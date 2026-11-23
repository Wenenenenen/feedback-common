/*
 * 主线程控制器：
 *  - Blob 内联 Worker（file:// 下 classic worker 无法加载同目录脚本）
 *  - 导入失败 / 取消时保留上一份可检查、可导出的结果
 *  - 错误信息带记录位置；进度与计时
 *  - 画布预览（线性→sRGB 显示变换）、点击像素检查、RGBA64 / JSON 导出
 * 本文件不做任何合成计算，算法全部在 engine.js（Worker 内外同一份源码）。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $('view'),
  wrap: $('canvas-wrap'),
  file: $('file-input'),
  sample: $('load-sample'),
  cancel: $('cancel'),
  exportBin: $('export-rgba64'),
  exportJson: $('export-json'),
  err: $('err'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  inspect: $('inspect'),
  statSize: $('stat-size'),
  statLayers: $('stat-layers'),
  statPixels: $('stat-pixels'),
  statTime: $('stat-time'),
};

const state = {
  pack: null,        // 最近一次成功的定长打包数据
  frame: null,       // 最近一次成功的 Float64 帧
  sourceName: '',
  jobId: 0,          // 作业代次：取消或新导入都会 +1，旧代次回包/读取一律丢弃
  worker: null,
  jobStart: 0,
  selected: null,    // 当前检查像素
};

// 仅测试用：在 FileReader 读完后、启动 Worker 前注入延迟，模拟慢读取以稳定复现取消
const testHook = { readDelayMs: 0 };

/* ---------------- Worker：Blob 内联，兼容 file:// ---------------- */

function workerMain() {
  /* global DicEngine */
  // 该函数源码与 engine.js 源码拼接后注入 Blob；DicEngine 由拼接内容提供。
  self.onmessage = (ev) => {
    const { jobId, text, fileName } = ev.data;
    const t0 = Date.now();
    try {
      const data = DicEngine.parseJson(text);
      const pack = DicEngine.parseAndPack(data);
      const frame = DicEngine.compositeFrame(pack);
      // 只回传主线程需要的缓冲（transfer，零拷贝）
      self.postMessage({
        jobId, ok: true, fileName,
        width: pack.width, height: pack.height, layerCount: pack.layerCount,
        offsets: pack.offsets.buffer,
        itypes: pack.itypes.buffer,
        fvals: pack.fvals.buffer,
        rgba: frame.rgba.buffer,
        A: frame.A.buffer,
        T: frame.T.buffer,
        elapsedMs: Date.now() - t0,
      }, [pack.offsets.buffer, pack.itypes.buffer, pack.fvals.buffer,
        frame.rgba.buffer, frame.A.buffer, frame.T.buffer]);
    } catch (e) {
      self.postMessage({
        jobId, ok: false, fileName,
        message: e && e.message ? e.message : String(e),
        path: e && e.path ? e.path : null,
      });
    }
  };
}

function createWorker() {
  const engineSrc = engineSourceText();
  const src = engineSrc + '\n;' + workerMain.toString() + ';\nworkerMain();\n';
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return new Worker(url);
}

// engine.js 以内联 <script> 形式存在于 index.html（同一份源码也供 Node/require）。
// Worker 在 file:// 下无法加载外部脚本，这里直接取内联文本拼 Blob URL。
let _engineText = null;
function engineSourceText() {
  if (_engineText !== null) return _engineText;
  const tag = Array.from(document.scripts).find(
    (s) => !s.src && s.textContent.indexOf('DicEngine') >= 0);
  if (tag) {
    _engineText = tag.textContent;
    return _engineText;
  }
  // http 下的兜底：同步 XHR 读取同目录 engine.js
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'engine.js', false);
  xhr.send(null);
  if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
    _engineText = xhr.responseText;
    return _engineText;
  }
  throw new Error('无法取得 engine.js 源码以启动 Worker（HTTP ' + xhr.status + '）');
}

/* ---------------- 导入流程 ---------------- */

