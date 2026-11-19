/*
 * app.js — 频域陷波工作台交互层
 * 数学全部来自 dsp.js（手写 FFT），本文件只负责状态、画布与导入导出。
 */
(function () {
  'use strict';
  const D = window.FNC_DSP;

  /* ---------------- 全局状态 ---------------- */
  const state = {
    imageData: null,        // 原始 ImageData（sRGB 8 位）
    fileName: '',
    decoded: null,          // 线性 RGB
    padMode: 'reflect101',
    notches: [],            // [{id,u,v,sigma,strength}]
    selectedId: null,
    pendingUV: null,        // 频谱上点选、尚未确认添加的位置
    result: null,           // DSP.process 的结果
    previewView: 'filtered',
    diffGain: 4,
    specImage: null,        // 频谱底图 ImageBitmap/ImageData
    dragId: null,
    dragMoved: false,
    probeUV: null,       // 已钉住的点查坐标（重算后自动刷新）
  };
  let seq = 1;
  const MAX_NOTCHES = 16;

  const $ = (id) => document.getElementById(id);
  const els = {};
  ['file-input','file-info','pad-seg','pad-info','notch-count','notch-list','add-btn',
   'editor','edit-u','edit-v','edit-sigma','sigma-val','edit-strength','strength-val',
   'delete-btn','export-png-btn','export-json-btn','spectrum','probe','hover-tip',
   'preview-tabs','preview','diff-gain','diff-gain-val','diff-gain-wrap','diff-gain-label',
   'metric-grid','notch-table','spinner','status-text','toast','theme-btn']
    .forEach((k) => { els[k] = $(k); });

  const specCanvas = els.spectrum;
  const specCtx = specCanvas.getContext('2d');
  const prevCanvas = els.preview;
  const prevCtx = prevCanvas.getContext('2d');

  /* ---------------- 通用 ---------------- */
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('on'), 2400);
  }
  function setStatus(text, busy) {
    els['status-text'].textContent = text;
    els.spinner.classList.toggle('on', !!busy);
  }
  function fmt(x, digits = 4) {
    if (!isFinite(x)) return String(x);
    if (x !== 0 && Math.abs(x) < 1e-3) return x.toExponential(3);
    return Number(x.toFixed(digits)).toString();
  }

  /* ---------------- 主题 ---------------- */
  els['theme-btn'].addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem('fnc-theme', root.getAttribute('data-theme')); } catch (e) {}
    drawSpectrum();
  });
  try {
    const t = localStorage.getItem('fnc-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}

  /* ---------------- 文件导入（含尺寸/格式校验） ---------------- */
  els['file-input'].addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      if (!/\.png$/i.test(file.name)) throw new Error('仅支持 PNG 文件');
      const buf = new Uint8Array(await file.arrayBuffer());
      const info = readPNGHeader(buf);
      if (!info) throw new Error('无法识别的 PNG 文件');
      if (info.bitDepth !== 8 || (info.colorType !== 2 && info.colorType !== 6)) {
        throw new Error('仅支持 8 位 RGB/RGBA PNG（当前 bitDepth=' + info.bitDepth + ' colorType=' + info.colorType + '）');
      }
      if (info.width > 512 || info.height > 512) {
        throw new Error('单边不得超过 512（当前 ' + info.width + '×' + info.height + '）');
      }
      const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      const img = new ImageData(info.width, info.height);
      const t = document.createElement('canvas');
      t.width = info.width; t.height = info.height;
      const tctx = t.getContext('2d');
      tctx.drawImage(bitmap, 0, 0);
      const drawn = tctx.getImageData(0, 0, info.width, info.height);
      img.data.set(drawn.data);
      loadImage(img, file.name);
    } catch (err) {
      toast('导入失败：' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  function readPNGHeader(buf) {
    if (buf.length < 24) return null;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      width: dv.getUint32(16),
      height: dv.getUint32(20),
      bitDepth: buf[24],
      colorType: buf[25],
    };
  }

  function loadImage(imageData, name) {
    state.imageData = imageData;
    state.fileName = name || 'image.png';
    state.decoded = D.decodeLinearRGB(imageData);
    state.notches = [];
    state.selectedId = null;
    state.pendingUV = null;
    state.probeUV = null;
    els.probe.innerHTML = '导入图像后在此点查频率与复数值';
    const { W, H } = D.paddedSize(imageData.width, imageData.height);
    els['file-info'].textContent =
      name + ' — 原图 ' + imageData.width + '×' + imageData.height +
      '，填充后 ' + W + '×' + H;
    els['add-btn'].disabled = false;
    els['export-png-btn'].disabled = false;
    els['export-json-btn'].disabled = false;
    scheduleProcess('已导入 ' + name);
  }

  /* ---------------- 填充模式 ---------------- */
  els['pad-seg'].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.padMode = btn.dataset.mode;
    els['pad-seg'].querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    scheduleProcess('切换填充模式：' + state.padMode);
  });

  /* ---------------- 处理调度（debounce） ---------------- */
  let processTimer = null;
  function scheduleProcess(reason) {
    if (!state.decoded) return;
    setStatus((reason || '更新') + '… 计算中', true);
    clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      const t0 = performance.now();
      // 过滤掉编辑过程中的临时非法值
      const notches = state.notches
        .filter((n) => Number.isFinite(n.u) && Number.isFinite(n.v))
        .map((n) => ({ u: n.u | 0, v: n.v | 0, sigma: n.sigma, strength: n.strength }));
      state.result = D.process(state.decoded, state.padMode, notches);
      buildSpecImage();
      drawSpectrum();
      renderPreview();
      renderReport();
      renderProbe();
      setStatus('完成（' + (performance.now() - t0).toFixed(0) + ' ms）', false);
    }, 120);
  }

  /* ---------------- 频谱底图（对数幅值，居中） ---------------- */
  function buildSpecImage() {
    const r = state.result;
    const { W, H } = r;
    const mag = D.magnitudeLog(r.spectra[0]);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < mag.length; i++) {
      if (mag[i] < lo) lo = mag[i];
      if (mag[i] > hi) hi = mag[i];
    }
    const range = Math.max(hi - lo, 1e-12);
    const out = new ImageData(W, H);
    const px = out.data;
    for (let sy = 0; sy < H; sy++) {
      for (let sx = 0; sx < W; sx++) {
        // 居中显示坐标 -> 未 shift 索引
        const u = D.shiftToUnshift(sx, W);
        const v = D.shiftToUnshift(sy, H);
        const t = (mag[v * W + u] - lo) / range;
        // 深蓝仪器底调上的蓝青对数幅值热图
        const o = (sy * W + sx) * 4;
        px[o] = Math.round(20 + 10 * t);
        px[o + 1] = Math.round(28 + 150 * t);
        px[o + 2] = Math.round(42 + 200 * t);
        px[o + 3] = 255;
      }
    }
    state.specImage = out;
    specCanvas.style.aspectRatio = W + ' / ' + H;
  }

  function drawSpectrum() {
    if (!state.result) {
      specCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg') || '#0d1117';
      specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
      return;
    }
    const r0 = state.result;
    const { W, H } = r0;
    // 内部位图固定取 CSS 像素尺寸；浏览器负责位图到显示尺寸的缩放
    const rect = specCanvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    if (specCanvas.width !== cssW || specCanvas.height !== cssH) {
      specCanvas.width = cssW;
      specCanvas.height = cssH;
    }
    const cw = specCanvas.width;
    const ch = specCanvas.height;
    const sx = cw / W, sy = ch / H;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    off.getContext('2d').putImageData(state.specImage, 0, 0);
    specCtx.imageSmoothingEnabled = false;
    specCtx.clearRect(0, 0, cw, ch);
    specCtx.drawImage(off, 0, 0, cw, ch);

    // 网格：直流十字线
    specCtx.strokeStyle = 'rgba(255,255,255,0.12)';
    specCtx.lineWidth = 1;
    specCtx.beginPath();
    specCtx.moveTo(cw / 2 + 0.5, 0); specCtx.lineTo(cw / 2 + 0.5, ch);
    specCtx.moveTo(0, ch / 2 + 0.5); specCtx.lineTo(cw, ch / 2 + 0.5);
    specCtx.stroke();

    // 直流标记
    drawMarker(cw / 2, ch / 2, '#58a6ff', true, 4);

    // 待确认点
    if (state.pendingUV) {
      const [px, py] = unshiftToCanvas(state.pendingUV[0], state.pendingUV[1]);
      drawMarker(px, py, '#ffd43b', true, 6);
    }

    // 陷波组：主中心实心、共轭空心
    for (const n of state.notches) {
      const selected = n.id === state.selectedId;
      const radius = selected ? 7 : 5.5;
      const [x1, y1] = unshiftToCanvas(n.u, n.v);
      const cu = (-(((n.u % W) + W) % W) + W) % W;
      const cv = (-(((n.v % H) + H) % H) + H) % H;
      const [x2, y2] = unshiftToCanvas(cu, cv);
      drawMarker(x1, y1, '#ff8a5c', true, radius, selected);
      if (!(cu === n.u && cv === n.v)) {
        drawMarker(x2, y2, '#ff8a5c', false, radius, selected);
      }
      // σ 半径环（示意，1σ）
      specCtx.beginPath();
      specCtx.arc(x1, y1, Math.max(3, n.sigma * Math.min(sx, sy)), 0, Math.PI * 2);
      specCtx.strokeStyle = selected ? 'rgba(255,138,92,0.95)' : 'rgba(255,138,92,0.5)';
      specCtx.lineWidth = selected ? 1.6 : 1;
      specCtx.stroke();
    }
  }

  function drawMarker(x, y, color, filled, r, ring) {
    specCtx.beginPath();
    specCtx.arc(x, y, r, 0, Math.PI * 2);
    if (filled) {
      specCtx.fillStyle = color;
      specCtx.fill();
      specCtx.strokeStyle = 'rgba(0,0,0,0.55)';
      specCtx.lineWidth = 1;
      specCtx.stroke();
    } else {
      specCtx.strokeStyle = color;
      specCtx.lineWidth = 2;
      specCtx.stroke();
    }
    if (ring) {
      specCtx.beginPath();
      specCtx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      specCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      specCtx.lineWidth = 1.2;
      specCtx.stroke();
    }
  }

  // 未 shift 频率坐标 -> 相对画布 CSS 盒的像素位置（与 eventPos 同一坐标系）
  function unshiftToCanvas(u, v) {
    const r = state.result;
    const rect = specCanvas.getBoundingClientRect();
    return [
      D.unshiftToShift(u, r.W) * (rect.width / r.W),
      D.unshiftToShift(v, r.H) * (rect.height / r.H),
    ];
  }
  function canvasToUnshift(px, py) {
    const r = state.result;
    const rect = specCanvas.getBoundingClientRect();
    // 用相对坐标换算，避免内部位图分辨率与 CSS 尺寸不一致时取错格点
    const fx = Math.floor((px / rect.width) * r.W + 1e-9);
    const fy = Math.floor((py / rect.height) * r.H + 1e-9);
    return [D.shiftToUnshift(fx, r.W), D.shiftToUnshift(fy, r.H)];
  }

  /* ---------------- 频谱交互：点查 / 添加 / 拖动 ---------------- */
  function eventPos(e) {
    const rect = specCanvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    // 统一返回相对画布 CSS 盒的坐标与 rect 本身
    return [p.clientX - rect.left, p.clientY - rect.top, rect];
  }
  specCanvas.addEventListener('pointerdown', (e) => {
    if (!state.result) return;
    const [px, py] = eventPos(e);
    const hit = hitNotch(px, py);
    if (hit) {
      state.dragId = hit.id;
      state.dragMoved = false;
      state.selectedId = hit.id;
      specCanvas.setPointerCapture(e.pointerId);
      renderNotchList();
      renderEditor();
    }
  });

  specCanvas.addEventListener('pointermove', (e) => {
    if (!state.result) return;
    const [px, py, rect] = eventPos(e);
    const [u, v] = canvasToUnshift(px, py);
    updateHoverTip(px, py, u, v, rect);

    if (state.dragId != null) {
      const n = state.notches.find((x) => x.id === state.dragId);
      if (!n) return;
      if (u !== n.u || v !== n.v) state.dragMoved = true;
      if (isForbidden(u, v)) return;
      n.u = u; n.v = v;
      renderNotchList();
      renderEditor();
      drawSpectrum();
      scheduleProcess('拖动陷波');
    }
  });

  specCanvas.addEventListener('pointerup', (e) => {
    if (!state.result) return;
    const [px, py] = eventPos(e);
    // 未发生位移的按下不算拖拽，松手仍按“点击”处理（选中+探针）
    const wasDrag = state.dragId != null && state.dragMoved;
    if (state.dragId != null) {
      state.dragId = null;
      state.dragMoved = false;
      try { specCanvas.releasePointerCapture(e.pointerId); } catch (err) { /* 无捕获时忽略 */ }
    }
    if (wasDrag) return;
    const hit = hitNotch(px, py);
    if (hit) {
      // 点击已有陷波：选中并把探针钉到其精确中心
      state.selectedId = hit.id;
      pinProbe(hit.u, hit.v);
      renderNotchList();
      renderEditor();
      drawSpectrum();
      return;
    }
    const [u, v] = canvasToUnshift(px, py);
    // 点查（直流只查不加）
    pinProbe(u, v);
    if (u === 0 && v === 0) {
      toast('直流 (0,0) 始终保留，不能放置陷波');
      return;
    }
    state.pendingUV = [u, v];
    state.selectedId = null;
    renderEditor();
    drawSpectrum();
    els['add-btn'].textContent = '在 (' + u + ',' + v + ') 添加陷波组';
  });

  specCanvas.addEventListener('pointerleave', () => {
    els['hover-tip'].style.display = 'none';
  });

  function hitNotch(px, py) {
    for (const n of state.notches) {
      const [x1, y1] = unshiftToCanvas(n.u, n.v);
      if (Math.hypot(px - x1, py - y1) <= 10) return n;
      const r = state.result;
      const cu = (-(((n.u % r.W) + r.W) % r.W) + r.W) % r.W;
      const cv = (-(((n.v % r.H) + r.H) % r.H) + r.H) % r.H;
      if (cu !== n.u || cv !== n.v) {
        const [x2, y2] = unshiftToCanvas(cu, cv);
        if (Math.hypot(px - x2, py - y2) <= 10) return n;
      }
    }
    return null;
  }

  // 直流禁止；与已有组的任一唯一中心重合则禁止（含奈奎斯特自共轭不重复抑制）
  function isForbidden(u, v) {
    if (u === 0 && v === 0) return true;
    const r = state.result;
    const W = r.W, H = r.H;
    const targets = new Set([u + ',' + v, ((-u + W) % W) + ',' + ((-v + H) % H)]);
    for (const n of state.notches) {
      if (n.id === state.dragId) continue;
      const cs = D.uniqueCenters([{ u: n.u, v: n.v, sigma: n.sigma, strength: n.strength }], W, H);
      for (const c of cs) if (targets.has(c.u + ',' + c.v)) return true;
    }
    return false;
  }

  els['add-btn'].addEventListener('click', () => {
    if (!state.pendingUV) {
      toast('请先在频谱上点选位置');
      return;
    }
    if (state.notches.length >= MAX_NOTCHES) {
      toast('最多 ' + MAX_NOTCHES + ' 组陷波');
      return;
    }
    const [u, v] = state.pendingUV;
    if (isForbidden(u, v)) {
      toast('该频率中心已被其他陷波组占用（奈奎斯特自共轭点不可重复抑制）');
      state.pendingUV = null;
      els['add-btn'].textContent = '在频谱上点选位置后添加';
      drawSpectrum();
      return;
    }
    const n = { id: seq++, u, v, sigma: 0.6, strength: 1 };
    state.notches.push(n);
    state.selectedId = n.id;
    state.pendingUV = null;
    els['add-btn'].textContent = '在频谱上点选位置后添加';
    renderNotchList();
    renderEditor();
    drawSpectrum();
    scheduleProcess('添加陷波');
  });

  /* ---------------- 点查浮层 ---------------- */
  function updateHoverTip(px, py, u, v, rect) {
    const tip = els['hover-tip'];
    if (!state.result) return;
    const s = state.result.spectra[0];
    const r = state.result;
    const i = v * r.W + u;
    tip.style.display = 'block';
    tip.style.left = Math.min(px + 14, rect.width - 150) + 'px';
    tip.style.top = Math.min(py + 14, rect.height - 78) + 'px';
    tip.innerHTML = 'u=' + u + ' v=' + v + '<br>|X|=' + fmt(Math.hypot(s.re[i], s.im[i]), 3)
      + '<br>re=' + fmt(s.re[i], 3) + ' im=' + fmt(s.im[i], 3);
  }

  function pinProbe(u, v) {
    state.probeUV = [u, v];
    renderProbe();
  }

  function renderProbe() {
    if (!state.result || !state.probeUV) return;
    const [u, v] = state.probeUV;
    const r = state.result;
    const s = r.spectra[0];
    const i = v * r.W + u;
    const fs = r.filteredSpectra[0];
    els.probe.innerHTML =
      '点查（未 shift）u=' + u + ' v=' + v + '<br>' +
      '滤波前 |X|=' + fmt(Math.hypot(s.re[i], s.im[i])) +
      '（re=' + fmt(s.re[i]) + ' im=' + fmt(s.im[i]) + '）<br>' +
      '滤波后 |X|=' + fmt(Math.hypot(fs.re[i], fs.im[i])) +
      '（re=' + fmt(fs.re[i]) + ' im=' + fmt(fs.im[i]) + '）<br>' +
      'H=' + fmt(r.Hfilter[i]);
  }

  /* ---------------- 陷波列表与参数编辑 ---------------- */
  function renderNotchList() {
    const wrap = els['notch-list'];
    wrap.innerHTML = '';
    els['notch-count'].textContent = state.notches.length + ' / ' + MAX_NOTCHES;
    if (!state.notches.length) {
      wrap.innerHTML = '<div class="empty-hint">暂无陷波组。空滤波器应能无损往返。</div>';
      return;
    }
    for (const n of state.notches) {
      const r = state.result;
      const conj = r ? conjugateOf(n, r.W, r.H) : [0, 0];
      const item = document.createElement('div');
      item.className = 'notch-item' + (n.id === state.selectedId ? ' sel' : '');
      item.innerHTML =
        '<div class="head"><span class="dot"></span>' +
        '<span class="coords">(' + n.u + ',' + n.v + ')' +
        (conj[0] === n.u && conj[1] === n.v ? ' · 自共轭' : ' ⇄ (' + conj[0] + ',' + conj[1] + ')') +
        '</span><button class="x-btn" title="删除" type="button">×</button></div>' +
        '<div class="meta"><span>σ=' + n.sigma + '</span><span>s=' + n.strength + '</span></div>';
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('x-btn')) return;
        state.selectedId = n.id;
        renderNotchList();
        renderEditor();
        drawSpectrum();
      });
      item.querySelector('.x-btn').addEventListener('click', () => removeNotch(n.id));
      wrap.appendChild(item);
    }
  }

  function conjugateOf(n, W, H) {
    const u = ((n.u % W) + W) % W, v = ((n.v % H) + H) % H;
    return [(-u + W) % W, (-v + H) % H];
  }

  function removeNotch(id) {
    state.notches = state.notches.filter((n) => n.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    renderNotchList();
    renderEditor();
    drawSpectrum();
    scheduleProcess('删除陷波');
  }
  els['delete-btn'].addEventListener('click', () => {
    if (state.selectedId != null) removeNotch(state.selectedId);
  });

  function currentNotch() {
    return state.notches.find((n) => n.id === state.selectedId) || null;
  }

  function renderEditor() {
    const n = currentNotch();
    els.editor.hidden = !n;
    if (!n) return;
    els['edit-u'].value = n.u;
    els['edit-v'].value = n.v;
    els['edit-sigma'].value = n.sigma;
    els['edit-strength'].value = n.strength;
    els['sigma-val'].textContent = Number(n.sigma).toFixed(2);
    els['strength-val'].textContent = Number(n.strength).toFixed(2);
  }

  els['edit-u'].addEventListener('change', () => {
    const n = currentNotch(); if (!n) return;
    const u = clampInt(+els['edit-u'].value, 0, state.result.W - 1);
    if (isForbiddenAt(u, n.v, n.id)) { toast('该位置与其他陷波中心冲突'); renderEditor(); return; }
    n.u = u; afterEdit();
  });
  els['edit-v'].addEventListener('change', () => {
    const n = currentNotch(); if (!n) return;
    const v = clampInt(+els['edit-v'].value, 0, state.result.H - 1);
    if (isForbiddenAt(n.u, v, n.id)) { toast('该位置与其他陷波中心冲突'); renderEditor(); return; }
    n.v = v; afterEdit();
  });
  els['edit-sigma'].addEventListener('input', () => {
    const n = currentNotch(); if (!n) return;
    n.sigma = +els['edit-sigma'].value;
    els['sigma-val'].textContent = n.sigma.toFixed(2);
    renderNotchList();
    drawSpectrum();
    scheduleProcess('调整带宽');
  });
  els['edit-strength'].addEventListener('input', () => {
    const n = currentNotch(); if (!n) return;
    n.strength = +els['edit-strength'].value;
    els['strength-val'].textContent = n.strength.toFixed(2);
    renderNotchList();
    drawSpectrum();
    scheduleProcess('调整强度');
  });

  function isForbiddenAt(u, v, ignoreId) {
    if (u === 0 && v === 0) return true;
    const r = state.result, W = r.W, H = r.H;
    const targets = new Set([u + ',' + v, ((-u + W) % W) + ',' + ((-v + H) % H)]);
    for (const o of state.notches) {
      if (o.id === ignoreId) continue;
      for (const c of D.uniqueCenters([o], W, H)) if (targets.has(c.u + ',' + c.v)) return true;
    }
    return false;
  }
  function clampInt(x, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(x))); }
  function afterEdit() {
    renderNotchList(); renderEditor(); drawSpectrum(); scheduleProcess('调整位置');
  }

  /* ---------------- 预览 ---------------- */
  els['preview-tabs'].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.previewView = btn.dataset.view;
    els['preview-tabs'].querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === btn));
    els['diff-gain-wrap'].hidden = state.previewView !== 'diff';
    renderPreview();
  });
  els['diff-gain'].addEventListener('input', () => {
    state.diffGain = +els['diff-gain'].value;
    els['diff-gain-val'].textContent = '×' + state.diffGain;
    els['diff-gain-label'].textContent = state.diffGain;
    renderPreview();
  });

  function renderPreview() {
    if (!state.result || !state.imageData) return;
    const w = state.imageData.width, h = state.imageData.height;
    prevCanvas.width = w; prevCanvas.height = h;
    const out = prevCtx.createImageData(w, h);
    const src = state.imageData.data;

    if (state.previewView === 'original') {
      out.data.set(src);
    } else if (state.previewView === 'filtered') {
      const enc = D.encodeOutput(state.result);
      out.data.set(enc.data);
    } else {
      // 差值：线性域差值 × 增益，映射为中灰底的偏差图（RGB 共用各自通道差）
      const g = state.diffGain;
      const dec = state.decoded.channels;
      for (let i = 0; i < w * h; i++) {
        for (let ch = 0; ch < 3; ch++) {
          const d = (state.result.outputChannels[ch][i] - dec[ch][i]) * g;
          // 以线性 0.5 为中灰，按 sRGB 编码
          out.data[i * 4 + ch] = D.linearToSrgbByte(0.5 + d);
        }
        out.data[i * 4 + 3] = 255;
      }
    }
    prevCtx.putImageData(out, 0, 0);
  }

  /* ---------------- 数值报告 ---------------- */
  function renderReport() {
    const r = state.result;
    if (!r) return;
    const metrics = [
      ['原图尺寸', r.width + ' × ' + r.height],
      ['填充尺寸', r.W + ' × ' + r.H + '（' + r.mode + '）'],
      ['陷波组数', String(r.notches.length) + ' / ' + MAX_NOTCHES],
      ['限幅前最大虚部', fmt(r.maxImag, 6)],
      ['处理前均值 R/G/B', r.beforeMeans.map((x) => fmt(x, 5)).join(' / ')],
      ['处理后均值 R/G/B', r.afterMeans.map((x) => fmt(x, 5)).join(' / ')],
    ];
    els['metric-grid'].innerHTML = metrics.map(([k, v]) =>
      '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

    const tb = els['notch-table'].querySelector('tbody');
    if (!r.notchReport.length) {
      tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--ink-faint)">空滤波器：H≡1，编码像素逐字节不变</td></tr>';
      return;
    }
    tb.innerHTML = r.notchReport.map((q) =>
      '<tr><td>(' + q.u + ',' + q.v + ')</td><td>' + q.sigma + '</td><td>' + q.strength +
      '</td><td>' + fmt(q.magnitudeBefore, 4) + '</td><td>' + fmt(q.magnitudeAfter, 4) + '</td></tr>').join('');
  }

  /* ---------------- 导出 ---------------- */
  els['export-png-btn'].addEventListener('click', () => {
    if (!state.result) return;
    const enc = D.encodeOutput(state.result);
    const c = document.createElement('canvas');
    c.width = enc.width; c.height = enc.height;
    c.getContext('2d').putImageData(enc, 0, 0);
    c.toBlob((blob) => {
      downloadBlob(blob, baseName() + '_filtered.png');
    }, 'image/png');
  });

  els['export-json-btn'].addEventListener('click', () => {
    if (!state.result) return;
    const r = state.result;
    const payload = {
      source: state.fileName,
      padding: {
        mode: r.mode,
        originalSize: { width: r.width, height: r.height },
        paddedSize: { width: r.W, height: r.H },
      },
      notches: r.notches.map((n) => ({ u: n.u, v: n.v, sigma: n.sigma, strength: n.strength })),
      uniqueCenters: r.centers.map((q) => ({ u: q.u, v: q.v })),
      numericErrors: {
        maxImaginaryBeforeClip: r.maxImag,
        meanBefore_linearRGB: r.beforeMeans,
        meanAfter_linearRGB: r.afterMeans,
      },
      notchMagnitudes: r.notchReport.map((q) => ({
        u: q.u, v: q.v,
        magnitudeBefore: q.magnitudeBefore,
        magnitudeAfter: q.magnitudeAfter,
      })),
      convention: {
        forwardDFT: 'exp(-2*pi*i*k*n/N), 不归一化；逆向除 N',
        filter: 'Gq=1-strength*exp(-d_torus^2/(2*sigma^2))，组间连乘，H(0,0)=1',
        color: 'sRGB 解码为线性 RGB，三通道共用 H，输出取实部限幅编码 sRGB',
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, baseName() + '_report.json');
  });

  function baseName() {
    return state.fileName.replace(/\.png$/i, '') || 'image';
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------------- 初始化 ---------------- */
  // 仅暴露自动化测试需要的最小接口
  window.__fnc = { get state() { return state; } };
  renderNotchList();
  renderEditor();
  drawSpectrum();
  els['diff-gain-val'].textContent = '×' + state.diffGain;
  window.addEventListener('resize', () => { if (state.result) drawSpectrum(); });
})();
