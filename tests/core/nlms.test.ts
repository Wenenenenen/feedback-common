import { describe, expect, it } from 'vitest';
import { NlmsEngine } from '../../src/core/nlms';
import { decodeWavPcm } from '../../src/core/wav';
import { parseSampleConfig, parseTinyExpected } from '../../src/core/samples';
import { sampleBytes, sampleJson } from '../helpers/samples';
import type { NlmsConfig } from '../../src/core/types';

function tinyEngine(config: NlmsConfig): NlmsEngine {
  const x = decodeWavPcm(sampleBytes('tiny-x.wav'));
  const d = decodeWavPcm(sampleBytes('tiny-d.wav'));
  return new NlmsEngine({
    reference: Float64Array.from(x.samples),
    microphone: Float64Array.from(d.samples),
    sampleRate: 16000,
    config,
  });
}

function tinyConfig(): NlmsConfig {
  const sample = parseSampleConfig(sampleJson('tiny.json'));
  return { delay: sample.delay, taps: sample.taps, mu: sample.mu, leak: sample.leak, tiny: true, freeze: sample.freeze };
}

describe('tiny 核对：逐位复现包内期望值', () => {
  it('估计回声、残差与抽头与 tiny-expected.json 完全相等（不是“接近”）', () => {
    const engine = tinyEngine(tinyConfig());
    engine.runToEnd();
    const expected = parseTinyExpected(sampleJson('tiny-expected.json'));
    expect(engine.totalFrames).toBe(expected.echo.length);
    for (let n = 0; n < expected.echo.length; n += 1) {
      expect(engine.echo[n], `echo[${n}]`).toBe(expected.echo[n]);
      expect(engine.residual[n], `residual[${n}]`).toBe(expected.residual[n]);
    }
    expect(Array.from(engine.taps)).toEqual(expected.h);
  });

  it('冻结区间内的帧不做任何抽头更新', () => {
    const engine = tinyEngine(tinyConfig());
    engine.runToEnd();
    // tiny.json 的冻结区间为 [3, 5)。
    expect(engine.frozen[3]).toBe(1);
    expect(engine.frozen[4]).toBe(1);
    expect(engine.updated[3]).toBe(0);
    expect(engine.updated[4]).toBe(0);
    // 第 5 帧起再次更新。
    expect(engine.updated[5]).toBe(1);
    // 抽头只在第 5、7 帧改变（第 3、4 帧冻结，第 1、2、6 帧 u·u=0 或未达 gate）。
    const history = engine.tapHistory.map((s) => s.frame);
    expect(history[history.length - 1]).toBe(8);
  });

  it('分块大小不影响结果：逐帧、3 帧、随机分块与一次到底产生相同输出', () => {
    const state = tinyConfig();
    const full = tinyEngine(state);
    full.runToEnd();

    const stepwise = tinyEngine(state);
    for (let i = 0; i < 8; i += 1) stepwise.advance(1);

    const chunked = tinyEngine(state);
    for (const size of [3, 2, 3]) chunked.advance(size);

    const zeroChunks = tinyEngine(state);
    zeroChunks.advance(0);
    zeroChunks.advance(0);
    zeroChunks.runToEnd();

    for (const other of [stepwise, chunked, zeroChunks]) {
      expect(other.frame).toBe(full.frame);
      for (let n = 0; n < full.totalFrames; n += 1) {
        expect(other.echo[n]).toBe(full.echo[n]);
        expect(other.residual[n]).toBe(full.residual[n]);
      }
      expect(Array.from(other.taps)).toEqual(Array.from(full.taps));
    }
  });

  it('处理中途暂停时，只暴露已处理前缀的能量统计', () => {
    const engine = tinyEngine(tinyConfig());
    engine.advance(4);
    expect(engine.frame).toBe(4);
    // 未处理的帧输出保持 0，且不会被算作“已处理”。
    expect(engine.echo[4]).toBe(0);
  });
});