function setProgress(pct) {
  els.progress.classList.toggle('show', pct !== null);
  if (pct !== null) els.progressBar.style.width = pct + '%';
}

function showError(msg) {
  els.err.textContent = msg;
  els.err.classList.add('show');
}

function clearError() {
  els.err.classList.remove('show');
  els.err.textContent = '';
}

function importText(text, fileName) {
  clearError();
  const jobId = ++state.jobId;
  state.jobStart = performance.now();
  setProgress(8);
  els.cancel.disabled = false;
  els.file.value = '';

  if (testHook.readDelayMs > 0) {
    // 测试钩子：模拟慢读取，期间用户可取消
    setTimeout(() => launchImport(jobId, text, fileName), testHook.readDelayMs);
  } else {
    launchImport(jobId, text, fileName);
  }
}

function launchImport(jobId, text, fileName) {
  // 读取期间可能已被取消或被更新的导入取代
  if (jobId !== state.jobId) return;

  if (state.worker) state.worker.terminate();
  const worker = createWorker();
  state.worker = worker;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.jobId !== state.jobId) return; // 旧代次，丢弃
    els.cancel.disabled = true;
    setProgress(null);

    if (!msg.ok) {
      const where = msg.path ? `（位置：${msg.path}）` : '';
      // clearError 可能已被下一次导入调用过；错误回包到达时重新展示，
      // 保证失败信息（含记录位置）不会因连续导入而丢失。
      showError(`导入失败，已保留上一份结果。\n${msg.message}${where ? '\n' + where : ''}`);
      worker.terminate();
      if (state.worker === worker) state.worker = null;
      return;
    }

    const W = msg.width, H = msg.height;
    const pack = {
      width: W, height: H,
      offsets: new Int32Array(msg.offsets),
      itypes: new Int32Array(msg.itypes),
      fvals: new Float64Array(msg.fvals),
      layerCount: msg.layerCount,
    };
    const frame = {
      rgba: new Float64Array(msg.rgba),
      A: new Float64Array(msg.A),
      T: new Float64Array(msg.T),
    };
    state.pack = pack;
    state.frame = frame;
    state.sourceName = fileName;
    state.selected = null;

    const totalMs = performance.now() - state.jobStart;
    renderPreview(pack, frame);
    updateStats(pack, totalMs, msg.elapsedMs);
    els.exportBin.disabled = false;
    els.exportJson.disabled = false;
    renderInspectPlaceholder();
    worker.terminate();
    if (state.worker === worker) state.worker = null;
  };
  worker.onerror = (ev) => {
    if (jobId !== state.jobId) return;
    els.cancel.disabled = true;
    setProgress(null);
    showError(`导入失败，已保留上一份结果。\nWorker 错误：${ev.message || '未知错误'}`);
  };
  setProgress(22);
  worker.postMessage({ jobId, text, fileName });
  setProgress(40);
}

function cancelImport() {
  state.jobId++; // 让任何迟到的读取回调/Worker 回包失效
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  els.cancel.disabled = true;
  setProgress(null);
  showError('已取消导入，保留上一份可检查、可导出的结果。');
}
els.cancel.addEventListener('click', cancelImport);

els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => importText(String(reader.result), f.name);
  reader.onerror = () => showError(`导入失败，已保留上一份结果。\n文件读取失败：${f.name}`);
  reader.readAsText(f);
});

els.sample.addEventListener('click', () => {
  importText(JSON.stringify(window.DIC_DEFAULT_SAMPLE), 'deep-intervals.json（内置样例）');
});

// 拖拽导入
els.wrap.addEventListener('dragover', (e) => { e.preventDefault(); els.wrap.classList.add('dragover'); });
els.wrap.addEventListener('dragleave', () => els.wrap.classList.remove('dragover'));
els.wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  els.wrap.classList.remove('dragover');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => importText(String(reader.result), f.name);
  reader.onerror = () => showError(`导入失败，已保留上一份结果。\n文件读取失败：${f.name}`);
  reader.readAsText(f);
});

/* ---------------- 预览（仅显示用，不改变导出精度） ---------------- */

