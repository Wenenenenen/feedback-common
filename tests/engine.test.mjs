/* Engine tests: exact enumeration, tie rules, witnesses, locks, bounds.
 * Run with: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Engine = require(join(root, 'src/engine.js'))();
const sample = JSON.parse(readFileSync(join(root, 'samples/league-cutline.json'), 'utf8'));
const flip = JSON.parse(readFileSync(join(root, 'samples/leader-flip.json'), 'utf8'));

/* Independent, deliberately naive reference: rebuilds every table from
 * scratch for each assignment. */
function reference(raw, K, locks) {
  const teams = raw.teams.slice().sort((a, b) => a - b);
  const n = teams.length;
  const idx = new Map(teams.map((t, i) => [t, i]));
  const pending = raw.matches.filter((m) => m.candidates).slice().sort((a, b) => a.id - b.id);
  const fixed = raw.matches.filter((m) => m.score);
  const emptyGrid = () => Array.from({ length: n }, () => new Array(n).fill(0));

  function rank(assign) {
    const P = new Array(n).fill(0), D = new Array(n).fill(0);
    const VP = emptyGrid(), VD = emptyGrid();
    const play = (left, right, l, r) => {
      const a = idx.get(left), b = idx.get(right);
      const pl = l > r ? 3 : l === r ? 1 : 0, pr = r > l ? 3 : l === r ? 1 : 0, d = l - r;
      P[a] += pl; P[b] += pr; D[a] += d; D[b] -= d;
      VP[a][b] += pl; VP[b][a] += pr; VD[a][b] += d; VD[b][a] -= d;
    };
    fixed.forEach((m) => play(m.left, m.right, m.score[0], m.score[1]));
    pending.forEach((m, i) => {
      const c = m.candidates[assign[i]];
      play(m.left, m.right, c[0], c[1]);
    });
    const order = [];
    function resolve(list) {
      if (list.length === 1) { order.push(list[0]); return; }
      const hp = new Map(list.map((t) => [t, 0]));
      const hd = new Map(list.map((t) => [t, 0]));
      for (const i of list) for (const j of list) {
        if (i === j) continue;
        hp.set(i, hp.get(i) + VP[i][j]);
        hd.set(i, hd.get(i) + VD[i][j]);
      }
      const sorted = list.slice().sort((x, y) =>
        hp.get(y) - hp.get(x) || hd.get(y) - hd.get(x) || teams[x] - teams[y]);
      const allEqual = sorted.every((t) => hp.get(t) === hp.get(sorted[0]) && hd.get(t) === hd.get(sorted[0]));
      if (allEqual) {
        list.slice().sort((x, y) => D[y] - D[x] || teams[x] - teams[y]).forEach((t) => order.push(t));
        return;
      }
      let i = 0;
      while (i < sorted.length) {
        let j = i + 1;
        while (j < sorted.length && hp.get(sorted[j]) === hp.get(sorted[i]) && hd.get(sorted[j]) === hd.get(sorted[i])) j++;
        const run = sorted.slice(i, j);
        run.length === 1 ? order.push(run[0]) : resolve(run);
        i = j;
      }
    }
    const byPoints = new Map();
    for (let i = 0; i < n; i++) {
      if (!byPoints.has(P[i])) byPoints.set(P[i], []);
      byPoints.get(P[i]).push(i);
    }
    [...byPoints.keys()].sort((a, b) => b - a).forEach((p) => resolve(byPoints.get(p)));
    return order;
  }

  const lockedIds = Object.keys(locks || {}).map(Number);
  const assign = pending.map((m) => (Object.prototype.hasOwnProperty.call(locks || {}, m.id) ? locks[m.id] : 0));
  const free = pending.map((m, i) => i).filter((i) => !lockedIds.includes(pending[i].id));
  const counts = new Array(n).fill(0);
  const firstQ = new Array(n).fill(null), firstE = new Array(n).fill(null);
  let total = 0;
  (function walk(k) {
    if (k === free.length) {
      total++;
      rank(assign).forEach((t, r) => {
        if (r < K) { counts[t]++; if (!firstQ[t]) firstQ[t] = assign.slice(); }
        else if (!firstE[t]) firstE[t] = assign.slice();
      });
      return;
    }
    const i = free[k];
    for (let c = 0; c < pending[i].candidates.length; c++) { assign[i] = c; walk(k + 1); }
    assign[i] = 0;
  })(0);
  return {
    total,
    teams: teams.map((t, i) => ({
      id: t, qualify: counts[i], eliminate: total - counts[i],
      earliestQualify: firstQ[i], earliestEliminate: firstE[i]
    }))
  };
}

