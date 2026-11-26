/* app.js — 页面逻辑：导入/渲染/查看/试听/导出 */
'use strict';
/* global RenderCore, JSZip */
const RC = RenderCore;
const $ = (sel) => document.querySelector(sel);

const state = {
  bank: null,        // normalizeBank 结果
  bankRaw: null,     // 原始 JSON（导出用）
  sources: [],       // {name, samples, trackFrames, trackAngs, rendered:{left,right}|null, dirty}
  wavPool: new Map(),// 文件名 -> Int16Array（导入工程时解析 wav）
  rendering: false,
  workers: [],
  renderTimer: null,
  audio: { ctx: null, src: null },
  playTarget: 'mix', // 'mix' 或源下标字符串
  renderVersion: 0,  // 任何渲染结果变化时 +1（量化缓存键）
  quantCache: null,  // {key, ql, qr}
  mixCache: null,    // {left, right} Float64Array
  sel: { start: 0, end: 0 },
  te: null,          // 轨迹编辑器状态
};

/* ---------------- 通用 ---------------- */

let msgTimer = null;
function showMsg(text, ms = 4000) {
  const el = $('#msg');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function totalLen() {
  if (!state.bank || state.sources.length === 0) return 0;
  const maxN = Math.max(...state.sources.map((s) => s.samples.length));
  return RC.totalLength(maxN, state.bank.L);
}

function fmtDeg(centi) { return (centi / 100).toFixed(2) + '°'; }

/* ---------------- 声源与工程导入 ---------------- */

function addSource(name, samples, trackFrames, trackAngs) {
  if (state.sources.length >= RC.MAX_SOURCES) throw new Error(`最多 ${RC.MAX_SOURCES} 条声源`);
  if (samples.length > RC.MAX_FRAMES) throw new Error(`${name}：录音超过 30 秒`);
  state.sources.push({
    name, samples, trackFrames, trackAngs,
    rendered: null, dirty: true,
  });
  fitRendered();
}

/** 总长变化后，把已渲染缓冲零填充/截断到新长度（尾部本为零，不影响其他声源结果）。 */
function fitRendered() {
  const total = totalLen();
  for (const o of state.sources) {
    if (!o.rendered) continue;
    for (const ear of ['left', 'right']) {
      const old = o.rendered[ear];
      if (old.length === total) continue;
      const nw = new Float64Array(total);
      nw.set(old.subarray(0, Math.min(old.length, total)));
      o.rendered[ear] = nw;
    }
  }
}

async function decodeWavFile(file) {
  const buf = await file.arrayBuffer();
  return RC.decodeWavPcm16Mono(buf);
}

function defaultTrack(n) {
  return n === 1
    ? { frames: Int32Array.from([0]), angs: Int32Array.from([0]) }
    : { frames: Int32Array.from([0, n - 1]), angs: Int32Array.from([0, 0]) };
}

function importProjectJson(proj) {
  const bank = RC.normalizeBank(proj.bank);
  const missing = [];
  const toAdd = [];
  for (const s of proj.sources || []) {
    const samples = state.wavPool.get(s.wav);
    if (!samples) { missing.push(s.wav); continue; }
    const track = RC.normalizeTrack(s.track, samples.length);
    toAdd.push({ name: s.wav, samples, track });
  }
  if (toAdd.length === 0 && missing.length > 0) {
    throw new Error('缺少 WAV：' + missing.join('、') + '（请先用「补充 WAV」选择同名文件）');
  }
  state.bank = bank;
  state.bankRaw = proj.bank;
  for (const t of toAdd) addSource(t.name, t.samples, t.track.frames, t.track.angs);
  // 方位库变化 → 所有已渲染结果失效
  for (const s of state.sources) { s.rendered = null; s.dirty = true; }
  state.mixCache = null; state.quantCache = null;
  state.renderVersion++;
  if (missing.length > 0) showMsg('未找到 WAV，已跳过：' + missing.join('、'), 6000);
}

async function importZip(file) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载（需联网加载 CDN），可改用「导入工程 JSON + 补充 WAV」');
  const zip = await JSZip.loadAsync(file);
  const projEntry = zip.file('project.json');
  if (!projEntry) throw new Error('ZIP 内缺少 project.json');
  const proj = JSON.parse(await projEntry.async('string'));
  for (const s of proj.sources || []) {
    if (state.wavPool.has(s.wav)) continue;
    const entry = zip.file(s.wav);
    if (!entry) continue;
    const buf = await entry.async('arraybuffer');
    state.wavPool.set(s.wav, RC.decodeWavPcm16Mono(buf));
  }
  importProjectJson(proj);
}

