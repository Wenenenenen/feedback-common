/* 主应用：状态、可取消细分编排、相机联动重细分、控制点编辑、导入导出 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    model: null,
    camera: null,
    tess: null,
    linkGroups: null,
    options: { pixelError: 1.0, maxDepth: 7 },
    view: {
      showMesh: true,
      showWireframe: true,
      showNormals: false,
      showControlNet: false,
      shadeMode: 'shaded', // shaded | flat | heatmap
    },
    token: null,
    runSeq: 0,
    selected: null, // {patchId, j, i}
    dirty: false,
  };

  let renderer = null;

  /* ---------- 初始化 ---------- */
  function init() {
    const canvas = $('glcanvas');
    resizeCanvas(canvas);
    renderer = new Render.Renderer(canvas);
    bindCameraControls(canvas);
    bindUI();
    loadSample('patches');
    requestAnimationFrame(frame);
  }

  function resizeCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (state.camera) state.camera.setSize(canvas.width, canvas.height);
  }
  window.addEventListener('resize', () => {
    resizeCanvas($('glcanvas'));
    scheduleRetessellate();
  });

  /* ---------- 加载与校验 ---------- */
  function loadModel(data, sourceName) {
    const result = PatchModel.validateModel(data);
    if (!result.ok) {
      showImportError(result.errors, sourceName);
      return false;
    }
    state.model = result.model;
    state.linkGroups = PatchModel.buildLinkGroups(state.model);
    const cam = data.camera || {};
    state.camera = new Camera.OrthoCamera({
      position: cam.position || [3, 3, 4],
      target: cam.target || modelCenter(state.model),
      up: cam.up || [0, 1, 0],
      width: $('glcanvas').width,
      height: $('glcanvas').height,
      vertical_span: cam.vertical_span || 3,
    });
    state.selected = null;
    hideImportError();
    refreshPatchList();
    refreshControlNet();
    runTessellate();
    return true;
  }

  function modelCenter(model) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    model.patches.forEach((p) => p.points.forEach((row) => row.forEach((c) => {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], c[k]);
        max[k] = Math.max(max[k], c[k]);
      }
    })));
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  function loadSample(name) {
    const data = SAMPLE_CASES[name];
    if (!data) return;
    loadModel(JSON.parse(JSON.stringify(data)), name);
  }

  function showImportError(errors, sourceName) {
    const box = $('importError');
    $('importErrorTitle').textContent = `导入被拒绝：${sourceName || '未知来源'}`;
    $('importErrorList').innerHTML = errors
      .map((e) => `<li>${escapeHTML(e)}</li>`)
      .join('');
    box.classList.remove('hidden');
  }
  function hideImportError() {
    $('importError').classList.add('hidden');
  }

  /* ---------- 细分编排（可取消） ---------- */
  async function runTessellate() {
    if (!state.model) return;
    // 取消上一轮
    if (state.token) state.token.cancelled = true;
    const token = { cancelled: false };
    state.token = token;
    const seq = ++state.runSeq;
    setProgress(0, true);
    $('cancelBtn').disabled = false;

    try {
      const tess = await Tessellator.tessellate(state.model, state.camera, {
        pixelError: state.options.pixelError,
        maxDepth: state.options.maxDepth,
        token,
      }, (p) => {
        if (seq === state.runSeq) setProgress(p, true);
      });
      if (token.cancelled || seq !== state.runSeq) return;
      state.tess = tess;
      renderer.uploadMesh(tess, state.model, state.view.shadeMode, state.options.pixelError);
      refreshControlNet();
      updateStats();
      setProgress(1, false);
    } catch (err) {
      if (seq === state.runSeq) setProgress(0, false);
      console.error(err);
      alert('细分失败：' + err.message);
    } finally {
      if (seq === state.runSeq) $('cancelBtn').disabled = true;
    }
  }

  let retessTimer = null;
  function scheduleRetessellate(delay = 120) {
    if (!state.model) return;
    clearTimeout(retessTimer);
    retessTimer = setTimeout(() => runTessellate(), delay);
  }

  function setProgress(p, active) {
    const bar = $('progressBar');
    bar.style.width = `${Math.round(p * 100)}%`;
    $('progressWrap').classList.toggle('active', active);
  }

  /* ---------- 相机控制 ---------- */
  function bindCameraControls(canvas) {
    let dragging = false;
    let mode = null;
    let last = { x: 0, y: 0 };

    canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !state.camera) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (mode === 'rotate') {
        state.camera.rotate(dx * 0.01, dy * 0.01);
      } else {
        state.camera.pan(dx, dy);
      }
      scheduleRetessellate();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      state.camera.zoom(factor);
      scheduleRetessellate();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 单击拾取控制点（未拖动时）
    let downPos = null;
    canvas.addEventListener('mousedown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('mouseup', (e) => {
      if (!downPos || !state.model) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      const hit = renderer.pickControlPoint(state.model, state.camera, px, py);
      selectControlPoint(hit);
    });
  }

  /* ---------- 控制点选择与编辑 ---------- */
  function selectControlPoint(hit) {
    if (!hit) {
      state.selected = null;
      $('editor').classList.add('hidden');
      return;
    }
    state.selected = { patchId: hit.patchId, j: hit.j, i: hit.i };
    $('editor').classList.remove('hidden');
    syncEditorFields();
  }

  function syncEditorFields() {
    const { patchId, j, i } = state.selected;
    const patch = state.model.patches.find((p) => p.id === patchId);
    const p = patch.points[j][i];
    $('cpLabel').textContent = `片 ${patchId} · points[${j}][${i}]`;
    $('cpX').value = round(p[0]);
    $('cpY').value = round(p[1]);
    $('cpZ').value = round(p[2]);
    const linked = describeLinked(patchId, j, i);
    $('cpLinked').textContent = linked || '独立控制点（无接缝联动）';
  }

  function describeLinked(patchId, j, i) {
    const out = [];
    for (const edge of Bezier.EDGES) {
      const cp = Bezier.edgeControlPoints(
        state.model.patches.find((p) => p.id === patchId).points, edge);
      for (let k = 0; k < 4; k++) {
        const [gj, gi] = PatchModel.edgeIndexToGrid(edge, k);
        if (gj === j && gi === i) {
          const gi2 = state.linkGroups.memberToGroup.get(`${patchId}.${edge}.${k}`);
          if (gi2 != null) {
            const others = state.linkGroups.groups[gi2]
              .filter((m) => !(m.patch === patchId && m.edge === edge))
              .map((m) => `${m.patch}.${m.edge}[${m.index}]`);
            if (others.length) out.push(`接缝联动 → ${others.join(', ')}`);
          }
        }
      }
    }
    return out.join('；');
  }

  function editFromFields() {
    if (!state.selected) return;
    const x = parseFloat($('cpX').value);
    const y = parseFloat($('cpY').value);
    const z = parseFloat($('cpZ').value);
    if (![x, y, z].every(Number.isFinite)) return;
    const { patchId, j, i } = state.selected;
    PatchModel.applyLinkedEdit(state.model, state.linkGroups, patchId, j, i, [x, y, z]);
    // 接缝联动后理论上仍重合；刷新渲染与细分
    refreshControlNet();
    scheduleRetessellate(20);
  }

  function refreshControlNet() {
    if (state.model && state.linkGroups) {
      renderer.uploadControlNet(state.model, state.linkGroups);
      if (state.selected) syncEditorFields();
    }
  }

  /* ---------- 统计与报告 ---------- */
  function updateStats() {
    const t = state.tess;
    if (!t) return;
    const s = t.stats;
    const over = s.overLimitTriangles;
    $('stats').innerHTML = `
      <div class="stat"><span>曲面片</span><b>${s.patchCount}</b></div>
      <div class="stat"><span>接缝</span><b>${s.seamCount}</b></div>
      <div class="stat"><span>顶点</span><b>${s.vertexCount}</b></div>
      <div class="stat"><span>三角形</span><b>${s.triangleCount}</b></div>
      <div class="stat"><span>最大屏幕误差</span><b>${s.maxError.toFixed(3)} px</b></div>
      <div class="stat ${over ? 'warn' : ''}"><span>超限三角形</span><b>${over}</b></div>
      <div class="stat"><span>耗时</span><b>${s.elapsedMs} ms</b></div>`;
    $('perPatch').innerHTML = t.patchStats.map((p) => `
      <tr>
        <td>${p.id}${p.planar ? ' <em>平面</em>' : ''}</td>
        <td>${p.maxNodeDepth}</td>
        <td>${p.leafCount}</td>
        <td>${p.triangleCount}</td>
        <td>${p.maxError.toFixed(2)}</td>
        <td class="${p.overLimitTriangles ? 'warn' : ''}">${p.overLimitTriangles}</td>
      </tr>`).join('');
  }

  /* ---------- 导出 ---------- */
  function doExport(kind) {
    if (!state.tess) return;
    const opts = state.options;
    if (kind === 'mesh') {
      const mesh = Exporter.buildMeshJSON(state.model, state.tess, state.camera, opts);
      Exporter.downloadJSON(mesh, 'tessellated-mesh.json');
    } else {
      const report = Exporter.buildReport(state.model, state.tess, state.camera, opts, false);
      Exporter.downloadJSON(report, 'tessellation-report.json');
    }
  }

  /* ---------- UI 绑定 ---------- */
  function bindUI() {
    $('sampleSelect').addEventListener('change', (e) => loadSample(e.target.value));
    $('importFile').addEventListener('change', handleImport);
    $('dismissError').addEventListener('click', hideImportError);

    const errSlider = $('pixelError');
    errSlider.addEventListener('input', () => {
      state.options.pixelError = parseFloat(errSlider.value);
      $('pixelErrorVal').textContent = state.options.pixelError.toFixed(2);
      scheduleRetessellate();
    });
    const depthSlider = $('maxDepth');
    depthSlider.addEventListener('input', () => {
      state.options.maxDepth = parseInt(depthSlider.value, 10);
      $('maxDepthVal').textContent = state.options.maxDepth;
      scheduleRetessellate();
    });
    $('cancelBtn').addEventListener('click', () => {
      if (state.token) state.token.cancelled = true;
    });
    $('retessBtn').addEventListener('click', () => runTessellate());

    ['cpX', 'cpY', 'cpZ'].forEach((id) => $(id).addEventListener('input', editFromFields));

    $('exportMesh').addEventListener('click', () => doExport('mesh'));
    $('exportReport').addEventListener('click', () => doExport('report'));

    bindToggle('showMesh', 'showMesh', false);
    bindToggle('showWireframe', 'showWireframe', false);
    bindToggle('showNormals', 'showNormals', false);
    bindToggle('showControlNet', 'showControlNet', true);
    $('shadeMode').addEventListener('change', (e) => {
      state.view.shadeMode = e.target.value;
      if (state.tess) renderer.uploadMesh(state.tess, state.model, state.view.shadeMode, state.options.pixelError);
    });
  }

  function bindToggle(elId, key, retess) {
    $(elId).addEventListener('change', (e) => {
      state.view[key] = e.target.checked;
      if (retess && key === 'showControlNet') refreshControlNet();
    });
  }

  function refreshPatchList() {
    $('patchList').textContent = state.model.patches.map((p) => p.id).join(', ');
  }

  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (err) {
        showImportError(['JSON 解析失败：' + err.message], file.name);
        return;
      }
      loadModel(data, file.name);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /* ---------- 渲染循环 ---------- */
  function frame() {
    if (state.camera && state.tess) {
      renderer.render(state.camera, state.view);
    } else if (state.camera) {
      renderer.render(state.camera, state.view);
    }
    requestAnimationFrame(frame);
  }

  function round(n) { return Math.round(n * 1e6) / 1e6; }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('DOMContentLoaded', init);

  // 测试钩子（仅自动化使用）：暴露最小内部状态与编辑入口
  window.__PST = {
    state,
    selectControlPoint,
    editFromFields,
    runTessellate,
  };
})();
