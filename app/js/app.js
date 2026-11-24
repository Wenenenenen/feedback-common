// app.js — 页面主控制器
import { solve } from './solver.js';
import { importPackage } from './importer.js';
import { AudioEngine } from './audio.js';
import { Timeline, takeColor, fmtTime } from './timeline.js';
import { renderMix, encodeWav, SAMPLE_RATE } from './wav-codec.js';

const state = {
  instance: null,
  takeAudio: null,
  result: null,
  locks: new Map(),       // cueIdx -> candId
  selectedCue: null,
  selectedCandId: null,
  deliverySamples: null,
  loaded: false,
};

const audio = new AudioEngine();
let timeline;
const $ = (sel) => document.querySelector(sel);

const els = {};
let cueRowObserver;

function boot() {
  timeline = new Timeline(
    { ruler: $('#ruler'), sourceWrap: $('#source-lanes'), deliveryWrap: $('#delivery-lane') },
    { onSelect: handleSelect, onSeek: handleSeek }
  );

  Object.assign(els, {
    fileInput: $('#file-input'),
    drop: $('#drop'),
    loadSample: $('#load-sample'),
    solveBtn: $('#solve-btn'),
    clearLocks: $('#clear-locks'),
    zoomIn: $('#zoom-in'),
    zoomOut: $('#zoom-out'),
    stopBtn: $('#stop-btn'),
    playDelivery: $('#play-delivery'),
    loopToggle: $('#loop-toggle'),
    exportWav: $('#export-wav'),
    exportJson: $('#export-json'),
    exportFull: $('#export-full'),
    cueList: $('#cue-list'),
    banner: $('#banner'),
    summary: $('#summary'),
    selectedPanel: $('#selected-panel'),
    statusLine: $('#status-line'),
    metaLine: $('#meta-line'),
    warnings: $('#warnings'),
    downloadArea: $('#download-area'),
  });

  els.fileInput.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
  ['dragover', 'dragenter'].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('dragging'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('dragging'); })
  );
  els.drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  });
  els.loadSample.addEventListener('click', loadBuiltinSample);
  els.solveBtn.addEventListener('click', () => runSolve(true));
  els.clearLocks.addEventListener('click', () => { state.locks.clear(); runSolve(true); });
  els.zoomIn.addEventListener('click', () => timeline.setPps(timeline.pps * 1.25));
  els.zoomOut.addEventListener('click', () => timeline.setPps(timeline.pps / 1.25));
  els.stopBtn.addEventListener('click', () => audio.stop());
  els.playDelivery.addEventListener('click', playDelivery);
  els.loopToggle.addEventListener('change', () => {
    if (audio.playing) { // 以新循环设置重放
      const { mode } = audio;
      audio.stop();
      if (mode === 'delivery') playDelivery();
      else replaySelected();
    }
  });
  els.exportWav.addEventListener('click', exportWav);
  els.exportJson.addEventListener('click', exportManifest);
  els.exportFull.addEventListener('click', exportFullSnapshot);

  audio.onEnd = () => timeline.clearPlayhead();
  audio.onPlayState = (playing) => {
    els.playDelivery.textContent = playing && audio.mode === 'delivery' ? '停止成片' : '播放成片';
  };

  loadBuiltinSample();
  requestAnimationFrame(tickPlayhead);
  window.addEventListener('dcc-theme-change', () => {
    if (state.loaded) timeline.renderStatic();
  });
}

// ---------------- 导入 ----------------
async function loadFile(file) {
  if (!file) return;
  flashStatus(`正在解析 ${file.name} …`);
  try {
    const { instance, takeAudio, warnings } = await importPackage(file);
    applyData(instance, takeAudio, warnings);
  } catch (e) {
    flashStatus(`导入失败: ${e.message}`, true);
  }
}

