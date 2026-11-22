// Application wiring: file import, filters, packet table, clock chart,
// anomaly list, JSON export, and the packet detail panel.

import { analyze } from "../analyzer.js";
import { MAX_FILE_SIZE } from "../ts-parser.js";
import { createPacketTable } from "./packet-table.js";
import { renderClockChart } from "./clock-chart.js";

const state = {
  result: null,
  fileName: "",
  filterPid: "all",
  filterProgram: "all",
  filterIssue: "all",
  clockKind: "PCR",
  selectedPacket: -1,
};

const el = {};

export function boot() {
  for (const id of [
    "dropzone", "file-input", "file-name", "summary-strip",
    "program-select", "pid-select", "issue-select", "clock-kind",
    "packet-table", "packet-detail", "clock-chart", "anomaly-list",
    "export-json", "load-status", "anomaly-count",
  ]) {
    el[id] = document.getElementById(id);
  }

  el["file-input"].addEventListener("change", onFileChosen);
  const dz = el["dropzone"];
  ["dragover", "dragenter"].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove("drag-over"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });
  dz.addEventListener("click", () => el["file-input"].click());

  el["program-select"].addEventListener("change", (e) => {
    state.filterProgram = e.target.value;
    state.filterPid = "all";
    refreshAll();
  });
  el["pid-select"].addEventListener("change", (e) => {
    state.filterPid = e.target.value;
    refreshAll();
  });
  el["issue-select"].addEventListener("change", (e) => {
    state.filterIssue = e.target.value;
    refreshAll();
  });
  el["clock-kind"].addEventListener("change", (e) => {
    state.clockKind = e.target.value;
    renderClock();
  });
  el["export-json"].addEventListener("click", exportAnomaliesJson);
}

async function onFileChosen(e) {
  const f = e.target.files?.[0];
  if (f) await handleFile(f);
}

async function handleFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    setStatus(`文件 ${file.size.toLocaleString()} 字节，超过 32MB 上限。`, true);
    return;
  }
  setStatus(`正在解析 ${file.name} …`);
  try {
    const buf = await file.arrayBuffer();
    // Let the status paint before the synchronous parse.
    await new Promise((r) => setTimeout(r, 0));
    const result = analyze(buf);
    state.result = result;
    state.fileName = file.name;
    state.filterPid = "all";
    state.filterProgram = "all";
    state.filterIssue = "all";
    state.selectedPacket = -1;
    el["file-name"].textContent = `${file.name} · ${file.size.toLocaleString()} 字节`;
    setStatus(`解析完成：${result.packetCount} 个完整包，${result.anomalies.length} 条异常。`);
    populateSelectors();
    document.getElementById("summary-strip").hidden = false;
    document.getElementById("filter-row").hidden = false;
    document.getElementById("work-grid").hidden = false;
    refreshAll();
  } catch (err) {
    setStatus(`解析失败：${err.message}`, true);
  }
}

function setStatus(text, isError = false) {
  el["load-status"].textContent = text;
  el["load-status"].classList.toggle("error", isError);
}

function populateSelectors() {
  const r = state.result;
  // Programs from the final map
  const finalMap = r.psi.mapAt(r.packetCount);
  fillSelect(el["program-select"], [
    { value: "all", label: "全部节目" },
    ...finalMap.programs.map((p) => ({
      value: String(p.programNumber),
      label: `节目 ${p.programNumber}（PMT PID ${p.pmtPid}）`,
    })),
  ]);
  fillSelect(el["pid-select"], [
    { value: "all", label: "全部 PID" },
    ...r.pids.map((p) => ({
      value: String(p.pid),
      label: `PID ${p.pid} (0x${p.pid.toString(16).padStart(4, "0")}) · ${p.packetCount} 包`,
    })),
  ]);
  const issueTypes = [...new Set(r.anomalies.map((a) => a.type))].sort();
  fillSelect(el["issue-select"], [
    { value: "all", label: "全部异常类型" },
    ...issueTypes.map((t) => ({ value: t, label: issueLabel(t) })),
  ]);
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
}

function filteredRows() {
  const r = state.result;
  if (!r) return [];
  let rows = r.packets;
  if (state.filterPid !== "all") {
    const pid = Number(state.filterPid);
    rows = rows.filter((row) => row.pid === pid);
  } else if (state.filterProgram !== "all") {
    const progNum = Number(state.filterProgram);
    const pids = pidsForProgram(progNum);
    rows = rows.filter((row) => pids.has(row.pid));
  }
  if (state.filterIssue !== "all") {
    const byIndex = new Set(
      r.anomalies.filter((a) => a.type === state.filterIssue && a.packetIndex !== null)
        .map((a) => a.packetIndex),
    );
    rows = rows.filter((row) => byIndex.has(row.index) || row.issues.includes(state.filterIssue));
  }
  return rows;
}

