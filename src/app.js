/* Browser controller for the shared-label outline workbench. */
(function () {
  'use strict';

  const C = window.LabelOutlineCore;
  const $ = id => document.getElementById(id);

  const state = {
    model: null,
    result: null,
    areaLimit: 0,
    tool: 'edit',
    selectedEdge: null,
    hoverEdge: null,
    hoverCell: null,
    view: { scale: 10, ox: 20, oy: 20 },
    canvasSize: { w: 0, h: 0, dpr: 1 },
    drag: null,
    spacePan: false,
  };

  let rasterCanvas = null;
  let rasterDirty = true;
  let checkerPattern = null;
  let renderHandle = 0;
  let rebuildTimer = 0;
  let hoverHandle = 0;
  let lastPointer = null;

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const wrap = $('canvas-wrap');

  window.LabelOutlineApp = {
    state,
    loadRaw,
    loadStripeFixture,
    rebuildResult,
    exportJSON: exportSharedJSON,
    exportSVG: exportLabelSVG,
    buildJSON: () => state.result ? C.buildSharedEdgesJSON(state.result) : null,
    buildSVG: () => state.result ? C.buildLabelSVG(state.result) : null,
    fitView,
  };

  /* -------------------------------- Utilities ----------------------------- */

  function showError(message) {
    const box = $('error-box');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = message;
  }

  let toastTimer = 0;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function scheduleRender() {
    if (renderHandle) return;
    renderHandle = requestAnimationFrame(() => {
      renderHandle = 0;
      render();
    });
  }

  function scheduleVectorRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildResult(), 140);
  }

  /* --------------------------------- Data --------------------------------- */

  function loadRaw(raw, sourceName) {
    showError('');
    const model = new C.LabelGridModel(raw);
    state.model = model;
    state.result = null;
    state.selectedEdge = null;
    state.hoverEdge = null;
    rasterDirty = true;

    $('canvas-empty').hidden = true;
    $('export-json').disabled = true;
    $('export-svg').disabled = true;
    $('data-status').textContent =
      `已导入 ${sourceName || model.name || '标签栅格'}：${model.height} 行 × ${model.width} 列。`;

    const maxR = model.height - 1;
    const maxC = model.width - 1;
    $('cell-row').max = maxR;
    $('cell-col').max = maxC;

    rebuildResult();
    requestAnimationFrame(() => fitView());
  }

  async function loadSample() {
    try {
      const response = await fetch('samples/label-outline.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();
      loadRaw(raw, 'samples/label-outline.json');
    } catch (err) {
      if (window.SAMPLE_LABEL_OUTLINE) {
        loadRaw(window.SAMPLE_LABEL_OUTLINE, '内置 samples/label-outline.json 副本');
        toast('当前环境限制 fetch，已载入内置示例；也可用“选择 JSON”导入原文件。');
        return;
      }
      showError('无法载入示例。请使用“选择 JSON”选择 samples/label-outline.json，或在仓库目录运行 npm start。\n' + err.message);
      toast('示例载入失败，请手动选择 samples/label-outline.json');
    }
  }

  function loadStripeFixture() {
    const width = 512;
    const height = 112;
    const labels = new Array(height);
    for (let r = 0; r < height; r++) {
      const value = r % 2 ? 2 : 1;
      labels[r] = new Array(width).fill(value);
    }
    $('area-limit').value = '0';
    $('area-range').value = '0';
    loadRaw(
      { labels, palette: { 1: '#5c91c5', 2: '#d6a851' } },
      '512×112 满额条纹压测图'
    );
  }

  function readFile(file) {
    if (!file) return;
    file.text().then(text => {
      try {
        loadRaw(JSON.parse(text), file.name);
      } catch (err) {
        showError(err.message || String(err));
        toast('JSON 解析失败');
      }
    }).catch(err => showError('读取文件失败：' + err.message));
  }

  /* ------------------------------- Processing ------------------------------ */

  function currentAreaLimit() {
    const value = Number($('area-limit').value);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function rebuildResult() {
    clearTimeout(rebuildTimer);
    if (!state.model) return;

    state.areaLimit = currentAreaLimit();
    state.selectedEdge = null;
    updateEdgePanel(null);

    const started = performance.now();
    let details = null;
    try {
      state.result = C.processGrid(state.model, { maxDoubleArea: state.areaLimit });
      showError('');
      $('export-json').disabled = false;
      $('export-svg').disabled = false;
    } catch (err) {
      state.result = null;
      details = err.details || null;
      $('export-json').disabled = true;
      $('export-svg').disabled = true;
      showError(err.message || String(err));
    }
    const elapsed = performance.now() - started;

    updateStats(elapsed, details);
    updateHistoryButtons();
    updateLegend();
    updatePaintSwatch();
    rasterDirty = true;
    render();

    const pill = $('perf-pill');
    if (state.result) {
      pill.textContent = `结果已显示 · ${Math.round(elapsed)} ms`;
      pill.style.background = 'rgba(21,128,61,.35)';
    } else {
      pill.textContent = '输入超出约束或无效';
      pill.style.background = 'rgba(198,40,40,.42)';
    }
  }

  function updateStats(elapsed, details) {
    const m = state.model;
    const r = state.result;
    $('stat-grid').textContent = m ? `${m.height} × ${m.width}` : '—';

    if (r) {
      $('stat-unit').textContent = r.unitEdges.length.toLocaleString('zh-CN');
      $('stat-edges').textContent = r.edges.length.toLocaleString('zh-CN');
      $('stat-chains').textContent = `${r.chains.length} / ${r.cycles.length}`;
      $('stat-removed').textContent = r.removedCount.toLocaleString('zh-CN');
    } else if (details && details.boundaryCount != null) {
      $('stat-unit').textContent = details.boundaryCount.toLocaleString('zh-CN') + '（超限）';
      $('stat-edges').textContent = '—';
      $('stat-chains').textContent = '—';
      $('stat-removed').textContent = '—';
    } else {
      $('stat-unit').textContent = '—';
      $('stat-edges').textContent = '—';
      $('stat-chains').textContent = '—';
      $('stat-removed').textContent = '—';
    }
    $('stat-time').textContent = `${elapsed.toFixed(1)} ms`;
    const zero = $('stat-zero');
    if (r && r.maxDoubleArea === 0) {
      zero.textContent = C.areaZeroBoundariesMatch(r) ? '单位边集合一致' : '不一致';
      zero.style.color = zero.textContent === '不一致' ? 'var(--danger)' : 'var(--ok)';
    } else {
      zero.textContent = '—';
      zero.style.color = '';
    }
  }

  function updateHistoryButtons() {
    $('undo-btn').disabled = !state.model || !state.model.canUndo();
    $('redo-btn').disabled = !state.model || !state.model.canRedo();
  }

  function updateLegend() {
    const el = $('legend');
    if (!state.model) {
      el.innerHTML = '<span class="hint">尚未导入标签</span>';
      return;
    }
    const labels = state.result ? state.result.labels : C.uniqueLabels(state.model.cells);
    const all = [0, ...labels.filter(x => x !== 0)];
    el.innerHTML = all.map(label => {
      const color = C.resolveColor(state.model.palette, label);
      const bg = label === 0
        ? 'background: repeating-conic-gradient(#cdd5e3 0% 25%, #fff 0% 50%) 50% / 8px 8px;'
        : `background:${color};`;
      const text = label === 0 ? '0 透明/图外' : String(label);
      return `<span class="legend-item"><i style="${bg}"></i>${text}</span>`;
    }).join('');
  }

  function updatePaintSwatch() {
    const label = Math.max(0, parseInt($('paint-label').value, 10) || 0);
    const color = C.resolveColor(state.model ? state.model.palette : null, label);
    const sw = $('paint-swatch');
    if (label === 0) {
      sw.style.background = '';
    } else {
      sw.style.background = color;
    }
  }

  /* -------------------------------- Canvas -------------------------------- */

  function resizeCanvas() {
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.canvasSize = { w: rect.width, h: rect.height, dpr };
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    render();
  }

  function fitView() {
    if (!state.model) return;
    const rect = wrap.getBoundingClientRect();
    const pad = 34;
    const scale = Math.min(
      (rect.width - pad * 2) / state.model.width,
      (rect.height - pad * 2) / state.model.height
    );
    state.view.scale = Math.max(0.05, scale);
    state.view.ox = (rect.width - state.model.width * state.view.scale) / 2;
    state.view.oy = (rect.height - state.model.height * state.view.scale) / 2;
    render();
  }

  function eventPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    return {
      sx, sy,
      x: (sx - state.view.ox) / state.view.scale,
      y: (sy - state.view.oy) / state.view.scale,
    };
  }

  function cellAtWorld(x, y) {
    if (!state.model) return null;
    const c = Math.floor(x);
    const r = Math.floor(y);
    if (!state.model.inBounds(r, c)) return null;
    return { r, c };
  }

  function ensureRaster() {
    if (!state.model) return null;
    const { width: w, height: h, cells, palette } = state.model;
    if (!rasterCanvas) rasterCanvas = document.createElement('canvas');
    if (rasterCanvas.width !== w || rasterCanvas.height !== h) {
      rasterCanvas.width = w;
      rasterCanvas.height = h;
      rasterDirty = true;
    }
    if (!rasterDirty) return rasterCanvas;

    const rctx = rasterCanvas.getContext('2d');
    const image = rctx.createImageData(w, h);
    for (let i = 0; i < cells.length; i++) {
      const label = cells[i];
      const offset = i * 4;
      if (label === 0) {
        image.data[offset + 3] = 0;
        continue;
      }
      const css = C.resolveColor(palette, label);
      let rgb = C.parseColorToRgb(css);
      if (!rgb) rgb = C.parseColorToRgb(C.defaultColor(label));
      image.data[offset] = rgb.r;
      image.data[offset + 1] = rgb.g;
      image.data[offset + 2] = rgb.b;
      image.data[offset + 3] = Math.round((rgb.a == null ? 1 : rgb.a) * 255);
    }
    rctx.putImageData(image, 0, 0);
    rasterDirty = false;
    return rasterCanvas;
  }

  function getCheckerPattern(scale) {
    if (!checkerPattern) {
      const pc = document.createElement('canvas');
      pc.width = 16;
      pc.height = 16;
      const pctx = pc.getContext('2d');
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, 16, 16);
      pctx.fillStyle = '#cfd7e6';
      pctx.fillRect(0, 0, 8, 8);
      pctx.fillRect(8, 8, 8, 8);
      checkerPattern = ctx.createPattern(pc, 'repeat');
    }
    if (checkerPattern && checkerPattern.setTransform) {
      // Keep the checker squares around 16 screen pixels despite world scaling.
      checkerPattern.setTransform(new DOMMatrix([1 / scale, 0, 0, 1 / scale, 0, 0]));
    }
    return checkerPattern;
  }

  function render() {
    const { w: cssW, h: cssH, dpr } = state.canvasSize;
    if (!cssW || !cssH) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!state.model) return;

    const { scale, ox, oy } = state.view;
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    const W = state.model.width;
    const H = state.model.height;

    // Shadow/backing.
    ctx.save();
    ctx.shadowColor = 'rgba(16,26,49,.22)';
    ctx.shadowBlur = 18 / scale;
    ctx.shadowOffsetY = 5 / scale;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Transparent holes / outside-label-zero cells.
    const pattern = getCheckerPattern(scale);
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W, H);
    }

    const raster = ensureRaster();
    ctx.imageSmoothingEnabled = false;
    if (raster) ctx.drawImage(raster, 0, 0, W, H);

    // Visible pixel grid at high zoom.
    if (scale >= 13) {
      const left = Math.max(0, Math.floor(-ox / scale) - 1);
      const top = Math.max(0, Math.floor(-oy / scale) - 1);
      const right = Math.min(W, Math.ceil((cssW - ox) / scale) + 1);
      const bottom = Math.min(H, Math.ceil((cssH - oy) / scale) + 1);
      ctx.beginPath();
      for (let x = left; x <= right; x++) {
        ctx.moveTo(x, Math.max(0, top));
        ctx.lineTo(x, Math.min(H, bottom));
      }
      for (let y = top; y <= bottom; y++) {
        ctx.moveTo(Math.max(0, left), y);
        ctx.lineTo(Math.min(W, right), y);
      }
      ctx.lineWidth = 0.7 / scale;
      ctx.strokeStyle = 'rgba(40,52,78,.22)';
      ctx.stroke();

      if (scale >= 26) {
        ctx.font = `${10.5 / scale}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let r = top; r < bottom; r++) {
          for (let c = left; c < right; c++) {
            const label = state.model.get(r, c);
            ctx.fillStyle = label === 0 ? 'rgba(23,32,51,.45)' : 'rgba(255,255,255,.88)';
            ctx.strokeStyle = label === 0 ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.35)';
            ctx.lineWidth = 2.4 / scale;
            const text = String(label);
            ctx.strokeText(text, c + 0.5, r + 0.52);
            ctx.fillText(text, c + 0.5, r + 0.52);
          }
        }
      }
    }

    // Hover cell / paint target.
    if (state.hoverCell && (state.tool === 'edit' || state.drag?.mode === 'edit')) {
      const { r, c } = state.hoverCell;
      ctx.fillStyle = 'rgba(36,87,214,.22)';
      ctx.fillRect(c, r, 1, 1);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = 'rgba(36,87,214,.95)';
      ctx.strokeRect(c + 0.03 / scale, r + 0.03 / scale, 1 - 0.06 / scale, 1 - 0.06 / scale);
    }

    if (state.result) {
      drawEdges(ctx, state.result.edges, scale);
      if (state.hoverEdge && state.hoverEdge !== state.selectedEdge) {
        drawSingleEdge(ctx, state.hoverEdge, scale, '#2457d6', 3.2);
      }
      if (state.selectedEdge) {
        drawSingleEdge(ctx, state.selectedEdge, scale, '#f97316', 4.2);
        drawEndpoints(ctx, state.selectedEdge, scale);
      }
    }

    // Outer border.
    ctx.lineWidth = 1.2 / scale;
    ctx.strokeStyle = 'rgba(16,26,49,.55)';
    ctx.strokeRect(0, 0, W, H);
  }

  function drawEdges(c, edges, scale) {
    c.beginPath();
    for (const e of edges) {
      c.moveTo(e.x1, e.y1);
      c.lineTo(e.x2, e.y2);
    }
    c.lineWidth = 1.15 / scale;
    c.strokeStyle = 'rgba(15,23,42,.82)';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
  }

  function drawSingleEdge(c, e, scale, color, widthPx) {
    c.beginPath();
    c.moveTo(e.x1, e.y1);
    c.lineTo(e.x2, e.y2);
    c.lineWidth = widthPx / scale;
    c.strokeStyle = color;
    c.lineCap = 'round';
    c.stroke();
  }

  function drawEndpoints(c, e, scale) {
    for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) {
      c.beginPath();
      c.arc(x, y, 4.2 / scale, 0, Math.PI * 2);
      c.fillStyle = '#ffffff';
      c.fill();
      c.lineWidth = 2 / scale;
      c.strokeStyle = '#c2410c';
      c.stroke();
    }
  }

  /* ------------------------------- Edge info ------------------------------- */

  function updateEdgePanel(hit) {
    const empty = $('edge-info');
    const detail = $('edge-detail');
    if (!hit) {
      empty.hidden = false;
      empty.textContent = state.result
        ? '未选中边：在“点边查看”工具下点击一条共边。'
        : '切换到“点边查看”后，点击任意共边。';
      detail.hidden = true;
      for (const key of ['edgeId', 'left', 'right', 'x1', 'y1', 'x2', 'y2']) delete detail.dataset[key];
      return;
    }

    empty.hidden = true;
    detail.hidden = false;
    const e = hit.edge || hit;
    detail.dataset.edgeId = `e${e.id}`;
    detail.dataset.left = String(e.left);
    detail.dataset.right = String(e.right);
    detail.dataset.x1 = String(e.x1);
    detail.dataset.y1 = String(e.y1);
    detail.dataset.x2 = String(e.x2);
    detail.dataset.y2 = String(e.y2);
    $('edge-id').textContent = `e${e.id}`;
    $('edge-left').textContent = e.left;
    $('edge-right').textContent = e.right;
    $('edge-start').textContent = `(${e.x1}, ${e.y1})`;
    $('edge-end').textContent = `(${e.x2}, ${e.y2})`;
    const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    $('edge-extra').textContent =
      `L=${len.toFixed(2)}; Δ=(${e.x2 - e.x1},${e.y2 - e.y1})`;

    const palette = state.model && state.model.palette;
    for (const [swatchId, label] of [['edge-left-swatch', e.left], ['edge-right-swatch', e.right]]) {
      const sw = $(swatchId);
      if (label === 0) sw.style.background = '';
      else sw.style.background = C.resolveColor(palette, label);
    }
  }

  function clearSelectionForReprocess() {
    state.selectedEdge = null;
    state.hoverEdge = null;
    const empty = $('edge-info');
    empty.hidden = false;
    empty.textContent = '面积上限已更改，正在重新简化；完成后可重新点选边。';
    $('edge-detail').hidden = true;
    scheduleRender();
  }

  function selectEdgeAt(sx, sy) {
    if (!state.result) return;
    const world = eventPoint({ clientX: sx, clientY: sy });
    const tolerance = 11 / state.view.scale;
    const hit = C.hitTestEdge(state.result.edges, world.x, world.y, tolerance);
    state.selectedEdge = hit ? hit.edge : null;
    updateEdgePanel(hit);
    scheduleRender();
  }

  /* ------------------------------- Painting ------------------------------- */

  function paintLabelValue() {
    return Math.max(0, parseInt($('paint-label').value, 10) || 0);
  }

  function paintCell(r, c, label) {
    if (!state.model || !state.model.inBounds(r, c)) return;
    const changed = state.model.paintInBatch
      ? paintBatched(r, c, label)
      : false;
    if (changed) {
      rasterDirty = true;
      scheduleRender();
    }
  }

  function paintBatched(r, c, label) {
    // model.batch is opened on pointerdown and committed on pointerup.
    const i = state.model.index(r, c);
    const current = state.model.cells[i];
    if (current === label) return false;
    if (!state.model.batch) state.model.beginBatch();
    const existing = state.model.batch.get(i);
    if (existing) {
      existing.after = label;
      state.model.cells[i] = label;
    } else {
      state.model.batch.set(i, { i, r, c, before: current, after: label });
      state.model.cells[i] = label;
    }
    return true;
  }

  function paintLine(r0, c0, r1, c1, label) {
    const dr = Math.abs(r1 - r0);
    const dc = Math.abs(c1 - c0);
    const steps = Math.max(dr, dc);
    if (steps === 0) {
      paintCell(r0, c0, label);
      return;
    }
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = Math.round(r0 + (r1 - r0) * t);
      const c = Math.round(c0 + (c1 - c0) * t);
      paintCell(r, c, label);
    }
  }

  /* ------------------------------- Events ---------------------------------- */

  function setTool(tool) {
    state.tool = tool;
    for (const btn of document.querySelectorAll('.tool')) {
      btn.classList.toggle('is-active', btn.dataset.tool === tool);
    }
    canvas.classList.toggle('tool-inspect', tool === 'inspect');
    canvas.classList.toggle('tool-pan', tool === 'pan');
  }

  function initEvents() {
    $('load-sample').addEventListener('click', loadSample);
    $('load-stripe').addEventListener('click', loadStripeFixture);
    $('file-input').addEventListener('change', e => readFile(e.target.files[0]));

    $('area-limit').addEventListener('input', e => {
      const v = Math.max(0, Number(e.target.value) || 0);
      $('area-range').value = String(Math.min(262144, v));
      clearSelectionForReprocess();
      scheduleVectorRebuild();
    });
    $('area-limit').addEventListener('change', rebuildResult);
    $('area-range').addEventListener('input', e => {
      $('area-limit').value = e.target.value;
      clearSelectionForReprocess();
      scheduleVectorRebuild();
    });
    $('area-range').addEventListener('change', rebuildResult);

    $('paint-label').addEventListener('input', updatePaintSwatch);

    document.querySelectorAll('.tool').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    $('cell-form').addEventListener('submit', e => {
      e.preventDefault();
      if (!state.model) {
        toast('请先导入标签栅格');
        return;
      }
      const r = parseInt($('cell-row').value, 10);
      const c = parseInt($('cell-col').value, 10);
      const label = parseInt($('cell-value').value, 10);
      try {
        const cmd = state.model.editCell(r, c, label);
        if (!cmd) toast('该格已经是这个编号');
        rebuildResult();
      } catch (err) {
        showError(err.message);
        toast(err.message);
      }
    });

    $('undo-btn').addEventListener('click', undo);
    $('redo-btn').addEventListener('click', redo);
    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        state.spacePan = true;
      }
    });
    document.addEventListener('keyup', e => {
      if (e.code === 'Space') state.spacePan = false;
    });

    $('export-json').addEventListener('click', exportSharedJSON);
    $('export-svg').addEventListener('click', exportLabelSVG);

    $('zoom-in').addEventListener('click', () => zoomButton(1.25));
    $('zoom-out').addEventListener('click', () => zoomButton(0.8));
    $('zoom-fit').addEventListener('click', fitView);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      state.hoverCell = null;
      if (!state.drag) {
        state.hoverEdge = null;
        $('coord-readout').textContent = '坐标：—';
        scheduleRender();
      }
    });

    canvas.addEventListener('wheel', onWheel, { passive: false });

    new ResizeObserver(resizeCanvas).observe(wrap);
  }

  function undo() {
    if (!state.model || !state.model.canUndo()) return;
    state.model.undo();
    rebuildResult();
  }

  function redo() {
    if (!state.model || !state.model.canRedo()) return;
    state.model.redo();
    rebuildResult();
  }

  function onPointerDown(ev) {
    if (!state.model) return;
    canvas.setPointerCapture(ev.pointerId);
    const p = eventPoint(ev);
    const usePan = state.tool === 'pan' || ev.button === 1 || state.spacePan;
    state.drag = {
      pointerId: ev.pointerId,
      startSx: p.sx,
      startSy: p.sy,
      lastSx: p.sx,
      lastSy: p.sy,
      ox: state.view.ox,
      oy: state.view.oy,
      moved: false,
      mode: usePan ? 'pan' : state.tool,
      lastCell: cellAtWorld(p.x, p.y),
    };

    if (state.drag.mode === 'pan') {
      canvas.classList.add('panning');
    } else if (state.drag.mode === 'edit') {
      state.model.beginBatch();
      const cell = cellAtWorld(p.x, p.y);
      if (cell) {
        paintCell(cell.r, cell.c, paintLabelValue());
        syncCellForm(cell);
      }
    }
  }

  function onPointerMove(ev) {
    lastPointer = ev;
    const p = eventPoint(ev);
    updateCoordReadout(p);

    if (state.drag && state.drag.pointerId === ev.pointerId) {
      const dx = p.sx - state.drag.startSx;
      const dy = p.sy - state.drag.startSy;
      if (Math.hypot(dx, dy) > 3) state.drag.moved = true;

      if (state.drag.mode === 'pan') {
        state.view.ox = state.drag.ox + dx;
        state.view.oy = state.drag.oy + dy;
        scheduleRender();
        return;
      }

      if (state.drag.mode === 'edit') {
        const cell = cellAtWorld(p.x, p.y);
        if (cell && state.drag.lastCell) {
          paintLine(
            state.drag.lastCell.r, state.drag.lastCell.c,
            cell.r, cell.c, paintLabelValue()
          );
          state.drag.lastCell = cell;
          syncCellForm(cell);
        }
        return;
      }
    }

    const cell = cellAtWorld(p.x, p.y);
    state.hoverCell = cell;

    if (state.tool === 'inspect' && state.result) {
      if (!hoverHandle) {
        hoverHandle = requestAnimationFrame(() => {
          hoverHandle = 0;
          const tolerance = 11 / state.view.scale;
          const rect = canvas.getBoundingClientRect();
          // Use last event through closure? Simpler event stored globally.
          const last = lastPointer;
          if (!last) return;
          const wp = eventPoint(last);
          const hit = C.hitTestEdge(state.result.edges, wp.x, wp.y, tolerance);
          state.hoverEdge = hit ? hit.edge : null;
          scheduleRender();
        });
      }
    } else if (state.hoverEdge) {
      state.hoverEdge = null;
    }
    scheduleRender();
  }

  function onPointerUp(ev) {
    const drag = state.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;

    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    canvas.classList.remove('panning');

    if (drag.mode === 'edit') {
      const cmd = state.model.commitBatch();
      if (cmd) rebuildResult();
      else updateHistoryButtons();
    } else if (drag.mode === 'inspect' && !drag.moved) {
      selectEdgeAt(ev.clientX, ev.clientY);
    }

    state.drag = null;
  }

  function syncCellForm(cell) {
    $('cell-row').value = cell.r;
    $('cell-col').value = cell.c;
    const label = state.model.get(cell.r, cell.c);
    $('cell-value').value = label;
  }

  function updateCoordReadout(p) {
    if (!state.model) return;
    const cell = cellAtWorld(p.x, p.y);
    if (cell) {
      const label = state.model.get(cell.r, cell.c);
      $('coord-readout').textContent =
        `r=${cell.r}, c=${cell.c} · 标签=${label} · x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}`;
    } else {
      $('coord-readout').textContent = `x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}（图外按 0）`;
    }
  }

  function onWheel(ev) {
    if (!state.model) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const wx = (mx - state.view.ox) / state.view.scale;
    const wy = (my - state.view.oy) / state.view.scale;
    const factor = Math.exp(-ev.deltaY * 0.0014);
    const next = Math.min(96, Math.max(0.05, state.view.scale * factor));
    state.view.ox = mx - wx * next;
    state.view.oy = my - wy * next;
    state.view.scale = next;
    scheduleRender();
  }

  function zoomButton(factor) {
    const rect = wrap.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const wx = (mx - state.view.ox) / state.view.scale;
    const wy = (my - state.view.oy) / state.view.scale;
    const next = Math.min(96, Math.max(0.05, state.view.scale * factor));
    state.view.ox = mx - wx * next;
    state.view.oy = my - wy * next;
    state.view.scale = next;
    scheduleRender();
  }

  /* -------------------------------- Export -------------------------------- */

  function exportSharedJSON() {
    rebuildResult(); // Flush a debounced area-input change before serializing.
    if (!state.result) return null;
    const data = C.buildSharedEdgesJSON(state.result);
    window.LabelOutlineApp.lastJSON = data;
    downloadFile('shared-edges.json', JSON.stringify(data, null, 2), 'application/json');
    toast('已导出共边 JSON');
    return data;
  }

  function exportLabelSVG() {
    rebuildResult();
    if (!state.result) return null;
    const svg = C.buildLabelSVG(state.result);
    window.LabelOutlineApp.lastSVG = svg;
    downloadFile('labels-no-stroke.svg', svg, 'image/svg+xml;charset=utf-8');
    toast('已导出无描边 SVG');
    return svg;
  }

  /* --------------------------------- Init --------------------------------- */

  initEvents();
  resizeCanvas();
  updatePaintSwatch();
  setTool('inspect');
  const params = new URLSearchParams(window.location.search);
  if (params.get('fixture') === 'stripe' || params.get('bench') === 'stripe') {
    loadStripeFixture();
  } else {
    loadSample();
  }
})();
