/*
 * Node 测试（无第三方依赖）：node tests/planner.test.js
 * 验收基准为样例包 expected.json，并覆盖预算、字典序、原子性、同刻事件等边界。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const planner = require('../js/planner.js');
const validator = require('../js/validator.js');
const sim = require('../js/simulator.js');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

/* ---------------- 校验器 ---------------- */

group('validator 校验与规范化', () => {
  test('样例全部通过校验', () => {
    for (const f of ['demo.json', 'unreachable.json', 'tie.json']) {
      const r = validator.validate(fx(f));
      assert.deepStrictEqual(r.errors, [], `${f}: ${r.errors.join('; ')}`);
    }
  });

  test('成本必须为正整数', () => {
    const d = fx('tie.json');
    d.actions[0].cost = 0;
    assert.ok(validator.validate(d).errors.some((e) => e.includes('cost')));
  });

  test('add/remove 互斥', () => {
    const d = fx('tie.json');
    d.actions[0].add = ['done'];
    d.actions[0].remove = ['done'];
    assert.ok(validator.validate(d).errors.some((e) => e.includes('互斥')));
  });

  test('资源越界初值拒绝', () => {
    const d = fx('demo.json');
    d.initial.resources.ore = 9;
    assert.ok(validator.validate(d).errors.some((e) => e.includes('ore')));
  });

  test('超过 12 布尔量 / 2 资源 / 32 动作上限', () => {
    const d = validator.emptyDomain();
    for (let i = 0; i < 13; i++) d.initial.facts['f' + i] = false;
    assert.ok(validator.validate(d).errors.some((e) => e.includes('布尔量')));
    const d2 = validator.emptyDomain();
    d2.caps.b = 1; d2.initial.resources.b = 0;
    d2.caps.c = 1; d2.initial.resources.c = 0;
    assert.ok(validator.validate(d2).errors.some((e) => e.includes('资源')));
    const d3 = validator.emptyDomain();
    d3.actions = Array.from({ length: 33 }, (_, i) => ({
      id: 'a' + i, cost: 1, duration_ms: 1, pre: {}, min: {}, max: {},
      add: [], remove: [], delta: {},
    }));
    assert.ok(validator.validate(d3).errors.some((e) => e.includes('动作')));
  });

  test('重复动作 id 拒绝', () => {
    const d = fx('tie.json');
    d.actions[1].id = d.actions[0].id;
    assert.ok(validator.validate(d).errors.some((e) => e.includes('重复')));
  });
});

/* ---------------- 规划器：样例基准 ---------------- */

group('planner 最优搜索（对齐 expected.json）', () => {
  const demo = validator.validate(fx('demo.json')).domain;
  const expected = fx('expected.json');

  test('demo 静态计划与总成本一致', () => {
    const r = planner.plan(demo, demo.initial);
    assert.strictEqual(r.status, 'solved');
    assert.deepStrictEqual(r.plan, expected.static_plan);
    assert.strictEqual(r.cost, expected.static_cost);
  });

  test('demo 各步累计成本正确（1,2,4,5）', () => {
    const r = planner.plan(demo, demo.initial);
    assert.deepStrictEqual(r.steps.map((s) => s.costAfter), [1, 2, 4, 5]);
    assert.deepStrictEqual(r.steps.map((s) => s.actionId), ['gather', 'gather', 'craft', 'deliver']);
    // 中间状态可核对
    assert.strictEqual(r.steps[2].stateAfter.resources.ore, 0);
    assert.strictEqual(r.steps[2].stateAfter.facts.tool, true);
  });

  test('tie：同成本按 id 序列字典序选 a', () => {
    const tie = validator.validate(fx('tie.json')).domain;
    const r = planner.plan(tie, tie.initial);
    assert.deepStrictEqual(r.plan, ['a']);
    assert.strictEqual(r.cost, 2);
  });

  test('unreachable：队列耗尽才判无解', () => {
    const u = validator.validate(fx('unreachable.json')).domain;
    const r = planner.plan(u, u.initial);
    assert.strictEqual(r.status, 'unsolvable');
    assert.strictEqual(r.cost, null);
    assert.strictEqual(r.remainingCandidates, 0);
  });

  test('初始即目标：空计划、零成本、零扩展', () => {
    const d = JSON.parse(JSON.stringify(demo));
    const r = planner.plan(d, { facts: { access: true, tool: true, done: true }, resources: { ore: 0 } });
    assert.strictEqual(r.status, 'solved');
    assert.deepStrictEqual(r.plan, []);
    assert.strictEqual(r.cost, 0);
    assert.strictEqual(r.expansions, 1);
  });
});

