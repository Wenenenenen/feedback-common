/*
 * app.js — 循环上限限幅台交互层
 * 依赖 ccl-core.js / wav-codec.js / zip-read.js / sample-data.js（均挂全局 CCL）。
 */
(function () {
  'use strict';
  // 允许在 Node / 无 DOM 环境被 require 而不报错（纯逻辑请用 ccl-core.js）。
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const C = window.CCL;
  if (!C) { console.error('CCL core 未加载'); return; }
  const MAX_FRAMES_48K = 60 * 48000;

  const state = {
    audio: null,          // {name,N,left,right,sampleRate,origPeaks}
    zipEntries: null,
    settings: { ceiling: 16000, up: 30, down: 120 },
    locks: new Map(),
    good: null,           // 上次可行的完整 result（含 gains/outL/outR）
    candidate: null,      // 最近一次冲突求解的候选曲线
    capInfo: null,        // 按 ceiling 缓存的上限帽（换素材/ceiling 才重算）
    lastConflicts: [],
    rev: 0,
    selection: { start: 0, end: 0 },
    beforeSrc: 'interp',
    decim: {},
    timings: null,
    audioCtx: null,
    analyser: null,
    srcNode: null,
    playback: null,
    monitorToken: 0,
  };

  const $ = (id) => document.getElementById(id);
  const els = {};
  let importToken = 0; // 防止内置 fetch 与用户选文件之间的载入竞态

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheEls();
    exposeTestApi(); // 即使 Canvas 不可用，自动化句柄也要先就绪
    bindEvents();
    try { setupCanvases(); } catch (e) { console.warn('canvas init failed', e); }
    // 直接打开 file:// 也有完整可看的案例。
    loadBuiltin().catch((e) => showToast('内置案例载入失败：' + e.message, 'error'));
  }

  function cacheEls() {
    [
      'file-input', 'btn-import', 'btn-load-sample', 'case-select',
      'source-meta', 'input-ceiling', 'input-up', 'input-down', 'btn-apply',
      'solve-time', 'conflict-panel', 'conflict-list', 'lockonly-list',
      'lock-frame', 'lock-gain', 'btn-add-lock', 'lock-list', 'btn-clear-locks',
      'stat-length', 'peak-orig', 'peak-interp', 'peak-out', 'stat-gainrange',
      'wave-before', 'wave-after', 'gain-canvas',
      'wrap-before', 'wrap-after', 'wrap-gain', 'tooltip', 'toast',
      'btn-play', 'btn-stop', 'check-loop-sel', 'monitor-source', 'play-state',
      'sel-start', 'sel-end', 'sel-length', 'btn-sel-full',
      'btn-download-sel', 'btn-download-full', 'export-note',
    ].forEach((id) => { els[camel(id)] = $(id); });
    els.fileInput = $('file-input');
  }
  function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

  function bindEvents() {
    els.btnImport.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', onFilePicked);
    els.btnLoadSample.addEventListener('click', () => loadBuiltin());
    els.caseSelect.addEventListener('change', onCaseSwitch);

    els.btnApply.addEventListener('click', () => applyAndRender('button'));
    [els.inputCeiling, els.inputUp, els.inputDown].forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyAndRender('enter'); });
      // 改动后 350ms 自动提交，兼容“填完即等结果”的自动化操作。
      inp.addEventListener('input', scheduleAutoApply);
    });

    els.btnAddLock.addEventListener('click', addLockFromForm);
    [els.lockFrame, els.lockGain].forEach((i) =>
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') addLockFromForm(); }));
    els.btnClearLocks.addEventListener('click', () => {
      state.locks.clear(); renderLocks(); applyAndRender('locks-cleared');
    });

    document.querySelectorAll('[data-before-src]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-before-src]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.beforeSrc = btn.dataset.beforeSrc;
        drawBefore();
      });
    });

    bindChartInteractions();
    bindTransport();
    bindExport();

    if (typeof window.ResizeObserver === 'function') {
      let rzQ = 0;
      const ro = new ResizeObserver(() => {
        if (typeof requestAnimationFrame === 'function') {
          cancelAnimationFrame(rzQ);
          rzQ = requestAnimationFrame(() => { try { setupCanvases(); redrawAll(); } catch { /* noop */ } });
        } else {
          try { setupCanvases(); redrawAll(); } catch { /* noop */ }
        }
      });
      [els.wrapBefore, els.wrapAfter, els.wrapGain].forEach((w) => w && ro.observe(w));
    }
  }

  /* ================= 导入 ================= */

  async function loadBuiltin() {
    const token = ++importToken;
    // http(s) 下优先直接按 samples/cyclic-ceiling-cases.zip 导入，走真实 ZIP 路径；
    // file:// 或 fetch 失败时回退到内嵌的同份字节，保证双击 index.html 也能用。
    let buf = null, settings = C.builtinSample.settings || null, name = 'loop.wav';
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const resp = await fetch('samples/cyclic-ceiling-cases.zip', { cache: 'no-store' });
        if (token !== importToken) return; // 期间用户已选择其它素材
        if (resp.ok) {
          const entries = await C.Zip.unzip(await resp.arrayBuffer());
          if (token !== importToken) return;
          const sj = entries.find((e) => /settings\.json$/i.test(e.name));
          if (sj) settings = JSON.parse(new TextDecoder().decode(sj.bytes));
          const wavE = entries.find((e) => /\.wav$/i.test(e.name));
          if (wavE) {
            buf = wavE.bytes.buffer.slice(wavE.bytes.byteOffset, wavE.bytes.byteOffset + wavE.bytes.byteLength);
            name = baseName(wavE.name);
          }
        }
      } catch (e) { console.warn('fetch zip failed, using embedded sample', e); }
    }
    if (token !== importToken) return;
    if (!buf) { buf = C.builtinSample.getBuffer(); }
    applySettingsInputs(settings);
    await ingestWavBuffer(buf, name, settings);
    showToast(`已载入内置案例 ${name}（48k 双声道，4800 帧 = 0.1s）`, 'success');
  }

  async function onFilePicked(ev) {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    const token = ++importToken; // 取消任何在途的内置 fetch 载入
    try {
      const wavCases = [];
      let importedSettings = null;
      for (const file of files) {
        const buf = await file.arrayBuffer();
        if (token !== importToken) return;
        if (/\.zip$/i.test(file.name)) {
          const entries = await C.Zip.unzip(buf);
          if (token !== importToken) return;
          for (const e of entries) {
            if (/settings\.json$/i.test(e.name)) {
              try { importedSettings = JSON.parse(new TextDecoder().decode(e.bytes)); } catch { /* ignore */ }
            }
          }
          for (const e of entries) {
            if (/\.wav$/i.test(e.name)) {
              wavCases.push({ name: baseName(e.name), buf: e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength) });
            }
          }
        } else if (/\.wav$/i.test(file.name)) {
          wavCases.push({ name: file.name, buf });
        }
      }
      if (!wavCases.length) throw new Error('没有在所选文件 / ZIP 中找到 WAV');
      if (token !== importToken) return;
      state.zipEntries = wavCases;
      if (importedSettings) applySettingsInputs(importedSettings);
      renderCaseSelect(wavCases);
      await loadCaseAt(0, importedSettings);
    } catch (err) {
      if (token !== importToken) return; // 已被更新的导入取代
      console.error(err);
      showToast('导入失败：' + err.message, 'error');
    } finally {
      ev.target.value = '';
    }
  }

  function baseName(p) { return p.split('/').pop(); }

  function renderCaseSelect(cases) {
    if (cases.length > 1) {
      els.caseSelect.innerHTML = cases.map((c, i) => `<option value="${i}">${escapeHtml(c.name)}</option>`).join('');
      els.caseSelect.parentElement.hidden = false;
    } else {
      els.caseSelect.parentElement.hidden = true;
    }
  }

  async function onCaseSwitch() {
    await loadCaseAt(Number(els.caseSelect.value), currentSettingsFromInputs());
  }

  async function loadCaseAt(i, settingsOverride) {
    const c = state.zipEntries[i];
    if (!c) return;
    await ingestWavBuffer(c.buf, c.name, settingsOverride || null);
  }

  function applySettingsInputs(s) {
    if (!s) return;
    if (Number.isFinite(+s.ceiling)) els.inputCeiling.value = s.ceiling;
    if (Number.isFinite(+s.up)) els.inputUp.value = s.up;
    if (Number.isFinite(+s.down)) els.inputDown.value = s.down;
    if (s.locks != null) {
      // n 未知时 normalizeLocks 不做范围过滤；载入音频后会再按真实 n 归一。
      state.locks = new Map(C.normalizeLocks(s.locks, 0).map((l) => [l.frame, l.gain]));
    }
  }

  /** 解码 + 校验 + 重置状态 + 首次求解。 */
  async function ingestWavBuffer(buf, name, settingsOverride) {
    let wav;
    try {
      wav = C.WAV.decodeWav(buf);
    } catch (e) {
      throw new Error(`WAV 解码失败（${name}）：${e.message}`);
    }
    if (wav.channels !== 2) throw new Error(`要求双声道，${name} 是 ${wav.channels} 声道`);
    if (wav.sampleRate !== 48000) throw new Error(`要求 48 kHz，${name} 是 ${wav.sampleRate} Hz`);
    if (wav.frames > MAX_FRAMES_48K) {
      throw new Error(`时长 ${(wav.frames / 48000).toFixed(1)}s 超过 60s 上限（${name}）`);
    }
    // 新素材一旦通过校验，立即停掉旧素材的循环，避免耳朵听到与界面无关的旧缓冲。
    stopPlayback();
    if (settingsOverride) applySettingsInputs(settingsOverride);

    const left = wav.channelData[0];
    const right = wav.channelData[1];
    state.audio = {
      name, N: wav.frames, left, right, sampleRate: 48000,
      origPeaks: C.pcmPeaks(left, right),
    };
    // 用真实 n 重新过滤导入的锁。
    const n = 4 * wav.frames;
    state.locks = new Map(C.normalizeLocks(Array.from(state.locks, ([frame, gain]) => ({ frame, gain })), n)
      .map((l) => [l.frame, l.gain]));
    state.selection = { start: 0, end: n };
    state.good = null;
    state.capInfo = null;
    state.rev = 0;
    invalidateDecim();
    renderSourceMeta();
    resetStatsForNewAudio();
    renderLocks();
    syncSelectionInputs();
    applyAndRender('load');
  }

  function renderSourceMeta() {
    const a = state.audio;
    if (!a) { els.sourceMeta.textContent = '尚未载入素材。'; return; }
    const secs = a.N / 48000;
    els.sourceMeta.innerHTML =
      `<span class="ok">● 已载入</span> ${escapeHtml(a.name)}<br>` +
      `${a.N} 基率帧 · ${secs.toFixed(3)}s @48k<br>` +
      `四倍插值后 <b>${(4 * a.N).toLocaleString('en-US')}</b> 帧 @192k`;
  }

  /* ================= 设定 / 求解 ================= */

  let autoTimer = 0;
  function scheduleAutoApply() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => applyAndRender('auto'), 350);
  }

  function readSettings() {
    const ceiling = parseBounded(els.inputCeiling, 0, 32767, 'ceiling');
    const up = parseBounded(els.inputUp, 0, 65536, 'up');
    const down = parseBounded(els.inputDown, 0, 65536, 'down');
    return { ceiling, up, down };
  }
  function currentSettingsFromInputs() {
    try { return readSettings(); } catch { return { ...state.settings }; }
  }
  function parseBounded(inp, lo, hi, label) {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || inp.value.trim() === '') throw new Error(`${label} 需要是整数`);
    const r = Math.round(v);
    if (r < lo || r > hi) throw new Error(`${label} 必须在 ${lo}..${hi}`);
    if (r !== v) inp.value = String(r);
    return r;
  }

  function applyAndRender(reason) {
    clearTimeout(autoTimer); // 显式提交优先，取消尚未触发的防抖自动提交
    if (!state.audio) return null;
    let s;
    try { s = readSettings(); }
    catch (e) { showToast(e.message, 'error'); return null; }
    state.settings = s;

    const lockArr = Array.from(state.locks, ([frame, gain]) => ({ frame, gain }));
    const t0 = performance.now();
    // ceiling 不变时复用上限帽（up/down/锁微调路径省掉一整轮插值帽计算）。
    if (!state.capInfo || state.capInfo.ceiling !== s.ceiling) {
      state.capInfo = Object.assign(
        C.computeCaps(state.audio.left, state.audio.right, state.audio.N, s.ceiling),
        { ceiling: s.ceiling }
      );
    }
    let result;
    try {
      result = C.processCycle(
        { left: state.audio.left, right: state.audio.right, length: state.audio.N },
        { ...s, locks: lockArr, capInfo: state.capInfo }
      );
    } catch (e) {
      console.error(e);
      showToast('求解失败：' + e.message, 'error');
      return null;
    }
    const solveMs = performance.now() - t0;

    if (!result.ok) {
      // 冲突：同一素材上保留上次可行曲线；若是新素材首次求解，则清空旧素材统计。
      state.timings = { solveMs, at: new Date() };
      state.candidate = result;
      state.lastConflicts = result.conflicts;
      lastConflictFrames = new Set(result.conflicts.map((x) => x.frame));
      if (state.good) renderStats(state.good);
      else renderUnfeasibleStats(result);
      renderConflicts(result);
      renderSolveTime(solveMs, true, result.conflicts.length);
      document.documentElement.dataset.conflict = '1';
      document.documentElement.dataset.conflictFrames = result.conflicts.map((x) => x.frame).join(',');
      document.documentElement.dataset.lockonlyFrames = (result.lockOnlyConflicts || []).map((x) => x.frame).join(',');
      redrawAll(); // 有 state.good 时仍画上次曲线；新素材无 good 时画空状态提示
      showToast(state.good
        ? `有 ${result.conflicts.length} 个锁达不到，已保留上次可行曲线`
        : `有 ${result.conflicts.length} 个锁达不到，且当前素材没有更早的可行曲线`, 'error');
      return result;
    }

    // 可行：提交新曲线。
    state.good = result;
    state.candidate = null;
    state.lastConflicts = [];
    lastConflictFrames = null;
    state.rev++;
    state.timings = { solveMs, at: new Date() };
    C.lastResult = result;
    C.lastGoodResult = result;
    document.documentElement.dataset.conflict = '0';
    delete document.documentElement.dataset.conflictFrames;
    delete document.documentElement.dataset.lockonlyFrames;
    document.documentElement.dataset.curveReady = '1';
    document.documentElement.dataset.rev = String(state.rev);

    els.conflictPanel.hidden = true;
    renderSolveTime(solveMs, false, 0);
    renderStats(result);
    renderLocks();
    pruneResultDecim(); // 输出/gain 桶需要重建；插值/cap 桶复用
    redrawAll();
    refreshActiveLimitedPlayback();
    return result;
  }

  function renderSolveTime(ms, conflict, nConf) {
    const fullN = state.audio ? 4 * state.audio.N : 0;
    els.solveTime.classList.add('ready');
    els.solveTime.innerHTML = conflict
      ? `传播耗时 ${ms.toFixed(0)} ms · ${nConf} 个冲突 · 显示上次可行曲线`
      : `求解+逐码 ${ms.toFixed(0)} ms · ${fullN.toLocaleString('en-US')} 帧 · 第 ${state.rev} 版可行曲线`;
    els.solveTime.dataset.ms = String(Math.round(ms));
  }

  function setPeak(elKey, l, r) {
    const el = els[elKey];
    el.dataset.l = String(l);
    el.dataset.r = String(r);
    const lSpan = document.getElementById(el.id + '-l');
    const rSpan = document.getElementById(el.id + '-r');
    if (lSpan && rSpan) { lSpan.textContent = String(l); rSpan.textContent = String(r); }
  }

  function resetStatsForNewAudio() {
    const a = state.audio;
    if (!a) return;
    const n = 4 * a.N;
    els.statLength.textContent = `${a.N}→${n.toLocaleString('en-US')} 帧 / ${(n / 192000).toFixed(3)}s`;
    setPeak('peakOrig', a.origPeaks.left, a.origPeaks.right);
    setPeak('peakInterp', '—', '—');
    setPeak('peakOut', '—', '—');
    els.peakOut.className = 'stat-value';
    els.peakOut.dataset.ok = '';
    els.statGainrange.textContent = '—';
  }

  function renderStats(r) {
    const a = state.audio;
    els.statLength.textContent = `${a.N}→${r.n.toLocaleString('en-US')} 帧 / ${(r.n / 192000).toFixed(3)}s`;
    setPeak('peakOrig', a.origPeaks.left, a.origPeaks.right);
    setPeak('peakInterp', r.interpPeakL.toFixed(1), r.interpPeakR.toFixed(1));
    setPeak('peakOut', r.outPeakL, r.outPeakR);
    const ok = r.outPeakL <= r.ceiling && r.outPeakR <= r.ceiling;
    els.peakOut.className = 'stat-value ' + (ok ? 'good' : 'over');
    els.peakOut.dataset.ok = ok ? '1' : '0';
    const g = r.gains;
    let mn = 65536, mx = 0;
    for (let i = 0; i < g.length; i++) { if (g[i] < mn) mn = g[i]; if (g[i] > mx) mx = g[i]; }
    els.statGainrange.textContent = `${mn} / ${mx}`;
  }

  /** 新素材首次求解就冲突、没有“上次可行曲线”时，只展示候选范围，绝不残留旧素材统计。 */
  function renderUnfeasibleStats(r) {
    const a = state.audio;
    if (!a || !r) { resetStatsForNewAudio(); return; }
    els.statLength.textContent = `${a.N}→${r.n.toLocaleString('en-US')} 帧 / ${(r.n / 192000).toFixed(3)}s`;
    setPeak('peakOrig', a.origPeaks.left, a.origPeaks.right);
    setPeak('peakInterp', r.interpPeakL.toFixed(1), r.interpPeakR.toFixed(1));
    setPeak('peakOut', '无可行锁', '无可行锁');
    els.peakOut.className = 'stat-value over';
    els.peakOut.dataset.ok = '0';
    const g = r.gains;
    let mn = 65536, mx = 0;
    for (let i = 0; i < g.length; i++) { if (g[i] < mn) mn = g[i]; if (g[i] > mx) mx = g[i]; }
    els.statGainrange.textContent = `${mn} / ${mx}（候选）`;
  }

  function renderConflicts(result) {
    const panel = els.conflictPanel;
    panel.hidden = false;
    const lockOnlySet = new Set((result.lockOnlyConflicts || []).map((x) => x.frame));
    els.conflictList.innerHTML = result.conflicts.map((x) => {
      const pure = lockOnlySet.has(x.frame);
      const reason = pure ? '锁间步率不可达' : 'ceiling 上限传播后不可达';
      return `<li class="conflict-item" data-frame="${x.frame}" data-lock-only="${pure ? 'true' : 'false'}"
         data-kind="${pure ? 'slew' : 'ceiling'}" data-testid="conflict-item-${x.frame}">
         <span>帧 ${x.frame} <em class="conflict-reason">（${reason}）</em></span>
         <span><span class="bad">目标 ${x.target}</span> · <span class="ach">传播后仅 ${x.achievable}</span></span>
       </li>`;
    }).join('');
    els.conflictList.dataset.frames = result.conflicts.map((x) => x.frame).join(',');
    els.conflictList.dataset.lockOnlyFrames = (result.lockOnlyConflicts || []).map((x) => x.frame).join(',');
    if (result.lockOnlyConflicts && result.lockOnlyConflicts.length) {
      els.lockonlyList.innerHTML = result.lockOnlyConflicts.map((x) =>
        `<li data-frame="${x.frame}"><span>帧 ${x.frame}</span><span class="bad">${x.target}</span> · <span class="ach">最多 ${x.achievable}</span></li>`).join('');
    } else {
      els.lockonlyList.innerHTML = '<li><span>无（锁彼此兼容；不可达来自 ceiling 上限传播）</span></li>';
    }
  }

  /* ================= 锁 UI ================= */

  function addLockFromForm() {
    if (!state.audio) { showToast('请先导入素材', 'error'); return; }
    const n = 4 * state.audio.N;
    const f = Number(els.lockFrame.value);
    const g = Number(els.lockGain.value);
    if (!Number.isInteger(f) || f < 0 || f >= n) {
      showToast(`帧号需为 0..${n - 1} 的整数`, 'error'); return;
    }
    if (!Number.isInteger(g) || g < 0 || g > 65536) {
      showToast('增益需为 0..65536 的整数', 'error'); return;
    }
    state.locks.set(f, g);
    renderLocks();
    applyAndRender('add-lock');
  }

  function renderLocks() {
    const locks = Array.from(state.locks.entries()).sort((a, b) => a[0] - b[0]);
    if (!locks.length) {
      els.lockList.innerHTML = '<li class="lock-empty">暂无锁定。可在增益曲线上单击，或用上方表单精确锁定。</li>';
      return;
    }
    els.lockList.innerHTML = locks.map(([f, g]) => `
      <li data-frame="${f}">
        <span class="lock-frame">#${f}</span>
        <input class="lock-gain-input" type="number" min="0" max="65536" value="${g}"
               data-frame="${f}" aria-label="帧 ${f} 的锁定增益" data-testid="lock-gain-row-${f}"
               style="width:96px;padding:3px 6px;font-size:12px;">
        <button class="lock-del" type="button" data-del="${f}" aria-label="删除帧 ${f} 的锁"
                data-testid="lock-delete-${f}">✕</button>
      </li>`).join('');
    els.lockList.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.locks.delete(Number(btn.dataset.del));
        renderLocks(); applyAndRender('delete-lock');
      }));
    els.lockList.querySelectorAll('.lock-gain-input').forEach((inp) =>
      inp.addEventListener('change', () => {
        const f = Number(inp.dataset.frame), g = Number(inp.value);
        if (!Number.isInteger(g) || g < 0 || g > 65536) { showToast('增益需为 0..65536', 'error'); inp.value = state.locks.get(f); return; }
        state.locks.set(f, g);
        applyAndRender('edit-lock');
      }));
  }

  /* ================= Canvas 基础 ================= */

  const canvases = {};
  function setupCanvases() {
    for (const key of ['waveBefore', 'waveAfter', 'gainCanvas']) {
      const canvas = els[key];
      if (!canvas || !canvas.parentElement) continue;
      const wrap = canvas.parentElement;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) continue; // 无 canvas 实现的环境：保留 API，绘图整体跳过
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(50, wrap.clientWidth || 800), h = wrap.clientHeight || 160;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvases[key] = { canvas, ctx, w, h };
    }
  }

  function invalidateDecim() { state.decim = {}; }
  /** 新结果只需丢弃 out/gain 桶；插值桶与 cap 桶可按 key 复用（60s 时省一整轮扫描）。 */
  function pruneResultDecim() {
    for (const k of Object.keys(state.decim)) {
      if (k.startsWith('after-') || k.startsWith('gain-')) delete state.decim[k];
    }
  }

  function redrawAll() {
    drawBefore();
    drawAfter();
    drawGain();
  }

  /** 空像素列（样本数少于像素时）用最近的有效桶前向/后向补齐，避免曲线掉到 0。 */
  function fillEmptyBuckets(arrs) {
    const W = arrs[0].length;
    for (let x = 0; x < W; x++) {
      if (arrs[0][x] !== Infinity) continue;
      let src = x - 1;
      while (src >= 0 && arrs[0][src] === Infinity) src--;
      if (src < 0) {
        src = x + 1;
        while (src < W && arrs[0][src] === Infinity) src++;
        if (src >= W) { for (const a of arrs) a[x] = 0; continue; }
      }
      for (const a of arrs) a[x] = a[src];
    }
  }

  /** 由两个平面 Int16/Float 数组生成每像素 min/max 桶。 */
  function bucketsFromArrays(L, R, len, W) {
    const minL = new Float64Array(W).fill(Infinity), maxL = new Float64Array(W).fill(-Infinity);
    const minR = new Float64Array(W).fill(Infinity), maxR = new Float64Array(W).fill(-Infinity);
    for (let i = 0; i < len; i++) {
      const x = Math.min(W - 1, (i * W / len) | 0);
      let v = L[i]; if (v < minL[x]) minL[x] = v; if (v > maxL[x]) maxL[x] = v;
      v = R[i]; if (v < minR[x]) minR[x] = v; if (v > maxR[x]) maxR[x] = v;
    }
    fillEmptyBuckets([minL, maxL, minR, maxR]);
    return { minL, maxL, minR, maxR };
  }

  /** 插值 K 值桶（单位 K，显示时 /128）。 */
  function bucketsFromInterp(a, W) {
    const N = a.N;
    const minL = new Float64Array(W).fill(Infinity), maxL = new Float64Array(W).fill(-Infinity);
    const minR = new Float64Array(W).fill(Infinity), maxR = new Float64Array(W).fill(-Infinity);
    for (let i = 0; i < N; i++) {
      const im = C.cycIdx(i - 1, N), i1 = C.cycIdx(i + 1, N), i2 = C.cycIdx(i + 2, N);
      const aL = a.left[im], bL = a.left[i], cL = a.left[i1], dL = a.left[i2];
      const aR = a.right[im], bR = a.right[i], cR = a.right[i1], dR = a.right[i2];
      for (let j = 0; j < 4; j++) {
        const k = 4 * i + j;
        const x = Math.min(W - 1, (k * W / (4 * N)) | 0);
        let v = C.interpK(aL, bL, cL, dL, j);
        if (v < minL[x]) minL[x] = v; if (v > maxL[x]) maxL[x] = v;
        v = C.interpK(aR, bR, cR, dR, j);
        if (v < minR[x]) minR[x] = v; if (v > maxR[x]) maxR[x] = v;
      }
    }
    fillEmptyBuckets([minL, maxL, minR, maxR]);
    return { minL, maxL, minR, maxR };
  }

  function bucketsFromGains(g, W) {
    const n = g.length;
    const mn = new Float64Array(W).fill(Infinity), mx = new Float64Array(W).fill(-Infinity);
    const first = new Float64Array(W);
    for (let i = 0; i < n; i++) {
      const x = Math.min(W - 1, (i * W / n) | 0);
      const v = g[i];
      if (mn[x] === Infinity) first[x] = v;
      if (v < mn[x]) mn[x] = v;
      if (v > mx[x]) mx[x] = v;
    }
    fillEmptyBuckets([mn, mx, first]);
    return { min: mn, max: mx, first };
  }

  function clearChart(cv) {
    const { ctx, w, h } = cv;
    ctx.clearRect(0, 0, w, h);
    // 横向网格
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let q = 1; q < 4; q++) {
      const y = Math.round(h * q / 4) + .5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  function drawChannelBuckets(cv, b, yMax, scaleUnit) {
    // scaleUnit: 桶值到“码值”的除数（插值 K 为 128，其余 1）
    const { ctx, w, h } = cv;
    const mid = h / 2;
    const amp = h / 2 - 8;
    const y = (v) => mid - (v / scaleUnit / yMax) * amp;

    const channels = [
      { lo: b.minL, hi: b.maxL, color: getCss('--ch-l') },
      { lo: b.minR, hi: b.maxR, color: getCss('--ch-r') },
    ];
    for (const ch of channels) {
      ctx.strokeStyle = ch.color;
      ctx.globalAlpha = .82;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y1 = y(ch.hi[x]), y2 = y(ch.lo[x]);
        ctx.moveTo(x + .5, y1);
        ctx.lineTo(x + .5, Math.max(y1 + 1, y2));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 零轴
    ctx.strokeStyle = 'rgba(238,242,248,.28)';
    ctx.beginPath(); ctx.moveTo(0, mid + .5); ctx.lineTo(w, mid + .5); ctx.stroke();
  }

  function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawSelection(cv, n) {
    if (!state.audio) return;
    const { ctx, w, h } = cv;
    const { start, end } = state.selection;
    const x0 = start / n * w, x1 = end / n * w;
    ctx.fillStyle = 'rgba(51,140,237,.14)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = 'rgba(157,200,253,.8)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0 + .5, 0); ctx.lineTo(x0 + .5, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1 - .5, 0); ctx.lineTo(x1 - .5, h); ctx.stroke();
  }

  function drawCeilingLines(cv, ceiling) {
    const { ctx, w, h } = cv;
    const mid = h / 2, amp = h / 2 - 8;
    // after 图 yMax = ceiling*1.18
    const yMax = Math.max(1, ceiling * 1.18);
    for (const sgn of [1, -1]) {
      const y = mid - sgn * (ceiling / yMax) * amp;
      ctx.strokeStyle = getCss('--danger');
      ctx.globalAlpha = .8;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  function drawBefore() {
    const cv = canvases.waveBefore;
    if (!cv || !state.audio) return;
    clearChart(cv);
    const a = state.audio;
    const W = Math.round(cv.w);
    let b, yMax, unit, len;
    if (state.beforeSrc === 'orig') {
      const key = 'orig-' + W;
      b = state.decim[key] || (state.decim[key] = bucketsFromArrays(a.left, a.right, a.N, W));
      yMax = Math.max(1, a.origPeaks.left, a.origPeaks.right) * 1.08;
      unit = 1; len = a.N;
    } else {
      const key = 'interp-' + W;
      b = state.decim[key] || (state.decim[key] = bucketsFromInterp(a, W));
      const r = state.good;
      const peak = r ? Math.max(r.interpPeakL, r.interpPeakR)
        : Math.max(maxAbsBucket(b.maxL, b.minL, b.maxR, b.minR) / 128, 1);
      yMax = Math.max(1, peak) * 1.06;
      unit = 128; len = 4 * a.N;
    }
    drawChannelBuckets(cv, b, yMax, unit);
    drawSelection(cv, 4 * a.N); // 选区状态始终是 192k 帧边界
    drawAxisTime(cv, len, state.beforeSrc === 'orig' ? 48000 : 192000);
  }

  function maxAbsBucket(...arrs) {
    let m = 0;
    for (const arr of arrs) for (let i = 0; i < arr.length; i++) { const v = Math.abs(arr[i]); if (v > m) m = v; }
    return m;
  }

  function noCurveHint() {
    if (!state.audio) return '请先导入素材';
    if (!state.good && state.lastConflicts.length) return '锁冲突且暂无更早的可行曲线；请按左侧列表调整锁';
    return '当前设定有锁冲突，仍显示上次可行曲线';
  }

  function drawAfter() {
    const cv = canvases.waveAfter;
    if (!cv) return;
    clearChart(cv);
    const r = state.good;
    if (!r) { drawEmptyHint(cv, noCurveHint()); return; }
    const W = Math.round(cv.w);
    const key = 'after-' + state.rev + '-' + W;
    const b = state.decim[key] || (state.decim[key] = bucketsFromArrays(r.outL, r.outR, r.n, W));
    drawChannelBuckets(cv, b, Math.max(1, r.ceiling * 1.18), 1);
    drawCeilingLines(cv, r.ceiling);
    drawSelection(cv, r.n);
    drawAxisTime(cv, r.n);
  }

  function drawGain() {
    const cv = canvases.gainCanvas;
    if (!cv) return;
    clearChart(cv);
    const r = state.good;
    if (!r) { drawEmptyHint(cv, noCurveHint()); return; }
    const { ctx, w, h } = cv;
    const W = Math.round(w);
    const n = r.n;

    // y 轴自动放大，但永远包含 0 与所有锁目标。
    let hi = 1;
    for (let i = 0; i < r.caps.length; i += Math.max(1, (r.caps.length / 4000) | 0)) if (r.caps[i] > hi) hi = r.caps[i];
    for (let i = 0; i < r.gains.length; i += Math.max(1, (r.gains.length / 4000) | 0)) if (r.gains[i] > hi) hi = r.gains[i];
    for (const l of state.locks.values()) if (l > hi) hi = l;
    const yMax = Math.min(C.GAIN_MAX, Math.max(64, hi * 1.12));
    const y = (v) => h - 14 - (v / yMax) * (h - 30);

    // cap 桶（灰）
    const capKey = 'cap-' + r.ceiling + '-' + W;
    const cb = state.decim[capKey] || (state.decim[capKey] = bucketsFromGains(r.caps, W));
    ctx.strokeStyle = getCss('--cap');
    ctx.globalAlpha = .28; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x++) { ctx.moveTo(x + .5, y(cb.max[x])); ctx.lineTo(x + .5, y(cb.min[x])); }
    ctx.stroke();
    // 每桶最紧帽（min）连线，作为可读的上限包络
    ctx.globalAlpha = .75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x++) { const yy = y(cb.min[x]); if (x === 0) ctx.moveTo(x + .5, yy); else ctx.lineTo(x + .5, yy); }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // gain 桶 minmax（aqua）
    const gKey = 'gain-' + state.rev + '-' + W;
    const gb = state.decim[gKey] || (state.decim[gKey] = bucketsFromGains(r.gains, W));
    ctx.strokeStyle = getCss('--gain');
    ctx.globalAlpha = .35;
    ctx.beginPath();
    for (let x = 0; x < W; x++) { ctx.moveTo(x + .5, y(gb.max[x])); ctx.lineTo(x + .5, y(gb.min[x])); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 每桶首值折线
    ctx.strokeStyle = getCss('--gain');
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = 0; x < W; x++) { const yy = y(gb.first[x]); if (x === 0) ctx.moveTo(x + .5, yy); else ctx.lineTo(x + .5, yy); }
    ctx.stroke();

    // y 轴标签
    ctx.fillStyle = getCss('--text-3');
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (let q = 0; q <= 4; q++) {
      const v = Math.round(yMax * q / 4);
      const yy = y(v);
      ctx.fillText(String(v), 4, yy - 2);
    }

    // 锁标记
    const locks = Array.from(state.locks.entries());
    for (const [f, g] of locks) {
      const x = f / n * w, yy = y(g);
      const conflicted = !!(lastConflictFrames && lastConflictFrames.has(f));
      ctx.save();
      ctx.translate(x, yy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = conflicted ? getCss('--danger') : getCss('--lock');
      ctx.fillRect(-4.5, -4.5, 9, 9);
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 4.5, yy - 4.5, 9, 9);
    }

    drawSelection(cv, n);
    drawAxisTime(cv, n);
  }

  let lastConflictFrames = null;

  function drawAxisTime(cv, n, rate) {
    const { ctx, w, h } = cv;
    ctx.fillStyle = 'rgba(170,182,200,.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = 5;
    rate = rate || 192000;
    for (let q = 0; q <= ticks; q++) {
      const f = Math.round(n * q / ticks);
      const x = q / ticks * w;
      const sec = f / rate;
      const label = sec < 1 ? `${(sec * 1000).toFixed(sec * 1000 < 10 ? 2 : 0)}ms` : `${sec.toFixed(2)}s`;
      ctx.fillText(label, Math.min(w - 28, Math.max(28, x)), h - 4);
    }
  }

  function drawEmptyHint(cv, text) {
    const { ctx, w, h } = cv;
    ctx.fillStyle = getCss('--text-3');
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
  }

  /* ================= 图表指针交互 ================= */

  function bindChartInteractions() {
    const defs = [
      { wrap: els.wrapBefore, canvas: els.waveBefore, kind: 'before' },
      { wrap: els.wrapAfter, canvas: els.waveAfter, kind: 'after' },
      { wrap: els.wrapGain, canvas: els.gainCanvas, kind: 'gain' },
    ];
    let drag = null;

    for (const d of defs) {
      d.canvas.addEventListener('contextmenu', (e) => {
        if (d.kind !== 'gain' || !state.audio) return;
        e.preventDefault();
        const f = frameFromEvent(e, d.canvas, 4 * state.audio.N);
        const lf = nearestLockedFrame(f, 14 / d.canvas.getBoundingClientRect().width * (4 * state.audio.N));
        if (lf != null) { state.locks.delete(lf); renderLocks(); applyAndRender('context-delete'); }
      });

      d.canvas.addEventListener('pointerdown', (e) => {
        if (!state.audio || e.button !== 0) return;
        const n = 4 * state.audio.N;
        const b = boundaryFromEvent(e, d.canvas, n);
        drag = { kind: d.kind, canvas: d.canvas, startB: b, curB: b, startX: e.clientX, moved: false, pointerId: e.pointerId };
        d.canvas.setPointerCapture(e.pointerId);
      });

      d.canvas.addEventListener('pointermove', (e) => {
        updateCrosshair(d, e);
        if (!drag || drag.canvas !== d.canvas) return;
        const n = 4 * state.audio.N;
        const b = boundaryFromEvent(e, d.canvas, n);
        if (Math.abs(e.clientX - drag.startX) > 5) drag.moved = true;
        drag.curB = b;
        const s = Math.min(drag.startB, drag.curB), en = Math.max(drag.startB, drag.curB);
        if (en > s) {
          state.selection.start = s; state.selection.end = en;
          syncSelectionInputs(false);
          redrawAll();
        }
      });

      const endDrag = (e) => {
        if (!drag || drag.canvas !== d.canvas) return;
        const wasDrag = drag;
        drag = null;
        if (!state.audio) return;
        const n = 4 * state.audio.N;
        if (!wasDrag.moved) {
          // 单击：gain 图锁定当前曲线值
          if (d.kind === 'gain') {
            const f = frameFromEvent(e, d.canvas, n);
            const baseCurve = state.good ? state.good.gains : (state.candidate ? state.candidate.gains : null);
            const g = baseCurve ? baseCurve[f] : C.GAIN_MAX;
            state.locks.set(f, g);
            els.lockFrame.value = f; els.lockGain.value = g;
            renderLocks(); applyAndRender('click-lock');
          }
          return;
        }
        const s = Math.min(wasDrag.startB, wasDrag.curB), en = Math.max(wasDrag.startB, wasDrag.curB);
        if (en > s) {
          state.selection = { start: s, end: en };
          syncSelectionInputs(true);
          redrawAll();
          restartPlaybackForSelection();
        }
      };
      d.canvas.addEventListener('pointerup', endDrag);
      d.canvas.addEventListener('pointercancel', () => { drag = null; });
      d.canvas.addEventListener('pointerleave', () => hideCrosshair(d));
    }
  }

  function frameFromEvent(e, canvas, n) {
    const r = canvas.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
    return Math.min(n - 1, Math.max(0, Math.floor(x / r.width * n)));
  }
  function boundaryFromEvent(e, canvas, n) {
    const r = canvas.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
    return Math.min(n, Math.max(0, Math.round(x / r.width * n)));
  }
  function nearestLockedFrame(f, maxDist) {
    let best = null, bd = maxDist;
    for (const lf of state.locks.keys()) {
      const dd = Math.abs(lf - f);
      if (dd < bd) { bd = dd; best = lf; }
    }
    return best;
  }

  /* ---------- 十字线 + tooltip ---------- */
  let ttRaf = 0;
  function updateCrosshair(d, e) {
    const wrap = d.wrap;
    const ch = wrap.querySelector('.crosshair');
    const rect = d.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    ch.hidden = false;
    ch.style.left = `${x}px`;
    const n = state.audio ? 4 * state.audio.N : 0;
    if (!n) return;
    const f = Math.min(n - 1, Math.max(0, Math.floor(x / rect.width * n)));
    const tip = els.tooltip;
    cancelAnimationFrame(ttRaf);
    ttRaf = requestAnimationFrame(() => {
      tip.hidden = false;
      tip.innerHTML = tooltipHtml(d.kind, f);
      const pad = 14;
      let tx = e.clientX + pad, ty = e.clientY + pad;
      const tr = tip.getBoundingClientRect();
      if (tx + tr.width > innerWidth - 8) tx = e.clientX - tr.width - pad;
      if (ty + tr.height > innerHeight - 8) ty = e.clientY - tr.height - pad;
      tip.style.left = `${Math.max(8, tx)}px`;
      tip.style.top = `${Math.max(8, ty)}px`;
    });
  }
  function hideCrosshair(d) {
    d.wrap.querySelector('.crosshair').hidden = true;
    els.tooltip.hidden = true;
  }

  function tooltipHtml(kind, f) {
    const r = state.good;
    const timeMs = (f / 192000 * 1000);
    const head = `<div class="tt-title">帧 ${f} · ${timeMs.toFixed(2)} ms</div>`;
    if (!r) return head + '无可行曲线（锁冲突中）';
    if (kind === 'after') {
      return head +
        `L=${r.outL[f]} R=${r.outR[f]}<br>g=${r.gains[f]} cap=${r.caps[f]}<br>` +
        `区间越限：${Math.abs(r.outL[f]) > r.ceiling || Math.abs(r.outR[f]) > r.ceiling ? '<span class=tt-bad>是</span>' : '否'}`;
    }
    if (kind === 'gain') {
      const lock = state.locks.get(f);
      return head +
        `g=${r.gains[f]} cap=${r.caps[f]}<br>` +
        (lock != null ? `锁目标=${lock}` : '未锁定');
    }
    // before：按当前信号源显示原始码或精确插值 K/128
    const a = state.audio;
    if (state.beforeSrc === 'orig') {
      const i = Math.min(a.N - 1, Math.floor(f / 4));
      return head + `原始基率帧 ${i}<br>L=${a.left[i]} R=${a.right[i]} @48k`;
    }
    const i = (f / 4) | 0, j = f % 4;
    const im = C.cycIdx(i - 1, a.N), i1 = C.cycIdx(i + 1, a.N), i2 = C.cycIdx(i + 2, a.N);
    const iL = C.interpK(a.left[im], a.left[i], a.left[i1], a.left[i2], j) / 128;
    const iR = C.interpK(a.right[im], a.right[i], a.right[i1], a.right[i2], j) / 128;
    return head + `插值 L=${iL.toFixed(3)} R=${iR.toFixed(3)}<br>(基率帧 ${i}, 相位 j=${j}/4)`;
  }

  /* ================= 选区输入 / 导出 ================= */

  function syncSelectionInputs(redraw = true) {
    if (!state.audio) return;
    const n = 4 * state.audio.N;
    const { start, end } = state.selection;
    els.selStart.value = start;
    els.selEnd.value = end;
    els.selStart.max = n - 1;
    els.selEnd.max = n;
    const len = Math.max(0, end - start);
    els.selLength.textContent = `${len.toLocaleString('en-US')} 帧 · ${(len / 192000).toFixed(4)}s`;
    if (redraw) redrawAll();
  }

  function commitSelectionFromInputs() {
    if (!state.audio) return;
    const n = 4 * state.audio.N;
    let s = Number(els.selStart.value), e = Number(els.selEnd.value);
    if (!Number.isInteger(s) || !Number.isInteger(e)) { showToast('起止帧需为整数', 'error'); return false; }
    s = Math.max(0, Math.min(n, s)); e = Math.max(0, Math.min(n, e));
    if (!(e > s)) { showToast('需要 止帧 > 起帧（左闭右开）', 'error'); return false; }
    state.selection = { start: s, end: e };
    syncSelectionInputs(true);
    return true;
  }

  function bindExport() {
    els.selStart.addEventListener('change', () => {
      if (commitSelectionFromInputs()) restartPlaybackForSelection();
    });
    els.selEnd.addEventListener('change', () => {
      if (commitSelectionFromInputs()) restartPlaybackForSelection();
    });
    els.btnSelFull.addEventListener('click', () => {
      if (!state.audio) return;
      state.selection = { start: 0, end: 4 * state.audio.N };
      syncSelectionInputs(true);
      restartPlaybackForSelection();
    });
    els.btnDownloadSel.addEventListener('click', () => {
      if (!commitSelectionFromInputs()) return;
      downloadSlice(state.selection.start, state.selection.end);
    });
    els.btnDownloadFull.addEventListener('click', () => {
      if (!state.audio) return;
      downloadSlice(0, 4 * state.audio.N);
    });
  }

  function downloadSlice(s, e) {
    const r = state.good;
    if (!r) { showToast('当前没有可行曲线可导出（请先解决锁冲突）', 'error'); return; }
    const bytes = C.WAV.encodeWav16([r.outL, r.outR], C.OUT_RATE, s, e);
    const stem = (state.audio?.name || 'loop').replace(/\.wav$/i, '');
    C.WAV.downloadBytes(bytes, `${stem}.limited192k.${s}-${e}.wav`);
    showToast(`已导出 [${s}, ${e}) 共 ${e - s} 帧 192kHz 双声道 WAV（${bytes.length} 字节）`, 'success');
  }

  /* ================= 试听 ================= */

  function bindTransport() {
    els.btnPlay.addEventListener('click', () => void playLoop());
    els.btnStop.addEventListener('click', stopPlayback);
    els.checkLoopSel.addEventListener('change', () => {
      if (state.srcNode) void playLoop();
    });
    els.monitorSource.addEventListener('change', () => {
      if (state.srcNode) void playLoop();
    });
  }

  function ensureCtx() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AC();
      // 旁路分析节点：仍然送到 destination，同时让自动化/电平表能读到实际播放信号。
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 2048;
      state.analyser.connect(state.audioCtx.destination);
    }
    if (state.audioCtx.state === 'suspended') void state.audioCtx.resume();
    return state.audioCtx;
  }

  function stopPlayback() {
    state.monitorToken++;
    if (state.srcNode) {
      try { state.srcNode.onended = null; state.srcNode.stop(); } catch { /* already stopped */ }
      state.srcNode = null;
    }
    state.playback = null;
    els.playState.textContent = '已停止';
    els.playState.classList.remove('playing');
    els.btnPlay.textContent = '▶ 试听循环';
  }

  function positiveMod(v, m) {
    const r = v % m;
    return r < 0 ? r + m : r;
  }

  /**
   * 新可行曲线提交后，若耳朵正在听“限幅后”缓冲，必须立刻替换正在循环的
   * AudioBuffer；否则界面峰值已更新，听到的却仍是旧码。尽量保持当前相位。
   * 锁冲突时不会调用：state.good 与正在播放的上次可行缓冲都继续保留。
   */
  function refreshActiveLimitedPlayback() {
    if (state.srcNode && els.monitorSource.value === 'limited') {
      void playLoop({ keepPosition: true });
    }
  }

  function restartPlaybackForSelection() {
    if (state.srcNode && els.checkLoopSel.checked) void playLoop();
  }

  async function playLoop(options = {}) {
    if (!state.audio) { showToast('请先导入素材', 'error'); return; }
    const previous = options.keepPosition ? state.playback : null;
    stopPlayback();
    const token = state.monitorToken;
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* 自动播放策略下由后续点击重试 */ }
    }
    const mode = els.monitorSource.value;
    let buffer;
    try {
      buffer = mode === 'original' ? buildOriginalBuffer(ctx)
        : mode === 'interp' ? buildInterpBuffer(ctx)
        : buildLimitedBuffer(ctx);
    } catch (e) {
      els.playState.textContent = '未播放';
      showToast(e.message, 'error');
      return;
    }
    if (token !== state.monitorToken) return;

    const useSelection = els.checkLoopSel.checked && mode !== 'original' &&
      state.selection.end > state.selection.start;
    const loopStart = useSelection ? state.selection.start / C.OUT_RATE : 0;
    const loopEnd = useSelection ? state.selection.end / C.OUT_RATE : buffer.duration;

    let offset = loopStart;
    if (previous && Number.isFinite(previous.startedAt)) {
      const elapsed = Math.max(0, ctx.currentTime - previous.startedAt);
      const sameRegion = Math.abs((previous.loopStart || 0) - loopStart) < 1e-6 &&
        Math.abs((previous.loopEnd || buffer.duration) - loopEnd) < 1e-6;
      if (sameRegion && loopEnd > loopStart) {
        const span = loopEnd - loopStart;
        offset = loopStart + positiveMod((previous.offset || loopStart) + elapsed - loopStart, span);
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = loopStart;
    src.loopEnd = loopEnd;
    src.connect(state.analyser || ctx.destination);
    src.onended = () => {
      if (state.srcNode === src) {
        state.srcNode = null;
        state.playback = null;
        els.playState.textContent = '已停止';
        els.playState.classList.remove('playing');
        els.btnPlay.textContent = '▶ 试听循环';
      }
    };
    src.start(0, offset);
    state.srcNode = src;
    state.playback = { mode, offset, startedAt: ctx.currentTime, loopStart, loopEnd };
    els.btnPlay.textContent = '♫ 循环播放中';
    els.playState.classList.add('playing');
    const selMsg = useSelection ? '（选区循环）' : '（整圈循环）';
    const modeLabel = { limited: '限幅后 192k', interp: '插值未限幅', original: '原始 48k' }[mode] || mode;
    els.playState.textContent = `播放中 · ${modeLabel} ${selMsg}`;
  }

  function buildLimitedBuffer(ctx) {
    const r = state.good;
    if (!r) throw new Error('锁冲突中，没有可行的限幅结果可试听');
    const buf = ctx.createBuffer(2, r.n, C.OUT_RATE);
    buf.getChannelData(0).set(floatFromInt16(r.outL));
    buf.getChannelData(1).set(floatFromInt16(r.outR));
    return buf;
  }
  function floatFromInt16(i16) {
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    return f;
  }
  function buildOriginalBuffer(ctx) {
    const a = state.audio;
    const buf = ctx.createBuffer(2, a.N, 48000);
    buf.getChannelData(0).set(floatFromInt16(a.left));
    buf.getChannelData(1).set(floatFromInt16(a.right));
    return buf;
  }
  function buildInterpBuffer(ctx) {
    const a = state.audio, n = 4 * a.N;
    const buf = ctx.createBuffer(2, n, C.OUT_RATE);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < a.N; i++) {
      const im = C.cycIdx(i - 1, a.N), i1 = C.cycIdx(i + 1, a.N), i2 = C.cycIdx(i + 2, a.N);
      for (let j = 0; j < 4; j++) {
        const k = 4 * i + j;
        L[k] = C.interpK(a.left[im], a.left[i], a.left[i1], a.left[i2], j) / 128 / 32768;
        R[k] = C.interpK(a.right[im], a.right[i], a.right[i1], a.right[i2], j) / 128 / 32768;
      }
    }
    return buf;
  }

  /* ================= 杂项 / 测试 API ================= */

  let toastTimer = 0;
  function showToast(msg, kind) {
    const t = els.toast;
    t.hidden = false;
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 给自动化 / 控制台用的稳定句柄。 */
  const api = {
    version: '1.0.0',
    async loadArrayBuffer(buf, name, settings) {
      state.zipEntries = [{ name: name || 'input.wav', buf }];
      renderCaseSelect(state.zipEntries);
      await ingestWavBuffer(buf, name || 'input.wav', settings || null);
      return this.snapshot();
    },
    async loadBuiltin() { await loadBuiltin(); return this.snapshot(); },
    /** 直接改设定并同步求解；overrides: {ceiling,up,down,locks:[[f,g]...]} */
    applySettings(over = {}) {
      if (over.ceiling != null) els.inputCeiling.value = over.ceiling;
      if (over.up != null) els.inputUp.value = over.up;
      if (over.down != null) els.inputDown.value = over.down;
      if (over.locks instanceof Map || Array.isArray(over.locks) || typeof over.locks === 'object') {
        const n = state.audio ? 4 * state.audio.N : 0;
        state.locks = new Map(C.normalizeLocks(over.locks, n).map((l) => [l.frame, l.gain]));
        renderLocks();
      }
      const r = applyAndRender('api');
      return r ? summarize(r) : this.snapshot();
    },
    snapshot() {
      return {
        loaded: !!state.audio,
        name: state.audio?.name || null,
        N: state.audio?.N || 0,
        n: state.audio ? 4 * state.audio.N : 0,
        rev: state.rev,
        settings: { ...state.settings },
        locks: Array.from(state.locks.entries()).map(([frame, gain]) => ({ frame, gain })),
        selection: { ...state.selection },
        hasFeasibleCurve: !!state.good,
        conflictPanelVisible: !els.conflictPanel.hidden,
        conflicts: state.lastConflicts.map((x) => ({ frame: x.frame, target: x.target, achievable: x.achievable })),
        lockOnlyConflicts: state.candidate
          ? state.candidate.lockOnlyConflicts.map((x) => ({ frame: x.frame, target: x.target, achievable: x.achievable }))
          : [],
        timings: state.timings ? { solveMs: state.timings.solveMs } : null,
      };
    },
    gainAt(i) { return state.good ? state.good.gains[i] : null; },
    outAt(i) { return state.good ? [state.good.outL[i], state.good.outR[i]] : null; },
    capAt(i) { return state.good ? state.good.caps[i] : null; },
    encodeSlice(start, end) {
      if (!state.good) throw new Error('no feasible result');
      const n = state.good.n;
      const s = start ?? 0, e = end ?? n;
      return C.WAV.encodeWav16([state.good.outL, state.good.outR], 192000, s, e);
    },
    playbackLevel() {
      const an = state.analyser;
      if (!an || !state.srcNode) return { active: false };
      const data = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(data);
      let peak = 0, sumSq = 0;
      for (const v of data) { const a = Math.abs(v); peak = Math.max(peak, a); sumSq += v * v; }
      return { active: true, peak, rms: Math.sqrt(sumSq / data.length) };
    },
    state, // 高级检查直接访问
  };

  function summarize(r) {
    return {
      ok: r.ok, n: r.n, rev: state.rev,
      conflicts: r.conflicts,
      lockOnlyConflicts: r.lockOnlyConflicts,
      solveMs: state.timings?.solveMs ?? null,
      outPeakL: r.outPeakL ?? null, outPeakR: r.outPeakR ?? null,
    };
  }

  function exposeTestApi() {
    window.__ccl = api;
    window.CCL.app = api;
  }
})();
