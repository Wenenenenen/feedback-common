// 响度交付核对台主控。
// 计量/增益全部来自自研模块（wav-codec / meter / gain / true-peak），
// 不调用任何现成响度库或 FFmpeg 滤镜。

import { parseWav, encodeWav24 } from './wav-codec.js';
import { analyze } from './meter.js';
import { planGain, applyGain } from './gain.js';

const $ = (id) => document.getElementById(id);

// ---- 全局状态 ----
const state = {
  file: null, // { name, bytes, wav }
  analysis: null, // 当前输入的分析结果
  plan: null, // 当前增益决策
  processed: null, // 处理后 planar
  targetLufs: -23,
  ceilingDbtp: -1,
  oversampleFactor: 4,
  // 失效管理：任何文件/参数变更都使分析与交付标记为过期
  stale: false,
  audioContext: null,
  currentSource: null,
  playMode: 'original',
};

const MAX_DURATION_S = 60;

// ---- 工具 ----
function fmtDb(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '不可测';
  return `${v.toFixed(digits)} dB`;
}
function showError(msg) {
  const el = $('loadError');
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  $('loadError').hidden = true;
}

// ---- 失效管理 ----
function markStale(reason) {
  state.stale = true;
  const badge = $('freshBadge');
  badge.textContent = `结果已过期 · ${reason}`;
  badge.classList.add('stale');
  // 禁用依赖当前结果的交付控件
  $('exportWav').disabled = true;
  $('exportJson').disabled = true;
  $('abProcessed').disabled = true;
}
function markFresh() {
  state.stale = false;
  const badge = $('freshBadge');
  badge.textContent = '当前结果';
  badge.classList.remove('stale');
}

