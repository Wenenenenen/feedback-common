/**
 * 波形视图：参考 x / 麦克风 d / 估计回声 y / 残差 e 四条轨道，
 * 叠加冻结区间阴影、拖拽选择、播放游标与逐块能量带（d 与 e 的均方）。
 */

import type { BlockEnergy } from './energy';

export interface WaveData {
  sampleRate: number;
  totalFrames: number;
  processedFrames: number;
  reference: Float64Array;
  microphone: Float64Array;
  echo: Float64Array;
  residual: Float64Array;
  freeze: Array<{ start: number; end: number }>;
  analysis: Array<{ start: number; end: number }>;

}

export interface WaveSelection {
  start: number;
  end: number;
}

const LANES = [
  { key: 'reference', label: '参考 x', color: '#5fd4d6' },
  { key: 'microphone', label: '麦克风 d', color: '#e6ecf4' },
  { key: 'echo', label: '估计回声 y', color: '#f3b455' },
  { key: 'residual', label: '残差 e', color: '#7bd88f' },
] as const;

const PAD_TOP = 22;
const LANE_HEIGHT = 54;
const LANE_GAP = 8;
const ENERGY_HEIGHT = 46;
const PAD_BOTTOM = 26;
const LABEL_WIDTH = 74;

export class WaveformView {
  readonly canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private data: WaveData | null = null;
  private energy: BlockEnergy | null = null;
  private playhead = 0;
  private dragStart: number | null = null;
  private dragCurrent: number | null = null;
  private hoverFrame: number | null = null;
  private width = 1100;
  private readonly height: number;
  private observer: ResizeObserver | null = null;

