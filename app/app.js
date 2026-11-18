/*
 * app.js — 标记引导测地分割网页主逻辑（纯浏览器，零第三方依赖）
 * 依赖 png.js (MGSPng) 与 segment.js (MGSSegment)。
 */
"use strict";

const MAX_SIDE = 512;
const MAX_LABELS = 32;

/* 32 色高区分标签调色板（与背景深色调和，种子/区域共用） */
const PALETTE = [
  "#ff6b6b", "#4ecdc4", "#ffe66d", "#95e1d3", "#a8e6cf", "#c7a8ff", "#ffb26b", "#7bd88f",
  "#6fc2ff", "#f78fb3", "#b8e986", "#f6a6ff", "#ffd166", "#06d6a0", "#ef476f", "#8ecae6",
  "#fb8500", "#bdb2ff", "#80ed99", "#ffafcc", "#90dbf4", "#f4a261", "#b9fbc0", "#e0aaff",
  "#ff8fa3", "#a3c4f3", "#cfbaf0", "#98f5e1", "#fde4cf", "#ffa3a3", "#9bf6ff", "#fdffb6"
];

/** 应用状态 */
const state = {
  image: null,          // { width,height, gray:Uint8ClampedArray, name }
  mask: null,           // Uint8Array(0/1) 或 null
  maskName: null,
  connectivity: 4,
  seeds: [],            // { label, x, y }
  nextLabel: 1,
  activeLabel: 1,
  result: null,         // segment() 返回
  stats: null,
  tool: "inspect",
  zoom: 8,
  baseZoom: 8,          // 100% 对应的像素放大倍数
  hover: null,          // {x,y}
  show: { overlay: true, boundary: true, cost: false, seeds: true, grid: false }
};

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d");

/* ---------------- 消息 ---------------- */
function log(msg, kind) {
  const box = $("msgLog");
  const div = document.createElement("div");
  div.className = "msg" + (kind ? " " + kind : "");
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 60) box.removeChild(box.firstChild);
}

/* ---------------- 文件导入 ---------------- */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

async function importImage(file) {
  try {
    const buf = await readFile(file);
    const im = MGSPng.decode(buf);
    if (im.bitDepth !== 8 || im.colorType !== 0) {
      log(`提示：${file.name} 非 8 位灰度（bit=${im.bitDepth}, type=${im.colorType}），已按灰度转换载入。约定输入应为 8 位灰度 PNG。`, "error");
    }
    if (im.width > MAX_SIDE || im.height > MAX_SIDE) {
      throw new Error(`图像单边最多 ${MAX_SIDE} 像素，实际 ${im.width}×${im.height}`);
    }
    state.image = { width: im.width, height: im.height, gray: im.gray, name: file.name };
    state.mask = null; state.maskName = null;
    state.seeds = [];
    state.result = null; state.stats = null;
    state.hover = null;
    fitZoom();
    resizeCanvas();
    $("emptyHint").style.display = "none";
    $("statusbar").textContent = `${file.name}  ${im.width}×${im.height}  8位灰度`;
    $("inspector").classList.add("dim");
    $("inspector").textContent = "将鼠标移到画布上查看像素信息";
    setExportEnabled(false);
    log(`已载入图像 ${file.name}：${im.width}×${im.height}`, "ok");
    refreshLabelSelect();
    scheduleRun();
  } catch (e) {
    log("图像导入失败：" + e.message, "error");
  }
}

async function importMask(file) {
  try {
    if (!state.image) throw new Error("请先导入图像");
    const buf = await readFile(file);
    const im = MGSPng.decode(buf);
    if (im.width !== state.image.width || im.height !== state.image.height) {
      throw new Error(`掩膜尺寸 ${im.width}×${im.height} 与图像 ${state.image.width}×${state.image.height} 不一致`);
    }
    const mask = new Uint8Array(im.width * im.height);
    for (let i = 0; i < mask.length; i++) mask[i] = im.gray[i] > 127 ? 1 : 0;
    // 落在掩膜外的种子直接剔除并提示
    const kept = [];
    const dropped = [];
    for (const s of state.seeds) {
      if (mask[s.y * im.width + s.x]) kept.push(s);
      else dropped.push(s);
    }
    state.seeds = kept;
    state.mask = mask;
    state.maskName = file.name;
    log(`已载入掩膜 ${file.name}（有效像素 ${mask.reduce((a, v) => a + v, 0)}）` +
      (dropped.length ? `；剔除 ${dropped.length} 个掩膜外种子` : ""), dropped.length ? "error" : "ok");
    scheduleRun();
  } catch (e) {
    log("掩膜导入失败：" + e.message, "error");
  }
}

