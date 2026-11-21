/**
 * 音频播放：把原音 / 估计回声 / 残差作为可切换音源，共用同一播放进度。
 *
 * 用 Web Audio 的 AudioBufferSourceNode 逐次播放整段（≤15 秒），
 * 播放位置以 AudioContext.currentTime 推算，避免 requestAnimationFrame 累积漂移。
 */

export type Stem = 'microphone' | 'echo' | 'residual';

export interface StemBuffers {
  sampleRate: number;
  numFrames: number;
  microphone: Float64Array;
  echo: Float64Array;
  residual: Float64Array;
}

export class StemPlayer {
  private context: AudioContext | null = null;
  private buffers: Record<Stem, AudioBuffer> | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private stem: Stem = 'microphone';
  private playing = false;
  private data: StemBuffers | null = null;
  private gainNode: GainNode | null = null;
  private onEnd: (() => void) | null = null;
  /** 由界面写入：标识当前缓冲对应哪一版引擎，避免重建后仍播旧数据。 */
  key = '';

  setOnEnd(handler: (() => void) | null): void {
    this.onEnd = handler;
  }

  get currentStem(): Stem {
    return this.stem;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get hasAudio(): boolean {
    return this.data !== null && this.data.numFrames > 0;
  }

  get sampleRate(): number {
    return this.data?.sampleRate ?? 0;
  }

  get numFrames(): number {
    return this.data?.numFrames ?? 0;
  }

  /** 载入音源；会停止当前播放并丢弃旧缓冲。 */
  load(data: StemBuffers): void {
    this.stop();
    this.data = data;
    this.buffers = null;
    this.offset = 0;
  }

  /** 处理进度推进后刷新残差缓冲（只重建残差，原音与回声不变）。 */
  refreshResidual(data: StemBuffers): void {
    if (!this.data) {
      this.load(data);
      return;
    }
    this.data = data;
    if (this.buffers) {
      this.buffers.residual = this.makeBuffer('residual');
      if (this.playing) this.restartAtCurrentPosition();
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor();
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = 1;
      this.gainNode.connect(this.context.destination);
    }
    return this.context;
  }

  private makeBuffer(stem: Stem): AudioBuffer {
    const context = this.ensureContext();
    const data = this.data!;
    const buffer = context.createBuffer(1, data.numFrames, data.sampleRate);
    const channel = buffer.getChannelData(0);
    channel.set(data[stem]);
    return buffer;
  }

  private ensureBuffers(): Record<Stem, AudioBuffer> {
    if (!this.data || this.data.numFrames <= 0) throw new Error('尚未载入有效音频');
    if (!this.buffers) {
      this.buffers = {
        microphone: this.makeBuffer('microphone'),
        echo: this.makeBuffer('echo'),
        residual: this.makeBuffer('residual'),
      };
    }
    return this.buffers;
  }

  setStem(stem: Stem): void {
    this.stem = stem;
    if (this.playing) this.restartAtCurrentPosition();
  }

  private restartAtCurrentPosition(): void {
    const position = this.positionSeconds();
    this.stopSourceOnly();
    this.startAt(position);
  }

  private stopSourceOnly(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // 已经停止的 source 再 stop 会抛 InvalidStateError，忽略。
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  play(fromFrame?: number): void {
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume();
    const position = fromFrame === undefined ? this.offset : fromFrame / this.data!.sampleRate;
    this.startAt(position);
  }

  private startAt(positionSeconds: number): void {
    if (!this.data || this.data.numFrames <= 0) {
      this.playing = false;
      return;
    }
    this.ensureBuffers();
    const context = this.ensureContext();
    this.stopSourceOnly();
    const duration = this.data.numFrames / this.data.sampleRate;
    const position = Math.max(0, Math.min(duration, positionSeconds));
    if (position >= duration) {
      this.playing = false;
      this.offset = duration;
      this.onEnd?.();
      return;
    }
    const source = context.createBufferSource();
    source.buffer = this.buffers![this.stem];
    source.connect(this.gainNode!);
    source.start(0, position);
    source.onended = () => {
      if (this.source === source) {
        this.playing = false;
        this.offset = duration;
        this.source = null;
        this.onEnd?.();
      }
    };
    this.source = source;
    this.startedAt = context.currentTime;
    this.offset = position;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.positionSeconds();
    this.playing = false;
    this.stopSourceOnly();
  }

  stop(): void {
    this.playing = false;
    this.offset = 0;
    this.stopSourceOnly();
  }

  positionSeconds(): number {
    if (!this.playing || !this.context) return this.offset;
    const duration = this.data ? this.data.numFrames / this.data.sampleRate : 0;
    return Math.min(duration, this.offset + (this.context.currentTime - this.startedAt));
  }

  positionFrame(): number {
    if (!this.data) return 0;
    return Math.round(this.positionSeconds() * this.data.sampleRate);
  }

  seek(frame: number): void {
    const wasPlaying = this.playing;
    this.pause();
    this.offset = this.data ? frame / this.data.sampleRate : 0;
    if (wasPlaying) this.play(frame);
  }

  /** 当前播放位置的帧（供波形游标使用）。 */
  tick(): number {
    return this.positionFrame();
  }
}
