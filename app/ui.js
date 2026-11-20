// 页面控制器：文件导入、参数绑定、SVG 画布渲染、点击拾取、检查器、导出。
// 算法全部来自无 DOM 依赖的 core/png/exporter，本文件只负责交互与绘制。
import { decodePng, decodeMask } from "./png.js";
import {
  buildTopology, buildGeometry, validateLevels, cellInfo,
} from "./core.js";
import { buildSvg, buildJson, DEFAULT_PALETTE } from "./exporter.js";

const $ = (id) => document.getElementById(id);
const state = {
  image: null,       // {width,height,bitDepth,values,name}
  mask: null,        // Uint8Array 或 null
  maskName: null,
  topo: null,
  geom: null,
  origin: [10, -5],
  spacing: [0.5, 2],
  selectedCell: null,  // {r,c}
  selectedLine: null,  // {levelIndex, lineId}
  pickMode: "line",    // "line" | "cell"
  palette: DEFAULT_PALETTE,
};

// ---------- 通用 ----------
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 主题 ----------
$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme");
  root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
});

// 拾取模式：折线（默认，点等值线看测量值）/ 单元（点网格看角点与连接）
$("pickModeBtn").addEventListener("click", () => {
  state.pickMode = state.pickMode === "line" ? "cell" : "line";
  state.selectedCell = null;
  state.selectedLine = null;
  renderAll();
});

// ---------- 文件导入 ----------
function bindDrop(dropEl, inputEl, handler) {
  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", async () => {
    if (inputEl.files[0]) await handler(inputEl.files[0]);
    inputEl.value = "";
  });
  ["dragover", "dragenter"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.remove("drag"); }));
  dropEl.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (f) await handler(f);
  });
}

bindDrop($("imageDrop"), $("imageInput"), async (file) => {
  try {
    const bytes = await readFile(file);
    const img = decodePng(bytes);
    state.image = { ...img, name: file.name };
    state.mask = null; state.maskName = null;
    $("maskMeta").hidden = true;
    $("imageMeta").hidden = false;
    $("imageMeta").textContent =
      `${file.name}\n${img.width} × ${img.height} 节点 · ${img.bitDepth} 位灰度\n` +
      `取值范围 ${Math.min(...img.values)} – ${Math.max(...img.values)}`;
    $("extractBtn").disabled = false;
    toast(`已载入图像 ${img.width}×${img.height}`);
  } catch (err) {
    toast(err.message, true);
  }
});

