/**
 * 实时预览播放器。
 *
 * 结构：
 * - 视频：按播放时钟循环合成到 canvas（rAF 驱动），音频暂停时不渲染。
 * - 音频：Web Audio 连续时间线。每次 seek 后重建音频播放链，随后由
 *   AudioContext 自己的时钟推进，与 rAF 画面共用一个“播放起点”，
 *   因此画面和声音都从同一个绝对时间原点出发，不会各自漂移。
 *
 * 音频渲染以 0.25 秒小块提前渲染并调度，避免一次性混完整条时间轴。
 */
import { SAMPLE_RATE, sampleToTime, type TimelineLayout } from './timeline';
import { compositeFrame } from './composite';
import { TimelineAudioMixer } from './audio';
import { cueAt, type ProjectedCue } from './subtitles';

/** 音频调度提前量（秒） */
const SCHEDULE_AHEAD = 0.6;
/** 单次渲染的音频块长度（秒） */
const AUDIO_BLOCK = 0.25;

export interface PreviewEngineOptions {
  canvas: HTMLCanvasElement;
  audioContext: AudioContext;
  mixer: TimelineAudioMixer;
  layout: TimelineLayout;
  /** 取某一时刻画面（源内时间）；用片段 id 定位，避免编辑后索引错位 */
  frameAt: (clipId: string, assetId: string, sourceIn: number, sourceOut: number, sourceTime: number) => Promise<CanvasImageSource | null>;
  /** 当前字幕 */
  getCues: () => ProjectedCue[];
}

/**
 * 预览引擎：管理播放时钟、rAF 画面循环与 Web Audio 音频调度。
 */
export class PreviewEngine {
  private canvas: HTMLCanvasElement;
  private context2d: CanvasRenderingContext2D;
  private audioContext: AudioContext;
  private mixer: TimelineAudioMixer;
  private layout: TimelineLayout;
  private frameAt: PreviewEngineOptions['frameAt'];
  private getCues: () => ProjectedCue[];

  /** 当前时间轴采样点（权威播放位置） */
  private playheadSample = 0;
  /** 播放起点：AudioContext 时间（秒） */
  private audioStartTime = 0;
  /** 播放起点对应的采样点 */
  private audioStartSample = 0;
  /** 已经调度到的时间轴采样点 */
  private scheduledSample = 0;
  private playing = false;
  private rafId: number | null = null;
  private scheduledNodes: AudioBufferSourceNode[] = [];
  private pendingMix: Promise<void> | null = null;
  /** 播放代次：每次重建播放链递增，用于让在途的混音循环自行作废 */
  private playToken = 0;
  /** 播放循环里已经画过的时间（避免同一时刻重复绘制） */
  private lastDrawnTime = -1;
  /** 最近一次请求绘制的采样点，用于丢弃过期的排队帧 */
  private lastRequestedSample = -1;
  /** 绘制队列：保证同一时刻只有一次合成在跑，避免画布并发写入 */
  private drawQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private onTimeUpdate: (time: number) => void;
  private onPlayStateChange: (playing: boolean) => void;

  constructor(options: PreviewEngineOptions) {
    this.canvas = options.canvas;
    const context2d = options.canvas.getContext('2d', { alpha: false });
    if (!context2d) {
      throw new Error('无法创建 2D 画布上下文');
    }
    this.context2d = context2d;
    this.audioContext = options.audioContext;
    this.mixer = options.mixer;
    this.layout = options.layout;
    this.frameAt = options.frameAt;
    this.getCues = options.getCues;
    this.onTimeUpdate = () => undefined;
    this.onPlayStateChange = () => undefined;
  }

  /** 订阅播放时间变化（用于界面跟随） */
  setTimeListener(listener: (time: number) => void): void {
    this.onTimeUpdate = listener;
  }

  /** 订阅播放状态变化 */
  setPlayStateListener(listener: (playing: boolean) => void): void {
    this.onPlayStateChange = listener;
  }

  getCanvasSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  setCanvasSize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.lastDrawnTime = -1;
      void this.drawAt(this.playheadSample);
    }
  }

  /**
   * 更新排版（剪辑后调用）。
   * 播放中编辑时间轴会让「音频起点 → 采样」的换算前提变化，
   * 因此这里把播放原点重置到当前真实位置，避免音画错位。
   * 剪辑组分（播放音频）与画面时钟共用同一个起点，重置后两者仍保持一致。
   */
  setLayout(layout: TimelineLayout): void {
    this.layout = layout;
    this.mixer.setLayout(layout);
    if (this.playing) {
      // 以音频时钟算出当前位置，再以该位置为新起点重建播放链
      const elapsed = this.audioContext.currentTime - this.audioStartTime;
      const current = this.audioStartSample + Math.round(elapsed * SAMPLE_RATE);
      const clamped = Math.max(0, Math.min(layout.totalSamples, current));
      this.beginPlaybackAt(clamped);
    } else {
      this.scheduledSample = Math.min(this.scheduledSample, this.playheadSample);
      this.playheadSample = Math.min(this.playheadSample, layout.totalSamples);
    }
  }

  /** 当前播放位置（秒） */
  getTime(): number {
    return sampleToTime(this.playheadSample);
  }

  /** 总时长（秒） */
  getDuration(): number {
    return sampleToTime(this.layout.totalSamples);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** 播放/暂停切换 */
  toggle(): void {
    if (this.playing) {
      this.pause();
    } else {
      void this.play();
    }
  }

  /** 跳到指定秒并重绘 */
  async seek(time: number): Promise<void> {
    const targetSample = Math.max(0, Math.min(this.layout.totalSamples, Math.round(time * SAMPLE_RATE)));
    const wasPlaying = this.playing;
    this.stopAudioNodes();
    this.playheadSample = targetSample;
    this.lastDrawnTime = -1;
    await this.drawAt(targetSample);
    this.onTimeUpdate(sampleToTime(targetSample));
    if (wasPlaying) {
      this.beginPlaybackAt(targetSample);
    }
  }

  /** 开始播放 */
  async play(): Promise<void> {
    if (this.playing) {
      return;
    }
    if (this.playheadSample >= this.layout.totalSamples) {
      this.playheadSample = 0;
    }
    await this.audioContext.resume();
    this.beginPlaybackAt(this.playheadSample);
  }

  /** 暂停 */
  pause(): void {
    if (!this.playing) {
      return;
    }
    // 以音频时钟为准，把播放位置定格在当前真实时刻
    const elapsed = this.audioContext.currentTime - this.audioStartTime;
    const current = this.audioStartSample + Math.round(elapsed * SAMPLE_RATE);
    this.playheadSample = Math.max(0, Math.min(this.layout.totalSamples, current));
    this.stopAudioNodes();
    this.onPlayStateChange(false);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    void this.drawAt(this.playheadSample);
    this.onTimeUpdate(sampleToTime(this.playheadSample));
  }

  private beginPlaybackAt(sample: number): void {
    this.playing = true;
    this.onPlayStateChange(true);
    this.playToken += 1;
    this.audioStartTime = this.audioContext.currentTime;
    this.audioStartSample = sample;
    this.scheduledSample = sample;
    this.playheadSample = sample;
    this.stopAudioNodes();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    void this.scheduleAudio();
    this.lastDrawnTime = -1;
    this.rafLoop();
  }

  private stopAudioNodes(): void {
    for (const node of this.scheduledNodes) {
      try {
        node.stop();
      } catch {
        // 已停止的节点再 stop 会抛异常，忽略
      }
      node.disconnect();
    }
    this.scheduledNodes = [];
  }

  /**
   * 把已混好的时间轴音频块，按“与视频共用的播放起点”调度到 Web Audio 时间线上。
   * 每块的起始时刻由绝对采样下标算出，不依赖前一块是否已播放。
   */
  private async scheduleAudio(): Promise<void> {
    if (this.pendingMix) {
      return;
    }
    const token = this.playToken;
    this.pendingMix = (async () => {
      try {
        const blockSamples = AUDIO_BLOCK * SAMPLE_RATE;
        const totalSamples = this.layout.totalSamples;
        while (this.playing && !this.disposed && this.playToken === token) {
          const nowElapsedSamples = Math.round((this.audioContext.currentTime - this.audioStartTime) * SAMPLE_RATE);
          const aheadTarget = this.audioStartSample + nowElapsedSamples + Math.round(SCHEDULE_AHEAD * SAMPLE_RATE);
          if (this.scheduledSample >= aheadTarget || this.scheduledSample >= totalSamples) {
            break;
          }
          const blockStart = this.scheduledSample;
          const blockEnd = Math.min(totalSamples, blockStart + blockSamples);
          const [left, right] = await this.mixer.renderRange(blockStart, blockEnd);
          // 渲染期间播放链可能被重建（剪辑、跳转、暂停），此时这批数据已作废
          if (!this.playing || this.disposed || this.playToken !== token) {
            break;
          }

          // 该块在 AudioContext 时间线上的绝对起点
          const when = this.audioStartTime + (blockStart - this.audioStartSample) / SAMPLE_RATE;
          this.scheduleBlock(left, right, when);
          this.scheduledSample = blockEnd;
        }
      } finally {
        this.pendingMix = null;
      }
      // 若还有缺口，安排下一轮（同样受代次约束，避免旧循环续命）
      if (this.playing && this.playToken === token && this.scheduledSample < this.layout.totalSamples) {
        window.setTimeout(() => {
          if (this.playToken === token) {
            void this.scheduleAudio();
          }
        }, 40);
      }
    })();
  }

  private scheduleBlock(left: Float32Array, right: Float32Array, when: number): void {
    const frames = left.length;
    if (frames === 0) {
      return;
    }
    const buffer = this.audioContext.createBuffer(2, frames, SAMPLE_RATE);
    buffer.getChannelData(0).set(left);
    buffer.getChannelData(1).set(right);
    const node = this.audioContext.createBufferSource();
    node.buffer = buffer;
    node.connect(this.audioContext.destination);
    // when 可能已过去（渲染延迟），用 max(now, when) 保底，但保持与画面同一原点
    node.start(Math.max(this.audioContext.currentTime + 0.01, when));
    this.scheduledNodes.push(node);
    node.onended = () => {
      const index = this.scheduledNodes.indexOf(node);
      if (index !== -1) {
        this.scheduledNodes.splice(index, 1);
      }
    };
  }

  /** 播放循环：画面跟随音频时钟 */
  private rafLoop = (): void => {
    if (!this.playing || this.disposed) {
      return;
    }
    const elapsed = this.audioContext.currentTime - this.audioStartTime;
    const currentSample = this.audioStartSample + Math.round(elapsed * SAMPLE_RATE);

    if (currentSample >= this.layout.totalSamples) {
      this.playheadSample = this.layout.totalSamples;
      this.playing = false;
      this.onPlayStateChange(false);
      this.stopAudioNodes();
      void this.drawAt(this.layout.totalSamples);
      this.onTimeUpdate(sampleToTime(this.layout.totalSamples));
      return;
    }

    this.playheadSample = currentSample;
    // 画面按显示刷新率推进；同一时间点不重复绘制
    if (currentSample !== this.lastDrawnTime) {
      this.lastDrawnTime = currentSample;
      void this.drawAt(currentSample);
    }
    this.onTimeUpdate(sampleToTime(currentSample));
    // 音频调度补位
    void this.scheduleAudio();
    this.rafId = requestAnimationFrame(this.rafLoop);
  };

  /** 绘制指定采样点的画面（串行化，避免并发合成把画布画乱） */
  async drawAt(sample: number): Promise<void> {
    const target = sample;
    this.lastRequestedSample = target;
    this.drawQueue = this.drawQueue.then(async () => {
      // 排队期间已跳到更晚的位置时，丢弃过期请求，只画最新一帧
      if (target < this.lastRequestedSample || this.disposed) {
        return;
      }
      const subtitleText = cueAt(this.getCues(), sampleToTime(target));
      await compositeFrame(this.context2d, {
        width: this.canvas.width,
        height: this.canvas.height,
        layout: this.layout,
        sample: target,
        subtitle: subtitleText,
        provider: (item, targetSample) => {
          const sourceTime = item.clip.sourceIn + (targetSample - item.startSample) / SAMPLE_RATE;
          return this.frameAt(
            item.clip.id,
            item.clip.assetId,
            item.clip.sourceIn,
            item.clip.sourceOut,
            sourceTime,
          );
        },
      });
    });
    return this.drawQueue;
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.stopAudioNodes();
  }
}
