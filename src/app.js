// UI controller: loads scenes, runs the engine, renders the four views,
// draws pre/post-clip wireframes, handles pixel inspection, cancellation
// and PNG/JSON export. All core math stays in engine.js / inspector.js.
import { rasterizeScene } from "./engine.js";
import { inspectPixel, screenPolygonOf } from "./inspector.js";
import {
  encodePng,
  linearToSrgbByte,
  buildPixelJson,
  downloadBytes,
} from "./exporters.js";

const SAMPLE_FILES = {
  perspective: "perspective.json",
  "shared-edge": "shared-edge.json",
  "equal-depth": "equal-depth.json",
  degenerate: "degenerate.json",
  "near-cross": "near-cross.json",
  "behind-eye": "behind-eye.json",
  "invalid-index": "invalid-index.json",
  stress: "stress.json",
};

const state = {
  scene: null,
  sceneName: "",
  result: null,
  view: "color", // color | depth | face | coverage
  mesh: "post", // off | pre | post
  zoom: 1,
  selected: null, // {px, py}
  running: false,
  cancel: null,
  runToken: 0,
};

const $ = (id) => document.getElementById(id);
const canvas = $("raster-canvas");
const ctx = canvas.getContext("2d");

// ---------- deterministic face-id color ----------
function faceColor(id) {
  if (id < 0) return [0, 0, 0];
  let h = (id + 1) * 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  const hue = (h >>> 0) % 360;
  // HSL (hue, 65%, 55%) -> RGB
  const s = 0.65;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ---------- framebuffer -> ImageData ----------
function renderToImageData() {
  const r = state.result;
  const { width, height } = r;
  const img = ctx.createImageData(width, height);
  const data = img.data;
  for (let i = 0; i < width * height; i++) {
    let rr = 0, gg = 0, bb = 0;
    const face = r.faceBuffer[i];
    if (state.view === "color") {
      if (face >= 0) {
        rr = linearToSrgbByte(r.rgb[0][i]);
        gg = linearToSrgbByte(r.rgb[1][i]);
        bb = linearToSrgbByte(r.rgb[2][i]);
      }
    } else if (state.view === "depth") {
      if (face >= 0) {
        const d = Math.min(1, Math.max(0, r.depthBuffer[i]));
        const v = Math.round((1 - d) * 255); // near=white, far=black
        rr = gg = bb = v;
      }
    } else if (state.view === "face") {
      if (face >= 0) [rr, gg, bb] = faceColor(face);
    } else if (state.view === "coverage") {
      const cov = r.coverage[i];
      if (cov === 0) [rr, gg, bb] = [0, 0, 0];
      else if (cov === 1) [rr, gg, bb] = [24, 96, 74];
      else {
        // heat: more overlapping fragments -> brighter amber/red
        const t = Math.min(1, Math.log2(cov) / 6);
        rr = Math.round(180 + 75 * t);
        gg = Math.round(90 * (1 - t) + 40);
        bb = Math.round(40 * (1 - t));
      }
    }
    data[i * 4] = rr;
    data[i * 4 + 1] = gg;
    data[i * 4 + 2] = bb;
    data[i * 4 + 3] = 255;
  }
  return img;
}

function drawMeshOverlay() {
  const r = state.result;
  if (state.mesh === "off") return;
  const { width, height } = r;
  ctx.save();
  ctx.lineWidth = 1 / state.zoom;

  for (const rec of r.faceRecords) {
    if (!rec || !rec.valid) continue;
    if (state.mesh === "pre") {
      // Original triangle projected directly (only vertices with w>EPS shown,
      // so behind-eye geometry is drawn in clipped NDC where it still maps).
      const pts = rec.original
        .filter((v) => v.x[3] > 1e-12)
        .map((v) => {
          const w = v.x[3];
          return {
            x: (v.x[0] / w + 1) * width * 0.5,
            y: (1 - v.x[1] / w) * height * 0.5,
          };
        });
      if (pts.length === 3) strokePoly(pts, "rgba(125,211,252,0.9)", true);
    } else {
      const poly = screenPolygonOf(rec, width, height);
      if (poly && poly.length >= 3) {
        strokePoly(poly.map((p) => ({ x: p.sx, y: p.sy })), "rgba(253,224,71,0.9)", false);
      }
    }
  }
  ctx.restore();
}

function strokePoly(pts, color, close) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.stroke();
}

function drawSelection() {
  if (!state.selected) return;
  const { px, py } = state.selected;
  ctx.save();
  ctx.lineWidth = 1 / state.zoom;
  ctx.strokeStyle = "#f472b6";
  ctx.strokeRect(px + 0.06, py + 0.06, 0.88, 0.88);
  ctx.restore();
}

function renderCanvas() {
  if (!state.result) return;
  const r = state.result;
  canvas.width = r.width;
  canvas.height = r.height;
  ctx.putImageData(renderToImageData(), 0, 0);
  ctx.imageSmoothingEnabled = false;
  drawMeshOverlay();
  drawSelection();
  canvas.style.width = `${r.width * state.zoom}px`;
  canvas.style.height = `${r.height * state.zoom}px`;
}

