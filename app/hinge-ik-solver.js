// hinge-ik-solver.js — 铰链骨架逆运动学求解器 (无第三方依赖)
// 模型与 tools/solver_proto.py 完全一致:
//   W_j = W_parent * T(offset) * R(axis, angle); 根父矩阵为单位阵
//   cost = sum_e w_e |p_e - target_e|^2 + lambda * sum_j (theta_j - rest_j)^2 (弧度, 含锁定常量)
// 方法: Levenberg-Marquardt 阻尼高斯-牛顿 + 盒约束投影 + 投影梯度停滞检测
// 全部运算确定, 无 Math.random / Date, 同一初值逐位一致。
"use strict";

const DEG = Math.PI / 180;

// ---------- 3x4 齐次变换 (4x4 存储, 末行固定 0,0,0,1) ----------
function I4() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mul(a, b) {
  const c = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      c[i * 4 + j] = s;
    }
  }
  return c;
}
function trans(v) {
  const m = I4();
  m[3] = v[0]; m[7] = v[1]; m[11] = v[2];
  return m;
}
function rot(axis, ang) {
  const [x, y, z] = axis;
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s, 0,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s, 0,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C, 0,
    0, 0, 0, 1,
  ];
}
function tpoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}
function tvec(m, v) {
  const [x, y, z] = v;
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[4] * x + m[5] * y + m[6] * z,
    m[8] * x + m[9] * y + m[10] * z,
  ];
}

// ---------- Cholesky 求解 A x = b (A 对称正定) ----------
function choleskySolve(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];
      if (i === j) {
        const v = A[i][i] - s;
        if (!(v > 1e-14)) throw new Error("matrix not positive definite");
        L[i][j] = Math.sqrt(v);
      } else {
        L[i][j] = (A[i][j] - s) / L[j][j];
      }
    }
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < i; k++) s += L[i][k] * y[k];
    y[i] = (b[i] - s) / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = 0;
    for (let k = i + 1; k < n; k++) s += L[k][i] * x[k];
    x[i] = (y[i] - s) / L[i][i];
  }
  return x;
}

// ---------- 模型 ----------
class KinModel {
  constructor(caseObj) {
    const joints = caseObj.joints;
    const byId = Object.fromEntries(joints.map((j) => [j.id, j]));
    const ordered = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      const j = byId[id];
      if (j.parent !== null && j.parent !== undefined) visit(j.parent);
      seen.add(id);
      ordered.push(j);
    };
    joints.forEach((j) => visit(j.id));
    this.joints = ordered;
    this.n = ordered.length;
    this.index = Object.fromEntries(ordered.map((j, i) => [j.id, i]));
    this.effectors = caseObj.effectors.map((e) => ({ ...e }));
    this.lam = Number(caseObj.regularization || 0);
    this.tol = Number(caseObj.positionTolerance ?? 0.01);
    this.maxIter = Number(caseObj.maxIterations || 2000);
    this.theta = ordered.map((j) => j.angle * DEG);
    this.rest = ordered.map((j) => j.rest * DEG);
    this.lo = ordered.map((j) => j.min * DEG);
    this.hi = ordered.map((j) => j.max * DEG);
    this.locked = ordered.map((j) => !!j.locked);
    this.free = [];
    for (let i = 0; i < this.n; i++) if (!this.locked[i]) this.free.push(i);
    this.anc = this.effectors.map((e) => {
      const set = new Set();
      let k = this.index[e.joint];
      for (;;) {
        set.add(k);
        const pj = this.joints[k].parent;
        if (pj === null || pj === undefined) break;
        k = this.index[pj];
      }
      return set;
    });
  }

  // 正向运动学: 返回关节世界矩阵、关节原点(旋转前)、世界轴、末端世界点
  fk(theta) {
    theta = theta || this.theta;
    const W = new Array(this.n);
    const origin = new Array(this.n);
    const axisW = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const j = this.joints[i];
      const Wp = j.parent === null || j.parent === undefined ? I4() : W[this.index[j.parent]];
      const M = mul(Wp, trans(j.offset));
      W[i] = mul(M, rot(j.axis, theta[i]));
      origin[i] = [M[3], M[7], M[11]];
      axisW[i] = tvec(M, j.axis);
    }
    const pts = this.effectors.map((e) => tpoint(W[this.index[e.joint]], e.point));
    return { W, origin, axisW, pts };
  }

  costs(theta) {
    const { pts } = this.fk(theta);
    let pos = 0;
    const errs = [];
    for (let ei = 0; ei < this.effectors.length; ei++) {
      const e = this.effectors[ei];
      const p = pts[ei];
      let d2 = 0;
      for (let k = 0; k < 3; k++) d2 += (p[k] - e.target[k]) ** 2;
      const d = Math.sqrt(d2);
      errs.push(d);
      pos += Number(e.weight) * d2;
    }
    let reg = 0;
    for (let i = 0; i < this.n; i++) reg += (theta[i] - this.rest[i]) ** 2;
    reg *= this.lam;
    return { pos, reg, total: pos + reg, errs };
  }
}

