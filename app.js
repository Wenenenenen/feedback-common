// 页面主逻辑：导入、烘焙、立方体面展开、反射球、检查器与导出。
import {
  FACE_ORDER, CubeEnv, bakeCubemap, bakeTexel,
  displayColor, encodePFM, dirToFaceUV,
} from "./app/cube-core.js";
import { buildZip } from "./app/zip.js";

const DEFAULT_ROUGHNESSES = [0, 0.25, 0.5, 1];
const $ = (id) => document.getElementById(id);

const state = {
  env: null,            // CubeEnv
  envName: "",
  envSize: 0,
  outN: 32,
  roughness: 0,
  samples: 256,
  exposure: 1,          // exposure 滑块 0 -> 实际倍率 1
  baked: new Map(),     // r -> { faces, texelDirs }
  baking: false,
  selected: null,       // { face, row, col }
  sphere: { yaw: 0.6, pitch: 0.25 },
};

// ---------- 工具 ----------
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "toast error" : "toast";
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function loadEnvironmentJSON(json, name) {
  if (!json || typeof json !== "object" || !json.faces || !Number.isInteger(json.size)) {
    throw new Error("JSON 需含 size 与 faces 字段");
  }
  const N = json.size;
  if (!(N > 0 && N <= 64)) throw new Error("面边长需在 1–64 之间");
  for (const f of FACE_ORDER) {
    if (!Array.isArray(json.faces[f]) || json.faces[f].length !== N * N) {
      throw new Error(`面 ${f} 数据缺失或长度非 ${N * N}`);
    }
  }
  const faces = {};
  for (const f of FACE_ORDER) {
    const flat = new Float32Array(N * N * 3);
    json.faces[f].forEach((c, i) => {
      if (!Array.isArray(c) || c.length !== 3 || c.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
        throw new Error(`面 ${f} 第 ${i} 纹素不是有限 RGB 三元组`);
      }
      flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2];
    });
    faces[f] = flat;
  }
  state.env = new CubeEnv(N, faces);
  state.envSize = N;
  state.envName = name;
  state.baked.clear();
  state.selected = null;
  $("envMeta").textContent = `文件: ${name}｜输入面边长: ${N}｜线性浮点 HDR（不裁剪）`;
  $("bakeBtn").disabled = false;
  $("exportBtn").disabled = true;
  renderCubeGrid();
  drawSphere();
  renderInspector();
}

// ---------- 立方体面展开渲染 ----------
function ensureFaceCanvases() {
  const grid = $("cubeGrid");
  grid.innerHTML = "";
  for (const f of FACE_ORDER) {
    const card = document.createElement("div");
    card.className = "face-card";
    card.innerHTML = `<h4><span>${f}</span><span class="mono face-size"></span></h4>`;
    const canvas = document.createElement("canvas");
    canvas.className = "face-canvas";
    canvas.dataset.face = f;
    canvas.addEventListener("click", onFaceClick);
    card.appendChild(canvas);
    grid.appendChild(card);
  }
}

function currentDisplaySource() {
  const src = document.querySelector('input[name="cubeSrc"]:checked').value;
  if (src === "input") return { kind: "input" };
  const b = state.baked.get(state.roughness);
  return b ? { kind: "output", data: b } : null;
}

function renderCubeGrid() {
  if (!state.env) return;
  if (!$("cubeGrid").querySelector(".face-card")) ensureFaceCanvases();
  const src = currentDisplaySource();
  const n = src?.kind === "output" ? state.outN : state.envSize;
  const imageData = new ImageData(n, n);
  document.querySelectorAll(".face-card").forEach((card) => {
    const f = card.querySelector(".face-canvas").dataset.face;
    card.querySelector(".face-size").textContent = `${n}×${n}`;
    const canvas = card.querySelector(".face-canvas");
    canvas.width = n; canvas.height = n;
    const ctx = canvas.getContext("2d");
    let buf;
    if (src?.kind === "output") buf = src.data.faces[f];
    else {
      // 输入直接用环境面。
      buf = state.env.faces[f];
    }
    for (let p = 0; p < n * n; p++) {
      const [r, g, b] = displayColor([buf[p * 3], buf[p * 3 + 1], buf[p * 3 + 2]], state.exposure);
      imageData.data[p * 4] = r; imageData.data[p * 4 + 1] = g;
      imageData.data[p * 4 + 2] = b; imageData.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    drawSelectionOverlay(canvas, f);
  });
}

function drawSelectionOverlay(canvas, face) {
  if (!state.selected || state.selected.face !== face) return;
  const ctx = canvas.getContext("2d");
  const { row, col } = state.selected;
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = 1;
  ctx.strokeRect(col + 0.5, row + 0.5, 1, 1);
}

function onFaceClick(e) {
  const src = currentDisplaySource();
  if (!src || src.kind !== "output") {
    toast("请先切换到“输出”并完成烘焙，再点击纹素检查");
    return;
  }
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const col = Math.min(state.outN - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * state.outN)));
  const row = Math.min(state.outN - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * state.outN)));
  state.selected = { face: canvas.dataset.face, row, col };
  renderCubeGrid();
  renderInspector();
}