// ---------- run pipeline ----------
async function runScene(scene, name) {
  state.scene = scene;
  state.sceneName = name;
  state.selected = null;
  const token = ++state.runToken;
  state.cancel = { cancelled: false };
  state.running = true;
  updateRunUI(true);
  $("progress-bar").style.width = "0%";
  $("status-line").textContent = `正在计算 ${name}…`;

  try {
    const result = await rasterizeScene(scene, {
      signal: state.cancel,
      yieldEvery: 32,
      onProgress: (p) => {
        if (token !== state.runToken) return;
        $("progress-bar").style.width = `${(p * 100).toFixed(1)}%`;
        $("status-line").textContent =
          `正在计算 ${name}… ${(p * 100).toFixed(0)}%`;
      },
    });
    if (token !== state.runToken) return;
    state.result = result;
    $("status-line").textContent = `完成：${name}`;
    renderCanvas();
    renderStats();
    renderInspectorBlank();
  } catch (err) {
    if (err && err.cancelled) {
      $("status-line").textContent = `已取消：${name}`;
    } else {
      $("status-line").textContent = `计算失败：${err.message || err}`;
      throw err;
    }
  } finally {
    if (token === state.runToken) {
      state.running = false;
      updateRunUI(false);
    }
  }
}

function updateRunUI(running) {
  $("btn-run").disabled = running;
  $("btn-cancel").hidden = !running;
  $("btn-export-png").disabled = !state.result;
  $("btn-export-json").disabled = !state.result;
}

