/**
 * 转场与淡入淡出曲线测试：检查边界值与单调性，避免转场时音量跳变。
 */
import { describe, expect, it } from 'vitest';
import { crossfadeIn, crossfadeOut, dipIn, dipOut, transitionInGain, transitionOutGain } from './envelope';

describe('叠化曲线（等功率）', () => {
  it('起点与终点符合等功率边界', () => {
    expect(crossfadeIn(0)).toBeCloseTo(0, 6);
    expect(crossfadeIn(1)).toBeCloseTo(1, 6);
    expect(crossfadeOut(0)).toBeCloseTo(1, 6);
    expect(crossfadeOut(1)).toBeCloseTo(0, 6);
  });

  it('中点两侧功率之和为 1（不会出现音量凹谷）', () => {
    for (let i = 0; i <= 10; i++) {
      const p = i / 10;
      const inGain = crossfadeIn(p);
      const outGain = crossfadeOut(p);
      expect(inGain ** 2 + outGain ** 2).toBeCloseTo(1, 6);
    }
  });

  it('随进度单调递增/递减', () => {
    let previousIn = -1;
    let previousOut = 2;
    for (let i = 0; i <= 20; i++) {
      const p = i / 20;
      const inGain = crossfadeIn(p);
      const outGain = crossfadeOut(p);
      expect(inGain).toBeGreaterThanOrEqual(previousIn);
      expect(outGain).toBeLessThanOrEqual(previousOut);
      previousIn = inGain;
      previousOut = outGain;
    }
  });
});

describe('淡入淡出（dip）曲线', () => {
  it('中间进度附近完全无声', () => {
    expect(dipIn(0)).toBeCloseTo(0, 6);
    expect(dipOut(0)).toBeCloseTo(1, 6);
    expect(dipIn(0.5)).toBeCloseTo(0, 6);
    expect(dipOut(0.5)).toBeCloseTo(0, 6);
    expect(dipIn(1)).toBeCloseTo(1, 6);
    expect(dipOut(1)).toBeCloseTo(0, 6);
  });

  it('增益限制在 [0,1]', () => {
    for (const p of [-0.5, 0, 0.25, 0.5, 1, 1.5]) {
      expect(dipIn(p)).toBeGreaterThanOrEqual(0);
      expect(dipIn(p)).toBeLessThanOrEqual(1);
      expect(dipOut(p)).toBeGreaterThanOrEqual(0);
      expect(dipOut(p)).toBeLessThanOrEqual(1);
    }
  });
});

describe('按类型分发', () => {
  it('none 类型始终为满增益', () => {
    expect(transitionInGain('none', 0.3)).toBe(1);
    expect(transitionOutGain('none', 0.3)).toBe(1);
  });

  it('crossfade 与 dipToBlack 走各自曲线', () => {
    expect(transitionInGain('crossfade', 0.5)).toBeCloseTo(0.70710678, 6);
    expect(transitionInGain('dipToBlack', 0.5)).toBeCloseTo(0, 6);
  });
});
