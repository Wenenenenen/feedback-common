/* ============================================================
   脚锁动作格子 —— 页面逻辑
   ============================================================ */
(function () {
  'use strict';

  var E = window.FootlockEngine;

  /* ---------------- 全局状态 ---------------- */
  var state = {
    raw: null,            // 当前原始数据（未归一）
    input: null,          // 归一化输入（求解用）
    result: null,         // 求解结果
    solveToken: 0,        // 防止过期结果覆盖
    currentTick: 0,       // 当前拍（0 基）
    playing: false,
    playTimer: null,
    editDirty: false,     // 根轨迹是否有未求解的改动
    editedTicks: {},      // 拍号 -> { root, angle } 编辑快照（用于撤销）
    originalTicks: null,  // 首次载入的 ticks 原始副本（撤销用）
    exportDoc: null,
    lastError: null,
    fieldZoom: 'all'      // 'all' 全域 | 'tick' 当前拍
  };

  var SAMPLE_URL = '../samples/footlock-lattice.json';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.className = 'toast'; }, 2800);
  }

  /* ---------------- 主题 ---------------- */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('footlock-theme'); } catch (e) {}
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var isDark = cur ? cur === 'dark' : prefersDark;
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('footlock-theme', next); } catch (e) {}
      renderAll();
    });
  }

  /* ---------------- 数据载入 ---------------- */
  function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

  function setData(raw, label) {
    state.raw = deepClone(raw);
    state.originalTicks = state.raw.ticks ? deepClone(state.raw.ticks) : null;
    state.editedTicks = {};
    state.editDirty = false;
    state.currentTick = 0;
    $('dataTag').textContent = label || '自定义';
    $('jsonInput').value = '';
    $('dataWarn').textContent = '';
    stopPlay();
    try {
      state.input = E.normalizeInput(state.raw);
    } catch (err) {
      state.input = null;
      state.result = null;
      $('dataWarn').textContent = '数据校验失败：' + err.message;
      renderAll();
      return false;
    }
    state.lastError = null;
    solveNow();
    return true;
  }

  function loadSampleText(text, label) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (err) { toast('JSON 解析失败：' + err.message, true); return false; }
    return setData(obj, label);
  }

  /* ---------------- 求解 ---------------- */
  function solveNow() {
    if (!state.input) return;
    var token = ++state.solveToken;
    setStatus('busy', '求解中…');
    // 让状态先绘制，再同步求解（满额约 1–2 秒）
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (token !== state.solveToken) return;
        var t0 = performance.now();
        var res;
        try {
          res = E.solve(state.input);
        } catch (err) {
          state.result = null;
          setStatus('bad', '求解出错');
          $('dataWarn').textContent = '求解失败：' + err.message;
          renderAll();
          return;
        }
        state.result = res;
        state.editDirty = false;
        state.lastError = null;
        if (state.input && state.input.ticks.length) {
          if (state.currentTick >= state.input.ticks.length) state.currentTick = state.input.ticks.length - 1;
        }
        state.exportDoc = null;
        if (res.ok) setStatus('ok', '最优 ' + res.totalCostString + ' · ' + (performance.now() - t0).toFixed(0) + 'ms');
        else setStatus('bad', '无解 · 拍 ' + (res.firstImpossibleTick + 1) + ' 不可达');
        renderAll();
      }, 16);
    });
  }

  function setStatus(kind, text) {
    var pill = $('statusPill');
    pill.className = 'pill ' + (kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : kind === 'busy' ? 'busy' : '');
    $('statusText').textContent = text;
  }

  /* ---------------- 编辑根轨迹 ---------------- */
  function currentTickObj() {
    if (!state.input) return null;
    return state.input.ticks[state.currentTick] || null;
  }

  function editTick(which, value) {
    if (!state.input) return;
    var rawTick = state.raw.ticks[state.currentTick];
    if (!rawTick) return;
    if (which === 'x') rawTick.root[0] = value;
    else if (which === 'y') rawTick.root[1] = value;
    else if (which === 'angle') rawTick.angle = value;
    // 记录编辑过的拍
    if (!state.editedTicks[state.currentTick]) {
      state.editedTicks[state.currentTick] = true;
    }
    state.editDirty = true;
    try {
      state.input = E.normalizeInput(state.raw);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    renderTickControls();
    renderField();
    renderCandidates();
    updateDirtyBanner();
  }

  function updateDirtyBanner() {
    var b = $('failureBanner');
    if (state.editDirty) {
      b.hidden = false;
      b.className = 'banner warn';
      b.innerHTML = '根轨迹已改动，当前显示的选段仍是上一次求解结果。<b>点顶栏「重新求解」</b>更新。';
    } else if (state.result && !state.result.ok) {
      b.hidden = false;
      b.className = 'banner bad';
      b.innerHTML = '<b>第 ' + (state.result.firstImpossibleTick + 1) + ' 拍不可达</b>：从上一拍没有任何合法衔接（受边、脚锁或跳转冷却限制）。' +
        (state.result.prefixIds && state.result.prefixIds.length ? ' 最优可达前缀：' + state.result.prefixIds.join(' → ') : '');
    } else {
      b.hidden = true;
    }
  }

  function resetTrack() {
    if (!state.originalTicks) return;
    state.raw.ticks = deepClone(state.originalTicks);
    state.editedTicks = {};
    state.editDirty = true;
    try { state.input = E.normalizeInput(state.raw); } catch (e) {}
    renderTickControls();
    renderField();
    renderCandidates();
    updateDirtyBanner();
    toast('已撤销轨迹编辑（重新求解后生效）');
  }

  /* ---------------- 当前拍辅助 ---------------- */
  function currentDetail() {
    if (!state.result || !state.result.ok) return null;
    return state.result.details[state.currentTick] || null;
  }

  function tickOfResult(t) {
    if (!state.result || !state.result.ok) return null;
    return state.result.details[t] || null;
  }

  /* ---------------- 渲染：全部 ---------------- */
  function renderAll() {
    renderTickControls();
    renderField();
    renderTimeline();
    renderCandidates();
    renderSummary();
    renderDetailTable();
    renderPlayReadout();
    updateDirtyBanner();
    updateExportButtons();
  }

  function renderTickControls() {
    var T = state.input ? state.input.ticks.length : 1;
    var t = Math.min(state.currentTick, T - 1);
    state.currentTick = t;
    $('tickTag').textContent = '拍 ' + (t + 1) + ' / ' + T;
    $('tickGoto').max = T;
    $('tickGoto').value = t + 1;
    var tick = state.input ? state.input.ticks[t] : null;
    if (tick) {
      $('rootX').value = tick.root[0];
      $('rootY').value = tick.root[1];
      $('angleInput').value = tick.angle;
      var chips = document.querySelectorAll('.angle-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('on', Number(chips[i].getAttribute('data-angle')) === tick.angle);
      }
    }
    var atFirst = t <= 0, atLast = t >= T - 1;
    $('firstBtn').disabled = atFirst; $('prevBtn').disabled = atFirst;
    $('lastBtn').disabled = atLast; $('nextBtn').disabled = atLast;
    // 缩放按钮高亮
    $('viewAllBtn').className = 'btn small' + (state.fieldZoom === 'all' ? ' primary' : '');
    $('viewTickBtn').className = 'btn small' + (state.fieldZoom === 'tick' ? ' primary' : '');
  }

  function renderPlayReadout() {
    var T = state.input ? state.input.ticks.length : 0;
    $('playReadout').textContent = T ? ('拍 ' + (state.currentTick + 1) + ' / ' + T) : '拍 — / —';
    $('prevTickBtn').disabled = state.currentTick <= 0;
    $('nextTickBtn').disabled = !T || state.currentTick >= T - 1;
  }

  /* ---------------- 渲染：场地 ---------------- */
  function renderField() {
    var svg = $('fieldSvg');
    var T = state.input ? state.input.ticks.length : 0;
    if (!T) { svg.innerHTML = ''; return; }

    var t = state.currentTick;
    var tick = state.input.ticks[t];
    var candWorld = candidateWorld(t);

    // 计算视野：全域看整条根轨迹 + 全部候选；当前拍只框住本拍根、选中脚与足迹范围
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function acc(x, y) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (state.fieldZoom === 'tick') {
      acc(tick.root[0], tick.root[1]);
      var lt = liveTickInfo(t);
      if (lt) { acc(lt.l[0], lt.l[1]); acc(lt.r[0], lt.r[1]); }
      var lp = t > 0 ? liveTickInfo(t - 1) : null;
      if (lp) { acc(lp.l[0], lp.l[1]); acc(lp.r[0], lp.r[1]); }
    } else {
      state.input.ticks.forEach(function (tk) { acc(tk.root[0], tk.root[1]); });
      candWorld.forEach(function (c) { acc(c.l[0], c.l[1]); acc(c.r[0], c.r[1]); });
    }

    // 正方形世界窗口，保持等比例尺（脚印方块不被拉伸）
    if (!isFinite(minX)) { minX = -2; maxX = 2; minY = -2; maxY = 2; }
    var pad = state.fieldZoom === 'tick' ? 2.0 : 1.5;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var worldSpan = Math.max(state.fieldZoom === 'tick' ? 3 : 4, (maxX - minX) * pad, (maxY - minY) * pad);
    minX = cx - worldSpan / 2; maxX = cx + worldSpan / 2;
    minY = cy - worldSpan / 2; maxY = cy + worldSpan / 2;

    var W = 760, H = 540, m = 28;
    var scale = (Math.min(W, H) - 2 * m) / worldSpan; // 像素/世界单位，两轴一致
    var ox = W / 2 - cx * scale;   // 世界原点（0,0）的屏幕 x
    var oy = H / 2 + cy * scale;   // 屏幕 y（向上为正，故加）
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    function sx(x) { return ox + x * scale; }
    function sy(y) { return oy - y * scale; }

    var parts = [];
    parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>');

    // 网格（约每 72px 一格）
    var step = niceStep(worldSpan / Math.max(4, Math.round((Math.min(W, H) - 2 * m) / 72)));
    var gx0 = Math.ceil(minX / step) * step;
    for (var gx = gx0; gx <= maxX + 1e-9; gx += step) {
      parts.push('<line class="grid-line' + (Math.abs(gx) < 1e-9 ? ' axis' : '') + '" x1="' + sx(gx) + '" y1="' + m + '" x2="' + sx(gx) + '" y2="' + (H - m) + '"/>');
    }
    var gy0 = Math.ceil(minY / step) * step;
    for (var gy = gy0; gy <= maxY + 1e-9; gy += step) {
      parts.push('<line class="grid-line' + (Math.abs(gy) < 1e-9 ? ' axis' : '') + '" x1="' + m + '" y1="' + sy(gy) + '" x2="' + (W - m) + '" y2="' + sy(gy) + '"/>');
    }
    parts.push('<text class="flabel" x="' + (W - m) + '" y="' + (H - m + 16) + '" text-anchor="end">网格 ' + fmtStep(step) + '</text>');

    // 根轨迹折线（“当前拍”视图下只画相邻几拍，避免一条长线穿过放大画面）
    var traceTicks = state.fieldZoom === 'tick'
      ? state.input.ticks.filter(function (_, i) { return Math.abs(i - t) <= 2; })
      : state.input.ticks;
    if (traceTicks.length > 1) {
      var pts = traceTicks.map(function (tk) { return sx(tk.root[0]) + ',' + sy(tk.root[1]); }).join(' ');
      parts.push('<polyline class="root-path" points="' + pts + '"/>');
    }

    // 全轨迹根小点（淡）
    if (state.fieldZoom !== 'tick' && T <= 400) {
      state.input.ticks.forEach(function (tk, i) {
        if (i === t) return;
        parts.push('<circle class="tick-root" cx="' + sx(tk.root[0]) + '" cy="' + sy(tk.root[1]) + '" r="2.2"/>');
      });
    }

    // 用“当前输入 + 求解序列”实时计算世界落点，根轨迹被编辑后脚印也跟着动
    var live = liveTickInfo(t);
    var livePrev = t > 0 ? liveTickInfo(t - 1) : null;

    // 上一拍脚印（若有）
    if (livePrev && live) {
      drawSoles(parts, livePrev.l, livePrev.r, livePrev.supL, livePrev.supR, sx, sy, 'prev', 'prev');
      // 脚锁连线（实时判定）
      if (livePrev.supL && live.supL && samePair(livePrev.l, live.l)) {
        parts.push('<line class="locklink" x1="' + sx(livePrev.l[0]) + '" y1="' + sy(livePrev.l[1]) + '" x2="' + sx(live.l[0]) + '" y2="' + sy(live.l[1]) + '"/>');
      }
      if (livePrev.supR && live.supR && samePair(livePrev.r, live.r)) {
        parts.push('<line class="locklink" x1="' + sx(livePrev.r[0]) + '" y1="' + sy(livePrev.r[1]) + '" x2="' + sx(live.r[0]) + '" y2="' + sy(live.r[1]) + '"/>');
      }
    }

    // 当前拍候选脚印（淡，非选中）：候选过多时只抽样少量，避免堆成一团遮住选中脚印
    if (state.fieldZoom !== 'tick') {
      var live0 = live;
      var ghosts = candWorld.filter(function (c) { return !(live0 && c.sample === live0.sample); });
      var GHOST_CAP = 24;
      if (ghosts.length > GHOST_CAP) {
        var stepG = ghosts.length / GHOST_CAP;
        var sampled = [];
        for (var gi = 0; gi < GHOST_CAP; gi++) sampled.push(ghosts[Math.floor(gi * stepG)]);
        ghosts = sampled;
      }
      ghosts.forEach(function (c) {
        drawSoles(parts, c.l, c.r, c.supL, c.supR, sx, sy, 'ghost', 'ghost');
      });
    }

    // 当前拍选中脚印（画在根标记之后，保证双脚不被根圆盖住）
    // 根标记 + 朝向
    var rx = sx(tick.root[0]), ry = sy(tick.root[1]);
    // 朝向箭头方向（屏幕坐标：+y 向上已翻转，逆时针角）
    var rad = tick.quarter * Math.PI / 2;
    var dirX = Math.cos(rad), dirY = -Math.sin(rad); // 屏幕 y 向下
    var unit = Math.min(40, (W - 2 * m) / 14);
    parts.push('<line class="facing" x1="' + rx + '" y1="' + ry + '" x2="' + (rx + dirX * unit) + '" y2="' + (ry + dirY * unit) + '" marker-end="url(#arrow)" style="color:var(--accent)"/>');
    parts.push('<circle class="root-marker" data-role="root" cx="' + rx + '" cy="' + ry + '" r="7"/>');

    // 选中脚印叠加在根标记之上，确保可见
    if (live) {
      drawSoles(parts, live.l, live.r, live.supL, live.supR, sx, sy, 'cur', 'cur');
      parts.push('<text class="flabel strong" x="' + (sx(live.l[0]) + 8) + '" y="' + (sy(live.l[1]) - 6) + '">L</text>');
      parts.push('<text class="flabel strong" x="' + (sx(live.r[0]) + 8) + '" y="' + (sy(live.r[1]) - 6) + '">R</text>');
    }
    parts.push('<text class="flabel strong" x="' + (rx + 10) + '" y="' + (ry + 16) + '">根 (' + tick.root[0] + ',' + tick.root[1] + ') · ' + tick.angle + '°</text>');

    svg.innerHTML = parts.join('');
    attachRootDrag(svg, cx, cy, scale, W, H);
  }

  function drawSoles(parts, l, r, supL, supR, sx, sy, kind, idp) {
    var size = 9;
    parts.push('<rect class="sole' + (supL ? ' support' : '') + (kind === 'ghost' ? ' ghost' : '') + (kind === 'prev' ? ' prev' : '') +
      '" x="' + (sx(l[0]) - size / 2) + '" y="' + (sy(l[1]) - size / 2) + '" width="' + size + '" height="' + size + '" rx="2"/>');
    parts.push('<rect class="sole' + (supR ? ' support' : '') + (kind === 'ghost' ? ' ghost' : '') + (kind === 'prev' ? ' prev' : '') +
      '" x="' + (sx(r[0]) - size / 2) + '" y="' + (sy(r[1]) - size / 2) + '" width="' + size + '" height="' + size + '" rx="2"/>');
  }

  function fmtStep(step) {
    return step >= 1 ? String(step) : step.toFixed(2);
  }

  function niceStep(raw) {
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / pow;
    var mult = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return mult * pow;
  }

  /** 当前拍各候选的世界落点（用于画淡脚印），按 costs 顺序 */
  function candidateWorld(t) {
    var tick = state.input.ticks[t];
    var samples = state.input.samples;
    var out = [];
    tick.allowedList.forEach(function (si) {
      var s = samples[si];
      out.push({
        sample: si, id: s.id,
        l: E.worldFoot(tick.root, tick.quarter, s.left),
        r: E.worldFoot(tick.root, tick.quarter, s.right),
        supL: s.left.support, supR: s.right.support
      });
    });
    return out;
  }

  /** 当前输入 + 求解序列下，某拍选中样本的实时世界落点；无解或未选中返回 null */
  function liveTickInfo(t) {
    if (!state.input || !state.result || !state.result.ok) return null;
    var det = state.result.details[t];
    if (!det) return null;
    var tick = state.input.ticks[t];
    var s = state.input.samples[det.sample];
    return {
      sample: det.sample,
      l: E.worldFoot(tick.root, tick.quarter, s.left),
      r: E.worldFoot(tick.root, tick.quarter, s.right),
      supL: s.left.support, supR: s.right.support
    };
  }

  function samePair(a, b) { return a[0] === b[0] && a[1] === b[1]; }

  /* 场地拖动改根位置 */
  function attachRootDrag(svg, cx, cy, scale, W, H) {
    var marker = svg.querySelector('[data-role="root"]');
    if (!marker) return;
    var dragging = false;
    function toWorld(evt) {
      var pt = svg.createSVGPoint();
      var src = evt.touches ? evt.touches[0] : evt;
      pt.x = src.clientX; pt.y = src.clientY;
      var loc = pt.matrixTransform(svg.getScreenCTM().inverse());
      var ox = W / 2 - cx * scale, oy = H / 2 + cy * scale;
      var wx = (loc.x - ox) / scale;
      var wy = (oy - loc.y) / scale;
      return [Math.round(wx), Math.round(wy)];
    }
    function onMove(evt) {
      if (!dragging) return;
      evt.preventDefault();
      var w = toWorld(evt);
      var tick = state.input.ticks[state.currentTick];
      var raw = state.raw.ticks[state.currentTick];
      if (tick.root[0] === w[0] && tick.root[1] === w[1]) return;
      raw.root[0] = w[0]; raw.root[1] = w[1];
      tick.root[0] = w[0]; tick.root[1] = w[1];
      state.editDirty = true;
      state.editedTicks[state.currentTick] = true;
      $('rootX').value = w[0]; $('rootY').value = w[1];
      renderField();
      renderCandidates();
      updateDirtyBanner();
    }
    function onUp() { dragging = false; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }
    marker.addEventListener('pointerdown', function (evt) {
      evt.preventDefault();
      dragging = true;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  /* ---------------- 渲染：时间轴 ---------------- */
  function renderTimeline() {
    var tl = $('timeline');
    var T = state.input ? state.input.ticks.length : 0;
    tl.innerHTML = '';
    tl.classList.toggle('sparse', T <= 60);
    if (!T) { $('tlAxisEnd').textContent = '拍 0'; return; }
    $('tlAxisEnd').textContent = '拍 ' + T;

    // 确定费用量级用于柱子高度（用姿势费）
    var maxCost = 1;
    state.input.ticks.forEach(function (tk) {
      tk.allowedList.forEach(function (si) {
        var c = Number(tk.poseCost[si]);
        if (isFinite(c) && c > maxCost) maxCost = c;
      });
    });

    var frag = document.createDocumentFragment();
    var resultOk = state.result && state.result.ok;
    var failTick = state.result && !state.result.ok ? state.result.firstImpossibleTick : -1;
    for (var t = 0; t < T; t++) {
      var cell = document.createElement('div');
      cell.className = 'tick-cell';
      cell.dataset.tick = t;
      cell.title = '拍 ' + (t + 1);
      if (t === state.currentTick) cell.classList.add('current');
      if (t === failTick) cell.classList.add('impossible');
      var det = resultOk ? state.result.details[t] : null;
      var bar = document.createElement('div');
      bar.className = 'bar';
      var h = 8;
      if (det) {
        var pc = Number(det.poseCost);
        h = 6 + Math.round(Math.min(1, Math.max(0, (pc + 2) / (maxCost + 2))) * 40);
        if (det.jump) { cell.classList.add('jump'); var jp = document.createElement('span'); jp.className = 'jp'; jp.textContent = ''; cell.appendChild(jp); }
        cell.title = '拍 ' + (t + 1) + ' · 样本 ' + det.sampleId + (det.jump ? ' · 跳转' : '') + ' · 累计 ' + det.cumulative;
      }
      bar.style.height = h + 'px';
      cell.appendChild(bar);
      frag.appendChild(cell);
    }
    tl.appendChild(frag);
    $('tlTag').textContent = T + ' 拍';
  }

  /* ---------------- 渲染：候选 ---------------- */
  function renderCandidates() {
    var list = $('candList');
    var hint = $('candHint');
    if (!state.input) { list.innerHTML = ''; $('candTag').textContent = '0'; return; }
    var t = state.currentTick;
    var tick = state.input.ticks[t];
    var samples = state.input.samples;
    var det = currentDetail();
    var chosenId = det ? det.sampleId : null;
    $('candTag').textContent = String(tick.allowedList.length);
    if (!tick.allowedList.length) {
      list.innerHTML = '<div class="banner bad" style="font-size:12px">本拍 costs 为空，没有任何可选样本。</div>';
      hint.textContent = '';
      return;
    }
    hint.textContent = '仅列 costs 中出现的样本；点样本编号可跳到该样本的解（若被选中）。';

    var rows = tick.allowedList.slice().sort(function (a, b) { return samples[a].id - samples[b].id; });
    var html = '<table class="cand-table"><thead><tr>' +
      '<th>样本</th><th>左脚世界</th><th>右脚世界</th><th class="num">姿势费</th></tr></thead><tbody>';
    var LIMIT = 200;
    rows.slice(0, LIMIT).forEach(function (si) {
      var s = samples[si];
      var wl = E.worldFoot(tick.root, tick.quarter, s.left);
      var wr = E.worldFoot(tick.root, tick.quarter, s.right);
      var chosen = chosenId !== null && s.id === chosenId;
      html += '<tr class="' + (chosen ? 'chosen' : '') + '">' +
        '<td>' + s.id + (chosen ? ' <span class="badge chosen">选中</span>' : '') + '</td>' +
        '<td>(' + wl[0] + ',' + wl[1] + ') ' + (s.left.support ? '<span class="badge support">支</span>' : '<span class="badge air">空</span>') + '</td>' +
        '<td>(' + wr[0] + ',' + wr[1] + ') ' + (s.right.support ? '<span class="badge support">支</span>' : '<span class="badge air">空</span>') + '</td>' +
        '<td class="num">' + tick.poseCost[si].toString() + '</td></tr>';
    });
    html += '</tbody></table>';
    if (rows.length > LIMIT) html += '<div class="hint" style="margin-top:6px">另有 ' + (rows.length - LIMIT) + ' 个候选取样省略（按编号排序仅显示前 ' + LIMIT + '）。</div>';
    list.innerHTML = html;
  }

  /* ---------------- 渲染：汇总 ---------------- */
  function renderSummary() {
    var el = $('summaryTiles');
    if (!state.input) { el.innerHTML = ''; return; }
    var T = state.input.ticks.length;
    var res = state.result;
    var html = '';
    html += tile('拍数', String(T));
    html += tile('样本 / 边', state.input.samples.length + ' / ' + state.input.edges.length, 'small');
    if (res && res.ok) {
      var jumps = res.details.filter(function (d) { return d.jump; }).length;
      var maxState = Math.max.apply(null, res.stats.states);
      html += tile('总代价', res.totalCostString, 'good', true);
      html += tile('跳转次数', String(jumps), jumps ? 'jump' : '');
      html += tile('最大活性状态', String(maxState), 'small');
      html += tile('求解耗时', res.solveMs.toFixed(0) + ' ms', 'small');
    } else if (res && !res.ok) {
      html += tile('总代价', '无解', 'bad');
      html += tile('首个不可达', '拍 ' + (res.firstImpossibleTick + 1), 'bad');
      html += tile('可达前缀', String(res.prefixIds ? res.prefixIds.length : 0) + ' 拍', 'small');
    } else {
      html += tile('总代价', '—', 'small');
    }
    el.innerHTML = html;
  }

  function tile(k, v, cls, big) {
    return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + (big ? '' : ' small') + '">' + esc(v) + '</div></div>';
  }

  /* ---------------- 渲染：明细表 ---------------- */
  function renderDetailTable() {
    var res = state.result;
    var wrap = $('detailWrap'), empty = $('detailEmpty'), body = $('detailBody');
    if (!res || !res.ok) { wrap.hidden = true; empty.hidden = false; body.innerHTML = ''; return; }
    wrap.hidden = false; empty.hidden = true;
    var html = '';
    res.details.forEach(function (d, i) {
      var trans;
      if (i === 0) trans = '<span class="badge air">起始</span>';
      else if (d.jump) trans = '<span class="badge" style="background:var(--jump-soft);color:var(--jump)">跳转·冷' + d.cooldownAfter + '</span>';
      else trans = '边·冷' + d.cooldownAfter;
      html += '<tr data-tick="' + i + '" class="' + (i === state.currentTick ? 'current' : '') + '">' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + d.sampleId + '</td>' +
        '<td>(' + d.root[0] + ',' + d.root[1] + ') ' + d.angle + '°</td>' +
        '<td>' + trans + '</td>' +
        '<td>' + lockTag(d.footlockLeft, !!d.supportLeft) + '</td>' +
        '<td>' + lockTag(d.footlockRight, !!d.supportRight) + '</td>' +
        '<td class="num">' + d.poseCost + '</td>' +
        '<td class="num">' + d.edgeFee + '</td>' +
        '<td class="num">' + d.cumulative + '</td>' +
        '</tr>';
    });
    body.innerHTML = html;
  }

  function lockTag(kind, support) {
    if (kind === 'locked') return '<span class="locktag locked">锁</span>';
    if (kind === 'break') return '<span class="locktag break">断</span>';
    if (!support) return '<span class="locktag air">离地</span>';
    return '<span class="locktag air">—</span>';
  }

  /* ---------------- 渲染：导出按钮 ---------------- */
  function updateExportButtons() {
    var has = !!(state.exportDoc || (state.result));
    $('copyBtn').disabled = !state.exportDoc;
    $('downloadBtn').disabled = !state.exportDoc;
  }

  /* ---------------- 选拍 / 播放 ---------------- */
  function selectTick(t) {
    if (!state.input) return;
    var T = state.input.ticks.length;
    t = Math.max(0, Math.min(T - 1, t));
    state.currentTick = t;
    renderTickControls();
    renderField();
    renderTimeline();
    renderCandidates();
    renderDetailTable();
    renderPlayReadout();
  }

  function stopPlay() {
    state.playing = false;
    if (state.playTimer) { clearTimeout(state.playTimer); state.playTimer = null; }
    $('playBtn').textContent = '▶ 播放';
  }

  function togglePlay() {
    if (!state.input) return;
    if (state.playing) { stopPlay(); return; }
    state.playing = true;
    $('playBtn').textContent = '⏸ 暂停';
    var delay = parseInt($('speedSelect').value, 10) || 850;
    var T = state.input.ticks.length;
    function step() {
      if (!state.playing) return;
      var next = state.currentTick + 1;
      if (next >= T) { next = 0; }
      selectTick(next);
      state.playTimer = setTimeout(step, delay);
    }
    state.playTimer = setTimeout(step, delay);
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function buildExport() {
    if (!state.input || !state.result) { toast('请先载入并求解', true); return null; }
    var doc = E.buildReplay(state.input, state.result);
    state.exportDoc = doc;
    $('exportBox').value = JSON.stringify(doc, null, 2);
    updateExportButtons();
    return doc;
  }

  function doExport() {
    var doc = buildExport();
    if (!doc) return;
    toast(doc.ok ? '已生成导出：' + doc.sequenceIds.length + ' 拍，总价 ' + doc.totalCost : '已生成无解凭证（首个不可达拍 ' + doc.firstImpossibleTick + '）');
  }

  function doCopy() {
    if (!state.exportDoc) return;
    var text = JSON.stringify(state.exportDoc, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, function () { fallbackSelect(); });
    } else fallbackSelect();
    function fallbackSelect() {
      var box = $('exportBox');
      box.focus(); box.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败，请手动选择', true); }
    }
  }

  function doDownload() {
    if (!state.exportDoc) return;
    var blob = new Blob([JSON.stringify(state.exportDoc, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'footlock-replay-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function doImportVerify() {
    var raw = $('exportBox').value.trim();
    if (!raw) { toast('导出框为空，请先生成或粘贴 JSON', true); return; }
    var doc;
    try { doc = JSON.parse(raw); }
    catch (err) { showVerify(false, ['JSON 解析失败：' + err.message]); return; }

    var v;
    try { v = E.verifyReplay(doc); }
    catch (err) { showVerify(false, ['核算异常：' + err.message]); return; }

    if (v.ok) {
      var lines = ['<b>重导核算通过</b>'];
      if (v.result && v.result.ok) {
        lines.push('重新求解总价 ' + v.result.totalCostString + '，序列与导出一致；逐拍边、脚锁、冷却、费用加总全部核对无误。');
      } else {
        lines.push('无解结果一致：首个不可达拍 ' + (v.result.firstImpossibleTick + 1) + '。');
      }
      showVerify(true, lines);
      // 同时把这份数据载入页面，便于逐拍对照
      if (doc.input) {
        loadSampleText(JSON.stringify(doc.input), '导入的 replay');
      }
    } else {
      showVerify(false, ['<b>重导核算未通过</b>'].concat(v.errors.map(esc)));
    }
  }

  function showVerify(ok, lines) {
    var el = $('verifyResult');
    el.hidden = false;
    el.className = 'banner ' + (ok ? 'good' : 'bad');
    el.innerHTML = lines.join('<br>');
  }

  /* ---------------- 满额基准 ---------------- */
  function makeLargeCase() {
    return window.FootlockLargeCase.buildLargeCase();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('loadSampleBtn').addEventListener('click', function () {
      fetchSample().then(function (text) { loadSampleText(text, '样例'); }).catch(function () {
        // file:// 下 fetch 可能失败，使用内嵌最小样例
        loadSampleText(JSON.stringify(window.__FOOTLOCK_SAMPLE__), '内嵌样例');
      });
    });
    $('loadLargeBtn').addEventListener('click', function () {
      setStatus('busy', '生成满额基准…');
      $('dataTag').textContent = '满额基准';
      setTimeout(function () {
        var raw = makeLargeCase();
        setData(raw, '满额基准');
        toast('满额基准已载入：240 拍 / 4096 样本 / 60000 边');
      }, 20);
    });
    $('fileInput').addEventListener('change', function (evt) {
      var f = evt.target.files && evt.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { loadSampleText(String(reader.result), f.name); };
      reader.readAsText(f, 'utf-8');
      evt.target.value = '';
    });
    $('applyJsonBtn').addEventListener('click', function () {
      var txt = $('jsonInput').value.trim();
      if (!txt) { toast('请先粘贴 JSON', true); return; }
      if (loadSampleText(txt, '粘贴')) $('pastePanel').open = false;
    });
    $('solveBtn').addEventListener('click', function () { solveNow(); });
    $('resetTrackBtn').addEventListener('click', resetTrack);

    $('viewAllBtn').addEventListener('click', function () {
      state.fieldZoom = 'all'; renderTickControls(); renderField();
    });
    $('viewTickBtn').addEventListener('click', function () {
      state.fieldZoom = 'tick'; renderTickControls(); renderField();
    });

    $('firstBtn').addEventListener('click', function () { selectTick(0); });
    $('prevBtn').addEventListener('click', function () { selectTick(state.currentTick - 1); });
    $('nextBtn').addEventListener('click', function () { selectTick(state.currentTick + 1); });
    $('lastBtn').addEventListener('click', function () { selectTick((state.input ? state.input.ticks.length : 1) - 1); });
    $('tickGoto').addEventListener('change', function () {
      var v = parseInt(this.value, 10);
      if (isFinite(v)) selectTick(v - 1);
    });

    function onRootInput() {
      var x = parseInt($('rootX').value, 10), y = parseInt($('rootY').value, 10);
      if (!isFinite(x) || !isFinite(y)) return;
      var raw = state.raw.ticks[state.currentTick];
      if (raw.root[0] === x && raw.root[1] === y) return;
      raw.root[0] = x; raw.root[1] = y;
      state.editDirty = true; state.editedTicks[state.currentTick] = true;
      try { state.input = E.normalizeInput(state.raw); } catch (e) {}
      renderField(); renderCandidates(); updateDirtyBanner();
    }
    $('rootX').addEventListener('change', onRootInput);
    $('rootY').addEventListener('change', onRootInput);
    $('angleInput').addEventListener('change', function () {
      var v = parseInt(this.value, 10);
      if (!isFinite(v) || v % 90 !== 0) { toast('朝向必须是 90° 的整数倍', true); renderTickControls(); return; }
      editTick('angle', ((v % 360) + 360) % 360);
      renderTickControls();
    });
    document.querySelectorAll('.angle-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (!state.input) return;
        editTick('angle', Number(chip.getAttribute('data-angle')));
        renderTickControls();
      });
    });

    $('timeline').addEventListener('click', function (evt) {
      var cell = evt.target.closest('.tick-cell');
      if (cell && cell.dataset.tick !== undefined) selectTick(Number(cell.dataset.tick));
    });
    $('detailBody').addEventListener('click', function (evt) {
      var tr = evt.target.closest('tr');
      if (tr && tr.dataset.tick !== undefined) selectTick(Number(tr.dataset.tick));
    });

    $('playBtn').addEventListener('click', togglePlay);
    $('prevTickBtn').addEventListener('click', function () { stopPlay(); selectTick(state.currentTick - 1); });
    $('nextTickBtn').addEventListener('click', function () { stopPlay(); selectTick(state.currentTick + 1); });
    $('speedSelect').addEventListener('change', function () { if (state.playing) { stopPlay(); togglePlay(); } });

    $('exportBtn').addEventListener('click', doExport);
    $('copyBtn').addEventListener('click', doCopy);
    $('downloadBtn').addEventListener('click', doDownload);
    $('importBtn').addEventListener('click', doImportVerify);

    document.addEventListener('keydown', function (evt) {
      if (evt.target && /input|textarea|select/i.test(evt.target.tagName)) return;
      if (evt.key === ' ') { evt.preventDefault(); togglePlay(); }
      else if (evt.key === 'ArrowLeft') { evt.preventDefault(); stopPlay(); selectTick(state.currentTick - 1); }
      else if (evt.key === 'ArrowRight') { evt.preventDefault(); stopPlay(); selectTick(state.currentTick + 1); }
      else if (evt.key === 'Home') { selectTick(0); }
      else if (evt.key === 'End') { selectTick((state.input ? state.input.ticks.length : 1) - 1); }
    });
  }

  function fetchSample() {
    // file:// 下无法 fetch 本地文件，直接用内嵌样例，避免无谓的控制台报错
    if (location.protocol === 'file:') return Promise.reject(new Error('file protocol'));
    return fetch(SAMPLE_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    initTheme();
    bind();
    // 优先 fetch 样例文件；file:// 下退回内嵌样例
    fetchSample().then(function (text) {
      loadSampleText(text, '样例');
    }).catch(function () {
      var embedded = window.__FOOTLOCK_SAMPLE__;
      if (embedded) loadSampleText(JSON.stringify(embedded), '内嵌样例');
      else {
        setStatus('bad', '无数据');
        $('dataWarn').textContent = '无法读取 samples/footlock-lattice.json，请手动粘贴或选择文件。';
      }
    });
  }

  window.addEventListener('DOMContentLoaded', start);
})();
