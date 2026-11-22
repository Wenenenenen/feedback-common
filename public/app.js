import { parseFile, cleanMoov, isKeyframe } from "./mp4/parse.js";
import { buildOutput, buildOriginal } from "./mp4/write.js";

const ROW_HEIGHT = 29;
const OVERSCAN = 12;

const state = {
  model: null,
  moovClean: null,
  activeTrackId: null,
  order: "decode",
  cuts: new Set(), // global decode indices on the video track
  visibleRows: [],
};

const el = (id) => document.getElementById(id);
const big = (v) => (typeof v === "bigint" ? v.toString() : String(v));

function setText(id, text) {
  el(id).textContent = text;
}

function showError(container, message, kind = "error") {
  const div = document.createElement("div");
  div.className = `error-item ${kind === "warn" ? "warn" : ""}`;
  div.textContent = message;
  container.appendChild(div);
}

function formatFlags(f) {
  return "0x" + f.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

async function loadFile(file) {
  const statusPanel = el("status-panel");
  const workPanel = el("work-panel");
  const errBox = el("errors");
  statusPanel.classList.remove("hidden");
  workPanel.classList.add("hidden");
  errBox.textContent = "";
  setText("parse-progress", `解析中：${file.name}（${(file.size / 1048576).toFixed(1)} MiB）`);

  try {
    const model = await parseFile(file, (p) => {
      setText("parse-progress",
        `解析中：已扫描 ${p.fragments}/${p.total} 个分片（不读取 mdat 负载）`);
    });
    state.model = model;
    state.moovClean = await cleanMoov(model.moovBytes);
    model.moovClean = state.moovClean;
    setText("parse-progress", `解析完成：${model.fragments.length} 个分片，` +
      `${model.tracks.size} 条轨，用时见浏览器性能面板`);

    renderRangeErrors(model, errBox);
    renderTrackSummary(model);
    // Range errors make byte-exact repacking unsafe; only original export stays.
    const blocked = model.rangeErrors.length > 0;
    el("btn-export-new").disabled = blocked;
    el("btn-export-new").title = blocked
      ? "存在样本越界/重叠，无法保证重封装字节完整" : "";
    initCuts(model);
    buildTrackTabs(model);
    state.activeTrackId = model.videoId;
    document.querySelector('input[name="order"][value="decode"]').checked = true;
    state.order = "decode";
    renderTable();
    updatePreview();
    workPanel.classList.remove("hidden");
  } catch (e) {
    showError(errBox, `解析失败：${e.message}`);
    state.model = null;
    setText("parse-progress", "解析失败，未生成可用索引。");
  }
}

function renderRangeErrors(model, errBox) {
  for (const e of model.rangeErrors) {
    if (e.kind === "out-of-mdat") {
      showError(errBox,
        `样本越界：轨 ${e.trackId} 全局样本 #${e.sample}（原片段 ${e.fragment}）` +
        `引用字节 [${e.offset}, ${e.end})，未落在任何 mdat 负载内。`, "warn");
    } else {
      const a = e.a, b = e.b;
      showError(errBox,
        `样本重叠：轨 ${a.trackId} 样本 #${a.sample}（片段 ${a.fragment}，偏移 ${a.offset}）` +
        `与轨 ${b.trackId} 样本 #${b.sample}（片段 ${b.fragment}，偏移 ${b.offset}）字节区间相交。`, "warn");
    }
  }
}

function renderTrackSummary(model) {
  const box = el("track-summary");
  box.textContent = "";
  for (const id of model.trackOrder) {
    const t = model.tracks.get(id);
    const kind = t.meta.handler === "vide" ? "视频" : "音频";
    const chip = document.createElement("span");
    chip.className = "track-chip";
    chip.textContent =
      `${kind}轨 #${id} · ${t.count} 样本 · timescale ${t.meta.timescale}` +
      `${t.meta.handler === "vide" ? " · H.264" : " · AAC"}`;
    box.appendChild(chip);
  }
}

function initCuts(model) {
  state.cuts = new Set([0]); // 首视频样本始终是第一段起点
}

// ---------------------------------------------------------------------------
// Track tabs
// ---------------------------------------------------------------------------

function buildTrackTabs(model) {
  const tabs = el("track-tabs");
  tabs.textContent = "";
  for (const id of model.trackOrder) {
    const t = model.tracks.get(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.dataset.trackId = String(id);
    btn.textContent = (t.meta.handler === "vide" ? "视频轨 " : "音轨 ") + id;
    btn.addEventListener("click", () => {
      state.activeTrackId = id;
      renderTable();
    });
    tabs.appendChild(btn);
  }
}

function activeTrack() {
  return state.model.tracks.get(state.activeTrackId);
}

// Row ordering: decode order = natural index; display order = displayOrder map.
function rowIndices(track) {
  return state.order === "display" ? track.displayOrder : null;
}

function renderTable() {
  const model = state.model;
  const track = activeTrack();
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.trackId) === state.activeTrackId);
  });

  const body = el("grid-body");
  body.textContent = "";
  const wrap = el("scroll-wrap");
  wrap.scrollTop = 0;
  body.style.height = track.count * ROW_HEIGHT + "px";
  drawVisible();
}

