'use strict';
// 页面主逻辑：导入/编辑掩膜、Worker 调度（取消 + 防旧结果覆盖）、逐轮展示、
// 点选定位供体、误差复核与导出。

import { decodePNG, encodePNG } from './png-codec.js';

const state = {
  width: 0,
  height: 0,
  originalImage: null, // Uint8Array RGB，永不修改
  mask: null, // Uint8Array，255=待修补
  dirty: false,
  taskToken: 0,
  lastResult: null,
  viewLevel: 0,
  viewIteration: 0,
  mode: 'paint', // paint | erase | inspect
  brush: 5,
  showMask: true,
  showOverlay: true,
  inspect: null, // {x,y}
  lastParams: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $('main-canvas');
const ctx = canvas.getContext('2d');

function setStatus(text, kind = 'info') {
  const el = $('status-line');
  el.textContent = text;
  el.dataset.kind = kind;
}

// ---------------- 导入 ----------------

async function decodeImageFile(file) {
  const buf = await file.arrayBuffer();
  const png = await decodePNG(buf);
  if (png.channels !== 3) {
    throw new Error('图像必须是 8 位 RGB PNG（颜色类型 2），当前通道数=' + png.channels);
  }
  if (png.width > 512 || png.height > 512) {
    throw new Error(`边长不得超过 512（当前 ${png.width}×${png.height}）`);
  }
  return png;
}

async function decodeMaskFile(file, width, height) {
  const png = await decodePNG(await file.arrayBuffer());
  if (png.width !== width || png.height !== height) {
    throw new Error(`掩膜尺寸 ${png.width}×${png.height} 与图像 ${width}×${height} 不一致`);
  }
  if (png.channels !== 1 && png.channels !== 2) {
    throw new Error('掩膜必须是灰度 PNG');
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const v = png.data[i * png.channels];
    out[i] = v >= 128 ? 255 : 0;
  }
  return out;
}

function countHoles() {
  let c = 0;
  for (const v of state.mask) if (v === 255) c++;
  return c;
}

async function handleImage(file) {
  try {
    const png = await decodeImageFile(file);
    state.width = png.width;
    state.height = png.height;
    state.originalImage = png.data;
    state.mask = new Uint8Array(png.width * png.height);
    state.dirty = false;
    state.lastResult = null;
    state.inspect = null;
    $('mask-file').value = '';
    updateMaskCount();
    setStatus(`已导入图像 ${png.width}×${png.height}。请导入同尺寸掩膜，或直接在图上绘制缺口。`);
    render();
  } catch (err) {
    setStatus('图像导入失败：' + err.message, 'error');
  }
}

async function handleMask(file) {
  if (!state.originalImage) {
    setStatus('请先导入 RGB 图像。', 'error');
    return;
  }
  try {
    state.mask = await decodeMaskFile(file, state.width, state.height);
    state.dirty = false;
    state.lastResult = null;
    state.inspect = null;
    updateMaskCount();
    setStatus(`已导入掩膜，待修补像素 ${countHoles()} 个。`);
    render();
  } catch (err) {
    setStatus('掩膜导入失败：' + err.message, 'error');
  }
}

function updateMaskCount() {
  $('mask-count').textContent = state.mask ? countHoles() : 0;
}

// ---------------- 画布渲染 ----------------

function currentViewImageData() {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') {
    // 未修补：原图 + 洞位显示黑底标记
    const out = new Uint8ClampedArray(state.width * state.height * 4);
    for (let i = 0; i < state.width * state.height; i++) {
      out[i * 4] = state.originalImage[i * 3];
      out[i * 4 + 1] = state.originalImage[i * 3 + 1];
      out[i * 4 + 2] = state.originalImage[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return new ImageData(out, state.width, state.height);
  }
  // 浏览某轮快照或最终结果
  let rgb = r.image;
  const report = r.levelReports.find((x) => x.level === state.viewLevel && !x.skipped);
  if (report && state.viewIteration > 0) {
    const snap = report.snapshots[state.viewIteration - 1];
    if (snap && snap.image) rgb = snap.image;
  }
  const out = new Uint8ClampedArray(state.width * state.height * 4);
  for (let i = 0; i < state.width * state.height; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, state.width, state.height);
}

function render() {
  if (!state.originalImage) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  canvas.width = state.width;
  canvas.height = state.height;
  const imgData = currentViewImageData();
  // 掩膜红色半透明叠加
  if (state.showMask && state.mask) {
    for (let i = 0; i < state.width * state.height; i++) {
      if (state.mask[i] === 255) {
        imgData.data[i * 4] = Math.round(imgData.data[i * 4] * 0.25 + 255 * 0.75);
        imgData.data[i * 4 + 1] = Math.round(imgData.data[i * 4 + 1] * 0.85);
        imgData.data[i * 4 + 2] = Math.round(imgData.data[i * 4 + 2] * 0.85);
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const r = state.lastResult;
  if (state.showOverlay && r && r.status === 'ok' && state.inspect) {
    drawInspection(r);
  }
}

function drawInspection(r) {
  const { x, y } = state.inspect;
  const idx = y * state.width + x;
  if (state.mask[idx] !== 255) return;
  const sx = r.finalNnf.nnfX[idx];
  const sy = r.finalNnf.nnfY[idx];
  const ps = r.params.patchSize;
  const rad = (ps - 1) / 2;
  // 目标 patch 框：蓝
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#2a78d6';
  ctx.strokeRect(Math.max(0, x - rad) + 0.5, Math.max(0, y - rad) + 0.5,
    Math.min(state.width, x + rad + 1) - Math.max(0, x - rad),
    Math.min(state.height, y + rad + 1) - Math.max(0, y - rad));
  // 供体 patch 框：橙
  ctx.strokeStyle = '#eb6834';
  ctx.strokeRect(sx - rad + 0.5, sy - rad + 0.5, ps, ps);
  // 中心点标记
  ctx.fillStyle = '#2a78d6';
  ctx.fillRect(x - 1, y - 1, 3, 3);
  ctx.fillStyle = '#eb6834';
  ctx.fillRect(sx - 1, sy - 1, 3, 3);
  // 连线
  ctx.strokeStyle = 'rgba(235,104,52,0.8)';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(sx, sy);
  ctx.stroke();
}

// ---------------- 画笔编辑 ----------------

function eventToPixel(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * state.width);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * state.height);
  return { x: Math.max(0, Math.min(state.width - 1, x)), y: Math.max(0, Math.min(state.height - 1, y)) };
}

function stamp(x, y, value) {
  const half = Math.floor(state.brush / 2);
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= state.width || yy >= state.height) continue;
      if (state.brush % 2 === 0 && dx === half && dy === half) continue;
      state.mask[yy * state.width + xx] = value;
    }
  }
}

