/**
 * 导出：WebCodecs 编码 + 流式封装 MP4。
 *
 * 三条硬性约束的对应做法：
 * 1. 内存不爆：直接写入磁盘（File System Access API 或 OPFS），
 *    音频按 0.25 秒块混音后立刻编码，任何时刻内存里只有一个块的数据。
 * 2. 音画同步：视频帧时间戳固定为 n/fps，音频块时间戳固定为 blockStart/48000，
 *    两者都由时间轴绝对位置算出；AAC 编码器的前导延迟由库自动扣除。
 * 3. 字幕烧进画面：每帧先合成视频与字幕，再送编码器，字幕成为画面像素。
 */
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { SAMPLE_RATE, type ClipLayout, type TimelineLayout } from './timeline';
import type { InputAudioTrack } from 'mediabunny';
import { compositeFrame } from './composite';
import { TimelineAudioMixer } from './audio';
import { cueAt, type ProjectedCue } from './subtitles';
import type { ExportSettings } from '../types';

/** 音频块长度（采样），0.25 秒 */
const AUDIO_BLOCK_SAMPLES = SAMPLE_RATE / 4;
/** 音频提前推送量（秒），让封装器能正常交织 */
const AUDIO_LOOKAHEAD_SECONDS = 0.4;

export type ExportPhase = 'preparing' | 'encoding' | 'finalizing' | 'done' | 'canceled' | 'error';

export interface ExportProgress {
  phase: ExportPhase;
  /** 0 → 1 */
  ratio: number;
  /** 已完成帧数 */
  framesDone: number;
  /** 总帧数 */
  totalFrames: number;
}

export interface ExportResult {
  /** 文件名 */
  fileName: string;
  /** 字节数（写到磁盘时可能为 null，因为流式写入不统计） */
  bytes: number | null;
  /** 是否已保存到用户指定的文件 */
  savedToFile: boolean;
}

export interface ExportOptions {
  layout: TimelineLayout;
  settings: ExportSettings;
  /** 取某片段某源内时刻的帧 */
  frameAt: (item: ClipLayout, sourceTime: number) => Promise<CanvasImageSource | null>;
  /** 按素材 id 取音轨 */
  getAudioTrack: (assetId: string) => InputAudioTrack | null;
  cues: ProjectedCue[];
  /** 源素材帧率（设置里选 'source' 时使用） */
  sourceFrameRate: number;
  /** 进度回调 */
  onProgress?: (progress: ExportProgress) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 导出目标：能顺序/定位写入的流 */
interface OutputTargetHandle {
  writable: WritableStream<{ type: 'write'; data: Uint8Array; position: number }>;
  /** 结束并返回结果 */
  finish: () => Promise<{ fileName: string; bytes: number | null; savedToFile: boolean }>;
  abort: () => Promise<void>;
}

const WRITE_CHUNK_TYPE = 'write' as const;

/** 优先使用系统另存为对话框；不可用时退回 OPFS 临时文件 */
export async function createOutputTarget(fileName: string): Promise<OutputTargetHandle> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;

  if (typeof picker === 'function') {
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
    });
    const writable = (await handle.createWritable()) as unknown as WritableStream<{
      type: 'write';
      data: Uint8Array;
      position: number;
    }>;
    return {
      writable,
      finish: async () => ({
        fileName: handle.name,
        bytes: null,
        savedToFile: true,
      }),
      abort: async () => {
        try {
          await (writable as unknown as WritableStreamDefaultWriter).abort?.();
        } catch {
          // 忽略中断异常
        }
      },
    };
  }

  // 回退：写入 OPFS，再以 File 句柄触发下载（下载走磁盘，不占内存）
  const root = await navigator.storage.getDirectory();
  const tempName = `export-${Date.now()}-${fileName}`;
  const fileHandle = await root.getFileHandle(tempName, { create: true });
  const writable = (await fileHandle.createWritable()) as unknown as WritableStream<{
    type: 'write';
    data: Uint8Array;
    position: number;
  }>;
  return {
    writable,
    finish: async () => {
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      // 稍后回收，确保下载已开始
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const bytes = file.size;
      try {
        await root.removeEntry(tempName);
      } catch {
        // 删除失败无碍，OPFS 之后会被浏览器回收
      }
      return { fileName, bytes, savedToFile: false };
    },
    abort: async () => {
      try {
        await (writable as unknown as WritableStreamDefaultWriter).abort?.();
      } catch {
        // 忽略
      }
      try {
        await root.removeEntry(tempName);
      } catch {
        // 忽略
      }
    },
  };
}

/** 确保有可用的 AAC 编码器（浏览器不支持时启用 WASM 实现） */
async function ensureAacEncoder(channels: number, sampleRate: number, bitrate: number): Promise<void> {
  const supported = await canEncodeAudio('aac', { numberOfChannels: channels, sampleRate, quality: new Quality({ bitrate }) });
  if (!supported) {
    registerAacEncoder();
  }
}

