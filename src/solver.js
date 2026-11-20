// ARAP 局部刚性变形核心：硬位置约束（消元精确施加），局部旋转限定 SO(3)。
// 每次求解都从 rest 重新初始化，不继承上一次变形结果。

import { bestRotation, matIdentity, matVec, sub3, cross3, norm3 } from './mat3.js';
import { SparseLDL } from './sparse.js';

export const STOP = {
  NONE: 'running',
  CONVERGED: 'converged', // 相对能量下降不超过阈值
  MAX_ITER: 'max_iterations', // 达到轮数上限（不得称作收敛）
  NO_FREE: 'no_deformable_vertices', // 没有需要求解的自由点
};

// data: validateMesh 产出 { rest, triangles, constraints, neighbors, degree, compOf, components }
export class ArapSolver {
  constructor(data) {
    this.data = data;
    this.n = data.rest.length;
    this.resetConstraints(data.constraints);
  }

  // 约束改变后：重新从 rest 初始化（每次求解以导入原网格为参考）
  resetConstraints(constraints) {
    const { n, data } = this;
    this.constraints = constraints.map((c) => ({
      vertex: c.vertex,
      target: c.target.slice(),
    }));
    this.pinned = new Map(this.constraints.map((c) => [c.vertex, c.target]));

    // 无约束的整个连通分量冻结在 p；孤立约束点直接到 target（其本身也在 pinned 中）
    this.frozen = new Uint8Array(n);
    for (const verts of data.components) {
      if (!verts.some((v) => this.pinned.has(v))) {
        for (const v of verts) this.frozen[v] = 1;
      }
    }

    this.freeIdx = [];
    for (let i = 0; i < n; i++) {
      if (!this.pinned.has(i) && !this.frozen[i]) this.freeIdx.push(i);
    }
    this.reduced = new Int32Array(n).fill(-1);
    this.freeIdx.forEach((gi, k) => {
      this.reduced[gi] = k;
    });

    this._factor = null;
    this.initState();
  }

  initState() {
    const { n, data } = this;
    // x 初始化为 rest；硬约束点直接赋 target；冻结点保持 rest
    this.x = data.rest.map((p) => p.slice());
    for (const [v, t] of this.pinned) this.x[v] = t.slice();
    // R_i 初始单位阵
    this.rotations = Array.from({ length: n }, () => matIdentity());
    this.energies = [];
    this.iterations = 0;
    this.stopReason = STOP.NONE;

    // 初始化后先做一次局部步并记录第 0 项能量
    this.localStep();
    this.energies.push(this.energy());
  }

  // 组装自由点矩阵并分解（约束不变则缓存）
  factorization() {
    if (this._factor) return this._factor;
    const { data, freeIdx, reduced } = this;
    const m = freeIdx.length;
    const triplets = [];
    const seen = new Set(); // 每条无向边只入组一次，避免非对角元重复累加
    for (let k = 0; k < m; k++) {
      const i = freeIdx[k];
      triplets.push([k, k, data.degree[i]]);
      for (const j of data.neighbors[i]) {
        if (reduced[j] === -1) continue;
        const rj = reduced[j];
        const key = k < rj ? k * m + rj : rj * m + k;
        if (seen.has(key)) continue;
        seen.add(key);
        triplets.push([Math.max(k, rj), Math.min(k, rj), -1]);
      }
    }
    this._factor = new SparseLDL(m, triplets);
    return this._factor;
  }