let drawing = false;
canvas.addEventListener('pointerdown', (ev) => {
  if (!state.originalImage) return;
  if (state.mode === 'inspect') {
    const p = eventToPixel(ev);
    if (state.mask[p.y * state.width + p.x] === 255) {
      state.inspect = p;
      showInspectInfo(p);
    } else {
      state.inspect = null;
      setStatus('点选位置不在待修补区内；请点击红色掩膜像素。');
    }
    render();
    return;
  }
  drawing = true;
  canvas.setPointerCapture(ev.pointerId);
  const p = eventToPixel(ev);
  stamp(p.x, p.y, state.mode === 'paint' ? 255 : 0);
  state.dirty = true;
  state.lastResult = null;
  state.inspect = null;
  updateMaskCount();
  render();
});
canvas.addEventListener('pointermove', (ev) => {
  if (!drawing || state.mode === 'inspect') return;
  const p = eventToPixel(ev);
  stamp(p.x, p.y, state.mode === 'paint' ? 255 : 0);
  updateMaskCount();
  render();
});
canvas.addEventListener('pointerup', () => {
  if (drawing) {
    drawing = false;
    setStatus(`掩膜已编辑，待修补像素 ${countHoles()} 个。参数就绪后点击“开始修补”。`);
  }
});

function showInspectInfo(p) {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') return;
  const idx = p.y * state.width + p.x;
  const sx = r.finalNnf.nnfX[idx];
  const sy = r.finalNnf.nnfY[idx];
  const mse = r.verification.perPixelMse[idx];
  const donorPx = [state.originalImage[(sy * state.width + sx) * 3],
    state.originalImage[(sy * state.width + sx) * 3 + 1],
    state.originalImage[(sy * state.width + sx) * 3 + 2]];
  $('inspect-info').innerHTML =
    `目标 (${p.x}, ${p.y}) → 供体中心 (${sx}, ${sy})；` +
    `归一化 MSE=<b>${Number.isFinite(mse) ? mse.toExponential(3) : '—'}</b>；` +
    `供体中心 RGB=(${donorPx.join(',')})。蓝框=目标 patch，橙框=供体 patch。`;
}

