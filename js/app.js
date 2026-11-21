/* 页面逻辑：编辑 → 编译 → 渲染 → 可视化 / 探针 / 试听 / 导出 */
'use strict';

const E = window.GraphEngine;

/* 内置预设（与 samples/ 中一致） */
const PRESETS = {
  '示例：并行链对齐 + 反馈': {
    sample_rate: 48000, frames: 192, output: 'mix',
    nodes: [
      { id: 'src', type: 'impulse', events: [[0, 0.125], [4, 0.125], [6, 0.125], [8, 0.125]] },
      { id: 'fast', type: 'gain', points: [[0, 1], [4, 1], [8, 0.5]] },
      { id: 'slow', type: 'latency', samples: 3 },
      { id: 'mix', type: 'mix' },
    ],
    edges: [
      { src: 'src', dst: 'fast' },
      { src: 'src', dst: 'slow' },
      { src: 'fast', dst: 'mix' },
      { src: 'slow', dst: 'mix' },
      { src: 'mix', dst: 'mix', delay: 2, gain: 0.5 },
    ],
  },
  '反例：普通边成环': {
    sample_rate: 48000, frames: 192, output: 'mix',
    nodes: [
      { id: 'src', type: 'impulse', events: [[0, 0.125], [4, 0.125], [6, 0.125], [8, 0.125]] },
      { id: 'fast', type: 'gain', points: [[0, 1], [4, 1], [8, 0.5]] },
      { id: 'slow', type: 'latency', samples: 3 },
      { id: 'mix', type: 'mix' },
    ],
    edges: [
      { src: 'src', dst: 'fast' },
      { src: 'src', dst: 'slow' },
      { src: 'fast', dst: 'mix' },
      { src: 'slow', dst: 'mix' },
      { src: 'mix', dst: 'fast' },
    ],
  },
  '反例：零延迟反馈': {
    sample_rate: 48000, frames: 192, output: 'mix',
    nodes: [
      { id: 'src', type: 'impulse', events: [[0, 0.125], [4, 0.125], [6, 0.125], [8, 0.125]] },
      { id: 'fast', type: 'gain', points: [[0, 1], [4, 1], [8, 0.5]] },
      { id: 'slow', type: 'latency', samples: 3 },
      { id: 'mix', type: 'mix' },
    ],
    edges: [
      { src: 'src', dst: 'fast' },
      { src: 'src', dst: 'slow' },
      { src: 'fast', dst: 'mix' },
      { src: 'slow', dst: 'mix' },
      { src: 'mix', dst: 'mix', delay: 0, gain: 0.5 },
    ],
  },
};

const $ = id => document.getElementById(id);

const state = {
  spec: null,
  compiled: null,
  result: null,       // { output, buffers, frames }
  error: null,        // GraphError
  blockSize: 128,
  probeNode: null,
  probeT: 0,
  renderMs: 0,
};

/* ---------- 工具 ---------- */

