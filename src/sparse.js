// 稀疏 LDL^T 求解器（A = L D L^T，L 单位下三角），专为网格规模（n<=2000）设计。
// 符号阶段：消去树 + 行可达集（已用稠密 Cholesky 独立验证：无缺失非零元）。
// 数值阶段：固定符号结构上的左向 LDL，升序双指针求公共列。
// 矩阵对称，只需传入下三角（含对角）三元组。

export class SparseLDL {
  constructor(n, triplets) {
    this.n = n;
    this.diag = new Float64Array(n);
    const orig = Array.from({ length: n }, () => new Map());
    for (const [i, j, v] of triplets) {
      if (i === j) this.diag[i] += v;
      else {
        const r = Math.max(i, j);
        const c = Math.min(i, j);
        orig[r].set(c, (orig[r].get(c) || 0) + v);
      }
    }
    this.orig = orig;

    // ---- 1. 消去树 ----
    // parent[j]：对每列 k，遍历结构行 i<k，沿 parent 找根 r，若 r 无父则 parent[r]=k。
    const parent = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) {
      for (const i of orig[k].keys()) {
        let r = i;
        while (parent[r] !== -1 && parent[r] < k) r = parent[r];
        if (parent[r] === -1) parent[r] = k;
      }
    }
    this.parent = parent;

    // ---- 2. 每行符号 pattern：结构列沿 etree 的祖先闭包（严格小于行号）----
    const pattern = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) {
      const s = pattern[i];
      const stack = Array.from(orig[i].keys());
      while (stack.length) {
        const j = stack.pop();
        if (j >= i || s.has(j)) continue;
        s.add(j);
        if (parent[j] !== -1) stack.push(parent[j]);
      }
    }
    const cols = pattern.map((s) => Array.from(s).sort((a, b) => a - b));
    this.cols = cols;

    // ---- 3. 数值 LDL（结构固定，左向递推）----
    const Lvals = cols.map((c) => new Float64Array(c.length));
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const ci = cols[i];
      const li = Lvals[i];
      for (let t = 0; t < ci.length; t++) {
        const j = ci[t];
        const cj = cols[j];
        const lj = Lvals[j];
        // 结构非零取 A[i,j]，填充位置（超集里的多余项）缺省为 0
        let s = orig[i].get(j) || 0;
        // 公共列求交：ci[0..t) 与 cj（cj 所有列都 < j=ci[t]）
        let ai = 0;
        let aj = 0;
        while (ai < t && aj < cj.length) {
          const ma = ci[ai];
          const mb = cj[aj];
          if (ma === mb) {
            s -= li[ai] * lj[aj] * d[ma];
            ai++;
            aj++;
          } else if (ma < mb) ai++;
          else aj++;
        }
        li[t] = s / d[j];
      }
      let dkk = this.diag[i];
      for (let t = 0; t < ci.length; t++) dkk -= li[t] * li[t] * d[ci[t]];
      if (!(dkk > 0)) {
        throw new Error(
          `稀疏分解在第 ${i} 行遇到非正主元 ${dkk}，矩阵非正定（可能存在无约束的自由分量）`
        );
      }
      d[i] = dkk;
    }
    this.Lvals = Lvals;
    this.d = d;

    // 按列索引：colRows[j] 列出所有满足 L[i][j]!=0 的行 i>j 及其数值位置，
    // 供反向代入解 L^T x = z（需要第 j 列、行号大于 j 的非零元）。
    const colRows = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < cols[i].length; t++) {
        colRows[cols[i][t]].push([i, Lvals[i][t]]);
      }
    }
    this.colRows = colRows;
  }

  // b: Float64Array(n * nrhs)，行主序；结果写入同一数组
  solve(b, nrhs = 3) {
    const { n, cols, Lvals, colRows, d } = this;
    // 前向代入 L y = b（按行，cols[i] 升序）
    for (let i = 0; i < n; i++) {
      const ci = cols[i];
      const li = Lvals[i];
      for (let r = 0; r < nrhs; r++) {
        let s = b[i * nrhs + r];
        for (let t = 0; t < ci.length; t++) s -= li[t] * b[ci[t] * nrhs + r];
        b[i * nrhs + r] = s;
      }
    }
    // z = y / d
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < nrhs; r++) b[i * nrhs + r] /= d[i];
    }
    // 反向代入 L^T x = z：第 i 个方程为 x_i + sum_{j>i} L[j][i] x_j = z_i
    for (let i = n - 1; i >= 0; i--) {
      for (let r = 0; r < nrhs; r++) {
        let s = b[i * nrhs + r];
        for (const [j, lji] of colRows[i]) s -= lji * b[j * nrhs + r];
        b[i * nrhs + r] = s;
      }
    }
    return b;
  }
}
