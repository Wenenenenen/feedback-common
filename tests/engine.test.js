/* 引擎语义测试：node tests/engine.test.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function run() {
  let failed = 0;
  for (const c of cases) {
    try { c.fn(); passed++; }
    catch (err) { failed++; console.error('✗ ' + c.name + '\n  ' + (err.message || err).split('\n').join('\n  ')); }
  }
  console.log(`\n${passed}/${cases.length} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-data', f), 'utf8'));

/* ---------- 1. branch.json 期望终态 ---------- */
test('branch.json：终态/余额/进度与 expected 完全一致', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  const exp = d.expected;
  assert.deepEqual(rt.ctx.state, exp.states);
  assert.equal(rt.ctx.balances.gold, exp.gold);
  assert.equal(rt.ctx.progress.next.c, exp.nextCount);
  assert.equal(rt.ctx.progress.either.d, exp.uniqueCount);
});

test('branch.json：e2 重复 claim 为幂等忽略且不二次发奖', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  const t1 = rt.traces[1], t2 = rt.traces[2];
  assert.equal(t1.event.eventId, 'e2');
  assert.equal(t1.status, 'applied');
  assert.equal(t2.status, 'ignored');
  assert.equal(rt.ctx.balances.gold, 10);
  assert.equal(Object.keys(rt.ctx.issues).length, 0);
});

test('branch.json：同 objectId 去重，不同 objectId 累计', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  assert.deepEqual(rt.ctx.collected.either.d.sort(), ['r1', 'r2']);
  const collectTraces = rt.traces.filter((t) => t.event.type === 'collect');
  const r1second = collectTraces[1];
  assert.ok(r1second.reasons.some((r) => r.includes('去重不重复计数')));
});

test('branch.json：互斥领取后 right 失效并传播 rightOnly；next 激活但不追认 e1', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  assert.equal(rt.ctx.state.right, 'failed');
  assert.equal(rt.ctx.state.rightOnly, 'failed');
  assert.equal(rt.ctx.state.next, 'active');
  assert.equal(rt.ctx.progress.next.c, 0); // e1 发生时 next 尚未激活
});

/* ---------- 2. 重传与冲突 ---------- */
function kill(id, extra) { return Object.assign({ eventId: id, type: 'kill', tag: 'wolf', amount: 1 }, extra || {}); }
const qs1 = [{
  id: 'q', requires: [], requireMode: 'all', choiceGroup: '',
  objectives: [{ id: 'o', kind: 'count', eventType: 'kill', match: { tag: 'wolf' }, target: 5 }],
  reward: { gold: 2 }
}];

test('同 eventId 同载荷：忽略且不计数', () => {
  const rt = E.replay(qs1, [kill('e1'), kill('e1'), kill('e1')]);
  assert.equal(rt.ctx.progress.q.o, 1);
  assert.equal(rt.traces.filter((t) => t.status === 'ignored').length, 2);
});

test('同 eventId 异载荷：拒绝、记录位置、不计数', () => {
  const rt = E.replay(qs1, [kill('e1'), kill('e1', { amount: 2 })]);
  assert.equal(rt.ctx.progress.q.o, 1);
  assert.equal(rt.traces[1].status, 'rejected');
  assert.equal(rt.ctx.issues.length, 1);
  assert.equal(rt.ctx.issues[0].index, 1);
  assert.equal(rt.ctx.issues[0].kind, 'conflict');
  assert.ok(!Object.keys(rt.ctx.seen).includes('e1') === false); // e1 仍在 seen
});

test('唯一 eventId 相同载荷的不同事件可各自计数', () => {
  const rt = E.replay(qs1, [kill('a'), kill('b')]);
  assert.equal(rt.ctx.progress.q.o, 2);
});

test('amount 缺省为 1，非正整数拒绝', () => {
  let rt = E.replay(qs1, [kill('e1', { amount: undefined })]);
  assert.equal(rt.ctx.progress.q.o, 1);
  rt = E.replay(qs1, [kill('e1', { amount: 0 })]);
  assert.equal(rt.traces[0].status, 'rejected');
  assert.equal(rt.ctx.progress.q.o, 0);
});

