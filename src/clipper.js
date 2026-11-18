/*
 * clipper.js — 齐次裁剪空间六平面裁剪（Sutherland–Hodgman）
 *
 * 裁剪约定 0 <= z_clip <= w，六个平面的内侧符号距离（>=0 在内）：
 *   left   : w + x
 *   right  : w - x
 *   bottom : w + y
 *   top    : w - y
 *   near   : z
 *   far    : w - z
 *
 * 顶点为 { c: [x,y,z,w], ...attrs }，交点处附带属性按参数 t 线性插值。
 * 透视相机下穿过相机背后的三角形（w<=0）也由本裁剪安全处理。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});
  const M = HLM.math;

  const EPS = 1e-12;

  // [a,b,c,d] 表示平面符号距离 a*x+b*y+c*z+d*w
  const PLANES = [
    [1, 0, 0, 1],   // left:   w + x >= 0
    [-1, 0, 0, 1],  // right:  w - x >= 0
    [0, 1, 0, 1],   // bottom: w + y >= 0
    [0, -1, 0, 1],  // top:    w - y >= 0
    [0, 0, 1, 0],   // near:   z     >= 0
    [0, 0, -1, 1],  // far:    w - z >= 0
  ];

  function signed(plane, v) {
    return plane[0] * v.c[0] + plane[1] * v.c[1]
         + plane[2] * v.c[2] + plane[3] * v.c[3];
  }

  function inside(plane, v) {
    const s = signed(plane, v);
    return s >= -EPS * (1 + Math.abs(v.c[3]));
  }

  /** 求线段 S->E 与平面的交点（S 在内、E 在外，或反之），插值全部属性 */
  function intersect(plane, sV, eV) {
    const ds = signed(plane, sV);
    const de = signed(plane, eV);
    let t = ds / (ds - de);
    if (!Number.isFinite(t)) t = 0;
    t = M.clamp(t, 0, 1);
    const out = { c: M.lerp4(sV.c, eV.c, t) };
    for (const k of Object.keys(sV)) {
      if (k === 'c') continue;
      const a = sV[k], b = eV[k];
      if (typeof a === 'number' && typeof b === 'number') {
        out[k] = a + (b - a) * t;
      } else {
        out[k] = a;
      }
    }
    return out;
  }

  function clipPolygonOnce(vertices, plane) {
    const out = [];
    if (vertices.length === 0) return out;
    for (let i = 0; i < vertices.length; i++) {
      const S = vertices[i];
      const E = vertices[(i + 1) % vertices.length];
      const sIn = inside(plane, S);
      const eIn = inside(plane, E);
      if (sIn && eIn) {
        out.push(E);
      } else if (sIn && !eIn) {
        out.push(intersect(plane, S, E));
      } else if (!sIn && eIn) {
        out.push(intersect(plane, S, E));
        out.push(E);
      }
    }
    return out;
  }

  /** 对多边形（顶点数组）依次应用六个平面，返回裁剪后的凸多边形顶点 */
  function clipPolygon(vertices) {
    let poly = vertices;
    for (const plane of PLANES) {
      poly = clipPolygonOnce(poly, plane);
      if (poly.length < 3) return poly;
    }
    return poly;
  }

  /**
   * 裁剪一条携带参数 t（原始 3D 线段上的 u∈[0,1]）的齐次线段。
   * 返回 null（完全在视锥外）或 { t0, t1, c0, c1 }。
   * 凸视锥与直线的交至多一段；输出按 t 排序。
   */
  function clipSegment(c0, c1) {
    let poly = [{ c: c0, t: 0 }, { c: c1, t: 1 }];
    for (const plane of PLANES) {
      poly = clipPolygonOnce(poly, plane);
      if (poly.length === 0) return null;
    }
    if (poly.length < 2) return null;
    let lo = poly[0], hi = poly[0];
    for (const v of poly) {
      if (v.t < lo.t) lo = v;
      if (v.t > hi.t) hi = v;
    }
    if (hi.t - lo.t <= EPS) return null;
    return { t0: lo.t, t1: hi.t, c0: lo.c, c1: hi.c };
  }

  /**
   * 裁剪一个三角形（3 个齐次顶点），返回裁剪多边形的 NDC 顶点数组。
   * 投影后零面积由调用方判别。
   */
  function clipTriangleToNdc(c0, c1, c2) {
    const poly = clipPolygon([{ c: c0 }, { c: c1 }, { c: c2 }]);
    if (poly.length < 3) return [];
    return poly.map(v => HLM.camera.clipToNdc(v.c));
  }

  HLM.clipper = { clipPolygon, clipSegment, clipTriangleToNdc, PLANES };
})(typeof window !== 'undefined' ? window : globalThis);
