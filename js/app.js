/* Lightmap Mask Packer 页面应用 */
(function () {
  'use strict';
  var L = window.LMP;

  // ---------- 应用状态 ----------
  var state = {
    parsed: null,            // LMP.parseInput 结果
    rawInput: null,          // 原始 JSON（用于重新解析与导出）
    placements: {},          // id -> {x,y,rotation}（含手动放置）
    locked: {},              // id -> bool（界面锁定状态，初始取自输入）
    selectedId: null,
    cell: 24,                // 画布每格像素
    showPadding: true,
    showGrid: true,
    drag: null,              // 拖拽上下文
    hoverCell: null,
    messageSeq: 0
  };

  var $ = function (id) { return document.getElementById(id); };
  var atlasCanvas = $('atlas');
  var ctx = atlasCanvas.getContext('2d');

  // ---------- 工具 ----------
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function addMessage(kind, title, detail) {
    var box = $('messages');
    var seq = ++state.messageSeq;
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    var html = '<div class="title">[' + seq + '] ' + escapeHtml(title) + '</div>';
    if (detail) html += '<div class="cells">' + escapeHtml(detail) + '</div>';
    div.innerHTML = html;
    box.prepend(div);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function download(filename, text, mime) {
    // 沙盒里 <a download> 可能失效：同时提供模态查看与复制
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function chartById(id) {
    if (!state.parsed) return null;
    for (var i = 0; i < state.parsed.charts.length; i++)
      if (state.parsed.charts[i].id === id) return state.parsed.charts[i];
    return null;
  }
  function currentVariant(chart) {
    var pl = state.placements[chart.id];
    var rot = pl ? pl.rotation : 0;
    return L.buildVariant(chart, rot, state.parsed.padding);
  }
  function hsl(idx, l, s) {
    var hue = (idx * 137.508) % 360;
    return 'hsl(' + hue.toFixed(1) + ',' + (s || 66) + '%,' + l + '%)';
  }

  // ---------- 载入数据 ----------
  function loadInput(obj) {
    var parsed;
    try {
      parsed = L.parseInput(obj);
    } catch (e) {
      addMessage('error', '输入解析失败', e.message);
      return false;
    }
    state.rawInput = JSON.parse(JSON.stringify(obj));
    state.parsed = parsed;
    state.placements = {};
    state.locked = {};
    state.selectedId = null;
    parsed.charts.forEach(function (c) {
      state.locked[c.id] = c.locked;
      if (c.given) state.placements[c.id] = { x: c.given.x, y: c.given.y, rotation: c.given.rotation };
    });
    $('messages').innerHTML = '';
    addMessage('info', '已载入 ' + parsed.charts.length + ' 个图块',
      '画布 ' + parsed.atlasSize + '×' + parsed.atlasSize + '，补边 ' + parsed.padding + ' 格');
    setupCanvasSize();
    renderAll();
    return true;
  }

  function currentPackInput() {
    // 把界面锁定状态与手动位置回写到引擎输入
    var raw = JSON.parse(JSON.stringify(state.rawInput));
    raw.padding = parseInt($('paddingInput').value, 10);
    raw.charts.forEach(function (c) {
      c.locked = !!state.locked[c.id];
      if (c.locked && state.placements[c.id]) {
        c.placement = {
          x: state.placements[c.id].x, y: state.placements[c.id].y,
          rotation: state.placements[c.id].rotation
        };
      } else {
        delete c.placement;
      }
    });
    return L.parseInput(raw);
  }

  // ---------- 画布尺寸与坐标 ----------
  function setupCanvasSize() {
    var size = state.parsed.atlasSize;
    var cell = state.cell;
    atlasCanvas.width = size * cell;
    atlasCanvas.height = size * cell;
  }
  function eventToCell(e) {
    var rect = atlasCanvas.getBoundingClientRect();
    var x = Math.floor((e.clientX - rect.left) / state.cell);
    var y = Math.floor((e.clientY - rect.top) / state.cell);
    var size = state.parsed.atlasSize;
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return { x: x, y: y };
  }

  // ---------- 渲染主画布 ----------
  function renderAtlas() {
    if (!state.parsed) return;
    var size = state.parsed.atlasSize;
    var cell = state.cell;
    var W = size * cell;
    ctx.clearRect(0, 0, W, W);

    // 空白底色
    ctx.fillStyle = cssVar('--empty-swatch');
    ctx.fillRect(0, 0, W, W);

    var layout = L.computeLayout(state.parsed, state.placements);
    var conflictCharts = {};
    layout.conflicts.forEach(function (cf) {
      if (cf.a) conflictCharts[cf.a] = true;
      if (cf.b) conflictCharts[cf.b] = true;
    });

    // 先画补边，再画占用
    layout.placedCharts.forEach(function (pc) {
      var idx = pc.chart.index;
      var padColor = hsl(idx, 80, 62);
      var occColor = hsl(idx, 52, 64);
      if (state.showPadding) {
        ctx.fillStyle = padColor;
        pc.absClaim.forEach(function (c) {
          ctx.fillRect(c[0] * cell, c[1] * cell, cell, cell);
        });
      }
      ctx.fillStyle = occColor;
      pc.absOcc.forEach(function (c) {
        ctx.fillRect(c[0] * cell, c[1] * cell, cell, cell);
      });
    });

    // 冲突格红叉高亮
    layout.conflicts.forEach(function (cf) {
      cf.cells.forEach(function (c) {
        ctx.strokeStyle = cssVar('--critical');
        ctx.lineWidth = Math.max(1.5, cell / 10);
        ctx.beginPath();
        ctx.moveTo(c[0] * cell + 2, c[1] * cell + 2);
        ctx.lineTo((c[0] + 1) * cell - 2, (c[1] + 1) * cell - 2);
        ctx.moveTo((c[0] + 1) * cell - 2, c[1] * cell + 2);
        ctx.lineTo(c[0] * cell + 2, (c[1] + 1) * cell - 2);
        ctx.stroke();
      });
    });

    // 网格线
    if (state.showGrid && cell >= 6) {
      ctx.strokeStyle = cssVar('--grid-line');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var i = 0; i <= size; i++) {
        ctx.moveTo(i * cell + .5, 0); ctx.lineTo(i * cell + .5, W);
        ctx.moveTo(0, i * cell + .5); ctx.lineTo(W, i * cell + .5);
      }
      ctx.stroke();
    }

    // 选中描边 + 拖拽预览
    if (state.selectedId) {
      var sel = chartById(state.selectedId);
      var pl = state.placements[sel.id];
      if (pl) {
        var v = L.buildVariant(sel, pl.rotation, state.parsed.padding);
        ctx.strokeStyle = cssVar('--accent');
        ctx.lineWidth = Math.max(2, cell / 8);
        ctx.strokeRect(pl.x * cell + 1, pl.y * cell + 1,
          v.rw * cell - 2, v.rh * cell - 2);
      }
    }
    if (state.drag && state.drag.preview) {
      var d = state.drag;
      var dv = L.buildVariant(d.chart, d.rotation, state.parsed.padding);
      var ok = placementLegal(d.chart, d.preview.x, d.preview.y, d.rotation);
      ctx.fillStyle = ok ? 'rgba(31,138,76,.35)' : 'rgba(192,57,43,.35)';
      dv.claim.forEach(function (c) {
        ctx.fillRect((c[0] + d.preview.x) * cell, (c[1] + d.preview.y) * cell, cell, cell);
      });
      ctx.strokeStyle = ok ? cssVar('--good') : cssVar('--critical');
      ctx.lineWidth = 2;
      ctx.strokeRect(d.preview.x * cell + 1, d.preview.y * cell + 1, dv.rw * cell - 2, dv.rh * cell - 2);
    }
    updateStats(layout);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function updateStats(layout) {
    var s = layout.stats;
    $('statOccupied').innerHTML = s.occupiedCells + ' <small>格</small>';
    $('statPadding').innerHTML = s.paddingCells + ' <small>格</small>';
    $('statFree').innerHTML = s.freeCells + ' <small>格</small>';
    $('statUtil').innerHTML = (s.utilization * 100).toFixed(1) + '<small>%</small>';
    var placed = Object.keys(state.placements).length;
    $('statPlaced').textContent = placed + ' / ' + state.parsed.charts.length;
    $('statConflicts').textContent = layout.conflicts.length;
    $('statConflicts').style.color = layout.conflicts.length ? cssVar('--critical') : '';
  }

  // 合法性（补边不越界、不与他块冲突；自身忽略）
  function placementLegal(chart, px, py, rotation) {
    var v = L.buildVariant(chart, rotation, state.parsed.padding);
    var size = state.parsed.atlasSize;
    for (var i = 0; i < v.claim.length; i++) {
      var x = v.claim[i][0] + px, y = v.claim[i][1] + py;
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
    }
    for (var j = 0; j < state.parsed.charts.length; j++) {
      var other = state.parsed.charts[j];
      if (other.id === chart.id) continue;
      var op = state.placements[other.id];
      if (!op) continue;
      var ov = L.buildVariant(other, op.rotation, state.parsed.padding);
      var set = {};
      ov.claim.forEach(function (c) { set[(c[0] + op.x) + ',' + (c[1] + op.y)] = true; });
      for (var k = 0; k < v.claim.length; k++) {
        var key = (v.claim[k][0] + px) + ',' + (v.claim[k][1] + py);
        if (set[key]) return false;
      }
    }
    return true;
  }

  // ---------- 画布交互：点选/拖拽 ----------
  atlasCanvas.addEventListener('pointerdown', function (e) {
    if (!state.parsed) return;
    var cell0 = eventToCell(e);
    if (!cell0) return;
    var layout = L.computeLayout(state.parsed, state.placements);
    var idx = layout.occGrid[cell0.y * state.parsed.atlasSize + cell0.x];
    if (idx < 0) idx = layout.claimGrid[cell0.y * state.parsed.atlasSize + cell0.x];
    if (idx < 0) { state.selectedId = null; renderAll(); return; }
    var chart = state.parsed.charts[idx];
    state.selectedId = chart.id;
    var pl = state.placements[chart.id];
    if (!pl) { renderAll(); return; }
    if (state.locked[chart.id]) {
      addMessage('warn', '图块 ' + chart.id + ' 已锁定', '解锁后才能拖动；可用右侧按钮解锁。');
      renderAll(); return;
    }
    atlasCanvas.setPointerCapture(e.pointerId);
    atlasCanvas.classList.add('dragging');
    state.drag = {
      chart: chart, startX: pl.x, startY: pl.y,
      rotation: pl.rotation,
      grabDX: cell0.x - pl.x, grabDY: cell0.y - pl.y,
      preview: { x: pl.x, y: pl.y }, moved: false
    };
    renderAll();
  });

  atlasCanvas.addEventListener('pointermove', function (e) {
    if (!state.parsed) return;
    var cell0 = eventToCell(e);
    state.hoverCell = cell0;
    if (!state.drag || !cell0) { renderAtlas(); return; }
    var d = state.drag;
    var nx = cell0.x - d.grabDX;
    var ny = cell0.y - d.grabDY;
    if (nx !== d.preview.x || ny !== d.preview.y) d.moved = true;
    d.preview = { x: nx, y: ny };
    renderAtlas();
  });

  atlasCanvas.addEventListener('pointerup', function (e) {
    if (!state.drag) return;
    var d = state.drag;
    atlasCanvas.releasePointerCapture(e.pointerId);
    atlasCanvas.classList.remove('dragging');
    var target = d.preview;
    state.drag = null;
    if (d.moved) {
      if (placementLegal(d.chart, target.x, target.y, d.rotation)) {
        state.placements[d.chart.id] = { x: target.x, y: target.y, rotation: d.rotation };
        addMessage('ok', '已移动 ' + d.chart.id, '新位置 (' + target.x + ',' + target.y + ') 旋转 ' + d.rotation + '°');
      } else {
        // 放下时冲突：逐格报告
        reportConflict(d.chart, target.x, target.y, d.rotation);
        state.placements[d.chart.id] = { x: d.startX, y: d.startY, rotation: d.rotation };
      }
    }
    renderAll();
  });

  function reportConflict(chart, px, py, rotation) {
    var parsed = state.parsed;
    var v = L.buildVariant(chart, rotation, parsed.padding);
    var size = parsed.atlasSize;
    var oob = [], overlaps = {};
    v.claim.forEach(function (c) {
      var x = c[0] + px, y = c[1] + py;
      if (x < 0 || y < 0 || x >= size || y >= size) { oob.push([x, y]); return; }
      for (var i = 0; i < parsed.charts.length; i++) {
        var o = parsed.charts[i];
        if (o.id === chart.id) continue;
        var op = state.placements[o.id];
        if (!op) continue;
        var ov = L.buildVariant(o, op.rotation, parsed.padding);
        for (var j = 0; j < ov.claim.length; j++) {
          if (ov.claim[j][0] + op.x === x && ov.claim[j][1] + op.y === y) {
            if (!overlaps[o.id]) overlaps[o.id] = [];
            if (overlaps[o.id].length < 12) overlaps[o.id].push([x, y]);
          }
        }
      }
    });
    var detail = [];
    if (oob.length) detail.push('越界格 ' + oob.length + ' 处：' + L.formatCells(oob.slice(0, 12)));
    Object.keys(overlaps).forEach(function (oid) {
      detail.push('与 ' + oid + ' 冲突格：' + L.formatCells(overlaps[oid]));
    });
    addMessage('error', '无法放下 ' + chart.id + '（位置 (' + px + ',' + py + ') 旋转 ' + rotation + '°）',
      detail.join('；') || '补边格越界或与相邻图块补边重叠');
  }

  // ---------- 按钮动作 ----------
  function doPack() {
    if (!state.parsed) { toast('请先载入数据'); return; }
    var parsed;
    try { parsed = currentPackInput(); }
    catch (e) { addMessage('error', '重排输入构建失败', e.message); return; }
    var t0 = performance.now();
    var r = L.pack(parsed);
    var ms = (performance.now() - t0).toFixed(0);
    if (r.status === 'ok') {
      r.placements.forEach(function (p) { state.placements[p.id] = { x: p.x, y: p.y, rotation: p.rotation }; });
      addMessage('ok', '排布成功（' + r.phase + '，' + ms + 'ms，节点 ' + r.nodes + '）', r.message);
    } else if (r.status === 'locked-conflict') {
      addMessage('error', '锁定冲突：' + r.lockedChart, r.message);
      (r.conflicts || []).forEach(function (cf) {
        addMessage('error', cf.kind === 'out-of-bounds' ? '越界' : '补边重叠',
          (cf.b || '') + ' ' + L.formatCells(cf.cells));
      });
    } else if (r.status === 'impossible') {
      addMessage('error', '可证明无解（未缩放任何图块）', r.message);
    } else {
      addMessage('warn', '未找到可行布局（不能证明无解，未缩放任何图块）', r.message);
    }
    renderAll();
  }

  function rotateSelected() {
    if (!state.selectedId) { toast('请先选择图块'); return; }
    var chart = chartById(state.selectedId);
    if (state.locked[chart.id]) { addMessage('warn', chart.id + ' 已锁定，无法旋转'); return; }
    var pl = state.placements[chart.id] || { x: 0, y: 0, rotation: 0 };
    var newRot = pl.rotation === 0 ? 90 : 0;
    // 以包围框左上角为锚旋转：新尺寸可能变化，保持左上角并做合法性检查
    if (placementLegal(chart, pl.x, pl.y, newRot)) {
      state.placements[chart.id] = { x: pl.x, y: pl.y, rotation: newRot };
      addMessage('ok', chart.id + ' 旋转为 ' + newRot + '°');
    } else {
      reportConflict(chart, pl.x, pl.y, newRot);
    }
    renderAll();
  }

  function nudge(dx, dy) {
    if (!state.selectedId) { toast('请先选择图块'); return; }
    var chart = chartById(state.selectedId);
    if (state.locked[chart.id]) { addMessage('warn', chart.id + ' 已锁定'); return; }
    var pl = state.placements[chart.id];
    if (!pl) { toast('该图块尚未放置'); return; }
    var nx = pl.x + dx, ny = pl.y + dy;
    if (placementLegal(chart, nx, ny, pl.rotation)) {
      pl.x = nx; pl.y = ny;
      addMessage('info', chart.id + ' 微调到 (' + nx + ',' + ny + ')');
    } else {
      reportConflict(chart, nx, ny, pl.rotation);
    }
    renderAll();
  }

  function toggleLock() {
    if (!state.selectedId) { toast('请先选择图块'); return; }
    var id = state.selectedId;
    state.locked[id] = !state.locked[id];
    addMessage('info', id + (state.locked[id] ? ' 已锁定' : ' 已解锁'),
      state.locked[id] ? '重排时保持当前位置不变' : '重排时可被引擎重新放置');
    renderAll();
  }

  function clearUnlocked() {
    var removed = [];
    state.parsed.charts.forEach(function (c) {
      if (!state.locked[c.id] && state.placements[c.id]) {
        delete state.placements[c.id];
        removed.push(c.id);
      }
    });
    addMessage('info', '已清除 ' + removed.length + ' 个未锁定图块的放置', removed.join(', '));
    renderAll();
  }

  // ---------- 图块列表 ----------
  function renderChartList() {
    var box = $('chartList');
    box.innerHTML = '';
    var layout = state.parsed ? L.computeLayout(state.parsed, state.placements) : null;
    var conflictSet = {};
    if (layout) layout.conflicts.forEach(function (cf) {
      if (cf.a) conflictSet[cf.a] = true;
      if (cf.b) conflictSet[cf.b] = true;
    });
    state.parsed.charts.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'chart-row' + (c.id === state.selectedId ? ' selected' : '');
      var pl = state.placements[c.id];
      var badge = '';
      if (conflictSet[c.id]) badge = '<span class="badge conflict">冲突</span>';
      else if (state.locked[c.id]) badge = '<span class="badge locked">锁定</span>';
      else if (pl) badge = '<span class="badge placed">已放</span>';
      else badge = '<span class="badge unplaced">未放</span>';
      row.innerHTML =
        '<span class="dot" style="background:' + hsl(c.index, 52, 64) + '"></span>' +
        '<span class="name">' + escapeHtml(c.id) + '</span>' +
        (pl ? '<span class="mini-pos">' + pl.x + ',' + pl.y + ' r' + pl.rotation + '</span>' : '') +
        badge;
      row.addEventListener('click', function () {
        state.selectedId = c.id;
        renderAll();
      });
      box.appendChild(row);
    });
  }

  // ---------- 检查器：网格与 UV ----------
  function renderInspector() {
    var detail = $('chartDetail');
    if (!state.selectedId) {
      detail.innerHTML = '<div class="empty-hint">在画布或左侧列表点击图块查看原网格、变换与逐角 UV。</div>';
      $('meshSection').hidden = true;
      return;
    }
    var c = chartById(state.selectedId);
    var pl = state.placements[c.id];
    var v = L.buildVariant(c, pl ? pl.rotation : 0, state.parsed.padding);
    var dl = [
      ['ID', c.id],
      ['原始尺寸', c.w + ' × ' + c.h],
      ['占用格', c.occ.length],
      ['补边格', v.claimCount + '（padding=' + state.parsed.padding + '）'],
      ['旋转后', v.rw + ' × ' + v.rh],
      ['锁定', state.locked[c.id] ? '是' : '否'],
      ['放置', pl ? '(' + pl.x + ', ' + pl.y + ') ' + pl.rotation + '°' : '未放置']
    ];
    detail.innerHTML = '<dl class="kv">' +
      dl.map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + escapeHtml(p[1]) + '</dd>'; }).join('') +
      '</dl>';
    drawMesh(c, pl);
  }

  function drawMesh(chart, pl) {
    var pad = state.parsed.padding;
    // 原网格
    var oc = $('meshOriginal'), octx = oc.getContext('2d');
    var scale = 18;
    oc.width = chart.w * scale; oc.height = chart.h * scale;
    octx.fillStyle = cssVar('--empty-swatch');
    octx.fillRect(0, 0, oc.width, oc.height);
    var occSet = {};
    chart.occ.forEach(function (c) { occSet[c[0] + ',' + c[1]] = true; });
    for (var y = 0; y < chart.h; y++) for (var x = 0; x < chart.w; x++) {
      if (occSet[x + ',' + y]) {
        octx.fillStyle = hsl(chart.index, 52, 64);
        octx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    drawTriangles(octx, chart, null, scale);
    drawGridLines(octx, chart.w, chart.h, scale);
    $('meshSection').hidden = false;

    // 变换后
    var tc = $('meshTransformed'), tctx = tc.getContext('2d');
    var rot = pl ? pl.rotation : 0;
    var tv = L.buildVariant(chart, rot, pad);
    tc.width = tv.rw * scale; tc.height = tv.rh * scale;
    tctx.fillStyle = cssVar('--empty-swatch');
    tctx.fillRect(0, 0, tc.width, tc.height);
    // 补边
    tctx.fillStyle = hsl(chart.index, 80, 62);
    tv.claim.forEach(function (c) { tctx.fillRect(c[0] * scale, c[1] * scale, scale, scale); });
    // 占用
    tctx.fillStyle = hsl(chart.index, 52, 64);
    tv.occ.forEach(function (c) { tctx.fillRect(c[0] * scale, c[1] * scale, scale, scale); });
    if (pl) drawTriangles(tctx, chart, pl, scale);
    drawGridLines(tctx, tv.rw, tv.rh, scale);
    $('meshNote').textContent = pl
      ? '上图：原网格与三角形；下图：旋转 ' + rot + '° 后（含补边），平移 (' + pl.x + ',' + pl.y + ') 后 UV=连续坐标/' + state.parsed.atlasSize
      : '该图块尚未放置，下图仅显示旋转 ' + rot + '° 的局部形态。';
  }

  function drawGridLines(c2d, w, h, scale) {
    c2d.strokeStyle = cssVar('--grid-line');
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (var i = 0; i <= w; i++) { c2d.moveTo(i * scale + .5, 0); c2d.lineTo(i * scale + .5, h * scale); }
    for (var j = 0; j <= h; j++) { c2d.moveTo(0, j * scale + .5); c2d.lineTo(w * scale, j * scale + .5); }
    c2d.stroke();
  }

  function drawTriangles(c2d, chart, pl, scale) {
    var geo = pl ? L.transformGeometry(chart, pl, state.parsed.atlasSize) : null;
    c2d.strokeStyle = 'rgba(10,15,22,.85)';
    c2d.fillStyle = 'rgba(10,15,22,.85)';
    c2d.lineWidth = 1.2;
    chart.triangles.forEach(function (t) {
      var pts = t.map(function (vi) {
        if (pl) return [geo.positions[vi][0] - pl.x, geo.positions[vi][1] - pl.y];
        return chart.vertices[vi];
      });
      c2d.beginPath();
      c2d.moveTo(pts[0][0] * scale, pts[0][1] * scale);
      c2d.lineTo(pts[1][0] * scale, pts[1][1] * scale);
      c2d.lineTo(pts[2][0] * scale, pts[2][1] * scale);
      c2d.closePath();
      c2d.stroke();
    });
  }

  // ---------- 导出 ----------
  function placedList() {
    return state.parsed.charts
      .filter(function (c) { return state.placements[c.id]; })
      .map(function (c) {
        var p = state.placements[c.id];
        return { id: c.id, x: p.x, y: p.y, rotation: p.rotation };
      });
  }

  function exportLayout() {
    var data = L.buildLayoutJSON(state.parsed, placedList());
    var text = JSON.stringify(data, null, 2);
    showExportModal('布局 JSON', text, 'layout.json');
  }
  function exportCornerUV() {
    var data = L.buildCornerUV(state.parsed, placedList());
    var text = JSON.stringify(data, null, 2);
    showExportModal('逐角 UV', text, 'corner-uv.json');
  }
  function exportOwnership() {
    // PNG（1 格 1 像素）+ JSON 色表，区分原占用/补边/空白
    var size = state.parsed.atlasSize;
    var layout = L.computeLayout(state.parsed, placedMap());
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var c2d = cv.getContext('2d');
    var img = c2d.createImageData(size, size);
    var palette = {}; // id -> {occ:[r,g,b], pad:[...]}
    function rgb(idx, light) {
      var hue = (idx * 137.508) % 360;
      return hslToRgb(hue / 360, light > 70 ? .6 : .64, light / 100);
    }
    state.parsed.charts.forEach(function (c) {
      palette[c.id] = { occ: rgb(c.index, 52), pad: rgb(c.index, 80) };
    });
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = y * size + x;
        var off = i * 4;
        var owner = layout.claimGrid[i];
        if (owner < 0) { // 空白
          img.data[off] = 255; img.data[off + 1] = 255; img.data[off + 2] = 255; img.data[off + 3] = 255;
        } else {
          var id = state.parsed.charts[owner].id;
          var isOcc = layout.occGrid[i] >= 0;
          var col = isOcc ? palette[id].occ : palette[id].pad;
          img.data[off] = col[0]; img.data[off + 1] = col[1]; img.data[off + 2] = col[2]; img.data[off + 3] = 255;
        }
      }
    }
    c2d.putImageData(img, 0, 0);
    var colorTable = {
      atlasSize: size, padding: state.parsed.padding,
      cellKind: { occupied: '图块原占用格（深色）', padding: '补边膨胀格（浅色）', empty: '空白格 #FFFFFF' },
      colors: Object.keys(palette).map(function (id) {
        return {
          id: id,
          occupied: '#' + palette[id].occ.map(function (v) { return hex2(v); }).join(''),
          padding: '#' + palette[id].pad.map(function (v) { return hex2(v); }).join('')
        };
      }),
      empty: '#FFFFFF'
    };
    var tableText = JSON.stringify(colorTable, null, 2);
    cv.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      showOwnershipModal(url, tableText, blob);
    });
  }
  function placedMap() {
    var m = {};
    placedList().forEach(function (p) { m[p.id] = p; });
    return m;
  }
  function hex2(v) { var s = v.toString(16); return s.length < 2 ? '0' + s : s; }
  function hslToRgb(h, s, l) {
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var hue2 = function (p, q, t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      var q = l < .5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2(p, q, h + 1 / 3); g = hue2(p, q, h); b = hue2(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  var modal = $('modal'), modalTitle = $('modalTitle'), modalBody = $('modalBody'), modalActions = $('modalActions');
  function showExportModal(title, text, filename) {
    modalTitle.textContent = title;
    modalBody.innerHTML = '<pre id="modalPre"></pre>';
    $('modalPre').textContent = text;
    modalActions.innerHTML = '';
    addModalButton('下载 ' + filename, function () { download(filename, text); }, true);
    addModalButton('复制到剪贴板', function () {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); },
        function () {
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选择'); }
          ta.remove();
        });
    });
    addModalButton('关闭', closeModal);
    modal.classList.add('open');
  }
  function showOwnershipModal(pngUrl, tableText, blob) {
    modalTitle.textContent = '图块归属图（PNG + JSON 色表）';
    modalBody.innerHTML =
      '<div class="small" style="margin-bottom:8px">每像素对应一个格子；深色=原占用，浅色=补边，白色=空白。下方为放大预览，导出为原始 ' +
      state.parsed.atlasSize + '×' + state.parsed.atlasSize + ' 像素。</div>' +
      '<img alt="ownership preview" src="' + pngUrl + '" style="width:100%;image-rendering:pixelated">' +
      '<hr class="sep"><pre id="modalPre"></pre>';
    $('modalPre').textContent = tableText;
    modalActions.innerHTML = '';
    addModalButton('下载 ownership.png', function () {
      var a = document.createElement('a');
      a.href = pngUrl; a.download = 'ownership.png';
      document.body.appendChild(a); a.click(); a.remove();
    }, true);
    addModalButton('下载 color-table.json', function () { download('color-table.json', tableText); });
    addModalButton('复制色表 JSON', function () {
      navigator.clipboard.writeText(tableText).then(function () { toast('已复制'); },
        function () { toast('复制失败，请手动选择'); });
    });
    addModalButton('关闭', closeModal);
    modal.classList.add('open');
  }
  function addModalButton(label, fn, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    modalActions.appendChild(b);
  }
  function closeModal() { modal.classList.remove('open'); }

  // ---------- 渲染总入口 ----------
  function renderAll() {
    if (!state.parsed) return;
    renderAtlas();
    renderChartList();
    renderInspector();
  }

  // ---------- 事件绑定 ----------
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try { loadInput(JSON.parse(reader.result)); }
      catch (err) { addMessage('error', '文件不是有效 JSON', err.message); }
    };
    reader.readAsText(f);
  });
  $('packBtn').addEventListener('click', doPack);
  $('rotateBtn').addEventListener('click', rotateSelected);
  $('lockBtn').addEventListener('click', toggleLock);
  $('clearBtn').addEventListener('click', clearUnlocked);
  $('upBtn').addEventListener('click', function () { nudge(0, -1); });
  $('downBtn').addEventListener('click', function () { nudge(0, 1); });
  $('leftBtn').addEventListener('click', function () { nudge(-1, 0); });
  $('rightBtn').addEventListener('click', function () { nudge(1, 0); });
  $('zoomOut').addEventListener('click', function () { setCell(Math.max(4, state.cell - 4)); });
  $('zoomIn').addEventListener('click', function () { setCell(Math.min(64, state.cell + 4)); });
  $('zoomFit').addEventListener('click', function () {
    var wrap = atlasCanvas.parentElement;
    setCell(Math.max(4, Math.min(40, Math.floor((wrap.clientWidth - 24) / state.parsed.atlasSize))));
  });
  function setCell(c) { state.cell = c; $('zoomLabel').textContent = c + 'px'; setupCanvasSize(); renderAtlas(); }
  $('togglePadding').addEventListener('click', function () {
    state.showPadding = !state.showPadding;
    this.classList.toggle('active', state.showPadding);
    renderAtlas();
  });
  $('toggleGrid').addEventListener('click', function () {
    state.showGrid = !state.showGrid;
    this.classList.toggle('active', state.showGrid);
    renderAtlas();
  });
  $('paddingInput').addEventListener('change', function () {
    var v = parseInt(this.value, 10);
    if (!Number.isInteger(v) || v < 0 || v > 4) { addMessage('error', '补边必须是 0..4 的整数'); this.value = state.parsed.padding; return; }
    // 重新解析应用新 padding，保留锁定与位置
    var raw = JSON.parse(JSON.stringify(state.rawInput));
    raw.padding = v;
    raw.charts.forEach(function (c) {
      c.locked = !!state.locked[c.id];
      if (c.locked && state.placements[c.id]) c.placement = state.placements[c.id];
      else delete c.placement;
    });
    loadInput(raw);
  });
  $('exportLayout').addEventListener('click', exportLayout);
  $('exportUV').addEventListener('click', exportCornerUV);
  $('exportOwnership').addEventListener('click', exportOwnership);
  $('modalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (modal.classList.contains('open')) { if (e.key === 'Escape') closeModal(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'r' || e.key === 'R') rotateSelected();
    else if (e.key === 'l' || e.key === 'L') toggleLock();
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-1, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(1, 0); }
  });

  // ---------- 内置样例 ----------
  function loadSample(name) {
    var obj = window.SAMPLES[name];
    if (!obj) { toast('样例缺失'); return; }
    $('paddingInput').value = obj.padding;
    loadInput(obj);
  }
  $('sampleSmall').addEventListener('click', function () { loadSample('small'); });
  $('sampleCapacity').addEventListener('click', function () { loadSample('capacity'); });
  loadSample('small');

  $('zoomLabel').textContent = state.cell + 'px';
})();
