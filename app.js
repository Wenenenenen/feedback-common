/* app.js — 页面逻辑：输入校验、变换链调度、指标、试听、绘图、导入导出 */
'use strict';
const D = window.MDCTDSP;
const el = id => document.getElementById(id);

const state = {
  input: null,   // {rate, bits, channels, frames, data:[Float64Array]}
  N: 128,
  mode: 'float',
  steps: [0.02, 0.03, 0.04, 0.05],
  local: null,   // 本地计算 {coeff[], quant[], overflow[], reconCoeff[], K, N, mode, steps[]}
  recon: null,   // 当前重建 {coeff[], signal[], N, K, rate, source:'local'|'import', header?}
  block: 0,
  ch: 0,
};

// ---------- 工具 ----------
function fmtV(v) {
  if (!isFinite(v)) return '∞';
  const a = Math.abs(v);
  if (v !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(4);
  return String(Math.round(v * 1e6) / 1e6);
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function setMsg(id, text, cls) {
  const e = el(id); e.textContent = text; e.className = 'msg' + (cls ? ' ' + cls : '');
}
function setupCanvas(cvs, hCss) {
  const dpr = window.devicePixelRatio || 1;
  const w = cvs.clientWidth || 1100;
  cvs.width = Math.round(w * dpr); cvs.height = Math.round(hCss * dpr);
  cvs.style.height = hCss + 'px';
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hCss);
  return { ctx, w, h: hCss };
}
function drawStrip(ctx, data, x0, w, y0, h, color, label) {
  const mid = y0 + h / 2, amp = h / 2 - 4;
  ctx.strokeStyle = '#2a3340';
  ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + w, mid); ctx.stroke();
  ctx.fillStyle = color;
  const n = data.length;
  for (let px = 0; px < w; px++) {
    const i0 = Math.floor(px / w * n), i1 = Math.max(i0 + 1, Math.ceil((px + 1) / w * n));
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i < i1; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn > 1.05) mn = 1.05; if (mn < -1.05) mn = -1.05;
    if (mx > 1.05) mx = 1.05; if (mx < -1.05) mx = -1.05;
    ctx.fillRect(x0 + px, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
  }
  ctx.fillStyle = '#8b98a8'; ctx.font = '11px sans-serif';
  ctx.fillText(label, x0 + 6, y0 + 14);
}

// ---------- 输入 ----------
el('wavFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  setMsg('wavError', ''); setMsg('wavInfo', '');
  el('wavTable').classList.add('hidden');
  if (!f) return;
  try {
    const wav = D.parseWav(await f.arrayBuffer());
    state.input = wav;
    invalidateResults();
    el('wavTable').classList.remove('hidden');
    el('wiRate').textContent = wav.rate + ' Hz';
    el('wiCh').textContent = wav.channels === 1 ? '单声道' : '双声道';
    el('wiBits').textContent = wav.bits + ' 位 PCM';
    el('wiFrames').textContent = wav.frames;
    el('wiDur').textContent = (wav.frames / wav.rate).toFixed(3) + ' s';
    updateBlocksLabel();
    setMsg('wavInfo', '已加载：' + f.name, 'ok');
  } catch (err) {
    state.input = null;
    invalidateResults();
    setMsg('wavError', '拒绝载入：' + err.message, 'error');
  }
  updateButtons();
});

function updateBlocksLabel() {
  el('wiBlocks').textContent = state.input
    ? D.frameCount(state.input.frames, state.N) + '（K = ⌈L/N⌉+1）' : '—';
}

// ---------- 参数 ----------
document.querySelectorAll('input[name=n]').forEach(r => r.addEventListener('change', () => {
  state.N = Number(r.value);
  updateBlocksLabel();
  invalidateResults();
}));
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => {
  state.mode = r.value;
  el('stepsCol').style.opacity = state.mode === 'int16' ? '1' : '.45';
  invalidateResults();
}));
document.querySelectorAll('.step').forEach(inp => inp.addEventListener('change', invalidateResults));

function invalidateResults() {
  state.local = null; state.recon = null;
  stopPlayback();
  ['metricsSec', 'playSec', 'overviewSec', 'blockSec'].forEach(id => el(id).classList.add('hidden'));
  updateButtons();
}

function readSteps() {
  const steps = [...document.querySelectorAll('.step')].map(i => Number(i.value));
  if (!steps.every(s => isFinite(s) && s > 0)) throw new Error('四个频带步长必须都是正数');
  return steps;
}

