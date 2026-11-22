// 独立测试：从 index.html 抽取引擎源码，并用朴素回溯/朴素极小化极大交叉验证。
// 运行：node tests/run-tests.mjs samples/draft-endgame.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const m = html.match(/<script type="text\/draft-engine" id="engine-source">([\s\S]*?)<\/script>/);
assert(m, '未找到引擎 script 块');
const sandbox = {
  Math, Map, Set, Date, Number, Array, Object, JSON, Int8Array, Uint32Array,
  Error, isNaN, parseInt, Infinity
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox);
const { createDraftEngine, buildBenchmarkPackage, lexLess } = sandbox.globalThis.__DraftEngine;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e));
    process.exitCode = 1;
  }
}

/* ================= 独立朴素实现（不依赖引擎任何求解函数） ================= */

// 朴素部分匹配：允许空槽，但所有给定英雄都必须放进互异的合规槽（一个都不能丢）
function naiveCanFillPartial(heroes, key, gis) {
  const used = new Array(gis.length).fill(false);
  let placed = 0;
  function go(slot) {
    if (slot === 4) return placed === gis.length; // 槽走完时英雄也须全部落位
    if (go(slot + 1)) return true; // 本槽留空
    for (let i = 0; i < gis.length; i++) {
      if (used[i]) continue;
      if (heroes[gis[i]][key][slot] !== null) {
        used[i] = true; placed++;
        const ok = go(slot + 1);
        used[i] = false; placed--;
        if (ok) return true;
      }
    }
    return false;
  }
  return go(0);
}
// 朴素满编匹配
function naiveCanFill(heroes, key, gis) {
  if (gis.length !== 4) return false;
  const used = new Array(4).fill(false);
  function go(slot) {
    if (slot === 4) return true;
    for (let i = 0; i < 4; i++) {
      if (used[i]) continue;
      if (heroes[gis[i]][key][slot] !== null) {
        used[i] = true;
        if (go(slot + 1)) return true;
        used[i] = false;
      }
    }
    return false;
  }
  return go(0);
}
// 朴素最优分配：穷举 4! 排列
function naiveBest(heroes, key, syn, gis) {
  assert.equal(gis.length, 4);
  const H = heroes.length;
  const perm = [];
  const used = new Array(4).fill(false);
  let best = null;
  function scoreOf(seq) {
    let v = 0;
    for (let s = 0; s < 4; s++) {
      const g = seq[s];
      const cell = heroes[g][key][s];
      if (cell === null) return null;
      v += cell;
    }
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const x = seq[i], y = seq[j];
      const pair = x < y ? x * H + y : y * H + x;
      if (syn.has(pair)) v += syn.get(pair);
    }
    return v;
  }
  function go() {
    if (perm.length === 4) {
      const v = scoreOf(perm);
      if (v === null) return;
      const seqIds = perm.map(g => heroes[g].id);
      if (best === null || v > best.v || (v === best.v && lexLess(seqIds, best.seqIds))) {
        best = { v, seq: perm.slice(), seqIds };
      }
      return;
    }
    for (let i = 0; i < 4; i++) {
      if (used[i]) continue;
      used[i] = true; perm.push(gis[i]); go(); perm.pop(); used[i] = false;
    }
  }
  go();
  return best;
}
function synMapOf(pkg, key, heroes, id2gi) {
  const H = heroes.length;
  return new Map((pkg[key] || []).map(([x, y, v]) => {
    const gx = id2gi.get(x), gy = id2gi.get(y);
    return gx < gy ? [gx * H + gy, v] : [gy * H + gx, v];
  }));
}
function naiveTerminal(pkg, heroes, id2gi, gaGis, gbGis, synAMap, synBMap) {
  const a = naiveBest(heroes, 'a', synAMap, gaGis);
  const b = naiveBest(heroes, 'b', synBMap, gbGis);
  assert(a && b, '朴素：终局队伍必须可填满');
  let d = a.v - b.v;
  const inA = new Set(gaGis), inB = new Set(gbGis);
  for (const [agId, as, bgId, bs, val] of pkg.counter || []) {
    const ag = id2gi.get(agId), bg = id2gi.get(bgId);
    // 正向：甲持主动角色、乙持对方角色且槽位吻合 → 甲对乙 +val
    if (inA.has(ag) && inB.has(bg) && a.seq[as] === ag && b.seq[bs] === bg) d += val;
    // 反向：乙持主动角色、甲持对方角色且槽位吻合 → 乙对甲，扣分差
    if (inB.has(ag) && inA.has(bg) && b.seq[as] === ag && a.seq[bs] === bg) d -= val;
  }
  return d;
}
// 朴素 minimax（独立实现：集合状态 + 键记忆化，匹配/分配仍用朴素回溯）
const WIN = 2000000000, NORMAL = 1000000000, LOSS = 0;
function naiveSolve(pkg, entry) {
  const heroes = pkg.heroes.slice().sort((x, y) => x.id - y.id);
  const id2gi = new Map(heroes.map((h, i) => [h.id, i]));
  const synAMap = synMapOf(pkg, 'synA', heroes, id2gi);
  const synBMap = synMapOf(pkg, 'synB', heroes, id2gi);
  const preA = pkg.a.map(id => id2gi.get(id));
  const preB = pkg.b.map(id => id2gi.get(id));
  const memo = new Map();
  const e0 = entry || { avail: pkg.available.slice(), pa: [], pb: [], t: 0 };

  // 朴素可满编 DP：与引擎 reachable 同语义，但用 id 集合独立实现。
  // basePicks 为入口局面本队已从池中选入的 id（它们已固定，必在路径上）
  function buildReach(preGis, key, need, basePicks, remainingAvail) {
    const reach = new Map(); // 池 id 排序串 -> bool
    reach.set('', true);
    const avail = remainingAvail.slice().sort((x, y) => x - y);
    const needMore = need - basePicks.length;
    function fillNow(chosenIds) {
      const gis = preGis.concat(basePicks.concat(chosenIds).map(id => id2gi.get(id)));
      return naiveCanFillPartial(heroes, key, gis);
    }
    function fillFull(chosenIds) {
      const gis = preGis.concat(basePicks.concat(chosenIds).map(id => id2gi.get(id)));
      return gis.length === 4 && naiveCanFill(heroes, key, gis);
    }
    // 入口已选必须本身可放，否则整个入口无解
    if (basePicks.length && !fillNow([])) return new Map();
    for (let k = 1; k <= needMore; k++) {
      for (const combo of combinations(avail, k)) {
        if (!fillNow(combo)) continue;
        const ok = combo.some(id => {
          const parent = combo.filter(x => x !== id);
          return reach.get(parent.sort((x, y) => x - y).join(',')) === true;
        });
        if (ok) reach.set(combo.join(','), true);
      }
    }
    // 终层必须真能满编
    for (const [k, v] of Array.from(reach.entries())) {
      if (v && k.split(',').filter(Boolean).length === needMore && !fillFull(k.split(',').filter(Boolean).map(Number))) {
        reach.set(k, false);
      }
    }
    return reach;
  }
  function combinations(arr, k) {
    const out = [];
    function go(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); go(i + 1, cur); cur.pop(); }
    }
    go(0, []);
    return out;
  }
  const reachA = buildReach(preA, 'a', 4 - preA.length, e0.pa, e0.avail);
  const reachB = buildReach(preB, 'b', 4 - preB.length, e0.pb, e0.avail);
  function pickOk(team, picks) {
    const reach = team === 'A' ? reachA : reachB;
    const base = team === 'A' ? e0.pa : e0.pb;
    const extra = picks.filter(x => !base.includes(x));
    return reach.get(extra.slice().sort((x, y) => x - y).join(',')) === true;
  }

  function go(availSet, picksA, picksB, t) {
    if (t === pkg.turns.length) {
      const ga = preA.concat(picksA.map(id => id2gi.get(id)));
      const gb = preB.concat(picksB.map(id => id2gi.get(id)));
      return { v: NORMAL + naiveTerminal(pkg, heroes, id2gi, ga, gb, synAMap, synBMap), id: null };
    }
    const key = Array.from(availSet).sort((x, y) => x - y).join(',') + '|' +
      picksA.slice().sort((x, y) => x - y).join(',') + '|' +
      picksB.slice().sort((x, y) => x - y).join(',') + '|' + t;
    if (memo.has(key)) return memo.get(key);
    const [team, action] = pkg.turns[t];
    const max = team === 'A';
    let best = null;
    for (const id of Array.from(availSet).sort((x, y) => x - y)) {
      let r;
      if (action === 'pick') {
        const picks = (team === 'A' ? picksA : picksB).concat(id);
        if (!pickOk(team, picks)) continue; // 可满编前瞻，与引擎一致
        const rest = new Set(availSet); rest.delete(id);
        r = team === 'A'
          ? go(rest, picksA.concat(id), picksB, t + 1)
          : go(rest, picksA, picksB.concat(id), t + 1);
      } else {
        const rest = new Set(availSet); rest.delete(id);
        r = go(rest, picksA, picksB, t + 1);
      }
      if (best === null || (max ? r.v > best.v : r.v < best.v) ||
        (r.v === best.v && id < best.id)) best = { v: r.v, id };
    }
    const result = best === null ? { v: max ? LOSS : WIN, id: null } : best;
    memo.set(key, result);
    return result;
  }
  return {
    root: go(new Set(e0.avail), e0.pa.slice(), e0.pb.slice(), e0.t),
    heroes, id2gi
  };
}
// 朴素展开某首手后的子值：在原包上走一步，把局面作为入口传入，回合序列不变
function naiveChildValue(pkg, firstId) {
  const [team, action] = pkg.turns[0];
  const entry = {
    avail: pkg.available.filter(x => x !== firstId),
    pa: [], pb: [], t: 1
  };
  if (action === 'pick') (team === 'A' ? entry.pa : entry.pb).push(firstId);
  return naiveSolve(pkg, entry).root.v;
}

