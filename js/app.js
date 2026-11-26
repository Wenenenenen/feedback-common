/* app.js — 页面主控制：种子编辑、画布渲染、计算触发、点格查看、导入导出 */
'use strict';

const W = 2048, H = 2048, N = W * H;
// 32 个可区分标签色（标签 0 留空，深底）
const LABEL_COLORS = [
  null,
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0',
  '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8',
  '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#ffffff',
  '#a52a2a', '#7fffd4', '#ff7f50', '#6495ed', '#dc143c', '#00fa9a', '#ff8c00',
  '#4b0082', '#2f4f4f', '#daa520', '#1e90ff',
];

const $ = (id) => document.getElementById(id);
const state = {
  seed: new Uint8Array(N),
  tool: 'paint',
  label: 1,
  sx: 2, sy: 1,
  wrap: 1,
  radius: 6, margin: 3,
  view: 'seeds',
  top: null,        // 最近/最近异类完整结果
  fill: null,       // Uint8Array 输出标签
  zoom: 40,
};

const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const img = ctx.createImageData(W, H);
const imgData = img.data;

// ---------- 渲染 ----------
function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const COLOR_RGB = LABEL_COLOR.map(c => (c ? rgb(c) : null));

function clearBase() {
  const d = imgData;
  for (let p = 0; p < N; p++) {
    const o = p * 4;
    d[o] = 12; d[o + 1] = 15; d[o + 2] = 19; d[o + 3] = 255;
  }
}
function putPixel(p, lab) {
  const o = p * 4;
  if (lab === 0) { imgData[o] = 12; imgData[o + 1] = 15; imgData[o + 2] = 19; }
  else { const c = COLOR_RGB[lab]; imgData[o] = c[0]; imgData[o + 1] = c[1]; imgData[o + 2] = c[2]; }
  imgData[o + 3] = 255;
}
function renderSeeds() {
  clearBase();
  for (let p = 0; p < N; p++) if (state.seed[p]) putPixel(p, state.seed[p]);
  ctx.putImageData(img, 0, 0);
}
function renderFill() {
  if (!state.fill) { renderSeeds(); return; }
  clearBase();
  for (let p = 0; p < N; p++) {
    const lab = state.fill[p];
    if (lab) putPixel(p, lab);
  }
  // 种子位置叠白边点，便于对照
  for (let p = 0; p < N; p++) if (state.seed[p]) {
    const o = p * 4; imgData[o] = 255; imgData[o + 1] = 255; imgData[o + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function render() {
  if (state.view === 'fill' && state.fill) renderFill();
  else renderSeeds();
  applyZoom();
}
function applyZoom() {
  // 用 CSS 缩放内部 2048 画布；容器内自适应
  const z = 0.25 + (state.zoom / 100) * 2.5; // 0.25x – 2.75x
  const size = Math.round(Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight) * 0.98);
  const css = Math.min(size, Math.round(W * z));
  canvas.style.width = css + 'px';
  canvas.style.height = css + 'px';
}

// ---------- 坐标映射 ----------
function eventToCell(ev) {
  const rect = canvas.getBoundingClientRect();
  const cx = Math.floor((ev.clientX - rect.left) / rect.width * W);
  const cy = Math.floor((ev.clientY - rect.top) / rect.height * H);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
  return [cx, cy];
}

// ---------- 编辑 ----------
let painting = false;
function applyTool(c, r) {
  const p = r * W + c;
  if (state.tool === 'paint') {
    if (state.seed[p] !== state.label) { state.seed[p] = state.label; putPixel(p, state.label); }
  } else if (state.tool === 'erase') {
    if (state.seed[p] !== 0) { state.seed[p] = 0; putPixel(p, 0); }
  }
  updateSeedCount();
}
canvas.addEventListener('pointerdown', (ev) => {
  const cell = eventToCell(ev);
  if (!cell) return;
  if (state.tool === 'inspect') { showCell(...cell); return; }
  painting = true;
  canvas.setPointerCapture(ev.pointerId);
  applyTool(...cell);
  ctx.putImageData(img, 0, 0);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!painting) return;
  const cell = eventToCell(ev);
  if (!cell) return;
  applyTool(...cell);
  ctx.putImageData(img, 0, 0);
});
window.addEventListener('pointerup', () => { painting = false; });

// ---------- 点格查看 ----------
function physDelta(c, r, sc0, sr0) {
  let dx = Math.abs(c - sc0), dy = Math.abs(r - sr0);
  if (state.wrap) { dx = Math.min(dx, W - dx); dy = Math.min(dy, H - dy); }
  return { dx, dy, d2: (dx * state.sx) ** 2 + (dy * state.sy) ** 2 };
}
function srcBox(el, title, d, lab, r, c) {
  if (d === SDTCore.INF || lab === 0) { el.innerHTML = `${title}：无`; return; }
  const color = LABEL_COLORS[lab];
  el.innerHTML = `${title}：<span class="lab-dot" style="background:${color}"></span>` +
    `标签 <b>${lab}</b> @ (列 ${c}, 行 ${r})<br>精确 d² = <b>${d}</b>`;
}
function showCell(c, r) {
  const p = r * W + c;
  $('cell-coord').textContent = `(${c}, ${r})`;
  if (!state.top) { setStatus('请先应用设置并计算。', 'warn'); return; }
  const t = state.top;
  srcBox($('src1'), '最近种子', t.d1[p], t.l1[p], t.r1[p], t.c1[p]);
  srcBox($('src2'), '最近异类', t.d2[p], t.l2[p], t.r2[p], t.c2[p]);
  $('cell-label').textContent = state.fill ? `输出 ${state.fill[p]}` : '—';
  // 附物理坐标差校验
  if (t.d1[p] !== SDTCore.INF) {
    const pd = physDelta(c, r, t.c1[p], t.r1[p]);
    $('src1').innerHTML += `<br><span style="color:var(--muted)">dx=${pd.dx}·sx, dy=${pd.dy}·sy 核验 d²=${pd.d2} ${pd.d2 === t.d1[p] ? '✓' : '✗'}</span>`;
  }
}

// ---------- 控件 ----------
function buildPalette() {
  const pal = $('palette');
  for (let l = 1; l <= 32; l++) {
    const d = document.createElement('div');
    d.className = 'swatch' + (l === state.label ? ' sel' : '');
    d.style.background = LABEL_COLORS[l];
    d.textContent = l;
    d.onclick = () => {
      state.label = l;
      pal.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
      d.classList.add('sel');
    };
    pal.appendChild(d);
  }
}
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => {
  state.tool = b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('active', x === b));
  canvas.style.cursor = state.tool === 'inspect' ? 'help' : 'crosshair';
});
document.querySelectorAll('[data-wrap]').forEach(b => b.onclick = () => {
  state.wrap = parseInt(b.dataset.wrap, 10);
  document.querySelectorAll('[data-wrap]').forEach(x => x.classList.toggle('active', x === b));
});
$('view-seeds').onclick = () => { state.view = 'seeds'; toggleView(); };
$('view-fill').onclick = () => { state.view = 'fill'; toggleView(); };
function toggleView() {
  $('view-seeds').classList.toggle('active', state.view === 'seeds');
  $('view-fill').classList.toggle('active', state.view === 'fill');
  render();
}
$('zoom').oninput = (e) => { state.zoom = parseInt(e.target.value, 10); applyZoom(); };

