/*
 * app.js — 主线程：导入、校验、耳位编辑与撤销、渲染编排、到达图、时间轴、试听与导出。
 *
 * 关键不变量：
 *   - 试听与导出的 PCM 完全来自 Worker 最近一次成功渲染的左右声道，逐样点相同。
 *   - 非法轨迹/非法耳位编辑绝不覆盖上一份可试听结果。
 *   - 耳位编辑只改现有点的三维坐标，可撤销；非法编辑不进入场景。
 */

import { validateEars } from "./engine.js";
import { readZip } from "./zip.js";
import { encodeStereo16, sliceSelections } from "./wav.js";
import { drawTimeline } from "./draw.js";

const $ = (id) => document.getElementById(id);

/* ───────────────────────── 状态 ───────────────────────── */

const state = {
  // 当前“已提交”的场景（可能来自导入或耳位编辑）；null 表示尚未导入
  scene: null,
  // 当前场景对应的 WAV 字节（name -> Uint8Array），随场景一起提交
  wavBytes: {},
  // 最近一次成功渲染（供试听/导出/到达图）——与 scene 同步
  rendered: null, // {left, right, energyL, energyR, countL, countR, stats}
  preparedEars: null,
  // 耳位撤销栈（每条为完整 ears 深拷贝）
  earHistory: [],
  // 当前编辑的耳位下标
  earIndex: 0,
  // 到达图当前侧
  side: "left",
  cursor: 0,
  playing: false,
  busy: false,
  // 导入诊断
  wavMeta: {},
  jobSeq: 0,
  renderCount: 0,
};

let worker = null;
const pending = new Map(); // jobId -> {resolve, reject, onProgress}
let currentJob = 0;

/* ───────────────────────── Worker ───────────────────────── */

function initWorker() {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.jobId);
    if (m.type === "progress") {
      if (m.jobId === currentJob) setProgress(m.frac);
      return;
    }
    if (m.type === "wavParsed") {
      state.wavMeta[m.name] = m.meta;
      return;
    }
    if (!p) return;
    pending.delete(m.jobId);
    if (m.type === "render") p.resolve(m);
    else if (m.type === "inspect") p.resolve(m);
    else if (m.type === "error") p.reject(m);
  };
  worker.onerror = (e) => {
    showToast("Worker 异常：" + (e.message || "未知"), true);
  };
}

function renderInWorker(scene, wavBytes, { progressMs } = {}) {
  const jobId = ++state.jobSeq;
  currentJob = jobId;
  const transfer = [];
  const wavs = {};
  if (wavBytes) {
    for (const [name, bytes] of Object.entries(wavBytes)) {
      // 复制以便转移（保留 state.wavBytes 供后续耳位编辑复用）
      const copy = bytes.slice();
      wavs[name] = copy.buffer;
      transfer.push(copy.buffer);
    }
  }
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    const payload = { type: "render", jobId, scene, progressMs };
    if (wavBytes) payload.wavs = wavs;
    worker.postMessage(payload, transfer);
  });
}

function inspectInWorker(t, side) {
  const jobId = ++state.jobSeq;
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    worker.postMessage({ type: "inspect", jobId, t, side });
  });
}

/* ───────────────────────── UI 辅助 ───────────────────────── */

function setStatus(text, kind = "") {
  $("status-text").textContent = text;
  $("status-strip").classList.toggle("busy", kind === "busy");
  $("status-strip").classList.toggle("error", kind === "error");
  $("status-spin").hidden = kind !== "busy";
}

function setProgress(frac) {
  if (frac > 0 && frac < 1) {
    $("status-text").textContent = `渲染中 ${Math.round(frac * 100)}%`;
    $("status-strip").classList.add("busy");
    $("status-spin").hidden = false;
  }
}

