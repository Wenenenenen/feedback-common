/*
 * render-core.js — 移动声源耳机校音核心渲染
 *
 * 约定（samples/约定.txt）：
 * - 方位库 angles：互异升序，百分之一度，范围 0..35999，至少 2 个。
 * - 轨迹点：[帧号, 角度]，帧号严格升序，从 0 到录音末帧；角度为有符号 int32（保留圈数）。
 *   相邻点线性插值，取模 36000 后用循环相邻方向求线性权重，精确命中时该方向权重为 1。
 * - 每耳延时数组单位 1/256 采样，整数 0..65536。
 * - L 为所有响应共有抽头数，抽头为有符号 Q15。
 * - 按发声帧为两耳分别插值延时与逐抽头幅值，贡献 = 发声码值 × 插值抽头，
 *   按延时小数部分线性分摊到相邻整帧，整数延时只写一帧。
 * - 工程总长 = 最长源录音帧数 + L + 255，独听保持该长度。
 * - 全体贡献 float64 累加后按最接近偶数舍入，再限到 PCM16；选区左闭右开。
 *
 * 本文件同时可用于浏览器页面、Web Worker（importScripts）与 Node（require）。
 */
'use strict';
(function (global) {
  const TURN = 36000;          // 一圈，百分之一度
  const DELAY_UNIT = 256;      // 延时单位：1/256 采样
  const Q15 = 32768;
  const MAX_SOURCES = 4;
  const MAX_DIRECTIONS = 16;
  const MAX_TAPS = 512;
  const MAX_SECONDS = 30;
  const MAX_TRACK_POINTS = 20000;
  const SAMPLE_RATE = 48000;
  const MAX_FRAMES = MAX_SECONDS * SAMPLE_RATE; // 1,440,000

  /** 角度取模到 [0, TURN) */
  function modTurn(a) {
    let m = a % TURN;
    if (m < 0) m += TURN;
    return m;
  }

  /**
   * 循环相邻方向查找。
   * angles：升序 Int32Array/Array（>=2 个，0..35999）。
   * angleMod：已取模到 [0,36000) 的浮点角度。
   * 返回 [iA, iB, w]：iA/iB 为相邻方向下标，w 为 iB 的线性权重；
   * 精确命中时返回 [i, i, 1]。
   */
  function directionLookup(angles, angleMod) {
    const n = angles.length;
    if (angleMod < angles[0]) {
      // 位于末方向与首方向（+一圈）之间
      const a0 = angles[n - 1] - TURN;
      const a1 = angles[0];
      const w = (angleMod - a0) / (a1 - a0);
      return [n - 1, 0, w];
    }
    // 二分：最大的满足 angles[i] <= angleMod 的 i
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (angles[mid] <= angleMod) lo = mid; else hi = mid - 1;
    }
    if (angles[lo] === angleMod) return [lo, lo, 1];
    if (lo === n - 1) {
      const a0 = angles[lo];
      const a1 = angles[0] + TURN;
      const w = (angleMod - a0) / (a1 - a0);
      return [lo, 0, w];
    }
    const a0 = angles[lo];
    const a1 = angles[lo + 1];
    const w = (angleMod - a0) / (a1 - a0);
    return [lo, lo + 1, w];
  }

  /**
   * 轨迹在帧 n 的角度（保留圈数的线性插值）。
   * frames 严格升序，frames[0] = 0；n 超出末点则取末点角度。
   */
  function trackAngleAt(frames, angs, n) {
    const last = frames.length - 1;
    if (n >= frames[last]) return angs[last];
    // 二分找段：frames[i] <= n < frames[i+1]
    let lo = 0, hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid] <= n) lo = mid; else hi = mid - 1;
    }
    const f0 = frames[lo], f1 = frames[lo + 1];
    const a0 = angs[lo], a1 = angs[lo + 1];
    return a0 + (a1 - a0) * ((n - f0) / (f1 - f0));
  }

  /**
   * 某发声帧的方位解算（供查看与渲染共用）。
   * 返回 { raw, mod, iA, iB, w, delayA, delayB, delay } —— delay 单位为采样（浮点）。
   */
  function frameAzimuth(frames, angs, angles, delays, n) {
    const raw = trackAngleAt(frames, angs, n);
    const mod = modTurn(raw);
    const [iA, iB, w] = directionLookup(angles, mod);
    const dA = delays[iA], dB = delays[iB];
    const d256 = dA + (dB - dA) * w;      // 1/256 采样
    return { raw, mod, iA, iB, w, delay: d256 / DELAY_UNIT };
  }

  /**
   * 渲染一条声源的一只耳。
   * samples: Int16Array（发声码值）
   * trackFrames/trackAngs: 轨迹
   * angles: 方位库（升序）
   * taps: Float64Array，D*L，已换算为 Q15/32768
   * delays: Float64Array，D，单位 1/256 采样
   * out: Float64Array(totalLen)，累加进去（调用前需清零）
   * onProgress(doneFrames)：可选，周期性回调；返回 false 表示请求取消（抛 CancelError）。
   */
  function renderSourceEar(samples, trackFrames, trackAngs, angles, taps, delays, L, out, onProgress) {
    const N = samples.length;
    const D = angles.length;
    const lastTrack = trackFrames.length - 1;
    // 相邻方向对的差分缓存：key = iA*D+iB
    const diffCache = new Map();
    let seg = 0;
    const PROGRESS_STEP = 1 << 16;

    for (let n = 0; n < N; n++) {
      if ((n & (PROGRESS_STEP - 1)) === 0 && onProgress) {
        if (onProgress(n) === false) {
          const err = new Error('cancelled');
          err.cancelled = true;
          throw err;
        }
      }
      // 推进轨迹段
      while (seg < lastTrack && n > trackFrames[seg + 1]) seg++;
      let ang;
      if (seg >= lastTrack) {
        ang = trackAngs[lastTrack];
      } else {
        const f0 = trackFrames[seg], f1 = trackFrames[seg + 1];
        const a0 = trackAngs[seg], a1 = trackAngs[seg + 1];
        ang = a0 + (a1 - a0) * ((n - f0) / (f1 - f0));
      }
      const mod = modTurn(ang);
      const [iA, iB, w] = directionLookup(angles, mod);

      const dA = delays[iA], dB = delays[iB];
      const d256 = dA + (dB - dA) * w;
      const ds = d256 / DELAY_UNIT;
      const intd = Math.floor(ds);
      const frac = ds - intd;

      const x = samples[n];
      if (x === 0) continue;

      const offA = iA * L, offB = iB * L;
      const base = n + intd;

      if (w === 0 || iA === iB) {
        // 只用方向 A
        if (frac === 0) {
          for (let k = 0; k < L; k++) out[base + k] += x * taps[offA + k];
        } else {
          const g0 = 1 - frac, g1 = frac;
          for (let k = 0; k < L; k++) {
            const c = x * taps[offA + k];
            out[base + k] += c * g0;
            out[base + k + 1] += c * g1;
          }
        }
      } else if (w === 1) {
        if (frac === 0) {
          for (let k = 0; k < L; k++) out[base + k] += x * taps[offB + k];
        } else {
          const g0 = 1 - frac, g1 = frac;
          for (let k = 0; k < L; k++) {
            const c = x * taps[offB + k];
            out[base + k] += c * g0;
            out[base + k + 1] += c * g1;
          }
        }
      } else {
        const key = iA * D + iB;
        let hD = diffCache.get(key);
        if (!hD) {
          hD = new Float64Array(L);
          for (let k = 0; k < L; k++) hD[k] = taps[offB + k] - taps[offA + k];
          diffCache.set(key, hD);
        }
        if (frac === 0) {
          for (let k = 0; k < L; k++) {
            out[base + k] += x * (taps[offA + k] + hD[k] * w);
          }
        } else {
          const g0 = 1 - frac, g1 = frac;
          for (let k = 0; k < L; k++) {
            const c = x * (taps[offA + k] + hD[k] * w);
            out[base + k] += c * g0;
            out[base + k + 1] += c * g1;
          }
        }
      }
    }
    if (onProgress) onProgress(N);
  }

  /** 最接近偶数舍入（round half to even） */
  function roundHalfEven(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  /** float64 累加缓冲 → PCM16（最接近偶数舍入 + 限幅） */
  function quantize(buf) {
    const out = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      let v = roundHalfEven(buf[i]);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out[i] = v;
    }
    return out;
  }

  /** 工程总长 = 最长源帧数 + L + 255 */
  function totalLength(maxSourceFrames, L) {
    return maxSourceFrames + L + 255;
  }

  /* ---------------- WAV 编解码 ---------------- */

  /** 解码 48kHz 单声道 PCM16 WAV → Int16Array。失败抛错。 */
  function decodeWavPcm16Mono(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 44) throw new Error('WAV 文件太小');
    if (dv.getUint32(0, false) !== 0x52494646) throw new Error('不是 RIFF 文件');
    if (dv.getUint32(8, false) !== 0x57415645) throw new Error('不是 WAVE 文件');
    let pos = 12;
    let fmt = null, dataOff = -1, dataLen = 0;
    while (pos + 8 <= dv.byteLength) {
      const id = dv.getUint32(pos, false);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 0x666d7420) { // 'fmt '
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          rate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461) { // 'data'
        dataOff = body; dataLen = Math.min(size, dv.byteLength - body);
      }
      pos = body + size + (size & 1);
    }
    if (!fmt) throw new Error('缺少 fmt 块');
    if (dataOff < 0) throw new Error('缺少 data 块');
    if (fmt.format !== 1) throw new Error('只支持未压缩 PCM');
    if (fmt.channels !== 1) throw new Error('只支持单声道');
    if (fmt.rate !== SAMPLE_RATE) throw new Error('采样率须为 48000 Hz');
    if (fmt.bits !== 16) throw new Error('只支持 16 位 PCM');
    const n = Math.floor(dataLen / 2);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2, true);
    return out;
  }

  /** 编码双声道 PCM16 WAV。left/right: Int16Array（等长，为 [s,e) 切片后的数据）。 */
  function encodeWavStereoPcm16(left, right, sampleRate) {
    const n = left.length;
    const dataLen = n * 4;
    const buf = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buf);
    const w32 = (o, v) => dv.setUint32(o, v, false);
    const w32le = (o, v) => dv.setUint32(o, v, true);
    const w16le = (o, v) => dv.setUint16(o, v, true);
    w32(0, 0x52494646); w32le(4, 36 + dataLen); w32(8, 0x57415645);
    w32(12, 0x666d7420); w32le(16, 16);
    w16le(20, 1); w16le(22, 2); w32le(24, sampleRate);
    w32le(28, sampleRate * 4); w16le(32, 4); w16le(34, 16);
    w32(36, 0x64617461); w32le(40, dataLen);
    let o = 44;
    for (let i = 0; i < n; i++) {
      dv.setInt16(o, left[i], true); o += 2;
      dv.setInt16(o, right[i], true); o += 2;
    }
    return buf;
  }

  /* ---------------- 工程校验 ---------------- */

  function assert(cond, msg) { if (!cond) throw new Error(msg); }

  /** 校验并规范化方位库。返回 {angles, left, right, leftDelay, rightDelay, L, D} */
  function normalizeBank(bank) {
    assert(bank && typeof bank === 'object', '方位库缺失');
    const angles = bank.angles;
    assert(Array.isArray(angles), 'angles 缺失');
    assert(angles.length >= 2, 'angles 至少 2 个');
    assert(angles.length <= MAX_DIRECTIONS, `angles 最多 ${MAX_DIRECTIONS} 个`);
    for (let i = 0; i < angles.length; i++) {
      assert(Number.isInteger(angles[i]), 'angles 须为整数');
      assert(angles[i] >= 0 && angles[i] <= 35999, 'angles 范围 0..35999');
      if (i > 0) assert(angles[i] > angles[i - 1], 'angles 须互异升序');
    }
    const D = angles.length;
    const left = bank.left, right = bank.right;
    assert(Array.isArray(left) && left.length === D, 'left 响应数须与 angles 一致');
    assert(Array.isArray(right) && right.length === D, 'right 响应数须与 angles 一致');
    const L = left[0].length;
    assert(L >= 1 && L <= MAX_TAPS, `抽头数 1..${MAX_TAPS}`);
    const conv = (resp, name) => {
      const out = new Float64Array(D * L);
      for (let d = 0; d < D; d++) {
        assert(Array.isArray(resp[d]) && resp[d].length === L, `${name}[${d}] 抽头数须为 ${L}`);
        for (let k = 0; k < L; k++) {
          const t = resp[d][k];
          assert(Number.isInteger(t) && t >= -32768 && t <= 32767, `${name}[${d}][${k}] 须为 Q15 整数`);
          out[d * L + k] = t / Q15;
        }
      }
      return out;
    };
    const leftT = conv(left, 'left');
    const rightT = conv(right, 'right');
    const convDelay = (arr, name) => {
      assert(Array.isArray(arr) && arr.length === D, `${name} 数量须与 angles 一致`);
      const out = new Float64Array(D);
      for (let d = 0; d < D; d++) {
        assert(Number.isInteger(arr[d]) && arr[d] >= 0 && arr[d] <= 65536, `${name}[${d}] 须为 0..65536 整数`);
        out[d] = arr[d];
      }
      return out;
    };
    return {
      angles: Int32Array.from(angles),
      left: leftT, right: rightT,
      leftDelay: convDelay(bank.left_delay, 'left_delay'),
      rightDelay: convDelay(bank.right_delay, 'right_delay'),
      L, D,
    };
  }

  /** 校验并规范化轨迹。frames: Int32Array, angs: Int32Array */
  function normalizeTrack(track, numFrames) {
    assert(Array.isArray(track) && track.length >= 1, '轨迹至少 1 个点');
    assert(track.length <= MAX_TRACK_POINTS, `轨迹最多 ${MAX_TRACK_POINTS} 个点`);
    const m = track.length;
    const frames = new Int32Array(m), angs = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      const p = track[i];
      assert(Array.isArray(p) && p.length === 2, `轨迹点 ${i} 须为 [帧号, 角度]`);
      const f = p[0], a = p[1];
      assert(Number.isInteger(f) && Number.isInteger(a), `轨迹点 ${i} 须为整数`);
      assert(a >= -2147483648 && a <= 2147483647, `轨迹点 ${i} 角度须为 int32`);
      assert(f >= 0 && f < numFrames, `轨迹点 ${i} 帧号须在 0..${numFrames - 1}`);
      if (i > 0) assert(f > frames[i - 1], '轨迹帧号须严格升序');
      frames[i] = f; angs[i] = a;
    }
    assert(frames[0] === 0, '轨迹首点帧号须为 0');
    assert(numFrames === 1 ? m === 1 && frames[0] === 0 : frames[m - 1] === numFrames - 1,
      '轨迹末点须落在录音末帧（单帧录音只需一个点）');
    return { frames, angs };
  }

  const RenderCore = {
    TURN, DELAY_UNIT, Q15, SAMPLE_RATE,
    MAX_SOURCES, MAX_DIRECTIONS, MAX_TAPS, MAX_SECONDS, MAX_TRACK_POINTS, MAX_FRAMES,
    modTurn, directionLookup, trackAngleAt, frameAzimuth,
    renderSourceEar, roundHalfEven, quantize, totalLength,
    decodeWavPcm16Mono, encodeWavStereoPcm16,
    normalizeBank, normalizeTrack,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RenderCore;
  else global.RenderCore = RenderCore;
})(typeof self !== 'undefined' ? self : this);
