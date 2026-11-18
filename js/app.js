/* 页面逻辑：导入、选区编辑、视图联动、求解调度（可取消）、导出。 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    fileSrc: $('file-src'), fileTgt: $('file-tgt'), fileMask: $('file-mask'),
    preset: $('preset'),
    brushMode: $('brush-mode'), brushRadius: $('brush-radius'),
    maskAll: $('mask-all'), maskNone: $('mask-none'), maskInvert: $('mask-invert'),
    dx: $('dx'), dy: $('dy'),
    tol: $('tol'), maxIter: $('max-iter'),
    solveBtn: $('solve-btn'), cancelBtn: $('cancel-btn'), status: $('status'),
    zoom: $('zoom'), diffGain: $('diff-gain'), probe: $('probe'),
    viewMask: $('view-mask'), viewPaste: $('view-paste'),
    viewResult: $('view-result'), viewDiff: $('view-diff'),
    brushCursor: $('brush-cursor'),
    exportPng: $('export-png'), exportJson: $('export-json'),
    report: $('report')
  };

  var state = {
    src: null,          // {w,h,rgb:Uint8Array}
    tgt: null,          // {w,h,rgb:Uint8Array}
    mask: null,         // Uint8Array(srcW*srcH) 0/1
    maskFromFile: false,
    dx: 0, dy: 0,
    mode: 'source',
    result: null,       // 求解返回（solution 为线性未限幅）
    elapsedMs: 0,
    pasteBytes: null,   // 直接粘贴 8 位 RGB（底图尺寸）
    resultBytes: null,  // 求解结果 8 位 RGB（显示限幅后）
    solving: false
  };

  var worker = null;
  var jobId = 0;
  var solveTimer = null;

  // ---------- 状态提示 ----------
  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ---------- 图像解码 ----------
  function decodeImage(blob) {
    var opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    return createImageBitmap(blob, opts).catch(function () {
      return createImageBitmap(blob);
    }).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      if (w > 512 || h > 512) throw new Error('图像超过 512×512 限制（' + w + '×' + h + '）');
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      var data = ctx.getImageData(0, 0, w, h).data;
      var rgb = new Uint8Array(w * h * 3);
      for (var i = 0, n = w * h; i < n; i++) {
        rgb[i * 3] = data[i * 4];
        rgb[i * 3 + 1] = data[i * 4 + 1];
        rgb[i * 3 + 2] = data[i * 4 + 2];
      }
      return { w: w, h: h, rgb: rgb };
    });
  }

  // ---------- 视图绘制 ----------
  function drawPlaceholder(canvas, text) {
    canvas.width = 220; canvas.height = 120;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#181d25';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8b96a8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    applyZoom();
  }

  function drawRGB(canvas, bytes, w, h) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var d = img.data;
    for (var i = 0, n = w * h; i < n; i++) {
      d[i * 4] = bytes[i * 3];
      d[i * 4 + 1] = bytes[i * 3 + 1];
      d[i * 4 + 2] = bytes[i * 3 + 2];
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    applyZoom();
  }

  function renderMaskView() {
    if (!state.src) { drawPlaceholder(els.viewMask, '未导入源图'); return; }
    var w = state.src.w, h = state.src.h;
    var bytes = new Uint8Array(w * h * 3);
    for (var i = 0, n = w * h; i < n; i++) {
      var r = state.src.rgb[i * 3], g = state.src.rgb[i * 3 + 1], b = state.src.rgb[i * 3 + 2];
      if (state.mask && state.mask[i]) { // 选中区域叠红
        r = Math.round(r * 0.5 + 255 * 0.5);
        g = Math.round(g * 0.5 + 40 * 0.5);
        b = Math.round(b * 0.5 + 40 * 0.5);
      }
      bytes[i * 3] = r; bytes[i * 3 + 1] = g; bytes[i * 3 + 2] = b;
    }
    drawRGB(els.viewMask, bytes, w, h);
  }

  function computePaste() {
    if (!state.tgt) return null;
    var w = state.tgt.w, h = state.tgt.h;
    var out = new Uint8Array(state.tgt.rgb);
    if (state.src && state.mask) {
      for (var sy = 0; sy < state.src.h; sy++) {
        var ty = sy + state.dy;
        if (ty < 0 || ty >= h) continue;
        for (var sx = 0; sx < state.src.w; sx++) {
          if (!state.mask[sy * state.src.w + sx]) continue;
          var tx = sx + state.dx;
          if (tx < 0 || tx >= w) continue;
          var s = (sy * state.src.w + sx) * 3, t = (ty * w + tx) * 3;
          out[t] = state.src.rgb[s];
          out[t + 1] = state.src.rgb[s + 1];
          out[t + 2] = state.src.rgb[s + 2];
        }
      }
    }
    return out;
  }

  function renderPaste() {
    if (!state.tgt) { drawPlaceholder(els.viewPaste, '未导入底图'); return; }
    state.pasteBytes = computePaste();
    drawRGB(els.viewPaste, state.pasteBytes, state.tgt.w, state.tgt.h);
  }

  function renderResult() {
    if (!state.tgt) { drawPlaceholder(els.viewResult, '未导入底图'); return; }
    if (!state.result) { drawPlaceholder(els.viewResult, '尚未求解'); return; }
    var w = state.tgt.w, h = state.tgt.h;
    var sol = state.result.solution;
    var bytes = new Uint8Array(w * h * 3);
    for (var i = 0, n = w * h * 3; i < n; i++) {
      bytes[i] = PoissonSolver.linearToSrgbByte(sol[i]); // 限幅仅用于显示
    }
    state.resultBytes = bytes;
    drawRGB(els.viewResult, bytes, w, h);
  }

  function renderDiff() {
    if (!state.tgt) { drawPlaceholder(els.viewDiff, '未导入底图'); return; }
    if (!state.result || !state.pasteBytes || !state.resultBytes) {
      drawPlaceholder(els.viewDiff, '尚未求解');
      return;
    }
    var gain = parseFloat(els.diffGain.value) || 1;
    var n = state.tgt.w * state.tgt.h * 3;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var d = Math.abs(state.resultBytes[i] - state.pasteBytes[i]) * gain;
      bytes[i] = d > 255 ? 255 : d;
    }
    drawRGB(els.viewDiff, bytes, state.tgt.w, state.tgt.h);
  }

  function renderAll() {
    renderMaskView();
    renderPaste();
    renderResult();
    renderDiff();
  }

  function applyZoom() {
    var z = parseFloat(els.zoom.value) || 1;
    [els.viewMask, els.viewPaste, els.viewResult, els.viewDiff].forEach(function (cv) {
      cv.style.width = (cv.width * z) + 'px';
      cv.style.height = (cv.height * z) + 'px';
    });
  }

  // ---------- 求解调度（修改参数即取消旧计算） ----------
  function readyToSolve() {
    return !!(state.src && state.tgt && state.mask);
  }

  function cancelSolve(reason) {
    if (worker) { worker.terminate(); worker = null; }
    state.solving = false;
    els.cancelBtn.disabled = true;
    if (reason) setStatus(reason, '');
  }

  function scheduleSolve(delay) {
    if (!readyToSolve()) return;
    if (worker) { worker.terminate(); worker = null; } // 取消旧计算
    clearTimeout(solveTimer);
    solveTimer = setTimeout(runSolve, delay == null ? 250 : delay);
  }

  function runSolve() {
    if (!readyToSolve()) return;
    if (worker) worker.terminate();
    var id = ++jobId;
    try {
      worker = new Worker('js/solver-worker.js');
    } catch (err) {
      setStatus('无法创建 Worker（请通过 HTTP 访问页面）：' + err.message, 'err');
      return;
    }
    state.solving = true;
    els.cancelBtn.disabled = false;
    setStatus('求解中…', 'busy');

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.id !== id) return; // 过期任务
      if (msg.type === 'progress') {
        setStatus('求解中… 通道 ' + 'RGB'[msg.channel] +
          ' 迭代 ' + msg.iter + '，相对残差 ' + msg.relres.toExponential(2), 'busy');
      } else if (msg.type === 'done') {
        worker.terminate(); worker = null;
        state.solving = false;
        els.cancelBtn.disabled = true;
        state.result = msg.result;
        state.elapsedMs = msg.elapsedMs;
        renderResult();
        renderDiff();
        updateReport();
        els.exportPng.disabled = false;
        els.exportJson.disabled = false;
        var r = msg.result.residuals;
        setStatus('完成：' + msg.result.regionPixels + ' 像素，' +
          Math.round(msg.elapsedMs) + ' ms，最大相对残差 ' +
          Math.max(r[0], r[1], r[2]).toExponential(2), 'ok');
      } else if (msg.type === 'error') {
        cancelSolve();
        setStatus('求解出错：' + msg.message, 'err');
      }
    };
    worker.onerror = function (e) {
      cancelSolve();
      setStatus('Worker 错误：' + (e.message || '未知'), 'err');
    };

    var tol = parseFloat(els.tol.value);
    var maxIter = parseInt(els.maxIter.value, 10);
    worker.postMessage({
      id: id,
      params: {
        srcBytes: state.src.rgb, srcW: state.src.w, srcH: state.src.h,
        tgtBytes: state.tgt.rgb, tgtW: state.tgt.w, tgtH: state.tgt.h,
        mask: state.mask,
        dx: state.dx, dy: state.dy,
        mode: state.mode,
        tol: isFinite(tol) && tol > 0 ? tol : 1e-8,
        maxIter: isFinite(maxIter) && maxIter > 0 ? maxIter : 3000
      }
    });
  }

  // ---------- 报告与导出 ----------
  function buildReport() {
    var r = state.result;
    if (!r) return null;
    var names = ['R', 'G', 'B'];
    var perChannel = function (arr, digits) {
      var o = {};
      names.forEach(function (nm, i) {
        o[nm] = typeof arr[i] === 'number' && digits ? Number(arr[i].toExponential(digits)) : arr[i];
      });
      return o;
    };
    return {
      参数: {
        平移: { dx: state.dx, dy: state.dy },
        引导梯度: state.mode === 'mixed' ? '混合梯度' : '源梯度',
        容差: parseFloat(els.tol.value) || 1e-8,
        最大迭代: parseInt(els.maxIter.value, 10) || 3000,
        源图尺寸: [state.src.w, state.src.h],
        底图尺寸: [state.tgt.w, state.tgt.h]
      },
      有效区域像素: r.regionPixels,
      整幅选中锚点: r.anchored,
      裁剪范围: r.bbox ? { x: r.bbox.x, y: r.bbox.y, 宽: r.bbox.width, 高: r.bbox.height } : null,
      迭代次数: perChannel(r.iterations),
      相对残差: perChannel(r.residuals, 6),
      未限幅数值范围: {
        R: { min: r.rangeMin[0], max: r.rangeMax[0] },
        G: { min: r.rangeMin[1], max: r.rangeMax[1] },
        B: { min: r.rangeMin[2], max: r.rangeMax[2] }
      },
      收敛: perChannel(r.converged),
      耗时毫秒: Math.round(state.elapsedMs)
    };
  }

  function updateReport() {
    var rep = buildReport();
    els.report.textContent = rep ? JSON.stringify(rep, null, 2) : '（尚无求解结果）';
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  els.exportPng.addEventListener('click', function () {
    if (!state.result) return;
    els.viewResult.toBlob(function (blob) {
      if (blob) download(blob, 'poisson-result.png');
    }, 'image/png');
  });

  els.exportJson.addEventListener('click', function () {
    var rep = buildReport();
    if (!rep) return;
    download(new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' }), 'poisson-report.json');
  });

  // ---------- 输入事件 ----------
  function onParamChange() {
    state.dx = parseInt(els.dx.value, 10) || 0;
    state.dy = parseInt(els.dy.value, 10) || 0;
    state.mode = document.querySelector('input[name="grad-mode"]:checked').value;
    renderPaste();
    if (readyToSolve()) scheduleSolve();
  }

  els.dx.addEventListener('change', onParamChange);
  els.dy.addEventListener('change', onParamChange);
  els.tol.addEventListener('change', onParamChange);
  els.maxIter.addEventListener('change', onParamChange);
  document.querySelectorAll('input[name="grad-mode"]').forEach(function (el) {
    el.addEventListener('change', onParamChange);
  });

  els.solveBtn.addEventListener('click', function () { scheduleSolve(0); });
  els.cancelBtn.addEventListener('click', function () {
    clearTimeout(solveTimer);
    cancelSolve('已取消计算。');
  });

  els.zoom.addEventListener('change', applyZoom);
  els.diffGain.addEventListener('change', renderDiff);

  els.fileSrc.addEventListener('change', function () {
    var f = els.fileSrc.files[0];
    if (!f) return;
    decodeImage(f).then(function (img) {
      state.src = img;
      if (!state.mask || state.mask.length !== img.w * img.h) {
        state.mask = new Uint8Array(img.w * img.h); // 默认空选区
        state.maskFromFile = false;
      }
      state.result = null;
      renderAll();
      setStatus('源图已导入（' + img.w + '×' + img.h + '）。');
      if (readyToSolve()) scheduleSolve();
    }).catch(function (e) { setStatus('源图导入失败：' + e.message, 'err'); });
  });

  els.fileTgt.addEventListener('change', function () {
    var f = els.fileTgt.files[0];
    if (!f) return;
    decodeImage(f).then(function (img) {
      state.tgt = img;
      state.result = null;
      renderAll();
      setStatus('底图已导入（' + img.w + '×' + img.h + '）。');
      if (readyToSolve()) scheduleSolve();
    }).catch(function (e) { setStatus('底图导入失败：' + e.message, 'err'); });
  });

  els.fileMask.addEventListener('change', function () {
    var f = els.fileMask.files[0];
    if (!f) return;
    if (!state.src) { setStatus('请先导入源图，再导入掩膜。', 'err'); return; }
    decodeImage(f).then(function (img) {
      if (img.w !== state.src.w || img.h !== state.src.h) {
        throw new Error('掩膜尺寸（' + img.w + '×' + img.h + '）须与源图（' +
          state.src.w + '×' + state.src.h + '）一致');
      }
      var m = new Uint8Array(img.w * img.h);
      for (var i = 0, n = m.length; i < n; i++) {
        m[i] = (img.rgb[i * 3] || img.rgb[i * 3 + 1] || img.rgb[i * 3 + 2]) ? 1 : 0;
      }
      state.mask = m;
      state.maskFromFile = true;
      state.result = null;
      renderAll();
      setStatus('掩膜已导入。');
      if (readyToSolve()) scheduleSolve();
    }).catch(function (e) { setStatus('掩膜导入失败：' + e.message, 'err'); });
  });

  // 样例
  var PRESETS = {
    gradient: { src: 'source.png', tgt: 'target.png', mask: 'mask.png' },
    identity: { src: 'identity-source.png', tgt: 'target.png', mask: 'mask.png' },
    constant: { src: 'constant-source.png', tgt: 'constant-target.png', mask: 'mask.png' },
    overshoot: { src: 'overshoot-source.png', tgt: 'overshoot-target.png', mask: 'overshoot-mask.png' }
  };
  els.preset.addEventListener('change', function () {
    var p = PRESETS[els.preset.value];
    if (!p) return;
    setStatus('加载样例…', 'busy');
    var base = 'samples/cases/';
    Promise.all(['src', 'tgt', 'mask'].map(function (k) {
      return fetch(base + p[k]).then(function (r) {
        if (!r.ok) throw new Error('无法加载 ' + p[k]);
        return r.blob();
      }).then(decodeImage);
    })).then(function (imgs) {
      state.src = imgs[0];
      state.tgt = imgs[1];
      var mi = imgs[2];
      var m = new Uint8Array(mi.w * mi.h);
      for (var i = 0, n = m.length; i < n; i++) {
        m[i] = (mi.rgb[i * 3] || mi.rgb[i * 3 + 1] || mi.rgb[i * 3 + 2]) ? 1 : 0;
      }
      state.mask = m;
      state.maskFromFile = true;
      state.result = null;
      state.dx = 0; state.dy = 0;
      els.dx.value = '0'; els.dy.value = '0';
      renderAll();
      setStatus('样例已加载。', 'ok');
      scheduleSolve(0);
    }).catch(function (e) {
      setStatus('样例加载失败：' + e.message + '（需通过 HTTP 访问页面）', 'err');
    });
  });

  // ---------- 选区工具 ----------
  function maskOp(fn) {
    if (!state.src) return;
    if (!state.mask) state.mask = new Uint8Array(state.src.w * state.src.h);
    fn(state.mask);
    state.result = null;
    renderMaskView();
    if (readyToSolve()) scheduleSolve();
  }
  els.maskAll.addEventListener('click', function () { maskOp(function (m) { m.fill(1); }); });
  els.maskNone.addEventListener('click', function () { maskOp(function (m) { m.fill(0); }); });
  els.maskInvert.addEventListener('click', function () {
    maskOp(function (m) { for (var i = 0; i < m.length; i++) m[i] = m[i] ? 0 : 1; });
  });

  // ---------- 画笔 ----------
  var painting = false;
  var paintErase = false;
  var lastPaint = null;

  function canvasPos(e, canvas) {
    var rect = canvas.getBoundingClientRect();
    var z = parseFloat(els.zoom.value) || 1;
    return {
      x: Math.floor((e.clientX - rect.left) / z),
      y: Math.floor((e.clientY - rect.top) / z)
    };
  }

  function paintAt(cx, cy) {
    if (!state.src || !state.mask) return;
    var r = Math.max(1, parseInt(els.brushRadius.value, 10) || 1);
    var w = state.src.w, h = state.src.h;
    var val = paintErase ? 0 : 1;
    for (var y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (var x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        var ddx = x - cx, ddy = y - cy;
        if (ddx * ddx + ddy * ddy <= r * r) state.mask[y * w + x] = val;
      }
    }
  }

  function paintLine(a, b) {
    var steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (var i = 0; i <= steps; i++) {
      paintAt(Math.round(a.x + (b.x - a.x) * i / steps),
              Math.round(a.y + (b.y - a.y) * i / steps));
    }
  }

  els.viewMask.addEventListener('pointerdown', function (e) {
    if (!state.src) return;
    e.preventDefault();
    painting = true;
    paintErase = (e.button === 2) || (els.brushMode.value === 'erase');
    els.viewMask.setPointerCapture(e.pointerId);
    var p = canvasPos(e, els.viewMask);
    paintAt(p.x, p.y);
    lastPaint = p;
    renderMaskView();
  });
  els.viewMask.addEventListener('pointermove', function (e) {
    moveBrushCursor(e);
    if (!painting) return;
    var p = canvasPos(e, els.viewMask);
    paintLine(lastPaint, p);
    lastPaint = p;
    renderMaskView();
  });
  function endPaint() {
    if (!painting) return;
    painting = false;
    state.result = null;
    if (readyToSolve()) scheduleSolve();
  }
  els.viewMask.addEventListener('pointerup', endPaint);
  els.viewMask.addEventListener('pointercancel', endPaint);
  els.viewMask.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  els.viewMask.addEventListener('pointerleave', function () {
    els.brushCursor.style.display = 'none';
  });

  function moveBrushCursor(e) {
    if (!state.src) return;
    var z = parseFloat(els.zoom.value) || 1;
    var r = Math.max(1, parseInt(els.brushRadius.value, 10) || 1);
    var rect = els.viewMask.getBoundingClientRect();
    var box = els.viewMask.parentElement.getBoundingClientRect();
    var cur = els.brushCursor;
    cur.style.display = 'block';
    cur.style.width = (r * 2 * z) + 'px';
    cur.style.height = (r * 2 * z) + 'px';
    cur.style.left = (e.clientX - box.left - r * z) + 'px';
    cur.style.top = (e.clientY - box.top - r * z) + 'px';
  }

  // ---------- 拖动平移（在直接粘贴视图上拖动） ----------
  var dragging = false;
  var dragStart = null;
  els.viewPaste.addEventListener('pointerdown', function (e) {
    if (!state.src || !state.tgt) return;
    e.preventDefault();
    dragging = true;
    els.viewPaste.setPointerCapture(e.pointerId);
    dragStart = { x: e.clientX, y: e.clientY, dx: state.dx, dy: state.dy };
  });
  els.viewPaste.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var z = parseFloat(els.zoom.value) || 1;
    state.dx = dragStart.dx + Math.round((e.clientX - dragStart.x) / z);
    state.dy = dragStart.dy + Math.round((e.clientY - dragStart.y) / z);
    els.dx.value = state.dx;
    els.dy.value = state.dy;
    renderPaste();
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (readyToSolve()) scheduleSolve();
  }
  els.viewPaste.addEventListener('pointerup', endDrag);
  els.viewPaste.addEventListener('pointercancel', endDrag);

  // ---------- 像素探针 ----------
  function fmtRGB(bytes, i) {
    return '(' + bytes[i * 3] + ',' + bytes[i * 3 + 1] + ',' + bytes[i * 3 + 2] + ')';
  }
  function probeHandler(canvas, kind) {
    return function (e) {
      var p = canvasPos(e, canvas);
      var z = parseFloat(els.zoom.value) || 1;
      if (kind === 'mask') {
        if (!state.src || p.x < 0 || p.y < 0 || p.x >= state.src.w || p.y >= state.src.h) {
          els.probe.textContent = '—'; return;
        }
        var i = p.y * state.src.w + p.x;
        els.probe.textContent = '源 (' + p.x + ',' + p.y + ') 掩膜:' +
          (state.mask && state.mask[i] ? '选中' : '未选') +
          ' 源图:' + fmtRGB(state.src.rgb, i);
      } else {
        if (!state.tgt || p.x < 0 || p.y < 0 || p.x >= state.tgt.w || p.y >= state.tgt.h) {
          els.probe.textContent = '—'; return;
        }
        var j = p.y * state.tgt.w + p.x;
        var s = '底图 (' + p.x + ',' + p.y + ')';
        if (state.pasteBytes) s += ' 粘贴:' + fmtRGB(state.pasteBytes, j);
        if (state.resultBytes) {
          s += ' 结果:' + fmtRGB(state.resultBytes, j);
          var sol = state.result.solution;
          s += ' 线性:(' + sol[j * 3].toFixed(4) + ',' + sol[j * 3 + 1].toFixed(4) +
               ',' + sol[j * 3 + 2].toFixed(4) + ')';
        }
        els.probe.textContent = s;
      }
    };
  }
  els.viewMask.addEventListener('pointermove', probeHandler(els.viewMask, 'mask'));
  [els.viewPaste, els.viewResult, els.viewDiff].forEach(function (cv) {
    cv.addEventListener('pointermove', probeHandler(cv, 'tgt'));
  });

  // ---------- 初始化 ----------
  renderAll();
  updateReport();
})();