// ---- 导入 ----
async function handleFile(file) {
  clearError();
  try {
    const buf = await file.arrayBuffer();
    const wav = parseWav(buf);
    if (wav.duration > MAX_DURATION_S + 1e-6) {
      throw new Error(`时长 ${wav.duration.toFixed(2)}s 超过 ${MAX_DURATION_S}s 上限`);
    }
    state.file = { name: file.name, wav };
    state.processed = null;
    state.plan = null;
    // 新文件：停止旧播放并把试听切回原音，杜绝旧结果残留
    stopPlayback();
    state.playMode = 'original';
    document.querySelectorAll('.ab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === 'original'));
    renderFileMeta();
    runAnalysis();
  } catch (err) {
    state.file = null;
    $('fileMeta').hidden = true;
    $('analysisPanel').hidden = true;
    $('deliveryPanel').hidden = true;
    showError(err.message || String(err));
  }
}

function renderFileMeta() {
  const { wav, name } = state.file;
  const items = [
    ['文件', name],
    ['采样率', `${wav.sampleRate} Hz`],
    ['声道', wav.channels === 1 ? '单声道' : '双声道'],
    ['位深', `${wav.bitsPerSample} 位 PCM`],
    ['帧数', wav.frames.toLocaleString()],
    ['时长', `${wav.duration.toFixed(3)} s`],
  ];
  $('fileMeta').innerHTML = items
    .map(([k, v]) => `<div class="meta-item"><span class="meta-k">${k}</span><span class="meta-v">${v}</span></div>`)
    .join('');
  $('fileMeta').hidden = false;
}

// ---- 分析 ----
function runAnalysis() {
  if (!state.file) return;
  const { wav } = state.file;
  const m = analyze(wav.planar, wav.sampleRate, { oversampleFactor: state.oversampleFactor });
  state.analysis = m;
  state.processed = null;
  state.plan = null;
  renderAnalysis(m);
  runDelivery();
  markFresh();
}

function renderAnalysis(m) {
  $('analysisPanel').hidden = false;
  $('statOversample').textContent = `${m.oversampleFactor}×`;

  // I
  const iEl = $('statI');
  if (m.integratedLufs === null) {
    iEl.textContent = '不可测';
    iEl.classList.add('unmeasurable');
    $('statIUnit').textContent = '无完整门限块或纯静音';
  } else {
    iEl.textContent = m.integratedLufs.toFixed(1);
    iEl.classList.remove('unmeasurable');
    $('statIUnit').textContent = 'LUFS（双重门限）';
  }

  $('statDuration').textContent = m.duration.toFixed(2);
  $('statBlocks').textContent = `${m.mCurve.length} 个 400ms 块`;

  const maxSp = maxOf(m.perChannel.map((c) => c.samplePeakDbfs));
  const maxTp = maxOf(m.perChannel.map((c) => c.truePeakDbtp));
  const spEl = $('statSamplePeak');
  spEl.textContent = maxSp === null ? '负无穷' : maxSp.toFixed(2);
  spEl.classList.toggle('unmeasurable', maxSp === null);
  const tpEl = $('statTruePeak');
  tpEl.textContent = maxTp === null ? '不可测' : maxTp.toFixed(2);
  tpEl.classList.toggle('unmeasurable', maxTp === null);

  // 逐声道表
  const tbody = document.querySelector('#channelTable tbody');
  tbody.innerHTML = m.perChannel
    .map(
      (c) => `<tr>
        <td>声道 ${c.channel}</td>
        <td class="${c.samplePeakDbfs === null ? 'unmeasurable' : ''}">${c.samplePeakDbfs === null ? '负无穷' : c.samplePeakDbfs.toFixed(3)}</td>
        <td class="${c.truePeakDbtp === null ? 'unmeasurable' : ''}">${c.truePeakDbtp === null ? '不可测' : c.truePeakDbtp.toFixed(3)}</td>
      </tr>`,
    )
    .join('');

  drawChart(m);
}

function maxOf(arr) {
  const valid = arr.filter((v) => v !== null && v !== undefined);
  return valid.length ? Math.max(...valid) : null;
}

// ---- M/S 曲线（SVG）----
function drawChart(m) {
  const svg = $('loudnessChart');
  const W = 900;
  const H = 320;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const duration = m.duration;

  // 纵轴范围（覆盖数据，固定刻度）。全静音/无有效响度时用兜底范围。
  const allVals = [...m.mCurve.map((p) => p.lufs), ...m.sCurve.map((p) => p.lufs)].filter(
    (v) => v !== null && Number.isFinite(v),
  );
  let lo, hi;
  if (allVals.length === 0) {
    lo = -80;
    hi = -20;
  } else {
    lo = Math.floor((Math.min(...allVals) - 4) / 10) * 10;
    hi = Math.ceil((Math.max(...allVals) + 4) / 10) * 10;
    if (hi - lo < 20) hi = lo + 20;
  }

  const x = (t) => padL + (t / duration) * plotW;
  const y = (db) => padT + plotH - ((db - lo) / (hi - lo)) * plotH;

  let grid = '';
  for (let db = lo; db <= hi; db += 10) {
    const yy = y(db);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-variant-numeric="tabular-nums">${db}</text>`;
  }
  // 横轴时间刻度
  let xaxis = '';
  const tickCount = Math.max(1, Math.min(8, Math.floor(duration)));
  for (let i = 0; i <= tickCount; i++) {
    const t = (duration * i) / tickCount;
    const xx = x(t);
    xaxis += `<line x1="${xx}" y1="${H - padB}" x2="${xx}" y2="${H - padB + 5}" stroke="var(--baseline)"/>
      <text x="${xx}" y="${H - padB + 20}" text-anchor="middle" font-size="11" fill="var(--muted)" font-variant-numeric="tabular-nums">${t.toFixed(1)}</text>`;
  }

  const pathFor = (curve) =>
    curve
      .filter((p) => p.lufs !== null && Number.isFinite(p.lufs))
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)},${y(p.lufs).toFixed(2)}`)
      .join(' ');

  svg.innerHTML = `
    ${grid}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--baseline)" stroke-width="1.5"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--baseline)" stroke-width="1.5"/>
    ${xaxis}
    <path d="${pathFor(m.sCurve)}" fill="none" stroke="var(--series-s)" stroke-width="2" opacity="0.95"/>
    <path d="${pathFor(m.mCurve)}" fill="none" stroke="var(--series-m)" stroke-width="2" opacity="0.95"/>
    <line id="chartCrosshair" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--baseline)" stroke-width="1" stroke-dasharray="3 3" hidden/>
  `;

  // 不可测点说明：区分“无完整 3s 窗口”与“完整窗口内为静音”
  const firstComplete = m.sCurve.findIndex((p) => p.lufs !== null);
  const incompleteCount = firstComplete === -1 ? m.sCurve.length : firstComplete;
  const silentCount = m.sCurve.length - incompleteCount - (firstComplete === -1 ? 0 : m.sCurve.slice(firstComplete).filter((p) => p.lufs !== null).length);
  const notes = [];
  if (incompleteCount > 0) notes.push(`起始 ${incompleteCount} 个 100ms 采样点不足 3 秒完整 S 窗口，标记为不可测`);
  if (silentCount > 0) notes.push(`另有 ${silentCount} 个完整窗口因内部为静音而不可测`);
  notes.push('M 为 400ms、S 为 3s，均不加门限，每 100ms 更新');
  $('chartNote').textContent = notes.join('；') + '。';

  attachChartHover(m, x, y, padL, W - padR);
}

function attachChartHover(m, xFn, yFn, xMin, xMax) {
  const svg = $('loudnessChart');
  const tip = $('chartTooltip');
  const cross = svg.querySelector('#chartCrosshair');
  const wrap = svg.parentElement;

  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * 900;
    if (px < xMin || px > xMax) {
      tip.hidden = true;
      cross.hidden = true;
      return;
    }
    const t = ((px - xMin) / (xMax - xMin)) * m.duration;
    const mPt = nearest(m.mCurve, t);
    const sPt = nearest(m.sCurve, t);
    cross.setAttribute('x1', xFn(mPt.t));
    cross.setAttribute('x2', xFn(mPt.t));
    cross.hidden = false;
    tip.innerHTML = `<div class="tt-time">t = ${mPt.t.toFixed(2)} s</div>
      <div class="tt-row"><span style="color:var(--series-m)">M</span><b>${mPt.lufs === null ? '不可测' : mPt.lufs.toFixed(1)}</b></div>
      <div class="tt-row"><span style="color:var(--series-s)">S</span><b>${sPt.lufs === null ? '不可测' : sPt.lufs.toFixed(1)}</b></div>`;
    const wrapRect = wrap.getBoundingClientRect();
    tip.hidden = false;
    let left = ev.clientX - wrapRect.left + 14;
    if (left + 150 > wrapRect.width) left = ev.clientX - wrapRect.left - 150;
    tip.style.left = `${left}px`;
    tip.style.top = `${ev.clientY - wrapRect.top - 10}px`;
  };
  svg.onmouseleave = () => {
    tip.hidden = true;
    cross.hidden = true;
  };
}