function fmtNum(x) {
  if (x === null || x === undefined) return '—';
  if (Number.isInteger(x)) return String(x);
  const s = Number(x).toPrecision(7);
  return String(parseFloat(s));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 编译 + 渲染 ---------- */

function compileAndRender() {
  state.error = null;
  state.compiled = null;
  state.result = null;
  try {
    state.compiled = E.compile(state.spec);
    if (!state.probeNode || !state.compiled.nodes.has(state.probeNode)) {
      state.probeNode = state.spec.output;
    }
    if (state.probeT >= state.spec.frames) state.probeT = state.spec.frames - 1;
    const t0 = performance.now();
    state.result = E.render(state.compiled, state.blockSize, [state.probeNode]);
    state.renderMs = performance.now() - t0;
  } catch (e) {
    state.error = e;
  }
  refreshViews();
}

function refreshViews() {
  renderError();
  renderStatus();
  renderViz();
  renderCompTables();
  renderWaveform();
  renderProbe();
  const ok = !!state.result;
  $('btnPlay').disabled = !ok;
  $('btnExport').disabled = !ok;
  $('btnSelfCheck').disabled = !ok;
}

/* ---------- 错误 / 状态 ---------- */

function renderError() {
  const el = $('errorBanner');
  if (!state.error) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  let text = '✕ ' + state.error.message;
  if (state.error.code === 'cycle' && state.error.cyclePath) {
    text += '\n环路径：' + state.error.cyclePath.join(' → ');
  }
  el.textContent = text;
}

function renderStatus() {
  const el = $('statusBar');
  if (state.error) {
    el.innerHTML = `编译失败：<b>${esc(state.error.code || 'error')}</b>，请修正后重新渲染`;
    return;
  }
  const c = state.compiled;
  const frames = state.spec.frames;
  const totalLat = c.outTime.get(state.spec.output);
  el.innerHTML =
    `输出节点 <b>${esc(state.spec.output)}</b> · ` +
    `帧数 <b>${frames}</b>（${(frames / E.SAMPLE_RATE * 1000).toFixed(1)} ms @48kHz）· ` +
    `输出路径总延迟 <b>${totalLat}</b> 帧 · ` +
    `普通边 <b>${c.normalEdges.length}</b> / 反馈边 <b>${c.feedbackEdges.length}</b> · ` +
    `每批 <b>${state.blockSize}</b> 样本 · 渲染耗时 <b>${state.renderMs.toFixed(1)} ms</b>`;
}

/* ---------- 图可视化 ---------- */

function nodeSubLabel(n) {
  switch (n.type) {
    case 'impulse': return `impulse · ${n.events.length} 事件`;
    case 'gain': return `gain · ${n.points.length} 关键帧`;
    case 'latency': return `latency · ${n.samples} 帧`;
    default: return 'mix';
  }
}

function renderViz() {
  const svg = $('viz');
  const spec = state.spec;
  if (!spec || !Array.isArray(spec.nodes)) { svg.innerHTML = ''; return; }

  // 分层：普通边上做松弛（迭代上限 = 节点数，成环时也能给出近似布局）
  const nodes = spec.nodes;
  const layer = new Map(nodes.map(n => [n.id, 0]));
  const normalEdges = (spec.edges || []).filter(e => e.delay === undefined || e.delay === null);
  const feedbackEdges = (spec.edges || []).filter(e => !(e.delay === undefined || e.delay === null));
  for (let it = 0; it < nodes.length; it++) {
    for (const e of normalEdges) {
      if (layer.has(e.src) && layer.has(e.dst)) {
        layer.set(e.dst, Math.max(layer.get(e.dst), layer.get(e.src) + 1));
      }
    }
  }
  const layers = [];
  for (const [, l] of layer) layers[l] = true;
  const perLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n.id);
    if (!perLayer.has(l)) perLayer.set(l, []);
    perLayer.get(l).push(n.id);
  }

  const W = 150, H = 52, GX = 90, GY = 34;
  const maxLayer = Math.max(0, ...perLayer.keys());
  const pos = new Map();
  let maxRows = 1;
  for (const [l, ids] of perLayer) {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, i) => pos.set(id, { x: 24 + l * (W + GX), y: 46 + i * (H + GY) }));
  }
  const width = 24 + (maxLayer + 1) * (W + GX);
  const height = 46 + maxRows * (H + GY) + 30;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const cyclic = new Set(state.error && state.error.code === 'cycle' ? state.error.cycleNodes : []);
  const fbSrcs = new Set(feedbackEdges.map(e => e.src));
  const compOf = new Map();
  if (state.compiled) {
    for (const e of state.compiled.normalEdges) compOf.set(e.src + '→' + e.dst, e.comp);
  }

  let out = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b7ba6"/></marker>` +
    `<marker id="arrFb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffb74d"/></marker></defs>`;

  // 普通边
  for (const e of normalEdges) {
    const a = pos.get(e.src), b = pos.get(e.dst);
    if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const cyc = cyclic.has(e.src) && cyclic.has(e.dst);
    out += `<line class="edge" x1="${x1}" y1="${y1}" x2="${x2 - 4}" y2="${y2}" marker-end="url(#arr)"${cyc ? ' style="stroke:#ef5350;stroke-width:2.5"' : ''}/>`;
    const comp = compOf.get(e.src + '→' + e.dst);
    if (comp !== undefined && comp > 0) {
      out += `<text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">补 ${comp}</text>`;
    }
  }
  // 反馈边（虚线弧线）
  for (const e of feedbackEdges) {
    const a = pos.get(e.src), b = pos.get(e.dst);
    if (!a || !b) continue;
    const label = `d=${e.delay} g=${fmtNum(e.gain === undefined ? 1 : e.gain)}`;
    if (e.src === e.dst) {
      const cx = a.x + W / 2, top = a.y;
      out += `<path class="edge feedback" d="M ${cx - 18} ${top} C ${cx - 40} ${top - 52}, ${cx + 40} ${top - 52}, ${cx + 18} ${top}" marker-end="url(#arrFb)"/>`;
      out += `<text class="fb-label" x="${cx}" y="${top - 40}" text-anchor="middle">${esc(label)}</text>`;
    } else {
      const x1 = a.x + W / 2, y1 = a.y, x2 = b.x + W / 2, y2 = b.y;
      const my = Math.min(y1, y2) - 56;
      out += `<path class="edge feedback" d="M ${x1} ${y1} Q ${(x1 + x2) / 2} ${my}, ${x2} ${y2 - 2}" marker-end="url(#arrFb)"/>`;
      out += `<text class="fb-label" x="${(x1 + x2) / 2}" y="${my + 12}" text-anchor="middle">${esc(label)}</text>`;
    }
  }
  // 节点
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const cls = ['node'];
    if (fbSrcs.has(n.id)) cls.push('fb-src');
    if (cyclic.has(n.id)) cls.push('cyclic');
    if (state.spec.output === n.id) cls.push('output');
    out += `<g class="${cls.join(' ')}">` +
      `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8"/>` +
      `<text x="${p.x + W / 2}" y="${p.y + 22}" text-anchor="middle" font-weight="600">${esc(n.id)}</text>` +
      `<text class="sub" x="${p.x + W / 2}" y="${p.y + 39}" text-anchor="middle">${esc(nodeSubLabel(n))}</text></g>`;
  }
  svg.innerHTML = out;
}

