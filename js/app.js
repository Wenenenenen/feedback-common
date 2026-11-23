// 主线程 UI 逻辑：虚拟记录列表、帧播放器、四通道双网格、编辑/撤销/导出
import { STATUS, STATUS_LABEL, oddParity, decodeRecord } from './engine.js';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const ROW_H = 30;
const VIEW_BUF = 8;

const state = {
  loaded: false,
  recordCount: 0,
  totalFrames: 0,
  frame: 0,
  selected: -1,
  filter: '',
  filterHits: null,        // Uint32Array 或 null
  channelState: null,
  undoDepth: 0,
  redoDepth: 0,
  fileName: '',
};

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'), undoBtn: $('undoBtn'), redoBtn: $('redoBtn'),
  selStart: $('selStart'), selEnd: $('selEnd'), exportBtn: $('exportBtn'),
  meta: $('meta'), jumpRecord: $('jumpRecord'), filterText: $('filterText'),
  scroller: $('recordScroller'), spacer: $('recordSpacer'), rows: $('recordRows'),
  detail: $('detail'), channels: $('channels'),
  firstBtn: $('firstBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), lastBtn: $('lastBtn'),
  frameInput: $('frameInput'), frameSlider: $('frameSlider'), frameTotal: $('frameTotal'),
  jumpMs: $('jumpMs'), clock: $('clock'),
  modal: $('structureModal'), structureErrors: $('structureErrors'), closeModal: $('closeModal'),
  toast: $('toast'),
};

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const statusClass = (s) => (['ok', 'bad', 'ignored', 'suppressed'])[s];

// ---------- Worker 通信 ----------
let rpcId = 0;
const pending = new Map();
worker.addEventListener('message', (e) => {
  const d = e.data;
  if (d.type === 'error') { toast('错误：' + d.message); return; }
  const resolver = pending.get(d.reqId);
  if (resolver) { pending.delete(d.reqId); resolver(d); }
});
function call(msg) {
  const reqId = ++rpcId;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    worker.postMessage({ ...msg, reqId });
  });
}

// ---------- 虚拟列表 ----------
function visibleCount() {
  return state.filterHits ? state.filterHits.length : state.recordCount;
}

function renderRows(batch) {
  const total = visibleCount();
  els.spacer.style.height = `${total * ROW_H}px`;
  const frag = document.createDocumentFragment();
  batch.rows.forEach((r, k) => {
    const div = document.createElement('div');
    div.className = 'record-row' + (r.i === state.selected ? ' selected' : '');
    div.style.position = 'absolute';
    div.style.top = `${(batch.logicalStart + k) * ROW_H}px`;
    div.style.left = '0';
    div.style.right = '0';
    div.dataset.index = r.i;
    const pa = r.parityA ? 'parity-ok' : 'parity-bad';
    const pb = r.parityB ? 'parity-ok' : 'parity-bad';
    div.innerHTML = `
      <span style="width:72px" class="mono">#${r.i}</span>
      <span style="width:72px" class="mono">${r.frame}</span>
      <span style="width:44px" class="mono">${r.field}</span>
      <span style="width:96px" class="mono"><span class="${pa}">${hex2(r.rawA)}</span> <span class="${pb}">${hex2(r.rawB)}</span></span>
      <span style="width:84px"><span class="badge ${statusClass(r.status)}">${STATUS_LABEL[r.status]}</span></span>
      <span class="mono" style="overflow:hidden;text-overflow:ellipsis">${r.label}</span>`;
    div.addEventListener('click', () => selectRecord(r.i));
    frag.appendChild(div);
  });
  els.rows.innerHTML = '';
  els.rows.appendChild(frag);
}

