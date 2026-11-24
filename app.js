/* global NestedGlass */
'use strict';

const GT = window.NestedGlass;

const FALLBACK_SAMPLE = {
  size: [1, 1],
  depth: 4,
  background: [1, 1, 1],
  spheres: [{ id: 1, c: [0, 0, 0], r: 1, n: 1.4, sigma: [0.1, 0.2, 0] }],
  rays: [[[-3, 0, 0], [1, 0, 0]]]
};

const $ = (id) => document.getElementById(id);
const els = {
  statusPill: $('statusPill'),
  loadSampleBtn: $('loadSampleBtn'),
  fileInput: $('fileInput'),
  exportPng: $('exportPng'),
  exportJson: $('exportJson'),
  depthRange: $('depthRange'),
  depthValue: $('depthValue'),
  errorPanel: $('errorPanel'),
  errorMessage: $('errorMessage'),
  errorList: $('errorList'),
  closeError: $('closeError'),
  canvasFrame: $('canvasFrame'),
  view: $('view'),
  overlay: $('overlay'),
  renderBadge: $('renderBadge'),
  renderBadgeText: $('renderBadgeText'),
  progressBar: $('progressBar'),
  pixelReadout: $('pixelReadout'),
  residualOverlay: $('residualOverlay'),
  statRays: $('statRays'),
  statSpheres: $('statSpheres'),
  statEscapes: $('statEscapes'),
  statResidualBranches: $('statResidualBranches'),
  statResidualRgb: $('statResidualRgb'),
  statTir: $('statTir'),
  inspectorEmpty: $('inspectorEmpty'),
  inspectorContent: $('inspectorContent'),
  selectedSwatch: $('selectedSwatch'),
  selectedTitle: $('selectedTitle'),
  selectedRgb: $('selectedRgb'),
  selectedResidual: $('selectedResidual'),
  branchTree: $('branchTree'),
  exportPixelJson: $('exportPixelJson'),
  copyPixelJson: $('copyPixelJson'),
  pixelJson: $('pixelJson'),
  mapCanvas: $('mapCanvas'),
  sceneSummary: $('sceneSummary'),
  sphereList: $('sphereList'),
  clearSphere: $('clearSphere'),
  toast: $('toast')
};

const viewCtx = els.view.getContext('2d', { willReadFrequently: false });
const overlayCtx = els.overlay.getContext('2d');
const mapCtx = els.mapCanvas.getContext('2d');

const state = {
  raw: null,
  scene: null,
  depth: 4,
  sourceName: 'nested-glass.json',
  selectedIndex: 0,
  selectedTrace: null,
  selectedSphereId: null,
  activeNodeId: null,
  mapAxis: 'xy',
  renderToken: 0,
  renderPromise: null,
  summary: null,
  residualByPixel: [],
  overlayCss: { w: 1, h: 1 },
  mapView: { w: 680, h: 420, dpr: 1 },
  depthTimer: null
};

function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? ' error' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

function setStatus(text, mode) {
  els.statusPill.textContent = text;
  els.statusPill.className = `status-pill${mode ? ` ${mode}` : ''}`;
}

function baseFileName() {
  return (state.sourceName || 'nested-glass.json').replace(/\.json$/i, '') || 'nested-glass';
}

function fmt(n) {
  if (n === null || n === undefined) return '–';
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-12) return '0';
  if (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e5) return n.toExponential(2);
  return String(Number(n.toPrecision(6)));
}

function fmtVec(v) {
  return `[${(v || []).map(fmt).join(', ')}]`;
}

function fmtWeight(w) {
  return `[${(w || []).map((x) => fmt(x)).join(', ')}]`;
}

function mediumLabel(m) {
  if (!m || m.id === null || m.id === undefined) return '空气(n=1)';
  return `#${m.id}(n=${fmt(m.n)})`;
}

function channelFragment(w) {
  const frag = document.createDocumentFragment();
  [['r', 0], ['g', 1], ['b', 2]].forEach(([cls, i]) => {
    const span = document.createElement('span');
    span.className = `ch ${cls}`;
    span.textContent = fmt(w ? w[i] : 0);
    frag.appendChild(span);
  });
  return frag;
}

