'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../solver.js');

/* ---------------- 穷举参考实现（BigInt 精确） ---------------- */

function* cartesian(arrays, i, prefix) {
  i = i || 0;
  prefix = prefix || [];
  if (i === arrays.length) {
    yield prefix.slice();
    return;
  }
  for (const v of arrays[i]) {
    prefix.push(v);
    yield* cartesian(arrays, i + 1, prefix);
    prefix.pop();
  }
}

function bruteSolve(proj, anchorMap) {
  const n = proj.marks.length;
  const Z0 = proj.marks.map((m) => S.candidateZs(m));
  const anc = anchorMap || proj.anchors || {};
  const locked = new Map(Object.entries(anc).map(([k, v]) => [Number(k), v]));
  const lists = Z0.map((zs, i) => (locked.has(i) ? [locked.get(i)] : zs));
  const xs = proj.marks.map((m) => m[0]);
  const dx = xs.slice(1).map((x, i) => x - xs[i]);
  const [a, b] = proj.rate_min;
  const [c, d] = proj.rate_max;

  let best = null;
  for (const z of cartesian(lists)) {
    let ok = true;
    for (let i = 0; i < n - 1; i++) {
      const dz = z[i + 1] - z[i];
      if (!(BigInt(a) * BigInt(dx[i]) <= BigInt(b) * BigInt(dz))) { ok = false; break; }
      if (!(BigInt(d) * BigInt(dz) <= BigInt(c) * BigInt(dx[i]))) { ok = false; break; }
    }
    if (!ok) continue;
    let cost = 0n;
    for (let i = 0; i < n - 2; i++) {
      const dz1 = z[i + 1] - z[i];
      const dz2 = z[i + 2] - z[i + 1];
      let t = BigInt(dz1) * BigInt(dx[i + 1]) - BigInt(dz2) * BigInt(dx[i]);
      if (t < 0n) t = -t;
      cost += t;
    }
    if (best === null || cost < best.cost || (cost === best.cost && lexLess(z, best.z))) {
      best = { cost, z: z.slice() };
    }
  }
  return best;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// 独立的“前缀是否存在”穷举，求第一个无法延续的读数
function bruteFirstBad(proj, anchorMap) {
  const n = proj.marks.length;
  const Z0 = proj.marks.map((m) => S.candidateZs(m));
  const anc = anchorMap || proj.anchors || {};
  const locked = new Map(Object.entries(anc).map(([k, v]) => [Number(k), v]));
  const xs = proj.marks.map((m) => m[0]);
  const [a, b] = proj.rate_min;
  const [c, d] = proj.rate_max;

  function edgeOk(zi, zj, dxi) {
    const dz = zj - zi;
    return BigInt(a) * BigInt(dxi) <= BigInt(b) * BigInt(dz) &&
      BigInt(d) * BigInt(dz) <= BigInt(c) * BigInt(dxi);
  }

  let reach = new Set(locked.has(0) ? [locked.get(0)] : Z0[0]);
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[i - 1];
    const allowed = locked.has(i) ? [locked.get(i)] : Z0[i];
    const next = new Set();
    for (const z of allowed) {
      for (const pz of reach) if (edgeOk(pz, z, dx)) { next.add(z); break; }
    }
    if (next.size === 0) return i;
    reach = next;
  }
  return -1;
}