let windowSeq = 0;
let filterGen = 0;
async function requestWindow(logicalStart) {
  const seq = ++windowSeq;
  const gen = filterGen;
  const count = Math.ceil(els.scroller.clientHeight / ROW_H) + VIEW_BUF * 2;
  let res;
  if (state.filterHits) {
    const total = state.filterHits.length;
    const end = Math.min(logicalStart + count, total);
    const first = state.filterHits[logicalStart];
    const last = state.filterHits[end - 1];
    res = await call({ type: 'window', start: first, count: last - first + 1 });
    if (seq !== windowSeq || gen !== filterGen) return;
    const wanted = new Set(state.filterHits.subarray(logicalStart, end));
    res.rows = res.rows.filter((r) => wanted.has(r.i));
    res.logicalStart = logicalStart;
  } else {
    res = await call({ type: 'window', start: logicalStart, count });
    if (seq !== windowSeq || gen !== filterGen) return;
    res.logicalStart = logicalStart;
  }
  renderRows(res);
}

els.scroller.addEventListener('scroll', () => {
  const top = Math.max(0, Math.floor(els.scroller.scrollTop / ROW_H) - VIEW_BUF);
  requestWindow(top);
});

// ---------- 过滤 ----------
function applyFilter(text) {
  state.filter = text.trim();
  filterGen++;
  if (!state.loaded) return;
  if (!state.filter) { state.filterHits = null; }
  else {
    const kw = state.filter.toLowerCase();
    const hits = [];
    // 过滤需要扫状态标签；用 worker 窗口全量取代价高，改为在主线程按块扫描
    const block = 50000;
    const scan = (from) => new Promise((resolve) => {
      const step = (pos) => {
        if (pos >= state.recordCount) { resolve(); return; }
        call({ type: 'window', start: pos, count: Math.min(block, state.recordCount - pos) }).then((res) => {
          for (const r of res.rows) {
            const hay = `${STATUS_LABEL[r.status]} ${r.label} ${r.frame} ${r.field}`.toLowerCase();
            if (hay.includes(kw)) hits.push(r.i);
          }
          step(pos + block);
        });
      };
      step(from);
    });
    scan(0).then(() => {
      state.filterHits = new Uint32Array(hits);
      els.scroller.scrollTop = 0;
      requestWindow(0);
      toast(`筛选命中 ${hits.length} 条`);
    });
    return;
  }
  els.scroller.scrollTop = 0;
  requestWindow(0);
}
els.filterText.addEventListener('input', (e) => applyFilter(e.target.value));

// ---------- 记录详情与编辑 ----------
async function selectRecord(index) {
  state.selected = index;
  document.querySelectorAll('.record-row').forEach((d) => {
    d.classList.toggle('selected', Number(d.dataset.index) === index);
  });
  const [win] = await Promise.all([call({ type: 'window', start: index, count: 1 })]);
  const r = win.rows[0];
  const byteOffset = 12 + index * 8;
  const lowA = r.rawA & 0x7f;
  const lowB = r.rawB & 0x7f;
  const decoded = decodeRecord(r.rawA, r.rawB, r.status);
  const reasons = explainRecord(r);
  els.detail.innerHTML = `
    <h3>记录 #${r.i} <span class="badge ${statusClass(r.status)}">${STATUS_LABEL[r.status]}</span></h3>
    <div class="kv">
      <span class="k">源帧 / 场</span><span class="mono">帧 ${r.frame}，场 ${r.field}（${r.field === 1 ? 'CC1/CC2' : 'CC3/CC4'}）</span>
      <span class="k">字节偏移</span><span class="mono">0x${byteOffset.toString(16)}（${byteOffset}），A@+5 B@+6</span>
      <span class="k">原字节</span><span class="mono">A=${hex2(r.rawA)} B=${hex2(r.rawB)}（保留字节=00）</span>
      <span class="k">低 7 位</span><span class="mono">A=${hex2(lowA)} B=${hex2(lowB)}</span>
      <span class="k">奇校验</span><span>A ${r.parityA ? '✓ 正确' : '✗ 错误'}，B ${r.parityB ? '✓ 正确' : '✗ 错误'}</span>
      <span class="k">解码</span><span>${r.label}</span>
      <span class="k">目标通道</span><span>${decoded.channel === null ? '—（文本走场当前通道）' : `该场第 ${decoded.channel + 1} 通道`}</span>
    </div>
    <div><strong>执行/跳过原因</strong>
      <ul class="reason-list">${reasons.map((x) => `<li>${x}</li>`).join('')}</ul>
    </div>
    <div class="byte-editor">
      <label>新字节 A（hex）<input id="newA" maxlength="2" value="${hex2(r.rawA)}"></label>
      <label>新字节 B（hex）<input id="newB" maxlength="2" value="${hex2(r.rawB)}"></label>
      <label><input id="fixParity" type="checkbox" checked> 自动奇校验</label>
      <button id="applyEdit">应用修改</button>
      <span class="hint">只改 A/B 两字节，结构不变；修改后整稿重新演算，可撤销/重做</span>
    </div>`;
  $('applyEdit').addEventListener('click', () => applyEdit(index));
}