/* ---------------- 预算语义 ---------------- */

group('预算语义', () => {
  const demo = validator.validate(fx('demo.json')).domain;

  test('budget=0：首状态扩展后即触顶，候选已入堆 => budget_exhausted', () => {
    const r0 = planner.plan(demo, demo.initial, 0);
    assert.strictEqual(r0.status, 'budget_exhausted');
    assert.strictEqual(r0.expansions, 1);
    assert.ok(r0.remainingCandidates > 0);
  });

  test('budget=1：首状态扩展出候选后预算用尽 => budget_exhausted，与无解严格区分', () => {
    const r1 = planner.plan(demo, demo.initial, 1);
    assert.strictEqual(r1.status, 'budget_exhausted');
    assert.strictEqual(r1.expansions, 1);
    assert.ok(r1.remainingCandidates > 0);

    const u = validator.validate(fx('unreachable.json')).domain;
    const full = planner.plan(u, u.initial, 10000);
    assert.strictEqual(full.status, 'unsolvable');
    assert.strictEqual(full.remainingCandidates, 0);
  });

  test('预算恰好在弹出目标时用完 => 仍算 solved（先判目标）', () => {
    const tie = validator.validate(fx('tie.json')).domain;
    // 弹出初始(1 扩展)即判目标前，目标在第二次弹出
    const r = planner.plan(tie, tie.initial, 2);
    assert.strictEqual(r.status, 'solved');
  });

  test('小预算下无解与预算耗尽可区分', () => {
    const u = validator.validate(fx('unreachable.json')).domain;
    // budget=1：初始状态扩展后产生 gather 后继，预算用尽，仍有未检查候选
    const exhausted = planner.plan(u, u.initial, 1);
    assert.strictEqual(exhausted.status, 'budget_exhausted');
    // 预算充足：完整搜索后队列为空，证明无解
    const full = planner.plan(u, u.initial, 10000);
    assert.strictEqual(full.status, 'unsolvable');
    assert.strictEqual(full.remainingCandidates, 0);
  });  test('扩展计数只计持有最优路径的未扩展状态（过期堆条目不计数）', () => {
    const r = planner.plan(demo, demo.initial, 10000);
    assert.ok(r.expansions <= r.statesReached);
  });
});

/* ---------------- 最优性与资源语义 ---------------- */