function nearest(curve, t) {
  let best = curve[0];
  let bd = Infinity;
  for (const p of curve) {
    const d = Math.abs(p.t - t);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

// ---- 交付决策 ----
function runDelivery() {
  $('deliveryPanel').hidden = false;
  if (!state.analysis) return;
  const plan = planGain(state.analysis, state.targetLufs, state.ceilingDbtp);
  state.plan = plan;

  $('gainValue').textContent = plan.canDeliver ? `${plan.gainDb.toFixed(2)} dB（×${plan.gainLinear.toFixed(4)}）` : '禁止交付';
  $('gainReason').textContent = plan.reason;
  $('predI').textContent = plan.canDeliver ? `${plan.predictedIntegratedLufs.toFixed(2)} LUFS` : '—';
  $('predTp').textContent = plan.canDeliver ? `${plan.predictedMaxTruePeakDbtp.toFixed(2)} dBTP` : '—';

  const gap = $('gapBanner');
  const blocked = $('blockedBanner');
  gap.hidden = true;
  blocked.hidden = true;

  if (!plan.canDeliver) {
    blocked.textContent = `⛔ ${plan.reason}。已禁止生成交付文件。`;
    blocked.hidden = false;
    $('exportWav').disabled = true;
    $('exportJson').disabled = true;
    $('abProcessed').disabled = true;
    stopPlayback();
    return;
  }

  if (plan.peakConstrained) {
    gap.innerHTML = `⚠️ <b>峰值约束优先</b>：为不突破 ${state.ceilingDbtp} dBTP 上限，未达响度目标，
      交付响度距目标还差 <b>${plan.targetGapLu.toFixed(2)} LU</b>（目标 ${state.targetLufs} LUFS，实际 ${plan.predictedIntegratedLufs.toFixed(2)} LUFS）。`;
    gap.hidden = false;
  }

  // 生成处理结果
  state.processed = applyGain(state.file.wav.planar, plan.gainLinear);
  $('exportWav').disabled = false;
  $('exportJson').disabled = false;
  $('abProcessed').disabled = false;
}

// ---- 参数变更：立即失效并重算 ----
function onParamChange() {
  const nextTarget = parseFloat($('targetLufs').value);
  const nextCeiling = parseFloat($('ceilingDbtp').value);
  if (!Number.isFinite(nextTarget) || !Number.isFinite(nextCeiling)) {
    showError('目标响度与峰值上限必须是有效数值');
    return;
  }
  clearError();
  state.targetLufs = nextTarget;
  state.ceilingDbtp = nextCeiling;
  // 交付参数只影响增益决策，计量读数保持有效；重算后即为当前结果
  if (state.file) {
    runDelivery();
    markFresh();
  }
}
$('targetLufs').addEventListener('input', onParamChange);
$('ceilingDbtp').addEventListener('input', onParamChange);

$('oversampleSelect').addEventListener('change', () => {
  state.oversampleFactor = parseInt($('oversampleSelect').value, 10);
  if (state.file) {
    markStale('过采样倍数已修改');
    runAnalysis(); // 过采样影响真峰值，需重新完整分析
  }
});

// ---- 文件拖放 ----
const drop = $('fileDrop');
const input = $('fileInput');
input.addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));

