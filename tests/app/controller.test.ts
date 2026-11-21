import { describe, expect, it } from 'vitest';
import { Controller } from '../../src/app/controller';
import { decodeWavPcm } from '../../src/core/wav';
import { buildResidualWav, buildResidualFloat64, clipStatsOf } from '../../src/core/export';
import { NlmsEngine } from '../../src/core/nlms';
import { sampleBytes } from '../helpers/samples';

function fileOf(name: string): File {
  const bytes = sampleBytes(name);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new File([copy], name, { type: 'audio/wav' });
}

async function controllerWithTiny(): Promise<Controller> {
  const controller = new Controller();
  await controller.loadFiles(fileOf('tiny-x.wav'), fileOf('tiny-d.wav'));
  controller.setParams({ delay: 1, taps: 2, mu: 0.25, leak: 0.001, tiny: true });
  controller.setFreeze([{ start: 3, end: 5 }]);
  return controller;
}

describe('Controller 端到端状态机', () => {
  it('导入两份 WAV 后按参数组建引擎，参数变更清零重算', async () => {
    const controller = await controllerWithTiny();
    expect(controller.engine).not.toBeNull();
    expect(controller.engine!.frame).toBe(0);
    controller.runToEnd();
    expect(controller.engine!.frame).toBe(8);
    expect(controller.snapshot().processedFrames).toBe(8);

    // 改步长：结果清零。
    expect(controller.setParams({ mu: 0.3 })).toBe(true);
    expect(controller.engine!.frame).toBe(0);
    // 改非法参数：保持原状并在提示中说明。
    expect(controller.setParams({ delay: 99999 })).toBe(false);
  });

  it('检查点文本可往返，并拒绝参数不一致的续算', async () => {
    const controller = await controllerWithTiny();
    controller.runToEnd();
    const text = await controller.exportCheckpointText();
    expect(text).not.toBeNull();
    expect(JSON.parse(text!).frame).toBe(8);

    // 相同参数：可以续算（从头开始等价于再跑一遍）。
    const fresh = await controllerWithTiny();
    expect(await fresh.resumeFromCheckpointText(text!)).toBe(true);
    expect((await fresh.exportCheckpointText())! === text!).toBe(false); // createdAt 不同

    // 改参数后拒绝。
    fresh.setParams({ mu: 0.4 });
    expect(await fresh.resumeFromCheckpointText(text!)).toBe(false);
  });

  it('导出 24 位 WAV 与浮点残差的字节符合约定，削波与限幅一致', async () => {
    const controller = await controllerWithTiny();
    controller.runToEnd();
    const wav = controller.exportResidualWav();
    expect(wav).not.toBeNull();
    const decoded = decodeWavPcm(wav!.bytes);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.bitDepth).toBe(24);
    expect(decoded.numFrames).toBe(8);

    const f64 = controller.exportResidualFloat64();
    expect(f64!.bytes.length).toBe(8 * 8);
    const view = new DataView(f64!.bytes.buffer);
    const engine = controller.engine!;
    for (let i = 0; i < 8; i += 1) {
      expect(view.getFloat64(i * 8, true)).toBe(engine.residual[i]);
      // 写入 WAV 的整数 = 限幅后对称四舍五入。
      expect(decoded.pcm[i]).toBe(Math.round(Math.max(-1, Math.min(1 - 2 ** -23, engine.residual[i])) * 8388608));
    }
    expect(clipStatsOf(engine.residual, 8).clipped).toBe(0);
  });

  it('浮点残差保留越界值，而 WAV 已限幅（削波计数来自限幅前）', () => {
    const engine = new NlmsEngine({
      reference: Float64Array.from([1, 1]),
      microphone: Float64Array.from([2, -2]),
      sampleRate: 16000,
      config: { delay: 0, taps: 1, mu: 0, leak: 0, tiny: true, freeze: [] },
    });
    engine.runToEnd();
    const { bytes, stats } = buildResidualWav(engine);
    expect(stats.clipped).toBe(2);
    const decoded = decodeWavPcm(bytes);
    expect(decoded.pcm[0]).toBe(8388607);
    expect(decoded.pcm[1]).toBe(-8388608);
    const raw = buildResidualFloat64(engine);
    const view = new DataView(raw.buffer);
    expect(view.getFloat64(0, true)).toBe(2);
    expect(view.getFloat64(8, true)).toBe(-2);
  });
});
