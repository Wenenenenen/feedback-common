/*
 * 主线程：界面状态、导入校验、参数编辑、渲染调度、试听、导出。
 *
 * 数据流：
 *   WAV/样例 → Worker（load：转规范序）→ 主线程编辑参数
 *   → Worker（render：整段旋转 + 监听立体声）→ 时间轴 / 电平 / 方向示意 / 播放器
 *   → Worker（export：重新渲染 → 24-bit WAV / 格式 JSON）
 *
 * 预览与导出都调用同一个 renderCanonical()，曲线与量化保证一致。
 */

import { AutomationError, parseAutomationJson, serializeAutomation, validateKeyframes } from './automation.js';
import { FORMAT_SPECS, conversionMatrix, formatSpec } from './ambisonic.js';
import { DEFAULT_MONITOR_ROWS, MonitorPlayer, sanitizeMonitorRows } from './player.js';
import { drawDirection, drawTimeline, formatInt, formatTime } from './draw.js';
import {
  eulerDegFromQuat,
  normalizeQuat,
  quatFromEulerDeg,
  vectorToSpherical,
  wrapDeg,
} from './quaternion.js';
import { MODES, RotationInputError, buildAutomationRotation, buildStaticRotation } from './rotation-mode.js';
import { parseWav, WavError } from './wav.js';

const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 60;

/* ── 状态 ───────────────────────────────────────────── */
const state = {
  source: null,        // {name, sampleRate, bitsPerSample, frames, data, formatTag}
  inputFormat: 'ambix',
  outputFormat: 'ambix',
  mode: 'static',
  yaw: 0,
  pitch: 0,
  roll: 0,
  keyframes: [],       // [{frame, q:[w,x,y,z]}] 原始编辑值（未归一化的输入原值）
  keyframeError: null,
  keyframeWarnings: [],
  rotation: null,      // 当前生效 rotation 对象（已归一化/对齐）
  rendered: null,      // {stats, stereo, planes?}
  renderId: 0,
  exportId: 0,
  exportJsonPending: false,
  monitorRows: DEFAULT_MONITOR_ROWS,
  conventions: null,
  samples: null,
  reference: null,     // {name, path} 参考文件元数据
  playhead: 0,
  playing: false,
  envelopes: null,
  loadedSampleId: null,
};

const worker = new Worker(new URL('./rotation-worker.js', import.meta.url), { type: 'module' });
const player = new MonitorPlayer();

/* ══════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════ */

function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  const strip = $('status-strip');
  strip.classList.remove('busy', 'ok', 'error');
  if (kind) strip.classList.add(kind);
}