/* ================= 测试用例 ================= */

const samplePath = process.argv[2] || 'samples/draft-endgame.json';
const samplePkg = JSON.parse(readFileSync(join(root, samplePath), 'utf8'));

console.log('1) 示例包基础行为');
test('示例包可加载，初始池 2 人、剩余 2 手', () => {
  const eng = createDraftEngine(samplePkg);
  const s = eng.initialState();
  assert.equal(eng.stats().poolSize, 2);
  assert.equal(s.av, 0b11);
  assert.equal(eng.turns.length, 2);
});

test('示例包两手均合法', () => {
  const eng = createDraftEngine(samplePkg);
  const s = eng.initialState();
  const info = eng.legalMoves(s.av, s.pa, s.pb, 0);
  assert.equal(info.moves.length, 2);
  assert(info.moves.every(m => m.legal));
});

test('根节点值与每个首手子值都与朴素 minimax 一致', () => {
  const eng = createDraftEngine(samplePkg);
  const s = eng.initialState();
  const res = eng.analyze(s.av, s.pa, s.pb, 0);
  const ref = naiveSolve(samplePkg);
  assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), ref.root.v, '根值');
  for (const mv of res.moves) {
    const r = eng.solveRoot(s.av, s.pa, s.pb, 0, mv.bit);
    assert.equal(r.value, naiveChildValue(samplePkg, mv.id), '首手 #' + mv.id + ' 子值');
    assert(Array.isArray(r.continuation));
  }
});