/**
 * 执行导出。
 * 调用方需先通过 createOutputTarget 拿到写入目标。
 */
export async function exportTimeline(
  target: OutputTargetHandle,
  options: ExportOptions,
): Promise<ExportResult> {
  const { layout, settings, frameAt, getAudioTrack, cues, onProgress, signal } = options;

  const fps = settings.fps === 'source' ? options.sourceFrameRate || 24 : settings.fps;
  const width = settings.width;
  const height = settings.height;
  const totalSeconds = layout.totalSamples / SAMPLE_RATE;
  const totalFrames = Math.max(1, Math.ceil(totalSeconds * fps));

  const report = (phase: ExportPhase, framesDone: number) => {
    onProgress?.({
      phase,
      ratio: totalFrames > 0 ? Math.min(1, framesDone / totalFrames) : 0,
      framesDone,
      totalFrames,
    });
  };

  report('preparing', 0);

  // 编码能力检查，尽早失败而不是导到一半才报错
  if (!(await canEncodeVideo('avc', { width, height, frameRate: fps, quality: new Quality({ bitrate: settings.videoBitrate }) }))) {
    throw new Error(`当前浏览器无法以 ${width}x${height}@${fps} 编码 H.264，请降低分辨率或帧率。`);
  }
  await ensureAacEncoder(2, SAMPLE_RATE, settings.audioBitrate);

  // 离屏画布用于每帧合成
  const canvas = new OffscreenCanvas(width, height);
  const context2d = canvas.getContext('2d', { alpha: false });
  if (!context2d) {
    throw new Error('无法创建导出用 2D 画布');
  }

  // 混音器独立于预览，从头开始
  const mixer = new TimelineAudioMixer({ getTrack: getAudioTrack, layout });

  // 预分配包数量上界，用于 reserve 模式把 moov 前置（可边播边下）
  const maximumVideoPackets = Math.ceil(totalFrames * 1.34) + 16;
  const maximumAudioPackets = Math.ceil(totalSeconds * 100 * 1.34) + 16;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new StreamTarget(target.writable as never),
  });

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: settings.videoBitrate }),
    keyFrameInterval: 2,
  });
  const audioSource = new AudioSampleSource({
    codec: 'aac',
    quality: new Quality({ bitrate: settings.audioBitrate }),
    transform: { numberOfChannels: 2, sampleRate: SAMPLE_RATE },
  });

  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: maximumVideoPackets });
  output.addAudioTrack(audioSource, { maximumPacketCount: maximumAudioPackets });

  let framesDone = 0;
  let audioWrittenSamples = 0;

  try {
    await output.start();

    const checkAbort = () => {
      if (signal?.aborted) {
        throw new Error('EXPORT_CANCELED');
      }
    };

    // 音频按块推送
    const pushAudioUntil = async (sampleLimit: number) => {
      while (audioWrittenSamples < Math.min(sampleLimit, layout.totalSamples)) {
        checkAbort();
        const blockStart = audioWrittenSamples;
        const blockEnd = Math.min(layout.totalSamples, blockStart + AUDIO_BLOCK_SAMPLES);
        const [left, right] = await mixer.renderRange(blockStart, blockEnd);
        const frames = left.length;
        if (frames > 0) {
          // f32-planar：先左声道整段，再右声道整段
          const data = new Float32Array(frames * 2);
          data.set(left, 0);
          data.set(right, frames);
          const sample = new AudioSample({
            data,
            format: 'f32-planar',
            numberOfChannels: 2,
            sampleRate: SAMPLE_RATE,
            timestamp: blockStart / SAMPLE_RATE,
          });
          await audioSource.add(sample);
          sample.close();
        }
        audioWrittenSamples = blockEnd;
      }
    };

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      checkAbort();
      const time = frameIndex / fps;
      // 画面取该帧中点时刻，避免正好落在边界上取到下一帧
      const sample = Math.min(layout.totalSamples - 1, Math.round((time + 0.5 / fps) * SAMPLE_RATE));

      await compositeFrame(context2d, {
        width,
        height,
        layout,
        sample,
        subtitle: cueAt(cues, time),
        provider: (item, targetSample) => {
          const sourceTime = item.clip.sourceIn + (targetSample - item.startSample) / SAMPLE_RATE;
          return frameAt(item, sourceTime);
        },
      });

      await videoSource.add(time, 1 / fps);

      // 音频保持领先不超过 lookahead，避免封装器里堆积无界样本
      const audioLimit = Math.min(
        layout.totalSamples,
        Math.round((time + AUDIO_LOOKAHEAD_SECONDS) * SAMPLE_RATE),
      );
      await pushAudioUntil(audioLimit);

      framesDone += 1;
      if (frameIndex % 8 === 0) {
        report('encoding', framesDone);
      }
    }

    // 补齐尾部音频
    await pushAudioUntil(layout.totalSamples);

    report('finalizing', framesDone);
    await videoSource.close();
    await audioSource.close();
    await output.finalize();

    const result = await target.finish();
    report('done', totalFrames);
    return result;
  } catch (error) {
    try {
      await output.cancel();
    } catch {
      // 取消失败忽略
    }
    mixer.dispose();
    if (signal?.aborted) {
      await target.abort();
      report('canceled', framesDone);
      throw new Error('EXPORT_CANCELED');
    }
    report('error', framesDone);
    throw error;
  } finally {
    mixer.dispose();
  }
}