// ---------------- Worker 调度 ----------------

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;}
// Worker 只绑定一次消息处理器，所有结果都与“当前任务令牌”比对，
// 确保被取消 / 被取代的旧任务结果绝不可能覆盖新结果。
function bindWorker() {
  const w = getWorker();
  w.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'canceled') {
      setRunningUI(false);
      setStatus('任务已取消，结果已丢弃。');
      return;
    }
    if (typeof msg.token !== 'number' || msg.token !== state.taskToken) return; // 旧任务消息，丢弃
    if (msg.type === 'progress') {
      handleProgress(msg.info);
    } else if (msg.type === 'done') {
      finishRun(msg.result, state.lastParams);
    } else if (msg.type === 'error') {
      setRunningUI(false);
      setStatus('修补失败：' + msg.message, 'error');
    }
  };
  return w;
}

function readParams() {
  const patchSize = parseInt($('param-patch').value, 10);
  const levels = parseInt($('param-levels').value, 10);
  const iterations = parseInt($('param-iters').value, 10);
  const seedRaw = $('param-seed').value.trim();
  const seed = /^-?\d+$/.test(seedRaw) ? parseInt(seedRaw, 10) : seedRaw;
  return { patchSize, levels, iterations, seed };
}

function setRunningUI(running) {
  $('btn-run').disabled = running;
  $('btn-cancel').disabled = !running;
  $('progress-bar').style.display = running ? 'block' : 'none';
  $('progress-bar').dataset.active = running ? '1' : '0';
}

$('btn-run').addEventListener('click', () => {
  if (!state.originalImage) return setStatus('请先导入图像。', 'error');
  const holes = countHoles();
  if (holes === 0) return setStatus('掩膜为空：没有待修补像素。', 'error');
  let params;
  try {
    params = readParams();
    if (params.patchSize < 3 || params.patchSize > 15 || params.patchSize % 2 === 0) throw new Error('patch 边长须为 3..15 的奇数');
    if (params.levels < 1 || params.levels > 4) throw new Error('层数须在 1..4');
    if (params.iterations < 1 || params.iterations > 30) throw new Error('每层迭代须在 1..30');
  } catch (err) {
    return setStatus('参数错误：' + err.message, 'error');
  }

  const token = ++state.taskToken;
  state.runStartedAt = Date.now();
  state.lastParams = params;
  state.lastResult = null;
  state.inspect = null;
  setRunningUI(true);
  $('progress-fill').style.width = '2%';
  $('progress-meta').textContent = '';
  for (const id of ['v-mean', 'v-max', 'v-illegal', 'v-count']) $(id).textContent = '—';
  $('iter-select').innerHTML = '<option>计算中……</option>';
  $('inspect-info').textContent = '';
  setStatus('修补任务已启动……');
  const w = bindWorker();
  w.postMessage({
    type: 'run',
    image: state.originalImage,
    mask: state.mask.slice(),
    width: state.width,
    height: state.height,
    params,
  });
});

$('btn-cancel').addEventListener('click', () => {
  state.taskToken++; // 使后续到达的旧结果全部失效，杜绝旧任务覆盖新结果
  getWorker().postMessage({ type: 'cancel' });
  setRunningUI(false);
  $('progress-bar').style.display = 'none';
  setStatus('正在取消……');
});

function handleProgress(info) {
  let pct;
  let text;
  if (info.phase === 'skipped-level') {
    pct = ((info.levels - info.level - 1) / info.levels) * 100;
    text = `第 ${info.levels - info.level} 层无合法供体，已跳过`;
  } else {
    // 各层等权；当前层内按迭代推进
    const layerBase = (info.levels - 1 - info.level) / info.levels;
    const layerSpan = 1 / info.levels;
    pct = (layerBase + layerSpan * (info.iteration / info.iterations)) * 100;
    text = `第 ${info.level + 1}/${info.levels} 层 · 第 ${info.iteration}/${info.iterations} 轮 · MSE=${info.meanMse.toExponential(3)}`;
  }
  $('progress-fill').style.width = Math.max(2, Math.min(99, pct)).toFixed(1) + '%';
  const elapsed = ((Date.now() - state.runStartedAt) / 1000).toFixed(1);
  $('progress-meta').textContent = `总进度 ${pct.toFixed(0)}% · 已用时 ${elapsed}s`;
  $('progress-text').textContent = text;
  setStatus(text);
}

