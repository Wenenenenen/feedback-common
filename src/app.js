/* 页面应用层：配置编辑、画布渲染、双窗口并发烘焙、取消、版本保护、点格查询、导出。 */
(function () {
  'use strict';

  var V = self.VegetationModule();
  if (!V) {
    document.body.innerHTML = '<pre style="padding:24px;color:#f88">缺少 src/core.js</pre>';
    return;
  }

  var TREE = V.LAYER_TREE, GRASS = V.LAYER_GRASS;
  var FIXED = V.FIXED;

  /* 样例配置（去掉冗长的 rules 说明，保留约定字段） */
  var SAMPLE = {
    seed: 12,
    species: [
      [{ id: 'oak', radius: 320 }],
      [{ id: 'grass', radius: 128 }]
    ],
    base: [[1], [1]],
    patches: [
      { rect: [1, 1, 3, 2], weights: [[0], [1]] }
    ],
    window: [-3, -2, 8, 6]
  };

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) n.setAttribute(k, v);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtTiles(units) {
    var t = units / FIXED;
    return (Math.round(t * 1000) / 1000).toString();
  }
  function fmtMs(ms) {
    if (ms == null) return '—';
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  var state = {
    config: clone(SAMPLE),
    version: 0,
    ui: {
      tab: 'species',
      tool: 'inspect',
      brush: 'tree',
      drawRect: false,
      showPatches: true,
      header: false
    },
    windows: {
      A: newWindowState('A', SAMPLE.window.slice()),
      B: newWindowState('B', [SAMPLE.window[0] + SAMPLE.window[2] + 1, SAMPLE.window[1], SAMPLE.window[2], SAMPLE.window[3]])
    },
    inspect: null,
    hover: null
  };

  function rectKey(r) { return r[0] + ',' + r[1] + ',' + r[2] + ',' + r[3]; }

  function newWindowState(key, rect) {
    return {
      key: key,
      rect: rect,
      job: null,
      result: null,
      resultVersion: -1,
      resultRect: null,
      status: 'idle',
      message: '',
      elapsedMs: null
    };
  }

  /* 结果是否与当前配置版本和当前窗口矩形都匹配 */
  function resultCurrent(w) {
    return !!w.result && w.result.version === state.version &&
      w.resultRect === rectKey(w.rect);
  }

  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function notify() {
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  /* 配置变更：版本号递增，取消在算的任务，旧结果标记过期。
   * 若 mutator 没有真正改变配置（例如输入框失焦时补发的 change），
   * 不产生新版本、不取消在算任务，避免无谓地丢弃结果。 */
  function commit(mutator, opts) {
    opts = opts || {};
    var before = mutator ? JSON.stringify(state.config) : null;
    if (mutator) mutator(state.config);
    if (mutator && JSON.stringify(state.config) === before) {
      if (opts.rerender) notify();
      return false;
    }
    state.version++;
    cancelAllJobs('配置已更改');
    if (!opts.quietJson) syncJsonText();
    notify();
    return true;
  }

  function syncJsonText() {
    var ta = $('#config-json');
    if (ta) ta.value = JSON.stringify(state.config, null, 2);
  }

  /* ------------------------------------------------------------------ */
  /* 配置归一化（带缓存）                                                */
  /* ------------------------------------------------------------------ */

  var normCache = { version: -1, cfg: null, error: null };

  function normalized() {
    if (normCache.version === state.version && (normCache.cfg || normCache.error)) {
      if (normCache.error) throw normCache.error;
      return normCache.cfg;
    }
    try {
      var cfg = V.normalizeConfig(state.config);
      normCache = { version: state.version, cfg: cfg, error: null };
      return cfg;
    } catch (e) {
      normCache = { version: state.version, cfg: null, error: e };
      throw e;
    }
  }

  function tryNormalized() {
    try { return { cfg: normalized(), error: null }; }
    catch (e) { return { cfg: null, error: e }; }
  }

  /* ------------------------------------------------------------------ */
  /* Worker 任务                                                         */
  /* ------------------------------------------------------------------ */

  var workerUrl = null;

  function workerSource() {
    return [
      'var V = (' + VegetationModule.toString() + ')();',
      'self.onmessage = function (e) {',
      '  var m = e.data;',
      '  try {',
      '    var cfg = V.normalizeConfig(m.config);',
      '    var r = V.bake(cfg, m.window, { details: false });',
      '    self.postMessage({ id: m.id, ok: true, result: {',
      '      window: r.window, survivors: r.survivors, stats: r.stats, elapsedMs: r.elapsedMs',
      '    } });',
      '  } catch (err) {',
      '    self.postMessage({ id: m.id, ok: false, error: {',
      '      name: err.name || "Error", message: err.message || String(err),',
      '      validation: err.validation || null',
      '    } });',
      '  }',
      '};'
    ].join('\n');
  }

  function getWorkerUrl() {
    if (workerUrl !== null) return workerUrl;
    try {
      var blob = new Blob([workerSource()], { type: 'text/javascript' });
      workerUrl = URL.createObjectURL(blob);
    } catch (e) {
      workerUrl = '';
    }
    return workerUrl;
  }

  var jobSeq = 0;

  /*
   * 启动一个烘焙任务。返回句柄 { cancel() }。
   * onDone(version, result) 只在任务仍是该窗口的当前任务时调用。
   */
  function startJob(winKey, onDone) {
    var w = state.windows[winKey];
    if (w.job) w.job.cancel(true);

    var version = state.version;
    var rect = w.rect.slice();
    var rectSig = rectKey(rect);
    var configSnapshot = clone(state.config);
    var id = ++jobSeq;
    var cancelled = false;
    var worker = null;
    var fallbackTimer = null;
    var handle;

    function finish(result) {
      if (cancelled) return;
      if (state.windows[winKey].job !== handle) return;
      state.windows[winKey].job = null;
      // 版本或窗口矩形已变：结果作废，绝不落到新状态上
      if (version !== state.version || rectSig !== rectKey(state.windows[winKey].rect)) {
        state.windows[winKey].status = 'stale';
        state.windows[winKey].message = '配置或窗口已更改，结果已丢弃';
        notify();
        return;
      }
      state.windows[winKey].result = {
        window: result.window,
        survivors: result.survivors,
        stats: result.stats,
        elapsedMs: result.elapsedMs,
        version: version
      };
      state.windows[winKey].resultVersion = version;
      state.windows[winKey].resultRect = rectSig;
      state.windows[winKey].status = 'done';
      state.windows[winKey].message = '';
      state.windows[winKey].elapsedMs = result.elapsedMs;
      notify();
      onDone && onDone(version, state.windows[winKey].result);
    }

    function fail(err) {
      if (cancelled) return;
      if (state.windows[winKey].job !== handle) return;
      state.windows[winKey].job = null;
      state.windows[winKey].status = 'error';
      state.windows[winKey].message = (err && err.message) || String(err);
      notify();
    }

    function cleanupWorker() {
      if (worker) {
        try { worker.terminate(); } catch (e) { /* noop */ }
        worker = null;
      }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    }

    handle = {
      id: id,
      version: version,
      cancel: function (silent) {
        if (cancelled) return;
        cancelled = true;
        cleanupWorker();
        if (state.windows[winKey].job === handle) {
          state.windows[winKey].job = null;
          if (!silent) {
            state.windows[winKey].status = 'cancelled';
            state.windows[winKey].message = '已取消';
            notify();
          }
        }
      }
    };

    state.windows[winKey].job = handle;
    state.windows[winKey].status = 'running';
    state.windows[winKey].message = '';
    notify();

    var url = getWorkerUrl();
    if (url) {
      try {
        worker = new Worker(url);
        worker.onmessage = function (e) {
          var m = e.data;
          if (!m || m.id !== id) return;
          cleanupWorker();
          if (m.ok) finish(m.result); else fail(m.error);
        };
        worker.onerror = function (e) {
          cleanupWorker();
          // 退回主线程计算，保证仍可得到结果
          runFallback();
          if (e && e.message) console.warn('Worker 错误，改用主线程：', e.message);
        };
        worker.postMessage({ id: id, config: configSnapshot, window: rect });
        return handle;
      } catch (e) {
        cleanupWorker();
      }
    }
    runFallback();
    return handle;

    function runFallback() {
      fallbackTimer = setTimeout(function () {
        fallbackTimer = null;
        if (cancelled) return;
        try {
          var cfg = V.normalizeConfig(configSnapshot);
          var t0 = (self.performance && performance.now) ? performance.now() : Date.now();
          var r = V.bake(cfg, rect, {
            details: false,
            shouldCancel: function () { return cancelled; }
          });
          var t1 = (self.performance && performance.now) ? performance.now() : Date.now();
          finish({ window: r.window, survivors: r.survivors, stats: r.stats, elapsedMs: t1 - t0 });
        } catch (err) {
          if (err && err.name === 'Cancelled') return;
          fail(err);
        }
      }, 0);
    }
  }

  function cancelAllJobs(message) {
    Object.keys(state.windows).forEach(function (k) {
      var w = state.windows[k];
      if (w.job) {
        w.job.cancel(true);
        w.job = null;
        if (w.status === 'running') {
          w.status = 'stale';
          w.message = message || '已取消';
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 画布                                                                */
  /* ------------------------------------------------------------------ */

  var canvas = $('#view');
  var ctx = canvas.getContext('2d');
  var cam = { cx: 0, cy: 0, scale: 16 };
  var cssW = 1, cssH = 1, dpr = 1;
  var colors = {};
  var needDraw = false;

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['--bg', '--panel', '--line', '--text', '--muted', '--faint', '--accent',
     '--tree', '--grass', '--b-tree', '--b-grass', '--warn', '--bad'].forEach(function (k) {
      colors[k] = cs.getPropertyValue(k).trim();
    });
  }

  function resizeCanvas() {
    var r = canvas.getBoundingClientRect();
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    dpr = Math.min(2, self.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    scheduleDraw();
  }

  function scheduleDraw() {
    if (needDraw) return;
    needDraw = true;
    requestAnimationFrame(function () {
      needDraw = false;
      draw();
    });
  }

  function w2sx(wx) { return (wx - cam.cx) * cam.scale + cssW / 2; }
  function w2sy(wy) { return (wy - cam.cy) * cam.scale + cssH / 2; }
  function s2wx(sx) { return (sx - cssW / 2) / cam.scale + cam.cx; }
  function s2wy(sy) { return (sy - cssH / 2) / cam.scale + cam.cy; }

  function visibleBounds() {
    return {
      x0: s2wx(0), y0: s2wy(0),
      x1: s2wx(cssW), y1: s2wy(cssH)
    };
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = colors['--bg'] || '#0b0f0d';
    ctx.fillRect(0, 0, cssW, cssH);

    var vb = visibleBounds();
    drawGrid(vb);
    if (state.ui.showPatches) drawPatches(vb);
    drawWindows();
    drawResult('A', vb);
    drawResult('B', vb);
    drawRulers(vb);
    drawInspect();
    drawHover();
  }

  // 顶部与左侧的格坐标刻度
  function drawRulers(vb) {
    var s = cam.scale;
    if (s < 0.12) return;
    // 选一个合适的步长，让刻度间距 >= 56px
    var steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * s >= 56) { step = steps[i]; break; }
    }
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.strokeStyle = hexA(colors['--line'] || '#27332b', 0.9);
    ctx.lineWidth = 1;

    // 底部与左侧留出浅色底，保证文字在密集植被上也可读
    var stripY = 18, stripX = 44;
    ctx.fillStyle = hexA(colors['--panel'] || '#111814', 0.8);
    ctx.fillRect(0, cssH - stripY, cssW, stripY);
    ctx.fillRect(0, 0, stripX, cssH - stripY);

    ctx.fillStyle = hexA(colors['--muted'] || '#93a69a', 0.95);
    var x0 = Math.floor(vb.x0 / step) * step;
    for (var x = x0; x <= vb.x1; x += step) {
      var sx = Math.round(w2sx(x)) + 0.5;
      if (sx < stripX + 6 || sx > cssW - 8) continue;
      ctx.beginPath();
      ctx.moveTo(sx, cssH - 5);
      ctx.lineTo(sx, cssH);
      ctx.stroke();
      ctx.fillText(String(x), sx + 3, cssH - 5);
    }

    var y0 = Math.floor(vb.y0 / step) * step;
    for (var y = y0; y <= vb.y1; y += step) {
      var sy = Math.round(w2sy(y)) + 0.5;
      if (sy < 10 || sy > cssH - stripY) continue;
      ctx.beginPath();
      ctx.moveTo(stripX - 4, sy);
      ctx.lineTo(stripX, sy);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(y), stripX - 6, sy + 3.5);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  function drawGrid(vb) {
    var s = cam.scale;
    if (s < 5) return;
    var x0 = Math.floor(vb.x0), x1 = Math.ceil(vb.x1);
    var y0 = Math.floor(vb.y0), y1 = Math.ceil(vb.y1);
    if ((x1 - x0) > 800 || (y1 - y0) > 800) return;
    ctx.save();
    ctx.strokeStyle = colors['--line'] || '#27332b';
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = x0; x <= x1; x++) {
      var sx = Math.round(w2sx(x)) + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
    }
    for (var y = y0; y <= y1; y++) {
      var sy = Math.round(w2sy(y)) + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawPatches(vb) {
    var patches = state.config.patches || [];
    ctx.save();
    ctx.lineWidth = 1.5;
    for (var i = 0; i < patches.length; i++) {
      var r = patches[i].rect;
      if (!r || r.length !== 4) continue;
      var x = w2sx(r[0]), y = w2sy(r[1]);
      var w = r[2] * cam.scale, h = r[3] * cam.scale;
      if (x + w < 0 || y + h < 0 || x > cssW || y > cssH) continue;
      ctx.fillStyle = hexA(colors['--accent'] || '#7ee787', 0.06);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hexA(colors['--accent'] || '#7ee787', 0.5);
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w), Math.max(1, h));
      ctx.setLineDash([]);
      if (w > 26 && h > 16) {
        ctx.fillStyle = hexA(colors['--accent'] || '#7ee787', 0.85);
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('P' + (i + 1), x + 4, y + 12);
      }
    }
    ctx.restore();

    // 正在拖出的矩形：实时预览
    if (drag && drag.kind === 'rect') {
      var dr = rectFromDrag(drag);
      var rx = w2sx(dr[0]), ry = w2sy(dr[1]);
      var rw = dr[2] * cam.scale, rh = dr[3] * cam.scale;
      ctx.save();
      ctx.strokeStyle = colors['--accent'] || '#7ee787';
      ctx.fillStyle = hexA(colors['--accent'] || '#7ee787', 0.16);
      ctx.lineWidth = 2;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw), Math.max(1, rh));
      ctx.restore();
    }
  }

  function drawWindows() {
    ['A', 'B'].forEach(function (key) {
      var win = state.windows[key];
      var r = win.rect;
      var color = key === 'A' ? (colors['--tree'] || '#6ee7a8') : (colors['--b-tree'] || '#5cc8ff');
      var x = w2sx(r[0]), y = w2sy(r[1]);
      var w = r[2] * cam.scale, h = r[3] * cam.scale;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hexA(color, 0.95);
      ctx.setLineDash(key === 'A' ? [7, 5] : [2, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w), Math.max(1, h));
      ctx.setLineDash([]);
      // 角标
      var lx = clamp(x + 6, 2, cssW - 30), ly = clamp(y + 6, 2, cssH - 24);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      var label = '窗口 ' + key;
      var tw = ctx.measureText(label).width;
      ctx.fillStyle = hexA(colors['--panel'] || '#111814', 0.82);
      ctx.fillRect(lx - 3, ly - 1, tw + 6, 16);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly + 11);
      ctx.restore();
    });
  }

  function drawResult(key, vb) {
    var win = state.windows[key];
    if (!win.result) return;
    var stale = !resultCurrent(win);
    var treeColor = key === 'A' ? colors['--tree'] : colors['--b-tree'];
    var grassColor = key === 'A' ? colors['--grass'] : colors['--b-grass'];
    var alpha = stale ? 0.28 : 1;
    var list = win.result.survivors;

    // 树
    drawDots(list, TREE, treeColor, alpha, true);
    // 草
    drawDots(list, GRASS, grassColor, alpha, false);
  }

  function drawDots(list, layer, color, alpha, isTree) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    var s = cam.scale;
    ctx.beginPath();
    var drawn = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.layer !== layer) continue;
      var sx = w2sx(c.px / FIXED), sy = w2sy(c.py / FIXED);
      if (sx < -20 || sy < -20 || sx > cssW + 20 || sy > cssH + 20) continue;
      var rad = (c.radius / FIXED) * s;
      if (rad < 0.7) rad = 0.7;
      ctx.moveTo(sx + rad, sy);
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      drawn++;
    }
    ctx.fill();
    if (isTree && s > 3) {
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
    return drawn;
  }

  function drawInspect() {
    if (!state.inspect) return;
    var x = state.inspect.x, y = state.inspect.y;
    var sx = w2sx(x), sy = w2sy(y), s = cam.scale;
    ctx.save();
    ctx.strokeStyle = colors['--accent'] || '#7ee787';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, s, s);
    ctx.fillStyle = hexA(colors['--accent'] || '#7ee787', 0.18);
    ctx.fillRect(sx, sy, s, s);
    ctx.restore();
  }

  function drawHover() {
    if (!state.hover || state.ui.tool !== 'inspect' && !state.ui.drawRect) {
      if (!state.hover) return;
    }
    var x = state.hover.x, y = state.hover.y;
    var sx = w2sx(x), sy = w2sy(y), s = cam.scale;
    ctx.save();
    ctx.strokeStyle = hexA(colors['--muted'] || '#93a69a', 0.65);
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, s, s);
    ctx.restore();
  }

  function hexA(hex, a) {
    if (!hex) return 'rgba(0,0,0,' + a + ')';
    hex = hex.trim();
    if (hex[0] !== '#') return hex;
    if (hex.length === 4) {
      hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function fitRect(rect, margin) {
    margin = margin || 0.12;
    var w = Math.max(1, rect[2]), h = Math.max(1, rect[3]);
    var scale = Math.min(cssW / (w * (1 + margin * 2)), cssH / (h * (1 + margin * 2)));
    cam.scale = clamp(scale, 0.05, 200);
    cam.cx = rect[0] + w / 2;
    cam.cy = rect[1] + h / 2;
    scheduleDraw();
  }

  /* ------------------------------------------------------------------ */
  /* 画布交互                                                            */
  /* ------------------------------------------------------------------ */

  var drag = null;

  function canvasPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function tileAt(sx, sy) {
    return { x: Math.floor(s2wx(sx)), y: Math.floor(s2wy(sy)) };
  }

  canvas.addEventListener('pointermove', function (e) {
    var p = canvasPoint(e);
    var t = tileAt(p.x, p.y);

    if (drag) {
      if (drag.kind === 'pan') {
        cam.cx = drag.cx - (p.x - drag.sx) / cam.scale;
        cam.cy = drag.cy - (p.y - drag.sy) / cam.scale;
        scheduleDraw();
      } else if (drag.kind === 'rect') {
        drag.cur = t;
        scheduleDraw();
        $('#hud').textContent = '地块 ' + rectFromDrag(drag).join(', ');
      }
      return;
    }

    state.hover = t;
    updateHud(t);
    scheduleDraw();
  });

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    canvas.setPointerCapture(e.pointerId);
    var p = canvasPoint(e);
    var t = tileAt(p.x, p.y);
    var panning = e.button === 1 || e.altKey || state.ui.tool === 'pan';
    if (panning) {
      drag = { kind: 'pan', sx: p.x, sy: p.y, cx: cam.cx, cy: cam.cy };
      canvas.classList.add('panning');
    } else if (state.ui.drawRect) {
      drag = { kind: 'rect', start: t, cur: t };
      canvas.classList.add('painting');
    } else {
      drag = { kind: 'click', start: t, sx: p.x, sy: p.y, moved: false };
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (drag && drag.kind === 'click') {
      var p = canvasPoint(e);
      if (Math.abs(p.x - drag.sx) + Math.abs(p.y - drag.sy) > 4) drag.moved = true;
    }
  });

  canvas.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    canvas.classList.remove('panning', 'painting');
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }

    if (d.kind === 'rect') {
      var rect = rectFromDrag(d);
      if (rect[2] > 0 && rect[3] > 0) addPatchFromBrush(rect);
    } else if (d.kind === 'click' && !d.moved) {
      inspectTile(d.start.x, d.start.y);
    }
  });

  canvas.addEventListener('pointercancel', function () {
    drag = null;
    canvas.classList.remove('panning', 'painting');
  });

  canvas.addEventListener('pointerleave', function () {
    if (!drag) { state.hover = null; scheduleDraw(); }
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = canvasPoint(e);
    var wx = s2wx(p.x), wy = s2wy(p.y);
    var factor = Math.pow(1.0015, -e.deltaY);
    var next = clamp(cam.scale * factor, 0.05, 200);
    var ratio = next / cam.scale;
    cam.cx = wx - (wx - cam.cx) / ratio;
    cam.cy = wy - (wy - cam.cy) / ratio;
    cam.scale = next;
    scheduleDraw();
  }, { passive: false });

  function rectFromDrag(d) {
    var x0 = Math.min(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y);
    var x1 = Math.max(d.start.x, d.cur.x) + 1, y1 = Math.max(d.start.y, d.cur.y) + 1;
    return [x0, y0, x1 - x0, y1 - y0];
  }

  function updateHud(t) {
    if (!t) return;
    var s = '格 (' + fmt(t.x) + ', ' + fmt(t.y) + ') · 定点 (' + fmt(t.x * FIXED) + ', ' + fmt(t.y * FIXED) + ')';
    $('#hud').textContent = s;
  }

  /* ------------------------------------------------------------------ */
  /* 地表：画笔、patches、base                                           */
  /* ------------------------------------------------------------------ */

  function addPatchFromBrush(rect) {
    var cfg = state.config;
    if (!cfg.patches) cfg.patches = [];
    if (cfg.patches.length >= V.MAX_PATCHES) {
      toast('patches 已达上限 ' + V.MAX_PATCHES, 'warn');
      return;
    }
    var brush = state.ui.brush;
    var treeN = (cfg.species[0] || []).length;
    var grassN = (cfg.species[1] || []).length;
    var tw = cfg.base[0] ? cfg.base[0].slice() : new Array(treeN).fill(0);
    var gw = cfg.base[1] ? cfg.base[1].slice() : new Array(grassN).fill(0);
    var weights;
    if (brush === 'tree') weights = [tw, zeros(grassN)];
    else if (brush === 'grass') weights = [zeros(treeN), gw];
    else if (brush === 'empty') weights = [zeros(treeN), zeros(grassN)];
    else weights = [null, null];

    commit(function (c) {
      c.patches.push({ rect: rect.slice(), weights: clone(weights) });
    });
    toast('已添加地块 P' + state.config.patches.length + '：' + rect.join(', '));
    renderGround();
  }

  function zeros(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a; }

  function renderGround() {
    var cfg = state.config;
    var patches = cfg.patches || [];
    $('#patch-count').textContent = String(patches.length);

    var list = $('#patch-list');
    list.textContent = '';
    if (!patches.length) {
      list.appendChild(el('div', { class: 'empty', text: '还没有地块。拖出矩形，或添加一项。' }));
    }
    patches.forEach(function (pt, i) {
      list.appendChild(patchRow(pt, i));
    });

    renderBaseEditor();
  }

  function patchRow(pt, i) {
    var species = state.config.species;
    var node = el('div', { class: 'patch-row' });
    var head = el('div', { class: 'head' }, [
      el('span', { class: 'idx', text: 'P' + (i + 1) }),
      el('span', { class: 'hint', text: '后项覆盖前项' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn ghost icon-btn', title: '删除该地块', text: '✕',
        onclick: function () {
          commit(function (c) { c.patches.splice(i, 1); });
          renderGround();
        }
      })
    ]);
    node.appendChild(head);

    var rectGrid = el('div', { class: 'rect' });
    ['x', 'y', 'w', 'h'].forEach(function (name, k) {
      var cell = el('div');
      cell.appendChild(el('label', { text: name }));
      var input = el('input', {
        type: 'number', step: '1', value: String(pt.rect[k])
      });
      input.addEventListener('change', function () {
        var v = parseInt(input.value, 10);
        if (!isFinite(v)) { input.value = String(pt.rect[k]); return; }
        if ((k === 2 || k === 3) && v < 1) v = 1;
        commit(function (c) { c.patches[i].rect[k] = v; }, { quietJson: false });
        renderGround();
      });
      cell.appendChild(input);
      rectGrid.appendChild(cell);
    });
    node.appendChild(rectGrid);

    [0, 1].forEach(function (layer) {
      var row = el('div', { class: 'wrow' }, [
        el('span', { text: layer === 0 ? '树' : '草' })
      ]);
      var spec = species[layer] || [];
      var wArr = pt.weights ? pt.weights[layer] : null;
      spec.forEach(function (sp, si) {
        var val = (wArr && wArr[si] != null) ? String(wArr[si]) : '';
        var input = el('input', {
          type: 'number', min: '0', max: '65535', step: '1',
          placeholder: '继承', title: sp.id + ' 权重（留空=继承）', value: val
        });
        input.addEventListener('change', function () {
          var raw = input.value.trim();
          commit(function (c) {
            var p = c.patches[i];
            if (!p.weights) p.weights = [null, null];
            if (!p.weights[layer]) p.weights[layer] = zeros(spec.length);
            if (raw === '') {
              // 置空：若该层全空则整体置 null
              p.weights[layer][si] = null;
              var any = false;
              for (var q = 0; q < p.weights[layer].length; q++) {
                if (p.weights[layer][q] != null) any = true;
              }
              if (!any) p.weights[layer] = null;
            } else {
              var v = parseInt(raw, 10);
              p.weights[layer][si] = isFinite(v) ? clamp(v, 0, 65535) : 0;
            }
          });
          renderGround();
        });
        row.appendChild(input);
      });
      node.appendChild(row);
    });

    return node;
  }

  function renderBaseEditor() {
    var host = $('#base-editor');
    host.textContent = '';
    [0, 1].forEach(function (layer) {
      var wrap = el('div', { style: 'margin-bottom:8px' });
      wrap.appendChild(el('div', {
        class: 'hint', style: 'margin-bottom:4px',
        text: layer === 0 ? '树层' : '草层'
      }));
      var row = el('div', { class: 'wrow', style: 'display:flex;gap:6px;align-items:center' });
      var species = state.config.species[layer] || [];
      if (!species.length) row.appendChild(el('span', { class: 'hint', text: '（尚无物种）' }));
      species.forEach(function (sp, si) {
        var box = el('div', { style: 'display:flex;gap:4px;align-items:center;flex:1;min-width:0' });
        box.appendChild(el('span', {
          class: 'hint', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
          text: sp.id
        }));
        var input = el('input', {
          type: 'number', min: '0', max: '65535', step: '1',
          value: String((state.config.base[layer] && state.config.base[layer][si]) || 0),
          style: 'width:64px'
        });
        input.addEventListener('change', function () {
          var v = parseInt(input.value, 10);
          commit(function (c) { c.base[layer][si] = isFinite(v) ? clamp(v, 0, 65535) : 0; });
          renderBaseEditor();
        });
        box.appendChild(input);
        row.appendChild(box);
      });
      wrap.appendChild(row);
      host.appendChild(wrap);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 物种                                                                */
  /* ------------------------------------------------------------------ */

  function renderSpecies() {
    [0, 1].forEach(function (layer) {
      var host = $(layer === 0 ? '#tree-species' : '#grass-species');
      host.textContent = '';
      var arr = state.config.species[layer] || [];
      if (!arr.length) {
        host.appendChild(el('div', { class: 'empty', text: '该层暂无物种' }));
      }
      arr.forEach(function (sp, i) {
        host.appendChild(speciesRow(layer, sp, i, arr.length));
      });
    });
  }

  function speciesRow(layer, sp, i, count) {
    var node = el('div', { class: 'species-row' });
    var color = layer === 0 ? 'var(--tree)' : 'var(--grass)';
    var top = el('div', { class: 'top' }, [
      el('span', {
        class: 'badge', text: '#' + i,
        style: 'border-color:' + color + ';color:' + color
      })
    ]);
    var idInput = el('input', { class: 'id', type: 'text', value: sp.id, 'aria-label': '物种名' });
    idInput.addEventListener('change', function () {
      var v = idInput.value.trim();
      if (!v) { idInput.value = sp.id; return; }
      commit(function (c) { c.species[layer][i].id = v; });
      renderSpecies();
      renderGround();
    });
    top.appendChild(idInput);

    var radInput = el('input', {
      class: 'rad', type: 'number', step: '0.00390625', min: '0.00390625', max: '32',
      value: String(Math.round(sp.radius / FIXED * 1000) / 1000),
      title: '半径（格）'
    });
    var radHint = el('span', {
      class: 'hint', style: 'white-space:nowrap',
      text: (Math.round(sp.radius / FIXED * 1000) / 1000) + '格'
    });
    radInput.addEventListener('change', function () {
      var tiles = parseFloat(radInput.value);
      if (!isFinite(tiles)) { radInput.value = String(sp.radius / FIXED); return; }
      var units = clamp(Math.round(tiles * FIXED), 1, V.MAX_RADIUS);
      commit(function (c) { c.species[layer][i].radius = units; });
      radInput.value = String(units / FIXED);
      radHint.textContent = fmtTiles(units) + '格（' + units + '/256）';
      scheduleDraw();
    });
    top.appendChild(el('span', { class: 'hint', text: '格' }));
    top.appendChild(radInput);
    if (count > 1) {
      top.appendChild(el('button', {
        class: 'btn ghost icon-btn', title: '删除物种', text: '✕',
        onclick: function () { removeSpecies(layer, i); }
      }));
    }
    node.appendChild(top);
    var row2 = el('div', { class: 'row2' }, [
      el('span', { text: '半径 ' + fmtTiles(sp.radius) + ' 格' }),
      el('span', { text: '= ' + sp.radius + ' / 256 格' })
    ]);
    node.appendChild(row2);
    return node;
  }

  function addSpecies(layer) {
    var arr = state.config.species[layer];
    if (arr.length >= V.MAX_SPECIES) { toast('每层最多 ' + V.MAX_SPECIES + ' 种', 'warn'); return; }
    commit(function (c) {
      c.species[layer].push({ id: (layer === 0 ? 'tree' : 'grass') + (c.species[layer].length + 1), radius: layer === 0 ? FIXED : Math.round(FIXED / 2) });
      c.base[layer].push(0);
      (c.patches || []).forEach(function (p) {
        if (p.weights && p.weights[layer]) p.weights[layer].push(0);
      });
    });
    renderSpecies();
    renderGround();
  }

  function removeSpecies(layer, i) {
    var arr = state.config.species[layer];
    if (arr.length <= 1) { toast('每层至少保留一种物种', 'warn'); return; }
    commit(function (c) {
      c.species[layer].splice(i, 1);
      c.base[layer].splice(i, 1);
      (c.patches || []).forEach(function (p) {
        if (p.weights && p.weights[layer]) {
          p.weights[layer].splice(i, 1);
          if (!p.weights[layer].length) p.weights[layer] = null;
        }
      });
    });
    renderSpecies();
    renderGround();
  }

  /* ------------------------------------------------------------------ */
  /* 窗口                                                                */
  /* ------------------------------------------------------------------ */

  function renderWindows() {
    var host = $('#window-cards');
    host.textContent = '';
    ['A', 'B'].forEach(function (key) {
      host.appendChild(windowCard(key));
    });
  }

  function windowCard(key) {
    var w = state.windows[key];
    var card = el('div', { class: 'window-card' });

    var swatchClass = key === 'A' ? 'swatch-win-a' : 'swatch-win-b';
    var head = el('div', { class: 'head' }, [
      el('span', { class: 'swatch ' + swatchClass, style: 'width:10px;height:10px;border-radius:3px' }),
      el('span', { class: 'name', text: '窗口 ' + key }),
      el('span', { class: 'key', text: key === 'A' ? '主窗口' : '并行对比' }),
      el('span', { class: 'spacer' })
    ]);
    var chipHost = el('span');
    head.appendChild(chipHost);
    card.appendChild(head);

    var row = el('div', { class: 'row' });
    var rectInputs = [];
    ['x', 'y', 'w', 'h'].forEach(function (name, k) {
      var cell = el('div', { class: 'cell' });
      cell.appendChild(el('label', { text: name }));
      var input = el('input', {
        type: 'number', step: '1', value: String(w.rect[k])
      });
      input.addEventListener('change', function () {
        var v = parseInt(input.value, 10);
        if (!isFinite(v)) { input.value = String(w.rect[k]); return; }
        if ((k === 2 || k === 3) && (v < 1 || v > V.MAX_WINDOW_SIDE)) {
          v = clamp(v, 1, V.MAX_WINDOW_SIDE);
          input.value = String(v);
        }
        if (w.rect[k] === v) return;          // 值未变不丢弃结果
        w.rect[k] = v;
        // 窗口位置改变：取消在算任务，旧结果作废（不允许旧矩形的结果落到新矩形上）
        if (w.job) w.job.cancel(true);
        w.job = null;
        if (w.status === 'running') w.status = 'stale';
        w.resultRect = null;
        w.resultVersion = -1;
        scheduleDraw();
        refresh();
        renderInspector();
      });
      rectInputs.push(input);
      cell.appendChild(input);
      row.appendChild(cell);
    });
    card.appendChild(row);

    var actions = el('div', { class: 'actions' });
    var runBtn = el('button', { class: 'btn primary', text: '计算' });
    runBtn.addEventListener('click', function () { runWindow(key); });
    actions.appendChild(runBtn);

    var cancelBtn = el('button', {
      class: 'btn danger', text: '取消',
      onclick: function () {
        if (w.job) w.job.cancel(false);
        refresh();
      }
    });

    var expBtn = el('button', { class: 'btn', text: '导出 TSV' });
    expBtn.addEventListener('click', function () { exportWindow(key); });
    actions.appendChild(expBtn);

    var copyBtn = el('button', { class: 'btn ghost', text: '复制' });
    copyBtn.addEventListener('click', function () { copyWindow(key); });
    actions.appendChild(copyBtn);

    actions.appendChild(el('button', {
      class: 'btn ghost', text: '定位',
      onclick: function () { fitRect(w.rect); }
    }));
    card.appendChild(actions);

    var status = el('div', { class: 'status' });
    card.appendChild(status);

    // 就地刷新动态部分：坐标输入框不重建，连续编辑不会失焦
    function refresh() {
      var cur = resultCurrent(w);
      var stale = w.result && !cur;

      chipHost.textContent = '';
      chipHost.appendChild(statusChip(w));

      runBtn.textContent = w.status === 'running' ? '计算中…' : '计算';
      runBtn.disabled = w.status === 'running';
      expBtn.disabled = !cur;
      copyBtn.disabled = !cur;

      var hasCancel = cancelBtn.parentNode === actions;
      if (w.status === 'running' && !hasCancel) actions.insertBefore(cancelBtn, expBtn);
      else if (w.status !== 'running' && hasCancel) actions.removeChild(cancelBtn);

      var bits = [];
      if (w.status === 'running') bits.push('计算中…');
      if (w.status === 'cancelled') bits.push('已取消');
      if (w.status === 'error') bits.push('错误：' + w.message);
      if (w.status === 'stale') bits.push(w.message || '结果已过期');
      if (w.result) {
        var s = w.result.stats;
        var counts = countLayers(w.result.survivors);
        bits.push('导出 树 ' + fmt(counts.tree) + ' / 草 ' + fmt(counts.grass));
        bits.push('总候选 ' + fmt(s.treeCandidates + s.grassCandidates));
        bits.push('用时 ' + fmtMs(w.result.elapsedMs));
        if (stale) bits.push('⚠ 配置或窗口已更改，请重新计算');
      }
      if (!bits.length) bits.push('尚未计算');
      status.textContent = bits.join(' · ');
      status.className = 'status';
      if (w.status === 'error') status.className = 'status bad';
      else if (stale) status.className = 'status stale';
      else if (w.status === 'done' && cur) status.className = 'status ok';
    }

    card._refresh = refresh;
    refresh();
    return card;
  }

  function refreshWindowCards() {
    $$('.window-card').forEach(function (card) {
      if (card._refresh) card._refresh();
    });
  }

  function countLayers(list) {
    var tree = 0, grass = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].layer === TREE) tree++; else grass++;
    }
    return { tree: tree, grass: grass };
  }

  function statusChip(w) {
    var cls = 'chip', dotClass = 'dot';
    var text = '就绪';
    if (w.status === 'running') { text = '计算中'; dotClass += ' run'; }
    else if (w.status === 'done' && resultCurrent(w)) { text = '已完成'; dotClass += ' ok'; }
    else if (w.status === 'done') { text = '过期'; dotClass += ' bad'; }
    else if (w.status === 'error') { text = '错误'; dotClass += ' bad'; }
    else if (w.status === 'cancelled') { text = '已取消'; }
    else if (w.status === 'stale') { text = '过期'; dotClass += ' bad'; }
    return el('span', { class: cls }, [el('span', { class: dotClass }), el('span', { text: text })]);
  }

  function runWindow(key) {
    var w = state.windows[key];
    if (!validWindow(w.rect)) {
      toast('窗口无效：宽高须在 1..' + V.MAX_WINDOW_SIDE + ' 格', 'bad');
      return;
    }
    var n = tryNormalized();
    if (n.error) {
      toast('配置有误，无法计算：' + n.error.message.split('\n')[0], 'bad');
      renderConfigErrors(n.error);
      return;
    }
    startJob(key, function () {
      // 结果落地后刷新画布与面板
      scheduleDraw();
      refreshWindowCards();
      renderInspector();
      var r = state.windows[key].result;
      if (r) {
        toast('窗口 ' + key + ' 完成：' + fmt(r.survivors.length) + ' 个导出候选，用时 ' + fmtMs(r.elapsedMs));
      }
    });
    scheduleDraw();
    refreshWindowCards();
  }

  function validWindow(r) {
    return r && r.length === 4 &&
      r[2] > 0 && r[3] > 0 && r[2] <= V.MAX_WINDOW_SIDE && r[3] <= V.MAX_WINDOW_SIDE &&
      Math.abs(r[0]) <= V.MAX_COORD && Math.abs(r[1]) <= V.MAX_COORD;
  }

  function exportWindow(key) {
    var w = state.windows[key];
    if (!resultCurrent(w)) {
      toast('结果已过期，请重新计算后再导出', 'warn');
      return;
    }
    var text = V.exportText(w.result, { header: state.ui.header });
    var name = 'vegetation_' + key + '_' + w.result.window.join('_') + '.tsv';
    download(name, text, 'text/tab-separated-values');
    toast('已导出 ' + w.result.survivors.length + ' 行');
  }

  function copyWindow(key) {
    var w = state.windows[key];
    if (!resultCurrent(w)) {
      toast('结果已过期，请重新计算后再复制', 'warn');
      return;
    }
    var text = V.exportText(w.result, { header: state.ui.header });
    copyText(text).then(function () { toast('已复制 ' + w.result.survivors.length + ' 行'); });
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------------ */
  /* 检查器                                                              */
  /* ------------------------------------------------------------------ */

  function inspectTile(x, y) {
    state.inspect = { x: x, y: y, data: null, error: null, version: state.version };
    renderInspector();
    scheduleDraw();

    var n = tryNormalized();
    if (n.error) {
      state.inspect.error = n.error;
      renderInspector();
      return;
    }
    try {
      var q = V.queryTile(n.cfg, x, y);
      state.inspect.data = q;
      state.inspect.version = state.version;
    } catch (e) {
      state.inspect.error = e;
    }
    renderInspector();
  }

  function renderInspector() {
    var coord = $('#inspect-coord');
    var body = $('#inspect-body');
    if (!state.inspect) return;

    var x = state.inspect.x, y = state.inspect.y;
    coord.textContent = '格 (' + fmt(x) + ', ' + fmt(y) + ') · 定点 (' + fmt(x * FIXED) + ', ' + fmt(y * FIXED) + ')';

    body.textContent = '';
    if (state.inspect.error) {
      body.appendChild(el('div', { class: 'empty' }, [
        el('div', { text: '配置有误，无法查询该格。' }),
        el('div', { class: 'err-text', text: state.inspect.error.message })
      ]));
      return;
    }
    var d = state.inspect.data;
    if (!d) return;

    [TREE, GRASS].forEach(function (layer) {
      body.appendChild(layerCard(d, layer));
    });

    var inA = inside(d.x, d.y, state.windows.A.rect);
    var inB = inside(d.x, d.y, state.windows.B.rect);
    var info = el('div', { class: 'hint', style: 'margin-top:6px' });
    info.textContent = '该格位于 ' + (inA ? '窗口 A ' : '') + (inB ? '窗口 B' : '') +
      (inA || inB ? ' 内（会被导出）' : '两个窗口之外（只参与判断，不导出）');
    body.appendChild(info);
  }

  function inside(x, y, r) {
    return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  }

  function layerCard(d, layer) {
    var entry = layer === TREE ? d.tree : d.grass;
    var weights = layer === TREE ? d.weights.tree : d.weights.grass;
    var species = state.config.species[layer] || [];
    var card = el('div', { class: 'layer-card' });

    var title = el('h3', {}, [
      el('span', { class: 'swatch ' + (layer === TREE ? 'swatch-tree' : 'swatch-grass'),
        style: 'width:9px;height:9px;border-radius:2px' }),
      el('span', { text: layer === TREE ? '树层' : '草层' }),
      el('span', { class: 'tag', text: 'layer ' + layer })
    ]);
    card.appendChild(title);

    if (!entry) {
      var zeroTotal = (weights || []).reduce(function (a, b) { return a + b; }, 0);
      card.appendChild(el('div', { class: 'status-chip none', text: '无候选' }));
      card.appendChild(el('div', {
        class: 'hint', style: 'margin-top:6px',
        text: zeroTotal === 0
          ? '该层在此格总权重为 0，因此不产生候选。'
          : '哈希取余没有落入任何物种段（权重和 ' + zeroTotal + '）。'
      }));
      if (zeroTotal > 0) {
        var specNames = (state.config.species[layer] || []).map(function (s, si) {
          return s.id + '=' + (weights[si] || 0);
        });
        card.appendChild(el('div', { class: 'hint', text: '权重：' + specNames.join(' / ') }));
      }
      return card;
    }

    var chip;
    if (entry.kept) chip = el('span', { class: 'status-chip kept', text: '✓ 保留' });
    else if (entry.reason === 'tree') chip = el('span', { class: 'status-chip elim', text: '✕ 被树淘汰' });
    else if (entry.reason === 'grass') chip = el('span', { class: 'status-chip elim', text: '✕ 被草淘汰' });
    else chip = el('span', { class: 'status-chip none', text: '状态未知' });
    card.appendChild(chip);

    var sp = species[entry.species];
    var kv = el('dl', { class: 'kv', style: 'margin-top:8px' });
    addKV(kv, '物种', (sp ? sp.id : '#' + entry.species) + '（#' + entry.species + '）');
    addKV(kv, '定点位置', entry.px + ', ' + entry.py);
    addKV(kv, '半径', entry.radius + '/256 格（' + fmtTiles(entry.radius) + ' 格）');
    addKV(kv, '排序键', String(entry.rank));
    addKV(kv, '格内偏移', (entry.px - entry.x * FIXED) + ', ' + (entry.py - entry.y * FIXED));
    card.appendChild(kv);

    if (entry.blocker) {
      var b = entry.blocker;
      var bsp = (state.config.species[b.layer] || [])[b.species];
      var dx = entry.px - b.px, dy = entry.py - b.py;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var greater = Math.max(entry.radius, b.radius);
      var box = el('div', { class: 'blocker' }, [
        el('div', {}, [
          el('span', { class: 'arrow', text: '↑ 被更高排序者挡住：' })
        ]),
        el('div', {
          text: (b.layer === 0 ? '树' : '草') + ' (' + b.x + ', ' + b.y + ')' +
            ' · ' + (bsp ? bsp.id : '#' + b.species) +
            ' · 半径 ' + b.radius + '/256'
        }),
        el('div', {
          text: '距离 ' + dist.toFixed(1) + ' / 256 格，阈值 ' + greater + ' / 256 格' +
            '（' + (dist < greater ? '严格小于 → 淘汰' : '不小于 → 不淘汰') + '）'
        })
      ]);
      card.appendChild(box);
    }

    return card;
  }

  function addKV(dl, k, v) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v }));
  }

  /* ------------------------------------------------------------------ */
  /* 配置 JSON                                                           */
  /* ------------------------------------------------------------------ */

  function renderConfigErrors(err) {
    var host = $('#config-errors');
    if (!err) { host.textContent = ''; return; }
    var lines = err.validation && err.validation.length ? err.validation : [err.message];
    host.textContent = lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n…' : '');
  }

  function applyJson() {
    var ta = $('#config-json');
    var parsed;
    try {
      parsed = JSON.parse(ta.value);
    } catch (e) {
      toast('JSON 解析失败：' + e.message, 'bad');
      renderConfigErrors({ message: 'JSON 解析失败：' + e.message });
      return;
    }
    var next = {
      seed: parsed.seed,
      species: parsed.species,
      base: parsed.base,
      patches: parsed.patches === undefined ? [] : parsed.patches,
      window: parsed.window || state.config.window
    };
    // 先校验，避免把无效配置放进状态
    try {
      V.normalizeConfig(ptClone(next));
    } catch (e) {
      toast('配置校验未通过，未应用', 'bad');
      renderConfigErrors(e);
      return;
    }
    state.config = ptClone(next);
    if (parsed.rules) state.config.rules = parsed.rules;
    $('#seed').value = String(state.config.seed);
    state.windows.A.rect = state.config.window.slice();
    commit(null, { quietJson: true });
    renderConfigErrors(null);
    ta.value = JSON.stringify(state.config, null, 2);
    fullRender();
    fitRect(state.windows.A.rect);
    toast('配置已应用');
  }

  // 保留 rules 等额外字段的结构化克隆（JSON 语义即可）
  function ptClone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------------ */
  /* 提示条                                                              */
  /* ------------------------------------------------------------------ */

  function toast(msg, kind) {
    var stack = $('#toasts');
    var node = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    stack.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .3s, transform .3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(4px)';
      setTimeout(function () { node.remove(); }, 320);
    }, 3200);
  }

  /* ------------------------------------------------------------------ */
  /* 全局状态指示                                                        */
  /* ------------------------------------------------------------------ */

  function updateGlobalStatus() {
    var dot = $('#global-dot'), text = $('#global-text');
    var running = 0, done = 0, stale = 0, error = 0;
    ['A', 'B'].forEach(function (k) {
      var w = state.windows[k];
      if (w.status === 'running') running++;
      if (resultCurrent(w)) done++;
      else if (w.result || w.status === 'stale') stale++;
      if (w.status === 'error') error++;
    });
    dot.className = 'dot';
    if (error) { dot.className = 'dot bad'; text.textContent = '有错误'; }
    else if (running) { dot.className = 'dot run'; text.textContent = '计算中 ×' + running; }
    else if (state.version > 0 && (stale || done)) {
      if (stale) { dot.className = 'dot'; text.textContent = '结果已过期'; }
      else { dot.className = 'dot ok'; text.textContent = '就绪'; }
    } else { text.textContent = '就绪'; }
  }

  /* ------------------------------------------------------------------ */
  /* 渲染总入口                                                          */
  /* ------------------------------------------------------------------ */

  function fullRender() {
    renderSpecies();
    renderGround();
    renderWindows();
    renderInspector();
    updateGlobalStatus();
    scheduleDraw();
  }

  onChange(function () {
    updateGlobalStatus();
    scheduleDraw();
    refreshWindowCards();
    // 配置一变，检查器里的结论就过期了：重新查询当前格
    if (state.inspect) inspectTile(state.inspect.x, state.inspect.y);
    else renderInspector();
  });

  /* ------------------------------------------------------------------ */
  /* 绑定静态控件                                                        */
  /* ------------------------------------------------------------------ */

  function bindStatic() {
    var seed = $('#seed');
    seed.addEventListener('change', function () {
      var v = parseInt(seed.value, 10);
      if (!isFinite(v)) { seed.value = String(state.config.seed); return; }
      if (v === state.config.seed) return;   // 值未变不产生新版本
      commit(function (c) { c.seed = v; });
      updateGlobalStatus();
    });

    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-tab');
        state.ui.tab = name;
        $$('.tab').forEach(function (t) {
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        $$('.tab-panel').forEach(function (p) {
          if (p.getAttribute('data-panel') === name) p.removeAttribute('hidden');
          else p.setAttribute('hidden', '');
        });
      });
    });

    $('#add-tree').addEventListener('click', function () { addSpecies(0); });
    $('#add-grass').addEventListener('click', function () { addSpecies(1); });
    $('#add-patch').addEventListener('click', function () {
      commit(function (c) {
        if (c.patches.length >= V.MAX_PATCHES) return;
        c.patches.push({ rect: [0, 0, 2, 2], weights: [null, null] });
      });
      renderGround();
    });

    $('#brush').addEventListener('change', function () {
      state.ui.brush = $('#brush').value;
    });

    $('#draw-rect').addEventListener('click', function () {
      state.ui.drawRect = !state.ui.drawRect;
      if (state.ui.drawRect) { state.ui.tool = 'inspect'; refreshToolButtons(); }
      $('#draw-rect').setAttribute('aria-pressed', state.ui.drawRect ? 'true' : 'false');
      canvas.style.cursor = state.ui.drawRect ? 'crosshair' : '';
    });

    $('#tool-inspect').addEventListener('click', function () {
      state.ui.tool = 'inspect';
      state.ui.drawRect = false;
      $('#draw-rect').setAttribute('aria-pressed', 'false');
      refreshToolButtons();
    });
    $('#tool-pan').addEventListener('click', function () {
      state.ui.tool = 'pan';
      refreshToolButtons();
    });
    $('#toggle-patches').addEventListener('click', function () {
      state.ui.showPatches = !state.ui.showPatches;
      $('#toggle-patches').setAttribute('aria-pressed', state.ui.showPatches ? 'true' : 'false');
      scheduleDraw();
    });

    $('#zoom-in').addEventListener('click', function () { zoomBy(1.4); });
    $('#zoom-out').addEventListener('click', function () { zoomBy(1 / 1.4); });
    $('#fit-view').addEventListener('click', function () { fitRect(state.windows.A.rect); });

    $('#theme-toggle').addEventListener('click', function () {
      var html = document.documentElement;
      var next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      readColors();
      scheduleDraw();
      try { localStorage.setItem('vege-theme', next); } catch (e) { /* noop */ }
    });

    $('#apply-json').addEventListener('click', applyJson);
    $('#export-header').addEventListener('change', function (e) {
      state.ui.header = !!e.target.checked;
    });
    $('#copy-json').addEventListener('click', function () {
      copyText($('#config-json').value).then(function () { toast('配置已复制'); });
    });
    $('#reset-sample').addEventListener('click', function () {
      state.config = clone(SAMPLE);
      cancelAllJobs('已载入样例');
      ['A', 'B'].forEach(function (k) {
        state.windows[k].result = null;
        state.windows[k].resultVersion = -1;
        state.windows[k].resultRect = null;
        state.windows[k].status = 'idle';
        state.windows[k].message = '';
      });
      state.windows.A.rect = SAMPLE.window.slice();
      state.windows.B.rect = [SAMPLE.window[0] + SAMPLE.window[2] + 1, SAMPLE.window[1], SAMPLE.window[2], SAMPLE.window[3]];
      $('#seed').value = String(state.config.seed);
      commit(null, { quietJson: true });
      syncJsonText();
      fullRender();
      fitRect(SAMPLE.window);
      toast('已载入样例');
    });

    document.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'f') fitRect(state.windows.A.rect);
      else if (e.key === 'i') { state.ui.tool = 'inspect'; state.ui.drawRect = false; refreshToolButtons(); }
      else if (e.key === 'p') { state.ui.tool = 'pan'; refreshToolButtons(); }
      else if (e.key === '=' || e.key === '+') zoomBy(1.3);
      else if (e.key === '-') zoomBy(1 / 1.3);
    });

    if (window.ResizeObserver) {
      new ResizeObserver(resizeCanvas).observe($('#stage'));
    } else {
      window.addEventListener('resize', resizeCanvas);
    }
  }

  function refreshToolButtons() {
    $('#tool-inspect').setAttribute('aria-pressed', state.ui.tool === 'inspect' && !state.ui.drawRect ? 'true' : 'false');
    $('#tool-pan').setAttribute('aria-pressed', state.ui.tool === 'pan' ? 'true' : 'false');
    $('#draw-rect').setAttribute('aria-pressed', state.ui.drawRect ? 'true' : 'false');
    canvas.style.cursor = state.ui.drawRect ? 'crosshair' : '';
  }

  function zoomBy(f) {
    var next = clamp(cam.scale * f, 0.05, 200);
    cam.scale = next;
    scheduleDraw();
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    try {
      var saved = localStorage.getItem('vege-theme');
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    } catch (e) { /* noop */ }
    readColors();

    $('#seed').value = String(state.config.seed);
    syncJsonText();
    bindStatic();
    resizeCanvas();
    fullRender();
    fitRect(state.windows.A.rect);
    refreshToolButtons();
    renderConfigErrors(null);

    // 若通过 http 提供，可尝试读取样例文件（file:// 下会失败，使用内置样例）
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      fetch('samples/biome-spawn.json').then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (json) {
        if (!json) return;
        // 只在用户尚未改动时载入
        if (state.version === 0) {
          state.config = {
            seed: json.seed,
            species: json.species,
            base: json.base,
            patches: json.patches || [],
            window: json.window
          };
          if (json.rules) state.config.rules = json.rules;
          state.windows.A.rect = json.window.slice();
          $('#seed').value = String(state.config.seed);
          syncJsonText();
          fullRender();
          fitRect(json.window);
        }
      }).catch(function () { /* 忽略 */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
