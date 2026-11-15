/*
 * 试听播放器：把旋转后的一阶声场按 conventions.json 的监听矩阵解码成立体声，
 * 用 Web Audio 播放。解码只用于监听，不参与导出，也不改变任何样点电平。
 *
 * 监听矩阵（monitor_rows_wyzx）作用在 AmbiX 规范序 [W, Y, Z, X] 上：
 *   L = r0 · [W, Y, Z, X]
 *   R = r1 · [W, Y, Z, X]
 * 两行都含 W 与 X 项，Y 项反号，Z 项为 0。矩阵来自样例包的 conventions.json，
 * 页面载入时读取并校验；不可用时退回内置值。
 */

import { SQRT2 } from './ambisonic.js';

/** 与 samples/ambisonic-cases.zip 内 conventions.json 的 monitor_rows_wyzx 一致。 */
export const DEFAULT_MONITOR_ROWS = [
  [0.5, 0.25, 0, 0.4330127018922193],
  [0.5, -0.25, 0, 0.4330127018922193],
];

/**
 * 严格校验监听矩阵：必须为 2×4 的有限数值。
 * 样例包是外部数据，只接受数字，任何异常形状都退回内置矩阵。
 */
export function sanitizeMonitorRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) return null;
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const copy = [];
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      copy.push(v);
    }
    out.push(copy);
  }
  return out;
}

/**
 * 把规范序 [W,Y,Z,X] 的四声道旋转结果解码成立体声。
 * 输出电平即监听矩阵的原始结果，不额外归一化。
 * @param {{W:Float32Array,Y:Float32Array,Z:Float32Array,X:Float32Array}} planes
 * @param {number[][]} monitorRows
 * @param {number} start
 * @param {number} count
 * @returns {{left:Float32Array,right:Float32Array}}
 */
export function decodeMonitor(planes, monitorRows, start, count) {
  const [r0, r1] = monitorRows;
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  const { W, Y, Z, X } = planes;
  for (let i = 0; i < count; i++) {
    const f = start + i;
    const w = W[f];
    const y = Y[f];
    const z = Z[f];
    const x = X[f];
    left[i] = r0[0] * w + r0[1] * y + r0[2] * z + r0[3] * x;
    right[i] = r1[0] * w + r1[1] * y + r1[2] * z + r1[3] * x;
  }
  return { left, right };
}

/** 监听矩阵解码后的峰值（用于提示，不用于导出判定）。 */
export function monitorPeak(planes, monitorRows) {
  const { W, Y, Z, X } = planes;
  const [r0, r1] = monitorRows;
  let peak = 0;
  for (let f = 0; f < W.length; f++) {
    const w = W[f];
    const y = Y[f];
    const z = Z[f];
    const x = X[f];
    const l = Math.abs(r0[0] * w + r0[1] * y + r0[2] * z + r0[3] * x);
    const r = Math.abs(r1[0] * w + r1[1] * y + r1[2] * z + r1[3] * x);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

export class MonitorPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.startCtxTime = 0;
    this.startOffset = 0; // 秒
    this.sampleRate = 48000;
    this.frames = 0;
    this.volume = 0.9;
    this._onState = null;
    this._stopTimer = null;
    this._endHandler = null;
  }

  onStateChange(fn) {
    this._onState = fn;
  }

  _notify() {
    if (this._onState) this._onState(this);
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('浏览器不支持 Web Audio');
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  /**
   * 安装解码后的立体声缓冲。正在播放时保持播放位置。
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @param {number} sampleRate
   */
  setBuffer(left, right, sampleRate) {
    const wasPlaying = this.playing;
    const at = this.currentFrame();
    this.stopSource();
    const ctx = this.ensureContext();
    const frames = Math.min(left.length, right.length);
    const buffer = ctx.createBuffer(2, frames, sampleRate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    this.buffer = buffer;
    this.sampleRate = sampleRate;
    this.frames = frames;
    const resumeAt = Math.min(at, Math.max(0, frames - 1));
    this.startOffset = resumeAt / sampleRate;
    this.playing = false;
    if (wasPlaying) this.play(resumeAt);
    this._notify();
  }

  clear() {
    this.stopSource();
    this.buffer = null;
    this.frames = 0;
    this.playing = false;
    this.startOffset = 0;
    this._notify();
  }

  get ready() {
    return !!this.buffer;
  }

  currentFrame() {
    if (!this.ready) return 0;
    if (!this.playing) return Math.round(this.startOffset * this.sampleRate);
    const t = this.ctx.currentTime - this.startCtxTime + this.startOffset;
    return Math.max(0, Math.min(this.frames, Math.round(t * this.sampleRate)));
  }

  currentSeconds() {
    return this.currentFrame() / (this.sampleRate || 1);
  }

  play(fromFrame = null) {
    if (!this.ready) return false;
    const ctx = this.ensureContext();
    const offsetFrames = fromFrame == null ? this.currentFrame() : fromFrame;
    const clamped = Math.max(0, Math.min(this.frames - 1, Math.round(offsetFrames)));
    this.stopSource();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source !== src) return; // 被主动停止或替换
      this.playing = false;
      this.source = null;
      this.startOffset = this.frames / this.sampleRate;
      this._notify();
    };
    this.source = src;
    this.startOffset = clamped / this.sampleRate;
    this.startCtxTime = ctx.currentTime;
    src.start(0, this.startOffset);
    this.playing = true;
    this._notify();
    return true;
  }

  pause() {
    if (!this.playing) return;
    const frame = this.currentFrame();
    this.stopSource();
    this.playing = false;
    this.startOffset = Math.min(frame, this.frames) / this.sampleRate;
    this._notify();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(frame) {
    if (!this.ready) return;
    const clamped = Math.max(0, Math.min(this.frames - 1, Math.round(frame)));
    if (this.playing) {
      this.play(clamped);
    } else {
      this.startOffset = clamped / this.sampleRate;
      this._notify();
    }
  }

  stopSource() {
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
    if (this.source) {
      const src = this.source;
      this.source = null;
      try {
        src.onended = null;
        src.stop();
      } catch {
        // 已经结束的 source 再 stop 会抛错，忽略
      }
      try {
        src.disconnect();
      } catch {
        // 忽略
      }
    }
  }

  /** 停止并回到起点。 */
  stop() {
    this.stopSource();
    this.playing = false;
    this.startOffset = 0;
    this._notify();
  }

  dispose() {
    this.stopSource();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // 忽略
      }
      this.ctx = null;
    }
  }
}

/** 立体声监听结果是否超出 [-1,1)（仅提示，不阻止导出）。 */
export function monitorOverflow(left, right) {
  let count = 0;
  let first = -1;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i]) >= 1 || Math.abs(right[i]) >= 1) {
      if (first < 0) first = i;
      count++;
    }
  }
  return { count, first };
}

export { SQRT2 };
