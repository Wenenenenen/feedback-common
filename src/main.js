// main.js — APNG Disposal Studio UI controller.
import { ApngError } from './apng-parser.js';
import { decodePng, encodePng, chunkBytes } from './png-codec.js';
import { exportApng } from './apng-exporter.js';
import { buildZip } from './zip-store.js';
import { frameDurationMs } from './compositor.js';
import { renderCanvas, renderRawFrame, pickPixel } from './canvas-view.js';
import {
  state, loadFile, frameEdit, effectiveNumPlays, setFrameEdit,
  setNumPlays, resetEdits, recompose, effectiveFrameParams,
} from './app-state.js';

const $ = (id) => document.getElementById(id);
const DISPOSE_NAMES = ['NONE', 'BACKGROUND', 'PREVIOUS'];
const BLEND_NAMES = ['SOURCE', 'OVER'];

function downloadBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showError(err) {
  const panel = $('error-panel');
  const all = err.errors || [err];
  const rows = [];
  all.forEach((e, idx) => {
    const detail = e.detail || {};
    if (idx > 0) rows.push('<div class="err-sep"></div>');
    rows.push(`<div class="err-kind">${errorKindLabel(e.kind)}${all.length > 1 ? ` · 问题 ${idx + 1}/${all.length}` : ''}</div>`);
    rows.push(`<div class="err-msg">${escapeHtml(e.message.replace(/^共发现 \d+ 个问题，首要问题：/, ''))}</div>`);
    const loc = [];
    if (detail.chunkType) loc.push(`块类型 <code>${detail.chunkType}</code>`);
    if (typeof detail.offset === 'number') loc.push(`字节偏移 <code>${detail.offset}</code> (0x${detail.offset.toString(16)})`);
    if (typeof detail.crcOffset === 'number') loc.push(`CRC 字段偏移 <code>${detail.crcOffset}</code>`);
    if (loc.length) rows.push(`<div class="err-loc">${loc.join(' · ')}</div>`);
  });
  panel.innerHTML = rows.join('');
  panel.hidden = false;
  $('workspace').hidden = true;
}

function errorKindLabel(kind) {
  return {
    signature: '签名错误', crc: 'CRC 校验失败', length: '块长度错误',
    count: '帧数不匹配', sequence: '序号不连续', bounds: '矩形越界',
    truncation: '文件截断', structure: '结构错误',
  }[kind] || '解析错误';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clearError() {
  $('error-panel').hidden = true;
}

// ---------- file loading ----------
async function handleFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 50 * 1024 * 1024) {
      throw new ApngError(`文件 ${file.size} 字节，超出 50MB 上限`, 'structure', {});
    }
    loadFile(file.name, bytes);
    // decode poster standalone for the poster strip
    const parsed = state.parsed;
    const posterPng = buildStandalonePng(parsed);
    state.posterPixels = decodePng(posterPng).rgba;
    clearError();
    $('workspace').hidden = false;
    buildTimeline();
    refreshAll();
  } catch (err) {
    if (err instanceof ApngError || err.name === 'ApngError') showError(err);
    else showError(new ApngError(err.message, 'structure', {}));
  }
}

function buildStandalonePng(parsed) {
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = parsed.chunks.find((c) => c.type === 'IHDR');
  parts.push(chunkBytes('IHDR', parsed.bytes.subarray(ihdr.bodyStart, ihdr.bodyEnd)));
  for (const c of parsed.idatChunks) {
    parts.push(chunkBytes('IDAT', parsed.bytes.subarray(c.bodyStart, c.bodyEnd)));
  }
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- timeline ----------
function buildTimeline() {
  const strip = $('timeline-strip');
  strip.innerHTML = '';
  state.parsed.frames.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className = 'tl-item';
    btn.dataset.index = i;
    btn.title = `第 ${i} 帧 · fcTL @${f.fctlOffset}`;
    const cv = document.createElement('canvas');
    cv.className = 'tl-thumb';
    btn.appendChild(cv);
    const label = document.createElement('span');
    label.className = 'tl-label';
    label.textContent = `#${i}`;
    btn.appendChild(label);
    btn.addEventListener('click', () => { state.playing = false; updatePlayButton(); selectFrame(i); });
    strip.appendChild(btn);
    renderThumbnail(cv, i);
  });
  $('frame-total').textContent = state.parsed.frames.length;
}

