/* app.js — 页面逻辑：文件载入、预览、pass 分析、重编码与导出 */
'use strict';

const FILTER_COLORS = ['#94a3b8', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];
const CHANNEL_LABELS = {
  0: ['灰度'], 2: ['R', 'G', 'B'], 3: ['索引'], 6: ['R', 'G', 'B', 'A'],
};

let current = null;      // { dec, name }
let renc = null;         // 重编码结果
let previewScale = 1;
let selectedPixel = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

/* ---------------- 文件载入 ---------------- */
const dz = $('dropzone');
const fileInput = $('file-input');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
  fileInput.value = '';
});

async function handleFile(file) {
  hide($('error-panel'));
  hide($('result'));
  hide($('dl-src-json'));
  current = null; renc = null; selectedPixel = null;

  if (file.size > PNGCore.MAX_FILE_BYTES) {
    showError(new PNGCore.PNGError(
      `文件大小 ${file.size} 字节，超过 20MB 限制`, null));
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const dec = await PNGCore.decode(bytes);
    current = { dec, name: file.name };
    renderAll(dec, file.name);
  } catch (e) {
    showError(e);
  }
}

/* ---------------- 错误展示 ---------------- */
function showError(e) {
  const panel = $('error-panel');
  $('error-message').textContent = e.message || String(e);
  let loc = '';
  if (e.loc) {
    if (e.loc.chunkIndex !== undefined) {
      loc = `位置：块 #${e.loc.chunkIndex}` +
        (e.loc.type ? ` (${e.loc.type})` : '') +
        (e.loc.offset !== undefined ? `，文件偏移 0x${e.loc.offset.toString(16).toUpperCase()}` : '');
    } else if (e.loc.pass !== undefined) {
      loc = `位置：Pass ${e.loc.pass}，第 ${e.loc.row} 行`;
    } else if (e.loc.offset !== undefined) {
      loc = `位置：文件偏移 0x${e.loc.offset.toString(16).toUpperCase()}`;
    }
  }
  $('error-location').textContent = loc;
  // 展示出错前已解析的块，帮助定位
  const box = $('error-chunks');
  if (e.partialChunks && e.partialChunks.length) {
    box.innerHTML = '<p class="hint">出错前已成功解析的块：</p>' +
      chunkTableHTML(e.partialChunks.map((c) => ({
        index: c.index, type: c.type, offset: c.offset, length: c.length, crc: c.crc,
      })));
  } else {
    box.innerHTML = '';
  }
  show(panel);
}

/* ---------------- 成功渲染 ---------------- */
function renderAll(dec, name) {
  renderSummary(dec, name);
  renderChunks(dec);
  renderPreview(dec);
  renderPasses(dec);
  hide($('renc-result'));
  show($('result'));
  show($('dl-src-json'));
}

