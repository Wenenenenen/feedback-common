// BS.1770-4 / EBU Tech 3341 响度计量核心（自行实现）。
// - 400ms 块、100ms 步长，从整轨起点建立，末尾不完整块丢弃
// - M：400ms 短时响度（不加门限）；S：3s 瞬时响度（不加门限）
// - 整轨 I：−70 LUFS 绝对门限 + 相对门限（−10 LU）双重门限
// - 纯静音、无完整门限块时 I 记为 null（不可测）
// 输入为 planar 声道数组，声道权重 L/R/单声道均为 1.0。

import { kWeight } from './k-weighting.js';
import { truePeak } from './true-peak.js';

const ABSOLUTE_GATE = -70; // LUFS（含门限：块响度 ≥ −70）
const RELATIVE_OFFSET = -10; // LU
const BLOCK_MS = 400;
const HOP_MS = 100;
const MOMENTARY_S = 0.4;
const SHORT_S = 3;

function toDb(meanSquare) {
  if (meanSquare <= 0) return null;
  return -0.691 + 10 * Math.log10(meanSquare);
}

/**
 * 计算全部 400ms 块的加权均方（每块一个数，已含声道权重）。
 * 用滑动窗口差分累加，避免每块重复求和。
 */
function blockMeanSquares(weightedChannels, blockSize, hop, channels) {
  const frames = weightedChannels[0].length;
  const blockCount = Math.max(0, Math.floor((frames - blockSize) / hop) + 1);
  const means = new Float64Array(blockCount);
  if (blockCount === 0) return means;

  // 初始块（索引 0..blockSize-1）各声道平方和
  let sums = new Float64Array(channels);
  for (let c = 0; c < channels; c++) {
    const ch = weightedChannels[c];
    let s = 0;
    for (let n = 0; n < blockSize; n++) s += ch[n] * ch[n];
    sums[c] = s;
  }

  for (let b = 0; b < blockCount; b++) {
    if (b > 0) {
      const start = b * hop;
      const prevStart = (b - 1) * hop;
      for (let c = 0; c < channels; c++) {
        const ch = weightedChannels[c];
        let s = sums[c];
        for (let n = prevStart; n < start; n++) s -= ch[n] * ch[n];
        for (let n = prevStart + blockSize; n < start + blockSize; n++) s += ch[n] * ch[n];
        sums[c] = s;
      }
    }
    let z = 0;
    for (let c = 0; c < channels; c++) z += sums[c] / blockSize; // 权重 1.0
    means[b] = z;
  }
  return means;
}

/**
 * 双重门限整轨响度。
 * @returns {number|null} LUFS
 */
function gatedLoudness(blockMs) {
  // 第一遍：绝对门限
  const kept = [];
  for (let i = 0; i < blockMs.length; i++) {
    const db = toDb(blockMs[i]);
    if (db !== null && db >= ABSOLUTE_GATE) kept.push(blockMs[i]);
  }
  if (kept.length === 0) return null;

  const absMean = kept.reduce((a, b) => a + b, 0) / kept.length;
  const absLoudness = toDb(absMean);
  if (absLoudness === null) return null;

  // 第二遍：相对门限 = 绝对门限响度 − 10 LU
  const relativeGate = absLoudness + RELATIVE_OFFSET;
  let relSum = 0;
  let relCount = 0;
  for (let i = 0; i < blockMs.length; i++) {
    const db = toDb(blockMs[i]);
    if (db !== null && db > relativeGate) {
      relSum += blockMs[i];
      relCount++;
    }
  }
  if (relCount === 0) return null;
  return toDb(relSum / relCount);
}

/**
 * 3 秒 S 曲线：样本级精确滑动窗口，100ms 步长，不加门限。
 * 先把各声道 K 加权能量按样本求和为混合能量序列，再用滑动窗口求每个
 * 3 秒窗口的均方响度。窗口右端时间与 M 曲线一致（每 100ms 一个）。
 * 起点处不足完整 3s 窗口的采样点记 null。
 */