function explainRecord(r) {
  const out = [];
  if (!r.parityA || !r.parityB) {
    out.push(`字节 ${!r.parityA ? 'A' : ''}${!r.parityA && !r.parityB ? '、' : ''}${!r.parityB ? 'B' : ''} 奇校验失败：整对丢弃，不改变任何通道状态，并打断本场控制重复检测。`);
    return out;
  }
  switch (r.status) {
    case STATUS.SUPPRESSED:
      out.push('控制/PAC 与本场上一帧刚执行的字节对完全相同：按场成对抑制，本条不执行，重复候选同时清除。另一场不参与判定。');
      break;
    case STATUS.IGNORED:
      out.push('字节对不在文本集，也不是约定支持的控制/PAC（或 PAC 行号 index=0）：记为忽略，并打断本场控制重复检测。');
      break;
    case STATUS.OK:
      if (r.kind === 'text') out.push('两字节均在文本集（00 空操作 / 20 空格 / 41–5A 大写字母）：按顺序写入当前通道目标网格，写后游标右移，列 32 饱和覆盖。');
      else if (r.kind === 'control') out.push('支持的控制码：已执行；A 位 3 选定本场第一/第二通道，执行后该通道成为本场当前通道，并登记为重复候选。');
      else if (r.kind === 'pac') out.push('支持的 PAC：按 2×(A 低3位)+(B 位5) 查行号表定位，B 位 4 决定列；滚动模式下改基行并按相对偏移搬迁窗口内容。');
      break;
  }
  return out;
}

async function applyEdit(index) {
  let a = parseInt($('newA').value, 16);
  let b = parseInt($('newB').value, 16);
  if (Number.isNaN(a) || Number.isNaN(b) || a < 0 || a > 255 || b < 0 || b > 255) {
    toast('请输入 00–FF 的十六进制字节'); return;
  }
  if ($('fixParity').checked) {
    a = oddParity(a & 0x7f);
    b = oddParity(b & 0x7f);
  }
  const res = await call({ type: 'edit', index, newA: a, newB: b });
  if (!res.result.ok) { showStructure(res.result.errors); return; }
  handleReload(res.result, res);
  toast(`记录 #${index} 字节改为 ${hex2(a)} ${hex2(b)}，已重新演算`);
  selectRecord(index);
}

// ---------- 撤销/重做 ----------
els.undoBtn.addEventListener('click', async () => {
  const res = await call({ type: 'undo' });
  if (res.ok) { handleReload(res.result, res); toast('已撤销'); if (state.selected >= 0) selectRecord(state.selected); }
});
els.redoBtn.addEventListener('click', async () => {
  const res = await call({ type: 'redo' });
  if (res.ok) { handleReload(res.result, res); toast('已重做'); if (state.selected >= 0) selectRecord(state.selected); }
});

