/*
 * Matrix Room Convolver 主线程。
 *
 * 竞态策略：
 *  - state.generation 每次参数/文件变化递增；
 *  - 新任务启动前先取消旧任务，结果回包时再校验 generation；
 *  - 旧任务的结果永远不会写入 state.analyzeResult。
 */

import { parseWav } from './wav.js';
import {
  validateFiles,
  ROUTES,
  ROUTE_LABELS,
  fixedLength,
  tailLength,
  maxPredelayFrames,
  toMs,
  formatTime,
  formatDb,
} from './validate.js';
import { setAudio, startAnalyze, startRender, startExport, cancelTask } from './job-runner.js';
import { drawMirroredWaveform, drawMonoWaveform, envelopeFromPcm } from './waves.js';
import { Player } from './player.js';

const state = {
  files: { dry: null, LL: null, LR: null, RL: null, RR: null },
  validation: null,
  sampleRate: null,
  predelayFrames: 0,
  wetRatio: 0.65,
  generation: 0,
  analysisCount: 0,
  analyzeTask: null,
  exportTask: null,
  analyzeResult: null,
  analyzing: false,
  exporting: false,
  activePlayback: null,
  playToken: 0,
  sampleManifest: [],
  sampleLoadToken: 0,
  loadingSample: false,
  audioReadyToken: 0,
  workerAudioReady: false,
};

const player = new Player();

const el = {};
const slotEls = new Map();

const SLOT_DEFS = [
  { key: 'dry', label: 'DRY', title: '双声道干声', role: '2 ch · 可缺失' },
  ...ROUTES.map((route) => ({
    key: route,
    label: route,
    title: `IR ${route}`,
    role: `${ROUTE_LABELS[route].out}出 ← ${ROUTE_LABELS[route].in}入`,
  })),
];

const IDS = [
  'status-strip', 'status-text', 'status-fill', 'cancel-task', 'chip-rate', 'chip-state',
  'stat-rate', 'stat-rate-sub', 'stat-length', 'stat-length-sub', 'stat-tail', 'stat-tail-sub',
  'stat-peak', 'stat-peak-sub',
  'sample-select', 'load-sample', 'sample-hint', 'file-slots', 'alerts',
  'routing-matrix', 'formula',
  'predelay-readout', 'predelay-range', 'predelay-frames', 'predelay-presets',
  'wet-readout', 'wet-range', 'wet-number',
  'mix-dry', 'mix-wet', 'mix-dry-bar', 'mix-wet-bar', 'length-summary', 'length-total',
  'dry-wave', 'dry-frame', 'dry-placeholder', 'dry-tooltip', 'dry-caption', 'dry-foot',
  'ir-grid', 'ir-foot',
  'out-wave', 'out-frame', 'out-placeholder', 'out-overlay', 'out-overlay-text',
  'out-overlay-fill', 'out-cancel', 'out-tooltip', 'out-caption', 'out-foot',
  'play-dry', 'play-wet', 'stop-play', 'now-playing', 'export-btn',
  'export-report', 'export-file', 'rep-peak', 'rep-over', 'rep-clamp', 'rep-foot',
];

function bindEls() {
  for (const id of IDS) {
    el[toCamel(id)] = document.getElementById(id);
  }
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* ── 格式化 ───────────────────────────────────────────── */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const nf = (n) => Number(n).toLocaleString('en-US');

/** 振幅读数：3 位有效数字 + dB，避免 0.0203 被显示成 0.0000。 */
function fmtAmp(v) {
  if (!Number.isFinite(v) || v === 0) return '0';
  // 包络是分箱最大值，极小值多为 FFT 舍入；低于 1e-9 按零显示
  if (Math.abs(v) < 1e-9) return '≈0';
  return v.toPrecision(4);
}

/* ── 文件槽位 ─────────────────────────────────────────── */

function buildSlots() {
  el.fileSlots.innerHTML = '';
  slotEls.clear();
  for (const def of SLOT_DEFS) {
    const wrap = document.createElement('div');
    wrap.className = `slot ${def.key === 'dry' ? 'wide' : 'route'} empty`;
    wrap.dataset.key = def.key;
    wrap.innerHTML = `
      <div class="slot-head">
        <span class="slot-dot" aria-hidden="true"></span>
        <span class="slot-label">${def.label}</span>
        <span class="slot-role">${def.role}</span>
      </div>
      <div class="slot-title" data-role="title"></div>
      <div class="slot-meta" data-role="meta"></div>
      <div class="slot-actions">
        <button class="btn tiny" type="button" data-role="pick">选择文件</button>
        <button class="btn tiny ghost" type="button" data-role="clear">清除</button>
      </div>
      <input type="file" accept=".wav,audio/wav,audio/x-wav,audio/wave" hidden data-role="input">
    `;

    const input = wrap.querySelector('[data-role="input"]');
    wrap.querySelector('[data-role="pick"]').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) assignFiles([file], def.key);
    });
    wrap.querySelector('[data-role="clear"]').addEventListener('click', () => clearSlot(def.key));

    wrap.addEventListener('dragover', (event) => {
      event.preventDefault();
      wrap.classList.add('dragover');
    });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
    wrap.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      wrap.classList.remove('dragover');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) assignFiles(files, def.key);
    });

    el.fileSlots.appendChild(wrap);
    slotEls.set(def.key, {
      wrap,
      title: wrap.querySelector('[data-role="title"]'),
      meta: wrap.querySelector('[data-role="meta"]'),
      def,
    });
  }
  renderSlots();
}

function routeFromName(name) {
  const base = name.replace(/\.wav$/i, '').toUpperCase();
  for (const route of ROUTES) {
    if (base === route) return route;
    if (base.endsWith(`_${route}`) || base.endsWith(`-${route}`) || base.endsWith(`.${route}`)) {
      return route;
    }
  }
  return null;
}