test('最优续手链每一步都是该局面的最优手', () => {
  const eng = createDraftEngine(samplePkg);
  let s = eng.initialState();
  const first = eng.legalMoves(s.av, s.pa, s.pb, 0).moves.find(m => m.legal);
  const r = eng.solveRoot(s.av, s.pa, s.pb, 0, first.bit);
  let cur = eng.stepState(s.av, s.pa, s.pb, 0, first.bit);
  for (const c of r.continuation) {
    const info = eng.legalMoves(cur.av, cur.pa, cur.pb, cur.t);
    const rows = info.moves.filter(m => m.legal).map(m => ({
      id: m.id, v: eng.solveRoot(cur.av, cur.pa, cur.pb, cur.t, m.bit).value
    }));
    const max = info.turn.team === 'A';
    rows.sort((x, y) => max ? (y.v - x.v || x.id - y.id) : (x.v - y.v || x.id - y.id));
    assert.equal(rows[0].id, c.id, '续手应为当前局面最优');
    cur = eng.stepState(cur.av, cur.pa, cur.pb, cur.t, bitOfId(eng, c.id));
  }
  assert.equal(cur.t, eng.turns.length);
});
function bitOfId(eng, id) {
  const gi = eng.heroes.findIndex(h => h.id === id);
  for (let b = 0; b < 16; b++) if (eng.pool[b] === gi) return b;
  throw new Error('id 不在池中');
}