bindDrop($("maskDrop"), $("maskInput"), async (file) => {
  try {
    if (!state.image) throw new Error("请先导入灰度图像");
    const bytes = await readFile(file);
    const mask = decodeMask(bytes, state.image.width, state.image.height);
    state.mask = mask;
    state.maskName = file.name;
    const valid = mask.reduce((n, v) => n + v, 0);
    $("maskMeta").hidden = false;
    $("maskMeta").textContent =
      `${file.name}\n有效节点 ${valid} / ${mask.length}`;
    toast("已载入掩膜");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- 参数读取 ----------
function readParams() {
  const levels = validateLevels($("levelsInput").value);
  const ox = Number($("originX").value);
  const oy = Number($("originY").value);
  const sx = Number($("spacingX").value);
  const sy = Number($("spacingY").value);
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new Error("物理原点必须是数字");
  if (!(sx > 0) || !(sy > 0)) throw new Error("横纵间距必须大于 0");
  return { levels, origin: [ox, oy], spacing: [sx, sy] };
}

// ---------- 提取 ----------
$("extractBtn").addEventListener("click", () => {
  try {
    if (!state.image) throw new Error("请先导入图像");
    const { levels, origin, spacing } = readParams();
    state.origin = origin; state.spacing = spacing;
    state.topo = buildTopology({
      width: state.image.width,
      height: state.image.height,
      values: state.image.values,
      mask: state.mask || undefined,
      levels,
    });
    state.geom = buildGeometry(state.topo, origin, spacing);
    state.selectedCell = null; state.selectedLine = null;
    renderAll();
    const lineCount = state.geom.levels.reduce((n, lv) => n + lv.lines.length, 0);
    toast(`提取完成：${levels.length} 个阈值，${lineCount} 条折线`);
  } catch (err) {
    toast(err.message, true);
  }
});

// 间距/原点改动后仅重算几何（拓扑不变），显示与导出同步
function refreshGeometry() {
  if (!state.topo) return;
  try {
    const { origin, spacing } = readParams();
    state.origin = origin; state.spacing = spacing;
    state.geom = buildGeometry(state.topo, origin, spacing);
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}
["originX", "originY", "spacingX", "spacingY"].forEach((id) =>
  $(id).addEventListener("change", refreshGeometry));

// ---------- 画布渲染 ----------
const SVGNS = "http://www.w3.org/2000/svg";
// SVG 命名空间元素（仅用于画布）
function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}
// HTML 命名空间元素（用于检查器、图例、徽标等普通 DOM）
function h(tag, attrs = {}, parent) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k === "className") node.className = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

// 节点坐标 -> 屏幕像素（Y 向下，与 SVG 一致；物理 Y 由几何层已含 origin/spacing）
function makeTransform() {
  const { width: W, height: H } = state.topo;
  // 画布显示尺寸：长边约 720px
  const target = 760;
  const scale = target / Math.max(W - 1, H - 1);
  const margin = 12;
  // 节点 (col,row) 映射；物理坐标仅用于检查器/导出，画布保持网格拓扑视角
  return {
    scale, margin, W, H,
    sx: (col) => margin + col * scale,
    sy: (row) => margin + row * scale,
    viewW: margin * 2 + (W - 1) * scale,
    viewH: margin * 2 + (H - 1) * scale,
  };
}

function renderAll() {
  renderStage();
  renderLegend();
  renderStats();
  renderInspector();
}

function renderStage() {
  const stage = $("stage");
  stage.innerHTML = "";
  if (!state.topo) { stage.hidden = true; $("emptyHint").hidden = false; return; }
  $("emptyHint").hidden = true;
  stage.hidden = false;
  stage.classList.toggle("pick-cell", state.pickMode === "cell");
  $("pickModeBtn").textContent = state.pickMode === "cell" ? "拾取：单元" : "拾取：折线";
  $("pickModeBtn").setAttribute("aria-pressed", String(state.pickMode === "cell"));
  const tr = makeTransform();
  stage.setAttribute("viewBox", `0 0 ${tr.viewW} ${tr.viewH}`);
  stage.setAttribute("width", tr.viewW);
  stage.setAttribute("height", tr.viewH);
  const { width: W, height: H } = state.topo;

  // 1) 掩膜无效区背景（按单元）
  if (state.mask) {
    const gMask = el("g", { class: "mask-layer" }, stage);
    const cols = W - 1, rows = H - 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!state.topo.validCell[r * cols + c]) {
          el("rect", {
            x: tr.sx(c), y: tr.sy(r),
            width: tr.scale, height: tr.scale,
            class: "masked",
          }, gMask);
        }
      }
    }
  }

  // 2) 可点击单元（透明矩形捕获点击）
  const gCell = el("g", { class: "cell-layer" }, stage);
  const cols = W - 1, rows = H - 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = el("rect", {
        x: tr.sx(c), y: tr.sy(r), width: tr.scale, height: tr.scale,
        class: "grid-cell",
        "data-r": r, "data-c": c,
      }, gCell);
      rect.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectedCell = { r, c };
        state.selectedLine = null;
        renderStage();
        renderInspector();
      });
    }
  }

  // 3) 等值线（每阈值一色）
  state.geom.levels.forEach((lv, li) => {
    const color = state.palette[li % state.palette.length];
    const g = el("g", { "data-level": lv.level }, stage);
    // stroke-width 用屏幕像素（vector-effect 保证不随 viewBox 缩放），
    // 同时加粗透明描边作为更大的点击热区
    for (const line of lv.lines) {
      // 物理点转回节点坐标以绘制（与拓扑视角一致）
      const d = line.points.map((p, i) => {
        const col = (p[0] - state.origin[0]) / state.spacing[0];
        const row = (p[1] - state.origin[1]) / state.spacing[1];
        return `${i === 0 ? "M" : "L"}${tr.sx(col)},${tr.sy(row)}`;
      }).join("") + (line.open ? "" : "Z");
      const sel = state.selectedLine && state.selectedLine.lineId === line.id;
      // 透明热区：宽度大、先绘制，仅负责接收点击
      const hit = el("path", {
        d, fill: "none", stroke: "transparent", "stroke-width": 12,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
        style: "cursor:pointer",
      }, g);
      const path = el("path", {
        d, class: "contour" + (sel ? " sel" : ""),
        stroke: color, "stroke-width": sel ? 3.2 : 2,
        "vector-effect": "non-scaling-stroke",
        "data-line-id": line.id, "data-level-index": li,
        style: `color:${color}`,
      }, g);
      const onPick = (e) => {
        e.stopPropagation();
        state.selectedLine = { levelIndex: li, lineId: line.id };
        state.selectedCell = null;
        renderStage();
        renderInspector();
      };
      hit.addEventListener("click", onPick);
      path.addEventListener("click", onPick);
    }
  });

  // 4) 选中单元的角点、交点、连接
  if (state.selectedCell) {
    drawCellOverlay(stage, tr, state.selectedCell.r, state.selectedCell.c);
  }
}

