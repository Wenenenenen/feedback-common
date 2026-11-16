/* 3D 向量与 4x4 矩阵工具（列主序，兼容 WebGL uniformMatrix4fv 与 Node 测试） */
(function (global) {
  'use strict';

  const v3 = {
    create: (x = 0, y = 0, z = 0) => [x, y, z],
    clone: (a) => [a[0], a[1], a[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm(a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
    },
    lerp: (a, b, t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ],
  };

  /* 列主序 16 元素矩阵 */
  const m4 = {
    identity() {
      const m = new Float64Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },

    multiply(a, b) {
      const out = new Float64Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          out[c * 4 + r] =
            a[0 * 4 + r] * b[c * 4 + 0] +
            a[1 * 4 + r] * b[c * 4 + 1] +
            a[2 * 4 + r] * b[c * 4 + 2] +
            a[3 * 4 + r] * b[c * 4 + 3];
        }
      }
      return out;
    },

    /* 视图矩阵：相机位于 eye，朝向 target，上方向 up */
    lookAt(eye, target, up) {
      const z = v3.norm(v3.sub(eye, target)); // 视线反方向
      const x = v3.norm(v3.cross(v3.sub(target, eye), up)); // 右 = forward × up
      const y = v3.cross(z, x);
      const m = new Float64Array(16);
      m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
      m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
      m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
      m[12] = -v3.dot(x, eye);
      m[13] = -v3.dot(y, eye);
      m[14] = -v3.dot(z, eye);
      m[15] = 1;
      return m;
    },

    /* 正交投影：vertical_span 为世界单位下的可视高度 */
    ortho(verticalSpan, aspect, near, far) {
      const h = verticalSpan / 2;
      const w = h * aspect;
      const m = new Float64Array(16);
      m[0] = 1 / w;
      m[5] = 1 / h;
      m[10] = 2 / (near - far);
      m[14] = (near + far) / (near - far);
      m[15] = 1;
      return m;
    },

    transformPoint(m, p) {
      const x = p[0], y = p[1], z = p[2];
      return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
        m[3] * x + m[7] * y + m[11] * z + m[15],
      ];
    },
  };

  const api = { v3, m4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Math3D = api;
})(typeof window !== 'undefined' ? window : globalThis);
