// 3x3 矩阵工具：行主序存储 [m00,m01,m02, m10,...]，向量为长度 3 的数组。
// 所有例程均为纯函数、零分配热点路径尽量复用输出参数。

export function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function isFiniteVec3(a) {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

export function matIdentity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

// C = A * B
export function matMul(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i * 3 + j] =
        A[i * 3] * B[j] +
        A[i * 3 + 1] * B[3 + j] +
        A[i * 3 + 2] * B[6 + j];
    }
  }
  return C;
}

// R * v
export function matVec(R, v) {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
}

export function matTranspose(A) {
  return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
}

export function matDet(A) {
  return (
    A[0] * (A[4] * A[8] - A[5] * A[7]) -
    A[1] * (A[3] * A[8] - A[5] * A[6]) +
    A[2] * (A[3] * A[7] - A[4] * A[6])
  );
}

// 对称 3x3 矩阵的 Jacobi 特征分解 A = V diag(w) V^T。
// 输入 A 行主序；输出 { w: [特征值升序? 不保证顺序], V: 列向量为特征向量(行主序) }。
// 对浮点噪声不敏感，适合 H^T H 这类半正定矩阵。
export function symEig3(Ain) {
  const a = [
    [Ain[0], Ain[1], Ain[2]],
    [Ain[1], Ain[4], Ain[5]],
    [Ain[2], Ain[5], Ain[8]],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 60; sweep++) {
    const off =
      a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p][p];
        const aqq = a[q][q];
        let tau = (aqq - app) / (2 * apq);
        let t;
        if (tau >= 0) t = 1 / (tau + Math.sqrt(1 + tau * tau));
        else t = -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = 0;
        a[q][p] = 0;
        for (let r = 0; r < 3; r++) {
          if (r !== p && r !== q) {
            const arp = a[r][p];
            const arq = a[r][q];
            a[r][p] = c * arp - s * arq;
            a[p][r] = a[r][p];
            a[r][q] = s * arp + c * arq;
            a[q][r] = a[r][q];
          }
        }
        for (let r = 0; r < 3; r++) {
          const vrp = V[r][p];
          const vrq = V[r][q];
          V[r][p] = c * vrp - s * vrq;
          V[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }

  const w = [a[0][0], a[1][1], a[2][2]];
  // 行主序展平 V：V[r][c]
  const Vflat = [V[0][0], V[0][1], V[0][2], V[1][0], V[1][1], V[1][2], V[2][0], V[2][1], V[2][2]];
  return { w, V: Vflat };
}

// 由 H 求最优正旋转 R（SO(3) 投影）。
// 输入约定（conventions.md）：H = sum (p_i-p_j)(x_i-x_j)^T，标准 SVD 记 H = U S V^T，
// 最优正旋转 R = V diag(1,1,det(V U^T)) U^T。
// 实现：对 H^T H 特征分解取 V、H H^T 取 U，非零奇异值用 U=H V/S 对齐符号，
// 零奇异方向用右手正交基补全并让 U、V 的零空间方向一致（保证秩亏时旋转仍在数据平面内正确作用）。
// H 全零返回单位阵。
export function bestRotation(Hin) {
  let h2 = 0;
  for (let k = 0; k < 9; k++) h2 += Hin[k] * Hin[k];
  if (h2 === 0) return matIdentity();

  const Ht = matTranspose(Hin);
  const HtH = matMul(Ht, Hin); // H^T H = V S^2 V^T，只需这一次特征分解
  const eV = symEig3(HtH);

  const colOf = (M, c) => [M[c], M[3 + c], M[6 + c]];
  const oV = [0, 1, 2].sort((a, b) => eV.w[b] - eV.w[a]); // 奇异值降序
  const sig = oV.map((k) => Math.sqrt(Math.max(0, eV.w[k])));
  const Vc = oV.map((k) => colOf(eV.V, k));
  const Uc = [null, null, null];

  const tol = 1e-12 * (sig[0] || 1);
  const nullIdx = [];
  for (let k = 0; k < 3; k++) {
    if (sig[k] > tol) {
      // 标准 SVD 关系 U[:,k] = H V[:,k] / σ_k，自动确定 U 的方向与符号
      Uc[k] = scale3(matVec(Hin, Vc[k]), 1 / sig[k]);
    } else {
      nullIdx.push(k);
    }
  }

  if (nullIdx.length === 1) {
    // 秩 2：零方向是数据平面法向。U、V 的该列都取各自另两列的叉积，
    // 这样零空间在域和值域中对齐为同一根物理轴，旋转不会把平面内向量转出平面。
    const k = nullIdx[0];
    const o = [0, 1, 2].filter((x) => x !== k);
    Vc[k] = cross3(Vc[o[0]], Vc[o[1]]);
    Uc[k] = cross3(Uc[o[0]], Uc[o[1]]);
  } else if (nullIdx.length === 2) {
    // 秩 1：围绕唯一非零方向各建一组右手正交基
    const k0 = [0, 1, 2].find((x) => Uc[x] !== null);
    const build = (u) => {
      const ref = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let e1 = cross3(u, ref);
      e1 = scale3(e1, 1 / norm3(e1));
      const e2 = cross3(u, e1);
      return [e1, e2];
    };
    const [u1, u2] = build(Uc[k0]);
    Uc[nullIdx[0]] = u1;
    Uc[nullIdx[1]] = u2;
    const [v1, v2] = build(Vc[k0]);
    Vc[nullIdx[0]] = v1;
    Vc[nullIdx[1]] = v2;
  } else if (nullIdx.length === 3) {
    // H 非零却三个奇异值都为零，理论上不会发生，保险返回单位阵
    return matIdentity();
  }

  const pack = (cs) => [
    cs[0][0], cs[1][0], cs[2][0],
    cs[0][1], cs[1][1], cs[2][1],
    cs[0][2], cs[1][2], cs[2][2],
  ];
  const U = pack(Uc);
  const V = pack(Vc);
  const d = matDet(matMul(V, matTranspose(U)));
  const D = [1, 0, 0, 0, 1, 0, 0, 0, d >= 0 ? 1 : -1];
  return normalizeSO3(matMul(matMul(V, D), matTranspose(U)));
}

// 对近正交矩阵做修正 Gram-Schmidt，输出严格正交且行列式为 +1 的旋转。
// 消除浮点噪声（~1e-16 正交误差、负零行列式），并稳健处理平面/共线导致的秩亏列
// （约定允许局部共面邻域，此时 H 可能秩 2 或秩 1，零空间方向可任选最优正旋转）。
export function normalizeSO3(R) {
  const col = (c) => [R[c], R[3 + c], R[6 + c]];
  // 用矩阵整体尺度做相对阈值，避免绝对 1e-12 在大/小坐标量级下误判
  let scale = 0;
  for (let k = 0; k < 9; k++) scale = Math.max(scale, Math.abs(R[k]));
  const zeroTol = 1e-10 * Math.max(1, scale);

  // 第一遍：对非零列做 Gram-Schmidt，记录秩亏列
  const q = [null, null, null];
  const rankDef = [];
  for (let c = 0; c < 3; c++) {
    let v = col(c);
    for (let k = 0; k < c; k++) {
      if (q[k] === null) continue;
      v = sub3(v, scale3(q[k], dot3(v, q[k])));
    }
    if (norm3(v) > zeroTol) {
      q[c] = scale3(v, 1 / norm3(v));
    } else {
      rankDef.push(c);
    }
  }

  if (rankDef.length === 1) {
    // 秩 2：零列取另两列叉积
    const [a, b] = [0, 1, 2].filter((x) => x !== rankDef[0]);
    q[rankDef[0]] = cross3(q[a], q[b]);
    if (norm3(q[rankDef[0]]) <= zeroTol) {
      // 两列近乎共线的极端兜底
      q[rankDef[0]] = arbitraryOrthonormal(q[a] || q[b]);
    }
  } else if (rankDef.length === 2) {
    // 秩 1：围绕唯一非零列任建正交基
    const keep = [0, 1, 2].find((x) => q[x] !== null);
    const u = q[keep];
    const ref = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let e1 = cross3(u, ref);
    e1 = scale3(e1, 1 / norm3(e1));
    const e2 = cross3(u, e1);
    q[rankDef[0]] = e1;
    q[rankDef[1]] = e2;
  } else if (rankDef.length === 3) {
    return matIdentity();
  }

  // 强制右手系（det=+1）
  if (dot3(cross3(q[0], q[1]), q[2]) < 0) {
    q[2] = scale3(q[2], -1);
  }
  return [
    q[0][0], q[1][0], q[2][0],
    q[0][1], q[1][1], q[2][1],
    q[0][2], q[1][2], q[2][2],
  ];
}

// 给定向量 u，返回一个与它正交的单位向量
function arbitraryOrthonormal(u) {
  const ref = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let v = cross3(u, ref);
  return scale3(v, 1 / norm3(v));
}