/**
 * 导入一组文件：按文件名归类；单文件拖到槽位时按槽位归类。
 */
async function assignFiles(fileList, preferredKey = null) {
  const files = [...fileList].filter((f) => /\.wav$/i.test(f.name) || /wav/i.test(f.type || ''));
  if (!files.length) {
    flashStatus('没有可导入的 WAV 文件。', true);
    return;
  }

  const assignments = [];
  if (preferredKey && files.length === 1) {
    assignments.push({ key: preferredKey, file: files[0] });
  } else {
    const used = new Set();
    for (const file of files) {
      const route = routeFromName(file.name);
      if (route && !used.has(route)) {
        assignments.push({ key: route, file });
        used.add(route);
      }
    }
    const rest = files.filter((f) => !assignments.some((a) => a.file === f));
    const dryFile = rest.find((f) => /dry/i.test(f.name)) || rest[0];
    if (dryFile) assignments.push({ key: 'dry', file: dryFile });
    // 其余同名字文件忽略，避免误把第二条 IR 放到干声
  }

  for (const { key, file } of assignments) {
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseWav(buffer);
      state.files[key] = { name: file.name, parsed };
    } catch (err) {
      state.files[key] = { name: file.name, error: err?.message || String(err) };
    }
  }
  onFilesChanged();
}

function clearSlot(key) {
  state.files[key] = null;
  onFilesChanged();
}

function renderSlots() {
  for (const def of SLOT_DEFS) {
    const entry = slotEls.get(def.key);
    if (!entry) continue;
    const file = state.files[def.key];
    entry.wrap.classList.remove('empty', 'loaded', 'error');

    if (!file) {
      entry.wrap.classList.add('empty');
      entry.title.innerHTML = `<em>${def.title} · 未导入</em>`;
      entry.meta.textContent = def.key === 'dry' ? '可缺失，按零补齐' : '需要单声道 IR';
      continue;
    }
    if (file.error) {
      entry.wrap.classList.add('error');
      entry.title.textContent = file.name;
      entry.meta.innerHTML = `<span class="err">${escapeHtml(file.error)}</span>`;
      continue;
    }
    entry.wrap.classList.add('loaded');
    entry.title.textContent = file.name;
    const p = file.parsed;
    entry.meta.innerHTML =
      `${p.channels} ch · ${p.bitsPerSample}-bit · ${(p.sampleRate / 1000).toFixed(1)} kHz<br>` +
      `<b>${nf(p.frames)}</b> 帧 · ${formatTime(p.duration)}`;
  }
}

/* ── 校验与派生显示 ──────────────────────────────────── */

function onFilesChanged() {
  const result = validateFiles(state.files);
  state.validation = result;
  const prevRate = state.sampleRate;
  state.sampleRate = result.ok ? result.sampleRate : null;
  if (state.sampleRate && state.sampleRate !== prevRate) clampPredelay();

  invalidateAnalysis();
  renderSlots();
  renderAlerts();
  renderDerived();
  renderControls();
  redrawInputs();
  // 输入失效时清掉过期的输出波形与状态文案，避免仍显示上一次的结果
  drawOutputWaveform();
  if (!result.ok && result.errors.length) {
    setBusy(false, '输入不完整：请按上方提示修正后重试。', null, true);
  }
  prepareWorkerAudio();
}

async function prepareWorkerAudio() {
  const v = state.validation;
  state.workerAudioReady = false;
  if (!v?.ok) return;
  const token = ++state.audioReadyToken;
  try {
    await setAudio({
      dryL: v.dry.left,
      dryR: v.dry.right,
      irs: v.irs,
      sampleRate: state.sampleRate,
    });
    if (token !== state.audioReadyToken) return;
    state.workerAudioReady = true;
    if (v === state.validation) scheduleAnalyze();
  } catch (err) {
    flashStatus(`后台线程不可用：${err.message}`, true);
  }
}

function hasUsableInputs() {
  return Boolean(state.validation?.ok);
}

/* ── 参数 ─────────────────────────────────────────────── */

function clampPredelay() {
  const max = state.sampleRate ? maxPredelayFrames(state.sampleRate) : 9600;
  if (state.predelayFrames > max) state.predelayFrames = max;
}

function setPredelay(frames, { commit = true } = {}) {
  const max = state.sampleRate ? maxPredelayFrames(state.sampleRate) : 9600;
  let value = Math.round(Number(frames));
  if (!Number.isFinite(value)) value = 0;
  value = Math.max(0, Math.min(max, value));
  const unchanged = value === state.predelayFrames;
  state.predelayFrames = value;
  syncParamInputs();
  // 失焦会把当前值再发一次；未变化时不重建任务
  if (commit && !unchanged) onParamsChanged();
}

function setWet(w, { commit = true } = {}) {
  let value = Number(w);
  if (!Number.isFinite(value)) value = 0;
  value = Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
  const unchanged = value === state.wetRatio;
  state.wetRatio = value;
  syncParamInputs();
  if (commit && !unchanged) onParamsChanged();
}

