'use strict';

(function () {
  const Solver = window.ToneCurveSolver;
  const IO = window.ToneCurveIO;
  const N = 4096;
  const X_MAX = 4095;
  const Y_MAX = 1023;
  const MAX_LOCKS = 32;

  const $ = (id) => document.getElementById(id);

  let imageParts = { source: null, target: null, weights: null };
  let dataset = null;
  let lockRows = [];
  let lockUid = 1;
  let lastGood = null;
  let selectedPixel = null;
  let recomputeTimer = null;

  function setStatus(element, message, type = '') {
    element.textContent = message;
    element.className = `status${type ? ` ${type}` : ''}`;
  }

  function newLockRow(x = '', y = '') {
    return { cid: `lock-row-${lockUid++}`, x, y };
  }

  function locksFromJsonValue(parsed) {
    const normalized = Solver.normalizeLocks(parsed);
    lockRows = normalized.map((lock) => newLockRow(lock.x, lock.y));
    renderLocks();
  }

  async function applyLocksText(text) {
    const parsed = IO.parseLocksJson(text);
    locksFromJsonValue(parsed);
  }

  function currentLocksForSolver() {
    return lockRows.map((row) => ({ x: row.x, y: row.y, id: row.cid }));
  }

  function renderLocks() {
    const tbody = $('lock-tbody');
    tbody.replaceChildren();

    if (lockRows.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = document.createElement('td');
      td.colSpan = 3;
      td.textContent = '暂无锁点';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const row of lockRows) {
        const tr = document.createElement('tr');
        tr.dataset.cid = row.cid;
        tr.innerHTML = `
          <td>
            <input class="lock-x" type="number" min="0" max="${X_MAX}" step="1"
                   inputmode="numeric" aria-label="锁点源值" value="${row.x}">
          </td>
          <td>
            <input class="lock-y" type="number" min="0" max="${Y_MAX}" step="1"
                   inputmode="numeric" aria-label="锁点曲线值" value="${row.y}">
          </td>
          <td><button type="button" class="delete-lock" data-cid="${row.cid}">删除</button></td>
        `;
        tbody.appendChild(tr);
      }
    }

    $('lock-count').textContent = `${lockRows.length}/${MAX_LOCKS}`;
  }

  function scheduleRecompute(delay = 180) {
    if (!$('auto-compute').checked) return;
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      recompute().catch((error) => {
        setStatus($('solve-status'), `计算失败：${error.message || error}`, 'error');
      });
    }, delay);
  }

  function renderDatasetMeta(extra = '') {
    const host = $('dataset-meta');
    host.replaceChildren();
    if (!dataset) return;

    const pills = [
      `${dataset.width}×${dataset.height}`,
      `${dataset.pixelCount.toLocaleString('zh-CN')} 像素`,
      `源 maxval=${dataset.sourceMeta.maxval}`,
      `目标 maxval=${dataset.targetMeta.maxval}`,
      dataset.weightsMeta ? `权重 maxval=${dataset.weightsMeta.maxval}` : '无权重图：逐像素权重 1',
    ];
    if (extra) pills.push(extra);

    for (const text of pills) {
      const span = document.createElement('span');
      span.className = 'meta-pill';
      span.textContent = text;
      host.appendChild(span);
    }
  }

  async function rebuildDataset() {
    if (!imageParts.source || !imageParts.target) {
      dataset = null;
      lastGood = null;
      selectedPixel = null;
      $('dataset-meta').replaceChildren();
      setStatus($('import-status'), '请同时导入源图和同尺寸目标 P5。', 'warning');
      $('export-curve').disabled = true;
      $('export-p5').disabled = true;
      drawCurveChart();
      drawSlopeChart();
      return;
    }

    const sourceMeta = imageParts.source;
    const targetMeta = imageParts.target;
    const weightsMeta = imageParts.weights;

    if (sourceMeta.width !== targetMeta.width || sourceMeta.height !== targetMeta.height) {
      throw new Error(
        `源图 ${sourceMeta.width}×${sourceMeta.height} 与目标 ${targetMeta.width}×${targetMeta.height} 尺寸不一致。`,
      );
    }

    const width = sourceMeta.width;
    const height = sourceMeta.height;
    const pixelCount = width * height;

    if (width > 2048 || height > 1024) {
      throw new Error(`图像尺寸 ${width}×${height} 超出允许的最大幅面 2048×1024。`);
    }
    if (pixelCount > 2048 * 1024) {
      throw new Error(`图像像素数 ${pixelCount} 超过 2048×1024。`);
    }
    if (weightsMeta && (weightsMeta.width !== width || weightsMeta.height !== height)) {
      throw new Error('权重图必须与源图、目标图同尺寸。');
    }

    const source = sourceMeta.data;
    const target = targetMeta.data;
    const weights = weightsMeta ? weightsMeta.data : null;

    // This also validates source/target sample ranges and aggregates by source bin.
    const observation = Solver.aggregateObservations(source, target, weights, N);

    dataset = {
      width,
      height,
      pixelCount,
      source,
      target,
      weights,
      sourceMeta,
      targetMeta,
      weightsMeta,
      observation,
      proof: null,
    };

    // A new image/objective is a new problem; do not call this a continuation
    // of the previous image's successful curve.
    lastGood = null;
    selectedPixel = null;
    updateCrosshairs(null);
    resetPixelInfo();

    paintGray($('source-canvas'), source, X_MAX);
    paintGray($('target-canvas'), target, Y_MAX);
    paintGray($('proof-canvas'), new Uint16Array(pixelCount), Y_MAX);

    $('export-curve').disabled = true;
    $('export-p5').disabled = true;
    renderDatasetMeta(`参与加权像素 ${observation.usedPixels}/${observation.pixelCount}`);
    setStatus($('import-status'), '图像导入成功。', 'success');

    await recompute();
  }

  function paintGray(canvas, values, maxValue) {
    if (!dataset) return;
    const { width, height } = dataset;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const image = ctx.createImageData(width, height);
    const denom = maxValue > 0 ? maxValue : 1;

    for (let i = 0; i < values.length; i += 1) {
      let g = Math.round((values[i] * 255) / denom);
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      const j = i * 4;
      image.data[j] = g;
      image.data[j + 1] = g;
      image.data[j + 2] = g;
      image.data[j + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  function cssColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function chartColors() {
    return {
      surface: cssColor('--surface', '#ffffff'),
      text: cssColor('--text', '#191919'),
      secondary: cssColor('--text-secondary', '#666666'),
      grid: cssColor('--grid', '#e7e7e7'),
      axis: cssColor('--axis', '#c2c2c2'),
      curve: cssColor('--series-curve', '#257de0'),
      good: cssColor('--good', '#0aac23'),
      critical: cssColor('--critical', '#dc3c3d'),
    };
  }

  const CURVE_LAYOUT = { left: 58, right: 20, top: 18, bottom: 42 };

  function drawCurveChart(curve = lastGood ? lastGood.curve : null) {
    const canvas = $('curve-canvas');
    const ctx = canvas.getContext('2d');
    const c = chartColors();
    const W = canvas.width;
    const H = canvas.height;
    const m = CURVE_LAYOUT;
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, W, H);

    const xMap = (x) => m.left + (x / X_MAX) * pw;
    const yMap = (y) => m.top + ph - (y / Y_MAX) * ph;

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 1;

    const yTicks = [0, 256, 512, 768, 1023];
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const yv of yTicks) {
      const y = yMap(yv);
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(m.left + pw, y);
      ctx.stroke();
      ctx.fillStyle = c.secondary;
      ctx.fillText(String(yv), m.left - 8, y);
    }

    const xTicks = [0, 512, 1024, 2048, 3072, 4095];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const xv of xTicks) {
      const x = xMap(xv);
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, m.top);
      ctx.lineTo(x, m.top + ph);
      ctx.stroke();
      ctx.fillStyle = c.secondary;
      ctx.fillText(String(xv), x, m.top + ph + 9);
    }

    ctx.strokeStyle = c.axis;
    ctx.beginPath();
    ctx.moveTo(m.left, m.top);
    ctx.lineTo(m.left, m.top + ph);
    ctx.lineTo(m.left + pw, m.top + ph);
    ctx.stroke();

    ctx.fillStyle = c.secondary;
    ctx.textAlign = 'center';
    ctx.fillText('源值 x（0–4095，点击可填充锁点 x/y）', m.left + pw / 2, H - 12);
    ctx.save();
    ctx.translate(15, m.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('曲线值 y', 0, 0);
    ctx.restore();

    if (curve && curve.length === N) {
      ctx.strokeStyle = c.curve;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let x = 0; x < N; x += 1) {
        const px = xMap(x);
        const py = yMap(curve[x]);
        if (x === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = c.secondary;
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('尚无成功曲线；导入图像并计算后显示', m.left + pw / 2, m.top + ph / 2);
    }

    // Draft locks are always drawn over the last successful curve.
    for (const row of lockRows) {
      const x = Number(row.x);
      const y = Number(row.y);
      if (!Number.isInteger(x) || x < 0 || x > X_MAX || !Number.isInteger(y) || y < 0 || y > Y_MAX) {
        continue;
      }
      const px = xMap(x);
      const py = yMap(y);
      const hit = curve && curve[x] === y;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 3;
      if (hit) {
        ctx.fillStyle = c.good;
        ctx.strokeStyle = c.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = c.critical;
        ctx.strokeStyle = c.surface;
        ctx.lineWidth = 2;
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-5.5, -5.5, 11, 11);
        ctx.strokeRect(-5.5, -5.5, 11, 11);
      }
      ctx.restore();
    }
  }

  function drawSlopeChart(curve = lastGood ? lastGood.curve : null) {
    const canvas = $('slope-canvas');
    const ctx = canvas.getContext('2d');
    const colors = chartColors();
    const W = canvas.width;
    const H = canvas.height;
    const m = { left: 48, right: 18, top: 16, bottom: 30 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, W, H);

    const xMap = (i) => m.left + (i / (N - 2)) * pw;
    const yMap = (d) => m.top + ph - (d / 3) * ph;

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let d = 0; d <= 3; d += 1) {
      const y = yMap(d);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(m.left + pw, y);
      ctx.stroke();
      ctx.fillStyle = colors.secondary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(d), m.left - 8, y);
    }

    ctx.strokeStyle = colors.axis;
    ctx.beginPath();
    ctx.moveTo(m.left, m.top);
    ctx.lineTo(m.left, m.top + ph);
    ctx.lineTo(m.left + pw, m.top + ph);
    ctx.stroke();

    ctx.fillStyle = colors.secondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('相邻斜率 d[i] = c[i+1] − c[i]；限 0..3，相邻段差 ≤ 1', m.left + pw / 2, H - 20);

    if (!curve || curve.length < 2) return;

    ctx.strokeStyle = colors.curve;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < N - 1; i += 1) {
      const d = curve[i + 1] - curve[i];
      const x = xMap(i);
      const y = yMap(d);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderStats(result) {
    const a = result.analysis;
    $('stat-sse').textContent = Math.round(result.weightedSquaredError).toLocaleString('zh-CN');
    $('stat-pixels').textContent = result.usedPixels != null
      ? `${result.usedPixels.toLocaleString('zh-CN')} / ${result.pixelCount.toLocaleString('zh-CN')}`
      : '—';
    $('stat-range').textContent = `${a.minValue}–${a.maxValue}`;
    $('stat-slopes').textContent = a.minSlope == null ? '—' : `${a.minSlope}–${a.maxSlope}`;
    $('stat-jump').textContent = `${a.maxSlopeJump} / 限 1`;
    $('stat-locks').textContent = `${result.locks.length - a.lockMismatches.length}/${result.locks.length} 精确`;
  }

  function renderSuccessfulResult(result) {
    lastGood = result;
    if (dataset) {
      const proof = new Uint16Array(dataset.pixelCount);
      for (let i = 0; i < dataset.pixelCount; i += 1) {
        proof[i] = result.curve[dataset.source[i]];
      }
      dataset.proof = proof;
      paintGray($('source-canvas'), dataset.source, X_MAX);
      paintGray($('target-canvas'), dataset.target, Y_MAX);
      paintGray($('proof-canvas'), proof, Y_MAX);
    }

    drawCurveChart(result.curve);
    drawSlopeChart(result.curve);
    renderStats(result);
    updatePixelInfo();

    $('export-curve').disabled = false;
    $('export-p5').disabled = !dataset;
    setStatus($('export-status'), '当前导出内容就是这次成功求解的原始整数曲线 / 查值 P5。', 'success');
  }

  async function recompute() {
    clearTimeout(recomputeTimer);

    if (!dataset || !dataset.observation) {
      setStatus($('solve-status'), '请先导入源图和同尺寸目标 P5。', 'warning');
      return { ok: false, code: 'missing_images' };
    }

    let locks;
    try {
      locks = Solver.normalizeLocks(currentLocksForSolver());
    } catch (error) {
      setStatus($('solve-status'), `锁点输入无效：${error.message}`, 'error');
      return { ok: false, code: error.code || 'invalid_locks', message: error.message };
    }

    const button = $('compute-button');
    button.disabled = true;
    setStatus($('solve-status'), '正在精确求解：聚合像素 → 4096×1024 状态动态规划 → 字典序重建…');
    await new Promise((resolve) => setTimeout(resolve, 24));

    let result;
    try {
      result = Solver.solveAnchoredCurve({
        ...dataset.observation,
        locks,
        bins: N,
        maxValue: Y_MAX,
        slopeMax: 3,
        slopeStep: 1,
      });
    } catch (error) {
      result = { ok: false, code: error.code || 'solver_exception', message: error.message };
    } finally {
      button.disabled = false;
    }

    if (result.ok) {
      renderSuccessfulResult(result);
      const lockText = locks.length ? `，${locks.length} 个锁点全部精确命中` : '，无锁点';
      setStatus(
        $('solve-status'),
        `求解成功：已取得加权平方误差全局最小值 ${Math.round(result.weightedSquaredError).toLocaleString('zh-CN')}`
        + `${lockText}；同分曲线已按整条曲线字典序最小化。`,
        'success',
      );
      return result;
    }

    // Failure path deliberately never assigns a failed curve to lastGood.
    drawCurveChart(lastGood ? lastGood.curve : null);
    drawSlopeChart(lastGood ? lastGood.curve : null);

    if (lastGood) {
      $('export-curve').disabled = false;
      $('export-p5').disabled = !dataset;
      setStatus(
        $('solve-status'),
        `${result.message || '无解：当前锁点无法同时满足全部约束。'}\n`
        + '新锁点没有产生可行曲线；页面图像、图表和导出仍保留上一次成功曲线，未替换。',
        'error',
      );
      setStatus($('export-status'), '注意：当前草稿无解，导出的是上一次成功曲线。', 'warning');
    } else {
      $('export-curve').disabled = true;
      $('export-p5').disabled = true;
      setStatus(
        $('solve-status'),
        `${result.message || '无解：当前锁点无法同时满足全部约束。'}\n`
        + '此前没有可保留的成功曲线；请放宽或删除冲突锁点后重试。',
        'error',
      );
      setStatus($('export-status'), '没有可导出的成功曲线。', 'warning');
    }

    updatePixelInfo();
    return result;
  }

  async function ingestZipBuffer(buffer) {
    setStatus($('import-status'), '正在读取 ZIP 目录并解压…');
    const files = await IO.unzip(buffer);

    let sourceP5 = null;
    let targetP5 = null;
    let weightsP5 = null;
    let locksText = null;
    const notes = [];

    for (const entry of Object.values(files)) {
      const name = entry.name;
      const base = IO.baseName(name);
      if (name.startsWith('__MACOSX/') || base.startsWith('._') || base.endsWith('/')) continue;

      const category = IO.classifyFileName(name);
      try {
        if (category === 'source' && !sourceP5) sourceP5 = IO.readP5(entry.data);
        else if (category === 'target' && !targetP5) targetP5 = IO.readP5(entry.data);
        else if (category === 'weights' && !weightsP5) weightsP5 = IO.readP5(entry.data);
        else if (category === 'locks' && locksText == null) {
          locksText = new TextDecoder('utf-8').decode(entry.data);
        }
      } catch (error) {
        notes.push(`${base}: ${error.message}`);
      }
    }

    if (sourceP5) imageParts.source = sourceP5;
    if (targetP5) imageParts.target = targetP5;
    if (weightsP5) imageParts.weights = weightsP5;

    if (locksText != null) {
      try {
        await applyLocksText(locksText);
      } catch (error) {
        notes.push(`锁点 JSON: ${error.message}`);
        setStatus($('solve-status'), `锁点文件无效，未替换当前锁点：${error.message}`, 'error');
      }
    }

    await rebuildDataset();

    if (notes.length) {
      setStatus($('import-status'), `导入完成，但部分条目有问题：\n${notes.join('\n')}`, 'warning');
    } else {
      setStatus($('import-status'), 'ZIP 案例导入成功。', 'success');
    }
  }

  async function handleFileList(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const zip = files.find((file) => /\.zip$/i.test(file.name)
      || file.type === 'application/zip'
      || file.type === 'application/x-zip-compressed');

    if (zip) {
      const buffer = await IO.readFileAsArrayBuffer(zip);
      await ingestZipBuffer(buffer);
      return;
    }

    for (const file of files) {
      const category = IO.classifyFileName(file.name);
      if (!category) continue;
      if (category === 'locks') {
        const text = await IO.readFileAsText(file);
        await applyLocksText(text);
      } else {
        const buffer = await IO.readFileAsArrayBuffer(file);
        const p5 = IO.readP5(buffer);
        imageParts[category] = p5;
      }
    }

    await rebuildDataset();
  }

  async function handleSingleFileInput(input, category) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (category === 'locks') {
        const text = await IO.readFileAsText(file);
        await applyLocksText(text);
        if (dataset) scheduleRecompute(0);
        setStatus($('import-status'), `已导入锁点文件 ${file.name}。`, 'success');
      } else {
        const buffer = await IO.readFileAsArrayBuffer(file);
        const p5 = IO.readP5(buffer);
        imageParts[category] = p5;
        await rebuildDataset();
      }
    } catch (error) {
      setStatus($('import-status'), `导入 ${file.name} 失败：${error.message || error}`, 'error');
    } finally {
      input.value = '';
    }
  }

  function pixelFromEvent(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((event.clientX - rect.left) / rect.width) * dataset.width);
    const py = Math.floor(((event.clientY - rect.top) / rect.height) * dataset.height);
    return {
      x: Math.max(0, Math.min(dataset.width - 1, px)),
      y: Math.max(0, Math.min(dataset.height - 1, py)),
    };
  }

  function updateCrosshairs(index) {
    const frames = document.querySelectorAll('.canvas-frame');
    if (index == null || !dataset) {
      frames.forEach((frame) => {
        frame.querySelector('.crosshair-v').style.display = 'none';
        frame.querySelector('.crosshair-h').style.display = 'none';
      });
      return;
    }

    const x = index % dataset.width;
    const y = Math.floor(index / dataset.width);
    const left = `${((x + 0.5) / dataset.width) * 100}%`;
    const top = `${((y + 0.5) / dataset.height) * 100}%`;

    frames.forEach((frame) => {
      const v = frame.querySelector('.crosshair-v');
      const h = frame.querySelector('.crosshair-h');
      v.style.left = left;
      h.style.top = top;
      v.style.display = 'block';
      h.style.display = 'block';
    });
  }

  function resetPixelInfo() {
    selectedPixel = null;
    updateCrosshairs(null);
    const box = $('pixel-info');
    box.classList.remove('has-selection');
    box.textContent = '点击任一图像中的像素，查看源值、目标值、校样值、权重和本项误差。';
  }

  function updatePixelInfo() {
    const box = $('pixel-info');
    if (selectedPixel == null || !dataset) {
      resetPixelInfo();
      return;
    }

    const idx = selectedPixel;
    const x = idx % dataset.width;
    const y = Math.floor(idx / dataset.width);
    const sourceValue = dataset.source[idx];
    const targetValue = dataset.target[idx];
    const weight = dataset.weights ? dataset.weights[idx] : 1;
    const proofValue = lastGood ? lastGood.curve[sourceValue] : null;

    box.classList.add('has-selection');

    if (proofValue == null) {
      box.textContent = [
        `像素 #${idx}  坐标 (x=${x}, y=${y})`,
        `源值 source = ${sourceValue}`,
        `目标 target = ${targetValue}`,
        `权重 weight = ${weight}${dataset.weights ? '' : '（缺省为 1）'}`,
        '校样 proof  = 暂无成功曲线',
      ].join('\n');
      return;
    }

    const delta = proofValue - targetValue;
    const squared = delta * delta;
    const weighted = weight * squared;
    const excluded = weight === 0 ? '；权重 0，不参与全局求解' : '';

    box.textContent = [
      `像素 #${idx}  坐标 (x=${x}, y=${y})`,
      `源值 source       = ${sourceValue}`,
      `目标 target       = ${targetValue}`,
      `校样 proof        = ${proofValue}   （原始曲线 curve[${sourceValue}]，非显示量化）`,
      `权重 weight       = ${weight}${dataset.weights ? '' : '（无权重图，逐像素为 1）'}${excluded}`,
      `本项误差 Δ        = proof − target = ${proofValue} − ${targetValue} = ${delta}`,
      `平方误差 Δ²       = ${squared}`,
      `加权平方误差 wΔ²  = ${weighted}`,
    ].join('\n');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function bindEvents() {
    $('case-files').addEventListener('change', async (event) => {
      const input = event.currentTarget;
      try {
        await handleFileList(input.files);
      } catch (error) {
        setStatus($('import-status'), `导入失败：${error.message || error}`, 'error');
      } finally {
        input.value = '';
      }
    });

    $('load-builtin').addEventListener('click', async () => {
      try {
        if (window.EMBEDDED_SAMPLE_ZIP_BASE64) {
          setStatus($('import-status'), '正在载入内置样例…');
          const binary = atob(window.EMBEDDED_SAMPLE_ZIP_BASE64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          await ingestZipBuffer(bytes.buffer);
          return;
        }

        setStatus($('import-status'), '正在通过 HTTP 读取 samples/anchored-tone-cases.zip…');
        const response = await fetch('samples/anchored-tone-cases.zip', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        await ingestZipBuffer(buffer);
      } catch (error) {
        setStatus(
          $('import-status'),
          `无法读取内置样例（通过 file:// 直接打开时浏览器可能禁止 fetch）。请用 ZIP 文件选择器手动导入，或运行 scripts/start.sh。原因：${error.message}`,
          'error',
        );
      }
    });

    $('source-file').addEventListener('change', (e) => handleSingleFileInput(e.currentTarget, 'source'));
    $('target-file').addEventListener('change', (e) => handleSingleFileInput(e.currentTarget, 'target'));
    $('weights-file').addEventListener('change', (e) => handleSingleFileInput(e.currentTarget, 'weights'));
    $('locks-file').addEventListener('change', (e) => handleSingleFileInput(e.currentTarget, 'locks'));

    $('clear-weights').addEventListener('click', async () => {
      imageParts.weights = null;
      $('weights-file').value = '';
      try {
        await rebuildDataset();
      } catch (error) {
        setStatus($('import-status'), error.message, 'error');
      }
    });

    $('lock-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const x = Number($('lock-x').value);
      const y = Number($('lock-y').value);

      try {
        Solver.normalizeLocks([[x, y]]);
      } catch (error) {
        setStatus($('solve-status'), `无法添加锁点：${error.message}`, 'error');
        return;
      }

      const existing = lockRows.find((row) => Number(row.x) === x);
      if (existing) {
        existing.y = y;
      } else {
        if (lockRows.length >= MAX_LOCKS) {
          setStatus($('solve-status'), `锁点最多 ${MAX_LOCKS} 个；请先删除一个，或修改已有同 x 锁点。`, 'error');
          return;
        }
        lockRows.push(newLockRow(x, y));
      }

      $('lock-x').value = '';
      $('lock-y').value = '';
      renderLocks();
      drawCurveChart(lastGood ? lastGood.curve : null);
      if ($('auto-compute').checked) await recompute();
    });

    $('lock-tbody').addEventListener('input', (event) => {
      const rowElement = event.target.closest('tr[data-cid]');
      if (!rowElement) return;
      const row = lockRows.find((item) => item.cid === rowElement.dataset.cid);
      if (!row) return;
      if (event.target.classList.contains('lock-x')) row.x = event.target.value;
      if (event.target.classList.contains('lock-y')) row.y = event.target.value;
      drawCurveChart(lastGood ? lastGood.curve : null);
      scheduleRecompute(220);
    });

    $('lock-tbody').addEventListener('click', async (event) => {
      const button = event.target.closest('.delete-lock');
      if (!button) return;
      lockRows = lockRows.filter((row) => row.cid !== button.dataset.cid);
      renderLocks();
      if ($('auto-compute').checked) await recompute();
      else drawCurveChart(lastGood ? lastGood.curve : null);
    });

    $('compute-button').addEventListener('click', () => {
      recompute().catch((error) => {
        setStatus($('solve-status'), `计算失败：${error.message || error}`, 'error');
      });
    });

    document.querySelectorAll('.canvas-frame').forEach((frame) => {
      frame.addEventListener('click', (event) => {
        if (!dataset) return;
        const canvas = frame.querySelector('canvas');
        const p = pixelFromEvent(event, canvas);
        selectedPixel = p.y * dataset.width + p.x;
        updateCrosshairs(selectedPixel);
        updatePixelInfo();
      });
    });

    $('curve-canvas').addEventListener('click', (event) => {
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const bitmapX = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const m = CURVE_LAYOUT;
      const pw = canvas.width - m.left - m.right;
      let x = Math.round(((bitmapX - m.left) / pw) * X_MAX);
      x = Math.max(0, Math.min(X_MAX, x));
      $('lock-x').value = x;
      if (lastGood) $('lock-y').value = lastGood.curve[x];
      $('lock-x').focus();
    });

    $('curve-canvas').addEventListener('mousemove', (event) => {
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const bitmapX = (cssX / rect.width) * canvas.width;
      const m = CURVE_LAYOUT;
      const pw = canvas.width - m.left - m.right;
      let x = Math.round(((bitmapX - m.left) / pw) * X_MAX);
      x = Math.max(0, Math.min(X_MAX, x));

      const line = $('curve-hover-line');
      const tooltip = $('curve-tooltip');
      line.style.left = `${cssX}px`;
      line.style.display = 'block';

      const curve = lastGood ? lastGood.curve : null;
      const lock = lockRows.find((row) => Number(row.x) === x);
      const lines = [`x = ${x}`];
      if (curve) {
        lines.push(`curve[x] = ${curve[x]}`);
        if (x < X_MAX) lines.push(`d[${x}] = ${curve[x + 1] - curve[x]}`);
      } else {
        lines.push('curve[x] = —');
      }
      if (lock && Number.isInteger(Number(lock.y))) lines.push(`lock y = ${Number(lock.y)}`);

      tooltip.textContent = lines.join('\n');
      tooltip.hidden = false;
      tooltip.style.left = `${cssX}px`;
      tooltip.style.top = `${cssY}px`;
      tooltip.style.transform = cssX > rect.width * 0.72
        ? 'translate(calc(-100% - 12px), 12px)'
        : 'translate(12px, 12px)';
    });

    $('curve-canvas').addEventListener('mouseleave', () => {
      $('curve-hover-line').style.display = 'none';
      $('curve-tooltip').hidden = true;
    });

    $('export-curve').addEventListener('click', () => {
      if (!lastGood) return;
      const json = JSON.stringify(lastGood.curve);
      downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), 'curve.json');
      setStatus($('export-status'), `已导出 curve.json（${lastGood.curve.length} 项纯整数数组）。`, 'success');
    });

    $('export-p5').addEventListener('click', () => {
      if (!lastGood || !dataset || !dataset.proof) return;
      const bytes = IO.encodeP5_16(dataset.width, dataset.height, dataset.proof, 1023);
      downloadBlob(
        new Blob([bytes], { type: 'image/x-portable-graymap' }),
        'proof.pgm',
      );
      setStatus(
        $('export-status'),
        `已导出 proof.pgm：${dataset.width}×${dataset.height}，P5/maxval=1023/大端 16-bit，数值来自原始曲线查值。`,
        'success',
      );
    });
  }

  function init() {
    if (!window.ToneCurveSolver || !window.ToneCurveIO) {
      document.body.innerHTML = '<p style="padding:2rem">脚本加载失败，请确认 solver.js、io.js、app.js 与 index.html 在同一目录。</p>';
      return;
    }
    bindEvents();
    renderLocks();
    drawCurveChart(null);
    drawSlopeChart(null);
    updateCrosshairs(null);

    // Useful for manual/automated inspection without making the page fetch a
    // sample that could race with files supplied by a test.
    window.solveAnchoredCurve = Solver.solveAnchoredCurve;
    window.aggregateToneObservations = Solver.aggregateObservations;
    window.toneCurveApp = {
      N,
      getDataset: () => dataset,
      getLocks: () => lockRows,
      getLastGood: () => lastGood,
      recompute,
      ingestZipBuffer,
      handleFileList,
    };
  }

  init();
})();