function handleReload(result, hist) {
  state.recordCount = result.recordCount;
  state.totalFrames = result.totalFrames;
  state.undoDepth = hist.undoDepth ?? state.undoDepth;
  state.redoDepth = hist.redoDepth ?? state.redoDepth;
  state.filterHits = null; els.filterText.value = ''; filterGen++;
  updateMeta();
  els.scroller.scrollTop = 0;
  requestWindow(0);
  jump(state.frame, true);
  els.undoBtn.disabled = state.undoDepth === 0;
  els.redoBtn.disabled = state.redoDepth === 0;
}

// ---------- 文件加载 ----------
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.fileName = file.name;
  const buf = await file.arrayBuffer();
  const res = await call({ type: 'load', buffer: buf });
  if (!res.ok) { showStructure(res.errors); return; }
  state.loaded = true;
  state.recordCount = res.recordCount;
  state.totalFrames = res.totalFrames;
  state.frame = 0; state.selected = -1;
  state.undoDepth = 0; state.redoDepth = 0;
  updateMeta();
  els.frameSlider.max = String(Math.max(0, state.totalFrames - 1));
  els.frameInput.max = String(state.totalFrames);
  els.frameTotal.textContent = `/ ${state.totalFrames}`;
  els.selEnd.value = String(state.totalFrames);
  els.selStart.max = String(state.totalFrames);
  els.selEnd.max = String(state.totalFrames);
  els.exportBtn.disabled = false;
  els.undoBtn.disabled = true; els.redoBtn.disabled = true;
  els.scroller.scrollTop = 0;
  requestWindow(0);
  jump(0, true);
  toast(`已加载 ${file.name}：${res.recordCount.toLocaleString()} 条 / ${res.totalFrames.toLocaleString()} 帧`);
});

function showStructure(errors) {
  els.structureErrors.textContent = errors.map((x) => `字节偏移 ${x.offset}（0x${x.offset.toString(16)}）：${x.message}`).join('\n');
  els.modal.hidden = false;
}
els.closeModal.addEventListener('click', () => { els.modal.hidden = true; });

function updateMeta() {
  els.meta.textContent = state.loaded
    ? `${state.fileName} · ${state.recordCount.toLocaleString()} 条记录 · ${state.totalFrames.toLocaleString()} 帧 · 30000/1001 fps`
    : '';
}

// ---------- 帧播放器 ----------
async function jump(frame, force = false) {
  if (!state.loaded) return;
  const F = Math.max(0, Math.min(state.totalFrames, frame | 0));
  if (!force && F === state.frame) return;
  state.frame = F;
  els.frameInput.value = String(F);
  els.frameSlider.value = String(Math.min(F, state.totalFrames - 1));
  const res = await call({ type: 'jump', frame: F });
  state.channelState = res.state;
  els.jumpMs.textContent = `${res.ms.toFixed(1)} ms`;
  renderClock(F);
  renderChannels();
}

