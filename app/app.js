/*
 * app.js — 界面主控：状态、树视图、节点编辑、相机、拾取、批量射线。
 * 依赖全局 Mat4 / SdfValidate / Sdf / RayMarch / Render（由 index.html 顺序加载）。
 */
(function () {
  'use strict';

  // ---------- 内置示例（与样例包一致，便于 file:// 直接体验） ----------
  const SAMPLES = {
    sphere: {
      nodes: { outer: { kind: 'sphere', radius: 1 } }, root: 'outer',
      rays: [
        { id: 'outside', origin: [0, 0, 3], direction: [0, 0, -1] },
        { id: 'inside', origin: [0, 0, 0], direction: [1, 0, 0] },
        { id: 'miss', origin: [0, 0, 3], direction: [0, 1, 0] },
      ],
    },
    shell: {
      nodes: {
        outer: { kind: 'sphere', radius: 1 },
        inner: { kind: 'sphere', radius: 0.5 },
        cut: { kind: 'difference', left: 'outer', right: 'inner' },
      },
      root: 'cut',
      rays: [
        { id: 'outside', origin: [0, 0, 3], direction: [0, 0, -1] },
        { id: 'inside', origin: [0, 0, 0], direction: [1, 0, 0] },
        { id: 'miss', origin: [0, 0, 3], direction: [0, 1, 0] },
      ],
    },
    scaled: {
      nodes: { ellipsoid: { kind: 'sphere', radius: 1, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1] } },
      root: 'ellipsoid',
      rays: [{ id: 'axis', origin: [3, 0, 0], direction: [-1, 0, 0] }],
    },
    sheared: {
      nodes: { shape: { kind: 'sphere', radius: 1, matrix: [1, 0.8, 0, 0, 0, 1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1] } },
      root: 'shape',
      rays: [{ id: 'thin', origin: [0, 0, 2], direction: [0, 0, -1] }],
    },
    'union-intersection': {
      nodes: {
        box: { kind: 'box', half_size: [0.8, 0.8, 0.8] },
        ring: { kind: 'torus', major: 0.7, minor: 0.3 },
        op: { kind: 'union', left: 'box', right: 'ring' },
      },
      root: 'op',
      rays: [
        { id: 'outside', origin: [0, 0, 3], direction: [0, 0, -1] },
        { id: 'inside', origin: [0, 0, 0], direction: [1, 0, 0] },
        { id: 'miss', origin: [0, 0, 3], direction: [0, 1, 0] },
      ],
    },
  };

  // ---------- 状态 ----------
  const state = {
    scene: null,          // 可编辑的场景对象
    validation: null,     // 最近一次校验结果
    tree: null,           // Sdf.compile 产物（校验通过时）
    cam: Render.makeCamera(),
    selectedId: null,
    pixelInfo: null,
    leafIndex: new Map(),
    batchRays: [],        // 批量导入的射线
    batchResults: null,
    renderMs: null,
  };

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(Render.WIDTH, Render.HEIGHT);

  // ---------- 工具 ----------
  function fmt(v, digits = 5) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number') return String(v);
    if (!Number.isFinite(v)) return String(v);
    if (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-3)) return v.toExponential(3);
    return Number(v.toFixed(digits)).toString();
  }
  function fmtVec(v, digits = 4) {
    return Array.isArray(v) ? '[' + v.map((x) => fmt(x, digits)).join(', ') + ']' : String(v);
  }
  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 场景载入与校验 ----------
  function loadScene(data, sourceName) {
    state.scene = data;
    state.selectedId = null;
    state.batchResults = null;
    state.pixelInfo = null;
    const result = SdfValidate.validateScene(data);
    state.validation = result;
    renderValidation(sourceName);
    if (result.ok) {
      state.tree = Sdf.compile(data);
      rebuildLeafIndex();
      state.selectedId = data.root;
    } else {
      state.tree = null;
      state.leafIndex = new Map();
    }
    renderTree();
    renderEditor();
    renderLegend();
    scheduleRender();
    updateSceneStat();
  }

  function rebuildLeafIndex() {
    state.leafIndex = new Map();
    if (!state.tree) return;
    Sdf.listLeaves(state.tree).sort().forEach((id, i) => state.leafIndex.set(id, i));
  }

  function renderValidation(sourceName) {
    const el = $('validation');
    const v = state.validation;
    const parts = [];
    if (sourceName) parts.push(`<div class="msg ok">已载入 ${escapeHtml(sourceName)}</div>`);
    if (!v) { el.innerHTML = parts.join(''); return; }
    for (const e of v.errors) {
      parts.push(`<div class="msg error">${e.node ? `节点 <span class="node-id">${escapeHtml(e.node)}</span>：` : ''}${escapeHtml(e.message)}</div>`);
    }
    for (const w of v.warnings) {
      parts.push(`<div class="msg warning">${w.node ? `节点 <span class="node-id">${escapeHtml(w.node)}</span>：` : ''}${escapeHtml(w.message)}</div>`);
    }
    if (v.ok && v.warnings.length === 0) {
      parts.push('<div class="msg ok">校验通过：引用、尺寸、变换与树约束均合法</div>');
    }
    el.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateSceneStat() {
    const v = state.validation;
    $('sceneStat').textContent = v
      ? `叶 ${v.stats.leafCount}/64 · 最大深度 ${v.stats.maxDepth}/16 · 错误 ${v.errors.length} · 警告 ${v.warnings.length}`
      : '';
  }

  // ---------- 树视图 ----------
  function renderTree() {
    const el = $('treeView');
    if (!state.scene) { el.innerHTML = '<p class="hint">尚未载入场景。</p>'; $('treeMeta').textContent = ''; return; }
    const nodes = state.scene.nodes;
    const root = state.scene.root;
    const rows = [];
    const seen = new Set();
    const walk = (id, depth) => {
      if (!nodes[id]) {
        rows.push(`<div class="node" style="margin-left:${depth * 14}px"><span class="neg-tag">✗ ${escapeHtml(id)}（缺失）</span></div>`);
        return;
      }
      if (seen.has(id)) {
        rows.push(`<div class="node" style="margin-left:${depth * 14}px"><span class="neg-tag">⟲ ${escapeHtml(id)}（环）</span></div>`);
        return;
      }
      seen.add(id);
      const n = nodes[id];
      const isLeaf = SdfValidate.LEAF_KINDS.has(n.kind);
      const swatch = isLeaf && state.leafIndex.has(id)
        ? `<span class="swatch" style="background:rgb(${Render.leafColor(id, state.leafIndex.get(id), state.leafIndex.size, false).join(',')})"></span>`
        : '<span class="swatch" style="background:transparent;border-color:#666"></span>';
      const sel = state.selectedId === id ? ' selected' : '';
      rows.push(
        `<div class="node${sel}" data-id="${escapeHtml(id)}" style="margin-left:${depth * 14}px">` +
        `${swatch}<span class="kind">${escapeHtml(n.kind)}</span> ${escapeHtml(id)}` +
        (n.matrix ? ' <span class="neg-tag">M</span>' : '') +
        '</div>'
      );
      if (!isLeaf && n.left !== undefined) {
        walk(n.left, depth + 1);
        walk(n.right, depth + 1);
      }
    };
    walk(root, 0);
    el.innerHTML = rows.join('');
    el.querySelectorAll('.node[data-id]').forEach((nodeEl) => {
      nodeEl.addEventListener('click', () => {
        state.selectedId = nodeEl.dataset.id;
        renderTree();
        renderEditor();
      });
    });
    $('treeMeta').textContent = state.tree ? `（根 ${escapeHtml(root)}）` : '';
  }

  // ---------- 节点编辑器 ----------
  function renderEditor() {
    const el = $('editor');
    const id = state.selectedId;
    $('editNodeId').textContent = id ? `· ${id}` : '';
    if (!id || !state.scene || !state.scene.nodes[id]) {
      el.innerHTML = '<p class="hint">在树上选择一个节点进行编辑。</p>';
      return;
    }
    const n = state.scene.nodes[id];
    const parts = [];

    if (SdfValidate.LEAF_KINDS.has(n.kind)) {
      parts.push('<label>类型（叶节点尺寸）</label>');
      if (n.kind === 'sphere') {
        parts.push(numField('radius', n.radius, 'radius（半径，>0）'));
      } else if (n.kind === 'box') {
        parts.push('<label>half_size（半尺寸，均 >0）</label><div class="row">');
        for (let i = 0; i < 3; i++) parts.push(numField(`half_${i}`, n.half_size[i], ['x', 'y', 'z'][i]));
        parts.push('</div>');
      } else {
        parts.push(numField('major', n.major, 'major（主半径，>0）'));
        parts.push(numField('minor', n.minor, 'minor（管半径，>0）'));
      }
    } else if (SdfValidate.INTERNAL_KINDS.has(n.kind)) {
      parts.push(
        '<label>布尔运算 / 子节点引用</label>',
        '<div class="row">',
        `<select id="edKind">${['union', 'intersection', 'difference'].map((k) => `<option ${k === n.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>`,
        '</div>',
        '<div class="row">',
        textField('edLeft', n.left, 'left 节点 id'),
        textField('edRight', n.right, 'right 节点 id'),
        '</div>'
      );
    }

    parts.push('<label>可逆仿射变换（行主序 4×4，留空为单位阵）</label>');
    const m = n.matrix || Mat4.identity();
    parts.push('<div class="matrix-grid">');
    for (let i = 0; i < 16; i++) parts.push(`<input type="number" step="any" id="m${i}" value="${fmt(m[i], 6)}">`);
    parts.push('</div>');
    parts.push('<div class="row" style="margin-top:6px">');
    parts.push('<button id="clearMatrixBtn">清除变换（单位阵）</button>');
    parts.push('<button id="applyMatrixBtn" class="primary">应用变换</button>');
    parts.push('</div>');
    parts.push('<p class="hint" id="matrixHint"></p>');

    el.innerHTML = parts.join('');

    // 绑定字段
    if (n.kind === 'sphere') bindNum('radius', (v) => { n.radius = v; });
    if (n.kind === 'torus') {
      bindNum('major', (v) => { n.major = v; });
      bindNum('minor', (v) => { n.minor = v; });
    }
    if (n.kind === 'box') {
      for (let i = 0; i < 3; i++) bindNum(`half_${i}`, (v) => { n.half_size[i] = v; });
    }
    if (SdfValidate.INTERNAL_KINDS.has(n.kind)) {
      $('edKind').addEventListener('change', (e) => { n.kind = e.target.value; afterEdit(); });
      $('edLeft').addEventListener('change', (e) => { n.left = e.target.value; afterEdit(); });
      $('edRight').addEventListener('change', (e) => { n.right = e.target.value; afterEdit(); });
    }
    $('clearMatrixBtn').addEventListener('click', () => {
      delete n.matrix;
      afterEdit();
    });
    $('applyMatrixBtn').addEventListener('click', () => {
      const vals = [];
      for (let i = 0; i < 16; i++) vals.push(Number($(`m${i}`).value));
      n.matrix = vals;
      afterEdit();
    });
    updateMatrixHint(n);
  }

  function updateMatrixHint(n) {
    const hint = $('matrixHint');
    if (!hint) return;
    if (!n.matrix) { hint.textContent = '当前为单位阵'; return; }
    const inv = Mat4.inverse(n.matrix);
    if (inv === null) { hint.innerHTML = '<span class="neg">该矩阵奇异，无法求逆，保存后将报校验错误</span>'; return; }
    const sig = Mat4.minSingularValue(n.matrix);
    hint.textContent = `可逆；线性部分最小奇异值 σ_min = ${fmt(sig, 5)}（局部场按此缩为世界保守下界）`;
  }

  function numField(id, value, labelText) {
    return `<div><label style="margin-top:0">${escapeHtml(labelText)}</label><input type="number" step="any" id="ed_${id}" value="${value}"></div>`;
  }
  function textField(id, value, labelText) {
    return `<div><label style="margin-top:0">${escapeHtml(labelText)}</label><input type="text" id="${id}" value="${escapeHtml(value)}"></div>`;
  }
  function bindNum(id, apply) {
    const input = $(`ed_${id}`);
    if (!input) return;
    input.addEventListener('change', () => {
      apply(Number(input.value));
      afterEdit();
    });
  }

  // 编辑后重新校验；合法则重编译并重渲，非法则保留数据、展示错误、停用上一版树
  function afterEdit() {
    const v = SdfValidate.validateScene(state.scene);
    state.validation = v;
    renderValidation();
    updateSceneStat();
    if (v.ok) {
      state.tree = Sdf.compile(state.scene);
      rebuildLeafIndex();
      renderLegend();
      scheduleRender();
    } else {
      state.tree = null;
    }
    renderTree();
    renderEditor();
  }

  // ---------- 图例 ----------
  function renderLegend() {
    const el = $('legend');
    if (!state.tree || state.leafIndex.size === 0) { el.innerHTML = '<span class="hint">无有效叶节点</span>'; return; }
    const total = state.leafIndex.size;
    el.innerHTML = [...state.leafIndex.entries()].map(([id, idx]) => {
      const rgb = Render.leafColor(id, idx, total, false);
      const rgbDark = Render.leafColor(id, idx, total, true);
      return `<span class="item"><span class="swatch" style="background:rgb(${rgb.join(',')})"></span>${escapeHtml(id)}` +
        `<span class="swatch" style="background:rgb(${rgbDark.join(',')});margin-left:6px" title="差集内壁"></span><span class="hint">内壁</span></span>`;
    }).join('');
  }

  // ---------- 渲染 ----------
  let renderQueued = false;
  function scheduleRender() {
    if (!$('autoRender').checked) return;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(); });
  }
  function doRender() {
    if (!state.tree) {
      ctx.fillStyle = '#10141b';
      ctx.fillRect(0, 0, Render.WIDTH, Render.HEIGHT);
      $('renderStat').textContent = '场景未通过校验，无法渲染';
      state.pixelInfo = null;
      return;
    }
    const maxSteps = RayMarch.normalizeMaxSteps(Number($('maxStepsInput').value));
    const t0 = performance.now();
    const out = Render.render(state.tree, state.cam, imageData, state.leafIndex, state.leafIndex.size, maxSteps);
    ctx.putImageData(imageData, 0, 0);
    state.renderMs = performance.now() - t0;
    state.pixelInfo = out.pixelInfo;
    $('renderStat').textContent =
      `${state.renderMs.toFixed(0)} ms · hit ${out.stats.hit} · miss ${out.stats.miss} · 耗尽 ${out.stats.iteration_limit || 0}`;
  }

  // ---------- 相机交互 ----------
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (e.shiftKey) {
      state.cam.distance = Math.min(30, Math.max(2, state.cam.distance + dy * 0.01));
    } else {
      state.cam.azimuth += dx * 0.01;
      state.cam.elevation = Math.max(-1.45, Math.min(1.45, state.cam.elevation + dy * 0.01));
    }
    scheduleRender();
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.cam.distance = Math.min(30, Math.max(2, state.cam.distance + e.deltaY * 0.005));
    scheduleRender();
  }, { passive: false });

  // ---------- 点击拾取 ----------
  canvas.addEventListener('click', (e) => {
    if (!state.tree || !state.pixelInfo) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * Render.WIDTH);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * Render.HEIGHT);
    if (px < 0 || py < 0 || px >= Render.WIDTH || py >= Render.HEIGHT) return;
    const info = state.pixelInfo[py * Render.WIDTH + px];
    if (!info) {
      $('pickInfo').innerHTML = '<p class="hint">该像素未命中（miss 或步数耗尽），无表面信息。可降低 max_steps 观察耗尽像素。</p>';
      return;
    }
    // 用点击像素对应的相机射线做一次带完整采样的求交
    const ray = Render.pixelRay(state.cam, px, py);
    const trace = RayMarch.trace(state.tree, ray, { maxSteps: Number($('maxStepsInput').value) });
    renderPickInfo(px, py, ray, trace);
  });

  function renderPickInfo(px, py, ray, r) {
    const el = $('pickInfo');
    if (r.status !== 'hit') {
      el.innerHTML = `<p class="hint">像素 (${px},${py}) 状态为 <span class="status-pill status-${r.status}">${r.status}</span>，无表面命中。</p>`;
      return;
    }
    const rows = [
      ['状态', `<span class="status-pill status-hit">hit</span>`],
      ['命中叶', `<span class="node-id" style="color:var(--accent)">${escapeHtml(r.leaf)}</span>${r.negated ? ' <span class="neg">（差集右枝，梯度反向）</span>' : ''}`],
      ['t', fmt(r.t, 6)],
      ['距离 d', `${fmt(r.distance, 6)}（|d| ≤ ${RayMarch.HIT_EPSILON} 判定命中）`],
      ['命中点', fmtVec(r.point, 5)],
      ['法线', fmtVec(r.normal, 5)],
      ['步数', `${r.steps} / ${RayMarch.normalizeMaxSteps(Number($('maxStepsInput').value))}`],
      ['射线原点', fmtVec(ray.origin, 4)],
      ['射线方向', fmtVec(ray.direction, 4)],
    ];
    const sampleRows = r.samples.map((s) =>
      `<tr><td>${s.step}</td><td>${fmt(s.t, 5)}</td><td class="${s.negated ? 'neg' : ''}">${fmt(s.d, 5)}</td>` +
      `<td class="leaf-cell">${escapeHtml(s.leaf)}${s.negated ? ' <span class="neg">¬</span>' : ''}</td></tr>`).join('');
    el.innerHTML =
      `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>` +
      `<label style="margin-top:8px">每步采样（${r.samples.length} 步）</label>` +
      `<div class="samples"><table><thead><tr><th>step</th><th>t</th><th>d</th><th>leaf</th></tr></thead><tbody>${sampleRows}</tbody></table></div>`;
  }

  // ---------- 文件导入 ----------
  function readJsonFile(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      try { cb(null, JSON.parse(reader.result)); }
      catch (err) { cb(err); }
    };
    reader.readAsText(file);
  }
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readJsonFile(file, (err, data) => {
      if (err) { $('validation').innerHTML = `<div class="msg error">JSON 解析失败：${escapeHtml(err.message)}</div>`; return; }
      loadScene(data, file.name);
    });
    e.target.value = '';
  });
  $('rayFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readJsonFile(file, (err, data) => {
      if (err) { $('batchStat').innerHTML = `<span class="neg">JSON 解析失败：${escapeHtml(err.message)}</span>`; return; }
      importRays(data, file.name);
    });
    e.target.value = '';
  });

  function importRays(data, name) {
    const rays = Array.isArray(data) ? data : data.rays;
    if (!Array.isArray(rays)) {
      $('batchStat').innerHTML = '<span class="neg">射线文件需要 rays 数组或顶层数组</span>';
      return;
    }
    // 复用场景校验里的射线规则做逐条检查
    const probe = { nodes: { s: { kind: 'sphere', radius: 1 } }, root: 's', rays };
    const v = SdfValidate.validateScene(probe);
    const rayErrors = v.errors.filter((e) => /射线|origin|direction|id/.test(e.message));
    if (rayErrors.length) {
      $('batchStat').innerHTML = rayErrors.map((e) => `<span class="neg">${escapeHtml(e.message)}</span>`).join('<br>');
      return;
    }
    state.batchRays = rays;
    state.batchResults = null;
    $('batchStat').innerHTML = `已从 ${escapeHtml(name)} 导入 <b>${rays.length}</b> 条射线，等待运行。`;
    $('batchSummary').innerHTML = '';
  }

  // ---------- 批量求交与导出 ----------
  $('runBatchBtn').addEventListener('click', () => {
    if (!state.tree) { $('batchStat').innerHTML = '<span class="neg">场景未通过校验，无法运行</span>'; return; }
    const rays = state.batchRays.length ? state.batchRays : (state.scene.rays || []);
    if (!rays.length) { $('batchStat').innerHTML = '<span class="neg">没有射线：可使用场景自带 rays 或导入射线文件</span>'; return; }
    const maxSteps = RayMarch.normalizeMaxSteps(Number($('maxStepsInput').value));
    const t0 = performance.now();
    const results = rays.map((ray) => {
      const r = RayMarch.trace(state.tree, ray, { maxSteps });
      return packResult(ray, r, maxSteps);
    });
    state.batchResults = { params: { maxSteps, tMax: RayMarch.T_MAX, hitEpsilon: RayMarch.HIT_EPSILON, gradEpsilon: Sdf.GRAD_EPS }, results };
    const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const ms = (performance.now() - t0).toFixed(1);
    $('batchStat').innerHTML = `完成 ${results.length} 条（${ms} ms）：` +
      `<span class="status-pill status-hit">hit ${counts.hit || 0}</span> ` +
      `<span class="status-pill status-miss">miss ${counts.miss || 0}</span> ` +
      `<span class="status-pill status-iteration_limit">iteration_limit ${counts.iteration_limit || 0}</span>`;
    $('batchSummary').innerHTML = renderBatchTable(results);
  });

  function packResult(ray, r, maxSteps) {
    const base = {
      id: ray.id,
      status: r.status,
      steps: r.steps,
      maxSteps,
      samples: r.samples.map((s) => ({ step: s.step, t: s.t, d: s.d, leaf: s.leaf, negated: s.negated })),
    };
    if (r.status === 'hit') {
      return {
        ...base,
        t: r.t, point: r.point, leaf: r.leaf, negated: r.negated,
        distance: r.distance, normal: r.normal,
      };
    }
    if (r.status === 'miss') return { ...base, t: r.t, lastDistance: r.lastDistance };
    return { ...base, t: r.t, lastDistance: r.lastDistance, lastLeaf: r.lastLeaf };
  }

  function renderBatchTable(results) {
    const rows = results.slice(0, 200).map((r) =>
      `<tr><td>${escapeHtml(String(r.id))}</td>` +
      `<td><span class="status-pill status-${r.status}">${r.status}</span></td>` +
      `<td>${fmt(r.t, 4)}</td>` +
      `<td class="leaf-cell">${r.leaf ? escapeHtml(r.leaf) + (r.negated ? ' <span class="neg">¬</span>' : '') : '—'}</td>` +
      `<td>${r.normal ? fmtVec(r.normal, 3) : '—'}</td></tr>`).join('');
    return `<div class="samples" style="max-height:260px;margin-top:6px"><table>` +
      `<thead><tr><th>id</th><th>status</th><th>t</th><th>leaf</th><th>normal</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      (results.length > 200 ? '<p class="hint">仅预览前 200 条，导出 JSON 含全部。</p>' : '');
  }

  $('exportHitsBtn').addEventListener('click', () => {
    if (!state.batchResults) { $('batchStat').innerHTML = '<span class="neg">请先运行批量求交</span>'; return; }
    const byId = {};
    for (const r of state.batchResults.results) byId[r.id] = r;
    downloadJson('csg-hits.json', {
      format: 'signed-distance-csg-desk/hits-v1',
      generatedAt: new Date().toISOString(),
      params: state.batchResults.params,
      results: byId,
      resultsArray: state.batchResults.results,
    });
  });
  $('exportSceneBtn').addEventListener('click', () => {
    if (!state.scene) return;
    const { __sample, ...clean } = state.scene;
    downloadJson('csg-scene.json', clean);
  });

  // ---------- 其他控件 ----------
  $('renderBtn').addEventListener('click', doRender);
  $('resetCamBtn').addEventListener('click', () => { state.cam = Render.makeCamera(); scheduleRender(); });
  $('maxStepsInput').addEventListener('change', () => {
    const v = RayMarch.normalizeMaxSteps(Number($('maxStepsInput').value));
    $('maxStepsInput').value = v;
    scheduleRender();
  });
  $('resetSceneBtn').addEventListener('click', () => {
    state.scene = null; state.tree = null; state.validation = null;
    state.selectedId = null; state.batchResults = null; state.batchRays = [];
    $('validation').innerHTML = ''; $('treeView').innerHTML = ''; $('editor').innerHTML = '';
    $('legend').innerHTML = ''; $('pickInfo').innerHTML = ''; $('batchSummary').innerHTML = '';
    $('batchStat').textContent = ''; updateSceneStat();
    ctx.fillStyle = '#10141b'; ctx.fillRect(0, 0, Render.WIDTH, Render.HEIGHT);
    $('renderStat').textContent = '';
  });
  $('loadSampleBtn').addEventListener('click', () => {
    const names = Object.keys(SAMPLES);
    const name = names[(names.indexOf(state.scene && state.scene.__sample) + 1) % names.length] || 'sphere';
    const data = JSON.parse(JSON.stringify(SAMPLES[name]));
    data.__sample = name;
    loadScene(data, `内置示例 ${name}.json`);
  });

  // ---------- 启动：默认球壳差集（覆盖外壁/内壁拾取两个关键点） ----------
  loadScene(JSON.parse(JSON.stringify(SAMPLES.shell)), '内置示例 shell.json');

  // 只读调试/自动化句柄（不暴露任何写接口）
  globalThis.__CSG_DEBUG__ = {
    getState: () => state,
    tracePixel(px, py) {
      if (!state.tree) return null;
      const ray = Render.pixelRay(state.cam, px, py);
      return RayMarch.trace(state.tree, ray, { maxSteps: Number($('maxStepsInput').value) });
    },
  };
})();