function pidsForProgram(programNumber) {
  const map = state.result.psi.mapAt(state.result.packetCount);
  const prog = map.programs.find((p) => p.programNumber === programNumber);
  const set = new Set();
  if (!prog) return set;
  set.add(prog.pmtPid);
  if (prog.pcrPid !== null) set.add(prog.pcrPid);
  for (const s of prog.streams) set.add(s.elementaryPid);
  return set;
}

let table;
function refreshAll() {
  const r = state.result;
  if (!r) return;
  renderSummary();
  if (!table) {
    table = createPacketTable(el["packet-table"], {
      getRows: filteredRows,
      onRowActivate: (index) => showDetail(index),
    });
  }
  table.render();
  renderClock();
  renderAnomalies();
}

function renderSummary() {
  const r = state.result;
  const counts = {};
  for (const a of r.anomalies) counts[a.type] = (counts[a.type] || 0) + 1;
  el["anomaly-count"].textContent = String(r.anomalies.length);
  const tiles = [
    ["完整 TS 包", r.packetCount],
    ["首同步偏移", r.firstSyncOffset],
    ["PCR 采样", r.pcrSamples.length],
    ["PTS/DTS 采样", r.ptsSamples.length],
    ["异常条目", r.anomalies.length],
  ];
  el["summary-strip"].replaceChildren();
  for (const [k, v] of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const val = document.createElement("div");
    val.className = "stat-value";
    val.textContent = String(v);
    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = k;
    tile.append(val, label);
    el["summary-strip"].append(tile);
  }
}

function renderClock() {
  const r = state.result;
  if (!r) return;
  const pid = state.filterPid === "all" ? null : Number(state.filterPid);
  let points = r.clockPoints.filter((p) => p.kind === state.clockKind);
  if (pid !== null) points = points.filter((p) => p.pid === pid);
  renderClockChart(el["clock-chart"], {
    points,
    kindFilter: state.clockKind,
    onSelectPacket: (index) => {
      table.select(index, true);
      showDetail(index);
    },
  });
}

function renderAnomalies() {
  const r = state.result;
  const list = el["anomaly-list"];
  list.replaceChildren();
  let items = r.anomalies;
  if (state.filterIssue !== "all") items = items.filter((a) => a.type === state.filterIssue);
  if (state.filterPid !== "all") {
    const pid = Number(state.filterPid);
    items = items.filter((a) => a.pid === pid);
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "anomaly-empty";
    empty.textContent = "当前筛选下没有异常。";
    list.append(empty);
    return;
  }
  for (const a of items.slice(0, 500)) {
    const item = document.createElement("button");
    item.className = `anomaly-item severity-${severityOf(a.type)}`;
    const head = document.createElement("div");
    head.className = "anomaly-head";
    const name = document.createElement("span");
    name.className = "anomaly-name";
    name.textContent = issueLabel(a.type);
    const loc = document.createElement("span");
    loc.className = "anomaly-loc";
    loc.textContent = a.packetIndex === null || a.packetIndex === undefined
      ? `PID ${a.pid ?? "-"}`
      : `#${a.packetIndex} · PID ${a.pid ?? "-"}`;
    head.append(name, loc);
    const detail = document.createElement("div");
    detail.className = "anomaly-detail";
    detail.textContent = a.detail || "";
    item.append(head, detail);
    item.addEventListener("click", () => {
      if (a.packetIndex !== null && a.packetIndex !== undefined) {
        table.select(a.packetIndex, true);
        showDetail(a.packetIndex);
      }
    });
    list.append(item);
  }
  if (items.length > 500) {
    const more = document.createElement("div");
    more.className = "anomaly-more";
    more.textContent = `仅显示前 500 条，共 ${items.length} 条；用筛选缩小范围或导出 JSON。`;
    list.append(more);
  }
}

