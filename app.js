/* 子像素点阵打样台 —— 界面 */
(function () {
  'use strict';
  const C = window.FoundryCore;
  const $ = (id) => document.getElementById(id);

  const SAMPLE = {
    tests: [[1, 0, 1, 1], [1, 1, 2, 4], [3, -2, 1, 2]],
    pins: [[0, 0]],
    bans: [[1, 1]],
  };

  const state = {
    dataset: null,          // { tests:[{a,b,c,w}], pins:[[r,c]], bans:[[r,c]] }
    result: null,           // 上次成功结果（含 pins/bans 快照）
    selected: 0,
    conflict: null,         // 当前约束冲突说明（null 表示可行）
  };

  /* ---------- 小工具 ---------- */
  function fmt(r) { return C.rToFixed(r, 5); }
  function exactShort(r) {
    const s = C.rToString(r);
    return s.length > 24 ? s.slice(0, 11) + '…' + s.slice(-9) : s;
  }
  function errClass(r) {
    const v = Math.abs(C.rNum(r));
    if (v < 1e-9) return 'good';
    if (v < 0.01) return 'mid';
    return 'bad';
  }
  function signNum(v) { return (v < 0 ? '−' : '') + Math.abs(v); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  /* ---------- 当前约束（始终显示用户正在编辑的约束） ---------- */
  /* ---------- 数据装载 ---------- */
  function sameTests(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.a !== y.a || x.b !== y.b || x.c !== y.c || x.w !== y.w) return false;
    }
    return true;
  }

  function setDataset(ds) {
    // 测例改变则旧结果失去意义；仅约束变化时保留旧结果用于冲突回退。
    if (!state.dataset || !sameTests(state.dataset.tests, ds.tests)) {
      state.result = null;
      state.selected = 0;
    }
    state.dataset = ds;
    if (state.selected >= ds.tests.length) state.selected = 0;
    syncDataText();
    hideDataError();
    solveNow({ resetView: !state.result });
  }

  function syncDataText() {
    if (!state.dataset) return;
    $('dataJson').value = JSON.stringify({
      tests: state.dataset.tests.map((t) => [t.a, t.b, t.c, t.w]),
      pins: state.dataset.pins,
      bans: state.dataset.bans,
    });
  }

  /* ---------- 求解 ---------- */
  function solveNow(opts) {
    opts = opts || {};
    const ds = state.dataset;
    try {
      const res = C.solve({ tests: ds.tests, pins: ds.pins, bans: ds.bans });
      if (!res.ok) {
        applyConflict(res.reason);
        return;
      }
      res.pins = ds.pins.map((p) => p.slice());
      res.bans = ds.bans.map((p) => p.slice());
      state.result = res;
      state.conflict = null;
      if (opts.resetView) state.selected = 0;
      if (state.selected >= res.details.rows.length) state.selected = 0;
      clearBanner();
      renderAll();
    } catch (e) {
      applyConflict('求解失败：' + e.message);
    }
  }

  function applyConflict(reason) {
    state.conflict = reason;
    showBanner(reason, !!state.result);
    renderAll();
  }

  function showBanner(reason, kept) {
    const el = $('conflict');
    const tail = kept
      ? '已保留上一次的求解结果与点阵，界面仍显示该结果；请调整锁定或禁用后重试。'
      : '当前没有任何可用点阵，请调整锁定或禁用后重试。';
    el.innerHTML = '<strong>无解</strong> · ' + esc(reason) + '<br>' + tail;
    el.hidden = false;
  }
  function clearBanner() { $('conflict').hidden = true; }

  function showDataError(msg) { const el = $('dataError'); el.textContent = msg; el.hidden = false; }
  function hideDataError() { $('dataError').hidden = true; }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    renderTestList();
    renderSummary();
    renderPattern();
    renderSelected();
  }

  function renderEmpty() {
    clearNode($('testList'));
    ['sumMax', 'sumWsum', 'sumTime', 'sumFeasible', 'sumEvaluated'].forEach((id) => { $(id).textContent = '—'; });
    $('sumMaxDec').textContent = '';
    $('sumWsumDec').textContent = '';
    clearNode($('windowSvg'));
    $('selEq').textContent = '—';
    $('selSample').textContent = '—';
    $('selTrue').textContent = '—';
    $('selErr').textContent = '—';
  }

  function currentPerm() {
    return state.result ? state.result.perm : null;
  }

  function renderTestList() {
    const list = $('testList');
    clearNode(list);
    const ds = state.dataset;
    if (!ds) return;
    $('testCount').textContent = ds.tests.length + ' 条';
    const byIndex = new Map();
    if (state.result) for (const r of state.result.details.rows) byIndex.set(r.index, r);

    ds.tests.forEach((t, i) => {
      const row = byIndex.get(i);
      const btn = document.createElement('button');
      btn.className = 'test-row' + (i === state.selected ? ' active' : '');
      btn.dataset.index = String(i);
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.innerHTML = `${signNum(t.a)}x ${signNum(t.b)}y ≤ ${t.c} <span class="w">×${t.w}</span>`;
      const err = document.createElement('span');
      if (row) {
        err.className = 'err ' + errClass(row.error);
        err.textContent = fmt(row.error);
      } else {
        err.className = 'err';
        err.textContent = '—';
      }
      btn.append(idx, eq, err);
      btn.addEventListener('click', () => selectTest(i));
      list.appendChild(btn);
    });
  }

  function renderSummary() {
    const ds = state.dataset;
    $('sumCount').textContent = ds ? String(ds.tests.length) : '—';
    const r = state.result;
    if (!r) {
      ['sumMax', 'sumWsum', 'sumTime', 'sumFeasible', 'sumEvaluated'].forEach((id) => { $(id).textContent = '—'; });
      $('sumMaxDec').textContent = '';
      $('sumWsumDec').textContent = '';
      return;
    }
    $('sumMax').textContent = fmt(r.maxError);
    $('sumMaxDec').textContent = '精确 ' + exactShort(r.maxError);
    $('sumWsum').textContent = fmt(r.weightedSum);
    $('sumWsumDec').textContent = '精确 ' + exactShort(r.weightedSum);
    $('sumTime').textContent = r.elapsedMs.toFixed(1) + ' ms' + (state.conflict ? ' · 沿用上次' : '');
    $('sumFeasible').textContent = r.feasibleCount.toLocaleString('en-US');
    $('sumEvaluated').textContent = r.evaluated.toLocaleString('en-US');
  }

  function selectTest(i) {
    if (!state.dataset || i < 0 || i >= state.dataset.tests.length) return;
    state.selected = i;
    renderTestList();
    renderSelected();
    const active = $('testList').querySelector('.test-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 窗口可视化 ---------- */
  const VIEW = 680;
  const PAD = 46;
  const SPAN = VIEW - PAD * 2; // 坐标 0..2 的像素跨度
  const UNIT = SPAN / 2;

  function toScreen(x, y) { return [PAD + x * UNIT, VIEW - PAD - y * UNIT]; }

  function renderSelected() {
    const ds = state.dataset;
    if (!ds || !ds.tests.length) { renderEmpty(); return; }
    const test = ds.tests[state.selected];
    const perm = currentPerm();
    const rowInfo = state.result ? state.result.details.rows.find((r) => r.index === state.selected) : null;

    $('testCounter').textContent = `${state.selected + 1} / ${ds.tests.length}`;
    $('selEq').innerHTML = `${signNum(test.a)}x ${signNum(test.b)}y ≤ ${test.c}<span class="w">权重 ×${test.w}</span>`;

    if (rowInfo) {
      $('selSample').textContent = fmt(rowInfo.sampleRatio);
      $('selSampleSub').textContent = `覆盖 ${rowInfo.covered} / 32 · 精确 ${C.rToString(rowInfo.sampleRatio)}`;
      $('selTrue').textContent = fmt(rowInfo.trueRatio);
      $('selTrueSub').textContent = '精确 ' + exactShort(rowInfo.trueRatio);
      $('selErr').textContent = fmt(rowInfo.error);
      $('selErrSub').textContent = '精确 ' + exactShort(rowInfo.error);
    } else {
      $('selSample').textContent = '—';
      $('selSampleSub').textContent = '—';
      $('selTrue').textContent = '—';
      $('selTrueSub').textContent = '—';
      $('selErr').textContent = '—';
      $('selErrSub').textContent = '—';
    }
    drawWindow(test, perm);
  }

  function drawWindow(test, perm) {
    const svg = $('windowSvg');
    clearNode(svg);

    const defs = svgEl('defs');
    const cp = svgEl('clipPath', { id: 'winClip' });
    const [cx0, cy0] = toScreen(0, 2);
    cp.appendChild(svgEl('rect', { x: cx0, y: cy0, width: UNIT * 2, height: UNIT * 2 }));
    defs.appendChild(cp);
    svg.appendChild(defs);

    // 像素背景
    for (let py = 0; py < 2; py++) {
      for (let px = 0; px < 2; px++) {
        const even = (px + py) % 2 === 0;
        const [x0, y0] = toScreen(px, py + 1);
        svg.appendChild(svgEl('rect', {
          x: x0, y: y0, width: UNIT, height: UNIT,
          fill: even ? '#151b22' : '#10151b',
        }));
      }
    }

    // 子格线（每像素 8×8）
    for (let py = 0; py < 2; py++) {
      for (let px = 0; px < 2; px++) {
        const g = svgEl('g', { stroke: '#222b35', 'stroke-width': 1 });
        for (let i = 1; i < 8; i++) {
          const [xa, ya] = toScreen(px + i / 8, py);
          const [, yb] = toScreen(px + i / 8, py + 1);
          g.appendChild(svgEl('line', { x1: xa, y1: ya, x2: xa, y2: yb }));
          const [xc, yc] = toScreen(px, py + i / 8);
          const [xd] = toScreen(px + 1, py + i / 8);
          g.appendChild(svgEl('line', { x1: xc, y1: yc, x2: xd, y2: yc }));
        }
        svg.appendChild(g);
      }
    }

    // 覆盖区域
    const poly = C.clipPolygon(test.a, test.b, test.c);
    if (poly.length >= 3) {
      const pts = poly.map((p) => toScreen(C.rNum(p.x), C.rNum(p.y)).join(',')).join(' ');
      svg.appendChild(svgEl('polygon', {
        points: pts, fill: 'rgba(233,180,81,0.16)', stroke: 'none', 'clip-path': 'url(#winClip)',
      }));
    }

    // 像素边框 + 偶/奇标注
    for (let py = 0; py < 2; py++) {
      for (let px = 0; px < 2; px++) {
        const [x0, y0] = toScreen(px, py + 1);
        svg.appendChild(svgEl('rect', {
          x: x0, y: y0, width: UNIT, height: UNIT, fill: 'none', stroke: '#3b4653', 'stroke-width': 1.4,
        }));
        const even = (px + py) % 2 === 0;
        const label = svgEl('text', {
          x: x0 + 10, y: y0 + 20, fill: even ? '#5ac8e8' : '#e9b451', 'font-size': 15,
          'font-family': 'monospace', opacity: 0.72,
        });
        label.textContent = even ? '偶' : '奇';
        svg.appendChild(label);
      }
    }

    // 切边
    drawCutLine(svg, test);

    // 采样点
    if (perm) {
      const pts = C.samplePointsForTest(test, perm);
      const dotR = 9;
      for (const p of pts) {
        const [sx, sy] = toScreen(p.x, p.y);
        const g = svgEl('g');
        if (p.covered) {
          g.appendChild(svgEl('circle', { cx: sx, cy: sy, r: dotR, fill: '#5ac8e8', opacity: 0.94 }));
          if (p.onLine) g.appendChild(svgEl('circle', { cx: sx, cy: sy, r: dotR + 4.5, fill: 'none', stroke: '#ffffff', 'stroke-width': 2 }));
        } else {
          g.appendChild(svgEl('circle', { cx: sx, cy: sy, r: dotR - 1, fill: '#0d1014', stroke: '#828d9b', 'stroke-width': 2.2 }));
        }
        const title = svgEl('title');
        title.textContent = `行 ${p.row} · 列 ${p.col} · 像素(${p.pixel.join(',')}) ${p.covered ? '覆盖' : '未覆盖'}${p.onLine ? ' · 在线上' : ''}`;
        g.appendChild(title);
        svg.appendChild(g);
      }
    } else {
      const hint = svgEl('text', {
        x: VIEW / 2, y: VIEW / 2, fill: '#7d8794', 'font-size': 20, 'text-anchor': 'middle', 'font-family': 'sans-serif',
      });
      hint.textContent = '尚无可行点阵';
      svg.appendChild(hint);
    }

    addAxisLabels(svg);
  }

  function drawCutLine(svg, test) {
    const seg = clipLineToBox(test.a, test.b, test.c, 0, 2, 0, 2);
    if (seg) {
      const [x1, y1] = toScreen(seg[0], seg[1]);
      const [x2, y2] = toScreen(seg[2], seg[3]);
      svg.appendChild(svgEl('line', {
        x1, y1, x2, y2, stroke: '#e9b451', 'stroke-width': 2.8, 'stroke-linecap': 'round',
      }));
    }
  }

  function clipLineToBox(a, b, c, xmin, xmax, ymin, ymax) {
    const pts = [];
    const push = (x, y) => {
      if (x >= xmin - 1e-9 && x <= xmax + 1e-9 && y >= ymin - 1e-9 && y <= ymax + 1e-9) {
        for (const p of pts) if (Math.abs(p[0] - x) < 1e-7 && Math.abs(p[1] - y) < 1e-7) return;
        pts.push([x, y]);
      }
    };
    if (b !== 0) { push(xmin, (c - a * xmin) / b); push(xmax, (c - a * xmax) / b); }
    if (a !== 0) { push((c - b * ymin) / a, ymin); push((c - b * ymax) / a, ymax); }
    return pts.length >= 2 ? [pts[0][0], pts[0][1], pts[1][0], pts[1][1]] : null;
  }

  function addAxisLabels(svg) {
    const dim = '#5c6572';
    for (let i = 0; i <= 2; i++) {
      const [x, y] = toScreen(i, 0);
      const t = svgEl('text', { x, y: y + 24, fill: dim, 'font-size': 15, 'text-anchor': 'middle', 'font-family': 'monospace' });
      t.textContent = String(i); svg.appendChild(t);
      const [x2, y2] = toScreen(0, i);
      const u = svgEl('text', { x: x2 - 17, y: y2 + 5, fill: dim, 'font-size': 15, 'text-anchor': 'end', 'font-family': 'monospace' });
      u.textContent = String(i); svg.appendChild(u);
    }
  }

  /* ---------- 原点阵 ---------- */
  const PSIZE = 384;
  const POFF = 24;
  const PCELL = (PSIZE - POFF * 2) / 8;

  function renderPattern() {
    const svg = $('patternSvg');
    clearNode(svg);
    const perm = currentPerm();
    const cons = state.dataset;
    const pinOf = new Map();
    for (const [r, c] of cons.pins) pinOf.set(r, c);
    const banSet = new Set(cons.bans.map(([r, c]) => r * 8 + c));
    const chosen = new Set();
    if (perm) for (let r = 0; r < 8; r++) chosen.add(r * 8 + perm[r]);

    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: PSIZE, height: PSIZE, fill: '#0f1318' }));

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const x = POFF + c * PCELL, y = POFF + r * PCELL;
        const isPin = pinOf.get(r) === c;
        const isBan = banSet.has(r * 8 + c);
        const isChosen = chosen.has(r * 8 + c);
        let fill = '#151b22';
        if (isBan) fill = 'rgba(226,104,95,.12)';
        else if (isPin) fill = 'rgba(233,180,81,.16)';
        else if (isChosen) fill = 'rgba(90,200,232,.10)';
        const rect = svgEl('rect', {
          x: x + 1.5, y: y + 1.5, width: PCELL - 3, height: PCELL - 3, rx: 5, fill,
          stroke: isPin ? 'rgba(233,180,81,.7)' : isBan ? 'rgba(226,104,95,.45)' : (isChosen ? 'rgba(90,200,232,.45)' : '#1f2832'),
          'stroke-width': isPin || isBan ? 1.7 : 1,
          'data-cell': `${r},${c}`,
        });
        rect.style.cursor = 'pointer';
        rect.addEventListener('click', () => toggleCell(r, c));
        svg.appendChild(rect);

        const cx = x + PCELL / 2, cy = y + PCELL / 2;
        const overlay = svgEl('g', { 'pointer-events': 'none' });
        if (isChosen && !isBan) {
          overlay.appendChild(svgEl('circle', {
            cx, cy, r: 7.5, fill: isPin ? '#e9b451' : '#5ac8e8', stroke: '#0f1318', 'stroke-width': 1.6,
          }));
        }
        if (isBan) {
          overlay.appendChild(svgEl('line', { x1: cx - 7, y1: cy - 7, x2: cx + 7, y2: cy + 7, stroke: '#e2685f', 'stroke-width': 2.3, 'stroke-linecap': 'round' }));
          overlay.appendChild(svgEl('line', { x1: cx + 7, y1: cy - 7, x2: cx - 7, y2: cy + 7, stroke: '#e2685f', 'stroke-width': 2.3, 'stroke-linecap': 'round' }));
        }
        svg.appendChild(overlay);
      }
    }

    for (let i = 0; i < 8; i++) {
      const tx = svgEl('text', { x: POFF + i * PCELL + PCELL / 2, y: POFF - 8, fill: '#5c6572', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'monospace' });
      tx.textContent = String(i); svg.appendChild(tx);
      const ty = svgEl('text', { x: POFF - 10, y: POFF + i * PCELL + PCELL / 2 + 4, fill: '#5c6572', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'monospace' });
      ty.textContent = String(i); svg.appendChild(ty);
    }

    $('permText').textContent = perm ? perm.join(' ') : '无可行点阵';
    renderTags(cons);
  }

  function renderTags(cons) {
    const wrap = $('pinList');
    clearNode(wrap);
    if (!cons.pins.length && !cons.bans.length) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = '未设置约束';
      wrap.appendChild(s);
      return;
    }
    for (const [r, c] of cons.pins) {
      const t = document.createElement('span'); t.className = 'tag pin'; t.textContent = `锁 ${r},${c}`; wrap.appendChild(t);
    }
    for (const [r, c] of cons.bans) {
      const t = document.createElement('span'); t.className = 'tag ban'; t.textContent = `禁 ${r},${c}`; wrap.appendChild(t);
    }
  }

  function toggleCell(r, c) {
    const ds = state.dataset;
    const inPins = ds.pins.findIndex(([pr, pc]) => pr === r && pc === c);
    const inBans = ds.bans.findIndex(([br, bc]) => br === r && bc === c);
    if (inPins >= 0) {
      ds.pins.splice(inPins, 1);
      ds.bans.push([r, c]);
    } else if (inBans >= 0) {
      ds.bans.splice(inBans, 1);
    } else {
      ds.pins.push([r, c]);
    }
    syncDataText();
    solveNow();
  }

  /* ---------- 导入 / 导出 ---------- */
  function applyDataText() {
    let raw, ds;
    try { raw = JSON.parse($('dataJson').value); }
    catch (e) { showDataError('JSON 解析失败：' + e.message); return; }
    try { ds = C.parseDataset(raw); }
    catch (e) { showDataError(e.message); return; }
    hideDataError();
    setDataset(ds);
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => { $('dataJson').value = String(reader.result); applyDataText(); };
    reader.onerror = () => showDataError('读取文件失败');
    reader.readAsText(file);
  }

  function exportResult() {
    if (!state.result) { showDataError('尚无可导出的结果，请先求解。'); return; }
    const r = state.result;
    const payload = {
      permutation: r.perm,
      pattern: r.perm.map((c, row) => [row, c]),
      maxAbsoluteError: C.rToString(r.maxError),
      maxAbsoluteErrorDecimal: fmt(r.maxError),
      weightedAbsoluteErrorSum: C.rToString(r.weightedSum),
      weightedAbsoluteErrorSumDecimal: fmt(r.weightedSum),
      elapsedMs: Math.round(r.elapsedMs * 10) / 10,
      feasibleCount: r.feasibleCount,
      evaluatedCount: r.evaluated,
      pins: r.pins,
      bans: r.bans,
      tests: r.details.rows.map((row) => ({
        index: row.index + 1,
        a: row.a, b: row.b, c: row.c, weight: row.w,
        coveredPoints: row.covered,
        sampleRatio: C.rToString(row.sampleRatio),
        sampleRatioDecimal: fmt(row.sampleRatio),
        trueRatio: C.rToString(row.trueRatio),
        trueRatioDecimal: fmt(row.trueRatio),
        absoluteError: C.rToString(row.error),
        absoluteErrorDecimal: fmt(row.error),
        weightedError: C.rToString(C.rat(BigInt(row.w) * row.error.n, row.error.d)),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'subpixel-pattern-result.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- 事件 ---------- */
  function bind() {
    $('btnImport').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    $('btnSample').addEventListener('click', () => {
      hideDataError();
      setDataset(C.parseDataset(SAMPLE));
    });
    $('btnSolve').addEventListener('click', () => solveNow());
    $('btnExport').addEventListener('click', exportResult);
    $('btnApplyData').addEventListener('click', applyDataText);
    $('btnClearConstraints').addEventListener('click', () => {
      state.dataset.pins.length = 0;
      state.dataset.bans.length = 0;
      syncDataText();
      solveNow();
    });
    $('prevTest').addEventListener('click', () => selectTest(state.selected - 1));
    $('nextTest').addEventListener('click', () => selectTest(state.selected + 1));
    document.addEventListener('keydown', (e) => {
      if (e.target && ['TEXTAREA', 'INPUT'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') selectTest(state.selected - 1);
      if (e.key === 'ArrowRight') selectTest(state.selected + 1);
    });
  }

  bind();
  setDataset(C.parseDataset(SAMPLE));
})();
