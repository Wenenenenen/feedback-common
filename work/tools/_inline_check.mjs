
import { parseSave, encodeV2, GWSVError, MAX_CHUNKS, MAX_ENTITIES, CELLS } from "./gwsv-core.js";

// ---------- 内置有效样例（world-v2.sav 的 base64） ----------
const DEMO_V2_B64 = "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";

// ---------- 应用状态 ----------
const state = {
  fileName: null,
  rawBytes: null,          // 原始导入字节
  world: null,             // { version, chunks, entities, errors }
  chunkIndex: new Map(),   // "x,y,z" -> chunk 对象
  selectedChunkKey: null,
  selectedCell: null,      // 0..511
  layer: 0,
  selectedEntityId: null,
  fatal: null,             // 致命错误（无法成世界）
  dirty: false,
  sourceLabel: "",
};

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function coordKey(c) { return c.join(","); }
function cellToXYZ(cell) {
  const x = cell % 8;
  const y = Math.floor(cell / 8) % 8;
  const z = Math.floor(cell / 64);
  return [x, y, z];
}
function xyzToCell(x, y, z) { return x + 8 * y + 64 * z; }
// 方块 ID -> 确定性颜色（0 交给空气样式）
function blockColor(id) {
  if (id === 0) return null;
  const hue = (id * 47 + 11) % 360;
  const sat = 58 + (id % 3) * 8;
  const light = 42 + ((id * 7) % 22);
  return `hsl(${hue} ${sat}% ${light}%)`;
}
function textOn(id) {
  // 与 blockColor 的 light 对应，决定格内数字明暗
  const light = 42 + ((id * 7) % 22);
  return light > 52 ? "#16202b" : "#ffffff";
}
function showToast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => { t.className = "toast"; }, 2600);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast("已复制到剪贴板"); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); showToast("已复制到剪贴板"); }
    catch { showToast("复制失败，请手动选择", true); }
    ta.remove();
  }
}

// ---------- 主题 ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("gwsv-theme"); } catch {}
  if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const darkNow = cur === "dark" || (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = darkNow ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("gwsv-theme", next); } catch {}
    if (state.world) renderGrid();
  });
}

// ---------- 加载与解析 ----------
function loadBytes(bytes, label) {
  state.fileName = label;
  state.rawBytes = bytes;
  state.fatal = null;
  state.dirty = false;
  state.selectedChunkKey = null;
  state.selectedCell = null;
  state.selectedEntityId = null;
  state.layer = 0;
  let parsed;
  try {
    parsed = parseSave(bytes);
  } catch (e) {
    if (e instanceof GWSVError) {
      state.fatal = { msg: e.message, offset: e.offset };
      state.world = null;
    } else {
      state.fatal = { msg: "未知解析错误: " + e.message, offset: null };
      state.world = null;
    }
    showFatal();
    return;
  }
  state.world = parsed;
  rebuildIndex();
  // 默认选第一个区块
  const first = [...state.chunkIndex.values()].sort((a, b) => cmp(a.coord, b.coord))[0];
  if (first) state.selectedChunkKey = coordKey(first.coord);
  $("dropzone").hidden = true;
  $("app").hidden = false;
  renderAll();
  if (parsed.errors.length === 0) showToast(`已载入 ${label}：校验通过`);
  else showToast(`已载入 ${label}：发现 ${parsed.errors.length} 项问题`, true);
}

function rebuildIndex() {
  state.chunkIndex = new Map();
  for (const c of state.world.chunks) state.chunkIndex.set(coordKey(c.coord), c);
}