/* ---------------- 随机用例生成 ---------------- */

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 构造一条满足 [rmin,rmax] 的真路径，并在其周围放 ≤span 个 k 候选
function randomProject(rng, n, opts) {
  opts = opts || {};
  const rmin = opts.rmin || [4, 1];
  const rmax = opts.rmax || [7, 1];
  const maxX = opts.maxX || 200;
  const marks = [];
  const trueZ = [];
  let x = 0;
  let z = Math.floor(rng() * 500);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = 5 + Math.floor(rng() * (maxX - 5));
      x += dx;
      const lo = rmin[0] / rmin[1], hi = rmax[0] / rmax[1];
      const slope = lo + rng() * (hi - lo);
      z += Math.max(1, Math.round(slope * dx));
    }
    trueZ.push(z);
    const p = ((z % 256) + 256) % 256;
    const k = Math.floor(z / 256);
    const span = opts.span != null ? opts.span : 3;
    const klo = Math.max(0, k - Math.floor(rng() * span));
    let khi = Math.min(S.MAX_K, k + Math.floor(rng() * span));
    if (khi < klo) khi = klo;
    if (khi - klo + 1 > 16) khi = klo + 15;
    marks.push([x, p, klo, khi]);
  }
  // 约定：首尾锁定到真路径展开相位（必在候选中）
  const anchors = { 0: trueZ[0] };
  if (opts.lockEnds !== false) anchors[n - 1] = trueZ[n - 1];
  return { project: { rate_min: rmin, rate_max: rmax, marks, anchors }, trueZ };
}

function solveWithAnchors(proj, anchorObj) {
  const prep = S.prepare(proj);
  const r = S.resolveAnchors(prep, anchorObj);
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  return { prep, res: S.solvePrepared(prep, r.anchorIdx) };
}

/* ---------------- 测试 ---------------- */

test('样例包：最优路径/代价/输出帧数与 Python 预言机一致', () => {
  const proj = {
    wav: 'tape.wav', rate_min: [4, 1], rate_max: [7, 1],
    marks: [[0, 0, 0, 0], [400, 72, 7, 9], [840, 118, 16, 18], [1200, 0, 25, 25]],
    anchors: { 0: 0, 3: 6400 }
  };
  const res = S.solveProject(proj);
  assert.equal(res.ok, true);
  assert.deepEqual(res.z, [0, 2120, 4470, 6400]);
  assert.equal(res.costText, '10400');
  assert.equal(S.outputFrameCount(res.z), 1200);
  assert.deepEqual(S.yNumerators(res.z), [0, 6360, 13410, 19200]);
});

test('小规模随机用例：DP 与穷举的最优代价+字典序完全一致（含随机锚点）', () => {
  const rng = mulberry32(20261127);
  let cases = 0;
  for (let iter = 0; iter < 400; iter++) {
    const n = 2 + Math.floor(rng() * 5); // 2..6
    const proj = randomProject(rng, n, { span: 3 + Math.floor(rng() * 4) }).project;
    // 随机加 0..2 个中间锚点（取真候选集合中的随机值，可能造成无解）
    const anchorObj = Object.assign({}, proj.anchors);
    const extra = Math.floor(rng() * 3);
    for (let a = 0; a < extra; a++) {
      const i = 1 + Math.floor(rng() * (n - 2));
      if (i >= 1 && i <= n - 2) {
        const zs = S.candidateZs(proj.marks[i]);
        anchorObj[i] = zs[Math.floor(rng() * zs.length)];
      }
    }
    const bf = bruteSolve(proj, anchorObj);
    const bfBad = bruteFirstBad(proj, anchorObj);
    const { prep, res } = solveWithAnchors(proj, anchorObj);
    const bad = S.firstBadReading(prep, (() => {
      const rr = S.resolveAnchors(prep, anchorObj);
      return rr.anchorIdx;
    })());

    assert.equal(bad, bfBad, `firstBad mismatch iter=${iter} n=${n}`);
    if (bf === null) {
      assert.equal(res.ok, false);
      assert.equal(res.firstBad, bfBad);
      assert.ok(bfBad >= 0);
    } else {
      assert.equal(res.ok, true);
      assert.deepEqual(res.z, bf.z, `z mismatch iter=${iter}: ${JSON.stringify(proj.marks)} anchors=${JSON.stringify(anchorObj)}`);
      assert.equal(res.cost.toString(), bf.cost.toString());
      cases++;
    }
  }
  assert.ok(cases > 50, '应当有相当数量的可行用例，实际 ' + cases);
});

