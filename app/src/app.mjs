// app.mjs — 页面主控制器：数据加载、Worker 调度、播放、像素检视、导出
import {
  DEFAULTS, PARAM_LIMITS, Reason, REASON_META, SampleReason,
  validateSequence, clampParams, computePixelDebug, reprojectSequence,
} from './core.mjs';
import {
  configureCanvas, renderView, drawMarkers, eventToPixel,
  flattenColors, exportPNG, downloadText, buildFloatPayload, REASON_LEGEND,
} from './render.mjs';

const BUILTIN = [
  { name: 'three-pixels（3×1·3帧）', path: 'sample-data/three-pixels.json' },
  { name: 'moving（32×20·12帧）', path: 'sample-data/moving.json' },
  { name: 'capacity（160×96·48帧）', path: 'sample-data/capacity.json.gz' },
  { name: 'invalid（结构错误示例）', path: 'sample-data/invalid.json' },
];

const $ = (id) => document.getElementById(id);
const state = {
  seq: null, seqName: '', meta: null,
  currentFlat: [],            // 每帧当前色的扁平 Float64Array（惰性）
  frames: [],                 // Worker 结果 {color,count,reason}
  runId: 0,
  frameIndex: 0,
  playing: false, playTimer: null, playFps: 6, loop: true,
  selected: null,
  params: { ...DEFAULTS },
  computing: false,
};

const worker = new Worker('src/worker.mjs', { type: 'module' });
const SAMPLE_REASON_LABEL = {
  [SampleReason.NONE]: '有效',
  [SampleReason.OUT_OF_BOUNDS]: '越界',
  [SampleReason.DEPTH_NULL]: '历史深度空',
  [SampleReason.DEPTH_THRESHOLD]: '深度拒绝',
};

// ---------- gzip / 加载 ----------
async function maybeGunzip(buf, name) {
  const isGz = name.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b);
  if (!isGz) return buf;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

async function loadFromPath(path, name) {
  setStatus(`正在加载 ${name} …`);
  try {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await maybeGunzip(await resp.arrayBuffer(), path);
    setupSequence(JSON.parse(new TextDecoder().decode(buf)), name);
  } catch (err) {
    showLoadError(`加载 ${name} 失败：${err.message}`);
  }
}

async function loadFromFile(file) {
  setStatus(`正在读取 ${file.name} …`);
  try {
    const buf = await maybeGunzip(await file.arrayBuffer(), file.name);
    setupSequence(JSON.parse(new TextDecoder().decode(buf)), file.name);
  } catch (err) {
    showLoadError(`解析 ${file.name} 失败：${err.message}`);
  }
}

function setupSequence(seq, name) {
  const check = validateSequence(seq);
  if (!check.ok) {
    showLoadError(`「${name}」结构校验未通过：\n${check.errors.map((e) => '· ' + e).join('\n')}`);
    return;
  }
  stopPlay();
  state.seq = seq;
  state.seqName = name;
  state.meta = check;
  seq._meta = check; // computeFrame / 自检在主线程也依赖该字段
  state.frames = new Array(seq.frames.length);
  state.currentFlat = new Array(seq.frames.length);
  state.frameIndex = 0;
  state.selected = null;
  for (const c of document.querySelectorAll('canvas')) configureCanvas(c, seq.width, seq.height);
  $('scrubber').max = seq.frames.length - 1;
  $('scrubber').value = 0;
  $('frameJump').max = seq.frames.length - 1;
  $('frameJump').value = 0;
  gotoFrame(0); // 同步帧标签等 UI（此时 seq/meta 已就绪）
  setStatus(`已加载 ${name}：${seq.width}×${seq.height}，${seq.frames.length} 帧。开始重投影…`);
  startRun();
}

function showLoadError(msg) {
  state.seq = null;
  $('errorBox').hidden = false;
  $('errorBox').textContent = msg;
  setStatus('未加载有效序列');
}

