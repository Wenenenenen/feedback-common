/*
 * 扫频谐波测量核心。
 *
 * 逆扫频：  g[j] = x[N-1-j] * exp(-j*ln(f1/f0)/N),  0 <= j < N
 * 定标：    D = (x * g)[N-1] = Σ_k x[k]^2 * exp(-(N-1-k)*ln(f1/f0)/N)
 * 反卷积：  c = (y * g) / D            （y 为某一路采集，* 为线性卷积）
 * 零点：    c 在 [N-1+lo, N-1+hi] 内 |c| 最大的帧，同高取较早帧
 * 第 q 阶中心：zero - floor(N*ln(q)/ln(f1/f0) + 0.5)
 * 窗口：    [center-pre, center+post)，窗内超出反卷积索引的样本取零
 * 能量：    窗内样本平方和
 *
 * 所有函数是纯数值的，浏览器（全局 SHMCore）与 Node（module.exports）共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHMCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FFT = (typeof module === 'object' && module.exports)
    ? require('./fft.js')
    : (typeof globalThis !== 'undefined' ? globalThis.SHMFFT : null);

  const SAMPLE_RATE = 48000;
  const MIN_SWEEP_SECONDS = 1;
  const MAX_SWEEP_SECONDS = 20;
  const MAX_CAPTURE_SECONDS = 25;
  const MIN_FREQ = 20;
  const MAX_FREQ = 20000;
  const MAX_CAPTURE_CHANNELS = 4;
  const ORDERS = [1, 2, 3, 4];
  // 单窗样本数上限：窗要逐样本上屏并导出，超过这个量级已不是有效测量
  // （400 万帧 ≈ 83 s，Float64 约 32 MB/窗）。按包内规则 pre/post 本身无上限，
  // 这里给出一个明确的拒绝理由，而不是让浏览器分配失败。
  const MAX_WINDOW_SAMPLES = 4000000;

  const isInt = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);

  /* --------------------------------------------------------------------- */
  /* 参数校验                                                               */
  /* --------------------------------------------------------------------- */

  function intParam(raw, key, label, min, max) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error('setup.json 缺少参数 ' + key);
    }
    const v = raw[key];
    if (!isInt(v)) throw new Error('参数 ' + key + '（' + label + '）必须是整数');
    if (v < min || v > max) {
      throw new Error('参数 ' + key + '（' + label + '）= ' + v + ' 超出范围 ' + min + '–' + max);
    }
    return v;
  }

  /*
   * 校验 setup.json 本体。返回 {f0,f1,lo,hi,pre,post}。
   * lo/hi 与采集帧数、采样率等输入属性的关系在 validateParams 里检查。
   */
  function validateSetupObject(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('setup.json 必须是 JSON 对象');
    }
    const f0 = intParam(raw, 'f0', '起始频率 Hz', MIN_FREQ, MAX_FREQ - 1);
    const f1 = intParam(raw, 'f1', '终止频率 Hz', MIN_FREQ + 1, MAX_FREQ);
    if (!(f0 < f1)) throw new Error('必须 f0 < f1（当前 f0=' + f0 + '，f1=' + f1 + '）');
    const lo = intParam(raw, 'lo', '搜索起点', 0, Number.MAX_SAFE_INTEGER);
    const hi = intParam(raw, 'hi', '搜索终点', 0, Number.MAX_SAFE_INTEGER);
    if (!(lo <= hi)) throw new Error('搜索端点必须 lo <= hi（当前 lo=' + lo + '，hi=' + hi + '）');
    const pre = intParam(raw, 'pre', '窗左宽', 0, MAX_WINDOW_SAMPLES);
    const post = intParam(raw, 'post', '窗右宽', 1, MAX_WINDOW_SAMPLES);
    if (pre + post > MAX_WINDOW_SAMPLES) {
      throw new Error('窗宽 pre+post = ' + (pre + post) + ' 超过单窗上限 ' + MAX_WINDOW_SAMPLES + ' 样本');
    }
    return { f0, f1, lo, hi, pre, post };
  }

  /*
   * 校验搜索区间 / 窗宽（页面可改）与采集帧数、输入格式的关系。
   * 返回规范化对象；不合规抛出中文原因。
   */
  function validateParams(raw, ctx) {
    const base = validateSetupObject(raw);
    const { f0, f1, lo, hi, pre, post } = base;
    if (ctx) {
      if (ctx.sweepRate != null && ctx.sweepRate !== SAMPLE_RATE) {
        throw new Error('扫频采样率为 ' + ctx.sweepRate + ' Hz，需要 ' + SAMPLE_RATE + ' Hz');
      }
      if (ctx.captureRate != null && ctx.captureRate !== SAMPLE_RATE) {
        throw new Error('采集采样率为 ' + ctx.captureRate + ' Hz，需要 ' + SAMPLE_RATE + ' Hz');
      }
      if (ctx.sweepChannels != null && ctx.sweepChannels !== 1) {
        throw new Error('扫频必须是单声道（当前 ' + ctx.sweepChannels + ' 声道）');
      }
      if (ctx.captureChannels != null) {
        if (ctx.captureChannels < 1 || ctx.captureChannels > MAX_CAPTURE_CHANNELS) {
          throw new Error('采集声道数 ' + ctx.captureChannels + ' 不在 1–' + MAX_CAPTURE_CHANNELS + ' 范围');
        }
      }
      if (ctx.captureFrames != null) {
        if (!(hi < ctx.captureFrames)) {
          throw new Error('搜索终点 hi=' + hi + ' 必须小于采集帧数 ' + ctx.captureFrames);
        }
      }
      if (ctx.sweepFrames != null) {
        const sec = ctx.sweepFrames / SAMPLE_RATE;
        if (sec < MIN_SWEEP_SECONDS - 1e-9 || sec > MAX_SWEEP_SECONDS + 1e-9) {
          throw new Error('扫频时长 ' + sec.toFixed(3) + ' s 超出 1–20 s');
        }
      }
      if (ctx.captureFrames != null) {
        const sec = ctx.captureFrames / SAMPLE_RATE;
        if (sec > MAX_CAPTURE_SECONDS + 1e-9) {
          throw new Error('采集时长 ' + sec.toFixed(3) + ' s 超过 25 s 上限');
        }
      }
    }
    return base;
  }

  /* --------------------------------------------------------------------- */
  /* 逆扫频与定标                                                           */
  /* --------------------------------------------------------------------- */

  function logRatio(f0, f1) {
    return Math.log(f1 / f0);
  }

  /* g[j] = x[N-1-j]*exp(-j*L/N) */
  function inverseSweep(sweep, f0, f1) {
    const N = sweep.length;
    const L = logRatio(f0, f1);
    const g = new Float64Array(N);
    for (let j = 0; j < N; j++) g[j] = sweep[N - 1 - j] * Math.exp(-j * L / N);
    return g;
  }

  /*
   * 扫频自测主响应 D = (x * g)[N-1]，用与卷积等价的直接求和计算。
   * D = Σ_k x[k]^2 * exp(-(N-1-k) L/N)，O(N)，无需 FFT。
   */
  function selfCalibration(sweep, f0, f1) {
    const N = sweep.length;
    if (N < 2) throw new Error('扫频帧数过少（N=' + N + '）');
    const L = logRatio(f0, f1);
    let D = 0;
    for (let k = 0; k < N; k++) {
      const w = Math.exp(-(N - 1 - k) * L / N);
      D += sweep[k] * sweep[k] * w;
    }
    return D;
  }

  /* 第 q 阶相对零点的帧偏移：floor(N*ln(q)/ln(f1/f0)+0.5) */
  function orderShift(q, N, f0, f1) {
    return Math.floor(N * Math.log(q) / Math.log(f1 / f0) + 0.5);
  }

  /* --------------------------------------------------------------------- */
  /* 线性卷积（实数 FFT）                                                   */
  /* --------------------------------------------------------------------- */

  /*
   * c = (y * g) / D，整段长度 M+N-1。返回 Float64Array（定标后）。
   *
   * 两个实序列打包进一次复 FFT（z = y + i·g），从 Z 分离出各自的谱，
   * 相乘后再用一次复逆变换取实部。主要用于测试与交叉核对；
   * 页面走 deconvolveBand（只算需要的一段，用实数 FFT）。
   */
  function deconvolve(y, g, D) {
    if (!(D !== 0 && Number.isFinite(D))) {
      throw new Error('扫频自测主响应为 0，无法定标（分母为 0）');
    }
    const M = y.length;
    const N = g.length;
    const dataLen = M + N - 1;
    if (dataLen < 2) throw new Error('采集或扫频帧数过少');
    const n = FFT.nextPow2(dataLen);
    const plan = FFT.makeComplexFFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(y);
    im.set(g);
    plan.fwd(re, im);
    // Z[k] = Y[k] + i·G[k]  ⇒  Y[k] = (Z + conj(Z[n-k]))/2, G[k] = (Z - conj(Z[n-k]))/(2i)
    // C = Y·G 是实序列的谱，满足 C[n-k] = conj(C[k])：成对原地改写即可，
    // 只需两份长度 n 的数组，满额输入（n = 2^22）约 67 MB。
    const half = n >> 1;
    const inv2 = 0.5;
    for (let k = 0; k <= half; k++) {
      const kb = (n - k) & (n - 1);
      const zr = re[k], zi = im[k];
      const wr = re[kb], wi = -im[kb];             // conj(Z[n-k])
      const yr = (zr + wr) * inv2;
      const yi = (zi + wi) * inv2;
      // G = (Z - conj(Z[n-k]))/(2i) = ((zr-wr) + i(zi-wi)) · (-i/2)
      const dr = (zr - wr) * inv2;
      const di = (zi - wi) * inv2;
      const gr = di;
      const gi = -dr;
      const rr = yr * gr - yi * gi;
      const ii = yr * gi + yi * gr;
      re[k] = rr; im[k] = ii;
      if (k > 0 && k < half) {
        re[n - k] = rr;
        im[n - k] = -ii;
      }
    }
    plan.ifft(re, im);
    const out = new Float64Array(dataLen);
    const inv = 1 / D;
    for (let i = 0; i < dataLen; i++) out[i] = re[i] * inv;
    return out;
  }

  /*
   * c = (y * g) / D 在 [lo, hi] 上的一段。返回 {lo, values: Float64Array}。
   *
   * 只算需要的那一段：把 y 前端补 P = max(0, N-1-lo) 个零后，用长度
   * L = nextPow2(hi-lo+N) 的实数 FFT 做一次循环卷积，输出索引
   * m = k+P 全都落在无混叠的 [N-1, L-1] 区间内。
   *
   * 满额输入（N=960k、查询带宽约 30k）时 L 只有 2^20，而整段卷积要 2^22——
   * 三次实数变换约 180 ms/通道，而不是 900 ms。
   */
  function deconvolveBand(y, g, D, lo, hi) {
    if (!(D !== 0 && Number.isFinite(D))) {
      throw new Error('扫频自测主响应为 0，无法定标（分母为 0）');
    }
    const M = y.length;
    const N = g.length;
    const dataLen = M + N - 1;
    const a = Math.max(0, Math.min(lo, dataLen - 1));
    const b = Math.max(a, Math.min(hi, dataLen - 1));
    const P = Math.max(0, (N - 1) - a);
    const s = Math.max(0, a + P - (N - 1));
    const L = FFT.nextPow2(b + P - s + 1);
    const plan = FFT.makeRealFFT(L);
    const x = new Float64Array(L);
    // x[i] = y[s + i - P]
    const yStart = s - P;
    for (let i = 0; i < L; i++) {
      const yi = yStart + i;
      if (yi >= 0 && yi < M) x[i] = y[yi];
    }
    const f = new Float64Array(L);
    f.set(g);
    const X = plan.fwd(x);
    const G = plan.fwd(f);
    const H = G.re, Hi = G.im;
    for (let k = 0; k <= plan.m; k++) {
      const rr = X.re[k] * H[k] - X.im[k] * Hi[k];
      const ii = X.re[k] * Hi[k] + X.im[k] * H[k];
      X.re[k] = rr; X.im[k] = ii;
    }
    const conv = plan.inv(X.re, X.im);
    const n = b - a + 1;
    const values = new Float64Array(n);
    const inv = 1 / D;
    const off = a + P - s;
    for (let i = 0; i < n; i++) values[i] = conv[off + i] * inv;
    return { lo: a, hi: b, dataLen, values };
  }

  /*
   * 给定参数，算出定位需要的反卷积区间（零点尚未知，但四窗落点有确定上界）：
   * 从「搜索区间最早零点 − q4 偏移 − pre」到「最晚零点 + post − 1」，
   * 两侧再留余量，使小幅调整窗宽时可以复用已算好的分段。
   */
  function planBand(N, dataLen, params) {
    const { f0, f1, lo, hi, pre, post } = params;
    const L = Math.log(f1 / f0);
    let shiftMax = 0;
    for (const q of ORDERS) {
      const s = Math.floor(N * Math.log(q) / L + 0.5);
      if (s > shiftMax) shiftMax = s;
    }
    let a = (N - 1) + lo - shiftMax - pre;
    let b = (N - 1) + hi + post - 1;
    a = Math.max(0, Math.min(a, dataLen - 1));
    b = Math.max(a, Math.min(b, dataLen - 1));
    // 两侧留余量：小幅调整窗宽时可直接复用已算好的分段，不必重做 FFT。
    // 余量取所需宽度的 25%（最少 4096 帧、最多 65536 帧），FFT 规模因此有上界。
    const width = b - a + 1;
    const pad = Math.min(65536, Math.max(4096, Math.round(width * 0.25)));
    const lo2 = Math.max(0, a - pad);
    const hi2 = Math.min(dataLen - 1, b + pad);
    return { lo: lo2, hi: hi2, coreLo: a, coreHi: b };
  }

  /* 信号视图：整段数组或 {lo, values} 分段。segAt 对未覆盖处返回 0。 */
  function asSignal(c, dataLen) {
    if (c && !ArrayBuffer.isView(c) && ArrayBuffer.isView(c.values)) {
      return {
        dataLen: c.dataLen != null ? c.dataLen : dataLen,
        lo: c.lo | 0,
        values: c.values,
      };
    }
    if (!ArrayBuffer.isView(c)) throw new Error('信号必须是 Float64Array 或 {lo, values}');
    return { dataLen: dataLen != null ? dataLen : c.length, lo: 0, values: c };
  }

  function segAt(sig, i) {
    const j = i - sig.lo;
    return (j >= 0 && j < sig.values.length) ? sig.values[j] : 0;
  }

  /* --------------------------------------------------------------------- */
  /* 窗口定位                                                               */
  /* --------------------------------------------------------------------- */

  /*
   * 在反卷积结果上定位零点与四个窗口。
   * c 可以是整段 Float64Array（dataLen 为长度），也可以是 deconvolveBand 的结果。
   * params: {f0,f1,lo,hi,pre,post}
   * 返回：
   *  { zero, zeroRel, zeroValue, search:{start,end},
   *    windows:[{q,shift,center,start,end,samples,energy,peak,peakIndex,peakOffset,rms,zeroFilled}],
   *    conflicts:[[qA,qB]], minCenter, maxCenter }
   */
  function locateWindows(c, dataLen, N, params) {
    const sig = asSignal(c, dataLen);
    const total = sig.dataLen;
    const { f0, f1, lo, hi, pre, post } = params;
    const L = Math.log(f1 / f0);
    const searchStart = N - 1 + lo;
    const searchEnd = N - 1 + hi;
    if (searchStart < 0 || searchEnd >= total) {
      throw new Error('搜索区间对应的反卷积帧越界');
    }
    let zero = searchStart;
    let zeroAbs = Math.abs(segAt(sig, searchStart));
    for (let n = searchStart + 1; n <= searchEnd; n++) {
      const a = Math.abs(segAt(sig, n));
      if (a > zeroAbs) { zeroAbs = a; zero = n; }   // 严格大于 → 同高取较早帧
    }
    const windows = [];
    let minCenter = Infinity;
    let maxCenter = -Infinity;
    for (const q of ORDERS) {
      const shift = Math.floor(N * Math.log(q) / L + 0.5);
      const center = zero - shift;
      const start = center - pre;
      const end = center + post;
      const len = end - start;
      if (!(len >= 1)) throw new Error('第 ' + q + ' 阶窗宽非法');
      if (len > MAX_WINDOW_SAMPLES) {
        throw new Error('第 ' + q + ' 阶窗有 ' + len + ' 个样本，超过单窗上限 ' + MAX_WINDOW_SAMPLES);
      }
      const samples = new Float64Array(len);
      let energy = 0;
      let peak = 0;
      let peakIndex = -1;
      let zeroFilled = 0;
      for (let i = start; i < end; i++) {
        let v = 0;
        if (i >= 0 && i < total) v = segAt(sig, i);
        else zeroFilled++;
        samples[i - start] = v;
        energy += v * v;
        if (Math.abs(v) > Math.abs(peak)) { peak = v; peakIndex = i; }
      }
      windows.push({
        q,
        shift,
        center,
        start,
        end,
        length: len,
        samples,
        energy,
        peak,
        peakIndex,
        peakOffset: peakIndex >= 0 ? peakIndex - start : -1,
        rms: Math.sqrt(energy / len),
        zeroFilled,
        zeroFilledLeft: start < 0 ? Math.min(-start, len) : 0,
        zeroFilledRight: end > total ? Math.min(end - total, len) : 0,
      });
      if (center < minCenter) minCenter = center;
      if (center > maxCenter) maxCenter = center;
    }
    const conflicts = [];
    for (let a = 0; a < windows.length; a++) {
      for (let b = a + 1; b < windows.length; b++) {
        const A = windows[a], B = windows[b];
        if (A.start < B.end && B.start < A.end) conflicts.push([A.q, B.q]);
      }
    }
    return {
      zero,
      zeroRel: zero - (N - 1),
      zeroValue: segAt(sig, zero),
      search: { start: searchStart, end: searchEnd },
      windows,
      conflicts,
      minCenter,
      maxCenter,
    };
  }

  /* --------------------------------------------------------------------- */
  /* 总览包络（画图用）                                                      */
  /* --------------------------------------------------------------------- */

  /*
   * 把 c[lo..hi] 分成 bins 个桶，返回每桶的 min/max（有符号包络）。
   * 桶数不超过样本数。
   */
  function buildOverview(c, lo, hi, bins, dataLen) {
    const sig = asSignal(c, dataLen != null ? dataLen : c.length);
    const total = sig.dataLen;
    const a = Math.max(0, Math.min(lo, total - 1));
    const b = Math.max(a, Math.min(hi, total - 1));
    const span = b - a + 1;
    const count = Math.max(1, Math.min(bins, span));
    const min = new Float64Array(count);
    const max = new Float64Array(count);
    const startIdx = new Int32Array(count + 1);
    for (let i = 0; i <= count; i++) startIdx[i] = a + Math.floor(i * span / count);
    for (let i = 0; i < count; i++) {
      const s = startIdx[i];
      let e = startIdx[i + 1];
      if (e <= s) e = s + 1;
      let mn = segAt(sig, s), mx = mn;
      for (let k = s + 1; k < e; k++) {
        const v = segAt(sig, k);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      min[i] = mn;
      max[i] = mx;
    }
    return { lo: a, hi: b, bins: count, min, max };
  }

  /*
   * 单通道完整分析。
   *
   * 两种入口：
   *  a) analyzeBand(band, N, params)：band 为 deconvolveBand 结果，效率最高；
   *  b) analyzeChannel(c, N, params)：c 为整段 Float64Array（测试与交叉核对用）。
   * 返回可结构化克隆的普通对象，samples 与 overview 都是独立数组。
   */
  function analyzeSignal(sig, N, params, opts) {
    const total = sig.dataLen;
    const found = locateWindows(sig, total, N, params);
    const searchStart = found.search.start;
    const searchEnd = found.search.end;
    let needLo = searchStart;
    let needHi = searchEnd;
    for (const w of found.windows) {
      if (w.start < needLo) needLo = w.start;
      if (w.end - 1 > needHi) needHi = w.end - 1;
    }
    // 观察范围：包住搜索区间与所有窗口，两侧各留 2% 余量
    const pad = Math.max(8, Math.round((needHi - needLo + 1) * 0.02));
    const viewLo = Math.max(0, Math.min(needLo, searchStart) - pad);
    const viewHi = Math.min(total - 1, Math.max(needHi, searchEnd) + pad);
    const bins = opts && opts.bins ? opts.bins : 1600;
    const overview = buildOverview(sig, viewLo, viewHi, bins);
    return {
      dataLen: total,
      zero: found.zero,
      zeroRel: found.zeroRel,
      zeroValue: found.zeroValue,
      search: found.search,
      windows: found.windows,
      conflicts: found.conflicts,
      view: { lo: viewLo, hi: viewHi },
      overview,
    };
  }

  function analyzeChannel(c, N, params, opts) {
    return analyzeSignal(asSignal(c, c.length), N, params, opts);
  }

  function analyzeBand(band, N, params, opts) {
    return analyzeSignal(asSignal(band, band.dataLen), N, params, opts);
  }

  /*
   * 一步到位：采集通道 y -> 定标反卷积 -> 窗口。
   * 给定搜参范围时只算那一段（band = false 可强制整段，测试对拍用）。
   */
  function processChannel(y, sweep, params, precomputed) {
    const N = sweep.length;
    const f0 = params.f0, f1 = params.f1;
    let g, D;
    if (precomputed && precomputed.g && precomputed.D != null) {
      g = precomputed.g; D = precomputed.D;
    } else {
      D = selfCalibration(sweep, f0, f1);
      g = inverseSweep(sweep, f0, f1);
    }
    if (precomputed && precomputed.band === false) {
      const c = deconvolve(y, g, D);
      return { calib: D, g, c, analysis: analyzeChannel(c, N, params) };
    }
    const dataLen = y.length + N - 1;
    const plan = planBand(N, dataLen, params);
    const band = deconvolveBand(y, g, D, plan.lo, plan.hi);
    return { calib: D, g, band, analysis: analyzeBand(band, N, params) };
  }

  /* 读入后把采样点落到 [-1,1] 之外的浮点 WAV 也接受；这里只做统计。 */
  function channelStats(data) {
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: data.length ? Math.sqrt(sum / data.length) : 0 };
  }

  return {
    SAMPLE_RATE, MIN_SWEEP_SECONDS, MAX_SWEEP_SECONDS, MAX_CAPTURE_SECONDS,
    MIN_FREQ, MAX_FREQ, MAX_CAPTURE_CHANNELS, MAX_WINDOW_SAMPLES, ORDERS,
    validateSetupObject, validateParams,
    logRatio, inverseSweep, selfCalibration, orderShift,
    deconvolve, deconvolveBand, planBand, locateWindows, buildOverview,
    analyzeChannel, analyzeBand, processChannel, channelStats,
    asSignal, segAt,
  };
});
