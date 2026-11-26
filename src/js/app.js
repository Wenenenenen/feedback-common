// 主线程：导入、渲染扇区 / 单帧 / 块表 / 坏区编辑、导出。
// 计算在 engine.js（Worker 池）里进行；本文件只管 DOM 与状态机。

import { Engine } from './engine.js';
import * as Core from './core.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const S = {
  engine: null,
  result: null,
  view: 'sector',
  sector: 0,
  frame: 0,
  copySel: 0,
  badRead: 0,
  badChannel: 0,
  busy: false,
  phase: 'idle', // idle | loading | loaded | computed | nosolution
  loadSeq: 0,    // 每次开始导入自增，供自动化与调试判断“这次导入已完成”
  lastWarn: '',
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const fmt = (n) => n.toLocaleString('zh-CN');
const pct = (a, b) => (b ? (a / b) * 100 : 0).toFixed(2) + '%';
const secs = (ms) => (ms / 1000).toFixed(2) + ' s';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function setStatus(msg, kind = '') {
  const line = $('status-line');
  $('status-msg').textContent = msg;
  line.classList.toggle('err', kind === 'err');
}

function setMeta(msg) {
  $('status-meta').textContent = msg;
}

function showBusy(text) {
  S.busy = true;
  $('busy-text').textContent = text;
  $('busy').classList.remove('hidden');
  $('btn-run').disabled = true;
}

function hideBusy() {
  S.busy = false;
  $('busy').classList.add('hidden');
  updateRunEnabled();
}

function updateRunEnabled() {
  $('btn-run').disabled = S.busy || !S.engine;
}

function showImportError(msg) {
  const box = $('import-error');
  box.textContent = msg;
  box.classList.remove('hidden');
  $('empty-state').classList.remove('hidden');
  $('workspace').classList.add('hidden');
}

function clearImportError() {
  $('import-error').classList.add('hidden');
  $('import-error').textContent = '';
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

async function loadZipBytes(bytes, sourceName) {
  clearImportError();
  S.loadSeq += 1;
  S.phase = 'loading';
  showBusy('解析压缩包…');
  try {
    if (S.engine) S.engine.dispose();
    S.engine = null;
    // 4 线程是题面机器（四核）的上限；实际 Worker 数还会被硬件并发数压一次
    const engine = await Engine.load(bytes, { parallel: true, workers: 4 });
    S.engine = engine;
    S.result = null;
    S.phase = 'loaded';
    S.view = 'sector';
    S.sector = 0;
    S.frame = 0;
    S.copySel = 0;
    S.badRead = 0;
    S.badChannel = 0;
    $('empty-state').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('nosolution').classList.add('hidden');
    $('summary').classList.add('hidden');
    $('toolbar-wrap').classList.remove('hidden');
    $('view-sector').classList.remove('hidden');
    $('view-frame').classList.remove('hidden');
    setView('sector');
    setStatus(`已载入${sourceName ? '「' + sourceName + '」' : ''}：1 份基准 + ${engine.project.copies.length} 份副本。点「开始校对」。`, '');
    setMeta(`基准 ${fmt(engine.project.anchor.frames)} 帧 · 载入 ${secs(engine.loadMs)}`);
    buildReadSelectors();
    renderBadEditor();
    renderBlocks();
    updateExportButtons();
    updateRunEnabled();
    hideBusy();
  } catch (err) {
    hideBusy();
    if (S.engine) { S.engine.dispose(); S.engine = null; }
    showImportError(err && err.message ? err.message : String(err));
    setStatus('导入失败。', 'err');
  }
}

function executorLabel() {
  if (!S.engine) return '未载入';
  if (!S.engine.executor) {
    return typeof SharedArrayBuffer === 'function' ? '待首次校对（可多线程）' : '单线程（缺 SharedArrayBuffer）';
  }
  return S.engine.executor.mode;
}

async function loadFile(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    await loadZipBytes(new Uint8Array(buf), file.name);
  } catch (err) {
    hideBusy();
    showImportError('读取文件失败：' + (err && err.message ? err.message : err));
  }
}

