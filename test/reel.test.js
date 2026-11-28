'use strict';
const assert = require('assert');
const path = require('path');
const Reel = require(path.join(__dirname, '..', 'reel.js'));

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

// 1. 官方样例: 2 组 2 线程, 交换对端 lane 号写入输出区
t('样例程序: 交换对端值', () => {
  const spec = require(path.join(__dirname, '..', 'samples', 'workgroup-reel.json'));
  const r = Reel.run(spec);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.strictEqual(r.groupsCompleted, 2);
  for (const g of r.groups) {
    assert.deepStrictEqual(Array.from(g.output), [1, 0]);
    assert.deepStrictEqual(Array.from(g.shared), [0, 1]);
    assert.strictEqual(g.phases.length, 2); // barrier 前一段 + 末阶段
  }
});

// 2. 读自己的最新写入: 同阶段写后读, 读到自己的值, 不算冲突
t('线程读自己的最新写入', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 1, outputWords: 1,
    program: [
      ['set', 'r0', 'lane'],
      ['store', 'shared', 0, 'r0'],   // 两个线程都写 shared[0] -> 多写冲突!
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'conflict');

  // 改成各写各的地址再读回, 无冲突
  const r2 = Reel.run({
    groups: 1, lanes: 2, sharedWords: 2, outputWords: 2,
    program: [
      ['set', 'r0', 'lane'],
      ['add', 'r0', 'r0', 10],
      ['store', 'shared', 'lane', 'r0'],
      ['load', 'r1', 'shared', 'lane'],   // 读自己刚写的 -> 10+lane, 不是阶段初的 0
      ['store', 'output', 'lane', 'r1'],
      ['halt'],
    ]
  });
  assert.strictEqual(r2.ok, true, r2.error && r2.error.message);
  assert.deepStrictEqual(Array.from(r2.groups[0].output), [10, 11]);
});

// 3. 多线程写同地址, 即使值一样也报冲突
t('多线程同值写同地址仍报冲突', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 1, outputWords: 0,
    program: [
      ['store', 'shared', 0, 42],
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'conflict');
  assert.strictEqual(r.error.group, 0);
  assert.strictEqual(r.error.phase, 0);
  const c = r.error.conflicts[0];
  assert.strictEqual(c.addr, 0);
  assert.strictEqual(c.writers.length, 2);
  assert.ok(c.writers.every(w => w.value === 42));
});

// 4. 跨线程读写同地址报冲突; 读者读到的是阶段开始的值
t('跨线程读写冲突 + 读阶段开始的值', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 1, outputWords: 2,
    program: [
      // lane1 写 shared[0]=7; lane0 读 shared[0](读到阶段初的 0) -> 冲突
      ['set', 'r0', 'lane'],
      ['jz', 'r0', 4],          // lane0 跳到 load; lane1 顺序执行写
      ['store', 'shared', 0, 7],
      ['jz', 0, 5],
      ['load', 'r1', 'shared', 0],
      ['store', 'output', 'lane', 'r1'],
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'conflict');
  const c = r.error.conflicts[0];
  assert.strictEqual(c.writers.length, 1);
  assert.strictEqual(c.writers[0].lane, 1);
  assert.strictEqual(c.readers[0].lane, 0);
});

// 5. 屏障后跨线程读不写 -> 无冲突, 读到上个阶段提交的值
t('屏障分隔后跨线程读无冲突', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 2, outputWords: 2,
    program: [
      ['store', 'shared', 'lane', 'lane'],
      ['barrier'],
      ['xor', 'r0', 'lane', 1],
      ['load', 'r1', 'shared', 'r0'],
      ['store', 'output', 'lane', 'r1'],
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.deepStrictEqual(Array.from(r.groups[0].output), [1, 0]);
});

