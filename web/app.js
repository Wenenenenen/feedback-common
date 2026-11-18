/* HiZ 保守遮挡校验台 —— 全部算法在本文件内实现，不依赖任何现成剔除器 */
'use strict';
const $ = id => document.getElementById(id);
const EPS_W = 1e-9, EPS_D = 1e-6;

/* ---------------- 状态 ---------------- */
const S = {
  name: '',
  W: 0, H: 0, mode: 'standard',
  depth: null,          // Float64Array，可被孔洞编辑
  originalDepth: null,  // 导入时的原始深度，擦除孔洞用
  holes: new Set(),     // 被绘制成清屏值的叶像素索引
  M: null,              // 行主序 4x4
  boxes: [],            // {id,min:[...],max:[...]}
  pyramid: [],          // [{w,h,data:Float64Array}]
  results: new Map(),   // id -> result
  selectedId: null,
  level: 0,
  tool: 'inspect',
  painting: false,
  stats: { pyr: 0, exh: 0, occluded: 0, visible: 0, outside: 0, mismatch: 0 },
};

/* ---------------- 数学工具 ---------------- */
const isFin = v => typeof v === 'number' && Number.isFinite(v);
function mat4Det(m) {
  const a = [m.slice(0, 4), m.slice(4, 8), m.slice(8, 12), m.slice(12, 16)];
  const d3 = b => b[0][0] * (b[1][1] * b[2][2] - b[1][2] * b[2][1])
    - b[0][1] * (b[1][0] * b[2][2] - b[1][2] * b[2][0])
    + b[0][2] * (b[1][0] * b[2][1] - b[1][1] * b[2][0]);
  let s = 0;
  for (let c = 0; c < 4; c++) {
    const minor = [a[1].slice(0, c).concat(a[1].slice(c + 1)),
                   a[2].slice(0, c).concat(a[2].slice(c + 1)),
                   a[3].slice(0, c).concat(a[3].slice(c + 1))];
    s += (c % 2 ? -1 : 1) * a[0][c] * d3(minor);
  }
  return s;
}
function mulMat(M, p) {
  const [x, y, z] = p;
  return [M[0] * x + M[1] * y + M[2] * z + M[3],
          M[4] * x + M[5] * y + M[6] * z + M[7],
          M[8] * x + M[9] * y + M[10] * z + M[11],
          M[12] * x + M[13] * y + M[14] * z + M[15]];
}
function boxCorners(b) {
  const [lo, hi] = [b.min, b.max];
  const out = [];
  for (let sz = 0; sz < 2; sz++) for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++)
    out.push([sx ? hi[0] : lo[0], sy ? hi[1] : lo[1], sz ? hi[2] : lo[2]]);
  return out;
}

/* ---------------- 输入校验 ---------------- */
function validateInput(d) {
  const e = [];
  if (!d || typeof d !== 'object') return ['输入不是 JSON 对象'];
  const { width: W, height: H } = d;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) e.push('width/height 必须为正整数');
  else if (W > 513 || H > 385) e.push(`尺寸 ${W}×${H} 超过 513×385 上限`);
  if (!Array.isArray(d.depth)) e.push('depth 必须是数组');
  else if (Number.isInteger(W) && Number.isInteger(H) && d.depth.length !== W * H)
    e.push(`深度数量 ${d.depth.length} 与 ${W}×${H}=${W * H} 不符`);
  else {
    for (let i = 0; i < d.depth.length; i++) {
      const v = d.depth[i];
      if (!isFin(v)) { e.push(`depth[${i}] 不是有限数`); break; }
      if (v < 0 || v > 1) { e.push(`depth[${i}] = ${v} 超出 [0,1]`); break; }
    }
  }
  if (d.mode !== 'standard' && d.mode !== 'reversed') e.push('mode 必须是 standard 或 reversed');
  if (!Array.isArray(d.view_projection) || d.view_projection.length !== 16)
    e.push('view_projection 必须是 16 个数（行主序 4×4）');
  else if (d.view_projection.some(v => !isFin(v))) e.push('view_projection 含非有限数');
  else if (Math.abs(mat4Det(d.view_projection)) < 1e-12) e.push('view_projection 奇异（行列式≈0）');
  if (!Array.isArray(d.boxes)) e.push('boxes 必须是数组');
  else {
    if (d.boxes.length > 2000) e.push(`boxes 数量 ${d.boxes.length} 超过 2000 上限`);
    d.boxes.forEach((b, j) => {
      if (!b || !Array.isArray(b.min) || !Array.isArray(b.max) || b.min.length !== 3 || b.max.length !== 3)
        e.push(`boxes[${j}] 缺少长度为 3 的 min/max`);
      else if (b.min.some(v => !isFin(v)) || b.max.some(v => !isFin(v)))
        e.push(`boxes[${j}]（id=${b.id}）含非有限数`);
      else if (b.min.some((v, k) => v > b.max[k]))
        e.push(`boxes[${j}]（id=${b.id}）min 分量大于 max`);
    });
  }
  return e;
}