// 点击画布空白处清除选择（监听器只绑定一次，子元素已 stopPropagation）
$("stage").addEventListener("click", () => {
  if (!state.selectedCell && !state.selectedLine) return;
  state.selectedCell = null;
  state.selectedLine = null;
  renderStage();
  renderInspector();
});

function drawCellOverlay(stage, tr, r, c) {
  const g = el("g", { class: "cell-overlay" }, stage);
  el("rect", {
    x: tr.sx(c), y: tr.sy(r), width: tr.scale, height: tr.scale, class: "cell-sel",
  }, g);
  // 角点（取当前阈值，若选了线则用其阈值，否则用第一个）
  const li = state.selectedLine ? state.selectedLine.levelIndex : 0;
  const info = cellInfo(state.topo, li, r, c);
  if (!info) return;
  // 四角节点
  const corners = [
    ["a", c, r], ["b", c + 1, r], ["c", c + 1, r + 1], ["d", c, r + 1],
  ];
  for (const [key, col, row] of corners) {
    const cn = info.corners[key];
    el("circle", {
      cx: tr.sx(col), cy: tr.sy(row), r: Math.max(2.2, tr.scale * 0.09),
      class: "corner-dot", fill: cn.above ? "var(--accent)" : "var(--fg-muted)",
    }, g);
  }
  // 交点
  for (const it of info.intersections) {
    el("circle", {
      cx: tr.sx(it.nodePoint[0]), cy: tr.sy(it.nodePoint[1]),
      r: Math.max(3, tr.scale * 0.12), class: "intersection",
    }, g);
  }
}

function renderLegend() {
  const legend = $("legend");
  legend.innerHTML = "";
  if (!state.geom) return;
  state.geom.levels.forEach((lv, li) => {
    const open = lv.lines.filter((l) => l.open).length;
    const closed = lv.lines.length - open;
    const chip = h("span", { class: "chip" }, legend);
    h("span", { class: "swatch", style: `background:${state.palette[li % state.palette.length]}` }, chip);
    chip.appendChild(document.createTextNode(`t=${lv.level} · 开 ${open} · 闭 ${closed}`));
  });
}

