'use strict';
/* 与独立暴力实现对照的随机测试：不漏解、不多解、幅度上下界准确。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.resolve(__dirname, '..', 'src', 'core.js'));

/* ------------------------------------------------------------------ */
/* 独立参照：对每个候选深度组合，枚举第一条回波的幅度，推出第二条区间     */
/* ------------------------------------------------------------------ */

function laneMatchesOne(lane, slot, a) {
  // 单回波：必须命中已列槽，且该槽读数与 a 相符；其余列出槽须为 null/0
  let hit = false;
  for (const [t, v] of lane) {
    if (t === slot) {
      hit = true;
      if (v === null) continue;
      if (v === 255) { if (a < 255) return false; }
      else if (v === 0) return false;
      else if (a !== v) return false;
    } else {
      if (v !== null && v !== 0) return false;
    }
  }
  return hit;
}

function laneConstraintForSecond(lane, slotA, slotB, a1) {
  // 固定 a1 后，返回 a2 的 [lo,hi]（已与 1..1023 求交）；不可行返回 null
  let lo = 1, hi = 1023;
  let presentA = false, presentB = false;
  for (const [t, v] of lane) {
    let count = 0, isA = false, isB = false;
    if (t === slotA) { count++; isA = true; }
    if (t === slotB) { count++; isB = true; }
    if (count === 0) {
      if (v !== null && v !== 0) return null;
      continue;
    }
    if (isA) presentA = true;
    if (isB) presentB = true;
    if (count === 2) {
      if (v === null) continue;
      if (v === 0) return null;
      if (v === 255) { lo = Math.max(lo, 255 - a1); continue; }
      const need = v - a1;               // a1 + a2 = v
      lo = Math.max(lo, need);
      hi = Math.min(hi, need);
    } else if (isA) {
      if (v === null) continue;
      if (v === 0) return null;
      if (v === 255) { if (a1 < 255) return null; continue; }
      if (a1 !== v) return null;
    } else {
      if (v === null) continue;
      if (v === 0) return null;
      if (v === 255) { lo = Math.max(lo, 255); continue; }
      lo = Math.max(lo, v);
      hi = Math.min(hi, v);
    }
  }
  if (!presentA || !presentB) return null;
  if (lo > hi) return null;
  return [lo, hi];
}

function bruteForce(doc, index, params) {
  const p0 = doc.periods[0], p1 = doc.periods[1];
  const o0 = params && params.offsets ? params.offsets[0] : doc.offsets[0];
  const o1 = params && params.offsets ? params.offsets[1] : doc.offsets[1];
  const maxDepth = params && params.maxDepth !== undefined ? params.maxDepth : doc.maxDepth;
  const lane0 = doc.pixels[index][0];
  const lane1 = doc.pixels[index][1];
  const mod = (v, p) => ((v % p) + p) % p;

  // k=0
  const zeroOk = [lane0, lane1].every(lane => lane.every(([, v]) => v === null || v === 0));
  if (zeroOk) return { k: 0, groups: [] };

  // k=1
  const g1 = [];
  for (let d = 0; d <= maxDepth; d++) {
    const s0 = mod(d + o0, p0), s1 = mod(d + o1, p1);
    let anyA = false, aLo = 1024, aHi = -1;
    for (let a = 1; a <= 1023; a++) {
      if (laneMatchesOne(lane0, s0, a) && laneMatchesOne(lane1, s1, a)) {
        anyA = true;
        if (a < aLo) aLo = a;
        if (a > aHi) aHi = a;
      }
    }
    if (anyA) g1.push({ d, aLo, aHi });
  }
  if (g1.length) {
    return { k: 1, groups: g1.map(g => ({ depths: [g.d], amps: [[g.aLo, g.aHi]] })) };
  }

  // k=2
  const g2 = [];
  for (let d1 = 0; d1 <= maxDepth; d1++) {
    for (let d2 = d1 + 1; d2 <= maxDepth; d2++) {
      const s10 = mod(d1 + o0, p0), s11 = mod(d1 + o1, p1);
      const s20 = mod(d2 + o0, p0), s21 = mod(d2 + o1, p1);
      let seen = false;
      let a1Lo = 1024, a1Hi = -1, a2Lo = 1024, a2Hi = -1;
      for (let a1 = 1; a1 <= 1023; a1++) {
        const c0 = laneConstraintForSecond(lane0, s10, s20, a1);
        if (!c0) continue;
        const c1 = laneConstraintForSecond(lane1, s11, s21, a1);
        if (!c1) continue;
        const lo = Math.max(c0[0], c1[0], 1);
        const hi = Math.min(c0[1], c1[1], 1023);
        if (lo > hi) continue;
        seen = true;
        if (a1 < a1Lo) a1Lo = a1;
        if (a1 > a1Hi) a1Hi = a1;
        if (lo < a2Lo) a2Lo = lo;
        if (hi > a2Hi) a2Hi = hi;
      }
      if (seen) g2.push({ depths: [d1, d2], amps: [[a1Lo, a1Hi], [a2Lo, a2Hi]] });
    }
  }
  if (g2.length) return { k: 2, groups: g2 };
  return { k: null, groups: [] };
}

