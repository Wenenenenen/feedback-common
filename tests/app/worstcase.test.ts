import { describe, expect, it } from 'vitest';
import { NlmsEngine } from '../../src/core/nlms';
import { buildCheckpoint, finalizeCheckpoint, parseCheckpoint, serializeCheckpoint } from '../../src/core/checkpoint';

/** 15 秒 × 48kHz × 256 抽头的最坏规模：检查点可以保存、解析、续算，
 *  且耗时保持在可交互范围内。 */
describe('最坏规模（15s@48kHz，256 抽头）', () => {
  it('720000 帧的检查点可往返并续算，前缀摘要一致', async () => {
    const frames = 48000 * 15;
    const x = new Float64Array(frames);
    const d = new Float64Array(frames);
    // 简单的回声 + 近端噪声
    for (let n = 0; n < frames; n += 1) {
      const v = 0.2 * Math.sin(n * 0.004) + 0.1 * Math.sin(n * 0.017);
      x[n] = v;
      d[n] = 0.5 * (n >= 12 ? x[n - 12] : 0) + (n > frames * 0.6 ? 0.05 * Math.sin(n * 0.3) : 0);
    }
    const config = { delay: 0, taps: 256, mu: 0.2, leak: 1e-4, tiny: false, freeze: [{ start: 300000, end: 360000 }] };
    const engine = new NlmsEngine({ reference: x, microphone: d, sampleRate: 48000, config });
    const t0 = performance.now();
    engine.advance(400000);
    const processMs = performance.now() - t0;
    expect(engine.frame).toBe(400000);

    const meta = { name: 'a.wav', sampleRate: 48000, bitDepth: 16 as const, numFrames: frames, digest: 'sha256-stub' };
    const t1 = performance.now();
    const text = serializeCheckpoint(await finalizeCheckpoint(engine, buildCheckpoint({ engine, referenceMeta: meta, microphoneMeta: { ...meta, name: 'b.wav' } })));
    const serializeMs = performance.now() - t1;
    const sizeMb = text.length / 1024 / 1024;
    expect(sizeMb).toBeLessThan(40);

    const t2 = performance.now();
    const resumed = await parseCheckpoint(text, { referenceDigest: 'sha256-stub', microphoneDigest: 'sha256-stub', totalFrames: frames });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.reasons.join('; '));
    const parseMs = performance.now() - t2;

    const t3 = performance.now();
    const second = new NlmsEngine({ reference: x, microphone: d, sampleRate: 48000, config });
    second.restore({ frame: resumed.frame, taps: resumed.taps, echoPrefix: resumed.echoPrefix, residualPrefix: resumed.residualPrefix, tapHistory: resumed.tapHistory });
    const restoreMs = performance.now() - t3;
    second.runToEnd();
    // 与从头一次跑完的参照引擎对比。
    const reference = new NlmsEngine({ reference: x, microphone: d, sampleRate: 48000, config });
    reference.runToEnd();
    expect(Array.from(second.taps)).toEqual(Array.from(reference.taps));
    // 输出（前缀 + 续算）逐位一致。
    for (let n = 400000; n < frames; n += 1) {
      if (second.echo[n] !== reference.echo[n] || second.residual[n] !== reference.residual[n]) {
        throw new Error(`第 ${n} 帧续算与参照不一致`);
      }
    }
    // 性能底线：单次处理 + 序列化 + 解析 + 恢复都在 12 秒内。
    const total = processMs + serializeMs + parseMs + restoreMs;
    expect(total).toBeLessThan(12000);
    // eslint-disable-next-line no-console
    console.log(`最坏规模：处理 ${processMs.toFixed(0)}ms，序列化 ${serializeMs.toFixed(0)}ms（${sizeMb.toFixed(1)}MB），解析 ${parseMs.toFixed(0)}ms，恢复 ${restoreMs.toFixed(0)}ms`);
  }, 30000);
});