function finishRun(result, params) {
  $('progress-fill').style.width = '100%';
  setRunningUI(false);
  $('progress-bar').style.display = 'none';
  if (result.status === 'no-donor') {
    setStatus('无法修补：' + result.message, 'error');
    state.lastResult = null;
    render();
    return;
  }
  if (result.status === 'canceled') {
    setStatus('任务已取消。');
    return;
  }
  // 已知像素逐字节核对（页面侧独立断言）
  const preserved = verifyKnownPreserved(result.image);
  if (!preserved) setStatus('警告：检测到已知像素被改动！', 'error');

  state.lastResult = { ...result, finalNnf: result.nnfArrays };
  state.viewLevel = 0;
  const fine = result.levelReports.find((x) => x.level === 0 && !x.skipped);
  state.viewIteration = fine ? fine.snapshots.length : 0;
  setStatus(
    `修补完成：掩膜内 ${countHoles()} 像素，最终平均归一化 MSE=${result.verification.meanMse.toExponential(3)}，` +
    `非法供体 ${result.verification.illegal} 个。已知像素逐字节保持：${preserved ? '是' : '否'}。`,
    preserved ? 'ok' : 'error',
  );
  buildIterationSelector();
  drawMseChart();
  $('v-mean').textContent = result.verification.meanMse.toExponential(4);
  $('v-max').textContent = result.verification.maxMse.toExponential(4);
  $('v-illegal').textContent = String(result.verification.illegal);
  $('v-count').textContent = String(result.verification.count);
  render();
}

function verifyKnownPreserved(outImage) {
  const n = state.width * state.height;
  for (let i = 0; i < n; i++) {
    if (state.mask[i] !== 255) {
      for (let c = 0; c < 3; c++) {
        if (state.originalImage[i * 3 + c] !== outImage[i * 3 + c]) return false;
      }
    }
  }
  return true;
}

// ---------------- 逐轮选择与误差曲线 ----------------

function buildIterationSelector() {
  const r = state.lastResult;
  const sel = $('iter-select');
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '0';
  opt.textContent = '最终修补结果';
  sel.appendChild(opt);
  const fine = r.levelReports.find((x) => x.level === 0 && !x.skipped);
  if (fine) {
    fine.snapshots.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i + 1);
      o.textContent = `细层第 ${s.iteration} 轮（MSE ${s.meanMse.toExponential(2)}）`;
      sel.appendChild(o);
    });
  }
  sel.value = '0';
  sel.onchange = () => {
    state.viewIteration = parseInt(sel.value, 10);
    render();
  };
}

function drawMseChart() {
  const r = state.lastResult;
  const fine = r.levelReports.find((x) => x.level === 0 && !x.skipped);
  const host = $('mse-chart');
  host.innerHTML = '';
  if (!fine) return;
  const data = fine.snapshots.map((s) => s.meanMse);
  const W = 460;
  const H = 210;
  const pad = { l: 72, r: 14, t: 16, b: 44 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxV = Math.max(...data, 1e-12);
  const minV = Math.min(...data);
  const logMax = Math.log10(maxV + 1e-12);
  const logMin = Math.log10(minV + 1e-12);
  const span = logMax - logMin || 1;
  const yOf = (v) => pad.t + ih - ((Math.log10(v + 1e-12) - logMin) / span) * ih;
  const xOf = (i) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="逐轮匹配误差曲线">`];
  // 网格与纵轴刻度（4 条）
  for (let g = 0; g <= 3; g++) {
    const y = pad.t + (g / 3) * ih;
    const val = Math.pow(10, logMax - (g / 3) * span);
    svg.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="currentColor" opacity="0.15"/>`);
    svg.push(`<text x="${pad.l - 8}" y="${(y + 3.5).toFixed(1)}" fill="currentColor" font-size="10" text-anchor="end">${val.toExponential(1)}</text>`);
  }
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  svg.push(`<path d="${path}" fill="none" stroke="#2a78d6" stroke-width="2"/>`);
  data.forEach((v, i) => {
    svg.push(`<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3" fill="#2a78d6" tabindex="0"><title>第 ${i + 1} 轮 MSE=${v.toExponential(3)}</title></circle>`);
  });
  // 横轴：首/中/末轮次
  const ticks = data.length <= 2 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1];
  for (const i of ticks) {
    svg.push(`<text x="${xOf(i).toFixed(1)}" y="${(pad.t + ih + 16).toFixed(1)}" fill="currentColor" font-size="10" text-anchor="middle">第${i + 1}轮</text>`);
  }
  svg.push(`<text x="${pad.l + iw / 2}" y="${H - 6}" fill="currentColor" font-size="11" text-anchor="middle">迭代轮次（纵轴为对数刻度：归一化 MSE）</text>`);
  svg.push('</svg>');
  host.innerHTML = svg.join('');
}