function applyData(instance, takeAudio, warnings = []) {
  audio.stop();
  state.instance = instance;
  state.takeAudio = takeAudio;
  state.locks = new Map();
  state.selectedCue = null;
  state.selectedCandId = null;
  state.deliverySamples = null;
  state.loaded = true;
  els.downloadArea.innerHTML = '';
  els.warnings.hidden = warnings.length === 0;
  els.warnings.textContent = warnings.join('；');
  els.metaLine.textContent =
    `${instance.takes.length} 轨 · ${instance.cues.length} 句 · 共 ${instance.cues.reduce((a, c) => a + c.candidates.length, 0)} 候选 · ` +
    `交付 ${(instance.frames / SAMPLE_RATE).toFixed(2)}s · 间隔 ${instance.gap} 帧 · 切轨上限 ${instance.changes} · 切轨费 ${instance.switchCost}`;
  audio.setTakes(takeAudio);
  timeline.setData(instance, takeAudio);
  renderCueList();
  runSolve(false);
}

// ---------------- 求解 ----------------
function runSolve(manual) {
  if (!state.loaded) return;
  audio.stop();
  const t0 = performance.now();
  const result = solve(state.instance, { locks: state.locks });
  result.uiMs = performance.now() - t0;
  state.result = result;
  state.deliverySamples = null;
  els.downloadArea.innerHTML = '';

  if (result.ok) {
    // 选中态跟随: 默认第一句
    if (state.selectedCue == null) selectCue(0);
    else if (!state.locks.has(state.selectedCue)) {
      state.selectedCandId = result.chosen[state.selectedCue]?.id ?? state.selectedCandId;
    }
    els.banner.hidden = true;
    renderSummary();
    renderDelivery();
  } else {
    els.banner.hidden = false;
    $('#banner-text').textContent =
      `无解: 第 ${result.failedCue + 1} 句是第一处不存在合法前缀的句子（${reasonText(result.reason)}）。` +
      (state.locks.size ? ' 可解除该句或更早句子的锁定后重算。' : '');
    els.summary.innerHTML = ['无解', '—', '—', '—', '—', `${state.locks.size} 句`]
      .map((v, i) => `<div class="stat"><span class="stat-k">${['总成本', '候选分之和', '切轨次数', '切轨费', '求解耗时', '锁定'][i]}</span><span class="stat-v">${v}</span></div>`)
      .join('');
    selectCue(result.failedCue);
  }
  refreshTimeline();
  updateCueRows();
  const hasSolution = result.ok;
  for (const id of ['export-wav', 'export-json', 'export-full', 'play-delivery']) {
    document.getElementById(id).disabled = !hasSolution;
  }
  flashStatus(
    result.ok
      ? `求解完成 ${result.solveMs.toFixed(0)} ms（含渲染 ${result.uiMs.toFixed(0)} ms）· ${result.states} 个 DP 状态`
      : `无解定位在第 ${result.failedCue + 1} 句 · ${result.solveMs.toFixed(0)} ms`,
    !result.ok
  );
}

function reasonText(reason) {
  return {
    'no-candidate-fits-slot': '该句没有候选能完整落入目标槽',
    'locked-candidate-unavailable': '被锁定的候选无法落入目标槽',
    'no-legal-prefix': '该句没有候选能与前面的选择同时满足静音间隔与同源轨不重叠约束',
  }[reason] || reason;
}

function renderSummary() {
  const r = state.result;
  const candSum = r.chosen.reduce((a, c) => a + c.cost, 0);
  els.summary.innerHTML = `
    <div class="stat"><span class="stat-k">总成本</span><span class="stat-v">${r.totalCost}</span></div>
    <div class="stat"><span class="stat-k">候选分之和</span><span class="stat-v">${candSum}</span></div>
    <div class="stat"><span class="stat-k">切轨次数</span><span class="stat-v">${r.switches}<small>/${state.instance.changes}</small></span></div>
    <div class="stat"><span class="stat-k">切轨费</span><span class="stat-v">${r.switches * state.instance.switchCost}</span></div>
    <div class="stat"><span class="stat-k">求解耗时</span><span class="stat-v">${r.solveMs.toFixed(0)}<small>ms</small></span></div>
    <div class="stat"><span class="stat-k">锁定</span><span class="stat-v">${state.locks.size}<small>句</small></span></div>`;
}

