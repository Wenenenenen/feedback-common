/**
 * 时间轴音频混音器（流式）。
 *
 * 同步策略（为什么不越剪越飘）：
 * 1. 每个输出采样点都由「时间轴绝对帧号」直接映射到「素材源内帧号」，
 *    从不累加已经播放过的时间，因此剪切、转场、拖动顺序都不会累积误差。
 * 2. 输出统一为 48kHz 立体声；素材若是 44.1kHz 等其它采样率，用绝对帧号做线性插值重采样。
 * 3. 以固定小块（默认 0.25s）流式产出，边混边编码，内存不随素材时长增长。
 */
import { AudioSampleSink, type AudioSample, type InputAudioTrack } from 'mediabunny';
import { SAMPLE_RATE, type ClipLayout, type TimelineLayout } from './timeline';
import { transitionInGain, transitionOutGain } from './envelope';

/** 把 AudioSample 拆成 f32 平面数组 */
function toPlanar(sample: AudioSample): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let ch = 0; ch < sample.numberOfChannels; ch++) {
    const bytes = sample.allocationSize({ planeIndex: ch, format: 'f32-planar' });
    const target = new Float32Array(bytes / 4);
    sample.copyTo(target, { planeIndex: ch, format: 'f32-planar' });
    planes.push(target);
  }
  return planes;
}

/** 任意声道数 → 立体声（单声道复制；5.1 的中央声道按 -3dB 混入左右） */
function toStereo(planes: Float32Array[], frames: number): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  if (planes.length === 1) {
    left.set(planes[0].subarray(0, frames));
    right.set(planes[0].subarray(0, frames));
    return [left, right];
  }

  left.set(planes[0].subarray(0, frames));
  right.set(planes[1].subarray(0, frames));

  if (planes.length >= 3) {
    const center = planes[2];
    const coef = 0.70710678;
    for (let i = 0; i < frames; i++) {
      const value = center[i] * coef;
      left[i] += value;
      right[i] += value;
    }
  }
  return [left, right];
}

/**
 * 单个片段的顺序音频游标。
 * 内部缓冲以「片段内源帧号」为绝对坐标，读取时用绝对帧号定位与插值。
 */
class ClipAudioCursor {
  private iterator: AsyncGenerator<AudioSample, void, unknown> | null = null;
  private sink: AudioSampleSink | null = null;
  private sourceRate = 0;
  private readonly track: InputAudioTrack;
  private readonly sourceIn: number;
  private readonly sourceOut: number;

  /** 缓冲区首帧的绝对帧号（相对片段起点，源采样率） */
  private baseFrame = 0;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  /** 缓冲区有效帧数（从 baseFrame 起） */
  private bufFrames = 0;
  private eof = false;

  constructor(track: InputAudioTrack, sourceIn: number, sourceOut: number) {
    this.track = track;
    this.sourceIn = sourceIn;
    this.sourceOut = sourceOut;
  }

  /** 打开解码流（幂等） */
  private async open(): Promise<void> {
    if (this.iterator) {
      return;
    }
    if (!this.sink) {
      this.sink = new AudioSampleSink(this.track);
      this.sourceRate = await this.track.getSampleRate();
      if (!Number.isFinite(this.sourceRate) || this.sourceRate <= 0) {
        this.sourceRate = SAMPLE_RATE;
      }
    }
    this.startFrom(this.baseFrame);
  }

  /** 从片段内指定的源帧位置开始解码 */
  private startFrom(localFrame: number): void {
    if (!this.sink) {
      return;
    }
    void this.iterator?.return();
    this.baseFrame = Math.max(0, localFrame);
    this.bufFrames = 0;
    this.eof = false;

    // 解码器从最近的帧边界开始，让起点略微提前，保证插值有前一帧可用
    const seekFrame = Math.max(0, this.baseFrame - 2048);
    const seekTime = Math.min(this.sourceOut, this.sourceIn + seekFrame / this.sourceRate);
    this.iterator = this.sink.samples(seekTime, this.sourceOut) as AsyncGenerator<
      AudioSample,
      void,
      unknown
    >;
    // 注意：baseFrame 已经前移，但缓冲起点须对应 seekFrame，这里用「预填」交由 append 校正
    this.baseFrame = seekFrame;
  }

  /** 确保缓冲区能容纳 endFrame 之前的帧 */
  private ensureCapacity(endFrame: number): void {
    const needed = endFrame - this.baseFrame;
    if (needed <= this.bufL.length) {
      return;
    }
    // 指数扩容，避免频繁拷贝
    let capacity = Math.max(4096, this.bufL.length * 2);
    while (capacity < needed) {
      capacity *= 2;
    }
    const grownL = new Float32Array(capacity);
    const grownR = new Float32Array(capacity);
    grownL.set(this.bufL.subarray(0, this.bufFrames), 0);
    grownR.set(this.bufR.subarray(0, this.bufFrames), 0);
    this.bufL = grownL;
    this.bufR = grownR;
  }

