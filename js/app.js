/* 事件快门校片台 —— DOM/交互层。数值全部来自 window.EVLCore。 */
(function () {
  'use strict';
  const C = window.EVLCore;
  const $ = (id) => document.getElementById(id);

  const LOG_MIN = C.LIMITS.logMin;
  const LOG_MAX = C.LIMITS.logMax;
  const MISSING = C.LIMITS.missing;

  /** @type {{data:any,result:any,windows:number[][],activeWindow:number,layer:string,selected:number,busy:boolean,version:number,lastError:any,undoStack:any[],redoStack:any[],timings:any,chartRange:string,fileName:string,fileSize:number}} */
  const state = {
    data: null,
    result: null,
    windows: [[1000, 15000], [12000, 27000], [25000, 35000]],
    activeWindow: 0,
    layer: 'lum',
    selected: 0,
    busy: false,
    version: 0,
    lastError: null,
    undoStack: [],
    redoStack: [],
    timings: null,
    chartRange: 'auto',
    fileName: '',
    fileSize: 0,
    codesRev: 0,
    dirtyPixels: new Set(),
  };
  let computeGen = 0;
  const idleWaiters = [];

  // ---------------- 小工具 ----------------
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtCompactT(t) {
    if (Math.abs(t) >= 1e6) return (t / 1e6).toFixed(2) + 'M';
    if (Math.abs(t) >= 1000) return (t / 1000).toFixed(t % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(t));
  }
  function fmtSci(v, d = 6) {
    if (v === 0) return '0';
    if (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e5) return v.toFixed(d >= 8 ? 8 : 5);
    return v.toExponential(3);
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function setBusy(busy, label) {
    state.busy = busy;
    const line = $('perf-line');
    const track = $('progress-track');
    line.dataset.busy = busy ? 'true' : 'false';
    if (busy) {
      line.textContent = label || '计算中…';
      track.hidden = false;
      $('progress-bar').style.width = '4%';
    } else {
      track.hidden = true;
    }
    ['btn-undo', 'btn-redo'].forEach(() => updateUndoButtons());
    updateExportButtons();
    notifyIdle();
  }
  function setProgress(p) {
    $('progress-bar').style.width = `${Math.round(6 + p * 94)}%`;
  }
  function notifyIdle() {
    if (!state.busy) {
      while (idleWaiters.length) idleWaiters.shift()();
    }
  }
  function whenIdle() {
    if (!state.busy && state.result) return Promise.resolve();
    return new Promise((res) => idleWaiters.push(res));
  }

  // ---------------- 错误条 / 文件载入 ----------------
  function showFormatError(err) {
    state.lastError = { message: err.message, offset: err.offset, field: err.field, at: Date.now() };
    const banner = $('error-banner');
    banner.hidden = false;
    $('error-message').textContent = err.message || '文件不是合法 EVL1';
    $('error-offset').textContent = String(err.offset);
    $('error-offset-hex').textContent = `(0x${err.offset.toString(16).toUpperCase()})`;
    $('error-field').textContent = err.field || '?';
    document.body.dataset.lastErrorOffset = String(err.offset);
    const badge = $('data-badge');
    badge.textContent = '文件错误 · 已保留前次结果';
    badge.className = 'badge badge-error';
  }
  function clearError() {
    state.lastError = null;
    $('error-banner').hidden = true;
    delete document.body.dataset.lastErrorOffset;
  }
  $('error-close').addEventListener('click', () => { $('error-banner').hidden = true; });

  async function loadBuffer(input, name) {
    clearError();
    let buf;
    try {
      if (input instanceof ArrayBuffer) buf = input;
      else if (ArrayBuffer.isView(input)) buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      else throw new Error('需要 ArrayBuffer 或 TypedArray');
    } catch (e) {
      showFormatError(e);
      return { ok: false, error: e.message, offset: e.offset ?? null };
    }

    let data;
    const tParse0 = performance.now();
    try {
      data = C.parseEVL(buf);
    } catch (err) {
      if (err instanceof C.EVLFormatError) {
        showFormatError(err);
        return { ok: false, error: err.message, offset: err.offset, field: err.field };
      }
      throw err;
    }
    const parseMs = performance.now() - tParse0;

    // 新文件计算前先校验窗
    let wins;
    try { wins = C.validateWindows(state.windows); }
    catch (e) {
      state.windows = [[data.anchorTimes[0], data.anchorTimes[data.anchorCount - 1]]];
      wins = state.windows;
      renderWindowList();
    }

    const gen = ++computeGen;
    setBusy(true, `解析 ${parseMs.toFixed(0)} ms · 正在计算 ${wins.length} 窗…`);
    await tick();
    const tCalc0 = performance.now();
    let result;
    try {
      result = await C.computeAllAsync(data, wins, { onProgress: setProgress, yieldEvery: 8192 });
    } catch (err) {
      setBusy(false);
      showFormatError(new C.EVLFormatError(-1, 'compute', err.message));
      return { ok: false, error: err.message, offset: -1 };
    }
    const calcMs = performance.now() - tCalc0;
    if (gen !== computeGen) return { ok: false, stale: true };

    // 原子提交：失败的文件永远不会覆盖前次结果
    state.data = data;
    state.result = result;
    state.fileName = name || 'buffer.evl';
    state.fileSize = buf.byteLength;
    state.selected = 0;
    state.activeWindow = Math.min(state.activeWindow, wins.length - 1);
    state.undoStack.length = 0;
    state.redoStack.length = 0;
    state.dirtyPixels.clear();
    state.timings = { parseMs, calcMs, totalMs: parseMs + calcMs, bytes: buf.byteLength };
    state.version++;

    setBusy(false);
    renderAll();
    return { ok: true, ...state.timings };
  }

  async function loadSample() {
    const candidates = [
      'examples/turntable.evl',
      'samples/extracted/turntable.evl',
      './examples/turntable.evl',
    ];
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        // 同时尝试载入 shutters 窗
        try {
          const jr = await fetch('examples/shutters.json');
          if (!jr.ok) throw new Error('no examples shutters');
          const jw = await jr.json();
          if (Array.isArray(jw) && jw.length) state.windows = C.validateWindows(jw);
        } catch {
          try {
            const jr2 = await fetch('samples/extracted/shutters.json');
            if (jr2.ok) {
              const jw2 = await jr2.json();
              if (Array.isArray(jw2) && jw2.length) state.windows = C.validateWindows(jw2);
            }
          } catch { /* file:// 时使用内置同款三窗 */ }
        }
        return loadBuffer(buf, 'turntable.evl');
      } catch { /* try next */ }
    }
    // fetch 在 file:// 被拦截：提示用文件选择
    $('window-form-error').hidden = false;
    $('window-form-error').textContent = '浏览器拦截了 file:// 下的 fetch，请用「打开 EVL1 文件」选择 samples/extracted/turntable.evl';
    return { ok: false, fetchBlocked: true };
  }

  // ---------------- 窗口面板 ----------------
  function renderWindowList() {
    const list = $('window-list');
    list.innerHTML = '';
    state.windows.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'window-row' + (i === state.activeWindow ? ' is-active' : '');
      row.dataset.testid = 'window-row';
      row.dataset.index = String(i);
      row.innerHTML = `
        <span class="window-index">${String(i + 1).padStart(2, '0')}</span>
        <input type="number" data-role="start" data-testid="window-start-${i}" value="${w[0]}" min="0" max="4294967295" step="1" aria-label="窗 ${i + 1} 起点">
        <input type="number" data-role="end" data-testid="window-end-${i}" value="${w[1]}" min="0" max="4294967295" step="1" aria-label="窗 ${i + 1} 终点">
        <button type="button" class="win-export" data-role="row-export" data-testid="window-export-${i}" title="导出第 ${i + 1} 窗 LUM1" ${state.result ? '' : 'disabled'}>⤓</button>`;
      list.appendChild(row);
    });
    const addBtn = $('btn-add-window');
    addBtn.disabled = state.windows.length >= C.LIMITS.maxWindows;
    addBtn.textContent = state.windows.length >= C.LIMITS.maxWindows
      ? '已达 24 窗上限'
      : `＋ 新增窗（${state.windows.length}/24）`;
    renderWindowSelect();
  }

  function renderWindowSelect() {
    const sel = $('active-window-select');
    const prev = state.activeWindow;
    sel.innerHTML = state.windows.map((w, i) =>
      `<option value="${i}" ${i === prev ? 'selected' : ''}>#${i + 1} [${w[0]}, ${w[1]})</option>`).join('');
    sel.value = String(state.activeWindow);
  }

  function readWindowRows() {
    const rows = [...$('window-list').querySelectorAll('.window-row')];
    const wins = [];
    let firstBad = null;
    for (let i = 0; i < rows.length; i++) {
      const sEl = rows[i].querySelector('[data-role=start]');
      const eEl = rows[i].querySelector('[data-role=end]');
      sEl.classList.remove('invalid'); eEl.classList.remove('invalid');
      const s = Number(sEl.value);
      const e = Number(eEl.value);
      let bad = !Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0 ||
        s > C.LIMITS.u32Max || e > C.LIMITS.u32Max || !(s < e);
      if (bad) {
        sEl.classList.add('invalid'); eEl.classList.add('invalid');
        if (!firstBad) firstBad = i;
      }
      wins.push([s, e]);
    }
    if (firstBad !== null) {
      const err = new Error(`第 ${firstBad + 1} 窗非法：需为 0..4294967295 的整数且 start < end`);
      err.windowIndex = firstBad;
      throw err;
    }
    return wins;
  }

  async function commitWindows(reason) {
    let wins;
    try { wins = readWindowRows(); }
    catch (e) {
      $('window-form-error').hidden = false;
      $('window-form-error').textContent = e.message;
      return false;
    }
    $('window-form-error').hidden = true;
    $('window-form-error').textContent = '';
    state.windows = wins;
    state.activeWindow = Math.min(state.activeWindow, wins.length - 1);
    // 不重建窗口行：避免提交时替换正在输入/聚焦的输入框；只同步下拉标签
    renderWindowSelect();
    if (state.data) await recompute('window-edit');
    return true;
  }

  let debounceTimer = 0;
  function scheduleWindowCommit() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { commitWindows('window-edit'); }, 260);
  }

  $('window-list').addEventListener('change', (ev) => {
    const row = ev.target.closest('.window-row');
    if (!row) return;
    if (ev.target.matches('input')) { clearTimeout(debounceTimer); commitWindows('window-edit'); }
  });
  $('window-list').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('input')) {
      clearTimeout(debounceTimer);
      commitWindows('window-edit');
    }
  });
  $('window-list').addEventListener('input', (ev) => {
    if (ev.target.matches('input')) scheduleWindowCommit();
  });
  $('window-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-role=row-export]');
    if (btn) {
      const row = btn.closest('.window-row');
      exportWindow(Number(row.dataset.index));
      return;
    }
    const row = ev.target.closest('.window-row');
    if (row && !ev.target.matches('input')) {
      state.activeWindow = Number(row.dataset.index);
      renderWindowList(); renderPreview(); renderChart(); renderPixelTable();
    }
  });

  $('active-window-select').addEventListener('change', (e) => {
    state.activeWindow = Number(e.target.value);
    renderWindowList(); renderPreview(); renderChart(); renderPixelTable();
  });

  $('btn-add-window').addEventListener('click', async () => {
    if (state.windows.length >= 24) return;
    let s = 0, e = 10000;
    if (state.data) {
      const at = state.data.anchorTimes;
      s = at[0]; e = at[at.length - 1];
      if (e <= s) e = s + 1;
    } else if (state.windows.length) {
      const last = state.windows[state.windows.length - 1];
      const len = Math.max(1, last[1] - last[0]);
      s = Math.min(C.LIMITS.u32Max - len, last[1]);
      e = s + len;
    }
    state.windows.push([s, e]);
    state.activeWindow = state.windows.length - 1;
    renderWindowList();
    if (state.data) await recompute('add-window');
  });

  $('btn-even24').addEventListener('click', async () => {
    if (!state.data) {
      $('window-form-error').hidden = false;
      $('window-form-error').textContent = '请先载入 EVL1，再按锚区间生成 24 个均分窗';
      return;
    }
    const at = state.data.anchorTimes;
    const lo = at[0], hi = at[at.length - 1];
    const span = Math.max(25, hi - lo);
    const bounds = [];
    for (let i = 0; i <= 24; i++) bounds.push(lo + Math.floor((i * span) / 24));
    bounds[24] = hi;
    const wins = [];
    for (let i = 0; i < 24; i++) {
      let s = bounds[i], e = bounds[i + 1];
      if (e <= s) e = Math.min(C.LIMITS.u32Max, s + 1);
      wins.push([s, e]);
    }
    state.windows = C.validateWindows(wins);
    state.activeWindow = 0;
    renderWindowList();
    await recompute('even24');
  });

  $('btn-shutters').addEventListener('click', async () => {
    let loaded = false;
    for (const url of ['examples/shutters.json', 'samples/extracted/shutters.json']) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          state.windows = C.validateWindows(await resp.json());
          loaded = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!loaded) state.windows = C.validateWindows([[1000, 15000], [12000, 27000], [25000, 35000]]);
    state.activeWindow = 0;
    renderWindowList();
    if (state.data) await recompute('shutters');
  });

  async function setWindows(list) {
    const wins = C.validateWindows(list);
    state.windows = wins;
    state.activeWindow = Math.min(state.activeWindow, wins.length - 1);
    renderWindowList();
    if (state.data) await recompute('api-setwindows');
    return state.windows;
  }

  async function recompute() {
    if (!state.data) return;
    const gen = ++computeGen;
    const wins = state.windows;
    const revAtStart = state.codesRev;
    setBusy(true, `正在计算 ${wins.length} 窗 × ${state.data.pixels.toLocaleString()} 像素…`);
    await tick();
    const t0 = performance.now();
    const result = await C.computeAllAsync(state.data, wins, { onProgress: setProgress, yieldEvery: 8192 });
    if (gen !== computeGen) return; // 已有更新的窗口/载入计算，本结果作废
    // 计算途中若改过锚值，逐脏像素按当前码对账，杜绝跨分块的新旧混合
    if (state.codesRev !== revAtStart && state.dirtyPixels.size) {
      const P = state.data.pixels, W = wins.length;
      const dur = new Float64Array(W), intg = new Float64Array(W);
      for (const p of state.dirtyPixels) {
        C.computePixelInto(state.data, p, wins, result.lum, result.cov, P, dur, intg);
      }
    }
    state.dirtyPixels.clear();
    state.result = result;
    state.version++;
    if (state.timings) state.timings.calcMs = performance.now() - t0;
    setBusy(false);
    renderPreview(); renderChart(); renderAnchorList(); renderPixelTable(); updatePerfLine();
    $('version-label').textContent = `v${state.version}`;
  }

  function updatePerfLine() {
    const t = state.timings;
    if (!t || !state.data) return;
    const calc = state.result ? '' : '';
    $('perf-line').innerHTML =
      `解析 ${t.parseMs.toFixed(0)} ms · 最近全量计算 ${(t.calcMs || 0).toFixed(0)} ms · 载入总计 ${t.totalMs.toFixed(0)} ms`;
    $('perf-line').dataset.parseMs = String(Math.round(t.parseMs));
    $('perf-line').dataset.calcMs = String(Math.round(t.calcMs || 0));
    void calc;
  }

  // ---------------- 预览 ----------------
  const canvas = $('preview-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  function renderPreview() {
    if (!state.data || !state.result) return;
    const { width: W, height: H, pixels: P } = state.data;
    canvas.width = W; canvas.height = H;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const wi = state.activeWindow;
    const base = wi * P;
    const lum = state.result.lum;
    const cov = state.result.cov;
    const layer = state.layer;
    for (let p = 0; p < P; p++) {
      let g;
      if (layer === 'lum') g = Math.round(255 * clamp01(lum[base + p]));
      else g = Math.round(255 * clamp01(cov[base + p]));
      const k = p * 4;
      d[k] = g; d[k + 1] = g; d[k + 2] = g; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    $('preview-empty').hidden = true;
    updateMarker();
    updateReadout(null);
  }

  function updateMarker() {
    const m = $('pixel-marker');
    if (!state.data) { m.hidden = true; return; }
    const { width: W, height: H } = state.data;
    const x = state.selected % W;
    const y = Math.floor(state.selected / W);
    m.hidden = false;
    m.style.left = `${(x / W) * 100}%`;
    m.style.top = `${(y / H) * 100}%`;
    m.style.width = `${100 / W}%`;
    m.style.height = `${100 / H}%`;
  }

  function eventToPixel(ev) {
    const rect = canvas.getBoundingClientRect();
    const { width: W, height: H } = state.data;
    let x = Math.floor(((ev.clientX - rect.left) / rect.width) * W);
    let y = Math.floor(((ev.clientY - rect.top) / rect.height) * H);
    x = Math.max(0, Math.min(W - 1, x));
    y = Math.max(0, Math.min(H - 1, y));
    return { x, y, p: y * W + x };
  }

  function updateReadout(xy) {
    const el = $('preview-readout');
    if (!state.data || !state.result) { el.textContent = '移动/点按画面选择像素'; return; }
    const p = xy ? xy.p : state.selected;
    const { width: W } = state.data;
    const x = p % W, y = Math.floor(p / W);
    const wi = state.activeWindow;
    const i = wi * state.data.pixels + p;
    const L = state.result.lum[i], Cov = state.result.cov[i];
    el.innerHTML = xy
      ? `x=${x} y=${y} #${p} · 亮度 <b>${fmtSci(L, 8)}</b> · 覆盖率 <b>${Cov.toFixed(7)}</b>`
      : `选中 x=${x} y=${y} #${p} · 亮度 <b>${fmtSci(L, 8)}</b> · 覆盖率 <b>${Cov.toFixed(7)}</b>`;
  }

  canvas.addEventListener('click', (ev) => {
    if (!state.data) return;
    const { p } = eventToPixel(ev);
    selectPixel(p);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!state.data) return;
    const xy = eventToPixel(ev);
    updateReadout(xy);
  });
  canvas.addEventListener('pointerleave', () => updateReadout(null));

  document.querySelectorAll('.seg-btn[data-layer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn[data-layer]').forEach((b) => b.classList.toggle('is-active', b === btn));
      state.layer = btn.dataset.layer;
      $('cov-legend').hidden = state.layer !== 'cov';
      renderPreview();
    });
  });

  function selectPixel(xOrP, maybeY) {
    if (!state.data) return;
    let p;
    if (maybeY !== undefined) p = maybeY * state.data.width + xOrP;
    else p = xOrP;
    p = Math.max(0, Math.min(state.data.pixels - 1, p | 0));
    state.selected = p;
    const x = p % state.data.width, y = Math.floor(p / state.data.width);
    $('pixel-x').value = x; $('pixel-y').value = y;
    $('pixel-index-label').textContent = `#${p} / ${state.data.pixels}`;
    updateMarker(); updateReadout(null); renderAnchorList(); renderChart(); renderPixelTable();
  }
  $('pixel-x').addEventListener('change', () => {
    const x = Number($('pixel-x').value), y = Number($('pixel-y').value) || 0;
    if (state.data && Number.isInteger(x)) selectPixel(Math.min(state.data.width - 1, Math.max(0, x)), y);
  });
  $('pixel-y').addEventListener('change', () => {
    const x = Number($('pixel-x').value) || 0, y = Number($('pixel-y').value);
    if (state.data && Number.isInteger(y)) selectPixel(x, Math.min(state.data.height - 1, Math.max(0, y)));
  });
  $('chart-range').addEventListener('change', (e) => { state.chartRange = e.target.value; renderChart(); });

  // ---------------- 锚编辑 + 撤销 ----------------
  function renderAnchorList() {
    const box = $('anchor-list');
    if (!state.data) { box.innerHTML = '<p class="muted">载入文件后可编辑该像素锚值</p>'; return; }
    const A = state.data.anchorCount;
    const p = state.selected;
    const base = p * A;
    box.innerHTML = '';
    for (let a = 0; a < A; a++) {
      const code = state.data.codes[base + a];
      const missing = code === MISSING;
      const row = document.createElement('div');
      row.className = 'anchor-row' + (missing ? ' is-missing' : '');
      row.dataset.testid = 'anchor-row';
      row.dataset.anchor = String(a);
      const logTxt = missing ? '缺测' : `L=${(code / 256).toFixed(3)}`;
      row.innerHTML = `
        <span class="anchor-index">A${a}</span>
        <div class="anchor-main">
          <div class="anchor-top">
            <span class="anchor-time" title="锚时标 µs">t=${fmtInt(state.data.anchorTimes[a])} µs</span>
            <button type="button" class="icon-btn ${missing ? '' : 'danger'}" data-role="toggle-missing"
              data-testid="anchor-missing-${a}">${missing ? '恢复为 0' : '设缺测'}</button>
          </div>
          <div class="anchor-code-wrap">
            <input type="number" step="1" data-role="code" data-testid="anchor-code-${a}"
              value="${missing ? '' : code}" placeholder="${MISSING} 缺测"
              aria-label="锚 ${a} 码值"/>
            <span class="anchor-log" data-role="log">${logTxt}</span>
          </div>
        </div>`;
      box.appendChild(row);

      const input = row.querySelector('[data-role=code]');
      const commitCode = () => {
        const raw = input.value.trim();
        if (raw === '') { applyAnchorChange(p, a, MISSING); return; }
        const v = Number(raw);
        if (!Number.isInteger(v) || !(v === MISSING || (v >= C.LIMITS.codeMin && v <= C.LIMITS.codeMax))) {
          input.classList.add('invalid');
          input.title = `合法码值为整数 ${C.LIMITS.codeMin}..${C.LIMITS.codeMax}，或 ${MISSING} 缺测`;
          setTimeout(() => renderAnchorList(), 1400);
          return;
        }
        applyAnchorChange(p, a, v === MISSING ? MISSING : v);
      };
      input.addEventListener('change', commitCode);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      row.querySelector('[data-role=toggle-missing]').addEventListener('click', () => {
        applyAnchorChange(p, a, missing ? 0 : MISSING);
      });
    }
    updateUndoButtons();
  }

  function refreshAfterPixelEdit(p) {
    if (!state.result) return;
    const W = state.windows.length, P = state.data.pixels;
    const dur = new Float64Array(W), intg = new Float64Array(W);
    C.computePixelInto(state.data, p, state.windows, state.result.lum, state.result.cov, P, dur, intg);
    state.version++;
    $('version-label').textContent = `v${state.version}`;
    renderPreview(); renderAnchorList(); renderChart(); renderPixelTable(); updateUndoButtons();
  }

  function applyAnchorChange(p, a, nextCode, record = true) {
    if (!state.data) return false;
    const idx = p * state.data.anchorCount + a;
    const prev = state.data.codes[idx];
    if (prev === nextCode) { renderAnchorList(); return false; }
    state.data.codes[idx] = nextCode;
    state.codesRev++;
    state.dirtyPixels.add(p);
    if (record) {
      state.undoStack.push({ p, a, before: prev, after: nextCode });
      state.redoStack.length = 0;
    }
    if (state.busy) {
      // 全量计算在途：只刷新不依赖结果的锚行；结果提交前会按脏像素对账
      renderAnchorList();
      updateUndoButtons();
    } else {
      refreshAfterPixelEdit(p);
    }
    return true;
  }

  function undo() {
    if (!state.undoStack.length) return;
    const cmd = state.undoStack.pop();
    state.data.codes[cmd.p * state.data.anchorCount + cmd.a] = cmd.before;
    state.codesRev++;
    state.dirtyPixels.add(cmd.p);
    state.redoStack.push(cmd);
    if (cmd.p !== state.selected) selectPixel(cmd.p);
    if (state.busy) { renderAnchorList(); updateUndoButtons(); }
    else refreshAfterPixelEdit(cmd.p);
  }
  function redo() {
    if (!state.redoStack.length) return;
    const cmd = state.redoStack.pop();
    state.data.codes[cmd.p * state.data.anchorCount + cmd.a] = cmd.after;
    state.codesRev++;
    state.dirtyPixels.add(cmd.p);
    state.undoStack.push(cmd);
    if (cmd.p !== state.selected) selectPixel(cmd.p);
    if (state.busy) { renderAnchorList(); updateUndoButtons(); }
    else refreshAfterPixelEdit(cmd.p);
  }
  function updateUndoButtons() {
    const u = $('btn-undo'), r = $('btn-redo');
    if (!u) return;
    u.disabled = state.undoStack.length === 0;
    r.disabled = state.redoStack.length === 0;
    u.title = state.undoStack.length ? `撤销（剩 ${state.undoStack.length} 步）` : '没有可撤销的锚值修改';
  }
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // 输入框内保留原生撤销文本；Ctrl+Enter 不强抢
      if (!e.shiftKey && e.key.toLowerCase() === 'z' && e.target.type !== 'number') return;
    }
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (e.key.toLowerCase() === 'y') {
      e.preventDefault(); redo();
    }
  });

  // ---------------- 像素逐窗表 ----------------
  function renderPixelTable() {
    const body = $('pixel-window-body');
    if (!state.data || !state.result) { body.innerHTML = ''; return; }
    const p = state.selected, P = state.data.pixels;
    body.innerHTML = state.windows.map((w, i) => {
      const idx = i * P + p;
      const lum = state.result.lum[idx], cov = state.result.cov[idx];
      const dur = cov > 0 ? Math.round(cov * (w[1] - w[0])) : 0;
      return `<tr class="${i === state.activeWindow ? 'is-active' : ''}" data-testid="pw-row" data-window="${i}">
        <td>${i + 1}</td>
        <td class="num">[${fmtInt(w[0])}, ${fmtInt(w[1])})</td>
        <td class="num">${lum.toPrecision(9)}</td>
        <td class="num">${cov.toFixed(7)}</td>
        <td class="num">${fmtInt(dur)}</td>
      </tr>`;
    }).join('');
    body.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
      state.activeWindow = Number(tr.dataset.window);
      $('active-window-select').value = String(state.activeWindow);
      renderWindowList(); renderPreview(); renderChart(); renderPixelTable();
    }));
  }

  // ---------------- 有效区段 chips ----------------
  function renderSegments() {
    const box = $('segment-list');
    if (!state.data) { box.innerHTML = ''; return; }
    const p = state.selected, A = state.data.anchorCount, at = state.data.anchorTimes, codes = state.data.codes;
    const base = p * A;
    const runs = C.buildPixelRuns(state.data, p);
    const validRange = runs.map((r) => `[${fmtInt(r.start)}, ${fmtInt(r.end)}]`).join('、') || '无';
    let html = `<div class="seg-chip valid"><b>有效连续段</b> ${validRange}<span class="muted">（连续 ≥2 个有效锚；孤立锚不贡献曝光）</span></div>`;
    for (let k = 0; k < A - 1; k++) {
      const ok = codes[base + k] !== MISSING && codes[base + k + 1] !== MISSING;
      const dur = at[k + 1] - at[k];
      html += `<div class="seg-chip ${ok ? 'valid' : 'invalid'}" data-testid="segment-chip" data-segment="${k}" data-valid="${ok}">
        <b>${ok ? '有效' : '无效'}</b>
        <span>锚 ${k}–${k + 1}</span>
        <code>[${fmtInt(at[k])}, ${fmtInt(at[k + 1])})</code>
        <span class="muted">${fmtInt(dur)} µs${ok ? '' : ' · 端点缺测，不跨越重连'}</span>
      </div>`;
    }
    box.innerHTML = html;
  }

  // ---------------- SVG 图表 ----------------
  function clampLog(z) { return z < LOG_MIN ? LOG_MIN : z > LOG_MAX ? LOG_MAX : z; }

  function chartDomain() {
    const at = state.data.anchorTimes;
    let lo = at[0], hi = at[at.length - 1];
    const mode = state.chartRange;
    const aw = state.windows[state.activeWindow] || [lo, hi];
    if (mode === 'window') { lo = aw[0]; hi = aw[1]; }
    else if (mode === 'auto') { lo = Math.min(lo, aw[0]); hi = Math.max(hi, aw[1]); }
    else if (mode === 'allwindows') {
      lo = Math.min(...state.windows.map((w) => w[0]));
      hi = Math.max(...state.windows.map((w) => w[1]));
    }
    if (!(hi > lo)) hi = lo + 1;
    const pad = Math.max(1, (hi - lo) * 0.03);
    return { lo: lo - pad, hi: hi + pad };
  }

  function renderChart() {
    renderSegments();
    const host = $('chart-container');
    if (!state.data) { host.innerHTML = '<p class="muted" style="padding:24px">载入 EVL1 后显示该像素轨迹</p>'; return; }
    const p = state.selected;
    const data = state.data;
    const Wpx = Math.max(340, host.clientWidth || 720);
    const Hpx = 360;
    const M = { l: 56, r: 18, t: 16, b: 64 };
    const pw = Wpx - M.l - M.r, ph = Hpx - M.t - M.b;
    const dom = chartDomain();
    const X = (t) => M.l + ((t - dom.lo) / (dom.hi - dom.lo)) * pw;
    const Y = (z) => M.t + (1 - (clampLog(z) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * ph;

    const runs = C.buildPixelRuns(data, p);
    const at = data.anchorTimes, A = data.anchorCount, codes = data.codes, base = p * A;

    let svg = `<svg viewBox="0 0 ${Wpx} ${Hpx}" width="${Wpx}" height="${Hpx}" role="img" aria-label="像素 ${p} 的对数亮度轨迹">`;
    svg += `<defs>
      <clipPath id="plot-clip"><rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}"/></clipPath>
      <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="var(--invalid-band)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--series-red)" stroke-width="1.4" opacity=".5"/>
      </pattern>
    </defs>`;

    // 绘图区背景与横向网格
    svg += `<rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}" fill="var(--surface-2)" stroke="var(--border)" rx="8"/>`;
    for (const z of [-24, -16, -8, 0, 8]) {
      const y = Y(z);
      svg += `<line x1="${M.l}" y1="${y}" x2="${M.l + pw}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
      svg += `<text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">${z}</text>`;
    }
    svg += `<text x="14" y="${M.t + 4}" font-size="11" fill="var(--muted)">log₂</text>`;

    // x 刻度 ~6 个
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const t = dom.lo + ((dom.hi - dom.lo) * i) / ticks;
      const x = X(t);
      svg += `<line x1="${x}" y1="${M.t + ph}" x2="${x}" y2="${M.t + ph + 5}" stroke="var(--border-strong)"/>`;
      svg += `<text x="${x}" y="${M.t + ph + 18}" text-anchor="middle" font-size="10.5" fill="var(--muted)" font-family="var(--mono)">${fmtCompactT(t)}</text>`;
    }
    svg += `<text x="${M.l + pw}" y="${Hpx - 4}" text-anchor="end" font-size="10.5" fill="var(--muted)">时间 t (µs)</text>`;

    const inX = (t) => t >= dom.lo && t <= dom.hi;

    // 首末锚之外的无锚覆盖
    const tFirst = at[0], tLast = at[A - 1];
    if (dom.lo < tFirst) svg += bandRect(dom.lo, Math.min(tFirst, dom.hi), 'url(#hatch)', X, Y, M, ph);
    if (dom.hi > tLast) svg += bandRect(Math.max(tLast, dom.lo), dom.hi, 'url(#hatch)', X, Y, M, ph);

    // 无效锚间段
    for (let k = 0; k < A - 1; k++) {
      if (codes[base + k] === MISSING || codes[base + k + 1] === MISSING) {
        svg += bandRect(at[k], at[k + 1], 'url(#hatch)', X, Y, M, ph);
      }
    }
    // 有效 run 底色
    for (const r of runs) {
      if (r.end > dom.lo && r.start < dom.hi) {
        const x0 = X(Math.max(r.start, dom.lo)), x1 = X(Math.min(r.end, dom.hi));
        svg += `<rect x="${x0}" y="${M.t}" width="${Math.max(1, x1 - x0)}" height="${ph}" fill="var(--valid-band)"/>`;
      }
    }

    // 当前曝光窗 band
    const win = state.windows[state.activeWindow];
    if (win && win[1] > dom.lo && win[0] < dom.hi) {
      const x0 = X(Math.max(win[0], dom.lo)), x1 = X(Math.min(win[1], dom.hi));
      svg += `<rect x="${x0}" y="${M.t}" width="${Math.max(1.5, x1 - x0)}" height="${ph + 26}" fill="var(--window-band)" stroke="var(--window-edge)" stroke-dasharray="5 3" stroke-width="1"/>`;
      svg += `<text x="${x0 + 4}" y="${M.t + 12}" font-size="10.5" fill="var(--warn)" font-family="var(--mono)">窗#${state.activeWindow + 1}</text>`;
    }

    // 轨迹（精确折线 or 列包络抽稀）
    let totalIntervals = 0;
    for (const r of runs) totalIntervals += r.T.length;
    const decimate = totalIntervals > 1400;
    if (!decimate) {
      let dPath = '';
      for (const r of runs) {
        const { T, Z, B } = r;
        const K = T.length;
        for (let j = 0; j < K; j++) {
          const t0 = T[j], z0 = Z[j], b = B[j];
          const tend = j + 1 < K ? T[j + 1] : r.end;
          if (tend < dom.lo || t0 > dom.hi) continue;
          const pts = [[t0, z0]];
          if (b !== 0) {
            for (const bound of [LOG_MIN, LOG_MAX]) {
              const x = (bound - z0) / b;
              const tc = t0 + x;
              if (tc > t0 && tc < tend) pts.push([tc, bound]);
            }
          }
          pts.push([tend, z0 + b * (tend - t0)]);
          pts.sort((u, v) => u[0] - v[0]);
          pts.forEach(([t, z], qi) => {
            dPath += `${qi === 0 ? 'M' : 'L'}${X(t).toFixed(2)},${Y(z).toFixed(2)} `;
          });
        }
      }
      svg += `<g clip-path="url(#plot-clip)"><path d="${dPath}" fill="none" stroke="var(--text)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></g>`;
      // 事件阶跃虚线
      let jumps = '';
      for (const r of runs) {
        const { T, Z, B } = r;
        for (let j = 1; j < T.length; j++) {
          const t = T[j];
          const pre = Z[j - 1] + B[j - 1] * (t - T[j - 1]);
          const post = Z[j];
          if (Math.abs(pre - post) < 1e-8) continue;
          if (!inX(t)) continue;
          jumps += `<line x1="${X(t)}" y1="${Y(pre)}" x2="${X(t)}" y2="${Y(post)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2" opacity=".7"/>`;
        }
      }
      svg += `<g clip-path="url(#plot-clip)">${jumps}</g>`;
    } else {
      // 按像素列记录 y 最小/最大包络
      const cols = Math.max(64, Math.floor(pw));
      const yMin = new Float64Array(cols).fill(Infinity);
      const yMax = new Float64Array(cols).fill(-Infinity);
      const put = (t, z) => {
        const cx = Math.floor(((t - dom.lo) / (dom.hi - dom.lo)) * pw);
        if (cx < 0 || cx >= cols) return;
        const y = Y(z);
        if (y < yMin[cx]) yMin[cx] = y;
        if (y > yMax[cx]) yMax[cx] = y;
      };
      for (const r of runs) {
        const { T, Z, B } = r; const K = T.length;
        for (let j = 0; j < K; j++) {
          const tend = j + 1 < K ? T[j + 1] : r.end;
          put(T[j], Z[j]);
          put(tend, Z[j] + B[j] * (tend - T[j]));
        }
      }
      let dPath = '';
      for (let c = 0; c < cols; c++) {
        if (Number.isFinite(yMin[c])) dPath += `M${(M.l + c + 0.5).toFixed(1)},${yMin[c].toFixed(1)}V${yMax[c].toFixed(1)} `;
      }
      svg += `<g clip-path="url(#plot-clip)"><path d="${dPath}" fill="none" stroke="var(--text)" stroke-width="1.5"/></g>`;
      svg += `<text x="${M.l + 8}" y="${M.t + 14}" font-size="10.5" fill="var(--muted)">密集轨迹已按像素列包络抽稀</text>`;
    }

    // 锚点
    for (let a = 0; a < A; a++) {
      const t = at[a];
      if (!inX(t)) continue;
      const x = X(t);
      if (codes[base + a] === MISSING) {
        const yy = Y(LOG_MIN) - 12;
        svg += `<rect x="${x - 4.5}" y="${yy - 4.5}" width="9" height="9" transform="rotate(45 ${x} ${yy})" fill="var(--surface)" stroke="var(--series-amber)" stroke-width="2"/>`;
        svg += `<text x="${x}" y="${yy - 9}" text-anchor="middle" font-size="10" fill="var(--warn)">缺</text>`;
      } else {
        const y = Y(codes[base + a] / 256);
        svg += `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" fill="var(--series-blue)" stroke="var(--surface)" stroke-width="1.6"/>`;
        svg += `<text x="${x}" y="${y - 9}" text-anchor="middle" font-size="10" fill="var(--series-blue)" font-family="var(--mono)">${a}</text>`;
      }
    }

    // 事件 rug（同刻合并；过密则分箱）
    const gs = data.gStart;
    const rawEvents = [];
    for (let q = gs[p]; q < gs[p + 1]; q++) rawEvents.push([data.gTime[q], data.gPol[q]]);
    const merged = new Map();
    for (const [t, d] of rawEvents) merged.set(t, (merged.get(t) || 0) + d);
    const mEvents = [...merged.entries()].sort((a, b) => a[0] - b[0]);
    const baseY = M.t + ph + 34;
    svg += `<line x1="${M.l}" y1="${baseY}" x2="${M.l + pw}" y2="${baseY}" stroke="var(--border)"/>`;
    svg += `<text x="${M.l - 8}" y="${baseY + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)">事件</text>`;
    if (mEvents.length <= 700) {
      for (const [t, d] of mEvents) {
        if (!inX(t)) continue;
        const x = X(t);
        const col = d >= 0 ? 'var(--series-red)' : 'var(--series-blue)';
        const h = Math.min(11, 4 + Math.abs(d) * 1.6);
        if (d >= 0) svg += `<line x1="${x}" y1="${baseY - 2}" x2="${x}" y2="${baseY - 2 - h}" stroke="${col}" stroke-width="1.4"/>`;
        else svg += `<line x1="${x}" y1="${baseY + 2}" x2="${x}" y2="${baseY + 2 + h}" stroke="${col}" stroke-width="1.4"/>`;
      }
    } else {
      const bins = 260;
      const bp = new Int32Array(bins), bn = new Int32Array(bins);
      for (const [t, d] of mEvents) {
        const c = Math.floor(((t - dom.lo) / (dom.hi - dom.lo)) * bins);
        if (c < 0 || c >= bins) continue;
        if (d >= 0) bp[c] += d; else bn[c] += -d;
      }
      const mx = Math.max(1, ...bp, ...bn);
      for (let c = 0; c < bins; c++) {
        const x = M.l + (c + 0.5) / bins * pw;
        if (bp[c]) {
          const h = 2 + 9 * bp[c] / mx;
          svg += `<line x1="${x}" y1="${baseY - 2}" x2="${x}" y2="${baseY - 2 - h}" stroke="var(--series-red)" stroke-width="${Math.max(1, pw / bins * 0.7)}"/>`;
        }
        if (bn[c]) {
          const h = 2 + 9 * bn[c] / mx;
          svg += `<line x1="${x}" y1="${baseY + 2}" x2="${x}" y2="${baseY + 2 + h}" stroke="var(--series-blue)" stroke-width="${Math.max(1, pw / bins * 0.7)}"/>`;
        }
      }
    }

    // 十字线层
    svg += `<line id="chart-cross" x1="0" y1="${M.t}" x2="0" y2="${M.t + ph}" stroke="var(--primary)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
    svg += `<rect id="chart-hover" x="${M.l}" y="${M.t}" width="${pw}" height="${ph + 40}" fill="transparent"/>`;
    svg += `</svg>`;
    host.innerHTML = svg;

    const hover = $('chart-hover');
    const cross = $('chart-cross');
    const tip = $('chart-tooltip');
    hover.addEventListener('pointermove', (ev) => {
      const rect = host.querySelector('svg').getBoundingClientRect();
      const sx = (ev.clientX - rect.left) * (Wpx / rect.width);
      let t = dom.lo + ((sx - M.l) / pw) * (dom.hi - dom.lo);
      t = Math.max(dom.lo, Math.min(dom.hi, t));
      cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t)); cross.setAttribute('visibility', 'visible');
      // 计算该时刻轨迹值
      let info = null;
      for (const r of runs) {
        if (t < r.start || t > r.end) continue;
        const { T, Z, B } = r;
        let j = T.length - 1;
        while (j > 0 && T[j] > t) j--;
        const tt0 = T[j];
        let z = Z[j] + B[j] * (t - tt0);
        // 若恰好落在事件时刻右侧，Z[j] 已含跳变；左侧由 j-1 区间处理（鼠标连续值影响小）
        info = { z, r, j };
        break;
      }
      let html = `<div class="tt-t">t = ${fmtInt(Math.round(t))} µs</div>`;
      if (info) {
        const zc = clampLog(info.z);
        html += `<div>原始 log₂ L = ${info.z.toFixed(4)}</div>`;
        html += `<div>夹紧 log₂ = ${zc.toFixed(4)}</div>`;
        html += `<div>线性亮度 2^L = <b>${Math.pow(2, zc).toPrecision(6)}</b></div>`;
      } else {
        html += `<div style="opacity:.8">该时刻无有效轨迹（缺锚/锚区间外）</div>`;
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const cr = $('chart-container').getBoundingClientRect();
      let left = ev.clientX - cr.left + 14;
      if (left + 190 > cr.width) left = ev.clientX - cr.left - 190;
      tip.style.left = `${left}px`;
      tip.style.top = `${ev.clientY - cr.top + 10}px`;
    });
    hover.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  function bandRect(t0, t1, fill, X, Y, M, ph) {
    if (!(t1 > t0)) return '';
    const x0 = X(t0), x1 = X(t1);
    return `<rect x="${x0}" y="${M.t}" width="${Math.max(1, x1 - x0)}" height="${ph}" fill="${fill}"/>`;
  }

  // ---------------- 导出 ----------------
  function updateExportButtons() {
    const has = !!(state.result && !state.busy);
    $('btn-export-current').disabled = !has;
    $('btn-export-zip').disabled = !has || state.windows.length === 0;
    document.querySelectorAll('[data-role=row-export]').forEach((b) => { b.disabled = !has; });
  }

  function lum1For(i) {
    const planar = $('export-planar').checked;
    return planar ? C.encodeLUM1Planar(state.result, i) : C.encodeLUM1(state.result, i);
  }
  function bytesToBase64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function exportWindow(i) {
    if (!state.result) return;
    const buf = lum1For(i);
    const w = state.windows[i];
    downloadBytes(buf, `lum1_w${String(i + 1).padStart(2, '0')}_${w[0]}_${w[1]}.lum1`);
  }
  $('btn-export-current').addEventListener('click', () => exportWindow(state.activeWindow));
  $('btn-export-zip').addEventListener('click', () => {
    if (!state.result) return;
    const files = state.windows.map((w, i) => ({
      name: `lum1_w${String(i + 1).padStart(2, '0')}_${w[0]}_${w[1]}.lum1`,
      bytes: new Uint8Array(lum1For(i)),
    }));
    const zip = C.zipStore(files);
    downloadBytes(zip, `lum1_${state.windows.length}windows_EVReel.zip`);
  });

  // ---------------- 顶部按钮 / 拖放 / input ----------------
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      const buf = await f.arrayBuffer();
      await loadBuffer(buf, f.name);
    }
    e.target.value = '';
  });
  $('btn-sample').addEventListener('click', loadSample);

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragDepth++;
    $('drop-hint').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-hint').hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('drop-hint').hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { const buf = await f.arrayBuffer(); await loadBuffer(buf, f.name); }
  });

  // ---------------- 总渲染 ----------------
  function renderAll() {
    const d = state.data;
    $('meta-name').textContent = state.fileName || '—';
    $('meta-name').title = state.fileName;
    $('meta-dims').textContent = d ? `${d.width} × ${d.height}` : '—';
    $('meta-anchors').textContent = d ? String(d.anchorCount) : '—';
    $('meta-events').textContent = d ? fmtInt(d.eventCount) : '—';
    $('meta-size').textContent = state.fileSize ? `${(state.fileSize / 1024).toFixed(1)} KiB` : '—';
    const badge = $('data-badge');
    if (d) { badge.textContent = `EVL1 · ${d.width}×${d.height} · ${fmtInt(d.eventCount)} 事件`; badge.className = 'badge badge-ready'; }
    updatePerfLine();
    $('pixel-x').value = state.selected % (d ? d.width : 1);
    $('pixel-y').value = Math.floor(state.selected / (d ? d.width : 1));
    $('pixel-x').max = d ? d.width - 1 : 0;
    $('pixel-y').max = d ? d.height - 1 : 0;
    $('pixel-index-label').textContent = d ? `#${state.selected} / ${d.pixels}` : '';
    renderWindowList();
    renderPreview();
    renderAnchorList();
    renderChart();
    renderPixelTable();
    updateExportButtons();
    $('version-label').textContent = `v${state.version}`;
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (state.data) renderChart(); });
  });

  // ---------------- 自动化 / 编程接口 ----------------
  window.EVReel = {
    core: C,
    loadBuffer,
    loadSample,
    whenIdle,
    async openFile(path) { // 便于测试以 URL 取文件
      const r = await fetch(path);
      if (!r.ok) throw new Error(`fetch ${path} -> ${r.status}`);
      return loadBuffer(await r.arrayBuffer(), path.split('/').pop());
    },
    setWindows,
    getWindows: () => state.windows.map((w) => [w[0], w[1]]),
    setActiveWindow(i) { state.activeWindow = i | 0; renderWindowList(); renderPreview(); renderChart(); renderPixelTable(); },
    setLayer(l) {
      state.layer = l;
      document.querySelectorAll('.seg-btn[data-layer]').forEach((b) => b.classList.toggle('is-active', b.dataset.layer === l));
      $('cov-legend').hidden = l !== 'cov';
      renderPreview();
    },
    selectPixel,
    getSelectedPixel() {
      if (!state.data) return null;
      return { index: state.selected, x: state.selected % state.data.width, y: Math.floor(state.selected / state.data.width) };
    },
    getAnchorCode(a) { return state.data ? state.data.codes[state.selected * state.data.anchorCount + a] : null; },
    setAnchorCode(a, code) {
      if (!state.data) throw new Error('no data');
      let v;
      if (code === null || code === undefined || code === 'missing') v = MISSING;
      else {
        v = Number(code);
        if (!Number.isInteger(v) || !(v === MISSING || (v >= C.LIMITS.codeMin && v <= C.LIMITS.codeMax))) {
          throw new Error(`非法码值 ${code}`);
        }
      }
      return applyAnchorChange(state.selected, a | 0, v);
    },
    setAnchorCodeAt(p, a, code) {
      selectPixel(p);
      let v = code === null ? MISSING : Number(code);
      return applyAnchorChange(p | 0, a | 0, v);
    },
    undo, redo,
    canUndo: () => state.undoStack.length > 0,
    canRedo: () => state.redoStack.length > 0,
    undoDepth: () => state.undoStack.length,
    getData: () => state.data,
    getResult: () => state.result,
    getPixelValues(p) {
      if (!state.result) return null;
      p = p ?? state.selected;
      const P = state.data.pixels;
      return state.windows.map((w, i) => ({
        window: [w[0], w[1]],
        luminance: state.result.lum[i * P + p],
        coverage: state.result.cov[i * P + p],
        validUs: state.result.cov[i * P + p] > 0 ? Math.round(state.result.cov[i * P + p] * (w[1] - w[0])) : 0,
      }));
    },
    buildLUM1(i) { return lum1For(i ?? state.activeWindow); },
    buildLUM1Bytes(i) { return new Uint8Array(lum1For(i ?? state.activeWindow)); },
    buildLUM1Base64(i) { return bytesToBase64(lum1For(i ?? state.activeWindow)); },
    buildAllZip() {
      const files = state.windows.map((w, i) => ({ name: `w${i + 1}.lum1`, bytes: new Uint8Array(lum1For(i)) }));
      return C.zipStore(files);
    },
    buildAllZipBase64() { return bytesToBase64(this.buildAllZip()); },
    exportWindow,
    getLastError: () => state.lastError,
    getState: () => ({
      hasData: !!state.data,
      busy: state.busy,
      version: state.version,
      windows: state.windows.map((w) => [w[0], w[1]]),
      activeWindow: state.activeWindow,
      layer: state.layer,
      selected: state.selected,
      lastError: state.lastError,
      timings: state.timings,
      width: state.data && state.data.width,
      height: state.data && state.data.height,
      anchorCount: state.data && state.data.anchorCount,
      eventCount: state.data && state.data.eventCount,
    }),
  };

  // ---------------- 启动 ----------------
  renderWindowList();
  renderAnchorList();
  updateExportButtons();
  // http 下自动载入随包样例，让首屏即有完整状态；file:// 失败则安静等待用户选文件
  if (location.protocol.startsWith('http')) {
    loadSample().catch(() => {});
  }
})();