async function importMarkers(file) {
  try {
    if (!state.image) throw new Error("请先导入图像");
    const text = new TextDecoder().decode(await readFile(file));
    const data = JSON.parse(text);
    const conn = Number(data.connectivity);
    if (conn !== 4 && conn !== 8) throw new Error("connectivity 必须是 4 或 8");
    if (!Array.isArray(data.seeds)) throw new Error("标记 JSON 缺少 seeds 数组");
    state.connectivity = conn;
    document.querySelector(`input[name="connectivity"][value="${conn}"]`).checked = true;
    state.seeds = data.seeds.map((s) => ({ label: Number(s.label), x: Number(s.x), y: Number(s.y) }));
    // 校验交给引擎（含越界、冲突、掩膜外、标签范围）
    const norm = MGSSegment.normalizeSeeds(state.seeds, state.image.width, state.image.height, state.mask);
    state.seeds = norm.seeds.map((s) => ({ label: s.label, x: s.x, y: s.y }));
    state.activeLabel = state.seeds[0].label;
    if (norm.duplicates.length) log(`去重 ${norm.duplicates.length} 个重复的同标签同坐标种子`);
    refreshLabelSelect();
    log(`已载入标记 ${file.name}：${state.seeds.length} 个种子，${conn} 邻域`, "ok");
    scheduleRun();
  } catch (e) {
    log("标记导入失败：" + e.message, "error");
  }
}

/* ---------------- 标签与种子编辑 ---------------- */
function usedLabels() {
  return Array.from(new Set(state.seeds.map((s) => s.label))).sort((a, b) => a - b);
}

function refreshLabelSelect() {
  const sel = $("labelSelect");
  const used = usedLabels();
  // 选项覆盖已用标签 + 下一个可用标签，最多 32
  const nextAvail = firstAvailableLabel();
  const opts = new Set(used);
  if (nextAvail) opts.add(nextAvail);
  sel.innerHTML = "";
  Array.from(opts).sort((a, b) => a - b).forEach((lab) => {
    const o = document.createElement("option");
    o.value = lab;
    o.textContent = `标签 ${lab}`;
    sel.appendChild(o);
  });
  if (![...sel.options].some((o) => Number(o.value) === state.activeLabel)) {
    state.activeLabel = sel.options[0] ? Number(sel.options[0].value) : 1;
  }
  sel.value = state.activeLabel;
  renderSeedList();
}

function firstAvailableLabel() {
  const used = new Set(usedLabels());
  for (let l = 1; l <= MAX_LABELS; l++) if (!used.has(l)) return l;
  return null;
}

function addLabel() {
  const l = firstAvailableLabel();
  if (!l) return log(`最多 ${MAX_LABELS} 种标签`, "error");
  state.activeLabel = l;
  refreshLabelSelect();
  log(`新增标签 ${l}（在图上播入种子后参与分割）`);
}

function removeLabel() {
  const lab = state.activeLabel;
  const before = state.seeds.length;
  state.seeds = state.seeds.filter((s) => s.label !== lab);
  if (state.seeds.length === before) return log(`标签 ${lab} 没有种子，无需删除`);
  log(`已删除标签 ${lab} 的全部 ${before - state.seeds.length} 个种子`);
  refreshLabelSelect();
  scheduleRun();
}

function addSeed(x, y, label) {
  if (!state.image) return;
  if (x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) return;
  if (state.mask && !state.mask[y * state.image.width + x]) {
    return log(`(${x},${y}) 位于有效掩膜之外，不能播种子`, "error");
  }
  // 冲突检测
  const occupant = state.seeds.find((s) => s.x === x && s.y === y);
  if (occupant) {
    if (occupant.label === label) return; // 同标签重复，忽略
    return log(`(${x},${y}) 已属于标签 ${occupant.label}，冲突标签拒绝`, "error");
  }
  if (!usedLabels().includes(label) && usedLabels().length >= MAX_LABELS &&
    !state.seeds.some((s) => s.label === label)) {
    return log(`最多 ${MAX_LABELS} 种标签`, "error");
  }
  state.seeds.push({ label, x, y });
  refreshLabelSelect();
  scheduleRun();
}

