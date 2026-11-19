// Basic radix-2 iterative FFT (Cooley-Tukey), in-place complex arrays.
// Length must be a power of two. This is the "basic FFT" building block;
// all pitch logic lives in the other modules.

export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const cos = Math.cos, sin = Math.sin;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = cos(ang), wIm = sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  return { re, im };
}

export function ifft(re, im) {
  // conjugate, forward FFT, conjugate back, scale
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
  return { re, im };
}

// Autocorrelation r(tau) for lags 0..maxLag of a real segment, via FFT
// with zero padding so circular terms do not alias into the used lags.
export function autocorrelation(seg, maxLag) {
  let n = 1;
  while (n < seg.length + maxLag) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(seg);
  fft(re, im);
  // power spectrum
  for (let i = 0; i < n; i++) {
    const a = re[i], b = im[i];
    re[i] = a * a + b * b;
    im[i] = 0;
  }
  ifft(re, im);
  const r = new Float64Array(maxLag + 1);
  for (let t = 0; t <= maxLag; t++) r[t] = re[t];
  return r;
}

// One-sided magnitude spectrum (Hann-windowed) used for the harmonic
// octave check. Zero-pads to the next power of two and returns bins spaced
// at `sampleRate / n` so low-frequency band energies stay comparable across
// frame positions and window sizes.
export function magnitudeSpectrum(seg, sampleRate) {
  let n = 1;
  while (n < seg.length * 2) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < seg.length; i++) {
    re[i] = seg[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (seg.length - 1)));
  }
  fft(re, im);
  const bins = n >> 1;
  const mag = new Float64Array(bins + 1);
  const freqs = new Float64Array(bins + 1);
  for (let k = 0; k <= bins; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    freqs[k] = (k * sampleRate) / n;
  }
  return { freqs, mag };
}