function summarise(raw, K, locks) {
  const engine = Engine.create(raw, { qualifiers: K, locks });
  const analysis = engine.analyze();
  return { engine, analysis, summary: Engine.summarize(analysis, K) };
}

test('sample dataset counts and witnesses match the reference', () => {
  const { analysis, summary } = summarise(sample, sample.qualifiers, {});
  const want = reference(sample, sample.qualifiers, {});
  assert.equal(analysis.total, want.total);
  for (const w of want.teams) {
    const got = summary.teams.find((t) => t.id === w.id);
    assert.equal(got.qualify, w.qualify, 'qualify count for team ' + w.id);
    assert.equal(got.eliminate, w.eliminate, 'eliminate count for team ' + w.id);
    assert.deepEqual(got.earliestQualify, w.earliestQualify, 'qualify witness for team ' + w.id);
    assert.deepEqual(got.earliestEliminate, w.earliestEliminate, 'eliminate witness for team ' + w.id);
  }
});

test('randomised data matches the reference, with and without locks', () => {
  let seed = 24680;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 30; trial++) {
    const n = 2 + (trial % 5);
    const teams = Array.from({ length: n }, (_, i) => i + 1);
    const pairs = new Map();
    const matches = [];
    let id = 1;
    const pendingWanted = 1 + (trial % 4);
    for (let p = 0; p < pendingWanted; p++) {
      let a, b, key, guard = 0;
      do {
        a = Math.floor(rnd() * n); b = Math.floor(rnd() * n);
        key = Math.min(a, b) + '-' + Math.max(a, b);
        guard++;
      } while ((a === b || (pairs.get(key) || 0) >= 2) && guard < 500);
      if (guard >= 500) continue;
      pairs.set(key, (pairs.get(key) || 0) + 1);
      const cands = [];
      while (cands.length < 1 + (trial % 3)) {
        const l = Math.floor(rnd() * 3), r = Math.floor(rnd() * 3);
        if (!cands.some((c) => c[0] === l && c[1] === r)) cands.push([l, r]);
      }
      matches.push({ id: id++, left: teams[a], right: teams[b], candidates: cands });
    }
    for (let p = 0; p < 3; p++) {
      const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
      if (a === b) continue;
      const key = Math.min(a, b) + '-' + Math.max(a, b);
      if ((pairs.get(key) || 0) >= 2) continue;
      pairs.set(key, (pairs.get(key) || 0) + 1);
      matches.push({ id: id++, left: teams[a], right: teams[b], score: [Math.floor(rnd() * 3), Math.floor(rnd() * 3)] });
    }
    const raw = { teams, qualifiers: trial % (n + 1), matches };
    const K = raw.qualifiers;
    const locks = trial % 3 === 0 && matches.some((m) => m.candidates)
      ? { [matches.find((m) => m.candidates).id]: 0 } : {};
    const { analysis, summary } = summarise(raw, K, locks);
    const want = reference(raw, K, locks);
    assert.equal(analysis.total, want.total, 'scenario count, trial ' + trial);
    for (const w of want.teams) {
      const got = summary.teams.find((t) => t.id === w.id);
      assert.equal(got.qualify, w.qualify, 'qualify, trial ' + trial + ', team ' + w.id);
      assert.deepEqual(got.earliestQualify, w.earliestQualify, 'Q witness, trial ' + trial + ', team ' + w.id);
      assert.deepEqual(got.earliestEliminate, w.earliestEliminate, 'E witness, trial ' + trial + ', team ' + w.id);
    }
  }
});

