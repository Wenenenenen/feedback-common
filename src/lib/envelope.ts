/**
 * 音量包络与转场曲线。
 *
 * 叠化（crossfade）使用等功率曲线（sin/cos），听感上音量恒定；
 * 淡入淡出（dipToBlack）在画面中间变黑，声音对应做 V 形下潜。
 */
import type { TransitionType } from '../types';

/** 限制到 [0,1] */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 叠化入场增益（等功率） */
export function crossfadeIn(p: number): number {
  return Math.sin((clamp01(p) * Math.PI) / 2);
}

/** 叠化出场增益（等功率） */
export function crossfadeOut(p: number): number {
  return Math.cos((clamp01(p) * Math.PI) / 2);
}

/** 淡入淡出的入场增益：后半程才逐渐出声 */
export function dipIn(p: number): number {
  return clamp01(2 * clamp01(p) - 1);
}

/** 淡入淡出的出场增益：前半程迅速收声 */
export function dipOut(p: number): number {
  return clamp01(1 - 2 * clamp01(p));
}

/** 按转场类型取入场增益 */
export function transitionInGain(type: TransitionType, p: number): number {
  if (type === 'crossfade') return crossfadeIn(p);
  if (type === 'dipToBlack') return dipIn(p);
  return 1;
}

/** 按转场类型取出场增益 */
export function transitionOutGain(type: TransitionType, p: number): number {
  if (type === 'crossfade') return crossfadeOut(p);
  if (type === 'dipToBlack') return dipOut(p);
  return 1;
}

/** 画面合成用的入场透明度 */
export function transitionInAlpha(type: TransitionType, p: number): number {
  return transitionInGain(type, p);
}

/** 画面合成用的出场透明度 */
export function transitionOutAlpha(type: TransitionType, p: number): number {
  return transitionOutGain(type, p);
}
