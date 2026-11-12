/**
 * 剪辑操作与字幕投影测试。
 */
import { describe, expect, it } from 'vitest';
import { moveClip, removeClip, splitClip, trimIn, trimOut } from './edits';
import { SAMPLE_RATE, buildLayout } from './timeline';
import { cueAt, projectCues } from './subtitles';
import type { Clip, SubtitleSet } from '../types';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: overrides.id ?? 'c1',
    assetId: overrides.assetId ?? 'a1',
    sourceIn: overrides.sourceIn ?? 0,
    sourceOut: overrides.sourceOut ?? 10,
    muted: overrides.muted ?? false,
    fadeIn: overrides.fadeIn ?? 0,
    fadeOut: overrides.fadeOut ?? 0,
    transitionOut: overrides.transitionOut ?? { type: 'none', duration: 0 },
  };
}

describe('splitClip', () => {
  it('在中间切一刀，得到两段首尾相接、不重叠', () => {
    const [left, right] = splitClip(makeClip(), 4);
    expect(left.sourceIn).toBe(0);
    expect(left.sourceOut).toBe(4);
    expect(right.sourceIn).toBe(4);
    expect(right.sourceOut).toBe(10);
    expect(left.id).not.toBe(right.id);
  });

  it('切点过于靠近边界时原样返回，避免零长片段', () => {
    const result = splitClip(makeClip(), 0.001);
    expect(result).toHaveLength(1);
    expect(result[0].sourceOut).toBe(10);
  });

  it('切分后总时长保持不变', () => {
    const original = makeClip({ sourceOut: 10 });
    const [left, right] = splitClip(original, 3.7);
    const total = left.sourceOut - left.sourceIn + (right.sourceOut - right.sourceIn);
    expect(total).toBeCloseTo(10, 6);
  });
});

describe('trim', () => {
  it('入点不能越过出点', () => {
    const trimmed = trimIn(makeClip({ sourceIn: 0, sourceOut: 5 }), 6, 20);
    expect(trimmed.sourceIn).toBeLessThan(5);
  });

  it('出点不能超出素材时长', () => {
    const trimmed = trimOut(makeClip({ sourceIn: 0, sourceOut: 5 }), 30, 8);
    expect(trimmed.sourceOut).toBe(8);
  });
});

describe('removeClip / moveClip', () => {
  it('删除指定片段', () => {
    const clips = [makeClip({ id: 'a' }), makeClip({ id: 'b' })];
    expect(removeClip(clips, 'a')).toHaveLength(1);
    expect(removeClip(clips, 'a')[0].id).toBe('b');
  });

  it('移动顺序后总时长不变', () => {
    const clips = [
      makeClip({ id: 'a', sourceOut: 3 }),
      makeClip({ id: 'b', sourceOut: 2 }),
      makeClip({ id: 'c', sourceOut: 4 }),
    ];
    const before = buildLayout(clips).totalSamples;
    const moved = moveClip(clips, 0, 2);
    expect(moved.map((clip) => clip.id)).toEqual(['b', 'c', 'a']);
    expect(buildLayout(moved).totalSamples).toBe(before);
  });
});

describe('字幕投影', () => {
  const subtitleSets: SubtitleSet[] = [
    {
      assetId: 'a1',
      name: 'sintel',
      cues: [
        { start: 1, end: 4, text: '第一句' },
        { start: 7, end: 9, text: '被切掉一半的句子' },
      ],
    },
  ];

  it('字幕按片段入点重新映射到时间轴', () => {
    // 从源内 2s 开始剪，字幕 1-4s 只剩 2-4s 可见
    const layout = buildLayout([makeClip({ sourceIn: 2, sourceOut: 10 })]);
    const projected = projectCues(layout, subtitleSets);
    const first = projected.find((cue) => cue.text === '第一句');
    expect(first).toBeDefined();
    expect(first!.start).toBeCloseTo(0, 6);
    expect(first!.end).toBeCloseTo(2, 6);
  });

  it('跨剪切点的字幕只保留可见部分', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceIn: 0, sourceOut: 8 }),
      makeClip({ id: 'b', sourceIn: 8, sourceOut: 12 }),
    ]);
    const projected = projectCues(layout, subtitleSets);
    const cut = projected.find((cue) => cue.text === '被切掉一半的句子');
    // 原 7-9s，第一段里只有 7-8s 可见
    expect(cut!.start).toBeCloseTo(7, 6);
    expect(cut!.end).toBeCloseTo(8, 6);
  });

  it('同一素材被使用两次时字幕各投影一次', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceIn: 0, sourceOut: 2 }),
      makeClip({ id: 'b', sourceIn: 0, sourceOut: 2 }),
    ]);
    const projected = projectCues(layout, subtitleSets);
    const firsts = projected.filter((cue) => cue.text === '第一句');
    expect(firsts).toHaveLength(2);
    expect(firsts[0].start).toBeCloseTo(1, 6);
    expect(firsts[1].start).toBeCloseTo(3, 6);
  });

  it('cueAt 返回当前时刻应显示的文本', () => {
    const layout = buildLayout([makeClip({ sourceIn: 0, sourceOut: 10 })]);
    const projected = projectCues(layout, subtitleSets);
    expect(cueAt(projected, 2)).toBe('第一句');
    expect(cueAt(projected, 5)).toBeNull();
  });

  it('字幕时长与采样率无关，始终精确到秒', () => {
    const layout = buildLayout([makeClip({ sourceIn: 0, sourceOut: 10 })]);
    const projected = projectCues(layout, subtitleSets);
    const first = projected.find((cue) => cue.text === '第一句')!;
    expect((first.end - first.start) * SAMPLE_RATE).toBeCloseTo(3 * SAMPLE_RATE, 3);
  });
});
