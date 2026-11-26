// 向量/矩阵基础数学 —— 手写，无第三方依赖
export const EPS = 1e-9;

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const clone = (a) => [a[0], a[1], a[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const lengthSq = (a) => dot(a, a);
export const length = (a) => Math.sqrt(lengthSq(a));
export const dist = (a, b) => length(sub(a, b));
export const normalize = (a) => {
  const l = length(a);
  return l > EPS ? scale(a, 1 / l) : [0, 0, 0];
};
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const mul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; // 分量乘

export function isFiniteV(a) {
  return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
}

// 点关于平面(v0, n) 的反射
export function reflectPoint(x, v0, n) {
  const d = dot(sub(x, v0), n);
  return sub(x, scale(n, 2 * d));
}

// 列主序 4x4（和常见 WebGL 约定一致），m[col*4+row]
export function identity4() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// 反射平面的仿射矩阵 H(x) = x - 2((x-v0)·n) n
// = (I - 2 n nᵀ) x + 2 (n·v0) n
export function reflectionMatrix(v0, n) {
  const m = identity4();
  const a00 = 1 - 2 * n[0] * n[0];
  const a11 = 1 - 2 * n[1] * n[1];
  const a22 = 1 - 2 * n[2] * n[2];
  const a01 = -2 * n[0] * n[1];
  const a02 = -2 * n[0] * n[2];
  const a12 = -2 * n[1] * n[2];
  const nv = dot(n, v0);
  // 线性部分
  m[0] = a00; m[4] = a01; m[8] = a02;
  m[1] = a01; m[5] = a11; m[9] = a12;
  m[2] = a02; m[6] = a12; m[10] = a22;
  // 平移部分
  m[12] = 2 * nv * n[0];
  m[13] = 2 * nv * n[1];
  m[14] = 2 * nv * n[2];
  return m;
}

export function multiply4(a, b) {
  // out = a * b
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
}

export function transformPoint4(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function transformDir4(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

// 通用 4x4 逆（Gauss-Jordan）；本应用矩阵为等距反射，必可逆
export function invert4(a) {
  const inv = new Float64Array(16);
  const aug = new Float64Array(16);
  aug.set(a);
  inv[0] = inv[5] = inv[10] = inv[15] = 1;
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(aug[r * 4 + col]) > Math.abs(aug[piv * 4 + col])) piv = r;
    }
    if (Math.abs(aug[piv * 4 + col]) < 1e-14) return null;
    if (piv !== col) {
      for (let k = 0; k < 4; k++) {
        const t1 = aug[col * 4 + k], t2 = aug[piv * 4 + k];
        aug[col * 4 + k] = t2; aug[piv * 4 + k] = t1;
        const u1 = inv[col * 4 + k], u2 = inv[piv * 4 + k];
        inv[col * 4 + k] = u2; inv[piv * 4 + k] = u1;
      }
    }
    const pv = aug[col * 4 + col];
    for (let k = 0; k < 4; k++) {
      aug[col * 4 + k] /= pv;
      inv[col * 4 + k] /= pv;
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = aug[r * 4 + col];
      if (f === 0) continue;
      for (let k = 0; k < 4; k++) {
        aug[r * 4 + k] -= f * aug[col * 4 + k];
        inv[r * 4 + k] -= f * inv[col * 4 + k];
      }
    }
  }
  return inv;
}

// 有符号三角形面积 ×2 的模
export function triArea2(a, b, c) {
  return cross(sub(b, a), sub(c, a));
}
export function triAreaNorm(a, b, c) {
  return length(triArea2(a, b, c)) * 0.5;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
export function clamp01(x) {
  return clamp(x, 0, 1);
}
export function toByte(c) {
  return Math.round(clamp01(c) * 255);
}
