/* UI  wiring:渐进渲染、暂停/续算/取消、探针、导出 */
(function () {
  'use strict';
  var E = window.MisEngine;

  var els = {
    sampleSelect: document.getElementById('sampleSelect'),
    loadSampleBtn: document.getElementById('loadSampleBtn'),
    fileInput: document.getElementById('fileInput'),
    sceneInfo: document.getElementById('sceneInfo'),
    sppInput: document.getElementById('sppInput'),
    depthInput: document.getElementById('depthInput'),
    seedInput: document.getElementById('seedInput'),
    startBtn: document.getElementById('startBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    progressText: document.getElementById('progressText'),
    imageCanvas: document.getElementById('imageCanvas'),
    varCanvas: document.getElementById('varCanvas'),
    statsBox: document.getElementById('statsBox'),
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    exportPngBtn: document.getElementById('exportPngBtn'),
    probePoint: document.getElementById('probePoint'),
    probeNormal: document.getElementById('probeNormal'),
    probeRho: document.getElementById('probeRho'),
    probeSamples: document.getElementById('probeSamples'),
    probeSeed: document.getElementById('probeSeed'),
    probeBtn: document.getElementById('probeBtn'),
    probeResult: document.getElementById('probeResult')
  };

  var scene = null;
  var sceneId = 0;
  var render = null;        // 引擎渲染状态
  var renderSig = null;     // 参数签名,变了则重开
  var running = false;
  var startTime = 0;
  var elapsedBefore = 0;

  /* ---------- 样例与场景加载 ---------- */
  Object.keys(window.MIS_SAMPLES).forEach(function (k) {
    if (k === 'reference') return;
    var opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    els.sampleSelect.appendChild(opt);
  });

  function loadScene(json, label) {
    try {
      scene = E.buildScene(json);
      sceneId++;
      resetRender();
      var emissive = scene.lights.length;
      els.sceneInfo.textContent = '已加载 ' + label + ':三角形 ' + scene.faces.length +
        ',发光面 ' + emissive + ',忽略零面积面 ' + scene.ignoredZeroArea +
        ',分辨率 ' + scene.width + '×' + scene.height;
      if (scene.probe) {
        els.probePoint.value = scene.probe.point.join(', ');
        els.probeNormal.value = scene.probe.normal.join(', ');
        els.probeRho.value = scene.probe.rho.join(', ');
      }
      clearCanvases();
    } catch (err) {
      scene = null;
      els.sceneInfo.textContent = '加载失败:' + err.message;
    }
  }

  els.loadSampleBtn.addEventListener('click', function () {
    var key = els.sampleSelect.value;
    loadScene(window.MIS_SAMPLES[key], '内置样例 ' + key);
  });

  els.fileInput.addEventListener('change', function () {
    var f = els.fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        loadScene(JSON.parse(reader.result), f.name);
      } catch (err) {
        els.sceneInfo.textContent = 'JSON 解析失败:' + err.message;
      }
    };
    reader.readAsText(f);
  });

  /* ---------- 渲染控制 ---------- */
  function currentMode() {
    var r = document.querySelector('input[name="mode"]:checked');
    return r ? r.value : 'mis';
  }

  function currentSig() {
    return [sceneId, currentMode(), els.seedInput.value, els.depthInput.value].join('|');
  }

  function resetRender() {
    render = null;
    running = false;
    elapsedBefore = 0;
    updateButtons();
    els.progressText.textContent = '';
    els.statsBox.textContent = '';
    els.exportJsonBtn.disabled = true;
    els.exportPngBtn.disabled = true;
  }

  function updateButtons() {
    var hasScene = !!scene;
    var hasRender = !!render;
    els.startBtn.disabled = !hasScene || running;
    els.pauseBtn.disabled = !running;
    els.resumeBtn.disabled = !(hasRender && !running && !render.done);
    els.cancelBtn.disabled = !hasRender;
    els.exportJsonBtn.disabled = !(hasRender && render.stats.completedPaths > 0 && !running);
    els.exportPngBtn.disabled = els.exportJsonBtn.disabled;
  }

  function renderLoop() {
    if (!running || !render) return;
    E.renderBatch(render, 40);
    drawViews();
    updateProgress();
    if (render.done) {
      running = false;
      elapsedBefore += Date.now() - startTime;
      updateButtons();
      updateProgress();
      return;
    }
    setTimeout(renderLoop, 0);
  }

  els.startBtn.addEventListener('click', function () {
    if (!scene) return;
    var spp = Math.max(1, Math.min(1024, parseInt(els.sppInput.value, 10) || 1));
    els.sppInput.value = spp;
    var depth = Math.max(0, Math.min(8, parseInt(els.depthInput.value, 10) || 0));
    els.depthInput.value = depth;
    var seed = Math.max(0, parseInt(els.seedInput.value, 10) || 0) >>> 0;

    if (render && currentSig() === renderSig && !render.done && render.targetSpp === spp) {
      // 与现有任务一致:直接继续
    } else if (render && currentSig() === renderSig && spp > render.nextSample) {
      // 参数不变、提高 spp:在既有累积上续算,结果与一次算完一致
      render.targetSpp = spp;
      render.done = false;
    } else {
      render = E.createRender(scene, {
        mode: currentMode(), spp: spp, seed: seed, maxDepth: depth
      });
      renderSig = currentSig();
      elapsedBefore = 0;
    }
    running = true;
    startTime = Date.now();
    updateButtons();
    renderLoop();
  });

  els.pauseBtn.addEventListener('click', function () {
    if (!running) return;
    running = false;
    elapsedBefore += Date.now() - startTime;
    updateButtons();
    updateProgress();
  });

  els.resumeBtn.addEventListener('click', function () {
    if (!render || render.done || running) return;
    running = true;
    startTime = Date.now();
    updateButtons();
    renderLoop();
  });

  els.cancelBtn.addEventListener('click', function () {
    resetRender();
    clearCanvases();
  });

  /* ---------- 显示 ---------- */
  var imgCtx = els.imageCanvas.getContext('2d');
  var varCtx = els.varCanvas.getContext('2d');

  function clearCanvases() {
    imgCtx.clearRect(0, 0, els.imageCanvas.width, els.imageCanvas.height);
    varCtx.clearRect(0, 0, els.varCanvas.width, els.varCanvas.height);
  }

  function heatColor(t) {
    // 蓝 → 青 → 黄 → 红
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var r, g, b;
    if (t < 0.33) { var u = t / 0.33; r = 0; g = u; b = 1; }
    else if (t < 0.66) { var u2 = (t - 0.33) / 0.33; r = u2; g = 1; b = 1 - u2; }
    else { var u3 = (t - 0.66) / 0.34; r = 1; g = 1 - u3; b = 0; }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function drawViews() {
    if (!render) return;
    var w = render.width, h = render.height;
    var res = E.resultArrays(render);
    var img = E.rgbToSrgb8(res.rgb, w, h);
    var imgData = new ImageData(img, w, h);
    imgCtx.putImageData(imgData, 0, 0);

    var vmax = 0;
    for (var i = 0; i < res.variance.length; i++) {
      if (res.variance[i] > vmax) vmax = res.variance[i];
    }
    var varImg = new Uint8ClampedArray(w * h * 4);
    for (var p = 0; p < w * h; p++) {
      var t = vmax > 0 ? Math.log(1 + res.variance[p]) / Math.log(1 + vmax) : 0;
      var c = heatColor(t);
      varImg[p * 4] = c[0]; varImg[p * 4 + 1] = c[1]; varImg[p * 4 + 2] = c[2];
      varImg[p * 4 + 3] = 255;
    }
    varCtx.putImageData(new ImageData(varImg, w, h), 0, 0);
  }

  function fmt(x) { return Number(x).toPrecision(4); }

  function updateProgress() {
    if (!render) return;
    var sppDone = render.nextSample + (render.nextPixel > 0 ? render.nextPixel / (render.width * render.height) : 0);
    var elapsed = (elapsedBefore + (running ? Date.now() - startTime : 0)) / 1000;
    els.progressText.textContent =
      (render.done ? '完成' : (running ? '渲染中' : '已暂停')) +
      ' · ' + sppDone.toFixed(1) + '/' + render.targetSpp + ' spp · ' + elapsed.toFixed(1) + ' s';
    var s = render.stats;
    var picks = s.lightPicks.map(function (c, i) { return '灯' + i + ': ' + c; }).join('  ');
    els.statsBox.textContent =
      '完成路径数: ' + s.completedPaths + '\n' +
      '每灯选择次数: ' + (s.lightPicks.length ? picks : '(无灯)') + '\n' +
      '被忽略零面积面数: ' + s.ignoredZeroArea;
  }

  /* ---------- 导出 ---------- */
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  els.exportJsonBtn.addEventListener('click', function () {
    if (!render) return;
    var res = E.resultArrays(render);
    var out = {
      width: render.width,
      height: render.height,
      spp: render.nextSample,
      mode: render.mode,
      seed: render.seed,
      max_depth: render.maxDepth,
      rgb: Array.prototype.map.call(res.rgb, fmt),
      variance: Array.prototype.map.call(res.variance, fmt),
      stats: {
        light_picks: render.stats.lightPicks.slice(),
        completed_paths: render.stats.completedPaths,
        ignored_zero_area_faces: render.stats.ignoredZeroArea
      }
    };
    download(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'render-float.json');
  });

  els.exportPngBtn.addEventListener('click', function () {
    if (!render) return;
    var res = E.resultArrays(render);
    var data = E.rgbToSrgb8(res.rgb, render.width, render.height);
    var c = document.createElement('canvas');
    c.width = render.width; c.height = render.height;
    c.getContext('2d').putImageData(new ImageData(data, render.width, render.height), 0, 0);
    c.toBlob(function (b) { download(b, 'render.png'); }, 'image/png');
  });

  /* ---------- 探针 ---------- */
  function parseVec3(text, name) {
    var parts = text.split(',').map(function (s) { return parseFloat(s); });
    if (parts.length !== 3 || parts.some(function (v) { return !Number.isFinite(v); })) {
      throw new Error(name + ' 须为三个逗号分隔数字');
    }
    return parts;
  }

  els.probeBtn.addEventListener('click', function () {
    if (!scene) { els.probeResult.textContent = '请先加载场景'; return; }
    try {
      var point = parseVec3(els.probePoint.value, '点');
      var normal = parseVec3(els.probeNormal.value, '法线');
      var rho = parseVec3(els.probeRho.value, 'ρ');
      var n = Math.max(1, parseInt(els.probeSamples.value, 10) || 1);
      var seed = Math.max(0, parseInt(els.probeSeed.value, 10) || 0) >>> 0;
      var stats = { lightPicks: scene.lights.map(function () { return 0; }) };
      var t0 = Date.now();
      var r = E.probeDirect(scene, point, normal, rho, n, seed, stats);
      els.probeResult.textContent =
        '直接光 RGB = [' + r.rgb.map(function (v) { return v.toFixed(6); }).join(', ') + ']' +
        ' · ' + r.samples + ' 样本 · ' + (Date.now() - t0) + ' ms' +
        (stats.lightPicks.length ? ' · 选灯次数 [' + stats.lightPicks.join(', ') + ']' : ' · 场景无灯');
    } catch (err) {
      els.probeResult.textContent = '探针失败:' + err.message;
    }
  });

  /* 默认加载第一个样例 */
  if (els.sampleSelect.options.length) {
    els.sampleSelect.selectedIndex = 0;
    loadScene(window.MIS_SAMPLES[els.sampleSelect.value], '内置样例 ' + els.sampleSelect.value);
  }
})();
