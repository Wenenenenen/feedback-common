/**
 * 时间轴布局与采样级映射。
 *
 * 关键设计：所有时刻都在 48kHz 采样域中表示，并由绝对时间轴位置反推源内位置，
 * 绝不“累加”经过的时间。这样无论剪多少刀、加多少转场，音画都不会逐步漂移。
 */
import type { Clip } from '../types';

/** 时间轴内部统一的采样率 */
export const SAMPLE_RATE = 48000;

/** 单段片段在时间轴上的排布结果 */
export interface ClipLayout {
  clip: Clip;
  /** 在原 clips 数组中的下标 */
  index: number;
  /** 时间轴起点（采样） */
  startSample: number;
  /** 时长（采样），由源入出点决定 */
  durSamples: number;
  /** 与下一段的重叠长度（采样），即转场时长 */
  transitionSamples: number;
}

/** 整条时间轴的排布结果 */
export interface TimelineLayout {
  clips: ClipLayout[];
  /** 总时长（采样） */
  totalSamples: number;
}

/**
 * 由片段列表计算时间轴排布。
 * 规则：每段按源时长铺开，与下一段的重叠长度等于转场时长，因此转场会轻微缩短总时长。
 */
export function buildLayout(clips: Clip[]): TimelineLayout {
  // 先算各段自身时长，转场需要前后两段时长做约束
  const durations = clips.map((clip) =>
    Math.max(1, Math.round((clip.sourceOut - clip.sourceIn) * SAMPLE_RATE)),
  );

  const transitions = clips.map((clip, index) => {
    if (index === clips.length - 1) {
      return 0;
    }
    const transition = clip.transitionOut;
    if (!transition || transition.type === 'none' || transition.duration <= 0) {
      return 0;
    }
    const requested = Math.round(transition.duration * SAMPLE_RATE);
    // 转场不能超过任一侧的片段长度
    return Math.max(0, Math.min(requested, durations[index], durations[index + 1]));
  });

  // 二次约束：中间片段两侧转场之和不能超过它自身长度，否则会出现三段同时重叠
  for (let i = 1; i < clips.length - 1; i++) {
    const sum = transitions[i - 1] + transitions[i];
    if (sum > durations[i]) {
      const excess = sum - durations[i];
      // 优先压缩较长的那个转场
      if (transitions[i - 1] >= transitions[i]) {
        transitions[i - 1] = Math.max(0, transitions[i - 1] - excess);
      } else {
        transitions[i] = Math.max(0, transitions[i] - excess);
      }
    }
  }

  const items: ClipLayout[] = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i++) {
    items.push({
      clip: clips[i],
      index: i,
      startSample: cursor,
      durSamples: durations[i],
      transitionSamples: transitions[i],
    });
    cursor += durations[i] - transitions[i];
  }

  const totalSamples = items.length > 0 ? items[items.length - 1].startSample + items[items.length - 1].durSamples : 0;

  return { clips: items, totalSamples };
}

/** 秒 → 采样（四舍五入到最近采样） */
export function timeToSample(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

/** 采样 → 秒 */
export function sampleToTime(sample: number): number {
  return sample / SAMPLE_RATE;
}

/** 返回该时刻处于活动状态的所有片段（转场区间会返回两段，按原顺序） */
export function activeClipsAt(layout: TimelineLayout, sample: number): ClipLayout[] {
  const out: ClipLayout[] = [];
  for (const item of layout.clips) {
    if (sample >= item.startSample && sample < item.startSample + item.durSamples) {
      out.push(item);
    }
  }
  return out;
}

/** 时间轴采样 → 片段内相对采样（片段起点为 0） */
export function localSampleOf(item: ClipLayout, sample: number): number {
  return sample - item.startSample;
}

/** 片段内相对采样 → 素材源内秒数（用入点加偏移，不累加历史时间） */
export function sourceTimeAt(item: ClipLayout, sample: number): number {
  return item.clip.sourceIn + localSampleOf(item, sample) / SAMPLE_RATE;
}

/** 某个时间轴采样位置是否落在“带转场的重叠区”内，是则返回重叠信息 */
export interface OverlapInfo {
  /** 较早片段（正在离场） */
  outgoing: ClipLayout;
  /** 较晚片段（正在入场） */
  incoming: ClipLayout;
  /** 重叠区内进度，0 → 1 */
  progress: number;
}

/**
 * 计算该采样点所在的重叠转场信息；不在重叠区返回 null。
 */
export function overlapAt(layout: TimelineLayout, sample: number): OverlapInfo | null {
  const active = activeClipsAt(layout, sample);
  if (active.length < 2) {
    return null;
  }
  const [outgoing, incoming] = active;
  const overlapSamples = outgoing.transitionSamples;
  if (overlapSamples <= 0) {
    return null;
  }
  const raw = (sample - incoming.startSample) / overlapSamples;
  const progress = Math.min(1, Math.max(0, raw));
  return { outgoing, incoming, progress };
}
