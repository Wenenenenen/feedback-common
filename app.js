/* global ImprintStack */
(function imprintApp() {
  'use strict';

  const { parseImprintJSON, StackOptimizer, findCycle } = window.ImprintStack;

  // Order validated with the dataviz palette checker for a dark map surface.
  const LAYER_COLORS = [
    '#d85c83', '#488beb', '#50a33d', '#cb5fa6', '#809900', '#777feb',
    '#b58300', '#009dd4', '#db5c6c', '#00a5ba', '#db6143', '#00a8a6',
    '#d36c00', '#00aa82', '#aa6cd4', '#19a75a', '#8d77e5', '#ca7500',
  ];
  const LAYER_RGB = LAYER_COLORS.map(hexToRgb);
  const BLANK_RGB = [38, 50, 71];
  const MATCH_RGB = [42, 54, 77];
  const MISMATCH_RGB = [255, 78, 108];

  const state = {
    sourceName: '',
    rawInput: null,
    data: null,
    optimizer: null,
    locks: [],
    lockIdSeq: 1,
    pairA: 1,
    pairB: 2,
    lastSuccess: null,
    cycle: null,
    reverse: null,
  };

  const el = {};
  let toastTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    bindEvents();
    loadInitialSample();
  }

  function cacheElements() {
    [
      'loadSampleBtn', 'fileInput', 'dataSummary', 'solveBtn', 'solveStatePill',
      'scoreValue', 'mismatchCountValue', 'dpStatesValue', 'lockCountValue',
      'lockForm', 'lockAboveSelect', 'lockBelowSelect', 'lockList',
      'cyclePanel', 'cycleChain', 'pairASelect', 'pairBSelect', 'swapPairBtn',
      'reverseBtn', 'pairMessage', 'reverseSummary', 'reverseMapCard',
      'reverseMapTitle', 'reverseMapSubtitle', 'reverseMismatchCanvas',
      'downloadReversePngBtn', 'exportJsonBtn', 'exportCsvBtn',
      'exportPredPngBtn', 'exportMismatchPngBtn', 'copyJsonBtn', 'orderList',
      'successMeta', 'preservedPill', 'legend', 'predictionCanvas',
      'mismatchCanvas', 'pixelInspector', 'tooltip', 'toast',
    ].forEach((id) => { el[id] = document.getElementById(id); });
  }

  function bindEvents() {
    el.loadSampleBtn.addEventListener('click', loadSampleFromServer);
    el.fileInput.addEventListener('change', onFileChange);
    el.solveBtn.addEventListener('click', () => runSolve());
    el.lockForm.addEventListener('submit', onAddLock);
    el.lockList.addEventListener('click', onDeleteLock);
    el.orderList.addEventListener('click', onOrderPairButton);
    el.pairASelect.addEventListener('change', onPairSelectChange);
    el.pairBSelect.addEventListener('change', onPairSelectChange);
    el.swapPairBtn.addEventListener('click', swapPair);
    el.reverseBtn.addEventListener('click', runReverseQuery);

    el.exportJsonBtn.addEventListener('click', exportJSON);
    el.exportCsvBtn.addEventListener('click', exportCSV);
    el.exportPredPngBtn.addEventListener('click', () => {
      downloadCanvas(el.predictionCanvas, 'prediction.png');
    });
    el.exportMismatchPngBtn.addEventListener('click', () => {
      downloadCanvas(el.mismatchCanvas, 'mismatch.png');
    });
    el.copyJsonBtn.addEventListener('click', copyJSON);
    el.downloadReversePngBtn.addEventListener('click', () => {
      downloadCanvas(el.reverseMismatchCanvas, 'reverse-mismatch.png');
    });

    [el.predictionCanvas, el.mismatchCanvas, el.reverseMismatchCanvas].forEach((canvas) => {
      canvas.addEventListener('pointermove', onMapPointer);
      canvas.addEventListener('pointerdown', onMapPointer);
      canvas.addEventListener('pointerleave', hideTooltip);
    });
  }

  async function loadInitialSample() {
    let loaded = false;
    try {
      const response = await fetch('samples/imprint-stack.json', { cache: 'no-store' });
      if (response.ok) {
        const json = await response.json();
        loadDataset(json, 'samples/imprint-stack.json');
        loaded = true;
      }
    } catch (_error) {
      // file:// pages commonly block fetch; the embedded identical sample keeps the tool usable.
    }

    if (!loaded) {
      const fallback = JSON.parse(document.getElementById('sampleFallback').textContent);
      loadDataset(fallback, '内置示例（samples/imprint-stack.json）');
    }
  }

  async function loadSampleFromServer() {
    try {
      const response = await fetch('samples/imprint-stack.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      loadDataset(json, 'samples/imprint-stack.json');
      showToast('已载入 samples/imprint-stack.json');
    } catch (error) {
      const fallback = JSON.parse(document.getElementById('sampleFallback').textContent);
      loadDataset(fallback, '内置示例（samples/imprint-stack.json）');
      showToast('浏览器阻止本地 fetch，已载入内置示例；也可用“导入 JSON”选择原文件');
    }
  }

  async function onFileChange(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      loadDataset(text, file.name);
      showToast(`已导入 ${file.name}`);
    } catch (error) {
      showImportError(error);
    }
  }

  function showImportError(error) {
    const message = error && error.message ? error.message : String(error);
    showToast(`导入失败：${message}`, 5200);
    el.dataSummary.innerHTML = '';
    appendMetaChip(el.dataSummary, '导入失败', message);
  }

  function loadDataset(input, sourceName) {
    // Parse and build first; if the new file is invalid, current state stays usable.
    const data = parseImprintJSON(input);
    const optimizer = new StackOptimizer(data);

    state.sourceName = sourceName || 'imprint-stack.json';
    state.rawInput = input;
    state.data = data;
    state.optimizer = optimizer;
    state.locks = data.locks.map((lock) => ({
      id: state.lockIdSeq++,
      above: lock.above,
      below: lock.below,
    }));
    state.pairA = 1;
    state.pairB = Math.min(2, data.layerCount);
    state.lastSuccess = null;
    state.cycle = null;
    state.reverse = null;
    el.pairMessage.textContent = '';

    populateLayerSelects();
    renderAll();
    runSolve();
  }

  function populateLayerSelects() {
    const n = state.data.layerCount;
    const selects = [el.lockAboveSelect, el.lockBelowSelect, el.pairASelect, el.pairBSelect];
    selects.forEach((select) => {
      select.innerHTML = '';
      for (let layer = 1; layer <= n; layer += 1) {
        const option = document.createElement('option');
        option.value = String(layer);
        option.textContent = `第 ${layer} 层`;
        select.appendChild(option);
      }
    });

    el.lockAboveSelect.value = String(Math.min(n, 3));
    el.lockBelowSelect.value = String(Math.min(n, 2));
    if (Number(el.lockAboveSelect.value) === Number(el.lockBelowSelect.value) && n > 1) {
      el.lockBelowSelect.value = '1';
    }
    el.pairASelect.value = String(state.pairA);
    el.pairBSelect.value = String(state.pairB);
  }

  function renderAll() {
    renderDataSummary();
    renderLockList();
    renderCycle();
    renderLegend();
    renderSuccess();
    renderReverse();
  }

  function renderDataSummary() {
    const data = state.data;
    el.dataSummary.innerHTML = '';
    if (!data) return;

    const totalWeight = data.weight.reduce((sum, value) => sum + value, 0);
    const chips = [
      ['文件', state.sourceName],
      ['尺寸', `${data.width} × ${data.height}`],
      ['层数', String(data.layerCount)],
      ['像素', data.pixelCount.toLocaleString('zh-CN')],
      ['权值总和', totalWeight.toLocaleString('zh-CN')],
      ['DP 状态', (1 << data.layerCount).toLocaleString('zh-CN')],
    ];
    chips.forEach(([label, value]) => appendMetaChip(el.dataSummary, label, value));
    el.dpStatesValue.textContent = (1 << data.layerCount).toLocaleString('zh-CN');
  }

  function appendMetaChip(container, label, value) {
    const chip = document.createElement('span');
    chip.className = 'meta-chip';
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    chip.append(labelNode, strong);
    container.appendChild(chip);
  }

  function renderLockList() {
    el.lockCountValue.textContent = String(state.locks.length);
    el.lockList.innerHTML = '';

    if (state.locks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lock-empty';
      empty.textContent = '暂无锁定；求解器会在全部层序中寻找全局最优。';
      el.lockList.appendChild(empty);
      return;
    }

    state.locks.forEach((lock) => {
      const item = document.createElement('span');
      item.className = 'lock-item';
      item.appendChild(layerBadge(lock.above, 'layer-badge'));
      item.append(document.createTextNode('在'));
      item.appendChild(layerBadge(lock.below, 'layer-badge'));
      item.append(document.createTextNode('之上'));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'delete-lock';
      remove.dataset.lockId = String(lock.id);
      remove.setAttribute('aria-label', `删除锁定：第 ${lock.above} 层必须在第 ${lock.below} 层之上`);
      remove.textContent = '×';
      item.appendChild(remove);
      el.lockList.appendChild(item);
    });
  }

  function layerBadge(layer, className) {
    const badge = document.createElement('span');
    badge.className = className;
    badge.style.setProperty('--layer', layerColor(layer));
    badge.textContent = String(layer);
    return badge;
  }

  function layerColor(layer) {
    return LAYER_COLORS[(layer - 1) % LAYER_COLORS.length];
  }

  function onAddLock(event) {
    event.preventDefault();
    if (!state.data) return;

    const above = Number(el.lockAboveSelect.value);
    const below = Number(el.lockBelowSelect.value);
    if (!Number.isInteger(above) || !Number.isInteger(below)) return;

    const duplicate = state.locks.some((lock) => lock.above === above && lock.below === below);
    if (duplicate) {
      showToast('这条锁定已经存在');
      return;
    }

    state.locks.push({ id: state.lockIdSeq++, above, below });
    el.pairMessage.textContent = '';
    renderLockList();
    runSolve();
  }

  function onDeleteLock(event) {
    const button = event.target.closest('button[data-lock-id]');
    if (!button) return;
    const id = Number(button.dataset.lockId);
    state.locks = state.locks.filter((lock) => lock.id !== id);
    renderLockList();
    runSolve();
  }

  function runSolve() {
    if (!state.optimizer || !state.data) return null;

    setPill(el.solveStatePill, '计算中', 'neutral');
    state.reverse = null;
    renderReverse();

    const edges = state.locks.map((lock) => [lock.above - 1, lock.below - 1]);
    const result = state.optimizer.solve(edges);

    if (!result.ok) {
      state.cycle = result;
      renderCycle();
      renderSuccess();
      setPill(el.solveStatePill, '锁定有环', 'critical');
      return result;
    }

    const evaluation = state.optimizer.evaluate(result.order);
    if (evaluation.score !== result.score) {
      console.error('DP score and pixel evaluation differ', result.score, evaluation.score);
    }

    state.cycle = null;
    state.reverse = null;
    state.lastSuccess = {
      result,
      evaluation,
      locks: state.locks.map((lock) => ({ ...lock })),
      at: new Date(),
    };

    renderCycle();
    renderSuccess();
    renderReverse();
    setPill(el.solveStatePill, '全局最优', 'good');
    return result;
  }

  function setPill(node, text, tone) {
    node.textContent = text;
    node.className = `pill ${tone}`;
  }

  function renderCycle() {
    const cycle = state.cycle;
    if (!cycle || !cycle.cycleLayers) {
      el.cyclePanel.hidden = true;
      el.cycleChain.innerHTML = '';
      return;
    }

    el.cyclePanel.hidden = false;
    appendCycleChain(el.cycleChain, cycle);
  }

  function appendCycleChain(container, cycle) {
    const layers = cycle.cycleLayers || [];
    container.innerHTML = '';
    layers.forEach((layer, index) => {
      container.appendChild(layerBadge(layer, 'layer-badge'));
      if (index < layers.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'cycle-arrow';
        arrow.textContent = '→';
        arrow.setAttribute('aria-hidden', 'true');
        container.appendChild(arrow);
      }
    });

    const readable = document.createElement('span');
    readable.className = 'sr-only';
    readable.textContent = `环路径：${layers.join(' → ')}`;
    container.appendChild(readable);
  }

  function renderSuccess() {
    const last = state.lastSuccess;
    const hasData = Boolean(state.data);
    el.solveBtn.disabled = !hasData;
    el.reverseBtn.disabled = !last;
    ['exportJsonBtn', 'exportCsvBtn', 'exportPredPngBtn', 'exportMismatchPngBtn', 'copyJsonBtn']
      .forEach((id) => { el[id].disabled = !last; });

    if (!last) {
      el.scoreValue.textContent = '—';
      el.mismatchCountValue.textContent = '—';
      el.successMeta.textContent = hasData
        ? '尚未得到成功结果；请检查锁定关系。'
        : '尚未载入数据。';
      el.preservedPill.hidden = true;
      renderOrderList();
      clearCanvases();
      el.pixelInspector.textContent = '载入数据后，这里显示当前像素的覆盖、实测与预测。';
      return;
    }

    el.scoreValue.textContent = formatScore(last.evaluation.score);
    el.mismatchCountValue.textContent = last.evaluation.mismatchCount.toLocaleString('zh-CN');
    el.successMeta.textContent =
      `成功解于 ${formatTime(last.at)}；逐像素复算总分 ${formatScore(last.evaluation.score)}，` +
      `失配 ${last.evaluation.mismatchCount} 点，成功时锁定 ${last.locks.length} 条。`;
    el.preservedPill.hidden = !state.cycle;

    renderOrderList();
    paintPredictionCanvas();
    paintMismatchCanvas();
    el.pixelInspector.textContent = '将指针移到图上查看像素；触屏点按即可固定查看。';
  }

  function renderOrderList() {
    const last = state.lastSuccess;
    el.orderList.innerHTML = '';

    if (!last) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = state.data
        ? '当前锁定无成功拓扑序。删除环中关系后会自动恢复结果。'
        : '导入 JSON 后，这里会显示字典序最小的最优层序。';
      el.orderList.appendChild(empty);
      return;
    }

    last.result.orderLayers.forEach((layer, index) => {
      if (index > 0) {
        const connector = document.createElement('li');
        connector.className = 'order-connector';
        connector.setAttribute('aria-hidden', 'true');
        connector.textContent = '↓';
        el.orderList.appendChild(connector);
      }

      const row = document.createElement('li');
      row.className = 'order-row';

      const rank = document.createElement('span');
      rank.className = 'order-rank';
      rank.textContent = String(index + 1).padStart(2, '0');

      const chip = document.createElement('span');
      chip.className = 'order-layer';
      chip.style.setProperty('--layer', layerColor(layer));
      chip.textContent = String(layer);

      const name = document.createElement('span');
      name.className = 'order-name';
      name.textContent = `第 ${layer} 层`;
      const sub = document.createElement('small');
      const position = index === 0 ? '最上层' : index === last.result.orderLayers.length - 1 ? '最下层' : `第 ${index + 1} 位`;
      sub.textContent = `${position} · 层号字典序并列时取小`;
      name.appendChild(sub);

      const actions = document.createElement('span');
      actions.className = 'order-actions';
      const aButton = makePairButton('甲', 'a', layer, state.pairA === layer);
      const bButton = makePairButton('乙', 'b', layer, state.pairB === layer);
      actions.append(aButton, bButton);

      row.append(rank, chip, name, actions);
      el.orderList.appendChild(row);
    });
  }

  function makePairButton(label, pair, layer, active) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mini-btn ${active ? `active-${pair}` : ''}`;
    button.dataset.pair = pair;
    button.dataset.layer = String(layer);
    button.textContent = active ? `✓ ${label}` : `选${label}`;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    return button;
  }

  function onOrderPairButton(event) {
    const button = event.target.closest('button[data-pair]');
    if (!button) return;
    const layer = Number(button.dataset.layer);
    if (button.dataset.pair === 'a') {
      state.pairA = layer;
      el.pairASelect.value = String(layer);
    } else {
      state.pairB = layer;
      el.pairBSelect.value = String(layer);
    }
    renderOrderList();
  }

  function onPairSelectChange() {
    state.pairA = Number(el.pairASelect.value);
    state.pairB = Number(el.pairBSelect.value);
    renderOrderList();
  }

  function swapPair() {
    const a = Number(el.pairASelect.value);
    const b = Number(el.pairBSelect.value);
    state.pairA = b;
    state.pairB = a;
    el.pairASelect.value = String(state.pairA);
    el.pairBSelect.value = String(state.pairB);
    renderOrderList();
  }

  function renderLegend() {
    el.legend.innerHTML = '';
    if (!state.data) return;

    el.legend.appendChild(makeLegendItem(BLANK_RGB, '0 无覆盖', true));
    for (let layer = 1; layer <= state.data.layerCount; layer += 1) {
      el.legend.appendChild(makeLegendItem(LAYER_RGB[layer - 1], `第 ${layer} 层`));
    }
  }

  function makeLegendItem(rgb, label, blank) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = `legend-swatch${blank ? ' blank' : ''}`;
    swatch.style.setProperty('--swatch', `rgb(${rgb.join(',')})`);
    const text = document.createElement('span');
    text.textContent = label;
    item.append(swatch, text);
    return item;
  }

  function clearCanvases() {
    [el.predictionCanvas, el.mismatchCanvas, el.reverseMismatchCanvas].forEach((canvas) => {
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 1, 1);
    });
  }

  function paintPredictionCanvas() {
    const last = state.lastSuccess;
    if (!last) return;
    paintCanvas(el.predictionCanvas, (p) => {
      const predicted = last.evaluation.prediction[p];
      return predicted === 0 ? BLANK_RGB : LAYER_RGB[predicted - 1];
    });
  }

  function paintMismatchCanvas() {
    const last = state.lastSuccess;
    if (!last) return;
    paintCanvas(el.mismatchCanvas, (p) => (
      last.evaluation.mismatch[p] ? MISMATCH_RGB : MATCH_RGB
    ));
  }

  function paintCanvas(canvas, colorAtPixel) {
    const { width, height } = state.data;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);

    for (let p = 0; p < width * height; p += 1) {
      const [r, g, b] = colorAtPixel(p);
      const offset = p * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  function runReverseQuery() {
    el.pairMessage.textContent = '';
    if (!state.lastSuccess || !state.optimizer) {
      el.pairMessage.textContent = '请先得到一次成功层序。';
      return;
    }

    const a = Number(el.pairASelect.value);
    const b = Number(el.pairBSelect.value);
    state.pairA = a;
    state.pairB = b;

    if (!a || !b || a === b) {
      state.reverse = null;
      el.pairMessage.textContent = '请选择两个不同的层。';
      renderReverse();
      return;
    }

    const orderLayers = state.lastSuccess.result.orderLayers;
    const posA = orderLayers.indexOf(a);
    const posB = orderLayers.indexOf(b);
    const currentTop = posA < posB ? a : b;
    const currentBottom = posA < posB ? b : a;

    // Current top is above current bottom. Reverse means current bottom above current top.
    const reversedEdge = [currentBottom - 1, currentTop - 1];
    const baseEdges = state.locks.map((lock) => [lock.above - 1, lock.below - 1]);
    const baseCycle = findCycle(state.data.layerCount, baseEdges);

    if (baseCycle) {
      state.reverse = {
        ok: false,
        a,
        b,
        currentTop,
        currentBottom,
        reversedEdge,
        baseCycle: true,
        cycle: { cycleLayers: baseCycle.map((layer) => layer + 1) },
      };
      renderReverse();
      return;
    }

    const result = state.optimizer.solve(baseEdges.concat([reversedEdge]));
    if (!result.ok) {
      state.reverse = {
        ok: false,
        a,
        b,
        currentTop,
        currentBottom,
        reversedEdge,
        baseCycle: false,
        cycle: result,
      };
    } else {
      const evaluation = state.optimizer.evaluate(result.order);
      state.reverse = {
        ok: true,
        a,
        b,
        currentTop,
        currentBottom,
        reversedEdge,
        result,
        evaluation,
        delta: evaluation.score - state.lastSuccess.evaluation.score,
      };
    }

    renderReverse();
    if (state.reverse.ok) {
      requestAnimationFrame(() => {
        if (typeof el.reverseMapCard.scrollIntoView === 'function') {
          el.reverseMapCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }
  }

  function renderReverse() {
    const reverse = state.reverse;
    if (!reverse) {
      el.reverseSummary.hidden = true;
      el.reverseSummary.innerHTML = '';
      el.reverseMapCard.hidden = true;
      return;
    }

    el.reverseSummary.hidden = false;
    el.reverseSummary.innerHTML = '';

    if (!reverse.ok) {
      el.reverseSummary.className = 'reverse-summary bad';
      const title = document.createElement('h3');
      title.textContent = reverse.baseCycle
        ? '当前锁定本身有环，暂时无法反转查询'
        : `反转第 ${reverse.a}、${reverse.b} 层后无解`;
      const text = document.createElement('p');
      text.className = 'alert-text';
      text.textContent = reverse.baseCycle
        ? '左侧当前锁定已经包含下面的环。请先删除环中关系，再查询反转后的全局最小代价；上次成功结果仍保留。'
        : `当前成功层序中第 ${reverse.currentTop} 层在第 ${reverse.currentBottom} 层之上；` +
          `加入“第 ${reverse.currentBottom} 层在第 ${reverse.currentTop} 层之上”后形成锁定环。`;
      const chain = document.createElement('div');
      chain.className = 'cycle-chain';
      appendCycleChain(chain, reverse.cycle);
      el.reverseSummary.append(title, text, chain);
      el.reverseMapCard.hidden = true;
      return;
    }

    el.reverseSummary.className = 'reverse-summary good';
    const title = document.createElement('h3');
    title.textContent = '反转约束下的全局最优解';
    const text = document.createElement('p');
    text.className = 'card-note';
    text.style.marginBottom = '8px';
    text.textContent =
      `已强制第 ${reverse.currentBottom} 层位于第 ${reverse.currentTop} 层之上，并重新满足全部当前锁定。`;

    const order = document.createElement('div');
    order.className = 'reverse-order';
    reverse.result.orderLayers.forEach((layer, index) => {
      if (index > 0) {
        const arrow = document.createElement('span');
        arrow.textContent = '→';
        arrow.setAttribute('aria-hidden', 'true');
        order.appendChild(arrow);
      }
      order.appendChild(layerBadge(layer, 'layer-badge'));
    });

    const stats = document.createElement('div');
    stats.className = 'reverse-stats';
    stats.innerHTML =
      `<span>最小总分 <strong>${formatScore(reverse.evaluation.score)}</strong></span>` +
      `<span>失配点 <strong>${reverse.evaluation.mismatchCount}</strong></span>` +
      `<span>相对当前最优 <strong>${reverse.delta >= 0 ? '+' : ''}${formatScore(reverse.delta)}</strong></span>`;

    el.reverseSummary.append(title, text, order, stats);

    el.reverseMapCard.hidden = false;
    el.reverseMapTitle.textContent = `反转方案失配图：第 ${reverse.currentBottom} 层在上`;
    el.reverseMapSubtitle.textContent =
      `总分 ${formatScore(reverse.evaluation.score)} · ${reverse.evaluation.mismatchCount} 个失配点`;
    paintReverseMismatchCanvas(reverse.evaluation);
  }

  function paintReverseMismatchCanvas(evaluation) {
    paintCanvas(el.reverseMismatchCanvas, (p) => (
      evaluation.mismatch[p] ? MISMATCH_RGB : MATCH_RGB
    ));
  }

  function onMapPointer(event) {
    if (!state.data || !state.lastSuccess) return;
    const canvas = event.currentTarget;
    const point = pixelFromEvent(canvas, event);
    if (!point) return;

    const scheme = schemeForCanvas(canvas);
    if (!scheme) return;

    renderInspector(point.p, scheme);
    renderTooltip(event, point, scheme);
  }

  function schemeForCanvas(canvas) {
    if (canvas.dataset.map === 'prediction') {
      return {
        name: '当前成功预测',
        evaluation: state.lastSuccess.evaluation,
        orderLayers: state.lastSuccess.result.orderLayers,
      };
    }
    if (canvas.dataset.map === 'mismatch') {
      return {
        name: '当前失配图',
        evaluation: state.lastSuccess.evaluation,
        orderLayers: state.lastSuccess.result.orderLayers,
      };
    }
    if (canvas.dataset.map === 'reverseMismatch' && state.reverse && state.reverse.ok) {
      return {
        name: '反转方案',
        evaluation: state.reverse.evaluation,
        orderLayers: state.reverse.result.orderLayers,
      };
    }
    return null;
  }

  function pixelFromEvent(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * state.data.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * state.data.height);
    if (x < 0 || y < 0 || x >= state.data.width || y >= state.data.height) return null;
    return { x, y, p: y * state.data.width + x };
  }

  function pixelDetails(p, scheme) {
    const data = state.data;
    const cover = data.cover[p];
    const coverLayers = [];
    for (let layer = 1; layer <= data.layerCount; layer += 1) {
      if (cover & (1 << (layer - 1))) coverLayers.push(layer);
    }
    return {
      index: p,
      x: p % data.width,
      y: Math.floor(p / data.width),
      cover,
      coverLayers,
      observed: data.observed[p],
      weight: data.weight[p],
      predicted: scheme.evaluation.prediction[p],
      mismatch: scheme.evaluation.mismatch[p] === 1,
      cost: scheme.evaluation.pixelCost[p],
      schemeName: scheme.name,
    };
  }

  function renderInspector(p, scheme) {
    const d = pixelDetails(p, scheme);
    el.pixelInspector.innerHTML =
      `<div class="inspector-grid">
        <div class="inspector-item"><span>位置 / 序号</span><strong>(${d.x}, ${d.y}) · #${d.index}</strong></div>
        <div class="inspector-item"><span>${escapeHTML(d.schemeName)}预测</span><strong>第 ${d.predicted} 层${d.predicted === 0 ? ' / 空白' : ''}</strong></div>
        <div class="inspector-item"><span>实测 observed</span><strong>第 ${d.observed} 层${d.observed === 0 ? ' / 空白' : ''}</strong></div>
        <div class="inspector-item ${d.mismatch ? 'bad' : 'good'}"><span>判定</span><strong>${d.mismatch ? `失配 · 计 ${d.cost}` : '匹配 · 0'}</strong></div>
        <div class="inspector-item"><span>信任权 weight</span><strong>${d.weight}</strong></div>
        <div class="inspector-item"><span>覆盖层 (cover=${d.cover})</span><strong>${d.coverLayers.length ? d.coverLayers.join(', ') : '无覆盖'}</strong></div>
      </div>`;
  }

  function renderTooltip(event, point, scheme) {
    const d = pixelDetails(point.p, scheme);
    el.tooltip.hidden = false;
    el.tooltip.innerHTML =
      `<strong>(${d.x}, ${d.y}) · ${escapeHTML(d.schemeName)}</strong><br>` +
      `预测：<strong>${d.predicted === 0 ? '0 空白' : `第 ${d.predicted} 层`}</strong> · ` +
      `实测：<strong>${d.observed === 0 ? '0 空白' : `第 ${d.observed} 层`}</strong><br>` +
      `覆盖：${d.coverLayers.length ? d.coverLayers.join(', ') : '无'} · 权 ${d.weight}<br>` +
      `<span class="${d.mismatch ? 'bad' : 'good'}">${d.mismatch ? `失配，计 ${d.cost}` : '匹配'}</span>`;

    const width = el.tooltip.offsetWidth || 240;
    const height = el.tooltip.offsetHeight || 90;
    let left = event.clientX + 15;
    let top = event.clientY + 15;
    if (left + width > window.innerWidth - 8) left = event.clientX - width - 15;
    if (top + height > window.innerHeight - 8) top = event.clientY - height - 15;
    el.tooltip.style.left = `${Math.max(8, left)}px`;
    el.tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    el.tooltip.hidden = true;
  }

  function buildExportPayload() {
    if (!state.lastSuccess || !state.data) return null;
    const { data, lastSuccess } = state;
    return {
      schema: 'imprint-stack-result/v1',
      exportedAt: new Date().toISOString(),
      sourceFile: state.sourceName,
      width: data.width,
      height: data.height,
      layers: data.layerCount,
      orderTopToBottom: lastSuccess.result.orderLayers,
      order: lastSuccess.result.orderLayers,
      totalScore: lastSuccess.evaluation.score,
      score: lastSuccess.evaluation.score,
      dpScore: lastSuccess.result.score,
      mismatchPixelCount: lastSuccess.evaluation.mismatchCount,
      locks: lastSuccess.locks.map(({ above, below }) => ({ above, below })),
      predictions: Array.from(lastSuccess.evaluation.prediction),
      mismatch: Array.from(lastSuccess.evaluation.mismatch),
      mismatchCosts: Array.from(lastSuccess.evaluation.pixelCost),
      observed: Array.from(data.observed),
      cover: Array.from(data.cover),
      weight: Array.from(data.weight),
    };
  }

  function exportJSON() {
    const payload = buildExportPayload();
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, exportFileName('result.json'));
    showToast('已导出成功层序与逐像素 JSON');
  }

  async function copyJSON() {
    const payload = buildExportPayload();
    if (!payload) return;
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      showToast('结果 JSON 已复制到剪贴板');
    } catch (_error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_e) { copied = false; }
      textarea.remove();
      showToast(copied ? '结果 JSON 已复制' : '复制被浏览器拒绝，请使用“结果 JSON”导出', 4200);
    }
  }

  function exportCSV() {
    if (!state.lastSuccess || !state.data) return;
    const { data, lastSuccess } = state;
    const evaluation = lastSuccess.evaluation;
    const chunks = ['index,x,y,coverMask,coverLayers,observed,predicted,mismatch,weight,mismatchCost\n'];
    let buffer = [];

    for (let p = 0; p < data.pixelCount; p += 1) {
      const coverLayers = [];
      for (let layer = 1; layer <= data.layerCount; layer += 1) {
        if (data.cover[p] & (1 << (layer - 1))) coverLayers.push(layer);
      }
      buffer.push([
        p,
        p % data.width,
        Math.floor(p / data.width),
        data.cover[p],
        `"${coverLayers.join('|')}"`,
        data.observed[p],
        evaluation.prediction[p],
        evaluation.mismatch[p],
        data.weight[p],
        evaluation.pixelCost[p],
      ].join(','));

      if (buffer.length >= 5000) {
        chunks.push(`${buffer.join('\n')}\n`);
        buffer = [];
      }
    }

    if (buffer.length) chunks.push(buffer.join('\n'));
    const blob = new Blob(chunks, { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, exportFileName('pixels.csv'));
    showToast('已导出逐像素 CSV');
  }

  function exportFileName(suffix) {
    const base = (state.sourceName || 'imprint-stack')
      .replace(/\.json$/i, '')
      .replace(/[^\w一-鿿.-]+/g, '_');
    return `${base}.${suffix}`;
  }

  function downloadCanvas(canvas, suffix) {
    if (!state.lastSuccess) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('PNG 导出失败，请重试', 4200);
        return;
      }
      downloadBlob(blob, exportFileName(suffix));
      showToast(`已导出 ${suffix}`);
    }, 'image/png');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function showToast(message, duration = 2800) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, duration);
  }

  function formatScore(value) {
    if (Number.isInteger(value)) return value.toLocaleString('zh-CN');
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  }

  function formatTime(date) {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function hexToRgb(hex) {
    const normalized = hex.replace('#', '');
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }

  // Small debugging/automation surface.
  window.ImprintStackApp = {
    state,
    loadDataset,
    runSolve,
    runReverseQuery,
    buildExportPayload,
  };
})();
