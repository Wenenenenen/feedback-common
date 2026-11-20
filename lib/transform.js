// 正交 DCT-II 与归一化 Walsh-Hadamard 组变换。
//
// 二维 DCT-II 矩阵：C[k,n] = sqrt((1 if k==0 else 2)/p) * cos(pi*(n+0.5)*k/p)
// 二维变换即 C · X · Cᵀ（C 正交，逆变换为 Cᵀ · Y · C）。
//
// 组变换：H1 = [1]，H_2m = [[Hm,Hm],[Hm,-Hm]] / sqrt(2)，沿组序作用于同频系数。
// H 为对称正交矩阵，正逆变换相同。

const dctCache = new Map();
const hadamardCache = new Map();

export function dctMatrix(p) {
  let C = dctCache.get(p);
  if (C) return C;
  C = new Float64Array(p * p);
  for (let k = 0; k < p; k++) {
    const scale = Math.sqrt((k === 0 ? 1 : 2) / p);
    for (let n = 0; n < p; n++) {
      C[k * p + n] = scale * Math.cos((Math.PI * (n + 0.5) * k) / p);
    }
  }
  dctCache.set(p, C);
  return C;
}

export function hadamardMatrix(m) {
  let H = hadamardCache.get(m);
  if (H) return H;
  if (m < 1 || (m & (m - 1)) !== 0) throw new Error('Walsh-Hadamard 组大小必须为 2 的幂');
  H = new Float64Array([1]);
  let size = 1;
  const s = Math.SQRT1_2;
  while (size < m) {
    const next = size * 2;
    const G = new Float64Array(next * next);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const v = H[r * size + c];
        G[r * next + c] = v * s;
        G[r * next + c + size] = v * s;
        G[(r + size) * next + c] = v * s;
        G[(r + size) * next + c + size] = -v * s;
      }
    }
    H = G;
    size = next;
  }
  hadamardCache.set(m, H);
  return H;
}

export function dct2(patch, p) {
  const C = dctMatrix(p);
  const tmp = new Float64Array(p * p);
  for (let k = 0; k < p; k++) {
    for (let n = 0; n < p; n++) {
      let sum = 0;
      for (let x = 0; x < p; x++) sum += C[k * p + x] * patch[x * p + n];
      tmp[k * p + n] = sum;
    }
  }
  const out = new Float64Array(p * p);
  for (let k = 0; k < p; k++) {
    for (let l = 0; l < p; l++) {
      let sum = 0;
      for (let n = 0; n < p; n++) sum += tmp[k * p + n] * C[l * p + n];
      out[k * p + l] = sum;
    }
  }
  return out;
}

export function idct2(coef, p) {
  const C = dctMatrix(p);
  // tmp = Cᵀ · coef
  const tmp = new Float64Array(p * p);
  for (let x = 0; x < p; x++) {
    for (let l = 0; l < p; l++) {
      let sum = 0;
      for (let k = 0; k < p; k++) sum += C[k * p + x] * coef[k * p + l];
      tmp[x * p + l] = sum;
    }
  }
  // out = tmp · C
  const out = new Float64Array(p * p);
  for (let x = 0; x < p; x++) {
    for (let y = 0; y < p; y++) {
      let sum = 0;
      for (let l = 0; l < p; l++) sum += tmp[x * p + l] * C[l * p + y];
      out[x * p + y] = sum;
    }
  }
  return out;
}

// 组数据布局：[组索引 i][空间频率 k] -> i * nCoef + k。
// 对每个 k 沿 i 做 H · v。
export function groupTransform(group, m, nCoef, H = hadamardMatrix(m)) {
  const out = new Float64Array(m * nCoef);
  for (let r = 0; r < m; r++) {
    for (let k = 0; k < nCoef; k++) {
      let sum = 0;
      for (let j = 0; j < m; j++) sum += H[r * m + j] * group[j * nCoef + k];
      out[r * nCoef + k] = sum;
    }
  }
  return out;
}

export function inverseGroupTransform(group, m, nCoef, H = hadamardMatrix(m)) {
  // H 对称正交，逆变换与正变换相同。
  return groupTransform(group, m, nCoef, H);
}