test('head-to-head recomputation can change the group leader', () => {
  const { engine, analysis, summary } = summarise(flip, flip.qualifiers, {});
  let found = null;
  for (const team of summary.teams) {
    const ranks = [team.earliestQualifyRank, team.earliestEliminateRank].filter((r) => r !== null);
    for (const rank of ranks) {
      const witness = analysis.teams.find((t) => t.id === team.id).firstByRank[rank];
      const replay = engine.scenario(witness, true);
      for (const round of replay.rounds) {
        if (round.level === 0 || round.kind !== 'h2h') continue;
        const parent = replay.rounds[round.parentSeq];
        if (parent && parent.rows[0].id !== round.rows[0].id &&
            round.rows.some((r) => r.id === parent.rows[0].id)) {
          found = { parent, round };
        }
      }
      if (found) break;
    }
    if (found) break;
  }
  assert.ok(found, 'expected one witness whose deeper round reorders the leader');
  assert.ok(found.round.members.length > 1);
  for (const row of found.round.rows) {
    assert.ok(found.parent.members.includes(row.id), 'round members are inside the parent group');
  }
});

test('replayed standings agree with the recorded rounds', () => {
  const { engine, analysis } = summarise(sample, sample.qualifiers, {});
  for (const team of analysis.teams) {
    for (let rank = 0; rank < team.rankHist.length; rank++) {
      if (!team.rankHist[rank]) continue;
      const replay = engine.scenario(team.firstByRank[rank], true);
      assert.equal(replay.standings[rank].id, team.id);
      for (const round of replay.rounds) {
        if (round.level === 0) continue;
        const parent = replay.rounds[round.parentSeq];
        assert.ok(parent, 'every nested round names its parent');
        for (const id of round.members) assert.ok(parent.members.includes(id));
      }
    }
  }
});

test('qualifier count scales the same analysis without re-enumerating', () => {
  const engine = Engine.create(flip, { qualifiers: 1 });
  const analysis = engine.analyze();
  for (let k = 0; k <= flip.teams.length; k++) {
    const summary = Engine.summarize(analysis, k);
    const want = reference(flip, k, {});
    for (const w of want.teams) {
      const got = summary.teams.find((t) => t.id === w.id);
      assert.equal(got.qualify, w.qualify, 'K=' + k + ', team ' + w.id);
    }
  }
});

test('bounds and input errors are reported clearly', () => {
  const reject = (raw, pattern) => {
    assert.throws(() => Engine.normalize(raw), (err) => err && err.name === 'CutlineInputError' && pattern.test(err.message));
  };
  reject({ teams: [1, 2, 3, 4, 5, 6, 7, 8, 9], qualifiers: 1, matches: [] }, /8/);
  reject({ teams: [1, 2], qualifiers: 1, matches: [
    { id: 1, left: 1, right: 2, score: [0, 0] },
    { id: 2, left: 1, right: 2, score: [0, 0] },
    { id: 3, left: 1, right: 2, score: [0, 0] }] }, /超过 2 场/);
  reject({ teams: [1, 2], qualifiers: 1, matches: [{ id: 1, left: 1, right: 2, candidates: [[1, 0], [1, 0]] }] }, /重复/);
  reject({ teams: [1, 2], qualifiers: 1, matches: [{ id: 1, left: 1, right: 2, score: [0, 0], candidates: [[1, 0]] }] }, /只能有/);
  reject({ teams: [1, 2], qualifiers: 1, matches: [{ id: 1, left: 1, right: 2, candidates: [[1, 0], [0, 1], [1, 1], [2, 2]] }] }, /1–3/);
  const many = [];
  for (let a = 1; a <= 8 && many.length < 15; a++) {
    for (let b = a + 1; b <= 8 && many.length < 15; b++) many.push({ id: many.length + 1, left: a, right: b, candidates: [[0, 0]] });
  }
  reject({ teams: [1, 2, 3, 4, 5, 6, 7, 8], qualifiers: 1, matches: many }, /14/);
});

test('the maximum 14 x 3 case completes well inside 12 seconds', () => {
  const teams = [1, 2, 3, 4, 5, 6, 7, 8];
  const pairings = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) pairings.push([teams[a], teams[b]]);
  const matches = pairings.slice(0, 14).map(([left, right], i) => ({
    id: i + 1, left, right,
    candidates: [[0, 0], [1, 0], [0, 1]]
  }));
  const started = Date.now();
  const engine = Engine.create({ teams, qualifiers: 4, matches }, { qualifiers: 4 });
  const analysis = engine.analyze();
  const elapsed = Date.now() - started;
  assert.equal(analysis.total, Math.pow(3, 14));
  assert.ok(elapsed < 12000, 'took ' + elapsed + ' ms');
});