/* ---------------- 深度金字塔 ---------------- */
function buildPyramid(depth, W, H, mode) {
  const levels = [{ w: W, h: H, data: depth.slice() }];
  let w = W, h = H, cur = depth;
  while (w > 1 || h > 1) {
    const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
    const nxt = new Float64Array(nw * nh);
    for (let ny = 0; ny < nh; ny++) for (let nx = 0; nx < nw; nx++) {
      let acc = mode === 'standard' ? -Infinity : Infinity;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const cx = 2 * nx + dx, cy = 2 * ny + dy;
        if (cx < w && cy < h) {
          const v = cur[cy * w + cx];
          acc = mode === 'standard' ? Math.max(acc, v) : Math.min(acc, v);
        }
      }
      nxt[ny * nw + nx] = acc;
    }
    levels.push({ w: nw, h: nh, data: nxt });
    w = nw; h = nh; cur = nxt;
  }
  return levels;
}

/* 节点在叶像素上的覆盖范围（底向上对齐，奇数尺寸关键） */
function nodeCover(levels, L, nx, ny) {
  let x0 = nx, y0 = ny, x1 = nx + 1, y1 = ny + 1;
  for (let k = L; k > 0; k--) {
    const lw = levels[k - 1].w, lh = levels[k - 1].h;
    x0 *= 2; y0 *= 2;
    x1 = Math.min(2 * x1, lw); y1 = Math.min(2 * y1, lh);
  }
  return [x0, y0, x1, y1];
}

/* 金字塔精确分解查询：完全包含即消费，边界下降到叶 */
function queryPyramid(levels, x0, y0, x1, y1, mode) {
  const visited = [];
  const usedVals = [];
  const top = levels.length - 1;
  const recurse = (L, nx, ny) => {
    const { w, data } = levels[L];
    const [cx0, cy0, cx1, cy1] = nodeCover(levels, L, nx, ny);
    if (cx1 <= x0 || cx0 >= x1 || cy1 <= y0 || cy0 >= y1) return;
    const value = data[ny * w + nx];
    const full = cx0 >= x0 && cx1 <= x1 && cy0 >= y0 && cy1 <= y1;
    const used = full || L === 0;
    visited.push({ level: L, x: nx, y: ny, value, used });
    if (used) { usedVals.push(value); return; }
    const cw = levels[L - 1].w, ch = levels[L - 1].h;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const cnx = 2 * nx + dx, cny = 2 * ny + dy;
      if (cnx < cw && cny < ch) recurse(L - 1, cnx, cny);
    }
  };
  recurse(top, 0, 0);
  const agg = mode === 'standard' ? Math.max(...usedVals) : Math.min(...usedVals);
  return { agg, visited };
}

/* 逐像素穷举对照（独立实现，不参与金字塔判定） */
function queryExhaustive(depth, W, x0, y0, x1, y1, mode) {
  let acc = mode === 'standard' ? -Infinity : Infinity, count = 0;
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
    const v = depth[py * W + px];
    acc = mode === 'standard' ? Math.max(acc, v) : Math.min(acc, v);
    count++;
  }
  return { value: acc, count };
}