function showDetail(index) {
  const r = state.result;
  state.selectedPacket = index;
  const row = r.packets.find((p) => p.index === index);
  const host = el["packet-detail"];
  host.replaceChildren();
  if (!row) return;
  const title = document.createElement("div");
  title.className = "detail-title";
  title.textContent = `包 #${row.index} · 偏移 ${row.offset} · PID ${row.pid} (0x${row.pid.toString(16).padStart(4, "0")})`;
  host.append(title);

  const grid = document.createElement("dl");
  grid.className = "detail-grid";
  const fields = [
    ["PUSI", row.pusi], ["TEI", row.tei ? 1 : 0], ["优先级", row.priority],
    ["加扰控制", row.scrambling], ["适配字段控制", afcText(row.afc)],
    ["连续计数 CC", `0x${row.cc.toString(16)}`],
    ["载荷长度", row.payloadLength],
  ];
  if (row.adaptation) {
    fields.push(["适配字段长度", row.adaptation.length]);
    fields.push(["discontinuity", row.adaptation.discontinuity ? 1 : 0]);
    fields.push(["random_access", row.adaptation.randomAccess ? 1 : 0]);
    if (row.adaptation.pcr !== null) {
      fields.push(["PCR 原值 (27MHz)", row.adaptation.pcr.toString()]);
      fields.push(["PCR base", (row.adaptation.pcr / 300n).toString()]);
      fields.push(["PCR 扩展", (row.adaptation.pcr % 300n).toString()]);
    }
  }
  if (row.pes) {
    fields.push(["PES stream_id", `0x${row.pes.streamId.toString(16).padStart(2, "0")}`]);
    if (row.pes.pts !== null) fields.push(["PTS 原值 (90kHz)", row.pes.pts.toString()]);
    if (row.pes.dts !== null) fields.push(["DTS 原值", row.pes.dts.toString()]);
  }
  for (const [k, v] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = String(v);
    grid.append(dt, dd);
  }
  host.append(grid);

  if (row.issues.length) {
    const wrap = document.createElement("div");
    wrap.className = "detail-badges";
    for (const iss of row.issues) {
      const b = document.createElement("span");
      b.className = "badge badge-detail";
      b.textContent = issueLabel(iss);
      wrap.append(b);
    }
    host.append(wrap);
  }

  // Program relationship in force at this packet
  const map = r.psi.mapAt(row.index);
  if (map.ready) {
    const rel = document.createElement("div");
    rel.className = "detail-program";
    rel.textContent = "此时节目关系：" + map.programs.map((p) =>
      `节目${p.programNumber}→PMT ${p.pmtPid}, PCR ${p.pcrPid ?? "-"}, 流 [${p.streams.map((s) => s.elementaryPid).join(", ")}]`).join("；");
    host.append(rel);
  }
}

function exportAnomaliesJson() {
  const r = state.result;
  if (!r) return;
  const payload = {
    file: state.fileName,
    exportedAt: new Date().toISOString(),
    byteLength: r.byteLength,
    packetCount: r.packetCount,
    firstSyncOffset: r.firstSyncOffset,
    trailingBytes: r.trailingBytes,
    filters: {
      program: state.filterProgram, pid: state.filterPid, issue: state.filterIssue,
    },
    anomalyCount: r.anomalies.length,
    anomalies: r.anomalies.map((a) => ({
      type: a.type,
      packetIndex: a.packetIndex,
      pid: a.pid,
      detail: a.detail,
    })),
    programTimeline: r.psi.mapTimeline,
  };
  const blob = new Blob([JSON.stringify(payload, jsonReplacer, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.fileName.replace(/\.[^.]+$/, "") || "capture"}-anomalies.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function severityOf(type) {
  if (type.includes("crc") || type.includes("sync") || type === "same_cc_different") return "critical";
  if (type.includes("gap") || type.includes("discontinuity") || type.includes("regression") || type.includes("jump")) return "serious";
  if (type.includes("wrap") || type.includes("switch") || type === "adaptation_only" || type === "truncated_packet") return "warning";
  return "info";
}

function afcText(afc) {
  return { 0: "00 保留", 1: "01 仅载荷", 2: "10 仅适配字段", 3: "11 适配+载荷" }[afc] ?? String(afc);
}

function issueLabel(type) {
  const labels = {
    exact_duplicate: "完全重复包",
    same_cc_different: "同 CC 异内容",
    cc_gap: "缺包（CC 跳变）",
    discontinuity: "显式不连续指示",
    adaptation_only: "仅适配字段包",
    tei_set: "传输错误指示 TEI",
    sync_lost: "同步丢失",
    truncated_packet: "末尾截断包",
    reserved_afc: "保留的 AFC 值",
    psi_crc_error: "PSI 表 CRC 错误",
    psi_incomplete: "PSI 表未完成",
    pcr_wrap: "PCR 回绕",
    pcr_regression: "PCR 小幅倒退",
    pcr_large_jump: "PCR 异常前跳",
    pts_wrap: "PTS/DTS 回绕",
    pts_regression: "PTS/DTS 小幅倒退",
    pts_large_jump: "PTS/DTS 异常前跳",
    pcr_discontinuity_segment: "PCR 不连续分段",
    program_switch_segment: "节目切换分段",
  };
  return labels[type] || type;
}
