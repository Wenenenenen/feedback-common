// 主线程控制器：Worker 池调度、只提交最新帧、错误保留上一帧、
// 相机轨道控制、像素检查与 PNG 导出。不做任何光栅化计算。
import { mergeBands, inspectPixel, validateScene, ValidationError } from './renderer.js';
import { encodePng } from './png.js';

const MAX_WORKERS = 4;
const SIZES = [64, 128, 192, 256, 320, 384, 512, 640, 768, 896, 1024];

const els = {
  canvas: document.getElementById('view'),
  sample: document.getElementById('sample-select'),
  file: document.getElementById('file-input'),
  size: document.getElementById('size-select'),
  sizeVal: document.getElementById('size-val'),
  reset: document.getElementById('cam-reset'),
  status: document.getElementById('status'),
  err: document.getElementById('error'),
  exportBtn: document.getElementById('export-png'),
  coord: document.getElementById('hover-coord'),
  marker: document.getElementById('marker'),
  inspect: document.getElementById('inspect-panel'),
  camInfo: document.getElementById('cam-info'),
  progress: document.getElementById('progress'),
};

const ctx = els.canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ---------------------------------------------------------------------------
// Worker 池
// ---------------------------------------------------------------------------
const nWorkers = Math.min(MAX_WORKERS, Math.max(1, navigator.hardwareConcurrency || 1));
const workers = [];
for (let i = 0; i < nWorkers; i++) {
  const wk = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
  workers.push({ wk, busy: false });
}

// ---------------------------------------------------------------------------
// 应用状态
// ---------------------------------------------------------------------------
const state = {
  scene: null,              // 已校验的场景
  frame: null,              // 最近一次成功帧（错误输入时保留）
  size: 512,
  camera: null,             // 当前相机参数
  baseCamera: null,         // 场景自带相机（reset 用）
  orbit: null,              // 轨道参数 {az, el, r}
  seq: 0,                   // 帧序号：旧序号的响应一律丢弃
  job: null,                // 进行中的作业
  pending: null,            // 进行中又来新请求时，只保留最新参数
  selectedPixel: null,
};

// ---------------------------------------------------------------------------
// 相机轨道控制
// ---------------------------------------------------------------------------
function orbitFromCamera(cam) {
  const f = sub3(cam.target, cam.position);
  const r = len3(f);
  const fwd = scale3(f, 1 / r);
  const up = norm3(cam.up);
  const az = Math.atan2(fwd[0], fwd[2]);
  const el = Math.asin(Math.max(-1, Math.min(1, dot3(fwd, up))));
  return { az, el, r };
}
function cameraFromOrbit() {
  const { az, el, r } = state.orbit;
  const target = state.camera.target;
  const up = norm3(state.baseCamera.up);
  const ce = Math.cos(el);
  const dir = [ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)];
  // 以场景 up 为极轴；绕 up 的方位 + 俯仰重建位置
  const right = norm3(cross3(dir, up));
  const camUp = cross3(right, dir);
  return {
    position: sub3(target, scale3(dir, r)),
    target,
    up: camUp,
    fov_y_degrees: state.camera.fov_y_degrees,
    near: state.camera.near,
    far: state.camera.far,
  };
}

