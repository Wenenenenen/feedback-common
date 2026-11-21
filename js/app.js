/*
 * app.js — UI wiring for the sparse-TIFF ROI inspector.
 *
 * All TIFF parsing / tile addressing / decoding lives in js/tiff.js; PNG
 * encoding in js/png.js. This file only handles state, rendering and events.
 */
(function () {
  'use strict';

  const { TiffReader, BlobSource, STATUS, STATUS_LABEL, ORIENTATION_LABEL, CACHE_LIMIT } =
    window.TiffRoi;
  const Png = window.PngWriter;

  // --- DOM --------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const el = {
    fileInput: $('file-input'),
    sampleBtn: $('sample-btn'),
    sampleSelect: $('sample-select'),
    banner: $('banner'),
    stage: $('preview-stage'),
    canvas: $('overview-canvas'),
    roiBox: $('roi-box'),
    roiLabel: $('roi-label'),
    empty: $('preview-empty'),
    overviewProgress: $('overview-progress'),
    zoomLevel: $('zoom-level'),
    zoomIn: $('zoom-in'),
    zoomOut: $('zoom-out'),
    zoomFit: $('zoom-fit'),
    roiView: $('roi-view'),
    viewportReadout: $('viewport-readout'),
    dirList: $('directory-list'),
    orientationNote: $('orientation-note'),
    roiX: $('roi-x'),
    roiY: $('roi-y'),
    roiW: $('roi-w'),
    roiH: $('roi-h'),
    roiApply: $('roi-apply'),
    roiMax: $('roi-max'),
    roiReset: $('roi-reset'),
    roiHint: $('roi-hint'),
    exportPng: $('export-png'),
    exportMask: $('export-mask'),
    cursorPos: $('cursor-pos'),
    pixelRows: $('pixel-rows'),
    pixelTiles: $('pixel-tiles'),
    roiCanvas: $('roi-canvas'),
    roiViewEmpty: $('roi-view-empty'),
    tileSummary: $('tile-summary'),
    tileList: $('tile-list'),
    statDecodes: $('stat-decodes'),
    statTotalDecodes: $('stat-total-decodes'),
    statCache: $('stat-cache'),
    statBytes: $('stat-bytes'),
    statMeta: $('stat-meta'),
    statReads: $('stat-reads'),
    issues: $('issues'),
    dirDetail: $('dir-detail'),
    dirDetailBody: $('dir-detail-body')
  };

  // --- state ------------------------------------------------------------

  const state = {
    reader: null,
    layer: null,
    overview: null,
    overviewToken: 0,
    viewport: null,        // display-space region shown (null = whole image)
    roi: { x: 0, y: 0, width: 256, height: 256 },
    roiResult: null,
    roiToken: 0,
    drag: null,
    pixelToken: 0,
    roiViewScale: 0
  };

  // --- helpers ----------------------------------------------------------

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
  }
  function fmtInt(n) { return n.toLocaleString('en-US'); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function showBanner(lines, kind) {
    if (!lines || !lines.length) { el.banner.hidden = true; return; }
    el.banner.hidden = false;
    el.banner.className = 'banner' + (kind === 'error' ? ' error' : '');
    el.banner.innerHTML = lines.map((l) => '<div>' + l + '</div>').join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // --- file / sample loading -------------------------------------------

  const ZIP_CTX = window;
  let zipEntries = null; // Map<name, {name, async bytes(): Uint8Array}>

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function unzip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const files = window.fflate.unzipSync(buf);
    const entries = new Map();
    for (const name of Object.keys(files).sort()) {
      if (name.endsWith('/')) continue;
      entries.set(name, files[name]);
    }
    return entries;
  }

  function isTiffName(name) { return /\.(tif|tiff)$/i.test(name); }

  async function mountZip(blob, label) {
    const entries = await unzip(blob);
    zipEntries = entries;
    const tiffs = [...entries.keys()].filter(isTiffName);
    if (!tiffs.length) throw new Error('压缩包内没有 .tif / .tiff 文件');
    el.sampleSelect.innerHTML = tiffs.map((n) =>
      '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
    el.sampleSelect.hidden = false;
    el.sampleSelect.title = label;
    const meta = entries.get('truth.json');
    let truth = null;
    if (meta) {
      try { truth = JSON.parse(new TextDecoder().decode(meta)); } catch (_) { truth = null; }
    }
    window.__zipTruth = truth;
    await openEntry(tiffs.includes('plain.tif') ? 'plain.tif' : tiffs[0]);
  }

  async function openEntry(name) {
    const bytes = zipEntries.get(name);
    if (!bytes) return;
    el.sampleSelect.value = name;
    await openBuffer(bytes.slice(), name);
  }

  async function openBuffer(bytes, name) {
    try {
      const reader = await TiffReader.fromBytes(bytes, { name });
      adoptReader(reader, name);
    } catch (err) {
      showBanner(['无法解析 <code>' + escapeHtml(name) + '</code>：' + escapeHtml(err.message)], 'error');
    }
  }

  async function openBlob(blob, name) {
    try {
      const reader = await TiffReader.open(new BlobSource(blob, name));
      adoptReader(reader, name);
    } catch (err) {
      showBanner(['无法解析 <code>' + escapeHtml(name) + '</code>：' + escapeHtml(err.message)], 'error');
    }
  }

  function adoptReader(reader, name) {
    state.reader = reader;
    state.layer = null;
    state.overview = null;
    state.roiResult = null;
    state.roiToken++;
    state.overviewToken++;
    el.empty.hidden = true;
    el.sampleSelect.dataset.file = name;
    el.roiHint.className = 'hint';
    el.roiHint.textContent = '';
    renderDirectories();
    renderDirDetail();
    const notes = [];
    notes.push('已载入 <code>' + escapeHtml(name) + '</code> · ' +
      (reader.big ? 'BigTIFF' : 'Classic TIFF') + ' · ' +
      (reader.littleEndian ? '小端' : '大端') + ' · ' + fmtBytes(reader.size));
    const dirErrors = reader.errors.filter((e) => e.scope === 'directory');
    if (dirErrors.length) {
      notes.push('目录问题：' + dirErrors.map((e) =>
        escapeHtml(e.message) + '（偏移 ' + e.offset + '）').join('；'));
    }
    showBanner(notes, dirErrors.length ? 'error' : null);
    selectLayer(reader.layers[0]);
  }

  // --- directory list ---------------------------------------------------

  function layerTitle(dir) {
    const pos = dir.kind === 'sub'
      ? 'SubIFD #' + dir.subIndex
      : 'IFD #' + dir.chainIndex;
    return pos;
  }

  function renderDirectories() {
    const reader = state.reader;
    if (!reader) return;
    el.dirList.innerHTML = '';
    for (const dir of reader.directories) {
      const ds = reader.displaySize(dir);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dir-item' + (dir === state.layer ? ' active' : '');
      btn.dataset.offset = String(dir.offset);
      const usable = dir.isTiled && !dir.problems.some((p) => /不支持|超过|缺失|不足/.test(p));
      const flag = usable
        ? (dir.kind === 'sub' ? '<span class="dir-flag warn">概览</span>' : '')
        : '<span class="dir-flag">不可用</span>';
      btn.innerHTML =
        '<span class="dir-badge">' + (dir.isTiled ? layerTitle(dir) : 'IFD ' + dir.chainIndex) + '</span>' +
        '<span class="dir-body">' +
          '<span class="dir-title">' + escapeHtml(ds.width + ' × ' + ds.height) + ' 显示</span>' +
          '<span class="dir-meta">' + escapeHtml(
            (dir.tileWidth ? dir.tileWidth + '×' + dir.tileLength + ' 块' : '非图块') +
            ' · ' + (dir.planar === 2 ? '分平面' : '交错') +
            ' · ' + (dir.compression === 8 ? 'Deflate' : dir.compression === 1 ? '未压缩' : '压缩' + dir.compression) +
            ' · 方向' + dir.orientation) + '</span>' +
          (dir.problems.length ? '<span class="dir-meta dir-problem">' +
            escapeHtml(dir.problems[0]) + (dir.problems.length > 1 ? ' 等 ' + dir.problems.length + ' 项' : '') +
            '</span>' : '') +
        '</span>' +
        flag;
      btn.disabled = !dir.isTiled;
      btn.addEventListener('click', () => selectLayer(dir));
      el.dirList.appendChild(btn);
    }
  }

  function selectLayer(dir) {
    if (!dir || !dir.isTiled) return;
    state.layer = dir;
    state.overviewToken++;
    state.roiToken++;
    state.roiResult = null;
    state.overview = null;
    state.viewport = null;
    renderDirectories();
    const ds = state.reader.displaySize(dir);
    el.orientationNote.textContent =
      '方向 ' + dir.orientation + '（' + ORIENTATION_LABEL[dir.orientation] + '） · 存储 ' +
      dir.width + '×' + dir.height + ' → 显示 ' + ds.width + '×' + ds.height;
    resetRoiToDefault();
    refreshExportButtons();
    clearResults();
    renderIssues();
    loadOverview();
  }

  // --- overview ---------------------------------------------------------

  function fitCanvas(canvas, width, height) {
    const stageRect = el.stage.getBoundingClientRect();
    const maxW = Math.max(80, stageRect.width - 28);
    const maxH = Math.max(80, Math.min(stageRect.height, window.innerHeight * 0.62) - 28);
    // allow magnifying tiny images, but not absurdly
    const scale = Math.min(maxW / width, maxH / height, 16);
    const cssW = Math.max(1, Math.round(width * scale));
    const cssH = Math.max(1, Math.round(height * scale));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    return { scale, cssW, cssH };
  }

  function rgbFromRgba(rgba, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    out.set(rgba);
    return out;
  }

  function paintOverview(view) {
    const canvas = el.canvas;
    const { width, height } = view;
    const rgba = view.rgba;
    const step = view.step;
    const displaySize = view.displaySize;
    const viewport = view.viewport || { x: 0, y: 0, width: displaySize.width, height: displaySize.height };
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext('2d');
    tctx.putImageData(new ImageData(rgbFromRgba(rgba, width, height), width, height), 0, 0);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(tmp, 0, 0);
    state.overview = { width, height, step, displaySize, viewport, rgba };
    fitCanvas(canvas, width, height);
    el.empty.hidden = true;
    renderRoiBox();
  }

  /** Paint the already-decoded ROI pixels over the tile map, if visible. */
  function paintRoiPatch(res) {
    const ov = state.overview;
    if (!res || !ov) return;
    const vp = ov.viewport;
    const sx = (res.roi.x - vp.x) / ov.step;
    const sy = (res.roi.y - vp.y) / ov.step;
    const sw = res.width / ov.step;
    const sh = res.height / ov.step;
    const ctx = el.canvas.getContext('2d');
    const patch = document.createElement('canvas');
    patch.width = res.width;
    patch.height = res.height;
    patch.getContext('2d').putImageData(
      new ImageData(rgbFromRgba(res.rgba, res.width, res.height), res.width, res.height), 0, 0
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(patch, sx, sy, sw, sh);
  }

  function showTileMap() {
    const reader = state.reader;
    const dir = state.layer;
    if (!reader || !dir) return;
    const map = reader.buildTileMap(dir, {
      maxDim: 460,
      viewport: state.viewport || undefined
    });
    paintOverview(map);
    if (state.roiResult) paintRoiPatch(state.roiResult);
    const c = reader.countTiles(dir);
    const bits = [fmtInt(c.total) + ' 块', fmtInt(c.present) + ' 存在'];
    if (c.missing) bits.push(fmtInt(c.missing) + ' 缺块');
    if (c.invalid) bits.push(fmtInt(c.invalid) + ' 异常偏移');
    if (c.oob) bits.push(fmtInt(c.oob) + ' 越界');
    el.overviewProgress.hidden = false;
    el.overviewProgress.textContent = bits.join(' · ');
    renderViewportReadout();
  }

  function renderViewportReadout() {
    const ov = state.overview;
    if (!ov) { el.viewportReadout.textContent = ''; return; }
    const vp = ov.viewport;
    const ds = ov.displaySize;
    const atWhole = vp.x === 0 && vp.y === 0 && vp.width === ds.width && vp.height === ds.height;
    el.zoomLevel.textContent = atWhole ? '全图' : '缩放';
    el.zoomLevel.className = 'pill ' + (atWhole ? 'pill-muted' : 'pill-ok');
    el.viewportReadout.textContent = atWhole
      ? ''
      : '视图 x ' + Math.round(vp.x) + '–' + Math.round(vp.x + vp.width - 1) +
        ' · y ' + Math.round(vp.y) + '–' + Math.round(vp.y + vp.height - 1) +
        ' · 每格 ' + ov.step + ' 像素';
  }

  async function loadOverview() {
    const reader = state.reader;
    const dir = state.layer;
    if (!reader || !dir) return;
    // The preview is a tile map: it reads only the directory arrays and
    // never decodes a block. Pixel data is read exclusively for the ROI.
    state.overviewToken++;
    showTileMap();
  }

  // --- zoom / pan -------------------------------------------------------

  function setViewport(viewport) {
    const ds = state.reader.displaySize(state.layer);
    if (!viewport) {
      state.viewport = null;
    } else {
      let w = Math.min(viewport.width, ds.width);
      let h = Math.min(viewport.height, ds.height);
      w = Math.max(1, w); h = Math.max(1, h);
      const x = clamp(viewport.x, 0, ds.width - w);
      const y = clamp(viewport.y, 0, ds.height - h);
      // a viewport that covers the whole image is just "whole image"
      state.viewport = (x === 0 && y === 0 && w === ds.width && h === ds.height)
        ? null
        : { x, y, width: w, height: h };
    }
    showTileMap();
    renderRoiBox();
  }

  function zoomBy(factor, focus) {
    const ov = state.overview;
    if (!ov || !state.layer) return;
    const ds = ov.displaySize;
    const cur = state.viewport || { x: 0, y: 0, width: ds.width, height: ds.height };
    const cx = focus ? focus.x : cur.x + cur.width / 2;
    const cy = focus ? focus.y : cur.y + cur.height / 2;
    // deepest zoom shows at most ~64 display pixels per texel
    const minSpan = 8;
    let w = Math.max(minSpan, cur.width / factor);
    let h = Math.max(minSpan, cur.height / factor);
    if (cur.width >= ds.width && cur.height >= ds.height && factor < 1) {
      state.viewport = null;
      showTileMap();
      renderRoiBox();
      return;
    }
    w = Math.min(w, ds.width);
    h = Math.min(h, ds.height);
    setViewport({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
  }

  function resetViewport() {
    state.viewport = null;
    showTileMap();
    renderRoiBox();
  }

  function zoomToRoi() {
    if (!state.layer) return;
    const ds = state.reader.displaySize(state.layer);
    const r = state.roi;
    // pad around the ROI, never smaller than a couple of tiles
    const pad = Math.max(r.width, r.height, 64) * 0.5;
    const w = Math.min(ds.width, r.width + pad * 2);
    const h = Math.min(ds.height, r.height + pad * 2);
    setViewport({
      x: r.x + r.width / 2 - w / 2,
      y: r.y + r.height / 2 - h / 2,
      width: w, height: h
    });
  }

  // --- ROI box geometry -------------------------------------------------

  function overlayTransform() {
    const canvas = el.canvas;
    const stage = el.stage;
    const stageRect = stage.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      left: canvasRect.left - stageRect.left,
      top: canvasRect.top - stageRect.top,
      scaleX: canvasRect.width / (state.overview ? state.overview.width : canvas.width || 1),
      scaleY: canvasRect.height / (state.overview ? state.overview.height : canvas.height || 1),
      canvasW: canvasRect.width,
      canvasH: canvasRect.height
    };
  }

  function renderRoiBox() {
    const ov = state.overview;
    if (!ov) { el.roiBox.hidden = true; return; }
    const t = overlayTransform();
    const k = ov.step; // display px per overview texel
    const vp = ov.viewport;
    const x = Math.max(state.roi.x, vp.x);
    const y = Math.max(state.roi.y, vp.y);
    const x1 = Math.min(state.roi.x + state.roi.width, vp.x + vp.width);
    const y1 = Math.min(state.roi.y + state.roi.height, vp.y + vp.height);
    if (x1 <= x || y1 <= y) { el.roiBox.hidden = true; return; }
    el.roiBox.hidden = false;
    const left = t.left + ((x - vp.x) / k) * t.scaleX;
    const top = t.top + ((y - vp.y) / k) * t.scaleY;
    const boxW = Math.max(4, ((x1 - x) / k) * t.scaleX);
    const boxH = Math.max(4, ((y1 - y) / k) * t.scaleY);
    el.roiBox.style.left = left + 'px';
    el.roiBox.style.top = top + 'px';
    el.roiBox.style.width = boxW + 'px';
    el.roiBox.style.height = boxH + 'px';
    el.roiLabel.textContent = state.roi.width + '×' + state.roi.height + ' @ ' +
      state.roi.x + ',' + state.roi.y;
    // keep the label inside the box: bottom-left normally, top-right if the
    // box is too short to fit it
    el.roiLabel.classList.toggle('below', boxH > 34);
    el.roiLabel.classList.remove('right');
  }

  function eventToDisplay(ev) {
    const ov = state.overview;
    if (!ov) return null;
    const t = overlayTransform();
    const stageRect = el.stage.getBoundingClientRect();
    const px = (ev.clientX - stageRect.left - t.left) / t.scaleX;
    const py = (ev.clientY - stageRect.top - t.top) / t.scaleY;
    const vp = ov.viewport;
    const dx = Math.round(vp.x + px * ov.step);
    const dy = Math.round(vp.y + py * ov.step);
    return {
      x: clamp(dx, 0, ov.displaySize.width),
      y: clamp(dy, 0, ov.displaySize.height)
    };
  }

  // --- ROI input --------------------------------------------------------

  function setRoiInputs() {
    el.roiX.value = state.roi.x;
    el.roiY.value = state.roi.y;
    el.roiW.value = state.roi.width;
    el.roiH.value = state.roi.height;
  }

  function readRoiInputs() {
    const ds = state.layer ? state.reader.displaySize(state.layer) : { width: 0, height: 0 };
    let x = Math.round(Number(el.roiX.value) || 0);
    let y = Math.round(Number(el.roiY.value) || 0);
    let w = Math.round(Number(el.roiW.value) || 1);
    let h = Math.round(Number(el.roiH.value) || 1);
    if (w > 1024 || h > 1024) {
      el.roiHint.className = 'hint error';
      el.roiHint.textContent = '裁区不能超过 1024×1024（当前 ' + w + '×' + h + '）';
      return null;
    }
    x = clamp(x, 0, Math.max(0, ds.width - 1));
    y = clamp(y, 0, Math.max(0, ds.height - 1));
    w = clamp(w, 1, ds.width - x);
    h = clamp(h, 1, ds.height - y);
    el.roiHint.className = 'hint';
    el.roiHint.textContent = '';
    return { x, y, width: w, height: h };
  }

  function resetRoiToDefault() {
    if (!state.layer) return;
    const ds = state.reader.displaySize(state.layer);
    const side = Math.min(256, ds.width, ds.height);
    state.roi = {
      x: Math.max(0, Math.floor((ds.width - side) / 2)),
      y: Math.max(0, Math.floor((ds.height - side) / 2)),
      width: side,
      height: side
    };
    setRoiInputs();
    renderRoiBox();
  }

  function useMaxRoi() {
    if (!state.layer) return;
    const ds = state.reader.displaySize(state.layer);
    const w = Math.min(1024, ds.width);
    const h = Math.min(1024, ds.height);
    state.roi = {
      x: Math.max(0, Math.min(state.roi.x, ds.width - w)),
      y: Math.max(0, Math.min(state.roi.y, ds.height - h)),
      width: w, height: h
    };
    setRoiInputs();
    renderRoiBox();
    el.roiHint.className = 'hint';
    el.roiHint.textContent = '已设为 ' + w + '×' + h;
  }

  // --- drag interaction -------------------------------------------------

  // 'move' = drag the existing box, 'resize' = drag a corner handle,
  // 'create' = rubber-band a brand-new box from empty space
  function beginDrag(ev, mode, handle) {
    if (!state.overview) return;
    ev.preventDefault();
    const p = eventToDisplay(ev);
    if (!p) return;
    state.drag = {
      mode, handle,
      start: p,
      current: p,
      origin: { ...state.roi },
      pointerId: ev.pointerId
    };
    el.stage.setPointerCapture(ev.pointerId);
  }

  function updateDrag(ev) {
    const d = state.drag;
    if (!d) return;
    const p = eventToDisplay(ev);
    if (!p) return;
    d.current = p;
    const ds = state.overview.displaySize;
    const o = d.origin;
    let roi;
    if (d.mode === 'move') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      roi = {
        x: clamp(o.x + dx, 0, ds.width - o.width),
        y: clamp(o.y + dy, 0, ds.height - o.height),
        width: o.width,
        height: o.height
      };
    } else if (d.mode === 'create') {
      let x0 = Math.min(d.start.x, p.x);
      let y0 = Math.min(d.start.y, p.y);
      let x1 = Math.max(d.start.x, p.x);
      let y1 = Math.max(d.start.y, p.y);
      if (x1 - x0 < 1) x1 = Math.min(ds.width, x0 + 1);
      if (y1 - y0 < 1) y1 = Math.min(ds.height, y0 + 1);
      roi = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    } else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.width, y1 = o.y + o.height;
      const h = d.handle;
      if (h.includes('w')) x0 = clamp(p.x, 0, x1 - 1);
      if (h.includes('e')) x1 = clamp(p.x, x0 + 1, ds.width);
      if (h.includes('n')) y0 = clamp(p.y, 0, y1 - 1);
      if (h.includes('s')) y1 = clamp(p.y, y0 + 1, ds.height);
      roi = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    if (roi.width > 1024) roi.width = 1024;
    if (roi.height > 1024) roi.height = 1024;
    roi.x = clamp(roi.x, 0, ds.width - roi.width);
    roi.y = clamp(roi.y, 0, ds.height - roi.height);
    state.roi = roi;
    setRoiInputs();
    renderRoiBox();
  }

  function endDrag(ev) {
    if (!state.drag) return;
    const d = state.drag;
    state.drag = null;
    try { el.stage.releasePointerCapture(d.pointerId); } catch (_) { /* ignore */ }
    void ev;
    readRoiRegion();
  }

  // --- ROI read ---------------------------------------------------------

  async function readRoiRegion() {
    const reader = state.reader;
    const dir = state.layer;
    if (!reader || !dir) return;
    const roi = readRoiInputs();
    if (!roi) return;
    state.roi = roi;
    setRoiInputs();
    renderRoiBox();
    const token = ++state.roiToken;
    el.roiApply.disabled = true;
    el.roiApply.textContent = '读取中…';
    try {
      const res = await reader.readRoi(dir, roi);
      if (token !== state.roiToken) return;
      state.roiResult = res;
      paintRoiPatch(res);
      paintRoiCanvas(res);
      renderTileList(res);
      updateStats(res, true);
      renderIssues();
      renderPixelInfo(null);
      refreshExportButtons();
      el.roiHint.className = 'hint';
      el.roiHint.textContent = '命中 ' + res.hitTiles.length + ' 块 · 新解压 ' + res.decodes +
        ' · 缓存命中 ' + res.cacheHits;
    } catch (err) {
      if (token === state.roiToken) {
        el.roiHint.className = 'hint error';
        el.roiHint.textContent = err.message;
      }
    } finally {
      if (token === state.roiToken) {
        el.roiApply.disabled = false;
        el.roiApply.textContent = '读取裁区';
      }
    }
  }

  // --- results rendering ------------------------------------------------

  function paintRoiCanvas(res) {
    const canvas = el.roiCanvas;
    // composite the decoded pixels over a checkerboard so missing pixels read
    // as "no data" rather than black
    const comp = document.createElement('canvas');
    comp.width = res.width;
    comp.height = res.height;
    const cctx = comp.getContext('2d');
    const checker = cctx.createImageData(res.width, res.height);
    for (let i = 0; i < res.width * res.height; i++) {
      const x = i % res.width, y = (i / res.width) | 0;
      const v = ((x >> 2) + (y >> 2)) % 2 === 0 ? 42 : 30;
      checker.data[i * 4] = v;
      checker.data[i * 4 + 1] = v + 3;
      checker.data[i * 4 + 2] = v + 8;
      checker.data[i * 4 + 3] = 255;
    }
    cctx.putImageData(checker, 0, 0);
    const patch = document.createElement('canvas');
    patch.width = res.width;
    patch.height = res.height;
    patch.getContext('2d').putImageData(
      new ImageData(rgbFromRgba(res.rgba, res.width, res.height), res.width, res.height), 0, 0
    );
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(patch, 0, 0);

    canvas.width = res.width;
    canvas.height = res.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, res.width, res.height);
    ctx.drawImage(comp, 0, 0);
    // scale to fit the pane, but keep pixels crisp
    const wrap = canvas.parentElement;
    const availW = Math.max(40, wrap.clientWidth - 2);
    const availH = 298;
    const scale = Math.min(availW / res.width, availH / res.height, 24);
    canvas.style.width = Math.max(1, Math.round(res.width * scale)) + 'px';
    canvas.style.height = Math.max(1, Math.round(res.height * scale)) + 'px';
    state.roiViewScale = scale;
    el.roiViewEmpty.hidden = true;
  }

  function clearRoiCanvas() {
    const canvas = el.roiCanvas;
    canvas.width = 1;
    canvas.height = 1;
    canvas.style.width = '0px';
    canvas.style.height = '0px';
    el.roiViewEmpty.hidden = false;
    state.roiViewScale = 0;
  }

  function clearResults() {
    el.pixelRows.innerHTML = '<tr><td colspan="4" class="muted">把光标移到裁区上</td></tr>';
    el.pixelTiles.innerHTML = '';
    el.cursorPos.textContent = '—';
    el.tileList.innerHTML = '<p class="muted">读取裁区后列出</p>';
    el.tileSummary.textContent = '—';
    el.issues.innerHTML = '';
    clearRoiCanvas();
    for (const k of ['statDecodes', 'statTotalDecodes', 'statReads']) el[k].textContent = '0';
    el.statCache.textContent = '0 / ' + CACHE_LIMIT;
    el.statBytes.textContent = '0 B';
    el.statMeta.textContent = '0 B';
  }

  function updateStats(res, fromRoi) {
    const reader = state.reader;
    if (!reader) return;
    const s = reader.stats;
    if (fromRoi && res) {
      el.statDecodes.textContent = fmtInt(res.decodes);
      el.statBytes.textContent = fmtBytes(s.tileBytes);
      el.statMeta.textContent = fmtBytes(s.metaBytes);
      el.statTotalDecodes.textContent = fmtInt(s.decodes);
      el.statReads.textContent = fmtInt(s.reads);
    } else {
      el.statBytes.textContent = fmtBytes(s.tileBytes);
      el.statMeta.textContent = fmtBytes(s.metaBytes);
      el.statTotalDecodes.textContent = fmtInt(s.decodes);
      el.statReads.textContent = fmtInt(s.reads);
    }
    el.statCache.textContent = s.cached + ' / ' + CACHE_LIMIT;
  }

  function renderTileList(res) {
    const groups = { missing: [], bad: [], ok: [] };
    for (const t of res.tileDetails) {
      if (t.status === STATUS.MISSING) groups.missing.push(t);
      else if (t.status === STATUS.PRESENT) groups.ok.push(t);
      else groups.bad.push(t);
    }
    const total = res.tileDetails.length;
    const badCount = groups.missing.length + groups.bad.length;
    el.tileSummary.textContent = total + ' 块' + (badCount ? ' · ' + badCount + ' 异常' : '');
    el.tileSummary.className = 'pill ' + (badCount ? 'pill-bad' : 'pill-ok');
    if (!total) {
      el.tileList.innerHTML = '<p class="tile-empty">该裁区没有命中任何图块</p>';
      return;
    }
    const order = [...groups.missing, ...groups.bad, ...groups.ok];
    el.tileList.innerHTML = order.map((t) => {
      const cls = t.status === STATUS.MISSING ? 'missing' : t.status === STATUS.PRESENT ? '' : 'bad';
      const chan = t.channel == null ? '' : ' · 通道 ' + t.channel;
      const err = t.error && !t.ok
        ? '<span class="tile-err">' + escapeHtml(t.error) + '</span>'
        : '';
      return '<div class="tile-row ' + cls + '">' +
        '<span class="tile-num">#' + t.index + '</span>' +
        '<span class="tile-desc">' +
          '<span class="tile-pos">块行 ' + t.tileRow + ' · 块列 ' + t.tileCol + chan +
            ' · ' + escapeHtml(t.statusLabel) + '</span>' + err +
        '</span>' +
        '<span class="tile-bytes">' + (t.byteCount ? fmtBytes(t.byteCount) : '—') +
          '<br>@ ' + (t.offset || '—') + '</span>' +
      '</div>';
    }).join('');
  }

  function renderIssues() {
    const reader = state.reader;
    if (!reader) return;
    const res = state.roiResult;
    const items = [];
    for (const e of reader.errors) {
      if (e.scope === 'directory') {
        items.push({ bad: true, html: escapeHtml(e.message) });
      }
    }
    if (res) {
      if (res.missingTiles.length) {
        items.push({ bad: false, html: '缺块（偏移与字节数均为 0）：块 ' +
          res.missingTiles.slice(0, 12).map((i) => '<code>#' + i + '</code>').join(' ') +
          (res.missingTiles.length > 12 ? ' …共 ' + res.missingTiles.length + ' 块' : '') });
      }
      if (res.corruptTiles.length) {
        items.push({ bad: true, html: '损坏块（解压/长度校验失败）：' +
          res.corruptTiles.slice(0, 12).map((i) => '<code>#' + i + '</code>').join(' ') +
          (res.corruptTiles.length > 12 ? ' …共 ' + res.corruptTiles.length + ' 块' : '') });
      }
      if (res.oobTiles.length) {
        items.push({ bad: true, html: '偏移越界块：' +
          res.oobTiles.slice(0, 12).map((i) => '<code>#' + i + '</code>').join(' ') +
          (res.oobTiles.length > 12 ? ' …共 ' + res.oobTiles.length + ' 块' : '') });
      }
      if (res.invalidTiles.length) {
        items.push({ bad: true, html: '偏移/字节数单项为 0 的块：' +
          res.invalidTiles.slice(0, 12).map((i) => '<code>#' + i + '</code>').join(' ') +
          (res.invalidTiles.length > 12 ? ' …共 ' + res.invalidTiles.length + ' 块' : '') });
      }
      const missingPixels = res.mask.length - res.mask.reduce((a, b) => a + b, 0);
      if (missingPixels > 0) {
        items.push({ bad: false, html: '裁区中 ' + missingPixels + ' / ' + res.mask.length +
          ' 个像素因缺任一通道被置零（有效掩膜为 0）' });
      }
    }
    el.issues.innerHTML = items.map((i) =>
      '<div class="issue' + (i.bad ? ' bad' : '') + '">' + i.html + '</div>').join('');
  }

  function renderPixelInfo(pix) {
    if (!pix) {
      el.pixelRows.innerHTML = '<tr><td colspan="4" class="muted">把光标移到裁区上</td></tr>';
      el.pixelTiles.innerHTML = '';
      el.cursorPos.textContent = '—';
      return;
    }
    el.cursorPos.textContent = '显示 ' + pix.display.x + ',' + pix.display.y +
      ' → 存储 ' + pix.storage.x + ',' + pix.storage.y;
    const names = pix.channels.length === 1
      ? ['灰度']
      : ['R', 'G', 'B'].slice(0, pix.channels.length);
    el.pixelRows.innerHTML = pix.channels.map((v, c) => {
      const missing = v === null || v === undefined;
      const byte = missing ? 0 : window.TiffRoi.toByte(v);
      return '<tr>' +
        '<td class="chan">' + names[c] + '</td>' +
        '<td class="val' + (missing ? ' missing' : '') + '">' +
          (missing ? '缺失' : fmtInt(v)) + '</td>' +
        '<td><span class="swatch" style="background:rgb(' + byte + ',' + byte + ',' + byte + ')"></span></td>' +
        '<td>' + (missing ? escapeHtml(pix.tiles[c] ? pix.tiles[c].label : '缺块') : '已读取') + '</td>' +
      '</tr>';
    }).join('');
    el.pixelTiles.innerHTML = pix.tiles.map((t) =>
      '<span class="tile-chip ' + (t.status === STATUS.PRESENT ? '' : t.status === STATUS.MISSING ? 'missing' : 'bad') + '">' +
        '块 <span class="idx">#' + t.index + '</span>' +
        (t.channel != null ? ' · 通道 ' + t.channel : '') +
        ' · ' + escapeHtml(t.label) +
        ' · @' + t.offset + ' / ' + t.byteCount + ' B' +
      '</span>').join('');
  }

  // --- pixel probing ----------------------------------------------------

  function renderRoiPixel(res, ox, oy) {
    if (!res) return;
    if (ox < 0 || oy < 0 || ox >= res.width || oy >= res.height) {
      renderPixelInfo(null);
      return;
    }
    const sp = state.reader.displayToStorage(res.dir, res.roi.x + ox, res.roi.y + oy);
    const nch = res.channels;
    const base = (oy * res.width + ox) * nch;
    const channels = [];
    const tiles = [];
    const tw = res.dir.tileWidth, th = res.dir.tileLength;
    const tc = Math.floor(sp.x / tw);
    const tr = Math.floor(sp.y / th);
    for (let c = 0; c < nch; c++) {
      const v = res.raw[base + c];
      channels.push(v < 0 ? null : v);
      const idx = res.dir.planar === 2
        ? state.reader.tileIndex(res.dir, c, tr, tc)
        : state.reader.tileIndex(res.dir, 0, tr, tc);
      const detail = res.tileDetails.find((t) => t.index === idx);
      tiles.push({
        index: idx,
        channel: res.dir.planar === 2 ? c : null,
        status: detail ? detail.status : STATUS.MISSING,
        label: detail ? detail.statusLabel : '缺块',
        offset: detail ? detail.offset : 0,
        byteCount: detail ? detail.byteCount : 0
      });
    }
    renderPixelInfo({
      display: { x: res.roi.x + ox, y: res.roi.y + oy },
      storage: sp,
      channels,
      tiles
    });
  }

  function roiCanvasPixel(ev) {
    const res = state.roiResult;
    if (!res || !state.roiViewScale) return null;
    const rect = el.roiCanvas.getBoundingClientRect();
    const ox = Math.floor((ev.clientX - rect.left) / state.roiViewScale);
    const oy = Math.floor((ev.clientY - rect.top) / state.roiViewScale);
    if (ox < 0 || oy < 0 || ox >= res.width || oy >= res.height) return null;
    return { ox, oy };
  }

  async function probePixel(ev) {
    const reader = state.reader;
    const dir = state.layer;
    if (!reader || !dir || !state.overview) return;
    const p = eventToDisplay(ev);
    if (!p) return;
    const ds = state.overview.displaySize;
    if (p.x >= ds.width || p.y >= ds.height) {
      renderPixelInfo(null);
      return;
    }
    const token = ++state.pixelToken;
    try {
      const pix = await reader.pixelAt(dir, p.x, p.y);
      if (token !== state.pixelToken) return;
      renderPixelInfo(pix);
      updateStats(null, false);
    } catch (_) {
      if (token === state.pixelToken) renderPixelInfo(null);
    }
  }

  // --- exports ----------------------------------------------------------

  function refreshExportButtons() {
    const ok = !!state.roiResult;
    el.exportPng.disabled = !ok;
    el.exportMask.disabled = !ok;
  }

  function download(name, bytes) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function baseName() {
    let name = el.sampleSelect.dataset.file || 'roi';
    name = name.replace(/\.(tif|tiff)$/i, '');
    return name;
  }

  function exportRoiPng() {
    const res = state.roiResult;
    if (!res) return;
    if (res.samplesPerPixel === 1) {
      download(baseName() + '_roi16.png',
        Png.encodeGray16(res.values, res.width, res.height));
      return;
    }
    // RGB: always emit three channels, replicating a single available one
    const n = res.width * res.height;
    const rgb = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) {
      const base = i * res.channels;
      if (res.channels === 1) {
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = res.values[base];
      } else {
        rgb[i * 3] = res.values[base];
        rgb[i * 3 + 1] = res.values[base + 1] || 0;
        rgb[i * 3 + 2] = res.channels > 2 ? res.values[base + 2] : 0;
      }
    }
    download(baseName() + '_roi16.png', Png.encodeRgb16(rgb, res.width, res.height, 3));
  }

  function exportMaskPng() {
    const res = state.roiResult;
    if (!res) return;
    const bytes = Png.encodeMask(res.mask, res.width, res.height);
    download(baseName() + '_mask.png', bytes);
  }

  // --- directory detail / audit ----------------------------------------

  function renderDirDetail() {
    const reader = state.reader;
    if (!reader) return;
    const cards = reader.directories.map((dir) => {
      const ds = reader.displaySize(dir);
      const lines = [];
      lines.push(['类型', dir.kind === 'sub' ? 'SubIFD #' + dir.subIndex : 'IFD #' + dir.chainIndex]);
      lines.push(['偏移', dir.offset]);
      lines.push(['存储尺寸', dir.width + ' × ' + dir.height]);
      lines.push(['显示尺寸', ds.width + ' × ' + ds.height]);
      lines.push(['方向', dir.orientation]);
      lines.push(['图块', dir.tileWidth + ' × ' + dir.tileLength]);
      lines.push(['通道', dir.spp + ' × ' + dir.bits + ' 位']);
      lines.push(['布局', dir.planar === 2 ? '分平面' : '交错']);
      lines.push(['压缩', dir.compression === 8 ? 'Deflate' : dir.compression === 1 ? '无压缩' : String(dir.compression)]);
      lines.push(['预测器', dir.predictor]);
      let auditHtml = '';
      if (dir.isTiled) {
        const audit = reader.auditTiles(dir);
        lines.push(['块总数', fmtInt(audit.total)]);
        lines.push(['存在', fmtInt(audit.counts.present)]);
        if (audit.counts.missing) lines.push(['缺块', fmtInt(audit.counts.missing)]);
        if (audit.counts.invalid) lines.push(['单项为 0', fmtInt(audit.counts.invalid)]);
        if (audit.counts.oob) lines.push(['越界', fmtInt(audit.counts.oob)]);
        if (audit.problems.length) {
          const shown = audit.problems.slice(0, 20).map((p) =>
            '#' + p.index + ' ' + STATUS_LABEL[p.status]).join('，');
          auditHtml = '<div class="tag-list">问题块：' + escapeHtml(shown) +
            (audit.problems.length > 20 ? ' …共 ' + audit.problems.length : '') + '</div>';
        }
      }
      const tagBrief = dir.rawTags
        .filter((t) => [254, 256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 284, 317, 322, 323, 330].includes(t.tag))
        .map((t) => {
          const label = window.TiffRoi.TAG_LABEL[t.tag] || String(t.tag);
          const value = t.error
            ? '错误'
            : (t.values && t.values.length > 6
              ? t.values.slice(0, 3).join(',') + '…(' + t.values.length + ')'
              : (t.values || []).join(','));
          return label + '=' + value;
        }).join(' · ');
      return '<div class="audit-card">' +
        '<h3>' + escapeHtml(dir.kind === 'sub' ? 'SubIFD #' + dir.subIndex : 'IFD #' + dir.chainIndex) +
          ' · ' + escapeHtml(dir.isTiled ? '图块' : '不可用') + '</h3>' +
        lines.map(([k, v]) =>
          '<div class="audit-kv"><span>' + escapeHtml(k) + '</span><b>' + escapeHtml(String(v)) + '</b></div>').join('') +
        (dir.problems.length
          ? '<div class="tag-list" style="color:var(--warn)">' +
            escapeHtml(dir.problems.join('；')) + '</div>' : '') +
        auditHtml +
        '<div class="tag-list">' + escapeHtml(tagBrief) + '</div>' +
      '</div>';
    });
    const errs = reader.errors.map((e) =>
      '<div class="issue bad" style="margin-top:8px">' + escapeHtml(e.message) + '</div>').join('');
    el.dirDetailBody.innerHTML = '<div class="audit-grid">' + cards.join('') + '</div>' + errs;
  }

  // --- events -----------------------------------------------------------

  let probeTimer = 0;
  let lastProbeEvent = null;
  function scheduleProbe(ev) {
    lastProbeEvent = ev;
    if (probeTimer) return;
    probeTimer = setTimeout(() => {
      probeTimer = 0;
      if (lastProbeEvent) probePixel(lastProbeEvent);
    }, 40);
  }

  el.stage.addEventListener('pointerdown', (ev) => {
    if (!state.overview || ev.button !== 0) return;
    const handle = ev.target.closest('.roi-handle');
    if (handle) beginDrag(ev, 'resize', handle.dataset.handle);
    else if (ev.target.closest('.roi-box')) beginDrag(ev, 'move', null);
    else beginDrag(ev, 'create', null);
  });
  el.stage.addEventListener('pointermove', (ev) => {
    if (state.drag) { updateDrag(ev); return; }
    scheduleProbe(ev);
  });
  el.stage.addEventListener('pointerup', (ev) => endDrag(ev));
  el.stage.addEventListener('pointercancel', (ev) => endDrag(ev));
  el.stage.addEventListener('pointerleave', () => {
    if (!state.drag) renderPixelInfo(null);
  });
  el.stage.addEventListener('wheel', (ev) => {
    if (!state.overview || !state.layer) return;
    ev.preventDefault();
    const focus = eventToDisplay(ev);
    zoomBy(ev.deltaY < 0 ? 1.6 : 1 / 1.6, focus);
  }, { passive: false });
  el.stage.addEventListener('keydown', (ev) => {
    if (!state.overview || !state.layer) return;
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomBy(1.6, null); }
    else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomBy(1 / 1.6, null); }
    else if (ev.key === '0') { ev.preventDefault(); resetViewport(); }
    else if (ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      const ov = state.overview;
      const cur = state.viewport || { x: 0, y: 0, width: ov.displaySize.width, height: ov.displaySize.height };
      const amount = Math.max(1, Math.round(Math.min(cur.width, cur.height) / 6));
      const dx = ev.key === 'ArrowLeft' ? -amount : ev.key === 'ArrowRight' ? amount : 0;
      const dy = ev.key === 'ArrowUp' ? -amount : ev.key === 'ArrowDown' ? amount : 0;
      setViewport({ x: cur.x + dx, y: cur.y + dy, width: cur.width, height: cur.height });
    }
  });

  el.roiCanvas.addEventListener('pointermove', (ev) => {
    const cell = roiCanvasPixel(ev);
    if (cell) renderRoiPixel(state.roiResult, cell.ox, cell.oy);
  });
  el.roiCanvas.addEventListener('pointerleave', () => renderPixelInfo(null));
  el.roiCanvas.addEventListener('pointerdown', (ev) => {
    const res = state.roiResult;
    const cell = roiCanvasPixel(ev);
    if (!res || !cell) return;
    // jump the ROI to centre on the clicked pixel, same size
    const ds = state.reader.displaySize(res.dir);
    const cx = res.roi.x + cell.ox;
    const cy = res.roi.y + cell.oy;
    state.roi = {
      x: clamp(cx - Math.floor(res.width / 2), 0, Math.max(0, ds.width - res.width)),
      y: clamp(cy - Math.floor(res.height / 2), 0, Math.max(0, ds.height - res.height)),
      width: res.width, height: res.height
    };
    setRoiInputs();
    renderRoiBox();
    readRoiRegion();
  });

  el.roiApply.addEventListener('click', readRoiRegion);
  el.roiMax.addEventListener('click', useMaxRoi);
  el.roiReset.addEventListener('click', () => {
    resetRoiToDefault();
    readRoiRegion();
  });
  for (const input of [el.roiX, el.roiY, el.roiW, el.roiH]) {
    input.addEventListener('change', () => {
      const roi = readRoiInputs();
      if (!roi) return;
      state.roi = roi;
      setRoiInputs();
      renderRoiBox();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); readRoiRegion(); }
    });
  }

  el.zoomIn.addEventListener('click', () => zoomBy(1.6, null));
  el.zoomOut.addEventListener('click', () => zoomBy(1 / 1.6, null));
  el.zoomFit.addEventListener('click', resetViewport);
  el.roiView.addEventListener('click', zoomToRoi);
  el.exportPng.addEventListener('click', exportRoiPng);
  el.exportMask.addEventListener('click', exportMaskPng);

  el.sampleBtn.addEventListener('click', async () => {
    if (!window.SAMPLE_ZIP_BASE64) {
      showBanner(['页面内没有内嵌样例，请使用「打开 TIFF / ZIP」'], 'error');
      return;
    }
    try {
      const bytes = base64ToBytes(window.SAMPLE_ZIP_BASE64);
      await mountZip(new Blob([bytes], { type: 'application/zip' }), 'sparse-tiff-roi-cases.zip');
    } catch (err) {
      showBanner(['样例载入失败：' + escapeHtml(err.message)], 'error');
    }
  });

  el.sampleSelect.addEventListener('change', () => {
    openEntry(el.sampleSelect.value);
  });

  el.fileInput.addEventListener('change', async () => {
    const files = [...el.fileInput.files];
    el.fileInput.value = '';
    if (!files.length) return;
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    const tiff = files.find((f) => isTiffName(f.name));
    if (zip) {
      try { await mountZip(zip, zip.name); }
      catch (err) { showBanner(['ZIP 读取失败：' + escapeHtml(err.message)], 'error'); }
    } else if (tiff) {
      zipEntries = null;
      el.sampleSelect.hidden = true;
      await openBlob(tiff, tiff.name);
    } else {
      showBanner(['请选择 .tif / .tiff 或 .zip 文件'], 'error');
    }
  });

  window.addEventListener('resize', () => {
    if (state.overview) {
      fitCanvas(el.canvas, state.overview.width, state.overview.height);
      renderRoiBox();
    }
  });

  // expose a tiny hook for automated tests
  window.__roiApp = {
    state,
    openBuffer,
    mountZip,
    readRoiRegion,
    selectLayer,
    loadOverview,
    refreshExportButtons
  };
})();