function syncParamInputs() {
  const max = state.sampleRate ? maxPredelayFrames(state.sampleRate) : 9600;
  el.predelayRange.max = String(max);
  el.predelayFrames.max = String(max);
  el.predelayRange.value = String(state.predelayFrames);
  if (document.activeElement !== el.predelayFrames) {
    el.predelayFrames.value = String(state.predelayFrames);
  }
  el.predelayRange.style.setProperty('--pct', `${max ? (state.predelayFrames / max) * 100 : 0}%`);
  el.predelayRange.setAttribute(
    'aria-valuetext',
    state.sampleRate
      ? `${state.predelayFrames} 帧，${currentPredelayMs().toFixed(1)} 毫秒`
      : `${state.predelayFrames} 帧`,
  );

  el.wetRange.value = String(state.wetRatio);
  if (document.activeElement !== el.wetNumber) {
    el.wetNumber.value = String(state.wetRatio);
  }
  el.wetRange.style.setProperty('--pct', `${state.wetRatio * 100}%`);
  el.wetRange.setAttribute('aria-valuetext', state.wetRatio.toFixed(3));

  el.predelayReadout.innerHTML = state.sampleRate
    ? `<b>${nf(state.predelayFrames)}</b> 帧 · ${currentPredelayMs().toFixed(1)} ms`
    : `<b>${state.predelayFrames}</b> 帧`;
  el.wetReadout.innerHTML = `<b>${state.wetRatio.toFixed(3)}</b>`;

  const dryPct = Math.round((1 - state.wetRatio) * 1000) / 10;
  const wetPct = Math.round(state.wetRatio * 1000) / 10;
  el.mixDry.textContent = `${dryPct}%`;
  el.mixWet.textContent = `${wetPct}%`;
  el.mixDryBar.style.width = `${dryPct}%`;
  el.mixWetBar.style.width = `${wetPct}%`;

  const ms = currentPredelayMs();
  for (const btn of el.predelayPresets.querySelectorAll('.preset')) {
    const presetMs = Number(btn.dataset.ms);
    btn.classList.toggle('active', Math.abs(presetMs - ms) < 0.05);
  }
}

function currentPredelayMs() {
  return state.sampleRate ? toMs(state.predelayFrames, state.sampleRate) : 0;
}

let analyzeDebounce = null;

function onParamsChanged() {
  invalidateAnalysis();
  renderDerived();
  renderControls();
  // 拖动滑块会连续触发；短暂合并，避免堆积大量已作废的任务
  if (analyzeDebounce) clearTimeout(analyzeDebounce);
  analyzeDebounce = setTimeout(() => {
    analyzeDebounce = null;
    scheduleAnalyze();
  }, 90);
}

/* ── 失效 / 分析 ──────────────────────────────────────── */

function invalidateAnalysis() {
  state.generation++;
  if (state.analyzeTask) {
    cancelTask(state.analyzeTask);
    state.analyzeTask = null;
    // 旧任务已作废但新任务尚未启动：显示准备状态（保持忙碌，取消按钮仍可用）
    setBusy(true, '参数已改变，准备重新计算…');
  }
  if (state.exportTask) {
    cancelTask(state.exportTask);
    state.exportTask = null;
  }
  state.analyzing = false;
  state.analyzeResult = null;
  el.outOverlay.classList.remove('show');
  stopPlayback();
}

function scheduleAnalyze() {
  if (analyzeDebounce) {
    clearTimeout(analyzeDebounce);
    analyzeDebounce = null;
  }
  if (!hasUsableInputs()) {
    setBusy(false, '等待有效输入。');
    el.outOverlay.classList.remove('show');
    el.outPlaceholder.textContent = '等待输入';
    el.outPlaceholder.classList.remove('hidden');
    drawOutputWaveform();
    return;
  }
  if (!state.workerAudioReady) {
    setBusy(false, '准备后台线程…');
    return;
  }
  startAnalysis();
}

function startAnalysis() {
  const generation = ++state.generation;
  state.analyzing = true;
  state.analyzeResult = null;
  hideExportReport();

  el.outOverlay.classList.add('show');
  el.outOverlayText.textContent = '计算中… 0%';
  el.outOverlayFill.style.width = '0%';
  el.outPlaceholder.classList.add('hidden');
  setBusy(true, '正在卷积…', 0);
  renderControls();

  const task = startAnalyze(
    {
      predelayFrames: state.predelayFrames,
      wetRatio: state.wetRatio,
      envelopeBins: 4096,
    },
    {
      onProgress: (progress) => {
        if (generation !== state.generation) return;
        const pct = Math.max(0, Math.min(100, progress * 100));
        el.outOverlayFill.style.width = `${pct}%`;
        el.outOverlayText.textContent = `计算中… ${pct.toFixed(0)}%`;
        setBusy(true, `正在卷积… ${pct.toFixed(0)}%`, progress);
      },
    },
  );
  state.analyzeTask = task;

  task.promise
    .then((result) => {
      if (generation !== state.generation) return;
      state.analyzeTask = null;
      state.analyzing = false;
      state.analyzeResult = result;
      state.analysisCount += 1;
      document.body.dataset.analysisCount = String(state.analysisCount);
      el.outOverlay.classList.remove('show');
      setBusy(false, `已完成 · 用时 ${(result.elapsedMs / 1000).toFixed(2)} s · 峰值 ${formatDb(result.peak)}`);
      renderDerived();
      renderControls();
      drawOutputWaveform();
    })
    .catch((err) => {
      if (generation !== state.generation) return;
      state.analyzeTask = null;
      state.analyzing = false;
      el.outOverlay.classList.remove('show');
      if (err.cancelled) {
        // 参数变更导致的取消：继续执行新任务，状态由新任务接管
        return;
      }
      el.outPlaceholder.textContent = `计算失败：${err.message}`;
      el.outPlaceholder.classList.remove('hidden');
      setBusy(false, `计算失败：${err.message}`, null, true);
      renderControls();
    });
}

/* ── 派生显示 ─────────────────────────────────────────── */

