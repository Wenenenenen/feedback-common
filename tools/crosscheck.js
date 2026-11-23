/* 交叉验证：JS 求解器 vs Python 参考实现。运行：node tools/crosscheck.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../assets/solver.js');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(rng) {
  const n = 2 + Math.floor(rng() * 9);
  const m = 1 + Math.floor(rng() * 5);
  const horizon = 1 + Math.floor(rng() * 8);
  const hintSets = [['A', 'B'], ['未亮', '左灯', '右灯', '完成'], ['x', 'y', 'z']];
  const hints = hintSets[Math.floor(rng() * hintSets.length)];
  const states = Array.from({ length: n }, (_, i) => ({
    id: i + 1, hint: hints[Math.floor(rng() * hints.length)],
    goal: i === n - 1 && rng() < 0.7
  }));
  if (!states.some(s => s.goal)) states[Math.floor(rng() * n)].goal = true;
  const actions = Array.from({ length: m }, (_, j) => ({ id: j + 1, name: `a${j + 1}` }));
  const transitions = [];
  for (const s of states) {
    for (const a of actions) {
      if (rng() < 0.75) {
        const k = 1 + Math.floor(rng() * 2);
        const pool = states.map(x => x.id);
        const nxt = [];
        while (nxt.length < Math.min(k, n)) {
          const id = pool[Math.floor(rng() * pool.length)];
          if (!nxt.includes(id)) nxt.push(id);
        }
        transitions.push([s.id, a.id, nxt]);
      }
    }
  }
  const initSize = 1 + Math.floor(rng() * Math.min(3, n));
  const ids = states.map(s => s.id);
  const initial = [];
  while (initial.length < initSize) {
    const id = ids[Math.floor(rng() * ids.length)];
    if (!initial.includes(id)) initial.push(id);
  }
  return { horizon, states, actions, initial, transitions, rules: 'random' };
}

function jsFull(raw) {
  const { model } = S.buildModel(raw);
  const root = S.evaluate(model, model.initialMask, model.horizon);
  const rows = S.analyzeActions(model, model.initialMask, model.horizon).map(r => ({
    id: r.id, legal: r.legal, guaranteed: r.guaranteed,
    cost: r.cost, chosen: r.chosen,
    reason: !r.legal ? 'illegal' : !r.guaranteed ? 'failing-branch'
      : r.chosen ? 'chosen' : (r.eliminatedReason && r.eliminatedReason.includes('同分')) ? 'tie-lost' : 'ok',
    branches: (r.branches || []).map(b => ({
      hint: b.hint, belief: b.belief.slice().sort((x, y) => x - y), win: b.win,
      ...(b.win ? { cost: b.cost == null ? 0 : b.cost } : {})
    }))
  }));
  const traces = {};
  for (const ai of S.legalActions(model, model.initialMask)) {
    traces[String(model.actions[ai].id)] =
      S.counterTrace(model, model.initialMask, model.horizon, ai);
  }
  return {
    root: { win: root.win, cost: root.win ? root.cost : null,
      action: root.win && root.action >= 0 ? model.actions[root.action].id : null },
    rows, traces
  };
}

const END_REASON = {
  '时限耗尽，候选集仍含非终点状态': 'timeout',
  '候选集已全部是终点（不应发生于失败分支）': 'all-goal',
  '当前候选集上没有可继续推演的失败动作': 'stuck'
};
function normTrace(t) {
  return {
    ok: t.ok,
    reason: t.reason ? (t.reason === 'illegal' ? 'illegal' : 'no-failing-branch') : null,
    endReason: t.endReason ? (END_REASON[t.endReason] || t.endReason) : null,
    steps: (t.steps || []).map(s => ({
      actionId: s.actionId, hint: s.hint,
      belief: s.belief.slice().sort((x, y) => x - y), remaining: s.remaining
    }))
  };
}

function main() {
  const N = 300;
  const rng = mulberry32(20261124);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cross-'));
  let fails = 0;
  for (let i = 0; i < N; i++) {
    const raw = randomModel(rng);
    const file = path.join(tmp, `m${i}.json`);
    fs.writeFileSync(file, JSON.stringify(raw));
    const py = JSON.parse(execFileSync('python3', ['-I',
      path.join(__dirname, 'ref_solver.py'), '--full', file], { encoding: 'utf8' }));
    const js = jsFull(raw);

    const errs = [];
    if (py.root.win !== js.root.win || py.root.cost !== js.root.cost ||
      py.root.action !== js.root.action) {
      errs.push(['root', py.root, js.root]);
    }
    for (let k = 0; k < py.rows.length; k++) {
      const a = py.rows[k], b = js.rows[k];
      if (a.id !== b.id || a.legal !== b.legal || a.guaranteed !== b.guaranteed ||
        a.cost !== b.cost || a.chosen !== b.chosen || a.reason !== b.reason) {
        errs.push(['row', a, b]);
      }
      const ab = a.branches || [], bb = b.branches || [];
      if (JSON.stringify(ab) !== JSON.stringify(bb)) errs.push(['branches', ab, bb]);
    }
    for (const key of Object.keys(py.traces)) {
      const a = py.traces[key], b = normTrace(js.traces[key]);
      if (JSON.stringify({ ok: a.ok, reason: a.reason || null, endReason: a.endReason || null,
        steps: a.steps }) !== JSON.stringify(b)) {
        errs.push(['trace', a, b]);
      }
    }
    if (errs.length) {
      fails++;
      console.log(`CASE ${i} FAIL`, JSON.stringify(raw));
      errs.slice(0, 3).forEach(e => console.log('  ', e[0], '\n   py:', JSON.stringify(e[1]), '\n   js:', JSON.stringify(e[2])));
      if (fails >= 5) break;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fails) { console.log(`FAILED (${fails} cases differ)`); process.exit(1); }
  console.log(`OK: ${N} random models, JS matches Python on root/rows/branches/traces`);
}

main();