// ---------- 烘焙 ----------
async function runBake() {
  if (!state.env || state.baking) return;
  state.baking = true;
  $("bakeBtn").disabled = true;
  $("exportBtn").disabled = true;
  const wrap = document.querySelector(".progress-wrap");
  wrap.hidden = false;
  try {
    const results = new Map();
    for (let k = 0; k < DEFAULT_ROUGHNESSES.length; k++) {
      const r = DEFAULT_ROUGHNESSES[k];
      $("progressText").textContent = `烘焙粗糙度 ${r}（${k + 1}/${DEFAULT_ROUGHNESSES.length}）`;
      const baked = await bakeCubemap(state.env, r, state.samples, state.outN, {
        onProgress: (p) => {
          const overall = (k + p) / DEFAULT_ROUGHNESSES.length;
          $("progressBar").style.width = `${(overall * 100).toFixed(1)}%`;
        },
      });
      results.set(r, baked);
    }
    state.baked = results;
    $("progressBar").style.width = "100%";
    $("progressText").textContent = "完成";
    $("exportBtn").disabled = false;
    toast("烘焙完成");
    renderCubeGrid();
    drawSphere();
    renderInspector();
  } catch (err) {
    toast(`烘焙失败: ${err.message}`, true);
  } finally {
    state.baking = false;
    $("bakeBtn").disabled = false;
    setTimeout(() => { wrap.hidden = true; $("progressBar").style.width = "0"; }, 800);
  }
}

// ---------- 检查器 ----------
function renderInspector() {
  const empty = $("inspectorEmpty");
  const body = $("inspectorBody");
  if (!state.selected || !state.baked.has(state.roughness)) {
    empty.hidden = false; body.hidden = true;
    return;
  }
  empty.hidden = true; body.hidden = false;
  const { face, row, col } = state.selected;
  const baked = state.baked.get(state.roughness);
  const p = row * state.outN + col;
  const dArr = baked.texelDirs[face];
  const d = [dArr[p * 3], dArr[p * 3 + 1], dArr[p * 3 + 2]];
  const rgb = [baked.faces[face][p * 3], baked.faces[face][p * 3 + 1], baked.faces[face][p * 3 + 2]];
  $("inspFace").textContent = face;
  $("inspCoord").textContent = `row=${row}, col=${col}`;
  $("inspDir").textContent = `(${d.map((x) => x.toFixed(5)).join(", ")})`;
  $("inspRGB").textContent = `(${rgb.map((x) => x.toFixed(5)).join(", ")})`;
  $("inspParams").textContent = `r=${state.roughness}, S=${state.roughness === 0 ? "—" : state.samples}`;

  // 实时重算该纹素的追踪（确定性，与烘焙一致）。
  const trace = bakeTexel(state.env, d, state.roughness, state.samples, true);
  fillTraceTable(trace.samples);
  drawTraceViz(trace.samples, d);
}

