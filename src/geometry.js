// 精确平面几何（点 = {x: Frac, y: Frac}）
import { Frac, f0 } from './frac.js';

export function pt(x, y) { return { x, y }; }
export function ptInt(x, y) { return pt(Frac.fromInt(x), Frac.fromInt(y)); }

export function ptEq(a, b) { return a.x.eq(b.x) && a.y.eq(b.y); }
export function ptCmp(a, b) {
  const c = a.x.cmp(b.x);
  return c !== 0 ? c : a.y.cmp(b.y);
}

// 点的字典序 key（用于 Map）
export function ptKey(p) { return `${p.x}|${p.y}`; }

// 向量叉积 (b-a) × (c-a)
export function cross(a, b, c) {
  return b.x.sub(a.x).mul(c.y.sub(a.y)).sub(b.y.sub(a.y).mul(c.x.sub(a.x)));
}
export function orient(a, b, c) { return cross(a, b, c).sign(); } // >0 即 CCW

// 向量 (b-a) 与 (d-c) 的叉积
export function vecCross(a, b, c, d) {
  return b.x.sub(a.x).mul(d.y.sub(c.y)).sub(b.y.sub(a.y).mul(d.x.sub(c.x)));
}

// r 是否落在闭线段 [p,q] 上（调用方需保证共线）
export function onSegment(p, q, r) {
  return r.x.cmp(minF(p.x, q.x)) >= 0 && r.x.cmp(maxF(p.x, q.x)) <= 0 &&
         r.y.cmp(minF(p.y, q.y)) >= 0 && r.y.cmp(maxF(p.y, q.y)) <= 0;
}
const minF = (a, b) => (a.cmp(b) <= 0 ? a : b);
const maxF = (a, b) => (a.cmp(b) >= 0 ? a : b);

// 整数 bbox 快速排除
export function bboxDisjoint(s1, s2) {
  return maxF(s1.a.x, s1.b.x).cmp(minF(s2.a.x, s2.b.x)) < 0 ||
         maxF(s2.a.x, s2.b.x).cmp(minF(s1.a.x, s1.b.x)) < 0 ||
         maxF(s1.a.y, s1.b.y).cmp(minF(s2.a.y, s2.b.y)) < 0 ||
         maxF(s2.a.y, s2.b.y).cmp(minF(s1.a.y, s1.b.y)) < 0;
}

// 线段求交，返回 {type:'none'|'point'|'segment', points:[...]}
// point 时 points 长度 1；segment 时 points 为共线重叠区间端点（两点，可重合=相切点）
export function segmentIntersection(s1, s2) {
  const { a: p, b: q } = s1;
  const { a: r, b: s } = s2;
  const d1 = vecCross(p, q, p, r); // (q-p)×(r-p)
  const d2 = vecCross(p, q, p, s); // (q-p)×(s-p)
  const d3 = vecCross(r, s, r, p);
  const d4 = vecCross(r, s, r, q);

  if (d1.sign() !== 0 || d2.sign() !== 0 || d3.sign() !== 0 || d4.sign() !== 0) {
    // 一般情形（含 T 接、端点相交）：参数 t = d3 / (d3-d4)
    const denom = d3.sub(d4);
    if (denom.sign() === 0) return { type: 'none', points: [] };
    const t = d3.div(denom);
    if (t.sign() < 0 || t.cmp(Frac.ONE) > 0) return { type: 'none', points: [] };
    const hit = pt(p.x.add(q.x.sub(p.x).mul(t)), p.y.add(q.y.sub(p.y).mul(t)));
    if (onSegment(r, s, hit)) return { type: 'point', points: [hit] };
    return { type: 'none', points: [] };
  }

  // 全部共线
  if (!onSegment(p, q, r) && !onSegment(p, q, s) &&
      !onSegment(r, s, p) && !onSegment(r, s, q)) {
    return { type: 'none', points: [] };
  }
  const pts = [p, q, r, s].filter((v) => onSegment(p, q, v) && onSegment(r, s, v));
  pts.sort(ptCmp);
  const uniq = [];
  for (const v of pts) {
    if (!uniq.length || !ptEq(uniq[uniq.length - 1], v)) uniq.push(v);
  }
  if (uniq.length === 0) return { type: 'none', points: [] };
  if (uniq.length === 1) return { type: 'point', points: [uniq[0]] };
  return { type: 'segment', points: [uniq[0], uniq[uniq.length - 1]] };
}

// 点是否在三角形内部或边上（精确），tri 为三点数组
export function pointInTriangleClosed(tri, p) {
  const [a, b, c] = tri;
  const s1 = orient(a, b, p);
  const s2 = orient(b, c, p);
  const s3 = orient(c, a, p);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}
// 严格内部
export function pointInTriangleStrict(tri, p) {
  const [a, b, c] = tri;
  return orient(a, b, p) > 0 && orient(b, c, p) > 0 && orient(c, a, p) > 0;
}

// 有向三角形面积 ×2（CCW 为正）
export function triArea2(a, b, c) { return cross(a, b, c); }

// 环有向面积 ×2：顶点数组
export function ringArea2(ring) {
  let s = f0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s = s.add(a.x.mul(b.y).sub(a.y.mul(b.x)));
  }
  return s;
}
