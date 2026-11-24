/* 页面应用层：导入校验、参数编辑、状态图渲染、像素检查、导出。 */
(function () {
  'use strict';

  var C = self.EchoCore;
  var $ = function (id) { return document.getElementById(id); };

  var STATUS_COLOR = {
    0: '--empty',
    1: '--s-unique1',
    2: '--s-unique2',
    3: '--s-multi',
    4: '--s-none',
  };
  var STATUS_NAME = {
    0: '无回波',
    1: '唯一单层',
    2: '唯一双层',
    3: '多组深度',
    4: '无解',
  };
  var STATUS_LONG = {
    0: '无回波：两路都没有正读数',
    1: '唯一深度组 · 单层',
    2: '唯一深度组 · 双层',
    3: '多组深度',
    4: '无解',
  };
  var ORDERED_STATUS = [1, 2, 3, 4, 0];

  var state = {
    doc: null,
    result: null,
    params: { offsets: [0, 0], maxDepth: 0 },
    selection: 0,
    view: 'state',
    requestId: 0,
    hover: -1,
    asyncJob: null,
  };

  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  function readTheme() {
    try {
      var t = localStorage.getItem('echo-depth-theme');
      return t === 'dark' || t === 'light' ? t : null;
    } catch (e) { return null; }
  }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(readTheme());
  $('themeBtn').addEventListener('click', function () {
    var root = document.documentElement;
    var isDark = root.getAttribute('data-theme') === 'dark' ||
      (!root.getAttribute('data-theme') && window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var next = isDark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('echo-depth-theme', next); } catch (e) {}
    if (state.result) { renderMap(); renderCounts(); renderInspector(); }
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () {
      if (!document.documentElement.getAttribute('data-theme') && state.result) {
        renderMap(); renderCounts(); renderInspector();
      }
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtMs(ms) {
    if (ms == null) return '—';
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function parseStrictInt(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!/^-?\d+$/.test(s)) return null;
    var n = Number(s);
    return isInt(n) ? n : null;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function download(bytes, filename, type) {
    var blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* 导入与校验                                                           */
  /* ------------------------------------------------------------------ */

  function setIoHint(msg, cls) {
    var n = $('ioHint');
    n.textContent = msg;
    n.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function setRecordPill(doc) {
    if (!doc) {
      $('recordPill').textContent = '尚无记录';
      return;
    }
    $('recordPill').textContent = doc.width + ' × ' + doc.height + ' · 周期 ' +
      doc.periods[0] + ' / ' + doc.periods[1];
  }

  function showErrors(invalid, keptDoc) {
    var card = $('errorCard');
    if (!invalid || !invalid.errors.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    var list = $('errorList');
    list.textContent = '';
    invalid.errors.forEach(function (err) {
      var li = el('li');
      var hasLoc = err.x !== null && err.x !== undefined;
      if (hasLoc) {
        var btn = el('button', null, err.message);
        btn.type = 'button';
        btn.title = '跳到该像素';
        btn.addEventListener('click', function () {
          if (keptDoc && err.x < keptDoc.width && err.y < keptDoc.height) {
            selectPixel(err.y * keptDoc.width + err.x, true);
          }
        });
        li.appendChild(btn);
      } else {
        li.textContent = err.message;
      }
      list.appendChild(li);
    });
    $('errCount').textContent = invalid.totalErrors > 1
      ? (invalid.errors.length + ' / ' + invalid.totalErrors + ' 条')
      : '1 条';
    $('keptNote').textContent = keptDoc
      ? '旧图已保留：' + keptDoc.width + ' × ' + keptDoc.height + '，周期 ' +
        keptDoc.periods[0] + ' / ' + keptDoc.periods[1] + '。修正记录后重新导入即可替换。'
      : '尚无可用记录；导入合法记录后才会显示状态图。';
  }

  function adoptDocument(doc) {
    state.doc = doc;
    state.result = null;
    state.params.offsets = [doc.offsets[0], doc.offsets[1]];
    state.params.maxDepth = doc.maxDepth;
    state.selection = clamp(state.selection, 0, doc.width * doc.height - 1);
    setRecordPill(doc);
    $('fSize').textContent = doc.width + ' × ' + doc.height;
    $('fPeriod').textContent = doc.periods[0] + ' / ' + doc.periods[1];
    $('fCount').textContent = fmt(doc.width * doc.height);
    $('fMax').textContent = doc.maxDepth;
    $('p0Label').textContent = doc.periods[0];
    $('p1Label').textContent = doc.periods[1];
    $('maxDepthHint').textContent = '0..' + (doc.periods[0] * doc.periods[1] - 1);
    $('maxDepth').value = doc.maxDepth;
    $('off0').value = doc.offsets[0];
    $('off1').value = doc.offsets[1];
    updateParamHints();
    recompute();
  }

  function importRaw(raw, fileName) {
    var v = C.validateDocument(raw);
    var kept = state.doc;
    if (!v.ok) {
      showErrors(v, kept);
      setIoHint('导入失败' + (fileName ? '（' + fileName + '）' : '') + '：' +
        v.totalErrors + ' 处非法记录。' + (kept ? '旧图保留。' : '尚无可用记录。'), 'err');
      return false;
    }
    showErrors(null, null);
    adoptDocument(v.doc);
    setIoHint('已载入 ' + (fileName || '记录') + '：' + v.doc.width + ' × ' + v.doc.height +
      '，' + fmt(v.doc.width * v.doc.height) + ' 像素，周期 ' +
      v.doc.periods[0] + ' / ' + v.doc.periods[1] + '。', 'ok');
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 参数                                                                */
  /* ------------------------------------------------------------------ */

  function updateParamHints() {
    if (!state.doc) return;
    var p0 = state.doc.periods[0], p1 = state.doc.periods[1];
    var o0 = parseStrictInt($('off0').value);
    var o1 = parseStrictInt($('off1').value);
    if (o0 !== null) {
      $('off0Mod').textContent = 'mod ' + p0 + ' = ' + C.mod(o0, p0);
      $('off0').classList.remove('bad');
    } else { $('off0Mod').textContent = '须为整数'; $('off0').classList.add('bad'); }
    if (o1 !== null) {
      $('off1Mod').textContent = 'mod ' + p1 + ' = ' + C.mod(o1, p1);
      $('off1').classList.remove('bad');
    } else { $('off1Mod').textContent = '须为整数'; $('off1').classList.add('bad'); }
    var md = parseStrictInt($('maxDepth').value);
    if (md !== null && md >= 0 && md < p0 * p1) {
      $('maxDepth').classList.remove('bad');
    } else {
      $('maxDepth').classList.add('bad');
    }
  }

  function readParams() {
    if (!state.doc) return null;
    var p0 = state.doc.periods[0], p1 = state.doc.periods[1];
    var o0 = parseStrictInt($('off0').value);
    var o1 = parseStrictInt($('off1').value);
    var md = parseStrictInt($('maxDepth').value);
    if (o0 === null || o1 === null || Math.abs(o0) > 1e6 || Math.abs(o1) > 1e6) {
      $('paramHint').textContent = '偏移须为绝对值不超过 1000000 的整数，已保留上一次结果。';
      $('paramHint').className = 'hint err';
      return null;
    }
    if (md === null || md < 0 || md >= p0 * p1) {
      $('paramHint').textContent = '深度上限须为 0..' + (p0 * p1 - 1) + ' 的整数，已保留上一次结果。';
      $('paramHint').className = 'hint err';
      return null;
    }
    return { offsets: [o0, o1], maxDepth: md };
  }

  var paramTimer = null;
  function applyParams(immediate) {
    var params = readParams();
    if (!params) return;
    $('paramHint').textContent = '偏移按非负余数折叠：' + C.mod(params.offsets[0], state.doc.periods[0]) +
      ' / ' + C.mod(params.offsets[1], state.doc.periods[1]) + '；深度上限 ' + params.maxDepth + '。';
    $('paramHint').className = 'hint';
    state.params = params;
    recompute();
  }

  function onParamInput() {
    updateParamHints();
    clearTimeout(paramTimer);
    paramTimer = setTimeout(function () { applyParams(); }, 200);
  }
  ['off0', 'off1', 'maxDepth'].forEach(function (id) {
    $(id).addEventListener('input', onParamInput);
    $(id).addEventListener('change', function () {
      clearTimeout(paramTimer);
      applyParams();
    });
  });
  $('resetParams').addEventListener('click', function () {
    if (!state.doc) return;
    $('maxDepth').value = state.doc.maxDepth;
    $('off0').value = state.doc.offsets[0];
    $('off1').value = state.doc.offsets[1];
    updateParamHints();
    state.params = { offsets: state.doc.offsets.slice(), maxDepth: state.doc.maxDepth };
    $('paramHint').textContent = '已恢复记录自带的偏移与上限。';
    $('paramHint').className = 'hint';
    recompute();
  });

  /* ------------------------------------------------------------------ */
  /* 求解调度                                                            */
  /* ------------------------------------------------------------------ */

  function recompute() {
    if (!state.doc) return;
    var doc = state.doc;
    var token = ++state.requestId;
    if (state.asyncJob) { state.asyncJob.cancel(); state.asyncJob = null; }
    var n = doc.width * doc.height;
    $('progress').hidden = false;
    $('progressBar').style.width = '0%';
    $('timing').textContent = '计算中…';
    $('timing').className = 'hint';
    if (!state.result) {
      mapCanvas.hidden = true;
      $('mapEmpty').hidden = false;
      $('mapEmpty').textContent = '计算中…';
    }

    function finish(res) {
      if (token !== state.requestId) return;
      state.result = res;
      $('progress').hidden = true;
      $('timing').textContent = '耗时 ' + fmtMs(res.elapsedMs) + ' · ' + fmt(n) + ' 像素';
      $('timing').className = 'hint';
      renderAll();
    }

    if (n > 16000) {
      state.asyncJob = C.solveAllAsync(doc, state.params, finish, function (frac) {
        if (token !== state.requestId) return;
        $('progressBar').style.width = Math.round(frac * 100) + '%';
      });
    } else {
      var res;
      try {
        res = C.solveAll(doc, state.params);
      } catch (e) {
        $('progress').hidden = true;
        $('timing').textContent = '求解失败：' + e.message;
        $('timing').className = 'hint err';
        return;
      }
      finish(res);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：解状态分布                                                     */
  /* ------------------------------------------------------------------ */

  function renderCounts() {
    var res = state.result;
    var counts = $('counts');
    var stack = $('stack');
    counts.textContent = '';
    stack.textContent = '';
    if (!res) return;
    var n = res.width * res.height;
    var map = {
      0: res.counts.empty, 1: res.counts.unique1, 2: res.counts.unique2,
      3: res.counts.multi, 4: res.counts.none,
    };
    ORDERED_STATUS.forEach(function (st) {
      var c = map[st];
      var pct = n ? (100 * c / n) : 0;
      var pctText = n ? (pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)) + '%' : '—';
      var li = el('li');
      li.setAttribute('aria-label', STATUS_NAME[st] + ' ' + fmt(c) + ' 像素，占 ' + pctText);
      var sw = el('span', 'sw');
      sw.style.background = cssVar(STATUS_COLOR[st]);
      li.appendChild(sw);
      li.appendChild(el('span', 'name', STATUS_NAME[st]));
      li.appendChild(el('span', 'num', fmt(c)));
      li.appendChild(el('span', 'pct', pctText));
      counts.appendChild(li);
      if (c > 0) {
        var seg = el('span');
        seg.style.flex = String(c);
        seg.style.background = cssVar(STATUS_COLOR[st]);
        seg.title = STATUS_NAME[st] + ' ' + fmt(c);
        stack.appendChild(seg);
      }
    });
    var total = el('li', 'total-row');
    total.appendChild(el('span', 'name', '合计'));
    total.appendChild(el('span', 'num', fmt(n) + ' 像素'));
    counts.appendChild(total);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：状态图                                                         */
  /* ------------------------------------------------------------------ */

  var mapCanvas = $('map');
  var mapWrap = $('mapWrap');
  var offscreen = document.createElement('canvas');
  var layout = { scale: 1 };
  var COLORS = {};
  var depthRange = { min: 0, max: 0, has: false };

  function refreshColors() {
    COLORS = {
      empty: cssVar('--empty'),
      s: {
        0: cssVar('--empty'), 1: cssVar('--s-unique1'), 2: cssVar('--s-unique2'),
        3: cssVar('--s-multi'), 4: cssVar('--s-none'),
      },
      ramp: [cssVar('--d100'), cssVar('--d200'), cssVar('--d300'), cssVar('--d400'),
        cssVar('--d500'), cssVar('--d600'), cssVar('--d700')],
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      ink3: cssVar('--ink-3'),
      surface: cssVar('--surface'),
      line: cssVar('--line'),
    };
  }

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mix(a, b, t) {
    var A = hexToRgb(a), B = hexToRgb(b);
    return [Math.round(A[0] + (B[0] - A[0]) * t), Math.round(A[1] + (B[1] - A[1]) * t), Math.round(A[2] + (B[2] - A[2]) * t)];
  }
  function rampColor(t) {
    t = clamp(t, 0, 1);
    var colors = COLORS.ramp;
    var x = t * (colors.length - 1);
    var i = Math.min(colors.length - 2, Math.floor(x));
    return mix(colors[i], colors[i + 1], x - i);
  }

  function computeLayout() {
    var res = state.result;
    if (!res) return;
    var availW = Math.max(160, mapWrap.clientWidth - 28);
    var availH = Math.max(180, Math.min(640, window.innerHeight - 240));
    var scale;
    if (res.width <= 24 && res.height <= 24) {
      scale = clamp(Math.floor(Math.min(availW / res.width, availH / res.height)), 6, 32);
    } else {
      scale = clamp(Math.floor(Math.min(availW / res.width, availH / res.height)), 1, 12);
    }
    layout.scale = scale;
    $('mapZoom').textContent = scale === 1 ? '1 px = 1 px' : '1 px = ' + scale + ' px';
  }

  function paintStatusView(img, res) {
    var n = res.width * res.height;
    var data = img.data;
    var rgb = {};
    for (var k = 0; k < 5; k++) rgb[k] = hexToRgb(COLORS.s[k]);
    for (var i = 0; i < n; i++) {
      var c = rgb[res.status[i]];
      var o = i * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }

  function paintDepthView(img, res, layer) {
    var n = res.width * res.height;
    var data = img.data;
    var layerArr = layer === 0 ? res.layer0 : res.layer1;
    var empty = hexToRgb(COLORS.empty);
    var minVal = Infinity, maxVal = -Infinity;
    for (var i = 0; i < n; i++) {
      if (layerArr[i] > 0) {
        var v = layerArr[i] - 1;
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }
    var has = minVal <= maxVal;
    if (!has) { minVal = 0; maxVal = 0; }
    var span = Math.max(1, maxVal - minVal);
    var cache = {};
    for (var j = 0; j < n; j++) {
      var raw = layerArr[j];
      var o = j * 4;
      if (raw === 0) {
        data[o] = empty[0]; data[o + 1] = empty[1]; data[o + 2] = empty[2]; data[o + 3] = 255;
      } else {
        var val = raw - 1;
        var col = cache[val];
        if (!col) { col = rampColor((val - minVal) / span); cache[val] = col; }
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
      }
    }
    depthRange = { min: minVal, max: maxVal, has: has };
  }

  function drawSelection(ctx, dpr) {
    var res = state.result;
    if (!res) return;
    var idx = state.selection;
    if (idx < 0 || idx >= res.width * res.height) return;
    var x = idx % res.width, y = (idx / res.width) | 0;
    var s = layout.scale;
    var px = x * s, py = y * s;
    ctx.save();
    ctx.strokeStyle = COLORS.surface;
    ctx.lineWidth = 3;
    ctx.strokeRect(px - 1.5, py - 1.5, s + 3, s + 3);
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px - 2, py - 2, s + 4, s + 4);
    ctx.restore();
  }

  function drawGrid(ctx) {
    var res = state.result;
    if (!res || layout.scale < 7) return;
    ctx.save();
    ctx.strokeStyle = COLORS.line;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    var w = res.width * layout.scale, h = res.height * layout.scale;
    ctx.beginPath();
    for (var x = 1; x < res.width; x++) {
      var px = Math.round(x * layout.scale) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (var y = 1; y < res.height; y++) {
      var py = Math.round(y * layout.scale) + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  function renderLegend() {
    var legend = $('legend');
    var scale = $('depthScale');
    legend.textContent = '';
    if (state.view === 'state') {
      scale.hidden = true;
      ORDERED_STATUS.forEach(function (st) {
        var li = el('li');
        var sw = el('span', 'sw');
        sw.style.background = cssVar(STATUS_COLOR[st]);
        li.appendChild(sw);
        li.appendChild(document.createTextNode(STATUS_NAME[st]));
        legend.appendChild(li);
      });
    } else {
      scale.hidden = false;
      var li = el('li');
      var sw = el('span', 'sw');
      sw.style.background = cssVar('--empty');
      li.appendChild(sw);
      li.appendChild(document.createTextNode('不导出（0）'));
      legend.appendChild(li);
      var li2 = el('li');
      var sw2 = el('span', 'sw');
      sw2.style.background = cssVar(state.view === 'layer0' ? '--d400' : '--d500');
      li2.appendChild(sw2);
      li2.appendChild(document.createTextNode('唯一深度组'));
      legend.appendChild(li2);
      $('depthRange').textContent = depthRange.has
        ? (depthRange.min + ' – ' + depthRange.max) : '无唯一像素';
    }
  }

  function renderMap() {
    var res = state.result;
    refreshColors();
    if (!res) {
      mapCanvas.hidden = true;
      $('mapEmpty').hidden = false;
      if (!state.doc) $('mapEmpty').textContent = '没有可显示的记录。';
      return;
    }
    $('mapEmpty').hidden = true;
    mapCanvas.hidden = false;
    computeLayout();

    var dpr = window.devicePixelRatio || 1;
    var w = res.width, h = res.height;
    offscreen.width = w;
    offscreen.height = h;
    var octx = offscreen.getContext('2d');
    var img = octx.createImageData(w, h);
    if (state.view === 'state') paintStatusView(img, res);
    else paintDepthView(img, res, state.view === 'layer0' ? 0 : 1);
    octx.putImageData(img, 0, 0);

    var cssW = w * layout.scale, cssH = h * layout.scale;
    mapCanvas.width = Math.round(cssW * dpr);
    mapCanvas.height = Math.round(cssH * dpr);
    mapCanvas.style.width = cssW + 'px';
    mapCanvas.style.height = cssH + 'px';
    var ctx = mapCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(offscreen, 0, 0, cssW, cssH);
    drawGrid(ctx);
    drawSelection(ctx, dpr);
    renderLegend();
    $('mapHelp').textContent = state.view === 'state'
      ? '颜色表示每个像素的最少回波解：点击查看两路槽读数与全部深度组。方向键移动。'
      : '颜色表示唯一深度组的深度（深色更远）；灰色为不导出的像素。点击查看详情。';
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function pixelFromEvent(ev) {
    var res = state.result;
    if (!res) return -1;
    var rect = mapCanvas.getBoundingClientRect();
    var x = Math.floor((ev.clientX - rect.left) / layout.scale);
    var y = Math.floor((ev.clientY - rect.top) / layout.scale);
    if (x < 0 || y < 0 || x >= res.width || y >= res.height) return -1;
    return y * res.width + x;
  }

  function hoverTip(idx) {
    var tip = $('tip');
    if (idx < 0) {
      tip.hidden = true;
      $('mapCursor').textContent = '—';
      state.hover = -1;
      return;
    }
    var res = state.result;
    var x = idx % res.width, y = (idx / res.width) | 0;
    state.hover = idx;
    $('mapCursor').textContent = '(' + x + ', ' + y + ')';
    var st = res.status[idx];
    var text = '(' + x + ', ' + y + ') · ' + STATUS_NAME[st];
    if (st === 1) text += ' · 深度 ' + (res.layer0[idx] - 1);
    else if (st === 2) text += ' · 深度 ' + (res.layer0[idx] - 1) + ' / ' + (res.layer1[idx] - 1);
    tip.textContent = '';
    var sw = el('span', 'st');
    sw.style.background = cssVar(STATUS_COLOR[st]);
    tip.appendChild(sw);
    tip.appendChild(document.createTextNode(text));
    tip.hidden = false;

    var wrapRect = mapWrap.getBoundingClientRect();
    var cRect = mapCanvas.getBoundingClientRect();
    var left = cRect.left - wrapRect.left + mapWrap.scrollLeft + x * layout.scale + 14;
    var top = cRect.top - wrapRect.top + mapWrap.scrollTop + y * layout.scale + 14;
    var tipW = tip.offsetWidth, tipH = tip.offsetHeight;
    if (left + tipW > mapWrap.scrollLeft + mapWrap.clientWidth - 4) left = left - tipW - 32;
    if (top + tipH > mapWrap.scrollTop + mapWrap.clientHeight - 4) top = top - tipH - 32;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  }

  function selectPixel(idx, scroll) {
    var res = state.result;
    if (!res || idx < 0 || idx >= res.width * res.height) return;
    state.selection = idx;
    renderMap();
    renderInspector();
    if (scroll) {
      var cRect = mapCanvas.getBoundingClientRect();
      var wRect = mapWrap.getBoundingClientRect();
      var x = idx % res.width, y = (idx / res.width) | 0;
      var top = cRect.top - wRect.top + y * layout.scale;
      var left = cRect.left - wRect.left + x * layout.scale;
      if (top < 0 || top + layout.scale > mapWrap.clientHeight) {
        mapWrap.scrollTop += top - mapWrap.clientHeight / 2;
      }
      if (left < 0 || left + layout.scale > mapWrap.clientWidth) {
        mapWrap.scrollLeft += left - mapWrap.clientWidth / 2;
      }
    }
  }

  mapCanvas.addEventListener('pointermove', function (ev) { hoverTip(pixelFromEvent(ev)); });
  mapCanvas.addEventListener('pointerleave', function () { hoverTip(-1); });
  mapCanvas.addEventListener('pointerdown', function (ev) {
    var idx = pixelFromEvent(ev);
    if (idx >= 0) { mapCanvas.focus(); selectPixel(idx, false); }
  });
  mapCanvas.addEventListener('keydown', function (ev) {
    var res = state.result;
    if (!res) return;
    var idx = state.selection;
    var x = idx % res.width, y = (idx / res.width) | 0;
    var moved = true;
    if (ev.key === 'ArrowLeft') x = Math.max(0, x - 1);
    else if (ev.key === 'ArrowRight') x = Math.min(res.width - 1, x + 1);
    else if (ev.key === 'ArrowUp') y = Math.max(0, y - 1);
    else if (ev.key === 'ArrowDown') y = Math.min(res.height - 1, y + 1);
    else if (ev.key === 'Home') { x = 0; y = 0; }
    else if (ev.key === 'End') { x = res.width - 1; y = res.height - 1; }
    else moved = false;
    if (moved) {
      ev.preventDefault();
      selectPixel(y * res.width + x, true);
    }
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.result) { renderMap(); renderInspector(); }
    }, 120);
  });

  /* ------------------------------------------------------------------ */
  /* 渲染：检查器                                                         */
  /* ------------------------------------------------------------------ */

  function readingText(v) {
    if (v === null) return 'null · 不约束';
    if (v === 0) return '0 · 槽和须为 0';
    if (v === 255) return '255 · 至少 255';
    return '精确 ' + v;
  }

  function laneTable(lane) {
    var tbl = el('table', 'slots');
    var thead = el('thead');
    var hr = el('tr');
    ['槽', '读数', '约束'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tbody = el('tbody');
    var sorted = lane.slice().sort(function (a, b) { return a[0] - b[0]; });
    sorted.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'hit', String(row[0])));
      tr.appendChild(el('td', null, row[1] === null ? 'null' : String(row[1])));
      tr.appendChild(el('td', row[1] === null || row[1] === 0 ? 'none' : null, readingText(row[1])));
      tbody.appendChild(tr);
    });
    if (!sorted.length) {
      var tr = el('tr');
      tr.appendChild(el('td', 'none', '—'));
      tr.appendChild(el('td', 'none', '—'));
      tr.appendChild(el('td', 'none', '未列槽（全部恰为 0）'));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  function drawSpectrum(canvas, lane, p, usedSlots) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = Math.max(180, canvas.clientWidth || 300);
    var cssH = 100;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    cssW = canvas.width / dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var values = new Map();
    lane.forEach(function (row) { values.set(row[0], row[1]); });
    var padL = 2, padR = 2, padT = 16, padB = 18;
    var innerW = cssW - padL - padR;
    var innerH = cssH - padT - padB;
    var step = innerW / p;
    var barW = Math.max(1, Math.min(24, step - (step > 6 ? 2 : 0.5)));
    var ink = cssVar('--ink');
    var ink2 = cssVar('--ink-2');
    var ink3 = cssVar('--ink-3');
    var line = cssVar('--line');

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + innerH + 0.5);
    ctx.lineTo(cssW - padR, padT + innerH + 0.5);
    ctx.stroke();

    var showLabels = p <= 16;
    var usedAccent = cssVar('--s-unique1');
    for (var s = 0; s < p; s++) {
      var cx = padL + s * step + step / 2;
      var listed = values.has(s);
      var v = listed ? values.get(s) : null;
      var isUsed = usedSlots.indexOf(s) >= 0;
      if (isUsed) {
        // 命中槽：基线色带，不假装成幅度柱
        ctx.fillStyle = usedAccent;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(padL + s * step + (step > 6 ? 1 : 0), padT + innerH + 2, Math.max(2, step - (step > 6 ? 2 : 0)), 3);
        ctx.globalAlpha = 1;
      }
      var barH = 0;
      if (listed && v !== null) barH = Math.max(4, (Math.min(v, 255) / 255) * innerH);
      else if (listed && v === null) barH = Math.max(3, innerH * 0.12);
      if (barH > 0) {
        ctx.fillStyle = listed && v === null ? ink3 : ink2;
        ctx.globalAlpha = listed && v === null ? 0.55 : 0.85;
        var bx = cx - barW / 2;
        var by = padT + innerH - barH;
        var r = Math.min(2, barW / 2);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, barW, barH, [r, r, 0, 0]);
        else ctx.rect(bx, by, barW, barH);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (listed && v === 255) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - barW / 2 - 1, padT + innerH - barH - 3);
        ctx.lineTo(cx + barW / 2 + 1, padT + innerH - barH - 3);
        ctx.stroke();
      }
      if (showLabels) {
        ctx.fillStyle = isUsed ? usedAccent : ink3;
        ctx.font = (isUsed ? '600 ' : '') + '9.5px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(s), cx, cssH - 5);
        if (listed) {
          ctx.fillStyle = ink2;
          ctx.font = '9.5px ui-monospace, SFMono-Regular, monospace';
          var label = v === null ? 'null' : String(v);
          var ly = Math.max(9, padT + innerH - barH - 5);
          if (barH > innerH - 14) { ctx.fillStyle = 'rgba(255,255,255,.94)'; ly = padT + 10; }
          ctx.fillText(label, cx, ly);
        }
      }
    }
    if (!showLabels) {
      ctx.fillStyle = ink3;
      ctx.font = '9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('槽 0', padL, cssH - 5);
      ctx.textAlign = 'right';
      ctx.fillText('槽 ' + (p - 1), cssW - padR, cssH - 5);
    }
  }

  function buildLaneBlock(lane, p, laneIndex, usedSlots) {
    var block = el('div', 'lane-block');
    var hd = el('div', 'lane-hd');
    hd.appendChild(el('span', 'lane-name', '第 ' + (laneIndex + 1) + ' 路'));
    var offset = state.params.offsets[laneIndex];
    var reduced = C.mod(offset, p);
    hd.appendChild(el('span', 'lane-meta',
      '周期 ' + p + ' · 偏移 ' + offset + (offset === reduced ? '' : ' ≡ ' + reduced)));
    block.appendChild(hd);

    var canvas = document.createElement('canvas');
    canvas.className = 'spectrum';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '第 ' + (laneIndex + 1) + ' 路槽读数分布');
    block.appendChild(canvas);
    block.appendChild(laneTable(lane));
    block._canvas = canvas;

    var unlisted = p - lane.length;
    block.appendChild(el('div', 'hint', unlisted > 0
      ? '另有 ' + unlisted + ' 个槽未列出，槽和恰为 0；高亮为当前解所用槽。'
      : '全部 ' + p + ' 个槽都已列出；高亮为当前解所用槽。'));
    return block;
  }

  function rangeText(lo, hi) {
    return lo === hi ? String(lo) : lo + ' – ' + hi;
  }

  function renderInspector() {
    var res = state.result;
    var doc = state.doc;
    var content = $('inspContent');
    var empty = $('inspEmpty');
    if (!res || !doc) {
      content.hidden = true;
      empty.hidden = false;
      $('pixCoord').textContent = '像素 —';
      $('pixSub').textContent = '等待记录';
      $('pixStatusText').textContent = '—';
      $('pixStatus').querySelector('.dot').style.background = cssVar('--empty');
      return;
    }
    var idx = state.selection;
    var x = idx % res.width, y = (idx / res.width) | 0;
    var detail = C.solvePixelDetail(doc, idx, state.params);
    var summary = C.layerSummary(detail);

    $('pixCoord').textContent = '像素 (' + x + ', ' + y + ')';
    $('pixSub').textContent = 'index ' + idx + ' · 第 ' + (idx + 1) + ' / ' + (res.width * res.height) + ' 个';
    var stKey = detail.kind === 'empty' ? 0 : detail.kind === 'none' ? 4 :
      (detail.groupCount === 1 ? (detail.minEchoes === 1 ? 1 : 2) : 3);
    $('pixStatusText').textContent = STATUS_LONG[stKey];
    $('pixStatus').querySelector('.dot').style.background = cssVar(STATUS_COLOR[stKey]);

    content.hidden = false;
    empty.hidden = true;
    content.textContent = '';

    var usedSlots = [[], []];
    detail.groups.forEach(function (g) {
      g.depths.forEach(function (d) {
        var s0 = C.mod(d + state.params.offsets[0], doc.periods[0]);
        var s1 = C.mod(d + state.params.offsets[1], doc.periods[1]);
        if (usedSlots[0].indexOf(s0) < 0) usedSlots[0].push(s0);
        if (usedSlots[1].indexOf(s1) < 0) usedSlots[1].push(s1);
      });
    });

    var laneBlocks = [];
    for (var li = 0; li < 2; li++) {
      var blk = buildLaneBlock(detail.lanes[li] || [], doc.periods[li], li, usedSlots[li]);
      content.appendChild(blk);
      laneBlocks.push(blk);
    }

    var solve = el('div', 'solve-block');
    var sh = el('div', 'solve-hd');
    sh.appendChild(el('h3', null, '求解'));
    sh.appendChild(el('span', 'sub',
      '上限 ' + state.params.maxDepth + ' · 候选深度 ' + detail.candDepths.length));
    solve.appendChild(sh);

    if (detail.kind === 'empty') {
      var lineE = el('div', 'solve-line');
      lineE.appendChild(document.createTextNode('两路都没有正读数，'));
      lineE.appendChild(el('strong', null, '无回波'));
      lineE.appendChild(document.createTextNode('。最少 0 个，也是最少的可能。'));
      solve.appendChild(lineE);
      solve.appendChild(el('div', 'hint', 'null 与 0 都不产生回波；导出两层都写 0。'));
    } else if (detail.kind === 'none') {
      var lineN = el('div', 'solve-line');
      lineN.appendChild(document.createTextNode('在 0..' + state.params.maxDepth + ' 内，'));
      lineN.appendChild(el('strong', null, '找不到'));
      lineN.appendChild(document.createTextNode('满足两路槽读数的 1 或 2 个回波组合。'));
      solve.appendChild(lineN);
      solve.appendChild(el('div', 'hint',
        '检查：正读数所在的槽能否由某个不超过上限的深度同时命中两路；所需的幅度和是否落在 1..1023；未列槽是否被迫为 0。'));
      if (detail.candDepths.length) {
        var candLine = el('div', 'export-line');
        candLine.appendChild(document.createTextNode('本像素的候选深度（两路余数可同时满足，≤ 上限）：'));
        candLine.appendChild(el('b', null, detail.candDepths.slice(0, 24).join(', ') +
          (detail.candDepths.length > 24 ? ' …' : '')));
        solve.appendChild(candLine);
      }
    } else {
      var k = detail.minEchoes;
      var lineK = el('div', 'solve-line');
      lineK.appendChild(document.createTextNode('最少需要 '));
      lineK.appendChild(el('strong', null, k + ' 个回波'));
      lineK.appendChild(document.createTextNode('，共 '));
      lineK.appendChild(el('strong', null, detail.groupCount + ' 组'));
      lineK.appendChild(document.createTextNode(
        detail.groupCount === 1 ? '可行深度组（唯一，可导出）' : '可行深度组（多组，不导出）'));
      solve.appendChild(lineK);

      var layerTable = el('table', 'layers');
      var thead = el('thead');
      var hr = el('tr');
      ['层', '深度上下界', '幅度上下界'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
      thead.appendChild(hr);
      layerTable.appendChild(thead);
      var tbody = el('tbody');
      summary.layers.forEach(function (L, i) {
        var tr = el('tr');
        var td0 = el('td');
        var tag = el('span', 'layer-tag');
        var sw = el('i');
        sw.style.background = cssVar(i === 0 ? '--d400' : '--d600');
        tag.appendChild(sw);
        tag.appendChild(document.createTextNode('第 ' + (i + 1) + ' 层'));
        td0.appendChild(tag);
        tr.appendChild(td0);
        tr.appendChild(el('td', null, rangeText(L.dLo, L.dHi)));
        tr.appendChild(el('td', null, rangeText(L.aLo, L.aHi)));
        tbody.appendChild(tr);
      });
      layerTable.appendChild(tbody);
      solve.appendChild(layerTable);

      var gw = el('div', 'groups-wrap');
      var gs = el('div', 'groups-scroll');
      var gt = el('table', 'groups');
      var gthead = el('thead');
      var ghr = el('tr');
      if (k === 1) ['#', '深度', '幅度'].forEach(function (t) { ghr.appendChild(el('th', null, t)); });
      else ['#', '层 1 深度', '层 2 深度', '层 1 幅度', '层 2 幅度'].forEach(function (t) { ghr.appendChild(el('th', null, t)); });
      gthead.appendChild(ghr);
      gt.appendChild(gthead);
      var gbody = el('tbody');
      var LIMIT = 300;
      var shown = Math.min(detail.groups.length, LIMIT);
      for (var gi = 0; gi < shown; gi++) {
        var g = detail.groups[gi];
        var tr2 = el('tr');
        tr2.appendChild(el('td', 'dim', String(gi + 1)));
        if (k === 1) {
          tr2.appendChild(el('td', null, String(g.depths[0])));
          tr2.appendChild(el('td', null, rangeText(g.amps[0][0], g.amps[0][1])));
        } else {
          tr2.appendChild(el('td', null, String(g.depths[0])));
          tr2.appendChild(el('td', null, String(g.depths[1])));
          tr2.appendChild(el('td', null, rangeText(g.amps[0][0], g.amps[0][1])));
          tr2.appendChild(el('td', null, rangeText(g.amps[1][0], g.amps[1][1])));
        }
        gbody.appendChild(tr2);
      }
      gt.appendChild(gbody);
      gs.appendChild(gt);
      gw.appendChild(gs);
      if (detail.groups.length > shown) {
        gw.appendChild(el('div', 'groups-foot',
          '另有 ' + (detail.groups.length - shown) + ' 组未列出（共 ' + detail.groups.length + ' 组）。'));
      } else {
        gw.appendChild(el('div', 'groups-foot', '共 ' + detail.groups.length + ' 组深度可行解。'));
      }
      solve.appendChild(gw);

      var expLine = el('div', 'export-line');
      var e0 = stKey === 1 || stKey === 2 ? detail.groups[0].depths[0] + 1 : 0;
      var e1 = stKey === 2 ? detail.groups[0].depths[1] + 1 : 0;
      expLine.appendChild(document.createTextNode('本像素导出：层 1 = '));
      expLine.appendChild(el('b', null, String(e0)));
      expLine.appendChild(document.createTextNode('，层 2 = '));
      expLine.appendChild(el('b', null, String(e1)));
      expLine.appendChild(document.createTextNode(stKey === 3 ? '（多组深度，均写 0）' : ''));
      solve.appendChild(expLine);
    }
    content.appendChild(solve);

    requestAnimationFrame(function () {
      laneBlocks.forEach(function (blk, i) {
        drawSpectrum(blk._canvas, detail.lanes[i] || [], doc.periods[i], usedSlots[i]);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 汇总渲染与导出说明                                                   */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    renderMap();
    renderCounts();
    renderInspector();
    renderExportNote();
  }

  function renderExportNote() {
    var res = state.result;
    var note = $('exportNote');
    if (!res) { note.textContent = '尚无可导出的结果。'; return; }
    note.textContent = '';
    note.appendChild(document.createTextNode(
      '16 位 P5（最大值 65535）：仅深度组唯一时写深度 + 1；无回波、多组深度、无解与缺层写 0。当前层 1 可写 '));
    note.appendChild(el('b', null, fmt(res.counts.unique1 + res.counts.unique2)));
    note.appendChild(document.createTextNode(' 像素，层 2 可写 '));
    note.appendChild(el('b', null, fmt(res.counts.unique2)));
    note.appendChild(document.createTextNode(' 像素。'));
  }

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  $('exportL0').addEventListener('click', function () {
    if (!state.result) return;
    var pgm = C.encodePGM16(state.result.width, state.result.height, state.result.layer0);
    download(pgm, 'echo-depth-layer1.pgm', 'image/x-portable-graymap');
  });
  $('exportL1').addEventListener('click', function () {
    if (!state.result) return;
    var pgm = C.encodePGM16(state.result.width, state.result.height, state.result.layer1);
    download(pgm, 'echo-depth-layer2.pgm', 'image/x-portable-graymap');
  });
  $('exportJson').addEventListener('click', function () {
    var res = state.result;
    if (!res) return;
    var width = res.width, height = res.height;
    var rows = [];
    for (var y = 0; y < height; y++) {
      var s = '';
      for (var x = 0; x < width; x++) s += String(res.status[y * width + x]);
      rows.push(s);
    }
    var payload = {
      width: width, height: height,
      periods: res.periods,
      offsets: res.offsets,
      maxDepth: res.maxDepth,
      elapsedMs: Math.round(res.elapsedMs),
      counts: res.counts,
      statusLegend: {
        '0': '无回波',
        '1': '唯一深度组（1 个回波）',
        '2': '唯一深度组（2 个回波）',
        '3': '多组深度',
        '4': '无解',
      },
      statusRows: rows,
      layer1: Array.prototype.slice.call(res.layer0),
      layer2: Array.prototype.slice.call(res.layer1),
      exportRule: 'layer = depth + 1 when the depth group is unique; 0 otherwise (including a missing layer)',
    };
    download(JSON.stringify(payload, null, 2), 'echo-depth-status.json', 'application/json');
  });

  /* ------------------------------------------------------------------ */
  /* 视图切换                                                            */
  /* ------------------------------------------------------------------ */

  function tabId(v) { return v === 'state' ? 'viewState' : v === 'layer0' ? 'viewLayer0' : 'viewLayer1'; }

  function setView(view) {
    state.view = view;
    ['state', 'layer0', 'layer1'].forEach(function (v) {
      var btn = $(tabId(v));
      var on = v === view;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.setAttribute('tabindex', on ? '0' : '-1');
    });
    renderMap();
  }
  $('viewState').addEventListener('click', function () { setView('state'); });
  $('viewLayer0').addEventListener('click', function () { setView('layer0'); });
  $('viewLayer1').addEventListener('click', function () { setView('layer1'); });
  document.querySelector('.seg').addEventListener('keydown', function (ev) {
    var order = ['state', 'layer0', 'layer1'];
    var i = order.indexOf(state.view);
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
      i = (i + 1) % 3; setView(order[i]); $(tabId(order[i])).focus(); ev.preventDefault();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
      i = (i + 2) % 3; setView(order[i]); $(tabId(order[i])).focus(); ev.preventDefault();
    } else if (ev.key === 'Home') {
      setView('state'); $('viewState').focus(); ev.preventDefault();
    } else if (ev.key === 'End') {
      setView('layer1'); $('viewLayer1').focus(); ev.preventDefault();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 导入交互                                                            */
  /* ------------------------------------------------------------------ */

  var drop = $('drop');
  var fileInput = $('fileInput');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (f) readFile(f);
    fileInput.value = '';
  });

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try {
        raw = JSON.parse(reader.result);
      } catch (err) {
        showErrors({
          errors: [{ x: null, y: null, message: '文件不是合法的 JSON：' + err.message }],
          totalErrors: 1,
        }, state.doc);
        setIoHint('导入失败（' + file.name + '）：不是合法 JSON。' + (state.doc ? '旧图保留。' : ''), 'err');
        return;
      }
      importRaw(raw, file.name);
    };
    reader.onerror = function () {
      setIoHint('读取文件失败：' + file.name, 'err');
    };
    reader.readAsText(file);
  }

  $('loadSample').addEventListener('click', function () {
    if (!self.EchoSample) {
      setIoHint('内嵌样例缺失（src/sample-data.js）。', 'err');
      return;
    }
    importRaw(JSON.parse(JSON.stringify(self.EchoSample)), '内置样例');
  });

  /* 满额图：256×256，周期 31 / 37，上限 1146；单点/两点交错，两点一半在同一路同槽。 */
  function generateFullFigure() {
    var p0 = 31, p1 = 37, maxDepth = 1146, W = 256, H = 256;
    var seed = 20261125 >>> 0;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
    var pixels = new Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var echoes;
        if (((x + y) & 1) === 1) {
          var d1 = ri(0, maxDepth - 1);
          var d2;
          if ((x % 4) < 2) {
            // 两路之一同槽：让 (d2 - d1) 为 p0 的倍数
            var k = ri(1, Math.max(1, Math.floor((maxDepth - d1) / p0)));
            d2 = d1 + k * p0;
            if (d2 > maxDepth || d2 === d1) {
              d2 = d1 + p0;
              if (d2 > maxDepth) d2 = d1 - p0 >= 0 ? d1 - p0 : (d1 + 1) % (maxDepth + 1);
            }
          } else {
            d2 = ri(0, maxDepth);
            if (d2 === d1) d2 = (d1 + 1) % (maxDepth + 1);
          }
          echoes = [[d1, ri(1, 1023)], [d2, ri(1, 1023)]];
        } else {
          echoes = [[ri(0, maxDepth), ri(1, 1023)]];
        }
        var lanes = [];
        for (var L = 0; L < 2; L++) {
          var p = L === 0 ? p0 : p1;
          var bins = {};
          for (var e = 0; e < echoes.length; e++) {
            var slot = echoes[e][0] % p;
            bins[slot] = (bins[slot] || 0) + echoes[e][1];
          }
          var slots = Object.keys(bins).map(Number).sort(function (a, b) { return a - b; });
          var lane = [];
          for (var q = 0; q < slots.length; q++) {
            lane.push([slots[q], Math.min(bins[slots[q]], 255)]);
          }
          lanes.push(lane);
        }
        pixels[y * W + x] = lanes;
      }
    }
    return { width: W, height: H, periods: [p0, p1], offsets: [0, 0], maxDepth: maxDepth, pixels: pixels };
  }
  $('loadBig').addEventListener('click', function () {
    var t0 = performance.now();
    var raw = generateFullFigure();
    var genMs = performance.now() - t0;
    if (importRaw(raw, '满额压测图')) {
      setIoHint('已生成 256 × 256 满额图（周期 31 / 37，上限 1146），生成耗时 ' +
        Math.round(genMs) + ' ms。', 'ok');
    }
  });

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    refreshColors();
    if (self.EchoSample) {
      importRaw(JSON.parse(JSON.stringify(self.EchoSample)), '内置样例');
      setIoHint('已载入内置样例（12 × 10，周期 5 / 7，上限 34）。可导入自己的记录或点“满额图压测”。', 'ok');
    } else {
      setRecordPill(null);
      $('mapEmpty').hidden = false;
      $('mapEmpty').textContent = '没有可显示的记录。';
      $('inspEmpty').hidden = false;
      $('pixCoord').textContent = '像素 —';
      $('pixSub').textContent = '等待记录';
    }
  }

  boot();
})();
