/*
 * app.js — 页面交互：载入、渲染、试听/裁区、逐帧核查、缺口浏览、导出。
 * 唯一 PCM 真源是 state.result.pcm（交错 Int16）；WAV 与试听缓冲都从它派生。
 */
(function () {
  'use strict';
  const C = window.OpticalStitcher;
  const $ = (id) => document.getElementById(id);

  /** @type {{data:any,result:any,fileName:string,region:{start:number,end:number}|null,
   *  audioCtx:AudioContext|null, masterBuffer:AudioBuffer|null, source:AudioBufferSourceNode|null,
   *  playing:boolean, cursor:number, raf:number|null, startedAt:number, offset:number,
   *  lastAudition:any, peaks:any}} */
  const state = {
    data: null, result: null, fileName: '', region: null,
    audioCtx: null, masterBuffer: null, source: null,
    playing: false, cursor: 0, raf: null, startedAt: 0, offset: 0,
    lastAudition: null, peaks: null, drag: null,
  };

  // ------------------------------------------------------------ 工具

  function setStatus(text, cls) {
    const el = $('renderStatus');
    el.textContent = text;
    el.className = 'status-line' + (cls ? ' ' + cls : '');
  }
  function showError(err) {
    const box = $('errorBox');
    if (!err) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = '处理失败：' + (err && err.message ? err.message : String(err));
  }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function fmtSec(frames) { return (frames / C.SAMPLE_RATE).toFixed(3) + ' s'; }

  function downloadBytes(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function downloadText(text, filename, mime) {
    downloadBytes(new TextEncoder().encode(text), filename, mime || 'text/csv;charset=utf-8');
  }

  // ------------------------------------------------------------ 载入 + 渲染

  function loadObject(obj, name) {
    showError(null);
    try {
      const t0 = performance.now();
      // 渲染核心内部会 parse + decode；这里先保留原始对象便于 API 检查。
      const result = C.renderStrips(obj);
      const wallMs = performance.now() - t0;
      // 使旧的播放缓冲/声源失效，避免载入新数据后仍播放旧 masterBuffer。
      stopSource();
      state.masterBuffer = null;
      state.auditionRange = null;
      state.data = obj;
      state.result = result;
      state.fileName = name || 'object';
      state.region = null;
      state.cursor = 0;
      state.offset = 0;
      state.lastAudition = null;
      $('regionStart').value = '';
      $('regionEnd').value = '';
      $('playBtn').textContent = '▶ 播放整轨';

      renderMeta(wallMs);
      renderWarnings(result.warnings);
      buildPeaks(result);
      drawWaveform();
      renderGapLists();
      setControlsEnabled(true);
      setStatus(
        `渲染完成：${fmtInt(result.frameCount)} 帧（${(result.frameCount / C.SAMPLE_RATE).toFixed(3)} s），` +
        `核心耗时 ${result.stats.renderMs.toFixed(0)} ms，页面计时 ${wallMs.toFixed(0)} ms。`,
        'ok'
      );
      $('inspectFrame').max = String(result.frameCount - 1);
      $('regionStart').max = String(result.frameCount - 1);
      $('regionEnd').max = String(result.frameCount);
      $('inspectFrame').value = '0';
      showFrame(0);
      updateRegionUI();
      updateTimeDisplay();
      return result;
    } catch (err) {
      console.error(err);
      setStatus('渲染失败。', '');
      showError(err);
      setControlsEnabled(false);
      throw err;
    }
  }

  function renderMeta(wallMs) {
    const r = state.result;
    $('metaName').textContent = state.fileName;
    $('metaName').title = state.fileName;
    $('metaStrips').textContent = fmtInt(r.stats.stripCount);
    $('metaRows').textContent = fmtInt(r.stats.totalRows);
    $('metaFrames').textContent = fmtInt(r.frameCount);
    $('metaDuration').textContent = (r.frameCount / C.SAMPLE_RATE).toFixed(3) + ' s';
    $('metaRenderMs').textContent = `${r.stats.renderMs.toFixed(0)} ms（核心）/ ${wallMs.toFixed(0)} ms`;
  }

  function renderWarnings(warnings) {
    const ul = $('warnList');
    ul.innerHTML = '';
    (warnings || []).forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    });
  }

  function setControlsEnabled(on) {
    const ids = ['playBtn', 'stopBtn', 'inspectFrame', 'inspectBtn', 'prevFrameBtn',
      'nextFrameBtn', 'exportWavBtn', 'exportGapsCsvBtn', 'exportGapsLeftBtn',
      'exportGapsRightBtn', 'exportGapsJsonBtn', 'regionStart', 'regionEnd',
      'applyRegionBtn'];
    ids.forEach((id) => { $(id).disabled = !on; });
    if (!on) {
      ['playRegionBtn', 'exportRegionWavBtn', 'clearRegionBtn'].forEach((id) => { $(id).disabled = true; });
    } else {
      updateRegionButtons();
    }
  }

  async function handleFile(file) {
    if (!file) return;
    setStatus('正在读取并解析 ' + file.name + ' …', 'busy');
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      loadObject(obj, file.name);
    } catch (err) {
      showError(err);
      setStatus('无法读取 JSON 文件。', '');
    }
  }

  async function loadBundledSample() {
    setStatus('正在载入 samples/optical-strips.json …', 'busy');
    // file:// 下 fetch 本地 JSON 会被浏览器拦截并在控制台报错，直接用内嵌副本。
    if (location.protocol === 'file:' && window.OPTICAL_SAMPLE_DATA) {
      return loadObject(window.OPTICAL_SAMPLE_DATA, 'sample-data.js（内嵌样例）');
    }
    try {
      const resp = await fetch('samples/optical-strips.json', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const obj = await resp.json();
      return loadObject(obj, 'samples/optical-strips.json');
    } catch (fetchErr) {
      if (window.OPTICAL_SAMPLE_DATA) {
        return loadObject(window.OPTICAL_SAMPLE_DATA, 'sample-data.js（内嵌样例）');
      }
      showError(fetchErr);
      setStatus('自动读取样例失败，请用按钮选择 samples/optical-strips.json。', '');
    }
  }

  // ------------------------------------------------------------ 波形峰值

  function buildPeaks(result) {
    const BUCKETS = 4096;
    const F = result.frameCount;
    const pcm = result.pcm;
    const n = Math.min(BUCKETS, Math.max(1, F));
    const peaks = {
      n,
      lMin: new Float32Array(n), lMax: new Float32Array(n),
      rMin: new Float32Array(n), rMax: new Float32Array(n),
    };
    const per = F / n;
    for (let b = 0; b < n; b++) {
      const f0 = Math.floor(b * per);
      const f1 = Math.max(f0 + 1, Math.floor((b + 1) * per));
      let lmin = 0, lmax = 0, rmin = 0, rmax = 0;
      for (let f = f0; f < Math.min(F, f1); f++) {
        const l = pcm[2 * f], r = pcm[2 * f + 1];
        if (l < lmin) lmin = l; if (l > lmax) lmax = l;
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      }
      peaks.lMin[b] = lmin / 32768; peaks.lMax[b] = lmax / 32768;
      peaks.rMin[b] = rmin / 32768; peaks.rMax[b] = rmax / 32768;
    }
    state.peaks = peaks;
  }

  function drawWaveform() {
    const canvas = $('waveform');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 900;
    const cssH = 170;
    canvas.height = cssH;
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const centerL = Math.round(cssH * 0.25);
    const centerR = Math.round(cssH * 0.75);
    const amp = cssH * 0.21;

    // 两条泳道的中线与分隔线
    ctx.strokeStyle = getCss('--border');
    ctx.lineWidth = 1;
    [centerL, centerR].forEach((cy) => {
      ctx.beginPath(); ctx.moveTo(0, cy + 0.5); ctx.lineTo(cssW, cy + 0.5); ctx.stroke();
    });
    ctx.strokeStyle = 'color-mix(in srgb, ' + getCss('--border') + ' 55%, transparent)';
    ctx.beginPath(); ctx.moveTo(0, cssH / 2 + 0.5); ctx.lineTo(cssW, cssH / 2 + 0.5); ctx.stroke();

    if (!state.result || !state.peaks) return;
    const F = state.result.frameCount;
    const peaks = state.peaks;

    // 裁区高亮
    if (state.region) {
      const x0 = state.region.start / F * cssW;
      const x1 = state.region.end / F * cssW;
      ctx.fillStyle = 'rgba(55,208,179,0.13)';
      ctx.fillRect(x0, 0, x1 - x0, cssH);
      ctx.strokeStyle = 'rgba(55,208,179,0.8)';
      ctx.beginPath();
      ctx.moveTo(x0, 0); ctx.lineTo(x0, cssH);
      ctx.moveTo(x1, 0); ctx.lineTo(x1, cssH);
      ctx.stroke();
    }

    drawChannel(ctx, peaks.lMin, peaks.lMax, cssW, centerL, amp, 'rgba(91,157,255,0.92)');
    drawChannel(ctx, peaks.rMin, peaks.rMax, cssW, centerR, amp, 'rgba(55,208,179,0.92)');

    // 泳道标签
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(91,157,255,0.9)';
    ctx.fillText('L', 6, 12);
    ctx.fillStyle = 'rgba(55,208,179,0.9)';
    ctx.fillText('R', 6, cssH / 2 + 12);

    // 播放头
    if (state.cursor > 0 || state.playing) {
      const x = state.cursor / F * cssW;
      ctx.strokeStyle = getCss('--amber');
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    }
  }

  function drawChannel(ctx, mins, maxs, w, center, amp, color) {
    const n = mins.length;
    ctx.fillStyle = color;
    for (let b = 0; b < n; b++) {
      const x = b / n * w;
      const bw = Math.max(1, w / n);
      const yMax = center - Math.max(maxs[b], 0) * amp;
      const yMin = center - Math.min(mins[b], 0) * amp;
      ctx.fillRect(x, yMax, bw, Math.max(1, yMin - yMax));
    }
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  // ------------------------------------------------------------ 波形交互

  function frameFromEvent(ev) {
    const rect = $('waveform').getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, ev.clientX - rect.left));
    const F = state.result.frameCount;
    return Math.min(F - 1, Math.floor(x / rect.width * F));
  }

  function initWavePointer() {
    const cv = $('waveform');
    cv.addEventListener('pointerdown', (ev) => {
      if (!state.result) return;
      cv.setPointerCapture(ev.pointerId);
      const f = frameFromEvent(ev);
      state.drag = { anchor: f, moved: false, cur: f };
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!state.drag) return;
      const f = frameFromEvent(ev);
      if (Math.abs(f - state.drag.anchor) > 2) state.drag.moved = true;
      state.drag.cur = f;
      if (state.drag.moved) {
        const a = Math.min(state.drag.anchor, f);
        const b = Math.max(state.drag.anchor, f) + 1; // 半开
        state.region = { start: a, end: b };
        $('regionStart').value = String(a);
        $('regionEnd').value = String(b);
        updateRegionUI();
        drawWaveform();
      }
    });
    cv.addEventListener('pointerup', () => {
      if (!state.drag) return;
      if (!state.drag.moved) {
        const f = state.drag.anchor;
        $('inspectFrame').value = String(f);
        showFrame(f);
        seekCursor(f);
      } else {
        updateRegionUI();
      }
      state.drag = null;
      drawWaveform();
    });
  }

  // ------------------------------------------------------------ 裁区控件

  function currentRegionFromInputs() {
    const F = state.result.frameCount;
    let a = parseInt($('regionStart').value, 10);
    let b = parseInt($('regionEnd').value, 10);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = F;
    a = Math.max(0, Math.min(F - 1, a));
    b = Math.max(a + 1, Math.min(F, b));
    return { start: a, end: b };
  }

  function applyRegionFromInputs() {
    if (!state.result) return;
    state.region = currentRegionFromInputs();
    $('regionStart').value = String(state.region.start);
    $('regionEnd').value = String(state.region.end);
    updateRegionUI();
    drawWaveform();
  }

  // 输入即同步（自动化 fill 会触发 input）；任一框为空时暂不形成裁区。
  function syncRegionFromInputs() {
    if (!state.result) return;
    const sv = $('regionStart').value.trim();
    const ev = $('regionEnd').value.trim();
    if (sv === '' || ev === '') {
      state.region = null;
    } else {
      let a = parseInt(sv, 10), b = parseInt(ev, 10);
      if (Number.isInteger(a) && Number.isInteger(b) && b > a) {
        const F = state.result.frameCount;
        a = Math.max(0, Math.min(F - 1, a));
        b = Math.max(a + 1, Math.min(F, b));
        state.region = { start: a, end: b };
      } else {
        state.region = null;
      }
    }
    updateRegionUI();
    drawWaveform();
  }

  function clearRegion() {
    state.region = null;
    $('regionStart').value = '';
    $('regionEnd').value = '';
    updateRegionUI();
    drawWaveform();
  }

  function updateRegionButtons() {
    const has = !!state.region;
    $('playRegionBtn').disabled = !has;
    $('exportRegionWavBtn').disabled = !has;
    $('clearRegionBtn').disabled = !has;
  }

  function updateRegionUI() {
    if (!state.result) return;
    updateRegionButtons();
    const info = $('regionInfo');
    if (state.region) {
      const { start, end } = state.region;
      info.textContent = `[${start}, ${end}) · ${fmtInt(end - start)} 帧 · ${((end - start) / 48000).toFixed(3)} s`;
    } else {
      info.textContent = '未选择裁区';
    }
  }

  // ------------------------------------------------------------ 音频 / 试听

  function ensureAudio() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 WebAudio');
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
    return state.audioCtx;
  }

  function getMasterBuffer() {
    if (state.masterBuffer) return state.masterBuffer;
    const ctx = ensureAudio();
    const r = state.result;
    const buf = ctx.createBuffer(2, r.frameCount, C.SAMPLE_RATE);
    const fl = r.toFloatChannels(0, r.frameCount);
    buf.copyToChannel(fl.left, 0);
    buf.copyToChannel(fl.right, 1);
    state.masterBuffer = buf;
    return buf;
  }

  /**
   * 构造裁区试听载荷：Float32 样本严格等于整轨 Int16 切片 /32768。
   * 同时尝试送入 WebAudio；即使 AudioContext 不可用，载荷也已记录并返回，
   * 便于自动化核对“送入音频的样本”。
   */
  function audition(startFrame, endFrame) {
    const r = state.result;
    if (!r) throw new Error('尚未渲染数据');
    const a = Math.max(0, startFrame | 0);
    const b = Math.min(r.frameCount, endFrame | 0);
    if (!(b > a)) throw new Error('裁区为空：需要 start < end');

    const floats = r.toFloatChannels(a, b);
    const pcm = r.pcm.slice(2 * a, 2 * b);
    let buffer = null;
    try {
      const ctx = ensureAudio();
      stopSource();
      buffer = ctx.createBuffer(2, b - a, C.SAMPLE_RATE);
      buffer.copyToChannel(floats.left, 0);
      buffer.copyToChannel(floats.right, 1);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => { if (state.source === src) { state.playing = false; state.source = null; } };
      src.start();
      state.source = src;
      state.playing = true;
      state.startedAt = ctx.currentTime;
      state.offset = 0;
      state.auditionRange = { start: a, end: b };
    } catch (audioErr) {
      // 无头环境可能无法真正出声；样本载荷仍可供断言。
      console.warn('WebAudio 播放不可用，仅记录试听样本：', audioErr);
    }

    state.lastAudition = {
      startFrame: a,
      endFrame: b,
      sampleRate: C.SAMPLE_RATE,
      channels: 2,
      pcm,
      left: floats.left,
      right: floats.right,
      buffer,
      sentAt: Date.now(),
    };
    state.cursor = a;
    startRaf();
    return state.lastAudition;
  }

  function stopSource() {
    if (state.source) {
      try { state.source.onended = null; state.source.stop(); } catch (_) { /* already stopped */ }
      try { state.source.disconnect(); } catch (_) {}
      state.source = null;
    }
    state.playing = false;
  }

  function playFull() {
    if (!state.result) return;
    const ctx = ensureAudio();
    if (state.playing) { // 暂停
      state.offset = currentPlaybackFrame();
      stopSource();
      $('playBtn').textContent = '▶ 继续';
      return;
    }
    stopSource();
    const buf = getMasterBuffer();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const from = Math.max(0, Math.min(state.offset || 0, state.result.frameCount - 1));
    src.start(0, from / C.SAMPLE_RATE);
    state.source = src;
    state.playing = true;
    state.startedAt = ctx.currentTime;
    state.offset = from;
    src.onended = () => {
      if (state.source === src) {
        state.source = null; state.playing = false;
        state.cursor = state.result ? state.result.frameCount : 0;
        state.offset = 0;
        $('playBtn').textContent = '▶ 播放整轨';
        updateTimeDisplay();
      }
    };
    $('playBtn').textContent = '⏸ 暂停';
    startRaf();
  }

  function currentPlaybackFrame() {
    if (!state.audioCtx || !state.playing) return state.cursor;
    const elapsed = state.audioCtx.currentTime - state.startedAt;
    return Math.floor(state.offset + elapsed * C.SAMPLE_RATE);
  }

  function seekCursor(f) {
    state.cursor = f;
    state.offset = f;
    updateTimeDisplay();
    drawWaveform();
  }

  function startRaf() {
    if (state.raf !== null) return;
    const tick = () => {
      state.raf = requestAnimationFrame(tick);
      if (state.playing) {
        let f = currentPlaybackFrame();
        if (state.auditionRange && state.source) {
          if (f >= state.auditionRange.end) f = state.auditionRange.end;
        }
        state.cursor = f;
        updateTimeDisplay();
        drawWaveform();
      }
    };
    state.raf = requestAnimationFrame(tick);
  }

  function stopAll() {
    stopSource();
    state.auditionRange = null;
    state.offset = 0; state.cursor = 0;
    $('playBtn').textContent = '▶ 播放整轨';
    updateTimeDisplay(); drawWaveform();
  }

  function updateTimeDisplay() {
    if (!state.result) { $('timeDisplay').textContent = '0 / 0 帧 · 0.000 s'; return; }
    const cur = Math.min(state.cursor, state.result.frameCount);
    $('timeDisplay').textContent =
      `${fmtInt(cur)} / ${fmtInt(state.result.frameCount)} 帧 · ${(cur / 48000).toFixed(3)} s`;
  }

  // ------------------------------------------------------------ 帧核查渲染

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showFrame(frame) {
    const r = state.result;
    const host = $('inspectResult');
    if (!r) return;
    const fromArg = Number.isInteger(frame);
    let f = fromArg ? frame : parseInt($('inspectFrame').value, 10);
    if (!Number.isInteger(f)) f = 0;
    f = Math.max(0, Math.min(r.frameCount - 1, f | 0));
    // 用户正在输入时不要回写输入框，避免打断键入；其他入口负责同步显示。
    if (fromArg || document.activeElement !== $('inspectFrame')) {
      $('inspectFrame').value = String(f);
    }

    let info;
    try { info = r.inspectFrame(f); } catch (e) { showError(e); return; }

    host.innerHTML = '';
    const head = el('div', 'frame-head');
    head.appendChild(el('span', null, '帧 '));
    const strong = el('strong', null, String(f));
    head.appendChild(strong);
    head.appendChild(el('span', null, `刻区间 [${info.tickStart}, ${info.tickEnd})`));
    head.appendChild(el('span', null, `时间 ${info.timeSeconds.toFixed(6)} s`));
    head.appendChild(el('span', null, `PCM L=${info.sample.left} R=${info.sample.right}`));
    host.appendChild(head);

    const grid = el('div', 'inspect-grid');
    grid.appendChild(buildChannelPanel('left', '左声道', info.left, info.sample.left,
      info.numerator.left, C.TICKS_PER_FRAME));
    grid.appendChild(buildChannelPanel('right', '右声道', info.right, info.sample.right,
      info.numerator.right, C.TICKS_PER_FRAME));
    host.appendChild(grid);
  }

  function buildChannelPanel(side, title, chInfo, sample, numerator, tpf) {
    const p = el('div', 'ch-panel ' + side);
    const h = el('h4');
    h.appendChild(el('span', null, title));
    h.appendChild(el('span', 'tag-strip', sample + ''));
    p.appendChild(h);

    const stats = el('div', 'ch-stats');
    stats.appendChild(stat('覆盖刻数', `${chInfo.coverageTicks} / ${tpf}`));
    stats.appendChild(stat('加权分子', String(numerator)));
    stats.appendChild(stat('来源条带', String(chInfo.sources.length)));
    p.appendChild(stats);

    const bar = el('div', 'coverage-bar');
    const ii = el('i');
    ii.style.width = (chInfo.coverageTicks / tpf * 100).toFixed(1) + '%';
    bar.appendChild(ii); p.appendChild(bar);

    if (chInfo.runs.length === 0) {
      p.appendChild(el('p', 'empty-hint', '  整帧无有效覆盖刻 → 全部补零，属于缺口。'));
      return p;
    }

    const table = el('table', 'src-table');
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>条带</th><th>行号</th><th>半开刻区间</th>' +
      '<th class="num">刻数</th><th class="num">行样本</th></tr>';
    table.appendChild(thead);
    const tb = document.createElement('tbody');
    chInfo.runs.forEach((run) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><span class="tag-strip">#${run.stripId}</span></td>` +
        `<td>${run.rowIndex}</td>` +
        `<td>[${run.startTick}, ${run.endTick})</td>` +
        `<td class="num">${run.ticks}</td>` +
        `<td class="num">${run.value}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    p.appendChild(table);

    if (chInfo.sources.length > 1) {
      const sum = el('p', 'empty-hint');
      sum.style.padding = '8px 12px';
      sum.textContent = '按条带合计：' +
        chInfo.sources.map((s) => `#${s.stripId} ${s.ticks} 刻`).join('，');
      p.appendChild(sum);
    }
    return p;
  }

  function stat(k, v) {
    const d = el('div', 'ch-stat');
    d.appendChild(el('span', 'k', k));
    d.appendChild(el('span', 'v', v));
    return d;
  }

  // ------------------------------------------------------------ 缺口列表

  function renderGapLists() {
    const r = state.result;
    $('gapCountL').textContent = fmtInt(r.gapCount.left) + ' 段';
    $('gapCountR').textContent = fmtInt(r.gapCount.right) + ' 段';
    fillGapList($('gapListL'), r.gapTicks.left);
    fillGapList($('gapListR'), r.gapTicks.right);
  }

  function fillGapList(host, flat) {
    host.innerHTML = '';
    if (flat.length === 0) {
      host.appendChild(el('p', 'empty-hint', '该声道在整轨范围内无缺口。'));
      return;
    }
    const MAX_ITEMS = 300;
    const count = flat.length / 2;
    const show = Math.min(count, MAX_ITEMS);
    for (let i = 0; i < show; i++) {
      const s = flat[2 * i], e = flat[2 * i + 1];
      const item = el('div', 'gap-item');
      item.appendChild(el('span', 'gi-range', `[${fmtInt(s)}, ${fmtInt(e)})`));
      item.appendChild(el('span', 'gi-len', `${fmtInt(e - s)} 刻`));
      item.appendChild(el('span', 'gi-frame',
        `起帧 ${Math.floor(s / 960)}（刻内 ${s % 960}）→ 止帧 ${Math.floor(e / 960)}（刻内 ${e % 960}，不含）`));
      item.title = '点击核查缺口起点所在帧';
      item.addEventListener('click', () => {
        const f = Math.min(state.result.frameCount - 1, Math.floor(s / 960));
        $('inspectFrame').value = String(f);
        showFrame(f);
        seekCursor(f);
        $('inspectCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      host.appendChild(item);
    }
    if (count > MAX_ITEMS) {
      host.appendChild(el('div', 'gap-more',
        `仅显示前 ${MAX_ITEMS} 段（共 ${fmtInt(count)} 段），完整列表请导出 CSV。`));
    }
  }

  // ------------------------------------------------------------ 导出动作

  function exportWav(regionOnly) {
    const r = state.result;
    if (!r) return;
    let bytes, name;
    if (regionOnly) {
      const reg = state.region || currentRegionFromInputs();
      const pcm = r.pcmSlice(reg.start, reg.end);
      bytes = C.encodeWavPcm(pcm, { frames: reg.end - reg.start });
      name = `optical-${reg.start}-${reg.end - 1}.wav`;
    } else {
      bytes = C.encodeWavPcm(r.pcm, { frames: r.frameCount });
      name = 'optical-soundtrack-48k-stereo-s16.wav';
    }
    downloadBytes(bytes, name, 'audio/wav');
  }

  function exportGapCsv(which) {
    const r = state.result;
    if (!r) return;
    const csv = C.gapsToCsv(r, which);
    const suffix = which === 'left' ? 'left' : which === 'right' ? 'right' : 'both';
    downloadText(csv, `optical-gaps-${suffix}.csv`, 'text/csv;charset=utf-8');
  }

  function exportGapJson() {
    const r = state.result;
    if (!r) return;
    downloadText(JSON.stringify(C.gapsToJson(r), null, 2),
      'optical-gaps.json', 'application/json');
  }

  // ------------------------------------------------------------ 对外 API（自动化/控制台）

  // 验收点中的构造用例（与 test/core-test.mjs 相同），方便控制台 / Playwright 直接取。
  const fixtures = {
    // 验收点3：#2 全覆盖 0.25；#1 在 [240,720) 左 0.75、右因参考相等无效。
    overlapPriority() {
      const nc = (x) => [0, 4, [x * 4]];
      return {
        frames: 1,
        strips: [
          { id: 1, start: 240, step: 480, rows: [[nc(0.75), [5, 5, [5]]]] },
          { id: 2, start: 0, step: 960, rows: [[nc(0.25), nc(0.25)]] },
        ],
      };
    },
    // 验收点4：满亮左声道只覆盖 [480,960)，右声道 null。
    halfCoverageGap() {
      const fullBright = [0, 4, [4, 4, 4, 4]];
      return {
        frames: 1,
        strips: [{ id: 1, start: 480, step: 480, rows: [[fullBright, null]] }],
      };
    },
  };

  const appApi = {
    loadObject,
    loadBundledSample,
    fixtures,
    getState: () => state,
    getResult: () => state.result,
    /** 程序化渲染 JSON 并返回 RenderResult（等价于选择文件）。 */
    render: (obj, name) => loadObject(obj, name || 'programmatic.json'),
    inspectFrame: (f) => state.result.inspectFrame(f),
    /** 构造并播放 [startFrame,endFrame) 裁区，返回送入 AudioBuffer 的精确样本载荷。 */
    audition,
    playRegion: (a, b) => {
      if (a !== undefined && b !== undefined) {
        state.region = { start: a, end: b };
        $('regionStart').value = String(a);
        $('regionEnd').value = String(b);
        updateRegionUI(); drawWaveform();
      }
      const reg = state.region || currentRegionFromInputs();
      return audition(reg.start, reg.end);
    },
    playFull,
    stop: stopAll,
    /** 返回最近一次试听载荷（含 left/right Float32 与 Int16 pcm）。 */
    getLastAudition: () => state.lastAudition,
    /** WAV 字节；给 a,b 时返回裁区 WAV。 */
    wavBytes: (a, b) => {
      if (a !== undefined && b !== undefined) {
        return C.encodeWavPcm(state.result.pcmSlice(a, b), { frames: b - a });
      }
      return C.encodeWavPcm(state.result.pcm, { frames: state.result.frameCount });
    },
    gapsCsv: (which) => C.gapsToCsv(state.result, which || 'both'),
    version: '1.0.0',
  };
  window.OpticalStitcherApp = appApi;
  // 也把 UI API 挂到核心全局上，方便只记得一个名字。
  C.app = appApi;

  // ------------------------------------------------------------ 事件绑定

  function bind() {
    $('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
    $('loadSampleBtn').addEventListener('click', loadBundledSample);

    const dz = $('dropZone');
    dz.addEventListener('click', () => $('fileInput').click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); });
    ['dragover', 'dragenter'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $('playBtn').addEventListener('click', playFull);
    $('stopBtn').addEventListener('click', stopAll);
    $('playRegionBtn').addEventListener('click', () => {
      const reg = state.region || currentRegionFromInputs();
      state.region = reg;
      audition(reg.start, reg.end);
    });
    $('applyRegionBtn').addEventListener('click', applyRegionFromInputs);
    $('clearRegionBtn').addEventListener('click', clearRegion);
    ['regionStart', 'regionEnd'].forEach((id) => {
      $(id).addEventListener('input', syncRegionFromInputs);
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRegionFromInputs(); });
    });

    $('inspectBtn').addEventListener('click', () => showFrame());
    const frameInput = $('inspectFrame');
    frameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') showFrame(); });
    frameInput.addEventListener('change', () => showFrame());
    // fill 会触发 input：即时刷新，方便自动化只 fill 后断言面板文本。
    frameInput.addEventListener('input', () => { if (frameInput.value !== '') showFrame(); });
    $('prevFrameBtn').addEventListener('click', () => showFrame(parseInt($('inspectFrame').value, 10) - 1));
    $('nextFrameBtn').addEventListener('click', () => showFrame(parseInt($('inspectFrame').value, 10) + 1));

    $('exportWavBtn').addEventListener('click', () => exportWav(false));
    $('exportRegionWavBtn').addEventListener('click', () => exportWav(true));
    $('exportGapsCsvBtn').addEventListener('click', () => exportGapCsv('both'));
    $('exportGapsLeftBtn').addEventListener('click', () => exportGapCsv('left'));
    $('exportGapsRightBtn').addEventListener('click', () => exportGapCsv('right'));
    $('exportGapsJsonBtn').addEventListener('click', exportGapJson);

    initWavePointer();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawWaveform, 120);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    setControlsEnabled(false);
    // 打开页面即尝试载入样例：http 下 fetch JSON，file:// 下用内嵌副本。
    loadBundledSample();
  });
})();