// ---- 试听 ----
function ensureContext() {
  if (!state.audioContext) state.audioContext = new AudioContext();
  return state.audioContext;
}
function planarToBuffer(planar, sampleRate) {
  const ctx = ensureContext();
  const frames = planar[0].length;
  const buf = ctx.createBuffer(planar.length, frames, sampleRate);
  for (let c = 0; c < planar.length; c++) buf.copyToChannel(planar[c], c);
  return buf;
}
function stopPlayback() {
  if (state.currentSource) {
    try { state.currentSource.stop(); } catch { /* 已停止 */ }
    state.currentSource = null;
  }
  $('playBtn').textContent = '播放';
}
function startPlayback() {
  if (!state.file) return;
  const ctx = ensureContext();
  ctx.resume();
  stopPlayback();
  const useProcessed = state.playMode === 'processed' && state.processed;
  const planar = useProcessed ? state.processed : state.file.wav.planar;
  const buf = planarToBuffer(planar, state.file.wav.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => {
    state.currentSource = null;
    $('playBtn').textContent = '播放';
    $('playTime').textContent = '0.0 s';
  };
  src.start();
  state.currentSource = src;
  $('playBtn').textContent = '停止';
  const t0 = ctx.currentTime;
  const tick = () => {
    if (!state.currentSource) return;
    $('playTime').textContent = `${(ctx.currentTime - t0).toFixed(1)} s`;
    requestAnimationFrame(tick);
  };
  tick();
}
$('playBtn').addEventListener('click', () => {
  if (state.currentSource) stopPlayback();
  else startPlayback();
});
document.querySelectorAll('.ab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    document.querySelectorAll('.ab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.playMode = btn.dataset.mode;
    if (state.currentSource) startPlayback(); // 立即切换音源
  });
});

// ---- 导出 WAV ----
$('exportWav').addEventListener('click', () => {
  if (!state.plan?.canDeliver || !state.processed) return;
  const { wav } = state.file;
  const bytes = encodeWav24(wav.sampleRate, wav.channels, state.processed, wav.frames);
  downloadBlob(new Blob([bytes], { type: 'audio/wav' }), replaceExt(state.file.name, '.delivered.wav'));
});

// ---- 导出读数 JSON ----
$('exportJson').addEventListener('click', async () => {
  if (!state.plan?.canDeliver || !state.processed) return;
  const { wav } = state.file;
  // 对处理结果重新完整计量，作为交付后读数
  const after = analyze(state.processed, wav.sampleRate, { oversampleFactor: state.oversampleFactor });
  const payload = buildJsonReport(state.analysis, after, state.plan, wav);
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), replaceExt(state.file.name, '.report.json'));
});

function buildJsonReport(before, after, plan, wav) {
  const pick = (m) => ({
    integrated_lufs: m.integratedLufs,
    per_channel: m.perChannel.map((c) => ({
      channel: c.channel,
      sample_peak_dbfs: c.samplePeakDbfs,
      true_peak_dbtp: c.truePeakDbtp,
    })),
    max_true_peak_dbtp: maxOf(m.perChannel.map((c) => c.truePeakDbtp)),
  });
  return {
    source: {
      sample_rate: wav.sampleRate,
      channels: wav.channels,
      bits_per_sample: wav.bitsPerSample,
      frames: wav.frames,
      duration_s: wav.duration,
    },
    target_lufs: state.targetLufs,
    ceiling_dbtp: state.ceilingDbtp,
    oversample_factor: state.oversampleFactor,
    input: pick(before),
    delivered: pick(after),
    gain: {
      gain_db: plan.gainDb,
      gain_linear: plan.gainLinear,
      peak_constrained: plan.peakConstrained,
      target_gap_lu: plan.peakConstrained ? plan.targetGapLu : 0,
    },
    gating: 'BS.1770-4 absolute -70 LUFS + relative -10 LU; 400ms block / 100ms hop',
    generated_at: new Date().toISOString(),
  };
}

function replaceExt(name, suffix) {
  return name.replace(/\.wav$/i, '') + suffix;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