function renderThumbnail(canvas, i) {
  const st = state.states[i];
  renderCanvas(canvas, st.shown, state.parsed.width, state.parsed.height,
    Math.max(1, Math.floor(48 / Math.max(state.parsed.width, state.parsed.height))), false, null);
}

function selectFrame(i) {
  state.currentFrame = Math.max(0, Math.min(state.parsed.frames.length - 1, i));
  refreshAll();
}

// ---------- main rendering ----------
function refreshAll() {
  refreshTimelineSelection();
  refreshCanvases();
  refreshInspector();
  refreshInfo();
}

function refreshTimelineSelection() {
  document.querySelectorAll('.tl-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.index) === state.currentFrame);
  });
  const jump = $('frame-jump');
  if (document.activeElement !== jump) jump.value = state.currentFrame;
}

function refreshCanvases() {
  const i = state.currentFrame;
  const f = state.parsed.frames[i];
  const st = state.states[i];
  const scale = state.zoom;
  const checker = state.checker;
  const W = state.parsed.width, H = state.parsed.height;
  const rect = { x: f.x, y: f.y, width: f.width, height: f.height };

  renderRawFrame($('cv-raw'), state.framePixels[i], f.width, f.height, scale, checker);
  renderCanvas($('cv-before'), st.before, W, H, scale, checker, rect);
  renderCanvas($('cv-shown'), st.shown, W, H, scale, checker, rect);
  renderCanvas($('cv-after'), st.after, W, H, scale, checker, rect);

  $('raw-meta').textContent = `${f.width}×${f.height} @ (${f.x}, ${f.y})`;
  attachPickers(i, f, W, H, scale);
}

function attachPickers(i, f, W, H, scale) {
  const st = state.states[i];
  bindPicker($('cv-raw'), state.framePixels[i], f.width, f.height, scale, 'raw');
  bindPicker($('cv-before'), st.before, W, H, scale, 'canvas');
  bindPicker($('cv-shown'), st.shown, W, H, scale, 'canvas');
  bindPicker($('cv-after'), st.after, W, H, scale, 'canvas');
}

function bindPicker(canvas, rgba, w, h, scale, kind) {
  canvas.onmousemove = (ev) => {
    const p = pickPixel(canvas, ev, rgba, w, h, scale);
    const box = $('pixel-readout');
    if (!p) { box.textContent = '—'; return; }
    box.innerHTML = kind === 'raw'
      ? `局部坐标 <b>(${p.x}, ${p.y})</b> · R <b>${p.r}</b> G <b>${p.g}</b> B <b>${p.b}</b> A <b>${p.a}</b>`
      : `画布坐标 <b>(${p.x}, ${p.y})</b> · R <b>${p.r}</b> G <b>${p.g}</b> B <b>${p.b}</b> A <b>${p.a}</b>`;
    const sw = $('swatch');
    sw.style.background = `rgba(${p.r},${p.g},${p.b},${(p.a / 255).toFixed(3)})`;
  };
  canvas.onmouseleave = () => { $('pixel-readout').textContent = '悬停取色…'; };
}

