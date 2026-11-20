/* app.js — 主控：状态、UI 绑定、Worker 渲染、像素检视、导出 */
'use strict';
(function () {
  var METHODS = ['nearest', 'bilinear', 'elliptic'];
  var MAX_DIM = 256;

  var state = {
    tex: null, texImageData: null, texName: '',
    params: null, // {H, outW, outH, address, aniso, maxRadius}
    buffers: null,
    stats: null,
    renderToken: 0,
    selected: null,
    activeMethod: 'elliptic',
    worker: null,
    workerReady: false,
    fullJson: false
  };

  var PRESETS = [
    { name: 'case-0 · repeat · A=8', case: 0 },
    { name: 'case-1 · mirror · A=4', case: 1 },
    { name: 'case-2 · clamp · A=16', case: 2 },
    { name: 'case-3 · 缩小映射（含无效位置）', case: 3 }
  ];
  var CASE_FILES = [
    { texture: 'texture.png', width: 64, height: 48, H: [3, 1, -40, 0.4, 0.7, -4, 0.002, 0.001, 1], address: 'repeat', anisotropy: 8 },
    { texture: 'texture.png', width: 64, height: 48, H: [3, 1, -40, 0.4, 0.7, -4, 0.002, 0.001, 1], address: 'mirror', anisotropy: 4 },
    { texture: 'texture.png', width: 64, height: 48, H: [3, 1, -40, 0.4, 0.7, -4, 0.002, 0.001, 1], address: 'clamp', anisotropy: 16 },
    { texture: 'texture.png', width: 64, height: 48, H: [0.01, 0, 0, 0, 0.01, 0, -0.03, 0, 1], address: 'repeat', anisotropy: 8 }
  ];

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['fileInput', 'dropHint', 'texThumb', 'texInfo', 'presetSel', 'outW', 'outH', 'hText', 'addrSel',
   'anisoInput', 'radiusInput', 'radiusWarn', 'radiusWarnVal', 'radiusWarnDetail', 'renderBtn',
   'resetBtn', 'dlPngBtn', 'dlJsonBtn', 'dlFallback', 'dlText', 'dlImg', 'chipMode', 'chipAniso',
   'chipInvalid', 'chipOverflow', 'progBar', 'statusText', 'inspCoord', 'inspInvalid', 'inspContent',
   'themeBtn', 'canvasWrap', 'fullJsonChk'].forEach(function (id) { els[id] = $(id); });
  var canvases = {
    nearest: { cv: $('cvNearest'), meta: $('metaNearest') },
    bilinear: { cv: $('cvBilinear'), meta: $('metaBilinear') },
    elliptic: { cv: $('cvElliptic'), meta: $('metaElliptic') }
  };

  /* ---------------- init worker ---------------- */
  function initWorker() {
    try {
      var blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      var workerUrl = URL.createObjectURL(blob);
      state.worker = new Worker(workerUrl);
      state.workerReady = true;
      state.worker.onmessage = onWorkerMessage;
      state.worker.onerror = function () { state.workerReady = false; };
    } catch (e) { state.workerReady = false; }
  }

  function onWorkerMessage(ev) {
    var msg = ev.data;
    if (msg.type === 'progress') {
      els.progBar.style.width = Math.round(100 * msg.rows / msg.total) + '%';
      els.statusText.textContent = '渲染中 ' + msg.rows + ' / ' + msg.total + ' 行';
    } else if (msg.type === 'done') {
      var token = state.renderToken;
      // structured clone 后显式重建 Uint8ClampedArray
      state.buffers = {};
      METHODS.forEach(function (m) {
        var raw = msg.buffers[m];
        state.buffers[m] = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw.buffer || raw);
      });
      state.stats = msg.stats;
      presentResults(token);
    } else if (msg.type === 'error') {
      els.statusText.textContent = '渲染失败：' + msg.message;
      setProgress(0);
    }
  }

  function setProgress(p) { els.progBar.style.width = p + '%'; }

  /* ---------------- texture loading ---------------- */
  function imageDataFromImage(img) {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function loadTextureFromSrc(src, name) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        if (img.naturalWidth > MAX_DIM || img.naturalHeight > MAX_DIM) {
          reject(new Error('纹理尺寸 ' + img.naturalWidth + '×' + img.naturalHeight + ' 超过 256×256 限制'));
          return;
        }
        var id = imageDataFromImage(img);
        state.texImageData = id;
        state.tex = Sampler.makeTexture(id);
        window.__TEST_TEX__ = state.tex; // 供端到端测试访问
        state.texName = name;
        els.texThumb.src = src;
        els.texInfo.textContent = name + ' · ' + id.width + '×' + id.height + ' · RGBA8 · 已转线性';
        resolve();
      };
      img.onerror = function () { reject(new Error('PNG 解码失败')); };
      img.src = src;
    });
  }

  function loadFile(file) {
    if (!file) return;
    if (!/\.png$/i.test(file.name)) { flashStatus('仅支持 PNG 文件'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      loadTextureFromSrc(reader.result, file.name).catch(function (e) {
        els.texInfo.textContent = e.message; flashStatus(e.message);
      });
    };
    reader.readAsDataURL(file);
  }

  /* ---------------- params / presets ---------------- */
  function readParams() {
    var nums = els.hText.value.split(/[\s,;]+/).filter(Boolean).map(Number);
    var errs = [];
    if (nums.length !== 9 || nums.some(isNaN)) errs.push('H 需要 9 个数值');
    var W = parseInt(els.outW.value, 10), Hh = parseInt(els.outH.value, 10);
    if (!(W >= 1 && W <= MAX_DIM)) errs.push('输出宽需在 1–256');
    if (!(Hh >= 1 && Hh <= MAX_DIM)) errs.push('输出高需在 1–256');
    var aniso = Number(els.anisoInput.value);
    if (!(aniso >= 1)) errs.push('各向异性上限 ≥ 1');
    var maxRadius = Number(els.radiusInput.value);
    if (!(maxRadius >= 1 && maxRadius <= 32)) errs.push('最大半径需在 1–32');
    if (errs.length) { flashStatus(errs.join('；')); return null; }
    return { H: nums, outW: W, outH: Hh, address: els.addrSel.value, aniso: aniso, maxRadius: maxRadius };
  }

  function applyPreset(idx) {
    var cs = CASE_FILES[idx];
    els.outW.value = cs.width; els.outH.value = cs.height;
    els.hText.value = cs.H.join(', ');
    els.addrSel.value = cs.address;
    els.anisoInput.value = cs.anisotropy;
    els.radiusInput.value = 32;
  }

  function currentPresetIndex() { return parseInt(els.presetSel.value, 10); }

  /* ---------------- render ---------------- */
  function render() {
    if (!state.tex) { flashStatus('请先加载纹理'); return; }
    var p = readParams();
    if (!p) return;
    state.params = p;
    state.selected = null;
    state.renderToken++;
    var token = state.renderToken;
    els.renderBtn.disabled = true;
    els.statusText.textContent = '开始渲染…';
    setProgress(2);
    hide(els.radiusWarn);

    var msg = {
      type: 'render',
      params: {
        texW: state.tex.w, texH: state.tex.h, texLin: state.tex.lin,
        H: p.H, outW: p.outW, outH: p.outH, address: p.address,
        aniso: p.aniso, maxRadius: p.maxRadius, methods: METHODS
      }
    };
    if (state.workerReady) {
      state.worker.postMessage(msg);
    } else {
      renderOnMainThread(msg.params, token);
    }
  }

  function renderOnMainThread(p, token) {
    var tex = { w: p.texW, h: p.texH, lin: p.texLin };
    var res = Sampler.renderAll({
      tex: tex, H: p.H, outW: p.outW, outH: p.outH, address: p.address,
      aniso: p.aniso, maxRadius: p.maxRadius, methods: p.methods
    }, function (rows, total) {
      setProgress(Math.round(100 * rows / total));
      els.statusText.textContent = '渲染中（主线程）' + rows + ' / ' + total + ' 行';
    });
    state.buffers = res.buffers;
    state.stats = res.stats;
    presentResults(token);
  }

  function presentResults(token) {
    if (token !== state.renderToken) return; // 已有更新的渲染请求
    var st = state.stats, p = state.params;
    METHODS.forEach(function (m) {
      var entry = canvases[m];
      var cv = entry.cv;
      cv.width = st.width; cv.height = st.height;
      cv.style.setProperty('--ar', (st.width / st.height).toFixed(4));
      var ctx = cv.getContext('2d');
      var img = new ImageData(new Uint8ClampedArray(state.buffers[m]), st.width, st.height);
      ctx.putImageData(img, 0, 0);
      drawMarkerLayer(ctx, st);
      entry.meta.textContent = st.width + '×' + st.height + ' · ' +
        (m === 'elliptic' ? '平均 ' + st.avgContrib.toFixed(1) + ' 纹素/像素 · ' : '') +
        Math.round(st.elapsedMs) + ' ms';
    });

    els.chipMode.textContent = p.address;
    els.chipAniso.textContent = 'A=' + p.aniso + ' · 实测最长轴 ' + st.maxObservedRadius.toFixed(2);
    els.chipInvalid.textContent = '无效 ' + st.invalidPixels.length;
    els.chipInvalid.className = 'chip' + (st.invalidPixels.length ? ' bad' : ' ok');
    if (st.overflowPixels.length) {
      els.chipOverflow.style.display = 'inline-flex';
      els.chipOverflow.className = 'chip bad';
      els.chipOverflow.textContent = '超半径 ' + st.overflowPixels.length;
      els.radiusWarn.classList.add('show');
      els.radiusWarnVal.textContent = p.maxRadius;
      var sample = st.overflowPixels.slice(0, 6).map(function (q) { return '(' + q[0] + ',' + q[1] + ')'; }).join(' ');
      els.radiusWarnDetail.textContent = sample + (st.overflowPixels.length > 6 ? ' 等 ' + st.overflowPixels.length + ' 个像素' : '');
    } else {
      els.chipOverflow.style.display = 'none';
      els.radiusWarn.classList.remove('show');
    }
    setProgress(100);
    els.statusText.textContent = '完成 · 最长轴半径 ' + st.maxObservedRadius.toFixed(2) +
      ' 纹素（上限 ' + p.maxRadius + '）· 无效位置 ' + st.invalidPixels.length + ' 个';
    els.renderBtn.disabled = false;
    resetInspector();  }

  // 无效/超限像素的叠加标记（仅显示层；导出 PNG 单独按导出规则编码）
  function drawMarkerLayer(ctx, st) {
    ctx.save();
    st.invalidPixels.forEach(function (q) {
      ctx.fillStyle = 'rgba(120,120,120,.55)';
      ctx.fillRect(q[0], q[1], 1, 1);
      ctx.strokeStyle = 'rgba(220,80,80,.9)';
      ctx.strokeRect(q[0] + .15, q[1] + .15, .7, .7);
    });
    st.overflowPixels.forEach(function (q) {
      ctx.fillStyle = 'rgba(180,83,9,.5)';
      ctx.fillRect(q[0], q[1], 1, 1);
    });
    ctx.restore();
  }

  function flashStatus(t) { els.statusText.textContent = t; }
  function hide(el) { el.classList.remove('show'); }

  /* ---------------- pixel inspector ---------------- */
  function resetInspector() {
    state.selected = null;
    els.inspCoord.textContent = '未选择';
    els.inspInvalid.classList.remove('show');
    els.inspContent.innerHTML = '<div class="insp-empty">在中间任一输出图上点选一个像素。</div>';
  }

  function selectPixel(x, y, method) {
    if (!state.params || !state.tex) return;
    var p = state.params;
    if (x < 0 || y < 0 || x >= p.outW || y >= p.outH) return;
    state.activeMethod = method;
    Array.prototype.forEach.call(els.canvasWrap.querySelectorAll('.tile'), function (tile) {
      tile.classList.toggle('active', tile.getAttribute('data-method') === method);
    });
    var rec = Sampler.computePixel(state.tex, p.H, x, y, p.address, p.aniso, p.maxRadius, METHODS);
    state.selected = { x: x, y: y, method: method, rec: rec };
    renderInspector(rec);
  }

  function fmt(v, d) {
    if (v === null || v === undefined) return '—';
    d = d === undefined ? 4 : d;
    if (!isFinite(v)) return String(v);
    return Number(v).toFixed(d);
  }
  function linToCss(c) {
    return 'rgb(' + Sampler.linearToSRGBByte(c.r) + ',' + Sampler.linearToSRGBByte(c.g) + ',' + Sampler.linearToSRGBByte(c.b) + ')';
  }

  function renderInspector(rec) {
    els.inspCoord.textContent = '(' + rec.x + ', ' + rec.y + ')';
    var host = els.inspContent;
    if (rec.invalid) {
      els.inspInvalid.classList.add('show');
      host.innerHTML =
        kvHtml([
          ['输出边界坐标', '(' + rec.X.toFixed(1) + ', ' + rec.Y.toFixed(1) + ')'],
          ['投影分母 w', fmt(rec.w, 6)],
          ['判定', 'w ≤ 1e-6 → 透明输出']
        ]);
      return;
    }
    els.inspInvalid.classList.remove('show');
    var fp = rec.fp;
    var parts = [];
    parts.push('<div class="legend">' +
      '<span><i style="background:var(--accent)"></i>长轴 r=' + fp.rMajor.toFixed(2) + '</span>' +
      '<span><i style="background:var(--blue)"></i>短轴 r=' + fp.rMinor.toFixed(2) + '</span>' +
      '<span><i style="background:var(--green)"></i>落点 (' + rec.s.toFixed(2) + ', ' + rec.t.toFixed(2) + ')</span>' +
      '</div>');
    parts.push(buildSvg(rec));
    parts.push('<dl class="kv">' +
      kvRow('落点 s, t（边界坐标）', fmt(rec.s) + ', ' + fmt(rec.t)) +
      kvRow('投影分母 w', fmt(rec.w, 6)) +
      kvRow('J = ∂(s,t)/∂(x,y)', '[' + [rec.J.dsdx, rec.J.dsdy, rec.J.dtdx, rec.J.dtdy].map(function (v) { return fmt(v, 3); }).join(', ') + ']') +
      kvRow('λmax / λmin', fmt(fp.lamMax) + ' / ' + fmt(fp.lamMin)) +
      kvRow('限制后 λmin′', fmt(fp.lamMinLimited)) +
      kvRow('轴比 原始 / 限制后', fmt(fp.ratioRaw, 2) + ' / ' + fmt(fp.ratioLimited, 2)) +
      kvRow('长轴方向角', (fp.angle * 180 / Math.PI).toFixed(1) + '°') +
      kvRow('半径（纹素）', fp.rMajor.toFixed(3) + ' × ' + fp.rMinor.toFixed(3)) +
      kvRow('是否超 ' + state.params.maxRadius + ' 纹素', rec.overflow ? '是 — 不采样' : '否') +
      '</dl>');

    METHODS.forEach(function (m) {
      var c = rec.colors[m];
      var label = m === 'nearest' ? '最近邻' : (m === 'bilinear' ? '双线性' : '椭圆足迹');
      parts.push('<div style="display:flex;align-items:center;gap:8px;font-size:12px">' +
        '<span class="swatch" style="background:' + linToCss(c) + ';width:16px;height:16px"></span>' +
        '<strong>' + label + '</strong>' +
        '<span class="hint" style="margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--fg-dim)">' +
        'L ' + [c.r, c.g, c.b].map(function (v) { return fmt(v, 3); }).join(' ') + ' A ' + fmt(c.a, 3) + '</span></div>');
    });

    if (rec.elliptic) {
      var e = rec.elliptic;
      parts.push('<div class="hint">参与纹素 ' + e.contribs.length + ' 个 · 权重和 ' + fmt(e.wsum, 5) +
        '（q&lt;1，w=e⁻²ᵠ−e⁻²，归一化）</div>');
      parts.push('<div class="table-scroll"><table class="contribs"><thead><tr>' +
        '<th>纹素(i,j)</th><th>实际地址</th><th>q</th><th>权重</th><th>色</th></tr></thead><tbody>');
      var sorted = e.contribs.slice().sort(function (a, b) { return b.w - a.w; });
      sorted.forEach(function (z) {
        parts.push('<tr><td>' + z.i + ',' + z.j + '</td><td>' + z.ii + ',' + z.jj + '</td>' +
          '<td>' + fmt(z.q, 3) + '</td><td>' + fmt(z.w / e.wsum, 4) + '</td>' +
          '<td><span class="swatch" style="background:rgb(' +
          [z.rgba[0], z.rgba[1], z.rgba[2]].map(Sampler.linearToSRGBByte).join(',') + ')"></span></td></tr>');
      });
      parts.push('</tbody></table></div>');
    }
    host.innerHTML = parts.join('');
  }

  function kvRow(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }
  function kvHtml(rows) { return '<dl class="kv">' + rows.map(function (r) { return kvRow(r[0], r[1]); }).join('') + '</dl>'; }

  // 检视器 SVG：纹素网格 + 椭圆 + 两主轴 + 落点 + 参与纹素高亮
  function buildSvg(rec) {
    var fp = rec.fp, s = rec.s, t = rec.t;
    var R = fp.rMajor + 1.6;
    var x0 = Math.floor(s - R), x1 = Math.ceil(s + R);
    var y0 = Math.floor(t - R), y1 = Math.ceil(t + R);
    var Wc = x1 - x0, Hc = y1 - y0;
    var cell = Math.max(14, Math.min(34, 300 / Math.max(Wc, Hc)));
    var pw = Wc * cell, ph = Hc * cell;
    var toX = function (sv) { return (sv - x0) * cell; };
    var toY = function (tv) { return (tv - y0) * cell; };
    var svg = ['<svg class="insp-svg" viewBox="0 0 ' + pw + ' ' + ph + '" preserveAspectRatio="xMidYMid meet">'];

    // 纹素底色（按寻址后的实际纹素）
    for (var j = y0; j < y1; j++) {
      for (var i = x0; i < x1; i++) {
        var c = Sampler.fetchLinear(state.tex, i, j, state.params.address);
        var col = 'rgb(' + Sampler.linearToSRGBByte(c.r) + ',' + Sampler.linearToSRGBByte(c.g) + ',' + Sampler.linearToSRGBByte(c.b) + ')';
        svg.push('<rect x="' + toX(i) + '" y="' + toY(j) + '" width="' + cell + '" height="' + cell + '" fill="' + col + '" fill-opacity="0.85"/>');
      }
    }
    // 网格线
    svg.push('<g stroke="var(--line)" stroke-width="1">');
    for (var gx = x0; gx <= x1; gx++) svg.push('<line x1="' + toX(gx) + '" y1="0" x2="' + toX(gx) + '" y2="' + ph + '"/>');
    for (var gy = y0; gy <= y1; gy++) svg.push('<line x1="0" y1="' + toY(gy) + '" x2="' + pw + '" y2="' + toY(gy) + '"/>');
    svg.push('</g>');

    // 参与纹素描边（按权重定透明度）
    if (rec.elliptic) {
      rec.elliptic.contribs.forEach(function (z) {
        var op = Math.max(0.15, z.w / rec.elliptic.wsum * 1.6);
        svg.push('<rect x="' + (toX(z.i) + 1) + '" y="' + (toY(z.j) + 1) + '" width="' + (cell - 2) + '" height="' + (cell - 2) +
          '" fill="none" stroke="var(--green)" stroke-width="2" opacity="' + Math.min(1, op).toFixed(2) + '"/>');
      });
    }

    // 椭圆（rMajor × rMinor，绕落点旋转 angle）
    var cx = toX(s), cy = toY(t);
    var ang = fp.angle;
    svg.push('<g transform="rotate(' + (ang * 180 / Math.PI).toFixed(2) + ' ' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ')">');
    svg.push('<ellipse cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" rx="' + (fp.rMajor * cell).toFixed(2) +
      '" ry="' + (fp.rMinor * cell).toFixed(2) + '" fill="none" stroke="var(--accent)" stroke-width="2"/>');
    svg.push('<line x1="' + (cx - fp.rMajor * cell).toFixed(2) + '" y1="' + cy + '" x2="' + (cx + fp.rMajor * cell).toFixed(2) +
      '" y2="' + cy + '" stroke="var(--accent)" stroke-width="1.6"/>');
    svg.push('<line x1="' + cx + '" y1="' + (cy - fp.rMinor * cell).toFixed(2) + '" x2="' + cx +
      '" y2="' + (cy + fp.rMinor * cell).toFixed(2) + '" stroke="var(--blue)" stroke-width="1.6"/>');
    svg.push('</g>');

    // 落点
    svg.push('<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="3.5" fill="var(--green)" stroke="var(--panel)" stroke-width="1.5"/>');
    svg.push('</svg>');
    return svg.join('');
  }

  /* ---------------- export ---------------- */
  function buildExportImageData(markMode) {
    var st = state.stats, p = state.params;
    var src = new Uint8ClampedArray(state.buffers.elliptic);
    var out = new Uint8ClampedArray(src);
    if (markMode) {
      st.invalidPixels.forEach(function (q) {
        var k = (q[1] * st.width + q[0]) * 4;
        out[k] = 255; out[k + 1] = 0; out[k + 2] = 255; out[k + 3] = 255; // 品红=无效
      });
      st.overflowPixels.forEach(function (q) {
        var k = (q[1] * st.width + q[0]) * 4;
        out[k] = 255; out[k + 1] = 128; out[k + 2] = 0; out[k + 3] = 255; // 橙=超半径
      });
    }
    return new ImageData(out, st.width, st.height);
  }

  function exportPNG() {
    if (!state.stats) { flashStatus('请先渲染'); return; }
    var c = document.createElement('canvas');
    c.width = state.stats.width; c.height = state.stats.height;
    c.getContext('2d').putImageData(buildExportImageData(true), 0, 0);
    els.dlFallback.classList.remove('show');
    c.toBlob(function (blob) {
      if (!blob) { showFallbackImage(c); return; }
      tryDownload(blob, 'elliptic-filtered.png', function () { showFallbackImage(c); });
    }, 'image/png');
  }

  function showFallbackImage(canvas) {
    els.dlFallback.classList.add('show');
    els.dlImg.src = canvas.toDataURL('image/png');
    els.dlText.value = '';
  }

  function buildExportJSON() {
    var st = state.stats, p = state.params;
    var payload = {
      generator: 'elliptic-footprint-sampler',
      texture: { name: state.texName, width: state.tex.w, height: state.tex.h },
      output: { width: st.width, height: st.height },
      homography: p.H,
      addressMode: p.address,
      anisotropyLimit: p.aniso,
      maxFootprintRadiusTexels: p.maxRadius,
      colorPipeline: 'sRGB decode → premultiplied linear weighted average → unpremultiply → sRGB encode',
      weight: 'q = (r-c)^T C\'^-1 (r-c); q<1; w = exp(-2q)-exp(-2); normalized',
      invalidProjectionPositions: st.invalidPixels,
      overflowPositions: st.overflowPixels,
      legend: { magentaInPNG: 'invalid w<=1e-6', orangeInPNG: 'footprint radius exceeds limit' }
    };
    if (state.fullJson) {
      payload.pixels = [];
      for (var y = 0; y < st.height; y++) {
        for (var x = 0; x < st.width; x++) {
          var rec = Sampler.computePixel(state.tex, p.H, x, y, p.address, p.aniso, p.maxRadius, ['elliptic']);
          if (rec.invalid) {
            payload.pixels.push({ x: x, y: y, invalid: true });
            continue;
          }
          var fp = rec.fp;
          var row = {
            x: x, y: y, s: rec.s, t: rec.t,
            footprint: {
              rMajor: fp.rMajor, rMinor: fp.rMinor, angle: fp.angle,
              lambdaMax: fp.lamMax, lambdaMin: fp.lamMin, lambdaMinLimited: fp.lamMinLimited,
              overflow: rec.overflow
            },
            linearRGBA: [rec.color.r, rec.color.g, rec.color.b, rec.color.a]
          };
          if (!rec.overflow) {
            row.contributions = rec.elliptic.contribs.map(function (z) {
              return [z.i, z.j, z.ii, z.jj, z.q, z.w / rec.elliptic.wsum];
            });
          }
          payload.pixels.push(row);
        }
      }
    } else if (state.selected) {
      var r = state.selected.rec;
      if (!r.invalid) {
        payload.inspectedPixel = {
          x: r.x, y: r.y, s: r.s, t: r.t, jacobian: r.J,
          footprint: r.fp,
          contributions: r.overflow ? [] : r.elliptic.contribs.map(function (z) {
            return { source: [z.i, z.j], addressed: [z.ii, z.jj], q: z.q, normalizedWeight: z.w / r.elliptic.wsum, linearRGBA: z.rgba };
          })
        };
      }
    }
    return JSON.stringify(payload, null, 2);
  }

  function exportJSON() {
    if (!state.stats) { flashStatus('请先渲染'); return; }
    var json = buildExportJSON();
    els.dlFallback.classList.remove('show');
    var blob = new Blob([json], { type: 'application/json' });
    tryDownload(blob, 'elliptic-sampling.json', function () {
      els.dlFallback.classList.add('show');
      els.dlText.value = json;
      els.dlImg.removeAttribute('src');
    });
  }

  function tryDownload(blob, filename, fallback) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    try { a.click(); } catch (e) { fallback(); }
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
    // 沙箱拦截下载时没有可靠事件；同时准备回退内容
    setTimeout(function () { if (els.dlFallback.classList.contains('show') === false && navigator.userAgent.indexOf('Claude') >= 0) fallback(); }, 300);
  }

  /* ---------------- events ---------------- */
  function bindCanvas(cv, method) {
    cv.addEventListener('click', function (ev) {
      var rect = cv.getBoundingClientRect();
      var x = Math.floor((ev.clientX - rect.left) / rect.width * cv.width);
      var y = Math.floor((ev.clientY - rect.top) / rect.height * cv.height);
      selectPixel(x, y, method);
    });
  }

  function bind() {
    PRESETS.forEach(function (pr, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = pr.name;
      els.presetSel.appendChild(o);
    });
    els.presetSel.addEventListener('change', function () {
      applyPreset(parseInt(els.presetSel.value, 10));
      render();
    });
    els.fileInput.addEventListener('change', function () { loadFile(els.fileInput.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      els.dropHint.addEventListener(ev, function (e) { e.preventDefault(); els.dropHint.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      els.dropHint.addEventListener(ev, function (e) { e.preventDefault(); els.dropHint.classList.remove('drag'); });
    });
    els.dropHint.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    els.renderBtn.addEventListener('click', render);
    els.resetBtn.addEventListener('click', function () {
      applyPreset(currentPresetIndex());
      render();
    });
    els.dlPngBtn.addEventListener('click', exportPNG);
    els.dlJsonBtn.addEventListener('click', exportJSON);
    els.fullJsonChk.addEventListener('change', function () { state.fullJson = els.fullJsonChk.checked; });
    bindCanvas(canvases.nearest.cv, 'nearest');
    bindCanvas(canvases.bilinear.cv, 'bilinear');
    bindCanvas(canvases.elliptic.cv, 'elliptic');

    els.themeBtn.addEventListener('click', function () {
      var root = document.documentElement;
      var dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.setAttribute('data-theme', 'light');
      else root.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('efs-theme', dark ? 'light' : 'dark'); } catch (e) {}
    });
    try {
      var saved = localStorage.getItem('efs-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {}
  }

  /* ---------------- boot ---------------- */
  function boot() {
    bind();
    initWorker();
    applyPreset(0);
    loadTextureFromSrc('data:image/png;base64,' + window.DEFAULT_TEX_B64, 'texture.png（内置样例）')
      .then(render)
      .catch(function (e) { flashStatus('内置纹理加载失败：' + e.message); });
  }

  // worker 源码在 worker-inlined.js 中以字符串注入
  var WORKER_SOURCE = window.__WORKER_SOURCE__ || '';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
