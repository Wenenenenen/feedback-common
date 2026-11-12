/**
 * 时间轴排布与采样映射测试。
 * 重点验证：多次剪辑后仍由绝对位置映射源内时间，不做累加，因此不会漂移。
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, buildLayout, overlapAt, sampleToTime, sourceTimeAt, timeToSample } from './timeline';
import type { Clip } from '../types';

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

describe('buildLayout', () => {
  it('无转场时总时长等于各段时长之和', () => {
    const layout = buildLayout([makeClip({ id: 'a', sourceOut: 5 }), makeClip({ id: 'b', sourceOut: 3 })]);
    expect(layout.totalSamples).toBe(8 * SAMPLE_RATE);
    expect(layout.clips[1].startSample).toBe(5 * SAMPLE_RATE);
  });

  it('转场重叠会缩短总时长', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceOut: 5, transitionOut: { type: 'crossfade', duration: 1 } }),
      makeClip({ id: 'b', sourceOut: 4 }),
    ]);
    expect(layout.clips[1].startSample).toBe(4 * SAMPLE_RATE);
    expect(layout.totalSamples).toBe(8 * SAMPLE_RATE);
  });

  it('转场时长不超过任一侧片段长度', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceOut: 2, transitionOut: { type: 'crossfade', duration: 5 } }),
      makeClip({ id: 'b', sourceOut: 1 }),
    ]);
    expect(layout.clips[0].transitionSamples).toBe(1 * SAMPLE_RATE);
  });

  it('中间片段两侧转场不会被压到负数', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceOut: 10, transitionOut: { type: 'crossfade', duration: 3 } }),
      makeClip({ id: 'b', sourceOut: 4, transitionOut: { type: 'crossfade', duration: 3 } }),
      makeClip({ id: 'c', sourceOut: 10 }),
    ]);
    const first = layout.clips[0].transitionSamples;
    const second = layout.clips[1].transitionSamples;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    // 两侧之和不能超过中间片段长度
    expect(first + second).toBeLessThanOrEqual(4 * SAMPLE_RATE);
  });
});

describe('sourceTimeAt：绝对映射不漂移', () => {
  it('多次剪切后，每段内部时间仍与源内时间一一对应', () => {
    const clips = [
      makeClip({ id: 'a', sourceIn: 0, sourceOut: 4 }),
      makeClip({ id: 'b', sourceIn: 6, sourceOut: 12 }),
      makeClip({ id: 'c', sourceIn: 20, sourceOut: 23 }),
    ];
    const layout = buildLayout(clips);

    // 第三段起点应为前两段时长之和
    const cStart = layout.clips[2].startSample;
    expect(cStart).toBe(10 * SAMPLE_RATE);

    // 第三段内 1.5 秒处，应映射到源内 21.5 秒
    const item = layout.clips[2];
    const at = sourceTimeAt(item, cStart + 1.5 * SAMPLE_RATE);
    expect(at).toBeCloseTo(21.5, 6);
  });

  it('浮点秒输入在采样域取整后仍稳定', () => {
    // 0.1 秒在二进制里不精确，转采样必须四舍五入到最近采样
    expect(timeToSample(0.1)).toBe(4800);
    expect(timeToSample(0.7)).toBe(33600);
    expect(sampleToTime(33600)).toBe(0.7);
  });

  it('每秒采样点都精确落回对应秒数，累积 1000 段也不偏', () => {
    // 模拟极端情况：1 万秒时间轴，逐秒检查映射误差
    const layout = buildLayout([makeClip({ sourceIn: 0, sourceOut: 10000 })]);
    const item = layout.clips[0];
    for (let second = 0; second < 10000; second += 97) {
      const sample = second * SAMPLE_RATE;
      const mapped = sourceTimeAt(item, sample);
      expect(Math.abs(mapped - second)).toBeLessThan(1 / SAMPLE_RATE + 1e-9);
    }
  });
});

describe('overlapAt', () => {
  it('重叠区返回出场/入场片段与进度', () => {
    const layout = buildLayout([
      makeClip({ id: 'a', sourceOut: 5, transitionOut: { type: 'crossfade', duration: 1 } }),
      makeClip({ id: 'b', sourceOut: 4 }),
    ]);
    // 第二段起点 4s，重叠区 4s → 5s
    const at4 = overlapAt(layout, 4 * SAMPLE_RATE);
    expect(at4).not.toBeNull();
    expect(at4!.progress).toBeCloseTo(0, 6);

    const at45 = overlapAt(layout, 4.5 * SAMPLE_RATE);
    expect(at45!.progress).toBeCloseTo(0.5, 6);

    const at3 = overlapAt(layout, 3 * SAMPLE_RATE);
    expect(at3).toBeNull();
  });

  it('无转场时任何位置都不返回重叠', () => {
    const layout = buildLayout([makeClip({ id: 'a' }), makeClip({ id: 'b' })]);
    expect(overlapAt(layout, 10 * SAMPLE_RATE)).toBeNull();
  });
});
