/*
 * dsp.js — 频域陷波去网纹的数学核心（无任何现成 FFT / 滤波库）
 *
 * 变换约定（见 samples 约定.json）：
 *   前向 DFT: X[k] = Σ x[n] exp(-2πi·k·n/N)，不归一化
 *   逆向 DFT: x[n] = (1/N) Σ X[k] exp(+2πi·k·n/N)
 *   二维变换按轴依次执行。
 * 本文件同时可在浏览器（全局 FNC_DSP）与 Node（module.exports）中使用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FNC_DSP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 基本工具 ---------------- */

  function nextPow2(n) {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function isPow2(n) {
    return n >= 1 && (n & (n - 1)) === 0;
  }

  // 两轴环形（torus）最短环绕距离
  function wrapDelta(a, b, N) {
    let d = a - b;
    d = ((d % N) + N) % N;
    if (d > N / 2) d -= N;
    return d;
  }

  /* ---------------- sRGB <-> 线性 RGB ---------------- */

  function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgbByte(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    // 限幅 + 四舍五入到 8 位
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  /*
   * 把 8 位 sRGB ImageData 解码为三个 Float64 线性通道。
   * 输入: ImageData 风格对象 {width,height,data:Uint8ClampedArray}
   * 输出: {width,height,channels:[Float64Array x3]}（逐通道、行主序）
   */
  function decodeLinearRGB(imageData) {
    const { width: w, height: h, data } = imageData;
    const n = w * h;
    const channels = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      channels[0][i] = srgbToLinear(data[p]);
      channels[1][i] = srgbToLinear(data[p + 1]);
      channels[2][i] = srgbToLinear(data[p + 2]);
    }
    return { width: w, height: h, channels };
  }

  /* ---------------- 一维 radix-2 FFT（手写，迭代 Cooley–Tukey） ----------------
   * re/im: Float64Array，长度必须为 2 的幂；原地变换。
   * inverse=false: 前向 exp(-2πi...)；inverse=true: 逆向并除以 N。
   */
  function fft1d(re, im, inverse) {
    const N = re.length;
    if (N === 1) return;
    if (!isPow2(N)) throw new Error('fft1d 仅支持 2 的幂长度，收到 ' + N);

    // 位逆序置换
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const ang = (sign * 2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let start = 0; start < N; start += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < half; k++) {
          const a = start + k;
          const b = a + half;
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

    if (inverse) {
      for (let i = 0; i < N; i++) {
        re[i] /= N;
        im[i] /= N;
      }
    }
  }

  /* ---------------- 二维 FFT（按轴执行） ----------------
   * 输入/输出: {width:W, height:H, re, im}，长度 W*H 的行主序数组。
   * 先对每一行（宽度轴）做 1D FFT，再对每一列（高度轴）做。
   */
  function fft2d(plane, inverse) {
    const W = plane.width, H = plane.height;
    const { re, im } = plane;

    // 行变换：长度 W
    const rowRe = new Float64Array(W);
    const rowIm = new Float64Array(W);
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        rowRe[x] = re[base + x];
        rowIm[x] = im[base + x];
      }
      fft1d(rowRe, rowIm, inverse);
      for (let x = 0; x < W; x++) {
        re[base + x] = rowRe[x];
        im[base + x] = rowIm[x];
      }
    }

    // 列变换：长度 H
    const colRe = new Float64Array(H);
    const colIm = new Float64Array(H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        colRe[y] = re[y * W + x];
        colIm[y] = im[y * W + x];
      }
      fft1d(colRe, colIm, inverse);
      for (let y = 0; y < H; y++) {
        re[y * W + x] = colRe[y];
        im[y * W + x] = colIm[y];
      }
    }
  }

  /* ---------------- 填充 ----------------
   * 右侧与底部填充至各轴不小于原尺寸的最小 2 次幂。
   * mode: 'zero' | 'reflect101'（对称反射，不重复边缘）。
   * 长度 1 恒取自身。
   */
  function paddedSize(w, h) {
    return { W: nextPow2(w), H: nextPow2(h) };
  }

  function padChannel(src, w, h, W, H, mode) {
    const dst = new Float64Array(W * H);
    if (mode === 'zero') {
      for (let y = 0; y < h; y++) {
        const sb = y * w, db = y * W;
        dst.set(src.subarray(sb, sb + w), db);
      }
      return dst;
    }
    if (mode !== 'reflect101') throw new Error('未知填充模式: ' + mode);
    // reflect101: 对任意目标坐标，映射回源坐标
    const mapIdx = (i, n) => {
      if (n === 1) return 0;
      const period = 2 * (n - 1);
      let m = ((i % period) + period) % period;
      if (m >= n) m = period - m;
      return m;
    };
    for (let y = 0; y < H; y++) {
      const sy = mapIdx(y, h);
      const db = y * W, sb = sy * w;
      for (let x = 0; x < W; x++) {
        dst[db + x] = src[sb + mapIdx(x, w)];
      }
    }
    return dst;
  }

  function padImage(decoded, mode) {
    const { width: w, height: h, channels } = decoded;
    const { W, H } = paddedSize(w, h);
    return {
      width: w, height: h, W, H, mode,
      channels: channels.map((c) => padChannel(c, w, h, W, H, mode)),
    };
  }

  /* ---------------- 陷波滤波器 H ----------------
   * notches: [{u, v, sigma, strength}]，u/v 为未 shift 的整数频率索引。
   * 每组中心 = (u,v) 与 (-u mod W, -v mod H)，相同点仅一次；
   * 全部组的唯一中心合并，每个中心一个高斯 G，连乘；H(0,0) 强制为 1。
   * 返回 Float64Array(W*H)，未 shift 布局。
   */
  function uniqueCenters(notches, W, H) {
    const seen = new Set();
    const out = [];
    for (const n of notches) {
      const u = ((n.u % W) + W) % W;
      const v = ((n.v % H) + H) % H;
      const cands = [[u, v], [(-u + W) % W, (-v + H) % H]];
      for (const [cu, cv] of cands) {
        const key = cu + ',' + cv;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ u: cu, v: cv, sigma: n.sigma, strength: n.strength });
        }
      }
    }
    return out;
  }

  function buildFilter(W, H, notches) {
    const Hfilter = new Float64Array(W * H).fill(1);
    if (!notches || notches.length === 0) return Hfilter;

    const centers = uniqueCenters(notches, W, H);
    for (const q of centers) {
      const s2 = 2 * q.sigma * q.sigma;
      for (let v = 0; v < H; v++) {
        const dv = wrapDelta(v, q.v, H);
        const base = v * W;
        for (let u = 0; u < W; u++) {
          const du = wrapDelta(u, q.u, W);
          const d2 = du * du + dv * dv;
          const g = 1 - q.strength * Math.exp(-d2 / s2);
          Hfilter[base + u] *= g;
        }
      }
    }
    // 直流始终保留
    Hfilter[0] = 1;
    return Hfilter;
  }

  /* ---------------- 整条处理流水线 ----------------
   * decoded: decodeLinearRGB 的输出
   * mode: 'zero' | 'reflect101'
   * notches: 陷波组数组
   * 返回:
   *   { width,height,W,H, mode, notches, centers,
   *     spectra:[{re,im} x3],            // 滤波前频谱（未 shift）
   *     filteredSpectra:[{re,im} x3],    // 滤波后频谱（未 shift）
   *     outputChannels:[Float64Array x3] // 原尺寸区域内的逆变换实部（线性）
   *     maxImag,                          // 限幅前最大虚部（原尺寸区域）
   *     beforeMeans, afterMeans,          // 原尺寸区域三通道均值（线性）
   *     notchReport:[...] }               // 陷波中心前后幅值
   */
  function process(decoded, mode, notches) {
    const padded = padImage(decoded, mode);
    const { width: w, height: h, W, H } = padded;
    const nOut = w * h;

    const Hfilter = buildFilter(W, H, notches);
    const centers = uniqueCenters(notches, W, H);

    const spectra = [];
    const filteredSpectra = [];
    const outputChannels = [];
    const beforeMeans = [0, 0, 0];
    const afterMeans = [0, 0, 0];
    let maxImag = 0;

    for (let ch = 0; ch < 3; ch++) {
      const re = padded.channels[ch].slice();
      const im = new Float64Array(W * H);
      const plane = { width: W, height: H, re, im };
      fft2d(plane, false);
      spectra.push({ re: re.slice(), im: im.slice() });

      // 三通道共用同一 H
      const fre = new Float64Array(W * H);
      const fim = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) {
        fre[i] = re[i] * Hfilter[i];
        fim[i] = im[i] * Hfilter[i];
      }
      filteredSpectra.push({ re: fre.slice(), im: fim.slice() });

      const inv = { width: W, height: H, re: fre, im: fim };
      fft2d(inv, true);

      const out = new Float64Array(nOut);
      for (let y = 0; y < h; y++) {
        const base = y * W;
        for (let x = 0; x < w; x++) {
          const idx = base + x;
          out[y * w + x] = fre[idx];
          const ai = Math.abs(fim[idx]);
          if (ai > maxImag) maxImag = ai;
        }
      }
      outputChannels.push(out);

      for (let i = 0; i < nOut; i++) {
        beforeMeans[ch] += decoded.channels[ch][i];
        afterMeans[ch] += out[i];
      }
      beforeMeans[ch] /= nOut;
      afterMeans[ch] /= nOut;
    }

    // 陷波中心前后幅值（取自第 0 通道即可表征；三通道共用 H，位置一致）
    const spec0 = spectra[0];
    const fspec0 = filteredSpectra[0];
    const notchReport = centers.map((q) => {
      const i = q.v * W + q.u;
      const mag = (s) => Math.hypot(s.re[i], s.im[i]);
      return {
        u: q.u, v: q.v,
        sigma: q.sigma, strength: q.strength,
        magnitudeBefore: mag(spec0),
        magnitudeAfter: mag(fspec0),
      };
    });

    return {
      width: w, height: h, W, H, mode,
      notches: notches.map((n) => ({ ...n })),
      centers,
      Hfilter,
      spectra,
      filteredSpectra,
      outputChannels,
      maxImag,
      beforeMeans,
      afterMeans,
      notchReport,
    };
  }

  /* 把线性输出通道编码为 sRGB 位图（裁回原尺寸、限幅）。
   * 浏览器返回 ImageData；无 ImageData 的环境（Node 测试）返回普通对象。 */
  function encodeOutput(result) {
    const { width: w, height: h, outputChannels } = result;
    const n = w * h;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      data[p] = linearToSrgbByte(outputChannels[0][i]);
      data[p + 1] = linearToSrgbByte(outputChannels[1][i]);
      data[p + 2] = linearToSrgbByte(outputChannels[2][i]);
      data[p + 3] = 255;
    }
    if (typeof ImageData !== 'undefined') return new ImageData(data, w, h);
    return { width: w, height: h, data };
  }

  /* 频谱幅值（用于居中显示），返回对数压缩后的 Float64 视图（未 shift） */
  function magnitudeLog(spectrum) {
    const { re, im } = spectrum;
    const n = re.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.log1p(Math.hypot(re[i], im[i]));
    }
    return out;
  }

  // 未 shift 索引 -> 居中显示坐标
  function unshiftToShift(u, W) {
    return (u + (W >> 1)) % W;
  }
  function shiftToUnshift(x, W) {
    return (x + (W >> 1)) % W;
  }

  return {
    nextPow2, isPow2, wrapDelta,
    srgbToLinear, linearToSrgbByte, decodeLinearRGB,
    fft1d, fft2d,
    paddedSize, padChannel, padImage,
    uniqueCenters, buildFilter,
    process, encodeOutput,
    magnitudeLog, unshiftToShift, shiftToUnshift,
  };
});
