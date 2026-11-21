/**
 * 逐样本 NLMS 回声消除核心。
 *
 * 数值约定（来自样例说明，全部按 Float64 计算）：
 * - u[j] = x[n - delay - j]，越界取 0（不钳位到边界）。
 * - 先算 y = h·u、e = d[n] - y，再决定是否更新。
 * - u·u >= gate 且 n 不在任何冻结区间时：
 *     h = (1 - leak)·h + μ·e·u / (epsilon + u·u)
 *   否则 h 完全不变。
 * - epsilon = 1e-8，gate = 1e-7。
 *
 * 每一步只依赖前一状态与输入样本；分块大小、暂停/续算都不改变结果。
 */

import { NLMS_CONSTANTS, type FreezeRange, type NlmsConfig } from './types';
import { concatFloat64LE } from './digest';
import { freezeMaskOf } from './params';

export interface TapSnapshot {
  /** 快照位于处理完 [0, frame) 帧之后（frame=0 为初始全零抽头）。 */
  frame: number;
  taps: Float64Array;
}

export interface EngineInput {
  reference: Float64Array;
  microphone: Float64Array;
  /** 采样率（仅用于导出 WAV 时写头，不参与计算）。 */
  sampleRate: number;
  config: NlmsConfig;
  /** 抽头快照间隔（帧）；默认使快照数不超过约 320。 */
  snapshotStride?: number;
}

export interface EngineResumeState {
  frame: number;
  taps: Float64Array;
  echoPrefix: Float64Array;
  residualPrefix: Float64Array;
  tapHistory: TapSnapshot[];
}

export interface IntervalEnergyResult {
  start: number;
  end: number;
  processedFrames: number;
  totalFrames: number;
  complete: boolean;
  echoMeanSquare: number | null;
  microphoneMeanSquare: number | null;
  residualMeanSquare: number | null;
  erleDb: number | null;
}

export class NlmsEngine {
  readonly reference: Float64Array;
  readonly microphone: Float64Array;
  readonly totalFrames: number;
  readonly sampleRate: number;
  readonly config: NlmsConfig;
  readonly epsilon = NLMS_CONSTANTS.epsilon;
  readonly gate = NLMS_CONSTANTS.gate;
  readonly snapshotStride: number;

  /** 下一条待处理的帧。 */
  frame = 0;
  taps: Float64Array;
  echo: Float64Array;
  residual: Float64Array;
  frozen: Uint8Array;
  updated: Uint8Array;
  tapHistory: TapSnapshot[] = [];

  constructor(input: EngineInput) {
    const { reference, microphone, config } = input;
    if (reference.length !== microphone.length) {
      throw new Error(`参考 ${reference.length} 帧与麦克风 ${microphone.length} 帧长度不等`);
    }
    this.reference = reference;
    this.microphone = microphone;
    this.totalFrames = reference.length;
    this.sampleRate = input.sampleRate;
    this.config = config;
    this.snapshotStride = Math.max(1, input.snapshotStride ?? Math.ceil(this.totalFrames / 320));
    this.taps = new Float64Array(config.taps);
    this.echo = new Float64Array(this.totalFrames);
    this.residual = new Float64Array(this.totalFrames);
    this.frozen = freezeMaskOf(config.freeze, this.totalFrames);
    this.updated = new Uint8Array(this.totalFrames);
  }

  /** 用检查点状态落位（调用方应先完成一致性校验）。 */
  restore(state: EngineResumeState): void {
    if (state.frame > this.totalFrames) throw new Error(`检查点帧 ${state.frame} 超过总长 ${this.totalFrames}`);
    if (state.taps.length !== this.taps.length) {
      throw new Error(`检查点抽头长度 ${state.taps.length} 与参数 ${this.taps.length} 不符`);
    }
    if (state.echoPrefix.length !== state.frame || state.residualPrefix.length !== state.frame) {
      throw new Error('检查点前缀输出长度与帧号不符');
    }
    this.frame = state.frame;
    this.taps.set(state.taps);
    this.echo.set(state.echoPrefix, 0);
    this.residual.set(state.residualPrefix, 0);
    this.recomputeUpdateFlags(0, state.frame);
    this.tapHistory = state.tapHistory.map((entry) => ({ frame: entry.frame, taps: Float64Array.from(entry.taps) }));
    if (this.tapHistory.length === 0 || this.tapHistory[0].frame !== 0) {
      this.tapHistory.unshift({ frame: 0, taps: new Float64Array(this.config.taps) });
    }
  }

  /** 前缀的更新标记完全由输入与配置决定，可直接重算（不重放滤波器）。 */
  private recomputeUpdateFlags(from: number, to: number): void {
    const { delay, taps } = this.config;
    const x = this.reference;
    const totalFrames = this.totalFrames;
    for (let n = from; n < to; n += 1) {
      if (this.frozen[n]) {
        this.updated[n] = 0;
        continue;
      }
      let energy = 0;
      const firstIndex = n - delay;
      for (let j = 0; j < taps; j += 1) {
        const idx = firstIndex - j;
        if (idx >= 0 && idx < totalFrames) energy += x[idx] * x[idx];
      }
      this.updated[n] = energy >= this.gate ? 1 : 0;
    }
  }

