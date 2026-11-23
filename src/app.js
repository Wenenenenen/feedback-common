/*
 * App shell: import, parameter editing, worker-backed solving, chart views,
 * sample inspector, filters and export.
 */
(function () {
  'use strict';

  const C = window.AICore;
  const Z = window.AIZip;
  const Chart = window.AIChart;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fmt = (v, d = 4) => {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e5)) return v.toExponential(2);
    return v.toFixed(d);
  };
  const fmtInt = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');

  const state = {
    cfg: null,              // {M,P,Q,H,T,h_lengths,t_lengths,weights,limits,lambda,delay,taps}
    caseName: '',
    result: null,           // last *valid* solved payload
    resultParams: null,     // snapshot of params used for result
    view: 'curves',
    meas: 0,
    program: 0,
    filterProgram: 0,
    series: { target: true, prediction: true, residual: true },
    sample: 0,
    busy: false,
    pending: 0,             // request id of in-flight solve
    stale: false,
  };

  /* ------------------------------ theme --------------------------------- */

  const THEME_KEY = 'arrinv.theme';
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    for (const b of document.querySelectorAll('.theme button')) {
      b.setAttribute('aria-pressed', String(b.dataset.t === mode));
    }
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
    if (typeof redrawCharts === 'function') redrawCharts();
  }
  let themeMode = 'auto';
  try { themeMode = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* ignore */ }
  for (const b of document.querySelectorAll('.theme button')) {
    b.addEventListener('click', () => { themeMode = b.dataset.t; applyTheme(themeMode); });
  }
  applyTheme(themeMode);

  /* ------------------------------ toast --------------------------------- */

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    $('liveRegion').textContent = msg;
  }

  /* --------------------------- import case ------------------------------ */

  function showErrors(containerId, errors, kind = 'error') {
    const host = $(containerId);
    host.textContent = '';
    if (!errors || errors.length === 0) return;
    const box = el('div', `errors${kind === 'warn' ? ' warn' : ''}`);
    const hd = el('div', 'hd');
    hd.append(el('span', null, kind === 'warn' ? '提示' : '数据有误'));
    hd.append(el('span', 'count', `${errors.length} 项`));
    box.append(hd);
    const ul = el('ul');
    for (const e of errors.slice(0, 30)) {
      const li = el('li');
      if (e.path) li.append(el('div', 'p', e.path));
      li.append(el('div', 'm', e.message));
      ul.append(li);
    }
    if (errors.length > 30) {
      const li = el('li');
      li.append(el('div', 'm', `…另有 ${errors.length - 30} 项未显示`));
      ul.append(li);
    }
    box.append(ul);
    host.append(box);
  }

  function setStatus(kind, text) {
    const pill = $('statusPill');
    pill.className = `status ${kind}`;
    $('statusText').textContent = text;
  }

  // Any in-flight solve belongs to the previous case; drop it so its result
  // can never be published against the newly loaded measurements.
  function invalidatePending() {
    if (!state.pending) return;
    const token = state.pending;
    state.pending = 0;
    if (worker) { try { worker.postMessage({ type: 'cancel', token }); } catch { /* ignore */ } }
    finishBusy();
  }

  async function importZip(buffer, name) {
    clearErrors();
    let entries;
    try {
      entries = await Z.unzip(buffer);
    } catch (err) {
      setStatus('bad', '导入失败');
      showErrors('caseErrors', [{ path: name, message: `无法读取 ZIP：${err.message}` }]);
      return;
    }
    const projBytes = entries.get('project.json');
    if (!projBytes) {
      showErrors('caseErrors', entries.has('signals.f32')
        ? [{ path: `${name} → project.json`, message: 'ZIP 中缺少 project.json' }]
        : [{ path: name, message: 'ZIP 中缺少 project.json 与 signals.f32（应位于压缩包根目录）' }]);
      setStatus('bad', '导入失败');
      return;
    }
    let project;
    try {
      project = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(projBytes));
    } catch (err) {
      showErrors('caseErrors', [{ path: `${name} → project.json`, message: `JSON 解析失败：${err.message}` }]);
      setStatus('bad', '导入失败');
      return;
    }
    const v = C.validateProjectObject(project);
    if (v.errors.length) {
      showErrors('caseErrors', v.errors);
      setStatus('bad', '字段非法');
      return;
    }
    const sigBytes = entries.get('signals.f32');
    if (!sigBytes) {
      showErrors('caseErrors', [{ path: `${name} → signals.f32`, message: 'ZIP 中缺少 signals.f32' }]);
      setStatus('bad', '导入失败');
      return;
    }
    const sigBuf = sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength);
    const parsed = C.parseSignals(sigBuf, v.config);
    if (parsed.errors.length) {
      showErrors('caseErrors', parsed.errors);
      setStatus('bad', '样本非法');
      return;
    }
    const cfg = {
      ...v.config,
      H: parsed.H,
      T: parsed.T,
    };
    const pv = C.validateParams(cfg);
    if (pv.errors.length) {
      // Project still loads; parameters are editable and flagged.
      showErrors('paramErrors', pv.errors);
    }
    invalidatePending();
    state.cfg = cfg;
    state.caseName = name;
    state.result = null;
    state.resultParams = null;
    state.stale = false;
    state.sample = 0;
    state.meas = 0;
    state.program = 0;
    state.filterProgram = 0;
    state.signalStats = parsed.stats;
    syncParamInputs();
    renderCaseInfo();
    renderParams();
    renderAll();
    setStatus(pv.errors.length ? 'warn' : 'idle', pv.errors.length ? '参数待修正' : '就绪');
    if (!pv.errors.length) {
      // Auto-solve once so the desk is immediately useful.
      startSolve({ auto: true });
    }
  }

  function renderCaseInfo() {
    const cfg = state.cfg;
    const info = $('caseInfo');
    if (!cfg) { info.classList.remove('show'); return; }
    info.classList.add('show');
    $('caseName').textContent = state.caseName || '已载入';
    $('ciH').textContent = `${cfg.M}×${cfg.P}`;
    $('ciT').textContent = `${cfg.M}×${cfg.Q}`;
    const st = state.signalStats || {};
    $('ciS').textContent = st.samples != null ? fmtInt(st.samples) : '—';
    $('chipM').textContent = String(cfg.M);
    $('chipP').textContent = String(cfg.P);
    $('chipQ').textContent = String(cfg.Q);
    $('chipN').textContent = state.result ? String(state.result.geometry.N) : '—';
  }

  function clearErrors() {
    for (const id of ['caseErrors', 'paramErrors', 'solveErrors']) $(id).textContent = '';
  }

  /* ------------------------------ params -------------------------------- */

  const paramInputs = { weight: [], limit: [] };

  function buildParamInputs() {
    const cfg = state.cfg;
    const wg = $('weightGrid'), lg = $('limitGrid');
    wg.textContent = ''; lg.textContent = '';
    paramInputs.weight = []; paramInputs.limit = [];
    if (!cfg) return;
    for (let m = 0; m < cfg.M; m++) {
      const wrap = el('label', 'field');
      const lab = el('span', 'lab');
      lab.append(el('span', null, `测点 ${m + 1}`), el('span', 'hint', 'w'));
      const inp = el('input');
      inp.type = 'number';
      inp.step = '0.05';
      inp.min = String(C.W_MIN);
      inp.max = String(C.W_MAX);
      inp.dataset.kind = 'weight';
      inp.dataset.idx = String(m);
      inp.addEventListener('input', onParamInput);
      inp.addEventListener('blur', onParamBlur);
      wrap.append(lab, inp);
      wg.append(wrap);
      paramInputs.weight.push(inp);
    }
    for (let p = 0; p < cfg.P; p++) {
      const wrap = el('label', 'field');
      const lab = el('span', 'lab');
      lab.append(el('span', null, `扬声器 ${p + 1}`), el('span', 'hint', 'G'));
      const inp = el('input');
      inp.type = 'number';
      inp.step = '0.001';
      inp.min = String(C.G_MIN);
      inp.max = String(C.G_MAX);
      inp.dataset.kind = 'limit';
      inp.dataset.idx = String(p);
      inp.addEventListener('input', onParamInput);
      inp.addEventListener('blur', onParamBlur);
      wrap.append(lab, inp);
      lg.append(wrap);
      paramInputs.limit.push(inp);
    }
  }

  function syncParamInputs() {
    buildParamInputs();
    const cfg = state.cfg;
    if (!cfg) return;
    for (let m = 0; m < cfg.M; m++) paramInputs.weight[m].value = String(cfg.weights[m]);
    for (let p = 0; p < cfg.P; p++) paramInputs.limit[p].value = String(cfg.limits[p]);
    $('lambdaInput').value = String(cfg.lambda);
    $('lambdaSlider').value = String(cfg.lambda);
    $('delayInput').value = String(cfg.delay);
    $('tapsInput').value = String(cfg.taps);
  }

  // Parse a typed value that must be a finite number in [min,max]; returns
  // {ok, value}.
  function readNumber(inp, min, max, integer) {
    const raw = inp.value.trim();
    if (raw === '') return { ok: false, message: '不能为空' };
    const v = Number(raw);
    if (!Number.isFinite(v)) return { ok: false, message: '必须是数值' };
    if (integer && !Number.isInteger(v)) return { ok: false, message: '必须是整数' };
    if (v < min || v > max) return { ok: false, message: `必须在 ${min}–${max} 内` };
    return { ok: true, value: v };
  }

  function paramInputsAll() {
    return [...paramInputs.weight, ...paramInputs.limit, $('lambdaInput'), $('delayInput'), $('tapsInput')];
  }

  function collectParams({ validateNow }) {
    const cfg = state.cfg;
    const errors = [];
    const draft = {
      weights: cfg.weights.slice(),
      limits: cfg.limits.slice(),
      lambda: cfg.lambda,
      delay: cfg.delay,
      taps: cfg.taps,
    };
    const marking = [];
    for (let m = 0; m < cfg.M; m++) {
      const inp = paramInputs.weight[m];
      const r = readNumber(inp, C.W_MIN, C.W_MAX, false);
      if (r.ok) draft.weights[m] = r.value;
      else { errors.push({ path: `weights[${m}]`, message: r.message }); marking.push([inp, r.message]); }
    }
    for (let p = 0; p < cfg.P; p++) {
      const inp = paramInputs.limit[p];
      const r = readNumber(inp, C.G_MIN, C.G_MAX, false);
      if (r.ok) draft.limits[p] = r.value;
      else { errors.push({ path: `limits[${p}]`, message: r.message }); marking.push([inp, r.message]); }
    }
    const lr = readNumber($('lambdaInput'), C.LAMBDA_MIN, C.LAMBDA_MAX, false);
    if (lr.ok) draft.lambda = lr.value;
    else { errors.push({ path: 'lambda', message: lr.message }); marking.push([$('lambdaInput'), lr.message]); }
    const dr = readNumber($('delayInput'), 0, C.MAX_DELAY, true);
    if (dr.ok) draft.delay = dr.value;
    else { errors.push({ path: 'delay', message: dr.message }); marking.push([$('delayInput'), dr.message]); }
    const tr = readNumber($('tapsInput'), 1, C.MAX_LEN, true);
    if (tr.ok) draft.taps = tr.value;
    else { errors.push({ path: 'taps', message: tr.message }); marking.push([$('tapsInput'), tr.message]); }
    for (const [inp, msg] of marking) {
      inp.classList.add('invalid');
      inp.title = msg;
    }
    for (const inp of paramInputsAll()) if (!marking.some(([m]) => m === inp)) {
      inp.classList.remove('invalid');
      inp.title = '';
    }
    // energy bound uses the draft weights
    let energy = null;
    if (cfg.H && !errors.some((e) => e.path.startsWith('weights'))) {
      energy = C.energyTerms(cfg.H, draft.weights);
      if (energy.total > C.ENERGY_LIMIT) {
        errors.push({
          path: 'weights',
          message: `加权能量 ${energy.total.toFixed(4)} > 上限 ${C.ENERGY_LIMIT}；请降低测点权重`,
        });
        for (const i of paramInputs.weight) { i.classList.add('invalid'); i.title = '加权能量超限'; }
      }
    }
    return { draft, errors, energy };
  }

  function paramsEqual(a, b) {
    if (!a || !b) return false;
    const close = (x, y) => Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y));
    if (a.lambda !== b.lambda || a.delay !== b.delay || a.taps !== b.taps) return false;
    if (a.weights.length !== b.weights.length || a.limits.length !== b.limits.length) return false;
    for (let i = 0; i < a.weights.length; i++) if (!close(a.weights[i], b.weights[i])) return false;
    for (let i = 0; i < a.limits.length; i++) if (!close(a.limits[i], b.limits[i])) return false;
    return true;
  }

  function onParamInput(ev) {
    const c = collectParams({ validateNow: true });
    showErrors('paramErrors', c.errors);
    renderEnergy(c.energy);
    if (state.result) {
      // The displayed result is stale unless every input matches what produced it.
      state.stale = !(c.errors.length === 0 && paramsEqual(c.draft, state.resultParams));
      renderStale();
    }
    $('btnSolve').disabled = state.busy || !state.cfg || c.errors.length > 0;
  }

  function onParamBlur(ev) {
    const inp = ev.target;
    const kind = inp.dataset.kind;
    if (kind === 'weight' || kind === 'limit') {
      const idx = Number(inp.dataset.idx);
      const lim = kind === 'weight' ? [C.W_MIN, C.W_MAX] : [C.G_MIN, C.G_MAX];
      const r = readNumber(inp, lim[0], lim[1], false);
      if (!r.ok && inp.value.trim() === '') {
        inp.value = String(kind === 'weight' ? state.cfg.weights[idx] : state.cfg.limits[idx]);
        inp.classList.remove('invalid');
      }
    }
  }

  function renderEnergy(energy) {
    const box = $('energyMeter');
    if (!energy || !state.cfg) { box.hidden = true; return; }
    box.hidden = false;
    const v = energy.total;
    $('energyVal').textContent = `${v.toFixed(4)} / ${C.ENERGY_LIMIT}`;
    const fill = $('energyFill');
    const pct = Math.max(0, Math.min(100, (v / C.ENERGY_LIMIT) * 100));
    fill.style.width = `${pct}%`;
    fill.className = `fill${v > C.ENERGY_LIMIT ? ' bad' : v > C.ENERGY_LIMIT * 0.85 ? ' warn' : ''}`;
  }

  function renderParams() {
    const cfg = state.cfg;
    if (!cfg) return;
    const c = collectParams({ validateNow: false });
    showErrors('paramErrors', c.errors);
    renderEnergy(c.energy);
    $('btnSolve').disabled = state.busy || c.errors.length > 0;
  }

  // wire simple inputs
  for (const id of ['lambdaInput', 'delayInput', 'tapsInput']) {
    const inp = $(id);
    inp.addEventListener('input', () => {
      inp.classList.remove('invalid');
      if (id === 'lambdaInput') $('lambdaSlider').value = inp.value;
      onParamInput({ target: inp });
      renderParams();
    });
  }
  $('lambdaSlider').addEventListener('input', () => {
    $('lambdaInput').value = $('lambdaSlider').value;
    $('lambdaInput').classList.remove('invalid');
    onParamInput({ target: $('lambdaInput') });
    renderParams();
  });

  /* ------------------------------ solving -------------------------------- */

  let worker = null;
  let workerBroken = false;
  let reqSeq = 0;

  function ensureWorker() {
    if (worker || workerBroken) return worker;
    if (typeof Worker === 'undefined' || !window.AI_WORKER_SOURCE) {
      workerBroken = true;
      return null;
    }
    try {
      const blob = new Blob([window.AI_WORKER_SOURCE], { type: 'text/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = onWorkerMessage;
      worker.onerror = (e) => {
        // A worker failure must not lose the last valid result.
        if (state.pending) {
          state.pending = 0;
          finishBusy();
          showErrors('solveErrors', [{ path: '求解器', message: `后台线程异常：${e.message || '未知错误'}` }]);
          setStatus('bad', '求解失败');
        }
        workerBroken = true;
        try { worker.terminate(); } catch { /* ignore */ }
        worker = null;
      };
      return worker;
    } catch (err) {
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function packCfg(cfg) {
    // structured-clone friendly plain object with typed arrays intact
    return {
      M: cfg.M, P: cfg.P, Q: cfg.Q,
      h_lengths: cfg.h_lengths, t_lengths: cfg.t_lengths,
      H: cfg.H, T: cfg.T,
      weights: Array.from(cfg.weights),
      limits: Array.from(cfg.limits),
      lambda: cfg.lambda, delay: cfg.delay, taps: cfg.taps,
    };
  }

  function startSolve({ auto } = {}) {
    if (!state.cfg) return;
    const c = collectParams({ validateNow: true });
    renderEnergy(c.energy);
    if (c.errors.length) {
      showErrors('paramErrors', c.errors);
      setStatus('bad', '参数非法');
      return;
    }
    showErrors('paramErrors', []);
    const cfg = { ...state.cfg, ...c.draft };
    state.pendingCfg = cfg;
    const reqId = ++reqSeq;
    state.pending = reqId;
    setBusy(true);
    $('btnCancel').disabled = false;
    $('solveLabel').textContent = auto ? '求解中…' : '求解中…';
    setStatus('busy', '求解中');
    renderProgressReset();
    const w = ensureWorker();
    const payload = packCfg(cfg);
    if (w) {
      try {
        w.postMessage({ type: 'solve', reqId, cfg: payload });
      } catch (err) {
        workerBroken = true;
        worker = null;
        solveOnMain(payload, reqId);
      }
    } else {
      solveOnMain(payload, reqId);
    }
  }

  // In-thread fallback (also used when workers are unavailable).
  async function solveOnMain(cfg, reqId) {
    const token = reqId;
    try {
      const report = await window.AIReport.runSolve(cfg, {
        shouldAbort: () => state.pending !== token,
        onEvent: (ev) => { if (state.pending === token) onProgress(ev); },
      });
      if (state.pending !== token) return; // superseded: never publish
      if (report.aborted) { finishBusy(); return; }
      acceptResult(report, cfg, reqId);
    } catch (err) {
      if (state.pending !== token) return;
      state.pending = 0;
      finishBusy();
      showErrors('solveErrors', [{ path: '求解器', message: err && err.message ? err.message : String(err) }]);
      setStatus('bad', '求解失败');
    }
  }

  function onWorkerMessage(e) {
    const msg = e.data || {};
    if (msg.reqId !== state.pending) return; // stale or foreign message
    if (msg.type === 'progress') { onProgress(msg.event); return; }
    if (msg.type === 'aborted') { finishBusy(); return; }
    if (msg.type === 'error') {
      state.pending = 0;
      finishBusy();
      showErrors('solveErrors', [{ path: '求解器', message: msg.message || '未知错误' }]);
      setStatus('bad', '求解失败');
      return;
    }
    if (msg.type === 'result') {
      acceptResult(msg.report, state.pendingCfg, msg.reqId);
    }
  }

  function acceptResult(report, cfg, reqId) {
    if (reqId !== state.pending) return; // a newer task owns the display
    state.pending = 0;
    // Enforce the export contract: never publish an uncertified result.
    const cert = report.certification;
    if (!cert || (cert.projectedResidual > C.PG_LIMIT) || cert.maxOverrun > 1e-12) {
      finishBusy();
      showErrors('solveErrors', [{
        path: 'filters.json',
        message: `投影梯度 ${cert ? cert.projectedResidual.toExponential(3) : '—'} 超过 1e-7 或抽头越界；结果未采纳，保留上次有效解`,
      }]);
      setStatus('bad', '核查未通过');
      return;
    }
    state.result = report;
    state.resultParams = {
      weights: cfg.weights.slice(),
      limits: cfg.limits.slice(),
      lambda: cfg.lambda,
      delay: cfg.delay,
      taps: cfg.taps,
    };
    // If the fields were edited while this solve was running, the result no
    // longer corresponds to them: surface it as stale instead of pretending.
    const cur = collectParams({ validateNow: false });
    state.stale = !(cur.errors.length === 0 && paramsEqual(cur.draft, state.resultParams));
    state.sample = Math.min(state.sample, Math.max(0, report.geometry.N - 1));
    state.meas = Math.min(state.meas, cfg.M - 1);
    state.program = Math.min(state.program, cfg.Q - 1);
    state.filterProgram = Math.min(state.filterProgram, cfg.Q - 1);
    finishBusy();
    showErrors('solveErrors', []);
    setStatus('ok', '已求解');
    $('chipN').textContent = String(report.geometry.N);
    renderAll();
    toast(`求解完成 · ${Math.round(report.elapsed)} ms · 投影梯度 ${report.projectedResidual.toExponential(1)}`);
  }

  function setBusy(b) {
    state.busy = b;
    $('btnSolve').disabled = b || !state.cfg;
    $('btnCancel').disabled = !b;
    $('progress').classList.toggle('show', b);
    // Hold the previous render at reduced opacity while a new solve runs -
    // no skeleton, no layout jump.
    document.body.classList.toggle('solving', b && !!state.result);
  }

  function finishBusy() {
    setBusy(false);
    $('solveLabel').textContent = '求解';
    renderParams();
  }

  function cancelSolve() {
    if (!state.pending) return;
    const token = state.pending;
    state.pending = 0; // results for this token will be dropped
    if (worker) {
      try { worker.postMessage({ type: 'cancel', token }); } catch { /* ignore */ }
    }
    finishBusy();
    setStatus(state.result ? 'idle' : 'idle', state.result ? '已取消' : '未求解');
    toast('已取消当前求解；保留上次有效结果');
  }

  function renderProgressReset() {
    $('progressText').textContent = '构建谱与算子…';
    const stages = $('progressStages');
    stages.textContent = '';
    for (const [k, label] of [['spectra', '谱分解'], ['operator', '算子 + Cholesky'], ['rhs', '右端项'], ['solve', '主动集求解']]) {
      const row = el('div', 'stage');
      row.dataset.k = k;
      row.append(el('span', 't', label), el('span', 'v', '—'));
      stages.append(row);
    }
  }

  const STAGE_LABEL = { spectra: '谱分解', operator: '算子 + Cholesky', rhs: '右端项', solve: '主动集求解', iterate: '迭代' };
  function onProgress(ev) {
    if (!ev) return;
    const stages = $('progressStages');
    const rows = stages.querySelectorAll('.stage');
    const order = ['spectra', 'operator', 'rhs', 'solve'];
    if (ev.type === 'stage') {
      const idx = order.indexOf(ev.stage);
      rows.forEach((r, i) => {
        if (i < idx) r.classList.add('done');
        if (i === idx && ev.stage !== 'solve') {
          r.querySelector('.v').textContent = `${Math.round(ev.elapsed)} ms`;
        }
      });
      if (ev.stage === 'iterate') {
        $('progressText').textContent = `优化中 · 第 ${ev.outer + 1} 轮 · CG ${ev.iterations} 步`;
        const row = rows[3];
        if (row) row.querySelector('.v').textContent = `${ev.outer + 1} 轮 / ${ev.iterations} 步`;
      } else if (ev.stage === 'rhs') {
        $('progressText').textContent = `节目 ${ev.q + 1}：右端项`;
      } else if (ev.stage === 'solve') {
        $('progressText').textContent = `节目 ${ev.q + 1}：投影梯度 ${ev.projected.toExponential(2)}`;
        const r = rows[3];
        if (r) { r.classList.add('done'); r.querySelector('.v').textContent = ev.projected.toExponential(2); }
      } else {
        $('progressText').textContent = `${STAGE_LABEL[ev.stage] || ev.stage} …`;
      }
    }
  }

  $('btnSolve').addEventListener('click', () => startSolve({}));
  $('btnCancel').addEventListener('click', cancelSolve);
  $('btnRevert').addEventListener('click', () => {
    if (!state.resultParams) return;
    const cfg = state.cfg;
    state.cfg = { ...cfg, ...state.resultParams };
    syncParamInputs();
    renderParams();
    state.stale = false;
    renderStale();
    toast('已恢复上次有效解所用参数');
    renderAll();
  });

  /* --------------------------- render: shell ----------------------------- */

  function renderStale() {
    $('staleNote').classList.toggle('show', state.stale && !!state.result);
    $('btnRevert').hidden = !(state.stale && state.result);
  }

  function renderAll() {
    renderStale();
    renderCaseInfo();
    document.body.dataset.loaded = state.cfg ? '1' : '0';
    const hasResult = !!state.result;
    $('emptyState').style.display = hasResult ? 'none' : '';
    for (const v of ['curves', 'filters', 'report']) {
      $(`view-${v}`).classList.toggle('show', hasResult && state.view === v);
    }
    $('tabs').style.display = hasResult ? '' : 'none';
    if (!hasResult) return;
    renderSummary();
    renderCurves();
    renderFilters();
    renderReport();
  }

  /* --------------------------- summary card ------------------------------ */

  function renderSummary() {
    const r = state.result;
    const summary = $('summary');
    summary.classList.add('show');
    const stats = $('summaryStats');
    stats.textContent = '';
    const items = [
      ['目标 E', fmt(r.objective, 5)],
      ['投影梯度', r.projectedResidual.toExponential(2)],
    ];
    for (const [k, v] of items) {
      const s = el('div', 'stat');
      s.append(el('div', 'k', k), el('div', 'v', v));
      stats.append(s);
    }
    const cert = r.certification;
    const box = $('certBox');
    const ok = cert.withinTolerance;
    box.className = `cert ${ok ? 'ok' : 'bad'}`;
    const icon = $('certIcon');
    icon.textContent = '';
    icon.innerHTML = ok
      ? '<circle cx="8" cy="8" r="6.5" stroke="#0ca30c" stroke-width="1.4"/><path d="M5 8.2l2 2 4-4.4" stroke="#0ca30c" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<circle cx="8" cy="8" r="6.5" stroke="#d03b3b" stroke-width="1.4"/><path d="M8 4.8v4M8 11.2h.01" stroke="#d03b3b" stroke-width="1.6" stroke-linecap="round"/>';
    $('certText').textContent = ok
      ? `导出已复核 · ${fmtInt(cert.tapsChecked)} 个抽头全在盒内 · 误差 ≤ 1e-7`
      : '导出核查未通过';
    $('certVal').textContent = cert.projectedResidual.toExponential(2);
  }

  /* ---------------------------- curves view ------------------------------ */

  let mainChart = null;

  function ensureChart() {
    if (!mainChart) {
      mainChart = new Chart.LineChart($('mainChart'), $('mainChartWrap'), $('mainTip'));
    }
    return mainChart;
  }

  function currentSeries() {
    const r = state.result;
    if (!r) return null;
    const q = state.program;
    const m = state.meas;
    return {
      target: r.series[q].target[m],
      prediction: r.series[q].prediction[m],
      residual: r.series[q].residual[m],
      sse: r.perMeasurement[q][m].sse,
    };
  }

  function seriesColors() {
    const wrap = $('mainChartWrap');
    const css = Chart.themeColors(wrap);
    return { target: css.s1, prediction: css.s2, residual: css.s3, css };
  }

  function renderProgramSeg() {
    const seg = $('programSeg');
    seg.textContent = '';
    const r = state.result;
    if (!r) return;
    for (let q = 0; q < r.Q; q++) {
      const b = el('button', null, `节目 ${q + 1}`);
      b.setAttribute('aria-pressed', String(state.program === q));
      b.addEventListener('click', () => { state.program = q; renderCurves(); });
      seg.append(b);
    }
  }

  function renderSeriesSeg() {
    const seg = $('seriesSeg');
    seg.textContent = '';
    const cols = seriesColors();
    const opts = [['target', '目标', cols.target], ['prediction', '预测', cols.prediction], ['residual', '残差', cols.residual]];
    for (const [k, label, color] of opts) {
      const b = el('button', null);
      b.setAttribute('aria-pressed', String(state.series[k]));
      const sw = el('span', 'swatch line');
      sw.style.background = color;
      b.append(sw, el('span', null, label));
      b.addEventListener('click', () => {
        const visCount = Object.values(state.series).filter(Boolean).length;
        if (state.series[k] && visCount === 1) return; // keep at least one
        state.series[k] = !state.series[k];
        renderCurves();
      });
      seg.append(b);
    }
  }

  function renderMeasSelect() {
    const sel = $('measSelect');
    const r = state.result;
    if (!r) return;
    sel.textContent = '';
    for (let m = 0; m < r.M; m++) {
      const o = el('option', null, `测点 ${m + 1}`);
      o.value = String(m);
      o.selected = m === state.meas;
      sel.append(o);
    }
  }

  function renderCurves() {
    const r = state.result;
    if (!r) return;
    const S = currentSeries();
    const cols = seriesColors();
    const N = r.geometry.N;
    state.sample = Math.max(0, Math.min(N - 1, state.sample));
    renderProgramSeg();
    renderSeriesSeg();
    renderMeasSelect();
    const slider = $('sampleSlider');
    slider.max = String(N - 1);
    slider.value = String(state.sample);
    $('sampleInput').max = String(N - 1);
    $('sampleInput').value = String(state.sample);

    const series = [];
    if (state.series.target) series.push({ name: '目标', color: cols.target, values: S.target, width: 2 });
    if (state.series.prediction) series.push({ name: '预测', color: cols.prediction, values: S.prediction, width: 2 });
    if (state.series.residual) series.push({ name: '残差', color: cols.residual, values: S.residual, width: 1.7 });
    $('mainChartTitle').textContent = `测点 ${state.meas + 1} · 节目 ${state.program + 1}`;
    $('mainChartSub').textContent = `N = ${N} 样本 · 加权 SSE = ${fmt(r.perMeasurement[state.program][state.meas].weightedSse, 5)} · 峰值 |r| = ${fmt(r.perMeasurement[state.program][state.meas].peak, 5)}`;

    const legend = $('mainLegend');
    legend.textContent = '';
    for (const s of series) {
      const it = el('span', 'item');
      const key = el('span', 'key');
      key.style.background = s.color;
      it.append(key, el('span', null, s.name));
      legend.append(it);
    }
    ensureChart().setSpec({
      series,
      xLength: N,
      marker: state.sample,
      xLabel: '样本 n',
      yLabel: '',
      onSelect: (idx) => setSample(idx),
      onHover: () => {},
    });
    renderSampleRead();
    renderMiniGrid();
  }

  function setSample(idx) {
    const r = state.result;
    if (!r) return;
    state.sample = Math.max(0, Math.min(r.geometry.N - 1, idx));
    $('sampleSlider').value = String(state.sample);
    $('sampleInput').value = String(state.sample);
    if (mainChart) mainChart.setSpec({ ...mainChart.spec, marker: state.sample });
    renderSampleRead();
    renderMiniGrid();
  }

  function renderSampleRead() {
    const r = state.result;
    const S = currentSeries();
    const n = state.sample;
    $('readAside').textContent = `n = ${n}`;
    const host = $('sampleRead');
    host.textContent = '';
    const cols = seriesColors();
    const rows = [
      ['目标', S.target[n], cols.target, false],
      ['预测', S.prediction[n], cols.prediction, false],
      ['残差', S.residual[n], cols.residual, true],
    ];
    for (const [label, value, color, small] of rows) {
      const box = el('div', 'rv');
      const k = el('span', 'k');
      const sw = el('span', 'swatch line');
      sw.style.background = color;
      k.append(sw, el('span', null, label));
      const v = el('div', `v${small ? ' small' : ''}`, fmt(value, 6));
      box.append(k, v);
      host.append(box);
    }
    // table across all measurement points
    const tb = $('sampleTable').querySelector('tbody');
    tb.textContent = '';
    for (let m = 0; m < r.M; m++) {
      const pm = r.perMeasurement[state.program][m];
      const tr = el('tr');
      if (m === state.meas) tr.className = 'hl';
      tr.append(el('td', 'lbl', `测点 ${m + 1}`));
      tr.append(el('td', null, fmt(pm.target[n], 6)));
      tr.append(el('td', null, fmt(pm.prediction[n], 6)));
      tr.append(el('td', null, fmt(pm.residual[n], 6)));
      tr.append(el('td', null, fmt(pm.peak, 4)));
      tb.append(tr);
    }
  }

  const THUMB_N = 240;
  function downsample(values, maxPoints) {
    const n = values.length;
    if (n <= maxPoints) return { data: values, step: 1 };
    const step = n / maxPoints;
    const out = new Float64Array(maxPoints);
    for (let i = 0; i < maxPoints; i++) {
      const i0 = Math.floor(i * step), i1 = Math.min(n, Math.floor((i + 1) * step));
      let lo = Infinity, hi = -Infinity;
      for (let j = i0; j < i1; j++) { if (values[j] < lo) lo = values[j]; if (values[j] > hi) hi = values[j]; }
      // keep the sample with the largest magnitude so peaks stay visible
      out[i] = Math.abs(lo) > Math.abs(hi) ? lo : hi;
    }
    return { data: out, step };
  }

  function renderMiniGrid() {
    const r = state.result;
    const grid = $('miniGrid');
    grid.textContent = '';
    const q = state.program;
    for (let m = 0; m < r.M; m++) {
      const pm = r.perMeasurement[q][m];
      const d = el('div', `mini${m === state.meas ? ' sel' : ''}`);
      d.tabIndex = 0;
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', `测点 ${m + 1} 残差，峰值 ${fmt(pm.peak, 4)}`);
      const cap = el('div', 'cap');
      cap.append(el('span', 'nm', `测点 ${m + 1}`), el('span', 'vv', `|r| ${fmt(pm.peak, 3)}`));
      const cv = el('canvas');
      d.append(cap, cv);
      const pick = () => { state.meas = m; renderCurves(); };
      d.addEventListener('click', pick);
      d.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      grid.append(d);
      requestAnimationFrame(() => {
        const ds = downsample(pm.residual, THUMB_N);
        Chart.drawMini(cv, ds.data, { marker: Math.min(ds.data.length - 1, Math.round(state.sample / ds.step)), color: seriesColors().residual });
      });
    }
    $('miniAside').textContent = `节目 ${q + 1} · 残差包络`;
  }

  // sample controls
  $('measSelect').addEventListener('change', (ev) => {
    state.meas = Number(ev.target.value);
    renderCurves();
  });
  $('sampleSlider').addEventListener('input', (ev) => setSample(Number(ev.target.value)));
  $('sampleInput').addEventListener('input', (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) setSample(v);
  });
  $('btnPrev').addEventListener('click', () => setSample(state.sample - 1));
  $('btnNext').addEventListener('click', () => setSample(state.sample + 1));

  /* ---------------------------- filters view ----------------------------- */

  function renderFilterProgramSeg() {
    const seg = $('filterProgramSeg');
    seg.textContent = '';
    const r = state.result;
    if (!r) return;
    for (let q = 0; q < r.Q; q++) {
      const b = el('button', null, `节目 ${q + 1}`);
      b.setAttribute('aria-pressed', String(state.filterProgram === q));
      b.addEventListener('click', () => { state.filterProgram = q; renderFilters(); });
      seg.append(b);
    }
  }

  const TAP_PAGE = 32;

  // Each speaker card shows a tap plot with the ±G box, and a paged table so
  // every tap stays readable (no 4096-row DOM dump).
  function renderFilters() {
    const r = state.result;
    if (!r) return;
    renderFilterProgramSeg();
    const host = $('filterCards');
    host.textContent = '';
    const q = state.filterProgram;
    const f = r.filters[q];
    $('filterEmpty').style.display = 'none';
    for (let p = 0; p < r.P; p++) {
      const card = el('div', 'card channel-card');
      const hd = el('div', 'hd');
      hd.append(el('span', 'tag', `SPK ${p + 1}`));
      hd.append(el('h3', null, `扬声器 ${p + 1}`));
      const G = r.limits[p];
      let inBox = true, saturated = 0, peak = 0, energy = 0;
      const tapsArr = f.subarray(p * r.taps, (p + 1) * r.taps);
      for (let k = 0; k < r.taps; k++) {
        const v = tapsArr[k];
        if (Math.abs(v) > G + 1e-12) inBox = false;
        if (Math.abs(Math.abs(v) - G) < 1e-9) saturated++;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        energy += v * v;
      }
      const meta = el('div', 'meta');
      meta.append(el('span', null, `G = ${G}`));
      meta.append(el('span', null, `峰值 ${fmt(peak, 4)}`));
      meta.append(el('span', null, `Σf² ${fmt(energy, 4)}`));
      meta.append(el('span', null, `${saturated} 个触界`));
      hd.append(meta);

      const row = el('div', 'row');
      const chip = el('span', `chip${inBox ? '' : ' badchip'}`);
      chip.append(el('span', 'k', '盒约束'), el('b', null, inBox ? '全部在 [−G, G]' : '有抽头越界'));
      row.append(chip);

      const plot = el('canvas', 'tapcanvas');
      row.append(plot);
      card.append(hd, row);

      // paged tap table
      const nav = el('div', 'row tapnav');
      const prev = el('button', 'btn sm', '上一页');
      const next = el('button', 'btn sm', '下一页');
      const range = el('span', 'note');
      nav.append(prev, next, range);

      const table = el('table', 'data');
      const thead = el('thead');
      const htr = el('tr');
      for (const hcol of ['k', 'F[k]', '盒内位置', '距边界']) htr.append(el('th', null, hcol));
      thead.append(htr);
      table.append(thead);
      const tbody = el('tbody');
      table.append(tbody);

      let page = 0;
      const pages = Math.max(1, Math.ceil(r.taps / TAP_PAGE));
      const paint = () => {
        tbody.textContent = '';
        const lo = page * TAP_PAGE;
        const hi = Math.min(r.taps, lo + TAP_PAGE);
        for (let k = lo; k < hi; k++) {
          const v = tapsArr[k];
          const tr = el('tr');
          tr.append(el('td', 'lbl', String(k)));
          tr.append(el('td', null, v.toPrecision(3)));
          const td = el('td');
          const bar = el('div', 'bar');
          const fill = el('i');
          const frac = G > 0 ? Math.min(1, Math.abs(v) / G) : 0;
          if (v < 0) fill.style.left = `${50 - frac * 50}%`;
          else fill.style.left = '50%';
          fill.style.width = `${frac * 50}%`;
          if (Math.abs(Math.abs(v) - G) < 1e-9) fill.classList.add('warn');
          bar.append(fill);
          td.append(bar);
          tr.append(td);
          tr.append(el('td', null, fmt(G - Math.abs(v), 4)));
          tbody.append(tr);
        }
        range.textContent = `抽头 ${lo}–${hi - 1} / ${r.taps}`;
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
      };
      prev.addEventListener('click', () => { if (page > 0) { page--; paint(); } });
      next.addEventListener('click', () => { if (page < pages - 1) { page++; paint(); } });
      paint();
      const tableWrap = el('div', 'taptable');
      tableWrap.append(table);
      card.append(nav, tableWrap);
      host.append(card);
      requestAnimationFrame(() => drawTapPlot(plot, tapsArr, G));
    }
  }

  function drawTapPlot(canvas, tapsArr, G) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = rect.width, h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const col = Chart.themeColors(canvas);
    const n = tapsArr.length;
    const mid = h / 2;
    // scale to the larger of the box and the realized taps so nothing clips
    let realized = 0;
    for (let k = 0; k < n; k++) { const a = Math.abs(tapsArr[k]); if (a > realized) realized = a; }
    const span = Math.max(G, realized, 1e-12) * 1.04;
    const yOf = (v) => mid - Math.max(-1, Math.min(1, v / span)) * (h / 2 - 2);
    // box edges
    ctx.strokeStyle = col.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const g of [G, -G]) {
      const y = Math.round(yOf(g)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = col.grid;
    const y0 = Math.round(mid) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke();
    // envelope
    ctx.strokeStyle = col.s1;
    ctx.lineWidth = 1.4;
    const buckets = Math.max(8, Math.floor(w));
    if (n <= buckets) {
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const x = (k / Math.max(1, n - 1)) * w;
        const y = yOf(tapsArr[k]);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      for (let b = 0; b < buckets; b++) {
        const i0 = Math.floor((b / buckets) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / buckets) * n));
        let lo = Infinity, hi = -Infinity;
        for (let k = i0; k < i1 && k < n; k++) { if (tapsArr[k] < lo) lo = tapsArr[k]; if (tapsArr[k] > hi) hi = tapsArr[k]; }
        if (!Number.isFinite(lo)) continue;
        const x = (b + 0.5) * (w / buckets);
        ctx.beginPath();
        ctx.moveTo(x, yOf(hi));
        ctx.lineTo(x, yOf(lo));
        ctx.stroke();
      }
    }
    // labels
    ctx.font = '10px ui-monospace, monospace';
    const label = `±G ${G}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = col.surface;
    ctx.fillRect(1, 1, tw + 4, 13);
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, 3, 2);
    ctx.textAlign = 'right';
    ctx.fillText(`k = ${n - 1}`, w - 3, h - 2);
  }

  /* ----------------------------- report view ----------------------------- */

  function renderReport() {
    const r = state.result;
    if (!r) return;
    const stats = $('reportStats');
    stats.textContent = '';
    const cards = [
      ['目标 E', fmt(r.objective, 5), '', '残差 + λ·抽头'],
      ['加权残差', fmt(r.objectiveResidual, 5), '', 'Σ w·SSE'],
      ['抽头正则', fmt(r.lambda * r.tapSum, 5), '', `λ = ${r.lambda}`],
      ['投影梯度', r.projectedResidual.toExponential(2), '', r.certification.withinTolerance ? '≤ 1e-7 核查通过' : '未通过', r.certification.withinTolerance ? 'ok' : 'bad'],
      ['迭代 / 轮', `${fmtInt(r.iterations)} / ${fmtInt(r.outer)}`, '', 'CG 步 / 主动集轮'],
      ['耗时', `${Math.round(r.elapsed)}`, 'ms', '单核满载'],
    ];
    for (const [k, v, u, d, cls] of cards) {
      const c = el('div', 'sc');
      c.append(el('div', 'k', k));
      const vv = el('div', 'v mono', v);
      if (u) vv.append(el('span', 'u', u));
      c.append(vv);
      if (d) c.append(el('div', `d${cls ? ' ' + cls : ''}`, d));
      stats.append(c);
    }
    renderReportCurves();

    // per channel
    const pc = $('reportPerChannel');
    pc.textContent = '';
    const t = el('table', 'data');
    const th = el('tr');
    for (const h of ['节目', '加权 SSE', 'λ·Σf²', 'E', '投影梯度']) th.append(el('th', null, h));
    const thead = el('thead'); thead.append(th); t.append(thead);
    const tb = el('tbody');
    for (const ch of r.perChannel) {
      const tr = el('tr');
      tr.append(el('td', 'lbl', `节目 ${ch.q + 1}`));
      tr.append(el('td', null, fmt(ch.residualSum, 6)));
      tr.append(el('td', null, fmt(r.lambda * ch.tapSum, 6)));
      tr.append(el('td', null, fmt(ch.objective, 6)));
      tr.append(el('td', null, ch.projectedResidual.toExponential(2)));
      tb.append(tr);
    }
    t.append(tb);
    pc.append(t);

    // geometry / cert kv
    const kv = $('reportKv');
    kv.textContent = '';
    const cert = r.certification;
    const pairs = [
      ['几何 N', String(r.geometry.N)],
      ['FFT L', String(r.geometry.L)],
      ['max h', String(r.geometry.maxH)],
      ['max conv', String(r.geometry.maxConv)],
      ['tags', `${r.taps} × ${r.P} × ${r.Q}`],
      ['核查抽头', fmtInt(cert.tapsChecked)],
      ['导出 PG', cert.projectedResidual.toExponential(2)],
      ['每通道 PG', cert.perChannelPg.map((v) => v.toExponential(1)).join(' · ')],
      ['越界量', cert.maxOverrun.toExponential(1)],
      ['结论', cert.withinTolerance ? '通过' : '未通过'],
    ];
    for (const [k, v] of pairs) {
      kv.append(el('span', 'k', k), el('span', 'v', v));
    }
    $('reportGeoAside').textContent = `delay ${r.delay} · λ ${r.lambda}`;

    // export json preview (truncated)
    $('exportSize').textContent = `${(r.exportText.length / 1024).toFixed(1)} KiB · ${r.P}×${r.Q}×${r.taps} 浮点数`;
    const preview = r.exportText.length > 4200 ? r.exportText.slice(0, 4200) + '\n…（截断预览，下载内容为完整 JSON）' : r.exportText;
    const pre = $('jsonPreview');
    pre.textContent = preview;
    $('jsonPreviewAside').textContent = `${(r.exportText.length / 1024).toFixed(1)} KiB`;

    // per measurement table
    const rt = $('reportTable').querySelector('tbody');
    rt.textContent = '';
    for (let q = 0; q < r.Q; q++) {
      for (let m = 0; m < r.M; m++) {
        const pm = r.perMeasurement[q][m];
        let tEnergy = 0;
        for (let i = 0; i < pm.target.length; i++) tEnergy += pm.target[i] * pm.target[i];
        const tr = el('tr');
        tr.append(el('td', 'lbl', `测点 ${m + 1}`));
        tr.append(el('td', null, fmt(r.weights[m], 3)));
        tr.append(el('td', null, `节目 ${q + 1}`));
        tr.append(el('td', null, fmt(pm.sse, 5)));
        tr.append(el('td', null, fmt(pm.rms, 5)));
        tr.append(el('td', null, fmt(pm.peak, 5)));
        tr.append(el('td', null, fmt(r.lambda * r.perChannel[q].tapSum, 5)));
        tr.append(el('td', null, fmt(tEnergy, 5)));
        rt.append(tr);
      }
    }
  }

  // One row per program channel: a small multiple per measurement showing
  // target, prediction and residual on a shared vertical scale.
  function renderReportCurves() {
    const r = state.result;
    const host = $('reportCurves');
    host.textContent = '';
    const cols = seriesColors();
    $('reportCurvesAside').textContent = '目标 / 预测 / 残差 · 全长度 N';
    for (let q = 0; q < r.Q; q++) {
      const block = el('div', 'rep-curve-block');
      const head = el('div', 'rep-head');
      head.append(el('span', 'tag', `节目 ${q + 1}`));
      const legend = el('div', 'legend');
      for (const [nm, color] of [['目标', cols.target], ['预测', cols.prediction], ['残差', cols.residual]]) {
        const it = el('span', 'item');
        const key = el('span', 'key');
        key.style.background = color;
        it.append(key, el('span', null, nm));
        legend.append(it);
      }
      head.append(legend);
      block.append(head);
      const grid = el('div', 'rep-grid');
      for (let m = 0; m < r.M; m++) {
        const pm = r.perMeasurement[q][m];
        const cell = el('div', 'rep-cell');
        const cap = el('div', 'cap');
        cap.append(el('span', 'nm', `测点 ${m + 1}`));
        cap.append(el('span', 'vv', `RMS ${fmt(pm.rms, 4)}`));
        const cv = el('canvas');
        cell.append(cap, cv);
        cell.addEventListener('click', () => {
          state.program = q; state.meas = m; state.view = 'curves';
          for (const bb of document.querySelectorAll('.tabs button')) {
            bb.setAttribute('aria-selected', String(bb.dataset.view === 'curves'));
          }
          renderAll();
        });
        grid.append(cell);
        requestAnimationFrame(() => Chart.drawMiniMulti(cv, [
          { values: pm.target, color: cols.target, width: 1.3 },
          { values: pm.prediction, color: cols.prediction, width: 1.3 },
          { values: pm.residual, color: cols.residual, width: 1 },
        ]));
      }
      block.append(grid);
      host.append(block);
    }
  }

  /* ------------------------------ exports -------------------------------- */

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function downloadFilters() {
    const r = state.result;
    if (!r) { toast('尚无已核查的滤波器'); return; }
    // Re-verify the exact text we are about to hand out.
    const decoded = JSON.parse(r.exportText);
    const cert = C.certifyExport(state.resultParams ? { ...state.cfg, ...state.resultParams } : state.cfg, decoded);
    if (!cert.withinTolerance) {
      toast('导出核查未通过，已阻止下载');
      showErrors('solveErrors', [{ path: 'filters.json', message: `投影梯度 ${cert.projectedResidual.toExponential(3)} 超限` }]);
      return;
    }
    let name = (state.caseName || 'array-inverse').replace(/\.zip$/i, '');
    download(`${name}-filters.json`, r.exportText, 'application/json');
    toast('已下载 ' + `${name}-filters.json`);
  }

  $('btnDownloadFilters').addEventListener('click', downloadFilters);
  $('btnDownloadAgain').addEventListener('click', downloadFilters);
  $('btnPrint').addEventListener('click', () => window.print());

  /* ------------------------------- tabs ---------------------------------- */

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      for (const bb of document.querySelectorAll('.tabs button')) {
        bb.setAttribute('aria-selected', String(bb === b));
      }
      renderAll();
    });
  }

  /* ------------------------------ import --------------------------------- */

  const dz = $('dropzone');
  const fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fi.click(); }
  });
  fi.addEventListener('change', async () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    await importZip(buf, f.name);
    fi.value = '';
  });
  dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    dz.classList.remove('drag');
    const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    if (!/\.zip$/i.test(f.name) && f.type !== 'application/zip') {
      showErrors('caseErrors', [{ path: f.name, message: '请导入 .zip 测量包' }]);
      return;
    }
    const buf = await f.arrayBuffer();
    await importZip(buf, f.name);
  });
  $('btnClearCase').addEventListener('click', () => {
    invalidatePending();
    state.cfg = null;
    state.result = null;
    state.resultParams = null;
    state.stale = false;
    state.caseName = '';
    $('caseInfo').classList.remove('show');
    $('summary').classList.remove('show');
    clearErrors();
    renderParams();
    renderAll();
    setStatus('idle', '未载入');
    $('chipM').textContent = '—';
    $('chipP').textContent = '—';
    $('chipQ').textContent = '—';
    $('chipN').textContent = '—';
  });

  $('btnSample').addEventListener('click', async () => {
    try {
      const res = await fetch('samples/array-inverse-cases.zip');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      await importZip(buf, 'array-inverse-cases.zip');
    } catch (err) {
      showErrors('caseErrors', [{
        path: 'samples/array-inverse-cases.zip',
        message: `无法读取示例（通过本地 HTTP 服务打开时可用，例如 python3 -m http.server）：${err.message}`,
      }]);
    }
  });

  // redraw on resize handled inside LineChart; redraw on theme change
  function redrawCharts() {
    if (!state.result) return;
    if (mainChart) mainChart.schedule();
    renderSeriesSeg();
    renderMiniGrid();
    renderReportCurves();
    if (state.view === 'filters') renderFilters();
  }
  window.addEventListener('theme-changed', redrawCharts);

  // keyboard: escape cancels a running solve
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.pending) cancelSolve();
  });

  renderParams();
  renderAll();
})();