function renderSummary(dec, name) {
  const ratio = dec.scanlineBytes ? (dec.idatBytes / dec.scanlineBytes * 100) : 0;
  const items = [
    ['文件', name],
    ['尺寸', `${dec.width} × ${dec.height}`],
    ['颜色类型', `${dec.colorType}（${PNGCore.COLOR_TYPE_NAMES[dec.colorType]}）`],
    ['位深', String(dec.depth)],
    ['隔行', dec.interlace ? 'Adam7（7 pass）' : '无'],
    ['文件大小', fmtBytes(dec.fileBytes)],
    ['IDAT 数据', fmtBytes(dec.idatBytes)],
    ['扫描行数据', fmtBytes(dec.scanlineBytes)],
    ['压缩占比', ratio.toFixed(1) + '%'],
  ];
  if (dec.palette) items.push(['调色板', `${dec.palette.length} 色`]);
  if (dec.transparency) items.push(['tRNS', `${dec.transparency.length} 项`]);
  $('summary').innerHTML = items.map(([k, v]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
}

function chunkRowsHTML(chunks) {
  return chunks.map((c) =>
    `<tr><td class="mono">${c.index}</td><td class="mono">${esc(c.type)}</td>` +
    `<td class="mono">0x${c.offset.toString(16).toUpperCase()}</td>` +
    `<td class="mono">${c.length}</td>` +
    `<td class="mono crc-ok">✓ 0x${c.crc.toString(16).toUpperCase().padStart(8, '0')}</td></tr>`).join('');
}

function chunkTableHTML(chunks) {
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>类型</th><th>偏移</th><th>长度</th><th>CRC</th></tr></thead>` +
    `<tbody>${chunkRowsHTML(chunks)}</tbody></table></div>`;
}

function renderChunks(dec) {
  document.querySelector('#chunk-table tbody').innerHTML = chunkRowsHTML(dec.chunks);
}

/* ---------------- 预览与像素点查 ---------------- */
function renderPreview(dec) {
  const rgba = PNGCore.toRGBA8(dec);
  const src = document.createElement('canvas');
  src.width = dec.width; src.height = dec.height;
  src.getContext('2d').putImageData(new ImageData(rgba, dec.width, dec.height), 0, 0);

  previewScale = Math.max(1, Math.min(32,
    Math.floor(560 / dec.width) || 1, Math.floor(420 / dec.height) || 1));
  const cv = $('preview');
  cv.width = dec.width * previewScale;
  cv.height = dec.height * previewScale;
  drawPreview(cv, src);
  cv._src = src;
  $('pixel-info').textContent = '未选择像素';
}

function drawPreview(cv, src) {
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  if (selectedPixel) {
    const { x, y } = selectedPixel;
    ctx.save();
    ctx.strokeStyle = '#ff2d55';
    ctx.lineWidth = Math.max(1, previewScale >> 3);
    ctx.strokeRect(x * previewScale, y * previewScale, previewScale, previewScale);
    ctx.restore();
  }
}

$('preview').addEventListener('click', (e) => {
  if (!current) return;
  const cv = $('preview');
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * current.dec.width);
  const y = Math.floor((e.clientY - r.top) / r.height * current.dec.height);
  if (x < 0 || y < 0 || x >= current.dec.width || y >= current.dec.height) return;
  selectedPixel = { x, y };
  drawPreview(cv, cv._src);
  showPixelInfo(current.dec, x, y);
});

function showPixelInfo(dec, x, y) {
  const p = PNGCore.pixelAt(dec, x, y);
  const labels = CHANNEL_LABELS[dec.colorType];
  const parts = p.values.map((v, i) => `${labels[i]}=${v}`);
  const lines = [];
  lines.push(`(${x}, ${y})  原始样本：${parts.join('  ')}`);
  lines.push(`位深 ${dec.depth}（范围 0..${p.maxValue}）`);
  const pxOff = (y * dec.width + x) * dec.channels;
  const rgba = PNGCore.toRGBA8({
    ...dec, width: 1, height: 1,
    samples: dec.samples.slice(pxOff, pxOff + dec.channels),
  });
  let note = '';
  if (dec.colorType === 3) {
    const rgb = p.paletteRGB || [0, 0, 0];
    lines.push(`调色板[${p.paletteIndex}] = RGB(${rgb.join(', ')})`);
    lines.push(`Alpha = ${p.alpha}` +
      (dec.transparency && p.paletteIndex >= dec.transparency.length ? '（tRNS 未提供，默认 255）' : ''));
  } else {
    lines.push(`Alpha = ${p.alpha}` +
      (dec.transparency && p.alpha === 0 ? '（tRNS 透明色键命中）' : ''));
  }
  lines.push(`预览 RGBA8 = (${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})`);
  $('pixel-info').innerHTML =
    `<span class="swatch" style="background:rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})"></span>` +
    esc(lines.join('\n')) + esc(note);
}

/* ---------------- Pass 分析 ---------------- */
function legendHTML() {
  return PNGCore.FILTER_NAMES.map((n, i) =>
    `<span class="chip"><span class="box" style="background:${FILTER_COLORS[i]}"></span>${i} ${n}</span>`).join('');
}

async function renderPasses(dec) {
  $('filter-legend').innerHTML = legendHTML();
  const list = $('pass-list');
  list.innerHTML = '';

  // 每个 pass 的过滤后扫描流单独 deflate，估算压缩占比
  const active = dec.passes.filter((p) => p.streamLength > 0);
  const estSizes = await Promise.all(active.map((p) =>
    PNGCore.deflate(dec.scanStream.subarray(p.streamOffset, p.streamOffset + p.streamLength))
      .then((b) => b.length)));
  const estTotal = estSizes.reduce((a, b) => a + b, 0) || 1;

  dec.passes.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'pass';
    if (p.w === 0 || p.h === 0) {
      div.innerHTML = `<div class="pass-head"><span class="title">Pass ${p.index}</span>` +
        `<span class="dim">空 pass（不占字节）</span></div>`;
      list.appendChild(div);
      return;
    }
    const ai = active.indexOf(p);
    const share = (estSizes[ai] / estTotal * 100).toFixed(1);
    const hist = [0, 0, 0, 0, 0];
    p.rows.forEach((r) => hist[r.filter]++);
    const histText = hist.map((n, f) => n ? `${f}:${n}` : null).filter(Boolean).join('  ');
    div.innerHTML =
      `<div class="pass-head">` +
      `<span class="title">Pass ${p.index}</span>` +
      `<span class="dim">${p.w} × ${p.h}</span>` +
      `<span class="hist">${p.rows.length} 行 · ${p.streamLength} 字节 · 过滤分布 ${histText}</span>` +
      `<span class="grow"></span>` +
      `<span class="share">压缩占比 ≈ ${share}%</span>` +
      `</div>` +
      `<canvas class="strip" width="${p.rows.length}" height="16"></canvas>` +
      `<div class="strip-readout"></div>`;
    list.appendChild(div);

    const strip = div.querySelector('.strip');
    const ctx = strip.getContext('2d');
    p.rows.forEach((r, x) => {
      ctx.fillStyle = FILTER_COLORS[r.filter];
      ctx.fillRect(x, 0, 1, 16);
    });
    const readout = div.querySelector('.strip-readout');
    strip.addEventListener('mousemove', (e) => {
      const r = strip.getBoundingClientRect();
      const ri = Math.floor((e.clientX - r.left) / r.width * p.rows.length);
      const row = p.rows[ri];
      if (row) {
        readout.textContent = `行 ${row.row}：过滤 ${row.filter} (${PNGCore.FILTER_NAMES[row.filter]}) · ${row.bytes} 字节`;
      }
    });
    strip.addEventListener('mouseleave', () => { readout.textContent = ''; });
  });
}

/* ---------------- 重编码 ---------------- */
$('renc-btn').addEventListener('click', async () => {
  if (!current) return;
  const modeRaw = $('filter-mode').value;
  const mode = modeRaw === 'auto' ? 'auto' : parseInt(modeRaw, 10);
  renc = await PNGCore.encode(current.dec, mode);
  renc.mode = mode;

  const dec = current.dec;
  const delta = renc.fileBytes - dec.fileBytes;
  const deltaCls = delta > 0 ? 'delta-up' : 'delta-down';
  const stats = [
    ['过滤器', mode === 'auto' ? '自动择优' : `${mode} (${PNGCore.FILTER_NAMES[mode]})`],
    ['输出文件', fmtBytes(renc.fileBytes)],
    ['IDAT 数据', fmtBytes(renc.idatBytes)],
    ['扫描行数据', fmtBytes(renc.scanlineBytes)],
    ['对比原文件', `<span class="${deltaCls}">${delta > 0 ? '+' : delta < 0 ? '-' : '±'}${fmtBytes(Math.abs(delta))}</span>`],
  ];
  $('renc-stats').innerHTML = stats.map(([k, v]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('');

  $('renc-legend').innerHTML = legendHTML();
  const strip = $('renc-strip');
  strip.width = renc.rows.length;
  strip.height = 16;
  const ctx = strip.getContext('2d');
  renc.rows.forEach((r, x) => {
    ctx.fillStyle = FILTER_COLORS[r.filter];
    ctx.fillRect(x, 0, 1, 16);
  });
  show($('renc-result'));
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function baseName() {
  return (current ? current.name : 'image').replace(/\.png$/i, '');
}

$('dl-png').addEventListener('click', () => {
  if (!renc) return;
  download(new Blob([renc.bytes], { type: 'image/png' }),
    `${baseName()}.reenc-${renc.mode === 'auto' ? 'auto' : 'f' + renc.mode}.png`);
});

$('dl-json').addEventListener('click', () => {
  if (!renc || !current) return;
  const dec = current.dec;
  const rec = {
    source_file: current.name,
    filter_mode: renc.mode === 'auto' ? 'auto' : renc.mode,
    width: dec.width, height: dec.height,
    depth: dec.depth, color_type: dec.colorType, interlace: 0,
    rows: renc.rows,
    scanline_bytes: renc.scanlineBytes,
    idat_bytes: renc.idatBytes,
    file_bytes: renc.fileBytes,
  };
  download(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }),
    `${baseName()}.reenc-filters.json`);
});

$('dl-src-json').addEventListener('click', () => {
  if (!current) return;
  const dec = current.dec;
  const rec = {
    source_file: current.name,
    width: dec.width, height: dec.height,
    depth: dec.depth, color_type: dec.colorType, interlace: dec.interlace,
    rows: dec.rows,
    scanline_bytes: dec.scanlineBytes,
    idat_bytes: dec.idatBytes,
    file_bytes: dec.fileBytes,
  };
  download(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }),
    `${baseName()}.src-filters.json`);
});

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
