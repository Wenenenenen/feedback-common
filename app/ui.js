/*
 * 界面层：只负责 DOM 交互与预览，所有像素逻辑都走 engine.js。
 * 依赖全局 FlowEngine、FlowZip（由 build 脚本内联，Node 测试不加载本文件）。
 */
'use strict';

const CLASS_COLORS = [
  [120, 120, 120], // 0 端点原图（灰，仅图例用，端点不叠加）
  [46, 160, 67],   // 1 通过供色：绿
  [230, 159, 0],   // 2 仅未通过：橙
  [0, 114, 178],   // 3 补洞：蓝
  [204, 50, 50],   // 4 全空黑：红
];

const state = {
  ds: null,
  passes: null,
  result: null,          // 当前预览结果
  step: 32,
  tolerance: 10,
  overlay: false,
  selected: new Set(),
  lastGoodResult: null,  // 出错时保留的上一次画面
  renderMs: 0,
  inspectCoord: null,    // 当前点选坐标，重渲染后自动刷新检查器
};

const el = (id) => document.getElementById(id);

function setStatus(kind, message) {
  const bar = el('statusBar');
  bar.className = `status ${kind}`;
  bar.textContent = message;
  bar.style.display = message ? 'flex' : 'none';
}

/* ---------------- 数据载入 ---------------- */

async function readFileEntry(fileEntry) {
  // input 拿到的是普通 File，直接读 arrayBuffer；不做 .file 真值判断
  // （File 原型上存在 file() 之类的成员，真值判断会误入 DataView 分支）
  const buf = await fileEntry.arrayBuffer();
  return { name: fileEntry.name, bytes: new Uint8Array(buf) };
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  // 按“文件基名”精确识别，避免目录名或后缀造成误判
  const slotOf = (name) => {
    const base = name.split(/[\\/]/).pop().toLowerCase();
    if (base === 'a.ppm') return 'aPPM';
    if (base === 'b.ppm') return 'bPPM';
    if (base === 'a.bin') return 'aBIN';
    if (base === 'b.bin') return 'bBIN';
    return null;
  };
  const picked = {};
  const unknown = [];
  for (const f of files) {
    const slot = slotOf(f.name);
    if (slot) picked[slot] = f;
    else unknown.push(f.name);
  }
  const missing = ['aPPM', 'bPPM', 'aBIN', 'bBIN'].filter((k) => !picked[k]);
  if (missing.length || unknown.length) {
    const parts = [];
    if (missing.length) parts.push(`缺少 ${missing.join('、')}`);
    if (unknown.length) parts.push(`无法识别 ${unknown.join('、')}`);
    setStatus('error', `${parts.join('；')}（需要恰好 a.ppm、b.ppm、a.bin、b.bin）。已保留上一次画面。`);
    return;
  }
  try {
    const payload = {
      aPPM: await readFileEntry(picked.aPPM),
      bPPM: await readFileEntry(picked.bPPM),
      aBIN: await readFileEntry(picked.aBIN),
      bBIN: await readFileEntry(picked.bBIN),
    };
    const ds = FlowEngine.loadDataset(payload);
    // 全部校验通过后才替换现场，保证失败时上一次画面完整保留
    state.ds = ds;
    state.passes = {
      passA: FlowEngine.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
      passB: FlowEngine.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
    };
    state.selected = new Set([state.step]);
    el('datasetInfo').textContent =
      `已载入 ${ds.names.aPPM} / ${ds.names.bPPM}，尺寸 ${ds.width}×${ds.height}`;
    setStatus('ok', `载入成功：${ds.width}×${ds.height}，往返检查已建立。`);
    buildStepGrid();
    renderCurrent();
  } catch (err) {
    setStatus('error', `${err.message}。已保留上一次画面。`);
  }
}

/* ---------------- 渲染与预览 ---------------- */

function computeResult() {
  const { ds, step, tolerance, passes } = state;
  if (!ds) return null;
  if (step === 0) return FlowEngine.endpointFrame(ds, 0);
  if (step === 64) return FlowEngine.endpointFrame(ds, 1);
  return FlowEngine.renderFrame(ds, step, tolerance, passes);
}

function renderCurrent() {
  if (!state.ds) return;
  const t0 = performance.now();
  const result = computeResult();
  state.renderMs = performance.now() - t0;
  state.result = result;
  state.lastGoodResult = result;
  drawPreview();
  updateStats();
  // 若已有点选，按当前结果刷新检查器（坐标在同尺寸下始终有效）
  if (state.inspectCoord) {
    const info = FlowEngine.inspectPixel(result, state.ds, state.inspectCoord.x, state.inspectCoord.y);
    if (info) renderInspector(info);
  }
}