function renderStats() {
  const s = state.result.stats;
  const rows = [
    ["总面数", s.totalFaces],
    ["有效绘制面", s.drawnFaces],
    ["触发裁剪面", s.clippedFaces],
    ["裁剪后子三角形", s.emittedTriangles],
    ["退化面（跳过）", s.degenerateFaces],
    ["非法索引面", s.invalidFaces],
    ["覆盖像素", s.coveredPixels],
    ["深度否决次数", s.depthRejected],
    ["多重覆盖像素", s.multiCoveredPixels],
  ];
  $("stats-body").innerHTML = rows
    .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`)
    .join("");
}

// ---------- inspector ----------
function renderInspectorBlank() {
  $("inspector").innerHTML =
    '<p class="hint">点击任意像素查看原始面、裁剪顶点、重心权重与逐通道插值。</p>';
}

function fmt(n, digits = 6) {
  if (n === null || n === undefined || Number.isNaN(n)) return String(n);
  if (!Number.isFinite(n)) return n > 0 ? "∞" : "-∞";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e5)) return n.toExponential(4);
  return Number(n.toFixed(digits)).toString();
}

function renderInspector() {
  if (!state.selected || !state.result) return renderInspectorBlank();
  const { px, py } = state.selected;
  const info = inspectPixel(state.result, state.scene, px, py);
  const root = $("inspector");

  if (!info.covered) {
    root.innerHTML = `
      <h3>像素 (${px}, ${py})</h3>
      <p class="hint">未覆盖 — face=-1，depth=null，rgb=[0,0,0]</p>`;
    return;
  }

  const d = info.derivation;
  const rec = info.rec;
  const origRows = rec.original
    .map(
      (v, i) =>
        `<tr><td>v${i}</td><td>${v.x.map((x) => fmt(x, 4)).join(", ")}</td><td>${v.rgb.map((x) => fmt(x, 3)).join(", ")}</td></tr>`
    )
    .join("");
  const clipRows = rec.clippedPoly
    .map(
      (v, i) =>
        `<tr><td>c${i}</td><td>${v.x.map((x) => fmt(x, 4)).join(", ")}</td><td>${v.rgb.map((x) => fmt(x, 3)).join(", ")}</td></tr>`
    )
    .join("");

  let termHtml = "";
  if (d) {
    termHtml = d.terms
      .map((t, i) => {
        const edge = d.edges[i];
        return `<tr>
          <td>子顶点 ${i}</td>
          <td>λ=${fmt(t.lambda)}</td>
          <td>1/w=${fmt(1 / t.w)}</td>
          <td>λ/w=${fmt(t.lambdaOverW)}</td>
          <td>z/w=${fmt(t.zOverW)}</td>
        </tr>`;
      })
      .join("");
  }

  root.innerHTML = `
    <h3>像素 (${px}, ${py}) · 采样点 (${fmt(info.sample[0], 2)}, ${fmt(info.sample[1], 2)})</h3>
    <div class="kv">
      <span>获胜面</span><strong>#${info.faceId}</strong>
      <span>该像素碎片数</span><strong>${info.coverage}</strong>
      <span>实际写入次数</span><strong>${info.writes}</strong>
      <span>面状态</span><strong>${rec.clipped ? "已裁剪" : "未裁剪"}${rec.degenerate ? "（退化）" : ""}</strong>
    </div>

    <h4>原始面齐次顶点</h4>
    <div class="table-wrap"><table><thead><tr><th></th><th>x [x,y,z,w]</th><th>rgb</th></tr></thead><tbody>${origRows}</tbody></table></div>

    <h4>裁剪后顶点（${rec.clippedPoly.length} 个）</h4>
    <div class="table-wrap"><table><thead><tr><th></th><th>x [x,y,z,w]</th><th>rgb</th></tr></thead><tbody>${clipRows}</tbody></table></div>
    ${
      d
        ? `<h4>重心与透视插值</h4>
      <p class="hint">子三角形有向面积=${fmt(d.area, 4)}，λ 之和=${fmt(d.barySum, 10)}；
      边零值：${d.edges.map((e) => (e.onEdge ? "命中边(纳入)" : "严格内")).join("，")}</p>
      <div class="table-wrap"><table><thead><tr><th></th><th>重心 λ</th><th>1/w</th><th>λ/w</th><th>z/w</th></tr></thead><tbody>${termHtml}</tbody></table></div>
      <div class="kv">
        <span>Σ(λ/w)</span><strong>${fmt(d.sumLambdaOverW)}</strong>
        <span>深度 Σ(λz/w)</span><strong>${fmt(d.depth)}</strong>
        <span>线性 RGB</span><strong>[${d.color.map((x) => fmt(x)).join(", ")}]</strong>
      </div>`
        : '<p class="hint">该面在本像素无可视化子三角形。</p>'
    }`;
}

// ---------- events ----------
function bindEvents() {
  $("sample-select").addEventListener("change", async (e) => {
    const file = SAMPLE_FILES[e.target.value];
    if (!file) return;
    const resp = await fetch(`src/samples/${file}`);
    const scene = await resp.json();
    loadScene(scene, e.target.options[e.target.selectedIndex].text);
  });

  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const scene = JSON.parse(text);
      const error = validateScene(scene);
      if (error) {
        $("status-line").textContent = `输入无效：${error}`;
        return;
      }
      loadScene(scene, file.name);
    } catch (err) {
      $("status-line").textContent = `解析失败：${err.message}`;
    }
  });

  $("btn-run").addEventListener("click", () => {
    if (state.scene) runScene(state.scene, state.sceneName);
  });
  $("btn-cancel").addEventListener("click", () => {
    if (state.cancel) state.cancel.cancelled = true;
    $("btn-cancel").disabled = true;
  });

  document.querySelectorAll('input[name="view"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.view = e.target.value;
      renderCanvas();
    });
  });
  $("mesh-select").addEventListener("change", (e) => {
    state.mesh = e.target.value;
    renderCanvas();
  });
  $("zoom-select").addEventListener("change", (e) => {
    state.zoom = Number(e.target.value);
    renderCanvas();
  });

  canvas.addEventListener("click", (e) => {
    if (!state.result) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
    state.selected = { px, py };
    renderCanvas();
    renderInspector();
  });

  $("btn-export-png").addEventListener("click", exportPng);
  $("btn-export-json").addEventListener("click", exportJson);
}

function validateScene(scene) {
  if (!scene || typeof scene !== "object") return "不是 JSON 对象";
  if (!Number.isInteger(scene.width) || !Number.isInteger(scene.height))
    return "width/height 必须为整数";
  if (scene.width <= 0 || scene.height <= 0 || scene.width > 256 || scene.height > 256)
    return "width/height 须在 1..256";
  if (!Array.isArray(scene.vertices) || !Array.isArray(scene.triangles))
    return "vertices/triangles 必须为数组";
  if (scene.triangles.length > 5000) return "三角形数量超过 5000";
  for (const v of scene.vertices) {
    if (!Array.isArray(v.x) || v.x.length !== 4 || !Array.isArray(v.rgb) || v.rgb.length !== 3)
      return "顶点需含 x[4] 与 rgb[3]";
  }
  return null;
}

function loadScene(scene, name) {
  state.scene = scene;
  state.sceneName = name;
  $("scene-meta").textContent =
    `${name} · ${scene.width}×${scene.height} · ${scene.vertices.length} 顶点 · ${scene.triangles.length} 面`;
  runScene(scene, name);
}

function exportPng() {
  const r = state.result;
  const img = renderToImageData();
  // Re-render without overlay/selection for a clean framebuffer export.
  const png = encodePng(r.width, r.height, img.data);
  downloadBytes(png, `${baseName()}-${state.view}.png`, "image/png");
}

function exportJson() {
  const includeCoverage = $("opt-coverage").checked;
  const payload = buildPixelJson(state.result, includeCoverage);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  downloadBytes(bytes, `${baseName()}-pixels.json`, "application/json");
}

function baseName() {
  return state.sceneName.replace(/\.json$/i, "").replace(/[^\w.-]+/g, "_") || "raster";
}

// ---------- boot ----------
async function boot() {
  bindEvents();
  const resp = await fetch("src/samples/perspective.json");
  const scene = await resp.json();
  loadScene(scene, "perspective.json");
}

boot();