function showError(err) {
  els.errorPanel.hidden = false;
  els.errorMessage.textContent = err && err.message ? err.message : String(err);
  els.errorList.innerHTML = '';
  const conflicts = err && err.sphereConflicts ? err.sphereConflicts : (err && err.details && err.details.sphereConflicts) || [];
  for (const c of conflicts) {
    const li = document.createElement('li');
    li.textContent = `球 #${c.a} ↔ #${c.b}：${GT.geometryKindLabel(c.kind)}，关系距离 d=${fmt(c.d)}，间隙=${fmt(c.clearance)}`;
    els.errorList.appendChild(li);
  }
  setStatus('导入失败 · 旧图保留', 'error');
  toast('JSON 未通过校验，当前画面保持不变', true);
}

function hideError() {
  els.errorPanel.hidden = true;
}

function acceptScene(raw, sourceName) {
  let scene;
  try {
    scene = GT.normalizeScene(raw);
  } catch (err) {
    showError(err);
    return false;
  }

  hideError();
  state.raw = raw;
  state.scene = scene;
  state.sourceName = sourceName || 'nested-glass.json';
  state.depth = scene.depth;
  state.selectedIndex = 0;
  state.selectedTrace = null;
  state.selectedSphereId = null;
  els.depthRange.value = String(state.depth);
  els.depthValue.textContent = String(state.depth);
  els.exportPng.disabled = false;
  els.exportJson.disabled = false;
  els.canvasFrame.classList.add('has-image');

  renderSphereList();
  updateSceneSummary();
  setStatus(`${scene.spheres.length} 球 · ${scene.rays.length} 射线`, 'ready');
  startRender();
  return true;
}

async function loadSampleFromServer() {
  if (location.protocol === 'file:') {
    acceptScene(FALLBACK_SAMPLE, 'samples/nested-glass.json');
    return;
  }
  try {
    const res = await fetch('samples/nested-glass.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    acceptScene(raw, 'nested-glass.json');
  } catch (err) {
    // file:// or static server root mismatch: use the identical built-in sample.
    acceptScene(FALLBACK_SAMPLE, 'samples/nested-glass.json');
  }
}

function readJsonFile(file) {
  file.text().then((text) => {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      showError(new GT.SceneValidationError(`JSON 解析失败：${err.message}`));
      return;
    }
    acceptScene(raw, file.name);
  }).catch((err) => showError(err));
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function startRender() {
  if (!state.scene) return;
  const token = ++state.renderToken;
  const scene = state.scene;
  const depth = state.depth;
  const width = scene.width;
  const height = scene.height;
  const total = scene.rays.length;

  els.renderBadge.hidden = false;
  els.renderBadgeText.textContent = `追迹 0/${total}`;
  els.progressBar.style.width = '0%';
  setStatus('追迹中…', 'busy');

  state.renderPromise = (async () => {
    els.view.width = width;
    els.view.height = height;
    const imageData = viewCtx.createImageData(width, height);
    const residualByPixel = new Array(total);
    const summary = {
      escapes: 0,
      residualBranches: 0,
      events: 0,
      tir: 0,
      residual: [0, 0, 0]
    };

    let i = 0;
    while (i < total) {
      const chunkStart = performance.now();
      while (i < total && performance.now() - chunkStart < 18) {
        const pixel = [i % width, Math.floor(i / width)];
        const result = GT.traceRay(scene, scene.rays[i], depth, {
          detail: false,
          rayIndex: i,
          pixel
        });
        const q = result.rgb255;
        const k = i * 4;
        imageData.data[k] = q[0];
        imageData.data[k + 1] = q[1];
        imageData.data[k + 2] = q[2];
        imageData.data[k + 3] = 255;

        summary.escapes += result.stats.escapes;
        summary.residualBranches += result.stats.residualBranches;
        summary.events += result.stats.events;
        summary.tir += result.stats.tir;
        for (let c = 0; c < 3; c++) summary.residual[c] += result.residual[c];
        residualByPixel[i] = result.residual.slice();
        i++;
      }

      els.progressBar.style.width = `${(i / total) * 100}%`;
      els.renderBadgeText.textContent = `追迹 ${i}/${total}`;
      await nextTask();
      if (token !== state.renderToken) return;
    }

    viewCtx.putImageData(imageData, 0, 0);
    state.summary = summary;
    state.residualByPixel = residualByPixel;
    updateStats();

    if (state.selectedIndex >= total) state.selectedIndex = 0;
    selectPixel(state.selectedIndex);
    resizeOverlay();
    drawMap();

    els.renderBadge.hidden = true;
    els.progressBar.style.width = '100%';
    setStatus(`完成 · 深度 ${depth}`, 'ready');
  })();

  try {
    await state.renderPromise;
  } finally {
    if (token === state.renderToken) state.renderPromise = null;
  }
}

function updateStats() {
  const s = state.scene;
  const sum = state.summary;
  if (!s || !sum) return;
  els.statRays.textContent = `${s.rays.length} / ${s.width}×${s.height}`;
  els.statSpheres.textContent = String(s.spheres.length);
  els.statEscapes.textContent = String(sum.escapes);
  els.statResidualBranches.textContent = String(sum.residualBranches);
  els.statResidualRgb.textContent = fmtWeight(sum.residual.map((x) => Number(x.toPrecision(4))));
  els.statResidualRgb.title = fmtWeight(sum.residual);
  els.statTir.textContent = `${sum.tir} / ${sum.events}`;
}

function updateSceneSummary() {
  const s = state.scene;
  if (!s) {
    els.sceneSummary.textContent = '';
    return;
  }
  const nested = s.spheres.filter((x) => s.parent.get(x.id) !== null).length;
  els.sceneSummary.innerHTML =
    `当前文件 <strong>${state.sourceName}</strong>；` +
    `${s.spheres.length} 球（${nested} 个嵌套子球）、${s.rays.length} 射线、` +
    `背景 ${fmtVec(s.background)}。最内包含球决定介质。`;
}

function sphereColor(sphere) {
  const hue = (200 + Number(String(sphere.id).split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) * 37) % 130) % 360;
  return `hsl(${hue} 85% 68%)`;
}