/* ---------- 3. unique 语义 ---------- */
const qsU = [{
  id: 'u', requires: [], requireMode: 'all', choiceGroup: '',
  objectives: [{ id: 'o', kind: 'unique', eventType: 'collect', match: { tag: 'relic' }, target: 3 }],
  reward: {}
}];
test('unique 缺 objectId：整条事件拒绝并报错', () => {
  const rt = E.replay(qsU, [{ eventId: 'e1', type: 'collect', tag: 'relic' }]);
  assert.equal(rt.traces[0].status, 'rejected');
  assert.equal(rt.ctx.issues.length, 1);
  assert.equal(rt.ctx.collected.u.o.length, 0);
  assert.ok(!('e1' in rt.ctx.seen)); // 被拒绝事件不登记
});
test('unique 去重收集且截到 target', () => {
  const evs = [
    { eventId: 'e1', type: 'collect', tag: 'relic', objectId: 'a' },
    { eventId: 'e2', type: 'collect', tag: 'relic', objectId: 'a' },
    { eventId: 'e3', type: 'collect', tag: 'relic', objectId: 'b' },
    { eventId: 'e4', type: 'collect', tag: 'relic', objectId: 'c' },
    { eventId: 'e5', type: 'collect', tag: 'relic', objectId: 'd' }
  ];
  const rt = E.replay(qsU, evs);
  assert.equal(rt.ctx.progress.u.o, 3);
  assert.deepEqual(rt.ctx.collected.u.o.sort(), ['a', 'b', 'c']);
  assert.equal(rt.ctx.state.u, 'ready');
});

/* ---------- 4. 匹配与多目标 ---------- */
test('match 严格匹配：缺键/异值均不推进；同事件推进多个目标', () => {
  const qs = [{
    id: 'q', requires: [], requireMode: 'all', choiceGroup: '',
    objectives: [
      { id: 'o1', kind: 'count', eventType: 'kill', match: { tag: 'wolf', zone: 'north' }, target: 2 },
      { id: 'o2', kind: 'count', eventType: 'kill', match: { tag: 'wolf' }, target: 1 },
      { id: 'o3', kind: 'count', eventType: 'gather', match: {}, target: 1 }
    ],
    reward: {}
  }];
  const rt = E.replay(qs, [
    { eventId: 'e1', type: 'kill', tag: 'wolf', zone: 'north', amount: 2 },
    { eventId: 'e2', type: 'kill', tag: 'boar', amount: 1 },
    { eventId: 'e3', type: 'gather' }
  ]);
  assert.equal(rt.ctx.progress.q.o1, 2);
  assert.equal(rt.ctx.progress.q.o2, 1);
  assert.equal(rt.ctx.progress.q.o3, 1);
  assert.equal(rt.ctx.state.q, 'ready');
});

test('count 截断到 target', () => {
  const rt = E.replay(qs1, [kill('e1', { amount: 99 })]);
  assert.equal(rt.ctx.progress.q.o, 5);
});

/* ---------- 5. 前置激活/失效传播 ---------- */
test('all：任一前置 failed 则 locked 变 failed；仅 claimed 满足激活', () => {
  const qs = [
    { id: 'a', requires: [], requireMode: 'all', choiceGroup: 'g', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'b', requires: [], requireMode: 'all', choiceGroup: 'g', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'c', requires: ['a', 'b'], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} }
  ];
  const rt = E.replay(qs, [
    { eventId: 'e1', type: 'x' }, // a、b 同事件都 ready
    { eventId: 'e2', type: 'claim', questId: 'a' } // b failed -> c failed
  ]);
  assert.equal(rt.ctx.state.a, 'claimed');
  assert.equal(rt.ctx.state.b, 'failed');
  assert.equal(rt.ctx.state.c, 'failed');
});

test('any：全部前置 failed 才 failed；一个 claimed 即激活', () => {
  const qs = [
    { id: 'a', requires: [], requireMode: 'all', choiceGroup: 'g1', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'b', requires: [], requireMode: 'all', choiceGroup: 'g2', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'c', requires: ['a', 'b'], requireMode: 'any', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} }
  ];
  // 先把 a 领掉（g1 内 a 独占，不影响 b），c 应激活
  let rt = E.replay(qs, [
    { eventId: 'e1', type: 'x' },
    { eventId: 'e2', type: 'claim', questId: 'a' }
  ]);
  assert.equal(rt.ctx.state.c, 'active');

  // 另一场景：a、b 同组，领 a 使 b failed；c 因 a claimed 仍 active
  const qs2 = JSON.parse(JSON.stringify(qs));
  qs2[1].choiceGroup = 'g1';
  rt = E.replay(qs2, [
    { eventId: 'e1', type: 'x' },
    { eventId: 'e2', type: 'claim', questId: 'a' }
  ]);
  assert.equal(rt.ctx.state.b, 'failed');
  assert.equal(rt.ctx.state.c, 'active');
});