function renderClock(frame) {
  const seconds = frame * 1001 / 30000;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  els.clock.textContent = `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

els.firstBtn.addEventListener('click', () => jump(0));
els.prevBtn.addEventListener('click', () => jump(state.frame - 1));
els.nextBtn.addEventListener('click', () => jump(state.frame + 1));
els.lastBtn.addEventListener('click', () => jump(state.totalFrames));
els.frameInput.addEventListener('change', () => jump(Number(els.frameInput.value)));
els.frameSlider.addEventListener('input', () => jump(Number(els.frameSlider.value)));
els.jumpRecord.addEventListener('change', async () => {
  const idx = Number(els.jumpRecord.value);
  if (Number.isInteger(idx) && idx >= 0 && idx < state.recordCount) {
    selectRecord(idx);
    const res = await call({ type: 'frameAtRecord', index: idx });
    jump(res.frame);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') jump(state.frame - 1);
  if (e.key === 'ArrowRight') jump(state.frame + 1);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) els.undoBtn.click();
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) els.redoBtn.click();
});

// ---------- 四通道双网格渲染（结构只建一次，跳帧增量更新单元格）----------
const MODE_LABEL = { pop: '弹出', paint: '直写', roll: '滚动' };
const gridRefs = []; // [{ modeEl, posEl, blocks:[{cells:[480]}] }]

function buildChannelScaffold() {
  els.channels.innerHTML = '';
  gridRefs.length = 0;
  for (let c = 0; c < 4; c++) {
    const card = document.createElement('div');
    card.className = 'channel-card';
    card.innerHTML = `
      <div class="channel-head">
        CC${c + 1}
        <span class="mode"></span>
        <span class="pos"></span>
      </div>
      <div class="grid-wrap">
        <div class="grid-block">
          <div class="grid-title">显示网格（上屏）</div>
          <div class="grid"></div>
        </div>
        <div class="grid-block">
          <div class="grid-title">后备网格（弹出写入）</div>
          <div class="grid"></div>
        </div>
      </div>`;
    const gridEls = card.querySelectorAll('.grid');
    const blocks = [...gridEls].map((gel) => {
      const cells = [];
      const corner = document.createElement('div');
      corner.className = 'gcorner';
      gel.appendChild(corner);
      for (let col = 1; col <= 32; col++) {
        const h = document.createElement('div');
        h.className = 'gcorner';
        h.textContent = String(col);
        gel.appendChild(h);
      }
      for (let row = 1; row <= 15; row++) {
        const lab = document.createElement('div');
        lab.className = 'rlabel';
        lab.textContent = String(row);
        gel.appendChild(lab);
        for (let col = 1; col <= 32; col++) {
          const cell = document.createElement('div');
          cell.className = 'cell';
          cell.title = `${row}行${col}列`;
          gel.appendChild(cell);
          cells.push(cell);
        }
      }
      return { cells };
    });
    els.channels.appendChild(card);
    gridRefs.push({
      modeEl: card.querySelector('.mode'),
      posEl: card.querySelector('.pos'),
      blocks,
    });
  }
}

function paintGrid(cells, grid, cursorIndex) {
  for (let k = 0; k < 480; k++) {
    const v = grid[k];
    const cell = cells[k];
    const wantText = v === 0 ? '·' : (v === 0x20 ? '␠' : String.fromCharCode(v));
    if (cell.textContent !== wantText) cell.textContent = wantText;
    cell.classList.toggle('on', v !== 0);
    cell.classList.toggle('cursor', k === cursorIndex);
  }
}

function renderChannels() {
  const st = state.channelState;
  if (!st) return;
  if (!gridRefs.length) buildChannelScaffold();
  for (let c = 0; c < 4; c++) {
    const ch = st.channels[c];
    const ref = gridRefs[c];
    const rollInfo = ch.mode === 'roll' ? `，${ch.rollRows} 行窗，基行 ${ch.baseRow}` : '';
    ref.modeEl.textContent = `${MODE_LABEL[ch.mode]}${rollInfo}`;
    ref.posEl.textContent = `游标 ${ch.curRow}行${ch.curCol}列`;
    const cursorIndex = (ch.curRow - 1) * 32 + (ch.curCol - 1);
    paintGrid(ref.blocks[0].cells, ch.display, cursorIndex);
    paintGrid(ref.blocks[1].cells, ch.back, cursorIndex);
  }
}

// ---------- 选区导出 ----------
els.exportBtn.addEventListener('click', async () => {
  const start = Math.max(0, Number(els.selStart.value) | 0);
  const end = Math.min(state.totalFrames, Number(els.selEnd.value) | 0);
  if (!(end > start)) { toast('选区需满足 start < end'); return; }
  const res = await call({ type: 'export', start, end });
  const out = res.json;
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.fileName.replace(/\.l21p$/i, '') || 'export'}-[${start},${end}).json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${out.cues.length} 个 cue（半开源帧号，按 start/通道排序）`);
});