function renderDelivery() {
  try {
    state.deliverySamples = renderMix(state.result.chosen,
      new Map([...state.takeAudio].map(([t, w]) => [t, w.samples])), state.instance.frames);
    audio.setDelivery(state.deliverySamples);
  } catch (e) {
    flashStatus(`交付轨渲染失败: ${e.message}`, true);
  }
}

// ---------------- 句子列表 ----------------
function renderCueList() {
  cueRowObserver?.disconnect();
  els.cueList.innerHTML = '';
  state.instance.cues.forEach((cue, k) => {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.cue = k;
    row.innerHTML = `
      <button class="cue-head" type="button">
        <span class="cue-no">${String(k + 1).padStart(3, '0')}</span>
        <span class="cue-slot">${fmtTime(cue.slot[0])} – ${fmtTime(cue.slot[1])}</span>
        <span class="cue-pick" data-role="pick"></span>
        <span class="cue-lock" data-role="lock"></span>
      </button>
      <div class="cue-body" data-role="body" hidden></div>`;
    row.querySelector('.cue-head').addEventListener('click', () => selectCue(k));
    els.cueList.append(row);
  });
  cueRowObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) fillBody(Number(en.target.dataset.cue));
  }, { root: els.cueList, rootMargin: '300px' });
  document.querySelectorAll('.cue-row').forEach((r) => cueRowObserver.observe(r));
}

function fillBody(k) {
  const row = els.cueList.querySelector(`[data-cue="${k}"] .cue-body`);
  if (row.dataset.filled) return;
  row.dataset.filled = '1';
  const cue = state.instance.cues[k];
  const fits = (c) => c.dst >= cue.slot[0] && c.dst + c.len <= cue.slot[1];
  cue.candidates.forEach((c) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cand-chip';
    chip.dataset.cand = c.id;
    chip.disabled = !fits(c);
    chip.innerHTML = `
      <span class="chip-id">#${c.id}</span>
      <span class="chip-dot" style="background:${takeColor(c.take)}"></span>
      <span class="chip-take">t${c.take}</span>
      <span class="chip-meta">${fmtTime(c.dst)} · ${(c.len / SAMPLE_RATE).toFixed(2)}s</span>
      <span class="chip-cost">${c.cost}</span>
      <span class="chip-tag" data-role="tag"></span>`;
    chip.title = fits(c)
      ? `候选 ${c.id}: 轨 t${c.take}, 源 ${c.src}, 目标 ${c.dst}, 长 ${c.len}, 分 ${c.cost}`
      : '候选超出目标槽, 不可用';
    chip.addEventListener('click', () => handleSelect(k, c.id));
    row.append(chip);
  });
  updateRowState(k);
}

function updateCueRows() {
  state.instance.cues.forEach((_, k) => {
    const rowEl = els.cueList.querySelector(`[data-cue="${k}"]`);
    if (rowEl) updateRowState(k);
  });
}

