'use strict';
/* 额外稳健性测试：时间轴检查点重放、任意步快照续跑、深层并行历史、边界。
 * node tests/extra.test.js
 */
const assert = require('node:assert/strict');
const R = require('../web/runner.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); console.error(e); process.exit(1); }
}

// 同时覆盖：并行多分区、嵌套复合、历史、定时器、内部事件、守卫、set
const complexChart = () => ({
  root: 1,
  vars: { n: 0, pinged: 0 },
  states: [
    { id: 1, parallel: true },
    // 动作分区 10：11 Idle -> 12 Follow(带 ping 定时器) -> 13 剧情
    { id: 10, parent: 1, initial: 11 },
    { id: 11, parent: 10 },
    { id: 12, parent: 10, timers: [{ after: 4, event: 'ping' }] },
    { id: 13, parent: 10 },
    // 表情分区 20
    { id: 20, parent: 1, initial: 21 },
    { id: 21, parent: 20 },
    { id: 22, parent: 20 },
    // 第三分区 30
    { id: 30, parent: 1, initial: 31 },
    { id: 31, parent: 30 },
    { id: 32, parent: 30 },
  ],
  edges: [
    { id: 1, source: 11, exitRoot: 10, target: 12, event: 'follow' },
    { id: 2, source: 12, exitRoot: 10, target: 13, event: 'story' },
    { id: 3, source: 13, exitRoot: 10, target: 11, event: 'storyEnd', history: true },
    { id: 4, source: 12, exitRoot: 10, target: 11, event: 'ping', set: { pinged: 1 }, emit: ['wink'] },
    { id: 5, source: 21, exitRoot: 20, target: 22, event: 'blink' },
    { id: 6, source: 22, exitRoot: 20, target: 21, event: 'wink' },
    { id: 7, source: 31, exitRoot: 30, target: 32, event: 'go30', guard: { n: 1 }, set: { n: 2 } },
  ],
  inputs: [
    { ms: 0, event: 'follow' },
    { ms: 2, event: 'story' },     // 提前离开 12，due=4 的 ping 应失效
    { ms: 5, event: 'storyEnd' },  // 历史恢复 12，重新登记 ping due=9
    { ms: 6, event: 'blink' },
    { ms: 20, event: 'go30' },     // guard n=1 不满足，无效
  ],
});

test('复杂图：剧情打断后历史恢复 Follow，旧 ping 不触发、新 ping 触发', () => {
  const r = R.create(complexChart());
  r.runToEnd();
  const evs = r.trace.map((t) => `${t.kind}:${t.event}`);
  // t=4 的旧 ping 已随 12 退出被取消；t=5 历史重入 12 => 新 ping due=9
  assert.ok(evs.includes('timer:ping'), '新 ping 应在 t=9 触发');
  const pingRows = r.trace.filter((t) => t.kind === 'timer' && t.event === 'ping');
  assert.equal(pingRows.length, 1);
  assert.equal(pingRows[0].ms, 9);
  assert.equal(r.state.vars.pinged, 1);
  // ping 的内部事件 wink 让表情分区 22->21（与 blink 路径交互后仍确定）
  assert.deepEqual(r.trace.find((t) => t.event === 'go30').effective, false);
});

test('时间轴：任意 seq 从最近检查点重放，状态与逐步运行完全一致', () => {
  const r = R.create(complexChart());
  const liveStates = [R.cloneState(r.state)];
  while (r.hasNext()) { r.step(); liveStates.push(R.cloneState(r.state)); }
  const last = r.trace.length - 1;

  const CP = 3; // 用小间隔多建几个检查点
  const cps = new Map([[0, R.cloneState(liveStates[0])]]);
  for (let s = 1; s <= last; s++) if (s % CP === 0) cps.set(s, R.cloneState(liveStates[s]));

  for (let seq = 0; seq <= last; seq++) {
    let cp = 0;
    for (const k of cps.keys()) if (k <= seq && k > cp) cp = k;
    const t = r.spawn(cps.get(cp));
    for (let i = cp + 1; i <= seq; i++) t.step();
    assert.deepEqual(t.state, liveStates[seq], `seq ${seq} 重放状态不一致`);
  }
});