// ---------------- 导出 ----------------

function download(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btn-export-img').addEventListener('click', () => {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') return setStatus('尚无修补结果可导出。', 'error');
  download(encodePNG(state.width, state.height, 3, r.image), 'inpainted.png', 'image/png');
});
$('btn-export-nnf').addEventListener('click', () => {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') return setStatus('尚无修补结果可导出。', 'error');
  download(r.nnfBytes, 'nnf-int32le.bin', 'application/octet-stream');
});
$('btn-export-snap').addEventListener('click', () => {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') return setStatus('尚无修补结果可导出。', 'error');
  download(encodePNG(state.width, state.height, 3, r.targetSnapshot), 'target-snapshot.png', 'image/png');
});
$('btn-export-params').addEventListener('click', () => {
  const r = state.lastResult;
  if (!r || r.status !== 'ok') return setStatus('尚无修补结果可导出。', 'error');
  const payload = {
    width: state.width,
    height: state.height,
    parameters: r.params,
    voteWeight: 'w = round(1024 / (SSD / (3 * patchSize^2 * 255^2) + 1e-4))，裁剪到 [1, 1048576] 的整数权重，逐 patch 对重叠洞像素加权平均后四舍五入',
    errorDefinition: '每个目标 patch：RGB 归一化到[0,1]后的平方差，在目标有效（图内）偏移上取均值；源端始终取原始已知像素',
    verification: {
      meanMse: r.verification.meanMse,
      maxMse: r.verification.maxMse,
      illegalDonorPatches: r.verification.illegal,
      targetPixels: r.verification.count,
    },
    nnfFormat: '逐像素交错 int32 小端 (sx,sy)，每像素 8 字节；非掩膜位置为 (-1,-1)',
    prng: 'mulberry32，种子经 xmur3 混洗；同环境同种子同参数逐字节复现',
  };
  download(new TextEncoder().encode(JSON.stringify(payload, null, 2)), 'inpaint-params.json', 'application/json');
});

// ---------------- 控件绑定 ----------------

$('image-file').addEventListener('change', (e) => e.target.files[0] && handleImage(e.target.files[0]));
$('mask-file').addEventListener('change', (e) => e.target.files[0] && handleMask(e.target.files[0]));
$('mode-paint').addEventListener('change', () => { state.mode = 'paint'; canvas.style.cursor = 'crosshair'; });
$('mode-erase').addEventListener('change', () => { state.mode = 'erase'; canvas.style.cursor = 'crosshair'; });
$('mode-inspect').addEventListener('change', () => { state.mode = 'inspect'; canvas.style.cursor = 'help'; });
$('brush-size').addEventListener('input', (e) => {
  state.brush = parseInt(e.target.value, 10);
  $('brush-size-val').textContent = state.brush;
});
$('toggle-mask').addEventListener('change', (e) => { state.showMask = e.target.checked; render(); });
$('toggle-overlay').addEventListener('change', (e) => { state.showOverlay = e.target.checked; render(); });
$('btn-clear-mask').addEventListener('click', () => {
  if (!state.mask) return;
  state.mask.fill(0);
  state.dirty = true;
  state.lastResult = null;
  state.inspect = null;
  updateMaskCount();
  render();
  setStatus('掩膜已清空。');
});

// 暴露给手工调试
window.__inpaintState = state;
