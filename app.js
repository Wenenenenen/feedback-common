/* Ordered Strip Forge 浏览器界面；打包核心在 strip-forge.js。 */
(function () {
  'use strict';

  const SF = window.StripForge;
  const $ = (id) => document.getElementById(id);

  const EMBEDDED_SAMPLE = {
    format:
      'faces每条为{v:[a,b,c],group:非负整数,last:整数或null}，v为互异的0至2147483647。',
    faces: [
      { v: [0, 1, 2], group: 0, last: null },
      { v: [2, 1, 3], group: 0, last: null },
      { v: [9, 10, 11], group: 1, last: 11 }
    ]
  };

  const state = {
    faces: null,
    result: null,
    selectedFace: 0,
    detailWindow: 0,
    busy: false
  };

  let faceList = null;
  let windowList = null;
  let toastTimer = 0;

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function showError(err) {
    const banner = $('errorBanner');
    const message = err && err.message ? err.message : String(err);
    const details = err && err.details && err.details.faceIndex;
    banner.hidden = false;
    banner.textContent =
      '打包未应用，仍显示上一版结果：' +
      message +
      (typeof details === 'number' ? `（面 #${details}）` : '');
  }

  function hideError() {
    $('errorBanner').hidden = true;
    $('errorBanner').textContent = '';
  }

  function setBadge(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.className = 'badge ' + (kind || 'group');
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('zh-CN').format(n);
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制到剪贴板');
      return true;
    } catch (e) {
      return false;
    }
  }

  let lastExportText = '';

  function openExportModal(filename, text) {
    lastExportText = text;
    $('exportModalTitle').textContent = filename;
    $('exportModalText').value = text;
    $('exportModal').hidden = false;
  }

  function closeExportModal() {
    $('exportModal').hidden = true;
  }

  async function copyExportModal() {
    const ok = await copyText(lastExportText);
    if (!ok) {
      const ta = $('exportModalText');
      ta.focus();
      ta.select();
      const execOk = document.execCommand('copy');
      showToast(execOk ? '已复制选中文本' : '请按 Ctrl/Cmd+C 复制');
    }
  }

  /* ---------------- 虚拟列表 ---------------- */

  function createVirtualList(el, rowHeight, renderRow, onActivate) {
    const spacer = document.createElement('div');
    spacer.className = 'vlist-spacer';
    el.innerHTML = '';
    el.appendChild(spacer);

    let count = 0;
    let selected = -1;
    let raf = 0;

    function render() {
      raf = 0;
      const viewHeight = el.clientHeight || 480;
      const overscan = 8;
      const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
      const visible = Math.ceil(viewHeight / rowHeight);
      const end = Math.min(count, start + visible + overscan * 2);

      spacer.style.height = count * rowHeight + 'px';
      let html = '';
      for (let i = start; i < end; i++) html += renderRow(i, i === selected);
      spacer.innerHTML = html;
      Array.prototype.forEach.call(spacer.children, (rowEl, offset) => {
        rowEl.style.top = (start + offset) * rowHeight + 'px';
      });
    }

    function scheduleRender() {
      if (!raf) raf = requestAnimationFrame(render);
    }

    el.addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(render);
      },
      { passive: true }
    );

    el.addEventListener('click', (event) => {
      const row = event.target.closest('[data-index]');
      if (!row || !el.contains(row)) return;
      onActivate(Number(row.dataset.index));
    });

    el.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(count - 1, selected + delta));
      if (Number.isFinite(next)) {
        onActivate(next);
        requestAnimationFrame(() => {
          const nextRow = el.querySelector(`[data-index="${next}"]`);
          if (nextRow && typeof nextRow.focus === 'function') nextRow.focus();
        });
      }
    });

    return {
      setCount(value) {
        count = value;
        render();
      },
      setSelected(index, shouldScroll) {
        selected = index;
        render();
        if (shouldScroll && index >= 0) this.scrollToIndex(index);
      },
      getSelected() {
        return selected;
      },
      scrollToIndex(index) {
        const target = Math.max(
          0,
          index * rowHeight - el.clientHeight / 2 + rowHeight / 2
        );
        el.scrollTop = target;
        scheduleRender();
      },
      refresh: render
    };
  }

  function vertexChips(triple, provoke, lockedLast) {
    return triple
      .map((value) => {
        const cls =
          'idx' +
          (value === provoke ? ' provoke' : '') +
          (lockedLast !== null && value === lockedLast ? ' locked' : '');
        return `<span class="${cls}" title="${
          value === provoke ? '实际末索引 / 平面着色触发点' : '顶点索引'
        }">${value}</span>`;
      })
      .join('');
  }

  function renderFaceRow(i, selected) {
    const f = state.faces[i];
    const m = state.result.mapping[i];
    const vertices = f.v
      .map((v) => {
        const locked = f.last !== null && v === f.last;
        const chosen = f.last === null && m && m.raw[2] === v;
        return `<span class="vertex${locked ? ' last' : chosen ? ' chosen' : ''}">${v}${
          locked ? ' ●' : ''
        }</span>`;
      })
      .join('<span class="arrow">→</span>');

    return `
      <button type="button" class="vrow face-row${selected ? ' selected' : ''}" data-index="${i}"
        aria-label="原面 ${i}，分组 ${f.group}">
        <span class="row-index">#${i}</span>
        <span class="vertex-line">${vertices}</span>
        <span class="badge group">g${f.group}</span>
      </button>`;
  }

  function renderWindowRow(i, selected) {
    const w = state.result.windows[i];
    const status = w.degenerate
      ? '<span class="badge warn">退化</span>'
      : `<span class="badge good">面 #${w.faceIndex}</span>`;
    return `
      <button type="button" class="vrow window-row${w.degenerate ? ' degenerate' : ''}${
      selected ? ' selected' : ''
    }" data-index="${i}" aria-label="窗口记录 ${i}">
        <span class="row-index">#${w.index}</span>
        <span class="mono" style="color:var(--muted);font-size:11px;">@${w.start}</span>
        <span class="triple">${vertexChips(w.raw, w.raw[2], null)}</span>
        <span class="triple canonical-col">${vertexChips(w.canonical, w.canonical[2], null)}</span>
        <span style="display:grid;gap:2px;justify-items:end;">
          <span class="badge parity-${w.parity}">${w.parity ? '奇窗' : '偶窗'}</span>
          ${status}
        </span>
      </button>`;
  }

  /* ---------------- SVG 面对照 ---------------- */

  function triangleSVG(v, highlight) {
    const pts = [
      [130, 38],
      [42, 166],
      [218, 166]
    ];

    let edges = '';
    for (let k = 0; k < 3; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % 3];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      edges += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"
        stroke="var(--line-strong)" stroke-width="2.4" stroke-linecap="round"/>
        <g transform="translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${angle.toFixed(1)})">
          <path d="M-7,-5 L4,0 L-7,5" fill="none" stroke="var(--accent)" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"/>
        </g>`;
    }

    const nodes = v
      .map((value, k) => {
        const [x, y] = pts[k];
        const label = String(value);
        const width = Math.max(42, label.length * 7.6 + 20);
        const cls =
          'tri-node' +
          (highlight !== null && value === highlight ? ' provoke' : '');
        return `
          <g class="${cls}">
            ${
              highlight !== null && value === highlight
                ? `<rect x="${x - width / 2 - 4}" y="${y - 19}" width="${width + 8}" height="38" rx="13" class="node-halo"/>`
                : ''
            }
            <rect x="${x - width / 2}" y="${y - 16}" width="${width}" height="32" rx="10"></rect>
            <text x="${x}" y="${y + 1}">${label}</text>
          </g>`;
      })
      .join('');

    return `
      <svg class="triangle-svg" viewBox="0 0 260 204" role="img"
        aria-label="有向三角形 ${v.join(' 到 ')}">
        ${edges}
        ${nodes}
      </svg>`;
  }

  /* ---------------- 渲染 ---------------- */

  function renderStats(verification) {
    const r = state.result;
    const groupCount = new Set(state.faces.map((f) => f.group)).size;
    $('statFaces').textContent = formatNumber(r.stats.faceCount);
    $('statIndices').textContent = formatNumber(r.stats.indexCount);
    $('statRestarts').textContent = formatNumber(r.stats.restartCount);
    $('statDegenerate').textContent = formatNumber(r.stats.degenerateWindowCount);
    $('statGroups').textContent = formatNumber(groupCount);
    $('statTime').textContent =
      r.stats.packMs.toFixed(0) + ' ms' + (verification && verification.ok ? ' ✓' : '');
    $('faceCountBadge').textContent = formatNumber(state.faces.length) + ' faces';
    $('windowCountBadge').textContent = formatNumber(r.windows.length) + ' windows';
    setBadge(
      'verifyBadge',
      verification && verification.ok
        ? `校验通过 · 最小长度 ${r.length}`
        : '校验失败',
      verification && verification.ok ? 'good' : 'bad'
    );
  }

  function renderOriginalDetail() {
    const i = state.selectedFace;
    if (i < 0 || !state.faces[i]) {
      $('originalTriangle').innerHTML =
        '<div class="empty-state"><span class="big">没有三角形</span><span>请导入包含 faces 的 JSON。</span></div>';
      $('originalMeta').innerHTML = '';
      return;
    }
    const f = state.faces[i];
    const m = state.result.mapping[i];
    $('originalTriangle').innerHTML = triangleSVG(f.v, f.last);
    $('originalMeta').innerHTML = `
      <dt>原序号</dt><dd class="mono">#${i}</dd>
      <dt>group</dt><dd class="mono">${f.group}</dd>
      <dt>指定 last</dt><dd class="mono">${f.last === null ? 'null（允许优化器选择）' : f.last}</dd>
      <dt>实际末顶点</dt><dd class="mono" style="color:var(--provoke);font-weight:800;">${m.raw[2]}</dd>
      <dt>输入绕序</dt><dd class="mono">[${f.v.join(', ')}]</dd>`;
  }

  function renderWindowFormula() {
    const w = state.result.windows[state.detailWindow];
    if (!w) {
      $('windowFormula').innerHTML = '<span class="hint">没有解码窗口。</span>';
      $('windowMeta').innerHTML = '';
      return;
    }
    const oddSwap =
      w.parity === 1
        ? `<div class="formula-line">
             <span class="formula-label">奇窗交换</span>
             <span class="big-index">${w.raw[0]}</span>
             <span class="big-index">${w.raw[1]}</span>
             <span class="big-index provoke">${w.raw[2]}</span>
             <span class="arrow">→</span>
             <span class="big-index">${w.canonical[0]}</span>
             <span class="big-index">${w.canonical[1]}</span>
             <span class="big-index provoke">${w.canonical[2]}</span>
           </div>`
        : `<div class="formula-line"><span class="formula-label">偶窗</span><span>不交换前两点，规范面等于 raw。</span></div>`;

    const status = w.degenerate
      ? '<span class="badge warn">重复索引：不出面，仍推进奇偶</span>'
      : `<span class="badge good">对应实面 #${w.faceIndex}</span>`;

    $('windowFormula').innerHTML = `
      <div class="formula-line">
        <span class="formula-label">raw 窗口</span>
        <span class="big-index">${w.raw[0]}</span>
        <span class="big-index">${w.raw[1]}</span>
        <span class="big-index provoke">${w.raw[2]}</span>
        ${status}
      </div>
      ${oddSwap}
      <div class="formula-line">
        <span class="formula-label">规范绕序</span>
        <span class="big-index">${w.canonical[0]}</span>
        <span class="big-index">${w.canonical[1]}</span>
        <span class="big-index provoke">${w.canonical[2]}</span>
      </div>`;

    const linkedFace = w.degenerate ? null : w.faceIndex;
    $('windowMeta').innerHTML = `
      <dt>全流偏移</dt><dd class="mono">start=${w.start}, end=${w.start + 2}</dd>
      <dt>条带窗号</dt><dd class="mono">windowIndex=${w.windowIndex}</dd>
      <dt>奇偶</dt><dd><span class="badge parity-${w.parity}">${w.parity} · ${w.parity ? 'odd' : 'even'}</span></dd>
      <dt>segment</dt><dd class="mono">#${w.segment}</dd>
      <dt>关联原面</dt><dd class="mono">${linkedFace === null ? '无（退化窗）' : '#' + linkedFace}</dd>`;
  }

  function renderMappingMeta() {
    const m = state.result.mapping[state.selectedFace];
    if (!m) {
      $('mappingMeta').innerHTML = '<dt>mapping</dt><dd>暂无逐面映射。</dd>';
      return;
    }
    $('mappingMeta').innerHTML = `
      <dt>originalIndex</dt><dd class="mono">${m.originalIndex}</dd>
      <dt>windowStart</dt><dd class="mono">${m.windowStart}</dd>
      <dt>windowIndex</dt><dd class="mono">${m.windowIndex}</dd>
      <dt>parity</dt><dd class="mono">${m.parity}</dd>
      <dt>group</dt><dd class="mono">${m.group}</dd>
      <dt>条带内序号</dt><dd class="mono">strip ${m.stripInGroup} / segment ${m.segment}</dd>
      <dt>raw</dt><dd class="mono">[${m.raw.join(', ')}]</dd>
      <dt>canonical</dt><dd class="mono">[${m.canonical.join(', ')}]</dd>`;
  }

  function renderEditForm() {
    const i = state.selectedFace;
    if (i < 0 || !state.faces || !state.faces[i]) {
      $('faceIndexInput').value = '';
      $('groupInput').value = '';
      $('lastSelect').innerHTML = '';
      return;
    }
    const f = state.faces[i];
    $('faceIndexInput').value = i;
    $('faceIndexInput').max = state.faces.length - 1;
    $('groupInput').value = f.group;
    const select = $('lastSelect');
    select.innerHTML =
      '<option value="">null — 不锁定，允许选择末顶点</option>' +
      f.v
        .map(
          (v) =>
            `<option value="${v}"${f.last === v ? ' selected' : ''}>last = ${v}</option>`
        )
        .join('');
    select.value = f.last === null ? '' : String(f.last);
  }

  function buildExportObject() {
    return {
      format: 'ordered-strip-forge/export-v1',
      indices: state.result.indices,
      mapping: state.result.mapping.map((m) => ({
        originalIndex: m.originalIndex,
        face: m.face,
        faceIndex: m.originalIndex,
        group: m.group,
        stripInGroup: m.stripInGroup,
        segment: m.segment,
        windowStart: m.windowStart,
        windowFirstOffset: m.windowStart,
        offset: m.windowStart,
        windowIndex: m.windowIndex,
        parity: m.parity,
        parityInStrip: m.parity,
        provokingVertex: m.raw[2],
        specifiedLast: m.last,
        raw: m.raw,
        canonical: m.canonical
      }))
    };
  }

  function renderExportPreview() {
    const full = JSON.stringify(buildExportObject(), null, 2);
    const limit = 6000;
    $('exportPreview').value =
      full.length > limit
        ? full.slice(0, limit) +
          `\n\n… 预览已截断；完整 ${formatNumber(full.length)} 字符，请使用“导出 JSON”。`
        : full;
  }

  function renderAll(verification) {
    if (!state.result) return;
    const verify = verification || SF.verifyResult({ faces: state.faces }, state.result);
    renderStats(verify);
    faceList.setCount(state.faces.length);
    faceList.setSelected(state.selectedFace, false);
    windowList.setCount(state.result.windows.length);
    windowList.setSelected(state.detailWindow, false);
    renderOriginalDetail();
    renderWindowFormula();
    renderMappingMeta();
    renderEditForm();
    renderExportPreview();
  }

  /* ---------------- 选择 ---------------- */

  function selectFace(i, scrollFace = false, scrollWindow = scrollFace) {
    if (!state.result || !state.faces.length) return;
    state.selectedFace = Math.max(0, Math.min(state.faces.length - 1, i));
    const m = state.result.mapping[state.selectedFace];
    state.detailWindow = m.windowRecord;

    faceList.setSelected(state.selectedFace, scrollFace);
    windowList.setSelected(state.detailWindow, scrollWindow);
    renderOriginalDetail();
    renderWindowFormula();
    renderMappingMeta();
    renderEditForm();
  }

  function selectWindow(i) {
    state.detailWindow = i;
    const w = state.result.windows[i];
    windowList.setSelected(i, false);
    if (!w.degenerate && Number.isInteger(w.faceIndex)) {
      state.selectedFace = w.faceIndex;
      faceList.setSelected(state.selectedFace, true);
      renderOriginalDetail();
      renderMappingMeta();
      renderEditForm();
    }
    renderWindowFormula();
  }

  /* ---------------- 打包与修改 ---------------- */

  async function repack(nextFaces) {
    if (state.busy) return false;
    state.busy = true;
    setBadge('verifyBadge', '打包中…', 'warn');
    await nextFrame();

    try {
      const doc = { faces: nextFaces };
      const result = SF.packDocument(doc);
      const verification = SF.verifyResult(doc, result);
      if (!verification.ok) throw new Error(verification.errors.join('；'));

      state.faces = result.faces;
      state.result = result;
      if (state.faces.length > 0) {
        state.selectedFace = Math.max(
          0,
          Math.min(state.faces.length - 1, state.selectedFace)
        );
        state.detailWindow = state.result.mapping[state.selectedFace].windowRecord;
      } else {
        state.selectedFace = -1;
        state.detailWindow = -1;
      }
      hideError();
      renderAll(verification);
      return true;
    } catch (err) {
      showError(err);
      showToast('改动无效，已保留上一版结果');
      setBadge('verifyBadge', '非法改动 · 保留上一版', 'bad');
      renderEditForm();
      return false;
    } finally {
      state.busy = false;
    }
  }

  async function loadDocument(doc, name) {
    try {
      // 先由引擎严格校验/规范化；repack 内部还会再做一次完整打包。
      const faces = SF.validateDocument(doc);
      state.selectedFace = 0;
      state.detailWindow = 0;
      const ok = await repack(faces);
      if (ok) showToast(`已载入 ${name || 'JSON'}`);
      return ok;
    } catch (err) {
      showError(err);
      setBadge(
        'verifyBadge',
        state.result ? '输入无效 · 保留上一版' : '输入无效',
        'bad'
      );
      return false;
    }
  }

  async function loadSample() {
    try {
      const res = await fetch('samples/ordered-strips.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      await loadDocument(json, 'samples/ordered-strips.json');
    } catch (e) {
      await loadDocument(EMBEDDED_SAMPLE, '内置样例');
    }
  }

  function makeLongChain() {
    const faces = new Array(100000);
    for (let i = 0; i < 100000; i++) {
      faces[i] = {
        v: i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2],
        group: 0,
        last: null
      };
    }
    return { faces };
  }

  function cloneFaces() {
    return state.faces.map((f) => ({ v: f.v.slice(), group: f.group, last: f.last }));
  }

  function runBounds(faces, index) {
    const g = faces[index].group;
    let start = index;
    let end = index;
    while (start > 0 && faces[start - 1].group === g) start--;
    while (end < faces.length - 1 && faces[end + 1].group === g) end++;
    return { g, start, end };
  }

  async function applyFormEdit(event) {
    event.preventDefault();
    if (!state.result || !state.faces.length) return;

    const target = Number($('faceIndexInput').value);
    if (Number.isInteger(target) && target >= 0 && target < state.faces.length) {
      state.selectedFace = target;
    }

    const nextFaces = cloneFaces();
    const i = state.selectedFace;
    const group = Number($('groupInput').value);
    if (!Number.isInteger(group) || group < 0 || group > Number.MAX_SAFE_INTEGER) {
      showError(new Error('group 必须是非负整数'));
      renderEditForm();
      setBadge('verifyBadge', '非法改动 · 保留上一版', 'bad');
      return;
    }

    // group 输入可只改当前面、后缀或整个连续运行；最终仍由严格校验裁决。
    const scope = $('groupScope') ? $('groupScope').value : 'face';
    const bounds = runBounds(nextFaces, i);
    if (scope === 'run') {
      for (let k = bounds.start; k <= bounds.end; k++) nextFaces[k].group = group;
    } else if (scope === 'suffix') {
      for (let k = i; k <= bounds.end; k++) nextFaces[k].group = group;
    } else {
      nextFaces[i].group = group;
    }

    const lastValue = $('lastSelect').value;
    nextFaces[i].last = lastValue === '' ? null : Number(lastValue);

    const ok = await repack(nextFaces);
    if (ok) showToast('已重新打包为字典序最小最短流');
  }

  async function splitGroup() {
    if (!state.result || !state.faces.length) return;
    const i = state.selectedFace;
    if (i === 0) {
      showToast('第一面之前不能再拆组');
      return;
    }
    const bounds = runBounds(state.faces, i);
    if (bounds.start === i) {
      showToast('此面已经是组首');
      return;
    }
    let maxGroup = 0;
    for (const f of state.faces) maxGroup = Math.max(maxGroup, f.group);
    const newGroup = maxGroup + 1;
    const nextFaces = cloneFaces();
    for (let k = i; k <= bounds.end; k++) nextFaces[k].group = newGroup;
    const ok = await repack(nextFaces);
    if (ok) showToast(`已从 #${i} 拆出新组 g${newGroup}`);
  }

  async function mergePreviousGroup() {
    if (!state.result || !state.faces.length) return;
    const i = state.selectedFace;
    const bounds = runBounds(state.faces, i);
    if (bounds.start === 0) {
      showToast('这已经是第一个组');
      return;
    }
    const previousGroup = state.faces[bounds.start - 1].group;
    const nextFaces = cloneFaces();
    for (let k = bounds.start; k <= bounds.end; k++) {
      nextFaces[k].group = previousGroup;
    }
    const ok = await repack(nextFaces);
    if (ok) showToast(`已并入 g${previousGroup}`);
  }

  /* ---------------- 导入/导出 ---------------- */

  function readImportedFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const json = JSON.parse(String(reader.result));
        const ok = await loadDocument(json, file.name);
        if (!ok) showToast('导入无效，当前结果未改动');
      } catch (e) {
        showError(e);
        setBadge('verifyBadge', 'JSON 解析失败', 'bad');
        showToast('JSON 解析失败，当前结果未改动');
      }
    };
    reader.onerror = () => showError(new Error('文件读取失败'));
    reader.readAsText(file);
  }

  function mappingCsv() {
    const header = [
      'originalIndex',
      'group',
      'stripInGroup',
      'segment',
      'windowStart',
      'windowIndex',
      'parity',
      'provokingVertex',
      'specifiedLast'
    ];
    const rows = state.result.mapping.map((m) =>
      [
        m.originalIndex,
        m.group,
        m.stripInGroup,
        m.segment,
        m.windowStart,
        m.windowIndex,
        m.parity,
        m.raw[2],
        m.last === null ? '' : m.last
      ].join(',')
    );
    return [header.join(','), ...rows].join('\n');
  }

  function bindEvents() {
    faceList = createVirtualList($('faceList'), 58, renderFaceRow, (i) =>
      selectFace(i, false, true)
    );
    windowList = createVirtualList($('windowList'), 48, renderWindowRow, selectWindow);

    $('importBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      readImportedFile(e.target.files[0]);
      e.target.value = '';
    });

    $('sampleBtn').addEventListener('click', loadSample);
    $('chainBtn').addEventListener('click', async () => {
      state.selectedFace = 0;
      const t0 = performance.now();
      const ok = await repack(makeLongChain().faces);
      if (ok) {
        showToast(`10 万长链完成，引擎耗时 ${state.result.stats.packMs.toFixed(0)} ms`);
        selectFace(0, true);
      }
      console.info('long chain wall ms', performance.now() - t0);
    });

    $('prevFaceBtn').addEventListener('click', () => selectFace(state.selectedFace - 1, true));
    $('nextFaceBtn').addEventListener('click', () => selectFace(state.selectedFace + 1, true));

    $('editForm').addEventListener('submit', applyFormEdit);
    $('splitBtn').addEventListener('click', splitGroup);
    $('mergeBtn').addEventListener('click', mergePreviousGroup);
    $('faceIndexInput').addEventListener('change', () => {
      const v = Number($('faceIndexInput').value);
      if (Number.isInteger(v)) selectFace(v, true);
    });

    $('exportAllBtn').addEventListener('click', () => {
      const text = JSON.stringify(buildExportObject(), null, 2);
      downloadText('ordered-strip-export.json', text);
      openExportModal('ordered-strip-export.json', text);
      showToast('完整 JSON 已生成');
    });
    $('exportIndicesBtn').addEventListener('click', () => {
      const text = JSON.stringify({ indices: state.result.indices }, null, 2);
      downloadText('indices.json', text);
      openExportModal('indices.json', text);
      showToast('indices 整数流已生成');
    });
    $('exportCsvBtn').addEventListener('click', () => {
      const text = mappingCsv();
      downloadText('face-mapping.csv', text, 'text/csv;charset=utf-8');
      openExportModal('face-mapping.csv', text);
      showToast('逐面映射 CSV 已生成');
    });
    $('copyBtn').addEventListener('click', async () => {
      const text = JSON.stringify(buildExportObject(), null, 2);
      const ok = await copyText(text);
      if (!ok) openExportModal('ordered-strip-export.json', text);
    });

    $('exportModalClose').addEventListener('click', closeExportModal);
    $('exportModalCopy').addEventListener('click', copyExportModal);
    $('exportModalSelect').addEventListener('click', () => {
      const ta = $('exportModalText');
      ta.focus();
      ta.select();
    });
    $('exportModal').addEventListener('click', (e) => {
      if (e.target === $('exportModal')) closeExportModal();
    });

    const drop = $('dropzone');
    ['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('drag');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove('drag');
      })
    );
    drop.addEventListener('drop', (e) => readImportedFile(e.dataTransfer.files[0]));

    $('themeBtn').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme === 'dark';
      if (dark) root.dataset.theme = 'light';
      else root.dataset.theme = 'dark';
      try {
        localStorage.setItem('strip-forge-theme', root.dataset.theme);
      } catch (e) {}
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('exportModal').hidden) {
        closeExportModal();
        return;
      }
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') selectFace(state.selectedFace - 1, true);
      if (e.key === 'ArrowRight') selectFace(state.selectedFace + 1, true);
    });
  }

  function initTheme() {
    let theme = null;
    try {
      theme = localStorage.getItem('strip-forge-theme');
    } catch (e) {}
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  }

  async function boot() {
    if (!SF) {
      $('verifyBadge').textContent = 'strip-forge.js 加载失败';
      return;
    }
    initTheme();
    bindEvents();
    await loadSample();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
