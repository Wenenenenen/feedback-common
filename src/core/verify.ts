/** 核对工具：tiny 逐位核对、分块不变性自检、格式往返自检。 */

import { NlmsEngine } from './nlms';
import { encodeWav24, decodeWavPcm, type DecodedPcm } from './wav';
import type { NlmsConfig, TinyCheck, TinyExpected } from './types';
import { quantizeResidual } from './export';

/** 与 tiny-expected.json 逐位比对。 */
export function tinyCheck(engine: NlmsEngine, expected: TinyExpected): TinyCheck {
  const frames = expected.echo.length;
  let maxEchoError = 0;
  let maxResidualError = 0;
  let maxTapError = 0;
  let exact = true;
  for (let n = 0; n < frames; n += 1) {
    const dEcho = Math.abs(engine.echo[n] - expected.echo[n]);
    const dResidual = Math.abs(engine.residual[n] - expected.residual[n]);
    if (!Object.is(engine.echo[n], expected.echo[n]) || !Object.is(engine.residual[n], expected.residual[n])) {
      exact = false;
    }
    if (dEcho > maxEchoError) maxEchoError = dEcho;
    if (dResidual > maxResidualError) maxResidualError = dResidual;
  }
  for (let t = 0; t < expected.h.length; t += 1) {
    const tap = engine.taps[t] ?? 0;
    const dTap = Math.abs(tap - expected.h[t]);
    if (!Object.is(tap, expected.h[t])) exact = false;
    if (dTap > maxTapError) maxTapError = dTap;
  }
  return {
    // 通过条件：帧数与抽头数一致、所有输出差值 < 1e-12，且逐位相等。
    passed: exact && engine.totalFrames === frames && engine.config.taps === expected.h.length,
    exact,
    maxEchoError,
    maxResidualError,
    maxTapError,
    frames,
    taps: expected.h.length,
  };
}

export interface ChunkInvarianceResult {
  passed: boolean;
  sizes: number[];
  maxEchoDifference: number;
  maxResidualDifference: number;
  maxTapDifference: number;
  /** 每个分块尺寸处理后的最终抽头摘要。 */
  tapSums: Array<{ size: number; sum: number; frames: number }>;
}

/** 用多个分块尺寸跑完整段，比较输出与抽头是否完全一致。 */
export function chunkInvariance(
  reference: Float64Array,
  microphone: Float64Array,
  sampleRate: number,
  config: NlmsConfig,
  sizes: number[],
): ChunkInvarianceResult {
  const runs = sizes.map((size) => {
    const engine = new NlmsEngine({ reference, microphone, sampleRate, config });
    if (size <= 0) engine.runToEnd();
    else while (engine.frame < engine.totalFrames) engine.advance(size);
    return { size, engine };
  });
  const first = runs[0].engine;
  let maxEchoDifference = 0;
  let maxResidualDifference = 0;
  let maxTapDifference = 0;
  for (const run of runs.slice(1)) {
    for (let n = 0; n < first.totalFrames; n += 1) {
      const dEcho = Math.abs(run.engine.echo[n] - first.echo[n]);
      const dResidual = Math.abs(run.engine.residual[n] - first.residual[n]);
      if (dEcho > maxEchoDifference) maxEchoDifference = dEcho;
      if (dResidual > maxResidualDifference) maxResidualDifference = dResidual;
    }
    for (let t = 0; t < first.config.taps; t += 1) {
      const dTap = Math.abs(run.engine.taps[t] - first.taps[t]);
      if (dTap > maxTapDifference) maxTapDifference = dTap;
    }
  }
  const tapSums = runs.map((run) => ({
    size: run.size,
    sum: Array.from(run.engine.taps).reduce((sum, value) => sum + value, 0),
    frames: run.engine.frame,
  }));
  return {
    passed: maxEchoDifference === 0 && maxResidualDifference === 0 && maxTapDifference === 0,
    sizes: sizes.slice(),
    maxEchoDifference,
    maxResidualDifference,
    maxTapDifference,
    tapSums,
  };
}

export interface FormatCheck {
  name: string;
  passed: boolean;
  sampleRate: number;
  bitDepth: 16 | 24;
  frames: number;
  /** PCM → 浮点 → 重新编码 24 位 → 解码 的往返最大误差（LSB，24 位尺度）。 */
  roundTripLsb: number;
  /** 峰值绝对值。 */
  peak: number;
  reasons: string[];
}

/**
 * 格式自检：确认样例能导入，且在 [-1,1) 内的样本经 24 位编码后再解码
 * 与原值相差不超过 0.5 LSB（16 位样本在 24 位尺度下为整数倍，应完全无损）。
 */
export function formatSelfCheck(name: string, decoded: DecodedPcm): FormatCheck {
  const reasons: string[] = [];
  if (![8000, 16000, 48000].includes(decoded.sampleRate)) reasons.push(`采样率 ${decoded.sampleRate} 不在 8/16/48kHz`);
  if (decoded.numChannels !== 1) reasons.push(`声道数 ${decoded.numChannels} 不是单声道`);
  const bytes = encodeWav24(decoded.sampleRate, decoded.numFrames, (index) => quantizeResidual(decoded.samples[index]));
  const roundTrip = decodeWavPcm(bytes);
  let roundTripLsb = 0;
  for (let i = 0; i < decoded.numFrames; i += 1) {
    const before = decoded.samples[i];
    const after = roundTrip.samples[i];
    const diff = Math.abs(after - before) * 8388608;
    if (diff > roundTripLsb) roundTripLsb = diff;
  }
  if (roundTripLsb > 0.5 + 1e-9) reasons.push(`24 位往返误差 ${roundTripLsb.toFixed(3)} LSB 超过 0.5`);
  let peak = 0;
  for (let i = 0; i < decoded.numFrames; i += 1) peak = Math.max(peak, Math.abs(decoded.samples[i]));
  if (peak > 1) reasons.push(`峰值 ${peak} 超过 1`);
  return {
    name,
    passed: reasons.length === 0,
    sampleRate: decoded.sampleRate,
    bitDepth: decoded.bitDepth,
    frames: decoded.numFrames,
    roundTripLsb,
    peak,
    reasons,
  };
}