async function loadSample() {
  clearImportError();
  showBusy('载入样例…');
  try {
    const res = await fetch('samples/disc-consensus.zip', { cache: 'no-store' });
    if (!res.ok) throw new Error(`样例下载失败（HTTP ${res.status}）`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await loadZipBytes(bytes, '自带样例');
  } catch (err) {
    hideBusy();
    showImportError('载入样例失败：' + (err && err.message ? err.message : err));
  }
}

// ---------------------------------------------------------------------------
// 校对
// ---------------------------------------------------------------------------

async function runAlign() {
  if (!S.engine || S.busy) return;
  showBusy('对齐与投票…');
  setStatus('正在对齐各副本并逐帧投票…');
  const t0 = performance.now();
  try {
    // 让浏览器先绘制忙碌层
    await new Promise((r) => setTimeout(r, 16));
    const res = await S.engine.compute();
    S.result = res;
    if (!res.ok && res.reason === 'nosolution') {
      S.phase = 'nosolution';
      renderNoSolution(res);
      setStatus('无法排出可行偏移；本次不生成交付文件。', 'err');
    } else {
      S.phase = 'computed';
      $('nosolution').classList.add('hidden');
      $('toolbar-wrap').classList.remove('hidden');
      setView(S.view);
      renderAll();
      const t = S.engine.timings;
      setStatus(`完成：${fmt(res.frames)} 帧合议，${fmt(res.stats.disputes)} 个声道帧争议。用时 ${secs(t.total)}（评分 ${secs(t.score)} · 对齐 ${secs(t.dp)} · 投票 ${secs(t.vote)}）。`);
    }
    setMeta(`前端总耗时 ${secs(performance.now() - t0)}（含渲染）· 并行：${executorLabel()}`);
    updateExportButtons();
  } catch (err) {
    setStatus('计算出错：' + (err && err.message ? err.message : err), 'err');
    console.error(err);
  } finally {
    hideBusy();
  }
}

function updateExportButtons() {
  const ready = S.phase === 'computed' && S.result && S.result.ok;
  $('btn-export-wav').disabled = !ready;
  $('btn-export-csv').disabled = !ready;
  $('btn-export-align').disabled = !ready;
}

// ---------------------------------------------------------------------------
// 渲染：无解
// ---------------------------------------------------------------------------

function renderNoSolution(res) {
  $('summary').classList.add('hidden');
  $('nosolution').classList.remove('hidden');
  // 没有可展示的扇区/单帧结果，隐藏对应区域（块偏移与坏区编辑仍留着定位）
  $('toolbar-wrap').classList.add('hidden');
  $('view-sector').classList.add('hidden');
  $('view-frame').classList.add('hidden');
  // 坏区编辑器预填失败块的源区间，方便据此放宽
  const b = res.block;
  $('bad-read').value = String(res.copyIndex + 1);
  S.badRead = res.copyIndex + 1;
  S.badChannel = 0;
  $('bad-channel').value = '0';
  $('bad-start').value = String(b.src);
  $('bad-end').value = String(b.src + b.len);
  renderBadEditor();
  $('nosolution-msg').textContent =
    `${res.copyLabel}（${res.copyFile}）的第 ${res.blockIndex + 1} 块无法排下：` +
    `源起帧 ${fmt(b.src)}、名义盘面起帧 ${fmt(b.nom)}、长 ${fmt(b.len)} 帧。` +
    `即使按相邻块不重叠的约束取最靠前的可行位置，也排不进这一块。`;
  // 仍显示块表与坏区编辑，便于定位
  renderBlocks();
  updateExportButtons();
}

// ---------------------------------------------------------------------------
// 渲染：全部
// ---------------------------------------------------------------------------

function renderAll() {
  if (!S.result || !S.result.ok) return;
  const r = S.result;
  $('summary').classList.remove('hidden');
  $('sum-frames').textContent = fmt(r.frames);
  $('sum-frames-sub').textContent = '×2 声道';
  $('sum-reads').textContent = String(S.engine.project.copies.length + 1);
  $('sum-disputes').textContent = fmt(r.stats.disputes);
  $('sum-disputes-sub').textContent = pct(r.stats.disputes, r.stats.channelFrames) + ' / 全部声道帧';
  $('sum-gaps').textContent = `${fmt(r.stats.gapL)} / ${fmt(r.stats.gapR)}`;
  let scoreSum = 0;
  for (const c of r.copies) scoreSum += c.total;
  $('sum-score').textContent = fmt(scoreSum);
  $('sum-time').textContent = secs(r.timings.total);
  $('sum-time-sub').textContent = '对齐 + 投票 + 导出准备';

  S.sector = clamp(S.sector, 0, r.sector.sectors - 1);
  S.frame = clamp(S.frame, 0, r.frames - 1);
  buildSectorStrip();
  renderSectorView();
  renderFrameView();
  renderBlocks();
}

// ---------------------------------------------------------------------------
// 渲染：扇区
// ---------------------------------------------------------------------------

// 扇区总览用 canvas 绘制：整盘一次画完，几万个扇区也不会卡住 DOM。
// 颜色只有四种状态，取 CSS 变量的实际值，深浅色主题切换后重绘。
function sectorPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name) => cs.getPropertyValue(name).trim();
  return {
    adopt: pick('--adopt') || '#84b9f3',
    nomaj: pick('--no-majority') || '#dc3c3d',
    insuf: pick('--insufficient') || '#f2a600',
    gap: pick('--gap') || '#9aa0a6',
    grid: pick('--surface-2') || '#f2f3f5',
    cursor: pick('--accent') || '#257de0',
    text: pick('--text-2') || '#666',
    surface: pick('--surface-1') || '#fff',
  };
}

function sectorBadCount(s) {
  const r = S.result;
  let bad = 0;
  for (let k = 1; k < 4; k++) bad += r.sector.countsL[s * 4 + k] + r.sector.countsR[s * 4 + k];
  return bad;
}