  /** 追加一个解码样本 */
  private append(sample: AudioSample): void {
    const frames = sample.numberOfFrames;
    if (frames <= 0) {
      return;
    }
    const planes = toPlanar(sample);
    const [left, right] = toStereo(planes, frames);

    // 该样本在片段内的起始源帧（按时间戳绝对换算）
    const startFrame = Math.round((sample.timestamp - this.sourceIn) * this.sourceRate);
    const endFrame = startFrame + frames;

    if (endFrame <= this.baseFrame) {
      // 完全早于缓冲起点（解码预滚），丢弃
      return;
    }
    this.ensureCapacity(endFrame);

    const offset = startFrame - this.baseFrame;
    if (offset >= 0) {
      this.bufL.set(left, offset);
      this.bufR.set(right, offset);
    } else {
      const skip = -offset;
      const copyFrames = Math.min(frames - skip, this.bufL.length);
      if (copyFrames > 0) {
        this.bufL.set(left.subarray(skip, skip + copyFrames), 0);
        this.bufR.set(right.subarray(skip, skip + copyFrames), 0);
      }
    }
    this.bufFrames = Math.max(this.bufFrames, endFrame - this.baseFrame);
  }

  private async pull(): Promise<boolean> {
    await this.open();
    if (this.eof || !this.iterator) {
      return false;
    }
    const result = await this.iterator.next();
    if (result.done) {
      this.eof = true;
      return false;
    }
    // 数据已拷入缓冲，样本必须显式关闭以释放解码器资源
    this.append(result.value);
    result.value.close();
    return true;
  }

  /** 丢弃已消费的旧帧（保留少量预滚帧供插值） */
  private trimBefore(frame: number): void {
    const drop = frame - this.baseFrame;
    if (drop <= 0 || this.bufFrames <= 0) {
      return;
    }
    if (drop >= this.bufFrames) {
      this.baseFrame = frame;
      this.bufFrames = 0;
      return;
    }
    this.bufL.copyWithin(0, drop, this.bufFrames);
    this.bufR.copyWithin(0, drop, this.bufFrames);
    this.bufFrames -= drop;
    this.baseFrame = frame;
  }

  /**
   * 读取片段内 [localStart, localEnd) 的 48kHz 立体声数据（相对片段起点，单位 48k 帧）。
   * 采样位置由绝对帧号决定，线性插值完成重采样。
   */
  async read(localStart: number, localEnd: number): Promise<[Float32Array, Float32Array]> {
    const count = Math.max(0, localEnd - localStart);
    const outL = new Float32Array(count);
    const outR = new Float32Array(count);
    if (count === 0) {
      return [outL, outR];
    }

    await this.open();
    const ratio = this.sourceRate / SAMPLE_RATE;

    // 回溯读取：重建解码流（AAC 每包都是关键帧，从中段重启成本很低）
    const needStartSource = Math.floor(localStart * ratio);
    if (needStartSource < this.baseFrame) {
      this.startFrom(needStartSource);
    }

    const needEndSource = Math.ceil(localEnd * ratio) + 2;
    while (!this.eof && this.baseFrame + this.bufFrames < needEndSource) {
      const more = await this.pull();
      if (!more) {
        break;
      }
    }

    const frameAt = (buffer: Float32Array, index: number): number | null => {
      const local = index - this.baseFrame;
      if (local >= 0 && local < this.bufFrames) {
        return buffer[local];
      }
      return null;
    };

    for (let i = 0; i < count; i++) {
      const position = (localStart + i) * ratio;
      const lower = Math.floor(position);
      const upper = lower + 1;
      const fraction = position - lower;

      // 越界时用边界帧延展，避免静音爆点
      const aL = frameAt(this.bufL, lower);
      const bL = frameAt(this.bufL, upper);
      const aR = frameAt(this.bufR, lower);
      const bR = frameAt(this.bufR, upper);

      if (aL !== null) {
        outL[i] = bL !== null ? aL + fraction * (bL - aL) : aL;
      }
      if (aR !== null) {
        outR[i] = bR !== null ? aR + fraction * (bR - aR) : aR;
      }
    }

    // 只保留下一块插值可能用到的一帧
    this.trimBefore(Math.max(0, needStartSource - 2));
    return [outL, outR];
  }

  /** 当前片段已解码覆盖的最大源帧（用于判断是否可以安全裁剪缓冲） */
  get decodedFrames(): number {
    return this.baseFrame + this.bufFrames;
  }

  dispose(): void {
    void this.iterator?.return();
    this.iterator = null;
    this.sink = null;
    this.bufL = new Float32Array(0);
    this.bufR = new Float32Array(0);
    this.bufFrames = 0;
  }
}

/** 混音器构造参数 */
export interface AudioMixerOptions {
  /** 按素材 id 取音频轨 */
  getTrack: (assetId: string) => InputAudioTrack | null;
  /** 时间轴排布 */
  layout: TimelineLayout;
}

