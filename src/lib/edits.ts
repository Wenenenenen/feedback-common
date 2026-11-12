/**
 * 时间轴编辑操作（纯函数）。
 *
 * 全部返回新数组，不做原地修改，方便 React 状态与撤销栈复用。
 */
import type { Clip } from '../types';
import { SAMPLE_RATE } from './timeline';

/** 最短片段时长（采样），避免切出零长度片段 */
const MIN_CLIP_SAMPLES = SAMPLE_RATE / 100; // 10ms

/** 生成唯一 id */
let idCounter = 0;
export function nextId(prefix = 'clip'): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}


/**
 * 在片段内某个源内时刻切一刀，返回切分后的片段列表。
 * 若切点太靠近边界则原样返回。
 */
export function splitClip(clip: Clip, atSourceTime: number): Clip[] {
  const minSpan = MIN_CLIP_SAMPLES / SAMPLE_RATE;
  if (atSourceTime <= clip.sourceIn + minSpan || atSourceTime >= clip.sourceOut - minSpan) {
    return [clip];
  }

  const left: Clip = {
    ...clip,
    sourceOut: atSourceTime,
    // 左侧不继承出场转场，转场归右侧片段所持有的“到下一段”关系
    transitionOut: { type: 'none', duration: 0 },
    fadeOut: Math.min(clip.fadeOut, atSourceTime - clip.sourceIn),
  };
  const right: Clip = {
    ...clip,
    id: nextId(),
    sourceIn: atSourceTime,
    fadeIn: Math.min(clip.fadeIn, clip.sourceOut - atSourceTime),
    transitionOut: clip.transitionOut,
  };
  return [left, right];
}

/** 删除片段 */
export function removeClip(clips: Clip[], clipId: string): Clip[] {
  return clips.filter((clip) => clip.id !== clipId);
}

/** 移动片段到新下标 */
export function moveClip(clips: Clip[], fromIndex: number, toIndex: number): Clip[] {
  if (fromIndex < 0 || fromIndex >= clips.length) {
    return clips;
  }
  const clampedTarget = Math.max(0, Math.min(clips.length - 1, toIndex));
  if (clampedTarget === fromIndex) {
    return clips;
  }
  const copy = clips.slice();
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(clampedTarget, 0, moved);
  return copy;
}

/** 调整片段源入点（拖动左边缘） */
export function trimIn(clip: Clip, newSourceIn: number, assetDuration: number): Clip {
  const minSpan = MIN_CLIP_SAMPLES / SAMPLE_RATE;
  const upperBound = Math.min(clip.sourceOut - minSpan, assetDuration);
  const lowerBound = 0;
  const sourceIn = Math.max(lowerBound, Math.min(upperBound, newSourceIn));
  return { ...clip, sourceIn };
}

/** 调整片段源出点（拖动右边缘） */
export function trimOut(clip: Clip, newSourceOut: number, assetDuration: number): Clip {
  const minSpan = MIN_CLIP_SAMPLES / SAMPLE_RATE;
  const lowerBound = Math.max(clip.sourceIn + minSpan, 0);
  const upperBound = assetDuration;
  const sourceOut = Math.max(lowerBound, Math.min(upperBound, newSourceOut));
  return { ...clip, sourceOut };
}
