/* loop-core.js — 循环区间校验、后卷预混交叉淡化、接缝指标、工程序列化。
 * 双模式：浏览器（全局 LOOPCORE）与 Node（module.exports）。
 *
 * 交叉淡化定义（与 samples/loop-cases.zip 中 cases.json 一致）：
 *   L = end - start，F = fadeFrames（0 或 >= 2）
 *   y[k] = (1 - k/(F-1)) * x[end + k] + (k/(F-1)) * x[start + k],  0 <= k < F
 *   y[k] = x[start + k],                                          F <= k < L
 * 即：首帧 y[0] 完全来自 end 之后的预留音频，末帧 y[L-1] 完全来自原头部，
 * 循环长度保持 L 不变；end 之后必须至少有 F 帧。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.LOOPCORE = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const PROJECT_KIND = 'loop-postroll-studio';
  const PROJECT_VERSION = 1;
  const MAX_FADE_MS = 100;

  /* ---------- 淡化帧数换算 ---------- */

  /* 毫秒 → 帧数。四舍五入后若落到 1 帧，取最近的合法值：不足 1 帧按 0，否则按 2。 */
  function fadeFramesForMs(ms, sampleRate) {
    if (!(ms > 0)) return 0;
    const raw = (ms * sampleRate) / 1000;
    const rounded = Math.round(raw);
    if (rounded < 1) return 0;
    if (rounded === 1) return 2;
    return rounded;
  }

  function fadeMsForFrames(fadeFrames, sampleRate) {
    if (!(fadeFrames > 0)) return 0;
    return (fadeFrames * 1000) / sampleRate;
  }

  /* 当前切点下允许的最大合法淡化帧数（0 或 ≥ 2）。 */
  function maxFadeFrames(frames, start, end, sampleRate, limitMs) {
    const L = end - start;
    if (!(L > 0) || !(start >= 0) || !(end <= frames)) return 0;
    const postroll = Math.max(0, frames - end);
    const byInterval = Math.floor(L / 2);
    const byMs = Math.max(0,
      Math.round(((limitMs == null ? MAX_FADE_MS : limitMs) * sampleRate) / 1000));
    const value = Math.min(postroll, byInterval, byMs);
    return value >= 2 ? value : 0;   // 1 帧不是合法取值
  }

  /* ---------- 校验 ---------- */

  /**
   * @param {{frames:number,start:number,end:number,fadeFrames:number}} cfg
   * @returns {{ok:boolean, errors:{code:string,message:string}[]}}
   */
  function validateLoop(cfg) {
    const errors = [];
    const { frames } = cfg;
    const start = cfg.start;
    const end = cfg.end;
    const F = cfg.fadeFrames;

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      errors.push({ code: 'RANGE_NOT_INTEGER', message: '切点必须是整数采样帧。' });
    }
    if (!(start >= 0)) {
      errors.push({ code: 'RANGE_START', message: '起点不能小于 0。' });
    }
    if (!(end <= frames)) {
      errors.push({ code: 'RANGE_END', message: '终点不能超过素材长度（' + frames + ' 帧）。' });
    }
    if (!(end > start)) {
      errors.push({ code: 'RANGE_EMPTY', message: '区间 [start, end) 必须至少包含 1 帧。' });
    }
    if (!Number.isInteger(F) || F < 0) {
      errors.push({ code: 'FADE_INVALID', message: '淡化帧数 F 必须是非负整数。' });
      return { ok: errors.length === 0, errors };
    }
    if (F === 1) {
      errors.push({ code: 'FADE_ONE', message: '淡化帧数 F 只能为 0 或至少 2 帧。' });
    }

    const L = end - start;
    if (F > 0 && L > 0 && F * 2 > L) {
      errors.push({
        code: 'FADE_TOO_LONG',
        message: '交叉淡化 ' + F + ' 帧超过循环区间一半（区间 ' + L + ' 帧，最多 ' +
          Math.floor(L / 2) + ' 帧）。',
      });
    }
    if (F > 0 && end + F > frames) {
      errors.push({
        code: 'NO_POSTROLL',
        message: 'end 之后预留音频不足：需要 ' + F + ' 帧，仅有 ' + Math.max(0, frames - end) +
          ' 帧。',
      });
    }
    if (F > 0 && cfg.sampleRate > 0 && (F * 1000) / cfg.sampleRate > MAX_FADE_MS + 1e-9) {
      errors.push({
        code: 'FADE_MS_LIMIT',
        message: '淡化时长不能超过 ' + MAX_FADE_MS + ' ms（当前 ' +
          ((F * 1000) / cfg.sampleRate).toFixed(2) + ' ms，' + F + ' 帧）。',
      });
    }

    return { ok: errors.length === 0, errors };
  }

  function assertValid(cfg) {
    const result = validateLoop(cfg);
    if (!result.ok) {
      const err = new Error(result.errors.map((e) => e.message).join(' '));
      err.code = 'INVALID_LOOP';
      err.errors = result.errors;
      throw err;
    }
  }

  /* ---------- 交叉淡化 ---------- */

  function crossfadeValue(channel, start, end, F, k) {
    if (F > 0 && k < F) {
      const den = F - 1;
      const w = k / den;             // 原头部的权重；k=0 → 0，k=F-1 → 1
      return (1 - w) * channel[end + k] + w * channel[start + k];
    }
    return channel[start + k];
  }

  /**
   * 生成完整的循环输出（每个声道一个 Float32Array，长度 L = end - start）。
   * @param {Float32Array[]} channelData
   * @param {number} start
   * @param {number} end
   * @param {number} fadeFrames
   * @param {number} [sampleRate] 提供时会一并校验 100ms 上限
   */
  function processLoop(channelData, start, end, fadeFrames, sampleRate) {
    const frames = channelData[0].length;
    assertValid({ frames, start, end, fadeFrames, sampleRate: sampleRate || 0 });
    const L = end - start;
    const F = fadeFrames;
    const out = [];
    for (let c = 0; c < channelData.length; c++) {
      const src = channelData[c];
      const dst = new Float32Array(L);
      const mix = Math.min(F, L);
      for (let k = 0; k < mix; k++) dst[k] = crossfadeValue(src, start, end, F, k);
      if (F < L) dst.set(src.subarray(start + F, end), F);
      out.push(dst);
    }
    return out;
  }

  /* 只取原始循环区间（处理前试听、导出对照用）。 */
  function sliceLoop(channelData, start, end) {
    return channelData.map((ch) => ch.slice(start, end));
  }

  /* ---------- 接缝指标 ---------- */

  function rmsOf(values, from, count) {
    if (count <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const v = values[from + i];
      sum += v * v;
    }
    return Math.sqrt(sum / count);
  }

  function rmsOfAccessor(fn, count) {
    if (count <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const v = fn(i);
      sum += v * v;
    }
    return Math.sqrt(sum / count);
  }

  /**
   * 计算各声道的切口与接缝指标，以及两端各 10ms 的 RMS。
   *
   * 原样（切下来直接循环，输出 = x[start .. end-1]）：
   *   首端跳变 = x[start] − x[start−1]       （在 start 处切开的突变）
   *   尾端跳变 = x[end] − x[end−1]           （在 end 处切开的突变）
   *   循环接缝 = x[start] − x[end−1]         （回绕瞬间的突变）
   * 处理后（输出 = P[0 .. L-1]）：
   *   首端跳变 = P[0] − x[start−1]
   *   尾端跳变 = x[end] − P[L−1]
   *   循环接缝 = P[0] − P[L−1]
   * 两端 RMS 均以循环输出开头/末尾 10ms 计。
   */
  function analyzeLoop(channelData, sampleRate, start, end, fadeFrames) {
    const frames = channelData[0].length;
    const L = end - start;
    const F = fadeFrames;
    const valid = validateLoop({ frames, start, end, fadeFrames, sampleRate }).ok;
    const win = Math.min(Math.max(1, Math.round(sampleRate * 0.01)), Math.max(0, L));
    const result = {
      length: L,
      fadeFrames: F,
      windowFrames: win,
      valid,
      channels: [],
    };

    for (let c = 0; c < channelData.length; c++) {
      const ch = channelData[c];
      const entry = {
        channel: c,
        headJumpRaw: start > 0 ? ch[start] - ch[start - 1] : null,
        tailJumpRaw: end < frames ? ch[end] - ch[end - 1] : null,
        seamJumpRaw: L > 0 ? ch[start] - ch[end - 1] : null,
        headRmsRaw: rmsOf(ch, start, win),
        tailRmsRaw: rmsOf(ch, end - win, win),
        headJumpProcessed: null,
        tailJumpProcessed: null,
        seamJumpProcessed: null,
        headRmsProcessed: null,
        tailRmsProcessed: null,
        headFrameReplaced: null,
        tailFrameReplaced: null,
      };

      if (valid && L > 0) {
        const sampleAt = (k) => crossfadeValue(ch, start, end, F, k);
        const first = sampleAt(0);
        const last = sampleAt(L - 1);
        entry.headJumpProcessed = start > 0 ? first - ch[start - 1] : null;
        entry.tailJumpProcessed = end < frames ? ch[end] - last : null;
        entry.seamJumpProcessed = first - last;
        entry.headRmsProcessed = rmsOfAccessor(sampleAt, win);
        entry.tailRmsProcessed = rmsOfAccessor(
          (i) => crossfadeValue(ch, start, end, F, L - win + i),
          win
        );
        entry.headFrameReplaced = first !== ch[start];
        entry.tailFrameReplaced = last !== ch[end - 1];
      }

      result.channels.push(entry);
    }
    return result;
  }

  /* ---------- 校验和 ---------- */

  function getSubtle() {
    if (typeof crypto !== 'undefined' && crypto && crypto.subtle) return crypto.subtle;
    if (typeof require === 'function') {
      try {
        const nodeCrypto = require('crypto');
        if (nodeCrypto && nodeCrypto.webcrypto) return nodeCrypto.webcrypto.subtle;
      } catch (_) { /* 忽略 */ }
    }
    return null;
  }

  /* 纯 JS SHA-256（crypto.subtle 不可用时兜底：非 localhost 的 http 源没有安全上下文）。 */
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256BytesFallback(bytes) {
    const len = bytes.length;
    const bitLenHi = Math.floor(len / 536870912);
    const bitLenLo = (len * 8) >>> 0;
    const paddedLen = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(paddedLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(paddedLen - 8, bitLenHi, false);
    dv.setUint32(paddedLen - 4, bitLenLo, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < paddedLen; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outDv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outDv.setUint32(i * 4, v, false));
    return out;
  }

  function bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  function sha256HexSync(data) {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return bytesToHex(sha256BytesFallback(bytes));
  }

  /** SHA-256（十六进制小写）。支持 ArrayBuffer / TypedArray。 */
  async function sha256Hex(data) {
    const subtle = getSubtle();
    if (!subtle) return sha256HexSync(data);
    const buf = data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    try {
      const digest = await subtle.digest('SHA-256', buf);
      return bytesToHex(new Uint8Array(digest));
    } catch (_) {
      return sha256HexSync(data);
    }
  }

  /* ---------- 工程 ---------- */

  function sourceDescriptor(file) {
    return {
      name: file.name || '',
      size: file.size,
      sha256: file.sha256 || '',
      sampleRate: file.sampleRate,
      bits: file.bits,
      channelCount: file.channelCount,
      frames: file.frames,
      duration: file.frames / file.sampleRate,
    };
  }

  function createProject(file, start, end, fadeFrames) {
    return {
      kind: PROJECT_KIND,
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      source: sourceDescriptor(file),
      loop: {
        start,
        end,
        fadeFrames,
        fadeMs: fadeMsForFrames(fadeFrames, file.sampleRate),
      },
    };
  }

  function isFinitePositiveInt(v) {
    return Number.isInteger(v) && v >= 0;
  }

  function validateProject(input) {
    const errors = [];
    if (!input || typeof input !== 'object') {
      return { ok: false, errors: [{ code: 'PROJECT_NOT_OBJECT', message: '工程文件不是有效的 JSON 对象。' }] };
    }
    if (input.kind !== PROJECT_KIND) {
      errors.push({ code: 'PROJECT_KIND', message: '不是本工具的工程文件（kind 不匹配）。' });
    }
    if (!Number.isInteger(input.version) || input.version < 1) {
      errors.push({ code: 'PROJECT_VERSION', message: '工程文件版本无效。' });
    }
    const src = input.source;
    if (!src || typeof src !== 'object') {
      errors.push({ code: 'PROJECT_SOURCE', message: '工程缺少源文件信息。' });
    } else {
      if (typeof src.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(src.sha256)) {
        errors.push({ code: 'PROJECT_CHECKSUM', message: '工程中的源文件校验和无效。' });
      }
      if (!Number.isInteger(src.frames) || src.frames <= 0) {
        errors.push({ code: 'PROJECT_SOURCE_FRAMES', message: '工程中的源文件帧数无效。' });
      }
      if (!Number.isInteger(src.sampleRate) || src.sampleRate <= 0) {
        errors.push({ code: 'PROJECT_SOURCE_RATE', message: '工程中的采样率无效。' });
      }
    }
    const loop = input.loop;
    if (!loop || typeof loop !== 'object') {
      errors.push({ code: 'PROJECT_LOOP', message: '工程缺少切点与淡化参数。' });
    } else {
      if (!isFinitePositiveInt(loop.start) || !isFinitePositiveInt(loop.end) || loop.end <= loop.start) {
        errors.push({ code: 'PROJECT_RANGE', message: '工程中的切点区间无效。' });
      }
      if (!isFinitePositiveInt(loop.fadeFrames)) {
        errors.push({ code: 'PROJECT_FADE', message: '工程中的淡化帧数无效。' });
      }
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      project: {
        kind: PROJECT_KIND,
        version: input.version,
        savedAt: typeof input.savedAt === 'string' ? input.savedAt : '',
        source: {
          name: typeof src.name === 'string' ? src.name : '',
          size: Number.isInteger(src.size) ? src.size : -1,
          sha256: src.sha256.toLowerCase(),
          sampleRate: src.sampleRate,
          bits: src.bits,
          channelCount: src.channelCount,
          frames: src.frames,
          duration: src.frames / src.sampleRate,
        },
        loop: {
          start: loop.start,
          end: loop.end,
          fadeFrames: loop.fadeFrames,
          fadeMs: typeof loop.fadeMs === 'number' ? loop.fadeMs : 0,
        },
      },
    };
  }

  /**
   * 对比工程记录的源文件与当前导入文件。
   * @returns {{match:boolean, checksumMatch:boolean, differences:string[]}}
   */
  function compareSource(expected, actual) {
    const differences = [];
    const checksumMatch = !!expected.sha256 && !!actual.sha256 &&
      expected.sha256.toLowerCase() === actual.sha256.toLowerCase();
    if (!checksumMatch) differences.push('SHA-256 校验和不同');
    if (expected.size >= 0 && actual.size !== expected.size) {
      differences.push('文件大小不同（工程 ' + expected.size + ' 字节，当前 ' + actual.size + ' 字节）');
    }
    if (expected.frames !== actual.frames) {
      differences.push('帧数不同（工程 ' + expected.frames + '，当前 ' + actual.frames + '）');
    }
    if (expected.sampleRate !== actual.sampleRate) {
      differences.push('采样率不同（工程 ' + expected.sampleRate + ' Hz，当前 ' + actual.sampleRate + ' Hz）');
    }
    if (expected.bits !== actual.bits) {
      differences.push('位深不同（工程 ' + expected.bits + ' 位，当前 ' + actual.bits + ' 位）');
    }
    if (expected.channelCount !== actual.channelCount) {
      differences.push('声道数不同（工程 ' + expected.channelCount + '，当前 ' + actual.channelCount + '）');
    }
    if (expected.name && actual.name && expected.name !== actual.name) {
      differences.push('文件名不同（工程 ' + expected.name + '，当前 ' + actual.name + '）');
    }
    return { match: checksumMatch, checksumMatch, differences };
  }

  return {
    PROJECT_KIND,
    PROJECT_VERSION,
    MAX_FADE_MS,
    fadeFramesForMs,
    fadeMsForFrames,
    maxFadeFrames,
    validateLoop,
    processLoop,
    sliceLoop,
    crossfadeValue,
    analyzeLoop,
    sha256Hex,
    sha256HexSync,
    sourceDescriptor,
    createProject,
    validateProject,
    compareSource,
  };
});