test('快照：在每一个微步导出/导回再跑到底，轨迹与状态都与原运行一致', () => {
  for (let cut = 0; cut <= 12; cut++) {
    const a = R.create(complexChart());
    for (let i = 0; i < cut && a.hasNext(); i++) a.step();
    const snap = JSON.parse(JSON.stringify({ state: a.serialize(), trace: a.trace }));
    const b = R.create(complexChart());
    b.restore(snap.state);
    b.trace = snap.trace;
    a.runToEnd();
    b.runToEnd();
    assert.deepEqual(b.trace, a.trace, `cut=${cut} 轨迹不一致`);
    assert.deepEqual(b.state, a.state, `cut=${cut} 状态不一致`);
  }
});

test('上限：转移超过 2048 报 2048', () => {
  const chart = { root: 1, states: [{ id: 1 }], edges: [], inputs: [] };
  for (let i = 0; i < 2049; i++) {
    chart.edges.push({ id: i + 1, source: 1, exitRoot: 1, target: 1, event: `e${i}` });
  }
  assert.throws(() => R.create(chart), /2048/);
});

test('排序：同毫秒外部事件严格按输入数组顺序', () => {
  const chart = {
    root: 1, vars: { x: 0 },
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }],
    edges: [
      { id: 1, source: 2, exitRoot: 1, target: 2, event: 'a', set: { x: 1 } },
    ],
    inputs: [
      { ms: 7, event: 'a' }, { ms: 7, event: 'zzz' }, { ms: 7, event: 'a' },
    ],
  };
  const r = R.create(chart);
  r.runToEnd();
  assert.deepEqual(r.trace.filter((t) => t.kind === 'input').map((t) => t.inputIndex), [0, 1, 2]);
  assert.equal(r.trace.filter((t) => t.kind === 'input')[1].effective, false);
});

test('回滚后快照仍保持 halted，且不可继续', () => {
  const chart = {
    root: 1, vars: { n: 0 },
    states: [{ id: 1, initial: 2 }, { id: 2, parent: 1 }],
    edges: [{ id: 1, source: 2, exitRoot: 1, target: 2, event: 'go', emit: ['go'] }],
    inputs: [{ ms: 0, event: 'go' }, { ms: 9, event: 'later' }],
  };
  const a = R.create(chart);
  a.runToEnd();
  assert.equal(a.state.halted, true);
  const b = R.create(chart);
  b.restore(JSON.parse(JSON.stringify(a.serialize())));
  assert.equal(b.state.halted, true);
  assert.equal(b.hasNext(), false);
  assert.equal(b.step(), null);
});

test('深层并行历史：三个分区各自恢复不同的叶', () => {
  const chart = {
    root: 1,
    states: [
      { id: 1, parallel: true },
      { id: 10, parent: 1, initial: 11 }, { id: 11, parent: 10 }, { id: 12, parent: 10 },
      { id: 20, parent: 1, initial: 21 }, { id: 21, parent: 20 }, { id: 22, parent: 20 },
      { id: 30, parent: 1, initial: 31 }, { id: 31, parent: 30 }, { id: 32, parent: 30 },
    ],
    edges: [
      // 局部退出根：三个分区分别迁移到 12 / 22 / 32，且互不重置
      { id: 1, source: 11, exitRoot: 10, target: 12, event: 'm1' },
      { id: 2, source: 21, exitRoot: 20, target: 22, event: 'm2' },
      { id: 3, source: 31, exitRoot: 30, target: 32, event: 'm3' },
      // 整树退出：记录完整配置后，target 路径 + 其余分区默认
      { id: 8, source: 12, exitRoot: 1, target: 11, event: 'leave' },
      // history：恢复上一次整树退出时记录的 12/22/32
      { id: 9, source: 11, exitRoot: 1, target: 11, event: 'back', history: true },
    ],
    inputs: [
      { ms: 0, event: 'm1' }, { ms: 1, event: 'm2' }, { ms: 2, event: 'm3' },
      { ms: 3, event: 'leave' }, { ms: 4, event: 'back' },
    ],
  };
  const r = R.create(chart);
  r.runToEnd();
  assert.deepEqual(r.state.config.slice().sort((a, b) => a - b),
    [1, 10, 12, 20, 22, 30, 32]);
  assert.deepEqual(r.trace[r.trace.length - 1].fired, [9]);
});

console.log(`\n额外 ${passed} 个测试全部通过`);
