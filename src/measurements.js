// 测量：通带纹波、镜像/混叠电平、群延迟、扫频 STFT、滤波器设计响应指标。
import { magnitudeSpectrum, interpolatedPeak, nextPow2, stft } from './fft.js';
import { prototypeResponse } from './filter.js';

function db(x) {
  return 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
}

/** 寻找谱中局部峰值（dB），返回 bin 列表（按幅度降序）。 */
function findPeaks(magDb, minDb = -120, minSeparation = 3) {
  const peaks = [];
  for (let i = 2; i < magDb.length - 2; i++) {
    if (magDb[i] < minDb) continue;
    if (
      magDb[i] >= magDb[i - 1] &&
      magDb[i] >= magDb[i + 1] &&
      magDb[i] >= magDb[i - 2] &&
      magDb[i] >= magDb[i + 2]
    ) {
      peaks.push(i);
    }
  }
  // 全局最大值一定纳入（即使位于主瓣斜坡、不满足严格局部峰条件）
  let globalBin = 2;
  for (let i = 3; i < magDb.length; i++) {
    if (magDb[i] > magDb[globalBin]) globalBin = i;
  }
  if (!peaks.includes(globalBin)) peaks.push(globalBin);
  // 按幅度降序，做最小间距抑制
  peaks.sort((a, b) => magDb[b] - magDb[a]);
  const kept = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.abs(q - p) >= minSeparation)) kept.push(p);
  }
  return kept;
}

/** 把任意频率折叠进 [0, Fs/2] 的基带。 */
export function foldBand(f, Fs) {
  const half = Fs / 2;
  let x = f % Fs;
  if (x < 0) x += Fs;
  if (x > half) x = Fs - x;
  return x;
}

/**
 * 重采样混叠/镜像频率。
 * 输入频率分量 fin 经 fo/fi 重采样后：
 *   - 基带（wanted）位置 = foldBand(fin·fo/fi, fo)
 *   - 高阶谱复制 n·fi ± fin（n≥1）各自独立折叠，产生混叠/镜像候选
 * 返回 { wanted, aliases }，aliases 已去重并排除与 wanted 重合者。
 */
export function aliasFrequencies(fin, fi, fo) {
  const ratio = fo / fi;
  const wanted = foldBand(fin * ratio, fo);
  const aliases = [];
  for (let n = 1; n <= 8; n++) {
    for (const base of [n * fi + fin, n * fi - fin, fin - n * fi]) {
      if (base <= 0) continue;
      const f = foldBand(base * ratio, fo);
      if (f < 0 || f > fo / 2) continue;
      if (Math.abs(f - wanted) < fo * 1e-6) continue; // 折叠回基带=主频自身
      if (!aliases.some((x) => Math.abs(x - f) < fo * 1e-6)) aliases.push(f);
    }
  }
  return { wanted, aliases: aliases.sort((a, b) => a - b) };
}

/**
 * 单音信号的精确测量：找到最强音（抛物线插值），并评估其镜像/混叠分量。
 * @param knownInputFreq 输出测量时可传入已知输入主音频率(Hz)，用于精确锁定混叠位置
 */
export function measureTone(samples, sampleRate, fi, fo, isOutput, nfft, knownInputFreq = null) {
  const spec = magnitudeSpectrum(samples, sampleRate, nfft);
  const { magDb, freqs, nfft: usedNfft } = spec;
  const peaks = findPeaks(magDb, -110, 4);
  const result = {
    spectrum: spec,
    toneFreq: null,
    toneDb: null,
    spurs: [],
    sfdrDb: null,
    floorMedianDb: null,
  };
  if (peaks.length === 0) return result;

  const mainBin = peaks[0];
  const pk = interpolatedPeak(magDb, mainBin);
  result.toneFreq = (pk.bin * sampleRate) / usedNfft;
  result.toneDb = pk.db;

  // 噪声底（剔除主峰附近 ±5 bin 后的中位数）
  const rest = [];
  for (let i = 1; i < magDb.length - 1; i++) {
    if (Math.abs(i - mainBin) > 5) rest.push(magDb[i]);
  }
  rest.sort((a, b) => a - b);
  result.floorMedianDb = rest[Math.floor(rest.length / 2)];

  if (isOutput) {
    // 优先使用已知输入主音频率，避免信号被滤除后噪声峰被误判
    const finEstimate = knownInputFreq !== null ? knownInputFreq : result.toneFreq * (fi / fo);
    const { wanted, aliases } = aliasFrequencies(finEstimate, fi, fo);
    result.wantedFreq = wanted;
    for (const f of aliases) {
      const bin = Math.round((f * usedNfft) / sampleRate);
      if (bin < 2 || bin >= magDb.length - 2) continue;
      const p = interpolatedPeak(magDb, bin);
      const fMeas = (p.bin * sampleRate) / usedNfft;
      result.spurs.push({
        freqHz: fMeas,
        db: p.db,
        relativeDb: p.db - result.toneDb,
        kind: fo < fi ? 'alias' : 'image',
      });
    }
    // SFDR：除主峰外的最高杂散（全带扫描）
    let worst = -Infinity;
    let worstBin = -1;
    for (const b of peaks) {
      if (Math.abs(b - mainBin) <= 4) continue;
      if (magDb[b] > worst) {
        worst = magDb[b];
        worstBin = b;
      }
    }
    if (worstBin >= 0) {
      const wp = interpolatedPeak(magDb, worstBin);
      result.sfdrDb = result.toneDb - wp.db;
    }
  }
  return result;
}