function drawVisible() {
  const model = state.model;
  if (!model) return;
  const track = activeTrack();
  const wrap = el("scroll-wrap");
  const body = el("grid-body");
  const n = track.count;
  const scrollTop = wrap.scrollTop;
  const viewH = wrap.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(n, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN);
  body.textContent = "";

  const orderMap = rowIndices(track);
  const isVideo = state.activeTrackId === model.videoId;
  const frag = model.fragments;
  const frag0 = document.createDocumentFragment();

  for (let view = first; view < last; view++) {
    const gi = orderMap ? orderMap[view] : view;
    const key = isKeyframe(track, gi);
    const row = document.createElement("div");
    row.className = "virtual-row";
    row.style.top = view * ROW_HEIGHT + "px";

    const pts = track.ptsFallback ? track.pts[gi] : BigInt(track.pts[gi]);
    const checkCell = document.createElement("div");
    checkCell.className = "cell col-check";
    if (isVideo && key) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.cuts.has(gi);
      cb.addEventListener("change", () => {
        if (cb.checked) state.cuts.add(gi);
        else if (gi !== 0) state.cuts.delete(gi);
        else cb.checked = true; // 首帧边界不可取消
        updatePreview();
      });
      checkCell.appendChild(cb);
    }
    row.appendChild(checkCell);

    const cells = [
      String(gi),
      formatFlags(track.sampleFlags[gi]),
      key ? "关键帧" : "普通",
      big(track.dts[gi]),
      String(track.cts[gi]),
      big(pts),
      String(track.duration[gi]),
      String(track.size[gi]),
      String(track.offset[gi]),
      "#" + frag[track.frag[gi]].sequence,
    ];
    for (const text of cells) {
      const c = document.createElement("div");
      c.className = "cell";
      c.textContent = text;
      row.appendChild(c);
    }
    // mark keyframe cell visually
    row.children[3].classList.add(key ? "tag-key" : "tag-non");
    frag0.appendChild(row);
  }
  body.appendChild(frag0);
}

// ---------------------------------------------------------------------------
// Segment preview
// ---------------------------------------------------------------------------

function updatePreview() {
  const model = state.model;
  const video = model.tracks.get(model.videoId);
  const cutIndices = [...state.cuts].sort((a, b) => a - b);
  el("cut-count").textContent = String(cutIndices.length);

  const boundaries = cutIndices.map((gi) => video.dts[gi]);
  const parts = [];
  for (let s = 0; s < boundaries.length; s++) {
    const start = boundaries[s];
    const end = s + 1 < boundaries.length ? boundaries[s + 1] : null;
    parts.push(`段${s + 1}: DTS ${big(start)}${end === null ? " 起" : ` – ${big(end)}`}`);
  }

  let audioNote = "";
  if (model.audioId !== null) {
    const audio = model.tracks.get(model.audioId);
    // Count audio samples per segment for the preview.
    let seg = 0;
    const counts = new Array(boundaries.length).fill(0);
    for (let i = 0; i < audio.count; i++) {
      const d = audio.dts[i];
      while (seg + 1 < boundaries.length && d >= boundaries[seg + 1]) seg++;
      counts[seg]++;
    }
    audioNote = `；音轨样本分布 [${counts.join(", ")}]（同刻进后段）`;
  }
  el("seg-preview").textContent =
    `将生成 ${boundaries.length} 个新段${audioNote}。` +
    (parts.length <= 6 ? " " + parts.join("｜") : "");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportNew() {
  const model = state.model;
  if (!model) return;
  const video = model.tracks.get(model.videoId);
  const cutIndices = [...state.cuts].sort((a, b) => a - b);
  for (const gi of cutIndices) {
    if (!isKeyframe(video, gi)) {
      alert(`样本 #${gi} 不是关键帧，不能作为边界。`);
      return;
    }
  }
  const boundaries = cutIndices.map((gi) => video.dts[gi]);
  const btn = el("btn-export-new");
  btn.disabled = true;
  try {
    setText("export-progress", "重封装中…");
    const blob = await buildOutput(model, boundaries, cutIndices, (p) => {
      setText("export-progress", `写出段 ${p.segment}/${p.total}`);
    });
    download(blob, outputName(model, "repacked"));
    setText("export-progress", `完成：${(blob.size / 1048576).toFixed(2)} MiB`);
  } catch (e) {
    setText("export-progress", "导出失败：" + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function exportOriginal() {
  const model = state.model;
  if (!model) return;
  const btn = el("btn-export-original");
  btn.disabled = true;
  try {
    setText("export-progress", "按原方案导出…");
    const blob = await buildOriginal(model);
    download(blob, outputName(model, "original"));
    setText("export-progress", `完成：${(blob.size / 1048576).toFixed(2)} MiB`);
  } catch (e) {
    setText("export-progress", "导出失败：" + e.message);
  } finally {
    btn.disabled = false;
  }
}

function outputName(model, suffix) {
  const base = model.file.name.replace(/\.mp4$/i, "");
  return `${base}.${suffix}.mp4`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el("file-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) {
    el("file-name").textContent = f.name;
    loadFile(f);
  }
});

document.querySelectorAll('input[name="order"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.order = document.querySelector('input[name="order"]:checked').value;
    drawVisible();
  });
});

el("scroll-wrap").addEventListener("scroll", () => {
  requestAnimationFrame(drawVisible);
});

el("clear-cuts").addEventListener("click", () => {
  state.cuts = new Set([0]);
  drawVisible();
  updatePreview();
});

el("select-all-key").addEventListener("click", () => {
  const model = state.model;
  const video = model.tracks.get(model.videoId);
  for (let i = 0; i < video.count; i++) {
    if (isKeyframe(video, i)) state.cuts.add(i);
  }
  drawVisible();
  updatePreview();
});

el("btn-export-new").addEventListener("click", exportNew);
el("btn-export-original").addEventListener("click", exportOriginal);
