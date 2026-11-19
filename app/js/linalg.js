// 3x3 线性代数与 3x3 对称矩阵特征分解（自实现 Jacobi）。
// 矩阵均按行优先 9 元素数组存储，作用于齐次列向量 [x, y, 1]。

export function identity3() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function matMul(a, b) {
  const out = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] =
        a[i * 3] * b[j] +
        a[i * 3 + 1] * b[3 + j] +
        a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

export function matVec(m, x, y, w = 1) {
  return [
    m[0] * x + m[1] * y + m[2] * w,
    m[3] * x + m[4] * y + m[5] * w,
    m[6] * x + m[7] * y + m[8] * w,
  ];
}

// 归一化：除以 m[8]。分母不可用时抛错（对应约定中 H[2,2] 必须可用）。
export function normalizeH(m) {
  const d = m[8];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) {
    throw new Error('单应矩阵归一化失败：H[2,2] 接近零或无效（投影退化）');
  }
  return m.map((v) => v / d);
}

export function invert3(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    throw new Error('矩阵不可逆：行列式接近零（投影退化）');
  }
  const id = 1 / det;
  return [
    A * id,
    (c * h - b * i) * id,
    (b * f - c * e) * id,
    B * id,
    (a * i - c * g) * id,
    (c * d - a * f) * id,
    C * id,
    (b * g - a * h) * id,
    (a * e - b * d) * id,
  ];
}

export function det3(m) {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

// 对称 3x3 矩阵（按 6 个独立元素或完整 9 元素给出）的特征值/特征向量。
// 返回 { values: [λ0,λ1,λ2], vectors: [v0,v1,v2] }，特征值升序。
// 这是题目允许使用的“矩阵分解”能力，采用经典 Jacobi 旋转迭代实现。
export function symmetricEig3(sym) {
  const a = [
    sym[0], sym[1], sym[2],
    sym[1], sym[4], sym[5],
    sym[2], sym[5], sym[8],
  ];
  const v = identity3();
  for (let sweep = 0; sweep < 100; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-300) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q];
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p * 3 + p];
        const aqq = a[q * 3 + q];
        let t;
        const phi = (aqq - app) / (2 * apq);
        if (phi === 0) {
          t = 1;
        } else {
          const s = Math.sign(phi);
          t = s / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        // 旋转 A
        a[p * 3 + p] = app - t * apq;
        a[q * 3 + q] = aqq + t * apq;
        a[p * 3 + q] = 0;
        a[q * 3 + p] = 0;
        for (let k = 0; k < 3; k++) {
          if (k !== p && k !== q) {
            const akp = a[k * 3 + p];
            const akq = a[k * 3 + q];
            a[k * 3 + p] = c * akp - s * akq;
            a[p * 3 + k] = a[k * 3 + p];
            a[k * 3 + q] = s * akp + c * akq;
            a[q * 3 + k] = a[k * 3 + q];
          }
        }
        // 累积特征向量
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p];
          const vkq = v[k * 3 + q];
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j]);
  const values = idx.map((k) => a[k * 3 + k]);
  const vectors = idx.map((k) => [v[k], v[3 + k], v[6 + k]]);
  return { values, vectors };
}

// 通用 n×n 对称矩阵 Jacobi 特征分解（行优先 n*n）。
// 返回 { values: 升序特征值, vectors: 对应列特征向量数组 }。
export function symmetricEigN(sym, n) {
  const a = sym.slice();
  const v = [];
  for (let i = 0; i < n * n; i++) v.push(i % (n + 1) === 0 ? 1 : 0);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const phi = (aqq - app) / (2 * apq);
        const t = phi === 0 ? 1 : Math.sign(phi) / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        a[p * n + p] = app - t * apq;
        a[q * n + q] = aqq + t * apq;
        a[p * n + q] = 0;
        a[q * n + p] = 0;
        for (let k = 0; k < n; k++) {
          if (k !== p && k !== q) {
            const akp = a[k * n + p];
            const akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[p * n + k] = a[k * n + p];
            a[k * n + q] = s * akp + c * akq;
            a[q * n + k] = a[k * n + q];
          }
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => a[i * n + i] - a[j * n + j]
  );
  const values = order.map((k) => a[k * n + k]);
  const vectors = order.map((k) => {
    const vec = [];
    for (let r = 0; r < n; r++) vec.push(v[r * n + k]);
    return vec;
  });
  return { values, vectors };
}