function showFatal() {
  $("dropzone").hidden = true;
  $("app").hidden = false;
  $("statusBand").innerHTML = "";
  $("metrics").innerHTML = "";
  $("chunkList").innerHTML = "";
  $("entityList").innerHTML = "";
  $("voxelGrid").innerHTML = "";
  $("diagList").innerHTML = "";
  $("exportBtn").disabled = true;
  const off = state.fatal.offset != null ? `@offset ${state.fatal.offset}` : "";
  $("statusBand").innerHTML =
    `<div class="pill fatal"><span class="sev">致命</span><span>文件无法解析为世界</span>
       <span class="detail mono">${escapeHtml(state.fatal.msg)} ${off}</span></div>
     <div class="pill crit"><span class="sev">已拦截</span><span class="detail">该文件不会被展示为正常世界，也无法导出。请修复源文件后重新导入。</span></div>`;
  $("sliceTitle").textContent = "无可显示切片";
  $("roundtripNote").textContent = "";
}

// ---------- 实时校验（编辑后） ----------
function liveValidation() {
  const errs = [];
  const coordSet = new Set(state.world.chunks.map((c) => coordKey(c.coord)));
  const idSet = new Set();
  const dupIds = new Set();
  for (const e of state.world.entities) {
    if (idSet.has(e.id)) dupIds.add(e.id);
    idSet.add(e.id);
  }
  for (const id of dupIds) errs.push({ level: "error", msg: `实体 id 重复: ${id}`, offset: null, kind: "entity", id });
  for (const e of state.world.entities) {
    if (!coordSet.has(coordKey(e.chunk)))
      errs.push({ level: "error", msg: `实体 ${e.id} 位于不存在的区块 (${e.chunk.join(",")})`, offset: e.offset, kind: "entity", id: e.id });
    if (!Number.isInteger(e.cell) || e.cell < 0 || e.cell > 511)
      errs.push({ level: "error", msg: `实体 ${e.id} cell 越界: ${e.cell}`, offset: e.offset, kind: "entity", id: e.id });
    const seen = new Set();
    for (const t of e.links) {
      if (seen.has(t)) errs.push({ level: "error", msg: `实体 ${e.id} links 存在重复目标`, offset: e.offset, kind: "entity", id: e.id });
      seen.add(t);
      if (!idSet.has(t))
        errs.push({ level: "error", msg: `实体 ${e.id} 悬空链接 → 实体 ${t} (不存在)`, offset: e.offset, kind: "entity", id: e.id, target: t });
    }
  }
  // 区块不可读（CRC/索引损坏）
  for (const c of state.world.chunks) {
    if (c.voxels === null)
      errs.push({ level: "error", msg: `区块(${c.coord.join(",")}) 数据不可读，无法安全导出`, offset: c.crcOffset, kind: "chunk", coord: c.coord });
  }
  return errs;
}

function exportBlockedReasons() {
  const reasons = [];
  if (state.world.chunks.some((c) => c.voxels === null)) reasons.push("存在不可读区块（CRC 或调色板损坏）");
  const live = liveValidation();
  if (live.length) reasons.push(`存在 ${live.length} 项实体/引用校验问题`);
  return reasons;
}

// ---------- 渲染：总览 ----------
function renderAll() {
  renderStatus();
  renderMetrics();
  renderChunkList();
  renderGrid();
  renderEntityList();
  renderDiag();
  updateExportState();
}

function renderStatus() {
  const band = $("statusBand");
  const parseErrs = state.world.errors;
  const live = liveValidation();
  const unreadable = state.world.chunks.filter((c) => c.voxels === null).length;
  const total = parseErrs.length + live.length;
  band.innerHTML = "";
  if (total === 0) {
    band.innerHTML = `<div class="pill clean"><span class="sev">通过</span>
      <span>结构、CRC、调色板与实体引用全部有效</span>
      <span class="detail mono">源版本 v${state.world.version} · ${state.sourceLabel || state.fileName}${state.dirty ? " · 已编辑" : ""}</span></div>`;
  } else {
    const crit = unreadable > 0;
    band.innerHTML = `<div class="pill ${crit ? "crit" : "warn"}"><span class="sev">${crit ? "损坏" : "警告"}</span>
      <span>${total} 项问题（解析期 ${parseErrs.length} · 实时 ${live.length}）${unreadable ? `，${unreadable} 个区块不可读` : ""}</span>
      <span class="detail">问题数据不会被当作正常世界；修复引用类问题后方可导出</span></div>`;
  }
}