function sectorTitle(s) {
  const r = S.result;
  const start = s * Core.SECTOR_FRAMES;
  const end = Math.min(r.frames, start + Core.SECTOR_FRAMES);
  return `扇区 ${s + 1}：帧 ${fmt(start)}–${fmt(end - 1)}，未采用 ${fmt(sectorBadCount(s))} 声道帧`;
}

/**
 * 重画扇区总览：一条“争议脊线”。
 * 扇区数常远大于画布像素宽（90 秒就有 6750 个扇区 / 约 1300 像素），
 * 所以按输出像素列聚合，取该列内最严重的一个扇区来定高定色，
 * 否则零星的单扇区争议会被平均掉。没有争议的列只留基线，问题一眼可见。
 */
function paintSectorCanvas() {
  const r = S.result;
  const cv = $('sector-canvas');
  if (!r || !r.ok) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = cv.clientWidth || 800;
  const cssH = cv.clientHeight || 76;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const ctx = cv.getContext('2d');
  const P = sectorPalette();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = P.grid;
  ctx.fillRect(0, 0, cssW, cssH);

  const { sectors, countsL, countsR } = r.sector;
  const colW = Math.max(1, Math.floor(cssW));
  const baseH = 3;
  const usableH = cssH - baseH;

  const colAt = (x) => Math.min(sectors - 1, Math.floor((x * sectors) / colW));

  // 逐列取“该列覆盖扇区里最严重的那个”
  const fracCol = new Float32Array(colW);
  const colorCol = new Array(colW);
  const selCol = new Int32Array(colW).fill(-1);
  let peak = 0;
  for (let x = 0; x < colW; x++) {
    const a = colAt(x);
    const b = x + 1 < colW ? colAt(x + 1) : sectors;
    let bestFrac = 0;
    let bestColor = null;
    for (let s = a; s < b; s++) {
      const l = s * 4;
      let tot = 0;
      let bad = 0;
      for (let k = 0; k < 4; k++) tot += countsL[l + k] + countsR[l + k];
      for (let k = 1; k < 4; k++) bad += countsL[l + k] + countsR[l + k];
      if (s === S.sector) selCol[x] = s;
      if (!bad) continue;
      const frac = tot ? bad / tot : 0;
      if (frac >= bestFrac) {
        bestFrac = frac;
        bestColor = (countsL[l + 3] + countsR[l + 3]) > 0 ? P.gap
          : (countsL[l + 1] + countsR[l + 1]) > 0 ? P.nomaj : P.insuf;
      }
    }
    fracCol[x] = bestFrac;
    colorCol[x] = bestColor;
    if (bestFrac > peak) peak = bestFrac;
  }
  const scale = peak > 0 ? usableH / Math.sqrt(peak) : 1;

  ctx.fillStyle = P.adopt;
  ctx.fillRect(0, cssH - baseH, cssW, baseH);
  for (let x = 0; x < colW; x++) {
    if (!colorCol[x]) continue;
    // 最小可见高度 = 可用高度的 14%，让零星争议也能看见
    const h = baseH + Math.max(usableH * 0.14, Math.min(usableH, Math.sqrt(fracCol[x]) * scale));
    ctx.fillStyle = colorCol[x];
    ctx.fillRect(x, cssH - h, 1, h);
  }

  // 选中扇区：找到它所在的列
  let selX = -1;
  for (let x = 0; x < colW; x++) if (selCol[x] >= 0) { selX = x + 0.5; break; }
  if (selX < 0) selX = ((S.sector + 0.5) / sectors) * cssW;
  ctx.fillStyle = P.surface;
  ctx.fillRect(selX - 1.5, 0, 3, cssH);
  ctx.fillStyle = P.cursor;
  ctx.fillRect(selX - 0.75, 0, 1.5, cssH);
  ctx.beginPath();
  ctx.moveTo(selX - 4, 0);
  ctx.lineTo(selX + 4, 0);
  ctx.lineTo(selX, 6);
  ctx.closePath();
  ctx.fill();

  cv.dataset.sectors = String(sectors);
  cv.dataset.peak = peak.toFixed(4);
}

function buildSectorStrip() {
  const r = S.result;
  if (!r || !r.ok) return;
  updateSectorNav();
  paintSectorCanvas();
}

function updateSectorNav() {
  const r = S.result;
  if (!r || !r.ok) return;
  $('sector-total').textContent = `/ ${fmt(r.sector.sectors)} 扇区`;
  $('sector-input').max = String(r.sector.sectors);
  if (document.activeElement !== $('sector-input')) $('sector-input').value = String(S.sector + 1);
}

function selectSector(s) {
  if (!S.result || !S.result.ok) return;
  S.sector = clamp(s, 0, S.result.sector.sectors - 1);
  updateSectorNav();
  paintSectorCanvas();
  renderSectorView();
}

/** 扇区号 → 画布 x（0..1）。 */
function sectorFromEvent(ev, cv) {
  const rect = cv.getBoundingClientRect();
  const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 0.9999);
  return Math.floor(ratio * S.result.sector.sectors);
}

