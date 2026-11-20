/*
 * 差分测试：随机生成小规模领域，用 BFS 穷举全部路径作为参考解，
 * 与 planner 的最优成本、字典序决胜逐项对比。
 * 运行：node tests/differential.test.js
 */
const assert = require('assert');
const planner = require('../js/planner.js');
const validator = require('../js/validator.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomDomain(rand) {
  const nFacts = 1 + Math.floor(rand() * 4);
  const nRes = Math.floor(rand() * 2);
  const factNames = Array.from({ length: nFacts }, (_, i) => 'f' + i);
  const resNames = Array.from({ length: nRes }, (_, i) => 'r' + i);
  const caps = {};
  resNames.forEach((n) => { caps[n] = 1 + Math.floor(rand() * 3); });

  const facts = {};
  factNames.forEach((n) => { facts[n] = rand() < 0.5; });
  const resources = {};
  resNames.forEach((n) => { resources[n] = Math.floor(rand() * (caps[n] + 1)); });

  const nActions = 2 + Math.floor(rand() * 5);
  const actions = [];
  for (let i = 0; i < nActions; i++) {
    const pre = {};
    factNames.forEach((n) => { if (rand() < 0.35) pre[n] = rand() < 0.5; });
    const min = {}, max = {}, delta = {};
    resNames.forEach((n) => {
      if (rand() < 0.3) min[n] = Math.floor(rand() * (caps[n] + 1));
      if (rand() < 0.2) max[n] = Math.floor(rand() * (caps[n] + 1));
      if (rand() < 0.6) {
        const d = 1 + Math.floor(rand() * 2);
        delta[n] = rand() < 0.5 ? -d : d;
      }
    });
    const add = [], remove = [];
    factNames.forEach((n) => {
      const roll = rand();
      if (roll < 0.2) add.push(n);
      else if (roll < 0.4) remove.push(n);
    });
    actions.push({
      id: 'a' + i, cost: 1 + Math.floor(rand() * 5),
      duration_ms: 1 + Math.floor(rand() * 10),
      pre, min, max, add, remove, delta,
    });
  }

  const goalFacts = {};
  factNames.forEach((n) => { if (rand() < 0.4) goalFacts[n] = rand() < 0.5; });
  const goalMin = {}, goalMax = {};
  resNames.forEach((n) => {
    if (rand() < 0.3) goalMin[n] = Math.floor(rand() * (caps[n] + 1));
  });

  return {
    initial: { facts, resources }, caps,
    goal: { facts: goalFacts, min: goalMin, max: goalMax },
    actions, budget: 100000, events: [],
  };
}

// 参考解：枚举所有简单状态路径（状态空间本身有限）
function bruteForce(domain) {
  const idx = planner.buildIndex(domain);
  const resIdx = {};
  idx.resNames.forEach((n, i) => { resIdx[n] = i; });
  const capsArr = idx.resNames.map((n) => domain.caps[n]);
  const start = planner.encodeState(domain, idx, domain.initial);

  let best = null; // { g, path }
  const seenBest = new Map();

  function key(bits, res) { return bits + '|' + res.join('|'); }
  function goal(bits, res) {
    return planner.isGoal(bits, res, domain.goal, idx.factIdx, resIdx);
  }

  const stack = [{ bits: start.bits, res: start.res, g: 0, path: [] }];
  while (stack.length) {
    const node = stack.pop();
    const k = key(node.bits, node.res);
    const prior = seenBest.get(k);
    if (prior && (prior.g < node.g ||
      (prior.g === node.g && !planner.lexLess(node.path, prior.path)))) continue;
    seenBest.set(k, { g: node.g, path: node.path });

    if (goal(node.bits, node.res)) {
      if (!best || node.g < best.g ||
        (node.g === best.g && planner.lexLess(node.path, best.path))) {
        best = { g: node.g, path: node.path.slice() };
      }
      continue;
    }
    for (const a of domain.actions) {
      if (!planner.applicable(a, node.bits, node.res, idx.factIdx, resIdx, capsArr)) continue;
      const nx = planner.applyAction(a, node.bits, node.res, idx.factIdx, resIdx);
      stack.push({ bits: nx.bits, res: nx.res, g: node.g + a.cost, path: node.path.concat(a.id) });
    }
  }
  return best;
}

let trials = 0;
const rand = rng(20261121);
for (let t = 0; t < 400; t++) {
  const raw = randomDomain(rand);
  const v = validator.validate(raw);
  if (!v.domain) continue;
  const domain = v.domain;
  trials++;
  const got = planner.plan(domain, domain.initial, 100000);
  const ref = bruteForce(domain);

  if (ref === null) {
    assert.strictEqual(got.status, 'unsolvable', `trial ${t}: 应为无解`);
  } else {
    assert.strictEqual(got.status, 'solved', `trial ${t}: 应可解`);
    assert.strictEqual(got.cost, ref.g, `trial ${t}: 成本 ${got.cost} != 参考 ${ref.g}`);
    assert.deepStrictEqual(got.plan, ref.path,
      `trial ${t}: 计划 ${got.plan.join(',')} != 参考 ${ref.path.join(',')}`);
    // 步骤状态与累计成本一致性
    let cum = 0;
    got.steps.forEach((s) => {
      const act = domain.actions.find((a) => a.id === s.actionId);
      cum += act.cost;
      assert.strictEqual(s.costAfter, cum);
    });
  }
}

console.log(`\n${trials} 个随机领域全部与暴力参考解一致（成本最优 + 字典序决胜）`);
