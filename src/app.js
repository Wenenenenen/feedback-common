/*
 * velocity-crop-conformer — application shell
 *
 * Owns project state, talks to the solver worker, renders the frame strip,
 * overlay viewer, crop preview, trajectory chart and inspector, and builds
 * the PNG / crop-table exports.
 */
(function () {
  'use strict';

  var VCC = window.VCC;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- state
  var state = {
    project: null,
    source: null,
    name: '',
    locks: {},
    solution: null,      // { ok, positions|failFrame, totalScore, totalAccel, solveMs }
    solving: false,
    stale: false,        // solution predates the current lock set
    cur: 0,
    overlays: { must: true, soft: true, cand: true, crop: true, ghost: true },
    sel: { start: 0, end: 0 },
    undo: [],
    redo: [],
    lastSolveMs: 0
  };

  var MAX_EXPORT_FRAMES = 120;
  var SOLVE_BUDGET_MS = 15000;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Number(n).toLocaleString('zh-CN'); }
  function clone(v) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(v));
  }

  // ---------------------------------------------------------------- toast
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 4200);
  }

  // ---------------------------------------------------------------- status
  function setStatus(kind, text, detail) {
    $('statusDot').className = 'dot ' + kind;
    $('statusText').textContent = text;
    $('statusDetail').textContent = detail || '';
  }

  // ---------------------------------------------------------------- solver
  var worker = null;
  var solveSeq = 0;
  var activeSolve = 0;
  var solveTimer = null;
  var solveToastTimer = null;

  function makeWorker() {
    var src = solveProject.toString() +
      '\nself.onmessage=function(ev){var d=ev.data;try{' +
      'var r=solveProject(d.project,d.locks);self.postMessage({id:d.id,result:r});' +
      '}catch(e){self.postMessage({id:d.id,error:(e&&e.message)||String(e)});}};';
    var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    var w = new Worker(url);
    w._url = url;
    return w;
  }

  function killWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* noop */ }
      try { URL.revokeObjectURL(worker._url); } catch (e) { /* noop */ }
      worker = null;
    }
  }

  function requestSolve() {
    if (!state.project) return;
    var id = ++solveSeq;
    activeSolve = id;
    state.solving = true;
    state.stale = true;
    renderStatus();
    renderExportState();

    killWorker();
    worker = makeWorker();
    var localWorker = worker;

    clearTimeout(solveTimer);
    var startedAt = performance.now();
    solveTimer = setTimeout(function () {
      if (activeSolve !== id) return;
      killWorker();
      state.solving = false;
      state.solution = null;
      setStatus('err', '求解超时', '超过 ' + (SOLVE_BUDGET_MS / 1000) + ' 秒未返回');
      toast('求解超过 ' + (SOLVE_BUDGET_MS / 1000) + ' 秒，已中止', 'err');
      renderAll();
    }, SOLVE_BUDGET_MS);

    localWorker.onmessage = function (ev) {
      var d = ev.data;
      if (!d || d.id !== activeSolve) return;
      clearTimeout(solveTimer);
      var elapsed = performance.now() - startedAt;
      killWorker();
      state.solving = false;
      state.stale = false;
      state.lastSolveMs = d.result && d.result.solveMs != null ? d.result.solveMs : elapsed;

      if (d.error) {
        state.solution = null;
        setStatus('err', '求解失败', d.error);
        toast('求解失败：' + d.error, 'err');
        renderAll();
        return;
      }
      var res = d.result;
      state.solution = res;
      if (!res.ok) {
        state.cur = res.failFrame >= 0 ? res.failFrame : state.cur;
        setStatus('err', res.reason || '无可行方案',
          '最早失去可行前缀：第 ' + res.failFrame + ' 帧');
        toast('无解：第 ' + res.failFrame + ' 帧起失去可行前缀，导出已停用', 'err');
      } else {
        setStatus('ok', '已求得全片最优解',
          '求解 ' + Math.round(state.lastSolveMs) + ' ms · ' + state.project.frames.length + ' 帧');
      }
      renderAll();
    };

    localWorker.onerror = function (err) {
      if (id !== activeSolve) return;
      clearTimeout(solveTimer);
      killWorker();
      state.solving = false;
      state.solution = null;
      setStatus('err', '求解线程出错', (err && err.message) || '');
      toast('求解线程出错', 'err');
      renderAll();
    };

    localWorker.postMessage({ id: id, project: state.project, locks: state.locks });
  }

  // debounce so rapid lock edits coalesce
  function scheduleSolve() {
    clearTimeout(solveToastTimer);
    solveToastTimer = setTimeout(requestSolve, 60);
  }

  // ---------------------------------------------------------------- history
  function snapshot() {
    return {
      locks: clone(state.locks),
      solution: state.solution ? clone(state.solution) : null,
      lastSolveMs: state.lastSolveMs
    };
  }

  function pushHistory() {
    state.undo.push(snapshot());
    if (state.undo.length > 120) state.undo.shift();
    state.redo.length = 0;
    renderHistory();
  }

  function applySnapshot(s) {
    // Any solve still in flight belongs to a superseded state: invalidate it
    // so its result cannot overwrite the snapshot we are restoring.
    activeSolve = ++solveSeq;
    clearTimeout(solveTimer);
    killWorker();
    state.locks = s.locks;
    state.solution = s.solution;
    state.lastSolveMs = s.lastSolveMs || 0;
    state.solving = false;
    state.stale = false;
    if (state.solution && !state.solution.ok && state.solution.failFrame >= 0) {
      state.cur = state.solution.failFrame;
    }
    renderAll();
    if (!state.solution) requestSolve();
  }

  function undo() {
    if (!state.undo.length) return;
    var s = state.undo.pop();
    state.redo.push(snapshot());
    applySnapshot(s);
    renderHistory();
  }

  function redo() {
    if (!state.redo.length) return;
    var s = state.redo.pop();
    state.undo.push(snapshot());
    applySnapshot(s);
    renderHistory();
  }

  // ---------------------------------------------------------------- images
  var imgmgr = {
    full: new Map(),
    order: [],
    thumbCache: new Map(),
    pending: new Map(),
    MAX: 16,

    touch: function (idx) {
      var p = this.order.indexOf(idx);
      if (p >= 0) this.order.splice(p, 1);
      this.order.push(idx);
    },

    evict: function () {
      while (this.order.length > this.MAX) {
        var old = this.order.shift();
        this.full.delete(old);
      }
    },

    get: function (idx) {
      var self = this;
      if (this.full.has(idx)) {
        var v = this.full.get(idx);
        this.touch(idx);
        return Promise.resolve(v);
      }
      if (this.pending.has(idx)) return this.pending.get(idx);
      var frame = state.project.frames[idx];
      if (!frame || !frame.image) return Promise.resolve(null);
      var p = state.source.readFile(frame.image)
        .then(function (blob) { return VCC.decodeBlob(blob); })
        .then(function (img) {
          self.full.set(idx, img.canvas);
          self.touch(idx);
          self.evict();
          self.pending.delete(idx);
          return img.canvas;
        })
        .catch(function (err) {
          self.pending.delete(idx);
          self.full.set(idx, null);
          return null;
        });
      this.pending.set(idx, p);
      return p;
    },

    thumb: function (idx) {
      var self = this;
      if (this.thumbCache.has(idx)) {
        var c = this.thumbCache.get(idx);
        if (c) return Promise.resolve(c);
      }
      return this.get(idx).then(function (src) {
        if (!src) { self.thumbCache.set(idx, null); return null; }
        var TW = 30, TH = 44;
        var cv = document.createElement('canvas');
        cv.width = TW; cv.height = TH;
        var ctx = cv.getContext('2d');
        // cover-fit source into the thumb
        var sc = Math.max(TW / src.width, TH / src.height);
        var sw = TW / sc, sh = TH / sc;
        ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, TW, TH);
        self.thumbCache.set(idx, cv);
        return cv;
      });
    }
  };

  // ---------------------------------------------------------------- loading
  function loadSource(source, name) {
    state.source = source;
    return source.readProject().then(function (project) {
      validateProject(project);
      state.project = project;
      state.name = (name || source.projectPath || 'project').replace(/\.zip$/i, '');
      state.locks = {};
      var locks = project.locks || {};
      for (var k in locks) {
        if (!Object.prototype.hasOwnProperty.call(locks, k)) continue;
        var lv = locks[k];
        if (lv && lv.length >= 2) state.locks[k] = [lv[0] | 0, lv[1] | 0];
      }
      state.solution = null;
      state.undo.length = 0;
      state.redo.length = 0;
      state.cur = 0;
      state.sel = { start: 0, end: Math.min(project.frames.length - 1, MAX_EXPORT_FRAMES - 1) };
      imgmgr.full.clear(); imgmgr.order.length = 0;
      imgmgr.thumbCache.clear(); imgmgr.pending.clear();

      $('projName').textContent = state.name;
      $('frameCount').textContent = project.frames.length + ' 帧';
      buildStrip();
      syncSelectionInputs();
      renderAll();
      requestSolve();
      return project;
    });
  }

  function validateProject(p) {
    if (!p || typeof p !== 'object') throw new Error('project.json 不是对象');
    if (!Array.isArray(p.frames) || !p.frames.length) throw new Error('project.json 缺少 frames');
    if (!Array.isArray(p.crop) || p.crop.length < 2) throw new Error('project.json 缺少 crop');
    if (!(p.width > 0) || !(p.height > 0)) throw new Error('project.json 缺少合法 width / height');
    var cw = p.crop[0], ch = p.crop[1];
    if (!(cw > 0) || !(ch > 0) || cw > p.width || ch > p.height) throw new Error('crop 尺寸不合法');
    for (var i = 0; i < p.frames.length; i++) {
      if (!p.frames[i] || typeof p.frames[i].image !== 'string') throw new Error('第 ' + i + ' 帧缺少 image');
    }
  }

  function loadZipBlob(blob, name) {
    setStatus('busy', '正在读取素材包…', '');
    return blob.arrayBuffer().then(function (buf) {
      var source = VCC.sourceFromZipBuffer(buf);
      return loadSource(source, name);
    }).then(function () {
      toast('已载入 ' + state.name, 'ok');
    }).catch(function (err) {
      setStatus('err', '载入失败', (err && err.message) || '');
      toast('载入失败：' + ((err && err.message) || err), 'err');
    });
  }

  function loadSample() {
    if (!VCC.SAMPLE_ZIP_B64) { toast('未内置示例数据', 'err'); return; }
    var bin = atob(VCC.SAMPLE_ZIP_B64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    loadZipBlob(new Blob([bytes]), 'velocity-crop-cases.zip');
  }

  // ---------------------------------------------------------------- strip
  var stripObserver = null;

  function buildStrip() {
    var inner = $('stripInner');
    inner.textContent = '';
    if (stripObserver) stripObserver.disconnect();
    var frames = state.project.frames;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < frames.length; i++) {
      var d = document.createElement('div');
      d.className = 'thumb' + (frames[i].cut ? ' cut' : '');
      d.dataset.idx = String(i);
      d.title = '第 ' + i + ' 帧' + (frames[i].cut ? '（硬切）' : '');
      var num = document.createElement('span');
      num.className = 'tn';
      num.textContent = String(i);
      d.appendChild(num);
      d.addEventListener('click', onThumbClick);
      frag.appendChild(d);
    }
    inner.appendChild(frag);

    stripObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        if (el.dataset.loaded) return;
        el.dataset.loaded = '1';
        var idx = parseInt(el.dataset.idx, 10);
        imgmgr.thumb(idx).then(function (cv) {
          if (!cv) { el.classList.add('empty'); return; }
          var clone = cv.cloneNode();
          clone.getContext('2d').drawImage(cv, 0, 0);
          el.insertBefore(clone, el.firstChild);
        });
      });
    }, { root: $('stripScroll'), rootMargin: '300px 0px' });

    for (var j = 0; j < inner.children.length; j++) stripObserver.observe(inner.children[j]);
  }

  function onThumbClick(e) {
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    seek(idx);
  }

  function seek(idx) {
    if (!state.project) return;
    state.cur = clamp(idx, 0, state.project.frames.length - 1);
    renderViewer();
    renderCrop();
    renderInspector();
    renderStripSelection();
    renderPath();
    scrollStripToCurrent();
  }

  function scrollStripToCurrent() {
    var inner = $('stripInner');
    var el = inner.children[state.cur];
    if (!el) return;
    var sc = $('stripScroll');
    var left = el.offsetLeft - sc.clientWidth / 2 + el.offsetWidth / 2;
    sc.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- render
  function renderAll() {
    renderStatus();
    renderMetrics();
    renderHistory();
    renderStripSelection();
    renderPath();
    renderViewer();
    renderCrop();
    renderInspector();
    renderExportState();
  }

  function renderStatus() {
    if (!state.project) { setStatus('idle', '等待载入素材', ''); return; }
    if (state.solving) {
      setStatus('busy', '正在求解全片最优裁框…', state.project.frames.length + ' 帧');
      return;
    }
    if (!state.solution) return;
    if (!state.solution.ok) {
      setStatus('err', state.solution.reason || '无可行方案',
        '最早失去可行前缀：第 ' + state.solution.failFrame + ' 帧');
    } else {
      setStatus('ok', '已求得全片最优解',
        '求解 ' + Math.round(state.lastSolveMs) + ' ms · ' + state.project.frames.length + ' 帧');
    }
  }

  function renderMetrics() {
    var s = state.solution;
    var ok = s && s.ok;
    $('mScore').textContent = ok ? fmt(s.totalScore) : (state.solving ? '求解中' : '—');
    $('mScore').classList.toggle('muted', !ok);
    $('mAccel').textContent = ok ? fmt(s.totalAccel) : '—';
    $('mTime').textContent = state.lastSolveMs ? Math.round(state.lastSolveMs) + ' ms' : '—';
  }

  function renderHistory() {
    $('btnUndo').disabled = !state.undo.length;
    $('btnRedo').disabled = !state.redo.length;
  }

  function renderStripSelection() {
    var inner = $('stripInner');
    for (var i = 0; i < inner.children.length; i++) {
      var el = inner.children[i];
      el.classList.toggle('cur', i === state.cur);
      el.classList.toggle('locked', Object.prototype.hasOwnProperty.call(state.locks, String(i)));
    }
  }

  function positionAt(idx) {
    var s = state.solution;
    if (s && s.ok && s.positions && s.positions[idx]) return s.positions[idx];
    return null;
  }

  // trajectory chart ------------------------------------------------
  var pathGeom = { w: 0, h: 0, padL: 30, padR: 10, padT: 12, padB: 18 };

  function sizePathCanvas() {
    var cv = $('pathCanvas');
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 260;
    var h = 150;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    pathGeom.w = w; pathGeom.h = h; pathGeom.dpr = dpr;
  }

  function renderPath() {
    var cv = $('pathCanvas');
    if (!cv) return;
    sizePathCanvas();
    var ctx = cv.getContext('2d');
    var dpr = pathGeom.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, pathGeom.w, pathGeom.h);

    var p = state.project;
    var padL = pathGeom.padL, padR = pathGeom.padR;
    var laneH = 52, laneGap = 16, top = pathGeom.padT;
    var plotW = pathGeom.w - padL - padR;
    if (!p) return;
    var n = p.frames.length;

    var bg = function (y, label, color, maxVal) {
      ctx.fillStyle = '#0a0b0e';
      ctx.strokeStyle = '#1e212a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(padL, y, plotW, laneH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#5d6371';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(label, 6, y + 12);
      ctx.fillStyle = '#3a3f4d';
      ctx.fillText(String(maxVal), 4, y + laneH - 2);
    };

    var maxX = Math.max(1, p.width - p.crop[0]);
    var maxY = Math.max(1, p.height - p.crop[1]);
    bg(top, 'x', '#ffb454', maxX);
    bg(top + laneH + laneGap, 'y', '#4fd1c5', maxY);

    if (n > 1) {
      var xAt = function (i) { return padL + (i / (n - 1)) * plotW; };
      var laneY = function (v, maxV, laneTop) {
        return laneTop + laneH - 3 - (v / maxV) * (laneH - 8);
      };

      // cut markers
      ctx.strokeStyle = 'rgba(167,139,250,.5)';
      ctx.setLineDash([2, 3]);
      for (var c = 0; c < n; c++) {
        if (!p.frames[c].cut) continue;
        var xc = xAt(c);
        ctx.beginPath();
        ctx.moveTo(xc, top);
        ctx.lineTo(xc, top + laneH * 2 + laneGap);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      var s = state.solution;
      if (s && s.ok && s.positions) {
        drawSeries(ctx, s.positions, 0, '#ffb454', maxX, top, xAt, laneY, p, laneH);
        drawSeries(ctx, s.positions, 1, '#4fd1c5', maxY, top + laneH + laneGap, xAt, laneY, p, laneH);

        // current marker
        var xCur = xAt(state.cur);
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xCur, top - 4);
        ctx.lineTo(xCur, top + laneH * 2 + laneGap + 4);
        ctx.stroke();
        var pos = s.positions[state.cur];
        if (pos) {
          ctx.fillStyle = '#ffb454';
          ctx.beginPath();
          ctx.arc(xCur, laneY(pos[0], maxX, top), 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#4fd1c5';
          ctx.beginPath();
          ctx.arc(xCur, laneY(pos[1], maxY, top + laneH + laneGap), 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (s && !s.ok && s.failFrame >= 0) {
        var xf = xAt(s.failFrame);
        ctx.strokeStyle = 'rgba(255,107,107,.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xf, top);
        ctx.lineTo(xf, top + laneH * 2 + laneGap);
        ctx.stroke();
        ctx.fillStyle = '#ff6b6b';
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText('✕', xf - 3, top - 2);
      }
    }
  }

  function drawSeries(ctx, positions, axis, color, maxVal, laneTop, xAt, laneY, p, laneH) {
    var n = positions.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    var started = false;
    for (var i = 0; i < n; i++) {
      if (positions[i] == null) { started = false; continue; }
      var startsShot = (i === 0 || p.frames[i].cut);
      var x = xAt(i), y = laneY(positions[i][axis], maxVal, laneTop);
      if (!started) { ctx.beginPath(); ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
      var nextStartsShot = (i + 1 < n && p.frames[i + 1].cut);
      if (nextStartsShot || i === n - 1) { ctx.stroke(); started = false; }
    }
  }

  // viewer ---------------------------------------------------------------
  function fitCanvasToStage(cv, w, h) {
    // Derive a CSS display size that fits the stage while preserving the
    // source aspect ratio.  The drawing buffer stays at native resolution.
    var stage = document.querySelector('.stage');
    if (!stage) return;
    var availW = Math.max(80, stage.clientWidth - 32);
    var availH = Math.max(80, stage.clientHeight - 32);
    var scale = Math.min(availW / w, availH / h);
    // upscale small sources for legibility, but never smaller than 1:1
    cv.style.width = Math.round(w * scale) + 'px';
    cv.style.height = Math.round(h * scale) + 'px';
    cv.style.imageRendering = scale >= 3 ? 'pixelated' : 'auto';
  }

  function renderViewer() {
    var p = state.project;
    var cv = $('viewCanvas');
    var hint = $('canvasHint');
    if (!p) { cv.width = 0; cv.height = 0; hint.style.display = ''; return; }
    hint.style.display = 'none';

    var idx = state.cur;
    imgmgr.get(idx).then(function (src) {
      if (state.cur !== idx) return; // user moved on
      if (!src) {
        cv.width = p.width; cv.height = p.height;
        fitCanvasToStage(cv, p.width, p.height);
        var c0 = cv.getContext('2d');
        c0.fillStyle = '#0a0b0e';
        c0.fillRect(0, 0, p.width, p.height);
        c0.fillStyle = '#5d6371';
        c0.font = Math.round(p.height / 24) + 'px sans-serif';
        c0.fillText('无法读取 ' + (p.frames[idx].image || '图像'), 20, 40);
        return;
      }
      drawViewer(src, idx);
    });
  }

  function drawViewer(src, idx) {
    var p = state.project;
    var cv = $('viewCanvas');
    if (cv.width !== p.width || cv.height !== p.height) {
      cv.width = p.width;
      cv.height = p.height;
    }
    fitCanvasToStage(cv, p.width, p.height);
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, p.width, p.height);
    ctx.drawImage(src, 0, 0, p.width, p.height);

    var cw = p.crop[0], ch = p.crop[1];
    var lw = Math.max(1, Math.round(p.width / 500));
    var fr = p.frames[idx];
    var small = Math.max(9, Math.round(p.width / 90));

    // candidates (corner ticks only — there can be ~100)
    if (state.overlays.cand && Array.isArray(fr.candidates)) {
      ctx.strokeStyle = 'rgba(232,235,244,.62)';
      ctx.lineWidth = Math.max(1, lw * 1.1);
      var tick = Math.max(6, Math.round(Math.min(cw, ch) / 12));
      for (var i = 0; i < fr.candidates.length; i++) {
        var c = fr.candidates[i];
        if (!c || c.length < 2) continue;
        var x = c[0], y = c[1];
        if (x < 0 || y < 0 || x + cw > p.width || y + ch > p.height) continue;
        ctx.beginPath();
        ctx.moveTo(x, y + tick); ctx.lineTo(x, y); ctx.lineTo(x + tick, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + cw - tick, y + ch); ctx.lineTo(x + cw, y + ch); ctx.lineTo(x + cw, y + ch - tick);
        ctx.stroke();
      }
    }

    // soft boxes
    if (state.overlays.soft && Array.isArray(fr.soft)) {
      var maxW = 1;
      fr.soft.forEach(function (s) { if (s && s.weight > maxW) maxW = s.weight; });
      // Soft boxes are reward regions, so keep their wash light and read
      // them mainly as a thin outline; a heavy fill would hide the plate.
      for (var qi = 0; qi < fr.soft.length; qi++) {
        var s = fr.soft[qi];
        if (!s || !s.box) continue;
        var b = s.box;
        var a = 0.03 + 0.09 * ((s.weight || 0) / maxW);
        ctx.fillStyle = 'rgba(79,209,197,' + a.toFixed(3) + ')';
        ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        ctx.strokeStyle = 'rgba(79,209,197,.7)';
        ctx.lineWidth = Math.max(1, lw * 0.8);
        ctx.strokeRect(b[0] + 0.5, b[1] + 0.5, b[2] - b[0] - 1, b[3] - b[1] - 1);
        ctx.fillStyle = 'rgba(79,209,197,.95)';
        ctx.font = '600 ' + small + 'px ui-monospace, monospace';
        ctx.fillText('w' + s.weight, b[0] + 4, b[1] + small + 2);
      }
    }

    // must boxes
    if (state.overlays.must && Array.isArray(fr.must)) {
      for (var mi = 0; mi < fr.must.length; mi++) {
        var m = fr.must[mi];
        if (!m) continue;
        ctx.fillStyle = 'rgba(255,93,115,.13)';
        ctx.fillRect(m[0], m[1], m[2] - m[0], m[3] - m[1]);
        ctx.strokeStyle = '#ff5d73';
        ctx.lineWidth = lw * 1.4;
        ctx.setLineDash([Math.max(4, lw * 5), Math.max(3, lw * 3)]);
        ctx.strokeRect(m[0] + 0.5, m[1] + 0.5, m[2] - m[0] - 1, m[3] - m[1] - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff5d73';
        ctx.font = '600 ' + small + 'px ui-monospace, monospace';
        ctx.fillText('必拍', m[0] + 4, m[1] + small + 2);
      }
    }

    var pos = positionAt(idx);
    var locked = Object.prototype.hasOwnProperty.call(state.locks, String(idx));

    // ghost of neighbouring crops
    if (state.overlays.ghost) {
      var prev = idx > 0 && !fr.cut ? positionAt(idx - 1) : null;
      var next = idx + 1 < p.frames.length && !p.frames[idx + 1].cut ? positionAt(idx + 1) : null;
      if (prev) ghostRect(ctx, prev[0], prev[1], cw, ch, 'rgba(255,255,255,.32)', lw, '←');
      if (next) ghostRect(ctx, next[0], next[1], cw, ch, 'rgba(255,255,255,.18)', lw, '→');
    }

    // chosen crop
    if (state.overlays.crop && pos) {
      ctx.save();
      // dim outside
      ctx.fillStyle = 'rgba(0,0,0,.38)';
      ctx.fillRect(0, 0, p.width, Math.max(0, pos[1]));
      ctx.fillRect(0, pos[1] + ch, p.width, Math.max(0, p.height - pos[1] - ch));
      ctx.fillRect(0, pos[1], Math.max(0, pos[0]), ch);
      ctx.fillRect(pos[0] + cw, pos[1], Math.max(0, p.width - pos[0] - cw), ch);

      ctx.strokeStyle = locked ? '#ffcf87' : '#ffb454';
      ctx.lineWidth = lw * 2.2;
      ctx.strokeRect(pos[0] + lw, pos[1] + lw, cw - lw * 2, ch - lw * 2);

      // corner brackets
      var bl = Math.max(10, Math.round(cw / 8));
      ctx.lineWidth = lw * 3.2;
      ctx.strokeStyle = locked ? '#ffcf87' : '#ffb454';
      var corners = [
        [pos[0], pos[1], 1, 1], [pos[0] + cw, pos[1], -1, 1],
        [pos[0], pos[1] + ch, 1, -1], [pos[0] + cw, pos[1] + ch, -1, -1]
      ];
      corners.forEach(function (k) {
        ctx.beginPath();
        ctx.moveTo(k[0] + k[2] * bl, k[1]);
        ctx.lineTo(k[0], k[1]);
        ctx.lineTo(k[0], k[1] + k[3] * bl);
        ctx.stroke();
      });

      // label
      var label = locked ? '锁定裁框 ' + cw + '×' + ch : '裁框 ' + cw + '×' + ch + '  @' + pos[0] + ',' + pos[1];
      ctx.font = '600 ' + small + 'px ui-monospace, monospace';
      var tw = ctx.measureText(label).width;
      var lx = clamp(pos[0], 0, p.width - tw - 10);
      var ly = pos[1] - 8;
      if (ly < small + 6) ly = pos[1] + small + 8;
      ctx.fillStyle = 'rgba(12,13,16,.85)';
      ctx.fillRect(lx - 2, ly - small, tw + 8, small + 7);
      ctx.fillStyle = locked ? '#ffcf87' : '#ffb454';
      ctx.fillText(label, lx + 2, ly);
      ctx.restore();
    }

    // stale / solving veil
    if (state.solving || state.stale) {
      ctx.fillStyle = 'rgba(10,11,14,.28)';
      ctx.fillRect(0, 0, p.width, p.height);
    }
  }

  function ghostRect(ctx, x, y, w, h, color, lw, tag) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash([Math.max(5, lw * 6), Math.max(4, lw * 4)]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    var fs = Math.max(11, Math.round(w / 30));
    ctx.font = '600 ' + fs + 'px ui-monospace, monospace';
    ctx.fillText(tag, x + 6, y + fs + 4);
    ctx.restore();
  }

  // crop preview --------------------------------------------------------
  function renderCrop() {
    var p = state.project;
    var cv = $('cropCanvas');
    var dims = $('cropDims');
    if (!p) { dims.textContent = ''; return; }
    dims.textContent = p.crop[0] + ' × ' + p.crop[1];
    var idx = state.cur;
    var pos = positionAt(idx);
    if (!pos) {
      cv.width = 0; cv.height = 0;
      return;
    }
    imgmgr.get(idx).then(function (src) {
      if (state.cur !== idx) return;
      if (!src) return;
      var cw = p.crop[0], ch = p.crop[1];
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      var ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(src, pos[0], pos[1], cw, ch, 0, 0, cw, ch);
      // fit within the preview well, keeping native pixels in the buffer
      var well = cv.parentElement;
      var availW = Math.max(60, well.clientWidth - 4);
      var availH = Math.max(60, well.clientHeight - 4);
      var scale = Math.min(availW / cw, availH / ch);
      cv.style.width = Math.round(cw * scale) + 'px';
      cv.style.height = Math.round(ch * scale) + 'px';
      cv.style.imageRendering = scale >= 3 ? 'pixelated' : 'auto';
    });
  }

  // inspector -----------------------------------------------------------
  function renderInspector() {
    var p = state.project;
    if (!p) return;
    var idx = state.cur;
    var fr = p.frames[idx];
    var pos = positionAt(idx);
    var locked = Object.prototype.hasOwnProperty.call(state.locks, String(idx));

    $('curFrame').textContent = String(idx);
    var total = p.frames.length;
    $('frameMeta').innerHTML = '';

    var metaParts = [];
    metaParts.push(fr.image);
    if (fr.cut) metaParts.push('<span class="cut-tag">硬切 · 新镜头</span>');
    else {
      // find shot start
      var st = idx;
      while (st > 0 && !p.frames[st].cut) st--;
      metaParts.push('镜头 ' + (countShotsBefore(p, st) + 1));
    }
    $('frameMeta').innerHTML = metaParts.join(' · ');

    $('iFrame').textContent = String(idx);
    var shotIdx = countShotsBefore(p, shotStartOf(p, idx));
    $('iShot').textContent = '#' + shotIdx;
    $('iCand').textContent = (fr.candidates ? fr.candidates.length : 0) + ' 个';
    $('iCrop').textContent = pos ? ('(' + pos[0] + ', ' + pos[1] + ')') : '—';
    var score = pos ? scoreFor(p, idx, pos) : null;
    $('iScore').textContent = score == null ? '—' : fmt(score);
    $('iSpeed').textContent = '±' + p.speed[0] + ' , ±' + p.speed[1];
    $('iAccel').textContent = '±' + p.accel[0] + ' , ±' + p.accel[1];

    // triple second-difference at this frame
    var tri = tripleAt(p, idx);
    $('iTriple').textContent = tri ? (tri[0] + ' , ' + tri[1]) : '—';

    $('lockBadge').classList.toggle('hidden', !locked);
    $('lockHereState').textContent = locked
      ? '已锁定 (' + state.locks[String(idx)].join(', ') + ')'
      : '未锁定';
    $('btnLockHere').disabled = !pos || locked;
    $('btnClearLock').disabled = !locked;

    // must boxes
    var mustList = $('mustList');
    mustList.textContent = '';
    $('mustCount').textContent = String(fr.must ? fr.must.length : 0);
    if (!fr.must || !fr.must.length) {
      var em = document.createElement('li');
      em.innerHTML = '<span class="empty">无必拍框</span>';
      mustList.appendChild(em);
    } else {
      fr.must.forEach(function (m) {
        var li = document.createElement('li');
        li.innerHTML = '<span class="sw"></span><span>[' + m.join(', ') + ']</span>';
        mustList.appendChild(li);
      });
    }

    // soft
    var softList = $('softList');
    softList.textContent = '';
    $('softCount').textContent = String(fr.soft ? fr.soft.length : 0);
    if (!fr.soft || !fr.soft.length) {
      var em2 = document.createElement('li');
      em2.innerHTML = '<span class="empty">无可选项</span>';
      softList.appendChild(em2);
    } else {
      fr.soft.forEach(function (s) {
        var li = document.createElement('li');
        var ov = pos ? overlapArea(pos, p.crop, s.box) : 0;
        li.innerHTML = '<span class="sw"></span><span>[' + s.box.join(', ') + ']</span>' +
          '<span class="w">w' + s.weight + (pos ? ' · ' + fmt(ov * s.weight) : '') + '</span>';
        softList.appendChild(li);
      });
    }

    // candidates (sorted by score at this frame), click to lock
    renderCandidates(fr, idx, pos);

    // all locks
    var lockList = $('lockList');
    lockList.textContent = '';
    var keys = Object.keys(state.locks).sort(function (a, b) { return a - b; });
    $('allLockCount').textContent = String(keys.length);
    if (!keys.length) {
      var em3 = document.createElement('li');
      em3.innerHTML = '<span class="empty">尚未设置构图锁</span>';
      lockList.appendChild(em3);
    } else {
      keys.forEach(function (k) {
        var li = document.createElement('li');
        if (Number(k) === idx) li.className = 'cur';
        var span = document.createElement('span');
        span.textContent = '帧 ' + k + ' → (' + state.locks[k].join(', ') + ')';
        var btn = document.createElement('button');
        btn.textContent = '×';
        btn.title = '移除此锁';
        btn.addEventListener('click', function () { removeLock(Number(k)); });
        li.appendChild(span);
        li.appendChild(btn);
        lockList.appendChild(li);
      });
    }
  }

  function renderCandidates(fr, idx, pos) {
    var host = $('candList');
    host.textContent = '';
    var cands = (fr.candidates || []).slice();
    $('candCount').textContent = String(cands.length);
    var cw = state.project.crop[0], ch = state.project.crop[1];
    var maxX = state.project.width - cw, maxY = state.project.height - ch;
    var rows = cands.map(function (c) {
      return { x: c[0], y: c[1], score: scoreFor(state.project, idx, c) };
    }).filter(function (r) {
      return r.x >= 0 && r.y >= 0 && r.x <= maxX && r.y <= maxY;
    }).sort(function (a, b) { return b.score - a.score || a.x - b.x || a.y - b.y; });

    var locked = Object.prototype.hasOwnProperty.call(state.locks, String(idx));
    rows.slice(0, 80).forEach(function (r) {
      var li = document.createElement('li');
      var isCur = pos && pos[0] === r.x && pos[1] === r.y;
      if (isCur) li.style.outline = '1px solid rgba(255,180,84,.4)';
      var span = document.createElement('span');
      span.textContent = (isCur ? '● ' : '') + '(' + r.x + ', ' + r.y + ')';
      span.style.fontFamily = 'var(--mono)';
      var sc = document.createElement('span');
      sc.textContent = fmt(r.score);
      sc.style.marginLeft = 'auto';
      sc.style.marginRight = '8px';
      sc.style.color = 'var(--accent)';
      var btn = document.createElement('button');
      btn.textContent = locked && isCur ? '已锁' : '锁定';
      btn.style.fontSize = '9.5px';
      btn.style.padding = '1px 5px';
      btn.disabled = locked && isCur;
      btn.addEventListener('click', function () { lockAt(idx, [r.x, r.y]); });
      li.appendChild(span);
      li.appendChild(sc);
      li.appendChild(btn);
      host.appendChild(li);
    });
  }

  function shotStartOf(p, idx) {
    var st = idx;
    while (st > 0 && !p.frames[st].cut) st--;
    return st;
  }

  function countShotsBefore(p, st) {
    var c = 0;
    for (var i = 0; i < st; i++) if (i === 0 || p.frames[i].cut) c++;
    return c;
  }

  function tripleAt(p, idx) {
    var s = state.solution;
    if (!s || !s.ok || !s.positions) return null;
    if (idx < 2) return null;
    if (p.frames[idx].cut || p.frames[idx - 1].cut) return null;
    var a = s.positions[idx - 2], b = s.positions[idx - 1], c = s.positions[idx];
    if (!a || !b || !c) return null;
    return [Math.abs(c[0] - 2 * b[0] + a[0]), Math.abs(c[1] - 2 * b[1] + a[1])];
  }

  function overlapArea(pos, crop, box) {
    var x0 = pos[0], y0 = pos[1], x1 = pos[0] + crop[0], y1 = pos[1] + crop[1];
    var ox = Math.min(x1, box[2]) - Math.max(x0, box[0]);
    if (ox <= 0) return 0;
    var oy = Math.min(y1, box[3]) - Math.max(y0, box[1]);
    if (oy <= 0) return 0;
    return ox * oy;
  }

  function scoreFor(p, idx, pos) {
    var fr = p.frames[idx];
    if (!fr.soft) return 0;
    var total = 0;
    for (var i = 0; i < fr.soft.length; i++) {
      total += overlapArea(pos, p.crop, fr.soft[i].box) * fr.soft[i].weight;
    }
    return total;
  }

  // ---------------------------------------------------------------- locks
  function lockAt(idx, pos) {
    if (!state.project) return;
    var key = String(idx);
    if (state.locks[key] && state.locks[key][0] === pos[0] && state.locks[key][1] === pos[1]) return;
    pushHistory();
    state.locks[key] = [pos[0], pos[1]];
    state.stale = true;
    renderStripSelection();
    renderInspector();
    renderExportState();
    scheduleSolve();
    toast('已锁定第 ' + idx + ' 帧 → (' + pos[0] + ', ' + pos[1] + ')', 'ok');
  }

  function removeLock(idx) {
    var key = String(idx);
    if (!Object.prototype.hasOwnProperty.call(state.locks, key)) return;
    pushHistory();
    delete state.locks[key];
    state.stale = true;
    renderStripSelection();
    renderInspector();
    renderExportState();
    scheduleSolve();
    toast('已解除第 ' + idx + ' 帧的锁定');
  }

  // ---------------------------------------------------------------- export
  function renderExportState() {
    var p = state.project;
    var ok = !!(p && state.solution && state.solution.ok && !state.solving);
    $('btnExportSeq').disabled = !ok || state.solving;
    $('btnExportTable').disabled = !p || !state.solution || !state.solution.ok;
    var n = state.sel.end - state.sel.start + 1;
    $('selCount').textContent = (n > 0 ? n : 0) + ' 帧';
    if (!ok) {
      $('exportHint').textContent = !p ? '每批至多 120 帧；PNG 按原图整数裁切，不缩放。'
        : (state.solving ? '求解中，导出暂不可用。' : '当前方案无解或尚未求解，导出已停用。');
    } else if (n > MAX_EXPORT_FRAMES) {
      $('exportHint').textContent = '所选 ' + n + ' 帧超过单批上限 ' + MAX_EXPORT_FRAMES + ' 帧，请缩小选区。';
    } else {
      $('exportHint').textContent = '每批至多 120 帧；PNG 按原图整数裁切，不缩放。';
    }
  }

  function syncSelectionInputs() {
    $('selStart').value = String(state.sel.start);
    $('selEnd').value = String(state.sel.end);
  }

  function readSelectionInputs() {
    var p = state.project;
    if (!p) return;
    var max = p.frames.length - 1;
    var a = parseInt($('selStart').value, 10);
    var b = parseInt($('selEnd').value, 10);
    if (!isFinite(a)) a = 0;
    if (!isFinite(b)) b = max;
    a = clamp(a, 0, max);
    b = clamp(b, 0, max);
    if (a > b) { var t = a; a = b; b = t; }
    state.sel = { start: a, end: b };
    renderExportState();
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('PNG 编码失败'));
      }, 'image/png');
    });
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportPngSequence() {
    var p = state.project;
    if (!p || !state.solution || !state.solution.ok) return;
    readSelectionInputs();
    var a = state.sel.start, b = state.sel.end;
    var count = b - a + 1;
    if (count > MAX_EXPORT_FRAMES) {
      toast('单批最多导出 ' + MAX_EXPORT_FRAMES + ' 帧，当前选区 ' + count + ' 帧', 'err');
      return;
    }
    if (count <= 0) return;

    var btn = $('btnExportSeq');
    btn.disabled = true;
    var cancelled = false;
    var canvas = document.createElement('canvas');
    canvas.width = p.crop[0];
    canvas.height = p.crop[1];
    var ctx = canvas.getContext('2d');
    var files = [];
    var digits = String(b).length;
    var rows = [['frame', 'cut', 'x', 'y', 'w', 'h', 'score'].join(',')];

    function step(i) {
      if (cancelled) return Promise.resolve();
      if (i > b) return Promise.resolve();
      setStatus('busy', '正在导出 PNG 序列…', (i - a + 1) + ' / ' + count);
      var pos = state.solution.positions[i];
      return imgmgr.get(i).then(function (src) {
        if (!src) throw new Error('第 ' + i + ' 帧图像读取失败');
        ctx.clearRect(0, 0, p.crop[0], p.crop[1]);
        ctx.drawImage(src, pos[0], pos[1], p.crop[0], p.crop[1], 0, 0, p.crop[0], p.crop[1]);
        var name = 'frame_' + String(i).padStart(digits, '0') + '.png';
        rows.push([i, p.frames[i].cut ? 1 : 0, pos[0], pos[1], p.crop[0], p.crop[1],
          scoreFor(p, i, pos)].join(','));
        return canvasToBlob(canvas).then(blobToBytes).then(function (bytes) {
          files.push({ name: name, data: bytes });
          return step(i + 1);
        });
      });
    }

    step(a).then(function () {
      if (cancelled) return;
      var csvBytes = new TextEncoder().encode(rows.join('\n'));
      files.push({ name: 'crop-table.csv', data: csvBytes });
      var meta = {
        project: state.name,
        width: p.width, height: p.height,
        crop: p.crop, speed: p.speed, accel: p.accel,
        range: [a, b],
        totalScore: state.solution.totalScore,
        totalAccel: state.solution.totalAccel,
        locks: state.locks
      };
      files.push({ name: 'export.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
      var zipBlob = VCC.buildZip(files);
      download(zipBlob, state.name + '_frames_' + a + '-' + b + '.zip');
      setStatus('ok', '已导出 ' + count + ' 帧 PNG', state.name + '_frames_' + a + '-' + b + '.zip');
      toast('已导出 ' + count + ' 帧 PNG 与裁框表', 'ok');
      btn.disabled = false;
      renderExportState();
    }).catch(function (err) {
      cancelled = true;
      btn.disabled = false;
      setStatus('err', '导出失败', (err && err.message) || '');
      toast('导出失败：' + ((err && err.message) || err), 'err');
      renderExportState();
    });
  }

  function exportCropTable() {
    var p = state.project;
    if (!p || !state.solution || !state.solution.ok) return;
    var lines = [['frame', 'cut', 'x', 'y', 'w', 'h', 'score'].join(',')];
    for (var i = 0; i < p.frames.length; i++) {
      var pos = state.solution.positions[i];
      lines.push([i, p.frames[i].cut ? 1 : 0, pos[0], pos[1], p.crop[0], p.crop[1],
        scoreFor(p, i, pos)].join(','));
    }
    var head = [
      '# project=' + state.name,
      '# width=' + p.width + ' height=' + p.height + ' crop=' + p.crop.join('x'),
      '# speed=' + p.speed.join(',') + ' accel=' + p.accel.join(','),
      '# totalScore=' + state.solution.totalScore + ' totalAccel=' + state.solution.totalAccel,
      '# locks=' + JSON.stringify(state.locks)
    ];
    var blob = new Blob([head.join('\n') + '\n' + lines.join('\n')], { type: 'text/csv' });
    download(blob, state.name + '_crop-table.csv');
    toast('已导出全片裁框表', 'ok');
  }

  // ---------------------------------------------------------------- events
  function bindEvents() {
    $('btnOpen').addEventListener('click', function () { $('fileInput').click(); });
    $('btnSample').addEventListener('click', loadSample);
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadZipBlob(f, f.name);
      e.target.value = '';
    });

    $('btnPrev').addEventListener('click', function () { seek(state.cur - 1); });
    $('btnNext').addEventListener('click', function () { seek(state.cur + 1); });

    $('toggles').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      var key = b.dataset.ov;
      state.overlays[key] = !state.overlays[key];
      b.classList.toggle('on', state.overlays[key]);
      renderViewer();
    });

    $('btnLockHere').addEventListener('click', function () {
      var pos = positionAt(state.cur);
      if (pos) lockAt(state.cur, [pos[0], pos[1]]);
    });
    $('btnClearLock').addEventListener('click', function () { removeLock(state.cur); });

    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);

    $('selStart').addEventListener('change', readSelectionInputs);
    $('selEnd').addEventListener('change', readSelectionInputs);
    $('btnSelHere').addEventListener('click', function () {
      state.sel.start = state.cur;
      state.sel.end = Math.min(state.project.frames.length - 1, state.cur + MAX_EXPORT_FRAMES - 1);
      syncSelectionInputs();
      renderExportState();
    });
    $('btnExportSeq').addEventListener('click', exportPngSequence);
    $('btnExportTable').addEventListener('click', exportCropTable);

    $('pathCanvas').addEventListener('click', function (e) {
      if (!state.project) return;
      var rect = e.currentTarget.getBoundingClientRect();
      var padL = pathGeom.padL, padR = pathGeom.padR;
      var plotW = rect.width - padL - padR;
      var x = e.clientX - rect.left - padL;
      var t = clamp(x / plotW, 0, 1);
      seek(Math.round(t * (state.project.frames.length - 1)));
    });

    window.addEventListener('keydown', function (e) {
      if (/input|textarea/i.test((e.target && e.target.tagName) || '')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.cur - (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.cur + (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'Home') { e.preventDefault(); seek(0); }
      else if (e.key === 'End') { e.preventDefault(); seek(state.project ? state.project.frames.length - 1 : 0); }
      else if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) {
        var pos = positionAt(state.cur);
        if (pos) lockAt(state.cur, [pos[0], pos[1]]);
      }
    });

    var resizeRaf = 0;
    window.addEventListener('resize', function () {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(function () {
        renderPath();
        if (state.project) {
          var cv = $('viewCanvas');
          if (cv.width) fitCanvasToStage(cv, state.project.width, state.project.height);
          renderCrop();
        }
      });
    });

    // drag and drop
    var veil = $('dropVeil');
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      e.preventDefault();
      depth++;
      veil.classList.add('show');
    });
    window.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault();
    });
    window.addEventListener('dragleave', function (e) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) veil.classList.remove('show');
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      veil.classList.remove('show');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var zip = null;
      for (var i = 0; i < files.length; i++) {
        if (/\.zip$/i.test(files[i].name)) { zip = files[i]; break; }
      }
      if (zip) { loadZipBlob(zip, zip.name); return; }
      if (files.length && /project\.json$/i.test(files[0].name || '')) {
        // flat folder drop of the sample style
        var list = Array.prototype.slice.call(files);
        var hasProject = list.some(function (f) { return /project\.json$/i.test(f.name); });
        if (hasProject) {
          try {
            var src = new VCC.FolderSource(list);
            loadSource(src, 'dropped-project').then(function () { toast('已载入拖入的文件', 'ok'); })
              .catch(function (err) { toast('载入失败：' + err.message, 'err'); });
            return;
          } catch (err) { toast('载入失败：' + err.message, 'err'); return; }
        }
      }
      toast('请拖入 .zip 素材包，或含 project.json 的文件夹', 'err');
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    bindEvents();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
