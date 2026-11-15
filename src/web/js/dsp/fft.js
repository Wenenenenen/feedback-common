/*
 * 原地迭代 radix-2 复数 FFT，数据按 [re0, im0, re1, im1, ...] 交错存放。
 * 长度必须是 2 的幂；所有旋转因子只预计算一次，可在多个任务中复用。
 */

export class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT 长度必须是 2 的幂：${size}`);
    }
    this.size = size;
    this.bits = Math.log2(size);

    const reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < this.bits; b++) r = (r << 1) | ((i >> b) & 1);
      reversed[i] = r;
    }
    this.reversed = reversed;

    this.cos = new Float64Array(size >> 1);
    this.sin = new Float64Array(size >> 1);
    for (let i = 0; i < size >> 1; i++) {
      const angle = (2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
  }

  /**
   * @param {Float64Array} data 交错复数数组，长度 >= offset + 2*size
   * @param {number} offset 起始元素下标（交错下标）
   * @param {boolean} inverse 逆变换（含 1/N 缩放）
   */
  transform(data, offset = 0, inverse = false) {
    const n = this.size;
    const rev = this.reversed;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = offset + 2 * i;
        const b = offset + 2 * j;
        const tr = data[a];
        const ti = data[a + 1];
        data[a] = data[b];
        data[a + 1] = data[b + 1];
        data[b] = tr;
        data[b + 1] = ti;
      }
    }

    const cos = this.cos;
    const sin = this.sin;
    const sign = inverse ? 1 : -1;

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        const startOffset = offset + 2 * start;
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = cos[tw];
          const wi = sign * sin[tw];
          const a = startOffset + 2 * j;
          const b = a + 2 * half;
          const br = data[b];
          const bi = data[b + 1];
          const vr = br * wr - bi * wi;
          const vi = br * wi + bi * wr;
          const ar = data[a];
          const ai = data[a + 1];
          data[a] = ar + vr;
          data[a + 1] = ai + vi;
          data[b] = ar - vr;
          data[b + 1] = ai - vi;
        }
      }
    }

    if (inverse) {
      const scale = 1 / n;
      const end = offset + 2 * n;
      for (let i = offset; i < end; i++) data[i] *= scale;
    }
  }
}

const fftCache = new Map();

export function getFFT(size) {
  let fft = fftCache.get(size);
  if (!fft) {
    fft = new FFT(size);
    fftCache.set(size, fft);
  }
  return fft;
}
