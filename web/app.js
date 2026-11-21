/* Slanted-edge MTF workbench UI. Depends on mtf-core.js (global MtfCore). */
(function () {
  "use strict";
  const C = window.MtfCore;
  const $ = (id) => document.getElementById(id);
  const MAX_SIDE = 1536;
  const MAX_ROIS = 16;

  const state = {
    img: null, w: 0, h: 0, fileName: "",
    rois: [],            // {x,y,w,h}
    results: new Map(),  // index -> analyzeRoi result
    selected: -1,
    scale: 1,
    drawing: false,
    drag: null,
    theme: null,
  };

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else if (t === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("mtf-theme", t || "system"); } catch (_) {}
    if (state.img) { renderImage(); renderOverlay(); renderReport(); renderDetail(); }
  }
  $("themeBtn").addEventListener("click", () => {
    const order = ["system", "light", "dark"];
    const cur = state.theme || "system";
    state.theme = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme(state.theme);
    toast("主题：" + (state.theme === "system" ? "跟随系统" : state.theme === "light" ? "浅色" : "深色"));
  });
  try {
    const saved = localStorage.getItem("mtf-theme");
    if (saved && saved !== "system") { state.theme = saved; applyTheme(saved); }
  } catch (_) {}

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------------- toast / error ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }
  function showError(msg) {
    const el = $("importError");
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  /* ---------------- file import ---------------- */
  let pickedImage = null, pickedJson = null;

  $("imgFile").addEventListener("change", (e) => {
    pickedImage = e.target.files[0] || null;
    updateFileLabel();
  });
  $("jsonFile").addEventListener("change", (e) => {
    pickedJson = e.target.files[0] || null;
    updateFileLabel();
  });
  function updateFileLabel() {
    const parts = [];
    if (pickedImage) parts.push("图像：" + pickedImage.name);
    if (pickedJson) parts.push("JSON：" + pickedJson.name);
    $("fileName").textContent = parts.join("　");
    $("analyzeBtn").disabled = !pickedImage;
    showError("");
  }

  const drop = $("dropZone");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); })
  );
  drop.addEventListener("drop", async (e) => {
    const files = Array.from(e.dataTransfer.files);
    const imgF = files.find((f) => /\.(u16|bin|raw)$/i.test(f.name));
    const jsonF = files.find((f) => /\.json$/i.test(f.name));
    if (imgF) { pickedImage = imgF; $("imgFile").files = e.dataTransfer.files; }
    if (jsonF) pickedJson = jsonF;
    updateFileLabel();
    if (imgF) await loadImage(imgF, jsonF || null);
  });

  $("analyzeBtn").addEventListener("click", () => loadImage(pickedImage, pickedJson));

  async function loadImage(imgFile, jsonFile) {
    showError("");
    try {
      const buf = new Uint8Array(await imgFile.arrayBuffer());
      let meta = null;
      if (jsonFile) {
        const txt = new TextDecoder().decode(await jsonFile.arrayBuffer());
        meta = JSON.parse(txt);
      }
      const guess = guessDimensions(buf.length, meta);
      const { w, h } = guess;
      if (w > MAX_SIDE || h > MAX_SIDE) {
        throw new Error(`图像单边 ${Math.max(w, h)}px 超过 1536 限制`);
      }
      if (buf.length !== w * h * 2) {
        throw new Error(`字节数 ${buf.length} 与尺寸 ${w}×${h}×2 不匹配`);
      }
      const img = new Uint16Array(w * h);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < w * h; i++) img[i] = dv.getUint16(i * 2, true);

      state.img = img; state.w = w; state.h = h;
      state.fileName = imgFile.name;
      state.rois = sanitizeRois(meta && meta.rois, w, h);
      state.results = new Map();
      state.selected = state.rois.length ? 0 : -1;

      $("imgMeta").textContent = `${imgFile.name} · ${w}×${h} · 16-bit 线性灰度`;
      $("imgPill").hidden = false;
      $("imageCard").hidden = false;
      $("reportCard").hidden = false;
      $("exportBtn").disabled = false;
      runAllAnalyses();
      renderImage();
      renderOverlay();
      renderReport();
      renderDetail();
      toast(`已载入 ${state.rois.length} 个测区`);
    } catch (err) {
      showError("导入失败：" + err.message);
    }
  }

  function guessDimensions(byteLen, meta) {
    if (meta && Number.isInteger(meta.w) && Number.isInteger(meta.h)) {
      return { w: meta.w, h: meta.h };
    }
    const px = byteLen / 2;
    const s = Math.round(Math.sqrt(px));
    if (s * s === px) return { w: s, h: s };
    throw new Error("无法确定图像尺寸，请在 JSON 中提供 w、h");
  }

  function sanitizeRois(rois, w, h) {
    if (!Array.isArray(rois)) return [];
    const out = [];
    for (const r of rois) {
      if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v))) continue;
      let [x, y, rw, rh] = r.map(Math.round);
      rw = Math.max(4, Math.min(rw, w));
      rh = Math.max(4, Math.min(rh, h));
      x = Math.max(0, Math.min(x, w - rw));
      y = Math.max(0, Math.min(y, h - rh));
      out.push({ x, y, w: rw, h: rh });
      if (out.length === MAX_ROIS) break;
    }
    return out;
  }

  /* ---------------- analysis ---------------- */
  function runAllAnalyses() {
    state.results = new Map();
    state.rois.forEach((roi, i) => {
      try {
        state.results.set(i, C.analyzeRoi(state.img, state.w, state.h, [roi.x, roi.y, roi.w, roi.h]));
      } catch (err) {
        state.results.set(i, { valid: false, reason: "计算异常：" + err.message, edge: { valid: false } });
      }
    });
  }

  /* ---------------- image canvas ---------------- */
  const canvas = $("imgCanvas");
  const overlay = $("overlay");
  const wrap = $("canvasWrap");

  function renderImage() {
    const { img, w, h } = state;
    // chart background marker (32768) is excluded from the data stretch and
    // rendered as a fixed mid-gray so it never biases the display contrast
    const dataVals = [];
    for (let i = 0; i < img.length; i++) if (img[i] !== C.BG_VALUE) dataVals.push(img[i]);
    dataVals.sort((a, b) => a - b);
    const dMin = dataVals[Math.floor(dataVals.length * 0.005)];
    const dMax = dataVals[dataVals.length - 1 - Math.floor(dataVals.length * 0.005)];
    const cw = wrap.clientWidth || Math.min(w, 760);
    const scale = Math.min(3, Math.max(1, Math.floor(cw / w)));
    state.scale = scale;
    canvas.width = w; canvas.height = h;
    canvas.style.width = w * scale + "px";
    canvas.style.height = h * scale + "px";
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(w, h);
    const span = Math.max(1, dMax - dMin);
    const bgGray = 46;
    for (let i = 0; i < w * h; i++) {
      let g;
      if (img[i] === C.BG_VALUE) g = bgGray;
      else {
        g = Math.round(((img[i] - dMin) / span) * 255);
        g = Math.max(0, Math.min(255, g));
      }
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = g;
      out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
    overlay.setAttribute("width", w * scale);
    overlay.setAttribute("height", h * scale);
    overlay.style.width = w * scale + "px";
    overlay.style.height = h * scale + "px";
  }

  function minMaxValue(img) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < img.length; i++) {
      const v = img[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function renderOverlay() {
    overlay.innerHTML = "";
    const s1 = cssVar("--series-1");
    const reject = cssVar("--reject");
    if (drawArmed) {
      overlay.appendChild(el("rect", {
        class: "draw-catcher", x: 0, y: 0, width: state.w, height: state.h,
        fill: "transparent",
      }));
    }
    state.rois.forEach((roi, i) => {
      const res = state.results.get(i);
      const g = el("g", {});
      const rect = el("rect", {
        class: "roi-rect" + (i === state.selected ? " selected" : ""),
        x: roi.x, y: roi.y, width: roi.w, height: roi.h,
        stroke: res && !res.valid ? reject : s1,
        rx: 1,
      });
      g.appendChild(rect);
      const hit = el("rect", {
        class: "roi-hit" + (i === state.selected ? " selected" : ""),
        x: roi.x, y: roi.y, width: roi.w, height: roi.h,
        "data-idx": i,
      });
      g.appendChild(hit);
      const label = el("text", { class: "roi-label", x: roi.x + 3, y: roi.y + 13 });
      label.textContent = "#" + (i + 1) + (res && !res.valid ? " ✕" : "");
      g.appendChild(label);

      if (res && res.valid) drawEdgeOverlay(g, res, roi);      overlay.appendChild(g);
    });
  }

  function drawEdgeOverlay(g, res, roi) {
    const edge = res.edge;
    const [nx, ny] = edge.normal;
    const tx = -ny, ty = nx;
    // clip the fitted line to this ROI so it never crosses neighboring ROIs
    const [lx, ly] = edge.linePoint;
    const ext = 200;
    const seg = clipLine(
      lx - tx * ext, ly - ty * ext, lx + tx * ext, ly + ty * ext,
      roi.x, roi.y, roi.x + roi.w, roi.y + roi.h
    );
    if (seg) {
      g.appendChild(el("line", {
        class: "edge-line",
        x1: seg[0], y1: seg[1], x2: seg[2], y2: seg[3],
        stroke: cssVar("--series-1"),
      }));
    }
    edge.points.forEach((p, k) => {
      const inlier = edge.inliers[k];
      const [u, v] = p;
      const cx = edge.vertical ? v : u;
      const cy = edge.vertical ? u : v;
      g.appendChild(el("circle", {
        class: "pt " + (inlier ? "inlier" : "reject"),
        cx, cy, r: 1.1,
      }));
    });
  }

  /* Liang-Barsky clipping of a segment to rectangle [xmin,ymin,xmax,ymax]. */
  function clipLine(x0, y0, x1, y1, xmin, ymin, xmax, ymax) {
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    const sides = [[-dx, x0 - xmin], [dx, xmax - x0], [-dy, y0 - ymin], [dy, ymax - y0]];
    for (const [p, q] of sides) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  }

  /* ---------------- ROI interactions ---------------- */
  function eventToImage(e) {
    const r = overlay.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * state.w,
      y: ((e.clientY - r.top) / r.height) * state.h,
    };
  }

  overlay.addEventListener("mousedown", (e) => {
    const hit = e.target.closest(".roi-hit");
    if (!hit) return;
    const idx = Number(hit.dataset.idx);
    state.selected = idx;
    const p = eventToImage(e);
    state.drag = { idx, dx: p.x - state.rois[idx].x, dy: p.y - state.rois[idx].y, moved: false };
    renderOverlay(); renderReport(); renderDetail();
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!state.drag) return;
    const p = eventToImage(e);
    const roi = state.rois[state.drag.idx];
    roi.x = Math.round(Math.max(0, Math.min(p.x - state.drag.dx, state.w - roi.w)));
    roi.y = Math.round(Math.max(0, Math.min(p.y - state.drag.dy, state.h - roi.h)));
    state.drag.moved = true;
    renderOverlay();
  });
  window.addEventListener("mouseup", () => {
    if (!state.drag) return;
    const idx = state.drag.idx;
    state.drag = null;
    state.results.set(idx, C.analyzeRoi(state.img, state.w, state.h, [
      state.rois[idx].x, state.rois[idx].y, state.rois[idx].w, state.rois[idx].h,
    ]));
    renderOverlay(); renderReport(); renderDetail();
  });

  $("deleteBtn").addEventListener("click", deleteSelected);
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected >= 0 &&
        !/input|textarea|select/i.test(document.activeElement.tagName)) {
      deleteSelected();
    }
  });
  function deleteSelected() {
    if (state.selected < 0) return;
    state.rois.splice(state.selected, 1);
    runAllAnalyses();
    state.selected = state.rois.length ? Math.min(state.selected, state.rois.length - 1) : -1;
    renderOverlay(); renderReport(); renderDetail(); updateRoiCount();
    toast("测区已删除");
  }

  let drawArmed = false;
  $("drawBtn").addEventListener("click", () => {
    if (state.rois.length >= MAX_ROIS) { toast("最多 16 个测区"); return; }
    drawArmed = !drawArmed;
    $("drawBtn").textContent = drawArmed ? "在图上拖出矩形（再点取消）" : "✚ 绘制测区";
    overlay.classList.toggle("interactive", drawArmed);
    renderOverlay();
  });
  let drawStart = null;
  overlay.addEventListener("mousedown", (e) => {
    if (!drawArmed || e.target.closest(".roi-hit")) return;
    drawStart = eventToImage(e);
    e.preventDefault();
  });
  window.addEventListener("mouseup", (e) => {
    if (!drawArmed || !drawStart) return;
    const p0 = drawStart; drawStart = null;
    const p1 = eventToImage(e);
    let x = Math.max(0, Math.round(Math.min(p0.x, p1.x)));
    let y = Math.max(0, Math.round(Math.min(p0.y, p1.y)));
    let rw = Math.round(Math.abs(p1.x - p0.x));
    let rh = Math.round(Math.abs(p1.y - p0.y));
    if (rw < 8 || rh < 8) {
      rw = Math.min(Number($("drawW").value) || 91, state.w);
      rh = Math.min(Number($("drawH").value) || 81, state.h);
      x = Math.round(Math.max(0, Math.min(p0.x - rw / 2, state.w - rw)));
      y = Math.round(Math.max(0, Math.min(p0.y - rh / 2, state.h - rh)));
    }
    if (state.rois.length >= MAX_ROIS) { toast("最多 16 个测区"); return; }
    state.rois.push({ x, y, w: rw, h: rh });
    state.selected = state.rois.length - 1;
    runAllAnalyses();
    drawArmed = false;
    $("drawBtn").textContent = "✚ 绘制测区";
    overlay.classList.remove("interactive");
    renderOverlay(); renderReport(); renderDetail(); updateRoiCount();
  });

  function updateRoiCount() {
    $("roiCount").textContent = state.rois.length;
    $("roiCountPill").hidden = state.rois.length === 0;
    $("deleteBtn").disabled = state.selected < 0;
    const full = state.rois.length >= MAX_ROIS;
    $("drawBtn").disabled = full;
    if (full && drawArmed) {
      drawArmed = false;
      overlay.classList.remove("interactive");
      $("drawBtn").textContent = "✚ 绘制测区";
      renderOverlay();
    }
    $("drawBtn").title = full ? "已达 16 个测区上限" : "";
  }

  /* ---------------- report table ---------------- */
  function renderReport() {
    const tb = $("reportTable").querySelector("tbody");
    tb.innerHTML = "";
    state.rois.forEach((roi, i) => {
      const res = state.results.get(i);
      const tr = document.createElement("tr");
      if (i === state.selected) tr.classList.add("selected");
      const td = (txt, cls) => {
        const t = document.createElement("td");
        if (cls) t.className = cls;
        t.textContent = txt;
        return t;
      };
      tr.appendChild(td("#" + (i + 1)));
      tr.appendChild(td(roi.x, "num"));
      tr.appendChild(td(roi.y, "num"));
      tr.appendChild(td(roi.w, "num"));
      tr.appendChild(td(roi.h, "num"));
      let dir = "—", pol = "—", slope = "—";
      if (res && res.valid) {
        dir = res.edge.vertical ? "近垂直" : "近水平";
        pol = polarityText(res);
        slope = fmt(res.edge.slope, 4);
      }
      tr.appendChild(td(dir));
      tr.appendChild(td(pol));
      tr.appendChild(td(slope, "num"));
      tr.appendChild(td(res && res.valid && res.mtf50 != null ? fmt(res.mtf50, 4) : "不可测", "num"));
      tr.appendChild(td(res && res.valid && res.mtf10 != null ? fmt(res.mtf10, 4) : "不可测", "num"));
      const st = document.createElement("td");
      st.innerHTML = "";
      const ok = !!(res && res.valid);
      st.className = ok ? "status-ok" : "status-bad";
      st.textContent = ok ? "有效" : "无效";
      tr.appendChild(st);
      const reason = document.createElement("td");
      reason.className = "reason-cell";
      reason.textContent = ok ? "" : (res ? res.reason : "未计算");
      tr.appendChild(reason);
      tr.addEventListener("click", () => {
        state.selected = i;
        renderOverlay(); renderReport(); renderDetail();
        $("imageCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      tb.appendChild(tr);
    });
    updateRoiCount();
  }

  function polarityText(res) {
    // normal points to bright side; vertical edge: bright on right if nx>0
    const [nx, ny] = res.edge.normal;
    if (res.edge.vertical) return nx > 0 ? "暗→亮（亮在右）" : "亮→暗（亮在左）";
    return ny > 0 ? "暗→亮（亮在下）" : "亮→暗（亮在上）";
  }

  function fmt(v, d) {
    return Number(v).toFixed(d);
  }

  /* ---------------- detail + charts ---------------- */
  function renderDetail() {
    const i = state.selected;
    if (i < 0 || !state.rois[i]) {
      $("detailCard").hidden = true;
      $("placeholderCard").hidden = false;
      return;
    }
    $("detailCard").hidden = false;
    $("placeholderCard").hidden = true;
    const roi = state.rois[i];
    const res = state.results.get(i);
    $("detailTitle").textContent = "#" + (i + 1) + `（${roi.x},${roi.y} ${roi.w}×${roi.h}）`;
    const pill = $("detailStatus");
    pill.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "dot " + (res.valid ? "ok" : "bad");
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(res.valid ? "有效" : "无效"));

    const setMetric = (id, v, d) => {
      const node = $(id);
      if (v == null) { node.textContent = "不可测"; node.className = "value na"; }
      else { node.textContent = fmt(v, d); node.className = "value"; }
    };
    if (res.valid) {
      setMetric("m50", res.mtf50, 4);
      setMetric("m10", res.mtf10, 4);
      $("slopeV").textContent = fmt(res.edge.slope, 4);
      $("slopeV").className = "value";
      $("detailReason").hidden = true;
      drawEsf(res); drawLsf(res); drawMtf(res);
    } else {
      setMetric("m50", null); setMetric("m10", null);
      $("slopeV").textContent = res.edge && res.edge.slope != null ? fmt(res.edge.slope, 4) : "—";
      $("slopeV").className = "value";
      $("detailReason").hidden = false;
      $("detailReason").textContent = "无效原因：" + res.reason;
      $("chartEsf").innerHTML = $("chartLsf").innerHTML = $("chartMtf").innerHTML = "";
    }
  }

  /* generic SVG line chart with crosshair point-reading */
  function lineChart(containerId, opts) {
    const { series, xLabel, yLabel, xMin, xMax, marker } = opts;
    const W = 460, H = 170, M = { l: 46, r: 14, t: 14, b: 30 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const allY = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    let yMin = Math.min(...allY), yMax = Math.max(...allY);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.06;
    yMin -= pad; yMax += pad;
    const sx = (x) => M.l + ((x - xMin) / (xMax - xMin)) * iw;
    const sy = (y) => M.t + ih - ((y - yMin) / (yMax - yMin)) * ih;

    const svg = el("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, role: "img" });
    const nTicks = 4;
    const compact = (v) => {
      const a = Math.abs(v);
      if (a >= 10000) return (v / 1000).toFixed(0) + "k";
      if (a >= 100) return v.toFixed(0);
      if (a >= 1) return v.toFixed(1);
      return v.toFixed(2);
    };
    for (let t = 0; t <= nTicks; t++) {
      const yv = yMin + ((yMax - yMin) * t) / nTicks;
      const yy = sy(yv);
      svg.appendChild(el("line", { class: "grid-line", x1: M.l, x2: M.l + iw, y1: yy, y2: yy }));
      const txt = el("text", { x: M.l - 5, y: yy + 3.5, "text-anchor": "end" });
      txt.textContent = compact(yv);
      svg.appendChild(txt);
    }
    const xTicks = 4;
    const xDecimals = xMax - xMin <= 1 ? 2 : 1;
    for (let t = 0; t <= xTicks; t++) {
      const xv = xMin + ((xMax - xMin) * t) / xTicks;
      const xx = sx(xv);
      const txt = el("text", { x: xx, y: H - 9, "text-anchor": "middle" });
      txt.textContent = xv.toFixed(xDecimals);
      svg.appendChild(txt);
    }
    svg.appendChild(el("line", { class: "axis-line", x1: M.l, x2: M.l, y1: M.t, y2: M.t + ih }));
    svg.appendChild(el("line", { class: "axis-line", x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));
    const xlab = el("text", { x: M.l + iw, y: H - 0.5, "text-anchor": "end", style: "font-weight:600" });
    xlab.textContent = xLabel; svg.appendChild(xlab);
    const ylab = el("text", { x: 12, y: M.t + ih / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${M.t + ih / 2})`, style: "font-weight:600" });
    ylab.textContent = yLabel; svg.appendChild(ylab);

    series.forEach((s) => {
      const d = s.values.map((v, k) => `${k ? "L" : "M"}${sx(s.x[k]).toFixed(2)},${sy(v).toFixed(2)}`).join("");
      svg.appendChild(el("path", { class: "series-line", d, stroke: s.color }));
    });
    if (marker) {
      marker.forEach((mk) => {
        svg.appendChild(el("line", {
          class: "crosshair", x1: sx(mk.x), x2: sx(mk.x), y1: M.t, y2: M.t + ih,
          stroke: mk.color,
        }));
      });
    }

    const cross = el("line", { class: "crosshair", y1: M.t, y2: M.t + ih, visibility: "hidden" });
    svg.appendChild(cross);
    const dots = series.map((s) => {
      const c = el("circle", { class: "hover-dot", r: 4, fill: s.color, visibility: "hidden" });
      svg.appendChild(c);
      return c;
    });

    const tip = $("tip");
    svg.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const frac = Math.max(0, Math.min(1, (px - M.l) / iw));
      const xv = xMin + frac * (xMax - xMin);
      const k = Math.round((xv - xMin) / ((xMax - xMin) / (series[0].x.length - 1)));
      const kk = Math.max(0, Math.min(series[0].x.length - 1, k));
      const realX = series[0].x[kk];
      cross.setAttribute("x1", sx(realX)); cross.setAttribute("x2", sx(realX));
      cross.setAttribute("visibility", "visible");
      series.forEach((s, si) => {
        dots[si].setAttribute("cx", sx(realX));
        dots[si].setAttribute("cy", sy(s.values[kk]));
        dots[si].setAttribute("visibility", "visible");
      });
      tip.innerHTML = "";
      const head = document.createElement("div");
      head.className = "row";
      head.innerHTML = `<span class="k">${xLabel}</span><b>${realX.toFixed(3)}</b>`;
      tip.appendChild(head);
      series.forEach((s) => {
        const row = document.createElement("div");
        row.className = "row";
        const name = document.createElement("span");
        name.className = "k";
        name.textContent = s.name;
        const val = document.createElement("b");
        val.textContent = Number(s.values[kk]).toFixed(4);
        row.appendChild(name); row.appendChild(val);
        tip.appendChild(row);
      });
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + "px";
      tip.style.top = Math.max(8, Math.min(window.innerHeight - th - 8, e.clientY - th - 10)) + "px";
    });
    svg.addEventListener("mouseleave", () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    });

    const host = $(containerId);
    host.innerHTML = "";
    host.appendChild(svg);
  }

  function drawEsf(res) {
    lineChart("chartEsf", {
      series: [{ name: "ESF", values: res.esf, x: res.binCenters, color: cssVar("--series-2") }],
      xMin: C.BIN_MIN, xMax: C.BIN_MAX, xLabel: "法向距离（像素）", yLabel: "ESF（码值）",
    });
  }
  function drawLsf(res) {
    const lsfX = res.binCenters.slice(1, -1);
    lineChart("chartLsf", {
      series: [{ name: "LSF", values: res.lsf, x: lsfX, color: cssVar("--series-3") }],
      xMin: C.BIN_MIN, xMax: C.BIN_MAX, xLabel: "法向距离（像素）", yLabel: "LSF",
    });
  }
  function drawMtf(res) {
    const fx = res.mtf.map((_, j) => j * C.F_STEP);
    const markers = [];
    if (res.mtf50 != null) markers.push({ x: res.mtf50, color: cssVar("--series-4") });
    if (res.mtf10 != null) markers.push({ x: res.mtf10, color: cssVar("--reject") });
    lineChart("chartMtf", {
      series: [{ name: "MTF", values: res.mtf, x: fx, color: cssVar("--series-1") }],
      xMin: 0, xMax: C.F_MAX, xLabel: "空间频率（周期/像素）", yLabel: "MTF（归一化）",
      marker: markers,
    });
  }

  /* ---------------- CSV export ---------------- */
  $("exportBtn").addEventListener("click", exportCsv);
  function exportCsv() {
    if (!state.rois.length) return;
    const rows = [];
    rows.push(["# 参数表"]);
    rows.push(["roi", "x", "y", "width", "height", "orientation", "polarity", "slope",
      "mtf50_cyc_per_px", "mtf10_cyc_per_px", "valid", "reason"]);
    state.rois.forEach((roi, i) => {
      const res = state.results.get(i);
      let dir = "", pol = "", slope = "", m50 = "", m10 = "";
      if (res && res.valid) {
        dir = res.edge.vertical ? "near-vertical" : "near-horizontal";
        pol = polarityText(res);
        slope = res.edge.slope;
        m50 = res.mtf50 == null ? "not_measurable" : res.mtf50;
        m10 = res.mtf10 == null ? "not_measurable" : res.mtf10;
      }
      rows.push([i + 1, roi.x, roi.y, roi.w, roi.h, dir, pol, slope, m50, m10,
        res && res.valid ? "true" : "false", res ? res.reason || "" : ""]);
    });
    rows.push([]);
    rows.push(["# 曲线（每区一块：ESF 96 点 / LSF 94 点 / MTF 101 点；无效测区无曲线）"]);
    state.rois.forEach((roi, i) => {
      const res = state.results.get(i);
      if (!res || !res.valid) {
        rows.push([`roi_${i + 1}`, "invalid", res ? res.reason || "" : ""]);
        rows.push([]);
        return;
      }
      rows.push([`roi_${i + 1}_esf`]);
      rows.push(["distance_px", ...res.binCenters.map((v) => v.toFixed(3))]);
      rows.push(["esf", ...res.esf.map((v) => (Number.isFinite(v) ? v : ""))]);
      rows.push([`roi_${i + 1}_lsf`]);
      rows.push(["distance_px", ...res.binCenters.slice(1, -1).map((v) => v.toFixed(3))]);
      rows.push(["lsf", ...res.lsf]);
      rows.push([`roi_${i + 1}_mtf`]);
      rows.push(["frequency_cyc_per_px", ...Array.from({ length: C.N_FREQ }, (_, j) => (j * C.F_STEP).toFixed(3))]);
      rows.push(["mtf", ...res.mtf]);
      rows.push([]);
    });
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.fileName || "mtf").replace(/\.[^.]+$/, "") + "_mtf.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("CSV 已导出");
  }
  function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------------- built-in sample ---------------- */
  $("sampleBtn").addEventListener("click", loadBuiltinSample);
  async function loadBuiltinSample() {
    try {
      const [imgResp, metaResp] = await Promise.all([
        fetch("sample/chart.u16"), fetch("sample/chart.json"),
      ]);
      if (!imgResp.ok || !metaResp.ok) throw new Error("样例文件缺失");
      const buf = new Uint8Array(await imgResp.arrayBuffer());
      const meta = await metaResp.json();
      const file = new File([buf], "chart.u16", { type: "application/octet-stream" });
      const jf = new File([JSON.stringify(meta)], "chart.json", { type: "application/json" });
      pickedImage = file; pickedJson = jf;
      updateFileLabel();
      await loadImage(file, jf);
      toast("内置样例已载入");
    } catch (err) {
      showError("样例载入失败：" + err.message);
    }
  }

  window.addEventListener("resize", () => {
    if (!state.img) return;
    renderImage(); renderOverlay();
  });
})();
