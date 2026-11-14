/**
 * 2-D section canvas: draw loops filled by type, with hover highlighting,
 * measured labels for larger loops, and pan/zoom. Canvas 2D only.
 */

import { View2D } from './camera.js';

const COLORS = {
  solidFill: 'rgba(56,139,253,0.30)',
  solidStroke: '#1f6feb',
  holeFill: 'rgba(250,250,252,1)',
  holeStroke: '#c2410c',
  openStroke: '#b91c1c',
  hover: 'rgba(255,214,10,0.5)',
  axis: 'rgba(100,116,139,0.25)',
  text: '#334155',
};

export class SectionCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.view = new View2D();
    this.section = null;
    this.hoverLoop = null;
    this.selectedLoop = null;
    this.showLabels = true;
    this.showGrid = true;
    this.onHover = null;
    this.onSelect = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.lastFitKey = null;
    this.fitRequested = true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  requestFit() {
    this.fitRequested = true;
  }

  setSection(section) {
    this.section = section;
    this.hoverLoop = null;
    this.selectedLoop = null;
    if (section && !section.empty) {
      const key = sectionFitKey(section);
      if (this.fitRequested || key !== this.lastFitKey) {
        this.lastFitKey = key;
        this.fitRequested = false;
        const bbox = unionBBox(section);
        this.view.reset(bbox, this.width, this.height);
      }
    }
  }

  draw() {
    const ctx = this.resize();
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fbfcfd';
    ctx.fillRect(0, 0, w, h);

    if (!this.section) {
      this.drawHint(ctx, w, h, '暂无截面');
      return;
    }
    if (this.section.empty) {
      this.drawHint(ctx, w, h, this.section.reason || '平面与模型无交');
      return;
    }

    this.drawGrid(ctx);

    const loops = this.section.loops;
    const solids = loops.filter((l) => l.kind === 'solid');
    const holes = loops.filter((l) => l.kind === 'hole');
    const opens = loops.filter((l) => l.kind === 'open');

    // Fill from largest to smallest, each loop on its own. This keeps nested
    // cases right (an island inside a cavity is material again) and avoids
    // even-odd fill turning a nested solid into a hole.
    const closed = [...solids, ...holes].sort(
      (a, b) => Math.abs(b.area_mm2) - Math.abs(a.area_mm2),
    );
    for (const l of closed) {
      ctx.save();
      ctx.beginPath();
      addPath(ctx, l, this.view, w, h);
      ctx.fillStyle = l.kind === 'solid' ? COLORS.solidFill : COLORS.holeFill;
      ctx.fill();
      ctx.restore();
    }

    if (this.hoverLoop !== null || this.selectedLoop !== null) {
      const target = this.selectedLoop ?? this.hoverLoop;
      const loop = loops.find((l) => l.id === target);
      if (loop) {
        ctx.save();
        ctx.beginPath();
        addPath(ctx, loop, this.view, w, h);
        ctx.fillStyle = COLORS.hover;
        ctx.fill();
        ctx.restore();
      }
    }

    // Strokes.
    for (const l of solids) strokeLoop(ctx, l, this.view, w, h, COLORS.solidStroke, 2);
    for (const l of holes) strokeLoop(ctx, l, this.view, w, h, COLORS.holeStroke, 2);
    for (const l of opens) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      strokeLoop(ctx, l, this.view, w, h, COLORS.openStroke, 1.6);
      ctx.restore();
    }

    if (this.showLabels) this.drawLabels(ctx, loops);
  }

  drawHint(ctx, w, h, text) {
    ctx.save();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
    ctx.restore();
  }

  drawGrid(ctx) {
    if (!this.showGrid) return;
    const { width: w, height: h, view } = this;
    const mmTarget = 60; // desired px per grid cell
    const rawStep = mmTarget / view.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 1e-9))));
    const candidates = [1, 2, 5, 10];
    let step = pow;
    for (const c of candidates) {
      if (pow * c >= rawStep) { step = pow * c; break; }
    }
    const world = [
      this.view.toWorld(0, 0, w, h),
      this.view.toWorld(w, h, w, h),
    ];
    const minx = Math.min(world[0][0], world[1][0]);
    const maxx = Math.max(world[0][0], world[1][0]);
    const miny = Math.min(world[0][1], world[1][1]);
    const maxy = Math.max(world[0][1], world[1][1]);
    ctx.save();
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = Math.ceil(minx / step) * step; x <= maxx; x += step) {
      const [sx] = this.view.toScreen([x, 0], w, h);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.ceil(miny / step) * step; y <= maxy; y += step) {
      const [, sy] = this.view.toScreen([0, y], w, h);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
    // Axis lines (u=0, v=0).
    const [ox, oy] = this.view.toScreen([0, 0], w, h);
    ctx.strokeStyle = 'rgba(71,85,105,0.45)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    if (oy > 0 && oy < h) { ctx.moveTo(0, oy); ctx.lineTo(w, oy); }
    if (ox > 0 && ox < w) { ctx.moveTo(ox, 0); ctx.lineTo(ox, h); }
    ctx.stroke();
    ctx.restore();
    this.gridStep = step;
  }

  drawLabels(ctx, loops) {
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelItems = loops
      .map((l) => ({
        l,
        px: Math.abs(polygonArea(l.points2d)) * this.view.scale * this.view.scale,
      }))
      .sort((a, b) => b.px - a.px)
      .slice(0, 18);
    for (const { l, px } of labelItems) {
      if (px < 2200) continue;
      const c = centroid(l.points2d);
      const [sx, sy] = this.view.toScreen(c, this.width, this.height);
      const text =
        l.kind === 'hole'
          ? l.bodyId == null
            ? '孔（无外环）'
            : `孔 ${fmtArea(-l.area_mm2)}`
          : l.kind === 'solid'
            ? fmtArea(l.area_mm2)
            : '开口';
      const wid = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fillRect(sx - wid / 2, sy - 8, wid, 16);
      ctx.fillStyle = l.kind === 'hole' ? '#9a3412' : l.kind === 'solid' ? '#1e40af' : '#991b1b';
      ctx.fillText(text, sx, sy);
    }
    ctx.restore();
  }

  hitTest(px, py) {
    if (!this.section || this.section.empty) return null;
    const world = this.view.toWorld(px, py, this.width, this.height);
    // Prefer the smallest-area loop containing the point, so holes and small
    // bodies are selectable inside big ones.
    let best = null;
    let bestAbs = Infinity;
    for (const l of this.section.loops) {
      if (l.kind === 'open') {
        const d = distanceToPolyline(world, l.points2d);
        const tol = 6 / this.view.scale;
        if (d <= tol && d < bestAbs) { best = l; bestAbs = d; }
        continue;
      }
      if (pointInPolygon(world, l.points2d)) {
        const a = Math.abs(polygonArea(l.points2d));
        if (a < bestAbs) { best = l; bestAbs = a; }
      }
    }
    return best;
  }
}