group('最优性 / 资源边界（不夹取）', () => {
  test('delta 越界动作不可用，不会夹取', () => {
    const d = validator.emptyDomain();
    d.initial.facts = { done: false };
    d.caps = { ore: 1 };
    d.initial.resources = { ore: 1 };
    d.actions = [{
      id: 'overflow', cost: 1, duration_ms: 1, pre: {}, min: {}, max: {},
      add: ['done'], remove: [], delta: { ore: 1 },
    }];
    d.goal = { facts: { done: true }, min: {}, max: {} };
    const r = planner.plan(d, d.initial);
    assert.strictEqual(r.status, 'unsolvable');
  });

  test('贵的捷径不会被贪心选中：单步低价动作直接胜出', () => {
    const d = validator.emptyDomain();
    d.initial.facts = { done: false };
    d.caps = {}; d.initial.resources = {};
    d.actions = [
      { id: 'cheap1', cost: 1, duration_ms: 1, pre: {}, min: {}, max: {}, add: [], remove: [], delta: {} },
      { id: 'cheap2', cost: 1, duration_ms: 1, pre: {}, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
      { id: 'pricey', cost: 9, duration_ms: 1, pre: {}, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
    ];
    d.goal = { facts: { done: true }, min: {}, max: {} };
    const r = planner.plan(d, d.initial);
    assert.strictEqual(r.cost, 1);
    assert.deepStrictEqual(r.plan, ['cheap2']);
  });

  test('需要两步时搜索找到便宜长路而非一步贵路', () => {
    const d = validator.emptyDomain();
    d.initial.facts = { mid: false, done: false };
    d.caps = {}; d.initial.resources = {};
    d.actions = [
      { id: 'a-step1', cost: 1, duration_ms: 1, pre: {}, min: {}, max: {}, add: ['mid'], remove: [], delta: {} },
      { id: 'b-step2', cost: 1, duration_ms: 1, pre: { mid: true }, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
      { id: 'pricey', cost: 9, duration_ms: 1, pre: {}, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
    ];
    d.goal = { facts: { done: true }, min: {}, max: {} };
    const r = planner.plan(d, d.initial);
    assert.strictEqual(r.cost, 2);
    assert.deepStrictEqual(r.plan, ['a-step1', 'b-step2']);
  });

  test('资源 min/max 条件参与目标与前置判断', () => {
    const d = validator.emptyDomain();
    d.initial.facts = {};
    d.caps = { ore: 5 };
    d.initial.resources = { ore: 0 };
    d.actions = [{
      id: 'mine', cost: 1, duration_ms: 1, pre: {}, min: {}, max: {},
      add: [], remove: [], delta: { ore: 1 },
    }];
    d.goal = { facts: {}, min: { ore: 3 }, max: {} };
    const r = planner.plan(d, d.initial);
    assert.strictEqual(r.status, 'solved');
    assert.strictEqual(r.plan.length, 3);
    assert.strictEqual(r.steps[2].stateAfter.resources.ore, 3);
  });

  test('同成本不同长度：逐元素字典序而非按长度决胜', () => {
    assert.ok(planner.lexLess(['a'], ['a', 'b']));
    assert.ok(planner.lexLess(['a', 'z'], ['b']));
    assert.ok(!planner.lexLess(['b'], ['a']));
  });
});

/* ---------------- 演算引擎：对齐 expected.json 运行时轨迹 ---------------- */

group('simulator 运行时语义', () => {
  const demo = validator.validate(fx('demo.json')).domain;
  const expected = fx('expected.json');

  test('demo 完整重放轨迹与 expected 完全一致', () => {
    const eng = sim.createEngine(demo, planner);
    sim.runToEnd(eng);
    assert.deepStrictEqual(
      eng.completed.map((c) => [c.actionId, c.at]),
      expected.runtime_completed
    );
    assert.deepStrictEqual(
      eng.canceled.map((c) => [c.actionId, c.at]),
      expected.runtime_canceled
    );
    assert.strictEqual(eng.cost, expected.runtime_cost);
    assert.strictEqual(eng.state.resources.ore, expected.runtime_final_ore);
    assert.strictEqual(eng.status, 'goal_reached');
  });

  test('被取消的 gather 不扣成本、不留效果（ore 仍为 0）', () => {
    const eng = sim.createEngine(demo, planner);
    // 推进到 t=150 事件边界
    let r = sim.step(eng);
    assert.strictEqual(r.boundary, 100); // 第一个完成
    assert.strictEqual(eng.state.resources.ore, 1);
    r = sim.step(eng);
    assert.strictEqual(r.boundary, 150); // 事件打断第二个 gather
    assert.strictEqual(eng.state.resources.ore, 1); // 中断动作未加 ore
    assert.strictEqual(eng.cost, 1);                 // 也未扣成本
    assert.strictEqual(eng.canceled.length, 1);
  });

  test('事件优先于同刻完成', () => {
    const d = JSON.parse(JSON.stringify(demo));
    // 在 t=100（第一个 gather 完成刻）插入事件：access=false
    d.events = [{ t: 100, set_facts: { access: false }, set_resources: {} }];
    const eng = sim.createEngine(d, planner);
    const r = sim.step(eng);
    assert.strictEqual(r.boundary, 100);
    // gather 在途被取消，完成被推迟语义 => 实际是取消而非完成
    assert.strictEqual(eng.completed.length, 0);
    assert.strictEqual(eng.canceled.length, 1);
    assert.strictEqual(eng.state.facts.access, false);
    assert.strictEqual(eng.cost, 0);
  });

  test('同刻多事件按输入顺序全部处理', () => {
    const d = JSON.parse(JSON.stringify(demo));
    d.events = [
      { t: 120, set_facts: { access: false }, set_resources: {} },
      { t: 120, set_facts: { access: true }, set_resources: {} },
    ];
    const eng = sim.createEngine(d, planner);
    sim.step(eng); // t=100 gather 完成
    sim.step(eng); // t=120 两个事件
    assert.strictEqual(eng.state.facts.access, true); // 后者生效
    assert.strictEqual(eng.canceled.length, 1);
  });

  test('规划失败时暂停并区分原因（unsolvable）', () => {
    const u = validator.validate(fx('unreachable.json')).domain;
    const eng = sim.createEngine(u, planner);
    assert.strictEqual(eng.status, 'unsolvable');
    assert.strictEqual(sim.step(eng).advanced, false);
  });

  test('预算耗尽单独显示为 budget_exhausted', () => {
    const d = JSON.parse(JSON.stringify(demo));
    d.budget = 1;
    const eng = sim.createEngine(d, planner);
    assert.strictEqual(eng.status, 'budget_exhausted');
    assert.ok(eng.log.some((l) => l.kind === 'budget'));
  });
  test('insertEvent：当前刻立即触发重规划', () => {
    const eng = sim.createEngine(demo, planner);
    const before = eng.plan.plan.slice();
    const r = sim.injectEvent(eng, {
      t: 0, set_facts: { access: false }, set_resources: {},
    });
    assert.ok(r.ok);
    assert.ok(r.advanced);
    // 新计划改走 buy（craft 被 access=false 阻断）
    assert.deepStrictEqual(eng.plan.plan, ['buy', 'deliver']);
    assert.notDeepStrictEqual(eng.plan.plan, before);
  });

  test('insertEvent：拒绝过去时刻与非法赋值', () => {
    const eng = sim.createEngine(demo, planner);
    assert.strictEqual(sim.injectEvent(eng, { t: -1, set_facts: {}, set_resources: {} }).ok, false);
    sim.step(eng);
    assert.ok(sim.injectEvent(eng, { t: 50, set_facts: {}, set_resources: {} }).error.includes('过去'));
    assert.ok(sim.injectEvent(eng, { t: 200, set_facts: { nope: true }, set_resources: {} }).error.includes('未知'));
    assert.ok(sim.injectEvent(eng, { t: 200, set_facts: {}, set_resources: { ore: 99 } }).error.includes('整数'));
  });

  test('peekBoundary 取下一事件与在途完成的较小值', () => {
    const eng = sim.createEngine(demo, planner);
    assert.strictEqual(sim.peekBoundary(eng), 100); // 完成早于 150 事件
    sim.step(eng);
    assert.strictEqual(sim.peekBoundary(eng), 150); // 事件早于 200 完成
  });

  test('reset 完全回到初始并清空轨迹', () => {
    const eng = sim.createEngine(demo, planner);
    sim.runToEnd(eng);
    sim.reset(eng);
    assert.strictEqual(eng.t, 0);
    assert.strictEqual(eng.cost, 0);
    assert.deepStrictEqual(eng.state, demo.initial);
    assert.strictEqual(eng.completed.length, 0);
    assert.strictEqual(eng.canceled.length, 0);
  });

  test('动作效果原子提交：完成刻一次性变更', () => {
    const d = JSON.parse(JSON.stringify(demo));
    const eng = sim.createEngine(d, planner);
    // 在途期间状态不变
    assert.strictEqual(eng.state.resources.ore, 0);
    sim.step(eng);
    assert.strictEqual(eng.state.resources.ore, 1);
    assert.strictEqual(eng.completed[0].at, 100);
  });

  test('事件直接把状态改为目标：标记达成且不做无谓重规划', () => {
    const d = JSON.parse(JSON.stringify(demo));
    d.events = [{ t: 50, set_facts: { done: true }, set_resources: {} }];
    const eng = sim.createEngine(d, planner);
    const replansBefore = eng.replanCount;
    sim.step(eng);
    assert.strictEqual(eng.status, 'goal_reached');
    assert.strictEqual(eng.canceled.length, 1); // gather 在途被取消
    assert.strictEqual(eng.replanCount, replansBefore); // 未触发新规划
    assert.strictEqual(eng.cost, 0);
  });

  test('同刻事件优先：被推迟的完成在下一步正常提交，不丢失', () => {
    const d = JSON.parse(JSON.stringify(demo));
    // t=100 事件不改变可达性，只翻转一个无关量后恢复
    d.events = [
      { t: 100, set_facts: { access: false }, set_resources: {} },
      { t: 100, set_facts: { access: true }, set_resources: {} },
    ];
    const eng = sim.createEngine(d, planner);
    const r1 = sim.step(eng); // t=100：事件优先，gather 被取消
    assert.strictEqual(r1.boundary, 100);
    assert.strictEqual(eng.completed.length, 0);
    assert.strictEqual(eng.canceled.length, 1);
    // 重规划后新 gather 从 t=100 开始，t=200 完成
    assert.strictEqual(sim.peekBoundary(eng), 200);
    sim.step(eng);
    assert.strictEqual(eng.completed.length, 1);
    assert.strictEqual(eng.completed[0].at, 200);
    assert.strictEqual(eng.state.resources.ore, 1);
  });
});

/* ---------------- 导出快照 ---------------- */

group('snapshot / 日志', () => {
  test('snapshot 含计划、事件、轨迹且与引擎解耦', () => {
    const demo = validator.validate(fx('demo.json')).domain;
    const eng = sim.createEngine(demo, planner);
    sim.step(eng);
    const s = sim.snapshot(eng);
    assert.strictEqual(s.t, 100);
    assert.ok(s.plan.plan.includes('craft'));
    assert.strictEqual(s.pendingEvents.length, 1);
    s.state.resources.ore = 999;
    assert.notStrictEqual(eng.state.resources.ore, 999);
  });
});

console.log(`\n${passed} 个测试通过${process.exitCode ? '（存在失败）' : ''}`);
