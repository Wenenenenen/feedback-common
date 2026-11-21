/** 参数校验与冻结区间归一化。所有拒绝都给出具体原因，且不修改调用方数据。 */

import { NLMS_CONSTANTS, type FreezeRange, type NlmsConfig, type NlmsParams } from './types';

export interface ConfigValidation {
  ok: boolean;
  errors: string[];
  /** 仅当 ok 时存在：冻结区间已归一化（排序、重叠/相邻合并）。 */
  config: NlmsConfig | null;
}

export interface NormalizedFreeze {
  ranges: FreezeRange[];
  errors: string[];
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 叠加区间并集：排序后合并相交或相接的区间。输入不被修改。 */
export function normalizeFreeze(input: ReadonlyArray<FreezeRange>, totalFrames: number, field = '冻结区间'): NormalizedFreeze {
  const errors: string[] = [];
  if (!Array.isArray(input)) {
    return { ranges: [], errors: [`${field}必须是区间数组`] };
  }
  const prepared: FreezeRange[] = [];
  input.forEach((range, index) => {
    if (!range || typeof range !== 'object') {
      errors.push(`${field}[${index}] 不是对象`);
      return;
    }
    const { start, end } = range as FreezeRange;
    if (!isInteger(start) || !isInteger(end)) {
      errors.push(`${field}[${index}] 端点必须是整数帧（收到 ${String(start)} / ${String(end)}）`);
      return;
    }
    if (start < 0) {
      errors.push(`${field}[${index}] 起点 ${start} 不能为负`);
      return;
    }
    if (end > totalFrames) {
      errors.push(`${field}[${index}] 终点 ${end} 超出文件长度 ${totalFrames} 帧（终点不含）`);
      return;
    }
    if (start >= end) {
      errors.push(`${field}[${index}] 空区间 [${start}, ${end})：起点必须小于终点`);
      return;
    }
    prepared.push({ start, end });
  });
  if (errors.length > 0) return { ranges: [], errors };
  prepared.sort((a, b) => a.start - b.start || a.end - b.end);
  const ranges: FreezeRange[] = [];
  for (const range of prepared) {
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      ranges.push({ start: range.start, end: range.end });
    }
  }
  return { ranges, errors: [] };
}

export function validateConfig(params: NlmsParams & { freeze?: ReadonlyArray<FreezeRange>; tiny?: boolean }, totalFrames: number): ConfigValidation {
  const errors: string[] = [];
  const { delay, taps, mu, leak } = params;
  const tiny = params.tiny === true;
  const freeze = params.freeze ?? [];

  if (!isInteger(delay)) errors.push('延迟必须是整数帧');
  else if (delay < 0 || delay > NLMS_CONSTANTS.maxDelay) {
    errors.push(`延迟 ${delay} 帧超出 0..${NLMS_CONSTANTS.maxDelay}`);
  }

  if (!isInteger(taps)) errors.push('抽头数必须是整数');
  else if (taps > NLMS_CONSTANTS.maxTaps) errors.push(`抽头数 ${taps} 超出上限 ${NLMS_CONSTANTS.maxTaps}`);
  else if (taps < (tiny ? NLMS_CONSTANTS.tinyMinTaps : NLMS_CONSTANTS.minTaps)) {
    errors.push(
      tiny
        ? `tiny 核对模式抽头数 ${taps} 低于 ${NLMS_CONSTANTS.tinyMinTaps}`
        : `普通模式抽头数 ${taps} 低于 ${NLMS_CONSTANTS.minTaps}（要用 2 抽头短滤波器请开启 tiny 核对模式）`,
    );
  }

  if (!isNumber(mu)) errors.push('步长 μ 必须是有限数值');
  else if (mu < 0 || mu > 1) errors.push(`步长 μ=${mu} 超出 0..1`);

  if (!isNumber(leak)) errors.push('泄漏系数必须是有限数值');
  else if (leak < 0 || leak > NLMS_CONSTANTS.maxLeak) errors.push(`泄漏系数 ${leak} 超出 0..${NLMS_CONSTANTS.maxLeak}`);

  const normalized = normalizeFreeze(freeze, totalFrames);
  errors.push(...normalized.errors);

  if (errors.length > 0) return { ok: false, errors, config: null };
  return {
    ok: true,
    errors: [],
    config: {
      delay,
      taps,
      mu,
      leak,
      tiny,
      freeze: normalized.ranges,
    },
  };
}

/** 参数数值完全相同（用于检查点续算的参数一致性判断）。 */
export function configsEqual(a: NlmsConfig, b: NlmsConfig): boolean {
  return (
    a.delay === b.delay &&
    a.taps === b.taps &&
    a.mu === b.mu &&
    a.leak === b.leak &&
    a.tiny === b.tiny &&
    a.freeze.length === b.freeze.length &&
    a.freeze.every((range, i) => range.start === b.freeze[i].start && range.end === b.freeze[i].end)
  );
}

/** 把冻结区间展开为逐帧掩码（长度 totalFrames）。 */
export function freezeMaskOf(ranges: ReadonlyArray<FreezeRange>, totalFrames: number): Uint8Array {
  const mask = new Uint8Array(totalFrames);
  for (const range of ranges) {
    const start = Math.max(0, range.start);
    const end = Math.min(totalFrames, range.end);
    for (let i = start; i < end; i += 1) mask[i] = 1;
  }
  return mask;
}
