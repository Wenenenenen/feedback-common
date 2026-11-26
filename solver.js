'use strict';

/*
 * Anchored tone-curve solver.
 *
 * Curve c[0..4095] contains integers in [0,1023].
 * Slopes d[i] = c[i+1] - c[i] are integers in [0,3], and
 * |d[i+1] - d[i]| <= 1. Locked source bins must take their exact value.
 *
 * The objective is separable by source bin after aggregating pixels:
 *   sum_p w_p * (c[source_p] - target_p)^2
 *
 * A second-order DP over states (curve value, incoming slope) examines every
 * feasible integer curve. For equal cost, each suffix keeps the transition to
 * the smallest possible next value; the starting bin is scanned ascending.
 * This reconstructs the lexicographically smallest globally optimal curve.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ToneCurveSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CURVE_LENGTH = 4096;
  const SOURCE_MAX = 4095;
  const CURVE_MAX = 1023;
  const CURVE_LEVELS = 1024;
  const MAX_LOCKS = 32;
  const SLOPE_MAX = 3;
  const SLOPE_STEP = 1;

  class SolverInputError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'SolverInputError';
      this.code = code;
    }
  }

  function inputError(code, message) {
    return new SolverInputError(code, message);
  }

  function asInteger(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw inputError('invalid_integer', `${label} 必须是整数，收到：${String(value)}`);
    }
    return n;
  }

  function normalizeLocks(locks, options = {}) {
    const bins = options.bins ?? CURVE_LENGTH;
    const maxValue = options.maxValue ?? CURVE_MAX;
    const maxLocks = options.maxLocks ?? MAX_LOCKS;

    if (locks === undefined || locks === null) return [];
    if (!Array.isArray(locks)) {
      throw inputError('invalid_locks', '锁点必须是 [[源值, 曲线值], ...] 数组。');
    }
    if (locks.length > maxLocks) {
      throw inputError('too_many_locks', `锁点最多 ${maxLocks} 个，当前有 ${locks.length} 个。`);
    }

    const byX = new Map();
    const result = [];

    locks.forEach((item, index) => {
      let rawX;
      let rawY;
      let id;

      if (Array.isArray(item)) {
        rawX = item[0];
        rawY = item[1];
        id = index;
      } else if (item && typeof item === 'object') {
        rawX = item.x;
        rawY = item.y;
        id = item.id ?? index;
      } else {
        throw inputError('invalid_locks', `第 ${index + 1} 个锁点格式无效。`);
      }

      const x = asInteger(rawX, '锁点源值');
      const y = asInteger(rawY, '锁点曲线值');

      if (x < 0 || x >= bins) {
        throw inputError('lock_x_out_of_range', `锁点源值 ${x} 超出 0..${bins - 1}。`);
      }
      if (y < 0 || y > maxValue) {
        throw inputError('lock_y_out_of_range', `锁点曲线值 ${y} 超出 0..${maxValue}。`);
      }

      const existing = byX.get(x);
      if (existing) {
        if (existing.y !== y) {
          throw inputError(
            'conflicting_locks',
            `源值 ${x} 同时被锁为 ${existing.y} 和 ${y}，锁点冲突。`,
          );
        }
        return; // Exact duplicate is harmless.
      }

      const lock = { id, x, y };
      byX.set(x, lock);
      result.push(lock);
    });

    result.sort((a, b) => a.x - b.x || a.y - b.y);
    return result;
  }

  function aggregateObservations(source, target, weights = null, bins = CURVE_LENGTH) {
    if (!source || !target) {
      throw inputError('missing_images', '缺少源图或目标图。');
    }
    const pixelCount = source.length;
    if (target.length !== pixelCount) {
      throw inputError('dimension_mismatch', '源图与目标图尺寸/像素数不一致。');
    }
    if (weights && weights.length !== pixelCount) {
      throw inputError('dimension_mismatch', '权重图与源图尺寸/像素数不一致。');
    }

    const weightSum = new Float64Array(bins);
    const weightedTargetSum = new Float64Array(bins);
    const weightedTargetSqSum = new Float64Array(bins);

    let totalWeight = 0;
    let usedPixels = 0;

    for (let i = 0; i < pixelCount; i += 1) {
      const x = source[i];
      const t = target[i];

      if (!Number.isInteger(x) || x < 0 || x >= bins) {
        throw inputError('source_out_of_range', `源图像素 #${i} 的值 ${x} 超出 0..${bins - 1}。`);
      }
      if (!Number.isInteger(t) || t < 0 || t > CURVE_MAX) {
        throw inputError('target_out_of_range', `目标像素 #${i} 的值 ${t} 超出 0..${CURVE_MAX}。`);
      }

      let w = 1;
      if (weights) {
        w = weights[i];
        if (!Number.isFinite(w) || w < 0) {
          throw inputError('invalid_weight', `权重像素 #${i} 不是非负有限数。`);
        }
      }
      if (w === 0) continue;

      const wt = w * t;
      weightSum[x] += w;
      weightedTargetSum[x] += wt;
      weightedTargetSqSum[x] += wt * t;
      totalWeight += w;
      usedPixels += 1;
    }

    return {
      weightSum,
      weightedTargetSum,
      weightedTargetSqSum,
      totalWeight,
      usedPixels,
      pixelCount,
    };
  }

  function formatLock(lock) {
    return `(${lock.x}, ${lock.y})`;
  }

  function diagnoseInfeasibility(options = {}) {
    const bins = options.bins ?? CURVE_LENGTH;
    const maxValue = options.maxValue ?? CURVE_MAX;
    const slopeMax = options.slopeMax ?? SLOPE_MAX;
    const slopeStep = options.slopeStep ?? SLOPE_STEP;

    let locks;
    try {
      locks = options.normalizedLocks || normalizeLocks(options.locks, { bins, maxValue });
    } catch (error) {
      return {
        feasible: false,
        code: error.code || 'invalid_locks',
        message: error.message,
      };
    }

    const lockY = new Int32Array(bins).fill(-1);
    const lockByX = new Map();
    for (const lock of locks) {
      lockY[lock.x] = lock.y;
      lockByX.set(lock.x, lock);
    }

    const pairFailure = (a, b, reason) => ({
      feasible: false,
      code: 'infeasible_locks',
      reason,
      failedLock: b || null,
      relatedLock: a || null,
      message: `无解：锁点无法同时满足。${reason}`,
    });

    for (let i = 1; i < locks.length; i += 1) {
      const a = locks[i - 1];
      const b = locks[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dy < 0) {
        return pairFailure(
          a,
          b,
          `锁点 ${formatLock(a)} 到 ${formatLock(b)} 需要下降 ${-dy}，但斜率只允许 ${0}..${slopeMax}，曲线必须非递减。`,
        );
      }
      if (dy > slopeMax * dx) {
        return pairFailure(
          a,
          b,
          `锁点 ${formatLock(a)} 到 ${formatLock(b)} 相距 ${dx} 档却要上升 ${dy}，超过每档最多上升 ${slopeMax}。`,
        );
      }
    }

    if (bins <= 1) {
      return { feasible: true };
    }

    const slopeCount = slopeMax + 1;
    const stateCount = (maxValue + 1) * slopeCount;
    let reach = new Uint8Array(stateCount);

    // Initialize states at bin 1 by choosing c[0] and the first slope.
    for (let y0 = 0; y0 <= maxValue; y0 += 1) {
      if (lockY[0] !== -1 && y0 !== lockY[0]) continue;
      for (let t = 0; t <= slopeMax; t += 1) {
        const y1 = y0 + t;
        if (y1 > maxValue) continue;
        if (lockY[1] !== -1 && y1 !== lockY[1]) continue;
        reach[y1 * slopeCount + t] = 1;
      }
    }

    const hasState = (arr) => {
      for (let i = 0; i < arr.length; i += 1) if (arr[i]) return true;
      return false;
    };

    const failureAt = (x) => {
      const failedLock = lockByX.get(x) || null;
      let previous = null;
      for (const lock of locks) {
        if (lock.x < x) previous = lock;
        else break;
      }

      let reason;
      if (failedLock && previous) {
        reason = `锁点 ${formatLock(failedLock)} 无法与此前的 ${formatLock(previous)} 等锁点连接：每档斜率须为 0..${slopeMax}，相邻两段斜率之差还不能超过 ${slopeStep}。`;
      } else if (failedLock) {
        reason = `锁点 ${formatLock(failedLock)} 无法在给定斜率与斜率变化限制下到达。`;
      } else if (previous) {
        reason = `从锁点 ${formatLock(previous)} 出发后，曲线在源值 ${x} 附近已无法同时满足值域上界、斜率 0..${slopeMax} 和斜率变化 ≤${slopeStep}。`;
      } else {
        reason = `曲线在源值 ${x} 附近无法满足值域上界、斜率 0..${slopeMax} 和斜率变化 ≤${slopeStep}。`;
      }

      return {
        feasible: false,
        code: 'infeasible_locks',
        atX: x,
        failedLock,
        relatedLock: previous,
        message: `无解：这些锁点无法同时满足全部约束。${reason}`,
      };
    };

    if (!hasState(reach)) return failureAt(1);

    let next = new Uint8Array(stateCount);

    for (let i = 1; i < bins - 1; i += 1) {
      next.fill(0);

      for (let y = 0; y <= maxValue; y += 1) {
        for (let s = 0; s <= slopeMax; s += 1) {
          const stateIndex = y * slopeCount + s;
          if (!reach[stateIndex]) continue;

          const low = Math.max(0, s - slopeStep);
          const high = Math.min(slopeMax, s + slopeStep);

          for (let t = low; t <= high; t += 1) {
            const ny = y + t;
            if (ny > maxValue) continue;
            if (lockY[i + 1] !== -1 && ny !== lockY[i + 1]) continue;
            next[ny * slopeCount + t] = 1;
          }
        }
      }

      const tmp = reach;
      reach = next;
      next = tmp;

      if (!hasState(reach)) return failureAt(i + 1);
    }

    return { feasible: true };
  }

  function solveAnchoredCurve(options = {}) {
    const bins = options.bins ?? CURVE_LENGTH;
    const maxValue = options.maxValue ?? CURVE_MAX;
    const slopeMax = options.slopeMax ?? SLOPE_MAX;
    const slopeStep = options.slopeStep ?? SLOPE_STEP;
    const slopeCount = slopeMax + 1;
    const stateCount = (maxValue + 1) * slopeCount;

    let locks;
    try {
      locks = normalizeLocks(options.locks, { bins, maxValue });
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'invalid_locks',
        error: error.message,
        message: error.message,
      };
    }

    let weightSum = options.weightSum;
    let weightedTargetSum = options.weightedTargetSum;
    let weightedTargetSqSum = options.weightedTargetSqSum;
    let aggregate = null;

    if ((!weightSum || !weightedTargetSum) && options.source) {
      aggregate = aggregateObservations(
        options.source,
        options.target,
        options.weights ?? null,
        bins,
      );
      weightSum = aggregate.weightSum;
      weightedTargetSum = aggregate.weightedTargetSum;
      weightedTargetSqSum = aggregate.weightedTargetSqSum;
    }

    const W = weightSum || null;
    const A = weightedTargetSum || null;
    const Q = weightedTargetSqSum || null;

    function unaryCost(i, y) {
      const w = W ? W[i] : 0;
      const a = A ? A[i] : 0;
      return w * y * y - 2 * a * y;
    }

    const lockY = new Int32Array(bins).fill(-1);
    for (const lock of locks) lockY[lock.x] = lock.y;

    // A one-bin curve has no slope constraints.
    if (bins === 1) {
      let bestCost = Infinity;
      let bestY = -1;
      for (let y = 0; y <= maxValue; y += 1) {
        if (lockY[0] !== -1 && y !== lockY[0]) continue;
        const cost = unaryCost(0, y);
        if (cost < bestCost) {
          bestCost = cost;
          bestY = y;
        }
      }

      if (bestY < 0) {
        const diagnosis = diagnoseInfeasibility({
          bins, maxValue, slopeMax, slopeStep, normalizedLocks: locks,
        });
        return { ok: false, locks, ...diagnosis };
      }

      const meta = aggregate || {
        totalWeight: options.totalWeight ?? null,
        usedPixels: options.usedPixels ?? null,
        pixelCount: options.pixelCount ?? null,
      };
      const curve = [bestY];
      return finalizeResult(curve, locks, { W, A, Q, aggregate: meta, bins, maxValue, slopeMax, slopeStep });
    }

    // decisions[i * stateCount + y * slopeCount + s] = chosen next slope t.
    // 255 means no transition / unreachable.
    const decisions = new Uint8Array(bins * stateCount);
    let nextCost = new Float64Array(stateCount);
    let currentCost = new Float64Array(stateCount);
    const INF = Number.POSITIVE_INFINITY;

    for (let i = bins - 1; i >= 1; i -= 1) {
      currentCost.fill(INF);
      const decisionBase = i * stateCount;
      const lockedY = lockY[i];
      const isTerminal = i === bins - 1;

      for (let y = 0; y <= maxValue; y += 1) {
        if (lockedY !== -1 && y !== lockedY) continue;

        const u = unaryCost(i, y);

        for (let s = 0; s <= slopeMax; s += 1) {
          // A state at bin i with incoming slope s must have c[i-1] = y-s >= 0.
          if (y < s) continue;

          const stateIndex = y * slopeCount + s;
          let bestSuffix = INF;
          let bestT = 255;

          if (isTerminal) {
            bestSuffix = u;
            bestT = 254; // terminal marker; not used during reconstruction
          } else {
            const low = Math.max(0, s - slopeStep);
            const high = Math.min(slopeMax, s + slopeStep);

            // Ascending t means ascending c[i+1]; strict comparison keeps the
            // smallest next value on equal suffix cost.
            for (let t = low; t <= high; t += 1) {
              const nextY = y + t;
              if (nextY > maxValue) continue;
              const candidate = nextCost[nextY * slopeCount + t];
              if (candidate < bestSuffix) {
                bestSuffix = candidate;
                bestT = t;
              }
            }

            if (bestT !== 255) bestSuffix += u;
            else bestSuffix = INF;
          }

          currentCost[stateIndex] = bestSuffix;
          decisions[decisionBase + stateIndex] = bestT;
        }
      }

      const tmp = nextCost;
      nextCost = currentCost;
      currentCost = tmp;
    }

    let globalBest = INF;
    let startY = -1;
    let startT = -1;

    // Ascending y0 with strict updates gives the smallest c[0] among global ties.
    for (let y0 = 0; y0 <= maxValue; y0 += 1) {
      if (lockY[0] !== -1 && y0 !== lockY[0]) continue;

      const u0 = unaryCost(0, y0);
      let bestForY0 = INF;
      let bestTForY0 = -1;

      for (let t = 0; t <= slopeMax; t += 1) {
        const y1 = y0 + t;
        if (y1 > maxValue) continue;
        const candidate = u0 + nextCost[y1 * slopeCount + t];
        if (candidate < bestForY0) {
          bestForY0 = candidate;
          bestTForY0 = t;
        }
      }

      if (bestForY0 < globalBest) {
        globalBest = bestForY0;
        startY = y0;
        startT = bestTForY0;
      }
    }

    if (startY < 0 || !Number.isFinite(globalBest)) {
      const diagnosis = diagnoseInfeasibility({
        bins, maxValue, slopeMax, slopeStep, normalizedLocks: locks,
      });
      return { ok: false, locks, ...diagnosis };
    }

    const curve = new Array(bins);
    curve[0] = startY;
    let y = startY;
    let s = startT;

    if (startT < 0 || startT > slopeMax) {
      return {
        ok: false,
        code: 'internal_dp_error',
        message: '动态规划重建失败：找不到起始斜率。',
      };
    }

    y = startY + startT;
    s = startT;
    curve[1] = y;

    for (let i = 1; i < bins - 1; i += 1) {
      const stateIndex = y * slopeCount + s;
      const t = decisions[i * stateCount + stateIndex];
      if (!Number.isInteger(t) || t < 0 || t > slopeMax) {
        return {
          ok: false,
          code: 'internal_dp_error',
          message: `动态规划重建失败：在源值 ${i} 处缺少可行后继。`,
        };
      }
      y += t;
      s = t;
      curve[i + 1] = y;
    }

    const meta = aggregate || {
      totalWeight: options.totalWeight ?? null,
      usedPixels: options.usedPixels ?? null,
      pixelCount: options.pixelCount ?? null,
    };

    return finalizeResult(curve, locks, {
      W, A, Q, aggregate: meta, bins, maxValue, slopeMax, slopeStep,
      optimalVariableCost: globalBest,
    });
  }

  function scoreCurve(curve, options = {}) {
    const W = options.weightSum || null;
    const A = options.weightedTargetSum || null;
    const Q = options.weightedTargetSqSum || null;
    const bins = curve.length;

    let variableCost = 0;
    let weightedSquaredError = 0;

    for (let x = 0; x < bins; x += 1) {
      const y = curve[x];
      const w = W ? W[x] : 0;
      const a = A ? A[x] : 0;
      const q = Q ? Q[x] : 0;
      const variable = w * y * y - 2 * a * y;
      variableCost += variable;
      weightedSquaredError += variable + q;
    }

    return { variableCost, weightedSquaredError };
  }

  function analyzeCurve(curve, options = {}) {
    const slopeMax = options.slopeMax ?? SLOPE_MAX;
    const slopeStep = options.slopeStep ?? SLOPE_STEP;
    const locks = options.locks
      ? normalizeLocks(options.locks, {
        bins: curve.length,
        maxValue: options.maxValue ?? CURVE_MAX,
      })
      : [];

    const slopes = new Array(Math.max(0, curve.length - 1));
    let minValue = Infinity;
    let maxValue = -Infinity;
    let minSlope = Infinity;
    let maxSlope = -Infinity;
    let maxSlopeJump = 0;
    const slopeViolations = [];

    for (let i = 0; i < curve.length; i += 1) {
      const y = curve[i];
      if (y < minValue) minValue = y;
      if (y > maxValue) maxValue = y;

      if (i < curve.length - 1) {
        const d = curve[i + 1] - y;
        slopes[i] = d;
        if (d < minSlope) minSlope = d;
        if (d > maxSlope) maxSlope = d;
        if (d < 0 || d > slopeMax) {
          slopeViolations.push({ index: i, slope: d });
        }
        if (i > 0) {
          const jump = Math.abs(d - slopes[i - 1]);
          if (jump > maxSlopeJump) maxSlopeJump = jump;
        }
      }
    }

    const lockMismatches = [];
    for (const lock of locks) {
      if (curve[lock.x] !== lock.y) {
        lockMismatches.push({ ...lock, actual: curve[lock.x] });
      }
    }

    return {
      length: curve.length,
      minValue,
      maxValue,
      minSlope: curve.length > 1 ? minSlope : null,
      maxSlope: curve.length > 1 ? maxSlope : null,
      maxSlopeJump: curve.length > 2 ? maxSlopeJump : 0,
      slopeViolations,
      lockMismatches,
      feasible: slopeViolations.length === 0
        && lockMismatches.length === 0
        && maxSlopeJump <= slopeStep,
    };
  }

  function finalizeResult(curve, locks, context) {
    const {
      W, A, Q, aggregate, bins, maxValue, slopeMax, slopeStep,
      optimalVariableCost,
    } = context;

    const analysis = analyzeCurve(curve, { locks, maxValue, slopeMax, slopeStep });
    const score = scoreCurve(curve, { weightSum: W, weightedTargetSum: A, weightedTargetSqSum: Q });

    return {
      ok: true,
      code: 'optimal',
      curve,
      locks,
      analysis,
      objectiveVariable: Number.isFinite(optimalVariableCost)
        ? optimalVariableCost
        : score.variableCost,
      weightedSquaredError: score.weightedSquaredError,
      totalWeight: aggregate?.totalWeight ?? null,
      usedPixels: aggregate?.usedPixels ?? null,
      pixelCount: aggregate?.pixelCount ?? null,
    };
  }

  return {
    CURVE_LENGTH,
    SOURCE_MAX,
    CURVE_MAX,
    CURVE_LEVELS,
    MAX_LOCKS,
    SLOPE_MAX,
    SLOPE_STEP,
    SolverInputError,
    normalizeLocks,
    aggregateObservations,
    solveAnchoredCurve,
    diagnoseInfeasibility,
    scoreCurve,
    analyzeCurve,
  };
});
