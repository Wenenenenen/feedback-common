import { runPipeline } from './skeleton.js';

// ---------- 状态 ----------
const state = {
  gray: null, w: 0, h: 0, fileName: '',
  result: null,          // runPipeline 输出
  selectedEdge: -1,
  scale: 1,
};

const $ = (sel) => document.querySelector(sel);
const views = {};
document.querySelectorAll('canvas[data-view]').forEach((c) => { views[c.dataset.view] = c; });

// ---------- PNG 头校验：8 位灰度、单边 ≤ 512 ----------
function checkPngHeader(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 33 || dv.getUint32(0) !== 0x89504e47 || dv.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG 文件');
  }
  if (dv.getUint32(8) !== 13 || dv.getUint32(12) !== 0x49484452) throw new Error('PNG 缺少 IHDR');
  const w = dv.getUint32(16), h = dv.getUint32(20);
  const bitDepth = dv.getUint8(24), colorType = dv.getUint8(25);
  if (bitDepth !== 8 || colorType !== 0) {
    throw new Error(`仅支持 8 位灰度 PNG（当前 bitDepth=${bitDepth}, colorType=${colorType}）`);
  }
  if (w < 1 || h < 1 || w > 512 || h > 512) {
    throw new Error(`图像尺寸须为 1~512，当前 ${w}×${h}`);
  }
  return { w, h };
}

async function loadImage(file) {
  const buf = await file.arrayBuffer();
  const { w, h } = checkPngHeader(buf);
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = data[i * 4]; // 灰度图 R=G=B
  state.gray = gray; state.w = w; state.h = h; state.fileName = file.name;
  recompute();
}

// ---------- 参数 ----------
function params() {
  return {
    threshold: +$('#threshold').value,
    invert: $('#invert').checked,
    spacing: Math.max(1e-9, +$('#spacing').value || 1),
  };
}

let recomputeTimer = 0;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 80);
}

function recompute() {
  if (!state.gray) return;
  const p = params();
  $('#thresholdVal').textContent = p.threshold;
  state.result = runPipeline(state.gray, state.w, state.h, p);
  state.selectedEdge = -1;
  state.scale = Math.max(1, Math.min(16, Math.floor(420 / Math.max(state.w, state.h))));
  $('#imageInfo').textContent = `${state.fileName} · ${state.w}×${state.h}`;
  updateSummary();
  renderAll();
  renderEdgeList();
  renderEdgeDetail();
  renderColorbar();
  for (const id of ['#exportSkeleton', '#exportRaw', '#exportJson']) $(id).disabled = false;
}

// ---------- 颜色 ----------
function edgeColor(i) { return `hsl(${(i * 67 + 20) % 360} 85% 60%)`; }
function heatColor(t) {
  // 蓝 -> 青 -> 绿 -> 黄 -> 红
  t = Math.min(1, Math.max(0, t));
  const stops = [[40, 40, 160], [0, 190, 220], [30, 200, 90], [240, 220, 40], [230, 50, 30]];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return c;
}
function widthRange() {
  const { widthMap } = state.result;
  let mn = Infinity, mx = 0;
  for (const v of widthMap) if (v > 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn)) { mn = 0; mx = 0; }
  return [mn, mx];
}

// ---------- 绘制 ----------
function baseCanvas(view, drawPixel) {
  const { w, h, scale } = { w: state.w, h: state.h, scale: state.scale };
  const cv = views[view];
  cv.width = w * scale; cv.height = h * scale;
  const ctx = cv.getContext('2d');
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(w, h);
  drawPixel(img.data);
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, cv.width, cv.height);
  return ctx;
}