function shortTermCurve(weightedChannels, sampleRate, channels, blockSize, hop) {
  const frames = weightedChannels[0].length;
  // 混合能量序列（每样本各声道加权平方和）
  const mixSq = new Float64Array(frames);
  for (let c = 0; c < channels; c++) {
    const ch = weightedChannels[c];
    for (let n = 0; n < frames; n++) mixSq[n] += ch[n] * ch[n];
  }
  // 混合能量前缀和，O(1) 求任意窗口和
  const prefix = new Float64Array(frames + 1);
  for (let n = 0; n < frames; n++) prefix[n + 1] = prefix[n] + mixSq[n];

  const windowSamples = Math.round((SHORT_S * sampleRate)); // 3s 样本数
  const blockCount = Math.floor((frames - blockSize) / hop) + 1;
  const points = [];
  for (let b = 0; b < blockCount; b++) {
    const end = b * hop + blockSize; // 窗口右端样本（不含）
    const start = end - windowSamples;
    const t = end / sampleRate;
    if (start < 0) {
      points.push({ t, lufs: null });
      continue;
    }
    const sum = prefix[end] - prefix[start];
    points.push({ t, lufs: toDb(sum / windowSamples) });
  }
  return points;
}

/**
 * 完整分析。
 * @param {Float32Array[]} planar 原始（未加权）planar 样本
 * @param {number} sampleRate
 * @param {object} [opts]
 */
export function analyze(planar, sampleRate, opts = {}) {
  const oversampleFactor = opts.oversampleFactor ?? 4;
  const channels = planar.length;
  const frames = planar[0].length;

  // 1) 逐声道 K 加权（Float64 精度）
  const weighted = planar.map((ch) => kWeight(ch, sampleRate));

  // 2) 400ms / 100ms 块序列
  const blockSize = Math.round((BLOCK_MS / 1000) * sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  const blockMs = blockMeanSquares(weighted, blockSize, hop, channels);
  const hasFullBlock = blockMs.length > 0;

  // 3) M 曲线（400ms，不加门限），时间戳为窗口右端（首个块在 0.4s 结束）
  const mCurve = [];
  for (let b = 0; b < blockMs.length; b++) {
    mCurve.push({
      t: (b * hop + blockSize) / sampleRate,
      lufs: toDb(blockMs[b]),
    });
  }

  // 4) S 曲线（3s，不加门限）。对加权混合能量做样本级精确 3 秒滑动窗口，
  //    每 100ms 输出一个点；起点之前不足完整 3s 窗口的点记 null。
  const sCurve = shortTermCurve(weighted, sampleRate, channels, blockSize, hop);

  // 5) 整轨 I（双重门限）
  const integrated = hasFullBlock ? gatedLoudness(blockMs) : null;

  // 6) 逐声道采样峰值（原始 PCM，不做过采样）
  const samplePeaksLinear = planar.map((ch) => {
    let p = 0;
    for (let n = 0; n < ch.length; n++) {
      const a = Math.abs(ch[n]);
      if (a > p) p = a;
    }
    return p;
  });
  const allDigitalSilence = samplePeaksLinear.every((p) => p === 0);
  const samplePeakDbfs = samplePeaksLinear.map((p) => (p === 0 ? null : 20 * Math.log10(p)));

  // 7) 逐声道真峰值（≥4 倍过采样）；纯静音不可测
  const tp = allDigitalSilence
    ? { peaksLinear: samplePeaksLinear.map(() => 0), dbtp: samplePeaksLinear.map(() => null) }
    : truePeak(planar, oversampleFactor);

  return {
    sampleRate,
    channels,
    frames,
    duration: frames / sampleRate,
    block: { sizeMs: BLOCK_MS, hopMs: HOP_MS, shortWindowS: SHORT_S },
    oversampleFactor,
    integratedLufs: integrated,
    mCurve,
    sCurve,
    perChannel: planar.map((_, c) => ({
      channel: c + 1,
      samplePeakDbfs: samplePeakDbfs[c],
      truePeakDbtp: tp.dbtp[c],
      samplePeakLinear: samplePeaksLinear[c],
      truePeakLinear: tp.peaksLinear[c],
    })),
    digitalSilence: allDigitalSilence,
  };
}
