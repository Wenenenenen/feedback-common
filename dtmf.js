/*
 * dtmf.js — DTMF 按键音检测、脱敏渲染、WAV 读写。
 * 纯算法库，无 DOM 依赖：浏览器里挂到全局 `DTMF`，Node 里 module.exports。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.DTMF = lib;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------------------------------------------------------- 常量

  const LOWS = [697, 770, 852, 941];
  const HIGHS = [1209, 1336, 1477, 1633];
  const FREQS = LOWS.concat(HIGHS);

  const KEY_TABLE = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
  };
  const KEYS = Object.keys(KEY_TABLE);

  // lowIdx,highIdx -> key
  const KEY_BY_IDX = {};
  for (const k of KEYS) {
    const [l, h] = KEY_TABLE[k];
    KEY_BY_IDX[LOWS.indexOf(l) + ',' + HIGHS.indexOf(h)] = k;
  }

  // 检测参数
  const WIN_MS = 30;        // 分类窗长（保证 697/770 等邻频可分辨）
  const HOP_MS = 10;        // 分类帧移
  const REFINE_WIN_MS = 8;  // 边界精修窗长
  const REFINE_HOP_MS = 1;  // 边界精修步长
  const REFINE_SPAN_MS = 40;    // 精修搜索半径（粗边界两侧）
  const MIN_RUN_SPAN_MS = 35;   // 粗筛：帧级连续段最短跨度（60ms 音约 50-60ms，20ms 音约 10-20ms）
  const MIN_DURATION_MS = 45;   // 精修后事件最短时长（拒绝 20ms 短音，接受 60ms 按键）
  const MERGE_GAP_MS = 35;      // 同键相邻段小于该间隔才合并（40ms 间隔必须分开）
  const SECOND_RATIO = 2.0;     // 组内次峰抑制：主峰幅度 ≥ 2×次峰（泄漏约 -17dB，双音约 0dB）
  const TWIST_MAX_DB = 10;      // 双频幅度差容限（要求覆盖 6dB；单频泄漏 >17dB 被拒绝）
  // 双音功率占比下限。±1% 频偏时标称频点幅度最差衰减到 sinc(0.49)≈0.65（功率 0.42），
  // 20dB 信噪比下双音占总功率 0.99 → 实测最低约 0.42；纯噪声仅约 0.01-0.02。
  const SNR_MIN = 0.3;
  const POWER_FLOOR = 1e-8;     // 静音/零帧绝对门限（样本已归一化到 ±1）

  // ---------------------------------------------------------------- 基础工具

  // Goertzel：返回 x[s0, s0+n) 在 coeff=2cos(2πf/fs) 处的幅度（未归一化）
  function goertzelMag(x, s0, n, coeff) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = x[s0 + i] + coeff * s1 - s2;
      s2 = s1; s1 = s;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Float64Array.from(arr).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = Float64Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }

  // ---------------------------------------------------------------- 帧级分类

  // 分析以 c（样本）为中心、长 winN 的帧；越界部分截断。
  // 返回按键字符或 null。
  function classifyFrame(x, N, c, winN, coeffs) {
    let s0 = c - (winN >> 1);
    let s1 = s0 + winN;
    if (s0 < 0) s0 = 0;
    if (s1 > N) s1 = N;
    const n = s1 - s0;
    if (n < (winN >> 2)) return null;

    let sumsq = 0;
    for (let i = s0; i < s1; i++) sumsq += x[i] * x[i];
    const power = sumsq / n;
    if (power < POWER_FLOOR) return null;

    const mags = new Array(8);
    for (let i = 0; i < 8; i++) {
      mags[i] = (2 * goertzelMag(x, s0, n, coeffs[i])) / n; // 正弦幅度
    }

    // 低组/高组各自找主峰与次峰
    let li = 0, hi = 0;
    for (let i = 1; i < 4; i++) if (mags[i] > mags[li]) li = i;
    for (let i = 5; i < 8; i++) if (mags[i] > mags[4 + hi]) hi = i - 4;
    let lowSecond = 0, highSecond = 0;
    for (let i = 0; i < 4; i++) {
      if (i !== li) lowSecond = Math.max(lowSecond, mags[i]);
      if (i !== hi) highSecond = Math.max(highSecond, mags[4 + i]);
    }
    const mL = mags[li], mH = mags[4 + hi];

    // 三频同响（组内双强峰）拒绝
    if (mL < SECOND_RATIO * lowSecond) return null;
    if (mH < SECOND_RATIO * highSecond) return null;

    // 双频幅度差（twist）：单频音因泄漏比 >17dB 在此被拒绝
    const twist = Math.abs(20 * Math.log10((mL + 1e-12) / (mH + 1e-12)));
    if (twist > TWIST_MAX_DB) return null;

    // 双音功率占比（信噪比）：20dB SNR 时约 0.99，纯噪声/语音远低于此
    const tonePow = (mL * mL + mH * mH) / 2;
    if (tonePow < SNR_MIN * power) return null;

    return KEY_BY_IDX[li + ',' + hi] || null;
  }

  // ---------------------------------------------------------------- 边界精修

  // tMs 时刻、REFINE_WIN 窗的双音幅度包络（f1、f2 为已知键频）
  function makeEnvelope(x, N, sr, coeff1, coeff2, winR) {
    return function (tMs) {
      const c = Math.round((tMs * sr) / 1000);
      let s0 = c - (winR >> 1);
      let s1 = s0 + winR;
      if (s0 < 0) s0 = 0;
      if (s1 > N) s1 = N;
      const n = s1 - s0;
      if (n <= 4) return 0;
      return (2 * (goertzelMag(x, s0, n, coeff1) + goertzelMag(x, s0, n, coeff2))) / n;
    };
  }

  // 对粗段 [cStartMs, cEndMs]（帧中心时间）精修起止边界
  function refineRun(x, N, sr, key, cStartMs, cEndMs) {
    const [f1, f2] = KEY_TABLE[key];
    const coeff1 = 2 * Math.cos((2 * Math.PI * f1) / sr);
    const coeff2 = 2 * Math.cos((2 * Math.PI * f2) / sr);
    const winR = Math.max(8, Math.round((sr * REFINE_WIN_MS) / 1000));
    const env = makeEnvelope(x, N, sr, coeff1, coeff2, winR);

    const span = cEndMs - cStartMs;
    const mid0 = cStartMs + span * 0.25, mid1 = cEndMs - span * 0.25;
    const inVals = [];
    for (let t = mid0; t <= mid1; t += REFINE_HOP_MS) inVals.push(env(t));
    const lIn = median(inVals);
    if (lIn <= 0) return null;

    // 段外噪声估计（取低分位，避免相邻按键尾部干扰）
    const outVals = [];
    for (let t = cStartMs - REFINE_SPAN_MS; t <= cStartMs - 15; t += REFINE_HOP_MS) outVals.push(env(t));
    for (let t = cEndMs + 15; t <= cEndMs + REFINE_SPAN_MS; t += REFINE_HOP_MS) outVals.push(env(t));
    const lNoise = percentile(outVals, 0.15);

    const thr = Math.max(0.5 * lIn, 4 * lNoise, 1e-6);

    // 起点：从段内向回找第一个低于阈值的点，线性插值
    let start = Math.max(0, cStartMs - REFINE_SPAN_MS);
    {
      let prevT = cStartMs + 10, prevE = env(prevT);
      for (let t = cStartMs + 10 - REFINE_HOP_MS; t >= cStartMs - REFINE_SPAN_MS; t -= REFINE_HOP_MS) {
        const e = env(t);
        if (e < thr) {
          const frac = (prevE - thr) / (prevE - e + 1e-12);
          start = Math.max(0, t + REFINE_HOP_MS * frac + REFINE_HOP_MS * 0); // t..prevT 之间
          start = Math.max(0, t + (prevT - t) * frac);
          break;
        }
        prevT = t; prevE = e;
        if (t <= 0) { start = 0; break; }
      }
    }

    // 终点：从段内向前找第一个低于阈值的点，线性插值
    let end = Math.min(N / sr * 1000, cEndMs + REFINE_SPAN_MS);
    {
      let prevT = cEndMs - 10, prevE = env(prevT);
      const tMax = Math.min(N / sr * 1000, cEndMs + REFINE_SPAN_MS);
      for (let t = cEndMs - 10 + REFINE_HOP_MS; t <= tMax; t += REFINE_HOP_MS) {
        const e = env(t);
        if (e < thr) {
          const frac = (prevE - thr) / (prevE - e + 1e-12);
          end = Math.min(tMax, prevT + (t - prevT) * frac);
          break;
        }
        prevT = t; prevE = e;
        if (t >= tMax) { end = tMax; break; }
      }
    }

    if (end - start < MIN_DURATION_MS) return null;
    return { key, startMs: start, endMs: end };
  }

  // ---------------------------------------------------------------- 逐声道检测

  // x: Float32Array（±1 归一化），sr: 采样率。返回 [{key, channel, startMs, endMs}]
  async function detectChannel(x, sr, channel, opts) {
    const N = x.length;
    const winN = Math.max(16, Math.round((sr * WIN_MS) / 1000));
    const hopN = Math.max(1, Math.round((sr * HOP_MS) / 1000));
    const coeffs = FREQS.map((f) => 2 * Math.cos((2 * Math.PI * f) / sr));

    // 1) 帧级分类
    const nFrames = Math.floor(N / hopN) + 1;
    const frameKeys = new Array(nFrames);
    const yieldEvery = (opts && opts.yieldEvery) || 0;
    for (let k = 0; k < nFrames; k++) {
      frameKeys[k] = classifyFrame(x, N, k * hopN, winN, coeffs);
      if (yieldEvery && k % yieldEvery === 0 && opts && opts.onProgress) {
        await opts.onProgress(k / nFrames);
      }
    }

    // 2) 同键连续段（粗）
    const runs = [];
    let rKey = null, rStart = 0;
    for (let k = 0; k <= nFrames; k++) {
      const cur = k < nFrames ? frameKeys[k] : null;
      if (cur !== rKey) {
        if (rKey !== null) {
          const cStart = rStart * HOP_MS;
          const cEnd = (k - 1) * HOP_MS;
          if (cEnd - cStart >= MIN_RUN_SPAN_MS) runs.push({ key: rKey, cStart, cEnd });
        }
        rKey = cur; rStart = k;
      }
    }

    // 3) 边界精修 + 最短时长过滤
    let events = [];
    for (const r of runs) {
      const ev = refineRun(x, N, sr, r.key, r.cStart, r.cEnd);
      if (ev) events.push(ev);
    }

    // 4) 同键小间隔合并（≥40ms 间隔保持分开）
    events.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const ev of events) {
      const last = merged[merged.length - 1];
      if (last && last.key === ev.key && ev.startMs - last.endMs < MERGE_GAP_MS) {
        last.endMs = Math.max(last.endMs, ev.endMs);
      } else {
        merged.push({ key: ev.key, startMs: ev.startMs, endMs: ev.endMs });
      }
    }

    return merged.map((e) => ({
      key: e.key,
      channel,
      startMs: e.startMs,
      endMs: e.endMs,
    }));
  }

  // channelsFloat: [Float32Array, ...]。返回全部声道的事件（按开始时间排序）。
  async function detectAudio(channelsFloat, sr, onProgress) {
    const all = [];
    for (let ch = 0; ch < channelsFloat.length; ch++) {
      const evs = await detectChannel(channelsFloat[ch], sr, ch, {
        yieldEvery: 200,
        onProgress: async (p) => {
          if (onProgress) await onProgress((ch + p) / channelsFloat.length);
        },
      });
      all.push(...evs);
    }
    all.sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
    return all;
  }

  // ---------------------------------------------------------------- 脱敏

  // events: [{channel, startFrame, endFrame}]（帧号，end 不含）
  // mode: 'event' 仅事件声道 | 'both' 两声道同时处理
  // 返回新的 Int16Array 数组（未触及的采样与原值完全一致）。
  function redact(int16Channels, sr, numFrames, events, mode) {
    const nCh = int16Channels.length;
    const F10 = Math.round(sr * 0.01); // 事件前后各扩 10ms 静音
    const F5 = Math.round(sr * 0.005); // 扩展段外再接 5ms 渐变
    const gains = [];
    for (let c = 0; c < nCh; c++) gains.push(new Float32Array(numFrames).fill(1));

    for (const ev of events) {
      const targets = mode === 'both'
        ? Array.from({ length: nCh }, (_, i) => i)
        : [ev.channel];
      const a = Math.max(0, ev.startFrame - F10);
      const b = Math.min(numFrames, ev.endFrame + F10);
      const fa = Math.max(0, a - F5);
      const fb = Math.min(numFrames, b + F5);
      for (const c of targets) {
        const g = gains[c];
        for (let i = fa; i < a; i++) {
          const v = (a - i) / (a - fa); // 1 → 0
          if (v < g[i]) g[i] = v;
        }
        for (let i = a; i < b; i++) g[i] = 0;
        for (let i = b; i < fb; i++) {
          const v = (i - b) / (fb - b); // 0 → 1
          if (v < g[i]) g[i] = v;
        }
      }
    }

    const out = [];
    for (let c = 0; c < nCh; c++) {
      const src = int16Channels[c];
      const g = gains[c];
      const dst = new Int16Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        if (g[i] === 1) dst[i] = src[i];
        else {
          let v = Math.round(src[i] * g[i]);
          if (v > 32767) v = 32767;
          else if (v < -32768) v = -32768;
          dst[i] = v;
        }
      }
      out.push(dst);
    }
    return out;
  }

  // ---------------------------------------------------------------- WAV I/O

  // 解码 16 位 PCM WAV。返回 {sampleRate, numChannels, numFrames, int16: [Int16Array]}
  function decodeWav(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 44) throw new Error('文件太小，不是有效的 WAV');
    if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) {
      throw new Error('不是 RIFF/WAVE 文件');
    }
    let pos = 12;
    let fmt = null, dataOff = 0, dataLen = 0;
    while (pos + 8 <= dv.byteLength) {
      const id = dv.getUint32(pos, false);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 0x666d7420) { // 'fmt '
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461) { // 'data'
        dataOff = body; dataLen = Math.min(size, dv.byteLength - body);
      }
      pos = body + size + (size % 2);
    }
    if (!fmt) throw new Error('缺少 fmt 块');
    if (fmt.format !== 1) throw new Error('仅支持未压缩 PCM（format=1）');
    if (fmt.bits !== 16) throw new Error('仅支持 16 位 PCM');
    if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('仅支持单声道或双声道');
    if (!dataOff) throw new Error('缺少 data 块');

    const numFrames = Math.floor(dataLen / (2 * fmt.channels));
    const int16 = [];
    for (let c = 0; c < fmt.channels; c++) int16.push(new Int16Array(numFrames));
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < fmt.channels; c++) {
        int16[c][i] = dv.getInt16(dataOff + (i * fmt.channels + c) * 2, true);
      }
    }
    return { sampleRate: fmt.sampleRate, numChannels: fmt.channels, numFrames, int16 };
  }

  // 编码 16 位 PCM WAV。int16Channels: [Int16Array]，交错写入。
  function encodeWav(int16Channels, sampleRate, numFrames) {
    const nCh = int16Channels.length;
    const dataLen = numFrames * nCh * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buf);
    const w32 = (o, v) => dv.setUint32(o, v, false);
    const w32le = (o, v) => dv.setUint32(o, v, true);
    const w16le = (o, v) => dv.setUint16(o, v, true);
    w32(0, 0x52494646); w32le(4, 36 + dataLen); w32(8, 0x57415645);
    w32(12, 0x666d7420); w32le(16, 16);
    w16le(20, 1); w16le(22, nCh); w32le(24, sampleRate);
    w32le(28, sampleRate * nCh * 2); w16le(32, nCh * 2); w16le(34, 16);
    w32(36, 0x64617461); w32le(40, dataLen);
    let o = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < nCh; c++) {
        dv.setInt16(o, int16Channels[c][i], true);
        o += 2;
      }
    }
    return buf;
  }

  function toFloat(int16) {
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
    return f;
  }

  return {
    LOWS, HIGHS, KEYS, KEY_TABLE,
    detectAudio, detectChannel,
    redact,
    decodeWav, encodeWav, toFloat,
    _internals: { classifyFrame, refineRun, goertzelMag },
  };
});
