/* 横段掩码裁区拓扑检查台 —— 页面交互。
 * 纯算法全部在 js/topology.js（window.RunMaskTopology），本文件只做渲染与交互。
 * 经典脚本写法，file:// 直接打开也能运行（示例 fetch 失败时有内置兜底数据）。
 */
(function () {
  'use strict';

  var T = window.RunMaskTopology;
  var $ = function (id) { return document.getElementById(id); };

  var EMBEDDED_SAMPLE = {
    width: 20, height: 12,
    runs: [[4, 3, 8], [2, 5, 8], [3, 7, 8], [2, 3, 5], [3, 3, 4], [8, 10, 12], [8, 11, 14]],
  };

  var state = {
    fileName: '',
    mask: null,
    full: null,
    analysis: null,
    crop: { x0: 0, y0: 0, x1: 0, y1: 0, width: 0, height: 0 },
    parseMs: 0,
    fullMs: 0,
    cropMs: 0,
    selection: null, // {kind:'foreground'|'hole'|'external', number?, x,y}
    trackedProbe: null, // {x,y}
    tab: 'fg',
    view: { scale: 1, cx: 0, cy: 0 },
    hover: null,
    exportText: '',
    ovTransform: null,
    ovLayer: null,
    ovLayerKey: '',
    drag: null,
  };

  /* ---------------- 工具 ---------------- */

  function fmtInt(n) {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }
  function fmtMs(ms) { return ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s'; }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  function prng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var nums = [1, 2, 5, 10];
    for (var i = 0; i < nums.length; i++) if (nums[i] * p >= raw) return nums[i] * p;
    return 10 * p;
  }

  function lowerBoundYs(ys, y) {
    var lo = 0, hi = ys.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ys[mid] < y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function setupCanvas(cv) {
    var rect = cv.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return { ctx: ctx, w: w, h: h };
  }

  /* ---------------- 数据载入 ---------------- */

  function loadJSONObject(obj, name) {
    var t0 = performance.now();
    var mask = T.parseMask(obj);
    state.parseMs = performance.now() - t0;
    state.fileName = name || '内存数据';
    state.mask = mask;

    t0 = performance.now();
    state.full = T.analyzeMask(mask);
    state.fullMs = performance.now() - t0;

    var fullCrop = { x0: 0, y0: 0, x1: mask.width, y1: mask.height };
    state.trackedProbe = null;
    applyCropImmediate(fullCrop);
    fitCropView();

    $('input-crop-x0').max = mask.width;
    $('input-crop-x1').max = mask.width;
    $('input-crop-y0').max = mask.height;
    $('input-crop-y1').max = mask.height;
    $('overview-empty').hidden = true;
    ['btn-export', 'btn-copy-json'].forEach(function (id) { $(id).disabled = false; });

    if (mask.warnings && mask.warnings.length) {
      console.warn('[run-mask] 规整警告：', mask.warnings);
      toast('已载入，但有 ' + mask.warnings.length + ' 条坐标警告（已自动规整，详见控制台）');
    } else {
      toast('已载入 ' + state.fileName + '：' + fmtInt(mask.width) + '×' + fmtInt(mask.height) +
        '，规范横段 ' + fmtInt(mask.canonicalRunCount) + ' 条');
    }
    drawOverview();
    updateMachineState();
    return getSummary();
  }

  function loadSample() {
    return fetch('samples/run-mask.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return loadJSONObject(j, 'samples/run-mask.json'); })
      .catch(function () {
        // file:// 下 fetch 常被浏览器拦截，使用与样例文件一致的内置副本。
        return loadJSONObject(EMBEDDED_SAMPLE, '内置示例（samples/run-mask.json 兜底副本）');
      });
  }

  function generateBenchmark() {
    var rnd = prng(20261127);
    var W = 1e6, H = 1e6, runs = [];
    function pushSeg(y, a, b) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      if (a > b) { var t = a; a = b; b = t; }
      a = Math.max(0, Math.floor(a)); b = Math.min(W, Math.floor(b));
      y = Math.max(0, Math.min(H - 1, Math.floor(y)));
      if (b > a) runs.push([y, a, b]);
    }
    // 先放规则小环阵列（约 6 万段、约 1 万个真实孔），避免被 20 万截断切掉
    for (var gy = 0; gy < 40; gy++) {
      for (var gx = 0; gx < 250; gx++) {
        var bx = 2000 + gx * 3900;
        var by = 2000 + gy * 24000;
        if (bx + 6 > W || by + 4 > H) continue;
        runs.push([by, bx, bx + 6]);
        runs.push([by + 1, bx, bx + 1], [by + 1, bx + 5, bx + 6]);
        runs.push([by + 2, bx, bx + 1], [by + 2, bx + 5, bx + 6]);
        runs.push([by + 3, bx, bx + 6]);
      }
    }
    // 随机段 + 重复/拆分，压解析与前景 DSU；总数精确补到 20 万
    var i = 0;
    while (runs.length < 200000) {
      var y = Math.floor(rnd() * H);
      var x0 = Math.floor(rnd() * (W - 4000));
      var len = 1 + Math.floor(rnd() * 3000);
      pushSeg(y, x0, x0 + len);
      if (runs.length < 200000 && i % 7 === 0) runs.push([y, x0, Math.min(W, x0 + len)]);
      if (runs.length + 2 <= 200000 && i % 11 === 0 && len > 4) {
        var cut = x0 + 2 + Math.floor(rnd() * (len - 3));
        runs.push([y, x0, cut]);
        runs.push([y, cut - 1, x0 + len]);
      }
      i++;
    }
    runs = runs.slice(0, 200000);
    var obj = { width: W, height: H, runs: runs };
    return loadJSONObject(obj, '满额压测数据（100 万×100 万 / 20 万段）');
  }

  /* ---------------- 裁区与统计 ---------------- */

  function readCropInputs() {
    return {
      x0: parseInt($('input-crop-x0').value, 10),
      y0: parseInt($('input-crop-y0').value, 10),
      x1: parseInt($('input-crop-x1').value, 10),
      y1: parseInt($('input-crop-y1').value, 10),
    };
  }

  function writeCropInputs(c) {
    $('input-crop-x0').value = c.x0;
    $('input-crop-y0').value = c.y0;
    $('input-crop-x1').value = c.x1;
    $('input-crop-y1').value = c.y1;
  }

  // 同步执行裁区核算（自动化 API 也走这里，保证可立即取结果）。
  function applyCropImmediate(rectLike) {
    if (!state.mask) return null;
    var crop = T.normalizeCrop(rectLike || {}, state.mask.width, state.mask.height);
    state.crop = crop;
    writeCropInputs(crop);

    var t0 = performance.now();
    state.analysis = T.analyzeMask(state.mask, crop);
    state.cropMs = performance.now() - t0;

    state.selection = null; // 编号随裁区重排，旧选择失效
    state.exportText = T.exportJSON(state.analysis);

    renderStats();
    componentList.setSelected(-1, false);
    holeList.setSelected(-1, false);
    componentList.refresh();
    holeList.refresh();
    renderSelectionDetail();
    renderTrackStatus();
    drawCrop();
    drawOverview(); // 同步整图导航上的裁区框
    updateMachineState();
    $('crop-timing').textContent = '裁区核算 ' + fmtMs(state.cropMs) + '（要求 < 8 s）';
    return getSummary();
  }

  function applyCropAsync(rectLike) {
    if (!state.mask) return Promise.resolve(null);
    $('crop-busy').hidden = false;
    // 让“核算中”提示先绘制，再执行同步重计算。
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          resolve(applyCropImmediate(rectLike));
        } finally {
          $('crop-busy').hidden = true;
        }
      }, 30);
    });
  }

  function resetCrop() {
    if (!state.mask) return;
    applyCropAsync({ x0: 0, y0: 0, x1: state.mask.width, y1: state.mask.height })
      .then(function () { fitCropView(); });
  }

  function getSummary() {
    if (!state.analysis) return null;
    return {
      fileName: state.fileName,
      width: state.mask.width,
      height: state.mask.height,
      crop: { x0: state.crop.x0, y0: state.crop.y0, x1: state.crop.x1, y1: state.crop.y1 },
      timingsMs: { parse: state.parseMs, full: state.fullMs, crop: state.cropMs },
      stats: state.analysis.stats,
      selection: state.selection,
      trackedProbe: state.trackedProbe,
    };
  }

  function updateMachineState() {
    var s = getSummary() || {};
    $('machine-state').textContent = JSON.stringify(s);
  }

  function renderStats() {
    var m = state.mask, a = state.analysis, s = a.stats;
    $('stat-width-height').textContent = fmtInt(m.width) + ' × ' + fmtInt(m.height);
    $('stat-raw-runs').textContent = fmtInt(s.rawRunCount) + ' / ' + fmtInt(s.canonicalRunCount);
    $('stat-crop-rect').textContent = '[' + s.cropX0 + ', ' + s.cropY0 + ') – [' + s.cropX1 + ', ' + s.cropY1 + ')';
    $('stat-crop-area').textContent = fmtInt(s.cropWidth) + '×' + fmtInt(s.cropHeight) +
      ' = ' + fmtInt(s.cropArea);
    $('stat-crop-runs').textContent = fmtInt(s.cropRunCount);
    $('stat-fg-pixels').textContent = fmtInt(s.foregroundPixels);
    $('stat-bg-pixels').textContent = fmtInt(s.backgroundPixels);
    $('stat-fg-components').textContent = fmtInt(s.foregroundComponents);
    $('stat-holes').textContent = fmtInt(s.holes);
    $('stat-hole-pixels').textContent = fmtInt(s.holePixels);
    $('stat-perimeter').textContent = fmtInt(s.totalPerimeter);
    $('time-full').textContent = '整图 ' + fmtMs(state.fullMs) +
      ' · 解析 ' + fmtMs(state.parseMs);
    $('count-components').textContent = fmtInt(a.components.length);
    $('count-holes').textContent = fmtInt(a.holes.length);
  }

  /* ---------------- 虚拟列表 ---------------- */

  function VList(containerId, variant) {
    this.el = $(containerId);
    this.variant = variant; // 'fg' | 'hole'
    this.rowH = 58;
    this.selected = -1;
    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    this.el.appendChild(this.inner);
    var self = this;
    this.el.addEventListener('scroll', function () { self.render(); });
    this.inner.addEventListener('click', function (e) {
      var row = e.target.closest('.vrow');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-index'), 10);
      if (self.variant === 'fg') selectComponent(idx + 1, true);
      else selectHole(idx + 1, true);
    });
  }
  VList.prototype.count = function () {
    if (!state.analysis) return 0;
    return this.variant === 'fg' ? state.analysis.components.length : state.analysis.holes.length;
  };
  VList.prototype.setSelected = function (i, scroll) {
    this.selected = i;
    this.render();
    if (scroll && i >= 0) {
      var target = i * this.rowH - this.el.clientHeight / 2 + this.rowH / 2;
      this.el.scrollTop = Math.max(0, target);
    }
  };
  VList.prototype.refresh = function () { this.render(); };
  VList.prototype.render = function () {
    var count = this.count();
    if (!count) {
      this.inner.style.height = 'auto';
      this.inner.innerHTML = '<div class="list-empty">' +
        (this.variant === 'fg' ? '当前裁区内没有前景组件' : '当前裁区内没有不贴边的背景孔') + '</div>';
      return;
    }
    this.inner.style.height = (count * this.rowH) + 'px';
    var scrollTop = this.el.scrollTop;
    var vh = this.el.clientHeight || 300;
    var start = Math.max(0, Math.floor(scrollTop / this.rowH) - 5);
    var end = Math.min(count, Math.ceil((scrollTop + vh) / this.rowH) + 5);
    var html = '';
    for (var i = start; i < end; i++) {
      var item = this.variant === 'fg' ? state.analysis.components[i] : state.analysis.holes[i];
      var selClass = i === this.selected
        ? (this.variant === 'fg' ? ' selected' : ' selected selected-hole')
        : '';
      var rowClass = 'vrow ' + (this.variant === 'hole' ? 'row-hole' : '') + selClass;
      var line1, line2;
      if (this.variant === 'fg') {
        line1 = '面积 ' + fmtInt(item.area) + ' · 周长 ' + fmtInt(item.perimeter);
        line2 = '框 [' + item.bbox.x0 + ',' + item.bbox.y0 + ')-[' + item.bbox.x1 + ',' + item.bbox.y1 +
          ') · ' + item.bbox.width + '×' + item.bbox.height;
      } else {
        line1 = '孔内格数 ' + fmtInt(item.area) + ' · 横段 ' + fmtInt(item.runCount);
        line2 = '框 [' + item.bbox.x0 + ',' + item.bbox.y0 + ')-[' + item.bbox.x1 + ',' + item.bbox.y1 +
          ') · ' + item.bbox.width + '×' + item.bbox.height;
      }
      html += '<button type="button" role="option" class="' + rowClass + '" data-index="' + i +
        '" style="top:' + (i * this.rowH) + 'px" aria-selected="' + (i === this.selected) + '">' +
        '<span class="row-num">#' + item.number + '</span>' +
        '<span class="row-body"><span class="row-line1">' + line1 + '</span>' +
        '<span class="row-line2">' + line2 + '</span></span></button>';
    }
    this.inner.innerHTML = html;
  };

  var componentList, holeList;

  /* ---------------- 选择与明细 ---------------- */

  function selectComponent(number, locate) {
    if (!state.analysis || number < 1 || number > state.analysis.components.length) return;
    state.selection = { kind: 'foreground', number: number };
    state.tab = 'fg';
    switchTab('fg');
    componentList.setSelected(number - 1, true);
    holeList.setSelected(-1, false);
    renderSelectionDetail();
    if (locate) locateBBox(state.analysis.components[number - 1].bbox);
    drawCrop();
    updateMachineState();
  }

  function selectHole(number, locate) {
    if (!state.analysis || number < 1 || number > state.analysis.holes.length) return;
    state.selection = { kind: 'hole', number: number };
    state.tab = 'hole';
    switchTab('hole');
    holeList.setSelected(number - 1, true);
    componentList.setSelected(-1, false);
    renderSelectionDetail();
    $('btn-track-hole').disabled = false;
    if (locate) locateBBox(state.analysis.holes[number - 1].bbox);
    drawCrop();
    updateMachineState();
  }

  function renderSelectionDetail() {
    var box = $('selection-detail');
    var sel = state.selection;
    $('btn-track-hole').disabled = !(sel && sel.kind === 'hole');
    if (!state.analysis) { box.innerHTML = '<p class="muted">尚未载入数据。</p>'; return; }

    if (!sel) {
      box.innerHTML = '<p class="muted">尚未选中组件或孔。可在画布上单击，或从下方列表选择。</p>';
      return;
    }
    if (sel.kind === 'external') {
      box.innerHTML = '<p class="muted">点 (' + sel.x + ', ' + sel.y +
        ') 是<b>与裁区边相通的外部背景</b>，按规则不计为孔。</p>';
      return;
    }
    if (sel.kind === 'outside-crop') {
      box.innerHTML = '<p class="muted">该点不在当前裁区内。</p>';
      return;
    }
    if (sel.kind === 'foreground') {
      var c = state.analysis.components[sel.number - 1];
      if (!c) return;
      box.innerHTML =
        '<h3 class="detail-title"><span class="badge badge-fg">组件 #' + c.number + '</span> 前景四连通</h3>' +
        '<dl class="detail-grid">' +
        '<dt>面积</dt><dd>' + fmtInt(c.area) + ' 格</dd>' +
        '<dt>周长</dt><dd>' + fmtInt(c.perimeter) + ' 条单位边（含裁切边）</dd>' +
        '<dt>横段数</dt><dd>' + fmtInt(c.runCount) + '</dd>' +
        '<dt>包围框</dt><dd>[' + c.bbox.x0 + ', ' + c.bbox.y0 + ') – [' + c.bbox.x1 + ', ' + c.bbox.y1 + ')</dd>' +
        '<dt>框尺寸</dt><dd>' + c.bbox.width + ' × ' + c.bbox.height + '</dd>' +
        '<dt>最上最左格</dt><dd>(' + c.anchor.x + ', ' + c.anchor.y + ')</dd>' +
        '</dl>' +
        '<div class="detail-actions"><button class="btn btn-small" id="detail-locate" type="button">在图中定位</button></div>';
      $('detail-locate').onclick = function () { locateBBox(c.bbox); };
      return;
    }
    if (sel.kind === 'hole') {
      var h = state.analysis.holes[sel.number - 1];
      if (!h) return;
      box.innerHTML =
        '<h3 class="detail-title"><span class="badge badge-hole">孔 #' + h.number + '</span> 背景八连通 · 不贴边</h3>' +
        '<dl class="detail-grid">' +
        '<dt>面积</dt><dd>' + fmtInt(h.area) + ' 格背景</dd>' +
        '<dt>背景横段</dt><dd>' + fmtInt(h.runCount) + '</dd>' +
        '<dt>包围框</dt><dd>[' + h.bbox.x0 + ', ' + h.bbox.y0 + ') – [' + h.bbox.x1 + ', ' + h.bbox.y1 + ')</dd>' +
        '<dt>框尺寸</dt><dd>' + h.bbox.width + ' × ' + h.bbox.height + '</dd>' +
        '<dt>最上最左格</dt><dd>(' + h.anchor.x + ', ' + h.anchor.y + ')</dd>' +
        '<dt>跟踪探针</dt><dd>(' + h.probe.x + ', ' + h.probe.y + ')</dd>' +
        '</dl>' +
        '<div class="detail-actions"><button class="btn btn-small" id="detail-locate-hole" type="button">在图中定位</button>' +
        '<button class="btn btn-small btn-primary" id="detail-track-hole" type="button">跟踪此孔</button></div>';
      $('detail-locate-hole').onclick = function () { locateBBox(h.bbox); };
      $('detail-track-hole').onclick = function () { startTrackHole(h.number); };
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    $('tab-components').classList.toggle('active', tab === 'fg');
    $('tab-holes').classList.toggle('active', tab === 'hole');
    $('component-list').hidden = tab !== 'fg';
    $('hole-list').hidden = tab !== 'hole';
    // 隐藏容器中的列表 clientHeight 可能为 0，切回时重算窗口
    setTimeout(function () {
      if (tab === 'fg') componentList.render(); else holeList.render();
    }, 0);
  }

  /* ---------------- 孔跟踪 ---------------- */

  function startTrackHole(number) {
    if (!state.analysis) return;
    var h = state.analysis.holes[number - 1];
    if (!h) return;
    state.trackedProbe = { x: h.probe.x, y: h.probe.y };
    $('btn-clear-track').disabled = false;
    renderTrackStatus();
    drawCrop();
    updateMachineState();
    toast('已在 (' + h.probe.x + ', ' + h.probe.y + ') 放置跟踪探针；改变裁区后这里会报告该孔是否贯通外部。');
  }

  function renderTrackStatus() {
    var el = $('track-status');
    $('btn-clear-track').disabled = !state.trackedProbe;
    if (!state.trackedProbe || !state.analysis) {
      el.className = 'track-status';
      el.textContent = '在「孔」列表或画布中选中一个孔，点「跟踪此孔」；之后裁掉顶边若干行，可直接看它是否已与外部八连通。';
      return;
    }
    var info = T.trackProbe(state.analysis, state.trackedProbe);
    if (info.status === 'hole') {
      el.className = 'track-status state-hole';
      el.textContent = '探针 (' + state.trackedProbe.x + ', ' + state.trackedProbe.y +
        ')：仍是孔 #' + info.number + '，面积 ' + fmtInt(info.hole.area) +
        '。继续裁边，直到它变成外部背景即说明已贯通。';
    } else if (info.status === 'external') {
      el.className = 'track-status state-external';
      el.textContent = '探针 (' + state.trackedProbe.x + ', ' + state.trackedProbe.y +
        ')：该孔已与裁区外部背景八连通，不再计为孔！';
    } else if (info.status === 'outside') {
      el.className = 'track-status state-outside';
      el.textContent = '探针 (' + state.trackedProbe.x + ', ' + state.trackedProbe.y +
        ') 已落到当前裁区之外（可能已被裁掉）。请把裁区扩回，或重新选择孔。';
    } else {
      el.className = 'track-status';
      el.textContent = '探针状态：' + info.status;
    }
  }

  /* ---------------- 裁区画布：视图与绘制 ---------------- */

  function fitCropView() {
    var wrap = $('crop-wrap');
    var w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
    var c = state.crop;
    var cw = Math.max(1, c.width), ch = Math.max(1, c.height);
    var scale = Math.min((w - 28) / cw, (h - 28) / ch);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    state.view.scale = Math.max(scale, 1e-6);
    state.view.cx = c.x0 + c.width / 2;
    state.view.cy = c.y0 + c.height / 2;
    drawCrop();
  }

  function locateBBox(bb) {
    var wrap = $('crop-wrap');
    var w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
    var bw = Math.max(1, bb.width), bh = Math.max(1, bb.height);
    var target = Math.min((w * 0.82) / bw, (h * 0.82) / bh);
    // 小目标给一个足够放大、但仍可观察周边的尺度
    if (bb.width <= 2 && bb.height <= 2) target = Math.max(target, 18);
    state.view.scale = Math.min(64, Math.max(target, 1e-6));
    state.view.cx = (bb.x0 + bb.x1) / 2;
    state.view.cy = (bb.y0 + bb.y1) / 2;
    drawCrop();
  }

  function cropPointToWorld(cv, clientX, clientY) {
    var rect = cv.getBoundingClientRect();
    var sx = clientX - rect.left, sy = clientY - rect.top;
    var m = setupCanvas(cv); // 仅取尺寸不重置也无妨；这里 rect 已够
    return {
      x: (sx - m.w / 2) / state.view.scale + state.view.cx,
      y: (sy - m.h / 2) / state.view.scale + state.view.cy,
      sx: sx, sy: sy, w: m.w, h: m.h,
    };
  }

  function drawCrop() {
    var cv = $('crop-canvas');
    if (!cv || !state.analysis) return;
    var d = setupCanvas(cv), ctx = d.ctx, w = d.w, h = d.h;
    var a = state.analysis, idx = a.index, v = state.view;

    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);

    var x2s = function (x) { return (x - v.cx) * v.scale + w / 2; };
    var y2s = function (y) { return (y - v.cy) * v.scale + h / 2; };

    var wx0 = v.cx - w / 2 / v.scale;
    var wx1 = v.cx + w / 2 / v.scale;
    var wy0 = v.cy - h / 2 / v.scale;
    var wy1 = v.cy + h / 2 / v.scale;

    // 网格（足够放大时）
    if (v.scale >= 7) {
      var step = niceStep(64 / v.scale);
      ctx.lineWidth = 1;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-grid') || 'rgba(148,163,184,.14)';
      ctx.beginPath();
      var gx0 = Math.max(a.crop.x0, Math.ceil(wx0 / step) * step);
      var gx1 = Math.min(a.crop.x1, Math.floor(wx1 / step) * step);
      for (var gx = gx0; gx <= gx1; gx += step) {
        var sx = Math.round(x2s(gx)) + .5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
      var gy0 = Math.max(a.crop.y0, Math.ceil(wy0 / step) * step);
      var gy1 = Math.min(a.crop.y1, Math.floor(wy1 / step) * step);
      for (var gy = gy0; gy <= gy1; gy += step) {
        var sy = Math.round(y2s(gy)) + .5;
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
      if (v.scale >= 16) {
        ctx.fillStyle = 'rgba(148,163,184,.75)';
        ctx.font = '10px ui-monospace, monospace';
        for (var gx2 = gx0; gx2 <= gx1; gx2 += step) {
          ctx.fillText(String(gx2), x2s(gx2) + 3, 11);
        }
        for (var gy2 = gy0; gy2 <= gy1; gy2 += step) {
          ctx.fillText(String(gy2), 4, y2s(gy2) - 3);
        }
      }
    }

    // 裁区边界
    ctx.strokeStyle = 'rgba(96,165,250,.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x2s(a.crop.x0), y2s(a.crop.y0),
      a.crop.width * v.scale, a.crop.height * v.scale);
    ctx.setLineDash([]);

    var minPx = v.scale < 1 ? 1.1 : 0;

    // 背景孔（先画，位于前景之下），按可见行扫描背景段
    ctx.fillStyle = 'rgba(244,63,94,.30)';
    ctx.beginPath();
    var li0 = Math.max(0, Math.floor(wy0) - a.crop.y0);
    var li1 = Math.min(a.crop.height - 1, Math.ceil(wy1) - a.crop.y0);
    if (li1 >= li0) {
      for (var li = li0; li <= li1; li++) {
        var rs = idx.rowStart[li], re = idx.rowStart[li + 1];
        var yy = a.crop.y0 + li;
        if (yy + 1 < wy0 || yy > wy1) continue;
        for (var bi = rs; bi < re; bi++) {
          if (idx.bgHoleNumber[bi] <= 0) continue;
          var bx0 = idx.bgX0[bi], bx1 = idx.bgX1[bi];
          if (bx1 < wx0 || bx0 > wx1) continue;
          var rx = x2s(bx0), ry = y2s(yy);
          var rw = (bx1 - bx0) * v.scale, rh = v.scale;
          if (minPx) { rw = Math.max(rw, 1.1); rh = Math.max(rh, 1.1); }
          ctx.rect(rx, ry, rw, rh);
        }
      }
      ctx.fill();
    }

    // 前景横段
    ctx.fillStyle = 'rgba(125,211,252,.9)';
    ctx.beginPath();
    var yi0 = lowerBoundYs(idx.fgYs, Math.floor(wy0) - 1);
    for (var yi = yi0; yi < idx.fgYs.length; yi++) {
      var fy = idx.fgYs[yi];
      if (fy > wy1 + 1) break;
      if (fy + 1 < wy0) continue;
      var row = idx.fgRows.get(fy);
      for (var ri = 0; ri < row.length; ri++) {
        var run = row[ri];
        if (run.x1 < wx0) continue;
        if (run.x0 > wx1) break;
        var fx = x2s(run.x0), fyScreen = y2s(run.y);
        var fw = (run.x1 - run.x0) * v.scale, fh = v.scale;
        if (minPx) { fw = Math.max(fw, 1.1); fh = Math.max(fh, 1.1); }
        ctx.rect(fx, fyScreen, fw, fh);
      }
    }
    ctx.fill();

    // 选中的孔：高亮其横段
    if (state.selection && state.selection.kind === 'hole') {
      var hn = state.selection.number;
      ctx.fillStyle = 'rgba(52,211,153,.55)';
      ctx.beginPath();
      for (var li2 = Math.max(0, Math.floor(wy0) - a.crop.y0);
        li2 <= Math.min(a.crop.height - 1, Math.ceil(wy1) - a.crop.y0); li2++) {
        var hs = idx.rowStart[li2], he = idx.rowStart[li2 + 1];
        var hy = a.crop.y0 + li2;
        for (var hbi = hs; hbi < he; hbi++) {
          if (idx.bgHoleNumber[hbi] !== hn) continue;
          var hx0 = idx.bgX0[hbi], hx1 = idx.bgX1[hbi];
          var hrw = (hx1 - hx0) * v.scale, hrh = Math.max(v.scale, minPx ? 1.4 : v.scale);
          ctx.rect(x2s(hx0), y2s(hy), hrw, hrh);
        }
      }
      ctx.fill();
      drawBBox(ctx, state.analysis.holes[hn - 1].bbox, '#34d399', '孔 #' + hn, x2s, y2s);
    }

    // 选中的前景组件
    if (state.selection && state.selection.kind === 'foreground') {
      var cn = state.selection.number;
      ctx.fillStyle = 'rgba(251,191,36,.95)';
      ctx.beginPath();
      var runs = idx.fgRuns;
      for (var rj = 0; rj < runs.length; rj++) {
        if (idx.runCompNumber[rj] !== cn) continue;
        var sr = runs[rj];
        var sw = (sr.x1 - sr.x0) * v.scale, sh = v.scale;
        if (minPx) { sw = Math.max(sw, 1.6); sh = Math.max(sh, 1.6); }
        ctx.rect(x2s(sr.x0), y2s(sr.y), sw, sh);
      }
      ctx.fill();
      drawBBox(ctx, state.analysis.components[cn - 1].bbox, '#fbbf24', '组件 #' + cn, x2s, y2s);
    }

    // 跟踪探针
    if (state.trackedProbe) {
      var p = state.trackedProbe;
      if (p.x >= a.crop.x0 && p.x < a.crop.x1 && p.y >= a.crop.y0 && p.y < a.crop.y1) {
        var px = x2s(p.x + .5), py = y2s(p.y + .5);
        var info = T.trackProbe(a, p);
        ctx.strokeStyle = info.status === 'external' ? '#ef4444'
          : info.status === 'hole' ? '#34d399' : '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px - 11, py); ctx.lineTo(px - 4, py);
        ctx.moveTo(px + 4, py); ctx.lineTo(px + 11, py);
        ctx.moveTo(px, py - 11); ctx.lineTo(px, py - 4);
        ctx.moveTo(px, py + 4); ctx.lineTo(px, py + 11);
        ctx.stroke();
      }
    }

    // 悬停格
    if (state.hover && !state.drag) {
      var hv = state.hover;
      if (hv.x >= a.crop.x0 && hv.x < a.crop.x1 && hv.y >= a.crop.y0 && hv.y < a.crop.y1) {
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x2s(hv.x) + .5, y2s(hv.y) + .5,
          Math.max(v.scale, 1), Math.max(v.scale, 1));
      }
    }
  }

  function drawBBox(ctx, bb, color, label, x2s, y2s) {
    if (!bb) return;
    var x = x2s(bb.x0), y = y2s(bb.y0);
    var w = bb.width * state.view.scale, h = bb.height * state.view.scale;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.font = 'bold 12px ui-monospace, system-ui, sans-serif';
    var tw = ctx.measureText(label).width;
    var lx = x, ly = y - 20;
    if (ly < 4) ly = y + 4;
    ctx.fillStyle = color;
    roundRect(ctx, lx, ly, tw + 14, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#101828';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 7, ly + 9);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, h);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 整图导航 ---------------- */

  function overviewTransform(w, h) {
    var m = state.mask;
    var pad = 10;
    var scale = Math.min((w - pad * 2) / m.width, (h - pad * 2) / m.height);
    var ox = (w - m.width * scale) / 2;
    var oy = (h - m.height * scale) / 2;
    return { scale: scale, ox: ox, oy: oy };
  }

  function buildOverviewLayer(w, h) {
    var dpr = window.devicePixelRatio || 1;
    var layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    var ctx = layer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var tr = overviewTransform(w, h);

    ctx.fillStyle = '#0d1730';
    ctx.fillRect(0, 0, w, h);

    // 孔（整图分析）
    if (state.full) {
      var fi = state.full.index;
      ctx.fillStyle = 'rgba(244,63,94,.4)';
      ctx.beginPath();
      for (var bi = 0; bi < fi.nBg; bi++) {
        if (fi.bgHoleNumber[bi] <= 0) continue;
        var x = tr.ox + fi.bgX0[bi] * tr.scale;
        var y = tr.oy + fi.bgY[bi] * tr.scale;
        var rw = Math.max((fi.bgX1[bi] - fi.bgX0[bi]) * tr.scale, 1);
        var rh = Math.max(tr.scale, 1);
        ctx.rect(x, y, rw, rh);
      }
      ctx.fill();
    }

    // 前景规范横段
    if (state.mask) {
      ctx.fillStyle = 'rgba(125,211,252,.9)';
      ctx.beginPath();
      var ys = state.mask.ys;
      for (var i = 0; i < ys.length; i++) {
        var y = ys[i];
        var runs = state.mask.rows.get(y);
        for (var j = 0; j < runs.length; j++) {
          var r = runs[j];
          var rx = tr.ox + r[0] * tr.scale;
          var ry = tr.oy + y * tr.scale;
          var rw2 = Math.max((r[1] - r[0]) * tr.scale, 1);
          var rh2 = Math.max(tr.scale, 1.1);
          ctx.rect(rx, ry, rw2, rh2);
        }
      }
      ctx.fill();
    }
    state.ovLayer = layer;
    state.ovLayerKey = w + 'x' + h + '@' + dpr;
  }

  function drawOverview() {
    var cv = $('overview-canvas');
    if (!cv || !state.mask) return;
    var d = setupCanvas(cv), ctx = d.ctx, w = d.w, h = d.h;
    var key = w + 'x' + h + '@' + (window.devicePixelRatio || 1);
    if (!state.ovLayer || state.ovLayerKey !== key) buildOverviewLayer(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.ovLayer, 0, 0, w, h);

    var tr = overviewTransform(w, h);
    state.ovTransform = tr;
    var toX = function (x) { return tr.ox + x * tr.scale; };
    var toY = function (y) { return tr.oy + y * tr.scale; };

    // 原图边框
    ctx.strokeStyle = 'rgba(148,163,184,.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tr.ox, tr.oy, state.mask.width * tr.scale, state.mask.height * tr.scale);

    // 当前裁区外压暗
    var c = state.crop;
    var cx = toX(c.x0), cy = toY(c.y0);
    var cw = c.width * tr.scale, ch = c.height * tr.scale;
    ctx.fillStyle = 'rgba(4,8,18,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(cx, cy, cw, ch);
    ctx.fill('evenodd');

    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(cx + .5, cy + .5, cw, ch);

    // 拖选框
    if (state.drag && state.drag.rect) {
      var r = state.drag.rect;
      var rx = toX(r.x0), ry = toY(r.y0);
      var rw = (r.x1 - r.x0) * tr.scale, rh = (r.y1 - r.y0) * tr.scale;
      ctx.fillStyle = 'rgba(251,191,36,.18)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#fbbf24';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(rx + .5, ry + .5, rw, rh);
      ctx.setLineDash([]);
    }
    $('overview-size').textContent = fmtInt(state.mask.width) + ' × ' + fmtInt(state.mask.height);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $('btn-sample').addEventListener('click', loadSample);
    $('btn-import').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(String(reader.result));
          loadJSONObject(obj, file.name);
        } catch (err) {
          console.error(err);
          toast('导入失败：' + (err.message || err), true);
        }
      };
      reader.onerror = function () { toast('读取文件失败', true); };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('btn-benchmark').addEventListener('click', function () {
      try { generateBenchmark(); }
      catch (err) { console.error(err); toast('生成压测数据失败：' + err.message, true); }
    });

    $('crop-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var r = readCropInputs();
      applyCropAsync(r).then(function () { fitCropView(); });
    });
    $('btn-reset-crop').addEventListener('click', resetCrop);
    $('btn-trim-top').addEventListener('click', function () {
      if (!state.mask) return;
      var n = parseInt($('input-trim-top').value, 10);
      if (!(n >= 1)) { toast('请输入 ≥1 的裁掉行数', true); return; }
      var c = state.crop;
      var next = { x0: c.x0, x1: c.x1, y0: Math.min(c.y1 - 1, c.y0 + n), y1: c.y1 };
      applyCropAsync(next);
    });

    $('tab-components').addEventListener('click', function () { switchTab('fg'); });
    $('tab-holes').addEventListener('click', function () { switchTab('hole'); });
    $('btn-jump').addEventListener('click', function () {
      var n = parseInt($('input-jump-number').value, 10);
      if (!(n >= 1)) return;
      // 根据当前可见 tab 跳转对应列表编号
      if ($('component-list').hidden === false) selectComponent(n, true);
      else selectHole(n, true);
    });
    $('input-jump-number').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('btn-jump').click(); }
    });

    $('btn-track-hole').addEventListener('click', function () {
      if (state.selection && state.selection.kind === 'hole') startTrackHole(state.selection.number);
    });
    $('btn-clear-track').addEventListener('click', function () {
      state.trackedProbe = null;
      renderTrackStatus();
      drawCrop();
      updateMachineState();
    });

    $('crop-zoom-in').addEventListener('click', function () { zoomBy(1.35); });
    $('crop-zoom-out').addEventListener('click', function () { zoomBy(1 / 1.35); });
    $('crop-zoom-fit').addEventListener('click', fitCropView);

    bindOverviewPointer();
    bindCropPointer();
    bindExport();

    var ro = new ResizeObserver(function () {
      if (state.mask) { drawOverview(); drawCrop(); }
    });
    ro.observe($('overview-canvas').parentElement);
    ro.observe($('crop-wrap'));
  }

  function zoomBy(factor) {
    state.view.scale = Math.min(200, Math.max(1e-6, state.view.scale * factor));
    drawCrop();
  }

  function bindOverviewPointer() {
    var cv = $('overview-canvas');
    function world(e) {
      var rect = cv.getBoundingClientRect();
      var tr = state.ovTransform || overviewTransform(rect.width, rect.height);
      return {
        x: (e.clientX - rect.left - tr.ox) / tr.scale,
        y: (e.clientY - rect.top - tr.oy) / tr.scale,
      };
    }
    cv.addEventListener('pointerdown', function (e) {
      if (!state.mask) return;
      var p = world(e);
      state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, id: e.pointerId };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!state.drag) return;
      var p = world(e);
      state.drag.x1 = p.x; state.drag.y1 = p.y;
      if (Math.abs(p.x - state.drag.x0) * (state.ovTransform.scale) > 3 ||
        Math.abs(p.y - state.drag.y0) * (state.ovTransform.scale) > 3) state.drag.moved = true;
      var m = state.mask;
      state.drag.rect = {
        x0: Math.max(0, Math.min(state.drag.x0, state.drag.x1)),
        y0: Math.max(0, Math.min(state.drag.y0, state.drag.y1)),
        x1: Math.min(m.width, Math.max(state.drag.x0, state.drag.x1)),
        y1: Math.min(m.height, Math.max(state.drag.y0, state.drag.y1)),
      };
      drawOverview();
    });
    function end(e) {
      if (!state.drag) return;
      var d = state.drag;
      state.drag = null;
      if (d.moved && state.mask) {
        var rect = T.normalizeCrop({
          x0: Math.floor(Math.min(d.x0, d.x1)),
          y0: Math.floor(Math.min(d.y0, d.y1)),
          x1: Math.ceil(Math.max(d.x0, d.x1)),
          y1: Math.ceil(Math.max(d.y0, d.y1)),
        }, state.mask.width, state.mask.height);
        if (rect.width >= 1 && rect.height >= 1) {
          applyCropAsync(rect).then(function () { fitCropView(); });
        }
      }
      drawOverview();
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', function () { state.drag = null; drawOverview(); });
  }

  function bindCropPointer() {
    var cv = $('crop-canvas');
    var pan = null;

    cv.addEventListener('pointerdown', function (e) {
      if (!state.analysis) return;
      var p = cropPointToWorld(cv, e.clientX, e.clientY);
      pan = {
        startSx: p.sx, startSy: p.sy,
        cx: state.view.cx, cy: state.view.cy,
        moved: false, id: e.pointerId,
      };
      cv.setPointerCapture(e.pointerId);
    });

    cv.addEventListener('pointermove', function (e) {
      if (!state.analysis) return;
      var p = cropPointToWorld(cv, e.clientX, e.clientY);
      var wx = Math.floor(p.x), wy = Math.floor(p.y);
      state.hover = { x: wx, y: wy };
      var locText = 'x: ' + wx + '  y: ' + wy;
      if (wx < state.analysis.crop.x0 || wx >= state.analysis.crop.x1 ||
        wy < state.analysis.crop.y0 || wy >= state.analysis.crop.y1) {
        locText += '（裁区外）';
      } else {
        var loc = T.locateAt(state.analysis, wx, wy);
        if (loc.kind === 'foreground') locText += ' · 前景组件 #' + loc.number;
        else if (loc.kind === 'hole') locText += ' · 孔 #' + loc.number;
        else locText += ' · 外部背景';
      }
      $('cursor-coords').textContent = locText;

      if (pan) {
        var dx = p.sx - pan.startSx, dy = p.sy - pan.startSy;
        if (Math.abs(dx) + Math.abs(dy) > 5) {
          pan.moved = true;
          cv.parentElement.classList.add('panning');
        }
        if (pan.moved) {
          state.view.cx = pan.cx - dx / state.view.scale;
          state.view.cy = pan.cy - dy / state.view.scale;
          drawCrop();
        }
      }
    });

    cv.addEventListener('pointerup', function (e) {
      cv.parentElement.classList.remove('panning');
      if (!pan) return;
      var wasMove = pan.moved;
      pan = null;
      if (wasMove) return;
      var p = cropPointToWorld(cv, e.clientX, e.clientY);
      var wx = Math.floor(p.x), wy = Math.floor(p.y);
      var loc = T.locateAt(state.analysis, wx, wy);
      if (loc.kind === 'foreground') selectComponent(loc.number, false);
      else if (loc.kind === 'hole') selectHole(loc.number, false);
      else if (loc.kind === 'external') {
        state.selection = { kind: 'external', x: wx, y: wy };
        componentList.setSelected(-1, false);
        holeList.setSelected(-1, false);
        renderSelectionDetail();
        drawCrop();
        updateMachineState();
      } else {
        state.selection = { kind: 'outside-crop', x: wx, y: wy };
        renderSelectionDetail();
      }
    });
    cv.addEventListener('pointerleave', function () { state.hover = null; drawCrop(); });

    cv.addEventListener('dblclick', fitCropView);

    cv.addEventListener('wheel', function (e) {
      if (!state.analysis) return;
      e.preventDefault();
      var rect = cv.getBoundingClientRect();
      var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      var w = rect.width, h = rect.height;
      var wxBefore = (sx - w / 2) / state.view.scale + state.view.cx;
      var wyBefore = (sy - h / 2) / state.view.scale + state.view.cy;
      var factor = Math.exp(-e.deltaY * 0.0014);
      state.view.scale = Math.min(200, Math.max(1e-6, state.view.scale * factor));
      state.view.cx = wxBefore - (sx - w / 2) / state.view.scale;
      state.view.cy = wyBefore - (sy - h / 2) / state.view.scale;
      drawCrop();
    }, { passive: false });
  }

  /* ---------------- 导出 ---------------- */

  function bindExport() {
    $('btn-export').addEventListener('click', function () {
      if (!state.analysis) return;
      state.exportText = T.exportJSON(state.analysis);
      $('export-text').value = state.exportText;
      var s = state.analysis.stats;
      $('export-meta').textContent =
        'runs: ' + s.cropRunCount + ' 条 · 组件 ' + s.foregroundComponents +
        ' · 孔 ' + s.holes + ' · 总周长 ' + s.totalPerimeter +
        ' · 坐标均为原图坐标，裁区 [' + s.cropX0 + ',' + s.cropY0 + ')-[' + s.cropX1 + ',' + s.cropY1 + ')';
      $('export-modal').hidden = false;
    });
    $('btn-close-modal').addEventListener('click', function () { $('export-modal').hidden = true; });
    $('export-modal').addEventListener('click', function (e) {
      if (e.target === $('export-modal')) $('export-modal').hidden = true;
    });
    $('btn-download').addEventListener('click', downloadExport);
    $('btn-modal-copy').addEventListener('click', function () {
      copyText($('export-text').value).then(function () { toast('已复制完整导出 JSON'); });
    });
    $('btn-copy-json').addEventListener('click', function () {
      if (!state.analysis) return;
      copyText(T.exportJSON(state.analysis)).then(function () { toast('已复制裁区导出 JSON'); });
    });
  }

  function downloadExport() {
    if (!state.analysis) return;
    var text = T.exportJSON(state.analysis);
    var c = state.crop;
    var name = 'run-mask-crop_' + c.x0 + '-' + c.y0 + '_' + c.x1 + '-' + c.y1 + '.json';
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('已开始下载 ' + name);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    ta.remove();
  }

  /* ---------------- 对外自动化 API ---------------- */

  window.RunMaskApp = {
    version: '1.0.0',
    loadJSONObject: loadJSONObject,
    loadSample: loadSample,
    generateBenchmark: generateBenchmark,
    setCrop: function (rect) { return applyCropImmediate(rect); },
    resetCrop: function () { return resetCrop(); },
    fitView: fitCropView,
    getMask: function () { return state.mask; },
    getFullAnalysis: function () { return state.full; },
    getAnalysis: function () { return state.analysis; },
    getState: getSummary,
    selectComponent: function (n) { selectComponent(n, true); },
    selectHole: function (n) { selectHole(n, true); },
    startTrackHole: startTrackHole,
    getExportText: function () { return state.analysis ? T.exportJSON(state.analysis) : ''; },
    locate: function (x, y) { return state.analysis ? T.locateAt(state.analysis, x, y) : null; },
    trackProbe: function () {
      return state.analysis && state.trackedProbe ? T.trackProbe(state.analysis, state.trackedProbe) : null;
    },
  };

  /* ---------------- 启动 ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    componentList = new VList('component-list', 'fg');
    holeList = new VList('hole-list', 'hole');
    bindEvents();
    // 自动尝试载入样例（http 下 fetch 原文件；file:// 下用内置同内容副本）
    loadSample().then(function () {
      fitCropView();
      drawOverview();
    });
  });
})();
