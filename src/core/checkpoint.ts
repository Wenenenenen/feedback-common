/**
 * 检查点保存与续算校验。
 *
 * 检查点记录全部数值状态（抽头、逐帧 y/e 前缀、抽头快照）与输入内容摘要；
 * 续算前必须确认：两份 WAV 与保存时逐字节相同、参数与冻结区间完全一致、
 * 前缀输出摘要自洽。任何一项不符都整份拒绝，不用“尽量接近”的方式续算。
 */

import { base64ToFloat64, float64ToBase64 } from './base64';
import { type NlmsEngine, type TapSnapshot } from './nlms';
import { concatFloat64LE, digestSha256, sha256Hex } from './digest';

export { digestSha256, sha256Hex };
import { configsEqual } from './params';
import { NLMS_CONSTANTS, type ClipMeta, type NlmsConfig } from './types';

export const CHECKPOINT_FORMAT = 'nlms-echo-desk/checkpoint';
export const CHECKPOINT_VERSION = 1;

export interface CheckpointJson {
  format: string;
  version: number;
  createdAt: string;
  /** 处理完的帧数；续算从该帧开始。 */
  frame: number;
  totalFrames: number;
  inputs: {
    reference: ClipMeta;
    microphone: ClipMeta;
  };
  params: {
    delay: number;
    taps: number;
    mu: number;
    leak: number;
    tiny: boolean;
  };
  freeze: Array<{ start: number; end: number }>;
  constants: { epsilon: number; gate: number };
  snapshotStride: number;
  /** 当前抽头（处理完 frame 帧之后）。 */
  taps: string;
  /** 前 frame 帧的 y 与 e，按 float64 小端序列化后 base64。 */
  echoPrefix: string;
  residualPrefix: string;
  /** 前缀输出（y 与 e 依序拼接）的 SHA-256，用于自洽校验。 */
  prefixDigest: string;
  /** 抽头快照（帧号 + float64 base64）。 */
  tapHistory: Array<{ frame: number; taps: string }>;
  /** 未处理的尾部不做任何记录（缺省即从 frame 起处理）。 */
}

export interface CheckpointBuildInput {
  engine: NlmsEngine;
  referenceMeta: ClipMeta;
  microphoneMeta: ClipMeta;
  createdAt?: string;
}

/** 生成检查点 JSON 对象（尚未做前缀摘要，需要异步补上）。 */
export function buildCheckpoint(input: CheckpointBuildInput): Omit<CheckpointJson, 'prefixDigest'> {
  const { engine } = input;
  const config = engine.config;
  return {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    frame: engine.frame,
    totalFrames: engine.totalFrames,
    inputs: {
      reference: input.referenceMeta,
      microphone: input.microphoneMeta,
    },
    params: {
      delay: config.delay,
      taps: config.taps,
      mu: config.mu,
      leak: config.leak,
      tiny: config.tiny,
    },
    freeze: config.freeze.map((range) => ({ start: range.start, end: range.end })),
    constants: { epsilon: engine.epsilon, gate: engine.gate },
    snapshotStride: engine.snapshotStride,
    taps: float64ToBase64(engine.taps),
    echoPrefix: float64ToBase64(engine.echo.subarray(0, engine.frame)),
    residualPrefix: float64ToBase64(engine.residual.subarray(0, engine.frame)),
    tapHistory: engine.tapHistory.map((entry) => ({ frame: entry.frame, taps: float64ToBase64(entry.taps) })),
  };
}

/** 补上前缀摘要并序列化。 */
export async function finalizeCheckpoint(engine: NlmsEngine, partial: Omit<CheckpointJson, 'prefixDigest'>): Promise<CheckpointJson> {
  const prefix = engine.prefixOutputBytes();
  return { ...partial, prefixDigest: `sha256-${await digestSha256(prefix)}` };
}

export function serializeCheckpoint(checkpoint: CheckpointJson): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export interface ResumeRejection {
  ok: false;
  reasons: string[];
}

export interface ResumeAcceptance {
  ok: true;
  frame: number;
  taps: Float64Array;
  echoPrefix: Float64Array;
  residualPrefix: Float64Array;
  tapHistory: TapSnapshot[];
  config: NlmsConfig;
  totalFrames: number;
}

export type ResumeResult = ResumeAcceptance | ResumeRejection;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 解析并校验检查点。
 * `referenceDigest` / `microphoneDigest` 为当前导入文件的内容摘要。
 */