function showMessage(container, kind, html) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!html) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="msg ${kind}">${html}</div>`;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDb(peak) {
  if (!(peak > 0)) return '−∞ dBFS';
  const db = 20 * Math.log10(peak);
  return `${db >= 0 ? '+' : ''}${db.toFixed(2)} dBFS`;
}

function fmtFloat(v, digits = 6) {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

/** 把秒换算为帧号并夹在 [0, N-1]。 */
function secondsToFrame(sec) {
  if (!state.source) return 0;
  const f = Math.round(sec * state.source.sampleRate);
  return Math.max(0, Math.min(state.source.frames - 1, f));
}

function frameToSeconds(frame) {
  if (!state.source) return 0;
  return frame / state.source.sampleRate;
}

/* ══════════════════════════════════════════════════════
 * Worker 通信
 * ══════════════════════════════════════════════════════ */
const pending = new Map();

function callWorker(message, transfer = []) {
  return new Promise((resolve, reject) => {
    if (message.id == null) message.id = ++state.renderId;
    pending.set(message.id, { resolve, reject });
    worker.postMessage(message, transfer);
  });
}

worker.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.id == null) return;
  const entry = pending.get(msg.id);
  if (!entry) return;

  switch (msg.type) {
    case 'loaded':
      pending.delete(msg.id);
      entry.resolve(msg);
      break;
    case 'progress':
      if (msg.id === state.renderId) updateProgress(msg.done, msg.total, msg.stage);
      break;
    case 'rendered':
      pending.delete(msg.id);
      entry.resolve(msg);
      break;
    case 'exported':
      pending.delete(msg.id);
      entry.resolve(msg);
      break;
    case 'compared':
      pending.delete(msg.id);
      entry.resolve(msg);
      break;
    case 'error':
      pending.delete(msg.id);
      if (msg.cancelled) {
        const err = new Error('已取消');
        err.cancelled = true;
        entry.reject(err);
      } else {
        const err = new Error(msg.message);
        err.overflow = msg.overflow;
        err.stats = msg.stats;
        entry.reject(err);
      }
      break;
    default:
      break;
  }
};

worker.onerror = (ev) => {
  console.error('worker error', ev);
  setStatus('计算线程出错', 'error');
};

function updateProgress(done, total, stage) {
  const track = $('render-progress-track');
  const fill = $('render-progress');
  const ratio = total > 0 ? done / total : 0;
  if (ratio >= 1) {
    track.hidden = true;
    return;
  }
  track.hidden = false;
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  if (stage === 'export') setStatus(`正在渲染导出… ${(ratio * 100).toFixed(0)}%`, 'busy');
  else setStatus(`正在旋转… ${(ratio * 100).toFixed(0)}%`, 'busy');
}

/* ══════════════════════════════════════════════════════
 * 载入音频
 * ══════════════════════════════════════════════════════ */

async function loadWavArrayBuffer(buffer, name, opts = {}) {
  let parsed;
  try {
    parsed = parseWav(buffer);
  } catch (err) {
    if (err instanceof WavError) {
      setStatus(`无法读取 ${name}：${err.message}`, 'error');
      showSourceError(`${err.message}`);
      return false;
    }
    throw err;
  }

  state.source = {
    name,
    sampleRate: parsed.sampleRate,
    bitsPerSample: parsed.bitsPerSample,
    frames: parsed.frames,
    formatTag: parsed.formatTag,
    channelMask: parsed.channelMask,
    peak: parsed.peak,
    data: parsed.data,
  };
  state.loadedSampleId = opts.sampleId || null;
  state.reference = opts.reference || null;
  state.rendered = null;
  state.envelopes = null;
  state.playhead = 0;
  player.clear();

  if (opts.inputFormat) setInputFormat(opts.inputFormat, false);
  // 只更新选择状态；渲染等新音频载入 Worker 之后再统一触发
  if (opts.outputFormat) setOutputFormatSilent(opts.outputFormat);

  showSourceInfo();
  $('source-info').hidden = false;
  $('dropzone').hidden = true;
  $('reference-card').hidden = !state.reference;
  renderFormatMatrices();
  updateTransportBounds();

  player.setVolume(parseFloat($('volume').value));
  player.onStateChange(() => {
    state.playing = player.playing;
    updatePlayIcon();
    if (!player.playing) {
      // 播放到结尾时同步游标
      state.playhead = player.currentFrame();
      syncTransportFromPlayhead(false);
    }
  });

  // 发送副本给 Worker：主线程保留原始数据用于帧内读数与格式切换后的重载，
  // 避免 transfer 把本地视图置空。
  const workerPlanes = parsed.data.map((p) => p.slice());
  const loadMsg = await callWorker({
    type: 'load',
    id: ++state.renderId,
    planes: workerPlanes,
    inputFormat: state.inputFormat,
    sampleRate: parsed.sampleRate,
  }, workerPlanes.map((p) => p.buffer));

  updateProgress(1, 1, 'render');
  setStatus(`已载入 ${name}`, 'ok');
  state.source.channelPeaks = loadMsg.channelPeaks;
  await refreshRender({ reason: 'load' });
  updateTimeline();
  drawDirectionForCurrentFrame();
  return true;
}

function showSourceError(message) {
  const info = $('source-info');
  info.hidden = true;
  $('dropzone').hidden = false;
  showMessage('kf-status', 'error', esc(message));
  $('export-wav').disabled = true;
  $('export-json').disabled = true;
  // 读取失败时清掉旧音频，否则改角度会拿上一份文件重新渲染，
  // 界面会出现「新文件读失败但导出又变可用」的矛盾状态。
  state.source = null;
  state.rendered = null;
  state.envelopes = null;
  state.loadedSampleId = null;
  state.reference = null;
  $('reference-card').hidden = true;
  player.clear();
  updateStats(null);
  updateTransportBounds();
  updateTimeline();
  updateFrameValues();
  drawDirectionForCurrentFrame();
}

function showSourceInfo() {
  const s = state.source;
  if (!s) return;
  const chips = [];
  chips.push(`<span class="chip">文件 <b>${esc(s.name)}</b></span>`);
  chips.push(`<span class="chip">采样率 <b>${(s.sampleRate / 1000).toFixed(1)} kHz</b></span>`);
  chips.push(`<span class="chip">位深 <b>${s.bitsPerSample}-bit</b></span>`);
  chips.push(`<span class="chip">声道 <b>4</b></span>`);
  chips.push(`<span class="chip">帧数 <b>${formatInt(s.frames)}</b></span>`);
  chips.push(`<span class="chip">时长 <b>${formatTime(s.frames / s.sampleRate)}</b></span>`);
  chips.push(`<span class="chip">峰值 <b>${fmtDb(s.peak)}</b></span>`);
  if (s.channelMask != null) {
    chips.push(
      s.channelMask === 0
        ? '<span class="chip">无扬声器掩码（一阶 B-format 正常）</span>'
        : `<span class="chip">声道掩码 <b>0x${s.channelMask.toString(16)}</b>（不用于判断格式）</span>`,
    );
  }
  $('source-meta').innerHTML = chips.join('');
}

/* ══════════════════════════════════════════════════════
 * 格式
 * ══════════════════════════════════════════════════════ */

function setInputFormat(id, rerender = true) {
  if (!FORMAT_SPECS[id]) return;
  state.inputFormat = id;
  $(id === 'ambix' ? 'in-ambix' : 'in-fuma').checked = true;
  renderFormatMatrices();
  if (rerender) {
    // 输入格式变化需要 Worker 重新换算规范序
    if (state.source) reloadIntoWorker();
  }
}

function setOutputFormat(id) {
  if (!FORMAT_SPECS[id]) return;
  state.outputFormat = id;
  $(id === 'ambix' ? 'out-ambix' : 'out-fuma').checked = true;
  refreshRender({ reason: 'output-format' });
}

async function reloadIntoWorker() {
  if (!state.source) return;
  const { data, sampleRate } = state.source;
  const copies = data.map((p) => p.slice());
  try {
    const msg = await callWorker({
      type: 'load',
      id: ++state.renderId,
      planes: copies,
      inputFormat: state.inputFormat,
      sampleRate,
    }, copies.map((p) => p.buffer));
    state.source.channelPeaks = msg.channelPeaks;
    await refreshRender({ reason: 'input-format' });
  } catch (err) {
    setStatus(`格式换算失败：${err.message}`, 'error');
  }
}

function renderFormatMatrices() {
  if (!state.source) return;
  const m = conversionMatrix(state.inputFormat, state.outputFormat || state.inputFormat);
  const inOrder = FORMAT_SPECS[state.inputFormat].order;
  const canon = ['W', 'Y', 'Z', 'X'];
  let html = '<table class="matrix"><thead><tr><th></th>';
  for (const c of canon) html += `<th>${c}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 0; r < 4; r++) {
    html += `<tr><th class="rowhead">${inOrder[r]}</th>`;
    for (let c = 0; c < 4; c++) {
      const v = m[r * 4 + c];
      const cls = Math.abs(v) < 1e-12 ? 'zero' : '';
      html += `<td class="${cls}">${Math.abs(v) < 1e-12 ? '0' : v.toFixed(4)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  $('conv-matrix').innerHTML = html;

  const rows = state.monitorRows;
  let mon = '<table class="matrix"><thead><tr><th></th>';
  for (const c of canon) mon += `<th>${c}</th>`;
  mon += '</tr></thead><tbody>';
  ['L', 'R'].forEach((label, r) => {
    mon += `<tr><th class="rowhead">${label}</th>`;
    for (let c = 0; c < 4; c++) {
      const v = rows[r][c];
      const cls = Math.abs(v) < 1e-12 ? 'zero' : '';
      mon += `<td class="${cls}">${Math.abs(v) < 1e-12 ? '0' : v.toFixed(4)}</td>`;
    }
    mon += '</tr>';
  });
  mon += '</tbody></table>';
  $('monitor-matrix').innerHTML = mon;

  const spec = formatSpec(state.inputFormat);
  $('channel-map').innerHTML = [
    `输入 ${esc(spec.id === 'ambix' ? 'AmbiX' : 'FuMa')}：<code>${spec.order.join(' ')}</code>`,
    `规范序：<code>W Y Z X</code>`,
    `W 换算：<code>× ${spec.wGainToCanonical.toFixed(4)}</code>`,
    `输出：<code>${FORMAT_SPECS[state.outputFormat].order.join(' ')}</code>`,
  ].join('');
}

/* ══════════════════════════════════════════════════════
 * 旋转参数
 * ══════════════════════════════════════════════════════ */

function setMode(mode, { rerender = true } = {}) {
  if (!MODES.includes(mode)) return;
  state.mode = mode;
  const isStatic = mode === 'static';
  $('mode-static').classList.toggle('active', isStatic);
  $('mode-automation').classList.toggle('active', !isStatic);
  $('mode-static').setAttribute('aria-checked', String(isStatic));
  $('mode-automation').setAttribute('aria-checked', String(!isStatic));
  $('static-panel').hidden = !isStatic;
  $('automation-panel').hidden = isStatic;
  $('mode-note').innerHTML = isStatic
    ? '当前只有静态欧拉角参与渲染；关键帧数据保留但不生效。'
    : '当前只有关键帧曲线参与渲染；静态角度值保留但不生效。';
  if (rerender) refreshRender({ reason: 'mode' });
}

function readAngleInputs() {
  return {
    yaw: $('yaw').value,
    pitch: $('pitch').value,
    roll: $('roll').value,
  };
}

function applyAngleInputs(fromRange = null) {
  const inputs = readAngleInputs();
  let yaw = Number(inputs.yaw);
  let pitch = Number(inputs.pitch);
  let roll = Number(inputs.roll);
  let ok = true;
  for (const [v, id] of [[yaw, 'yaw'], [pitch, 'pitch'], [roll, 'roll']]) {
    if (!Number.isFinite(v)) ok = false;
    if (!Number.isFinite(v)) $(id).setAttribute('aria-invalid', 'true');
    else $(id).removeAttribute('aria-invalid');
  }
  if (!ok) {
    $('euler-quat').textContent = '—';
    return false;
  }
  state.yaw = yaw;
  state.pitch = pitch;
  state.roll = roll;
  if (fromRange !== 'yaw') $('yaw-range').value = clampRange(yaw, 'yaw');
  if (fromRange !== 'pitch') $('pitch-range').value = clampRange(pitch, 'pitch');
  if (fromRange !== 'roll') $('roll-range').value = clampRange(roll, 'roll');
  const q = quatFromEulerDeg(yaw, pitch, roll);
  $('euler-quat').textContent = `[${q.map((v) => fmtFloat(v, 6)).join(', ')}]`;
  return true;
}

function clampRange(value, which) {
  const range = { yaw: [-180, 180], pitch: [-90, 90], roll: [-180, 180] }[which];
  return Math.max(range[0], Math.min(range[1], wrapDeg(value)));
}

function onAngleChange(source, which) {
  if (source === 'range') {
    const map = { yaw: 'yaw', pitch: 'pitch', roll: 'roll' };
    $(map[which]).value = $(`${which}-range`).value;
    $('euler-quat').textContent = '—';
  }
  applyAngleInputs(source === 'range' ? which : null);
  scheduleRender('angles');
}

let renderTimer = null;
function scheduleRender(reason) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    refreshRender({ reason });
  }, 90);
}

/* ══════════════════════════════════════════════════════
 * 构建 rotation 并刷新
 * ══════════════════════════════════════════════════════ */

function currentFrameLimit() {
  return state.source ? state.source.frames - 1 : null;
}

/**
 * 构建当前 rotation。无效时返回 {error}。
 */
function buildCurrentRotation() {
  try {
    if (state.mode === 'static') {
      const inputs = readAngleInputs();
      return { rotation: buildStaticRotation(inputs.yaw, inputs.pitch, inputs.roll) };
    }
    const raw = state.keyframes.map((k) => ({ frame: k.frame, q: k.q }));
    const built = buildAutomationRotation(raw, currentFrameLimit());
    return { rotation: built, warnings: built.warnings };
  } catch (err) {
    if (err instanceof RotationInputError || err instanceof AutomationError) {
      return { error: err };
    }
    throw err;
  }
}

let refreshSeq = 0;

async function refreshRender({ reason } = {}) {
  const seq = ++refreshSeq;
  const built = buildCurrentRotation();
  if (built.error) {
    state.rotation = null;
    state.rendered = null;
    state.keyframeError = built.error;
    updateKeyframeStatus();
    setStatus(`旋转参数无效：${built.error.message}`, 'error');
    $('export-wav').disabled = true;
    $('export-json').disabled = true;
    updateStats(null);
    updateTimeline();
    drawDirectionForCurrentFrame();
    return;
  }
  state.rotation = built.rotation;
  state.keyframeError = null;
  state.keyframeWarnings = built.warnings || [];
  updateKeyframeStatus();

  if (!state.source) {
    updateStats(null);
    drawDirectionForCurrentFrame();
    return;
  }

  const id = ++state.renderId;
  $('export-wav').disabled = true;
  $('export-json').disabled = true;
  updateProgress(0, 1, 'render');
  if (reason !== 'seek') setStatus('正在旋转…', 'busy');

  try {
    const msg = await callWorker({
      type: 'render',
      id,
      rotation: serializeRotation(state.rotation),
      outputFormat: state.outputFormat,
      monitorRows: state.monitorRows,
    });

    if (seq !== refreshSeq || id !== state.renderId) return; // 已被更新的请求取代

    state.rendered = msg;
    state.envelopes = msg.envelopes || null;
    player.setBuffer(msg.stereo.left, msg.stereo.right, msg.stereo.sampleRate);
    updateStats(msg.stats);
    updateTimeline();
    syncTransportFromPlayhead(false);
    drawDirectionForCurrentFrame();
    updateFrameValues();
    setStatus('旋转完成', 'ok');
    $('export-wav').disabled = !(msg.stats.overflowCount === 0);
    $('export-json').disabled = false;
    updateOverflowMessage(msg.stats);
    player.seek(state.playhead);
    if (state.reference) await maybeVerifyReference();
  } catch (err) {
    if (err.cancelled) return;
    if (seq !== refreshSeq) return;
    setStatus(`渲染失败：${err.message}`, 'error');
  } finally {
    updateProgress(1, 1, 'render');
  }
}

function serializeRotation(rotation) {
  if (rotation.mode === 'static') {
    return { mode: 'static', matrix: rotation.matrix, quat: rotation.quat };
  }
  return { mode: 'automation', frames: rotation.frames, quats: rotation.quats };
}

/* ══════════════════════════════════════════════════════
 * 统计显示
 * ══════════════════════════════════════════════════════ */

function updateStats(stats) {
  if (!stats || !state.source) {
    $('stat-peak').textContent = '—';
    $('stat-peak-sub').textContent = '尚未渲染';
    $('stat-overflow').textContent = '—';
    $('stat-overflow-card').classList.remove('danger');
    $('stat-overflow-sub').innerHTML = '&nbsp;';
    $('stat-rate').textContent = '—';
    $('stat-frames').textContent = '—';
    $('stat-format-sub').textContent = '输出 24-bit · 4 声道';
    return;
  }
  const spec = formatSpec(state.outputFormat);
  const peakText = `${fmtFloat(stats.peak, 6)}`;
  $('stat-peak').textContent = peakText;
  $('stat-peak-sub').textContent = `${fmtDb(stats.peak)} · ${spec.order[stats.peakChannel]} 通道`;
  $('stat-overflow').textContent = formatInt(stats.overflowCount);
  $('stat-overflow-card').classList.toggle('danger', stats.overflowCount > 0);
  if (stats.overflowCount > 0) {
    $('stat-overflow-sub').textContent =
      `首个：frame ${formatInt(stats.overflowFrame)} · ${spec.order[stats.overflowChannel]}`;
  } else {
    $('stat-overflow-sub').textContent = '全部在 [-1, 1) 内';
  }
  $('stat-rate').textContent = `${(state.source.sampleRate / 1000).toFixed(1)} kHz`;
  $('stat-frames').textContent = `${formatInt(state.source.frames)} 帧`;
  $('stat-format-sub').textContent = `输出 ${spec.order.join(' ')} · 24-bit`;
}

function updateOverflowMessage(stats) {
  if (!stats) {
    showMessage('overflow-msg', '', '');
    return;
  }
  if (stats.overflowCount > 0) {
    const spec = formatSpec(state.outputFormat);
    showMessage(
      'overflow-msg',
      'error',
      `<div><strong>已阻止 PCM 导出</strong>：${formatInt(stats.overflowCount)} 个样点超出 [-1, 1)，
       峰值 ${fmtFloat(stats.peak, 6)}（${fmtDb(stats.peak)}），
       首次出现在 frame ${formatInt(stats.overflowFrame)} 的 ${spec.order[stats.overflowChannel]} 通道。</div>
       <div class="hint" style="margin-top:4px">页面不会自动压低音量。请调整旋转角度或改用 FuMa 输出（W 为 1/√2）。</div>`,
    );
  } else {
    showMessage('overflow-msg', '', '');
  }
}

/* ══════════════════════════════════════════════════════
 * 关键帧编辑
 * ══════════════════════════════════════════════════════ */

function renderKeyframeTable() {
  const body = $('kf-body');
  const table = $('kf-table');
  const empty = $('kf-empty');
  const list = state.keyframes;
  $('kf-count').textContent = `${list.length} 个关键帧`;
  const hasFrames = list.length > 0;
  table.hidden = !hasFrames;
  empty.hidden = hasFrames;
  if (!hasFrames) {
    body.innerHTML = '';
    return;
  }

  const rows = [];
  list.forEach((kf, i) => {
    const invalid = !Number.isInteger(kf.frame) || kf.frame < 0
      || (i > 0 && Number.isInteger(list[i - 1].frame) && kf.frame <= list[i - 1].frame);
    const euler = safeEulerText(kf.q);
    const qCells = [0, 1, 2, 3].map((c) => `<td class="q-cell q-${'wxyz'[c]}" data-label="${'wxyz'[c]}"><input class="q" type="number" step="0.000001" value="${fmtRaw(kf.q[c])}" data-kf="${i}" data-field="q${c}" aria-label="关键帧 ${i + 1} 的 ${'wxyz'[c]}"></td>`).join('');
    rows.push(`<tr class="${invalid ? 'invalid' : ''}" data-index="${i}">
      <td class="idx"><span class="idx-num">${i + 1}</span></td>
      <td class="frame-cell" data-label="frame"><input class="frame" type="number" step="1" min="0" value="${kf.frame == null ? '' : kf.frame}" data-kf="${i}" data-field="frame" aria-label="关键帧 ${i + 1} 的采样帧"></td>
      ${qCells}
      <td class="euler-cell">${euler}</td>
      <td class="row-actions"><button class="icon-btn" data-kf-delete="${i}" title="删除这一关键帧" aria-label="删除关键帧 ${i + 1}">✕</button></td>
    </tr>`);
  });
  body.innerHTML = rows.join('');
}

function fmtRaw(v) {
  if (!Number.isFinite(v)) return '';
  const s = Number(v.toPrecision(7));
  return String(s);
}

function safeEulerText(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0)) return '—';
  const e = eulerDegFromQuat(q.map((v) => v / n));
  return `${wrapDeg(e.yaw).toFixed(1)}° / ${e.pitch.toFixed(1)}° / ${wrapDeg(e.roll).toFixed(1)}°`;
}

function updateKeyframeStatus() {
  const box = $('kf-status');
  if (!box) return;
  if (state.keyframeError) {
    showMessage(box, 'error', esc(state.keyframeError.message));
    return;
  }
  if (state.mode !== 'automation') {
    showMessage(box, '', '');
    return;
  }
  if (state.keyframeWarnings && state.keyframeWarnings.length) {
    const items = state.keyframeWarnings.slice(0, 4).map((w) => `<li>${esc(w)}</li>`).join('');
    showMessage(box, 'warn', `<div>已按规则调整（保留你的输入值，仅影响渲染）：</div><ul>${items}</ul>`);
    return;
  }
  showMessage(box, '', '');
}

function addKeyframeAtPlayhead() {
  if (!state.source) return;
  const frame = Math.round(state.playhead);
  if (state.keyframes.some((k) => k.frame === frame)) {
    setStatus(`frame ${formatInt(frame)} 已有关键帧`, 'error');
    return;
  }
  let q;
  if (state.keyframes.length === 0) {
    // 第一个关键帧取当前静态角，让切换模式时声场不跳变
    q = quatFromEulerDeg(state.yaw, state.pitch, state.roll);
  } else {
    q = interpolateExisting(frame);
  }
  state.keyframes = [...state.keyframes, { frame, q }].sort((a, b) => a.frame - b.frame);
  renderKeyframeTable();
  updateKeyframeRangeNote();
  refreshRender({ reason: 'keyframe-add' });
}

/** 在已有关键帧曲线上求值（与 Worker 同一套 SLERP 规则）。 */
function interpolateExisting(frame) {
  const valid = state.keyframes
    .filter((k) => Number.isInteger(k.frame) && k.frame >= 0)
    .sort((a, b) => a.frame - b.frame);
  if (!valid.length) return [1, 0, 0, 0];
  if (frame <= valid[0].frame) return valid[0].q.slice();
  if (frame >= valid[valid.length - 1].frame) return valid[valid.length - 1].q.slice();
  let lo = 0;
  for (let i = 0; i < valid.length - 1; i++) {
    if (valid[i].frame <= frame && frame <= valid[i + 1].frame) { lo = i; break; }
  }
  const a = valid[lo];
  const b = valid[lo + 1];
  const qa = normalizeQuat(a.q) || [1, 0, 0, 0];
  let qb = normalizeQuat(b.q) || [1, 0, 0, 0];
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) qb = qb.map((v) => -v);
  const t = (frame - a.frame) / (b.frame - a.frame);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot >= 0 ? dot : -dot)));
  let q;
  if (Math.sin(theta) < 1e-7) {
    q = qa.map((v, i2) => v + (qb[i2] - v) * t);
  } else {
    const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
    const wb = Math.sin(t * theta) / Math.sin(theta);
    q = qa.map((v, i2) => wa * v + wb * qb[i2]);
  }
  return normalizeQuat(q) || [1, 0, 0, 0];
}

function onKeyframeInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const idx = target.dataset.kf;
  if (idx == null) return;
  const field = target.dataset.field;
  const i = Number(idx);
  const kf = state.keyframes[i];
  if (!kf) return;

  if (field === 'frame') {
    const raw = target.value.trim();
    if (raw === '') { kf.frame = null; }
    else {
      const v = Number(raw);
      kf.frame = Number.isFinite(v) ? Math.round(v) : NaN;
    }
  } else {
    const c = Number(field.slice(1));
    const v = Number(target.value);
    kf.q[c] = Number.isFinite(v) ? v : NaN;
  }
  // 只重绘出错标记，不打断输入焦点
  markKeyframeRowInvalid(i);
  scheduleRender('keyframe-edit');
  updateKeyframeRangeNote();
}

function markKeyframeRowInvalid(i) {
  const row = $('kf-body').querySelector(`tr[data-index="${i}"]`);
  if (!row) return;
  const kf = state.keyframes[i];
  const badFrame = !Number.isInteger(kf.frame) || kf.frame < 0;
  const badQ = kf.q.some((v) => !Number.isFinite(v)) || !(Math.hypot(...kf.q) > 0);
  row.classList.toggle('invalid', badFrame || badQ);
}

function removeKeyframe(i) {
  state.keyframes.splice(i, 1);
  renderKeyframeTable();
  scheduleRender('keyframe-delete');
}

function updateKeyframeRangeNote() {
  const note = $('kf-range-note');
  if (!note) return;
  if (!state.source) {
    note.innerHTML = '<span class="hint">音频尚未载入；关键帧的帧号范围在载入后校验。</span>';
    return;
  }
  const n = state.source.frames;
  const frames = state.keyframes.map((k) => k.frame).filter((f) => Number.isInteger(f));
  if (!frames.length) {
    note.innerHTML = `<span class="hint">合法帧号范围 <code>0 – ${formatInt(n - 1)}</code></span>`;
    return;
  }
  const min = Math.min(...frames);
  const max = Math.max(...frames);
  note.innerHTML = [
    `帧号范围 <code>0 – ${formatInt(n - 1)}</code>`,
    `已用 <code>${formatInt(min)} – ${formatInt(max)}</code>`,
    `端点外保持 <code>${state.keyframes.length >= 2 ? '最近端值' : '唯一值'}</code>`,
  ].join('');
}

function importKeyframes(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result || '');
      const raw = parseAutomationJson(text);
      const { frames, quats, warnings } = validateKeyframes(raw, currentFrameLimit());
      state.keyframes = frames.map((frame, i) => ({ frame, q: quats[i].slice() }));
      state.keyframeError = null;
      state.keyframeWarnings = warnings;
      renderKeyframeTable();
      updateKeyframeRangeNote();
      showMessage('kf-status', 'ok', `已导入 ${state.keyframes.length} 个关键帧（四元数已归一化）。`);
      setMode('automation', { rerender: false });
      refreshRender({ reason: 'keyframe-import' });
    } catch (err) {
      state.keyframeError = err;
      showMessage('kf-status', 'error', esc(err.message));
      setStatus(`导入失败：${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

function exportKeyframes() {
  try {
    const raw = state.keyframes.map((k) => ({ frame: k.frame, q: k.q }));
    const { frames, quats } = validateKeyframes(raw, currentFrameLimit());
    const text = serializeAutomation(frames, quats);
    const blob = new Blob([text], { type: 'application/json' });
    triggerDownload(blob, 'ambisonic-orientation-keyframes.json');
    showMessage('kf-status', 'ok', `已导出 ${frames.length} 个关键帧。`);
  } catch (err) {
    showMessage('kf-status', 'error', esc(err.message));
  }
}

/* ══════════════════════════════════════════════════════
 * 时间轴 / 播放
 * ══════════════════════════════════════════════════════ */

function updateTransportBounds() {
  if (!state.source) {
    // 无音频：清空传输条，避免拖动残留的旧长度
    $('scrub').min = '0';
    $('scrub').max = '0';
    $('scrub').value = '0';
    $('scrub').disabled = true;
    $('time-total').textContent = formatTime(0);
    $('scrub-end').textContent = formatTime(0);
    $('play-btn').disabled = true;
    $('kf-add').disabled = true;
    updateTimeReadout();
    return;
  }
  const scrub = $('scrub');
  scrub.min = '0';
  scrub.max = String(state.source.frames - 1);
  scrub.disabled = false;
  scrub.value = String(Math.round(state.playhead));
  $('time-total').textContent = formatTime(state.source.frames / state.source.sampleRate);
  $('scrub-end').textContent = formatTime(state.source.frames / state.source.sampleRate);
  $('play-btn').disabled = false;
  $('kf-add').disabled = false;
  updateTimeReadout();
}

function updateTimeReadout() {
  const frame = Math.round(state.playhead);
  $('time-now').textContent = formatTime(frameToSeconds(frame));
  $('frame-now').textContent = state.source
    ? `frame ${formatInt(frame)} / ${formatInt(state.source.frames)}`
    : 'frame 0 / 0';
}

function syncTransportFromPlayhead(fromUser) {
  if (!state.source) return;
  const frame = Math.round(state.playhead);
  $('scrub').value = String(frame);
  updateTimeReadout();
  if (fromUser) {
    player.seek(frame);
    if (player.playing) player.play(frame);
  }
}

function setPlayhead(frame, { fromUser = false, redraw = true } = {}) {
  if (!state.source) return;
  state.playhead = Math.max(0, Math.min(state.source.frames - 1, Math.round(frame)));
  $('scrub').value = String(state.playhead);
  updateTimeReadout();
  if (fromUser) {
    player.seek(state.playhead);
    if (player.playing) player.play(state.playhead);
  }
  if (redraw) {
    updateTimeline();
    drawDirectionForCurrentFrame();
    updateFrameValues();
  }
}

function updateTimeline() {
  if (!state.source) {
    drawTimeline($('timeline'), { frames: 1, playhead: 0, keyframes: [], progress: 0, sampleRate: 48000 });
    return;
  }
  drawTimeline($('timeline'), {
    frames: state.source.frames,
    sampleRate: state.source.sampleRate,
    playhead: state.playhead,
    keyframes: state.mode === 'automation'
      ? state.keyframes.filter((k) => Number.isInteger(k.frame))
      : [],
    envelopes: state.envelopes,
    laneLabels: FORMAT_SPECS[state.outputFormat].order,
    progress: 0,
  });
}

function drawDirectionForCurrentFrame() {
  const frame = Math.round(state.playhead);
  let axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let quat = [1, 0, 0, 0];

  if (state.rotation) {
    if (state.rotation.mode === 'static') {
      const m = state.rotation.matrix;
      axes = [
        [m[0], m[3], m[6]],
        [m[1], m[4], m[7]],
        [m[2], m[5], m[8]],
      ];
      quat = state.rotation.quat;
    } else {
      // 用与 Worker 相同的二分 + SLERP 求当前帧四元数
      const q = sampleCurve(frame);
      if (q) {
        quat = q;
        const [w, x, y, z] = q;
        axes = [
          [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
          [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
          [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
        ];
      }
    }
  }

  const front = axes[0];
  drawDirection($('dir-canvas'), { axes, front });

  $('dir-quat').textContent = `[${quat.map((v) => fmtFloat(v, 4)).join(', ')}]`;
  const sph = vectorToSpherical(front);
  $('dir-azel').textContent = sph
    ? `az ${sph.az.toFixed(1)}° / el ${sph.el.toFixed(1)}°`
    : '—';
}

/** 主线程侧的曲线求值（仅用于方向示意，不参与渲染）。 */
function sampleCurve(frame) {
  if (!state.rotation || state.rotation.mode !== 'automation') return null;
  const { frames, quats } = state.rotation;
  if (!frames.length) return null;
  if (frame <= frames[0]) return quats[0];
  const last = frames.length - 1;
  if (frame >= frames[last]) return quats[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= frame) lo = mid;
    else hi = mid;
  }
  const span = frames[hi] - frames[lo];
  const t = span > 0 ? (frame - frames[lo]) / span : 0;
  const a = quats[lo];
  const b = quats[hi];
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  const theta = Math.acos(dot);
  if (Math.sin(theta) < 1e-7) {
    const q = a.map((v, i) => v + (b[i] - v) * t);
    return normalizeQuat(q) || a;
  }
  const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
  const wb = Math.sin(t * theta) / Math.sin(theta);
  return a.map((v, i) => wa * v + wb * b[i]);
}

function updateFrameValues() {
  if (!state.source || !state.rotation) {
    $('meters').innerHTML = '';
    $('frame-values').innerHTML = '';
    return;
  }
  const frame = Math.round(state.playhead);
  const rows = [];
  const colors = { W: 'var(--ch-w)', Y: 'var(--ch-y)', Z: 'var(--ch-z)', X: 'var(--ch-x)' };
  const order = state.outputFormat === 'fuma' ? ['W', 'X', 'Y', 'Z'] : ['W', 'Y', 'Z', 'X'];
  const values = frameChannelValues(frame);
  if (values) {
    for (let i = 0; i < 4; i++) {
      const name = order[i];
      const v = values[i];
      const pct = Math.min(100, Math.abs(v) * 100);
      const over = Math.abs(v) >= 1;
      rows.push(`<div class="meter-row">
        <span class="meter-name" style="color:${colors[name]}">${name}</span>
        <div class="meter-track">
          <div class="meter-fill" style="width:${pct.toFixed(1)}%;color:${over ? 'var(--danger)' : colors[name]}"></div>
        </div>
        <span class="meter-val">${fmtFloat(v, 4)}</span>
      </div>`);
    }
    $('frame-values').innerHTML = `帧内四通道 <code>${order.map((n, i) => `${n} ${fmtFloat(values[i], 4)}`).join(' · ')}</code>`;
  }
  $('meters').innerHTML = rows.join('');
}

/**
 * 当前帧在输出格式下的四通道值。
 * 直接从原始文件通道 + 当前旋转矩阵计算，与 Worker 的公式逐项对应；
 * 用于读数与电平条，导出与试听仍以 Worker 的结果为唯一依据。
 */
function frameChannelValues(frame) {
  if (!state.source || !state.rotation) return null;
  const src = state.source.data;
  const map = state.inputFormat === 'fuma'
    ? { W: 0, X: 1, Y: 2, Z: 3 }
    : { W: 0, Y: 1, Z: 2, X: 3 };
  const wGain = state.inputFormat === 'fuma' ? Math.SQRT2 : 1;
  const w = src[map.W][frame] * wGain;
  const y = src[map.Y][frame];
  const z = src[map.Z][frame];
  const x = src[map.X][frame];
  const m = rotationMatrixFor(frame);
  if (!m) return null;
  const canon = [
    w,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
    m[0] * x + m[1] * y + m[2] * z,
  ];
  const outMap = state.outputFormat === 'fuma'
    ? { W: 0, X: 1, Y: 2, Z: 3 }
    : { W: 0, Y: 1, Z: 2, X: 3 };
  const wScale = state.outputFormat === 'fuma' ? 1 / Math.SQRT2 : 1;
  const out = new Array(4);
  out[outMap.W] = canon[0] * wScale;
  out[outMap.Y] = canon[1];
  out[outMap.Z] = canon[2];
  out[outMap.X] = canon[3];
  return out;
}

/** 当前旋转在该帧的 3×3 行主序矩阵（主线程侧，仅用于读数）。 */
function rotationMatrixFor(frame) {
  if (!state.rotation) return null;
  if (state.rotation.mode === 'static') return state.rotation.matrix;
  const q = sampleCurve(frame);
  if (!q) return null;
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

function updatePlayIcon() {
  const icon = $('play-icon');
  if (state.playing) {
    icon.innerHTML = '<rect x="3.5" y="2.5" width="3.6" height="11" rx="1"/><rect x="9.4" y="2.5" width="3.6" height="11" rx="1"/>';
    $('play-btn').setAttribute('aria-label', '暂停');
  } else {
    icon.innerHTML = '<path d="M4.5 2.8v10.4c0 .5.5.8 1 .5l8.2-5.2a.6.6 0 0 0 0-1L5.5 2.3c-.5-.3-1 0-1 .5Z"/>';
    $('play-btn').setAttribute('aria-label', '播放');
  }
}

/* ══════════════════════════════════════════════════════
 * 导出
 * ══════════════════════════════════════════════════════ */

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportBaseName() {
  const src = state.source ? state.source.name.replace(/\.wav$/i, '') : 'ambisonic';
  const mode = state.mode === 'static'
    ? `yaw${Math.round(state.yaw)}_pitch${Math.round(state.pitch)}_roll${Math.round(state.roll)}`
    : `kf${state.keyframes.length}`;
  return `${src}-${state.outputFormat}-${mode}`;
}

async function exportWav() {
  if (!state.source || !state.rotation) return;
  const btn = $('export-wav');
  btn.disabled = true;
  showMessage('export-status', 'info', '正在重新渲染并写出 24-bit PCM…');
  const id = ++state.exportId;
  // 导出期间若参数又变了，refreshRender 会负责按钮状态；这里不要用旧结果重新启用。
  const seqAtStart = refreshSeq;
  try {
    const msg = await callWorker({
      type: 'export',
      id,
      rotation: serializeRotation(state.rotation),
      outputFormat: state.outputFormat,
    });
    const blob = new Blob([msg.buffer], { type: 'audio/wav' });
    const name = `${exportBaseName()}-24bit.wav`;
    triggerDownload(blob, name);
    showMessage(
      'export-status',
      'ok',
      `已导出 <b>${esc(name)}</b>：${formatInt(msg.meta.frames)} 帧 · ${(msg.meta.sampleRate / 1000).toFixed(1)} kHz ·
       ${msg.meta.outputFormat === 'fuma' ? 'W X Y Z' : 'W Y Z X'} · 峰值 ${fmtFloat(msg.meta.peak, 6)}（${fmtDb(msg.meta.peak)}）。
       未做响度归一化。`,
    );
    setStatus('已导出 WAV', 'ok');
  } catch (err) {
    if (err.cancelled) return;
    if (err.overflow && err.stats) {
      updateOverflowMessage(err.stats);
      showMessage('export-status', 'error', esc(err.message));
      setStatus('导出被阻止：样点溢出', 'error');
    } else {
      showMessage('export-status', 'error', esc(err.message));
      setStatus(`导出失败：${err.message}`, 'error');
    }
  } finally {
    updateProgress(1, 1, 'export');
    // 只有导出期间参数没变，才按本次结果恢复按钮；否则交给正在进行的刷新。
    if (seqAtStart === refreshSeq) {
      const canExport = state.rendered && state.rendered.stats.overflowCount === 0;
      btn.disabled = !canExport;
    }
  }
}

function exportFormatJson() {
  if (!state.source || !state.rotation) return;
  try {
    const rotationJson = state.rotation.mode === 'static'
      ? {
        mode: 'static',
        eulerDeg: { yaw: state.yaw, pitch: state.pitch, roll: state.roll },
        order: 'Rz(yaw) * Ry(pitch) * Rx(roll)',
        quaternion: state.rotation.quat,
      }
      : {
        mode: 'automation',
        keyframes: state.rotation.frames.map((frame, i) => ({
          frame,
          q: state.rotation.quats[i],
        })),
      };

    const doc = {
      tool: 'ambisonic-orientation-bench',
      conventions: {
        layout: state.outputFormat,
        channelOrder: FORMAT_SPECS[state.outputFormat].order,
        normalization: state.outputFormat === 'ambix' ? 'SN3D' : 'FuMa (W = AmbiX W / √2)',
        axes: '右手系，X 向前、Y 向左、Z 向上',
        rotation: '主动旋转 q * v * q⁻¹；W 不参与旋转',
      },
      input: {
        name: state.source.name,
        layout: state.inputFormat,
        channelOrder: FORMAT_SPECS[state.inputFormat].order,
        sampleRate: state.source.sampleRate,
        bitsPerSample: state.source.bitsPerSample,
        frames: state.source.frames,
        durationSeconds: state.source.frames / state.source.sampleRate,
      },
      output: {
        sampleRate: state.source.sampleRate,
        bitsPerSample: 24,
        channels: 4,
        frames: state.source.frames,
        layout: state.outputFormat,
        channelOrder: FORMAT_SPECS[state.outputFormat].order,
        audioFile: `${exportBaseName()}-24bit.wav`,
      },
      rotation: rotationJson,
      rotationCurve: describeCurveSummary(),
      monitorRowsWYZx: state.monitorRows,
      stats: state.rendered ? {
        peak: state.rendered.stats.peak,
        peakChannel: state.rendered.stats.peakChannel,
        peakChannelName: FORMAT_SPECS[state.outputFormat].order[state.rendered.stats.peakChannel],
        overflowSamples: state.rendered.stats.overflowCount,
      } : null,
      note: '仅格式换算与旋转；保留采样率与帧数；不做响度归一化。',
    };
    const text = JSON.stringify(doc, null, 2) + '\n';
    const blob = new Blob([text], { type: 'application/json' });
    const name = `${exportBaseName()}-format.json`;
    triggerDownload(blob, name);
    showMessage('export-status', 'ok', `已导出格式 JSON <b>${esc(name)}</b>。`);
  } catch (err) {
    showMessage('export-status', 'error', esc(err.message));
  }
}

function describeCurveSummary() {
  if (state.rotation.mode === 'static') {
    return {
      kind: 'constant',
      note: '整段使用同一旋转矩阵',
      eulerDeg: { yaw: state.yaw, pitch: state.pitch, roll: state.roll },
      quaternion: state.rotation.quat,
    };
  }
  return {
    kind: 'slerp-keyframes',
    interpolation: '归一化后最短弧 SLERP；相邻点积为负翻转后者',
    endpoints: '区间外保持最近端值',
    frames: state.rotation.frames,
  };
}

/* ══════════════════════════════════════════════════════
 * 参考核对
 * ══════════════════════════════════════════════════════ */

async function maybeVerifyReference() {
  if (!state.reference) return;
  const result = $('reference-result');
  if (!state.loadedSampleId) {
    result.innerHTML = '';
    $('reference-card').hidden = true;
    return;
  }
  $('reference-card').hidden = false;
  result.innerHTML = '<div class="msg info">正在与参考文件逐样点核对…</div>';
  try {
    const url = `/api/sample?path=${encodeURIComponent(state.reference.path)}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`参考文件不可用（HTTP ${response.status}）`);
    const buffer = await response.arrayBuffer();
    const ref = parseWav(buffer);
    if (ref.frames !== state.source.frames || ref.sampleRate !== state.source.sampleRate) {
      throw new Error('参考文件的采样率或帧数与输入不一致');
    }
    const referenceInts = ref.data.map((plane) => {
      const out = new Int32Array(plane.length);
      for (let i = 0; i < plane.length; i++) out[i] = Math.round(plane[i] * 8388608);
      return out;
    });

    const msg = await callWorker({
      type: 'compare',
      id: ++state.exportId,
      rotation: serializeRotation(state.rotation),
      reference: referenceInts,
    });

    const worst = msg.worst;
    const pass = worst <= 4;
    $('reference-note').textContent = pass ? '通过 · ±4 单位内' : `超出容差 · ${worst} 单位`;
    result.innerHTML = `<div class="msg ${pass ? 'ok' : 'error'}">
      ${pass ? '✓ 与参考文件一致' : '✗ 与参考文件不一致'}：
      最大逐样点差 <b>${formatInt(worst)}</b> 个 24-bit 整数单位
      ${msg.worstFrame >= 0 ? `（frame ${formatInt(msg.worstFrame)} · ${['W', 'Y', 'Z', 'X'][msg.worstChannel]}）` : ''}，
      容差 ±4。
    </div>`;
  } catch (err) {
    result.innerHTML = `<div class="msg warn">参考核对无法完成：${esc(err.message)}</div>`;
  }
}

/* ══════════════════════════════════════════════════════
 * 样例
 * ══════════════════════════════════════════════════════ */

async function loadSample(id) {
  if (!state.samples) return;
  const entry = state.samples.wavs.find((w) => w.id === id);
  if (!entry) return;
  setStatus('正在载入样例…', 'busy');
  try {
    const url = `/api/sample?path=${encodeURIComponent(entry.path)}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();

    // 先重置旋转状态，避免上一个样例的角度串台
    if (entry.preset) applyPreset(entry.preset);
    if (entry.automation) {
      const autoResp = await fetch(`/api/sample?path=${encodeURIComponent(entry.automation)}`, { cache: 'no-store' });
      if (autoResp.ok) {
        const text = await autoResp.text();
        const raw = parseAutomationJson(text);
        const { frames, rawQuats } = validateKeyframes(raw, null);
        // 编辑表里保留用户原始输入（未做最短弧翻转），渲染时由 Worker 侧统一对齐
        state.keyframes = frames.map((frame, i) => ({ frame, q: rawQuats[i].slice() }));
        renderKeyframeTable();
      }
    } else {
      state.keyframes = [];
      renderKeyframeTable();
    }

    const ok = await loadWavArrayBuffer(buffer, entry.path, {
      inputFormat: entry.preset?.inputFormat || 'ambix',
      outputFormat: entry.preset?.outputFormat || 'ambix',
      sampleId: entry.id,
      reference: entry.reference ? { path: entry.reference } : null,
    });
    if (!ok) return;

    // 关键帧范围现在已知，重新校验并刷新
    if (entry.automation) {
      try {
        const { frames, rawQuats, warnings } = validateKeyframes(
          state.keyframes.map((k) => ({ frame: k.frame, q: k.q })),
          state.source.frames - 1,
        );
        state.keyframes = frames.map((frame, i) => ({ frame, q: rawQuats[i].slice() }));
        state.keyframeWarnings = warnings;
        renderKeyframeTable();
        updateKeyframeStatus();
        if (entry.preset?.mode === 'automation') setMode('automation', { rerender: false });
        await refreshRender({ reason: 'sample' });
      } catch (err) {
        showMessage('kf-status', 'error', esc(err.message));
      }
    }
    updateKeyframeRangeNote();
    updateTimeline();
    setStatus(`已载入样例：${entry.title}`, 'ok');
  } catch (err) {
    setStatus(`样例载入失败：${err.message}`, 'error');
  }
}

function applyPreset(preset) {
  if (preset.mode) setMode(preset.mode, { rerender: false });
  if (preset.yaw != null) {
    $('yaw').value = preset.yaw;
    $('yaw-range').value = clampRange(preset.yaw, 'yaw');
  }
  if (preset.pitch != null) {
    $('pitch').value = preset.pitch;
    $('pitch-range').value = clampRange(preset.pitch, 'pitch');
  }
  if (preset.roll != null) {
    $('roll').value = preset.roll;
    $('roll-range').value = clampRange(preset.roll, 'roll');
  }
  applyAngleInputs();
  if (preset.inputFormat) setInputFormat(preset.inputFormat, false);
  if (preset.outputFormat) setOutputFormatSilent(preset.outputFormat);
}

function setOutputFormatSilent(id) {
  if (!FORMAT_SPECS[id]) return;
  state.outputFormat = id;
  $(id === 'ambix' ? 'out-ambix' : 'out-fuma').checked = true;
}

/* ══════════════════════════════════════════════════════
 * 初始化
 * ══════════════════════════════════════════════════════ */

function bindEvents() {
  $('open-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async () => {
    const file = $('file-input').files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    state.keyframes = [];
    state.keyframeWarnings = [];
    renderKeyframeTable();
    await loadWavArrayBuffer(buf, file.name, { sampleId: null });
    $('file-input').value = '';
  });

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('file-input').click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('file-input').click();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    });
  });
  dz.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.wav$/i.test(file.name)) {
      setStatus('只接受 .wav 文件', 'error');
      return;
    }
    const buf = await file.arrayBuffer();
    state.keyframes = [];
    state.keyframeWarnings = [];
    renderKeyframeTable();
    await loadWavArrayBuffer(buf, file.name, { sampleId: null });
  });

  for (const id of ['in-ambix', 'in-fuma']) {
    $(id).addEventListener('change', () => {
      if ($(id).checked) setInputFormat($(id).value);
    });
  }
  for (const id of ['out-ambix', 'out-fuma']) {
    $(id).addEventListener('change', () => {
      if ($(id).checked) setOutputFormat($(id).value);
    });
  }

  $('mode-static').addEventListener('click', () => setMode('static'));
  $('mode-automation').addEventListener('click', () => setMode('automation'));

  for (const which of ['yaw', 'pitch', 'roll']) {
    $(which).addEventListener('input', () => onAngleChange('number', which));
    $(`${which}-range`).addEventListener('input', () => onAngleChange('range', which));
  }
  $('reset-angles').addEventListener('click', () => {
    for (const which of ['yaw', 'pitch', 'roll']) {
      $(which).value = '0';
      $(`${which}-range`).value = '0';
    }
    applyAngleInputs();
    refreshRender({ reason: 'reset' });
  });

  $('kf-add').addEventListener('click', addKeyframeAtPlayhead);
  $('kf-body').addEventListener('input', onKeyframeInput);
  $('kf-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kf-delete]');
    if (btn) removeKeyframe(Number(btn.dataset.kfDelete));
  });
  $('kf-import-btn').addEventListener('click', () => $('kf-import').click());
  $('kf-import').addEventListener('change', () => {
    const file = $('kf-import').files?.[0];
    if (file) importKeyframes(file);
    $('kf-import').value = '';
  });
  $('kf-export').addEventListener('click', exportKeyframes);

  $('sample-select').addEventListener('change', () => {
    $('load-sample').disabled = !$('sample-select').value;
  });
  $('load-sample').addEventListener('click', () => {
    const id = $('sample-select').value;
    if (id) loadSample(id);
  });

  $('play-btn').addEventListener('click', () => {
    if (!player.ready) return;
    if (player.playing) player.pause();
    else player.play(Math.round(state.playhead));
  });
  $('scrub').addEventListener('input', () => {
    setPlayhead(Number($('scrub').value), { fromUser: false });
  });
  $('scrub').addEventListener('change', () => {
    setPlayhead(Number($('scrub').value), { fromUser: true });
  });
  $('volume').addEventListener('input', () => {
    player.setVolume(parseFloat($('volume').value));
  });

  // 时间轴点击/拖动定位
  const timeline = $('timeline');
  let dragging = false;
  const frameFromEvent = (e) => {
    const rect = timeline.getBoundingClientRect();
    const pad = 4;
    const plotW = Math.max(1, rect.width - pad * 2);
    const x = Math.max(0, Math.min(plotW, e.clientX - rect.left - pad));
    return secondsToFrame((x / plotW) * (state.source ? state.source.frames / state.source.sampleRate : 0));
  };
  timeline.addEventListener('pointerdown', (e) => {
    if (!state.source) return;
    dragging = true;
    timeline.setPointerCapture(e.pointerId);
    setPlayhead(frameFromEvent(e), { fromUser: true });
  });
  timeline.addEventListener('pointermove', (e) => {
    if (dragging) setPlayhead(frameFromEvent(e), { fromUser: true });
  });
  timeline.addEventListener('pointerup', (e) => {
    dragging = false;
    try { timeline.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });

  $('export-wav').addEventListener('click', exportWav);
  $('export-json').addEventListener('click', exportFormatJson);

  window.addEventListener('resize', () => {
    updateTimeline();
    drawDirectionForCurrentFrame();
  });

  // 播放中刷新游标
  const tick = () => {
    if (player.playing) {
      const f = player.currentFrame();
      state.playhead = Math.min(f, (state.source?.frames || 1) - 1);
      $('scrub').value = String(state.playhead);
      updateTimeReadout();
      updateTimeline();
      drawDirectionForCurrentFrame();
      updateFrameValues();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener('beforeunload', () => player.dispose());
}

async function loadConventions() {
  try {
    const resp = await fetch('/api/conventions', { cache: 'no-store' });
    if (!resp.ok) return;
    const doc = await resp.json();
    state.conventions = doc;
    const rows = sanitizeMonitorRows(doc.monitor_rows_wyzx);
    if (rows) state.monitorRows = rows;
    // 包内 conventions.json 是格式定义的唯一来源；与内置规格不一致时必须在界面上说清楚，
    // 而不是静默使用内置值。
    const mismatches = [];
    if (doc && doc.formats) {
      for (const key of ['ambix', 'fuma']) {
        const pack = doc.formats[key];
        const mine = FORMAT_SPECS[key];
        if (pack && Array.isArray(pack.order)) {
          const order = pack.order.join(' ');
          if (order !== mine.order.join(' ')) {
            mismatches.push(`${key} 通道序：包内 ${order}，页面实际使用 ${mine.order.join(' ')}`);
          }
        }
      }
    }
    if (!rows) mismatches.push('monitor_rows_wyzx 形状异常，已改用内置监听矩阵');
    state.conventionsMismatch = mismatches;
    if (mismatches.length) {
      console.warn('conventions.json 与内置规格不一致：', mismatches);
      showMessage('conventions-mismatch', 'warn',
        `包内 conventions.json 与页面内置规格不一致，已按内置规格运行：<ul>${
          mismatches.map((m) => `<li>${esc(m)}</li>`).join('')
        }</ul>`);
    }
    renderFormatMatrices();
  } catch (err) {
    console.warn('conventions.json 不可用，使用内置矩阵', err);
  }
}

async function loadSamples() {
  try {
    const resp = await fetch('/api/samples', { cache: 'no-store' });
    if (!resp.ok) return;
    state.samples = await resp.json();
    const select = $('sample-select');
    for (const w of state.samples.wavs) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.title;
      if (w.meta) opt.title = `${w.meta.sampleRate} Hz · ${w.meta.bitsPerSample}-bit · ${w.meta.frames} 帧`;
      select.appendChild(opt);
    }
    if (state.samples.wavs.length === 0) {
      select.insertAdjacentHTML('beforeend', '<option disabled>（样例不可用，请手动导入 WAV）</option>');
    }
    $('load-sample').disabled = true;
  } catch (err) {
    console.warn('样例清单不可用', err);
  }
}

async function init() {
  player.setVolume(parseFloat($('volume').value));

  bindEvents();
  renderKeyframeTable();
  updateKeyframeRangeNote();
  applyAngleInputs();
  drawDirectionForCurrentFrame();
  updateTimeline();
  updateStats(null);
  setMode('static', { rerender: false });
  updatePlayIcon();
  updateKeyframeStatus();

  await Promise.all([loadConventions(), loadSamples()]);
  renderFormatMatrices();
}

init().catch((err) => {
  console.error(err);
  setStatus(`初始化失败：${err.message}`, 'error');
});

// 供端到端测试读取内部状态（只读，不改变行为）
window.__bench = {
  state,
  player,
  buildCurrentRotation,
};