function renderSphereList() {
  const s = state.scene;
  els.sphereList.innerHTML = '';
  if (!s) return;

  for (const sphere of s.spheres) {
    const parentId = s.parent.get(sphere.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sphere-card';
    card.dataset.sphereId = String(sphere.id);
    card.style.setProperty('--sphere-color', sphereColor(sphere));
    card.setAttribute('aria-pressed', 'false');

    const head = document.createElement('div');
    head.className = 'sphere-card-head';
    const idLine = document.createElement('span');
    idLine.className = 'sphere-id';
    idLine.innerHTML = `<span class="sphere-dot"></span>球 #${sphere.id}`;
    const parent = document.createElement('span');
    parent.className = 'parent-pill';
    parent.textContent = parentId === null || parentId === undefined ? '顶层介质边界' : `嵌套于 #${parentId}`;
    head.append(idLine, parent);

    const props = document.createElement('div');
    props.className = 'sphere-props';
    props.innerHTML =
      `<div><span>c</span>${fmtVec(sphere.c)}</div>` +
      `<div><span>r</span>${fmt(sphere.r)}</div>` +
      `<div><span>n</span>${fmt(sphere.n)}</div>` +
      `<div><span>id</span>${String(sphere.id)}</div>`;

    const sigma = document.createElement('div');
    sigma.className = 'sigma-bar';
    const label = document.createElement('span');
    label.style.color = 'var(--faint)';
    label.textContent = 'sigma';
    const channels = document.createElement('span');
    channels.className = 'sigma-channels';
    sphere.sigma.forEach((x, i) => {
      const bar = document.createElement('i');
      const colors = ['#fb7185', '#34d399', '#60a5fa'];
      bar.style.background = colors[i];
      bar.style.width = `${Math.max(3, (Math.log10(1 + x) / 6) * 100)}%`;
      bar.title = `sigma${'RGB'[i]}=${x}`;
      channels.appendChild(bar);
    });
    sigma.append(label, channels);
    props.appendChild(sigma);

    card.append(head, props);
    card.addEventListener('click', () => selectSphere(sphere.id));
    els.sphereList.appendChild(card);
  }
}

function selectSphere(id, options) {
  state.selectedSphereId = id;
  document.querySelectorAll('.sphere-card').forEach((card) => {
    const selected = card.dataset.sphereId === String(id);
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', selected ? 'true' : 'false');
    if (selected && options && options.flash !== false) {
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
      if (options.scroll !== false) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  drawMap();
}

els.clearSphere.addEventListener('click', () => {
  state.selectedSphereId = null;
  document.querySelectorAll('.sphere-card').forEach((c) => {
    c.classList.remove('selected', 'flash');
    c.setAttribute('aria-pressed', 'false');
  });
  drawMap();
});

function eventSphereButton(event) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'locate-btn';
  btn.textContent = `定位球面 #${event.sphereId}`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectSphere(event.sphereId, { scroll: true });
    toast(`已定位球 #${event.sphereId}`);
  });
  return btn;
}

function makeTerm(term, valueNode) {
  const wrap = document.createElement('div');
  wrap.style.display = 'contents';
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  if (typeof valueNode === 'string') dd.textContent = valueNode;
  else if (valueNode) dd.appendChild(valueNode);
  wrap.append(dt, dd);
  return wrap;
}

function renderNode(node, depth) {
  const details = document.createElement('details');
  details.className = `branch-node kind-${node.kind} outcome-${node.outcome}`;
  details.open = depth < 2 || node.outcome === 'residual' || node.outcome === 'escape';

  const summary = document.createElement('summary');
  summary.className = 'branch-row';

  const titleLine = document.createElement('div');
  titleLine.className = 'branch-title-line';
  const badge = document.createElement('span');
  badge.className = `badge ${node.kind}`;
  badge.textContent = node.kind === 'root' ? 'RAY' : node.kind;
  titleLine.appendChild(badge);

  const outcome = document.createElement('span');
  outcome.className = `outcome-tag ${node.outcome}`;
  outcome.textContent = ({
    escape: '逃逸 → background',
    residual: '深度余量',
    event: 'Fresnel 分裂',
    zero: '零权终止',
    pending: '待追迹'
  })[node.outcome] || node.outcome;
  titleLine.appendChild(outcome);

  const id = document.createElement('span');
  id.className = 'branch-id';
  id.textContent = node.id;
  titleLine.appendChild(id);

  if (node.event) titleLine.appendChild(eventSphereButton(node.event));

  const titleMetrics = document.createElement('div');
  titleMetrics.className = 'tiny mono';
  titleMetrics.style.color = 'var(--muted)';
  if (node.end) {
    titleMetrics.textContent = `t=${fmt(node.t)} · ${mediumLabel(node.medium)} → ${node.event ? mediumLabel(node.event.outMedium) : '?'}`;
  } else if (node.outcome === 'escape') {
    titleMetrics.textContent = `无下一击 · ${mediumLabel(node.medium)} · 已逃逸`;
  } else {
    titleMetrics.textContent = mediumLabel(node.medium);
  }

  summary.append(titleLine, titleMetrics);
  details.appendChild(summary);

  const grid = document.createElement('dl');
  grid.className = 'branch-grid';
  grid.appendChild(makeTerm('起点', fmtVec(node.start)));
  if (node.end) {
    grid.appendChild(makeTerm('终点', `${fmtVec(node.end)}（t=${fmt(node.t)}）`));
  } else {
    const dirEnd = node.start.map((x, i) => x + node.direction[i]);
    grid.appendChild(makeTerm('终点', `∞ 方向 ${fmtVec(node.direction)}；示意方向点 ${fmtVec(dirEnd)}`));
  }
  grid.appendChild(makeTerm('段内介质', mediumLabel(node.medium)));
  grid.appendChild(makeTerm('起始权重', channelFragment(node.startWeight)));
  if (node.outcome === 'residual') {
    grid.appendChild(makeTerm('余量口径', '原权重；不传播到候选击'));
    grid.appendChild(makeTerm('计入余量', channelFragment(node.residual || node.startWeight)));
    if (node.pendingHit) {
      grid.appendChild(makeTerm('候选下一击', `球 #${node.pendingHit.sphereId}，t=${fmt(node.candidateT || node.t)}`));
      grid.appendChild(makeTerm('候选段吸收', channelFragment(node.candidateAttenuation || node.attenuation)));
      grid.appendChild(makeTerm('若衰减到击', channelFragment(node.residualArrived || node.endWeight)));
    }
  } else if (node.end && node.attenuation.some((x) => Math.abs(x - 1) > 1e-12)) {
    grid.appendChild(makeTerm('吸收 exp', channelFragment(node.attenuation)));
    grid.appendChild(makeTerm('到达权重', channelFragment(node.endWeight)));
  }
  if (node.outcome !== 'residual' && node.residual) grid.appendChild(makeTerm('计入余量', channelFragment(node.residual)));
  if (node.escapeContribution) grid.appendChild(makeTerm('背景贡献', channelFragment(node.escapeContribution)));

  if (node.event) {
    const ev = node.event;
    grid.appendChild(makeTerm('入/出介质', `${mediumLabel(ev.mediumIn)} → ${mediumLabel(ev.mediumOut)}`));
    grid.appendChild(makeTerm('cosI / eta', `${fmt(ev.cosI)} / ${fmt(ev.eta)}`));
    grid.appendChild(makeTerm('Fresnel F', ev.tir ? '1（全反射，仅 R）' : fmt(ev.F)));
    if (!ev.tir) grid.appendChild(makeTerm('cosT', fmt(ev.cosT)));
    grid.appendChild(makeTerm('法向(朝入射侧)', fmtVec(ev.normal)));
    grid.appendChild(makeTerm('入射侧判定', ev.entering ? '从球外穿入该球' : '从球内穿出该球'));
  }
  details.appendChild(grid);

  if (node.children && node.children.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'branch-children';
    for (const child of node.children) childWrap.appendChild(renderNode(child, depth + 1));
    details.appendChild(childWrap);
  }

  details.addEventListener('mouseenter', () => {
    state.activeNodeId = node.id;
    drawMap();
  });
  details.addEventListener('mouseleave', () => {
    if (state.activeNodeId === node.id) {
      state.activeNodeId = null;
      drawMap();
    }
  });

  return details;
}

function selectPixel(index) {
  if (!state.scene || index < 0 || index >= state.scene.rays.length) return;
  state.selectedIndex = index;
  const width = state.scene.width;
  const pixel = [index % width, Math.floor(index / width)];
  state.selectedTrace = GT.traceRay(state.scene, state.scene.rays[index], state.depth, {
    detail: true,
    rayIndex: index,
    pixel
  });

  els.inspectorEmpty.hidden = true;
  els.inspectorContent.hidden = false;
  els.selectedTitle.textContent = `像素 (${pixel[0]}, ${pixel[1]}) · ray #${index}`;
  const q = state.selectedTrace.rgb255;
  els.selectedSwatch.style.background = `rgb(${q[0]},${q[1]},${q[2]})`;
  els.selectedRgb.textContent = `linear ${fmtWeight(state.selectedTrace.rgb)} · PNG rgb(${q.join(', ')}) #${q.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  els.selectedResidual.textContent = `余量 ${fmtWeight(state.selectedTrace.residual)} · ${state.selectedTrace.stats.residualBranches} 支未逃逸`;
  els.pixelReadout.textContent = `已选像素 (${pixel[0]}, ${pixel[1]})：RGB ${q.join('/')}，余量 ${fmtWeight(state.selectedTrace.residual)}`;

  els.branchTree.innerHTML = '';
  els.branchTree.appendChild(renderNode(state.selectedTrace.tree, 0));
  els.pixelJson.textContent = JSON.stringify(state.selectedTrace, null, 2);

  resizeOverlay();
  drawOverlay();
  drawMap();

  if (window.matchMedia('(max-width: 980px)').matches) {
    document.querySelector('.inspector-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

els.view.addEventListener('click', (event) => {
  if (!state.scene) return;
  const rect = els.view.getBoundingClientRect();
  const px = Math.floor(((event.clientX - rect.left) / rect.width) * els.view.width);
  const py = Math.floor(((event.clientY - rect.top) / rect.height) * els.view.height);
  if (px < 0 || py < 0 || px >= els.view.width || py >= els.view.height) return;
  selectPixel(py * els.view.width + px);
});

els.depthRange.addEventListener('input', () => {
  state.depth = Number(els.depthRange.value);
  els.depthValue.textContent = String(state.depth);
  clearTimeout(state.depthTimer);
  state.depthTimer = setTimeout(() => startRender(), 150);
});

els.residualOverlay.addEventListener('change', drawOverlay);
els.closeError.addEventListener('click', hideError);
els.loadSampleBtn.addEventListener('click', loadSampleFromServer);

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) readJsonFile(file);
  els.fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) readJsonFile(file);
});

els.exportPng.addEventListener('click', async () => {
  if (!state.scene) return;
  if (state.renderPromise) await state.renderPromise;
  els.view.toBlob((blob) => {
    if (!blob) {
      toast('PNG 导出失败', true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseFileName()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('PNG 已导出（linear clamp + round）');
  }, 'image/png');
});

els.exportJson.addEventListener('click', () => {
  if (!state.scene) return;
  const old = els.exportJson.textContent;
  els.exportJson.disabled = true;
  els.exportJson.textContent = '生成 JSON…';
  setTimeout(() => {
    try {
      const data = GT.buildExport(state.scene, { depth: state.depth, sourceFile: state.sourceName });
      GT.downloadJsonValue(data, `${baseFileName()}-paths.json`);
      toast(`已导出 ${data.rays.length} 条射线的完整光路 JSON`);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      els.exportJson.disabled = false;
      els.exportJson.textContent = old;
    }
  }, 30);
});

els.exportPixelJson.addEventListener('click', () => {
  if (!state.scene || state.selectedIndex === null) return;
  const data = GT.buildExport(state.scene, {
    depth: state.depth,
    sourceFile: state.sourceName,
    rayIndices: [state.selectedIndex]
  });
  GT.downloadJsonValue(data, `${baseFileName()}-pixel-${state.selectedIndex}.json`);
  toast('当前像素光路 JSON 已导出');
});

els.copyPixelJson.addEventListener('click', async () => {
  if (!state.selectedTrace) return;
  const text = JSON.stringify(state.selectedTrace, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('当前像素 JSON 已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('当前像素 JSON 已复制');
  }
});

function resizeOverlay() {
  const rect = els.view.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  els.overlayCss = { w: rect.width, h: rect.height };
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

function drawOverlay() {
  const { w, h } = els.overlayCss;
  overlayCtx.clearRect(0, 0, w, h);
  if (!state.scene) return;
  const W = state.scene.width;
  const H = state.scene.height;
  const cw = w / W;
  const ch = h / H;

  if (els.residualOverlay.checked) {
    for (let i = 0; i < state.residualByPixel.length; i++) {
      const r = state.residualByPixel[i];
      if (!r) continue;
      const max = Math.max(r[0], r[1], r[2]);
      if (max <= 1e-9) continue;
      const x = (i % W) * cw;
      const y = Math.floor(i / W) * ch;
      overlayCtx.fillStyle = 'rgba(251,191,36,.72)';
      const s = Math.max(2, Math.min(cw, ch) * 0.42);
      overlayCtx.fillRect(x + cw - s - 1, y + 1, s, s);
    }
  }

  if (state.selectedIndex !== null && state.selectedIndex < state.scene.rays.length) {
    const x = (state.selectedIndex % W) * cw;
    const y = Math.floor(state.selectedIndex / W) * ch;
    const pad = 1.5;
    overlayCtx.save();
    overlayCtx.strokeStyle = '#67e8f9';
    overlayCtx.lineWidth = 2;
    overlayCtx.shadowColor = 'rgba(103,232,249,.9)';
    overlayCtx.shadowBlur = 10;
    overlayCtx.strokeRect(x + pad, y + pad, Math.max(1, cw - pad * 2), Math.max(1, ch - pad * 2));
    overlayCtx.restore();
  }
}

function setupMapSize() {
  const rect = els.mapCanvas.getBoundingClientRect();
  const cssW = Math.max(280, rect.width || 680);
  const cssH = Math.max(280, Math.min(460, cssW * 0.62));
  const dpr = window.devicePixelRatio || 1;
  state.mapView = { w: cssW, h: cssH, dpr };
  els.mapCanvas.width = Math.round(cssW * dpr);
  els.mapCanvas.height = Math.round(cssH * dpr);
  els.mapCanvas.style.height = `${cssH}px`;
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function projected(p) {
  if (state.mapAxis === 'xy') return [p[0], p[1]];
  if (state.mapAxis === 'xz') return [p[0], p[2]];
  return [p[1], p[2]];
}

function mapTransform() {
  const s = state.scene;
  const { w, h } = state.mapView;
  const pad = 44;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

  function includePoint(p) {
    const [u, v] = projected(p);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }

  for (const sph of s.spheres) {
    const [u, v] = projected(sph.c);
    minU = Math.min(minU, u - sph.r); maxU = Math.max(maxU, u + sph.r);
    minV = Math.min(minV, v - sph.r); maxV = Math.max(maxV, v + sph.r);
  }

  if (state.selectedTrace) {
    let escapeSeen = 0;
    function includeNode(node) {
      if (node.start) includePoint(node.start);
      if (node.end) includePoint(node.end);
      else if (node.direction && escapeSeen < 8) {
        escapeSeen++;
        const center = [(minU + maxU) / 2, (minV + maxV) / 2];
        const range = Math.max(maxU - minU, maxV - minV, 2);
        const p = node.start.map((x, i) => x + node.direction[i] * range * 0.28);
        includePoint(p);
      }
      (node.children || []).forEach(includeNode);
    }
    includeNode(state.selectedTrace.tree);
  }

  if (!Number.isFinite(minU)) { minU = -3; maxU = 3; minV = -3; maxV = 3; }
  if (maxU - minU < 1e-9) { minU -= 1; maxU += 1; }
  if (maxV - minV < 1e-9) { minV -= 1; maxV += 1; }

  const rangeU = maxU - minU;
  const rangeV = maxV - minV;
  const scale = Math.min((w - pad * 2) / rangeU, (h - pad * 2) / rangeV);
  const drawW = rangeU * scale;
  const drawH = rangeV * scale;
  const ox = (w - drawW) / 2;
  const oy = (h - drawH) / 2;

  function toScreen(p) {
    const [u, v] = projected(p);
    return [ox + (u - minU) * scale, oy + (maxV - v) * scale];
  }
  function toWorld(sx, sy) {
    const u = minU + (sx - ox) / scale;
    const v = maxV - (sy - oy) / scale;
    return { u, v };
  }
  return { scale, toScreen, toWorld, minU, maxU, minV, maxV };
}

function drawMapAxes(tr) {
  const { w, h } = state.mapView;
  mapCtx.save();
  mapCtx.strokeStyle = 'rgba(157,175,208,.16)';
  mapCtx.lineWidth = 1;
  const o = tr.toScreen([0, 0, 0]);
  mapCtx.beginPath();
  mapCtx.moveTo(20, o[1]); mapCtx.lineTo(w - 20, o[1]);
  mapCtx.moveTo(o[0], 18); mapCtx.lineTo(o[0], h - 18);
  mapCtx.stroke();

  mapCtx.fillStyle = 'rgba(157,175,208,.55)';
  mapCtx.font = '11px ui-monospace, monospace';
  const labels = state.mapAxis === 'xy' ? ['x', 'y'] : state.mapAxis === 'xz' ? ['x', 'z'] : ['y', 'z'];
  mapCtx.fillText(labels[0], w - 24, o[1] - 6);
  mapCtx.fillText(labels[1], o[0] + 7, 24);
  mapCtx.restore();
}

function drawMapPaths(tr) {
  if (!state.selectedTrace) return;
  const range = Math.max(tr.maxU - tr.minU, tr.maxV - tr.minV, 2);
  function drawNode(node) {
    const a = tr.toScreen(node.start);
    let endPoint = node.end;
    let dashed = false;
    if (!endPoint && node.direction) {
      dashed = true;
      endPoint = node.start.map((x, i) => x + node.direction[i] * range * 0.24);
    }
    if (endPoint) {
      const b = tr.toScreen(endPoint);
      const color = node.kind === 'R' ? '#fbbf24' : node.kind === 'T' ? '#38bdf8' : '#a78bfa';
      const active = state.activeNodeId === node.id;
      mapCtx.save();
      mapCtx.strokeStyle = color;
      mapCtx.globalAlpha = active ? 1 : 0.72;
      mapCtx.lineWidth = active ? 4 : 1.8;
      mapCtx.lineCap = 'round';
      if (dashed) mapCtx.setLineDash([6, 5]);
      mapCtx.shadowColor = color;
      mapCtx.shadowBlur = active ? 16 : 7;
      mapCtx.beginPath();
      mapCtx.moveTo(a[0], a[1]);
      mapCtx.lineTo(b[0], b[1]);
      mapCtx.stroke();
      mapCtx.restore();

      if (node.event) {
        mapCtx.save();
        mapCtx.fillStyle = '#fff';
        mapCtx.strokeStyle = color;
        mapCtx.lineWidth = 2;
        mapCtx.beginPath();
        mapCtx.arc(b[0], b[1], 4.2, 0, Math.PI * 2);
        mapCtx.fill();
        mapCtx.stroke();
        mapCtx.restore();
      }
    }
    (node.children || []).forEach(drawNode);
  }
  drawNode(state.selectedTrace.tree);

  const rootStart = tr.toScreen(state.selectedTrace.origin);
  mapCtx.save();
  mapCtx.fillStyle = '#fff';
  mapCtx.shadowColor = '#a78bfa';
  mapCtx.shadowBlur = 14;
  mapCtx.fillRect(rootStart[0] - 4, rootStart[1] - 4, 8, 8);
  mapCtx.restore();
}

function drawMapSpheres(tr) {
  const s = state.scene;
  for (const sph of s.spheres) {
    const [cx, cy] = tr.toScreen(sph.c);
    const radius = Math.max(5, sph.r * tr.scale);
    const selected = state.selectedSphereId !== null && String(state.selectedSphereId) === String(sph.id);
    const color = sphereColor(sph);

    const grad = mapCtx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.38, radius * 0.1, cx, cy, radius);
    grad.addColorStop(0, 'rgba(255,255,255,.20)');
    grad.addColorStop(0.42, color.replace('hsl', 'hsla').replace(')', ' / .18)'));
    grad.addColorStop(1, color.replace('hsl', 'hsla').replace(')', ' / .05)'));
    mapCtx.save();
    mapCtx.beginPath();
    mapCtx.arc(cx, cy, radius, 0, Math.PI * 2);
    mapCtx.fillStyle = grad;
    mapCtx.fill();
    mapCtx.lineWidth = selected ? 4 : 1.7;
    mapCtx.strokeStyle = selected ? '#ffffff' : color;
    mapCtx.shadowColor = selected ? '#a78bfa' : color;
    mapCtx.shadowBlur = selected ? 24 : 8;
    mapCtx.stroke();

    mapCtx.shadowBlur = 0;
    mapCtx.fillStyle = selected ? '#ffffff' : 'rgba(234,241,255,.92)';
    mapCtx.font = `800 ${Math.max(11, Math.min(15, radius * 0.42))}px ui-sans-serif, system-ui`;
    mapCtx.textAlign = 'center';
    mapCtx.textBaseline = 'middle';
    if (radius >= 16) mapCtx.fillText(`#${sph.id}`, cx, cy);
    else {
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 3, 0, Math.PI * 2);
      mapCtx.fill();
    }
    mapCtx.restore();
  }
}

