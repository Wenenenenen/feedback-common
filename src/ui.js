// 争地地图版本校验台 —— DOM 绑定与画布渲染
'use strict';

(function () {
  const App = window.FrontierApp;
  const $ = (id) => document.getElementById(id);
  // id（kebab）-> 代码里使用的 camelCase 键，统一在此对齐
  const idMap = {
    theme: 'theme', drop: 'drop', file: 'file', 'load-sample': 'loadSample',
    'project-meta': 'projectMeta', errors: 'errors', workspace: 'workspace',
    map: 'map', 'map-ver': 'mapVer', legend: 'legend', 'zoom-in': 'zoomIn',
    'zoom-out': 'zoomOut', 'zoom-fit': 'zoomFit', tree: 'tree',
    'version-count': 'versionCount', 'edit-value': 'editValue', 'do-edit': 'doEdit',
    'cell-empty': 'cellEmpty', 'cell-info': 'cellInfo', 'cell-kv': 'cellKv',
    'add-query-here': 'addQueryHere', 'trace-enclave': 'traceEnclave', trace: 'trace',
    'query-count': 'queryCount', 'run-batch': 'runBatch', 'export-json': 'exportJson',
    'clear-queries': 'clearQueries', 'query-table': 'queryTable', toast: 'toast',
  };
  const els = {};
  for (const [id, key] of Object.entries(idMap)) els[key] = $(id);

  // -------------------------------------------------------------------------
  // 主题
  // -------------------------------------------------------------------------
  function applyTheme(t) {
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('frontier-theme', t); } catch { /* 忽略 */ }
    if (App.state.project) render();
  }
  let savedTheme = 'system';
  try { savedTheme = localStorage.getItem('frontier-theme') || 'system'; } catch { /* 忽略 */ }
  els.theme.value = savedTheme;
  applyTheme(savedTheme);
  els.theme.addEventListener('change', () => applyTheme(els.theme.value));

  // -------------------------------------------------------------------------
  // 通用提示
  // -------------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  // -------------------------------------------------------------------------
  // 导入（无效导入保留当前项目）
  // -------------------------------------------------------------------------
  function showErrors(errors) {
    els.errors.innerHTML = '<strong>导入失败，当前项目保持不变：</strong><ul>' +
      errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
    els.errors.classList.remove('hidden');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ingest(text, fileName) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      showErrors(['JSON 解析失败：' + err.message]);
      return;
    }
    const result = App.loadProject(parsed, fileName);
    if (!result.ok) {
      showErrors(result.errors);
      return;
    }
    els.errors.classList.add('hidden');
    els.workspace.classList.remove('hidden');
    lastResults = null;
    els.exportJson.disabled = true;
    render();
    toast('导入成功');
  }

  els.file.addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => ingest(reader.result, f.name);
    reader.readAsText(f);
  });
  els.drop.addEventListener('click', () => els.file.click());
  ['dragover', 'dragenter'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
    e.preventDefault(); els.drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
    e.preventDefault(); els.drop.classList.remove('drag');
  }));
  els.drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => ingest(reader.result, f.name);
    reader.readAsText(f);
  });

  // 内置样例（与 samples/frontier-versions.json 一致）
  const SAMPLE = {
    rows: ['AAAA', 'A..A', 'ABBA', 'AAAA'],
    edits: [
      { parent: 0, x: 1, y: 0, value: '.' },
      { parent: 0, x: 1, y: 2, value: 'A' },
    ],
    queries: [
      { version: 0, x: 1, y: 1 },
      { version: 1, x: 1, y: 1 },
    ],
  };
  els.loadSample.addEventListener('click', () => ingest(JSON.stringify(SAMPLE), 'sample'));

  // -------------------------------------------------------------------------
  // 画布
  // -------------------------------------------------------------------------
  const canvas = els.map;
  const ctx = canvas.getContext('2d');
  let cellPx = 16;
  let hoverCell = null;

  function cellColor(code) {
    const { palette, codeToChar } = App.state;
    if (code === 0) {
      return getComputedStyle(document.documentElement).getPropertyValue('--empty').trim() || '#eef0f3';
    }
    const ch = codeToChar[code];
    const c = palette.get(ch);
    if (!c) return '#888';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? c.dark : c.light;
  }

  function drawMap() {
    const { w, h } = App.dims();
    const grid = App.gridAt(App.state.currentVersion);
    const hl = App.state.highlightCells;
    const hlSet = hl ? new Set(hl) : null;
    cellPx = Math.max(2, Math.floor(cellPx));
    canvas.width = w * cellPx;
    canvas.height = h * cellPx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        ctx.fillStyle = cellColor(grid[idx]);
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
    // 高亮整块
    if (hlSet) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--hl').trim() || '#ffcf3f';
      ctx.globalAlpha = 0.55;
      for (const idx of hlSet) {
        const x = idx % w, y = (idx - x) / w;
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
      ctx.globalAlpha = 1;
    }
    // 选中框 + 悬停框
    const sel = App.state.selectedCell;
    if (sel) drawOutline(sel.x, sel.y, '#111', 2);
    if (hoverCell && (!sel || hoverCell.x !== sel.x || hoverCell.y !== sel.y)) {
      drawOutline(hoverCell.x, hoverCell.y, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), 1.5);
    }
    // 网格线（放大时）
    if (cellPx >= 8) {
      ctx.strokeStyle = 'rgba(128,128,128,.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) { ctx.moveTo(x * cellPx + .5, 0); ctx.lineTo(x * cellPx + .5, h * cellPx); }
      for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * cellPx + .5); ctx.lineTo(w * cellPx, y * cellPx + .5); }
      ctx.stroke();
    }
  }

  function drawOutline(x, y, color, lw) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(x * cellPx + 1, y * cellPx + 1, cellPx - 2, cellPx - 2);
  }

  function eventCell(ev) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = App.dims();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const x = Math.floor(px / cellPx);
    const y = Math.floor(py / cellPx);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return { x, y };
  }

  canvas.addEventListener('click', (ev) => {
    const c = eventCell(ev);
    if (!c) return;
    const info = App.inspectCell(c.x, c.y);
    renderCellInfo(c, info);
    drawMap();
  });
  canvas.addEventListener('mousemove', (ev) => {
    const c = eventCell(ev);
    if ((c && (!hoverCell || c.x !== hoverCell.x || c.y !== hoverCell.y)) || (!c && hoverCell)) {
      hoverCell = c;
      drawMap();
    }
  });
  canvas.addEventListener('mouseleave', () => { hoverCell = null; drawMap(); });

  els.zoomIn.addEventListener('click', () => { cellPx = Math.min(64, cellPx * 1.4); drawMap(); });
  els.zoomOut.addEventListener('click', () => { cellPx = Math.max(2, cellPx / 1.4); drawMap(); });
  els.zoomFit.addEventListener('click', () => {
    const wrap = canvas.parentElement.getBoundingClientRect().width;
    const { w, h } = App.dims();
    cellPx = Math.max(2, Math.floor(Math.min(wrap / w, 520 / h)));
    drawMap();
  });

  // -------------------------------------------------------------------------
  // 图例
  // -------------------------------------------------------------------------
  function renderLegend() {
    const { palette } = App.state;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    let html = '<span class="chip"><span class="swatch" style="background:var(--empty)"></span>. 空地</span>';
    for (const [ch, c] of palette) {
      html += `<span class="chip"><span class="swatch" style="background:${dark ? c.dark : c.light}"></span>${escapeHtml(ch)}</span>`;
    }
    els.legend.innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // 版本树
  // -------------------------------------------------------------------------
  function renderTree() {
    const p = App.state.project;
    els.versionCount.textContent = p.edits.length + 1;
    const children = App.versionTree();
    // DFS 展开，缩进体现层级
    const lines = [];
    (function walk(v, depth) {
      const edit = v > 0 ? p.edits[v - 1] : null;
      const editTxt = edit ? `(${edit.x},${edit.y})→${edit.value} ←v${edit.parent}` : '底图';
      lines.push(`<div class="tree-item ${v === App.state.currentVersion ? 'active' : ''}" data-v="${v}"
        style="padding-left:${9 + depth * 14}px">
        <span class="ver">v${v}</span><span class="edit">${escapeHtml(editTxt)}</span></div>`);
      for (const c of children[v]) walk(c, depth + 1);
    })(0, 0);
    els.tree.innerHTML = lines.join('');
    els.tree.querySelectorAll('.tree-item').forEach((item) => {
      item.addEventListener('click', () => {
        App.state.currentVersion = Number(item.dataset.v);
        App.state.selectedCell = null;
        App.state.highlightCells = null;
        els.cellInfo.classList.add('hidden');
        els.cellEmpty.classList.remove('hidden');
        els.trace.classList.add('hidden');
        render();
      });
    });
    // 滚动到当前版本
    const active = els.tree.querySelector('.tree-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------
  // 单元格详情
  // -------------------------------------------------------------------------
  function renderCellInfo(c, info) {
    els.cellEmpty.classList.add('hidden');
    els.cellInfo.classList.remove('hidden');
    els.trace.classList.add('hidden');
    const { codeToChar } = App.state;
    let html = `<dt>坐标</dt><dd>(${c.x}, ${c.y})</dd>`;
    if (info.isEmpty) {
      const owner = info.ownerCodes.size === 0 ? null :
        (info.ownerCodes.size === 1 ? codeToChar[[...info.ownerCodes][0]] : '多方（无主）');
      html += `<dt>类型</dt><dd>空地</dd>
        <dt>面积</dt><dd>${info.area}</dd>
        <dt>贴地图外边</dt><dd>${info.touchesBoundary ? '是' : '否'}</dd>
        <dt>飞地</dt><dd>${info.enclave ? '<span class="tag bad">是（整块不接外边）</span>' : '<span class="tag good">否</span>'}</dd>
        <dt>归属</dt><dd>${owner === null ? '<span class="tag">无主（无共边阵营）</span>' : owner === '多方（无主）' ? '<span class="tag warn">多方（无主）</span>' : `<span class="tag good">${escapeHtml(owner)}</span>`}</dd>`;
    } else {
      html += `<dt>类型</dt><dd>阵营 ${escapeHtml(info.value)}</dd>
        <dt>面积</dt><dd>${info.area}</dd>
        <dt>周长</dt><dd>${info.perimeter}</dd>`;
    }
    els.cellKv.innerHTML = html;
  }

  els.addQueryHere.addEventListener('click', () => {
    const sel = App.state.selectedCell;
    if (!sel) return;
    App.addQuery({ version: App.state.currentVersion, x: sel.x, y: sel.y });
    renderQueryTable();
    toast('已加入批查询');
  });

  els.traceEnclave.addEventListener('click', () => {
    const sel = App.state.selectedCell;
    if (!sel) return;
    const { trace, becameEnclaveAt, truncated, checked } = App.traceEnclave(sel.x, sel.y);
    let html = `<div class="muted small" style="margin-bottom:6px">沿祖先链回退（检查 ${checked} 个该格为空地的版本，遇首个非飞地即停）：</div>`;
    for (const rec of trace) {
      if (rec.status === 'not-empty') continue;
      const editTxt = rec.edit ? `改格 (${rec.edit.x},${rec.edit.y})→${escapeHtml(rec.edit.value)}` : '底图';
      html += `<div class="trace-line">v${rec.version} · 面积 ${rec.area} · ${editTxt}
        <span class="flag ${rec.enclave ? 'tag bad' : 'tag good'}">${rec.enclave ? '飞地' : '非飞地'}</span></div>`;
    }
    if (becameEnclaveAt !== null) {
      html += `<div class="small" style="margin-top:8px">当前这段飞地始于 <strong class="mono">v${becameEnclaveAt}</strong>，对应改格即封死出口的那次操作。</div>`;
    } else {
      html += '<div class="small" style="margin-top:8px">检查范围内该分量未形成飞地。</div>';
    }
    if (truncated) {
      html += '<div class="small tag warn" style="margin-top:6px">祖先链过长，仅展示最近 600 个相关版本；更早成因未纳入。</div>';
    }
    els.trace.innerHTML = html;
    els.trace.classList.remove('hidden');
  });

  // -------------------------------------------------------------------------
  // 改格
  // -------------------------------------------------------------------------
  function renderEditValues() {
    const { codeToChar } = App.state;
    let html = '';
    for (let code = 0; code < codeToChar.length; code++) {
      if (code === 0) html += '<option value=".">. （空地）</option>';
      else html += `<option value="${escapeHtml(codeToChar[code])}">${escapeHtml(codeToChar[code])}</option>`;
    }
    els.editValue.innerHTML = html;
  }

  els.doEdit.addEventListener('click', () => {
    const sel = App.state.selectedCell;
    if (!sel) { toast('请先在地图上点选一格'); return; }
    const value = els.editValue.value;
    const nv = App.editCell(sel.x, sel.y, value);
    renderEditValues();
    render();
    toast(`已生成 v${nv}`);
  });

  // -------------------------------------------------------------------------
  // 批查询表
  // -------------------------------------------------------------------------
  let lastResults = null;

  function renderQueryTable() {
    const tbody = els.queryTable.querySelector('tbody');
    const qd = App.state.queryDraft;
    els.queryCount.textContent = qd.length;
    let html = '';
    for (let i = 0; i < qd.length; i++) {
      const q = qd[i];
      const r = lastResults && lastResults[i];
      html += `<tr>
        <td class="num">${i + 1}</td>
        <td class="num">${q.version}</td>
        <td class="num">${q.x}</td>
        <td class="num">${q.y}</td>
        <td>${r ? (r.type === 'empty' ? '<span class="pill empty">空地</span>' : `<span class="pill terr">${escapeHtml(r.faction)}</span>`) : '—'}</td>
        <td class="num">${r ? r.area : '—'}</td>
        <td class="num">${r && r.type === 'territory' ? r.perimeter : '—'}</td>
        <td class="num">${r && r.type === 'empty' ? (r.enclave ? '是' : '否') : '—'}</td>
        <td class="num">${r && r.type === 'empty' ? (r.owner ? escapeHtml(r.owner) : '无主') : '—'}</td>
        <td><button class="ghost small" data-del="${i}">删</button></td>
      </tr>`;
    }
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        App.removeQuery(Number(btn.dataset.del));
        lastResults = null;
        els.exportJson.disabled = true;
        renderQueryTable();
      });
    });
  }

  els.runBatch.addEventListener('click', () => {
    if (App.state.queryDraft.length === 0) { toast('没有查询'); return; }
    const out = App.runQueries();
    if (!out.ok) { showErrors(out.errors); return; }
    lastResults = out.results;
    els.exportJson.disabled = false;
    renderQueryTable();
    toast(`完成 ${out.results.length} 条查询`);
  });

  els.clearQueries.addEventListener('click', () => {
    App.state.queryDraft.length = 0;
    lastResults = null;
    els.exportJson.disabled = true;
    renderQueryTable();
  });

  // 导出结果 JSON（按提交顺序）。普通浏览器走文件下载；
  // 受限沙箱拦截下载时依次回退到剪贴板、新标签可拷贝文本。
  els.exportJson.addEventListener('click', async () => {
    if (!lastResults) return;
    const payload = JSON.stringify(lastResults, null, 2);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `frontier-results-${stamp}.json`;
    // 1) 标准下载
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('结果 JSON 已开始下载');
      return;
    } catch { /* 落到回退 */ }
    // 2) 剪贴板
    try {
      await navigator.clipboard.writeText(payload);
      toast('下载被拦截，结果 JSON 已复制到剪贴板');
      return;
    } catch { /* 继续回退 */ }
    // 3) 新标签展示
    const w = window.open('', '_blank');
    if (w) { w.document.body.innerText = payload; toast('已在新标签打开，可全选复制'); }
    else toast('导出失败，请检查浏览器权限');
  });

  // -------------------------------------------------------------------------
  // 总渲染
  // -------------------------------------------------------------------------
  function render() {
    const p = App.state.project;
    if (!p) return;
    const { w, h } = App.dims();
    els.projectMeta.textContent =
      `${App.state.fileName || '未命名'} · ${w}×${h} 格 · ${p.edits.length} 改格 · ${p.edits.length + 1} 版本 · ${p.queries.length} 导入查询`;
    els.mapVer.textContent = `· 当前 v${App.state.currentVersion}`;
    renderLegend();
    renderTree();
    renderEditValues();
    renderQueryTable();
    drawMap();
  }
})();