function exportProjectJson() {
  if (!state.bankRaw) { showMsg('尚未加载方位库'); return; }
  const proj = {
    bank: state.bankRaw,
    sources: state.sources.map((s) => ({
      wav: s.name,
      track: Array.from(s.trackFrames, (f, i) => [f, s.trackAngs[i]]),
    })),
  };
  downloadBlob(new Blob([JSON.stringify(proj)], { type: 'application/json' }), 'project.json');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- 渲染 ---------------- */

function dirtySourceIds() {
  const ids = [];
  state.sources.forEach((s, i) => { if (s.dirty) ids.push(i); });
  return ids;
}

function startRender(srcIds) {
  if (state.rendering) cancelRender();
  if (!state.bank) { showMsg('请先加载耳响应库'); return; }
  if (srcIds.length === 0) { showMsg('没有待渲染的声源'); return; }
  const total = totalLen();
  const tasks = [];
  for (const id of srcIds) {
    tasks.push({ srcId: id, ear: 'left' }, { srcId: id, ear: 'right' });
  }
  const totalFrames = tasks.reduce((acc, t) => acc + state.sources[t.srcId].samples.length, 0);
  const progress = new Map(); // taskKey -> done
  let finished = 0;

  state.rendering = true;
  state.renderStart = performance.now();
  $('#btn-render').disabled = true;
  $('#btn-cancel').disabled = false;
  $('#render-progress').value = 0;
  $('#render-status').textContent = '渲染中…';

  const poolSize = Math.min(tasks.length, Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)));
  const taskQueue = tasks.slice();
  const results = new Map(); // srcId -> {left?, right?}
  let nextTaskId = 0;

  const updateProgress = () => {
    let done = 0;
    for (const v of progress.values()) done += v;
    $('#render-progress').value = totalFrames ? done / totalFrames : 0;
  };

  const finishIfDone = () => {
    if (finished < tasks.length) return;
    // 全部完成：写入结果
    for (const [srcId, r] of results) {
      const s = state.sources[srcId];
      if (r.left && r.right) {
        s.rendered = { left: r.left, right: r.right };
        s.dirty = false;
      }
    }
    state.mixCache = null; state.quantCache = null;
    state.renderVersion++;
    state.rendering = false;
    state.workers.forEach((w) => w.terminate());
    state.workers = [];
    $('#btn-render').disabled = false;
    $('#btn-cancel').disabled = true;
    const sec = ((performance.now() - state.renderStart) / 1000).toFixed(1);
    $('#render-status').textContent = `完成，用时 ${sec} s`;
    $('#render-progress').value = 1;
    refreshUI();
    showMsg(`渲染完成（${sec} s）`);
  };

  const assign = (worker) => {
    const t = taskQueue.shift();
    if (!t) return;
    const s = state.sources[t.srcId];
    const taskId = nextTaskId++;
    const key = `${t.srcId}:${t.ear}`;
    worker._task = { taskId, key, srcId: t.srcId, ear: t.ear };
    const taps = t.ear === 'left' ? state.bank.left : state.bank.right;
    const delays = t.ear === 'left' ? state.bank.leftDelay : state.bank.rightDelay;
    const samplesCopy = s.samples.slice();
    worker.postMessage({
      type: 'render', taskId, srcId: t.srcId, ear: t.ear,
      samples: samplesCopy.buffer,
      trackFrames: s.trackFrames.slice().buffer,
      trackAngs: s.trackAngs.slice().buffer,
      angles: state.bank.angles.slice().buffer,
      taps: taps.slice().buffer,
      delays: delays.slice().buffer,
      L: state.bank.L,
      totalLen: total,
    }, [samplesCopy.buffer]);
  };

  for (let i = 0; i < poolSize; i++) {
    const w = new Worker('worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      const task = w._task;
      if (m.type === 'progress') {
        if (task) { progress.set(task.key, m.done); updateProgress(); }
      } else if (m.type === 'done') {
        const r = results.get(m.srcId) || {};
        r[m.ear] = new Float64Array(m.buffer);
        results.set(m.srcId, r);
        if (task) progress.set(task.key, state.sources[task.srcId].samples.length);
        finished++;
        updateProgress();
        assign(w); // 领取下一个任务
        finishIfDone();
      } else if (m.type === 'error') {
        cancelRender();
        showMsg('渲染出错：' + m.message, 6000);
      }
    };
    w.onerror = (e) => {
      cancelRender();
      showMsg('渲染 Worker 出错：' + (e.message || '未知错误'), 6000);
    };
    state.workers.push(w);
    assign(w);
  }
}

