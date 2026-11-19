/* app.js — 簇光校验台交互层（纯原生 JS + Canvas 2D，无第三方渲染/分簇组件） */
"use strict";
(function () {
  const CC = globalThis.ClusterCore;
  const $ = (id) => document.getElementById(id);

  const state = {
    caseName: null,
    raw: null,
    overrides: new Map(),       // id -> {position?, radius?, intensity?}
    res: null,                  // 规范结果（不截断）
    cappedRes: null,            // 截断诊断结果
    cap: 128,
    imgMode: "cluster",
    heatSlice: 0,
    selectedPx: null,           // [px,py]
    selectedCluster: null,
    selectedLightId: null,
    tonemap: true,
    showLights: true,
    view3dMode: "all",
    cam: { yaw: -0.72, pitch: 0.42, dist: 0, target: [0, 0, 8] },
    drag3d: null,
  };

  /* ---------------- 工具 ---------------- */
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rampColors(varPrefix, stops) {
    return stops.map((s) => hexToRgb(cssVar("--" + varPrefix + "-" + s)));
  }
  function rampAt(colors, t) {
    t = Math.max(0, Math.min(1, t));
    const seg = t * (colors.length - 1);
    const i = Math.min(colors.length - 2, Math.floor(seg));
    const f = seg - i;
    return [0, 1, 2].map((k) => Math.round(colors[i][k] + (colors[i + 1][k] - colors[i][k]) * f));
  }
  function fmt(v, d) {
    if (v === null || v === undefined) return "—";
    if (!Number.isFinite(v)) return String(v);
    const av = Math.abs(v);
    if (av !== 0 && (av < 1e-4 || av >= 1e5)) return v.toExponential(3);
    return v.toFixed(d === undefined ? 4 : d);
  }
  function msg(text, kind) {
    const box = $("msg-box");
    const el = document.createElement("div");
    el.className = "msgline " + (kind || "");
    el.textContent = text;
    box.prepend(el);
    while (box.children.length > 6) box.lastChild.remove();
  }

  /* ---------------- 主题 ---------------- */
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("cli-theme"); } catch (e) { /* noop */ }
    if (saved) document.documentElement.dataset.theme = saved;
    $("btn-theme").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("cli-theme", next); } catch (e) { /* noop */ }
      renderAll();
    });
  }

  /* ---------------- 加载与重算 ---------------- */
  function recompute() {
    const cap = state.cap;
    state.res = CC.analyze(state.raw, { overrides: state.overrides });
    state.cappedRes = cap > 0 ? CC.analyze(state.raw, { overrides: state.overrides, cap }) : state.res;
    state.heatSlice = Math.min(state.heatSlice, state.res.meta.slices - 1);
  }
  // 让 analyze 在独立帧执行，避免 512/1024 灯重算时长任务冻结交互
  function recomputeAsync() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        recompute();
        requestAnimationFrame(resolve);
      });
    });
  }

  async function loadCase(name, raw) {
    state.caseName = name;
    state.raw = raw;
    state.overrides = new Map();
    state.selectedPx = null;
    state.selectedCluster = null;
    state.selectedLightId = null;
    const v = CC.validateCase(raw);
    renderValidation(v);
    if (v.errors.length) {
      msg("用例存在阻断性错误：" + v.errors.join("；"), "err");
      return;
    }
    $("case-name").textContent = name + "（计算中…）";
    await recomputeAsync();
    fit3dCamera();
    renderAll();
    msg("已加载 " + name + "：" + state.res.meta.nClusters + " 簇，" +
      state.res.lights.length + " 个有效光源", "ok");
    v.warnings.forEach((w) => msg(w, "warn"));
  }

  function renderValidation(v) {
    const box = $("validate-box");
    $("validate-count").textContent =
      v.errors.length + " 错误 / " + v.warnings.length + " 警告";
    const rows = [];
    v.errors.forEach((t) => rows.push(['<div class="msgline err">', t, "</div>"]));
    v.warnings.forEach((t) => rows.push(['<div class="msgline warn">', t, "</div>"]));
    if (!rows.length) rows.push('<div class="msgline ok">全部字段符合格式说明（尺寸、tile_size、slices、深度、法线、光源 id/radius/intensity）</div>');
    box.innerHTML = rows.join("");
  }

  /* ---------------- 主渲染 ---------------- */
  function renderAll() {
    if (!state.res) return;
    // 先由选中像素确定所属簇，保证热图与 3D 高亮与详情同帧一致
    if (state.selectedPx) {
      const [px, py] = state.selectedPx;
      const idx = py * state.res.meta.W + px;
      if (state.res.pixelCluster[idx] >= 0) state.selectedCluster = state.res.pixelCluster[idx];
    }
    renderStatus();
    renderImage();
    renderHeatmap();
    render3d();
    renderDetail();
    renderLightEditor();
  }

  function renderStatus() {
    const r = state.res, m = r.meta;
    $("case-name").textContent = state.caseName;
    $("pill-dims").textContent =
      m.W + "×" + m.H + " · tile " + m.ts + " · 瓦片 " + m.ntx + "×" + m.nty +
      " · " + m.slices + " 对数层";
    $("pill-lights-txt").textContent =
      r.lights.length + " 有效灯" + (r.invalidLightIds.length ? " · 剔除 " + r.invalidLightIds.length : "");
    const maxC = Math.max(...r.clusterCounts);
    const capPill = $("pill-cap");
    capPill.className = "pill " + (maxC > 128 ? "warn" : "");
    $("pill-cap-txt").textContent = "单簇峰值 " + maxC + " 灯（不截断）";
    const errPill = $("pill-err");
    if (state.cap > 0) {
      const ce = state.cappedRes;
      errPill.className = "pill " + (ce.maxError > 0 ? "bad" : "ok");
      $("pill-err-txt").textContent = "cap=" + state.cap + " 误差 max " + fmt(ce.maxError, 6);
    } else {
      errPill.className = "pill ok";
      $("pill-err-txt").textContent = "分簇=穷举 误差 0";
    }
    $("stat-cand").textContent = r.totals.candidateTests.toLocaleString();
    $("stat-evals").textContent = r.totals.actualEvaluations.toLocaleString();
    $("stat-exh").textContent = r.totals.exhaustiveTests.toLocaleString();
    const save = 1 - r.totals.candidateTests / Math.max(1, r.totals.exhaustiveTests);
    $("stat-save").textContent = (save * 100).toFixed(1) + "%";
    $("img-size-tag").textContent = m.W + "×" + m.H + " px";
    $("heat-grid-tag").textContent = m.ntx + "×" + m.nty + " 瓦片 × " + m.slices;
    // 热图层切换
    const hs = $("heat-slice");
    if (hs.children.length !== m.slices) {
      hs.innerHTML = "";
      for (let s = 0; s < m.slices; s++) {
        const b = document.createElement("button");
        b.textContent = "层 " + s;
        b.dataset.slice = s;
        if (s === state.heatSlice) b.classList.add("on");
        b.addEventListener("click", () => { state.heatSlice = s; renderHeatmap(); syncSeg(hs); });
        hs.appendChild(b);
      }
    }
    function syncSeg(container) {
      container.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("on", Number(b.dataset.slice) === state.heatSlice));
    }
  }

  /* ---------------- 屏幕图像 ---------------- */
  function renderImage() {
    const r = state.res, m = r.meta;
    const cv = $("img-canvas");
    const scale = Math.max(2, Math.floor(560 / Math.max(m.W, m.H)));
    cv.width = m.W * scale; cv.height = m.H * scale;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(m.W, m.H);
    const mode = state.imgMode;
    // 误差图：开启截断诊断时显示 cap 引入的漏光误差，否则显示规范路径（恒 0）
    const errSrc = state.cap > 0 ? state.cappedRes.errRGB : r.errRGB;
    const src = mode === "exhaustive" ? r.exhRGB : mode === "error" ? errSrc : r.clusterRGB;
    let hi = 0;
    if (mode === "error") for (let i = 0; i < src.length; i++) hi = Math.max(hi, src[i]);
    const errColors = rampColors("err", [0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < m.W * m.H; i++) {
      let R, G, B;
      if (mode === "error") {
        const e = Math.max(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
        [R, G, B] = rampAt(errColors, hi > 0 ? e / hi : 0);
      } else {
        const lin = [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]];
        if (state.tonemap) {
          R = CC.linearToSRGB255(lin[0]); G = CC.linearToSRGB255(lin[1]); B = CC.linearToSRGB255(lin[2]);
        } else {
          R = Math.round(Math.min(1, lin[0]) * 255);
          G = Math.round(Math.min(1, lin[1]) * 255);
          B = Math.round(Math.min(1, lin[2]) * 255);
        }
      }
      img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B;
      img.data[i * 4 + 3] = 255;
    }
    // 先 1:1 放离屏，再放大画到主画布
    const off = document.createElement("canvas");
    off.width = m.W; off.height = m.H;
    off.getContext("2d").putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, cv.width, cv.height);

    // 簇边界（淡线）
    ctx.strokeStyle = cssVar("--border-strong");
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (let tx = 0; tx <= m.ntx; tx++) {
      const x = Math.min(m.W, tx * m.ts) * scale;
      ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, cv.height); ctx.stroke();
    }
    for (let ty = 0; ty <= m.nty; ty++) {
      const y = Math.min(m.H, ty * m.ts) * scale;
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(cv.width, y + .5); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 选中像素
    if (state.selectedPx) {
      const [px, py] = state.selectedPx;
      ctx.strokeStyle = cssVar("--amber-soft");
      ctx.lineWidth = 2;
      ctx.strokeRect(px * scale + 1, py * scale + 1, scale - 2, scale - 2);
    }
    drawLightMarkers(ctx, scale);
    // 图例
    const legendBar = $("img-legend-bar");
    if (mode === "error") {
      legendBar.style.background =
        "linear-gradient(90deg," + errColors.map((c) => "rgb(" + c + ")").join(",") + ")";
      $("img-legend-label").textContent = state.cap > 0
        ? "线性误差（cap=" + state.cap + " 截断 vs 穷举）"
        : "线性 |分簇−穷举| 最大通道误差";
      $("img-legend-lo").textContent = "0";
      $("img-legend-hi").textContent = hi > 0 ? fmt(hi, 6) : "0（两图完全一致）";
    } else {
      legendBar.style.background =
        "linear-gradient(90deg,#000," + (state.tonemap ? "rgb(255,255,255)" : "rgb(255,255,255) clamp@1") + ")";
      $("img-legend-label").textContent =
        (mode === "exhaustive" ? "逐灯穷举 · " : "分簇列表 · ") +
        (state.tonemap ? "线性→Reinhard→sRGB 显示" : "线性直接 clamp 显示");
      $("img-legend-lo").textContent = "0";
      $("img-legend-hi").textContent = "线性 HDR";
    }
  }

  function drawLightMarkers(ctx, scale) {
    if (!state.showLights) return;
    const r = state.res, m = r.meta;
    const W = m.W * scale, H = m.H * scale;
    const amber = hexToRgb(cssVar("--amber-soft"));
    const blue = hexToRgb(cssVar("--accent"));
    const font = "600 10px " + cssVar("--font-mono");
    ctx.font = font;
    const usedLabelSlots = [];
    const MAX_LABELS = 24;
    let labelCount = 0;
    const tryLabel = (x, y, text, col) => {
      if (labelCount >= MAX_LABELS) return false;
      const tw = ctx.measureText(text).width + 8;
      let lx = Math.max(2, Math.min(W - tw, x + 6));
      let ly = Math.max(12, Math.min(H - 4, y - 6));
      // 有界去重：槽位重叠则向下错开，超过画布即放弃，杜绝死循环
      let attempts = 0;
      while (attempts++ < 30 &&
        usedLabelSlots.some((s) => Math.abs(s.y - ly) < 13 && Math.abs(s.x - lx) < tw)) {
        ly += 12;
        if (ly > H - 4) return false;
      }
      usedLabelSlots.push({ x: lx, y: ly });
      labelCount++;
      ctx.fillStyle = "rgb(" + col + ")";
      ctx.fillText(text, lx, ly);
      return true;
    };
    let behindText = null;
    for (const L of r.lights) {
      const pr = CC.projectLight(r, L);
      const isSel = L.id === state.selectedLightId;
      const col = isSel ? blue : amber;
      if (!pr) {
        // 相机内/相机后：汇总为一条角标，避免逐灯堆叠
        if (!behindText) behindText = { count: 0, ids: [] };
        behindText.count++; behindText.ids.push(L.id);
        continue;
      }
      const x = pr.px * scale, y = pr.py * scale;
      const radPx = Math.max(4, pr.radiusPx * scale);
      ctx.beginPath();
      ctx.arc(x, y, radPx, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(" + col + ",.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, isSel ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(" + col + ")";
      ctx.fill();
      ctx.strokeStyle = cssVar("--bg");
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 仅屏外或选中灯打文字标签，屏内灯靠悬停/点选查看，避免密集场景文字灾难
      if (!pr.onScreen || isSel) tryLabel(x, y, "#" + L.id, col);
    }
    if (behindText) {
      const text = behindText.count + " 灯在相机内/相机后 (id " +
        (behindText.ids.length > 6 ? behindText.ids.slice(0, 6).join(",") + "…" : behindText.ids.join(",")) + ")";
      const tw = ctx.measureText(text).width + 12;
      const boxH = 17, boxY = H - 60; // 上移，避开底部操作提示
      ctx.fillStyle = "rgba(10,12,15,.85)";
      ctx.fillRect(4, boxY, Math.min(W - 8, tw), boxH);
      ctx.fillStyle = "rgb(" + amber + ")";
      ctx.font = "600 10px " + cssVar("--font-mono");
      ctx.fillText(text, 9, boxY + 12);
    }
  }

  /* ---------------- 热图 ---------------- */
  function renderHeatmap() {
    const r = state.res, m = r.meta;
    const cv = $("heat-canvas");
    const cw = 300, ch = Math.round(cw * m.nty / m.ntx);
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext("2d");
    const colors = rampColors("heat", [0, 1, 2, 3, 4, 5]);
    const maxC = Math.max(1, ...r.clusterCounts);
    const cwCell = cw / m.ntx, chCell = ch / m.nty;
    for (const c of r.clusters) {
      if (c.s !== state.heatSlice) continue;
      const t = c.count / maxC;
      const [R, G, B] = rampAt(colors, t);
      ctx.fillStyle = "rgb(" + R + "," + G + "," + B + ")";
      const x = c.tx * cwCell, y = c.ty * chCell;
      ctx.fillRect(x, y, cwCell + 1, chCell + 1);
      ctx.strokeStyle = cssVar("--bg");
      ctx.strokeRect(x + .5, y + .5, cwCell - 1, chCell - 1);
      if (state.selectedCluster === c.index) {
        ctx.strokeStyle = cssVar("--amber-soft");
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 1.5, y + 1.5, cwCell - 3, chCell - 3);
      }
      // 计数文字
      ctx.fillStyle = t > 0.55 ? "#0d0f12" : cssVar("--fg-2");
      ctx.font = "600 " + Math.max(10, Math.min(15, chCell * .36)) + "px " + cssVar("--font-mono");
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(c.count), x + cwCell / 2, y + chCell / 2);
    }
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    $("heat-legend-hi").textContent = maxC + " 灯";
    $("heat-legend-bar").style.background =
      "linear-gradient(90deg," + colors.map((c) => "rgb(" + c + ")").join(",") + ")";
  }

  /* ---------------- 3D 线框（自研软件投影） ---------------- */
  function fit3dCamera() {
    const m = state.res.meta;
    const span = Math.abs(m.far - m.near);
    state.cam.dist = (m.far * 1.35) / Math.tan(0.44);
    state.cam.target = [0, 0, (m.near + m.far) / 2];
  }

  function viewBasis() {
    const { yaw, pitch } = state.cam;
    const eye = [
      state.cam.target[0] + state.cam.dist * Math.cos(pitch) * Math.sin(yaw),
      state.cam.target[1] + state.cam.dist * Math.sin(pitch),
      state.cam.target[2] + state.cam.dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const fwd = CC.vec.normalize(CC.vec.sub(state.cam.target, eye));
    const right = CC.vec.normalize(CC.vec.cross(fwd, [0, 1, 0]));
    const up = CC.vec.cross(right, fwd);
    return { eye, fwd, right, up };
  }
  function project3(p, basis, w, h) {
    const rel = CC.vec.sub(p, basis.eye);
    const z = CC.vec.dot(rel, basis.fwd);
    if (z <= 0.05) return null;
    const x = CC.vec.dot(rel, basis.right);
    const y = CC.vec.dot(rel, basis.up);
    const focal = h * 1.15;
    return { sx: w / 2 + x * focal / z, sy: h / 2 - y * focal / z, z };
  }

  function render3d() {
    const r = state.res, m = r.meta;
    const cv = $("view3d");
    const w = cv.clientWidth || 320, h = 300;
    cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio;
    cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.fillStyle = "#0a0c0f";
    ctx.fillRect(0, 0, w, h);
    const basis = viewBasis();

    // 相机视锥近裁面框
    drawFrustumOutline(ctx, basis, w, h);

    // 簇线框
    const lineColor = cssVar("--border-strong");
    const selColor = cssVar("--accent");
    const edgePairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for (const c of r.clusters) {
      if (state.view3dMode === "selected" && c.index !== state.selectedCluster) continue;
      const corners = CC.clusterCorners(c).map((p) => project3(p, basis, w, h));
      if (corners.some((q) => !q)) continue;
      const isSel = c.index === state.selectedCluster;
      ctx.strokeStyle = isSel ? selColor : lineColor;
      ctx.globalAlpha = isSel ? 0.95 : (state.view3dMode === "selected" ? 0.9 : 0.32);
      ctx.lineWidth = isSel ? 1.6 : 0.8;
      ctx.beginPath();
      for (const [a, b] of edgePairs) {
        ctx.moveTo(corners[a].sx, corners[a].sy);
        ctx.lineTo(corners[b].sx, corners[b].sy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 光源：球用圆圈+半径指示
    const amber = hexToRgb(cssVar("--amber-soft"));
    const blue = hexToRgb(cssVar("--accent"));
    state._3dHits = [];
    for (const L of r.lights) {
      const center = project3(L.position, basis, w, h);
      if (!center) continue;
      const isSel = L.id === state.selectedLightId;
      const col = isSel ? blue : amber;
      // 半径圈：取沿 right 方向偏移 radius 的投影距离近似
      const edgeP = project3(
        [L.position[0] + basis.right[0] * L.radius,
         L.position[1] + basis.right[1] * L.radius,
         L.position[2] + basis.right[2] * L.radius], basis, w, h);
      const radDraw = edgeP ? Math.max(5, Math.abs(edgeP.sx - center.sx)) : 6;
      ctx.beginPath();
      ctx.arc(center.sx, center.sy, radDraw, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(" + col + ",.45)";
      ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath();
      ctx.arc(center.sx, center.sy, isSel ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(" + col + ")";
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = "rgb(" + col + ")";
        ctx.font = "600 11px " + cssVar("--font-mono");
        ctx.fillText("#" + L.id, center.sx + 8, center.sy - 8);
      }
      state._3dHits.push({ id: L.id, x: center.sx, y: center.sy, rad: Math.max(8, radDraw) });
    }
    $("ov-cam").textContent = "yaw " + state.cam.yaw.toFixed(2) + " pitch " + state.cam.pitch.toFixed(2);
  }

  function drawFrustumOutline(ctx, basis, w, h) {
    const m = state.res.meta;
    const t = m.tanHalf, a = m.aspect, n = m.near, f = m.far;
    const pts = [
      [-a * t * n, t * n, n], [a * t * n, t * n, n],
      [a * t * n, -t * n, n], [-a * t * n, -t * n, n],
      [-a * t * f, t * f, f], [a * t * f, t * f, f],
      [a * t * f, -t * f, f], [-a * t * f, -t * f, f],
    ].map((p) => project3(p, basis, w, h));
    if (pts.some((q) => !q)) return;
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    ctx.strokeStyle = cssVar("--fg-3");
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [i, j] of edges) { ctx.moveTo(pts[i].sx, pts[i].sy); ctx.lineTo(pts[j].sx, pts[j].sy); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // 相机原点
    const o = project3([0, 0, 0], basis, w, h);
    if (o) {
      ctx.fillStyle = cssVar("--fg-2");
      ctx.beginPath(); ctx.arc(o.sx, o.sy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = "10px " + cssVar("--font-mono");
      ctx.fillText("camera", o.sx + 6, o.sy + 3);
    }
  }

  /* ---------------- 像素详情 ---------------- */
  function renderDetail() {
    const r = state.res;
    const tag = $("detail-pixel-tag");
    const ckv = $("cluster-kv"), pkv = $("pixel-kv");
    const tbody = $("light-table").querySelector("tbody");
    if (!state.selectedPx) {
      tag.textContent = "未选像素";
      ckv.innerHTML = '<div class="k muted">在左图点击任意像素</div>';
      pkv.innerHTML = "";
      tbody.innerHTML = "";
      return;
    }
    const [px, py] = state.selectedPx;
    const det = CC.pixelDetail(r, px, py);
    tag.textContent = "像素 (" + px + "," + py + ")";
    if (det.background) {
      ckv.innerHTML = '<div class="k">背景像素（depth=null），光照 0，不属于任何簇</div>';
      pkv.innerHTML = ""; tbody.innerHTML = "";
      return;
    }
    const c = r.clusters[det.clusterIndex];
    state.selectedCluster = det.clusterIndex;
    ckv.innerHTML =
      kvRow("簇 index", det.clusterIndex) +
      kvRow("瓦片 (tx,ty)", c.tx + ", " + c.ty) +
      kvRow("深度层 s", c.s + "  (z " + fmt(c.z0, 3) + " → " + fmt(c.z1, 3) + ")") +
      kvRow("像素范围 x", c.x0 + ".." + (c.x1 - 1)) +
      kvRow("像素范围 y", c.y0 + ".." + (c.y1 - 1)) +
      kvRow("完整灯数", c.count + "（不截断）") +
      kvRow("视空间点", "(" + det.viewPos.map((v) => fmt(v, 3)).join(", ") + ")") +
      kvRow("法线 N", "(" + det.normal.map((v) => fmt(v, 3)).join(", ") + ")");
    const sw = (rgb) => '<span class="swatch" style="background:rgb(' +
      rgb.map((v) => CC.linearToSRGB255(v)).join(",") + ')"></span>';
    pkv.innerHTML =
      kvRow("分簇线性 RGB", sw(det.clusterRGB) + rgbText(det.clusterRGB)) +
      kvRow("穷举线性 RGB", sw(det.exhRGB) + rgbText(det.exhRGB)) +
      kvRow("候选测试 / 实际求值", det.candidateTests + " / " + det.actualEvaluations) +
      kvRow("穷举求值次数", det.exhaustiveEvaluations);
    tbody.innerHTML = det.rows.map((row) => {
      const badge = !row.inList ? '<span class="badge out">落选</span>'
        : row.reason === "有贡献" ? '<span class="badge in">候选</span>'
          : '<span class="badge skip">跳过</span>';
      return '<tr data-id="' + row.id + '" class="' +
        (row.contributionMag > 0 ? "contrib" : "") + (row.id === state.selectedLightId ? " sel" : "") + '">' +
        "<td>#" + row.id + "</td><td class='l'>" + badge + "</td>" +
        "<td>" + fmt(row.distance, 3) + "</td>" +
        "<td>" + fmt(row.nl, 3) + "</td>" +
        "<td class='l'>" + row.reason + "</td>" +
        "<td>" + fmt(row.contribution[0], 5) + "</td>" +
        "<td>" + fmt(row.contribution[1], 5) + "</td>" +
        "<td>" + fmt(row.contribution[2], 5) + "</td></tr>";
    }).join("");
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        state.selectedLightId = Number(tr.dataset.id);
        renderAll();
      });
    });
  }
  function kvRow(k, v) {
    return '<div class="k">' + k + '</div><div class="v">' + v + "</div>";
  }
  function rgbText(rgb) {
    return '<span class="num">' + rgb.map((v) => fmt(v, 5)).join(", ") + "</span>";
  }

  /* ---------------- 光源编辑器 ---------------- */
  function renderLightEditor() {
    const empty = $("light-editor-empty"), ed = $("light-editor");
    const id = state.selectedLightId;
    if (id === null || !state.res) { empty.hidden = false; ed.hidden = true; return; }
    empty.hidden = true; ed.hidden = false;
    const L = state.res.lights.find((q) => q.id === id) ||
      state.raw.lights.find((q) => q.id === id);
    if (!L) { empty.hidden = false; ed.hidden = true; return; }
    $("le-x").value = fmt(L.position[0], 4);
    $("le-y").value = fmt(L.position[1], 4);
    $("le-z").value = fmt(L.position[2], 4);
    $("le-r").value = fmt(L.radius, 4);
    $("le-ir").value = fmt(L.intensity[0], 4);
    $("le-ig").value = fmt(L.intensity[1], 4);
    $("le-ib").value = fmt(L.intensity[2], 4);
  }
  function applyLightEdit() {
    const id = state.selectedLightId;
    if (id === null) return;
    const ov = state.overrides.get(id) || {};
    ov.position = [Number($("le-x").value), Number($("le-y").value), Number($("le-z").value)];
    ov.radius = Number($("le-r").value);
    ov.intensity = [Number($("le-ir").value), Number($("le-ig").value), Number($("le-ib").value)];
    if (ov.position.some((v) => !Number.isFinite(v))) { msg("位置必须是数值", "err"); return; }
    if (!(ov.radius > 0)) { msg("radius 必须 >0（否则该灯按无效剔除）", "err"); return; }
    if (ov.intensity.some((v) => !Number.isFinite(v) || v < 0)) { msg("intensity 必须为非负数", "err"); return; }
    state.overrides.set(id, ov);
    recompute(); renderAll();
    msg("灯 #" + id + " 修改已应用并完成全量重算", "ok");
  }

  /* ---------------- 图像交互：选像素 / 拖灯 ---------------- */
  function imagePixelFromEvent(ev) {
    const cv = $("img-canvas"), m = state.res.meta;
    const rect = cv.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) / rect.width * m.W;
    const sy = (ev.clientY - rect.top) / rect.height * m.H;
    return [Math.floor(sx), Math.floor(sy)];
  }
  function pickLightAtImage(ev) {
    const cv = $("img-canvas"), m = state.res.meta;
    const rect = cv.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / rect.width * m.W;
    const my = (ev.clientY - rect.top) / rect.height * m.H;
    let best = null, bestD = 14 / Math.max(1, cv.getBoundingClientRect().width / m.W);
    for (const L of state.res.lights) {
      const pr = CC.projectLight(state.res, L);
      if (!pr) continue;
      const d = Math.hypot(pr.px - mx, pr.py - my);
      if (d < bestD) { bestD = d; best = L; }
    }
    return best;
  }

  function initImageInteraction() {
    const cv = $("img-canvas"), wrap = $("img-wrap");
    let dragging = null;
    cv.addEventListener("pointerdown", (ev) => {
      const L = pickLightAtImage(ev);
      if (L) {
        state.selectedLightId = L.id;
        const z = L.position[2] > 0 ? L.position[2] : state.res.meta.near;
        dragging = { id: L.id, fixedZ: z };
        cv.setPointerCapture(ev.pointerId);
        wrap.classList.add("dragging");
        renderAll();
      } else {
        const [px, py] = imagePixelFromEvent(ev);
        const m = state.res.meta;
        if (px >= 0 && py >= 0 && px < m.W && py < m.H) {
          state.selectedPx = [px, py];
          renderAll();
        }
      }
    });
    cv.addEventListener("pointermove", (ev) => {
      if (dragging) {
        const [px, py] = imagePixelFromEvent(ev);
        const m = state.res.meta;
        const pos = CC.unprojectPixel(state.res,
          Math.max(-.5, Math.min(m.W - .5, px)),
          Math.max(-.5, Math.min(m.H - .5, py)), dragging.fixedZ);
        const ov = state.overrides.get(dragging.id) || {};
        ov.position = pos;
        state.overrides.set(dragging.id, ov);
        recompute(); renderAll();
      } else {
        const L = pickLightAtImage(ev);
        cv.style.cursor = L ? "grab" : "crosshair";
      }
    });
    const endDrag = (ev) => {
      if (dragging) {
        msg("灯 #" + dragging.id + " 已移动，分簇与光照已重算", "ok");
        dragging = null;
        wrap.classList.remove("dragging");
      }
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("mousemove", (ev) => {
      if (dragging) return;
      const [px, py] = imagePixelFromEvent(ev);
      const m = state.res && state.res.meta;
      if (!m || px < 0 || py < 0 || px >= m.W || py >= m.H) { $("tooltip").style.display = "none"; return; }
      const i = py * m.W + px;
      const tip = $("tooltip");
      const rgb = state.imgMode === "exhaustive" ? state.res.exhRGB : state.res.clusterRGB;
      const z = state.res.depth[i];
      tip.innerHTML = '<div class="t-title">像素 (' + px + "," + py + ")</div>" +
        '<div class="t-row"><span>深度 z</span><b>' + (z === null ? "背景" : fmt(z, 3)) + "</b></div>" +
        '<div class="t-row"><span>所属簇</span><b>#' + state.res.pixelCluster[i] + "</b></div>" +
        '<div class="t-row"><span>线性 RGB</span><b>' +
        [0, 1, 2].map((k) => fmt(rgb[i * 3 + k], 3)).join(", ") + "</b></div>" +
        '<div class="t-row"><span>求值/候选</span><b>' +
        state.res.actualEvals[i] + "/" + state.res.candTests[i] + "</b></div>";
      tip.style.display = "block";
      tip.style.left = Math.min(innerWidth - 270, ev.clientX + 14) + "px";
      tip.style.top = (ev.clientY + 14) + "px";
    });
    cv.addEventListener("mouseleave", () => { $("tooltip").style.display = "none"; });

    $("heat-canvas").addEventListener("click", (ev) => {
      const cv2 = $("heat-canvas"), m = state.res.meta;
      const rect = cv2.getBoundingClientRect();
      const tx = Math.floor((ev.clientX - rect.left) / rect.width * m.ntx);
      const ty = Math.floor((ev.clientY - rect.top) / rect.height * m.nty);
      if (tx < 0 || ty < 0 || tx >= m.ntx || ty >= m.nty) return;
      const cidx = (ty * m.ntx + tx) * m.slices + state.heatSlice;
      state.selectedCluster = cidx;
      const c = state.res.clusters[cidx];
      const px = Math.min(m.W - 1, c.x0), py = Math.min(m.H - 1, c.y0);
      state.selectedPx = [px, py];
      renderAll();
      msg("选中簇 #" + cidx + "（瓦片 " + tx + "," + ty + " 层 " + state.heatSlice +
        "），完整灯数 " + c.count, "");
    });
  }

  /* ---------------- 3D 交互 ---------------- */
  function init3dInteraction() {
    const cv = $("view3d");
    let orbit = null;
    cv.addEventListener("pointerdown", (ev) => {
      const rect = cv.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const hit = (state._3dHits || []).find((h) => Math.hypot(h.x - x, h.y - y) <= h.rad);
      if (hit) {
        state.selectedLightId = hit.id;
        const L = state.res.lights.find((q) => q.id === hit.id);
        state.drag3d = { id: hit.id, start: [x, y], planePoint: L.position.slice() };
        cv.setPointerCapture(ev.pointerId);
        renderAll();
      } else {
        orbit = { x: ev.clientX, y: ev.clientY, yaw: state.cam.yaw, pitch: state.cam.pitch };
        cv.setPointerCapture(ev.pointerId);
      }
    });
    cv.addEventListener("pointermove", (ev) => {
      const rect = cv.getBoundingClientRect();
      if (orbit) {
        state.cam.yaw = orbit.yaw - (ev.clientX - orbit.x) * 0.008;
        state.cam.pitch = Math.max(-1.35, Math.min(1.35, orbit.pitch + (ev.clientY - orbit.y) * 0.008));
        render3d();
      } else if (state.drag3d) {
        const basis = viewBasis();
        const w = cv.clientWidth, h = cv.clientHeight;
        const nx = ev.clientX - rect.left, ny = ev.clientY - rect.top;
        // 与过灯点、垂直视线的平面求交
        const focal = h * 1.15;
        const ray = CC.vec.normalize([
          (nx - w / 2) / focal, -(ny - h / 2) / focal, 1
        ].reduce((acc, v, k) => {
          acc[0] += v * basis.right[k]; acc[1] += v * basis.up[k]; acc[2] += v * basis.fwd[k];
          return acc;
        }, [0, 0, 0]));
        const rel = CC.vec.sub(state.drag3d.planePoint, basis.eye);
        const denom = CC.vec.dot(ray, basis.fwd);
        const t = CC.vec.dot(rel, basis.fwd) / denom;
        const hit = [basis.eye[0] + ray[0] * t, basis.eye[1] + ray[1] * t, basis.eye[2] + ray[2] * t];
        const ov = state.overrides.get(state.drag3d.id) || {};
        ov.position = hit;
        state.overrides.set(state.drag3d.id, ov);
        recompute(); renderAll();
      }
    });
    const up = () => {
      if (state.drag3d) { msg("灯 #" + state.drag3d.id + " 3D 拖动完成，已重算", "ok"); state.drag3d = null; }
      orbit = null;
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      state.cam.dist *= 1 + Math.sign(ev.deltaY) * 0.08;
      render3d();
    }, { passive: false });
  }

  /* ---------------- 导出 ---------------- */
  function buildExport() {
    const r = state.res, m = r.meta, N = m.W * m.H;
    const pixels = [];
    for (let i = 0; i < N; i++) {
      const px = i % m.W, py = Math.floor(i / m.W);
      pixels.push({
        px, py,
        depth: r.depth[i],
        background: !!r.isBg[i],
        cluster_index: r.pixelCluster[i],
        cluster_linear_rgb: [r.clusterRGB[i * 3], r.clusterRGB[i * 3 + 1], r.clusterRGB[i * 3 + 2]],
        exhaustive_linear_rgb: [r.exhRGB[i * 3], r.exhRGB[i * 3 + 1], r.exhRGB[i * 3 + 2]],
        error_linear_rgb: [r.errRGB[i * 3], r.errRGB[i * 3 + 1], r.errRGB[i * 3 + 2]],
        candidate_tests: r.candTests[i],
        actual_evaluations: r.actualEvals[i],
        exhaustive_tests: r.exhTests[i],
        exhaustive_evaluations: r.exhEvals[i],
      });
    }
    return {
      schema: "cluster-light-inspector/1",
      exported_at: new Date().toISOString(),
      case: state.caseName,
      camera: {
        view_space: "x-right y-up z-forward",
        width: m.W, height: m.H, fov_y: m.fovY, near: m.near, far: m.far,
        tile_size: m.ts, slices: m.slices,
        tile_count: [m.ntx, m.nty],
        depth_edges: m.edges,
      },
      lights: r.lights.map((L) => ({
        id: L.id, position: L.position, radius: L.radius, intensity: L.intensity,
        modified: state.overrides.has(L.id),
      })),
      invalid_light_ids: r.invalidLightIds,
      clusters: r.clusters.map((c) => ({
        index: c.index, tx: c.tx, ty: c.ty, slice: c.s,
        pixel_bounds: { x0: c.x0, x1: c.x1 - 1, y0: c.y0, y1: c.y1 - 1 },
        depth_bounds: [c.z0, c.z1],
        light_count: c.count,
        light_ids: c.members,
      })),
      pixels,
      totals: r.totals,
      error: {
        max_abs_linear: r.maxError,
        mean_abs_linear: r.meanError,
        note: "线性 RGB 口径，分簇列表与逐灯穷举；规范路径下候选覆盖全部贡献灯，误差为 0",
      },
      truncation_diagnostic: state.cap > 0 ? {
        cap: state.cap,
        max_abs_linear: state.cappedRes.maxError,
        mean_abs_linear: state.cappedRes.meanError,
        affected_clusters: r.clusters.filter((c) => c.count > state.cap).map((c) => c.index),
      } : null,
    };
  }
  function downloadJSON(obj, name) {
    const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------------- 控件绑定 ---------------- */
  function bindControls() {
    document.querySelectorAll("#img-mode button").forEach((b) => {
      b.addEventListener("click", () => {
        state.imgMode = b.dataset.mode;
        document.querySelectorAll("#img-mode button").forEach((q) => q.classList.toggle("on", q === b));
        renderImage();
      });
    });
    document.querySelectorAll("#view3d-mode button").forEach((b) => {
      b.addEventListener("click", () => {
        state.view3dMode = b.dataset.mode;
        document.querySelectorAll("#view3d-mode button").forEach((q) => q.classList.toggle("on", q === b));
        render3d();
      });
    });
    $("chk-tonemap").addEventListener("change", (e) => { state.tonemap = e.target.checked; renderImage(); });
    $("chk-lights").addEventListener("change", (e) => { state.showLights = e.target.checked; renderImage(); });
    $("cap-select").addEventListener("change", (e) => {
      state.cap = Number(e.target.value);
      recompute(); renderStatus(); renderImage(); renderDetail();
      if (state.cap > 0 && state.cappedRes.maxError > 0)
        msg("cap=" + state.cap + " 触发漏光：最大线性误差 " + fmt(state.cappedRes.maxError, 6) +
          "，受影响簇 " + state.res.clusters.filter((c) => c.count > state.cap).length + " 个", "warn");
    });
    $("le-apply").addEventListener("click", applyLightEdit);
    $("le-reset").addEventListener("click", () => {
      const id = state.selectedLightId;
      if (id === null) return;
      state.overrides.delete(id);
      recompute(); renderAll();
      msg("灯 #" + id + " 已恢复用例初始值", "ok");
    });
    $("btn-export").addEventListener("click", () => {
      if (!state.res) { msg("请先加载用例", "err"); return; }
      downloadJSON(buildExport(), (state.caseName || "case") + ".inspection.json");
      msg("已导出完整检查 JSON（簇列表 / 像素线性颜色 / 误差 / 实际求值次数）", "ok");
    });
    $("file-input").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { loadCase(f.name.replace(/\.json$/i, ""), JSON.parse(reader.result)); }
        catch (err) { msg("JSON 解析失败：" + err.message, "err"); }
      };
      reader.readAsText(f);
      e.target.value = "";
    });
    addEventListener("resize", () => { if (state.res) { renderImage(); renderHeatmap(); render3d(); } });
  }

  /* ---------------- 启动（嵌入样例由构建脚本注入 window.__SAMPLES__） ---------------- */
  function boot() {
    initTheme();
    bindControls();
    initImageInteraction();
    init3dInteraction();
    const sel = $("sample-select");
    const samples = globalThis.__SAMPLES__ || {};
    Object.keys(samples).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name + ".json";
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      if (sel.value) loadCase(sel.value, samples[sel.value]);
    });
    const first = Object.keys(samples)[0];
    if (first) { sel.value = first; loadCase(first, samples[first]); }
    else msg("未找到嵌入样例，请使用导入按钮", "warn");
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