test('ready 不计入前置满足：all 前置齐 ready 未领，下游保持 locked', () => {
  const qs = [
    { id: 'a', requires: [], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'c', requires: ['a'], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} }
  ];
  const rt = E.replay(qs, [{ eventId: 'e1', type: 'x' }]);
  assert.equal(rt.ctx.state.a, 'ready');
  assert.equal(rt.ctx.state.c, 'locked');
  const why = E.explainLock(rt.ctx, qs[1]);
  assert.ok(why.some((r) => r.includes('可领取但未领取')));
});

test('同事件新激活任务不追认；领取激活后后续事件才推进', () => {
  const qs = [
    { id: 'a', requires: [], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} },
    { id: 'c', requires: ['a'], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} }
  ];
  const rt = E.replay(qs, [
    { eventId: 'e1', type: 'x' },
    { eventId: 'e2', type: 'claim', questId: 'a' },
    { eventId: 'e3', type: 'x' }
  ]);
  assert.equal(rt.ctx.progress.c.o, 1);
  assert.equal(rt.ctx.state.c, 'ready');
});

test('claim 非 ready 业务拒绝且不发奖；错误 questId 拒绝', () => {
  const rt = E.replay(qs1, [
    { eventId: 'c0', type: 'claim', questId: 'q' },    // active 未完成
    { eventId: 'c1', type: 'claim', questId: 'ghost' } // 不存在
  ]);
  assert.equal(rt.traces[0].status, 'rejected');
  assert.equal(rt.traces[1].status, 'rejected');
  assert.equal(rt.ctx.balances.gold || 0, 0);
  assert.equal(rt.ctx.issues.filter((i) => i.kind === 'claim-reject').length, 2);
});

test('claim 被业务拒绝后仍登记 seen，同载荷重传为忽略而非再次拒绝', () => {
  const rt = E.replay(qs1, [
    { eventId: 'c0', type: 'claim', questId: 'q' },
    { eventId: 'c0', type: 'claim', questId: 'q' }
  ]);
  assert.equal(rt.traces[0].status, 'rejected');
  assert.equal(rt.traces[1].status, 'ignored');
});

test('奖励原子入账，多币种累加', () => {
  const qs = [
    { id: 'a', requires: [], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: { gold: 3, gem: 1 } },
    { id: 'b', requires: [], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: { gold: 2 } }
  ];
  const rt = E.replay(qs, [
    { eventId: 'e1', type: 'x' },
    { eventId: 'c1', type: 'claim', questId: 'a' },
    { eventId: 'c2', type: 'claim', questId: 'b' }
  ]);
  assert.deepEqual(rt.ctx.balances, { gold: 5, gem: 1 });
});

/* ---------- 6. 定义校验 ---------- */
test('依赖环被检出（invalid-cycle.json）', () => {
  const d = load('invalid-cycle.json');
  const r = E.validateQuests(d.quests);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('依赖环')));
});
test('重复 id / 未知前置 / 目标数越界 / 非法 target 均报错', () => {
  const base = (id, reqs) => ({ id, requires: reqs || [], requireMode: 'all', choiceGroup: '', objectives: [{ id: 'o', kind: 'count', eventType: 'x', match: {}, target: 1 }], reward: {} });
  assert.equal(E.validateQuests([base('a'), base('a')]).ok, false);
  assert.equal(E.validateQuests([base('a', ['zz'])]).ok, false);
  const noObj = base('a'); noObj.objectives = [];
  assert.equal(E.validateQuests([noObj]).ok, false);
  const badTarget = base('a'); badTarget.objectives[0].target = 0;
  assert.equal(E.validateQuests([badTarget]).ok, false);
  assert.throws(() => E.replay([base('a', ['zz'])], []));
});

/* ---------- 7. 时间轴定位 viewAt ---------- */
test('viewAt 各游标位置与逐段执行一致', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  for (let k = 0; k <= d.events.length; k++) {
    const sub = E.replay(d.quests, d.events.slice(0, k));
    const view = E.viewAt(rt, k);
    assert.equal(E.stableStringify(view.state), E.stableStringify(sub.ctx.state), 'state@' + k);
    assert.equal(E.stableStringify(view.progress), E.stableStringify(sub.ctx.progress), 'progress@' + k);
    assert.equal(E.stableStringify(view.collected), E.stableStringify(sub.ctx.collected), 'collected@' + k);
    assert.equal(E.stableStringify(view.balances), E.stableStringify(sub.ctx.balances), 'balances@' + k);
  }
});