// ---------- 运行变换链 ----------
el('runBtn').addEventListener('click', () => {
  setMsg('paramError', '');
  try {
    const inp = state.input;
    if (!inp) throw new Error('请先加载 WAV');
    const N = state.N, mode = state.mode;
    const steps = readSteps();
    state.steps = steps;
    const coeff = [], quant = [], overflow = [], reconCoeff = [], signal = [];
    let K = 0;
    for (let c = 0; c < inp.channels; c++) {
      const a = D.analyzeChannel(inp.data[c], N);
      K = a.K;
      coeff.push(a.coeff);
      if (mode === 'int16') {
        const { q, overflow: ov } = D.quantize(a.coeff, N, steps);
        quant.push(q); overflow.push(ov);
        reconCoeff.push(D.dequantize(q, N, steps)); // 不截断，溢出照样解码
      } else {
        quant.push(null); overflow.push(new Map());
        reconCoeff.push(a.coeff.slice());
      }
      signal.push(D.synthesizeChannel(reconCoeff[c], N, inp.frames));
    }
    state.local = { coeff, quant, overflow, reconCoeff, K, N, mode, steps: steps.slice() };
    state.recon = { coeff: reconCoeff, signal, N, K, rate: inp.rate, source: 'local' };
    state.block = 0;
    renderAll();
  } catch (err) {
    setMsg('paramError', err.message, 'error');
  }
});

// ---------- 渲染 ----------
function renderAll() {
  renderMetrics();
  renderOverview();
  renderBlock();
  updatePlayUI();
  updateButtons();
}

function reconChannels() { return state.recon ? state.recon.signal.length : 0; }

function comparable() {
  return state.input && state.recon &&
    state.input.frames === state.recon.signal[0].length &&
    state.input.channels === reconChannels() &&
    state.input.rate === state.recon.rate;
}

function renderMetrics() {
  const r = state.recon;
  if (!r) { el('metricsSec').classList.add('hidden'); return; }
  el('metricsSec').classList.remove('hidden');
  const l = state.local;
  el('srcBadge').textContent = r.source === 'local'
    ? (l && l.mode === 'int16' ? '本地计算 · 16 位量化' : '本地计算 · 浮点旁路')
    : '导入 ZIP · 独立解码（N=' + r.N + '，' + r.header.storage + '）';
  const cards = el('metricCards');
  cards.innerHTML = '';
  if (comparable()) {
    const L = state.input.frames;
    const okLen = r.signal.every(s => s.length === L);
    setMsg('lenCheck', okLen
      ? `✓ 恢复长度 ${L} 与原始帧数一致`
      : `✗ 恢复长度 ${r.signal[0].length} ≠ 原始帧数 ${L}`, okLen ? 'ok' : 'error');
    for (let c = 0; c < reconChannels(); c++) {
      const m = D.metrics(state.input.data[c], r.signal[c]);
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `<h3>声道 ${c}</h3>
        <div class="metric"><span>误差能量（均方差）</span><b>${m.mse.toExponential(4)}</b></div>
        <div class="metric"><span>SNR</span><b>${m.lossless ? '∞' : m.snr.toFixed(2) + ' dB'}</b></div>
        ${m.lossless ? '<span class="badge">无损</span>' : ''}`;
      cards.appendChild(div);
    }
  } else {
    setMsg('lenCheck', state.input
      ? '导入系数与当前 WAV 的采样率/声道/帧数不一致，不做误差对比'
      : '未加载原始 WAV，仅显示独立解码结果', 'warn');
  }
  // 溢出报告（指出频带）
  const ovLines = [];
  if (l && l.mode === 'int16') {
    l.overflow.forEach((ov, c) => {
      for (const [band, e] of [...ov.entries()].sort()) {
        ovLines.push(`声道 ${c} 频带 ${band}：${e.count} 个系数溢出，最大 |q| = ${e.maxAbs}`);
      }
    });
  }
  setMsg('overflowMsg', ovLines.length
    ? '量化溢出（q 超出 [-32768,32767]，未截断；已禁止 int16 导出）：\n' + ovLines.join('\n') : '', 'error');
}

