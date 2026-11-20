/* =============================================================================
   Boxed Hermite 提取器 — application shell
   ========================================================================== */
(function () {
  'use strict';

  const BHE = window.BHE;
  const View = window.BHEView;

  const AXIS_LABEL = ['x', 'y', 'z'];
  const AXIS_INDEX = { x: 0, y: 1, z: 2 };
  const STATE_LABEL = { lower: '下界', upper: '上界', free: '自由' };

  const state = {
    caseId: null,
    importedRaw: null,
    raw: null,
    data: null,
    model: null,
    errors: [],
    lambda: BHE.DEFAULT_LAMBDA,
    cell: null,
    edgeKey: null,
    slice: { axis: 2, layer: 0 },
    layers: { wire: true, iso: true, cells: true, hits: true, normals: true, unconstrained: true, guides: true, topology: true },
    samplesIndex: [],
    caseCache: new Map(),
  };

  let scene = null;
  let sliceView = null;
  let detailView = null;
  let extractQueued = false;
  let edgeTimer = null;

  // ----------------------------------------------------------------- utilities

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] === true) n.setAttribute(k, '');
        else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (c == null) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function fmt(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    const d = digits == null ? 4 : digits;
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e5)) return v.toExponential(3);
    return v.toFixed(d);
  }

  function fmtCompact(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    const d = digits == null ? 3 : digits;
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e4)) return v.toExponential(2);
    return v.toFixed(d);
  }

  function fmtVec(v, digits) {
    return '(' + v.map((x) => fmtCompact(x, digits)).join(', ') + ')';
  }

  /** A short, round-trippable-ish decimal for editable number inputs. */
  function shortNum(v, sig) {
    if (!Number.isFinite(v)) return String(v);
    const n = sig == null ? 5 : sig;
    return String(Number(Number(v).toPrecision(n)));
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2400);
  }

  // -------------------------------------------------------------- case loading

  async function getCase(id) {
    if (state.caseCache.has(id)) return state.caseCache.get(id);
    const inline = (window.BHE_INLINE_SAMPLES || []).find((s) => s.id === id);
    if (inline) {
      state.caseCache.set(id, inline.raw);
      return inline.raw;
    }
    const meta = state.samplesIndex.find((c) => c.id === id);
    const url = (meta && meta.file) || ('data/samples/' + id + '.json');
    let raw = null;
    try {
      const res = await fetch(url);
      if (res.ok) raw = await res.json();
    } catch (e) {
      // file:// or a missing companion directory — fall through to the
      // embedded copy, if this build carries one.
      raw = null;
    }
    if (!raw) {
      const dataUri = (window.BHE_CASE_DATA || {})[id];
      if (dataUri) {
        const comma = dataUri.indexOf(',');
        raw = JSON.parse(decodeURIComponent(dataUri.slice(comma + 1)));
      }
    }
    if (!raw) throw new Error('无法读取样例 ' + id + '（该构建未内嵌此样例，请把 data/ 目录一并部署）');
    state.caseCache.set(id, raw);
    return raw;
  }

  async function selectCase(id) {
    let raw;
    try {
      raw = await getCase(id);
    } catch (e) {
      toast(e.message);
      return;
    }
    state.caseId = id;
    state.importedRaw = BHE.cloneRaw(raw);
    state.raw = BHE.cloneRaw(raw);
    state.cell = null;
    state.edgeKey = null;
    state.slice = { axis: 2, layer: 0 };
    reextract({ resetSelection: true });
    $('#caseSelect').value = id;
    if (scene) scene.fitToContent();
  }

  // ------------------------------------------------------------------ extract

  function reextract(opts) {
    const o = opts || {};
    const struct = BHE.validateInput(state.raw);
    state.errors = struct.errors;
    if (!struct.ok) {
      state.data = null;
      state.model = null;
      state.cell = null;
      state.edgeKey = null;
      refreshAll({ rebuildEditor: true });
      return;
    }
    state.data = struct.data;
    state.model = BHE.extract(state.data, state.lambda);

    // Keep a sensible selection.
    if (!state.cell || !state.model.cellIndex.has(state.cell.join(','))) {
      if (o.resetSelection || !state.cell) {
        const first = state.model.vertices[0];
        state.cell = first ? first.cell.slice() : null;
      }
    }
    const v = selectedVertex();
    if (o.resetSelection || !state.edgeKey) {
      state.edgeKey = v && v.residuals.length ? keyOf(v.residuals[0]) : null;
    }
    if (state.edgeKey && !state.data.edgeMap.has(state.edgeKey)) {
      state.edgeKey = v && v.residuals.length ? keyOf(v.residuals[0]) : null;
    }
    if (state.data) {
      const a = state.slice.axis;
      const maxLayer = state.data.dims[a] - 2;
      if ((o.resetSelection || o.followSelection) && state.cell) {
        state.slice.layer = Math.max(0, Math.min(maxLayer, state.cell[a]));
      } else {
        state.slice.layer = Math.max(0, Math.min(maxLayer, state.slice.layer));
      }
    }
    refreshAll({ rebuildEditor: o.rebuildEditor !== false });
  }

  function queueExtract() {
    if (extractQueued) return;
    extractQueued = true;
    requestAnimationFrame(() => {
      extractQueued = false;
      reextract({ rebuildEditor: false });
      syncEdgeEditorValues();
    });
  }

  function keyOf(r) {
    return r.axis + ':' + r.node.join(',');
  }

  // ------------------------------------------------------------- render parts

  function renderHeader() {
    const model = state.model;
    const pill = $('#statusPill');
    const row = $('#statusRow');
    pill.className = 'status-pill';
    row.classList.remove('bad');
    if (!state.data) {
      pill.classList.add('err');
      row.classList.add('bad');
      pill.innerHTML = '<span class="dot"></span>输入校验失败';
    } else if (!model || !model.vertices.length) {
      pill.classList.add('ok');
      pill.innerHTML = '<span class="dot"></span>有效 · 空结果（全部同号）';
    } else {
      pill.classList.add('ok');
      pill.innerHTML = '<span class="dot"></span>有效 · ' + model.counts.vertices + ' 个混合单元顶点';
    }

    const counts = $('#counts');
    counts.innerHTML = '';
    if (model) {
      const c = model.counts;
      const mk = (label, value, warn) => el('span', { class: 'chip' + (warn ? ' warn' : '') }, [
        label, el('b', { text: String(value) }),
      ]);
      counts.appendChild(mk('顶点', c.vertices));
      counts.appendChild(mk('三角', c.triangles));
      counts.appendChild(mk('边界穿越', c.boundary_crossings, c.boundary_crossings > 0));
      counts.appendChild(mk('边界边', c.boundary_edges, c.boundary_edges > 0));
      counts.appendChild(mk('非流形边', c.nonmanifold_edges, c.nonmanifold_edges > 0));
    }

    const hud = $('#viewportHud');
    if (model && state.data) {
      hud.innerHTML =
        '<span>混合单元 <b>' + model.cells.length + '</b></span>' +
        '<span>λ <b>' + state.lambda.toExponential(1) + '</b></span>' +
        '<span>网格 <b>' + state.data.dims.join('×') + '</b></span>' +
        '<span>间距 <b>' + state.data.spacing.map((s) => fmtCompact(s, 3)).join(' · ') + '</b></span>';
    } else {
      hud.innerHTML = '';
    }

    const ov = $('#viewportOverlay');
    if (!state.data) {
      ov.hidden = false;
      ov.innerHTML = '<div><h3>无法提取</h3><p>输入未通过校验。右侧「诊断」列出每个问题的字段位置。</p></div>';
    } else if (!model || !model.vertices.length) {
      ov.hidden = false;
      ov.innerHTML = '<div><h3>空结果</h3><p>所有节点同号，没有异号边，因此不生成顶点与三角面。OBJ 为空，诊断 JSON 仍可导出。</p></div>';
    } else {
      ov.hidden = true;
      ov.innerHTML = '';
    }
  }

  function lambdaFromSlider(v) {
    return Math.pow(10, -6 + 6 * (v / 1000));
  }

  function sliderFromLambda(l) {
    return Math.round(1000 * (Math.log10(l) + 6) / 6);
  }

  function renderLambda() {
    const slider = $('#lambdaSlider');
    const input = $('#lambdaInput');
    slider.value = String(sliderFromLambda(state.lambda));
    if (document.activeElement !== input) input.value = state.lambda.toPrecision(3);
    $('#lambdaValue').textContent = state.lambda.toExponential(2);
    slider.disabled = !state.data;
  }

  function renderSliceControls() {
    if (!state.data) {
      $('#layerSlider').max = '0';
      $('#layerSlider').value = '0';
      $('#layerReadout').textContent = '—';
      return;
    }
    const dims = state.data.dims;
    const a = state.slice.axis;
    $$('#sliceAxis button').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.axis) === a));
    });
    const maxLayer = dims[a] - 2;
    state.slice.layer = Math.max(0, Math.min(maxLayer, state.slice.layer));
    const slider = $('#layerSlider');
    slider.max = String(maxLayer);
    slider.value = String(state.slice.layer);
    $('#layerReadout').innerHTML = AXIS_LABEL[a] + ' 层 <b>' + state.slice.layer + '</b> / ' + maxLayer +
      '<span style="opacity:.65">　' + ['x', 'y', 'z'][(a + 1) % 3] + '×' + ['x', 'y', 'z'][(a + 2) % 3] +
      ' ' + dims[(a + 1) % 3] + '×' + dims[(a + 2) % 3] + '</span>';
  }

  function selectedVertex() {
    if (!state.model || !state.cell) return null;
    const id = state.model.cellIndex.get(state.cell.join(','));
    return id === undefined ? null : state.model.vertices[id];
  }

  function renderCellQuery() {
    if (!state.data) {
      ['x', 'y', 'z'].forEach((ax) => { $('#cell-' + ax).value = ''; $('#cell-' + ax).max = ''; });
      $('#cellStatus').textContent = '无有效网格';
      return;
    }
    const dims = state.data.dims;
    ['x', 'y', 'z'].forEach((ax, i) => {
      const inp = $('#cell-' + ax);
      inp.max = String(dims[i] - 2);
      inp.min = '0';
      if (document.activeElement !== inp) inp.value = state.cell ? String(state.cell[i]) : '';
    });
    const v = selectedVertex();
    const st = $('#cellStatus');
    if (!state.cell) st.textContent = '未选择';
    else if (v) st.textContent = '混合单元 · 顶点 #' + v.index;
    else st.textContent = '同号单元';
  }

  function activeClass(s) {
    return s === 'lower' ? 'lower' : s === 'upper' ? 'upper' : 'free';
  }

  function renderCellDetail() {
    const host = $('#cellDetail');
    host.innerHTML = '';
    if (!state.data) {
      host.appendChild(el('div', { class: 'empty-note', text: '导入有效 JSON 后显示单元解。' }));
      return;
    }
    if (!state.cell) {
      host.appendChild(el('div', { class: 'empty-note', text: '在三维视图点选顶点、在切层视图点选单元，或输入单元坐标。' }));
      return;
    }
    const v = selectedVertex();
    if (!v) {
      host.appendChild(el('div', { class: 'empty-note' }, [
        '单元 [' + state.cell.join(', ') + '] 的 8 个节点同号，没有异号边，因而不生成顶点。',
      ]));
      host.appendChild(el('div', { class: 'hint', text: '用「后一混合单元」可跳到下一个有顶点的单元。' }));
      return;
    }

    const kv = el('dl', { class: 'kv' });
    const row = (k, val, cls) => {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', { class: cls || '' }, [val]));
    };
    row('最终解 x*', el('strong', { text: fmtVec(v.position, 5) }));
    row('无约束解', el('span', { text: fmtVec(v.unconstrained, 5) }));
    row('交点均值 c', el('span', { text: fmtVec(v.centroid, 5) }));
    row('目标 F(x*)', el('strong', { text: fmt(v.objective, 7) }));
    row('数据项 Σr²', el('span', { text: fmt(v.dataError, 7) }));
    row('正则项 λ‖x−c‖²', el('span', { text: fmt(v.regularization, 7) }));
    row('朴素夹取目标', el('span', {
      text: fmt(v.clampObjective, 7) + (v.clampObjective > v.objective + 1e-12 ? ' · 非最优' : ' · 相同'),
    }));
    host.appendChild(kv);

    host.appendChild(el('div', { class: 'section-title' }, ['活动约束', el('span', { text: 'lower / free / upper' })]));
    const axes = el('div', { class: 'axes-row' });
    for (let a = 0; a < 3; a++) {
      const s = v.activeAxes[a];
      const val = s === 'lower' ? v.box.lower[a] : s === 'upper' ? v.box.upper[a] : v.position[a];
      axes.appendChild(el('div', { class: 'axis-card ' + activeClass(s) }, [
        el('span', { class: 'ax', text: AXIS_LABEL[a] + ' · ' + STATE_LABEL[s] }),
        el('span', { class: 'st mono', text: fmtCompact(val, 4) }),
      ]));
    }
    host.appendChild(axes);

    host.appendChild(el('div', { class: 'section-title' }, ['目标构成', el('span', { text: '数据项 + 正则项' })]));
    const total = Math.max(v.objective, 1e-300);
    const dataPct = Math.max(0, Math.min(100, 100 * v.dataError / total));
    const comp = el('div', { class: 'composition' });
    comp.appendChild(el('span', { class: 'lbl', text: '数据项' }));
    comp.appendChild(el('div', { class: 'stackbar', title: '数据项占比 ' + dataPct.toFixed(1) + '%' }, [
      el('i', { class: 'data', style: 'display:block;width:' + dataPct + '%' }),
      el('i', { class: 'reg', style: 'display:block;width:' + (100 - dataPct) + '%' }),
    ]));
    comp.appendChild(el('span', { class: 'val', text: dataPct.toFixed(1) + '%' }));
    host.appendChild(comp);

    host.appendChild(el('div', { class: 'section-title' }, [
      '平面残差', el('span', { text: v.residuals.length + ' 条异号边 · r = n̂·(x*−h)' }),
    ]));
    const maxAbs = v.residuals.reduce((m, r) => Math.max(m, Math.abs(r.residual)), 0) || 1;
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: '边' }), el('th', { text: 't' }), el('th', { text: '残差' }), el('th', { text: '占比' }),
    ])]));
    const tb = el('tbody');
    v.residuals.forEach((r) => {
      const key = keyOf(r);
      const tr = el('tr', {
        class: 'selectable' + (state.edgeKey === key ? ' selected' : ''),
      }, [
        el('td', { text: r.axis + ' [' + r.node.join(',') + ']' }),
        el('td', { text: fmtCompact(r.t, 4) }),
        el('td', { class: Math.abs(r.residual) > 1e-3 ? 'danger' : '', text: fmt(r.residual, 5) }),
        el('td', {}, [el('div', { class: 'bar' }, [
          el('i', { style: 'width:' + (100 * Math.abs(r.residual) / maxAbs).toFixed(1) + '%' }),
        ])]),
      ]);
      tr.addEventListener('click', () => selectEdge(key));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
    host.appendChild(el('div', { class: 'hint', text: '残差衡量顶点到各输入平面的距离；总目标为数据项与正则项之和。' }));
  }

  function renderDiagnosticsPanel() {
    const host = $('#diagList');
    host.innerHTML = '';
    const panel = $('#diagPanel');
    if (!state.errors.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('#diagCount').textContent = state.errors.length + ' 项';
    for (const e of state.errors) {
      const item = el('div', { class: 'error-item' }, [
        el('div', { class: 'code', text: e.code }),
        el('div', { class: 'field', text: e.field }),
        el('div', { class: 'msg', text: e.message }),
      ]);
      if (e.edge) {
        item.appendChild(el('div', { class: 'field', text: '定位：' + e.edge.axis + ' [' + e.edge.node.join(',') + ']' }));
      }
      host.appendChild(item);
    }
  }

  // ---------------------------------------------------------------- edge editor

  function findEdge(key) {
    return state.data ? state.data.edgeMap.get(key) : null;
  }

  function isEdited(key) {
    if (!state.importedRaw || !state.data) return false;
    const orig = state.importedRaw.edges.find((e) => keyOf2(e) === key);
    const rec = state.data.edgeMap.get(key);
    if (!orig || !rec) return false;
    return orig.t !== rec.t ||
      orig.normal[0] !== rec.normal[0] || orig.normal[1] !== rec.normal[1] || orig.normal[2] !== rec.normal[2];
  }

  function keyOf2(e) {
    return e.axis + ':' + e.node.join(',');
  }

  function editedKeys() {
    if (!state.data) return [];
    const out = [];
    for (const key of state.data.edgeMap.keys()) if (isEdited(key)) out.push(key);
    return out;
  }

  function selectEdge(key) {
    state.edgeKey = key;
    renderEdgeList();
    renderEdgeEditor();
    renderCellDetail();
    drawAll();
  }

  function renderEdgeList() {
    const host = $('#edgeList');
    host.innerHTML = '';
    if (!state.data) {
      host.appendChild(el('div', { class: 'empty-note', text: '无有效网格。' }));
      return;
    }
    const v = selectedVertex();
    if (!v) {
      host.appendChild(el('div', { class: 'empty-note', text: '选择混合单元后列出它的异号边。' }));
      return;
    }
    for (const r of v.residuals) {
      const key = keyOf(r);
      host.appendChild(el('button', {
        class: 'edge-item' + (isEdited(key) ? ' edited' : ''),
        type: 'button',
        'aria-current': state.edgeKey === key ? 'true' : 'false',
        onclick: () => selectEdge(key),
      }, [
        el('span', { class: 'k', text: r.axis + ' [' + r.node.join(',') + ']' }),
        el('span', { class: 'v', text: 't=' + fmtCompact(r.t, 3) + ' · r=' + fmtCompact(r.residual, 3) }),
      ]));
    }
  }

  function renderEdgeEditor() {
    const host = $('#edgeEditor');
    host.innerHTML = '';
    const key = state.edgeKey;
    const rec = key ? findEdge(key) : null;
    $('#restoreEdgeBtn').disabled = !rec || !isEdited(key);
    $('#restoreAllBtn').disabled = editedKeys().length === 0;

    if (!rec) {
      host.appendChild(el('div', {
        class: 'empty-note',
        text: '在残差表或边列表中选择一条异号边，即可编辑 t 与法线。改动会更新所有共享该边的单元。',
      }));
      return;
    }

    const edgeCells = (state.model && state.model.edgeCellMap.get(key)) || [];
    host.appendChild(el('dl', { class: 'kv' }, [
      el('dt', { text: '选中边' }), el('dd', {}, [el('strong', { text: rec.axis + ' [' + rec.node.join(',') + ']' })]),
      el('dt', { text: '影响单元' }), el('dd', { text: String(edgeCells.length) }),
      el('dt', { text: '状态' }), el('dd', { id: 'edgeState', text: isEdited(key) ? '已修改' : '导入值' }),
    ]));

    host.appendChild(el('div', { class: 'field' }, [
      el('label', { text: '交点参数 t（0 < t < 1）', for: 'edgeT' }),
      el('div', { class: 'field-row' }, [
        el('input', { id: 'edgeTSlider', type: 'range', min: '0.0001', max: '0.9999', step: '0.0001', value: String(rec.t), 'aria-label': 't 滑块' }),
        el('input', { id: 'edgeT', type: 'number', min: '0', max: '1', step: '0.001', value: shortNum(rec.t, 8), style: 'width:96px;flex:none', title: String(rec.t) }),
      ]),
      el('div', { class: 'hint', id: 'edgeTError' }),
    ]));

    host.appendChild(el('div', { class: 'field' }, [
      el('label', { text: '法线 n（自动归一化）', for: 'edgeNx' }),
      el('div', { class: 'field-grid3' }, [
        el('input', { id: 'edgeNx', type: 'number', step: '0.05', value: shortNum(rec.normal[0]), 'aria-label': '法线 x 分量', title: String(rec.normal[0]) }),
        el('input', { id: 'edgeNy', type: 'number', step: '0.05', value: shortNum(rec.normal[1]), 'aria-label': '法线 y 分量', title: String(rec.normal[1]) }),
        el('input', { id: 'edgeNz', type: 'number', step: '0.05', value: shortNum(rec.normal[2]), 'aria-label': '法线 z 分量', title: String(rec.normal[2]) }),
      ]),
      el('div', { class: 'hint', id: 'edgeNError' }),
    ]));

    host.appendChild(el('div', { class: 'hint', id: 'edgeSummary' }));

    $('#edgeTSlider').addEventListener('input', (e) => {
      $('#edgeT').value = Number(e.target.value).toFixed(4);
      clearTimeout(edgeTimer);
      edgeTimer = setTimeout(applyEdgeEdit, 90);
    });
    ['#edgeT', '#edgeNx', '#edgeNy', '#edgeNz'].forEach((sel) => {
      $(sel).addEventListener('input', () => {
        clearTimeout(edgeTimer);
        edgeTimer = setTimeout(applyEdgeEdit, 220);
      });
      $(sel).addEventListener('blur', applyEdgeEdit);
      $(sel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyEdgeEdit(); }
      });
    });
    syncEdgeEditorValues();
  }

  function syncEdgeEditorValues() {
    const key = state.edgeKey;
    const rec = key ? findEdge(key) : null;
    if (!rec) return;
    const summary = $('#edgeSummary');
    if (summary) {
      const ai = AXIS_INDEX[rec.axis];
      const pos = [0, 1, 2].map((i) => state.data.origin[i] + state.data.spacing[i] * (rec.node[i] + (i === ai ? rec.t : 0)));
      summary.textContent = '单位法线 ' + fmtVec(rec.normalized, 4) +
        '　世界位置 ' + fmtVec(pos, 4) +
        '　归属单元 ' + ((state.model && state.model.edgeCellMap.get(key)) || []).length;
    }
    const stateEl = $('#edgeState');
    if (stateEl) stateEl.textContent = isEdited(key) ? '已修改' : '导入值';
    const badge = $('#restoreEdgeBtn');
    if (badge) badge.disabled = !isEdited(key);
    $('#restoreAllBtn').disabled = editedKeys().length === 0;
  }

  function applyEdgeEdit() {
    clearTimeout(edgeTimer);
    const key = state.edgeKey;
    if (!key || !state.data) return;
    const tEl = $('#edgeT');
    const nxEl = $('#edgeNx');
    const nyEl = $('#edgeNy');
    const nzEl = $('#edgeNz');
    if (!tEl || !nxEl) return;

    const tRaw = parseFloat(tEl.value);
    const nx = parseFloat(nxEl.value);
    const ny = parseFloat(nyEl.value);
    const nz = parseFloat(nzEl.value);
    const errT = $('#edgeTError');
    const errN = $('#edgeNError');
    errT.textContent = '';
    errN.textContent = '';
    tEl.classList.remove('invalid');
    [nxEl, nyEl, nzEl].forEach((n) => n.classList.remove('invalid'));

    let ok = true;
    if (!Number.isFinite(tRaw) || !(tRaw > 0 && tRaw < 1)) {
      errT.textContent = 't 必须严格大于 0 且小于 1。';
      tEl.classList.add('invalid');
      ok = false;
    }
    if (![nx, ny, nz].every(Number.isFinite)) {
      errN.textContent = '法线分量必须为有限数值。';
      [nxEl, nyEl, nzEl].forEach((n) => n.classList.add('invalid'));
      ok = false;
    } else if (!(Math.hypot(nx, ny, nz) > 1e-9)) {
      errN.textContent = '法线不能是零向量（无法归一化）。';
      [nxEl, nyEl, nzEl].forEach((n) => n.classList.add('invalid'));
      ok = false;
    }
    if (!ok) return;

    const target = state.raw.edges.find((e) => keyOf2(e) === key);
    if (!target) return;
    target.t = tRaw;
    target.normal = [nx, ny, nz];

    reextract({ rebuildEditor: false });
    const slider = $('#edgeTSlider');
    if (slider) slider.value = String(tRaw);
    syncEdgeEditorValues();
  }

  // ------------------------------------------------------------------- export

  function currentDiagnostics() {
    const grid = state.data
      ? { dims: state.data.dims, origin: state.data.origin, spacing: state.data.spacing }
      : rawGrid(state.raw);
    const diag = BHE.toDiagnostics(state.model, state.data, state.errors, { lambda: state.lambda, grid: grid });
    diag.edited_edges = editedKeys().map((key) => {
      const rec = findEdge(key);
      const orig = state.importedRaw.edges.find((e) => keyOf2(e) === key);
      return {
        key: key,
        t: rec ? rec.t : null,
        normal: rec ? rec.normal.slice() : null,
        imported_t: orig ? orig.t : null,
        imported_normal: orig ? orig.normal.slice() : null,
      };
    });
    return diag;
  }

  function rawGrid(raw) {
    if (!raw) return null;
    return { dims: raw.dims, origin: raw.origin, spacing: raw.spacing };
  }

  // --------------------------------------------------------------- draw / sync

  function drawAll() {
    if (scene) {
      scene.setScene(state.data, state.model);
      scene.selection = { virtualIndex: selectedVertex() ? selectedVertex().index : null };
      scene.slice = state.slice;
      scene.layers = state.layers;
      scene.draw();
    }
    if (sliceView) {
      sliceView.setScene(state.data, state.model, state.slice);
      const v = selectedVertex();
      sliceView.selection = {
        cell: state.cell ? state.cell.slice() : null,
        position: v ? v.position.slice() : null,
        detail: v ? {
          cell: v.cell, centroid: v.centroid, unconstrained: v.unconstrained,
          position: v.position, residuals: v.residuals,
        } : null,
      };
      sliceView.editedKeys = editedKeys();
      sliceView.focus = $('#sliceFocus') ? $('#sliceFocus').checked : true;
      sliceView.draw();
    }
    updateSliceSummary();
    updateDetailView();
  }

  function renderDetailSide(host, v) {
    host.innerHTML = '';
    if (!v) {
      host.appendChild(el('div', { class: 'empty-note', text: '选中混合单元后显示单元盒、交点和两个解。' }));
      return;
    }
    const kv = el('dl', { class: 'kv' });
    const row = (k, val) => {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', {}, [val]));
    };
    const nmax = v.residuals.reduce((m, r) => Math.max(m, Math.abs(r.residual)), 0);
    row('最大残差', el('strong', { text: fmt(nmax, 4) }));
    row('目标 F', el('span', { text: fmt(v.objective, 6) }));
    row('迭代', el('span', { text: '27 活动集枚举' }));
    host.appendChild(kv);
    host.appendChild(el('div', { class: 'legend-inline' }, [
      el('span', {}, [el('i', { class: 'c' }), '最终解 x*']),
      el('span', {}, [el('i', { class: 'u' }), '无约束']),
      el('span', {}, [el('i', { class: 'h' }), '交点']),
    ]));
    host.appendChild(el('div', { class: 'hint', style: 'font-size:10px' }, ['拖拽旋转单格视角 · 滚轮缩放']));
  }

  function updateDetailView() {
    const host = $('#detailSide');
    if (!host) return;
    const v = selectedVertex();
    const label = $('#detailCell');
    if (label) label.textContent = state.cell ? '单元 [' + state.cell.join(', ') + ']' : '—';
    if (detailView) detailView.setVertex(v);
    renderDetailSide(host, v);
    const sliceMeta = $('#sliceMeta');
    if (sliceMeta) sliceMeta.textContent = state.cell ? '单元 [' + state.cell.join(', ') + ']' : '';
  }

  function updateSliceSummary() {
    const out = $('#sliceSummary');
    if (!out) return;
    if (!state.model) {
      out.textContent = '';
      return;
    }
    const a = state.slice.axis;
    const layer = state.slice.layer;
    let cells = 0;
    let crossings = 0;
    const seen = new Set();
    for (const v of state.model.vertices) {
      if (v.cell[a] !== layer) continue;
      cells++;
      for (const r of v.residuals) {
        const ax = AXIS_INDEX[r.axis];
        // Crossings of this slab live on its two bounding node planes.
        if (ax === a || (r.node[a] !== layer && r.node[a] !== layer + 1)) continue;
        const key = r.axis + ':' + r.node.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        crossings++;
      }
    }
    out.textContent = '本层 ' + cells + ' 个混合单元 · ' + crossings + ' 个层内交点' +
      (cells === 0 && crossings === 0 ? '　（此层无等值面片）' : '');
  }

  function refreshAll(opts) {
    const o = opts || {};
    document.body.classList.toggle('no-data', !state.data);
    const emptySurface = !!state.data && (!state.model || !state.model.vertices.length);
    document.body.classList.toggle('no-surface', emptySurface);
    renderHeader();
    renderLambda();
    renderSliceControls();
    renderCellQuery();
    renderCellDetail();
    renderEdgeList();
    if (o.rebuildEditor !== false) renderEdgeEditor();
    else syncEdgeEditorValues();
    renderDiagnosticsPanel();
    drawAll();
  }

  // ------------------------------------------------------------------- wiring

  function pickCell(cell) {
    state.cell = cell ? cell.slice() : null;
    const v = selectedVertex();
    state.edgeKey = v && v.residuals.length ? keyOf(v.residuals[0]) : null;
    if (state.cell && state.data) {
      // Keep the slice on the selected cell so the two views stay linked.
      const a = state.slice.axis;
      state.slice.layer = Math.max(0, Math.min(state.data.dims[a] - 2, state.cell[a]));
    }
    renderSliceControls();
    renderCellQuery();
    renderCellDetail();
    renderEdgeList();
    renderEdgeEditor();
    drawAll();
  }

  function clampCellInput(axisIdx, value) {
    if (!state.data) return null;
    const dims = state.data.dims;
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(dims[axisIdx] - 2, Math.round(value)));
  }

  function stepLayer(d) {
    if (!state.data) return;
    const maxLayer = state.data.dims[state.slice.axis] - 2;
    state.slice.layer = Math.max(0, Math.min(maxLayer, state.slice.layer + d));
    renderSliceControls();
    drawAll();
  }

  function stepCell(dir) {
    if (!state.model || !state.model.vertices.length) return;
    const verts = state.model.vertices;
    let id = -1;
    const cur = selectedVertex();
    if (cur) id = cur.index;
    let next;
    if (id < 0) next = dir > 0 ? 0 : verts.length - 1;
    else next = (id + dir + verts.length) % verts.length;
    pickCell(verts[next].cell);
    // Move the slice with the selection so the two views stay linked.
    if (state.data) {
      state.slice.axis = 2;
      state.slice.layer = Math.max(0, Math.min(state.data.dims[2] - 2, verts[next].cell[2]));
      renderSliceControls();
      drawAll();
    }
  }

  function initControls() {
    const sel = $('#caseSelect');
    sel.innerHTML = '';
    const ordering = (window.BHE_CASES && window.BHE_CASES.length)
      ? window.BHE_CASES
      : (window.BHE_INLINE_SAMPLES || []).map((s) => ({ id: s.id, name: s.name }));
    for (const c of ordering) {
      sel.appendChild(el('option', { value: c.id, text: c.name || c.id }));
    }
    sel.addEventListener('change', () => selectCase(sel.value));

    $('#lambdaSlider').addEventListener('input', (e) => {
      state.lambda = lambdaFromSlider(Number(e.target.value));
      renderLambda();
      queueExtract();
    });
    $('#lambdaInput').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= BHE.LAMBDA_MIN && v <= BHE.LAMBDA_MAX) {
        state.lambda = v;
        reextract({ rebuildEditor: false });
        renderLambda();
      } else {
        e.target.classList.add('invalid');
        setTimeout(() => e.target.classList.remove('invalid'), 1200);
        renderLambda();
      }
    });
    $('#lambdaInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('#lambdaReset').addEventListener('click', () => {
      state.lambda = BHE.DEFAULT_LAMBDA;
      reextract({ rebuildEditor: false });
      renderLambda();
      toast('λ 已恢复默认 1e-3');
    });

    for (const key of Object.keys(state.layers)) {
      const cb = $('#layer-' + key);
      if (!cb) continue;
      cb.addEventListener('change', (e) => {
        state.layers[key] = e.target.checked;
        drawAll();
      });
    }

    $$('#sliceAxis button').forEach((b) => {
      b.addEventListener('click', () => {
        state.slice.axis = Number(b.dataset.axis);
        if (state.data) {
          const a = state.slice.axis;
          state.slice.layer = Math.max(0, Math.min(state.data.dims[a] - 2, state.slice.layer));
        }
        renderSliceControls();
        drawAll();
      });
    });
    $('#layerSlider').addEventListener('input', (e) => {
      state.slice.layer = Number(e.target.value);
      renderSliceControls();
      drawAll();
    });
    const sliceFocus = $('#sliceFocus');
    if (sliceFocus) sliceFocus.addEventListener('change', () => {
      if (sliceView) { sliceView.focus = sliceFocus.checked; sliceView.draw(); }
    });
    $('#layerPrev').addEventListener('click', () => stepLayer(-1));
    $('#layerNext').addEventListener('click', () => stepLayer(1));

    ['x', 'y', 'z'].forEach((ax, i) => {
      const inp = $('#cell-' + ax);
      inp.addEventListener('change', () => {
        if (!state.data) return;
        const base = state.cell ? state.cell.slice() : [0, 0, 0];
        const v = clampCellInput(i, parseFloat(inp.value));
        if (v == null) { inp.value = state.cell ? String(state.cell[i]) : '0'; return; }
        base[i] = v;
        pickCell(base);
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    $('#cellGo').addEventListener('click', () => {
      if (!state.data) return;
      const vals = ['x', 'y', 'z'].map((ax) => clampCellInput(AXIS_INDEX[ax], parseFloat($('#cell-' + ax).value)));
      if (vals.some((v) => v == null)) { toast('请输入 3 个整数单元坐标'); return; }
      pickCell(vals);
    });
    $('#cellPrev').addEventListener('click', () => stepCell(-1));
    $('#cellNext').addEventListener('click', () => stepCell(1));
    $('#cellFocus').addEventListener('click', () => {
      if (!state.cell || !state.data) return;
      state.slice.axis = 2;
      state.slice.layer = Math.max(0, Math.min(state.data.dims[2] - 2, state.cell[2]));
      renderSliceControls();
      drawAll();
      toast('切层已对准 k=' + state.slice.layer);
    });

    $('#restoreEdgeBtn').addEventListener('click', () => {
      const key = state.edgeKey;
      if (!key || !state.importedRaw) return;
      const orig = state.importedRaw.edges.find((e) => keyOf2(e) === key);
      const target = state.raw.edges.find((e) => keyOf2(e) === key);
      if (!orig || !target) return;
      target.t = orig.t;
      target.normal = orig.normal.slice();
      reextract({ rebuildEditor: true });
      toast('已恢复该边的导入值');
    });
    $('#restoreAllBtn').addEventListener('click', () => {
      if (!state.importedRaw) return;
      state.raw = BHE.cloneRaw(state.importedRaw);
      reextract({ resetSelection: true, rebuildEditor: true });
      toast('已恢复全部导入值');
    });

    $('#resetView').addEventListener('click', () => {
      if (scene) scene.fitToContent();
      toast('视角已适配等值面');
    });

    $('#importBtn').addEventListener('click', openImport);
    $('#exportBtn').addEventListener('click', openExport);
    $('#dialogClose').addEventListener('click', closeDialog);
    $('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog') closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dialog').hidden) closeDialog(); });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (scene) scene.resize();
        if (sliceView) sliceView.resize();
        if (detailView) detailView.resize();
      }, 80);
    });

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => {
      if (scene) scene.setTheme();
      if (sliceView) sliceView.setTheme();
      if (detailView) detailView.setTheme();
    };
    if (mq.addEventListener) mq.addEventListener('change', onTheme);
    new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ------------------------------------------------------------------- dialogs

  function openDialog(title, bodyNodes, footNodes) {
    $('#dialogTitle').textContent = title;
    const body = $('#dialogBody');
    body.innerHTML = '';
    for (const n of bodyNodes) body.appendChild(n);
    const foot = $('#dialogFoot');
    foot.innerHTML = '';
    for (const n of footNodes) foot.appendChild(n);
    $('#dialog').hidden = false;
    const focusTarget = body.querySelector('textarea, input, button');
    if (focusTarget) focusTarget.focus();
  }

  function closeDialog() {
    $('#dialog').hidden = true;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = btn.dataset.label || '复制'; }, 1400);
    } catch (e) {
      const ta = $('#dialogBody textarea');
      if (ta) {
        ta.focus();
        ta.select();
        btn.textContent = '已全选，请按 Ctrl+C';
      }
    }
  }

  function makeDownload(text, filename, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function openExport() {
    if (!state.raw) {
      toast('请先选择样例或导入 JSON');
      return;
    }
    const base = (state.caseId || 'custom').replace(/\.json$/, '');
    let activeTab = 'obj';

    const ta = el('textarea', { spellcheck: 'false', readonly: true, 'aria-label': '导出内容' });
    const tabs = el('div', { class: 'dialog-tabs' });
    const objBtn = el('button', { type: 'button', text: 'OBJ 三角网格' });
    const jsonBtn = el('button', { type: 'button', text: '诊断 JSON' });
    tabs.appendChild(objBtn);
    tabs.appendChild(jsonBtn);

    const summary = el('div', { class: 'hint' });
    const refreshCopyLabel = () => {
      copyBtn.textContent = activeTab === 'obj' ? '复制 OBJ' : '复制 JSON';
      copyBtn.dataset.label = copyBtn.textContent;
    };
    const render = () => {
      refreshCopyLabel();
      if (activeTab === 'obj') {
        ta.value = state.model ? BHE.toOBJ(state.model) : '# 无有效网格\n';
        const c = state.model ? state.model.counts : null;
        summary.textContent = c
          ? c.vertices + ' 个顶点 · ' + c.triangles + ' 个三角形 · 边界穿越 ' + c.boundary_crossings + '。点「复制 OBJ」后粘贴保存为 .obj。'
          : '输入无效，无法生成网格；可导出诊断 JSON 查看错误定位。';
      } else {
        ta.value = JSON.stringify(currentDiagnostics(), null, 2);
        summary.textContent = '含逐单元解、无约束解、活动约束、平面残差、误差定位，以及已编辑边记录。先把文本复制走，再存成 .json。';
      }
      objBtn.setAttribute('aria-selected', String(activeTab === 'obj'));
      jsonBtn.setAttribute('aria-selected', String(activeTab === 'json'));
    };
    const copyBtn = el('button', { type: 'button', class: 'primary', text: '复制 OBJ' });
    copyBtn.addEventListener('click', () => copyText(ta.value, copyBtn));
    objBtn.addEventListener('click', () => { activeTab = 'obj'; render(); });
    jsonBtn.addEventListener('click', () => { activeTab = 'json'; render(); });

    const selBtn = el('button', { type: 'button', text: '全选' });
    selBtn.addEventListener('click', () => { ta.focus(); ta.select(); });
    const dlBtn = el('button', { type: 'button', class: 'small ghost', text: '下载（仅独立部署）' });
    dlBtn.addEventListener('click', () => {
      const isObj = activeTab === 'obj';
      const name = base + (isObj ? '.obj' : '-diagnostics.json');
      const ok = makeDownload(ta.value, name, isObj ? 'text/plain' : 'application/json');
      toast(ok ? '已触发下载 ' + name + '；若没有出现文件，请改用复制' : '此处不允许下载，请使用复制');
    });

    render();
    openDialog('导出', [tabs, ta, summary], [copyBtn, selBtn, dlBtn]);
  }

  function openImport() {
    const ta = el('textarea', {
      spellcheck: 'false',
      placeholder: '粘贴输入 JSON：dims、origin、spacing、signs、edges。',
      'aria-label': '输入 JSON',
    });
    ta.value = state.importedRaw ? JSON.stringify(state.importedRaw, null, 1) : '';
    const file = el('input', { type: 'file', accept: '.json,application/json' });
    file.setAttribute('aria-label', '从文件载入 JSON');
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => { ta.value = String(fr.result); status.textContent = '已载入 ' + f.name + '，点击「载入并提取」。'; };
      fr.readAsText(f);
    });
    const status = el('div', { class: 'hint' });
    const applyBtn = el('button', { type: 'button', class: 'primary', text: '载入并提取' });
    applyBtn.addEventListener('click', () => {
      let raw;
      try {
        raw = JSON.parse(ta.value);
      } catch (e) {
        status.innerHTML = '';
        status.appendChild(el('span', { class: 'error-text', text: 'JSON 解析失败：' + e.message }));
        return;
      }
      const val = BHE.validateInput(raw);
      if (!val.ok) {
        status.innerHTML = '';
        const first = val.errors[0];
        status.appendChild(el('span', { class: 'error-text', text: '校验未通过：' + first.field + ' — ' + first.message + '（共 ' + val.errors.length + ' 项）' }));
        return;
      }
      state.caseId = null;
      $('#caseSelect').value = '';
      state.importedRaw = BHE.cloneRaw(raw);
      state.raw = BHE.cloneRaw(raw);
      state.slice = { axis: 2, layer: 0 };
      closeDialog();
      reextract({ resetSelection: true, rebuildEditor: true });
      if (scene) scene.fitToContent();
      toast('已载入并提取');
    });
    openDialog('导入 JSON', [file, ta, status], [applyBtn]);
  }

  // --------------------------------------------------------------------- boot

  async function boot() {
    View.attachTooltipStyles();
    sliceView = new View.SliceView($('#sliceCanvas'), $('#sliceTooltip'));
    detailView = new View.CellDetailView($('#cellCanvas'));
    scene = new View.Scene($('#scene'));
    scene.onPick = (hit) => { if (hit && state.model) pickCell(hit.v.cell); };
    sliceView.onPick = (hit) => {
      if (!hit) return;
      if (hit.kind === 'edge' && hit.edgeKey) {
        if (state.edgeKey !== hit.edgeKey) selectEdge(hit.edgeKey);
        return;
      }
      if (hit.kind === 'cell') pickCell(hit.cell);
    };

    if (window.BHE_CASES) state.samplesIndex = window.BHE_CASES;
    initControls();
    refreshAll({ rebuildEditor: true });

    const initial = (state.samplesIndex[0] && state.samplesIndex[0].id) || 'sharp-box';
    await selectCase(initial);

    requestAnimationFrame(() => {
      if (scene) scene.resize();
      if (sliceView) sliceView.resize();
      if (detailView) detailView.resize();
      if (scene) scene.fitToContent();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
