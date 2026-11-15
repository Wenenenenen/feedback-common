/*
 * 旋转模式与旋转参数的统一入口：静态欧拉角 ↔ 关键帧曲线互斥。
 *
 * buildRotation 把「界面状态」翻译成 dsp/rotation.js 需要的 rotation 对象。
 * 两种模式的字段互不允许混合：mode=static 时只读 yaw/pitch/roll，
 * mode=automation 时只读 keyframes。任何一半缺失都直接报错，
 * 不给「叠加」留口子。
 */

import { matrixFromEulerDeg, quatFromEulerDeg } from './quaternion.js';
import { AutomationCurve, AutomationError, validateKeyframes } from './automation.js';

export const MODES = ['static', 'automation'];

export class RotationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RotationInputError';
  }
}

function parseAngle(value, name) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new RotationInputError(`${name} 不能为空`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new RotationInputError(`${name} 不是有限数值`);
  if (Math.abs(n) > 3600) throw new RotationInputError(`${name} 必须在 ±3600° 之内`);
  return n;
}

/**
 * 静态角度 → rotation 对象。
 */
export function buildStaticRotation(yawDeg, pitchDeg, rollDeg) {
  const yaw = parseAngle(yawDeg, 'yaw');
  const pitch = parseAngle(pitchDeg, 'pitch');
  const roll = parseAngle(rollDeg, 'roll');
  const quat = quatFromEulerDeg(yaw, pitch, roll);
  return {
    mode: 'static',
    yaw,
    pitch,
    roll,
    quat,
    matrix: matrixFromEulerDeg(yaw, pitch, roll),
  };
}

/**
 * 关键帧 → rotation 对象。frameLimit 为 N-1（音频尚未载入时为 null）。
 */
export function buildAutomationRotation(rawKeyframes, frameLimit) {
  const { frames, quats, rawQuats, warnings } = validateKeyframes(rawKeyframes, frameLimit);
  return {
    mode: 'automation',
    frames,
    quats,
    rawQuats,
    warnings,
  };
}

/**
 * 界面状态 → rotation 对象。mode 与参数不一致时抛错。
 * @param {{mode:string, yaw:any, pitch:any, roll:any, keyframes:any[]}} state
 * @param {number|null} frameLimit
 */
export function buildRotation(state, frameLimit) {
  if (!MODES.includes(state.mode)) {
    throw new RotationInputError(`未知旋转模式：${state.mode}`);
  }
  if (state.mode === 'static') {
    if (state.keyframes && state.keyframes.length) {
      throw new RotationInputError('静态角度模式下不接受关键帧；两种模式互斥');
    }
    return buildStaticRotation(state.yaw, state.pitch, state.roll);
  }
  if (state.yaw != null || state.pitch != null || state.roll != null) {
    throw new RotationInputError('关键帧模式下不接受静态角度；两种模式互斥');
  }
  return buildAutomationRotation(state.keyframes, frameLimit);
}

/** rotation → 曲线（方向示意、时间轴绘制用）。静态模式也返回常数曲线。 */
export function curveFor(rotation) {
  if (rotation.mode === 'automation') {
    return new AutomationCurve(rotation.frames, rotation.quats);
  }
  return null;
}

/** 静态模式下的四元数（展示与导出格式 JSON 时使用）。 */
export function staticQuat(rotation) {
  return rotation.mode === 'static' ? rotation.quat : null;
}

export { AutomationError };