// ---------- 波形总览 ----------
function renderOverview() {
  const r = state.recon;
  if (!r) { el('overviewSec').classList.add('hidden'); return; }
  el('overviewSec').classList.remove('hidden');
  const { ctx, w, h } = setupCanvas(el('overview'), 270);
  const L = r.signal[0].length;
  const cmp = comparable();
  // 选中块高亮：块 b 覆盖输出 [bN-N, bN+N)
  const lo = Math.max(0, state.block * r.N - r.N), hi = Math.min(L, state.block * r.N + r.N);
  ctx.fillStyle = 'rgba(77,163,255,.10)';
  ctx.fillRect(lo / L * w, 0, (hi - lo) / L * w, h);
  const strips = cmp ? 3 : 1;
  const sh = h / strips;
  if (cmp) {
    drawStrip(ctx, mixdown(state.input.data), 0, w, 0, sh, '#9aa8ba', '原声');
    drawStrip(ctx, mixdown(r.signal), 0, w, sh, sh, '#4da3ff', '重建');
    drawStrip(ctx, diffSignal(), 0, w, 2 * sh, sh, '#ff5f6b', '差分（原声 − 重建）');
  } else {
    drawStrip(ctx, mixdown(r.signal), 0, w, 0, h, '#4da3ff', '重建');
  }
  // 块边界（输出坐标中位于 N 的整数倍）
  ctx.strokeStyle = 'rgba(255,201,77,.35)';
  for (let i = r.N; i < L; i += r.N) {
    const x = i / L * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
}

function mixdown(data) {
  if (data.length === 1) return data[0];
  const out = new Float64Array(data[0].length);
  for (let i = 0; i < out.length; i++) out[i] = (data[0][i] + data[1][i]) / 2;
  return out;
}
function diffSignal() {
  const a = mixdown(state.input.data), b = mixdown(state.recon.signal);
  const out = new Float64Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
  return out;
}

el('overview').addEventListener('click', e => {
  const r = state.recon;
  if (!r) return;
  const rect = e.target.getBoundingClientRect();
  const i = (e.clientX - rect.left) / rect.width * r.signal[0].length;
  state.block = Math.max(0, Math.min(r.K - 1, Math.floor((i + r.N) / r.N)));
  renderOverview();
  renderBlock();
});

// ---------- 块检查器 ----------
let coeffGeom = null;

function localCoeffFor(b, c) {
  const l = state.local, r = state.recon;
  if (!l || !r || l.N !== r.N || l.K !== r.K) return null;
  return l.coeff[c].subarray(b * l.N, b * l.N + l.N);
}

function renderBlock() {
  const r = state.recon;
  if (!r) { el('blockSec').classList.add('hidden'); return; }
  el('blockSec').classList.remove('hidden');
  const nCh = reconChannels();
  state.ch = Math.min(state.ch, nCh - 1);
  el('chSelLabel').style.display = nCh > 1 ? '' : 'none';
  const chSel = el('chSel');
  chSel.innerHTML = '';
  for (let c = 0; c < nCh; c++) {
    const o = document.createElement('option');
    o.value = c; o.textContent = '声道 ' + c;
    chSel.appendChild(o);
  }
  chSel.value = state.ch;
  const slider = el('blockSlider'), num = el('blockNum');
  slider.max = num.max = r.K - 1;
  slider.value = num.value = state.block;
  const N = r.N, b = state.block, c = state.ch;
  const L = r.signal[0].length;
  el('blockInfo').textContent =
    `块 ${b} / ${r.K - 1} · 覆盖输出样本 [${Math.max(0, b * N - N)}, ${Math.min(L, b * N + N)}) · 每块 ${N} 个系数`;

  const dec = r.coeff[c].subarray(b * N, b * N + N);
  const orig = localCoeffFor(b, c);
  drawCoeffPlot(dec, orig, N);
  drawErrPlot(orig, dec, N);
  drawBlockRecon(dec, orig, N);
}

function bandSteps() {
  if (state.local) return state.local.steps;
  if (state.recon && state.recon.header) return state.recon.header.steps;
  return state.steps;
}

function drawCoeffPlot(dec, orig, N) {
  const { ctx, w, h } = setupCanvas(el('coeffCanvas'), 220);
  const x0 = 8, y0 = 8, pw = w - 16, ph = h - 16;
  let ymax = 1e-6;
  for (let k = 0; k < N; k++) {
    ymax = Math.max(ymax, Math.abs(dec[k]), orig ? Math.abs(orig[k]) : 0);
  }
  coeffGeom = { x0, y0, w: pw, h: ph, ymax, N };
  const steps = bandSteps();
  // 频带底纹
  for (let i = 0; i < 4; i++) {
    const xa = x0 + pw * (i * N / 4) / N, xb = x0 + pw * ((i + 1) * N / 4) / N;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.015)';
    ctx.fillRect(xa, y0, xb - xa, ph);
    ctx.fillStyle = '#8b98a8'; ctx.font = '11px sans-serif';
    ctx.fillText(`带${i} Δ=${steps[i]}`, xa + 4, y0 + 13);
  }
  const mid = y0 + ph / 2;
  ctx.strokeStyle = '#2a3340';
  ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + pw, mid); ctx.stroke();
  const plot = (arr, color) => {
    ctx.strokeStyle = color; ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const x = x0 + pw * (k + 0.5) / N, y = mid - arr[k] / ymax * (ph / 2 - 2);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  };
  if (orig) plot(orig, '#4da3ff');
  plot(dec, '#ff9f43');
  if (!orig) {
    ctx.fillStyle = '#8b98a8';
    ctx.fillText('（无同参数本地系数，仅显示重建用系数）', x0 + 8, y0 + ph - 8);
  }
}