function eraseSeedAt(x, y) {
  const i = state.seeds.findIndex((s) => s.x === x && s.y === y);
  if (i < 0) return;
  const [s] = state.seeds.splice(i, 1);
  log(`删除种子 (${s.x},${s.y}) 标签${s.label}`);
  refreshLabelSelect();
  scheduleRun();
}

function renderSeedList() {
  const box = $("seedList");
  box.innerHTML = "";
  const grouped = new Map();
  for (const s of state.seeds) {
    if (!grouped.has(s.label)) grouped.set(s.label, []);
    grouped.get(s.label).push(s);
  }
  $("seedCountLine").textContent = `种子数：${state.seeds.length}（标签种类 ${grouped.size}）`;
  for (const [lab, list] of Array.from(grouped).sort((a, b) => a[0] - b[0])) {
    for (const s of list) {
      const item = document.createElement("div");
      item.className = "seed-item";
      item.innerHTML =
        `<span class="seed-swatch" style="background:${PALETTE[(lab - 1) % 32]}"></span>` +
        `<span>标签 ${lab}</span><span class="coord">(${s.x}, ${s.y})</span>` +
        `<button title="删除该种子" data-x="${s.x}" data-y="${s.y}">✕</button>`;
      box.appendChild(item);
    }
  }
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => eraseSeedAt(Number(b.dataset.x), Number(b.dataset.y));
  });
}

/* ---------------- 分割计算（防抖自动重算） ---------------- */
let runTimer = null;
function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(runSegmentation, 60);
}

function runSegmentation() {
  if (!state.image) return;
  if (!state.seeds.length) {
    state.result = null; state.stats = null;
    setExportEnabled(false);
    updateStats(null);
    draw();
    return;
  }
  try {
    state.result = MGSSegment.segment(
      state.image.gray, state.image.width, state.image.height,
      { mask: state.mask, connectivity: state.connectivity, seeds: state.seeds }
    );
    state.stats = MGSSegment.buildStats(state.result, state.image.gray, state.seeds);
    if (state.result.duplicates.length) log(`引擎去重 ${state.result.duplicates.length} 个重复种子`);
    setExportEnabled(true);
    updateStats(state.stats);
    const c = state.stats.counts;
    $("statusbar").textContent =
      `${state.image.name}  ${state.image.width}×${state.image.height}  ` +
      `${state.connectivity}邻域 | 可达 ${c.reached} · 分界 ${c.tie} · 未到达 ${c.unreached} · 掩膜外 ${c.excluded}`;
    log(`重算完成：${state.stats.counts.reached} 可达，${state.stats.counts.tie} 分界，` +
      `${state.stats.counts.unreached} 未到达，${state.stats.counts.excluded} 掩膜外`, "ok");
  } catch (e) {
    state.result = null; state.stats = null;
    setExportEnabled(false);
    log("分割失败：" + e.message, "error");
  }
  draw();
}

function setExportEnabled(on) {
  for (const id of ["btnExportRaw", "btnExportBoundary", "btnExportUnreached", "btnExportJson"]) {
    $(id).disabled = !on;
  }
}

/* ---------------- Canvas 渲染 ---------------- */
function resizeCanvas() {
  if (!state.image) return;
  const z = state.zoom;
  canvas.width = state.image.width * z;
  canvas.height = state.image.height * z;
  canvas.style.width = canvas.width + "px";
  canvas.style.height = canvas.height + "px";
}

function fitZoom() {
  if (!state.image) return;
  const sc = $("canvasScroll");
  const maxW = sc.clientWidth - 24, maxH = sc.clientHeight - 24;
  const z = Math.max(1, Math.floor(Math.min(maxW / state.image.width, maxH / state.image.height)));
  state.zoom = Math.min(z, 48);
  updateZoomLabel();
}

function updateZoomLabel() {
  $("zoomLabel").textContent = Math.round(state.zoom / state.baseZoom * 100) + "%";
}

/* 代价热图色带：低代价冷色 → 高代价暖色 */
const RAMP = [
  [13, 8, 73], [55, 6, 99], [117, 12, 117], [188, 55, 84],
  [237, 104, 37], [249, 168, 37], [244, 233, 94]
];
function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  const f = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f));
  const u = f - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},` +
    `${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}

