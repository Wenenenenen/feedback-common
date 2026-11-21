/* MVR1 closed-loop bench — page logic. Depends on window.MVR1 and window.MVR1_SAMPLES. */
(function () {
  'use strict';
  var M = window.MVR1;
  var $ = function (id) { return document.getElementById(id); };
  var ERR_RANGE = 32;

  var state = {
    sequence: null,
    encode: null,        // encoder result for the loaded sequence, null after opening a foreign stream
    goodBytes: null,     // last known-good bitstream for the current mode
    stream: null,        // { bytes, decoded, label, external, fault }
    params: { keyInterval: 6, quantStep: 8 },
    view: 'orig',
    showBlocks: true,
    showVectors: true,
    showPadding: false,
    frame: 0,
    block: 0,
    busy: false,
    dirty: false,
  };

  /* ----------------------------------------------------------------- utils */

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = bad ? 'bad' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 7000 : 3400);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 2 : 1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function fmtPsnr(v) {
    if (v == null) return '—';
    if (!isFinite(v)) return '∞';
    return v.toFixed(2);
  }
  function hex(n, width) {
    if (n == null) return '—';
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < (width || 2)) s = '0' + s;
    return '0x' + s;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function ceil8(v) { return Math.ceil(v / 8) * 8; }

  function metrics(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    return M.frameMetrics(a, b);
  }

  /* ------------------------------------------------------------- sequences */

  function sampleNames() { return Object.keys(window.MVR1_SAMPLES || {}); }

  function sampleToSequence(name) {
    var s = window.MVR1_SAMPLES[name];
    if (!s) return null;
    var frames = s.frames.map(function (b64, i) {
      var bin = atob(b64);
      var data = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) data[k] = bin.charCodeAt(k);
      return { index: i, name: pad2(i) + '.pgm', data: data };
    });
    return { name: name, width: s.width, height: s.height, frames: frames, warnings: [] };
  }

  function populateSequenceSelect() {
    var sel = $('sel-seq');
    sel.innerHTML = '';
    sampleNames().forEach(function (name) {
      var s = window.MVR1_SAMPLES[name];
      var o = el('option', null, name + ' · ' + s.width + '×' + s.height + ' · ' + s.frames.length + ' 帧');
      o.value = name;
      sel.appendChild(o);
    });
    var custom = el('option', null, '导入的序列');
    custom.value = '__custom';
    custom.disabled = true;
    custom.hidden = true;
    sel.appendChild(custom);
  }

  function setSequence(seq, custom) {
    state.sequence = seq;
    state.frame = 0;
    state.block = 0;
    state.view = state.view;
    var sel = $('sel-seq');
    if (!custom && sampleNames().indexOf(seq.name) >= 0) {
      sel.value = seq.name;
    } else {
      var o = sel.querySelector('option[value="__custom"]');
      o.hidden = false;
      o.disabled = false;
      o.textContent = seq.name + ' · ' + seq.width + '×' + seq.height + ' · ' + seq.frames.length + ' 帧';
      sel.value = '__custom';
    }
    $('src-badge').className = 'badge';
    $('src-badge-text').textContent = seq.name + ' · ' + seq.width + '×' + seq.height + ' · ' + seq.frames.length + ' 帧';
    if (seq.warnings && seq.warnings.length) {
      toast(seq.warnings.length + ' 条导入提示：' + seq.warnings[0]);
    }
    syncParamLimits();
    encode();
  }

  function syncParamLimits() {
    var n = state.sequence ? state.sequence.frames.length : 48;
    ['in-key', 'in-key-range'].forEach(function (id) {
      $(id).max = String(n);
      if (Number($(id).value) > n) $(id).value = String(n);
    });
    // The slider tops out at 64 for finer low-step control; the number input
    // still accepts the full 1..255 range.
    var q = Number($('in-q').value);
    $('in-q-range').value = String(Math.min(q, 64));
    updateParamNotes();
  }

  function updateParamNotes() {
    var n = state.sequence ? state.sequence.frames.length : 0;
    var ki = Number($('in-key').value) || 1;
    var q = Number($('in-q').value) || 1;
    $('key-note').textContent = n ? '共 ' + Math.ceil(n / ki) + ' 个 I 帧' : '';
    $('q-note').textContent = q === 1 ? '残差无损' : (q >= 64 ? '误差明显' : '残差步进 ' + q);
  }

  /* ---------------------------------------------------------------- params */

  function readParams() {
    var n = state.sequence ? state.sequence.frames.length : 48;
    var ki = clamp(Math.round(Number($('in-key').value) || 1), 1, n);
    var q = clamp(Math.round(Number($('in-q').value) || 1), 1, 255);
    $('in-key').value = String(ki);
    $('in-key-range').value = String(ki);
    $('in-q').value = String(q);
    $('in-q-range').value = String(Math.min(q, 64));
    updateParamNotes();
    return { keyInterval: ki, quantStep: q };
  }

  /* ---------------------------------------------------------------- encode */

  function setProgress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    $('encode-bar').style.width = pct + '%';
    $('encode-pct').textContent = total ? pct + '%' : '';
    if (done >= total && total) $('encode-state').textContent = '编码完成';
  }

  function encode(opts) {
    if (!state.sequence || state.busy) return;
    var params = readParams();
    var same = state.encode && state.params.keyInterval === params.keyInterval && state.params.quantStep === params.quantStep;
    if (same && !(opts && opts.force)) return;
    state.params = params;
    state.busy = true;
    $('btn-encode').disabled = true;
    $('btn-demo').disabled = true;
    $('encode-state').textContent = '编码中';
    setProgress(0, state.sequence.frames.length);
    var enc;
    try {
      enc = new M.Encoder(state.sequence, params);
    } catch (e) {
      state.busy = false;
      $('btn-encode').disabled = false;
      $('btn-demo').disabled = false;
      $('encode-state').textContent = '编码失败';
      toast(e.message, true);
      return;
    }
    var total = state.sequence.frames.length;
    var started = performance.now();
    (function chunk() {
      var until = performance.now() + 24;
      while (!enc.done && performance.now() < until) enc.step();
      setProgress(enc.index, total);
      if (!enc.done) { setTimeout(chunk, 0); return; }
      var result = enc.finish();
      var ms = performance.now() - started;
      state.encode = result;
      state.goodBytes = result.bytes;
      state.dirty = false;
      state.busy = false;
      $('btn-encode').disabled = false;
      $('btn-demo').disabled = false;
      $('encode-state').textContent = '完成 · ' + ms.toFixed(0) + ' ms';
      state.frame = clamp(state.frame, 0, result.frames.length - 1);
      state.block = clamp(state.block, 0, result.frames[state.frame].blocks.length - 1);
      setStream(result.bytes, '页面编码', { external: false });
      updateAll();
    })();
  }

  /* ----------------------------------------------------------------- stream */

  function setStream(bytes, label, opts) {
    opts = opts || {};
    var decoded = M.decode(bytes);
    state.stream = {
      bytes: bytes,
      label: label,
      decoded: decoded,
      external: !!opts.external,
      fault: opts.fault || null,
      crossCheck: null,
    };
    if (state.encode) {
      var total = 0;
      var first = -1;
      for (var i = 0; i < decoded.frames.length; i++) {
        var src = state.encode.frames[i];
        var df = decoded.frames[i];
        if (!src || !df) continue;
        var c = M.comparePlanes(df.recCrop, src.recCrop);
        if (c.mismatches) { total += c.mismatches; if (first < 0) first = i; }
      }
      state.stream.crossCheck = { mismatches: total, firstFrame: first, frames: decoded.frames.length, encoded: state.encode.frames.length };
    }
  }

  function updateAll() {
    renderTimeline();
    renderView();
    renderInspector();
    renderStatus();
    renderCharts();
    renderDiagnosis();
    renderBitstream();
  }

  function openStream(bytes, name) {
    state.encode = null;
    state.goodBytes = bytes;
    state.params = { keyInterval: M.readU16(bytes, 10), quantStep: M.readU16(bytes, 12) };
    state.frame = 0;
    state.block = 0;
    setStream(bytes, name, { external: true });
    $('src-badge').className = 'badge file';
    $('src-badge-text').textContent = '外部码流 · ' + name;
    updateAll();
    var d = state.stream.decoded;
    if (d.ok) toast('已从文件独立解码 ' + d.frames.length + ' 帧，' + fmtBytes(bytes.length));
    else toast('码流有 ' + d.issues.filter(function (x) { return x.severity === 'error'; }).length + ' 处问题，见「码流与校验」。', true);
  }

  /* ---------------------------------------------------------- frame access */

  function frameCount() {
    if (state.stream && state.stream.decoded.header) return state.stream.decoded.header.frameCount;
    if (state.encode) return state.encode.frames.length;
    if (state.sequence) return state.sequence.frames.length;
    return 0;
  }

  function decFrame(i) {
    if (!state.stream) return null;
    return state.stream.decoded.frames[i] || null;
  }
  function encFrame(i) {
    if (!state.encode) return null;
    return state.encode.frames[i] || null;
  }

  function header() {
    if (state.stream && state.stream.decoded.header) return state.stream.decoded.header;
    if (state.encode) return state.encode.header;
    return null;
  }

  function origPaddedFor(i) {
    var h = header();
    if (!h) return null;
    var ef = encFrame(i);
    if (ef && ef.origPadded) return ef.origPadded;
    if (!state.sequence) return null;
    if (state.sequence.frames.length !== h.frameCount) return null;
    if (state.sequence.width !== h.width || state.sequence.height !== h.height) return null;
    var s = state.sequence.frames[i];
    if (!s) return null;
    return M.padPlane(s.data, h.width, h.height, h.paddedWidth, h.paddedHeight);
  }

  // Unified view of the currently displayed frame. Once a bitstream exists the
  // decoder is the source of truth: a frame the file does not contain is shown
  // as missing rather than silently replaced by the encoder's copy.
  function viewFrame(i) {
    var h = header();
    if (!h) return null;
    var df = decFrame(i);
    var ef = state.stream ? null : encFrame(i);
    if (!df && !ef) return null;
    var type = df ? df.type : ef.type;
    return {
      index: i,
      type: type,
      pred: df ? df.predPadded : ef.predPadded,
      rec: df ? df.recPadded : ef.recPadded,
      orig: origPaddedFor(i),
      blocks: df ? df.blocks : ef.blocks,
      incomplete: !!(df && df.incomplete),
      fromFile: !!df,
      expectedType: i % h.keyInterval === 0 ? 0 : 1,
    };
  }

  function missingReason(i) {
    if (!state.stream) return null;
    var d = state.stream.decoded;
    var issue = d.issues.filter(function (it) { return it.severity === 'error'; })[0];
    if (!issue) return '该帧不在文件里';
    if (issue.frame != null && issue.frame < i) {
      return '解码在第 ' + issue.frame + ' 帧中断（' + issue.kind + '），后面的帧无法解码';
    }
    return '第 ' + i + ' 帧无法解码：' + issue.message;
  }

  function planeFor(vf, kind) {
    if (!vf) return null;
    if (kind === 'orig') return vf.orig;
    if (kind === 'pred') return vf.pred;
    if (kind === 'rec') return vf.rec;
    return null;
  }

  /* --------------------------------------------------------------- viewer */

  var viewerGeom = null; // { scale, drawW, drawH, pw, ph, panels }

  function showPadding() { return state.showPadding; }

  function computeScale(drawW, drawH) {
    var host = $('viewer');
    var availW = Math.max(140, host.clientWidth - (window.innerWidth <= 640 ? 24 : 48));
    var availH = Math.max(180, Math.min(600, window.innerHeight * 0.56));
    var s = Math.min(availW / drawW, availH / drawH);
    if (s >= 6) s = Math.floor(s);
    else if (s >= 2) s = Math.floor(s * 2) / 2;
    return Math.max(1, s);
  }

  function renderView() {
    var fit = $('canvas-fit');
    var empty = $('viewer-empty');
    var missing = $('viewer-missing');
    var vf = viewFrame(state.frame);
    var h = header();
    if (!header()) {
      fit.hidden = true;
      empty.hidden = false;
      missing.hidden = true;
      $('err-scale').hidden = true;
      return;
    }
    empty.hidden = true;
    if (!vf) {
      fit.hidden = true;
      missing.hidden = false;
      $('missing-title').textContent = '第 ' + state.frame + ' 帧无法显示';
      $('missing-text').textContent = missingReason(state.frame) || '该帧不在码流里。';
      $('err-scale').hidden = true;
      viewerGeom = null;
      return;
    }
    missing.hidden = true;
    fit.hidden = false;

    var pad = showPadding();
    var pw = h.paddedWidth, ph = h.paddedHeight;
    var w = h.width, hh = h.height;
    var bw = pad ? pw : w;
    var bh = pad ? ph : hh;

    var view = state.view;
    var needOrig = view === 'orig' || view === 'err' || view === 'side';
    if (needOrig && !vf.orig) {
      if (view === 'orig' || view === 'side') view = 'rec';
      else if (view === 'err') view = 'rec';
    }
    if (!vf.pred && (view === 'pred' || view === 'side')) view = vf.rec ? 'rec' : 'orig';

    var panels = 1;
    var gap = 0;
    if (view === 'side') { panels = 2; gap = Math.max(2, Math.round(Math.min(pw, ph) / 64)); }

    var drawW = panels === 2 ? bw * 2 + gap : bw;
    var drawH = bh;
    var canvas = $('view-canvas');
    if (canvas.width !== drawW) canvas.width = drawW;
    if (canvas.height !== drawH) canvas.height = drawH;

    var scale = computeScale(drawW, drawH);
    fit.style.width = Math.round(drawW * scale) + 'px';
    fit.style.height = Math.round(drawH * scale) + 'px';

    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(drawW, drawH);
    var out = img.data;
    var rec = vf.rec, pred = vf.pred, orig = vf.orig;

    function put(o, r, g, b) { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; }
    function gray(o, v) { out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; }

    var y, x, o;
    if (view === 'err') {
      for (y = 0; y < drawH; y++) {
        for (x = 0; x < drawW; x++) {
          var idx = y * bw + x;
          if (pad) {
            // padded planes all share pw*ph layout
            idx = y * pw + x;
            var a = orig ? orig[idx] : rec[idx];
            var b = rec[idx];
            var t = clamp((a - b) / ERR_RANGE, -1, 1);
            var c = errColor(t);
            put((y * drawW + x) * 4, c[0], c[1], c[2]);
          } else {
            o = (y * drawW + x) * 4;
            if (x >= w || y >= hh) { gray(o, 0); continue; }
            var ai = y * w + x;
            var t2 = clamp(((orig ? orig[ai] : rec[ai]) - rec[ai]) / ERR_RANGE, -1, 1);
            var c2 = errColor(t2);
            put(o, c2[0], c2[1], c2[2]);
          }
        }
      }
    } else if (view === 'side') {
      for (y = 0; y < drawH; y++) {
        for (x = 0; x < drawW; x++) {
          o = (y * drawW + x) * 4;
          if (x >= bw && x < bw + gap) {
            put(o, 154, 163, 171);
            continue;
          }
          var localX = x < bw ? x : x - bw - gap;
          var plane = x < bw ? orig : rec;
          var v;
          if (pad) v = plane[y * pw + localX];
          else v = (localX < w && y < hh) ? plane[y * w + localX] : 0;
          gray(o, v);
        }
      }
    } else {
      var plane2 = planeFor(vf, view);
      for (y = 0; y < drawH; y++) {
        for (x = 0; x < drawW; x++) {
          o = (y * drawW + x) * 4;
          var vv;
          if (pad) vv = plane2[y * pw + x];
          else vv = (x < w && y < hh) ? plane2[y * w + x] : 0;
          gray(o, vv);
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    viewerGeom = { scale: scale, drawW: drawW, drawH: drawH, pw: pw, ph: ph, bw: bw, bh: bh, gap: gap, panels: panels, view: view };
    $('err-scale').hidden = view !== 'err';
    renderOverlay();
  }

  function errColor(t) {
    if (t === 0) return [236, 238, 240];
    if (t < 0) {
      var a = clamp(-t, 0, 1);
      return [Math.round(236 - a * 194), Math.round(238 - a * 117), Math.round(240 - a * 26)];
    }
    var c = clamp(t, 0, 1);
    return [Math.round(236 + c * 19), Math.round(238 - c * 136), Math.round(240 - c * 194)];
  }

  function blockAt(x, y) {
    var h = header();
    if (!h || !viewerGeom) return -1;
    var g = viewerGeom;
    var localX = x;
    if (g.panels === 2) {
      if (x >= g.bw && x < g.bw + g.gap) return -1;
      localX = x < g.bw ? x : x - g.bw - g.gap;
    }
    if (g.view === 'side' && localX >= g.bw) return -1;
    if (!showPadding() && (localX >= h.width || y >= h.height)) return -1;
    if (localX < 0 || y < 0 || localX >= g.bw || y >= g.bh) return -1;
    var bx = Math.floor(localX / 8);
    var by = Math.floor(y / 8);
    var bwBlocks = g.bw / 8;
    return by * bwBlocks + bx;
  }

  function renderOverlay() {
    var svg = $('view-overlay');
    var g = viewerGeom;
    var vf = viewFrame(state.frame);
    if (!g || !vf) { svg.innerHTML = ''; return; }
    var h = header();
    var ns = 'http://www.w3.org/2000/svg';
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var dispW = Math.round(g.drawW * g.scale);
    var dispH = Math.round(g.drawH * g.scale);
    svg.setAttribute('viewBox', '0 0 ' + dispW + ' ' + dispH);
    svg.setAttribute('width', dispW);
    svg.setAttribute('height', dispH);

    var bwBlocks = g.bw / 8;
    var bhBlocks = g.bh / 8;
    var scale = g.scale;
    var panels = g.panels === 2 ? 2 : 1;

    if (state.showBlocks) {
      var gridPath = '';
      for (var p = 0; p < panels; p++) {
        var ox = p === 0 ? 0 : (g.bw + g.gap) * scale;
        for (var bx = 0; bx <= bwBlocks; bx++) {
          var x = Math.round((bx * 8) * scale) + ox + 0.5;
          gridPath += 'M' + x + ' ' + ox * 0 + 'V' + dispH;
        }
        for (var by = 0; by <= bhBlocks; by++) {
          var yy = Math.round((by * 8) * scale) + 0.5;
          gridPath += 'M' + ox + ' ' + yy + 'H' + (ox + g.bw * scale);
        }
      }
      var grid = document.createElementNS(ns, 'path');
      grid.setAttribute('d', gridPath);
      grid.setAttribute('fill', 'none');
      grid.setAttribute('stroke', 'rgba(18,24,29,0.22)');
      grid.setAttribute('stroke-width', '1');
      grid.setAttribute('shape-rendering', 'crispEdges');
      svg.appendChild(grid);
    }

    // Selected block outline (on every panel).
    var sel = vf.blocks[state.block];
    if (sel) {
      for (var pi = 0; pi < panels; pi++) {
        var px0 = (pi === 0 ? 0 : (g.bw + g.gap) * scale) + sel.bx * 8 * scale;
        var py0 = sel.by * 8 * scale;
        var rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', px0 + 0.5);
        rect.setAttribute('y', py0 + 0.5);
        rect.setAttribute('width', Math.max(1, 8 * scale - 1));
        rect.setAttribute('height', Math.max(1, 8 * scale - 1));
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#f0b45c');
        rect.setAttribute('stroke-width', '2');
        rect.setAttribute('pointer-events', 'none');
        svg.appendChild(rect);
      }
    }

    if (state.showVectors && vf.type === 1) {
      var showAll = scale >= 3;
      vf.blocks.forEach(function (b) {
        if (b.dx == null) return;
        if (!state.showVectors) return;
        if (!showAll && b.index !== state.block) return;
        if (b.dx === 0 && b.dy === 0 && b.index !== state.block) return;
        for (var p2 = 0; p2 < panels; p2++) {
          var baseX = (p2 === 0 ? 0 : (g.bw + g.gap) * scale) + (b.bx * 8 + 4) * scale;
          var baseY = (b.by * 8 + 4) * scale;
          var ex = baseX + (b.dx / 2) * scale;
          var ey = baseY + (b.dy / 2) * scale;
          var isSel = b.index === state.block;
          var grp = document.createElementNS(ns, 'g');
          grp.setAttribute('pointer-events', 'none');
          var line = document.createElementNS(ns, 'line');
          line.setAttribute('x1', baseX); line.setAttribute('y1', baseY);
          line.setAttribute('x2', ex); line.setAttribute('y2', ey);
          line.setAttribute('stroke', isSel ? '#f0b45c' : 'rgba(27,175,122,0.85)');
          line.setAttribute('stroke-width', isSel ? '2.2' : '1.6');
          grp.appendChild(line);
          var ang = Math.atan2(ey - baseY, ex - baseX);
          var ah = isSel ? 7 : 5;
          var a1x = ex - ah * Math.cos(ang - 0.42);
          var a1y = ey - ah * Math.sin(ang - 0.42);
          var a2x = ex - ah * Math.cos(ang + 0.42);
          var a2y = ey - ah * Math.sin(ang + 0.42);
          var head = document.createElementNS(ns, 'path');
          head.setAttribute('d', 'M' + ex + ' ' + ey + 'L' + a1x + ' ' + a1y + 'M' + ex + ' ' + ey + 'L' + a2x + ' ' + a2y);
          head.setAttribute('stroke', isSel ? '#f0b45c' : 'rgba(27,175,122,0.85)');
          head.setAttribute('stroke-width', isSel ? '2.2' : '1.6');
          head.setAttribute('fill', 'none');
          grp.appendChild(head);
          var dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', baseX); dot.setAttribute('cy', baseY);
          dot.setAttribute('r', isSel ? 2.6 : 1.6);
          dot.setAttribute('fill', isSel ? '#f0b45c' : 'rgba(27,175,122,0.9)');
          grp.appendChild(dot);
          svg.appendChild(grp);
        }
      });
    }

    // Padding-region marker when the coded grid is larger than the picture.
    if (showPadding() && (h.paddedWidth !== h.width || h.paddedHeight !== h.height)) {
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', 0.5); r.setAttribute('y', 0.5);
      r.setAttribute('width', h.width * scale - 1);
      r.setAttribute('height', h.height * scale - 1);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', 'rgba(240,180,92,0.95)');
      r.setAttribute('stroke-dasharray', '5 4');
      r.setAttribute('stroke-width', '1.5');
      r.setAttribute('pointer-events', 'none');
      svg.appendChild(r);
    }

    svg.onpointerdown = function (ev) {
      var rect = svg.getBoundingClientRect();
      var sx = g.drawW / rect.width;
      var sy = g.drawH / rect.height;
      var x = Math.floor((ev.clientX - rect.left) * sx);
      var y = Math.floor((ev.clientY - rect.top) * sy);
      var bi = blockAt(x, y);
      if (bi >= 0 && bi < vf.blocks.length) {
        state.block = bi;
        renderView();
        renderInspector();
        renderStatus();
      }
    };
  }

  /* ------------------------------------------------------------ inspector */

  function renderInspector() {
    var vf = viewFrame(state.frame);
    var h = header();
    var has = !!vf;
    $('block-empty').hidden = has;
    $('block-body').hidden = !has;
    $('ref-empty').hidden = !has || vf.type !== 1;
    $('ref-body').hidden = !has || vf.type !== 1;

    if (!has) {
      $('blk-of').textContent = '';
      $('fr-of').textContent = '';
      ['kv-type', 'kv-payload', 'kv-pblocks', 'kv-maxerr', 'kv-psnr'].forEach(function (id) { $(id).textContent = '—'; });
      return;
    }

    var b = vf.blocks[state.block];
    var bwBlocks = h.paddedWidth / 8;
    $('blk-of').textContent = vf.blocks.length + ' 块';
    $('fr-of').textContent = '帧 ' + state.frame;
    $('blk-where').innerHTML = '(' + (b ? b.bx : 0) + ', ' + (b ? b.by : 0) + ') <small>块 ' + state.block + '</small>';
    var kind = $('blk-kind');
    kind.className = 'chip ' + (vf.type === 0 ? 'chip-i' : 'chip-p');
    kind.textContent = vf.type === 0 ? 'I 帧块' : 'P 帧块';

    var offX = (b ? b.bx : 0) * 8;
    var offY = (b ? b.by : 0) * 8;
    var orig = vf.orig;
    var rec = vf.rec;
    var pred = vf.pred;
    var pw = h.paddedWidth;

    function blockBytes(plane) {
      if (!plane) return null;
      var arr = new Uint8Array(64);
      for (var yy = 0; yy < 8; yy++) {
        for (var xx = 0; xx < 8; xx++) arr[yy * 8 + xx] = plane[(offY + yy) * pw + offX + xx];
      }
      return arr;
    }
    var ob = blockBytes(orig);
    var rb = blockBytes(rec);
    var pb = blockBytes(pred);

    $('blk-mv').textContent = vf.type === 0 ? '—' : ((b && b.dx != null) ? b.dx + ', ' + b.dy : '—');
    var sad = b && b.sad != null ? b.sad : null;
    if (sad == null && vf.type === 1 && pb && ob) {
      // Frames decoded from a foreign file carry no stored SAD; recompute the
      // value the encoder would have used for this vector.
      sad = 0;
      for (var i = 0; i < 64; i++) sad += Math.abs(pb[i] - ob[i]);
    }
    $('blk-sad').textContent = sad == null ? '—' : String(sad);
    $('blk-nz').textContent = b ? String(b.nonzero) : '—';

    drawMini($('mini-orig'), ob, null);
    drawMini($('mini-pred'), pb, vf.type === 0 ? 128 : null);
    var diff = null;
    if (ob && rb) {
      diff = new Float32Array(64);
      for (var j = 0; j < 64; j++) diff[j] = ob[j] - rb[j];
    }
    drawMini($('mini-err'), rb, null, diff);

    function errText() {
      if (!ob || !rb) return '';
      var s = 0, mx = 0;
      for (var k = 0; k < 64; k++) { var d = Math.abs(ob[k] - rb[k]); s += d; if (d > mx) mx = d; }
      return 'MAE ' + (s / 64).toFixed(1);
    }
    $('mini-orig-v').textContent = ob ? '平均 ' + (avg(ob)).toFixed(0) : '—';
    $('mini-pred-v').textContent = pb ? '平均 ' + (avg(pb)).toFixed(0) : (vf.type === 0 ? '常量 128' : '—');
    $('mini-err-v').textContent = errText();

    var bytes = b ? (b.payloadEnd - b.payloadStart) : 0;
    $('blk-bytes').textContent = b ? bytes + ' B' : '';

    // Coefficient table.
    var tbody = $('coef-grid').querySelector('tbody');
    tbody.innerHTML = '';
    for (var row = 0; row < 8; row++) {
      var tr = document.createElement('tr');
      for (var col = 0; col < 8; col++) {
        var td = document.createElement('td');
        var v = b ? b.coeffs[row * 8 + col] : 0;
        td.textContent = String(v);
        if (v > 0) td.className = 'pos';
        else if (v < 0) td.className = 'neg';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    // Reference window.
    if (vf.type === 1 && b) {
      drawReference(b, h);
      $('ref-of').textContent = '块 (' + b.bx + ', ' + b.by + ') · 双线性';
      $('ref-math').textContent = 'x+dx/2, y+dy/2 = (' + (b.dx / 2).toFixed(1) + ', ' + (b.dy / 2).toFixed(1) + ') px';
      $('ref-samp').textContent = '采样整点 ' + Math.floor(b.dx / 2) + '…+1, ' + Math.floor(b.dy / 2) + '…+1';
    }
    renderFrameKv(vf, h);
  }

  function avg(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function drawMini(canvas, block, constant, diff) {
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(8, 8);
    for (var i = 0; i < 64; i++) {
      var o = i * 4;
      if (diff) {
        var c = errColor(clamp(diff[i] / ERR_RANGE, -1, 1));
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      } else {
        var v = block ? block[i] : (constant != null ? constant : 0);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawReference(b, h) {
    var canvas = $('ref-canvas');
    var pw = h.paddedWidth, ph = h.paddedHeight;
    var N = 14;            // reference cells shown per axis
    var CELL = 20;         // device pixels per reference cell
    canvas.width = N * CELL;
    canvas.height = N * CELL;
    var ctx = canvas.getContext('2d');
    var prev = state.frame > 0 ? decFrame(state.frame - 1) : null;
    var prevPlane = prev ? prev.recPadded : (state.frame > 0 ? (encFrame(state.frame - 1) || {}).recPadded : null);
    // Window origin: three cells of context on each side of the block.
    var ox = b.bx * 8 - 3;
    var oy = b.by * 8 - 3;

    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var sx = ox + x, sy = oy + y;
        var v = 0;
        if (prevPlane) {
          var cxs = clamp(sx, 0, pw - 1), cys = clamp(sy, 0, ph - 1);
          v = prevPlane[cys * pw + cxs];
        }
        var shade = 24 + Math.round(v / 255 * 216);
        ctx.fillStyle = 'rgb(' + shade + ',' + shade + ',' + shade + ')';
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // Integer sampling grid (the cells bilinear interpolation blends).
    ctx.strokeStyle = 'rgba(240,180,92,0.55)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= N; gx++) {
      var px = gx * CELL + 0.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, N * CELL); ctx.stroke();
    }
    for (var gy = 0; gy <= N; gy++) {
      var py = gy * CELL + 0.5;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(N * CELL, py); ctx.stroke();
    }

    // Footprint of the block's eight sample positions, in source coordinates.
    var fx = (b.bx * 8 - ox) + b.dx / 2;
    var fy = (b.by * 8 - oy) + b.dy / 2;
    ctx.strokeStyle = '#f0b45c';
    ctx.lineWidth = 2;
    ctx.strokeRect(fx * CELL + 0.5, fy * CELL + 0.5, 7 * CELL, 7 * CELL);

    // The eight sample centres along the top-left corner cell.
    ctx.fillStyle = '#12181d';
    for (var s = 0; s <= 8; s += 4) {
      ctx.beginPath();
      ctx.arc((fx + s) * CELL, (fy + s) * CELL, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f0b45c';
    ctx.beginPath();
    ctx.arc(fx * CELL, fy * CELL, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function renderFrameKv(vf, h) {
    var orig = vf.orig;
    var rec = vf.rec;
    var pred = vf.pred;
    var m = null;
    if (orig && rec && !showPadding()) {
      m = metrics(cropTo(orig, h), cropTo(rec, h));
    }
    $('kv-type').innerHTML = vf.type === 0 ? '<span class="chip chip-i">I</span>' : '<span class="chip chip-p">P</span>';
    var payload = null;
    if (state.stream) {
      var df = decFrame(state.frame);
      if (df) payload = df.payloadLen;
    }
    $('kv-payload').textContent = payload == null ? '—' : payload + ' B';
    var pm = 0;
    vf.blocks.forEach(function (b) { if (b.dx != null && (b.dx !== 0 || b.dy !== 0)) pm++; });
    $('kv-pblocks').textContent = vf.type === 1 ? pm + ' / ' + vf.blocks.length : '—';
    if (m) {
      $('kv-maxerr').textContent = m.maxErr;
      $('kv-psnr').textContent = fmtPsnr(m.psnr) + (isFinite(m.psnr) ? ' dB' : '');
    } else {
      $('kv-maxerr').textContent = '—';
      $('kv-psnr').textContent = vf.incomplete ? '帧不完整' : '—';
    }
  }

  function cropTo(padded, h) {
    return M.cropPlane(padded, h.width, h.height, h.paddedWidth);
  }

  /* ---------------------------------------------------------------- status */

  function renderStatus() {
    var vf = viewFrame(state.frame);
    var h = header();
    var n = frameCount();
    var chip = $('st-type');
    var tlChip = $('tl-chip');
    if (!header()) {
      chip.className = 'chip chip-p'; chip.textContent = '—';
      $('st-type-note').textContent = '';
      ['st-frame', 'st-block', 'st-mv', 'st-psnr'].forEach(function (id) { $(id).textContent = '—'; });
      $('st-extra').textContent = '';
      tlChip.className = 'chip chip-p'; tlChip.textContent = '—';
      $('tl-frame').textContent = '—';
      return;
    }
    $('tl-frame').textContent = String(state.frame);
    $('frame-range').value = String(state.frame);
    $('btn-prev').disabled = state.frame <= 0;
    $('btn-next').disabled = state.frame >= n - 1;
    var ticks = $('ticks').children;
    for (var i = 0; i < ticks.length; i++) {
      if (i === state.frame) ticks[i].setAttribute('aria-current', 'true');
      else ticks[i].removeAttribute('aria-current');
    }
    if (!vf) {
      chip.className = 'chip chip-p'; chip.textContent = '—';
      tlChip.className = 'chip chip-p'; tlChip.textContent = '—';
      $('st-type-note').textContent = '文件解码';
      $('st-frame').textContent = state.frame + ' / ' + Math.max(0, n - 1);
      $('st-block').textContent = '—';
      $('st-mv').textContent = '—';
      $('st-psnr').textContent = '—';
      $('st-extra').textContent = '该帧不在文件里';
      $('err-scale').hidden = true;
      return;
    }
    chip.className = 'chip ' + (vf.type === 0 ? 'chip-i' : 'chip-p');
    chip.textContent = vf.type === 0 ? 'I' : 'P';
    tlChip.className = 'chip ' + (vf.type === 0 ? 'chip-i' : 'chip-p');
    tlChip.textContent = vf.type === 0 ? 'I' : 'P';
    $('st-type-note').textContent = vf.fromFile ? '文件解码' : '编码器';
    $('st-frame').textContent = state.frame + ' / ' + Math.max(0, n - 1);
    var b = vf.blocks[state.block];
    $('st-block').textContent = b ? '(' + b.bx + ',' + b.by + ')' : '—';
    $('st-mv').textContent = vf.type === 0 ? '—' : (b && b.dx != null ? b.dx + ',' + b.dy : '—');
    var m = null;
    if (vf.orig && vf.rec && h) {
      m = metrics(cropTo(vf.orig, h), cropTo(vf.rec, h));
    }
    $('st-psnr').textContent = m ? fmtPsnr(m.psnr) : '—';
    var notes = [];
    if (vf.incomplete) notes.push('该帧不完整');
    if (h && (h.width !== h.paddedWidth || h.height !== h.paddedHeight)) notes.push('补边 ' + h.width + '×' + h.height + ' → ' + h.paddedWidth + '×' + h.paddedHeight);
    $('st-extra').textContent = notes.join(' · ');
  }

  /* -------------------------------------------------------------- timeline */

  function renderTimeline() {
    var n = frameCount();
    var ticks = $('ticks');
    ticks.innerHTML = '';
    var decoded = state.stream ? state.stream.decoded : null;
    var badFrames = {};
    if (decoded) decoded.issues.forEach(function (it) {
      if (it.frame != null) badFrames[it.frame] = true;
    });
    for (var i = 0; i < n; i++) {
      var type = 1;
      var df = decFrame(i);
      if (df) type = df.type;
      else {
        var ef = encFrame(i);
        if (ef) type = ef.type;
        else if (header()) type = i % header().keyInterval === 0 ? 0 : 1;
      }
      var cls = 'tick' + (type === 0 ? ' i' : '');
      if (badFrames[i]) cls += ' bad';
      if (decoded && !df) cls += ' undecoded';
      var b = el('button', cls);
      b.type = 'button';
      b.dataset.frame = String(i);
      var missingNote = decoded && !df;
      b.title = '帧 ' + i + ' · ' + (type === 0 ? 'I' : 'P') +
        (badFrames[i] ? ' · 解码出错' : (missingNote ? ' · 文件里没有这一帧' : ''));
      b.setAttribute('aria-label', b.title);
      if (i === state.frame) b.setAttribute('aria-current', 'true');
      ticks.appendChild(b);
    }
    $('frame-range').max = String(Math.max(0, n - 1));
    $('frame-range').value = String(state.frame);
    $('tl-total').textContent = n ? String(n) : '—';
    $('tm-end').textContent = n ? String(n - 1) : '';
    $('tm-mid').textContent = n ? String(Math.floor((n - 1) / 2)) : '';
  }

  /* ---------------------------------------------------------------- charts */

  var chartData = null;

  function buildChartData() {
    var h = header();
    var n = frameCount();
    var rows = [];
    var cum = 0;
    var gopStart = 0;
    var openLoop = computeOpenLoop(h);
    for (var i = 0; i < n; i++) {
      var vf = viewFrame(i);
      // A frame the current bitstream does not contain has no data; deriving
      // type from it would invent a key frame that isn't in the file.
      if (!vf) { rows.push({ i: i, type: null, recMse: null, predMse: null, mae: null, cum: null, gop: null, missing: true, openLoopMse: null }); continue; }
      var row = { i: i, type: vf.type, recMse: null, predMse: null, mae: null, cum: null, partial: vf.incomplete };
      var origCrop = null;
      if (vf.orig && vf.rec) {
        var o = cropTo(vf.orig, h), r = cropTo(vf.rec, h);
        origCrop = o;
        var m = metrics(o, r);
        row.recMse = m.mse;
        row.mae = m.mae;
        if (vf.pred) {
          var p = cropTo(vf.pred, h);
          row.predMse = metrics(o, p).mse;
        }
      }
      if (openLoop && openLoop[i] && origCrop) {
        row.openLoopMse = metrics(origCrop, openLoop[i]).mse;
      } else {
        row.openLoopMse = null;
      }
      if (row.type === 0) { cum = 0; gopStart = i; }
      if (row.mae != null) cum += row.mae;
      row.cum = row.mae == null ? null : cum;
      row.gop = i - gopStart;
      rows.push(row);
    }
    chartData = {
      rows: rows,
      hasOrig: !!(state.sequence && h && state.sequence.frames.length === h.frameCount),
      openLoop: openLoop,
    };

    // Table.
    var t1 = $('table-err');
    t1.innerHTML = '';
    var head = '<tr><th>帧</th><th>类型</th><th>重建 MSE</th><th>预测 MSE</th><th>原始参考 MSE</th><th>PSNR</th></tr>';
    var body = rows.map(function (r) {
      var psnr = r.recMse == null ? '—' : (r.recMse === 0 ? '∞' : (10 * Math.log10(65025 / r.recMse)).toFixed(2));
      return '<tr><td>' + r.i + '</td><td>' + (r.type === 0 ? 'I' : (r.type === 1 ? 'P' : '—')) + '</td><td>' +
        (r.recMse == null ? '—' : r.recMse.toFixed(1)) + '</td><td>' +
        (r.predMse == null ? '—' : r.predMse.toFixed(1)) + '</td><td>' +
        (r.openLoopMse == null ? '—' : r.openLoopMse.toFixed(1)) + '</td><td>' + psnr + '</td></tr>';
    }).join('');
    t1.innerHTML = head + body;

    var t2 = $('table-drift');
    t2.innerHTML = '<tr><th>帧</th><th>本帧 MAE</th><th>GOP 内累积</th></tr>' + rows.map(function (r) {
      return '<tr><td>' + r.i + '</td><td>' + (r.mae == null ? '—' : r.mae.toFixed(2)) + '</td><td>' + (r.cum == null ? '—' : r.cum.toFixed(2)) + '</td></tr>';
    }).join('');
  }

  /*
   * Counterfactual: the same bitstream, but each P frame predicts from the
   * PREVIOUS ORIGINAL frame instead of the previous decoded one. Comparing the
   * two reconstructions is the cheapest way to see whether a closed-loop bug is
   * costing quality — if they agree, the reference wiring is not the culprit.
   */
  function computeOpenLoop(h) {
    if (!state.sequence || !h) return null;
    if (state.sequence.frames.length !== h.frameCount) return null;
    if (state.sequence.width !== h.width || state.sequence.height !== h.height) return null;
    var pw = h.paddedWidth, ph = h.paddedHeight, q = h.quantStep;
    var out = [];
    for (var i = 0; i < h.frameCount; i++) {
      var vf = viewFrame(i);
      if (!vf || !vf.blocks.length) { out.push(null); continue; }
      var orig = origPaddedFor(i);
      if (!orig) { out.push(null); continue; }
      var rec = new Uint8Array(pw * ph);
      if (vf.type === 0) {
        rec.set(vf.rec || orig);
        out.push(cropTo(rec, h));
        continue;
      }
      var prevOrig = origPaddedFor(i - 1);
      if (!prevOrig) { out.push(null); continue; }
      var phases = M.buildPhasePlanes(prevOrig, pw, ph);
      for (var bi = 0; bi < vf.blocks.length; bi++) {
        var b = vf.blocks[bi];
        var dx = b.dx || 0, dy = b.dy || 0;
        var plane = phases.planes[M.phaseIndex(dx, dy)];
        var ox = Math.floor(dx / 2), oy = Math.floor(dy / 2);
        for (var yy = 0; yy < 8; yy++) {
          var py = b.by * 8 + yy;
          var row = py * pw + b.bx * 8;
          var src = (py + oy + 5) * phases.ew + (b.bx * 8 + ox) + 5;  // PAD = 5 in mvr1.js
          for (var xx = 0; xx < 8; xx++) {
            var pred = plane[src + xx];
            var v = pred + b.coeffs[yy * 8 + xx] * q;
            rec[row + xx] = v < 0 ? 0 : (v > 255 ? 255 : v);
          }
        }
      }
      out.push(cropTo(rec, h));
    }
    return out;
  }

  var chartHover = { err: -1, drift: -1 };

  function chartTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      ink: v('--ink'),
      ink2: v('--ink-2'),
      ink3: v('--ink-3'),
      line: v('--line'),
      surface: v('--surface'),
      rec: v('--s-rec'),
      pred: v('--s-pred'),
      accent: v('--accent'),
      vec: v('--s-vec'),
    };
  }

  function drawChart(canvas, rows, series, opts) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.max(240, rect.width), H = rect.height || 200;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var th = chartTheme();
    var padL = 46, padR = 14, padT = 12, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = rows.length;
    if (!n) return;

    var logScale = !!opts.log;
    var allVals = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && isFinite(v)) allVals.push(v); }); });
    var maxV = Math.max.apply(null, allVals.length ? allVals : [1]);
    var minV = 0;
    if (logScale) {
      maxV = Math.log10(1 + Math.max(1, maxV));
      minV = 0;
    } else {
      maxV = maxV === 0 ? 1 : maxV * 1.12;
    }
    function yOf(v) {
      var t = logScale ? Math.log10(1 + v) : v;
      return padT + plotH - (t / maxV) * plotH;
    }
    function xOf(i) { return n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW; }

    // Grid + y labels.
    ctx.font = '10px ' + (getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var frac = g / ticks;
      var val = logScale ? Math.pow(10, maxV * frac) - 1 : maxV * frac;
      var y = padT + plotH - frac * plotH;
      ctx.strokeStyle = th.line;
      ctx.globalAlpha = g === 0 ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(W - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.ink3;
      var label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : (val >= 10 ? val.toFixed(0) : val.toFixed(1));
      ctx.fillText(label, padL - 6, y);
    }

    // X labels: first, middle, last.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = th.ink3;
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) {
      if (i < 0) return;
      ctx.fillText(String(rows[i].i), xOf(i), H - padB + 6);
    });

    // Highlight I frames with a faint band.
    rows.forEach(function (r, i) {
      if (r.type !== 0) return;
      var x0 = i === 0 ? padL : (xOf(i) + xOf(i - 1)) / 2;
      var x1 = i === n - 1 ? W - padR : (xOf(i) + xOf(i + 1)) / 2;
      ctx.fillStyle = th.accent;
      ctx.globalAlpha = 0.07;
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      ctx.globalAlpha = 1;
    });

    // Series.
    series.forEach(function (s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var started = false;
      var lastX = 0, lastY = 0;
      s.values.forEach(function (v, i) {
        if (v == null || !isFinite(v)) { started = false; return; }
        var x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
        lastX = x; lastY = y;
      });
      ctx.stroke();
      // Dots at I-frame resets for the primary series.
      if (s.dots) {
        s.values.forEach(function (v, i) {
          if (v == null || rows[i].type !== 0) return;
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(xOf(i), yOf(v), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });

    // Selected frame marker.
    if (state.frame < n) {
      var sx = xOf(state.frame);
      ctx.strokeStyle = th.ink2;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, padT);
      ctx.lineTo(Math.round(sx) + 0.5, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Hover crosshair.
    var hover = chartHover[opts.key];
    if (hover >= 0 && hover < n) {
      var hx = xOf(hover);
      ctx.strokeStyle = th.accent;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, padT);
      ctx.lineTo(Math.round(hx) + 0.5, padT + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      series.forEach(function (s) {
        var v = s.values[hover];
        if (v == null || !isFinite(v)) return;
        ctx.fillStyle = th.surface;
        ctx.beginPath(); ctx.arc(hx, yOf(v), 4.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(hx, yOf(v), 3, 0, Math.PI * 2); ctx.fill();
      });
    }
    opts.geom = { padL: padL, plotW: plotW, padT: padT, plotH: plotH, xOf: xOf, n: n };
  }

  function renderCharts() {
    buildChartData();
    var rows = chartData.rows;
    var th = chartTheme();
    var errCanvas = $('chart-err');
    var driftCanvas = $('chart-drift');

    var errSeries = [
      { name: '重建 MSE', color: th.rec, values: rows.map(function (r) { return r.recMse; }), dots: true },
      { name: '预测 MSE', color: th.pred, values: rows.map(function (r) { return r.predMse; }) },
    ];
    var hasOpenLoop = rows.some(function (r) { return r.openLoopMse != null; });
    if (hasOpenLoop) {
      errSeries.push({ name: '改用原始帧作参考', color: th.vec, values: rows.map(function (r) { return r.openLoopMse; }) });
    }
    $('leg-openloop').hidden = !hasOpenLoop;
    var driftSeries = [
      { name: 'GOP 内累积 MAE', color: th.rec, values: rows.map(function (r) { return r.cum; }), dots: true },
      { name: '本帧增量 MAE', color: th.pred, values: rows.map(function (r) { return r.mae; }) },
    ];
    var errOpts = { log: true, key: 'err' };
    var driftOpts = { log: false, key: 'drift' };
    drawChart(errCanvas, rows, errSeries, errOpts);
    drawChart(driftCanvas, rows, driftSeries, driftOpts);
    errCanvas._series = errSeries; errCanvas._opts = errOpts; errCanvas._rows = rows;
    driftCanvas._series = driftSeries; driftCanvas._opts = driftOpts; driftCanvas._rows = rows;
  }

  function attachChartHover(canvas, tipEl, bodyEl) {
    function move(ev) {
      if (!canvas._opts || !canvas._opts.geom) return;
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var gm = canvas._opts.geom;
      var rel = (x - gm.padL) / (gm.plotW || 1);
      var i = Math.round(rel * (gm.n - 1));
      i = clamp(i, 0, gm.n - 1);
      chartHover[canvas._opts.key] = i;
      drawChart(canvas, canvas._rows, canvas._series, canvas._opts);
      var row = canvas._rows[i];
      var html = '<div class="t">帧 ' + row.i + ' · ' + (row.type === 0 ? 'I' : (row.type === 1 ? 'P' : '缺失')) + '</div>';
      canvas._series.forEach(function (s) {
        var v = s.values[i];
        html += '<div class="row"><span><i style="background:' + s.color + '"></i>' + s.name + '</span><span>' +
          (v == null ? '—' : (v >= 100 ? v.toFixed(0) : v.toFixed(2))) + '</span></div>';
      });
      tipEl.innerHTML = html;
      tipEl.hidden = false;
      var left = gm.xOf(i);
      tipEl.style.left = clamp(left, 70, rect.width - 70) + 'px';
      tipEl.style.top = '12px';
    }
    function leave() {
      chartHover[canvas._opts ? canvas._opts.key : 'err'] = -1;
      tipEl.hidden = true;
      if (canvas._opts) drawChart(canvas, canvas._rows, canvas._series, canvas._opts);
    }
    bodyEl.addEventListener('pointermove', move);
    bodyEl.addEventListener('pointerleave', leave);
    bodyEl.addEventListener('pointerdown', function (ev) {
      if (!canvas._opts) return;
      var gm = canvas._opts.geom;
      var rect = canvas.getBoundingClientRect();
      var rel = (ev.clientX - rect.left - gm.padL) / (gm.plotW || 1);
      var i = clamp(Math.round(rel * (gm.n - 1)), 0, gm.n - 1);
      setFrame(i);
    });
  }

  /* ------------------------------------------------------------- diagnosis */

  function renderDiagnosis() {
    var h = header();
    var rows = chartData ? chartData.rows : [];
    if (!h || !rows.length) {
      $('d-i').textContent = '—'; $('d-psnr').textContent = '—'; $('d-drift').textContent = '—';
      $('d-i-note').textContent = ''; $('d-psnr-note').textContent = ''; $('d-drift-note').textContent = '';
      return;
    }
    var iCount = rows.filter(function (r) { return r.type === 0; }).length;
    var missing = rows.filter(function (r) { return r.missing; }).length;
    $('d-i').innerHTML = iCount + '<small>共 ' + rows.length + ' 帧' + (missing ? ' · ' + missing + ' 帧缺失' : '') + '</small>';
    $('d-i-note').textContent = '间隔 ' + h.keyInterval + ' · 每 ' + Math.ceil(rows.length / Math.max(1, iCount)) + ' 帧复位一次';

    var psnrs = rows.map(function (r) {
      if (r.recMse == null) return null;
      return r.recMse === 0 ? Infinity : 10 * Math.log10(65025 / r.recMse);
    }).filter(function (v) { return v != null; });
    var finite = psnrs.filter(isFinite);
    var avgP = psnrs.indexOf(Infinity) >= 0 && finite.length === 0 ? Infinity : (finite.length ? finite.reduce(function (a, b) { return a + b; }, 0) / finite.length : null);
    $('d-psnr').innerHTML = (avgP == null ? '—' : (isFinite(avgP) ? avgP.toFixed(2) + '<small>dB</small>' : '∞')) + '';
    $('d-psnr-note').textContent = finite.length ? '按 ' + finite.length + ' 帧非无损帧计算' : (psnrs.length ? '全部无损' : '无原始序列可比');

    var peak = 0, peakFrame = -1;
    rows.forEach(function (r) { if (r.cum != null && r.cum > peak) { peak = r.cum; peakFrame = r.i; } });
    $('d-drift').innerHTML = chartData.hasOrig ? peak.toFixed(1) + '<small>灰度级</small>' : '—';
    $('d-drift-note').textContent = peakFrame >= 0 ? '峰值出现在帧 ' + peakFrame + '（GOP 内累积 MAE）' : '无原始序列可比';

    // Partial-block analysis: error inside edge blocks vs interior blocks.
    var note = $('d-note-text');
    var partialW = h.width % 8 !== 0;
    var partialH = h.height % 8 !== 0;
    var stats = edgeBlockStats(h);
    var parts = [];
    if (partialW || partialH) {
      parts.push('<strong>' + h.width + '×' + h.height + ' 不是 8 的整块</strong>，编码栅格补到 ' + h.paddedWidth + '×' + h.paddedHeight +
        '，右/下边缘块由末列末行复制而来。');
      if (stats && stats.edgeMae != null && stats.innerMae != null && stats.edgeCount) {
        var bothZero = stats.edgeMae === 0 && stats.innerMae === 0;
        var ratio = stats.innerMae > 0 ? stats.edgeMae / stats.innerMae : null;
        if (bothZero) {
          parts.push('当前参数下所有块都无损，补边没有带来误差。');
        } else {
          parts.push('边缘块平均误差 ' + stats.edgeMae.toFixed(2) + ' 灰度级，内部块 ' + stats.innerMae.toFixed(2) +
            (ratio != null ? '（' + ratio.toFixed(2) + '×）' : '') + '。');
          if (ratio != null && ratio > 1.15) {
            parts.push('边缘块明显更差，逐帧看时优先检查补边样本有没有被参考进预测。');
          }
        }
      }
    } else {
      parts.push('尺寸 ' + h.width + '×' + h.height + ' 正好是 8 的整块，没有补边；编码栅格与画面完全对齐。');
    }
    var maxGop = 0;
    rows.forEach(function (r) { if (r.gop != null && r.gop > maxGop) maxGop = r.gop; });
    parts.push('当前 GOP 内最长连续 ' + (maxGop + 1) + ' 帧不回 I 帧；量化步长 ' + h.quantStep +
      '。把关键帧间隔调大或步长调粗，漂移会更明显。');

    var ol = openLoopSummary(rows);
    if (ol) {
      if (ol.verdict === 'tie') {
        parts.push('把参考换成原始帧后，P 帧误差与闭环完全相同（平均 PSNR ' + ol.closedAvg +
          ' dB），两种接法目前看不出差别——量化步长 ' + h.quantStep + ' 下这一步没有暴露参考帧接错。');
      } else if (ol.verdict === 'closed-better') {
        parts.push('<strong>闭环正常</strong>：把参考换成原始帧后，' + ol.worsePct.toFixed(0) +
          '% 的 P 帧误差反而变大（平均 PSNR ' + ol.openAvg + ' dB 对 ' + ol.closedAvg +
          ' dB），说明用解码帧作参考没有白白丢失质量——越编越偏来自量化误差累积，而不是参考帧接错。');
      } else {
        parts.push('<strong>参考帧可疑</strong>：把参考换成原始帧后，' + ol.betterPct.toFixed(0) +
          '% 的 P 帧误差变小（平均 PSNR ' + ol.openAvg + ' dB 对 ' + ol.closedAvg +
          ' dB）。闭环参考可能接错，先核对解码器是否用上一帧重建图做预测。');
      }
    }
    note.innerHTML = parts.join(' ');
  }

  function openLoopSummary(rows) {
    var pairs = [];
    rows.forEach(function (r) {
      if (r.type !== 1 || r.recMse == null || r.openLoopMse == null) return;
      pairs.push({ rec: r.recMse, open: r.openLoopMse });
    });
    if (!pairs.length) return null;
    var closedMse = 0, openMse = 0;
    var worse = 0, better = 0;
    pairs.forEach(function (p) {
      closedMse += p.rec;
      openMse += p.open;
      if (p.open > p.rec) worse++;
      else if (p.open < p.rec) better++;
    });
    function toPsnr(ms) { return ms === 0 ? Infinity : 10 * Math.log10(65025 / ms); }
    var recAvg = toPsnr(closedMse / pairs.length);
    var openAvg = toPsnr(openMse / pairs.length);
    if (worse === 0 && better === 0) {
      return { verdict: 'tie', closedAvg: isFinite(recAvg) ? recAvg.toFixed(2) : '∞', openAvg: isFinite(openAvg) ? openAvg.toFixed(2) : '∞' };
    }
    var total = worse + better;
    return {
      verdict: worse >= better ? 'closed-better' : 'reference-suspect',
      worsePct: (worse / pairs.length) * 100,
      betterPct: (better / pairs.length) * 100,
      closedAvg: isFinite(recAvg) ? recAvg.toFixed(2) : '∞',
      openAvg: isFinite(openAvg) ? openAvg.toFixed(2) : '∞',
      pairs: pairs.length,
    };
  }

  function edgeBlockStats(h) {
    if (!state.sequence || state.sequence.frames.length !== h.frameCount) return null;
    if (state.sequence.width !== h.width || state.sequence.height !== h.height) return null;
    var pw = h.paddedWidth, bw = pw / 8;
    var edgeSum = 0, edgeN = 0, innerSum = 0, innerN = 0, edgeCount = 0;
    for (var i = 0; i < frameCount(); i++) {
      var vf = viewFrame(i);
      if (!vf || !vf.orig || !vf.rec) continue;
      for (var by = 0; by < h.paddedHeight / 8; by++) {
        for (var bx = 0; bx < bw; bx++) {
          // A block is "edge" when its 8x8 footprint extends past the picture.
          var edge = (bx * 8 + 8 > h.width) || (by * 8 + 8 > h.height);
          if (edge) edgeCount++;
          var s = 0;
          for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
            var idx = (by * 8 + y) * pw + bx * 8 + x;
            s += Math.abs(vf.orig[idx] - vf.rec[idx]);
          }
          if (edge) { edgeSum += s / 64; edgeN++; }
          else { innerSum += s / 64; innerN++; }
        }
      }
    }
    return {
      edgeMae: edgeN ? edgeSum / edgeN : null,
      innerMae: innerN ? innerSum / innerN : null,
      edgeCount: edgeCount,
    };
  }

  /* -------------------------------------------------------------- bitstream */

  function renderBitstream() {
    var h = header();
    var stream = state.stream;
    var decoded = stream ? stream.decoded : null;
    var badge = $('bs-badge');
    var badgeText = $('bs-badge-text');
    var layout = $('layout-bar');
    layout.innerHTML = '';

    if (!h || !stream) {
      $('hdr-size').textContent = '—';
      $('hdr-frames').textContent = '—';
      $('hdr-key').textContent = '—';
      $('hdr-q').textContent = '—';
      $('hdr-bytes').textContent = '—';
      badge.className = 'badge';
      badgeText.textContent = '尚未编码';
      $('issues').innerHTML = '<div class="empty-note">暂无问题。</div>';
      return;
    }

    $('hdr-size').textContent = h.width + '×' + h.height + (h.paddedWidth !== h.width || h.paddedHeight !== h.height ? ' → ' + h.paddedWidth + '×' + h.paddedHeight : '');
    $('hdr-frames').textContent = String(h.frameCount);
    $('hdr-key').textContent = String(h.keyInterval);
    $('hdr-q').textContent = String(h.quantStep);
    $('hdr-bytes').textContent = stream.bytes.length + ' B (' + fmtBytes(stream.bytes.length) + ')';

    var errors = decoded.issues.filter(function (i) { return i.severity === 'error'; });
    var warns = decoded.issues.filter(function (i) { return i.severity !== 'error'; });
    var healthy = decoded.ok && errors.length === 0;
    badge.className = 'badge ' + (healthy ? '' : 'bad');
    badgeText.textContent = stream.external ? (healthy ? '外部码流 · 解码通过' : '外部码流 · ' + errors.length + ' 处问题')
      : (healthy ? '页面编码 · 解码通过' : '页面编码 · ' + errors.length + ' 处问题');
    if (state.stream.fault) badgeText.textContent += ' · ' + state.stream.fault;

    // Layout bar: header + one segment per frame.
    var total = stream.bytes.length || 1;
    var headSeg = el('div', 'layout-seg layout-head');
    headSeg.style.flex = '14 0 0';
    headSeg.title = '固定头 14 B';
    layout.appendChild(headSeg);
    var frameSegs = [];
    decoded.frames.forEach(function (f) {
      var len = Math.max(1, f.payloadEnd + 4 + 1 - f.frameStart);
      var seg = el('button', 'layout-seg' + (f.type === 0 ? ' i' : ''));
      seg.type = 'button';
      seg.style.flex = len + ' 0 0';
      seg.title = '帧 ' + f.index + ' · ' + (f.type === 0 ? 'I' : 'P') + ' · ' + len + ' B' + (f.incomplete ? ' · 不完整' : '');
      seg.dataset.frame = String(f.index);
      if (f.index === state.frame) seg.setAttribute('aria-current', 'true');
      layout.appendChild(seg);
      frameSegs.push(seg);
    });
    // Segments for frames the decoder never reached.
    for (var i = decoded.frames.length; i < h.frameCount; i++) {
      var seg2 = el('div', 'layout-seg');
      seg2.style.flex = '1 0 0';
      seg2.title = '帧 ' + i + '（未能解码）';
      seg2.style.background = 'repeating-linear-gradient(135deg, var(--crit-soft) 0 3px, var(--surface) 3px 6px)';
      layout.appendChild(seg2);
    }
    // Issue offsets.
    decoded.issues.forEach(function (it) {
      if (it.offset == null) return;
      var mk = el('div', 'layout-marker');
      mk.style.left = clamp((it.offset / total) * 100, 0, 100) + '%';
      mk.title = it.message;
      layout.appendChild(mk);
    });

    // Verify line.
    var vl = $('verify-line');
    var vt = $('verify-text');
    var cc = stream.crossCheck;
    if (!healthy) {
      vl.className = 'verify-line bad';
      vt.innerHTML = '解码报告 <strong>' + errors.length + '</strong> 处错误' + (warns.length ? '、' + warns.length + ' 处提示' : '') +
        '；共解出 ' + decoded.frames.length + ' / ' + h.frameCount + ' 帧，消费 ' + decoded.consumed + ' / ' + stream.bytes.length + ' 字节。';
    } else if (cc) {
      if (cc.mismatches === 0 && cc.frames === cc.encoded) {
        vl.className = 'verify-line';
        vt.innerHTML = '已从字节流独立解码 <strong>' + cc.frames + '</strong> 帧，重建与编码器逐像素一致（0 处差异）。';
      } else {
        vl.className = 'verify-line bad';
        vt.innerHTML = '独立解码与编码器重建不一致：' + cc.mismatches + ' 个像素，首帧 ' + cc.firstFrame + '。';
      }
    } else {
      vl.className = 'verify-line';
      vt.innerHTML = stream.external
        ? '已从文件独立解码 <strong>' + decoded.frames.length + '</strong> 帧（未使用编码器状态）。'
        : '已解码 ' + decoded.frames.length + ' 帧。';
    }

    renderIssues(decoded, stream);
  }

  function renderIssues(decoded, stream) {
    var box = $('issues');
    box.innerHTML = '';
    if (!decoded.issues.length) {
      box.innerHTML = '<div class="empty-note">没有解码问题。' + (decoded.ok ? '文件完整、块合法。' : '') + '</div>';
      return;
    }
    decoded.issues.forEach(function (it) {
      var card = el('div', 'issue' + (it.severity === 'error' ? '' : ' ' + it.severity));
      var head = el('div', 'issue-head');
      head.appendChild(el('span', 'issue-kind', it.kind));
      if (it.offset != null) head.appendChild(el('span', 'issue-offset', '偏移 ' + it.offset + ' · ' + hex(it.offset, 4)));
      if (it.frame != null) {
        var chip = el('span', 'chip ' + (it.frame % (decoded.header ? decoded.header.keyInterval : 1) === 0 ? 'chip-i' : 'chip-p'), String(it.frame));
        chip.title = '帧 ' + it.frame;
        head.appendChild(chip);
      }
      if (it.block != null) head.appendChild(el('span', 'issue-offset', '块 ' + it.block + (it.bx != null ? ' (' + it.bx + ',' + it.by + ')' : '')));
      if (it.coef != null) head.appendChild(el('span', 'issue-offset', '系数 ' + it.coef));
      if (it.frame != null) {
        var go = el('button', 'btn btn-sm', '跳到该帧');
        go.type = 'button';
        go.addEventListener('click', function () {
          setFrame(clamp(it.frame, 0, frameCount() - 1));
          if (it.block != null) { state.block = clamp(it.block, 0, (viewFrame(state.frame) || { blocks: [] }).blocks.length - 1); renderView(); renderInspector(); }
        });
        head.appendChild(go);
      }
      card.appendChild(head);
      card.appendChild(el('div', 'issue-msg', it.message));
      if (it.offset != null) {
        card.appendChild(hexContext(stream.bytes, it.offset));
      }
      box.appendChild(card);
    });
  }

  function hexContext(bytes, offset) {
    var row = el('div', 'hexctx');
    row.appendChild(el('span', 'addr', '@' + offset));
    var start = Math.max(0, offset - 6);
    var end = Math.min(bytes.length, offset + 7);
    if (start === 0 && offset > 0) row.appendChild(el('span', 'b', '…'));
    for (var i = start; i < end; i++) {
      var b = el('span', 'b' + (i === offset ? ' hit' : ''), hex(bytes[i]));
      if (i === offset) b.title = '问题位置';
      row.appendChild(b);
    }
    if (end < bytes.length) row.appendChild(el('span', 'b', '…'));
    return row;
  }

  /* ------------------------------------------------------------ fault tools */

  function currentBytes() {
    return state.stream ? state.stream.bytes : null;
  }

  function applyFault(kind) {
    var base = state.goodBytes;
    var h = header();
    if (!base || !h) { toast('先编码或打开一个码流。', true); return; }
    var bytes = Uint8Array.from(base);
    var faultLabel = '';
    var at = null;
    var frameStarts = [];
    var pos = M.HEADER_BYTES;
    for (var i = 0; i < h.frameCount; i++) {
      if (pos + 5 > bytes.length) break;
      var plen = M.readU32(bytes, pos + 1);
      frameStarts.push({ start: pos, payload: pos + 5, len: plen, type: bytes[pos] });
      pos += 5 + plen;
    }
    var pFrames = frameStarts.filter(function (f) { return f.type === 1; });
    var target = pFrames.length ? pFrames[Math.min(1, pFrames.length - 1)] : frameStarts[frameStarts.length - 1];
    switch (kind) {
      case 'truncate-mid': {
        if (!target) break;
        var cut = target.payload + Math.floor(target.len / 2);
        bytes = bytes.subarray(0, cut);
        faultLabel = '截断帧载荷';
        at = cut;
        break;
      }
      case 'truncate-tail': {
        var cut2 = Math.max(M.HEADER_BYTES, bytes.length - 9);
        bytes = bytes.subarray(0, cut2);
        faultLabel = '截断文件尾';
        at = cut2;
        break;
      }
      case 'bad-vector': {
        if (!target) break;
        bytes[target.payload] = 0x7b;      // dx = 123, outside ±8
        faultLabel = '非法运动矢量';
        at = target.payload;
        break;
      }
      case 'bad-run': {
        if (!target) break;
        bytes[target.payload + 2] = 0xd0;  // zero-run 208 on a 64-coefficient block
        faultLabel = '越界零游程';
        at = target.payload + 2;
        break;
      }
      case 'bad-magic': {
        bytes[0] = 0x58;
        faultLabel = '破坏标识';
        at = 0;
        break;
      }
      case 'trailing': {
        var extra = new Uint8Array(bytes.length + 6);
        extra.set(bytes);
        extra.set([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01], bytes.length);
        bytes = extra;
        faultLabel = '尾部多余字节';
        at = base.length;
        break;
      }
    }
    if (!faultLabel) { toast('无法注入这种故障（缺少可用的 P 帧）。', true); return; }
    setStream(bytes, '故障注入 · ' + faultLabel, { external: !state.encode, fault: faultLabel });
    if (state.frame >= frameCount()) state.frame = Math.max(0, frameCount() - 1);
    updateAll();
    var errs = state.stream.decoded.issues.filter(function (x) { return x.severity === 'error'; });
    if (errs.length) {
      toast(faultLabel + '：' + errs[0].message, true);
    }
  }

  /* ---------------------------------------------------------------- actions */

  var encodeTimer = null;
  function scheduleEncode() {
    state.dirty = true;
    $('encode-state').textContent = '参数已改，准备重编';
    clearTimeout(encodeTimer);
    encodeTimer = setTimeout(function () { encode(); }, 280);
  }

  function setFrame(i) {
    var n = frameCount();
    if (!n) return;
    state.frame = clamp(i, 0, n - 1);
    var vf = viewFrame(state.frame);
    if (vf && vf.blocks.length) state.block = clamp(state.block, 0, vf.blocks.length - 1);
    renderTimeline();
    renderView();
    renderInspector();
    renderStatus();
    renderBitstream();
    renderCharts();
    renderDiagnosis();
  }

  function download(bytes, name) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  function exportStream() {
    if (state.stream) {
      var base = state.sequence ? state.sequence.name : 'stream';
      var name = state.stream.external ? (state.stream.label || 'stream') : (base + '_ki' + state.params.keyInterval + '_q' + state.params.quantStep + '.mvr1');
      if (!/\.mvr1$/i.test(name)) name = name.replace(/[^\w.\-一-龥]+/g, '_') + '.mvr1';
      download(state.stream.bytes, name);
      toast('已导出 ' + name + '（' + state.stream.bytes.length + ' 字节）');
    } else {
      toast('还没有可导出的码流。', true);
    }
  }

  function readFiles(fileList, handler) {
    var files = Array.prototype.slice.call(fileList);
    Promise.all(files.map(function (f) {
      return f.arrayBuffer().then(function (buf) { return { name: f.name, buffer: new Uint8Array(buf) }; });
    })).then(handler).catch(function (e) { toast('读取文件失败：' + e.message, true); });
  }

  function importSequence(files) {
    readFiles(files, function (entries) {
      try {
        var seq = M.buildSequence(entries, '导入序列');
        setSequence(seq, true);
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  function importStream(files) {
    readFiles(files, function (entries) {
      if (!entries.length) return;
      openStream(entries[0].buffer, entries[0].name);
    });
  }

  /* --------------------------------------------------------------- startup */

  function bind() {
    $('sel-seq').addEventListener('change', function (e) {
      if (e.target.value === '__custom') return;
      var seq = sampleToSequence(e.target.value);
      if (seq) setSequence(seq, false);
    });

    ['in-key', 'in-q'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        if (id === 'in-key') $('in-key-range').value = $(id).value;
        if (id === 'in-q') $('in-q-range').value = String(Math.min(Number($(id).value) || 1, 64));
        updateParamNotes();
      });
      $(id).addEventListener('change', scheduleEncode);
    });
    $('in-key-range').addEventListener('input', function (e) { $('in-key').value = e.target.value; updateParamNotes(); });
    $('in-key-range').addEventListener('change', scheduleEncode);
    $('in-q-range').addEventListener('input', function (e) { $('in-q').value = e.target.value; updateParamNotes(); });
    $('in-q-range').addEventListener('change', scheduleEncode);

    $('btn-encode').addEventListener('click', function () { encode({ force: true }); });
    $('btn-export').addEventListener('click', exportStream);

    $('btn-import-seq').addEventListener('click', function () { $('seq-input').click(); });
    $('btn-import-stream').addEventListener('click', function () { $('stream-input').click(); });
    $('seq-input').addEventListener('change', function (e) { if (e.target.files.length) importSequence(e.target.files); e.target.value = ''; });
    $('stream-input').addEventListener('change', function (e) { if (e.target.files.length) importStream(e.target.files); e.target.value = ''; });

    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.dataset.view;
        document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        renderView();
      });
    });
    $('tg-blocks').addEventListener('click', function () {
      state.showBlocks = !state.showBlocks;
      this.setAttribute('aria-pressed', String(state.showBlocks));
      renderView();
    });
    $('tg-vectors').addEventListener('click', function () {
      state.showVectors = !state.showVectors;
      this.setAttribute('aria-pressed', String(state.showVectors));
      renderView();
    });
    $('tg-padding').addEventListener('click', function () {
      state.showPadding = !state.showPadding;
      this.setAttribute('aria-pressed', String(state.showPadding));
      renderView();
      renderInspector();
      renderStatus();
    });

    $('ticks').addEventListener('click', function (e) {
      var t = e.target.closest('.tick');
      if (t) setFrame(Number(t.dataset.frame));
    });
    $('frame-range').addEventListener('input', function (e) { setFrame(Number(e.target.value)); });
    $('btn-prev').addEventListener('click', function () { setFrame(state.frame - 1); });
    $('btn-next').addEventListener('click', function () { setFrame(state.frame + 1); });

    $('layout-bar').addEventListener('click', function (e) {
      var seg = e.target.closest('.layout-seg');
      if (seg && seg.dataset.frame != null) setFrame(Number(seg.dataset.frame));
    });

    $('btn-verify').addEventListener('click', function () {
      if (!state.stream) { toast('先编码或打开一个码流。', true); return; }
      setStream(state.stream.bytes, state.stream.label, { external: state.stream.external });
      updateAll();
      var d = state.stream.decoded;
      toast(d.ok ? '独立解码通过：' + d.frames.length + ' 帧，' + d.consumed + ' / ' + d.bytes + ' 字节' : '解码发现问题，见「解码问题」。', !d.ok);
    });

    $('btn-restore').addEventListener('click', function () {
      if (!state.goodBytes) { toast('没有可恢复的码流。', true); return; }
      setStream(state.goodBytes, state.encode ? '页面编码' : '外部码流', { external: !state.encode });
      updateAll();
      toast('已恢复正确码流。');
    });

    document.querySelectorAll('[data-fault]').forEach(function (btn) {
      btn.addEventListener('click', function () { applyFault(btn.dataset.fault); });
    });

    $('btn-demo').addEventListener('click', function () {
      var name = sampleNames().indexOf('shift') >= 0 ? 'shift' : sampleNames()[0];
      if (!name) return;
      var seq = sampleToSequence(name);
      $('in-key').value = String(Math.min(12, seq.frames.length));
      $('in-q').value = '12';
      setSequence(seq, false);
      state.view = 'err';
      document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === 'err')); });
      state.showPadding = true;
      $('tg-padding').setAttribute('aria-pressed', 'true');
      setTimeout(function () {
        var vf = viewFrame(state.frame);
        if (vf && vf.blocks.length) {
          state.block = vf.blocks.length - 1;
          renderView(); renderInspector(); renderStatus();
        }
        toast('演示：量化步长 12、关键帧间隔 12。切到「误差」并显示补边，看右下角非整块边缘的残差。');
      }, 60);
    });

    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setFrame(state.frame - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setFrame(state.frame + 1); }
    });

    window.addEventListener('resize', function () {
      clearTimeout(bind._rt);
      bind._rt = setTimeout(function () { renderView(); renderCharts(); }, 140);
    });

    attachChartHover($('chart-err'), $('tip-err'), $('chart-err-body'));
    attachChartHover($('chart-drift'), $('tip-drift'), $('chart-drift-body'));

    // Theme changes swap CSS tokens; charts draw from them.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onTheme = function () { renderCharts(); };
      if (mq.addEventListener) mq.addEventListener('change', onTheme);
      else if (mq.addListener) mq.addListener(onTheme);
    }
  }

  function start() {
    populateSequenceSelect();
    bind();
    $('encode-state').textContent = '就绪';
    var first = sampleNames().indexOf('shift') >= 0 ? 'shift' : sampleNames()[0];
    if (first) {
      var seq = sampleToSequence(first);
      $('in-key').value = '6';
      $('in-q').value = '8';
      setSequence(seq, false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
