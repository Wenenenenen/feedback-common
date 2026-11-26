(() => {
  'use strict';

  const Core = window.AgreementCore;
  const $ = (id) => document.getElementById(id);

  const state = {
    dataset: null,
    truthImage: null,
    predictionImage: null,
    sourceLabel: '',
    results: [],
    activeThreshold: 0,
    computeToken: 0,
    computing: false,
    focus: { truthId: null, predictionId: null },
    hover: null,
    showLabels: true,
    cell: null,
    colors: { truth: new Map(), prediction: new Map() },
    lastJson: '',
  };

  function init() {
    bindTheme();
    bindInputs();
    bindView();
    bindTablesAndInspector();
    bindModal();
    loadBuiltInSample().catch((error) => {
      showStatus('error', `内置样例载入失败：${error.message}`);
    });
  }

  /* ---------- theme and feedback ---------- */

  function isDark() {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  function bindTheme() {
    let saved = null;
    try { saved = window.localStorage.getItem('ia-theme'); } catch { /* private mode */ }
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;

    $('themeToggle').addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { window.localStorage.setItem('ia-theme', next); } catch { /* ignore */ }
      if (state.dataset) renderCanvases();
    });

    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (!document.documentElement.dataset.theme && state.dataset) renderCanvases();
    });
  }

  function showStatus(kind, message) {
    const banner = $('statusBanner');
    banner.hidden = false;
    banner.className = `banner ${kind}`;
    banner.textContent = message;
  }

  function clearStatus() {
    const banner = $('statusBanner');
    banner.hidden = true;
    banner.textContent = '';
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ---------- import ---------- */

  function bindInputs() {
    $('zipButton').addEventListener('click', () => $('zipInput').click());
    $('truthButton').addEventListener('click', () => $('truthInput').click());
    $('predictionButton').addEventListener('click', () => $('predictionInput').click());
    $('sampleButton').addEventListener('click', () => loadBuiltInSample());

    $('zipInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await handleZipFile(file);
      event.target.value = '';
    });

    $('truthInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await handlePgmFile(file, 'truth');
      event.target.value = '';
    });

    $('predictionInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await handlePgmFile(file, 'prediction');
      event.target.value = '';
    });

    $('applyThresholds').addEventListener('click', () => {
      void runMatching();
    });

    let debounce = null;
    $('thresholdInput').addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void runMatching();
      }, 350);
    });

    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', async (event) => {
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      const files = [...(event.dataTransfer?.files ?? [])];
      await handleDroppedFiles(files);
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function loadBuiltInSample() {
    showStatus('info', '正在载入 samples/instance-agreement.zip 的内置副本…');
    const bytes = base64ToBytes(window.SAMPLE_ZIP_BASE64);
    const entries = await readZip(bytes.buffer);
    const truthEntry = pickZipEntry(entries, 'truth');
    const predictionEntry = pickZipEntry(entries, 'prediction');
    if (!truthEntry || !predictionEntry) {
      throw new Error('内置样例中未找到 truth.pgm / prediction.pgm。');
    }
    const truthImage = Core.parsePgm(truthEntry.bytes, 'truth.pgm');
    const predictionImage = Core.parsePgm(predictionEntry.bytes, 'prediction.pgm');
    loadImages(truthImage, predictionImage, '内置样例：instance-agreement.zip / truth.pgm + prediction.pgm');
    showStatus('success', '已载入内置样例。可直接点选掩膜，或导入自己的 ZIP / PGM。');
  }

  async function handleZipFile(file) {
    try {
      showStatus('info', `正在读取 ZIP：${file.name}…`);
      const entries = await readZip(await file.arrayBuffer());
      const truthEntry = pickZipEntry(entries, 'truth');
      const predictionEntry = pickZipEntry(entries, 'prediction');
      if (!truthEntry || !predictionEntry) {
        const pgms = entries.filter((e) => /\.pgm$/i.test(e.name));
        throw new Error(
          `无法在 ZIP 中自动识别真值/预测 PGM。找到：${pgms.map((e) => e.name).join(', ') || '无'}。请改用两个 PGM 按钮分别导入。`,
        );
      }
      const truthImage = Core.parsePgm(truthEntry.bytes, truthEntry.name);
      const predictionImage = Core.parsePgm(predictionEntry.bytes, predictionEntry.name);
      loadImages(truthImage, predictionImage, `${file.name} / ${truthEntry.name} + ${predictionEntry.name}`);
      showStatus('success', `已从 ${file.name} 导入两图并完成计算。`);
    } catch (error) {
      showStatus('error', `ZIP 导入失败：${error.message}`);
    }
  }

  async function handlePgmFile(file, side) {
    try {
      const image = Core.parsePgm(new Uint8Array(await file.arrayBuffer()), file.name);
      if (side === 'truth') state.truthImage = image;
      else state.predictionImage = image;

      if (!state.truthImage || !state.predictionImage) {
        showStatus('info', `已载入${side === 'truth' ? '真值' : '预测'} ${file.name}，请再选择另一张 PGM。`);
        return;
      }
      loadImages(
        state.truthImage,
        state.predictionImage,
        `分别导入：${side === 'truth' ? file.name : '当前真值'} + ${side === 'prediction' ? file.name : '当前预测'}`,
      );
      showStatus('success', `已导入 ${file.name} 并完成计算。`);
    } catch (error) {
      showStatus('error', `PGM 导入失败：${error.message}`);
    }
  }

  async function handleDroppedFiles(files) {
    if (files.length === 0) return;
    const zip = files.find((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip');
    if (zip) {
      await handleZipFile(zip);
      return;
    }

    const pgms = files.filter((f) => /\.pgm$/i.test(f.name));
    if (pgms.length === 1) {
      const side = looksTruth(pgms[0].name) ? 'truth' : looksPrediction(pgms[0].name) ? 'prediction' : null;
      if (!side) {
        showStatus('error', '无法从文件名判断这是真值还是预测；请使用对应的选择按钮。');
        return;
      }
      await handlePgmFile(pgms[0], side);
      return;
    }

    if (pgms.length >= 2) {
      let truthFile = pgms.find((f) => looksTruth(f.name));
      let predictionFile = pgms.find((f) => looksPrediction(f.name) && f !== truthFile);
      if (!truthFile || !predictionFile) {
        truthFile = pgms[0];
        predictionFile = pgms[1];
      }
      try {
        const truthImage = Core.parsePgm(new Uint8Array(await truthFile.arrayBuffer()), truthFile.name);
        const predictionImage = Core.parsePgm(new Uint8Array(await predictionFile.arrayBuffer()), predictionFile.name);
        loadImages(truthImage, predictionImage, `拖入文件：${truthFile.name} + ${predictionFile.name}`);
        showStatus('success', '已导入拖入的两个 PGM。');
      } catch (error) {
        showStatus('error', `拖入文件解析失败：${error.message}`);
      }
    }
  }

  function looksTruth(name) {
    return /truth|gt|ground|真值/i.test(name);
  }
  function looksPrediction(name) {
    return /pred|predict|forecast|infer|output|预测/i.test(name);
  }

  /* ---------- minimal ZIP reader ---------- */

  async function readZip(arrayBuffer) {
    const buffer = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    const earliest = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= earliest; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 中央目录结束标记。');

    let count = view.getUint16(eocd + 10, true);
    let centralOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64；请解压后分别选择两个 PGM。');
    }

    const decoder = new TextDecoder('utf-8');
    const entries = [];
    let p = centralOffset;

    for (let n = 0; n < count; n += 1) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 中央目录结构无效。');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLength);
      const name = flags & 0x800 ? decoder.decode(nameBytes) : decoder.decode(nameBytes);

      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

      let data;
      if (method === 0) {
        data = compressed;
      } else if (method === 8) {
        data = await inflateRaw(compressed);
      } else {
        throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方法 ${method}。`);
      }
      entries.push({ name, bytes: data });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function inflateRaw(compressed) {
    if (!('DecompressionStream' in window)) {
      throw new Error('当前浏览器不支持本地 Deflate 解压，请解压 ZIP 后分别导入 PGM。');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function pickZipEntry(entries, side) {
    const pgms = entries.filter((e) => !e.name.endsWith('/') && /\.pgm$/i.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name));
    const exact = pgms.find((e) => new RegExp(`(^|[/\\\\])${side}\\.pgm$`, 'i').test(e.name));
    if (exact) return exact;
    const pattern = side === 'truth'
      ? /truth|gt|ground|真值/i
      : /pred|predict|forecast|infer|output|预测/i;
    return pgms.find((e) => pattern.test(e.name)) ?? null;
  }

  /* ---------- dataset state ---------- */

  function loadImages(truthImage, predictionImage, sourceLabel) {
    const dataset = Core.buildDataset(truthImage, predictionImage);
    state.truthImage = truthImage;
    state.predictionImage = predictionImage;
    state.dataset = dataset;
    state.sourceLabel = sourceLabel;
    state.activeThreshold = 0;
    state.focus = { truthId: null, predictionId: null };
    state.cell = null;
    state.results = [];
    state.colors = {
      truth: buildColors(dataset.truthIds, 'truth'),
      prediction: buildColors(dataset.predictionIds, 'prediction'),
    };

    renderAll();
    void runMatching({ pickFirst: true });
  }

  function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function runMatching(options = {}) {
    if (!state.dataset) {
      state.results = [];
      return;
    }

    const token = ++state.computeToken;
    state.computing = true;
    updateComputeButton(0, 0);

    let thresholds;
    try {
      thresholds = Core.parseThresholds($('thresholdInput').value);
      clearStatus();
    } catch (error) {
      if (token !== state.computeToken) return;
      state.results = [];
      state.computing = false;
      updateComputeButton(0, 0);
      showStatus('error', error.message);
      renderThresholdTable();
      renderPairTable();
      renderUnmatched();
      renderInspector();
      updateExportButtons();
      return;
    }

    const results = [];
    state.results = [];
    renderThresholdTable();

    for (let i = 0; i < thresholds.length; i += 1) {
      // Yield between thresholds so the page can paint progress and remain
      // interactive even for the 256×256 worst case.
      await nextTick();
      if (token !== state.computeToken) return;

      results.push(Core.matchThreshold(state.dataset, thresholds[i]));
      state.results = results.slice();
      if (state.activeThreshold >= state.results.length) state.activeThreshold = 0;
      updateComputeButton(i + 1, thresholds.length);
      renderThresholdTable();
    }

    if (token !== state.computeToken) return;
    state.results = results;
    state.computing = false;
    if (state.activeThreshold >= state.results.length) state.activeThreshold = 0;

    if (options.pickFirst && state.focus.truthId === null && state.focus.predictionId === null) {
      const firstPair = activeResult()?.pairs?.[0];
      if (firstPair) state.focus = { truthId: firstPair.truthId, predictionId: firstPair.predictionId };
    }

    updateComputeButton(thresholds.length, thresholds.length);
    renderAllDataViews();
  }

  function updateComputeButton(done, total) {
    const button = $('applyThresholds');
    if (state.computing && total > 0) button.textContent = `计算中 ${done}/${total}`;
    else if (state.computing) button.textContent = '准备计算…';
    else button.textContent = '重算各档';
  }

  function activeResult() {
    return state.results[state.activeThreshold] ?? null;
  }

  function updateExportButtons() {
    const enabled = state.dataset && state.results.length > 0;
    $('exportJsonButton').disabled = !enabled;
    $('copyJsonButton').disabled = !enabled;
  }

  /* ---------- rendering orchestration ---------- */

  function renderAll() {
    renderDatasetMeta();
    renderThresholdTable();
    renderCanvases();
    renderPairTable();
    renderUnmatched();
    renderInspector();
    applyCell();
    updateExportButtons();
  }

  function renderAllDataViews() {
    renderThresholdTable();
    renderPairTable();
    renderUnmatched();
    renderInspector();
    renderCanvases();
    updateExportButtons();
  }

  function renderDatasetMeta() {
    const ds = state.dataset;
    if (!ds) return;
    const excluded = ds.excludedTruth.length + ds.excludedPrediction.length;
    $('datasetLine').textContent =
      `${ds.width}×${ds.height} · ${ds.truthIds.length} 个有效真值 · ${ds.predictionIds.length} 个有效预测 · 忽略 ${ds.ignoredPixels.toLocaleString()} px`;
    $('fileLine').textContent =
      `${state.sourceLabel}；有效像素 ${ds.validPixels.toLocaleString()}，剔除后空实例 ${excluded} 个（真 ${ds.excludedTruth.length} / 预 ${ds.excludedPrediction.length}）。`;
    $('truthMeta').textContent =
      `P5 ${ds.truthImageMeta.bitDepth}-bit · maxval ${ds.truthImageMeta.maxval} · ${ds.truthIds.length} objects`;
    $('predictionMeta').textContent =
      `P5 ${ds.predictionImageMeta.bitDepth}-bit · maxval ${ds.predictionImageMeta.maxval} · ${ds.predictionIds.length} objects`;
    $('truthReadout').textContent = '点击真值实例或编号进行点选。';
    $('predictionReadout').textContent = '点击预测实例或编号进行点选。';
  }

  /* ---------- colors and canvases ---------- */

  function hslToRgb(h, s, l) {
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h / 360 + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h / 360) * 255),
      Math.round(hue2rgb(p, q, h / 360 - 1 / 3) * 255),
    ];
  }

  function buildColors(ids, side) {
    const map = new Map();
    const lightness = isDark() ? 0.64 : 0.48;
    ids.forEach((id, i) => {
      const hue = (i * 137.508 + (side === 'prediction' ? 32 : 188)) % 360;
      map.set(id, hslToRgb(hue, 0.68, lightness));
    });
    return map;
  }

  function ignoreRgb(x, y) {
    const dark = isDark();
    const stripe = ((x + y) % 10) < 4;
    if (dark) return stripe ? [91, 112, 134] : [42, 56, 73];
    return stripe ? [148, 163, 184] : [214, 222, 232];
  }

  function renderCanvases() {
    if (!state.dataset) return;
    state.colors = {
      truth: buildColors(state.dataset.truthIds, 'truth'),
      prediction: buildColors(state.dataset.predictionIds, 'prediction'),
    };
    renderBaseCanvas('truth');
    renderBaseCanvas('prediction');
    renderOverlayCanvas('truth');
    renderOverlayCanvas('prediction');
    renderLabels('truth');
    renderLabels('prediction');
  }

  function renderBaseCanvas(side) {
    const ds = state.dataset;
    const canvas = $(`${side}Canvas`);
    canvas.width = ds.width;
    canvas.height = ds.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const image = ctx.createImageData(ds.width, ds.height);
    const rgba = image.data;
    const raster = side === 'truth' ? ds.truth : ds.prediction;
    const colors = state.colors[side];
    const focusId = side === 'truth' ? state.focus.truthId : state.focus.predictionId;
    const dark = isDark();

    for (let i = 0; i < ds.pixelCount; i += 1) {
      const x = i % ds.width;
      const y = (i / ds.width) | 0;
      const id = raster[i];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (side === 'truth' && id === Core.IGNORE_ID) {
        [r, g, b] = ignoreRgb(x, y);
      } else if (id === 0) {
        a = 0;
      } else {
        [r, g, b] = colors.get(id) ?? [148, 163, 184];
        if (focusId !== null && id !== focusId) {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          r += (gray - r) * 0.72;
          g += (gray - g) * 0.72;
          b += (gray - b) * 0.72;
          const fade = dark ? 0.48 : 0.34;
          r += ((dark ? 16 : 244) - r) * fade;
          g += ((dark ? 24 : 247) - g) * fade;
          b += ((dark ? 38 : 251) - b) * fade;
        }
      }

      const k = i * 4;
      rgba[k] = r;
      rgba[k + 1] = g;
      rgba[k + 2] = b;
      rgba[k + 3] = a;
    }
    ctx.putImageData(image, 0, 0);
  }

  function renderOverlayCanvas(side) {
    const ds = state.dataset;
    const canvas = $(`${side}Overlay`);
    const baseRect = $(`${side}Canvas`).getBoundingClientRect();
    const cssWidth = baseRect.width || ds.width;
    const cssHeight = baseRect.height || ds.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));

    const ctx = canvas.getContext('2d');
    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = ds.width;
    pixelCanvas.height = ds.height;
    const pixelCtx = pixelCanvas.getContext('2d');
    const image = pixelCtx.createImageData(ds.width, ds.height);
    const rgba = image.data;
    const raster = side === 'truth' ? ds.truth : ds.prediction;
    const ownId = side === 'truth' ? state.focus.truthId : state.focus.predictionId;
    const { truthId, predictionId } = state.focus;

    for (let i = 0; i < ds.pixelCount; i += 1) {
      const x = i % ds.width;
      const y = (i / ds.width) | 0;
      const t = ds.truth[i];
      const p = ds.prediction[i];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (side === 'prediction' && t === Core.IGNORE_ID) {
        const stripe = ((x + y) % 10) < 4;
        r = 100; g = 116; b = 139; a = stripe ? 115 : 70;
      }

      const isIntersection =
        truthId !== null && predictionId !== null &&
        t === truthId && p === predictionId &&
        t !== Core.IGNORE_ID;

      if (isIntersection) {
        r = 245; g = 158; b = 11; a = 155;
      } else if (ownId !== null && raster[i] === ownId) {
        r = isDark() ? 117 : 29;
        g = isDark() ? 167 : 95;
        b = isDark() ? 255 : 209;
        a = 58;
      }

      const k = i * 4;
      rgba[k] = r;
      rgba[k + 1] = g;
      rgba[k + 2] = b;
      rgba[k + 3] = a;
    }
    pixelCtx.putImageData(image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelCanvas, 0, 0, canvas.width, canvas.height);

    // Work in data-pixel coordinates. The high-DPI backing store keeps the
    // contour stroke at a constant CSS-pixel width even for tiny PGMs.
    ctx.setTransform(canvas.width / ds.width, 0, 0, canvas.height / ds.height, 0, 0);
    strokeObjectContour(ctx, side, ownId, canvas);
  }

  function strokeObjectContour(ctx, side, id, canvas) {
    if (id === null || id === 0 || !state.dataset) return;
    const ds = state.dataset;
    const raster = side === 'truth' ? ds.truth : ds.prediction;
    const rect = canvas.getBoundingClientRect();
    const cssPixelsPerDataPixel = rect.width > 0 ? rect.width / ds.width : 1;
    const path = new Path2D();

    for (let y = 0; y < ds.height; y += 1) {
      for (let x = 0; x < ds.width; x += 1) {
        const i = y * ds.width + x;
        if (raster[i] !== id) continue;

        if (y === 0 || raster[i - ds.width] !== id) {
          path.moveTo(x, y);
          path.lineTo(x + 1, y);
        }
        if (y === ds.height - 1 || raster[i + ds.width] !== id) {
          path.moveTo(x, y + 1);
          path.lineTo(x + 1, y + 1);
        }
        if (x === 0 || raster[i - 1] !== id) {
          path.moveTo(x, y);
          path.lineTo(x, y + 1);
        }
        if (x === ds.width - 1 || raster[i + 1] !== id) {
          path.moveTo(x + 1, y);
          path.lineTo(x + 1, y + 1);
        }
      }
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.58)';
    ctx.lineWidth = 5 / cssPixelsPerDataPixel;
    ctx.stroke(path);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.1 / cssPixelsPerDataPixel;
    ctx.stroke(path);
    ctx.restore();
  }

  function renderLabels(side) {
    const ds = state.dataset;
    const layer = $(`${side}Labels`);
    layer.replaceChildren();
    layer.hidden = !state.showLabels;
    const objects = side === 'truth' ? ds.truthObjects : ds.predictionObjects;
    const activeId = side === 'truth' ? state.focus.truthId : state.focus.predictionId;

    for (const obj of objects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mask-label${obj.id === activeId ? ' active' : ''}`;
      button.dataset.side = side;
      button.dataset.id = String(obj.id);
      button.textContent = String(obj.id);
      button.style.left = `${((obj.centroid.x + 0.5) / ds.width) * 100}%`;
      button.style.top = `${((obj.centroid.y + 0.5) / ds.height) * 100}%`;
      button.title = `${side === 'truth' ? '真值' : '预测'}编号 ${obj.id}，面积 ${obj.area}`;
      layer.appendChild(button);
    }
  }

  /* ---------- viewport interactions ---------- */

  function bindView() {
    $('labelToggle').addEventListener('change', (event) => {
      state.showLabels = event.target.checked;
      $('truthLabels').hidden = !state.showLabels;
      $('predictionLabels').hidden = !state.showLabels;
    });

    $('zoomIn').addEventListener('click', () => {
      const cell = state.cell ?? currentFitCell();
      state.cell = Math.min(64, cell * 1.6);
      applyCell();
    });
    $('zoomOut').addEventListener('click', () => {
      const cell = state.cell ?? currentFitCell();
      state.cell = Math.max(0.025, cell / 1.6);
      applyCell();
    });
    $('zoomFit').addEventListener('click', () => {
      state.cell = null;
      applyCell();
    });

    for (const side of ['truth', 'prediction']) {
      const canvas = $(`${side}Canvas`);
      canvas.addEventListener('click', (event) => {
        const pos = eventPixel(canvas, event);
        if (pos) selectAt(side, pos.x, pos.y);
      });
      canvas.addEventListener('pointermove', (event) => {
        const pos = eventPixel(canvas, event);
        if (pos) updateHover(pos);
      });
      canvas.addEventListener('pointerleave', clearHover);

      $(`${side}Labels`).addEventListener('click', (event) => {
        const label = event.target.closest('.mask-label');
        if (!label) return;
        event.stopPropagation();
        selectAt(side, null, null, Number(label.dataset.id));
      });
    }

    bindScrollSync();

    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (state.dataset && state.cell === null) {
          renderOverlayCanvas('truth');
          renderOverlayCanvas('prediction');
        }
      });
    });
  }

  function bindScrollSync() {
    const a = $('truthViewport');
    const b = $('predictionViewport');
    let syncing = false;
    const syncFrom = (source, target) => {
      source.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        target.scrollLeft = source.scrollLeft;
        target.scrollTop = source.scrollTop;
        requestAnimationFrame(() => { syncing = false; });
      }, { passive: true });
    };
    syncFrom(a, b);
    syncFrom(b, a);
  }

  function currentFitCell() {
    if (!state.dataset) return 1;
    return $('truthStack').getBoundingClientRect().width / state.dataset.width;
  }

  function applyCell() {
    if (!state.dataset) return;
    for (const id of ['truthStack', 'predictionStack']) {
      const stack = $(id);
      if (state.cell === null) {
        stack.classList.add('fit');
        stack.style.width = '';
      } else {
        stack.classList.remove('fit');
        stack.style.width = `${state.dataset.width * state.cell}px`;
      }
    }
    $('zoomReadout').textContent = state.cell === null
      ? '适应'
      : `${state.cell >= 1 ? state.cell.toFixed(1) : state.cell.toFixed(2)} px/格`;

    // Contour widths are expressed in CSS pixels, so recompute after scaling.
    if (state.dataset) {
      renderOverlayCanvas('truth');
      renderOverlayCanvas('prediction');
    }
  }

  function eventPixel(canvas, event) {
    const ds = state.dataset;
    if (!ds) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * ds.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * ds.height);
    if (x < 0 || y < 0 || x >= ds.width || y >= ds.height) return null;
    return { x, y };
  }

  function updateHover(pos) {
    const ds = state.dataset;
    state.hover = pos;
    for (const side of ['truth', 'prediction']) {
      const crosshair = $(`${side}Crosshair`);
      crosshair.hidden = false;
      crosshair.querySelector('.cross-v').style.left = `${((pos.x + 0.5) / ds.width) * 100}%`;
      crosshair.querySelector('.cross-h').style.top = `${((pos.y + 0.5) / ds.height) * 100}%`;
    }
    const i = pos.y * ds.width + pos.x;
    const t = ds.truth[i];
    const p = ds.prediction[i];
    const text = `x ${pos.x}, y ${pos.y} · 真值 ${formatPixelId(t, true)} · 预测 ${formatPixelId(p, false)}`;
    $('truthReadout').textContent = text;
    $('predictionReadout').textContent = text;
  }

  function clearHover() {
    $('truthCrosshair').hidden = true;
    $('predictionCrosshair').hidden = true;
    if (state.dataset) {
      $('truthReadout').textContent = '点击真值实例或编号进行点选。';
      $('predictionReadout').textContent = '点击预测实例或编号进行点选。';
    }
  }

  function formatPixelId(id, isTruth) {
    if (id === 0) return '0/背景';
    if (id === Core.IGNORE_ID && isTruth) return '65535/忽略';
    return String(id);
  }

  function selectAt(side, x, y, explicitId = null) {
    const ds = state.dataset;
    if (!ds) return;

    let id = explicitId;
    if (id === null) {
      const i = y * ds.width + x;
      id = side === 'truth' ? ds.truth[i] : ds.prediction[i];
    }

    const result = activeResult();
    if (side === 'truth') {
      if (id === 0) {
        state.focus = { truthId: null, predictionId: null };
      } else if (id === Core.IGNORE_ID) {
        state.focus = { truthId: Core.IGNORE_ID, predictionId: null };
      } else {
        const pair = result?.pairs.find((p) => p.truthId === id);
        state.focus = { truthId: id, predictionId: pair ? pair.predictionId : null };
      }
    } else {
      if (id === 0) {
        state.focus = { truthId: null, predictionId: null };
      } else {
        const pair = result?.pairs.find((p) => p.predictionId === id);
        state.focus = { truthId: pair ? pair.truthId : null, predictionId: id };
      }
    }
    renderFocusChanges();
  }

  function renderFocusChanges() {
    renderBaseCanvas('truth');
    renderBaseCanvas('prediction');
    renderOverlayCanvas('truth');
    renderOverlayCanvas('prediction');
    renderLabels('truth');
    renderLabels('prediction');
    renderPairTable();
    renderUnmatched();
    renderInspector();
  }

  /* ---------- threshold table ---------- */

  function bindTablesAndInspector() {
    $('thresholdTableBody').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-index]');
      if (!row) return;
      state.activeThreshold = Number(row.dataset.index);
      state.focus = { truthId: null, predictionId: null };
      const firstPair = activeResult()?.pairs?.[0];
      if (firstPair) state.focus = { truthId: firstPair.truthId, predictionId: firstPair.predictionId };
      renderAllDataViews();
    });

    $('thresholdTableBody').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('tr[data-index]');
      if (!row) return;
      event.preventDefault();
      state.activeThreshold = Number(row.dataset.index);
      renderAllDataViews();
    });

    $('pairTableBody').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-truth-id]');
      if (!row) return;
      state.focus = {
        truthId: Number(row.dataset.truthId),
        predictionId: Number(row.dataset.predictionId),
      };
      renderFocusChanges();
    });

    $('unmatchedBody').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      const id = Number(chip.dataset.id);
      if (chip.dataset.side === 'truth') {
        const pair = activeResult()?.pairs.find((p) => p.truthId === id);
        state.focus = { truthId: id, predictionId: pair ? pair.predictionId : null };
      } else {
        const pair = activeResult()?.pairs.find((p) => p.predictionId === id);
        state.focus = { truthId: pair ? pair.truthId : null, predictionId: id };
      }
      renderFocusChanges();
    });

    $('inspectorBody').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-candidate-truth-id]');
      if (!row) return;
      state.focus = {
        truthId: Number(row.dataset.candidateTruthId),
        predictionId: Number(row.dataset.candidatePredictionId),
      };
      renderFocusChanges();
    });

    $('exportJsonButton').addEventListener('click', () => {
      openJsonModal();
      downloadJson();
    });
    $('copyJsonButton').addEventListener('click', async () => {
      const text = buildJson();
      state.lastJson = text;
      const ok = await copyToClipboard(text);
      if (ok) toast('各档配对与计数 JSON 已复制。');
      else openJsonModal();
    });
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
  }

  function renderThresholdTable() {
    const body = $('thresholdTableBody');
    if (!state.dataset) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8" class="empty-cell">等待数据。</td></tr>';
      return;
    }
    if (state.results.length === 0) {
      const message = state.computing ? '正在计算各档匹配…' : '阈值输入无效，请按提示修正。';
      body.innerHTML = `<tr class="empty-row"><td colspan="8" class="empty-cell">${message}</td></tr>`;
      return;
    }

    body.replaceChildren();
    state.results.forEach((result, index) => {
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);
      tr.tabIndex = 0;
      if (index === state.activeThreshold) tr.classList.add('active');
      const c = result.counts;
      const truthRate = c.truthInstances ? c.matchedPairs / c.truthInstances : null;
      const predRate = c.predictionInstances ? c.matchedPairs / c.predictionInstances : null;
      tr.innerHTML = `
        <td><strong>${result.thresholdPermyriad}</strong> <span class="hint">‱ · ${(result.thresholdRatio * 100).toFixed(2)}%</span></td>
        <td class="num">${c.eligibleEdges}</td>
        <td class="num"><strong>${c.matchedPairs}</strong></td>
        <td class="num">${c.unmatchedTruth}</td>
        <td class="num">${c.unmatchedPrediction}</td>
        <td class="num">${formatPercent(truthRate)}</td>
        <td class="num">${formatPercent(predRate)}</td>
        <td class="num">${result.scoreMillionTotal.toLocaleString()}</td>
      `;
      body.appendChild(tr);
    });
  }

  function renderPairTable() {
    const body = $('pairTableBody');
    const result = activeResult();
    body.replaceChildren();

    if (!result || result.pairs.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      tr.innerHTML = '<td colspan="6" class="empty-cell">当前档位没有配对。可降低阈值或点选未配对象查看候选重叠。</td>';
      body.appendChild(tr);
      return;
    }

    for (const pair of result.pairs) {
      const tr = document.createElement('tr');
      tr.dataset.truthId = String(pair.truthId);
      tr.dataset.predictionId = String(pair.predictionId);
      if (state.focus.truthId === pair.truthId && state.focus.predictionId === pair.predictionId) {
        tr.classList.add('active');
      }
      tr.innerHTML = `
        <td class="mono"><strong>${pair.truthId}</strong></td>
        <td class="mono"><strong>${pair.predictionId}</strong></td>
        <td class="num">${pair.intersectionArea.toLocaleString()}</td>
        <td class="num">${pair.unionArea.toLocaleString()}</td>
        <td class="mono">${pair.iouExact}</td>
        <td class="num mono">${(pair.iouMillionFloor / 1_000_000).toFixed(6)}</td>
      `;
      body.appendChild(tr);
    }
  }

  function renderUnmatched() {
    const body = $('unmatchedBody');
    const result = activeResult();
    body.replaceChildren();
    if (!result) {
      body.innerHTML = '<p class="empty-state">有效阈值结果出现后，这里列出当前档未配编号。</p>';
      return;
    }

    body.appendChild(renderChipGroup('真值', 'truth', result.unmatchedTruthIds));
    body.appendChild(renderChipGroup('预测', 'prediction', result.unmatchedPredictionIds));
  }

  function renderChipGroup(label, side, ids) {
    const group = document.createElement('div');
    group.className = 'unmatched-group';
    const activeId = side === 'truth' ? state.focus.truthId : state.focus.predictionId;
    const chips = ids.length
      ? `<div class="chip-row">${ids.map((id) => `
          <button class="chip${id === activeId ? ' active' : ''}" type="button" data-side="${side}" data-id="${id}">${id}</button>
        `).join('')}</div>`
      : `<p class="all-matched">当前档没有未配${label}。</p>`;
    group.innerHTML = `<h3>${label}未配 · ${ids.length}</h3>${chips}`;
    return group;
  }

  /* ---------- inspector ---------- */

  function renderInspector() {
    const body = $('inspectorBody');
    const ds = state.dataset;
    if (!ds) {
      body.innerHTML = '<p class="empty-state">导入 P5 PGM 后，这里显示精确交集、并集和候选边。</p>';
      return;
    }

    const { truthId, predictionId } = state.focus;
    if (truthId === null && predictionId === null) {
      body.innerHTML = `
        <p class="empty-state">点击掩膜实例、编号标签、配对行或未配编号，查看交集、并集、面积和候选重叠。</p>
        <div class="metric-grid">
          ${metric('有效像素', ds.validPixels.toLocaleString())}
          ${metric('忽略像素', ds.ignoredPixels.toLocaleString())}
          ${metric('有效真值', String(ds.truthIds.length))}
          ${metric('有效预测', String(ds.predictionIds.length))}
        </div>`;
      return;
    }

    if (truthId === Core.IGNORE_ID) {
      body.innerHTML = `
        <div class="focus-title"><span class="id-pill">真值 65535</span>${statusPill('warn', '忽略区')}</div>
        <p class="exact-line">这些像素在两图面积、交集和并集中均剔除；完全落在此区域的预测实例会变空且不参与匹配。</p>
        <div class="metric-grid">${metric('忽略像素', ds.ignoredPixels.toLocaleString())}${metric('有效像素', ds.validPixels.toLocaleString())}</div>`;
      return;
    }

    const truthObject = ds.truthObjects.find((o) => o.id === truthId) ?? null;
    const predictionObject = ds.predictionObjects.find((o) => o.id === predictionId) ?? null;
    const excludedTruth = ds.excludedTruth.find((o) => o.id === truthId);
    const excludedPrediction = ds.excludedPrediction.find((o) => o.id === predictionId);
    const result = activeResult();
    const chosenPair = result?.pairs.find((p) => p.truthId === truthId && p.predictionId === predictionId) ?? null;
    const truthPair = result?.pairs.find((p) => p.truthId === truthId) ?? null;
    const predictionPair = result?.pairs.find((p) => p.predictionId === predictionId) ?? null;

    let status = '';
    if (excludedTruth || excludedPrediction) {
      status = statusPill('warn', '剔除后为空，不参与匹配');
    } else if (chosenPair) {
      status = statusPill('good', '当前档配对');
    } else if (truthId !== null && predictionId !== null && truthObject && predictionObject && result) {
      const ti = ds.truthIndex.get(truthId);
      const pj = ds.predictionIndex.get(predictionId);
      const eligible = Core.isEligible(ds, ti, pj, result.threshold);
      status = eligible
        ? statusPill('warn', '有资格，但全局最优未选此边')
        : statusPill('bad', '未达当前精确阈值');
    } else if (truthId !== null && truthObject) {
      status = truthPair
        ? statusPill('accent', `本档已配预测 ${truthPair.predictionId}`)
        : statusPill('bad', '当前档未配');
    } else if (predictionId !== null && predictionObject) {
      status = predictionPair
        ? statusPill('accent', `本档已配真值 ${predictionPair.truthId}`)
        : statusPill('bad', '当前档未配');
    }

    const title = `
      <div class="focus-title">
        ${truthId !== null ? `<span class="id-pill">真 ${truthId}</span>` : ''}
        ${truthId !== null && predictionId !== null ? '<span class="arrow">↔</span>' : ''}
        ${predictionId !== null ? `<span class="id-pill">预 ${predictionId}</span>` : ''}
        ${status}
      </div>`;

    const excludedNote = excludedTruth
      ? `<p class="exact-line">真值编号 ${excludedTruth.id}：原始 ${excludedTruth.rawArea} px；${excludedTruth.reason}。</p>`
      : excludedPrediction
        ? `<p class="exact-line">预测编号 ${excludedPrediction.id}：原始 ${excludedPrediction.rawArea} px；${excludedPrediction.reason}。</p>`
        : '';

    let overlap = null;
    let eligible = false;
    if (truthObject && predictionObject) {
      const ti = truthObject.index;
      const pj = predictionObject.index;
      overlap = Core.getOverlap(ds, ti, pj);
      if (result) eligible = Core.isEligible(ds, ti, pj, result.threshold);
    }

    const metrics = `
      <div class="metric-grid">
        ${metric('交集面积', overlap ? overlap.intersection.toLocaleString() : '—')}
        ${metric('并集面积', overlap ? overlap.union.toLocaleString() : '—')}
        ${metric('真值有效面积', truthObject ? truthObject.area.toLocaleString() : excludedTruth ? excludedTruth.rawArea.toLocaleString() : '—')}
        ${metric('预测有效面积', predictionObject ? predictionObject.area.toLocaleString() : excludedPrediction ? excludedPrediction.rawArea.toLocaleString() : '—')}
      </div>`;

    const exact = overlap
      ? `<p class="exact-line">精确 IoU：<code>${overlap.intersection}/${overlap.union}</code>
         ≈ ${(overlap.intersection / overlap.union).toFixed(8)}；向下取整到百万分：
         <strong class="mono">${(overlap.iouMillionFloor / 1_000_000).toFixed(6)}</strong>
         ${result ? `；当前阈值资格：<strong>${eligible ? '满足' : '不满足'}</strong>` : ''}
       </p>`
      : '<p class="exact-line">选择一个真值和一个预测编号后，这里显示两者的精确交并面积。</p>';

    body.innerHTML = title + excludedNote + metrics + exact + renderCandidateTable(truthObject, predictionObject);
  }

  function metric(label, value) {
    return `<div class="metric"><span class="metric-label">${label}</span><span class="metric-value">${value}</span></div>`;
  }

  function statusPill(kind, text) {
    const cls = {
      good: 'status-good',
      warn: 'status-warn',
      bad: 'status-bad',
      accent: 'status-accent',
    }[kind] ?? 'status-accent';
    return `<span class="status-pill ${cls}">${text}</span>`;
  }

  function renderCandidateTable(truthObject, predictionObject) {
    const ds = state.dataset;
    const result = activeResult();
    let anchorSide = null;
    let anchor = null;
    if (truthObject) {
      anchorSide = 'truth';
      anchor = truthObject;
    } else if (predictionObject) {
      anchorSide = 'prediction';
      anchor = predictionObject;
    } else {
      return '';
    }

    const rows = [];
    if (anchorSide === 'truth') {
      for (let pj = 0; pj < ds.predictionIds.length; pj += 1) {
        const overlap = Core.getOverlap(ds, anchor.index, pj);
        if (overlap.intersection === 0) continue;
        const pId = ds.predictionIds[pj];
        const eligible = result ? Core.isEligible(ds, anchor.index, pj, result.threshold) : false;
        const chosen = result?.pairs.some((p) => p.truthId === anchor.id && p.predictionId === pId);
        rows.push({ otherId: pId, otherIndex: pj, overlap, eligible, chosen });
      }
      rows.sort((a, b) => b.overlap.intersection - a.overlap.intersection || a.overlap.union - b.overlap.union);
      return candidateTableHtml('预测候选', anchor.id, 'truth', rows, result);
    }

    for (let ti = 0; ti < ds.truthIds.length; ti += 1) {
      const overlap = Core.getOverlap(ds, ti, anchor.index);
      if (overlap.intersection === 0) continue;
      const tId = ds.truthIds[ti];
      const eligible = result ? Core.isEligible(ds, ti, anchor.index, result.threshold) : false;
      const chosen = result?.pairs.some((p) => p.truthId === tId && p.predictionId === anchor.id);
      rows.push({ otherId: tId, otherIndex: ti, overlap, eligible, chosen });
    }
    rows.sort((a, b) => b.overlap.intersection - a.overlap.intersection || a.overlap.union - b.overlap.union);
    return candidateTableHtml('真值候选', anchor.id, 'prediction', rows, result);
  }

  function candidateTableHtml(title, anchorId, anchorSide, rows, result) {
    if (rows.length === 0) {
      return `<h3 class="candidate-title">${title} · 0</h3><p class="exact-line">没有任何非零交集。</p>`;
    }
    const headOther = anchorSide === 'truth' ? '预测编号' : '真值编号';
    const bodyRows = rows.slice(0, 80).map((row) => {
      const attrs = anchorSide === 'truth'
        ? `data-candidate-truth-id="${anchorId}" data-candidate-prediction-id="${row.otherId}"`
        : `data-candidate-truth-id="${row.otherId}" data-candidate-prediction-id="${state.focus.predictionId}"`;
      let stateText = '低于阈值';
      let stateClass = 'status-bad';
      if (row.chosen) { stateText = '本档配对'; stateClass = 'status-good'; }
      else if (row.eligible) { stateText = '有资格未选'; stateClass = 'status-warn'; }
      return `
        <tr ${attrs} style="cursor:pointer">
          <td class="mono">${row.otherId}</td>
          <td class="num">${row.overlap.intersection}</td>
          <td class="num">${row.overlap.union}</td>
          <td class="num mono">${(row.overlap.iouMillionFloor / 1_000_000).toFixed(6)}</td>
          <td><span class="status-pill ${stateClass}">${stateText}</span></td>
        </tr>`;
    }).join('');

    return `
      <h3 class="candidate-title">${title} · ${rows.length}${rows.length > 80 ? '（显示交集最大的 80 条）' : ''}</h3>
      <div class="candidate-scroll table-scroll">
        <table class="data-table candidate-table">
          <thead><tr><th>${headOther}</th><th class="num">交</th><th class="num">并</th><th class="num">IoU↓百万</th><th>状态</th></tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  }

  /* ---------- JSON export / modal ---------- */

  function buildJson() {
    const report = Core.buildReport(state.dataset, state.results, {
      source: state.sourceLabel,
      exportedAt: new Date().toISOString(),
    });
    return JSON.stringify(report, null, 2);
  }

  function bindModal() {
    $('jsonClose').addEventListener('click', closeJsonModal);
    $('jsonModal').addEventListener('click', (event) => {
      if (event.target === $('jsonModal')) closeJsonModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('jsonModal').hidden) closeJsonModal();
    });
    $('modalCopyButton').addEventListener('click', async () => {
      const ok = await copyToClipboard($('jsonOutput').value);
      if (ok) toast('JSON 已复制。');
    });
    $('modalDownloadButton').addEventListener('click', downloadJson);
  }

  function openJsonModal() {
    if (!state.dataset || state.results.length === 0) return;
    state.lastJson = buildJson();
    $('jsonOutput').value = state.lastJson;
    $('jsonMeta').textContent =
      `${state.results.length} 个阈值 · ${state.dataset.truthIds.length} 个真值 · ${state.dataset.predictionIds.length} 个预测`;
    $('jsonModal').hidden = false;
  }

  function closeJsonModal() {
    $('jsonModal').hidden = true;
  }

  function downloadJson() {
    if (!state.dataset || state.results.length === 0) return;
    const text = $('jsonOutput').value || buildJson();
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `instance-agreement-${state.dataset.width}x${state.dataset.height}-${state.results.length}thresholds.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已生成 JSON 下载。');
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }

    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  if (!Core) {
    document.body.innerHTML = '<p style="padding:24px">agreement-core.js 未能载入。</p>';
    return;
  }
  init();
})();
