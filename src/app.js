import { parsePgm } from './pgm.js';
import { readZip } from './zip.js';
import { validateRegion, RegionError } from './validate.js';
import { computeRasterMoments, cellContributions, derivedStats } from './moments.js';
import { computeAsync } from './worker-client.js';
import { cloneRegion, totalVertices, parseRingText, ringToText } from './region.js';
import { buildExport } from './export.js';

const $ = (id) => document.getElementById(id);
const state = {
  image: null,
  region: null,          // last VALID region (kept on invalid edits)
  draft: null,           // region currently shown in the editor (may be invalid)
  result: null,
  selected: { ring: 0, vertex: 0 },
  hoverCell: null,
  zoom: 1,
  sourceName: '',
  computing: false,
};

const SCALE = 16; // 1/16 pixel coordinates

// ---------- rendering: grayscale + coverage overlay ----------
function drawCanvas() {
  const canvas = $('canvas');
  const img = state.image;
  if (!img) return;
  const base = Math.max(img.width, img.height);
  const cssSize = Math.min(640, 40 + base * 7);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssSize + 'px';
  canvas.style.height = cssSize + 'px';
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = cssSize / base; // display pixels per image pixel
  state.view = { cssSize, px, base };

  // grayscale raster (constant gray per pixel, no interpolation)
  const off = document.createElement('canvas');
  off.width = img.width; off.height = img.height;
  const octx = off.getContext('2d');
  const imgData = octx.createImageData(img.width, img.height);
  for (let i = 0; i < img.gray.length; i++) {
    const v = img.gray[i] >> 8; // 16-bit -> 8-bit display
    imgData.data[i * 4] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  octx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cssSize, cssSize);
  ctx.drawImage(off, 0, 0, cssSize, cssSize);

  // coverage heatmap (exact area fraction per cell)
  if (state.result) {
    const heat = document.createElement('canvas');
    heat.width = img.width; heat.height = img.height;
    const hctx = heat.getContext('2d');
    const hd = hctx.createImageData(img.width, img.height);
    for (let i = 0; i < state.result.coverage.length; i++) {
      const a = state.result.coverage[i];
      if (a <= 0) continue;
      hd.data[i * 4] = 56;      // cool blue
      hd.data[i * 4 + 1] = 130;
      hd.data[i * 4 + 2] = 246;
      hd.data[i * 4 + 3] = Math.round(70 + 120 * Math.min(1, a));
    }
    hctx.putImageData(hd, 0, 0);
    ctx.drawImage(heat, 0, 0, cssSize, cssSize);
  }

  // region outline and vertices (coordinates in 1/16 px -> display)
  const region = state.draft || state.region;
  if (region) {
    const toX = (x) => (x / SCALE) * px;
    const toY = (y) => (y / SCALE) * px;
    ctx.lineWidth = 1.5;
    const drawRing = (ring, color) => {
      ctx.beginPath();
      ring.forEach(([x, y], i) => {
        const dx = toX(x), dy = toY(y);
        if (i === 0) ctx.moveTo(dx, dy); else ctx.lineTo(dx, dy);
      });
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    drawRing(region.outer, 'rgba(245, 158, 11, 0.95)');
    (region.holes || []).forEach((h) => drawRing(h, 'rgba(244, 63, 94, 0.95)'));

    // vertices
    const allRings = [region.outer, ...(region.holes || [])];
    allRings.forEach((ring, ri) => {
      ring.forEach(([x, y], vi) => {
        const dx = toX(x), dy = toY(y);
        const sel = state.selected.ring === ri && state.selected.vertex === vi;
        ctx.beginPath();
        ctx.arc(dx, dy, sel ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = sel ? '#fde047' : (ri === 0 ? '#f59e0b' : '#f43f5e');
        ctx.fill();
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    });
  }
}

// ---------- file loading ----------
async function handleFiles(fileList) {
  const files = [...fileList];
  let pgmFile = null, jsonFile = null, zipEntries = null;
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) {
    const buf = new Uint8Array(await zip.arrayBuffer());
    zipEntries = await readZip(buf);
    pgmFile = zipEntries.find((e) => /\.pgm$/i.test(e.name));
    jsonFile = zipEntries.find((e) => /region.*\.json$/i.test(e.name) || /\.json$/i.test(e.name));
    state.sourceName = zip.name;
  } else {
    pgmFile = files.find((f) => /\.pgm$/i.test(f.name));
    jsonFile = files.find((f) => /\.json$/i.test(f.name));
    state.sourceName = pgmFile ? pgmFile.name : '';
  }
  const errors = [];
  if (pgmFile) {
    try {
      const bytes = zipEntries ? pgmFile.data : new Uint8Array(await pgmFile.arrayBuffer());
      state.image = parsePgm(bytes);
    } catch (e) { errors.push('PGM 解析失败：' + e.message); }
  }
  if (jsonFile) {
    try {
      const text = new TextDecoder().decode(zipEntries ? jsonFile.data : await jsonFile.arrayBuffer());
      const region = JSON.parse(text);
      try {
        validateRegion(region);
        state.region = region;
        state.draft = cloneRegion(region);
        state.selected = { ring: 0, vertex: 0 };
      } catch (e) {
        errors.push(...(e.issues || [{ message: e.message }]).map((i) => '测区校验：' + i.message));
      }
    } catch (e) { errors.push('JSON 解析失败：' + e.message); }
  }
  reportErrors(errors);
  if (state.image && state.region) scheduleCompute();
  refreshEditor();
  drawCanvas();
}

function reportErrors(errors) {
  const box = $('errors');
  if (!errors.length) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.innerHTML = errors.map((e) => `<div>${escapeHtml(e)}</div>`).join('');
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- compute ----------
let computeToken = 0;
async function scheduleCompute() {
  if (!state.image || !state.region) return;
  const token = ++computeToken;
  state.computing = true;
  $('status').textContent = '计算中…（精确 BigInt 积分）';
  try {
    const result = await computeAsync(cloneRegion(state.region), state.image);
    if (token !== computeToken) return; // a newer edit superseded this run
    state.result = result;
    renderStats();
    $('status').textContent = `完成：${result.cellCount} 个相交像素格`;
  } catch (e) {
    if (token === computeToken) $('status').textContent = '计算失败：' + e.message;
  } finally {
    if (token === computeToken) state.computing = false;
    drawCanvas();
  }
}

// ---------- stats rendering ----------
const fmt = (f, digits = 10) => `${f.toDecimal(digits)} <span class="frac">${f.toString()}</span>`;

function renderStats() {
  const r = state.result;
  if (!r) return;
  const t = r.totals;
  const rows = [
    ['M00 零阶质量 ∫g', t.M00],
    ['M10 一阶 ∫g·x', t.M10],
    ['M01 一阶 ∫g·y', t.M01],
    ['M20 二阶 ∫g·x²', t.M20],
    ['M02 二阶 ∫g·y²', t.M02],
    ['M11 二阶 ∫g·x·y', t.M11],
  ];
  $('moments').innerHTML = rows.map(([label, v]) =>
    `<tr><th>${label}</th><td>${fmt(v)}</td></tr>`).join('');

  const stats = derivedStats(t);
  if (stats.centroid) {
    $('centroid').innerHTML =
      `<tr><th>重心 x̄</th><td>${fmt(stats.centroid.x)}</td></tr>
       <tr><th>重心 ȳ</th><td>${fmt(stats.centroid.y)}</td></tr>`;
    $('covariance').innerHTML =
      `<tr><th>σ²(x,x)</th><td>${fmt(stats.covariance.xx)}</td></tr>
       <tr><th>σ²(y,y)</th><td>${fmt(stats.covariance.yy)}</td></tr>
       <tr><th>σ²(x,y)</th><td>${fmt(stats.covariance.xy)}</td></tr>`;
  } else {
    $('centroid').innerHTML = '<tr><th>重心</th><td class="null">null（零质量）</td></tr>';
    $('covariance').innerHTML = '<tr><th>协方差</th><td class="null">null（零质量）</td></tr>';
  }
  $('meta').textContent =
    `相交格 ${r.cellCount}（完整 ${r.fullCount}）· 覆盖面积 ${r.coveredArea.toString()} 像素² · 顶点 ${totalVertices(state.region)}/1024`;
}

// ---------- editor ----------
function refreshEditor() {
  const region = state.draft || state.region;
  if (!region) return;
  const ringSel = $('ringSelect');
  const ringCount = 1 + (region.holes || []).length;
  if (ringSel.options.length !== ringCount) {
    ringSel.innerHTML = [['外环', 0], ...(region.holes || []).map((_, i) => [`孔 ${i + 1}`, i + 1])]
      .map(([name, i]) => `<option value="${i}">${name}</option>`).join('');
  }
  ringSel.value = String(state.selected.ring);
  const ring = state.selected.ring === 0 ? region.outer : region.holes[state.selected.ring - 1];
  $('vertexSelect').innerHTML = ring.map((_, i) =>
    `<option value="${i}">顶点 ${i}</option>`).join('');
  $('vertexSelect').value = String(Math.min(state.selected.vertex, ring.length - 1));
  state.selected.vertex = Number($('vertexSelect').value);
  const [vx, vy] = ring[state.selected.vertex];
  $('coordX').value = vx;
  $('coordY').value = vy;
  $('ringText').value = ringToText(ring);
}

function activeRings() {
  const region = state.draft || state.region;
  return [region.outer, ...(region.holes || [])];
}

// Commit an edited draft: validate, keep old region on failure with localization.
function commitDraft(next) {
  try {
    validateRegion(next);
    state.region = next;
    state.draft = cloneRegion(next);
    reportErrors([]);
    scheduleCompute();
  } catch (e) {
    state.draft = next; // show the illegal geometry so the user sees the problem
    const issues = e.issues || [{ message: e.message }];
    reportErrors(issues.map((i) => {
      const where = i.ring ? `[${i.ring}${i.vertex != null ? ' 顶点' + i.vertex : ''}${i.edges ? ' 边' + i.edges.join('/') : ''}] ` : '';
      return '非法修改已定位并保留旧测区：' + where + i.message;
    }));
    $('status').textContent = '校验未通过，仍使用上一个合法测区';
  }
  drawCanvas();
}

function applyCoordEdit() {
  const x = Number($('coordX').value);
  const y = Number($('coordY').value);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    reportErrors(['坐标必须是 1/16 像素整数']);
    return;
  }
  const next = cloneRegion(state.draft || state.region);
  const ring = state.selected.ring === 0 ? next.outer : next.holes[state.selected.ring - 1];
  ring[state.selected.vertex] = [x, y];
  commitDraft(next);
  refreshEditor();
}

function applyRingText() {
  let ring;
  try { ring = parseRingText($('ringText').value); }
  catch (e) { reportErrors([e.message]); return; }
  const next = cloneRegion(state.draft || state.region);
  if (state.selected.ring === 0) next.outer = ring;
  else next.holes[state.selected.ring - 1] = ring;
  state.selected.vertex = 0;
  commitDraft(next);
  refreshEditor();
}

function addVertex() {
  const next = cloneRegion(state.draft || state.region);
  const ring = state.selected.ring === 0 ? next.outer : next.holes[state.selected.ring - 1];
  if (totalVertices(next) >= 1024) { reportErrors(['已达 1024 顶点上限']); return; }
  const [ax, ay] = ring[state.selected.vertex];
  const [bx, by] = ring[(state.selected.vertex + 1) % ring.length];
  ring.splice(state.selected.vertex + 1, 0, [Math.round((ax + bx) / 2), Math.round((ay + by) / 2)]);
  state.selected.vertex += 1;
  commitDraft(next);
  refreshEditor();
}

function deleteVertex() {
  const next = cloneRegion(state.draft || state.region);
  const ring = state.selected.ring === 0 ? next.outer : next.holes[state.selected.ring - 1];
  if (ring.length <= 3) { reportErrors(['每个环至少需要 3 个顶点']); return; }
  ring.splice(state.selected.vertex, 1);
  state.selected.vertex = Math.max(0, state.selected.vertex - 1);
  commitDraft(next);
  refreshEditor();
}

function addHole() {
  const next = cloneRegion(state.draft || state.region);
  if (totalVertices(next) + 4 > 1024) { reportErrors(['已达 1024 顶点上限']); return; }
  // small centered square as a starting hole the user adjusts
  const cx = Math.round((Math.min(...next.outer.map(p => p[0])) + Math.max(...next.outer.map(p => p[0]))) / 2);
  const cy = Math.round((Math.min(...next.outer.map(p => p[1])) + Math.max(...next.outer.map(p => p[1]))) / 2);
  const d = 16;
  next.holes = next.holes || [];
  next.holes.push([[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d]]);
  state.selected = { ring: next.holes.length, vertex: 0 };
  commitDraft(next);
  refreshEditor();
}

// ---------- pointer interaction (drag vertices, inspect cells) ----------
function canvasPoint(evt) {
  const rect = $('canvas').getBoundingClientRect();
  const { px } = state.view;
  const dx = evt.clientX - rect.left;
  const dy = evt.clientY - rect.top;
  return { displayX: dx, displayY: dy, imgX: dx / px, imgY: dy / px };
}

function hitVertex(imgX, imgY) {
  const rings = activeRings();
  const tol = 0.35; // pixels
  let best = null, bestD = tol;
  rings.forEach((ring, ri) => ring.forEach(([x, y], vi) => {
    const d = Math.hypot(x / SCALE - imgX, y / SCALE - imgY);
    if (d < bestD) { bestD = d; best = { ring: ri, vertex: vi }; }
  }));
  return best;
}

let dragging = null;
function onPointerDown(evt) {
  if (!state.image) return;
  const { imgX, imgY } = canvasPoint(evt);
  const hit = hitVertex(imgX, imgY);
  if (hit) {
    dragging = hit;
    state.selected = { ...hit };
    refreshEditor();
    $('canvas').setPointerCapture(evt.pointerId);
  } else {
    inspectCell(imgX, imgY);
  }
}

function onPointerMove(evt) {
  const { imgX, imgY } = canvasPoint(evt);
  if (dragging) {
    const x = Math.round(imgX * SCALE);
    const y = Math.round(imgY * SCALE);
    const next = cloneRegion(state.draft || state.region);
    const ring = dragging.ring === 0 ? next.outer : next.holes[dragging.ring - 1];
    ring[dragging.vertex] = [x, y];
    state.draft = next;
    $('coordX').value = x; $('coordY').value = y;
    drawCanvas();
  } else {
    const c = Math.floor(imgX), r = Math.floor(imgY);
    if (c >= 0 && c < state.image.width && r >= 0 && r < state.image.height) {
      inspectCell(imgX, imgY, true);
    }
  }
}

function onPointerUp(evt) {
  if (dragging) {
    const next = state.draft;
    dragging = null;
    commitDraft(next);
    refreshEditor();
  }
}

function inspectCell(imgX, imgY, hover = false) {
  const c = Math.floor(imgX), r = Math.floor(imgY);
  if (!state.result || c < 0 || c >= state.image.width || r < 0 || r >= state.image.height) return;
  state.hoverCell = { r, c };
  const info = cellContributions(state.result, state.image, r, c);
  const box = $('cellInfo');
  if (!info) {
    box.innerHTML = `<strong>格 (${r}, ${c})</strong>：测区外，交叠分数 0`;
    return;
  }
  const frac = (v) => `${v.toDecimal(8)} <span class="frac">${v.toString()}</span>`;
  box.innerHTML = `
    <strong>格 (${r}, ${c})</strong> · 灰度 ${info.gray} · 交叠分数 <b>${info.area.toString()}</b>
    <table>
      <tr><th>分量</th><th>加权贡献（精确分数）</th></tr>
      ${['M00', 'M10', 'M01', 'M20', 'M02', 'M11'].map((k) =>
        `<tr><th>${k}</th><td>${frac(info.weighted[k])}</td></tr>`).join('')}
    </table>`;
}

// ---------- export ----------
function exportJson() {
  if (!state.result || !state.region) return;
  const doc = buildExport(state.region, state.image, state.result, state.sourceName);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'raster-moments.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wire up ----------
function init() {
  $('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));
  const drop = $('dropZone');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  $('applyCoord').addEventListener('click', applyCoordEdit);
  $('applyRingText').addEventListener('click', applyRingText);
  $('addVertex').addEventListener('click', addVertex);
  $('deleteVertex').addEventListener('click', deleteVertex);
  $('addHole').addEventListener('click', addHole);
  $('exportBtn').addEventListener('click', exportJson);
  $('ringSelect').addEventListener('change', (e) => { state.selected.ring = Number(e.target.value); state.selected.vertex = 0; refreshEditor(); });
  $('vertexSelect').addEventListener('change', (e) => { state.selected.vertex = Number(e.target.value); refreshEditor(); });
  const canvas = $('canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);

  // Load the bundled sample if the server provides it. Fully optional: any
  // failure (404, parse error, blocked fetch) is swallowed so the page starts
  // clean and waits for an explicit upload instead.
  (async () => {
    try {
      const pr = await fetch('samples/extracted/gray.pgm');
      if (!pr.ok) return;
      const buf = await pr.arrayBuffer();
      state.image = parsePgm(new Uint8Array(buf));
      const jr = await fetch('samples/extracted/region.json');
      if (jr.ok) {
        const region = await jr.json();
        validateRegion(region);
        state.region = region; state.draft = cloneRegion(region);
        state.sourceName = 'raster-moments.zip';
        refreshEditor(); scheduleCompute();
      }
      drawCanvas();
    } catch { /* no bundled sample — wait for upload */ }
  })();
}

init();