function draw() {
  if (!state.image) return;
  resizeCanvas();
  const { width: w, height: h, gray } = state.image;
  const z = state.zoom;
  const r = state.result;

  // 底层灰度图
  const base = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const g = gray[i];
    base.data[i * 4] = g; base.data[i * 4 + 1] = g; base.data[i * 4 + 2] = g;
    base.data[i * 4 + 3] = 255;
  }
  // 先 1:1 画到离屏，再放大，保证像素整齐
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const octx = off.getContext("2d");
  octx.putImageData(base, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  // 掩膜外压暗
  if (state.mask) {
    ctx.fillStyle = "rgba(10,12,16,0.62)";
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!state.mask[y * w + x]) ctx.fillRect(x * z, y * z, z, z);
    }
  }

  if (r) {
    // 代价热图（仅可达像素）
    if (state.show.cost) {
      let maxC = 0;
      for (let i = 0; i < w * h; i++) if (isFinite(r.cost[i]) && r.cost[i] > maxC) maxC = r.cost[i];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!r.reached[i] || !maxC) continue;
        ctx.fillStyle = rampColor(r.cost[i] / maxC);
        ctx.globalAlpha = 0.62;
        ctx.fillRect(x * z, y * z, z, z);
      }
      ctx.globalAlpha = 1;
    }
    // 标签着色
    if (state.show.overlay) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const lab = r.labels[y * w + x];
        if (!lab) continue;
        ctx.fillStyle = PALETTE[(lab - 1) % 32];
        ctx.globalAlpha = 0.42;
        ctx.fillRect(x * z, y * z, z, z);
      }
      ctx.globalAlpha = 1;
    }
    // 边界（分界像素）高亮
    if (state.show.boundary) {
      ctx.fillStyle = "#ffd34d";
      for (let i = 0; i < w * h; i++) {
        if (r.tie[i]) ctx.fillRect((i % w) * z, ((i / w) | 0) * z, z, z);
      }
      // 再描细边增强可见性
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < w * h; i++) {
        if (r.tie[i] && z >= 4) {
          ctx.strokeStyle = "rgba(120,80,0,0.9)";
          ctx.lineWidth = 1;
          ctx.strokeRect((i % w) * z + 0.5, ((i / w) | 0) * z + 0.5, z - 1, z - 1);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  // 像素网格
  if (state.show.grid && z >= 6) {
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, h * z); }
    for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(w * z, y * z + 0.5); }
    ctx.stroke();
  }

  // 种子
  if (state.show.seeds) {
    for (const s of state.seeds) {
      const cx = s.x * z + z / 2, cy = s.y * z + z / 2;
      const rad = Math.max(3, z * 0.42);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE[(s.label - 1) % 32];
      ctx.fill();
      ctx.lineWidth = Math.max(1, z * 0.08);
      ctx.strokeStyle = "#0b1220";
      ctx.stroke();
      if (z >= 10) {
        ctx.fillStyle = "#0b1220";
        ctx.font = `bold ${Math.min(z * 0.55, 13)}px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(s.label), cx, cy + 0.5);
      }
    }
  }

  // 悬停十字
  if (state.hover) {
    const { x, y } = state.hover;
    ctx.strokeStyle = "rgba(79,156,249,0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x * z + 0.5, y * z + 0.5, z - 1, z - 1);
  }
}

/* ---------------- 点查 / 鼠标交互 ---------------- */
function eventToPixel(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / state.zoom);
  const y = Math.floor((ev.clientY - rect.top) / state.zoom);
  if (!state.image || x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) return null;
  return { x, y };
}

canvas.addEventListener("mousemove", (ev) => {
  const p = eventToPixel(ev);
  state.hover = p;
  if (p) updateInspector(p);
  draw();
});
canvas.addEventListener("mouseleave", () => { state.hover = null; draw(); });

canvas.addEventListener("click", (ev) => {
  const p = eventToPixel(ev);
  if (!p) return;
  if (state.tool === "seed") addSeed(p.x, p.y, state.activeLabel);
  else if (state.tool === "erase") eraseSeedAt(p.x, p.y);
  else updateInspector(p, true);
  draw();
});

function classify(i) {
  const r = state.result;
  if (state.mask && !state.mask[i]) return { kind: "excluded", text: "掩膜外（排除）" };
  if (!r) return { kind: "none", text: "未计算" };
  if (!r.reached[i]) return { kind: "unreached", text: "未到达" };
  if (r.tie[i]) return { kind: "tie", text: "分界（标签最低成本相等）" };
  return { kind: "label", text: `标签 ${r.labels[i]}`, label: r.labels[i] };
}

function updateInspector(p, pinned) {
  const i = p.y * state.image.width + p.x;
  const g = state.image.gray[i];
  const r = state.result;
  const c = classify(i);
  let costLine = "—";
  if (r && r.reached[i]) costLine = String(r.cost[i]);
  const tagClass = c.kind === "label" ? "label" : c.kind;
  const tagStyle = c.kind === "label"
    ? `style="background:${PALETTE[(c.label - 1) % 32]}"` : "";
  const seedHere = state.seeds.find((s) => s.x === p.x && s.y === p.y);
  $("inspector").classList.remove("dim");
  $("inspector").innerHTML =
    `<div class="kv"><span>坐标</span><span>(${p.x}, ${p.y})</span></div>` +
    `<div class="kv"><span>灰度</span><span>${g}</span></div>` +
    `<div class="kv"><span>归属</span><span class="tag ${tagClass}" ${tagStyle}>${c.text}</span></div>` +
    `<div class="kv"><span>最低成本</span><span>${costLine}</span></div>` +
    `<div class="kv"><span>种子</span><span>${seedHere ? "标签 " + seedHere.label : "无"}</span></div>` +
    (pinned ? `<div class="dim" style="margin-top:4px">已固定该像素信息</div>` : "");
  $("statusbar").textContent =
    `(${p.x}, ${p.y})  gray=${g}  归属=${c.text}  成本=${costLine}` +
    (state.mask ? `  掩膜=${state.mask[i] ? "有效" : "排除"}` : "");
}

/* ---------------- 统计表 ---------------- */
function updateStats(stats) {
  const tb = $("statsTable").querySelector("tbody");
  tb.innerHTML = "";
  if (!stats) {
    $("countsLine").textContent = "";
    return;
  }
  for (const s of stats.perLabel) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><span class="cell-swatch" style="background:${PALETTE[(s.label - 1) % 32]}"></span>标签 ${s.label}</td>` +
      `<td>${s.area}</td><td>${s.meanGray}</td><td>[${s.bbox.join(", ")}]</td>`;
    tb.appendChild(tr);
  }
  const c = stats.counts;
  $("countsLine").innerHTML =
    `可达 <b style="color:var(--ok)">${c.reached}</b> · 分界 <b style="color:var(--boundary)">${c.tie}</b>` +
    ` · 未到达 <b style="color:var(--unreached)">${c.unreached}</b> · 掩膜外 ${c.excluded} · 合计 ${c.total}`;
}

/* ---------------- 导出 ---------------- */
function download(blobOrBuf, name, mime) {
  const blob = blobOrBuf instanceof Blob ? blobOrBuf : new Blob([blobOrBuf], { type: mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function baseName() {
  return state.image ? state.image.name.replace(/\.png$/i, "") : "segment";
}

function exportRaw() {
  const r = state.result;
  // 宽×高 行主序小端 uint16；分界/未到达/排除均为 0，由另两个 PNG 与 JSON 区分
  const le = new Uint8Array(r.width * r.height * 2);
  const dv = new DataView(le.buffer);
  for (let i = 0; i < r.width * r.height; i++) dv.setUint16(i * 2, r.labels[i], true);
  download(le, `${baseName()}-labels.raw`);
  log("已导出标签 RAW（小端 uint16，0=分界/未到达/排除）");
}

function exportBoundary() {
  const r = state.result;
  const g = new Uint8Array(r.width * r.height);
  for (let i = 0; i < g.length; i++) g[i] = r.tie[i] ? 255 : 0; // 只标平局像素
  download(MGSPng.encodeGray(r.width, r.height, g), `${baseName()}-boundary.png`, "image/png");
  log("已导出边界 PNG（白=分界像素）");
}

function exportUnreached() {
  const r = state.result;
  const g = new Uint8Array(r.width * r.height);
  for (let i = 0; i < g.length; i++) {
    // 白=有效掩膜内不可达；灰 128=掩膜外（保留掩膜形状）；黑=已到达
    g[i] = r.excluded[i] ? 128 : (r.reached[i] ? 0 : 255);
  }
  download(MGSPng.encodeGray(r.width, r.height, g), `${baseName()}-unreached.png`, "image/png");
  log("已导出未到达 PNG（白=未到达，灰=掩膜外，黑=已到达）");
}

function exportJson() {
  const r = state.result;
  const stats = state.stats;
  const payload = {
    image: state.image.name,
    width: r.width,
    height: r.height,
    connectivity: r.connectivity,
    costRule: "edge = step*(256+|gray(p)-gray(q)|); ortho step=10, diagonal step=14, integer",
    markers: {
      connectivity: r.connectivity,
      seeds: state.seeds.map((s) => ({ label: s.label, x: s.x, y: s.y }))
    },
    mask: state.maskName || null,
    labelEncoding: {
      raw: "uint16 little-endian, row-major; 0 means boundary/unreached/excluded",
      boundaryPng: "255=tie pixels, 0=otherwise",
      unreachedPng: "255=unreached inside mask, 128=outside mask, 0=reached"
    },
    stats: {
      perLabel: stats.perLabel,
      counts: stats.counts
    },
    exportedAt: new Date().toISOString()
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    `${baseName()}-report.json`, "application/json");
  log("已导出统计/配置 JSON（含全部种子与连通模式，可用于复算）");
}

/* ---------------- 控件绑定 ---------------- */
$("fileImage").addEventListener("change", (e) => e.target.files[0] && importImage(e.target.files[0]));
$("fileMask").addEventListener("change", (e) => e.target.files[0] && importMask(e.target.files[0]));
$("fileMarkers").addEventListener("change", (e) => e.target.files[0] && importMarkers(e.target.files[0]));

document.querySelectorAll('input[name="connectivity"]').forEach((rb) => {
  rb.addEventListener("change", () => {
    state.connectivity = Number(rb.value);
    scheduleRun();
  });
});

document.querySelectorAll(".tool").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.tool = b.dataset.tool;
    canvas.style.cursor = state.tool === "inspect" ? "crosshair" : "pointer";
  });
});

