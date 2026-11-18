/*
 * app.js — 页面逻辑：导入、细分级别、显示开关、拾取、统计、导出。
 */
(function () {
  'use strict';
  const CC = window.CC;
  const MAX_LEVEL = 3;

  // 状态
  let meshName = 'mesh';
  let baseMesh = null;          // validateMesh 的输出
  let levels = [];              // levels[i] = 第 i 级（懒计算）
  let currentLevel = 0;
  let warnings = [];

  const $ = id => document.getElementById(id);
  const canvas = $('view');
  const renderer = Renderer.create(canvas);

  // ---------------------------------------------------------- 网格载入
  function loadMeshData(data, name) {
    meshName = name;
    const res = CC.validateMesh(data);
    // 展示校验结果
    const box = $('messages');
    box.innerHTML = '';
    res.errors.forEach(e => box.appendChild(msgDiv('error', '✕ ' + e)));
    res.warnings.forEach(w => box.appendChild(msgDiv('warn', '⚠ ' + w)));
    if (!res.errors.length && !res.warnings.length) box.appendChild(msgDiv('ok', '✓ 校验通过'));
    if (!res.mesh) {
      baseMesh = null; levels = [];
      $('level-buttons').querySelectorAll('button').forEach(b => b.disabled = true);
      updateStats();
      return;
    }
    baseMesh = res.mesh;
    warnings = res.warnings;
    levels = [CC.buildLevel(baseMesh.positions, baseMesh.faces, baseMesh.edgeSharp)];
    $('level-buttons').querySelectorAll('button').forEach(b => b.disabled = false);
    selectLevel(Math.min(currentLevel, MAX_LEVEL));
    renderer.frame(baseMesh.positions);
  }

  function msgDiv(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    return d;
  }

  function ensureLevel(l) {
    while (levels.length <= l) levels.push(CC.subdivideLevel(levels[levels.length - 1]));
  }

  function selectLevel(l) {
    if (!baseMesh) return;
    currentLevel = l;
    ensureLevel(l);
    const lv = levels[l];
    renderer.setSurface(lv.positions, lv.faces);
    if (l === 0) renderer.clearControl();
    else renderer.setControl(levels[0].positions, levels[0].faces);
    renderer.setSelected(null);
    $('vertex-info').innerHTML = '<p class="dim">点击网格顶点查看其计算规则</p>';
    $('level-buttons').querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.level) === l));
    updateStats();
  }

  // ---------------------------------------------------------- 统计
  function updateStats() {
    const tbl = $('stats-table');
    tbl.innerHTML = '<tr><th>级别</th><th>面数</th><th>顶点数</th><th>边数</th><th>边界边</th><th>折痕边</th><th>欧拉数</th></tr>';
    if (!baseMesh) { tbl.innerHTML += '<tr><td colspan="7" class="dim">未导入网格</td></tr>'; $('nonmanifold').innerHTML = ''; return; }
    for (let l = 0; l <= MAX_LEVEL; l++) {
      const tr = document.createElement('tr');
      if (l < levels.length) {
        const s = CC.levelStats(levels[l]);
        tr.innerHTML = `<td>L${l}${l === 0 ? '（控制网格）' : ''}</td><td>${s.faces}</td><td>${s.vertices}</td><td>${s.edges}</td><td>${s.boundaryEdges}</td><td>${s.creaseEdges}</td><td>${s.euler}</td>`;
      } else {
        tr.innerHTML = `<td>L${l}</td><td colspan="6" class="dim">未计算</td>`;
      }
      if (l === currentLevel) tr.classList.add('active');
      tbl.appendChild(tr);
    }
    // 非流形边报告（基于当前已计算的最高级，非流形会随细分保留）
    const box = $('nonmanifold');
    box.innerHTML = '';
    const s = CC.levelStats(levels[levels.length - 1]);
    if (s.nonManifoldEdges.length === 0) {
      box.appendChild(msgDiv('ok', '✓ 未发现非流形边'));
    } else {
      box.appendChild(msgDiv('error', `✕ 非流形边 ${s.nonManifoldEdges.length} 条（被 3 个及以上面共用）：`));
      const ul = document.createElement('ul');
      s.nonManifoldEdges.forEach(e => {
        const li = document.createElement('li');
        li.textContent = `边 [${e.edge[0]}, ${e.edge[1]}] — ${e.faceCount} 个面共用`;
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
  }

  // ---------------------------------------------------------- 拾取
  canvas.addEventListener('click', e => {
    if (!renderer.wasClick() || !baseMesh) return;
    const lv = levels[currentLevel];
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    let best = -1, bestD = 14; // 像素阈值
    lv.positions.forEach((p, i) => {
      const s = renderer.project(p);
      if (!s) return;
      const d = Math.hypot(s[0] - cx, s[1] - cy);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    renderer.setSelected(lv.positions[best]);
    showVertexInfo(lv, best);
  });

  const RULE_NAMES = { smooth: '平滑规则', crease: '折痕规则', corner: '角点规则', boundary: '边界规则', blend: '混合规则', original: '原始顶点' };
  const TYPE_NAMES = { face: '面点', edge: '边点', vertex: '顶点' };

  function showVertexInfo(lv, idx) {
    const p = lv.positions[idx];
    const prov = lv.provenance ? lv.provenance[idx] : { type: 'vertex', rule: 'original', source: { vertex: idx }, note: '控制网格原始顶点' };
    const src = prov.source || {};
    let srcHtml = '';
    if (prov.type === 'face') srcHtml = `<tr><td>来源面</td><td>控制面 #${src.face}（${src.arity} 边形）</td></tr>`;
    if (prov.type === 'edge') srcHtml = `<tr><td>来源边</td><td>[${src.edge[0]}, ${src.edge[1]}]，锐度 ${src.sharpness}，${src.faceCount} 个面共用</td></tr>`;
    if (prov.type === 'vertex' && src.vertex !== undefined) {
      srcHtml = `<tr><td>来源顶点</td><td>#${src.vertex}${src.valence ? `，价数 ${src.valence}` : ''}${src.creaseCount !== undefined ? `，折痕边 ${src.creaseCount} 条` : ''}${src.sharpness !== undefined ? `，顶点锐度 ${Number(src.sharpness.toFixed(4))}` : ''}</td></tr>`;
      if (src.boundaryNeighbors) srcHtml += `<tr><td>边界邻居</td><td>[${src.boundaryNeighbors.join(', ')}]</td></tr>`;
    }
    $('vertex-info').innerHTML = `
      <table>
        <tr><td>顶点索引</td><td>#${idx}</td></tr>
        <tr><td>位置</td><td>(${p.map(v => Number(v.toFixed(5))).join(', ')})</td></tr>
        <tr><td>来源类型</td><td>${TYPE_NAMES[prov.type] || prov.type}</td></tr>
        <tr><td>计算规则</td><td><span class="rule rule-${prov.rule}">${RULE_NAMES[prov.rule] || prov.rule}</span></td></tr>
        ${srcHtml}
        ${prov.note ? `<tr><td>说明</td><td>${prov.note}</td></tr>` : ''}
      </table>`;
  }

  // ---------------------------------------------------------- 导出
  function download(filename, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $('export-obj').addEventListener('click', () => {
    if (!baseMesh) return;
    download(`${meshName.replace(/\.json$/, '')}-L${currentLevel}.obj`, CC.exportOBJ(levels[currentLevel], meshName));
  });
  $('export-json').addEventListener('click', () => {
    if (!baseMesh) return;
    download(`${meshName.replace(/\.json$/, '')}-L${currentLevel}-provenance.json`,
      CC.exportProvenance(levels[currentLevel], currentLevel, meshName), 'application/json');
  });

  // ---------------------------------------------------------- 控件
  $('level-buttons').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => selectLevel(Number(b.dataset.level))));

  const opt = (id, key) => $(id).addEventListener('change', e => renderer.setOption(key, e.target.checked));
  opt('opt-shaded', 'shaded');
  opt('opt-wireframe', 'wireframe');
  opt('opt-control', 'showControl');
  opt('opt-control-top', 'controlOnTop');

  // 文件导入
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { loadMeshData(JSON.parse(reader.result), f.name); }
      catch (err) {
        $('messages').innerHTML = '';
        $('messages').appendChild(msgDiv('error', '✕ JSON 解析失败：' + err.message));
      }
    };
    reader.readAsText(f);
  });

  // 拖拽导入
  const drop = $('drop-zone');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { loadMeshData(JSON.parse(reader.result), f.name); }
      catch (err) {
        $('messages').innerHTML = '';
        $('messages').appendChild(msgDiv('error', '✕ JSON 解析失败：' + err.message));
      }
    };
    reader.readAsText(f);
  });

  // 内置样例
  const sel = $('example-select');
  Object.keys(window.EXAMPLES || {}).forEach(name => {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    if (sel.value && window.EXAMPLES[sel.value]) loadMeshData(window.EXAMPLES[sel.value], sel.value + '.json');
  });

  // 初始载入第一个样例
  const first = Object.keys(window.EXAMPLES || {})[0];
  if (first) { sel.value = first; loadMeshData(window.EXAMPLES[first], first + '.json'); }
})();