function linToSrgb(c) {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function renderPreview(pack, frame) {
  const { width: W, height: H } = pack;
  els.canvas.width = W;
  els.canvas.height = H;
  const img = new ImageData(W, H);
  const rgba = frame.rgba;
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    // 线性预乘 → 直色 → sRGB；透明像素在棋盘格背景上自然显形
    const a = Math.max(0, Math.min(1, rgba[o + 3]));
    for (let c = 0; c < 3; c++) {
      const lin = a > 0 ? rgba[o + c] / a : 0;
      img.data[o + c] = Math.round(linToSrgb(lin) * 255);
    }
    img.data[o + 3] = Math.round(a * 255);
  }
  const ctx = els.canvas.getContext('2d');
  ctx.putImageData(img, 0, 0);
  // CSS 尺寸：保持像素比，尽量大
  const maxSide = Math.max(W, H);
  const css = Math.min(els.wrap.clientWidth - 40, els.wrap.clientHeight - 40, 640);
  const scale = Math.max(1, Math.floor(css / maxSide));
  els.canvas.style.width = W * scale + 'px';
  els.canvas.style.height = H * scale + 'px';
}

function updateStats(pack, totalMs, workerMs) {
  let nonEmpty = 0;
  const off = pack.offsets;
  for (let p = 0; p < off.length - 1; p++) if (off[p + 1] > off[p]) nonEmpty++;
  els.statSize.textContent = `${pack.width}×${pack.height}`;
  els.statLayers.textContent = pack.layerCount.toLocaleString('en-US');
  els.statPixels.textContent = nonEmpty.toLocaleString('en-US');
  els.statTime.textContent =
    `${totalMs.toFixed(0)} ms（Worker 解析+合成 ${workerMs} ms）`;
}

/* ---------------- 像素检查 ---------------- */

els.canvas.addEventListener('click', (ev) => {
  if (!state.pack) return;
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * els.canvas.width);
  const y = Math.floor((ev.clientY - rect.top) / rect.height * els.canvas.height);
  state.selected = { x, y };
  renderInspect(x, y);
});

function renderInspectPlaceholder() {
  els.inspect.innerHTML =
    '<h2>像素检查</h2><p class="muted">点击画面中的像素查看每个积分段的入射 / 出射透射率、吸收份额与预乘贡献。</p>';
}

const f6 = (v) => (v === 0 ? '0' : Number(v).toPrecision(10));

