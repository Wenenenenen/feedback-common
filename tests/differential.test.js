const test = require('node:test');
const assert = require('node:assert/strict');
const Cookfest = require('../js/cookfest.js');

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, n) => Math.floor(r() * n);
const pick = (r, xs) => xs[int(r, xs.length)];

function generate(seed) {
  const r = mulberry32(seed);
  const n = 1 + int(r, 5);
  const S = 1 + int(r, 3);
  const R = 1 + int(r, 3);
  const T = int(r, 3);
  const D = 2 + int(r, 6);
  const ings = Array.from({ length: R }, (_, i) => `m${i}`);
  const tools = Array.from({ length: T }, (_, i) => `t${i}`);
  const stations = Array.from({ length: S }, (_, i) => {
    let closed = [];
    if (r() < 0.25 && D >= 3) {
      const a = int(r, D - 1);
      const b = Math.min(D, a + 1 + int(r, 2));
      if (a < b) closed = [[a, b]];
    }
    return { id: i + 1, closed };
  });
  const stock = Object.fromEntries(ings.map((x) => [x, int(r, 3)]));
  const toolCapacity = Object.fromEntries(tools.map((x) => [x, 1 + int(r, 2)]));
  const jobs = [];
  for (let i = 1; i <= n; i++) {
    const after = [];
    if (i > 1 && r() < 0.45) after.push(1 + int(r, i - 1));
    const modes = [];
    const modeCount = 1 + int(r, 2);
    for (let mid = 1; mid <= modeCount; mid++) {
      const use = {};
      const yieldMap = {};
      const hold = {};
      if (r() < 0.7) use[pick(r, ings)] = 1 + int(r, 2);
      if (r() < 0.35) yieldMap[pick(r, ings)] = 1;
      if (T && r() < 0.4) hold[pick(r, tools)] = 1;
      modes.push({
        id: mid,
        station: 1 + int(r, S),
        ticks: 1 + int(r, 3),
        fee: int(r, 5),
        use,
        yield: yieldMap,
        hold
      });
    }
    jobs.push({ id: i, after: [...new Set(after)], modes });
  }
  return { deadline: D, stations, stock, tools: toolCapacity, jobs, locks: {} };
}

function bruteForce(raw, problem) {
  const D = raw.deadline;
  const lists = Cookfest._internal.candidateAt(problem, D).byStart.map((xs) => xs.flat());
  if (lists.some((xs) => xs.length === 0)) return null;
  let best = null;

  function compareKey(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  function rec(j, chosen) {
    if (j === lists.length) {
      const plain = chosen.map((c, index) => ({
        jobId: problem._runtime.jobs[index].id,
        modeId: c.modeId,
        start: c.start,
        end: c.end
      }));
      const verdict = Cookfest.verifyPlan(problem, plain);
      if (!verdict.valid) return;
      const makespan = Math.max(...chosen.map((c) => c.end));
      const cost = chosen.reduce((sum, c) => sum + c.fee, 0);
      const signature = chosen.flatMap((c) => [c.start, c.modeId]);
      const key = [makespan, cost, ...signature];
      if (!best || compareKey(key, best.key)) best = { key, makespan, cost, signature };
      return;
    }
    for (const c of lists[j]) {
      chosen[j] = c;
      rec(j + 1, chosen);
    }
  }
  rec(0, new Array(lists.length));
  return best;
}

test('random small schedules match independent brute force exactly', () => {
  for (let seed = 1; seed <= 250; seed++) {
    const raw = generate(seed);
    const normalized = Cookfest.normalizeProblem(raw);
    assert.equal(normalized.ok, true, normalized.errors ? normalized.errors.join('\n') : `seed ${seed} normalization failed`);
    const expected = bruteForce(raw, normalized.problem);
    const actual = Cookfest.solvePlan(raw);
    if (!expected) {
      assert.equal(actual.feasible, false, `seed ${seed}: expected unsolvable`);
    } else {
      assert.equal(actual.status, 'optimal', `seed ${seed}`);
      assert.equal(actual.makespan, expected.makespan, `seed ${seed} makespan`);
      assert.equal(actual.cost, expected.cost, `seed ${seed} cost`);
      assert.deepEqual(actual.signature, expected.signature, `seed ${seed} signature\n${JSON.stringify(raw)}`);
      assert.equal(actual.verification.valid, true, `seed ${seed} verification`);
    }
  }
});
