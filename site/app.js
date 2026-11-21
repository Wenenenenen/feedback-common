/* 接力回放导播台 —— 页面逻辑 */
(function () {
  'use strict';

  var RD = window.ReplayDirector;

  /* ---------- 镜头配色（8 色循环，明暗主题各一套） ---------- */
  var SHOT_HUES = [
    { light: '#1d5fc0', dark: '#6ea2ef' },
    { light: '#0f8a6d', dark: '#5fc994' },
    { light: '#b97a0f', dark: '#e0b35e' },
    { light: '#a8433c', dark: '#ef8a7d' },
    { light: '#7a3fc0', dark: '#b892e8' },
    { light: '#0f85a0', dark: '#5ec3dd' },
    { light: '#c05a2a', dark: '#f09869' },
    { light: '#5b6f1e', dark: '#a8c46a' }
  ];
  function shotColor(idx) {
    var c = SHOT_HUES[idx % SHOT_HUES.length];
    return document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) ? c.dark : c.light;
  }

  /* ---------- 全局状态 ---------- */
  var state = {
    rawInput: null,          // 当前输入（参数可能被表单覆盖）
    model: null,
    result: null,            // 求解结果（成功或失败）
    locks: new Map(),
    currentBeat: 0,
    playing: false,
    playTimer: null
  };

  function $(id) { return document.getElementById(id); }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function fmtNum(x) {
    if (x == null) return '—';
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ---------- 主题 ---------- */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('rpd-theme'); } catch (e) { /* 忽略 */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('rpd-theme', next); } catch (e) { /* 忽略 */ }
      renderAll();
    });
  }

  /* ---------- 数据加载 ---------- */
  function effectiveInput() {
    // 以表单参数覆盖输入中的参数
    var input = JSON.parse(JSON.stringify(state.rawInput));
    input.inset = parseFloat($('insetInput').value);
    input.cutCost = parseFloat($('cutCostInput').value);
    input.cutGap = parseInt($('cutGapInput').value, 10);
    return input;
  }

  function loadInput(obj) {
    // 先构建模型做完整校验
    var model = RD.buildModel(obj);
    state.rawInput = obj;
    state.locks = new Map();
    state.currentBeat = 0;
    stopPlay();
    $('insetInput').value = model.inset;
    $('cutCostInput').value = model.cutCost;
    $('cutGapInput').value = model.cutGap;
    $('jsonInput').value = JSON.stringify(obj, null, 2);
    $('dataWarnings').textContent = '';
    solveAndRender();
  }

  function solveAndRender() {
    stopPlay();
    var input;
    try {
      input = effectiveInput();
      state.model = RD.buildModel(input);
    } catch (e) {
      toast('输入无效：' + e.message, true);
      return;
    }

    // 参数或数据变化后，清理已不再可行的锁定（镜头消失或覆盖不了必拍）
    var dropped = [];
    Array.from(state.locks.keys()).forEach(function (bi) {
      var si = state.locks.get(bi);
      if (bi >= state.model.beats.length ||
          si >= state.model.shotIds.length ||
          !state.model.perBeat[bi].options[si].feasible) {
        dropped.push(bi + 1);
        state.locks.delete(bi);
      }
    });

    var locksObj = {};
    state.locks.forEach(function (si, bi) { locksObj[bi] = state.model.shotIds[si]; });
    var result = RD.solve(state.model, locksObj);
    state.result = result;

    // 清理失效锁定（锁定的镜头在新模型中不存在等情况由 normalizeLocks 警告）
    var warn = (result.warnings || []).slice();
    if (dropped.length) warn.unshift('以下拍的锁定因参数/数据变化已失效并解除：' + dropped.join('、'));
    $('dataWarnings').textContent = warn.length ? '⚠ ' + warn.join('；') : '';

    state.currentBeat = Math.min(state.currentBeat, state.model.beats.length - 1);
    renderAll();
  }

  /* ---------- 渲染入口 ---------- */
  function renderAll() {
    renderStatus();
    renderShotList();
    renderFollowList();
    renderField();
    renderTimeline();
    renderBeatPanel();
    renderSummary();
    renderDetailTable();
    renderFailureBanner();
    renderPlayerButtons();
  }

  function renderStatus() {
    var pill = $('statusPill');
    if (!state.result) {
      pill.className = 'pill';
      pill.textContent = '未求解';
      return;
    }
    if (state.result.ok) {
      pill.className = 'pill ok';
      pill.textContent = '✓ 已排出 ' + state.result.sequence.length + ' 拍 · 总成本 ' + state.result.totalCost;
    } else {
      pill.className = 'pill fail';
      pill.textContent = '✕ 第 ' + (state.result.firstImpossibleBeat + 1) + ' 拍无法排镜';
    }
  }

  function renderFailureBanner() {
    var el = $('failureBanner');
    var r = state.result;
    if (!r || r.ok) { el.hidden = true; el.innerHTML = ''; return; }
    var reasonText = {
      'no-eligible': '没有任何候选镜头能完整覆盖本拍的必拍目标',
      'lock-infeasible': '锁定的镜头无法覆盖本拍必拍目标',
      'lock-blocked': '锁定镜头与前面的硬切间距约束冲突',
      'cut-gap': '所有可达镜头都会造成硬切，且与上一次硬切的拍号差小于 cutGap = ' + state.model.cutGap
    }[r.reason] || '约束冲突';
    el.hidden = false;
    el.className = 'banner';
    el.innerHTML = '<span class="big">第 ' + (r.firstImpossibleBeat + 1) + ' 拍排不下去</span>' +
      '<div><p>' + esc(reasonText) + '。</p>' +
      '<p class="hint">此前 ' + r.firstImpossibleBeat + ' 拍存在可达前缀，已在时间轴中用虚线文字标出；可调整锁定、inset 或 cutGap 后重新计算。</p></div>';
  }

  /* ---------- 镜头列表 ---------- */
  function renderShotList() {
    var host = $('shotList');
    if (!state.model) { host.innerHTML = '<p class="hint">加载数据后显示镜头。</p>'; return; }
    host.innerHTML = '';
    state.model.shotIds.forEach(function (id, si) {
      var rect = state.model.shotRects[si];
      var chip = document.createElement('div');
      chip.className = 'shot-chip';
      chip.style.justifyContent = 'space-between';
      var lockedHere = state.locks.get(state.currentBeat) === si;
      if (lockedHere) chip.classList.add('locked');
      var feasible = state.model.perBeat[state.currentBeat].options[si].feasible;
      if (!feasible) chip.classList.add('infeasible');
      chip.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px;min-width:0">' +
        '<span class="dot" style="background:' + shotColor(si) + '"></span>' +
        '<span>#' + si + ' ' + esc(id) + '</span></span>' +
        '<span class="hint mono" style="text-decoration:none">[' + rect.join(', ') + ']</span>';
      chip.title = feasible
        ? '点击将第 ' + (state.currentBeat + 1) + ' 拍锁定为 ' + id + (lockedHere ? '（再次点击解除）' : '')
        : '该镜头在第 ' + (state.currentBeat + 1) + ' 拍无法覆盖必拍目标，不可锁定';
      chip.addEventListener('click', function () {
        if (!feasible) { toast('该镜头在本拍无法覆盖必拍目标', true); return; }
        toggleLock(state.currentBeat, si);
      });
      host.appendChild(chip);
    });
  }

  function renderFollowList() {
    var el = $('followList');
    if (!state.model) { el.textContent = ''; return; }
    var edges = [];
    state.model.follow.forEach(function (cost, key) {
      var parts = key.split(' ');
      edges.push(parts[0] + ' → ' + parts[1] + '（' + cost + '）');
    });
    el.innerHTML = '<span class="hint">跟拍边：</span>' +
      (edges.length ? esc(edges.join('，')) : '<span class="hint">无（异镜切换一律按硬切 ' + state.model.cutCost + ' 计）</span>');
  }

  function toggleLock(bi, si) {
    if (state.locks.get(bi) === si) state.locks.delete(bi);
    else state.locks.set(bi, si);
    solveAndRender();
  }

  /* ---------- 场地 SVG ---------- */
  var SVG_PAD = 34;

  function renderField() {
    var svg = $('fieldSvg');
    $('fieldTitle').textContent = state.model
      ? '场地取景 · 第 ' + (state.currentBeat + 1) + ' 拍 / 共 ' + state.model.beats.length + ' 拍'
      : '场地取景';
    if (!state.model) { svg.innerHTML = ''; $('fieldLegend').innerHTML = ''; return; }

    var m = state.model;
    var bi = state.currentBeat;
    var allRects = m.shotRects.slice();
    m.beats.forEach(function (b) {
      b.required.forEach(function (r) { allRects.push(r); });
      b.optional.forEach(function (o) { allRects.push(o.box); });
    });
    var minX = Math.min.apply(null, allRects.map(function (r) { return r[0]; }));
    var minY = Math.min.apply(null, allRects.map(function (r) { return r[1]; }));
    var maxX = Math.max.apply(null, allRects.map(function (r) { return r[2]; }));
    var maxY = Math.max.apply(null, allRects.map(function (r) { return r[3]; }));
    var spanX = Math.max(1, maxX - minX);
    var spanY = Math.max(1, maxY - minY);

    var W = 760, H = 300;
    var availW = W - SVG_PAD * 2;
    var availH = H - SVG_PAD * 2;
    var scale = Math.min(availW / spanX, availH / spanY);
    // 水平左对齐，垂直居中
    var drawW = spanX * scale;
    var drawH = spanY * scale;
    var ox = SVG_PAD + (availW - drawW) / 2 - minX * scale;
    var oy = SVG_PAD + (availH - drawH) / 2 - minY * scale;
    function px(x) { return ox + x * scale; }
    function py(y) { return oy + y * scale; }

    var parts = [];
    parts.push('<rect x="' + px(minX) + '" y="' + py(minY) + '" width="' + drawW + '" height="' + drawH +
      '" rx="6" fill="var(--field)" stroke="var(--field-line)" stroke-width="1.5"/>');
    // 中线（场地水平中线）
    var midY = (minY + maxY) / 2;
    parts.push('<line x1="' + px(minX) + '" y1="' + py(midY) + '" x2="' + px(maxX) + '" y2="' + py(midY) +
      '" stroke="var(--field-line)" stroke-width="1" stroke-dasharray="6 5"/>');

    // 全部候选镜头（非当前用浅色，当前镜头突出）
    var activeShot = currentShotIdx();
    m.shotRects.forEach(function (rect, si) {
      var isActive = si === activeShot;
      var col = shotColor(si);
      var x = px(rect[0]), y = py(rect[1]);
      var w = Math.max(1, (rect[2] - rect[0]) * scale);
      var h = Math.max(1, (rect[3] - rect[1]) * scale);
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4" ' +
        'fill="' + col + '" fill-opacity="' + (isActive ? 0.16 : 0.05) + '" ' +
        'stroke="' + col + '" stroke-width="' + (isActive ? 2.4 : 1) + '" ' +
        'stroke-dasharray="' + (isActive ? 'none' : '5 4') + '"/>');
      parts.push('<text x="' + (x + 6) + '" y="' + (y + 15) + '" font-size="13" font-weight="700" ' +
        'font-family="var(--font-display)" fill="' + col + '">' + esc(m.shotIds[si]) + '</text>');
    });

    // 当前镜头安全框
    if (activeShot != null) {
      var sf = m.safe[activeShot];
      parts.push('<rect x="' + px(sf[0]) + '" y="' + py(sf[1]) +
        '" width="' + Math.max(1, (sf[2] - sf[0]) * scale) + '" height="' + Math.max(1, (sf[3] - sf[1]) * scale) +
        '" rx="3" fill="none" stroke="var(--good)" stroke-width="1.6" stroke-dasharray="3 3"/>');
    }

    var beat = m.beats[bi];
    // 必拍目标：实心描边
    beat.required.forEach(function (r) {
      drawTarget(parts, r, px, py, scale, 'var(--good)', 2, true);
    });
    // 可选目标：入镜实心、漏拍红色虚线
    beat.optional.forEach(function (o) {
      var covered = activeShot != null && RD.contains(m.safe[activeShot], o.box);
      drawTarget(parts, o.box, px, py, scale, covered ? 'var(--good)' : 'var(--cut)', 1.6, covered, o.weight);
    });

    parts.push('');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = parts.join('');

    // 图例
    var legend = [
      ['var(--field-line)', '候选镜头（实线=当前，虚线=其他）'],
      ['var(--good)', '安全框 / 已入镜目标'],
      ['var(--cut)', '漏拍可选目标']
    ];
    $('fieldLegend').innerHTML = legend.map(function (it) {
      return '<span class="item"><span class="swatch" style="background:' + it[0] + '"></span>' + it[1] + '</span>';
    }).join('') + '<span class="item">数字为可选目标权重；坐标比例按场地实际尺寸等比缩放</span>';
  }

  function drawTarget(parts, r, px, py, scale, color, sw, filled, weight) {
    var x = px(r[0]), y = py(r[1]);
    var w = Math.max(2, (r[2] - r[0]) * scale);
    var h = Math.max(2, (r[3] - r[1]) * scale);
    parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2" ' +
      'fill="' + color + '" fill-opacity="' + (filled ? 0.28 : 0.08) + '" ' +
      'stroke="' + color + '" stroke-width="' + sw + '"' +
      (filled ? '' : ' stroke-dasharray="4 3"') + '/>');
    if (weight != null) {
      parts.push('<text x="' + (x + w / 2) + '" y="' + (y - 4) + '" font-size="11" ' +
        'text-anchor="middle" font-family="var(--font-mono)" fill="' + color + '">w' + weight + '</text>');
    }
  }

  /* 当前拍实际使用的镜头序号；失败拍/无方案时为 null */
  function currentShotIdx() {
    var r = state.result;
    if (!r) return null;
    if (r.ok) return r.sequenceIdx[state.currentBeat];
    // 失败：仅前缀拍有镜头
    if (state.currentBeat < r.firstImpossibleBeat && r.prefixBest) {
      return r.prefixBest.sequenceIdx[state.currentBeat];
    }
    return null;
  }

  /* ---------- 时间轴 ---------- */
  function renderTimeline() {
    var ruler = $('tlRuler');
    var tl = $('timeline');
    ruler.innerHTML = '';
    tl.innerHTML = '';
    if (!state.model) return;

    var n = state.model.beats.length;
    for (var bi = 0; bi < n; bi++) {
      var sp = document.createElement('span');
      sp.textContent = bi + 1;
      ruler.appendChild(sp);

      var cell = document.createElement('div');
      cell.className = 'beat-cell';
      if (bi === state.currentBeat) cell.classList.add('current');

      var shotIdx = shotIdxAt(bi);
      var impossible = state.result && !state.result.ok && bi === state.result.firstImpossibleBeat;
      if (impossible) cell.classList.add('impossible');
      if (shotIdx == null) cell.classList.add('empty');

      var marks = '';
      if (state.result && state.result.ok) {
        var d = state.result.details[bi];
        if (d.transition === 'cut') marks += '<span class="mark cut" title="硬切">切</span>';
        if (d.transition === 'follow') marks += '<span class="mark follow" title="跟拍边">跟</span>';
        if (d.missed.length) marks += '<span class="mark miss" title="漏拍 ' + d.missed.length + ' 个">漏' + d.missed.length + '</span>';
      }
      if (state.locks.has(bi)) marks += '<span class="mark lock" title="已锁定">锁</span>';

      cell.innerHTML =
        '<span class="beat-no">#' + (bi + 1) + '</span>' +
        '<span class="shot-name" style="background:' + (shotIdx == null ? 'var(--border)' : shotColor(shotIdx)) + '">' +
          (shotIdx == null ? '–' : esc(state.model.shotIds[shotIdx])) + '</span>' +
        '<span class="mark-row">' + marks + '</span>';
      cell.addEventListener('click', function (idx) {
        state.currentBeat = idx;
        renderField();
        renderTimeline();
        renderBeatPanel();
        renderDetailTable();
        renderPlayerButtons();
      }.bind(null, bi));
      tl.appendChild(cell);
    }
  }

  function shotIdxAt(bi) {
    var r = state.result;
    if (!r) return null;
    if (r.ok) return r.sequenceIdx[bi];
    if (bi < r.firstImpossibleBeat && r.prefixBest) {
      return r.prefixBest.sequenceIdx[bi];
    }
    return null;
  }

  /* ---------- 本拍面板 ---------- */
  function renderBeatPanel() {
    var host = $('beatPanel');
    $('beatPanelTitle').textContent = state.model
      ? '第 ' + (state.currentBeat + 1) + ' 拍信息'
      : '本拍信息';
    if (!state.model) { host.innerHTML = '<p class="hint">加载数据后显示。</p>'; return; }
    var m = state.model;
    var bi = state.currentBeat;
    var beat = m.beats[bi];
    var si = currentShotIdx();
    var opt = m.perBeat[bi].options;

    var html = '<div class="kv"><span>必拍目标</span><b>' + beat.required.length + ' 个</b></div>';
    html += '<div class="hint mono">' + (beat.required.length ? beat.required.map(function (r) { return '[' + r.join(', ') + ']'; }).join(' ') : '（无）') + '</div>';
    html += '<div class="kv"><span>可选目标</span><b>' + beat.optional.length + ' 个（总权重 ' +
      beat.optional.reduce(function (a, o) { return a + o.weight; }, 0) + '）</b></div>';

    if (state.locks.has(bi)) {
      html += '<p><span class="tag lock">已锁定为 ' + esc(m.shotIds[state.locks.get(bi)]) + '</span> ' +
        '<button class="ghost danger-text small" id="unlockHereBtn" type="button">解除本拍锁定</button></p>';
    }

    html += '<div><label>点镜头卡锁定本拍（灰色 = 无法覆盖必拍）</label><div id="beatShotChips" style="display:flex;gap:8px;flex-wrap:wrap"></div></div>';

    if (state.result && state.result.ok) {
      var d = state.result.details[bi];
      var transText = d.transition
        ? { stay: '保持同镜（0）', follow: '跟拍边（' + d.transitionCost + '）', cut: '硬切（' + d.transitionCost + '）' }[d.transition]
        : '首拍（无前序镜头）';
      html += '<div class="kv"><span>切换</span><b>' + transText + '</b></div>';
      html += '<div class="kv"><span>漏拍代价</span><b>' + d.missCost + '</b></div>';
      html += '<div class="kv"><span>本拍合计 / 累计</span><b>' + d.subtotal + ' / ' + d.cumulative + '</b></div>';
      if (d.missed.length) {
        html += '<div class="miss-list">漏拍：' + d.missed.map(function (o) {
          return '[' + o.box.join(', ') + '] 权重 ' + o.weight;
        }).join('；') + '</div>';
      }
    } else if (state.result && !state.result.ok && bi === state.result.firstImpossibleBeat) {
      html += '<p class="miss-list">本拍即为最早无法排下去的拍。</p>';
    }

    host.innerHTML = html;

    var chips = $('beatShotChips');
    opt.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'shot-chip' + (!o.feasible ? ' infeasible' : '') + (state.locks.get(bi) === o.idx ? ' locked' : '');
      b.innerHTML = '<span class="dot" style="background:' + shotColor(o.idx) + '"></span>#' + o.idx + ' ' + esc(o.id) +
        (o.feasible ? '<span class="hint mono" style="text-decoration:none">漏拍 ' + o.missCost + '</span>' : '<span class="hint" style="text-decoration:none">不可用</span>');
      b.addEventListener('click', function () {
        if (!o.feasible) { toast('该镜头无法覆盖本拍必拍目标', true); return; }
        toggleLock(bi, o.idx);
      });
      chips.appendChild(b);
    });

    var unlock = $('unlockHereBtn');
    if (unlock) unlock.addEventListener('click', function () {
      state.locks.delete(bi);
      solveAndRender();
    });
  }

  /* ---------- 汇总 ---------- */
  function renderSummary() {
    var host = $('summaryTiles');
    if (!state.model) { host.innerHTML = ''; return; }
    var m = state.model;
    var tiles;
    if (state.result.ok) {
      var r = state.result;
      var missTotal = r.details.reduce(function (a, d) { return a + d.missCost; }, 0);
      var cutTotal = r.details.reduce(function (a, d) { return a + d.transitionCost; }, 0);
      tiles = [
        ['总拍数', m.beats.length],
        ['总成本', r.totalCost],
        ['漏拍代价', missTotal],
        ['切换代价', cutTotal + '（硬切 ' + r.cutBeats.length + ' 次）']
      ];
    } else {
      tiles = [
        ['总拍数', m.beats.length],
        ['最早死拍', '#' + (state.result.firstImpossibleBeat + 1)],
        ['可达前缀', state.result.firstImpossibleBeat + ' 拍'],
        ['锁定数', state.locks.size]
      ];
    }
    host.innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="label">' + t[0] + '</div><div class="value">' + t[1] + '</div></div>';
    }).join('');
  }

  /* ---------- 明细表 ---------- */
  function renderDetailTable() {
    var body = $('detailBody');
    if (!state.model) { body.innerHTML = ''; return; }
    var m = state.model;
    var rows = '';

    if (state.result.ok) {
      state.result.details.forEach(function (d) {
        var transTag = d.transition ? {
          stay: '<span class="tag stay">保持</span>',
          follow: '<span class="tag follow">跟拍 ' + fmtNum(d.transitionCost) + '</span>',
          cut: '<span class="tag cut">硬切 ' + fmtNum(d.transitionCost) + '</span>'
        }[d.transition] : '<span class="hint">首拍</span>';
        rows += '<tr class="' + (d.beat === state.currentBeat ? 'current-row' : '') + '">' +
          '<td>#' + (d.beat + 1) + (d.locked ? ' <span class="tag lock">锁</span>' : '') + '</td>' +
          '<td><span style="display:inline-flex;align-items:center;gap:6px">' +
            '<span class="dot" style="width:9px;height:9px;border-radius:3px;background:' + shotColor(d.shotIdx) + ';display:inline-block"></span>' +
            '<b>' + esc(d.shot) + '</b></span></td>' +
          '<td>' + transTag + '</td>' +
          '<td class="num">' + fmtNum(d.missCost) + '</td>' +
          '<td class="num">' + fmtNum(d.transitionCost) + '</td>' +
          '<td class="num">' + fmtNum(d.subtotal) + '</td>' +
          '<td class="num">' + fmtNum(d.cumulative) + '</td>' +
          '<td>' + (d.missed.length ? d.missed.map(function (o) {
            return '<span class="tag miss">[' + o.box.join(',') + '] w' + o.weight + '</span>';
          }).join(' ') : '<span class="hint">无</span>') + '</td>' +
          '</tr>';
      });
    } else {
      // 失败：列出前缀拍 + 死拍
      var r2 = state.result;
      for (var bi = 0; bi < r2.firstImpossibleBeat; bi++) {
        var idx = shotIdxAt(bi);
        rows += '<tr class="' + (bi === state.currentBeat ? 'current-row' : '') + '">' +
          '<td>#' + (bi + 1) + (state.locks.has(bi) ? ' <span class="tag lock">锁</span>' : '') + '</td>' +
          '<td><b>' + esc(m.shotIds[idx]) + '</b></td><td colspan="5" class="hint">可达前缀（明细在成功求解后给出）</td><td>—</td></tr>';
      }
      rows += '<tr class="impossible-row"><td>#' + (r2.firstImpossibleBeat + 1) + '</td>' +
        '<td colspan="7"><b>无法排镜：</b>' + esc(reasonToText(r2.reason)) + '</td></tr>';
    }
    body.innerHTML = rows;
  }

  function reasonToText(reason) {
    return {
      'no-eligible': '无镜头可覆盖必拍目标',
      'lock-infeasible': '锁定镜头覆盖不了必拍目标',
      'lock-blocked': '锁定与硬切间距约束冲突',
      'cut-gap': '硬切间距不足（cutGap = ' + (state.model ? state.model.cutGap : '?') + '）'
    }[reason] || reason;
  }

  /* ---------- 播放 ---------- */
  function stopPlay() {
    state.playing = false;
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
    renderPlayerButtons();
  }

  function renderPlayerButtons() {
    var btn = $('playBtn');
    if (!state.model) { btn.disabled = true; btn.textContent = '▶ 播放'; $('beatReadout').textContent = '拍 — / —'; return; }
    btn.disabled = false;
    btn.textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
    var n = state.model.beats.length;
    $('beatReadout').textContent = '拍 ' + (state.currentBeat + 1) + ' / ' + n;
    $('prevBtn').disabled = state.currentBeat === 0;
    $('nextBtn').disabled = state.currentBeat >= n - 1;
  }

  function gotoBeat(bi) {
    state.currentBeat = Math.max(0, Math.min(bi, state.model.beats.length - 1));
    renderField();
    renderTimeline();
    renderBeatPanel();
    renderDetailTable();
    renderPlayerButtons();
    // 时间轴自动滚动到当前拍
    var cell = $('timeline').children[state.currentBeat];
    if (cell && cell.scrollIntoView) cell.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function initPlayer() {
    $('playBtn').addEventListener('click', function () {
      if (!state.model) return;
      if (state.playing) { stopPlay(); return; }
      // 失败时播到死拍为止；成功时循环播放
      state.playing = true;
      renderPlayerButtons();
      var tick = function () {
        var limit = state.model.beats.length - 1;
        if (state.result && !state.result.ok) limit = state.result.firstImpossibleBeat;
        if (state.currentBeat >= limit) { stopPlay(); return; }
        gotoBeat(state.currentBeat + 1);
      };
      state.playTimer = setInterval(tick, parseInt($('speedSelect').value, 10));
    });
    $('prevBtn').addEventListener('click', function () { stopPlay(); gotoBeat(state.currentBeat - 1); });
    $('nextBtn').addEventListener('click', function () { stopPlay(); gotoBeat(state.currentBeat + 1); });
    $('speedSelect').addEventListener('change', function () {
      if (state.playing) { stopPlay(); $('playBtn').click(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft' && state.model) { stopPlay(); gotoBeat(state.currentBeat - 1); }
      if (e.key === 'ArrowRight' && state.model) { stopPlay(); gotoBeat(state.currentBeat + 1); }
      if (e.key === ' ' && state.model) { e.preventDefault(); $('playBtn').click(); }
    });
  }

  /* ---------- 导出 ---------- */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildShotListCsv() {
    var r = state.result;
    if (!r.ok) return '';
    var head = ['拍号(1基)', '拍索引(0基)', '镜头', '切换类型', '来源镜头', '是否锁定'];
    var lines = [head.join(',')];
    r.details.forEach(function (d) {
      lines.push([
        d.beat + 1, d.beat, d.shot,
        d.transition ? { stay: '保持', follow: '跟拍', cut: '硬切' }[d.transition] : '首拍',
        d.fromShot || '', d.locked ? '是' : '否'
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\n');
  }

  function buildCostCsv() {
    var r = state.result;
    if (!r.ok) return '';
    var head = ['拍号(1基)', '镜头', '漏拍代价', '切换代价', '本拍合计', '累计成本', '硬切拍(0基)', '漏拍明细'];
    var lines = [head.join(',')];
    r.details.forEach(function (d) {
      var miss = d.missed.map(function (o) { return '[' + o.box.join('/') + ']w' + o.weight; }).join(' ');
      lines.push([
        d.beat + 1, d.shot, d.missCost, d.transitionCost, d.subtotal, d.cumulative,
        d.transition === 'cut' ? d.beat : '', miss
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\n');
  }

  function buildExportJson() {
    var r = state.result;
    var base = {
      generatedAt: new Date().toISOString(),
      params: {
        inset: state.model.inset,
        cutCost: state.model.cutCost,
        cutGap: state.model.cutGap
      },
      locks: Array.from(state.locks.keys()).map(function (bi) {
        return { beatIndex: bi, beatNumber: bi + 1, shot: state.model.shotIds[state.locks.get(bi)] };
      })
    };
    if (r.ok) {
      base.status = 'solved';
      base.totalCost = r.totalCost;
      base.cutBeats0Based = r.cutBeats;
      base.cutBeatNumbers = r.cutBeats.map(function (bi) { return bi + 1; });
      base.shots = r.details.map(function (d) {
        return {
          beatNumber: d.beat + 1,
          beatIndex: d.beat,
          shot: d.shot,
          transition: d.transition,
          fromShot: d.fromShot,
          missCost: d.missCost,
          transitionCost: d.transitionCost,
          subtotal: d.subtotal,
          cumulative: d.cumulative,
          missed: d.missed
        };
      });
    } else {
      base.status = 'infeasible';
      base.firstImpossibleBeatIndex = r.firstImpossibleBeat;
      base.firstImpossibleBeatNumber = r.firstImpossibleBeat + 1;
      base.reason = r.reason;
    }
    return JSON.stringify(base, null, 2);
  }

  function openExportModal() {
    if (!state.model) { toast('请先加载数据', true); return; }
    var r = state.result;
    var root = $('modalRoot');
    if (!r.ok) {
      root.innerHTML = '<div class="modal-backdrop"><div class="modal"><header><h2 style="font-size:16px">无法导出镜头单</h2>' +
        '<button id="modalClose" type="button">✕</button></header>' +
        '<div class="body"><p>当前排镜在第 <b>' + (r.firstImpossibleBeat + 1) + '</b> 拍失败（' + esc(reasonToText(r.reason)) +
        '），不存在完整镜头单。请调整锁定或参数后重新计算。</p></div>' +
        '<footer><button id="modalClose2" class="primary" type="button">知道了</button></footer></div></div>';
      wireClose();
      return;
    }
    var csv1 = buildShotListCsv();
    var csv2 = buildCostCsv();
    var json = buildExportJson();
    root.innerHTML =
      '<div class="modal-backdrop"><div class="modal">' +
      '<header><h2 style="font-size:16px">导出镜头单与代价明细</h2><button id="modalClose" type="button">✕</button></header>' +
      '<div class="body">' +
        exportBlock('镜头单 CSV（拍号、镜头、切换、锁定）', csv1, 'shot-list.csv', 'csv1') +
        exportBlock('代价明细 CSV（漏拍/切换/累计）', csv2, 'cost-detail.csv', 'csv2') +
        exportBlock('完整 JSON（含 0 基/1 基拍号与全部字段）', json, 'shot-plan.json', 'json') +
      '</div>' +
      '<footer><button id="modalClose2" type="button">关闭</button></footer>' +
      '</div></div>';
    wireClose();
    bindCopy(json, csv1, csv2);
  }

  function exportBlock(title, content, filename, id) {
    return '<div class="export-block"><div class="head"><span class="hint">' + esc(title) + '</span>' +
      '<span><button type="button" data-copy="' + id + '">复制</button> ' +
      '<button type="button" data-download="' + id + '" data-name="' + filename + '">下载文件</button></span></div>' +
      '<pre id="pre-' + id + '">' + esc(content) + '</pre></div>';
  }

  function wireClose() {
    var close = function () { $('modalRoot').innerHTML = ''; };
    var c1 = $('modalClose'); if (c1) c1.addEventListener('click', close);
    var c2 = $('modalClose2'); if (c2) c2.addEventListener('click', close);
    var bd = document.querySelector('.modal-backdrop');
    if (bd) bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
  }

  function bindCopy(json, csv1, csv2) {
    var map = { json: json, csv1: csv1, csv2: csv2 };
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = map[btn.getAttribute('data-copy')];
        copyText(text);
      });
    });
    document.querySelectorAll('[data-download]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-download');
        var name = btn.getAttribute('data-name');
        var text = map[id];
        var mime = name.endsWith('.json') ? 'application/json' : 'text/csv';
        tryDownload(name, text, mime);
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制到剪贴板');
      }).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch (e) { toast('复制失败，请手动选择文本', true); }
    document.body.removeChild(ta);
  }

  function tryDownload(name, text, mime) {
    try {
      var blob = new Blob([text], { type: mime + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已触发下载：' + name + '（若浏览器拦截，请用复制按钮）');
    } catch (e) {
      toast('下载被环境拦截，请改用复制按钮', true);
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('loadSampleBtn').addEventListener('click', function () {
      var s = window.REPLAY_SAMPLE;
      var obj = JSON.parse(JSON.stringify(s));
      delete obj.expected; delete obj.lockCase; delete obj.failure;
      loadInput(obj);
      toast('已加载完整样例');
    });
    $('loadFailBtn').addEventListener('click', function () {
      var s = window.REPLAY_SAMPLE;
      var obj = {
        shots: s.shots, inset: s.inset, follow: s.follow,
        cutCost: s.cutCost, cutGap: s.cutGap, beats: s.failure.beats
      };
      loadInput(obj);
      toast('已加载失败用例（第 3 拍无解）');
    });
    $('fileInput').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(reader.result);
          loadInput(obj);
          toast('已加载 ' + file.name);
        } catch (err) {
          toast('JSON 解析失败：' + err.message, true);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('applyJsonBtn').addEventListener('click', function () {
      try {
        var obj = JSON.parse($('jsonInput').value);
        loadInput(obj);
        toast('已应用粘贴的 JSON');
      } catch (err) {
        toast('JSON 解析失败：' + err.message, true);
      }
    });
    ['insetInput', 'cutCostInput', 'cutGapInput'].forEach(function (id) {
      $(id).addEventListener('change', solveAndRender);
    });
    $('reoptBtn').addEventListener('click', solveAndRender);
    $('clearLocksBtn').addEventListener('click', function () {
      if (state.locks.size === 0) { toast('当前没有锁定'); return; }
      state.locks = new Map();
      solveAndRender();
      toast('已清除全部锁定');
    });
    $('exportBtn').addEventListener('click', openExportModal);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initTheme();
    initPlayer();
    bindEvents();
    // 首帧即加载样例，让页面处于真实工作状态
    var s = window.REPLAY_SAMPLE;
    var obj = JSON.parse(JSON.stringify(s));
    delete obj.expected; delete obj.lockCase; delete obj.failure;
    loadInput(obj);
  }

  boot();
})();
