import { describe, expect, it } from 'vitest';
import { NlmsEngine } from '../../src/core/nlms';
import { decodeWavPcm } from '../../src/core/wav';
import { parseSampleConfig, parseTinyExpected, parseSampleConfig as parseCfg } from '../../src/core/samples';
import {
  buildCheckpoint,
  compareCheckpointConfig,
  digestSha256,
  finalizeCheckpoint,
  parseCheckpoint,
  serializeCheckpoint,
  sha256Hex,
  tapsHash,
} from '../../src/core/checkpoint';
import { chunkInvariance, tinyCheck } from '../../src/core/verify';
import { clipStatsOf, quantizeResidual } from '../../src/core/export';
import { sampleBytes, sampleJson } from '../helpers/samples';
import type { NlmsConfig } from '../../src/core/types';

function makeEngine(name: 'tiny' | 'main'): { engine: NlmsEngine; config: NlmsConfig } {
  const cfg = parseSampleConfig(sampleJson(`${name}.json`));
  const config: NlmsConfig = {
    delay: cfg.delay,
    taps: cfg.taps,
    mu: cfg.mu,
    leak: cfg.leak,
    tiny: cfg.taps < 32,
    freeze: cfg.freeze,
  };
  const x = decodeWavPcm(sampleBytes(`${name}-x.wav`));
  const d = decodeWavPcm(sampleBytes(`${name}-d.wav`));
  return {
    engine: new NlmsEngine({
      reference: Float64Array.from(x.samples),
      microphone: Float64Array.from(d.samples),
      sampleRate: x.sampleRate,
      config,
    }),
    config,
  };
}

const metaOf = (bytesName: string) => {
  const decoded = decodeWavPcm(sampleBytes(bytesName));
  return {
    name: bytesName,
    sampleRate: decoded.sampleRate,
    bitDepth: decoded.bitDepth,
    numFrames: decoded.numFrames,
    digest: `sha256-${sha256Hex(sampleBytes(bytesName))}`,
  };
};

