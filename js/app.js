/*
 * app.js — DOM 绑定、画布渲染、拖拽与导入导出。
 * 所有数学/历史都在 engine/studio 中；本文件只做视图。
 */
(function () {
  'use strict';
  const RKS = globalThis.RKS;
  const { Frac, Studio, evalPointFloat, distinctKnots } = RKS;

  // 与 samples/rational-knot.json 完全一致的内置兜底（file:// 无法 fetch 时首屏仍可用）
  const EMBEDDED_SAMPLE = {
    format: 'degree为次数p；points各为[X,Y,W]，投影坐标为[X/W,Y/W]。knots非降，数目为控制点数+p+1，两端各重复p+1次，内部重数最多p。分量和节点用整数字符串或分数字符串，输出分母正且约分，整数不带分母。曲线为各齐次点按通常B样条基函数线性组合后除以W，p=0时基函数为半开区间指示量，高次按Cox递推，零分母项取0，右端点取左极限。导数按原参数，对投影坐标求左右导数，端点只显示存在的一侧。插入或删除每次只增减一个内部节点。移点输入投影坐标并保留W，改权重时保留该投影坐标。SVG每段含data-u0和data-u1，坐标与样条坐标同轴同尺度；段内按参数线性插值，再与原曲线欧氏距离比较。',
    degree: 2,
    knots: ['0', '0', '0', '1', '1', '1'],
    points: [['1', '0', '1'], ['3/4', '3/4', '3/4'], ['0', '1', '1']],
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  /* ---------------- 单例与视图状态 ---------------- */
  const studio = new Studio(EMBEDDED_SAMPLE);
  RKS.studio = studio;
  globalThis.rksStudio = studio; // 便捷全局

  const ui = {
    selectedPoint: 0,
    selectedKnotR: null,
    view: null,
    lastQuery: null,
  };
  // 启动后台 fetch 样例的保护：一旦用户/API 有载入或编辑，就不得再用文件覆盖状态
  let bootDirty = false;

  const W = 1000, H = 620, PAD = 52;

  function projectedCP(c, i) {
    const p = c.points[i];
    if (p.W.isZero()) return [p.X.toNumber(), p.Y.toNumber()];
    return [p.X.div(p.W).toNumber(), p.Y.div(p.W).toNumber()];
  }

  function computeFit() {
    const c = studio.curve;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const bump = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    c.points.forEach((_, i) => { const q = projectedCP(c, i); bump(q[0], q[1]); });
    // 曲线采样也纳入范围，避免异常权重下控制点与曲线脱节
    const Uf = c.knots.map((k) => k.toNumber());
    const a = Uf[0], b = Uf[Uf.length - 1];
    for (let i = 0; i <= 240; i++) {
      const p = evalPointFloat(c, Uf, a + (b - a) * i / 240);
      if (p) bump(p[0], p[1]);
    }
    if (!Number.isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1; }
    let sx = maxX - minX, sy = maxY - minY;
    if (!(sx > 1e-12)) { sx = Math.max(1, Math.abs(minX) * 0.2); }
    if (!(sy > 1e-12)) { sy = Math.max(1, Math.abs(minY) * 0.2); }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const scale = Math.min((W - 2 * PAD) / sx, (H - 2 * PAD) / sy);
    const v = {
      cx, cy, scale,
      X: (x) => W / 2 + (x - cx) * scale,
      Y: (y) => H / 2 - (y - cy) * scale,
      invX: (X) => (X - W / 2) / scale + cx,
      invY: (Y) => cy - (Y - H / 2) / scale,
    };
    ui.view = v;
    return v;
  }

  /* ---------------- 状态条 ---------------- */
  let statusTimer = null;
  function setStatus(msg, kind) {
    const el = $('status-message');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (kind === 'ok') statusTimer = setTimeout(() => {
      el.textContent = '就绪。'; el.className = 'status';
    }, 2600);
  }

  function handleOp(result, okMsg) {
    if (result && result.ok) {
      if (okMsg) setStatus(okMsg, 'ok');
      // studio 变更事件会触发 refresh
    } else {
      setStatus('操作失败：' + ((result && result.error) || '未知错误'), 'error');
    }
  }

  /* ---------------- 画布渲染 ---------------- */
  function renderGrid(v) {
    let html = '';
    for (let x = 0; x <= W; x += 50) {
      html += `<line class="grid-line" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
    }
    for (let y = 0; y <= H; y += 50) {
      html += `<line class="grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    }
    // 数学零轴
    const zx = v.X(0), zy = v.Y(0);
    if (zx >= 0 && zx <= W) html += `<line class="grid-axis" x1="${zx}" y1="0" x2="${zx}" y2="${H}"/>`;
    if (zy >= 0 && zy <= H) html += `<line class="grid-axis" x1="0" y1="${zy}" x2="${W}" y2="${zy}"/>`;
    $('g-grid').innerHTML = html;
  }

  function renderStage() {
    const c = studio.curve;
    if (!ui.view) computeFit();
    const v = ui.view;
    renderGrid(v);
    const Uf = c.knots.map((k) => k.toNumber());
    const N = c.points.length;

    // 控制多边形 + 手柄
    let poly = '';
    const screenPts = c.points.map((_, i) => {
      const q = projectedCP(c, i);
      return [v.X(q[0]), v.Y(q[1])];
    });
    if (screenPts.length >= 2) {
      poly = '<polyline class="polygon" points="' +
        screenPts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ') + '"/>';
    }
    $('g-polygon').innerHTML = poly;

    // 曲线：每个不同节点区间固定密度采样
    const knots = distinctKnots(c);
    let d = '';
    const SUBD = 26;
    let started = false;
    for (let ki = 0; ki < knots.length - 1; ki++) {
      const a = knots[ki], b = knots[ki + 1];
      if (!b.gt(a)) continue;
      const an = a.toNumber(), bn = b.toNumber();
      for (let j = 0; j <= SUBD; j++) {
        // 跨区间的 j=0 与上一区间终点重合，直接跳过以避免重复 M
        if (j === 0 && started) continue;
        const u = an + (bn - an) * j / SUBD;
        const p = evalPointFloat(c, Uf, u);
        if (!p) continue;
        const X = v.X(p[0]).toFixed(2), Y = v.Y(p[1]).toFixed(2);
        d += (started ? 'L' : 'M') + X + ' ' + Y + ' ';
        started = true;
      }
    }
    $('curve-path').setAttribute('d', d.trim());

    // 节点标记（曲线点上的菱形）
    let kh = '';
    const multMap = new Map();
    for (const k of c.knots) multMap.set(k.toString(), (multMap.get(k.toString()) || 0) + 1);
    const seen = new Set();
    for (let r = RKS.interiorOccurrenceRange(c).first; r <= RKS.interiorOccurrenceRange(c).last; r++) {
      const k = c.knots[r];
      const key = k.toString();
      const p = evalPointFloat(c, Uf, k.toNumber());
      if (!p) continue;
      const X = v.X(p[0]), Y = v.Y(p[1]);
      const selected = ui.selectedKnotR === r;
      kh += `<g class="knot-marker${selected ? ' selected' : ''}" data-r="${r}" transform="translate(${X.toFixed(2)},${Y.toFixed(2)})">
        <rect class="knot-diamond" x="-5.5" y="-5.5" width="11" height="11" transform="rotate(45)"/>`;
      if (!seen.has(key)) {
        seen.add(key);
        const m = multMap.get(key);
        if (m > 1) kh += `<text class="knot-mult" x="8" y="13">×${m}</text>`;
      }
      kh += '</g>';
    }
    $('g-knots').innerHTML = kh;

    // 控制点手柄
    let ph = '';
    for (let i = 0; i < N; i++) {
      const [X, Y] = screenPts[i];
      const sel = ui.selectedPoint === i ? ' selected' : '';
      ph += `<g class="cp-handle${sel}" data-i="${i}" transform="translate(${X.toFixed(2)},${Y.toFixed(2)})">
        <rect class="cp-square" x="-6.5" y="-6.5" width="13" height="13" rx="2.5"/>
        <text class="cp-label" x="9" y="-8">${i}</text>
      </g>`;
    }
    $('g-points').innerHTML = ph;

    renderQueryMarker(v);
  }

  function renderQueryMarker(v) {
    const g = $('g-query');
    if (!ui.lastQuery || !ui.lastQuery.ok) { g.innerHTML = ''; return; }
    const q = ui.lastQuery;
    const X = v.X(q.point.x.toNumber()), Y = v.Y(q.point.y.toNumber());
    g.innerHTML =
      `<circle cx="${X}" cy="${Y}" r="7" fill="none" stroke="#d92d20" stroke-width="2"/>
       <line x1="${X - 11}" y1="${Y}" x2="${X + 11}" y2="${Y}" stroke="#d92d20" stroke-width="1.4"/>
       <line x1="${X}" y1="${Y - 11}" x2="${X}" y2="${Y + 11}" stroke="#d92d20" stroke-width="1.4"/>`;
  }

  /* ---------------- 右侧列表/表单 ---------------- */
  function renderMeta() {
    const c = studio.curve;
    const { a, b } = RKS.domain(c);
    const range = RKS.interiorOccurrenceRange(c);
    const interiorCount = Math.max(0, range.last - range.first + 1);
    $('curve-meta').innerHTML =
      `<span>p=<b>${c.degree}</b></span>` +
      `<span>控制点 <b>${c.points.length}</b>/${RKS.INT_MAX_CP}</span>` +
      `<span>节点 <b>${c.knots.length}</b></span>` +
      `<span>内部出现 <b>${interiorCount}</b></span>` +
      `<span>域 <b>[${a.toString()}, ${b.toString()}]</b></span>`;
  }

  function renderKnotList() {
    const c = studio.curve;
    const { first, last } = RKS.interiorOccurrenceRange(c);
    const wrap = $('knot-list');
    if (ui.selectedKnotR != null && (ui.selectedKnotR < first || ui.selectedKnotR > last)) {
      ui.selectedKnotR = null;
    }
    if (first > last) {
      wrap.innerHTML = '<span class="knot-empty">（无内部节点；可在上方插入分数节点）</span>';
      $('selected-knot').textContent = '无';
      $('btn-remove-knot').disabled = true;
      return;
    }
    const multMap = new Map();
    for (const k of c.knots) multMap.set(k.toString(), (multMap.get(k.toString()) || 0) + 1);
    let html = '';
    for (let r = first; r <= last; r++) {
      const k = c.knots[r];
      const m = multMap.get(k.toString());
      const sel = ui.selectedKnotR === r ? ' selected' : '';
      html += `<span class="knot-chip${sel}" data-select-r="${r}" title="选中节点出现位置 #${r}">
        #${r} ${k.toString()}${m > 1 ? ' ·重' + m : ''}
        <button type="button" class="x" data-remove-r="${r}" aria-label="删除节点 #${r}">×</button>
      </span>`;
    }
    wrap.innerHTML = html;
    updateSelectedKnotLabel();
  }

  function updateSelectedKnotLabel() {
    const c = studio.curve;
    const r = ui.selectedKnotR;
    const el = $('selected-knot');
    const btn = $('btn-remove-knot');
    if (r == null || !c.knots[r]) {
      el.textContent = '无';
      btn.disabled = true;
    } else {
      el.textContent = `r=${r}, u=${c.knots[r].toString()}`;
      btn.disabled = false;
    }
  }

  function renderCPTable() {
    const c = studio.curve;
    if (ui.selectedPoint >= c.points.length) ui.selectedPoint = 0;
    let html = '';
    for (let i = 0; i < c.points.length; i++) {
      const p = c.points[i];
      let px = '—', py = '—';
      if (!p.W.isZero()) {
        const x = p.X.div(p.W), y = p.Y.div(p.W);
        px = x.toDecimal(3); py = y.toDecimal(3);
      }
      const sel = ui.selectedPoint === i ? ' selected' : '';
      html += `<tr class="${sel}" data-i="${i}">
        <td>${i}</td><td title="${p.X.toString()}">${p.X.toDecimal(4)}</td>
        <td title="${p.Y.toString()}">${p.Y.toDecimal(4)}</td>
        <td title="${p.W.toString()}">${p.W.toDecimal(4)}</td>
        <td class="proj">(${px}, ${py})</td></tr>`;
    }
    $('cp-tbody').innerHTML = html;
    $('selected-info').textContent = '已选#' + ui.selectedPoint;
  }

  function updatePointEditorInputs(force) {
    const c = studio.curve;
    const i = ui.selectedPoint;
    if (i == null || !c.points[i]) return;
    const p = c.points[i];
    const active = document.activeElement;
    const ids = ['cp-x', 'cp-y', 'cp-w'];
    if (!force && active && ids.includes(active.id)) return; // 正在输入时不要覆盖
    if (!p.W.isZero()) {
      $('cp-x').value = p.X.div(p.W).toString();
      $('cp-y').value = p.Y.div(p.W).toString();
    }
    $('cp-w').value = p.W.toString();
  }

  function updateHistoryInfo() {
    $('btn-undo').disabled = !studio.canUndo;
    $('btn-redo').disabled = !studio.canRedo;
    $('history-info').textContent = `undo ${studio.undoStack.length} · redo ${studio.redoStack.length}`;
  }

  /* ---------------- 查询 ---------------- */
  function runQuery() {
    const text = $('query-u').value.trim();
    const r = studio.query(text);
    ui.lastQuery = r && r.ok ? r : null;
    renderQueryResult(r);
    if (!r.ok) setStatus('查询失败：' + r.error, 'error');
    if (ui.view) renderQueryMarker(ui.view);
    return r;
  }

  /** 统一的查询结果渲染；同时写 data-* 精确属性，方便自动化无歧义读取。 */
  function renderQueryResult(r) {
    const pointEl = $('q-point');
    if (!r || !r.ok) {
      pointEl.textContent = r ? '错误：' + r.error : '—';
      pointEl.removeAttribute('data-x');
      pointEl.removeAttribute('data-y');
      $('q-point-decimal').textContent = '—';
      $('q-homogeneous').textContent = '—';
      renderSide('left', null, '左端点外侧不存在（仅右导数）');
      renderSide('right', null, '右端点外侧不存在（仅左导数）');
      return;
    }
    pointEl.textContent = `(${r.point.x.toString()}, ${r.point.y.toString()})`;
    pointEl.setAttribute('data-x', r.point.x.toString());
    pointEl.setAttribute('data-y', r.point.y.toString());
    $('q-point-decimal').textContent =
      `(${r.point.x.toDecimal(8)}, ${r.point.y.toDecimal(8)})`;
    $('q-homogeneous').textContent =
      `X=${r.point.X.toString()}, Y=${r.point.Y.toString()}, W=${r.point.W.toString()}`;
    renderSide('left', r.left, r.atStart ? '左端点外侧不存在（仅右导数）' : '左侧极限不存在');
    renderSide('right', r.right, r.atEnd ? '右端点外侧不存在（仅左导数）' : '右侧极限不存在');
  }

  function renderSide(side, d, absentText) {
    const box = document.querySelector('.qr-' + side);
    const ex = $('q-' + side + '-exact');
    const dec = $('q-' + side + '-dec');
    if (!d) {
      box.classList.add('absent');
      box.setAttribute('data-present', 'false');
      ex.textContent = '不存在';
      ex.removeAttribute('data-dx');
      ex.removeAttribute('data-dy');
      dec.textContent = absentText;
    } else {
      box.classList.remove('absent');
      box.setAttribute('data-present', 'true');
      ex.textContent = `(${d.dx.toString()}, ${d.dy.toString()})`;
      ex.setAttribute('data-dx', d.dx.toString());
      ex.setAttribute('data-dy', d.dy.toString());
      dec.textContent = `≈ (${d.dx.toDecimal(8)}, ${d.dy.toDecimal(8)})`;
    }
  }

  /* ---------------- 导出 ---------------- */
  function refreshExports() {
    $('export-json').value = studio.exportJSON(2);
    const built = studio.exportSVG();
    $('export-svg').value = built.svg;
    $('svg-stats').textContent =
      `段数 ${built.segmentCount} · 自检最大偏差 ${built.maxDeviation.toFixed(4)} · 契约 ≤ ${built.limit}`;
    const host = $('svg-export-host');
    host.innerHTML = built.svg.replace(/^<\?xml[^>]*\?>\s*/, '');
  }

  /* ---------------- 总刷新 ---------------- */
  function refresh() {
    if (!studio.curve) return;
    updateHistoryInfo();
    renderMeta();
    renderKnotList();
    renderCPTable();
    updatePointEditorInputs(false);
    renderStage();
    refreshExports();
    // 参数探针随编辑实时复核
    if ($('query-u').value.trim()) {
      const r = studio.query($('query-u').value.trim());
      ui.lastQuery = r.ok ? r : null;
      renderQueryResult(r);
    }
  }

  studio.onChange((e) => {
    if (e.type === 'live' || e.type === 'edit' || e.type === 'undo' || e.type === 'redo') bootDirty = true;
    if (e.type === 'live') {
      updateHistoryInfo();
      renderStage();
    } else if (e.type !== 'failed') {
      refresh();
    } else {
      updateHistoryInfo();
    }
  });

  /* ---------------- 事件：历史 / 导入 / 导出 ---------------- */
  $('btn-undo').addEventListener('click', () => handleOp(studio.undo(), '已撤销'));
  $('btn-redo').addEventListener('click', () => handleOp(studio.redo(), '已重做'));

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return; // 保留输入框原生撤销
    e.preventDefault();
    if (key === 'y' || (key === 'z' && e.shiftKey)) handleOp(studio.redo(), '已重做');
    else handleOp(studio.undo(), '已撤销');
  });

  function loadObjectOrText(input, okMsg) {
    bootDirty = true;
    const r = studio.load(input);
    if (r.ok) {
      ui.selectedPoint = 0; ui.selectedKnotR = null; ui.view = null;
      computeFit();
      refresh();
      setStatus(okMsg || '导入成功。', 'ok');
      $('import-json').value = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    } else {
      setStatus('导入失败：' + (r.error || '格式不合法'), 'error');
    }
    return r;
  }

  $('btn-import-json').addEventListener('click', () => {
    loadObjectOrText($('import-json').value);
  });

  $('btn-load-sample').addEventListener('click', async () => {
    const candidates = [
      'samples/rational-knot.json',
      './samples/rational-knot.json',
      '../samples/rational-knot.json',
      '/samples/rational-knot.json',
    ];
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (resp.ok) {
          const text = await resp.text();
          const r = loadObjectOrText(text, '已从 ' + url + ' 载入样例。');
          if (r.ok) return;
        }
      } catch (_) { /* file:// 下 fetch 会失败，走内置兜底 */ }
    }
    loadObjectOrText(EMBEDDED_SAMPLE, '已载入内置样例（fetch 不可用，可能是 file:// 打开）。');
  });

  $('btn-open-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    loadObjectOrText(text, '已打开文件 ' + file.name);
    e.target.value = '';
  });

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  $('btn-download-json').addEventListener('click', () => {
    download('rational-curve.json', studio.exportJSON(2), 'application/json');
    setStatus('已导出约分曲线 JSON。', 'ok');
  });
  $('btn-download-svg').addEventListener('click', () => {
    download('rational-curve.svg', studio.exportSVG().svg, 'image/svg+xml');
    setStatus('已导出带 data-u0/data-u1 的 SVG 折线。', 'ok');
  });

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMsg, 'ok');
    } catch (_) {
      setStatus('剪贴板不可用，请直接复制文本框内容。', 'error');
    }
  }
  $('btn-copy-json').addEventListener('click', () => copyText($('export-json').value, 'JSON 已复制。'));
  $('btn-copy-svg').addEventListener('click', () => copyText($('export-svg').value, 'SVG 已复制。'));

  /* ---------------- 事件：节点 ---------------- */
  $('btn-insert-knot').addEventListener('click', () => {
    const v = $('insert-u').value.trim();
    const r = studio.insertKnot(v);
    handleOp(r, `已插入节点 ${v}（齐次曲线精确不变）。`);
    if (r.ok) {
      // 选中新插入的出现位置（最后一个等于 v 的内部下标）
      try {
        const fu = Frac.parse(v);
        const c = studio.curve;
        let target = null;
        for (let i = RKS.interiorOccurrenceRange(c).first; i <= RKS.interiorOccurrenceRange(c).last; i++) {
          if (c.knots[i].eq(fu)) target = i;
        }
        ui.selectedKnotR = target;
        refresh();
      } catch (_) { /* 状态已由 handleOp 处理 */ }
    }
  });

  $('btn-remove-knot').addEventListener('click', () => {
    const r = ui.selectedKnotR;
    if (r == null) { setStatus('请先在节点列表/画布中选择一个内部节点出现位置。', 'error'); return; }
    const rr = studio.removeKnotAt(r);
    handleOp(rr, `节点 #${r} 删除成功：重插校验完全相等且权重为正。`);
    if (rr.ok) { ui.selectedKnotR = null; refresh(); }
  });

  $('knot-list').addEventListener('click', (e) => {
    const rmBtn = e.target.closest('[data-remove-r]');
    if (rmBtn) {
      e.stopPropagation();
      const r = Number(rmBtn.getAttribute('data-remove-r'));
      ui.selectedKnotR = r;
      const rr = studio.removeKnotAt(r);
      handleOp(rr, `节点 #${r} 删除成功。`);
      if (rr.ok) { ui.selectedKnotR = null; refresh(); }
      return;
    }
    const chip = e.target.closest('[data-select-r]');
    if (chip) {
      ui.selectedKnotR = Number(chip.getAttribute('data-select-r'));
      renderKnotList();
      renderStage();
    }
  });

  /* ---------------- 事件：控制点表 / 表单 ---------------- */
  $('cp-tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    ui.selectedPoint = Number(tr.getAttribute('data-i'));
    renderCPTable();
    updatePointEditorInputs(true);
    renderStage();
  });

  $('btn-move-cp').addEventListener('click', () => {
    const i = ui.selectedPoint;
    const x = $('cp-x').value.trim(), y = $('cp-y').value.trim();
    const r = studio.movePoint(i, x, y);
    handleOp(r, `控制点 #${i} 已按投影坐标移动，W 保持 ${studio.curve.points[i].W.toString()}。`);
    if (r.ok) refresh();
  });

  $('btn-set-weight').addEventListener('click', () => {
    const i = ui.selectedPoint;
    const w = $('cp-w').value.trim();
    const r = studio.setWeight(i, w);
    handleOp(r, `控制点 #${i} 权重已改为 ${w}，投影位置保持不变。`);
    if (r.ok) refresh();
  });

  $('btn-fit-view').addEventListener('click', () => { computeFit(); renderStage(); setStatus('视图已复位。'); });
  $('btn-query').addEventListener('click', runQuery);
  $('query-u').addEventListener('keydown', (e) => { if (e.key === 'Enter') runQuery(); });
  $('insert-u').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-insert-knot').click(); });
  $('cp-x').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-move-cp').click(); });
  $('cp-y').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-move-cp').click(); });
  $('cp-w').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-set-weight').click(); });

  /* ---------------- 画布点选 + 拖拽 ---------------- */
  function eventToMath(e) {
    const m = stage.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: ui.view.invX(p.x), y: ui.view.invY(p.y) };
  }

  let drag = null;
  $('g-points').addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.cp-handle');
    if (!h) return;
    const i = Number(h.getAttribute('data-i'));
    ui.selectedPoint = i;
    renderCPTable();
    updatePointEditorInputs(true);
    renderStage();
    drag = { i, moved: false };
    studio.beginGesture();
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pt = eventToMath(e);
    if (!pt) return;
    drag.moved = true;
    // 量化到 6 位小数，保证送入精确引擎的是简洁确定的分数
    const xs = Frac.parse(pt.x.toFixed(6)).toString();
    const ys = Frac.parse(pt.y.toFixed(6)).toString();
    studio.liveMovePoint(drag.i, xs, ys);
    $('cp-x').value = xs;
    $('cp-y').value = ys;
  });

  function endDrag(e) {
    if (!drag) return;
    const d = drag; drag = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.moved) {
      const r = studio.endGesture('drag-point');
      if (r.changed) setStatus(`控制点 #${d.i} 拖拽完成（一次撤销步）。`, 'ok');
      refresh();
    } else {
      studio.cancelGesture();
    }
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', () => { if (drag) { studio.cancelGesture(); drag = null; refresh(); } });

  // 点击画布上的节点标记也可选中
  $('g-knots').addEventListener('click', (e) => {
    const mk = e.target.closest('.knot-marker');
    if (!mk) return;
    ui.selectedKnotR = Number(mk.getAttribute('data-r'));
    renderKnotList();
    renderStage();
  });

  /* ---------------- 稳定编程接口（供自动化/验证直接驱动） ---------------- */
  window.rksAPI = {
    studio,
    /** 载入对象或 JSON 文本，返回 {ok,error?}，会重置历史。 */
    load: (x) => loadObjectOrText(x, '已通过 API 导入。'),
    insertKnot: (u) => { const r = studio.insertKnot(u); if (r.ok) refresh(); return r; },
    addKnot: (u) => window.rksAPI.insertKnot(u),
    removeKnotAt: (r) => { const res = studio.removeKnotAt(r); if (res.ok) { ui.selectedKnotR = null; refresh(); } return res; },
    removeKnotValue: (u, occ) => { const res = studio.removeKnotValue(u, occ); if (res.ok) { ui.selectedKnotR = null; refresh(); } return res; },
    // 数字参数=按下标删；字符串参数=按节点值删
    removeKnot: (x, occ) => (typeof x === 'number'
      ? window.rksAPI.removeKnotAt(x)
      : window.rksAPI.removeKnotValue(x, occ)),
    movePoint: (i, x, y) => { const r = studio.movePoint(i, x, y); if (r.ok) refresh(); return r; },
    setWeight: (i, w) => { const r = studio.setWeight(i, w); if (r.ok) refresh(); return r; },
    setHomogeneousPoint: (i, X, Y, W) => { const r = studio.setHomogeneousPoint(i, X, Y, W); if (r.ok) refresh(); return r; },
    undo: () => { const r = studio.undo(); refresh(); return r; },
    redo: () => { const r = studio.redo(); refresh(); return r; },
    canUndo: () => studio.canUndo,
    canRedo: () => studio.canRedo,
    history: () => ({ undo: studio.undoStack.length, redo: studio.redoStack.length }),
    query: (u) => studio.queryPlain(u),
    json: () => studio.exportObject(true),
    jsonText: (indent) => studio.exportJSON(indent == null ? 2 : indent),
    svg: () => studio.exportSVG().svg,
    segments: () => studio.segmentsData(),
    curve: () => studio.curve,
    /** 选中某个控制点（会同步右侧表单）。 */
    selectPoint: (i) => { ui.selectedPoint = i; renderCPTable(); updatePointEditorInputs(true); renderStage(); },
  };

  /* ---------------- 启动 ---------------- */
  $('import-json').value = JSON.stringify(EMBEDDED_SAMPLE);
  computeFit();
  refresh();
  // 尝试用 samples/ 下的真实文件覆盖内置样例（内容一致也无妨）；
  // 若期间用户/API 已载入或编辑，则绝不覆盖。
  (async function autoFetchSample() {
    try {
      const resp = await fetch('samples/rational-knot.json', { cache: 'no-store' });
      if (resp.ok) {
        const text = await resp.text();
        const obj = JSON.parse(text);
        if (!bootDirty && studio.undoStack.length === 0) {
          const r = studio.load(obj);
          if (r.ok) { ui.view = null; computeFit(); refresh(); $('import-json').value = text; }
        }
      }
    } catch (_) { /* file:// 忽略，内置样例已就绪 */ }
  })();
})();
