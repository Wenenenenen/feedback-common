/* 双面去透印工作台前端 —— 零依赖。
 * 图层数据为 base64 编码的 float32 小端数组（服务端按行优先、与图同尺寸）。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  jobId: null,
  height: 0,
  width: 0,
  activeLayer: "estimate",
  scale: 8,
  // side(side: "front"|"back") -> layer key -> Float32Array
  data: { front: {}, back: {} },
  kernels: null,
};

const LAYER_META = {
  estimate:  { front: "front_estimate", back: "back_estimate", label: "本面估计" },
  observed:  { front: "front_observed", back: "back_observed", label: "观测" },
  bleed:     { front: "front_bleed",    back: "back_bleed",    label: "对面透印量" },
  residual:  { front: "front_residual", back: "back_residual", label: "观测残差" },
  mask:      { front: "front_mask",     back: "back_mask",     label: "有效掩膜" },
};

// ------------------------------------------------------------- 状态提示

function setStatus(mode, text) {
  const pill = $("#statusPill");
  pill.dataset.state = mode;
  $("#statusText").textContent = text;
}

function showError(message) {
  const el = $("#errorBanner");
  el.hidden = false;
  el.textContent = message;
  setStatus("error", "出错");
}
function clearError() {
  $("#errorBanner").hidden = true;
}

// ------------------------------------------------------------- 上传

$$(".file-slot input[type=file]").forEach((input) => {
  input.addEventListener("change", () => {
    const detail = input.closest(".file-slot").querySelector(".slot-detail");
    if (input.files && input.files[0]) {
      detail.textContent = input.files[0].name;
      detail.classList.add("filled");
    }
  });
});

$("#uploadForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearError();
  const form = ev.currentTarget;
  const fd = new FormData();
  let filled = 0;
  for (const input of form.querySelectorAll('input[type=file]')) {
    if (input.files && input.files[0]) {
      fd.append(input.name, input.files[0]);
      filled += 1;
    }
  }
  const cross = form.querySelector('input[name=cross_check]');
  if (cross && cross.checked) fd.append("cross_check", "true");
  if (!form.front.files[0] || !form.back.files[0] || !form.kernels.files[0]) {
    showError("请至少选择：正面 PGM、背面 PGM、散射核 JSON。");
    return;
  }

  const btn = $("#solveBtn");
  btn.disabled = true;
  btn.classList.add("busy");
  btn.querySelector(".btn-label").textContent = "拟合中…";
  setStatus("busy", `已上传 ${filled} 个文件，正在联合拟合`);

  try {
    const resp = await fetch("/api/solve", { method: "POST", body: fd });
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || `HTTP ${resp.status}`);
    ingestResult(payload);
    setStatus("ok", `拟合完成 · KKT ${formatNum(payload.diagnostics.optimality_inf, 2)}`);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.querySelector(".btn-label").textContent = "开始联合拟合";
  }
});

// ------------------------------------------------------------- 结果装载

function b64ToFloat32(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

function ingestResult(payload) {
  state.jobId = payload.job_id;
  state.height = payload.height;
  state.width = payload.width;
  state.kernels = payload.kernels;
  state.data = { front: {}, back: {} };
  for (const [key, meta] of Object.entries(LAYER_META)) {
    state.data.front[key] = b64ToFloat32(payload.layers[meta.front]);
    state.data.back[key] = b64ToFloat32(payload.layers[meta.back]);
  }
  renderDiagnostics(payload.diagnostics);
  renderKernels(payload.kernels);
  $("#diagCard").hidden = false;
  $("#viewerCard").hidden = false;
  $("#exportCard").hidden = false;
  setupCanvas();
  renderAll();
  $("#viewerCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDiagnostics(d) {
  const rows = [
    ["目标函数 F", formatNum(d.objective, 6), ""],
    ["KKT 分量最优性误差", formatNum(d.optimality_inf, 2),
      d.meets_tolerance ? "good" : "bad"],
    ["容差要求", "≤ " + formatNum(d.tolerance, 0), d.meets_tolerance ? "good" : "bad"],
    ["外迭代次数", String(d.outer_iterations), ""],
    ["变量数 (2·H·W)", d.variables.toLocaleString(), ""],
    ["求解用时 (s)", formatNum(d.elapsed_seconds, 2), ""],
    ["无约束 LSQ 下界", formatNum(d.lsq_objective_lower_bound, 6), ""],
    ["F ≥ LSQ 下界", d.objective_above_lower_bound ? "成立" : "违反",
      d.objective_above_lower_bound ? "good" : "bad"],
  ];
  if (d.cross_check_enabled) {
    rows.push(["L-BFGS-B 交叉目标", formatNum(d.cross_check_objective, 6), ""]);
    rows.push(["两算法目标一致", d.cross_check_match ? "是" : "否",
      d.cross_check_match ? "good" : "bad"]);
  }
  $("#diagGrid").innerHTML = rows.map(([k, v, cls]) =>
    `<div class="diag-item ${cls}"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`
  ).join("");
}

function renderKernels(kernels) {
  const block = (name, k) => {
    const rows = k.rows.map((r) => r.map((v) => Number(v).toFixed(3).padStart(7)).join(" ")).join("\n");
    return `<div><strong>${name}</strong> · 原点 (ox,oy)=(${k.origin[0]},${k.origin[1]})，`
      + `尺寸 ${k.rows[0].length}×${k.rows.length}<pre>${escapeHtml(rows)}</pre></div>`;
  };
  $("#kernelStrip").innerHTML = block("正面核 Kf（作用于 Y）", kernels.front)
    + block("背面核 Kb（作用于 X）", kernels.back);
}

// ------------------------------------------------------------- 画布与渲染

function setupCanvas() {
  for (const side of ["front", "back"]) {
    const c = document.getElementById(side + "Canvas");
    c.width = state.width;
    c.height = state.height;
    c.dataset.side = side;
    c.addEventListener("click", onCanvasClick);
  }
  const range = $("#scaleRange");
  range.max = Math.max(1, Math.min(24, Math.floor(480 / Math.max(state.width, state.height)) + 4));
  range.value = state.scale;
  $("#scaleVal").textContent = state.scale + "×";
  range.oninput = () => {
    state.scale = Number(range.value);
    $("#scaleVal").textContent = state.scale + "×";
    applyCanvasSize();
    renderAll();
  };
  applyCanvasSize();
}

function applyCanvasSize() {
  for (const side of ["front", "back"]) {
    const c = document.getElementById(side + "Canvas");
    c.style.width = (state.width * state.scale) + "px";
    c.style.height = (state.height * state.scale) + "px";
  }
}

function renderAll() {
  renderSide("front");
  renderSide("back");
  renderColorbar();
}

function renderSide(side) {
  const c = document.getElementById(side + "Canvas");
  const ctx = c.getContext("2d");
  const arr = state.data[side][state.activeLayer];
  const img = ctx.createImageData(state.width, state.height);
  const isResidual = state.activeLayer === "residual";
  const maxAbs = isResidual ? maxAbsResidual() : 1;
  for (let i = 0, p = 0; i < arr.length; i++, p += 4) {
    const v = arr[i];
    if (!Number.isFinite(v)) {
      img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
      img.data[p + 3] = 0;                 // 缺测：透明，露出棋盘格
      continue;
    }
    if (state.activeLayer === "mask" && v < 0.5) {
      img.data[p + 3] = 0;                 // 掩膜无效区：透明棋盘格
      continue;
    }
    const [r, g, b] = isResidual ? diverging(v, maxAbs) : grayscale(v);
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function maxAbsResidual() {
  let m = 1e-12;
  for (const side of ["front", "back"]) {
    const a = state.data[side].residual;
    for (const v of a) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  }
  return m;
}

function grayscale(v) {
  const t = Math.min(1, Math.max(0, v));
  const g = Math.round(t * 255);
  return [g, g, g];
}

// 残差发散色：负=蓝，零=白，正=红
function diverging(v, maxAbs) {
  const t = Math.min(1, Math.abs(v) / maxAbs);
  const neutral = 245;
  if (v >= 0) {
    return [neutral + (200 - neutral) * t, neutral - (neutral - 60) * t,
            neutral - (neutral - 70) * t];
  }
  return [neutral - (neutral - 55) * t, neutral - (neutral - 110) * t,
          neutral + (210 - neutral) * t];
}

function renderColorbar() {
  const ramp = $("#ramp");
  if (state.activeLayer === "residual") {
    const m = maxAbsResidual();
    ramp.style.background = "linear-gradient(90deg,#1f57c7,#f5f5f5,#c8322c)";
    $("#rampMin").textContent = "−" + formatNum(m, 4);
    $("#rampMid").textContent = "0";
    $("#rampMax").textContent = "+" + formatNum(m, 4);
  } else {
    ramp.style.background = "linear-gradient(90deg,#000,#fff)";
    $("#rampMin").textContent = "0.000";
    $("#rampMid").textContent = "";
    $("#rampMax").textContent = "1.000";
  }
}

$$(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeLayer = btn.dataset.layer;
    renderAll();
  });
});

// ------------------------------------------------------------- 像素检查

function onCanvasClick(ev) {
  const c = ev.currentTarget;
  const side = c.dataset.side;
  const rect = c.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * state.width);
  const y = Math.floor((ev.clientY - rect.top) / rect.height * state.height);
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
  moveCrosshair(side, x, y);
  renderInspector(side, x, y);
}

function moveCrosshair(side, x, y) {
  for (const s of ["front", "back"]) {
    const cross = document.getElementById(s + "Cross");
    const wrap = document.getElementById(s + "Wrap");
    const c = document.getElementById(s + "Canvas");
    if (s === side) {
      const wrapRect = wrap.getBoundingClientRect();
      const canvasRect = c.getBoundingClientRect();
      cross.style.display = "block";
      cross.style.left = (canvasRect.left - wrapRect.left + x * state.scale - wrap.scrollLeft + 8) + "px";
      cross.style.top = (canvasRect.top - wrapRect.top + y * state.scale - wrap.scrollTop + 8) + "px";
      cross.style.width = state.scale + "px";
      cross.style.height = state.scale + "px";
    } else {
      cross.style.display = "none";
    }
  }
}

function idx(x, y) { return y * state.width + x; }

function renderInspector(side, x, y) {
  const i = idx(x, y);
  const f = state.data.front;
  const b = state.data.back;
  // 背面画布按原朝向显示；其数组也是原朝向，直接按 (x,y) 取。
  // 正面坐标下的背面列：x_front = W-1-x_back
  const xf = side === "back" ? state.width - 1 - x : x;
  const yf = y;
  const fi = idx(xf, yf);

  const cell = (arr, k) => {
    const v = arr[k];
    return Number.isFinite(v) ? formatNum(v, 6) : `<span class="null-val">null（缺测）</span>`;
  };

  const frontRows = `
    <tr><th>本面估计 X</th><td>${cell(f.estimate, fi)}</td></tr>
    <tr><th>对面透印量 Kf·Y</th><td>${cell(f.bleed, fi)}</td></tr>
    <tr><th>观测 A</th><td>${cell(f.observed, fi)}</td></tr>
    <tr><th>残差 (X+KfY−A)</th><td>${cell(f.residual, fi)}</td></tr>
    <tr><th>掩膜（1 有效）</th><td>${cell(f.mask, fi)}</td></tr>`;
  const backRows = `
    <tr><th>本面估计 Y（原朝向）</th><td>${cell(b.estimate, i)}</td></tr>
    <tr><th>对面透印量 Kb·X（原朝向）</th><td>${cell(b.bleed, i)}</td></tr>
    <tr><th>观测 B（原朝向）</th><td>${cell(b.observed, i)}</td></tr>
    <tr><th>残差 (Y+KbX−B)</th><td>${cell(b.residual, i)}</td></tr>
    <tr><th>掩膜（1 有效）</th><td>${cell(b.mask, i)}</td></tr>`;

  const coordNote = side === "back"
    ? `点击位于背面原朝向 (x=${x}, y=${y})，对应正面坐标 (x=${xf}, y=${yf})`
    : `点击位于正面坐标 (x=${x}, y=${y})`;

  $("#inspector .inspector-empty").hidden = true;
  const body = $("#inspector .inspector-body");
  body.hidden = false;
  body.innerHTML = `
    <div class="insp-coord">${coordNote} · 图层：${LAYER_META[state.activeLayer].label}</div>
    <div class="insp-tables">
      <table class="insp"><caption>正面（正面坐标，索引 ${fi}）</caption>${frontRows}</table>
      <table class="insp"><caption>背面（当前显示朝向）</caption>${backRows}</table>
    </div>`;
}

// ------------------------------------------------------------- 导出

$$(".export-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state.jobId) return;
    const url = `/api/export?job=${encodeURIComponent(state.jobId)}&kind=${encodeURIComponent(btn.dataset.export)}`;
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
});

// ------------------------------------------------------------- 工具

function formatNum(v, digits) {
  if (!Number.isFinite(v)) return "null";
  if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(2);
  return Number(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

setStatus("idle", "未导入");