/* ---------- 对齐补偿表 ---------- */

function renderCompTables() {
  const nt = $('nodeTimeTable'), ct = $('compTable'), tl = $('totalLatency');
  if (!state.compiled) { nt.innerHTML = ''; ct.innerHTML = ''; tl.textContent = ''; return; }
  const c = state.compiled;

  let h = '<tr><th class="l">节点</th><th>类型</th><th>输入时刻</th><th>输出时刻</th></tr>';
  for (const id of c.order) {
    h += `<tr><td class="l">${esc(id)}</td><td>${c.nodes.get(id).type}</td>` +
      `<td>${c.inTime.get(id)}</td><td>${c.outTime.get(id)}</td></tr>`;
  }
  nt.innerHTML = h;

  h = '<tr><th class="l">普通边</th><th>源输出时刻</th><th>插入补偿</th></tr>';
  for (const e of c.normalEdges) {
    h += `<tr><td class="l">${esc(e.src)} → ${esc(e.dst)}</td><td>${c.outTime.get(e.src)}</td>` +
      `<td class="${e.comp > 0 ? 'comp-pos' : ''}">${e.comp > 0 ? '+' + e.comp : '0'}</td></tr>`;
  }
  for (const e of c.feedbackEdges) {
    h += `<tr><td class="l fb">${esc(e.src)} → ${esc(e.dst)}（反馈）</td><td>—</td>` +
      `<td class="fb">不参与对齐</td></tr>`;
  }
  ct.innerHTML = h;
  tl.textContent = `输出节点 ${state.spec.output} 的总延迟：${c.outTime.get(state.spec.output)} 帧`;
}

