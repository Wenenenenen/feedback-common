/*
 * Slanted-edge MTF core, implementing the convention in 约定.txt:
 *  - slope = minor/major axis component, must satisfy 0.03 <= |slope| <= 0.5
 *  - normal points toward the bright side
 *  - signed normal-distance bins on [-12, 12) at 0.25 px (96 bins)
 *  - interior gaps of <=2 bins linearly filled; head/tail or longer gaps invalid
 *  - LSF by central difference (endpoints dropped), Hanning window
 *  - DFT on a 0.005 cycles/px grid over [0, 0.5], normalized to DC
 *  - finite-difference compensation omega/sin(omega), omega = 2*pi*f*0.25
 *  - MTF50/MTF10 by linear interpolation of the first downward crossing
 *
 * Mirrors tools/ref_mtf.py; keep the two in sync.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MtfCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BIN_MIN = -12;
  const BIN_MAX = 12;
  const BIN_W = 0.25;
  const N_BINS = 96;
  const F_STEP = 0.005;
  const F_MAX = 0.5;
  const N_FREQ = 101;
  const BG_VALUE = 32768;
  const SLOPE_MIN = 0.03;
  const SLOPE_MAX = 0.5;

  function median(sortedAsc) {
    const n = sortedAsc.length;
    return n % 2 ? sortedAsc[(n - 1) >> 1] : 0.5 * (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]);
  }

  /* Robust line v = a*u + b using Theil-style initial slope + IRLS with MAD. */
  function robustLine(us, vs) {
    const n = us.length;
    const order = us.map((_, i) => i).sort((i, j) => us[i] - us[j]);
    const half = n >> 1;
    const slopes = [];
    for (let i = 0; i + half < n; i++) {
      const p = order[i];
      const q = order[i + half];
      if (us[q] !== us[p]) slopes.push((vs[q] - vs[p]) / (us[q] - us[p]));
    }
    slopes.sort((a, b) => a - b);
    let a = slopes.length ? slopes[slopes.length >> 1] : 0;
    const dev0 = vs.map((v, i) => v - a * us[i]).sort((x, y) => x - y);
    let b = median(dev0);
    let inliers = new Array(n).fill(true);

    for (let iter = 0; iter < 8; iter++) {
      const res = vs.map((v, i) => v - (a * us[i] + b));
      const absSorted = res.map(Math.abs).sort((x, y) => x - y);
      const mad = absSorted[n >> 1] || 0;
      const tol = Math.max(2.5 * 1.4826 * mad, 0.75);
      const next = res.map((r) => Math.abs(r) <= tol);
      let nin = 0;
      for (const ok of next) if (ok) nin++;
      if (nin < 8) break;
      let su = 0, sv = 0, suu = 0, suv = 0;
      for (let i = 0; i < n; i++) {
        if (!next[i]) continue;
        su += us[i]; sv += vs[i]; suu += us[i] * us[i]; suv += us[i] * vs[i];
      }
      const den = nin * suu - su * su;
      if (den === 0) break;
      const na = (nin * suv - su * sv) / den;
      const nb = (sv - na * su) / nin;
      const converged = Math.abs(na - a) < 1e-9 && Math.abs(nb - b) < 1e-9;
      a = na; b = nb; inliers = next;
      if (converged) break;
    }
    return { a, b, inliers };
  }

  function findEdge(img, w, h, rx, ry, rw, rh) {
    const px = (x, y) => img[y * w + x];
    const vals = [];
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) vals.push(px(x, y));
    vals.sort((a, b) => a - b);
    const dark = vals[Math.floor(vals.length / 20)];
    const bright = vals[vals.length - 1 - Math.floor(vals.length / 20)];
    if (bright - dark < Math.max(1000, 0.1 * Math.max(1, bright))) {
      return { valid: false, reason: "对比度不足，无法识别边缘" };
    }
    const mid = 0.5 * (dark + bright);

    let gx = 0, gy = 0, cnt = 0;
    for (let y = ry + 1; y < ry + rh - 1; y++) {
      for (let x = rx + 1; x < rx + rw - 1; x++) {
        gx += Math.abs(px(x + 1, y) - px(x - 1, y));
        gy += Math.abs(px(x, y + 1) - px(x, y - 1));
        cnt++;
      }
    }
    const vertical = gx >= gy;

    const points = [];
    if (vertical) {
      for (let y = ry; y < ry + rh; y++) {
        let prev = px(rx, y);
        for (let x = rx + 1; x < rx + rw; x++) {
          const cur = px(x, y);
          if ((prev - mid) * (cur - mid) < 0) {
            const t = (mid - prev) / (cur - prev);
            points.push([y, x - 1 + t]);
            break;
          }
          prev = cur;
        }
      }
    } else {
      for (let x = rx; x < rx + rw; x++) {
        let prev = px(x, ry);
        for (let y = ry + 1; y < ry + rh; y++) {
          const cur = px(x, y);
          if ((prev - mid) * (cur - mid) < 0) {
            const t = (mid - prev) / (cur - prev);
            points.push([x, y - 1 + t]);
            break;
          }
          prev = cur;
        }
      }
    }

    if (points.length < 8) {
      return { valid: false, reason: "可识别的边缘剖面过少", points, inliers: [] };
    }
    const us = points.map((p) => p[0]);
    const vs = points.map((p) => p[1]);
    const fit = robustLine(us, vs);
    let nin = 0;
    for (const ok of fit.inliers) if (ok) nin++;
    if (nin < 8) {
      return { valid: false, reason: "主直边拟合内点不足", points, inliers: fit.inliers };
    }

    const { a, b, inliers } = fit;
    const slope = a;
    let tx, ty;
    if (vertical) { tx = a; ty = 1; } else { tx = 1; ty = a; }
    const tn = Math.hypot(tx, ty);
    tx /= tn; ty /= tn;
    let nx = -ty, ny = tx;

    const xc = rx + (rw - 1) / 2;
    const yc = ry + (rh - 1) / 2;
    const sideMean = (sign) => {
      const acc = [];
      for (const step of [3.5, 5, 6.5]) {
        const xi = Math.round(xc + sign * step * nx);
        const yi = Math.round(yc + sign * step * ny);
        if (xi >= 0 && xi < w && yi >= 0 && yi < h) {
          const v = px(xi, yi);
          if (v !== BG_VALUE) acc.push(v);
        }
      }
      return acc.length ? acc.reduce((s, v) => s + v, 0) / acc.length : null;
    };
    const mp = sideMean(1), mm = sideMean(-1);
    if (mp !== null && mm !== null && mp < mm) { nx = -nx; ny = -ny; }

    if (!(Math.abs(slope) >= SLOPE_MIN && Math.abs(slope) <= SLOPE_MAX)) {
      return {
        valid: false,
        reason: `边缘斜率|${slope.toFixed(3)}|超出[0.03,0.5]，亚像素分箱不成立`,
        slope, points, inliers, vertical, a, b,
      };
    }

    const u0 = us[0];
    const v0 = a * u0 + b;
    const linePoint = vertical ? [v0, u0] : [u0, v0];

    return {
      valid: true, vertical, slope, a, b,
      normal: [nx, ny], linePoint,
      points, inliers, dark, bright,
    };
  }

  function esfLsfMtf(img, w, h, roi, edge) {
    const [rx, ry, rw, rh] = roi;
    const [nx, ny] = edge.normal;
    const [px0, py0] = edge.linePoint;
    const pad = Math.ceil(BIN_MAX) + 1;
    const x0 = Math.max(0, rx - pad);
    const x1 = Math.min(w, rx + rw + pad);
    const y0 = Math.max(0, ry - pad);
    const y1 = Math.min(h, ry + rh + pad);

    const sums = new Float64Array(N_BINS);
    const counts = new Int32Array(N_BINS);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = img[y * w + x];
        if (v === BG_VALUE) continue;
        const d = (x - px0) * nx + (y - py0) * ny;
        const k = Math.floor((d - BIN_MIN) / BIN_W);
        if (k >= 0 && k < N_BINS) { sums[k] += v; counts[k]++; }
      }
    }

    let first = -1, last = -1;
    for (let k = 0; k < N_BINS; k++) if (counts[k] > 0) { first = k; break; }
    for (let k = N_BINS - 1; k >= 0; k--) if (counts[k] > 0) { last = k; break; }
    if (first === -1 || first !== 0 || last !== N_BINS - 1) {
      return { error: "法向分箱首尾缺箱，边缘未充分覆盖[-12,12)像素" };
    }
    let run = 0;
    for (let k = 0; k < N_BINS; k++) {
      if (counts[k] === 0) { run++; if (run > 2) return { error: "法向分箱内部连续缺箱超过两个" }; }
      else run = 0;
    }

    const esf = new Array(N_BINS).fill(NaN);
    for (let k = 0; k < N_BINS; k++) if (counts[k]) esf[k] = sums[k] / counts[k];
    let k = 1;
    while (k < N_BINS - 1) {
      if (counts[k] === 0) {
        let j = k;
        while (j < N_BINS && counts[j] === 0) j++;
        const left = k - 1, right = j;
        for (let m = k; m < j; m++) {
          const t = (m - left) / (right - left);
          esf[m] = esf[left] + t * (esf[right] - esf[left]);
        }
        k = j;
      } else k++;
    }

    const nLsf = N_BINS - 2;
    const lsf = new Array(nLsf);
    for (let i = 0; i < nLsf; i++) {
      const bk = i + 1;
      lsf[i] = (esf[bk + 1] - esf[bk - 1]) / (2 * BIN_W);
    }
    const win = new Array(nLsf);
    for (let i = 0; i < nLsf; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (nLsf - 1)));
      win[i] = lsf[i] * hann;
    }
    let dc = 0;
    for (const v of win) dc += v;

    const mtf = new Array(N_FREQ);
    for (let j = 0; j < N_FREQ; j++) {
      const f = j * F_STEP;
      let re = 0, im = 0;
      for (let i = 0; i < nLsf; i++) {
        const ang = -2 * Math.PI * f * i * BIN_W;
        re += win[i] * Math.cos(ang);
        im += win[i] * Math.sin(ang);
      }
      const mag = Math.hypot(re, im);
      let comp = 1;
      if (j !== 0) {
        const omega = 2 * Math.PI * f * BIN_W;
        comp = omega / Math.sin(omega);
      }
      mtf[j] = Math.abs(mag / dc) * comp;
    }

    const crossing = (level) => {
      for (let j = 1; j < N_FREQ; j++) {
        if (mtf[j - 1] >= level && mtf[j] < level) {
          const f0 = (j - 1) * F_STEP, f1 = j * F_STEP;
          return f0 + ((level - mtf[j - 1]) * (f1 - f0)) / (mtf[j] - mtf[j - 1]);
        }
      }
      return null;
    };

    const binCenters = new Array(N_BINS);
    for (let b2 = 0; b2 < N_BINS; b2++) binCenters[b2] = BIN_MIN + BIN_W * (b2 + 0.5);

    return {
      esf, lsf, mtf,
      mtf50: crossing(0.5),
      mtf10: crossing(0.1),
      binCenters,
      counts: Array.from(counts),
    };
  }

  function analyzeRoi(img, w, h, roi) {
    const edge = findEdge(img, w, h, roi[0], roi[1], roi[2], roi[3]);
    const base = { roi: roi.slice(), edge };
    if (!edge.valid) return { ...base, valid: false, reason: edge.reason };
    const res = esfLsfMtf(img, w, h, roi, edge);
    if (res.error) return { ...base, valid: false, reason: res.error };
    return { ...base, valid: true, ...res };
  }

  return {
    BIN_MIN, BIN_MAX, BIN_W, N_BINS, F_STEP, F_MAX, N_FREQ, BG_VALUE,
    SLOPE_MIN, SLOPE_MAX,
    findEdge, esfLsfMtf, analyzeRoi, robustLine,
  };
});
