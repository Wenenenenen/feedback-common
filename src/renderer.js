// Canvas rendering for all six preview views, plus polygon overlay and the
// zoom/pan transform. Image content comes exclusively from processFrame().

import { selectedPolygon, polygonList } from './state.js';

const PROTECT_COLOR = '#37d67a';
const REMOVE_COLOR = '#ff6b5e';

// Build an ImageData-backed checkerboard at image resolution.
function checkerboard(width, height) {
  const cell = Math.max(4, Math.round(Math.min(width, height) / 32));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ? 200 : 110;
      const o = (y * width + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
  }
  return out;
}

// Straight-alpha composite over an opaque RGBA backdrop (both sRGB bytes).
function overBackdrop(rgba, backdrop, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const a = rgba[o + 3] / 255;
    out[o] = Math.round(rgba[o] * a + backdrop[o] * (1 - a));
    out[o + 1] = Math.round(rgba[o + 1] * a + backdrop[o + 1] * (1 - a));
    out[o + 2] = Math.round(rgba[o + 2] * a + backdrop[o + 2] * (1 - a));
    out[o + 3] = 255;
  }
  return out;
}

export function renderFrame(canvas, ctx, state) {
  const { width, height } = state;
  if (!width || !state.processed) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const p = state.processed;
  let imageData;
  if (state.view === 'original') {
    // ImageData requires 4 bytes per pixel; expand RGB with an opaque alpha.
    const src = state.frames[state.currentFrame];
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, o = 0; i < src.rgb.length; i += 3, o += 4) {
      rgba[o] = src.rgb[i]; rgba[o + 1] = src.rgb[i + 1]; rgba[o + 2] = src.rgb[i + 2]; rgba[o + 3] = 255;
    }
    imageData = new ImageData(rgba, width, height);
  } else if (state.view === 'matte') {
    const g = p.matteBytes;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, o = 0; i < g.length; i++, o += 4) {
      rgba[o] = g[i]; rgba[o + 1] = g[i]; rgba[o + 2] = g[i]; rgba[o + 3] = 255;
    }
    imageData = new ImageData(rgba, width, height);
  } else if (state.view === 'checker') {
    imageData = new ImageData(overBackdrop(p.rgba, checkerboard(width, height), width * height), width, height);
  } else if (state.view === 'black' || state.view === 'white') {
    const v = state.view === 'black' ? 0 : 255;
    const back = new Uint8ClampedArray(width * height * 4);
    for (let o = 3; o < back.length; o += 4) { back[o - 3] = v; back[o - 2] = v; back[o - 1] = v; back[o] = 255; }
    imageData = new ImageData(overBackdrop(p.rgba, back, width * height), width, height);
  } else {
    // custom background: the pipeline already produced the linear-light composite
    const c = p.composite;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, o = 0; i < c.length; i += 3, o += 4) {
      rgba[o] = c[i]; rgba[o + 1] = c[i + 1]; rgba[o + 2] = c[i + 2]; rgba[o + 3] = 255;
    }
    imageData = new ImageData(rgba, width, height);
  }

  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(imageData, 0, 0);
  if (state.showOverlay) drawOverlay(ctx, state);
}

function drawOverlay(ctx, state) {
  const drawOne = (points, color, selected) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5));
    ctx.closePath();
    ctx.fillStyle = color + (selected ? '2e' : '1c');
    ctx.fill();
    ctx.lineWidth = selected ? 1.6 : 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = color;
      for (const [x, y] of points) {
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
    }
  };
  state.params.protectPolygons.forEach((pts, i) =>
    drawOne(pts, PROTECT_COLOR, state.selected?.kind === 'protect' && state.selected.index === i));
  state.params.removePolygons.forEach((pts, i) =>
    drawOne(pts, REMOVE_COLOR, state.selected?.kind === 'remove' && state.selected.index === i));

  // in-progress polygon
  if (state.drawing) {
    const color = state.drawing.kind === 'protect' ? PROTECT_COLOR : REMOVE_COLOR;
    const pts = state.drawing.points;
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = color;
    for (const [x, y] of pts) ctx.fillRect(x - 2, y - 2, 4, 4);
  }
}

// ----- coordinate transforms -------------------------------------------------

export function applyTransform(canvas, viewport, state) {
  const { width, height } = state;
  if (!width) return;
  const base = fitScale(viewport.clientWidth, viewport.clientHeight, width, height);
  const scale = base * state.zoom;
  canvas.style.width = width * scale + 'px';
  canvas.style.height = height * scale + 'px';
  canvas.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
}

export function fitScale(vw, vh, iw, ih) {
  return Math.min(vw / iw, vh / ih) * 0.96;
}

// Convert a mouse event to image pixel coordinates (float).
export function eventToImage(e, canvas, state) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * state.width;
  const y = (e.clientY - rect.top) / rect.height * state.height;
  return [x, y];
}

const HANDLE_R = 6; // screen px hit radius for vertex handles

export function hitTest(state, imageX, imageY, canvas) {
  const scale = canvas.getBoundingClientRect().width / state.width;
  const r = HANDLE_R / scale;
  // vertices first (only on selected polygon)
  const sel = selectedPolygon(state);
  if (sel) {
    for (let i = 0; i < sel.points.length; i++) {
      const [x, y] = sel.points[i];
      if (Math.hypot(x - imageX, y - imageY) <= r) return { type: 'vertex', ...state.selected, vertex: i };
    }
  }
  // polygon bodies
  for (const item of polygonList(state)) {
    if (pointInPoly(imageX, imageY, item.points)) return { type: 'body', kind: item.kind, index: item.index };
  }
  return null;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
