/*
 * separator.js — 模板分轨核心算法
 *
 * 流程：STFT → 从参考区间提取非负模板 → 对混音每帧做非负最小二乘(NNLS)拟合
 * → 按各模板贡献比例做软掩蔽分配（共享频点按占比拆分，而不是整段判给一路）
 * → 用混音相位重建时域。各分轨掩蔽 + 剩余掩蔽逐频点之和恒为 1，
 * 因此各分轨 + 剩余声在时域精确加回混音（仅浮点误差），长度不变。
 *
 * FFT 为通用基-2 实现，可整体替换为任意通用 FFT 库；
 * 模板拟合、分配与重建为本文件自有实现。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- FFT
  // 就地复数 FFT，re/im 为等长 Float64Array，长度须为 2 的幂。
  function fft(re, im, inverse) {
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
      const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
      const wre = Math.cos(ang), wim = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curre = 1, curim = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = i + j + half;
          const vre = re[b] * curre - im[b] * curim;
          const vim = re[b] * curim + im[b] * curre;
          re[b] = re[a] - vre; im[b] = im[a] - vim;
          re[a] += vre; im[a] += vim;
          const nre = curre * wre - curim * wim;
          curim = curre * wim + curim * wre;
          curre = nre;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function hannWindow(N) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    return w;
  }

  // ---------------------------------------------------------------- STFT
  // 返回 { nFrames, nBins, re, im, mag, padLeft }，复数谱只存 0..N/2 共 nBins 个频点。
  // 左侧补 N/2 个零、末尾补零：Hann 窗在端点处权重为 0，不补边会导致
  // 首采样完全不被覆盖（重叠能量为 0，无法精确重建）。补边后每个输入采样
  // 都被正权重覆盖，ISTFT 除以实际重叠能量即可精确还原。
  function stft(x, N, hop) {
    const padLeft = Math.floor(N / 2);
    const total = x.length + padLeft; // 左侧补零后的有效长度
    const nFrames = Math.max(1, Math.ceil((total - N) / hop) + 1);
    const nBins = N / 2 + 1;
    const win = hannWindow(N);
    const re = new Float64Array(nFrames * nBins);
    const im = new Float64Array(nFrames * nBins);
    const mag = new Float32Array(nFrames * nBins);
    const fre = new Float64Array(N);
    const fim = new Float64Array(N);
    for (let t = 0; t < nFrames; t++) {
      const s = t * hop - padLeft; // 在原信号中的起始位置（可为负）
      fre.fill(0); fim.fill(0);
      for (let i = 0; i < N; i++) {
        const n = s + i;
        if (n >= 0 && n < x.length) fre[i] = x[n] * win[i];
      }
      fft(fre, fim, false);
      const off = t * nBins;
      for (let f = 0; f < nBins; f++) {
        re[off + f] = fre[f]; im[off + f] = fim[f];
        mag[off + f] = Math.hypot(fre[f], fim[f]);
      }
    }
    return { nFrames, nBins, re, im, mag, N, hop, padLeft };
  }

  // ---------------------------------------------------- 模板提取（非负）
  // 对参考音频 [startSec, endSec) 区间内的帧取幅度均值，归一化到最大值 1。
  // 幅度谱天然非负，即“从时频图提取的非负模板”。
  function extractTemplate(x, sampleRate, N, hop, startSec, endSec) {
    const nBins = N / 2 + 1;
    const win = hannWindow(N);
    const tpl = new Float64Array(nBins);
    const fre = new Float64Array(N);
    const fim = new Float64Array(N);
    let s0 = Math.max(0, Math.floor(startSec * sampleRate));
    let s1 = Math.min(x.length, Math.ceil(endSec * sampleRate));
    if (s1 <= s0) { s0 = 0; s1 = x.length; }
    let used = 0;
    for (let s = s0; s + N <= s1 || (s < s1 && s + N > s1 && s1 - s > N / 4); s += hop) {
      fre.fill(0); fim.fill(0);
      const cnt = Math.min(N, x.length - s);
      for (let i = 0; i < cnt; i++) fre[i] = x[s + i] * win[i];
      fft(fre, fim, false);
      for (let f = 0; f < nBins; f++) tpl[f] += Math.hypot(fre[f], fim[f]);
      used++;
      if (s + N > s1) break;
    }
    if (used === 0) throw new Error('参考区间太短，无法提取模板');
    let max = 0;
    for (let f = 0; f < nBins; f++) { tpl[f] /= used; if (tpl[f] > max) max = tpl[f]; }
    if (max <= 0) throw new Error('参考区间接近静音，无法提取模板');
    const out = new Float32Array(nBins);
    for (let f = 0; f < nBins; f++) out[f] = tpl[f] / max;
    return out;
  }

  // -------------------------------------------- NNLS 逐帧拟合（自有实现）
  // 对每帧幅度 v 解 min ||v - W a||² s.t. a>=0，W 为各参考模板（列）。
  // 用 Lee-Seung 乘性更新：a *= (Wᵀv) / (WᵀW a)。WᵀW 只算一次。
  function createFit(spec, templates) {
    const K = templates.length;
    const nBins = spec.nBins;
    const WtW = new Float64Array(K * K);
    for (let k = 0; k < K; k++)
      for (let j = 0; j < K; j++) {
        let s = 0;
        const Wk = templates[k], Wj = templates[j];
        for (let f = 0; f < nBins; f++) s += Wk[f] * Wj[f];
        WtW[k * K + j] = s;
      }
    const H = [];
    for (let k = 0; k < K; k++) H.push(new Float32Array(spec.nFrames));
    return { K, WtW, H };
  }

  // 拟合帧区间 [t0, t1)，可分段调用以刷新进度条。
  function fitFrames(fit, spec, templates, t0, t1, iterations) {
    const { K, WtW, H } = fit;
    const nBins = spec.nBins;
    const mag = spec.mag;
    const Wtv = new Float64Array(K);
    const denom = new Float64Array(K);
    const a = new Float64Array(K);
    for (let t = t0; t < t1; t++) {
      const off = t * nBins;
      for (let k = 0; k < K; k++) {
        const Wk = templates[k];
        let s = 0;
        for (let f = 0; f < nBins; f++) s += Wk[f] * mag[off + f];
        Wtv[k] = s;
      }
      for (let k = 0; k < K; k++) {
        const d = WtW[k * K + k];
        a[k] = d > 0 ? Math.max(Wtv[k] / d, 1e-12) : 0;
      }
      for (let it = 0; it < iterations; it++) {
        for (let k = 0; k < K; k++) {
          let s = 0;
          for (let j = 0; j < K; j++) s += WtW[k * K + j] * a[j];
          denom[k] = Math.max(s, 1e-20);
        }
        for (let k = 0; k < K; k++) a[k] = Math.max(a[k] * Wtv[k] / denom[k], 1e-12);
      }
      for (let k = 0; k < K; k++) H[k][t] = a[k];
    }
  }

  // 单频点占比查询（供频谱格子点击核对）：返回长度 K+1 的数组。
  function sharesAt(spec, templates, H, t, f) {
    const K = templates.length;
    const off = t * spec.nBins + f;
    const v = spec.mag[off];
    const parts = new Float64Array(K);
    let sum = 0;
    for (let k = 0; k < K; k++) { parts[k] = templates[k][f] * H[k][t]; sum += parts[k]; }
    const res = Math.max(v - sum, 0);
    const denom = sum + res;
    const out = new Float64Array(K + 1);
    if (denom > 0) {
      for (let k = 0; k < K; k++) out[k] = parts[k] / denom;
      out[K] = res / denom;
    }
    return { shares: out, mag: v, model: sum, residual: res };
  }

  // ------------------------------------------------------- 时域重建
  // 用混音复数谱（含混音相位）乘各软掩蔽，ISTFT 重叠叠加。
  function createReconstructor(spec, templates, length, N, hop) {
    const K = templates.length;
    const paddedLen = (spec.nFrames - 1) * hop + N;
    const padLeft = spec.padLeft || 0;
    const stems = [];
    for (let k = 0; k < K; k++) stems.push(new Float64Array(paddedLen));
    const residual = new Float64Array(paddedLen);
    const winSum = new Float64Array(paddedLen);
    const win = hannWindow(N);
    for (let t = 0; t < spec.nFrames; t++) {
      const s = t * hop;
      for (let i = 0; i < N; i++) winSum[s + i] += win[i] * win[i];
    }
    return { K, stems, residual, winSum, win, length, paddedLen, padLeft, N, hop };
  }

  // 重建帧区间 [t0, t1)，可分段调用以刷新进度条。
  // 软掩蔽分配说明：占比 = 该路重建量 / (各路重建量 + 剩余量)，
  // 剩余量 = max(实测幅度 - 各路重建量, 0)。全部占比（含剩余）逐频点之和
  // 恒为 1 —— 这是精确还原的关键。共享频点（如样例第 14 频点）按各路
  // 拟合贡献比例拆分，而不是整段判给某一路。
  function reconstructRange(rec, spec, templates, H, t0, t1) {
    const { K, N, win } = rec;
    const nBins = spec.nBins;
    const yre = new Float64Array(N);
    const yim = new Float64Array(N);
    const contrib = new Float64Array((K + 1) * nBins); // 每频点各路(含剩余)占比
    for (let t = t0; t < t1; t++) {
      const off = t * nBins;
      // 先算本帧全部频点的各路占比
      for (let f = 0; f < nBins; f++) {
        let sum = 0;
        for (let j = 0; j < K; j++) {
          const p = templates[j][f] * H[j][t];
          contrib[j * nBins + f] = p;
          sum += p;
        }
        const v = spec.mag[off + f];
        const res = Math.max(v - sum, 0);
        const denom = sum + res;
        if (denom > 0) {
          for (let j = 0; j < K; j++) contrib[j * nBins + f] /= denom;
          contrib[K * nBins + f] = res / denom;
        } else {
          for (let j = 0; j <= K; j++) contrib[j * nBins + f] = 0;
        }
      }
      // 每路：取自己的占比行，乘混音复数谱（保留混音相位），IFFT 叠加
      for (let k = 0; k <= K; k++) {
        const row = k * nBins;
        let any = false;
        for (let f = 0; f < nBins; f++) if (contrib[row + f] !== 0) { any = true; break; }
        if (!any) continue;
        // 组装 Hermitian 全谱：bin f 与 N-f 共轭
        yre.fill(0); yim.fill(0);
        for (let f = 0; f < nBins; f++) {
          const m = contrib[row + f];
          yre[f] = m * spec.re[off + f];
          yim[f] = m * spec.im[off + f];
        }
        for (let f = 1; f < nBins - 1; f++) {
          yre[N - f] = yre[f];
          yim[N - f] = -yim[f];
        }
        fft(yre, yim, true);
        const out = k < K ? rec.stems[k] : rec.residual;
        const s = t * rec.hop;
        for (let i = 0; i < N; i++) out[s + i] += yre[i] * win[i];
      }
    }
  }

  // 收尾：除以窗函数重叠能量、按 padLeft 对齐截到原始长度，并校验加和误差。
  function finalizeReconstruction(rec, mixture) {
    const len = rec.length;
    const P = rec.padLeft;
    const outs = rec.stems.map(s => {
      const o = new Float32Array(len);
      for (let n = 0; n < len; n++) o[n] = s[n + P] / rec.winSum[n + P];
      return o;
    });
    const res = new Float32Array(len);
    for (let n = 0; n < len; n++) res[n] = rec.residual[n + P] / rec.winSum[n + P];
    let maxErr = 0;
    for (let n = 0; n < len; n++) {
      let sum = res[n];
      for (let k = 0; k < outs.length; k++) sum += outs[k][n];
      const e = Math.abs(sum - mixture[n]);
      if (e > maxErr) maxErr = e;
    }
    return { stems: outs, residual: res, maxErr, length: len };
  }

  // ---------------------------------------------------------------- WAV
  function decodeWav(buf) {
    const dv = new DataView(buf);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是有效的 WAV 文件');
    let off = 12, fmt = null, data = null;
    while (off + 8 <= dv.byteLength) {
      const id = tag(off), size = dv.getUint32(off + 4, true);
      if (id === 'fmt ') {
        fmt = {
          format: dv.getUint16(off + 8, true),
          channels: dv.getUint16(off + 10, true),
          sampleRate: dv.getUint32(off + 12, true),
          bits: dv.getUint16(off + 22, true),
        };
      } else if (id === 'data') {
        data = { off: off + 8, size };
      }
      off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
    const n = Math.floor(data.size / (fmt.bits / 8) / fmt.channels);
    const samples = new Float32Array(n);
    const d0 = data.off;
    for (let i = 0; i < n; i++) {
      const o = d0 + i * fmt.channels * (fmt.bits / 8);
      let v;
      if (fmt.format === 1 && fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (fmt.format === 1 && fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else if (fmt.format === 1 && fmt.bits === 24) {
        const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
        let x = b0 | (b1 << 8) | (b2 << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (fmt.format === 1 && fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
      else throw new Error(`不支持的 WAV 格式：format=${fmt.format} bits=${fmt.bits}`);
      samples[i] = v;
    }
    return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, format: fmt.format };
  }

  // 导出 32 位浮点 WAV（format=3）
  function encodeWavFloat32(samples, sampleRate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 4);
    const dv = new DataView(buf);
    const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    put(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); put(8, 'WAVE');
    put(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 3, true);          // IEEE float
    dv.setUint16(22, 1, true);          // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 32, true);
    put(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, samples[i], true);
    return buf;
  }

  const Separator = {
    fft, hannWindow, stft, extractTemplate,
    createFit, fitFrames, sharesAt,
    createReconstructor, reconstructRange, finalizeReconstruction,
    decodeWav, encodeWavFloat32,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Separator;
  else global.Separator = Separator;
})(typeof window !== 'undefined' ? window : globalThis);