function renderDerived() {
  const v = state.validation;
  const ok = v?.ok;

  el.chipRate.className = ok ? 'chip ok' : 'chip idle';
  el.chipRate.textContent = ok ? `${(state.sampleRate / 1000).toFixed(1)} kHz` : '采样率 —';
  if (ok) {
    el.chipState.className = 'chip ok';
    el.chipState.textContent = '输入就绪';
  } else if (v && v.errors.length) {
    el.chipState.className = 'chip bad';
    el.chipState.textContent = '输入不完整';
  } else {
    el.chipState.className = 'chip idle';
    el.chipState.textContent = '等待导入';
  }

  if (ok) {
    const N = fixedLength({
      dryFrames: v.dryFrames,
      maxIrFrames: v.maxIrFrames,
      predelayFrames: state.predelayFrames,
    });
    const tail = tailLength({ maxIrFrames: v.maxIrFrames, predelayFrames: state.predelayFrames });
    el.statRate.textContent = `${(state.sampleRate / 1000).toFixed(1)} kHz`;
    el.statRateSub.textContent = v.details.dry.present
      ? `干声 ${nf(v.details.dry.frames)} 帧 · IR 4 条`
      : '干声缺失，按零补齐';
    el.statLength.textContent = formatTime(N / state.sampleRate);
    el.statLengthSub.textContent = `${nf(N)} 帧`;
    el.statTail.textContent = formatTime(tail / state.sampleRate);
    el.statTailSub.textContent = `${nf(tail)} 帧，w = 0 也保留`;
  } else {
    el.statRate.textContent = '—';
    el.statRateSub.textContent = '全部文件一致后可用';
    el.statLength.textContent = '—';
    el.statLengthSub.textContent = '干声 + 最长 IR − 1 + 预延迟';
    el.statTail.textContent = '—';
    el.statTailSub.textContent = 'w = 0 时仍保留';
  }

  const result = state.analyzeResult;
  if (result) {
    el.statPeak.textContent = formatDb(result.peak);
    el.statPeak.className = `stat-value${result.peak > 1 ? ' critical' : ''}`;
    el.statPeakSub.textContent = `超限样本 ${nf(result.overCount)}`;
  } else {
    el.statPeak.textContent = '—';
    el.statPeak.className = 'stat-value';
    el.statPeakSub.textContent = '超限样本 —';
  }

  renderLengthSummary();
  renderFormula();
  renderRouting();
}

function renderLengthSummary() {
  const v = state.validation;
  if (!v?.ok) {
    el.lengthSummary.innerHTML =
      '<div class="length-row"><span class="name">等待有效输入</span><span class="val">—</span></div>';
    if (el.lengthTotal) el.lengthTotal.textContent = '—';
    return;
  }
  const rate = state.sampleRate;
  const N = fixedLength({
    dryFrames: v.dryFrames,
    maxIrFrames: v.maxIrFrames,
    predelayFrames: state.predelayFrames,
  });
  const tail = tailLength({ maxIrFrames: v.maxIrFrames, predelayFrames: state.predelayFrames });
  const rows = [
    ['干声', `${nf(v.dryFrames)} 帧 · ${((v.dryFrames / rate) * 1000).toFixed(1)} ms`, ''],
    ['最长 IR', `${nf(v.maxIrFrames)} 帧 · ${((v.maxIrFrames / rate) * 1000).toFixed(1)} ms`, ''],
    ['预延迟', `${nf(state.predelayFrames)} 帧 · ${currentPredelayMs().toFixed(1)} ms`, ''],
    ['尾长（IR − 1 + 预延迟）', `${nf(tail)} 帧 · ${((tail / rate) * 1000).toFixed(1)} ms`, 'tail'],
    ['输出总长 N', `${nf(N)} 帧 · ${formatTime(N / rate)}`, 'total'],
  ];
  el.lengthSummary.innerHTML = rows
    .map(([name, val, cls]) =>
      `<div class="length-row ${cls}"><span class="name">${name}</span><span class="val">${val}</span></div>`)
    .join('');
  if (el.lengthTotal) el.lengthTotal.innerHTML = `<b>${nf(N)}</b> 帧 · ${formatTime(N / rate)}`;
}

function renderFormula() {
  const w = state.wetRatio;
  const dw = 1 - w;
  el.formula.innerHTML = `
<span class="d">y<sub>L</sub>[t]</span> <span class="op">=</span> <span class="dry">${dw.toFixed(3)}</span>·dry<sub>L</sub>[t] <span class="op">+</span> <span class="wet">${w.toFixed(3)}</span>·( <span class="wet">LL</span>*in<sub>L</sub> + <span class="wet">LR</span>*in<sub>R</sub> )[t − ${state.predelayFrames}]<br>
<span class="d">y<sub>R</sub>[t]</span> <span class="op">=</span> <span class="dry">${dw.toFixed(3)}</span>·dry<sub>R</sub>[t] <span class="op">+</span> <span class="wet">${w.toFixed(3)}</span>·( <span class="wet">RL</span>*in<sub>L</sub> + <span class="wet">RR</span>*in<sub>R</sub> )[t − ${state.predelayFrames}]
<span class="note">干声权重 (1 − w) = ${dw.toFixed(3)}；预延迟只作用于湿声；不做归一化。</span>`;
}

