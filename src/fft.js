// 手写迭代基-2 Cooley–Tukey FFT，不依赖任何第三方库。
// 输入输出均为交错 Float64Array [re0, im0, re1, im1, ...]。

export function nextPow2(n) {
  return 1 << (Math.ceil(Math.log2(Math.max(2, n))));
}

function bitReverse(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
}

/** 原地 FFT（inverse=true 时为逆变换，含 1/N 归一化）。n 必须是 2 的幂。 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  bitReverse(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? -1 : 1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Hann 窗（周期型，分母 N）。 */
export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * 单帧幅度谱（dBFS）。自动补零到 2 的幂，加 Hann 窗。
 * 返回 { freqs, magDb, nfft, coherentGain }
 */
export function magnitudeSpectrum(samples, sampleRate, nfft) {
  nfft = nfft || nextPow2(samples.length);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const win = hannWindow(Math.min(samples.length, nfft));
  const cg = win.reduce((a, b) => a + b, 0) / win.length; // Hann ≈ 0.5
  const n = win.length;
  for (let i = 0; i < n; i++) re[i] = samples[i] * win[i];
  fft(re, im, false);
  const bins = nfft >> 1;
  const magDb = new Float64Array(bins + 1);
  const freqs = new Float64Array(bins + 1);
  // 单频幅度 = 2·|X[k]| / sum(win)，使满幅正弦读数接近 0 dBFS
  const winSum = win.reduce((a, b) => a + b, 0);
  for (let k = 0; k <= bins; k++) {
    freqs[k] = (k * sampleRate) / nfft;
    const mag = (2 * Math.hypot(re[k], im[k])) / winSum;
    // 显示/测量下限 -160 dBFS，避免数值地板被当成真实超低电平
    magDb[k] = 20 * Math.log10(Math.max(mag, 1e-8));
  }
  return { freqs, magDb, nfft, coherentGain: cg };
}

/** 局部峰值插值（二次抛物线），返回分数 bin 位置与峰值 dB。 */
export function interpolatedPeak(magDb, bin) {
  if (bin <= 0 || bin >= magDb.length - 1) {
    return { bin, db: magDb[bin] };
  }
  const y0 = magDb[bin - 1];
  const y1 = magDb[bin];
  const y2 = magDb[bin + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : 0.5 * (y0 - y2) / denom;
  const db = y1 - 0.25 * (y0 - y2) * delta;
  return { bin: bin + delta, db };
}

/**
 * STFT 幅度谱（dB），用于扫频信号的时间-频率分析。
 * @returns {{times:Float64Array, freqs:Float64Array, matrix:Float64Array[], hop:number, winLen:number}}
 */
export function stft(samples, sampleRate, winLen = 2048, hop = 1024) {
  const nfft = nextPow2(winLen);
  const win = hannWindow(winLen);
  const cg = win.reduce((a, b) => a + b, 0) / win.length;
  const frames = Math.max(1, Math.floor((samples.length - winLen) / hop) + 1);
  const bins = nfft >> 1;
  const freqs = new Float64Array(bins + 1);
  for (let k = 0; k <= bins; k++) freqs[k] = (k * sampleRate) / nfft;
  const times = new Float64Array(frames);
  const matrix = new Array(frames);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    times[f] = (start + winLen / 2) / sampleRate;
    re.fill(0); im.fill(0);
    for (let i = 0; i < winLen; i++) re[i] = samples[start + i] * win[i];
    fft(re, im, false);
    const col = new Float64Array(bins + 1);
    const winSum = win.reduce((a, b) => a + b, 0);
    for (let k = 0; k <= bins; k++) {
      const mag = (2 * Math.hypot(re[k], im[k])) / winSum;
      col[k] = 20 * Math.log10(Math.max(mag, 1e-8));
    }
    matrix[f] = col;
  }
  return { times, freqs, matrix, hop, winLen, nfft };
}
