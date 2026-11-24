'use strict';
/* 运行器语义测试：node tests/runner.test.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../web/runner.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exit(1);
  }
}
const sorted = (a) => a.slice().sort((x, y) => x - y);
const events = (r) => r.trace.map((t) => `${t.kind}:${t.event}`);

// ---------- 1. 样例端到端 ----------
test('样例：follow/rest/idle 全流程', () => {
  const chart = JSON.parse(fs.readFileSync(path.join(__dirname, '../samples/companion-chart.json'), 'utf8'));
  const r = R.create(chart);
  r.runToEnd();
  assert.deepEqual(events(r), ['init:null', 'input:follow', 'timer:rest', 'input:idle']);
  assert.deepEqual(sorted(r.state.config), [1, 2]);
  assert.equal(r.state.vars.mood, 0);
  assert.equal(r.state.timers.length, 0);
  assert.equal(r.trace[1].fired.join(','), '1');
  assert.equal(r.trace[2].fired.join(','), '2');
  assert.equal(r.trace[3].effective, false); // idle 无转移，不计生效微步
  assert.equal(r.state.effective, 2);
});

// ---------- 2. 并行分区：一个事件多条转移同时生效 ----------
const parallelChart = () => ({
  root: 1,
  vars: {},
  states: [
    { id: 1, parallel: true },
    { id: 10, parent: 1, initial: 11 }, { id: 11, parent: 10 }, { id: 12, parent: 10 },
    { id: 20, parent: 1, initial: 21 }, { id: 21, parent: 20 }, { id: 22, parent: 20 },
  ],
  edges: [
    { id: 1, source: 11, exitRoot: 10, target: 12, event: 'go' },
    { id: 2, source: 21, exitRoot: 20, target: 22, event: 'go' },
  ],
  inputs: [{ ms: 0, event: 'go' }],
});
test('并行：一个事件让两个分区的转移一起生效', () => {
  const r = R.create(parallelChart());
  r.runToEnd();
  assert.deepEqual(sorted(r.state.config), [1, 10, 12, 20, 22]);
  assert.deepEqual(r.trace[1].fired, [1, 2]); // 按选中顺序执行
});

// ---------- 3. 守卫读步首值 ----------
test('守卫：同一微步内所有守卫读步首值', () => {
  const chart = parallelChart();
  chart.vars = { x: 0 };
  chart.edges = [
    { id: 1, source: 11, exitRoot: 10, target: 12, event: 'go', guard: { x: 0 }, set: { x: 1 } },
    { id: 2, source: 21, exitRoot: 20, target: 22, event: 'go', guard: { x: 1 } },
  ];
  chart.inputs = [{ ms: 0, event: 'go' }, { ms: 5, event: 'go' }];
  const r = R.create(chart);
  r.runToEnd();
  // 第一个 go：边2 的守卫读到步首 x=0，不生效；第二个 go 时 x=1，边2 生效
  assert.deepEqual(r.trace[1].fired, [1]);
  assert.deepEqual(r.trace[2].fired, [2]);
  assert.deepEqual(sorted(r.state.config), [1, 10, 12, 20, 22]);
});

// ---------- 4. 冲突：退出根互为祖先/相同只留先选 ----------
test('冲突：退出根为祖先时只保留先选（源更深）的边', () => {
  const r = R.create({
    root: 1,
    vars: { n: 0 },
    states: [
      { id: 1, initial: 2 },
      { id: 2, parent: 1, initial: 4 },
      { id: 4, parent: 2 },
    ],
    edges: [
      { id: 1, source: 4, exitRoot: 2, target: 4, event: 'go', set: { n: 1 } },
      { id: 2, source: 2, exitRoot: 1, target: 2, event: 'go', set: { n: 2 } },
    ],
    inputs: [{ ms: 0, event: 'go' }],
  });
  r.runToEnd();
  assert.deepEqual(r.trace[1].fired, [1]); // 源更深的边1先选，边2退出根是其祖先被丢弃
  assert.equal(r.state.vars.n, 1);
  assert.deepEqual(sorted(r.state.config), [1, 2, 4]);
});
test('冲突：退出根相同时按编号升序只留先选', () => {
  const r = R.create({
    root: 1,
    vars: { n: 0 },
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }, { id: 3, parent: 1 }],
    edges: [
      { id: 10, source: 2, exitRoot: 1, target: 3, event: 'go', set: { n: 10 } },
      { id: 11, source: 2, exitRoot: 1, target: 2, event: 'go', set: { n: 11 } },
    ],
    inputs: [{ ms: 0, event: 'go' }],
  });
  r.runToEnd();
  assert.deepEqual(r.trace[1].fired, [10]);
  assert.equal(r.state.vars.n, 10);
  assert.deepEqual(sorted(r.state.config), [1, 3]);
});

// ---------- 5. 定时器 ----------
test('定时器：离开状态即失效，旧计时器不触发', () => {
  const r = R.create({
    root: 1,
    vars: { ticked: 0 },
    states: [
      { id: 1, initial: 2 },
      { id: 2, parent: 1 },
      { id: 3, parent: 1, timers: [{ after: 5, event: 'tick' }] },
    ],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 3, event: 'go' },
      { id: 2, source: 3, exitRoot: 1, target: 2, event: 'stop' },
      { id: 3, source: 3, exitRoot: 1, target: 2, event: 'tick', set: { ticked: 1 } },
    ],
    inputs: [{ ms: 0, event: 'go' }, { ms: 3, event: 'stop' }],
  });
  r.runToEnd();
  assert.equal(r.state.vars.ticked, 0); // tick 从未触发
  assert.equal(r.state.timers.length, 0);
  assert.deepEqual(events(r), ['init:null', 'input:go', 'input:stop']);
});
test('定时器：同毫秒先于外部输入；同毫秒按登记顺序', () => {
  const r = R.create({
    root: 1,
    vars: {},
    states: [
      { id: 1, parallel: true },
      { id: 10, parent: 1, initial: 11 },
      { id: 11, parent: 10, timers: [{ after: 5, event: 'a' }, { after: 5, event: 'b' }] },
      { id: 20, parent: 1, initial: 21 },
      { id: 21, parent: 20 }, { id: 22, parent: 20 },
    ],
    edges: [
      { id: 1, source: 21, exitRoot: 20, target: 22, event: 'a' },
      { id: 2, source: 22, exitRoot: 20, target: 21, event: 'b' },
      { id: 3, source: 21, exitRoot: 20, target: 22, event: 'poke' },
    ],
    inputs: [{ ms: 5, event: 'poke' }],
  });
  r.runToEnd();
  // t=5：定时器 a、b（登记顺序）先于输入 poke
  assert.deepEqual(events(r), ['init:null', 'timer:a', 'timer:b', 'input:poke']);
  assert.deepEqual(r.trace[1].fired, [1]); // a: 21→22
  assert.deepEqual(r.trace[2].fired, [2]); // b: 22→21
  assert.deepEqual(r.trace[3].fired, [3]); // poke 时 21 活跃 → 21→22
});

// ---------- 6. 内部事件按入队顺序排空 ----------
test('内部事件：FIFO，排空后才接下一输入', () => {
  const mk = () => ({
    root: 1,
    vars: {},
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 2, event: 'go', emit: ['a', 'b'] },
      { id: 2, source: 2, exitRoot: 1, target: 2, event: 'a', emit: ['c'] },
      { id: 3, source: 2, exitRoot: 1, target: 2, event: 'b' },
      { id: 4, source: 2, exitRoot: 1, target: 2, event: 'c' },
    ],
    inputs: [{ ms: 0, event: 'go' }, { ms: 1, event: 'b' }],
  });
  const r = R.create(mk());
  r.runToEnd();
  // go 产生 [a,b]；处理 a 又产生 c 排在 b 后；全部排空后才处理 ms=1 的输入 b
  assert.deepEqual(events(r), ['init:null', 'input:go', 'internal:a', 'internal:b', 'internal:c', 'input:b']);
});

// ---------- 7. 超过 256 个生效微步：回滚并停住 ----------
test('回滚：超过 256 个生效微步回滚该次输入并停住', () => {
  const r = R.create({
    root: 1,
    vars: { n: 0 },
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }],
    edges: [{ id: 1, source: 2, exitRoot: 1, target: 2, event: 'go', set: { n: 1 }, emit: ['go'] }],
    inputs: [{ ms: 0, event: 'go' }],
  });
  r.runToEnd();
  assert.equal(r.state.halted, true);
  assert.match(r.state.haltReason, /256/);
  assert.equal(r.state.vars.n, 0); // 回滚到输入前
  assert.deepEqual(sorted(r.state.config), [1, 2]);
  assert.equal(r.trace.length, 1 + 256 + 1); // init + 256 个生效微步 + 回滚记录
  assert.equal(r.trace[r.trace.length - 1].kind, 'rollback');
  assert.equal(r.hasNext(), false);
});

// ---------- 8. 历史重入恢复各并行分区 ----------
test('历史：退树记住完整活跃配置，history 重入恢复各并行分区', () => {
  const chart = parallelChart();
  chart.edges = [
    { id: 1, source: 11, exitRoot: 1, target: 12, event: 'go' },
    { id: 2, source: 21, exitRoot: 1, target: 22, event: 'go2' },
    { id: 3, source: 22, exitRoot: 1, target: 11, event: 'back', history: true },
  ];
  chart.inputs = [{ ms: 0, event: 'go' }, { ms: 1, event: 'go2' }, { ms: 2, event: 'back' }];
  const r = R.create(chart);
  r.runToEnd();
  // go:  {1,10,12,20,21}（分区20走默认）；go2: 退出整树记录 {1,10,12,20,21}，重入后 {1,10,11,20,22}
  // back: history 恢复上次退出时记录的 {1,10,12,20,21}，而不是 target 路径或默认值
  assert.deepEqual(sorted(r.state.config), [1, 10, 12, 20, 21]);
});
test('历史：无记录时走默认（target 路径 + 其余分区默认）', () => {
  const chart = parallelChart();
  chart.edges = [{ id: 1, source: 11, exitRoot: 1, target: 12, event: 'go', history: true }];
  chart.inputs = [{ ms: 0, event: 'go' }];
  const r = R.create(chart);
  r.runToEnd();
  assert.deepEqual(sorted(r.state.config), [1, 10, 12, 20, 21]); // 无记录 → target 路径 + 默认分区
});

// ---------- 9. 快照导出/导回后继续跑，轨迹一致 ----------
test('快照：导回后继续跑，转移/变量/事件轨迹与原来一致', () => {
  const chart = {
    root: 1,
    vars: { mood: 0 },
    states: [
      { id: 1, initial: 2 },
      { id: 2, parent: 1 },
      { id: 3, parent: 1, timers: [{ after: 8, event: 'rest' }] },
    ],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 3, event: 'follow', set: { mood: 1 }, emit: ['blink'] },
      { id: 2, source: 3, exitRoot: 1, target: 2, event: 'rest', set: { mood: 0 } },
      { id: 3, source: 3, exitRoot: 1, target: 3, event: 'blink' },
    ],
    inputs: [{ ms: 0, event: 'follow' }, { ms: 3, event: 'follow' }, { ms: 12, event: 'idle' }, { ms: 20, event: 'follow' }],
  };
  const r1 = R.create(chart);
  r1.step(); r1.step(); r1.step(); // 跑到一半（含内部事件）
  // 导出 → JSON → 导回
  const snap = JSON.parse(JSON.stringify({ chart, state: r1.serialize(), trace: r1.trace }));
  const r2 = R.create(snap.chart);
  r2.restore(snap.state);
  r2.trace = snap.trace;
  r1.runToEnd();
  r2.runToEnd();
  assert.deepEqual(r2.trace, r1.trace); // 事件轨迹（含 fired 边）完全一致
  assert.deepEqual(r2.state, r1.state); // 变量、配置、定时器完全一致
});

// ---------- 10. 校验与上限 ----------
test('校验：超上限与非法定义报错', () => {
  const big = { root: 1, states: [], edges: [], inputs: [] };
  for (let i = 1; i <= 513; i++) big.states.push(i === 1 ? { id: 1, initial: 2 } : { id: i, parent: 1 });
  assert.throws(() => R.create(big), /512/);
  assert.throws(() => R.create({ root: 1, states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }, { id: 3, parent: 1 }], edges: [{ id: 1, source: 2, exitRoot: 3, target: 2, event: 'x' }], inputs: [] }), /包含 source/);
  assert.throws(() => R.create({ root: 1, states: [{ id: 1, initial: 2 }, { id: 2, parent: 1, timers: [{ after: 0, event: 't' }] }], edges: [], inputs: [] }), /正整数/);
  const manyInputs = { root: 1, states: [{ id: 1 }], edges: [], inputs: [] };
  for (let i = 0; i < 50001; i++) manyInputs.inputs.push({ ms: i, event: 'x' });
  assert.throws(() => R.create(manyInputs), /50000/);
});

// ---------- 11. 规模：5 万输入事件 ----------
test('规模：5 万条输入事件可运行', () => {
  const chart = {
    root: 1,
    vars: { n: 0 },
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }, { id: 3, parent: 1 }],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 3, event: 'a', set: { n: 1 } },
      { id: 2, source: 3, exitRoot: 1, target: 2, event: 'a', set: { n: 2 } },
    ],
    inputs: [],
  };
  for (let i = 0; i < 50000; i++) chart.inputs.push({ ms: i, event: 'a' });
  const t0 = Date.now();
  const r = R.create(chart);
  r.runToEnd();
  const ms = Date.now() - t0;
  assert.equal(r.trace.length, 50001);
  assert.equal(r.state.vars.n, 2); // 偶数次往返后停在状态 2 一侧
  console.log(`  (5 万输入耗时 ${ms}ms)`);
});

console.log(`\n全部 ${passed} 个测试通过`);