/** 用内存目标导出（仅用于自动化测试与小片段自检） */
export async function exportTimelineToBuffer(options: ExportOptions): Promise<ArrayBuffer> {
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  const fps = options.settings.fps === 'source' ? options.sourceFrameRate || 24 : options.settings.fps;
  const width = options.settings.width;
  const height = options.settings.height;
  const totalSeconds = options.layout.totalSamples / SAMPLE_RATE;
  const totalFrames = Math.max(1, Math.ceil(totalSeconds * fps));

  await ensureAacEncoder(2, SAMPLE_RATE, options.settings.audioBitrate);

  const canvas = new OffscreenCanvas(width, height);
  const context2d = canvas.getContext('2d', { alpha: false });
  if (!context2d) {
    throw new Error('无法创建导出用 2D 画布');
  }
  const mixer = new TimelineAudioMixer({ getTrack: options.getAudioTrack, layout: options.layout });
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: options.settings.videoBitrate }),
    keyFrameInterval: 2,
  });
  const audioSource = new AudioSampleSource({
    codec: 'aac',
    quality: new Quality({ bitrate: options.settings.audioBitrate }),
    transform: { numberOfChannels: 2, sampleRate: SAMPLE_RATE },
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  let audioWritten = 0;
  const pushAudio = async (limit: number) => {
    while (audioWritten < Math.min(limit, options.layout.totalSamples)) {
      const blockStart = audioWritten;
      const blockEnd = Math.min(options.layout.totalSamples, blockStart + AUDIO_BLOCK_SAMPLES);
      const [left, right] = await mixer.renderRange(blockStart, blockEnd);
      const frames = left.length;
      if (frames > 0) {
        const data = new Float32Array(frames * 2);
        data.set(left, 0);
        data.set(right, frames);
        const sample = new AudioSample({
          data,
          format: 'f32-planar',
          numberOfChannels: 2,
          sampleRate: SAMPLE_RATE,
          timestamp: blockStart / SAMPLE_RATE,
        });
        await audioSource.add(sample);
        sample.close();
      }
      audioWritten = blockEnd;
    }
  };

  try {
    await output.start();
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const time = frameIndex / fps;
      const sample = Math.min(options.layout.totalSamples - 1, Math.round((time + 0.5 / fps) * SAMPLE_RATE));
      await compositeFrame(context2d, {
        width,
        height,
        layout: options.layout,
        sample,
        subtitle: cueAt(options.cues, time),
        provider: (item, targetSample) =>
          options.frameAt(item, item.clip.sourceIn + (targetSample - item.startSample) / SAMPLE_RATE),
      });
      await videoSource.add(time, 1 / fps);
      await pushAudio(Math.round((time + AUDIO_LOOKAHEAD_SECONDS) * SAMPLE_RATE));
    }
    await pushAudio(options.layout.totalSamples);
    await videoSource.close();
    await audioSource.close();
    await output.finalize();
    const buffer = target.buffer;
    if (!buffer) {
      throw new Error('导出未产生数据');
    }
    return buffer;
  } finally {
    mixer.dispose();
  }
}

/** 生成默认导出文件名 */
export function defaultExportName(extension = 'mp4'): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `clipcut-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${extension}`;
}

/** 供界面使用：当前浏览器是否支持导出所需能力 */
export async function checkExportSupport(): Promise<{ ok: boolean; message: string }> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    return { ok: false, message: '当前浏览器不支持 WebCodecs，请使用较新的 Chrome。' };
  }
  const videoOk = await canEncodeVideo('avc', { width: 1920, height: 1080, frameRate: 30 });
  if (!videoOk) {
    return { ok: false, message: '当前浏览器不支持 H.264 硬件/软件编码。' };
  }
  return { ok: true, message: '导出能力正常' };
}

/** 内部：写入块类型常量（供测试断言协议） */
export const STREAM_CHUNK_TYPE = WRITE_CHUNK_TYPE;
