/* app.js — LUT 链校验台 UI 逻辑 */
'use strict';
/* global LutCore */

const $ = (id) => document.getElementById(id);

const state = {
  stages: [],            // {id, name, lut, enabled, srcText}
  nextId: 1,
  image: null,           // {width, height, orig:Uint8Array, processed:Uint8ClampedArray, name}
  picked: null,          // {x, y}
  baked: null,           // 烘焙得到的 3D lut
  compareLut: null,      // 用于对比的 LUT（烘焙载入或从文件载入）
  compareName: '',
  extraProbes: [],       // 手动加入对比的颜色
  lastCompare: null,
};

/* ---------------- 工具 ---------------- */

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  return Number(v.toPrecision(7)).toString();
}
function fmtFixed(v) {
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(6);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function download(bytes, filename, mime) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function setErr(id, msg) { $(id).textContent = msg || ''; }

/* ---------------- PNG 解码（不预乘，保留透明像素 RGB） ---------------- */

async function decodePngUnpremultiplied(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // 校验 PNG 签名与 IHDR：必须是 8 位 RGBA、边长 ≤ 1024
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('不是 PNG 文件');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ihdrLen = dv.getUint32(8);
  const type = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (ihdrLen !== 13 || type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
  const w = dv.getUint32(16), h = dv.getUint32(20);
  const bitDepth = buf[24], colorType = buf[25];
  if (bitDepth !== 8 || colorType !== 6)
    throw new Error(`仅支持 8 位 RGBA PNG（当前：位深 ${bitDepth}，颜色类型 ${colorType}）`);
  if (w < 1 || h < 1 || w > 1024 || h > 1024)
    throw new Error(`边长须 ≤ 1024（当前 ${w}×${h}）`);

  // createImageBitmap(premultiplyAlpha:'none') + WebGL 读回，避免 canvas 2D 的预乘
  const blob = new Blob([buf], { type: 'image/png' });
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('当前浏览器不支持 WebGL，无法在不预乘的前提下解码 PNG');
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const flipped = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
  // readPixels 原点在左下，翻回左上原点
  const px = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    px.set(flipped.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
  }
  bmp.close && bmp.close();
  gl.getExtension('WEBGL_lose_context') && gl.getExtension('WEBGL_lose_context').loseContext();
  return { width: w, height: h, data: px };
}

/* ---------------- 图像处理与显示 ---------------- */

function enabledStages() { return state.stages; }

function reprocessImage() {
  const img = state.image;
  if (!img) return;
  const { width, height, orig } = img;
  const out = new Uint8ClampedArray(orig.length);
  for (let i = 0; i < orig.length; i += 4) {
    const r = orig[i] / 255, g = orig[i + 1] / 255, b = orig[i + 2] / 255;
    const res = LutCore.applyChain(enabledStages(), r, g, b).out;
    // 仅最终展示时夹紧到 [0,1]
    out[i] = Math.round(LutCore.clamp01(res[0]) * 255);
    out[i + 1] = Math.round(LutCore.clamp01(res[1]) * 255);
    out[i + 2] = Math.round(LutCore.clamp01(res[2]) * 255);
    out[i + 3] = orig[i + 3]; // alpha 原样保留
  }
  img.processed = out;
  renderCanvas();
  $('exportPng').disabled = false;
}

function renderCanvas() {
  const img = state.image;
  if (!img) return;
  const canvas = $('view');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(img.processed, img.width, img.height), 0, 0);
  $('imgInfo').textContent =
    `${img.name} — ${img.width}×${img.height}，点击画面选取探针像素`;
  updateMarker();
}

function updateMarker() {
  const m = $('marker');
  if (!state.image || !state.picked) { m.hidden = true; return; }
  const canvas = $('view');
  const scaleX = canvas.clientWidth / state.image.width;
  const scaleY = canvas.clientHeight / state.image.height;
  m.style.left = (state.picked.x + 0.5) * scaleX + 'px';
  m.style.top = (state.picked.y + 0.5) * scaleY + 'px';
  m.hidden = false;
}

/* ---------------- 探针 ---------------- */

function probeInput() {
  const r = parseFloat($('probeR').value);
  const g = parseFloat($('probeG').value);
  const b = parseFloat($('probeB').value);
  if (![r, g, b].every(Number.isFinite)) return null;
  return [r, g, b];
}

function renderProbe() {
  const inp = probeInput();
  const host = $('probeTable');
  if (!inp) { host.innerHTML = '<div class="error">探针 RGB 须为有限浮点数</div>'; return; }
  const { out, steps } = LutCore.applyChain(enabledStages(), inp[0], inp[1], inp[2]);

  let html = '<table><tr><th>级</th><th>名称</th><th class="num">输入 R</th><th class="num">输入 G</th><th class="num">输入 B</th>' +
    '<th class="num">输出 R</th><th class="num">输出 G</th><th class="num">输出 B</th></tr>';
  if (steps.length === 0) {
    html += `<tr class="skipped"><td colspan="8">链为空，输入直通</td></tr>`;
  }
  steps.forEach((s, i) => {
    const cls = s.enabled ? '' : ' class="skipped"';
    const name = s.enabled ? esc(s.name) : esc(s.name) + '（已跳过）';
    html += `<tr${cls}><td>${i + 1}</td><td>${name}</td>` +
      s.input.map((v) => `<td class="num">${fmtFixed(v)}</td>`).join('') +
      s.output.map((v) => `<td class="num">${fmtFixed(v)}</td>`).join('') + '</tr>';
  });
  const sw = (v) => {
    const c = v.map((x) => Math.round(LutCore.clamp01(x) * 255));
    return `<span class="swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>`;
  };
  html += `<tr class="total"><td colspan="2">链输出（未夹紧）</td><td colspan="3"></td>` +
    out.map((v) => `<td class="num">${fmtFixed(v)}</td>`).join('') + '</tr>';
  html += `<tr><td colspan="2">展示值（夹到 [0,1]）</td><td colspan="2">${sw(inp)} 输入</td><td colspan="2">${sw(out)} 输出</td>` +
    out.map((v) => `<td class="num">${fmtFixed(LutCore.clamp01(v))}</td>`).join('') + '</tr>';
  html += '</table>';
  host.innerHTML = html;
}

/* ---------------- 链管理 ---------------- */

function renderStages() {
  $('stageCount').textContent = `${state.stages.length} / ${LutCore.MAX_STAGES}`;
  const list = $('stageList');
  list.innerHTML = '';
  state.stages.forEach((st, i) => {
    const li = document.createElement('li');
    if (!st.enabled) li.className = 'disabled';
    const lut = st.lut;
    const meta = `${lut.type === '1d' ? '1D' : '3D'} ${lut.size}` +
      ` · DOMAIN [${lut.domainMin.map(fmt).join(',')}] → [${lut.domainMax.map(fmt).join(',')}]`;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = st.enabled; cb.title = '启用/停用该级';
    cb.onchange = () => { st.enabled = cb.checked; refresh(); };

    const label = document.createElement('div');
    label.className = 'grow';
    label.innerHTML = `<div class="name">${i + 1}. ${esc(st.name)}</div><div class="meta">${esc(meta)}</div>`;

    const up = document.createElement('button');
    up.textContent = '↑'; up.disabled = i === 0; up.title = '上移';
    up.onclick = () => { [state.stages[i - 1], state.stages[i]] = [state.stages[i], state.stages[i - 1]]; refresh(); };
    const down = document.createElement('button');
    down.textContent = '↓'; down.disabled = i === state.stages.length - 1; down.title = '下移';
    down.onclick = () => { [state.stages[i + 1], state.stages[i]] = [state.stages[i], state.stages[i + 1]]; refresh(); };
    const del = document.createElement('button');
    del.textContent = '✕'; del.title = '移除';
    del.onclick = () => { state.stages.splice(i, 1); refresh(); };

    li.append(cb, label, up, down, del);
    list.appendChild(li);
  });
}

function addCubeFile(file) {
  return file.text().then((text) => {
    if (state.stages.length >= LutCore.MAX_STAGES)
      throw new Error(`最多 ${LutCore.MAX_STAGES} 级，请先移除现有级`);
    const lut = LutCore.parseCube(text);
    const name = lut.title || file.name;
    state.stages.push({ id: state.nextId++, name, lut, enabled: true, srcText: text });
    if (lut.warnings.length) $('cubeError').textContent = lut.warnings.join('\n');
  });
}

/* ---------------- 烘焙与对比 ---------------- */

function bakeSettings() {
  const min = ['bakeMinR', 'bakeMinG', 'bakeMinB'].map((id) => parseFloat($(id).value));
  const max = ['bakeMaxR', 'bakeMaxG', 'bakeMaxB'].map((id) => parseFloat($(id).value));
  const size = parseInt($('bakeSize').value, 10);
  return { min, max, size };
}

function doBake() {
  setErr('bakeError');
  try {
    const { min, max, size } = bakeSettings();
    if (![...min, ...max].every(Number.isFinite)) throw new Error('DOMAIN 须为有限浮点数');
    if (!Number.isInteger(size)) throw new Error('边长须为整数');
    state.baked = LutCore.bakeChain(enabledStages(), min, max, size);
    $('bakeInfo').textContent =
      `已烘焙 ${size}³ 网格（${(size * size * size).toLocaleString()} 点），DOMAIN [${min.map(fmt).join(',')}] → [${max.map(fmt).join(',')}]`;
    $('exportCube').disabled = false;
    $('useBaked').disabled = false;
  } catch (e) {
    setErr('bakeError', e.message);
    state.baked = null;
    $('exportCube').disabled = true;
    $('useBaked').disabled = true;
  }
}

function setCompareLut(lut, name) {
  state.compareLut = lut;
  state.compareName = name;
  state.lastCompare = null;
  $('compareInfo').textContent =
    `对比表：${name}（3D ${lut.size}，DOMAIN [${lut.domainMin.map(fmt).join(',')}] → [${lut.domainMax.map(fmt).join(',')}]）`;
  $('compareGo').disabled = false;
  $('addProbeColor').disabled = false;
  $('compareSummary').innerHTML = '';
  $('compareTable').innerHTML = '';
}

function doCompare() {
  setErr('compareError');
  const lut = state.compareLut;
  if (!lut) return;
  const count = Math.max(1, Math.min(100000, parseInt($('probeCount').value, 10) || 500));
  const seed = parseInt($('probeSeed').value, 10) || 0;
  // 连续随机探针（非网格点）+ 手动加入的颜色
  const probes = LutCore.makeProbes(lut.domainMin, lut.domainMax, count, seed)
    .concat(state.extraProbes.map((p) => p.slice()));
  const res = LutCore.compareProbes(enabledStages(), lut, probes);
  state.lastCompare = res;

  const cls = res.maxErr <= 1e-6 ? 'ok' : 'bad';
  $('compareSummary').innerHTML = `<div class="summary">` +
    `<span>探针数 <b>${probes.length}</b>（含手动 ${state.extraProbes.length}）</span>` +
    `<span>最大误差 <b class="${cls}">${res.maxErr.toExponential(3)}</b></span>` +
    `<span>平均 <b>${res.meanErr.toExponential(3)}</b></span>` +
    `<span>RMS <b>${res.rmsErr.toExponential(3)}</b></span></div>`;

  const top = res.rows.slice(0, 50);
  let html = '<div class="table-scroll"><table><tr><th>#</th><th>输入 RGB</th><th>原链输出</th><th>烘焙表输出</th><th class="num">|Δ| 最大通道</th></tr>';
  top.forEach((r, i) => {
    const f = (arr) => arr.map((v) => fmtFixed(v)).join(', ');
    html += `<tr><td>${i + 1}</td><td>${f(r.input)}</td><td>${f(r.chainOut)}</td><td>${f(r.bakedOut)}</td>` +
      `<td class="num">${r.maxAbs.toExponential(3)}</td></tr>`;
  });
  html += '</table></div><div class="hint">按误差降序，最多显示前 50 条。探针为 DOMAIN 内连续随机点，非网格点。</div>';
  $('compareTable').innerHTML = html;
}

/* ---------------- 工程导出 / 载入 ---------------- */

function exportProject() {
  const { min, max, size } = bakeSettings();
  const proj = {
    app: 'tetrahedral-lut-chain',
    version: 1,
    stages: state.stages.map((s) => ({ name: s.name, enabled: s.enabled, cube: s.srcText })),
    bake: { domainMin: min, domainMax: max, size },
  };
  download(JSON.stringify(proj, null, 2), 'lut-chain-project.json', 'application/json');
  $('projectInfo').textContent = `已导出工程（${state.stages.length} 级，含完整表内容）。`;
}

function importProject(file) {
  setErr('projectError');
  file.text().then((text) => {
    const proj = JSON.parse(text);
    if (!proj || proj.app !== 'tetrahedral-lut-chain' || !Array.isArray(proj.stages))
      throw new Error('不是本应用的工程文件');
    if (proj.stages.length > LutCore.MAX_STAGES)
      throw new Error(`工程含 ${proj.stages.length} 级，超过上限 ${LutCore.MAX_STAGES}`);
    const stages = proj.stages.map((s, i) => {
      if (typeof s.cube !== 'string') throw new Error(`第 ${i + 1} 级缺少表内容`);
      const lut = LutCore.parseCube(s.cube);
      return { id: state.nextId++, name: s.name || lut.title || `级 ${i + 1}`, lut, enabled: s.enabled !== false, srcText: s.cube };
    });
    state.stages = stages;
    if (proj.bake) {
      const b = proj.bake;
      if (Array.isArray(b.domainMin)) ['bakeMinR', 'bakeMinG', 'bakeMinB'].forEach((id, i) => { if (Number.isFinite(b.domainMin[i])) $(id).value = b.domainMin[i]; });
      if (Array.isArray(b.domainMax)) ['bakeMaxR', 'bakeMaxG', 'bakeMaxB'].forEach((id, i) => { if (Number.isFinite(b.domainMax[i])) $(id).value = b.domainMax[i]; });
      if (Number.isInteger(b.size)) $('bakeSize').value = b.size;
    }
    state.baked = null;
    $('exportCube').disabled = true;
    $('useBaked').disabled = true;
    $('bakeInfo').textContent = '';
    $('projectInfo').textContent = `已载入工程：${stages.length} 级（${file.name}）。`;
    refresh();
  }).catch((e) => setErr('projectError', `载入工程失败：${e.message}`));
}

/* ---------------- 汇总刷新 ---------------- */

function refresh() {
  renderStages();
  reprocessImage();
  renderProbe();
  // 链变了，旧对比结果失效
  if (state.lastCompare) { state.lastCompare = null; doCompareSafe(); }
}
function doCompareSafe() {
  try { if (state.compareLut) doCompare(); } catch (e) { setErr('compareError', e.message); }
}

/* ---------------- 事件绑定 ---------------- */

$('cubeFiles').addEventListener('change', async (ev) => {
  setErr('cubeError');
  const files = [...ev.target.files];
  for (const f of files) {
    try { await addCubeFile(f); }
    catch (e) { setErr('cubeError', `${f.name}: ${e.message}`); break; }
  }
  ev.target.value = '';
  refresh();
});

$('pngFile').addEventListener('change', async (ev) => {
  setErr('imgError');
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const dec = await decodePngUnpremultiplied(f);
    state.image = { width: dec.width, height: dec.height, orig: dec.data, processed: null, name: f.name };
    state.picked = null;
    reprocessImage();
  } catch (e) {
    setErr('imgError', e.message);
  }
});

