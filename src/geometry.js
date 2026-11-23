/*
 * geometry.js — 2D 几何基础（凸多边形、共边线、线段相交、朝向）
 * 同时支持浏览器 <script> 与 Node require。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CG = Object.assign(root.CG || {}, factory());
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 浮点容差：长度/端点误差要求 1e-6，内部判定用更紧的 1e-12
  const EPS = 1e-12;

  function eq(a, b, eps) { return Math.abs(a - b) <= (eps || EPS); }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s]; }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function dist2(a, b) { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }

  // 二维叉积 (a-o) × (b-o)
  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  // 有向面积（CCW 为正）
  function signedArea(poly) {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      s += a[0] * b[1] - a[1] * b[0];
    }
    return s * 0.5;
  }

  function centroid(poly) {
    let x = 0, y = 0;
    for (const p of poly) { x += p[0]; y += p[1]; }
    return [x / poly.length, y / poly.length];
  }

  // 点是否在线段上（含端点）
  function onSegment(p, a, b, eps) {
    eps = eps || EPS;
    if (Math.abs(cross(a, b, p)) > eps * Math.max(1, dist2(a, b))) return false;
    return Math.min(a[0], b[0]) - eps <= p[0] && p[0] <= Math.max(a[0], b[0]) + eps &&
           Math.min(a[1], b[1]) - eps <= p[1] && p[1] <= Math.max(a[1], b[1]) + eps;
  }

  // 点在凸多边形内（含边界）。poly 顶点顺序不限。
  function pointInConvex(p, poly, eps) {
    eps = eps || EPS;
    let sign = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      // 叉积容差按边长缩放，保证边界点在任何坐标尺度下都稳定
      const tol = eps * Math.max(1, dist2(a, b));
      const c = cross(a, b, p);
      if (Math.abs(c) <= tol) continue; // 边上
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // 线段 ab 是否整体位于凸多边形内（凸性：两端点在内即可）
  function segmentInConvex(a, b, poly, eps) {
    return pointInConvex(a, poly, eps) && pointInConvex(b, poly, eps);
  }

  // 两线段交点：返回 {type:'none'|'point'|'segment', a,b}（参数点均为坐标）
  function segmentIntersect(a, b, c, d, eps) {
    eps = eps || EPS;
    const r = sub(b, a), s = sub(d, c);
    const rxs = r[0] * s[1] - r[1] * s[0];
    const qpx = c[0] - a[0], qpy = c[1] - a[1];
    if (Math.abs(rxs) <= EPS) {
      // 平行：共线重叠才可能相交
      if (Math.abs(qpx * r[1] - qpy * r[0]) > eps) return { type: 'none' };
      const rr = r[0] * r[0] + r[1] * r[1];
      const t0 = (qpx * r[0] + qpy * r[1]) / rr;
      const t1 = t0 + (s[0] * r[0] + s[1] * r[1]) / rr;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
      if (lo > hi + eps) return { type: 'none' };
      if (hi - lo <= eps) return { type: 'point', a: lerp(a, b, lo), b: null };
      return { type: 'segment', a: lerp(a, b, lo), b: lerp(a, b, hi) };
    }
    const t = (qpx * s[1] - qpy * s[0]) / rxs;
    const u = (qpx * r[1] - qpy * r[0]) / rxs;
    if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return { type: 'none' };
    return { type: 'point', a: lerp(a, b, Math.min(1, Math.max(0, t))), b: null };
  }

  // 求两个凸多边形的共边线段（无共边返回 null）。
  // 思路：收集落在对方边界上的顶点，投影到共线方向取极值。
  function sharedEdge(polyA, polyB, eps) {
    eps = eps || 1e-9;
    const candidates = [];
    const push = (p) => {
      for (const q of candidates) if (dist2(p, q) <= eps * eps) return;
      candidates.push(p);
    };
    for (const p of polyA) {
      for (let j = 0, m = polyB.length; j < m; j++) {
        if (onSegment(p, polyB[j], polyB[(j + 1) % m], eps)) { push(p); break; }
      }
    }
    for (const p of polyB) {
      for (let j = 0, m = polyA.length; j < m; j++) {
        if (onSegment(p, polyA[j], polyA[(j + 1) % m], eps)) { push(p); break; }
      }
    }
    if (candidates.length < 2) {
      // 顶点不重合时的兜底：做边-边相交
      for (let i = 0, n = polyA.length; i < n; i++) {
        const a = polyA[i], b = polyA[(i + 1) % n];
        for (let j = 0, m = polyB.length; j < m; j++) {
          const c = polyB[j], d = polyB[(j + 1) % m];
          const hit = segmentIntersect(a, b, c, d, eps);
          if (hit.type === 'point') push(hit.a);
          else if (hit.type === 'segment') { push(hit.a); push(hit.b); }
        }
      }
      if (candidates.length < 2) return null;
    }
    // 找包含候选点最多的直线方向（取前两点），沿方向投影取两端
    let u = sub(candidates[1], candidates[0]);
    if (dist2(u, [0, 0]) <= eps * eps) {
      for (let k = 2; k < candidates.length; k++) {
        u = sub(candidates[k], candidates[0]);
        if (dist2(u, [0, 0]) > eps * eps) break;
      }
    }
    const ul = Math.hypot(u[0], u[1]);
    u = [u[0] / ul, u[1] / ul];
    let lo = Infinity, hi = -Infinity, pLo = null, pHi = null;
    for (const p of candidates) {
      const t = (p[0] - candidates[0][0]) * u[0] + (p[1] - candidates[0][1]) * u[1];
      if (t < lo) { lo = t; pLo = p; }
      if (t > hi) { hi = t; pHi = p; }
    }
    if (hi - lo <= eps) return null;
    return [pLo, pHi];
  }

  // 门线段按两端余量裁剪。返回：
  //   { kind:'empty' }                          余量吃掉整段 → 不可通行
  //   { kind:'point', p }                       恰好剩一个点
  //   { kind:'segment', a, b }                  有效门线段
  function applyMargin(doorA, doorB, margin) {
    const len = dist(doorA, doorB);
    if (len <= EPS) return { kind: 'point', p: [doorA[0], doorA[1]] };
    const m = Math.max(0, margin);
    if (2 * m > len + EPS) return { kind: 'empty' };
    if (len - 2 * m <= 1e-9) {
      return { kind: 'point', p: lerp(doorA, doorB, 0.5) };
    }
    const t0 = m / len, t1 = 1 - m / len;
    return { kind: 'segment', a: lerp(doorA, doorB, t0), b: lerp(doorA, doorB, t1) };
  }

  // 折线总长
  function polylineLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  }

  return {
    EPS, eq, sub, add, scale, lerp, dist, dist2, cross, signedArea, centroid,
    onSegment, pointInConvex, segmentInConvex, segmentIntersect, sharedEdge,
    applyMargin, polylineLength,
  };
});