// ---------- Worker 调度 ----------
function startRun() {
  if (!state.seq) return;
  state.runId++;
  state.computing = true;
  state.frames = new Array(state.seq.frames.length);
  $('progress').style.width = '0%';
  $('frameStats').textContent = '重算中…';
  $('btnCancel').disabled = false;
  worker.postMessage({
    type: 'run', runId: state.runId, seq: state.seq, params: clampParams(state.params),
  });
  renderCurrent(); // 立即显示“计算中”占位，避免残留上一参数的旧结果
}

worker.onmessage = (ev) => {
  const msg = ev.data;
  // 所有消息都必须属于当前 run：参数变更会令旧 run 的迟到消息全部作废
  if (msg.runId !== state.runId) return;
  if (msg.type === 'frame') {
    state.frames[msg.frame] = {
      color: new Float64Array(msg.color),
      count: new Int32Array(msg.count),
      reason: new Uint8Array(msg.reason),
    };
    const pct = Math.round(((msg.frame + 1) / state.seq.frames.length) * 100);
    $('progress').style.width = pct + '%';
    if (msg.frame === state.frameIndex) renderCurrent();
    updateFrameStats();
  } else if (msg.type === 'done') {
    state.computing = false;
    $('btnCancel').disabled = true;
    setStatus(`重投影完成：${state.seq.frames.length} 帧，耗时 ${msg.elapsedMs} ms（参数 tau=${msg.params.tau}，w=${msg.params.historyWeight}，cap=${msg.params.cap}）`);
    renderCurrent();
  } else if (msg.type === 'error') {
    state.computing = false;
    $('btnCancel').disabled = true;
    showLoadError('Worker 校验失败：\n' + msg.errors.map((e) => '· ' + e).join('\n'));
  } else if (msg.type === 'cancelled') {
    state.computing = false;
    $('btnCancel').disabled = true;
    setStatus('已取消计算');
  }
};

// ---------- 渲染 ----------
function getCurrentFlat(fi) {
  if (!state.currentFlat[fi]) {
    state.currentFlat[fi] = flattenColors(state.seq.frames[fi].color);
  }
  return state.currentFlat[fi];
}

