// app.js — 分块重绘校验台界面逻辑
(function () {
  'use strict';
  var E = window.RTEngine;

  // ---------- 全局状态 ----------
  var state = {
    rawScene: null,        // 初始场景 JSON（用于整体重建）
    model: null,
    rt: null,
    fullBuf: null,         // 独立全量参考（每批后重算）
    selectedId: null,
    filterGroupId: null,   // 统计过滤的组
    queue: [],             // 待提交补丁
    history: [],           // [{patches, log, snapshot(模型深拷贝)}]
    historyIndex: -1,      // 当前指向的事务
    view: 'incremental',
    zoom: 1,
    showGrid: true,
    showDamage: true,
    showBoxes: false,
    probe: null,           // {x, y}
    collapsed: new Set(),
    drag: null,
    lastLog: null
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Toast ----------
  function toast(msg, kind) {
    var wrap = $('toast-wrap');
    while (wrap.children.length >= 3) wrap.firstChild.remove();
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.classList.add('toast-fade'); }, 2400);
    setTimeout(function () { el.remove(); }, 2750);
  }

  // ---------- 场景载入 ----------
  function loadScene(scene, sourceName) {
    try {
      var model = E.buildModel(scene);
      state.rawScene = JSON.parse(JSON.stringify(scene));
      state.model = model;
      state.rt = E.createRetained(model);
      var primeLog = E.prime(state.rt);
      state.fullBuf = E.fullRender(model);
      primeLog.diff = E.diffBuffers(state.rt.canvas, state.fullBuf);
      primeLog.costMs = 0;
      state.selectedId = null;
      state.filterGroupId = null;
      state.queue = [];
      state.history = [];
      state.historyIndex = -1;
      state.collapsed = new Set();
      state.probe = null;
      state.lastLog = primeLog;
      fitZoom();
      renderAll();
      var diff = E.diffBuffers(state.rt.canvas, state.fullBuf);
      toast((sourceName || '场景') + '已载入：' + model.nodes.size + ' 个节点，prime ' +
            primeLog.stats.recomputed + ' 瓦片，差异 ' + diff.count + ' 处',
            diff.count ? 'error' : 'ok');
    } catch (err) {
      toast('载入失败：' + err.message, 'error');
      throw err;
    }
  }

  // ---------- 场景序列化 / 重建 ----------
  // 把 live 模型还原成 buildModel 接受的场景树
  function serializeScene() {
    function nodeToJson(id) {
      var n = state.model.nodes.get(id);
      if (n.type === 'leaf') {
        return { id: n.id, box: n.box.slice(), rgba: n.rgba.slice() };
      }
      var j = {
        id: n.id,
        children: n.children.map(nodeToJson),
        r: n.r,
        opacity: n.opacity,
        clip: n.clip ? n.clip.slice() : null,
        offset: n.offset.slice()
      };
      return j;
    }
    return {
      size: state.model.size.slice(),
      tile: state.model.tile,
      root: nodeToJson(state.model.rootId)
    };
  }

  // 从场景 JSON 重建模型与保留渲染器
  function rebuildFromScene(scene) {
    var model = E.buildModel(scene);
    state.model = model;
    state.rt = E.createRetained(model);
    E.prime(state.rt);
    state.fullBuf = E.fullRender(model);
    state.probe = null;
  }

  // ---------- 事务应用 / 撤销 / 重做 ----------
  function commitBatch(patches, meta) {
    // 丢弃重做分支
    state.history = state.history.slice(0, state.historyIndex + 1);
    E.validatePatches(state.model, patches);
    var beforeScene = serializeScene();
    var t0 = performance.now();
    var log = E.applyBatch(state.rt, patches, meta || {});
    var ms = performance.now() - t0;
    log.costMs = Math.round(ms * 100) / 100;
    state.fullBuf = E.fullRender(state.model);
    log.diff = E.diffBuffers(state.rt.canvas, state.fullBuf);
    state.history.push({
      patches: JSON.parse(JSON.stringify(patches)),
      log: log,
      beforeScene: beforeScene
    });
    state.historyIndex++;
    state.lastLog = log;
    return log;
  }

  function undo() {
    if (state.historyIndex < 0) return;
    var item = state.history[state.historyIndex];
    rebuildFromScene(item.beforeScene);
    state.historyIndex--;
    state.lastLog = state.historyIndex >= 0 ? state.history[state.historyIndex].log : null;
    renderAll();
    toast('已撤销事务 #' + item.log.seq);
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    var item = state.history[state.historyIndex + 1];
    E.applyBatch(state.rt, item.patches, { replay: true });
    state.fullBuf = E.fullRender(state.model);
    state.historyIndex++;
    state.lastLog = item.log;
    renderAll();
    toast('已重做事务 #' + item.log.seq);
  }

  function jumpToHistory(target) {
    var item = state.history[target];
    // 先回到该事务之前，再重放它的补丁
    rebuildFromScene(item.beforeScene);
    E.applyBatch(state.rt, item.patches, { replay: true });
    state.fullBuf = E.fullRender(state.model);
    state.historyIndex = target;
    state.lastLog = item.log;
    renderAll();
  }

  // ---------- 图层树 ----------
  function renderTree() {
    var wrap = $('tree-wrap');
    wrap.innerHTML = '';
    if (!state.model) {
      wrap.innerHTML = '<div class="empty-hint">导入场景或载入样例后显示图层树</div>';
      $('node-count-chip').textContent = '0/128';
      return;
    }
    $('node-count-chip').textContent = state.model.nodes.size + '/128';
    var damagedIds = collectDamagedIds();
    var root = state.model.nodes.get(state.model.rootId);
    wrap.appendChild(buildTreeNode(root, 0, damagedIds));
  }

  function collectDamagedIds() {
    var set = new Set();
    if (state.lastLog && state.lastLog.recomputedTiles) {
      Object.keys(state.lastLog.recomputedTiles).forEach(function (id) { set.add(id); });
    }
    return set;
  }

  function buildTreeNode(node, depth, damagedIds) {
    var row = document.createElement('div');
    var isGroup = node.type === 'group';
    row.className = 'tree-node' + (state.selectedId === node.id ? ' is-selected' : '') +
                    (damagedIds.has(node.id) ? ' is-damaged' : '');
    row.style.paddingLeft = (6 + depth * 14) + 'px';

    var toggle = document.createElement('span');
    toggle.className = 'tree-toggle' + (isGroup ? '' : ' leaf');
    toggle.textContent = isGroup ? (state.collapsed.has(node.id) ? '▶' : '▼') : '·';
    if (isGroup) toggle.onclick = function (ev) {
      ev.stopPropagation();
      if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
      else state.collapsed.add(node.id);
      renderTree();
    };
    row.appendChild(toggle);

    var kind = document.createElement('span');
    kind.className = 'node-kind ' + (isGroup ? 'kind-group' : 'kind-leaf');
    kind.textContent = isGroup ? '组' : '叶';
    row.appendChild(kind);

    if (!isGroup) {
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = rgbaCss(node.rgba, false);
      row.appendChild(sw);
    }

    var idEl = document.createElement('span');
    idEl.className = 'node-id';
    idEl.textContent = node.id;
    row.appendChild(idEl);

    var meta = document.createElement('span');
    meta.className = 'node-meta';
    meta.textContent = isGroup
      ? ('r' + node.r + ' α' + fmt(node.opacity) + (node.clip ? ' 裁' : ''))
      : (node.box[2] + '×' + node.box[3]);
    row.appendChild(meta);

    row.onclick = function () { selectNode(node.id); };

    var container = document.createElement('div');
    container.appendChild(row);
    if (isGroup && !state.collapsed.has(node.id)) {
      node.children.forEach(function (cid) {
        container.appendChild(buildTreeNode(state.model.nodes.get(cid), depth + 1, damagedIds));
      });
    }
    return container;
  }

  function selectNode(id) {
    state.selectedId = id;
    renderTree();
    renderInspector();
  }

  // ---------- 检视器 ----------
  function renderInspector() {
    var body = $('inspector-body');
    if (!state.model || !state.selectedId) {
      body.innerHTML = '<div class="empty-hint">在图层树或画布中点选一个组节点</div>';
      return;
    }
    var n = state.model.nodes.get(state.selectedId);
    var html = '<div class="insp-meta">';
    html += pill(n.type === 'group' ? '组节点' : '叶子节点');
    html += pill('id: ' + n.id);
    if (n.parentId) html += pill('父: ' + n.parentId);
    html += '</div>';

    if (n.type === 'leaf') {
      html +=
        '<div class="form-grid">' +
          field('box.x', n.box[0], 'leaf-box-0', true) +
          field('box.y', n.box[1], 'leaf-box-1', true) +
          field('box.w', n.box[2], 'leaf-box-2', true) +
          field('box.h', n.box[3], 'leaf-box-3', true) +
          rgbaFields(n.rgba) +
        '</div>' +
        '<div class="insp-actions">' +
          btn('id="btn-leaf-apply" class="btn btn-primary"', '加入叶子修改') +
        '</div>';
    } else {
      var isRoot = n.parentId === null;
      html += '<div class="form-grid">' +
        field('offset.dx', n.offset[0], 'off-0', isRoot) +
        field('offset.dy', n.offset[1], 'off-1', isRoot) +
        field('模糊半径 r (0-8)', n.r, 'r', false) +
        field('透明度 opacity', n.opacity, 'opacity', false) +
        clipFields(n.clip) +
      '</div>';
      // 同组顺序
      html += '<div class="order-row"><div class="form-field label">同组顺序（底→顶）</div>';
      n.children.forEach(function (cid, i) {
        var ch = state.model.nodes.get(cid);
        html += '<div class="order-item">' +
          '<span class="ord-idx">' + i + '</span>' +
          '<span class="ord-name">' + cid + '</span>' +
          '<button type="button" data-order-up="' + i + '" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
          '<button type="button" data-order-down="' + i + '" ' + (i === n.children.length - 1 ? 'disabled' : '') + '>↓</button>' +
        '</div>';
      });
      html += '</div>';
      html += '<div class="insp-actions">' +
        btn('id="btn-add-offset" class="btn btn-ghost"', '加入平移') +
        btn('id="btn-add-clip" class="btn btn-ghost"', '加入裁框') +
        btn('id="btn-add-opacity" class="btn btn-ghost"', '加入透明度') +
        btn('id="btn-add-r" class="btn btn-ghost"', '加入模糊半径') +
      '</div>';
    }
    body.innerHTML = html;
    bindInspector(n);
  }

  function pill(t) { return '<span class="meta-pill">' + t + '</span>'; }
  function btn(attrs, t) { return '<button type="button" ' + attrs + '>' + t + '</button>'; }
  function field(label, val, id, disabled) {
    return '<div class="form-field"><label>' + label + '</label>' +
      '<input id="' + id + '" value="' + val + '" ' + (disabled ? 'disabled' : '') +
      ' inputmode="decimal"></div>';
  }
  function clipFields(clip) {
    if (!clip) {
      return '<div class="form-field full"><label>裁框（勾选启用并填写 x,y,w,h）</label></div>' +
        '<div class="form-field"><label>启用裁框</label>' +
        '<input type="checkbox" id="clip-enable" style="width:auto"></div>' +
        '<div class="form-field"><label>clip.x</label><input id="clip-0" value="0" disabled></div>' +
        '<div class="form-field"><label>clip.y</label><input id="clip-1" value="0" disabled></div>' +
        '<div class="form-field"><label>clip.w</label><input id="clip-2" value="16" disabled></div>' +
        '<div class="form-field"><label>clip.h</label><input id="clip-3" value="16" disabled></div>';
    }
    return '<div class="form-field"><label>clip.x</label><input id="clip-0" value="' + clip[0] + '"></div>' +
      '<div class="form-field"><label>clip.y</label><input id="clip-1" value="' + clip[1] + '"></div>' +
      '<div class="form-field"><label>clip.w</label><input id="clip-2" value="' + clip[2] + '"></div>' +
      '<div class="form-field"><label>clip.h</label><input id="clip-3" value="' + clip[3] + '"></div>' +
      '<div class="form-field full"><label>清除裁框</label>' +
      '<input type="checkbox" id="clip-clear" style="width:auto"></div>';
  }
  function rgbaFields(rgba) {
    return field('rgba.r', rgba[0], 'rgba-0', false) +
      field('rgba.g', rgba[1], 'rgba-1', false) +
      field('rgba.b', rgba[2], 'rgba-2', false) +
      field('rgba.a', rgba[3], 'rgba-3', false);
  }

  function bindInspector(n) {
    if (n.type === 'leaf') {
      $('btn-leaf-apply').onclick = function () {
        var patch = { id: n.id };
        var box = [0, 1, 2, 3].map(function (i) { return parseInt($('leaf-box-' + i).value, 10); });
        var rgba = [0, 1, 2, 3].map(function (i) { return parseFloat($('rgba-' + i).value); });
        if (JSON.stringify(box) !== JSON.stringify(n.box)) patch.box = box;
        if (JSON.stringify(rgba) !== JSON.stringify(n.rgba)) patch.rgba = rgba;
        if (Object.keys(patch).length === 1) return toast('没有改动', 'error');
        enqueue(patch);
      };
      return;
    }
    $('btn-add-offset').onclick = function () {
      var dx = parseInt($('off-0').value, 10), dy = parseInt($('off-1').value, 10);
      if (dx === n.offset[0] && dy === n.offset[1]) return toast('平移未改变', 'error');
      enqueue({ id: n.id, offset: [dx, dy] });
    };
    $('btn-add-clip').onclick = function () {
      if ($('clip-clear') && $('clip-clear').checked) {
        enqueue({ id: n.id, clip: null });
        return;
      }
      if ($('clip-enable') && !$('clip-enable').checked) {
        return toast('先勾选启用裁框', 'error');
      }
      enqueue({ id: n.id, clip: [0, 1, 2, 3].map(function (i) {
        return parseInt($('clip-' + i).value, 10);
      }) });
    };
    var enable = $('clip-enable');
    if (enable) enable.onchange = function () {
      [0, 1, 2, 3].forEach(function (i) { $('clip-' + i).disabled = !enable.checked; });
    };
    $('btn-add-opacity').onclick = function () {
      var v = parseFloat($('opacity').value);
      if (v === n.opacity) return toast('透明度未改变', 'error');
      enqueue({ id: n.id, opacity: v });
    };
    $('btn-add-r').onclick = function () {
      var v = parseInt($('r').value, 10);
      if (v === n.r) return toast('模糊半径未改变', 'error');
      enqueue({ id: n.id, r: v });
    };
    bodyOrderButtons(n);
  }

  function bodyOrderButtons(n) {
    var ups = document.querySelectorAll('[data-order-up]');
    Array.prototype.forEach.call(ups, function (b) {
      b.onclick = function () {
        var i = parseInt(b.getAttribute('data-order-up'), 10);
        var order = n.children.slice();
        var tmp = order[i - 1]; order[i - 1] = order[i]; order[i] = tmp;
        enqueue({ id: n.id, children: order });
      };
    });
    var downs = document.querySelectorAll('[data-order-down]');
    Array.prototype.forEach.call(downs, function (b) {
      b.onclick = function () {
        var i = parseInt(b.getAttribute('data-order-down'), 10);
        var order = n.children.slice();
        var tmp = order[i + 1]; order[i + 1] = order[i]; order[i] = tmp;
        enqueue({ id: n.id, children: order });
      };
    });
  }

  // ---------- 批次队列 ----------
  function enqueue(patch) {
    try {
      E.validatePatches(state.model, [patch]);
    } catch (err) {
      toast('补丁无效：' + err.message, 'error');
      return;
    }
    state.queue.push(patch);
    renderQueue();
    toast('已加入批次：' + patch.id, 'ok');
  }

  function renderQueue() {
    var el = $('queue-list');
    $('queue-count').textContent = state.queue.length + ' 个补丁';
    $('btn-apply-batch').disabled = state.queue.length === 0;
    $('btn-clear-queue').disabled = state.queue.length === 0;
    if (!state.queue.length) {
      el.innerHTML = '<div class="empty-hint small">把编辑加入队列，成批提交为一次重绘事务</div>';
      return;
    }
    el.innerHTML = '';
    state.queue.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'queue-item';
      row.innerHTML = '<span class="q-target">' + p.id + '</span>' +
        '<span class="q-desc">' + describePatch(p) + '</span>' +
        '<button type="button" aria-label="移除">✕</button>';
      row.querySelector('button').onclick = function () {
        state.queue.splice(i, 1);
        renderQueue();
      };
      el.appendChild(row);
    });
  }

  function describePatch(p) {
    var parts = [];
    if ('offset' in p) parts.push('offset=[' + p.offset.join(',') + ']');
    if ('clip' in p) parts.push('clip=' + (p.clip ? '[' + p.clip.join(',') + ']' : 'null'));
    if ('opacity' in p) parts.push('opacity=' + p.opacity);
    if ('r' in p) parts.push('r=' + p.r);
    if ('children' in p) parts.push('order=[' + p.children.join('≺') + ']');
    if ('box' in p) parts.push('box=[' + p.box.join(',') + ']');
    if ('rgba' in p) parts.push('rgba=[' + p.rgba.map(fmt).join(',') + ']');
    return parts.join(' ');
  }

  // ---------- 时间线 ----------
  function renderTimeline() {
    var el = $('timeline');
    $('btn-undo').disabled = state.historyIndex < 0;
    $('btn-redo').disabled = state.historyIndex >= state.history.length - 1;
    if (!state.history.length) {
      el.innerHTML = '<div class="empty-hint small">尚无重绘事务</div>';
      return;
    }
    el.innerHTML = '';
    state.history.forEach(function (item, i) {
      var row = document.createElement('div');
      row.className = 'tl-item' + (i === state.historyIndex ? ' is-current' : '');
      var log = item.log;
      var diffBadge = log.diff && log.diff.count
        ? '<span class="tl-badge badge-diff">差异 ' + log.diff.count + '</span>'
        : '<span class="tl-badge badge-ok">逐像素一致</span>';
      row.innerHTML =
        '<div class="tl-head">' +
          '<span class="tl-seq">#' + log.seq + '</span>' +
          '<span class="tl-title">' + (log.meta.label || ('批次 ' + log.seq)) + '</span>' +
          '<span class="tl-stats">' + log.stats.recomputed + ' 瓦 · ' + log.costMs + 'ms</span>' +
        '</div>' +
        '<div class="tl-desc">' + item.patches.map(describePatch).join(' ｜ ') + '</div>' +
        '<div class="tl-badges">' + diffBadge + '</div>';
      row.onclick = function () { jumpToHistory(i); };
      el.appendChild(row);
    });
    el.scrollTop = el.scrollHeight;
  }

  // ---------- 统计 ----------
  function renderStats() {
    var log = state.lastLog;
    if (!log) return;
    $('num-damaged').textContent = log.stats.damaged;
    $('num-recomputed').textContent = log.stats.recomputed;
    $('num-reused').textContent = log.stats.reused;
    var wrap = $('group-stats');
    wrap.innerHTML = '';
    var groups = [];
    state.model.nodes.forEach(function (n) {
      if (n.type !== 'group') return;
      var recomputed = (log.recomputedTiles[n.id] || []).length;
      var damaged = (log.damagedTiles[n.id] || []).length;
      var cacheSize = state.rt.caches.has(n.id) ? state.rt.caches.get(n.id).size : 0;
      groups.push({ id: n.id, recomputed: recomputed, damaged: damaged, cache: cacheSize });
    });
    groups.sort(function (a, b) { return b.recomputed - a.recomputed; });
    groups.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'gstat-row' + (state.filterGroupId === g.id ? ' is-filtered' : '');
      row.innerHTML =
        '<span class="gstat-name" title="' + g.id + '">' + g.id + '</span>' +
        '<span class="gstat-num gstat-damaged">' + g.damaged + '</span>' +
        '<span class="gstat-num gstat-recompute">' + g.recomputed + '</span>' +
        '<span class="gstat-num gstat-reuse">' + (g.cache - g.recomputed) + '</span>';
      row.onclick = function () {
        state.filterGroupId = state.filterGroupId === g.id ? null : g.id;
        $('stat-group-chip').textContent = state.filterGroupId || '全部组';
        renderStats();
        drawOverlay();
      };
      wrap.appendChild(row);
    });
  }

  // ---------- 画布 ----------
  var canvas = $('canvas-view'), overlay = $('overlay-view');
  var ctx = canvas.getContext('2d'), octx = overlay.getContext('2d');

  function fitZoom() {
    if (!state.model) return;
    var stage = $('canvas-stage');
    var pad = 40;
    var zx = (stage.clientWidth - pad) / state.model.size[0];
    var zy = (stage.clientHeight - pad) / state.model.size[1];
    state.zoom = Math.max(1, Math.floor(Math.min(zx, zy) * 4) / 4);
    updateZoomLabel();
  }
  function updateZoomLabel() { $('zoom-label').textContent = Math.round(state.zoom * 100) + '%'; }

  function renderCanvas() {
    if (!state.model) return;
    var W = state.model.size[0], H = state.model.size[1];
    var z = state.zoom;
    canvas.width = W; canvas.height = H;
    overlay.width = W; overlay.height = H;
    canvas.style.width = overlay.style.width = W * z + 'px';
    canvas.style.height = overlay.style.height = H * z + 'px';

    var buf;
    if (state.view === 'full') buf = state.fullBuf;
    else buf = state.rt.canvas;
    var bytes = E.toSrgbBytes(buf);
    var img = new ImageData(new Uint8ClampedArray(bytes), W, H);
    ctx.putImageData(img, 0, 0);

    if (state.view === 'diff') drawDiff();
    drawOverlay();
  }

  function drawDiff() {
    var W = state.model.size[0], H = state.model.size[1];
    var d = E.diffBuffers(state.rt.canvas, state.fullBuf);
    var img = ctx.createImageData(W, H);
    // 深色底 + 差异像素高亮
    for (var i = 0; i < W * H; i++) {
      img.data[i * 4] = 18; img.data[i * 4 + 1] = 22; img.data[i * 4 + 2] = 30;
      img.data[i * 4 + 3] = 255;
    }
    var tol = 2e-3;
    for (var p = 0; p < W * H; p++) {
      var m = maxChannelDiff(state.rt.canvas, state.fullBuf, p);
      if (m > tol) {
        var heat = Math.min(1, m * 4);
        img.data[p * 4] = Math.round(112 + heat * 120);
        img.data[p * 4 + 1] = Math.round(72 - heat * 40);
        img.data[p * 4 + 2] = Math.round(232 - heat * 60);
        img.data[p * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function maxChannelDiff(a, b, p) {
    return Math.max(
      Math.abs(a[p * 4] - b[p * 4]),
      Math.abs(a[p * 4 + 1] - b[p * 4 + 1]),
      Math.abs(a[p * 4 + 2] - b[p * 4 + 2]),
      Math.abs(a[p * 4 + 3] - b[p * 4 + 3]));
  }

  function drawOverlay() {
    if (!state.model) return;
    var W = state.model.size[0], H = state.model.size[1];
    octx.clearRect(0, 0, W, H);
    var tile = state.model.tile;

    if (state.showGrid) {
      octx.strokeStyle = rgbaVar('--border-strong', .55);
      octx.lineWidth = 1 / state.zoom;
      octx.beginPath();
      for (var x = tile; x < W; x += tile) { octx.moveTo(x, 0); octx.lineTo(x, H); }
      for (var y = tile; y < H; y += tile) { octx.moveTo(0, y); octx.lineTo(W, y); }
      octx.stroke();
    }

    if (state.view === 'tiles') {
      // 重算瓦片（按过滤组或全部）
      var log = state.lastLog;
      state.rt.caches.forEach(function (cache, groupId) {
        if (state.filterGroupId && groupId !== state.filterGroupId) return;
        var recomputed = new Set((log && log.recomputedTiles[groupId]) || []);
        cache.forEach(function (entry, key) {
          var p = key.split(',').map(Number);
          var tx = p[0], ty = p[1];
          var tb = [tx * tile, ty * tile, tile, tile];
          if (tb[0] >= W || tb[1] >= H || tb[0] + tile <= 0 || tb[1] + tile <= 0) return;
          if (recomputed.has(key)) {
            octx.fillStyle = rgbaVar('--recompute', .38);
            octx.fillRect(tb[0], tb[1], tile, tile);
            octx.strokeStyle = rgbaVar('--recompute', .9);
          } else if (entry.valid) {
            octx.fillStyle = rgbaVar('--reuse', .14);
            octx.fillRect(tb[0], tb[1], tile, tile);
            octx.strokeStyle = rgbaVar('--reuse', .55);
          } else {
            return;
          }
          octx.lineWidth = 1 / state.zoom;
          octx.strokeRect(tb[0] + .5 / state.zoom, tb[1] + .5 / state.zoom,
                          tile - 1 / state.zoom, tile - 1 / state.zoom);
        });
      });
    }

    // 脏区描边（旧+新位置的并集矩形）
    if (state.showDamage && state.rt.rootDamage) {
      var rd = state.rt.rootDamage;
      octx.strokeStyle = rgbaVar('--damage', .95);
      octx.lineWidth = 2 / state.zoom;
      octx.setLineDash([6 / state.zoom, 4 / state.zoom]);
      octx.strokeRect(rd[0], rd[1], rd[2], rd[3]);
      octx.setLineDash([]);
    }

    // 节点包围盒
    if (state.showBoxes) {
      state.model.nodes.forEach(function (n) {
        var box = E.outputBox(state.model, n);
        if (!box) return;
        var placed = n.type === 'group' && n.offset
          ? E.rect.translate(box, n.offset[0], n.offset[1]) : box;
        if (n.parentId === null) return;
        octx.strokeStyle = n.id === state.selectedId ? rgbaVar('--accent', .95) : rgbaVar('--fg-faint', .7);
        octx.lineWidth = (n.id === state.selectedId ? 2 : 1) / state.zoom;
        octx.strokeRect(placed[0] + .5, placed[1] + .5, placed[2] - 1, placed[3] - 1);
      });
    }

    // 选中高亮
    if (state.selectedId) {
      var sn = state.model.nodes.get(state.selectedId);
      if (sn && sn.type === 'group') {
        var sb = groupCanvasBox(sn);
        if (sb) {
          octx.strokeStyle = rgbaVar('--accent', 1);
          octx.lineWidth = 2 / state.zoom;
          octx.strokeRect(sb[0], sb[1], sb[2], sb[3]);
        }
      }
    }

    // 探针十字
    if (state.probe) {
      var px = state.probe.x, py = state.probe.y;
      octx.strokeStyle = rgbaVar('--fg', .85);
      octx.lineWidth = 1 / state.zoom;
      octx.beginPath();
      octx.moveTo(px + .5, 0); octx.lineTo(px + .5, H);
      octx.moveTo(0, py + .5); octx.lineTo(W, py + .5);
      octx.stroke();
      octx.strokeStyle = rgbaVar('--accent', 1);
      octx.strokeRect(px, py, 1, 1);
    }
  }

  // 组在画布坐标中的盒（沿祖先 offset 累加）
  function groupCanvasBox(n) {
    var box = E.outputBox(state.model, n);
    var cur = n;
    while (cur && cur.parentId !== null) {
      box = E.rect.translate(box, cur.offset[0], cur.offset[1]);
      cur = state.model.nodes.get(cur.parentId);
    }
    return box;
  }

  function rgbaVar(token, alpha) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (v.startsWith('#')) return hexToRgba(v, alpha);
    return v;
  }
  function hexToRgba(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function rgbaCss(rgba, linear) {
    var v = rgba;
    if (linear) v = rgba.map(function (c, i) { return i < 3 ? E.linToSrgb(c) : c; });
    return 'rgba(' + Math.round(v[0] * 255) + ',' + Math.round(v[1] * 255) + ',' +
           Math.round(v[2] * 255) + ',' + v[3] + ')';
  }
  function fmt(v) { return (Math.round(v * 1000) / 1000).toString(); }

  // ---------- 像素探针 ----------
  function renderProbe() {
    var head = $('probe-head'), wrap = $('probe-table-wrap');
    if (!state.probe) {
      head.innerHTML = '<div class="empty-hint small">在画布上单击任意像素</div>';
      wrap.hidden = true;
      return;
    }
    var x = state.probe.x, y = state.probe.y;
    var chain = E.probePixel(state.model, x, y);
    var canvasIdx = (y * state.model.size[0] + x) * 4;
    var cv = Array.from(state.rt.canvas.slice(canvasIdx, canvasIdx + 4));
    var fv = state.fullBuf ? Array.from(state.fullBuf.slice(canvasIdx, canvasIdx + 4)) : null;
    head.innerHTML = '<div>画布像素 <b>(' + x + ', ' + y + ')</b></div>' +
      '<div style="margin-top:4px">增量预乘: ' + cv.map(fmt4).join(', ') + '</div>' +
      (fv ? '<div>全量预乘: ' + fv.map(fmt4).join(', ') + '</div>' : '');
    var html = '<div class="probe-section-title">沿祖先链各组输出（线性）</div>';
    html += '<table class="probe-table"><thead><tr><th>节点</th><th>R</th><th>G</th><th>B</th><th>A</th></tr></thead><tbody>';
    chain.forEach(function (item) {
      var v = item.premult;
      var sw = rgbaCss([
        v[3] > 0 ? v[0] / v[3] : 0,
        v[3] > 0 ? v[1] / v[3] : 0,
        v[3] > 0 ? v[2] / v[3] : 0, v[3]
      ], true);
      html += '<tr><td><span class="probe-swatch" style="background:' + sw + '"></span>' +
        '<span class="probe-type ' + (item.type === 'group' ? 'kind-group' : 'kind-leaf') + '">' +
        (item.type === 'group' ? '组' : '叶') + '</span>' + item.id +
        '<div style="color:var(--fg-faint)">局部 (' + item.x + ',' + item.y + ')</div></td>' +
        '<td>' + fmt4(v[0]) + '</td><td>' + fmt4(v[1]) + '</td><td>' + fmt4(v[2]) + '</td><td>' + fmt4(v[3]) + '</td></tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.hidden = false;
  }
  function fmt4(v) { return (Math.round(v * 10000) / 10000).toFixed(4); }

  // ---------- 状态栏 ----------
  function renderStatus() {
    if (!state.model) return;
    $('st-scene').textContent = '画布 ' + state.model.size[0] + '×' + state.model.size[1];
    $('st-nodes').textContent = state.model.nodes.size + ' 节点';
    $('st-tile').textContent = '瓦片 ' + state.model.tile + 'px（' +
      (state.model.size[0] / state.model.tile) + '×' +
      (state.model.size[1] / state.model.tile) + '）';
    $('st-seq').textContent = '事务 #' + state.historyIndex + '/' + state.history.length;
    var diffEl = $('st-diff');
    if (state.lastLog && state.lastLog.diff) {
      diffEl.hidden = false;
      var d = state.lastLog.diff;
      diffEl.textContent = d.count === 0
        ? '✓ 增量与全量逐像素一致（max ' + d.maxAbs.toExponential(1) + '）'
        : '✗ 差异 ' + d.count + ' 像素，max=' + d.maxAbs.toExponential(2);
      diffEl.className = 'status-item ' + (d.count === 0 ? 'status-good' : 'status-bad');
    }
    $('st-perf').textContent = state.lastLog && state.lastLog.costMs != null
      ? '重绘 ' + state.lastLog.costMs + 'ms' : '';
  }

  // ---------- 画布交互：点击探针 / 拖拽平移 ----------
  function eventToCanvas(ev) {
    var rect = canvas.getBoundingClientRect();
    var x = Math.floor((ev.clientX - rect.left) / state.zoom);
    var y = Math.floor((ev.clientY - rect.top) / state.zoom);
    return [x, y];
  }

  function findGroupAt(x, y) {
    // 自顶向下找最深的、画布盒包含点的组
    var hits = [];
    state.model.nodes.forEach(function (n) {
      if (n.type !== 'group' || n.parentId === null) return;
      var box = groupCanvasBox(n);
      if (box && x >= box[0] && y >= box[1] && x < box[0] + box[2] && y < box[1] + box[3]) {
        hits.push(n);
      }
    });
    hits.sort(function (a, b) { return b.depth - a.depth; });
    return hits[0] || null;
  }

  canvas.parentElement.addEventListener('mousedown', function (ev) {
    if (!state.model || ev.button !== 0) return;
    var p = eventToCanvas(ev);
    var g = findGroupAt(p[0], p[1]);
    state.drag = {
      groupId: g ? g.id : null,
      clickX: p[0], clickY: p[1],
      startX: ev.clientX, startY: ev.clientY,
      origOffset: g ? g.offset.slice() : null,
      beforeScene: g ? serializeScene() : null,
      moved: false
    };
    if (g) {
      canvas.parentElement.classList.add('dragging');
      selectNode(g.id);
    }
  });

  window.addEventListener('mousemove', function (ev) {
    if (!state.drag || !state.drag.groupId) return;
    if (!state.drag.moved && Math.abs(ev.clientX - state.drag.startX) < 4 &&
        Math.abs(ev.clientY - state.drag.startY) < 4) return;
    state.drag.moved = true;
    var dx = Math.round((ev.clientX - state.drag.startX) / state.zoom);
    var dy = Math.round((ev.clientY - state.drag.startY) / state.zoom);
    // 实时预览：从拖拽前场景重建，应用当前 offset（保证旧位置被正确覆盖）
    var scene = state.drag.beforeScene;
    var g0 = findNodeInScene(scene.root, state.drag.groupId);
    var newOffset = [state.drag.origOffset[0] + dx, state.drag.origOffset[1] + dy];
    g0.offset = newOffset;
    rebuildFromScene(scene);
    liveDragUpdate(state.drag.groupId, newOffset);
  });

  function findNodeInScene(node, id) {
    if (node.id === id) return node;
    if (!node.children) return null;
    for (var i = 0; i < node.children.length; i++) {
      var f = findNodeInScene(node.children[i], id);
      if (f) return f;
    }
    return null;
  }

  window.addEventListener('mouseup', function () {
    if (!state.drag) return;
    var d = state.drag;
    state.drag = null;
    canvas.parentElement.classList.remove('dragging');
    // 纯点击（无论是否点在组上）= 像素探针
    if (!d.moved || !d.groupId) {
      state.probe = { x: d.clickX, y: d.clickY };
      renderProbe();
      drawOverlay();
      return;
    }
    var finalOffset = state.model.nodes.get(d.groupId).offset.slice();
    // 回到拖拽前场景，以一个正式事务提交最终 offset
    rebuildFromScene(d.beforeScene);
    var log = commitBatch([{ id: d.groupId, offset: finalOffset }],
                          { label: '拖拽平移 ' + d.groupId });
    renderAll();
    if (log.diff.count) toast('拖拽后出现 ' + log.diff.count + ' 处差异', 'error');
    else toast('拖拽已提交为事务 #' + log.seq, 'ok');
  });

  function liveDragUpdate(groupId, offset) {
    state.lastLog = {
      seq: state.history.length + 1, meta: { label: '拖拽预览（未提交）' },
      patches: [{ id: groupId, offset: offset }],
      damagedTiles: {}, recomputedTiles: {}, rootDamage: null,
      stats: { damaged: 0, recomputed: 0, reused: 0 },
      diff: E.diffBuffers(state.rt.canvas, state.fullBuf), costMs: 0
    };
    renderCanvas();
    renderStats();
    renderStatus();
  }

  // ---------- 导出 ----------
  function exportPng() {
    if (!state.model) return toast('先载入场景', 'error');
    var W = state.model.size[0], H = state.model.size[1];
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cctx = c.getContext('2d');
    var bytes = E.toSrgbBytes(state.rt.canvas);
    cctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), W, H), 0, 0);
    c.toBlob(function (blob) {
      downloadBlob(blob, 'retained-composite-' + Date.now() + '.png');
      toast('PNG 已导出（sRGB 编码）', 'ok');
    }, 'image/png');
  }

  function exportLog() {
    if (!state.history.length) return toast('暂无重绘日志', 'error');
    var payload = {
      scene: state.rawScene,
      canvas: { width: state.model.size[0], height: state.model.size[1], tile: state.model.tile },
      transactions: state.history.map(function (item) {
        var log = item.log;
        return {
          seq: log.seq,
          meta: log.meta,
          patches: item.patches,
          rootDamage: log.rootDamage,
          damagedTiles: log.damagedTiles,
          recomputedTiles: log.recomputedTiles,
          stats: log.stats,
          costMs: log.costMs,
          diff: { count: log.diff.count, maxAbs: log.diff.maxAbs,
                  firstPixels: log.diff.pixels.slice(0, 20) }
        };
      })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'repaint-log-' + Date.now() + '.json');
    toast('重绘日志已导出', 'ok');
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  // ---------- 总渲染 ----------
  function renderAll() {
    renderTree();
    renderInspector();
    renderQueue();
    renderTimeline();
    renderStats();
    renderCanvas();
    renderProbe();
    renderStatus();
  }

  // ---------- 事件绑定 ----------
  $('file-input').addEventListener('change', function (ev) {
    var f = ev.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var json = JSON.parse(reader.result);
        loadScene(json, f.name);
      } catch (err) {
        toast('JSON 解析失败：' + err.message, 'error');
      }
    };
    reader.readAsText(f);
    ev.target.value = '';
  });

  $('btn-load-sample').onclick = function () {
    fetch('samples/retained-tile-cases.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) { loadScene(json, '样例 '); })
      .catch(function () {
        // 本地 file:// 协议下 fetch 可能失败，尝试内嵌兜底数据
        if (window.EMBEDDED_SAMPLE) loadScene(window.EMBEDDED_SAMPLE, '内嵌样例 ');
        else toast('无法读取样例文件，请用“导入场景”手动选择', 'error');
      });
  };

  $('btn-export-png').onclick = exportPng;
  $('btn-export-log').onclick = exportLog;
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  $('btn-apply-batch').onclick = function () {
    if (!state.queue.length) return;
    var patches = state.queue;
    try {
      var log = commitBatch(patches, { label: '批次 ' + (state.historyIndex + 2) });
      state.queue = [];
      renderAll();
      toast(log.diff.count
        ? '批次已应用，但发现 ' + log.diff.count + ' 处差异'
        : '批次已应用，' + log.stats.recomputed + ' 瓦片重算，逐像素一致',
        log.diff.count ? 'error' : 'ok');
    } catch (err) {
      toast('批次失败：' + err.message, 'error');
    }
  };
  $('btn-clear-queue').onclick = function () { state.queue = []; renderQueue(); };

  $('btn-replay-sample').onclick = function () {
    if (!state.rawScene || !state.rawScene.edits) return toast('当前场景没有内置编辑序列', 'error');
    var edits = state.rawScene.edits;
    var next = state.history.length;
    if (next >= edits.length) return toast('样例编辑已全部回放', 'error');
    try {
      var log = commitBatch(edits[next], { label: '样例批次 ' + (next + 1) });
      renderAll();
      toast('回放样例批次 ' + (next + 1) + '，重算 ' + log.stats.recomputed + ' 瓦片',
            log.diff.count ? 'error' : 'ok');
    } catch (err) {
      toast('回放失败：' + err.message, 'error');
    }
  };

  document.querySelectorAll('.view-opt').forEach(function (b) {
    b.onclick = function () {
      state.view = b.getAttribute('data-view');
      document.querySelectorAll('.view-opt').forEach(function (x) { x.classList.toggle('is-active', x === b); });
      renderCanvas();
    };
  });
  $('chk-grid').onchange = function (ev) { state.showGrid = ev.target.checked; drawOverlay(); };
  $('chk-damage').onchange = function (ev) { state.showDamage = ev.target.checked; drawOverlay(); };
  $('chk-boxes').onchange = function (ev) { state.showBoxes = ev.target.checked; drawOverlay(); };
  $('zoom-in').onclick = function () { state.zoom = Math.min(16, state.zoom * 1.25); updateZoomLabel(); renderCanvas(); };
  $('zoom-out').onclick = function () { state.zoom = Math.max(.25, state.zoom / 1.25); updateZoomLabel(); renderCanvas(); };
  $('zoom-fit').onclick = function () { fitZoom(); renderCanvas(); };

  document.querySelectorAll('.theme-opt').forEach(function (b) {
    b.onclick = function () {
      var v = b.getAttribute('data-theme-v');
      document.documentElement.setAttribute('data-theme', v);
      document.querySelectorAll('.theme-opt').forEach(function (x) {
        x.classList.toggle('is-active', x === b);
      });
      drawOverlay();
    };
  });

  window.addEventListener('resize', function () { if (state.model) drawOverlay(); });

  // 初始：尝试自动载入样例（artifact / http 发布后相对路径可用；
  // file:// 协议下 fetch 被浏览器禁止，直接跳过、等待手动导入）
  if (location.protocol !== 'file:') {
    fetch('samples/retained-tile-cases.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        window.EMBEDDED_SAMPLE = json;
        loadScene(json, '样例 ');
      })
      .catch(function () { /* 样例缺失时等待手动导入 */ });
  }
})();
