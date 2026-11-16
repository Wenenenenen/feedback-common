/* 双三次贝塞尔曲面求值、偏导、法线与边控制点提取 */
(function (global) {
  'use strict';

  /* 三次 Bernstein 基函数在 t 处的值 */
  function bernstein(t) {
    const u = 1 - t;
    return [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  }

  /* 三次 Bernstein 基函数对 t 的导数 */
  function bernsteinDeriv(t) {
    const u = 1 - t;
    return [-3 * u * u, 9 * u * u - 6 * u, 3 * t * (2 - 3 * t), 3 * t * t];
  }

  /* points[j][i]：u 方向第 i、v 方向第 j 控制点 */
  function evalSurface(points, u, v) {
    const bu = bernstein(u);
    const bv = bernstein(v);
    const p = [0, 0, 0];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const w = bu[i] * bv[j];
        const c = points[j][i];
        p[0] += w * c[0];
        p[1] += w * c[1];
        p[2] += w * c[2];
      }
    }
    return p;
  }

  function evalDeriv(points, u, v) {
    const bu = bernstein(u);
    const bv = bernstein(v);
    const du = bernsteinDeriv(u);
    const dv = bernsteinDeriv(v);
    const dPdu = [0, 0, 0];
    const dPdv = [0, 0, 0];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const c = points[j][i];
        const wu = du[i] * bv[j];
        const wv = bu[i] * dv[j];
        for (let k = 0; k < 3; k++) {
          dPdu[k] += wu * c[k];
          dPdv[k] += wv * c[k];
        }
      }
    }
    return { dPdu, dPdv };
  }

  function evalNormal(points, u, v) {
    const { dPdu, dPdv } = evalDeriv(points, u, v);
    const n = v3cross(dPdu, dPdv);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return [0, 0, 1];
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  function v3cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  const EDGES = ['u0', 'u1', 'v0', 'v1'];

  /* 边的 4 个控制点，按自然方向排序：u 边沿 v 增大，v 边沿 u 增大 */
  function edgeControlPoints(points, edge) {
    switch (edge) {
      case 'u0':
        return [points[0][0], points[1][0], points[2][0], points[3][0]];
      case 'u1':
        return [points[0][3], points[1][3], points[2][3], points[3][3]];
      case 'v0':
        return [points[0][0], points[0][1], points[0][2], points[0][3]];
      case 'v1':
        return [points[3][0], points[3][1], points[3][2], points[3][3]];
      default:
        throw new Error('未知边名: ' + edge);
    }
  }

  /* 边上自然参数 t∈[0,1] 的点 */
  function evalEdge(points, edge, t) {
    const cp = edgeControlPoints(points, edge);
    const b = bernstein(t);
    const p = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      p[0] += b[i] * cp[i][0];
      p[1] += b[i] * cp[i][1];
      p[2] += b[i] * cp[i][2];
    }
    return p;
  }

  /* 边自然参数 t 对应的曲面 (u,v) */
  function edgeUV(edge, t) {
    switch (edge) {
      case 'u0': return [0, t];
      case 'u1': return [1, t];
      case 'v0': return [t, 0];
      case 'v1': return [t, 1];
      default: throw new Error('未知边名: ' + edge);
    }
  }

  const api = {
    bernstein,
    bernsteinDeriv,
    evalSurface,
    evalDeriv,
    evalNormal,
    edgeControlPoints,
    evalEdge,
    edgeUV,
    EDGES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Bezier = api;
})(typeof window !== 'undefined' ? window : globalThis);
