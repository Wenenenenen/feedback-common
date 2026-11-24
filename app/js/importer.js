// importer.js — 导入包解析与规格校验
import { readZip } from './zip-reader.js';
import { parseWav, SAMPLE_RATE } from './wav-codec.js';

export const LIMITS = {
  maxTakes: 8,
  maxCues: 240,
  maxCandidates: 96,
  maxTakeSeconds: 180,
  maxChanges: 12,
};

const MAX_FRAMES = LIMITS.maxTakeSeconds * SAMPLE_RATE;

/**
 * @returns {Promise<{
 *   instance: object,            // 归一化后的求解实例
 *   takeAudio: Map<number, {name:string, samples:Int16Array, frames:number}>,
 *   warnings: string[],
 * }>}
 */
export async function importPackage(file) {
  const buf = await file.arrayBuffer();
  const files = await readZip(buf);
  const warnings = [];

  // ---- cues.json ----
  const jsonBytes = files.get('cues.json');
  if (!jsonBytes) throw new Error('压缩包中缺少 cues.json');
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
  } catch (e) {
    throw new Error(`cues.json 不是合法 JSON: ${e.message}`);
  }
  validateRaw(raw);

  // ---- 源轨 WAV ----
  if (!Array.isArray(raw.takes) || raw.takes.length === 0) {
    throw new Error('cues.json 的 takes 必须是非空数组');
  }
  if (raw.takes.length > LIMITS.maxTakes) {
    throw new Error(`源轨最多 ${LIMITS.maxTakes} 条, 当前 ${raw.takes.length} 条`);
  }
  const takeAudio = new Map();
  for (let t = 0; t < raw.takes.length; t++) {
    const name = raw.takes[t];
    const bytes = files.get(name);
    if (!bytes) throw new Error(`cues.json 引用的 ${name} 不在压缩包中`);
    const wav = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name);
    if (wav.frames > MAX_FRAMES) {
      throw new Error(`${name} 时长 ${(wav.frames / SAMPLE_RATE).toFixed(1)}s 超过 ${LIMITS.maxTakeSeconds}s 上限`);
    }
    takeAudio.set(t, wav);
  }

  // ---- 逐候选引用完整性 ----
  const idSeen = new Set();
  raw.cues.forEach((cue, k) => {
    if (!Array.isArray(cue.slot) || cue.slot.length !== 2 || cue.slot[0] < 0 || cue.slot[1] <= cue.slot[0]) {
      throw new Error(`第 ${k + 1} 句的 slot 非法`);
    }
    if (!Array.isArray(cue.candidates) || cue.candidates.length === 0) {
      throw new Error(`第 ${k + 1} 句没有候选`);
    }
    if (cue.candidates.length > LIMITS.maxCandidates) {
      throw new Error(`第 ${k + 1} 句候选数 ${cue.candidates.length} 超过 ${LIMITS.maxCandidates}`);
    }
    cue.candidates.forEach((c, q) => {
      if (!Array.isArray(c) || c.length !== 6) {
        throw new Error(`第 ${k + 1} 句第 ${q + 1} 条候选字段数不为 6`);
      }
      const [id, take, src, dst, len, cost] = c;
      if (!Number.isInteger(id) || id < 0) throw new Error(`候选编号必须是非负整数(句 ${k + 1})`);
      if (idSeen.has(id)) throw new Error(`候选编号 ${id} 重复`);
      idSeen.add(id);
      if (!Number.isInteger(take) || take < 0 || take >= raw.takes.length) {
        throw new Error(`候选 ${id} 的源轨编号 ${take} 越界`);
      }
      for (const [v, label] of [[src, '源起帧'], [dst, '目标起帧'], [len, '长度'], [cost, '代价']]) {
        if (!Number.isInteger(v) || v < 0) throw new Error(`候选 ${id} 的${label}必须是非负整数`);
      }
      const wav = takeAudio.get(take);
      if (src + len > wav.frames) {
        throw new Error(`候选 ${id} 的源区间 [${src}, ${src + len}) 超出 ${wav.name} 长度 ${wav.frames}`);
      }
    });
  });

  if (raw.frames > MAX_FRAMES) {
    throw new Error(`交付轨总时长 ${(raw.frames / SAMPLE_RATE).toFixed(1)}s 超过 ${LIMITS.maxTakeSeconds}s 上限`);
  }
  if (raw.changes > LIMITS.maxChanges) {
    warnings.push(`切轨上限 ${raw.changes} 超过允许的 ${LIMITS.maxChanges}, 已按 ${LIMITS.maxChanges} 处理`);
  }

  const instance = normalize(raw);
  return { instance, takeAudio, warnings };
}

function validateRaw(raw) {
  for (const key of ['takes', 'frames', 'gap', 'changes', 'switchCost', 'cues']) {
    if (!(key in raw)) throw new Error(`cues.json 缺少字段: ${key}`);
  }
  if (!Number.isInteger(raw.frames) || raw.frames <= 0) throw new Error('frames 必须是正整数');
  if (!Number.isInteger(raw.gap) || raw.gap < 0) throw new Error('gap 必须是非负整数');
  if (!Number.isInteger(raw.changes) || raw.changes < 0) throw new Error('changes 必须是非负整数');
  if (!Number.isInteger(raw.switchCost) || raw.switchCost < 0) throw new Error('switchCost 必须是非负整数');
  if (!Array.isArray(raw.cues)) throw new Error('cues 必须是数组');
  if (raw.cues.length > LIMITS.maxCues) {
    throw new Error(`句子数 ${raw.cues.length} 超过 ${LIMITS.maxCues} 句上限`);
  }
}

function normalize(raw) {
  return {
    takes: raw.takes,
    frames: raw.frames,
    gap: raw.gap,
    changes: Math.min(raw.changes, LIMITS.maxChanges),
    switchCost: raw.switchCost,
    cues: raw.cues.map((cue) => ({
      slot: cue.slot,
      candidates: cue.candidates.map((c) => ({
        id: c[0], take: c[1], src: c[2], dst: c[3], len: c[4], cost: c[5],
      })),
    })),
  };
}
