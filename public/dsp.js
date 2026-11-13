/* dsp.js — 纯函数 DSP 工具：FFT、重采样、起音包络、相关、鲁棒直线拟合、映射渲染。
 * 双模式：浏览器/Worker（挂到全局 DSP）与 Node（module.exports），无任何外部依赖。 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.DSP = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  /* 原地迭代基-2 FFT。invert=true 时为逆变换（含 1/n）。 */
  function fft(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (2 * Math.PI / len) * (invert ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let j = 0; j < half; j++) {
          const ur = re[i + j], ui = im[i + j];
          const xr = re[i + j + half], xi = im[i + j + half];
          const vr = xr * cwr - xi * cwi;
          const vi = xr * cwi + xi * cwr;
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
          const nw = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nw;
        }
      }
    }
    if (invert) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /* 线性插值重采样（分析用，足够）。 */
  function resampleLinear(sig, fromRate, toRate) {
    if (fromRate === toRate) return sig instanceof Float32Array ? sig : new Float32Array(sig);
    const outLen = Math.max(1, Math.round(sig.length * toRate / fromRate));
    const out = new Float32Array(outLen);
    const step = fromRate / toRate;
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, sig.length - 1);
      const f = pos - i0;
      out[i] = sig[i0] * (1 - f) + sig[i1] * f;
    }
    return out;
  }

  /* 起音包络：RMS 能量包络的正向差分（半波整流），对静音天然为零。
   * sigRate 采样率，envRate 输出包络率（Hz）。 */
  function onsetEnvelope(sig, sigRate, envRate) {
    const hop = Math.max(1, Math.round(sigRate / envRate));
    const win = Math.max(hop, Math.round(sigRate * 0.016)); // 16ms 窗
    const n = Math.max(0, Math.floor((sig.length - win) / hop) + 1);
    // 平方累计和
    const cs = new Float64Array(sig.length + 1);
    for (let i = 0; i < sig.length; i++) cs[i + 1] = cs[i] + sig[i] * sig[i];
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * hop;
      env[i] = Math.sqrt(Math.max(0, cs[s + win] - cs[s]) / win);
    }
    const lag = Math.max(1, Math.round(envRate * 0.016)); // 16ms 前向差分
    const on = new Float32Array(n);
    for (let i = lag; i < n; i++) {
      const d = env[i] - env[i - lag];
      on[i] = d > 0 ? d : 0;
    }
    return on;
  }

  function decimate(sig, factor) {
    const n = Math.floor(sig.length / factor);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = sig[i * factor];
    return out;
  }

  /* 有效区互相关：corr[lag] = Σ ref[lag+i]*chunk[i]，lag ∈ [0, ref.length-chunk.length]。 */
  function correlateValid(ref, chunk) {
    const validLen = ref.length - chunk.length + 1;
    if (validLen <= 0) return null;
    const N = nextPow2(ref.length + chunk.length);
    const rre = new Float64Array(N), rim = new Float64Array(N);
    const cre = new Float64Array(N), cim = new Float64Array(N);
    rre.set(ref);
    for (let i = 0; i < chunk.length; i++) cre[i] = chunk[chunk.length - 1 - i]; // 反转实现相关
    fft(rre, rim, false);
    fft(cre, cim, false);
    for (let i = 0; i < N; i++) {
      const ar = rre[i], ai = rim[i], br = cre[i], bi = cim[i];
      rre[i] = ar * br - ai * bi;
      rim[i] = ar * bi + ai * br;
    }
    fft(rre, rim, true);
    const out = new Float64Array(validLen);
    const off = chunk.length - 1;
    for (let lag = 0; lag < validLen; lag++) out[lag] = rre[lag + off];
    return out;
  }

  function sqCumsum(sig) {
    const cs = new Float64Array(sig.length + 1);
    for (let i = 0; i < sig.length; i++) cs[i + 1] = cs[i] + sig[i] * sig[i];
    return cs;
  }

  function normOf(sig) {
    let s = 0;
    for (let i = 0; i < sig.length; i++) s += sig[i] * sig[i];
    return Math.sqrt(s);
  }

  /* 抛物线插值：给定 ym1,y0,yp1，返回相对中心的小数偏移（[-1,1]）。 */
  function parabolic(ym1, y0, yp1) {
    const den = ym1 - 2 * y0 + yp1;
    if (Math.abs(den) < 1e-12) return 0;
    const d = 0.5 * (ym1 - yp1) / den;
    return Math.max(-1, Math.min(1, d));
  }

  /* 最小二乘拟合 y = a*x + b（仅使用 inliers 索引）。 */
  function lsqLine(xs, ys, idx) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const n = idx.length;
    for (const i of idx) {
      sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return null;
    const a = (n * sxy - sx * sy) / den;
    const b = (sy - a * sx) / n;
    return { a, b };
  }

  /* RANSAC 直线拟合：重复片段造成的错误相关峰作为离群点剔除。
   * 返回 {a,b,inliers,rms} 或 null（内点不足）。 */
  function ransacLine(xs, ys, thresh, minInliers, iters) {
    const n = xs.length;
    if (n < minInliers) return null;
    let best = null;
    let seed = 1234567;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let it = 0; it < iters; it++) {
      const i = Math.floor(rand() * n);
      let j = Math.floor(rand() * n);
      if (i === j) continue;
      if (Math.abs(xs[i] - xs[j]) < 3) continue; // 需要足够水平跨度
      const a = (ys[j] - ys[i]) / (xs[j] - xs[i]);
      const b = ys[i] - a * xs[i];
      const inl = [];
      for (let k = 0; k < n; k++) {
        if (Math.abs(ys[k] - (a * xs[k] + b)) <= thresh) inl.push(k);
      }
      if (!best || inl.length > best.inliers.length) best = { a, b, inliers: inl };
    }
    if (!best || best.inliers.length < minInliers) return null;
    // 内点上最小二乘 + 重新筛选，迭代两轮
    let cur = best;
    for (let round = 0; round < 2; round++) {
      const fit = lsqLine(xs, ys, cur.inliers);
      if (!fit) return null;
      const inl = [];
      let se = 0;
      for (let k = 0; k < n; k++) {
        const r = ys[k] - (fit.a * xs[k] + fit.b);
        if (Math.abs(r) <= thresh) { inl.push(k); se += r * r; }
      }
      if (inl.length < minInliers) return null;
      cur = { a: fit.a, b: fit.b, inliers: inl, rms: Math.sqrt(se / inl.length) };
    }
    return cur;
  }

  /* 统一映射渲染：预听与导出共用。
   * t_ref = a*t_track + b。输出 outRate 立体声：左=参考，右=映射后的待校准轨。
   * 超出任一音频范围处补零。 */
  function renderRange(refMono, refRate, trkMono, trkRate, a, b, t0, t1, outRate) {
    const n = Math.max(0, Math.round((t1 - t0) * outRate));
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const refDur = refMono.length / refRate;
    const trkDur = trkMono.length / trkRate;
    for (let i = 0; i < n; i++) {
      const tRef = t0 + i / outRate;
      if (tRef >= 0 && tRef < refDur) {
        const pos = tRef * refRate;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, refMono.length - 1);
        const f = pos - i0;
        left[i] = refMono[i0] * (1 - f) + refMono[i1] * f;
      }
      const tTrk = (tRef - b) / a;
      if (tTrk >= 0 && tTrk < trkDur) {
        const pos = tTrk * trkRate;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, trkMono.length - 1);
        const f = pos - i0;
        right[i] = trkMono[i0] * (1 - f) + trkMono[i1] * f;
      }
    }
    return { left, right };
  }

  return {
    nextPow2, fft, resampleLinear, onsetEnvelope, decimate,
    correlateValid, sqCumsum, normOf, parabolic, lsqLine, ransacLine, renderRange,
  };
});