console.log('\n2) 随机包：与朴素 minimax 穷举交叉验证（含配合、克制、占槽非法手）');
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }
function makeRandomPkg(seed) {
  const rand = rng(seed);
  const nAvail = 7;
  const heroes = [];
  for (let id = 1; id <= nAvail; id++) {
    heroes.push({
      id,
      a: [0, 1, 2, 3].map(() => rand() < 0.3 ? null : Math.floor(rand() * 11) - 5),
      b: [0, 1, 2, 3].map(() => rand() < 0.3 ? null : Math.floor(rand() * 11) - 5)
    });
  }
  for (let id = 101; id <= 102; id++) heroes.push({ id, a: [3, 3, null, null], b: [null, null, null, null] });
  for (let id = 201; id <= 202; id++) heroes.push({ id, a: [null, null, null, null], b: [3, 3, null, null] });
  // 6 手：每队恰 2 选 1 禁，保证终局 4 人
  const turns = [['A', 'ban'], ['B', 'ban'], ['A', 'pick'], ['B', 'pick'], ['A', 'pick'], ['B', 'pick']];
  const pkg = {
    rules: ['随机测试包'], heroes,
    available: heroes.slice(0, nAvail).map(h => h.id),
    a: [101, 102], b: [201, 202], turns,
    synA: [], synB: [], counter: []
  };
  const synPairs = new Set();
  for (let i = 0; i < 3; i++) {
    const x = 1 + Math.floor(rand() * nAvail), y = 1 + Math.floor(rand() * nAvail);
    const key = x < y ? x + '-' + y : y + '-' + x;
    if (x !== y && !synPairs.has(key)) { synPairs.add(key); pkg.synA.push([x, y, Math.floor(rand() * 9) - 4]); }
  }
  const synPairsB = new Set();
  for (let i = 0; i < 3; i++) {
    const x2 = 1 + Math.floor(rand() * nAvail), y2 = 1 + Math.floor(rand() * nAvail);
    const key = x2 < y2 ? x2 + '-' + y2 : y2 + '-' + x2;
    if (x2 !== y2 && !synPairsB.has(key)) { synPairsB.add(key); pkg.synB.push([x2, y2, Math.floor(rand() * 9) - 4]); }
  }
  for (let i = 0; i < 5; i++) {
    const x = 1 + Math.floor(rand() * nAvail), y = 1 + Math.floor(rand() * nAvail);
    pkg.counter.push([x, Math.floor(rand() * 4), y, Math.floor(rand() * 4), Math.floor(rand() * 13) - 6]);
  }
  return pkg;
}

