/*
 * mat4.js — 行主序 4×4 仿射矩阵工具（无依赖）
 * 输入 matrix 为长度 16 的数组，元素 m[4*i+j] 表示第 i 行第 j 列。
 * 点为列向量：p' = M * p。
 * 同时可在浏览器（globalThis.Mat4）与 Node（module.exports）中使用。
 */
(function (global, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else global.Mat4 = mod;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function clone(m) {
    return m.slice();
  }

  // c = a * b
  function multiply(a, b) {
    const c = new Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[4 * i + k] * b[4 * k + j];
        c[4 * i + j] = s;
      }
    }
    return c;
  }

  // 对点 (x,y,z) 做仿射变换，返回 [x',y',z']
  function transformPoint(m, x, y, z) {
    const w = m[12] * x + m[13] * y + m[14] * z + m[15];
    return [
      (m[0] * x + m[1] * y + m[2] * z + m[3]) / w,
      (m[4] * x + m[5] * y + m[6] * z + m[7]) / w,
      (m[8] * x + m[9] * y + m[10] * z + m[11]) / w,
    ];
  }

  /*
   * Gauss-Jordan 求逆。
   * 奇异（主元过小）时返回 null。阈值按矩阵元素量级取相对值，
   * 避免大尺度矩阵被误判、小尺度矩阵被漏判。
   */
  function inverse(m) {
    const a = new Array(16);
    const inv = identity();
    for (let i = 0; i < 16; i++) a[i] = m[i];

    let scale = 0;
    for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(a[i]));
    if (!isFinite(scale) || scale === 0) return null;
    const pivotTol = scale * 1e-12;

    for (let col = 0; col < 4; col++) {
      let piv = col;
      let pivAbs = Math.abs(a[4 * col + col]);
      for (let r = col + 1; r < 4; r++) {
        const v = Math.abs(a[4 * r + col]);
        if (v > pivAbs) { pivAbs = v; piv = r; }
      }
      if (pivAbs <= pivotTol) return null;
      if (piv !== col) {
        for (let k = 0; k < 4; k++) {
          let t = a[4 * col + k]; a[4 * col + k] = a[4 * piv + k]; a[4 * piv + k] = t;
          t = inv[4 * col + k]; inv[4 * col + k] = inv[4 * piv + k]; inv[4 * piv + k] = t;
        }
      }
      const diag = a[4 * col + col];
      for (let k = 0; k < 4; k++) {
        a[4 * col + k] /= diag;
        inv[4 * col + k] /= diag;
      }
      for (let r = 0; r < 4; r++) {
        if (r === col) continue;
        const f = a[4 * r + col];
        if (f === 0) continue;
        for (let k = 0; k < 4; k++) {
          a[4 * r + k] -= f * a[4 * col + k];
          inv[4 * r + k] -= f * inv[4 * col + k];
        }
      }
    }
    return inv;
  }

  /*
   * 对称 3×3 矩阵 Jacobi 特征值分解，返回特征值数组。
   * 用于求 A^T A 的特征值，进而得到奇异值。
   */
  function jacobiEigen3(sym) {
    const a = sym.slice();
    for (let iter = 0; iter < 100; iter++) {
      let p = 0, q = 1, maxOff = Math.abs(a[1]);
      const candidates = [[0, 2, Math.abs(a[2])], [1, 2, Math.abs(a[5])]];
      for (const [ci, cj, cv] of candidates) {
        if (cv > maxOff) { maxOff = cv; p = ci; q = cj; }
      }
      if (maxOff < 1e-15) break;

      const app = a[4 * p], aqq = a[4 * q], apq = a[p * 3 + q];
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < 3; k++) {
        const akp = a[3 * k + p], akq = a[3 * k + q];
        a[3 * k + p] = c * akp - s * akq;
        a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[3 * p + k], aqk = a[3 * q + k];
        a[3 * p + k] = c * apk - s * aqk;
        a[3 * q + k] = s * apk + c * aqk;
      }
    }
    return [a[0], a[4], a[8]];
  }

  /*
   * 线性部分 A（matrix 左上 3×3）的最小奇异值 σ_min。
   * σ_min = sqrt(λ_min(A^T A))，浮点误差导致的负特征值钳到 0。
   */
  function minSingularValue(m) {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const b = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += a[3 * k + i] * a[3 * k + j];
        b[3 * i + j] = s;
      }
    }
    const eig = jacobiEigen3(b);
    const lam = Math.min(eig[0], eig[1], eig[2]);
    return Math.sqrt(Math.max(lam, 0));
  }

  // —— 编辑器用的便捷构造（均返回行主序 4×4） ——
  function scaling(sx, sy, sz) {
    return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
  }

  function rotationY(rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  }

  function rotationX(rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
  }

  // x 方向沿 y 剪切：x' = x + k*y
  function shearXY(k) {
    return [1, k, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function translation(tx, ty, tz) {
    return [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
  }

  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function length3(a) { return Math.hypot(a[0], a[1], a[2]); }
  function normalize3(a) {
    const l = length3(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  }

  return {
    identity, clone, multiply, transformPoint, inverse,
    minSingularValue, jacobiEigen3,
    scaling, rotationX, rotationY, shearXY, translation,
    sub3, add3, scale3, dot3, cross3, length3, normalize3,
  };
});