// ---------- LM 求解 ----------
const FTOL = 1e-12;
const GTOL = 1e-10;
const MU_INIT = 1e-3, MU_DOWN = 0.5, MU_UP = 4, MU_MAX = 1e12, MU_MIN = 1e-14;

function logRow(it, errs, pos, reg, total, mu, step) {
  return {
    iteration: it,
    effectorErrors: errs.map((d) => Number(d.toPrecision(12))),
    positionCost: pos, regCost: reg, totalCost: total, mu, stepNorm: step,
  };
}

// 增量 LM 迭代器: next() 执行一轮完整外层迭代 (含内层阻尼接受/拒绝),
// 单步与一次性求解共用同一条代码路径, 保证结果一致。
class IKIterator {
  constructor(model, theta0) {
    this.model = model;
    this.theta = (theta0 ? theta0.slice() : model.theta.slice());
    for (const i of model.free)
      this.theta[i] = Math.min(Math.max(this.theta[i], model.lo[i]), model.hi[i]);
    this.it = 0;
    this.mu = MU_INIT;
    this.status = "idle";
    this.reason = "";
    this.done = false;
    const c = model.costs(this.theta);
    this.pos = c.pos; this.reg = c.reg; this.total = c.total; this.errs = c.errs;
    this.reached = c.errs.every((d) => d < model.tol);
    if (model.free.length === 0) {
      this.done = true;
      this.status = this.reached ? "converged" : "stalled";
      this.reason = "所有关节均已锁定, 没有可优化自由度";
    } else if (this.reached) {
      this.done = true;
      this.status = "converged";
      this.reason = "初始姿态已满足位置容差";
    }
  }

  next() {
    if (this.done) return this._snapshot();
    const model = this.model;
    const theta = this.theta;
    this.it++;
    const { origin, axisW, pts } = model.fk(theta);
    const nf = model.free.length;
    const ne = model.effectors.length;
    const m = 3 * ne + nf;
    const J = Array.from({ length: m }, () => new Array(nf).fill(0));
    const r = new Array(m).fill(0);
    for (let ei = 0; ei < ne; ei++) {
      const e = model.effectors[ei];
      const ws = Math.sqrt(Number(e.weight));
      const p = pts[ei];
      for (let k = 0; k < 3; k++) r[3 * ei + k] = ws * (p[k] - e.target[k]);
      for (let col = 0; col < nf; col++) {
        const jidx = model.free[col];
        if (!model.anc[ei].has(jidx)) continue;
        const ax = axisW[jidx];
        const rel = [p[0] - origin[jidx][0], p[1] - origin[jidx][1], p[2] - origin[jidx][2]];
        const jac = [
          ax[1] * rel[2] - ax[2] * rel[1],
          ax[2] * rel[0] - ax[0] * rel[2],
          ax[0] * rel[1] - ax[1] * rel[0],
        ];
        for (let k = 0; k < 3; k++) J[3 * ei + k][col] = ws * jac[k];
      }
    }
    for (let col = 0; col < nf; col++) {
      const jidx = model.free[col];
      r[3 * ne + col] = Math.sqrt(model.lam) * (theta[jidx] - model.rest[jidx]);
      J[3 * ne + col][col] = Math.sqrt(model.lam);
    }
    const n = nf;
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let row = 0; row < m; row++) {
        const Ja = J[row][a];
        if (Ja === 0) continue;
        Jtr[a] += Ja * r[row];
        for (let b = a; b < n; b++) {
          const Jb = J[row][b];
          if (Jb !== 0) JtJ[a][b] += Ja * Jb;
        }
      }
    }
    for (let a = 0; a < n; a++)
      for (let b = 0; b < a; b++) JtJ[b][a] = JtJ[a][b];

    let gnorm = 0;
    for (let col = 0; col < nf; col++) {
      const jidx = model.free[col];
      const g = Jtr[col];
      const atLo = theta[jidx] <= model.lo[jidx] + 1e-13;
      const atHi = theta[jidx] >= model.hi[jidx] - 1e-13;
      const active = (!atLo || g < 0) && (!atHi || g > 0);
      if (active) gnorm = Math.max(gnorm, Math.abs(g));
    }
    if (gnorm <= GTOL) {
      this._finish("stalled", "投影梯度接近零: 已到约束局部最优 (该目标在当前关节限位下不可达)");
      return this._snapshot();
    }

    let accepted = false;
    let stepNorm = 0;
    let relChange = 0;
    let mu = this.mu;
    while (mu <= MU_MAX) {
      const A = JtJ.map((row) => row.slice());
      for (let a = 0; a < n; a++) A[a][a] += mu * Math.max(JtJ[a][a], 1e-12);
      let dx;
      try {
        dx = choleskySolve(A, Jtr.map((v) => -v));
      } catch (e) {
        mu *= MU_UP;
        continue;
      }
      const trial = theta.slice();
      for (let col = 0; col < nf; col++) {
        const jidx = model.free[col];
        trial[jidx] = Math.min(Math.max(theta[jidx] + dx[col], model.lo[jidx]), model.hi[jidx]);
      }
      let sd = 0;
      for (const i of model.free) sd += (trial[i] - theta[i]) ** 2;
      stepNorm = Math.sqrt(sd);
      const tc = model.costs(trial);
      if (tc.total < this.total) {
        relChange = (this.total - tc.total) / Math.max(1, Math.abs(this.total));
        for (let i = 0; i < this.theta.length; i++) this.theta[i] = trial[i];
        this.pos = tc.pos; this.reg = tc.reg; this.total = tc.total; this.errs = tc.errs;
        mu = Math.max(MU_MIN, mu * MU_DOWN);
        accepted = true;
        this.reached = tc.errs.every((d) => d < model.tol);
        if (this.reached && relChange <= FTOL) {
          this._finish("converged", "全部末端位置误差低于容差且代价变化收敛");
        } else if (stepNorm <= 1e-13 && relChange <= FTOL) {
          this._finish("stalled", "步长下溢, 无法继续下降");
        }
        break;
      }
      mu *= MU_UP;
    }
    this.mu = mu;
    this.stepNorm = stepNorm;
    if (!this.done) {
      if (!accepted) {
        this._finish("stalled", "找不到下降方向: 约束局部最优或目标在关节限位下不可达");
      } else if (this.it >= model.maxIter) {
        this._finish("max_iterations", "达到最大迭代次数仍未满足位置容差");
      }
    }
    return this._snapshot();
  }

  _finish(status, reason) {
    this.done = true;
    this.status = status;
    this.reason = reason;
    if (status === "converged") this.reached = true;
    if (status !== "converged" && this.reached === false) {
      // 保持 reached 由误差判定
    }
    // 任何结束状态下, reached 完全由当前误差决定
    this.reached = this.errs.every((d) => d < this.model.tol);
    if (status === "converged" && !this.reached) this.status = "stalled";
  }

  _snapshot() {
    return {
      iteration: this.it, theta: this.theta.slice(), done: this.done,
      status: this.status, reason: this.reason, reached: this.reached,
      errors: this.errs.slice(), positionCost: this.pos, regCost: this.reg,
      totalCost: this.total, mu: this.mu,
      stepNorm: this.stepNorm || 0,
    };
  }
}

