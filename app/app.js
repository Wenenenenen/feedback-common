/* App layer: state, canvas rendering, editing, reference compare, exports. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const canvas = $("view");
  const ctx = canvas.getContext("2d");

  const state = {
    scene: null,
    sceneName: "scene.json",
    rays: [],
    activeId: null,
    traces: new Map(),       // ray id -> dda trace
    refTraces: new Map(),    // ray id -> exhaustive trace (when enabled)
    compareRows: [],
    hover: null,
    settings: {
      refMode: false,
      ovColor: true, ovDepth: false, ovNormal: false, ovCells: true,
      ovInterval: true, ovRay: true, ovGrid: false, ovLabels: false,
    },
  };

  const STATUS_LABEL = {
    "candidate": "候选", "graze": "擦碰", "backface": "背面",
    "empty-depth": "空深度", "source-skip": "源格跳过", "miss": "锥外",
    hit: "命中", "near": "近裁", "far": "远裁", "off-screen": "越界",
    "max-distance": "超距", "source-only": "仅源格", "epsilon": "起点容差",
    "bad-direction": "零方向",
  };
  const STATUS_COLOR = {
    hit: "var(--hit)", candidate: "var(--cand)", graze: "var(--graze)",
    backface: "var(--back)", "empty-depth": "var(--empty)",
    "source-skip": "var(--source)", near: "var(--near)",
    "off-screen": "var(--off)", far: "var(--off)", "max-distance": "var(--off)",
    miss: "var(--off)", "source-only": "var(--source)",
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function showBanner(kind, text) {
    const el = kind === "err" ? $("errBanner") : $("okBanner");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 4200);
  }

  // ---------- scene loading ----------
  async function loadScene(name, uploaded) {
    let scene;
    try {
      if (uploaded) {
        scene = uploaded;
      } else {
        const res = await fetch("data/" + name);
        if (!res.ok) throw new Error("HTTP " + res.status);
        scene = await res.json();
      }
      validateScene(scene);
    } catch (e) {
      showBanner("err", "场景载入失败：" + e.message);
      $("sceneSelect").value = state.sceneName === "capacity.json"
        ? "capacity.json" : "scene.json";
      return;
    }
    state.scene = scene;
    if (!uploaded) state.sceneName = name;
    canvas.width = scene.width;
    canvas.height = scene.height;
    $("cameraInfo").innerHTML = [
      ["fx / fy", `${scene.camera.fx} / ${scene.camera.fy}`],
      ["cx / cy", `${scene.camera.cx} / ${scene.camera.cy}`],
      ["near / far", `${scene.camera.near} / ${scene.camera.far}`],
      ["尺寸", `${scene.width} × ${scene.height}`],
      ["深度格", `${scene.depth.filter((d) => d !== null).length}`],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join("");
    $("thickness").value = scene.thickness;
    $("epsilon").value = scene.epsilon;
    $("maxDistance").value = scene.maxDistance;
    state.rays = (scene.rays || []).map((r) => structuredClone(r));
    state.activeId = state.rays[0]?.id ?? null;
    state.compareRows = [];
    $("compareTable").hidden = true;
    retraceAll();
    syncRayEditor();
    render();
  }

  function validateScene(s) {
    const need = ["width", "height", "camera", "depth", "normal", "color"];
    for (const k of need) if (!(k in s)) throw new Error("缺少字段 " + k);
    const n = s.width * s.height;
    if (s.depth.length !== n || s.normal.length !== n || s.color.length !== n) {
      throw new Error("数组长度与 width*height 不符");
    }
    for (const k of ["fx", "fy", "cx", "cy", "near", "far"]) {
      if (typeof s.camera[k] !== "number") throw new Error("camera." + k + " 缺失");
    }
    if (s.camera.near <= 0) throw new Error("near 必须为正（z>0 透视约定）");
  }

  // ---------- tracing ----------
  function activeScene() {
    // overlay current UI parameters without mutating the loaded scene
    return Object.assign({}, state.scene, {
      thickness: parseFloat($("thickness").value) || 0,
      epsilon: parseFloat($("epsilon").value) || 0,
      maxDistance: parseFloat($("maxDistance").value) || 0,
    });
  }

  function retraceAll() {
    const scene = activeScene();
    state.traces.clear();
    state.refTraces.clear();
    for (const ray of state.rays) {
      state.traces.set(ray.id, Tracer.trace(scene, ray, "dda"));
      if (state.settings.refMode) {
        state.refTraces.set(ray.id, Tracer.trace(scene, ray, "exhaustive"));
      }
    }
  }

  function currentRay() {
    return state.rays.find((r) => r.id === state.activeId) || null;
  }
  function currentTrace() {
    return state.traces.get(state.activeId) || null;
  }

  // ---------- rendering ----------
  function render() {
    renderCanvas();
    renderRayList();
    renderResult();
    renderHud();
  }

  function basePixelColor(idx) {
    const s = state.settings;
    const scene = state.scene;
    const depth = scene.depth[idx];
    if (s.ovDepth) {
      if (depth === null) return [18, 22, 28];
      const depths = scene.depth.filter((d) => d !== null);
      const lo = Math.min(...depths), hi = Math.max(...depths);
      const t = hi === lo ? 0.5 : (depth - lo) / (hi - lo);
      return [Math.round(40 + t * 200), Math.round(120 - t * 60), Math.round(200 - t * 120)];
    }
    if (s.ovNormal) {
      const n = scene.normal[idx];
      if (depth === null) return [18, 22, 28];
      return [Math.round((n[0] * 0.5 + 0.5) * 255),
        Math.round((n[1] * 0.5 + 0.5) * 255),
        Math.round((n[2] * 0.5 + 0.5) * 255)];
    }
    if (s.ovColor) {
      const c = scene.color[idx];
      if (depth === null) return [16, 20, 26];
      return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
    }
    return depth === null ? [16, 20, 26] : [210, 216, 224];
  }

  function renderCanvas() {
    const scene = state.scene;
    if (!scene) return;
    const W = scene.width, H = scene.height;
    const img = ctx.createImageData(W, H);
    for (let idx = 0; idx < W * H; idx++) {
      const [r, g, b] = basePixelColor(idx);
      const o = idx * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const trace = currentTrace();
    if (!trace) return;
    const ray = currentRay();

    // walked-cell overlay
    if (state.settings.ovCells) {
      for (const cell of trace.cells) {
        const [x, y] = cell.pixel;
        let color;
        if (trace.hit && cell.pixel[0] === trace.hit.pixel[0]
          && cell.pixel[1] === trace.hit.pixel[1]) color = cssVar("--hit");
        else color = STATUS_COLOR[cell.status] || "var(--off)";
        ctx.fillStyle = withAlpha(color, cell.status === "candidate" ? 0.42 : 0.26);
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // ray polyline in projected coordinates
    if (state.settings.ovRay && trace.span) {
      const [t0, t1] = trace.span;
      const d = trace.normalizedDirection;
      const p0 = Tracer.projectAt(ray.origin, d, t0, scene.camera);
      const p1 = Tracer.projectAt(ray.origin, d, t1, scene.camera);
      const lw = Math.max(0.08, W / 900);
      ctx.strokeStyle = cssVar("--accent");
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      // endpoint ticks show where clipping stopped the ray
      ctx.fillStyle = cssVar("--accent");
      for (const [u, v] of [p0, p1]) {
        ctx.beginPath();
        ctx.arc(u, v, lw * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // origin marker (may be off-screen)
      if (ray.origin[2] > 0) {
        const po = Tracer.projectPoint(ray.origin, scene.camera);
        if (po[0] >= 0 && po[0] < W && po[1] >= 0 && po[1] < H) {
          ctx.fillStyle = cssVar("--source");
          ctx.beginPath();
          ctx.arc(po[0], po[1], Math.max(0.22, W / 600), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // off-screen / near-plane reason marker at the clipped end
      if (!trace.hit && (trace.reason === "near" || trace.reason === "off-screen"
        || trace.reason === "far")) {
        ctx.strokeStyle = cssVar("--near");
        ctx.lineWidth = lw * 1.4;
        const r = Math.max(0.35, W / 300);
        ctx.beginPath();
        ctx.moveTo(p1[0] - r, p1[1] - r); ctx.lineTo(p1[0] + r, p1[1] + r);
        ctx.moveTo(p1[0] + r, p1[1] - r); ctx.lineTo(p1[0] - r, p1[1] + r);
        ctx.stroke();
      }
    }

    // hit interval markers: enter (triangle) / exit (cross)
    if (state.settings.ovInterval && trace.hit) {
      const d = trace.normalizedDirection;
      const [hx, hy] = trace.hit.pixel;
      for (const [t, kind] of [[trace.hit.enter, "in"], [trace.hit.exit, "out"]]) {
        const [u, v] = Tracer.projectAt(ray.origin, d, t, scene.camera);
        ctx.fillStyle = kind === "in" ? cssVar("--hit") : cssVar("--cand");
        ctx.beginPath();
        if (kind === "in") {
          ctx.moveTo(u, v - 0.32); ctx.lineTo(u + 0.3, v + 0.24); ctx.lineTo(u - 0.3, v + 0.24);
        } else {
          ctx.arc(u, v, 0.22, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.strokeStyle = cssVar("--hit");
      ctx.lineWidth = 0.08;
      ctx.strokeRect(hx + 0.08, hy + 0.08, 0.84, 0.84);
    }

    if (state.settings.ovGrid) {
      ctx.strokeStyle = withAlpha(cssVar("--ink"), 0.18);
      ctx.lineWidth = 0.04;
      for (let x = 0; x <= W; x++) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = 0; y <= H; y++) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    if (state.settings.ovLabels) {
      // canvas is upscaled by CSS; size text in display px then convert
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / W;
      const px = 11 / scale;
      ctx.font = `bold ${px}px monospace`;
      ctx.textBaseline = "top";
      for (const cell of trace.cells) {
        if (cell.status !== "candidate" && cell.status !== "graze") continue;
        const [x, y] = cell.pixel;
        const color = cell.status === "candidate" ? cssVar("--cand") : cssVar("--graze");
        const label = STATUS_LABEL[cell.status];
        const w = ctx.measureText(label).width;
        ctx.fillStyle = withAlpha(cssVar("--panel"), 0.75);
        ctx.fillRect(x + 0.06, y + 0.06, Math.min(w + 0.12, 0.9), px * 1.05 + 0.1);
        ctx.fillStyle = color;
        ctx.fillText(label, x + 0.1, y + 0.1);
      }
    }

    // hover frame
    if (state.hover) {
      ctx.strokeStyle = cssVar("--accent");
      ctx.lineWidth = 0.1;
      ctx.strokeRect(state.hover[0] + 0.04, state.hover[1] + 0.04, 0.92, 0.92);
    }
  }

  function withAlpha(color, alpha) {
    if (color.startsWith("#")) {
      const n = parseInt(color.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(",").map((s) => s.trim());
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
    }
    return color;
  }

  function renderHud() {
    const trace = currentTrace();
    const hud = $("hud");
    if (!trace) { hud.innerHTML = ""; return; }
    const hit = trace.hit
      ? `<span class="pill hit">命中 (${trace.hit.pixel[0]},${trace.hit.pixel[1]}) t∈[${trace.hit.enter.toFixed(4)}, ${trace.hit.exit.toFixed(4)})</span>`
      : `<span class="pill miss">未命中 · ${STATUS_LABEL[trace.reason] || trace.reason}</span>`;
    hud.innerHTML =
      `${hit}<span class="pill">遍历 ${trace.walkedCount} 格</span>` +
      `<span class="pill">候选 ${trace.candidates.length}</span>` +
      `<span class="pill">t 区间 [${trace.span ? trace.span[0].toFixed(4) : "—"}, ${trace.span ? trace.span[1].toFixed(4) : "—"}]</span>`;
  }

  function renderRayList() {
    const list = $("rayList");
    list.innerHTML = "";
    for (const ray of state.rays) {
      const tr = state.traces.get(ray.id);
      const div = document.createElement("div");
      div.className = "rayitem" + (ray.id === state.activeId ? " active" : "");
      const cls = tr?.reason === "hit" ? "hit" : (tr ? "miss" : "none");
      div.innerHTML = `<span class="dot ${cls}"></span>
        <span><span class="name">${escapeHtml(ray.id)}</span><br>
        <span class="meta">${tr ? STATUS_LABEL[tr.reason] || tr.reason : "—"} · 候选 ${tr?.candidates.length ?? 0}</span></span>
        <span class="meta mono">${tr?.hit ? tr.hit.pixel.join(",") : "—"}</span>`;
      div.onclick = () => { state.activeId = ray.id; syncRayEditor(); render(); };
      list.appendChild(div);
    }
  }

  function renderResult() {
    const trace = currentTrace();
    const ray = currentRay();
    const box = $("rayResult");
    if (!trace || !ray) { box.innerHTML = '<p class="muted">无射线</p>'; $("cellTable").querySelector("tbody").innerHTML = ""; return; }
    const rows = [];
    if (trace.hit) {
      rows.push(["命中格", `(${trace.hit.pixel[0]}, ${trace.hit.pixel[1]})`]);
      rows.push(["enter t", trace.hit.enter.toPrecision(10)]);
      rows.push(["exit t", trace.hit.exit.toPrecision(10)]);
      rows.push(["板内长度", (trace.hit.exit - trace.hit.enter).toPrecision(6)]);
    } else {
      rows.push(["主因", STATUS_LABEL[trace.reason] || trace.reason]);
      rows.push(["次因", trace.reasonFactors.map((f) => STATUS_LABEL[f] || f).join("、")]);
      if (trace.reason === "near" || trace.reason === "far" || trace.reason === "off-screen") {
        rows.push(["相机 near/far", `${scene.camera.near} / ${scene.camera.far}`]);
        const zAt = (t) => ray.origin[2] + trace.normalizedDirection[2] * t;
        rows.push(["z@epsilon / z@maxD",
          `${zAt(scene.epsilon).toFixed(4)} / ${zAt(scene.maxDistance).toFixed(4)}`]);
      }
    }
    rows.push(["归一化方向", trace.normalizedDirection.map((v) => v.toFixed(5)).join(", ")]);
    rows.push(["源方向长度", trace.directionLength.toPrecision(6)]);
    if (ray.sourcePixel) rows.push(["sourcePixel", `(${ray.sourcePixel[0]}, ${ray.sourcePixel[1]}) 整格跳过`]);
    box.innerHTML = `<div class="kv">${rows.map(([k, v]) => `<b>${k}</b><span>${escapeHtml(String(v))}</span>`).join("")}</div>`;

    const tbody = $("cellTable").querySelector("tbody");
    tbody.innerHTML = trace.cells.map((c) => {
      const enter = c.enter !== undefined ? c.enter.toFixed(6)
        : (c.coneEnter !== undefined ? c.coneEnter.toFixed(6) : "—");
      const exit = c.exit !== undefined ? c.exit.toFixed(6)
        : (c.coneExit !== undefined ? c.coneExit.toFixed(6) : "—");
      const tag = (trace.hit && c.pixel[0] === trace.hit.pixel[0]
        && c.pixel[1] === trace.hit.pixel[1]) ? "hit" : c.status;
      return `<tr><td>(${c.pixel[0]}, ${c.pixel[1]})</td>
        <td style="text-align:left"><span class="status-tag tag-${tag}">${STATUS_LABEL[c.status] || c.status}${tag === "hit" ? "·命中" : ""}</span></td>
        <td>${enter}</td><td>${exit}</td></tr>`;
    }).join("");
  }

  // ---------- editor ----------
  function syncRayEditor() {
    const ray = currentRay();
    if (!ray) return;
    $("rId").value = ray.id;
    $("ox").value = ray.origin[0]; $("oy").value = ray.origin[1]; $("oz").value = ray.origin[2];
    $("dx").value = ray.direction[0]; $("dy").value = ray.direction[1]; $("dz").value = ray.direction[2];
    $("hasSource").checked = !!ray.sourcePixel;
    $("srcX").value = ray.sourcePixel?.[0] ?? 0;
    $("srcY").value = ray.sourcePixel?.[1] ?? 0;
  }

  function readEditorRay() {
    const num = (id) => parseFloat($(id).value);
    const ray = {
      id: $("rId").value.trim() || `ray-${state.rays.length + 1}`,
      origin: [num("ox"), num("oy"), num("oz")],
      direction: [num("dx"), num("dy"), num("dz")],
    };
    if ($("hasSource").checked) {
      ray.sourcePixel = [parseInt($("srcX").value) || 0, parseInt($("srcY").value) || 0];
    }
    return ray;
  }

  function applyEditor() {
    const ray = readEditorRay();
    if (ray.origin.some(Number.isNaN) || ray.direction.some(Number.isNaN)) {
      showBanner("err", "origin/direction 必须是数字"); return;
    }
    const old = currentRay();
    if (old && old.id !== ray.id && state.rays.some((r) => r.id === ray.id)) {
      showBanner("err", "射线 ID 已存在"); return;
    }
    if (old) Object.assign(old, ray);
    else state.rays.push(ray);
    state.activeId = ray.id;
    retraceAll(); syncRayEditor(); render();
  }

  // ---------- pixel click → reflection ----------
  function eventCell(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * canvas.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return [x, y];
  }

  canvas.addEventListener("click", (e) => {
    const cell = eventCell(e);
    if (!cell) return;
    const built = Tracer.reflectionFromPixel(activeScene(), cell[0], cell[1]);
    if (built.error) { showBanner("err", built.message); return; }
    const ray = built.ray;
    // replace an existing reflection from the same pixel, else add
    const existing = state.rays.findIndex((r) => r.sourcePixel
      && r.sourcePixel[0] === cell[0] && r.sourcePixel[1] === cell[1]);
    if (existing >= 0) state.rays[existing] = ray;
    else state.rays.push(ray);
    state.activeId = ray.id;
    retraceAll(); syncRayEditor(); render();
    if (built.issues.length) showBanner("err", built.issues.join("；"));
    else showBanner("ok", `已从 (${cell[0]},${cell[1]}) 生成反射射线 ${ray.id}`);
  });

  canvas.addEventListener("mousemove", (e) => {
    state.hover = eventCell(e);
    const info = $("cursorInfo");
    if (state.hover && state.scene) {
      const [x, y] = state.hover;
      const idx = y * state.scene.width + x;
      const d = state.scene.depth[idx];
      info.textContent = `像素 (${x},${y}) · 深度 ${d === null ? "null" : d} · 法线 [${state.scene.normal[idx].map((v) => v.toFixed(3)).join(", ")}]`;
    }
    renderCanvas();
  });
  canvas.addEventListener("mouseleave", () => { state.hover = null; renderCanvas(); });

  // ---------- reference comparison ----------
  function runCompare() {
    const scene = activeScene();
    state.settings.refMode = true;
    $("refMode").checked = true;
    const tbody = $("compareTable").querySelector("tbody");
    tbody.innerHTML = "";
    let allOk = true;
    state.compareRows = state.rays.map((ray) => {
      const dda = Tracer.trace(scene, ray, "dda");
      const ex = Tracer.trace(scene, ray, "exhaustive");
      state.traces.set(ray.id, dda);
      state.refTraces.set(ray.id, ex);
      const hitSame = JSON.stringify(dda.hit?.pixel ?? null)
        === JSON.stringify(ex.hit?.pixel ?? null);
      const enterDiff = dda.hit && ex.hit ? Math.abs(dda.hit.enter - ex.hit.enter) : 0;
      const candSame = dda.candidates.length === ex.candidates.length;
      // full interval agreement
      let intervalOk = hitSame && enterDiff <= 1e-12 && candSame;
      if (intervalOk && dda.hit) {
        intervalOk = Math.abs(dda.hit.exit - ex.hit.exit) <= 1e-12;
      }
      const ok = intervalOk;
      if (!ok) allOk = false;
      return { id: ray.id, hitSame, enterDiff,
        ddaCand: dda.candidates.length, exCand: ex.candidates.length, ok };
    });
    for (const row of state.compareRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(row.id)}</td>
        <td>${row.hitSame ? "一致" : "不一致"}</td>
        <td>${row.enterDiff.toExponential(2)}</td>
        <td>${row.ddaCand} / ${row.exCand}</td>
        <td class="${row.ok ? "compare-ok" : "compare-bad"}">${row.ok ? "通过" : "失败"}</td>`;
      tbody.appendChild(tr);
    }
    $("compareTable").hidden = false;
    $("compareSummary").innerHTML = allOk
      ? `<span class="compare-ok">${state.compareRows.length} 条射线全部通过：命中格、t 参数与候选数量逐格一致。</span>`
      : `<span class="compare-bad">存在分歧，请查看下表。</span>`;
    render();
  }

  // ---------- exports ----------
  function buildExportJson() {
    const scene = activeScene();
    return {
      exportedAt: new Date().toISOString(),
      scene: {
        width: scene.width, height: scene.height, camera: scene.camera,
        thickness: scene.thickness, epsilon: scene.epsilon,
        maxDistance: scene.maxDistance,
      },
      convention: {
        projection: "u=fx*x/z+cx, v=cy-fy*y/z; half-open cells [i,i+1)x[j,j+1)",
        ray: "p(t)=origin+t*normalize(direction); t in [epsilon,maxDistance], near<=z<=far",
        volume: "projection cone intersect z slab [depth,depth+thickness]",
        frontFace: "normal . direction < 0",
        grazeRule: "interval length must exceed 1e-9; single-point contact rejected",
        tieBreak: "smallest enter t, then (y,x) lexicographic",
      },
      rays: state.rays.map((ray) => {
        const dda = state.traces.get(ray.id);
        const ex = state.refTraces.get(ray.id);
        return {
          ray,
          dda: stripTrace(dda),
          exhaustive: ex ? stripTrace(ex) : null,
        };
      }),
    };
  }

  function stripTrace(t) {
    return {
      reason: t.reason, reasonFactors: t.reasonFactors,
      hit: t.hit, span: t.span, spanTags: t.spanTags,
      walkedCount: t.walkedCount,
      normalizedDirection: t.normalizedDirection,
      candidates: t.candidates,
      cells: t.cells,
    };
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(buildExportJson(), null, 2)],
      { type: "application/json" });
    download(`slab-trace-${Date.now()}.json`, blob);
  }

  function exportPng() {
    // render at 4x with a white/black background bake so the PNG stands alone
    const scale = 4;
    const out = document.createElement("canvas");
    out.width = canvas.width * scale;
    out.height = canvas.height * scale;
    const c = out.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(canvas, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      if (blob) download(`slab-trace-${state.activeId || "frame"}-${Date.now()}.png`, blob);
    }, "image/png");
  }

  // ---------- bulk ray IO ----------
  function loadBulkText(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { showBanner("err", "JSON 解析失败：" + e.message); return; }
    if (!Array.isArray(parsed)) { showBanner("err", "需要射线对象数组"); return; }
    const bad = parsed.find((r) => !Array.isArray(r.origin) || !Array.isArray(r.direction));
    if (bad) { showBanner("err", "每条射线需要 origin 与 direction 数组"); return; }
    state.rays = parsed.map((r, i) => Object.assign({ id: `ray-${i + 1}` }, r));
    state.activeId = state.rays[0]?.id ?? null;
    retraceAll(); syncRayEditor(); render();
    showBanner("ok", `已载入 ${state.rays.length} 条射线`);
  }

  // ---------- wiring ----------
  function wire() {
    $("sceneSelect").onchange = async (e) => {
      if (e.target.value === "__upload__") { $("sceneFile").click(); e.target.value = state.sceneName; return; }
      await loadScene(e.target.value);
    };
    $("sceneFile").onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { loadScene(file.name, JSON.parse(reader.result)); }
        catch (err) { showBanner("err", "文件不是合法 JSON：" + err.message); }
      };
      reader.readAsText(file);
      e.target.value = "";
    };
    $("themeBtn").onclick = () => {
      const root = document.documentElement;
      const dark = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", dark ? "light" : "dark");
      render();
    };
    for (const key of Object.keys(state.settings)) {
      const el = $(key);
      if (!el) continue;
      el.checked = state.settings[key];
      el.onchange = () => {
        state.settings[key] = el.checked;
        if (key === "refMode") retraceAll();
        render();
      };
    }
    for (const id of ["thickness", "epsilon", "maxDistance"]) {
      $(id).onchange = () => { retraceAll(); render(); };
    }
    $("applyRay").onclick = applyEditor;
    $("normalizeDir").onclick = () => {
      const n = Tracer.normalize([parseFloat($("dx").value), parseFloat($("dy").value), parseFloat($("dz").value)]);
      if (n.len === 0) { showBanner("err", "零向量无法归一化"); return; }
      $("dx").value = n.dir[0]; $("dy").value = n.dir[1]; $("dz").value = n.dir[2];
    };
    $("addRay").onclick = () => {
      const ray = { id: `ray-${state.rays.length + 1}`, origin: [0, 0, 2], direction: [0, 0, 1] };
      state.rays.push(ray); state.activeId = ray.id;
      retraceAll(); syncRayEditor(); render();
    };
    $("dupRay").onclick = () => {
      const ray = currentRay();
      if (!ray) return;
      const copy = structuredClone(ray);
      copy.id = ray.id + "-copy";
      state.rays.push(copy); state.activeId = copy.id;
      retraceAll(); syncRayEditor(); render();
    };
    $("delRay").onclick = () => {
      const i = state.rays.findIndex((r) => r.id === state.activeId);
      if (i < 0) return;
      state.rays.splice(i, 1);
      state.activeId = state.rays[Math.min(i, state.rays.length - 1)]?.id ?? null;
      retraceAll(); syncRayEditor(); render();
    };
    $("runCompare").onclick = runCompare;
    $("exportPng").onclick = exportPng;
    $("exportJson").onclick = exportJson;
    $("loadBulk").onclick = () => loadBulkText($("bulkJson").value);
    $("fillBulk").onclick = () => {
      $("bulkJson").value = JSON.stringify(state.rays, null, 2);
    };
    $("loadRayFile").onclick = () => $("rayFile").click();
    $("rayFile").onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadBulkText(reader.result);
      reader.readAsText(file);
      e.target.value = "";
    };
    $("legend").innerHTML = [
      ["--hit", "命中格"], ["--cand", "候选区间"], ["--graze", "单点擦碰"],
      ["--back", "背面剔除"], ["--empty", "空深度"], ["--source", "源格/起点"],
      ["--accent", "射线路径"], ["--near", "近裁/未命中"],
    ].map(([v, label]) =>
      `<span><i class="swatch" style="background:var(${v})"></i>${label}</span>`).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  wire();
  loadScene("scene.json");
})();