['sx', 'sy'].forEach(id => $(id).onchange = (e) => {
  const v = clampInt(e.target, 1, 32); state[id] = v; e.target.value = v;
});
$('radius').onchange = (e) => { state.radius = clampInt(e.target, 0, 4096); };
$('margin').onchange = (e) => { state.margin = clampInt(e.target, 0, 1 << 30); };
function clampInt(el, lo, hi) {
  let v = parseInt(el.value, 10);
  if (!Number.isFinite(v)) v = lo;
  v = Math.max(lo, Math.min(hi, v));
  el.value = v;
  return v;
}

function updateSeedCount() {
  let c = 0;
  for (let p = 0; p < N; p++) if (state.seed[p]) c++;
  $('seed-count').textContent = c;
  return c;
}
function setStatus(msg, kind) {
  const el = $('status');
  el.className = 'status ' + (kind || '');
  el.textContent = msg;
}
function setProgress(x) { $('prog').style.width = (x * 100).toFixed(1) + '%'; }

// ---------- 计算 ----------
let runSeq = 0;
$('run').onclick = async () => {
  const seq = ++runSeq;
  const params = { sx: state.sx, sy: state.sy, wrap: !!state.wrap };
  state.radius = clampInt($('radius'), 0, 4096);
  state.margin = clampInt($('margin'), 0, 1 << 30);
  $('run').disabled = true;
  setStatus('计算中…（worker 并行）', 'warn');
  setProgress(0.05);
  const t0 = performance.now();
  try {
    const top = await LMarginCompute.runCompute(W, H, state.seed, params, (done, total) => {
      if (seq !== runSeq) return;
      setProgress(0.1 + 0.8 * done / total);
    });
    if (seq !== runSeq) return;
    state.top = top;
    const { out, filled } = SDTCore.applyFill(W, H, top, state.radius, state.margin);
    state.fill = out;
    const ms = performance.now() - t0;
    setProgress(1);
    $('fill-count').textContent = filled;
    $('elapsed').textContent = ms.toFixed(0) + ' ms';
    setStatus(`完成：${filled} 格填充，耗时 ${ms.toFixed(0)} ms`, 'ok');
    if (state.view === 'fill') render();
  } catch (err) {
    setStatus('计算失败：' + (err && err.message ? err.message : err), 'err');
  } finally {
    $('run').disabled = false;
  }
};

