/*
 * 关键帧自动化：解析、校验、序列化与曲线求值。
 *
 * 规则（与 conventions.json 一致）：
 * - frame 从 0 开始，关键帧必须严格递增，且都在 [0, N-1]（N 为音频帧数）。
 * - 四元数必须非零；导入即归一化。分量非有限、长度不为 4 一律拒绝。
 * - 零四元数、重复帧、越界帧、乱序帧全部拒绝，不做「宽容修正」。
 * - 相邻四元数点积为负时翻转后一项符号（最短弧），再走 SLERP。
 * - 端点之外保持最近端点值，不外推。
 * - 静态角度模式与关键帧模式互斥，由上层保证。
 */

import { alignShortestArc, normalizeQuat, slerp } from './quaternion.js';

export class AutomationError extends Error {
  constructor(message, index = -1) {
    super(message);
    this.name = 'AutomationError';
    this.index = index;
  }
}

/**
 * 校验并规范化关键帧。
 * @param {Array} raw 形如 [{frame, q:[w,x,y,z]}]
 * @param {number|null} frameLimit 最大合法帧号 N-1；null 表示音频尚未载入
 * @returns {{frames:number[], quats:number[][], warnings:string[]}}
 * @throws {AutomationError}
 */
export function validateKeyframes(raw, frameLimit, options = {}) {
  if (!Array.isArray(raw)) throw new AutomationError('关键帧必须是数组');
  if (raw.length === 0) throw new AutomationError('至少需要一个关键帧');
  const requireFrames = options.requireFrames !== false;
  const warnings = [];

  const outFrames = [];
  const outQuats = [];
  let lastFrame = -Infinity;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      throw new AutomationError('关键帧必须是对象 {frame, q}', i);
    }
    const q = item.q ?? item.quaternion;
    if (!Array.isArray(q) || q.length !== 4) {
      throw new AutomationError('q 必须是长度为 4 的数组 [w, x, y, z]', i);
    }
    for (let c = 0; c < 4; c++) {
      if (typeof q[c] !== 'number' || !Number.isFinite(q[c])) {
        throw new AutomationError(`q[${c}] 不是有限数值`, i);
      }
    }
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(n > 0)) throw new AutomationError('零四元数 [0, 0, 0, 0] 不可用', i);
    const norm = normalizeQuat(q);
    if (!norm) throw new AutomationError('四元数无法归一化', i);
    if (Math.abs(n - 1) > 1e-9) {
      warnings.push(`关键帧 #${i + 1} 模长 ${n.toPrecision(6)}，已归一化`);
    }

    let frame;
    if (item.frame == null) {
      if (requireFrames) throw new AutomationError('缺少 frame', i);
      frame = null;
    } else {
      if (typeof item.frame !== 'number' || !Number.isFinite(item.frame)) {
        throw new AutomationError('frame 必须是有限数值', i);
      }
      if (!Number.isInteger(item.frame)) {
        throw new AutomationError(`frame ${item.frame} 不是整数采样帧`, i);
      }
      if (item.frame < 0) throw new AutomationError(`frame ${item.frame} 小于 0`, i);
      frame = item.frame;
    }

    if (frame != null) {
      if (frame === lastFrame) {
        throw new AutomationError(`frame ${frame} 重复（第 ${i} 与第 ${i + 1} 个关键帧相同）`, i);
      }
      if (frame < lastFrame) {
        throw new AutomationError(
          `frame 必须严格递增（第 ${i + 1} 个为 ${frame}，前一个为 ${lastFrame}）`,
          i,
        );
      }
      lastFrame = frame;
    }

    outFrames.push(frame);
    outQuats.push(norm);
  }

  for (let i = 1; i < outQuats.length; i++) {
    const a = outQuats[i - 1];
    const b = outQuats[i];
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (dot < 0) {
      warnings.push(`关键帧 #${i + 1} 与 #${i} 点积 ${dot.toFixed(4)} < 0，已翻转后者取最短弧`);
    }
  }
  const aligned = alignShortestArc(outQuats);

  if (frameLimit != null && Number.isFinite(frameLimit)) {
    for (let i = 0; i < outFrames.length; i++) {
      if (outFrames[i] != null && outFrames[i] > frameLimit) {
        throw new AutomationError(
          `frame ${outFrames[i]} 超出音频范围 [0, ${frameLimit}]`,
          i,
        );
      }
    }
  }

  // quats 是下游应直接使用的形式（已归一化 + 已对齐最短弧）；
  // rawQuats 保留翻转前的归一化结果，便于界面显示用户原始输入。
  return { frames: outFrames, quats: aligned, rawQuats: outQuats, warnings };
}

/** 由 JSON 文本解析出关键帧数组。接受 {"keyframes":[...]} 或裸数组。 */
export function parseAutomationJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new AutomationError(`JSON 解析失败：${err.message}`);
  }
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.keyframes)) return doc.keyframes;
  throw new AutomationError('JSON 中找不到 keyframes 数组');
}

/** 关键帧 → 可导出的 JSON 文本。17 位有效数字保证回读后曲线不变。 */
export function serializeAutomation(frames, quats) {
  const keyframes = frames.map((frame, i) => ({
    frame,
    q: quats[i].map((v) => Number(v.toPrecision(17))),
  }));
  return JSON.stringify({ keyframes }, null, 2) + '\n';
}

/**
 * 关键帧曲线求值器。frames 严格递增；端点外保持端值。
 * 段内用 SLERP，段查找用二分（试听拖动时帧号会跳）。
 */
export class AutomationCurve {
  constructor(frames, quats) {
    if (!frames || frames.length === 0) throw new Error('关键帧曲线为空');
    this.frames = frames;
    this.quats = quats;
  }

  /** 帧号 f 处的归一化四元数。 */
  quatAt(f) {
    const frames = this.frames;
    const last = frames.length - 1;
    if (f <= frames[0]) return this.quats[0];
    if (f >= frames[last]) return this.quats[last];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid] <= f) lo = mid;
      else hi = mid;
    }
    const span = frames[hi] - frames[lo];
    return slerp(this.quats[lo], this.quats[hi], span > 0 ? (f - frames[lo]) / span : 0);
  }
}

/** 帧号 f 处的方向：末端 +X 被旋转到哪（用于方向示意）。 */
export function directionAt(curve, f) {
  const q = curve.quatAt(f);
  const [w, x, y, z] = q;
  // R * [1,0,0]ᵀ 的第一列
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
  ];
}