/**
 * 滤波器设计响应测量：通带纹波、-3dB 点、最小阻带衰减、过渡带宽度。
 * 频率均折算到低采样率域。
 */
export function measureFilterResponse(design) {
  const resp = prototypeResponse(design);
  const { magDb, freqsLow, fsLow } = resp;
  const nyqLow = fsLow / 2;

  const passEdge = design.passHz;
  const stopEdge = design.stopHz;
  // 通带纹波只统计平坦区（到通带边沿的 95%），避开滚降段
  const passFlatEdge = passEdge * 0.95;

  let passMax = -Infinity;
  let passMin = Infinity;
  let stopMin = Infinity;
  let stopMaxDb = -Infinity;
  let minus3db = null;

  for (let i = 1; i < magDb.length; i++) {
    const f = freqsLow[i];
    if (f <= passFlatEdge) {
      if (magDb[i] > passMax) passMax = magDb[i];
      if (magDb[i] < passMin) passMin = magDb[i];
    }
    if (f >= stopEdge && f <= nyqLow) {
      if (magDb[i] < stopMin) stopMin = magDb[i];
      if (magDb[i] > stopMaxDb) stopMaxDb = magDb[i];
    }
  }
  // -3dB 点（从通带边沿向下搜索第一次穿越 -3）
  for (let i = 1; i < magDb.length; i++) {
    if (magDb[i - 1] >= -3 && magDb[i] < -3) {
      const f0 = freqsLow[i - 1];
      const f1 = freqsLow[i];
      const y0 = magDb[i - 1];
      const y1 = magDb[i];
      minus3db = f0 + ((-3 - y0) / (y1 - y0)) * (f1 - f0);
      break;
    }
  }

  return {
    resp,
    passRippleDb: passMax - passMin,
    passMaxDb: passMax,
    passMinDb: passMin,
    stopAttenMinDb: -stopMaxDb,
    stopEdgeDb: stopMaxDb,
    minus3dbHz: minus3db,
    passEdgeHz: passEdge,
    stopEdgeHz: stopEdge,
    transitionHz: stopEdge - passEdge,
    predictedAttenDb: design.achievedAttenDb,
    beta: design.beta,
  };
}

/**
 * 群延迟测量。优先用脉冲信号：输出包络峰值位置与理论零延迟位置之差。
 * 找不到脉冲时返回 null（页面改用零延迟设计值说明）。
 */
export function measureGroupDelay(inData, outData, fi, fo) {
  // 单脉冲判定：显著非零样本（>1% 满度）占比极低（<0.1%），且存在一个孤立高峰
  let nonzero = 0;
  for (let i = 0; i < inData.length; i++) {
    if (Math.abs(inData[i]) > 0.01) nonzero++;
  }
  if (nonzero > Math.max(8, inData.length * 0.001)) return null;

  // 在输入中定位单脉冲（幅度 >= 0.2 且两侧紧邻样本几乎为 0）
  let p = -1;
  let amp = 0;
  for (let i = 0; i < inData.length; i++) {
    if (Math.abs(inData[i]) > Math.abs(amp)) {
      const around =
        (i > 0 ? Math.abs(inData[i - 1]) : 0) +
        (i + 1 < inData.length ? Math.abs(inData[i + 1]) : 0);
      if (Math.abs(inData[i]) >= 0.2 && around < 0.05 * Math.abs(inData[i])) {
        p = i;
        amp = inData[i];
      }
    }
  }
  if (p < 0) return null;

  // 输出峰值（绝对值），抛物线插值到分数样本
  let q = 0;
  for (let i = 1; i < outData.length - 1; i++) {
    if (Math.abs(outData[i]) > Math.abs(outData[q])) q = i;
  }
  const y0 = Math.abs(outData[q - 1]);
  const y1 = Math.abs(outData[q]);
  const y2 = Math.abs(outData[q + 1]);
  const denom = y0 - 2 * y1 + y2;
  const frac = denom === 0 ? 0 : 0.5 * (y0 - y2) / denom;
  const peakOut = q + frac;
  const theory = (p * fo) / fi; // 零延迟理论位置
  const delaySamples = peakOut - theory;
  return {
    impulseInputIndex: p,
    impulseAmplitude: amp,
    peakOutputIndex: peakOut,
    theoreticalPeakIndex: theory,
    delayOutputSamples: delaySamples,
    delaySeconds: delaySamples / fo,
  };
}

