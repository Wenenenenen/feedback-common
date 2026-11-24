/*
 * 页面主逻辑：导入、即时重算、冲突回退、三联动视图、像素检视、导出。
 */
(function () {
  'use strict';

  const T = window.SAPTrack;
  const Q = window.SAPQp;
  const F = window.SAPFit;
  const C = window.SAPCrop;
  const PNM = window.SAPPnm;
  const ZIP = window.SAPZip;

  const $ = (id) => document.getElementById(id);
  const els = {};
  const elIds = [
    'topChips', 'chipFrames', 'chipShots', 'chipCrop', 'statusPill', 'statusText',
    'recomputeBtn', 'exportBtn', 'banner', 'dsAside', 'loadSampleBtn', 'importBtn', 'zipInput',
    'dsGrid', 'dsSize', 'dsFrames', 'dsPixels', 'dsShots', 'dsThreshold', 'dsCuts', 'dsNote',
    'fitAside', 'cropW', 'cropH', 'cropHint', 'marginRange', 'marginVal', 'marginNum',
    'boundHint', 'lambdaRange', 'lambdaVal', 'lambdaNum', 'lambdaPresets',
    'pinList', 'pinCount', 'addPinBtn', 'clearPinsBtn', 'fitBtn', 'resetBtn',
    'shotAside', 'shotTable', 'jsonAside', 'jsonPreview',
    'rawPanel', 'rawMeta', 'rawWrap', 'rawCanvas', 'rawHint',
    'cropPanel', 'cropMeta', 'cropWrap', 'cropCanvas', 'cropHint', 'cropSizeTag',
    'chartCard', 'chartMeta', 'chartShell', 'trajChart', 'chartTip',
    'prevBtn', 'frameRange', 'nextBtn', 'frameLabel', 'frameTotal', 'playBtn', 'inspectToggle',
    'inspState', 'inspKv', 'inspOut', 'inspSrc', 'inspWeights', 'inspPoint', 'inspRgb', 'inspCanvas',
    'toast', 'liveRegion',
  ];
  for (const id of elIds) els[id] = $(id);

  const state = {
    dataset: null,        // {manifest, frames:[{width,height,data}], tracking, name, W, H, totalPixels}
    result: null,         // 上次成功的 fit 结果（含 ux, uy）
    stale: false,         // 当前参数不可行，显示上次结果
    lastErrors: [],
    pending: null,        // 上次成功时的参数
    frame: 0,
    axis: 'x',
    playing: false,
    playTimer: null,
    theme: null,
    chartCache: null,
    cropCache: null,      // {frame, ux, uy, cropW, cropH, data}
    inspHover: null,
    loadToken: 0,
  };

  /* ------------------------------------------------------------ helpers */

  function fmt(n, d = 2) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(d);
  }
  function fmtSigned(n, d = 2) {
    if (!Number.isFinite(n)) return '—';
    const s = n.toFixed(d);
    return (n >= 0 ? '+' : '') + s;
  }
  function fmtInt(n) {
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
  }
  function announce(msg) {
    els.liveRegion.textContent = '';
    setTimeout(() => { els.liveRegion.textContent = msg; }, 30);
  }
  let toastTimer = null;
  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = `toast show${kind === 'err' ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 3200);
  }
  function setStatus(kind, text) {
    els.statusPill.dataset.state = kind;
    els.statusText.textContent = text;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(v, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ------------------------------------------------------------ theme */

  function applyTheme(mode) {
    state.theme = mode;
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    for (const b of document.querySelectorAll('.theme button')) {
      b.setAttribute('aria-pressed', String(b.dataset.t === mode));
    }
    try { localStorage.setItem('sap-theme', mode); } catch { /* ignore */ }
    // 主题变化后图表要重绘
    state.chartCache = null;
    if (state.dataset) {
      drawChart();
      renderFrame();
    }
  }
  for (const b of document.querySelectorAll('.theme button')) {
    b.addEventListener('click', () => applyTheme(b.dataset.t));
  }
  try {
    const saved = localStorage.getItem('sap-theme');
    if (saved) applyTheme(saved);
  } catch { /* ignore */ }

  /* ------------------------------------------------------------ data load */

  function datasetFrom(manifestRaw, frames, name) {
    const frameSizes = frames.map((f) => ({ width: f.width, height: f.height }));
    const parsed = T.parseManifest(manifestRaw, frameSizes);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const m = parsed.manifest;
    const totalPixels = m.width * m.height * m.frameCount;
    const tracking = T.track(m);
    return {
      ok: true,
      dataset: {
        manifest: m, frames, tracking, name,
        W: m.width, H: m.height, totalPixels,
      },
    };
  }

  async function loadFromZipBuffer(buf, name) {
    try {
      const files = await ZIP.unzip(buf);
      let manifestKey = null;
      // manifest 在根或任意目录，优先根
      if (files.has('manifest.json')) manifestKey = 'manifest.json';
      else {
        for (const k of files.keys()) if (k.endsWith('/manifest.json')) { manifestKey = k; break; }
      }
      if (!manifestKey) {
        const anyJson = [...files.keys()].find((k) => k.endsWith('.json') && !k.includes('/frames/'));
        if (anyJson) manifestKey = anyJson;
      }
      if (!manifestKey) throw new Error('ZIP 中没有 manifest.json');
      const manifest = JSON.parse(new TextDecoder().decode(files.get(manifestKey)));
      if (!manifest || !Array.isArray(manifest.frames)) throw new Error('manifest.frames 缺失');
      const prefix = manifestKey.includes('/') ? manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1) : '';
      const frames = [];
      for (let i = 0; i < manifest.frames.length; i++) {
        const raw = String(manifest.frames[i]);
        const key = files.has(prefix + raw) ? prefix + raw : (files.has(raw) ? raw : null);
        if (!key) throw new Error(`缺少帧 ${raw}`);
        let dec;
        try { dec = PNM.decodePnm(files.get(key)); } catch (e) {
          throw new Error(`帧 ${raw}：${e.message}`);
        }
        frames.push(dec);
      }
      const ds = datasetFrom(manifest, frames, name || 'imported.zip');
      if (!ds.ok) throw new Error(ds.errors.map((e) => `${e.path}: ${e.message}`).join('；'));
      return ds.dataset;
    } catch (err) {
      return { error: err.message };
    }
  }

  function greetDataset(ds) {
    state.dataset = ds;
    state.frame = 0;
    state.stale = false;
    state.result = null;
    state.pending = null;
    state.cropCache = null;
    els.banner.className = 'banner';
    els.banner.innerHTML = '';
    updateDatasetSummary();
    syncParamInputsFromManifest();
    renderPinList();
    els.frameRange.max = String(ds.manifest.frameCount - 1);
    els.frameTotal.textContent = String(ds.manifest.frameCount);
    els.frameRange.value = '0';
    els.recomputeBtn.disabled = false;
    els.exportBtn.disabled = true;
    runFit({ initial: true, announce: true });
  }

  function updateDatasetSummary() {
    const ds = state.dataset;
    if (!ds) {
      els.dsAside.textContent = '未载入';
      els.dsSize.textContent = els.dsFrames.textContent = els.dsPixels.textContent = '—';
      els.dsShots.textContent = els.dsThreshold.textContent = els.dsCuts.textContent = '—';
      els.chipFrames.textContent = els.chipShots.textContent = els.chipCrop.textContent = '—';
      return;
    }
    const m = ds.manifest;
    els.dsAside.textContent = ds.name;
    els.dsSize.textContent = `${ds.W}×${ds.H}`;
    els.dsFrames.textContent = String(m.frameCount);
    els.dsPixels.textContent = `${(ds.totalPixels / 1e6).toFixed(2)} M`;
    els.dsShots.textContent = String(ds.tracking.shots.length);
    els.dsThreshold.textContent = fmt(m.threshold, 3);
    const cutCount = m.cuts.length;
    const weak = Array.from(ds.tracking.weakFlags).filter(Boolean).length;
    els.dsCuts.textContent = `${cutCount} / ${weak}`;
    els.chipFrames.textContent = String(m.frameCount);
    els.chipShots.textContent = String(ds.tracking.shots.length);
    els.chipCrop.textContent = `${m.cropW}×${m.cropH}`;
    els.cropHint.textContent = `上限 ${ds.W} × ${ds.H}`;
    const mR = els.marginRange;
    mR.max = String(Math.max(0, Math.floor(Math.max(ds.W, ds.H) / 2)));
    els.dsNote.textContent = `已载入 ${ds.name}；首帧尺寸 ${ds.W}×${ds.H}，累计 ${(ds.totalPixels / 1e6).toFixed(2)} M 像素。`;
  }

  function syncParamInputsFromManifest() {
    const m = state.dataset.manifest;
    els.cropW.value = String(m.cropW);
    els.cropH.value = String(m.cropH);
    els.marginRange.value = els.marginNum.value = String(m.margin);
    els.lambdaRange.value = els.lambdaNum.value = String(m.lambda);
    syncRangeFills();
    state.pins = m.pins.map((p) => ({ frame: p.frame, x: p.x, y: p.y }));
    renderPinList();
  }

  /* ------------------------------------------------------------ params */

  function currentParams() {
    const ds = state.dataset;
    const cropW = clampInt(els.cropW.value, 1, ds ? ds.W : 1e6);
    const cropH = clampInt(els.cropH.value, 1, ds ? ds.H : 1e6);
    const margin = Math.max(0, Math.round(Number(els.marginNum.value) || 0));
    const rawLambda = Number(els.lambdaNum.value);
    const lambda = Number.isFinite(rawLambda) ? Math.max(0, Math.min(10000, rawLambda)) : 25;
    return { cropW, cropH, margin, lambda, pins: state.pins.map((p) => ({ ...p })) };
  }

  function clampInt(v, lo, hi) {
    let n = Math.round(Number(v));
    if (!Number.isFinite(n)) n = lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function paramSignature(p) {
    return JSON.stringify({
      cropW: p.cropW, cropH: p.cropH, margin: p.margin, lambda: p.lambda,
      pins: p.pins.map((q) => [q.frame, +q.x.toFixed(9), +q.y.toFixed(9)]).sort((a, b) => a[0] - b[0]),
    });
  }

  function syncParamInputsFromParams(p) {
    els.cropW.value = String(p.cropW);
    els.cropH.value = String(p.cropH);
    els.marginRange.value = els.marginNum.value = String(p.margin);
    els.lambdaRange.value = els.lambdaNum.value = String(p.lambda);
    state.pins = p.pins.map((q) => ({ ...q }));
    syncRangeFills();
    renderPinList();
  }

  function syncRangeFills() {
    for (const r of [els.marginRange, els.lambdaRange]) {
      const min = Number(r.min);
      const max = Number(r.max);
      const v = Number(r.value);
      const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
      r.style.setProperty('--fill', `${pct}%`);
    }
    els.marginVal.textContent = `当前 ${els.marginNum.value}`;
    els.lambdaVal.textContent = `当前 ${els.lambdaNum.value}`;
    for (const b of els.lambdaPresets.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.lambda) === Number(els.lambdaNum.value)));
    }
  }

  /* ------------------------------------------------------------ fit */

  let fitTimer = null;
  let fitQueued = false;

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => runFit({ announce: true }), 90);
  }

  function runFit({ initial = false, announce: doAnnounce = false } = {}) {
    const ds = state.dataset;
    if (!ds) return;
    const params = currentParams();
    const t0 = performance.now();
    const res = F.fit(ds.tracking, ds.W, ds.H, params);
    const ms = performance.now() - t0;

    if (!res.ok) {
      // 保留上次成功结果
      state.stale = true;
      state.lastErrors = res.errors;
      state.lastBounds = { boundX: res.boundX, boundY: res.boundY };
      showConflict(res, params);
      markInvalid(true);
      if (!state.result) {
        setStatus('stale', '参数冲突 · 尚无结果');
      } else {
        setStatus('stale', '参数冲突 · 显示上次结果');
      }
      els.exportBtn.disabled = !state.result;
      renderAll();
      if (doAnnounce) announce(`参数不可行：${res.errors[0].message}`);
      return;
    }

    state.result = res;
    state.pending = res.params;
    state.stale = false;
    state.lastErrors = [];
    state.lastBounds = { boundX: res.boundX, boundY: res.boundY };
    els.banner.className = 'banner';
    els.banner.innerHTML = '';
    markInvalid(false);
    setStatus('ok', initial ? '已求解' : '已更新');
    els.exportBtn.disabled = false;
    els.fitAside.textContent = `${ms.toFixed(1)} ms`;
    updateShotTable();
    updateCropMeta();
    renderAll();
    if (doAnnounce) {
      const at = res.totals.nAtBoundX + res.totals.nAtBoundY;
      announce(`已更新：${res.totals.shotCount} 个镜头，偏移范围 ±${res.totals.maxAbsX.toFixed(2)}，${at} 轴帧贴界，用时 ${ms.toFixed(0)} 毫秒`);
    }
  }

  function markInvalid(isInvalid) {
    const fields = [els.cropW, els.cropH, els.marginNum, els.marginRange, els.lambdaNum];
    for (const f of fields) f.setAttribute('aria-invalid', String(!!isInvalid && state.lastErrors.length > 0));
    for (const panel of [els.rawPanel, els.cropPanel]) panel.classList.toggle('stale', isInvalid && !!state.result);
  }

  function showConflict(res, params) {
    const errs = res.errors;
    const items = errs.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('');
    const hasLast = !!state.result;
    els.banner.innerHTML = `
      <div class="title">⚠ 参数不可行${hasLast ? ' · 预览与导出沿用上次有效结果' : ' · 尚无可显示的结果'}</div>
      <ul>${items}</ul>
      <div class="actions">
        ${hasLast ? '<button class="btn small" id="bannerRevert">恢复上次可行参数</button>' : ''}
        <button class="btn small ghost" id="bannerClamp">修正到可行</button>
      </div>`;
    els.banner.className = 'banner show';
    const revert = $('bannerRevert');
    if (revert) revert.addEventListener('click', () => {
      if (!state.pending) return;
      syncParamInputsFromParams(state.pending);
      runFit({ announce: true });
    });
    const clamp = $('bannerClamp');
    if (clamp) clamp.addEventListener('click', () => {
      applyFeasibleClamp(res, params);
      runFit({ announce: true });
    });
    // 定位首个错误字段
    const first = errs[0];
    if (first && first.path === 'margin' && first.reason === F.REASONS.NEGATIVE_BOUND) {
      els.marginNum.setAttribute('aria-invalid', 'true');
    }
    if (first && first.reason === F.REASONS.PIN_OUT_OF_RANGE) {
      const row = els.pinList.querySelector(`[data-frame="${first.frame}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function applyFeasibleClamp(res, params) {
    // 反推可行的边距上限：margin ≤ (min(W-cropW, H-cropH))/2，再检查锁点
    const ds = state.dataset;
    let margin = Math.min(
      Math.floor((ds.W - params.cropW) / 2),
      Math.floor((ds.H - params.cropH) / 2),
    );
    margin = Math.max(0, margin);
    let pins = params.pins.map((p) => ({ ...p }));
    // 逐个收紧锁点到边界内
    const bx = (ds.W - params.cropW) / 2 - margin;
    const by = (ds.H - params.cropH) / 2 - margin;
    pins = pins.map((p) => ({
      frame: p.frame,
      x: Math.max(-bx, Math.min(bx, p.x)),
      y: Math.max(-by, Math.min(by, p.y)),
    }));
    els.marginRange.value = els.marginNum.value = String(margin);
    state.pins = pins;
    syncRangeFills();
    renderPinList();
  }

  /* ------------------------------------------------------------ rendering */

  function renderAll() {
    renderFrame();
    drawChart();
    updateShotTableActive();
    updateJsonPreview();
    updateCropMeta();
  }

  function currentOffsets() {
    const r = state.result;
    const t = state.frame;
    if (!r || !r.ok) return [0, 0];
    return [r.ux[t], r.uy[t]];
  }

  function currentCropDims() {
    const r = state.result;
    if (r && r.ok) return [r.params.cropW, r.params.cropH];
    const p = currentParams();
    return [p.cropW, p.cropH];
  }

  function renderFrame() {
    const ds = state.dataset;
    if (!ds) return;
    const W = ds.W; const H = ds.H;
    const [cropW, cropH] = currentCropDims();
    const frame = ds.frames[state.frame];
    const [ux, uy] = currentOffsets();

    // 原图
    drawRaw(ds, frame, cropW, cropH, ux, uy);
    // 裁后
    drawCrop(ds, frame, cropW, cropH, ux, uy);

    els.rawMeta.textContent = `帧 ${state.frame} · ${W}×${H}`;
    els.cropMeta.textContent = `u = (${fmtSigned(ux, 3)}, ${fmtSigned(uy, 3)})`;
    els.cropSizeTag.textContent = `${cropW}×${cropH}`;
    els.frameLabel.textContent = String(state.frame);
    els.frameRange.value = String(state.frame);
    if (els.inspectToggle.checked && state.inspHover) renderInspector();
  }

  /* 把 RGB 交错数据展开成 RGBA（ImageData 的 4 字节布局）。 */
  function rgbToImageData(img, rgb, n) {
    const d = img.data;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const p = i * 4;
      d[p] = rgb[o];
      d[p + 1] = rgb[o + 1];
      d[p + 2] = rgb[o + 2];
      d[p + 3] = 255;
    }
    return img;
  }

  function drawRaw(ds, frame, cropW, cropH, ux, uy) {
    const W = ds.W; const H = ds.H;
    const box = els.rawWrap;
    const availW = Math.max(120, box.clientWidth - 24);
    const availH = Math.max(120, window.innerHeight * 0.42);
    let scale = Math.min(availW / W, availH / H);
    // 大图至少铺满宽度；小图不超过 8 倍
    if (scale > 8) scale = Math.min(scale, 8);
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    const c = els.rawCanvas;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    rgbToImageData(img, frame.data, W * H);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(off, 0, 0, W, H, 0, 0, cw, ch);

    // 叠加取样框（输出画幅在当前偏移下覆盖的源区域）
    const sx0 = (W - cropW) / 2 + ux;
    const sy0 = (H - cropH) / 2 + uy;
    const kx = cw / W; const ky = ch / H;
    ctx.lineWidth = 1.5;
    // 居中基准框（u=0）
    ctx.strokeStyle = hexToRgba(cssVar('--fg-faint') || '#6a7484', 0.75);
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(((W - cropW) / 2) * kx + 0.5, ((H - cropH) / 2) * ky + 0.5, cropW * kx - 1, cropH * ky - 1);
    // 取样框
    ctx.setLineDash([]);
    ctx.strokeStyle = cssVar('--accent-2') || '#5b95e8';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx0 * kx + 1, sy0 * ky + 1, cropW * kx - 2, cropH * ky - 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.strokeRect(sx0 * kx - 0.5, sy0 * ky - 0.5, cropW * kx + 1, cropH * ky + 1);
    els.rawHint.textContent = `取样框 x${sx0.toFixed(1)} y${sy0.toFixed(1)}`;
  }

  function drawCrop(ds, frame, cropW, cropH, ux, uy) {
    const key = `${state.frame}|${ux}|${uy}|${cropW}|${cropH}`;
    if (!state.cropCache || state.cropCache.key !== key) {
      const data = C.renderCrop(frame.data, ds.W, ds.H, cropW, cropH, ux, uy);
      state.cropCache = { key, data, cropW, cropH };
    }
    const data = state.cropCache.data;
    const box = els.cropWrap;
    const availW = Math.max(120, box.clientWidth - 24);
    const availH = Math.max(120, window.innerHeight * 0.42);
    // 适应盒子；小图最多放大 8 倍；异形画幅保证短边至少 96 CSS 像素
    let scale = Math.min(availW / cropW, availH / cropH);
    scale = Math.min(scale, 8);
    const shortSide = Math.min(cropW * scale, cropH * scale);
    if (shortSide < 96) scale = Math.min(8, Math.max(scale, 96 / Math.min(cropW, cropH)));
    scale = Math.max(0.05, Math.min(scale, availW / cropW, availH / cropH, 8));
    const cw = Math.max(1, Math.round(cropW * scale));
    const ch = Math.max(1, Math.round(cropH * scale));
    const c = els.cropCanvas;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(cropW, cropH);
    rgbToImageData(img, data, cropW * cropH);
    const off = document.createElement('canvas');
    off.width = cropW; off.height = cropH;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(off, 0, 0, cropW, cropH, 0, 0, cw, ch);
    els.cropHint.textContent = `显示 ${cw}×${ch} · 输出 ${cropW}×${cropH}`;
  }

  /* ------------------------------------------------------------ inspector */

  function setInspectorFromPointer(clientX, clientY) {
    if (!els.inspectToggle.checked || !state.dataset || !state.result) return;
    const c = els.cropCanvas;
    const rect = c.getBoundingClientRect();
    const [cropW, cropH] = currentCropDims();
    const px = (clientX - rect.left) / rect.width * cropW;
    const py = (clientY - rect.top) / rect.height * cropH;
    if (px < 0 || py < 0 || px >= cropW || py >= cropH) { state.inspHover = null; return; }
    state.inspHover = { x: Math.floor(px), y: Math.floor(py) };
    renderInspector();
  }

  function renderInspector() {
    const ds = state.dataset;
    if (!ds || !state.inspHover || !state.result) return;
    const [cropW, cropH] = currentCropDims();
    const [ux, uy] = currentOffsets();
    const { x, y } = state.inspHover;
    const frame = ds.frames[state.frame];
    const sp = C.samplePixel(frame.data, ds.W, ds.H, cropW, cropH, x, y, ux, uy);
    els.inspOut.textContent = `(${x}, ${y})`;
    els.inspSrc.textContent = `(${fmt(sp.sx, 3)}, ${fmt(sp.sy, 3)})`;
    els.inspWeights.textContent = `(${fmt(sp.fx, 3)}, ${fmt(sp.fy, 3)})`;
    els.inspPoint.textContent = `i0=(${sp.x0},${sp.y0}) f=(${fmt(sp.fx, 2)},${fmt(sp.fy, 2)})`;
    const rgb = sp.rgb;
    els.inspRgb.innerHTML = `<span class="swatch" style="background:rgb(${rgb[0]},${rgb[1]},${rgb[2]})"></span> ${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
    els.inspState.textContent = `帧 ${state.frame} · 输出 (${x}, ${y})`;
    drawZoom(frame, sp, ds.W, ds.H);
  }

  function drawZoom(frame, sp, W, H) {
    const c = els.inspCanvas;
    const ctx = c.getContext('2d');
    const N = 9;
    const cell = Math.floor(c.width / N);
    if (cell * N !== c.width) c.width = c.height = cell * N;
    const startX = sp.x0 - 4;
    const startY = sp.y0 - 4;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const sx = startX + i;
        const sy = startY + j;
        let r = 20; let g = 20; let b = 20;
        if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
          const o = (sy * W + sx) * 3;
          r = frame.data[o]; g = frame.data[o + 1]; b = frame.data[o + 2];
        }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(i * cell, j * cell, cell - 1, cell - 1);
      }
    }
    // 取样点
    const gx = (sp.sx - startX) * cell;
    const gy = (sp.sy - startY) * cell;
    ctx.strokeStyle = '#ff5544';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(gx, gy, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(gx - 9, gy); ctx.lineTo(gx - 5, gy);
    ctx.moveTo(gx + 5, gy); ctx.lineTo(gx + 9, gy);
    ctx.moveTo(gx, gy - 9); ctx.lineTo(gx, gy - 5);
    ctx.moveTo(gx, gy + 5); ctx.lineTo(gx, gy + 9);
    ctx.stroke();
  }

  /* ------------------------------------------------------------ chart */

  function chartTheme() {
    return {
      surface: cssVar('--chart-surface') || '#161a21',
      grid: cssVar('--grid') || '#262c35',
      axis: cssVar('--axis') || '#39404b',
      text: cssVar('--fg-muted') || '#98a2b3',
      textStrong: cssVar('--fg') || '#e8ebf0',
      s1: cssVar('--series-1') || '#3987e5',
      s2: cssVar('--series-2') || '#d95926',
      s3: cssVar('--series-3') || '#199e70',
      bound: cssVar('--bound') || '#6a7484',
      pin: cssVar('--pin') || '#e9a23b',
      shot: cssVar('--shot-tint') || 'rgba(91,149,232,.05)',
    };
  }

  function chartLayout() {
    const c = els.trajChart;
    const shell = els.chartShell;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const cssW = Math.max(280, shell.clientWidth);
    const cssH = 240;
    if (c.dataset.cssW !== String(cssW) || c.dataset.dpr !== String(dpr)) {
      c.style.width = px(cssW);
      c.style.height = px(cssH);
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.dataset.cssW = String(cssW);
      c.dataset.dpr = String(dpr);
      state.chartCache = null;
    }
    return { cssW, cssH, dpr, pad: { l: 52, r: 16, t: 14, b: 30 } };
  }
  function px(v) { return `${v}px`; }

  function chartSeries() {
    const ds = state.dataset;
    const r = state.result;
    if (!ds || !r) return null;
    const ax = state.axis === 'x' ? 0 : 1;
    const p = ds.tracking.p[ax];
    const u = ax === 0 ? r.ux : r.uy;
    const q = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) q[i] = p[i] - u[i];
    return { p, u, q, bound: ax === 0 ? r.boundX : r.boundY };
  }

  function drawChart() {
    const ds = state.dataset;
    const c = els.trajChart;
    if (!ds) {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      els.chartMeta.textContent = '—';
      return;
    }
    const lay = chartLayout();
    const ctx = c.getContext('2d');
    const th = chartTheme();
    ctx.setTransform(lay.dpr, 0, 0, lay.dpr, 0, 0);
    ctx.clearRect(0, 0, lay.cssW, lay.cssH);
    ctx.fillStyle = th.surface;
    ctx.fillRect(0, 0, lay.cssW, lay.cssH);

    const series = chartSeries();
    const n = ds.manifest.frameCount;
    const { pad } = lay;
    const pw = lay.cssW - pad.l - pad.r;
    const ph = lay.cssH - pad.t - pad.b;

    // y 轴范围：轨迹、偏移、残差与允许界
    let lo = Infinity; let hi = -Infinity;
    if (series) {
      for (const arr of [series.p, series.u, series.q]) {
        for (let i = 0; i < n; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
      }
      lo = Math.min(lo, -series.bound); hi = Math.max(hi, series.bound);
    } else {
      lo = -1; hi = 1;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
    const padY = (hi - lo) * 0.08;
    lo -= padY; hi += padY;
    const xOf = (t) => pad.l + (n <= 1 ? pw / 2 : (t / (n - 1)) * pw);
    const yOf = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

    // 镜头底纹
    const shots = ds.tracking.shots;
    for (const s of shots) {
      if (s.index % 2 === 1) {
        ctx.fillStyle = th.shot;
        const x0 = xOf(s.start);
        const x1 = xOf(Math.max(s.start, s.end - 1));
        ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), ph);
      }
    }

    // 网格与 y 刻度
    const ticks = niceTicks(lo, hi, 5);
    ctx.font = `11px ${cssVar('--sans') || 'system-ui'}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const tv of ticks) {
      const y = yOf(tv);
      if (y < pad.t - 1 || y > pad.t + ph + 1) continue;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(pad.l + pw, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.fillText(formatTick(tv), pad.l - 8, y);
    }
    // x 刻度
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const xt = xTicks(n);
    for (const t of xt) {
      const x = xOf(t);
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, pad.t); ctx.lineTo(Math.round(x) + 0.5, pad.t + ph); ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.fillText(String(t), x, pad.t + ph + 6);
    }
    // 基线
    ctx.strokeStyle = th.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ph + 0.5); ctx.lineTo(pad.l + pw, pad.t + ph + 0.5); ctx.stroke();

    if (!series) {
      ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `13px ${cssVar('--sans') || 'system-ui'}`;
      ctx.fillText('等待求解结果', pad.l + pw / 2, pad.t + ph / 2);
      updateChartMeta(null);
      return;
    }

    // 允许界
    for (const b of [series.bound, -series.bound]) {
      const y = yOf(b);
      if (y < pad.t || y > pad.t + ph) continue;
      ctx.strokeStyle = th.bound; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(pad.l + pw, Math.round(y) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 线段
    const drawLine = (arr, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(i); const y = yOf(arr[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    // 只在镜头内连线（切点断开）
    const drawSegmented = (arr, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const s of shots) {
        ctx.beginPath();
        let started = false;
        for (let i = s.start; i < s.end; i++) {
          const x = xOf(i); const y = yOf(arr[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };
    // 残差 q 与轨迹 p 同色系较淡；p 用 series-1，u 用 series-2，q 用 series-3
    if (n <= 400) {
      // 点数少时用细线也能看清
    }
    drawSegmented(series.p, th.s1, 2);
    drawSegmented(series.u, th.s2, 2);
    drawSegmented(series.q, th.s3, 1.5);

    // 固定帧标记
    const pins = state.result.params.pins;
    for (const p of pins) {
      const x = xOf(p.frame);
      const v = state.axis === 'x' ? p.x : p.y;
      const y = yOf(v);
      ctx.fillStyle = th.pin;
      ctx.strokeStyle = th.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // 切点/弱帧标记
    for (let t = 0; t < n; t++) {
      const isCut = ds.tracking.cutFlags[t] === 1;
      const isWeak = ds.tracking.weakFlags[t] === 1;
      if (!isCut && !isWeak) continue;
      const x = xOf(t);
      ctx.strokeStyle = isCut ? th.s2 : th.bound;
      ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, pad.t); ctx.lineTo(Math.round(x) + 0.5, pad.t + ph); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 当前帧游标
    const curX = xOf(state.frame);
    ctx.strokeStyle = th.textStrong; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(curX) + 0.5, pad.t); ctx.lineTo(Math.round(curX) + 0.5, pad.t + ph); ctx.stroke();
    ctx.globalAlpha = 1;

    // 当前帧上的点
    const pt = (arr, color) => {
      const x = xOf(state.frame); const y = yOf(arr[state.frame]);
      ctx.fillStyle = color; ctx.strokeStyle = th.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    pt(series.p, th.s1); pt(series.u, th.s2); pt(series.q, th.s3);

    state.chartCache = { lay, lo, hi, xOf, yOf, series, n };
    updateChartMeta(series);
  }

  function updateChartMeta(series) {
    const ds = state.dataset;
    const r = state.result;
    if (!ds || !r) { els.chartMeta.textContent = '—'; return; }
    const ax = state.axis === 'x' ? '横向 X' : '纵向 Y';
    const b = state.axis === 'x' ? r.boundX : r.boundY;
    els.chartMeta.textContent = `${ax} · 允许界 ±${fmt(b, 3)} · ${r.totals.shotCount} 镜头 · ${r.totals.nAtBoundX + r.totals.nAtBoundY} 轴帧贴界`;
  }

  function niceTicks(lo, hi, target) {
    const span = hi - lo;
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
    step *= mag;
    const out = [];
    const start = Math.ceil(lo / step) * step;
    for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }
  function formatTick(v) {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }
  function xTicks(n) {
    if (n <= 1) return [0];
    const target = Math.min(8, Math.max(2, Math.floor(n / 40) + 2));
    const step = Math.max(1, Math.round((n - 1) / target));
    const out = [];
    for (let t = 0; t < n; t += step) out.push(t);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }

  // 悬停
  function onChartPointer(ev) {
    const c = els.trajChart;
    const cache = state.chartCache;
    if (!cache) return;
    const rect = c.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const { pad } = cache.lay;
    const pw = cache.lay.cssW - pad.l - pad.r;
    let t = Math.round(((x - pad.l) / pw) * (cache.n - 1));
    t = Math.max(0, Math.min(cache.n - 1, t));
    const ds = state.dataset;
    if (!ds) return;
    showTip(t, ev.clientX - rect.left, ev.clientY - rect.top);
  }
  function showTip(t, x, y) {
    const cache = state.chartCache;
    const ds = state.dataset;
    const r = state.result;
    if (!cache || !ds || !r) return;
    const th = chartTheme();
    const s = cache.series;
    const tip = els.chartTip;
    const axName = state.axis === 'x' ? 'x' : 'y';
    const rows = [
      ['轨迹 p', s.p[t], th.s1],
      ['偏移 u', s.u[t], th.s2],
      ['残差 q', s.q[t], th.s3],
    ];
    tip.innerHTML = `
      <div class="tt-head">帧 ${t}${ds.tracking.cutFlags[t] ? ' · 切点' : ''}${ds.tracking.weakFlags[t] ? ' · 弱帧' : ''}</div>
      ${rows.map(([k, v, col]) => `<div class="tt-row"><span class="key" style="background:${col}"></span>${k} ${axName}<b>${fmtSigned(v, 3)}</b></div>`).join('')}
      <div class="tt-row" style="margin-top:3px;color:${th.bound}"><span class="key" style="background:${th.bound}"></span>允许界<b>±${fmt(s.bound, 3)}</b></div>`;
    const layRect = els.chartShell.getBoundingClientRect();
    const px2 = Math.max(70, Math.min(layRect.width - 70, x));
    tip.style.left = `${px2}px`;
    tip.style.top = `${Math.max(28, y - 8)}px`;
    tip.classList.add('show');
  }
  function hideTip() { els.chartTip.classList.remove('show'); }

  /* ------------------------------------------------------------ shots table */

  function updateShotTable() {
    const r = state.result;
    const tbody = els.shotTable.querySelector('tbody');
    tbody.innerHTML = '';
    if (!r || !r.ok) {
      els.shotAside.textContent = '—';
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--fg-faint)">尚无结果</td></tr>';
      return;
    }
    els.shotAside.textContent = `${r.shots.length} 个`;
    for (const s of r.shots) {
      const tr = document.createElement('tr');
      tr.dataset.shot = String(s.index);
      tr.dataset.start = String(s.start);
      tr.dataset.end = String(s.end);
      const at = s.nAtBoundX + s.nAtBoundY;
      tr.innerHTML = `<td>${s.index + 1}</td>`
        + `<td>${s.start}–${s.end - 1}</td>`
        + `<td>${s.frames}</td>`
        + `<td>${fmt(s.maxAbsX, 2)} / ${fmt(s.maxAbsY, 2)}</td>`
        + `<td>${at > 0 ? `<span class="badge warn">${at}</span>` : '<span class="badge">0</span>'}</td>`;
      tr.addEventListener('click', () => {
        setFrame(s.start);
      });
      tbody.appendChild(tr);
    }
    updateShotTableActive();
  }

  function updateShotTableActive() {
    const ds = state.dataset;
    if (!ds) return;
    const activeShot = ds.tracking.frameShot[state.frame];
    for (const tr of els.shotTable.querySelectorAll('tbody tr')) {
      tr.classList.toggle('active', Number(tr.dataset.shot) === activeShot);
    }
  }

  function updateCropMeta() {
    const r = state.result;
    if (!r || !r.ok) return;
    els.chipCrop.textContent = `${r.params.cropW}×${r.params.cropH}`;
    els.boundHint.textContent = `每轴允许范围：x ±${fmt(r.boundX, 3)} · y ±${fmt(r.boundY, 3)}`;
  }

  function updateJsonPreview() {
    const ds = state.dataset;
    if (!ds) { els.jsonAside.textContent = '—'; els.jsonPreview.textContent = '—'; return; }
    const r = state.result;
    const offs = F.offsetsByFrame(r && r.ok ? r : { ok: false }, ds.manifest.frameCount);
    const head = offs.slice(0, 3).map((o) => `  [${fmt(o[0], 6)}, ${fmt(o[1], 6)}]`);
    const tail = offs.length > 3 ? '  …' : '';
    els.jsonPreview.textContent = `[\n${head.join(',\n')}${tail ? `,\n${tail}` : ''}\n]`;
    els.jsonAside.textContent = `${offs.length} 条 · offsets.json`;
  }

  /* ------------------------------------------------------------ pins */

  function renderPinList() {
    const ds = state.dataset;
    const wrap = els.pinList;
    wrap.innerHTML = '';
    const pins = state.pins || [];
    els.pinCount.textContent = pins.length ? `${pins.length} 个` : '';
    if (!pins.length) {
      wrap.innerHTML = '<div class="empty">未固定任何帧</div>';
      return;
    }
    pins.sort((a, b) => a.frame - b.frame);
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      const row = document.createElement('div');
      row.className = 'pin-row';
      row.dataset.frame = String(p.frame);
      const fi = document.createElement('input');
      fi.className = 'input pf'; fi.type = 'number'; fi.min = '0';
      fi.max = String(ds ? ds.manifest.frameCount - 1 : 0);
      fi.value = String(p.frame); fi.setAttribute('aria-label', '固定帧号');
      const xi = document.createElement('input');
      xi.className = 'input'; xi.type = 'number'; xi.step = '0.01'; xi.value = String(p.x);
      xi.setAttribute('aria-label', '横向固定偏移');
      const yi = document.createElement('input');
      yi.className = 'input'; yi.type = 'number'; yi.step = '0.01'; yi.value = String(p.y);
      yi.setAttribute('aria-label', '纵向固定偏移');
      const del = document.createElement('button');
      del.className = 'del'; del.type = 'button'; del.textContent = '✕'; del.title = '移除';
      const onChange = () => {
        const nf = Math.round(Number(fi.value));
        const nx = Number(xi.value);
        const ny = Number(yi.value);
        p.frame = Number.isFinite(nf) ? Math.max(0, Math.min(ds.manifest.frameCount - 1, nf)) : p.frame;
        p.x = Number.isFinite(nx) ? nx : p.x;
        p.y = Number.isFinite(ny) ? ny : p.y;
        scheduleFit();
      };
      fi.addEventListener('change', onChange);
      xi.addEventListener('change', onChange);
      yi.addEventListener('change', onChange);
      del.addEventListener('click', () => {
        state.pins = state.pins.filter((q) => q !== p);
        renderPinList();
        runFit({ announce: true });
      });
      row.append(fi, xi, yi, del);
      wrap.appendChild(row);
    }
  }

  /* ------------------------------------------------------------ frames */

  function setFrame(t, { scroll = false } = {}) {
    const ds = state.dataset;
    if (!ds) return;
    const n = ds.manifest.frameCount;
    const f = Math.max(0, Math.min(n - 1, Math.round(t)));
    state.frame = f;
    state.cropCache = null;
    renderFrame();
    updateShotTableActive();
    if (state.chartCache) drawChart();
    if (scroll) els.frameRange.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function playToggle() {
    if (state.playing) {
      state.playing = false;
      clearInterval(state.playTimer);
      els.playBtn.textContent = '▶';
      return;
    }
    if (!state.dataset) return;
    state.playing = true;
    els.playBtn.textContent = '⏸';
    const n = state.dataset.manifest.frameCount;
    state.playTimer = setInterval(() => {
      setFrame((state.frame + 1) % n);
    }, 220);
  }

  /* ------------------------------------------------------------ export */

  async function doExport() {
    const ds = state.dataset;
    const r = state.result;
    if (!ds || !r || !r.ok) return;
    els.exportBtn.disabled = true;
    setStatus('busy', '正在导出…');
    try {
      const cropW = r.params.cropW;
      const cropH = r.params.cropH;
      const entries = [];
      for (let t = 0; t < ds.manifest.frameCount; t++) {
        const data = C.renderCrop(ds.frames[t].data, ds.W, ds.H, cropW, cropH, r.ux[t], r.uy[t]);
        const pnm = PNM.encodePnm(cropW, cropH, data);
        entries.push({ name: `frames/${String(t).padStart(4, '0')}.ppm`, data: pnm });
        if (t % 40 === 0) await new Promise((res) => setTimeout(res, 0));
      }
      const offsets = F.offsetsByFrame(r, ds.manifest.frameCount);
      const json = JSON.stringify(offsets.map((o) => [round6(o[0]), round6(o[1])]));
      entries.push({ name: 'offsets.json', data: new TextEncoder().encode(`${json}\n`) });
      const zipBytes = await ZIP.zip(entries);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stabilized-${cropW}x${cropH}-${ds.manifest.frameCount}f.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus('ok', '已导出');
      toast(`已导出 ${ds.manifest.frameCount} 帧（${cropW}×${cropH}）`);
    } catch (err) {
      setStatus('stale', '导出失败');
      toast(`导出失败：${err.message}`, 'err');
    } finally {
      els.exportBtn.disabled = false;
    }
  }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  /* ------------------------------------------------------------ wiring */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 数字输入与滑块联动
  function bindPair(range, num, onChange) {
    range.addEventListener('input', () => {
      num.value = range.value;
      syncRangeFills();
      onChange();
    });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) {
        range.value = String(Math.max(Number(range.min), Math.min(Number(range.max), v)));
        syncRangeFills();
      }
    });
    num.addEventListener('change', () => {
      if (num.value === '') num.value = range.value;
      num.value = String(Math.max(Number(range.min), Math.min(Number(range.max), Number(num.value) || 0)));
      syncRangeFills();
      onChange();
    });
  }
  bindPair(els.marginRange, els.marginNum, scheduleFit);
  bindPair(els.lambdaRange, els.lambdaNum, scheduleFit);

  els.cropW.addEventListener('change', () => { normalizeCropInput(); scheduleFit(); });
  els.cropH.addEventListener('change', () => { normalizeCropInput(); scheduleFit(); });
  function normalizeCropInput() {
    const ds = state.dataset;
    if (!ds) return;
    els.cropW.value = String(clampInt(els.cropW.value, 1, ds.W));
    els.cropH.value = String(clampInt(els.cropH.value, 1, ds.H));
  }

  for (const b of document.querySelectorAll('[data-lambda]')) {
    b.addEventListener('click', () => {
      els.lambdaNum.value = b.dataset.lambda;
      els.lambdaRange.value = b.dataset.lambda;
      syncRangeFills();
      scheduleFit();
    });
  }
  for (const b of document.querySelectorAll('[data-axis]')) {
    b.addEventListener('click', () => {
      state.axis = b.dataset.axis;
      for (const x of document.querySelectorAll('[data-axis]')) x.setAttribute('aria-pressed', String(x === b));
      drawChart();
    });
  }

  els.fitBtn.addEventListener('click', () => runFit({ announce: true }));
  els.recomputeBtn.addEventListener('click', () => runFit({ announce: true }));
  els.resetBtn.addEventListener('click', () => {
    if (state.pending) { syncParamInputsFromParams(state.pending); runFit({ announce: true }); }
  });

  els.addPinBtn.addEventListener('click', () => {
    const ds = state.dataset;
    if (!ds) return;
    if (state.pins.some((p) => p.frame === state.frame)) {
      toast('当前帧已固定');
      return;
    }
    // 默认取当前帧在当前结果下的偏移（若可行）作为固定值
    let x = 0; let y = 0;
    if (state.result && state.result.ok) { x = state.result.ux[state.frame]; y = state.result.uy[state.frame]; }
    state.pins.push({ frame: state.frame, x, y });
    renderPinList();
    runFit({ announce: true });
  });
  els.clearPinsBtn.addEventListener('click', () => {
    if (!state.pins || !state.pins.length) return;
    state.pins = [];
    renderPinList();
    runFit({ announce: true });
  });

  els.frameRange.addEventListener('input', () => setFrame(Number(els.frameRange.value)));
  els.prevBtn.addEventListener('click', () => setFrame(state.frame - 1));
  els.nextBtn.addEventListener('click', () => setFrame(state.frame + 1));
  els.playBtn.addEventListener('click', playToggle);
  els.inspectToggle.addEventListener('change', () => {
    if (!els.inspectToggle.checked) { state.inspHover = null; }
  });

  els.cropCanvas.addEventListener('pointermove', (ev) => setInspectorFromPointer(ev.clientX, ev.clientY));
  els.cropCanvas.addEventListener('pointerleave', () => {
    state.inspHover = null;
    els.inspState.textContent = '在裁后图上移动指针';
  });

  els.trajChart.addEventListener('pointermove', onChartPointer);
  els.trajChart.addEventListener('pointerleave', hideTip);
  els.trajChart.addEventListener('click', (ev) => {
    const cache = state.chartCache;
    if (!cache) return;
    const rect = els.trajChart.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const pw = cache.lay.cssW - cache.lay.pad.l - cache.lay.pad.r;
    let t = Math.round(((x - cache.lay.pad.l) / pw) * (cache.n - 1));
    t = Math.max(0, Math.min(cache.n - 1, t));
    setFrame(t);
  });

  els.exportBtn.addEventListener('click', doExport);
  els.recomputeBtn.textContent = '重新计算';

  els.loadSampleBtn.addEventListener('click', () => loadSample());
  els.importBtn.addEventListener('click', () => els.zipInput.click());
  els.zipInput.addEventListener('change', async () => {
    const file = els.zipInput.files && els.zipInput.files[0];
    if (!file) return;
    els.zipInput.value = '';
    await importFile(file);
  });

  async function importFile(file) {
    setStatus('busy', '读取中…');
    const buf = await file.arrayBuffer();
    const ds = await loadFromZipBuffer(buf, file.name);
    if (ds.error) {
      setStatus('stale', '导入失败');
      toast(`导入失败：${ds.error}`, 'err');
      return;
    }
    greetDataset(ds);
    toast(`已导入 ${ds.manifest.frameCount} 帧`);
  }

  async function loadSample() {
    setStatus('busy', '载入示例…');
    try {
      if (window.SAP_SAMPLE_ZIP) {
        const bin = base64ToBytes(window.SAP_SAMPLE_ZIP);
        const ds = await loadFromZipBuffer(bin, '示例');
        if (ds.error) throw new Error(ds.error);
        greetDataset(ds);
        return;
      }
      const resp = await fetch('samples/stabilized-aperture-cases.zip');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const ds = await loadFromZipBuffer(buf, '示例');
      if (ds.error) throw new Error(ds.error);
      greetDataset(ds);
    } catch (err) {
      setStatus('stale', '载入失败');
      toast(`载入示例失败：${err.message}。请用「导入 ZIP」选择样例文件。`, 'err');
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 拖放
  function hasFiles(ev) { return ev.dataTransfer && [...ev.dataTransfer.types].includes('Files'); }
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) await importFile(file);
  });

  // 键盘
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); setFrame(state.frame - 1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); setFrame(state.frame + 1); }
    else if (ev.key === ' ') { ev.preventDefault(); playToggle(); }
    else if (ev.key === 'Home') { ev.preventDefault(); setFrame(0); }
    else if (ev.key === 'End') { ev.preventDefault(); setFrame(state.dataset ? state.dataset.manifest.frameCount - 1 : 0); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.chartCache = null;
      if (state.dataset) { drawChart(); renderFrame(); }
    }, 120);
  });

  // 初值
  syncRangeFills();
  (function init() {
    // 主题自适应时跟随系统变化
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (state.theme === 'auto' || !state.theme) { state.chartCache = null; if (state.dataset) { drawChart(); renderFrame(); } }
      });
    }
    if (window.SAP_SAMPLE_ZIP) loadSample();
    else {
      // 未内嵌时尝试拉取，失败则提示
      setStatus('idle', '未载入');
    }
  })();

  // 测试钩子（也方便浏览器自动化）
  window.SAPApp = {
    state,
    loadSample,
    importBuffer: async (buf, name) => {
      const ds = await loadFromZipBuffer(buf, name || 'buffer.zip');
      if (ds.error) return { ok: false, error: ds.error };
      greetDataset(ds);
      return { ok: true, dataset: ds };
    },
    setFrame,
    applyTheme,
    runFit,
    getResult: () => state.result,
    getParams: () => currentParams(),
    setParams: (p) => {
      if (p.cropW != null) els.cropW.value = String(p.cropW);
      if (p.cropH != null) els.cropH.value = String(p.cropH);
      if (p.margin != null) { els.marginRange.value = els.marginNum.value = String(p.margin); }
      if (p.lambda != null) { els.lambdaRange.value = els.lambdaNum.value = String(p.lambda); }
      if (p.pins != null) { state.pins = p.pins.map((q) => ({ ...q })); renderPinList(); }
      syncRangeFills();
    },
    exportZip: async () => {
      const ds = state.dataset;
      const r = state.result;
      if (!ds || !r || !r.ok) return null;
      const entries = [];
      for (let t = 0; t < ds.manifest.frameCount; t++) {
        const data = C.renderCrop(ds.frames[t].data, ds.W, ds.H, r.params.cropW, r.params.cropH, r.ux[t], r.uy[t]);
        entries.push({ name: `frames/${String(t).padStart(4, '0')}.ppm`, data: PNM.encodePnm(r.params.cropW, r.params.cropH, data) });
      }
      const offsets = F.offsetsByFrame(r, ds.manifest.frameCount);
      entries.push({ name: 'offsets.json', data: new TextEncoder().encode(JSON.stringify(offsets)) });
      return ZIP.zip(entries);
    },
    renderFrameData: (t) => {
      const ds = state.dataset;
      const r = state.result;
      if (!ds || !r || !r.ok) return null;
      return C.renderCrop(ds.frames[t].data, ds.W, ds.H, r.params.cropW, r.params.cropH, r.ux[t], r.uy[t]);
    },
  };
})();
