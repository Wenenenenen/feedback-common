/**
 * 字幕向时间轴的投影。
 *
 * 字幕绑定在素材的源内时间上，经剪切后会重新映射到时间轴。
 * 一条字幕若跨过剪切点被切断，会按每段可见部分拆成多条，保证只显示实际可见的那部分。
 */
import type { SubtitleSet } from '../types';
import { SAMPLE_RATE, type TimelineLayout } from './timeline';

/** 投影到时间轴后的一条字幕 */
export interface ProjectedCue {
  /** 时间轴起点（秒） */
  start: number;
  /** 时间轴终点（秒） */
  end: number;
  text: string;
}

/**
 * 把某个素材的字幕投影到当前时间轴。
 * 只在引用了该素材的片段范围内显示；同一素材被多次使用时各自独立投影。
 */
export function projectCues(layout: TimelineLayout, subtitleSets: SubtitleSet[]): ProjectedCue[] {
  const out: ProjectedCue[] = [];

  for (const item of layout.clips) {
    const set = subtitleSets.find((candidate) => candidate.assetId === item.clip.assetId);
    if (!set) {
      continue;
    }

    const clipIn = item.clip.sourceIn;
    const clipOut = item.clip.sourceOut;

    for (const cue of set.cues) {
      // 与片段可见区间求交
      const visibleStart = Math.max(cue.start, clipIn);
      const visibleEnd = Math.min(cue.end, clipOut);
      if (visibleEnd <= visibleStart) {
        continue;
      }
      const offsetStart = (visibleStart - clipIn) * SAMPLE_RATE;
      const offsetEnd = (visibleEnd - clipIn) * SAMPLE_RATE;
      out.push({
        start: (item.startSample + offsetStart) / SAMPLE_RATE,
        end: (item.startSample + offsetEnd) / SAMPLE_RATE,
        text: cue.text,
      });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 取某时刻应显示的字幕（重叠时取最后一条，避免文字堆叠） */
export function cueAt(cues: ProjectedCue[], time: number): string | null {
  let found: ProjectedCue | null = null;
  for (const cue of cues) {
    if (time >= cue.start && time < cue.end) {
      found = cue;
    } else if (cue.start > time) {
      break;
    }
  }
  return found ? found.text : null;
}
