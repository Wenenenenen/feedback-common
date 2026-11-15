/* app.js — 循环音频制作台主线程：导入、波形、切点、交叉淡化、试听、导出、工程。 */
'use strict';

(function () {
  const CORE = window.LOOPCORE;
  const WAVLIB = window.WAV;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    doc: null,          // { name, size, buffer, sha256, sampleRate, bits, channels, frames, loops, loop }
    view: { start: 0, fpp: 1 },   // fpp = frames per CSS pixel
    sel: { start: 0, end: 0, fadeFrames: 0 },
    processedCache: null,
    rawCache: null,
    playing: false,
    mode: 'processed',  // 'raw' | 'processed'
    playOffset: 0,      // 停止时在循环内的帧位置
    projectDirty: false,
    projectSaved: null,
    lastExport: null,
    pendingProject: null,
    drag: null,
    peaks: null,
  };

  const audio = {
    ctx: null,
    source: null,
    gain: null,
    mode: null,
    startCtxTime: 0,   // 源的排定启动时刻
    offsetSeconds: 0,  // 源启动时的缓冲内偏移
    posOffset: 0,      // 位置基准偏移
    posStart: 0,       // 位置基准时刻
    wraps: 0,
  };

  const CH_COLORS = ['#4cc2ff', '#f0b657'];
  const CH_NAMES = ['左 / 单声道', '右声道'];
  const LANE_MIN_H = 92;
  const RULER_H = 26;
  const HANDLE_GRAB = 7;

  const $ = (id) => document.getElementById(id);

  const el = {
    fileInput: $('fileInput'),
    btnImport: $('btnImport'),
    projectInput: $('projectInput'),
    btnProjectOpen: $('btnProjectOpen'),
    btnProjectSave: $('btnProjectSave'),
    btnExport: $('btnExport'),
    noticeStrip: $('noticeStrip'),
    noticeText: $('noticeText'),
    noticeClose: $('noticeClose'),
    sourceDot: $('sourceDot'),
    sourceInfo: $('sourceInfo'),
    btnZoomOut: $('btnZoomOut'),
    btnZoomFit: $('btnZoomFit'),
    btnZoomIn: $('btnZoomIn'),
    viewInfo: $('viewInfo'),
    waveStage: $('waveStage'),
    waveCanvas: $('waveCanvas'),
    emptyHint: $('emptyHint'),
    overviewCanvas: $('overviewCanvas'),
    cursorInfo: $('cursorInfo'),
    metricsBody: $('metricsBody'),
    fadeMetricNote: $('fadeMetricNote'),
    rangeTag: $('rangeTag'),
    startInput: $('startInput'),
    endInput: $('endInput'),
    startMinus: $('startMinus'),
    startPlus: $('startPlus'),
    endMinus: $('endMinus'),
    endPlus: $('endPlus'),
    startTime: $('startTime'),
    endTime: $('endTime'),
    lenFrames: $('lenFrames'),
    lenTime: $('lenTime'),
    postrollInfo: $('postrollInfo'),
    fadeTag: $('fadeTag'),
    fadeSlider: $('fadeSlider'),
    fadeMsInput: $('fadeMsInput'),
    fadeFramesInput: $('fadeFramesInput'),
    fadeFramesInfo: $('fadeFramesInfo'),
    fadeLimitInfo: $('fadeLimitInfo'),
    fadeError: $('fadeError'),
    fadeErrorText: $('fadeErrorText'),
    fadeFixMax: $('fadeFixMax'),
    fadeFixZero: $('fadeFixZero'),
    playTag: $('playTag'),
    btnPlay: $('btnPlay'),
    monitorRaw: $('monitorRaw'),
    monitorProcessed: $('monitorProcessed'),
    playPosition: $('playPosition'),
    loopCounter: $('loopCounter'),
    projectStatus: $('projectStatus'),
    exportStatus: $('exportStatus'),
    checksumStatus: $('checksumStatus'),
    mismatchDialog: $('mismatchDialog'),
    mismatchIntro: $('mismatchIntro'),
    mismatchList: $('mismatchList'),
    mismatchCancel: $('mismatchCancel'),
    mismatchApply: $('mismatchApply'),
    infoDialog: $('infoDialog'),
    infoTitle: $('infoTitle'),
    infoBody: $('infoBody'),
    infoOk: $('infoOk'),
  };

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function fmtFrames(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtTime(seconds, compact, decimals) {
    if (!isFinite(seconds)) return '—';
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    const digits = decimals == null ? 3 : decimals;
    if (!compact && m === 0) return sign + rest.toFixed(digits) + ' s';
    return sign + m + ':' + rest.toFixed(digits).padStart(digits + 3, '0');
  }

  function lsbOf(jump) {
    if (jump == null || !state.doc) return null;
    const scale = state.doc.bits === 16 ? 32768 : 8388608;
    return Math.round(Math.abs(jump) * scale);
  }

  function fmtDb(v) {
    if (v == null || !(v > 0)) return '−∞ dB';
    return (20 * Math.log10(v)).toFixed(1) + ' dB';
  }

  function loopLength() {
    return Math.max(0, state.sel.end - state.sel.start);
  }

  function loopLengthSeconds() {
    if (!state.doc) return 0;
    return loopLength() / state.doc.sampleRate;
  }

  let noticeTimer = 0;
  function notice(message, kind, sticky) {
    el.noticeText.textContent = message;
    el.noticeStrip.className = 'notice-strip' + (kind ? ' ' + kind : '');
    el.noticeStrip.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) {
      noticeTimer = setTimeout(() => { el.noticeStrip.hidden = true; }, kind === 'error' ? 12000 : 6000);
    }
  }
  function hideNotice() {
    clearTimeout(noticeTimer);
    el.noticeStrip.hidden = true;
  }
  el.noticeClose.addEventListener('click', hideNotice);

  function showInfo(title, body) {
    el.infoTitle.textContent = title;
    el.infoBody.textContent = body;
    el.infoDialog.showModal();
    el.infoOk.focus();
  }
  el.infoOk.addEventListener('click', () => el.infoDialog.close());

  function fileBaseName(name) {
    return (name || 'loop').replace(/\.wav$/i, '');
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------------ *
   * 波形峰值金字塔
   * ------------------------------------------------------------------ */

  const PEAK_FACTORS = [8, 64, 512, 4096];

  /* min/max 金字塔：第一级直接从原始声道聚合（8 帧/点），之后每级为上一级的 8 倍。
   * 60 秒立体声只有约 45 万个峰值点，内存远小于复制整段音频。 */
  function buildPeaks(channels) {
    const STEP = 8;
    const levels = [];
    let prev = channels.map((src) => {
      const n = Math.ceil(src.length / STEP);
      const mins = new Float32Array(n);
      const maxs = new Float32Array(n);
      for (let b = 0; b < n; b++) {
        const from = b * STEP;
        const to = Math.min(src.length, from + STEP);
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = from; i < to; i++) {
          if (src[i] < mn) mn = src[i];
          if (src[i] > mx) mx = src[i];
        }
        mins[b] = isFinite(mn) ? mn : 0;
        maxs[b] = isFinite(mx) ? mx : 0;
      }
      return { mins, maxs };
    });
    levels.push({ factor: STEP, mins: prev.map((d) => d.mins), maxs: prev.map((d) => d.maxs) });
    for (let li = 1; li < PEAK_FACTORS.length; li++) {
      const factor = PEAK_FACTORS[li];
      if (factor !== PEAK_FACTORS[li - 1] * 8) break;
      const next = prev.map((lv) => {
        const len = lv.mins.length;
        const n = Math.ceil(len / 8);
        const mins = new Float32Array(n);
        const maxs = new Float32Array(n);
        for (let b = 0; b < n; b++) {
          const from = b * 8;
          const to = Math.min(len, from + 8);
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = from; i < to; i++) {
            if (lv.mins[i] < mn) mn = lv.mins[i];
            if (lv.maxs[i] > mx) mx = lv.maxs[i];
          }
          mins[b] = isFinite(mn) ? mn : 0;
          maxs[b] = isFinite(mx) ? mx : 0;
        }
        return { mins, maxs };
      });
      levels.push({ factor, mins: next.map((d) => d.mins), maxs: next.map((d) => d.maxs) });
      prev = next;
    }
    return levels;
  }

  function pickPeakLevel(fpp) {
    if (!state.peaks) return null;
    let chosen = null;
    for (const lv of state.peaks) {
      if (lv.factor <= fpp * 2) chosen = lv;
    }
    return chosen;
  }

  /* ------------------------------------------------------------------ *
   * 视图与坐标
   * ------------------------------------------------------------------ */

  function canvasMetrics() {
    const rect = el.waveStage.getBoundingClientRect();
    return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, rect.height) };
  }

  function layoutHeight() {
    if (!state.doc) return RULER_H + LANE_MIN_H + 12;
    const n = state.doc.channels.length;
    return RULER_H + n * LANE_MIN_H + (n - 1) * 8 + 18;
  }

  function laneRect(index) {
    const laneH = LANE_MIN_H;
    const top = RULER_H + index * (laneH + 8);
    return { top, height: laneH, mid: top + laneH / 2 };
  }

  function viewSpanFrames() {
    if (!state.doc) return 1;
    const { width } = canvasMetrics();
    return state.view.fpp * width;
  }

  function clampView() {
    if (!state.doc) return;
    const { width } = canvasMetrics();
    const frames = state.doc.frames;
    const fitFpp = frames / width;
    const minFpp = Math.min(1 / 32, fitFpp);    // 每帧最多约 32 像素
    state.view.fpp = clamp(state.view.fpp, minFpp, fitFpp);
    const span = state.view.fpp * width;
    if (span >= frames) {
      state.view.start = 0;
    } else {
      state.view.start = clamp(state.view.start, 0, frames - span);
    }
  }

  function frameAtX(x) {
    return state.view.start + x * state.view.fpp;
  }

  function xAtFrame(frame) {
    return (frame - state.view.start) / state.view.fpp;
  }

  function zoomFit() {
    if (!state.doc) return;
    const { width } = canvasMetrics();
    state.view.fpp = state.doc.frames / width;
    state.view.start = 0;
    clampView();
    renderAll();
  }

  function zoomAt(factor, anchorX) {
    if (!state.doc) return;
    const { width } = canvasMetrics();
    const anchorFrame = frameAtX(anchorX == null ? width / 2 : anchorX);
    const fitFpp = state.doc.frames / width;
    const maxFpp = Math.max(fitFpp, 1 / 32);
    state.view.fpp = clamp(state.view.fpp / factor, 1 / 32, maxFpp);
    state.view.start = anchorFrame - (anchorX == null ? width / 2 : anchorX) * state.view.fpp;
    clampView();
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   * 参数变更
   * ------------------------------------------------------------------ */

  function markDirty() {
    state.projectDirty = true;
    updateProjectUI();
  }

  function invalidateProcessed() {
    state.processedCache = null;
    state.rawCache = null;
  }

  /* 参数被编辑：停止播放并把循环内位置钳制到新的长度内（避免为每次拖动重建音频缓冲）。 */
  function syncAfterEdit() {
    if (!state.doc) return;
    // 拖动/输入期间先停播，避免每帧都重建音频缓冲；位置钳制到新的循环长度内。
    if (state.playing) stopPlayback(false);
    const L = loopLength();
    state.playOffset = L <= 0 ? 0 : clamp(state.playOffset, 0, L - 1);
  }

  function setSelection(start, end, opts) {
    if (!state.doc) return;
    const frames = state.doc.frames;
    let s = clamp(Math.round(start), 0, frames - 1);
    let e = clamp(Math.round(end), s + 1, frames);
    if (e <= s) s = Math.max(0, e - 1);
    state.sel.start = s;
    state.sel.end = e;
    // 淡化帧数保持，但限制在合法上限内（超限由校验提示）
    invalidateProcessed();
    syncAfterEdit();
    if (!opts || !opts.silent) markDirty();
    refreshAll();
  }

  function setFadeFrames(fadeFrames) {
    if (!state.doc) return;
    let F = Math.round(fadeFrames);
    if (!isFinite(F) || F < 0) F = 0;
    // F = 1 保留为非法值，由校验提示“只能为 0 或至少 2 帧”
    state.sel.fadeFrames = F;
    invalidateProcessed();
    syncAfterEdit();
    markDirty();
    refreshAll();
  }

  function setFadeMs(ms) {
    if (!state.doc) return;
    const F = CORE.fadeFramesForMs(ms, state.doc.sampleRate);
    state.sel.fadeFrames = F;
    invalidateProcessed();
    syncAfterEdit();
    markDirty();
    refreshAll();
  }

  function validateCurrent() {
    if (!state.doc) return { ok: false, errors: [] };
    return CORE.validateLoop({
      frames: state.doc.frames,
      start: state.sel.start,
      end: state.sel.end,
      fadeFrames: state.sel.fadeFrames,
      sampleRate: state.doc.sampleRate,
    });
  }

  function processedChannels() {
    if (!state.doc) return null;
    const { start, end, fadeFrames } = state.sel;
    const key = start + ':' + end + ':' + fadeFrames + ':' + state.doc.sha256;
    if (state.processedCache && state.processedCache.key === key) {
      return state.processedCache.channels;
    }
    const check = validateCurrent();
    if (!check.ok) return null;
    const channels = CORE.processLoop(
      state.doc.channels, start, end, fadeFrames, state.doc.sampleRate
    );
    state.processedCache = { key, channels };
    return channels;
  }

  /* ------------------------------------------------------------------ *
   * 界面刷新
   * ------------------------------------------------------------------ */

  function refreshAll() {
    clampView();
    updateSourceUI();
    updateRangeUI();
    updateFadeUI();
    updateMetrics();
    updateAuditionUI();
    updateProjectUI();
    updateButtons();
    renderAll();
  }

  function updateSourceUI() {
    const doc = state.doc;
    if (!doc) {
      el.sourceDot.className = 'dot';
      el.sourceInfo.textContent = '尚未导入素材';
      el.emptyHint.hidden = false;
      el.checksumStatus.textContent = '源文件校验和：—';
      return;
    }
    el.sourceDot.className = 'dot loaded';
    const chLabel = doc.channels.length === 2 ? '立体声' : '单声道';
    let text = doc.name + '  ·  ' + (doc.sampleRate / 1000).toFixed(1) + ' kHz  ·  ' +
      doc.bits + ' 位  ·  ' + chLabel + '  ·  ' + fmtFrames(doc.frames) + ' 帧  ·  ' +
      fmtTime(doc.frames / doc.sampleRate);
    el.sourceInfo.textContent = text;
    el.sourceInfo.title = text;
    el.emptyHint.hidden = true;
    el.checksumStatus.textContent = '源文件校验和：' +
      (doc.sha256 ? doc.sha256.slice(0, 16) + '…（点击查看完整）' : '—');
    el.checksumStatus.title = doc.sha256 || '';
    el.checksumStatus.classList.toggle('clickable', !!doc.sha256);
  }

  function updateButtons() {
    const hasDoc = !!state.doc;
    el.btnProjectSave.disabled = !hasDoc;
    el.btnExport.disabled = !hasDoc;
    el.btnPlay.disabled = !hasDoc;
    el.monitorRaw.disabled = !hasDoc;
    const check = hasDoc ? validateCurrent() : { ok: false };
    el.monitorProcessed.disabled = !hasDoc || !check.ok;
    el.startInput.disabled = !hasDoc;
    el.endInput.disabled = !hasDoc;
    el.fadeSlider.disabled = !hasDoc;
    el.fadeMsInput.disabled = !hasDoc;
    el.fadeFramesInput.disabled = !hasDoc;
    [el.startMinus, el.startPlus, el.endMinus, el.endPlus].forEach((b) => { b.disabled = !hasDoc; });
    el.btnZoomIn.disabled = !hasDoc;
    el.btnZoomOut.disabled = !hasDoc;
    el.btnZoomFit.disabled = !hasDoc;
  }

  function updateRangeUI() {
    const doc = state.doc;
    if (!doc) {
      el.rangeTag.textContent = '[start, end)';
      el.startInput.value = '';
      el.endInput.value = '';
      el.startTime.textContent = '—';
      el.endTime.textContent = '—';
      el.lenFrames.textContent = '—';
      el.lenTime.textContent = '—';
      el.postrollInfo.textContent = '—';
      return;
    }
    const { start, end } = state.sel;
    if (document.activeElement !== el.startInput) el.startInput.value = String(start);
    if (document.activeElement !== el.endInput) el.endInput.value = String(end);
    el.startInput.max = String(doc.frames - 1);
    el.endInput.max = String(doc.frames);
    el.startTime.textContent = '时间 ' + fmtTime(start / doc.sampleRate);
    el.endTime.textContent = '时间 ' + fmtTime(end / doc.sampleRate) + ' · 最后一帧 ' + (end - 1);
    el.rangeTag.textContent = '[' + fmtFrames(start) + ', ' + fmtFrames(end) + ')';
    el.lenFrames.textContent = fmtFrames(end - start) + ' 帧';
    el.lenTime.textContent = (end - start) / doc.sampleRate >= 60
      ? '60.000 s'
      : ((end - start) / doc.sampleRate).toFixed(4) + ' s';
    const postroll = doc.frames - end;
    el.postrollInfo.textContent = fmtFrames(postroll) + ' 帧' +
      (postroll > 0 ? '（' + fmtTime(postroll / doc.sampleRate, true) + '）' : '（无）');
    el.postrollInfo.title = 'end 之后可用于交叉淡化的音频帧数';
  }

  function updateFadeUI() {
    const doc = state.doc;
    const check = validateCurrent();
    const valid = check.ok;
    if (!doc) {
      el.fadeTag.textContent = 'F = 0';
      el.fadeFramesInfo.textContent = 'F = 0 帧（不处理）';
      el.fadeLimitInfo.textContent = '';
      el.fadeSlider.value = '0';
      el.fadeMsInput.value = '0';
      el.fadeFramesInput.value = '0';
      el.fadeError.hidden = true;
      return;
    }
    const F = state.sel.fadeFrames;
    const ms = CORE.fadeMsForFrames(F, doc.sampleRate);
    el.fadeTag.textContent = 'F = ' + F + (F > 0 ? ' 帧' : '');
    el.fadeFramesInfo.textContent = F > 0
      ? 'F = ' + F + ' 帧 = ' + ms.toFixed(3) + ' ms'
      : 'F = 0 帧（不处理，直接回绕）';
    const maxF = CORE.maxFadeFrames(doc.frames, state.sel.start, state.sel.end, doc.sampleRate);
    el.fadeLimitInfo.textContent = maxF > 0
      ? '上限 ' + fmtFrames(maxF) + ' 帧（' + CORE.fadeMsForFrames(maxF, doc.sampleRate)
        .toFixed(2) + ' ms）'
      : '当前区间无法淡化';
    el.fadeLimitInfo.title = '上限取三者最小值：区间一半 ' +
      fmtFrames(Math.floor(loopLength() / 2)) + ' 帧、end 之后预留 ' +
      fmtFrames(doc.frames - state.sel.end) + ' 帧、100 ms（' +
      fmtFrames(Math.round(doc.sampleRate * 0.1)) + ' 帧）';

    if (document.activeElement !== el.fadeSlider) el.fadeSlider.value = String(Math.min(100, ms));
    if (document.activeElement !== el.fadeMsInput) el.fadeMsInput.value = ms ? ms.toFixed(2) : '0';
    if (document.activeElement !== el.fadeFramesInput) el.fadeFramesInput.value = String(F);
    el.fadeSlider.disabled = maxF <= 0;
    el.fadeMsInput.disabled = maxF <= 0;
    el.fadeFramesInput.disabled = false;

    if (!valid) {
      el.fadeError.hidden = false;
      const text = check.errors.map((e) => '· ' + e.message).join('\n');
      el.fadeErrorText.textContent = text;
      const codes = check.errors.map((e) => e.code);
      const canFixMax = codes.some((c) => c === 'FADE_TOO_LONG' ||
        c === 'NO_POSTROLL' || c === 'FADE_MS_LIMIT');
      el.fadeFixMax.hidden = !canFixMax || maxF <= 0;
      el.fadeFixMax.textContent = '设为最大合法值（' + fmtFrames(maxF) + ' 帧）';
      el.fadeFixZero.hidden = codes.indexOf('FADE_ONE') < 0;
    } else {
      el.fadeError.hidden = true;
      el.fadeErrorText.textContent = '';
      el.fadeFixMax.hidden = true;
      el.fadeFixZero.hidden = true;
    }
  }

  /* ---------------- 指标表 ---------------- */

  function jumpCell(v, title) {
    const cell = document.createElement('td');
    if (v == null) {
      cell.textContent = '—';
      cell.title = '区间贴边，没有相邻采样可比较';
      return cell;
    }
    const abs = Math.abs(v);
    const main = document.createElement('span');
    // 主值保留 5 位小数（约 0.01 LSB 分辨率），精确的整 LSB 值放在副行
    main.textContent = (v < 0 ? '−' : '') + abs.toFixed(abs < 1e-7 ? 0 : 5);
    const sub = document.createElement('span');
    sub.className = 'metric-delta';
    sub.textContent = lsbOf(v) + ' LSB';
    cell.appendChild(main);
    cell.appendChild(sub);
    cell.className = abs > 0.02 ? 'metric-bad' : abs > 0.003 ? 'metric-warn' : 'metric-good';
    cell.title = (title ? title + '\n' : '') + '有符号值 ' + v.toFixed(8);
    return cell;
  }

  function rmsCell(v) {
    const cell = document.createElement('td');
    if (v == null) { cell.textContent = '—'; return cell; }
    const main = document.createElement('span');
    main.textContent = v.toFixed(5);
    const sub = document.createElement('span');
    sub.className = 'metric-delta';
    sub.textContent = fmtDb(v);
    cell.appendChild(main);
    cell.appendChild(sub);
    return cell;
  }

  function updateMetrics() {
    el.metricsBody.textContent = '';
    if (!state.doc) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'empty-cell';
      td.textContent = '导入素材后显示各声道的测量值';
      tr.appendChild(td);
      el.metricsBody.appendChild(tr);
      el.fadeMetricNote.textContent = '';
      return;
    }
    const doc = state.doc;
    const metrics = CORE.analyzeLoop(
      doc.channels, doc.sampleRate, state.sel.start, state.sel.end, state.sel.fadeFrames
    );
    el.metricsBody.textContent = '';
    metrics.channels.forEach((m, idx) => {
      const rawTr = document.createElement('tr');
      const chTd = document.createElement('td');
      chTd.rowSpan = 2;
      const badge = document.createElement('span');
      badge.className = 'ch-badge';
      badge.textContent = doc.channels.length === 1 ? 'M' : (idx === 0 ? 'L' : 'R');
      badge.title = CH_NAMES[idx] || ('声道 ' + idx);
      chTd.appendChild(badge);
      rawTr.appendChild(chTd);

      const rawLabel = document.createElement('td');
      rawLabel.innerHTML = '<span class="row-label">原样</span>';
      rawTr.appendChild(rawLabel);
      rawTr.appendChild(jumpCell(m.headJumpRaw, 'x[start] − x[start−1]'));
      rawTr.appendChild(jumpCell(m.tailJumpRaw, 'x[end] − x[end−1]'));
      rawTr.appendChild(jumpCell(m.seamJumpRaw, 'x[start] − x[end−1]'));
      rawTr.appendChild(rmsCell(m.headRmsRaw));
      rawTr.appendChild(rmsCell(m.tailRmsRaw));
      el.metricsBody.appendChild(rawTr);

      const proTr = document.createElement('tr');
      proTr.className = 'processed-row' + (metrics.valid ? '' : ' invalid');
      const proLabel = document.createElement('td');
      const labelText = metrics.valid
        ? (state.sel.fadeFrames > 0 ? '淡化后' : '处理后')
        : '处理后';
      proLabel.innerHTML = '<span class="row-label">' + labelText + '</span>';
      proTr.appendChild(proLabel);
      if (!metrics.valid) {
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'empty-cell';
        td.textContent = '参数无效，无法计算处理后指标';
        proTr.appendChild(td);
      } else {
        proTr.appendChild(jumpCell(m.headJumpProcessed, 'P[0] − x[start−1]'));
        proTr.appendChild(jumpCell(m.tailJumpProcessed, 'x[end] − P[L−1]'));
        proTr.appendChild(jumpCell(m.seamJumpProcessed, 'P[0] − P[L−1]'));
        proTr.appendChild(rmsCell(m.headRmsProcessed));
        proTr.appendChild(rmsCell(m.tailRmsProcessed));
      }
      el.metricsBody.appendChild(proTr);
    });

    if (metrics.valid && state.sel.fadeFrames > 0) {
      const parts = metrics.channels.map((m, idx) => {
        const name = doc.channels.length === 1 ? 'M' : (idx === 0 ? 'L' : 'R');
        return name + ' ' + Math.abs(m.seamJumpRaw).toFixed(5) + ' → ' +
          Math.abs(m.seamJumpProcessed).toFixed(5);
      });
      el.fadeMetricNote.textContent = '回绕接缝跳变（原样 → 淡化后）：' + parts.join('；') +
        '。首帧完全取 end 之后预留音频，末帧与原头部末帧完全一致。';
    } else {
      el.fadeMetricNote.textContent = '';
    }
  }

  /* ---------------- 试听 ---------------- */

  function ensureAudio() {
    if (!audio.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.gain = audio.ctx.createGain();
      audio.gain.connect(audio.ctx.destination);
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return audio.ctx;
  }

  /* 缓冲按（声道数, 帧数, 处理参数, 模式）缓存：切换处理前后时无需重建，交接更顺滑。 */
  const bufferCache = new Map();
  function audioBufferFor(mode, channels) {
    const key = mode + ':' + state.doc.sha256 + ':' + channels.length + ':' +
      channels[0].length + ':' + state.doc.sampleRate + ':' + state.sel.start + ':' +
      state.sel.end + ':' + state.sel.fadeFrames;
    const cached = bufferCache.get(key);
    if (cached) return cached;
    const ctx = ensureAudio();
    const buf = ctx.createBuffer(channels.length, channels[0].length, state.doc.sampleRate);
    for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
    if (bufferCache.size > 4) {
      const first = bufferCache.keys().next().value;
      bufferCache.delete(first);
    }
    bufferCache.set(key, buf);
    return buf;
  }

  function makeAudioBuffer(mode, channels) {
    return audioBufferFor(mode, channels);
  }

  function auditionChannels(mode) {
    if (!state.doc) return null;
    if (mode === 'processed') return processedChannels();
    const key = 'raw:' + state.sel.start + ':' + state.sel.end + ':' + state.doc.sha256;
    if (state.rawCache && state.rawCache.key === key) return state.rawCache.channels;
    const channels = CORE.sliceLoop(state.doc.channels, state.sel.start, state.sel.end);
    state.rawCache = { key, channels };
    return channels;
  }

  function currentPlayState() {
    const L = loopLengthSeconds();
    if (!audio.ctx || !audio.source || !L) {
      return {
        pos: state.playOffset / (state.doc ? state.doc.sampleRate : 1),
        wraps: audio.wraps || 0,
      };
    }
    // 位置从 posStart 时刻起由 posOffset 开始推进；源本身的启动时刻另计（20ms 提前量）。
    const since = audio.ctx.currentTime - audio.posStart;
    if (since <= 0) return { pos: audio.posOffset, wraps: audio.wraps };
    const moved = audio.posOffset + since;
    return { pos: moved % L, wraps: audio.wraps + Math.floor(moved / L) };
  }

  function startPlayback(mode, offsetSeconds, wraps, opts) {
    if (!state.doc) return;
    const check = validateCurrent();
    if (mode === 'processed' && !check.ok) {
      notice('循环参数无效，无法试听处理后音频：' + check.errors.map((e) => e.message).join(' '), 'error');
      return;
    }
    const channels = auditionChannels(mode);
    if (!channels) return;
    const ctx = ensureAudio();
    const L = channels[0].length / state.doc.sampleRate;
    if (!(L > 0)) return;
    const options = opts || {};
    const now = ctx.currentTime;
    const when = now + (options.immediate ? 0 : 0.02);
    // 模式切换时旧源会继续播到 when，因此新源要在 when 时刻对上“当时的循环内位置”。
    const lead = options.compensate ? when - now : 0;
    const offset = ((offsetSeconds + lead) % L + L) % L;

    const buffer = makeAudioBuffer(mode, channels);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    src.connect(audio.gain);
    src.start(when, offset);

    if (audio.source) {
      const old = audio.source;
      const stopAt = options.compensate ? when : now;
      try { old.stop(Math.max(0, stopAt)); } catch (_) { /* 已停止 */ }
      setTimeout(() => { try { old.disconnect(); } catch (_) { /* 忽略 */ } },
        Math.max(0, (when - now) * 1000) + 250);
    }

    audio.source = src;
    audio.mode = mode;
    audio.startCtxTime = when;
    audio.offsetSeconds = offset;
    // 显示用的位置基准：补偿切换时旧源会一直响到 when，所以位置从 now 起算；
    // 普通启动时源在 when 才发声，位置也从 when 起算。
    audio.posOffset = options.compensate ? ((offsetSeconds + L) % L) : offset;
    audio.posStart = options.compensate ? now : when;
    audio.wraps = wraps || 0;
    state.playing = true;
    state.mode = mode;
    state.playOffset = audio.posOffset * state.doc.sampleRate;
    updateAuditionUI();
    startPlayLoop();
    prefetchBuffers();
  }

  function stopPlayback(updateUI) {
    if (audio.source) {
      // 停止前先把当前循环内位置记录下来，再次播放从这里继续
      const { pos } = currentPlayState();
      if (state.doc && isFinite(pos)) {
        state.playOffset = clamp(pos * state.doc.sampleRate, 0, Math.max(0, loopLength() - 1));
      }
      try { audio.source.stop(); } catch (_) { /* 已停止 */ }
      try { audio.source.disconnect(); } catch (_) { /* 忽略 */ }
      audio.source = null;
    }
    state.playing = false;
    if (updateUI !== false) {
      updateAuditionUI();
      renderAll();
    }
  }

  let rafId = 0;
  function startPlayLoop() {
    if (rafId) return;
    const tick = () => {
      if (!state.playing) { rafId = 0; return; }
      const { pos, wraps } = currentPlayState();
      const sr = state.doc.sampleRate;
      el.playPosition.textContent = fmtTime(pos) + ' / ' + fmtTime(loopLengthSeconds(), true) +
        '（第 ' + fmtFrames(Math.round(pos * sr)) + ' 帧）';
      el.loopCounter.textContent = String(wraps);
      renderAll();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!state.doc) return;
    if (state.playing) {
      stopPlayback(true);
      return;
    }
    const mode = state.mode;
    const check = validateCurrent();
    const useMode = (mode === 'processed' && !check.ok) ? 'raw' : mode;
    const offset = (state.playOffset || 0) / state.doc.sampleRate;
    startPlayback(useMode, offset, 0);
  }

  function updateAuditionUI() {
    const hasDoc = !!state.doc;
    const check = validateCurrent();
    el.btnPlay.disabled = !hasDoc;
    el.btnPlay.classList.toggle('playing', state.playing);
    el.btnPlay.textContent = state.playing ? '■ 停止' : '▶ 试听循环';
    el.playTag.textContent = state.playing
      ? (state.mode === 'raw' ? '处理前 · 循环中' : '处理后 · 循环中')
      : '已停止';
    el.monitorRaw.disabled = !hasDoc;
    el.monitorProcessed.disabled = !hasDoc || !check.ok;
    el.monitorRaw.classList.toggle('active', state.mode === 'raw');
    el.monitorProcessed.classList.toggle('active', state.mode === 'processed');
    if (!hasDoc) {
      el.playPosition.textContent = '—';
      el.loopCounter.textContent = '0';
    } else if (!state.playing) {
      const sr = state.doc.sampleRate;
      el.playPosition.textContent = fmtTime((state.playOffset || 0) / sr) + ' / ' +
        fmtTime(loopLengthSeconds(), true) + '（第 ' + fmtFrames(state.playOffset || 0) + ' 帧）';
    }
  }

  function switchMode(mode) {
    if (!state.doc) return;
    if (mode === 'processed' && !validateCurrent().ok) return;
    if (state.playing) {
      const cur = currentPlayState();
      startPlayback(mode, cur.pos, cur.wraps, { compensate: true });
    } else {
      state.mode = mode;
      updateAuditionUI();
      renderAll();
    }
  }

  /* ---------------- 工程 ---------------- */

  function updateProjectUI() {
    if (!state.doc) {
      el.projectStatus.textContent = '工程：未导入素材';
      el.exportStatus.textContent = '导出：—';
      return;
    }
    const doc = state.doc;
    if (!state.projectSaved) {
      el.projectStatus.textContent = state.projectDirty
        ? '工程：未保存（参数已更改）'
        : '工程：未保存';
    } else if (state.projectDirty) {
      el.projectStatus.textContent = '工程：已保存 · 当前参数有未保存更改';
    } else {
      el.projectStatus.textContent = '工程：已保存（' + state.projectSaved.name + '）';
    }
    el.projectStatus.title = state.projectSaved ? state.projectSaved.path || '' : '';
    if (state.lastExport) {
      el.exportStatus.textContent = '导出：' + state.lastExport.name + ' · ' +
        fmtFrames(state.lastExport.frames) + ' 帧 · smpl [0, ' +
        fmtFrames(state.lastExport.frames - 1) + '] 前向无限循环';
      el.exportStatus.title = state.lastExport.detail || '';
    }
  }

  /* ------------------------------------------------------------------ *
   * 波形渲染
   * ------------------------------------------------------------------ */

  function renderAll() {
    clampView();
    renderWave();
    renderOverview();
    el.viewInfo.textContent = state.doc
      ? (state.view.fpp >= 1
        ? state.view.fpp.toFixed(1) + ' 帧/像素'
        : (1 / state.view.fpp).toFixed(1) + ' 像素/帧')
      : '';
    updateButtons();
  }

  function setupCanvas(canvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH, dpr };
  }

  function renderWave() {
    const stageRect = el.waveStage.getBoundingClientRect();
    const width = Math.max(1, Math.round(stageRect.width));
    const height = layoutHeight();
    el.waveStage.style.height = height + 'px';
    const { ctx, w, h } = setupCanvas(el.waveCanvas, width, height);
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, w, h);

    if (!state.doc) {
      drawRuler(ctx, w, null);
      el.emptyHint.hidden = false;
      return;
    }

    const doc = state.doc;
    const fpp = state.view.fpp;
    const viewStart = state.view.start;
    const { start, end, fadeFrames } = state.sel;

    // 标尺
    drawRuler(ctx, w, doc);

    const chanCount = doc.channels.length;
    for (let c = 0; c < chanCount; c++) {
      drawLane(ctx, w, c, doc, viewStart, fpp);
    }

    // 选区外遮罩
    const sx0 = xAtFrame(start);
    const sx1 = xAtFrame(end);
    ctx.fillStyle = 'rgba(6, 10, 15, 0.62)';
    if (sx0 > 0) ctx.fillRect(0, RULER_H, Math.min(w, sx0), h - RULER_H);
    if (sx1 < w) ctx.fillRect(Math.max(0, sx1), RULER_H, w - Math.max(0, sx1), h - RULER_H);

    // 选区底色
    const selLeft = Math.max(0, sx0);
    const selRight = Math.min(w, sx1);
    if (selRight > selLeft) {
      ctx.fillStyle = 'rgba(76, 194, 255, 0.08)';
      ctx.fillRect(selLeft, RULER_H, selRight - selLeft, h - RULER_H);
    }

    // 后卷预留区（end 之后 F 帧）
    if (fadeFrames > 0) {
      const postL = Math.max(0, sx1);
      const postR = Math.min(w, xAtFrame(end + fadeFrames));
      if (postR > postL) {
        ctx.save();
        ctx.fillStyle = 'rgba(240, 182, 87, 0.16)';
        ctx.fillRect(postL, RULER_H, postR - postL, h - RULER_H);
        ctx.strokeStyle = 'rgba(240, 182, 87, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(postL + 0.5, RULER_H + 0.5, Math.max(0, postR - postL - 1), h - RULER_H - 1);
        ctx.restore();
        if (postR - postL > 46) {
          ctx.save();
          ctx.fillStyle = 'rgba(240, 182, 87, 0.9)';
          ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
          ctx.textBaseline = 'top';
          ctx.fillText('预留 ' + fmtFrames(fadeFrames) + ' 帧', postL + 5, RULER_H + 4);
          ctx.restore();
        }
      }
      // 头部淡化区
      const headL = Math.max(0, sx0);
      const headR = Math.min(w, xAtFrame(start + fadeFrames));
      if (headR > headL) {
        const grad = ctx.createLinearGradient(headL, 0, headR, 0);
        grad.addColorStop(0, 'rgba(76, 194, 255, 0.34)');
        grad.addColorStop(1, 'rgba(76, 194, 255, 0.06)');
        ctx.fillStyle = grad;
        ctx.fillRect(headL, RULER_H, headR - headL, h - RULER_H);
      }
    }

    // 边界线与手柄
    drawHandle(ctx, sx0, h, 'start', start, true);
    drawHandle(ctx, sx1, h, 'end', end, false);

    // 播放头
    let playFrameAbs = null;
    if (state.playing) {
      const { pos } = currentPlayState();
      playFrameAbs = start + pos * doc.sampleRate;
    } else if (state.playOffset > 0) {
      playFrameAbs = start + state.playOffset;
    }
    if (playFrameAbs != null) {
      const px = xAtFrame(playFrameAbs);
      if (px >= -1 && px <= w + 1) {
        ctx.save();
        ctx.strokeStyle = '#ff7d8e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, RULER_H);
        ctx.lineTo(px, h);
        ctx.stroke();
        ctx.fillStyle = '#ff7d8e';
        ctx.beginPath();
        ctx.arc(px, RULER_H + 5, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 空状态提示在 DOM 中，无需画
    el.emptyHint.hidden = !!state.doc;
  }

  function drawRuler(ctx, w, doc) {
    ctx.save();
    ctx.fillStyle = 'rgba(13, 19, 27, 0.9)';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(38, 48, 61, 0.9)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();
    if (!doc) { ctx.restore(); return; }
    const sr = doc.sampleRate;
    const span = w * state.view.fpp;
    // 选择合适的时间刻度
    const target = span / sr / 8; // 大约 8 个刻度
    const steps = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s >= target) { step = s; break; } }
    const startSec = state.view.start / sr;
    const endSec = startSec + span / sr;

    // 放大到 1 帧约 ≥ 2.5 像素时，额外画出每一帧的刻度与帧号，
    // 让“采样帧”这一单位在界面上真正可见、可直接数。
    const ppf = 1 / state.view.fpp;
    if (ppf >= 2.5) {
      // 刻度按 1-2-5 选步长，保证标签之间的空隙足够
      const rawStep = Math.max(1, Math.ceil(72 / ppf));
      const steps2 = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
      let labelEvery = steps2[steps2.length - 1];
      for (const st of steps2) { if (st >= rawStep) { labelEvery = st; break; } }
      ctx.font = '9.5px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'middle';
      const f0 = Math.floor(state.view.start);
      const f1 = Math.ceil(state.view.start + span);
      for (let f = f0; f <= f1; f++) {
        const x = Math.round((f - state.view.start) * ppf) + 0.5;
        if (x < -2 || x > w + 2) continue;
        const major = f % labelEvery === 0;
        ctx.strokeStyle = major ? 'rgba(120, 140, 160, 0.55)' : 'rgba(74, 88, 104, 0.25)';
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - (major ? 8 : 4));
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = '#8695a4';
          ctx.fillText(fmtFrames(f), x + 3, 8);
        }
      }
    }

    ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    // 刻度小于 1ms 时改用“秒.毫秒/微秒”表示，避免多个刻度显示成同一时间
    const decimals = step >= 0.1 ? 3 : step >= 0.01 ? 4 : step >= 0.001 ? 5 : 6;
    const first = Math.ceil(startSec / step) * step;
    for (let t = first; t <= endSec + 1e-9; t += step) {
      if (ppf >= 2.5) {
        // 采样级视图里帧号优先，时间刻度只保留竖线
        const x = (t * sr - state.view.start) / state.view.fpp;
        if (x < -2 || x > w + 2) continue;
        ctx.strokeStyle = 'rgba(110, 130, 150, 0.35)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H - 11);
        ctx.lineTo(Math.round(x) + 0.5, RULER_H);
        ctx.stroke();
        continue;
      }
      const x = (t * sr - state.view.start) / state.view.fpp;
      if (x < -60 || x > w + 60) continue;
      ctx.strokeStyle = 'rgba(74, 88, 104, 0.55)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H - 7);
      ctx.lineTo(Math.round(x) + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillStyle = '#6b7885';
      ctx.fillText(fmtTime(t, true, decimals), Math.round(x) + 4, 9);
    }
    ctx.restore();
  }

  function drawLane(ctx, w, c, doc, viewStart, fpp) {
    const lane = laneRect(c);
    const color = CH_COLORS[c % CH_COLORS.length];
    const amp = lane.height / 2 - 6;
    const mid = lane.mid;

    // 底
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.012)';
    ctx.fillRect(0, lane.top, w, lane.height);
    ctx.strokeStyle = 'rgba(74, 88, 104, 0.28)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    // 声道标签
    ctx.fillStyle = 'rgba(154, 167, 180, 0.7)';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(doc.channels.length === 1 ? 'M' : (c === 0 ? 'L' : 'R'), 7, lane.top + 6);
    ctx.restore();

    const ch = doc.channels[c];
    const viewEnd = viewStart + w * fpp;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, lane.top, w, lane.height);
    ctx.clip();

    if (fpp >= 8) {
      // 峰值图：使用金字塔
      const level = pickPeakLevel(fpp);
      const step = level ? level.factor : 1;
      const mins = level ? level.mins[c] : null;
      const maxs = level ? level.maxs[c] : null;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.78;
      for (let x = 0; x < w; x++) {
        const f0 = viewStart + x * fpp;
        const f1 = f0 + fpp;
        let mn = Infinity;
        let mx = -Infinity;
        if (step === 1) {
          const a = Math.max(0, Math.floor(f0));
          const b = Math.min(ch.length, Math.ceil(f1));
          for (let i = a; i < b; i++) { if (ch[i] < mn) mn = ch[i]; if (ch[i] > mx) mx = ch[i]; }
        } else {
          let a = Math.max(0, Math.floor(f0 / step));
          let b = Math.min(mins.length, Math.ceil(f1 / step));
          if (b <= a) b = Math.min(mins.length, a + 1);
          for (let i = a; i < b; i++) { if (mins[i] < mn) mn = mins[i]; if (maxs[i] > mx) mx = maxs[i]; }
        }
        if (!isFinite(mn)) continue;
        const yTop = mid - mx * amp;
        const yBot = mid - mn * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    } else {
      // 采样级：逐点连线；播放头所在帧高亮
      const from = Math.max(0, Math.floor(viewStart) - 1);
      const to = Math.min(ch.length, Math.ceil(viewEnd) + 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const x = (i - viewStart) / fpp;
        const y = mid - ch[i] * amp;
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (fpp <= 0.26) { // 每帧 >= ~4px 时画采样点
        ctx.fillStyle = color;
        for (let i = from; i < to; i++) {
          const x = (i - viewStart) / fpp;
          const y = mid - ch[i] * amp;
          ctx.beginPath();
          ctx.arc(x, y, 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 零线
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHandle(ctx, x, h, kind, frame, isStart) {
    if (x < -2 || x > canvasMetrics().width + 2) return;
    const color = isStart ? '#4cc2ff' : '#f0b657';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, RULER_H - 2);
    ctx.lineTo(Math.round(x) + 0.5, h - 2);
    ctx.stroke();

    // 顶部手柄
    const y = RULER_H - 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (isStart) {
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 9, y);
      ctx.lineTo(x + 0.5, y + 9);
    } else {
      ctx.moveTo(x - 0.5, y);
      ctx.lineTo(x - 9, y);
      ctx.lineTo(x - 0.5, y + 9);
    }
    ctx.closePath();
    ctx.fill();

    // 帧号标签
    const label = (isStart ? 'start ' : 'end ') + fmtFrames(frame);
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    const tw = ctx.measureText(label).width;
    let lx = isStart ? x + 6 : x - tw - 6;
    lx = clamp(lx, 2, canvasMetrics().width - tw - 2);
    const ly = h - 20;
    ctx.fillStyle = 'rgba(8, 12, 18, 0.85)';
    ctx.fillRect(lx - 3, ly - 2, tw + 6, 15);
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    ctx.fillText(label, lx, ly);
    ctx.restore();
  }

  /* ---------------- 总览 ---------------- */

  function renderOverview() {
    const rect = el.overviewCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = 46;
    const { ctx } = setupCanvas(el.overviewCanvas, w, h);
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, w, h);
    if (!state.doc) return;
    const doc = state.doc;
    const lanes = doc.channels.length;
    for (let c = 0; c < lanes; c++) {
      const top = lanes === 1 ? 4 : c * (h / 2) + 2;
      const laneH = lanes === 1 ? h - 8 : h / 2 - 4;
      const mid = top + laneH / 2;
      const amp = laneH / 2;
      const color = CH_COLORS[c % CH_COLORS.length];
      const ch = doc.channels[c];
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.65;
      const framesPerPx = doc.frames / w;
      const level = pickPeakLevel(framesPerPx);
      if (level) {
        const mins = level.mins[c];
        const maxs = level.maxs[c];
        for (let x = 0; x < w; x++) {
          const a = Math.floor((x * doc.frames) / w / level.factor);
          const b = Math.max(a + 1, Math.floor(((x + 1) * doc.frames) / w / level.factor));
          let mn = 0;
          let mx = 0;
          for (let i = a; i < b && i < mins.length; i++) {
            if (mins[i] < mn) mn = mins[i];
            if (maxs[i] > mx) mx = maxs[i];
          }
          const y0 = mid - mx * amp;
          const y1 = mid - mn * amp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
      } else {
        for (let x = 0; x < w; x++) {
          const a = Math.floor((x * doc.frames) / w);
          const b = Math.max(a + 1, Math.floor(((x + 1) * doc.frames) / w));
          let mn = 0;
          let mx = 0;
          for (let i = a; i < b && i < ch.length; i++) {
            if (ch[i] < mn) mn = ch[i];
            if (ch[i] > mx) mx = ch[i];
          }
          const y0 = mid - mx * amp;
          const y1 = mid - mn * amp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
      }
      ctx.globalAlpha = 1;
    }

    // 选区
    const sx0 = (state.sel.start / doc.frames) * w;
    const sx1 = (state.sel.end / doc.frames) * w;
    ctx.fillStyle = 'rgba(76, 194, 255, 0.2)';
    ctx.fillRect(sx0, 0, Math.max(1, sx1 - sx0), h);
    ctx.strokeStyle = 'rgba(76, 194, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx0 + 0.5, 0); ctx.lineTo(sx0 + 0.5, h);
    ctx.moveTo(sx1 - 0.5, 0); ctx.lineTo(sx1 - 0.5, h);
    ctx.stroke();

    // 视口
    const vx0 = (state.view.start / doc.frames) * w;
    const vx1 = ((state.view.start + viewSpanFrames()) / doc.frames) * w;
    ctx.strokeStyle = 'rgba(230, 237, 243, 0.55)';
    ctx.strokeRect(vx0 + 0.5, 1.5, Math.max(2, vx1 - vx0 - 1), h - 3);
  }

  /* ------------------------------------------------------------------ *
   * 波形交互
   * ------------------------------------------------------------------ */

  function hitTest(x) {
    if (!state.doc) return null;
    const xs = xAtFrame(state.sel.start);
    const xe = xAtFrame(state.sel.end);
    if (Math.abs(x - xs) <= HANDLE_GRAB) return 'start';
    if (Math.abs(x - xe) <= HANDLE_GRAB) return 'end';
    return null;
  }

  function pointerX(ev) {
    const rect = el.waveCanvas.getBoundingClientRect();
    return ev.clientX - rect.left;
  }

  el.waveCanvas.addEventListener('pointerdown', (ev) => {
    if (!state.doc) return;
    const x = pointerX(ev);
    const y = ev.clientY - el.waveCanvas.getBoundingClientRect().top;
    if (y < RULER_H - 10) return;
    const hit = hitTest(x);
    el.waveCanvas.setPointerCapture(ev.pointerId);
    if (state.playing) stopPlayback(false);
    if (ev.shiftKey || ev.button === 1) {
      state.drag = { mode: 'pan', x, viewStart: state.view.start };
      el.waveStage.classList.add('panning');
      return;
    }
    if (hit) {
      state.drag = { mode: 'adjust', which: hit, x, start: state.sel.start, end: state.sel.end };
      el.waveStage.classList.add('adjusting');
      return;
    }
    const anchor = clamp(Math.round(frameAtX(x)), 0, state.doc.frames);
    state.drag = { mode: 'select', x, anchorFrame: anchor, moved: false };
    el.waveStage.classList.add('adjusting');
  });

  el.waveCanvas.addEventListener('pointermove', (ev) => {
    if (!state.doc) return;
    const x = pointerX(ev);
    const frame = frameAtX(x);
    const inDoc = frame >= 0 && frame <= state.doc.frames;
    if (inDoc) {
      el.cursorInfo.textContent = '光标：帧 ' + fmtFrames(Math.floor(frame)) + ' · ' +
        fmtTime(frame / state.doc.sampleRate);
    } else {
      el.cursorInfo.textContent = '光标：—';
    }
    if (!state.drag) {
      const hit = hitTest(x);
      el.waveStage.classList.toggle('adjusting', !!hit);
      return;
    }
    const drag = state.drag;
    if (drag.mode === 'pan') {
      const dx = x - drag.x;
      const span = viewSpanFrames();
      state.view.start = drag.viewStart - dx * state.view.fpp;
      clampView();
      renderAll();
      return;
    }
    if (drag.mode === 'select') {
      if (Math.abs(x - drag.x) > 2) drag.moved = true;
      if (!drag.moved) return;
      const cur = clamp(Math.round(frameAtX(x)), 0, state.doc.frames);
      let a = Math.min(drag.anchorFrame, cur);
      let b = Math.max(drag.anchorFrame, cur) + (cur >= drag.anchorFrame ? 1 : 0);
      if (b - a < 1) b = Math.min(state.doc.frames, a + 1);
      if (a >= b) a = Math.max(0, b - 1);
      state.sel.start = a;
      state.sel.end = b;
      invalidateProcessed();
      syncAfterEdit();
      markDirty();
      refreshAll();
      return;
    }
    if (drag.mode === 'adjust') {
      const f = clamp(Math.round(frameAtX(x)), 0, state.doc.frames);
      if (drag.which === 'start') {
        const s = clamp(f, 0, state.sel.end - 1);
        state.sel.start = s;
      } else {
        const e = clamp(f, state.sel.start + 1, state.doc.frames);
        state.sel.end = e;
      }
      invalidateProcessed();
      syncAfterEdit();
      markDirty();
      refreshAll();
    }
  });

  function endDrag(ev) {
    if (!state.drag) return;
    const drag = state.drag;
    state.drag = null;
    el.waveStage.classList.remove('panning', 'adjusting');
    if (ev && el.waveCanvas.hasPointerCapture(ev.pointerId)) {
      el.waveCanvas.releasePointerCapture(ev.pointerId);
    }
    if (drag.mode === 'select' && !drag.moved) {
      // 单击：在循环内定位
      const frame = clamp(Math.round(frameAtX(pointerX(ev))), 0, state.doc.frames);
      seekToFrame(frame);
    }
    refreshAll();
  }

  el.waveCanvas.addEventListener('pointerup', endDrag);
  el.waveCanvas.addEventListener('pointercancel', endDrag);

  function prefetchBuffers() {
    if (!state.doc) return;
    try {
      const proc = processedChannels();
      if (proc) audioBufferFor('processed', proc);
      audioBufferFor('raw', auditionChannels('raw'));
    } catch (_) { /* 预取失败不影响正常播放 */ }
  }

  function seekToFrame(absFrame) {
    if (!state.doc) return;
    const L = loopLength();
    if (L <= 0) return;
    let rel = absFrame - state.sel.start;
    if (rel < 0) rel = 0;
    if (rel >= L) rel = L - 1;
    state.playOffset = rel;
    if (state.playing) {
      const cur = currentPlayState();
      startPlayback(state.mode, rel / state.doc.sampleRate, cur.wraps, { immediate: true });
    } else {
      updateAuditionUI();
    }
    renderAll();
  }

  el.waveCanvas.addEventListener('wheel', (ev) => {
    if (!state.doc) return;
    ev.preventDefault();
    const x = pointerX(ev);
    if (ev.shiftKey) {
      state.view.start += (ev.deltaY + ev.deltaX) * state.view.fpp * 2;
      clampView();
      renderAll();
    } else {
      const factor = ev.deltaY < 0 ? 1.35 : 1 / 1.35;
      zoomAt(factor, x);
    }
  }, { passive: false });

  el.overviewCanvas.addEventListener('pointerdown', (ev) => {
    if (!state.doc) return;
    const rect = el.overviewCanvas.getBoundingClientRect();
    const frac = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    const frame = frac * state.doc.frames;
    const span = viewSpanFrames();
    state.view.start = clamp(frame - span / 2, 0, Math.max(0, state.doc.frames - span));
    clampView();
    renderAll();
  });

  el.btnZoomIn.addEventListener('click', () => zoomAt(1.6));
  el.btnZoomOut.addEventListener('click', () => zoomAt(1 / 1.6));
  el.btnZoomFit.addEventListener('click', zoomFit);

  /* ------------------------------------------------------------------ *
   * 数字输入
   * ------------------------------------------------------------------ */

  function commitStartInput() {
    if (!state.doc) return;
    const raw = el.startInput.value.trim();
    const v = Number(raw);
    if (raw === '' || !isFinite(v)) {
      el.startInput.value = String(state.sel.start);
      notice('起点输入无效，已还原。', 'warn');
      return;
    }
    const clamped = clamp(Math.round(v), 0, state.sel.end - 1);
    if (clamped !== Math.round(v)) {
      notice('起点已限制在 0 … ' + fmtFrames(state.sel.end - 1) + '（必须小于终点）。', 'warn');
    }
    el.startInput.value = String(clamped);
    setSelection(clamped, state.sel.end);
  }

  function commitEndInput() {
    if (!state.doc) return;
    const raw = el.endInput.value.trim();
    const v = Number(raw);
    if (raw === '' || !isFinite(v)) {
      el.endInput.value = String(state.sel.end);
      notice('终点输入无效，已还原。', 'warn');
      return;
    }
    const clamped = clamp(Math.round(v), state.sel.start + 1, state.doc.frames);
    if (clamped !== Math.round(v)) {
      notice('终点已限制在 ' + fmtFrames(state.sel.start + 1) + ' … ' +
        fmtFrames(state.doc.frames) + '。', 'warn');
    }
    el.endInput.value = String(clamped);
    setSelection(state.sel.start, clamped);
  }

  el.startInput.addEventListener('change', commitStartInput);
  el.endInput.addEventListener('change', commitEndInput);
  el.startInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitStartInput(); el.startInput.blur(); } });
  el.endInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitEndInput(); el.endInput.blur(); } });

  el.startMinus.addEventListener('click', () => setSelection(state.sel.start - 1, state.sel.end));
  el.startPlus.addEventListener('click', () => setSelection(state.sel.start + 1, state.sel.end));
  el.endMinus.addEventListener('click', () => setSelection(state.sel.start, state.sel.end - 1));
  el.endPlus.addEventListener('click', () => setSelection(state.sel.start, state.sel.end + 1));

  el.fadeSlider.addEventListener('input', () => {
    const ms = Number(el.fadeSlider.value);
    el.fadeMsInput.value = ms ? ms.toFixed(2) : '0';
    setFadeMs(ms);
  });

  function commitFadeMs() {
    if (!state.doc) return;
    const raw = el.fadeMsInput.value.trim();
    let ms = Number(raw);
    if (raw === '' || !isFinite(ms)) {
      el.fadeMsInput.value = CORE.fadeMsForFrames(state.sel.fadeFrames, state.doc.sampleRate).toFixed(2);
      return;
    }
    ms = clamp(ms, 0, CORE.MAX_FADE_MS);
    setFadeMs(ms);
  }
  el.fadeMsInput.addEventListener('change', commitFadeMs);
  el.fadeMsInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitFadeMs(); el.fadeMsInput.blur(); } });

  function commitFadeFrames() {
    if (!state.doc) return;
    const raw = el.fadeFramesInput.value.trim();
    const v = Number(raw);
    if (raw === '' || !isFinite(v)) {
      el.fadeFramesInput.value = String(state.sel.fadeFrames);
      return;
    }
    setFadeFrames(v);
  }
  el.fadeFramesInput.addEventListener('change', commitFadeFrames);
  el.fadeFramesInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitFadeFrames(); el.fadeFramesInput.blur(); } });

  el.fadeFixMax.addEventListener('click', () => {
    if (!state.doc) return;
    const maxF = CORE.maxFadeFrames(
      state.doc.frames, state.sel.start, state.sel.end, state.doc.sampleRate
    );
    setFadeFrames(maxF);
  });
  el.fadeFixZero.addEventListener('click', () => setFadeFrames(0));

  el.checksumStatus.addEventListener('click', () => {
    const doc = state.doc;
    if (!doc || !doc.sha256) return;
    showInfo('源文件校验和',
      doc.name + '\n' + doc.size.toLocaleString('en-US') + ' 字节 · ' +
      doc.sampleRate + ' Hz · ' + doc.bits + ' 位 · ' + doc.channels.length + ' 声道 · ' +
      doc.frames.toLocaleString('en-US') + ' 帧\n\nSHA-256\n' + doc.sha256);
  });

  el.btnPlay.addEventListener('click', togglePlay);
  el.monitorRaw.addEventListener('click', () => switchMode('raw'));
  el.monitorProcessed.addEventListener('click', () => switchMode('processed'));

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === '+' || ev.key === '=') {
      zoomAt(1.6);
    } else if (ev.key === '-') {
      zoomAt(1 / 1.6);
    } else if (ev.key === '0') {
      zoomFit();
    } else if (ev.key === 'ArrowLeft') {
      setSelection(state.sel.start - (ev.shiftKey ? 100 * 1 : 1),
        state.sel.end - (ev.shiftKey ? 100 : 1));
    } else if (ev.key === 'ArrowRight') {
      setSelection(state.sel.start + (ev.shiftKey ? 100 : 1),
        state.sel.end + (ev.shiftKey ? 100 : 1));
    }
  });

  window.addEventListener('resize', () => {
    clampView();
    renderAll();
  });

  /* ------------------------------------------------------------------ *
   * 导入
   * ------------------------------------------------------------------ */

  async function loadFile(file, opts) {
    if (!file) return;
    const options = opts || {};
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      notice('读取文件失败：' + e.message, 'error');
      return;
    }
    let decoded;
    try {
      decoded = WAVLIB.decodeWav(buffer);
    } catch (e) {
      notice('无法导入「' + file.name + '」：' + (e.message || e), 'error');
      return;
    }
    let sha256 = '';
    try {
      sha256 = await CORE.sha256Hex(buffer);
    } catch (e) {
      sha256 = '';
    }
    const doc = {
      name: file.name,
      size: file.size,
      buffer,
      sha256,
      sampleRate: decoded.sampleRate,
      bits: decoded.bits,
      channels: decoded.channels,
      frames: decoded.frames,
      loops: decoded.loops,
      loop: decoded.loop,
    };
    stopPlayback(false);
    state.doc = doc;
    state.playOffset = 0;
    state.processedCache = null;
    state.rawCache = null;
    state.projectDirty = false;
    state.projectSaved = null;
    state.lastExport = null;
    state.mode = 'processed';
    state.peaks = buildPeaks(decoded.channels);

    if (options.applyProject) {
      applyProjectToDoc(options.applyProject, { name: options.projectName });
      return;
    }

    if (state.pendingProject) {
      const pending = state.pendingProject;
      state.pendingProject = null;
      const project = pending.project;
      const cmp = CORE.compareSource(project.source, doc);
      if (cmp.match) {
        applyProjectToDoc(project, { name: pending.fileName });
      } else {
        state.sel = { start: 0, end: decoded.frames, fadeFrames: 0 };
        state.view.start = 0;
        state.view.fpp = decoded.frames / Math.max(1, canvasMetrics().width);
        refreshAll();
        // 保留待恢复的工程：之后导入工程记录的源文件仍会自动恢复
        state.pendingProject = pending;
        showMismatch(project, cmp, pending.fileName);
      }
      return;
    }

    // 识别 smpl 前向循环标记（包括本工具导出的文件）
    if (decoded.loop) {
      const start = decoded.loop.start;
      const end = Math.min(decoded.frames, decoded.loop.endInclusive + 1);
      state.sel = { start, end, fadeFrames: 0 };
      zoomToSelection();
      refreshAll();
      const kind = decoded.loop.type === 0 ? '前向' : '类型 ' + decoded.loop.type;
      const play = decoded.loop.playCount === 0 ? '无限' : String(decoded.loop.playCount) + ' 次';
      notice('已识别 smpl 循环标记（' + kind + '，' + play + '，含端点 ' +
        fmtFrames(decoded.loop.endInclusive) + '）：切点设为 [' + fmtFrames(start) + ', ' +
        fmtFrames(end) + ')。', 'ok');
    } else {
      state.sel = { start: 0, end: decoded.frames, fadeFrames: 0 };
      state.view.start = 0;
      state.view.fpp = decoded.frames / Math.max(1, canvasMetrics().width);
      refreshAll();
      if (decoded.loops && decoded.loops.length) {
        notice('文件中存在 smpl 块，但没有可用的前向循环标记。', 'warn');
      }
    }
  }

  function zoomToSelection() {
    if (!state.doc) return;
    const { width } = canvasMetrics();
    const L = Math.max(1, state.sel.end - state.sel.start);
    const pad = Math.max(2, Math.floor(L * 0.05));
    const span = L + pad * 2;
    const frames = state.doc.frames;
    if (span >= frames) {
      state.view.fpp = frames / width;
      state.view.start = 0;
    } else {
      state.view.fpp = span / width;
      state.view.start = clamp(state.sel.start - pad, 0, frames - span);
    }
    clampView();
  }

  el.btnImport.addEventListener('click', () => {
    el.fileInput.value = '';
    el.fileInput.click();
  });
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    if (file) loadFile(file);
  });

  /* ------------------------------------------------------------------ *
   * 工程
   * ------------------------------------------------------------------ */

  el.btnProjectSave.addEventListener('click', () => {
    if (!state.doc) return;
    if (!state.doc.sha256) {
      notice('无法计算源文件校验和，不能保存工程。', 'error');
      return;
    }
    const project = CORE.createProject(
      state.doc, state.sel.start, state.sel.end, state.sel.fadeFrames
    );
    const filename = fileBaseName(state.doc.name) + '.loopproj.json';
    download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), filename);
    state.projectSaved = { name: filename, path: filename };
    state.projectDirty = false;
    updateProjectUI();
    notice('工程已保存：' + filename + '（记录源文件 SHA-256、切点与淡化参数）。', 'ok');
  });

  el.btnProjectOpen.addEventListener('click', () => {
    el.projectInput.value = '';
    el.projectInput.click();
  });

  el.projectInput.addEventListener('change', async () => {
    const file = el.projectInput.files && el.projectInput.files[0];
    el.projectInput.value = '';
    if (!file) return;
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch (e) {
      notice('工程文件不是有效的 JSON。', 'error');
      return;
    }
    const parsed = CORE.validateProject(json);
    if (!parsed.ok) {
      notice('工程文件无效：' + parsed.errors.map((e) => e.message).join(' '), 'error', true);
      return;
    }
    const project = parsed.project;
    state.pendingProject = { project, fileName: file.name };

    // 已有素材且校验和一致 → 直接应用
    if (state.doc && state.doc.sha256 && project.source.sha256 === state.doc.sha256) {
      applyProjectToDoc(project, { name: file.name });
      return;
    }
    if (state.doc) {
      // 已有素材但不匹配：列出差异并询问
      const cmp = CORE.compareSource(project.source, state.doc);
      showMismatch(project, cmp, file.name);
      return;
    }
    // 尚无素材：引导导入工程记录的源文件
    notice('工程来自「' + project.source.name + '」（' + fmtFrames(project.source.frames) +
      ' 帧）。请导入该源文件以恢复切点与淡化参数。', 'warn', true);
    el.fileInput.value = '';
    el.fileInput.click();
  });

  function applyProjectToDoc(project, opts) {
    const doc = state.doc;
    if (!doc) return;
    const options = opts || {};
    let { start, end, fadeFrames } = project.loop;
    const notes = [];
    if (end > doc.frames) {
      notes.push('终点 ' + end + ' 超出素材长度 ' + doc.frames + '，已钳制');
      end = doc.frames;
    }
    if (start >= end) {
      notes.push('起点不小于终点，已钳制');
      start = Math.max(0, end - 1);
    }
    state.sel.start = start;
    state.sel.end = end;
    let F = fadeFrames;
    const check = CORE.validateLoop({
      frames: doc.frames, start, end, fadeFrames: F, sampleRate: doc.sampleRate,
    });
    if (!check.ok) {
      notes.push('淡化参数在当前素材上无效（' + check.errors.map((e) => e.message).join(' ') +
        '），已设为 0');
      F = 0;
    }
    state.sel.fadeFrames = F;
    state.playOffset = 0;
    state.processedCache = null;
    state.rawCache = null;
    state.projectSaved = { name: options.name || '工程文件', path: '' };
    state.projectDirty = false;
    stopPlayback(false);
    zoomToSelection();
    refreshAll();
    const msg = '已恢复工程：切点 [' + fmtFrames(start) + ', ' + fmtFrames(end) + ')，F = ' + F +
      ' 帧' + (notes.length ? '。' + notes.join('；') + '。' : '。');
    notice(msg, notes.length ? 'warn' : 'ok');
    state.pendingProject = null;
  }

  function showMismatch(project, cmp, fileName) {
    el.mismatchIntro.textContent = '工程记录的源文件与当前导入的素材不一致，差异如下：';
    el.mismatchList.textContent = '';
    const diffs = cmp.differences.length ? cmp.differences : ['校验和不同'];
    diffs.forEach((d) => {
      const li = document.createElement('li');
      li.textContent = d;
      el.mismatchList.appendChild(li);
    });
    const mismatchNote = document.createElement('li');
    mismatchNote.textContent = '工程记录：' + project.source.name + ' · ' +
      fmtFrames(project.source.frames) + ' 帧 · ' + project.source.sampleRate + ' Hz · ' +
      project.source.bits + ' 位 · ' + project.source.channelCount + ' 声道';
    el.mismatchList.appendChild(mismatchNote);
    state.pendingMismatch = { project, fileName: fileName || '' };
    el.mismatchDialog.showModal();
  }

  el.mismatchCancel.addEventListener('click', () => {
    // 只放弃本次应用；保留待恢复的工程，之后导入正确的源文件仍会自动恢复。
    state.pendingMismatch = null;
    el.mismatchDialog.close();
    notice('已取消恢复工程参数。导入工程记录的源文件后仍可自动恢复。', 'warn');
  });
  el.mismatchApply.addEventListener('click', () => {
    const pending = state.pendingMismatch;
    el.mismatchDialog.close();
    state.pendingMismatch = null;
    if (pending) applyProjectToDoc(pending.project, { name: pending.fileName, force: true });
  });

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  el.btnExport.addEventListener('click', () => {
    if (!state.doc) return;
    const check = validateCurrent();
    if (!check.ok) {
      notice('无法导出：' + check.errors.map((e) => e.message).join(' '), 'error', true);
      return;
    }
    const channels = processedChannels();
    if (!channels) {
      notice('无法导出：处理失败。', 'error');
      return;
    }
    const L = channels[0].length;
    const loopMarker = { start: 0, endInclusive: L - 1, playCount: 0 };
    let buffer;
    try {
      buffer = WAVLIB.encodeWav({
        sampleRate: state.doc.sampleRate,
        bits: state.doc.bits,
        channelData: channels,
        loop: loopMarker,
      });
    } catch (e) {
      notice('导出失败：' + e.message, 'error', true);
      return;
    }
    const filename = fileBaseName(state.doc.name) + '-loop-' + state.sel.start + '-' +
      state.sel.end + '.wav';
    download(new Blob([buffer], { type: 'audio/wav' }), filename);
    state.lastExport = {
      name: filename,
      frames: L,
      detail: '源 ' + state.doc.name + ' · 切点 [' + state.sel.start + ', ' + state.sel.end +
        ') · F = ' + state.sel.fadeFrames + ' 帧 · ' + state.doc.sampleRate + ' Hz / ' +
        state.doc.bits + ' 位 / ' + state.doc.channels.length + ' 声道',
    };
    updateProjectUI();
    notice('已导出 ' + filename + '：' + fmtFrames(L) + ' 帧，smpl 前向无限循环 [0, ' +
      fmtFrames(L - 1) + ']。可再次导入验证标记。', 'ok', true);
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  /* 只读内省接口：便于自动化验收与外部集成读取播放位置（不修改任何状态）。 */
  window.LOOP_STUDIO = {
    positionFrames() {
      if (!state.doc || !state.playing) {
        return { frames: state.playOffset, wraps: 0, playing: false, clock: null };
      }
      const { pos, wraps } = currentPlayState();
      return {
        frames: pos * state.doc.sampleRate,
        wraps,
        playing: true,
        // 与 frames 同源的音频时钟（秒）；用它做跨时刻比较可避免两套时钟的量化误差
        clock: audio.ctx ? audio.ctx.currentTime : null,
      };
    },
    describe() {
      return {
        loaded: !!state.doc,
        sourceName: state.doc ? state.doc.name : null,
        frames: state.doc ? state.doc.frames : 0,
        sampleRate: state.doc ? state.doc.sampleRate : 0,
        start: state.sel.start,
        end: state.sel.end,
        fadeFrames: state.sel.fadeFrames,
        valid: validateCurrent().ok,
        mode: state.mode,
        playing: state.playing,
      };
    },
  };

  function boot() {
    // 控件行高与初始画布
    el.waveStage.style.height = layoutHeight() + 'px';
    refreshAll();
  }

  boot();
})();