/**
 * 扫频信号分析：STFT 谱图 + 每帧主频 + 混叠区能量评估。
 * 对数扫频：主频随时间指数上升；混叠分量会在时间轴上形成与主频分离的亮线。
 */
export function analyzeSweep(samples, sampleRate, fi, fo, isOutput) {
  const winLen = 2048;
  const hop = 1024;
  const S = stft(samples, sampleRate, winLen, hop);
  const mainTrack = new Float64Array(S.matrix.length);
  const aliasTrack = new Float64Array(S.matrix.length);
  const aliasMaxDb = new Float64Array(S.matrix.length);

  for (let f = 0; f < S.matrix.length; f++) {
    const col = S.matrix[f];
    // 主频：列内最大值（跳过最低 2 bin）
    let mainBin = 2;
    for (let b = 3; b < col.length; b++) if (col[b] > col[mainBin]) mainBin = b;
    mainTrack[f] = (mainBin * sampleRate) / S.nfft;
    // 混叠：在理论折叠位置直接读电平（含 ±1 bin 取最大）
    let alias = NaN;
    if (isOutput) {
      const fin = mainTrack[f] * (fi / fo);
      const { aliases } = aliasFrequencies(fin, fi, fo);
      let best = -Infinity;
      let found = false;
      for (const fc of aliases) {
        const b = Math.round((fc * S.nfft) / sampleRate);
        for (const bb of [b - 1, b, b + 1]) {
          if (bb >= 2 && bb < col.length && Math.abs(bb - mainBin) > 4) {
            if (col[bb] > best) best = col[bb];
            found = true;
          }
        }
      }
      if (found) alias = best;
    }
    aliasMaxDb[f] = alias;
    aliasTrack[f] = alias;
  }

  const valid = aliasMaxDb.filter((x) => Number.isFinite(x));
  const maxAlias = valid.length ? Math.max(...valid) : null;
  const meanAlias = valid.length
    ? valid.reduce((a, b) => a + b, 0) / valid.length
    : null;

  return {
    stft: S,
    mainTrack,
    aliasTrack,
    maxAliasDb: maxAlias,
    meanAliasDb: meanAlias,
  };
}

/** 判断输入是否为扫频信号（主频随时间显著、单调漂移）。 */
export function detectSweep(samples, sampleRate) {
  if (samples.length < sampleRate * 1.5) return false;
  const n = samples.length;
  const winLen = 2048;
  const hop = 2048;
  const positions = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)];
  const freqs = [];
  for (const start of positions) {
    if (start + winLen > n) continue;
    const frame = samples.subarray(start, start + winLen);
    const spec = magnitudeSpectrum(frame, sampleRate, 2048);
    let b = 2;
    for (let i = 3; i < spec.magDb.length; i++) {
      if (spec.magDb[i] > spec.magDb[b]) b = i;
    }
    freqs.push((b * sampleRate) / spec.nfft);
  }
  let moves = 0;
  for (let i = 1; i < freqs.length; i++) {
    if (Math.abs(freqs[i] - freqs[i - 1]) > sampleRate / 2048 * 4) moves++;
  }
  return moves >= 2;
}

/** 综合测量入口。 */
export function runMeasurements({
  inData,
  outData,
  fi,
  fo,
  design,
  channels,
  isSweep,
}) {
  const ch0 = 0;
  const inTone = measureTone(inData[ch0], fi, fi, fo, false, 32768);
  const outTone = measureTone(
    outData[ch0], fo, fi, fo, true, 32768,
    inTone.toneFreq !== null ? inTone.toneFreq : null
  );
  const filter = measureFilterResponse(design);
  const groupDelay = measureGroupDelay(inData[ch0], outData[ch0], fi, fo);

  // 主音增益（输出/输入幅度差，dB）。
  // 若输入主音高于输出奈奎斯特（应被滤除），改为评估该频率在输出端的实际电平。
  let toneGainDb = null;
  if (inTone.toneDb !== null && outTone.toneDb !== null) {
    toneGainDb = outTone.toneDb - inTone.toneDb;
  }
  // 被滤除信号：用输入主音在输出域的理论位置直接测电平，给出抑制量
  let suppressedDb = null;
  if (inTone.toneFreq !== null && inTone.toneFreq > fo / 2) {
    const folded = foldBand(inTone.toneFreq * (fo / fi), fo);
    const spec = outTone.spectrum;
    const bin = Math.round((folded * spec.nfft) / fo);
    if (bin >= 2 && bin < spec.magDb.length - 2) {
      suppressedDb = spec.magDb[bin] - inTone.toneDb;
    }
  }

  let sweep = null;
  if (isSweep) {
    sweep = {
      input: analyzeSweep(inData[ch0], fi, fi, fo, false),
      output: analyzeSweep(outData[ch0], fo, fi, fo, true),
    };
  }

  return {
    inTone,
    outTone,
    filter,
    groupDelay,
    toneGainDb,
    suppressedDb,
    sweep,
  };
}
