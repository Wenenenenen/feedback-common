/**
 * 导出：24 位残差 WAV、未限幅 float64 残差、滤波器 JSON，以及削波统计。
 *
 * 24 位 WAV 的约定（来自样例说明）：
 * - e 先限幅到 [-1, 1 - 2^-23]，再四舍五入为 24 位整数；
 * - 削波指“限幅前越界”的帧数：e < -1 或 e > 1 - 2^-23；
 * - 原始残差另存小端 float64，不做任何限幅；
 * - 削波数在写 WAV 与写滤波器 JSON 时用同一函数统计，两处不会分叉。
 */

import { encodeWav24 } from './wav';
import { NLMS_CONSTANTS, type NlmsConfig } from './types';
import type { NlmsEngine } from './nlms';

/** Math.round 对 .5 向 +∞ 取整；这里需要对称四舍五入（远离零）。 */
export function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}

export interface ClipStats {
  /** 限幅前 e 低于 -1 的帧数。 */
  belowMin: number;
  /** 限幅前 e 高于 1-2^-23 的帧数。 */
  aboveMax: number;
  /** 合计削波帧数（WAV 写入时被限幅的样本数）。 */
  clipped: number;
  /** 限幅前绝对值最大。 */
  peak: number;
}

export function clipStatsOf(residual: Float64Array, frames: number): ClipStats {
  const limit = NLMS_CONSTANTS.clipMax;
  let belowMin = 0;
  let aboveMax = 0;
  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    const value = residual[i];
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    if (value < -1) belowMin += 1;
    else if (value > limit) aboveMax += 1;
  }
  return { belowMin, aboveMax, clipped: belowMin + aboveMax, peak };
}

/** 把一个残差样本映射为写进 24 位 WAV 的整数。 */
export function quantizeResidual(value: number): number {
  const limit = NLMS_CONSTANTS.clipMax;
  const clamped = Math.min(limit, Math.max(-1, value));
  const integer = roundHalfAwayFromZero(clamped * NLMS_CONSTANTS.pcm24Scale);
  return Math.min(NLMS_CONSTANTS.pcm24Scale - 1, Math.max(-NLMS_CONSTANTS.pcm24Scale, integer));
}

/** 导出 24 位残差 WAV（仅已处理前缀）。 */
export function buildResidualWav(engine: NlmsEngine, frames = engine.frame): { bytes: Uint8Array; stats: ClipStats } {
  const stats = clipStatsOf(engine.residual, frames);
  const bytes = encodeWav24(engine.sampleRate, frames, (index) => quantizeResidual(engine.residual[index]));
  return { bytes, stats };
}

/** 小端 float64 字节流（未限幅残差）。 */
export function buildResidualFloat64(engine: NlmsEngine, frames = engine.frame): Uint8Array {
  const out = new Uint8Array(frames * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frames; i += 1) view.setFloat64(i * 8, engine.residual[i], true);
  return out;
}

export interface FilterReportInput {
  engine: NlmsEngine;
  sampleRate: number;
  config: NlmsConfig;
  referenceName: string;
  microphoneName: string;
  referenceDigest: string;
  microphoneDigest: string;
  intervals: Array<{
    start: number;
    end: number;
    freeze: boolean;
    processedFrames: number;
    echoMeanSquare: number | null;
    microphoneMeanSquare: number | null;
    residualMeanSquare: number | null;
    erleDb: number | null;
  }>;
}

/** 滤波器 JSON：抽头、参数、进度、能量指标与削波统计。 */
export function buildFilterReport(input: FilterReportInput): Record<string, unknown> {
  const { engine, config } = input;
  const stats = clipStatsOf(engine.residual, engine.frame);
  return {
    format: 'nlms-echo-desk/filter-report',
    version: 1,
    createdAt: new Date().toISOString(),
    sampleRate: input.sampleRate,
    totalFrames: engine.totalFrames,
    processedFrames: engine.frame,
    inputs: {
      reference: { name: input.referenceName, digest: input.referenceDigest },
      microphone: { name: input.microphoneName, digest: input.microphoneDigest },
    },
    parameters: {
      delay: config.delay,
      taps: config.taps,
      mu: config.mu,
      leak: config.leak,
      tiny: config.tiny,
    },
    freeze: config.freeze.map((range) => ({ start: range.start, end: range.end })),
    constants: { epsilon: NLMS_CONSTANTS.epsilon, gate: NLMS_CONSTANTS.gate },
    taps: Array.from(engine.taps, (value) => (Object.is(value, -0) ? 0 : value)),
    intervals: input.intervals.map((interval) => ({
      start: interval.start,
      end: interval.end,
      freeze: interval.freeze,
      processedFrames: interval.processedFrames,
      echoMeanSquare: interval.echoMeanSquare,
      microphoneMeanSquare: interval.microphoneMeanSquare,
      residualMeanSquare: interval.residualMeanSquare,
      erleDb: interval.erleDb,
    })),
    clipping: {
      frames: stats.clipped,
      belowMin: stats.belowMin,
      aboveMax: stats.aboveMax,
      peakAbs: stats.peak,
    },
  };
}

/** 从滤波器 JSON 还原抽头（供核对与二次分析）。 */
export function tapsFromReport(report: Record<string, unknown>): Float64Array {
  const taps = report.taps;
  if (!Array.isArray(taps)) throw new Error('滤波器 JSON 缺少 taps 数组');
  const values = taps.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`taps[${index}] 不是有限数值`);
    }
    return value;
  });
  return Float64Array.from(values);
}