function cancelRender() {
  if (!state.rendering) return;
  state.workers.forEach((w) => w.terminate());
  state.workers = [];
  state.rendering = false;
  $('#btn-render').disabled = false;
  $('#btn-cancel').disabled = true;
  $('#render-status').textContent = '已取消，保留上次结果';
  refreshUI();
}

/* ---------------- 混音 / 量化 / 播放 ---------------- */

function mixFloat() {
  if (state.mixCache) return state.mixCache;
  const total = totalLen();
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  for (const s of state.sources) {
    if (!s.rendered) continue;
    for (let i = 0; i < total; i++) { left[i] += s.rendered.left[i]; right[i] += s.rendered.right[i]; }
  }
  state.mixCache = { left, right };
  return state.mixCache;
}

/** 当前播放对象的量化立体声（整轨）。 */
function quantizedTarget() {
  const key = state.playTarget + ':v' + state.renderVersion;
  if (state.quantCache && state.quantCache.key === key) return state.quantCache;
  let fl, fr;
  if (state.playTarget === 'mix') {
    const m = mixFloat(); fl = m.left; fr = m.right;
  } else {
    const s = state.sources[+state.playTarget];
    if (!s || !s.rendered) return null;
    fl = s.rendered.left; fr = s.rendered.right;
  }
  const qc = { key, ql: RC.quantize(fl), qr: RC.quantize(fr) };
  state.quantCache = qc;
  return qc;
}

function ensureCtx() {
  if (!state.audio.ctx) {
    state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RC.SAMPLE_RATE });
  }
  if (state.audio.ctx.state === 'suspended') state.audio.ctx.resume();
  return state.audio.ctx;
}

function stopPlayback() {
  if (state.audio.src) {
    try { state.audio.src.stop(); } catch (_) { /* 已停止 */ }
    state.audio.src = null;
  }
}

function playRange(start, end) {
  const qc = quantizedTarget();
  if (!qc) { showMsg('请先完成渲染'); return; }
  const total = qc.ql.length;
  start = Math.max(0, Math.min(start, total));
  end = Math.max(start, Math.min(end, total));
  if (end === start) { showMsg('选区为空'); return; }
  stopPlayback();
  const ctx = ensureCtx();
  const len = end - start;
  const buf = ctx.createBuffer(2, len, RC.SAMPLE_RATE);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  for (let i = 0; i < len; i++) { l[i] = qc.ql[start + i] / 32768; r[i] = qc.qr[start + i] / 32768; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  state.audio.src = src;
}

/* ---------------- 发声帧查看 ---------------- */

function updateInspector() {
  const out = $('#inspect-out');
  const idx = +($('#inspect-src').value || -1);
  const s = state.sources[idx];
  if (!s || !state.bank) { out.textContent = '请先加载方位库与声源。'; return; }
  const N = s.samples.length;
  let n = Math.floor(+$('#inspect-frame').value || 0);
  n = Math.max(0, Math.min(N - 1, n));
  const b = state.bank;
  const L = RC.frameAzimuth(s.trackFrames, s.trackAngs, b.angles, b.leftDelay, n);
  const R = RC.frameAzimuth(s.trackFrames, s.trackAngs, b.angles, b.rightDelay, n);
  const desc = (z, ear) => {
    const intd = Math.floor(z.delay);
    const frac = z.delay - intd;
    const nb = z.iA === z.iB
      ? `方向 ${z.iA}（${fmtDeg(b.angles[z.iA])}）精确命中，权重 1`
      : `方向 ${z.iA}（${fmtDeg(b.angles[z.iA])}）权重 ${(1 - z.w).toFixed(6)} + 方向 ${z.iB}（${fmtDeg(b.angles[z.iB])}）权重 ${z.w.toFixed(6)}`;
    return `${ear}：${nb}\n   延时 ${z.delay.toFixed(4)} 采样 = 整数 ${intd} + 小数 ${frac.toFixed(4)}（${(z.delay * 256).toFixed(2)}/256）`;
  };
  out.textContent =
    `发声帧 ${n} / ${N - 1}（码值 ${s.samples[n]}）\n` +
    `轨迹角度（含圈数）：${L.raw.toFixed(2)} → 取模 ${L.mod.toFixed(2)}（${fmtDeg(L.mod)}）\n` +
    desc(L, '左耳') + '\n' + desc(R, '右耳');
}

/* ---------------- 波形与选区 ---------------- */

function drawWave() {
  const cv = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 120;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.body);
  g.clearRect(0, 0, W, H);
  const qc = quantizedTarget();
  const total = totalLen();
  if (!qc || total === 0) {
    g.fillStyle = css.getPropertyValue('--muted');
    g.font = '12px sans-serif';
    g.fillText('（渲染后显示波形）', 12, H / 2);
    return;
  }
  // 选区底色
  const x0 = (state.sel.start / total) * W, x1 = (state.sel.end / total) * W;
  g.fillStyle = 'rgba(100,150,255,0.18)';
  g.fillRect(x0, 0, x1 - x0, H);
  // 波形（min/max 抽样）
  g.strokeStyle = css.getPropertyValue('--accent');
  g.beginPath();
  const mid = H / 2;
  for (let px = 0; px < W; px++) {
    const i0 = Math.floor((px / W) * total);
    const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / W) * total));
    let mn = 32767, mx = -32768;
    for (let i = i0; i < i1; i++) {
      const v = Math.max(Math.abs(qc.ql[i]), Math.abs(qc.qr[i]));
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const y0 = mid - (mx / 32768) * (mid - 2);
    const y1 = mid - (mn / 32768) * (mid - 2);
    g.moveTo(px + 0.5, y0);
    g.lineTo(px + 0.5, Math.max(y1, y0 + 0.5));
  }
  g.stroke();
}

