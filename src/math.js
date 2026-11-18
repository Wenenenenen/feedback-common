/*
 * math.js — 基础三维向量/矩阵工具（无依赖）
 * 所有向量用长度为 3 或 4 的普通数组表示。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function length(a) { return Math.hypot(a[0], a[1], a[2]); }
  function normalize(a) {
    const l = length(a);
    return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  }
  function lerp(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }
  /** 4 分量齐次顶点的线性插值（t 按齐次裁剪空间线性，不在裁剪时做透视修正） */
  function lerp4(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ];
  }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function deg2rad(d) { return d * Math.PI / 180; }

  /**
   * 计算三角形面法线（归一化）。顶点按输入绕序，右手定则决定正向。
   * 退化三角形返回零向量。
   */
  function faceNormal(p0, p1, p2) {
    const n = cross(sub(p1, p0), sub(p2, p0));
    return normalize(n);
  }

  HLM.math = {
    add, sub, scale, dot, cross, length, normalize, lerp, lerp4,
    clamp, deg2rad, faceNormal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