/* ---------- 波形 ---------- */

function renderWaveform() {
  const cv = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!state.result) {
    ctx.fillStyle = '#8a99ad';
    ctx.fillText(state.error ? '图有错误，未渲染' : '无数据', 12, 20);
    return;
  }
  const data = state.result.output;
  const n = data.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  const scale = peak > 0 ? (h / 2 - 8) / peak : 1;
  const mid = h / 2;
  ctx.strokeStyle = '#2a3648';
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  ctx.strokeStyle = '#4fc3f7';
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(x * n / w), i1 = Math.max(i0 + 1, Math.floor((x + 1) * n / w));
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i < i1; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    ctx.moveTo(x + 0.5, mid - hi * scale);
    ctx.lineTo(x + 0.5, mid - lo * scale);
  }
  ctx.stroke();
  ctx.fillStyle = '#8a99ad';
  ctx.fillText(`峰值 ${fmtNum(peak)}`, 8, 14);
  // 探针位置
  if (state.probeT >= 0 && state.probeT < n) {
    const x = state.probeT / n * w;
    ctx.strokeStyle = '#ffb74d';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
}

/* ---------- 探针 ---------- */

function renderProbe() {
  const sel = $('probeNode');
  const keep = sel.value;
  sel.innerHTML = '';
  if (state.compiled) {
    for (const id of state.compiled.order) {
      const op = document.createElement('option');
      op.value = id; op.textContent = id;
      sel.appendChild(op);
    }
    sel.value = state.probeNode || keep || state.spec.output;
    state.probeNode = sel.value;
  }
  $('probeT').max = state.spec ? state.spec.frames - 1 : 0;

  const tbl = $('probeTable');
  if (!state.result || !state.probeNode) { tbl.innerHTML = ''; return; }

  const c = state.compiled;
  const inputs = c.inputsOf.get(state.probeNode) || [];
  const node = c.nodes.get(state.probeNode);
  const t0 = Math.max(0, state.probeT - 8);
  const t1 = Math.min(state.spec.frames - 1, state.probeT + 8);

  const edgeLabel = inp => inp.feedback
    ? `${inp.edge.src}→ 反馈 d=${inp.edge.delay} g=${fmtNum(inp.edge.gain)}`
    : `${inp.edge.src}→ 补${inp.edge.comp}`;

  let h = '<tr><th>样本 t</th>';
  for (const inp of inputs) h += `<th class="l">${esc(edgeLabel(inp))}</th>`;
  h += '<th>输入合计</th>';
  if (node.type === 'gain') h += '<th>g(t)</th>';
  h += '<th>输出</th></tr>';

  for (let t = t0; t <= t1; t++) {
    const p = E.probeAt(c, state.result.buffers, state.probeNode, t);
    const cols = [];
    for (const inp of inputs) {
      const list = inp.feedback ? p.feedback : p.normal;
      const rec = list.find(r => r.edge === inp.edge);
      cols.push(`<td class="${inp.feedback ? 'fb' : ''}">${fmtNum(rec ? rec.value : 0)}</td>`);
    }
    h += `<tr${t === state.probeT ? ' class="probe-center"' : ''}><td>${t}</td>` +
      cols.join('') +
      `<td>${fmtNum(p.input)}</td>` +
      (node.type === 'gain' ? `<td>${fmtNum(p.gainValue)}</td>` : '') +
      `<td><b>${fmtNum(p.output)}</b></td></tr>`;
  }
  tbl.innerHTML = h;
}

/* ---------- 结构化编辑器 ---------- */

