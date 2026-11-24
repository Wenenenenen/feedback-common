// app.js — 主应用：导入、编辑、撤销/重做、列统计、逐帧定位、导出
import { parseWav, MAX_SOURCES } from './wav.js';
import { SourcePyramid } from './pyramid.js';
import { Timeline, makeSegment, MAX_SEGMENTS, MAX_COLUMNS, MAX_TOTAL_FRAMES } from './timeline.js';
import { History } from './history.js';
import { buildExport, columnsCSV, timecode } from './exporter.js';
import { setupCanvas, drawSegmentStrip, drawColumns, frameAtX, xOfFrame } from './render.js';
import { TRACK_COLORS_LIGHT, TRACK_COLORS_DARK } from './colors.js';

const $ = (id) => document.getElementById(id);

const state = {
  sources: new Map(),       // id -> { name, frameCount, pyramid }
  timeline: null,
  history: new History(),
  view: { start: 0, end: 0 }, // 当前区间（= 列统计与导出的所选区间）
  B: 1024,
  columns: [],
  cursor: null,             // 单帧定位帧号
  selectedSegment: -1,
  page: 0,
  pageSize: 100,
};

// ---------- 小工具 ----------
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = isError ? 'error' : 'info';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function fmtInt(n) { return n.toLocaleString('en-US'); }

function ensureTimeline() {
  if (!state.timeline) state.timeline = new Timeline(state.sources);
  return state.timeline;
}

// 源 id → 导入序号的 O(1) 索引（渲染身份色用）
function rebuildSourceIndex() {
  const idx = new Map();
  let i = 0;
  for (const id of state.sources.keys()) idx.set(id, i++);
  ensureTimeline()._sourceIndex = idx;
}

// 任何会改段数组/段属性的操作：先快照，再执行，再重建并刷新
function commit(label, fn) {
  const tl = ensureTimeline();
  state.history.push(tl.segments); // 编辑前状态
  try {
    fn(tl);
    tl.rebuild();
  } catch (e) {
    // 执行失败：回滚本次快照
    state.history.undo(tl.segments);
    toast(`${label}失败：${e.message}`, true);
    return;
  }
  state.selectedSegment = -1;
  refresh();
  toast(label);
}

// ---------- 源轨导入 ----------
async function importFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  for (const file of files) {
    if (state.sources.size >= MAX_SOURCES) {
      toast(`最多导入 ${MAX_SOURCES} 条源轨`, true);
      break;
    }
    try {
      const buf = await file.arrayBuffer();
      const wav = parseWav(buf, file.name);
      const id = `S${state.sources.size}`;
      const pyramid = new SourcePyramid(wav.frames, wav.frameCount, file.name);
      state.sources.set(id, { name: file.name, frameCount: wav.frameCount, pyramid });
    } catch (e) {
      toast(`拒绝 ${file.name}：${e.message}`, true);
    }
  }
  ensureTimeline();
  rebuildSourceIndex();
  renderSourceList();
  renderAddOptions();
  refresh();
}

// ---------- 渲染：源轨列表 ----------
function renderSourceList() {
  const el = $('sourceList');
  el.innerHTML = '';
  let i = 0;
  for (const [id, src] of state.sources) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.innerHTML = `
      <span class="swatch" style="background:var(--track-${i})"></span>
      <span class="source-name" title="${src.name}">${src.name}</span>
      <span class="source-meta">${id} · ${fmtInt(src.frameCount)} 帧 · ${(src.frameCount / 48000).toFixed(2)}s</span>`;
    el.appendChild(row);
    i++;
  }
}

