/* QG01 页面交互。核心算法在 qg01-core.js，可独立在 Node/浏览器测试。 */
(() => {
  'use strict';

  const Q = window.QG01;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const MODE_LABEL = {
    constant: '常值叶 (00 + 8 位灰度)',
    raw: '逐像素原样叶 (01 + 整块字节)',
    split: '四分节点 (1 + 四个子块)',
  };

  const state = {
    image: null,
    mask: null,
    maskValidCount: 0,
    budget: 512,
    worker: null,
    workerReady: false,
    workerFailed: false,
    analysis: null,
    analysisId: 0,
    activeAnalysisId: 0,
    plan: null,
    qgBytes: null,
    imported: null,
    view: null,
    viewSource: null,
    selectedId: 0,
    materializeTimer: 0,
  };

  // ---------- DOM 辅助 ----------

  function setText(id, text) { $(id).textContent = text; }

  function showError(title, error) {
    const panel = $('alert-panel');
    const errBox = $('error-panel');
    const statusBox = $('status-panel');
    panel.hidden = false;
    errBox.hidden = false;
    statusBox.hidden = true;
    $('error-title').textContent = title;
    const report = error && typeof error.toReport === 'function'
      ? error.toReport()
      : (error && error.message) ? error.message : String(error);
    $('error-message').textContent = report;
    errBox.dataset.code = error?.code || 'error';
  }

  function showStatus(message, busy = false) {
    const panel = $('alert-panel');
    const errBox = $('error-panel');
    const statusBox = $('status-panel');
    panel.hidden = false;
    errBox.hidden = true;
    statusBox.hidden = false;
    statusBox.classList.toggle('busy', busy);
    statusBox.textContent = message;
  }

  function clearAlert() {
    $('alert-panel').hidden = true;
    $('error-panel').hidden = true;
    $('status-panel').hidden = true;
  }

  function bytesFromBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function readFileBytes(file) {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  function arraysEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------- Worker / DP ----------

  function initWorker() {
    try {
      const worker = new Worker('src/encoder-worker.js');
      state.worker = worker;
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.id !== state.activeAnalysisId && msg.type !== 'plan') return;
        if (msg.type === 'analyzed') {
          state.workerReady = true;
          $('worker-state').textContent = 'Web Worker DP 就绪';
          materializeNow();
        } else if (msg.type === 'plan') {
          if (msg.plan.budget !== Number($('budget-number').value)) {
            // 最新一次滑块输入会再触发 materialize；过期响应不渲染。
          }
          handlePlanMessage(msg.plan);
        } else if (msg.type === 'error') {
          showError('编码失败', msg.report || msg.message);
        }
      };
      worker.onerror = (event) => {
        state.workerFailed = true;
        state.workerReady = false;
        $('worker-state').textContent = 'Worker 不可用，已切换主线程编码';
        // 只有已经导入图像时才补一次主线程分析。
        if (state.image) mainThreadAnalyze();
        event.preventDefault();
      };
    } catch {
      state.workerFailed = true;
      $('worker-state').textContent = '当前环境不支持 Worker，使用主线程编码';
    }
  }

  function startAnalysis() {
    if (!state.image) return;
    clearAlert();
    $('encode-button').disabled = false;
    $('export-qg01').disabled = true;
    showStatus('正在建立整图四叉树误差/预算 DP…', true);

    state.activeAnalysisId = ++state.analysisId;
    state.plan = null;
    state.imported = null;
    state.view = null;

    if (!state.workerFailed && state.worker) {
      state.workerReady = false;
      state.worker.postMessage({
        type: 'analyze',
        id: state.activeAnalysisId,
        width: state.image.width,
        pixels: state.image.data,
        mask: state.mask,
      });
    } else {
      mainThreadAnalyze();
    }
  }

  function mainThreadAnalyze() {
    if (!state.image) return;
    const id = state.activeAnalysisId;
    setTimeout(() => {
      try {
        const analysis = Q.analyzeQuadtree({
          width: state.image.width,
          data: state.image.data,
          mask: state.mask,
        });
        if (id !== state.activeAnalysisId) return;
        state.analysis = analysis;
        state.workerReady = true;
        materializeNow();
      } catch (error) {
        showError('编码分析失败', error);
      }
    }, 30);
  }

  function scheduleMaterialize() {
    window.clearTimeout(state.materializeTimer);
    state.materializeTimer = window.setTimeout(() => materializeNow(), 90);
  }

  function materializeNow() {
    const budget = clampBudget($('budget-number').value);
    state.budget = budget;
    updateBudgetOutput();
    if (!state.image) return;

    if (!state.workerFailed && state.worker && !state.workerReady) return;

    if (!state.workerFailed && state.worker) {
      state.worker.postMessage({
        type: 'materialize',
        id: state.activeAnalysisId,
        reqId: `${state.activeAnalysisId}:${budget}:${Date.now()}`,
        budget,
      });
      showStatus('正在选取预算内误差最小方案…', true);
    } else if (state.analysis) {
      setTimeout(() => {
        try {
          const plan = Q.encodeOptimal({ ...state.analysis, budget });
          handlePlanMessage(plan);
        } catch (error) {
          showError('编码失败', error);
        }
      }, 0);
    }
  }

  function handlePlanMessage(plan) {
    if (!plan.leafIds) plan.leafIds = (plan.leaves || []).map((node) => node.id);
    if (!(plan.payload instanceof Uint8Array) && plan.payload?.buffer) {
      plan.payload = new Uint8Array(plan.payload.buffer);
    }
    state.plan = plan;
    state.qgBytes = plan.payload;
    state.view = plan;
    state.viewSource = 'encoded';
    state.selectedId = 0;
    state.imported = null;
    $('export-qg01').disabled = false;
    $('import-banner').hidden = true;
    $('roundtrip-card').hidden = true;
    clearAlert();
    renderAll();
    window.__QG01_LAST_BYTES__ = state.qgBytes;
  }

  // ---------- 输入文件 ----------

  async function handleImageFile(file) {
    if (!file) return;
    try {
      const bytes = await readFileBytes(file);
      const parsed = Q.parsePGM(bytes);
      Q.validateGrayImage(parsed);
      state.image = { width: parsed.width, height: parsed.height, data: parsed.data, name: file.name };
      state.mask = null;
      state.maskValidCount = parsed.width * parsed.height;
      $('image-name').textContent = `${file.name} · ${parsed.width}×${parsed.height}`;
      $('mask-name').textContent = '未使用掩膜（全部像素有效）';
      $('mask-input').value = '';
      $('encode-button').disabled = false;
      renderSource();
      startAnalysis();
    } catch (error) {
      showError('灰度 PGM 导入失败，当前预览未更改', error);
    } finally {
      $('image-input').value = '';
    }
  }

  async function handleMaskFile(file) {
    if (!file) return;
    try {
      if (!state.image) throw new Q.QG01Error('请先导入同尺寸灰度 PGM，再选择掩膜', { code: 'order' });
      const bytes = await readFileBytes(file);
      const mask = Q.normalizeMask(bytes, state.image.width, state.image.height);
      state.mask = mask;
      state.maskValidCount = mask.reduce((s, v) => s + (v ? 1 : 0), 0);
      $('mask-name').textContent = `${file.name} · 有效 ${state.maskValidCount}/${mask.length}`;
      startAnalysis();
    } catch (error) {
      showError('掩膜导入失败，当前预览未更改', error);
    } finally {
      $('mask-input').value = '';
    }
  }

  function loadSample() {
    try {
      const gray = Q.parsePGM(bytesFromBase64(window.QG01_SAMPLE.grayBase64));
      const maskPgm = Q.parsePGM(bytesFromBase64(window.QG01_SAMPLE.maskBase64));
      state.image = { width: gray.width, height: gray.height, data: gray.data, name: 'gray.pgm（样图）' };
      state.mask = Q.normalizeMask(maskPgm.data, gray.width, gray.height);
      state.maskValidCount = state.mask.reduce((s, v) => s + (v ? 1 : 0), 0);
      $('image-name').textContent = `gray.pgm · ${gray.width}×${gray.height}`;
      $('mask-name').textContent = `valid.pgm · 有效 ${state.maskValidCount}/${state.mask.length}`;
      $('encode-button').disabled = false;
      setBudget(512);
      renderSource();
      startAnalysis();
    } catch (error) {
      showError('样图载入失败', error);
    }
  }

  // ---------- 渲染 ----------

  function putGrayCanvas(canvasId, pixels, width, height, mask = null, dimInvalid = false) {
    const canvas = $(canvasId);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      let r = pixels[i], g = pixels[i], b = pixels[i];
      if (dimInvalid && mask && !mask[i]) {
        r = Math.round(r * 0.42 + 70);
        g = Math.round(g * 0.34);
        b = Math.round(b * 0.34);
      }
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  function renderSource() {
    if (!state.image) return;
    const { width, height, data } = state.image;
    const dim = $('mask-toggle').checked;
    putGrayCanvas('original-canvas', data, width, height, state.mask, dim);
    $('original-placeholder').hidden = true;
    $('stat-size').textContent = `${width}×${height}`;
    $('stat-valid').textContent = state.mask
      ? `${state.maskValidCount.toLocaleString()} / ${width * height}`
      : `${(width * height).toLocaleString()}`;
  }

  function renderAll() {
    const view = state.view;
    if (!view) return;
    if (!view.leafIds) view.leafIds = (view.leaves || []).map((node) => node.id);
    const width = view.width;
    $('recon-placeholder').hidden = true;
    $('boundary-placeholder').hidden = true;
    putGrayCanvas('reconstruction-canvas', view.reconstructed, width, width);
    putGrayCanvas('boundary-canvas', view.reconstructed, width, width);
    renderSvg(view);
    renderStats(view);
    renderBitstream(view);
    selectNode(state.selectedId || 0, false);
  }

  function renderStats(view) {
    const used = view.usedBits ?? view.bitLength;
    setText('stat-used', `${used} 位`);
    if (state.viewSource === 'encoded' && Number.isInteger(view.budget)) {
      setText('stat-left', `${view.budget - used} 位`);
    } else {
      const currentBudget = Number($('budget-number').value);
      setText('stat-left', `预算 ${currentBudget} / 差 ${used - currentBudget}`);
    }
    setText('stat-error', typeof view.distortion === 'number' ? view.distortion.toLocaleString() : '见块检查器');
    setText('stat-blocks', `${view.leafIds.length} / ${view.nodes.length}`);
    setText('stat-size', `${view.width}×${view.height}`);
    if (state.image?.mask || state.mask) {
      const mask = state.mask || state.image?.mask;
      const valid = mask ? mask.reduce((s, v) => s + (v ? 1 : 0), 0) : view.width * view.width;
      setText('stat-valid', mask ? `${valid.toLocaleString()} / ${mask.length}` : `${view.width ** 2}`);
    } else {
      setText('stat-valid', `${view.width ** 2}`);
    }
    $('recon-tag').textContent = state.viewSource === 'imported' ? 'QG01 解码像素' : `用 ${used} 位`;
    $('boundary-tag').textContent = `${view.leafIds.length} 个叶块`;
  }

  function renderSvg(view) {
    const svg = $('boundary-svg');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${view.width} ${view.width}`);
    for (const id of view.leafIds) {
      const node = view.nodes[id];
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', node.x + 0.025);
      rect.setAttribute('y', node.y + 0.025);
      rect.setAttribute('width', Math.max(0, node.size - 0.05));
      rect.setAttribute('height', Math.max(0, node.size - 0.05));
      rect.setAttribute('class', 'qrect');
      rect.dataset.nodeId = String(id);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `#${id} ${node.mode} ${node.size}×${node.size} bits ${Q.formatBitInterval(node)}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    }
  }

  function nodeAtPoint(view, px, py) {
    const x = Math.floor(px);
    const y = Math.floor(py);
    let best = null;
    for (const node of view.nodes) {
      if (node.mode === 'split') continue;
      if (x >= node.x && x < node.x + node.size && y >= node.y && y < node.y + node.size) {
        if (!best || node.size < best.size) best = node;
      }
    }
    return best;
  }

  function handleBoundaryClick(event) {
    const view = state.view;
    if (!view) return;
    const targetId = event.target?.dataset?.nodeId;
    if (targetId !== undefined) {
      selectNode(Number(targetId));
      return;
    }
    const rect = $('boundary-svg').getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * view.width;
    const py = ((event.clientY - rect.top) / rect.height) * view.width;
    const node = nodeAtPoint(view, px, py);
    if (node) selectNode(node.id);
  }

  function pathToRoot(view, id) {
    const path = [];
    let cur = view.nodes[id];
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId === null || cur.parentId === undefined ? null : view.nodes[cur.parentId];
    }
    return path;
  }

  function selectNode(id, updateBitHighlight = true) {
    const view = state.view;
    if (!view || !view.nodes[id]) return;
    state.selectedId = id;
    document.querySelectorAll('.qrect.selected').forEach((el) => el.classList.remove('selected'));
    const rect = document.querySelector(`.qrect[data-node-id="${id}"]`);
    if (rect) rect.classList.add('selected');

    const node = view.nodes[id];
    $('block-empty').hidden = true;
    $('block-details').hidden = false;
    const badge = $('block-mode');
    badge.textContent = node.mode === 'constant' ? '常值' : node.mode === 'raw' ? '原样' : '四分';
    badge.className = `mode-badge ${node.mode}`;
    setText('block-mode-long', MODE_LABEL[node.mode] || node.mode);
    setText('block-position', `(${node.x}, ${node.y})，${node.size}×${node.size}`);
    setText('block-error', typeof node.distortion === 'number'
      ? `${node.distortion.toLocaleString()}（仅掩膜有效点的 SSE）`
      : '无原图/掩膜，未计算');
    setText('block-bits', `${Q.formatBitInterval(node)} · ${node.bits} 位`);

    const fields = [];
    const fi = node.fieldIntervals || {};
    if (fi.branch) fields.push(`分支位 ${interval(fi.branch)}`);
    if (fi.prefix) fields.push(`模式前缀 ${interval(fi.prefix)}`);
    if (fi.value) fields.push(`灰度值 ${interval(fi.value)}`);
    if (fi.pixels) fields.push(`像素字节 ${interval(fi.pixels)}`);
    setText('block-fields', fields.join('；') || '—');

    const ancestors = $('block-ancestors');
    ancestors.innerHTML = '';
    pathToRoot(view, id).forEach((n, index, arr) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ancestor-btn';
      btn.textContent = index === arr.length - 1 ? `#${n.id} ${n.mode}` : `#${n.id}`;
      btn.addEventListener('click', () => selectNode(n.id));
      ancestors.appendChild(btn);
      if (index < arr.length - 1) ancestors.appendChild(document.createTextNode(' / '));
    });

    if (updateBitHighlight) highlightBits(node);
    else highlightBits(node);
  }

  function interval(pair) {
    return `[${pair[0]}, ${pair[1]})`;
  }

  function bitsFromQgBytes(bytes, bitLength) {
    let out = '';
    for (let i = 0; i < bitLength; i++) {
      out += ((bytes[Q.HEADER_BYTES + (i >> 3)] >> (7 - (i & 7))) & 1) ? '1' : '0';
    }
    return out;
  }

  function renderBitstream(view) {
    const bitLength = view.usedBits ?? view.bitLength;
    const bytes = state.qgBytes || view.payload;
    const bitString = bytes ? bitsFromQgBytes(bytes, bitLength) : Q.bitsToString(view);
    const kind = new Array(bitLength);
    for (const node of view.nodes) {
      if (node.mode === 'split') kind[node.bitStart] = 'branch';
      else for (let i = node.bitStart; i < node.bitEnd; i++) kind[i] = node.mode;
    }
    const box = $('bitstream');
    box.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < bitString.length; i++) {
      const span = document.createElement('span');
      span.className = `bit kind-${kind[i] || 'unknown'}`;
      if ((i & 7) === 7) span.classList.add('group-end');
      span.dataset.index = i;
      span.textContent = bitString[i];
      span.title = `载荷位 ${i}`;
      fragment.appendChild(span);
    }
    box.appendChild(fragment);

    if (bytes) {
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      setText('byte-hex', `QG01 文件（${bytes.length} 字节）：${hex}`);
    }
    highlightBits(view.nodes[state.selectedId || 0]);
  }

  function highlightBits(node) {
    document.querySelectorAll('.bit.in-selected,.bit.in-ancestor').forEach((el) => {
      el.classList.remove('in-selected', 'in-ancestor');
    });
    if (!node) return;
    for (let i = node.bitStart; i < node.bitEnd; i++) {
      document.querySelector(`.bit[data-index="${i}"]`)?.classList.add('in-selected');
    }
    const view = state.view;
    let parent = node.parentId === null || node.parentId === undefined ? null : view.nodes[node.parentId];
    while (parent) {
      for (let i = parent.bitStart; i < parent.bitEnd; i++) {
        const el = document.querySelector(`.bit[data-index="${i}"]`);
        if (el && !(i >= node.bitStart && i < node.bitEnd)) el.classList.add('in-ancestor');
      }
      parent = parent.parentId === null || parent.parentId === undefined ? null : view.nodes[parent.parentId];
    }
    const selected = document.querySelector('.bit.in-selected');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- QG01 导入/导出 ----------

  async function handleQGFile(file) {
    if (!file) return;
    let bytes;
    try {
      bytes = await readFileBytes(file);
    } catch (error) {
      showError('QG01 读取失败，当前预览未更改', error);
      return;
    }
    importQGBytes(bytes, file.name);
    $('qg01-input').value = '';
  }

  function importQGBytes(inputBytes, name = 'import.qg01') {
    const bytes = inputBytes instanceof ArrayBuffer ? new Uint8Array(inputBytes) : inputBytes;
    let decoded;
    try {
      decoded = Q.decodeQG01(bytes);
      if (!Q.isPowerOfTwoSide(decoded.width)) {
        throw new Q.QG01Error(`QG01 边长 ${decoded.width} 不在本应用导入范围 ${Q.MIN_SIDE}–${Q.MAX_SIDE}`, {
          code: 'bad-dimensions',
          byteOffset: 4,
        });
      }
    } catch (error) {
      showError('QG01 导入失败：当前预览未覆盖', error);
      return false;
    }

    state.imported = decoded;
    state.qgBytes = bytes;
    state.view = decoded;
    state.viewSource = 'imported';
    state.selectedId = 0;
    $('export-qg01').disabled = false;
    $('import-banner').hidden = false;
    $('return-encoded').hidden = !state.plan;
    clearAlert();

    if (state.image && state.image.width === decoded.width) {
      Q.evaluateNodes(decoded.nodes, decoded.pixels, state.image.data, state.mask, decoded.width);
      renderAll();
      if (state.plan && state.plan.width === decoded.width && arraysEqual(decoded.pixels, state.plan.reconstructed)) {
        $('roundtrip-card').hidden = false;
        $('roundtrip-text').textContent =
          `${decoded.width}×${decoded.width}，${decoded.pixels.length} 个重建像素逐个相同；声明 ${decoded.usedBits} 位。`;
      } else {
        $('roundtrip-card').hidden = true;
        showStatus(`已导入合法 QG01 ${name}；它与当前编码预览不是同一位流，但块检查可用。`);
      }
    } else {
      // 没有原图时，至少把解码像素显示在原图/重建两个画布中。
      state.view = decoded;
      renderAll();
      putGrayCanvas('original-canvas', decoded.pixels, decoded.width, decoded.width);
      $('original-placeholder').hidden = true;
      setText('stat-valid', `${decoded.width ** 2}（QG01 无掩膜）`);
      $('roundtrip-card').hidden = true;
      showStatus(`已导入 QG01 ${name}；未保留同尺寸 PGM，因此只显示解码像素，无法计算相对原图误差。`);
    }
    window.__QG01_IMPORTED__ = decoded;
    window.__QG01_LAST_BYTES__ = bytes;
    return true;
  }

  function exportCurrentQG() {
    if (!state.qgBytes) return;
    const bytes = state.qgBytes;
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const used = state.view?.usedBits ?? state.view?.bitLength ?? 'qg01';
    const width = state.view?.width ?? state.image?.width ?? 'image';
    a.href = url;
    a.download = `qg01-${width}-${used}b.qg01`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showStatus(`已导出 ${bytes.length} 字节 QG01（${used} 位载荷）。可立即用“重新导入 QG01”验证回环。`);
  }

  // ---------- 预算控件 ----------

  function clampBudget(value) {
    let n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) n = 512;
    n = Math.max(Q.MIN_BUDGET, Math.min(Q.MAX_BUDGET, n));
    return n;
  }

  function updateBudgetOutput() {
    setText('budget-output', `${state.budget} 位`);
    $('budget-range').value = String(state.budget);
    $('budget-number').value = String(state.budget);
  }

  function setBudget(value) {
    state.budget = clampBudget(value);
    updateBudgetOutput();
    scheduleMaterialize();
  }

  // ---------- 事件绑定 ----------

  function bindEvents() {
    $('image-input').addEventListener('change', (e) => handleImageFile(e.target.files?.[0]));
    $('mask-input').addEventListener('change', (e) => handleMaskFile(e.target.files?.[0]));
    $('qg01-input').addEventListener('change', (e) => handleQGFile(e.target.files?.[0]));
    $('load-sample').addEventListener('click', loadSample);
    $('export-qg01').addEventListener('click', exportCurrentQG);
    $('encode-button').addEventListener('click', () => {
      if (state.analysis || state.workerReady) materializeNow();
      else startAnalysis();
    });

    $('budget-range').addEventListener('input', (e) => {
      state.budget = clampBudget(e.target.value);
      updateBudgetOutput();
      scheduleMaterialize();
    });
    $('budget-number').addEventListener('input', (e) => {
      const n = Number.parseInt(e.target.value, 10);
      if (Number.isInteger(n) && n >= Q.MIN_BUDGET && n <= Q.MAX_BUDGET) {
        state.budget = n;
        setText('budget-output', `${n} 位`);
        $('budget-range').value = String(n);
        scheduleMaterialize();
      }
    });
    $('budget-number').addEventListener('change', () => {
      state.budget = clampBudget($('budget-number').value);
      updateBudgetOutput();
      materializeNow();
    });
    document.querySelectorAll('[data-budget]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.budget = Number(btn.dataset.budget);
        updateBudgetOutput();
        materializeNow();
      });
    });

    $('boundary-stage').addEventListener('click', handleBoundaryClick);
    $('mask-toggle').addEventListener('change', renderSource);
    $('return-encoded').addEventListener('click', () => {
      if (state.plan) {
        state.view = state.plan;
        state.viewSource = 'encoded';
        state.qgBytes = state.plan.payload || state.qgBytes;
        $('import-banner').hidden = true;
        renderAll();
      }
    });

    // 拖放 PGM/QG01 到窗口也可导入。
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.name.endsWith('.qg01') || file.name.endsWith('.qg')) handleQGFile(file);
      else if (file === e.dataTransfer.files[0] && !state.image) handleImageFile(file);
      else if (/mask|valid/i.test(file.name)) handleMaskFile(file);
      else handleImageFile(file);
    });
  }

  // ---------- 启动 ----------

  bindEvents();
  initWorker();
  updateBudgetOutput();

  // 给自动化/控制台留一个窄 API。
  window.QG01App = {
    state,
    loadSample,
    setBudget,
    encodeNow: startAnalysis,
    selectNode,
    importQGBytes,
    getQGBytes: () => state.qgBytes,
    getPlan: () => state.plan,
  };
})();
