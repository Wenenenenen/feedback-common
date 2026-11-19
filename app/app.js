/* app.js — 麦克风阵列方位分析页面逻辑（依赖 dsp.js 的全局 MB_DSP） */
(function () {
  "use strict";
  const D = window.MB_DSP;

  // ---------- 全局状态 ----------
  const state = {
    audio: null,
    geometry: null,
    geoRaw: null,
    wavName: "",
    jsonName: "",
    startFrame: 0,
    endFrame: 0,
    measurement: null,   // 区间相关的 GCC 测量
    fit: null,           // 权重/启用状态相关的拟合
    silence: null,
  };
  const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)",
                  "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];
  const SERIES_HEX_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#b37d00",
                            "#d04f82", "#008300", "#6250d6", "#e34948"];
  const SERIES_HEX_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500",
                           "#d55181", "#0ca30c", "#9085e9", "#e66767"];
  const isDark = () => {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit) return explicit === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const seriesColor = (idx) => (isDark() ? SERIES_HEX_DARK : SERIES_HEX_LIGHT)[idx];

  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(svgNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const htmlEl = (tag, parent) => {
    const n = document.createElement(tag);
    if (parent) parent.appendChild(n);
    return n;
  };

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------- 文件导入 ----------
  function bindDrop(dropId, inputId, cb) {
    const drop = $(dropId);
    const input = $(inputId);
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      if (e.dataTransfer.files.length) cb(e.dataTransfer.files[0]);
    });
    input.addEventListener("change", () => {
      if (input.files.length) cb(input.files[0]);
    });
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  bindDrop("wavDrop", "wavInput", async (file) => {
    try {
      const buf = await readFile(file);
      const audio = D.decodePCM(buf);
      state.audio = audio;
      state.wavName = file.name;
      $("wavName").textContent = file.name;
      if (state.geometry && state.geometry.coordinates.length !== audio.channelsCount) {
        state.geometry = null;
        state.geoRaw = null;
        $("jsonName").textContent = "坐标数与声道数不符，请重新选择 JSON";
      }
      resetAnalysis();
      renderMeta();
      maybeSetupWave();
    } catch (err) {
      state.audio = null;
      $("wavName").textContent = "导入失败：" + err.message;
      $("waveCard").hidden = true;
      resetAnalysis();
      renderMeta();
      toast(err.message);
    }
  });

  bindDrop("jsonDrop", "jsonInput", async (file) => {
    try {
      const text = await file.text();
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new Error("JSON 解析失败：" + e.message);
      }
      const nch = state.audio ? state.audio.channelsCount : (raw.coordinates_m || []).length;
      const geometry = D.validateGeometry(raw, nch);
      state.geometry = geometry;
      state.geoRaw = raw;
      state.jsonName = file.name;
      $("jsonName").textContent = file.name;
      resetAnalysis();
      renderMeta();
      maybeSetupWave();
    } catch (err) {
      state.geometry = null;
      toast(err.message);
    }
  });

  function resetAnalysis() {
    state.measurement = null;
    state.fit = null;
    state.silence = null;
    $("arrayCard").hidden = true;
    $("pairsCard").hidden = true;
    $("exportCard").hidden = true;
    $("resultSlot").innerHTML = "";
    $("jsonOut").hidden = true;
  }

  function renderMeta() {
    const box = $("metaChips");
    box.innerHTML = "";
    const chips = [];
    if (state.audio) {
      const a = state.audio;
      chips.push(["采样率 " + a.sampleRate + " Hz", ""]);
      chips.push([a.bitsPerSample + " 位 PCM", ""]);
      chips.push([a.channelsCount + " 声道", ""]);
      chips.push([a.frameCount + " 帧 / " + a.duration.toFixed(3) + " s", ""]);
    }
    if (state.geometry) {
      chips.push(["声速 " + state.geometry.speed + " m/s", ""]);
      chips.push([state.geometry.coordinates.length + " 个坐标点", ""]);
      const span2d = checkGeometryRank(state.geometry.coordinates);
      chips.push(span2d ? ["几何张成二维", "good"] : ["几何共线：方位不可定", "bad"]);
    }
    for (const [txt, kind] of chips) {
      const c = htmlEl("span", box);
      c.className = "chip" + (kind ? " " + kind : "");
      c.textContent = txt;
    }
  }

  function checkGeometryRank(coords) {
    let g00 = 0, g01 = 0, g11 = 0;
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const dx = coords[j][0] - coords[i][0];
        const dy = coords[j][1] - coords[i][1];
        g00 += dx * dx; g01 += dx * dy; g11 += dy * dy;
      }
    }
    const tr = g00 + g11;
    const det = g00 * g11 - g01 * g01;
    const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr / 2) ** 2 - det));
    return l2 > 1e-12 * tr;
  }

  function ready() {
    return !!(state.audio && state.geometry &&
      state.geometry.coordinates.length === state.audio.channelsCount);
  }

  // ---------- 波形 + 区间选择 ----------
  function maybeSetupWave() {
    if (!ready()) {
      $("waveCard").hidden = true;
      return;
    }
    $("waveCard").hidden = false;
    state.startFrame = 0;
    state.endFrame = state.audio.frameCount;
    drawWaveform();
    syncRangeInputs();
  }

  function downsampleEnvelope(channel, bins) {
    const n = channel.length;
    const out = new Float64Array(bins);
    const per = Math.max(1, Math.floor(n / bins));
    for (let b = 0; b < bins; b++) {
      let mx = 0;
      const lo = b * per;
      const hi = Math.min(n, lo + per);
      for (let k = lo; k < hi; k++) mx = Math.max(mx, Math.abs(channel[k]));
      out[b] = mx;
    }
    return out;
  }

  function drawWaveform() {
    const box = $("waveBox");
    box.innerHTML = "";
    const W = Math.max(320, box.clientWidth || 900);
    const H = 150;
    const padL = 44, padR = 12, padT = 10, padB = 22;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "波形与分析区间选择" }, box);
    const n = state.audio.frameCount;
    const bins = Math.min(1400, n);
    const env = downsampleEnvelope(state.audio.channels[0], bins);
    const xOf = (frame) => padL + (frame / n) * (W - padL - padR);
    const midY = (padT + H - padB) / 2;
    const ampY = midY - padT;

    // 网格与时间刻度
    for (let sec = 0; sec <= Math.floor(state.audio.duration); sec++) {
      const x = xOf(sec * state.audio.sampleRate);
      el("line", { x1: x, y1: padT, x2: x, y2: H - padB, class: "axis-grid" }, svg);
      const t = el("text", { x, y: H - 6, "text-anchor": "middle", class: "axis-label" }, svg);
      t.textContent = sec + "s";
    }
    el("line", { x1: padL, y1: midY, x2: W - padR, y2: midY, class: "axis-grid" }, svg);

    // 区间外遮罩
    const shade = (x1, x2) => el("rect", { x: x1, y: padT, width: Math.max(0, x2 - x1),
      height: H - padT - padB, fill: "var(--ink)", opacity: .07 }, svg);
    const shadeL = shade(padL, xOf(state.startFrame));
    const shadeR = shade(xOf(state.endFrame), W - padR);

    // 波形包络
    const path = [];
    for (let b = 0; b < bins; b++) {
      const x = padL + (b / (bins - 1)) * (W - padL - padR);
      path.push((b ? "L" : "M") + x.toFixed(2) + " " + (midY - env[b] * ampY).toFixed(2));
    }
    for (let b = bins - 1; b >= 0; b--) {
      const x = padL + (b / (bins - 1)) * (W - padL - padR);
      path.push("L" + x.toFixed(2) + " " + (midY + env[b] * ampY).toFixed(2));
    }
    el("path", { d: path.join(" "), fill: "var(--accent)", opacity: .55, stroke: "none" }, svg);

    // 选区边框与手柄
    const sel = el("rect", { y: padT, height: H - padT - padB, fill: "var(--accent)", opacity: .06,
      stroke: "var(--accent)", "stroke-width": 1.2 }, svg);
    const mkHandle = (x) => {
      const g = el("g", { style: "cursor: ew-resize" }, svg);
      el("rect", { x: x - 7, y: padT - 2, width: 14, height: H - padT - padB + 4,
        rx: 4, fill: "var(--accent)" }, g);
      return g;
    };
    const hL = mkHandle(0);
    const hR = mkHandle(0);

    function paint() {
      const x1 = xOf(state.startFrame), x2 = xOf(state.endFrame);
      sel.setAttribute("x", x1);
      sel.setAttribute("width", x2 - x1);
      shadeL.setAttribute("x", padL);
      shadeL.setAttribute("width", x1 - padL);
      shadeR.setAttribute("x", x2);
      shadeR.setAttribute("width", W - padR - x2);
      hL.setAttribute("transform", `translate(${x1},0)`);
      hR.setAttribute("transform", `translate(${x2},0)`);
    }
    paint();

    const frameFromEvent = (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      return Math.round(((x - padL) / (W - padL - padR)) * n);
    };
    const minFrames = Math.ceil(state.audio.sampleRate * 0.2 - 1e-9);
    let drag = null;
    const startDrag = (which) => (e) => {
      e.preventDefault();
      drag = which;
      svg.setPointerCapture(e.pointerId);
    };
    hL.addEventListener("pointerdown", startDrag("L"));
    hR.addEventListener("pointerdown", startDrag("R"));
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const f = Math.max(0, Math.min(n, frameFromEvent(e)));
      if (drag === "L") state.startFrame = Math.min(f, state.endFrame - minFrames);
      else state.endFrame = Math.max(f, state.startFrame + minFrames);
      state.startFrame = Math.max(0, state.startFrame);
      state.endFrame = Math.min(n, state.endFrame);
      paint();
      syncRangeInputs();
    });
    svg.addEventListener("pointerup", () => { drag = null; });
    svg.addEventListener("pointercancel", () => { drag = null; });
  }

  function syncRangeInputs() {
    if (!state.audio) return;
    $("startInput").max = state.audio.frameCount;
    $("endInput").max = state.audio.frameCount;
    $("startInput").value = state.startFrame;
    $("endInput").value = state.endFrame;
    const dur = (state.endFrame - state.startFrame) / state.audio.sampleRate;
    $("rangeDur").textContent =
      `区间长度 ${dur.toFixed(3)} s（${state.endFrame - state.startFrame} 帧）` +
      (dur < 0.2 ? " · 短于 0.2 秒，无法分析" : "");
  }

  $("startInput").addEventListener("change", () => {
    if (!state.audio) return;
    const minFrames = Math.ceil(state.audio.sampleRate * 0.2 - 1e-9);
    let v = parseInt($("startInput").value, 10);
    if (isNaN(v)) return syncRangeInputs();
    v = Math.max(0, Math.min(v, state.endFrame - minFrames));
    state.startFrame = v;
    drawWaveform();
    syncRangeInputs();
  });
  $("endInput").addEventListener("change", () => {
    if (!state.audio) return;
    const minFrames = Math.ceil(state.audio.sampleRate * 0.2 - 1e-9);
    let v = parseInt($("endInput").value, 10);
    if (isNaN(v)) return syncRangeInputs();
    v = Math.max(state.startFrame + minFrames, Math.min(v, state.audio.frameCount));
    state.endFrame = v;
    drawWaveform();
    syncRangeInputs();
  });
  $("selectAllBtn").addEventListener("click", () => {
    if (!state.audio) return;
    state.startFrame = 0;
    state.endFrame = state.audio.frameCount;
    drawWaveform();
    syncRangeInputs();
  });
  $("analyzeBtn").addEventListener("click", runAnalysis);

  // ---------- 分析 ----------
  function runAnalysis() {
    if (!state.audio || !state.geometry) {
      toast("请先导入有效的 WAV 与匹配的 JSON");
      return;
    }
    if (!ready()) {
      toast("WAV 声道数与坐标点数不一致，请重新导入");
      return;
    }
    const minFrames = Math.ceil(state.audio.sampleRate * 0.2 - 1e-9);
    if (state.endFrame - state.startFrame < minFrames) {
      toast("分析区间不足 0.2 秒");
      return;
    }
    try {
      state.measurement = D.measurePairs(
        state.audio, state.geometry, state.startFrame, state.endFrame);
      state.silence = D.checkSilence(state.measurement);
      refit();
    } catch (err) {
      resetAnalysis();
      toast(err.message);
    }
  }

  // 仅依赖启用/权重的重算（GCC 测量复用）
  function refit() {
    if (!state.measurement) return;
    if (state.silence) {
      state.fit = state.silence;
    } else {
      state.fit = D.fitBearing(state.measurement.pairs, state.geometry,
        state.audio.sampleRate);
    }
    renderResult();
    renderArray();
    renderPairCurves();
    renderPairTable();
    $("arrayCard").hidden = false;
    $("pairsCard").hidden = false;
    $("exportCard").hidden = false;
    $("jsonOut").hidden = true;
  }

  // ---------- 结果横幅 ----------
  function renderResult() {
    const slot = $("resultSlot");
    slot.innerHTML = "";
    const b = htmlEl("div", slot);
    const f = state.fit;
    if (f.valid) {
      b.className = "status-banner ok" + (f.warnings.length ? " warn" : "");
      const left = htmlEl("div", b);
      const lbl = htmlEl("div", left); lbl.className = "lbl"; lbl.textContent = "声源方位（自 +x 向 +y 逆时针）";
      const big = htmlEl("div", left); big.className = "big";
      big.textContent = f.bearingDeg.toFixed(2) + "°";
      const line = htmlEl("div", left);
      line.className = "stat-line";
      line.style.margin = "8px 0 0";
      const addStat = (k, v) => {
        const s = htmlEl("div", line); s.className = "stat";
        const vv = htmlEl("div", s); vv.className = "v"; vv.textContent = v;
        const kk = htmlEl("div", s); kk.className = "k"; kk.textContent = k;
      };
      addStat("RMS 残差", f.rmsSamples.toFixed(4) + " 样本 / " + (f.rmsS * 1e6).toFixed(2) + " µs");
      addStat("有效通道对", state.measurement.pairs.filter((p) => p.enabled && p.weight > 0).length +
        " / " + state.measurement.pairs.length);
      addStat("区间", `[${state.startFrame}, ${state.endFrame})`);
      if (f.warnings.length) {
        const ul = htmlEl("ul", b); ul.className = "warn-list";
        f.warnings.forEach((w) => { const li = htmlEl("li", ul); li.textContent = w; });
      }
    } else {
      b.className = "status-banner err";
      const left = htmlEl("div", b);
      const lbl = htmlEl("div", left); lbl.className = "lbl"; lbl.textContent = "无法确定方位";
      const big = htmlEl("div", left); big.className = "big"; big.textContent = "—";
      const msg = htmlEl("div", left); msg.className = "msg"; msg.style.marginTop = "6px";
      msg.textContent = f.message;
    }
  }

  // ---------- 阵列图 ----------
  function renderArray() {
    const box = $("arrayBox");
    box.innerHTML = "";
    const W = 440, H = 400, pad = 46;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "麦克风阵列布局与方位箭头",
      style: "width:100%;height:auto;display:block" }, box);
    const coords = state.geometry.coordinates;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    coords.forEach(([x, y]) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    const span = Math.max(maxX - minX, maxY - minY, 0.05) * 1.6;
    const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
    const scale = (Math.min(W, H) - 2 * pad) / span;
    const X = (x) => W / 2 + (x - cx0) * scale;
    const Y = (y) => H / 2 - (y - cy0) * scale;

    // 坐标十字轴
    el("line", { x1: pad - 14, y1: Y(0), x2: W - pad + 14, y2: Y(0),
      stroke: "var(--line)", "stroke-width": 1 }, svg);
    el("line", { x1: X(0), y1: pad - 14, x2: X(0), y2: H - pad + 14,
      stroke: "var(--line)", "stroke-width": 1 }, svg);
    const tx = el("text", { x: W - pad + 16, y: Y(0) + 4, class: "axis-label" }, svg); tx.textContent = "x (m)";
    const ty = el("text", { x: X(0) + 6, y: pad - 18, class: "axis-label" }, svg); ty.textContent = "y (m)";
    // 比例尺
    const barM = niceBar(span / 3);
    const bx = pad, by = H - 14;
    el("line", { x1: bx, y1: by, x2: bx + barM * scale, y2: by, stroke: "var(--ink-2)", "stroke-width": 1.5 }, svg);
    const bl = el("text", { x: bx, y: by - 5, class: "axis-label" }, svg);
    bl.textContent = barM >= 1 ? barM + " m" : (barM * 1000) + " mm";

    // 通道对基线
    state.measurement.pairs.forEach((p) => {
      el("line", {
        x1: X(coords[p.i][0]), y1: Y(coords[p.i][1]),
        x2: X(coords[p.j][0]), y2: Y(coords[p.j][1]),
        class: "pair-line" + (p.enabled && p.weight > 0 ? "" : " off"),
      }, svg);
    });

    // 方位箭头（从阵列质心指向声源）
    const acx = coords.reduce((s, p) => s + p[0], 0) / coords.length;
    const acy = coords.reduce((s, p) => s + p[1], 0) / coords.length;
    if (state.fit.valid) {
      const [ux, uy] = state.fit.u;
      const L = span * 0.42;
      const x0 = X(acx), y0 = Y(acy);
      const x1 = X(acx + ux * L), y1 = Y(acy + uy * L);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const ah = 11;
      const d = `M ${x1} ${y1} L ${x1 - ah * Math.cos(ang - 0.42)} ${y1 - ah * Math.sin(ang - 0.42)}` +
        ` L ${x1 - ah * Math.cos(ang + 0.42)} ${y1 - ah * Math.sin(ang + 0.42)} Z`;
      el("path", { d, fill: "var(--accent)" }, svg);
      el("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "bearing-arrow" }, svg);
      const lab = el("text", { x: x1 + 6, y: y1 - 6, fill: "var(--accent)",
        "font-size": 13, "font-weight": 650 }, svg);
      lab.textContent = state.fit.bearingDeg.toFixed(1) + "°";
    }

    // 麦克风
    coords.forEach((p, idx) => {
      const g = el("g", {}, svg);
      el("circle", { cx: X(p[0]), cy: Y(p[1]), r: 9, fill: seriesColor(idx),
        class: "mic-dot" }, g);
      const t = el("text", { x: X(p[0]), y: Y(p[1]) + 3.6, "text-anchor": "middle",
        fill: "#fff", "font-size": 10.5, "font-weight": 700 }, g);
      t.textContent = idx;
      const px = X(p[0]);
      const tagText = `CH${idx}  (${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;
      // 靠右的点把标签放左侧，避免溢出 SVG 边界
      const onRight = px > W - 110;
      const tag = el("text", {
        x: onRight ? px - 12 : px + 12,
        y: Y(p[1]) - 9,
        "text-anchor": onRight ? "end" : "start",
        class: "mic-tag",
      }, g);
      tag.textContent = tagText;
    });
  }

  function niceBar(target) {
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const n = target / pow;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * pow;
  }

  // ---------- 每对 GCC 小图 ----------
  function renderPairCurves() {
    const box = $("pairCurvesBox");
    box.innerHTML = "";
    const pairs = state.measurement.pairs;
    const cols = 2;
    const W = 210, H = 132, padL = 30, padR = 8, padT = 20, padB = 24;
    const svg = el("svg", { viewBox: `0 0 ${cols * W} ${Math.ceil(pairs.length / cols) * H}`,
      role: "img", "aria-label": "各通道对 GCC-PHAT 相关曲线",
      style: "width:100%;height:auto;display:block" }, box);
    pairs.forEach((p, idx) => {
      const col = idx % cols, row = Math.floor(idx / cols);
      const ox = col * W, oy = row * H;
      const g = el("g", { transform: `translate(${ox},${oy})`,
        class: p.enabled && p.weight > 0 ? "" : "gcc-curve off" }, svg);
      // 两端各留 6px 边距，边界处的峰线不被裁切
      const plotL = padL + 6, plotR = W - padR - 6;
      const xOf = (lag) => plotL + ((lag + p.maxLag) / (2 * p.maxLag)) * (plotR - plotL);
      let yMax = 1e-9;
      p.gcc.forEach((v) => { yMax = Math.max(yMax, Math.abs(v)); });
      // 纵向留 12% 头部空间，避免边界处的峰顶贴边
      const yOf = (v) => padT + (1 - (v / yMax) * 0.76 - 0.12) * (H - padT - padB);

      // 零滞后线与边框刻度
      el("line", { x1: padL, y1: yOf(0), x2: W - padR, y2: yOf(0), class: "gcc-zero" }, g);
      [-p.maxLag, 0, p.maxLag].forEach((lag) => {
        const t = el("text", { x: xOf(lag), y: H - 8, "text-anchor": "middle", class: "axis-label" }, g);
        t.textContent = lag;
      });
      const ttl = el("text", { x: padL, y: 13, class: "small-title" }, g);
      ttl.textContent = `CH${p.i}–CH${p.j}`;
      const sub = el("text", { x: W - padR, y: 13, "text-anchor": "end", class: "small-sub" }, g);
      sub.textContent = `τ=${p.lagSamples.toFixed(2)} 峰=${p.gccPeak.toFixed(2)}`;

      // 曲线
      let d = "";
      p.gcc.forEach((v, q) => {
        const lag = p.lags[q];
        d += (q ? " L" : "M") + xOf(lag).toFixed(1) + " " + yOf(v).toFixed(1);
      });
      el("path", { d, class: "gcc-curve", stroke: seriesColor(p.i) }, g);

      // 实测峰
      el("line", { x1: xOf(p.lagSamples), y1: padT, x2: xOf(p.lagSamples), y2: H - padB,
        class: "gcc-peak" }, g);
      // 拟合预测
      if (state.fit.valid) {
        const predLag = p.predictedTauS * state.audio.sampleRate;
        if (Math.abs(predLag) <= p.maxLag) {
          el("line", { x1: xOf(predLag), y1: padT, x2: xOf(predLag), y2: H - padB,
            class: "gcc-pred" }, g);
        }
      }
    });
  }

  // ---------- 通道对表 ----------
  function renderPairTable() {
    const tbody = $("pairTable").querySelector("tbody");
    tbody.innerHTML = "";
    const maxAbsResid = Math.max.apply(null,
      state.measurement.pairs.map((p) => Math.abs(p.residualSamples || 0)).concat([1e-9]));
    state.measurement.pairs.forEach((p) => {
      const tr = htmlEl("tr", tbody);
      if (!(p.enabled && p.weight > 0)) tr.classList.add("off");

      const tdEn = htmlEl("td", tr);
      const cb = htmlEl("input", tdEn);
      cb.type = "checkbox"; cb.checked = p.enabled;
      cb.setAttribute("aria-label", `启用通道对 ${p.i}-${p.j}`);
      cb.addEventListener("change", () => { p.enabled = cb.checked; refit(); });

      const tdPair = htmlEl("td", tr);
      const sw = htmlEl("span", tdPair); sw.className = "sw";
      sw.style.background = seriesColor(p.i);
      tdPair.appendChild(document.createTextNode(`CH${p.i} – CH${p.j}`));

      const tdBase = htmlEl("td", tr); tdBase.classList.add("mono");
      tdBase.textContent = p.baseline.toFixed(4);
      const tdMax = htmlEl("td", tr); tdMax.classList.add("mono");
      tdMax.textContent = "±" + p.maxLag;
      const tdLag = htmlEl("td", tr); tdLag.classList.add("mono");
      tdLag.textContent = (p.lagSamples >= 0 ? "+" : "") + p.lagSamples.toFixed(3) +
        (p.atPhysicalLimit ? " ⚠" : "");
      const tdTau = htmlEl("td", tr); tdTau.classList.add("mono");
      tdTau.textContent = (p.tauS >= 0 ? "+" : "") + (p.tauS * 1e6).toFixed(2);
      const tdPeak = htmlEl("td", tr); tdPeak.classList.add("mono");
      tdPeak.textContent = p.gccPeak.toFixed(4);
      if (p.gccPeak < D.constants.GCC_PEAK_FLOOR) tdPeak.style.color = "var(--critical)";

      const tdW = htmlEl("td", tr);
      const win = htmlEl("input", tdW);
      win.type = "number"; win.min = "0"; win.step = "0.1"; win.value = p.weight;
      win.className = "weight";
      win.setAttribute("aria-label", `通道对 ${p.i}-${p.j} 权重`);
      win.addEventListener("change", () => {
        const v = parseFloat(win.value);
        p.weight = isFinite(v) && v >= 0 ? v : 0;
        win.value = p.weight;
        refit();
      });

      const tdR = htmlEl("td", tr);
      const bar = htmlEl("span", tdR); bar.className = "resid-bar";
      const fill = htmlEl("i", bar);
      const r = Math.abs(p.residualSamples || 0);
      fill.style.width = (10 + 90 * (r / maxAbsResid)).toFixed(1) + "%";
      if (r > 1) bar.classList.add("bad");
      else if (r > D.constants.RESIDUAL_WARN_SAMPLES) bar.classList.add("warn");
      tdR.appendChild(document.createTextNode(" "));
      const rs = htmlEl("span", tdR); rs.style.fontFamily = "var(--mono)"; rs.style.fontSize = "11.5px";
      rs.textContent = (p.residualSamples >= 0 ? "+" : "") + (p.residualSamples || 0).toFixed(3);
    });
  }

  $("enableAllBtn").addEventListener("click", () => {
    state.measurement.pairs.forEach((p) => { p.enabled = true; });
    refit();
  });
  $("resetWeightBtn").addEventListener("click", () => {
    state.measurement.pairs.forEach((p) => { p.weight = 1; });
    refit();
  });

  // ---------- 导出 ----------
  function buildExport() {
    const m = state.measurement;
    const f = state.fit;
    return {
      convention: {
        coordinate_unit: "m",
        axes: "x 向右、y 向上",
        bearing_definition: "从 +x 轴向 +y 轴逆时针，范围 [0,360)，单位度",
        source_direction: "u 从阵列指向声源（远场单位矢量）",
        arrival_time: "t_i = -p_i·u/c",
        pair_lag_definition: "tau_ij = t_j - t_i（i<j），预测值 = -(p_j-p_i)·u/c",
        positive_lag_meaning: "正滞后表示通道 j 比通道 i 晚收到",
        gcc_formula: "IFFT(conj(FFT(xi))*FFT(xj)/max(abs(conj(Xi)*Xj),1e-12))",
        window: "去均值后乘对称 Hann 窗，线性零填充",
        refinement: "整数峰 ±ceil(d·fs/c) 内搜索，相邻三点抛物线细化",
      },
      files: { wav: state.wavName, geometry_json: state.jsonName },
      audio: {
        sample_rate_hz: state.audio.sampleRate,
        bits_per_sample: state.audio.bitsPerSample,
        channel_count: state.audio.channelsCount,
        total_frames: state.audio.frameCount,
      },
      array: {
        coordinates_m: state.geometry.coordinates,
        speed_m_s: state.geometry.speed,
      },
      analysis_interval: {
        start_frame: state.startFrame,
        end_frame: state.endFrame,
        duration_s: (state.endFrame - state.startFrame) / state.audio.sampleRate,
        nfft: m.nfft,
        signal_max_channel_rms: m.signalRms,
      },
      pair_measurements: m.pairs.map((p) => ({
        i: p.i,
        j: p.j,
        enabled: p.enabled && p.weight > 0,
        weight: p.weight,
        baseline_m: round(p.baseline, 6),
        physical_max_lag_samples: p.maxLag,
        lag_samples: round(p.lagSamples, 6),
        tau_s: round(p.tauS, 12),
        gcc_peak: round(p.gccPeak, 6),
        predicted_tau_s: f.valid ? round(p.predictedTauS, 12) : null,
        residual_s: f.valid ? round(p.residualS, 12) : null,
        residual_samples: f.valid ? round(p.residualSamples, 6) : null,
        peak_at_physical_limit: p.atPhysicalLimit,
      })),
      bearing: f.valid ? {
        valid: true,
        bearing_deg: round(f.bearingDeg, 4),
        unit_vector: [round(f.u[0], 8), round(f.u[1], 8)],
        rms_residual_s: round(f.rmsS, 12),
        rms_residual_samples: round(f.rmsSamples, 6),
        sse_s2: round(f.sse, 15),
        warnings: f.warnings,
      } : { valid: false, reason: f.reason, message: f.message },
      exported_at: new Date().toISOString(),
    };
  }

  function round(v, digits) {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  }

  $("exportBtn").addEventListener("click", () => {
    if (!state.measurement) return;
    const out = $("jsonOut");
    out.hidden = false;
    out.textContent = JSON.stringify(buildExport(), null, 2);
  });
  $("copyBtn").addEventListener("click", async () => {
    if (!state.measurement) return;
    const text = JSON.stringify(buildExport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("已复制到剪贴板"); }
      catch (_) { toast("复制失败，请手动选择文本"); }
      ta.remove();
    }
  });
  $("downloadBtn").addEventListener("click", () => {
    if (!state.measurement) return;
    const text = JSON.stringify(buildExport(), null, 2);
    try {
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (state.wavName.replace(/\.wav$/i, "") || "bearing") + "-bearing.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      toast("当前环境不支持下载，请改用复制按钮");
    }
  });

  // ---------- 主题切换 ----------
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("mb-theme", next); } catch (e) { /* 忽略 */ }
    if (state.measurement) { renderArray(); renderPairCurves(); renderPairTable(); }
  });
  try {
    const saved = localStorage.getItem("mb-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) { /* 忽略 */ }
})();
