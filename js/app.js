/*
 * 冲印标记定位台 — 界面与交互
 * 依赖 js/locator.js（window.MarkLocator）与 js/sample-data.js（可选样例）。
 */
(function () {
  'use strict';
  var ML = window.MarkLocator;

  var el = function (id) { return document.getElementById(id); };

  var dom = {
    engineText: el('engineText'), sampleChip: el('sampleChip'),
    tplDrop: el('tplDrop'), tplFile: el('tplFile'), tplName: el('tplName'),
    sceneDrop: el('sceneDrop'), sceneFile: el('sceneFile'), sceneName: el('sceneName'),
    sampleBtn: el('sampleBtn'), clearBtn: el('clearBtn'),
    tplCanvas: el('tplCanvas'), sceneCanvas: el('sceneCanvas'), sceneEmpty: el('sceneEmpty'),
    anchorX: el('anchorX'), anchorY: el('anchorY'),
    edgeAuto: el('edgeAuto'), edgeValue: el('edgeValue'), edgeHint: el('edgeHint'),
    minScale: el('minScale'), minScaleOut: el('minScaleOut'),
    maxScale: el('maxScale'), maxScaleOut: el('maxScaleOut'),
    scaleStep: el('scaleStep'), scaleStepOut: el('scaleStepOut'),
    angleStep: el('angleStep'), angleStepOut: el('angleStepOut'),
    minCoverage: el('minCoverage'), minCoverageOut: el('minCoverageOut'),
    mirrorSearch: el('mirrorSearch'),
    runBtn: el('runBtn'), message: el('message'),
    progress: el('progress'), progressBar: el('progressBar'),
    progressText: el('progressText'), progressPct: el('progressPct'),
    stats: el('stats'), resultCount: el('resultCount'),
    resultList: el('resultList'), resultEmpty: el('resultEmpty'),
    selDetail: el('selDetail'), dirtyNote: el('dirtyNote'),
    exportBtn: el('exportBtn'), exportPanel: el('exportPanel'),
    exportCode: el('exportCode'), copyBtn: el('copyBtn'),
    closeExport: el('closeExport'), copyHint: el('copyHint')
  };

  var state = {
    templateImg: null, templateName: '',
    sceneImg: null, sceneName: '',
    anchor: [20, 20],
    result: null,
    selected: -1,
    running: false,
    dirty: false,
    lastRunParams: null,
    objectUrlUsed: false
  };

  var LIMITS = { template: 128, scene: 384 };
  var TPL_TARGET = 176;

  /* ---------------------------------------------------------------- *
   * 工具
   * ---------------------------------------------------------------- */
  function showMessage(text, kind) {
    if (!text) { dom.message.hidden = true; return; }
    dom.message.textContent = text;
    dom.message.className = 'message' + (kind ? ' ' + kind : '');
    dom.message.hidden = false;
  }

  function numberValue(input, fallback) {
    var v = parseFloat(input.value);
    return isFinite(v) ? v : fallback;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------------------------------------------------------- *
   * PGM 读取
   * ---------------------------------------------------------------- */
  function readFileAsBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function acceptTemplate(img, name) {
    state.templateImg = img;
    state.templateName = name;
    dom.tplName.textContent = name + ' · ' + img.width + '×' + img.height;
    if (state.lastRunParams === null) {
      state.anchor = [Math.round(img.width / 2 * 2) / 2, Math.round(img.height / 2 * 2) / 2];
    }
    state.anchor[0] = clamp(state.anchor[0], 0, img.width - 1);
    state.anchor[1] = clamp(state.anchor[1], 0, img.height - 1);
    syncAnchorInputs();
    refreshAutoThreshold();
    drawTemplate();
    state.dirty = true;
    updateDirty();
  }

  function acceptScene(img, name) {
    state.sceneImg = img;
    state.sceneName = name;
    dom.sceneName.textContent = name + ' · ' + img.width + '×' + img.height;
    dom.sceneEmpty.hidden = true;
    drawScene();
    state.dirty = true;
    updateDirty();
  }

  function loadFile(file, kind) {
    if (!file) return;
    readFileAsBuffer(file).then(function (buf) {
      var img;
      try { img = ML.parsePGM(buf); }
      catch (e) { showMessage((kind === 'template' ? '模板：' : '场景：') + e.message, 'error'); return; }
      var limit = kind === 'template' ? LIMITS.template : LIMITS.scene;
      var longest = Math.max(img.width, img.height);
      if (longest > limit) {
        showMessage((kind === 'template' ? '模板' : '场景') + '单边最多 ' + limit + ' px，当前 ' + img.width + '×' + img.height + '。', 'error');
        return;
      }
      showMessage('');
      if (kind === 'template') acceptTemplate(img, file.name);
      else acceptScene(img, file.name);
    }).catch(function (e) { showMessage(e.message, 'error'); });
  }

  function wireDrop(dropEl, inputEl, kind) {
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropEl.addEventListener(evt, function (e) {
        e.preventDefault();
        dropEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropEl.addEventListener(evt, function (e) {
        e.preventDefault();
        dropEl.classList.remove('dragover');
      });
    });
    dropEl.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f, kind);
    });
    inputEl.addEventListener('change', function () {
      if (inputEl.files && inputEl.files[0]) loadFile(inputEl.files[0], kind);
      inputEl.value = '';
    });
  }

  /* ---------------------------------------------------------------- *
   * 模板画布与锚点
   * ---------------------------------------------------------------- */
  function canvasScaleFor(img, target) {
    return clamp(Math.floor(target / Math.max(img.width, img.height)), 1, 8);
  }

  function grayToCanvas(img) {
    var off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    var ctx = off.getContext('2d');
    var imgData = ctx.createImageData(img.width, img.height);
    var d = img.data, out = imgData.data;
    for (var i = 0, j = 0; i < d.length; i++, j += 4) {
      out[j] = d[i]; out[j + 1] = d[i]; out[j + 2] = d[i]; out[j + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return off;
  }

  function themeColor(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function drawTemplate() {
    var cv = dom.tplCanvas;
    var img = state.templateImg;
    if (!img) {
      cv.width = TPL_TARGET; cv.height = TPL_TARGET;
      var c0 = cv.getContext('2d');
      c0.fillStyle = themeColor('--surface-2', '#e6e9e2');
      c0.fillRect(0, 0, cv.width, cv.height);
      cv.style.width = TPL_TARGET + 'px';
      return;
    }
    var S = canvasScaleFor(img, TPL_TARGET);
    cv.width = img.width * S;
    cv.height = img.height * S;
    cv.style.width = cv.width + 'px';
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var off = grayToCanvas(img);
    ctx.drawImage(off, 0, 0, cv.width, cv.height);

    // 锚点十字
    var ax = (state.anchor[0] + 0.5) * S;
    var ay = (state.anchor[1] + 0.5) * S;
    var accent = themeColor('--accent', '#a24c05');
    var ink = themeColor('--ink', '#151a17');
    var arm = Math.max(8, S * 3);
    ctx.lineWidth = Math.max(1, S * 0.4);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(ax - arm, ay); ctx.lineTo(ax + arm, ay);
    ctx.moveTo(ax, ay - arm); ctx.lineTo(ax, ay + arm);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.setLineDash([Math.max(2, S), Math.max(2, S * 0.8)]);
    ctx.beginPath();
    ctx.moveTo(ax - arm, ay); ctx.lineTo(ax + arm, ay);
    ctx.moveTo(ax, ay - arm); ctx.lineTo(ax, ay + arm);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(3, S * 1.2), 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, S * 0.35);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(1.5, S * 0.55), 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  function canvasToImage(cv, clientX, clientY, imgW, imgH) {
    var rect = cv.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width * imgW;
    var y = (clientY - rect.top) / rect.height * imgH;
    return [clamp(x, 0, imgW), clamp(y, 0, imgH)];
  }

  function snapHalf(v) { return Math.round(v * 2) / 2; }

  function syncAnchorInputs() {
    dom.anchorX.value = state.anchor[0];
    dom.anchorY.value = state.anchor[1];
  }

  var tplDragging = false;
  function bindTemplatePointer() {
    var cv = dom.tplCanvas;
    cv.addEventListener('pointerdown', function (e) {
      if (!state.templateImg) return;
      tplDragging = true;
      cv.setPointerCapture(e.pointerId);
      setAnchorFromEvent(e);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!tplDragging || !state.templateImg) return;
      setAnchorFromEvent(e);
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      cv.addEventListener(t, function () { tplDragging = false; });
    });
    cv.addEventListener('keydown', function (e) {
      if (!state.templateImg) return;
      var step = e.shiftKey ? 2 : 0.5;
      var moved = true;
      if (e.key === 'ArrowLeft') state.anchor[0] = clamp(state.anchor[0] - step, 0, state.templateImg.width - 1);
      else if (e.key === 'ArrowRight') state.anchor[0] = clamp(state.anchor[0] + step, 0, state.templateImg.width - 1);
      else if (e.key === 'ArrowUp') state.anchor[1] = clamp(state.anchor[1] - step, 0, state.templateImg.height - 1);
      else if (e.key === 'ArrowDown') state.anchor[1] = clamp(state.anchor[1] + step, 0, state.templateImg.height - 1);
      else moved = false;
      if (moved) {
        e.preventDefault();
        syncAnchorInputs();
        drawTemplate();
        state.dirty = true;
        updateDirty();
      }
    });
  }

  function setAnchorFromEvent(e) {
    var p = canvasToImage(dom.tplCanvas, e.clientX, e.clientY, state.templateImg.width, state.templateImg.height);
    state.anchor = [clamp(snapHalf(p[0]), 0, state.templateImg.width - 1),
                    clamp(snapHalf(p[1]), 0, state.templateImg.height - 1)];
    syncAnchorInputs();
    drawTemplate();
    state.dirty = true;
    updateDirty();
  }

  /* ---------------------------------------------------------------- *
   * 场景画布与叠加
   * ---------------------------------------------------------------- */
  function drawScene() {
    var cv = dom.sceneCanvas;
    var img = state.sceneImg;
    var host = cv.parentElement;
    var avail = Math.max(180, (host ? host.clientWidth : SCENE_TARGET + 16) - 16);
    if (!img) {
      var S0 = clamp(Math.floor(avail / 176), 1, 4);
      cv.width = 176 * S0; cv.height = 146 * S0;
      cv.style.width = '100%';
      var c0 = cv.getContext('2d');
      c0.fillStyle = themeColor('--surface-2', '#e6e9e2');
      c0.fillRect(0, 0, cv.width, cv.height);
      dom.sceneEmpty.hidden = false;
      return;
    }
    // 按可用宽度选非整数放大倍数，窄屏也保持轮廓点可见
    var S = clamp(avail / img.width, 1, 8);
    cv.width = Math.max(1, Math.round(img.width * S));
    cv.height = Math.max(1, Math.round(img.height * S));
    S = cv.width / img.width;
    cv.style.width = cv.width + 'px';
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(grayToCanvas(img), 0, 0, cv.width, cv.height);

    if (!state.result || !state.result.poses.length) {
      dom.sceneEmpty.hidden = false;
      dom.sceneEmpty.textContent = state.result ? '没有达到覆盖率阈值的姿态' : '载入场景后在此显示匹配结果';
      return;
    }
    dom.sceneEmpty.hidden = true;

    var poses = state.result.poses;
    var accent = themeColor('--accent', '#a24c05');
    var matchColor = themeColor('--match', '#0b6f63');
    var missColor = themeColor('--miss', '#ad2146');
    var muted = themeColor('--line-strong', '#9aa598');
    var surface = themeColor('--surface', '#fbfcf9');
    var ink = themeColor('--ink', '#151a17');
    var dotR = clamp(S * 0.55, 1.6, 5);
    var lineW = Math.max(1, S * 0.3);

    // 其他候选：编号环
    for (var i = 0; i < poses.length; i++) {
      if (i === state.selected) continue;
      var p = poses[i];
      var px = (p.x + 0.5) * S, py = (p.y + 0.5) * S;
      var halo = Math.max(8, S * 3.4);
      ctx.beginPath();
      ctx.arc(px, py, halo, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = muted;
      ctx.lineWidth = lineW;
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = '600 ' + Math.max(9, Math.min(14, S * 3)) + 'px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.rank), px, py + 0.5);
    }

    if (state.selected >= 0 && state.selected < poses.length) {
      drawSelectedOverlay(ctx, poses[state.selected], S, matchColor, missColor, dotR, lineW, accent);
    }
  }

  function drawSelectedOverlay(ctx, pose, S, matchColor, missColor, dotR, lineW, accent) {
    var r = state.result;
    if (!r || !r.tpl || !r.scene) return;
    var ev;
    try {
      ev = ML.evaluatePose(pose, r.tpl, r.scene, {
        anchor: r.anchor.slice(), keepPoints: true
      });
    } catch (e) { return; }

    var n = r.tpl.count;
    // 先画失配点（x），再画匹配点（实心点），避免被覆盖
    ctx.lineWidth = Math.max(1, S * 0.4);
    ctx.strokeStyle = missColor;
    var cross = Math.max(2, S * 0.9);
    for (var i = 0; i < n; i++) {
      if (ev.flags[i]) continue;
      var mx = (ev.qx[i] + 0.5) * S, my = (ev.qy[i] + 0.5) * S;
      ctx.beginPath();
      ctx.moveTo(mx - cross, my - cross);
      ctx.lineTo(mx + cross, my + cross);
      ctx.moveTo(mx + cross, my - cross);
      ctx.lineTo(mx - cross, my + cross);
      ctx.stroke();
    }
    ctx.fillStyle = matchColor;
    for (var j = 0; j < n; j++) {
      if (!ev.flags[j]) continue;
      var qx = (ev.qx[j] + 0.5) * S, qy = (ev.qy[j] + 0.5) * S;
      ctx.beginPath();
      ctx.arc(qx, qy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 姿态原点标记：双环
    var ax = (pose.x + 0.5) * S, ay = (pose.y + 0.5) * S;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, S * 0.55);
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(5, S * 2.2), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, S * 0.35);
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(5, S * 2.2), 0, Math.PI * 2);
    ctx.stroke();
    // 角度指示线
    var ang = pose.angle * Math.PI / 180;
    var len = Math.max(9, S * 5);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + Math.cos(ang) * len, ay + Math.sin(ang) * len);
    ctx.stroke();
  }

  function bindScenePointer() {
    dom.sceneCanvas.addEventListener('click', function (e) {
      if (!state.sceneImg || !state.result || !state.result.poses.length) return;
      var p = canvasToImage(dom.sceneCanvas, e.clientX, e.clientY, state.sceneImg.width, state.sceneImg.height);
      var best = -1, bestD = Infinity;
      for (var i = 0; i < state.result.poses.length; i++) {
        var q = state.result.poses[i];
        var d = Math.hypot(q.x - p[0], q.y - p[1]);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 && bestD <= 20 && best !== state.selected) selectResult(best);
    });
  }

  /* ---------------------------------------------------------------- *
   * 参数读取 / 同步
   * ---------------------------------------------------------------- */
  function updateSliderOutputs() {
    dom.minScaleOut.textContent = numberValue(dom.minScale, 0.75).toFixed(2) + '×';
    dom.maxScaleOut.textContent = numberValue(dom.maxScale, 1.4).toFixed(2) + '×';
    dom.scaleStepOut.textContent = numberValue(dom.scaleStep, 0.1).toFixed(2);
    dom.angleStepOut.textContent = numberValue(dom.angleStep, 12).toFixed(0) + '°';
    dom.minCoverageOut.textContent = Math.round(numberValue(dom.minCoverage, 0.62) * 100) + '%';
  }

  function refreshAutoThreshold() {
    if (!state.templateImg || !dom.edgeAuto.checked) return;
    try {
      var t = ML.autoEdgeThreshold(state.templateImg);
      dom.edgeValue.value = Math.round(t);
    } catch (e) { /* ignore */ }
  }

  function updateEdgeControlState() {
    var auto = dom.edgeAuto.checked;
    dom.edgeValue.disabled = auto;
    dom.edgeHint.textContent = auto
      ? '自动取模板边点梯度中位数 × 0.72，压掉低对比度杂边。'
      : '手动阈值。阈值越高，只保留对比度更强的边缘。';
    if (auto) refreshAutoThreshold();
  }

  function readParams() {
    var anchor = [numberValue(dom.anchorX, state.anchor[0]), numberValue(dom.anchorY, state.anchor[1])];
    var edgeThreshold = dom.edgeAuto.checked
      ? Math.round(ML.autoEdgeThreshold(state.templateImg))
      : numberValue(dom.edgeValue, 200);
    return {
      anchor: anchor,
      edgeThreshold: edgeThreshold,
      minScale: numberValue(dom.minScale, 0.75),
      maxScale: numberValue(dom.maxScale, 1.4),
      scaleStep: numberValue(dom.scaleStep, 0.1),
      angleStep: numberValue(dom.angleStep, 12),
      minCoverage: numberValue(dom.minCoverage, 0.62),
      mirrorSearch: dom.mirrorSearch.checked
    };
  }

  function paramsKey(p) {
    return [p.anchor[0], p.anchor[1], p.edgeThreshold, p.minScale, p.maxScale,
      p.scaleStep, p.angleStep, p.minCoverage, p.mirrorSearch].join('|');
  }

  function updateDirty() {
    if (!state.result || !state.lastRunParams || !state.templateImg || !state.sceneImg) {
      dom.dirtyNote.hidden = true;
      return;
    }
    var current = paramsKey(readParams());
    dom.dirtyNote.hidden = current === state.lastRunParams;
  }

  /* ---------------------------------------------------------------- *
   * 运行定位
   * ---------------------------------------------------------------- */
  function setRunning(on) {
    state.running = on;
    dom.runBtn.disabled = on;
    dom.runBtn.textContent = on ? '定位中…' : '定位标记';
    dom.progress.hidden = !on;
    if (!on) {
      dom.progressBar.style.width = '0%';
      dom.progressPct.textContent = '0%';
    }
  }

  function progressHandler(p) {
    var pct = Math.round((p.pct || 0) * 100);
    dom.progressBar.style.width = pct + '%';
    dom.progressPct.textContent = pct + '%';
    var text = p.text || '';
    if (p.done != null && p.total) text += ' ' + p.done + '/' + p.total;
    dom.progressText.textContent = text;
  }

  function run() {
    if (state.running) return;
    if (!state.templateImg) { showMessage('先载入模板 PGM。', 'error'); return; }
    if (!state.sceneImg) { showMessage('先载入场景 PGM。', 'error'); return; }
    var params;
    try { params = readParams(); }
    catch (e) { showMessage(e.message, 'error'); return; }
    if (params.minScale > params.maxScale) {
      showMessage('最小尺度不能大于最大尺度。', 'error'); return;
    }
    showMessage('');
    setRunning(true);
    state.selected = -1;
    dom.selDetail.hidden = true;
    var t0 = performance.now();

    ML.locate(state.templateImg, state.sceneImg, params, {
      onProgress: progressHandler,
      yieldFn: function () {
        return new Promise(function (r) { setTimeout(r, 0); });
      }
    }).then(function (res) {
      setRunning(false);
      res.anchor = params.anchor.slice();
      res.params = params;
      state.result = res;
      state.lastRunParams = paramsKey(params);
      state.selected = res.poses.length ? 0 : -1;
      renderResults();
      renderStats(res);
      drawScene();
      dom.exportBtn.disabled = res.poses.length === 0;
      dom.exportPanel.hidden = true;
      state.dirty = false;
      updateDirty();
      if (!res.poses.length) {
        showMessage('没有姿态达到覆盖率阈值，可降低最低覆盖率或边缘强度后重试。');
      } else {
        showMessage('找到 ' + res.poses.length + ' 处标记，用时 ' + Math.round(performance.now() - t0) + ' ms。', 'ok');
      }
    }).catch(function (e) {
      setRunning(false);
      showMessage('定位失败：' + e.message, 'error');
    });
  }

  function renderStats(res) {
    var s = res.stats;
    dom.stats.innerHTML = '';
    var items = [
      ['模板边点', s.templateEdges],
      ['场景边点', s.sceneEdges],
      ['候选姿态', s.candidates],
      ['细化', s.refined],
      ['边缘阈值', Math.round(s.edgeThreshold)],
      ['耗时', s.elapsedMs + ' ms']
    ];
    for (var i = 0; i < items.length; i++) {
      var span = document.createElement('span');
      var b = document.createElement('b');
      b.textContent = items[i][1];
      span.appendChild(document.createTextNode(items[i][0] + ' '));
      span.appendChild(b);
      dom.stats.appendChild(span);
    }
  }

  /* ---------------------------------------------------------------- *
   * 结果列表
   * ---------------------------------------------------------------- */
  function fmtSigned(v, digits) {
    return (v > 0 ? '+' : '') + v.toFixed(digits);
  }

  function renderResults() {
    var list = dom.resultList;
    list.innerHTML = '';
    var res = state.result;
    if (!res || !res.poses.length) {
      dom.resultEmpty.hidden = false;
      dom.resultEmpty.querySelector('strong').textContent = res ? '没有符合条件的姿态' : '尚无结果';
      dom.resultEmpty.lastChild.textContent = res
        ? '试试降低最低覆盖率，或放宽尺度 / 角度范围。'
        : '载入模板与场景后点「定位标记」。结果按覆盖率降序、配对距离均值升序排列。';
      dom.resultCount.textContent = '—';
      dom.exportBtn.disabled = true;
      updateSelDetail();
      return;
    }
    dom.resultEmpty.hidden = true;
    dom.resultCount.textContent = res.poses.length + ' 处';

    var minCov = res.params ? res.params.minCoverage : 0;
    res.poses.forEach(function (p, idx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result';
      btn.setAttribute('aria-pressed', String(idx === state.selected));
      btn.dataset.index = String(idx);

      var top = document.createElement('div');
      top.className = 'result-top';
      var rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = '#' + p.rank;
      var coords = document.createElement('span');
      coords.className = 'coords';
      coords.innerHTML = p.x.toFixed(2) + '<span class="sep">,</span> ' + p.y.toFixed(2);

      var badge = document.createElement('span');
      badge.className = 'badge' + (p.mirror ? ' on' : '');
      badge.textContent = p.mirror ? '镜像' : '原向';

      top.appendChild(rank);
      top.appendChild(coords);
      top.appendChild(badge);

      var metrics = document.createElement('div');
      metrics.className = 'result-metrics';
      var cells = [
        ['角度', fmtSigned(p.angle, 1) + '°'],
        ['尺度', p.scale.toFixed(3) + '×'],
        ['覆盖率', (p.coverage * 100).toFixed(1) + '%'],
        ['均距', p.meanDistance.toFixed(2) + ' px']
      ];
      cells.forEach(function (c) {
        var d = document.createElement('div');
        var em = document.createElement('em');
        em.textContent = c[0];
        var b = document.createElement('b');
        b.textContent = c[1];
        d.appendChild(em); d.appendChild(b);
        metrics.appendChild(d);
      });

      var track = document.createElement('div');
      track.className = 'cov-track';
      var fill = document.createElement('div');
      fill.className = 'cov-fill';
      fill.style.width = clamp(p.coverage * 100, 0, 100) + '%';
      track.appendChild(fill);
      var mark = document.createElement('div');
      mark.className = 'cov-mark';
      mark.style.left = clamp(minCov * 100, 0, 100) + '%';
      track.appendChild(mark);

      btn.appendChild(top);
      btn.appendChild(metrics);
      btn.appendChild(track);
      btn.addEventListener('click', function () { selectResult(idx); });
      list.appendChild(btn);
    });
    updateSelDetail();
  }

  function selectResult(idx) {
    state.selected = idx;
    var buttons = dom.resultList.querySelectorAll('.result');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(i === idx));
    }
    drawScene();
    updateSelDetail();
    var active = dom.resultList.querySelector('.result[aria-pressed="true"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateSelDetail() {
    var res = state.result;
    if (!res || state.selected < 0 || !res.poses[state.selected]) {
      dom.selDetail.hidden = true;
      return;
    }
    var p = res.poses[state.selected];
    dom.selDetail.hidden = false;
    var matchedPts = p.matched;
    var missed = p.total - p.matched;
    dom.selDetail.innerHTML =
      '第 ' + p.rank + ' 项 · 覆盖 <b>' + (p.coverage * 100).toFixed(1) + '%</b>（' +
      p.matched + '/' + p.total + '）<br>' +
      '匹配 <span class="m-match">' + matchedPts + '</span> 点 · ' +
      '失配 <span class="m-miss">' + missed + '</span> 点 · ' +
      '均距 <b>' + p.meanDistance.toFixed(2) + ' px</b><br>' +
      '姿态 <b>(' + p.x.toFixed(2) + ', ' + p.y.toFixed(2) + ')</b> · ' +
      '旋转 <b>' + fmtSigned(p.angle, 1) + '°</b> · ' +
      '尺度 <b>' + p.scale.toFixed(3) + '×</b> · ' +
      (p.mirror ? '<b>镜像</b>' : '未镜像');
  }

  /* ---------------------------------------------------------------- *
   * 导出
   * ---------------------------------------------------------------- */
  function buildExport() {
    var res = state.result;
    if (!res) return null;
    return {
      format: 'occluded-mark-poses',
      version: 1,
      generatedAt: new Date().toISOString(),
      template: {
        name: state.templateName || null,
        width: state.templateImg ? state.templateImg.width : null,
        height: state.templateImg ? state.templateImg.height : null
      },
      scene: {
        name: state.sceneName || null,
        width: state.sceneImg ? state.sceneImg.width : null,
        height: state.sceneImg ? state.sceneImg.height : null
      },
      params: res.params ? {
        anchor: res.params.anchor,
        edgeThreshold: res.stats.edgeThreshold,
        minScale: res.params.minScale,
        maxScale: res.params.maxScale,
        scaleStep: res.params.scaleStep,
        angleStep: res.params.angleStep,
        minCoverage: res.params.minCoverage,
        mirrorSearch: res.params.mirrorSearch
      } : null,
      sort: 'coverage desc, meanDistance asc',
      stats: res.stats,
      poses: res.poses.map(function (p) {
        return {
          rank: p.rank,
          x: p.x,
          y: p.y,
          angle: p.angle,
          scale: p.scale,
          mirror: p.mirror,
          coverage: p.coverage,
          meanDistance: p.meanDistance,
          matched: p.matched,
          total: p.total
        };
      })
    };
  }

  function exportJson() {
    var data = buildExport();
    if (!data) return;
    var text = JSON.stringify(data, null, 2);
    dom.exportCode.textContent = text;
    dom.exportPanel.hidden = false;
    dom.copyHint.hidden = true;
    dom.exportPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function copyJson() {
    var text = dom.exportCode.textContent;
    if (!text) return;
    function fallback() {
      try {
        var range = document.createRange();
        range.selectNodeContents(dom.exportCode);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        dom.copyHint.textContent = '已选中 JSON，按 Ctrl/Cmd+C 复制';
        dom.copyHint.hidden = false;
      } catch (e) {
        dom.copyHint.textContent = '复制失败，请手动选择文本';
        dom.copyHint.hidden = false;
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        dom.copyHint.textContent = '已复制到剪贴板';
        dom.copyHint.hidden = false;
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  /* ---------------------------------------------------------------- *
   * 样例
   * ---------------------------------------------------------------- */
  function loadSample() {
    var sample = window.SAMPLE_DATA;
    if (!sample) { showMessage('样例数据未随页面提供。', 'error'); return; }
    try {
      var tpl = ML.parsePGM(base64ToBytes(sample.mark));
      var scene = ML.parsePGM(base64ToBytes(sample.scene));
    } catch (e) {
      showMessage('样例解析失败：' + e.message, 'error');
      return;
    }
    var q = sample.search || {};
    state.lastRunParams = null;
    acceptTemplate(tpl, 'mark.pgm');
    acceptScene(scene, 'scene.pgm');
    state.anchor = [Number(q.anchor ? q.anchor[0] : 20), Number(q.anchor ? q.anchor[1] : 20)];
    syncAnchorInputs();
    drawTemplate();
    if (q.minScale != null) dom.minScale.value = q.minScale;
    if (q.maxScale != null) dom.maxScale.value = q.maxScale;
    if (q.scaleStep != null) dom.scaleStep.value = q.scaleStep;
    if (q.angleStep != null) dom.angleStep.value = q.angleStep;
    if (q.minCoverage != null) dom.minCoverage.value = q.minCoverage;
    dom.edgeAuto.checked = true;
    updateEdgeControlState();
    updateSliderOutputs();
    state.dirty = true;
    run();
  }

  /* ---------------------------------------------------------------- *
   * 绑定
   * ---------------------------------------------------------------- */
  function bindControls() {
    wireDrop(dom.tplDrop, dom.tplFile, 'template');
    wireDrop(dom.sceneDrop, dom.sceneFile, 'scene');

    dom.sampleBtn.addEventListener('click', loadSample);
    dom.clearBtn.addEventListener('click', function () {
      state.result = null;
      state.selected = -1;
      state.lastRunParams = null;
      state.dirty = false;
      dom.exportPanel.hidden = true;
      dom.exportBtn.disabled = true;
      renderResults();
      renderStatsEmpty();
      drawScene();
      showMessage('');
      updateDirty();
    });

    dom.anchorX.addEventListener('input', function () {
      if (!state.templateImg) return;
      state.anchor[0] = clamp(numberValue(dom.anchorX, state.anchor[0]), 0, state.templateImg.width - 1);
      drawTemplate();
      state.dirty = true;
      updateDirty();
    });
    dom.anchorY.addEventListener('input', function () {
      if (!state.templateImg) return;
      state.anchor[1] = clamp(numberValue(dom.anchorY, state.anchor[1]), 0, state.templateImg.height - 1);
      drawTemplate();
      state.dirty = true;
      updateDirty();
    });

    dom.edgeAuto.addEventListener('change', function () {
      updateEdgeControlState();
      state.dirty = true;
      updateDirty();
    });
    dom.edgeValue.addEventListener('input', function () {
      state.dirty = true;
      updateDirty();
    });

    [dom.minScale, dom.maxScale, dom.scaleStep, dom.angleStep, dom.minCoverage].forEach(function (input) {
      input.addEventListener('input', function () {
        // 保持 min ≤ max
        if (input === dom.minScale && numberValue(dom.minScale, 0.75) > numberValue(dom.maxScale, 1.4)) {
          dom.maxScale.value = dom.minScale.value;
        }
        if (input === dom.maxScale && numberValue(dom.maxScale, 1.4) < numberValue(dom.minScale, 0.75)) {
          dom.minScale.value = dom.maxScale.value;
        }
        updateSliderOutputs();
        state.dirty = true;
        updateDirty();
      });
    });
    dom.mirrorSearch.addEventListener('change', function () {
      state.dirty = true;
      updateDirty();
    });

    dom.runBtn.addEventListener('click', run);
    dom.exportBtn.addEventListener('click', exportJson);
    dom.copyBtn.addEventListener('click', copyJson);
    dom.closeExport.addEventListener('click', function () { dom.exportPanel.hidden = true; });

    bindTemplatePointer();
    bindScenePointer();

    window.addEventListener('resize', function () {
      // 画布 CSS 宽度自适应，重绘以刷新圆点尺寸
      if (state.templateImg) drawTemplate();
      drawScene();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', function () { redrawAll(); });
    }
  }

  function redrawAll() {
    if (state.templateImg) drawTemplate();
    drawScene();
  }

  function renderStatsEmpty() {
    dom.stats.innerHTML = '<span>等待载入图像</span>';
  }

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */
  function init() {
    bindControls();
    updateSliderOutputs();
    updateEdgeControlState();
    renderResults();
    drawTemplate();
    drawScene();
    dom.engineText.textContent = '轮廓引擎就绪';
    dom.sampleChip.textContent = '内置样例';
    if (window.SAMPLE_DATA) {
      // 首屏直接进入可操作状态：载入样例并跑一次
      setTimeout(loadSample, 60);
    } else {
      showMessage('载入模板与场景 PGM 后开始定位。');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