  // 局部步：逐点求最优正旋转
  localStep() {
    const { data, x, rotations, pinned, frozen } = this;
    const p = data.rest;
    for (let i = 0; i < this.n; i++) {
      if (frozen[i]) {
        // 冻结分量不参与变形，旋转恒为单位
        rotations[i] = matIdentity();
        continue;
      }
      const nb = data.neighbors[i];
      if (nb.length === 0) {
        // 孤立点：无边能量，旋转无意义，取单位
        rotations[i] = matIdentity();
        continue;
      }
      // H_i = sum_j (p_i-p_j)(x_i-x_j)^T
      const H = new Array(9).fill(0);
      const pi = p[i];
      const xi = x[i];
      for (const j of nb) {
        const dp = [pi[0] - p[j][0], pi[1] - p[j][1], pi[2] - p[j][2]];
        const dx = [xi[0] - x[j][0], xi[1] - x[j][1], xi[2] - x[j][2]];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) H[r * 3 + c] += dp[r] * dx[c];
        }
      }
      rotations[i] = bestRotation(H);
      // 防御性断言：必须是正旋转
      const det = (() => {
        const R = rotations[i];
        return (
          R[0] * (R[4] * R[8] - R[5] * R[7]) -
          R[1] * (R[3] * R[8] - R[5] * R[6]) +
          R[2] * (R[3] * R[7] - R[4] * R[6])
        );
      })();
      if (!(det > 0)) throw new Error(`顶点 ${i} 的局部旋转行列式为 ${det}，非正旋转`);
    }
  }

  // 全局步：消元硬约束后解自由点方程
  globalStep() {
    const { data, freeIdx, reduced, rotations, pinned, frozen, x } = this;
    const p = data.rest;
    const m = freeIdx.length;
    if (m === 0) return;
    const factor = this.factorization();
    const b = new Float64Array(m * 3);
    for (let k = 0; k < m; k++) {
      const i = freeIdx[k];
      // 0.5 * sum_j (R_i + R_j)(p_i - p_j)，约束/冻结点移项到右端
      let bx = 0,
        by = 0,
        bz = 0;
      const Ri = rotations[i];
      for (const j of data.neighbors[i]) {
        const d = [p[i][0] - p[j][0], p[i][1] - p[j][1], p[i][2] - p[j][2]];
        const Rj = rotations[j];
        const S00 = 0.5 * (Ri[0] + Rj[0]);
        const S01 = 0.5 * (Ri[1] + Rj[1]);
        const S02 = 0.5 * (Ri[2] + Rj[2]);
        const S10 = 0.5 * (Ri[3] + Rj[3]);
        const S11 = 0.5 * (Ri[4] + Rj[4]);
        const S12 = 0.5 * (Ri[5] + Rj[5]);
        const S20 = 0.5 * (Ri[6] + Rj[6]);
        const S21 = 0.5 * (Ri[7] + Rj[7]);
        const S22 = 0.5 * (Ri[8] + Rj[8]);
        bx += S00 * d[0] + S01 * d[1] + S02 * d[2];
        by += S10 * d[0] + S11 * d[1] + S12 * d[2];
        bz += S20 * d[0] + S21 * d[1] + S22 * d[2];
        if (reduced[j] === -1) {
          // j 为硬约束或冻结点：+ x_j（L 中 -1*x_j 移项）
          bx += x[j][0];
          by += x[j][1];
          bz += x[j][2];
        }
      }
      b[k * 3] = bx;
      b[k * 3 + 1] = by;
      b[k * 3 + 2] = bz;
    }
    factor.solve(b, 3);
    for (let k = 0; k < m; k++) {
      const i = freeIdx[k];
      x[i] = [b[k * 3], b[k * 3 + 1], b[k * 3 + 2]];
    }
    // 硬约束点保持 target 不变；冻结点保持 rest
    for (const [v, t] of pinned) x[v] = t.slice();
  }

  // E = sum_i sum_j ||(x_i-x_j) - R_i(p_i-p_j)||^2（有向邻接求和）
  energy() {
    const { data, x, rotations } = this;
    const p = data.rest;
    let E = 0;
    for (let i = 0; i < this.n; i++) {
      const R = rotations[i];
      for (const j of data.neighbors[i]) {
        const dp = sub3(p[i], p[j]);
        const rdp = matVec(R, dp);
        const dx = sub3(x[i], x[j]);
        const e = [dx[0] - rdp[0], dx[1] - rdp[1], dx[2] - rdp[2]];
        E += e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
      }
    }
    return E;
  }

  // 推进一轮：全局步 -> 局部步 -> 记录能量；按阈值判定停止
  step(threshold = 1e-7) {
    if (this.stopReason !== STOP.NONE) return this.stopReason;
    if (this.freeIdx.length === 0) {
      this.stopReason = STOP.NO_FREE;
      return this.stopReason;
    }
    this.globalStep();
    this.localStep();
    const E = this.energy();
    const prev = this.energies[this.energies.length - 1];
    this.energies.push(E);
    this.iterations += 1;
    const denom = Math.max(1, prev);
    if (Math.abs(prev - E) / denom <= threshold) {
      this.stopReason = STOP.CONVERGED;
    }
    return this.stopReason;
  }

  // 全量求解（可由 worker 分帧驱动，每轮回调 onIteration 以便取消/刷新）
  async run(maxIterations, threshold, onIteration, shouldCancel) {
    for (let k = 0; k < maxIterations; k++) {
      if (shouldCancel && shouldCancel()) break;
      const reason = this.step(threshold);
      if (onIteration) await onIteration(this.iterations, this.energies[this.energies.length - 1]);
      if (reason !== STOP.NONE) return reason;
    }
    if (this.stopReason === STOP.NONE) this.stopReason = STOP.MAX_ITER;
    return this.stopReason;
  }
}

// 导出诊断 JSON 需要的逐点旋转（行主序）
export function rotationsFlat(solver) {
  return solver.rotations.map((R) => R.slice());
}

export { cross3, norm3 };