/* ---------- 8. 存档导出/校验/改历史重算 ---------- */
test('存档自校验通过；恢复后继续执行 == 连续执行', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  const save = E.exportSave(rt, rt.log.length);
  const v = E.verifySave(save);
  assert.equal(v.ok, true, v.problems.join('；'));

  // 模拟“恢复存档后再追加事件”：先恢复到 cursor，再追加，与一次性连续执行比对
  const more = [{ eventId: 'e6', type: 'kill', tag: 'wolf', amount: 1 }];
  const resumed = E.replay(save.quests, save.log.slice(0, save.cursor).concat(more));
  const continuous = E.replay(d.quests, d.events.concat(more));
  assert.equal(E.stableStringify(resumed.ctx.state), E.stableStringify(continuous.ctx.state));
  assert.equal(E.stableStringify(resumed.ctx.progress), E.stableStringify(continuous.ctx.progress));
  assert.equal(E.stableStringify(resumed.ctx.balances), E.stableStringify(continuous.ctx.balances));
});

test('篡改存档状态后 verifySave 必须报不一致', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  const save = E.exportSave(rt, rt.log.length);
  save.bundle.balances.gold = 999;
  const v = E.verifySave(save);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('奖励余额')));
});

test('修改历史事件后以完整新日志重算，不保留旧尾部状态', () => {
  const d = load('branch.json');
  // 把 e1 的 tag 改掉：left/right 不再完成，后续 claim left 应被拒绝
  const edited = JSON.parse(JSON.stringify(d.events));
  edited[0].tag = 'boar';
  const rt = E.replay(d.quests, edited);
  assert.equal(rt.ctx.state.left, 'active');
  const claimTrace = rt.traces[1];
  assert.equal(claimTrace.status, 'rejected');
  assert.equal(rt.ctx.balances.gold || 0, 0);
  assert.equal(rt.ctx.state.right, 'active'); // 未领取、未失效
});

/* ---------- 9. 压力规格：200 任务 / 5000 事件 ---------- */
test('stress.json：200×5000 全量重放在时限内完成且结果正确', () => {
  const d = load('stress.json');
  const t0 = Date.now();
  const rt = E.replay(d.quests, d.events);
  const ms = Date.now() - t0;
  assert.equal(rt.ctx.progress.q0.o, 5000);
  assert.equal(rt.ctx.progress.q199.o, 5000);
  d.quests.forEach((q) => assert.equal(rt.ctx.state[q.id], 'ready'));
  assert.ok(ms < 3000, '重放耗时 ' + ms + 'ms 超过 3000ms');
  console.log('    压力重放耗时：' + ms + 'ms（' + d.quests.length + ' 任务 / ' + d.events.length + ' 事件）');
});

test('压力场景 viewAt(2500) 与从头重放一致且足够快', () => {
  const d = load('stress.json');
  const rt = E.replay(d.quests, d.events);
  const t0 = Date.now();
  const view = E.viewAt(rt, 2500);
  const sub = E.replay(d.quests, d.events.slice(0, 2500));
  const ms = Date.now() - t0;
  assert.equal(E.stableStringify(view.progress), E.stableStringify(sub.ctx.progress));
  assert.ok(ms < 500, 'viewAt 耗时 ' + ms + 'ms');
});

test('超过 5000 日志项上限抛错', () => {
  const evs = Array.from({ length: 5001 }, (_, i) => kill('e' + i));
  assert.throws(() => E.replay(qs1, evs));
});


/* ---------- 10. 游标位置导出 ---------- */
test('exportSave 在中间游标导出的 bundle 等于该位置重放结果', () => {
  const d = load('branch.json');
  const rt = E.replay(d.quests, d.events);
  const save = E.exportSave(rt, 2);
  const sub = E.replay(d.quests, d.events.slice(0, 2));
  assert.equal(save.cursor, 2);
  assert.equal(E.stableStringify(save.bundle.state), E.stableStringify(sub.ctx.state));
  assert.equal(E.stableStringify(save.bundle.balances), E.stableStringify(sub.ctx.balances));
  const v = E.verifySave(save);
  assert.equal(v.ok, true, v.problems.join('；'));
});

run();
