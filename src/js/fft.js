/*
 * 复数 / 实数 FFT。
 *
 * 反卷积用的两条序列都是实的：makeRealFFT 把 n 点实序列装进长度 n/2 的复变换，
 * 一次正变换得到 0..n/2 的半谱，逆变换再从半谱还原。长度都是 2 的幂。
 *
 * 实现要点：
 *  - 基 2 原位 DIT，位翻转用递增法（不建表，省位翻转表）；
 *  - 旋转因子只用一张 n/2 的表（阶段 len 按步长 n/len 取），
 *    内存 = n 个 Float64，n = 2^22 时约 33 MB；
 *  - 逆变换复用同一张表（共轭），不做额外分配。
 * 浏览器（全局 SHMFFT）与 Node（module.exports）共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SHMFFT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function isPow2(n) {
    return n >= 1 && (n & (n - 1)) === 0;
  }

  /*
   * 复数 FFT 计划。fwd(re, im) 与 ifft(re, im) 原地计算，数组长度必须为 n。
   */
  function makeComplexFFT(n) {
    if (!isPow2(n)) throw new Error('FFT 长度必须是 2 的幂');
    if (n < 2) throw new Error('FFT 长度至少为 2');
    const half = n >> 1;
    // w[k] = exp(-2πik/n), k = 0..n/2-1
    const wr = new Float64Array(half);
    const wi = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = -2 * Math.PI * k / n;
      wr[k] = Math.cos(a);
      wi[k] = Math.sin(a);
    }

    function run(re, im, inverse) {
      // 位翻转
      for (let i = 1, j = 0; i < n; i++) {
        let bit = half;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      const sgn = inverse ? -1 : 1;
      for (let len = 2; len <= n; len <<= 1) {
        const h = len >> 1;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
          const lim = i + h;
          for (let a = i, k = 0; a < lim; a++, k += step) {
            const b = a + h;
            const br = re[b], bi = im[b];
            const cwr = wr[k], cwi = wi[k] * sgn;
            const vr = br * cwr - bi * cwi;
            const vi = br * cwi + bi * cwr;
            const ar = re[a], ai = im[a];
            re[b] = ar - vr; im[b] = ai - vi;
            re[a] = ar + vr; im[a] = ai + vi;
          }
        }
      }
      if (inverse) {
        const s = 1 / n;
        for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
      }
    }

    function fwd(re, im) { run(re, im, false); }
    function ifft(re, im) { run(re, im, true); }

    return { n, fwd, ifft };
  }

  /*
   * 实数 FFT（时域 n 点 -> 频域 0..n/2 共 n/2+1 点）。
   * 内部使用长度 n/2 的复变换。为便于通用卷积，这里也提供实序列线性卷积。
   */
  function makeRealFFT(n) {
    if (!isPow2(n) || n < 2) throw new Error('实数 FFT 长度必须是 >=2 的 2 的幂');
    const m = n >> 1;
    const core = makeComplexFFT(m);
    const half = m;
    const wR = new Float64Array(half + 1);
    const wI = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const a = -2 * Math.PI * k / n;
      wR[k] = Math.cos(a); wI[k] = Math.sin(a);
    }
    const zr = new Float64Array(m);
    const zi = new Float64Array(m);

    function fwdInto(x, hr, hi) {
      for (let i = 0; i < m; i++) {
        zr[i] = x[2 * i];
        zi[i] = x[2 * i + 1];
      }
      core.fwd(zr, zi);
      for (let k = 0; k <= m; k++) {
        const ka = k % m;
        const kb = (m - k) % m;
        const ar = zr[ka], ai = zi[ka];
        const br = zr[kb], bi = -zi[kb];
        const er = (ar + br) * 0.5, ei = (ai + bi) * 0.5;
        const or = (ai - bi) * 0.5, oi = -(ar - br) * 0.5;
        const wr = wR[k], wi = wI[k];
        hr[k] = er + (wr * or - wi * oi);
        hi[k] = ei + (wr * oi + wi * or);
      }
    }

    function fwd(x) {
      const hr = new Float64Array(m + 1);
      const hi = new Float64Array(m + 1);
      fwdInto(x, hr, hi);
      return { re: hr, im: hi };
    }

    function invInto(hr, hi, out) {
      const yr = zr, yi = zi;
      for (let k = 0; k < m; k++) {
        const ar = hr[k], ai = hi[k];
        let br, bi;
        if (k === 0) { br = hr[m]; bi = hi[m]; }
        else { br = hr[m - k]; bi = -hi[m - k]; }
        const er = (ar + br) * 0.5, ei = (ai + bi) * 0.5;
        const dr = (ar - br) * 0.5, di = (ai - bi) * 0.5;
        const wr = wR[k], wi = -wI[k];
        const or = wr * dr - wi * di;
        const oi = wr * di + wi * dr;
        yr[k] = er - oi;
        yi[k] = ei + or;
      }
      core.ifft(yr, yi);
      for (let i = 0; i < m; i++) {
        out[2 * i] = yr[i];
        out[2 * i + 1] = yi[i];
      }
    }

    function inv(hr, hi) {
      const out = new Float64Array(n);
      invInto(hr, hi, out);
      return out;
    }

    return { n, m, fwd, inv, fwdInto, invInto };
  }

  /* 两个实序列的线性卷积（通用工具；核心反卷积用打包复变换）。 */
  function convolveReal(a, b, n) {
    const p = makeRealFFT(n);
    if (p.n !== n) throw new Error('FFT 计划长度不匹配');
    const pa = new Float64Array(n);
    const pb = new Float64Array(n);
    pa.set(a);
    pb.set(b);
    const A = p.fwd(pa);
    const B = p.fwd(pb);
    for (let k = 0; k <= p.m; k++) {
      const rr = A.re[k] * B.re[k] - A.im[k] * B.im[k];
      const ii = A.re[k] * B.im[k] + A.im[k] * B.re[k];
      A.re[k] = rr; A.im[k] = ii;
    }
    return p.inv(A.re, A.im);
  }

  return { nextPow2, isPow2, makeComplexFFT, makeRealFFT, convolveReal };
});