test('字典序平局：构造同代价多解时选 z 序列最小', () => {
  // 等距 x、对称候选容易产生平局；用穷举确认 DP 选择
  const rng = mulberry32(424242);
  for (let iter = 0; iter < 120; iter++) {
    const n = 3 + Math.floor(rng() * 4);
    const proj = randomProject(rng, n, { span: 6 }).project;
    const bf = bruteSolve(proj, proj.anchors);
    if (!bf) continue;
    const res = S.solveProject(proj);
    assert.deepEqual(res.z, bf.z);
    assert.equal(res.costText, bf.cost.toString());
  }
});

test('字典序平局：显式构造两条 0 代价等斜率路径时选较小 z 序列', () => {
  const proj = {
    rate_min: [1, 1], rate_max: [200, 1],
    marks: [[0, 0, 0, 0], [10, 232, 3, 4], [20, 208, 7, 9]],
    anchors: { 0: 0 }
  };
  const r = S.solveProject(proj);
  assert.equal(r.ok, true);
  assert.equal(r.costText, '0');
  assert.deepEqual(r.z, [0, 1000, 2000]); // 而非另一条 [0,1256,2512]
});

test('极端整数：触发 BigInt 安全模式仍与 BigInt 穷举一致', () => {
  // 让 dz0 与 dx1 都接近各自上限，单项乘积 > 2^53，强制 BigInt 模式
  function markFromZ(x, z, wiggle) {
    const p = ((z % 256) + 256) % 256;
    const k = Math.floor((z - p) / 256);
    return [x, p, Math.max(0, k - wiggle), Math.min(S.MAX_K, k + wiggle)];
  }
  const z1 = 2300000000;
  const z2 = 2305000000;
  const z3 = 2550000000;
  const proj = {
    rate_min: [1, 1], rate_max: [4000000000, 1],
    marks: [
      markFromZ(0, 0, 0),
      markFromZ(100, z1, 2),
      markFromZ(4400000, z2, 2),
      markFromZ(8000000, z3, 1)
    ],
    anchors: { 0: 0, 3: z3 }
  };
  const prep = S.prepare(proj);
  assert.equal(prep.numberSafe, false, '该用例必须进入 BigInt 模式；costBound=' + prep.costBound);
  const bf = bruteSolve(proj, proj.anchors);
  assert.ok(bf, '穷举应存在解');
  const res = S.solveProject(proj);
  assert.equal(res.ok, true);
  assert.deepEqual(res.z, bf.z);
  assert.equal(res.costText, bf.cost.toString());
});

test('非法锚点 z（不在候选中）被拒绝并给出错误', () => {
  const proj = randomProject(mulberry32(7), 5).project;
  const prep = S.prepare(proj);
  const r = S.resolveAnchors(prep, { 2: 123456789 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /不在其整圈候选/);
});

test('确定性：同一问题两次求解结果完全相同', () => {
  const proj = randomProject(mulberry32(99), 30, { span: 8 }).project;
  const a = S.solveProject(proj);
  const b = S.solveProject(proj);
  assert.deepEqual(a.z, b.z);
  assert.equal(a.costText, b.costText);
});

/* ---------------- 性能：满额 20000 读数 + 一次锚点 ---------------- */

function makeFullCase(seed, opts) {
  opts = opts || {};
  const rng = mulberry32(seed);
  const n = 20000;
  const N = 48000 * 90; // 90 秒
  // 用随机正权重把 N 帧分配成 n-1 个严格正 dx
  const weights = [];
  let wsum = 0;
  for (let i = 0; i < n - 1; i++) {
    const w = 0.5 + rng();
    weights.push(w);
    wsum += w;
  }
  const dx = weights.map((w) => Math.max(1, Math.floor((w / wsum) * N)));
  let dsum = dx.reduce((a, b) => a + b, 0);
  dx[n - 2] += N - dsum; // 舍入误差补到最后一段（仍为正）
  const xs = [0];
  for (let i = 0; i < n - 1; i++) xs.push(xs[i] + dx[i]);
  xs[n - 1] = N;

  const marks = [];
  let z = 0;
  const trueZ = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dxi = xs[i] - xs[i - 1];
      const slope = 4.2 + rng() * 2.6; // 4.2..6.8 落在 [4,7]
      z += Math.max(4, Math.round(slope * dxi));
    }
    trueZ.push(z);
    const p = ((z % 256) + 256) % 256;
    const k = Math.floor(z / 256);
    const radius = opts.fullCandidates ? 8 : 3 + Math.floor(rng() * 4);
    let klo = Math.max(0, k - radius);
    let khi = Math.min(S.MAX_K, k + radius);
    if (khi - klo + 1 > 16) klo = khi - 15;
    marks.push([xs[i], p, klo, khi]);
  }
  const anchors = { 0: trueZ[0], [n - 1]: trueZ[n - 1] };
  return { project: { rate_min: [4, 1], rate_max: [7, 1], marks, anchors }, trueZ };
}