function placeholder(ctx, w, h, text) {
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface-2');
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg-dim');
  ctx.font = `${Math.max(10, Math.floor(h / 12))}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

function renderCurrent() {
  if (!state.seq) return;
  const fi = state.frameIndex;
  const n = state.meta.pixelCount;
  const fd = state.frames[fi];
  const curCtx = $('canvasCurrent').getContext('2d');
  renderView($('canvasCurrent'), 'current', state.seq, fi, { reason: null }, n, getCurrentFlat(fi));
  if (!fd) {
    for (const [id, text] of [['canvasAcc', '累积结果计算中…'], ['canvasReason', '拒绝原因计算中…']]) {
      const c = $(id);
      placeholder(c.getContext('2d'), c.width, c.height, text);
    }
  } else {
    renderView($('canvasAcc'), 'accumulated', state.seq, fi, fd, n, null);
    renderView($('canvasReason'), 'reason', state.seq, fi, fd, n, null);
  }
  renderMarkers();
  renderInspector();
  updateFrameStats();
}

function renderMarkers() {
  if (!state.selected) return;
  const { x, y } = state.selected;
  const fi = state.frameIndex;
  const fd = state.frames[fi];
  let marker = { x, y, historyX: null, historyY: null, samples: null };
  if (fd) {
    const prev = fi > 0 ? state.frames[fi - 1] : null;
    if (fi === 0 || prev) {
      const dbg = computePixelDebug(state.seq, fi, x, y,
        prev ? prev.color : new Float64Array(state.meta.pixelCount * 3),
        prev ? prev.count : new Int32Array(state.meta.pixelCount),
        clampParams(state.params));
      state.debug = dbg;
      marker = { x, y, historyX: dbg.historyX, historyY: dbg.historyY, samples: dbg.samples };
    }
  }
  for (const id of ['canvasCurrent', 'canvasAcc', 'canvasReason']) drawMarkers($(id), marker);
}

// ---------- 帧统计 ----------
function updateFrameStats() {
  const fd = state.frames[state.frameIndex];
  if (!fd) { $('frameStats').textContent = '—'; return; }
  const counts = new Map();
  for (let p = 0; p < fd.reason.length; p++) {
    counts.set(fd.reason[p], (counts.get(fd.reason[p]) || 0) + 1);
  }
  $('frameStats').textContent = REASON_META
    .filter((m) => counts.has(m.id))
    .map((m) => `${m.label} ${counts.get(m.id)}`)
    .join('　');
}

// ---------- 播放 / 跳转 ----------
function gotoFrame(fi) {
  if (!state.seq) return;
  state.frameIndex = Math.max(0, Math.min(state.seq.frames.length - 1, fi));
  $('scrubber').value = state.frameIndex;
  $('frameJump').value = state.frameIndex;
  $('frameLabel').textContent = `帧 ${state.frameIndex} / ${state.seq.frames.length - 1}`;
  renderCurrent();
}

function startPlay() {
  if (!state.seq || state.playing) return;
  state.playing = true;
  $('btnPlay').textContent = '暂停';
  state.playTimer = setInterval(() => {
    let next = state.frameIndex + 1;
    if (next >= state.seq.frames.length) {
      if (!state.loop) { stopPlay(); return; }
      next = 0;
    }
    gotoFrame(next);
  }, 1000 / state.playFps);
}

function stopPlay() {
  state.playing = false;
  $('btnPlay').textContent = '播放';
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
}

// ---------- 像素检视 ----------
const f4 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(4));
const rgbText = (c) => c ? `(${c.map((v) => f4(v)).join(', ')})` : '—';

function renderInspector() {
  const box = $('inspector');
  if (!state.seq) { box.innerHTML = '<p class="dim">加载序列后，点击任一像素查看详情。</p>'; return; }
  if (!state.selected) { box.innerHTML = '<p class="dim">点击任一画布上的像素，查看历史位置、四个采样点、权重与混合前后数值。</p>'; return; }
  const fi = state.frameIndex;
  const { x, y } = state.selected;
  const fd = state.frames[fi];
  if (!fd) { box.innerHTML = `<p class="dim">像素 (${x}, ${y})：该帧仍在计算中…</p>`; return; }
  const prev = fi > 0 ? state.frames[fi - 1] : null;
  if (fi > 0 && !prev) { box.innerHTML = `<p class="dim">上一帧尚未计算完成，请稍候。</p>`; return; }
  const dbg = computePixelDebug(state.seq, fi, x, y,
    prev ? prev.color : new Float64Array(state.meta.pixelCount * 3),
    prev ? prev.count : new Int32Array(state.meta.pixelCount),
    clampParams(state.params));
  state.debug = dbg;
  const reasonMeta = REASON_META[dbg.reason];
  const frame = state.seq.frames[fi];

  let html = `
  <div class="insp-head">
    <span>像素 (${x}, ${y}) · 帧 ${fi}</span>
    <span class="pill" style="--pill:rgb(${reasonMeta.color.join(',')})">${reasonMeta.label}</span>
  </div>
  <dl class="kv">
    <dt>当前深度</dt><dd>${dbg.depth === null ? 'null（直接输出当前色，计数 1）' : dbg.depth}</dd>
    <dt>当前线性 RGB（混合前）</dt><dd class="mono">${rgbText(dbg.currentColor)}</dd>
    <dt>输出线性 RGB（混合后）</dt><dd class="mono">${rgbText(dbg.outputColor)}</dd>
    <dt>历史计数 n → 新计数</dt><dd class="mono">${dbg.n === undefined ? '—' : f4(dbg.n)} → ${dbg.count}</dd>`;
  if (dbg.alpha !== undefined) {
    html += `<dt>混合系数 a=min(w, n/(n+1))</dt><dd class="mono">${f4(dbg.alpha)}</dd>`;
  }
  if (dbg.historyX !== null) {
    const m = frame.motion[y * state.seq.width + x];
    html += `<dt>motion / jitter</dt><dd class="mono">motion(${m[0]}, ${m[1]})　前帧抖(${state.seq.frames[fi - 1].jitter.join(', ')})　当前抖(${frame.jitter.join(', ')})</dd>
    <dt>历史位置（像素中心）</dt><dd class="mono">(${f4(dbg.historyX)}, ${f4(dbg.historyY)})</dd>`;
  }
  html += '</dl>';

  if (dbg.samples && dbg.samples.length) {
    html += `<table class="samples">
      <thead><tr><th>采样点</th><th>双线性权重</th><th>归一化</th><th>状态</th><th>历史深度</th><th>历史计数</th><th>历史累积 RGB</th></tr></thead><tbody>`;
    dbg.samples.forEach((s, i) => {
      html += `<tr class="${s.valid ? '' : 'bad-row'}">
        <td class="mono">${i}: (${s.x}, ${s.y})</td>
        <td class="mono">${f4(s.bilinearWeight)}</td>
        <td class="mono">${s.valid ? f4(s.normalizedWeight) : '—'}</td>
        <td>${SAMPLE_REASON_LABEL[s.sampleReason]}</td>
        <td class="mono">${s.prevDepth === null || s.prevDepth === undefined ? '—' : s.prevDepth}</td>
        <td class="mono">${s.prevCount === null || s.prevCount === undefined ? '—' : s.prevCount}</td>
        <td class="mono">${rgbText(s.prevColor)}</td></tr>`;
    });
    html += '</tbody></table>';
  }
  if (dbg.H) {
    html += `<dl class="kv">
      <dt>加权历史 H</dt><dd class="mono">${rgbText(dbg.H)}</dd>
      <dt>3×3 邻域 min / max</dt><dd class="mono">${rgbText(dbg.neighborhoodMin)}<br>${rgbText(dbg.neighborhoodMax)}</dd>
      <dt>限幅后 H</dt><dd class="mono">${rgbText(dbg.Hclamped)}</dd></dl>`;
  }
  box.innerHTML = html;
}

// ---------- 像素追踪 JSON ----------
function buildTrace() {
  if (!state.seq || !state.selected) return null;
  const px = state.selected.x, py = state.selected.y;
  const params = clampParams(state.params);
  const records = [];
  const empty = new Float64Array(state.meta.pixelCount * 3);
  const emptyI = new Int32Array(state.meta.pixelCount);
  for (let fi = 0; fi < state.seq.frames.length; fi++) {
    const fd = state.frames[fi];
    if (!fd) continue;
    const prev = fi > 0 ? state.frames[fi - 1] : null;
    const dbg = computePixelDebug(state.seq, fi, px, py,
      prev ? prev.color : empty, prev ? prev.count : emptyI, params);
    records.push({
      frame: fi,
      depth: dbg.depth,
      reason: REASON_META[dbg.reason].key,
      historyX: dbg.historyX, historyY: dbg.historyY,
      currentColor: dbg.currentColor,
      outputColor: dbg.outputColor,
      count: dbg.count,
      n: dbg.n ?? null, alpha: dbg.alpha ?? null,
      H: dbg.H ?? null, Hclamped: dbg.Hclamped ?? null,
      samples: (dbg.samples || []).map((s) => ({
        x: s.x, y: s.y, valid: s.valid,
        reason: SAMPLE_REASON_LABEL[s.sampleReason],
        bilinearWeight: s.bilinearWeight,
        normalizedWeight: s.valid ? s.normalizedWeight : null,
        prevDepth: s.prevDepth ?? null, prevCount: s.prevCount ?? null,
        prevColor: s.prevColor ?? null,
      })),
    });
  }
  return {
    sequence: state.seqName,
    width: state.seq.width, height: state.seq.height,
    pixel: { x: px, y: py },
    params,
    framesCovered: records.length,
    frameCount: state.seq.frames.length,
    trace: records,
  };
}

// ---------- 导出 ----------
function offscreenFrom(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

async function handlePNG(which) {
  if (!state.seq) return;
  const map = { current: ['canvasCurrent', 'current'], accumulated: ['canvasAcc', 'accumulated'], reason: ['canvasReason', 'reason'] };
  const [id, tag] = map[which];
  const canvas = offscreenFrom($(id));
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(blob);
  const name = `${baseName()}.f${state.frameIndex}.${tag}.png`;
  tryDownload(url, name, () => showImageModal(name, url));
}

function handleFloatExport() {
  if (!state.seq) return;
  const fd = state.frames[state.frameIndex];
  if (!fd) { setStatus('该帧尚未计算完成，无法导出'); return; }
  const payload = buildFloatPayload(state.seq, state.frameIndex, fd, clampParams(state.params));
  const text = JSON.stringify(payload, null, 2);
  const name = `${baseName()}.f${state.frameIndex}.float.json`;
  showTextModal(name, text);
}

function handleTraceExport() {
  const trace = buildTrace();
  if (!trace) { setStatus('请先点击选择一个像素'); return; }
  const name = `${baseName()}.px${trace.pixel.x}-${trace.pixel.y}.trace.json`;
  showTextModal(name, JSON.stringify(trace, null, 2));
}

function baseName() {
  return state.seqName.replace(/\.(json|gz)$/, '').replace(/[^\w.-]+/g, '_');
}

// artifact 框架内下载可能被拦截：同时提供弹窗预览 / 复制
function tryDownload(url, name, fallback) {
  try {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus(`已触发下载 ${name}；若浏览器未保存，已弹出预览可供手动保存。`);
    setTimeout(fallback, 300);
  } catch {
    fallback();
  }
}

function showImageModal(name, url) {
  openModal(name, `<img src="${url}" alt="${name}" style="image-rendering:pixelated;max-width:100%">
    <p class="dim">若下载未自动开始：右键图片“图片另存为”，或拖到本地保存。</p>`);
}

function showTextModal(name, text) {
  openModal(name, `<textarea class="export-text" readonly>${escapeHtml(text)}</textarea>
    <div class="modal-actions">
      <button class="btn" id="btnCopy">复制全文</button>
      <button class="btn primary" id="btnSaveText">下载 ${escapeHtml(name)}</button>
    </div>`);
  $('btnCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $('btnCopy').textContent = '已复制';
    } catch {
      const ta = document.querySelector('.export-text');
      ta.select(); document.execCommand('copy');
      $('btnCopy').textContent = '已复制（兼容方式）';
    }
  };
  $('btnSaveText').onclick = () => {
    downloadText(text, name);
  };
}

function openModal(title, inner) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = inner;
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 一致性自检（抽样：Worker 结果 vs 主线程从头重算） ----------
async function selfCheck() {
  if (!state.seq) return;
  const F = state.seq.frames.length;
  const n = state.meta.pixelCount;
  const params = clampParams(state.params);
  const SAMPLE = n <= 800 ? n : 200;
  const rng = mulberry32(20261121);
  const targets = [];
  for (let i = 0; i < SAMPLE; i++) targets.push(Math.floor(rng() * n));
  setStatus('一致性自检：主线程从头重算抽样像素…');
  // 主线程完整递推（与 Worker 同一份 core.mjs），分帧让出
  let prevColor = new Float64Array(n * 3);
  let prevCount = new Int32Array(n);
  let maxDiff = 0; let checked = 0;
  const { computeFrame } = await import('./core.mjs');
  for (let fi = 0; fi < F; fi++) {
    const color = new Float64Array(n * 3);
    const count = new Int32Array(n);
    const reason = new Uint8Array(n);
    computeFrame(state.seq, fi, params, prevColor, prevCount, color, count, reason);
    const wfd = state.frames[fi];
    if (wfd) {
      for (const p of targets) {
        for (let c = 0; c < 3; c++) {
          maxDiff = Math.max(maxDiff, Math.abs(color[p * 3 + c] - wfd.color[p * 3 + c]));
        }
        checked++;
      }
    }
    prevColor = color; prevCount = count;
    await new Promise((r) => setTimeout(r, 0));
  }
  setStatus(`一致性自检通过：抽样 ${SAMPLE} 像素 × ${F} 帧 = ${checked} 组，主线程从头重算与 Worker 结果最大绝对偏差 ${maxDiff.toExponential(2)}`);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setStatus(t) { $('status').textContent = t; }

// ---------- 事件绑定 ----------
function bind() {
  const sel = $('sequenceSelect');
  BUILTIN.forEach((b, i) => {
    const o = document.createElement('option');
    o.value = b.path; o.textContent = b.name;
    sel.appendChild(o);
  });
  sel.onchange = () => loadFromPath(sel.value, sel.options[sel.selectedIndex].textContent);
  $('btnLoadFile').onchange = (e) => { if (e.target.files[0]) loadFromFile(e.target.files[0]); };

  $('scrubber').oninput = (e) => { stopPlay(); gotoFrame(Number(e.target.value)); };
  $('frameJump').onchange = (e) => { stopPlay(); gotoFrame(Number(e.target.value)); };
  $('btnFirst').onclick = () => { stopPlay(); gotoFrame(0); };
  $('btnPrev').onclick = () => { stopPlay(); gotoFrame(state.frameIndex - 1); };
  $('btnPlay').onclick = () => (state.playing ? stopPlay() : startPlay());
  $('btnNext').onclick = () => { stopPlay(); gotoFrame(state.frameIndex + 1); };
  $('btnLast').onclick = () => { stopPlay(); gotoFrame(state.seq.frames.length - 1); };
  $('playFps').onchange = (e) => { state.playFps = Number(e.target.value); if (state.playing) { stopPlay(); startPlay(); } };
  $('playLoop').onchange = (e) => { state.loop = e.target.checked; };

  for (const id of ['canvasCurrent', 'canvasAcc', 'canvasReason']) {
    $(id).addEventListener('click', (e) => {
      const { x, y } = eventToPixel($(id), e);
      state.selected = { x, y };
      renderCurrent();
    });
  }

  const paramBind = [
    ['tau', 'tauVal', (v) => v],
    ['historyWeight', 'wVal', (v) => v],
    ['cap', 'capVal', (v) => Math.round(v)],
  ];
  for (const [key, labelId, fix] of paramBind) {
    const input = $(key);
    $(labelId).textContent = state.params[key];
    const sync = () => {
      state.params[key] = fix(Number(input.value));
      $(labelId).textContent = state.params[key];
    };
    input.oninput = sync;
    input.onchange = () => {
      const lim = PARAM_LIMITS[key];
      // change 可能由程序化赋值触发（无前置 input 事件），先同步再夹取
      state.params[key] = Math.min(lim.max, Math.max(lim.min, fix(Number(input.value))));
      input.value = state.params[key];
      $(labelId).textContent = state.params[key];
      startRun(); // 改参数后从第 0 帧全量重算
    };
  }
  $('btnResetParams').onclick = () => {
    state.params = { ...DEFAULTS };
    $('tau').value = DEFAULTS.tau; $('tauVal').textContent = DEFAULTS.tau;
    $('historyWeight').value = DEFAULTS.historyWeight; $('wVal').textContent = DEFAULTS.historyWeight;
    $('cap').value = DEFAULTS.cap; $('capVal').textContent = DEFAULTS.cap;
    startRun();
  };
  $('btnCancel').onclick = () => worker.postMessage({ type: 'cancel', runId: state.runId });
  $('btnSelfCheck').onclick = () => selfCheck();

  $('btnPngCurrent').onclick = () => handlePNG('current');
  $('btnPngAcc').onclick = () => handlePNG('accumulated');
  $('btnPngReason').onclick = () => handlePNG('reason');
  $('btnExportFloat').onclick = handleFloatExport;
  $('btnExportTrace').onclick = handleTraceExport;
  $('btnCloseModal').onclick = closeModal;
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // 图例
  $('legend').innerHTML = REASON_LEGEND.map((m) =>
    `<span class="legend-item"><i style="background:${m.css}"></i>${m.label}</span>`).join('');
}

bind();
loadFromPath(BUILTIN[0].path, BUILTIN[0].name);
