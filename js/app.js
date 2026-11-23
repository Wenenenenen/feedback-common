/*
 * app.js — 法线高度恢复台主逻辑。
 * 求解在 Blob Worker 中执行；Worker 不可用时回退主线程（带冻结提示）。
 * 所有计算请求带单调 seq，旧 Worker 直接 terminate，结果永不覆盖新请求。
 */
'use strict';

(function () {
  var NR = window.NormalRelief;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 默认样例（与 samples/normal-relief.json 一致） ---------------- */
  var DEFAULT_INPUT = {
    width: 3, height: 2, spacing: [1, 1.5], wrap: [false, false],
    samples: [
      [-0.3, 0.2, 1, 4], [-0.3, 0.2, 1, 4], [-0.3, 0.2, 1, 4],
      [-0.3, 0.2, 1, 4], [-0.3, 0.2, 1, 4], [-0.3, 0.2, 1, 4]
    ],
    pins: [[0, 0]]
  };

  /* ---------------- 应用状态 ---------------- */
  var state = {
    input: clone(DEFAULT_INPUT),       // 当前编辑中的输入
    result: null,                      // 最近一次有效结果
    view: 'height',                    // height | resH | resV
    addPinMode: false,
    hoverCell: -1,
    seq: 0,
    busy: false,
    error: null,                       // { title, errors[], keepOld }
    edgeOfCell: null,                  // Int32Array(n)：该格向右/下边的首条边索引
    edgeOfCellCount: null,             // Uint8Array(n)：该格发出的边数
    theme: null
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- Worker 引导 ----------------
   * solver-core.js / worker-body.js 已由 <script> 载入（file:// 下经典脚本可加载）。
   * Blob 源码从已解析的函数对象 toString 得到，无需 XHR，绕开 file:// CORS。 */
  var worker = null;
  var workerFailed = false;
  var workerTried = false;

  function spawnWorker() {
    if (worker) return worker;
    if (workerFailed || workerTried) return null;
    workerTried = true;
    try {
      // solver-core.js 的 UMD 把工厂挂在 window.NormalRelief；
      // Blob 内重建同构 UMD，工厂源码由 NR.__factory__ 提供（文件尾部注入）。
      var src = [
        "'use strict';",
        'var __NR_factory = ' + NR.__factory__.toString() + ';',
        '(function (root, factory) {',
        '  root.NormalRelief = factory();',
        '})(typeof self !== "undefined" ? self : this, __NR_factory);',
        'var __workerBody = ' + window.NR_WORKER_BODY.toString() + ';',
        '__workerBody(typeof self !== "undefined" ? self : this);'
      ].join('\n');
      var blob = new Blob([src], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      var w = new Worker(url);
      w.onmessage = onWorkerMessage;
      w.onerror = function () {
        workerFailed = true;
        try { w.terminate(); } catch (e) {}
        if (worker === w) worker = null;
        // 若有请求在途，改走主线程补算（结果仍受 seq 保护）
        if (state.busy) runOnMainThread();
      };
      worker = w;
      return w;
    } catch (e) {
      workerFailed = true;
      worker = null;
      return null;
    }
  }

  /* ---------------- 求解调度 ---------------- */
  var rerunTimer = null;
  function scheduleRerun(delay) {
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(runSolve, delay == null ? 120 : delay);
  }

  function runSolve() {
    var mySeq = ++state.seq;
    setBusy(true);
    var warm = state.result ? state.result.heights : null;
    var w = worker || spawnWorker();

    // 主线程先做一次校验：非法输入立即标错并保留旧结果，不发请求
    var v = NR.validateInput(state.input);
    if (!v.ok) {
      state.seq = mySeq; // 占用序号，任何在途旧结果都将过期
      state.error = { title: '输入不合法，已保留当前结果', errors: v.errors, keepOld: !!state.result };
      setBusy(false);
      renderError();
      return;
    }
    state.error = null;
    renderError();

    if (!w) {
      // 回退：主线程同步求解（seq 与取消令牌保证旧计算不覆盖新请求）
      runOnMainThread(mySeq, warm);
      return;
    }
    try {
      w.postMessage({ type: 'solve', seq: mySeq, input: clone(state.input), warm: warm });
    } catch (e) {
      workerFailed = true;
      try { w.terminate(); } catch (err) {}
      worker = null;
      runOnMainThread(mySeq, warm);
    }
  }

  function runOnMainThread(expectedSeq, warmIn) {
    var mySeq = expectedSeq != null ? expectedSeq : ++state.seq;
    setBusy(true);
    setTimeout(function () {
      // 给 UI 一帧刷新“计算中”
      var v = NR.validateInput(state.input);
      if (!v.ok) {
        state.error = { title: '输入不合法，已保留当前结果', errors: v.errors, keepOld: !!state.result };
        setBusy(false);
        renderError();
        return;
      }
      var model = NR.buildModel(v.data);
      var result;
      try {
        result = NR.solveModel(model, {
          warm: warmIn,
          shouldCancel: function () { return mySeq !== state.seq; }
        });
      } catch (err) {
        if (mySeq !== state.seq) return;
        state.error = { title: '求解出错', errors: [err.message || String(err)], keepOld: !!state.result };
        setBusy(false);
        renderError();
        return;
      }
      if (mySeq !== state.seq || result.cancelled) return; // 旧计算丢弃
      result.ok = true;
      attachModel(result, model);
      acceptResult(mySeq, result);
    }, 30);
  }

  function onWorkerMessage(ev) {
    var msg = ev.data;
    if (!msg || msg.seq !== state.seq) return; // 旧结果一律忽略
    if (msg.type === 'error') {
      state.error = { title: '求解出错', errors: [msg.message], keepOld: !!state.result };
      setBusy(false);
      renderError();
      return;
    }
    if (msg.type !== 'result' || !msg.ok) {
      state.error = { title: '输入不合法，已保留当前结果', errors: msg.errors || ['未知错误'], keepOld: !!state.result };
      setBusy(false);
      renderError();
      return;
    }
    acceptResult(msg.seq, msg);
  }

  function attachModel(result, model) {
    result.width = model.width;
    result.height = model.height;
    result.edgeA = model.edgeA;
    result.edgeB = model.edgeB;
    result.edgeW = model.edgeW;
    result.edgeG = model.edgeG;
    result.edgeAxis = model.edgeAxis;
    result.edgeWrap = model.edgeWrap;
    result.edgeCount = model.edgeCount;
    result.validCell = model.validCell;
    result.conf = model.conf;
    result.pinKind = model.pinKind;
    result.pinHeight = model.pinHeight;
    result.userPins = model.userPins;
    result.autoPins = model.autoPins;
  }

  function acceptResult(seq, result) {
    if (seq !== state.seq) return; // 双保险
    state.result = result;
    state.error = null;
    setBusy(false);
    buildEdgeLookup(result);
    renderAll();
  }

  function setBusy(b) {
    state.busy = b;
    var pill = $('statusPill');
    pill.className = 'pill ' + (b ? 'busy' : (state.result ? 'good' : 'idle'));
    pill.textContent = b ? '计算中…' : (state.result ? '就绪' : '待计算');
  }

  /* ---------------- 边检索 ---------------- */
  function buildEdgeLookup(result) {
    var n = result.width * result.height;
    var head = new Int32Array(n); head.fill(-1);
    var count = new Uint8Array(n);
    // 边按水平再垂直、格号升序构建；对每格记录其发出的连续边段起点
    var firstH = new Int32Array(n); firstH.fill(-1);
    var firstV = new Int32Array(n); firstV.fill(-1);
    for (var e = 0; e < result.edgeCount; e++) {
      var a = result.edgeA[e];
      if (result.edgeAxis[e] === 0) {
        if (firstH[a] < 0) firstH[a] = e;
      } else {
        if (firstV[a] < 0) firstV[a] = e;
      }
      count[a]++;
    }
    state.edgeOfCell = firstH; // 水平边起点（-1 表示无）
    state.edgeOfCellV = firstV;
    state.edgeOfCellCount = count;
  }

  /* ---------------- 颜色映射 ---------------- */
  // 高度：感知均匀的青蓝系分段（自己插值，不依赖外部库）
  var HEIGHT_STOPS = [
    [0.05, 0.08, 0.16], [0.10, 0.28, 0.45], [0.12, 0.55, 0.66],
    [0.35, 0.78, 0.72], [0.78, 0.86, 0.62], [0.95, 0.74, 0.38], [0.90, 0.42, 0.22]
  ];

  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    var z = t * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(z));
    var f = z - i;
    var a = stops[i], b = stops[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    ];
  }

  // 残差：0 为中性深灰，负 -> 蓝，正 -> 品红，按 |r|/scale 饱和
  function residualColor(r, scale, dark) {
    var t = scale > 0 ? Math.min(1, Math.abs(r) / scale) : 0;
    var neutral = dark ? [26, 36, 48] : [238, 241, 245];
    var end = r >= 0 ? [240, 100, 138] : [90, 160, 240];
    return [
      Math.round(neutral[0] + (end[0] - neutral[0]) * t),
      Math.round(neutral[1] + (end[1] - neutral[1]) * t),
      Math.round(neutral[2] + (end[2] - neutral[2]) * t)
    ];
  }

  function isDarkTheme() {
    if (state.theme === 'dark') return true;
    if (state.theme === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /* ---------------- 渲染 ---------------- */
  var baseCanvas = $('baseCanvas');
  var residualCanvas = $('residualCanvas');
  var overlayCanvas = $('overlayCanvas');
  var legendCanvas = $('legendCanvas');

  function renderAll() {
    renderPinList();
    renderStats();
    renderCanvas();
    renderWorstEdges();
    renderInspect();
    syncParamInputs();
  }

  function renderCanvas() {
    var r = state.result;
    if (!r) return;
    var W = r.width, H = r.height;
    baseCanvas.width = W; baseCanvas.height = H;
    residualCanvas.width = W; residualCanvas.height = H;
    overlayCanvas.width = W; overlayCanvas.height = H;
    var bctx = baseCanvas.getContext('2d');
    var rctx = residualCanvas.getContext('2d');
    var octx = overlayCanvas.getContext('2d');
    rctx.clearRect(0, 0, W, H);
    var img = bctx.createImageData(W, H);
    var dark = isDarkTheme();
    var data = img.data;
    var n = W * H;

    if (state.view === 'height') {
      var hmin = Infinity, hmax = -Infinity;
      for (var i = 0; i < n; i++) {
        if (r.validCell[i]) {
          var hh = r.heights[i];
          if (hh < hmin) hmin = hh;
          if (hh > hmax) hmax = hh;
        }
      }
      var span = (hmax - hmin) || 1;
      for (i = 0; i < n; i++) {
        var o = i * 4;
        if (!r.validCell[i]) {
          var hole = dark ? [10, 15, 21] : [223, 229, 236];
          data[o] = hole[0]; data[o + 1] = hole[1]; data[o + 2] = hole[2]; data[o + 3] = 255;
          continue;
        }
        var c = ramp(HEIGHT_STOPS, (r.heights[i] - hmin) / span);
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
      }
      bctx.putImageData(img, 0, 0);
      rctx.clearRect(0, 0, W, H); // 高度视图不叠残差
      drawLegendHeight(hmin, hmax);
      $('legendName').textContent = '高度 h';
      $('legendMin').textContent = hmin.toFixed(4);
      $('legendMax').textContent = hmax.toFixed(4);
      $('legendZeroNote').textContent = '';
    } else {
      var axis = state.view === 'resH' ? 0 : 1;
      var rmax = 0;
      for (var e = 0; e < r.edgeCount; e++) {
        if (r.edgeAxis[e] !== axis) continue;
        var av = Math.abs(r.edgeResidual[e]);
        if (av > rmax) rmax = av;
      }
      // 底色：孔格特殊色，非孔格中性
      for (i = 0; i < n; i++) {
        o = i * 4;
        if (!r.validCell[i]) {
          var hc = dark ? [10, 15, 21] : [223, 229, 236];
          data[o] = hc[0]; data[o + 1] = hc[1]; data[o + 2] = hc[2]; data[o + 3] = 255;
        } else {
          var neu = dark ? [26, 36, 48] : [238, 241, 245];
          data[o] = neu[0]; data[o + 1] = neu[1]; data[o + 2] = neu[2]; data[o + 3] = 255;
        }
      }
      bctx.putImageData(img, 0, 0);
      // 残差独立成层：边染在起格与终格的相邻像素上，回绕边两端各染一个边缘像素
      var eimg = rctx.createImageData(W, H);
      var ed = eimg.data;
      ed.fill(0);
      for (e = 0; e < r.edgeCount; e++) {
        if (r.edgeAxis[e] !== axis) continue;
        var col = residualColor(r.edgeResidual[e], rmax, dark);
        paintEdgePixels(ed, r, e, col, W, H);
      }
      rctx.putImageData(eimg, 0, 0);
      drawLegendResidual(rmax);
      $('legendName').textContent = axis === 0 ? '水平边残差 r' : '垂直边残差 r';
      $('legendMin').textContent = ('-' + rmax.toExponential(2));
      $('legendMax').textContent = '+' + rmax.toExponential(2);
      $('legendZeroNote').textContent = '蓝=负，品红=正，灰=0';
    }
    drawOverlay(octx, W, H);
  }

  function paintEdgePixels(ed, r, e, col, W, H) {
    var a = r.edgeA[e], b = r.edgeB[e];
    var ax = a % W, ay = (a / W) | 0;
    var bx = b % W, by = (b / W) | 0;
    var pts;
    if (r.edgeAxis[e] === 0) {
      if (r.edgeWrap[e]) {
        // 回绕边：起格右缘 + 终格左缘两个像素
        pts = [[W - 1, ay], [0, by]];
      } else {
        // 普通水平边：起格右半像素与终格左半像素都染色，形成连续线
        pts = [[ax, ay], [bx, by]];
      }
    } else {
      if (r.edgeWrap[e]) {
        pts = [[ax, H - 1], [bx, 0]];
      } else {
        pts = [[ax, ay], [bx, by]];
      }
    }
    for (var k = 0; k < pts.length; k++) {
      var idx = (pts[k][1] * W + pts[k][0]) * 4;
      ed[idx] = col[0]; ed[idx + 1] = col[1]; ed[idx + 2] = col[2]; ed[idx + 3] = 255;
    }
  }

  function drawOverlay(octx, W, H) {
    octx.clearRect(0, 0, W, H);
    var r = state.result;
    if (!r) return;
    var x, y, i;
    // 用户锁点：青蓝；自动锁点：灰
    for (i = 0; i < W * H; i++) {
      if (r.pinKind[i] === 1) {
        x = i % W; y = (i / W) | 0;
        octx.fillStyle = 'rgba(57,194,201,.95)';
        octx.fillRect(x, y, 1, 1);
      } else if (r.pinKind[i] === 2) {
        x = i % W; y = (i / W) | 0;
        octx.fillStyle = 'rgba(143,160,178,.85)';
        octx.fillRect(x, y, 1, 1);
      }
    }
    // 悬停高亮
    if (state.hoverCell >= 0 && r.validCell[state.hoverCell]) {
      x = state.hoverCell % W; y = (state.hoverCell / W) | 0;
      octx.strokeStyle = '#ffd166';
      octx.lineWidth = 0.14;
      octx.strokeRect(x + 0.1, y + 0.1, 0.8, 0.8);
    }
  }

  function drawLegendHeight(hmin, hmax) {
    var lctx = legendCanvas.getContext('2d');
    var img = lctx.createImageData(150, 10);
    for (var x = 0; x < 150; x++) {
      var c = ramp(HEIGHT_STOPS, x / 149);
      for (var y = 0; y < 10; y++) {
        var o = (y * 150 + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
  }

  function drawLegendResidual(rmax) {
    var lctx = legendCanvas.getContext('2d');
    var img = lctx.createImageData(150, 10);
    var dark = isDarkTheme();
    for (var x = 0; x < 150; x++) {
      var t = x / 149 * 2 - 1; // -1..1
      var c = residualColor(t * rmax, rmax, dark);
      for (var y = 0; y < 10; y++) {
        var o = (y * 150 + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
  }

  /* ---------------- 统计与检视 ---------------- */
  function renderStats() {
    var r = state.result;
    if (!r) return;
    $('statVerify').innerHTML = r.verifyPassed
      ? '<span class="pill good">通过 ≤ 1e-7</span>'
      : '<span class="pill bad">未通过</span>';
    $('statWorst').textContent = r.worstCell >= 0
      ? '#' + r.worstCell + '  ' + r.worstCellRatio.toExponential(3)
      : '—（无自由格）';
    $('statSizes').textContent = r.edgeCount + ' / ' + r.nFree;
    $('statIters').textContent = String(r.iterations);
    $('statWrms').textContent = r.wrms.toExponential(4);
    $('statMaxRes').textContent = r.maxAbsResidualEdge >= 0
      ? '#' + r.maxAbsResidualEdge + '  ' + r.maxAbsResidual.toExponential(3)
      : '—';
    $('statTime').textContent = r.buildMs.toFixed(0) + 'ms / ' + r.solveMs.toFixed(0) + 'ms';
    $('statPins').textContent = r.userPins.length + ' / ' + r.autoPins.length;
    $('gridSizeHint').textContent = r.width + ' × ' + r.height + ' = ' + (r.width * r.height) + ' 格';
  }

  function renderWorstEdges() {
    var r = state.result;
    var body = $('worstEdgesBody');
    body.innerHTML = '';
    if (!r || !r.edgeCount) {
      body.innerHTML = '<tr><td colspan="5" class="inspect-empty">没有有效边。</td></tr>';
      return;
    }
    var idx = [];
    for (var e = 0; e < r.edgeCount; e++) idx.push(e);
    idx.sort(function (p, q) { return Math.abs(r.edgeResidual[q]) - Math.abs(r.edgeResidual[p]); });
    var top = idx.slice(0, 12);
    top.forEach(function (e) {
      var tr = document.createElement('tr');
      var dir = (r.edgeAxis[e] === 0 ? '水平' : '垂直') + (r.edgeWrap[e] ? '·回绕' : '');
      tr.innerHTML = '<td>#' + e + '</td><td>' + dir + '</td><td>' +
        r.edgeG[e].toExponential(3) + '</td><td>' + r.edgeW[e] + '</td><td>' +
        r.edgeResidual[e].toExponential(3) + '</td>';
      tr.title = '边 #' + e + '：格 ' + r.edgeA[e] + ' → ' + r.edgeB[e];
      body.appendChild(tr);
    });
  }

  function renderInspect() {
    var r = state.result;
    var box = $('inspectCell');
    var ebox = $('inspectEdges');
    var id = state.hoverCell;
    if (!r || id < 0) {
      box.innerHTML = '<div class="inspect-empty">将鼠标移到画布上查看单格数据。</div>';
      ebox.innerHTML = '<div class="inspect-empty">悬停格后列出其向右、向下（含回绕）的边。</div>';
      return;
    }
    var W = r.width, H = r.height;
    var x = id % W, y = (id / W) | 0;
    if (!r.validCell[id]) {
      box.innerHTML = '<div class="kv"><span class="k">格号</span><span class="v">#' + id +
        ' (' + x + ',' + y + ')</span></div>' +
        '<div class="kv"><span class="k">类型</span><span class="v">孔（无约束）</span></div>';
      ebox.innerHTML = '<div class="inspect-empty">孔格不参与任何边。</div>';
      return;
    }
    var pinLabel = r.pinKind[id] === 1 ? '用户锁点' : (r.pinKind[id] === 2 ? '自动锁点' : '自由格');
    var s = state.input.samples[id];
    box.innerHTML =
      kv('格号', '#' + id + ' (' + x + ', ' + y + ')') +
      kv('类型', pinLabel) +
      kv('高度 h', fmt(r.heights[id])) +
      (r.pinKind[id] ? kv('锁定高度', fmt(r.pinHeight[id])) : '') +
      kv('法线 n', '[' + s[0] + ', ' + s[1] + ', ' + s[2] + ']') +
      kv('置信度', String(s[3])) +
      kv('|有向残差和|/权重和', r.pinKind[id] ? '（锁点不考核）' : r.cellRatio[id].toExponential(3));

    var rows = [];
    var h0 = state.edgeOfCell[id];
    if (h0 >= 0) rows.push(h0);
    var v0 = state.edgeOfCellV ? state.edgeOfCellV[id] : -1;
    if (v0 >= 0) rows.push(v0);
    if (!rows.length) {
      ebox.innerHTML = '<div class="inspect-empty">该格没有发出的有效边。</div>';
      return;
    }
    ebox.innerHTML = rows.map(function (e) {
      var dir = (r.edgeAxis[e] === 0 ? '向右' : '向下') + (r.edgeWrap[e] ? '（回绕）' : '');
      return '<div class="kv"><span class="k">边 #' + e + ' ' + dir + '<br>→ 格 ' +
        r.edgeB[e] + '</span><span class="v">g=' + fmt(r.edgeG[e]) +
        '<br>w=' + r.edgeW[e] + '<br>r=' + fmt(r.edgeResidual[e]) + '</span></div>';
    }).join('');
  }

  function kv(k, v) {
    return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }
  function fmt(x) { return (typeof x === 'number') ? x.toExponential(4) : String(x); }

  /* ---------------- 锁点列表 ---------------- */
  function renderPinList() {
    var box = $('pinList');
    box.innerHTML = '';
    var pins = state.input.pins || [];
    if (!pins.length) {
      box.innerHTML = '<div class="pin-empty">暂无用户锁点，连通块将自动锁 0。</div>';
      return;
    }
    pins.forEach(function (p, idx) {
      var row = document.createElement('div');
      row.className = 'pin-item';
      row.innerHTML =
        '<span class="tag user">用户</span>' +
        '<span class="cell-id">#' + p[0] + '</span>' +
        '<input type="number" step="any" data-idx="' + idx + '" class="pin-h" value="' + p[1] + '">' +
        '<button class="btn danger del" data-idx="' + idx + '" type="button">删</button>';
      box.appendChild(row);
    });
    box.querySelectorAll('input.pin-h').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var idx = +inp.dataset.idx;
        var val = parseFloat(inp.value);
        if (!isFinite(val)) { inp.classList.add('invalid'); return; }
        inp.classList.remove('invalid');
        state.input.pins[idx][1] = val;
        scheduleRerun();
      });
    });
    box.querySelectorAll('button.del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.input.pins.splice(+btn.dataset.idx, 1);
        scheduleRerun();
      });
    });
  }

  /* ---------------- 参数输入 ---------------- */
  function syncParamInputs() {
    $('dxInput').value = state.input.spacing[0];
    $('dyInput').value = state.input.spacing[1];
    $('wrapXInput').checked = !!state.input.wrap[0];
    $('wrapYInput').checked = !!state.input.wrap[1];
  }

  function bindParamInputs() {
    $('dxInput').addEventListener('change', function (e) {
      var v = parseFloat(e.target.value);
      if (isFinite(v)) { state.input.spacing[0] = v; scheduleRerun(); }
    });
    $('dyInput').addEventListener('change', function (e) {
      var v = parseFloat(e.target.value);
      if (isFinite(v)) { state.input.spacing[1] = v; scheduleRerun(); }
    });
    $('wrapXInput').addEventListener('change', function (e) {
      state.input.wrap[0] = e.target.checked; scheduleRerun();
    });
    $('wrapYInput').addEventListener('change', function (e) {
      state.input.wrap[1] = e.target.checked; scheduleRerun();
    });
  }

  /* ---------------- 错误条 ---------------- */
  function renderError() {
    var banner = $('errorBanner');
    if (!state.error) { banner.hidden = true; return; }
    banner.hidden = false;
    $('errorTitle').textContent = state.error.title;
    $('errorList').innerHTML = state.error.errors.map(function (m) {
      return '<li>' + escapeHtml(m) + '</li>';
    }).join('');
    $('errorKept').hidden = !state.error.keepOld;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 画布交互 ---------------- */
  function bindCanvas() {
    var stack = $('canvasStack');
    stack.addEventListener('mousemove', function (ev) {
      var id = eventToCell(ev);
      if (id !== state.hoverCell) {
        state.hoverCell = id;
        renderInspect();
        renderCanvas();
      }
    });
    stack.addEventListener('mouseleave', function () {
      state.hoverCell = -1;
      renderInspect();
      renderCanvas();
    });
    stack.addEventListener('click', function (ev) {
      if (!state.addPinMode) return;
      var id = eventToCell(ev);
      if (id < 0 || !state.result) return;
      if (!state.result.validCell[id]) {
        toast('格 #' + id + ' 是孔，不能锁定');
        return;
      }
      if (state.input.pins.some(function (p) { return p[0] === id; })) {
        // 已锁：点击即删除
        state.input.pins = state.input.pins.filter(function (p) { return p[0] !== id; });
        toast('已删除格 #' + id + ' 的用户锁点');
      } else {
        state.input.pins.push([id, 0]);
        toast('已在格 #' + id + ' 加锁（高度 0，可在左栏修改）');
      }
      scheduleRerun(0);
    });
  }

  function eventToCell(ev) {
    var r = state.result;
    if (!r) return -1;
    var rect = baseCanvas.getBoundingClientRect();
    var fx = (ev.clientX - rect.left) / rect.width;
    var fy = (ev.clientY - rect.top) / rect.height;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return -1;
    var x = Math.min(r.width - 1, Math.floor(fx * r.width));
    var y = Math.min(r.height - 1, Math.floor(fy * r.height));
    return y * r.width + x;
  }

  /* ---------------- 文件载入 / 生成 / 导出 ---------------- */
  function bindIO() {
    $('fileInput').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          loadInput(parsed, '已载入 ' + file.name);
        } catch (err) {
          state.error = { title: 'JSON 解析失败', errors: [err.message], keepOld: !!state.result };
          renderError();
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });

    $('loadSampleBtn').addEventListener('click', function () {
      loadInput(clone(DEFAULT_INPUT), '已载入内置样例');
    });

    $('genBtn').addEventListener('click', function () {
      loadInput(makeSynthetic384(), '已生成 384×384 带孔双周期测试场');
    });

    $('exportInputBtn').addEventListener('click', function () {
      downloadJson('normal-relief-input.json', state.input);
    });
    $('exportHeightsBtn').addEventListener('click', function () {
      if (!state.result) { toast('还没有可导出的结果'); return; }
      var r = state.result;
      var out = {
        width: r.width, height: r.height,
        spacing: state.input.spacing, wrap: state.input.wrap,
        verifyPassed: r.verifyPassed,
        worstCellRatio: r.worstCellRatio,
        wrms: r.wrms,
        iterations: r.iterations,
        userPins: state.input.pins,
        heights: Array.from(r.heights, function (h) { return isFinite(h) ? h : null; })
      };
      downloadJson('recovered-heights.json', out);
    });
    $('exportPngBtn').addEventListener('click', exportPng);
    $('exportCsvBtn').addEventListener('click', exportCsv);
  }

  function loadInput(parsed, okMsg) {
    var v = NR.validateInput(parsed);
    if (!v.ok) {
      state.error = { title: '文件内容不合法，已保留当前结果', errors: v.errors, keepOld: !!state.result };
      renderError();
      return;
    }
    state.input = parsed;
    if (!Array.isArray(parsed.pins)) parsed.pins = [];
    state.error = null;
    renderError();
    syncParamInputs();
    toast(okMsg);
    scheduleRerun(0);
  }

  // 确定性 384² 合成场：周期正弦高度 + 3% 孔 + 随机置信度
  function makeSynthetic384() {
    var W = 384, H = 384, dx = 1, dy = 1;
    var kx = 2 * Math.PI / (W * dx), ky = 2 * Math.PI / (H * dy), A = 2.5;
    var seed = 123456789;
    function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var samples = [];
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (rand() < 0.03) { samples.push(null); continue; }
        var gx = A * kx * Math.cos(kx * x * dx) * Math.sin(ky * y * dy);
        var gy = A * ky * Math.sin(kx * x * dx) * Math.cos(ky * y * dy);
        var inv = 1 / Math.hypot(gx, gy, 1);
        samples.push([-gx * inv, -gy * inv, inv, 1 + Math.floor(rand() * 16)]);
      }
    }
    return { width: W, height: H, spacing: [dx, dy], wrap: [true, true], samples: samples, pins: [] };
  }

  function downloadJson(name, obj) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    triggerDownload(URL.createObjectURL(blob), name);
  }

  function exportCsv() {
    var r = state.result;
    if (!r) { toast('还没有可导出的结果'); return; }
    var lines = ['edge,axis,wrap,from_cell,to_cell,g,weight,residual_signed'];
    for (var e = 0; e < r.edgeCount; e++) {
      lines.push([
        e,
        r.edgeAxis[e] === 0 ? 'x' : 'y',
        r.edgeWrap[e] ? 1 : 0,
        r.edgeA[e], r.edgeB[e],
        r.edgeG[e], r.edgeW[e], r.edgeResidual[e]
      ].join(','));
    }
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    triggerDownload(URL.createObjectURL(blob), 'edge-residuals.csv');
  }

  function exportPng() {
    var r = state.result;
    if (!r) { toast('还没有可导出的结果'); return; }
    // 导出当前视图的放大 PNG（每格 4px）
    var scale = 4;
    var c = document.createElement('canvas');
    c.width = r.width * scale; c.height = r.height * scale;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(baseCanvas, 0, 0, c.width, c.height);
    if (state.view !== 'height') {
      ctx.drawImage(residualCanvas, 0, 0, c.width, c.height);
    }
    ctx.drawImage(overlayCanvas, 0, 0, c.width, c.height);
    c.toBlob(function (blob) {
      triggerDownload(URL.createObjectURL(blob), 'heightmap.png');
    }, 'image/png');
  }

  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /* ---------------- 杂项 ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  function bindViewTabs() {
    [['tabHeight', 'height'], ['tabResH', 'resH'], ['tabResV', 'resV']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () {
        state.view = pair[1];
        ['tabHeight', 'tabResH', 'tabResV'].forEach(function (id) { $(id).classList.remove('active'); });
        $(pair[0]).classList.add('active');
        renderCanvas();
      });
    });
    $('addPinModeBtn').addEventListener('click', function () {
      state.addPinMode = !state.addPinMode;
      $('addPinModeBtn').classList.toggle('active', state.addPinMode);
      $('addPinModeBtn').textContent = state.addPinMode ? '✓ 点格加锁模式（再点关闭）' : '＋ 点格加锁模式';
    });
  }

  function bindTheme() {
    try {
      state.theme = localStorage.getItem('nr-theme') || null;
      if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    } catch (e) {}
    $('themeBtn').addEventListener('click', function () {
      state.theme = isDarkTheme() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', state.theme);
      try { localStorage.setItem('nr-theme', state.theme); } catch (e) {}
      if (state.result) renderCanvas();
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bindTheme();
    bindParamInputs();
    bindCanvas();
    bindIO();
    bindViewTabs();
    syncParamInputs();
    spawnWorker();
    scheduleRerun(0);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