function updateRowState(k) {
  const rowEl = els.cueList.querySelector(`[data-cue="${k}"]`);
  if (!rowEl) return;
  const locked = state.locks.has(k);
  rowEl.classList.toggle('locked', locked);
  rowEl.classList.toggle('failed', !state.result.ok && state.result.failedCue === k);
  rowEl.classList.toggle('active', state.selectedCue === k);

  const lockEl = rowEl.querySelector('[data-role="lock"]');
  lockEl.textContent = locked ? '🔒' : '';
  lockEl.title = locked ? '已锁定(点击候选可解锁)' : '';

  const pick = rowEl.querySelector('[data-role="pick"]');
  if (state.result.ok) {
    const c = state.result.chosen[k];
    pick.innerHTML = `<span class="chip-dot" style="background:${takeColor(c.take)}"></span>#${c.id} · ${c.cost}分`;
  } else {
    pick.textContent = locked ? `锁定 #${state.locks.get(k)}` : '—';
  }

  const body = rowEl.querySelector('[data-role="body"]');
  if (body.dataset.filled) {
    const chosenId = state.result.ok ? state.result.chosen[k].id : null;
    body.querySelectorAll('.cand-chip').forEach((chip) => {
      const id = Number(chip.dataset.cand);
      chip.classList.toggle('chosen', id === chosenId);
      chip.classList.toggle('selected', id === state.selectedCandId && k === state.selectedCue);
      chip.classList.toggle('locked-chip', locked && id === state.locks.get(k));
      chip.querySelector('[data-role="tag"]').textContent =
        id === chosenId ? '采用' : (locked && id === state.locks.get(k) ? '锁定' : '');
    });
  }
  body.hidden = state.selectedCue !== k;
}

// ---------------- 选择与锁定 ----------------
function selectCue(k) {
  state.selectedCue = k;
  const cue = state.instance.cues[k];
  if (state.result.ok) state.selectedCandId = state.result.chosen[k].id;
  else if (state.locks.has(k)) state.selectedCandId = state.locks.get(k);
  else state.selectedCandId = cue.candidates.find((c) => c.dst >= cue.slot[0] && c.dst + c.len <= cue.slot[1])?.id ?? null;
  updateCueRows();
  refreshTimeline();
  renderSelectedPanel();
  timeline.scrollToCue(k);
}

function handleSelect(k, candId) {
  if (state.selectedCue !== k) selectCue(k);
  state.selectedCandId = candId;
  const cue = state.instance.cues[k];
  const c = cue.candidates.find((x) => x.id === candId);
  if (!c || c.dst < cue.slot[0] || c.dst + c.len > cue.slot[1]) return;

  const wasLocked = state.locks.get(k);
  if (wasLocked === candId) {
    state.locks.delete(k); // 再点锁定候选 = 解锁
  } else {
    state.locks.set(k, candId);
  }
  runSolve(false);
  replaySelected();
}

function replaySelected() {
  const c = currentSelectedCandidate();
  if (!c) return;
  audio.playSegment(c.take, c.src, c.len, els.loopToggle.checked);
}

function currentSelectedCandidate() {
  if (state.selectedCue == null || state.selectedCandId == null) return null;
  return state.instance.cues[state.selectedCue].candidates.find((c) => c.id === state.selectedCandId) ?? null;
}

function handleSeek(seconds, mode, take) {
  if (mode === 'delivery' && state.deliverySamples) {
    audio.playDelivery(els.loopToggle.checked);
  } else if (mode === 'segment' && take != null) {
    const wav = state.takeAudio.get(take);
    const f = Math.round(seconds * SAMPLE_RATE);
    audio.playSegment(take, Math.min(f, Math.max(0, wav.frames - 480)), 4800, false);
  }
}

function playDelivery() {
  if (audio.playing && audio.mode === 'delivery') { audio.stop(); return; }
  if (!state.deliverySamples) return;
  audio.playDelivery(els.loopToggle.checked);
}