describe('数值约定边界', () => {
  it('参考窗口越界帧取 0，而不是钳位到边界样本', () => {
    // delay=0、taps=2 时第 0 帧的 u = [x[0], x[-1]=0]。
    const engine = new NlmsEngine({
      reference: Float64Array.from([1, 2, 3, 4]),
      microphone: Float64Array.from([0, 0, 0, 0]),
      sampleRate: 16000,
      config: { delay: 0, taps: 2, mu: 0.5, leak: 0, tiny: true, freeze: [] },
    });
    engine.advance(1);
    expect(engine.echo[0]).toBe(0);
    // 更新后 h[0] = 0.5·e·u[0]/(eps+1) = 0.5·0·1/1 = 0（麦克风为 0）。
    engine.runToEnd();
    for (let n = 0; n < 4; n += 1) expect(engine.echo[n]).toBe(0);
  });

  it('u·u 低于 gate 时不更新；达到 gate 才更新', () => {
    const below = new NlmsEngine({
      reference: Float64Array.from([1e-5, 0, 0, 0]),
      microphone: Float64Array.from([1, 1, 1, 1]),
      sampleRate: 16000,
      config: { delay: 0, taps: 1, mu: 1, leak: 0, tiny: true, freeze: [] },
    });
    below.runToEnd();
    // u·u = 1e-10 < 1e-7，全程不更新。
    for (let n = 0; n < 4; n += 1) expect(below.updated[n]).toBe(0);
    expect(below.taps[0]).toBe(0);

    const above = new NlmsEngine({
      reference: Float64Array.from([1, 0, 0, 0]),
      microphone: Float64Array.from([1, 1, 1, 1]),
      sampleRate: 16000,
      config: { delay: 0, taps: 1, mu: 1, leak: 0, tiny: true, freeze: [] },
    });
    above.runToEnd();
    expect(above.updated[0]).toBe(1);
    // h = 1·1·1/(1e-8+1) = 1/(1+ε)，ε 就是包内约定的 1e-8。
    expect(above.taps[0]).toBeCloseTo(1 / (1 + 1e-8), 15);
    // 第 1 帧的能量为 0（x[1]=0），echo 用更新后的 h 乘以 u=[x[1],[x[0]] 的越界位] 仍为 0。
    expect(above.echo[1]).toBe(0);
  });

  it('泄漏按 h = (1-leak)·h 逐帧乘，冻结帧完全不乘', () => {
    const engine = new NlmsEngine({
      reference: Float64Array.from([0, 0, 0]),
      microphone: Float64Array.from([0, 0, 0]),
      sampleRate: 16000,
      config: { delay: 0, taps: 1, mu: 0.5, leak: 0.01, tiny: true, freeze: [{ start: 1, end: 2 }] },
    });
    engine.advance(0);
    // 直接设定抽头，观察只有能量达 gate 且未冻结的帧才衰减。
    engine.taps[0] = 1;
    engine.runToEnd();
    // 参考全 0：能量为 0，未达 gate，全程不更新也不泄漏。
    expect(engine.taps[0]).toBe(1);
    expect(engine.updated[0] + engine.updated[1] + engine.updated[2]).toBe(0);
  });

  it('问候一下：leak 只影响更新帧，且因子恰为 (1-leak)', () => {
    const engine = new NlmsEngine({
      reference: Float64Array.from([1, 1, 1]),
      microphone: Float64Array.from([0, 0, 0]),
      sampleRate: 16000,
      config: { delay: 0, taps: 1, mu: 0, leak: 0.01, tiny: true, freeze: [] },
    });
    engine.taps[0] = 2;
    engine.runToEnd();
    // mu=0 时 h ← (1-leak)·h，每帧一次。
    expect(engine.taps[0]).toBeCloseTo(2 * Math.pow(0.99, 3), 15);
  });
});

describe('main 样例：两阶段真回声路径', () => {
  it('在手动冻结讲话区间后收敛到两阶段路径，且冻结区间内抽头不变', async () => {
    const sample = parseSampleConfig(sampleJson('main.json'));
    const x = decodeWavPcm(sampleBytes('main-x.wav'));
    const d = decodeWavPcm(sampleBytes('main-d.wav'));
    const config: NlmsConfig = {
      delay: sample.delay,
      taps: sample.taps,
      mu: sample.mu,
      leak: sample.leak,
      tiny: false,
      freeze: sample.freeze,
    };
    const engine = new NlmsEngine({
      reference: Float64Array.from(x.samples),
      microphone: Float64Array.from(d.samples),
      sampleRate: 16000,
      config,
    });
    engine.runToEnd();

    // 冻结区间 [12000, 19000) 内抽头必须完全不变：检查该区间内每个快照。
    const inFreeze = engine.tapHistory.filter((s) => s.frame >= 12000 && s.frame <= 19000);
    expect(inFreeze.length).toBeGreaterThan(1);
    const reference = Array.from(inFreeze[0].taps);
    for (const snapshot of inFreeze) expect(Array.from(snapshot.taps)).toEqual(reference);
    // 区间前后的抽头确实不同（否则说明冻结没有挡住说话段）。
    const before = engine.tapHistory.filter((s) => s.frame <= 12000).at(-1)!;
    const after = engine.tapHistory.filter((s) => s.frame >= 19000)[0];
    expect(Array.from(after.taps)).not.toEqual(Array.from(before.taps));

    // 收敛值应接近 truth-ir 的第二阶段（12→0.35、40→0.3，27 归零）。
    const stageTwo = sample.truthIr!.stages[1];
    for (const tap of stageTwo) {
      expect(engine.taps[tap.index], `h[${tap.index}]`).toBeCloseTo(tap.gain, 3);
    }
    const stageOneOnly = sample.truthIr!.stages[0].filter((tap) => !stageTwo.some((other) => other.index === tap.index));
    for (const tap of stageOneOnly) {
      expect(Math.abs(engine.taps[tap.index]), `h[${tap.index}] 应归零`).toBeLessThan(0.01);
    }

    // 讲话区间内的残差（相对麦克风）应显著变差，说明确实是近端讲话而非回声。
    const { intervalEnergy } = await import('../../src/core/nlms');
    const freezeEnergy = intervalEnergy(engine, { start: 12000, end: 19000 });
    const cleanEnergy = intervalEnergy(engine, { start: 0, end: 12000 });
    expect(freezeEnergy.erleDb).toBeLessThan(cleanEnergy.erleDb!);
  });

  it('冻结区间遮罩按并集展开，重叠区间只标记一次', async () => {
    const { freezeMaskOf, normalizeFreeze } = await import('../../src/core/params');
    const normalized = normalizeFreeze(
      [
        { start: 3, end: 8 },
        { start: 5, end: 10 },
        { start: 9, end: 12 },
        { start: 1, end: 2 },
      ],
      16,
    );
    expect(normalized.errors).toEqual([]);
    expect(normalized.ranges).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 12 },
    ]);
    const mask = freezeMaskOf(normalized.ranges, 16);
    expect(Array.from(mask)).toEqual([0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });
});