function renderInspect(x, y) {
  const insp = DicEngine.inspectPixel(state.pack, x, y);
  const res = insp.result;
  const parts = [];
  parts.push(`<h2>像素 (${x}, ${y})</h2>`);
  parts.push('<div class="kv">');
  parts.push(`<span class="k">层数</span><span>${insp.layerCount}</span>`);
  parts.push(`<span class="k">最终 R G B</span><span class="mono">${f6(res.r)} ${f6(res.g)} ${f6(res.b)}</span>`);
  parts.push(`<span class="k">A（吸收份额和）</span><span class="mono">${f6(res.A)}</span>`);
  parts.push(`<span class="k">残余透射 T</span><span class="mono">${f6(res.T)}</span>`);
  parts.push(`<span class="k">校验 R+G…</span><span class="mono muted">A = Σ份额，holdout 不计</span>`);
  parts.push('</div>');

  parts.push('<h2>体积积分段（由近及远）</h2>');
  if (insp.segments.length === 0) {
    parts.push('<p class="muted">无活跃体积段。</p>');
  } else {
    parts.push('<table><thead><tr><th>深度区间</th><th>活跃 id</th><th>σ</th><th>T 入</th><th>T 出</th><th>吸收份额</th><th>预乘贡献 RGB</th></tr></thead><tbody>');
    for (const s of insp.segments) {
      parts.push('<tr>' +
        `<td class="mono">[${s.z0}, ${s.z1})</td>` +
        `<td class="mono">[${s.activeIds.join(',')}]</td>` +
        `<td>${f6(s.sigma)}</td>` +
        `<td>${f6(s.tIn)}</td>` +
        `<td>${f6(s.tOut)}</td>` +
        `<td>${f6(s.absorbShare)}</td>` +
        `<td class="mono">${f6(s.contribution[0])} ${f6(s.contribution[1])} ${f6(s.contribution[2])}</td>` +
        '</tr>');
    }
    parts.push('</tbody></table>');
  }

  parts.push('<h2>同深度事件次序</h2>');
  parts.push('<table><thead><tr><th>z</th><th>事件</th><th>id</th><th>T 入</th><th>T 出</th><th>份额 / 贡献</th></tr></thead><tbody>');
  for (const e of insp.events) {
    let label, detail;
    if (e.type === 'volume-start') {
      label = '<span class="tag vol">体积开始</span>'; detail = '<span class="muted">—</span>';
    } else if (e.type === 'volume-end') {
      label = '<span class="tag vol">体积结束</span>'; detail = '<span class="muted">—</span>';
    } else if (e.type === 'surface') {
      label = '<span class="tag surf">表面</span>';
      detail = `份额 ${f6(e.absorbShare)}<br><span class="mono">${f6(e.contribution[0])} ${f6(e.contribution[1])} ${f6(e.contribution[2])}</span>`;
    } else {
      label = '<span class="tag hold">遮挡</span>';
      detail = '<span class="muted">切断透射，不计 A</span>';
    }
    parts.push('<tr>' +
      `<td>${e.z}</td><td>${label}</td><td>${e.id}</td>` +
      `<td>${f6(e.tIn)}</td><td>${f6(e.tOut)}</td><td>${detail}</td></tr>`);
  }
  parts.push('</tbody></table>');
  els.inspect.innerHTML = parts.join('');
}

/* ---------------- 导出 ---------------- */

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function baseName(s) {
  return (s || 'scene').replace(/\.json$/i, '').replace(/[\\/].*?([^\\/]+)$/, '$1') || 'scene';
}

// 二进制布局：魔数 DIC1 | width u32 | height u32 | 行主序 Float64 LE RGBA（每像素 4 个）
els.exportBin.addEventListener('click', () => {
  if (!state.pack || !state.frame) return;
  const { width: W, height: H } = state.pack;
  const head = new ArrayBuffer(12);
  const dv = new DataView(head);
  new Uint8Array(head).set([0x44, 0x49, 0x43, 0x31]); // "DIC1"
  dv.setUint32(4, W, true);
  dv.setUint32(8, H, true);
  const blob = new Blob([head, state.frame.rgba.buffer],
    { type: 'application/octet-stream' });
  download(blob, `${baseName(state.sourceName)}-${W}x${H}.rgba64`);
});

els.exportJson.addEventListener('click', () => {
  if (!state.pack || !state.frame) return;
  const { width: W, height: H } = state.pack;
  const rgba = state.frame.rgba;
  const pixels = [];
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    if (rgba[o] === 0 && rgba[o + 1] === 0 && rgba[o + 2] === 0 && rgba[o + 3] === 0) continue;
    pixels.push({
      x: p % W, y: Math.floor(p / W),
      rgba: [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]],
    });
  }
  const text = JSON.stringify({
    format: 'linear-premultiplied-rgba-float64',
    width: W, height: H,
    emptyPixel: [0, 0, 0, 0],
    pixels,
  });
  download(new Blob([text], { type: 'application/json' }),
    `${baseName(state.sourceName)}-${W}x${H}.rgba.json`);
});

/* ---------------- 启动：自动载入内置样例，保证首屏可点 ---------------- */
importText(JSON.stringify(window.DIC_DEFAULT_SAMPLE), 'deep-intervals.json（内置样例）');

/* ---------------- 测试钩子（只读，不参与渲染） ---------------- */
window.__DIC_TEST__ = {
  pack: () => state.pack,
  frame: () => state.frame,
  sourceName: () => state.sourceName,
  importText,
  setReadDelay: (ms) => { testHook.readDelayMs = ms; },
};