function renderSelectedPanel() {
  const k = state.selectedCue;
  if (k == null) { els.selectedPanel.hidden = true; return; }
  els.selectedPanel.hidden = false;
  const cue = state.instance.cues[k];
  const c = currentSelectedCandidate();
  const rows = cue.candidates.map((x) => {
    const ok = x.dst >= cue.slot[0] && x.dst + x.len <= cue.slot[1];
    return `<tr class="${ok ? '' : 'illegal'}">
      <td>#${x.id}</td><td><span class="chip-dot" style="background:${takeColor(x.take)}"></span> t${x.take}</td>
      <td>${fmtTime(x.src)}</td><td>${fmtTime(x.dst)}</td><td>${(x.len / SAMPLE_RATE).toFixed(3)}s</td>
      <td>${x.cost}</td><td>${ok ? '可' : '超槽'}</td></tr>`;
  }).join('');
  els.selectedPanel.innerHTML = `
    <div class="panel-head">
      <h3>第 ${k + 1} 句候选</h3>
      <div class="panel-actions">
        <button type="button" id="panel-play" class="btn small">试听选中</button>
        <button type="button" id="panel-unlock" class="btn small" ${state.locks.has(k) ? '' : 'disabled'}>解锁本句</button>
      </div>
    </div>
    <p class="panel-slot">目标槽 ${fmtTime(cue.slot[0])} – ${fmtTime(cue.slot[1])}（半开，${cue.slot[1] - cue.slot[0]} 帧）
      ${state.locks.has(k) ? `· 当前锁定 #${state.locks.get(k)}` : ''}
      ${c ? `· 选中 #${c.id}` : ''}</p>
    <div class="table-scroll"><table class="cand-table">
      <thead><tr><th>编号</th><th>源轨</th><th>源起</th><th>目标起</th><th>长度</th><th>候选分</th><th>槽位</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  $('#panel-play').addEventListener('click', replaySelected);
  $('#panel-unlock').addEventListener('click', () => {
    state.locks.delete(k);
    runSolve(false);
  });
}

function refreshTimeline() {
  timeline.update(state.result, state.selectedCue, state.selectedCandId, state.locks);
}

// ---------------- 播放头 ----------------
function tickPlayhead() {
  if (audio.playing) {
    timeline.setPlayhead(audio.position(), audio.mode,
      audio.mode === 'segment' ? currentSelectedCandidate()?.take ?? null : null);
  }
  requestAnimationFrame(tickPlayhead);
}

// ---------------- 导出 ----------------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.textContent = filename;
  a.download = filename;
  const item = document.createElement('div');
  item.className = 'download-item';
  item.append(a);
  els.downloadArea.append(item);
  try { a.click(); } catch { /* 沙箱可能拦截点击下载, 保留链接兜底 */ }
  flashStatus(`已生成 ${filename}（如下载被浏览器拦截, 可右键链接另存）`);
}

function exportWav() {
  if (!state.result?.ok || !state.deliverySamples) return;
  download(encodeWav(state.deliverySamples), 'delivery.wav');
}

function buildManifest() {
  const r = state.result;
  return {
    frames: state.instance.frames,
    sampleRate: SAMPLE_RATE,
    gap: state.instance.gap,
    switchCost: state.instance.switchCost,
    maxChanges: state.instance.changes,
    totalCost: r.totalCost,
    switches: r.switches,
    locks: [...state.locks.entries()].map(([cue, id]) => ({ cue, candidateId: id })),
    chosen: r.chosen.map((c, cue) => ({
      cue,
      candidateId: c.id,
      take: c.take,
      src: c.src,
      dst: c.dst,
      len: c.len,
      cost: c.cost,
    })),
  };
}

function exportManifest() {
  if (!state.result?.ok) return;
  download(new Blob([JSON.stringify(buildManifest(), null, 2)], { type: 'application/json' }), 'chosen-manifest.json');
}

function exportFullSnapshot() {
  if (!state.result?.ok) return;
  const snap = { ...buildManifest(), instance: state.instance };
  download(new Blob([JSON.stringify(snap)], { type: 'application/json' }), 'solution-snapshot.json');
}

// ---------------- 状态条 ----------------
let statusTimer;
function flashStatus(text, isError = false) {
  els.statusLine.textContent = text;
  els.statusLine.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => { els.statusLine.textContent = '就绪'; }, 6000);
}

// ---------------- 内置示例(无外部文件也可直接体验) ----------------
async function loadBuiltinSample() {
  const { buildSample } = await import('./sample-data.js');
  const { instance, takeAudio } = buildSample();
  applyData(instance, takeAudio, ['当前为内置示例数据, 可导入自己的 dub-candidates.zip 替换']);
}

document.addEventListener('DOMContentLoaded', boot);