function drawOverlay(ctx, { nodes = false, edgeIds = false, nodeIds = false, colorEdges = false } = {}) {
  const r = state.result, s = state.scale, unit = $('#unit').value;
  const sel = state.selectedEdge;
  ctx.textBaseline = 'middle';
  // 边
  r.edges.forEach((e, i) => {
    ctx.beginPath();
    e.polyline.forEach(([x, y], k) => {
      const px = (x + 0.5) * s, py = (y + 0.5) * s;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    if (i === sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, s * 0.55);
      ctx.stroke();
      ctx.strokeStyle = '#ff8c42';
      ctx.lineWidth = Math.max(1.2, s * 0.3);
    } else {
      ctx.strokeStyle = colorEdges ? edgeColor(i) : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = Math.max(1, s * 0.22);
    }
    ctx.stroke();
    if (edgeIds) {
      const mid = e.polyline[Math.floor((e.polyline.length - 1) / 2)];
      ctx.font = `bold ${Math.max(10, s * 1.6)}px sans-serif`;
      ctx.fillStyle = i === sel ? '#ff8c42' : edgeColor(i);
      ctx.fillText('E' + e.id, (mid[0] + 0.9) * s, (mid[1] + 0.2) * s);
    }
  });
  // 节点
  if (nodes) {
    r.nodes.forEach((nd) => {
      const [x, y] = nd.position;
      ctx.beginPath();
      ctx.arc((x + 0.5) * s, (y + 0.5) * s, Math.max(2.5, s * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = nd.type === 'branch' ? '#ff5252' : nd.type === 'ring' ? '#c26bff' : '#4dd0e1';
      ctx.fill();
      if (nodeIds) {
        ctx.font = `${Math.max(9, s * 1.3)}px sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('N' + nd.id, (x + 1.1) * s, (y - 0.4) * s);
      }
    });
  }
}

function renderAll() {
  const r = state.result;
  if (!r) return;
  const { binary, skeleton, widthMap } = r;
  const [wMin, wMax] = widthRange();

  // 二值图
  baseCanvas('binary', (d) => {
    for (let i = 0; i < binary.length; i++) {
      const v = binary[i] ? 255 : 0;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  });
  // 骨架（二值暗底 + 骨架高亮 + 节点）
  {
    const ctx = baseCanvas('skeleton', (d) => {
      for (let i = 0; i < binary.length; i++) {
        let v = binary[i] ? 46 : 0;
        if (skeleton[i]) v = 235;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
    });
    drawOverlay(ctx, { nodes: true });
  }
  // 宽度热图
  {
    const ctx = baseCanvas('heatmap', (d) => {
      const span = wMax > wMin ? wMax - wMin : 1;
      for (let i = 0; i < widthMap.length; i++) {
        if (widthMap[i] > 0) {
          const c = heatColor((widthMap[i] - wMin) / span);
          d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2];
        }
        d[i * 4 + 3] = 255;
      }
    });
    drawOverlay(ctx, {});
  }
  // 分支编号
  {
    const ctx = baseCanvas('graph', (d) => {
      for (let i = 0; i < binary.length; i++) {
        const v = binary[i] ? 40 : 0;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
    });
    drawOverlay(ctx, { nodes: true, edgeIds: true, nodeIds: true, colorEdges: true });
  }
}

// ---------- 侧栏 ----------
function fmt(v, d = 3) { return Number(v.toFixed(d)).toString(); }

function updateSummary() {
  const r = state.result, unit = $('#unit').value;
  let skelCount = 0, totalLen = 0;
  for (const v of r.skeleton) skelCount += v;
  for (const e of r.edges) totalLen += e.length;
  $('#summary').textContent =
    `骨架像素 ${skelCount} · 节点 ${r.nodes.length} · 分支 ${r.edges.length} · 总长度 ${fmt(totalLen)} ${unit}`;
}

function renderEdgeList() {
  const r = state.result, unit = $('#unit').value;
  const el = $('#edgeList');
  if (!r.edges.length) { el.textContent = '当前结果无分支'; return; }
  const rows = r.edges.map((e) =>
    `<tr class="edge-row${e.id === state.selectedEdge ? ' selected' : ''}" data-edge="${e.id}">
      <td><span class="swatch" style="background:${edgeColor(e.id)}"></span>E${e.id}</td>
      <td>N${e.nodes[0]}–N${e.nodes[1]}</td>
      <td>${fmt(e.length)}</td>
      <td>${fmt(e.width.mean)}</td>
    </tr>`).join('');
  el.innerHTML = `<table><tr><th>分支</th><th>节点</th><th>长度(${unit})</th><th>均宽(${unit})</th></tr>${rows}</table>`;
  el.querySelectorAll('.edge-row').forEach((tr) =>
    tr.addEventListener('click', () => selectEdge(+tr.dataset.edge)));
}

function renderEdgeDetail() {
  const el = $('#edgeDetail'), unit = $('#unit').value;
  const e = state.result?.edges[state.selectedEdge];
  if (!e) { el.textContent = state.result ? '点击任意视图中的分支查看长度与宽度统计' : '尚未导入图像'; return; }
  el.innerHTML = `<dl>
    <dt>分支</dt><dd>E${e.id}（节点 N${e.nodes[0]} – N${e.nodes[1]}${e.nodes[0] === e.nodes[1] ? '，自环' : ''}）</dd>
    <dt>折线像素</dt><dd>${e.pixel_count}</dd>
    <dt>折线长度</dt><dd>${fmt(e.length)} ${unit}</dd>
    <dt>宽度均值</dt><dd>${fmt(e.width.mean)} ${unit}</dd>
    <dt>宽度最小</dt><dd>${fmt(e.width.min)} ${unit}</dd>
    <dt>宽度最大</dt><dd>${fmt(e.width.max)} ${unit}</dd>
  </dl>`;
}

function renderColorbar() {
  const cv = $('#colorbar'), ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);
  for (let x = 0; x < cv.width; x++) {
    const c = heatColor(x / (cv.width - 1));
    for (let y = 0; y < cv.height; y++) {
      const i = (y * cv.width + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const [mn, mx] = state.result ? widthRange() : [0, 0];
  const unit = $('#unit').value;
  $('#cbMin').textContent = state.result ? `${fmt(mn)} ${unit}` : '–';
  $('#cbMax').textContent = state.result ? `${fmt(mx)} ${unit}` : '–';
}

// ---------- 选取 ----------
function selectEdge(id) {
  state.selectedEdge = id;
  renderAll();
  renderEdgeList();
  renderEdgeDetail();
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onViewClick(ev) {
  if (!state.result) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const px = (ev.clientX - rect.left) / state.scale - 0.5;
  const py = (ev.clientY - rect.top) / state.scale - 0.5;
  let best = -1, bestD = Infinity;
  for (const e of state.result.edges) {
    const pl = e.polyline;
    for (let k = 1; k < pl.length; k++) {
      const d = pointSegDist(px, py, pl[k - 1][0], pl[k - 1][1], pl[k][0], pl[k][1]);
      if (d < bestD) { bestD = d; best = e.id; }
    }
  }
  const tol = Math.max(2, 8 / state.scale);
  selectEdge(bestD <= tol ? best : -1);
}
Object.values(views).forEach((cv) => cv.addEventListener('click', onViewClick));

// ---------- 导出 ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function baseName() { return (state.fileName || 'image').replace(/\.png$/i, ''); }

$('#exportSkeleton').addEventListener('click', () => {
  const { skeleton, width: w, height: h } = state.result;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < skeleton.length; i++) {
    const v = skeleton[i] ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cv.toBlob((b) => download(b, `${baseName()}_skeleton.png`), 'image/png');
});

$('#exportRaw').addEventListener('click', () => {
  // float32 小端，行主序，仅骨架位置写宽度，其余 0
  download(new Blob([state.result.widthMap.buffer], { type: 'application/octet-stream' }),
    `${baseName()}_width_f32_${state.w}x${state.h}.raw`);
});

$('#exportJson').addEventListener('click', () => {
  const r = state.result, p = params();
  const out = {
    image: { file: state.fileName, width: state.w, height: state.h },
    params: { threshold: p.threshold, invert: p.invert, pixel_spacing: p.spacing, unit: $('#unit').value },
    nodes: r.nodes,
    edges: r.edges,
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }),
    `${baseName()}_graph.json`);
});

// ---------- 事件 ----------
$('#fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    await loadImage(file);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
  ev.target.value = '';
});
$('#threshold').addEventListener('input', scheduleRecompute);
$('#invert').addEventListener('change', recompute);
$('#spacing').addEventListener('change', recompute);
$('#unit').addEventListener('change', () => {
  if (!state.result) return;
  updateSummary(); renderEdgeList(); renderEdgeDetail(); renderColorbar();
});
