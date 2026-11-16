// app-state.js — Central studio state and edit bookkeeping.
import { parseApng, frameZlibStream } from './apng-parser.js';
import { decodeAllFrames, compositeAnimation } from './compositor.js';

export const state = {
  fileName: null,
  parsed: null,
  framePixels: null,      // decoded raw frame RGBA (never changes under edits)
  posterPixels: null,     // default image decoded standalone
  states: null,           // composited before/shown/after per frame
  currentFrame: 0,
  edits: { frames: {}, numPlays: null },
  checker: true,
  zoom: 8,                // integer pixel scale for canvases
  playing: false,
  dirty: false,
};

export function loadFile(name, bytes) {
  const parsed = parseApng(bytes);
  if (bytes.length > parsed.limits.maxBytes) {
    throw new Error(`文件 ${bytes.length} 字节超出 50MB 上限`);
  }
  const framePixels = decodeAllFrames(parsed, frameZlibStream);
  state.fileName = name;
  state.parsed = parsed;
  state.framePixels = framePixels;
  state.edits = { frames: {}, numPlays: null };
  state.currentFrame = 0;
  state.playing = false;
  state.dirty = false;
  state.zoom = fitZoom(parsed.width, parsed.height);
  state.states = compositeAnimation(parsed, framePixels, state.edits.frames);
  return state;
}

// Pick an integer zoom that keeps the scaled canvas inside a 4096px backing-store budget
// and roughly within the on-screen stage width.
function fitZoom(w, h) {
  const maxBacking = 4096;
  const byBacking = Math.max(1, Math.floor(maxBacking / Math.max(w, h)));
  const stageWidth = Math.min(620, window.innerWidth - 360);
  const byStage = Math.max(1, Math.floor(stageWidth / w));
  return Math.min(32, byBacking, byStage);
}

export function frameEdit(i) {
  return state.edits.frames[i] || {};
}

export function effectiveNumPlays() {
  return state.edits.numPlays ?? state.parsed.numPlays;
}

// Apply (or clear, when value === null) one editable field.
export function setFrameEdit(i, field, value) {
  const cur = state.edits.frames[i] || {};
  if (value === null) delete cur[field];
  else cur[field] = value;
  if (Object.keys(cur).length) state.edits.frames[i] = cur;
  else delete state.edits.frames[i];
  state.dirty = true;
  recompose();
}

export function setNumPlays(value) {
  state.edits.numPlays = value;
  state.dirty = true;
}

export function resetEdits() {
  state.edits = { frames: {}, numPlays: null };
  state.dirty = false;
  recompose();
}

export function recompose() {
  state.states = compositeAnimation(state.parsed, state.framePixels, state.edits.frames);
  if (state.currentFrame >= state.parsed.frames.length) {
    state.currentFrame = state.parsed.frames.length - 1;
  }
}

export function effectiveFrameParams(i) {
  const f = state.parsed.frames[i];
  const e = frameEdit(i);
  return {
    delayNum: e.delayNum ?? f.delayNum,
    delayDen: e.delayDen ?? f.delayDen,
    disposeOp: e.disposeOp ?? f.disposeOp,
    blendOp: e.blendOp ?? f.blendOp,
  };
}
