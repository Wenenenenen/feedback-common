/*
 * 播放控制：处理前播放干声，处理后播放完整输出（含尾段）。
 * 处理后音频按需从 Worker 分段取回，避免一次性把 ~64 秒双声道放进主线程。
 * 只有一个 AudioContext 和一个活动音源；新的播放会停止旧的。
 */

const CHUNK_SECONDS = 4;
const LOOKAHEAD_SECONDS = 2;

export class Player {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.sources = null;
    this.activeToken = 0;
    this.onTick = null;
    this.timer = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('浏览器不支持 Web Audio');
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** 播放一段已在内存中的双声道数据。 */
  async playBuffers({ left, right, sampleRate, label, onEnded, onProgress }) {
    const ctx = this.ensureContext();
    this.stop();

    const buffer = ctx.createBuffer(2, Math.max(1, left.length), sampleRate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right || left, 1);

    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = ctx.currentTime + 0.03;
    source.start(startAt);

    this.source = source;
    this.gain = gain;
    const token = ++this.activeToken;

    const tick = () => {
      if (token !== this.activeToken) return;
      const elapsed = ctx.currentTime - startAt;
      const progress = Math.max(0, Math.min(1, elapsed / buffer.duration));
      onProgress?.(progress);
      if (progress >= 1) {
        this.stop();
        onEnded?.();
        return;
      }
      this.timer = setTimeout(tick, 50);
    };
    tick();

    source.onended = () => {
      if (token === this.activeToken) {
        this.stop();
        onEnded?.();
      }
    };
    return { duration: buffer.duration, label };
  }

  /**
   * 流式播放：按需向 Worker 请求片段并排队。
   * @param {object} p
   * @param {number} p.sampleRate
   * @param {number} p.totalFrames
   * @param {(start:number,end:number)=>Promise<{left:Float32Array,right:Float32Array}>} p.fetchSegment
   * @param {number} [p.startFrame]
   */
  async playStreaming({ sampleRate, totalFrames, fetchSegment, startFrame = 0, onEnded, onProgress }) {
    const ctx = this.ensureContext();
    this.stop();

    const token = ++this.activeToken;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    this.gain = gain;

    const chunkFrames = Math.max(1024, Math.round(CHUNK_SECONDS * sampleRate));
    let nextFrame = Math.max(0, Math.min(startFrame, totalFrames));
    let scheduledUntil = ctx.currentTime + 0.06;
    const startedAt = ctx.currentTime + 0.06;
    const sources = new Set();
    this.sources = sources;

    const scheduleChunk = (left, right, frames) => {
      const buffer = ctx.createBuffer(2, Math.max(1, frames), sampleRate);
      buffer.copyToChannel(left, 0);
      buffer.copyToChannel(right, 1, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(scheduledUntil);
      sources.add(src);
      src.onended = () => sources.delete(src);
      scheduledUntil += buffer.duration;
    };

    const pump = async () => {
      while (token === this.activeToken) {
        if (nextFrame >= totalFrames) break;
        const end = Math.min(totalFrames, nextFrame + chunkFrames);
        // 只在队列不足 lookahead 时取新块
        const buffered = scheduledUntil - ctx.currentTime;
        if (buffered > LOOKAHEAD_SECONDS) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        const seg = await fetchSegment(nextFrame, end);
        if (token !== this.activeToken) return;
        scheduleChunk(seg.left, seg.right, seg.left.length);
        nextFrame = end;
      }
    };

    const tick = () => {
      if (token !== this.activeToken) return;
      const elapsed = ctx.currentTime - startedAt;
      const duration = totalFrames / sampleRate;
      const progress = Math.max(0, Math.min(1, elapsed / Math.max(1e-9, duration)));
      onProgress?.(progress);
      if (progress >= 1) {
        this.stop();
        onEnded?.();
        return;
      }
      this.timer = setTimeout(tick, 60);
    };

    pump().catch((err) => {
      if (token === this.activeToken) {
        console.error(err);
        this.stop();
        onEnded?.();
      }
    });
    tick();

    return { duration: totalFrames / sampleRate, sources };
  }

  stop() {
    this.activeToken++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.source) {
      try { this.source.stop(); } catch { /* 已结束 */ }
      this.source.disconnect();
      this.source = null;
    }
    if (this.sources) {
      for (const src of this.sources) {
        try { src.stop(); } catch { /* 已结束 */ }
        src.disconnect();
      }
      this.sources.clear();
      this.sources = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
  }

  isPlaying() {
    return Boolean(this.source || this.gain);
  }
}