function rebuildEditors() {
  // 图设置
  $('framesInput').value = state.spec.frames;
  const outSel = $('outputSelect');
  outSel.innerHTML = '';
  for (const n of state.spec.nodes) {
    const op = document.createElement('option');
    op.value = n.id; op.textContent = n.id;
    outSel.appendChild(op);
  }
  outSel.value = state.spec.output;

  // latency 节点
  const latBox = $('latencyEditors');
  latBox.innerHTML = '';
  const latNodes = state.spec.nodes.filter(n => n.type === 'latency');
  if (!latNodes.length) latBox.innerHTML = '<div class="empty">无 latency 节点</div>';
  for (const n of latNodes) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span class="id">${esc(n.id)}</span> 延迟 <input type="number" min="0" step="1" value="${n.samples}"> 帧`;
    div.querySelector('input').addEventListener('change', ev => {
      const v = Math.max(0, Math.round(Number(ev.target.value) || 0));
      n.samples = v; ev.target.value = v;
      syncJson(); compileAndRender();
    });
    latBox.appendChild(div);
  }

  // 反馈边
  const fbBox = $('feedbackEditors');
  fbBox.innerHTML = '';
  const fbEdges = state.spec.edges.filter(e => e.delay !== undefined && e.delay !== null);
  if (!fbEdges.length) fbBox.innerHTML = '<div class="empty">无反馈边（在 JSON 中给边加 delay 字段即成为反馈边）</div>';
  for (const e of fbEdges) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span class="tag">${esc(e.src)} → ${esc(e.dst)}</span>` +
      `delay <input type="number" min="1" step="1" value="${e.delay}"> 帧 ` +
      `gain <input type="number" step="any" value="${e.gain === undefined ? 1 : e.gain}">`;
    const [dIn, gIn] = div.querySelectorAll('input');
    dIn.addEventListener('change', ev => {
      const v = Math.round(Number(ev.target.value));
      e.delay = v; ev.target.value = v; // 非法值会在编译时报出
      syncJson(); compileAndRender();
    });
    gIn.addEventListener('change', ev => {
      e.gain = Number(ev.target.value);
      syncJson(); compileAndRender();
    });
    fbBox.appendChild(div);
  }

  // gain 关键帧
  const gBox = $('gainEditors');
  gBox.innerHTML = '';
  const gainNodes = state.spec.nodes.filter(n => n.type === 'gain');
  if (!gainNodes.length) gBox.innerHTML = '<div class="empty">无 gain 节点</div>';
  for (const n of gainNodes) {
    const div = document.createElement('div');
    div.className = 'gain-node';
    const rows = n.points.map((p, i) =>
      `<tr><td>t=<input type="number" min="0" step="any" data-i="${i}" data-k="0" value="${p[0]}"></td>` +
      `<td>g=<input type="number" step="any" data-i="${i}" data-k="1" value="${p[1]}"></td>` +
      `<td><button class="mini" data-del="${i}">删</button></td></tr>`).join('');
    div.innerHTML = `<span class="id">${esc(n.id)}</span> <span class="hint">线性插值，两端保持</span>` +
      `<table>${rows}</table><button class="mini" data-add>+ 添加关键帧</button>`;
    div.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.i), k = Number(inp.dataset.k);
        n.points[i][k] = Number(inp.value);
        syncJson(); compileAndRender();
      });
    });
    div.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        n.points.splice(Number(btn.dataset.del), 1);
        syncJson(); rebuildEditors(); compileAndRender();
      });
    });
    div.querySelector('[data-add]').addEventListener('click', () => {
      const last = n.points[n.points.length - 1] || [0, 1];
      n.points.push([last[0] + 1, last[1]]);
      syncJson(); rebuildEditors(); compileAndRender();
    });
    gBox.appendChild(div);
  }
}

function syncJson() {
  $('jsonEditor').value = JSON.stringify(state.spec, null, 2);
}

/* ---------- 播放 / 导出 ---------- */

let actx = null, source = null;

function stopPlayback() {
  if (source) { try { source.stop(); } catch (_) { /* 已停止 */ } source = null; }
}

function play() {
  if (!state.result) return;
  actx = actx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: E.SAMPLE_RATE });
  stopPlayback();
  const buf = actx.createBuffer(1, state.result.frames, E.SAMPLE_RATE);
  buf.copyToChannel(state.result.output, 0);
  source = actx.createBufferSource();
  source.buffer = buf;
  source.connect(actx.destination);
  source.onended = () => { $('btnStop').disabled = true; };
  source.start();
  $('btnStop').disabled = false;
}