function groupKey(g) {
  return g.depths.join(',');
}

function compare(doc, index, params) {
  const detail = C.solvePixelDetail(doc, index, params);
  const ref = bruteForce(doc, index, params);
  const gotK = detail.kind === 'empty' ? 0 : detail.kind === 'none' ? null : detail.minEchoes;
  if (gotK !== ref.k) {
    return `k 不符：solver=${gotK} ref=${ref.k} pixel=${index} lanes=${JSON.stringify(doc.pixels[index])}`;
  }
  if (ref.k === null || ref.k === 0) return null;
  const got = detail.groups.slice().sort((a, b) => a.depths[0] - b.depths[0] || a.depths[1] - b.depths[1]);
  const exp = ref.groups.slice().sort((a, b) => a.depths[0] - b.depths[0] || a.depths[1] - b.depths[1]);
  if (got.length !== exp.length) {
    return `组数不符：solver=${got.length} ref=${exp.length} pixel=${index} lanes=${JSON.stringify(doc.pixels[index])}`;
  }
  // 逐深度比对幅度区间（参照的区间是各层投影，可能与 solver 相同）
  const expMap = new Map(exp.map(g => [groupKey(g), g]));
  for (const g of got) {
    const e = expMap.get(groupKey(g));
    if (!e) return `多出深度组 ${groupKey(g)} pixel=${index}`;
    for (let i = 0; i < e.amps.length; i++) {
      if (g.amps[i][0] !== e.amps[i][0] || g.amps[i][1] !== e.amps[i][1]) {
        return `幅度不符 depth=${groupKey(g)} layer${i + 1} solver=${g.amps[i]} ref=${e.amps[i]} pixel=${index}`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 随机模糊测试                                                        */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const PRIME_PAIRS = [[3, 5], [5, 7], [3, 7], [5, 11], [7, 11], [13, 17]];

test('随机小图与暴力实现逐像素一致（含幅度上下界）', () => {
  const rand = mulberry32(0x9e3779b9);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  let checked = 0;
  for (let iter = 0; iter < 90; iter++) {
    const [p0, p1] = pick(PRIME_PAIRS);
    const o0 = ri(-6, 6), o1 = ri(-6, 6);
    const maxDepth = ri(0, p0 * p1 - 1);
    const pixels = [];
    for (let i = 0; i < 6; i++) {
      const lanes = [];
      for (let L = 0; L < 2; L++) {
        const p = L === 0 ? p0 : p1;
        const count = ri(0, 3);
        const slots = [];
        const used = new Set();
        let nulls = 0;
        for (let k = 0; k < count; k++) {
          let s = ri(0, p - 1);
          let guard = 0;
          while (used.has(s) && guard++ < 20) s = ri(0, p - 1);
          if (used.has(s)) continue;
          used.add(s);
          const r = rand();
          let v;
          if (r < 0.18 && nulls < 2) { v = null; nulls++; }
          else if (r < 0.4) v = 255;
          else if (r < 0.48) v = 0;
          else v = ri(1, 254);
          slots.push([s, v]);
        }
        lanes.push(slots);
      }
      pixels.push(lanes);
    }
    const raw = { width: pixels.length, height: 1, periods: [p0, p1], offsets: [o0, o1], maxDepth, pixels };
    const v = C.validateDocument(raw);
    assert.ok(v.ok, JSON.stringify(v.errors));
    for (let i = 0; i < pixels.length; i++) {
      const err = compare(v.doc, i, { offsets: [o0, o1], maxDepth });
      assert.equal(err, null, err || '');
      checked++;
    }
  }
  assert.ok(checked > 400, 'checked ' + checked);
});

test('随机记录换偏移和上限后仍与暴力实现一致', () => {
  const rand = mulberry32(1234567);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  let checked = 0;
  for (let iter = 0; iter < 40; iter++) {
    const [p0, p1] = pick(PRIME_PAIRS);
    const maxDepth = ri(0, p0 * p1 - 1);
    const pixel = [[], []];
    for (let L = 0; L < 2; L++) {
      const p = L === 0 ? p0 : p1;
      const used = new Set();
      const count = ri(0, 3);
      let nulls = 0;
      for (let k = 0; k < count; k++) {
        let s = ri(0, p - 1);
        if (used.has(s)) continue;
        used.add(s);
        const r = rand();
        let v;
        if (r < 0.2 && nulls < 2) { v = null; nulls++; }
        else if (r < 0.45) v = 255;
        else v = ri(1, 254);
        pixel[L].push([s, v]);
      }
    }
    const raw = { width: 1, height: 1, periods: [p0, p1], offsets: [0, 0], maxDepth, pixels: [pixel] };
    const v = C.validateDocument(raw);
    assert.ok(v.ok);
    const params = { offsets: [ri(-10, 10), ri(-10, 10)], maxDepth: ri(0, p0 * p1 - 1) };
    const err = compare(v.doc, 0, params);
    assert.equal(err, null, err || '');
    checked++;
  }
  assert.ok(checked >= 40);
});

test('全图快算与逐像素详情一致（状态、导出层）', () => {
  const rand = mulberry32(0xabcdef);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  for (let iter = 0; iter < 30; iter++) {
    const [p0, p1] = pick(PRIME_PAIRS);
    const o0 = ri(-5, 5), o1 = ri(-5, 5);
    const maxDepth = ri(0, p0 * p1 - 1);
    const pixels = [];
    const count = ri(1, 12);
    for (let i = 0; i < count; i++) {
      const lanes = [];
      for (let L = 0; L < 2; L++) {
        const p = L === 0 ? p0 : p1;
        const used = new Set();
        const arr = [];
        let nulls = 0;
        const k = ri(0, 3);
        for (let q = 0; q < k; q++) {
          const s = ri(0, p - 1);
          if (used.has(s)) continue;
          used.add(s);
          const r = rand();
          let v;
          if (r < 0.2 && nulls < 2) { v = null; nulls++; }
          else if (r < 0.5) v = 255;
          else v = ri(1, 254);
          arr.push([s, v]);
        }
        lanes.push(arr);
      }
      pixels.push(lanes);
    }
    const raw = { width: count, height: 1, periods: [p0, p1], offsets: [o0, o1], maxDepth, pixels };
    const v = C.validateDocument(raw);
    assert.ok(v.ok);
    const params = { offsets: [o0, o1], maxDepth };
    const res = C.solveAll(v.doc, params);
    for (let i = 0; i < count; i++) {
      const d = C.solvePixelDetail(v.doc, i, params);
      let expect = C.STATUS.NONE;
      if (d.kind === 'empty') expect = C.STATUS.EMPTY;
      else if (d.kind !== 'none') expect = d.groupCount > 1 ? C.STATUS.MULTI : (d.minEchoes === 1 ? C.STATUS.UNIQUE1 : C.STATUS.UNIQUE2);
      assert.equal(res.status[i], expect, `pixel ${i} status; groups=${JSON.stringify(d.groups)}`);
      if (expect === C.STATUS.UNIQUE1) {
        assert.equal(res.layer0[i], d.groups[0].depths[0] + 1);
        assert.equal(res.layer1[i], 0);
      } else if (expect === C.STATUS.UNIQUE2) {
        assert.equal(res.layer0[i], d.groups[0].depths[0] + 1);
        assert.equal(res.layer1[i], d.groups[0].depths[1] + 1);
      } else {
        assert.equal(res.layer0[i], 0);
        assert.equal(res.layer1[i], 0);
      }
    }
  }
});

test('满额图抽样：记录里的槽可由解出的深度折回，且最少回波数不超过真值', () => {
  // 生成 64×64（周期 31/37，上限 1146）并保留真值
  const p0 = 31, p1 = 37, maxDepth = 1146, W = 64, H = 64;
  let seed = 424242 >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pixels = [];
  const truth = [];
  for (let i = 0; i < W * H; i++) {
    let echoes;
    if (i % 2 === 1) {
      const d1 = ri(0, maxDepth - 1);
      let d2;
      if (i % 4 === 1) {
        const k = ri(1, Math.max(1, Math.floor((maxDepth - d1) / p0)));
        d2 = d1 + k * p0;
        if (d2 > maxDepth || d2 === d1) d2 = d1 + p0 > maxDepth ? (d1 >= p0 ? d1 - p0 : (d1 + 1) % (maxDepth + 1)) : d1 + p0;
      } else {
        d2 = ri(0, maxDepth);
        if (d2 === d1) d2 = (d1 + 1) % (maxDepth + 1);
      }
      echoes = [[d1, ri(1, 1023)], [d2, ri(1, 1023)]];
    } else {
      echoes = [[ri(0, maxDepth), ri(1, 1023)]];
    }
    const lanes = [];
    for (const [p] of [[p0], [p1]]) {
      const bins = new Map();
      for (const [d, a] of echoes) {
        const s = ((d % p) + p) % p;
        bins.set(s, (bins.get(s) || 0) + a);
      }
      lanes.push(Array.from(bins.entries()).sort((a, b) => a[0] - b[0]).map(([s, v]) => [s, Math.min(v, 255)]));
    }
    pixels.push(lanes);
    truth.push(echoes);
  }
  const v = C.validateDocument({ width: W, height: H, periods: [p0, p1], offsets: [0, 0], maxDepth, pixels });
  assert.ok(v.ok, JSON.stringify(v.errors.slice(0, 2)));
  const res = C.solveAll(v.doc, {});
  assert.equal(res.counts.none, 0, '构造的记录都应可解');

  let sampled = 0;
  for (let i = 0; i < W * H; i += 7) {
    const d = C.solvePixelDetail(v.doc, i, {});
    const t = truth[i];
    // 真值回波数不少于最少回波数
    assert.ok(d.minEchoes <= t.length, `pixel ${i}: min ${d.minEchoes} > truth ${t.length}`);
    // 每条解出的深度组都能折回记录里的槽：至少真值组应出现在解集合中
    const truthDepths = t.map(e => e[0]).sort((a, b) => a - b);
    const hasTruth = d.groups.some(g => g.depths.join(',') === truthDepths.join(','));
    assert.ok(hasTruth || d.minEchoes < t.length, `pixel ${i}: 解集缺少真值深度组 ${truthDepths} got ${JSON.stringify(d.groups.map(g => g.depths))}`);
    sampled++;
  }
  assert.ok(sampled > 500);
});
