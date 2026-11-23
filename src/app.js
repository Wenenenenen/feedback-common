/*
 * 页面应用逻辑：状态管理、表单绑定、渲染调度、像素检查器、下载。
 * 依赖全局 ReliefMath / ReliefField / ReliefRay / ReliefRender（classic script）。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    doc: null,           // 完整样例文档
    field: null,
    camera: null,
    light: null,
    mode: 'lit',
    result: null,        // 最近一次渲染结果
    selected: null,      // 检查器当前对象 { kind, label, trace, shadow, pixel }
    activeCaseIndex: 0,
  };

  function setStatus(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function vecFromInputs(ids) {
    return ids.map((id) => Number($(id).value));
  }
  function fillVec(ids, v) {
    ids.forEach((id, k) => { $(id).value = roundInput(v[k]); });
  }
  function roundInput(x) {
    if (!Number.isFinite(x)) return '';
    // 保留足够精度，去掉浮点尾巴
    return Number(x.toPrecision(10)).toString();
  }

  // ---------- 表单 <-> 状态 ----------
  function cameraFromForm() {
    return {
      o: vecFromInputs(['camOx', 'camOy', 'camOz']),
      stepX: vecFromInputs(['camSxx', 'camSxy', 'camSxz']),
      stepY: vecFromInputs(['camSyx', 'camSyy', 'camSyz']),
      d: vecFromInputs(['camDx', 'camDy', 'camDz']),
      t: [Number($('camT0').value), Number($('camT1').value)],
      size: [Number($('camW').value), Number($('camH').value)],
    };
  }
  function lightFromForm() {
    return {
      d: vecFromInputs(['lightDx', 'lightDy', 'lightDz']),
      t: [Number($('lightT0').value), Number($('lightT1').value)],
    };
  }
  function fillCameraForm(cam) {
    fillVec(['camOx', 'camOy', 'camOz'], cam.o);
    fillVec(['camSxx', 'camSxy', 'camSxz'], cam.stepX);
    fillVec(['camSyx', 'camSyy', 'camSyz'], cam.stepY);
    fillVec(['camDx', 'camDy', 'camDz'], cam.d);
    $('camT0').value = roundInput(cam.t[0]);
    $('camT1').value = roundInput(cam.t[1]);
    $('camW').value = cam.size[0];
    $('camH').value = cam.size[1];
  }
  function fillLightForm(light) {
    fillVec(['lightDx', 'lightDy', 'lightDz'], light.d);
    $('lightT0').value = roundInput(light.t[0]);
    $('lightT1').value = roundInput(light.t[1]);
  }
  function fillFieldForm(field) {
    $('inSx').value = roundInput(field.sx);
    $('inSy').value = roundInput(field.sy);
    $('inHeight').value = field.height.map((row) => JSON.stringify(row)).join('\n');
  }

  function parseHeightText(text) {
    const t = text.trim();
    if (!t) throw new Error('高度数据为空');
    // 既支持完整二维 JSON，也支持每行一个数组
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v) && v.every((r) => Array.isArray(r))) return v;
      throw new Error('不是二维数组');
    } catch (e) {
      const rows = t.split(/\r?\n/).map((line) => JSON.parse(line.trim()));
      if (!rows.every((r) => Array.isArray(r))) throw new Error('每行必须是数组');
      return rows;
    }
  }

  // ---------- 渲染调度 ----------
  function render() {
    if (!state.field || !state.camera || !state.light) return;
    try {
      const t0 = performance.now();
      state.result = ReliefRender.render(state.field, state.camera, state.light);
      ReliefRender.shade(state.result, state.mode, state.camera, state.light);
      ReliefRender.drawToCanvas(state.result, $('view'), 4);
      const ms = (performance.now() - t0).toFixed(1);
      updateStageMeta(ms);
      setStatus(`渲染完成：${state.result.width}×${state.result.height}，用时 ${ms} ms`, 'ok');
      $('engineState').textContent =
        `${state.field.nx}×${state.field.ny} 节点 · 周期 ${fmt(state.field.periodX)}×${fmt(state.field.periodY)}`;
    } catch (e) {
      setStatus('渲染失败：' + e.message, 'err');
    }
  }

  function fmt(x) { return Number(x.toPrecision(6)); }

  function updateStageMeta(ms) {
    const r = state.result;
    let hits = 0, shadow = 0, tan = 0;
    for (const row of r.pixels) for (const p of row) {
      if (p.hit) {
        hits++;
        if (p.hit.tangent) tan++;
        if (p.shadow && p.shadow.shadowed) shadow++;
      }
    }
    $('metaSize').textContent = `${r.width}×${r.height}`;
    $('metaHits').textContent = `${hits}/${r.width * r.height}`;
    $('metaShadow').textContent = String(shadow);
    $('metaTan').textContent = String(tan);
    const [d0, d1] = r.depthRange;
    $('metaDepth').textContent = Number.isFinite(d0) ? `${fmt(d0)} … ${fmt(d1)}` : '无命中';
  }

  // ---------- 模式切换 ----------
  function setMode(mode) {
    state.mode = mode;
    for (const btn of document.querySelectorAll('.seg button')) {
      btn.classList.toggle('on', btn.dataset.mode === mode);
    }
    if (state.result) {
      ReliefRender.shade(state.result, mode, state.camera, state.light);
      ReliefRender.drawToCanvas(state.result, $('view'), 4);
    }
  }

  // ---------- 检查器渲染 ----------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fnum(x, d = 6) {
    if (x === undefined || x === null) return '—';
    if (!Number.isFinite(x)) return String(x);
    return Number(x.toPrecision(d)).toString();
  }
  function vecHtml(v) {
    return '[' + v.map((x) => fnum(x)).join(', ') + ']';
  }

  function rootStatusTag(rec) {
    if (rec.status === 'accepted') return '<span class="tag hit">采纳</span>';
    return '<span class="tag miss">拒绝</span>';
  }

  function traceHtml(trace) {
    const ray = trace.ray;
    let html = `<details open><summary>射线参数</summary><div class="body"><table>
      <tr><th>O</th><td class="mono">${vecHtml(ray.o)}</td></tr>
      <tr><th>D（原长度）</th><td class="mono">${vecHtml(ray.d)}　|D|=${fnum(Math.hypot(...ray.d))}</td></tr>
      <tr><th>t 闭区间</th><td class="mono">[${fnum(ray.t[0])}, ${fnum(ray.t[1])}]</td></tr>
      <tr><th>遍历格数</th><td>${trace.cells.length}　迭代 ${trace.iterations}</td></tr>
      </table></div></details>`;

    // 首命中摘要
    if (trace.hit) {
      const h = trace.hit;
      const kindTag = h.tangent ? '<span class="tag tan">切触</span>'
        : h.kind !== '格内' ? '<span class="tag edge">' + h.kind + '</span>' : '';
      html += `<details open><summary>首命中 <span class="tag hit">HIT</span> ${kindTag}</summary><div class="body"><table>
        <tr><th>t</th><td class="mono">${fnum(h.t)}</td></tr>
        <tr><th>命中点 P</th><td class="mono">${vecHtml(h.point)}</td></tr>
        <tr><th>世界格 (半开归属)</th><td class="mono">(${h.cell[0]}, ${h.cell[1]})</td></tr>
        <tr><th>节点格（周期回绕）</th><td class="mono">(${h.nodeCell[0]}, ${h.nodeCell[1]})　u=${fnum(h.u)}, v=${fnum(h.v)}</td></tr>
        <tr><th>梯度法线（朝上）</th><td class="mono">${vecHtml(h.normal)}</td></tr>
        <tr><th>选中原因</th><td>${esc(h.selectedReason)}</td></tr>
        <tr><th>重复登记</th><td>${h.duplicates.length ? h.duplicates.map((d) => `格(${d.cell.join(',')}) 的 ${d.kind} 记录`).join('；') : '无'}</td></tr>
        </table></div></details>`;
    } else {
      html += `<details open><summary>结果 <span class="tag miss">MISS</span></summary><div class="body">
        <p class="muted" style="margin:4px 0">${esc(trace.missReason || '无命中')}</p></div></details>`;
    }

    // 去重后的全部命中
    if (trace.hits.length > 1) {
      html += `<details><summary>全部命中（${trace.hits.length} 次，已按 t 去重）</summary><div class="body"><table>
        <tr><th>#</th><th>t</th><th>点</th><th>格</th><th>类型</th></tr>`;
      trace.hits.forEach((h, i) => {
        html += `<tr><td>${i}</td><td class="mono">${fnum(h.t)}</td><td class="mono">${vecHtml(h.point)}</td>
          <td class="mono">(${h.cell.join(',')})</td><td>${h.kind}${h.tangent ? '·切触' : ''}</td></tr>`;
      });
      html += '</table></div></details>';
    }

    // 逐格展开：二次方程、每个根与原因
    html += `<details><summary>逐格展开（${trace.cells.length} 格）</summary><div class="body">`;
    for (const c of trace.cells) {
      const q = c.quadratic;
      html += `<details><summary>格 (${c.cx}, ${c.cy}) · 节点(${c.nodeI},${c.nodeJ}) · t∈[${fnum(c.tEnter)}, ${isFinite(c.tLeave) ? fnum(c.tLeave) : '∞'}]</summary>
        <div class="body">
        <p class="mono muted" style="margin:4px 0">h−z = ${fnum(q.A)}t² + ${fnum(q.B)}t + ${fnum(q.C)}　判别式 Δ=${fnum(q.discriminant)}${q.tangent ? '（≈0 切触）' : ''}${q.degenerate ? '（退化）' : ''}</p>
        <table><tr><th>t</th><th>u,v</th><th>状态/原因</th></tr>`;
      if (!c.roots.length) {
        html += '<tr><td colspan="3" class="muted">无实根（未穿越本格曲面）</td></tr>';
      }
      for (const r of c.roots) {
        const cls = r.status === 'accepted' ? 'root-accept' : 'root-reject';
        html += `<tr class="${cls}"><td class="mono">${fnum(r.t)}${r.tangent ? ' 切' : ''}</td>
          <td class="mono">${r.u !== undefined ? fnum(r.u) + ', ' + fnum(r.v) : '—'}</td>
          <td>${rootStatusTag(r)} ${esc(r.reason)}</td></tr>`;
      }
      html += '</table></div></details>';
    }
    html += '</div></details>';
    return html;
  }

  function shadowHtml(shadow) {
    if (!shadow) return '';
    let html = `<details ${shadow.shadowed ? 'open' : ''}><summary>自阴影射线 <span class="tag ${shadow.shadowed ? 'miss' : 'hit'}">${shadow.shadowed ? '有遮挡' : '无遮挡'}</span></summary><div class="body">
      <p class="mono muted" style="margin:4px 0">阴影区间 t∈[${fnum(shadow.interval[0])}, ${fnum(shadow.interval[1])}]</p>`;
    if (shadow.blocker) {
      const b = shadow.blocker;
      html += `<table>
        <tr><th>遮挡 t</th><td class="mono">${fnum(b.t)}</td></tr>
        <tr><th>遮挡点</th><td class="mono">${vecHtml(b.point)}</td></tr>
        <tr><th>遮挡格</th><td class="mono">(${b.cell.join(',')})　${b.kind}${b.tangent ? '·切触' : ''}</td></tr>
        </table>`;
    }
    return html + '</div></details>';
  }

  function showInspect(label, trace, shadow, pixel) {
    state.selected = { kind: pixel ? 'pixel' : 'manual', label, trace, shadow, pixel };
    $('inspectWhat').textContent = label;
    $('inspectBody').innerHTML = traceHtml(trace) + shadowHtml(shadow);
  }

  // ---------- 画布点击取像素 ----------
  function onCanvasClick(e) {
    if (!state.result) return;
    const rect = $('view').getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) / rect.width * state.result.width);
    const py = Math.floor((e.clientY - rect.top) / rect.height * state.result.height);
    if (px < 0 || py < 0 || px >= state.result.width || py >= state.result.height) return;
    const p = state.result.pixels[py][px];
    showInspect(`像素 (${px}, ${py})`, p.trace, p.shadow, p);
  }

  // ---------- 手动射线 ----------
  function onManualTrace() {
    if (!state.field) { setStatus('请先载入高度场', 'err'); return; }
    try {
      const O = vecFromInputs(['rayOx', 'rayOy', 'rayOz']);
      const D = vecFromInputs(['rayDx', 'rayDy', 'rayDz']);
      const t0 = Number($('rayT0').value), t1 = Number($('rayT1').value);
      const trace = ReliefRay.traceRay(state.field, O, D, t0, t1);
      let shadow = null;
      if (trace.hit) {
        shadow = ReliefRay.shadowRay(state.field, trace.hit.point, state.light.d, state.light.t[0], state.light.t[1]);
      }
      showInspect('手动射线', trace, shadow, null);
      setStatus(trace.hit
        ? `命中 t=${fnum(trace.hit.t)}，点 ${vecHtml(trace.hit.point)}${trace.hit.tangent ? '（切触）' : ''}`
        : '未命中：' + (trace.missReason || ''), trace.hit ? 'ok' : 'err');
    } catch (e) {
      setStatus('手动射线失败：' + e.message, 'err');
    }
  }

  // ---------- 载入样例 / 文件 ----------
  function loadDoc(doc, sourceName) {
    try {
      if (!doc.camera || !doc.light || !Array.isArray(doc.cases) || !doc.cases.length) {
        throw new Error('文档需包含 camera、light、cases');
      }
      const c = doc.cases[state.activeCaseIndex] || doc.cases[0];
      state.doc = doc;
      state.field = new ReliefField.HeightField(c);
      state.camera = doc.camera;
      state.light = doc.light;

      fillFieldForm(state.field);
      fillCameraForm(state.camera);
      fillLightForm(state.light);
      $('fileMeta').textContent =
        `${sourceName} · 用例「${c.id}」· ${state.field.nx}×${state.field.ny} 节点 · ${doc.cases.length} 个用例`;

      // 手动射线预填该用例第一条
      if (Array.isArray(c.rays) && c.rays[0]) {
        const r = c.rays[0];
        fillVec(['rayOx', 'rayOy', 'rayOz'], r.o);
        fillVec(['rayDx', 'rayDy', 'rayDz'], r.d);
        $('rayT0').value = roundInput(r.t[0]);
        $('rayT1').value = roundInput(r.t[1]);
      }
      render();
    } catch (e) {
      setStatus('载入失败：' + e.message, 'err');
    }
  }

  async function loadSample() {
    // file:// 下浏览器禁止 fetch 本地文件，直接用内嵌样例脚本；
    // http(s) 下优先 fetch JSON（数据源单一），失败再回退内嵌
    if (location.protocol === 'file:') {
      if (window.RELIEF_SAMPLE_DOC) {
        loadDoc(window.RELIEF_SAMPLE_DOC, 'relief-crossing-cases.json（内嵌）');
        return;
      }
      setStatus('缺少内嵌样例，请用「导入文件」选择 samples 下的 JSON。', 'err');
      return;
    }
    try {
      const resp = await fetch('samples/relief-crossing-cases.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      loadDoc(await resp.json(), 'relief-crossing-cases.json');
    } catch (e) {
      if (window.RELIEF_SAMPLE_DOC) {
        loadDoc(window.RELIEF_SAMPLE_DOC, 'relief-crossing-cases.json（内嵌回退）');
      } else {
        setStatus('自动读取样例失败（' + e.message + '）。可用「导入文件」选择 samples 下的 JSON。', 'err');
      }
    }
  }

  // ---------- 下载 ----------
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function buildHitJson() {
    const r = state.result;
    const pixels = [];
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const p = r.pixels[y][x];
        const rec = { x, y, hit: !!p.hit };
        if (p.hit) {
          rec.t = p.hit.t;
          rec.point = p.hit.point;
          rec.cell = p.hit.cell;
          rec.nodeCell = p.hit.nodeCell;
          rec.uv = [p.hit.u, p.hit.v];
          rec.normal = p.hit.normal;
          rec.kind = p.hit.kind;
          rec.tangent = p.hit.tangent;
          rec.shadowed = !!(p.shadow && p.shadow.shadowed);
          if (p.shadow && p.shadow.blocker) rec.blockerT = p.shadow.blocker.t;
        } else {
          rec.missReason = p.trace.missReason;
        }
        pixels.push(rec);
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      mode: state.mode,
      camera: state.camera,
      light: state.light,
      field: {
        spacing: [state.field.sx, state.field.sy],
        nodes: [state.field.nx, state.field.ny],
        period: [state.field.periodX, state.field.periodY],
      },
      size: [r.width, r.height],
      stats: (() => {
        let hits = 0, shadow = 0, tangent = 0;
        for (const row of r.pixels) for (const p of row) if (p.hit) {
          hits++;
          if (p.hit.tangent) tangent++;
          if (p.shadow && p.shadow.shadowed) shadow++;
        }
        return { hits, shadow, tangent, depthRange: r.depthRange };
      })(),
      pixels,
    };
  }

  function onDownloadJson() {
    if (!state.result) { setStatus('没有可导出的渲染结果', 'err'); return; }
    const blob = new Blob([JSON.stringify(buildHitJson(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'relief-hits.json');
    setStatus('命中 JSON 已下载', 'ok');
  }

  function onDownloadPng() {
    if (!state.result) { setStatus('没有可导出的预览', 'err'); return; }
    $('view').toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `relief-${state.mode}.png`);
        setStatus('预览图已下载', 'ok');
      }
    }, 'image/png');
  }

  // ---------- 应用字段/相机/灯 ----------
  function onApplyField() {
    try {
      const height = parseHeightText($('inHeight').value);
      const spacing = [Number($('inSx').value), Number($('inSy').value)];
      state.field = new ReliefField.HeightField({ spacing, height });
      if (state.doc && state.doc.cases[state.activeCaseIndex]) {
        state.doc.cases[state.activeCaseIndex].height = height;
        state.doc.cases[state.activeCaseIndex].spacing = spacing;
      }
      render();
    } catch (e) {
      setStatus('高度场无效：' + e.message, 'err');
    }
  }
  function onApplyCamera() {
    const cam = cameraFromForm();
    const errors = ReliefRender.validateCamera(cam);
    if (errors.length) { setStatus('相机参数无效：' + errors.join('；'), 'err'); return; }
    state.camera = cam;
    if (state.doc) state.doc.camera = cam;
    render();
  }
  function onApplyLight() {
    const light = lightFromForm();
    if (!light.d.every(Number.isFinite) || !light.t.every(Number.isFinite) || light.t[1] < light.t[0]) {
      setStatus('灯参数无效', 'err'); return;
    }
    state.light = light;
    if (state.doc) state.doc.light = light;
    render();
  }

  // ---------- 绑定 ----------
  function bind() {
    $('btnLoadSample').addEventListener('click', loadSample);
    $('btnImportFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { loadDoc(JSON.parse(reader.result), file.name); }
        catch (err) { setStatus('JSON 解析失败：' + err.message, 'err'); }
      };
      reader.readAsText(file);
    });
    $('btnApplyField').addEventListener('click', onApplyField);
    $('btnApplyCam').addEventListener('click', onApplyCamera);
    $('btnApplyLight').addEventListener('click', onApplyLight);
    $('btnTrace').addEventListener('click', onManualTrace);
    $('btnDownloadJson').addEventListener('click', onDownloadJson);
    $('btnDownloadPng').addEventListener('click', onDownloadPng);
    $('view').addEventListener('click', onCanvasClick);
    for (const btn of document.querySelectorAll('.seg button')) {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    }
  }

  bind();
  loadSample();
})();