function syncSelectionUI() {
  const total = totalLen();
  state.sel.start = Math.max(0, Math.min(state.sel.start, total));
  state.sel.end = Math.max(state.sel.start, Math.min(state.sel.end, total));
  $('#sel-start').value = state.sel.start;
  $('#sel-end').value = state.sel.end;
  $('#sel-start').max = total;
  $('#sel-end').max = total;
  $('#sel-info').textContent = `共 ${state.sel.end - state.sel.start} 帧 / 总长 ${total} 帧`;
}

/* ---------------- 轨迹编辑器 ---------------- */

function openTrackEditor(idx) {
  const s = state.sources[idx];
  state.te = { idx, sel: 0, drag: -1 };
  $('#te-name').textContent = s.name;
  $('#track-editor').hidden = false;
  drawTrackEditor();
}

function teCanvasGeom() {
  const s = state.sources[state.te.idx];
  const cv = $('#te-canvas');
  const W = cv.clientWidth, H = 260;
  const N = s.samples.length;
  let mn = Infinity, mx = -Infinity;
  for (const a of s.trackAngs) { if (a < mn) mn = a; if (a > mx) mx = a; }
  if (mn === mx) { mn -= 18000; mx += 18000; }
  const pad = (mx - mn) * 0.08;
  mn -= pad; mx += pad;
  const x2f = (x) => (x / W) * (N - 1);
  const f2x = (f) => (f / (N - 1)) * W;
  const y2a = (y) => mx - (y / H) * (mx - mn);
  const a2y = (a) => ((mx - a) / (mx - mn)) * H;
  return { W, H, N, mn, mx, x2f, f2x, y2a, a2y };
}

function drawTrackEditor() {
  const s = state.sources[state.te.idx];
  const cv = $('#te-canvas');
  const gm = teCanvasGeom();
  const dpr = window.devicePixelRatio || 1;
  cv.width = gm.W * dpr; cv.height = gm.H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.body);
  g.clearRect(0, 0, gm.W, gm.H);
  // 0° 参考线
  g.strokeStyle = css.getPropertyValue('--line');
  g.beginPath();
  g.moveTo(0, gm.a2y(0)); g.lineTo(gm.W, gm.a2y(0));
  g.stroke();
  // 折线
  g.strokeStyle = css.getPropertyValue('--accent');
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i < s.trackFrames.length; i++) {
    const x = gm.f2x(s.trackFrames[i]), y = gm.a2y(s.trackAngs[i]);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  // 点
  for (let i = 0; i < s.trackFrames.length; i++) {
    const x = gm.f2x(s.trackFrames[i]), y = gm.a2y(s.trackAngs[i]);
    g.beginPath();
    g.arc(x, y, i === state.te.sel ? 6 : 4, 0, Math.PI * 2);
    g.fillStyle = i === state.te.sel ? css.getPropertyValue('--danger') : css.getPropertyValue('--accent');
    g.fill();
  }
  g.lineWidth = 1;
  // 信息
  const i = state.te.sel;
  $('#te-frame').value = s.trackFrames[i];
  $('#te-angle').value = s.trackAngs[i];
  $('#te-frame').disabled = (i === 0 || i === s.trackFrames.length - 1);
  $('#te-info').textContent = `点 ${i + 1}/${s.trackFrames.length} · ${fmtDeg(s.trackAngs[i])}`;
  $('#te-error').textContent = '';
}

