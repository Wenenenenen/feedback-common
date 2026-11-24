/*
 * 拟合：参数校验 → 冲突分类 → 逐镜头逐轴求解 → 逐帧偏移装配与统计。
 *
 * 每镜头、每轴独立最小化
 *   Σ_t u_t² + λ·Σ_t (q_{t-1} − 2q_t + q_{t+1})²，q = p − u
 * 约束 |u_t| ≤ (源边长 − 输出边长)/2 − margin，以及 pins 指定的固定帧。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAPFit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const QP = typeof require === 'function' && typeof module === 'object' && module.exports
    ? require('./qp.js')
    : (typeof globalThis !== 'undefined' ? globalThis.SAPQp : null);

  const REASONS = {
    CROP_INVALID: 'crop_invalid',
    MARGIN_INVALID: 'margin_invalid',
    LAMBDA_INVALID: 'lambda_invalid',
    NEGATIVE_BOUND: 'negative_bound',
    PIN_OUT_OF_RANGE: 'pin_out_of_range',
    PIN_OUT_OF_FRAME: 'pin_out_of_frame',
    NO_DATA: 'no_data',
    NUMERIC: 'numeric',
  };

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function fmtNum(v) { return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }

  /**
   * 校验参数并计算每轴允许范围。
   * pins: [{frame, x, y}]（帧号从零起）。
   */
  function validateConfig(cfg, W, H, frameCount) {
    const errors = [];
    const { cropW, cropH, margin, lambda, pins } = cfg;
    if (!isInt(cropW) || !isInt(cropH) || cropW < 1 || cropH < 1) {
      errors.push({ reason: REASONS.CROP_INVALID, path: 'crop', message: '输出宽高必须是正整数' });
    } else if (cropW > W || cropH > H) {
      errors.push({
        reason: REASONS.CROP_INVALID, path: 'crop',
        message: `输出画幅 ${cropW}×${cropH} 超过源尺寸 ${W}×${H}`,
      });
    }
    if (!isInt(margin) || margin < 0) {
      errors.push({ reason: REASONS.MARGIN_INVALID, path: 'margin', message: '安全边距必须是非负整数' });
    }
    if (!isFiniteNum(lambda) || lambda < 0 || lambda > 10000) {
      errors.push({ reason: REASONS.LAMBDA_INVALID, path: 'lambda', message: '平滑强度必须在 0…10000 之间' });
    }
    if (errors.length) return { ok: false, errors, boundX: NaN, boundY: NaN };

    const boundX = (W - cropW) / 2 - margin;
    const boundY = (H - cropH) / 2 - margin;
    if (boundX < 0 || boundY < 0) {
      const axes = [];
      if (boundX < 0) axes.push(`横向 ${fmtNum(boundX)}`);
      if (boundY < 0) axes.push(`纵向 ${fmtNum(boundY)}`);
      const axisLabel = (boundX < 0 && boundY < 0) ? '横纵' : (boundX < 0 ? '横向' : '纵向');
      errors.push({
        reason: REASONS.NEGATIVE_BOUND,
        path: 'margin',
        message: `${axisLabel}允许范围 ${axes.join('、')} 小于 0：画幅与边距之和超出源画幅，`
          + `请减小输出宽高或安全边距（当前余量 x ${fmtNum((W - cropW) / 2)}、y ${fmtNum((H - cropH) / 2)}，边距 ${margin}）`,
        boundX, boundY,
      });
    }

    const pinList = Array.isArray(pins) ? pins : [];
    for (let i = 0; i < pinList.length; i++) {
      const p = pinList[i];
      if (!p || p.frame < 0 || p.frame >= frameCount || !isInt(p.frame)) {
        errors.push({
          reason: REASONS.PIN_OUT_OF_FRAME, path: `pins[${i}].frame`,
          message: `固定帧 ${p && p.frame} 超出 0…${frameCount - 1}`,
        });
        continue;
      }
      if (!isFiniteNum(p.x) || !isFiniteNum(p.y)) {
        errors.push({ reason: REASONS.PIN_OUT_OF_RANGE, path: `pins[${i}]`, message: '固定偏移必须是有限数' });
        continue;
      }
      if (Math.abs(p.x) > boundX + 1e-12) {
        errors.push({
          reason: REASONS.PIN_OUT_OF_RANGE, path: `pins[${i}]`, axis: 'x', frame: p.frame,
          message: `第 ${p.frame} 帧固定横向偏移 ${p.x} 超出允许范围 ±${boundX}`
            + `（余量 (${W}−${cropW})/2 = ${(W - cropW) / 2}，边距 ${margin}）`,
          limit: boundX, value: p.x,
        });
      }
      if (Math.abs(p.y) > boundY + 1e-12) {
        errors.push({
          reason: REASONS.PIN_OUT_OF_RANGE, path: `pins[${i}]`, axis: 'y', frame: p.frame,
          message: `第 ${p.frame} 帧固定纵向偏移 ${p.y} 超出允许范围 ±${boundY}`,
          limit: boundY, value: p.y,
        });
      }
    }
    return {
      ok: errors.length === 0,
      errors,
      boundX,
      boundY,
    };
  }

  /**
   * 求解全部镜头。
   * @param tracking  track() 的结果
   * @param W,H       源尺寸
   * @param cfg       {cropW, cropH, margin, lambda, pins}
   * @returns {{ok:boolean, errors, params, boundX, boundY, shots, ux, uy, totals}}
   *   失败时仍返回 params 与 boundX/boundY（若可算）供界面解释。
   */
  function fit(tracking, W, H, cfg) {
    const frameCount = tracking.p[0].length;
    const params = {
      cropW: cfg.cropW, cropH: cfg.cropH, margin: cfg.margin,
      lambda: cfg.lambda, pins: (cfg.pins || []).map((p) => ({ frame: p.frame, x: p.x, y: p.y })),
    };
    const v = validateConfig(params, W, H, frameCount);
    if (!v.ok) {
      return {
        ok: false, errors: v.errors, params,
        boundX: v.boundX, boundY: v.boundY,
        shots: [], ux: new Float64Array(0), uy: new Float64Array(0), totals: null,
      };
    }
    const { boundX, boundY } = v;
    const lambda = params.lambda;
    const pinByFrame = new Map();
    for (const p of params.pins) pinByFrame.set(p.frame, p);

    const ux = new Float64Array(frameCount);
    const uy = new Float64Array(frameCount);
    const shotsOut = [];
    let costX = 0;
    let costY = 0;
    let iterations = 0;
    let maxAbsX = 0;
    let maxAbsY = 0;
    let nAtBoundX = 0;
    let nAtBoundY = 0;
    let nPinnedX = 0;
    let nPinnedY = 0;

    try {
      for (const s of tracking.shots) {
        const m = s.end - s.start;
        const pX = new Float64Array(m);
        const pY = new Float64Array(m);
        const px = tracking.p[0];
        const py = tracking.p[1];
        for (let i = 0; i < m; i++) { pX[i] = px[s.start + i]; pY[i] = py[s.start + i]; }
        const pinsX = [];
        const pinsY = [];
        for (const [frame, p] of pinByFrame) {
          if (frame >= s.start && frame < s.end) {
            pinsX.push({ index: frame - s.start, value: p.x });
            pinsY.push({ index: frame - s.start, value: p.y });
          }
        }
        pinsX.sort((a, b) => a.index - b.index);
        pinsY.sort((a, b) => a.index - b.index);
        const rx = QP.solveAxis(pX, lambda, boundX, pinsX);
        const ry = QP.solveAxis(pY, lambda, boundY, pinsY);
        let shotMaxX = 0;
        let shotMaxY = 0;
        for (let i = 0; i < m; i++) {
          const ax = Math.abs(rx.u[i]);
          const ay = Math.abs(ry.u[i]);
          if (ax > shotMaxX) shotMaxX = ax;
          if (ay > shotMaxY) shotMaxY = ay;
          ux[s.start + i] = rx.u[i];
          uy[s.start + i] = ry.u[i];
        }
        if (shotMaxX > maxAbsX) maxAbsX = shotMaxX;
        if (shotMaxY > maxAbsY) maxAbsY = shotMaxY;
        costX += rx.cost;
        costY += ry.cost;
        iterations += rx.iterations + ry.iterations;
        nAtBoundX += rx.nAtUpper + rx.nAtLower;
        nAtBoundY += ry.nAtUpper + ry.nAtLower;
        nPinnedX += rx.nPinned;
        nPinnedY += ry.nPinned;
        shotsOut.push({
          index: shotsOut.length,
          start: s.start,
          end: s.end,
          frames: m,
          maxAbsX: shotMaxX,
          maxAbsY: shotMaxY,
          costX: rx.cost,
          costY: ry.cost,
          iterations: rx.iterations + ry.iterations,
          nAtBoundX: rx.nAtUpper + rx.nAtLower,
          nAtBoundY: ry.nAtUpper + ry.nAtLower,
        });
      }
    } catch (err) {
      return {
        ok: false,
        errors: [{ reason: REASONS.NUMERIC, path: 'solver', message: `求解失败：${err.message}` }],
        params, boundX, boundY, shots: [], ux: new Float64Array(0), uy: new Float64Array(0), totals: null,
      };
    }

    return {
      ok: true,
      errors: [],
      params,
      boundX,
      boundY,
      shots: shotsOut,
      ux,
      uy,
      totals: {
        costX, costY, iterations, maxAbsX, maxAbsY,
        nAtBoundX, nAtBoundY, nPinnedX, nPinnedY,
        shotCount: shotsOut.length,
      },
    };
  }

  /** 逐帧偏移数组（[[ux,uy],…]），供导出。 */
  function offsetsByFrame(result, frameCount) {
    const out = new Array(frameCount);
    for (let t = 0; t < frameCount; t++) {
      out[t] = result.ok ? [result.ux[t], result.uy[t]] : [0, 0];
    }
    return out;
  }

  return { REASONS, validateConfig, fit, offsetsByFrame };
});