/**
 * 时间轴音频混音器：按需渲染任意采样区间的 48kHz 立体声数据。
 */
export class TimelineAudioMixer {
  private readonly cursors = new Map<string, ClipAudioCursor>();
  private readonly getTrack: (assetId: string) => InputAudioTrack | null;
  private layout: TimelineLayout;

  constructor(options: AudioMixerOptions) {
    this.getTrack = options.getTrack;
    this.layout = options.layout;
  }

  /** 排版变化后同步更新（保留游标，避免重复解码） */
  setLayout(layout: TimelineLayout): void {
    this.layout = layout;
  }

  getLayout(): TimelineLayout {
    return this.layout;
  }

  private cursorFor(item: ClipLayout): ClipAudioCursor | null {
    const existing = this.cursors.get(item.clip.id);
    if (existing) {
      return existing;
    }
    const track = this.getTrack(item.clip.assetId);
    if (!track) {
      return null;
    }
    const cursor = new ClipAudioCursor(track, item.clip.sourceIn, item.clip.sourceOut);
    this.cursors.set(item.clip.id, cursor);
    return cursor;
  }

  /** 某时间轴采样点上某片段的瞬时增益（含段内淡入淡出与转场） */
  private gainAt(item: ClipLayout, sample: number): number {
    const clip = item.clip;
    if (clip.muted) {
      return 0;
    }
    let gain = 1;
    const local = sample - item.startSample;

    const fadeInSamples = Math.round(clip.fadeIn * SAMPLE_RATE);
    if (fadeInSamples > 0 && local < fadeInSamples) {
      gain *= Math.max(0, local / fadeInSamples);
    }

    const fadeOutSamples = Math.round(clip.fadeOut * SAMPLE_RATE);
    if (fadeOutSamples > 0 && local > item.durSamples - fadeOutSamples) {
      gain *= Math.max(0, (item.durSamples - local) / fadeOutSamples);
    }

    // 出场转场
    if (item.transitionSamples > 0) {
      const overlapStart = item.startSample + item.durSamples - item.transitionSamples;
      if (sample >= overlapStart) {
        const progress = (sample - overlapStart) / item.transitionSamples;
        gain *= transitionOutGain(clip.transitionOut.type, progress);
      }
    }

    // 入场转场（由上一段决定）
    const prev = this.layout.clips[item.index - 1];
    if (prev && prev.transitionSamples > 0) {
      const overlapEnd = item.startSample + prev.transitionSamples;
      if (sample < overlapEnd) {
        const progress = (sample - item.startSample) / prev.transitionSamples;
        gain *= transitionInGain(prev.clip.transitionOut.type, progress);
      }
    }

    return gain;
  }

  /**
   * 渲染时间轴 [startSample, endSample) 的立体声数据。
   * 返回长度等于区间长度的两个声道数组；内存与区间长度线性相关。
   */
  async renderRange(startSample: number, endSample: number): Promise<[Float32Array, Float32Array]> {
    const count = Math.max(0, endSample - startSample);
    const outL = new Float32Array(count);
    const outR = new Float32Array(count);
    if (count === 0) {
      return [outL, outR];
    }

    for (const item of this.layout.clips) {
      const itemStart = item.startSample;
      const itemEnd = item.startSample + item.durSamples;
      if (itemEnd <= startSample || itemStart >= endSample) {
        continue;
      }

      const localStart = Math.max(0, startSample - itemStart);
      const localEnd = Math.min(item.durSamples, endSample - itemStart);

      const cursor = this.cursorFor(item);
      if (!cursor) {
        continue;
      }
      const [left, right] = await cursor.read(localStart, localEnd);

      const writeOffset = itemStart + localStart - startSample;
      const length = localEnd - localStart;
      for (let i = 0; i < length; i++) {
        const sample = itemStart + localStart + i;
        const gain = this.gainAt(item, sample);
        outL[writeOffset + i] += left[i] * gain;
        outR[writeOffset + i] += right[i] * gain;
      }
    }

    // 叠加后防溢出（语音素材转场重叠时可能超过 1）
    for (let i = 0; i < count; i++) {
      if (outL[i] > 1) outL[i] = 1;
      else if (outL[i] < -1) outL[i] = -1;
      if (outR[i] > 1) outR[i] = 1;
      else if (outR[i] < -1) outR[i] = -1;
    }

    return [outL, outR];
  }

  /** 丢弃已不在时间轴上的片段游标 */
  prune(): void {
    const activeIds = new Set(this.layout.clips.map((item) => item.clip.id));
    for (const [id, cursor] of this.cursors) {
      if (!activeIds.has(id)) {
        cursor.dispose();
        this.cursors.delete(id);
      }
    }
  }

  dispose(): void {
    for (const cursor of this.cursors.values()) {
      cursor.dispose();
    }
    this.cursors.clear();
  }
}
