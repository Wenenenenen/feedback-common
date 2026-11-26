// Main application logic. Inlined into app.html; expects the inlined module
// functions (parsePnm, solveImage, inspectPixel, composite, ...), the worker
// source string WORKER_SOURCE, and window.DEMO_FILES to exist in scope.

(function () {
  "use strict";

  // ---------- application state ----------
  const state = {
    width: 0,
    height: 0,
    groups: [],            // {name, bg:Uint8Array, obs:Uint8Array, mask:Uint8Array|null, enabled, hasMask}
    datasetName: "",
    tol: 0,
    solveId: 0,            // increments on every requested solve
    appliedSolveId: -1,    // solve whose results currently feed every panel
    result: null,          // {status, rgba, feasibleCount, counts, tol}
    inspect: null,         // latest inspector payload
    inspectXY: null,
    selectedPixel: null,   // {x,y}
    view: "rgba",          // rgba | status | recomp
    recompMode: "backdrop",// backdrop | custom
    recompGroup: 0,
    recompColor: { r: 0, g: 128, b: 200 },
    recompBytes: null,     // cached recomposite for current solve+settings
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {};
  const saveMemory = (key, value) => {
    try { localStorage.setItem("ab." + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  };
  const loadMemory = (key, fallback) => {
    try {
      const raw = localStorage.getItem("ab." + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  };

  // ---------- worker lifecycle ----------
  let worker = null;
  let workerUrl = null;
  const pending = new Map(); // nonce/solveId -> resolver

  function startWorker() {
    if (worker) return;
    const blob = new Blob([MODULE_SOURCES + "\n" + WORKER_SOURCE], { type: "text/javascript" });
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);
    worker.onmessage = (ev) => handleWorkerMessage(ev.data);
    worker.onerror = (ev) => {
      setError("求解线程错误：" + ev.message);
    };
  }

  function postTransferable(msg, transfer) {
    startWorker();
    worker.postMessage(msg, transfer || []);
  }

  let inspectSeq = 0;
  let lastInspectSeq = -1;

  function handleWorkerMessage(msg) {
    if (msg.type === "progress") {
      if (msg.solveId === state.solveId) setProgress(msg.frac);
      return;
    }
    if (msg.type === "solved") {
      if (msg.solveId !== state.solveId) return; // stale
      state.busy = false;
      state.appliedSolveId = msg.solveId;
      state.result = {
        status: msg.status,
        rgba: msg.rgba,
        feasibleCount: msg.feasibleCount,
        counts: msg.counts,
        tol: msg.tol,
      };
      state.recompBytes = null;
      hideProgress();
      renderAll();
      // Re-arm the inspector for the selected pixel against the fresh solve.
      if (state.selectedPixel) {
        requestInspect(state.selectedPixel.x, state.selectedPixel.y);
      }
      return;
    }
    if (msg.type === "inspected") {
      if (msg.seq !== lastInspectSeq) return; // a newer inspect superseded this one
      state.inspect = msg.info;
      state.inspectXY = { x: msg.x, y: msg.y };
      renderInspector();
      return;
    }
    if (msg.type === "encoded") {
      const r = pending.get(msg.nonce);
      if (r) { pending.delete(msg.nonce); r.resolve(msg.bytes); }
      return;
    }
    if (msg.type === "recomposited") {
      const r = pending.get(msg.nonce);
      if (r) { pending.delete(msg.nonce); r.resolve(msg.out); }
      return;
    }
    if (msg.type === "error") {
      state.busy = false;
      hideProgress();
      setError(msg.message);
    }
  }

  let nonceSeq = 1;
  function workerRoundtrip(msg, transfer) {
    const nonce = nonceSeq++;
    msg.nonce = nonce;
    return new Promise((resolve, reject) => {
      pending.set(nonce, { resolve, reject });
      postTransferable(msg, transfer);
    });
  }

  // ---------- dataset loading ----------
  // Files arrive as a name -> ArrayBuffer map (from input, drop, or demo).
  async function loadDataset(fileMap, name) {
    clearError();
    try {
      const jsonName = Object.keys(fileMap).find((n) => n.toLowerCase().endsWith("groups.json"));
      let spec;
      if (jsonName) {
        const text = new TextDecoder("utf-8").decode(fileMap[jsonName]);
        spec = JSON.parse(text);
      } else {
        spec = { groups: inferGroupsFromNames(Object.keys(fileMap)) };
      }
      if (!spec || !Array.isArray(spec.groups) || spec.groups.length < 2 || spec.groups.length > 8) {
        throw new Error("groups.json 需要 2 到 8 组观测");
      }
      const base = jsonName ? jsonName.slice(0, jsonName.lastIndexOf("/") + 1) : "";
      const groups = [];
      let width = 0, height = 0;
      for (let i = 0; i < spec.groups.length; i++) {
        const g = spec.groups[i];
        const bgName = requireFile(fileMap, base + (g.background || ""), "background", i);
        const obsName = requireFile(fileMap, base + (g.observed || ""), "observed", i);
        const bg = parsePnm(fileMap[bgName]);
        const ob = parsePnm(fileMap[obsName]);
        if (bg.channels !== 3 || ob.channels !== 3) throw new Error("底图和合成图必须是 P6（RGB）");
        if (width === 0) { width = bg.width; height = bg.height; }
        if (bg.width !== width || bg.height !== height || ob.width !== width || ob.height !== height) {
          throw new Error("第 " + i + " 组尺寸与其他组不一致");
        }
        let mask = null, hasMask = false;
        if (g.valid) {
          const mName = resolveOptional(fileMap, base + g.valid);
          if (mName) {
            const m = parsePnm(fileMap[mName]);
            if (m.channels !== 1 || m.width !== width || m.height !== height) {
              throw new Error("第 " + i + " 组掩膜必须是同尺寸 P5");
            }
            mask = m.data; hasMask = true;
          }
        }
        groups.push({
          name: "组 " + i,
          bg: bg.data, obs: ob.data, mask, hasMask,
          enabled: true,
        });
      }
      state.width = width; state.height = height;
      state.groups = groups;
      state.datasetName = name;
      state.selectedPixel = null; state.inspect = null; state.result = null;
      state.recompBytes = null; state.appliedSolveId = -1;
      renderGroupPanel();
      requestSolve();
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  function requireFile(map, name, kind, i) {
    if (map[name]) return name;
    const hit = resolveOptional(map, name);
    if (!hit) throw new Error("第 " + i + " 组缺少 " + kind + " 文件：" + name);
    return hit;
  }

  function resolveOptional(map, name) {
    if (map[name]) return name;
    const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    const hit = Object.keys(map).find((n) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n) === base);
    return hit || null;
  }

  function inferGroupsFromNames(names) {
    const groups = [];
    for (let i = 0; i < 8; i++) {
      const bg = names.find((n) => new RegExp("bg" + i + "\\.ppm$", "i").test(n));
      const ob = names.find((n) => new RegExp("obs" + i + "\\.ppm$", "i").test(n));
      if (bg && ob) {
        const valid = names.find((n) => new RegExp("valid" + i + "\\.pgm$", "i").test(n));
        groups.push({ background: bg, observed: ob, valid: valid || undefined });
      }
    }
    return groups;
  }

  async function readInputsToMap(fileList) {
    const map = {};
    const files = Array.from(fileList);
    await Promise.all(files.map((f) => f.arrayBuffer().then((ab) => {
      // webkitRelativePath gives folder/name; fall back to plain name.
      const rel = f.webkitRelativePath && f.webkitRelativePath.includes("/")
        ? f.webkitRelativePath.slice(f.webkitRelativePath.indexOf("/") + 1)
        : f.name;
      map[rel] = ab;
    })));
    return map;
  }

  async function loadDemo() {
    const map = {};
    for (const [name, b64] of Object.entries(window.DEMO_FILES)) {
      if (name.endsWith(".txt")) continue;
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      map[name] = u8.buffer.slice(0);
    }
    await loadDataset(map, "内置演示样片 3×2");
  }

  // ---------- solving ----------
  function requestSolve() {
    if (!state.groups.length) return;
    clearError();
    state.solveId++;
    state.busy = true;
    setProgress(0);
    // Send copies: the worker takes ownership of transferred buffers.
    const groups = state.groups.map((g) => ({
      bg: g.bg.slice(), obs: g.obs.slice(),
      mask: g.mask ? g.mask.slice() : null,
      enabled: g.enabled,
    }));
    postTransferable({
      type: "solve",
      solveId: state.solveId,
      width: state.width, height: state.height,
      tol: state.tol, groups,
    }, groups.flatMap((g) => [g.bg.buffer, g.obs.buffer, ...(g.mask ? [g.mask.buffer] : [])]));
    markStale();
  }

  function requestInspect(x, y) {
    if (!state.result) return;
    const seq = ++inspectSeq;
    lastInspectSeq = seq;
    const groups = state.groups.map((g) => ({
      bg: g.bg.slice(), obs: g.obs.slice(),
      mask: g.mask ? g.mask.slice() : null,
      enabled: g.enabled,
    }));
    postTransferable({
      type: "inspect",
      seq,
      solveId: state.appliedSolveId,
      width: state.width, tol: state.tol, x, y, groups,
    }, groups.flatMap((g) => [g.bg.buffer, g.obs.buffer, ...(g.mask ? [g.mask.buffer] : [])]));
  }

  // ---------- rendering ----------
  function renderAll() {
    renderStats();
    renderCanvas();
    renderInspector();
    clearStale();
    updateExportState();
    if (state.view === "recomp") refreshRecomp();
  }

  function markStale() {
    document.body.classList.add("stale");
    els.staleNote.hidden = false;
  }
  function clearStale() {
    document.body.classList.remove("stale");
    els.staleNote.hidden = true;
  }

  function renderStats() {
    const r = state.result;
    if (!r) return;
    const n = state.width * state.height;
    els.statSize.textContent = state.width + " × " + state.height;
    els.statGroups.textContent = String(state.groups.filter((g) => g.enabled).length) + " / " + state.groups.length;
    els.statTol.textContent = String(r.tol);
    els.statFeasible.textContent = String(r.counts.feasible);
    els.statNoSol.textContent = String(r.counts.noSolution);
    els.statUnmeas.textContent = String(r.counts.unmeasured);
    els.statFeasiblePct.textContent = (100 * r.counts.feasible / n).toFixed(1) + "%";
  }

  function statusColor(code) {
    if (code === 1) return "var(--ok)";
    if (code === 2) return "var(--bad)";
    return "var(--warn)";
  }

  function renderCanvas() {
    const r = state.result;
    const canvas = els.canvas;
    canvas.width = state.width; canvas.height = state.height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(state.width, state.height);
    if (!r) { ctx.putImageData(img, 0, 0); return; }

    if (state.view === "rgba") {
      img.data.set(r.rgba);
    } else if (state.view === "status") {
      for (let p = 0; p < r.status.length; p++) {
        const code = r.status[p];
        // semantic colors only for display; the exported PNG keeps codes 0/1/2
        const rgb = code === 1 ? [38, 166, 123] : code === 2 ? [214, 78, 91] : [196, 153, 59];
        img.data[4 * p] = rgb[0]; img.data[4 * p + 1] = rgb[1]; img.data[4 * p + 2] = rgb[2];
        img.data[4 * p + 3] = 255;
      }
    } else if (state.view === "recomp") {
      const bytes = state.recompBytes;
      if (bytes) img.data.set(bytes);
      else { // while recomputing, show checker placeholder
        drawChecker(img);
      }
    }
    ctx.putImageData(img, 0, 0);
    drawMarker(ctx);
  }

  function drawChecker(img) {
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const p = y * state.width + x;
        const v = ((x >> 1) + (y >> 1)) % 2 ? 204 : 238;
        img.data[4 * p] = v; img.data[4 * p + 1] = v; img.data[4 * p + 2] = v;
        img.data[4 * p + 3] = 255;
      }
    }
  }

  function drawMarker(ctx) {
    if (!state.selectedPixel) return;
    const { x, y } = state.selectedPixel;
    ctx.save();
    ctx.strokeStyle = "var(--accent)";
    ctx.lineWidth = Math.max(1, Math.floor(Math.min(state.width, state.height) / 64));
    ctx.strokeRect(x + 0.5, y + 0.5, 1, 1);
    ctx.restore();
  }

  function renderGroupPanel() {
    const panel = els.groups;
    panel.innerHTML = "";
    const select = $("recomp-group-select");
    select.innerHTML = "";
    state.groups.forEach((g, i) => {
      const row = document.createElement("label");
      row.className = "group-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = g.enabled;
      cb.addEventListener("change", () => {
        g.enabled = cb.checked;
        requestSolve();
      });
      const label = document.createElement("span");
      label.className = "group-label";
      label.textContent = "组 " + i + (g.hasMask ? " · 含掩膜" : " · 全有效");
      row.append(cb, label);
      panel.append(row);

      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = "底图 " + i;
      select.append(opt);
    });
    select.value = String(Math.min(state.recompGroup, Math.max(0, state.groups.length - 1)));
  }

  function renderInspector() {
    const box = els.inspector;
    if (!state.result) {
      box.innerHTML = '<p class="muted">载入数据后，在预览图上点选像素。</p>';
      return;
    }
    if (!state.inspect) {
      box.innerHTML = '<p class="muted">点选预览图中的像素，查看全部可行 A 值与逐组预测误差。</p>';
      return;
    }
    const info = state.inspect;
    const parts = [];
    parts.push('<div class="insp-head"><span>像素 (' + info.x + ", " + info.y + ")</span>" +
      '<span class="badge" style="--bc:' + statusColor(info.status) + '">' +
      statusText(info.status) + "</span></div>");

    if (info.status === 0) {
      parts.push('<p class="muted">该像素在所有组都被掩膜排除（未测）。交片写透明黑 (0,0,0,0)。</p>');
    } else if (info.status === 2) {
      parts.push('<p class="muted">容差 ' + state.tol + " 下没有任何 A 能同时满足全部未排除观测通道。交片写透明黑。</p>");
    } else {
      const [a, r, g, b] = info.solution;
      parts.push('<div class="solution-tile">交片解（最小 A，再按 R/G/B 取最小）' +
        '<table class="kv"><tbody>' +
        "<tr><th>A</th><td>" + a + "</td></tr>" +
        "<tr><th>R</th><td>" + r + "</td></tr>" +
        "<tr><th>G</th><td>" + g + "</td></tr>" +
        "<tr><th>B</th><td>" + b + "</td></tr>" +
        "</tbody></table></div>");
      parts.push('<div class="feasible-head">可行 A 值（共 ' + info.feasible.length + " 个）</div>");
      parts.push('<div class="feasible-list">' + info.feasible.map((f) => {
        const isPick = f.a === a;
        return '<details class="a-row' + (isPick ? " picked" : "") + '">' +
          "<summary>A=" + f.a + (isPick ? " · 交片" : "") +
          ' <span class="muted">F区间 R[' + f.lo[0] + "–" + f.hi[0] + "] G[" +
          f.lo[1] + "–" + f.hi[1] + "] B[" + f.lo[2] + "–" + f.hi[2] + "]</span></summary>" +
          perGroupTable(info, f) + "</details>";
      }).join("") + "</div>");
    }
    box.innerHTML = parts.join("");
  }

  function perGroupTable(info, fEntry) {
    const rows = ['<table class="per-group"><thead><tr><th>组</th><th>底图 B</th><th>观测 O</th><th>预测 P</th><th>误差 P−O</th></tr></thead><tbody>'];
    info.perGroup.forEach((g, i) => {
      if (!g.used) {
        rows.push('<tr class="excluded"><td>' + i + "</td><td colspan=4 class=muted>已排除（" +
          (g.excludedByMask ? "掩膜为 0" : "组被关闭") + "）</td></tr>");
        return;
      }
      const pred = info.predictions[i];
      rows.push("<tr><td>" + i + "</td><td>" + g.b.join(", ") + "</td><td>" + g.o.join(", ") +
        "</td><td>" + pred.pred.join(", ") + "</td><td>" +
        pred.err.map((e) => fmtErr(e)).join(", ") + "</td></tr>");
    });
    rows.push("</tbody></table>");
    return rows.join("");
  }

  function fmtErr(e) {
    const cls = e === 0 ? "err-zero" : (Math.abs(e) <= state.tol ? "err-ok" : "err-bad");
    return '<span class="' + cls + '">' + (e > 0 ? "+" : "") + e + "</span>";
  }

  function statusText(s) {
    return s === 1 ? "可行" : s === 2 ? "无解" : "未测";
  }

  // ---------- recomposite ----------
  async function refreshRecomp() {
    if (state.view !== "recomp" || !state.result) return;
    let backdrop;
    const transfer = [];
    if (state.recompMode === "backdrop") {
      const g = state.groups[state.recompGroup];
      const bgCopy = g ? g.bg.slice() : new Uint8Array(state.width * state.height * 3);
      backdrop = bgCopy;
      transfer.push(bgCopy.buffer);
    } else {
      const { r, g, b } = state.recompColor;
      backdrop = { r, g, b };
    }
    const rgbaCopy = state.result.rgba.slice();
    transfer.push(rgbaCopy.buffer);
    const out = await workerRoundtrip({
      type: "recomposite",
      width: state.width, height: state.height,
      rgba: rgbaCopy,
      backdrop,
    }, transfer);
    state.recompBytes = out;
    if (state.view === "recomp") renderCanvas();
  }

  // ---------- export ----------
  async function exportRgba() {
    if (!state.result) return;
    const bytes = await workerRoundtrip({
      type: "encode", kind: "rgba",
      width: state.width, height: state.height,
      data: state.result.rgba.slice(),
    });
    verifyRgbaBytes(bytes);
    download(bytes, baseName() + "_rgba_tol" + state.result.tol + ".png", "image/png");
  }

  function verifyRgbaBytes(pngBytes) {
    // Byte-level structural verification without any 2D-canvas round trip:
    // drawing straight RGBA onto a canvas premultiplies alpha and can round
    // low-alpha RGB by one code value on readback, so canvas cannot be used as
    // the oracle here. We parse the PNG we just produced (IHDR + IDAT), inflate
    // it, strip the per-scanline filter byte and compare against solver bytes.
    try {
      const blob = new Blob([pngBytes.slice(8)]); // skip 8-byte signature
      const reader = new Response(blob).arrayBuffer().then((ab) => {
        const view = new DataView(ab);
        let pos = 0, width = 0, height = 0, colorType = -1;
        const idat = [];
        while (pos < ab.byteLength) {
          const len = view.getUint32(pos);
          const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5),
            view.getUint8(pos + 6), view.getUint8(pos + 7));
          if (type === "IHDR") {
            width = view.getUint32(pos + 8);
            height = view.getUint32(pos + 12);
            colorType = view.getUint8(pos + 8 + 9);
          } else if (type === "IDAT") {
            idat.push(new Uint8Array(ab, pos + 8, len));
          }
          pos += 12 + len;
        }
        if (width !== state.width || height !== state.height || colorType !== 6) {
          throw new Error("PNG 头不匹配：" + width + "x" + height + " type=" + colorType);
        }
        return inflate(concatBytes(idat));
      }).then((raw) => {
        const stride = state.width * 4;
        let mismatch = 0;
        const detail = [];
        for (let y = 0; y < state.height; y++) {
          const filter = raw[y * (stride + 1)];
          if (filter !== 0) throw new Error("期望 filter 0，收到 " + filter);
          for (let x = 0; x < stride; x++) {
            const got = raw[y * (stride + 1) + 1 + x];
            const want = state.result.rgba[y * stride + x];
            if (got !== want) {
              mismatch++;
              if (detail.length < 8) detail.push({ i: y * stride + x, got, want });
            }
          }
        }
        if (mismatch) {
          console.error("RGBA self-check detail", JSON.stringify(detail));
          setError("导出自检发现 " + mismatch + " 个字节不一致，已阻止下载");
        } else flashSelfCheck();
      }).catch((e) => setError("PNG 自检失败：" + e.message));
      return reader;
    } catch (e) {
      setError("PNG 自检失败：" + e.message);
    }
  }

  function concatBytes(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== "undefined") {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error("当前浏览器不支持 DecompressionStream，无法完成自检");
  }

  async function exportStatus() {
    if (!state.result) return;
    const bytes = await workerRoundtrip({
      type: "encode", kind: "status",
      width: state.width, height: state.height,
      data: state.result.status.slice(),
    });
    download(bytes, baseName() + "_status_tol" + state.result.tol + ".png", "image/png");
  }

  async function exportRecomp() {
    if (!state.result || !state.recompBytes) return;
    // recompBytes is RGBA opaque; encode as an RGBA PNG through the same encoder.
    const bytes = await workerRoundtrip({
      type: "encode", kind: "rgba",
      width: state.width, height: state.height,
      data: state.recompBytes.slice(),
    });
    download(bytes, baseName() + "_recomp_tol" + state.result.tol + ".png", "image/png");
  }

  function download(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function baseName() {
    return (state.datasetName || "dataset").replace(/[^\w一-龥-]+/g, "_");
  }

  // ---------- small UI helpers ----------
  function setError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }
  function clearError() { els.error.hidden = true; els.error.textContent = ""; }
  function setProgress(frac) {
    els.progress.hidden = false;
    els.progressBar.style.width = Math.round(frac * 100) + "%";
  }
  function hideProgress() { els.progress.hidden = true; }
  function flashSelfCheck() {
    els.selfCheck.hidden = false;
    clearTimeout(flashSelfCheck._t);
    flashSelfCheck._t = setTimeout(() => { els.selfCheck.hidden = true; }, 2600);
  }
  function updateExportState() {
    const on = !!state.result && !state.busy;
    [els.btnExportRgba, els.btnExportStatus, els.btnExportRecomp].forEach((b) => { b.disabled = !on; });
  }

  // ---------- events ----------
  function bind() {
    Object.assign(els, {
      groups: $("groups"), inspector: $("inspector"), canvas: $("canvas"),
      statSize: $("stat-size"), statGroups: $("stat-groups"), statTol: $("stat-tol"),
      statFeasible: $("stat-feasible"), statNoSol: $("stat-nosol"), statUnmeas: $("stat-unmeas"),
      statFeasiblePct: $("stat-feasible-pct"),
      error: $("error"), progress: $("progress"), progressBar: $("progress-bar"),
      staleNote: $("stale-note"), selfCheck: $("self-check"),
      btnExportRgba: $("btn-export-rgba"), btnExportStatus: $("btn-export-status"),
      btnExportRecomp: $("btn-export-recomp"),
    });

    $("btn-demo").addEventListener("click", loadDemo);
    $("file-folder").addEventListener("change", async (ev) => {
      const map = await readInputsToMap(ev.target.files);
      const folder = ev.target.files[0] && ev.target.files[0].webkitRelativePath;
      await loadDataset(map, folder ? folder.split("/")[0] : "上传数据集");
    });
    $("file-multi").addEventListener("change", async (ev) => {
      const map = await readInputsToMap(ev.target.files);
      await loadDataset(map, "上传数据集");
    });
    const drop = $("drop-zone");
    drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("dragging"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", async (ev) => {
      ev.preventDefault(); drop.classList.remove("dragging");
      const map = await readInputsToMap(ev.dataTransfer.files);
      await loadDataset(map, "拖入数据集");
    });

    const tolRange = $("tol-range"), tolNum = $("tol-num");
    let tolDebounce = null;
    tolRange.addEventListener("input", () => {
      state.tol = Number(tolRange.value);
      tolNum.value = state.tol;
      saveMemory("tol", state.tol);
      clearTimeout(tolDebounce);
      tolDebounce = setTimeout(requestSolve, 120);
    });
    tolNum.addEventListener("change", () => {
      let v = Math.max(0, Math.min(8, Number(tolNum.value) || 0));
      state.tol = v; tolRange.value = v; tolNum.value = v;
      saveMemory("tol", v);
      clearTimeout(tolDebounce);
      requestSolve();
    });

    document.querySelectorAll('input[name="view"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        state.view = radio.value;
        saveMemory("view", state.view);
        renderCanvas();
        if (state.view === "recomp") refreshRecomp();
      });
    });
    document.querySelectorAll('input[name="recomp-source"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        state.recompMode = radio.value;
        $("recomp-color").hidden = state.recompMode !== "custom";
        refreshRecomp();
      });
    });
    $("recomp-group-select").addEventListener("change", (ev) => {
      state.recompGroup = Number(ev.target.value);
      refreshRecomp();
    });
    $("recomp-color").addEventListener("input", (ev) => {
      const hex = ev.target.value;
      state.recompColor = {
        r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
      };
      refreshRecomp();
    });

    els.canvas.addEventListener("click", (ev) => {
      if (!state.result) return;
      const rect = els.canvas.getBoundingClientRect();
      const x = Math.floor((ev.clientX - rect.left) / rect.width * state.width);
      const y = Math.floor((ev.clientY - rect.top) / rect.height * state.height);
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
      state.selectedPixel = { x, y };
      renderCanvas();
      requestInspect(x, y);
    });

    els.btnExportRgba.addEventListener("click", exportRgba);
    els.btnExportStatus.addEventListener("click", exportStatus);
    els.btnExportRecomp.addEventListener("click", exportRecomp);

    $("theme-toggle").addEventListener("click", () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      saveMemory("theme", next);
    });
  }

  function init() {
    bind();
    const savedTheme = loadMemory("theme", null);
    if (savedTheme === "dark" || savedTheme === "light") {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }
    const savedTol = loadMemory("tol", 0);
    state.tol = Math.max(0, Math.min(8, Number(savedTol) || 0));
    $("tol-range").value = state.tol;
    $("tol-num").value = state.tol;
    const savedView = loadMemory("view", "rgba");
    const radio = document.querySelector('input[name="view"][value="' + savedView + '"]');
    if (radio) { radio.checked = true; state.view = savedView; }
    loadDemo();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