export async function parseCheckpoint(
  text: string,
  current: { referenceDigest: string; microphoneDigest: string; totalFrames: number },
): Promise<ResumeResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reasons: [`检查点不是合法 JSON：${(error as Error).message}`] };
  }
  if (!isPlainObject(raw)) return { ok: false, reasons: ['检查点顶层必须是对象'] };
  const reasons: string[] = [];
  if (raw.format !== CHECKPOINT_FORMAT) reasons.push(`format 字段为 “${String(raw.format)}”，不是本工具的检查点`);
  if (asInteger(raw.version) === null) reasons.push('version 字段缺失或不是整数');
  else if ((raw.version as number) > CHECKPOINT_VERSION) reasons.push(`检查点版本 ${raw.version} 高于本程序支持的 ${CHECKPOINT_VERSION}`);
  if (reasons.length > 0) return { ok: false, reasons };

  const frame = asInteger(raw.frame);
  const totalFrames = asInteger(raw.totalFrames);
  if (frame === null || frame < 0) reasons.push('frame 字段缺失或不是非负整数');
  if (totalFrames === null || totalFrames <= 0) reasons.push('totalFrames 字段缺失或不是正整数');
  if (frame !== null && totalFrames !== null && frame > totalFrames) reasons.push(`检查点帧 ${frame} 超过总长 ${totalFrames}`);

  const params = raw.params;
  if (!isPlainObject(params)) reasons.push('params 字段缺失');
  const delay = isPlainObject(params) ? asInteger(params.delay) : null;
  const tapsCount = isPlainObject(params) ? asInteger(params.taps) : null;
  const mu = isPlainObject(params) ? asFinite(params.mu) : null;
  const leak = isPlainObject(params) ? asFinite(params.leak) : null;
  const tiny = isPlainObject(params) ? params.tiny === true : false;
  if (delay === null) reasons.push('params.delay 缺失或不是整数');
  else if (delay < 0 || delay > NLMS_CONSTANTS.maxDelay) reasons.push(`params.delay=${delay} 超出 0..${NLMS_CONSTANTS.maxDelay}`);
  if (tapsCount === null) reasons.push('params.taps 缺失或不是整数');
  else if (tapsCount < 2 || tapsCount > NLMS_CONSTANTS.maxTaps) reasons.push(`params.taps=${tapsCount} 超出 2..${NLMS_CONSTANTS.maxTaps}`);
  if (mu === null) reasons.push('params.mu 缺失或不是有限数');
  else if (mu < 0 || mu > 1) reasons.push(`params.mu=${mu} 超出 0..1`);
  if (leak === null) reasons.push('params.leak 缺失或不是有限数');
  else if (leak < 0 || leak > NLMS_CONSTANTS.maxLeak) reasons.push(`params.leak=${leak} 超出 0..${NLMS_CONSTANTS.maxLeak}`);

  const freezeRaw = raw.freeze;
  const freeze: Array<{ start: number; end: number }> = [];
  if (!Array.isArray(freezeRaw)) reasons.push('freeze 字段缺失或不是数组');
  else {
    freezeRaw.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        reasons.push(`freeze[${index}] 不是对象`);
        return;
      }
      const start = asInteger(entry.start);
      const end = asInteger(entry.end);
      if (start === null || end === null || start < 0 || start >= end) {
        reasons.push(`freeze[${index}] 端点非法`);
        return;
      }
      freeze.push({ start, end });
    });
  }

  const inputs = raw.inputs;
  if (!isPlainObject(inputs) || !isPlainObject(inputs.reference) || !isPlainObject(inputs.microphone)) {
    reasons.push('inputs 字段缺失');
  } else {
    const refDigest = String(inputs.reference.digest ?? '');
    const micDigest = String(inputs.microphone.digest ?? '');
    if (refDigest !== current.referenceDigest) {
      reasons.push('远端参考 WAV 与保存检查点时的文件不同（内容摘要不符）');
    }
    if (micDigest !== current.microphoneDigest) {
      reasons.push('麦克风 WAV 与保存检查点时的文件不同（内容摘要不符）');
    }
    const refFrames = asInteger(inputs.reference.numFrames);
    const micFrames = asInteger(inputs.microphone.numFrames);
    if (refFrames === null || micFrames === null) reasons.push('inputs 缺少帧数');
    else if (refFrames !== current.totalFrames || micFrames !== current.totalFrames) {
      reasons.push(`检查点输入为 ${refFrames}/${micFrames} 帧，与当前 ${current.totalFrames} 帧不符`);
    }
  }

  const constants = raw.constants;
  if (!isPlainObject(constants)) reasons.push('constants 字段缺失');
  else {
    if (asFinite(constants.epsilon) !== NLMS_CONSTANTS.epsilon) reasons.push('constants.epsilon 与包内约定 1e-8 不符');
    if (asFinite(constants.gate) !== NLMS_CONSTANTS.gate) reasons.push('constants.gate 与包内约定 1e-7 不符');
  }

  // 数值字段在结构校验通过后再解码，避免在残缺数据上抛错。
  if (reasons.length > 0) return { ok: false, reasons };

  let taps: Float64Array;
  let echoPrefix: Float64Array;
  let residualPrefix: Float64Array;
  try {
    if (typeof raw.taps !== 'string') throw new Error('taps 字段缺失或不是 base64 字符串');
    taps = base64ToFloat64(raw.taps, tapsCount as number);
  } catch (error) {
    return { ok: false, reasons: [`抽头解码失败：${(error as Error).message}`] };
  }
  try {
    if (typeof raw.echoPrefix !== 'string') throw new Error('echoPrefix 字段缺失');
    echoPrefix = base64ToFloat64(raw.echoPrefix, frame as number);
  } catch (error) {
    return { ok: false, reasons: [`估计回声前缀解码失败：${(error as Error).message}`] };
  }
  try {
    if (typeof raw.residualPrefix !== 'string') throw new Error('residualPrefix 字段缺失');
    residualPrefix = base64ToFloat64(raw.residualPrefix, frame as number);
  } catch (error) {
    return { ok: false, reasons: [`残差前缀解码失败：${(error as Error).message}`] };
  }

  const historyRaw = raw.tapHistory;
  const tapHistory: TapSnapshot[] = [];
  if (!Array.isArray(historyRaw)) {
    reasons.push('tapHistory 字段缺失或不是数组');
  } else {
    for (let index = 0; index < historyRaw.length; index += 1) {
      const entry = historyRaw[index];
      if (!isPlainObject(entry)) {
        reasons.push(`tapHistory[${index}] 不是对象`);
        break;
      }
      const at = asInteger(entry.frame);
      if (at === null || at < 0 || at > (frame as number)) {
        reasons.push(`tapHistory[${index}].frame 非法`);
        break;
      }
      try {
        const decoded = base64ToFloat64(String(entry.taps), tapsCount as number);
        tapHistory.push({ frame: at, taps: decoded });
      } catch (error) {
        reasons.push(`tapHistory[${index}] 抽头解码失败：${(error as Error).message}`);
        break;
      }
    }
  }
  if (tapHistory.length > 0 && tapHistory[0].frame !== 0) {
    tapHistory.unshift({ frame: 0, taps: new Float64Array(tapsCount as number) });
  }

  if (reasons.length > 0) return { ok: false, reasons };

  // 前缀输出摘要：确认检查点自身没有被截断或篡改。
  if (typeof raw.prefixDigest !== 'string' || !raw.prefixDigest.startsWith('sha256-')) {
    return { ok: false, reasons: ['prefixDigest 缺失或格式错误'] };
  }
  const prefix = concatFloat64LE(echoPrefix, residualPrefix);
  const actual = `sha256-${await digestSha256(prefix)}`;
  if (actual !== raw.prefixDigest) {
    return { ok: false, reasons: ['检查点的前缀输出摘要不符（文件可能被截断或改写）'] };
  }

  const config: NlmsConfig = {
    delay: delay as number,
    taps: tapsCount as number,
    mu: mu as number,
    leak: leak as number,
    tiny,
    freeze,
  };
  return {
    ok: true,
    frame: frame as number,
    taps,
    echoPrefix,
    residualPrefix,
    tapHistory,
    config,
    totalFrames: totalFrames as number,
  };
}

