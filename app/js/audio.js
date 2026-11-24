// audio.js — Web Audio 播放引擎: 候选分段试听 + 交付整轨回放
import { SAMPLE_RATE } from './wav-codec.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // take -> AudioBuffer
    this.deliveryBuffer = null;
    this.source = null;
    this.mode = null; // 'segment' | 'delivery'
    this.startCtxTime = 0;
    this.startOffset = 0;
    this.duration = 0;
    this.loop = false;
    this.onEnd = null;
    this.onPlayState = null;
  }

  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setTakes(takeAudio) {
    this.stop();
    this.buffers.clear();
    for (const [take, wav] of takeAudio) {
      const buf = this.ensureCtx().createBuffer(1, wav.frames, SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      const s = wav.samples;
      for (let i = 0; i < s.length; i++) ch[i] = s[i] / 32768;
      this.buffers.set(take, buf);
    }
  }

  setDelivery(samples) {
    this.stop();
    const buf = this.ensureCtx().createBuffer(1, samples.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    this.deliveryBuffer = buf;
  }

  _start(buffer, offset, duration, loop, loopStart, loopEnd) {
    const ctx = this.ensureCtx();
    this.stop();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    this.loop = loop;
    if (loop) {
      src.loop = true;
      src.loopStart = loopStart;
      src.loopEnd = loopEnd;
    }
    src.onended = () => {
      if (this.source === src) {
        this.source = null;
        this.mode = null;
        this.onEnd?.();
        this.onPlayState?.(false);
      }
    };
    const t = ctx.currentTime;
    src.start(t, offset, duration);
    this.source = src;
    this.startCtxTime = t;
    this.startOffset = offset;
    this.duration = duration;
    this.onPlayState?.(true);
  }

  /** 试听某条源轨的一个区间(帧) */
  playSegment(take, src, len, loop = false) {
    const buf = this.buffers.get(take);
    if (!buf) throw new Error(`源轨 t${take} 未加载`);
    const off = src / SAMPLE_RATE;
    const dur = len / SAMPLE_RATE;
    this.mode = 'segment';
    this._start(buf, off, dur, loop, off, off + dur);
  }

  playDelivery(loop = false) {
    if (!this.deliveryBuffer) throw new Error('交付轨尚未渲染');
    this.mode = 'delivery';
    this._start(this.deliveryBuffer, 0, this.deliveryBuffer.duration, loop, 0, this.deliveryBuffer.duration);
  }

  stop() {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try { s.onended = null; s.stop(); } catch { /* 已停止 */ }
      this.mode = null;
      this.onPlayState?.(false);
    }
  }

  get playing() {
    return this.source !== null;
  }

  /** 当前播放位置(秒) */
  position() {
    if (!this.source || !this.ctx) return this.startOffset;
    const pos = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
    if (this.loop) {
      const span = this.duration;
      return this.mode === 'segment'
        ? this.startOffset + ((pos - this.startOffset) % span)
        : pos % span;
    }
    return Math.min(pos, this.startOffset + this.duration);
  }
}