$("labelSelect").addEventListener("change", (e) => { state.activeLabel = Number(e.target.value); });
$("btnAddLabel").addEventListener("click", addLabel);
$("btnRemoveLabel").addEventListener("click", removeLabel);

[
  ["tgOverlay", "overlay"], ["tgBoundary", "boundary"], ["tgCost", "cost"],
  ["tgSeeds", "seeds"], ["tgGrid", "grid"]
].forEach(([id, key]) => {
  $(id).addEventListener("change", (e) => { state.show[key] = e.target.checked; draw(); });
});

$("zoomIn").addEventListener("click", () => setZoom(state.zoom * 2));
$("zoomOut").addEventListener("click", () => setZoom(state.zoom / 2));
$("zoomFit").addEventListener("click", () => { fitZoom(); draw(); });
$("btnRerun").addEventListener("click", () => { runSegmentation(); log("手动重算"); });

function setZoom(z) {
  state.zoom = Math.max(1, Math.min(64, Math.round(z)));
  updateZoomLabel();
  draw();
}
canvas.addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  setZoom(state.zoom * (ev.deltaY < 0 ? 1.25 : 0.8));
}, { passive: false });

$("btnExportRaw").addEventListener("click", exportRaw);
$("btnExportBoundary").addEventListener("click", exportBoundary);
$("btnExportUnreached").addEventListener("click", exportUnreached);
$("btnExportJson").addEventListener("click", exportJson);

// 拖放导入
const scroll = $("canvasScroll");
["dragover", "dragenter"].forEach((t) => scroll.addEventListener(t, (e) => {
  e.preventDefault(); scroll.style.outline = "2px solid var(--accent)";
}));
["dragleave", "drop"].forEach((t) => scroll.addEventListener(t, () => {
  scroll.style.outline = "";
}));
scroll.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (f.name.endsWith(".json")) importMarkers(f);
  else if (state.image && (f.name.includes("mask") || f.name.includes("掩膜"))) importMask(f);
  else importImage(f);
});

window.addEventListener("resize", () => { if (state.image) draw(); });
refreshLabelSelect();
log("应用就绪：导入灰度 PNG 开始");