function showSectorTip(ev, s) {
  const tip = $('sector-tip');
  const cv = $('sector-canvas');
  const rect = cv.getBoundingClientRect();
  const wrapRect = cv.parentElement.getBoundingClientRect();
  tip.textContent = '';
  const rows = [
    ['扇区', String(s + 1)],
    ['帧', `${fmt(s * Core.SECTOR_FRAMES)}–${fmt(Math.min(S.result.frames, (s + 1) * Core.SECTOR_FRAMES) - 1)}`],
  ];
  const r = S.result;
  const names = [['采用', 0], ['未过半', 1], ['票数不足', 2], ['缺口', 3]];
  let framesInSector = 0;
  let bad = 0;
  for (let k = 0; k < 4; k++) {
    const n = r.sector.countsL[s * 4 + k] + r.sector.countsR[s * 4 + k];
    framesInSector += n;
    if (k) bad += n;
  }
  rows.push(['争议比例', framesInSector ? pct(bad, framesInSector) : '—']);
  for (const [label, k] of names) {
    const n = r.sector.countsL[s * 4 + k] + r.sector.countsR[s * 4 + k];
    if (n) rows.push([label, fmt(n)]);
  }
  for (const [k, v] of rows) {
    const row = el('div', 'st-row');
    row.appendChild(el('span', '', k));
    row.appendChild(el('b', '', v));
    tip.appendChild(row);
  }
  tip.classList.remove('hidden');
  const x = clamp(ev.clientX - wrapRect.left, 40, wrapRect.width - 40);
  tip.style.left = x + 'px';
  tip.style.top = '2px';
}

function hideSectorTip() {
  $('sector-tip').classList.add('hidden');
}

function renderSectorView() {
  const r = S.result;
  if (!r || !r.ok) return;
  const s = S.sector;
  const start = s * Core.SECTOR_FRAMES;
  const end = Math.min(r.frames, start + Core.SECTOR_FRAMES);
  $('sector-title').textContent = `扇区 ${fmt(s + 1)} 明细`;
  $('sector-range').textContent = `帧 ${fmt(start)}–${fmt(end - 1)}（${fmt(end - start)} 帧）`;

  // 读档明细
  const reads = S.engine.allReadsWithSegments();
  const table = $('sector-reads');
  table.textContent = '';
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, num] of [['读档', 0], ['覆盖帧', 1], ['坏区 左 / 右', 1], ['经过的块（偏移）', 0]]) {
    const th = el('th', num ? 'num' : '', label);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const read of reads) {
    const row = el('tr');
    row.appendChild(el('td', '', `${read.label}（${read.file}）`));
    const covered = overlapFrames(read.segments, start, end);
    row.appendChild(el('td', 'num', `${fmt(covered)} / ${fmt(end - start)}`));
    const spansL = spansOfRead(read, 0);
    const spansR = spansOfRead(read, 1);
    const inL = spansOverlapFrames(spansL, start, end);
    const inR = spansOverlapFrames(spansR, start, end);
    const badCell = el('td', 'num', `${fmt(inL)} / ${fmt(inR)}`);
    if (inL || inR) badCell.style.color = 'var(--critical)';
    row.appendChild(badCell);
    const blocksHit = blocksInSector(read, start, end);
    row.appendChild(el('td', '', blocksHit));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  // 争议段
  const list = $('sector-disputes');
  list.textContent = '';
  const runs = disputeRuns(start, end);
  if (runs.length === 0) {
    list.appendChild(el('div', 'dispute-empty', '本扇区没有争议片段。'));
  } else {
    for (const run of runs) {
      const cls = run.status === Core.STATUS_NO_MAJORITY ? 'nomaj'
        : run.status === Core.STATUS_INSUFFICIENT ? 'insuf' : 'gap';
      const row = el('div', 'dispute-row ' + cls);
      row.appendChild(el('span', 'dr-range', `${run.channel}声道 帧 ${fmt(run.start)}–${fmt(run.end - 1)}`));
      row.appendChild(el('span', 'dr-meta', `${fmt(run.end - run.start)} 帧 · ${Core.STATUS_LABELS[run.status]}`));
      row.appendChild(el('span', 'dr-meta', `有效票 ${fmt(run.vmin)}–${fmt(run.vmax)} · 最高票 ${fmt(run.tmin)}–${fmt(run.tmax)}`));
      const btn = el('button', 'btn tiny ghost', '在单帧查看');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        S.frame = run.start;
        setView('frame');
        renderFrameView();
        $('frame-input').value = String(S.frame);
      });
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  // 状态构成
  const bars = $('sector-status');
  bars.textContent = '';
  for (const [name, counts, off] of [['左声道', r.sector.countsL, 0], ['右声道', r.sector.countsR, 4]]) {
    const wrap = el('div', 'status-bar-row');
    wrap.appendChild(el('span', 'status-bar-label', name));
    const bar = el('div', 'status-bar');
    let total = 0;
    for (let k = 0; k < 4; k++) total += counts[s * 4 + k];
    const classes = ['adopt', 'nomaj', 'insuf', 'gap'];
    for (let k = 0; k < 4; k++) {
      const n = counts[s * 4 + k];
      if (!n) continue;
      const part = el('span', classes[k], n >= 40 ? fmt(n) : '');
      part.style.flex = String(n);
      part.title = `${Core.STATUS_LABELS[k]}：${fmt(n)} 帧`;
      bar.appendChild(part);
    }
    wrap.appendChild(bar);
    bars.appendChild(wrap);
  }
  const key = el('div', 'status-bar-key');
  const classes = ['adopt', 'nomaj', 'insuf', 'gap'];
  for (let k = 0; k < 4; k++) {
    const item = el('span', 'legend-item');
    const sw = el('span', 'legend-swatch');
    sw.style.background = `var(--${['adopt', 'no-majority', 'insufficient', 'gap'][k]})`;
    item.appendChild(sw);
    item.appendChild(el('span', '', Core.STATUS_LABELS[k]));
    key.appendChild(item);
  }
  bars.appendChild(key);
}

