/* global FluorescentCore */
'use strict';
(function () {
  var FC = window.FluorescentCore;

  /* 内置样例（与 samples/fluorescent-patches.json 一致，保证 file:// 直接打开也可用） */
  var EMBEDDED_SAMPLE = {
    bands: [410, 530, 620],
    observerRGB: [[0.1, 0, 0.7], [0.1, 0.9, 0.1], [0.8, 0.1, 0]],
    patches: [
      { id: 'label', direct: [1, 0, 0], reflect: [0.15, 0.25, 0.3], convert: [[0, 1, 0.4]] },
      { id: 'panel', direct: [0, 0, 0], reflect: [0.1, 0.6, 0.4], convert: [] }
    ],
    links: [['label', 'panel', 0.5], ['panel', 'label', 0.2]]
  };
  var STORAGE_KEY = 'fluorescent-relighter-state-v1';

  /* ---------------- 状态 ---------------- */
  var state = {
    data: clone(EMBEDDED_SAMPLE),   // 当前编辑中的数据（可能非法）
    lamp: EMBEDDED_SAMPLE.bands.map(function () { return 1; }),
    validData: clone(EMBEDDED_SAMPLE), // 上次通过校验的数据
    validLamp: EMBEDDED_SAMPLE.bands.map(function () { return 1; }),
    solution: null,                  // 上次有效求解结果
    selected: 0,
    tab: 'spectra',
    gain: null,                      // null = 自动
    manualGain: false
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = el('div', 'toast', msg);
    $('toast-root').appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  /* ---------------- 持久化 ---------------- */
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        data: state.data, lamp: state.lamp, selected: state.selected,
        gain: state.gain, manualGain: state.manualGain, theme: document.documentElement.dataset.theme || ''
      }));
    } catch (e2) { /* 存储不可用则静默 */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && saved.data && FC.validate(saved.data).ok) {
        state.data = saved.data;
        state.validData = clone(saved.data);
        state.lamp = Array.isArray(saved.lamp) && saved.lamp.length === saved.data.bands.length
          ? saved.lamp : saved.data.bands.map(function () { return 1; });
        state.validLamp = state.lamp.slice();
        if (Number.isFinite(saved.selected)) state.selected = Math.min(saved.selected, saved.data.patches.length - 1);
        if (saved.manualGain && Number.isFinite(saved.gain)) { state.manualGain = true; state.gain = saved.gain; }
        if (saved.theme) document.documentElement.dataset.theme = saved.theme;
      }
    } catch (e2) { /* 损坏的存档忽略 */ }
  }

  /* ---------------- 求解调度：非法则保留上次有效结果 ---------------- */
  function recompute() {
    var v = FC.validate(state.data);
    var banner = $('error-banner');
    if (v.ok) {
      banner.hidden = true;
      state.validData = clone(state.data);
      state.validLamp = state.lamp.slice();
      try {
        state.solution = FC.solve(state.validData, state.validLamp);
        $('status-state').textContent = '● 已求解';
        $('status-state').style.color = 'var(--good)';
      } catch (e3) {
        v.ok = false;
        v.errors = ['求解失败：' + e3.message];
      }
    }
    if (!v.ok) {
      banner.hidden = false;
      $('error-list').replaceChildren.apply($('error-list'),
        v.errors.map(function (m) { return el('li', null, m); }));
      $('status-state').textContent = '● 输入非法，显示上次有效结果';
      $('status-state').style.color = 'var(--critical)';
      // 回退到上次有效数据保证 solvution 存在
      if (!state.solution) state.solution = FC.solve(state.validData, state.validLamp);
    }
    renderAll();
    persist();
  }

  /* ---------------- 灯光区 ---------------- */
  function renderLamp() {
    var host = $('lamp-grid');
    host.replaceChildren();
    var B = state.data.bands.length;
    $('lamp-count').textContent = B + ' 个波段（' + state.data.bands[0] + '–' + state.data.bands[B - 1] + ' nm）';
    state.data.bands.forEach(function (wl, k) {
      var cell = el('div', 'lamp-cell');
      var head = el('div', 'lbl');
      head.appendChild(el('span', null, '波段 ' + k));
      head.appendChild(el('b', 'num', wl + ' nm'));
      cell.appendChild(head);
      var range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = '2'; range.step = '0.01';
      range.value = String(state.lamp[k]);
      var num = document.createElement('input');
      num.type = 'number'; num.min = '0'; num.step = '0.05'; num.value = String(state.lamp[k]);
      range.addEventListener('input', function () { num.value = range.value; setLamp(k, range.value); });
      num.addEventListener('input', function () { range.value = num.value; setLamp(k, num.value); });
      var val = el('div', 'val');
      val.appendChild(el('span', null, '倍数'));
      val.appendChild(num);
      cell.appendChild(range);
      cell.appendChild(val);
      host.appendChild(cell);
    });
  }
  function setLamp(k, raw) {
    var x = parseFloat(raw);
    if (!Number.isFinite(x) || x < 0) {
      state.lamp[k] = 0;
    } else state.lamp[k] = x;
    recompute();
  }

  /* ---------------- 色板 ---------------- */
  function currentGain() {
    if (state.manualGain && state.gain !== null) return state.gain;
    var sol = state.solution;
    var mx = 0;
    sol.rgb.forEach(function (c) { mx = Math.max(mx, c[0], c[1], c[2]); });
    return mx > 0 ? 0.9 / mx : 1;
  }
  function renderSwatches() {
    var host = $('swatch-grid');
    host.replaceChildren();
    var sol = state.solution, gain = currentGain();
    $('swatch-count').textContent = sol.N + ' 个贴片 · 线性 RGB（观察权重加权）';
    sol.ids.forEach(function (id, i) {
      var btn = el('button', 'swatch' + (i === state.selected ? ' active' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-label', '贴片 ' + id);
      var chip = el('div', 'chip');
      var rgb = sol.rgb[i];
      chip.style.background = FC.swatchCss(rgb, gain);
      var total = sol.outgoing[i].reduce(function (a, b) { return a + b; }, 0);
      if (total <= 1e-12) chip.appendChild(el('span', 'zero-tag', '无出射'));
      btn.appendChild(chip);
      var meta = el('div', 'meta');
      meta.appendChild(el('div', 'pid', id));
      meta.appendChild(el('div', 'prgb num',
        'R' + sci(rgb[0]) + ' G' + sci(rgb[1]) + ' B' + sci(rgb[2])));
      btn.appendChild(meta);
      btn.addEventListener('click', function () {
        state.selected = i; persist(); renderAll();
      });
      host.appendChild(btn);
    });
    $('gain-label').textContent = '×' + currentGain().toFixed(2);
    $('gain-range').value = state.manualGain ? String(Math.log10(state.gain || 1)) : String(Math.log10(currentGain()));
  }
  function sci(x) {
    if (x === 0) return '0';
    if (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e4) return x.toPrecision(3).replace(/\.?0+$/, '');
    return x.toExponential(1);
  }

  /* ---------------- 详情：光谱图（手绘 SVG） ---------------- */
  var SERIES = [
    { key: 'direct', name: '直射入射', colorVar: '--s-direct' },
    { key: 'reflected', name: '同波段反射', colorVar: '--s-reflect' },
    { key: 'fluorescent', name: '荧光', colorVar: '--s-fluor' },
    { key: 'outgoing', name: '总出射', colorVar: '--s-total' }
  ];
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function renderChart() {
    var sol = state.solution, i = state.selected, B = sol.B;
    var host = $('chart-host');
    host.replaceChildren();
    var W = Math.max(440, B * 110), H = 280;
    var padL = 52, padR = 16, padT = 14, padB = 42;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.classList.add('chart');

    var rows = SERIES.map(function (s) { return sol[s.key][i]; });
    var yMax = 0;
    rows.forEach(function (r) { r.forEach(function (v) { yMax = Math.max(yMax, v); }); });
    if (yMax === 0) yMax = 1;
    yMax *= 1.08;
    var bandW = plotW / B;
    function xCenter(k) { return padL + bandW * (k + 0.5); }
    function y(v) { return padT + plotH * (1 - v / yMax); }

    // 网格 + y 轴刻度（4 条）
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var val = yMax * t / ticks;
      var yy = y(val);
      var ln = document.createElementNS(svg.namespaceURI, 'line');
      ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR);
      ln.setAttribute('y1', yy); ln.setAttribute('y2', yy);
      ln.setAttribute('class', 'grid-line');
      svg.appendChild(ln);
      var lab = document.createElementNS(svg.namespaceURI, 'text');
      lab.setAttribute('x', padL - 7); lab.setAttribute('y', yy + 3.5);
      lab.setAttribute('text-anchor', 'end'); lab.setAttribute('class', 'axis-text');
      lab.textContent = sci(val);
      svg.appendChild(lab);
    }
    // x 轴
    var axis = document.createElementNS(svg.namespaceURI, 'line');
    axis.setAttribute('x1', padL); axis.setAttribute('x2', W - padR);
    axis.setAttribute('y1', padT + plotH); axis.setAttribute('y2', padT + plotH);
    axis.setAttribute('class', 'axis-line');
    svg.appendChild(axis);

    // 三组柱：直射 / 反射 / 荧光；总出射为折线
    var barGroupW = bandW * 0.62, barW = barGroupW / 3;
    var hitAreas = [];
    for (var k = 0; k < B; k++) {
      var x0 = xCenter(k) - barGroupW / 2;
      [0, 1, 2].forEach(function (si) {
        var v = rows[si][k];
        if (v <= 0) return;
        var h = plotH * (v / yMax);
        var rect = document.createElementNS(svg.namespaceURI, 'rect');
        rect.setAttribute('x', x0 + si * barW + 1);
        rect.setAttribute('y', y(v));
        rect.setAttribute('width', Math.max(1, barW - 2));
        rect.setAttribute('height', h);
        rect.setAttribute('rx', si === 0 ? '4' : '0');
        rect.setAttribute('fill', cssVar(SERIES[si].colorVar));
        svg.appendChild(rect);
      });
      // x 标签：波长
      var xlab = document.createElementNS(svg.namespaceURI, 'text');
      xlab.setAttribute('x', xCenter(k)); xlab.setAttribute('y', padT + plotH + 18);
      xlab.setAttribute('text-anchor', 'middle'); xlab.setAttribute('class', 'axis-text');
      xlab.textContent = sol.bands[k] + 'nm';
      svg.appendChild(xlab);
      var xlab2 = document.createElementNS(svg.namespaceURI, 'text');
      xlab2.setAttribute('x', xCenter(k)); xlab2.setAttribute('y', padT + plotH + 33);
      xlab2.setAttribute('text-anchor', 'middle'); xlab2.setAttribute('class', 'axis-text');
      xlab2.textContent = '波段' + k;
      svg.appendChild(xlab2);

      // 命中区（整波段）
      var hit = document.createElementNS(svg.namespaceURI, 'rect');
      hit.setAttribute('x', padL + bandW * k); hit.setAttribute('y', padT);
      hit.setAttribute('width', bandW); hit.setAttribute('height', plotH);
      hit.setAttribute('fill', 'transparent');
      hit.style.cursor = 'crosshair';
      (function (kk, hh) {
        hh.addEventListener('pointermove', function (ev) { showTip(ev, kk); });
        hh.addEventListener('pointerleave', hideTip);
      })(k, hit);
      hitAreas.push(hit);
    }
    hitAreas.forEach(function (h) { svg.appendChild(h); });

    // 总出射折线 + 端点
    var pts = rows[3].map(function (v, k) { return [xCenter(k), y(v)]; });
    var poly = document.createElementNS(svg.namespaceURI, 'polyline');
    poly.setAttribute('points', pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', cssVar('--s-total'));
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-linejoin', 'round'); poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);
    pts.forEach(function (p) {
      var dot = document.createElementNS(svg.namespaceURI, 'circle');
      dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]); dot.setAttribute('r', '4.5');
      dot.setAttribute('fill', cssVar('--s-total'));
      dot.setAttribute('stroke', cssVar('--surface'));
      dot.setAttribute('stroke-width', '2');
      svg.appendChild(dot);
    });
    host.appendChild(svg);

    var tip = $('chart-tip');
    function showTip(ev, kk) {
      tip.hidden = false;
      tip.replaceChildren();
      tip.appendChild(el('div', 'tip-title', sol.bands[kk] + ' nm · 波段 ' + kk));
      SERIES.forEach(function (s, si) {
        var row = el('div', 'tip-row');
        var sw = el('i', 'sw'); sw.style.background = cssVar(s.colorVar);
        row.appendChild(sw);
        row.appendChild(el('span', null, s.name));
        row.appendChild(el('b', 'num', rows[si][kk].toPrecision(5)));
        tip.appendChild(row);
      });
      var rw = tip.offsetWidth || 200;
      tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - rw - 12) + 'px';
      tip.style.top = Math.max(8, ev.clientY - tip.offsetHeight - 12) + 'px';
    }
    function hideTip() { tip.hidden = true; }
  }

  /* ---------------- 详情：数据表 ---------------- */
  function renderSpectraTable() {
    var sol = state.solution, i = state.selected;
    var tbl = $('spectra-table');
    tbl.replaceChildren();
    var thead = el('thead'), trh = el('tr');
    ['波段(nm)', '直射入射', '稳态入射', '反射', '荧光', '总出射'].forEach(function (h) {
      trh.appendChild(el('th', null, h));
    });
    thead.appendChild(trh); tbl.appendChild(thead);
    var tb = el('tbody');
    for (var k = 0; k < sol.B; k++) {
      var tr = el('tr');
      tr.appendChild(el('td', null, String(sol.bands[k])));
      tr.appendChild(el('td', 'num', n(sol.direct[i][k])));
      tr.appendChild(el('td', 'num', n(sol.incident[i][k])));
      tr.appendChild(el('td', 'num', n(sol.reflected[i][k])));
      tr.appendChild(el('td', 'num', n(sol.fluorescent[i][k])));
      tr.appendChild(el('td', 'num', n(sol.outgoing[i][k])));
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
  }
  function n(x) { return x.toPrecision(7).replace(/\.?0+$/, ''); }

  /* ---------------- 详情头部 ---------------- */
  function renderDetailHead() {
    var sol = state.solution, i = state.selected;
    $('detail-title').textContent = '贴片 ' + sol.ids[i];
    $('detail-chip').style.background = FC.swatchCss(sol.rgb[i], currentGain());
    $('detail-rgb').textContent = '线性 RGB = (' +
      sol.rgb[i].map(function (v) { return v.toPrecision(5); }).join(', ') + ')';
  }

  /* ---------------- 编辑器：直射 / 反射 ---------------- */
  function fieldErrors(patchId, field) {
    // 返回该贴片该字段逐波段是否非法的布尔数组（依据当前编辑数据的完整校验结果）
    var flags = state.data.bands.map(function () { return false; });
    if (FC.validate(state.data).ok) return flags;
    // 轻量本地复核：数值非负；反射还需参与能量守恒
    var p = state.data.patches[state.selected];
    p[field].forEach(function (v, k) {
      if (!Number.isFinite(v) || v < 0) flags[k] = true;
    });
    if (field === 'reflect') {
      p[field].forEach(function (v, k) {
        var conv = 0;
        p.convert.forEach(function (tri) { if (tri[0] === k) conv += tri[2]; });
        if (v + conv > 1 + FC.EPS) flags[k] = true;
      });
    }
    return flags;
  }
  function scalarEditor(hostId, field) {
    var host = $(hostId);
    host.replaceChildren();
    var p = state.data.patches[state.selected];
    var flags = fieldErrors(p.id, field);
    state.data.bands.forEach(function (wl, k) {
      var cell = el('div', 'input-cell');
      var lab = el('label', null, k + ' · ' + wl + 'nm');
      var inp = document.createElement('input');
      inp.type = 'number'; inp.step = 'any'; inp.value = String(p[field][k]);
      if (flags[k]) inp.classList.add('invalid');
      inp.addEventListener('input', function () {
        var x = parseFloat(inp.value);
        var bad = !Number.isFinite(x) || x < 0;
        if (!bad && field === 'reflect') {
          var conv = 0;
          p.convert.forEach(function (tri) { if (tri[0] === k) conv += tri[2]; });
          bad = x + conv > 1 + FC.EPS;
        }
        inp.classList.toggle('invalid', bad);
        if (Number.isFinite(x) && x >= 0) { p[field][k] = x; recompute(); }
      });
      cell.appendChild(lab); cell.appendChild(inp);
      host.appendChild(cell);
    });
  }

  /* ---------------- 编辑器：荧光转换 ---------------- */
  function renderConvertEditor() {
    var host = $('convert-editor');
    host.replaceChildren();
    var p = state.data.patches[state.selected];
    var B = state.data.bands;
    if (!p.convert.length) host.appendChild(el('div', 'empty-note', '暂无荧光转换。荧光只能把能量转到更长（更红）的波段。'));
    p.convert.forEach(function (tri, ti) {
      var row = el('div', 'convert-row');
      var sSel = bandSelect(tri[0]), tSel = bandSelect(tri[1]);
      var qInp = document.createElement('input');
      qInp.type = 'number'; qInp.step = 'any'; qInp.min = '0'; qInp.value = String(tri[2]);
      var qBad = !Number.isFinite(tri[2]) || tri[2] < 0 || tri[1] <= tri[0] ||
        tri[0] < 0 || tri[1] >= B ||
        p.reflect[tri[0]] + p.convert.reduce(function (a, c) { return a + (c[0] === tri[0] ? c[2] : 0); }, 0) > 1 + FC.EPS;
      if (qBad) qInp.classList.add('invalid');
      sSel.addEventListener('change', function () { tri[0] = parseInt(sSel.value, 10); recompute(); });
      tSel.addEventListener('change', function () { tri[1] = parseInt(tSel.value, 10); recompute(); });
      qInp.addEventListener('input', function () {
        var x = parseFloat(qInp.value);
        qInp.classList.toggle('invalid', !Number.isFinite(x) || x < 0);
        if (Number.isFinite(x) && x >= 0) { tri[2] = x; recompute(); }
      });
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { p.convert.splice(ti, 1); recompute(); });
      row.appendChild(sSel); row.appendChild(tSel); row.appendChild(qInp); row.appendChild(del);
      host.appendChild(row);
    });
    // 每波段能量分配计量
    var meter = $('conv-meter'), label = $('conv-sum-label');
    var worst = 0, worstK = 0;
    for (var k = 0; k < B; k++) {
      var sum = p.reflect[k];
      p.convert.forEach(function (tri) { if (tri[0] === k) sum += tri[2]; });
      if (sum > worst) { worst = sum; worstK = k; }
    }
    meter.querySelector('i').style.width = Math.min(100, worst * 100) + '%';
    meter.classList.toggle('over', worst > 1 + FC.EPS);
    label.classList.toggle('over', worst > 1 + FC.EPS);
    label.replaceChildren();
    label.appendChild(el('span', null, '波段 ' + worstK + '（' + state.data.bands[worstK] + 'nm）：反射 + 荧光转出'));
    label.appendChild(el('b', 'num', worst.toFixed(4) + ' / 1.0000'));
  }
  function bandSelect(selected) {
    var sel = document.createElement('select');
    state.data.bands.forEach(function (wl, k) {
      var opt = document.createElement('option');
      opt.value = String(k); opt.textContent = k + ' · ' + wl + 'nm';
      if (k === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  /* ---------------- 编辑器：传播链接 ---------------- */
  function renderLinkEditor() {
    var host = $('link-editor');
    host.replaceChildren();
    var data = state.data;
    if (!data.links.length) host.appendChild(el('div', 'empty-note', '暂无传播链接。'));
    // 只显示与当前贴片相关的链接，同时提供全局新增
    var related = data.links.map(function (ln, idx) { return { ln: ln, idx: idx }; })
      .filter(function (o) { return o.ln[0] === data.patches[state.selected].id || o.ln[1] === data.patches[state.selected].id; });
    if (!related.length) host.appendChild(el('div', 'empty-note', '当前贴片没有参与任何链接，可在下方新增。'));
    related.forEach(function (o) {
      var row = el('div', 'link-row');
      var srcSel = patchSelect(o.ln[0]), dstSel = patchSelect(o.ln[1]);
      var wInp = document.createElement('input');
      wInp.type = 'number'; wInp.step = 'any'; wInp.min = '0'; wInp.value = String(o.ln[2]);
      var srcSum = data.links.reduce(function (a, ln) { return a + (ln[0] === o.ln[0] ? ln[2] : 0); }, 0);
      if (!Number.isFinite(o.ln[2]) || o.ln[2] < 0 || srcSum > 0.95 + FC.EPS) wInp.classList.add('invalid');
      srcSel.addEventListener('change', function () { data.links[o.idx][0] = srcSel.value; recompute(); });
      dstSel.addEventListener('change', function () { data.links[o.idx][1] = dstSel.value; recompute(); });
      wInp.addEventListener('input', function () {
        var x = parseFloat(wInp.value);
        wInp.classList.toggle('invalid', !Number.isFinite(x) || x < 0);
        if (Number.isFinite(x) && x >= 0) { data.links[o.idx][2] = x; recompute(); }
      });
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { data.links.splice(o.idx, 1); recompute(); });
      row.appendChild(srcSel);
      row.appendChild(el('span', 'field-hint', '→'));
      row.appendChild(dstSel); row.appendChild(wInp); row.appendChild(del);
      host.appendChild(row);
    });
    // 来源合计提示
    var sums = {};
    data.links.forEach(function (ln) { sums[ln[0]] = (sums[ln[0]] || 0) + ln[2]; });
    Object.keys(sums).forEach(function (src) {
      if (sums[src] > 0.95 + FC.EPS || src === data.patches[state.selected].id) {
        var line = el('div', 'sum-label' + (sums[src] > 0.95 + FC.EPS ? ' over' : ''));
        line.replaceChildren();
        line.appendChild(el('span', null, '来源 "' + src + '" 传出合计'));
        line.appendChild(el('b', 'num', sums[src].toFixed(4) + ' / 0.9500'));
        host.appendChild(line);
      }
    });
  }
  function patchSelect(selectedId) {
    var sel = document.createElement('select');
    state.data.patches.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.id;
      if (p.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  /* ---------------- 标签页 ----------------
   * 每次切换都重建编辑器，避免旧 DOM 与数据脱节 */
  function renderEditors() {
    scalarEditor('direct-editor', 'direct');
    scalarEditor('reflect-editor', 'reflect');
    renderConvertEditor();
    renderLinkEditor();
    document.querySelectorAll('[data-pane]').forEach(function (pane) {
      pane.hidden = pane.dataset.pane !== state.tab;
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === state.tab);
    });
  }

  /* ---------------- 总渲染 ---------------- */
  function renderAll() {
    if (state.selected >= state.data.patches.length) state.selected = 0;
    $('status-size').textContent = state.data.patches.length + ' 贴片 · ' +
      state.data.bands.length + ' 波段 · ' + state.data.links.length + ' 传播记录';
    $('status-residual').textContent = '方程最大残差 ' +
      (state.solution ? state.solution.residual.toExponential(2) : '—');
    renderLamp();
    renderSwatches();
    renderDetailHead();
    renderChart();
    renderSpectraTable();
    renderEditors();
  }

  /* ---------------- 导入 / 导出 ----------------
   * 导出内容基于上次有效解，逐贴片逐波段全量 */
  function buildExportText(fmt) {
    var sol = state.solution, d = state.validData;
    if (fmt === 'json') {
      var out = {
        generatedAt: new Date().toISOString(),
        bands: sol.bands,
        lampMultipliers: state.validLamp,
        observerRGB: d.observerRGB,
        residual: sol.residual,
        patches: sol.ids.map(function (id, i) {
          return {
            id: id,
            linearRGB: sol.rgb[i],
            perBand: sol.bands.map(function (wl, k) {
              return {
                band: k, wavelengthNm: wl,
                direct: sol.direct[i][k],
                incident: sol.incident[i][k],
                reflected: sol.reflected[i][k],
                fluorescent: sol.fluorescent[i][k],
                outgoing: sol.outgoing[i][k]
              };
            })
          };
        })
      };
      return JSON.stringify(out, null, 2);
    }
    var head = ['patchId', 'bandIndex', 'wavelengthNm', 'direct', 'incident',
      'reflected', 'fluorescent', 'outgoing', 'linearR', 'linearG', 'linearB'];
    var lines = [head.join(',')];
    sol.ids.forEach(function (id, i) {
      for (var k = 0; k < sol.B; k++) {
        lines.push([
          csv(id), k, sol.bands[k],
          sol.direct[i][k], sol.incident[i][k], sol.reflected[i][k],
          sol.fluorescent[i][k], sol.outgoing[i][k],
          sol.rgb[i][0], sol.rgb[i][1], sol.rgb[i][2]
        ].join(','));
      }
    });
    return lines.join('\n');
  }
  function csv(s) { return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  function openExportModal() {
    var backdrop = el('div', 'modal-backdrop');
    var modal = el('div', 'modal');
    modal.appendChild(el('h2', null, '导出逐贴片逐波段数据（基于上次有效解）'));
    var radioRow = el('div', 'radio-row');
    ['csv', 'json'].forEach(function (f, ix) {
      var lab = document.createElement('label');
      var r = document.createElement('input');
      r.type = 'radio'; r.name = 'export-fmt'; r.value = f;
      if (ix === 0) r.checked = true;
      lab.appendChild(r); lab.appendChild(document.createTextNode(f.toUpperCase()));
      radioRow.appendChild(lab);
    });
    modal.appendChild(radioRow);
    var box = document.createElement('textarea');
    box.className = 'export-box'; box.readOnly = true;
    box.value = buildExportText('csv');
    modal.appendChild(box);
    radioRow.addEventListener('change', function () {
      var fmt = document.querySelector('input[name="export-fmt"]:checked').value;
      box.value = buildExportText(fmt);
    });
    var actions = el('div', 'modal-actions');
    var copyBtn = el('button', 'btn primary', '复制到剪贴板');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () {
      box.focus(); box.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(function () { toast('已复制' + box.value.length + ' 字符'); },
          function () { fallbackCopy(); });
      } else fallbackCopy();
      function fallbackCopy() {
        try { document.execCommand('copy'); toast('已复制'); } catch (e4) { toast('复制失败，请手动全选复制'); }
      }
    });
    var dlBtn = el('button', 'btn', '下载文件');
    dlBtn.type = 'button';
    dlBtn.addEventListener('click', function () {
      var fmt = document.querySelector('input[name="export-fmt"]:checked').value;
      var blob = new Blob([box.value], { type: fmt === 'json' ? 'application/json' : 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fluorescent-relight-export.' + fmt;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
    var closeBtn = el('button', 'btn ghost', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () { backdrop.remove(); });
    backdrop.addEventListener('click', function (e5) { if (e5.target === backdrop) backdrop.remove(); });
    actions.appendChild(dlBtn); actions.appendChild(copyBtn); actions.appendChild(closeBtn);
    modal.appendChild(actions);
    modal.appendChild(el('div', 'footer-note',
      '全部为线性能量量；CSV 中 RGB 三列为该贴片的观察权重加权线性值，逐行重复以便外部工具读取。'));
    backdrop.appendChild(modal);
    $('modal-root').appendChild(backdrop);
  }

  function importJsonText(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e6) {
      toast('JSON 解析失败：' + e6.message);
      return;
    }
    var v = FC.validate(parsed);
    if (!v.ok) {
      // 非法导入：整体拒绝，保留当前有效结果，错误走横幅
      state.data = clone(parsed);
      recompute();
      toast('导入数据不合法，已保留当前结果');
      return;
    }
    state.data = parsed;
    state.lamp = parsed.bands.map(function () { return 1; });
    state.selected = 0;
    state.gain = null; state.manualGain = false;
    recompute();
    toast('已导入 ' + parsed.patches.length + ' 个贴片、' + parsed.bands.length + ' 个波段');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('btn-import').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e7) {
      var f = e7.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { importJsonText(reader.result); };
      reader.readAsText(f);
      e7.target.value = '';
    });
    $('btn-export').addEventListener('click', openExportModal);
    $('btn-reset').addEventListener('click', function () {
      state.data = clone(EMBEDDED_SAMPLE);
      state.lamp = EMBEDDED_SAMPLE.bands.map(function () { return 1; });
      state.selected = 0; state.gain = null; state.manualGain = false;
      recompute();
      toast('已恢复内置样例');
    });
    $('btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.dataset.theme;
      var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = (!cur && dark) || cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      persist(); renderAll();
    });
    $('detail-tabs').addEventListener('click', function (e8) {
      var tab = e8.target.closest('.tab');
      if (!tab) return;
      state.tab = tab.dataset.tab;
      renderEditors();
    });
    $('btn-add-convert').addEventListener('click', function () {
      var p = state.data.patches[state.selected], B = state.data.bands;
      var src = 0, dst = Math.min(1, B - 1);
      p.convert.push([src, dst, 0.05]);
      recompute();
    });
    $('btn-add-link').addEventListener('click', function () {
      var ids = state.data.patches.map(function (p) { return p.id; });
      state.data.links.push([ids[state.selected], ids[(state.selected + 1) % ids.length], 0.1]);
      recompute();
    });
    $('gain-range').addEventListener('input', function () {
      state.manualGain = true;
      state.gain = Math.pow(10, parseFloat($('gain-range').value));
      renderSwatches(); renderDetailHead();
    });
    $('btn-gain-reset').addEventListener('click', function () {
      state.manualGain = false; state.gain = null;
      renderSwatches(); renderDetailHead(); persist();
    });
  }

  /* ---------------- 启动 ---------------- */
  restore();
  bind();
  // 主题变化时重绘 SVG 取色
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { renderAll(); });
  }
  recompute();
})();