function renderMetrics() {
  const w = state.world;
  const entByChunk = countEntitiesByChunk();
  let nonAir = 0, distinct = new Set();
  for (const c of w.chunks) if (c.voxels) for (const v of c.voxels) { if (v) nonAir++; distinct.add(v); }
  const unread = w.chunks.filter((c) => c.voxels === null).length;
  const dangling = countDangling();
  const items = [
    ["区块", `${w.chunks.length}/${MAX_CHUNKS}`, unread ? true : false],
    ["实体", `${w.entities.length}/${MAX_ENTITIES}`, false],
    ["非空气方块", String(nonAir), false],
    ["不同方块 ID", String(distinct.size), false],
    ["不可读区块", String(unread), unread > 0],
    ["悬空链接", String(dangling), dangling > 0],
  ];
  $("metrics").innerHTML = items.map(([k, v, bad]) =>
    `<div class="metric"><div class="k">${k}</div><div class="v ${bad ? "bad" : ""} mono">${v}</div></div>`).join("");
}

function countEntitiesByChunk() {
  const m = new Map();
  for (const e of state.world.entities) {
    const k = coordKey(e.chunk);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function countDangling() {
  const ids = new Set(state.world.entities.map((e) => e.id));
  let n = 0;
  for (const e of state.world.entities) for (const t of e.links) if (!ids.has(t)) n++;
  return n;
}

// ---------- 渲染：区块列表 ----------
function renderChunkList() {
  const filter = $("chunkFilter").value.trim().toLowerCase();
  const entByChunk = countEntitiesByChunk();
  const sorted = [...state.world.chunks].sort((a, b) => cmp(a.coord, b.coord));
  $("chunkCountHint").textContent = `${sorted.length} 个`;
  const items = sorted.filter((c) => !filter || coordKey(c.coord).toLowerCase().includes(filter));
  $("chunkList").innerHTML = items.map((c) => {
    const k = coordKey(c.coord);
    const selected = k === state.selectedChunkKey;
    const unread = c.voxels === null;
    const nEnt = entByChunk.get(k) || 0;
    const ids = state.world.entities.filter((e) => coordKey(e.chunk) === k).map((e) => e.id);
    const used = unread ? 0 : new Set(c.voxels.filter((v) => v !== 0)).size;
    return `<div class="chunk-item ${selected ? "selected" : ""} ${unread ? "unreadable" : ""}" data-key="${k}">
      <div class="row1">
        <span class="coord">(${c.coord.join(", ")})</span>
        ${unread ? '<span class="chunk-badge err">不可读</span>' : ""}
        <button class="btn sm danger del" data-del="${k}" ${nEnt > 0 ? "disabled title='该区块含实体，禁止删除'" : ""}>删除</button>
      </div>
      <div class="meta">
        <span>${unread ? "payload 损坏" : used + " 种方块"}</span>
        <span>${nEnt} 个实体</span>
        <span class="mono">head@${c.headOffset}</span>
      </div>
      ${ids.length ? `<div class="mini-entities">${ids.map((id) => `<span class="e-chip">#${id}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("") || `<p style="color:var(--faint);font-size:12.5px;">无匹配区块</p>`;

  $("chunkList").querySelectorAll(".chunk-item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-del]")) return;
      selectChunk(el.dataset.key);
    });
  });
  $("chunkList").querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      tryDeleteChunk(btn.dataset.del);
    });
  });
}

function selectChunk(key) {
  state.selectedChunkKey = key;
  const c = state.chunkIndex.get(key);
  state.layer = 0;
  $("layerRange").value = 0;
  state.selectedCell = null;
  renderChunkList();
  renderGrid();
}

function tryDeleteChunk(key) {
  const c = state.chunkIndex.get(key);
  const ents = state.world.entities.filter((e) => coordKey(e.chunk) === key);
  if (ents.length) {
    showToast(`拒绝删除：区块 (${key}) 含 ${ents.length} 个实体（${ents.map((e) => "#" + e.id).join("、")}），请先迁移实体`, true);
    return;
  }
  state.world.chunks = state.world.chunks.filter((x) => coordKey(x.coord) !== key);
  state.chunkIndex.delete(key);
  if (state.selectedChunkKey === key) {
    const next = [...state.chunkIndex.values()].sort((a, b) => cmp(a.coord, b.coord))[0];
    state.selectedChunkKey = next ? coordKey(next.coord) : null;
  }
  state.dirty = true;
  renderAll();
  showToast(`已删除区块 (${key})`);
}

// ---------- 渲染：8x8 切片 ----------
function renderGrid() {
  const grid = $("voxelGrid");
  const c = state.chunkIndex.get(state.selectedChunkKey);
  $("layerLabel").textContent = `z = ${state.layer}`;
  $("layerRange").value = state.layer;
  // 轴标签
  $("xAxis").innerHTML = '<span class="lab"></span>' + Array.from({ length: 8 }, (_, x) => `<span class="lab">x${x}</span>`).join("");
  $("yAxis").innerHTML = Array.from({ length: 8 }, (_, i) => {
    const y = 7 - i;
    return `<span class="lab">y${y}</span>`;
  }).join("");

  if (!c) {
    $("sliceTitle").textContent = "高度切片";
    grid.innerHTML = "";
    $("voxelEditor").style.opacity = .5;
    return;
  }
  $("sliceTitle").textContent = `高度切片 · 区块 (${c.coord.join(", ")})`;
  $("voxelEditor").style.opacity = 1;
  const entCells = new Set(state.world.entities
    .filter((e) => coordKey(e.chunk) === state.selectedChunkKey)
    .map((e) => e.cell));

  if (c.voxels === null) {
    grid.innerHTML = Array.from({ length: 64 }, () =>
      '<div class="cell unreadable-cell" title="区块数据不可读"></div>').join("");
    $("veCoords").textContent = "";
    $("idInput").value = "";
    $("idInput").disabled = true;
    $("applyIdBtn").disabled = true;
    $("setAirBtn").disabled = true;
    $("veEntityInfo").innerHTML = '<span class="ve-err">此区块 payload 未通过校验，方块数据不可信，已禁止编辑与导出。</span>';
    return;
  }
  $("idInput").disabled = false;
  $("applyIdBtn").disabled = false;
  $("setAirBtn").disabled = false;
  $("veEntityInfo").innerHTML = "";

  const z = state.layer;
  let html = "";
  for (let row = 0; row < 8; row++) {
    const y = 7 - row; // 顶部显示 y=7
    for (let x = 0; x < 8; x++) {
      const cell = xyzToCell(x, y, z);
      const id = c.voxels[cell];
      const isAir = id === 0;
      const sel = state.selectedCell === cell;
      const hasEnt = entCells.has(cell);
      const color = blockColor(id);
      const style = isAir ? "" : `background:${color};color:${textOn(id)};border-color:transparent;`;
      html += `<div class="cell ${isAir ? "air" : ""} ${sel ? "selected" : ""} ${hasEnt ? "has-entity" : ""}"
                data-cell="${cell}" style="${style}" title="cell ${cell} · (x${x},y${y},z${z}) · ID ${id}">${isAir ? "" : id}</div>`;
    }
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".cell").forEach((el) => {
    el.addEventListener("click", () => selectCell(parseInt(el.dataset.cell, 10)));
  });
  renderVoxelEditor();
}

function selectCell(cell) {
  state.selectedCell = cell;
  renderGrid();
}

function renderVoxelEditor() {
  const c = state.chunkIndex.get(state.selectedChunkKey);
  const errEl = $("veErr");
  errEl.hidden = true;
  if (!c || c.voxels === null || state.selectedCell === null) {
    $("veCoords").textContent = state.selectedCell === null ? "点击网格中的方块以选择" : "";
    if (state.selectedCell === null) { $("idInput").value = ""; $("veSwatch").style.background = "var(--air)"; }
    return;
  }
  const cell = state.selectedCell;
  const [lx, ly, lz] = cellToXYZ(cell);
  const id = c.voxels[cell];
  const gx = c.coord[0] * 8 + lx, gy = c.coord[1] * 8 + ly, gz = c.coord[2] * 8 + lz;
  $("veCoords").textContent = `cell ${cell} · 局部 (${lx},${ly},${lz}) · 世界 (${gx},${gy},${gz})`;
  $("idInput").value = id;
  $("idInput").classList.remove("invalid");
  const col = blockColor(id);
  $("veSwatch").style.background = col || "var(--air)";
  const ents = state.world.entities.filter((e) => coordKey(e.chunk) === state.selectedChunkKey && e.cell === cell);
  $("veEntityInfo").innerHTML = ents.length
    ? `<span class="backlink">此格实体：${ents.map((e) => `#${e.id}`).join("、")}（实体允许位于空气方块）</span>`
    : "";
}

function applyVoxelId() {
  const c = state.chunkIndex.get(state.selectedChunkKey);
  if (!c || c.voxels === null || state.selectedCell === null) return;
  const raw = $("idInput").value.trim();
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(id) || id < 0 || id > 65535) {
    $("idInput").classList.add("invalid");
    $("veErr").textContent = "方块 ID 必须是 0–65535 的整数";
    $("veErr").hidden = false;
    return;
  }
  $("idInput").classList.remove("invalid");
  $("veErr").hidden = true;
  c.voxels[state.selectedCell] = id;
  state.dirty = true;
  renderGrid();
  renderMetrics();
  renderStatus();
  updateExportState();
  showToast(`cell ${state.selectedCell} 已设为方块 ${id}`);
}

// ---------- 渲染：实体 ----------
function renderEntityList() {
  const filter = $("entityFilter").value.trim().replace("#", "");
  const ids = new Set(state.world.entities.map((e) => e.id));
  const backlinks = new Map();
  for (const e of state.world.entities) for (const t of e.links) {
    if (!backlinks.has(t)) backlinks.set(t, []);
    backlinks.get(t).push(e.id);
  }
  const sorted = [...state.world.entities].sort((a, b) => a.id - b.id);
  $("entityCountHint").textContent = `${sorted.length} 个`;
  const items = sorted.filter((e) => !filter || String(e.id).includes(filter));
  $("entityList").innerHTML = items.map((e) => {
    const sel = e.id === state.selectedEntityId;
    const linksHtml = e.links.length
      ? e.links.map((t) => `<span class="link-target ${ids.has(t) ? "" : "dangling"}" data-link="${t}" title="${ids.has(t) ? "跳转到实体 " + t : "悬空引用：实体 " + t + " 不存在"}">→${t}${ids.has(t) ? "" : " ✕"}</span>`).join("")
      : '<span class="backlink">无链接</span>';
    const bl = backlinks.get(e.id) || [];
    const chunkExists = state.chunkIndex.has(coordKey(e.chunk));
    return `<div class="entity-card ${sel ? "selected" : ""}" data-eid="${e.id}">
      <div class="ec-top">
        <span class="eid">#${e.id}</span>
        <span class="loc">(${e.chunk.join(",")}) · cell ${e.cell}</span>
        ${chunkExists ? "" : '<span class="chunk-badge err">区块缺失</span>'}
      </div>
      <div class="links">${linksHtml}</div>
      <div class="backlink">被引用：${bl.length ? bl.map((x) => "#" + x).join("、") : "无"}</div>
      <div class="ec-actions">
        <button class="btn sm" data-move="${e.id}">移动 / 改链接</button>
      </div>
      <div class="move-form" id="moveForm-${e.id}" hidden></div>
    </div>`;
  }).join("") || `<p style="color:var(--faint);font-size:12.5px;">无匹配实体</p>`;

  $("entityList").querySelectorAll(".entity-card").forEach((el) => {
    el.querySelector("[data-move]").addEventListener("click", () => toggleMoveForm(parseInt(el.dataset.eid, 10)));
  });
  $("entityList").querySelectorAll("[data-link]").forEach((el) => {
    el.addEventListener("click", () => {
      const target = parseInt(el.dataset.link, 10);
      const ent = state.world.entities.find((x) => x.id === target);
      if (ent) { selectEntity(target); showToast(`已定位到实体 #${target}`); }
      else showToast(`实体 ${target} 不存在（悬空引用）`, true);
    });
  });
}

function selectEntity(id) {
  state.selectedEntityId = id;
  const e = state.world.entities.find((x) => x.id === id);
  if (e) {
    state.selectedChunkKey = coordKey(e.chunk);
    state.layer = Math.floor(e.cell / 64);
    state.selectedCell = e.cell;
  }
  renderChunkList();
  renderGrid();
  renderEntityList();
}

function toggleMoveForm(id) {
  state.selectedEntityId = id;
  renderEntityList();
  const form = $("moveForm-" + id);
  form.hidden = !form.hidden;
  if (form.hidden) return;
  const e = state.world.entities.find((x) => x.id === id);
  const chunkOpts = [...state.world.chunks].sort((a, b) => cmp(a.coord, b.coord))
    .map((c) => `<option value="${coordKey(c.coord)}" ${coordKey(c.coord) === coordKey(e.chunk) ? "selected" : ""}>(${c.coord.join(", ")})${c.voxels === null ? " [不可读]" : ""}</option>`).join("");
  form.innerHTML = `
    <div class="mf-row"><label>目标区块</label><select id="mf-chunk-${id}">${chunkOpts}</select></div>
    <div class="mf-row"><label>目标 cell</label><input id="mf-cell-${id}" type="number" min="0" max="511" value="${e.cell}"></div>
    <div class="mf-row"><label>添加链接</label>
      <div class="link-edit-row"><input id="mf-link-${id}" type="number" min="1" placeholder="目标实体 ID"><button class="btn sm" id="mf-addlink-${id}">添加</button></div>
    </div>
    <div class="mf-row"><label>当前链接</label><div id="mf-links-${id}">${renderLinkChips(e)}</div></div>
    <div class="mf-err" id="mf-err-${id}" hidden></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn sm primary" id="mf-apply-${id}">应用移动</button>
    </div>`;
  $("mf-apply-" + id).addEventListener("click", () => applyMove(id));
  $("mf-addlink-" + id).addEventListener("click", () => addLink(id));
  form.querySelectorAll("[data-rmlink]").forEach((b) => b.addEventListener("click", () => removeLink(id, parseInt(b.dataset.rmlink, 10))));
}

function renderLinkChips(e) {
  if (!e.links.length) return '<span class="backlink">无</span>';
  const ids = new Set(state.world.entities.map((x) => x.id));
  return e.links.map((t) =>
    `<span class="link-target ${ids.has(t) ? "" : "dangling"}">→${t}
       <button data-rmlink="${t}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;padding:0 0 0 4px;">×</button>
     </span>`).join("");
}

function mfError(id, msg) {
  const el = $("mf-err-" + id);
  el.textContent = msg; el.hidden = false;
}
function applyMove(id) {
  const e = state.world.entities.find((x) => x.id === id);
  const key = $("mf-chunk-" + id).value;
  const target = state.chunkIndex.get(key);
  const cellRaw = $("mf-cell-" + id).value.trim();
  const cell = Number(cellRaw);
  if (!target) { mfError(id, "目标区块不存在，移动已拒绝"); return; }
  if (!/^\d+$/.test(cellRaw) || !Number.isInteger(cell) || cell < 0 || cell > 511) {
    mfError(id, "cell 必须是 0–511 的整数"); return;
  }
  e.chunk = target.coord.slice();
  e.cell = cell;
  state.dirty = true;
  $("mf-err-" + id).hidden = true;
  renderAll();
  showToast(`实体 #${id} 已移动到 (${target.coord.join(",")}) cell ${cell}`);
}
function addLink(id) {
  const e = state.world.entities.find((x) => x.id === id);
  const raw = $("mf-link-" + id).value.trim();
  const t = Number(raw);
  const ids = new Set(state.world.entities.map((x) => x.id));
  if (!/^\d+$/.test(raw) || !Number.isInteger(t) || t <= 0) { mfError(id, "请输入正整数实体 ID"); return; }
  if (t === id) { mfError(id, "实体不能链接到自身"); return; }
  if (!ids.has(t)) { mfError(id, `实体 ${t} 不存在，不能建立链接（会造成悬空引用）`); return; }
  if (e.links.includes(t)) { mfError(id, `链接 →${t} 已存在`); return; }
  e.links.push(t);
  $("mf-link-" + id).value = "";
  state.dirty = true;
  $("mf-err-" + id).hidden = true;
  renderAll();
  toggleMoveForm(id);
}
function removeLink(id, target) {
  const e = state.world.entities.find((x) => x.id === id);
  e.links = e.links.filter((t) => t !== target);
  state.dirty = true;
  renderAll();
  toggleMoveForm(id);
}

// ---------- 渲染：诊断 ----------
function renderDiag() {
  const parseErrs = state.world.errors.map((e) => ({ ...e, phase: "解析期" }));
  const live = liveValidation().map((e) => ({ ...e, phase: "实时" }));
  const all = [...parseErrs, ...live];
  const list = $("diagList");
  if (!all.length) {
    list.innerHTML = '<div class="diag-empty">✓ 无诊断问题：所有 CRC 有效、调色板索引合法、实体引用完整</div>';
    return;
  }
  list.innerHTML = all.map((e, i) => {
    const off = e.offset != null ? `<span class="d-off">offset ${e.offset}</span>` : '<span class="d-off">编辑期问题</span>';
    let locBtn = "";
    if (e.kind === "chunk" && e.coord) locBtn = `<button class="d-loc" data-loc-chunk="${coordKey(e.coord)}">定位区块</button>`;
    else if (e.kind === "entity" && e.id != null) locBtn = `<button class="d-loc" data-loc-entity="${e.id}">定位实体 #${e.id}</button>`;
    return `<div class="diag-item error">
      <span class="sev" style="font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--crit);">${e.phase}</span>
      <span class="d-msg">${escapeHtml(e.msg)}</span>
      <span style="display:flex;gap:8px;align-items:center;">${off}${locBtn}</span>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-loc-chunk]").forEach((b) => b.addEventListener("click", () => selectChunk(b.dataset.locChunk)));
  list.querySelectorAll("[data-loc-entity]").forEach((b) => b.addEventListener("click", () => selectEntity(parseInt(b.dataset.locEntity, 10))));
}

// ---------- 导出 ----------
function updateExportState() {
  const reasons = exportBlockedReasons();
  $("exportBtn").disabled = reasons.length > 0;
  $("exportBtn").title = reasons.length ? reasons.join("；") : "生成规范化 v2 存档";
  $("roundtripNote").textContent = reasons.length
    ? "导出被阻止：" + reasons.join("；")
    : "导出文件重新导入将得到完全相同的世界与引用关系（规范化编码幂等）。";
}

function doExport() {
  const reasons = exportBlockedReasons();
  if (reasons.length) { showToast("导出被阻止：" + reasons.join("；"), true); return; }
  const enc = encodeV2(state.world);
  if (enc.length > 8 * 1024 * 1024) { showToast("编码结果超过 8MB", true); return; }
  // 导出后立即回读校验：重新解析必须零错误且语义一致
  let reparsed, rtOk = false;
  try {
    reparsed = parseSave(enc);
    rtOk = reparsed.errors.length === 0 &&
      JSON.stringify(semanticOf(state.world)) === JSON.stringify(semanticOf(reparsed));
  } catch (err) { rtOk = false; }
  const fname = (state.fileName && state.fileName.endsWith(".sav"))
    ? state.fileName.replace(/\.sav$/i, "") + "-canonical-v2.sav"
    : "world-canonical-v2.sav";
  const blob = new Blob([enc], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  // 沙盒可能拦截下载：提供 base64 兜底
  $("roundtripNote").innerHTML =
    `${rtOk ? "✓ 回读校验通过：重新解析零错误，世界与引用完全一致。" : "✗ 回读校验失败，请勿使用该输出。"}
     若浏览器未触发下载，<button class="btn sm" id="b64Btn" type="button">复制 base64</button>
     <span class="mono" style="font-size:11px;">(${enc.length} 字节, v2)</span>`;
  const b64btn = $("b64Btn");
  if (b64btn) b64btn.addEventListener("click", () => {
    let bin = "";
    for (const by of enc) bin += String.fromCharCode(by);
    copyText(btoa(bin));
  });
  showToast(rtOk ? "已生成规范化 v2 并通过回读校验" : "导出校验失败", !rtOk);
}

function semanticOf(w) {
  return {
    chunks: [...w.chunks].sort((a, b) => cmp(a.coord, b.coord))
      .map((c) => ({ coord: c.coord, voxels: Array.from(c.voxels || []) })),
    entities: [...w.entities].sort((a, b) => a.id - b.id)
      .map((e) => ({ cell: e.cell, chunk: e.chunk, id: e.id, links: e.links })),
  };
}

// ---------- 杂项 ----------
function cmp(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    const f = $("fileInput").files[0];
    if (f) readFile(f);
    $("fileInput").value = "";
  });
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragging"); }));
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  $("loadDemoBtn").addEventListener("click", () => {
    const bytes = b64ToBytes(DEMO_V2_B64);
    state.sourceLabel = "内置有效样例";
    loadBytes(bytes, "demo-world-v2.sav");
  });
  $("loadCorruptDemoBtn").addEventListener("click", () => {
    const bytes = b64ToBytes(DEMO_V2_B64);
    // 翻转第一个区块 payload 的首字节（offset 19），其 CRC 随即失配——在内存中制造损坏，不改动样例
    bytes[19] ^= 0xff;
    state.sourceLabel = "内置 CRC 损坏样例（演示）";
    loadBytes(bytes, "demo-bad-crc.sav");
  });
  $("exportBtn").addEventListener("click", doExport);
  $("layerUp").addEventListener("click", () => { state.layer = Math.min(7, state.layer + 1); renderGrid(); });
  $("layerDown").addEventListener("click", () => { state.layer = Math.max(0, state.layer - 1); renderGrid(); });
  $("layerRange").addEventListener("input", () => { state.layer = parseInt($("layerRange").value, 10); renderGrid(); });
  $("applyIdBtn").addEventListener("click", applyVoxelId);
  $("setAirBtn").addEventListener("click", () => { $("idInput").value = "0"; applyVoxelId(); });
  $("idInput").addEventListener("keydown", (e) => { if (e.key === "Enter") applyVoxelId(); });
  $("chunkFilter").addEventListener("input", renderChunkList);
  $("entityFilter").addEventListener("input", renderEntityList);
}

function readFile(file) {
  if (file.size > 8 * 1024 * 1024) { showToast("文件超过 8MB 上限", true); return; }
  const fr = new FileReader();
  fr.onload = () => {
    state.sourceLabel = "用户导入";
    loadBytes(new Uint8Array(fr.result), file.name);
  };
  fr.onerror = () => showToast("读取文件失败", true);
  fr.readAsArrayBuffer(file);
}

// ---------- 启动 ----------
initTheme();
bindEvents();