  onSeek: ((frame: number) => void) | null = null;
  onSelection: ((selection: WaveSelection) => void) | null = null;
  onFreezeToggle: ((selection: WaveSelection) => void) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wave-canvas';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = 1100;
    this.height = PAD_TOP + LANES.length * (LANE_HEIGHT + LANE_GAP) + ENERGY_HEIGHT + PAD_BOTTOM;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '参考、麦克风、估计回声与残差波形');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('无法创建 2D 画布');
    this.context = context;
    this.bind();
  }

  /** 跟随容器宽度（画布像素比固定为 1×dpr，draw 时按 CSS 像素坐标）。 */
  observeContainer(container: HTMLElement): void {
    const apply = () => {
      const style = window.getComputedStyle(container);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const available = Math.max(560, Math.floor(container.clientWidth - padding - 2));
      if (available === this.width) return;
      this.width = available;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(apply);
      this.observer.observe(container);
    }
  }

  private bind(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.data) return;
      const frame = this.frameAt(event);
      if (frame === null) return;
      this.dragStart = frame;
      this.dragCurrent = frame;
      this.canvas.setPointerCapture(event.pointerId);
      this.render();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.data) return;
      const frame = this.frameAt(event);
      this.hoverFrame = frame;
      if (this.dragStart !== null && frame !== null) {
        this.dragCurrent = frame;
        this.render();
      } else {
        this.render();
      }
    });
    this.canvas.addEventListener('pointerup', (event) => {
      if (!this.data || this.dragStart === null) return;
      const frame = this.frameAt(event) ?? this.dragStart;
      const start = Math.min(this.dragStart, frame);
      const end = Math.max(this.dragStart, frame);
      this.dragStart = null;
      this.dragCurrent = null;
      if (end - start >= 1) {
        this.onSelection?.({ start, end });
      } else {
        this.onSeek?.(start);
      }
      this.render();
    });
    this.canvas.addEventListener('pointercancel', () => {
      this.dragStart = null;
      this.dragCurrent = null;
      this.render();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverFrame = null;
      this.render();
    });
    this.canvas.addEventListener('dblclick', (event) => {
      if (!this.data) return;
      // 双击已有区间：切换冻结/解冻。
      const frame = this.frameAt({ clientX: event.clientX } as PointerEvent);
      if (frame === null) return;
      const hit = this.data.freeze.find((range) => frame >= range.start && frame < range.end);
      if (hit) this.onFreezeToggle?.({ start: hit.start, end: hit.end });
    });
  }

  private frameAt(event: PointerEvent): number | null {
    if (!this.data) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - LABEL_WIDTH;
    const plot = this.width - LABEL_WIDTH - 8;
    if (x < 0 || x > plot) return null;
    const ratio = Math.max(0, Math.min(1, x / plot));
    return Math.round(ratio * this.data.totalFrames);
  }

  setData(data: WaveData): void {
    this.data = data;
    this.render();
  }

  /** 由外部按“块”重算能量（避免每次重绘都扫描全部样本）。 */
  setEnergy(energy: BlockEnergy): void {
    this.energy = energy;
    this.render();
  }

  setPlayhead(frame: number): void {
    if (this.playhead === frame) return;
    this.playhead = frame;
    this.render();
  }

  private render(): void {
    const ctx = this.context;
    const data = this.data;
    ctx.clearRect(0, 0, this.width, this.height);
    const plotLeft = LABEL_WIDTH;
    const plotWidth = this.width - LABEL_WIDTH - 8;

    if (!data || data.totalFrames === 0) {
      ctx.fillStyle = '#66758a';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('导入参考与麦克风 WAV 后在此显示波形', plotLeft, 34);
      return;
    }

    const duration = data.totalFrames / data.sampleRate;
    // 时间刻度
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#66758a';
    const targetTicks = Math.max(2, Math.floor(plotWidth / 90));
    for (let i = 0; i <= targetTicks; i += 1) {
      const ratio = i / targetTicks;
      const x = plotLeft + ratio * plotWidth;
      const seconds = ratio * duration;
      const frame = Math.round(ratio * data.totalFrames);
      // 极短片段（< 50ms）用帧号标尺，避免所有刻度都显示成 0.00s。
      const label = duration < 0.05 ? `${frame}帧` : `${seconds.toFixed(seconds < 1 ? 2 : 1)}s`;
      ctx.strokeStyle = 'rgba(110,168,247,0.16)';
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP - 6);
      ctx.lineTo(x, this.height - PAD_BOTTOM + 4);
      ctx.stroke();
      ctx.fillStyle = '#66758a';
      ctx.fillText(label, Math.min(x - 10, plotLeft + plotWidth - 26), 12);
    }

    // 冻结与分析区间底色
    for (const range of data.freeze) {
      const x0 = plotLeft + (range.start / data.totalFrames) * plotWidth;
      const x1 = plotLeft + (range.end / data.totalFrames) * plotWidth;
      ctx.fillStyle = 'rgba(239,111,111,0.13)';
      ctx.fillRect(x0, PAD_TOP - 8, Math.max(1, x1 - x0), this.lanesBottom() - PAD_TOP + 8);
      ctx.strokeStyle = 'rgba(239,111,111,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, PAD_TOP - 8);
      ctx.lineTo(x0 + 0.5, this.lanesBottom());
      ctx.moveTo(x1 - 0.5, PAD_TOP - 8);
      ctx.lineTo(x1 - 0.5, this.lanesBottom());
      ctx.stroke();

    }
    for (const range of data.analysis) {
      const x0 = plotLeft + (range.start / data.totalFrames) * plotWidth;
      const x1 = plotLeft + (range.end / data.totalFrames) * plotWidth;
      ctx.fillStyle = 'rgba(110,168,247,0.08)';
      ctx.fillRect(x0, PAD_TOP - 8, Math.max(1, x1 - x0), this.lanesBottom() - PAD_TOP + 8);
    }

    // 各轨道
    const laneScale = this.laneScale(data);
    for (let index = 0; index < LANES.length; index += 1) {
      const lane = LANES[index];
      const top = PAD_TOP + index * (LANE_HEIGHT + LANE_GAP);
      const mid = top + LANE_HEIGHT / 2;
      ctx.fillStyle = '#0b111a';
      ctx.fillRect(plotLeft, top, plotWidth, LANE_HEIGHT);
      ctx.strokeStyle = '#1a2431';
      ctx.strokeRect(plotLeft + 0.5, top + 0.5, plotWidth - 1, LANE_HEIGHT - 1);
      ctx.strokeStyle = 'rgba(102,117,138,0.28)';
      ctx.beginPath();
      ctx.moveTo(plotLeft, mid + 0.5);
      ctx.lineTo(plotLeft + plotWidth, mid + 0.5);
      ctx.stroke();
      ctx.fillStyle = lane.color;
      ctx.fillRect(plotLeft - 8, mid - 1.5, 4, 3);

      const label = lane.label;
      ctx.fillStyle = '#95a3b6';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(label, 8, mid + 4);

      const values = data[lane.key];
      const envelope = buildEnvelope(values, data.totalFrames, plotWidth, laneScale[0], laneScale[1]);
      ctx.strokeStyle = lane.color;
      ctx.fillStyle = lane.color;
      ctx.lineWidth = 1;
      for (let x = 0; x < envelope.length; x += 1) {
        const height = envelope[x];
        if (height < 0.5) continue;
        const px = plotLeft + x;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(px, mid - height);
        ctx.lineTo(px, mid + height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // 未处理段用暗色遮罩（残差与回声完全为 0 的部分不可见，需要明确边界）。
      if (index >= 2 && data.processedFrames < data.totalFrames) {
        const px = plotLeft + (data.processedFrames / data.totalFrames) * plotWidth;
        ctx.fillStyle = 'rgba(8,11,16,0.55)';
        ctx.fillRect(px, top + 1, plotLeft + plotWidth - px, LANE_HEIGHT - 2);
      }
    }

    // 能量带
    const energyTop = PAD_TOP + LANES.length * (LANE_HEIGHT + LANE_GAP);
    ctx.fillStyle = '#0b111a';
    ctx.fillRect(plotLeft, energyTop, plotWidth, ENERGY_HEIGHT);
    ctx.strokeStyle = '#1a2431';
    ctx.strokeRect(plotLeft + 0.5, energyTop + 0.5, plotWidth - 1, ENERGY_HEIGHT - 1);
    ctx.fillStyle = '#95a3b6';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('能量 dB', 8, energyTop + ENERGY_HEIGHT / 2 + 4);
    const energy = this.energy;
    if (energy) drawEnergy(ctx, energy, plotLeft, energyTop, plotWidth, ENERGY_HEIGHT);

    // 冻结区间的文字标记：在各轨道绘制完成后再画，避免被轨道底色盖住。
    ctx.font = '10px system-ui, sans-serif';
    for (const range of data.freeze) {
      const x0 = plotLeft + (range.start / data.totalFrames) * plotWidth;
      const x1 = plotLeft + (range.end / data.totalFrames) * plotWidth;
      if (x1 - x0 < 40) continue;
      const text = '冻结';
      const badgeWidth = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(40,18,18,0.9)';
      ctx.fillRect(x0 + 2, PAD_TOP + 2, badgeWidth, 14);
      ctx.strokeStyle = 'rgba(239,111,111,0.6)';
      ctx.strokeRect(x0 + 2.5, PAD_TOP + 2.5, badgeWidth - 1, 13);
      ctx.fillStyle = '#f0a0a0';
      ctx.fillText(text, x0 + 6, PAD_TOP + 12);
    }

    // 拖拽选择框
    if (this.dragStart !== null && this.dragCurrent !== null) {
      const start = Math.min(this.dragStart, this.dragCurrent);
      const end = Math.max(this.dragStart, this.dragCurrent);
      const x0 = plotLeft + (start / data.totalFrames) * plotWidth;
      const x1 = plotLeft + (end / data.totalFrames) * plotWidth;
      ctx.fillStyle = 'rgba(94,212,214,0.18)';
      ctx.fillRect(x0, PAD_TOP - 8, Math.max(1, x1 - x0), this.lanesBottom() - PAD_TOP + 8);
      ctx.fillStyle = '#5fd4d6';
      ctx.font = '11px ui-monospace, monospace';
      const text = `[${start}, ${end})  ${((end - start) / data.sampleRate).toFixed(3)}s`;
      ctx.fillText(text, Math.min(x0, plotLeft + plotWidth - 150), this.height - 8);
    }

    // 播放游标
    if (this.playhead > 0) {
      const x = plotLeft + (this.playhead / data.totalFrames) * plotWidth;
      ctx.strokeStyle = '#f3b455';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP - 8);
      ctx.lineTo(x, this.lanesBottom());
      ctx.stroke();
      ctx.fillStyle = '#f3b455';
      ctx.beginPath();
      ctx.moveTo(x - 4, PAD_TOP - 8);
      ctx.lineTo(x + 4, PAD_TOP - 8);
      ctx.lineTo(x, PAD_TOP - 2);
      ctx.closePath();
      ctx.fill();
    }

    // 悬停读数
    if (this.hoverFrame !== null) {
      ctx.fillStyle = 'rgba(19,26,36,0.92)';
      const boxWidth = 168;
      const x = Math.min(plotLeft + plotWidth - boxWidth, Math.max(plotLeft, plotLeft + (this.hoverFrame / data.totalFrames) * plotWidth + 6));
      ctx.fillRect(x, PAD_TOP - 4, boxWidth, 18);
      ctx.strokeStyle = '#2a3646';
      ctx.strokeRect(x + 0.5, PAD_TOP - 3.5, boxWidth - 1, 17);
      ctx.fillStyle = '#95a3b6';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`帧 ${this.hoverFrame} · d ${fmtSample(data.microphone[this.hoverFrame] ?? 0)} · e ${fmtSample(data.residual[this.hoverFrame] ?? 0)}`, x + 6, PAD_TOP + 9);
    }
  }

  private lanesBottom(): number {
    return PAD_TOP + LANES.length * (LANE_HEIGHT + LANE_GAP) - LANE_GAP;
  }

  private laneScale(data: WaveData): [number, number] {
    let peak = 0;
    const stride = Math.max(1, Math.floor(data.totalFrames / 4096));
    for (let n = 0; n < data.totalFrames; n += stride) {
      const d = Math.abs(data.microphone[n]);
      if (d > peak) peak = d;
      const e = Math.abs(data.residual[n]);
      if (e > peak) peak = e;
      const x = Math.abs(data.reference[n]);
      if (x > peak) peak = x;
    }
    // 所有轨道共用一个纵向尺度，便于直接比较幅度。
    const scale = peak > 0 ? (LANE_HEIGHT / 2 - 2) / peak : 0;
    return [scale, peak];
  }
}