function refreshInspector() {
  const i = state.currentFrame;
  const f = state.parsed.frames[i];
  const ed = frameEdit(i);
  const eff = effectiveFrameParams(i);

  $('frame-index').textContent = i;
  $('fctl-offset').textContent = `${f.fctlOffset} (0x${f.fctlOffset.toString(16)})`;
  $('frame-rect').textContent = `${f.width}×${f.height} @ (${f.x}, ${f.y})`;

  $('in-delay-num').value = eff.delayNum;
  $('in-delay-den').value = eff.delayDen;
  markEdited($('in-delay-num'), 'delayNum' in ed);
  markEdited($('in-delay-den'), 'delayDen' in ed);

  setSelect($('in-dispose'), eff.disposeOp, 'disposeOp' in ed);
  setSelect($('in-blend'), eff.blendOp, 'blendOp' in ed);

  const { frameMs, effectiveDen } = frameDurationMs(eff.delayNum, eff.delayDen);
  $('frame-ms').textContent = frameMs.toFixed(3).replace(/\.?0+$/, '');
  $('effective-den').textContent = effectiveDen;
  $('cumulative-ms').textContent = state.states[i].cumulativeMs.toFixed(3).replace(/\.?0+$/, '');

  // original values reference
  $('orig-params').textContent =
    `原始：delay ${f.delayNum}/${f.delayDen} · ${DISPOSE_NAMES[f.disposeOp]} · ${BLEND_NAMES[f.blendOp]}`;

  $('num-plays').value = effectiveNumPlays();
  markEdited($('num-plays'), state.edits.numPlays !== null);
  $('poster-flag').textContent = state.parsed.posterIsFrame
    ? '默认图参与动画（首帧即 IDAT）'
    : '默认图仅作封面（帧数据全部在 fdAT）';
}

function markEdited(el, edited) {
  el.classList.toggle('edited', !!edited);
}

function setSelect(sel, value, edited) {
  sel.value = String(value);
  sel.classList.toggle('edited', edited);
}

function refreshInfo() {
  const p = state.parsed;
  $('info-canvas').textContent = `${p.width}×${p.height}`;
  $('info-frames').textContent = p.frames.length;
  $('info-plays').textContent = effectiveNumPlays() === 0 ? '无限' : effectiveNumPlays();
  $('info-poster').textContent = p.posterIsFrame ? '参与动画' : '仅封面';
  $('info-file').textContent = state.fileName;
  $('zoom-label').textContent = `${state.zoom}×`;
  if (state.posterPixels) {
    const cv = $('poster-canvas');
    const scale = Math.max(1, Math.floor(Math.min(cv.width / p.width, cv.height / p.height)));
    renderCanvas(cv, state.posterPixels, p.width, p.height, scale, false, null);
  }
}