/* ---------------- 单盒剔除管线 ---------------- */
const PLANE_NAMES = ['左 x<-w', '右 x>w', '下 y<-w', '上 y>w', '近面', '远面 z>w'];
function cullBox(b) {
  const { W, H, mode, M, depth, pyramid } = S;
  const corners = boxCorners(b).map(p => mulMat(M, p));
  const r = { id: b.id, status: null, reason: '', rect: null, nearDepth: null,
              pyramidValue: null, exhaustiveValue: null, match: null,
              visits: 0, pixels: 0, visited: [], ndcCorners: null, clipCorners: corners };

  /* 1) 相机内部/后方保护：任一角 w<=1e-9，直接 visible 不查深度 */
  if (corners.some(c => c[3] <= EPS_W)) {
    r.status = 'visible';
    r.reason = '存在 w≤1e-9 的角点（相机内部或后方），按规则 visible，不查询深度';
    return r;
  }
  /* 2) 近裁面跨越：角点同时分布在近面两侧 */
  let cross = false, nearCond = '';
  if (mode === 'standard') {
    const inside = corners.filter(c => c[2] >= 0).length, outsideN = corners.filter(c => c[2] < 0).length;
    cross = inside > 0 && outsideN > 0; nearCond = '标准近面 z=0（同时存在 z<0 与 z≥0 角点）';
  } else {
    const inside = corners.filter(c => c[2] <= c[3]).length, outsideN = corners.filter(c => c[2] > c[3]).length;
    cross = inside > 0 && outsideN > 0; nearCond = '反向近面 z=w（同时存在 z>w 与 z≤w 角点）';
  }
  if (cross) {
    r.status = 'visible';
    r.reason = `跨越近裁面：${nearCond}，按规则 visible，不查询深度`;
    return r;
  }
  /* 3) 完全同侧 outside（此时角点 w 全正、且都在近面内侧） */
  const counts = [0, 0, 0, 0, 0, 0];
  for (const [x, y, z, w] of corners) {
    if (x < -w) counts[0]++; if (x > w) counts[1]++;
    if (y < -w) counts[2]++; if (y > w) counts[3]++;
    if (z < 0) counts[4]++; if (z > w) counts[5]++;
  }
  const planeIdx = counts.findIndex(c => c === 8);
  if (planeIdx >= 0) {
    r.status = 'outside';
    r.reason = `八个角点全部位于同一裁面外：${PLANE_NAMES[planeIdx]}`;
    return r;
  }
  /* 4) 透视除法与保守投影矩形 */
  const ndc = corners.map(([x, y, z, w]) => [x / w, y / w, z / w]);
  r.ndcCorners = ndc;
  const pxs = ndc.map(n => (n[0] + 1) * W / 2);
  const pys = ndc.map(n => (1 - n[1]) * H / 2);
  const rx0 = Math.floor(Math.min(...pxs)), rx1 = Math.ceil(Math.max(...pxs));
  const ry0 = Math.floor(Math.min(...pys)), ry1 = Math.ceil(Math.max(...pys));
  const x0 = Math.max(0, rx0), y0 = Math.max(0, ry0);
  const x1 = Math.min(W, rx1), y1 = Math.min(H, ry1);
  r.rect = [x0, y0, x1, y1];
  r.nearDepth = mode === 'standard'
    ? Math.min(...ndc.map(n => n[2])) : Math.max(...ndc.map(n => n[2]));
  if (x1 <= x0 || y1 <= y0) {
    r.status = 'visible';
    r.reason = '保守投影矩形裁剪到图像范围后为空，保留 visible';
    return r;
  }
  /* 5) 金字塔查询 + 穷举对照 */
  const q = queryPyramid(pyramid, x0, y0, x1, y1, mode);
  const ex = queryExhaustive(depth, W, x0, y0, x1, y1, mode);
  r.pyramidValue = q.agg; r.exhaustiveValue = ex.value;
  r.visited = q.visited; r.visits = q.visited.length; r.pixels = ex.count;
  r.match = q.agg === ex.value;
  const redName = mode === 'standard' ? 'max' : 'min';
  if (mode === 'standard') {
    const occ = r.nearDepth > q.agg + EPS_D;
    r.status = occ ? 'occluded' : 'visible';
    r.reason = occ
      ? `near_depth ${fmt(r.nearDepth)} > 矩形 max(depth) ${fmt(q.agg)} + 1e-6 → occluded`
      : `near_depth ${fmt(r.nearDepth)} ≤ max(depth) ${fmt(q.agg)} + 1e-6（等深/更近保留 visible）`;
  } else {
    const occ = r.nearDepth < q.agg - EPS_D;
    r.status = occ ? 'occluded' : 'visible';
    r.reason = occ
      ? `near_depth ${fmt(r.nearDepth)} < 矩形 min(depth) ${fmt(q.agg)} − 1e-6 → occluded`
      : `near_depth ${fmt(r.nearDepth)} ≥ min(depth) ${fmt(q.agg)} − 1e-6（等深/更近保留 visible）`;
  }
  return r;
}
const fmt = v => (v === null || v === undefined) ? '—' : Number(v).toFixed(4);