function fillTraceTable(samples) {
  const limitSel = $("traceLimit").value;
  const limit = limitSel === "all" ? samples.length : Math.min(samples.length, parseInt(limitSel, 10));
  $("traceLimitLabel").textContent = limit;
  const tbody = $("traceTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (let k = 0; k < limit; k++) {
    const s = samples[k];
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${s.i}</td>` +
      `<td class="mono">(${s.dir.map((x) => x.toFixed(4)).join(",")})</td>` +
      `<td>${s.envFace}</td>` +
      `<td class="mono">(${s.env.map((x) => x.toFixed(4)).join(",")})</td>` +
      `<td class="mono">${s.weight.toFixed(5)}</td>`;
    tbody.appendChild(tr);
  }
}

// 以 d 为中心的局部方位投影：把每个 ω 投到垂直 d 的平面上画点。
function drawTraceViz(samples, d) {
  const canvas = $("traceCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = W / 2 - 8;
  ctx.fillStyle = "#06090e";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#22303f"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  // 局部帧
  const a = Math.abs(d[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0];
  const t = (() => {
    const v = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
    const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l];
  })();
  const b = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  for (const s of samples) {
    const tx = s.dir[0] * t[0] + s.dir[1] * t[1] + s.dir[2] * t[2];
    const bx = s.dir[0] * b[0] + s.dir[1] * b[1] + s.dir[2] * b[2];
    const dz = s.dir[0] * d[0] + s.dir[1] * d[1] + s.dir[2] * d[2];
    if (dz <= 0) continue;
    const x = cx + tx * R, y = cy - bx * R;
    const heat = Math.max(0, Math.min(1, dz));
    ctx.fillStyle = `rgba(${Math.round(91 + 164 * heat)},${Math.round(157 - 60 * heat)},255,0.85)`;
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#ffd23f";
  ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
}

// ---------- 反射球 ----------
function sphereViewDirs() {
  const { yaw, pitch } = state.sphere;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // 相机朝向 -Z，构造相机基。
  const forward = [-sy * cp, sp, -cy * cp];
  const right = [cy, 0, -sy];
  const up = [sy * sp, cp, cy * sp];
  return { forward, right, up };
}

function drawSphere() {
  const canvas = $("sphereCanvas");
  if (!state.env) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = W / 2 - 2;
  const img = ctx.createImageData(W, H);
  const { forward, right, up } = sphereViewDirs();
  const baked = state.baked.get(state.roughness);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - cx) / R, ny = (cy - y) / R;
      const rr2 = nx * nx + ny * ny;
      const o = (y * W + x) * 4;
      if (rr2 > 1) { img.data[o + 3] = 0; continue; }
      const nz = Math.sqrt(1 - rr2);
      // 反射方向：r = reflect(view=-forward, n) = 2(n·f)n - f
      const n = [right[0] * nx + up[0] * ny + forward[0] * nz,
                 right[1] * nx + up[1] * ny + forward[1] * nz,
                 right[2] * nx + up[2] * ny + forward[2] * nz];
      const ndotf = n[0] * forward[0] + n[1] * forward[1] + n[2] * forward[2];
      const refl = [2 * ndotf * n[0] - forward[0], 2 * ndotf * n[1] - forward[1], 2 * ndotf * n[2] - forward[2]];
      let color;
      if (baked) {
        const { face, u, v } = dirToFaceUV(refl);
        const buf = baked.faces[face];
        const n2 = state.outN;
        const px = ((u + 1) * n2) / 2 - 0.5, py = ((v + 1) * n2) / 2 - 0.5;
        // 球上做简单双线性（输出面内部即可，边缘用最近邻兜底）。
        const x0 = Math.min(n2 - 1, Math.max(0, Math.floor(px)));
        const y0 = Math.min(n2 - 1, Math.max(0, Math.floor(py)));
        const tx = Math.min(1, Math.max(0, px - x0)), ty = Math.min(1, Math.max(0, py - y0));
        const x1 = Math.min(n2 - 1, x0 + 1), y1 = Math.min(n2 - 1, y0 + 1);
        const i00 = (y0 * n2 + x0) * 3, i10 = (y0 * n2 + x1) * 3, i01 = (y1 * n2 + x0) * 3, i11 = (y1 * n2 + x1) * 3;
        color = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          color[k] = (1 - tx) * (1 - ty) * buf[i00 + k] + tx * (1 - ty) * buf[i10 + k]
            + (1 - tx) * ty * buf[i01 + k] + tx * ty * buf[i11 + k];
        }
      } else {
        color = state.env.sampleBilinearDir(refl);
      }
      const [r, g, b] = displayColor(color, state.exposure);
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 球面中心法线对应的反射方向信息。
  const centerRefl = [-forward[0], -forward[1], -forward[2]];
  $("sphereInfo").textContent =
    `视角 yaw=${state.sphere.yaw.toFixed(2)} pitch=${state.sphere.pitch.toFixed(2)}\n` +
    `中心反射方向 (${centerRefl.map((x) => x.toFixed(3)).join(", ")})`;
}

function setupSphereDrag() {
  const canvas = $("sphereCanvas");
  let dragging = false, last = null;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    state.sphere.yaw += dx * 0.01;
    state.sphere.pitch = Math.max(-1.45, Math.min(1.45, state.sphere.pitch + dy * 0.01));
    last = { x: e.clientX, y: e.clientY };
    drawSphere();
  });
  const end = () => { dragging = false; last = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

// ---------- 导出 ----------
function buildConfig() {
  return {
    schema: "lobe-cubemap-baker/1",
    input: { name: state.envName, faceSize: state.envSize, encoding: "linear float RGB, row-major" },
    output: { faceSize: state.outN, faceOrder: FACE_ORDER },
    kernel: {
      roughnessToExponent: "n = max(0, 2/(r*r) - 2)",
      form: "(n+1)/(2*pi) * max(dot(d,omega),0)^n",
    },
    sampling: {
      rule: "xi1=(i+0.5)/S; xi2=radicalInverse2(i); cosTheta=(1-xi1)^(1/(n+1)); phi=2*pi*xi2",
      frame: "t=normalize(a x d); b=d x t; a=(0,0,1) if |d.z|<0.999 else (0,1,0)",
      integration: "importance-sampled equal-weight average of S environment bilinear samples",
    },
    roughnesses: DEFAULT_ROUGHNESSES,
    sampleCount: state.samples,
    exposure: { note: "preview only; export is unaffected linear float" },
    generatedAt: new Date(0).toISOString(),
  };
}

function buildTraceJSON() {
  const out = {};
  for (const r of DEFAULT_ROUGHNESSES) {
    const baked = state.baked.get(r);
    out[`r=${r}`] = {};
    for (const face of FACE_ORDER) {
      const arr = [];
      for (let p = 0; p < state.outN * state.outN; p++) {
        const dA = baked.texelDirs[face];
        const d = [dA[p * 3], dA[p * 3 + 1], dA[p * 3 + 2]];
        const trace = bakeTexel(state.env, d, r, state.samples, true);
        arr.push({
          row: Math.floor(p / state.outN), col: p % state.outN,
          dir: d, result: trace.value,
          samples: trace.samples.map((s) => ({
            i: s.i, dir: s.dir, envFace: s.envFace, env: s.env, weight: s.weight,
          })),
        });
      }
      out[`r=${r}`][face] = arr;
    }
  }
  return out;
}

async function exportZip() {
  if (state.baked.size !== DEFAULT_ROUGHNESSES.length) { toast("请先完成全部档位烘焙", true); return; }
  const entries = [];
  for (const r of DEFAULT_ROUGHNESSES) {
    const baked = state.baked.get(r);
    const tag = `r${String(r).replace(".", "_")}`;
    for (const face of FACE_ORDER) {
      entries.push({
        name: `pfm/${tag}/${face}.pfm`,
        data: encodePFM(state.outN, state.outN, baked.faces[face]),
      });
    }
  }
  entries.push({ name: "config.json", data: new TextEncoder().encode(JSON.stringify(buildConfig(), null, 2)) });
  entries.push({
    name: "sampling-trace.json",
    data: new TextEncoder().encode(JSON.stringify(buildTraceJSON())),
  });
  const zip = buildZip(entries);
  const blob = new Blob([zip], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lobe-cubemap-baker-${state.envName.replace(/\.json$/i, "") || "env"}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出 ${entries.length} 个文件（${(zip.length / 1024).toFixed(1)} KB）`);
}

