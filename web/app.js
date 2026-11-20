/* app.js — UI wiring for the parallel-beam FBP workbench.
 * All numerical work is in fbp-core.js; this file only does file handling,
 * rendering and interaction. Display windows never mutate reconstruction data. */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    caseData: null,        // normalized case from FBPCore.buildCase
    sourceName: "",
    rec: null,             // current reconstruction result
    contrib: null,         // Float64Array for selected angle
    contribIndex: 0,
    pick: null,            // {row, col} selected in reconstruction
    mode: "ramlak",
    // color windows, kept per view so switching data stays sensible
    win: {
      sino:  { lo: 0, hi: 1 },
      recon: { lo: 0, hi: 1 },
      contrib: { lo: 0, hi: 1 }
    },
    busy: false
  };

  /* ----------------------------- helpers ----------------------------- */

  function setStatus(msg, kind) {
    const el = $("status");
    if (!msg) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function fmt(v, d = 4) {
    if (!isFinite(v)) return String(v);
    if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 1e-3)) {
      return v.toExponential(3);
    }
    return Number(v).toFixed(d);
  }

  function download(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ----------------------- grayscale rendering ------------------------ */

  // Shared grayscale LUT built per draw (256 entries, window applied here).
  function makeLUT(lo, hi) {
    const lut = new Uint8ClampedArray(256);
    const span = Math.max(hi - lo, 1e-12);
    for (let i = 0; i < 256; i++) {
      // value represented by LUT slot i
      const v = lo + (i / 255) * span;
      const g = Math.round(Math.min(1, Math.max(0, (v - lo) / span)) * 255);
      lut[i] = g;
    }
    return lut;
  }

  function renderToCanvas(canvas, data, W, H, lo, hi) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || W;
    const cssH = Math.max(1, Math.round(cssW * H / W));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const px = img.data;
    const span = Math.max(hi - lo, 1e-12);
    for (let i = 0; i < data.length; i++) {
      let g = (data[i] - lo) / span;
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      const gi = Math.round(g * 255);
      px[i * 4] = gi; px[i * 4 + 1] = gi; px[i * 4 + 2] = gi;
      px[i * 4 + 3] = 255;
    }
    const small = document.createElement("canvas");
    small.width = W; small.height = H;
    small.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    return ctx;
  }

  function drawColorbar(canvas, lo, hi) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 300;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(18 * dpr);
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, 1);
    for (let x = 0; x < canvas.width; x++) {
      const g = Math.round(255 * x / (canvas.width - 1));
      img.data[x * 4] = g; img.data[x * 4 + 1] = g;
      img.data[x * 4 + 2] = g; img.data[x * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* --------------------------- data loading --------------------------- */

  async function loadFromZip(file) {
    const buf = await file.arrayBuffer();
    const entries = await Unzip.unzip(buf);
    // A package may bundle several cases. Candidate metadata = any JSON whose
    // referenced .raw is present, excluding the impulse expected-value file.
    const candidates = [];
    for (const [name, bytes] of entries) {
      if (!name.endsWith(".json") || name === "impulse-expected.json") continue;
      let meta;
      try { meta = JSON.parse(new TextDecoder().decode(bytes)); }
      catch (ex) { continue; }
      const rawName = String(meta.data || "")
        .replace(/^.*\//, "").toLowerCase();
      if (entries.has(rawName)) candidates.push({ name, meta, rawName });
    }
    if (candidates.length === 0) {
      throw new Error("ZIP 内未找到带对应 .raw 的参数 JSON。");
    }
    // Prefer a geometrically valid case (this also skips duplicate-angle
    // fixtures); if every candidate is invalid, surface the first real error.
    let lastError = null;
    for (const cand of candidates) {
      const rawBytes = entries.get(cand.rawName);
      const ab = rawBytes.buffer.slice(
        rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);
      try {
        const built = FBPCore.buildCase(cand.meta, ab);
        FBPCore.sortCase(built); // rejects duplicate angles
        ingest(cand.meta, ab, file.name + " / " + cand.name);
        if (candidates.length > 1) {
          setStatus("ZIP 内含多个用例，已载入 " + cand.name +
            "；其余可通过 raw+json 多文件方式选择。乱序角度已连同数据行与 offset 一起重排，重复角度会被拒绝。",
            "ok");
        }
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("ZIP 内没有可载入的有效用例。");
  }

  async function loadFromFiles(fileList) {
    let meta = null, rawBuf = null, metaName = "";
    for (const f of fileList) {
      if (f.name.toLowerCase().endsWith(".json")) {
        meta = JSON.parse(await f.text());
        metaName = f.name;
      }
    }
    if (!meta) throw new Error("未选择 JSON 参数文件。");
    const rawName = String(meta.data || "").replace(/^.*\//, "").toLowerCase();
    for (const f of fileList) {
      const nm = f.name.toLowerCase();
      if (nm === rawName || nm.endsWith(".raw")) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        rawBuf = bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        break;
      }
    }
    if (!rawBuf) throw new Error("未找到与 JSON 对应的 .raw 数据。");
    ingest(meta, rawBuf, metaName);
  }

  // Initial display window uses 1st/99th percentiles so sparse bright bands
  // don't crush the rest to black; true min/max stay in the stats panel and
  // the "data range" button restores exact extents. Data values are untouched.
  function percentileWindow(a) {
    return {
      lo: FBPCore.percentile(a, 1),
      hi: FBPCore.percentile(a, 99)
    };
  }

  function ingest(meta, arrayBuffer, label) {
    const c = FBPCore.buildCase(meta, arrayBuffer); // throws on bad geometry
    state.caseData = c;
    state.sourceName = label;
    state.pick = null;
    $("caseName").textContent =
      label + "  ·  " + c.angles.length + " 角度 × " + c.D + " 探测器";
    // seed geometry controls from JSON
    $("outW").value = c.W0;
    $("outH").value = c.H0;
    $("psRange").value = c.ps0;
    $("offRange").value = 0;
    syncGeomLabels();
    $("angSlider").max = Math.max(0, c.angles.length - 1);
    $("angSlider").value = 0;
    state.contribIndex = 0;
    $("btnPfm").disabled = false;
    $("btnSaveParams").disabled = false;
    // sinogram display window: rows are mostly zero background; window top at
    // the nonzero median so gray levels inside the projection band separate
    const sinoTop = FBPCore.percentile(c.sino, 50, true);
    state.win.sino = { lo: 0, hi: sinoTop };
    const sw = $("sinoWin");
    sw.max = Math.max(40, FBPCore.stats(c.sino).max);
    sw.value = Math.min(sw.max, sinoTop);
    $("sinoWinVal").textContent = sinoTop.toFixed(2);
    setStatus("导入成功：" + label +
      "。乱序角度已连同数据行与 offset 一起重排；重复角度将被拒绝。", "ok");
    renderCaseInfo();
    runReconstruction(true);
  }

  /* ------------------------- reconstruction --------------------------- */

  function currentOpts() {
    return {
      W: clampInt($("outW").value, 1, 256, state.caseData.W0),
      H: clampInt($("outH").value, 1, 256, state.caseData.H0),
      pixelSize: parseFloat($("psRange").value),
      extraOffset: parseFloat($("offRange").value),
      filtered: state.mode === "ramlak"
    };
  }

  function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function runReconstruction(resetWindow) {
    if (!state.caseData || state.busy) return;
    state.busy = true;
    let opts;
    try {
      opts = currentOpts();
      state.rec = FBPCore.reconstruct(state.caseData, opts);
      state.contribIndex = Math.min(state.contribIndex, state.rec.A - 1);
      $("angSlider").max = state.rec.A - 1;
      $("angSlider").value = state.contribIndex;
      state.contrib = FBPCore.angleContribution(state.rec, state.contribIndex);
      if (state.pick) {
        if (state.pick.row >= opts.H || state.pick.col >= opts.W) state.pick = null;
      }
      if (resetWindow) {
        state.win.recon = percentileWindow(state.rec.image);
      }
      state.win.contrib = percentileWindow(state.contrib);
      refreshAll();
      setStatus("重建完成（" + (opts.filtered ? "Ram-Lak 滤波" : "未滤波对照") +
        "，" + opts.W + "×" + opts.H + "）。数值保持原始尺度，负值未截断。", "ok");
    } catch (e) {
      setStatus("重建失败：" + e.message, "err");
    } finally {
      state.busy = false;
    }
  }

  /* ----------------------------- drawing ------------------------------ */

  function refreshAll() {
    drawSinogram();
    drawRecon();
    drawContrib();
    drawStats();
    drawPickInfo();
  }

  function drawSinogram() {
    const c = state.caseData;
    if (!c) return;
    const rec = state.rec;
    const A = c.angles.length, D = c.D;
    // show sorted, filtered/unfiltered q when a rec exists, else sorted raw p
    const data = new Float64Array(A * D);
    if (rec) data.set(rec.q);
    else data.set(FBPCore.sortCase(c).rows);
    const w = state.win.sino;
    const ctx = renderToCanvas($("cvSino"), data, D, A, w.lo, w.hi);
    drawColorbar($("cbSino"), w.lo, w.hi);
    $("cbSinoLo").textContent = fmt(w.lo);
    $("cbSinoHi").textContent = fmt(w.hi);
    $("sinoMeta").textContent = A + " 行 × " + D + " 列";

    // overlay: detector hit curve for the picked pixel across all angles
    if (rec && state.pick) {
      const cw = $("cvSino").width, ch = $("cvSino").height;
      const sx = cw / D, sy = ch / A;
      ctx.save();
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = Math.max(1.5, cw / 240);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < rec.A; i++) {
        const t = FBPCore.detectorIndexForPixel(
          rec, i, state.pick.row, state.pick.col);
        if (t < 0 || t > D - 1) { started = false; continue; }
        const x = (t + 0.5) * sx, y = (i + 0.5) * sy;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // marker at selected angle
      const ti = FBPCore.detectorIndexForPixel(
        rec, state.contribIndex, state.pick.row, state.pick.col);
      if (ti >= 0 && ti <= D - 1) {
        const x = (ti + 0.5) * sx, y = (state.contribIndex + 0.5) * sy;
        ctx.fillStyle = "#ff6b6b";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(4, cw / 120), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawRecon() {
    const rec = state.rec;
    if (!rec) return;
    const w = state.win.recon;
    const ctx = renderToCanvas($("cvRecon"), rec.image, rec.W, rec.H, w.lo, w.hi);
    drawColorbar($("cbRecon"), w.lo, w.hi);
    $("cbReconLo").textContent = fmt(w.lo);
    $("cbReconHi").textContent = fmt(w.hi);
    $("reconTitle").textContent =
      state.mode === "ramlak" ? "重建图 · Ram-Lak FBP" : "重建图 · 未滤波对照";
    $("reconMeta").textContent = rec.W + "×" + rec.H +
      " · pixel_size=" + fmt(rec.pixelSize, 3) +
      " · 附加偏移=" + fmt(rec.extraOffset, 2);
    if (state.pick) {
      const cw = $("cvRecon").width, ch = $("cvRecon").height;
      const sx = cw / rec.W, sy = ch / rec.H;
      ctx.save();
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2;
      ctx.strokeRect(state.pick.col * sx + 1, state.pick.row * sy + 1,
        sx - 2, sy - 2);
      ctx.restore();
    }
  }

  function drawContrib() {
    const rec = state.rec;
    if (!rec) return;
    const w = state.win.contrib;
    renderToCanvas($("cvContrib"), state.contrib, rec.W, rec.H, w.lo, w.hi);
    drawColorbar($("cbContrib"), w.lo, w.hi);
    $("cbContribLo").textContent = fmt(w.lo);
    $("cbContribHi").textContent = fmt(w.hi);
    const theta = rec.sorted.angles[state.contribIndex];
    const deg = (theta * 180 / Math.PI).toFixed(2);
    $("contribMeta").textContent =
      "θ=" + theta.toFixed(4) + " rad (" + deg + "°)" +
      " · 角权=" + fmt(rec.weights[state.contribIndex]);
    $("angIdxVal").textContent =
      state.contribIndex + " / " + (rec.A - 1);
  }

  function drawStats() {
    const rec = state.rec;
    const kv = $("stats");
    if (!rec) { kv.innerHTML = '<span class="k">状态</span><span class="v">待导入</span>'; return; }
    const st = FBPCore.stats(rec.image);
    const qst = FBPCore.stats(rec.q);
    const wsum = rec.weights.reduce((a, b) => a + b, 0);
    const negCount = Array.from(rec.image).filter(v => v < 0).length;
    kv.innerHTML = [
      ["角度数 / 探测器", rec.A + " / " + rec.D],
      ["角权之和", fmt(wsum, 10) + " (π=" + fmt(Math.PI, 10) + ")"],
      ["重建最小值", fmt(st.min, 6)],
      ["重建最大值", fmt(st.max, 6)],
      ["重建均值", fmt(st.mean, 6)],
      ["负值像素数", negCount + " / " + rec.image.length],
      ["滤波 q 范围", fmt(qst.min, 4) + " .. " + fmt(qst.max, 4)]
    ].map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + v +
      "</span>").join("");
  }

  function drawPickInfo() {
    const rec = state.rec;
    const info = $("pickInfo");
    if (!rec) return;
    if (!state.pick) {
      info.innerHTML = '<span class="k">提示</span><span class="v">在重建图上点选像素</span>';
      $("pickMeta").textContent = "";
      return;
    }
    const { row, col } = state.pick;
    const idx = row * rec.W + col;
    const val = rec.image[idx];
    const t = FBPCore.detectorIndexForPixel(rec, state.contribIndex, row, col);
    const D = rec.D;
    const inRange = t >= 0 && t <= D - 1;
    const qv = inRange ? FBPCore.sampleQ(
      rec.q.subarray(state.contribIndex * D, (state.contribIndex + 1) * D), D, t) : null;
    const cx = (rec.W - 1) / 2, cy = (rec.H - 1) / 2;
    const x = (col - cx) * rec.pixelSize;
    const y = (cy - row) * rec.pixelSize;
    $("pickMeta").textContent = "像素 (行 " + row + ", 列 " + col + ")";
    info.innerHTML = [
      ["重建值 f(x,y)", fmt(val, 6)],
      ["物理坐标 x, y", fmt(x, 3) + ", " + fmt(y, 3)],
      ["当前角度 θ", fmt(rec.sorted.angles[state.contribIndex], 5) + " rad"],
      ["命中探测器索引 t", fmt(t, 4) + (inRange ? "" : "（超出范围→按 0 处理）")],
      ["插值 q(t)", qv === null ? "0（范围外）" : fmt(qv, 6)],
      ["该角度 offset", fmt(rec.sorted.offset[state.contribIndex], 4)],
      ["角权 × q", qv === null ? "0" :
        fmt(rec.weights[state.contribIndex] * qv, 6)]
    ].map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + v +
      "</span>").join("");
  }

  function renderCaseInfo() {
    const c = state.caseData;
    if (!c) return;
    const minA = Math.min(...c.angles), maxA = Math.max(...c.angles);
    const sorted = c.angles.slice().sort((a, b) => a - b);
    let monotonic = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= sorted[i - 1]) monotonic = false;
    }
    const shuffled = c.angles.some((v, i) => i > 0 && v > c.angles[i - 1]);
    $("caseInfo").innerHTML = [
      ["数据源", state.sourceName],
      ["角度范围", fmt(minA, 4) + " .. " + fmt(maxA, 4) + " rad"],
      ["输入顺序", shuffled ? "乱序（已重排）" : "已排序"],
      ["ds / 原始 pixel_size", fmt(c.ds, 3) + " / " + fmt(c.ps0, 3)],
      ["逐行 offset 范围",
        fmt(Math.min(...c.offset), 3) + " .. " + fmt(Math.max(...c.offset), 3)]
    ].map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + v +
      "</span>").join("");
  }

  /* ------------------------------ events ------------------------------ */

  function syncGeomLabels() {
    $("psVal").textContent = parseFloat($("psRange").value).toFixed(2);
    $("offVal").textContent = parseFloat($("offRange").value).toFixed(2);
  }
  function syncWinLabels() {
    $("wcVal").textContent = parseFloat($("wc").value).toFixed(2);
    $("wwVal").textContent = parseFloat($("ww").value).toFixed(2);
  }
  function winToSliders() {
    const w = state.win.recon;
    const c = (w.lo + w.hi) / 2, width = Math.max(w.hi - w.lo, 0.02);
    $("wc").value = Math.max(-200, Math.min(200, c));
    $("ww").value = Math.max(0.02, Math.min(400, width));
    syncWinLabels();
  }
  function slidersToWin() {
    const c = parseFloat($("wc").value);
    const width = parseFloat($("ww").value);
    state.win.recon = { lo: c - width / 2, hi: c + width / 2 };
    syncWinLabels();
    drawRecon();
  }

  $("btnZip").onclick = () => $("fileZip").click();
  $("btnFiles").onclick = () => $("fileMulti").click();
  $("fileZip").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await loadFromZip(f); }
    catch (err) { setStatus("导入失败：" + err.message, "err"); }
    e.target.value = "";
  };
  $("fileMulti").onchange = async (e) => {
    try { await loadFromFiles(e.target.files); }
    catch (err) { setStatus("导入失败：" + err.message, "err"); }
    e.target.value = "";
  };

  // drag & drop
  const drop = $("drop");
  ["dragenter", "dragover"].forEach(ev =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => {
    const files = e.dataTransfer.files;
    if (!files.length) return;
    try {
      const isZip = files[0].name.toLowerCase().endsWith(".zip");
      if (isZip) {
        if (files.length !== 1) throw new Error("ZIP 导入请一次只选择一个包。");
        await loadFromZip(files[0]);
      } else {
        await loadFromFiles(files);
      }
    } catch (err) { setStatus("导入失败：" + err.message, "err"); }
  });

  // mode segmented control
  $("modeSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !state.caseData) return;
    state.mode = btn.dataset.mode;
    [...$("modeSeg").children].forEach(b =>
      b.classList.toggle("on", b === btn));
    runReconstruction(true);
  });

  // geometry controls
  let geomTimer = null;
  function scheduleRecon() {
    clearTimeout(geomTimer);
    geomTimer = setTimeout(() => runReconstruction(false), 120);
  }
  ["outW", "outH"].forEach(id => $(id).addEventListener("change", () => runReconstruction(true)));
  ["psRange", "offRange"].forEach(id => {
    $(id).addEventListener("input", () => { syncGeomLabels(); scheduleRecon(); });
  });
  $("btnResetGeom").onclick = () => {
    if (!state.caseData) return;
    $("outW").value = state.caseData.W0;
    $("outH").value = state.caseData.H0;
    $("psRange").value = state.caseData.ps0;
    $("offRange").value = 0;
    syncGeomLabels();
    runReconstruction(true);
  };

  // color window sliders drive the reconstruction window only
  $("wc").addEventListener("input", slidersToWin);
  $("ww").addEventListener("input", slidersToWin);
  $("btnAutoWin").onclick = () => {
    if (!state.rec) return;
    const st = FBPCore.stats(state.rec.image);
    state.win.recon = { lo: st.min, hi: st.max };
    winToSliders(); drawRecon();
  };
  $("btnFullWin").onclick = () => {
    if (!state.rec) return;
    const st = FBPCore.stats(state.rec.image);
    const m = Math.max(Math.abs(st.min), Math.abs(st.hi));
    state.win.recon = { lo: -m, hi: m };
    winToSliders(); drawRecon();
  };

  // sinogram display window (independent of reconstruction values)
  $("sinoWin").addEventListener("input", () => {
    const top = parseFloat($("sinoWin").value);
    state.win.sino = { lo: 0, hi: top };
    $("sinoWinVal").textContent = top.toFixed(2);
    drawSinogram();
  });

  // angle slider
  $("angSlider").addEventListener("input", () => {
    if (!state.rec) return;
    state.contribIndex = parseInt($("angSlider").value, 10);
    state.contrib = FBPCore.angleContribution(state.rec, state.contribIndex);
    state.win.contrib = percentileWindow(state.contrib);
    drawContrib(); drawSinogram(); drawPickInfo();
  });

  // pick a reconstruction pixel
  $("cvRecon").addEventListener("click", (e) => {
    const rec = state.rec;
    if (!rec) return;
    const rect = e.target.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const col = Math.min(rec.W - 1, Math.max(0, Math.floor(fx * rec.W)));
    const row = Math.min(rec.H - 1, Math.max(0, Math.floor(fy * rec.H)));
    if (state.pick && state.pick.row === row && state.pick.col === col) {
      state.pick = null; // toggle off
    } else {
      state.pick = { row, col };
    }
    drawRecon(); drawSinogram(); drawPickInfo();
  });

  // PFM export
  $("btnPfm").onclick = () => {
    if (!state.rec) return;
    const bytes = FBPCore.encodePFM(state.rec.image, state.rec.W, state.rec.H);
    const base = state.sourceName.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    download(bytes, base + "_" + state.mode + "_" + state.rec.W + "x" +
      state.rec.H + ".pfm");
    setStatus("已导出 PFM：底行优先、小端 float32、尺度 −1；重建值未归一化、负值保留。", "ok");
  };

  // parameter save / reload
  function paramsObject() {
    const c = state.caseData;
    return {
      app: "sinogram-rebuild-desk",
      version: 1,
      source: state.sourceName,
      mode: state.mode,
      width: state.rec.W,
      height: state.rec.H,
      pixel_size: state.rec.pixelSize,
      extra_offset: state.rec.extraOffset,
      color_window: { center: (state.win.recon.lo + state.win.recon.hi) / 2,
        width: state.win.recon.hi - state.win.recon.lo },
      detectors: c.D,
      ds: c.ds
    };
  }
  $("btnSaveParams").onclick = () => {
    if (!state.rec) return;
    const text = JSON.stringify(paramsObject(), null, 2);
    download(new TextEncoder().encode(text),
      state.sourceName.replace(/[^a-z0-9]+/gi, "_") + "_params.json",
      "application/json");
  };
  $("btnLoadParams").onclick = () => $("fileParams").click();
  $("fileParams").onchange = async (e) => {
    try {
      const p = JSON.parse(await e.target.files[0].text());
      if (!state.caseData) throw new Error("请先导入原始 raw + json 数据。");
      if (p.mode === "ramlak" || p.mode === "unfilt") {
        state.mode = p.mode;
        [...$("modeSeg").children].forEach(b =>
          b.classList.toggle("on", b.dataset.mode === p.mode));
      }
      if (isFinite(p.width)) $("outW").value = p.width;
      if (isFinite(p.height)) $("outH").value = p.height;
      if (isFinite(p.pixel_size)) $("psRange").value = p.pixel_size;
      if (isFinite(p.extra_offset)) $("offRange").value = p.extra_offset;
      syncGeomLabels();
      runReconstruction(true);
      if (p.color_window && isFinite(p.color_window.center)) {
        const cw = +p.color_window.center, ww = Math.max(0.02, +p.color_window.width);
        state.win.recon = { lo: cw - ww / 2, hi: cw + ww / 2 };
        winToSliders(); drawRecon();
      }
      setStatus("参数已重载：" + JSON.stringify(p.color_window || {}), "ok");
    } catch (err) {
      setStatus("参数重载失败：" + err.message, "err");
    }
    e.target.value = "";
  };

  window.addEventListener("resize", () => { if (state.caseData) refreshAll(); });

  // initial slider ranges
  syncGeomLabels();
  syncWinLabels();
  winToSliders();
})();