function teCommitEdit() {
  const s = state.sources[state.te.idx];
  const i = state.te.sel;
  const f = Math.round(+$('#te-frame').value);
  const a = Math.round(+$('#te-angle').value);
  const frames = Array.from(s.trackFrames);
  const angs = Array.from(s.trackAngs);
  frames[i] = f; angs[i] = a;
  try {
    const t = RC.normalizeTrack(frames.map((v, k) => [v, angs[k]]), s.samples.length);
    s.trackFrames = t.frames; s.trackAngs = t.angs;
    markDirtyAndRender(state.te.idx);
  } catch (err) {
    $('#te-error').textContent = err.message;
  }
  drawTrackEditor();
}

function markDirtyAndRender(idx) {
  const s = state.sources[idx];
  s.dirty = true;
  state.mixCache = null; state.quantCache = null;
  state.renderVersion++;
  refreshUI();
  startRender([idx]); // 只重算该声源，其他声源结果不变
}

/* ---------------- UI 刷新 ---------------- */

function refreshUI() {
  // 方位库
  if (state.bank) {
    $('#bank-info').textContent =
      `${state.bank.D} 个方位 · 每耳 ${state.bank.L} 抽头`;
    $('#bank-angles').textContent =
      '角度：' + Array.from(state.bank.angles, fmtDeg).join('  ');
  } else {
    $('#bank-info').textContent = '未加载';
    $('#bank-angles').textContent = '';
  }
  // 声源列表
  const list = $('#source-list');
  list.innerHTML = '';
  state.sources.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'src-card';
    const dur = (s.samples.length / RC.SAMPLE_RATE).toFixed(2);
    const badge = s.dirty
      ? '<span class="badge stale">待渲染</span>'
      : '<span class="badge">已渲染</span>';
    div.innerHTML = `<span class="title">${i + 1}. ${s.name}</span>${badge}
      <div class="small hint">${s.samples.length} 帧（${dur} s）· 轨迹 ${s.trackFrames.length} 点</div>`;
    const row = document.createElement('div');
    row.className = 'row wrap';
    const mkBtn = (text, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = fn;
      row.appendChild(b);
    };
    mkBtn('独听', () => { state.playTarget = String(i); refreshPlayTarget(); playRange(0, totalLen()); }, 'secondary');
    mkBtn('编辑轨迹', () => openTrackEditor(i), 'secondary');
    mkBtn('重渲染', () => { s.dirty = true; markDirtyAndRender(i); }, 'secondary');
    mkBtn('删除', () => {
      state.sources.splice(i, 1);
      state.mixCache = null; state.quantCache = null;
      state.renderVersion++;
      fitRendered();
      refreshUI();
    }, 'secondary');
    div.appendChild(row);
    list.appendChild(div);
  });
  // 查看器选项
  const sel = $('#inspect-src');
  const prev = sel.value;
  sel.innerHTML = '';
  state.sources.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${i + 1}. ${s.name}`;
    sel.appendChild(o);
  });
  if (prev && +prev < state.sources.length) sel.value = prev;
  // 播放对象
  refreshPlayTarget();
  syncSelectionUI();
  updateInspector();
  drawWave();
}

function refreshPlayTarget() {
  const sel = $('#play-target');
  sel.innerHTML = '';
  const om = document.createElement('option');
  om.value = 'mix'; om.textContent = '合听（全部声源）';
  sel.appendChild(om);
  state.sources.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = `独听 ${i + 1}. ${s.name}`;
    sel.appendChild(o);
  });
  sel.value = state.playTarget;
  if (sel.value !== state.playTarget) { state.playTarget = 'mix'; sel.value = 'mix'; }
}

/* ---------------- 事件绑定 ---------------- */

function bind(id, ev, fn) { $(id).addEventListener(ev, fn); }

bind('#btn-load-sample', 'click', async () => {
  try {
    const resp = await fetch('samples/hrir-delay-cases.zip');
    if (!resp.ok) throw new Error('找不到 samples/hrir-delay-cases.zip（请从仓库根目录启动静态服务）');
    await importZip(await resp.blob());
    refreshUI();
    startRender(dirtySourceIds());
  } catch (err) { showMsg('载入示例失败：' + err.message, 6000); }
});

bind('#file-zip', 'change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await importZip(f); refreshUI(); startRender(dirtySourceIds()); }
  catch (err) { showMsg('导入 ZIP 失败：' + err.message, 6000); }
});

bind('#file-json', 'change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { importProjectJson(JSON.parse(await f.text())); refreshUI(); startRender(dirtySourceIds()); }
  catch (err) { showMsg('导入工程 JSON 失败：' + err.message, 6000); }
});

bind('#file-wavs', 'change', async (e) => {
  const files = Array.from(e.target.files); e.target.value = '';
  for (const f of files) {
    try { state.wavPool.set(f.name, await decodeWavFile(f)); }
    catch (err) { showMsg(`${f.name}：${err.message}`, 6000); }
  }
  showMsg(`已加入 ${files.length} 个 WAV 到文件池`);
});

bind('#file-bank', 'change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    state.bank = RC.normalizeBank(raw.bank || raw);
    state.bankRaw = raw.bank || raw;
    for (const s of state.sources) { s.rendered = null; s.dirty = true; }
    state.mixCache = null; state.quantCache = null;
    state.renderVersion++;
    refreshUI();
  } catch (err) { showMsg('方位库无效：' + err.message, 6000); }
});

bind('#file-add-src', 'change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const samples = await decodeWavFile(f);
    const t = defaultTrack(samples.length);
    addSource(f.name, samples, t.frames, t.angs);
    state.wavPool.set(f.name, samples);
    refreshUI();
    startRender(dirtySourceIds());
  } catch (err) { showMsg('添加声源失败：' + err.message, 6000); }
});

bind('#btn-export-project', 'click', exportProjectJson);
bind('#btn-clear', 'click', () => {
  cancelRender();
  stopPlayback();
  state.sources = [];
  state.bank = null; state.bankRaw = null;
  state.mixCache = null; state.quantCache = null;
  state.renderVersion++;
  state.sel = { start: 0, end: 0 };
  refreshUI();
  showMsg('已清空工程');
});
bind('#btn-render', 'click', () => startRender(dirtySourceIds()));
bind('#btn-cancel', 'click', cancelRender);

bind('#inspect-src', 'change', updateInspector);
bind('#inspect-frame', 'input', updateInspector);

bind('#play-target', 'change', (e) => { state.playTarget = e.target.value; state.quantCache = null; drawWave(); });
bind('#btn-play', 'click', () => playRange(0, totalLen()));
bind('#btn-play-sel', 'click', () => playRange(state.sel.start, state.sel.end));
bind('#btn-stop', 'click', stopPlayback);

bind('#sel-start', 'input', () => { state.sel.start = Math.max(0, Math.floor(+$('#sel-start').value || 0)); if (state.sel.end < state.sel.start) state.sel.end = state.sel.start; syncSelectionUI(); drawWave(); });
bind('#sel-end', 'input', () => { state.sel.end = Math.max(0, Math.floor(+$('#sel-end').value || 0)); if (state.sel.end < state.sel.start) state.sel.start = state.sel.end; syncSelectionUI(); drawWave(); });

bind('#btn-export-wav', 'click', () => {
  const qc = quantizedTarget();
  if (!qc) { showMsg('请先完成渲染'); return; }
  const { start, end } = state.sel;
  if (end <= start) { showMsg('选区为空'); return; }
  const wav = RC.encodeWavStereoPcm16(qc.ql.subarray(start, end), qc.qr.subarray(start, end), RC.SAMPLE_RATE);
  const name = state.playTarget === 'mix' ? 'mix' : `solo${+state.playTarget + 1}`;
  downloadBlob(new Blob([wav], { type: 'audio/wav' }), `${name}_${start}-${end}.wav`);
});

// 波形选区拖动
(() => {
  const cv = $('#wave');
  let anchor = -1;
  const frameAt = (e) => {
    const r = cv.getBoundingClientRect();
    const total = totalLen();
    return Math.max(0, Math.min(total, Math.round(((e.clientX - r.left) / r.width) * total)));
  };
  cv.addEventListener('pointerdown', (e) => {
    anchor = frameAt(e);
    state.sel.start = anchor; state.sel.end = anchor;
    cv.setPointerCapture(e.pointerId);
    syncSelectionUI(); drawWave();
  });
  cv.addEventListener('pointermove', (e) => {
    if (anchor < 0) return;
    const f = frameAt(e);
    state.sel.start = Math.min(anchor, f);
    state.sel.end = Math.max(anchor, f);
    syncSelectionUI(); drawWave();
  });
  cv.addEventListener('pointerup', () => { anchor = -1; });
})();

// 轨迹编辑器事件
(() => {
  const cv = $('#te-canvas');
  const pickPoint = (e) => {
    const s = state.sources[state.te.idx];
    const gm = teCanvasGeom();
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best = -1, bd = 1e9;
    for (let i = 0; i < s.trackFrames.length; i++) {
      const dx = gm.f2x(s.trackFrames[i]) - px;
      const dy = gm.a2y(s.trackAngs[i]) - py;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return bd < 24 * 24 ? best : -1;
  };
  cv.addEventListener('pointerdown', (e) => {
    const i = pickPoint(e);
    if (i >= 0) {
      state.te.sel = i; state.te.drag = i;
      cv.setPointerCapture(e.pointerId);
      drawTrackEditor();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (state.te.drag < 0) return;
    const s = state.sources[state.te.idx];
    const i = state.te.drag;
    const gm = teCanvasGeom();
    const r = cv.getBoundingClientRect();
    const a = Math.round(gm.y2a(e.clientY - r.top));
    s.trackAngs[i] = Math.max(-2147483648, Math.min(2147483647, a));
    if (i > 0 && i < s.trackFrames.length - 1) {
      let f = Math.round(gm.x2f(e.clientX - r.left));
      f = Math.max(s.trackFrames[i - 1] + 1, Math.min(s.trackFrames[i + 1] - 1, f));
      s.trackFrames[i] = f;
    }
    drawTrackEditor();
  });
  cv.addEventListener('pointerup', () => {
    if (state.te.drag >= 0) {
      state.te.drag = -1;
      markDirtyAndRender(state.te.idx);
    }
  });
  cv.addEventListener('dblclick', (e) => {
    const s = state.sources[state.te.idx];
    if (s.trackFrames.length >= RC.MAX_TRACK_POINTS) { $('#te-error').textContent = '轨迹点已达上限'; return; }
    const gm = teCanvasGeom();
    const r = cv.getBoundingClientRect();
    const f = Math.round(gm.x2f(e.clientX - r.left));
    const a = Math.round(gm.y2a(e.clientY - r.top));
    const frames = Array.from(s.trackFrames), angs = Array.from(s.trackAngs);
    let pos = frames.findIndex((v) => v > f);
    if (pos < 0) pos = frames.length;
    frames.splice(pos, 0, f); angs.splice(pos, 0, a);
    try {
      const t = RC.normalizeTrack(frames.map((v, k) => [v, angs[k]]), s.samples.length);
      s.trackFrames = t.frames; s.trackAngs = t.angs;
      state.te.sel = pos;
      markDirtyAndRender(state.te.idx);
      drawTrackEditor();
    } catch (err) { $('#te-error').textContent = err.message; }
  });
  bind('#te-apply', 'click', teCommitEdit);
  bind('#te-delete', 'click', () => {
    const s = state.sources[state.te.idx];
    const i = state.te.sel;
    if (i === 0 || i === s.trackFrames.length - 1) { $('#te-error').textContent = '首末点不可删除'; return; }
    const frames = Array.from(s.trackFrames), angs = Array.from(s.trackAngs);
    frames.splice(i, 1); angs.splice(i, 1);
    const t = RC.normalizeTrack(frames.map((v, k) => [v, angs[k]]), s.samples.length);
    s.trackFrames = t.frames; s.trackAngs = t.angs;
    state.te.sel = Math.max(0, i - 1);
    markDirtyAndRender(state.te.idx);
    drawTrackEditor();
  });
  bind('#te-close', 'click', () => { $('#track-editor').hidden = true; state.te = null; });
})();

window.addEventListener('resize', () => { drawWave(); if (state.te) drawTrackEditor(); });

refreshUI();