/** 续算前把检查点参数与界面参数比对，给出人话原因。 */
export function compareCheckpointConfig(checkpoint: NlmsConfig, current: NlmsConfig): string[] {
  if (configsEqual(checkpoint, current)) return [];
  const reasons: string[] = [];
  if (checkpoint.delay !== current.delay) reasons.push(`延迟：检查点 ${checkpoint.delay}，当前 ${current.delay}`);
  if (checkpoint.taps !== current.taps) reasons.push(`抽头数：检查点 ${checkpoint.taps}，当前 ${current.taps}`);
  if (checkpoint.mu !== current.mu) reasons.push(`步长 μ：检查点 ${checkpoint.mu}，当前 ${current.mu}`);
  if (checkpoint.leak !== current.leak) reasons.push(`泄漏：检查点 ${checkpoint.leak}，当前 ${current.leak}`);
  if (checkpoint.tiny !== current.tiny) reasons.push(`tiny 核对模式：检查点 ${checkpoint.tiny ? '开' : '关'}，当前 ${current.tiny ? '开' : '关'}`);
  const freezeDiffer =
    checkpoint.freeze.length !== current.freeze.length ||
    checkpoint.freeze.some((range, i) => range.start !== current.freeze[i].start || range.end !== current.freeze[i].end);
  if (freezeDiffer) reasons.push('冻结区间与检查点不同');
  return reasons;
}

/** 从检查点抽头快照生成可比较的摘要字符串（供测试使用）。 */
export function tapsHash(taps: Float64Array): string {
  const bytes = new Uint8Array(taps.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < taps.length; i += 1) view.setFloat64(i * 8, taps[i], true);
  return `sha256-${sha256Hex(bytes)}`;
}