function drawMap() {
  if (!state.scene) return;
  setupMapSize();
  const { w, h } = state.mapView;
  mapCtx.clearRect(0, 0, w, h);
  const tr = mapTransform();
  drawMapAxes(tr);
  drawMapPaths(tr);
  drawMapSpheres(tr);
}

document.querySelectorAll('[data-axis]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mapAxis = btn.dataset.axis;
    document.querySelectorAll('[data-axis]').forEach((b) => b.classList.toggle('is-active', b === btn));
    drawMap();
  });
});

els.mapCanvas.addEventListener('click', (event) => {
  if (!state.scene) return;
  const rect = els.mapCanvas.getBoundingClientRect();
  const sx = ((event.clientX - rect.left) / rect.width) * state.mapView.w;
  const sy = ((event.clientY - rect.top) / rect.height) * state.mapView.h;
  const tr = mapTransform();
  let hit = null;
  for (const sph of state.scene.spheres) {
    const [cx, cy] = tr.toScreen(sph.c);
    const dist = Math.hypot(sx - cx, sy - cy);
    const radius = Math.max(5, sph.r * tr.scale);
    if (dist <= radius + 7 && (!hit || sph.r < hit.r)) hit = sph;
  }
  if (hit) selectSphere(hit.id, { scroll: true });
});

window.addEventListener('resize', () => {
  resizeOverlay();
  drawMap();
});

if (!GT) {
  setStatus('核心库加载失败', 'error');
  toast('tracer.js 未能加载', true);
} else {
  // Debug/automation handle; the UI remains the primary interface.
  window.__glassApp = {
    GT,
    state,
    acceptScene,
    startRender,
    selectPixel,
    selectSphere
  };
  window.traceNestedGlass = (raw, depth) => {
    const scene = GT.normalizeScene(raw);
    return GT.buildExport(scene, { depth: depth === undefined ? scene.depth : depth });
  };
  loadSampleFromServer();
}