/* ---------------- 全量运行 ---------------- */
function runAll() {
  S.pyramid = buildPyramid(S.depth, S.W, S.H, S.mode);
  S.results.clear();
  const st = { pyr: 0, exh: 0, occluded: 0, visible: 0, outside: 0, mismatch: 0 };
  for (const b of S.boxes) {
    const r = cullBox(b);
    S.results.set(b.id, r);
    st[r.status]++;
    st.pyr += r.visits; st.exh += r.pixels;
    if (r.match === false) st.mismatch++;
  }
  S.stats = st;
  if (S.level >= S.pyramid.length) S.level = S.pyramid.length - 1;
}

/* ---------------- 加载 ---------------- */
function loadDataset(d, name) {
  const errs = validateInput(d);
  showInputMsg(errs, d);
  if (errs.length) return false;
  S.name = name;
  S.W = d.width; S.H = d.height; S.mode = d.mode;
  S.depth = Float64Array.from(d.depth);
  S.originalDepth = Float64Array.from(d.depth);
  S.holes = new Set();
  S.M = d.view_projection.slice();
  S.boxes = d.boxes.map(b => ({ id: String(b.id), min: b.min.slice(), max: b.max.slice() }));
  S.selectedId = null; S.level = 0;
  runAll();
  $('datasetName').textContent = `${name} · ${S.W}×${S.H} · ${S.mode} · ${S.boxes.length} 盒`;
  renderAll();
  return true;
}
function showInputMsg(errs, d) {
  const el = $('inputMsg');
  if (!errs.length) { el.innerHTML = '<div class="msg ok">输入校验通过，已构建 ' +
    `${d.width}×${d.height} 深度金字塔（${d.mode}，清屏值 ${d.mode === 'standard' ? 1 : 0}）</div>`; return; }
  el.innerHTML = `<div class="msg ok" style="border-color:var(--bad);background:rgba(240,108,122,.1);color:var(--bad)">
    <b>输入校验失败（${errs.length} 项），未加载：</b><ul>${errs.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
}

/* ---------------- 画布渲染 ---------------- */
const canvas = $('pyrCanvas'), ctx = canvas.getContext('2d');
function heatColor(v) {
  // 深蓝 -> 青 -> 暖黄 的深度梯度
  const stops = [[27, 42, 74], [46, 143, 158], [232, 196, 90]];
  const t = Math.max(0, Math.min(1, v));
  const i = t < 0.5 ? 0 : 1, f = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const a = stops[i], c = stops[i + 1];
  return `rgb(${Math.round(a[0] + (c[0] - a[0]) * f)},${Math.round(a[1] + (c[1] - a[1]) * f)},${Math.round(a[2] + (c[2] - a[2]) * f)})`;
}
function renderCanvas() {
  if (!S.pyramid.length) return;
  const lvl = S.pyramid[S.level];
  const wrapW = $('canvasWrap').clientWidth || 600;
  const cell = Math.max(2, Math.min(64, Math.floor(wrapW / lvl.w)));
  canvas.width = lvl.w * cell; canvas.height = lvl.h * cell;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < lvl.h; y++) for (let x = 0; x < lvl.w; x++) {
    ctx.fillStyle = heatColor(lvl.data[y * lvl.w + x]);
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  // 网格（大单元格时）
  if (cell >= 10) {
    ctx.strokeStyle = 'rgba(127,140,160,.25)'; ctx.lineWidth = 1;
    for (let x = 0; x <= lvl.w; x++) { ctx.beginPath(); ctx.moveTo(x * cell + .5, 0); ctx.lineTo(x * cell + .5, canvas.height); ctx.stroke(); }
    for (let y = 0; y <= lvl.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * cell + .5); ctx.lineTo(canvas.width, y * cell + .5); ctx.stroke(); }
  }
  const sel = S.selectedId !== null ? S.results.get(S.selectedId) : null;
  const toX = lx => lx / S.W * canvas.width;
  const toY = ly => ly / S.H * canvas.height;
  // 孔洞红框（叶像素 -> 缩放到当前层）
  if (S.holes.size) {
    ctx.strokeStyle = getCss('--bad'); ctx.lineWidth = Math.max(1, cell / 6);
    for (const idx of S.holes) {
      const px = idx % S.W, py = Math.floor(idx / S.W);
      ctx.strokeRect(toX(px) + 1, toY(py) + 1, canvas.width / S.W - 2, canvas.height / S.H - 2);
    }
  }
  if (sel && sel.rect) {
    // 访问节点：当前层上的节点按叶覆盖绘制
    for (const n of sel.visited) {
      if (n.level !== S.level) continue;
      const [cx0, cy0, cx1, cy1] = nodeCover(S.pyramid, n.level, n.x, n.y);
      ctx.fillStyle = n.used ? 'rgba(180,140,240,.38)' : 'rgba(61,215,198,.28)';
      ctx.fillRect(toX(cx0), toY(cy0), toX(cx1) - toX(cx0), toY(cy1) - toY(cy0));
      ctx.strokeStyle = n.used ? getCss('--violet') : getCss('--accent');
      ctx.lineWidth = 1;
      ctx.strokeRect(toX(cx0) + .5, toY(cy0) + .5, toX(cx1) - toX(cx0) - 1, toY(cy1) - toY(cy0) - 1);
    }
    // 投影矩形
    const [x0, y0, x1, y1] = sel.rect;
    ctx.strokeStyle = getCss('--warn'); ctx.lineWidth = 2;
    ctx.strokeRect(toX(x0) + 1, toY(y0) + 1, toX(x1) - toX(x0) - 2, toY(y1) - toY(y0) - 2);
  }
  $('pyrMeta').textContent = `Level ${S.level}：${lvl.w}×${lvl.h} 节点 · 单元格 ${cell}px · ` +
    `归约方式：${S.mode === 'standard' ? 'max（普通深度）' : 'min（反向深度）'} · 孔洞 ${S.holes.size} 个`;
}
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* 画布坐标 -> 叶像素 */
function eventToLeaf(ev) {
  const rc = canvas.getBoundingClientRect();
  const lx = Math.floor((ev.clientX - rc.left) / rc.width * S.W);
  const ly = Math.floor((ev.clientY - rc.top) / rc.height * S.H);
  return [Math.max(0, Math.min(S.W - 1, lx)), Math.max(0, Math.min(S.H - 1, ly))];
}
function paintAt(lx, ly) {
  const clear = S.mode === 'standard' ? 1 : 0;
  if (S.tool === 'paint') {
    const idx = ly * S.W + lx;
    S.depth[idx] = clear; S.holes.add(idx);
  } else if (S.tool === 'erase') {
    const idx = ly * S.W + lx;
    if (S.holes.delete(idx)) S.depth[idx] = S.originalDepth[idx];
  }
}
canvas.addEventListener('mousedown', ev => {
  if (!S.pyramid.length) return;
  const [lx, ly] = eventToLeaf(ev);
  if (S.tool === 'inspect') { selectBoxAt(lx, ly); return; }
  S.painting = true; paintAt(lx, ly); renderCanvas();
});
window.addEventListener('mousemove', ev => {
  if (!S.pyramid.length) return;
  if (S.painting) { const [lx, ly] = eventToLeaf(ev); paintAt(lx, ly); renderCanvas(); }
  else if (ev.target === canvas) {
    const [lx, ly] = eventToLeaf(ev);
    const v = S.depth[ly * S.W + lx];
    $('hoverInfo').textContent = `叶像素 (${lx}, ${ly}) depth=${fmt(v)}${S.holes.has(ly * S.W + lx) ? ' · 孔洞' : ''}`;
  }
});
window.addEventListener('mouseup', () => {
  if (S.painting) { S.painting = false; runAll(); renderAll(); toast('孔洞已写入，金字塔与全部盒判定已重算'); }
});
function selectBoxAt(lx, ly) {
  let best = null, bestArea = Infinity;
  for (const b of S.boxes) {
    const r = S.results.get(b.id);
    if (!r.rect) continue;
    const [x0, y0, x1, y1] = r.rect;
    if (lx >= x0 && lx < x1 && ly >= y0 && ly < y1) {
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) { best = b.id; bestArea = area; }
    }
  }
  if (best !== null) { S.selectedId = best; renderAll(); }
}

/* ---------------- 列表与详情 ---------------- */
function renderTable() {
  const fId = $('boxFilter').value.trim().toLowerCase();
  const fV = $('verdictFilter').value;
  const rows = S.boxes.filter(b =>
    (!fId || String(b.id).toLowerCase().includes(fId)) && (!fV || S.results.get(b.id).status === fV));
  const cap = 400, shown = rows.slice(0, cap);
  $('boxTbody').innerHTML = shown.map(b => {
    const r = S.results.get(b.id);
    return `<tr data-id="${escapeHtml(b.id)}" class="${b.id === S.selectedId ? 'selected' : ''}">
      <td>${escapeHtml(b.id)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td class="num">${fmt(r.nearDepth)}</td>
      <td class="num">${fmt(r.pyramidValue)}</td>
      <td class="num">${fmt(r.exhaustiveValue)}</td>
      <td class="num">${r.visits || '—'}</td>
      <td class="num">${r.pixels || '—'}</td>
      <td class="muted" style="white-space:normal;max-width:260px">${escapeHtml(r.reason)}</td></tr>`;
  }).join('');
  const note = $('rowCapNote');
  note.textContent = rows.length > cap ? `仅显示前 ${cap} 行，共 ${rows.length} 行匹配；用 id/判定过滤缩小范围` : `共 ${rows.length} 行`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderDetail() {
  const el = $('boxDetail');
  const b = S.boxes.find(x => x.id === S.selectedId);
  if (!b) { el.innerHTML = '<div class="muted">在左侧列表或画布投影上选择一个盒</div>'; $('editCard').hidden = true; $('traceBox').innerHTML = '<div class="muted" style="padding:10px">深度查询发生后显示访问的 level/x/y/value</div>'; $('traceCount').textContent = ''; return; }
  const r = S.results.get(b.id);
  $('editCard').hidden = false;
  ['minX', 'minY', 'minZ'].forEach((id, k) => $(id).value = b.min[k]);
  ['maxX', 'maxY', 'maxZ'].forEach((id, k) => $(id).value = b.max[k]);
  const rectTxt = r.rect ? `[${r.rect.join(', ')}]（叶像素，半开区间）` : '—（未产生投影）';
  const ndcTxt = r.ndcCorners ? r.ndcCorners.map(n => `(${n.map(v => v.toFixed(3)).join(', ')})`).join('<br>') : '—';
  el.innerHTML = `
    <div class="reason-box ${r.status}" style="margin-bottom:10px"><b style="text-transform:uppercase;font-size:11px">${r.status}</b><br>${escapeHtml(r.reason)}</div>
    <dl class="kv">
      <dt>盒 id</dt><dd>${escapeHtml(b.id)}</dd>
      <dt>AABB min</dt><dd>[${b.min.map(fmt).join(', ')}]</dd>
      <dt>AABB max</dt><dd>[${b.max.map(fmt).join(', ')}]</dd>
      <dt>投影矩形</dt><dd>${rectTxt}</dd>
      <dt>最近深度</dt><dd>${fmt(r.nearDepth)}（${S.mode === 'standard' ? '八角 z/w 最小值' : '八角 z/w 最大值'}）</dd>
      <dt>金字塔聚合</dt><dd>${fmt(r.pyramidValue)}（${S.mode === 'standard' ? 'max' : 'min'}，访问 ${r.visits} 节点）</dd>
      <dt>穷举对照</dt><dd>${fmt(r.exhaustiveValue)}（${r.pixels} 像素）${r.match === true ? ' · <span style="color:var(--ok)">一致 ✓</span>' : r.match === false ? ' · <span style="color:var(--bad)">不一致 ✗</span>' : ''}</dd>
    </dl>
    <div style="margin-top:10px"><div class="muted" style="font-size:11px;margin-bottom:4px">八角 NDC (x,y,z)</div><div class="mono-block">${ndcTxt}</div></div>`;
  // 轨迹
  $('traceCount').textContent = r.visited.length ? `${r.visited.length} 个节点 / 对照 ${r.pixels} 像素` : '';
  if (!r.visited.length) {
    $('traceBox').innerHTML = '<div class="muted" style="padding:10px">该盒未发生深度查询（outside / 近裁面保护 / 空矩形）</div>';
  } else {
    $('traceBox').innerHTML = r.visited.map(n =>
      `<div class="node ${n.used ? 'used' : ''}">
        <span class="lv">L${n.level}</span><span class="coord">(${n.x}, ${n.y})</span>
        <span class="val">depth=${fmt(n.value)}</span>${n.used ? '<span class="tag">消费</span>' : '<span class="tag" style="background:var(--bg-3);color:var(--fg-dim)">下降</span>'}</div>`).join('');
  }
}

/* ---------------- 层标签 / 统计 ---------------- */
function renderLevelTabs() {
  $('levelTabs').innerHTML = S.pyramid.map((l, i) =>
    `<button class="${i === S.level ? 'active' : ''}" data-lvl="${i}">L${i} ${l.w}×${l.h}</button>`).join('');
  $('levelTabs').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    S.level = +btn.dataset.lvl; renderAll();
  }));
}
function renderStats() {
  const st = S.stats;
  $('stTotal').textContent = S.boxes.length;
  $('stVerdicts').textContent = `${st.occluded} / ${st.visible} / ${st.outside}`;
  $('stPyr').textContent = st.pyr.toLocaleString();
  $('stExh').textContent = st.exh.toLocaleString();
  $('modeText').textContent = `${S.mode} · 清屏 ${S.mode === 'standard' ? 1 : 0} · ${S.W}×${S.H}`;
  $('modePill').className = `pill ${S.mode === 'standard' ? 'info' : 'warn'}`;
  const cp = $('consistencyPill');
  if (st.mismatch === 0) { cp.hidden = false; cp.className = 'pill ok'; cp.innerHTML = '<span class="dot"></span>金字塔=穷举 全部一致'; }
  else { cp.hidden = false; cp.className = 'pill bad'; cp.innerHTML = `<span class="dot"></span>${st.mismatch} 盒不一致`; }
}

function renderAll() {
  if (!S.pyramid.length) return;
  renderStats(); renderLevelTabs(); renderTable(); renderDetail(); renderCanvas();
}

/* ---------------- 盒编辑 ---------------- */
$('applyBoxBtn').addEventListener('click', () => {
  const b = S.boxes.find(x => x.id === S.selectedId);
  if (!b) return;
  const min = ['minX', 'minY', 'minZ'].map(id => parseFloat($(id).value));
  const max = ['maxX', 'maxY', 'maxZ'].map(id => parseFloat($(id).value));
  const em = $('editMsg');
  if (min.some(v => !isFin(v)) || max.some(v => !isFin(v)))
    { em.innerHTML = '<div class="msg error">min/max 必须全部为有限数</div>'; return; }
  if (min.some((v, k) => v > max[k]))
    { em.innerHTML = '<div class="msg error">min 各分量必须不大于 max</div>'; return; }
  b.min = min; b.max = max; em.innerHTML = '';
  runAll(); renderAll(); toast('盒已更新，判定已重算');
});

/* ---------------- 孔洞 ---------------- */
$('clearHolesBtn').addEventListener('click', () => {
  if (!S.holes.size) return;
  S.depth.set(S.originalDepth); S.holes.clear();
  runAll(); renderAll(); toast('已恢复原始深度并清除全部孔洞');
});
$('toolSeg').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
  S.tool = btn.dataset.tool;
  $('toolSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === btn));
  $('paintHint').hidden = S.tool === 'inspect';
  canvas.style.cursor = S.tool === 'inspect' ? 'crosshair' : 'cell';
}));

/* ---------------- 过滤 ---------------- */
$('boxFilter').addEventListener('input', renderTable);
$('verdictFilter').addEventListener('change', renderTable);
$('boxTbody').addEventListener('click', ev => {
  const tr = ev.target.closest('tr');
  if (tr && tr.dataset.id) { S.selectedId = tr.dataset.id; renderAll(); }
});

/* ---------------- 文件导入 ---------------- */
$('fileInput').addEventListener('change', ev => {
  const f = ev.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      loadDataset(d, f.name);
    } catch (err) { showInputMsg(['JSON 解析失败：' + err.message], {}); }
  };
  rd.readAsText(f);
  ev.target.value = '';
});

/* ---------------- 内置样例 ---------------- */
$('sampleSelect').addEventListener('change', ev => {
  const key = ev.target.value;
  if (!key) return;
  const d = window.SAMPLES[key];
  loadDataset(d, key + '.json');
});

/* ---------------- 保存 / 重载（localStorage） ---------------- */
function currentInput() {
  return {
    width: S.W, height: S.H, mode: S.mode,
    depth: Array.from(S.depth), view_projection: S.M,
    boxes: S.boxes.map(b => ({ id: b.id, min: b.min, max: b.max })),
    _holes: Array.from(S.holes), _savedAt: new Date().toISOString(), _name: S.name,
  };
}
$('saveInputBtn').addEventListener('click', () => {
  if (!S.boxes.length) { toast('没有可保存的输入'); return; }
  try {
    localStorage.setItem('hiz-culler-input-v1', JSON.stringify(currentInput()));
    toast('输入（含孔洞编辑与盒修改）已保存在本浏览器');
  } catch (err) { toast('保存失败：' + err.message); }
});
$('loadSavedBtn').addEventListener('click', () => {
  try {
    const raw = localStorage.getItem('hiz-culler-input-v1');
    if (!raw) { toast('没有已保存的输入'); return; }
    const d = JSON.parse(raw);
    const holes = d._holes || []; delete d._holes;
    if (loadDataset(d, d._name || '已保存输入')) {
      S.holes = new Set(holes);
      toast('已重载保存的输入');
    }
  } catch (err) { toast('重载失败：' + err.message); }
});

/* ---------------- 导出 JSON ---------------- */
function buildExport() {
  const boxes = S.boxes.map(b => {
    const r = S.results.get(b.id);
    return {
      id: b.id, status: r.status, reason: r.reason,
      rect: r.rect, near_depth: r.nearDepth,
      pyramid_value: r.pyramidValue, exhaustive_value: r.exhaustiveValue,
      match: r.match, pyramid_visits: r.visits, exhaustive_pixels: r.pixels,
      visited_nodes: r.visited.map(n => ({ level: n.level, x: n.x, y: n.y, value: n.value, used: n.used })),
    };
  });
  return {
    schema: 'hiz-conservative-culler/export-v1',
    exported_at: new Date().toISOString(),
    input: {
      name: S.name, width: S.W, height: S.H, mode: S.mode,
      clear_value: S.mode === 'standard' ? 1 : 0,
      pyramid_sizes: S.pyramid.map(l => [l.w, l.h]),
      box_count: S.boxes.length, holes: Array.from(S.holes),
    },
    summary: {
      total: S.boxes.length, occluded: S.stats.occluded, visible: S.stats.visible,
      outside: S.stats.outside, pyramid_visits_total: S.stats.pyr,
      exhaustive_pixels_total: S.stats.exh, mismatches: S.stats.mismatch,
      speedup: S.stats.pyr ? +(S.stats.exh / S.stats.pyr).toFixed(3) : null,
    },
    boxes,
  };
}
$('exportBtn').addEventListener('click', () => {
  if (!S.boxes.length) { toast('没有可导出的判定'); return; }
  const text = JSON.stringify(buildExport(), null, 2);
  // 尝试文件下载（普通浏览器有效；受限查看器可能拦截，故同时提供文本框）
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hiz-cull-${S.name || 'export'}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) { /* 受限环境忽略 */ }
  showExportModal(text);
});
function showExportModal(text) {
  let ov = document.getElementById('exportOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'exportOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,18,.66);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = `<div style="max-width:860px;width:100%;max-height:86vh;display:flex;flex-direction:column;background:var(--bg-2);border:1px solid var(--line-2);border-radius:12px;padding:16px;gap:10px">
      <div style="display:flex;align-items:center;gap:10px"><b>导出判定与查询轨迹</b><span style="flex:1"></span>
      <button id="copyExport" class="small">复制全文</button><button id="closeExport" class="small ghost">关闭</button></div>
      <textarea readonly style="flex:1;min-height:300px;font-family:var(--mono);font-size:11.5px;line-height:1.45"></textarea>
      <div class="muted" style="font-size:11.5px">若浏览器拦截了自动下载，可直接复制此 JSON 保存；含每盒状态、原因、矩形、近深度、访问节点 (level/x/y/value) 与穷举对照计数。</div></div>`;
    document.body.appendChild(ov);
    $('closeExport').addEventListener('click', () => ov.remove());
    $('copyExport').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(ov.querySelector('textarea').value); toast('JSON 已复制'); }
      catch { const ta = ov.querySelector('textarea'); ta.select(); document.execCommand('selectAll'); toast('已选中，请手动复制'); }
    });
  }
  ov.querySelector('textarea').value = text;
}

/* ---------------- 主题 ---------------- */
function setTheme(t) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  ['themeSys', 'themeLight', 'themeDark'].forEach(id =>
    $(id).classList.toggle('active', id === 'theme' + t[0].toUpperCase() + t.slice(1)));
  try { localStorage.setItem('hiz-culler-theme', t); } catch { /* ignore */ }
  renderCanvas();
}
$('themeSys').addEventListener('click', () => setTheme('system'));
$('themeLight').addEventListener('click', () => setTheme('light'));
$('themeDark').addEventListener('click', () => setTheme('dark'));
try { const t = localStorage.getItem('hiz-culler-theme'); if (t) setTheme(t); } catch { /* ignore */ }

/* ---------------- 杂项 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
window.addEventListener('resize', () => renderCanvas());

/* ---------------- 启动：自动载入小样本，首屏即工作状态 ---------------- */
loadDataset(window.SAMPLES['odd-standard'], 'odd-standard.json');
$('sampleSelect').value = 'odd-standard';

/* Node 测试钩子（浏览器中 module 未定义，不产生任何影响） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { S, validateInput, buildPyramid, nodeCover, queryPyramid, queryExhaustive, cullBox, runAll, loadDataset };
}