el('coeffCanvas').addEventListener('mousemove', e => {
  const r = state.recon;
  if (!r || !coeffGeom) return;
  const rect = e.target.getBoundingClientRect();
  const g = coeffGeom;
  const k = Math.max(0, Math.min(g.N - 1,
    Math.floor((e.clientX - rect.left - g.x0) / g.w * g.N)));
  const N = r.N, b = state.block, c = state.ch;
  const dec = r.coeff[c][b * N + k];
  const orig = localCoeffFor(b, c);
  const band = D.bandOf(k, N);
  const steps = bandSteps();
  let qTxt = '';
  const l = state.local;
  if (l && l.mode === 'int16' && l.N === N && l.quant[c]) qTxt = ` · q=${l.quant[c][b * N + k]}`;
  el('coeffReadout').textContent =
    `k=${k} · 频带 ${band}（Δ=${steps[band]}）` +
    (orig ? ` · 原始=${fmtV(orig[k])}` : '') +
    ` · 重建用=${fmtV(dec)}` +
    (orig ? ` · 误差=${fmtV(orig[k] - dec)}` : '') + qTxt;
  renderBlockCursor(k);
});

function renderBlockCursor(k) {
  // 重绘系数图并叠加光标
  const r = state.recon;
  const N = r.N, b = state.block, c = state.ch;
  drawCoeffPlot(r.coeff[c].subarray(b * N, b * N + N), localCoeffFor(b, c), N);
  const g = coeffGeom;
  const ctx = el('coeffCanvas').getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  const x = g.x0 + g.w * (k + 0.5) / g.N;
  ctx.beginPath(); ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.h); ctx.stroke();
}

function drawErrPlot(orig, dec, N) {
  const { ctx, w, h } = setupCanvas(el('errCanvas'), 120);
  const x0 = 8, y0 = 8, pw = w - 16, ph = h - 16;
  const mid = y0 + ph / 2;
  ctx.strokeStyle = '#2a3340';
  ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + pw, mid); ctx.stroke();
  ctx.font = '11px sans-serif';
  if (!orig) {
    ctx.fillStyle = '#8b98a8';
    ctx.fillText('无本地原始系数可比较（导入解码或未运行本地链）', x0 + 8, mid - 6);
    return;
  }
  let ymax = 0;
  for (let k = 0; k < N; k++) ymax = Math.max(ymax, Math.abs(orig[k] - dec[k]));
  if (ymax === 0) {
    ctx.fillStyle = '#3fce8b';
    ctx.fillText('误差全为 0（浮点旁路 / 未量化）', x0 + 8, mid - 6);
    return;
  }
  ctx.strokeStyle = '#ff5f6b'; ctx.beginPath();
  for (let k = 0; k < N; k++) {
    const x = x0 + pw * (k + 0.5) / N, y = mid - (orig[k] - dec[k]) / ymax * (ph / 2 - 2);
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#8b98a8';
  ctx.fillText(`max |误差| = ${fmtV(ymax)}`, x0 + 8, y0 + 12);
}

