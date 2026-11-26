/* PDQ1 reel UI. Pure vanilla JS. Talks only to PDQEngine / PDQWav / PDQAudio. */
(function () {
  'use strict';
  var E = window.PDQEngine, W = window.PDQWav;
  var $ = function (id) { return document.getElementById(id); };
  var nextFrame = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  var CH_COLORS = ['#338ced', '#e76624', '#00a888', '#d28e05', '#9887ef', '#eb6263', '#4cc9f0', '#b8f24a'];
  var PAGE_RECORDS = 50;

  var state = {
    result: null,
    view: { f0: 0, f1: 1 },
    selection: null,
    inspect: { ch: 0, frame: 0, tick: null },
    hoverFrame: null,
    recPage: 0,
    recFilter: 'all',
    lanes: [],
    player: null,
    startedAt: 0
  };

  // ---------------------------------------------------------------- utils
  function fmtInt(n) { return (n | 0).toLocaleString('en-US'); }
  function hex(n) { return '0x' + (n >>> 0).toString(16); }
  function fmtSec(s) {
    if (!isFinite(s)) s = 0;
    var m = Math.floor(s / 60), ss = s - m * 60;
    return String(m).padStart(2, '0') + ':' + ss.toFixed(2).padStart(5, '0');
  }
  function fmtDur(seconds) {
    if (seconds >= 1) return seconds.toFixed(2) + ' s';
    return (seconds * 1000).toFixed(2) + ' ms';
  }
  function fmtTimeShort(sec) {
    if (sec <= 0) return '0';
    if (sec < 0.001) return (sec * 1e6).toFixed(0) + 'µs';
    if (sec < 1) return (sec * 1000).toFixed(2) + 'ms';
    return sec.toFixed(3) + 's';
  }
  function channelColor(c) { return CH_COLORS[c % CH_COLORS.length]; }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  function downloadBuffer(buf, filename, mime) { downloadBlob(new Blob([buf], { type: mime || 'application/octet-stream' }), filename); }
  function downloadText(text, filename, mime) { downloadBlob(new Blob([text], { type: mime || 'application/json' }), filename); }

  function setButtonsDisabled(sel) {
    ['play-sel', 'export-wav-sel', 'export-json-sel', 'clear-sel'].forEach(function (id) {
      $(id).disabled = !sel;
    });
  }

  // ---------------------------------------------------------------- file flow
  function handleFile(file) {
    if (!file) return;
    state.startedAt = performance.now();
    file.arrayBuffer().then(function (ab) { return processBuffer(file.name, ab); })
      .catch(function (err) { showFatal('读取文件失败：' + (err && err.message || err)); });
  }

  function showFatal(msg) {
    $('fatal-text').textContent = msg;
    $('fatal-banner').classList.remove('hidden');
    $('progress').classList.add('hidden');
    $('workspace').classList.add('hidden');
  }

  function setProgress(msg) { $('progress-text').textContent = msg; }

  async function processBuffer(name, buffer) {
    $('fatal-banner').classList.add('hidden');
    $('dropzone').classList.add('hidden');
    $('workspace').classList.add('hidden');
    $('progress').classList.remove('hidden');
    setProgress('校验 CRC 并解析分包 / 回绕…');
    await nextFrame();

    var parsed;
    try { parsed = E.parsePDQ(buffer); }
    catch (err) { console.error(err); showFatal('解析时发生异常：' + (err && err.message || err)); return; }

    if (parsed.headerError) {
      var extra = parsed.truncated ? '（记录偏移 ' + parsed.truncated.offset + ' / 第 ' + parsed.truncated.recordIndex + ' 条）' : '';
      showFatal(parsed.headerError + extra);
      return;
    }
    if (!parsed.headerOk) {
      showFatal('文件头参数不被支持：' + (parsed.headerProblems || []).join('；'));
      return;
    }

    var C = parsed.channels, D = parsed.D, F = parsed.totalTicks / D;
    var channelData = [];
    try {
      for (var c = 0; c < C; c++) {
        setProgress('重建逐路位流并做三阶抽取：声道 ' + (c + 1) + ' / ' + C + ' …');
        await nextFrame();
        var grid = E.buildChannelGrid(parsed, c);
        var dec = E.decimateGrid(grid, parsed.anchor, D);
        channelData.push({
          index: c, pcm: dec.pcm, affected: dec.affected,
          intervals: E.intervalsFromFlags(dec.affected)
        });
        grid = null;
      }

      setProgress('交织 48 kHz PCM16…');
      await nextFrame();
    } catch (err) {
      console.error(err);
      showFatal('重建 / 抽取失败（totalTicks=' + parsed.totalTicks + ' 可能过大或内存不足）：' + (err && err.message || err));
      return;
    }
    var interleaved = new Int16Array(F * C);
    for (var f = 0; f < F; f++) {
      var base = f * C;
      for (var cc = 0; cc < C; cc++) interleaved[base + cc] = channelData[cc].pcm[f];
    }

    var ms = performance.now() - state.startedAt;
    var result = {
      ok: true, fileName: name, parsed: parsed, bytes: parsed.bytes,
      anchor: parsed.anchor, totalTicks: parsed.totalTicks, channels: C, D: D,
      sampleRate: 48000, frameRate: 48000, frames: F,
      channelData: channelData, interleaved: interleaved,
      processMs: ms
    };
    state.result = result;
    state.view = { f0: 0, f1: F };
    state.selection = null;
    state.inspect = { ch: 0, frame: 0, tick: null };
    state.hoverFrame = null;
    state.recPage = 0;
    state.recFilter = 'all';

    $('progress').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    renderAll();
    $('perf-time').textContent = (ms / 1000).toFixed(2) + ' s';
    window.__PDQ_LAST_MS__ = ms;
  }

  function renderAll() {
    renderKpis();
    renderAlerts();
    buildLanes();
    renderIntervals();
    renderRecords();
    renderInspector(true);
    refreshJsonPreview();
    syncSelectionInputs();
    setButtonsDisabled(null);
    $('sel-start').max = state.result.frames; $('sel-end').max = state.result.frames;
    buildInspectChannelOptions();
  }

  // ---------------------------------------------------------------- KPIs / alerts
  function renderKpis() {
    var r = state.result, p = r.parsed;
    $('kpi-bitrate').textContent = (48000 * r.channels * 16 / 1e6).toFixed(2) + ' Mbit/s 交织';
    $('kpi-channels').textContent = r.channels;
    $('kpi-d').textContent = r.D;
    $('kpi-pdmrate').textContent = 'PDM tick ' + (48000 * r.D / 1e6).toFixed(3) + ' MHz';
    $('kpi-ticks').textContent = fmtInt(r.totalTicks);
    $('kpi-anchor').textContent = '首时标 ' + fmtInt(r.anchor) + ' · ' + hex(r.anchor);
    $('kpi-frames').textContent = fmtInt(r.frames);
    $('kpi-duration').textContent = fmtDur(r.frames / 48000) + '（输出 48 kHz）';

    var recs = p.records;
    var bad = recs.filter(function (x) { return !x.crcOk; }).length;
    var rejected = recs.filter(function (x) { return x.crcOk && !x.legal; }).length;
    var adopted = recs.filter(function (x) { return x.adopted; }).length;
    $('kpi-rec-total').textContent = fmtInt(recs.length);
    $('kpi-rec-detail').textContent = '采用 ' + fmtInt(adopted) + ' · 坏CRC ' + bad + ' · 未采用 ' + rejected;

    var tc = $('kpi-trunc-card'), kt = $('kpi-trunc'), ks = $('kpi-trunc-sub');
    if (p.truncated) {
      tc.classList.add('trunc-warn'); tc.classList.remove('trunc-ok');
      kt.textContent = '第 ' + p.truncated.recordIndex + ' 条';
      ks.textContent = '偏移 ' + p.truncated.offset + ' (' + hex(p.truncated.offset) + ') · 保留可计算结果';
    } else {
      tc.classList.remove('trunc-warn'); tc.classList.add('trunc-ok');
      kt.textContent = '无'; ks.textContent = p.trailingBytes ? ('尾部 ' + p.trailingBytes + ' 字节') : '所有记录完整';
    }
  }

  function renderAlerts() {
    var p = state.result.parsed, root = $('alerts');
    root.innerHTML = '';
    if (p.truncated) {
      var t = p.truncated;
      var div = document.createElement('div');
      div.className = 'alert alert-trunc';
      div.id = 'trunc-banner';
      div.setAttribute('data-offset', t.offset);
      div.setAttribute('data-record-index', t.recordIndex);
      div.innerHTML =
        '<div>' +
        '<div class="alert-title">末尾截断：定位到记录偏移 <span class="offset-big" id="trunc-offset">' + t.offset +
        '</span> 字节（<code>' + hex(t.offset) + '</code>），记录序号 <strong id="trunc-index">' + t.recordIndex + '</strong></div>' +
        '<div>阶段 <code>' + t.stage + '</code>；该记录声明需要 ' + t.need + ' 字节，实际剩余 ' + t.have +
        ' 字节。已保留此前全部完整且 CRC 合格的记录，PCM / 区间仍可计算，尾部缺位按绝对相位补位并标记受影响。</div>' +
        '</div>';
      root.appendChild(div);
    }
    var structural = p.records.filter(function (x) { return x.crcOk && !x.legal; });
    if (structural.length) {
      var d2 = document.createElement('div');
      d2.className = 'alert alert-error';
      d2.innerHTML = '<div><div class="alert-title">' + structural.length + ' 条记录结构越界 / 非法，未采用（仍按声明长度跳过分包）</div>' +
        structural.slice(0, 5).map(function (x) {
          return '<div>#' + x.index + ' @<code>' + x.offset + '</code>：' + x.errors.join('；') + '</div>';
        }).join('') + '</div>';
      root.appendChild(d2);
    }
  }

  // ---------------------------------------------------------------- lanes
  function buildLanes() {
    var r = state.result, host = $('lanes');
    host.innerHTML = '';
    state.lanes = [];
    for (var c = 0; c < r.channels; c++) {
      var lane = { ch: c, env: null, cssW: 0, cssH: 104 };
      var el = document.createElement('div');
      el.className = 'lane';
      el.innerHTML =
        '<div class="lane-label">' +
        '  <div class="lane-name"><span class="lane-dot" style="background:' + channelColor(c) + '"></span>声道 ' + c + '</div>' +
        '  <div class="lane-meta">' + r.D + '× · ' + fmtInt(r.frames) + ' 帧</div>' +
        '  <div class="lane-meta" id="lane-aff-' + c + '"></div>' +
        '</div>' +
        '<div class="lane-canvas-wrap"><canvas class="wave"></canvas></div>';
      host.appendChild(el);
      lane.canvas = el.querySelector('canvas.wave');
      lane.wrap = el.querySelector('.lane-canvas-wrap');
      state.lanes.push(lane);
      attachLanePointer(lane);

      var affN = r.channelData[c].intervals.reduce(function (a, iv) { return a + (iv[1] - iv[0]); }, 0);
      $('lane-aff-' + c).textContent = '受影响 ' + fmtInt(affN) + ' 帧';
    }
    requestAnimationFrame(function () { resizeAllCanvases(true); });
  }

  function resizeCanvasToDisplay(canvas, h) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function resizeAllCanvases(recompute) {
    for (var i = 0; i < state.lanes.length; i++) {
      var lane = state.lanes[i];
      var m = resizeCanvasToDisplay(lane.canvas, lane.cssH);
      lane.cssW = m.w; lane.ctx = m.ctx;
      if (recompute) computeEnvelope(lane);
      paintLane(lane);
    }
    resizeAxis();
  }

  function computeEnvelope(lane) {
    var r = state.result, cd = r.channelData[lane.ch], pcm = cd.pcm, aff = cd.affected, F = r.frames;
    var W = Math.max(1, Math.floor(lane.cssW));
    var v0 = state.view.f0, v1 = state.view.f1, span = Math.max(1e-9, v1 - v0);
    var mins = new Float32Array(W), maxs = new Float32Array(W), acol = new Float32Array(W);
    for (var x = 0; x < W; x++) {
      var a = Math.floor(v0 + (x / W) * span);
      var b = Math.max(a + 1, Math.floor(v0 + ((x + 1) / W) * span));
      var i0 = Math.max(0, Math.min(F - 1, a));
      var i1 = Math.max(i0 + 1, Math.min(F, b));
      var mn = 32767, mx = -32768, an = 0;
      for (var f = i0; f < i1; f++) {
        var v = pcm[f];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        if (aff[f]) an++;
      }
      mins[x] = mn; maxs[x] = mx; acol[x] = an / (i1 - i0);
    }
    lane.env = { mins: mins, maxs: maxs, acol: acol };
  }

  function frameToX(f, W) {
    var v0 = state.view.f0, span = state.view.f1 - state.view.f0;
    return ((f - v0) / span) * W;
  }
  function xToFrame(x, W) {
    var v0 = state.view.f0, span = state.view.f1 - state.view.f0;
    return v0 + (x / W) * span;
  }

  function tickStepFrames() {
    var span = state.view.f1 - state.view.f0, W = state.lanes[0] ? state.lanes[0].cssW : 1000;
    var target = Math.max(4, W / 110);
    var raw = span / target; // frames per tick desired
    var secSteps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    var frameSteps = secSteps.map(function (s) { return s * 48000; });
    for (var i = 0; i < frameSteps.length; i++) if (frameSteps[i] >= raw) return frameSteps[i];
    return Math.pow(10, Math.ceil(Math.log10(raw)));
  }

  function paintLane(lane) {
    if (!lane.ctx) return;
    var ctx = lane.ctx, W = lane.cssW, H = lane.cssH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#191919'; ctx.fillRect(0, 0, W, H);
    if (!lane.env) return;

    var step = tickStepFrames();
    var v0 = state.view.f0, v1 = state.view.f1;
    // vertical grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    var firstTick = Math.ceil(v0 / step) * step;
    for (var ft = firstTick; ft <= v1; ft += step) {
      var gx = Math.round(frameToX(ft, W)) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx, 14); ctx.lineTo(gx, H); ctx.stroke();
    }

    // affected rail + subtle band
    var env = lane.env;
    for (var x = 0; x < W; x++) {
      if (env.acol[x] > 0) {
        ctx.fillStyle = 'rgba(220,60,61,' + (0.35 + 0.55 * env.acol[x]).toFixed(3) + ')';
        ctx.fillRect(x, 3, 1, 8);
        ctx.fillStyle = 'rgba(220,60,61,0.05)';
        ctx.fillRect(x, 16, 1, H - 18);
      }
    }

    // zero line
    var mid = 16 + (H - 20) / 2;
    ctx.strokeStyle = '#474747'; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(W, mid + 0.5); ctx.stroke();

    // waveform min/max
    var amp = (H - 22) / 2 / 32768;
    ctx.fillStyle = channelColor(lane.ch);
    for (var xx = 0; xx < W; xx++) {
      var y1 = mid - env.maxs[xx] * amp;
      var y2 = mid - env.mins[xx] * amp;
      if (y2 - y1 < 1) y2 = y1 + 1;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(xx, y1, 1, y2 - y1);
    }
    ctx.globalAlpha = 1;

    // When zoomed in to a few frames per pixel or less, connect the exact
    // samples with a discrete step curve so individual PCM levels read clearly.
    var framesPerPixel = (state.view.f1 - state.view.f0) / W;
    if (framesPerPixel <= 3) {
      var pcm = state.result.channelData[lane.ch].pcm, F = state.result.frames;
      var fi0 = Math.max(0, Math.floor(state.view.f0));
      var fi1 = Math.min(F - 1, Math.ceil(state.view.f1));
      ctx.strokeStyle = channelColor(lane.ch); ctx.lineWidth = 2; ctx.globalAlpha = 0.95;
      ctx.beginPath();
      for (var fi = fi0; fi <= fi1; fi++) {
        var xa = frameToX(fi, W), xb = frameToX(fi + 1, W);
        var ya = mid - pcm[fi] * amp;
        if (fi === fi0) ctx.moveTo(xa, ya);
        ctx.lineTo(xb, ya);
        if (fi + 1 < F) { var ynext = mid - pcm[fi + 1] * amp; ctx.lineTo(xb, ynext); }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
      if (framesPerPixel <= 0.25) {
        ctx.fillStyle = '#eaf4ff';
        for (var fd = fi0; fd <= fi1; fd++) {
          ctx.beginPath(); ctx.arc(frameToX(fd + 0.5, W), mid - pcm[fd] * amp, 2.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // selection
    if (state.selection) {
      var sx0 = frameToX(state.selection.f0, W), sx1 = frameToX(state.selection.f1, W);
      ctx.fillStyle = 'rgba(124,192,255,0.16)';
      ctx.fillRect(sx0, 0, sx1 - sx0, H);
      ctx.strokeStyle = '#7cc0ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx0, 0); ctx.lineTo(sx0, H); ctx.moveTo(sx1, 0); ctx.lineTo(sx1, H); ctx.stroke();
    }

    // hover crosshair
    if (state.hoverFrame != null) {
      var hx = frameToX(state.hoverFrame, W);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke(); ctx.setLineDash([]);
    }

    // inspected frame marker
    if (state.inspect && state.inspect.ch === lane.ch) {
      var ix = frameToX(state.inspect.frame, W);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ix, 0); ctx.lineTo(ix, H); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(ix - 5, 0); ctx.lineTo(ix + 5, 0); ctx.lineTo(ix, 6); ctx.closePath(); ctx.fill();
    }
  }

  function resizeAxis() {
    var canvas = $('axis');
    if (!canvas || !state.lanes.length) return;
    var dpr = window.devicePixelRatio || 1;
    var wrap = canvas.parentElement;
    var w = wrap.clientWidth;
    canvas.style.width = w + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = 26 * dpr;
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, 26);
    var step = tickStepFrames();
    var v0 = state.view.f0, v1 = state.view.f1;
    ctx.fillStyle = '#9c9c9c'; ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    ctx.strokeStyle = '#474747';
    var firstTick = Math.ceil(v0 / step) * step;
    for (var ft = firstTick; ft <= v1; ft += step) {
      var x = Math.round(frameToX(ft, w)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 5); ctx.stroke();
      var sec = ft / 48000;
      var label = (step < 48000) ? sec.toFixed(2) + 's' : (step === 48000 ? sec.toFixed(0) + 's' : fmtSec(sec));
      ctx.fillText(label, x + 4, 17);
    }
  }
  function paintAll() { for (var i = 0; i < state.lanes.length; i++) paintLane(state.lanes[i]); resizeAxis(); }
  function updateView(recompute) {
    if (recompute) for (var i = 0; i < state.lanes.length; i++) computeEnvelope(state.lanes[i]);
    paintAll();
  }

  // ---------------------------------------------------------------- pointer
  function attachLanePointer(lane) {
    var canvas = lane.canvas, drag = null;
    function posX(e) { var rc = canvas.getBoundingClientRect(); return e.clientX - rc.left; }
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      var W = lane.cssW || canvas.clientWidth, x = posX(e);
      drag = { x0: x, x1: x, moved: false, pointerId: e.pointerId };
    });
    canvas.addEventListener('pointermove', function (e) {
      var W = lane.cssW || canvas.clientWidth, x = posX(e);
      var fr = Math.max(0, Math.min(state.result.frames - 1, Math.round(xToFrame(x, W))));
      state.hoverFrame = fr;
      if (drag) {
        drag.x1 = x;
        if (Math.abs(x - drag.x0) > 4) drag.moved = true;
        if (drag.moved) {
          var a = Math.floor(xToFrame(Math.min(drag.x0, drag.x1), W));
          var b = Math.ceil(xToFrame(Math.max(drag.x0, drag.x1), W));
          a = Math.max(0, Math.min(state.result.frames - 1, a));
          b = Math.max(a + 1, Math.min(state.result.frames, b));
          state.selection = { f0: a, f1: b };
          syncSelectionInputs(); setButtonsDisabled(state.selection);
        }
      }
      paintAll();
    });
    function endDrag(e) {
      if (!drag) return;
      var W = lane.cssW || canvas.clientWidth;
      if (!drag.moved) {
        var x = posX(e);
        var f = Math.max(0, Math.min(state.result.frames - 1, Math.round(xToFrame(x, W))));
        state.inspect.ch = lane.ch; state.inspect.frame = f; state.inspect.tick = null;
        $('inspect-channel').value = String(lane.ch);
        $('inspect-frame').value = String(f);
        renderInspector(false);
      } else if (state.selection) {
        // keep selection; inspect its first frame on this channel
        state.inspect.ch = lane.ch; state.inspect.frame = state.selection.f0; state.inspect.tick = null;
        $('inspect-channel').value = String(lane.ch);
        $('inspect-frame').value = String(state.selection.f0);
        renderInspector(false);
      }
      drag = null;
      paintAll();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('pointerleave', function () { if (!drag) { state.hoverFrame = null; paintAll(); } });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var W = lane.cssW || canvas.clientWidth, x = posX(e);
      var fr = xToFrame(x, W), span = state.view.f1 - state.view.f0;
      var factor = e.deltaY < 0 ? 0.8 : 1.25;
      var ns = Math.max(4, Math.min(state.result.frames, span * factor));
      var nf0 = fr - (x / W) * ns;
      nf0 = Math.max(0, Math.min(state.result.frames - ns, nf0));
      state.view = { f0: nf0, f1: nf0 + ns };
      updateView(true);
    }, { passive: false });
  }

  function zoomButton(factor) {
    var span = state.view.f1 - state.view.f0, F = state.result.frames;
    var ns = factor === 1 ? F : Math.max(4, Math.min(F, span * factor));
    var center = (state.view.f0 + state.view.f1) / 2;
    var nf0 = factor === 1 ? 0 : Math.max(0, Math.min(F - ns, center - ns / 2));
    state.view = { f0: nf0, f1: nf0 + ns };
    updateView(true);
  }

  // ---------------------------------------------------------------- selection
  function syncSelectionInputs() {
    var s = state.selection;
    $('sel-start').value = s ? s.f0 : '';
    $('sel-end').value = s ? s.f1 : '';
    $('selection-info').textContent = s
      ? ('[' + s.f0 + ', ' + s.f1 + ') · ' + fmtInt(s.f1 - s.f0) + ' 帧 · ' + ((s.f1 - s.f0) / 48000).toFixed(3) + ' s · ' + frameRangeAffected(s))
      : '未选择（在波形上拖出区间，或点击区间列表）';
  }
  function frameRangeAffected(s) {
    var n = 0;
    for (var c = 0; c < state.result.channels; c++) {
      var a = state.result.channelData[c].affected;
      for (var f = s.f0; f < s.f1; f++) if (a[f]) n++;
    }
    return '区间内受影响采样/声道计数 ' + fmtInt(n);
  }
  function applySelectionInputs() {
    var F = state.result.frames;
    var a = parseInt($('sel-start').value, 10), b = parseInt($('sel-end').value, 10);
    if (isNaN(a) || isNaN(b)) return;
    a = Math.max(0, Math.min(F, a)); b = Math.max(0, Math.min(F, b));
    if (b <= a) { b = Math.min(F, a + 1); }
    state.selection = { f0: a, f1: b };
    setButtonsDisabled(state.selection); syncSelectionInputs(); paintAll();
  }
  function clearSelection() {
    state.selection = null; setButtonsDisabled(null); syncSelectionInputs(); paintAll();
  }

  // ---------------------------------------------------------------- inspector
  function buildInspectChannelOptions() {
    var sel = $('inspect-channel');
    sel.innerHTML = '';
    for (var c = 0; c < state.result.channels; c++) {
      var o = document.createElement('option'); o.value = c; o.textContent = '声道 ' + c; sel.appendChild(o);
    }
    sel.value = String(state.inspect.ch || 0);
  }

  function renderInspector(resetTick) {
    var host = $('frame-inspector');
    if (!state.result) { host.innerHTML = '<p class="muted">尚未导入。</p>'; return; }
    var ch = state.inspect.ch, f = state.inspect.frame;
    f = Math.max(0, Math.min(state.result.frames - 1, f | 0));
    state.inspect.frame = f;
    var d = E.describeFrame(state.result, ch, f);
    if (resetTick || state.inspect.tick == null || state.inspect.tick < d.leftTick || state.inspect.tick > d.rightTick) {
      state.inspect.tick = d.extractTick; // default select extraction instant
    }

    var affBadge = d.affected
      ? '<span class="badge badge-bad">受缺位影响</span>'
      : '<span class="badge badge-ok">依赖域完整</span>';
    var consBadge = (d.pcmConsistent && d.affectedConsistent)
      ? '<span class="badge badge-ok">重算一致 ✓</span>'
      : '<span class="badge badge-bad">内部不一致</span>';
    var clampBadge = d.clamped ? '<span class="badge badge-warn">已限幅</span>' : '';

    var html = '';
    html += '<div class="frame-summary">'
      + stat('声道 / 输出帧', ch + ' / ' + f)
      + stat('抽取时刻 T (rel tick)', d.extractTick)
      + stat('依赖区间（含两端）', '[' + d.leftTick + ', ' + d.rightTick + '] · ' + d.kernelWidth + ' 位')
      + stat('三阶精确和 Σ', d.exactSum)
      + stat('×32768 / D³', Number(d.rawScaled).toFixed(4))
      + stat('PCM16（偶舍入）', d.pcm)
      + '<div class="stat"><div class="k">判定 / 自检</div><div class="v" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">' + affBadge + consBadge + clampBadge + '</div></div>'
      + '</div>';

    html += '<div class="formula">帧 ' + f + '：T = (f+1)D−1 = ' + d.extractTick +
      '；依赖左端 T−3(D−1) = ' + d.leftTick +
      '；PCM = clamp16(roundHalfEven(Σ w·x · 32768 / D³))，D=' + state.result.D + '</div>';

    // bit chips
    html += '<div class="bit-strip" role="list" aria-label="该帧依赖的输入位">';
    d.ticks.forEach(function (t) {
      var cls = 'bit-chip ' + t.kind + (t.kind === 'real' ? ' bit' + t.bit : '');
      if (state.inspect.tick === t.tick) cls += ' selected';
      var label = t.kind === 'prestart' ? '∅' : t.bit;
      var title = 'tick ' + t.tick + ' · ' + kindText(t) + (t.sourceIndex >= 0 ? ' · 记录#' + t.sourceIndex + ' @' + t.sourceOffset : '');
      html += '<button type="button" class="' + cls + '" data-tick="' + t.tick + '" title="' + escapeHtml(title) + '">'
        + '<span class="b">' + label + '</span><span class="t">' + t.tick + '</span></button>';
    });
    html += '</div>';

    // selected tick detail
    var sel = d.ticks.filter(function (t) { return t.tick === state.inspect.tick; })[0] || d.ticks[d.ticks.length - 1];
    html += renderTickDetail(sel);

    // full table
    html += '<details><summary class="em" style="cursor:pointer;margin:6px 0">展开全部 ' + d.ticks.length + ' 个依赖位与系数贡献表</summary>'
      + '<div class="tick-table-wrap"><table class="tick-table"><thead><tr>'
      + '<th class="l">tick</th><th>类型</th><th>位</th><th>x</th><th>系数w</th><th>w·x</th><th class="l">采用来源</th><th>候选记录</th>'
      + '</tr></thead><tbody>';
    d.ticks.forEach(function (t) {
      var rowCls = t.kind === 'fill' ? 'fill-row' : (t.kind === 'prestart' ? 'prestart-row' : '');
      if (state.inspect.tick === t.tick) rowCls += ' sel-row';
      var src = t.sourceIndex >= 0 ? ('#' + t.sourceIndex + ' @' + t.sourceOffset) : '—';
      html += '<tr class="' + rowCls + '" data-row-tick="' + t.tick + '">'
        + '<td class="l">' + t.tick + '</td>'
        + '<td>' + kindText(t) + '</td>'
        + '<td>' + (t.bit == null ? '—' : t.bit) + '</td>'
        + '<td>' + t.value + '</td>'
        + '<td>' + t.weight + '</td>'
        + '<td>' + t.contribution + '</td>'
        + '<td class="l">' + src + '</td>'
        + '<td>' + t.providers.length + '</td>'
        + '</tr>';
    });
    html += '</tbody></table></div></details>';

    host.innerHTML = html;

    // chip interactions
    Array.prototype.forEach.call(host.querySelectorAll('.bit-chip'), function (btn) {
      btn.addEventListener('click', function () {
        state.inspect.tick = parseInt(btn.getAttribute('data-tick'), 10);
        renderInspector(false);
      });
    });
  }

  function stat(k, v) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  function kindText(t) { return t.kind === 'real' ? '真位' : t.kind === 'fill' ? '缺位补位' : '起点前零'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }

  function renderTickDetail(t) {
    var html = '<div class="tick-detail" id="tick-detail"><h4>tick ' + t.tick + ' · ' + kindText(t) + '</h4>';
    html += '<div>使用值 x = <strong>' + t.value + '</strong>，等效滤波系数 w = <strong>' + t.weight +
      '</strong>，贡献 w·x = <strong>' + t.contribution + '</strong>。';
    if (t.kind === 'fill') {
      html += '该 tick 无任何有效记录覆盖，按绝对相位 (首时标+relTick) 奇偶补位：补入位 <strong>' + t.bit + '</strong>，并使本帧标记为受影响。';
    } else if (t.kind === 'prestart') {
      html += '位于相对 tick 0 之前，按约定取数值 0（不是缺位，不触发受影响）。';
    } else {
      html += '采用位 <strong>' + t.bit + '</strong>（0→−1，1→+1）。';
    }
    html += '</div>';
    if (t.providers.length) {
      html += '<ul class="prov-list">';
      t.providers.forEach(function (p) {
        var st = p.winner ? '<span class="badge badge-ok">最终采用 · 末次好记录胜</span>'
          : (p.adopted ? '<span class="badge badge-muted">有效但被后一条覆盖</span>'
            : (!p.crcOk ? '<span class="badge badge-bad">CRC 坏 · 不覆盖好包</span>'
              : '<span class="badge badge-warn">非法 · 未采用</span>'));
        html += '<li>记录 <strong>#' + p.recordIndex + '</strong> @字节偏移 <code>' + p.offset + '</code> '
          + '候选位=' + p.bit + ' CRC ' + (p.crcOk ? '✓' : '✗') + ' ' + st + '</li>';
      });
      html += '</ul>';
    } else if (t.kind === 'real') {
      html += '<p class="muted">无候选来源（异常）。</p>';
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------- intervals
  function renderIntervals() {
    var r = state.result, root = $('intervals-root');
    root.innerHTML = '';
    var CAP = 200;
    for (var c = 0; c < r.channels; c++) {
      var ivs = r.channelData[c].intervals;
      var box = document.createElement('div'); box.className = 'iv-channel';
      var head = '<div class="iv-channel-head"><span class="lane-dot" style="background:' + channelColor(c) + '"></span>声道 ' + c
        + ' · ' + ivs.length + ' 段最大连续区间</div>';
      var body = '<div class="iv-list">';
      if (!ivs.length) body += '<span class="iv-none">无受影响帧（依赖域内没有缺位）</span>';
      else {
        ivs.slice(0, CAP).forEach(function (iv) {
          body += '<button type="button" class="iv-btn" data-ch="' + c + '" data-a="' + iv[0] + '" data-b="' + iv[1] + '" title="点击设为选区并定位">'
            + '[' + iv[0] + ', ' + iv[1] + ')<br>' + fmtTimeShort(iv[0] / 48000) + '–' + fmtTimeShort(iv[1] / 48000) + '</button>';
        });
        if (ivs.length > CAP) body += '<span class="iv-more">…其余 ' + (ivs.length - CAP) + ' 段见导出 JSON</span>';
      }
      body += '</div>';
      box.innerHTML = head + body;
      root.appendChild(box);
    }
    Array.prototype.forEach.call(root.querySelectorAll('.iv-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var a = +btn.getAttribute('data-a'), b = +btn.getAttribute('data-b');
        state.selection = { f0: a, f1: b };
        state.inspect.ch = +btn.getAttribute('data-ch'); state.inspect.frame = a; state.inspect.tick = null;
        var pad = Math.max(b - a, 4 * state.result.D);
        var F = state.result.frames;
        state.view = { f0: Math.max(0, a - pad), f1: Math.min(F, b + pad) };
        $('inspect-channel').value = String(state.inspect.ch);
        $('inspect-frame').value = String(a);
        setButtonsDisabled(state.selection); syncSelectionInputs();
        updateView(true); renderInspector(false);
      });
    });
  }

  // ---------------------------------------------------------------- records
  function filteredRecords() {
    var all = state.result.parsed.records;
    if (state.recFilter === 'badcrc') return all.filter(function (x) { return !x.crcOk; });
    if (state.recFilter === 'problem') return all.filter(function (x) { return !x.crcOk || !x.legal; });
    return all;
  }
  function renderRecords() {
    var rows = filteredRecords(), pages = Math.max(1, Math.ceil(rows.length / PAGE_RECORDS));
    state.recPage = Math.min(state.recPage, pages - 1);
    var start = state.recPage * PAGE_RECORDS, slice = rows.slice(start, start + PAGE_RECORDS);
    var tb = $('records-tbody');
    tb.innerHTML = slice.map(function (x) {
      var cls = !x.crcOk ? 'row-badcrc' : (!x.legal ? 'row-rejected' : '');
      var status = x.adopted ? '<span class="badge badge-ok">采用</span>'
        : (!x.crcOk ? '<span class="badge badge-bad">CRC 坏</span>' : '<span class="badge badge-warn">未采用</span>');
      var maskBits = x.mask.toString(2).padStart(8, '0');
      return '<tr class="' + cls + '">'
        + '<td>' + x.index + '</td>'
        + '<td class="mono">' + x.offset + ' <span class="muted">' + hex(x.offset) + '</span></td>'
        + '<td class="mono">' + x.relStart + '</td>'
        + '<td class="mono">' + x.count + '</td>'
        + '<td class="mono" title="置位声道">' + maskBits + '</td>'
        + '<td class="mono">' + x.payloadLength + '</td>'
        + '<td class="mono" title="stored ' + hex(x.crcStored) + ' / calc ' + hex(x.crcCalc) + '">' + (x.crcOk ? '✓ ' + hex(x.crcStored) : '✗ ' + hex(x.crcStored)) + '</td>'
        + '<td>' + status + '</td>'
        + '</tr>';
    }).join('');
    $('rec-page-info').textContent = '第 ' + (state.recPage + 1) + ' / ' + pages + ' 页 · 共 ' + rows.length + ' 条';
    $('rec-prev').disabled = state.recPage <= 0;
    $('rec-next').disabled = state.recPage >= pages - 1;

    var p = state.result.parsed;
    var bad = p.records.filter(function (x) { return !x.crcOk; }).length;
    var legal = p.records.filter(function (x) { return x.crcOk && !x.legal; }).length;
    $('records-summary').innerHTML = '共 <strong>' + p.records.length + '</strong> 条完整记录，坏 CRC <strong>' + bad +
      '</strong>，结构未采用 <strong>' + legal + '</strong>' + (p.truncated ? '；另有一条在偏移 <strong>' + p.truncated.offset + '</strong> 处被截断（未计入）' : '；无截断');
  }

  // ---------------------------------------------------------------- JSON
  function buildReport(scope) {
    var sel = null;
    if (scope === 'selection' && state.selection) {
      sel = { startFrame: state.selection.f0, endFrame: state.selection.f1 };
    } else if (scope && typeof scope === 'object') {
      sel = scope;
    }
    return E.buildIntervalsReport(state.result, sel);
  }
  function refreshJsonPreview() {
    if (!state.result) return;
    var rep = buildReport('full');
    var text = JSON.stringify(rep, null, 2);
    $('json-preview').textContent = text.length > 12000 ? text.slice(0, 12000) + '\n…（预览截断，完整内容请导出 JSON）' : text;
  }

  // ---------------------------------------------------------------- transport / export
  function ensurePlayer() { if (!state.player) state.player = new window.PDQAudio.Player(); return state.player; }

  function baseName(ext) {
    var n = (state.result.fileName || 'pdq1').replace(/\.[^.]+$/, '');
    return n + '_48k_pcm16_' + state.result.channels + 'ch' + ext;
  }

  function bindEvents() {
    $('file-input').addEventListener('change', function (e) { handleFile(e.target.files[0]); e.target.value = ''; });
    var dz = $('dropzone');
    dz.addEventListener('click', function () { $('file-input').click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });
    ['dragover', 'dragenter'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop' || e.target === document) dz.classList.remove('drag'); });
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault(); dz.classList.remove('drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f);
    });

    $('load-demo-btn').addEventListener('click', function () {
      if (!window.PDQDemo) return;
      processBuffer('demo.pdq', window.PDQDemo.arrayBuffer());
    });

    $('zoom-in').addEventListener('click', function () { zoomButton(0.5); });
    $('zoom-out').addEventListener('click', function () { zoomButton(2); });
    $('zoom-reset').addEventListener('click', function () { zoomButton(1); });

    $('apply-sel').addEventListener('click', applySelectionInputs);
    $('sel-start').addEventListener('keydown', function (e) { if (e.key === 'Enter') applySelectionInputs(); });
    $('sel-end').addEventListener('keydown', function (e) { if (e.key === 'Enter') applySelectionInputs(); });
    $('clear-sel').addEventListener('click', clearSelection);

    $('inspect-btn').addEventListener('click', function () {
      state.inspect.ch = parseInt($('inspect-channel').value, 10) || 0;
      state.inspect.frame = parseInt($('inspect-frame').value, 10) || 0;
      state.inspect.tick = null; renderInspector(true); paintAll();
    });
    $('inspect-channel').addEventListener('change', function () {
      state.inspect.ch = parseInt(this.value, 10); state.inspect.tick = null; renderInspector(true); paintAll();
    });
    $('inspect-frame').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('inspect-btn').click(); });
    $('frame-prev').addEventListener('click', function () { nudgeFrame(-1); });
    $('frame-next').addEventListener('click', function () { nudgeFrame(1); });

    $('rec-filter').addEventListener('change', function () { state.recFilter = this.value; state.recPage = 0; renderRecords(); });
    $('rec-prev').addEventListener('click', function () { state.recPage--; renderRecords(); });
    $('rec-next').addEventListener('click', function () { state.recPage++; renderRecords(); });
    $('refresh-json-preview').addEventListener('click', refreshJsonPreview);

    $('play-full').addEventListener('click', function () {
      var p = ensurePlayer();
      p.playInterleaved(state.result.interleaved, state.result.channels, 48000);
      $('play-time').textContent = fmtSec(0) + ' / ' + fmtSec(state.result.frames / 48000);
      p.onTime = function (t) { $('play-time').textContent = fmtSec(t) + ' / ' + fmtSec(state.result.frames / 48000); };
    });
    $('play-sel').addEventListener('click', function () {
      if (!state.selection) return;
      var s = state.selection, view = W.interleavedViewSlice(state.result.interleaved, state.result.channels, s.f0, s.f1);
      var p = ensurePlayer();
      p.playInterleaved(view, state.result.channels, 48000);
      var dur = (s.f1 - s.f0) / 48000;
      $('play-time').textContent = fmtSec(0) + ' / ' + fmtSec(dur);
      p.onTime = function (t) { $('play-time').textContent = fmtSec(t) + ' / ' + fmtSec(dur); };
    });
    $('stop-btn').addEventListener('click', function () { if (state.player) state.player.stop(); });

    $('export-wav-full').addEventListener('click', function () {
      var buf = W.encodeInterleaved(state.result.interleaved, 48000, state.result.channels);
      downloadBuffer(buf, baseName('.full.wav'), 'audio/wav');
    });
    $('export-wav-sel').addEventListener('click', function () {
      if (!state.selection) return;
      var s = state.selection;
      var view = W.interleavedViewSlice(state.result.interleaved, state.result.channels, s.f0, s.f1);
      var buf = W.encodeInterleaved(view, 48000, state.result.channels);
      downloadBuffer(buf, baseName('.sel-' + s.f0 + '-' + s.f1 + '.wav'), 'audio/wav');
    });
    $('export-json-full').addEventListener('click', function () {
      downloadText(JSON.stringify(buildReport('full'), null, 2), baseName('.affected.json'));
    });
    $('export-json-sel').addEventListener('click', function () {
      if (!state.selection) return;
      downloadText(JSON.stringify(buildReport('selection'), null, 2),
        baseName('.affected.sel-' + state.selection.f0 + '-' + state.selection.f1 + '.json'));
    });

    var rz;
    window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (state.result) resizeAllCanvases(true); }, 120); });

    document.addEventListener('keydown', function (e) {
      if (!state.result) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft') nudgeFrame(-1);
      if (e.key === 'ArrowRight') nudgeFrame(1);
    });
  }

  function nudgeFrame(delta) {
    if (!state.result) return;
    var f = Math.max(0, Math.min(state.result.frames - 1, state.inspect.frame + delta));
    state.inspect.frame = f; state.inspect.tick = null;
    $('inspect-frame').value = String(f);
    renderInspector(true); paintAll();
  }

  // ---------------------------------------------------------------- automation API
  window.PDMReel = {
    version: '1.0.0',
    engine: E, wav: W,
    processBuffer: processBuffer,
    loadArrayBuffer: function (name, ab) { state.startedAt = performance.now(); return processBuffer(name, ab); },
    loadDemo: function () { return processBuffer('demo.pdq', window.PDQDemo.arrayBuffer()); },
    getResult: function () { return state.result; },
    getTimingMs: function () { return state.result ? state.result.processMs : window.__PDQ_LAST_MS__ || null; },
    setSelection: function (a, b) {
      if (!state.result) return;
      state.selection = { f0: a, f1: b };
      setButtonsDisabled(state.selection); syncSelectionInputs(); paintAll();
    },
    inspectFrame: function (ch, f) {
      state.inspect.ch = ch; state.inspect.frame = f; state.inspect.tick = null;
      $('inspect-channel').value = String(ch); $('inspect-frame').value = String(f);
      renderInspector(true); paintAll();
      return E.describeFrame(state.result, ch, f);
    },
    buildReport: function (scope) { return buildReport(scope); },
    getFullWavBytes: function () { return W.encodeInterleaved(state.result.interleaved, 48000, state.result.channels); },
    getSelectionWavBytes: function () {
      var s = state.selection; if (!s) return null;
      var view = W.interleavedViewSlice(state.result.interleaved, state.result.channels, s.f0, s.f1);
      return W.encodeInterleaved(view, 48000, state.result.channels);
    },
    getSelection: function () { return state.selection; }
  };

  bindEvents();
})();