  /** 逐帧处理 count 帧，返回实际处理的帧数（到末尾即停）。 */
  advance(count: number): number {
    const start = this.frame;
    const target = Math.min(this.totalFrames, start + Math.max(0, Math.floor(count)));
    this.processRange(start, target);
    this.frame = target;
    return target - start;
  }

  runToEnd(): number {
    return this.advance(this.totalFrames - this.frame);
  }

  private processRange(from: number, to: number): void {
    const x = this.reference;
    const d = this.microphone;
    const h = this.taps;
    const taps = this.config.taps;
    const delay = this.config.delay;
    const mu = this.config.mu;
    const leak = this.config.leak;
    const frozenMask = this.frozen;
    const updatedMask = this.updated;
    const echo = this.echo;
    const residual = this.residual;
    const totalFrames = this.totalFrames;
    const oneMinusLeak = 1 - leak;
    const epsilon = this.epsilon;
    const gate = this.gate;
    const stride = this.snapshotStride;

    for (let n = from; n < to; n += 1) {
      let y = 0;
      let energy = 0;
      // 延迟后的参考窗口；越界帧取 0，不钳位到边界。
      const firstIndex = n - delay;
      for (let j = 0; j < taps; j += 1) {
        const idx = firstIndex - j;
        if (idx >= 0 && idx < totalFrames) {
          const uj = x[idx];
          y += h[j] * uj;
          energy += uj * uj;
        }
      }
      const e = d[n] - y;
      echo[n] = y;
      residual[n] = e;

      if (frozenMask[n] === 1) {
        // 冻结区间：抽头完全不变。
      } else if (energy >= gate) {
        updatedMask[n] = 1;
        const factor = (mu * e) / (epsilon + energy);
        for (let j = 0; j < taps; j += 1) {
          const idx = firstIndex - j;
          h[j] = oneMinusLeak * h[j] + (idx >= 0 && idx < totalFrames ? factor * x[idx] : 0);
        }
      } else {
        // 参考帧能量低于 gate：不更新。
      }

      const processed = n + 1;
      if (processed % stride === 0) this.recordSnapshot(processed);
    }
    if (to === this.totalFrames && this.tapHistory[this.tapHistory.length - 1]?.frame !== this.totalFrames) {
      this.recordSnapshot(this.totalFrames);
    }
  }

  private recordSnapshot(frame: number): void {
    this.tapHistory.push({ frame, taps: Float64Array.from(this.taps) });
  }

  currentTaps(): Float64Array {
    return Float64Array.from(this.taps);
  }

  progress(): { frame: number; totalFrames: number } {
    return { frame: this.frame, totalFrames: this.totalFrames };
  }

  /** 前 frame 帧输出（echo 与 residual 依序拼接）的字节，检查点据此比对。 */
  prefixOutputBytes(): Uint8Array {
    return concatFloat64LE(this.echo.subarray(0, this.frame), this.residual.subarray(0, this.frame));
  }
}

/** 区间能量统计（基于已处理前缀）。空区间各统计为 null。 */
export function intervalEnergy(engine: NlmsEngine, range: FreezeRange): IntervalEnergyResult {
  const start = Math.max(0, Math.min(range.start, engine.totalFrames));
  const end = Math.max(start, Math.min(range.end, engine.totalFrames));
  const processedEnd = Math.min(end, engine.frame);
  const processedFrames = Math.max(0, processedEnd - start);
  const totalFrames = end - start;
  const complete = totalFrames > 0 && processedFrames === totalFrames;

  if (processedFrames === 0) {
    return {
      start,
      end,
      processedFrames: 0,
      totalFrames,
      complete,
      echoMeanSquare: null,
      microphoneMeanSquare: null,
      residualMeanSquare: null,
      erleDb: null,
    };
  }

  let sumEcho = 0;
  let sumMic = 0;
  let sumResidual = 0;
  for (let n = start; n < processedEnd; n += 1) {
    const y = engine.echo[n];
    const d = engine.microphone[n];
    const e = engine.residual[n];
    sumEcho += y * y;
    sumMic += d * d;
    sumResidual += e * e;
  }
  const echoMeanSquare = sumEcho / processedFrames;
  const microphoneMeanSquare = sumMic / processedFrames;
  const residualMeanSquare = sumResidual / processedFrames;

  let erleDb: number | null = null;
  if (microphoneMeanSquare > 0 && residualMeanSquare > 0) {
    erleDb = 10 * Math.log10(microphoneMeanSquare / residualMeanSquare);
  } else if (microphoneMeanSquare > 0 && residualMeanSquare === 0) {
    erleDb = Infinity;
  } else if (microphoneMeanSquare === 0) {
    erleDb = null;
  }

  return {
    start,
    end,
    processedFrames,
    totalFrames,
    complete,
    echoMeanSquare,
    microphoneMeanSquare,
    residualMeanSquare,
    erleDb,
  };
}

/** 逐块均方（用于波形下的能量带）。 */
export function blockMeanSquare(values: Float64Array, processedFrames: number, window: number, blockCount: number): Float64Array {
  const out = new Float64Array(blockCount);
  const count = Math.max(0, Math.min(processedFrames, values.length));
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * window;
    const end = Math.min(count, start + window);
    if (end <= start) continue;
    let sum = 0;
    for (let n = start; n < end; n += 1) sum += values[n] * values[n];
    out[block] = sum / (end - start);
  }
  return out;
}
