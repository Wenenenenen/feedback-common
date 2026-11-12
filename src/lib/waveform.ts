/**
 * 波形峰值提取。
 *
 * 十分钟 48kHz 立体声原始数据约 160MB（float32），不能整段驻留内存。
 * 这里逐块解码、逐块压缩成 min/max 峰值桶（默认 50 桶/秒），
 * 原始音频解析完即释放，最终每条素材只剩几百 KB 的峰值数组。
 */
import { AudioSampleSink } from 'mediabunny';
import type { AudioSample, InputAudioTrack } from 'mediabunny';
import { WAVEFORM_BUCKETS_PER_SECOND } from './thumbnails';

/** 计算音轨的波形峰值（按素材全时长） */
export async function computeWaveform(
  track: InputAudioTrack,
  duration: number,
  onProgress?: (ratio: number) => void,
): Promise<{ min: Float32Array; max: Float32Array }> {
  const totalBuckets = Math.max(1, Math.ceil(duration * WAVEFORM_BUCKETS_PER_SECOND));
  const min = new Float32Array(totalBuckets);
  const max = new Float32Array(totalBuckets);
  const buckets = new Int32Array(totalBuckets).fill(0);

  const sink = new AudioSampleSink(track);
  let lastReported = -1;

  try {
    for await (const sample of sink.samples(0, duration) as AsyncGenerator<AudioSample, void, unknown>) {
      const sampleRate = sample.sampleRate;
      const frames = sample.numberOfFrames;
      if (frames <= 0) {
        sample.close();
        continue;
      }

      // 逐声道直接读 f32，避免中间立体声数组
      for (let ch = 0; ch < sample.numberOfChannels; ch++) {
        const bytes = sample.allocationSize({ planeIndex: ch, format: 'f32-planar' });
        const plane = new Float32Array(bytes / 4);
        sample.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });

        for (let i = 0; i < plane.length; i++) {
          // 采样时刻 = 样本起点 + 帧偏移，按绝对时间归桶
          const time = sample.timestamp + i / sampleRate;
          if (time < 0) {
            continue;
          }
          const bucket = Math.floor(time * WAVEFORM_BUCKETS_PER_SECOND);
          if (bucket < 0 || bucket >= totalBuckets) {
            continue;
          }
          const value = plane[i];
          if (buckets[bucket] === 0) {
            min[bucket] = value;
            max[bucket] = value;
            buckets[bucket] = 1;
          } else {
            if (value < min[bucket]) min[bucket] = value;
            if (value > max[bucket]) max[bucket] = value;
          }
        }
      }

      if (onProgress) {
        const ratio = Math.min(1, (sample.timestamp + frames / sampleRate) / Math.max(duration, 1e-6));
        if (ratio - lastReported >= 0.1) {
          lastReported = ratio;
          onProgress(ratio);
        }
      }

      // 样本用完必须关闭，否则解码器资源不会释放
      sample.close();
    }
  } catch {
    // 波形失败不应阻断剪辑，返回已算出的部分
  }

  onProgress?.(1);
  return { min, max };
}
