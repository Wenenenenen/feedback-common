/* 网页交互层：导入、笔画采集、撤销重做、双画布同步、拾取、导出 */
(function () {
  'use strict';
  var C = window.SeamBrushCore;

  var state = {
    scene: null, model: null, texture: null,
    history: [], redo: [],
    drawing: false, currentPts: [], strokeTruncated: false,
    previewFace: null,
    viewScale: 2, texScale: 1
  };

  var $ = function (id) { return document.getElementById(id); };
  var viewCanvas = $('viewCanvas'), texCanvas = $('texCanvas');
  var vctx = viewCanvas.getContext('2d'), tctx = texCanvas.getContext('2d');
  var statusEl = $('status'), errorEl = $('error');

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    errorEl.style.display = isError ? 'block' : 'none';
    errorEl.textContent = isError ? msg : '';
  }

  function getBrush() {
    return {
      rgb: [+$('brushR').value, +$('brushG').value, +$('brushB').value],
      a: +$('brushA').value,
      diameter: +$('brushD').value
    };
  }

  /* ---------------- 导入 ---------------- */

  function loadScene(scene) {
    var err = C.validateScene(scene);
    if (err) {
      setStatus('导入失败：' + err + '（画布与笔画历史保持不变）', true);
      return;
    }
    // 整份校验通过后才切换
    state.scene = scene;
    state.model = C.createModel(scene);
    state.texture = C.makeBaseTexture(scene);
    state.history = [];
    state.redo = [];
    state.drawing = false;
    state.currentPts = [];
    state.strokeTruncated = false;
    viewCanvas.width = scene.view[0];
    viewCanvas.height = scene.view[1];
    texCanvas.width = scene.texture[0];
    texCanvas.height = scene.texture[1];
    fitScales();
    refreshPreview();
    refreshTexture();
    updateHistoryButtons();
    setStatus('已加载：' + scene.vertices.length + ' 顶点 / ' + scene.faces.length +
      ' 面，纹理 ' + scene.texture[0] + '×' + scene.texture[1] +
      '，归属纹素 ' + countOwned() + '/' + state.model.nTex);
  }

  function countOwned() {
    var n = 0, o = state.model.owner;
    for (var i = 0; i < o.length; i++) if (o[i] >= 0) n++;
    return n;
  }

  $('fileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var scene;
      try {
        scene = JSON.parse(reader.result);
      } catch (ex) {
        setStatus('导入失败：JSON 解析错误 — ' + ex.message + '（画布与笔画历史保持不变）', true);
        return;
      }
      loadScene(scene);
    };
    reader.onerror = function () { setStatus('导入失败：文件读取错误（画布与笔画历史保持不变）', true); };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ---------------- 画布缩放 ---------------- */

  function fitScales() {
    var s = state.scene;
    state.viewScale = Math.max(1, Math.floor(Math.min(480 / s.view[0], 360 / s.view[1])));
    state.texScale = Math.max(1, Math.floor(Math.min(480 / s.texture[0], 480 / s.texture[1])));
    viewCanvas.style.width = (s.view[0] * state.viewScale) + 'px';
    viewCanvas.style.height = (s.view[1] * state.viewScale) + 'px';
    texCanvas.style.width = (s.texture[0] * state.texScale) + 'px';
    texCanvas.style.height = (s.texture[1] * state.texScale) + 'px';
  }

  /* ---------------- 渲染同步 ---------------- */

  function refreshPreview() {
    var r = C.renderPreview(state.model, state.texture);
    state.previewFace = r.faceId;
    var img = new ImageData(r.rgba, state.model.viewW, state.model.viewH);
    vctx.putImageData(img, 0, 0);
  }

  function refreshTexture() {
    var data = C.textureToImageData(state.model, state.texture);
    var img = new ImageData(data, state.model.texW, state.model.texH);
    tctx.putImageData(img, 0, 0);
  }

  /* ---------------- 笔画采集 ---------------- */

  function eventToFixed(ev, canvas) {
    var rect = canvas.getBoundingClientRect();
    var px = (ev.clientX - rect.left) / state.viewScale; // 屏幕像素（浮点）
    var py = (ev.clientY - rect.top) / state.viewScale;
    // 换算到 256 分之一定点，半格取较大值
    return [C.halfUp(px * 256), C.halfUp(py * 256)];
  }

  viewCanvas.addEventListener('pointerdown', function (ev) {
    if (!state.model || ev.button !== 0) return;
    state.drawing = true;
    state.currentPts = [eventToFixed(ev, viewCanvas)];
    viewCanvas.setPointerCapture(ev.pointerId);
  });

  viewCanvas.addEventListener('pointermove', function (ev) {
    if (!state.model) return;
    if (state.drawing) {
      var p = eventToFixed(ev, viewCanvas);
      var last = state.currentPts[state.currentPts.length - 1];
      if (p[0] !== last[0] || p[1] !== last[1]) {
        if (state.currentPts.length < 256) {
          state.currentPts.push(p);
        } else {
          state.strokeTruncated = true;
        }
      }
    } else {
      hoverPick(ev);
    }
  });

  viewCanvas.addEventListener('pointerup', function (ev) {
    if (!state.drawing) return;
    state.drawing = false;
    finishStroke();
  });

  viewCanvas.addEventListener('pointercancel', function () {
    state.drawing = false;
    state.currentPts = [];
  });

  function finishStroke() {
    if (!state.currentPts.length) return;
    var b = getBrush();
    var stroke = { points: state.currentPts, diameter: b.diameter, rgb: b.rgb, a: b.a };
    var truncated = state.strokeTruncated;
    state.currentPts = [];
    state.strokeTruncated = false;
    var verr = C.validateStroke(stroke);
    if (verr) { setStatus('笔画无效：' + verr, true); return; }
    var patch = C.paintStroke(state.model, state.texture, stroke);
    if (patch.count === 0) {
      setStatus('该笔未覆盖任何可上色纹素（可能全被遮挡或落在画面外）');
      return;
    }
    state.history.push(patch);
    state.redo = []; // 从撤销位置新画一笔，重做记录清空
    refreshPreview();
    refreshTexture();
    updateHistoryButtons();
    setStatus('已上色 ' + patch.count + ' 个纹素，历史 ' + state.history.length + ' 笔' +
      (truncated ? '（笔画达到 256 点上限，后续点已截断）' : ''));
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  function applyPatchReverse(patch) {
    for (var k = 0; k < patch.indices.length; k++) {
      var o = patch.indices[k] * 3;
      state.texture[o] = patch.old[k * 3];
      state.texture[o + 1] = patch.old[k * 3 + 1];
      state.texture[o + 2] = patch.old[k * 3 + 2];
    }
  }

  function applyPatchForward(patch) {
    // 直接恢复该笔应用后的纹素快照，不依赖重新混色
    for (var k = 0; k < patch.indices.length; k++) {
      var o = patch.indices[k] * 3;
      state.texture[o] = patch.neu[k * 3];
      state.texture[o + 1] = patch.neu[k * 3 + 1];
      state.texture[o + 2] = patch.neu[k * 3 + 2];
    }
  }

  $('undoBtn').addEventListener('click', function () {
    if (!state.history.length) return;
    var patch = state.history.pop();
    applyPatchReverse(patch);
    state.redo.push(patch);
    refreshPreview();
    refreshTexture();
    updateHistoryButtons();
    setStatus('撤销一笔，剩余历史 ' + state.history.length + ' 笔');
  });

  $('redoBtn').addEventListener('click', function () {
    if (!state.redo.length) return;
    var patch = state.redo.pop();
    applyPatchForward(patch);
    state.history.push(patch);
    refreshPreview();
    refreshTexture();
    updateHistoryButtons();
    setStatus('重做一笔，历史 ' + state.history.length + ' 笔');
  });

  function updateHistoryButtons() {
    $('undoBtn').disabled = !state.history.length;
    $('redoBtn').disabled = !state.redo.length;
  }

  /* ---------------- 拾取 ---------------- */

  function hoverPick(ev) {
    if (!state.model) return;
    var rect = viewCanvas.getBoundingClientRect();
    var px = Math.floor((ev.clientX - rect.left) / state.viewScale);
    var py = Math.floor((ev.clientY - rect.top) / state.viewScale);
    if (px < 0 || py < 0 || px >= state.model.viewW || py >= state.model.viewH) return;
    var pi = py * state.model.viewW + px;
    var face = state.previewFace ? state.previewFace[pi] : -1;
    var lines = ['预览像素 (' + px + ',' + py + ')'];
    if (face < 0) {
      lines.push('覆盖面：无（背景）');
    } else {
      lines.push('覆盖面：' + face);
    }
    $('info').innerHTML = lines.join('<br>');
  }

  // 点纹理画布：看纹素归属面、投影坐标、最前深度
  texCanvas.addEventListener('click', function (ev) {
    if (!state.model) return;
    var rect = texCanvas.getBoundingClientRect();
    var tx = Math.floor((ev.clientX - rect.left) / state.texScale);
    var ty = Math.floor((ev.clientY - rect.top) / state.texScale);
    var info = C.pickTexel(state.model, tx, ty);
    if (!info) return;
    var lines = ['纹素 (' + tx + ',' + ty + ')', '归属面：' + (info.owner < 0 ? '无（不可上色）' : info.owner)];
    if (info.owner >= 0) {
      lines.push('UV 重心：(' + info.uvWeight.map(function (w) { return w.toFixed(5); }).join(', ') + ')');
      lines.push('投影定点：(' + info.projX.toFixed(2) + ', ' + info.projY.toFixed(2) + ')');
      lines.push('投影像素：(' + (info.projX / 256).toFixed(3) + ', ' + (info.projY / 256).toFixed(3) + ')');
      if (info.ownerDegenerate) lines.push('归属面投影面积为零：不可上色');
      if (!info.inView) {
        lines.push('最前深度：无（投影点出预览半开范围）');
      } else if (info.front) {
        lines.push('最前深度：' + info.front.depth.toFixed(4) + '（面 ' + info.front.face + '）');
      } else {
        lines.push('最前深度：无（该点无三角形覆盖）');
      }
    }
    $('info').innerHTML = lines.join('<br>');
  });

  /* ---------------- 导出 PNG ---------------- */

  $('exportBtn').addEventListener('click', function () {
    if (!state.model) { setStatus('请先导入场景', true); return; }
    var png = C.encodePng(state.texture, state.model.texW, state.model.texH);
    var blob = new Blob([png], { type: 'image/png' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'painted-texture.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('已导出 ' + state.model.texW + '×' + state.model.texH + ' RGB PNG');
  });

  /* ---------------- 键盘快捷键 ---------------- */

  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z' && !ev.shiftKey) {
      ev.preventDefault(); $('undoBtn').click();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || (ev.key === 'z' && ev.shiftKey))) {
      ev.preventDefault(); $('redoBtn').click();
    }
  });

  // 颜色预览块
  function syncSwatch() {
    var b = getBrush();
    $('swatch').style.background = 'rgb(' + b.rgb.join(',') + ')';
  }
  ['brushR', 'brushG', 'brushB'].forEach(function (id) {
    $(id).addEventListener('input', syncSwatch);
  });
  syncSwatch();
  updateHistoryButtons();
})();