// ---------- 控件绑定 ----------
function bindControls() {
  const roughSel = $("roughnessSelect");
  DEFAULT_ROUGHNESSES.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = String(r); opt.textContent = `r = ${r}`;
    roughSel.appendChild(opt);
  });
  roughSel.addEventListener("change", () => {
    state.roughness = parseFloat(roughSel.value);
    state.selected = null;
    renderCubeGrid(); drawSphere(); renderInspector();
  });
  $("sampleCount").addEventListener("input", (e) => {
    state.samples = parseInt(e.target.value, 10);
    $("sampleCountVal").textContent = state.samples;
  });
  $("outSize").addEventListener("input", (e) => {
    state.outN = parseInt(e.target.value, 10);
    $("outSizeVal").textContent = `${state.outN}×${state.outN}`;
    state.baked.clear(); state.selected = null;
    $("exportBtn").disabled = true;
    renderCubeGrid(); renderInspector();
  });
  $("exposure").addEventListener("input", (e) => {
    // 直接作为 1-exp(-exposure*value) 中的 exposure 系数（说明.txt 定义）。
    state.exposure = parseFloat(e.target.value);
    $("exposureVal").textContent = state.exposure.toFixed(2);
    renderCubeGrid(); drawSphere();
  });
  document.querySelectorAll('input[name="cubeSrc"]').forEach((el) =>
    el.addEventListener("change", () => { state.selected = null; renderCubeGrid(); renderInspector(); }));
  $("traceLimit").addEventListener("change", renderInspector);
  $("bakeBtn").addEventListener("click", runBake);
  $("exportBtn").addEventListener("click", exportZip);
  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      loadEnvironmentJSON(json, file.name);
      toast(`已导入 ${file.name}`);
    } catch (err) { toast(`导入失败: ${err.message}`, true); }
    e.target.value = "";
  });
  $("loadSampleBtn").addEventListener("click", async () => {
    try {
      const resp = await fetch("samples/extracted/highlight.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      loadEnvironmentJSON(json, "highlight.json（内置样例）");
      toast("已载入内置 highlight 样例（跨 px/pz 缝高光）");
    } catch (err) {
      toast(`内置样例加载失败（需经本地服务器访问）: ${err.message}`, true);
    }
  });
}

function init() {
  bindControls();
  setupSphereDrag();
  $("sampleCountVal").textContent = state.samples;
  $("outSizeVal").textContent = `${state.outN}×${state.outN}`;
  state.exposure = 1;
  $("exposureVal").textContent = "1.00";
}
init();
