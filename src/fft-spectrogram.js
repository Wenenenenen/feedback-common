// fft-spectrogram.js — 手写基-2 FFT 与频谱图，无依赖
// 迭代 Cooley-Tukey radix-2，原地复数运算；提供幅度谱与对数频谱图。

// 原地复数 FFT（n 必须是 2 的幂）。re/im 长度均为 n。
export function fft(re, im) {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // 蝶形
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < half; k++) {
        const uR = re[i + k], uI = im[i + k];
        const vR = re[i + k + half] * curR - im[i + k + half] * curI;
        const vI = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + half] = uR - vR;
        im[i + k + half] = uI - vI;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nR;
      }
    }
  }
}

// 计算一帧对数幅度谱（dB），返回长度 fftSize/2 的 Float32Array，已加汉宁窗
export function magnitudeSpectrum(samples, start, fftSize) {
  const n = fftSize;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    const s = j >= 0 && j < samples.length ? samples[j] : 0;
    // 汉宁窗
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const half = n >> 1;
  const mag = new Float32Array(half);
  const norm = 2 / n;
  for (let i = 0; i < half; i++) {
    const amp = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * norm;
    mag[i] = 20 * Math.log10(amp + 1e-8);
  }
  return mag;
}

// 生成频谱图：沿时间轴分帧，返回 {frames: Float32Array[帧][频点], hop, fftSize, binHz}
export function buildSpectrogram(samples, sampleRate, fftSize = 2048, hop = 512) {
  const frames = [];
  const last = samples.length - fftSize;
  for (let start = 0; start <= last; start += hop) {
    frames.push(magnitudeSpectrum(samples, start, fftSize));
  }
  return { frames, hop, fftSize, binHz: sampleRate / fftSize };
}