function drawBlockRecon(dec, orig, N) {
  const { ctx, w, h } = setupCanvas(el('reconCanvas'), 140);
  const x0 = 8, y0 = 8, pw = w - 16, ph = h - 16;
  const T = D.getTables(N);
  const yDec = new Float64Array(2 * N);
  D.imdctBlock(dec, N, yDec, T);
  const yOrig = orig ? new Float64Array(2 * N) : null;
  if (orig) D.imdctBlock(orig, N, yOrig, T);
  let ymax = 1e-6;
  for (let n = 0; n < 2 * N; n++) {
    ymax = Math.max(ymax, Math.abs(yDec[n]), yOrig ? Math.abs(yOrig[n]) : 0);
  }
  const mid = y0 + ph / 2;
  ctx.strokeStyle = '#2a3340';
  ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + pw, mid); ctx.stroke();
  const plot = (arr, color) => {
    ctx.strokeStyle = color; ctx.beginPath();
    for (let n = 0; n < 2 * N; n++) {
      const x = x0 + pw * (n + 0.5) / (2 * N), y = mid - arr[n] / ymax * (ph / 2 - 2);
      n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  };
  if (yOrig) plot(yOrig, '#4da3ff');
  plot(yDec, '#ff9f43');
}

el('blockSlider').addEventListener('input', e => {
  state.block = Number(e.target.value);
  renderOverview(); renderBlock();
});
el('blockNum').addEventListener('change', e => {
  const r = state.recon;
  if (!r) return;
  state.block = Math.max(0, Math.min(r.K - 1, Number(e.target.value) || 0));
  renderOverview(); renderBlock();
});
el('chSel').addEventListener('change', e => {
  state.ch = Number(e.target.value);
  renderBlock();
});

// ---------- 试听 ----------
const player = {
  ctx: null, nodes: [], gains: {}, playing: false,
  startedAt: 0, offset: 0, current: 'recon', raf: 0,
};

function playDuration() {
  return state.recon ? state.recon.signal[0].length / state.recon.rate : 0;
}

function updatePlayUI() {
  const r = state.recon;
  el('playSec').classList.toggle('hidden', !r);
  if (!r) return;
  const cmp = comparable();
  document.querySelectorAll('#srcSeg button').forEach(b => {
    const src = b.dataset.src;
    b.disabled = (src === 'orig' || src === 'diff') ? !cmp : false;
    b.classList.toggle('on', src === player.current);
  });
  if (!cmp && player.current !== 'recon') setSource('recon');
  updateTimeLabel();
}

function makeBuffer(data) {
  const ctx = player.ctx;
  const buf = ctx.createBuffer(data.length, data[0].length, state.recon.rate);
  for (let c = 0; c < data.length; c++) buf.getChannelData(c).set(data[c]);
  return buf;
}

function startPlayback() {
  if (!state.recon) return;
  if (!player.ctx) player.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = player.ctx;
  ctx.resume();
  stopNodes();
  const buffers = { recon: makeBuffer(state.recon.signal) };
  if (comparable()) {
    buffers.orig = makeBuffer(state.input.data);
    const diff = state.input.data.map((ch, c) => {
      const out = new Float64Array(ch.length);
      const rc = state.recon.signal[c];
      for (let i = 0; i < out.length; i++) out[i] = ch[i] - rc[i];
      return out;
    });
    buffers.diff = makeBuffer(diff);
  }
  const loop = el('loopChk').checked;
  const t = ctx.currentTime + 0.05;
  const dur = playDuration();
  player.offset %= dur;
  for (const [name, buf] of Object.entries(buffers)) {
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = loop;
    const g = ctx.createGain();
    g.gain.value = name === player.current ? 1 : 0;
    src.connect(g).connect(ctx.destination);
    src.start(t, player.offset);
    if (!loop) src.onended = () => { if (player.playing) pausePlayback(true); };
    player.nodes.push(src);
    player.gains[name] = g;
  }
  player.startedAt = t;
  player.playing = true;
  el('playBtn').textContent = '⏸ 暂停';
  tickProgress();
}

function stopNodes() {
  for (const n of player.nodes) { try { n.stop(); } catch (e) { /* 已停止 */ } }
  player.nodes = [];
  player.gains = {};
}

function pausePlayback(reset) {
  if (!reset) player.offset = currentPos();
  else player.offset = 0;
  stopNodes();
  player.playing = false;
  cancelAnimationFrame(player.raf);
  el('playBtn').textContent = '▶ 播放';
  updateTimeLabel();
}

function stopPlayback() {
  if (player.playing) pausePlayback(true);
  player.offset = 0;
}