// ---------- edits ----------
function bindEditor() {
  $('in-delay-num').addEventListener('change', (e) => {
    const v = clampInt(e.target.value, 0, 65535);
    e.target.value = v;
    setFrameEdit(state.currentFrame, 'delayNum', v);
    afterEdit();
  });
  $('in-delay-den').addEventListener('change', (e) => {
    const v = clampInt(e.target.value, 0, 65535);
    e.target.value = v;
    setFrameEdit(state.currentFrame, 'delayDen', v);
    afterEdit();
  });
  $('in-dispose').addEventListener('change', (e) => {
    setFrameEdit(state.currentFrame, 'disposeOp', Number(e.target.value));
    afterEdit();
  });
  $('in-blend').addEventListener('change', (e) => {
    setFrameEdit(state.currentFrame, 'blendOp', Number(e.target.value));
    afterEdit();
  });
  $('num-plays').addEventListener('change', (e) => {
    const v = clampInt(e.target.value, 0, 0xffffffff);
    e.target.value = v;
    setNumPlays(v);
    refreshInfo();
  });
  $('btn-reset').addEventListener('click', () => {
    resetEdits();
    refreshAll();
  });
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function afterEdit() {
  // early-frame edits propagate: full recomposite already happened in setFrameEdit;
  // every thumbnail and the current canvases refresh.
  document.querySelectorAll('.tl-item').forEach((el, i) => renderThumbnail(el.querySelector('.tl-thumb'), i));
  refreshAll();
}

// ---------- playback (package timing convention) ----------
// Every play starts from a fully transparent canvas, so the composited frame states
// repeat identically across loops. num_plays=0 loops forever; a finite count stops on
// the final frame's shown image (its disposal is never presented).
let playTimer = null;
let playCount = 0;

function updatePlayButton() {
  $('btn-play').textContent = state.playing ? '暂停' : '播放';
}

function startPlay() {
  if (state.playing) return;
  state.playing = true;
  playCount = 0;
  updatePlayButton();
  scheduleNext();
}

function stopPlay() {
  state.playing = false;
  clearTimeout(playTimer);
  updatePlayButton();
}

function scheduleNext() {
  if (!state.playing) return;
  const st = state.states[state.currentFrame];
  const wait = Math.max(1, st.frameMs);
  playTimer = setTimeout(() => {
    const totalFrames = state.parsed.frames.length;
    let next = state.currentFrame + 1;
    if (next >= totalFrames) {
      playCount++;
      const plays = effectiveNumPlays();
      if (plays !== 0 && playCount >= plays) {
        // finite loops completed: remain on the final shown frame
        stopPlay();
        return;
      }
      next = 0; // next play restarts from a transparent canvas
    }
    selectFrame(next);
    scheduleNext();
  }, wait);
}

// ---------- export ----------
function currentEditsPayload() {
  return { numPlays: effectiveNumPlays(), frames: state.edits.frames };
}

function doExportApng() {
  const bytes = exportApng(state.parsed, currentEditsPayload());
  const name = state.fileName.replace(/\.(apng|png)$/i, '') + '-edited.apng';
  downloadBlob(bytes, name, 'image/png');
}

function doExportSequence() {
  const files = [];
  const pad = String(state.parsed.frames.length).length;
  state.states.forEach((st, i) => {
    const png = encodePng(state.parsed.width, state.parsed.height, st.shown);
    files.push({ name: `shown-${String(i).padStart(pad, '0')}.png`, data: png });
  });
  const zip = buildZip(files);
  const name = state.fileName.replace(/\.(apng|png)$/i, '') + '-frames.zip';
  downloadBlob(zip, name, 'application/zip');
}

// ---------- wire up ----------
function init() {
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
  const drop = $('drop-zone');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $('btn-prev').addEventListener('click', () => { stopPlay(); selectFrame(state.currentFrame - 1); });
  $('btn-next').addEventListener('click', () => { stopPlay(); selectFrame(state.currentFrame + 1); });
  $('btn-play').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
  $('btn-first').addEventListener('click', () => { stopPlay(); selectFrame(0); });
  $('btn-last').addEventListener('click', () => { stopPlay(); selectFrame(state.parsed.frames.length - 1); });
  $('frame-jump').addEventListener('change', (e) => {
    stopPlay();
    selectFrame(clampInt(e.target.value, 0, state.parsed.frames.length - 1));
  });

  $('btn-zoom-in').addEventListener('click', () => {
    const next = state.zoom * 2;
    if (next * Math.max(state.parsed.width, state.parsed.height) > 4096) return;
    state.zoom = Math.min(32, next); refreshCanvases(); refreshInfo();
  });
  $('btn-zoom-out').addEventListener('click', () => { state.zoom = Math.max(1, Math.floor(state.zoom / 2)); refreshCanvases(); refreshInfo(); });
  $('chk-checker').addEventListener('change', (e) => { state.checker = e.target.checked; refreshCanvases(); });

  $('btn-export-apng').addEventListener('click', doExportApng);
  $('btn-export-seq').addEventListener('click', doExportSequence);

  bindEditor();

  document.addEventListener('keydown', (e) => {
    if (state.parsed === null) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') { stopPlay(); selectFrame(state.currentFrame - 1); }
    if (e.key === 'ArrowRight') { stopPlay(); selectFrame(state.currentFrame + 1); }
    if (e.key === ' ') { e.preventDefault(); state.playing ? stopPlay() : startPlay(); }
    if (e.key === 'Home') { stopPlay(); selectFrame(0); }
    if (e.key === 'End') { stopPlay(); selectFrame(state.parsed.frames.length - 1); }
  });
}

init();