function drawPreview() {
  const r = state.result;
  if (!r) return;
  const W = r.width;
  const H = r.height;
  const canvas = el('view');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let d = 0; d < W * H; d += 1) {
    const o = d * 4;
    const s = d * 3;
    img.data[o] = r.rgb[s];
    img.data[o + 1] = r.rgb[s + 1];
    img.data[o + 2] = r.rgb[s + 2];
    img.data[o + 3] = 255;
  }
  if (state.overlay && !r.endpoint) {
    for (let d = 0; d < W * H; d += 1) {
      const c = r.cls[d];
      if (c === 0) continue;
      const [cr, cg, cb] = CLASS_COLORS[c];
      const o = d * 4;
      // 60% 原图 + 40% 分类色，既保留画面又看清区域
      img.data[o] = Math.round(img.data[o] * 0.6 + cr * 0.4);
      img.data[o + 1] = Math.round(img.data[o + 1] * 0.6 + cg * 0.4);
      img.data[o + 2] = Math.round(img.data[o + 2] * 0.6 + cb * 0.4);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function updateStats() {
  const r = state.result;
  if (!r) return;
  const counts = [0, 0, 0, 0, 0];
  for (const c of r.cls) counts[c] += 1;
  const N = r.width * r.height;
  const rows = counts.map((cnt, i) => {
    const pct = (cnt / N * 100).toFixed(1);
    return `<span class="chip c${i}"><i style="background:rgb(${CLASS_COLORS[i].join(',')})"></i>` +
      `${FlowEngine.CLASS_NAMES[i]} ${cnt}（${pct}%）</span>`;
  }).join('');
  el('classStats').innerHTML = rows;
  const tolText = r.endpoint ? '端点（不投影/不补洞）' : `容差 ±${r.tolerance}`;
  el('renderInfo').textContent =
    `档位 n=${r.n}（t=${(r.t).toFixed(4)}） · ${tolText} · 渲染 ${state.renderMs.toFixed(1)} ms`;
}

/* ---------------- 点选 ---------------- */

function inspectAt(clientX, clientY) {
  const r = state.result;
  if (!r) return;
  const canvas = el('view');
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / rect.width * r.width);
  const y = Math.floor((clientY - rect.top) / rect.height * r.height);
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  state.inspectCoord = { x, y };
  const info = FlowEngine.inspectPixel(r, state.ds, x, y);
  renderInspector(info);
}

function renderInspector(info) {
  if (!info) return;
  const swatch = `rgb(${info.rgb.join(',')})`;
  let html = `
    <div class="insp-head">
      <span>像素 (x=${info.x}, y=${info.y})</span>
      <span class="chip c${info.cls}"><i style="background:rgb(${CLASS_COLORS[info.cls].join(',')})"></i>${FlowEngine.CLASS_NAMES[info.cls]}</span>
    </div>
    <div class="insp-rgb"><span>结果 RGB</span><b style="background:${swatch}"></b>${info.rgb.join(', ')}</div>`;

  if (info.endpoint) {
    html += `<p class="muted">${info.sideName} 原图，端点不做投影与补洞。</p>`;
  } else if (info.cls === 4) {
    html += `<p class="muted">${info.note}</p>`;
  } else if (info.cls === 3) {
    const f = info.fillFrom;
    html += `<p class="muted">${info.note}</p>
      <p>复制来源：<b>(${f.x}, ${f.y})</b>（线性索引 ${f.index}）</p>`;
  } else {
    html += `<p>最小非零深度 <b>zmin=${info.zmin}</b>，深度层 [${info.zmin}, ${info.layerHigh}]；` +
      `${info.hasPassInLayer ? '层内有往返通过点，<b>仅用通过点</b>混色' : '层内无通过点，使用该层全部未通过贡献'}</p>`;
    const rows = info.contributors.map((c) => {
      const tag = c.side === 0 ? 'a' : 'b';
      const status = !c.inLayer ? '深度层外·剔除'
        : !c.used ? '优先级剔除'
          : c.pass ? '通过·供色' : '未通过·供色';
      return `<tr class="${c.used ? 'used' : 'dropped'}">
        <td>${tag}</td><td>(${c.srcX}, ${c.srcY})</td>
        <td>z=${c.z}</td><td>${c.weight.toFixed(5)}</td>
        <td>${c.pass ? '✓' : '✗'}</td><td>${status}</td></tr>`;
    }).join('');
    html += `<table class="contrib"><thead><tr>
      <th>帧</th><th>源坐标</th><th>深度</th><th>权重</th><th>往返</th><th>状态</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  }
  el('inspector').innerHTML = html;
}

/* ---------------- 档位选择网格 ---------------- */

function buildStepGrid() {
  const grid = el('stepGrid');
  grid.innerHTML = '';
  for (let n = 0; n <= 64; n += 1) {
    const lab = document.createElement('label');
    lab.className = 'step-cb';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(n);
    cb.checked = state.selected.has(n);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(n);
      else state.selected.delete(n);
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(String(n)));
    grid.appendChild(lab);
  }
}

function syncGridChecks() {
  el('stepGrid').querySelectorAll('input').forEach((cb) => {
    cb.checked = state.selected.has(Number(cb.value));
  });
}

/* ---------------- 导出 ---------------- */

function selectedSteps() {
  return [...state.selected].filter((n) => n >= 0 && n <= 64).sort((a, b) => a - b);
}

async function exportZip() {
  if (!state.ds) {
    setStatus('error', '请先载入数据。');
    return;
  }
  const steps = selectedSteps();
  if (steps.length === 0) {
    setStatus('error', '请至少选择一个档位再导出。');
    return;
  }
  const btn = el('exportBtn');
  btn.disabled = true;
  try {
    const entries = [];
    for (let i = 0; i < steps.length; i += 1) {
      const n = steps[i];
      const r = n === 0 ? FlowEngine.endpointFrame(state.ds, 0)
        : n === 64 ? FlowEngine.endpointFrame(state.ds, 1)
          : FlowEngine.renderFrame(state.ds, n, state.tolerance, state.passes);
      const tag = String(n).padStart(2, '0');
      entries.push({ name: `frame_${tag}.ppm`, data: FlowEngine.encodePPM(r.rgb, r.width, r.height) });
      entries.push({ name: `class_${tag}.p5`, data: FlowEngine.encodeP5(r.cls, r.width, r.height) });
      setStatus('ok', `打包进度 ${i + 1}/${steps.length}（档位 ${tag}）…`);
      // 让出主线程，保持进度条可读
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const zipBytes = FlowZip.buildZip(entries);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inbetween_tol${state.tolerance}_${steps.length}steps.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus('ok', `已导出 ${steps.length} 个档位（${entries.length} 个文件）：PPM + 分类 P5。`);
  } catch (err) {
    setStatus('error', `导出失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function exportCurrentPPM() {
  const r = state.result;
  if (!r) {
    setStatus('error', '请先载入数据。');
    return;
  }
  const data = FlowEngine.encodePPM(r.rgb, r.width, r.height);
  const blob = new Blob([data], { type: 'image/x-portable-pixmap' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frame_${String(r.n).padStart(2, '0')}.ppm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- 演示数据 ---------------- */

async function loadDemo() {
  try {
    const dt = FlowDemoData;
    const payload = {
      aPPM: { name: 'a.ppm', bytes: decode64(dt.aPPM) },
      bPPM: { name: 'b.ppm', bytes: decode64(dt.bPPM) },
      aBIN: { name: 'a.bin', bytes: decode64(dt.aBIN) },
      bBIN: { name: 'b.bin', bytes: decode64(dt.bBIN) },
    };
    const ds = FlowEngine.loadDataset(payload);
    state.ds = ds;
    state.passes = {
      passA: FlowEngine.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
      passB: FlowEngine.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
    };
    state.selected = new Set([state.step]);
    el('datasetInfo').textContent =
      `演示数据（samples/flow-inbetween-cases）· ${ds.width}×${ds.height}`;
    setStatus('ok', '演示数据载入成功，可直接拖动时间轴。');
    buildStepGrid();
    renderCurrent();
  } catch (err) {
    setStatus('error', `演示数据载入失败：${err.message}`);
  }
}

function decode64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
  return u;
}

/* ---------------- 事件绑定 ---------------- */

function bindUI() {
  el('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));
  el('demoBtn').addEventListener('click', loadDemo);

  const stepSlider = el('stepSlider');
  stepSlider.addEventListener('input', () => {
    state.step = Number(stepSlider.value);
    el('stepValue').textContent = state.step;
    state.selected.add(state.step);
    syncGridChecks();
    renderCurrent();
  });

  const tolSlider = el('tolSlider');
  tolSlider.addEventListener('input', () => {
    state.tolerance = Number(tolSlider.value);
    el('tolValue').textContent = state.tolerance;
    el('tolNum').value = state.tolerance;
    renderCurrent();
  });
  el('tolNum').addEventListener('change', () => {
    let v = Number(el('tolNum').value);
    if (Number.isNaN(v)) v = state.tolerance;
    v = Math.max(0, Math.min(65535, Math.round(v)));
    state.tolerance = v;
    el('tolNum').value = v;
    el('tolSlider').value = v;
    el('tolValue').textContent = v;
    renderCurrent();
  });

  el('overlayChk').addEventListener('change', (e) => {
    state.overlay = e.target.checked;
    drawPreview();
  });

  el('view').addEventListener('click', (e) => inspectAt(e.clientX, e.clientY));

  el('selAll').addEventListener('click', () => {
    state.selected = new Set(Array.from({ length: 65 }, (_, i) => i));
    syncGridChecks();
  });
  el('selEnds').addEventListener('click', () => {
    state.selected = new Set([0, 64]);
    syncGridChecks();
  });
  el('selCurrent').addEventListener('click', () => {
    state.selected = new Set([state.step]);
    syncGridChecks();
  });
  el('selClear').addEventListener('click', () => {
    state.selected = new Set();
    syncGridChecks();
  });

  el('exportBtn').addEventListener('click', exportZip);
  el('exportCurrentBtn').addEventListener('click', exportCurrentPPM);
}

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  buildStepGrid();
  setStatus('', '');
  el('stepValue').textContent = state.step;
  el('tolValue').textContent = state.tolerance;
});
