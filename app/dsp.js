/*
 * dsp.js — 麦克风阵列 GCC-PHAT 方位分析核心
 *
 * 算法约定（与 samples 约定.txt 一致）：
 *   坐标单位米，x 向右、y 向上；方位角从 +x 向 +y 逆时针，[0,360)
 *   源方向 u 从阵列指向声源；t_i = -p_i·u/c
 *   tau_ij = t_j - t_i，预测值 = -(p_j-p_i)·u/c
 *   GCC = IFFT(conj(FFT(xi)) * FFT(xj) / max(abs(...), 1e-12))
 *   正滞后表示 j 晚到
 * 该模块在 Node（module.exports）与浏览器（window.MB_DSP）下均可运行。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MB_DSP = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------- WAV 解析 ----------------

  function decodePCM(buf) {
    const dv = new DataView(buf);
    const readStr = (off, len) => {
      let s = "";
      for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(off + k));
      return s;
    };
    if (buf.byteLength < 44 || readStr(0, 4) !== "RIFF" || readStr(8, 4) !== "WAVE") {
      throw new Error("不是 RIFF/WAVE 文件");
    }
    let pos = 12;
    let fmt = null;
    let dataBytes = null;
    let dataStart = 0;
    while (pos + 8 <= buf.byteLength) {
      const id = readStr(pos, 4);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === "fmt ") {
        fmt = {
          tag: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bitsPerSample: dv.getUint16(body + 14, true),
        };
      } else if (id === "data") {
        dataStart = body;
        dataBytes = new Uint8Array(buf, body, Math.min(size, buf.byteLength - body));
      }
      pos = body + size + (size & 1);
    }
    if (!fmt) throw new Error("缺少 fmt 块");
    if (!dataBytes) throw new Error("缺少 data 块");
    if (fmt.tag !== 1) throw new Error("仅支持无压缩 PCM（format tag=1），当前为 " + fmt.tag);
    if (fmt.sampleRate !== 44100 && fmt.sampleRate !== 48000) {
      throw new Error("仅支持 44.1kHz 或 48kHz，当前为 " + fmt.sampleRate + "Hz");
    }
    if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 24) {
      throw new Error("仅支持 16 位或 24 位 PCM，当前为 " + fmt.bitsPerSample + " 位");
    }
    if (fmt.channels < 3 || fmt.channels > 8) {
      throw new Error("声道数须在 3 到 8 之间，当前为 " + fmt.channels);
    }
    const bytesPerSample = fmt.bitsPerSample >> 3;
    const frameBytes = bytesPerSample * fmt.channels;
    const frameCount = Math.floor(dataBytes.length / frameBytes);
    const duration = frameCount / fmt.sampleRate;
    if (duration > 10 + 1e-9) {
      throw new Error("录音时长 " + duration.toFixed(2) + "s 超过 10 秒上限");
    }
    // 拆分为每声道 Float64（归一化到满量程 [-1,1)）
    const channels = [];
    for (let ch = 0; ch < fmt.channels; ch++) channels.push(new Float64Array(frameCount));
    if (fmt.bitsPerSample === 16) {
      for (let t = 0; t < frameCount; t++) {
        for (let ch = 0; ch < fmt.channels; ch++) {
          const v = dv.getInt16(dataStart + t * frameBytes + ch * 2, true);
          channels[ch][t] = v / 32768.0;
        }
      }
    } else {
      for (let t = 0; t < frameCount; t++) {
        for (let ch = 0; ch < fmt.channels; ch++) {
          const off = t * frameBytes + ch * 3;
          let s = dataBytes[off] | (dataBytes[off + 1] << 8) | (dataBytes[off + 2] << 16);
          if (s & 0x800000) s -= 1 << 24;
          channels[ch][t] = s / 8388608.0;
        }
      }
    }
    return {
      channels,
      frameCount,
      sampleRate: fmt.sampleRate,
      channelsCount: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      duration,
    };
  }

  function validateGeometry(geo, channelCount) {
    if (!geo || typeof geo !== "object") throw new Error("JSON 内容不是对象");
    const coords = geo.coordinates_m;
    if (!Array.isArray(coords)) throw new Error("缺少 coordinates_m 数组");
    if (coords.length !== channelCount) {
      throw new Error(
        "coordinates_m 长度 " + coords.length + " 与 WAV 声道数 " + channelCount + " 不一致"
      );
    }
    coords.forEach((p, idx) => {
      if (!Array.isArray(p) || p.length !== 2 || !isFinite(p[0]) || !isFinite(p[1])) {
        throw new Error("第 " + idx + " 个坐标不是 [x, y] 数值对");
      }
    });
    const c = geo.speed_m_s;
    if (typeof c !== "number" || !isFinite(c) || c <= 0) {
      throw new Error("speed_m_s 必须为正数");
    }
    return { coordinates: coords.map((p) => [p[0], p[1]]), speed: c };
  }

  // ---------------- FFT（in-place radix-2 DIT） ----------------

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function fft(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1.0;
        let ci = 0.0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tr = cr * re[b] - ci * im[b];
          const ti = cr * im[b] + ci * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
          const nwr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nwr;
        }
      }
    }
  }

  // IFFT 实部：IFFT(X) = conj(FFT(conj(X)))/N
  function ifftReal(reSpec, imSpec) {
    const n = reSpec.length;
    const re = reSpec.slice();
    const im = new Float64Array(n);
    for (let k = 0; k < n; k++) im[k] = -imSpec[k];
    fft(re, im);
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = re[k] / n;
    return out;
  }

  // ---------------- 分析流水线 ----------------

  const SILENCE_RMS_FLOOR = 1e-6;      // 满量程归一化 RMS
  const GCC_PEAK_FLOOR = 1e-4;         // PHAT 相关峰有效性下限
  const RANK_REL_FLOOR = 1e-12;        // 二维张成判定
  const RESIDUAL_WARN_SAMPLES = 0.5;   // 残差告警（样本）

  function hannWindow(n) {
    const w = new Float64Array(n);
    if (n === 1) {
      w[0] = 1;
      return w;
    }
    for (let k = 0; k < n; k++) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    return w;
  }

  // 对给定区间做全部逐对 GCC 测量（区间变化才需要重算）
  function measurePairs(audio, geometry, startFrame, endFrame) {
    const { sampleRate, channelsCount, channels } = audio;
    const { coordinates, speed } = geometry;
    const n = endFrame - startFrame;
    if (n < Math.ceil(sampleRate * 0.2 - 1e-9)) {
      throw new Error("分析区间不足 0.2 秒");
    }
    const win = hannWindow(n);
    const nfft = nextPow2(2 * n - 1);

    // 去直流 + 对称 Hann 加窗，每声道只做一次 FFT
    const specRe = [];
    const specIm = [];
    const segRms = new Array(channelsCount).fill(0);
    const segPeak = new Array(channelsCount).fill(0);
    for (let ch = 0; ch < channelsCount; ch++) {
      const src = channels[ch];
      let mean = 0;
      for (let t = 0; t < n; t++) mean += src[startFrame + t];
      mean /= n;
      const re = new Float64Array(nfft);
      const im = new Float64Array(nfft);
      let sumSq = 0;
      let peak = 0;
      for (let t = 0; t < n; t++) {
        const v = src[startFrame + t] - mean;
        sumSq += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        re[t] = v * win[t];
      }
      fft(re, im);
      specRe.push(re);
      specIm.push(im);
      segRms[ch] = Math.sqrt(sumSq / n);
      segPeak[ch] = peak;
    }

    const pairs = [];
    for (let i = 0; i < channelsCount; i++) {
      for (let jj = i + 1; jj < channelsCount; jj++) {
        const dx = coordinates[jj][0] - coordinates[i][0];
        const dy = coordinates[jj][1] - coordinates[i][1];
        const baseline = Math.hypot(dx, dy);
        const maxLag = Math.ceil((baseline * sampleRate) / speed);
        const Ri = specRe[i];
        const Ii = specIm[i];
        const Rj = specRe[jj];
        const Ij = specIm[jj];
        const crossRe = new Float64Array(nfft);
        const crossIm = new Float64Array(nfft);
        for (let k = 0; k < nfft; k++) {
          // conj(Xi) * Xj
          const ar = Ri[k] * Rj[k] + Ii[k] * Ij[k];
          const ai = Ri[k] * Ij[k] - Ii[k] * Rj[k];
          const norm = Math.max(Math.hypot(ar, ai), 1e-12);
          crossRe[k] = ar / norm;
          crossIm[k] = ai / norm;
        }
        const gcc = ifftReal(crossRe, crossIm);
        const L = Math.min(maxLag, n - 1);
        const lags = new Int32Array(2 * L + 1);
        const vals = new Float64Array(2 * L + 1);
        for (let q = 0; q <= 2 * L; q++) {
          const lag = q - L;
          lags[q] = lag;
          vals[q] = gcc[lag >= 0 ? lag : nfft + lag];
        }
        let q0 = 0;
        for (let q = 1; q < vals.length; q++) {
          if (vals[q] > vals[q0]) q0 = q;
        }
        const intPeak = lags[q0];
        const peakValue = vals[q0];
        // 相邻三点抛物线细化
        let delta = 0;
        if (q0 > 0 && q0 < vals.length - 1) {
          const a = vals[q0 - 1];
          const b = vals[q0];
          const c = vals[q0 + 1];
          const denom = a - 2 * b + c;
          if (denom !== 0) delta = 0.5 * (a - c) / denom;
        }
        let refined = intPeak + delta;
        // 最终滞后限制到物理最大时延
        const atPhysicalLimit = Math.abs(intPeak) >= maxLag;
        if (refined > maxLag) refined = maxLag;
        if (refined < -maxLag) refined = -maxLag;
        pairs.push({
          i,
          j: jj,
          baseline,
          dx,
          dy,
          maxLag,
          lags: Array.from(lags),
          gcc: Array.from(vals),
          intPeak,
          gccPeak: peakValue,
          lagSamples: refined,
          tauS: refined / sampleRate,
          atPhysicalLimit,
          enabled: true,
          weight: 1,
        });
      }
    }

    return {
      nfft,
      segRms,
      segPeak,
      signalRms: Math.max.apply(null, segRms),
      pairs,
    };
  }

  // 2x2 对称 Gram 矩阵特征值（加权基线）
  function gramEigen(pairs) {
    let g00 = 0, g01 = 0, g11 = 0;
    for (const p of pairs) {
      const w = p.weight;
      g00 += w * p.dx * p.dx;
      g01 += w * p.dx * p.dy;
      g11 += w * p.dy * p.dy;
    }
    const tr = g00 + g11;
    const det = g00 * g11 - g01 * g01;
    const disc = Math.max(0, (0.5 * tr) * (0.5 * tr) - det);
    const s = Math.sqrt(disc);
    return [0.5 * tr + s, 0.5 * tr - s];
  }

  // 单位圆约束加权最小二乘方位拟合：0.1° 网格 + 黄金分割局部细化
  function fitBearing(pairs, geometry, sampleRate) {
    const speed = geometry.speed;
    const active = pairs.filter((p) => p.enabled && p.weight > 0);
    const warnings = [];
    if (active.length < 2) {
      return { valid: false, reason: "insufficient", message: "有效通道对不足，无法确定方向（至少需要 2 对）" };
    }
    const [l1, l2] = gramEigen(active);
    if (!(l1 > 0) || l2 <= RANK_REL_FLOOR * l1) {
      return {
        valid: false,
        reason: "collinear",
        message: "有效基线方向共线（张成空间维数不足 2），平面方位不可定",
        eigen: [l1, l2],
      };
    }
    if (active.every((p) => p.gccPeak < GCC_PEAK_FLOOR)) {
      return { valid: false, reason: "no_peak", message: "GCC-PHAT 无有效相关峰，片段可能不含共同声源" };
    }

    const cost = (theta) => {
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      let s = 0;
      for (const p of active) {
        const e = p.tauS + (p.dx * ux + p.dy * uy) / speed;
        s += p.weight * e * e;
      }
      return s;
    };

    const step = Math.PI / 1800; // 0.1°
    let bestTheta = 0;
    let bestCost = Infinity;
    for (let q = 0; q < 3600; q++) {
      const t = q * step;
      const v = cost(t);
      if (v < bestCost) {
        bestCost = v;
        bestTheta = t;
      }
    }
    let lo = bestTheta - step;
    let hi = bestTheta + step;
    const gr = (Math.sqrt(5) + 1) / 2;
    for (let k = 0; k < 60; k++) {
      const m1 = hi - (hi - lo) / gr;
      const m2 = lo + (hi - lo) / gr;
      if (cost(m1) < cost(m2)) hi = m2;
      else lo = m1;
    }
    const theta = (lo + hi) / 2;
    const bearingDeg = ((theta * 180) / Math.PI + 360) % 360;
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);

    let wsum = 0;
    let sse = 0;
    for (const p of pairs) {
      const predictedTau = -(p.dx * ux + p.dy * uy) / speed;
      p.predictedTauS = predictedTau;
      p.residualS = p.tauS - predictedTau;
      p.residualSamples = p.residualS * sampleRate;
      if (p.enabled && p.weight > 0) {
        wsum += p.weight;
        sse += p.weight * p.residualS * p.residualS;
        if (p.atPhysicalLimit) warnings.push("通道对 " + p.i + "–" + p.j + " 相关峰位于物理时延边界");
      }
    }
    const rmsS = Math.sqrt(sse / wsum);
    const rmsSamples = rmsS * sampleRate;
    if (rmsSamples > RESIDUAL_WARN_SAMPLES) {
      warnings.push("拟合残差 " + rmsSamples.toFixed(2) + " 样本，超过 " + RESIDUAL_WARN_SAMPLES + " 样本告警线");
    }
    return {
      valid: true,
      bearingDeg,
      u: [ux, uy],
      rmsS,
      rmsSamples,
      sse,
      eigen: [l1, l2],
      warnings,
    };
  }

  function checkSilence(measurement) {
    if (measurement.signalRms < SILENCE_RMS_FLOOR) {
      return {
        valid: false,
        reason: "silence",
        message: "片段近似静音或为常数（最大通道 RMS=" + measurement.signalRms.toExponential(1) + "），不可定位",
      };
    }
    return null;
  }

  return {
    decodePCM,
    validateGeometry,
    nextPow2,
    fft,
    ifftReal,
    measurePairs,
    fitBearing,
    checkSilence,
    gramEigen,
    hannWindow,
    constants: { SILENCE_RMS_FLOOR, GCC_PEAK_FLOOR, RANK_REL_FLOOR, RESIDUAL_WARN_SAMPLES },
  };
});