function renderStats() {
  const s = $("canvasStats");
  if (!state.topo) { s.textContent = ""; return; }
  const total = state.geom.levels.reduce((n, lv) => n + lv.lines.length, 0);
  s.textContent = `${state.topo.width}×${state.topo.height} 节点 · ${total} 条折线 · ` +
    `origin(${state.origin.join(", ")}) spacing(${state.spacing.join(", ")})`;
}

// ---------- 检查器 ----------
function renderInspector() {
  const host = $("inspector");
  host.innerHTML = "";
  if (!state.topo) {
    host.innerHTML = `<div class="empty-hint">尚未选择对象</div>`;
    return;
  }
  if (state.selectedCell) {
    renderCellInspector(host);
  } else if (state.selectedLine) {
    renderLineInspector(host);
  } else {
    renderOverview(host);
  }
}

function kv(host, pairs) {
  const dl = h("dl", { class: "kv" }, host);
  for (const [k, v] of pairs) {
    h("dt", { text: k }, dl);
    h("dd", { text: v }, dl);
  }
}

function renderOverview(host) {
  h("div", { class: "section-title", text: "总览" }, host);
  state.geom.levels.forEach((lv, li) => {
    const wrap = h("div", { style: "margin-bottom:10px" }, host);
    h("div", { style: "font-weight:640;font-size:12.5px;margin-bottom:4px" }, wrap)
      .textContent = `阈值 ${lv.level}`;
    lv.lines.forEach((line) => {
      const row = h("div", {
        class: "pill", style: "cursor:pointer",
      }, wrap);
      row.textContent = `${line.id} · ${line.open ? "开放" : "闭环"} · ${line.pointCount} 点`;
      row.addEventListener("click", () => {
        state.selectedLine = { levelIndex: li, lineId: line.id };
        renderStage(); renderInspector();
      });
    });
  });
}

function renderLineInspector(host) {
  const { levelIndex, lineId } = state.selectedLine;
  const lv = state.geom.levels[levelIndex];
  const line = lv.lines.find((l) => l.id === lineId);
  if (!line) return;
  h("div", { class: "section-title", text: "折线" }, host);
  const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px" }, host);
  h("span", { class: "badge " + (line.open ? "open" : "closed"), text: line.open ? "开放" : "闭环" }, head);
  h("code", { text: line.id, style: "font-family:var(--mono);font-size:12px" }, head);
  kv(host, [
    ["所属阈值", String(lv.level)],
    ["点数", String(line.pointCount)],
    ["开闭", line.open ? "开放（触边/掩膜，不封口）" : "闭环"],
    ["物理长度", fmtNum(line.length)],
    ["闭环面积", line.area === null ? "null（开放线）" : fmtNum(line.area)],
    ["父环", line.parentId ?? "null"],
  ]);
  h("div", { class: "section-title", text: "物理坐标点（前 8 个）" }, host);
  const list = h("div", { class: "pill-list" }, host);
  line.points.slice(0, 8).forEach((p) => {
    h("div", { class: "pill", text: `(${fmtNum(p[0])}, ${fmtNum(p[1])})` }, list);
  });
  if (line.points.length > 8) {
    h("div", { class: "hint", style: "margin-top:6px" }, host)
      .textContent = `其余 ${line.points.length - 8} 个点见 JSON 导出`;
  }
}