function overlapFrames(segments, start, end) {
  let n = 0;
  for (const seg of segments) {
    const a = Math.max(start, seg.start);
    const b = Math.min(end, seg.end);
    if (b > a) n += b - a;
  }
  return n;
}

function spansOfRead(read, channel) {
  const idx = read.index;
  if (idx === 0) return S.engine.project.anchor.bad[channel];
  return S.engine.project.copies[idx - 1].bad[channel];
}

function spansOverlapFrames(spans, start, end) {
  let n = 0;
  for (const [s, e] of spans) {
    const a = Math.max(start, s);
    const b = Math.min(end, e);
    if (b > a) n += b - a;
  }
  return n;
}

function blocksInSector(read, start, end) {
  if (!read.segments || read.segments.length === 0) return '—';
  const parts = [];
  for (const seg of read.segments) {
    if (seg.end <= start || seg.start >= end) continue;
    const id = read.index === 0 ? '#0' : `#${seg.block}`;
    parts.push(`${id}(${seg.offset >= 0 ? '+' : ''}${seg.offset})`);
    if (parts.length > 18) { parts.push('…'); break; }
  }
  return parts.length ? parts.join(' ') : '—';
}

/** 本扇区内连续争议段（按声道）。 */
function disputeRuns(start, end) {
  const r = S.result;
  const out = [];
  for (const [channel, status, votes, top] of [
    ['左', r.votes.statusL, r.votes.votesL, r.votes.topL],
    ['右', r.votes.statusR, r.votes.votesR, r.votes.topR],
  ]) {
    let i = start;
    while (i < end) {
      const st = status[i];
      if (st === Core.STATUS_ADOPT) { i++; continue; }
      let j = i + 1;
      while (j < end && status[j] === st) j++;
      let vmin = votes[i], vmax = votes[i], tmin = top[i], tmax = top[i];
      for (let k = i + 1; k < j; k++) {
        vmin = Math.min(vmin, votes[k]); vmax = Math.max(vmax, votes[k]);
        tmin = Math.min(tmin, top[k]); tmax = Math.max(tmax, top[k]);
      }
      out.push({ channel, status: st, start: i, end: j, vmin, vmax, tmin, tmax });
      i = j;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 渲染：单帧
// ---------------------------------------------------------------------------

const statusClass = (st) => ['adopt', 'nomaj', 'insuf', 'gap'][st];

function renderFrameView() {
  const r = S.result;
  if (!r || !r.ok) return;
  S.frame = clamp(S.frame, 0, r.frames - 1);
  const f = S.frame;
  const frame = S.engine.frameAt(f);
  $('frame-pos').textContent = `帧 ${fmt(f)} / ${fmt(r.frames - 1)} · 扇区 ${Math.floor(f / Core.SECTOR_FRAMES) + 1}`;
  $('frame-input').max = String(r.frames - 1);
  if (document.activeElement !== $('frame-input')) $('frame-input').value = String(f);

  const cards = $('frame-vote');
  cards.textContent = '';
  for (const [name, data] of [['左声道', frame.left], ['右声道', frame.right]]) {
    const card = el('div', 'vote-card ' + statusClass(data.status));
    const head = el('div', 'vote-card-head');
    head.appendChild(el('span', '', name));
    const pill = el('span', 'pill ' + statusClass(data.status), Core.STATUS_LABELS[data.status]);
    head.appendChild(pill);
    card.appendChild(head);
    card.appendChild(el('div', 'vote-card-value', data.status === Core.STATUS_ADOPT ? String(data.out) : '0'));
    const detail = data.status === Core.STATUS_ADOPT
      ? `采用 ${fmt(data.top)} / ${fmt(data.votes)} 票（严格过半）`
      : data.status === Core.STATUS_GAP
        ? '无有效票，写 0'
        : data.status === Core.STATUS_INSUFFICIENT
          ? `仅 ${fmt(data.votes)} 票，不足两票，写 0`
          : `最高 ${fmt(data.top)} / ${fmt(data.votes)} 票，未严格过半，写 0`;
    card.appendChild(el('div', 'vote-card-meta', detail));
    cards.appendChild(card);
  }

  // 读档表
  const table = $('frame-reads');
  table.textContent = '';
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, num] of [['读档', 0], ['覆盖', 0], ['块', 0], ['偏移', 1], ['源帧', 1], ['左值', 1], ['右值', 1], ['有效', 0]]) {
    hr.appendChild(el('th', num ? 'num' : '', label));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of frame.reads) {
    const tr = el('tr');
    tr.appendChild(el('td', '', row.label));
    if (!row.covered) {
      tr.appendChild(el('td', '', '—'));
      for (let i = 0; i < 6; i++) tr.appendChild(el('td', '', ''));
      tbody.appendChild(tr);
      continue;
    }
    tr.appendChild(el('td', '', '是'));
    tr.appendChild(el('td', 'mono', row.block === undefined ? '—' : `#${row.block}`));
    tr.appendChild(el('td', 'num mono', (row.offset >= 0 ? '+' : '') + row.offset));
    tr.appendChild(el('td', 'num mono', fmt(row.srcFrame)));
    const lCell = el('td', 'num mono', String(row.valueL));
    const rCell = el('td', 'num mono', String(row.valueR));
    if (!row.validL) lCell.style.color = 'var(--text-3)';
    if (!row.validR) rCell.style.color = 'var(--text-3)';
    tr.appendChild(lCell);
    tr.appendChild(rCell);
    const validTxt = (row.validL ? '左' : '') + (row.validR ? '右' : '');
    tr.appendChild(el('td', '', validTxt || '全坏'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // 计票
  const tallies = $('frame-tallies');
  tallies.textContent = '';
  for (const [name, list] of [['左声道', frame.tally[0]], ['右声道', frame.tally[1]]]) {
    const box = el('div', 'tally');
    box.appendChild(el('h4', '', name));
    if (list.length === 0) {
      box.appendChild(el('div', 'empty', '无有效票'));
    } else {
      const max = list[0].count;
      const topCount = list.filter((x) => x.count === max).length;
      for (const item of list) {
        const row = el('div', 'tally-row' + (item.count === max && topCount === 1 ? ' top' : ''));
        row.appendChild(el('span', 'tv', String(item.value)));
        const barCell = el('span');
        const bar = el('span', 'tally-bar');
        bar.style.display = 'block';
        bar.style.width = (item.count / max) * 100 + '%';
        barCell.appendChild(bar);
        row.appendChild(barCell);
        row.appendChild(el('span', 'tv', fmt(item.count)));
        box.appendChild(row);
      }
    }
    tallies.appendChild(box);
  }
}

function gotoFrame(f) {
  if (!S.result || !S.result.ok) return;
  S.frame = clamp(f, 0, S.result.frames - 1);
  renderFrameView();
}

// ---------------------------------------------------------------------------
// 渲染：块表
// ---------------------------------------------------------------------------

function buildReadSelectors() {
  const reads = S.engine.reads();
  for (const [sel, skipAnchor] of [[$('copy-select'), true], [$('bad-read'), false]]) {
    sel.textContent = '';
    for (const read of reads) {
      if (skipAnchor && read.isAnchor) continue;
      const opt = el('option', '', `${read.label}（${read.file}）`);
      opt.value = String(read.index);
      sel.appendChild(opt);
    }
  }
  const firstCopy = reads.find((r) => !r.isAnchor);
  S.copySel = firstCopy ? firstCopy.index : 0;
  S.badRead = 0;
  $('copy-select').value = String(S.copySel);
  $('bad-read').value = String(S.badRead);
}

function renderBlocks() {
  const sel = $('copy-select');
  const copyIdx = Number(sel.value || S.copySel);
  S.copySel = copyIdx;
  const table = $('copy-blocks');
  table.textContent = '';
  const project = S.engine.project;
  const copy = project.copies[copyIdx - 1];
  if (!copy) return;
  const aligned = S.result && S.result.copies ? S.result.copies.find((c) => c.label === `副本 #${copyIdx}`) : null;
  $('copy-score').textContent = aligned && aligned.ok
    ? `得分 ${fmt(aligned.total)} · 绝对偏移和 ${fmt(aligned.absSum)}`
    : '';

  const thead = el('thead');
  const hr = el('tr');
  const cols = [['块', 0], ['源起帧', 1], ['源止帧', 1], ['名义盘面起帧', 1], ['长度', 1], ['偏移', 1], ['盘面起帧', 1], ['盘面止帧', 1], ['得分', 1], ['可比', 1], ['相等/不等', 1]];
  for (const [label, num] of cols) hr.appendChild(el('th', num ? 'num' : '', label));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  const failBlock = aligned && !aligned.ok ? aligned.failBlock : -1;
  copy.blocks.forEach((b, i) => {
    const tr = el('tr');
    if (i === failBlock) tr.classList.add('fault');
    tr.appendChild(el('td', 'mono', `#${i}`));
    tr.appendChild(el('td', 'num mono', fmt(b.src)));
    tr.appendChild(el('td', 'num mono', fmt(b.src + b.len)));
    tr.appendChild(el('td', 'num mono', fmt(b.nom)));
    tr.appendChild(el('td', 'num mono', fmt(b.len)));
    const d = aligned && aligned.ok ? aligned.details[i] : null;
    tr.appendChild(el('td', 'num mono', d ? (d.offset >= 0 ? '+' : '') + d.offset : '—'));
    tr.appendChild(el('td', 'num mono', d ? fmt(d.discStart) : '—'));
    tr.appendChild(el('td', 'num mono', d ? fmt(d.discEnd) : '—'));
    tr.appendChild(el('td', 'num mono', d ? fmt(d.score) : '—'));
    tr.appendChild(el('td', 'num mono', d ? fmt(d.comparable) : '—'));
    tr.appendChild(el('td', 'num mono', d ? `${fmt(d.eq)} / ${fmt(d.neq)}` : '—'));
    tr.addEventListener('click', () => {
      if (!d) return;
      const target = clamp(Math.floor((d.discStart + d.discEnd) / 2), 0, S.result.frames - 1);
      S.frame = target;
      setView('frame');
      renderFrameView();
    });
    tr.style.cursor = d ? 'pointer' : 'default';
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

// ---------------------------------------------------------------------------
// 坏区编辑
// ---------------------------------------------------------------------------

function currentBad(readIndex, channel) {
  if (readIndex === 0) return S.engine.project.anchor.bad[channel];
  return S.engine.project.copies[readIndex - 1].bad[channel];
}

function renderBadEditor() {
  if (!S.engine) return;
  const read = S.badRead;
  const ch = S.badChannel;
  const spans = currentBad(read, ch);
  const frames = read === 0 ? S.engine.project.anchor.frames : S.engine.project.copies[read - 1].frames;
  $('bad-limit').textContent = `源坐标 0..${fmt(frames)}`;
  $('bad-start').max = String(frames);
  $('bad-end').max = String(frames);
  const box = $('bad-spans');
  box.textContent = '';
  if (spans.length === 0) {
    box.appendChild(el('div', 'bad-empty', '该声道暂无坏区。'));
    return;
  }
  spans.forEach(([s, e], i) => {
    const row = el('div', 'bad-span');
    row.appendChild(el('span', 'bs-range', `[${fmt(s)}, ${fmt(e)})`));
    row.appendChild(el('span', 'muted small', `${fmt(e - s)} 帧`));
    const del = el('button', 'btn tiny ghost', '移除');
    del.type = 'button';
    del.addEventListener('click', () => {
      const next = spans.filter((_, k) => k !== i);
      changeBad(read, ch, next);
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function changeBad(read, channel, spans) {
  if (S.busy) return;
  try {
    const normalized = S.engine.setBad(read, channel, spans);
    renderBadEditor();
    if (S.phase === 'computed' || S.phase === 'nosolution') {
      S.phase = 'loaded';
      S.result = null;
      $('summary').classList.add('hidden');
      updateExportButtons();
      setStatus('坏区已改，正在重新对齐并投票…');
      await runAlign();
    } else {
      setStatus('坏区已改；点「开始校对」重新对齐。');
    }
  } catch (err) {
    setStatus('坏区无效：' + (err && err.message ? err.message : err), 'err');
  }
}

function addBadSpan() {
  const s = Number($('bad-start').value);
  const e = Number($('bad-end').value);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s) {
    setStatus('坏区起止必须是整数且 起 < 止。', 'err');
    return;
  }
  const spans = currentBad(S.badRead, S.badChannel).slice();
  spans.push([s, e]);
  changeBad(S.badRead, S.badChannel, spans);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function download(name, bytes, mime) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName() {
  return (S.engine && S.engine.project && S.engine.project.anchor.file
    ? S.engine.project.anchor.file.replace(/\.wav$/i, '')
    : 'disc') + '-consensus';
}

function exportWav() {
  if (!S.engine || !S.engine.wavBytes) return;
  download(baseName() + '.wav', S.engine.wavBytes, 'audio/wav');
}

function exportDisputes() {
  const text = S.engine && S.engine.exportDisputesCsv();
  if (!text) return;
  download(baseName() + '-disputes.csv', text, 'text/csv;charset=utf-8');
}

function exportAlign() {
  const text = S.engine && S.engine.exportAlignmentCsv();
  if (!text) return;
  download(baseName() + '-alignment.csv', text, 'text/csv;charset=utf-8');
}

// ---------------------------------------------------------------------------
// 视图切换与事件
// ---------------------------------------------------------------------------

function setView(name) {
  S.view = name;
  for (const b of document.querySelectorAll('.seg-btn')) {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('view-sector').classList.toggle('hidden', name !== 'sector');
  $('view-frame').classList.toggle('hidden', name !== 'frame');
}

function bindEvents() {
  $('file-zip').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) loadFile(f);
  });
  $('file-zip-2').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) loadFile(f);
  });
  $('btn-sample').addEventListener('click', loadSample);
  $('btn-sample-2').addEventListener('click', loadSample);
  $('btn-run').addEventListener('click', runAlign);

  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      setView(b.dataset.view);
      if (b.dataset.view === 'frame') renderFrameView();
    });
  }

  // 扇区（canvas 总览）
  const cv = $('sector-canvas');
  cv.addEventListener('click', (ev) => {
    if (!S.result || !S.result.ok) return;
    selectSector(sectorFromEvent(ev, cv));
  });
  cv.addEventListener('mousemove', (ev) => {
    if (!S.result || !S.result.ok) return;
    showSectorTip(ev, sectorFromEvent(ev, cv));
  });
  cv.addEventListener('mouseleave', hideSectorTip);
  cv.addEventListener('keydown', (ev) => {
    if (!S.result || !S.result.ok) return;
    const step = ev.shiftKey ? 10 : 1;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectSector(S.sector - step); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); selectSector(S.sector + step); }
    else if (ev.key === 'Home') { ev.preventDefault(); selectSector(0); }
    else if (ev.key === 'End') { ev.preventDefault(); selectSector(S.result.sector.sectors - 1); }
  });
  $('sector-prev').addEventListener('click', () => selectSector(S.sector - 1));
  $('sector-next').addEventListener('click', () => selectSector(S.sector + 1));
  $('sector-input').addEventListener('change', (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) selectSector(v - 1);
  });
  $('sector-first-dispute').addEventListener('click', () => {
    if (!S.result || !S.result.ok) return;
    const { countsL, countsR, sectors } = S.result.sector;
    for (let s = 0; s < sectors; s++) {
      let bad = 0;
      for (let k = 1; k < 4; k++) bad += countsL[s * 4 + k] + countsR[s * 4 + k];
      if (bad) { selectSector(s); return; }
    }
    setStatus('所有扇区都没有争议。');
  });

  // 单帧
  $('frame-prev').addEventListener('click', () => gotoFrame(S.frame - 1));
  $('frame-next').addEventListener('click', () => gotoFrame(S.frame + 1));
  $('frame-first').addEventListener('click', () => gotoFrame(0));
  $('frame-last').addEventListener('click', () => { if (S.result) gotoFrame(S.result.frames - 1); });
  $('frame-input').addEventListener('change', (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) gotoFrame(Math.trunc(v));
  });
  $('frame-goto-dispute').addEventListener('click', () => {
    if (!S.result || !S.result.ok) return;
    const v = S.result.votes;
    for (let i = 0; i < S.result.frames; i++) {
      if (v.statusL[i] !== Core.STATUS_ADOPT || v.statusR[i] !== Core.STATUS_ADOPT) {
        gotoFrame(i);
        return;
      }
    }
    setStatus('没有争议帧。');
  });

  // 块表
  $('copy-select').addEventListener('change', (ev) => {
    S.copySel = Number(ev.target.value);
    renderBlocks();
  });

  // 坏区
  $('bad-read').addEventListener('change', (ev) => {
    S.badRead = Number(ev.target.value);
    renderBadEditor();
  });
  $('bad-channel').addEventListener('change', (ev) => {
    S.badChannel = Number(ev.target.value);
    renderBadEditor();
  });
  $('bad-add-btn').addEventListener('click', addBadSpan);

  // 导出
  $('btn-export-wav').addEventListener('click', exportWav);
  $('btn-export-csv').addEventListener('click', exportDisputes);
  $('btn-export-align').addEventListener('click', exportAlign);

  // 主题
  $('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
  });

  // 画布随窗口尺寸重绘
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.result && S.result.ok) paintSectorCanvas(); }, 120);
  });
  // 主题切换后 canvas 需要按新配色重绘
  const themeBtn = $('btn-theme');
  themeBtn.addEventListener('click', () => {
    if (S.result && S.result.ok) setTimeout(paintSectorCanvas, 0);
  });

  // 键盘：单帧视图左右微调
  document.addEventListener('keydown', (ev) => {
    if (S.view !== 'frame' || S.busy) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); gotoFrame(S.frame - (ev.shiftKey ? 588 : 1)); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); gotoFrame(S.frame + (ev.shiftKey ? 588 : 1)); }
  });

  // 拖放
  let dragDepth = 0;
  const hint = $('drop-hint');
  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    hint.classList.remove('hidden');
  });
  window.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    if (!hint.classList.contains('hidden')) ev.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hint.classList.add('hidden');
  });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    hint.classList.add('hidden');
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) loadFile(f);
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function init() {
  bindEvents();
  setView('sector');
  $('foot-mode').textContent = typeof SharedArrayBuffer === 'function'
    ? '并行模式可用（SharedArrayBuffer 已启用）'
    : '并行模式不可用（缺少 SharedArrayBuffer，将单线程运行）';
  // 便于自动化测试与排障：只读地暴露当前状态
  window.__dc = {
    state: S,
    get result() { return S.result; },
    get phase() { return S.phase; },
    gotoFrame,
    selectSector,
    setView,
    run: runAlign,
    loadZipBytes,
    frameAt: (f) => S.engine && S.engine.frameAt(f),
    exportText: () => ({
      disputes: S.engine && S.engine.exportDisputesCsv(),
      alignment: S.engine && S.engine.exportAlignmentCsv(),
      wavLength: S.engine && S.engine.wavBytes ? S.engine.wavBytes.length : 0,
    }),
  };
}

init();