for (let seed = 1; seed <= 40; seed++) {
  test('随机包 seed=' + seed, () => {
    const pkg = makeRandomPkg(seed);
    const eng = createDraftEngine(pkg); // 不合法会直接抛错，测试即失败
    const s = eng.initialState();
    const info = eng.legalMoves(s.av, s.pa, s.pb, 0);
    const legal = info.moves.filter(m => m.legal);
    const ref = naiveSolve(pkg);
    assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), ref.root.v, '根值不一致');
    for (const mv of legal) {
      const r = eng.solveRoot(s.av, s.pa, s.pb, 0, mv.bit);
      assert.equal(r.value, naiveChildValue(pkg, mv.id), '首手 #' + mv.id + ' 子值不一致');
    }
    // 最优首手 id（同值取小编号）
    const max = pkg.turns[0][0] === 'A';
    const sorted = legal.slice().sort((x, y) => {
      const vx = eng.solveRoot(s.av, s.pa, s.pb, 0, x.bit).value;
      const vy = eng.solveRoot(s.av, s.pa, s.pb, 0, y.bit).value;
      return max ? (vy - vx || x.id - y.id) : (vx - vy || x.id - y.id);
    });
    assert.equal(sorted[0].id, ref.root.id, '最优首手不一致');
    // 沿最优链行走：强制胜负会在中途（无合法手）终止，只有走满回合才核对终局分差
    let cur = s;
    const chain = [sorted[0].id];
    let rr = eng.solveRoot(cur.av, cur.pa, cur.pb, 0, sorted[0].bit);
    cur = eng.stepState(cur.av, cur.pa, cur.pb, 0, sorted[0].bit);
    rr.continuation.forEach(c => { chain.push(c.id); cur = eng.stepState(cur.av, cur.pa, cur.pb, cur.t, bitOfId(eng, c.id)); });
    if (cur.t === pkg.turns.length) {
      const diff = eng.terminalDiff(cur.av, cur.pa, cur.pb);
      assert.equal(eng.constants.NORMAL_BASE + diff, rr.endValue, '终局编码值与分差不一致');
      // 满编终局两队人数都应为 4
      const masks = eng.stateMasks(cur.pa, cur.pb);
      assert.equal(popcount(masks.ga), 4);
      assert.equal(popcount(masks.gb), 4);
    } else {
      // 中途终止必为强制胜负，endValue 应落在 WIN/LOSS 区
      assert(rr.endValue >= eng.constants.WIN_BASE || rr.endValue < eng.constants.NORMAL_BASE,
        '中途终止的最优链必须导向强制胜负');
    }
  });
}

console.log('\n3) 规则边界');
test('无合法选人手的一方判负，胜负排在分差之外', () => {
  // 甲已预选 3 人且锁死槽 0/1/2；池里两个角色都不能占槽 3 → 甲任何选入都无法填满四槽
  const p = {
    rules: [],
    heroes: [
      { id: 1, a: [1, 1, 1, null], b: [null, null, null, null] },
      { id: 2, a: [1, 1, 1, null], b: [null, null, null, null] },
      { id: 101, a: [5, null, null, null], b: [null, null, null, null] },
      { id: 102, a: [null, 5, null, null], b: [null, null, null, null] },
      { id: 103, a: [null, null, 5, null], b: [null, null, null, null] },
      { id: 201, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 202, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 203, a: [null, null, null, null], b: [1, 1, 1, 1] }
    ],
    available: [1, 2], a: [101, 102, 103], b: [201, 202, 203],
    turns: [['A', 'pick'], ['B', 'pick']], synA: [], synB: [], counter: []
  };
  const eng = createDraftEngine(p);
  const s = eng.initialState();
  const info = eng.legalMoves(s.av, s.pa, s.pb, 0);
  assert.equal(info.moves.filter(m => m.legal).length, 0);
  assert(info.moves.every(m => m.reason && m.reason.length > 0), '非法手应给出原因');
  // 根值 = LOSS（甲无手），且小于任何 NORMAL 值
  assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), LOSS);
  // 镜像：乙无手则判甲胜
  const p2 = {
    rules: [],
    heroes: [
      { id: 1, a: [null, null, null, null], b: [1, 1, 1, null] },
      { id: 2, a: [null, null, null, null], b: [1, 1, 1, null] },
      { id: 101, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 102, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 103, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 201, a: [null, null, null, null], b: [5, null, null, null] },
      { id: 202, a: [null, null, null, null], b: [null, 5, null, null] },
      { id: 203, a: [null, null, null, null], b: [null, null, 5, null] }
    ],
    available: [1, 2], a: [101, 102, 103], b: [201, 202, 203],
    turns: [['B', 'pick'], ['A', 'pick']], synA: [], synB: [], counter: []
  };
  const eng2 = createDraftEngine(p2);
  const s2 = eng2.initialState();
  assert.equal(eng2.rootValue(s2.av, s2.pa, s2.pb, 0), WIN);
});

