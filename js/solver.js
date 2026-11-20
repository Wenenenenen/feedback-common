/**
 * 普通（非预条件）共轭梯度求解 H X = b，矩阵无关，H 由 model.hMatvec 提供。
 * 从 0 初始化；停止条件 norm(r)/max(norm(b),1e-12) <= tol，或达到 max_iter。
 * 迭代全程不截断；b = 0 直接返回全 0。
 */

import { ETA } from './model.js';

/**
 * @param {ReturnType<import('./model.js').buildModel>} model
 * @param {Float64Array} b
 * @param {number} lambda
 * @param {number} tol       1e-10 .. 1e-2
 * @param {number} maxIter   最多 300
 * @param {object} [opts]
 * @param {{aborted: boolean}} [opts.abortSignal]
 * @param {number} [opts.constY]  Σ_f Σ_q w_q y_q²，用于给出精确目标 J；缺省时数据项少一个常量
 */
export function conjugateGradient(model, b, lambda, tol, maxIter, opts = {}) {
  const N = model.N;
  const history = [];
  const x = new Float64Array(N);

  const bnorm = Math.sqrt(dot(b, b));
  if (bnorm === 0) {
    history.push({ iter: 0, relResidual: 0, dataTerm: 0, regTerm: 0, etaTerm: 0, objective: 0 });
    return { x, history, iterations: 0, stopReason: 'zero-rhs', finalRelResidual: 0 };
  }

  if (!(tol >= 1e-10 && tol <= 1e-2)) throw new Error('tol 必须在 [1e-10, 1e-2] 内');
  if (!(Number.isInteger(maxIter) && maxIter >= 1 && maxIter <= 300)) {
    throw new Error('max_iter 必须为 1..300 的整数');
  }
  if (!(lambda >= 0 && lambda <= 1)) throw new Error('lambda 必须在 [0, 1] 内');

  const r = new Float64Array(b); // r0 = b - H·0 = b
  const p = new Float64Array(r);
  const Hp = new Float64Array(N);
  const Hx = new Float64Array(N);
  const Lx = new Float64Array(N);
  const constY = Number.isFinite(opts.constY) ? opts.constY : 0;
  const haveConstY = Number.isFinite(opts.constY);

  let rr = bnorm * bnorm;
  const denom = Math.max(bnorm, 1e-12);
  let rel = 1;
  history.push({ iter: 0, relResidual: rel, ...objectiveAt(model, x, b, lambda, Hx, Lx, constY, haveConstY) });

  let iter = 0;
  let stopReason = 'max-iter';
  for (; iter < maxIter; iter++) {
    if (opts.abortSignal && opts.abortSignal.aborted) {
      stopReason = 'cancelled';
      break;
    }
    model.hMatvec(p, lambda, Hp);
    const pHp = dot(p, Hp);
    if (!(pHp > 0) || !Number.isFinite(pHp)) {
      stopReason = 'breakdown: pᵀHp 非正定（数值异常）';
      break;
    }
    const alpha = rr / pHp;
    for (let n = 0; n < N; n++) {
      x[n] += alpha * p[n];
      r[n] -= alpha * Hp[n];
    }
    let rrNew = 0;
    for (let n = 0; n < N; n++) rrNew += r[n] * r[n];
    rel = Math.sqrt(rrNew) / denom;
    iter += 1;
    history.push({
      iter,
      relResidual: rel,
      ...objectiveAt(model, x, b, lambda, Hx, Lx, constY, haveConstY),
    });
    if (rel <= tol) {
      stopReason = 'converged';
      break;
    }
    const beta = rrNew / rr;
    for (let n = 0; n < N; n++) p[n] = r[n] + beta * p[n];
    rr = rrNew;
  }

  return { x, history, iterations: iter, stopReason, finalRelResidual: rel };
}

function dot(a, b) {
  let s = 0;
  for (let n = 0; n < a.length; n++) s += a[n] * b[n];
  return s;
}

/**
 * 目标 J = 0.5 Σ w (AX-Y)² + λ/2 Σ_边 (差分)² + η/2 Σ X²。
 * 数据项展开为 0.5 (XᵀΣAᵀWA X − 2bᵀX + ΣwY²)；
 * 未提供 constY 时数据项仅缺与 X 无关的常量，曲线形态与最小点不变，并在字段名上注明。
 */
function objectiveAt(model, x, b, lambda, Hx, Lx, constY, haveConstY) {
  model.hMatvec(x, lambda, Hx);
  const xHx = dot(x, Hx);
  const bx = dot(b, x);
  const xx = dot(x, x);
  model.laplacian(x, Lx);
  const xLx = dot(x, Lx);
  const quadATS = xHx - lambda * xLx - ETA * xx; // Xᵀ ΣAᵀWA X
  const dataTerm = 0.5 * (quadATS - 2 * bx + constY);
  const regTerm = 0.5 * lambda * xLx;
  const etaTerm = 0.5 * ETA * xx;
  return {
    dataTerm,
    dataTermExact: haveConstY,
    regTerm,
    etaTerm,
    objective: dataTerm + regTerm + etaTerm,
  };
}