// 6. 屏障不一致: lane0 走 barrier, lane1 直接 halt
t('屏障不一致定位到组和阶段', () => {
  const r = Reel.run({
    groups: 3, lanes: 2, sharedWords: 0, outputWords: 0,
    program: [
      ['set', 'r0', 'lane'],
      ['jz', 'r0', 4],
      ['barrier'],     // pc=2, 只有 lane0 到
      ['halt'],        // pc=3
      ['halt'],        // pc=4, lane1 直接结束
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'barrier-diverge');
  assert.strictEqual(r.error.group, 0);
  assert.strictEqual(r.error.phase, 0);
  assert.strictEqual(r.groupsCompleted, 0);
  const states = r.error.locations.map(l => l.state).sort();
  assert.deepStrictEqual(states, [Reel.ST.BARRIER, Reel.ST.HALT]);
});

// 7. 不同屏障指令也算不一致
t('到达不同屏障指令算不一致', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 0, outputWords: 0,
    program: [
      ['set', 'r0', 'lane'],
      ['jz', 'r0', 4],
      ['barrier'],   // pc=2 lane0
      ['halt'],
      ['barrier'],   // pc=4 lane1
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'barrier-diverge');
});

// 8. 跳转越界
t('跳转越界定位', () => {
  const r = Reel.run({
    groups: 2, lanes: 2, sharedWords: 0, outputWords: 0,
    program: [['jz', 0, 99]]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'jump-oob');
  assert.strictEqual(r.error.group, 0);
  assert.strictEqual(r.error.phase, 0);
  assert.strictEqual(r.error.lane, 0);
  assert.strictEqual(r.error.pc, 0);
});

// 9. 访存越界
t('访存越界定位', () => {
  const r = Reel.run({
    groups: 1, lanes: 1, sharedWords: 2, outputWords: 0,
    program: [['store', 'shared', 5, 1]]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'mem-oob');
  assert.strictEqual(r.error.addr, 5);
});

// 10. 失败后保留上次成功输出: 第二阶段冲突, 第一阶段提交保留
t('失败后保留上次成功输出', () => {
  const r = Reel.run({
    groups: 1, lanes: 2, sharedWords: 0, outputWords: 2,
    program: [
      ['store', 'output', 'lane', 'lane'],  // 阶段0: 正常提交
      ['barrier'],
      ['store', 'output', 0, 9],            // 阶段1: 两线程都写 output[0] -> 冲突
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'conflict');
  assert.strictEqual(r.error.phase, 1);
  // 上次成功提交(阶段0)的输出保留, 阶段1 的写入未落盘
  assert.deepStrictEqual(Array.from(r.groups[0].output), [0, 1]);
  assert.strictEqual(r.groups[0].phases.length, 1);
  assert.strictEqual(r.groups[0].failedPhase.index, 1);
});

// 11. 出错组之后的组不运行; 之前的组结果保留
t('出错后停止, 已完成组保留', () => {
  const r = Reel.run({
    groups: 4, lanes: 1, sharedWords: 1, outputWords: 1,
    program: [
      ['set', 'r0', 'group'],
      ['jz', 'r0', 4],          // group0 跳到正常路径; 其它组顺序执行 -> 越界写
      ['store', 'shared', 9, 1],
      ['halt'],
      ['store', 'output', 0, 'group'],
      ['halt'],
    ]
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'mem-oob');
  assert.strictEqual(r.error.group, 1);   // group0 正常完成, group1 越界
  assert.strictEqual(r.groups.length, 2); // 后续组未运行
  assert.strictEqual(r.groups[0].completed, true);
  assert.strictEqual(r.groups[0].output[0], 0); // group0 的输出保留
});

// 12. 指令数超限
t('累计指令数超限定位', () => {
  const r = Reel.run({
    groups: 1, lanes: 1, sharedWords: 0, outputWords: 0,
    program: [['jz', 0, 0]] // 死循环
  }, { maxInstructions: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.kind, 'limit');
  assert.strictEqual(r.error.group, 0);
  assert.strictEqual(r.instructionsExecuted, 1000);
});

// 13. 走出程序末尾视为结束并提交末阶段
t('走出程序末尾视为结束', () => {
  const r = Reel.run({
    groups: 1, lanes: 1, sharedWords: 0, outputWords: 1,
    program: [['store', 'output', 0, 7]]
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.groups[0].output), [7]);
});

// 14. 并行归约(无冲突版本): 8 线程求和 1..8 = 36
t('并行归约求和无冲突', () => {
  // 阶段0: shared[lane] = lane+1; 之后 stride=1,2,4 树形归约,
  // 活跃线程 lane % (2*stride) == 0, 用 xor+jz 等值链分派
  const lanes = 8;
  const program = [
    ['set', 'r0', 'lane'],
    ['add', 'r0', 'r0', 1],
    ['store', 'shared', 'lane', 'r0'],
    ['barrier'],
  ];
  for (let s = 1; s < lanes; s *= 2) {
    const doLabels = [];
    for (let k = 0; k < lanes; k += 2 * s) {
      program.push(['set', 'r7', 'lane']);
      program.push(['xor', 'r7', 'r7', k]);
      doLabels.push(program.length);
      program.push(['jz', 'r7', 0]); // 占位, 回填
    }
    const skip = program.length;
    program.push(['jz', 0, 0]); // 无条件跳到 SKIP, 回填
    const doPc = program.length;
    for (const p of doLabels) program[p][2] = doPc;
    program[skip][2] = doPc + 5; // SKIP 在 body 之后
    program.push(['add', 'r3', 'lane', s]);        // partner 地址
    program.push(['load', 'r1', 'shared', 'r3']);
    program.push(['load', 'r2', 'shared', 'lane']);
    program.push(['add', 'r2', 'r2', 'r1']);
    program.push(['store', 'shared', 'lane', 'r2']);
    program.push(['barrier']);
  }
  program.push(['load', 'r4', 'shared', 0]);       // 所有线程读 shared[0](只读无冲突)
  program.push(['store', 'output', 'lane', 'r4']); // 各写各的输出槽
  program.push(['halt']);
  const r = Reel.run({ groups: 4, lanes, sharedWords: lanes, outputWords: lanes, program });
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  for (const g of r.groups) {
    assert.deepStrictEqual(Array.from(g.output), new Array(lanes).fill(36));
  }
});

// 15. memoryAt 重建各阶段内存
t('按阶段重建提交后内存', () => {
  const spec = {
    groups: 1, lanes: 2, sharedWords: 2, outputWords: 0,
    program: [
      ['store', 'shared', 'lane', 'lane'],
      ['barrier'],
      ['add', 'r0', 'lane', 10],
      ['store', 'shared', 'lane', 'r0'],
      ['halt'],
    ]
  };
  const r = Reel.run(spec);
  assert.strictEqual(r.ok, true);
  const g = r.groups[0];
  const m0 = Reel.memoryAt(r.config, g, 0);
  assert.deepStrictEqual(Array.from(m0.shared), [0, 1]);
  const m1 = Reel.memoryAt(r.config, g, 1);
  assert.deepStrictEqual(Array.from(m1.shared), [10, 11]);
});

// 16. 满额性能: 2048 组 x 32 线程, 无冲突, 须在 8 秒内
t('满额 2048x32 无冲突程序 8 秒内完成', () => {
  const program = [
    ['set', 'r0', 'lane'],
    ['add', 'r0', 'r0', 'group'],
    ['store', 'shared', 'lane', 'r0'],
    ['barrier'],
    ['xor', 'r1', 'lane', 31],
    ['load', 'r2', 'shared', 'r1'],
    ['store', 'output', 'lane', 'r2'],
    ['halt'],
  ];
  const r = Reel.run({ groups: 2048, lanes: 32, sharedWords: 32, outputWords: 32, program });
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.strictEqual(r.groupsCompleted, 2048);
  assert.strictEqual(r.instructionsExecuted, 2048 * 32 * 8);
  console.log('    满额执行 ' + r.instructionsExecuted.toLocaleString() + ' 条指令, 耗时 ' + r.elapsedMs.toFixed(1) + ' ms');
  assert.ok(r.elapsedMs < 8000, '超过 8 秒: ' + r.elapsedMs);
  // 抽查: group5 lane7 -> shared[24] = 24+5 = 29
  assert.strictEqual(r.groups[5].output[7], 29);
});

console.log('\n全部 ' + passed + ' 个测试通过');
