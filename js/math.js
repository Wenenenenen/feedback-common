// 向量 / 矩阵基础运算。内部统一行主序；列向量约定 p' = M * p。
export const v3 = {
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
  normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
};

// 行主序 3x3
export const m3 = {
  mulVec: (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ],
  det: (m) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]),
  // 逆转置 = 代数余子式矩阵 / 行列式
  inverseTranspose(m) {
    const c = (r, s) => {
      const rows = [0, 1, 2].filter((i) => i !== r);
      const cols = [0, 1, 2].filter((j) => j !== s);
      const minor =
        m[rows[0] * 3 + cols[0]] * m[rows[1] * 3 + cols[1]] -
        m[rows[0] * 3 + cols[1]] * m[rows[1] * 3 + cols[0]];
      return (r + s) % 2 === 0 ? minor : -minor;
    };
    const d = m3.det(m);
    const out = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = c(i, j) / d;
    return out;
  },
};

// 行主序 4x4
export const m4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  multiply(a, b) {
    const o = new Array(16).fill(0);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        for (let k = 0; k < 4; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
    return o;
  },
  translation: (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1],
  scale: (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1],
  rotX: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
  },
  rotY: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  },
  rotZ: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  },
  linear: (m) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
  transformPoint(m, p) {
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ];
  },
  // 行主序 -> WebGL 需要的列主序
  toColumnMajor: (m) => [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ],
  // 透视投影（行主序内部表示）
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, 2 * far * near * nf,
      0, 0, -1, 0,
    ];
  },
  lookAt(eye, center, up) {
    const z = v3.normalize(v3.sub(eye, center));
    const x = v3.normalize(v3.cross(up, z));
    const y = v3.cross(z, x);
    return [
      x[0], x[1], x[2], -v3.dot(x, eye),
      y[0], y[1], y[2], -v3.dot(y, eye),
      z[0], z[1], z[2], -v3.dot(z, eye),
      0, 0, 0, 1,
    ];
  },
};

// 由 TRS 组装实例矩阵：M = T * Rz * Ry * Rx * S（旋转按 X→Y→Z 顺序施加）
export function composeTRS(t, rDeg, s) {
  const rx = (rDeg[0] * Math.PI) / 180;
  const ry = (rDeg[1] * Math.PI) / 180;
  const rz = (rDeg[2] * Math.PI) / 180;
  return m4.multiply(
    m4.translation(t[0], t[1], t[2]),
    m4.multiply(m4.rotZ(rz), m4.multiply(m4.rotY(ry), m4.multiply(m4.rotX(rx), m4.scale(s[0], s[1], s[2]))))
  );
}