function fmtSample(value: number): string {
  if (value === 0) return '0';
  return value.toFixed(5);
}

/** 逐像素列的最大绝对值（用采样步长，长度不足时按 1）。 */
function buildEnvelope(values: Float64Array, totalFrames: number, plotWidth: number, scale: number, _peak: number): Float32Array {
  const columns = Math.max(1, Math.floor(plotWidth));
  const envelope = new Float32Array(columns);
  const perColumn = totalFrames / columns;
  for (let x = 0; x < columns; x += 1) {
    const start = Math.floor(x * perColumn);
    const end = Math.min(totalFrames, Math.max(start + 1, Math.floor((x + 1) * perColumn)));
    let max = 0;
    const step = Math.max(1, Math.floor((end - start) / 6));
    for (let n = start; n < end; n += step) {
      const value = Math.abs(values[n]);
      if (value > max) max = value;
    }
    envelope[x] = max * scale;
  }
  return envelope;
}

function drawEnergy(ctx: CanvasRenderingContext2D, energy: BlockEnergy, left: number, top: number, width: number, height: number): void {
  const blocks = energy.microphone.length;
  if (blocks === 0) return;
  const db = (value: number): number => (value > 0 ? Math.max(-90, 10 * Math.log10(value)) : -90);
  const minDb = -90;
  const maxDb = 0;
  const yOf = (value: number): number => top + height - ((db(value) - minDb) / (maxDb - minDb)) * (height - 6) - 3;

  // 网格
  ctx.strokeStyle = 'rgba(102,117,138,0.18)';
  for (const level of [-80, -60, -40, -20]) {
    const y = yOf(Math.pow(10, level / 10));
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
  }

  const xOf = (index: number): number => left + (index / Math.max(1, blocks - 1)) * width;
  const path = (values: Float64Array, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < blocks; i += 1) {
      const x = xOf(i);
      const y = yOf(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  path(energy.microphone, '#6b7a90');
  path(energy.residual, '#7bd88f');
  ctx.fillStyle = '#95a3b6';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('d', left + width - 32, yOf(0) - 2);
  ctx.fillStyle = '#7bd88f';
  ctx.fillText('e', left + width - 16, yOf(0) - 2);
  ctx.fillStyle = '#6b7a90';
  ctx.fillText('dB', left + 6, top + 12);
}
