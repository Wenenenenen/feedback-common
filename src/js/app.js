/*
 * 主线程：导入、参数编辑、Worker 调度、图表绘制、导出。
 *
 * 计算口径一律来自 core.js（Worker 与测试共用同一份实现）：
 * 定标反卷积 -> 逐通道零点 -> 四个响应窗。页面只负责交互与呈现。
 *
 * Worker 只回传需要的那段反卷积（band），主线程缓存它：只改搜索区间或窗宽时
 * 不必重做 FFT，直接在同一份 band 上重新定位窗口（毫秒级）；只有 f0/f1 变了
 * 或换了输入才重新反卷积。
 */
(function () {
  'use strict';

  const Core = window.SHMCore;
  const Wav = window.SHMWav;
  const Zip = window.SHMZip;
  const Chart = window.SHMChart;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    packageParams: null,   // 包内参数（不可变备份，用于「恢复包内参数」）
    params: null,          // 当前生效参数
    sweepName: '',
    captureName: '',
    sweep: null,           // {info, data: Float64Array}
    capture: null,         // {info, data: Float64Array[]}
    sourceNote: '',
    results: [],           // 每通道 {channel, calib, dataLen, analysis, band}
    activeCh: 0,
    dB: true,
    showSearch: true,
    compareDb: false,
    busy: false,
    runToken: 0,
    pendingNote: null,     // 计算中收到的新请求：只记最新一次，结束后再跑
    pendingQueued: false,
    lastMs: 0,
    cachedKey: '',         // 生成 results[].band 时使用的 (f0,f1,sweep,capture) 指纹
  };

  /* ------------------------------ helpers ------------------------------- */

  function setStatus(text, tone) {
    $('statusText').textContent = text;
    $('statusPill').dataset.tone = tone || 'idle';
  }

  function showErr(id, text) {
    const box = $(id);
    const span = $(id + 'Text');
    if (!text) { box.hidden = true; return; }
    if (span) span.textContent = text;
    box.hidden = false;
  }

  const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  function fmtNum(v, d) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    const digits = d == null ? 4 : d;
    if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(2);
    return v.toFixed(digits);
  }
  function fmtDb(v) {
    if (!(v > 0)) return '−∞ dB';
    return (10 * Math.log10(v)).toFixed(1) + ' dB';
  }
  const fmtSec = (frames) => (frames / Core.SAMPLE_RATE).toFixed(3) + ' s';
  const fmtRel = (rel) => (rel >= 0 ? '+' : '−') + fmtInt(Math.abs(rel));

  function download(name, bytes, mime) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  /* ------------------------------ theme --------------------------------- */

  const THEME_KEY = 'sweepHarmonic.theme';
  let themeMode = 'auto';
  try { themeMode = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { themeMode = 'auto'; }

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    for (const b of document.querySelectorAll('.theme button')) {
      b.setAttribute('aria-pressed', String(b.dataset.t === mode));
    }
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略 */ }
    renderOverview();
    renderWindows();
  }
  for (const b of document.querySelectorAll('.theme button')) {
    b.addEventListener('click', () => { themeMode = b.dataset.t; applyTheme(themeMode); });
  }
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (themeMode === 'auto') { renderOverview(); renderWindows(); }
      });
    } catch (e) { /* 老浏览器 */ }
  }

  /* ------------------------------ import -------------------------------- */

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(new Error('读取文件失败：' + file.name));
      fr.readAsArrayBuffer(file);
    });
  }

  function decodeSweep(bytes, name) {
    const w = Wav.decode(bytes);
    if (w.channels !== 1) throw new Error('扫频文件必须是单声道（' + name + ' 有 ' + w.channels + ' 声道）');
    if (w.sampleRate !== Core.SAMPLE_RATE) throw new Error('扫频采样率必须是 48 kHz（' + name + ' 为 ' + w.sampleRate + ' Hz）');
    const sec = w.frames / w.sampleRate;
    if (sec < Core.MIN_SWEEP_SECONDS - 1e-9 || sec > Core.MAX_SWEEP_SECONDS + 1e-9) {
      throw new Error('扫频时长 ' + sec.toFixed(3) + ' s 超出 1–20 s（' + name + '）');
    }
    return { info: w, data: w.data[0], name };
  }

  function decodeCapture(bytes, name) {
    const w = Wav.decode(bytes);
    if (w.sampleRate !== Core.SAMPLE_RATE) throw new Error('采集采样率必须是 48 kHz（' + name + ' 为 ' + w.sampleRate + ' Hz）');
    if (w.channels < 1 || w.channels > Core.MAX_CAPTURE_CHANNELS) {
      throw new Error('采集必须是 1–4 声道（' + name + ' 有 ' + w.channels + ' 声道）');
    }
    const sec = w.frames / w.sampleRate;
    if (sec > Core.MAX_CAPTURE_SECONDS + 1e-9) {
      throw new Error('采集时长 ' + sec.toFixed(3) + ' s 超过 25 s（' + name + '）');
    }
    return { info: w, data: w.data, name };
  }

  /* 用当前输入复核 setup 对象；抛中文错误。 */
  function crossCheck(setup) {
    Core.validateParams(setup, {
      sweepRate: state.sweep ? state.sweep.info.sampleRate : null,
      captureRate: state.capture ? state.capture.info.sampleRate : null,
      sweepChannels: state.sweep ? state.sweep.info.channels : null,
      captureChannels: state.capture ? state.capture.info.channels : null,
      captureFrames: state.capture ? state.capture.info.frames : null,
      sweepFrames: state.sweep ? state.sweep.info.frames : null,
    });
    return setup;
  }

  function prepareResultsForNewInput() {
    state.results = [];
    state.cachedKey = '';
    state.activeCh = 0;
  }

  function applyImport(sweep, capture, setupRaw, note) {
    const prevSweep = state.sweep;
    const prevCapture = state.capture;
    state.sweep = sweep;
    state.capture = capture;
    try {
      const setup = Core.validateSetupObject(setupRaw);
      crossCheck(setup);
      state.packageParams = { ...setup };
      state.params = { ...setup };
    } catch (e) {
      // 回滚
      state.sweep = prevSweep;
      state.capture = prevCapture;
      throw e;
    }
    state.sweepName = sweep.name;
    state.captureName = capture.name;
    state.sourceNote = note || '';
    prepareResultsForNewInput();
    syncParamInputs();
    renderCaseInfo();
  }

  function findEntry(entries, predicate) {
    for (const [name, data] of entries) if (predicate(name)) return { name, data };
    return null;
  }

  /*
   * 在包内 WAV 中判定哪一个是扫频、哪一个是采集：
   * 1) 文件名含 sweep / 采集文件含 capture 优先；
   * 2) 否则单声道 48 kHz 且 1–20 s 的作扫频，其余作采集；
   * 3) 两个都符合时取帧数少的作扫频。
   */
  function classifyWavs(wavs) {
    const decoded = wavs.map((w) => {
      try {
        return { ...w, dec: Wav.decode(w.data) };
      } catch (e) {
        return { ...w, dec: null, error: e.message };
      }
    });
    const good = decoded.filter((w) => w.dec);
    if (!good.length) {
      throw new Error('包内没有可解析的 WAV（' + decoded.map((d) => d.name + '：' + d.error).join('；') + '）');
    }
    const isSweepShape = (w) => {
      const d = w.dec;
      const sec = d.frames / d.sampleRate;
      return d.channels === 1 && d.sampleRate === Core.SAMPLE_RATE &&
        sec >= Core.MIN_SWEEP_SECONDS - 1e-9 && sec <= Core.MAX_SWEEP_SECONDS + 1e-9;
    };
    let sweep = good.find((w) => /sweep|扫频/i.test(w.name) && isSweepShape(w));
    let capture = good.find((w) => /capture|采集/i.test(w.name) && w !== sweep);
    if (!sweep) {
      const cands = good.filter(isSweepShape);
      if (!cands.length) throw new Error('包内找不到可作扫频的单声道 48 kHz、1–20 s 的 WAV');
      cands.sort((a, b) => a.dec.frames - b.dec.frames);
      sweep = cands[0];
    }
    if (!capture) {
      capture = good.find((w) => w !== sweep && w.dec.sampleRate === Core.SAMPLE_RATE &&
        w.dec.channels >= 1 && w.dec.channels <= Core.MAX_CAPTURE_CHANNELS);
      if (!capture) throw new Error('包内找不到 1–4 声道 48 kHz 的采集 WAV');
    }
    return { sweep, capture };
  }

  async function loadZip(file) {
    showErr('importErr', '');
    setStatus('解包中…', 'busy');
    const bytes = await readFile(file);
    let entries;
    try {
      entries = await Zip.unzip(bytes);
    } catch (e) {
      throw new Error('解包失败：' + e.message);
    }
    const jsonEntry = findEntry(entries, (n) => /(^|\/)setup\.json$/i.test(n));
    if (!jsonEntry) throw new Error('包内缺少 setup.json');
    let setupRaw;
    try {
      setupRaw = JSON.parse(new TextDecoder('utf-8').decode(jsonEntry.data));
    } catch (e) {
      throw new Error('setup.json 不是合法 JSON：' + e.message);
    }
    const wavs = [];
    for (const [name, data] of entries) {
      if (/\.wav$/i.test(name)) wavs.push({ name, data });
    }
    if (wavs.length < 2) throw new Error('包内需要至少两个 WAV（扫频 + 采集），实际 ' + wavs.length + ' 个');
    const picked = classifyWavs(wavs);
    const sweep = decodeSweep(picked.sweep.data, picked.sweep.name);
    const capture = decodeCapture(picked.capture.data, picked.capture.name);
    applyImport(sweep, capture, setupRaw, file.name);
    await runAnalysis('导入完成');
    setStatus('已载入', 'ok');
  }

  async function loadWavDirect(file, which) {
    showErr('importErr', '');
    const bytes = await readFile(file);
    if (which === 'sweep') {
      const s = decodeSweep(bytes, file.name);
      const prev = state.sweep;
      state.sweep = s;
      try {
        if (state.capture && state.params) crossCheck(state.params);
      } catch (e) {
        state.sweep = prev;
        throw e;
      }
      state.sweepName = file.name;
      if (state.capture && state.params) { state.cachedKey = ''; prepareResultsForNewInput(); }
    } else {
      const cap = decodeCapture(bytes, file.name);
      const prev = state.capture;
      state.capture = cap;
      try {
        if (state.params) crossCheck(state.params);
      } catch (e) {
        state.capture = prev;
        throw e;
      }
      state.captureName = file.name;
      if (state.sweep && state.params) { state.cachedKey = ''; prepareResultsForNewInput(); }
    }
    if (!state.params) {
      const def = { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 };
      state.packageParams = { ...def };
      state.params = { ...def };
      syncParamInputs();
    }
    prepareResultsForNewInput();
    renderCaseInfo();
    if (state.sweep && state.capture) await runAnalysis('已载入 WAV');
  }

  function renderCaseInfo() {
    $('ciSweep').textContent = state.sweep
      ? `${state.sweep.name} · 单声道 · ${fmtInt(state.sweep.info.frames)} 帧 · ${fmtSec(state.sweep.info.frames)}`
      : '—';
    $('ciCapture').textContent = state.capture
      ? `${state.capture.name} · ${state.capture.info.channels} 声道 · ${fmtInt(state.capture.info.frames)} 帧 · ${fmtSec(state.capture.info.frames)}`
      : '—';
    const p = state.params;
    $('ciFreq').textContent = p ? `${p.f0} → ${p.f1} Hz` : '—';
    $('chipCh').textContent = state.capture ? String(state.capture.info.channels) : '—';
    $('chipN').textContent = state.sweep ? fmtInt(state.sweep.info.frames) : '—';
    $('chipM').textContent = state.capture ? fmtInt(state.capture.info.frames) : '—';
    $('chipD').textContent = state.results.length ? fmtNum(state.results[0].calib, 3) : '—';
    $('chipT').textContent = state.lastMs ? state.lastMs.toFixed(0) + ' ms' : '—';
    renderChannelList();
  }

  /* ------------------------------ params UI ----------------------------- */

  const PARAM_INPUTS = ['inF0', 'inF1', 'inLo', 'inHi', 'inPre', 'inPost'];
  const PARAM_KEYS = { inF0: 'f0', inF1: 'f1', inLo: 'lo', inHi: 'hi', inPre: 'pre', inPost: 'post' };

  function syncParamInputs() {
    const p = state.params || state.packageParams;
    if (!p) return;
    for (const id of PARAM_INPUTS) {
      $(id).value = String(p[PARAM_KEYS[id]]);
      $(id).setAttribute('aria-invalid', 'false');
    }
    showErr('paramErr', '');
  }

  function readParamInputs() {
    const raw = {};
    for (const id of PARAM_INPUTS) {
      const v = $(id).value.trim();
      const key = PARAM_KEYS[id];
      if (v === '') throw new Error('参数 ' + key + ' 不能为空');
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error('参数 ' + key + ' 必须是整数（当前 “' + v + '”）');
      }
      raw[key] = n;
    }
    return raw;
  }

  let paramTimer = 0;
  function markInvalid(msg) {
    for (const id of PARAM_INPUTS) $(id).setAttribute('aria-invalid', 'false');
    for (const id of PARAM_INPUTS) {
      const key = PARAM_KEYS[id];
      if (new RegExp('(^|[^\\w])' + key + '([^\\w]|$)').test(msg) || msg.includes(' ' + key + ' ')) {
        $(id).setAttribute('aria-invalid', 'true');
      }
    }
  }

  async function commitParams() {
    let next;
    try {
      const raw = readParamInputs();
      next = Core.validateSetupObject(raw);
      if (state.sweep && state.capture) crossCheck(next);
      for (const id of PARAM_INPUTS) $(id).setAttribute('aria-invalid', 'false');
      showErr('paramErr', '');
    } catch (e) {
      showErr('paramErr', e.message);
      markInvalid(e.message);
      return;
    }
    const changed = !state.params ||
      ['f0', 'f1', 'lo', 'hi', 'pre', 'post'].some((k) => state.params[k] !== next[k]);
    state.params = next;
    if (!state.sweep || !state.capture) {
      renderCaseInfo();
      return;
    }
    if (!changed) return;
    await runAnalysis('参数已更新');
  }

  for (const id of PARAM_INPUTS) {
    $(id).addEventListener('input', () => { clearTimeout(paramTimer); paramTimer = setTimeout(commitParams, 240); });
    $(id).addEventListener('change', () => { clearTimeout(paramTimer); commitParams(); });
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(paramTimer); commitParams(); }
    });
  }
  $('btnReset').addEventListener('click', () => {
    if (!state.packageParams) return;
    state.params = { ...state.packageParams };
    syncParamInputs();
    if (state.sweep && state.capture) runAnalysis('已恢复包内参数');
    else renderCaseInfo();
  });

  /* ------------------------------ worker pool --------------------------- */

  const workers = [];
  let jobSeq = 1;

  function ensureWorkerPool(count) {
    // 4 逻辑核：最多 4 个 Worker，且不超过采集通道数（空闲 Worker 也会占内存）
    const want = Math.max(1, Math.min(4, count || 4));
    while (workers.length < want) {
      let w = null;
      try {
        w = window.SHM_makeWorker ? window.SHM_makeWorker() : null;
      } catch (e) { w = null; }
      if (!w) {
        if (workers.length) break;
        throw new Error('无法创建计算 Worker（当前环境不支持 Blob Worker）');
      }
      workers.push(w);
    }
    return workers;
  }

  /*
   * 跑一批通道。cacheHit 时不用 Worker，直接在主线程用缓存的 c 重新定位窗口。
   */
  /* 已缓存的 band 是否覆盖当前参数需要的范围（含 2% 余量） */
  function bandCovers(band, params) {
    const N = state.sweep.info.frames;
    const dataLen = band.dataLen;
    // planBand 已含余量；band 只要覆盖它就算可复用
    const plan = Core.planBand(N, dataLen, params);
    return band.lo <= plan.lo && band.hi >= plan.hi;
  }

  function keyFor(f0, f1) {
    const N = state.sweep ? state.sweep.info.frames : 0;
    const M = state.capture ? state.capture.info.frames : 0;
    return f0 + '|' + f1 + '|' + N + '|' + M + '|' + (state.sweep ? state.sweep.name : '') + '|' + (state.capture ? state.capture.name : '');
  }

  let pool = null;

  function sameCoreParams(a, b) {
    // 只比较影响反卷积的参数；lo/hi/pre/post 只影响定位，可在缓存上重定位
    return a && b && a.f0 === b.f0 && a.f1 === b.f1;
  }

  async function runAnalysis(note) {
    if (!state.sweep || !state.capture || !state.params) return;
    // 计算中又改了参数：不并排启动第二次（那样每个 Worker 都会堆任务），
    // 只记下「结束后用最新参数再跑一次」，最多额外一轮。
    if (state.busy) {
      state.pendingQueued = true;
      state.pendingNote = note || '参数已更新';
      setStatus('等待当前计算结束后更新…', 'busy');
      return;
    }
    const token = ++state.runToken;
    const t0 = performance.now();
    const chCount = state.capture.data.length;
    const params = { ...state.params };
    const key = keyFor(params.f0, params.f1);
    // 只有 f0/f1 变了（或换输入）才需要重做反卷积；仅改窗口参数时直接复用缓存
    const canReuse = state.results.length === chCount && state.cachedKey === key &&
      state.results.every((r) => r && r.band && bandCovers(r.band, params));
    state.busy = true;
    setStatus(canReuse ? '重新定位…' : '反卷积中…', 'busy');
    showErr('paramErr', '');

    try {
      // 让出一次事件循环：busy 状态与提示先上屏，再开始同步的重定位
      await new Promise((r) => setTimeout(r, 0));
      if (token !== state.runToken) return;
      if (canReuse) {
        const results = state.results.map((r) => {
          const analysis = Core.analyzeBand(r.band, state.sweep.info.frames, params, { bins: 2400 });
          return { ...r, analysis };
        });
        if (token !== state.runToken) return;
        state.results = results;
        state.cachedKey = key;
        state.lastMs = performance.now() - t0;
        state.activeCh = Math.min(state.activeCh, results.length - 1);
        renderAll();
        setStatus(note || '已重新定位', 'ok');
        return;
      }

      pool = ensureWorkerPool(chCount);
      const results = new Array(chCount);
      const jobs = [];
      for (let c = 0; c < chCount; c++) jobs.push({ id: jobSeq++, channel: c, params });
      let doneCount = 0;
      let firstError = null;
      // 每个 Worker 串行取任务，最多 4 条并行
      const runners = [];
      const nRunners = Math.min(pool.length, chCount);
      for (let k = 0; k < nRunners; k++) {
        runners.push((async (workerIdx) => {
          for (;;) {
            if (token !== state.runToken || firstError) return;
            const job = jobs.pop();
            if (!job) return;
            const worker = pool[workerIdx];
            try {
              const m = await new Promise((resolve, reject) => {
                const onMsg = (ev) => {
                  const d = ev.data || {};
                  if (d.id !== job.id) return;
                  if (d.type === 'result') { worker.removeEventListener('message', onMsg); resolve(d); }
                  else if (d.type === 'error') { worker.removeEventListener('message', onMsg); reject(new Error('通道 ' + (d.channel + 1) + '：' + d.message)); }
                  else if (d.type === 'superseded') {
                    worker.removeEventListener('message', onMsg);
                    const e = new Error('superseded');
                    e.superseded = true;
                    reject(e);
                  }
                };
                worker.addEventListener('message', onMsg);
                const sweepCopy = state.sweep.data.slice();
                const capCopy = state.capture.data[job.channel].slice();
                worker.postMessage({
                  type: 'job', id: job.id, channel: job.channel,
                  sweep: sweepCopy, capture: capCopy, params: job.params, bins: 2400,
                }, [sweepCopy.buffer, capCopy.buffer]);
              });
              if (token !== state.runToken) return;
              results[m.channel] = { channel: m.channel, calib: m.calib, dataLen: m.dataLen, analysis: m.analysis, band: m.band };
              doneCount++;
              // 参数已被改动（待跑下一轮）时，不把旧参数的结果刷上屏，避免数字与输入框不一致
              const staleNow = !sameCoreParams(params, state.params);
              state.results = staleNow ? state.results : results.filter(Boolean).sort((a, b) => a.channel - b.channel);
              state.lastMs = performance.now() - t0;
              if (!staleNow) renderAll();
              setStatus('计算中… ' + doneCount + '/' + chCount, 'busy');
            } catch (e) {
              if (e && e.superseded) return;      // 被更新的请求取代，静默退出
              firstError = firstError || e;
              return;
            }
          }
        })(k));
      }
      await Promise.all(runners);
      if (token !== state.runToken) return;
      if (firstError) throw firstError;
      for (let c = 0; c < chCount; c++) {
        if (!results[c]) {
          if (token !== state.runToken) return;
          throw new Error('通道 ' + (c + 1) + ' 未返回结果');
        }
      }
      state.lastMs = performance.now() - t0;
      if (sameCoreParams(params, state.params)) {
        state.results = results;
        state.cachedKey = key;
        state.activeCh = Math.min(state.activeCh, chCount - 1);
        renderAll();
        setStatus(note || '已完成', 'ok');
      }
    } catch (e) {
      if (token !== state.runToken) return;
      state.results = [];
      renderAll();
      setStatus('计算失败', 'err');
      showErr('paramErr', e.message);
    } finally {
      if (token === state.runToken) state.busy = false;
      renderCaseInfo();
      if (state.pendingQueued) {
        state.pendingQueued = false;
        const pendingNote = state.pendingNote || '参数已更新';
        state.pendingNote = null;
        // 用最新参数再跑一轮；若缓存的分段仍覆盖新参数，这轮只是重新定位。
        setTimeout(() => { runAnalysis(pendingNote); }, 0);
      }
    }
  }

  /* ------------------------------ rendering ----------------------------- */

  function renderChannelList() {
    const box = $('chList');
    box.textContent = '';
    if (!state.results.length) {
      box.appendChild(el('p', 'hint', state.capture ? '计算中…' : '载入采集后逐通道显示。'));
      return;
    }
    const sorted = state.results.slice().sort((a, b) => a.channel - b.channel);
    for (const r of sorted) {
      const row = el('div', 'row');
      row.appendChild(el('span', '', '通道 ' + (r.channel + 1)));
      row.appendChild(el('span', '', '零点 ' + fmtInt(r.analysis.zero) + ' (' + fmtRel(r.analysis.zeroRel) + ')'));
      box.appendChild(row);
    }
  }

  function renderTabs() {
    const box = $('chTabs');
    box.textContent = '';
    const sorted = state.results.slice().sort((a, b) => a.channel - b.channel);
    for (const r of sorted) {
      const c = r.channel;
      const b = el('button', 'tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(c === state.activeCh));
      const sw = el('span', 'sw');
      b.appendChild(sw);
      b.appendChild(document.createTextNode('通道 ' + (c + 1)));
      b.addEventListener('click', () => {
        state.activeCh = c;
        renderTabs();
        renderOverview();
        renderWindows();
      });
      box.appendChild(b);
    }
  }

  function currentResult() {
    const sorted = state.results.slice().sort((a, b) => a.channel - b.channel);
    return sorted.find((r) => r.channel === state.activeCh) || sorted[0] || null;
  }

  function renderOverview() {
    const canvas = $('cvOverview');
    const r = currentResult();
    const model = r ? {
      overview: r.analysis.overview,
      windows: r.analysis.windows,
      search: r.analysis.search,
      zero: r.analysis.zero,
      zeroValue: r.analysis.zeroValue,
      originFrame: state.sweep.info.frames - 1,
      dataLen: r.dataLen,
    } : null;
    Chart.drawOverview(canvas, model, { dB: state.dB, showSearch: state.showSearch });
    if (r) {
      $('ovSub').textContent = `通道 ${r.channel + 1} · 定标后 c = (y∗g)/D · 数据 0–${fmtInt(r.dataLen - 1)} 帧` +
        (r.analysis.conflicts.length ? ' · 窗冲突' : '');
      $('ovFoot').textContent = `视图 ${fmtInt(r.analysis.view.lo)}–${fmtInt(r.analysis.view.hi)} 帧 · N-1 = ${fmtInt(model.originFrame)} · ` +
        `零点 ${fmtInt(r.analysis.zero)}（rel ${fmtRel(r.analysis.zeroRel)}）· 定标 D = ${fmtNum(r.calib, 4)}。悬停查看帧号与幅度。`;
    } else {
      $('ovSub').textContent = '原反卷积时间轴 · 搜索区间与四个响应窗';
      $('ovFoot').textContent = '载入后显示每条采集通道的定标反卷积幅度。';
    }
  }

  function renderWindows() {
    const r = currentResult();
    const grid = $('wgrid');
    const summary = $('winSummary');
    grid.textContent = '';
    summary.textContent = '';
    if (!r) {
      $('winSub').textContent = '';
      $('conflictBar').hidden = true;
      grid.appendChild(el('div', 'empty', '载入并完成定位后显示四个响应窗。'));
      $('winFoot').textContent = '';
      return;
    }
    const a = r.analysis;
    $('winSub').textContent = `通道 ${r.channel + 1} · 零点 ${fmtInt(a.zero)} · 定标 D = ${fmtNum(r.calib, 4)}`;

    const bar = $('conflictBar');
    const ctext = $('conflictText');
    ctext.textContent = '';
    if (a.conflicts.length) {
      bar.hidden = false;
      const qset = [...new Set(a.conflicts.flat())].sort((x, y) => x - y).map((q) => '第 ' + q + ' 阶').join('、');
      ctext.appendChild(document.createTextNode('窗冲突：'));
      ctext.appendChild(el('b', 'pairs', qset));
      ctext.appendChild(document.createTextNode(' 的窗在公共样本上有重叠（' + a.conflicts.length + ' 对）。缩窄窗宽或改搜索区间可消除。'));
      const ul = el('ul');
      for (const [x, y] of a.conflicts) {
        const A = a.windows[x - 1], B = a.windows[y - 1];
        const lo = Math.max(A.start, B.start);
        const hi = Math.min(A.end, B.end);
        ul.appendChild(el('li', '', `q${x} ∩ q${y}：[${fmtInt(lo)}, ${fmtInt(hi)}) 共 ${fmtInt(hi - lo)} 个公共样本`));
      }
      ctext.appendChild(ul);
    } else {
      bar.hidden = true;
    }

    const direct = a.windows[0];
    const stats = [
      { label: '零点帧', value: fmtInt(a.zero) },
      { label: '零点偏移 rel', value: fmtRel(a.zeroRel) },
      { label: '零点值 c[zero]', value: fmtNum(a.zeroValue, 4) },
      { label: '直达窗能量', value: fmtNum(direct.energy, 4) },
    ];
    for (const s of stats) {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'label', s.label));
      d.appendChild(el('div', 'value', s.value));
      summary.appendChild(d);
    }

    const conflictQ = new Set();
    for (const [x, y] of a.conflicts) { conflictQ.add(x); conflictQ.add(y); }

    for (const win of a.windows) {
      const card = el('div', 'wcard' + (conflictQ.has(win.q) ? ' conflict' : ''));
      card.dataset.q = String(win.q);
      const head = el('div', 'whead');
      const qn = el('span', 'qname');
      qn.appendChild(document.createTextNode('第 '));
      qn.appendChild(el('span', 'q', String(win.q)));
      qn.appendChild(document.createTextNode(' 阶'));
      head.appendChild(qn);
      head.appendChild(el('span', 'range', `[${fmtInt(win.start)}, ${fmtInt(win.end)}) · 中心 ${fmtInt(win.center)}`));
      if (conflictQ.has(win.q)) head.appendChild(el('span', 'badge conflict', '冲突'));
      if (win.zeroFilled > 0) head.appendChild(el('span', 'badge warn', '窗内补零 ' + fmtInt(win.zeroFilled)));
      if (!conflictQ.has(win.q) && win.zeroFilled === 0) head.appendChild(el('span', 'badge muted', '无冲突'));
      card.appendChild(head);

      const cv = el('canvas');
      cv.height = 96;
      cv.setAttribute('aria-label', `第 ${win.q} 阶响应窗带符号波形`);
      card.appendChild(cv);

      const st = el('div', 'wstats');
      const e1 = el('div');
      e1.appendChild(el('span', 'sk', '能量 Σx²'));
      e1.appendChild(el('span', 'sv', fmtNum(win.energy, 5)));
      const e2 = el('div');
      e2.appendChild(el('span', 'sk', '峰值（带符号）'));
      e2.appendChild(el('span', 'sv signed', Chart.fmtSigned(win.peak, 4)));
      const e3 = el('div');
      e3.appendChild(el('span', 'sk', 'RMS'));
      e3.appendChild(el('span', 'sv', fmtNum(win.rms, 5)));
      st.appendChild(e1); st.appendChild(e2); st.appendChild(e3);
      card.appendChild(st);
      grid.appendChild(card);

      Chart.drawWindowWave(cv, win, r.dataLen);          // 颜色按阶次从角色变量取

      cv.addEventListener('pointermove', (ev) => {
        const hit = Chart.windowAt(cv, win, ev.clientX);
        if (!hit) return;
        cv.title = `帧 ${fmtInt(hit.frame)} · ${Chart.fmtSigned(hit.value, 6)}`;
      });
    }

    $('winFoot').textContent = `窗为半开区间 [中心-pre, 中心+post)，pre=${state.params.pre}，post=${state.params.post}；` +
      `窗内超出反卷积数据索引（0–${fmtInt(r.dataLen - 1)}）的样本取零。` +
      (a.conflicts.length ? '当前存在窗冲突，导出仍按各窗独立写出，但阶次内容会重叠。' : '四窗互不重叠。');
  }

  function renderCompare() {
    const body = $('compareBody');
    body.textContent = '';
    if (!state.results.length) {
      const tr = el('tr');
      const td = el('td', 'ctempty', '载入后显示');
      td.colSpan = 8;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const r of state.results.slice().sort((a, b) => a.channel - b.channel)) {
      const a = r.analysis;
      const tr = el('tr');
      const c1 = el('td');
      const tag = el('span', 'ctag');
      const sw = el('span', 'sw');
      sw.style.background = 'var(--accent)';
      tag.appendChild(sw);
      tag.appendChild(document.createTextNode('通道 ' + (r.channel + 1)));
      c1.appendChild(tag);
      tr.appendChild(c1);
      tr.appendChild(el('td', 'zeroed', `${fmtInt(a.zero)} (${fmtRel(a.zeroRel)})`));
      tr.appendChild(el('td', '', fmtNum(a.zeroValue, 4)));
      for (const w of a.windows) {
        tr.appendChild(el('td', '', state.compareDb ? fmtDb(w.energy) : fmtNum(w.energy, 5)));
      }
      const cf = el('td');
      if (a.conflicts.length) cf.appendChild(el('span', 'cflag', a.conflicts.map(([x, y]) => `q${x}∩q${y}`).join(' ')));
      else cf.appendChild(el('span', 'cok', '无'));
      tr.appendChild(cf);
      body.appendChild(tr);
    }
  }

  function exportName(r, win) {
    return 'ch' + (r.channel + 1) + '_q' + win.q + '_f' + win.start + '-' + (win.end - 1) + '.wav';
  }

  function renderExport() {
    const list = $('exList');
    list.textContent = '';
    const has = state.results.length > 0;
    $('btnExportAll').disabled = !has;
    if (!has) {
      list.appendChild(el('div', 'empty', '载入并完成定位后可导出各通道各阶的窗内波形。'));
      return;
    }
    for (const r of state.results.slice().sort((a, b) => a.channel - b.channel)) {
      for (const win of r.analysis.windows) {
        const row = el('div', 'exrow');
        const info = el('div');
        info.appendChild(el('div', 'exname', `通道 ${r.channel + 1} · 第 ${win.q} 阶`));
        info.appendChild(el('div', 'exmeta', exportName(r, win) + ` · ${fmtInt(win.length)} 帧 · ${fmtSec(win.length)}`));
        row.appendChild(info);
        row.appendChild(el('div', 'spacer'));
        const btn = el('button', 'btn small', '导出 WAV');
        btn.type = 'button';
        btn.addEventListener('click', () => {
          download(exportName(r, win), Wav.encodeFloat32Mono(win.samples, Core.SAMPLE_RATE), 'audio/wav');
        });
        row.appendChild(btn);
        list.appendChild(row);
      }
    }
  }

  function resultsJson() {
    return {
      version: 1,
      sampleRate: Core.SAMPLE_RATE,
      source: state.sourceNote || null,
      sweep: state.sweep ? {
        name: state.sweepName, frames: state.sweep.info.frames,
        bitsPerSample: state.sweep.info.bitsPerSample,
      } : null,
      capture: state.capture ? {
        name: state.captureName, channels: state.capture.info.channels,
        frames: state.capture.info.frames, bitsPerSample: state.capture.info.bitsPerSample,
      } : null,
      params: state.params,
      formula: {
        inverseSweep: 'g[j] = x[N-1-j]*exp(-j*ln(f1/f0)/N)',
        calibration: 'D = (x*g)[N-1]',
        deconvolution: 'c = (y*g)/D',
        zero: 'argmax |c[n]| for n in [N-1+lo, N-1+hi], ties -> earlier',
        orderShift: 'floor(N*ln(q)/ln(f1/f0)+0.5)',
        window: '[center-pre, center+post), out-of-range samples -> 0',
        energy: 'sum of squares in window',
      },
      channels: state.results.slice().sort((a, b) => a.channel - b.channel).map((r) => ({
        channel: r.channel,
        calibrator: r.calib,
        dataLen: r.dataLen,
        zero: r.analysis.zero,
        zeroRel: r.analysis.zeroRel,
        zeroValue: r.analysis.zeroValue,
        search: r.analysis.search,
        windows: r.analysis.windows.map((w) => ({
          q: w.q, shift: w.shift, center: w.center, start: w.start, end: w.end,
          length: w.length, energy: w.energy, peak: w.peak, peakIndex: w.peakIndex,
          rms: w.rms, zeroFilled: w.zeroFilled,
        })),
        conflicts: r.analysis.conflicts,
      })),
    };
  }

  function renderAll() {
    renderTabs();
    renderOverview();
    renderWindows();
    renderCompare();
    renderExport();
    renderChannelList();
    renderCaseInfo();
    $('btnExportJson').disabled = !state.results.length;
  }

  /* ------------------------------ export --------------------------------- */

  $('btnExportJson').addEventListener('click', () => {
    if (!state.results.length) return;
    const text = JSON.stringify(resultsJson(), null, 2);
    download('sweep-harmonic-results.json', new TextEncoder().encode(text), 'application/json');
  });

  $('btnExportAll').addEventListener('click', () => {
    if (!state.results.length) return;
    const entries = [];
    for (const r of state.results.slice().sort((a, b) => a.channel - b.channel)) {
      for (const win of r.analysis.windows) {
        entries.push({ name: exportName(r, win), data: Wav.encodeFloat32Mono(win.samples, Core.SAMPLE_RATE) });
      }
    }
    entries.push({
      name: 'results.json',
      data: new TextEncoder().encode(JSON.stringify(resultsJson(), null, 2)),
    });
    download('sweep-harmonic-export.zip', Zip.zipStore(entries), 'application/zip');
  });

  /* ------------------------------ events --------------------------------- */

  $('tgScale').addEventListener('click', () => {
    state.dB = !state.dB;
    $('tgScale').setAttribute('aria-pressed', String(state.dB));
    $('tgScale').textContent = state.dB ? 'dB' : '线性';
    renderOverview();
  });
  $('tgSearch').addEventListener('click', () => {
    state.showSearch = !state.showSearch;
    $('tgSearch').setAttribute('aria-pressed', String(state.showSearch));
    renderOverview();
  });
  $('tgCompareUnit').addEventListener('click', () => {
    state.compareDb = !state.compareDb;
    $('tgCompareUnit').setAttribute('aria-pressed', String(state.compareDb));
    renderCompare();
  });

  const dz = $('dropzone');
  const fileInput = $('fileInput');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    await handleFiles(Array.from(e.dataTransfer.files || []));
  });
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    await handleFiles(files);
  });

  async function handleFiles(files) {
    if (!files.length) return;
    try {
      const zipFile = files.find((f) => /\.zip$/i.test(f.name));
      if (zipFile) await loadZip(zipFile);
      else await handleWavFiles(files.filter((f) => /\.wav$/i.test(f.name)));
    } catch (e) {
      showErr('importErr', e.message);
      setStatus('导入失败', 'err');
    }
  }

  async function handleWavFiles(wavs) {
    if (!wavs.length) throw new Error('请选择 ZIP 测量包或 WAV 文件');
    const decoded = [];
    for (const f of wavs) decoded.push({ name: f.name, data: await readFile(f) });
    const picked = classifyWavs(decoded);
    const sweep = decodeSweep(picked.sweep.data, picked.sweep.name);
    const capture = decodeCapture(picked.capture.data, picked.capture.name);
    applyImport(sweep, capture, state.params || state.packageParams || {
      f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480,
    }, wavs.map((f) => f.name).join(' + '));
    await runAnalysis('已载入 WAV');
  }

  $('btnSample').addEventListener('click', async () => {
    showErr('importErr', '');
    setStatus('载入示例…', 'busy');
    try {
      if (location.protocol === 'file:') {
        throw new Error('file:// 下无法读取示例包，请用 scripts/start.sh 启动本地服务，或手动导入 ZIP');
      }
      const res = await fetch('samples/sweep-harmonic-cases.zip', { cache: 'no-store' });
      if (!res.ok) throw new Error('读取示例包失败（HTTP ' + res.status + '）');
      const blob = await res.blob();
      const name = 'sweep-harmonic-cases.zip';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // 复用 loadZip 的解包路径
      const file = new File([bytes], name, { type: 'application/zip' });
      await loadZip(file);
    } catch (e) {
      showErr('importErr', e.message);
      setStatus('示例载入失败', 'err');
    }
  });

  $('btnPickSweep').addEventListener('click', () => $('sweepInput').click());
  $('btnPickCapture').addEventListener('click', () => $('captureInput').click());
  $('sweepInput').addEventListener('change', async () => {
    const f = $('sweepInput').files[0];
    $('sweepInput').value = '';
    if (f) { showErr('importErr', ''); try { await loadWavDirect(f, 'sweep'); } catch (e) { showErr('importErr', e.message); } }
  });
  $('captureInput').addEventListener('change', async () => {
    const f = $('captureInput').files[0];
    $('captureInput').value = '';
    if (f) { showErr('importErr', ''); try { await loadWavDirect(f, 'capture'); } catch (e) { showErr('importErr', e.message); } }
  });

  /* 尺寸变化时重绘 */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderOverview(); renderWindows(); }, 140);
  });

  /* 悬停提示：总览 */
  (function setupOverviewTip() {
    const canvas = $('cvOverview');
    const tip = $('tipOverview');
    const wrap = canvas.parentElement;
    canvas.addEventListener('pointermove', (ev) => {
      const r = currentResult();
      if (!r) { tip.classList.remove('on'); return; }
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const ov = r.analysis.overview;
      const frac = (x - 56) / Math.max(10, rect.width - 56 - 14);
      if (frac < 0 || frac > 1) { tip.classList.remove('on'); return; }
      const frame = Math.round(ov.lo + frac * (ov.hi - ov.lo));
      const bi = Math.max(0, Math.min(ov.bins - 1, Math.floor(((frame - ov.lo) / (ov.hi - ov.lo + 1)) * ov.bins)));
      const amp = Math.max(Math.abs(ov.min[bi]), Math.abs(ov.max[bi]));
      let inWin = null;
      for (const w of r.analysis.windows) if (frame >= w.start && frame < w.end) { inWin = w.q; break; }
      tip.textContent = '';
      const l1 = el('div');
      l1.appendChild(el('span', 'k', '帧'));
      l1.appendChild(el('b', '', fmtInt(frame)));
      tip.appendChild(l1);
      const l2 = el('div');
      l2.appendChild(el('span', 'k', '|c|'));
      l2.appendChild(el('b', '', amp.toExponential(3)));
      tip.appendChild(l2);
      const l3 = el('div');
      if (inWin) {
        l3.appendChild(el('span', 'k', '位于'));
        l3.appendChild(el('b', '', '第 ' + inWin + ' 阶窗'));
      } else if (frame >= r.analysis.search.start && frame <= r.analysis.search.end) {
        l3.appendChild(el('span', 'k', ''));
        l3.appendChild(document.createTextNode('搜索区间内'));
      } else {
        l3.appendChild(el('span', 'k', ''));
        l3.appendChild(document.createTextNode('窗外'));
      }
      tip.appendChild(l3);
      const wrapRect = wrap.getBoundingClientRect();
      const left = Math.min(Math.max(ev.clientX - wrapRect.left, 60), wrapRect.width - 60);
      tip.style.left = left + 'px';
      tip.style.top = (ev.clientY - wrapRect.top) + 'px';
      tip.classList.add('on');
    });
    canvas.addEventListener('pointerleave', () => tip.classList.remove('on'));
  })();

  /* ------------------------------ boot ---------------------------------- */

  applyTheme(themeMode);
  $('btnExportJson').disabled = true;
  $('btnExportAll').disabled = true;
  setStatus('未载入', 'idle');
  renderCaseInfo();
  renderCompare();

  // 只读状态与少量入口，供端到端测试驱动
  window.__shm = {
    get state() { return state; },
    resultsJson,
    exportName,
    handleFiles,
  };
})();
