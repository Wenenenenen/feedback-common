/* 手工边界用例：node tools/edge_tests.js */
'use strict';
const S = require('../assets/solver.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) { console.error(`FAIL: ${name}`, detail || ''); process.exitCode = 1; }
  else { passed++; console.log(`ok - ${name}`); }
}
function solve(raw) {
  const r = S.buildModel(raw);
  if (!r.ok) throw new Error('build failed: ' + JSON.stringify(r.errors));
  const root = S.evaluate(r.model, r.model.initialMask, r.model.horizon);
  return { model: r.model, root, result: r };
}

// 1. 无解：时限 1，动作把候选集带到非终点
{
  const raw = {
    horizon: 1,
    states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'b', goal: true }],
    actions: [{ id: 1, name: 'x' }],
    initial: [1],
    transitions: [[1, 1, [1]]]
  };
  const { model, root } = solve(raw);
  check('无解：时限耗尽', root.win === false);
  const legal = S.legalActions(model, model.initialMask);
  const trace = S.counterTrace(model, model.initialMask, model.horizon, legal[0]);
  check('无解：反例给出致命提示', trace.ok && trace.steps.length === 1 &&
    trace.steps[0].hint === 'a' && trace.endReason.includes('时限'));
}

// 2. 同分取动作号小：两个动作都 1 拍到终点
{
  const raw = {
    horizon: 2,
    states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'g', goal: true }],
    actions: [{ id: 7, name: '大动作号' }, { id: 3, name: '小动作号' }],
    initial: [1],
    transitions: [[1, 7, [2]], [1, 3, [2]]]
  };
  const { model, root } = solve(raw);
  check('同分取动作号小', root.win && root.cost === 1 &&
    model.actions[root.action].id === 3);
  const rows = S.analyzeActions(model, model.initialMask, model.horizon);
  const big = rows.find(r => r.id === 7);
  check('同分动作标注淘汰原因', big.eliminatedReason && big.eliminatedReason.includes('同分'));
}

// 3. 初始集已是全部终点：零拍、无动作
{
  const raw = {
    horizon: 3,
    states: [{ id: 1, hint: 'g', goal: true }, { id: 2, hint: 'g', goal: true }],
    actions: [{ id: 1, name: 'x' }],
    initial: [1, 2],
    transitions: []
  };
  const { model, root } = solve(raw);
  check('全终点零拍', root.win && root.cost === 0 && root.action === -1);
  const tree = S.policyTree(model);
  check('全终点策略树是终止节点', tree.terminal && tree.allGoal);
}

// 4. 多后继按提示合并：两个状态动作后都进入同一提示下的不同状态，信念集合合并
{
  const raw = {
    horizon: 2,
    states: [
      { id: 1, hint: 'a' }, { id: 2, hint: 'a' },
      { id: 3, hint: 'b' }, { id: 4, hint: 'b' },
      { id: 5, hint: 'g', goal: true }
    ],
    actions: [{ id: 1, name: 'm' }, { id: 2, name: 'finish3' }, { id: 3, name: 'finish4' }],
    initial: [1, 2],
    transitions: [
      [1, 1, [3]], [2, 1, [4]],
      [3, 2, [5]], [4, 3, [5]]
    ]
  };
  const { model } = solve(raw);
  const applied = S.applyAction(model, model.initialMask, 0);
  check('同提示后继合并为单一信念集', applied.branches.length === 1 &&
    applied.branches[0].belief === undefined ||
    S.maskIds(applied.branches[0].mask, model.states).sort().join() === '3,4');
  const root = S.evaluate(model, model.initialMask, model.horizon);
  check('合并后无单一动作可保证（3/4 需要不同动作）', root.win === false);
}

// 5. 动作合法性：候选集中有一个状态没有出边即非法
{
  const raw = {
    horizon: 2,
    states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'a' }, { id: 3, hint: 'g', goal: true }],
    actions: [{ id: 1, name: 'x' }],
    initial: [1, 2],
    transitions: [[1, 1, [3]]]
  };
  const { model } = solve(raw);
  check('部分状态无出边则动作非法', S.legalActions(model, model.initialMask).length === 0);
  const rows = S.analyzeActions(model, model.initialMask, model.horizon);
  check('非法动作列出缺失状态', !rows[0].legal && rows[0].missingStates.includes(2));
}

