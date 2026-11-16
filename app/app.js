/* Main controller: project lifecycle, filtering, selection, exports. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    projectId: 0,              // bumped on every import; stale results are discarded
    name: '',
    data: null,                // validated {vertices, faces, uv}
    result: null,              // engine output
    status: 'empty',           // empty | analyzing | done | error | cancelled
    token: null,
    filters: { overlap: false, mirror: false, outside: false, stretch: false, degenerate: false },
    stretchThreshold: 2,
    selection: -1,
    cycle: [],                 // face ids at the picked UV location
    cyclePos: 0,
    sortKey: 'id',
    sortDir: 1,
    page: 0,
    pageSize: 50
  };

  /* ---------------- palette (driven by CSS tokens) ---------------- */
  function hexToRgba(hex, alpha) {
    var h = hex.trim();
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function buildPalette() {
    var sel = css('--selected');
    return {
      monoFont: "'JetBrains Mono', ui-monospace, monospace",
      // 3D colors (opaque)
      neutral: css('--good'),
      good: css('--good'),
      overlap: css('--overlap'),
      mirror: css('--mirror'),
      outside: css('--outside'),
      stretch: css('--stretch'),
      degenerate: css('--degenerate'),
      hover: sel,
      sel3d: sel,
      dim: css('--faint'),
      edge: css('--line-strong'),
      // UV canvas colors
      planeBg: css('--bg'),
      unitBg: css('--panel-2'),
      gridLine: css('--line'),
      frameLine: css('--line-strong'),
      axisLabel: css('--faint'),
      triStroke: css('--line-strong'),
      goodFill: css('--good-fill'),
      overlapFill: css('--overlap-fill'),
      mirrorFill: css('--mirror-fill'),
      outsideFill: css('--outside-fill'),
      stretchFill: css('--stretch-fill'),
      degenerateFill: css('--degenerate-fill'),
      dimFill: hexToRgba(css('--faint'), 0.14),
      selUv: hexToRgba(sel, 0.55),
      selStroke: sel,
      degenerateStroke: css('--faint'),
      ovlPoly: hexToRgba(css('--overlap'), 0.42),
      ovlPolyStroke: hexToRgba(css('--overlap'), 0.9),
      maskPixel: hexToRgba(css('--stretch'), 0.85),
      markerPrimary: sel,
      markerCycle: css('--overlap'),
      markerRing: css('--panel')
    };
  }

  /* ---------------- theme ---------------- */
  function currentTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit;
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('uva-theme', t); } catch (e) { /* ignore */ }
    if (state.data && threeView && uvView) {
      var pal = buildPalette();
      threeView.palette = pal;
      threeView._refreshColors();
      if (threeView.edges) threeView.edges.material.color.set(pal.edge);
      uvView.palette = pal;
      uvView.draw();
    }
  }

  /* ---------------- numeric formatting ---------------- */
  function fmt(x, digits) {
    if (x === null || x === undefined) return '—';
    if (!isFinite(x)) return '∞';
    if (x === 0) return '0';
    var ax = Math.abs(x);
    if (digits === undefined) digits = ax >= 100 ? 2 : ax >= 1 ? 4 : 4;
    return x.toFixed(digits).replace(/\.?0+$/, function (m) { return m.indexOf('.') >= 0 ? '' : m; });
  }
  function fmtSci(x) {
    if (x === null || x === undefined) return '—';
    if (x === 0) return '0';
    if (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e6) return fmt(x, 6);
    return x.toExponential(3);
  }

  /* ---------------- project lifecycle ---------------- */
  var threeView = null, uvView = null;

  function initViews() {
    if (threeView) return;
    threeView = new ThreeView($('threeContainer'), {
      onPick: onThreePick,
      onHover: function (id, x, y) { show3dTooltip(id, x, y); }
    });
    uvView = new UvView($('uvCanvas'), {
      onPick: onUvPick,
      onHover: function (id, x, y, uv) { showUvTooltip(id, x, y, uv); }
    });
  }

  async function loadProject(name, rawText) {
    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      setError(name, 'JSON 解析失败：' + e.message + '。注意 NaN/Infinity 不是合法 JSON，请改成 null 或数值。');
      return;
    }
    var data;
    try {
      data = UVAudit.validate(parsed);
    } catch (e) {
      setError(name, e.message);
      return;
    }

    // New project fully replaces the old one; a new generation id makes sure
    // any in-flight analysis cannot write into this project when it finishes.
    state.projectId++;
    var myId = state.projectId;
    state.name = name;
    state.data = data;
    state.result = null;
    state.status = 'analyzing';
    state.selection = -1;
    state.cycle = [];
    state.cyclePos = 0;
    state.page = 0;
    state.token = { cancelled: false };

    $('dropzone').hidden = true;
    $('workspace').hidden = false;
    $('statusStrip').hidden = false;
    $('tiles').hidden = false;
    $('btnCancel').hidden = false;
    setStatusPill('analyzing', '分析中');
    $('errorText').hidden = true;
    $('pendingNote').hidden = true;
    $('progressWrap').hidden = false;
    setProgress(0, '初始化…');
    setExportsEnabled(false);
    $('projectName').textContent = name;
    $('fileMeta').textContent = name + ' · ' + data.faces.length + ' 个三角形';

    initViews();
    var pal = buildPalette();
    threeView.setData(data, null, pal);
    uvView.setData(data, null, pal);
    renderEmptyAnalysisUi(data);

    var t0 = performance.now();
    var result;
    try {
      result = await UVAudit.analyze(
        data, state.token,
        function (phase, done, total) {
          if (myId !== state.projectId) return;
          var label = phase === 'metrics' ? '计算逐面指标' : phase === 'overlap' ? '检测重叠面对' : '生成 256² 遮罩';
          setProgress(done / total, label + '（' + done + '/' + total + '）');
        },
        function () { return new Promise(function (r) { setTimeout(r, 0); }); }
      );
    } catch (e) {
      if (myId === state.projectId) setError(name, '分析过程出错：' + e.message);
      return;
    }

    // Stale result from a previous import/cancel: never touch current project.
    if (myId !== state.projectId || state.token.cancelled) {
      if (myId === state.projectId) {
        state.status = 'cancelled';
        $('btnCancel').hidden = true;
        setStatusPill('cancelled', '已取消');
        $('progressWrap').hidden = true;
        $('pendingNote').hidden = false;
        $('pendingNote').textContent = '分析已取消，当前视图不含统计结果；重新导入或再次载入文件即可。';
      }
      return;
    }

    state.result = result;
    state.status = 'done';
    $('btnCancel').hidden = true;
    setStatusPill('done', '分析完成 · ' + Math.round(performance.now() - t0) + ' ms');
    $('progressWrap').hidden = true;
    setExportsEnabled(true);
    threeView.result = result;
    threeView.palette = pal;
    threeView._refreshColors();
    uvView.result = result;
    uvView.palette = pal;
    uvView.draw();
    renderAll();
  }

  function setError(name, msg) {
    state.projectId++;
    state.status = 'error';
    state.result = null;
    $('btnCancel').hidden = true;
    $('statusStrip').hidden = false;
    $('projectName').textContent = name || '无效文件';
    setStatusPill('error', '文件无效');
    $('progressWrap').hidden = true;
    $('pendingNote').hidden = true;
    var et = $('errorText');
    et.hidden = false;
    et.textContent = msg;
    setExportsEnabled(false);
  }

  function setStatusPill(kind, text) {
    var pill = $('statusPill');
    pill.className = 'status-pill ' + kind;
    pill.textContent = text;
  }
  function setProgress(frac, label) {
    $('progressFill').style.width = Math.round(frac * 100) + '%';
    $('progressLabel').textContent = label;
  }
  function setExportsEnabled(on) {
    ['btnExportCsv', 'btnExportJson', 'btnExportPng'].forEach(function (id) { $(id).disabled = !on; });
  }

  function cancelAnalysis() {
    if (state.token && state.status === 'analyzing') {
      state.token.cancelled = true;
      setProgress(1, '正在取消…');
    }
  }

  /* ---------------- derived sets ---------------- */
  function stretchSet() {
    var r = state.result, set = new Set();
    if (!r) return set;
    for (var i = 0; i < r.metrics.length; i++) {
      if (r.valid[i] && r.metrics[i].stretch >= state.stretchThreshold) set.add(i);
    }
    return set;
  }

  function faceMatches(i, sset) {
    var f = state.filters, r = state.result, m = r.metrics[i];
    if (m.degenerate) return f.degenerate;
    if (f.overlap && r.facePairs[i].length > 0) return true;
    if (f.mirror && m.mirrored) return true;
    if (f.outside && m.outside) return true;
    if (f.stretch && sset.has(i)) return true;
    return false;
  }

  function anyFilterOn() {
    var f = state.filters;
    return f.overlap || f.mirror || f.outside || f.stretch || f.degenerate;
  }

  // Returns {set, stretchSet}. When no filter is active, set is null (= all).
  function computeFilterSets() {
    var sset = stretchSet();
    if (!anyFilterOn()) return { set: null, stretchSet: sset };
    var set = new Set();
    for (var i = 0; i < state.data.faces.length; i++) {
      if (faceMatches(i, sset)) set.add(i);
    }
    return { set: set, stretchSet: sset };
  }

  /* ---------------- selection ---------------- */
  function selectFace(id, cycle) {
    state.selection = id;
    state.cycle = cycle || (id >= 0 ? [id] : []);
    state.cyclePos = Math.max(0, state.cycle.indexOf(id));
    pushSelectionToViews();
    renderDetail();
    renderTable();
    scrollTableToSelection();
  }

  function pushSelectionToViews() {
    threeView.setSelection(state.selection, state.cycle);
    uvView.setSelection(state.selection, state.cycle);
  }

  function cycleStep(dir) {
    if (state.cycle.length < 2) return;
    state.cyclePos = (state.cyclePos + dir + state.cycle.length) % state.cycle.length;
    state.selection = state.cycle[state.cyclePos];
    pushSelectionToViews();
    renderDetail();
    renderTable();
    scrollTableToSelection();
  }

  function onThreePick(id) {
    if (id < 0 || !state.result) { selectFace(-1, []); return; }
    // The 3D face is one triangle; at its UV spot other faces may overlap.
    var center = faceUvCentroid(id);
    var hits = UVAudit.facesAtPoint(state.result, center);
    if (hits.indexOf(id) < 0) hits.unshift(id);
    // Cycling covers every face sharing the UV location, filter-independent.
    var cycle = hits.slice().sort(function (a, b) { return a - b; });
    selectFace(id, cycle);
  }

  function onUvPick(uv) {
    if (!uv || !state.result) { selectFace(-1, []); return; }
    var hits = UVAudit.facesAtPoint(state.result, uv);
    if (!hits.length) { selectFace(-1, []); return; }
    // All faces under this UV point; filters only dim, never remove cycle members.
    var cycle = hits.slice().sort(function (a, b) { return a - b; });
    // Rotate around the current selection when re-clicking the same spot.
    var idx = cycle.indexOf(state.selection);
    var start = idx >= 0 ? (idx + 1) % cycle.length : 0;
    selectFace(cycle[start], cycle);
  }

  function faceUvCentroid(i) {
    var t = state.data.uv[i], u = 0, v = 0;
    for (var k = 0; k < 3; k++) { u += t[k][0]; v += t[k][1]; }
    return [u / 3, v / 3];
  }

  /* ---------------- tooltips ---------------- */
  function tooltipText(id, uv) {
    if (id < 0 || !state.result) return '';
    var m = state.result.metrics[id];
    var tags = [];
    if (m.degenerate) tags.push('退化');
    if (m.mirrored) tags.push('镜像');
    if (m.outside) tags.push('越界');
    if (state.result.facePairs[id].length) tags.push('重叠×' + state.result.facePairs[id].length);
    if (state.result.valid[id] && m.stretch >= state.stretchThreshold) tags.push('拉伸 ' + fmt(m.stretch, 2));
    var where = uv ? '  u=' + fmt(uv[0], 4) + ' v=' + fmt(uv[1], 4) : '';
    return '面 #' + id + where + (tags.length ? '  ·  ' + tags.join(' / ') : '');
  }
  function show3dTooltip(id, x, y) {
    var tip = $('tooltip');
    if (id < 0) { tip.classList.remove('show'); return; }
    tip.textContent = tooltipText(id);
    tip.classList.add('show');
    tip.style.left = Math.min(x + 14, innerWidth - 210) + 'px';
    tip.style.top = Math.max(8, y - 34) + 'px';
  }
  function showUvTooltip(id, x, y, uv) {
    var tip = $('tooltip');
    if (id < 0) { tip.classList.remove('show'); return; }
    tip.textContent = tooltipText(id, uv);
    tip.classList.add('show');
    tip.style.left = Math.min(x + 14, innerWidth - 210) + 'px';
    tip.style.top = Math.max(8, y - 34) + 'px';
  }

  /* ---------------- rendering: tiles, table, detail ---------------- */
  function renderEmptyAnalysisUi(data) {
    $('tileTotal').textContent = data.faces.length;
    $('tileValidSub').textContent = '统计计算中…';
    ['tileOverlap', 'tileMirror', 'tileOutside', 'tileStretch', 'tileDegenerate'].forEach(function (id) { $(id).textContent = '…'; });
    $('tileOverlapSub').textContent = '';
    $('tileStretchSub').textContent = '阈值 ' + state.stretchThreshold;
    $('faceTbody').innerHTML = '';
    $('pageInfo').textContent = '等待分析完成';
  }

  function renderAll() {
    renderTiles();
    applyFiltersToViews();
    renderTable();
    renderDetail();
  }

  function renderTiles() {
    var r = state.result, n = state.data.faces.length;
    var validCount = 0, mirror = 0, outside = 0, deg = 0;
    var sset = stretchSet();
    var overlapFaces = new Set();
    r.overlaps.forEach(function (o) { overlapFaces.add(o.a); overlapFaces.add(o.b); });
    for (var i = 0; i < n; i++) {
      var m = r.metrics[i];
      if (m.degenerate) { deg++; continue; }
      validCount++;
      if (m.mirrored) mirror++;
      if (m.outside) outside++;
    }
    $('tileTotal').textContent = n;
    $('tileValidSub').textContent = validCount + ' 个有效面参与统计';
    $('tileOverlap').textContent = r.overlaps.length;
    $('tileOverlapSub').textContent = overlapFaces.size + ' 个面涉及';
    $('tileMirror').textContent = mirror;
    $('tileOutside').textContent = outside;
    $('tileStretch').textContent = sset.size;
    $('tileStretchSub').textContent = '拉伸比 ≥ ' + state.stretchThreshold;
    $('tileDegenerate').textContent = deg;
  }

  function applyFiltersToViews() {
    var sets = computeFilterSets();
    threeView.setFilter(sets.set, sets.stretchSet);
    uvView.setFilters(sets.set, sets.stretchSet);
    var on = anyFilterOn();
    var total = state.data.faces.length;
    $('filterCount').textContent = on ? ('匹配 ' + sets.set.size + ' / ' + total + ' 面（其余变暗）') : ('全部 ' + total + ' 面');
  }

  function faceBadges(i) {
    var r = state.result, m = r.metrics[i], out = [];
    if (m.degenerate) out.push(['degenerate', '退化']);
    if (r.facePairs[i].length) out.push(['overlap', '重叠×' + r.facePairs[i].length]);
    if (m.mirrored) out.push(['mirror', '镜像']);
    if (m.outside) out.push(['outside', '越界']);
    if (r.valid[i] && r.metrics[i].stretch >= state.stretchThreshold) out.push(['stretch', '拉伸']);
    return out;
  }

  function overlapAreaTotal(i) {
    return state.result.facePairs[i].reduce(function (s, p) { return s + p.area; }, 0);
  }

  function sortedFilteredRows() {
    var sets = computeFilterSets();
    var rows = [];
    for (var i = 0; i < state.data.faces.length; i++) {
      if (sets.set && !sets.set.has(i)) continue;
      rows.push(i);
    }
    var key = state.sortKey, dir = state.sortDir;
    rows.sort(function (a, b) {
      var va = sortValue(a, key), vb = sortValue(b, key);
      if (va === vb) return a - b;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    return rows;
  }

  function sortValue(i, key) {
    var m = state.result.metrics[i];
    if (key === 'id') return i;
    if (key === 'overlapArea') return overlapAreaTotal(i);
    var v = m[key];
    return v === null || v === undefined || !isFinite(v) ? null : v;
  }

  function renderTable() {
    if (!state.result) return;
    var rows = sortedFilteredRows();
    var pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    var start = state.page * state.pageSize;
    var slice = rows.slice(start, start + state.pageSize);
    var html = slice.map(function (i) {
      var m = state.result.metrics[i];
      var badges = faceBadges(i).map(function (b) {
        return '<span class="mini-badge ' + b[0] + '">' + b[1] + '</span>';
      }).join('') || '<span class="mini-badge ' + (m.degenerate ? 'degenerate' : '') + '" style="opacity:.55">—</span>';
      return '<tr data-face="' + i + '"' + (i === state.selection ? ' class="selected"' : '') + '>' +
        '<td>#' + i + '</td>' +
        '<td class="num">' + (m.areaRatio === null ? '—' : fmt(m.areaRatio)) + '</td>' +
        '<td class="num">' + (m.svHi === null ? '—' : fmt(m.svHi)) + '</td>' +
        '<td class="num">' + (m.svLo === null ? '—' : fmt(m.svLo)) + '</td>' +
        '<td class="num">' + (m.stretch === null ? '—' : fmt(m.stretch, 2)) + '</td>' +
        '<td><div class="mini-badges">' + badges + '</div></td>' +
        '<td class="num">' + (state.result.facePairs[i].length ? fmtSci(overlapAreaTotal(i)) : '—') + '</td>' +
        '</tr>';
    }).join('');
    $('faceTbody').innerHTML = html || '<tr><td colspan="7" style="padding:18px;text-align:center;color:var(--faint)">当前筛选没有匹配的面</td></tr>';
    $('pageInfo').textContent = '第 ' + (state.page + 1) + '/' + pages + ' 页 · ' + rows.length + ' 面';
    $('btnPagePrev').disabled = state.page === 0;
    $('btnPageNext').disabled = state.page >= pages - 1;

    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      var arrow = th.querySelector('.arrow');
      arrow.textContent = th.dataset.sort === state.sortKey ? (state.sortDir > 0 ? '▲' : '▼') : '';
    });
  }

  function scrollTableToSelection() {
    var row = document.querySelector('#faceTbody tr.selected');
    if (!row) return;
    // Only scroll inside the table container; never move the whole page.
    var scroller = document.querySelector('.table-scroll');
    var r = row.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    if (r.top < s.top || r.bottom > s.bottom) {
      scroller.scrollTop += r.top - s.top - 8;
    }
  }

  function renderDetail() {
    var id = state.selection;
    $('detailId').textContent = id >= 0 ? ('#' + id) : '未选择';
    var canCycle = state.cycle.length > 1;
    $('btnPrevCycle').disabled = !canCycle;
    $('btnNextCycle').disabled = !canCycle;
    $('cyclePos').textContent = canCycle ? ((state.cyclePos + 1) + ' / ' + state.cycle.length + '（' + state.cycle.map(function (f) { return '#' + f; }).join(' ') + '）') : '';
    if (id < 0 || !state.result) {
      $('detailBadges').innerHTML = '<span class="empty-note">在任一视图中点选一个面。</span>';
      $('metricList').innerHTML = '';
      $('pairList').innerHTML = '<span class="empty-note">该面没有正面积重叠。</span>';
      $('pairCount').textContent = '';
      return;
    }
    var m = state.result.metrics[i0(id)];
    var badges = faceBadges(id);
    $('detailBadges').innerHTML = badges.length
      ? badges.map(function (b) { return '<span class="badge ' + b[0] + '">' + b[1] + '</span>'; }).join('')
      : '<span class="badge ok">正常</span>';

    var rows = [
      ['3D 面积', m.area3 === null ? '—' : fmtSci(m.area3)],
      ['UV 面积', m.areaUv === null ? '—' : fmtSci(m.areaUv)],
      ['面积倍率 (UV/3D)', m.areaRatio === null ? '—' : fmt(m.areaRatio)],
      ['主伸缩率 σ 大', m.svHi === null ? '—' : fmt(m.svHi)],
      ['主伸缩率 σ 小', m.svLo === null ? '—' : fmt(m.svLo)],
      ['拉伸比 σ大/σ小', m.stretch === null ? '—（退化面不参与统计）' : fmt(m.stretch, 4)],
      ['UV 有向面积', fmtSci(m.signedUv) + (m.mirrored ? '（负 → 镜像）' : '')],
      ['顶点索引', state.data.faces[id].join(', ')]
    ];
    $('metricList').innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span>';
    }).join('');

    var pairs = state.result.facePairs[id].slice().sort(function (a, b) { return b.area - a.area; });
    $('pairCount').textContent = pairs.length ? ('(' + pairs.length + ')') : '';
    $('pairList').innerHTML = pairs.length ? pairs.map(function (p) {
      var other = p.a === id ? p.b : p.a;
      return '<div class="pair-row" data-pair="' + p.a + '-' + p.b + '">' +
        '<span class="mono">#' + p.a + '</span><span>↔</span><span class="mono">#' + p.b + '</span>' +
        '<span class="area">' + fmtSci(p.area) + '</span></div>';
    }).join('') : '<span class="empty-note">该面没有正面积重叠。共边或仅共点不计入。</span>';
  }
  function i0(id) { return id; }

  /* ---------------- exports ---------------- */
  function buildCsv() {
    var r = state.result;
    var header = ['face', 'area_3d', 'area_uv', 'area_ratio', 'sigma_hi', 'sigma_lo',
      'stretch_ratio', 'mirrored', 'outside', 'degenerate', 'overlap_pairs', 'overlap_area_total'];
    var lines = [header.join(',')];
    for (var i = 0; i < state.data.faces.length; i++) {
      var m = r.metrics[i];
      var pairIds = r.facePairs[i].map(function (p) { return (p.a === i ? p.b : p.a); }).join(';');
      lines.push([
        i,
        m.area3, m.areaUv,
        m.areaRatio === null ? '' : m.areaRatio,
        m.svHi === null ? '' : m.svHi,
        m.svLo === null ? '' : m.svLo,
        m.stretch === null || !isFinite(m.stretch) ? '' : m.stretch,
        m.mirrored ? 1 : 0, m.outside ? 1 : 0, m.degenerate ? 1 : 0,
        '"' + pairIds + '"',
        r.facePairs[i].length ? overlapAreaTotal(i) : 0
      ].join(','));
    }
    return '﻿' + lines.join('\n');
  }

  function buildJsonReport() {
    var r = state.result;
    return {
      source: state.name,
      generated_at: new Date().toISOString(),
      conventions: {
        uv_origin: 'bottom-left',
        degenerate_threshold: UVAudit.EPS_DEG,
        overlap_area_threshold: UVAudit.EPS_OVL,
        mask_size: UVAudit.MASK_SIZE,
        note: '退化面不参与重叠与伸缩统计；共边或仅共点不计为重叠'
      },
      summary: {
        faces: state.data.faces.length,
        valid_faces: r.valid.filter(Boolean).length,
        overlap_pairs: r.overlaps.length,
        mirrored: r.metrics.map(function (m, i) { return m.mirrored ? i : -1; }).filter(function (i) { return i >= 0; }),
        outside: r.metrics.map(function (m, i) { return m.outside ? i : -1; }).filter(function (i) { return i >= 0; }),
        degenerate: r.metrics.map(function (m, i) { return m.degenerate ? i : -1; }).filter(function (i) { return i >= 0; }),
        mask_covered_pixels: r.mask.reduce(function (s, x) { return s + x; }, 0)
      },
      overlaps: r.overlaps.map(function (o) {
        return { faces: [o.a, o.b], area: o.area, centroid_uv: o.centroid };
      }),
      faces: r.metrics.map(function (m, i) {
        return {
          face: i,
          area_3d: m.area3,
          area_uv: m.areaUv,
          area_ratio: m.areaRatio,
          sigma_hi: m.svHi,
          sigma_lo: m.svLo,
          stretch_ratio: m.stretch === Infinity ? null : m.stretch,
          mirrored: m.mirrored,
          outside: m.outside,
          degenerate: m.degenerate,
          overlap_with: r.facePairs[i].map(function (p) { return p.a === i ? p.b : p.a; }),
          overlap_area_total: overlapAreaTotal(i)
        };
      })
    };
  }

  function renderMaskPng() {
    var r = state.result, size = r.maskSize;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(size, size);
    for (var p = 0; p < size * size; p++) {
      var v = r.mask[p] ? 255 : 0;
      img.data[p * 4] = v;
      img.data[p * 4 + 1] = v;
      img.data[p * 4 + 2] = v;
      img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function baseName() { return state.name.replace(/\.json$/i, '') || 'uv-audit'; }

  function openModal(title, node, note, downloadable, copyText) {
    $('modalTitle').textContent = title;
    var body = $('modalBody');
    body.innerHTML = '';
    body.appendChild(node);
    $('modalNote').textContent = note || '';
    $('modalDownload').hidden = !downloadable;
    $('modalCopy').hidden = !copyText;
    $('modalBackdrop').hidden = false;
    $('modalBackdrop')._copyText = copyText || null;
    $('modalBackdrop')._blob = downloadable || null;
  }
  function closeModal() { $('modalBackdrop').hidden = true; }

  function exportCsv() {
    var text = buildCsv();
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    openModal('导出逐面 CSV 报告', document.createTextNode('共 ' + state.data.faces.length + ' 行，含面积倍率、两个主伸缩率、拉伸比、标记与重叠面号。'),
      '若浏览器拦截了自动下载，可用“复制内容”后另存为 .csv。',
      { blob: blob, name: baseName() + '-faces.csv' }, text);
  }
  function exportJson() {
    var text = JSON.stringify(buildJsonReport(), null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var ta = document.createElement('textarea');
    ta.value = text;
    openModal('导出 JSON 报告', ta, '含摘要、全部重叠对（面积与重心）和逐面指标。',
      { blob: blob, name: baseName() + '-report.json' }, text);
  }
  function exportPng() {
    var cv = renderMaskPng();
    var img = document.createElement('img');
    img.className = 'preview-img';
    img.src = cv.toDataURL('image/png');
    var covered = state.result.mask.reduce(function (s, x) { return s + x; }, 0);
    var desc = document.createElement('p');
    desc.className = 'note';
    desc.style.textAlign = 'center';
    desc.textContent = '256×256，白色像素 = 被至少两个有效面占据（按像素中心判定，共边接触不计）。覆盖 ' + covered + ' 像素。';
    var wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '10px';
    wrap.appendChild(img);
    wrap.appendChild(desc);
    cv.toBlob(function (blob) {
      openModal('导出重叠遮罩 PNG', wrap, '白色为重叠遮罩、黑色为背景；行序按 PNG 自上而下，对应 v 从 1 到 0。',
        { blob: blob, name: baseName() + '-overlap-mask-256.png' }, null);
    }, 'image/png');
  }

  /* ---------------- wiring ---------------- */
  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () { loadProject(file.name, String(reader.result)); };
    reader.onerror = function () { setError(file.name, '文件读取失败：' + (reader.error && reader.error.message || '未知错误')); };
    reader.readAsText(file);
  }

  function wire() {
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('btnChooseFile').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      if (e.target.files[0]) readFile(e.target.files[0]);
      e.target.value = '';
    });

    var sampleButtons = [
      ['btnSampleSmall', 'small'], ['btnSampleSmall2', 'small'],
      ['btnSampleGrid', 'grid'], ['btnSampleGrid2', 'grid']
    ];
    sampleButtons.forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () {
        var s = window.SAMPLES[pair[1]];
        loadProject(s.name, JSON.stringify(s.data));
      });
    });

    $('btnCancel').addEventListener('click', cancelAnalysis);
    $('btnTheme').addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });

    // drag & drop anywhere on the page
    ['dragover', 'dragenter'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        $('dropzone').classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && e.relatedTarget) return;
        $('dropzone').classList.remove('dragover');
      });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    });

    // filters — the whole label is one toggle; no nested checkbox to double-fire.
    document.querySelectorAll('.filter-chip[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.dataset.filter;
        state.filters[key] = !state.filters[key];
        chip.classList.toggle('on', state.filters[key]);
        chip.setAttribute('aria-pressed', state.filters[key] ? 'true' : 'false');
        if (state.result) { state.page = 0; applyFiltersToViews(); renderTable(); }
      });
    });
    $('stretchThreshold').addEventListener('input', function (e) {
      var v = parseFloat(e.target.value);
      state.stretchThreshold = isFinite(v) && v >= 1 ? v : 2;
      if (state.result) { renderTiles(); applyFiltersToViews(); renderTable(); renderDetail(); }
    });
    $('btnClearFilter').addEventListener('click', function () {
      Object.keys(state.filters).forEach(function (k) { state.filters[k] = false; });
      document.querySelectorAll('.filter-chip').forEach(function (c) {
        c.classList.remove('on');
        c.setAttribute('aria-pressed', 'false');
      });
      if (state.result) { applyFiltersToViews(); state.page = 0; renderTable(); }
    });

    // overlays
    $('chkMask').addEventListener('change', function (e) {
      $('chipMask').classList.toggle('on', e.target.checked);
      uvView.setOverlay(e.target.checked, $('chkOvl').checked);
    });
    $('chkOvl').addEventListener('change', function (e) {
      $('chipOvl').classList.toggle('on', e.target.checked);
      uvView.setOverlay($('chkMask').checked, e.target.checked);
    });
    $('btnReset3d').addEventListener('click', function () { threeView && threeView.resetView(); });
    $('btnResetUv').addEventListener('click', function () { uvView && uvView.resetView(); });

    // selection cycling
    $('btnPrevCycle').addEventListener('click', function () { cycleStep(-1); });
    $('btnNextCycle').addEventListener('click', function () { cycleStep(1); });
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === ',') cycleStep(-1);
      if (e.key === '.') cycleStep(1);
    });

    // table
    $('faceTbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-face]');
      if (!tr) return;
      selectFace(Number(tr.dataset.face), [Number(tr.dataset.face)]);
    });
    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = 1; }
        renderTable();
      });
    });
    $('btnPagePrev').addEventListener('click', function () { state.page--; renderTable(); });
    $('btnPageNext').addEventListener('click', function () { state.page++; renderTable(); });
    $('pageSize').addEventListener('change', function (e) {
      state.pageSize = Number(e.target.value); state.page = 0; renderTable();
    });

    // pair rows
    $('pairList').addEventListener('click', function (e) {
      var row = e.target.closest('.pair-row');
      if (!row) return;
      var parts = row.dataset.pair.split('-').map(Number);
      selectFace(parts[0], parts);
    });

    // exports
    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnExportJson').addEventListener('click', exportJson);
    $('btnExportPng').addEventListener('click', exportPng);
    $('modalClose').addEventListener('click', closeModal);
    $('modalBackdrop').addEventListener('click', function (e) {
      if (e.target === $('modalBackdrop')) closeModal();
    });
    $('modalDownload').addEventListener('click', function () {
      var spec = $('modalBackdrop')._blob;
      if (spec) downloadBlob(spec.blob, spec.name);
    });
    $('modalCopy').addEventListener('click', function () {
      var text = $('modalBackdrop')._copyText;
      if (!text) return;
      var ta = $('modalBody').querySelector('textarea');
      function fallback() { if (ta) { ta.select(); document.execCommand('copy'); } }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(fallback);
      } else fallback();
    });
  }

  /* ---------------- boot ---------------- */
  try {
    var saved = localStorage.getItem('uva-theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* ignore */ }
  wire();
})();