test('空池 ban 无手判负', () => {
  const p = {
    rules: [],
    heroes: [
      { id: 101, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 102, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 103, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 104, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 201, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 202, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 203, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 204, a: [null, null, null, null], b: [1, 1, 1, 1] }
    ],
    available: [], a: [101, 102, 103, 104], b: [201, 202, 203, 204],
    turns: [['A', 'ban']], synA: [], synB: [], counter: []
  };
  const eng = createDraftEngine(p);
  const s = eng.initialState();
  assert.equal(eng.legalMoves(s.av, s.pa, s.pb, 0).moves.length, 0);
  assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), LOSS);
});

test('禁掉的角色双方都不可再用', () => {
  const pkg = makeRandomPkg(77);
  const eng = createDraftEngine(pkg);
  let s = eng.initialState();
  const banId = eng.heroes[eng.pool[0]].id;
  s = eng.stepState(s.av, s.pa, s.pb, 0, 0);
  const info = eng.legalMoves(s.av, s.pa, s.pb, 1);
  assert(info.moves.every(m => m.id !== banId));
});

test('平分时最优分配按槽位顺序编号序列取小', () => {
  const p = {
    rules: [],
    heroes: [
      { id: 1, a: [1, 1, null, null], b: [null, null, null, null] },
      { id: 2, a: [1, 1, null, null], b: [null, null, null, null] },
      { id: 3, a: [null, null, 1, 1], b: [null, null, null, null] },
      { id: 4, a: [null, null, 1, 1], b: [null, null, null, null] },
      { id: 201, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 202, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 203, a: [null, null, null, null], b: [1, 1, 1, 1] },
      { id: 204, a: [null, null, null, null], b: [1, 1, 1, 1] }
    ],
    available: [], a: [1, 2, 3, 4], b: [201, 202, 203, 204],
    turns: [['A', 'ban']], synA: [], synB: [], counter: []
  };
  const eng = createDraftEngine(p);
  const gi = id => eng.heroes.findIndex(h => h.id === id);
  const mask = [1, 2, 3, 4].reduce((acc, id) => acc | (1 << gi(id)), 0);
  const r = eng.bestAssign('A', mask);
  assert.equal(r.v, 4);
  assert.deepEqual(Array.from(r.seq.map(g => eng.heroes[g].id)), [1, 2, 3, 4]);
  // 与朴素穷举一致（跨 vm realm，用 JSON 序列化做内容比较）
  const ref = naiveBest(eng.heroes, 'a', new Map(), [1, 2, 3, 4].map(gi));
  assert.equal(JSON.stringify(ref.seq.map(g => eng.heroes[g].id)), JSON.stringify([1, 2, 3, 4]));
});

test('同值首手取编号小者（基准对称形状）', () => {
  const bp = buildBenchmarkPackage();
  const eng = createDraftEngine(bp);
  const s = eng.initialState();
  const res = eng.analyze(s.av, s.pa, s.pb, 0);
  const vals = new Set(res.moves.map(m => m.value));
  assert.equal(vals.size, 1);
  assert.equal(res.moves[0].id, 1);
});