// 6. 反例：点一个实际能保证的动作应被拒绝
{
  const raw = {
    horizon: 2,
    states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'g', goal: true }],
    actions: [{ id: 1, name: 'ok' }, { id: 2, name: 'bad' }],
    initial: [1],
    transitions: [[1, 1, [2]], [1, 2, [1]]]
  };
  const { model } = solve(raw);
  const trace = S.counterTrace(model, model.initialMask, model.horizon, 0);
  check('能保证的动作不构成反例', trace.ok === false && trace.reason.includes('所有提示分支'));
}

// 6b. 可解模型里的失败动作：时限 1，自环动作一拍后仍非终点
{
  const raw = {
    horizon: 1,
    states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'g', goal: true }],
    actions: [{ id: 1, name: '好' }, { id: 2, name: '坏' }],
    initial: [1],
    transitions: [[1, 1, [2]], [1, 2, [1]]]
  };
  const { model, root } = solve(raw);
  check('整体仍可保证（选好动作）', root.win && model.actions[root.action].id === 1);
  const rows = S.analyzeActions(model, model.initialMask, 1);
  check('坏动作被标记为不可保证', rows[1].guaranteed === false &&
    rows[1].eliminatedReason.includes('无法保证过关'));
  const trace = S.counterTrace(model, model.initialMask, 1, 1);
  check('坏动作反例给出致命提示', trace.ok && trace.steps[0].hint === 'a' &&
    trace.endReason.includes('时限'));
  const goodTrace = S.counterTrace(model, model.initialMask, 1, 0);
  check('好动作不构成反例', goodTrace.ok === false);
}

// 7. 最坏步数：两个分支步数不同，取最大
{
  const raw = {
    horizon: 4,
    states: [
      { id: 1, hint: 'start' },
      { id: 2, hint: 'fast' }, { id: 3, hint: 'slow' },
      { id: 4, hint: 'slow2' }, { id: 9, hint: 'g', goal: true }
    ],
    actions: [{ id: 1, name: 'split' }, { id: 2, name: 'go' }],
    initial: [1],
    transitions: [
      [1, 1, [2, 3]],
      [2, 2, [9]],
      [3, 2, [4]], [4, 2, [9]],
      // 让动作 2 在状态 1 也合法但不优
      [1, 2, [1]]
    ]
  };
  const { model, root } = solve(raw);
  // split: fast 分支 1+1=2 拍，slow 分支 split->3->4->9 = 3 拍；最坏 3
  check('最坏步数取分支最大', root.win && model.actions[root.action].id === 1 && root.cost === 3);
}

// 8. 校验：超限与坏引用
{
  const r = S.buildModel({ horizon: 99, states: [], actions: [], initial: [], transitions: [] });
  check('超限 horizon 报错', !r.ok && r.errors.some(e => e.includes('horizon')));
  const r2 = S.buildModel({
    horizon: 1,
    states: [{ id: 1, hint: 'a' }],
    actions: [{ id: 1, name: 'x' }],
    initial: [1],
    transitions: [[1, 1, [99]]]
  });
  check('坏后继引用报错', !r2.ok && r2.errors.some(e => e.includes('99')));
}

// 9. 大模型性能：128 状态 16 动作 12 拍，随机稠密转移
{
  const rng = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const N = 128, M = 16, H = 12;
  const states = Array.from({ length: N }, (_, i) => ({ id: i + 1, hint: 'h' + (i % 8), goal: i === N - 1 }));
  const actions = Array.from({ length: M }, (_, j) => ({ id: j + 1, name: 'a' + (j + 1) }));
  const transitions = [];
  for (let si = 1; si <= N; si++) {
    for (const a of actions) {
      const k = 1 + Math.floor(rng() * 3);
      const nxt = new Set();
      while (nxt.size < k) nxt.add(1 + Math.floor(rng() * N));
      transitions.push([si, a.id, [...nxt]]);
    }
  }
  const t0 = Date.now();
  const { model, root } = solve({ horizon: H, states, actions, initial: [1], transitions });
  const ms = Date.now() - t0;
  const t1 = Date.now();
  S.evaluate(model, model.initialMask, H);
  const cachedMs = Date.now() - t1;
  check(`128 状态稠密模型 3 秒内求解（首次 ${ms}ms，缓存命中 ${cachedMs}ms）`, ms < 3000, 'win=' + root.win);
}

console.log(`\n${passed} 项边界检查通过`);
