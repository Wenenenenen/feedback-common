/*
 * dither-core.js — integer bit-depth reduction with TPDF dither and error feedback.
 *
 * All arithmetic is exact integer arithmetic (|values| stay well inside
 * Number.MAX_SAFE_INTEGER; the RNG state is kept in uint32 via |0 / >>>0).
 *
 * Per channel c and sample n:
 *   if n is a reset frame for channel c: state = seed; e = 0
 *   state = xorshift32(state); w1 = state
 *   state = xorshift32(state); w2 = state
 *   d = (w1 & (2^k - 1)) - (w2 & (2^k - 1))
 *   v0 = x + floor(3e / 4)              // floor, also for negative e
 *   v  = v0 + d
 *   q  = round-half-to-even of v onto multiples of 2^k
 *   if q < -32768 or q > 32768 - 2^k:  y = clamp(q); e_next = 0
 *   else:                              y = q;       e_next = v0 - q
 *
 * Channels keep independent RNG states. A selection is rendered by running
 * the full channel and slicing it, so selected samples are bit-identical to
 * the full-track render.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DitherCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function xorshift32(x) {
    x = x | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  }

  function floorDiv4(a) {
    // exact floor of a/4 for any integer a (a can be negative)
    return Math.floor(a / 4);
  }

  function roundHalfEven(v, step) {
    const half = step >> 1;
    const t = v - half;
    const low = t - (t % step); // greatest multiple of step <= v - half
    const dist = v - low;
    if (dist < half) return low;
    if (dist > half) return low + step;
    // exact half step: even step-index wins
    return (low / step) % 2 === 0 ? low : low + step;
  }

  /**
   * Process one channel.
   * @param {Int16Array} samples input PCM samples
   * @param {number} seed non-zero uint32
   * @param {Int32Array|number[]} resetFrames sorted reset frame indices
   * @param {number} k discarded bits, 2..12
   * @param {object} [detail] optional, receives per-sample arrays when provided
   */
  function processChannel(samples, seed, resetFrames, k, detail) {
    const n = samples.length;
    const out = new Int16Array(n);
    const step = 1 << k;
    const mask = step - 1;
    const lo = -32768;
    const hi = 32768 - step;
    let state = seed >>> 0;
    if (state === 0) throw new Error("seed must be a non-zero 32-bit value");
    let e = 0;
    let resetIdx = 0;
    const resetCount = resetFrames ? resetFrames.length : 0;

    let w1Arr, w2Arr, dArr, v0Arr, vArr, qArr, eInArr, eOutArr, clampArr;
    if (detail) {
      w1Arr = new Uint32Array(n);
      w2Arr = new Uint32Array(n);
      dArr = new Int32Array(n);
      v0Arr = new Int32Array(n);
      vArr = new Int32Array(n);
      qArr = new Int32Array(n);
      eInArr = new Int32Array(n);
      eOutArr = new Int32Array(n);
      clampArr = new Uint8Array(n);
    }

    for (let i = 0; i < n; i++) {
      while (resetIdx < resetCount && resetFrames[resetIdx] < i) resetIdx++;
      if (resetIdx < resetCount && resetFrames[resetIdx] === i) {
        state = seed >>> 0;
        e = 0;
        resetIdx++;
      }
      const eIn = e;

      state = xorshift32(state);
      const w1 = state;
      state = xorshift32(state);
      const w2 = state;

      const d = (w1 & mask) - (w2 & mask);
      const v0 = samples[i] + floorDiv4(3 * e);
      const v = v0 + d;
      let q = roundHalfEven(v, step);
      let y;
      let clamped = 0;
      if (q < lo || q > hi) {
        y = q < lo ? lo : hi;
        e = 0;
        clamped = 1;
      } else {
        y = q;
        e = v0 - q;
      }
      out[i] = y;

      if (detail) {
        w1Arr[i] = w1;
        w2Arr[i] = w2;
        dArr[i] = d;
        v0Arr[i] = v0;
        vArr[i] = v;
        qArr[i] = q;
        eInArr[i] = eIn;
        eOutArr[i] = e;
        clampArr[i] = clamped;
      }
    }

    if (detail) {
      detail.w1 = w1Arr;
      detail.w2 = w2Arr;
      detail.d = dArr;
      detail.v0 = v0Arr;
      detail.v = vArr;
      detail.q = qArr;
      detail.eIn = eInArr;
      detail.eOut = eOutArr;
      detail.clamped = clampArr;
    }
    return out;
  }

  /* ---------------- WAV parsing / encoding (PCM 16-bit) ---------------- */

  function parseWav(buffer) {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (bytes.length < 44 ||
        String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
        String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") {
      throw new Error("不是 RIFF/WAVE 文件");
    }
    let p = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = 0;
    while (p + 8 <= bytes.length) {
      const id = String.fromCharCode(...bytes.subarray(p, p + 4));
      const size = dv.getUint32(p + 4, true);
      const body = p + 8;
      if (id === "fmt ") {
        fmt = {
          audioFormat: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bitsPerSample: dv.getUint16(body + 14, true),
        };
      } else if (id === "data") {
        dataOffset = body;
        dataSize = size;
      }
      p = body + size + (size & 1);
    }
    if (!fmt) throw new Error("WAV 缺少 fmt 块");
    if (dataOffset < 0) throw new Error("WAV 缺少 data 块");
    if (fmt.audioFormat !== 1) {
      throw new Error("仅支持无压缩 PCM（audioFormat=1），当前为 " + fmt.audioFormat);
    }
    if (fmt.bitsPerSample !== 16) {
      throw new Error("仅支持 16 位 PCM，当前为 " + fmt.bitsPerSample + " 位");
    }
    if (fmt.channels < 1 || fmt.channels > 2) {
      throw new Error("仅支持单声道或双声道，当前声道数 " + fmt.channels);
    }
    if (fmt.sampleRate !== 48000) {
      throw new Error("仅支持 48kHz 采样率，当前为 " + fmt.sampleRate + "Hz");
    }
    const frameBytes = fmt.channels * 2;
    const frames = Math.floor(dataSize / frameBytes);
    const channels = [];
    for (let c = 0; c < fmt.channels; c++) {
      const arr = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        arr[i] = dv.getInt16(dataOffset + (i * frameBytes + c * 2), true);
      }
      channels.push(arr);
    }
    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      frames,
      channelData: channels,
    };
  }

  function encodeWav(sampleRate, channelData) {
    const nch = channelData.length;
    const frames = channelData[0].length;
    const dataSize = frames * nch * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
    };
    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, nch, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * nch * 2, true); // byte rate
    dv.setUint16(32, nch * 2, true);      // block align
    dv.setUint16(34, 16, true);
    writeStr(36, "data");
    dv.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        dv.setInt16(off, channelData[c][i], true);
        off += 2;
      }
    }
    return buffer;
  }

  /**
   * Render every channel of a parsed WAV with the given settings.
   * @returns {{outputs: Int16Array[], frames: number}}
   */
  function renderAll(wav, settings, onProgress) {
    const k = settings.k;
    const outputs = [];
    for (let c = 0; c < wav.channels; c++) {
      const seed = settings.seeds[c] >>> 0;
      const resets = settings.resets[c] || [];
      outputs.push(processChannel(wav.channelData[c], seed, resets, k));
      if (onProgress) onProgress((c + 1) / wav.channels);
    }
    return { outputs, frames: wav.frames };
  }

  function validateSettings(settings, channels) {
    const errors = [];
    const k = Number(settings.k);
    if (!Number.isInteger(k) || k < 2 || k > 12) {
      errors.push("丢弃位数 k 必须是 2–12 的整数");
    }
    if (!Array.isArray(settings.seeds) || settings.seeds.length !== channels) {
      errors.push("种子数量必须等于声道数（" + channels + "）");
    } else {
      settings.seeds.forEach((s, i) => {
        const raw = Number(s);
        if (!Number.isInteger(raw) || raw < 1 || raw > 0xFFFFFFFF) {
          errors.push("声道 " + (i + 1) + " 的种子必须是非零 32 位正整数（1–4294967295）");
        }
      });
    }
    if (!Array.isArray(settings.resets) || settings.resets.length !== channels) {
      errors.push("重置帧列表数量必须等于声道数");
    } else {
      settings.resets.forEach((list, i) => {
        if (!Array.isArray(list)) {
          errors.push("声道 " + (i + 1) + " 的重置帧必须是数组");
          return;
        }
        list.forEach((f) => {
          if (!Number.isInteger(f) || f < 0) {
            errors.push("声道 " + (i + 1) + " 含非法重置帧 " + f);
          }
        });
      });
    }
    return errors;
  }

  return {
    xorshift32,
    roundHalfEven,
    processChannel,
    parseWav,
    encodeWav,
    renderAll,
    validateSettings,
  };
});