test('克制项按最终槽位双向计入分差', () => {
  // 每名角色只有唯一可占槽，强制分配与槽位编号对齐，克制槽位即可精确预测
  const p = {
    rules: [],
    heroes: [
      { id: 1, a: [10, null, null, null], b: [null, null, null, null] },
      { id: 2, a: [null, 10, null, null], b: [null, null, null, null] },
      { id: 3, a: [null, null, 10, null], b: [null, null, null, null] },
      { id: 4, a: [null, null, null, 10], b: [null, null, null, null] },
      { id: 5, a: [null, null, null, 10], b: [null, null, null, null] },
      { id: 21, a: [null, null, null, null], b: [10, null, null, null] },
      { id: 22, a: [null, null, null, null], b: [null, 10, null, null] },
      { id: 23, a: [null, null, null, null], b: [null, null, 10, null] },
      { id: 24, a: [null, null, null, null], b: [null, null, null, 10] }
    ],
    available: [5], a: [1, 2, 3, 4], b: [21, 22, 23, 24],
    turns: [['A', 'ban']],
    synA: [], synB: [],
    // 甲 1 占槽0、乙 21 占槽0 → 甲对乙 +7；同一对反向乙对甲 +3 → 净 +4
    counter: [[1, 0, 21, 0, 7], [21, 0, 1, 0, 3]]
  };
  const eng = createDraftEngine(p);
  const s = eng.initialState();
  const after = eng.stepState(s.av, s.pa, s.pb, 0, 0);
  assert.equal(eng.terminalDiff(after.av, after.pa, after.pb), 4);
  // 与朴素终局一致
  const ref = naiveSolve(p);
  assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), ref.root.v);
  assert.equal(ref.root.v, NORMAL + 4);
});

test('配合分进入队伍最优总分', () => {
  const p = {
    rules: [],
    heroes: [
      { id: 1, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 2, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 3, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 4, a: [1, 1, 1, 1], b: [null, null, null, null] },
      { id: 21, a: [null, null, null, null], b: [0, 0, 0, 0] },
      { id: 22, a: [null, null, null, null], b: [0, 0, 0, 0] },
      { id: 23, a: [null, null, null, null], b: [0, 0, 0, 0] },
      { id: 24, a: [null, null, null, null], b: [0, 0, 0, 0] }
    ],
    available: [], a: [1, 2, 3, 4], b: [21, 22, 23, 24],
    turns: [['A', 'ban']],
    synA: [[1, 2, 5], [3, 4, -2]], synB: [], counter: []
  };
  const eng = createDraftEngine(p);
  const gi = id => eng.heroes.findIndex(h => h.id === id);
  const maskA = [1, 2, 3, 4].reduce((acc, id) => acc | (1 << gi(id)), 0);
  assert.equal(eng.bestAssign('A', maskA).v, 4 + 5 - 2);
});

test('部分匹配（选入合法性）与满编匹配都和朴素回溯一致', () => {
  const p = makeRandomPkg(123);
  const eng = createDraftEngine(p);
  const N = eng.stats().poolSize;
  // 朴素侧只用宿主 realm 的纯数据（p.heroes 已按 id 排序，与引擎内部一致）
  const plainHeroes = p.heroes.slice().sort((x, y) => x.id - y.id);
  const giPlain = id => plainHeroes.findIndex(h => h.id === id);
  const preGisA = p.a.map(giPlain);
  const preGisB = p.b.map(giPlain);
  const poolGisByBit = eng.pool.map(g => giPlain(eng.heroes[g].id));
  const combos = [];
  for (let m = 0; m < (1 << N); m++) {
    if (popcount(m) === 2) combos.push(m); // 预选2 + 池选2 = 4 人
  }
  for (const cm of combos) {
    const poolGis = bitsOf(cm).map(b => poolGisByBit[b]);
    const gisA = preGisA.concat(poolGis);
    const gisB = preGisB.concat(poolGis);
    const gmA = gisA.reduce((acc, g) => acc | (1 << g), 0);
    const gmB = gisB.reduce((acc, g) => acc | (1 << g), 0);
    // 满编 4 人匹配
    assert.equal(eng.canFill('A', gmA), naiveCanFill(plainHeroes, 'a', gisA));
    assert.equal(eng.canFill('B', gmB), naiveCanFill(plainHeroes, 'b', gisB));
    // 部分匹配（允许空槽）—— 选入合法性的真实语义
    assert.equal(eng.canAssign('A', gmA), naiveCanFillPartial(plainHeroes, 'a', gisA));
    assert.equal(eng.canAssign('B', gmB), naiveCanFillPartial(plainHeroes, 'b', gisB));
    // 仅预选 2 人时：满编必 false，部分匹配可能 true
    const preMaskA = preGisA.reduce((acc, g) => acc | (1 << g), 0);
    assert.equal(eng.canFill('A', preMaskA), false);
    assert.equal(eng.canAssign('A', preMaskA), naiveCanFillPartial(plainHeroes, 'a', preGisA));
  }
});
function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
function bitsOf(m) { const out = []; let b = 0; while (m) { if (m & 1) out.push(b); m >>= 1; b++; } return out; }