function renderRouting() {
  el.routingMatrix.innerHTML = '';
  const corner = document.createElement('div');
  corner.className = 'matrix-corner';
  corner.innerHTML = '<span class="axis-hint">输出 ↓<br>输入 →</span>';
  el.routingMatrix.appendChild(corner);

  for (const [label, color] of [['L', 'var(--series-l)'], ['R', 'var(--series-r)']]) {
    const axis = document.createElement('div');
    axis.className = 'matrix-axis';
    axis.innerHTML = `<span class="dot" style="background:${color}"></span>输入 ${label}`;
    el.routingMatrix.appendChild(axis);
  }

  for (const [outCh, outName] of [['L', '左出'], ['R', '右出']]) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'matrix-axis axis-label';
    rowLabel.innerHTML = `<span class="out">输出 ${outCh}</span><span class="out-sub">${outName}</span>`;
    el.routingMatrix.appendChild(rowLabel);

    for (const inCh of ['L', 'R']) {
      const route = `${outCh}${inCh}`;
      const crosstalk = outCh !== inCh;
      const cell = document.createElement('div');
      cell.className = `matrix-cell${crosstalk ? ' crosstalk' : ''}`;
      const detail = state.validation?.ok
        ? state.validation.details.irs.find((d) => d.route === route)
        : null;
      const dotColor = outCh === 'L' ? 'var(--series-l)' : 'var(--series-r)';

      if (!detail) {
        cell.classList.add('empty');
        cell.innerHTML = `
          <div class="cell-top">
            <span class="cell-code">${route}</span>
            <span class="cell-tag">${crosstalk ? '串音' : '直达'}</span>
          </div>
          <div class="cell-route">${ROUTE_LABELS[route].desc}</div>
          <div class="cell-name">未导入</div>
          <div class="cell-meta">—</div>`;
      } else {
        cell.innerHTML = `
          <div class="cell-top">
            <span class="dot" style="width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block"></span>
            <span class="cell-code">${route}</span>
            <span class="cell-tag">${crosstalk ? '串音' : '直达'}</span>
          </div>
          <div class="cell-route">${ROUTE_LABELS[route].desc}</div>
          <div class="cell-name" title="${escapeHtml(detail.name)}">${escapeHtml(detail.name)}</div>
          <div class="cell-meta"><span>${nf(detail.frames)} 帧 · ${(detail.duration * 1000).toFixed(1)} ms</span><span>峰值 ${formatDb(detail.peak)}</span></div>`;
      }
      el.routingMatrix.appendChild(cell);
    }
  }
}

function renderAlerts() {
  const v = state.validation;
  el.alerts.innerHTML = '';
  if (v && v.errors.length) {
    for (const err of v.errors) {
      const box = document.createElement('div');
      box.className = 'alert';
      box.innerHTML = `<span class="icon" aria-hidden="true">!</span><div><b>${escapeHtml(err.file)}</b>：${escapeHtml(err.message)}</div>`;
      el.alerts.appendChild(box);
    }
  }
  if (v?.ok && !v.details.dry.present) {
    const box = document.createElement('div');
    box.className = 'alert info';
    box.innerHTML =
      '<span class="icon" aria-hidden="true">i</span><div>未提供干声，按零输入处理；输出仍按固定长度保留尾段。</div>';
    el.alerts.appendChild(box);
  }
}

function renderControls() {
  const ok = hasUsableInputs();
  el.predelayRange.disabled = !ok;
  el.predelayFrames.disabled = !ok;
  el.wetRange.disabled = !ok;
  el.wetNumber.disabled = !ok;
  for (const btn of el.predelayPresets.querySelectorAll('.preset')) btn.disabled = !ok;

  el.playDry.disabled = !state.files.dry?.parsed;
  el.playWet.disabled = !state.analyzeResult;
  el.exportBtn.disabled = !(ok && !state.exporting);
  el.stopPlay.disabled = !state.activePlayback;
}

/* ── 波形绘制 ─────────────────────────────────────────── */

function redrawInputs() {
  drawDryWaveform();
  drawIrTiles();
  if (state.analyzeResult) drawOutputWaveform();
}

function drawDryWaveform() {
  const dry = state.files.dry?.parsed;
  if (!dry) {
    el.dryPlaceholder.classList.remove('hidden');
    el.dryPlaceholder.textContent = '尚未导入双声道干声';
    clearCanvas(el.dryWave);
    el.dryCaption.textContent = '—';
    el.dryFoot.textContent = '—';
    return;
  }
  el.dryPlaceholder.classList.add('hidden');
  const bins = Math.max(200, Math.round(el.dryWave.getBoundingClientRect().width || 600));
  drawMirroredWaveform(el.dryWave, {
    left: envelopeFromPcm(dry.data[0], bins),
    right: envelopeFromPcm(dry.data[1] || dry.data[0], bins),
    peak: dry.peak,
  });
  el.dryCaption.textContent = `${dry.peak > 0 ? formatDb(dry.peak) : '−∞ dB'} 峰值 · ${formatTime(dry.duration)}`;
  el.dryFoot.textContent = `${nf(dry.frames)} 帧 · ${(dry.sampleRate / 1000).toFixed(1)} kHz`;
}

function drawIrTiles() {
  el.irGrid.innerHTML = '';
  const ok = state.validation?.ok;
  let longest = null;
  ROUTES.forEach((route, i) => {
    const detail = ok ? state.validation.details.irs.find((d) => d.route === route) : null;
    const tile = document.createElement('div');
    tile.className = 'ir-tile';
    tile.innerHTML = `
      <div class="ir-head">
        <span class="code">${route}</span>
        <span class="len">${detail ? `${(detail.duration * 1000).toFixed(1)} ms` : '—'}</span>
      </div>
      <div class="wave-frame"><canvas role="img" aria-label="IR ${route} 波形"></canvas></div>
      <div class="ir-foot">${detail ? `${nf(detail.frames)} 帧 · ${detail.bits}-bit` : '未导入'}</div>`;
    el.irGrid.appendChild(tile);

    const canvas = tile.querySelector('canvas');
    if (detail) {
      const bins = Math.max(80, Math.round(canvas.getBoundingClientRect().width || 160));
      drawMonoWaveform(canvas, envelopeFromPcm(state.validation.irs[i], bins), detail.peak);
      if (!longest || detail.frames > longest.frames) longest = detail;
    } else {
      clearCanvas(canvas);
    }
  });
  el.irFoot.textContent = longest
    ? `最长 ${longest.route} · ${nf(longest.frames)} 帧 · ${formatTime(longest.duration)}`
    : '—';
}

