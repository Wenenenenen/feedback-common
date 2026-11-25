/* app.js — 页面控制器：加载、参数、编辑、撤销重做、视图联动。 */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let rawData = null;   // 当前导入的原始数据
  let st = null;        // 引擎状态
  let sliceView = null;
  let view3d = null;
  let pendingEdit = 'CARVE';
  let activeTab = 'slice';

  const opts = {
    colorByMaterial: true,
    showSurface: true, showSolid: true, showCavity: true,
  };

  /* ---------- 提示 ---------- */
  function toast(title, errors, kind = 'error') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<div><b>${title}</b></div>`;
    if (errors && errors.length) {
      const ul = document.createElement('ul');
      errors.slice(0, 30).forEach((e) => {
        const li = document.createElement('li');
        li.textContent = (e.field ? e.field + '：' : '') + e.message;
        ul.appendChild(li);
      });
      el.appendChild(ul);
      if (errors.length > 30) {
        const more = document.createElement('div');
        more.className = 'small';
        more.textContent = `…其余 ${errors.length - 30} 条略`;
        el.appendChild(more);
      }
    }
    $('toastWrap').appendChild(el);
    setTimeout(() => el.remove(), 9000);
  }

  /* ---------- 加载 ---------- */
  function loadData(data, { fromFile = false } = {}) {
    const res = VF.validateInput(data);
    if (!res.ok) {
      toast('输入非法，已拒绝并保留当前有效结果', res.errors);
      return false;
    }
    rawData = JSON.parse(JSON.stringify(data));
    st = VF.createEngineState(rawData);
    const t0 = performance.now();
    VF.fullRebuild(st);
    st.timings.loadMs = performance.now() - t0;
    syncParamUI();
    renderGroups();
    refreshAll();
    toast(`已加载 ${rawData.meshId}（${rawData.triangles.length} 面 / ${st.total} 体素）`, null, 'ok');
    return true;
  }

  function syncParamUI() {
    $('selMode').value = st.mode;
    $('selFlood').value = String(st.flood);
    $('kvDims').textContent = `[${st.dims.join(', ')}]`;
    $('kvSpacing').textContent = `[${st.spacing.join(', ')}]`;
    $('kvOrigin').textContent = `[${st.origin.join(', ')}]`;
    const thin26 = st.mode === '6-separating' && st.flood === 26;
    $('modeHint').innerHTML = thin26
      ? '⚠ 薄壳 + 26 连通漫水：将定位所有对角漏孔（6 连通下封闭、26 连通下被对角穿透的体素对）。'
      : '切换参数后全量重算；编辑操作按 8×8×8 分块增量更新。';
  }

  /* ---------- 分组 ---------- */
  function renderGroups() {
    const map = new Map();
    st.tris.forEach((t) => {
      if (!map.has(t.group)) map.set(t.group, { count: 0, enabled: 0 });
      const g = map.get(t.group);
      g.count++;
      if (t.enabled) g.enabled++;
    });
    const box = $('groupList');
    box.innerHTML = '';
    [...map.keys()].sort().forEach((name) => {
      const g = map.get(name);
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = g.enabled === g.count;
      cb.addEventListener('change', () => {
        const r = VF.toggleGroup(st, name);
        if (!r.ok) { toast('分组启停失败', [{ field: 'group', message: r.error }]); cb.checked = !cb.checked; return; }
        refreshAll();
        toast(`分组 ${name} 已${r.enabled ? '启用' : '停用'}（增量分块重算）`, null, 'ok');
      });
      const n = document.createElement('span'); n.className = 'gname'; n.textContent = name;
      const c = document.createElement('span'); c.className = 'gcount'; c.textContent = `${g.enabled}/${g.count}`;
      lab.append(cb, n, c);
      if (g.enabled === 0) lab.classList.add('toggle-off');
      box.appendChild(lab);
    });
  }

  /* ---------- 统计 / 表格 ---------- */
  function renderStats() {
    const s = st.stats;
    const rows = [
      ['SURFACE', s.counts.SURFACE], ['EXTERIOR', s.counts.EXTERIOR],
      ['SOLID_INTERIOR', s.counts.SOLID_INTERIOR], ['EMPTY_CAVITY', s.counts.EMPTY_CAVITY],
    ];
    let html = rows.map(([k, v]) => `<span class="muted">${k}</span><b>${v}</b>`).join('');
    const mats = Object.entries(s.materialHistogram).sort((a, b) => +a[0] - +b[0]);
    if (mats.length) html += `<span class="muted">材质分布</span><b>${mats.map(([m, n]) => `M${m}:${n}`).join('，')}</b>`;
    html += `<span class="muted">对角漏孔</span><b style="color:${st.leaks.length ? 'var(--leak)' : 'var(--accent2)'}">${st.leaks.length}</b>`;
    html += `<span class="muted">封闭分量</span><b>${st.components.length}</b>`;
    $('statsBox').innerHTML = html;
    $('timingBox').textContent =
      `体素化 ${st.timings.voxelizeMs.toFixed(1)} ms · 分类 ${st.timings.classifyMs.toFixed(1)} ms · 总计 ${st.timings.totalMs.toFixed(1)} ms`;
    $('editStack').textContent = `操作栈：可撤销 ${st.history.length} / 可重做 ${st.redo.length}`;
  }

  function renderCompTables() {
    const ct = $('compTable');
    ct.innerHTML = '<tr><th>id</th><th>类型</th><th>体素数</th><th>代表体素</th><th>绕数 W</th></tr>' +
      st.components.map((c) => `<tr>
        <td>${c.componentId}</td>
        <td style="color:${c.type === 'SOLID_INTERIOR' ? 'var(--solid)' : 'var(--cavity)'}">${c.type}</td>
        <td>${c.voxelCount}</td>
        <td>[${c.representativeVoxel.join(', ')}]</td>
        <td>${c.windingNumber.toFixed(6)}</td></tr>`).join('') ||
      '<tr><td class="muted">无封闭分量</td></tr>';

    const ls = $('leakSummary');
    if (!(st.mode === '6-separating' && st.flood === 26)) {
      ls.innerHTML = '<span class="muted">仅 6 分离薄壳 + 26 连通漫水时计算对角漏孔。</span>';
      $('leakTable').innerHTML = '';
      return;
    }
    ls.textContent = `共 ${st.leaks.length} 对（按 fromExterior、toEnclosed 字典序）`;
    const rows = st.leaks.slice(0, 500);
    $('leakTable').innerHTML = '<tr><th>#</th><th>fromExterior (E6)</th><th>toEnclosed (I6)</th></tr>' +
      rows.map((p, i) => `<tr><td>${i}</td><td>[${p.fromExterior.join(', ')}]</td><td>[${p.toEnclosed.join(', ')}]</td></tr>`).join('') +
      (st.leaks.length > 500 ? `<tr><td colspan="3" class="muted">…仅显示前 500 对，完整列表见导出 JSON</td></tr>` : '');
  }

  /* ---------- 视图 ---------- */
  function refreshAll() {
    renderStats();
    renderCompTables();
    renderGroups();
    if (sliceView) {
      sliceView.slice = Math.min(sliceView.slice, sliceView.maxSlice());
      $('sliceRange').max = sliceView.maxSlice();
      $('sliceRange').value = sliceView.slice;
      updateSliceLabel();
      sliceView.draw();
    }
    if (view3d) view3d.draw();
    $('renderMode').textContent = view3d ? view3d.lastMode : '';
  }

  function updateSliceLabel() {
    const axName = ['x', 'y', 'z'][sliceView.axis];
    $('sliceLabel').textContent = `${axName} = ${sliceView.slice} / ${sliceView.maxSlice()}`;
    $('sliceHud').textContent =
      `切片平面：固定 ${axName.toUpperCase()}=${sliceView.slice}　左键拖拽框选 → ${pendingEdit === 'CARVE' ? '挖空' : '填充'}`;
  }

  function initViews() {
    const sc = $('sliceCanvas');
    sliceView = new VF.SliceView(sc, () => ({ st, opts }));
    sliceView.onBoxSelect = (b) => {
      const r = pendingEdit === 'CARVE'
        ? VF.boxEdit(st, 'BOX_CARVE', b)
        : VF.boxEdit(st, 'BOX_FILL', b, +$('fillMaterial').value);
      if (!r.ok) { toast('框选编辑被拒绝', [{ field: 'box', message: r.error }]); return; }
      refreshAll();
      toast(`框选${pendingEdit === 'CARVE' ? '挖空' : '填充'} [${b.join(', ')}]（8³ 分块增量）`, null, 'ok');
    };
    sc.addEventListener('pointermove', () => {
      const info = sliceView.infoAt();
      const el = $('sliceInfo');
      if (!info) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = `体素 [${info.coord.join(', ')}] · <b>${info.cls}</b>` +
        (info.material >= 0 ? ` · 材质 M${info.material}` : '') +
        (info.triId >= 0 ? ` · 来源面 #${info.triId}` : '') +
        (info.d2 !== null ? ` · d²=${info.d2.toExponential(3)}` : '');
    });

    view3d = new VF.View3D($('canvas3d'), () => ({ st, opts }));
    view3d.showWire = $('chkWire').checked;
    view3d.showLeaks = $('chkLeak').checked;

    $('sliceRange').max = sliceView.maxSlice();
    $('sliceRange').value = 0;
    updateSliceLabel();
    requestAnimationFrame(() => sliceView.draw());
  }

  /* ---------- 事件 ---------- */
  function bind() {
    // 样例
    const sel = $('sampleSelect');
    Object.keys(window.VF_SAMPLES).forEach((id) => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => loadData(window.VF_SAMPLES[sel.value]));
    $('btnLoad').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        let data;
        try { data = JSON.parse(reader.result); }
        catch (e) { toast('JSON 解析失败', [{ field: 'file', message: e.message }]); return; }
        loadData(data, { fromFile: true });
      };
      reader.readAsText(f);
      ev.target.value = '';
    });

    $('btnExport').addEventListener('click', () => {
      if (!st) return;
      const blob = new Blob([JSON.stringify(VF.exportJSON(st), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${st.meshId || 'voxel'}_export.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('selMode').addEventListener('change', () => {
      st.mode = $('selMode').value;
      VF.fullRebuild(st);
      syncParamUI(); refreshAll();
    });
    $('selFlood').addEventListener('change', () => {
      st.flood = +$('selFlood').value;
      VF.fullRebuild(st);
      syncParamUI(); refreshAll();
    });

    $('btnCarve').addEventListener('click', () => {
      pendingEdit = 'CARVE';
      $('btnCarve').classList.add('primary'); $('btnFill').classList.remove('primary');
      updateSliceLabel();
    });
    $('btnFill').addEventListener('click', () => {
      pendingEdit = 'FILL';
      $('btnFill').classList.add('primary'); $('btnCarve').classList.remove('primary');
      updateSliceLabel();
    });
    $('btnCarve').classList.add('primary');

    $('btnUndo').addEventListener('click', () => {
      const r = VF.undo(st);
      if (!r.ok) toast('无法撤销', [{ message: r.error }], 'warn');
      else { refreshAll(); toast(`已撤销：${r.label}`, null, 'ok'); }
    });
    $('btnRedo').addEventListener('click', () => {
      const r = VF.redo(st);
      if (!r.ok) toast('无法重做', [{ message: r.error }], 'warn');
      else { refreshAll(); toast(`已重做：${r.label}`, null, 'ok'); }
    });
    $('btnVerify').addEventListener('click', () => {
      const r = VF.verifyIncremental(st);
      if (r.ok) toast('一致性自检通过：增量结果与全量重算完全相同', null, 'ok');
      else toast(`自检发现 ${r.diffs} 个差异体素`, [{ message: '首个差异：' + JSON.stringify(r.first) }]);
      refreshAll();
    });

    document.querySelectorAll('[data-axis]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('[data-axis]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      sliceView.setAxis(+b.dataset.axis);
      $('sliceRange').max = sliceView.maxSlice();
      $('sliceRange').value = sliceView.slice;
      updateSliceLabel();
    }));
    $('sliceRange').addEventListener('input', () => {
      sliceView.setSlice(+$('sliceRange').value);
      updateSliceLabel();
    });

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      activeTab = b.dataset.tab;
      $('paneSlice').style.display = activeTab === 'slice' ? 'flex' : 'none';
      $('pane3d').style.display = activeTab === '3d' ? 'block' : 'none';
      $('paneComps').style.display = activeTab === 'comps' ? 'block' : 'none';
      if (activeTab === '3d') requestAnimationFrame(() => view3d.draw());
      if (activeTab === 'slice') requestAnimationFrame(() => sliceView.draw());
    }));

    $('chkMat').addEventListener('change', () => { opts.colorByMaterial = $('chkMat').checked; refreshAll(); });
    $('chkSurface3d').addEventListener('change', () => { opts.showSurface = $('chkSurface3d').checked; view3d.draw(); });
    $('chkSolid3d').addEventListener('change', () => { opts.showSolid = $('chkSolid3d').checked; view3d.draw(); });
    $('chkCavity3d').addEventListener('change', () => { opts.showCavity = $('chkCavity3d').checked; view3d.draw(); });
    $('chkWire').addEventListener('change', () => { view3d.showWire = $('chkWire').checked; view3d.draw(); });
    $('chkLeak').addEventListener('change', () => { view3d.showLeaks = $('chkLeak').checked; view3d.draw(); });

    window.addEventListener('resize', () => {
      if (sliceView) sliceView.draw();
      if (view3d) view3d.draw();
    });
  }

  /* ---------- 启动 ---------- */
  function start() {
    bind();
    const first = Object.keys(window.VF_SAMPLES)[0];
    $('sampleSelect').value = first;
    loadData(window.VF_SAMPLES[first]);   // 先建 st
    initViews();                          // 再初始化视图（依赖 st）
    $('sliceRange').max = sliceView.maxSlice();
    $('sliceRange').value = sliceView.slice;
    updateSliceLabel();
    requestAnimationFrame(() => sliceView.draw());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
