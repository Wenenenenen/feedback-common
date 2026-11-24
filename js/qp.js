/*
 * 单轴约束二次规划（每镜头一条轨迹）。
 *
 *   minimize  Σ_t u_t²  +  λ · Σ_t ( q_t − 2q_{t+1} + q_{t+2} )²,   q = p − u
 *   subject to |u_t| ≤ bound（画幅余量） 与固定帧 u_t = pin（等式）。
 *
 * 目标严格凸（H = I + λDᵀD ⪰ I），可行域为闭凸集，故最优解唯一。
 * 求解：H 为五对角（带宽 2），用带状 LDLᵀ + 原始活跃集法精确求解。
 * 单次操作 O(m)，活跃集迭代次数与贴界帧数同阶。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPQp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 构造 H = I + λ DᵀD 的五对角（λ 可为零）。返回 {diag, off1, off2}。 */
  function buildH(m, lambda) {
    const diag = new Float64Array(m);
    const off1 = new Float64Array(Math.max(0, m - 1));
    const off2 = new Float64Array(Math.max(0, m - 2));
    for (let i = 0; i < m; i++) diag[i] = 1;
    if (lambda !== 0 && m >= 3) {
      for (let r = 0; r + 2 < m; r++) {
        diag[r] += lambda;
        diag[r + 1] += 4 * lambda;
        diag[r + 2] += lambda;
        off1[r] += -2 * lambda;
        off1[r + 1] += -2 * lambda;
        off2[r] += lambda;
      }
    }
    return { diag, off1, off2 };
  }

  /** b = λ · Dᵀ D p。 */
  function buildB(p, m, lambda) {
    const b = new Float64Array(m);
    if (lambda === 0 || m < 3) return b;
    const a = new Float64Array(m - 2);
    for (let r = 0; r + 2 < m; r++) a[r] = p[r] - 2 * p[r + 1] + p[r + 2];
    const rows = m - 2;
    for (let j = 0; j < m; j++) {
      let s = 0;
      if (j < rows) s += a[j];
      if (j - 1 >= 0 && j - 1 < rows) s += -2 * a[j - 1];
      if (j - 2 >= 0 && j - 2 < rows) s += a[j - 2];
      b[j] = lambda * s;
    }
    return b;
  }

  /** y = H x（五对角 matvec）。 */
  function matvec(H, x) {
    const { diag, off1, off2 } = H;
    const m = diag.length;
    const y = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = diag[i] * x[i];
      if (i + 1 < m) s += off1[i] * x[i + 1];
      if (i - 1 >= 0) s += off1[i - 1] * x[i - 1];
      if (i + 2 < m) s += off2[i] * x[i + 2];
      if (i - 2 >= 0) s += off2[i - 2] * x[i - 2];
      y[i] = s;
    }
    return y;
  }

  /** 目标值 f(u) = Σu² + λΣ(Δ²(p−u))²。 */
  function objective(p, u, lambda) {
    const m = p.length;
    let e = 0;
    for (let i = 0; i < m; i++) e += u[i] * u[i];
    if (lambda !== 0 && m >= 3) {
      let d2 = 0;
      for (let r = 0; r + 2 < m; r++) {
        const q0 = p[r] - u[r];
        const q1 = p[r + 1] - u[r + 1];
        const q2 = p[r + 2] - u[r + 2];
        const v = q0 - 2 * q1 + q2;
        d2 += v * v;
      }
      e += lambda * d2;
    }
    return e;
  }

  /**
   * 带状 LDLᵀ（半带宽 2）。A 用 {diag, off1, off2} 表示（对称，仅存上三角）。
   * 返回 x 使 A x = rhs。不修改输入。
   */
  function solveBandedFull(A, rhs) {
    const n = A.diag.length;
    const x = new Float64Array(n);
    if (n === 0) return x;
    if (n === 1) {
      if (A.diag[0] === 0) throw new Error('带状分解遇到零主元');
      x[0] = rhs[0] / A.diag[0];
      return x;
    }
    // 紧凑存 L: l1[i]=L[i+1,i] (i=0..n-2), l2[i]=L[i+2,i] (i=0..n-3)
    const l1 = new Float64Array(n - 1);
    const l2 = new Float64Array(n >= 3 ? n - 2 : 0);
    const D = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let d = A.diag[j];
      if (j >= 1) d -= l1[j - 1] * l1[j - 1] * D[j - 1];
      if (j >= 2) d -= l2[j - 2] * l2[j - 2] * D[j - 2];
      if (!(d > 0)) throw new Error('带状分解主元非正（矩阵非正定）');
      D[j] = d;
      if (j + 1 < n) {
        // L[j+1,j] = (A[j+1,j] - Σ_{k=max(0,j-1)}^{j-1} L[j+1,k]D[k]L[j,k]) / D[j]
        let s = A.off1[j];
        // k=j-1: L[j+1,j-1]=l2[j-1?] 注意 l2 索引: L[i+2,i]=l2[i] → L[j+1,j-1]=l2[j-1]
        if (j - 1 >= 0) s -= l2[j - 1] * D[j - 1] * l1[j - 1];
        l1[j] = s / d;
      }
      if (j + 2 < n) {
        // L[j+2,j] = A.off2[j] / D[j]（k 求和区间为空）
        l2[j] = A.off2[j] / d;
      }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = rhs[i];
      if (i >= 1) s -= l1[i - 1] * y[i - 1];
      if (i >= 2) s -= l2[i - 2] * y[i - 2];
      y[i] = s;
    }
    for (let i = 0; i < n; i++) y[i] /= D[i];
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      if (i + 1 < n) s -= l1[i] * x[i + 1];
      if (i + 2 < n) s -= l2[i] * x[i + 2];
      x[i] = s;
    }
    return x;
  }

  /**
   * 求解单轴问题。
   * @param {Float64Array} p      轨迹（长度 m）
   * @param {number} lambda       平滑强度 ≥ 0
   * @param {number} bound        每侧允许 |u| ≤ bound（≥ 0）；调用方已保证
   * @param {Array<{index:number,value:number}>} pins 局部帧号与锁定值（已保证 |value|≤bound）
   * @returns {{u:Float64Array, cost:number, iterations:number,
   *            nAtUpper:number, nAtLower:number, nPinned:number}}
   */
  function solveAxis(p, lambda, bound, pins) {
    const m = p.length;
    const u = new Float64Array(m);
    if (m === 0) return { u, cost: 0, iterations: 0, nAtUpper: 0, nAtLower: 0, nPinned: 0 };
    const pinList = pins || [];
    const pinned = new Uint8Array(m);
    for (const pin of pinList) {
      if (pin.index < 0 || pin.index >= m) throw new Error('固定帧索引越界');
      pinned[pin.index] = 1;
      u[pin.index] = pin.value;
    }
    // 唯一可行点：所有自由帧只能为 0
    if (bound === 0) {
      return {
        u,
        cost: objective(p, u, lambda),
        iterations: 0,
        nAtUpper: 0,
        nAtLower: 0,
        nPinned: pinList.length,
      };
    }
    // m ≤ 2：目标仅 Σu²（无二阶项），自由帧最优为 0
    const H = buildH(m, lambda);
    const b = buildB(p, m, lambda);
    if (m < 3) {
      return {
        u,
        cost: objective(p, u, lambda),
        iterations: 0,
        nAtUpper: 0,
        nAtLower: 0,
        nPinned: pinList.length,
      };
    }

    // 可行起点：自由帧把 p 夹到 [−bound, bound]；固定帧取锁定值
    const start = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      if (pinned[i]) start[i] = u[i];
      else start[i] = Math.max(-bound, Math.min(bound, p[i]));
    }
    // 工作集状态：0 自由，+1 贴上界，−1 贴下界，2 固定帧
    const state = new Int8Array(m);
    for (let i = 0; i < m; i++) if (pinned[i]) state[i] = 2;

    let cur = start;
    let iterations = 0;
    const maxIter = 20 * (m + 8);

    // 缓存：构建自由集时复用的数组
    const freeIdx = [];
    const uPartial = new Float64Array(m);

    for (let guard = 0; guard <= maxIter; guard++) {
      iterations++;
      // 组装工作集固定部分
      uPartial.fill(0);
      freeIdx.length = 0;
      for (let i = 0; i < m; i++) {
        if (state[i] === 2) uPartial[i] = u[i];
        else if (state[i] === 1) uPartial[i] = bound;
        else if (state[i] === -1) uPartial[i] = -bound;
        else freeIdx.push(i);
      }
      // 若自由集为空，解即当前固定值
      let cand = new Float64Array(m);
      if (freeIdx.length > 0) {
        const k = freeIdx.length;
        const Ha = matvec(H, uPartial);
        const Ared = {
          diag: new Float64Array(k),
          off1: new Float64Array(Math.max(0, k - 1)),
          off2: new Float64Array(Math.max(0, k - 2)),
        };
        for (let i = 0; i < k; i++) Ared.diag[i] = H.diag[freeIdx[i]] + 0;
        const lookup = (i, j) => {
          const oi = freeIdx[i];
          const oj = freeIdx[j];
          const d = oj - oi;
          if (Math.abs(d) > 2) return 0;
          if (d === 1) return H.off1[oi];
          if (d === 2) return H.off2[oi];
          if (d === -1) return H.off1[oj];
          if (d === -2) return H.off2[oj];
          return 0;
        };
        for (let i = 0; i < k - 1; i++) {
          const v = lookup(i, i + 1);
          if (v !== 0) Ared.off1[i] += v;
        }
        for (let i = 0; i < k - 2; i++) {
          const v = lookup(i, i + 2);
          if (v !== 0) Ared.off2[i] += v;
        }
        const rhs = new Float64Array(k);
        for (let i = 0; i < k; i++) rhs[i] = b[freeIdx[i]] - Ha[freeIdx[i]];
        const sol = solveBandedFull(Ared, rhs);
        cand.set(uPartial);
        for (let i = 0; i < k; i++) cand[freeIdx[i]] = sol[i];
      } else {
        cand = uPartial;
      }

      // 检查自由帧是否越界；有则做比值检验，加入阻塞约束
      let block = -1;
      let bestRatio = Infinity;
      let blockSign = 0;
      let feasible = true;
      for (let i = 0; i < m; i++) {
        if (state[i] !== 0) continue;
        const target = cand[i];
        if (target > bound + 1e-12) {
          feasible = false;
          const denom = target - cur[i];
          const ratio = denom > 0 ? (bound - cur[i]) / denom : 0;
          if (ratio < bestRatio - 1e-15 || (Math.abs(ratio - bestRatio) <= 1e-15 && i < block)) {
            bestRatio = ratio; block = i; blockSign = 1;
          }
        } else if (target < -bound - 1e-12) {
          feasible = false;
          const denom = target - cur[i];
          const neg = -bound;
          const ratio = denom < 0 ? (neg - cur[i]) / denom : 0;
          if (ratio < bestRatio - 1e-15 || (Math.abs(ratio - bestRatio) <= 1e-15 && i < block)) {
            bestRatio = ratio; block = i; blockSign = -1;
          }
        }
      }

      if (!feasible) {
        const alpha = bestRatio === Infinity ? 0 : Math.min(1, Math.max(0, bestRatio));
        const next = new Float64Array(m);
        for (let i = 0; i < m; i++) next[i] = cur[i] + alpha * (cand[i] - cur[i]);
        // 精确贴到界，避免数值漂移
        if (block >= 0) {
          next[block] = blockSign > 0 ? bound : -bound;
          state[block] = blockSign;
        }
        // 清理极小的越界噪声
        for (let i = 0; i < m; i++) {
          if (state[i] === 0) {
            if (next[i] > bound) next[i] = bound;
            else if (next[i] < -bound) next[i] = -bound;
          }
        }
        cur = next;
        continue;
      }

      // 解可行：置于候选点，检查已贴界约束的乘子
      cur = cand;
      const g = matvec(H, cur);
      for (let i = 0; i < m; i++) g[i] -= b[i];
      // KKT：上界需 g_i ≤ 0；下界需 g_i ≥ 0；固定帧不检
      let worst = -1;
      let worstVal = 0;
      for (let i = 0; i < m; i++) {
        if (state[i] === 1) {
          const viol = g[i]; // >0 说明应释放
          if (viol > 1e-12 && viol > worstVal) { worstVal = viol; worst = i; }
        } else if (state[i] === -1) {
          const viol = -g[i]; // g<0 应释放
          if (viol > 1e-12 && viol > worstVal) { worstVal = viol; worst = i; }
        }
      }
      if (worst < 0) {
        // 最优点
        let nUp = 0; let nLo = 0;
        for (let i = 0; i < m; i++) {
          if (state[i] === 1) nUp++;
          else if (state[i] === -1) nLo++;
        }
        return {
          u: cur,
          cost: objective(p, cur, lambda),
          iterations,
          nAtUpper: nUp,
          nAtLower: nLo,
          nPinned: pinList.length,
        };
      }
      state[worst] = 0;
    }
    // 理论上不会到这里；为稳妥返回当前点
    return {
      u: cur,
      cost: objective(p, cur, lambda),
      iterations,
      nAtUpper: 0,
      nAtLower: 0,
      nPinned: pinList.length,
    };
  }

  /** 无约束解（用于对照/诊断）：u = p − H⁻¹p。 */
  function solveUnconstrained(p, lambda) {
    const m = p.length;
    const H = buildH(m, lambda);
    const q = solveBandedFull(H, Float64Array.from(p));
    const u = new Float64Array(m);
    for (let i = 0; i < m; i++) u[i] = p[i] - q[i];
    return u;
  }

  return {
    buildH, buildB, matvec, objective,
    solveBandedFull, solveAxis, solveUnconstrained,
  };
});