function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len3(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm3(a) { const n = len3(a) || 1; return scale3(a, 1 / n); }

// ---------------------------------------------------------------------------
// 调度：只提交最新一帧
// ---------------------------------------------------------------------------
function requestRender(reason = '') {
  if (!state.scene) return;
  const params = {
    scene: state.scene, size: state.size,
    camera: state.camera, reason,
  };
  if (state.job) { state.pending = params; return; }
  startJob(params);
}

function startJob(params) {
  const seq = ++state.seq;
  const { scene, size, camera } = params;
  // 按行均分分带，每带至少 1 行
  const bands = [];
  const bandRows = Math.ceil(size / nWorkers);
  for (let i = 0; i < nWorkers; i++) {
    const y0 = Math.min(size, i * bandRows);
    const y1 = Math.min(size, (i + 1) * bandRows);
    if (y0 < y1) bands.push({ y0, y1 });
  }
  const collected = new Array(bands.length);
  let finished = 0;
  let failed = false;
  state.job = { seq, bands, collected, finished, failed, params, t0: performance.now() };
  els.progress.textContent = `渲染中… 0/${bands.length} 分带（${nWorkers} Worker）`;

  bands.forEach((bd, idx) => {
    const slot = workers[idx % workers.length];
    slot.busy = true;
    slot.wk.postMessage({
      seq, scene, size, camera, y0: bd.y0, y1: bd.y1,
    });
  });
}

workers.forEach((slot) => {
  slot.wk.onmessage = (ev) => {
    const { seq, ok } = ev.data;
    slot.busy = false;
    const job = state.job;
    if (!job || seq !== job.seq) return;          // 旧帧响应，丢弃
    if (job.failed) return;
    if (!ok) {
      job.failed = true;
      state.job = null;
      showError(`输入无效，已保留上一帧：${ev.data.error}`);
      els.progress.textContent = '';
      drainPending();
      return;
    }
    const idx = job.bands.findIndex((b) => b.y0 === ev.data.band.y0);
    job.collected[idx] = ev.data.band;
    job.finished++;
    els.progress.textContent = `渲染中… ${job.finished}/${job.bands.length} 分带`;
    if (job.finished === job.bands.length) {
      const ms = performance.now() - job.t0;
      const frame = mergeBands(job.collected, job.params.size, state.scene.background_linear_rgb);
      state.frame = frame;                          // 仅成功帧提交
      state.job = null;
      clearError();
      els.progress.textContent = '';
      presentFrame(frame);
      let fragCount = 0;
      for (let i = 0; i < frame.fragStart.length - 1; i++)
        fragCount += frame.fragStart[i + 1] - frame.fragStart[i];
      els.status.textContent =
        `${job.params.size}×${job.params.size} · ${ms.toFixed(0)} ms · ${nWorkers} Worker · ${fragCount} 片元`;
      // 尺寸变化后旧选中像素可能越界，校验后再检查，否则清除
      if (state.selectedPixel) {
        const { x, y } = state.selectedPixel;
        if (x < frame.size && y < frame.size) {
          updateInspect(x, y);
        } else {
          state.selectedPixel = null;
          els.marker.style.display = 'none';
          els.inspect.innerHTML = '<h3>点击图像中的像素查看逐片元信息</h3>';
        }
      }
      drainPending();
    }
  };
});

function drainPending() {
  if (state.pending) {
    const p = state.pending;
    state.pending = null;
    startJob(p);
  }
}

function showError(msg) {
  els.err.textContent = msg;
  els.err.classList.add('show');
}
function clearError() {
  els.err.textContent = '';
  els.err.classList.remove('show');
}

// ---------------------------------------------------------------------------
// 显示：Canvas 2D 仅负责把已算好的像素贴上
// ---------------------------------------------------------------------------
function presentFrame(frame) {
  const { size } = frame;
  const off = new ImageData(new Uint8ClampedArray(size * size * 4), size, size);
  for (let i = 0, j = 0; i < frame.rgb8.length; i += 3, j += 4) {
    off.data[j] = frame.rgb8[i];
    off.data[j + 1] = frame.rgb8[i + 1];
    off.data[j + 2] = frame.rgb8[i + 2];
    off.data[j + 3] = 255;
  }
  const offCanvas = document.createElement('canvas');
  offCanvas.width = size; offCanvas.height = size;
  offCanvas.getContext('2d').putImageData(off, 0, 0);
  els.canvas.width = size; els.canvas.height = size;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(offCanvas, 0, 0);
}

// ---------------------------------------------------------------------------
// 像素检查
// ---------------------------------------------------------------------------
function canvasToPixel(ev) {
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * els.canvas.width);
  const y = Math.floor((ev.clientY - rect.top) / rect.height * els.canvas.height);
  return { x, y };
}

els.canvas.addEventListener('click', (ev) => {
  if (!state.frame) return;
  const { x, y } = canvasToPixel(ev);
  if (x < 0 || y < 0 || x >= state.frame.size || y >= state.frame.size) return;
  state.selectedPixel = { x, y };
  updateInspect(x, y);
});

els.canvas.addEventListener('mousemove', (ev) => {
  if (!state.frame) { els.coord.textContent = ''; return; }
  const { x, y } = canvasToPixel(ev);
  els.coord.textContent = `像素 (${x}, ${y})`;
});

function fmt(v, d = 6) { return Number(v).toFixed(d); }

function updateInspect(x, y) {
  const info = inspectPixel(state.frame, x, y);
  // 标记
  const rect = els.canvas.getBoundingClientRect();
  const scale = rect.width / state.frame.size;
  els.marker.style.display = 'block';
  els.marker.style.left = `${rect.left - els.canvas.parentElement.getBoundingClientRect().left + x * scale}px`;
  els.marker.style.top = `${rect.top - els.canvas.parentElement.getBoundingClientRect().top + y * scale}px`;
  els.marker.style.width = `${Math.max(2, scale)}px`;
  els.marker.style.height = `${Math.max(2, scale)}px`;

  const rows = info.hits.map((h, k) => `
    <tr>
      <td>${k + 1}</td><td>${h.id}</td><td>${fmt(h.depth)}</td>
      <td>${h.rgba.map((v) => fmt(v, 4)).join(', ')}</td>
      <td>${h.composite_linear_rgb.map((v) => fmt(v, 4)).join(', ')}</td>
    </tr>`).join('');
  els.inspect.innerHTML = `
    <h3>像素 (${x}, ${y}) — 由近到远 ${info.hits.length} 个非零 alpha 片元</h3>
    <table>
      <thead><tr><th>#</th><th>id</th><th>相机深度</th><th>RGBA（线性，非预乘）</th><th>该层合成值（线性RGB）</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">无覆盖片元（仅背景）</td></tr>'}</tbody>
    </table>
    <p class="final">最终线性 RGB：[${info.linear_rgb.map((v) => fmt(v, 6)).join(', ')}]
       &nbsp;|&nbsp; sRGB 8-bit：[${info.png_rgb8.join(', ')}]</p>
    <p class="note">不透明面之后的片元仍完整保留；alpha=0 的片元按规范不列入。</p>`;
}

