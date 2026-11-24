/*
 * 独立参考求积器（仅测试使用，页面不加载）。
 * ---------------------------------------------------------------------------
 * 与 engine.js 的“碎片相减”完全不同的思路，用来交叉验证面积：
 *
 *   · 所有输入坐标先精确转成有理数（BigInt 分数），全程有理运算；
 *   · 孔径、光阑、每个覆盖三角形都用半平面组 A·p ≤ B 表示；
 *   · 收集所有边界直线的两两交点 x，把平面切成竖条；竖条内各区域的截面
 *     端点是 x 的线性函数、组合结构不变；
 *   · 竖条中点处求各区域的竖直截面区间，按 (depth, id) 升序做区间并，
 *     面积 = 中点截面长度 × 条带宽度。
 *
 * 结果只在最后转 double，可作为 1e-9 量级的对照。刻意不 import engine.js。
 */
'use strict';

// ---------------------------------------------------------------------------
// 有理数（BigInt 分数，既约、分母为正）
// ---------------------------------------------------------------------------
function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1n;
}

function R(n, d) {
  if (typeof n === 'number') n = BigInt(n);
  d = typeof d === 'bigint' ? d : BigInt(d === undefined ? 1 : d);
  if (d === 0n) throw new Error('R: division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const R0 = R(0), R1 = R(1);
const add = (a, b) => R(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => R(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => R(a.n * b.n, a.d * b.d);
const div = (a, b) => R(a.n * b.d, a.d * b.n);
const neg = a => R(-a.n, a.d);
const cmp = (a, b) => {
  const l = a.n * b.d, r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
const eq = (a, b) => cmp(a, b) === 0;
const half = a => div(a, R(2));
const toNum = a => ratioToFloat(a.n, a.d);

// BigInt 分数转 double：先按位长缩放到约 60 位商，避免超大数转 Infinity 后相除得 NaN。
function ratioToFloat(n, d) {
  if (n === 0n) return 0;
  const negv = (n < 0n) !== (d < 0n);
  if (n < 0n) n = -n;
  if (d < 0n) d = -d;
  const nb = n.toString(2).length, db = d.toString(2).length;
  const k = 60 - (nb - db);
  let q;
  if (k >= 0) q = (n << BigInt(k)) / d;
  else q = n / (d << BigInt(-k));
  const v = Number(q) * Math.pow(2, -k);
  return negv ? -v : v;
}
const isZero = a => a.n === 0n;

// 有限 double → 精确有理数。
function fromFloat(x) {
  if (!Number.isFinite(x)) throw new Error('fromFloat: non-finite');
  if (Number.isInteger(x)) return R(BigInt(x));
  // 用 IEEE-754 位精确拆解：x = sign · m · 2^e2。
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const sign = (bits >> 63n) & 1n ? -1n : 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  let m = exp === 0 ? frac : (frac | (1n << 52n));
  let e2 = exp === 0 ? -1074 : exp - 1075;
  m *= sign;
  if (e2 >= 0) return R(m << BigInt(e2));
  return R(m, 1n << BigInt(-e2));
}

// ---------------------------------------------------------------------------
// 场景展开：半平面组
// ---------------------------------------------------------------------------
// 半平面 {A:[Ax,Ay], B}，表示 A·p ≤ B。
function hp(Ax, Ay, B) { return { Ax, Ay, B }; }

function chordHalfplanes(polyCCW) {
  // 凸多边形（CCW）各边的内侧半平面。
  const out = [];
  const n = polyCCW.length;
  for (let i = 0; i < n; i++) {
    const a = polyCCW[i], b = polyCCW[(i + 1) % n];
    const ex = sub(b[0], a[0]), ey = sub(b[1], a[1]);
    // cross(e, p − a) ≥ 0  →  (ey, −ex)·p ≤ ey·ax − ex·ay
    out.push(hp(ey, neg(ex), sub(mul(ey, a[0]), mul(ex, a[1]))));
  }
  return out;
}

// 竖直截面区间：返回 {lo, hi} 或 null。要求 x 不是任何竖直边界/交点。
function intervalAt(hps, x) {
  let lo = null, hi = null;
  for (let i = 0; i < hps.length; i++) {
    const { Ax, Ay, B } = hps[i];
    const rem = sub(B, mul(Ax, x)); // Ay·y ≤ rem
    if (isZero(Ay)) {
      if (cmp(R0, rem) > 0) return null; // 0 ≤ rem 不成立
      continue;
    }
    const y = div(rem, Ay);
    if (cmp(Ay, R0) > 0) {
      if (hi === null || cmp(y, hi) < 0) hi = y;
    } else {
      if (lo === null || cmp(y, lo) > 0) lo = y;
    }
  }
  if (lo === null || hi === null) return null;
  if (cmp(lo, hi) >= 0) return null;
  return { lo, hi };
}

function lineIntersect(l1, l2) {
  const det = sub(mul(l1.Ax, l2.Ay), mul(l1.Ay, l2.Ax));
  if (isZero(det)) return null;
  return {
    x: div(sub(mul(l1.B, l2.Ay), mul(l2.B, l1.Ay)), det),
    y: div(sub(mul(l1.Ax, l2.B), mul(l2.Ax, l1.B)), det),
  };
}

// 区域面积：竖条扫掠。region：半平面组；covers：[{id, hp:半平面组}]，已按
// (depth, id) 升序。
function sweep(regionHP, covers) {
  const triAreas = new Map();

  // 所有直线：区域边 + 各覆盖片边。
  const lines = regionHP.slice();
  for (const c of covers) for (const l of c.hp) lines.push(l);

  // 收集竖条边界 x：所有直线两两交点。
  const xs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lineIntersect(lines[i], lines[j]);
      if (p) xs.push(p.x);
    }
  }
  // 竖条边界只取直线交点即可：域是这些半平面的交，其 x 范围端点必落在某个
  // 交点上（孔径与光阑的边界都已在 regionHP 中）。
  xs.sort(cmp);
  const uniq = [];
  for (const x of xs) if (uniq.length === 0 || !eq(uniq[uniq.length - 1], x)) uniq.push(x);

  if (uniq.length < 2) return { triAreas, bgArea: R0, domainArea: R0 };

  let bgArea = R0;
  let domainArea = R0;
  for (let k = 0; k + 1 < uniq.length; k++) {
    const x0 = uniq[k], x1 = uniq[k + 1];
    const w = sub(x1, x0);
    if (cmp(w, R0) <= 0) continue;
    const xm = half(add(x0, x1));
    const dv = intervalAt(regionHP, xm);
    if (!dv) continue;
    domainArea = add(domainArea, mul(sub(dv.hi, dv.lo), w));

    let covered = []; // 有序、互不相交的 [a,b]
    let unionLen = R0;
    for (const c of covers) {
      const iv = c.hp.length === 0 ? dv : intervalAt(c.hp, xm);
      if (!iv) continue;
      const lo = cmp(iv.lo, dv.lo) > 0 ? iv.lo : dv.lo;
      const hi = cmp(iv.hi, dv.hi) < 0 ? iv.hi : dv.hi;
      if (cmp(lo, hi) >= 0) continue;
      let win = R0, cursor = lo;
      for (const seg of covered) {
        if (cmp(seg[1], cursor) <= 0) continue;
        if (cmp(seg[0], hi) >= 0) break;
        if (cmp(seg[0], cursor) > 0) win = add(win, sub(seg[0], cursor));
        cursor = cmp(cursor, seg[1]) > 0 ? cursor : seg[1];
        if (cmp(cursor, hi) >= 0) break;
      }
      if (cmp(cursor, hi) < 0) win = add(win, sub(hi, cursor));
      if (cmp(win, R0) > 0) {
        triAreas.set(c.id, add(triAreas.get(c.id) || R0, mul(win, w)));
      }
      unionLen = add(unionLen, win);
      // 并入 covered
      let mlo = lo, mhi = hi;
      const next = [];
      let placed = false;
      for (const seg of covered) {
        if (cmp(seg[1], mlo) < 0) next.push(seg);
        else if (cmp(seg[0], mhi) > 0) {
          if (!placed) { next.push([mlo, mhi]); placed = true; }
          next.push(seg);
        } else {
          if (cmp(seg[0], mlo) < 0) mlo = seg[0];
          if (cmp(seg[1], mhi) > 0) mhi = seg[1];
        }
      }
      if (!placed) next.push([mlo, mhi]);
      covered = next;
    }
    bgArea = add(bgArea, mul(sub(sub(dv.hi, dv.lo), unionLen), w));
  }
  return { triAreas, bgArea, domainArea };
}

// ---------------------------------------------------------------------------
// 对外：给定已校验的场景（与 engine.prepare 接受的格式一致），求单像素。
// 返回 { domainArea, pupilArea, triAreas: Map<id, number>, bgArea, blackArea }。
// ---------------------------------------------------------------------------
function referencePixel(scene, px, py, opts) {
  opts = opts || {};
  const f = fromFloat(Number.isFinite(opts.focusOffset) ? opts.focusOffset : 0);
  const stop = (opts.stop && Array.isArray(opts.stop.offset)) ? opts.stop : scene.stop;
  const W = fromFloat(scene.width), H = fromFloat(scene.height);
  const qx = add(fromFloat(px), R(1, 2)), qy = add(fromFloat(py), R(1, 2));

  const ox = fromFloat(stop.offset[0]), oy = fromFloat(stop.offset[1]);
  const sx = fromFloat(stop.slope[0]), sy = fromFloat(stop.slope[1]);
  const cx = add(ox, mul(sx, sub(qx, half(W))));
  const cy = add(oy, mul(sy, sub(qy, half(H))));

  const pupil = scene.pupil;
  // 保证 CCW
  let area2 = R0;
  for (let i = 0; i < pupil.length; i++) {
    const a = pupil[i], b = pupil[(i + 1) % pupil.length];
    area2 = add(area2, sub(mul(fromFloat(a[0]), fromFloat(b[1])), mul(fromFloat(b[0]), fromFloat(a[1]))));
  }
  const ccw = cmp(area2, R0) < 0 ? pupil.slice().reverse() : pupil;
  const pupilRat = ccw.map(p => [fromFloat(p[0]), fromFloat(p[1])]);
  const pupilArea = toNum(R(area2.n < 0n ? -area2.n : area2.n, area2.d)) / 2;

  const region = chordHalfplanes(pupilRat);
  // 光阑矩形
  region.push(hp(R1, R0, add(cx, R1)));
  region.push(hp(R(-1), R0, neg(sub(cx, R1))));
  region.push(hp(R0, R1, add(cy, R1)));
  region.push(hp(R0, R(-1), neg(sub(cy, R1))));

  // 覆盖片
  const tris = scene.triangles.slice().sort((a, b) => a.depth - b.depth || a.id - b.id);
  const covers = [];
  for (const t of tris) {
    const s = sub(fromFloat(t.s), f);
    if (isZero(s)) {
      // s = 0：q 在三角形内则覆盖整平面。
      if (pointInTriRat(qx, qy, t.xy)) covers.push({ id: t.id, hp: [] });
      continue;
    }
    let xy = t.xy.map(p => [fromFloat(p[0]), fromFloat(p[1])]);
    let a2 = R0;
    for (let i = 0; i < 3; i++) {
      const a = xy[i], b = xy[(i + 1) % 3];
      a2 = add(a2, sub(mul(a[0], b[1]), mul(b[0], a[1])));
    }
    if (cmp(a2, R0) < 0) xy = xy.slice().reverse();
    const hps = [];
    for (let i = 0; i < 3; i++) {
      const a = xy[i], b = xy[(i + 1) % 3];
      const ex = sub(b[0], a[0]), ey = sub(b[1], a[1]);
      // s·cross(e, p) ≤ cross(e, q − a)
      const Ax = mul(s, neg(ey)), Ay = mul(s, ex);
      const B = sub(mul(ex, sub(qy, a[1])), mul(ey, sub(qx, a[0])));
      hps.push(hp(Ax, Ay, B));
    }
    covers.push({ id: t.id, hp: hps });
  }

  const res = sweep(region, covers);
  const domainArea = toNum(res.domainArea);
  const triAreas = new Map();
  for (const [id, a] of res.triAreas) triAreas.set(id, toNum(a));
  return {
    domainArea,
    pupilArea,
    triAreas,
    bgArea: toNum(res.bgArea),
    blackArea: pupilArea - domainArea,
  };
}

function pointInTriRat(x, y, xy) {
  let pos = false, negS = false;
  for (let i = 0; i < 3; i++) {
    const a = xy[i], b = xy[(i + 1) % 3];
    const ax = fromFloat(a[0]), ay = fromFloat(a[1]);
    const bx = fromFloat(b[0]), by = fromFloat(b[1]);
    const z = sub(mul(sub(bx, ax), sub(y, ay)), mul(sub(by, ay), sub(x, ax)));
    const c = cmp(z, R0);
    if (c > 0) pos = true;
    else if (c < 0) negS = true;
  }
  return !(pos && negS);
}

module.exports = { referencePixel };