test('性能：20000 读数预处理+求解，再加一个锚点重解，总重解 < 10s', () => {
  const { project } = makeFullCase(1234, { fullCandidates: true });
  let t = process.hrtime.bigint();
  const prep = S.prepare(project);
  const r0 = S.resolveAnchors(prep, project.anchors);
  const first = S.solvePrepared(prep, r0.anchorIdx);
  let prepMs = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(first.ok, true, '满额样例应当可解');
  assert.equal(first.z.length, 20000);

  // 加一个中间锚点（取 DP 已选值，必然可行）
  const mid = 10000;
  const anchors2 = Object.assign({}, project.anchors);
  anchors2[mid] = first.z[mid];
  t = process.hrtime.bigint();
  const r2 = S.resolveAnchors(prep, anchors2);
  const second = S.solvePrepared(prep, r2.anchorIdx);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(second.ok, true);
  assert.equal(second.z[mid], first.z[mid]);
  console.log(`  [perf] prepare+solve=${prepMs.toFixed(0)}ms, 加锚重解=${ms.toFixed(0)}ms, numberSafe=${prep.numberSafe}`);
  assert.ok(ms < 10000, '加锚后重解应在 10s 内，实际 ' + ms + 'ms');
});

test('性能：满额读数加错误锚点时 10s 内给出无解位置', () => {
  const { project } = makeFullCase(555);
  const prep = S.prepare(project);
  const base = S.solveProject(project);
  assert.ok(base.ok);

  // 在若干中间读数里搜索一个确实导致不可延续的候选锚点
  let badChoice = null;
  for (const mid of [12345, 8000, 15000, 6000, 18000, 4000, 16000]) {
    const zs = prep.Z[mid];
    for (let ci = 0; ci < zs.length; ci++) {
      if (ci === base.zIndices[mid]) continue;
      const anchors = Object.assign({}, project.anchors, { [mid]: zs[ci] });
      const r = S.resolveAnchors(prep, anchors);
      const ai = r.anchorIdx;
      const fb = S.firstBadReading(prep, ai);
      if (fb >= 0) { badChoice = { mid, z: zs[ci], fb, anchors }; break; }
    }
    if (badChoice) break;
  }
  assert.ok(badChoice, '应当能找到一个导致无解的候选锚点');

  const t = process.hrtime.bigint();
  const r2 = S.resolveAnchors(prep, badChoice.anchors);
  const res = S.solvePrepared(prep, r2.anchorIdx);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res.ok, false);
  assert.equal(res.firstBad, badChoice.fb);
  assert.ok(res.firstBad >= 0 && res.firstBad <= 19999);
  console.log(`  [perf] 坏锚(#${badChoice.mid})无解定位=#${res.firstBad} 耗时=${ms.toFixed(0)}ms`);
  assert.ok(ms < 10000);
});