function renderCellInspector(host) {
  const { r, c } = state.selectedCell;
  const li = state.selectedLine ? state.selectedLine.levelIndex : 0;
  const info = cellInfo(state.topo, li, r, c);
  if (!info) return;
  h("div", { class: "section-title", text: `单元 (行 ${r}, 列 ${c})` }, host);
  const head = h("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:10px" }, host);
  h("span", {
    class: "badge " + (info.valid ? "closed" : "invalid"),
    text: info.valid ? "有效单元" : "无效（掩膜）",
  }, head);
  if (info.isSaddle) {
    h("span", { class: "badge open", text: "鞍点四交点" }, head);
  }
  kv(host, [
    ["阈值", String(info.level)],
    ["四角状态码", String(info.caseBits)],
    ...(info.isSaddle ? [["Q", fmtNum(info.Q)], ["Q 判据", info.Q > 0 ? "Q>0" : "Q≤0"]] : []),
  ]);

  h("div", { class: "section-title", text: "四角节点（a 左上 b 右上 c 右下 d 左下）" }, host);
  const grid = h("div", { class: "corner-grid" }, host);
  for (const key of ["a", "b", "c", "d"]) {
    const cn = info.corners[key];
    const card = h("div", { class: "corner-card" + (cn.above ? " above" : "") }, grid);
    h("div", { class: "pos", text: `${key} (${cn.node[0]},${cn.node[1]})` }, card);
    h("div", { class: "val", text: String(cn.value) }, card);
    h("div", { style: "font-size:11px;color:var(--fg-faint)" }, card)
      .textContent = cn.above ? "高于阈值" : "低于阈值";
  }

  h("div", { class: "section-title", text: `交点（${info.intersections.length}）` }, host);
  if (info.intersections.length) {
    const pl = h("div", { class: "pill-list" }, host);
    info.intersections.forEach((it) => {
      h("div", {
        class: "pill",
        text: `${it.edgeZh}边 · 分数 ${fmtNum(it.fraction)} · 节点(${fmtNum(it.nodePoint[0])}, ${fmtNum(it.nodePoint[1])})`,
      }, pl);
    });
  } else {
    h("div", { class: "hint" }, host).textContent = "该单元无交点（四角同侧）";
  }

  h("div", { class: "section-title", text: "连接选择" }, host);
  if (info.chosenPairs.length) {
    const pl = h("div", { class: "pill-list" }, host);
    info.chosenPairs.forEach((pair) => {
      h("div", { class: "pill", style: "border-color:var(--accent)" }, pl)
        .textContent = `实际连接：${pair[0]} – ${pair[1]}`;
    });
    if (info.alternativePairs) {
      info.alternativePairs.forEach((pair) => {
        h("div", {
          class: "pill", style: "opacity:.6;text-decoration:line-through",
        }, pl).textContent = `备选（未采用）：${pair[0]} – ${pair[1]}`;
      });
    }
  } else {
    h("div", { class: "hint" }, host).textContent = info.valid
      ? "该单元四角同侧，无等值线穿过"
      : "无效单元（四角未全部有效），不参与提线";
  }
}

function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(6)));
}

// ---------- 导出 ----------
function baseName() {
  return (state.image?.name || "contour").replace(/\.png$/i, "");
}

$("exportSvgBtn").addEventListener("click", () => {
  if (!state.geom) return;
  const svg = buildSvg(state.geom, { palette: state.palette, imageName: state.image?.name });
  download(`${baseName()}-contours.svg`, svg, "image/svg+xml");
  toast("已导出 SVG（仅闭环写 Z）");
});

$("exportJsonBtn").addEventListener("click", () => {
  if (!state.geom) return;
  const j = buildJson(state.geom, {
    image: state.image?.name ?? null,
    mask: state.maskName ?? null,
    nodesX: state.topo.width,
    nodesY: state.topo.height,
  });
  download(`${baseName()}-contours.json`, JSON.stringify(j, null, 2), "application/json");
  toast("已导出含物理坐标、父环与测量值的 JSON");
});

// 有拓扑后启用导出按钮
const origRender = renderAll;
renderAll = function () {
  origRender();
  const has = !!state.geom;
  $("exportSvgBtn").disabled = !has;
  $("exportJsonBtn").disabled = !has;
};

// 暴露给自动化测试做导出内容校验（应用本身不依赖 window.__atlas）
window.__atlas = {
  getState: () => state,
  buildSvg: (opts) => buildSvg(state.geom, { palette: state.palette, ...opts }),
  buildJson: (meta) => buildJson(state.geom, meta),
};