// ---------- 导入 ----------
$('import-btn').onclick = () => $('import-file').click();
$('import-file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      importJSON(data);
      setStatus(`已导入 ${data.seeds.length} 个种子（${data.width}×${data.height}）`, 'ok');
    } catch (err) {
      setStatus('导入失败：' + err.message, 'err');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};
function importJSON(data) {
  // 画布固定 2048²；样例可能是较小尺寸（如 12×8），只要种子坐标落在界内就导入，
  // 种子按其原始 (列,行) 放置；spacing/wrap/radius/margin 采用文件中的设置。
  if (!Array.isArray(data.seeds)) throw new Error('JSON 缺少 seeds 数组');
  state.seed.fill(0);
  const seen = new Set();
  let skipped = 0;
  for (const s of data.seeds) {
    const [c, r, lab] = s;
    if (!Number.isInteger(c) || !Number.isInteger(r) || !Number.isInteger(lab)) { skipped++; continue; }
    if (c < 0 || c >= W || r < 0 || r >= H || lab < 1 || lab > 32) { skipped++; continue; }
    const key = r * W + c;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    state.seed[key] = lab;
  }
  if (Array.isArray(data.spacing)) {
    state.sx = clampInt({ value: data.spacing[0] }, 1, 32); $('sx').value = state.sx;
    state.sy = clampInt({ value: data.spacing[1] }, 1, 32); $('sy').value = state.sy;
  }
  if (typeof data.wrap === 'boolean') {
    state.wrap = data.wrap ? 1 : 0;
    document.querySelectorAll('[data-wrap]').forEach(x =>
      x.classList.toggle('active', parseInt(x.dataset.wrap, 10) === state.wrap));
  }
  if (Number.isFinite(data.radius)) { state.radius = data.radius; $('radius').value = data.radius; }
  if (Number.isFinite(data.margin)) { state.margin = data.margin; $('margin').value = data.margin; }
  updateSeedCount();
  state.top = null; state.fill = null;
  render();
  if (data.width !== W || data.height !== H) {
    setStatus(`已导入 ${seen.size} 个种子（源尺寸 ${data.width}×${data.height}，置于 ${W} 画布；跳过 ${skipped}）`, 'warn');
  }
}

// ---------- 导出 P5 ----------
$('export-p5').onclick = () => {
  if (!state.fill) { setStatus('请先计算再导出。', 'warn'); return; }
  const bytes = LMarginCompute.buildP5(W, H, state.fill);
  const blob = new Blob([bytes], { type: 'image/x-portable-graymap' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'labels.pgm';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus('已导出 P5（最大样值 32，原始标签字节）', 'ok');
};

// ---------- 初始化 ----------
$('dim-label').textContent = `${W} × ${H} 稀疏种子图`;
buildPalette();
updateSeedCount();
render();
window.addEventListener('resize', applyZoom);
