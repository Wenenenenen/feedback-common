/* paper-grid-evidence — 界面与交互
 *
 * 结构：
 *   样本导入（zip / 多文件 / 文件夹）→ 逐样本构建（core.js）
 *   当前样本 → 求解（solver.js）→ 渲染（canvas）
 *   点边 → 局部两种损失 + 强制相反决定时的全表最少损失
 *   锁定 → 重新求解；锁定冲突时禁止导出
 *
 * 全局依赖（按顺序加载）：GridSolver、PaperGridCore、PaperGridSample。
 */
(function () {
  'use strict';

  var Solver = window.GridSolver;
  var Core = window.PaperGridCore;
  var Sample = window.PaperGridSample;

  var state = {
    cases: [],          // [{ name, scan, mask, grid, solved, locks, error }]
    active: -1,
    selectedEdge: null,
    locksByCase: new Map(),
    forceCache: new Map(),
    view: { scale: 1, offsetX: 0, offsetY: 0, fitted: false },
    dragging: false,
    dragMoved: false,
    dragStart: null,
    hoverEdge: null,
    solving: false
  };

  var $ = function (id) { return document.getElementById(id); };

  // 颜色从 CSS 变量取，保证深浅色一致
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ========================================================================
  // 导入
  // ========================================================================
  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持解压 zip，请改用“选择文件夹”。'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setStatus('busy', '正在读取 ' + files.length + ' 个文件…');
    try {
      var map = {};
      var zipSeen = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var lower = f.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          zipSeen++;
          var bytes = new Uint8Array(await f.arrayBuffer());
          var inner = await Core.readZipAsync(bytes, inflateRaw);
          var prefix = f.name.replace(/\.zip$/i, '');
          Object.keys(inner).forEach(function (p) {
            map[prefix + '/' + p] = inner[p];
          });
        } else {
          var rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
          map[rel] = new Uint8Array(await f.arrayBuffer());
        }
      }
      var found = Core.casesFromFiles(map, '样本');
      adoptCases(found.cases, found.errors);
    } catch (e) {
      setStatus('bad', e && e.message ? e.message : String(e));
      banner(e && e.message ? e.message : String(e));
    }
  }

  async function loadSample() {
    setStatus('busy', '正在载入内置示例…');
    try {
      var bytes = Core.b64ToBytes(Sample.SAMPLE_ZIP_BASE64);
      var inner = await Core.readZipAsync(bytes, inflateRaw);
      var found = Core.casesFromFiles(inner, '内置示例');
      adoptCases(found.cases, found.errors);
    } catch (e) {
      setStatus('bad', e && e.message ? e.message : String(e));
      banner(e && e.message ? e.message : String(e));
    }
  }

  function adoptCases(cases, errors) {
    state.cases = cases;
    state.active = cases.length ? 0 : -1;
    state.locksByCase = new Map();
    state.forceCache = new Map();
    state.selectedEdge = null;
    cases.forEach(function (c, i) {
      state.locksByCase.set(i, c.grid.locks.map(function (L) {
        return { axis: L.axis, row: L.row, col: L.col, keep: L.keep };
      }));
      // 先全部求解一次，样本标签上的状态点才准确。
      solveCaseAt(i);
    });
    renderCaseTabs();
    if (errors && errors.length) {
      banner('以下样本未能载入：' + errors.map(function (e) { return e.name + '（' + e.message + '）'; }).join('；'));
    } else {
      banner(null);
    }
    if (cases.length) selectCase(0);
    else setStatus('bad', '没有可用样本');
    if (errors && errors.length) setStatus('bad', '部分样本载入失败');
  }

  // ========================================================================
  // 求解
  // ========================================================================

  function solveCaseAt(i) {
    var c = state.cases[i];
    var locks = state.locksByCase.get(i) || [];
    var t0 = now();
    try {
      c.solved = Core.solveCase(c.scan, c.mask, c.grid, Solver, { locks: locks });
      c.error = null;
    } catch (e) {
      c.error = e && e.message ? e.message : String(e);
      c.solved = null;
    }
    c.solveMs = now() - t0;
    c.locks = locks;
    // 任何一次重算都会让此前的「强制相反」反事实失效，整体清空缓存。
    state.forceCache = new Map();
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function activeCase() {
    return state.active >= 0 ? state.cases[state.active] : null;
  }

  // ========================================================================
  // 锁定与强制
  // ========================================================================
  function lockIndex(i, axis, row, col) {
    var locks = state.locksByCase.get(i) || [];
    for (var k = 0; k < locks.length; k++) {
      if (locks[k].axis === axis && locks[k].row === row && locks[k].col === col) return k;
    }
    return -1;
  }

  function setLock(i, axis, row, col, keep, on) {
    var locks = state.locksByCase.get(i) || [];
    var idx = lockIndex(i, axis, row, col);
    if (idx >= 0) {
      if (on) locks[idx].keep = keep;
      else locks.splice(idx, 1);
    } else if (on) {
      locks.push({ axis: axis, row: row, col: col, keep: keep });
    }
    state.locksByCase.set(i, locks);
    solveCaseAt(i);
    state.forceCache = new Map();
    return caseConflict(i);
  }

  // 同一短边同时出现保留与去掉锁定 ⇒ 直接冲突。
  function directConflictIds(locks) {
    var keepSet = {}, remSet = {};
    for (var i = 0; i < locks.length; i++) {
      var L = locks[i];
      var id = L.axis + ',' + L.row + ',' + L.col;
      (L.keep ? keepSet : remSet)[id] = true;
    }
    return Object.keys(keepSet).filter(function (id) { return remSet[id]; });
  }

  // 当前样本的锁定是否「冲突」：直接矛盾，或锁定组合下无可行铺法
  // （无锁定时全集铺法必定存在，故不可行只可能来自锁定互斥）。
  function caseConflict(i) {
    var c = state.cases[i];
    var locks = state.locksByCase.get(i) || [];
    var direct = directConflictIds(locks);
    if (direct.length) return { conflict: true, kind: 'direct', ids: direct };
    if (c && c.solved && c.solved.result && !c.solved.result.feasible) {
      return {
        conflict: true, kind: c.solved.result.reason === 'lock-conflict' ? 'direct' : 'infeasible',
        ids: c.solved.result.reason === 'lock-conflict' ? direct : []
      };
    }
    return { conflict: false, kind: null, ids: [] };
  }

  function allConflicts() {
    var out = [];
    state.cases.forEach(function (c, i) {
      var info = caseConflict(i);
      if (info.conflict) out.push({ index: i, name: c.name, kind: info.kind, ids: info.ids });
    });
    return out;
  }

  // 依据当前决定，计算强制相反决定后的最优
  function computeForce(i, edge) {
    var c = state.cases[i];
    var dec = c.solved && c.solved.decisions;
    if (!dec || !c.solved.result || !c.solved.result.feasible) return null;
    var currentlyKept = edge.axis === 'v'
      ? dec.v[edge.row * (c.grid.C - 1) + (edge.col - 1)] === 1
      : dec.h[(edge.row - 1) * c.grid.C + edge.col] === 1;
    var flipKeep = !currentlyKept;
    var key = i + '|' + edge.axis + edge.row + ',' + edge.col + '|' + (flipKeep ? 'K' : 'R');
    if (state.forceCache.has(key)) return state.forceCache.get(key);
    // 「强制相反」是相对于当前决定的反事实：这条边自带的锁定要先移除，
    // 否则反事实永远与当前决定矛盾。
    var locks = (state.locksByCase.get(i) || []).filter(function (L) {
      return !(L.axis === edge.axis && L.row === edge.row && L.col === edge.col);
    });
    var res;
    try {
      res = Core.solveCase(c.scan, c.mask, c.grid, Solver, {
        locks: locks,
        force: { axis: edge.axis, row: edge.row, col: edge.col, keep: flipKeep }
      });
    } catch (e) {
      res = { result: { feasible: false, reason: e.message }, forcedKeep: flipKeep };
    }
    res.currentlyKept = currentlyKept;
    res.forcedKeep = flipKeep;
    res.baseLoss = c.solved.result.loss;
    res.baseCount = c.solved.result.count;
    state.forceCache.set(key, res);
    return res;
  }

  // ========================================================================
  // 渲染：样本标签
  // ========================================================================
  function renderCaseTabs() {
    var bar = $('caseBar'), tabs = $('caseTabs');
    if (!state.cases.length) { bar.hidden = true; tabs.innerHTML = ''; return; }
    bar.hidden = false;
    tabs.innerHTML = '';
    state.cases.forEach(function (c, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'case-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === state.active ? 'true' : 'false');
      var ok = c.solved && c.solved.result && c.solved.result.feasible;
      var badge = document.createElement('span');
      badge.className = 'badge ' + (ok ? 'ok' : 'bad');
      btn.appendChild(badge);
      btn.appendChild(document.createTextNode(c.name));
      btn.title = c.name;
      btn.addEventListener('click', function () { selectCase(i); });
      tabs.appendChild(btn);
    });
  }

  function selectCase(i) {
    if (i < 0 || i >= state.cases.length) return;
    state.active = i;
    state.selectedEdge = null;
    state.hoverEdge = null;
    state.view.fitted = false;
    var c = state.cases[i];
    if (!c.solved && !c.error) solveCaseAt(i);
    renderCaseTabs();
    renderAll();
    fitView();
    setStatus('ok', '已载入「' + c.name + '」');
  }

  // ========================================================================
  // 渲染：整个面板
  // ========================================================================
  function renderAll() {
    var c = activeCase();
    $('stageEmpty').hidden = !!c;
    if (!c) {
      $('infoName').textContent = '—';
      $('infoImage').textContent = '—';
      $('infoGrid').textContent = '—';
      $('infoMask').textContent = '—';
      $('infoEdges').textContent = '—';
      $('resLoss').textContent = '—';
      $('resCount').textContent = '—';
      $('resTime').textContent = '—';
      clearEdgeDetail();
      renderEdgeTable();
      drawCanvas();
      updateExportUI();
      return;
    }
    var g = c.grid;
    $('infoName').textContent = c.name;
    $('infoImage').textContent = c.scan.width + ' × ' + c.scan.height;
    $('infoGrid').textContent = g.R + ' 行 × ' + g.C + ' 列';
    $('infoMask').textContent = c.mask ? '有（' + c.mask.width + '×' + c.mask.height + '）' : '无';
    $('infoEdges').textContent = (g.R * (g.C - 1) + (g.R - 1) * g.C) + ' 条';
    renderResult();
    renderConflicts();
    renderEdgeDetail();
    renderEdgeTable();
    drawCanvas();
    updateExportUI();
  }

  function renderResult() {
    var c = activeCase();
    var res = c && c.solved && c.solved.result;
    var lossEl = $('resLoss'), countEl = $('resCount'), timeEl = $('resTime'), note = $('resNote');
    note.className = 'result-note';
    if (!c) { lossEl.textContent = '—'; countEl.textContent = '—'; timeEl.textContent = '—'; note.textContent = ''; return; }
    if (c.error) {
      lossEl.textContent = '—'; countEl.textContent = '—'; timeEl.textContent = '—';
      note.className = 'result-note warn';
      note.textContent = '样本错误：' + c.error;
      return;
    }
    if (!res || !res.feasible) {
      lossEl.textContent = '—';
      countEl.textContent = '—';
      timeEl.textContent = '—';
      note.className = 'result-note warn';
      note.textContent = '当前锁定下没有可行的矩形铺法。' + reasonText(res && res.reason);
      return;
    }
    lossEl.textContent = formatNum(res.loss);
    countEl.textContent = String(res.count);
    timeEl.textContent = c.solveMs != null ? c.solveMs.toFixed(1) + ' ms' : '—';
    var zeroN = c.solved.edges.filter(function (e) { return e.samples === 0; }).length;
    var lockN = (state.locksByCase.get(state.active) || []).length;
    var parts = [];
    parts.push(lockN ? ('已应用 ' + lockN + ' 条锁定') : '无锁定');
    if (zeroN) parts.push(zeroN + ' 条短边无有效像素（两种代价均为 0）');
    note.textContent = parts.join(' · ');
  }

  function reasonText(reason) {
    if (!reason) return '';
    var map = {
      'lock-conflict': '同一短边被同时锁定为保留与去掉。',
      'no-tiling': '约束互相矛盾，无法拼成矩形。',
      'force-conflict': '强制决定与已有锁定冲突。',
      'lock-out-of-range': '锁定坐标越界。',
      'force-out-of-range': '强制坐标越界。'
    };
    return map[reason] || String(reason);
  }

  function renderConflicts() {
    var bannerEl = $('conflictBanner');
    var all = allConflicts();
    if (!all.length) { bannerEl.hidden = true; bannerEl.textContent = ''; return; }
    bannerEl.hidden = false;
    bannerEl.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = '锁定冲突';
    bannerEl.appendChild(strong);
    var line = document.createElement('span');
    line.textContent = all.map(function (x) {
      if (x.kind === 'direct') {
        return '「' + x.name + '」' + x.ids.map(prettyEdgeId).join('、') + ' 同时锁定保留与去掉';
      }
      return '「' + x.name + '」当前锁定无法拼出任何矩形铺法';
    }).join('；') + '。冲突解除前不能下载。';
    bannerEl.appendChild(line);
  }

  function prettyEdgeId(id) {
    var p = id.split(',');
    return (p[0] === 'v' ? '竖边' : '横边') + ' r' + p[1] + ' c' + p[2];
  }

  // ========================================================================
  // 渲染：短边详情
  // ========================================================================
  function clearEdgeDetail() {
    $('edgeEmpty').hidden = false;
    $('edgeDetail').hidden = true;
  }

  function renderEdgeDetail() {
    var c = activeCase();
    var sel = state.selectedEdge;
    if (!c || !sel) { clearEdgeDetail(); return; }
    var edge = findEdge(c, sel.axis, sel.row, sel.col);
    if (!edge) { clearEdgeDetail(); return; }
    $('edgeEmpty').hidden = true;
    $('edgeDetail').hidden = false;
    $('edgeId').textContent = (edge.axis === 'v' ? '竖边 v' : '横边 h') +
      '(' + edge.row + ',' + edge.col + ')';
    var decEl = $('edgeDecision');
    var dec = c.solved && c.solved.result && c.solved.result.feasible
      ? Core.decisionOfEdge(c.solved, c.grid, edge) : null;
    if (dec) {
      decEl.hidden = false;
      decEl.className = 'pill ' + dec;
      decEl.textContent = dec === 'keep' ? '保留' : '去掉';
    } else {
      decEl.hidden = true;
    }
    $('edgeSamples').textContent = edge.samples + ' 像素' + (edge.samples === 0 ? '（全被掩膜剔除）' : '');
    $('edgeKeep').textContent = formatNum(edge.keep);
    $('edgeRemove').textContent = formatNum(edge.remove);
    var li = lockIndex(state.active, edge.axis, edge.row, edge.col);
    var locks = state.locksByCase.get(state.active) || [];
    $('edgeLock').textContent = li >= 0 ? (locks[li].keep ? '锁定保留' : '锁定去掉') : '未锁定';
    $('lockKeep').classList.toggle('active', li >= 0 && locks[li].keep);
    $('lockRemove').classList.toggle('active', li >= 0 && !locks[li].keep);
    $('lockClear').disabled = li < 0;
    renderForce(edge);
  }

  function renderForce(edge) {
    var box = $('forceResult');
    var c = activeCase();
    var res = c && c.solved && c.solved.result;
    if (!res || !res.feasible) { box.textContent = '当前无可行铺法，无法比较。'; return; }
    var flip = computeForce(state.active, edge);
    if (!flip || !flip.result.feasible) {
      box.innerHTML = '';
      var span = document.createElement('span');
      span.className = 'bad';
      span.textContent = '强制相反决定后无可行铺法。';
      box.appendChild(span);
      return;
    }
    var delta = flip.result.loss - res.loss;
    box.innerHTML = '';
    var t = document.createElement('span');
    t.textContent = '最少总损失 ' + formatNum(flip.result.loss) + '，矩形数 ' + flip.result.count + '（';
    box.appendChild(t);
    var d = document.createElement('span');
    d.className = 'delta ' + (delta > 0 ? 'up' : (delta < 0 ? 'down' : ''));
    d.textContent = delta > 0 ? '+' + formatNum(delta) : (delta < 0 ? String(delta) : '±0');
    box.appendChild(d);
    var t2 = document.createElement('span');
    t2.textContent = delta === 0 ? ' 与当前并列）' : ' 相对当前）';
    box.appendChild(t2);
  }

  function findEdge(c, axis, row, col) {
    var list = c.solved ? c.solved.edges : [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.axis === axis && e.row === row && e.col === col) return e;
    }
    return null;
  }

  // ========================================================================
  // 渲染：逐边表
  // ========================================================================
  function renderEdgeTable() {
    var body = $('edgeBody');
    body.innerHTML = '';
    var c = activeCase();
    var countEl = $('edgeCount');
    if (!c || !c.solved) { countEl.textContent = ''; return; }
    var edges = c.solved.edges;
    countEl.textContent = '共 ' + edges.length + ' 条';
    var locks = state.locksByCase.get(state.active) || [];
    var lockSet = {};
    locks.forEach(function (L) { lockSet[L.axis + ',' + L.row + ',' + L.col] = L.keep ? 'K' : 'R'; });
    var highlight = state.selectedEdge;
    var frag = document.createDocumentFragment();
    edges.forEach(function (e) {
      var tr = document.createElement('tr');
      var id = e.axis + ',' + e.row + ',' + e.col;
      tr.dataset.edge = id;
      if (highlight && highlight.axis === e.axis && highlight.row === e.row && highlight.col === e.col) {
        tr.className = 'selected';
      }
      if (lockSet[id]) tr.classList.add('locked');

      var tdId = document.createElement('td');
      tdId.className = 'mono';
      tdId.textContent = (e.axis === 'v' ? 'v' : 'h') + e.row + ',' + e.col;
      tr.appendChild(tdId);

      var tdK = document.createElement('td');
      tdK.className = 'num keep-text';
      tdK.textContent = formatNum(e.keep);
      tr.appendChild(tdK);

      var tdR = document.createElement('td');
      tdR.className = 'num remove-text';
      tdR.textContent = formatNum(e.remove);
      tr.appendChild(tdR);

      var tdD = document.createElement('td');
      var dec = c.solved.result && c.solved.result.feasible
        ? Core.decisionOfEdge(c.solved, c.grid, e) : null;
      if (dec) {
        var dot = document.createElement('span');
        dot.className = 'dec-dot ' + dec;
        tdD.appendChild(dot);
        tdD.appendChild(document.createTextNode(dec === 'keep' ? '保留' : '去掉'));
      } else {
        tdD.textContent = '—';
      }
      tr.appendChild(tdD);

      var tdL = document.createElement('td');
      if (lockSet[id]) {
        tdL.className = 'lock-mark';
        tdL.textContent = lockSet[id] === 'K' ? '锁·留' : '锁·去';
      } else {
        tdL.className = 'dim';
        tdL.textContent = '';
      }
      tr.appendChild(tdL);

      tr.addEventListener('click', function () { selectEdge({ axis: e.axis, row: e.row, col: e.col }); });
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function selectEdge(sel) {
    state.selectedEdge = sel;
    renderEdgeDetail();
    renderEdgeTable();
    drawCanvas();
    // 让表中选中行可见
    var tr = document.querySelector('tr.selected');
    if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
  }

  // ========================================================================
  // 画布
  // ========================================================================
  var canvas = $('canvas');
  var ctx = canvas.getContext('2d');
  var dpr = 1;

  function resizeCanvas() {
    var stage = $('stage');
    var rect = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    if (state.active >= 0 && !state.view.fitted) fitView();
    drawCanvas();
  }

  function fitView() {
    var c = activeCase();
    if (!c) { state.view.scale = 1; state.view.offsetX = 0; state.view.offsetY = 0; drawCanvas(); return; }
    var rect = $('stage').getBoundingClientRect();
    var pad = 24;
    var sx = (rect.width - pad * 2) / c.scan.width;
    var sy = (rect.height - pad * 2) / c.scan.height;
    var scale = Math.max(0.05, Math.min(sx, sy));
    state.view.scale = scale;
    state.view.offsetX = (rect.width - c.scan.width * scale) / 2;
    state.view.offsetY = (rect.height - c.scan.height * scale) / 2;
    state.view.fitted = true;
    updateZoomLabel();
    drawCanvas();
  }

  function updateZoomLabel() {
    $('zoomLabel').textContent = Math.round(state.view.scale * 100) + '%';
  }

  function imageToScreen(x, y) {
    var v = state.view;
    return [v.offsetX + x * v.scale, v.offsetY + y * v.scale];
  }
  function screenToImage(sx, sy) {
    var v = state.view;
    return [(sx - v.offsetX) / v.scale, (sy - v.offsetY) / v.scale];
  }

  var scanCanvasCache = null;   // { key, canvas }
  var maskCanvasCache = null;

  function getScanCanvas(c) {
    var key = c.name + '|' + c.scan.width + 'x' + c.scan.height + '|' + c.scan.data.length + '|' + (c._imgKey || 0);
    if (scanCanvasCache && scanCanvasCache.key === key) return scanCanvasCache.canvas;
    var cv = document.createElement('canvas');
    cv.width = c.scan.width; cv.height = c.scan.height;
    var cx = cv.getContext('2d');
    var img = cx.createImageData(c.scan.width, c.scan.height);
    var src = c.scan.data;
    for (var i = 0, p = 0; i < src.length; i++, p += 4) {
      var g = src[i];
      img.data[p] = g; img.data[p + 1] = g; img.data[p + 2] = g; img.data[p + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    scanCanvasCache = { key: key, canvas: cv };
    return cv;
  }

  function getMaskCanvas(c) {
    if (!c.mask) return null;
    var key = c.name + '|m';
    if (maskCanvasCache && maskCanvasCache.key === key) return maskCanvasCache.canvas;
    var cv = document.createElement('canvas');
    cv.width = c.mask.width; cv.height = c.mask.height;
    var cx = cv.getContext('2d');
    var img = cx.createImageData(c.mask.width, c.mask.height);
    var src = c.mask.data;
    for (var i = 0, p = 0; i < src.length; i++, p += 4) {
      img.data[p] = 107; img.data[p + 1] = 94; img.data[p + 2] = 168;
      img.data[p + 3] = src[i] === 0 ? 165 : 0;  // 只画被掩膜剔除的区域
    }
    cx.putImageData(img, 0, 0);
    maskCanvasCache = { key: key, canvas: cv };
    return cv;
  }

  function drawCanvas() {
    var stage = $('stage');
    var rect = stage.getBoundingClientRect();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    var c = activeCase();
    if (!c) return;

    var v = state.view;
    ctx.imageSmoothingEnabled = v.scale < 2;
    var [sx, sy] = imageToScreen(0, 0);
    var dw = c.scan.width * v.scale, dh = c.scan.height * v.scale;

    // 纸底
    ctx.fillStyle = cssVar('--paper', '#fbf9f4');
    ctx.fillRect(0, 0, rect.width, rect.height);

    // 原图
    ctx.drawImage(getScanCanvas(c), sx, sy, dw, dh);
    ctx.strokeStyle = cssVar('--line-strong', '#bcb3a1');
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + .5, sy + .5, dw - 1, dh - 1);

    // 掩膜叠加
    if ($('ovMask').checked && c.mask) {
      ctx.drawImage(getMaskCanvas(c), sx, sy, dw, dh);
    }

    // 格线
    if ($('ovGuides').checked) {
      ctx.save();
      ctx.strokeStyle = cssVar('--accent', '#2f5d8a');
      ctx.globalAlpha = .35;
      ctx.lineWidth = Math.max(1, v.scale * .6);
      ctx.setLineDash([4, 4]);
      var xs = c.grid.xs, ys = c.grid.ys, i;
      for (i = 0; i < xs.length; i++) {
        var p0 = imageToScreen(xs[i] + .5, 0);
        var p1 = imageToScreen(xs[i] + .5, c.scan.height);
        line(ctx, p0[0], p0[1], p1[0], p1[1]);
      }
      for (i = 0; i < ys.length; i++) {
        var q0 = imageToScreen(0, ys[i] + .5);
        var q1 = imageToScreen(c.scan.width, ys[i] + .5);
        line(ctx, q0[0], q0[1], q1[0], q1[1]);
      }
      ctx.restore();
    }

    // 矩形
    var solved = c.solved;
    if ($('ovRects').checked && solved && solved.result && solved.result.feasible) {
      drawRects(c, solved.result.rects);
    }

    // 识别边
    if ($('ovEdges').checked && solved && solved.result && solved.result.feasible) {
      drawEdges(c, solved);
    } else if ($('ovEdges').checked && solved && solved.result && !solved.result.feasible) {
      drawLockedOnly(c);
    }

    // 索引
    if ($('ovIndex').checked) drawIndices(c);
  }

  function line(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }

  function vEdgeGeom(c, e) {
    var xs = c.grid.xs, ys = c.grid.ys;
    var x = xs[e.col] + .5;
    var y0 = ys[e.row] + 1, y1 = ys[e.row + 1] - 1;
    return [imageToScreen(x, y0), imageToScreen(x, y1)];
  }
  function hEdgeGeom(c, e) {
    var xs = c.grid.xs, ys = c.grid.ys;
    var y = ys[e.row] + .5;
    var x0 = xs[e.col] + 1, x1 = xs[e.col + 1] - 1;
    return [imageToScreen(x0, y), imageToScreen(x1, y)];
  }

  function drawRects(c, rects) {
    var v = state.view;
    var accent = cssVar('--accent', '#2f5d8a');
    ctx.save();
    ctx.lineWidth = Math.max(1.2, Math.min(3, v.scale * 1.6));
    ctx.strokeStyle = accent;
    ctx.globalAlpha = .38;
    var xs = c.grid.xs, ys = c.grid.ys;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var p = imageToScreen(xs[r[1]] + .5, ys[r[0]] + .5);
      var q = imageToScreen(xs[r[3]] - .5, ys[r[2]] - .5);
      roundRect(ctx, p[0], p[1], q[0] - p[0], q[1] - p[1], Math.min(8, 2 + v.scale));
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, rr) {
    if (w < 2 * rr) rr = w / 2;
    if (h < 2 * rr) rr = h / 2;
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  // 无可行铺法时，至少把已锁定的边标出来，便于逐条解除。
  function drawLockedOnly(c) {
    var v = state.view;
    var locks = state.locksByCase.get(state.active) || [];
    if (!locks.length) return;
    var lockC = cssVar('--lock', '#8a5a12');
    ctx.save();
    ctx.lineWidth = Math.max(2.5, Math.min(8, v.scale * 2.6));
    ctx.lineCap = 'round';
    for (var i = 0; i < locks.length; i++) {
      var L = locks[i];
      var seg = L.axis === 'v' ? vEdgeGeom(c, L) : hEdgeGeom(c, L);
      ctx.strokeStyle = lockC;
      ctx.globalAlpha = 0.9;
      ctx.setLineDash(L.keep ? [] : [5, 4]);
      line(ctx, seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
    }
    ctx.restore();
  }

  function drawEdges(c, solved) {
    var v = state.view;
    var keepC = cssVar('--keep', '#2f7a4e');
    var remC = cssVar('--remove', '#b4562f');
    var lockC = cssVar('--lock', '#8a5a12');
    var accentC = cssVar('--accent', '#2f5d8a');
    var locks = state.locksByCase.get(state.active) || [];
    var lockSet = {};
    locks.forEach(function (L) { lockSet[L.axis + ',' + L.row + ',' + L.col] = L.keep ? 'K' : 'R'; });
    var edges = solved.edges;
    ctx.save();
    // 线宽不随缩放无限变大，保证原图墨线始终可见；高倍时用半透明细线描在墨线上方。
    var baseW = Math.max(2, Math.min(5.5, 1.6 + v.scale * 1.1));
    var haloW = baseW + 4;
    var dashOn = Math.max(3, baseW * 1.6), dashOff = Math.max(2.5, baseW * 1.2);
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var dec = Core.decisionOfEdge(solved, c.grid, e);
      if (!dec) continue;
      var seg = e.axis === 'v' ? vEdgeGeom(c, e) : hEdgeGeom(c, e);
      var isSel = state.selectedEdge && state.selectedEdge.axis === e.axis &&
        state.selectedEdge.row === e.row && state.selectedEdge.col === e.col;
      var isHover = state.hoverEdge && state.hoverEdge.axis === e.axis &&
        state.hoverEdge.row === e.row && state.hoverEdge.col === e.col;
      var id = e.axis + ',' + e.row + ',' + e.col;
      var color = dec === 'keep' ? keepC : remC;
      var dash = dec === 'keep' ? [] : [dashOn, dashOff];

      // 1) 选中/悬停先用强调色画外圈
      if (isSel || isHover) {
        ctx.globalAlpha = isSel ? 0.5 : 0.28;
        ctx.strokeStyle = accentC;
        ctx.lineWidth = haloW + 3;
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        line(ctx, seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
      }
      // 2) 锁定：金色外圈（半透明，不遮盖墨线）
      if (lockSet[id]) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = lockC;
        ctx.lineWidth = haloW;
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        line(ctx, seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
      }
      // 3) 决定本身：半透明彩线
      ctx.globalAlpha = dec === 'keep' ? 0.82 : 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSel ? baseW + 1 : baseW;
      ctx.lineCap = dec === 'keep' ? 'round' : 'butt';
      ctx.setLineDash(dash);
      line(ctx, seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawIndices(c) {
    var v = state.view;
    var xs = c.grid.xs, ys = c.grid.ys;
    if (xs.length * ys.length > 200 || v.scale < 0.3) return;
    ctx.save();
    ctx.fillStyle = cssVar('--fg-dim', '#5f5a51');
    ctx.font = Math.max(8, Math.min(12, 9 * Math.sqrt(v.scale) + 3)) + 'px ' +
      getComputedStyle(document.documentElement).getPropertyValue('--mono');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var r = 0; r < c.grid.R; r++) {
      for (var col = 0; col < c.grid.C; col++) {
        var mid = imageToScreen((xs[col] + xs[col + 1]) / 2, (ys[r] + ys[r + 1]) / 2);
        ctx.fillText(r + ',' + col, mid[0], mid[1]);
      }
    }
    ctx.restore();
  }

  // ========================================================================
  // 画布交互
  // ========================================================================
  function hitTestEdge(clientX, clientY) {
    var c = activeCase();
    if (!c || !c.solved || !c.solved.result || !c.solved.result.feasible) return null;
    var stageRect = $('stage').getBoundingClientRect();
    var sx = clientX - stageRect.left, sy = clientY - stageRect.top;
    var img = screenToImage(sx, sy);
    var ix = img[0], iy = img[1];
    var xs = c.grid.xs, ys = c.grid.ys;
    var v = state.view;
    var tol = Math.max(6, 7 / v.scale); // 屏幕 ~6px 容差
    var best = null, bestD = Infinity;
    var edges = c.solved.edges;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var d;
      if (e.axis === 'v') {
        var ex = xs[e.col];
        if (Math.abs(ix - ex) > tol) continue;
        if (iy < ys[e.row] || iy > ys[e.row + 1]) continue;
        d = Math.abs(ix - ex);
      } else {
        var ey = ys[e.row];
        if (Math.abs(iy - ey) > tol) continue;
        if (ix < xs[e.col] || ix > xs[e.col + 1]) continue;
        d = Math.abs(iy - ey);
      }
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    var stage = $('stage');
    stage.setPointerCapture && stage.setPointerCapture(ev.pointerId);
    state.dragging = true;
    state.dragMoved = false;
    state.dragStart = { x: ev.clientX, y: ev.clientY, ox: state.view.offsetX, oy: state.view.offsetY };
  }

  function onPointerMove(ev) {
    var stage = $('stage');
    var rect = stage.getBoundingClientRect();
    if (state.dragging) {
      var dx = ev.clientX - state.dragStart.x, dy = ev.clientY - state.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.dragMoved = true;
      if (state.dragMoved) {
        state.view.offsetX = state.dragStart.ox + dx;
        state.view.offsetY = state.dragStart.oy + dy;
        stage.classList.add('dragging');
        drawCanvas();
      }
      return;
    }
    var edge = hitTestEdge(ev.clientX, ev.clientY);
    if ((edge && !state.hoverEdge) || (edge && state.hoverEdge &&
        (edge.axis !== state.hoverEdge.axis || edge.row !== state.hoverEdge.row || edge.col !== state.hoverEdge.col)) ||
        (!edge && state.hoverEdge)) {
      state.hoverEdge = edge ? { axis: edge.axis, row: edge.row, col: edge.col } : null;
      stage.classList.toggle('pointing', !!edge);
      drawCanvas();
    }
    var tip = $('hoverTip');
    if (edge) {
      var e = findEdge(activeCase(), edge.axis, edge.row, edge.col);
      tip.hidden = false;
      tip.textContent = (e.axis === 'v' ? 'v' : 'h') + e.row + ',' + e.col +
        ' · 保留损失 ' + formatNum(e.keep) + ' · 去掉损失 ' + formatNum(e.remove);
      tip.style.left = (ev.clientX - rect.left) + 'px';
      tip.style.top = (ev.clientY - rect.top) + 'px';
    } else {
      tip.hidden = true;
    }
  }

  function onPointerUp(ev) {
    var stage = $('stage');
    if (!state.dragging) return;
    var wasDrag = state.dragMoved;
    state.dragging = false;
    state.dragMoved = false;
    stage.classList.remove('dragging');
    if (!wasDrag) {
      var edge = hitTestEdge(ev.clientX, ev.clientY);
      if (edge) selectEdge({ axis: edge.axis, row: edge.row, col: edge.col });
    }
  }

  function onWheel(ev) {
    var c = activeCase();
    if (!c) return;
    ev.preventDefault();
    var stage = $('stage');
    var rect = stage.getBoundingClientRect();
    var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    var img = screenToImage(mx, my);
    var factor = Math.exp(-ev.deltaY * 0.0016);
    var newScale = Math.max(0.05, Math.min(40, state.view.scale * factor));
    state.view.scale = newScale;
    state.view.offsetX = mx - img[0] * newScale;
    state.view.offsetY = my - img[1] * newScale;
    state.view.fitted = false;
    updateZoomLabel();
    drawCanvas();
  }

  // ========================================================================
  // 导出
  // ========================================================================
  function updateExportUI() {
    var c = activeCase();
    var conflict = state.active >= 0 ? caseConflict(state.active) : { conflict: false };
    var ok = !!c && !c.error && c.solved && c.solved.result && c.solved.result.feasible && !conflict.conflict;
    $('btnExport').disabled = !ok;
    $('btnCopy').disabled = !ok;
    var note = $('exportNote');
    if (conflict.conflict) {
      note.textContent = '当前样本存在锁定冲突，已禁止下载上一版结果。解除冲突锁定后恢复。';
    } else if (c && c.error) {
      note.textContent = '样本错误，无法导出。';
    } else if (c && c.solved && c.solved.result && !c.solved.result.feasible) {
      note.textContent = '当前无可行铺法，无法导出。';
    } else if (ok) {
      note.textContent = '导出包含矩形、逐边决定与总损失的 JSON。';
    } else {
      note.textContent = '';
    }
  }

  function currentExport() {
    var c = activeCase();
    if (!c || !c.solved) return null;
    return Core.exportJSON({
      name: c.name, scan: c.scan, mask: c.mask, grid: c.grid,
      solved: c.solved, locks: state.locksByCase.get(state.active) || []
    });
  }

  function doExport() {
    if (state.active < 0 || caseConflict(state.active).conflict) { setStatus('bad', '存在锁定冲突，不能导出'); return; }
    var obj = currentExport();
    if (!obj) { setStatus('bad', '当前没有可导出的结果'); return; }
    var text = JSON.stringify(obj, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var safe = (activeCase().name || 'case').replace(/[^\w一-龥.-]+/g, '_');
    a.href = url;
    a.download = safe + '.merge-review.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('ok', '已导出 ' + a.download);
  }

  function doCopy() {
    if (state.active < 0 || caseConflict(state.active).conflict) { setStatus('bad', '存在锁定冲突，不能复制'); return; }
    var obj = currentExport();
    if (!obj) return;
    var text = JSON.stringify(obj, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('ok', '已复制 JSON 到剪贴板');
      }, function () {
        setStatus('bad', '剪贴板不可用');
      });
    } else {
      setStatus('bad', '剪贴板不可用');
    }
  }

  // ========================================================================
  // 状态与提示
  // ========================================================================
  function setStatus(kind, text) {
    var pill = $('statusPill');
    pill.className = 'pill' + (kind === 'busy' ? ' busy' : kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : '');
    var map = { busy: '处理中', bad: '错误', ok: '就绪', idle: '就绪' };
    pill.textContent = map[kind] || '就绪';
    $('statusText').textContent = text || '';
  }

  function banner(msg) {
    // 非冲突类总错误提示，复用一个行内 banner 放在样本概览上
    var el = $('importBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'importBanner';
      el.className = 'banner danger';
      el.hidden = true;
      var host = document.querySelector('.inspector');
      host.insertBefore(el, host.firstChild);
    }
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function formatNum(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('zh-CN');
  }

  // ========================================================================
  // 满额演示
  // ========================================================================
  function makeFullCase() {
    var R = 24, C = 8;
    var partW = 40, partH = 26, pad = 10;
    var W = pad * 2 + partW * C, H = pad * 2 + partH * R;
    var xs = [], ys = [];
    for (var c = 0; c <= C; c++) xs.push(pad + c * partW);
    for (var r = 0; r <= R; r++) ys.push(pad + r * partH);
    var seed = 20261125;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    // 先生成一个真值铺排：每格恰归一个矩形，供合成图像使用。
    var owner = new Int32Array(R * C).fill(-1);
    var rects = [];
    for (var rr = 0; rr < R; rr++) {
      for (var cc = 0; cc < C; cc++) {
        if (owner[rr * C + cc] >= 0) continue;
        var maxH = 1, maxW = 1;
        while (rr + maxH < R && owner[(rr + maxH) * C + cc] < 0) maxH++;
        while (cc + maxW < C && owner[rr * C + cc + maxW] < 0) maxW++;
        var hh = 1 + Math.floor(rnd() * Math.min(maxH, 4));
        var ww = 1 + Math.floor(rnd() * Math.min(maxW, 3));
        // 面积越大越少见
        if (hh * ww > 2 && rnd() < 0.45) { hh = 1; ww = 1 + Math.floor(rnd() * Math.min(maxW, 2)); }
        var id = rects.length;
        for (var y = rr; y < rr + hh; y++) {
          for (var x = cc; x < cc + ww; x++) owner[y * C + x] = id;
        }
        rects.push([rr, cc, rr + hh, cc + ww]);
      }
    }

    // 纸底：轻微网点噪声。
    var data = new Uint8Array(W * H);
    for (var p = 0; p < data.length; p++) data[p] = 243 + Math.floor(rnd() * 10);

    function put(x, y, v) {
      if (x >= 0 && x < W && y >= 0 && y < H) data[y * W + x] = v;
    }
    // 矩形之间画实墨线（不画端点，端点由相邻线交叉处自然补足）。
    for (var r3 = 0; r3 < R; r3++) {
      for (var c3 = 1; c3 < C; c3++) {
        var kept = owner[r3 * C + c3 - 1] !== owner[r3 * C + c3];
        var xl = xs[c3], yA = ys[r3] + 1, yB = ys[r3 + 1] - 1;
        for (var y2 = yA; y2 < yB; y2++) {
          if (kept) {
            if (rnd() < 0.035) { put(xl, y2, 244); continue; }  // 断墨
            put(xl, y2, 24 + Math.floor(rnd() * 16));
          } else {
            // 矩形内部：残留淡痕
            put(xl, y2, 198 + Math.floor(rnd() * 26));
          }
        }
      }
    }
    for (var r4 = 1; r4 < R; r4++) {
      for (var c4 = 0; c4 < C; c4++) {
        var keptH = owner[(r4 - 1) * C + c4] !== owner[r4 * C + c4];
        var yl = ys[r4], xA = xs[c4] + 1, xB = xs[c4 + 1] - 1;
        for (var x2 = xA; x2 < xB; x2++) {
          if (keptH) {
            if (rnd() < 0.035) { put(x2, yl, 244); continue; }
            put(x2, yl, 24 + Math.floor(rnd() * 16));
          } else {
            put(x2, yl, 198 + Math.floor(rnd() * 26));
          }
        }
      }
    }
    // 污点：少量深色斑点，可能落在纸面或淡痕上。
    for (var s = 0; s < 90; s++) {
      var sx = Math.floor(rnd() * W), sy = Math.floor(rnd() * H);
      var rad = 1 + Math.floor(rnd() * 2);
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          put(sx + dx, sy + dy, 60 + Math.floor(rnd() * 60));
        }
      }
    }
    // 外框画实。
    for (var x3 = 0; x3 < W; x3++) { put(x3, ys[0], 28); put(x3, ys[R], 28); }
    for (var y3 = 0; y3 < H; y3++) { put(xs[0], y3, 28); put(xs[C], y3, 28); }

    var grid = Core.parseGrid({ xs: xs, ys: ys, locks: [] });
    var scan = { width: W, height: H, maxval: 255, data: data };
    return { name: '满额 24×8', scan: scan, mask: null, grid: grid, error: null, _imgKey: 1, truth: rects };
  }

  function loadFull() {
    setStatus('busy', '正在生成满额表并求解…');
    setTimeout(function () {
      try {
        var c = makeFullCase();
        state.cases = [c];
        state.active = 0;
        state.locksByCase = new Map([[0, []]]);
        state.forceCache = new Map();
        state.selectedEdge = null;
        renderCaseTabs();
        solveCaseAt(0);
        var solveMs = c.solveMs;
        state.view.fitted = false;
        renderAll();
        fitView();
        renderCaseTabs();
        var res = c.solved.result;
        if (res.feasible) {
          setStatus('ok', '满额 24×8 求解完成：' + solveMs.toFixed(1) + ' ms（限 5 秒）');
        } else {
          setStatus('bad', '满额演示无可行铺法：' + reasonText(res.reason));
        }
      } catch (e) {
        setStatus('bad', e && e.message ? e.message : String(e));
      }
    }, 30);
  }

  // ========================================================================
  // 事件绑定
  // ========================================================================
  function bind() {
    $('fileInput').addEventListener('change', function (ev) {
      importFiles(ev.target.files);
      ev.target.value = '';
    });
    $('dirInput').addEventListener('change', function (ev) {
      importFiles(ev.target.files);
      ev.target.value = '';
    });
    $('btnSample').addEventListener('click', loadSample);
    $('btnFull').addEventListener('click', loadFull);
    $('btnFit').addEventListener('click', fitView);
    $('btnExport').addEventListener('click', doExport);
    $('btnCopy').addEventListener('click', doCopy);

    ['ovEdges', 'ovRects', 'ovGuides', 'ovMask', 'ovIndex'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (id === 'ovMask' && activeCase() && !activeCase().mask) {
          // 无掩膜时保持勾选也无副作用
        }
        drawCanvas();
      });
    });

    $('lockKeep').addEventListener('click', function () { applyLock(true); });
    $('lockRemove').addEventListener('click', function () { applyLock(false); });
    $('lockClear').addEventListener('click', function () {
      var sel = state.selectedEdge;
      if (!sel || state.active < 0) return;
      setLock(state.active, sel.axis, sel.row, sel.col, false, false);
      afterLockChange();
    });

    var stage = $('stage');
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', function () {
      state.dragging = false; state.dragMoved = false;
      stage.classList.remove('dragging');
    });
    stage.addEventListener('pointerleave', function () {
      if (!state.dragging) {
        state.hoverEdge = null;
        $('hoverTip').hidden = true;
        stage.classList.remove('pointing');
        drawCanvas();
      }
    });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', fitView);

    $('btnTheme').addEventListener('click', toggleTheme);
    window.addEventListener('resize', resizeCanvas);
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener &&
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCanvas);
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { state.selectedEdge = null; renderAll(); }
    });
  }

  function applyLock(keep) {
    var sel = state.selectedEdge;
    if (!sel || state.active < 0) return;
    var info = setLock(state.active, sel.axis, sel.row, sel.col, keep, true);
    afterLockChange();
  }

  function afterLockChange() {
    // 求解已完成（setLock 内），刷新所有面板
    renderAll();
    renderCaseTabs();
    updateExportUI();
    var conflicts = allConflicts();
    if (conflicts.length) {
      var first = conflicts[0];
      if (first.kind === 'direct' && first.ids.length) {
        setStatus('bad', '锁定冲突：' + first.ids.map(prettyEdgeId).join('、') + ' 同时锁定保留与去掉');
      } else {
        setStatus('bad', '锁定冲突：当前锁定无法拼出任何矩形铺法');
      }
    } else {
      var c = activeCase();
      var res = c && c.solved && c.solved.result;
      if (res && !res.feasible) setStatus('bad', '当前锁定下无可行铺法');
      else setStatus('ok', '锁定已更新并重新求解');
    }
  }

  function toggleTheme() {
    var root = document.documentElement;
    var cur = root.getAttribute('data-theme');
    var effective = cur || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.setAttribute('data-theme', effective === 'dark' ? 'light' : 'dark');
    // 缓存画布颜色无关，重绘即可
    drawCanvas();
  }

  // ========================================================================
  // 启动
  // ========================================================================
  function init() {
    bind();
    resizeCanvas();
    renderAll();
    setStatus('idle', '等待导入样本');
    // 支持 ?fixture=full / ?fixture=sample 便捷入口
    var params = new URLSearchParams(location.search);
    var fixture = params.get('fixture');
    if (fixture === 'full') loadFull();
    else if (fixture === 'sample') loadSample();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露少量调试接口，便于自动化测试
  window.__paperGrid = {
    state: state,
    loadSample: loadSample,
    loadFull: loadFull,
    selectEdge: selectEdge,
    setLock: setLock,
    applyLock: applyLock,
    afterLockChange: afterLockChange,
    forceQuery: computeForce,
    caseConflict: caseConflict,
    exportObj: currentExport,
    makeFullCase: makeFullCase
  };
})();