function sectionFitKey(section) {
  // Fit only when the section's spatial extent changes materially: panning the
  // plane should not jump the zoom.
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const l of section.loops) {
    for (const p of l.points2d) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
  }
  if (!Number.isFinite(minx)) return 'empty';
  const r = (v) => Math.round(v * 4) / 4;
  return `${r(minx)},${r(miny)},${r(maxx)},${r(maxy)}`;
}

function unionBBox(section) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const l of section.loops) {
    for (const p of l.points2d) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
  }
  return Number.isFinite(minx) ? [minx, miny, maxx, maxy] : null;
}

function addPath(ctx, loop, view, w, h) {
  const pts = loop.points2d;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = view.toScreen(pts[i], w, h);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (loop.closed) ctx.closePath();
}

function strokeLoop(ctx, loop, view, w, h, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  addPath(ctx, loop, view, w, h);
  ctx.stroke();
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

function distanceToPolyline(pt, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distanceToSegment(pt, pts[i], pts[i + 1]));
  }
  return best;
}

function distanceToSegment(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

function fmtArea(mm2) {
  const abs = Math.abs(mm2);
  if (abs >= 1000) return `${(mm2 / 100).toFixed(1)} cm²`;
  if (abs >= 10) return `${mm2.toFixed(1)} mm²`;
  if (abs >= 1) return `${mm2.toFixed(2)} mm²`;
  return `${mm2.toFixed(3)} mm²`;
}