function drawOutputWaveform() {
  const result = state.analyzeResult;
  if (!result) {
    el.outPlaceholder.classList.remove('hidden');
    el.outPlaceholder.textContent = '等待计算';
    clearCanvas(el.outWave);
    el.outCaption.textContent = '—';
    el.outFoot.textContent = '—';
    return;
  }
  el.outPlaceholder.classList.add('hidden');
  const dryFrames = state.validation?.dryFrames || 0;
  drawMirroredWaveform(el.outWave, {
    left: result.envelope.left,
    right: result.envelope.right,
    tailFraction: result.totalFrames ? dryFrames / result.totalFrames : null,
    peak: result.peak,
  });
  const overText = result.overCount ? `超限 ${nf(result.overCount)} 样本` : '无超限';
  el.outCaption.textContent = `峰值 ${formatDb(result.peak)} · ${overText}`;
  el.outFoot.textContent =
    `${nf(result.totalFrames)} 帧 · ${formatTime(result.totalFrames / state.sampleRate)} · 尾段 ${nf(
      tailLength({ maxIrFrames: result.maxIrFrames, predelayFrames: result.predelayFrames }),
    )} 帧`;
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/* ── 试听 ─────────────────────────────────────────────── */

function stopPlayback() {
  state.playToken++;
  player.stop();
  state.activePlayback = null;
  el.stopPlay.disabled = true;
  el.nowPlaying.textContent = '未播放';
  el.nowPlaying.classList.remove('active');
}

function startPlaybackUI(label) {
  state.activePlayback = label;
  el.stopPlay.disabled = false;
  el.nowPlaying.classList.add('active');
}

function playbackLabel(prefix, progress, duration) {
  const cur = duration * progress;
  const m = Math.floor(cur / 60);
  const s = cur - m * 60;
  return `${prefix} · ${(progress * 100).toFixed(0)}% · ${m}:${s.toFixed(1).padStart(4, '0')}`;
}

async function playDry() {
  const dry = state.files.dry?.parsed;
  if (!dry) return;
  stopPlayback();
  const token = state.playToken;
  const duration = dry.duration;
  try {
    await player.playBuffers({
      left: dry.data[0],
      right: dry.data[1] || dry.data[0],
      sampleRate: dry.sampleRate,
      onProgress: (p) => {
        if (token !== state.playToken) return;
        el.nowPlaying.textContent = playbackLabel('处理前', p, duration);
      },
      onEnded: () => {
        if (token !== state.playToken) return;
        state.activePlayback = null;
        el.stopPlay.disabled = true;
        el.nowPlaying.textContent = '播放结束';
        el.nowPlaying.classList.remove('active');
        renderControls();
      },
    });
    if (token !== state.playToken) return;
    startPlaybackUI('dry');
    el.nowPlaying.textContent = playbackLabel('处理前', 0, duration);
    renderControls();
  } catch (err) {
    flashStatus(`无法播放：${err.message}`, true);
  }
}

async function playWet() {
  if (!state.analyzeResult || !hasUsableInputs()) return;
  stopPlayback();
  const token = state.playToken;
  const generation = state.generation;
  const totalFrames = state.analyzeResult.totalFrames;
  const duration = totalFrames / state.sampleRate;

  try {
    await player.playStreaming({
      sampleRate: state.sampleRate,
      totalFrames,
      fetchSegment: (startFrame, endFrame) =>
        startRender(
          { predelayFrames: state.predelayFrames, wetRatio: state.wetRatio },
          startFrame,
          endFrame,
        ).promise.then((msg) => ({ left: msg.left, right: msg.right })),
      onProgress: (p) => {
        if (token !== state.playToken || generation !== state.generation) return;
        el.nowPlaying.textContent = playbackLabel('处理后', p, duration);
      },
      onEnded: () => {
        if (token !== state.playToken) return;
        state.activePlayback = null;
        el.stopPlay.disabled = true;
        el.nowPlaying.textContent = '播放结束';
        el.nowPlaying.classList.remove('active');
        renderControls();
      },
    });
    if (token !== state.playToken || generation !== state.generation) {
      player.stop();
      return;
    }
    startPlaybackUI('wet');
    el.nowPlaying.textContent = playbackLabel('处理后', 0, duration);
    renderControls();
  } catch (err) {
    if (!err.cancelled) flashStatus(`无法播放：${err.message}`, true);
  }
}

/* ── 导出 ─────────────────────────────────────────────── */

async function exportWav() {
  if (!hasUsableInputs() || state.exporting) return;
  state.exporting = true;
  const generation = state.generation;
  const sampleRate = state.sampleRate;
  const filename = `matrix-room-${sampleRate / 1000}kHz-w${state.wetRatio.toFixed(3)}-pd${state.predelayFrames}.wav`;

  el.exportBtn.disabled = true;
  el.exportBtn.textContent = '正在生成…';
  setBusy(true, '正在生成 24-bit WAV…', 0);

  try {
    const task = startExport(
      { predelayFrames: state.predelayFrames, wetRatio: state.wetRatio },
      {
        onProgress: (p) => {
          if (generation === state.generation) {
            setBusy(true, `正在生成 24-bit WAV… ${(p * 100).toFixed(0)}%`, p);
          }
        },
      },
    );
    state.exportTask = task;
    const result = await task.promise;
    state.exportTask = null;

    if (generation !== state.generation) {
      setBusy(false, '参数已改变，导出结果已丢弃。', null, true);
      return;
    }

    const blob = new Blob([result.wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    showExportReport(result, filename);
    setBusy(false, `已导出 ${filename} · 量化前峰值 ${formatDb(result.peak)}`);
  } catch (err) {
    // 若是参数变化导致失效，状态条与忙碌态交给新任务，不在这里覆盖
    if (generation === state.generation) {
      if (err.cancelled) setBusy(false, '已取消导出。');
      else setBusy(false, `导出失败：${err.message}`, null, true);
    }
  } finally {
    state.exporting = false;
    state.exportTask = null;
    el.exportBtn.textContent = '导出 24-bit WAV';
    renderControls();
  }
}

function showExportReport(result, filename) {
  el.exportReport.classList.add('show');
  el.exportFile.textContent = filename;
  el.repPeak.textContent = formatDb(result.peak);
  el.repPeak.className = `v${result.peak > 1 ? ' critical' : ''}`;
  el.repOver.textContent = nf(result.overCount);
  el.repOver.className = `v${result.overCount ? ' warn' : ''}`;
  el.repClamp.textContent = nf(result.clampCount);
  el.repClamp.className = `v${result.clampCount ? ' critical' : ''}`;
  el.repFoot.innerHTML =
    `左 / 右超限样本：${nf(result.overL)} / ${nf(result.overR)}；` +
    `输出 ${nf(result.totalFrames)} 帧 · ${formatTime(result.totalFrames / state.sampleRate)}。` +
    (result.overCount
      ? ' 超限样本仅在写入 24-bit PCM 时限幅，处理与试听路径保持原值。'
      : ' 所有样本都在 ±1 量程内，导出无需限幅。');
}

function hideExportReport() {
  el.exportReport.classList.remove('show');
}

/* ── 状态条 ───────────────────────────────────────────── */

function setStatus(text) {
  el.statusText.textContent = text;
  el.statusText.style.color = '';
}

function flashStatus(text, isError = false) {
  el.statusText.textContent = text;
  el.statusText.style.color = isError ? 'var(--critical)' : '';
  if (!el.statusStrip.classList.contains('busy')) {
    setTimeout(() => {
      if (!el.statusStrip.classList.contains('busy') && el.statusText.textContent === text) {
        el.statusText.style.color = '';
        el.statusText.textContent = '就绪。';
      }
    }, 6000);
  }
}

function setBusy(busy, text, progress = null, isError = false) {
  el.statusStrip.classList.toggle('busy', busy);
  el.statusText.textContent = text;
  el.statusText.style.color = isError ? 'var(--critical)' : '';
  if (progress != null) el.statusFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  if (!busy) el.statusFill.style.width = '0%';
  // 始终占位，只切换可用状态：避免按钮出现/消失造成布局跳动与误点
  el.cancelTask.disabled = !busy;
}

/* ── 样例 ─────────────────────────────────────────────── */

async function loadSampleList() {
  let manifest = [];
  try {
    const res = await fetch('/api/samples', { cache: 'no-store' });
    if (res.ok) manifest = await res.json();
  } catch {
    manifest = [];
  }
  state.sampleManifest = manifest;
  el.sampleSelect.innerHTML = '<option value="">内置样例</option>';
  if (!manifest.length) {
    el.sampleHint.textContent = '未找到样例包（samples/matrix-room.zip）';
    return;
  }
  for (const entry of manifest) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.title;
    el.sampleSelect.appendChild(opt);
  }
  el.sampleHint.textContent = `${manifest.length} 个样例 · 来自 samples/matrix-room.zip`;
}

async function loadSampleById(id) {
  const entry = state.sampleManifest.find((item) => item.id === id);
  if (!entry) return;

  const token = ++state.sampleLoadToken;
  state.loadingSample = true;
  setBusy(true, `正在载入样例「${entry.title}」…`);
  const next = { dry: null, LL: null, LR: null, RL: null, RR: null };
  try {
    for (const [key, rel] of Object.entries(entry.files)) {
      if (token !== state.sampleLoadToken) return;
      const res = await fetch(`/api/sample?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`无法读取 ${rel}（HTTP ${res.status}）`);
      const buffer = await res.arrayBuffer();
      next[key] = { name: rel.split('/').pop(), parsed: parseWav(buffer) };
    }
    state.files = next;
    if (entry.case && typeof entry.case.wet_ratio === 'number') {
      state.wetRatio = Math.min(1, Math.max(0, entry.case.wet_ratio));
    }
    if (entry.case && Number.isInteger(entry.case.predelay_frames)) {
      state.predelayFrames = entry.case.predelay_frames;
    }
    if (token !== state.sampleLoadToken) return;
    clampPredelay();
    onFilesChanged();
    syncParamInputs();
    setBusy(false, `已载入样例「${entry.title}」。`);
  } catch (err) {
    if (token !== state.sampleLoadToken) return;
    setBusy(false, `样例载入失败：${err.message}`, null, true);
  } finally {
    if (token === state.sampleLoadToken) state.loadingSample = false;
  }
}

/* ── 事件 ─────────────────────────────────────────────── */

function buildPresets() {
  const values = [0, 5, 10, 20, 40, 80, 200];
  el.predelayPresets.innerHTML = '';
  for (const ms of values) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.dataset.ms = String(ms);
    btn.textContent = `${ms} ms`;
    btn.addEventListener('click', () => {
      if (!state.sampleRate) return;
      setPredelay(Math.round((ms / 1000) * state.sampleRate));
    });
    el.predelayPresets.appendChild(btn);
  }
}

function cancelCurrentTask() {
  if (analyzeDebounce) {
    clearTimeout(analyzeDebounce);
    analyzeDebounce = null;
  }
  if (analyzeDebounce && !state.analyzeTask && !state.exporting && !state.loadingSample) {
    analyzeDebounce = null;
    state.generation++;
    el.outOverlay.classList.remove('show');
    el.outPlaceholder.textContent = '已取消';
    el.outPlaceholder.classList.remove('hidden');
    state.analyzeResult = null;
    setBusy(false, '已取消计算。');
    renderDerived();
    renderControls();
    return;
  }
  if (state.loadingSample) {
    state.sampleLoadToken++;
    state.loadingSample = false;
    setBusy(false, '已取消载入样例。');
    return;
  }
  if (state.exporting) {
    // 导出任务也走 Worker，取消后等待 finally 收尾
    if (state.exportTask) cancelTask(state.exportTask);
    return;
  }
  // 没有在跑的任务也把忙碌态收干净，避免状态条停留在过期进度上
  if (state.analyzeTask) {
    cancelTask(state.analyzeTask);
    state.analyzeTask = null;
  }
  state.analyzing = false;
  state.generation++;
  el.outOverlay.classList.remove('show');
  el.outPlaceholder.textContent = '已取消';
  el.outPlaceholder.classList.remove('hidden');
  el.analyzeResult = null;
  setBusy(false, '已取消计算。');
  renderDerived();
  renderControls();
}

function bindEvents() {
  el.predelayRange.addEventListener('input', () => setPredelay(Number(el.predelayRange.value)));
  el.predelayFrames.addEventListener('input', () => {
    if (el.predelayFrames.value === '') return;
    setPredelay(Number(el.predelayFrames.value));
  });
  el.predelayFrames.addEventListener('blur', () => {
    setPredelay(Number(el.predelayFrames.value) || 0);
  });

  el.wetRange.addEventListener('input', () => setWet(Number(el.wetRange.value)));
  el.wetNumber.addEventListener('input', () => {
    if (el.wetNumber.value === '') return;
    setWet(Number(el.wetNumber.value));
  });
  el.wetNumber.addEventListener('blur', () => {
    setWet(Number(el.wetNumber.value) || 0);
  });

  el.loadSample.addEventListener('click', () => {
    const id = el.sampleSelect.value;
    if (id) loadSampleById(id);
    else flashStatus('请先选择一个样例。');
  });

  el.playDry.addEventListener('click', playDry);
  el.playWet.addEventListener('click', playWet);
  el.stopPlay.addEventListener('click', stopPlayback);
  el.exportBtn.addEventListener('click', exportWav);
  el.cancelTask.addEventListener('click', cancelCurrentTask);
  el.outCancel.addEventListener('click', cancelCurrentTask);

  const shell = document.querySelector('.shell');
  shell.addEventListener('dragover', (event) => event.preventDefault());
  shell.addEventListener('drop', (event) => {
    if (event.target.closest('.slot')) return;
    event.preventDefault();
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) assignFiles(files);
  });

  window.addEventListener('resize', debounce(redrawInputs, 120));
  window.addEventListener('beforeunload', () => player.stop());

  bindWaveTooltip(el.dryWave, el.dryTooltip, () => {
    const dry = state.files.dry?.parsed;
    if (!dry) return null;
    return (frac) => {
      const frame = Math.max(0, Math.min(dry.frames - 1, Math.round(frac * (dry.frames - 1))));
      const l = dry.data[0][frame] ?? 0;
      const r = dry.data[1]?.[frame] ?? 0;
      return `<div class="t">${formatTime(frame / dry.sampleRate)} · 帧 ${nf(frame)}</div>
        <div class="row"><span class="dot" style="background:var(--series-l)"></span>L ${fmtAmp(l)}</div>
        <div class="row"><span class="dot" style="background:var(--series-r)"></span>R ${fmtAmp(r)}</div>`;
    };
  });

  bindWaveTooltip(el.outWave, el.outTooltip, () => {
    const result = state.analyzeResult;
    if (!result?.envelope) return null;
    return (frac) => {
      const env = result.envelope;
      const idx = Math.min(env.bins - 1, Math.max(0, Math.floor(frac * env.bins)));
      const frame = Math.round(frac * (result.totalFrames - 1));
      return `<div class="t">${formatTime(frame / state.sampleRate)} · 帧 ${nf(frame)}</div>
        <div class="row"><span class="dot" style="background:var(--series-l)"></span>L 包络峰值 ${fmtAmp(env.left[idx])}</div>
        <div class="row"><span class="dot" style="background:var(--series-r)"></span>R 包络峰值 ${fmtAmp(env.right[idx])}</div>`;
    };
  });
}

function bindWaveTooltip(canvas, tooltip, getInfo) {
  const frame = canvas.parentElement;
  canvas.addEventListener('pointermove', (event) => {
    const info = getInfo();
    if (!info) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const frac = rect.width ? x / rect.width : 0;
    const html = info(frac);
    if (!html) return;
    tooltip.innerHTML = html;
    tooltip.classList.add('show');
    tooltip.style.left = `${Math.max(70, Math.min(rect.width - 70, x))}px`;
    tooltip.style.top = `${Math.max(60, event.clientY - frame.getBoundingClientRect().top - 10)}px`;
  });
  canvas.addEventListener('pointerleave', () => tooltip.classList.remove('show'));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ── 启动 ─────────────────────────────────────────────── */

function init() {
  bindEls();
  buildSlots();
  buildPresets();
  bindEvents();
  syncParamInputs();
  renderDerived();
  renderAlerts();
  renderControls();
  drawIrTiles();
  drawDryWaveform();
  loadSampleList();
  setStatus('导入干声与四条脉冲响应，或加载内置样例。');

  requestAnimationFrame(() => {
    drawDryWaveform();
    drawIrTiles();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