console.log('\n4) 基准形状性能与对称性');
test('基准包：16 角色 8 手，全部首手同值且主线程 8 秒内完成', () => {
  const bp = buildBenchmarkPackage();
  const eng = createDraftEngine(bp);
  const s = eng.initialState();
  const t0 = Date.now();
  const res = eng.analyze(s.av, s.pa, s.pb, 0);
  const ms = Date.now() - t0;
  const vals = new Set(res.moves.filter(m => m.legal).map(m => m.value));
  assert.equal(vals.size, 1, '基准形状首手必须全部同值');
  assert(ms <= 8000, '主线程求解应 ≤8s，实际 ' + ms + 'ms');
  console.log('    主线程耗时 ' + ms + 'ms · 记忆状态 ' + res.visited.toLocaleString() +
    ' · memo ' + res.memoSize.toLocaleString() + ' · 值=' + res.moves[0].value);
});

test('基准形状与朴素 minimax 根值一致', () => {
  const bp = buildBenchmarkPackage();
  const eng = createDraftEngine(bp);
  const s = eng.initialState();
  const ref = naiveSolve(bp);
  assert.equal(eng.rootValue(s.av, s.pa, s.pb, 0), ref.root.v);
  assert.equal(ref.root.v, NORMAL, '对称形状分差应为 0');
});

console.log('\n5) 导出/导回与数据校验');
test('导出序列回放后局面逐位一致', () => {
  const eng = createDraftEngine(samplePkg);
  let s = eng.initialState();
  const seq = [];
  for (let t = 0; t < eng.turns.length; t++) {
    const info = eng.legalMoves(s.av, s.pa, s.pb, t);
    const mv = info.moves.find(m => m.legal);
    seq.push({ team: info.turn.team, action: info.turn.action, hero: mv.id });
    s = eng.stepState(s.av, s.pa, s.pb, t, mv.bit);
  }
  const eng2 = createDraftEngine(samplePkg);
  let s2 = eng2.initialState();
  for (const mv of seq) {
    const info = eng2.legalMoves(s2.av, s2.pa, s2.pb, s2.t);
    const match = info.moves.find(x => x.legal && x.id === mv.hero &&
      info.turn.team === mv.team && info.turn.action === mv.action);
    assert(match);
    s2 = eng2.stepState(s2.av, s2.pa, s2.pb, s2.t, match.bit);
  }
  assert.equal(s2.av, s.av);
  assert.equal(s2.pa, s.pa);
  assert.equal(s2.pb, s.pb);
  assert.equal(s2.t, s.t);
});

test('非法数据包被拒绝', () => {
  assert.throws(() => createDraftEngine({ heroes: [], available: [], a: [], b: [], turns: [['A', 'pick']] }));
  assert.throws(() => createDraftEngine({ ...samplePkg, available: [1, 2, 1] }));
  assert.throws(() => createDraftEngine({ ...samplePkg, turns: [['X', 'pick']] }));
  const tooMany = JSON.parse(JSON.stringify(samplePkg));
  tooMany.available = Array.from({ length: 17 }, (_, i) => i + 1);
  assert.throws(() => createDraftEngine(tooMany));
  const badCount = JSON.parse(JSON.stringify(samplePkg));
  badCount.turns = [['A', 'pick'], ['A', 'pick']];
  assert.throws(() => createDraftEngine(badCount), '选后人数超 4 应拒绝');
});

test('预选本身不可匹配时拒绝建包', () => {
  const p = JSON.parse(JSON.stringify(samplePkg));
  p.heroes.find(h => h.id === 11).a = [null, null, null, null]; // 11 无任何可占槽
  assert.throws(() => createDraftEngine(p));
});

console.log('\n' + (failed ? failed + ' 项失败，' + passed + ' 项通过' : '全部 ' + passed + ' 项通过'));