function currentPos() {
  if (!player.playing) return player.offset;
  return (player.offset + Math.max(0, player.ctx.currentTime - player.startedAt)) % playDuration();
}

function setSource(name) {
  player.current = name;
  document.querySelectorAll('#srcSeg button').forEach(b =>
    b.classList.toggle('on', b.dataset.src === name));
  if (player.playing) {
    const t = player.ctx.currentTime;
    for (const [n, g] of Object.entries(player.gains)) {
      g.gain.setTargetAtTime(n === name ? 1 : 0, t, 0.01);
    }
  }
}

function updateTimeLabel() {
  const dur = playDuration();
  el('timeLabel').textContent =
    (player.playing ? currentPos() : player.offset).toFixed(3) + ' / ' + dur.toFixed(3) + ' s';
  el('progress').firstElementChild.style.width =
    (dur ? ((player.playing ? currentPos() : player.offset) / dur) * 100 : 0) + '%';
}

function tickProgress() {
  if (!player.playing) return;
  updateTimeLabel();
  player.raf = requestAnimationFrame(tickProgress);
}

el('playBtn').addEventListener('click', () => {
  if (player.playing) pausePlayback(false);
  else startPlayback();
});
document.querySelectorAll('#srcSeg button').forEach(b =>
  b.addEventListener('click', () => { if (!b.disabled) setSource(b.dataset.src); }));
el('progress').addEventListener('click', e => {
  if (!state.recon) return;
  const rect = e.target.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width * playDuration();
  if (player.playing) {
    player.offset = pos;
    startPlayback(); // 从新位置重启
  } else {
    player.offset = pos;
    updateTimeLabel();
  }
});

// ---------- 导入导出 ----------
function updateButtons() {
  el('runBtn').disabled = !state.input;
  const l = state.local;
  let zipOk = !!l;
  if (l && l.mode === 'int16') {
    const hasOv = l.overflow.some(ov => ov.size > 0);
    if (hasOv) zipOk = false;
  }
  el('expZip').disabled = !zipOk;
  el('expWav').disabled = !state.recon;
}

el('expZip').addEventListener('click', () => {
  const l = state.local, inp = state.input;
  if (!l || !inp) return;
  try {
    const storage = l.mode === 'float' ? 'float32le' : 'int16le';
    const zip = D.packCoefficients({
      rate: inp.rate, channels: inp.channels, frames: inp.frames,
      N: l.N, blocks: l.K, storage, steps: l.steps,
      coeff: l.coeff, quant: l.quant,
    });
    download(zip, `mdct-coefficients-N${l.N}-${storage}.zip`, 'application/zip');
    setMsg('ioMsg', `已导出系数 ZIP（storage=${storage}，K=${l.K}，N=${l.N}）`, 'ok');
  } catch (err) {
    setMsg('ioMsg', '导出失败：' + err.message, 'error');
  }
});

el('expWav').addEventListener('click', () => {
  if (!state.recon) return;
  try {
    const buf = D.encodeWav24(state.recon.signal, state.recon.rate);
    download(buf, 'reconstruction-24bit.wav', 'audio/wav');
    setMsg('ioMsg', '已导出 24 位 PCM WAV（限幅 [-1, 1-2⁻²³]，远离零舍入）', 'ok');
  } catch (err) {
    setMsg('ioMsg', '导出失败：' + err.message, 'error');
  }
});

el('impZip').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { header, coeff } = await D.unpackCoefficients(await f.arrayBuffer());
    const signal = coeff.map(c => D.synthesizeChannel(c, header.N, header.frames));
    stopPlayback();
    state.recon = {
      coeff, signal, N: header.N, K: header.blocks,
      rate: header.rate, source: 'import', header,
    };
    // 本地系数仅在参数一致时保留用于对比
    if (state.local && (state.local.N !== header.N || state.local.K !== header.blocks))
      state.local = null;
    state.block = 0;
    renderAll();
    setMsg('ioMsg',
      `已导入并独立解码：${f.name}（N=${header.N}，K=${header.blocks}，frames=${header.frames}，` +
      `${header.channels} 声道，${header.rate} Hz，${header.storage}）`, 'ok');
  } catch (err) {
    setMsg('ioMsg', '导入失败，已拒绝：' + err.message, 'error');
  }
  updateButtons();
});

// 窗口尺寸变化时重绘
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderOverview(); renderBlock(); }, 150);
});