function renderAddOptions() {
  const sel = $('addSource');
  sel.innerHTML = '';
  let i = 0;
  for (const [id, src] of state.sources) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${id} ${src.name}（${fmtInt(src.frameCount)} 帧）`;
    sel.appendChild(opt);
    i++;
  }
}

// ---------- 统计与视图 ----------
function refresh() {
  const tl = state.timeline;
  if (!tl) return;
  const total = tl.totalFrames();
  // 视图越界保护（编辑后总长可能缩短）
  state.view.start = Math.min(state.view.start, total);
  state.view.end = Math.min(Math.max(state.view.end, state.view.start), total);
  const n = state.view.end - state.view.start;
  state.columns = n > 0 ? tl.columnStats(state.view.start, n, state.B) : emptyColumns();
  renderAll();
}

function emptyColumns() {
  return Array.from({ length: state.B }, () => ({ start: state.view.start, end: state.view.start, stats: [null, null] }));
}

function renderAll() {
  renderWaveforms();
  renderAggregate();
  renderSegmentTable();
  renderInspector();
  renderHistoryButtons();
  renderViewInfo();
}

// ---------- 画布 ----------
let stripCtx, waveCtx;
let stripCanvas, waveCanvas;

function sizeCanvases() {
  const w = $('canvasWrap').clientWidth;
  stripCanvas = $('stripCanvas');
  waveCanvas = $('waveCanvas');
  stripCtx = setupCanvas(stripCanvas, w, 34);
  waveCtx = setupCanvas(waveCanvas, w, 220);
  renderWaveforms();
}

function renderWaveforms() {
  if (!stripCtx || !state.timeline) return;
  const w = stripCanvas.clientWidth;
  drawSegmentStrip(stripCtx, w, 34, state.timeline, state.view, state.selectedSegment);
  drawColumns(waveCtx, w, 220, state.timeline, state.columns, state.view);
  drawOverlays();
}

// 选区/光标的 DOM 覆盖层（绝对定位，避免在像素画布上画文字）
function drawOverlays() {
  const cursor = $('cursorLine');
  if (!cursor) return;
  const w = waveCanvas.clientWidth;
  const total = state.timeline.totalFrames();
  if (total === 0) { cursor.hidden = true; return; }
  if (state.cursor !== null && state.cursor >= state.view.start && state.cursor < state.view.end) {
    const x = xOfFrame(state.cursor, w, state.view);
    cursor.style.left = `${x}px`;
    cursor.hidden = false;
  } else {
    cursor.hidden = true;
  }
}

// ---------- 区间聚合 ----------
function renderAggregate() {
  const tl = state.timeline;
  const n = state.view.end - state.view.start;
  const stats = n > 0 ? tl.rangeStats(state.view.start, state.view.end) : [null, null];
  const box = $('aggregate');
  const row = (label, st) => {
    if (!st) return `<tr><th>${label}</th><td colspan="4">空区间</td></tr>`;
    return `<tr><th>${label}</th>
      <td>${st.min}</td><td>${st.max}</td>
      <td class="num">${fmtInt(st.count)}</td>
      <td class="num sumsq" title="精确平方和（十进制）">${st.sumSq.toString()}</td></tr>`;
  };
  box.innerHTML = `
    <table>
      <thead><tr><th>声道</th><th>min</th><th>max</th><th>count</th><th>sumSq（精确十进制）</th></tr></thead>
      <tbody>${row('左 L', stats[0])}${row('右 R', stats[1])}</tbody>
    </table>`;
}

// ---------- 单帧定位 ----------
function renderInspector() {
  const el = $('inspector');
  if (state.cursor === null) {
    el.innerHTML = '<p class="muted">点击波形任意位置定位单帧，查看源轨、源帧号与双声道原始值。</p>';
    return;
  }
  const info = state.timeline.inspectFrame(state.cursor);
  if (!info) {
    el.innerHTML = '<p class="muted">该位置没有帧。</p>';
    return;
  }
  el.innerHTML = `
    <dl class="inspect-grid">
      <dt>拼接帧</dt><dd class="num">${fmtInt(info.absFrame)}</dd>
      <dt>时间码</dt><dd class="num">${timecode(info.absFrame)}</dd>
      <dt>所属段</dt><dd>#${info.segmentIndex}</dd>
      <dt>源轨</dt><dd><span class="swatch" style="background:var(--track-${[...state.sources.keys()].indexOf(info.sourceId)})"></span>${info.sourceName}（${info.sourceId}）</dd>
      <dt>源帧号</dt><dd class="num">${fmtInt(info.srcFrame)} ${info.reverse ? '<span class="tag">倒序</span>' : ''} ${info.muted ? '<span class="tag tag-mute">静音</span>' : ''}</dd>
      <dt>左声道值</dt><dd class="num">${info.values[0]}</dd>
      <dt>右声道值</dt><dd class="num">${info.values[1]} <span class="muted">（声道不交换）</span></dd>
    </dl>`;
}

// ---------- 段表 ----------
function renderSegmentTable() {
  const tl = state.timeline;
  const tbody = $('segBody');
  const total = tl.segments.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pages - 1);
  const from = state.page * state.pageSize;
  const rows = tl.segments.slice(from, from + state.pageSize);
  tbody.innerHTML = rows.map((seg, k) => {
    const i = from + k;
    const srcIdx = [...state.sources.keys()].indexOf(seg.sourceId);
    const len = seg.srcEnd - seg.srcStart;
    return `<tr data-index="${i}" class="${i === state.selectedSegment ? 'sel' : ''}">
      <td class="num">${i}</td>
      <td><span class="swatch sm" style="background:var(--track-${srcIdx})"></span>${seg.sourceId}</td>
      <td class="num">${fmtInt(seg.srcStart)}</td>
      <td class="num">${fmtInt(seg.srcEnd)}</td>
      <td class="num">${fmtInt(len)}</td>
      <td class="num">${timecode(tl.offsets[i])}</td>
      <td>${seg.reverse ? '<span class="tag">倒序</span>' : ''}${seg.muted ? '<span class="tag tag-mute">静音</span>' : ''}</td>
    </tr>`;
  }).join('');
  $('segPage').textContent = total === 0 ? '无段' : `第 ${state.page + 1}/${pages} 页 · 共 ${fmtInt(total)} 段（上限 ${fmtInt(MAX_SEGMENTS)}）`;
}

// ---------- 历史按钮 ----------
function renderHistoryButtons() {
  $('btnUndo').disabled = !state.history.canUndo();
  $('btnRedo').disabled = !state.history.canRedo();
}

function renderViewInfo() {
  $('viewStart').value = state.view.start;
  $('viewEnd').value = state.view.end;
  const n = state.view.end - state.view.start;
  $('viewMeta').textContent = `区间 ${fmtInt(state.view.start)}–${fmtInt(state.view.end)} · ${fmtInt(n)} 帧 · B=${state.B} · 总长 ${fmtInt(state.timeline.totalFrames())} 帧`;
}

// ---------- 编辑操作 ----------
function doUndo() {
  const prev = state.history.undo(state.timeline.segments);
  if (prev === null) return;
  state.timeline.segments = prev;
  state.timeline.rebuild();
  state.selectedSegment = -1;
  state.page = 0;
  refresh();
  toast('撤销');
}

function doRedo() {
  const next = state.history.redo(state.timeline.segments);
  if (next === null) return;
  state.timeline.segments = next;
  state.timeline.rebuild();
  state.selectedSegment = -1;
  refresh();
  toast('重做');
}

function addSegment() {
  const sourceId = $('addSource').value;
  const start = parseInt($('addStart').value, 10);
  const end = parseInt($('addEnd').value, 10);
  if (!sourceId) { toast('请先导入源轨', true); return; }
  const cap = state.sources.get(sourceId).frameCount;
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : cap;
  commit('添加段', (tl) => tl.append(makeSegment(sourceId, s, e)));
}

function appendWhole(sourceId) {
  const cap = state.sources.get(sourceId).frameCount;
  commit('整轨添加', (tl) => tl.append(makeSegment(sourceId, 0, cap)));
}

function selectedIndexOrWarn() {
  if (state.selectedSegment < 0) { toast('先在段表或分段条选择一个段', true); return -1; }
  return state.selectedSegment;
}

// 在当前区间起点（无选区则用光标）拆分
function doSplit() {
  const frame = state.cursor ?? state.view.start;
  if (frame <= 0 || frame >= state.timeline.totalFrames()) {
    toast('把光标移到要拆分的帧（不能在首帧/尾边界之外）', true);
    return;
  }
  commit(`在帧 ${fmtInt(frame)} 拆分`, (tl) => tl.splitAt(frame));
}

function bindEditButtons() {
  $('btnSplit').onclick = doSplit;
  $('btnReverse').onclick = () => {
    const i = selectedIndexOrWarn(); if (i < 0) return;
    commit('切换倒序', (tl) => tl.toggleReverse(i));
  };
  $('btnMute').onclick = () => {
    const i = selectedIndexOrWarn(); if (i < 0) return;
    commit('切换静音', (tl) => tl.toggleMute(i));
  };
  $('btnDelete').onclick = () => {
    const i = selectedIndexOrWarn(); if (i < 0) return;
    commit('删除段', (tl) => tl.removeAt(i));
  };
  $('btnMoveLeft').onclick = () => {
    const i = selectedIndexOrWarn(); if (i < 0) return;
    commit('前移一段', (tl) => tl.move(i, i - 1));
  };
  $('btnMoveRight').onclick = () => {
    const i = selectedIndexOrWarn(); if (i < 0) return;
    commit('后移一段', (tl) => tl.move(i, i + 1));
  };
  $('btnUndo').onclick = doUndo;
  $('btnRedo').onclick = doRedo;
}

// ---------- 画布交互：点击定位、拖拽选区 ----------
function bindCanvas() {
  const wrap = $('canvasWrap');
  let dragging = false;
  let dragStart = 0;

  const frameFromEvent = (ev) => {
    const rect = waveCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    return frameAtX(x, rect.width, state.view);
  };

  waveCanvas.addEventListener('pointerdown', (ev) => {
    if (state.timeline.totalFrames() === 0) return;
    dragging = true;
    waveCanvas.setPointerCapture(ev.pointerId);
    dragStart = frameFromEvent(ev);
    state.cursor = dragStart;
    state.view.start = dragStart;
    state.view.end = Math.min(dragStart + 1, state.timeline.totalFrames());
    refresh();
  });

  waveCanvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const f = frameFromEvent(ev);
    // 半开区间：向右 [dragStart, f+1)，向左 [f, dragStart+1)
    state.view.start = Math.min(dragStart, f);
    state.view.end = Math.max(dragStart, f) + 1;
    state.view.end = Math.min(state.view.end, state.timeline.totalFrames());
    if (state.view.end <= state.view.start) state.view.end = state.view.start + 1;
    refresh();
  });

  waveCanvas.addEventListener('pointerup', () => { dragging = false; });

  // 分段条点选段
  stripCanvas.addEventListener('pointerdown', (ev) => {
    const rect = stripCanvas.getBoundingClientRect();
    const f = frameAtX(ev.clientX - rect.left, rect.width, state.view);
    const loc = state.timeline.locate(f);
    if (loc) {
      state.selectedSegment = loc.index;
      state.page = Math.floor(loc.index / state.pageSize);
      renderAll();
    }
  });

  // 悬停 tooltip
  let tip = null;
  const removeTip = () => { if (tip) { tip.remove(); tip = null; } };
  waveCanvas.addEventListener('mousemove', (ev) => {
    const rect = waveCanvas.getBoundingClientRect();
    const f = frameAtX(ev.clientX - rect.left, rect.width, state.view);
    const span = Math.max(1, state.view.end - state.view.start);
    const j = Math.min(state.B - 1, Math.max(0, Math.floor(((f - state.view.start) / span) * state.B)));
    const col = state.columns[j];
    if (!col || col.end === col.start) { removeTip(); return; }
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
    const L = col.stats[0], R = col.stats[1];
    tip.innerHTML = `列 ${j}<br>帧 ${fmtInt(col.start)}–${fmtInt(col.end - 1)}（${fmtInt(col.end - col.start)}）<br>` +
      `L min/max ${L ? L.min : '∅'}/${L ? L.max : '∅'}<br>R min/max ${R ? R.min : '∅'}/${R ? R.max : '∅'}`;
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  });
  waveCanvas.addEventListener('mouseleave', removeTip);
}

// ---------- 视图/B 控件 ----------
function bindControls() {
  $('bRange').addEventListener('input', (e) => {
    state.B = parseInt(e.target.value, 10);
    $('bValue').textContent = state.B;
    refresh();
  });
  $('btnFullView').onclick = () => {
    state.view = { start: 0, end: state.timeline.totalFrames() };
    state.cursor = null;
    refresh();
  };
  $('btnApplyView').onclick = () => {
    const s = Math.max(0, parseInt($('viewStart').value, 10) || 0);
    const e = Math.min(state.timeline.totalFrames(), parseInt($('viewEnd').value, 10) || 0);
    if (e < s) { toast('区间终点不能小于起点', true); return; }
    state.view = { start: s, end: e };
    refresh();
  };
  $('btnAdd').onclick = addSegment;
  $('btnAddWhole').onclick = () => {
    const id = $('addSource').value;
    if (id) appendWhole(id); else toast('请先导入源轨', true);
  };
  $('segBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-index]');
    if (!tr) return;
    state.selectedSegment = parseInt(tr.dataset.index, 10);
    renderAll();
  });
  $('segPrev').onclick = () => { state.page = Math.max(0, state.page - 1); renderSegmentTable(); };
  $('segNext').onclick = () => {
    const pages = Math.ceil(state.timeline.segments.length / state.pageSize);
    state.page = Math.min(pages - 1, state.page + 1);
    renderSegmentTable();
  };
  $('fileInput').addEventListener('change', (e) => importFiles(e.target.files));
  $('btnImport').onclick = () => $('fileInput').click();

  // 主题
  $('themeToggle').onclick = () => {
    const cur = document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wav-theme', next); } catch { /* 忽略 */ }
    renderAll();
  };

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
  });
}

// ---------- 导出 ----------
function bindExport() {
  $('btnExport').onclick = () => {
    const data = buildExport(state.timeline, state.view, state.columns, state.B);
    $('exportJson').textContent = JSON.stringify(data, null, 2);
    $('exportCsv').textContent = columnsCSV(data);
    $('exportModal').hidden = false;
    $('exportJson').dataset.payload = JSON.stringify(data);
    $('exportCsv').dataset.payload = columnsCSV(data);
  };
  $('closeExport').onclick = () => { $('exportModal').hidden = true; };
  const copy = async (target, label) => {
    const text = $(target).dataset.payload;
    try { await navigator.clipboard.writeText(text); toast(`已复制${label}到剪贴板`); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast(`已复制${label}（兼容方式）`);
    }
  };
  $('copyJson').onclick = () => copy('exportJson', ' JSON');
  $('copyCsv').onclick = () => copy('exportCsv', ' CSV');
  // 下载（普通浏览器有效；部分受限查看器会拦截，故同时提供复制）
  const download = (target, filename, mime) => {
    const blob = new Blob([$(target).dataset.payload], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('dlJson').onclick = () => download('exportJson', 'waveform-columns.json', 'application/json');
  $('dlCsv').onclick = () => download('exportCsv', 'waveform-columns.csv', 'text/csv');
}

// ---------- 启动 ----------
async function boot() {
  // 主题
  try {
    const saved = localStorage.getItem('wav-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* 忽略 */ }

  // 注入轨道色 CSS 变量
  const root = document.documentElement;
  TRACK_COLORS_LIGHT.forEach((c, i) => root.style.setProperty(`--track-${i}`, c));
  // 暗色通过 data-theme 覆盖
  const darkStyle = document.createElement('style');
  darkStyle.textContent = `:root[data-theme="dark"]{${TRACK_COLORS_DARK.map((c, i) => `--track-${i}:${c}`).join(';')}}
    @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${TRACK_COLORS_DARK.map((c, i) => `--track-${i}:${c}`).join(';')}}}`;
  document.head.appendChild(darkStyle);

  ensureTimeline();
  sizeCanvases(); // 先初始化画布上下文，bindCanvas 才能拿到 canvas 元素
  new ResizeObserver(sizeCanvases).observe($('canvasWrap'));
  bindEditButtons();
  bindCanvas();
  bindControls();
  bindExport();

  // 尝试载入随页样例，作为可操作的初始状态（失败则停在空状态）
  try {
    const resp = await fetch('samples/wave-edit-source.wav');
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      const wav = parseWav(buf, 'wave-edit-source.wav');
      const id = 'S0';
      state.sources.set(id, { name: 'wave-edit-source.wav', frameCount: wav.frameCount, pyramid: new SourcePyramid(wav.frames, wav.frameCount, wav.name) });
      // 预置三段：正向 / 倒序 / 静音，演示全部能力
      const tl = ensureTimeline();
      const half = Math.floor(wav.frameCount / 2);
      tl.append(makeSegment(id, 0, half));
      tl.append({ ...makeSegment(id, half, wav.frameCount), reverse: true });
      tl.append({ ...makeSegment(id, 1000, 3000), muted: true });
      state.history.undoStack.push([]); // 撤销栈底固定为空轨，可一路撤销回初始状态
      state.view = { start: 0, end: tl.totalFrames() };
      rebuildSourceIndex();
      renderSourceList();
      renderAddOptions();
      refresh();
      toast('已载入样例并预置 正向/倒序/静音 三段，可直接编辑核对');
      return;
    }
  } catch (e) {
    console.warn('样例载入失败', e);
  }
  rebuildSourceIndex();
  renderSourceList();
  renderAddOptions();
  refresh();
}

boot();
