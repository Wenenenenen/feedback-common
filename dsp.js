/*
 * dsp.js — 局部频谱修复核心：WAV 解码/编码、FFT、STFT 频谱衰减处理。
 * 浏览器（window.SpectralDSP）与 Node（module.exports）通用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpectralDSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- WAV 解码 ----------------
   * 仅接受 PCM(format=1) 16/24bit，单/双声道。
   * 返回 { sampleRate, channels, bitsPerSample, frames,
   *        ints:   [Int32Array]   每声道原始整数值（右对齐）
   *        floats: [Float64Array] 每声道归一化浮点值 int/2^(bits-1) }
   */
  function decodeWav(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 44 || dv.getUint32(0, false) !== 0x52494646 /*RIFF*/ ||
        dv.getUint32(8, false) !== 0x57415645 /*WAVE*/) {
      throw new Error('不是有效的 RIFF/WAVE 文件');
    }
    let pos = 12, fmt = null, dataOff = -1, dataSize = 0;
    while (pos + 8 <= buf.byteLength) {
      const id = dv.getUint32(pos, false);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 0x666d7420 /*fmt */) {
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461 /*data*/) {
        dataOff = body; dataSize = Math.min(size, buf.byteLength - body);
      }
      pos = body + size + (size & 1); // 块按偶数字节对齐
    }
    if (!fmt) throw new Error('缺少 fmt 块');
    if (dataOff < 0) throw new Error('缺少 data 块');
    if (fmt.format !== 1) throw new Error('仅支持 PCM 格式（不支持浮点/压缩）');
    if (fmt.bits !== 16 && fmt.bits !== 24) throw new Error('仅支持 16/24 位 PCM');
    if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('仅支持单声道或双声道');
    const bytesPer = fmt.bits / 8;
    const frames = Math.floor(dataSize / (bytesPer * fmt.channels));
    const ints = [], floats = [];
    for (let c = 0; c < fmt.channels; c++) {
      ints.push(new Int32Array(frames));
      floats.push(new Float64Array(frames));
    }
    const norm = 1 / (1 << (fmt.bits - 1));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < fmt.channels; c++) {
        const off = dataOff + (i * fmt.channels + c) * bytesPer;
        let v;
        if (bytesPer === 2) {
          v = dv.getInt16(off, true);
        } else {
          v = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16);
          if (v & 0x800000) v -= 0x1000000; // 24bit 符号扩展
        }
        ints[c][i] = v;
        floats[c][i] = v * norm;
      }
    }
    return {
      sampleRate: fmt.sampleRate, channels: fmt.channels,
      bitsPerSample: fmt.bits, frames, ints, floats,
    };
  }

  /* ---------------- WAV 编码 ----------------
   * channelInts: 每声道 Int32Array（原始整数值），各声道长度一致。
   * 输出 PCM WAV（16字节 fmt 块），与常见解码器兼容。
   */
  function encodeWav(opts) {
    const { sampleRate, bitsPerSample } = opts;
    const chans = opts.channelInts;
    const channels = chans.length;
    const frames = chans[0].length;
    const bytesPer = bitsPerSample / 8;
    const dataSize = frames * channels * bytesPer;
    const buf = new ArrayBuffer(44 + dataSize + (dataSize & 1));
    const dv = new DataView(buf);
    const w32 = (o, v) => dv.setUint32(o, v, true);
    const w16 = (o, v) => dv.setUint16(o, v, true);
    dv.setUint32(0, 0x52494646, false);          // RIFF
    w32(4, 36 + dataSize);
    dv.setUint32(8, 0x57415645, false);          // WAVE
    dv.setUint32(12, 0x666d7420, false);         // fmt
    w32(16, 16);
    w16(20, 1);                                  // PCM
    w16(22, channels);
    w32(24, sampleRate);
    w32(28, sampleRate * channels * bytesPer);
    w16(32, channels * bytesPer);
    w16(34, bitsPerSample);
    dv.setUint32(36, 0x64617461, false);         // data
    w32(40, dataSize);
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const v = chans[c][i];
        if (bytesPer === 2) {
          dv.setInt16(off, v, true); off += 2;
        } else {
          dv.setUint8(off, v & 0xff);
          dv.setUint8(off + 1, (v >> 8) & 0xff);
          dv.setUint8(off + 2, (v >> 16) & 0xff);
          off += 3;
        }
      }
    }
    return buf;
  }

  /* 浮点 [-1,1) → 整数量化（四舍五入 + 钳位） */
  function floatsToInts(floats, bits) {
    const scale = 1 << (bits - 1);
    const lo = -(1 << (bits - 1)), hi = (1 << (bits - 1)) - 1;
    const out = new Int32Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      let v = Math.round(floats[i] * scale);
      if (v < lo) v = lo; else if (v > hi) v = hi;
      out[i] = v;
    }
    return out;
  }

  /* ---------------- FFT（基-2 迭代，原地） ---------------- */
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {           // 位反转重排
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
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curR = 1, curI = 0;
        for (let k = 0; k < half; k++) {
          const aR = re[i + k], aI = im[i + k];
          const bR = re[i + k + half] * curR - im[i + k + half] * curI;
          const bI = re[i + k + half] * curI + im[i + k + half] * curR;
          re[i + k] = aR + bR; im[i + k] = aI + bI;
          re[i + k + half] = aR - bR; im[i + k + half] = aI - bI;
          const nR = curR * wr - curI * wi;
          curI = curR * wi + curI * wr; curR = nR;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /* ---------------- STFT 处理器 ----------------
   * Hann 窗（周期），hop = N/4，分析/合成同窗，COLA 和 = 3/2（常数），
   * 增益全 1 时精确重建（浮点误差量级）。
   *
   * 选框: { start, end (秒), low, high (Hz), attenDb (0..60),
   *         channels: [0..], enabled }
   * 重叠取最大衰减（线性增益取 min），不相加。
   * 频率/时间边缘在框内做余弦斜坡平滑；贴 0Hz / Nyquist / 首尾边界的
   * 边缘不做斜坡（端点全深度覆盖）。
   */
  const FFT_SIZE = 4096;
  const HOP = FFT_SIZE / 4;
  const TIME_RAMP = 0.01;                       // 10ms 时间过渡
  const FREQ_RAMP_BINS = 2;                     // 至少 2 个频点过渡
  const FREQ_RAMP_RATIO = 0.08;                 // 或带宽的 8%

  function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  // 单个选框的频率增益向量（长度 N/2+1），1 = 不衰减
  function boxFreqGain(box, sampleRate) {
    const bins = FFT_SIZE / 2 + 1;
    const g = new Float64Array(bins).fill(1);
    const binHz = sampleRate / FFT_SIZE;
    const gMin = Math.pow(10, -box.attenDb / 20);
    const lo = Math.max(0, box.low), hi = Math.min(sampleRate / 2, box.high);
    if (hi <= lo) return g;
    let ramp = Math.min(Math.max(FREQ_RAMP_BINS * binHz, FREQ_RAMP_RATIO * (hi - lo)), (hi - lo) / 2);
    const rampLo = lo <= 0 ? 0 : ramp;              // 贴直流端不做下斜坡
    const rampHi = hi >= sampleRate / 2 ? 0 : ramp; // 贴 Nyquist 端不做上斜坡
    for (let b = 0; b < bins; b++) {
      const f = b * binHz;
      if (f < lo || f > hi) { g[b] = 1; continue; }
      let s = 1; // 衰减深度 0..1
      if (rampLo > 0 && f < lo + rampLo) s = 0.5 - 0.5 * Math.cos(Math.PI * (f - lo) / rampLo);
      if (rampHi > 0 && f > hi - rampHi) {
        const s2 = 0.5 - 0.5 * Math.cos(Math.PI * (hi - f) / rampHi);
        s = Math.min(s, s2);
      }
      g[b] = 1 - s * (1 - gMin);
    }
    return g;
  }

  // 单个选框在时刻 t 的时间包络 0..1
  function boxTimeEnv(box, t, duration) {
    // 贴首/尾边界的选框向文件外延伸（边界帧中心可能落在 [0,duration] 外）
    const t0 = box.start <= 0 ? -Infinity : box.start;
    const t1 = box.end >= duration ? Infinity : box.end;
    if (t < t0 || t > t1) return 0;
    const c0 = Math.max(0, box.start), c1 = Math.min(duration, box.end);
    if (c1 <= c0) return 0;
    const ramp = Math.min(TIME_RAMP, (c1 - c0) / 2);
    let s = 1;
    if (box.start > 0 && ramp > 0 && t < box.start + ramp) s = 0.5 - 0.5 * Math.cos(Math.PI * (t - box.start) / ramp);
    if (box.end < duration && ramp > 0 && t > box.end - ramp) {
      const s2 = 0.5 - 0.5 * Math.cos(Math.PI * (box.end - t) / ramp);
      s = Math.min(s, s2);
    }
    return s;
  }

  /* 创建分步处理器。
   * channelFloats: [Float64Array]，boxes: 选框数组（只处理 enabled 的）。
   * 返回 { totalFrames, step(budget)->已处理帧数, done, result()->[Float64Array] }
   */
  function createProcessor(channelFloats, sampleRate, boxes) {
    const numCh = channelFloats.length;
    const len = channelFloats[0].length;
    const win = hannWindow(FFT_SIZE);
    const COLA = 1.5;
    const leftPad = FFT_SIZE - HOP; // 保证每个采样都被 4 帧完整覆盖（COLA）
    const numFrames = Math.max(1, Math.floor((leftPad + len - 1) / HOP) + 1);
    const bufLen = numFrames * HOP + FFT_SIZE;

    const active = boxes.filter(b => b.enabled && b.attenDb > 0 && b.end > b.start && b.high > b.low);
    const duration = len / sampleRate;
    // 每选框预计算频率增益向量
    const prepared = active.map(b => ({
      box: b,
      freqGain: boxFreqGain(b, sampleRate),
      chans: b.channels.filter(c => c >= 0 && c < numCh),
    }));

    const padded = [], out = [];
    for (let c = 0; c < numCh; c++) {
      padded.push(new Float64Array(bufLen));
      padded[c].set(channelFloats[c], leftPad);
      out.push(new Float64Array(bufLen));
    }
    const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
    const G = new Float64Array(FFT_SIZE / 2 + 1);
    let frameIdx = 0;

    function processFrame() {
      const p = frameIdx * HOP;
      const t = (p + FFT_SIZE / 2 - leftPad) / sampleRate; // 帧中心时刻
      // 每声道：先算该帧各选框时间包络，若无任何衰减则直接重建
      for (let c = 0; c < numCh; c++) {
        let any = false;
        G.fill(1);
        for (const pr of prepared) {
          if (!pr.chans.includes(c)) continue;
          const s = boxTimeEnv(pr.box, t, duration);
          if (s <= 0) continue;
          any = true;
          const fg = pr.freqGain;
          for (let b = 0; b < G.length; b++) {
            const cand = 1 - s * (1 - fg[b]);
            if (cand < G[b]) G[b] = cand; // 重叠取最大衰减
          }
        }
        const src = padded[c];
        for (let i = 0; i < FFT_SIZE; i++) { re[i] = src[p + i] * win[i]; im[i] = 0; }
        fft(re, im, false);
        if (any) {
          const bins = G.length;
          for (let b = 0; b < bins; b++) {
            const g = G[b];
            re[b] *= g; im[b] *= g;
            const m = FFT_SIZE - b; // 共轭对称，保持实信号
            if (m < FFT_SIZE && m !== b) { re[m] *= g; im[m] *= g; }
          }
        }
        fft(re, im, true);
        const dst = out[c];
        for (let i = 0; i < FFT_SIZE; i++) dst[p + i] += re[i] * win[i];
      }
      frameIdx++;
    }

    return {
      totalFrames: numFrames,
      get done() { return frameIdx >= numFrames; },
      step(budget) {
        const end = Math.min(numFrames, frameIdx + budget);
        while (frameIdx < end) processFrame();
        return frameIdx;
      },
      result() {
        return out.map(o => {
          const r = new Float64Array(len);
          for (let i = 0; i < len; i++) r[i] = o[leftPad + i] / COLA;
          return r;
        });
      },
    };
  }

  /* 同步便捷封装 */
  function processAudio(channelFloats, sampleRate, boxes) {
    const proc = createProcessor(channelFloats, sampleRate, boxes);
    while (!proc.done) proc.step(256);
    return proc.result();
  }

  return {
    decodeWav, encodeWav, floatsToInts, fft,
    createProcessor, processAudio,
    boxFreqGain, boxTimeEnv,
    FFT_SIZE, HOP,
  };
});
