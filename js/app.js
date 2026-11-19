/*
 * app.js — 页面主逻辑：导入、参数联动重算、图表、试听、表格、导出
 */
import { analyzePlayout, buildExportJson, STATUS } from "./engine.js";
import { buildWavBlob, expectedWavSize } from "./wav.js";
import { JitterChart, PlayoutStrip, WaveformChart } from "./charts.js";
import { buildDemoDoc } from "./demo.js";

const state = {
  doc: null,
  fileName: null,
  result: null,
  delayMs: 30,
  policy: "zero",
  packetPage: 0,
  slotPage: 0,
  pageSize: 25,
  filter: "all",
  audioCtx: null,
  audioBuffer: null,
  sourceNode: null,
  startedAt: 0,
  offsetAtStart: 0,
  playing: false,
};

const $ = (id) => document.getElementById(id);
const fmtUs = (us) =>
  us === null || us === undefined ? "—" : Math.abs(us) >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us} µs`;

const STATUS_LABEL = {
  accepted: "接收",
  late: "迟到",
  duplicate: "重复",
  invalid: "无效",
  "concealed-zero": "补零",
  "concealed-decay": "衰减补偿",
};

/* ---------------- 导入 ---------------- */

async function importFile(file) {
  try {
    const text = await file.text();
    const doc = JSON.parse(text);
    loadDoc(doc, file.name);
  } catch (e) {
    showImportError(`JSON 解析失败：${e.message}`);
  }
}

function showImportError(msg) {
  const el = $("import-error");
  el.textContent = msg;
  el.hidden = false;
}

function loadDoc(doc, name) {
  $("import-error").hidden = true;
  state.doc = doc;
  state.fileName = name;
  state.packetPage = 0;
  state.slotPage = 0;
  stopPlayback();
  $("file-label").textContent = name;
  recompute();
}

/* ---------------- 重算 ---------------- */

function recompute() {
  if (!state.doc) return;
  const result = analyzePlayout(state.doc, state.delayMs, state.policy);
  if (!result.ok) {
    showImportError("文档不符合约定：" + result.errors.join("；"));
    return;
  }
  state.result = result;
  state.audioBuffer = null;
  renderAll();
}

function renderAll() {
  renderHeader();
  renderStats();
  jitter.setData(state.result);
  strip.setData(state.result);
  wave.setData(state.result);
  renderPacketTable();
  renderSlotTable();
  updateExportInfo();
  stopPlayback();
}

/* ---------------- 概要与统计 ---------------- */

function renderHeader() {
  const h = state.result.header;
  $("doc-summary").innerHTML = `
    <div><span class="kv-k">采样率</span><span class="kv-v">${h.rate} Hz</span></div>
    <div><span class="kv-k">声道</span><span class="kv-v">${h.channels === 1 ? "单声道" : "立体声"}</span></div>
    <div><span class="kv-k">帧/包</span><span class="kv-v">${h.fpp}</span></div>
    <div><span class="kv-k">槽数</span><span class="kv-v">${h.total}</span></div>
    <div><span class="kv-k">时长</span><span class="kv-v">${h.durationSec.toFixed(3)} s</span></div>
    <div><span class="kv-k">PCM</span><span class="kv-v">${(state.result.pcm.length / 1024).toFixed(1)} KiB</span></div>`;
}

function renderStats() {
  const count = { accepted: 0, late: 0, duplicate: 0, invalid: 0 };
  for (const p of state.result.packets) count[p.status]++;
  const total = state.result.header.total;
  const concealed = state.result.slots.filter((s) => s.source === null).length;
  const stats = [
    { label: "接收 accepted", value: count.accepted, cls: "accepted" },
    { label: "迟到 late", value: count.late, cls: "late" },
    { label: "重复 duplicate", value: count.duplicate, cls: "duplicate" },
    { label: "无效 invalid", value: count.invalid, cls: "invalid" },
    { label: "补偿槽位", value: `${concealed}/${total}`, cls: "conceal" },
    { label: "播放覆盖率", value: `${(((total - concealed) / total) * 100).toFixed(1)}%`, cls: "cover" },
  ];
  $("stats").innerHTML = stats
    .map(
      (s) => `<div class="stat stat-${s.cls}">
        <div class="stat-value">${s.value}</div>
        <div class="stat-label">${s.label}</div></div>`,
    )
    .join("");
}

/* ---------------- 逐包表格 ---------------- */

function filteredPackets() {
  const list = state.result.packets;
  if (state.filter === "all") return list;
  return list.filter((p) => p.status === state.filter);
}

function renderPacketTable() {
  const list = filteredPackets();
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  if (state.packetPage >= pages) state.packetPage = pages - 1;
  const rows = list.slice(state.packetPage * state.pageSize, (state.packetPage + 1) * state.pageSize);
  $("packet-rows").innerHTML = rows
    .map(
      (p) => `<tr data-slot="${p.slot ?? ""}">
      <td>${p.id}</td>
      <td class="num">${p.input_index}</td>
      <td class="num">${p.arrival_us === null ? "—" : fmtUs(p.arrival_us)}</td>
      <td class="num">${p.seq ?? "—"}</td>
      <td class="num">${p.slot ?? "—"}</td>
      <td class="num">${p.deadline_us === null ? "—" : fmtUs(p.deadline_us)}</td>
      <td><span class="badge badge-${p.status}">${STATUS_LABEL[p.status]}</span></td>
      <td class="reason">${p.reason}</td>
    </tr>`,
    )
    .join("");
  $("packet-page-info").textContent =
    `第 ${state.packetPage + 1}/${pages} 页 · ${list.length} 个包（按到达顺序，含输入索引）`;
  $("packet-prev").disabled = state.packetPage === 0;
  $("packet-next").disabled = state.packetPage >= pages - 1;
}

/* ---------------- 逐槽表格 ---------------- */

function renderSlotTable() {
  const list = state.result.slots;
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  if (state.slotPage >= pages) state.slotPage = pages - 1;
  const rows = list.slice(state.slotPage * state.pageSize, (state.slotPage + 1) * state.pageSize);
  $("slot-rows").innerHTML = rows
    .map((s) => {
      const badge =
        s.source !== null
          ? `<span class="badge badge-accepted">${s.source}</span>`
          : s.status === "late"
            ? `<span class="badge badge-late">迟到占槽</span>`
            : `<span class="badge badge-conceal">${s.conceal ?? "补零"}</span>`;
      return `<tr data-slot="${s.slot}">
        <td class="num">${s.slot}</td>
        <td class="num">${fmtUs(s.deadline_us)}</td>
        <td>${badge}</td>
        <td class="reason">${
          s.source !== null
            ? `播放槽使用包 ${s.source}`
            : s.status === "late"
              ? "占用槽位的包迟到，播放内容已按策略补偿，迟到包不改写"
              : `该槽无接收包，按 ${state.policy} 策略补偿`
        }</td>
      </tr>`;
    })
    .join("");
  $("slot-page-info").textContent = `第 ${state.slotPage + 1}/${pages} 页 · 共 ${list.length} 个播放槽`;
  $("slot-prev").disabled = state.slotPage === 0;
  $("slot-next").disabled = state.slotPage >= pages - 1;
}

/* ---------------- 试听 ---------------- */

function ensureAudioBuffer() {
  if (state.audioBuffer) return state.audioBuffer;
  const { rate, channels, fpp, total } = state.result.header;
  const ctx = getAudioCtx();
  const buffer = ctx.createBuffer(channels, fpp * total, rate);
  const view = new DataView(state.result.pcm.buffer, state.result.pcm.byteOffset, state.result.pcm.byteLength);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < fpp * total; i++) {
      data[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
    }
  }
  state.audioBuffer = buffer;
  return buffer;
}

function getAudioCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  return state.audioCtx;
}

function play(offset = 0) {
  const ctx = getAudioCtx();
  ctx.resume();
  stopPlayback();
  const node = ctx.createBufferSource();
  node.buffer = ensureAudioBuffer();
  node.connect(ctx.destination);
  node.start(0, offset);
  node.onended = () => {
    if (state.sourceNode === node) {
      state.playing = false;
      $("play-btn").textContent = "播放";
    }
  };
  state.sourceNode = node;
  state.startedAt = ctx.currentTime;
  state.offsetAtStart = offset;
  state.playing = true;
  $("play-btn").textContent = "停止";
  requestAnimationFrame(tickPlayhead);
}

function stopPlayback() {
  if (state.sourceNode) {
    try {
      state.sourceNode.onended = null;
      state.sourceNode.stop();
    } catch (e) {
      /* 已停止 */
    }
    state.sourceNode = null;
  }
  state.playing = false;
  const btn = $("play-btn");
  if (btn) btn.textContent = "播放";
  const t = $("play-time");
  if (t && state.audioBuffer) t.textContent = `0.00 / ${state.audioBuffer.duration.toFixed(2)} s`;
  if (typeof wave !== "undefined" && wave) wave.setPlayhead(0);
}

function tickPlayhead() {
  if (!state.playing || !state.audioCtx) return;
  const sec = state.audioCtx.currentTime - state.startedAt + state.offsetAtStart;
  const dur = state.audioBuffer.duration;
  if (sec >= dur) {
    wave.setPlayhead(dur);
    stopPlayback();
    return;
  }
  wave.setPlayhead(sec);
  $("play-time").textContent = `${sec.toFixed(2)} / ${dur.toFixed(2)} s`;
  requestAnimationFrame(tickPlayhead);
}

/* ---------------- 导出 ---------------- */

function updateExportInfo() {
  const { fpp, total, channels, rate } = state.result.header;
  const size = expectedWavSize(total, fpp, channels);
  $("export-info").textContent =
    `WAV：${rate} Hz / ${channels === 1 ? "单声道" : "立体声"} / 16-bit，` +
    `${size} 字节（44 头 + ${size - 44} PCM），时长 ${((total * fpp) / rate).toFixed(3)} s`;
}

function exportWav() {
  const blob = buildWavBlob(state.result.pcm, state.result.header.rate, state.result.header.channels);
  downloadBlob(blob, baseName() + `_${state.delayMs}ms_${state.policy}.wav`);
}

function exportJson() {
  const payload = buildExportJson(state.result);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, baseName() + `_${state.delayMs}ms_${state.policy}_verdicts.json`);
}

function baseName() {
  return (state.fileName || "capture").replace(/\.json$/i, "");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- 主题 ---------------- */

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("pap-theme");
  } catch (e) {
    /* storage 不可用 */
  }
  if (saved) document.documentElement.dataset.theme = saved;
  $("theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("pap-theme", next);
    } catch (e) {
      /* 忽略 */
    }
    if (state.result) renderAll();
  });
}

/* ---------------- 联动 ---------------- */

let jitter;
let strip;
let wave;

function linkHover(slot) {
  document.querySelectorAll("tr[data-slot]").forEach((tr) => {
    tr.classList.toggle("row-hot", slot !== null && tr.dataset.slot === String(slot));
  });
}

/* ---------------- 启动 ---------------- */

function init() {
  initTheme();
  jitter = new JitterChart($("jitter-canvas"), $("chart-tooltip"));
  strip = new PlayoutStrip($("strip-canvas"), $("chart-tooltip"));
  wave = new WaveformChart($("wave-canvas"), $("chart-tooltip"));
  jitter.onHover = linkHover;
  strip.onHover = linkHover;
  wave.onSeek = (sec) => {
    if (state.playing) play(sec);
    else {
      wave.setPlayhead(sec);
      $("play-time").textContent = `${sec.toFixed(2)} / ${ensureAudioBuffer().duration.toFixed(2)} s`;
    }
  };

  const delaySlider = $("delay-slider");
  const delayValue = $("delay-value");
  delaySlider.addEventListener("input", () => {
    state.delayMs = Number(delaySlider.value);
    delayValue.textContent = `${state.delayMs} ms`;
    recompute();
  });
  document.querySelectorAll('input[name="policy"]').forEach((r) => {
    r.addEventListener("change", () => {
      state.policy = r.value;
      recompute();
    });
  });

  $("file-input").addEventListener("change", (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
  });
  const drop = $("drop-zone");
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("drag-over");
  }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("drag-over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });
  $("demo-btn").addEventListener("click", () => loadDoc(buildDemoDoc(), "内置演示.json"));

  $("play-btn").addEventListener("click", () => {
    if (state.playing) stopPlayback();
    else play(0);
  });
  $("export-wav").addEventListener("click", exportWav);
  $("export-json").addEventListener("click", exportJson);

  $("filter-select").addEventListener("change", (e) => {
    state.filter = e.target.value;
    state.packetPage = 0;
    renderPacketTable();
  });
  $("packet-prev").addEventListener("click", () => {
    state.packetPage--;
    renderPacketTable();
  });
  $("packet-next").addEventListener("click", () => {
    state.packetPage++;
    renderPacketTable();
  });
  $("slot-prev").addEventListener("click", () => {
    state.slotPage--;
    renderSlotTable();
  });
  $("slot-next").addEventListener("click", () => {
    state.slotPage++;
    renderSlotTable();
  });

  // 图表尺寸变化由各自的 ResizeObserver 处理，无需窗口监听

  // 首屏直接加载演示数据，让页面在完整工作状态下打开
  loadDoc(buildDemoDoc(), "内置演示.json");
  delaySlider.value = state.delayMs;
  delayValue.textContent = `${state.delayMs} ms`;
}

document.addEventListener("DOMContentLoaded", init);