$('view').addEventListener('click', (ev) => {
  if (!state.image) return;
  const rect = ev.target.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) * state.image.width / rect.width);
  const y = Math.floor((ev.clientY - rect.top) * state.image.height / rect.height);
  if (x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) return;
  state.picked = { x, y };
  const i = (y * state.image.width + x) * 4;
  const o = state.image.orig;
  $('probeR').value = (o[i] / 255).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
  $('probeG').value = (o[i + 1] / 255).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
  $('probeB').value = (o[i + 2] / 255).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
  $('probeSrc').textContent =
    `像素 (${x}, ${y})：原图 RGBA = (${o[i]}, ${o[i + 1]}, ${o[i + 2]}, ${o[i + 3]})，` +
    `处理后 = (${state.image.processed[i]}, ${state.image.processed[i + 1]}, ${state.image.processed[i + 2]}, ${state.image.processed[i + 3]})`;
  updateMarker();
  renderProbe();
});

$('probeGo').addEventListener('click', () => {
  state.picked = null;
  $('probeSrc').textContent = '手动输入的浮点 RGB';
  updateMarker();
  renderProbe();
});

$('exportPng').addEventListener('click', async () => {
  if (!state.image || !state.image.processed) return;
  try {
    const png = await LutCore.encodePng(state.image.width, state.image.height, state.image.processed);
    download(png, 'processed.png', 'image/png');
  } catch (e) {
    setErr('imgError', `PNG 编码失败：${e.message}`);
  }
});