let toastTimer = 0;
function showToast(msg, isErr = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

function fmtInt(n) {
  return n.toLocaleString("en-US");
}

/* ───────────────────────── 渲染提交 ───────────────────────── */

/**
 * 使用给定场景渲染。成功则更新 state.scene / rendered 并刷新 UI；
 * 失败则保留上一份可试听结果，仅显示错误。
 * wavBytes 为 null 表示复用 Worker 已缓存的 WAV（耳位编辑时）。
 */
async function applyScene(scene, wavBytes, { fromImport = false } = {}) {
  if (state.busy) return false;
  state.busy = true;
  setStatus(fromImport ? "正在解析并渲染…" : "正在重新渲染…", "busy");
  $("status-spin").hidden = false;
  try {
    const msg = await renderInWorker(scene, wavBytes, { progressMs: 90 });
    state.scene = scene;
    if (wavBytes) state.wavBytes = wavBytes;
    state.rendered = {
      left: new Int16Array(msg.left.buffer, msg.left.byteOffset, msg.left.length),
      right: new Int16Array(msg.right.buffer, msg.right.byteOffset, msg.right.length),
      energyL: msg.energyL,
      energyR: msg.energyR,
      countL: msg.countL,
      countR: msg.countR,
      stats: msg.stats,
    };
    state.cursor = Math.min(state.cursor, scene.frames - 1);
    state.renderCount++;
    onRenderSuccess();
    setStatus(`已渲染 · ${fmtInt(scene.frames)} 帧 · ${msg.stats.elapsedMs.toFixed(0)} ms`);
    return true;
  } catch (err) {
    const fails = err.errors || [];
    // 保留上一份可试听结果：state.scene / state.rendered 在成功前不会被改写。
    showImportErrors(err.message || "渲染失败", fails);
    setStatus("渲染失败 · 保留上一份可试听结果", "error");
    return false;
  } finally {
    state.busy = false;
    $("status-spin").hidden = true;
  }
}

function onRenderSuccess() {
  const r = state.rendered;
  $("stat-frames").textContent = fmtInt(state.scene.frames);
  $("stat-arrivals").textContent = fmtInt(r.stats.arrivals);
  $("stat-peak").textContent = `${r.stats.peakL} / ${r.stats.peakR}`;
  $("stat-time").textContent = `${r.stats.elapsedMs.toFixed(0)} ms`;

  const N = state.scene.frames;
  $("seek").max = String(N - 1);
  $("seek-num").max = String(N - 1);
  $("sel-start").max = String(N - 1);
  $("sel-end").max = String(N);
  if (+$("sel-end").value === 0 || +$("sel-end").value > N) $("sel-end").value = String(N);
  $("export-wav").disabled = false;
  $("play").disabled = false;
  $("stop").disabled = false;
  $("play-selection").disabled = false;

  populateEarEditor();
  drawTimeline(canvasCtx(), state);
  updateCursor();
  refreshArrivals(true);
  renderDiag();
}

function showImportErrors(headline, errors) {
  const el = $("ear-error");
  // 诊断面板里集中展示
  const list = $("diag");
  list.innerHTML = "";
  const add = (cls, k, v) => {
    const li = document.createElement("li");
    li.className = cls;
    const kk = document.createElement("span");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "v";
    vv.textContent = v;
    li.append(kk, vv);
    list.append(li);
  };
  add("bad", "失败", headline);
  for (const e of errors.slice(0, 40)) add("bad", e.path || "场景", e.msg || String(e));
  if (errors.length > 40) add("bad", "…", `还有 ${errors.length - 40} 条错误`);
  showToast(`${headline}（${errors.length} 处）`, true);
}

/* ───────────────────────── 导入 ───────────────────────── */

async function handleZipFile(file) {
  setStatus(`读取 ${file.name}…`, "busy");
  $("status-spin").hidden = false;
  try {
    const buf = await file.arrayBuffer();
    const zip = await readZip(buf);
    if (!zip.ok) {
      showImportErrors("ZIP 解析失败", zip.errors.map((m) => ({ path: "zip", msg: m })));
      setStatus("ZIP 解析失败", "error");
      return;
    }
    let sceneBytes = null;
    const wavBytes = {};
    for (const entry of zip.entries) {
      if (/^scene\.json$/i.test(entry.name)) sceneBytes = entry.bytes;
      else if (/\.wav$/i.test(entry.name)) wavBytes[entry.name] = entry.bytes;
    }
    if (!sceneBytes) {
      showImportErrors("缺少 scene.json", [{ path: "zip", msg: "压缩包内未找到 scene.json" }]);
      setStatus("缺少 scene.json", "error");
      return;
    }
    let scene;
    try {
      scene = JSON.parse(new TextDecoder("utf-8").decode(sceneBytes));
    } catch (err) {
      showImportErrors("scene.json 不是合法 JSON", [{ path: "scene.json", msg: err.message }]);
      setStatus("scene.json 格式错误", "error");
      return;
    }
    await commitScene(scene, wavBytes, fromImportOpts(zip.errors));
  } catch (err) {
    showImportErrors("导入失败", [{ path: "文件", msg: String(err.message || err) }]);
    setStatus("导入失败", "error");
  } finally {
    $("status-spin").hidden = true;
  }
}

function fromImportOpts(zipErrors) {
  return { fromImport: true, zipErrors };
}

async function commitScene(scene, wavBytes, opts = {}) {
  await loadWavMetaFirst(wavBytes);
  const updated = await applyScene(scene, wavBytes, { fromImport: !!opts.fromImport });
  if (updated) {
    state.earHistory = [];
    state.earIndex = 0;
    $("ear-undo").disabled = true;
    refreshFileList(wavBytes, opts.zipErrors || []);
    if (opts.zipErrors && opts.zipErrors.length) {
      for (const m of opts.zipErrors) addDiag("warn", "zip", m);
    }
  }
}

/** 先让 Worker 解析 WAV 元数据（用于校验），返回 meta 映射。 */
async function loadWavMetaFirst(wavBytes) {
  // 通过一次 setWavs 让 worker 回报解析结果
  const parsed = new Promise((resolve) => {
    const names = new Set(Object.keys(wavBytes));
    const got = {};
    let timer = 0;
    const handler = (e) => {
      if (e.data.type === "wavParsed") {
        got[e.data.name] = e.data.meta;
        if (Object.keys(got).length >= names.size) done();
        return;
      }
    };
    const done = () => {
      worker.removeEventListener("message", handler);
      clearTimeout(timer);
      resolve(got);
    };
    worker.addEventListener("message", handler);
    timer = setTimeout(done, 4000);
  });
  const transfer = [];
  const wavs = {};
  for (const [name, bytes] of Object.entries(wavBytes)) {
    const copy = bytes.slice();
    wavs[name] = copy.buffer;
    transfer.push(copy.buffer);
  }
  worker.postMessage({ type: "setWavs", wavs }, transfer);
  const got = await parsed;
  state.wavMeta = { ...state.wavMeta, ...got };
  return got;
}

function refreshFileList(wavBytes, zipErrors) {
  const list = $("filelist");
  list.innerHTML = "";
  if (state.scene) {
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = "scene.json";
    const mt = document.createElement("span");
    mt.className = "meta";
    mt.textContent = `${fmtInt(state.scene.frames)} 帧 · ${state.scene.tracks.length} 轨`;
    li.append(nm, mt);
    list.append(li);
  }
  for (const name of Object.keys(wavBytes)) {
    const meta = state.wavMeta[name];
    const li = document.createElement("li");
    if (meta && !meta.ok) li.classList.add("bad");
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = name;
    const mt = document.createElement("span");
    mt.className = "meta";
    mt.textContent = meta ? (meta.ok ? `${fmtInt(meta.frames)} 帧` : meta.error) : "…";
    li.append(nm, mt);
    list.append(li);
  }
  for (const m of zipErrors) addDiag("warn", "zip", m);
}

/* ───────────────────────── 内置样例 ───────────────────────── */

async function loadSample() {
  if (state.busy) return;
  setStatus("载入内置样例…", "busy");
  $("status-spin").hidden = false;
  try {
    const sceneRes = await fetch("/api/scene", { cache: "no-store" });
    if (!sceneRes.ok) throw new Error("服务端未提供样例（请通过 scripts/start.sh 启动）");
    const scene = await sceneRes.json();
    const wavBytes = {};
    for (const tr of scene.tracks) {
      if (wavBytes[tr.wav]) continue;
      const res = await fetch(`/api/wav?name=${encodeURIComponent(tr.wav)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`无法读取样例 WAV ${tr.wav}`);
      wavBytes[tr.wav] = new Uint8Array(await res.arrayBuffer());
    }
    await commitScene(scene, wavBytes, { fromImport: true });
  } catch (err) {
    showImportErrors("样例载入失败", [{ path: "样例", msg: String(err.message || err) }]);
    setStatus("样例载入失败", "error");
  } finally {
    $("status-spin").hidden = true;
  }
}

/* ───────────────────────── 耳位编辑与撤销 ───────────────────────── */

function populateEarEditor() {
  const ears = state.scene.ears;
  $("ear-count").textContent = `${ears.length} 点`;
  state.earIndex = Math.max(0, Math.min(state.earIndex, ears.length - 1));
  const e = ears[state.earIndex];
  $("ear-t").value = e.t;
  $("ear-lx").value = e.left[0];
  $("ear-ly").value = e.left[1];
  $("ear-lz").value = e.left[2];
  $("ear-rx").value = e.right[0];
  $("ear-ry").value = e.right[1];
  $("ear-rz").value = e.right[2];
  $("ear-prev").disabled = state.earIndex === 0;
  $("ear-next").disabled = state.earIndex === ears.length - 1;
}

function readEarInputs() {
  const num = (id) => Number($(id).value);
  return {
    t: state.scene.ears[state.earIndex].t,
    left: [num("ear-lx"), num("ear-ly"), num("ear-lz")],
    right: [num("ear-rx"), num("ear-ry"), num("ear-rz")],
  };
}

/** 应用耳位编辑：先本地校验，非法则不提交、不覆盖上一份可试听结果。 */
async function applyEarEdit() {
  if (!state.scene || state.busy) return;
  const edit = readEarInputs();
  if (edit.left.some((v) => !Number.isFinite(v)) || edit.right.some((v) => !Number.isFinite(v))) {
    showEarError("耳位必须为有限整数坐标");
    return;
  }
  const nextEars = deepClone(state.scene.ears);
  nextEars[state.earIndex].left = edit.left;
  nextEars[state.earIndex].right = edit.right;
  const errs = validateEars(nextEars, state.scene.frames);
  if (errs.length) {
    showEarError(errs.map((e) => `${e.path}: ${e.msg}`).join("\n"));
    return;
  }
  // 记录撤销点
  state.earHistory.push(deepClone(state.scene.ears));
  if (state.earHistory.length > 200) state.earHistory.shift();
  const nextScene = deepClone(state.scene);
  nextScene.ears = nextEars;
  const ok = await applyScene(nextScene, null, { fromImport: false });
  if (!ok) {
    state.earHistory.pop();
  } else {
    showEarError("");
    $("ear-undo").disabled = state.earHistory.length === 0;
  }
}

async function undoEar() {
  if (state.busy || state.earHistory.length === 0) return;
  const prev = state.earHistory.pop();
  const nextScene = deepClone(state.scene);
  nextScene.ears = prev;
  const ok = await applyScene(nextScene, null, { fromImport: false });
  if (ok) {
    $("ear-undo").disabled = state.earHistory.length === 0;
    showEarError("");
  } else {
    state.earHistory.push(prev);
  }
}

function showEarError(msg) {
  $("ear-error").textContent = msg;
  for (const id of ["ear-lx", "ear-ly", "ear-lz", "ear-rx", "ear-ry", "ear-rz"]) {
    $(id).classList.toggle("bad", !!msg);
  }
}

/* ───────────────────────── 时间轴 / 光标 / 到达 ───────────────────────── */

const canvas = $("timeline");
function canvasCtx() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.round(rect.width * dpr));
  const h = Math.round(220 * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, 220);
  return ctx;
}

function updateCursor() {
  if (!state.scene) return;
  const N = state.scene.frames;
  const wrap = canvas.getBoundingClientRect();
  const frac = N > 1 ? state.cursor / (N - 1) : 0;
  const line = $("cursor-line");
  line.hidden = false;
  line.style.left = `${frac * wrap.width}px`;
  $("seek").value = String(state.cursor);
  $("seek-num").value = String(state.cursor);
}

function setCursor(t) {
  if (!state.scene) return;
  state.cursor = Math.max(0, Math.min(state.scene.frames - 1, Math.round(t)));
  updateCursor();
  refreshArrivals();
  if (state.playing) playFrom(state.cursor);
}

let arrivalsTimer = 0;
let arrivalsInFlight = false;
let lastArrivalsAt = 0;
const ARRIVALS_MIN_INTERVAL = 110; // ms，播放时约 9Hz

/**
 * 节流刷新到达图。immediate=true 时立即刷新（渲染完成/切耳）。
 * 播放中每帧都会调用，用最小间隔节流而不是防抖，否则定时器被不断重置永不触发。
 */
function refreshArrivals(immediate = false) {
  const now = performance.now();
  const elapsed = now - lastArrivalsAt;
  if (!immediate && elapsed < ARRIVALS_MIN_INTERVAL) {
    // 安排一次尾随刷新，保证最后一次光标位置也会被查询
    clearTimeout(arrivalsTimer);
    arrivalsTimer = setTimeout(() => refreshArrivals(true), ARRIVALS_MIN_INTERVAL - elapsed);
    return;
  }
  clearTimeout(arrivalsTimer);
  lastArrivalsAt = now;
  runArrivals();
}

async function runArrivals() {
  if (!state.scene || !state.rendered) return;
  if (arrivalsInFlight) return;
  arrivalsInFlight = true;
  try {
    const tAt = state.cursor;
    const sideAt = state.side;
    const msg = await inspectInWorker(tAt, sideAt);
    // 结果回来时若光标已明显移走则丢弃（避免显示旧帧数据）
    if (Math.abs(state.cursor - tAt) > 400) return;
    renderArrivals(msg.items || [], msg.t, msg.side);
  } catch {
    /* 尚无结果 */
  } finally {
    arrivalsInFlight = false;
  }
}

function renderArrivals(items, t, side) {
  const tbody = $("arrivals-table").querySelector("tbody");
  tbody.innerHTML = "";
  const summary = $("arrivals-summary");
  const empty = $("arrivals-empty");
  if (!items.length) {
    summary.textContent = `t=${t} · ${side === "left" ? "左耳" : "右耳"} · 无到达`;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  let total = 0;
  for (const c of items) total += c.contrib;
  const r = state.rendered;
  const pcm = side === "left" ? r.left[t] : r.right[t];
  summary.textContent = `t=${t} · ${side === "left" ? "左耳" : "右耳"} · ${items.length} 项 · 和 ${total.toFixed(3)} → ${pcm}`;
  const frag = document.createDocumentFragment();
  for (const c of items) {
    const tr = document.createElement("tr");
    const cells = [
      String(c.track),
      String(c.segment),
      c.u.toFixed(6),
      c.d.toFixed(6),
      c.gain.toFixed(9),
      c.q.toFixed(6),
      c.value.toFixed(3),
      c.contrib.toFixed(4),
      (c.residual >= 0 ? "+" : "") + c.residual.toExponential(1),
    ];
    for (const v of cells) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    frag.append(tr);
  }
  tbody.append(frag);
}

/* ───────────────────────── 诊断 ───────────────────────── */

function renderDiag() {
  const list = $("diag");
  list.innerHTML = "";
  if (!state.scene) return;
  addDiag("ok", "场景", `${fmtInt(state.scene.frames)} 帧 · ${state.scene.tracks.length} 轨 · ${state.scene.ears.length} 耳位点`);
  let segCount = 0;
  for (const tr of state.scene.tracks) segCount += tr.segments.length;
  addDiag("ok", "发射段", `${segCount} / 6000`);
  const r = state.rendered;
  if (r) {
    addDiag("ok", "首非零帧", String(r.stats.firstNonzero));
    addDiag("ok", "渲染用时", `${r.stats.elapsedMs.toFixed(0)} ms（限 12000）`);
    addDiag(r.stats.elapsedMs < 12000 ? "ok" : "warn", "性能", r.stats.elapsedMs < 12000 ? "达标" : "超出 12 秒");
  }
  for (const [name, meta] of Object.entries(state.wavMeta)) {
    if (meta.ok) addDiag("ok", name, `${fmtInt(meta.frames)} 帧 · 48kHz · mono · PCM16`);
    else addDiag("bad", name, meta.error);
  }
}

function addDiag(cls, k, v) {
  const li = document.createElement("li");
  li.className = cls;
  const kk = document.createElement("span");
  kk.className = "k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = "v";
  vv.textContent = v;
  li.append(kk, vv);
  $("diag").append(li);
}

/* ───────────────────────── 播放与导出 ───────────────────────── */

let audioCtx = null;
let sourceNode = null;
let playStartTime = 0;
let playStartFrame = 0;
let rafPlay = 0;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  return audioCtx;
}

/** 从 t 帧开始，播放到结束（或选区终点）。使用渲染结果切片，逐样点等同导出。 */
function playFrom(startFrame, endFrame = state.scene.frames) {
  const r = state.rendered;
  if (!r) return;
  stopPlayback(false);
  const ctx = ensureAudio();
  if (ctx.state === "suspended") ctx.resume();
  const s = Math.max(0, Math.min(startFrame, r.left.length));
  const e = Math.max(s, Math.min(endFrame, r.left.length));
  const interleaved = sliceSelections(r.left, r.right, s, e);
  const buf = ctx.createBuffer(2, Math.max(1, e - s), 48000);
  const chL = new Float32Array(e - s);
  const chR = new Float32Array(e - s);
  for (let i = 0; i < e - s; i++) {
    chL[i] = interleaved[2 * i];
    chR[i] = interleaved[2 * i + 1];
  }
  buf.copyToChannel(chL, 0);
  buf.copyToChannel(chR, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  sourceNode = src;
  state.playing = true;
  playStartTime = ctx.currentTime;
  playStartFrame = s;
  $("play").textContent = "❚❚ 暂停";
  src.onended = () => {
    if (state.playing && sourceNode === src) {
      state.playing = false;
      $("play").textContent = "▶ 播放";
      cancelAnimationFrame(rafPlay);
    }
  };
  const tick = () => {
    if (!state.playing || sourceNode !== src) return;
    const f = playStartFrame + Math.floor((ctx.currentTime - playStartTime) * 48000);
    if (f !== state.cursor && f < state.scene.frames) {
      state.cursor = f;
      updateCursor();
      refreshArrivals();
    }
    rafPlay = requestAnimationFrame(tick);
  };  tick();
}

function stopPlayback(updateCursorFlag = true) {
  state.playing = false;
  cancelAnimationFrame(rafPlay);
  if (sourceNode) {
    try {
      sourceNode.onended = null;
      sourceNode.stop();
    } catch {
      /* 已停止 */
    }
    sourceNode.disconnect();
    sourceNode = null;
  }
  $("play").textContent = "▶ 播放";
  if (updateCursorFlag) updateCursor();
}

async function playSelection() {
  if (!state.rendered) return;
  const N = state.scene.frames;
  let a = Number($("sel-start").value);
  let b = Number($("sel-end").value);
  if (!Number.isFinite(a)) a = 0;
  if (!Number.isFinite(b)) b = N;
  a = Math.max(0, Math.min(N, Math.round(a)));
  b = Math.max(0, Math.min(N, Math.round(b)));
  if (b <= a) {
    $("export-error").textContent = "选区终点必须大于起点";
    return;
  }
  $("export-error").textContent = "";
  $("use-selection").checked = true;
  playFrom(a, b);
}

function exportWav() {
  const r = state.rendered;
  if (!r) return;
  const N = state.scene.frames;
  let start = 0;
  let end = N;
  if ($("use-selection").checked) {
    let a = Number($("sel-start").value);
    let b = Number($("sel-end").value);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = N;
    a = Math.max(0, Math.min(N, Math.round(a)));
    b = Math.max(0, Math.min(N, Math.round(b)));
    if (b <= a) {
      $("export-error").textContent = "选区终点必须大于起点";
      return;
    }
    start = a;
    end = b;
  }
  $("export-error").textContent = "";
  const buffer = encodeStereo16(r.left, r.right, start, end);
  const blob = new Blob([buffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `binaural-${start}-${end}.wav`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast(`已导出 ${fmtInt(end - start)} 帧（${start}–${end}）`);
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

function bindEvents() {
  // 导入
  const dz = $("dropzone");
  const fileInput = $("file-zip");
  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleZipFile(f);
    fileInput.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
    });
  }
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleZipFile(f);
  });
  $("load-sample").addEventListener("click", loadSample);

  // 耳位
  $("ear-apply").addEventListener("click", applyEarEdit);
  $("ear-undo").addEventListener("click", undoEar);
  $("ear-prev").addEventListener("click", () => {
    if (!state.scene) return;
    state.earIndex = Math.max(0, state.earIndex - 1);
    populateEarEditor();
    showEarError("");
  });
  $("ear-next").addEventListener("click", () => {
    if (!state.scene) return;
    state.earIndex = Math.min(state.scene.ears.length - 1, state.earIndex + 1);
    populateEarEditor();
    showEarError("");
  });

  // 时间轴点击/拖动
  let dragging = false;
  const seekAt = (clientX) => {
    if (!state.scene) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setCursor(Math.round(frac * (state.scene.frames - 1)));
  };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) seekAt(e.clientX);
  });
  canvas.addEventListener("pointerup", () => (dragging = false));

  $("seek").addEventListener("input", () => setCursor(Number($("seek").value)));
  $("seek-num").addEventListener("change", () => setCursor(Number($("seek-num").value)));

  // 到达图侧别
  $("side-left").addEventListener("click", () => setSide("left"));
  $("side-right").addEventListener("click", () => setSide("right"));

  // 播放
  $("play").addEventListener("click", () => {
    if (state.playing) {
      stopPlayback(true);
    } else {
      const a = Number($("sel-start").value);
      const b = Number($("sel-end").value);
      if ($("use-selection").checked && Number.isFinite(a) && Number.isFinite(b) && b > a) {
        playFrom(a, b);
      } else {
        playFrom(state.cursor);
      }
    }
  });
  $("stop").addEventListener("click", () => {
    stopPlayback(true);
    setCursor(0);
  });
  $("play-selection").addEventListener("click", playSelection);
  $("export-wav").addEventListener("click", exportWav);

  $("use-selection").addEventListener("change", () => {
    $("export-error").textContent = "";
  });

  window.addEventListener("resize", () => {
    if (state.scene) {
      drawTimeline(canvasCtx(), state);
      updateCursor();
    }
  });
}

function setSide(side) {
  state.side = side;
  $("side-left").classList.toggle("on", side === "left");
  $("side-right").classList.toggle("on", side === "right");
  refreshArrivals();
}

/* ───────────────────────── 工具 ───────────────────────── */

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ───────────────────────── 启动 ───────────────────────── */

function main() {
  initWorker();
  bindEvents();
  renderDiagEmpty();
}

function renderDiagEmpty() {
  addDiag("warn", "提示", "拖入 moving-audio.zip，或点击“载入内置样例”。");
}

main();

/* 暴露少量内部状态供端到端测试核对（只读使用）。 */
window.__bench = {
  get state() {
    return state;
  },
  get renderCount() {
    return state.renderCount;
  },
  setCursor,
  applyEarEdit,
  undoEar,
  playSelection,
  exportWav,
  inspectAt: (t, side) => inspectInWorker(t, side),
  validateEars,
};