// ---------------------------------------------------------------------------
// 相机交互：拖拽轨道、滚轮推拉
// ---------------------------------------------------------------------------
let dragging = false;
let last = null;
els.canvas.addEventListener('pointerdown', (ev) => {
  if (!state.scene) return;
  dragging = true; last = { x: ev.clientX, y: ev.clientY };
  els.canvas.setPointerCapture(ev.pointerId);
});
els.canvas.addEventListener('pointermove', (ev) => {
  if (!dragging) return;
  const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
  last = { x: ev.clientX, y: ev.clientY };
  const o = state.orbit;
  o.az -= dx * 0.005;
  o.el = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, o.el + dy * 0.005));
  applyCamera();
});
els.canvas.addEventListener('pointerup', () => { dragging = false; });
els.canvas.addEventListener('wheel', (ev) => {
  if (!state.scene) return;
  ev.preventDefault();
  const o = state.orbit;
  o.r *= Math.exp(ev.deltaY * 0.001);
  applyCamera();
}, { passive: false });

function applyCamera() {
  state.camera = cameraFromOrbit();
  renderCamInfo();
  requestRender('camera');
}
function renderCamInfo() {
  const c = state.camera;
  els.camInfo.textContent =
    `position [${c.position.map((v) => fmt(v, 3)).join(', ')}]  target [${c.target.map((v) => fmt(v, 3)).join(', ')}]  fov ${c.fov_y_degrees}°  near ${c.near} far ${c.far}`;
}
els.reset.addEventListener('click', () => {
  if (!state.baseCamera) return;
  state.camera = structuredClone(state.baseCamera);
  state.orbit = orbitFromCamera(state.camera);
  renderCamInfo();
  requestRender('reset');
});

// ---------------------------------------------------------------------------
// 尺寸选择
// ---------------------------------------------------------------------------
for (const s of SIZES) {
  const opt = document.createElement('option');
  opt.value = String(s); opt.textContent = `${s} × ${s}`;
  if (s === 512) opt.selected = true;
  els.size.appendChild(opt);
}
els.size.addEventListener('change', () => {
  state.size = Number(els.size.value);
  els.sizeVal.textContent = `${state.size}×${state.size}`;
  requestRender('size');
});

// ---------------------------------------------------------------------------
// 场景加载（样例 / 本地文件）
// ---------------------------------------------------------------------------
async function loadSceneObject(obj, label) {
  let valid;
  try {
    valid = validateScene(obj);   // 主线程先校验，失败直接保留上一帧
  } catch (e) {
    showError(`${label} 输入无效，已保留上一帧：${e.message}`);
    return;
  }
  state.scene = valid;
  state.baseCamera = structuredClone(valid.camera);
  state.camera = structuredClone(valid.camera);
  state.orbit = orbitFromCamera(state.camera);
  state.selectedPixel = null;
  els.marker.style.display = 'none';
  els.inspect.innerHTML = '<h3>点击图像中的像素查看逐片元信息</h3>';
  renderCamInfo();
  clearError();
  requestRender('load');
}

async function loadSamples() {
  const resp = await fetch('/api/samples');
  const names = await resp.json();
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    els.sample.appendChild(opt);
  }
}
els.sample.addEventListener('change', async () => {
  const name = els.sample.value;
  if (!name) return;
  const resp = await fetch(`/api/sample/${encodeURIComponent(name)}`);
  const obj = await resp.json();
  await loadSceneObject(obj, name);
});
els.file.addEventListener('change', async () => {
  const f = els.file.files[0];
  if (!f) return;
  let obj;
  try {
    obj = JSON.parse(await f.text());
  } catch (e) {
    showError(`${f.name} 不是合法 JSON，已保留上一帧：${e.message}`);
    return;
  }
  await loadSceneObject(obj, f.name);
});

// ---------------------------------------------------------------------------
// PNG 导出
// ---------------------------------------------------------------------------
els.exportBtn.addEventListener('click', () => {
  if (!state.frame) return;
  const png = encodePng(state.frame.rgb8, state.frame.size, state.frame.size);
  const blob = new Blob([png], { type: 'image/png' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `alpha-ref-${state.frame.size}.png`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// 初始化
loadSamples().catch((e) => showError('样例列表加载失败：' + e.message));
