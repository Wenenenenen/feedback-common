(function () {
  'use strict';

  var ENGINE = window.MatteEngine;
  var PNG = window.MattePng;
  var CONFIG = window.MatteConfig;
  var SAMPLES = window.MatteSamples;

  var PIXEL_SCALE = 4;
  var DEBOUNCE_MS = 300;
  var THEME_KEY = 'seedcut.theme.v1';

  // ---------------------------------------------------------------- 状态

  var state = {
    image: null,          // { width, height, rgb, name, seq }
    imageSeq: 0,
    seeds: new Uint8Array(0), // 0 无 / 1 前景 / 2 背景
    fgCount: 0,
    bgCount: 0,
    tool: 'fg',
    brush: 2,
    lambda: 1,
    hover: -1,
    picks: [],
    result: null,
    job: null,
    jobSeq: 0,
    dirty: false,
    computing: false,
    hadResult: false,
    seedVersion: 0,
    noticeKind: '',
    resultSeq: 0,
    blockedReason: '',
    costs: null
  };

  var els = {};
  var runTimer = null;
  var dragging = null;
  var renderQueued = false;
  var maskCacheKey = null;

  function $(id) { return document.getElementById(id); }

  function boot() {
    [
      'views', 'wrapOriginal', 'wrapMask', 'wrapComposite', 'dropHint',
      'canvasOriginal', 'canvasMask', 'canvasComposite',
      'emptyOriginal', 'emptyMask', 'emptyComposite',
      'metaOriginal', 'metaMask', 'metaComposite',
      'notice', 'pixelBody', 'hoverChip', 'edgeBody', 'edgeChip',
      'statusPill', 'statusText', 'seedCounts', 'brush', 'brushOut',
      'lambda', 'lambdaOut', 'runBtn', 'cancelBtn', 'runMeta',
      'sumUnary', 'sumBoundary', 'sumTotal', 'betaOut', 'flowOut', 'compOut',
      'freshTag', 'swatchFg', 'swatchBg', 'meanFg', 'meanBg', 'detailBody',
      'exportMask', 'exportRgba', 'exportConfig', 'copyConfig',
      'fileImage', 'fileConfig', 'themeBtn'
    ].forEach(function (id) { els[id] = $(id); });

    bindUI();
    initTheme();
    setTool('fg');
    updateBrushOut();
    updateLambdaOut();
    updateSeedCounts();
    updateFreshnessUI();
    renderPixelCard();
    renderEdgeCard();
    updateEmptyStates();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { fitAll(); }).observe(els.views);
    }
    window.addEventListener('resize', fitAll);
    setStatus('idle', '等待图片');
    setNotice('info', '打开一张 8 位 RGB PNG（边长 ≤ 256），或点击顶部示例开始。',
      [{ label: '载入「微小样例」', onClick: function () { loadSample('tiny'); } }]);
  }

  // ---------------------------------------------------------------- 通用

  function fmt(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    var d = digits == null ? 6 : digits;
    if (v !== 0 && Math.abs(v) < Math.pow(10, -d)) return v.toExponential(3);
    return v.toFixed(d);
  }

  function fmtBytes(m) {
    if (!m) return '—';
    return Math.round(m[0] * 255) + ', ' + Math.round(m[1] * 255) + ', ' + Math.round(m[2] * 255);
  }

  function hex2(v) {
    var s = v.toString(16).toUpperCase();
    return s.length < 2 ? '0' + s : s;
  }

  function rgbHex(rgb, i) {
    return '#' + hex2(rgb[i * 3]) + hex2(rgb[i * 3 + 1]) + hex2(rgb[i * 3 + 2]);
  }

  function cssRgb(m) {
    return 'rgb(' + Math.round(m[0] * 255) + ',' + Math.round(m[1] * 255) + ',' + Math.round(m[2] * 255) + ')';
  }

  function hexFromMean(m) {
    return '#' + hex2(Math.round(m[0] * 255)) + hex2(Math.round(m[1] * 255)) + hex2(Math.round(m[2] * 255));
  }

  function coordsOf(i) {
    if (i == null || i < 0 || !state.image) return '—';
    var w = state.image.width;
    return '(' + (i % w) + ', ' + Math.floor(i / w) + ')';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function seedHash() {
    var s = state.seeds;
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }

  // 签名 = 图片 + 种子 + λ。种子哈希在改动时增量维护，避免每次悬停都扫全图。
  var sigCache = { key: '', value: '' };

  function signature() {
    var lambdaKey = Number(state.lambda).toFixed(4);
    var key = state.imageSeq + ':' + state.seedVersion + ':' + lambdaKey;
    if (sigCache.key !== key) {
      sigCache.key = key;
      sigCache.value = state.imageSeq + ':' + seedHash() + ':' + lambdaKey;
    }
    return sigCache.value;
  }

  function setStatus(kind, text) {
    els.statusPill.setAttribute('data-state', kind === 'idle' ? '' : kind);
    els.statusText.textContent = text;
  }

  function setNotice(level, html, actions, kind) {
    state.noticeKind = kind || '';
    var n = els.notice;
    n.innerHTML = '';
    n.setAttribute('data-level', level);
    n.hidden = false;
    var body = document.createElement('div');
    body.className = 'notice-body';
    var p = document.createElement('p');
    p.innerHTML = html;
    body.appendChild(p);
    if (actions && actions.length) {
      var row = document.createElement('div');
      row.className = 'run-row';
      row.style.marginTop = '8px';
      actions.slice(0, 2).forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = a.label;
        b.addEventListener('click', a.onClick);
        row.appendChild(b);
      });
      body.appendChild(row);
    }
    n.appendChild(body);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'notice-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', function () { n.hidden = true; });
    n.appendChild(close);
  }

  function hideNotice() { els.notice.hidden = true; state.noticeKind = ''; }

  // ---------------------------------------------------------------- 主题

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    updateThemeTitle(saved);
    els.themeBtn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'dark' ? 'light' : current === 'light' ? null : 'dark';
      if (next) document.documentElement.setAttribute('data-theme', next);
      else document.documentElement.removeAttribute('data-theme');
      try {
        if (next) localStorage.setItem(THEME_KEY, next);
        else localStorage.removeItem(THEME_KEY);
      } catch (e) { /* 忽略存储失败 */ }
      updateThemeTitle(next);
    });
  }

  function updateThemeTitle(v) {
    els.themeBtn.title = v === 'dark' ? '深色主题（点击切换为浅色）' :
      v === 'light' ? '浅色主题（点击切换为跟随系统）' : '跟随系统主题（点击切换为深色）';
  }

  // ---------------------------------------------------------------- 绑定

  function bindUI() {
    document.querySelectorAll('[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () { setTool(btn.getAttribute('data-tool')); });
    });
    document.querySelectorAll('[data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () { loadSample(btn.getAttribute('data-sample')); });
    });

    els.brush.addEventListener('input', function () {
      state.brush = Number(els.brush.value);
      updateBrushOut();
    });

    els.lambda.addEventListener('input', function () {
      state.lambda = Number(els.lambda.value);
      updateLambdaOut();
      markDirty();
      scheduleRun();
    });

    els.runBtn.addEventListener('click', function () { runNow(); });
    els.cancelBtn.addEventListener('click', function () { cancelJob(true); });

    els.fileImage.addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) readImageFile(file);
    });
    els.fileConfig.addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) readConfigFile(file);
    });

    els.exportMask.addEventListener('click', exportMaskPng);
    els.exportRgba.addEventListener('click', exportRgbaPng);
    els.exportConfig.addEventListener('click', exportSeedJson);
    els.copyConfig.addEventListener('click', copySeedJson);

    els.seedCounts.addEventListener('click', function (ev) {
      if (ev.target && ev.target.id === 'clearSeeds') clearSeeds();
    });

    bindCanvas(els.canvasOriginal, true);
    bindCanvas(els.canvasMask, false);
    bindCanvas(els.canvasComposite, false);
    bindDropZone(els.views);

    document.addEventListener('keydown', function (ev) {
      var t = ev.target;
      var tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (ev.key === '1') setTool('fg');
      else if (ev.key === '2') setTool('bg');
      else if (ev.key === '3') setTool('erase');
      else if (ev.key === '4') setTool('probe');
      else if (ev.key === 'Escape' && state.job) { ev.preventDefault(); cancelJob(true); }
    });
  }

  function updateBrushOut() { els.brushOut.textContent = state.brush + ' px'; }
  function updateLambdaOut() { els.lambdaOut.textContent = Number(state.lambda).toFixed(2); }

  function setTool(tool) {
    if (tool !== 'fg' && tool !== 'bg' && tool !== 'erase' && tool !== 'probe') return;
    state.tool = tool;
    document.querySelectorAll('[data-tool]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-tool') === tool ? 'true' : 'false');
    });
  }

  function bindDropZone(el) {
    var depth = 0;
    ['dragenter', 'dragover'].forEach(function (t) {
      el.addEventListener(t, function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
        if (t === 'dragenter') depth++;
        els.dropHint.hidden = false;
      });
    });
    el.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) els.dropHint.hidden = true;
    });
    el.addEventListener('drop', function (ev) {
      ev.preventDefault();
      depth = 0;
      els.dropHint.hidden = true;
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      var file = files[0];
      if (/\.json$/i.test(file.name) || /json/i.test(file.type)) readConfigFile(file);
      else readImageFile(file);
    });
  }

  function readImageFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      loadImageBytes(new Uint8Array(reader.result), file.name);
    };
    reader.onerror = function () {
      setStatus('error', '读取失败');
      setNotice('error', '读取文件失败：' + escapeHtml(file.name));
    };
    reader.readAsArrayBuffer(file);
  }

  function readConfigFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (e) {
        setStatus('error', '配置解析失败');
        setNotice('error', '<b>种子配置不是有效 JSON。</b> ' + escapeHtml(e && e.message ? e.message : String(e)));
        return;
      }
      applySeedConfig(raw, file.name);
    };
    reader.onerror = function () {
      setNotice('error', '读取配置失败：' + escapeHtml(file.name));
    };
    reader.readAsText(file);
  }

  /*
   * 三块画布联动：在原图上可画笔刷，三块画布都可以点击选择像素。
   * canPaint 为 false 时只做选择，不修改种子。
   */
  function bindCanvas(canvas, canPaint) {
    canvas.addEventListener('contextmenu', function (ev) {
      if (state.image) ev.preventDefault();
    });

    canvas.addEventListener('pointerdown', function (ev) {
      if (!state.image) return;
      var idx = pixelFromEvent(canvas, ev);
      if (idx < 0) return;
      if (!canPaint || state.tool === 'probe' || ev.button === 2) {
        selectPixel(idx);
        return;
      }
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      dragging = { canvas: canvas, changed: false, overwritten: 0 };
      if (paintAt(idx)) dragging.changed = true;
    });

    canvas.addEventListener('pointermove', function (ev) {
      if (!state.image) return;
      var idx = pixelFromEvent(canvas, ev);
      if (idx < 0) return;
      if (dragging && dragging.canvas === canvas) {
        if (paintAt(idx)) dragging.changed = true;
      } else if (!dragging) {
        setHover(idx);
      }
    });

    canvas.addEventListener('pointerup', function (ev) {
      if (!dragging || dragging.canvas !== canvas) return;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      var changed = dragging.changed;
      dragging = null;
      if (changed) {
        markDirty();
        scheduleRun();
      }
    });

    canvas.addEventListener('pointercancel', function () {
      if (dragging) {
        var changed = dragging.changed;
        dragging = null;
        if (changed) {
          markDirty();
          scheduleRun();
        }
      }
    });

    canvas.addEventListener('pointerleave', function () {
      if (!dragging) setHover(-1);
    });
  }

  function paintAt(idx) {
    var img = state.image;
    if (!img) return false;
    var w = img.width, h = img.height;
    var half = Math.floor(state.brush / 2);
    var x0 = idx % w;
    var y0 = Math.floor(idx / w);
    var value = state.tool === 'erase' ? 0 : state.tool === 'fg' ? 1 : 2;
    if (state.tool === 'probe') return false;
    var changed = false;
    var overwritten = 0;
    for (var dy = -half; dy < -half + state.brush; dy++) {
      for (var dx = -half; dx < -half + state.brush; dx++) {
        var x = x0 + dx;
        var y = y0 + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var i = y * w + x;
        var prev = state.seeds[i];
        if (prev === value) continue;
        // 画上另一类种子时，直接改类，而不是留下一个冲突像素：
        // 同一个像素无法同时作为两类的硬约束。
        if (value !== 0 && prev !== 0) overwritten++;
        state.seeds[i] = value;
        changed = true;
      }
    }
    if (changed) {
      refreshSeedState();
      noteSeedChange();
      requestRender();
      if (overwritten && dragging && !dragging.notifiedOverwrite) {
        dragging.notifiedOverwrite = true;
        setNotice('info', '已把 ' + overwritten + ' 个相反类别的种子改为当前类别。同一个像素不能同时是前景与背景。');
      }
    }
    return changed;
  }

  function clearSeeds() {
    if (!state.image || !state.seeds.length) return;
    state.seeds.fill(0);
    refreshSeedState();
    markDirty();
    scheduleRun(0);
    setNotice('info', '种子已清空。用「前景种子」和「背景种子」各标一些像素后再计算。');
    setStatus('idle', '待标注');
  }

  function selectPixel(idx) {
    if (!state.image) return;
    var picks = state.picks;
    if (!picks.length || picks[picks.length - 1] !== idx) {
      picks.push(idx);
      if (picks.length > 2) picks.shift();
    }
    renderPixelCard();
    renderEdgeCard();
    requestRender();
  }

  function setHover(idx) {
    if (state.hover === idx) return;
    state.hover = idx;
    els.hoverChip.textContent = idx >= 0 && state.image ? '悬停 ' + coordsOf(idx) : '悬停查看坐标';
    renderPixelCard();
  }

  function pixelFromEvent(canvas, ev) {
    if (!state.image) return -1;
    var rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return -1;
    var x = Math.floor((ev.clientX - rect.left) / rect.width * state.image.width);
    var y = Math.floor((ev.clientY - rect.top) / rect.height * state.image.height);
    if (x < 0 || y < 0 || x >= state.image.width || y >= state.image.height) return -1;
    return y * state.image.width + x;
  }

  // ---------------------------------------------------------------- 图片

  function loadImageBytes(bytes, name) {
    PNG.decode(bytes).then(function (img) {
      setImage(img.width, img.height, img.rgb, name || '未命名.png');
    }).catch(function (err) {
      setStatus('error', '图片无法打开');
      setNotice('error', '<b>无法打开图片。</b> ' + escapeHtml(err && err.message ? err.message : String(err)));
    });
  }

  function setImage(width, height, rgb, name) {
    cancelJob(false);
    state.imageSeq++;
    state.image = { width: width, height: height, rgb: rgb, name: name, seq: state.imageSeq };
    state.seeds = new Uint8Array(width * height);
    state.seedVersion++;
    state.result = null;
    state.dirty = false;
    state.hadResult = false;
    state.blockedReason = '';
    state.picks = [];
    state.hover = -1;
    state.costs = null;
    maskCacheKey = null;
    refreshSeedState();

    els.metaOriginal.textContent = name + ' · ' + width + '×' + height;
    els.metaMask.textContent = width + '×' + height;
    els.metaComposite.textContent = width + '×' + height;
    [els.canvasOriginal, els.canvasMask, els.canvasComposite].forEach(function (c) {
      c.width = width * PIXEL_SCALE;
      c.height = height * PIXEL_SCALE;
    });
    els.hoverChip.textContent = '悬停查看坐标';
    els.edgeChip.textContent = '—';

    fitAll();
    requestRender();
    updateSeedCounts();
    updateFreshnessUI();
    renderPixelCard();
    renderEdgeCard();
    setStatus('idle', '待标注');
    setNotice('info', '已载入 <b>' + escapeHtml(name) + '</b>（' + width + '×' + height +
      '）。用「前景种子」和「背景种子」各标一些像素。');
  }

  function loadSample(key) {
    var s = SAMPLES[key];
    if (!s) return;
    var bytes;
    try {
      bytes = base64ToBytes(s.png);
    } catch (e) {
      setNotice('error', '内置示例数据损坏。');
      return;
    }
    PNG.decode(bytes).then(function (img) {
      setImage(img.width, img.height, img.rgb, s.name);
      state.lambda = s.lambda;
      els.lambda.value = String(s.lambda);
      updateLambdaOut();

      if (key === 'conflict') {
        // 冲突配置走与「导入种子」完全相同的校验路径，明确拒绝。
        applySeedConfig({
          foreground: s.foreground,
          background: s.background,
          lambda: s.lambda
        }, 'conflict.json');
        setNotice('error', '<b>示例「冲突配置」被拒绝。</b> 像素 (1, 1) 同时出现在前景种子和背景种子中。' +
          '种子是硬约束，冲突会让约束不可满足，因此整份配置不会生效。请为像素 (1, 1) 只保留一类种子后重新导入。',
          [{ label: '了解，开始标注', onClick: function () { hideNotice(); setStatus('idle', '待标注'); } }]);
        setStatus('error', '配置冲突');
        return;
      }

      applySeedPoints(s.foreground, s.background);
      if (key === 'constant') {
        setNotice('info', '<b>示例「常色图」</b>：整幅同色。全部邻边颜色平方差为 0，按定义 β = 0，边权都等于 λ = 0；' +
          '两类种子均值也相同，颜色项 D₀ = D₁。最优割不唯一，结果由种子位置决定。');
      } else if (key === 'islands') {
        setNotice('info', '<b>示例「双岛」</b>：两个分离的前景区域。二元割不要求前景连通，两座岛都会被保留。');
      } else {
        setNotice('info', '<b>示例「微小样例」</b>：与包内 tiny.json 一致，能量可与 tiny-expected.json 对照。');
      }
      scheduleRun(0);
    }).catch(function (err) {
      setNotice('error', '内置示例无法解码：' + escapeHtml(err && err.message ? err.message : String(err)));
    });
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function applySeedPoints(fg, bg) {
    if (!state.image) return;
    var w = state.image.width, h = state.image.height;
    state.seeds.fill(0);
    var outOfRange = [];
    function put(list, value) {
      (list || []).forEach(function (p) {
        if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
          outOfRange.push(p);
          return;
        }
        var x = p[0], y = p[1];
        if (x < 0 || y < 0 || x >= w || y >= h) {
          outOfRange.push(p);
          return;
        }
        state.seeds[y * w + x] = value;
      });
    }
    put(fg, 1);
    put(bg, 2);
    refreshSeedState();
    markDirty();
    requestRender();
    if (outOfRange.length) {
      setNotice('warn', '有 ' + outOfRange.length + ' 个种子坐标超出图片范围，已忽略。');
    }
  }

  function applySeedConfig(raw, fileName) {
    var parsed;
    try {
      parsed = CONFIG.validateSeedConfig(raw, state.image
        ? { width: state.image.width, height: state.image.height }
        : null);
    } catch (err) {
      setStatus('error', '配置被拒绝');
      setNotice('error', '<b>种子配置被拒绝。</b> ' + escapeHtml(err && err.message ? err.message : String(err)));
      return false;
    }
    if (!state.image) {
      setNotice('warn', '配置有效（' + parsed.foreground.length + ' 个前景种子、' + parsed.background.length +
        ' 个背景种子），但还没有图片。先打开对应尺寸的 PNG，再导入这份配置。');
      return false;
    }
    state.seeds.fill(0);
    applySeedPoints(parsed.foreground, parsed.background);
    state.lambda = parsed.lambda;
    els.lambda.value = String(parsed.lambda);
    updateLambdaOut();
    markDirty();
    requestRender();
    var notes = [];
    if (parsed.lambdaDefaulted) notes.push('配置未写 λ，按 1 处理');
    if (parsed.duplicates) notes.push('忽略重复坐标 ' + parsed.duplicates + ' 个');
    setNotice('ok', '已从 ' + escapeHtml(fileName || '配置') + ' 导入 ' + parsed.foreground.length +
      ' 个前景种子、' + parsed.background.length + ' 个背景种子' +
      (notes.length ? '（' + notes.join('；') + '）' : '') + '。');
    scheduleRun(0);
    return true;
  }

  // ---------------------------------------------------------------- 种子与代价

  function refreshSeedState() {
    var s = state.seeds;
    var fg = 0, bg = 0;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === 1) fg++;
      else if (s[i] === 2) bg++;
    }
    state.fgCount = fg;
    state.bgCount = bg;
    state.seedVersion++;
    state.costs = null;
    if (fg > 0 && bg > 0 &&
        (state.blockedReason === '缺少前景种子' || state.blockedReason === '缺少背景种子')) {
      state.blockedReason = '';
    }
    updateSeedCounts();
  }

  function updateSeedCounts() {
    if (!state.image) {
      els.seedCounts.innerHTML = '<span>载入图片后可标注种子</span>';
      return;
    }
    els.seedCounts.innerHTML =
      '<span style="color:var(--fg-seed)">前景 ' + state.fgCount + '</span>' +
      '<span style="color:var(--bg-seed)">背景 ' + state.bgCount + '</span>' +
      '<button type="button" class="link-btn" id="clearSeeds">清空种子</button>';
  }

  function ensureCosts() {
    if (!state.image) return null;
    if (state.costs) return state.costs;
    var w = state.image.width, h = state.image.height;
    var rgb = state.image.rgb;
    var N = w * h;
    var m1 = [0, 0, 0], m0 = [0, 0, 0];
    var s = state.seeds;
    var n1 = 0, n0 = 0;
    var i, o;
    for (i = 0; i < N; i++) {
      var v = s[i];
      if (!v) continue;
      o = i * 3;
      if (v === 1) { m1[0] += rgb[o]; m1[1] += rgb[o + 1]; m1[2] += rgb[o + 2]; n1++; }
      else if (v === 2) { m0[0] += rgb[o]; m0[1] += rgb[o + 1]; m0[2] += rgb[o + 2]; n0++; }
    }
    var D0 = new Float64Array(N);
    var D1 = new Float64Array(N);
    var hasBoth = n1 > 0 && n0 > 0;
    if (hasBoth) {
      m1 = [m1[0] / n1 / 255, m1[1] / n1 / 255, m1[2] / n1 / 255];
      m0 = [m0[0] / n0 / 255, m0[1] / n0 / 255, m0[2] / n0 / 255];
      for (i = 0; i < N; i++) {
        o = i * 3;
        var r = rgb[o] / 255, g = rgb[o + 1] / 255, b = rgb[o + 2] / 255;
        var a0 = r - m0[0], b0 = g - m0[1], c0 = b - m0[2];
        var a1 = r - m1[0], b1 = g - m1[1], c1 = b - m1[2];
        D0[i] = a0 * a0 + b0 * b0 + c0 * c0;
        D1[i] = a1 * a1 + b1 * b1 + c1 * c1;
      }
    }
    var sum = 0, count = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = y * w + x;
        var op = p * 3;
        if (x + 1 < w) {
          var q = p + 1, oq = q * 3;
          var dr = (rgb[op] - rgb[oq]) / 255, dg = (rgb[op + 1] - rgb[oq + 1]) / 255, db = (rgb[op + 2] - rgb[oq + 2]) / 255;
          sum += dr * dr + dg * dg + db * db; count++;
        }
        if (y + 1 < h) {
          var q2 = p + w, oq2 = q2 * 3;
          var dr2 = (rgb[op] - rgb[oq2]) / 255, dg2 = (rgb[op + 1] - rgb[oq2 + 1]) / 255, db2 = (rgb[op + 2] - rgb[oq2 + 2]) / 255;
          sum += dr2 * dr2 + dg2 * dg2 + db2 * db2; count++;
        }
      }
    }
    var meanDiff = count ? sum / count : 0;
    state.costs = {
      m0: m0, m1: m1, n0: n0, n1: n1, hasBoth: hasBoth,
      D0: D0, D1: D1,
      meanDiff: meanDiff,
      beta: meanDiff === 0 ? 0 : 1 / (2 * meanDiff)
    };
    return state.costs;
  }

  function edgeWeight(p, q, costs) {
    var rgb = state.image.rgb;
    var op = p * 3, oq = q * 3;
    var dr = (rgb[op] - rgb[oq]) / 255;
    var dg = (rgb[op + 1] - rgb[oq + 1]) / 255;
    var db = (rgb[op + 2] - rgb[oq + 2]) / 255;
    var d = dr * dr + dg * dg + db * db;
    return { d: d, w: Number(state.lambda) * Math.exp(-costs.beta * d) };
  }

  // ---------------------------------------------------------------- 求解

  // 任何会影响当前结果的改动都从这里走：立即清掉旧结果并取消在跑的计算，
  // 保证界面上不会再显示与当前种子 / 参数不符的结果。
  function noteSeedChange() {
    if (state.result || state.job || !state.dirty) markDirty();
  }

  function markDirty() {
    state.dirty = true;
    if (state.job) cancelJob(false);
    state.result = null;
    maskCacheKey = null;
    updateFreshnessUI();
    requestRender();
    renderPixelCard();
    renderEdgeCard();
  }

  function scheduleRun(delay) {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(function () {
      runTimer = null;
      runNow();
    }, delay == null ? DEBOUNCE_MS : delay);
  }

  function runNow() {
    if (runTimer) { clearTimeout(runTimer); runTimer = null; }
    if (!state.image) {
      setNotice('warn', '先打开一张图片。');
      return;
    }
    if (!validateBeforeRun()) {
      updateFreshnessUI();
      return;
    }
    if (isCurrentResult()) {
      // 参数和种子都没变：保留现有结果，不重复计算。
      updateFreshnessUI();
      setStatus('ok', '结果已是最新');
      return;
    }
    startSolve();
  }

  function validateBeforeRun() {
    state.blockedReason = '';
    if (state.fgCount === 0) {
      state.blockedReason = '缺少前景种子';
      setStatus('warn', '缺少前景种子');
      setNotice('warn', '<b>缺少前景种子。</b> 用「前景种子」工具至少标一个像素（快捷键 1）。' +
        '前景种子是硬约束，不能省略。');
      return false;
    }
    if (state.bgCount === 0) {
      state.blockedReason = '缺少背景种子';
      setStatus('warn', '缺少背景种子');
      setNotice('warn', '<b>缺少背景种子。</b> 用「背景种子」工具至少标一个像素（快捷键 2）。' +
        '背景种子是硬约束，不能省略。');
      return false;
    }
    var lam = Number(state.lambda);
    if (!isFinite(lam) || lam < 0 || lam > 20) {
      state.blockedReason = 'λ 超出范围';
      setStatus('error', 'λ 超出范围');
      setNotice('error', '平滑强度 λ 必须在 0 到 20 之间。');
      return false;
    }
    updateFreshnessUI();
    return true;
  }

  function startSolve() {
    if (state.job) cancelJob(false);
    var sig = signature();
    var id = ++state.jobSeq;
    var fg = [], bg = [];
    for (var i = 0; i < state.seeds.length; i++) {
      if (state.seeds[i] === 1) fg.push(i);
      else if (state.seeds[i] === 2) bg.push(i);
    }
    var job = {
      type: 'solve',
      id: id,
      w: state.image.width,
      h: state.image.height,
      rgb: state.image.rgb.slice(),
      fg: new Uint32Array(fg),
      bg: new Uint32Array(bg),
      lambda: Number(state.lambda)
    };

    var worker = null;
    try {
      worker = new Worker(getWorkerUrl());
    } catch (err) {
      worker = null;
    }
    if (!worker) {
      runOnMainThread(job, sig);
      return;
    }

    state.job = { id: id, worker: worker, sig: sig, startedAt: Date.now() };
    state.computing = true;
    state.dirty = false;
    els.cancelBtn.hidden = false;
    els.runBtn.disabled = true;
    els.runMeta.textContent = '计算中…';
    setStatus('busy', '计算中');
    updateFreshnessUI();
    updateEmptyStates();

    worker.onmessage = function (ev) {
      var msg = ev.data;
      if (!state.job || state.job.id !== id) return;
      if (msg.type === 'progress') {
        els.runMeta.textContent = '计算中 · ' + (msg.phases || 0) + ' 相 · ' +
          Math.round(Date.now() - state.job.startedAt) + ' ms';
        return;
      }
      if (msg.type === 'result') finishSolve(id, msg, sig);
      else if (msg.type === 'error') failSolve(id, msg.message);
    };
    worker.onerror = function (ev) {
      failSolve(id, ev && ev.message ? ev.message : '计算线程异常');
    };

    try {
      worker.postMessage(job, [job.rgb.buffer]);
    } catch (err) {
      failSolve(id, err && err.message ? err.message : String(err));
    }
  }

  /*
   * 回退路径：环境无法创建 Blob Worker 时在主线程同步求解。
   * 这条路径会短暂阻塞界面，所以先让出一帧把「计算中」画出来。
   */
  var mainThreadHost = null;
  function runOnMainThread(job, sig) {
    if (!mainThreadHost) {
      mainThreadHost = {};
      ENGINE.entry(mainThreadHost);
    }
    state.job = { id: job.id, worker: null, sig: sig, startedAt: Date.now(), fallback: true };
    state.computing = true;
    state.dirty = false;
    els.cancelBtn.hidden = true;
    els.runBtn.disabled = true;
    els.runMeta.textContent = '计算中（兼容模式）…';
    setStatus('busy', '计算中');
    updateFreshnessUI();
    updateEmptyStates();
    setNotice('info', '当前环境不支持后台计算线程，正在主线程求解，界面会短暂无响应。');
    setTimeout(function () {
      if (!state.job || state.job.id !== job.id) return;
      try {
        var out = mainThreadHost.matteSolveJob(job);
        out.type = 'result';
        out.id = job.id;
        out.wallMs = Date.now() - state.job.startedAt;
        finishSolve(job.id, out, sig);
      } catch (err) {
        failSolve(job.id, err && err.message ? err.message : String(err));
      }
    }, 30);
  }

  var workerUrl = null;
  function getWorkerUrl() {
    if (!workerUrl) {
      workerUrl = URL.createObjectURL(new Blob([ENGINE.workerSource], { type: 'text/javascript' }));
    }
    return workerUrl;
  }

  function failSolve(id, message) {
    if (!state.job || state.job.id !== id) return;
    teardownJob();
    setStatus('error', '计算失败');
    els.runMeta.textContent = '计算失败';
    setNotice('error', '<b>计算没有完成。</b> ' + escapeHtml(message || '未知错误'));
    updateFreshnessUI();
    requestRender();
  }

  function finishSolve(id, msg, sig) {
    if (!state.job || state.job.id !== id) return;
    var expected = signature();
    teardownJob();
    if (sig !== expected) {
      // 结果来自旧参数：丢弃，绝不当作当前结果。
      state.dirty = true;
      updateFreshnessUI();
      requestRender();
      setStatus('warn', '参数已变更');
      return;
    }
    state.dirty = false;
    state.hadResult = true;
    state.resultSeq++;
    state.blockedReason = '';
    state.result = {
      labels: new Uint8Array(msg.labels),
      beta: msg.beta,
      meanDiff: msg.meanDiff,
      m0: msg.m0,
      m1: msg.m1,
      lambda: msg.lambda,
      unary: msg.unary,
      boundary: msg.boundary,
      total: msg.total,
      maxFlow: msg.maxFlow,
      finiteUpper: msg.finiteUpper,
      seedCapacity: msg.seedCapacity,
      fgComponents: msg.fgComponents,
      fgCount: msg.fgCount,
      bgCount: msg.bgCount,
      phases: msg.phases,
      augmentations: msg.augmentations,
      ms: msg.wallMs || msg.ms,
      sig: sig
    };
    maskCacheKey = null;
    updateFreshnessUI();
    requestRender();
    renderPixelCard();
    renderEdgeCard();
    setStatus('ok', '结果已更新');
    reportDegenerateCases();
  }

  function reportDegenerateCases() {
    var r = state.result;
    if (!r) return;
    var sameMean = Math.abs(r.m1[0] - r.m0[0]) < 1e-12 &&
      Math.abs(r.m1[1] - r.m0[1]) < 1e-12 &&
      Math.abs(r.m1[2] - r.m0[2]) < 1e-12;
    if (r.meanDiff === 0) {
      setNotice('info', '<b>常色图处理：</b>全部邻边的颜色平方差均值为 0，按定义取 β = 0，所有边权等于 λ。' +
        (sameMean ? '两类种子均值也相同，颜色项 D₀ = D₁，最优割不唯一，当前显示其中任意一个最优割。'
          : '两类种子均值不同，颜色项仍然决定归属。'), null, 'result');
    } else if (sameMean) {
      setNotice('warn', '<b>两类种子颜色均值相同。</b> 颜色项对两类没有区分力，割的位置只由边界项决定。', null, 'result');
    } else if (r.fgComponents > 1) {
      setNotice('ok', '<b>已保留 ' + r.fgComponents + ' 个分离的前景区域。</b> 二元割允许前景不连通，种子不会被合并或丢弃。', null, 'result');
    } else if (state.noticeKind === 'result') {
      // 只收起上一次自动生成的结果说明，不覆盖导入、缺种子等用户需要看的提示。
      hideNotice();
    }
  }

  function teardownJob() {
    var job = state.job;
    state.job = null;
    state.computing = false;
    if (job && job.worker) {
      try { job.worker.terminate(); } catch (e) { /* 忽略 */ }
    }
    els.cancelBtn.hidden = true;
    els.runBtn.disabled = false;
  }

  function cancelJob(showNotice) {
    if (!state.job) return;
    teardownJob();
    state.dirty = true;
    updateFreshnessUI();
    requestRender();
    if (showNotice) {
      setStatus('warn', '计算已取消');
      setNotice('warn', '计算已取消，没有更新结果。可调整种子或参数后重新计算。');
    }
  }

  // ---------------------------------------------------------------- 渲染

  function updateEmptyStates() {
    var hasImage = !!state.image;
    var hasResult = isCurrentResult();
    els.emptyOriginal.hidden = hasImage;
    els.emptyMask.hidden = hasImage && hasResult;
    els.emptyComposite.hidden = hasImage && hasResult;
    if (!hasResult) {
      var msg = !hasImage ? '等待图片。'
        : state.computing ? '正在计算当前参数…'
          : state.blockedReason ? state.blockedReason + '，暂无当前结果。'
            : state.dirty ? (state.hadResult ? '参数已更改，旧结果已清除，等待重新计算。' : '等待第一次计算。')
              : '等待计算。';
      els.emptyMask.querySelector('p').textContent = msg;
      els.emptyComposite.querySelector('p').textContent = msg;
      els.canvasMask.style.visibility = 'hidden';
      els.canvasComposite.style.visibility = 'hidden';
    } else {
      els.canvasMask.style.visibility = 'visible';
      els.canvasComposite.style.visibility = 'visible';
    }
  }

  // 结果是否与当前「图片 + 种子 + λ」一致。只有一致的结果才能当作当前结果。
  function isCurrentResult() {
    return !!(state.result && state.result.sig === signature());
  }

  function updateFreshnessUI() {
    updateEmptyStates();
    updateEnergyUI();
    // 结果有效性只由签名决定：签名相同就说明它确实是当前参数的结果，
    // 即使同一参数正在重算，也可以继续展示。
    var fresh = isCurrentResult();
    els.exportMask.disabled = !fresh;
    els.exportRgba.disabled = !fresh;
    els.exportConfig.disabled = !state.image;
    if (fresh) {
      els.freshTag.textContent = state.computing ? '当前结果 · 重算中' : '当前结果';
      els.freshTag.setAttribute('data-state', 'ok');
    } else if (state.computing) {
      els.freshTag.textContent = '计算中';
      els.freshTag.setAttribute('data-state', 'busy');
    } else if (state.blockedReason) {
      els.freshTag.textContent = state.blockedReason;
      els.freshTag.setAttribute('data-state', 'warn');
    } else if (state.image && (state.dirty || state.hadResult)) {
      els.freshTag.textContent = '结果已过期';
      els.freshTag.setAttribute('data-state', 'warn');
    } else if (state.image) {
      els.freshTag.textContent = state.fgCount && state.bgCount ? '待计算' : '待标注';
      els.freshTag.setAttribute('data-state', '');
    } else {
      els.freshTag.textContent = '无结果';
      els.freshTag.setAttribute('data-state', '');
    }
  }

  function updateEnergyUI() {
    var r = state.result;
    var costs = state.costs;
    if (r) {
      els.sumUnary.textContent = fmt(r.unary, 6);
      els.sumBoundary.textContent = fmt(r.boundary, 6);
      els.sumTotal.textContent = fmt(r.total, 6);
      els.betaOut.textContent = fmt(r.beta, 6);
      els.flowOut.textContent = fmt(r.maxFlow, 6);
      els.compOut.textContent = String(r.fgComponents);
      els.swatchFg.style.background = cssRgb(r.m1);
      els.swatchBg.style.background = cssRgb(r.m0);
      els.meanFg.textContent = fmtBytes(r.m1) + ' · ' + hexFromMean(r.m1);
      els.meanBg.textContent = fmtBytes(r.m0) + ' · ' + hexFromMean(r.m0);
      var diff = Math.abs(r.maxFlow - r.total);
      els.detailBody.innerHTML =
        '<p>最大流等于最小割容量；按标签重算的总能量与割容量一致（本图差值 ' + diff.toExponential(2) + '）。</p>' +
        '<dl>' +
        '<div class="kv"><span>全部有限项之和</span><span>' + fmt(r.finiteUpper, 6) + '</span></div>' +
        '<div class="kv"><span>种子硬约束容量 K</span><span>' + fmt(r.seedCapacity, 6) + '</span></div>' +
        '<div class="kv"><span>求解用 λ</span><span>' + fmt(r.lambda, 2) + '</span></div>' +
        '<div class="kv"><span>前景 / 背景种子</span><span>' + r.fgCount + ' / ' + r.bgCount + '</span></div>' +
        '<div class="kv"><span>Dinic 相数 / 增广次数</span><span>' + r.phases + ' / ' + r.augmentations + '</span></div>' +
        '<div class="kv"><span>求解耗时</span><span>' + Math.round(r.ms) + ' ms</span></div>' +
        '</dl>' +
        '<p>K 严格大于全部有限项之和，切开种子必然贵于任何可行割，所以种子一定保留。</p>';
      els.runMeta.textContent = '上次 ' + Math.round(r.ms) + ' ms · ' + r.phases + ' 相 · ' +
        r.augmentations + ' 次增广';
    } else {
      els.sumUnary.textContent = '—';
      els.sumBoundary.textContent = '—';
      els.sumTotal.textContent = '—';
      els.betaOut.textContent = costs ? fmt(costs.beta, 6) : '—';
      els.flowOut.textContent = '—';
      els.compOut.textContent = '—';
      els.swatchFg.style.background = costs && costs.n1 ? cssRgb(costs.m1) : 'transparent';
      els.swatchBg.style.background = costs && costs.n0 ? cssRgb(costs.m0) : 'transparent';
      els.meanFg.textContent = costs && costs.n1 ? fmtBytes(costs.m1) + ' · ' + hexFromMean(costs.m1) : '—';
      els.meanBg.textContent = costs && costs.n0 ? fmtBytes(costs.m0) + ' · ' + hexFromMean(costs.m0) : '—';
      if (!state.computing) {
        els.detailBody.innerHTML = '<p>完成一次计算后，这里会列出割容量、最大流、种子硬约束容量与求解统计。</p>';
        if (state.image) {
          els.runMeta.textContent = state.dirty ? '参数已更改，旧结果已清除' : '—';
        } else {
          els.runMeta.textContent = '—';
        }
      }
    }
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderOriginal();
      renderResults();
    });
  }

  function themeColor(name, fallback) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { v = ''; }
    return v || fallback;
  }

  function renderOriginal() {
    var img = state.image;
    if (!img) return;
    var w = img.width, h = img.height, S = PIXEL_SCALE;
    var seedOverlayFg = themeColor('--fg-seed', '#b93c19') + 'cc';
    var seedOverlayBg = themeColor('--bg-seed', '#2f6bc4') + 'cc';
    var canvas = els.canvasOriginal;
    var ctx = canvas.getContext('2d');
    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    var octx = off.getContext('2d');
    var id = octx.createImageData(w, h);
    for (var i = 0; i < w * h; i++) {
      id.data[i * 4] = img.rgb[i * 3];
      id.data[i * 4 + 1] = img.rgb[i * 3 + 1];
      id.data[i * 4 + 2] = img.rgb[i * 3 + 2];
      id.data[i * 4 + 3] = 255;
    }
    octx.putImageData(id, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    var seeds = state.seeds;
    for (var p = 0; p < w * h; p++) {
      var v = seeds[p];
      if (!v) continue;
      var x = (p % w) * S, y = Math.floor(p / w) * S;
      ctx.fillStyle = v === 1 ? seedOverlayFg : seedOverlayBg;
      ctx.fillRect(x, y, S, S);
    }

    for (var k = 0; k < state.picks.length; k++) {
      var pi = state.picks[k];
      var px = (pi % w) * S, py = Math.floor(pi / w) * S;
      var active = k === state.picks.length - 1;
      ctx.strokeStyle = active ? 'rgba(10, 20, 20, 0.95)' : 'rgba(255, 255, 255, 0.95)';
      var lw = Math.max(1, S * 0.24);
      ctx.lineWidth = lw;
      ctx.strokeRect(px + lw / 2, py + lw / 2, S - lw, S - lw);
      if (active) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = Math.max(1, S * 0.12);
        ctx.strokeRect(px + S * 0.2, py + S * 0.2, S * 0.6, S * 0.6);
      }
    }
    if (state.hover >= 0) {
      var hx = (state.hover % w) * S, hy = Math.floor(state.hover / w) * S;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx + 0.5, hy + 0.5, S - 1, S - 1);
    }
  }

  function renderResults() {
    var img = state.image;
    var r = isCurrentResult() ? state.result : null;
    updateEmptyStates();
    if (!img || !r) return;
    var w = img.width, h = img.height, N = w * h;

    var key = state.imageSeq + ':' + state.resultSeq;
    var rebuild = key !== maskCacheKey;
    if (rebuild) {
      maskCacheKey = key;
      drawMaskAndComposite(img, r);
    }
    drawPicksOn(els.canvasMask, 'rgba(255, 214, 64, 0.95)');
    drawPicksOn(els.canvasComposite, 'rgba(255, 214, 64, 0.95)');
  }

  function drawMaskAndComposite(img, r) {
    var w = img.width, h = img.height, N = w * h;

    var maskOff = document.createElement('canvas');
    maskOff.width = w; maskOff.height = h;
    var mctx = maskOff.getContext('2d');
    var mid = mctx.createImageData(w, h);
    for (var i = 0; i < N; i++) {
      var v = r.labels[i] ? 255 : 0;
      mid.data[i * 4] = v;
      mid.data[i * 4 + 1] = v;
      mid.data[i * 4 + 2] = v;
      mid.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(mid, 0, 0);
    var maskCtx = els.canvasMask.getContext('2d');
    maskCtx.imageSmoothingEnabled = false;
    maskCtx.clearRect(0, 0, els.canvasMask.width, els.canvasMask.height);
    maskCtx.drawImage(maskOff, 0, 0, els.canvasMask.width, els.canvasMask.height);

    var compOff = document.createElement('canvas');
    compOff.width = w; compOff.height = h;
    var cctx = compOff.getContext('2d');
    var cid = cctx.createImageData(w, h);
    for (i = 0; i < N; i++) {
      cid.data[i * 4] = img.rgb[i * 3];
      cid.data[i * 4 + 1] = img.rgb[i * 3 + 1];
      cid.data[i * 4 + 2] = img.rgb[i * 3 + 2];
      cid.data[i * 4 + 3] = r.labels[i] ? 255 : 0;
    }
    cctx.putImageData(cid, 0, 0);
    var compCtx = els.canvasComposite.getContext('2d');
    compCtx.imageSmoothingEnabled = false;
    compCtx.clearRect(0, 0, els.canvasComposite.width, els.canvasComposite.height);
    compCtx.drawImage(compOff, 0, 0, els.canvasComposite.width, els.canvasComposite.height);
  }

  function drawPicksOn(canvas, color) {
    var img = state.image;
    if (!img) return;
    var ctx = canvas.getContext('2d');
    var S = PIXEL_SCALE, w = img.width;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, S * 0.24);
    state.picks.forEach(function (pi) {
      var x = (pi % w) * S, y = Math.floor(pi / w) * S;
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2,
        S - ctx.lineWidth, S - ctx.lineWidth);
    });
    ctx.restore();
  }

  function fitAll() {
    var img = state.image;
    if (!img) return;
    [[els.wrapOriginal, els.canvasOriginal],
      [els.wrapMask, els.canvasMask],
      [els.wrapComposite, els.canvasComposite]].forEach(function (pair) {
      var wrap = pair[0], canvas = pair[1];
      var style = getComputedStyle(wrap);
      var padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
      var padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
      var availW = Math.max(40, wrap.clientWidth - padX);
      var availH = Math.max(40, Math.min(window.innerHeight * 0.5, 520) - padY);
      var scale = Math.min(availW / img.width, availH / img.height);
      if (!isFinite(scale) || scale <= 0) scale = 1;
      canvas.style.width = Math.max(1, Math.floor(img.width * scale)) + 'px';
      canvas.style.height = Math.max(1, Math.floor(img.height * scale)) + 'px';
    });
  }

  // ---------------------------------------------------------------- 检查器

  function renderPixelCard() {
    var body = els.pixelBody;
    var empty = '<p class="empty-line">点击一个像素，查看它对前景、背景两类均值的颜色代价 D。</p>';
    if (!state.image) { body.innerHTML = empty; return; }
    var pick = state.picks.length ? state.picks[state.picks.length - 1] : state.hover;
    if (pick == null || pick < 0) { body.innerHTML = empty; return; }

    var costs = ensureCosts();
    var rgb = state.image.rgb;
    var isPick = state.picks.length > 0;
    var seed = state.seeds[pick];
    var label = isCurrentResult() ? state.result.labels[pick] : -1;

    var badge = '';
    if (seed === 1) badge = '<span class="label-pill fg">前景种子</span>';
    else if (seed === 2) badge = '<span class="label-pill bg">背景种子</span>';
    else if (label === 1) badge = '<span class="label-pill fg">判为前景</span>';
    else if (label === 0) badge = '<span class="label-pill bg">判为背景</span>';

    var html = '<div class="cost-top">' +
      '<span class="color-chip" style="background:' + rgbHex(rgb, pick) + '"></span>' +
      '<span class="cost-coords">' + (isPick ? '选中 ' : '悬停 ') + coordsOf(pick) + '</span>' +
      '<span class="cost-hex">' + rgbHex(rgb, pick) + ' · ' +
        rgb[pick * 3] + ',' + rgb[pick * 3 + 1] + ',' + rgb[pick * 3 + 2] + '</span>' +
      badge + '</div>';

    if (!costs.hasBoth) {
      var miss = [];
      if (!costs.n1) miss.push('前景');
      if (!costs.n0) miss.push('背景');
      html += '<p class="empty-line">缺少' + miss.join('与') + '种子，还无法计算两类均值与颜色代价。</p>';
      body.innerHTML = html;
      return;
    }

    var d0 = costs.D0[pick], d1 = costs.D1[pick];
    var maxD = Math.max(d0, d1, 1e-12);
    html += '<div class="cost-bars">' +
      '<div class="cost-row"><span class="cost-name"><span class="marker fg"></span>D 前景</span>' +
      '<span class="cost-track"><span class="cost-fill fg" style="width:' + pctBar(d1, maxD) + '"></span></span>' +
      '<span class="cost-val">' + fmt(d1, 6) + '</span></div>' +
      '<div class="cost-row"><span class="cost-name"><span class="marker bg"></span>D 背景</span>' +
      '<span class="cost-track"><span class="cost-fill bg" style="width:' + pctBar(d0, maxD) + '"></span></span>' +
      '<span class="cost-val">' + fmt(d0, 6) + '</span></div>' +
      '</div><p class="cost-foot">';
    if (label === 1) {
      html += '当前结果判为<b>前景</b>，颜色项取 <b>' + fmt(d1, 6) + '</b>。';
    } else if (label === 0) {
      html += '当前结果判为<b>背景</b>，颜色项取 <b>' + fmt(d0, 6) + '</b>。';
    } else {
      html += '结果尚未更新，上面是按当前种子均值算出的两类代价。';
    }
    html += ' 均值 m₁ = ' + fmtBytes(costs.m1) + '，m₀ = ' + fmtBytes(costs.m0) + '。</p>';
    body.innerHTML = html;
  }

  function pctBar(v, maxV) {
    if (!(v > 0)) return '0%';
    return (Math.min(1, v / maxV) * 100).toFixed(1) + '%';
  }

  function renderEdgeCard() {
    var body = els.edgeBody;
    var empty = '<p class="empty-line">接着点击它的上下左右相邻像素，查看这条边的权重 w<sub>pq</sub>。</p>';
    if (!state.image || state.picks.length < 2) {
      els.edgeChip.textContent = '—';
      body.innerHTML = empty;
      return;
    }
    var a = state.picks[state.picks.length - 2];
    var b = state.picks[state.picks.length - 1];
    var w = state.image.width;
    var ax = a % w, ay = Math.floor(a / w), bx = b % w, by = Math.floor(b / w);
    var same = a === b;
    var adjacent = !same &&
      ((ax === bx && Math.abs(ay - by) === 1) || (ay === by && Math.abs(ax - bx) === 1));
    els.edgeChip.textContent = coordsOf(a) + (same ? '' : ' ↔ ' + coordsOf(b));
    if (same) {
      body.innerHTML = '<p class="empty-line">两次点击落在同一个像素。请再点一个相邻像素。</p>';
      return;
    }
    if (!adjacent) {
      var dist = Math.abs(ax - bx) + Math.abs(ay - by);
      body.innerHTML = '<p class="empty-line">这两个像素不相邻（曼哈顿距离 ' + dist +
        '）。边权只定义在上下左右四邻边上，请选择相邻像素。</p>';
      return;
    }

    var costs = ensureCosts();
    var ew = edgeWeight(a, b, costs);
    var cutHtml;
    if (isCurrentResult()) {
      var la = state.result.labels[a], lb = state.result.labels[b];
      cutHtml = '<p class="edge-foot">当前结果两端为 <b>' + (la ? '前景' : '背景') + '</b> / <b>' +
        (lb ? '前景' : '背景') + '</b>：' +
        (la !== lb ? '这条边被切开，权重计入边界项。' : '两端标签相同，这条边不计入边界项。') + '</p>';
    } else {
      cutHtml = '<p class="edge-foot">结果尚未更新；重量按当前 λ 与整图 β 直接算出。</p>';
    }
    body.innerHTML =
      '<div class="edge-flow">' +
      '<span class="edge-node"><span class="marker" style="background:' + rgbHex(state.image.rgb, a) + '"></span>' + coordsOf(a) + '</span>' +
      '<span class="edge-dash">—</span>' +
      '<span class="edge-node"><span class="marker" style="background:' + rgbHex(state.image.rgb, b) + '"></span>' + coordsOf(b) + '</span>' +
      '</div>' +
      '<div class="edge-weight mono">w = ' + fmt(ew.w, 6) + '</div>' +
      '<div class="edge-caption">这条边的权重</div>' +
      '<p class="edge-formula">w = λ·exp(−β·d)<br>= ' + fmt(Number(state.lambda), 2) + ' × exp(−' +
        fmt(costs.beta, 6) + ' × ' + fmt(ew.d, 6) + ')</p>' +
      cutHtml +
      '<p class="edge-foot">d = ‖c<sub>p</sub>−c<sub>q</sub>‖² = ' + fmt(ew.d, 6) +
      '；β 由整幅图全部右/下邻边决定，与种子无关。</p>';
  }

  // ---------------------------------------------------------------- 导出

  function seedCoords(kind) {
    var out = [];
    if (!state.image) return out;
    var w = state.image.width;
    for (var i = 0; i < state.seeds.length; i++) {
      if (state.seeds[i] === kind) out.push([i % w, Math.floor(i / w)]);
    }
    return out;
  }

  function currentConfig(includeModel) {
    return CONFIG.buildSeedConfig({
      foreground: seedCoords(1),
      background: seedCoords(2),
      lambda: Number(state.lambda),
      image: { width: state.image.width, height: state.image.height, name: state.image.name },
      result: includeModel && isCurrentResult() ? state.result : null
    });
  }

  function download(bytes, filename, mime) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function fileBase() {
    var name = state.image && state.image.name ? state.image.name : 'matte';
    return name.replace(/\.png$/i, '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'matte';
  }

  function exportMaskPng() {
    var r = isCurrentResult() ? state.result : null;
    if (!r || !state.image) return;
    var N = state.image.width * state.image.height;
    var pixels = new Uint8Array(N);
    for (var i = 0; i < N; i++) pixels[i] = r.labels[i] ? 255 : 0;
    els.exportMask.disabled = true;
    PNG.encode(state.image.width, state.image.height, 0, pixels).then(function (bytes) {
      download(bytes, fileBase() + '-mask.png');
      setNotice('ok', '已导出掩膜 PNG：0/255 灰度，' + state.image.width + '×' + state.image.height + '。');
    }).catch(function (err) {
      setNotice('error', '导出掩膜失败：' + escapeHtml(err && err.message ? err.message : String(err)));
    }).then(function () { els.exportMask.disabled = !state.result; });
  }

  function exportRgbaPng() {
    var r = isCurrentResult() ? state.result : null;
    if (!r || !state.image) return;
    var img = state.image;
    var N = img.width * img.height;
    var pixels = new Uint8Array(N * 4);
    for (var i = 0; i < N; i++) {
      pixels[i * 4] = img.rgb[i * 3];
      pixels[i * 4 + 1] = img.rgb[i * 3 + 1];
      pixels[i * 4 + 2] = img.rgb[i * 3 + 2];
      pixels[i * 4 + 3] = r.labels[i] ? 255 : 0;
    }
    els.exportRgba.disabled = true;
    PNG.encode(img.width, img.height, 6, pixels).then(function (bytes) {
      download(bytes, fileBase() + '-rgba.png');
      setNotice('ok', '已导出 RGBA PNG：保留原 RGB，Alpha 为 0/255 二值。');
    }).catch(function (err) {
      setNotice('error', '导出透明 PNG 失败：' + escapeHtml(err && err.message ? err.message : String(err)));
    }).then(function () { els.exportRgba.disabled = !state.result; });
  }

  function exportSeedJson() {
    if (!state.image) return;
    var cfg = currentConfig(true);
    download(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }),
      fileBase() + '-seeds.json');
    setNotice('ok', '已导出种子配置' + (cfg.model ? '（含当前结果的均值与能量）' : '（无当前结果，未写入能量）') + '。');
  }

  function copySeedJson() {
    if (!state.image) return;
    var text = JSON.stringify(currentConfig(true), null, 2);
    var done = function () { setNotice('ok', '种子配置 JSON 已复制到剪贴板。'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done();
      else setNotice('warn', '复制失败。可以改用「种子 JSON」按钮导出文件。');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
