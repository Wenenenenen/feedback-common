import { describe, expect, it } from 'vitest';
import { decodeWavPcm, encodeWav24, importWav } from '../../src/core/wav';
import { sampleBytes } from '../helpers/samples';

const load = (name: string) => decodeWavPcm(sampleBytes(name));

describe('WAV 解码', () => {
  it('8/16/48kHz 与 16/24 位都能解析，且浮点 = PCM / 2^(位深-1)', () => {
    const cases: Array<[string, number, 16 | 24]> = [
      ['formats/8000-16.wav', 8000, 16],
      ['formats/8000-24.wav', 8000, 24],
      ['formats/16000-16.wav', 16000, 16],
      ['formats/16000-24.wav', 16000, 24],
      ['formats/48000-16.wav', 48000, 16],
      ['formats/48000-24.wav', 48000, 24],
    ];
    for (const [name, rate, bits] of cases) {
      const decoded = load(name);
      expect(decoded.sampleRate).toBe(rate);
      expect(decoded.bitDepth).toBe(bits);
      expect(decoded.numChannels).toBe(1);
      const scale = 1 / Math.pow(2, bits - 1);
      for (let i = 0; i < decoded.numFrames; i += 1) {
        expect(decoded.samples[i]).toBe(decoded.pcm[i] * scale);
      }
      // 24 位文件的首样本已知值（197195 / 8388608）。
      if (bits === 24 && rate === 16000) {
        expect(decoded.pcm[1]).toBe(197195);
      }
    }
  });

  it('16 位样本来自有符号小端整数', () => {
    const decoded = load('tiny-x.wav');
    expect(Array.from(decoded.pcm)).toEqual([0, 8192, -4096, 12288, 0, 0, 2048, -8192]);
    expect(Array.from(decoded.samples, (v) => v * 32768)).toEqual([0, 8192, -4096, 12288, 0, 0, 2048, -8192]);
  });

  it('拒绝不支持的采样率、位深、声道数与浮点编码，并说明原因', () => {
    const base = new Uint8Array(sampleBytes('tiny-x.wav'));
    const mutated = (mutate: (view: DataView) => void): Uint8Array => {
      const copy = new Uint8Array(base.length);
      copy.set(base);
      mutate(new DataView(copy.buffer));
      return copy;
    };
    const rate44100 = mutated((view) => view.setUint32(24, 44100, true));
    expect(() => decodeWavPcm(rate44100)).toThrowError(/44100Hz/);

    const depth32 = mutated((view) => {
      view.setUint16(34, 32, true);
      view.setUint16(32, 4, true);
      view.setUint32(28, 16000 * 4, true);
    });
    expect(() => decodeWavPcm(depth32)).toThrowError(/32 位/);

    const stereo = mutated((view) => {
      view.setUint16(22, 2, true);
      view.setUint16(32, 4, true);
      view.setUint32(28, 16000 * 4, true);
    });
    expect(() => decodeWavPcm(stereo)).toThrowError(/声道数 2/);

    const float = mutated((view) => view.setUint16(20, 3, true));
    expect(() => decodeWavPcm(float)).toThrowError(/tag=3/);
  });

  it('拒绝被截断的 data 块与超长文件', () => {
    const truncated = new Uint8Array(sampleBytes('main-x.wav')).subarray(0, 44 + 48000);
    expect(() => decodeWavPcm(truncated)).toThrowError(/截断|越界/);

    const slow = new Uint8Array(sampleBytes('formats/8000-16.wav'));
    const view = new DataView(slow.buffer);
    view.setUint32(24, 1000, true);
    expect(() => decodeWavPcm(slow)).toThrowError(/1000Hz/);
  });
});

describe('24 位 WAV 编码', () => {
  it('编码后的文件能被自己重新解码，且低 16 位精度保留', () => {
    const values = [0, 1 / 8388608, -1 / 8388608, 0.5, -0.25, 1 - 1 / 8388608];
    const bytes = encodeWav24(16000, values.length, (i) => Math.round(values[i] * 8388608));
    const decoded = decodeWavPcm(bytes);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.bitDepth).toBe(24);
    expect(decoded.numFrames).toBe(values.length);
    expect(Array.from(decoded.pcm)).toEqual([0, 1, -1, 4194304, -2097152, 8388607]);
  });

  it('文件头符合 RIFF/WAVE 24 位单声道约定', () => {
    const bytes = encodeWav24(8000, 4, () => 0);
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(44 + 12);
    expect(view.getUint32(4, true)).toBe(36 + 12);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(8000 * 3);
    expect(view.getUint16(32, true)).toBe(3);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(12);
  });
});

describe('导入摘要', () => {
  it('相同字节得到相同摘要，不同字节不同摘要', async () => {
    const a = await importWav('a.wav', sampleBytes('tiny-x.wav'));
    const b = await importWav('a.wav', sampleBytes('tiny-x.wav'));
    const c = await importWav('c.wav', sampleBytes('tiny-d.wav'));
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(a.digest.length).toBeGreaterThan(16);
  });
});
