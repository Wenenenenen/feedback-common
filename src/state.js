// Application state and the shared processing pipeline.
// Preview and export call the same processFrame() (src/export.js), so what is
// visible on canvas is byte-identical to what lands in the ZIP.

import { processFrame } from './export.js';

export const DEFAULT_PARAMS = {
  keyColor: [33, 211, 33],
  inner: 0.01,
  outer: 0.63,
  softness: 0,
  despillStrength: 0.5,
  protectPolygons: [],
  removePolygons: [],
};

export function createState() {
  return {
    frames: [],          // [{ name, number, width, height, rgb }]
    width: 0,
    height: 0,
    params: structuredClone(DEFAULT_PARAMS),
    background: null,    // { rgb } custom background; null -> use black stand-in
    currentFrame: 0,
    view: 'original',    // original | matte | checker | black | white | custom
    showOverlay: true,
    tool: 'protect',     // protect | remove | edit
    // polygon editing
    drawing: null,       // { kind, points: [[x,y]...] } while drawing
    selected: null,      // { kind, index }
    vertexDrag: null,    // active vertex handle
    // viewport transform
    zoom: 1,
    panX: 0,
    panY: 0,
    // caches
    processed: null,     // output of processFrame for current frame/params
    // playback
    playing: false,
    fps: 24,
  };
}

export function invalidateCaches(state) {
  state.processed = null;
}

// Background used when the user has not picked a custom PNG: a black field,
// which also backs the "黑底" view.
function solidBackground(width, height, value) {
  const rgb = new Uint8Array(width * height * 3).fill(value);
  return { rgb };
}

export function getBackground(state) {
  if (state.background) return state.background;
  return solidBackground(state.width, state.height, 0);
}

// Recompute the current frame through the shared pipeline.
export function recomputeCurrent(state) {
  const frame = state.frames[state.currentFrame];
  if (!frame) { state.processed = null; return null; }
  state.processed = processFrame(frame.rgb, state.width, state.height, state.params, getBackground(state));
  return state.processed;
}

// ----- polygon model helpers -------------------------------------------------

export function polygonList(state) {
  const out = [];
  state.params.protectPolygons.forEach((points, index) => out.push({ kind: 'protect', index, points }));
  state.params.removePolygons.forEach((points, index) => out.push({ kind: 'remove', index, points }));
  return out;
}

export function addPolygon(state, kind, points) {
  const list = kind === 'protect' ? state.params.protectPolygons : state.params.removePolygons;
  list.push(points);
  invalidateCaches(state);
  return { kind, index: list.length - 1 };
}

export function deleteSelected(state) {
  if (!state.selected) return;
  const { kind, index } = state.selected;
  const list = kind === 'protect' ? state.params.protectPolygons : state.params.removePolygons;
  list.splice(index, 1);
  state.selected = null;
  invalidateCaches(state);
}

export function selectedPolygon(state) {
  if (!state.selected) return null;
  const { kind, index } = state.selected;
  const list = kind === 'protect' ? state.params.protectPolygons : state.params.removePolygons;
  return list[index] ? { kind, index, points: list[index] } : null;
}