describe('纯 JS SHA-256', () => {
  it('与 WebCrypto 对相同输入得到相同摘要', async () => {
    const bytes = sampleBytes('tiny-x.wav');
    const native = await digestSha256(bytes);
    expect(native).toBe(sha256Hex(bytes));
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('检查点往返', () => {
  it('暂停后重新导入同一批文件，从检查点续算的结果与一次到底一致', async () => {
    const full = makeEngine('main');
    full.engine.runToEnd();

    const paused = makeEngine('main');
    paused.engine.advance(9000);
    const partial = buildCheckpoint({
      engine: paused.engine,
      referenceMeta: metaOf('main-x.wav'),
      microphoneMeta: metaOf('main-d.wav'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const checkpoint = await finalizeCheckpoint(paused.engine, partial);
    const text = serializeCheckpoint(checkpoint);

    const resumed = makeEngine('main');
    const parsed = await parseCheckpoint(text, {
      referenceDigest: metaOf('main-x.wav').digest,
      microphoneDigest: metaOf('main-d.wav').digest,
      totalFrames: resumed.engine.totalFrames,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reasons.join('; '));
    expect(compareCheckpointConfig(parsed.config, resumed.config)).toEqual([]);
    resumed.engine.restore({
      frame: parsed.frame,
      taps: parsed.taps,
      echoPrefix: parsed.echoPrefix,
      residualPrefix: parsed.residualPrefix,
      tapHistory: parsed.tapHistory,
    });
    expect(resumed.engine.frame).toBe(9000);
    // 续算前的输出与一次到底的前缀逐位相同。
    for (let n = 0; n < 9000; n += 1) {
      expect(resumed.engine.echo[n], `echo[${n}]`).toBe(full.engine.echo[n]);
      expect(resumed.engine.residual[n], `residual[${n}]`).toBe(full.engine.residual[n]);
    }
    resumed.engine.runToEnd();
    for (let n = 9000; n < full.engine.totalFrames; n += 1) {
      expect(resumed.engine.echo[n], `续算 echo[${n}]`).toBe(full.engine.echo[n]);
      expect(resumed.engine.residual[n], `续算 residual[${n}]`).toBe(full.engine.residual[n]);
    }
    expect(tapsHash(resumed.engine.taps)).toBe(tapsHash(full.engine.taps));
  });

  it('分块大小不影响结果（含 1、7、100、整段）', () => {
    const sample = makeEngine('tiny');
    const result = chunkInvariance(
      sample.engine.reference,
      sample.engine.microphone,
      sample.engine.sampleRate,
      sample.config,
      [1, 3, 7, 100, 0],
    );
    expect(result.passed).toBe(true);
    expect(result.maxEchoDifference).toBe(0);
    expect(result.maxResidualDifference).toBe(0);
    expect(result.maxTapDifference).toBe(0);
    expect(result.tapSums.every((t) => t.frames === 8)).toBe(true);
  });

  it.each([
    ['参考文件不同', 'main-x.wav', 'tiny-d.wav', 'ref'],
    ['麦克风文件不同', 'tiny-x.wav', 'main-d.wav', 'mic'],
  ])('拒绝%s：输入摘要不符', async (_label, refName, micName) => {
    const paused = makeEngine('main');
    paused.engine.advance(100);
    const checkpoint = await finalizeCheckpoint(
      paused.engine,
      buildCheckpoint({
        engine: paused.engine,
        referenceMeta: metaOf('main-x.wav'),
        microphoneMeta: metaOf('main-d.wav'),
      }),
    );
    const parsed = await parseCheckpoint(serializeCheckpoint(checkpoint), {
      referenceDigest: metaOf(refName).digest,
      microphoneDigest: metaOf(micName).digest,
      totalFrames: paused.engine.totalFrames,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons.join('\n')).toMatch(/内容摘要不符/);
  });

  it('参数不同时拒绝续算，并列出具体差异', async () => {
    const paused = makeEngine('main');
    paused.engine.advance(100);
    const parsed = await parseCheckpoint(
      serializeCheckpoint(
        await finalizeCheckpoint(
          paused.engine,
          buildCheckpoint({
            engine: paused.engine,
            referenceMeta: metaOf('main-x.wav'),
            microphoneMeta: metaOf('main-d.wav'),
          }),
        ),
      ),
      {
        referenceDigest: metaOf('main-x.wav').digest,
        microphoneDigest: metaOf('main-d.wav').digest,
        totalFrames: paused.engine.totalFrames,
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('检查点应可解析');
    const changed: NlmsConfig = { ...parsed.config, mu: 0.2, freeze: [{ start: 12000, end: 19000 }] };
    const diffs = compareCheckpointConfig(parsed.config, changed);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.join('\n')).toMatch(/步长 μ/);
  });

  it('拒绝损坏的前缀输出、缺失字段与非本工具的文件', async () => {
    const paused = makeEngine('main');
    paused.engine.advance(50);
    const good = await finalizeCheckpoint(
      paused.engine,
      buildCheckpoint({
        engine: paused.engine,
        referenceMeta: metaOf('main-x.wav'),
        microphoneMeta: metaOf('main-d.wav'),
      }),
    );
    const current = {
      referenceDigest: metaOf('main-x.wav').digest,
      microphoneDigest: metaOf('main-d.wav').digest,
      totalFrames: paused.engine.totalFrames,
    };
    const corrupted = { ...good, prefixDigest: `sha256-${'0'.repeat(64)}` };
    const result = await parseCheckpoint(serializeCheckpoint(corrupted), current);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join('\n')).toMatch(/摘要不符/);

    const missing = { ...good, input: good.inputs } as unknown as Record<string, unknown>;
    delete missing.inputs;
    delete missing.taps;
    const missingResult = await parseCheckpoint(JSON.stringify(missing), current);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.reasons.join('\n')).toMatch(/inputs|taps/);

    const foreign = await parseCheckpoint(JSON.stringify({ hello: 'world' }), current);
    expect(foreign.ok).toBe(false);
  });

  it('tiny 核对失败时明确报告（错误参数）', () => {
    const engine = makeEngine('tiny');
    const expected = parseTinyExpected(sampleJson('tiny-expected.json'));
    const wrongDelay = new NlmsEngine({
      reference: engine.engine.reference,
      microphone: engine.engine.microphone,
      sampleRate: 16000,
      config: { ...engine.config, delay: 0 },
    });
    wrongDelay.runToEnd();
    const check = tinyCheck(wrongDelay, expected);
    expect(check.passed).toBe(false);
    expect(check.exact).toBe(false);
    expect(check.maxEchoError).toBeGreaterThan(0);
  });

  it('正确参数下 tiny 核对逐位通过', () => {
    const engine = makeEngine('tiny');
    engine.engine.runToEnd();
    const check = tinyCheck(engine.engine, parseTinyExpected(sampleJson('tiny-expected.json')));
    expect(check.passed).toBe(true);
    expect(check.exact).toBe(true);
    expect(check.maxEchoError).toBe(0);
    expect(check.maxResidualError).toBe(0);
    expect(check.maxTapError).toBe(0);
  });
});

describe('导出量化约定', () => {
  it('削波只统计限幅前越界帧', () => {
    const values = Float64Array.from([0, 0.5, 1, -1, -1.0001, 1.0002, 1 - Math.pow(2, -24), 1 - Math.pow(2, -23)]);
    const stats = clipStatsOf(values, values.length);
    // 低于 -1：-1.0001 一帧；高于 1-2^-23：1、1.0002、1-2^-24 三帧
    // （注意 1 本身也高于上限 1-2^-23，会被限幅）。
    expect(stats.belowMin).toBe(1);
    expect(stats.aboveMax).toBe(3);
    expect(stats.clipped).toBe(4);
    expect(stats.peak).toBeCloseTo(1.0002, 12);
  });

  it('限幅到 [-1, 1-2^-23] 后按对称四舍五入转 24 位', () => {
    expect(quantizeResidual(-1.5)).toBe(-8388608);
    expect(quantizeResidual(2)).toBe(8388607);
    // 0.5 LSB 恰好向外取整。
    expect(quantizeResidual((0.5 + 0.5) / 8388608)).toBe(1);
    expect(quantizeResidual(-(0.5 + 0.5) / 8388608)).toBe(-1);
    expect(quantizeResidual(0)).toBe(0);
    expect(Object.is(quantizeResidual(-0), 0)).toBe(true);
  });
});

describe('样例配置解析', () => {
  it('tiny.json 被识别为 tiny 核对模式', () => {
    const cfg = parseCfg(sampleJson('tiny.json'));
    expect(cfg.tiny).toBe(true);
    expect(cfg.freeze).toEqual([{ start: 3, end: 5 }]);
  });

  it('main.json 携带两阶段 truth-ir 与冻结区间', () => {
    const cfg = parseCfg(sampleJson('main.json'));
    expect(cfg.tiny).toBe(false);
    expect(cfg.freeze).toEqual([{ start: 12000, end: 19000 }]);
    expect(cfg.truthIr?.stages.length).toBe(2);
    expect(cfg.truthIr?.stages[0]).toEqual([
      { index: 12, gain: 0.6 },
      { index: 27, gain: -0.2 },
    ]);
  });
});
