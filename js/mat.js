/* 极简列主序 mat4 / vec3 工具（UMD：浏览器挂 window.CSMat，Node 可 require） */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CSMat = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 列主序：m[c*4+r]，与 WebGL uniformMatrix4fv 一致，作用于列向量。
  function multiply(a, b) { // 返回 a*b
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function transformPoint(m, p) { // 仿射/正交矩阵（w=1）
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  }

  function transpose(m) { // 列主序 -> 行主序（导出用）
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = m[r * 4 + c];
    return o;
  }

  function perspective(fovYDeg, aspect, near, far) {
    const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
    const m = new Array(16).fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  }

  // 正交投影，+z 朝前（光空间 z 增大表示远离光源），z=n -> -1, z=f -> +1
  function orthoForwardZ(l, r, b, t, n, f) {
    const m = new Array(16).fill(0);
    m[0] = 2 / (r - l);
    m[5] = 2 / (t - b);
    m[10] = 2 / (f - n);
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -(f + n) / (f - n);
    m[15] = 1;
    return m;
  }

  // 以三个行向量（光空间基 x/y/z）构造纯旋转视图矩阵：s = (x·p, y·p, z·p)
  function rotFromRows(x, y, z) {
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      0, 0, 0, 1,
    ];
  }

  function lookAt(eye, target, up) {
    const f = norm3(sub3(target, eye));
    const r = norm3(cross3(f, up));
    const u = cross3(r, f);
    return [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -dot3(r, eye), -dot3(u, eye), dot3(f, eye), 1,
    ];
  }

  function modelTRS(center, size) {
    return [
      size[0], 0, 0, 0,
      0, size[1], 0, 0,
      0, 0, size[2], 0,
      center[0], center[1], center[2], 1,
    ];
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
  function norm3(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }

  return {
    multiply, transformPoint, transpose, perspective, orthoForwardZ,
    rotFromRows, lookAt, modelTRS,
    sub3, add3, scale3, dot3, cross3, norm3,
  };
});
