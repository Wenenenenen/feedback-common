/**
 * 素材加载：解析 mp4，抽出轨道信息与句柄。
 *
 * File 对象直接交给 Mediabunny 的 BlobSource 惰性读取，
 * 所以加载时不会把整个文件读进内存，十分钟素材也只占用少量元数据。
 */
import {
  ALL_FORMATS,
  BlobSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import type { AssetInfo } from '../types';

/** 一个已加载素材的运行时句柄 */
export interface AssetHandle {
  info: AssetInfo;
  input: Input;
  file: File;
  videoTrack: InputVideoTrack | null;
  audioTrack: InputAudioTrack | null;
}

let assetCounter = 0;

/**
 * 加载一个 mp4（或其它 Mediabunny 支持的容器）文件。
 * 只读元数据与轨道句柄，不读媒体数据。
 */
export async function loadAsset(file: File): Promise<AssetHandle> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });

  if (!(await input.canRead())) {
    input.dispose();
    throw new Error(`无法识别的文件格式：${file.name}`);
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();

  const format = await input.getFormat();
  // 只接受能解出视频或音频的文件
  if (!videoTrack && !audioTrack) {
    input.dispose();
    throw new Error(`文件里没有可用的视频或音频轨：${file.name}`);
  }

  const duration = await input.computeDuration();

  let width = 0;
  let height = 0;
  let frameRate = 24;
  if (videoTrack) {
    width = await videoTrack.getDisplayWidth();
    height = await videoTrack.getDisplayHeight();
    if (!(await videoTrack.canDecode())) {
      input.dispose();
      throw new Error(`浏览器无法解码该视频编码：${file.name}`);
    }
    const metrics = await videoTrack.computeFrameRateMetrics({ targetPacketCount: 192 });
    const guessed = metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate;
    if (Number.isFinite(guessed) && guessed > 0) {
      frameRate = guessed;
    }
  }

  let sampleRate = 48000;
  let channels = 2;
  if (audioTrack) {
    if (!(await audioTrack.canDecode())) {
      input.dispose();
      throw new Error(`浏览器无法解码该音频编码：${file.name}`);
    }
    sampleRate = await audioTrack.getSampleRate();
    channels = await audioTrack.getNumberOfChannels();
  }

  assetCounter += 1;
  const info: AssetInfo = {
    id: `asset-${Date.now().toString(36)}-${assetCounter}`,
    name: file.name,
    duration,
    width,
    height,
    frameRate,
    hasVideo: Boolean(videoTrack),
    hasAudio: Boolean(audioTrack),
    sampleRate,
    channels,
  };

  // 记录容器格式，便于界面提示
  void format;

  return {
    info,
    input,
    file,
    videoTrack: videoTrack ?? null,
    audioTrack: audioTrack ?? null,
  };
}

/** 释放素材资源 */
export function disposeAsset(handle: AssetHandle): void {
  handle.input.dispose();
}