$('bakeGo').addEventListener('click', doBake);

$('exportCube').addEventListener('click', () => {
  if (!state.baked) return;
  download(LutCore.cubeToText(state.baked), 'baked-chain.cube', 'text/plain');
});

$('useBaked').addEventListener('click', () => {
  if (state.baked) setCompareLut(state.baked, '烘焙结果（内存）');
});

$('compareFile').addEventListener('change', async (ev) => {
  setErr('compareError');
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const lut = LutCore.parseCube(await f.text());
    if (lut.type !== '3d') throw new Error('对比表须为 3D LUT');
    setCompareLut(lut, f.name);
  } catch (e) {
    setErr('compareError', `${f.name}: ${e.message}`);
  }
});

$('compareGo').addEventListener('click', doCompareSafe);

$('addProbeColor').addEventListener('click', () => {
  const inp = probeInput();
  if (!inp) { setErr('compareError', '当前探针颜色无效'); return; }
  state.extraProbes.push(inp);
  doCompareSafe();
});

$('exportProject').addEventListener('click', exportProject);

$('projectFile').addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) importProject(f);
});

window.addEventListener('resize', updateMarker);

// 测试钩子：暴露解码后的未预乘原始像素
window.__state_image_orig = () => (state.image ? state.image.orig : new Uint8Array(0));

// 初始渲染
refresh();
