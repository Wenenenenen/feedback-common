/** 样例 JSON（tiny.json / main.json / tiny-expected.json）解析与校验。 */

import type { FreezeRange, SampleConfig, TinyExpected, TruthIr } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFreeze(raw: unknown): FreezeRange[] {
  if (!Array.isArray(raw)) return [];
  const out: FreezeRange[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const start = Number(entry[0]);
    const end = Number(entry[1]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
      out.push({ start, end });
    }
  }
  return out;
}

function toTruthIr(raw: unknown): TruthIr | null {
  if (!Array.isArray(raw)) return null;
  const stages: TruthIr['stages'] = [];
  for (const stage of raw) {
    if (!Array.isArray(stage)) return null;
    const taps: Array<{ index: number; gain: number }> = [];
    for (const item of stage) {
      if (!Array.isArray(item) || item.length !== 2) return null;
      const index = Number(item[0]);
      const gain = Number(item[1]);
      if (!Number.isInteger(index) || !Number.isFinite(gain)) return null;
      taps.push({ index, gain });
    }
    stages.push(taps);
  }
  return { stages };
}

export function parseSampleConfig(raw: unknown): SampleConfig {
  if (!isObject(raw)) throw new Error('样例参数 JSON 顶层必须是对象');
  const delay = Number(raw.delay ?? 0);
  const taps = Number(raw.taps ?? 0);
  const mu = Number(raw.mu ?? 0);
  const leak = Number(raw.leak ?? 0);
  if (!Number.isInteger(delay) || !Number.isInteger(taps)) throw new Error('样例 delay / taps 必须是整数');
  if (!Number.isFinite(mu) || !Number.isFinite(leak)) throw new Error('样例 mu / leak 必须是数值');
  return {
    delay,
    taps,
    mu,
    leak,
    tiny: taps < 32,
    freeze: toFreeze(raw.freeze),
    truthIr: toTruthIr(raw['truth-ir']),
    expected: null,
  };
}

export function parseTinyExpected(raw: unknown): TinyExpected {
  if (!isObject(raw)) throw new Error('期望值 JSON 顶层必须是对象');
  const list = (key: string): number[] => {
    const value = raw[key];
    if (!Array.isArray(value)) throw new Error(`期望值缺少 ${key} 数组`);
    return value.map((item, index) => {
      const num = Number(item);
      if (!Number.isFinite(num)) throw new Error(`期望值 ${key}[${index}] 不是有限数`);
      return num;
    });
  };
  return { echo: list('echo'), residual: list('residual'), h: list('h') };
}

/** 按 truth-ir 生成真实回声（两阶段路径：第 2 阶段覆盖第 1 阶段）。 */
export function renderTruthEcho(
  reference: Float64Array,
  truth: TruthIr,
  switchFrame: number,
): Float64Array {
  const out = new Float64Array(reference.length);
  for (let n = 0; n < reference.length; n += 1) {
    const stage = n < switchFrame ? truth.stages[0] : truth.stages[1] ?? truth.stages[0];
    let y = 0;
    for (const tap of stage ?? []) {
      const idx = n - tap.index;
      if (idx >= 0 && idx < reference.length) y += tap.gain * reference[idx];
    }
    out[n] = y;
  }
  return out;
}
