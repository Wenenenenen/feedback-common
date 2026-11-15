/* 主控制器：文件导入、交互、叠层、预览、探针、导入导出与渲染调度。 */
(function () {
  'use strict';

  const COLORS = ['#5aa2ff', '#ff9d5c', '#b58cff', '#7ce0c0'];
  const CORNER_NAMES = ['左上', '右上', '右下', '左下'];

  const els = {
    surfaceCanvas: document.getElementById('surfaceCanvas'),
    overlayCanvas: document.getElementById('overlayCanvas'),
    surfaceWrap: document.getElementById('surfaceWrap'),
    probeTip: document.getElementById('probeTip'),
    paramsScroll: document.getElementById('paramsScroll'),
    outputsGrid: document.getElementById('outputsGrid'),
    inspector: document.getElementById('inspector'),
    notice: document.getElementById('notice'),
    revisionLabel: document.getElementById('revisionLabel'),
    statusText: document.getElementById('statusText'),
    imageText: document.getElementById('imageText'),
    surfaceMeta: document.getElementById('surfaceMeta')
  };

  let state = null;
  let sampler = null;
  let renderQueued = false;
  let lastRenderedRevision = -1;
  let previewCanvases = {};   // projector id -> { frame, mask }，合成卡另有 composite
  const rendererCache = new WeakMap(); // 每个 canvas 一个独立 WebGL context/Renderer
  let drag = null;            // { projIndex, corner }
  let probePoint = null;

  // 一个 canvas 的 WebGL context 无法迁移，按 canvas 缓存各自的 Renderer
  function rendererFor(canvas) {
    let r = rendererCache.get(canvas);
    if (!r) {
      r = new Renderer.Renderer(canvas);
      rendererCache.set(canvas, r);
    }
    return r;
  }

  function showNotice(type, text, stickyMs = 4000) {
    els.notice.className = 'notice ' + type;
    els.notice.textContent = text;
    if (stickyMs > 0) {
      clearTimeout(showNotice._t);
      showNotice._t = setTimeout(() => els.notice.classList.add('hidden'), stickyMs);
    }
  }

  function clearNotice() {
    els.notice.className = 'notice hidden';
  }

  // ---------- 渲染调度：每帧最多一次，且只渲染最新 revision ----------
  function scheduleRender() {
    if (renderQueued || !state || !state.image) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll(state.revision);
    });
  }

  function renderAll(revAtSchedule) {
    if (!state || state.revision !== revAtSchedule) {
      // 调度期间又有新改动：重新排队，旧结果绝不写入
      scheduleRender();
      return;
    }
    try {
      rendererFor(els.surfaceCanvas).renderSurface(els.surfaceCanvas, state);
      drawOverlay();
      for (const p of state.projectors) {
        const cards = previewCanvases[p.id];
        if (!cards) continue;
        const idx = state.projectors.indexOf(p);
        rendererFor(cards.frame).renderProjector(cards.frame, state, idx, 1);
        if (cards.mask) rendererFor(cards.mask).renderMask(cards.mask, state, idx);
      }
      const comp = previewCanvases.__composite;
      if (comp) rendererFor(comp).renderSurface(comp, state);
      lastRenderedRevision = state.revision;
      if (probePoint) updateInspector(probePoint[0], probePoint[1], true);
    } catch (e) {
      showNotice('error', '渲染失败：' + e.message, 0);
    }
  }

  // ---------- 叠层：四角手柄、连线、探针标记 ----------
  function overlaySize() {
    // 与 WebGL 画布同内在分辨率；仅在尺寸变化时重设，避免无谓清空
    const w = els.surfaceCanvas.width;
    const h = els.surfaceCanvas.height;
    if (els.overlayCanvas.width !== w || els.overlayCanvas.height !== h) {
      els.overlayCanvas.width = w;
      els.overlayCanvas.height = h;
    }
  }

  // 按容器可用宽度与幕布宽高比，给 stage 设定固定 CSS 像素尺寸
  function layoutStage() {
    if (!state) return;
    const stage = document.querySelector('.surface-stage');
    const wrap = els.surfaceWrap;
    const availW = wrap.clientWidth - 28;
    const availH = window.innerHeight * 0.62;
    const [sw, sh] = state.surface;
    const scale = Math.min(availW / sw, availH / sh);
    const cssW = Math.max(1, Math.round(sw * scale));
    const cssH = Math.max(1, Math.round(sh * scale));
    stage.style.width = cssW + 'px';
    stage.style.height = cssH + 'px';
  }

  function drawOverlay() {
    overlaySize();
    const ctx = els.overlayCanvas.getContext('2d');
    const [W, H] = state.surface;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = Math.max(1, W / 400);
    state.projectors.forEach((p, pi) => {
      const color = COLORS[pi % COLORS.length];
      const q = p.pendingQuad || p.quad;
      ctx.strokeStyle = p.invalidReason ? '#ff6b6b' : color;
      ctx.lineWidth = Math.max(1.2, W / 350);
      ctx.beginPath();
      q.forEach((pt, i) => i === 0 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1]));
      ctx.closePath();
      ctx.stroke();
      q.forEach((pt, ci) => {
        const r = Math.max(4, W / 80);
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
        ctx.fillStyle = p.invalidReason ? '#ff6b6b' : color;
        ctx.fill();
        ctx.strokeStyle = '#0c0e12';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    });
    if (probePoint) {
      const [x, y] = probePoint;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      const r = Math.max(5, W / 60);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r - 3, y); ctx.lineTo(x - r + 1, y);
      ctx.moveTo(x + r - 1, y); ctx.lineTo(x + r + 3, y);
      ctx.moveTo(x, y - r - 3); ctx.lineTo(x, y - r + 1);
      ctx.moveTo(x, y + r - 1); ctx.lineTo(x, y + r + 3);
      ctx.stroke();
    }
  }

  // ---------- 参数面板 ----------
  function buildParamsPanel() {
    const root = els.paramsScroll;
    root.innerHTML = '';

    const g = document.createElement('div');
    g.className = 'field-group global-fields';
    g.innerHTML = '<div class="field-title">幕布与羽化</div>';
    const surfRow = document.createElement('div');
    surfRow.className = 'row';
    surfRow.innerHTML = '<label>幕布尺寸</label>' +
      numInput('surfW', state.surface[0], 1) + numInput('surfH', state.surface[1], 1);
    const featherRow = document.createElement('div');
    featherRow.className = 'row single';
    featherRow.innerHTML = '<label>羽化宽度 px</label>' + numInput('feather', state.feather, 0.01);
    g.append(surfRow, featherRow);
    root.appendChild(g);

    state.projectors.forEach((p, pi) => {
      const color = COLORS[pi % COLORS.length];
      const card = document.createElement('div');
      card.className = 'field-group' + (p.invalidReason ? ' invalid' : '');
      card.dataset.projIndex = String(pi);
      card.innerHTML = `
        <div class="field-title"><span class="dot" style="background:${color}"></span>
          <input type="text" class="pid" value="${escapeHtml(p.id)}" aria-label="投影名称">
        </div>
        <div class="row"><label>输出分辨率</label>
          ${numInput('sizeW', p.size[0], 1)}${numInput('sizeH', p.size[1], 1)}
        </div>
        <div class="corner-grid"></div>
        <div class="reason ${p.invalidReason ? '' : 'hidden'}"></div>`;
      const grid = card.querySelector('.corner-grid');
      const quad = p.pendingQuad || p.quad;
      quad.forEach((pt, ci) => {
        const cell = document.createElement('div');
        cell.className = 'corner-cell' + (p.invalidReason ? ' bad' : '');
        cell.innerHTML = `<div class="cap">${CORNER_NAMES[ci]}</div>
          <div class="xy">${numInput('qx', pt[0], 0.01)}${numInput('qy', pt[1], 0.01)}</div>`;
        cell.querySelectorAll('input').forEach((inp) => {
          inp.dataset.corner = String(ci);
        });
        grid.appendChild(cell);
      });
      card.querySelector('.reason').textContent = p.invalidReason || '';
      bindProjectorInputs(card, pi);
      root.appendChild(card);
    });
  }

  function numInput(cls, value, step) {
    return `<input type="number" class="${cls}" step="${step}" value="${roundStr(value)}">`;
  }

  function roundStr(v) {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function bindProjectorInputs(card, pi) {
    card.querySelector('.pid').addEventListener('change', (e) => {
      if (!AppState.setProjectorId(state, pi, e.target.value)) {
        showNotice('warn', '名称无效或与其他投影重复，已还原');
        e.target.value = state.projectors[pi].id;
        return;
      }
      afterStateChanged();
    });
    card.querySelectorAll('.sizeW,.sizeH').forEach((inp) => {
      inp.addEventListener('change', () => {
        const w = parseFloat(card.querySelector('.sizeW').value);
        const h = parseFloat(card.querySelector('.sizeH').value);
        if (!AppState.setProjectorSize(state, pi, w, h)) {
          showNotice('warn', '输出分辨率必须为正整数，已还原');
          inp.value = state.projectors[pi].size[inp.classList.contains('sizeW') ? 0 : 1];
          return;
        }
        afterStateChanged();
      });
    });
    card.querySelectorAll('.corner-cell input').forEach((inp) => {
      inp.addEventListener('change', () => readQuadFromPanel(pi));
      inp.addEventListener('input', () => readQuadFromPanel(pi, true));
    });
  }

  function readQuadFromPanel(pi, live) {
    const card = els.paramsScroll.querySelector(`.field-group[data-proj-index="${pi}"]`);
    const candidate = [[0, 0], [0, 0], [0, 0], [0, 0]];
    let bad = false;
    card.querySelectorAll('.corner-cell').forEach((cell, ci) => {
      const x = parseFloat(cell.querySelector('.qx').value);
      const y = parseFloat(cell.querySelector('.qy').value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) bad = true;
      candidate[ci] = [x, y];
    });
    if (bad) return;
    const ok = AppState.tryUpdateQuad(state, pi, candidate);
    const reasonEl = card.querySelector('.reason');
    if (!ok) {
      card.classList.add('invalid');
      reasonEl.classList.remove('hidden');
      reasonEl.textContent = state.projectors[pi].invalidReason;
      showNotice('error', `投影 ${state.projectors[pi].id}：${state.projectors[pi].invalidReason}，保留上一有效校正`, live ? 1500 : 4000);
      // 非法输入期间画面不更新（state.quad 未变），但叠层显示候选
      drawOverlay();
      return;
    }
    card.classList.remove('invalid');
    reasonEl.classList.add('hidden');
    clearNotice();
    afterStateChanged();
  }

  let lastStageKey = '';
  function afterStateChanged() {
    els.revisionLabel.textContent = '修订 #' + state.revision;
    buildOutputCardsIfNeeded();
    // 仅当幕布尺寸变化时才重算 stage 布局，拖动四角不触发布局漂移
    const key = state.surface[0] + 'x' + state.surface[1];
    if (key !== lastStageKey) {
      lastStageKey = key;
      layoutStage();
    }
    scheduleRender();
  }

  // ---------- 输出预览卡 ----------
  function buildOutputCardsIfNeeded() {
    const grid = els.outputsGrid;
    const want = state.projectors.map((p, i) => 'p:' + p.id)
      .concat(['composite', 'mask0']);
    const have = [...grid.children].map((c) => c.dataset.key);
    if (want.join('|') === have.join('|')) return;

    grid.innerHTML = '';
    previewCanvases = {};
    state.projectors.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'output-card';
      card.dataset.key = 'p:' + p.id;
      card.innerHTML = `<h3><span style="color:${COLORS[i % COLORS.length]}">●</span> 投影 ${escapeHtml(p.id)} 帧输出
        <span>${p.size[0]}×${p.size[1]}</span></h3><canvas></canvas>`;
      grid.appendChild(card);
      previewCanvases[p.id] = { frame: card.querySelector('canvas'), mask: null };
    });
    const maskCard = document.createElement('div');
    maskCard.className = 'output-card';
    maskCard.dataset.key = 'mask0';
    maskCard.innerHTML = '<h3>投影 1 羽化蒙层（原始权重）<span id="maskSize"></span></h3><canvas></canvas>';
    grid.appendChild(maskCard);
    const maskCanvas = maskCard.querySelector('canvas');
    if (state.projectors[0]) previewCanvases[state.projectors[0].id].mask = maskCanvas;

    const compCard = document.createElement('div');
    compCard.className = 'output-card';
    compCard.dataset.key = 'composite';
    compCard.innerHTML = `<h3>幕布合成预览<span>${state.surface[0]}×${state.surface[1]}</span></h3><canvas></canvas>`;
    grid.appendChild(compCard);
    previewCanvases.__composite = compCard.querySelector('canvas');
  }

  // ---------- 拖拽四角 ----------
  function eventToSurface(e) {
    const rect = els.overlayCanvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / rect.width * state.surface[0];
    const sy = (e.clientY - rect.top) / rect.height * state.surface[1];
    return [sx, sy];
  }

  function pickHandle(sx, sy) {
    const tol = Math.max(6, state.surface[0] / 60);
    let best = null, bestD = tol;
    state.projectors.forEach((p, pi) => {
      p.quad.forEach((pt, ci) => {
        const d = Math.hypot(pt[0] - sx, pt[1] - sy);
        if (d <= bestD) { bestD = d; best = { pi, ci }; }
      });
    });
    return best;
  }

  els.overlayCanvas.addEventListener('pointerdown', (e) => {
    if (!state) return;
    const [sx, sy] = eventToSurface(e);
    const hit = pickHandle(sx, sy);
    if (hit) {
      drag = hit;
      els.overlayCanvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  els.overlayCanvas.addEventListener('pointermove', (e) => {
    if (!state) return;
    const [sx, sy] = eventToSurface(e);
    if (drag) {
      const candidate = state.projectors[drag.pi].quad.map((p) => [p[0], p[1]]);
      candidate[drag.ci] = [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000];
      const ok = AppState.tryUpdateQuad(state, drag.pi, candidate);
      const card = els.paramsScroll.querySelector(`.field-group[data-proj-index="${drag.pi}"]`);
      if (ok) {
        syncQuadInputs(drag.pi);
        card.classList.remove('invalid');
        card.querySelector('.reason').classList.add('hidden');
        clearNotice();
        afterStateChanged();
      } else {
        // 非法：保留有效校正，仅叠层显示候选，不触发画面重算
        card.classList.add('invalid');
        card.querySelector('.reason').classList.remove('hidden');
        card.querySelector('.reason').textContent = state.projectors[drag.pi].invalidReason;
        drawOverlay();
      }
    } else {
      els.overlayCanvas.style.cursor = pickHandle(sx, sy) ? 'grab' : 'crosshair';
    }
  });

  els.overlayCanvas.addEventListener('pointerup', (e) => {
    if (drag) {
      const p = state.projectors[drag.pi];
      if (p.invalidReason) {
        showNotice('error', `投影 ${p.id}：${p.invalidReason}，已保留上一有效校正`);
        p.pendingQuad = null;
        drawOverlay();
        syncQuadInputs(drag.pi);
      }
      drag = null;
    }
  });

  function syncQuadInputs(pi) {
    const card = els.paramsScroll.querySelector(`.field-group[data-proj-index="${pi}"]`);
    const q = state.projectors[pi].quad;
    card.querySelectorAll('.corner-cell').forEach((cell, ci) => {
      cell.classList.remove('bad');
      cell.querySelector('.qx').value = roundStr(q[ci][0]);
      cell.querySelector('.qy').value = roundStr(q[ci][1]);
    });
  }

  // 点击（非拖拽）放探针
  els.overlayCanvas.addEventListener('click', (e) => {
    if (!state || !sampler) return;
    const [sx, sy] = eventToSurface(e);
    probePoint = [sx, sy];
    updateInspector(sx, sy, false);
    drawOverlay();
    positionTip(e.clientX, e.clientY);
  });

  function positionTip(clientX, clientY) {
    const wrap = els.surfaceWrap.getBoundingClientRect();
    els.probeTip.classList.remove('hidden');
    els.probeTip.style.left = Math.min(clientX - wrap.left + 14, wrap.width - 220) + 'px';
    els.probeTip.style.top = Math.max(8, clientY - wrap.top - 10) + 'px';
  }

  // ---------- 探针面板 ----------
  function updateInspector(sx, sy, silent) {
    const probe = Sampler.probeAt(state, sampler, sx, sy);
    const rows = state.projectors.map((p, i) => {
      const d = probe.perProjector[i];
      const fb = d.framebuffer ? `${d.framebuffer[0].toFixed(2)}, ${d.framebuffer[1].toFixed(2)}` : '—';
      const lin = d.linear ? d.linear.map((v) => v.toFixed(4)).join(', ') : '—';
      const swatch = d.linear
        ? `<span class="swatch" style="background:rgb(${d.linear.map((v) => ColorUtil.linearToSrgbChannel(v)).join(',')})"></span>` : '';
      return `<tr>
        <td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COLORS[i % COLORS.length]};margin-right:5px"></span>${escapeHtml(p.id)}</td>
        <td>${d.inside ? '覆盖' : '—'}</td>
        <td>${d.inside ? d.minDistance.toFixed(2) : '—'}</td>
        <td>${fb}</td>
        <td>${probe.weights[i].toFixed(4)}</td>
        <td>${swatch}${lin}</td>
      </tr>`;
    }).join('');
    const comp = probe.compositeLinear;
    const compBytes = comp.map((v) => ColorUtil.linearToSrgbChannel(v));
    els.inspector.innerHTML = `
      <table class="probe">
        <thead><tr><th>投影</th><th>覆盖</th><th>最小边距 d</th><th>映射帧缓冲坐标</th><th>归一化权重</th><th>采样线性 RGB</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:10px 0 0">
        幕布坐标 (${sx.toFixed(2)}, ${sy.toFixed(2)})；覆盖数 ${probe.coveredCount}；
        合成线性 RGB = (${comp.map((v) => v.toFixed(4)).join(', ')})；
        编码 sRGB = <span class="swatch" style="background:rgb(${compBytes.join(',')})"></span>
        rgb(${compBytes.join(', ')})
        ${probe.coveredCount === 0 ? '；未覆盖 → 黑' : ''}
        ${probe.coveredCount > 1 ? '；权重和 ' + probe.weights.reduce((t, w) => t + w, 0).toFixed(4) : ''}
      </p>`;
    if (!silent) {
      els.probeTip.innerHTML = probeTipHtml(probe, sx, sy);
    }
  }

  function probeTipHtml(probe, sx, sy) {
    return `幕布 (${sx.toFixed(1)}, ${sy.toFixed(1)})<br>` +
      state.projectors.map((p, i) =>
        `w[${escapeHtml(p.id)}]=${probe.weights[i].toFixed(3)}`).join('　') +
      `<br>线性 RGB ${probe.compositeLinear.map((v) => v.toFixed(3)).join(', ')}`;
  }

  // ---------- 文件导入 ----------
  async function loadImageFile(file) {
    const token = ++state.imageToken;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('图片解码失败'));
        img.src = url;
      });
      if (token !== state.imageToken) return; // 被后一次加载取代
      state.image = img;
      state.imageSize = [img.naturalWidth, img.naturalHeight];
      state.imageName = file.name;
      sampler = new Sampler.ImageSampler(img);
      rendererFor(els.surfaceCanvas); // 预热主画布 context
      els.imageText.textContent = `图像：${file.name}（${img.naturalWidth}×${img.naturalHeight}）`;
      afterStateChanged();
      showNotice('info', `已载入图像 ${file.name}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function loadConfigFile(file) {
    const text = await file.text();
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch (e) {
      showNotice('error', '配置 JSON 解析失败：' + e.message, 0);
      return null;
    }
    try {
      const next = AppState.stateFromConfig(cfg);
      state = next;
      probePoint = null;
      els.revisionLabel.textContent = '修订 #' + state.revision;
      buildParamsPanel();
      buildOutputCardsIfNeeded();
      updateStatus();
      const invalid = state.projectors.filter((p) => p.invalidReason);
      if (invalid.length) {
        showNotice('warn', '配置含非法四角（已加载但不参与渲染）：' +
          invalid.map((p) => `${p.id}（${p.invalidReason}）`).join('；'), 0);
      } else {
        showNotice('info', '配置已载入：' + file.name);
      }
      if (state.image) scheduleRender();
      return cfg;
    } catch (e) {
      showNotice('error', e.message, 0);
      return null;
    }
  }

  function updateStatus() {
    if (!state) return;
    els.statusText.textContent =
      `幕布 ${state.surface[0]}×${state.surface[1]}，羽化 ${state.feather}px，投影 ${state.projectors.length} 台`;
    els.surfaceMeta.textContent = state.projectors.map((p, i) =>
      `${p.id}: ${p.size[0]}×${p.size[1]} → 四角 ${p.quad.map((q) => `(${q[0]},${q[1]})`).join(' ')}`
    ).join('\n');
    els.surfaceMeta.style.whiteSpace = 'pre-wrap';
  }

  document.getElementById('fileImage').addEventListener('change', async (e) => {
    if (e.target.files[0] && state) await loadImageFile(e.target.files[0]);
    else if (e.target.files[0]) showNotice('warn', '请先导入配置 JSON');
    e.target.value = '';
  });

  document.getElementById('fileConfig').addEventListener('change', async (e) => {
    if (e.target.files[0]) await loadConfigFile(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('fileBoth').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
    const png = files.find((f) => f.name.toLowerCase().endsWith('.png'));
    if (!json) { showNotice('error', '多选导入需包含一个 JSON 配置'); return; }
    const cfg = await loadConfigFile(json);
    if (cfg && png) await loadImageFile(png);
    e.target.value = '';
  });

  // 拖放
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
    const png = files.find((f) => f.name.toLowerCase().endsWith('.png'));
    if (json) await loadConfigFile(json);
    if (png && state) await loadImageFile(png);
  });

  // ---------- 导出 ----------
  function download(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportConfig() {
    const cfg = AppState.toConfig(state);
    const json = JSON.stringify(cfg, null, 2);
    download(new TextEncoder().encode(json), 'warp-config.json', 'application/json');
    showNotice('info', '配置已导出（重新导入可完全还原四角与参数）');
  }

  // 用独立离屏 canvas 渲染并读像素，避免与预览 canvas 尺寸互相干扰
  function renderToPixels(width, height, mode, projIndex) {
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const r = rendererFor(cv);
    if (mode === 'surface') r.renderSurface(cv, state);
    else r.renderProjector(cv, state, projIndex, 1);
    return r.readPixels(cv);
  }

  async function exportComposite() {
    const frame = renderToPixels(state.surface[0], state.surface[1], 'surface');
    const png = await PngEncoder.encodePng(frame.width, frame.height, frame.data);
    download(png, 'composite.png', 'image/png');
    showNotice('info', `合成 PNG 已导出（${frame.width}×${frame.height}）`);
  }

  async function exportProjector(index) {
    const p = state.projectors[index];
    const frame = renderToPixels(p.size[0], p.size[1], 'projector', index);
    const png = await PngEncoder.encodePng(frame.width, frame.height, frame.data);
    download(png, `${sanitize(p.id)}.png`, 'image/png');
    return `${p.id}.png`;
  }

  function sanitize(name) {
    return String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  document.getElementById('btnExportConfig').addEventListener('click', () => state && exportConfig());
  document.getElementById('btnExportComposite').addEventListener('click', () => state && state.image && exportComposite());
  document.getElementById('btnExportAll').addEventListener('click', async () => {
    if (!state || !state.image) return;
    for (let i = 0; i < state.projectors.length; i++) await exportProjector(i);
    await exportComposite();
    exportConfig();
  });

  // 全局参数（幕布尺寸/羽化）面板事件委托
  els.paramsScroll.addEventListener('change', (e) => {
    if (!state) return;
    const t = e.target;
    if (t.id === 'feather' || t.classList.contains('feather')) {
      if (!AppState.setFeather(state, parseFloat(t.value))) {
        showNotice('warn', '羽化宽度必须为正数，已还原');
        t.value = state.feather;
      } else afterStateChanged();
    } else if (t.classList.contains('surfW') || t.classList.contains('surfH')) {
      const w = parseFloat(els.paramsScroll.querySelector('.surfW').value);
      const h = parseFloat(els.paramsScroll.querySelector('.surfH').value);
      if (!AppState.setSurfaceSize(state, w, h)) {
        showNotice('warn', '幕布尺寸必须为正整数，已还原');
        t.value = state.surface[t.classList.contains('surfW') ? 0 : 1];
      } else {
        buildParamsPanel();
        buildOutputCardsIfNeeded();
        afterStateChanged();
        updateStatus();
      }
    }
  });

  window.addEventListener('resize', () => { if (state) { layoutStage(); drawOverlay(); } });

  // 暴露给端到端测试
  window.__warp = {
    get state() { return state; },
    set state(v) { state = v; },
    get sampler() { return sampler; },
    set sampler(v) { sampler = v; },
    ensureRenderer() { return rendererFor(els.surfaceCanvas); },
    renderAll: () => renderAll(state.revision),
    scheduleRender,
    loadImageFile,
    loadConfigFile,
    renderToPixels,
    updateInspector: (x, y) => updateInspector(x, y, false),
    probeAt: (x, y) => Sampler.probeAt(state, sampler, x, y)
  };
})();
