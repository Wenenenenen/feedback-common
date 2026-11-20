import type { UV } from '../core/types.js';
import { chartColor, rampColor, SEQUENTIAL, STATUS, INK } from './colors.js';
import type { Store } from './state.js';

const FLIP_COLOR = STATUS.critical;
const NEAR_ZERO_COLOR = STATUS.warning;
const INVALID_COLOR = '#5b6472';
const BOUNDARY_COLOR = '#7dd3fc';
const SEAM_COLOR = '#fbbf24';

interface Cell {
  chart: number;
  /** Canvas rect in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** UV-space centre and scale. */
  cx: number;
  cy: number;
  scale: number;
}

export class UvView {
  private readonly wrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly hud: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly store: Store;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private cells: Cell[] = [];
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private hover: { chart: number; face: number } | null = null;
  private dragging: { x: number; y: number } | null = null;
  private dragMoved = false;
  private dpr = 1;


  constructor(args: {
    wrap: HTMLElement;
    canvas: HTMLCanvasElement;
    hud: HTMLElement;
    legend: HTMLElement;
    empty: HTMLElement;
    store: Store;
  }) {
    this.wrap = args.wrap;
    this.canvas = args.canvas;
    this.hud = args.hud;
    this.legend = args.legend;
    this.empty = args.empty;
    this.store = args.store;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.wrap);
    this.draw();

    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.hud.textContent = '';
      this.draw();
    });
    this.canvas.addEventListener('mousedown', (e) => {
      this.dragging = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => {
      this.dragging = null;
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragging.x;
      const dy = e.clientY - this.dragging.y;
      if (Math.hypot(dx, dy) > 3) this.dragMoved = true;
      this.panX += dx;
      this.panY += dy;
      this.dragging = { x: e.clientX, y: e.clientY };
      this.draw();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        this.zoom = Math.min(8, Math.max(0.4, this.zoom * factor));
        this.draw();
      },
      { passive: false },
    );
    this.canvas.addEventListener('click', (e) => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      const hit = this.hitTest(e);
      if (!hit) {
        this.store.select({ face: null, faces: [], chart: null, cutVertex: null });
        return;
      }
      const result = this.store.result;
      const chart = result?.charts[hit.chart];
      this.store.select({
        face: hit.face,
        chart: hit.chart,
        faces: chart?.faces ?? [hit.face],
        cutVertex: null,
      });
    });
    this.canvas.addEventListener('dblclick', () => {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.draw();
    });

    this.store.subscribe((event) => {
      if (event === 'input' || event === 'seams' || event === 'result' || event === 'view' || event === 'selection') {
        this.draw();
      }
    });
  }

  fit(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.draw();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
  }

  private layout(): { width: number; height: number } {
    const width = this.wrap.clientWidth;
    const height = this.wrap.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(width * this.dpr) || this.canvas.height !== Math.round(height * this.dpr)) {
      this.canvas.width = Math.round(width * this.dpr);
      this.canvas.height = Math.round(height * this.dpr);
    }
    return { width, height };
  }

  private computeCells(width: number, height: number): Cell[] {
    const result = this.store.result;
    if (!result) return [];
    const drawable = result.charts.filter((c) => c.valid || c.boundaryLoops.length > 0);
    const list = drawable.length > 0 ? drawable : result.charts;
    if (list.length === 0) return [];
    const grid = this.store.flags.uvGrid && list.length > 1;
    if (!grid) {
      const scale = (Math.min(width, height) / 2.6) * this.zoom;
      return list.map((chart) => ({
        chart: chart.index,
        x: 0,
        y: 0,
        w: width,
        h: height,
        cx: width / 2 + this.panX,
        cy: height / 2 + this.panY,
        scale,
      }));
    }
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    const cellW = width / cols;
    const cellH = height / rows;
    const scale = (Math.min(cellW, cellH) / 2.6) * this.zoom;
    return list.map((chart, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW;
      const y = row * cellH;
      return {
        chart: chart.index,
        x,
        y,
        w: cellW,
        h: cellH,
        cx: x + cellW / 2 + this.panX,
        cy: y + cellH / 2 + this.panY,
        scale,
      };
    });
  }

  private draw(): void {
    const { width, height } = this.layout();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = INK.surface;
    ctx.fillRect(0, 0, width, height);

    const result = this.store.result;
    const input = this.store.input;
    if (!result || !input) {
      this.empty.classList.remove('hidden');
      this.cells = [];
      this.hud.textContent = '';
      this.legend.innerHTML = '';
      return;
    }
    this.empty.classList.add('hidden');

    this.cells = this.computeCells(width, height);
    for (const cell of this.cells) this.drawCell(cell);

    // Residual legend for the ramp (only when residual colouring is active).
    this.legend.innerHTML = this.store.flags.uvResidual
      ? this.rampLegend()
      : this.chartLegend();

    this.updateHud();
  }

  private chartLegend(): string {
    const result = this.store.result!;
    const parts: string[] = [];
    for (let i = 0; i < Math.min(result.charts.length, 8); i++) {
      parts.push(`<span class="item"><span class="chip" style="background:${chartColor(i)}"></span>图表 ${i}</span>`);
    }
    parts.push(`<span class="item"><span class="chip" style="background:${BOUNDARY_COLOR}"></span>边界（单位圆）</span>`);
    const flipped = result.stats.flippedFaces;
    const near = result.stats.nearZeroFaces;
    if (flipped > 0) parts.push(`<span class="item"><span class="chip" style="background:${FLIP_COLOR}"></span>翻转 ${flipped}</span>`);
    if (near > 0) parts.push(`<span class="item"><span class="chip" style="background:${NEAR_ZERO_COLOR}"></span>近零 ${near}</span>`);
    return parts.join('');
  }

  private rampLegend(): string {
    const stops = SEQUENTIAL.map((c) => `<span class="chip" style="background:${c}"></span>`).join('');
    return `<span class="item">归一化残差</span><span class="item">${stops}</span><span class="item">0 → ${this.store.result?.stats.maxResidual.toExponential(1)}</span>`;
  }

  private updateHud(): void {
    const result = this.store.result;
    if (!result) {
      this.hud.textContent = '';
      return;
    }
    const h = this.hover;
    if (h) {
      this.hud.innerHTML = `图表 ${h.chart} · 面 ${h.face}`;
      return;
    }
    const parts = [`${result.charts.length} 图表`, `残差 ≤ ${result.stats.maxResidual.toExponential(1)}`];
    this.hud.innerHTML = parts.join(' · ');
  }

  private drawCell(cell: Cell): void {
    const ctx = this.ctx;
    const result = this.store.result!;
    const chart = result.charts[cell.chart];
    if (!chart) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.w, cell.h);
    ctx.clip();

    const cx = cell.cx;
    const cy = cell.cy;
    const s = cell.scale;
    const toScreen = (uv: UV): [number, number] => [cx + uv[0] * s, cy - uv[1] * s];

    // Cell frame + faint unit circle.
    if (this.store.flags.uvGrid && this.cells.length > 1) {
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
      ctx.fillStyle = INK.muted;
      ctx.font = '10.5px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`图表 ${cell.chart}`, cell.x + cell.w - 8, cell.y + 6);
    }

    ctx.beginPath();
    ctx.arc(cx, cy, s, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(125,211,252,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const firstUv = chart.faces.length > 0 ? result.cornerUV[chart.faces[0] * 3] : null;
    if (!firstUv) {
      // Distinguish a topology defect of this chart from an input rejected
      // upstream (a non-manifold edge elsewhere, for instance).
      const topologyCodes = new Set(['chart-not-disk', 'boundary-branching', 'degenerate-boundary']);
      const topologyDefect = chart.errors.some((e) => topologyCodes.has(e.code));
      const message = topologyDefect
        ? '图表不是拓扑圆盘，未生成 UV'
        : '输入存在错误，图表未求解（见诊断）';
      ctx.fillStyle = INK.muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(message, cx, cy + s * 0.86);
    }

    // Draw triangles.
    const sel = this.store.selection;
    for (const fi of chart.faces) {
      const uv0 = result.cornerUV[fi * 3 + 0];
      const uv1 = result.cornerUV[fi * 3 + 1];
      const uv2 = result.cornerUV[fi * 3 + 2];
      if (!uv0 || !uv1 || !uv2) continue;
      const [ax, ay] = toScreen(uv0);
      const [bx, by] = toScreen(uv1);
      const [qx, qy] = toScreen(uv2);

      const flipped = chart.flippedFaces.includes(fi);
      const nearZero = chart.nearZeroFaces.includes(fi);
      let fill = this.store.flags.chartColor ? chartColor(cell.chart) : INK.secondary;
      if (this.store.flags.uvResidual) {
        let localMax = 0;
        for (let c = 0; c < 3; c++) {
          const cv = result.cornerCutVertex[fi * 3 + c] ?? -1;
          if (cv < 0) continue;
          const r = chart.residuals.interior.find((x) => x.cutVertex === cv);
          if (r) localMax = Math.max(localMax, r.normalized);
        }
        const max = Math.max(result.stats.maxResidual, 1e-12);
        fill = localMax > 0 ? rampColor(Math.log1p(localMax) / (Math.log1p(max) || 1)) : rampColor(0);
      }
      if (flipped) fill = FLIP_COLOR;
      else if (nearZero) fill = NEAR_ZERO_COLOR;
      else if (!chart.valid) fill = INVALID_COLOR;

      const dimmed = sel.chart !== null && sel.chart !== cell.chart;
      const selected = sel.face === fi;

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(qx, qy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.globalAlpha = dimmed ? 0.4 : selected ? 1 : 0.86;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(11,15,22,0.55)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }

    // Boundary loop (arc-length placement) drawn on the unit circle.
    ctx.strokeStyle = BOUNDARY_COLOR;
    ctx.lineWidth = 1.5;
    for (const loop of chart.boundaryLoops) {
      ctx.beginPath();
      loop.forEach((cv, i) => {
        const uv = result.cutVertices[cv]?.uv;
        if (!uv) return;
        const [x, y] = toScreen(uv);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }

    // Split vertices: highlight each original vertex that appears more than once.
    const grouped = new Map<number, number[]>();
    for (const cv of chart.cutVertices) {
      const orig = result.cutVertices[cv].originalVertex;
      const list = grouped.get(orig);
      if (list) list.push(cv);
      else grouped.set(orig, [cv]);
    }
    ctx.fillStyle = SEAM_COLOR;
    for (const [, list] of grouped) {
      if (list.length < 2) continue;
      for (const cv of list) {
        const uv = result.cutVertices[cv]?.uv;
        if (!uv) continue;
        const [x, y] = toScreen(uv);
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Axis cross at chart origin.
    ctx.strokeStyle = 'rgba(147,162,184,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy);
    ctx.lineTo(cx + s, cy);
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx, cy + s);
    ctx.stroke();
    ctx.restore();
  }

  private hitTest(e: MouseEvent): { chart: number; face: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const result = this.store.result;
    if (!result) return null;
    const cell = this.cells.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
    if (!cell) return null;
    const chart = result.charts[cell.chart];
    if (!chart) return null;
    for (const fi of chart.faces) {
      const uv0 = result.cornerUV[fi * 3 + 0];
      const uv1 = result.cornerUV[fi * 3 + 1];
      const uv2 = result.cornerUV[fi * 3 + 2];
      if (!uv0 || !uv1 || !uv2) continue;
      const a: [number, number] = [cell.cx + uv0[0] * cell.scale, cell.cy - uv0[1] * cell.scale];
      const b: [number, number] = [cell.cx + uv1[0] * cell.scale, cell.cy - uv1[1] * cell.scale];
      const c: [number, number] = [cell.cx + uv2[0] * cell.scale, cell.cy - uv2[1] * cell.scale];
      if (pointInTriangle([x, y], a, b, c)) return { chart: cell.chart, face: fi };
    }
    return null;
  }

  private onMove(e: MouseEvent): void {
    const hit = this.hitTest(e);
    this.hover = hit ? { chart: hit.chart, face: hit.face } : null;
    if (hit) {
      this.store.hover = { face: hit.face, edge: null };
    } else if (this.store.hover.face !== null) {
      this.store.hover = { face: null, edge: null };
    }
    this.updateHud();
    this.draw();
  }
}

function sign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function pointInTriangle(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const d1 = sign(p[0], p[1], a[0], a[1], b[0], b[1]);
  const d2 = sign(p[0], p[1], b[0], b[1], c[0], c[1]);
  const d3 = sign(p[0], p[1], c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export { pointInTriangle };
