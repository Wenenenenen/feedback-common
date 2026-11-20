// 缝线缩放工作台：应用状态、画布渲染、画笔、变换编排与导出。
import { decodePNG, encodePNG } from './png-codec.js';
import { makeImage, cloneImage, runOperation, energyForAxis } from './seam-engine.js';
import { History, buildReplayFrames, frameEnergy } from './history.js';

const MIN_IN = 2, MAX_IN = 512, MIN_OUT = 2, MAX_OUT = 768, MAX_DELTA = 128;

const state = {
  image: null,            // 当前 History 指向的图（= history.current.image）
  sourceName: '',
  maskName: '',
  history: null,
  player: null,           // { frames, index, showEnergy, axis }
  brush: { size: 4, mode: 'paint' },
  maskVisible: true,
  order: 'width-first',
  painting: false,
  lastPaintCell: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');

// ---------- 工具 ----------
function setStatus(message, tone = 'info') {
  const el = $('status');
  el.textContent = message;
  el.dataset.tone = tone;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName(name) {
  return (name || 'image').replace(/\.png$/i, '');
}

// ---------- 载入 ----------
async function loadImage(file) {
  try {
    const buf = await file.arrayBuffer();
    const dec = await decodePNG(buf);
    if (dec.channels < 3) {
      throw new Error('仅支持 8 位 RGB（或 RGBA）PNG，收到灰度图，请先转换为 RGB。');
    }
    if (dec.width < MIN_IN || dec.width > MAX_IN || dec.height < MIN_IN || dec.height > MAX_IN) {
      throw new Error(`输入边长须在 ${MIN_IN}–${MAX_IN} 之间，当前为 ${dec.width}×${dec.height}。`);
    }
    let rgb = dec.data;
    if (dec.channels === 4) {
      const flat = new Uint8Array(dec.width * dec.height * 3);
      for (let i = 0, j = 0; i < dec.width * dec.height; i++, j += 3) {
        flat[j] = rgb[i * 4]; flat[j + 1] = rgb[i * 4 + 1]; flat[j + 2] = rgb[i * 4 + 2];
      }
      rgb = flat;
    }
    const img = makeImage(dec.width, dec.height, rgb, new Uint8Array(dec.width * dec.height));
    state.image = img;
    state.sourceName = file.name;
    state.maskName = '';
    state.history = new History(img);
    state.player = null;
    $('player-panel').hidden = true;
    $('target-w').value = dec.width;
    $('target-h').value = dec.height;
    setStatus(`已载入 ${file.name}（${dec.width}×${dec.height}）。可直接绘制保护区域，或载入同尺寸掩膜。`);
    refreshUndoRedo();
    validateTargets();
    render();
  } catch (err) {
    setStatus('载入失败：' + err.message, 'error');
  }
}

async function loadMask(file) {
  if (!state.image) { setStatus('请先载入 RGB 图像。', 'error'); return; }
  try {
    const dec = await decodePNG(await file.arrayBuffer());
    if (dec.width !== state.image.width || dec.height !== state.image.height) {
      throw new Error(`掩膜尺寸 ${dec.width}×${dec.height} 与图像 ${state.image.width}×${state.image.height} 不一致。`);
    }
    const cur = state.history.current.image;
    const mask = new Uint8Array(cur.width * cur.height);
    const ch = dec.channels;
    for (let i = 0; i < mask.length; i++) mask[i] = dec.data[i * ch] !== 0 ? 255 : 0;
    const next = makeImage(cur.width, cur.height, cur.rgb.slice(), mask);
    state.history.push({ kind: 'load-mask', label: `载入掩膜 ${file.name}`, image: next, trace: null, meta: { maskName: file.name } });
    state.maskName = file.name;
    state.image = state.history.current.image;
    state.player = null;
    refreshUndoRedo();
    render();
    setStatus(`已载入掩膜 ${file.name}，非零像素标记为保护。`);
  } catch (err) {
    setStatus('掩膜载入失败：' + err.message, 'error');
  }
}

// ---------- 画布渲染 ----------
function currentDisplayImage() {
  if (state.player) return state.player.frames[state.player.index].image;
  return state.image;
}

function render() {
  if (!state.image) return;
  const frame = state.player ? state.player.frames[state.player.index] : null;
  const img = frame ? frame.image : state.image;
  canvas.width = img.width;
  canvas.height = img.height;

  const showEnergy = $('view-energy').ariaPressed === 'true' || (state.player && state.player.showEnergy);
  if (showEnergy) {
    const axis = state.player ? state.player.axis : ($('axis-x').classList.contains('active') ? 'x' : 'y');
    const { energy, width, height } = frame ? frameEnergy(frame, axis) : energyForAxis(img, axis);
    drawEnergy(energy, width, height, img.mask);
  } else {
    const data = new ImageData(img.width, img.height);
    for (let i = 0, p = 0; i < img.width * img.height; i++, p += 4) {
      data.data[p] = img.rgb[i * 3];
      data.data[p + 1] = img.rgb[i * 3 + 1];
      data.data[p + 2] = img.rgb[i * 3 + 2];
      data.data[p + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  }

  // 保护掩膜叠加
  if (state.maskVisible && !showEnergy) drawMask(img.mask, img.width, img.height);

  // 缝线叠加
  if (frame && frame.overlay) drawOverlay(frame, img);

  updateSizeBadge(img);
  if (state.player) updatePlayerChrome(frame);
}

function drawMask(mask, w, h) {
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = '#ff3b5c';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 0) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

function drawEnergy(energy, w, h, mask) {
  let max = 0;
  for (let i = 0; i < energy.length; i++) {
    if (Number.isFinite(energy[i]) && energy[i] > max) max = energy[i];
  }
  const img = ctx.createImageData(w, h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (mask[i] !== 0 || !Number.isFinite(energy[i])) {
      // 保护像素：品红提示
      img.data[p] = 255; img.data[p + 1] = 0; img.data[p + 2] = 200; img.data[p + 3] = 255;
      continue;
    }
    const t = max > 0 ? energy[i] / max : 0;
    const [r, g, b] = ramp(t);
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// 深蓝 → 青 → 黄 → 红 的能量色带
function ramp(t) {
  const stops = [
    [0, [12, 20, 48]], [0.35, [28, 120, 160]], [0.65, [240, 200, 70]], [1, [235, 70, 60]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k));
    }
  }
  return stops[stops.length - 1][1];
}

function drawOverlay(frame, img) {
  const ov = frame.overlay;
  // 小图也要清晰：描边至少占一个完整像素，外加半透明发光底线
  const base = Math.max(1, Math.min(img.width, img.height) / 160);
  const tracePath = (points) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5));
  };
  ctx.save();
  if (ov.seam) {
    // 单条缝：深色描边 + 亮色主线，任何背景上都可见
    tracePath(ov.seam);
    ctx.strokeStyle = 'rgba(8,10,18,.85)';
    ctx.lineWidth = base + 1;
    ctx.stroke();
    tracePath(ov.seam);
    ctx.strokeStyle = ov.work ? '#7cf5ff' : '#ffe14d';
    ctx.lineWidth = base;
    ctx.stroke();
  }
  if (ov.seams) {
    // 批次应用：多条映回原图的缝，用不同色相区分，同样加暗底
    const hues = ['#ffe14d', '#7cf5ff', '#9dff8a', '#ff9f7c', '#d5a6ff', '#ffffff'];
    ov.seams.forEach((seam, idx) => {
      tracePath(seam);
      ctx.strokeStyle = 'rgba(8,10,18,.7)';
      ctx.lineWidth = base + 0.8;
      ctx.stroke();
      tracePath(seam);
      ctx.strokeStyle = hues[idx % hues.length];
      ctx.lineWidth = base;
      ctx.globalAlpha = 0.95;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function updateSizeBadge(img) {
  $('size-badge').textContent = `${img.width} × ${img.height}`;
}

function updatePlayerChrome(frame) {
  const p = state.player;
  $('player-panel').hidden = false;
  $('player-title').textContent = frame.label;
  $('player-index').textContent = `${p.index + 1} / ${p.frames.length}`;
  $('player-prev').disabled = p.index === 0;
  $('player-next').disabled = p.index === p.frames.length - 1;
  $('player-slider').max = p.frames.length - 1;
  $('player-slider').value = p.index;
}

// ---------- 画笔 ----------
function cellFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * canvas.width);
  const y = Math.floor((ev.clientY - rect.top) / rect.height * canvas.height);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return [x, y];
}

function stamp(cell) {
  const img = state.history.current.image;
  const [cx, cy] = cell;
  const r = state.brush.size;
  let changed = false;
  for (let dy = -r + 1; dy <= r - 1; dy++) {
    for (let dx = -r + 1; dx <= r - 1; dx++) {
      if (dx * dx + dy * dy > (r - 0.5) * (r - 0.5)) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const idx = y * img.width + x;
      const value = state.brush.mode === 'paint' ? 255 : 0;
      if (img.mask[idx] !== value) { img.mask[idx] = value; changed = true; }
    }
  }
  return changed;
}

function lineStamp(a, b) {
  //  Bresenham 连线，避免快速拖动出现断点
  let [x0, y0] = a, [x1, y1] = b;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    stamp([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.image || state.player) return;
  const cell = cellFromEvent(ev);
  if (!cell) return;
  canvas.setPointerCapture(ev.pointerId);
  state.painting = true;
  state.lastPaintCell = cell;
  stamp(cell);
  render();
});

canvas.addEventListener('pointermove', (ev) => {
  if (!state.painting) return;
  const cell = cellFromEvent(ev);
  if (!cell) return;
  lineStamp(state.lastPaintCell, cell);
  state.lastPaintCell = cell;
  render();
});

function endStroke() {
  if (!state.painting) return;
  state.painting = false;
  const cur = state.history.current.image;
  // 当前图已被原地修改；压入快照（再克隆一份作为该条目不可变状态）
  const snapshot = cloneImage(cur);
  state.history.stack[state.history.cursor].image = cloneImage(snapshot);
  state.history.push({
    kind: 'brush',
    label: state.brush.mode === 'paint' ? '画笔：标记保护' : '橡皮：取消保护',
    image: snapshot,
    trace: null,
  });
  state.image = state.history.current.image;
  refreshUndoRedo();
  render();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---------- 目标尺寸校验 ----------
function validateTargets() {
  if (!state.image) return null;
  const w = Number($('target-w').value);
  const h = Number($('target-h').value);
  const errors = [];
  for (const [v, name] of [[w, '宽'], [h, '高']]) {
    if (!Number.isInteger(v) || v < MIN_OUT || v > MAX_OUT) {
      errors.push(`${name}输出须为 ${MIN_OUT}–${MAX_OUT} 的整数`);
    }
  }
  const dw = w - state.image.width, dh = h - state.image.height;
  if (Math.abs(dw) > MAX_DELTA) errors.push(`宽每轴变化最多 ${MAX_DELTA}px（当前 ${dw > 0 ? '+' : ''}${dw}）`);
  if (Math.abs(dh) > MAX_DELTA) errors.push(`高每轴变化最多 ${MAX_DELTA}px（当前 ${dh > 0 ? '+' : ''}${dh}）`);
  const msg = errors.join('；');
  $('run-btn').disabled = !!msg;
  $('validation').textContent = msg || `变化：宽 ${dw >= 0 ? '+' : ''}${dw}px，高 ${dh >= 0 ? '+' : ''}${dh}px`;
  $('validation').dataset.invalid = msg ? 'true' : 'false';
  return msg ? null : { w, h };
}

// ---------- 执行变换 ----------
function runTransform() {
  const t = validateTargets();
  if (!t || !state.image) return;
  const source = state.history.current.image;
  const result = runOperation(source, t.w, t.h, state.order);
  const label = `缩放 ${source.width}×${source.height} → ${result.image.width}×${result.image.height}`;
  state.history.push({
    kind: 'transform',
    label,
    image: result.image,
    trace: result.trace,
    meta: {
      targetW: t.w, targetH: t.h, order: state.order,
      sourceSize: { width: source.width, height: source.height },
      applied: result.applied, requested: result.requested, stopReason: result.stopReason,
      sourceName: state.sourceName, maskName: state.maskName,
    },
  });
  state.image = state.history.current.image;
  refreshUndoRedo();
  // 打开逐步回放
  state.player = {
    frames: buildReplayFrames(source, result.trace),
    index: 0,
    showEnergy: false,
    axis: state.order === 'width-first' ? 'x' : 'y',
  };
  $('player-slider').value = 0;
  if (result.stopReason) {
    setStatus(`提前停止：找不到合法缝线，已保留上一步结果（宽完成 ${result.applied.x}，高完成 ${result.applied.y}）。`, 'warn');
  } else {
    setStatus(`${label} 完成，共 ${result.trace.filter((e) => e.kind !== 'expand-apply').length} 条缝线记录，可用下方播放器逐步查看。`);
  }
  render();
}

// ---------- 撤销重做 ----------
function refreshUndoRedo() {
  $('undo-btn').disabled = !state.history || !state.history.canUndo;
  $('redo-btn').disabled = !state.history || !state.history.canRedo;
  const entry = state.history ? state.history.current : null;
  $('history-label').textContent = entry ? entry.label : '—';
}

function undo() {
  if (!state.history?.canUndo) return;
  state.history.undo();
  state.image = state.history.current.image;
  state.player = null;
  $('player-panel').hidden = true;
  refreshUndoRedo();
  render();
  setStatus(`撤销：${state.history.current.label}`);
}

function redo() {
  if (!state.history?.canRedo) return;
  state.history.redo();
  state.image = state.history.current.image;
  const entry = state.history.current;
  if (entry.kind === 'transform' && entry.trace) {
    state.player = {
      frames: buildReplayFrames(prevImageFor(entry), entry.trace),
      index: 0, showEnergy: false, axis: entry.meta.order === 'width-first' ? 'x' : 'y',
    };
  } else {
    state.player = null;
    $('player-panel').hidden = true;
  }
  refreshUndoRedo();
  render();
  setStatus(`重做：${entry.label}`);
}

function prevImageFor(entry) {
  const idx = state.history.stack.indexOf(entry);
  return state.history.stack[idx - 1].image;
}

// ---------- 导出 ----------
async function exportImage() {
  if (!state.image) return;
  const blob = new Blob([await encodePNG(state.image.width, state.image.height, state.image.rgb, 2)], { type: 'image/png' });
  downloadBlob(blob, `${baseName(state.sourceName)}-retarget-${state.image.width}x${state.image.height}.png`);
  setStatus('已导出结果图像 PNG。');
}

async function exportMask() {
  if (!state.image) return;
  const blob = new Blob([await encodePNG(state.image.width, state.image.height, state.image.mask, 0)], { type: 'image/png' });
  downloadBlob(blob, `${baseName(state.sourceName)}-mask-${state.image.width}x${state.image.height}.png`);
  setStatus('已导出变换后掩膜 PNG。');
}

function buildSeamRecord() {
  const transforms = state.history.stack.filter((e) => e.kind === 'transform');
  return {
    app: 'seam-retarget-workbench',
    spec: '约定.json（线性 RGB 能量 / 最小列平局 / 扩图批次映回）',
    exportedAt: new Date().toISOString(),
    source: {
      image: state.sourceName || null,
      mask: state.maskName || null,
      width: state.history.stack[0].image.width,
      height: state.history.stack[0].image.height,
    },
    final: { width: state.image.width, height: state.image.height },
    operations: transforms.map((entry, opIndex) => ({
      operation: opIndex + 1,
      label: entry.label,
      order: entry.meta.order,
      target: { width: entry.meta.targetW, height: entry.meta.targetH },
      stopReason: entry.meta.stopReason,
      applied: entry.meta.applied,
      events: entry.trace.map((ev) => {
        if (ev.kind === 'shrink') {
          return {
            type: 'shrink', axis: ev.axis, seamIndex: ev.index,
            frame: { width: ev.width, height: ev.height },
            cumulativeCost: ev.cumulative,
            seam: ev.seam.map(([x, y]) => ({ x, y })),
          };
        }
        if (ev.kind === 'expand-discover') {
          return {
            type: 'expand-discover', axis: ev.axis, batch: ev.batch, seamIndex: ev.index,
            workFrame: { width: ev.width, height: ev.height },
            cumulativeCost: ev.cumulative,
            seam: ev.seam.map(([x, y]) => ({ x, y })),
          };
        }
        return {
          type: 'expand-apply', axis: ev.axis, batch: ev.batch,
          batchStart: { width: ev.startWidth, height: ev.startHeight },
          batchEnd: { width: ev.endWidth, height: ev.endHeight },
          requested: ev.requested, found: ev.found, stopReason: ev.stopReason,
          seams: ev.seams.map((seam) => seam.map(([x, y]) => ({ x, y }))),
        };
      }),
    })),
  };
}

function exportRecord() {
  if (!state.image) return;
  const record = buildSeamRecord();
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${baseName(state.sourceName)}-seam-record.json`);
  setStatus('已导出带批次坐标的缝线记录 JSON。若浏览器拦截下载，可用“查看 JSON”复制。');
}

async function copyRecordJson() {
  const json = JSON.stringify(buildSeamRecord(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    setStatus('缝线记录 JSON 已复制到剪贴板。');
  } catch {
    $('json-text').value = json;
    $('json-modal').showModal();
  }
}

// ---------- 事件绑定 ----------
function bind() {
  $('file-image').addEventListener('change', (e) => e.target.files[0] && loadImage(e.target.files[0]));
  $('file-mask').addEventListener('change', (e) => e.target.files[0] && loadMask(e.target.files[0]));
  $('run-btn').addEventListener('click', runTransform);
  $('undo-btn').addEventListener('click', undo);
  $('redo-btn').addEventListener('click', redo);
  $('export-image').addEventListener('click', exportImage);
  $('export-mask').addEventListener('click', exportMask);
  $('export-record').addEventListener('click', exportRecord);
  $('copy-json').addEventListener('click', copyRecordJson);
  $('view-json').addEventListener('click', () => {
    $('json-text').value = JSON.stringify(buildSeamRecord(), null, 2);
    $('json-modal').showModal();
  });
  $('json-close').addEventListener('click', () => $('json-modal').close());

  $('target-w').addEventListener('input', validateTargets);
  $('target-h').addEventListener('input', validateTargets);

  document.querySelectorAll('input[name="order"]').forEach((r) =>
    r.addEventListener('change', () => { state.order = document.querySelector('input[name="order"]:checked').value; }));
  document.querySelectorAll('input[name="brush-mode"]').forEach((r) =>
    r.addEventListener('change', () => { state.brush.mode = document.querySelector('input[name="brush-mode"]:checked').value; }));
  $('brush-size').addEventListener('input', (e) => {
    state.brush.size = Number(e.target.value);
    $('brush-size-val').textContent = e.target.value;
  });
  $('mask-toggle').addEventListener('change', (e) => { state.maskVisible = e.target.checked; render(); });
  $('clear-mask').addEventListener('click', () => {
    if (!state.image) return;
    const cur = state.history.current.image;
    const next = makeImage(cur.width, cur.height, cur.rgb.slice(), new Uint8Array(cur.width * cur.height));
    state.history.push({ kind: 'clear-mask', label: '清空保护掩膜', image: next, trace: null });
    state.image = state.history.current.image;
    state.player = null;
    refreshUndoRedo();
    render();
    setStatus('已清空保护掩膜。');
  });

  $('view-energy').addEventListener('click', (e) => {
    e.target.ariaPressed = e.target.ariaPressed === 'true' ? 'false' : 'true';
    render();
  });
  $('axis-x').addEventListener('click', () => {
    $('axis-x').classList.add('active'); $('axis-y').classList.remove('active'); render();
  });
  $('axis-y').addEventListener('click', () => {
    $('axis-y').classList.add('active'); $('axis-x').classList.remove('active'); render();
  });

  $('player-close').addEventListener('click', () => {
    state.player = null;
    $('player-panel').hidden = true;
    render();
  });
  $('player-prev').addEventListener('click', () => { if (state.player && state.player.index > 0) { state.player.index--; render(); } });
  $('player-next').addEventListener('click', () => {
    if (state.player && state.player.index < state.player.frames.length - 1) { state.player.index++; render(); }
  });
  $('player-slider').addEventListener('input', (e) => { if (state.player) { state.player.index = Number(e.target.value); render(); } });
  $('player-energy').addEventListener('click', (e) => {
    if (!state.player) return;
    state.player.showEnergy = !state.player.showEnergy;
    e.target.ariaPressed = String(state.player.showEnergy);
    render();
  });

  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if (mod && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); }
    else if (state.player && ev.key === 'ArrowLeft') { $('player-prev').click(); }
    else if (state.player && ev.key === 'ArrowRight') { $('player-next').click(); }
  });

  // 样例载入（随页面发布的样例文件）
  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [imgPath, maskPath] = btn.dataset.sample.split('|');
      const dec = await decodePNG(await (await fetch(imgPath)).arrayBuffer());
      const img = makeImage(dec.width, dec.height, dec.data.slice(), new Uint8Array(dec.width * dec.height));
      state.image = img;
      state.sourceName = imgPath.split('/').pop();
      state.maskName = '';
      state.history = new History(img);
      state.player = null;
      $('player-panel').hidden = true;
      $('target-w').value = dec.width;
      $('target-h').value = dec.height;
      if (maskPath) {
        const m = await decodePNG(await (await fetch(maskPath)).arrayBuffer());
        const mask = new Uint8Array(m.width * m.height);
        for (let i = 0; i < mask.length; i++) mask[i] = m.data[i] !== 0 ? 255 : 0;
        img.mask.set(mask);
        state.maskName = maskPath.split('/').pop();
        state.history.push({ kind: 'load-mask', label: `载入样例掩膜 ${state.maskName}`, image: cloneImage(img), trace: null });
      }
      refreshUndoRedo();
      validateTargets();
      render();
      setStatus(`已载入样例 ${state.sourceName}。`);
      document.body.dataset.loadGen = String(Number(document.body.dataset.loadGen || 0) + 1);
    });
  });
}

bind();
setStatus('请载入 8 位 RGB PNG（边长 2–512），或选择一个内置样例开始。');