function exportWav() {
  if (!state.result) return;
  const buf = E.encodeWavFloat32(state.result.output, E.SAMPLE_RATE);
  const blob = new Blob([buf], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `graph-${state.spec.output}-${state.spec.frames}f-float32.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 一致性自检 ---------- */

function selfCheck() {
  if (!state.compiled) return;
  const ref = state.result.output;
  const sizes = [1, 32, 128, 512, 2048, 48000];
  let msg = [];
  let allZero = true;
  for (const bs of sizes) {
    const out = E.render(state.compiled, bs, null).output;
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
    if (maxDiff !== 0) allZero = false;
    msg.push(`批 ${bs}: 最大差异 ${maxDiff}`);
  }
  const el = $('statusBar');
  el.innerHTML += `<br><span class="${allZero ? 'selfcheck-ok' : 'selfcheck-bad'}">` +
    `一致性自检（对照当前批大小 ${state.blockSize}）：${msg.join(' · ')}` +
    (allZero ? ' —— 全部逐位一致 ✓' : ' —— 存在差异！') + '</span>';
}

/* ---------- 事件绑定 ---------- */

function applyJson() {
  try {
    const spec = JSON.parse($('jsonEditor').value);
    state.spec = spec;
    rebuildEditors();
    compileAndRender();
  } catch (e) {
    state.error = Object.assign(new Error('JSON 解析失败：' + e.message), { code: 'json' });
    state.compiled = null; state.result = null;
    refreshViews();
  }
}

function init() {
  const presetSel = $('preset');
  for (const name of Object.keys(PRESETS)) {
    const op = document.createElement('option');
    op.value = name; op.textContent = name;
    presetSel.appendChild(op);
  }
  presetSel.addEventListener('change', () => {
    state.spec = JSON.parse(JSON.stringify(PRESETS[presetSel.value]));
    state.probeNode = null; state.probeT = 0;
    syncJson(); rebuildEditors(); compileAndRender();
  });

  $('btnApply').addEventListener('click', applyJson);
  $('blockSize').addEventListener('change', ev => {
    state.blockSize = Number(ev.target.value);
    compileAndRender();
  });
  $('btnSelfCheck').addEventListener('click', selfCheck);
  $('btnPlay').addEventListener('click', play);
  $('btnStop').addEventListener('click', () => { stopPlayback(); $('btnStop').disabled = true; });
  $('btnExport').addEventListener('click', exportWav);

  $('framesInput').addEventListener('change', ev => {
    const v = Math.round(Number(ev.target.value));
    state.spec.frames = v;
    syncJson(); compileAndRender();
  });
  $('outputSelect').addEventListener('change', ev => {
    state.spec.output = ev.target.value;
    syncJson(); compileAndRender();
  });

  $('probeNode').addEventListener('change', ev => {
    state.probeNode = ev.target.value;
    if (state.compiled) {
      state.result = E.render(state.compiled, state.blockSize, [state.probeNode]);
    }
    renderProbe(); renderWaveform();
  });
  $('probeT').addEventListener('change', ev => {
    state.probeT = Math.max(0, Math.round(Number(ev.target.value) || 0));
    renderProbe(); renderWaveform();
  });
  $('wave').addEventListener('click', ev => {
    if (!state.result) return;
    const rect = ev.target.getBoundingClientRect();
    state.probeT = Math.round((ev.clientX - rect.left) / rect.width * (state.result.frames - 1));
    $('probeT').value = state.probeT;
    renderProbe(); renderWaveform();
  });
  window.addEventListener('resize', renderWaveform);

  // 默认加载第一个预设
  state.spec = JSON.parse(JSON.stringify(PRESETS[Object.keys(PRESETS)[0]]));
  syncJson(); rebuildEditors(); compileAndRender();
}

init();