// 一次性完整求解 (基于迭代器), 保留与历史版本一致的返回结构。
function solve(model, theta0, recordLog = true) {
  const it = new IKIterator(model, theta0);
  const c0 = model.costs(it.theta);
  const log = recordLog
    ? [logRow(0, c0.errs, c0.pos, c0.reg, c0.total, it.mu, 0)]
    : [];
  let snap = it._snapshot();
  while (!it.done) {
    snap = it.next();
    if (recordLog) log.push(logRow(snap.iteration, snap.errors, snap.positionCost, snap.regCost, snap.totalCost, snap.mu, snap.stepNorm));
  }
  return {
    theta: snap.theta, status: snap.status, reason: snap.reason,
    iterations: snap.iteration, reached: snap.reached, errors: snap.errors,
    positionCost: snap.positionCost, regCost: snap.regCost, totalCost: snap.totalCost, log,
  };
}

// 仅推进一个 LM 外层迭代, 供 UI 单步按钮使用。
function stepOnce(model, theta) {
  const it = new IKIterator(model, theta);
  const snap = it.next();
  return {
    theta: snap.theta, done: snap.done, status: snap.status,
    reason: snap.reason, iteration: snap.iteration, mu: snap.mu,
    costs: { pos: snap.positionCost, reg: snap.regCost, total: snap.totalCost, errs: snap.errors },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { KinModel, IKIterator, solve, stepOnce, determinismCheck, choleskySolve, DEG, I4, mul, trans, rot, tpoint, tvec };
}

// 同一初值独立求解两次, 逐位比对角度与每轮记录; 完全一致才返回 identical=true。
// 全程不使用任何随机源或时钟, 因此结果必须恒等。
function determinismCheck(model) {
  const theta0 = model.theta.slice();
  const a = solve(model, theta0.slice(), true);
  const b = solve(model, theta0.slice(), true);
  const sameTheta = a.theta.every((v, i) => v === b.theta[i]);
  const sameLog = JSON.stringify(a.log) === JSON.stringify(b.log);
  const sameStatus = a.status === b.status && a.iterations === b.iterations;
  return {
    identical: sameTheta && sameLog && sameStatus,
    iterations: a.iterations,
    status: a.status,
    firstThetaDeg: a.theta.map((t) => t / DEG),
  };
}
