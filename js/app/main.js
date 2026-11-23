/* 主控制器：文件导入、Worker 调度、状态保留、UI 事件与导出。 */
(function (global) {
  'use strict';

  const state = {
    data: null,           // 原始导入数据
    result: null,         // 最近一次成功结果（即使后续姿态非法也保留可导出）
    lastGood: null,       // 上一份成功结果（非法姿态时仍可导出）
    badCells: [],
    badFaces: [],
    view: 'deformed',     // deformed | rest
    showCage: true,
    showNormals: false,
    worker: null,
    ctx: null,
    busy: false,
  };

  const $ = (id) => document.getElementById(id);

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + (kind || '');
  }
  function setProgress(ratio) {
    const bar = $('progress-bar');
    bar.style.width = Math.round(ratio * 100) + '%';
  }

  function init() {
    state.ctx = TCScene.createScene($('viewport'));
    TCScene.setHighlightVerts(state.ctx, []);
    bindUI();
    bindSceneEvents();
    // 自动载入样本
    loadFromUrl('samples/tetra-cage.json', true);
  }

  function bindUI() {
    $('file-input').addEventListener('change', onFile);
    $('load-sample').addEventListener('click', () => loadFromUrl('samples/tetra-cage.json', false));
    $('load-perf').addEventListener('click', () => loadFromUrl('samples/perf-full.json', false));
    $('btn-export-deformed').addEventListener('click', () => exportCurrent('deformed'));
    $('btn-export-rest').addEventListener('click', () => exportCurrent('rest'));
    $('toggle-cage').addEventListener('change', (e) => {
      state.showCage = e.target.checked;
      state.ctx.cageGroup.visible = state.showCage;
    });
    $('toggle-normals').addEventListener('change', (e) => {
      state.showNormals = e.target.checked;
      rerenderFragments();
    });
    $('view-deformed').addEventListener('click', () => setView('deformed'));
    $('view-rest').addEventListener('click', () => setView('rest'));
    $('opacity').addEventListener('input', (e) => {
      if (state.ctx.fragmentMesh) state.ctx.fragmentMesh.material.opacity = Number(e.target.value);
    });
  }

  function setView(v) {
    state.view = v;
    $('view-deformed').classList.toggle('active', v === 'deformed');
    $('view-rest').classList.toggle('active', v === 'rest');
    rerenderAll();
  }

  function bindSceneEvents() {
    TCScene.bindInteraction(state.ctx, $('viewport'), {
      onFragmentPick: (hit, perFragmentMeshes) => {
        const target = pickFragmentByFaceIndex(hit.faceIndex, perFragmentMeshes);
        if (target) selectFragment(target);
      },
      onCageDrag: (vi, xyz) => {
        // 拖动期间实时移动 marker，不重算（松手才重算）
      },
      onDragEnd: (drag) => {
        if (drag.kind === 'cagePoint' && state.data) {
          const p = drag.obj.position;
          state.data.pose = state.data.pose || state.data.rest.map(q => [...q]);
          state.data.pose[drag.index] = [Number(p.x.toFixed(4)), Number(p.y.toFixed(4)), Number(p.z.toFixed(4))];
          runWorker(true);
        }
      },
    });
  }

  // 碎片按扇形三角化，faceIndex 顺序与 fragment 顺序一致，累计三角形数定位
  function pickFragmentByFaceIndex(faceIndex, perFragmentMeshes) {
    let acc = 0;
    for (const info of perFragmentMeshes) {
      const triCount = info.fragment.vertIds.length - 2;
      if (faceIndex < acc + triCount) return info.fragment;
      acc += triCount;
    }
    return null;
  }

  function selectFragment(fr) {
    const verts = state.result.verts.map(gv => state.view === 'rest' ? gv.rest : gv.deformed);
    TCScene.setHighlightVerts(state.ctx, verts);
    TCScene.highlightFragment(state.ctx, fr);
    // 找到该碎片的全局顶点归属单元
    const ownerCells = new Set(fr.vertIds.map(id => state.result.verts[id].ownerCell));
    $('inspector').innerHTML =
      `<div class="ins-title">碎片详情</div>
       <div><span class="k">原面编号</span><span class="v">${fr.faceId}</span></div>
       <div><span class="k">所属单元</span><span class="v">${fr.cellId}</span></div>
       <div><span class="k">顶点数</span><span class="v">${fr.vertIds.length}</span></div>
       <div><span class="k">面积</span><span class="v">${fr.area.toFixed(4)}</span></div>
       <div><span class="k">共享顶点单元</span><span class="v">${[...ownerCells].join(', ')}</span></div>`;
  }

  function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        acceptData(json, file.name);
      } catch (err) {
        setStatus('JSON 解析失败：' + err.message, 'err');
      }
    };
    reader.readAsText(file);
  }

  function loadFromUrl(url, silent) {
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(json => acceptData(json, url.split('/').pop()))
      .catch(err => { if (!silent) setStatus('载入失败：' + err.message, 'err'); });
  }

  function acceptData(json, name) {
    const err = validateEnvelope(json);
    if (err) { setStatus('输入结构非法：' + err, 'err'); return; }
    if (!json.pose) json.pose = json.rest.map(p => [...p]);
    if (json.cells.length > 2048) { setStatus('单元数超过 2048 上限', 'err'); return; }
    if (json.faces.length > 12000) { setStatus('三角形数超过 12000 上限', 'err'); return; }
    state.data = json;
    setStatus(`已载入 ${name}：${json.rest.length} 顶点 / ${json.cells.length} 单元 / ${json.faces.length} 面`, '');
    runWorker(false);
  }

  function validateEnvelope(d) {
    if (!d || !Array.isArray(d.rest) || !Array.isArray(d.cells) || !Array.isArray(d.faces)) {
      return '缺少 rest / cells / faces 字段';
    }
    return null;
  }

  function runWorker(isPoseEdit) {
    if (state.busy) { state.worker && state.worker.terminate(); state.busy = false; }
    setProgress(0.02);
    setStatus(isPoseEdit ? '正在重算变形…' : '正在校验与裁分…', '');
    const worker = new Worker('js/worker/fragment.worker.js');
    state.worker = worker;
    state.busy = true;
    const t0 = performance.now();

    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') { setProgress(msg.ratio); return; }
      if (msg.type === 'error') {
        state.busy = false;
        setStatus('处理失败：' + msg.error, 'err');
        return;
      }
      if (msg.type === 'result') {
        state.busy = false;
        setProgress(1);
        const elapsed = performance.now() - t0;
        state.result = msg;
        state.badCells = msg.badCells;
        state.badFaces = msg.badFaces;
        const poseIllegal = msg.badCells.length > 0;
        const faceRejected = msg.badFaces.length > 0;
        if (!poseIllegal && !faceRejected) state.lastGood = msg;
        else if (!state.lastGood) state.lastGood = msg; // 首份即便有标记也保留，保证可导出
        updateSummary(elapsed);
        rerenderAll();
        const flags = [];
        if (poseIllegal) flags.push(`非法单元 ${msg.badCells.length} 个`);
        if (faceRejected) flags.push(`越界面 ${msg.badFaces.length} 个`);
        setStatus(flags.length ? `完成（${elapsed / 1000 >= 12 ? '超预算' : elapsed.toFixed(0) + 'ms'}）：${flags.join('，')}` : `完成，用时 ${elapsed.toFixed(0)} ms，无非法项`,
          flags.length ? 'warn' : 'ok');
      }
    };
    worker.postMessage({ type: 'process', data: state.data });
  }

  function updateSummary(elapsed) {
    const r = state.result;
    $('summary').innerHTML =
      `<div class="row"><span>碎片总数</span><b>${r.fragments.length}</b></div>
       <div class="row"><span>去重顶点</span><b>${r.verts.length}</b></div>
       <div class="row"><span>非法单元</span><b class="${r.badCells.length ? 'bad' : 'ok'}">${r.badCells.length}</b></div>
       <div class="row"><span>越界原面</span><b class="${r.badFaces.length ? 'bad' : 'ok'}">${r.badFaces.length}</b></div>
       <div class="row"><span>耗时</span><b>${elapsed.toFixed(0)} ms</b></div>`;
    $('issue-list').innerHTML = (r.faceErrors || []).slice(0, 50)
      .map(e => `<div class="issue">原面 ${e.face}：${e.error}</div>`).join('')
      + r.cellReasons.slice(0, 50).map(([ci, why]) => `<div class="issue">单元 ${ci}：${why}</div>`).join('');
  }

  function rerenderAll() {
    if (!state.result || !state.data) return;
    const points = state.view === 'rest' ? state.data.rest : (state.data.pose || state.data.rest);
    TCScene.renderCage(state.ctx, state.data.rest, points, state.data.cells, state.badCells, { showPose: state.view === 'deformed' });
    rerenderFragments();
    TCScene.renderMarkers(state.ctx, state.result, state.data, {});
  }
  function rerenderFragments() {
    if (!state.result) return;
    TCScene.renderFragments(state.ctx, state.result, {
      rest: state.view === 'rest',
      normals: state.showNormals,
      opacity: Number($('opacity').value),
    });
    const verts = state.result.verts.map(gv => state.view === 'rest' ? gv.rest : gv.deformed);
    TCScene.setHighlightVerts(state.ctx, verts);
  }

  function exportCurrent(mode) {
    const target = state.lastGood || state.result;
    if (!target) { setStatus('尚无结果可导出', 'warn'); return; }
    TCExport.download(target, mode, `tetra-fragments-${mode}.json`);
    setStatus(`已导出 ${mode} 姿态碎片（${target.fragments.length} 块）`, 'ok');
  }

  global.TCApp = { init, state, runWorker };
  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
