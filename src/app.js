/*
 * PQ 曝光校片台 — 界面与导入管线
 */
(function () {
  'use strict';

  const core = window.PQCore;
  const zip = window.PQZip;

  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const nf = new Intl.NumberFormat('zh-CN');

  const CHUNK_FRAMES = 120;      // 统计分块，保证界面可刷新

  /* ================= 状态 ================= */

  const state = {
    pixels: null,        // Uint16Array，整段帧数据
    dims: { w: 0, h: 0 },
    meta: null,          // 已生效（上次有效）的时间线
    stats: null,         // {p95, suggested}
    solution: null,      // {exposure, objective}
    frame: 0,
    source: '',
    conflict: null,
    workspace: core.makeWorkspace(),
    importMs: 0,
  };

  const el = {};
  let ctxS = null, ctxA = null;
  let chartGeom = null;
  let tableRows = [];

  /* ================= 工具 ================= */

  function fmtInt(n) { return n == null ? '—' : nf.format(n); }

  function fmtTime(us) {
    if (us == null) return '—';
    const s = us / 1e6;
    const mm = Math.floor(s / 60);
    const ss = s - mm * 60;
    return mm > 0
      ? mm + ':' + ss.toFixed(3).padStart(6, '0')
      : ss.toFixed(3) + ' s';
  }

  function fmtGrid(e) {
    if (e == null) return '—';
    return (e >= 0 ? '+' : '−') + Math.abs(e);
  }

  function cloneMeta(m) {
    return {
      width: m.width, height: m.height,
      pts_us: m.pts_us.slice(),
      end_us: m.end_us,
      cuts: m.cuts.slice(),
      weights: m.weights.slice(),
      locks: m.locks.map((x) => [x[0], x[1]]),
    };
  }

  function setBusy(on) {
    document.body.classList.toggle('is-busy', on);
    el.banner.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function status(text, kind) {
    el.status.textContent = text;
    el.status.dataset.kind = kind || '';
  }

  /* ================= 横幅 ================= */

  function clearBanner() {
    el.banner.hidden = true;
    el.bannerTitle.textContent = '';
    el.bannerText.textContent = '';
    el.bannerList.innerHTML = '';
    el.bannerList.hidden = true;
    el.bannerActions.innerHTML = '';
  }

  function banner(kind, title, detail, actions) {
    el.banner.hidden = false;
    el.banner.dataset.kind = kind;
    el.bannerTitle.textContent = title;
    el.bannerText.textContent = '';
    el.bannerList.innerHTML = '';
    el.bannerList.hidden = true;
    if (Array.isArray(detail) && detail.length) {
      for (const d of detail) {
        const li = document.createElement('li');
        li.textContent = d;
        el.bannerList.appendChild(li);
      }
      el.bannerList.hidden = false;
    } else if (detail) {
      el.bannerText.textContent = ' ' + detail;
    }
    el.bannerActions.innerHTML = '';
    if (actions) {
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn sm' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', a.onClick);
        el.bannerActions.appendChild(b);
      }
    }
  }

  /* ================= 导入 ================= */

  function normName(p) {
    return p.split('/').pop().toLowerCase();
  }

  function findEntry(entries, base) {
    return entries.find((e) => normName(e.name) === base) || null;
  }

  async function importZipBuffer(buffer, sourceName) {
    const t0 = performance.now();
    status('解析 ZIP…', '');
    const entries = await zip.readZip(buffer);
    if (!entries.length) throw new Error('ZIP 内没有文件');

    const tlEntry = findEntry(entries, 'timeline.json');
    const frEntry = findEntry(entries, 'frames.rgb10');
    if (!tlEntry) throw new Error('ZIP 内缺少 timeline.json');
    if (!frEntry) throw new Error('ZIP 内缺少 frames.rgb10');

    status('读取时间线…', '');
    const tlText = new TextDecoder('utf-8').decode(await tlEntry.bytes());
    let tl;
    try { tl = JSON.parse(tlText); }
    catch (e) { throw new Error('timeline.json 不是合法 JSON：' + e.message); }

    const v = core.validateTimeline(tl);
    if (!v.ok) {
      const err = new Error('时间线校验失败');
      err.details = v.errors;
      throw err;
    }
    const meta = v.meta;
    const count = meta.pts_us.length;
    const npix = meta.width * meta.height;
    const expected = npix * 3 * count * 2;
    if (frEntry.size !== expected) {
      throw new Error('frames.rgb10 大小不符：期望 ' + expected + ' 字节，实际 ' + frEntry.size + ' 字节');
    }

    status('解压帧数据…', '');
    const raw = await frEntry.bytes();
    if (raw.byteLength !== expected) {
      throw new Error('frames.rgb10 解压后大小不符：期望 ' + expected + '，实际 ' + raw.byteLength);
    }

    status('校验像素…', '');
    const pixels = toU16(raw);
    // 校验高 6 位（提前整段检查，坏帧即拒绝）
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] > 1023) {
        const p = Math.floor(i / 3);
        const f = Math.floor(p / npix);
        throw new Error('第 ' + f + ' 帧存在超出 1023 的码值（' + pixels[i] + '）');
      }
    }

    status('统计 P95…', '');
    const stats = await computeStatsChunked(pixels, meta.width, meta.height, count);

    status('求解曝光…', '');
    const res = core.solveAll(meta, stats.suggested, state.workspace);
    if (!res.ok) {
      const err = new Error('该片段的锁定无解');
      err.conflicts = res.conflicts;
      throw err;
    }

    // 提交
    state.pixels = pixels;
    state.dims = { w: meta.width, h: meta.height };
    state.meta = meta;
    state.stats = stats;
    state.solution = res;
    state.frame = 0;
    state.source = sourceName;
    state.conflict = null;
    state.importMs = performance.now() - t0;

    finishImport();
  }

  function toU16(raw) {
    const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    let buf = raw.buffer;
    // 尽量零拷贝：整段缓冲且对齐时直接视图
    if (littleEndian && raw.byteOffset % 2 === 0 &&
        raw.byteOffset === 0 && raw.byteLength === buf.byteLength) {
      return new Uint16Array(buf);
    }
    if (littleEndian && raw.byteOffset % 2 === 0) {
      return new Uint16Array(buf, raw.byteOffset, raw.byteLength / 2).slice();
    }
    const copy = raw.byteOffset === 0 && raw.byteLength === buf.byteLength
      ? new Uint8Array(buf)
      : raw.slice();
    if (littleEndian) return new Uint16Array(copy.buffer);
    // 大端平台：逐值转换
    const dv = new DataView(copy.buffer);
    const out = new Uint16Array(copy.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }

  async function computeStatsChunked(pixels, w, h, count) {
    const p95 = new Int32Array(count);
    const suggested = new Int16Array(count);
    const npix = w * h;
    const stride = npix * 3;
    for (let start = 0; start < count; start += CHUNK_FRAMES) {
      const cnt = Math.min(CHUNK_FRAMES, count - start);
      const sub = pixels.subarray(start * stride, (start + cnt) * stride);
      const r = core.computeStats(sub, w, h, cnt, null, start);
      p95.set(r.p95, start);
      suggested.set(r.suggested, start);
      const pct = Math.round(((start + cnt) / count) * 100);
      status('统计 P95… ' + pct + '%', '');
      if (start + cnt < count) await new Promise((r2) => setTimeout(r2, 0));
    }
    return { p95, suggested };
  }

  function finishImport() {
    const m = state.meta;
    tableModel = null;
    tableRows = [];
    el.scrub.max = String(m.pts_us.length - 1);
    el.frameTotal.textContent = String(m.pts_us.length);
    el.frameInput.max = String(m.pts_us.length - 1);
    el.tableNote.textContent = m.width + '×' + m.height + ' · ' + fmtInt(m.pts_us.length) + ' 帧 · ' +
      fmtInt(m.width * m.height * m.pts_us.length) + ' px';
    el.pngSuggested.disabled = false;
    el.pngActual.disabled = false;
    el.exportJson.disabled = false;

    for (const c of [el.cvSuggested, el.cvActual]) {
      c.width = m.width;
      c.height = m.height;
    }
    layoutCanvases();
    requestAnimationFrame(layoutCanvases);
    ctxS = el.cvSuggested.getContext('2d', { willReadFrequently: false });
    ctxA = el.cvActual.getContext('2d', { willReadFrequently: false });

    clearBanner();
    status('已载入 · ' + state.source, 'ok');
    el.timing.textContent = '导入→出表 ' + (state.importMs / 1000).toFixed(2) + ' s';
    renderAll();
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    const zipFile = files.find((f) => /\.zip$/i.test(f.name));
    try {
      setBusy(true);
      if (zipFile) {
        const buf = await zipFile.arrayBuffer();
        await importZipBuffer(buf, zipFile.name);
      } else {
        const tlFile = files.find((f) => /timeline\.json$/i.test(f.name));
        const frFile = files.find((f) => /frames\.rgb10$/i.test(f.name));
        if (!tlFile || !frFile) throw new Error('请同时选择 timeline.json 与 frames.rgb10，或选择一个 ZIP');
        await importRawFiles(tlFile, frFile);
      }
    } catch (e) {
      onImportError(e);
    } finally {
      setBusy(false);
    }
  }

  async function importRawFiles(tlFile, frFile) {
    const t0 = performance.now();
    status('读取时间线…', '');
    let tl;
    try { tl = JSON.parse(await tlFile.text()); }
    catch (e) { throw new Error('timeline.json 不是合法 JSON：' + e.message); }
    const v = core.validateTimeline(tl);
    if (!v.ok) { const err = new Error('时间线校验失败'); err.details = v.errors; throw err; }
    const meta = v.meta;
    const count = meta.pts_us.length;
    const npix = meta.width * meta.height;
    const expected = npix * 3 * count * 2;
    status('读取帧数据…', '');
    const buf = await frFile.arrayBuffer();
    if (buf.byteLength !== expected) {
      throw new Error('frames.rgb10 大小不符：期望 ' + expected + ' 字节，实际 ' + buf.byteLength + ' 字节');
    }
    const raw = new Uint8Array(buf);
    const pixels = toU16(raw);
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] > 1023) {
        const p = Math.floor(i / 3); const f = Math.floor(p / npix);
        throw new Error('第 ' + f + ' 帧存在超出 1023 的码值（' + pixels[i] + '）');
      }
    }
    status('统计 P95…', '');
    const stats = await computeStatsChunked(pixels, meta.width, meta.height, count);
    status('求解曝光…', '');
    const res = core.solveAll(meta, stats.suggested, state.workspace);
    if (!res.ok) { const err = new Error('该片段的锁定无解'); err.conflicts = res.conflicts; throw err; }

    state.pixels = pixels;
    state.dims = { w: meta.width, h: meta.height };
    state.meta = meta;
    state.stats = stats;
    state.solution = res;
    state.frame = 0;
    state.source = tlFile.name + ' + ' + frFile.name;
    state.conflict = null;
    state.importMs = performance.now() - t0;
    finishImport();
  }

  function onImportError(e) {
    const keep = !!state.meta && !!state.solution;
    if (e && (e.details || e.conflicts)) {
      const list = e.details || e.conflicts.map((c) => c.message);
      banner('error', (keep ? '导入失败，保留上次有效结果 · ' : '导入失败 · ') + e.message, list);
    } else {
      banner('error', keep ? '导入失败，保留上次有效结果' : '导入失败', e && e.message ? e.message : String(e));
    }
    status(keep ? '导入失败，沿用上次有效结果' : '导入失败', 'error');
  }

  /* ================= 编辑 ================= */

  function validateDraft(m) {
    const n = state.meta.pts_us.length;
    if (!Array.isArray(m.cuts) || m.cuts.length === 0 || m.cuts[0] !== 0) return '切点必须包含 0';
    for (let i = 0; i < m.cuts.length; i++) {
      if (!Number.isInteger(m.cuts[i]) || m.cuts[i] < 0 || m.cuts[i] >= n) return '切点越界：' + m.cuts[i];
      if (i > 0 && m.cuts[i] <= m.cuts[i - 1]) return '切点必须严格递增';
    }
    if (m.weights.length !== n) return '权重数量不符';
    for (let i = 0; i < n; i++) {
      if (!Number.isInteger(m.weights[i]) || m.weights[i] < 1 || m.weights[i] > 100) {
        return '帧 ' + i + ' 的权重必须是 1..100 的整数';
      }
    }
    const seen = new Set();
    for (const [f, e] of m.locks) {
      if (!Number.isInteger(f) || f < 0 || f >= n) return '锁定的帧号越界：' + f;
      if (!Number.isInteger(e) || e < core.E_MIN || e > core.E_MAX) return '帧 ' + f + ' 的锁值必须是 -96..96';
      if (seen.has(f)) return '帧 ' + f + ' 重复锁定';
      seen.add(f);
    }
    return null;
  }

  /**
   * 尝试修改：成功则提交；无解则保留上次有效结果并提示冲突。
   * @param {(m:object)=>void} mutate
   * @param {string} description
   */
  function attemptEdit(mutate, description) {
    if (!state.meta || !state.solution) return;
    // 始终从“上次有效结果”起算，被拒绝的修改不会残留
    const draft = cloneMeta(state.meta);
    mutate(draft);
    draft.locks.sort((a, b) => a[0] - b[0]);

    const invalid = validateDraft(draft);
    if (invalid) {
      banner('error', '修改无效', invalid + ' —— 未应用，仍显示上次有效结果。');
      status('修改无效', 'error');
      return;
    }

    const res = core.solveAll(draft, state.stats.suggested, state.workspace);
    if (!res.ok) {
      state.conflict = res.conflicts;
      const msgs = res.conflicts.map((c) => c.message);
      banner('warn', '此修改无解，未应用 —— 画面与曝光表仍为上次有效结果', msgs, [
        { label: '放弃未应用的修改', onClick: discardDraft },
        { label: '跳到冲突帧', primary: true, onClick: () => goto(res.conflicts[0].frame != null ? res.conflicts[0].frame : res.conflicts[0].a) },
      ]);
      status('修改无解：' + msgs[0], 'warn');
      syncEditInputs();
      renderChart();
      return;
    }

    state.meta = draft;
    state.solution = res;
    state.conflict = null;
    clearBanner();
    status('已应用：' + description, 'ok');
    syncEditInputs();
    renderAll();
  }

  function discardDraft() {
    state.conflict = null;
    clearBanner();
    status('已放弃未应用的修改', '');
    syncEditInputs();
    renderChart();
  }

  function currentLock(draftOrMeta, frame) {
    const m = draftOrMeta || state.meta;
    const l = m.locks.find((x) => x[0] === frame);
    return l ? l[1] : null;
  }

  function syncEditInputs() {
    const m = state.meta;
    if (!m) return;
    const f = state.frame;
    el.frameInput.value = String(f);
    el.weightInput.value = String(m.weights[f]);
    const lk = currentLock(m, f);
    el.lockInput.value = String(lk != null ? lk : (state.solution ? state.solution.exposure[f] : state.stats.suggested[f]));
    const isCut = m.cuts.includes(f);
    el.cutHere.textContent = isCut && f !== 0 ? '移除帧 ' + f + ' 切点' : '在帧 ' + f + ' 切分';
    el.cutHere.disabled = f === 0;
    el.lockClear.disabled = lk == null;
  }

  /* ================= 帧导航 ================= */

  function goto(frame) {
    if (!state.meta) return;
    const n = state.meta.pts_us.length;
    const f = Math.max(0, Math.min(n - 1, Math.round(frame)));
    state.frame = f;
    el.scrub.value = String(f);
    syncEditInputs();
    renderPreview();
    renderMeta();
    updateCursor();
    updateWeightCursor();
    markCurrentShot();
    syncTableCurrent();
    el.frameInput.value = String(f);
  }

  function shotOf(frame) {
    const cuts = state.meta.cuts;
    let s = 0;
    for (let i = 0; i < cuts.length; i++) if (cuts[i] <= frame) s = i;
    return s;
  }

  function shotRange(i) {
    const cuts = state.meta.cuts;
    const a = cuts[i];
    const b = i + 1 < cuts.length ? cuts[i + 1] - 1 : state.meta.pts_us.length - 1;
    return [a, b];
  }

  function gotoShotStart(delta) {
    if (!state.meta) return;
    const s = shotOf(state.frame);
    const t = Math.max(0, Math.min(state.meta.cuts.length - 1, s + delta));
    goto(state.meta.cuts[t]);
  }

  /* ================= 渲染：预览 ================= */

  /**
   * 按源画幅在可用宽度内做 contain 适配（极端画幅也不会被拉伸）。
   * 显示尺寸会夹到最小 24px，极端画幅不再压缩到看不清；
   * 此时画布内仍保留完整画面，只是按比例缩小。
   */
  function layoutCanvases() {
    if (!state.dims.w) return;
    const frameEl = el.cvSuggested.parentElement;
    const avail = Math.max(80, (frameEl.clientWidth || 320) - 2);
    const maxH = 300;
    const ar = state.dims.w / state.dims.h;
    let cw = avail;
    let ch = cw / ar;
    if (ch > maxH) { ch = maxH; cw = ch * ar; }
    cw = Math.max(24, cw);
    ch = Math.max(24, ch);
    for (const c of [el.cvSuggested, el.cvActual]) {
      c.style.width = Math.round(cw) + 'px';
      c.style.height = Math.round(ch) + 'px';
    }
  }

  function renderPreview() {
    if (!state.meta || !state.pixels || !state.stats) return;
    const { w, h } = state.dims;
    const npix = w * h;
    const stride = npix * 3;
    const f = state.frame;
    const px = state.pixels.subarray(f * stride, (f + 1) * stride);
    const q = state.stats.suggested[f];
    const e = state.solution.exposure[f];

    const img = new ImageData(w, h);
    const out = img.data;
    core.renderFrameRGBA(px, npix, q, out);
    ctxS.putImageData(img, 0, 0);

    const img2 = new ImageData(w, h);
    core.renderFrameRGBA(px, npix, e, img2.data);
    ctxA.putImageData(img2, 0, 0);

    el.capSugg.textContent = fmtGrid(q) + ' 格';
    el.capAct.textContent = fmtGrid(e) + ' 格';
    el.cvSuggested.setAttribute('aria-label',
      '帧 ' + f + ' 按建议曝光 ' + fmtGrid(q) + ' 格渲染的 SDR 画面（' + w + '×' + h + '）');
    el.cvActual.setAttribute('aria-label',
      '帧 ' + f + ' 按实际曝光 ' + fmtGrid(e) + ' 格渲染的 SDR 画面（' + w + '×' + h + '）');
    const ar = w / h;
    el.capNote.textContent = (ar >= 8 || ar <= 1 / 8) ? '画幅 ' + w + '×' + h + '，按比例缩放显示' : '';
    el.capAct.title = '2^(' + e + '/16) = ' + Math.pow(2, e / 16).toFixed(3) + ' 倍';
  }

  function renderMeta() {
    if (!state.meta) return;
    const m = state.meta;
    const f = state.frame;
    const n = m.pts_us.length;
    const dur = (f + 1 < n ? m.pts_us[f + 1] : m.end_us) - m.pts_us[f];
    const q = state.stats.suggested[f];
    const e = state.solution.exposure[f];
    const d = e - q;

    el.mTime.textContent = fmtTime(m.pts_us[f]);
    el.mPts.textContent = fmtInt(m.pts_us[f]) + ' µs';
    el.mDur.textContent = fmtInt(dur) + ' µs';
    el.mP95.textContent = fmtInt(state.stats.p95[f]) + ' mN';
    el.mSugg.textContent = fmtGrid(q);
    el.mAct.textContent = fmtGrid(e);
    el.mDelta.textContent = (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d);
    el.mDelta.className = d > 0 ? 'pos' : d < 0 ? 'neg' : '';
    const s = shotOf(f);
    const [a, b] = shotRange(s);
    el.mShot.textContent = (s + 1) + ' / ' + m.cuts.length + '（' + a + '–' + b + '）';
  }

  /* ================= 渲染：曲线 ================= */

  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function renderChart() {
    if (!state.meta || !state.stats || !state.solution) return;
    const wrap = el.chartWrap;
    const W = Math.max(240, wrap.clientWidth);
    const H = el.curve.clientHeight || 220;
    const svg = el.curve;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = '';

    const n = state.meta.pts_us.length;
    const q = state.stats.suggested;
    const e = state.solution.exposure;
    const padL = 44, padR = 58, padT = 14, padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, q[i], e[i]);
      hi = Math.max(hi, q[i], e[i]);
    }
    for (const [f, v] of state.meta.locks) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = -12; hi = 12; }
    lo = Math.max(core.E_MIN, lo - 4);
    hi = Math.min(core.E_MAX, hi + 4);
    if (hi - lo < 24) { const c = (lo + hi) / 2; lo = c - 12; hi = c + 12; }

    const x = (i) => n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW;
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
    chartGeom = { x, y, padL, padR, padT, padB, plotW, plotH, W, H, n };

    // 网格与刻度
    const span = hi - lo;
    const stepCandidates = [6, 12, 24, 48, 96];
    let step = 12;
    for (const s of stepCandidates) { if (span / s <= 6) { step = s; break; } }
    const g = svgEl('g', { class: 'grid' });
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = y(v);
      g.appendChild(svgEl('line', { x1: padL, x2: padL + plotW, y1: yy, y2: yy, stroke: 'var(--grid)', 'stroke-width': 1 }));
      const t = svgEl('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end', fill: 'var(--text-muted)', 'font-size': 10.5 });
      t.textContent = v > 0 ? '+' + v : String(v);
      g.appendChild(t);
    }
    svg.appendChild(g);

    // 切点
    const cutsG = svgEl('g');
    for (let i = 1; i < state.meta.cuts.length; i++) {
      const cx = x(state.meta.cuts[i]) - (n > 1 ? plotW / (n - 1) / 2 : 0);
      cutsG.appendChild(svgEl('line', {
        x1: cx, x2: cx, y1: padT, y2: padT + plotH,
        stroke: 'var(--series-4)', 'stroke-width': 1.5, 'stroke-dasharray': '3 4', 'stroke-opacity': 0.9,
      }));
    }
    svg.appendChild(cutsG);

    // 曲线
    const clip = svgEl('clipPath', { id: 'plot-clip' });
    clip.appendChild(svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH }));
    svg.appendChild(clip);

    const linesG = svgEl('g', { 'clip-path': 'url(#plot-clip)' });
    const mkPath = (arr) => {
      if (n === 1) return null;
      let d = '';
      for (let i = 0; i < n; i++) d += (i === 0 ? 'M' : 'L') + x(i).toFixed(2) + ' ' + y(arr[i]).toFixed(2);
      return d;
    };
    const ds = mkPath(q);
    const de = mkPath(e);
    if (ds) {
      linesG.appendChild(svgEl('path', { d: ds, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': 0.95 }));
      linesG.appendChild(svgEl('path', { d: de, fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    } else {
      linesG.appendChild(svgEl('circle', { cx: x(0), cy: y(q[0]), r: 4, fill: 'var(--series-1)' }));
      linesG.appendChild(svgEl('circle', { cx: x(0), cy: y(e[0]), r: 4, fill: 'var(--series-2)' }));
    }
    svg.appendChild(linesG);

    // 锁定
    const lockG = svgEl('g');
    for (const [f, v] of state.meta.locks) {
      if (f < 0 || f >= n) continue;
      lockG.appendChild(svgEl('rect', {
        x: x(f) - 4.5, y: y(v) - 4.5, width: 9, height: 9,
        transform: 'rotate(45 ' + x(f) + ' ' + y(v) + ')',
        fill: 'var(--series-7)', stroke: 'var(--surface-1)', 'stroke-width': 2,
      }));
    }
    svg.appendChild(lockG);

    // 待应用修改的冲突位置：图标 + 文字，不靠颜色单独承载
    if (state.conflict && state.conflict.length) {
      const cg = svgEl('g');
      for (const c of state.conflict) {
        const f = c.frame != null ? c.frame : c.a;
        if (f == null || f < 0 || f >= n) continue;
        const xx = x(f);
        cg.appendChild(svgEl('line', {
          x1: xx, x2: xx, y1: padT, y2: padT + plotH,
          stroke: 'var(--critical)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3',
        }));
        const badge = svgEl('g');
        const bw = 40;
        const bx = Math.min(padL + plotW - bw, Math.max(padL, xx - bw / 2));
        const by = padT + plotH - 17;
        badge.appendChild(svgEl('rect', {
          x: bx, y: by, width: bw, height: 15, rx: 3, fill: 'var(--critical)',
        }));
        const t = svgEl('text', {
          x: bx + bw / 2, y: by + 11, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 10,
        });
        t.textContent = '冲突 ' + f;
        badge.appendChild(t);
        cg.appendChild(badge);
      }
      svg.appendChild(cg);
    }

    // 末端直接标注（文字用文本色，旁边小圆点携带系列身份）
    const endG = svgEl('g');
    const last = n - 1;
    const items = [
      { v: q[last], color: 'var(--series-1)', label: fmtGrid(q[last]) },
      { v: e[last], color: 'var(--series-2)', label: fmtGrid(e[last]) },
    ];
    let y1 = y(items[0].v), y2 = y(items[1].v);
    if (Math.abs(y1 - y2) < 13) {
      const mid = (y1 + y2) / 2;
      if (y1 <= y2) { y1 = mid - 6.5; y2 = mid + 6.5; } else { y1 = mid + 6.5; y2 = mid - 6.5; }
    }
    const ys = [y1, y2];
    for (let i = 0; i < 2; i++) {
      const tx = padL + plotW + 12;
      endG.appendChild(svgEl('circle', { cx: tx - 4, cy: ys[i], r: 3.5, fill: items[i].color }));
      const t = svgEl('text', { x: tx + 4, y: ys[i] + 4, fill: 'var(--text-secondary)', 'font-size': 11 });
      t.textContent = items[i].label;
      endG.appendChild(t);
    }
    svg.appendChild(endG);

    // 光标层
    const cursor = svgEl('g', { id: 'cursor-g' });
    cursor.appendChild(svgEl('line', { id: 'cursor-line', y1: padT, y2: padT + plotH, stroke: 'var(--axis)', 'stroke-width': 1 }));
    cursor.appendChild(svgEl('circle', { id: 'cursor-s', r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    cursor.appendChild(svgEl('circle', { id: 'cursor-a', r: 4, fill: 'var(--series-2)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    svg.appendChild(cursor);

    // hover 层
    const hover = svgEl('g', { id: 'hover-g', visibility: 'hidden' });
    hover.appendChild(svgEl('line', { id: 'hover-line', y1: padT, y2: padT + plotH, stroke: 'var(--text-muted)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
    svg.appendChild(hover);

    updateCursor();
    renderWeights();
    renderShots();
  }

  function updateCursor() {
    const svg = el.curve;
    const g = svg.querySelector('#cursor-g');
    if (!g || !chartGeom || !state.solution) return;
    const { x, y, padT, plotH } = chartGeom;
    const f = state.frame;
    const line = g.querySelector('#cursor-line');
    line.setAttribute('x1', x(f));
    line.setAttribute('x2', x(f));
    line.setAttribute('y1', padT);
    line.setAttribute('y2', padT + plotH);
    const q = state.stats.suggested[f];
    const e = state.solution.exposure[f];
    const cs = g.querySelector('#cursor-s');
    const ca = g.querySelector('#cursor-a');
    cs.setAttribute('cx', x(f)); cs.setAttribute('cy', y(q));
    ca.setAttribute('cx', x(f)); ca.setAttribute('cy', y(e));
  }

  function renderWeights() {
    const svg = el.weights;
    if (!chartGeom) return;
    const W = chartGeom.W;
    const H = 26;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = '';
    const n = state.meta.pts_us.length;
    const { padL, plotW } = chartGeom;
    const cols = Math.max(1, Math.floor(plotW));
    const seg = document.createElementNS(SVGNS, 'path');
    let d = '';
    const buckets = new Uint16Array(cols);
    for (let i = 0; i < n; i++) {
      const c = n <= 1 ? 0 : Math.min(cols - 1, Math.round((i / (n - 1)) * (cols - 1)));
      if (state.meta.weights[i] > buckets[c]) buckets[c] = state.meta.weights[i];
    }
    for (let c = 0; c < cols; c++) {
      const hgt = Math.max(0.6, (buckets[c] / 100) * (H - 2));
      d += 'M' + (padL + c) + ' ' + H + 'h1V' + (H - hgt).toFixed(1) + 'h-1Z';
    }
    seg.setAttribute('d', d);
    seg.setAttribute('fill', 'var(--text-muted)');
    seg.setAttribute('fill-opacity', '0.5');
    svg.appendChild(seg);
    // 最大权重刻度
    let wmax = 0;
    for (let i = 0; i < n; i++) wmax = Math.max(wmax, state.meta.weights[i]);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', W - 1);
    t.setAttribute('y', 9);
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('fill', 'var(--text-muted)');
    t.setAttribute('font-size', '9.5');
    t.textContent = 'max ' + wmax;
    svg.appendChild(t);
    // 当前帧标线（单独更新，避免逐帧跳转时重建整条权重条）
    const r = document.createElementNS(SVGNS, 'line');
    r.setAttribute('id', 'w-cursor');
    r.setAttribute('y1', 0); r.setAttribute('y2', H);
    r.setAttribute('stroke', 'var(--accent)');
    r.setAttribute('stroke-width', 1);
    svg.appendChild(r);
    updateWeightCursor();
  }

  function updateWeightCursor() {
    const r = el.weights.querySelector('#w-cursor');
    if (!r || !chartGeom) return;
    const cx = chartGeom.x(state.frame);
    r.setAttribute('x1', cx);
    r.setAttribute('x2', cx);
  }

  function renderShots() {
    const box = el.shots;
    box.innerHTML = '';
    if (!state.meta) return;
    const cuts = state.meta.cuts;
    for (let i = 0; i < cuts.length; i++) {
      const [a, b] = shotRange(i);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shot-pill';
      btn.dataset.shot = String(i);
      btn.innerHTML = '<span class="pill-n">' + (i + 1) + '</span> 帧 ' + a + '–' + b;
      btn.addEventListener('click', () => goto(a));
      box.appendChild(btn);
    }
    markCurrentShot();
  }

  function markCurrentShot() {
    if (!state.meta) return;
    const s = shotOf(state.frame);
    for (const b of el.shots.querySelectorAll('.shot-pill')) {
      b.setAttribute('aria-current', Number(b.dataset.shot) === s ? 'true' : 'false');
    }
  }

  /* ---- 曲线交互 ---- */

  function chartIndexFromEvent(ev) {
    if (!chartGeom) return 0;
    const svg = el.curve;
    const rect = svg.getBoundingClientRect();
    const scale = chartGeom.W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const { padL, plotW, n } = chartGeom;
    if (n <= 1) return 0;
    const t = (px - padL) / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  }

  let dragging = false;

  function wireChart() {
    const svg = el.curve;
    svg.addEventListener('pointerdown', (ev) => {
      if (!state.meta) return;
      dragging = true;
      svg.setPointerCapture(ev.pointerId);
      goto(chartIndexFromEvent(ev));
      updateHover(ev);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!state.meta) return;
      if (dragging) goto(chartIndexFromEvent(ev));
      updateHover(ev);
    });
    svg.addEventListener('pointerup', (ev) => {
      dragging = false;
      try { svg.releasePointerCapture(ev.pointerId); } catch (_) { /* noop */ }
    });
    svg.addEventListener('pointerleave', () => {
      hideHover();
    });
  }

  function updateHover(ev) {
    if (!chartGeom || !state.meta || !state.solution) return;
    const i = chartIndexFromEvent(ev);
    const g = el.curve.querySelector('#hover-g');
    if (!g) return;
    g.setAttribute('visibility', 'visible');
    const line = g.querySelector('#hover-line');
    line.setAttribute('x1', chartGeom.x(i));
    line.setAttribute('x2', chartGeom.x(i));

    const n = state.meta.pts_us.length;
    const dur = (i + 1 < n ? state.meta.pts_us[i + 1] : state.meta.end_us) - state.meta.pts_us[i];
    const q = state.stats.suggested[i];
    const e = state.solution.exposure[i];
    el.tooltip.hidden = false;
    el.tooltip.innerHTML =
      '<div class="tt-head">帧 ' + i + ' · ' + fmtTime(state.meta.pts_us[i]) + '</div>' +
      '<div class="tt-row"><span>建议</span><b>' + fmtGrid(q) + '</b></div>' +
      '<div class="tt-row"><span>实际</span><b>' + fmtGrid(e) + '</b></div>' +
      '<div class="tt-row"><span>P95</span><b>' + fmtInt(state.stats.p95[i]) + '</b></div>' +
      '<div class="tt-row"><span>持续</span><b>' + fmtInt(dur) + ' µs</b></div>';

    const rect = el.curve.getBoundingClientRect();
    const sx = rect.width / chartGeom.W;
    const sy = rect.height / chartGeom.H;
    const left = chartGeom.x(i) * sx;
    const topY = chartGeom.y(Math.max(q, e)) * sy;
    el.tooltip.style.left = Math.max(78, Math.min(rect.width - 78, left)) + 'px';
    el.tooltip.style.top = Math.max(4, topY) + 'px';
  }

  function hideHover() {
    el.tooltip.hidden = true;
    const g = el.curve.querySelector('#hover-g');
    if (g) g.setAttribute('visibility', 'hidden');
  }

  /* ================= 渲染：表格 ================= */

  let tableModel = null; // {n, exp:Int16Array, w:Int32Array, lock:Int16Array(-32768 无), cut:Uint8Array}
  let currentRow = -1;

  function buildTableRows() {
    const m = state.meta;
    const n = m.pts_us.length;
    const st = state.stats;
    const ex = state.solution.exposure;
    const lockOf = new Int16Array(n).fill(-32768);
    for (const [f, e] of m.locks) lockOf[f] = e;
    const cutOf = new Uint8Array(n);
    for (const c of m.cuts) cutOf[c] = 1;

    const frag = document.createDocumentFragment();
    tableRows = new Array(n);
    for (let i = 0; i < n; i++) {
      const tr = document.createElement('tr');
      tr.dataset.frame = String(i);
      const dur = (i + 1 < n ? m.pts_us[i + 1] : m.end_us) - m.pts_us[i];
      const cells = [String(i), fmtInt(m.pts_us[i]), fmtInt(dur), fmtInt(st.p95[i]),
        fmtGrid(st.suggested[i]), '', '', '', ''];
      for (let c = 0; c < cells.length; c++) {
        const td = document.createElement('td');
        td.className = 'num';
        if (c === 3) td.title = st.p95[i] + ' 毫尼特';
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      tr.addEventListener('click', () => goto(i));
      tableRows[i] = tr;
      frag.appendChild(tr);
    }
    el.tableBody.innerHTML = '';
    el.tableBody.appendChild(frag);
    tableModel = {
      n,
      exp: new Int16Array(n).fill(-32767),
      w: new Int32Array(n).fill(-1),
      lock: new Int16Array(n).fill(-32767),
      cut: new Uint8Array(n).fill(255),
    };
    currentRow = -1;
    updateTableRows();
  }

  /** 只改动发生变化的单元格（整片 1800 帧时保持编辑响应） */
  function updateTableRows() {
    if (!tableModel || !state.meta || !state.solution) return;
    const m = state.meta;
    const st = state.stats;
    const ex = state.solution.exposure;
    const n = tableModel.n;
    const tm = tableModel;
    const lockNow = new Int16Array(n).fill(-32768);
    for (const [f, e] of m.locks) lockNow[f] = e;
    const cutNow = new Uint8Array(n);
    for (const c of m.cuts) cutNow[c] = 1;

    for (let i = 0; i < n; i++) {
      const tr = tableRows[i];
      if (!tr) continue;
      if (tm.cut[i] !== cutNow[i]) {
        tr.classList.toggle('is-cut', cutNow[i] === 1);
        tm.cut[i] = cutNow[i];
      }
      if (tm.lock[i] !== lockNow[i]) {
        const locked = lockNow[i] !== -32768;
        tr.classList.toggle('is-lock', locked);
        tr.children[8].textContent = locked ? fmtGrid(lockNow[i]) : '·';
        tm.lock[i] = lockNow[i];
      }
      if (tm.w[i] !== m.weights[i]) {
        tr.children[7].textContent = String(m.weights[i]);
        tm.w[i] = m.weights[i];
      }
      if (tm.exp[i] !== ex[i]) {
        const d = ex[i] - st.suggested[i];
        tr.children[5].textContent = fmtGrid(ex[i]);
        const td = tr.children[6];
        td.textContent = (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d);
        td.className = 'num ' + (d > 0 ? 'pos' : d < 0 ? 'neg' : '');
        tm.exp[i] = ex[i];
      }
    }
  }

  function renderTable() {
    if (!state.meta || !state.solution) return;
    if (!tableModel || tableModel.n !== state.meta.pts_us.length) buildTableRows();
    else updateTableRows();
    syncTableCurrent();
  }

  function syncTableCurrent() {
    if (!tableRows.length) return;
    const f = state.frame;
    if (currentRow === f) return;
    if (currentRow >= 0 && tableRows[currentRow]) tableRows[currentRow].removeAttribute('aria-current');
    const row = tableRows[f];
    if (row) {
      row.setAttribute('aria-current', 'true');
      const sc = el.tableScroll;
      const rt = row.getBoundingClientRect();
      const st = sc.getBoundingClientRect();
      if (rt.top < st.top + 30 || rt.bottom > st.bottom - 4) {
        row.scrollIntoView({ block: 'nearest' });
      }
    }
    currentRow = f;
  }

  /* ================= 总渲染 ================= */

  function renderAll() {
    if (!state.meta) return;
    renderPreview();
    renderMeta();
    renderChart();
    renderTable();
    syncEditInputs();
    markCurrentShot();
    if (state.solution.objective != null) {
      el.objective.textContent = fmtInt(Math.round(state.solution.objective * 1000) / 1000);
    }
    el.timing.textContent = state.importMs ? '导入→出表 ' + (state.importMs / 1000).toFixed(2) + ' s' : '';
    el.tableNote.textContent = state.meta.width + '×' + state.meta.height + ' · ' +
      fmtInt(state.meta.pts_us.length) + ' 帧 · ' +
      fmtInt(state.meta.width * state.meta.height * state.meta.pts_us.length) + ' px' +
      (state.importMs ? ' · 导入→出表 ' + (state.importMs / 1000).toFixed(2) + ' s' : '');
  }

  /* ================= 导出 ================= */

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async function downloadPng(which) {
    if (!state.meta || !state.solution) return;
    const canvas = which === 'suggested' ? el.cvSuggested : el.cvActual;
    const blob = await canvasToBlob(canvas);
    if (!blob) return;
    const e = which === 'suggested' ? state.stats.suggested[state.frame] : state.solution.exposure[state.frame];
    const name = 'pq_f' + String(state.frame).padStart(4, '0') + '_e' + (e >= 0 ? 'p' : 'm') + Math.abs(e) + '_' + which + '.png';
    triggerDownload(blob, name);
    status('已导出 ' + name, 'ok');
  }

  function downloadTable() {
    if (!state.meta || !state.solution) return;
    const table = core.buildTable(state.meta, state.stats, state.solution.exposure);
    const payload = { objective: table.objective, frames: table.frames };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'exposure_table.json');
    status('已导出 exposure_table.json（' + table.frames.length + ' 帧）', 'ok');
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    el.fileZip.addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    el.fileRaw.addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    el.loadSample.addEventListener('click', loadSample);

    el.themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pq-theme', next); } catch (_) { /* noop */ }
      requestAnimationFrame(renderChart);
    });

    el.prev.addEventListener('click', () => goto(state.frame - 1));
    el.next.addEventListener('click', () => goto(state.frame + 1));
    el.prevShot.addEventListener('click', () => gotoShotStart(-1));
    el.nextShot.addEventListener('click', () => gotoShotStart(1));
    el.scrub.addEventListener('input', (e) => goto(Number(e.target.value)));
    el.frameInput.addEventListener('change', (e) => goto(Number(e.target.value)));

    el.weightApply.addEventListener('click', () => {
      const raw = el.weightInput.value.trim();
      const f = state.frame;
      if (raw === '' || !Number.isFinite(Number(raw))) {
        banner('error', '修改无效', '请先填写权重（1..100 的整数）。');
        return;
      }
      const v = Number(raw);
      attemptEdit((m) => { m.weights[f] = v; }, '帧 ' + f + ' 权重 = ' + v);
    });
    el.weightInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.weightApply.click(); });

    el.wrApply.addEventListener('click', () => {
      const fromRaw = el.wrFrom.value.trim();
      const toRaw = el.wrTo.value.trim();
      const valRaw = el.wrVal.value.trim();
      if (fromRaw === '' || toRaw === '' || valRaw === '') {
        banner('error', '修改无效', '批量权重需要填写起止帧号和权重值。');
        return;
      }
      const from = Number(fromRaw);
      const to = Number(toRaw);
      const val = Number(valRaw);
      if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(val)) {
        banner('error', '修改无效', '批量权重的起止帧号与权重值都必须是整数。');
        return;
      }
      const a = Math.min(from, to), b = Math.max(from, to);
      attemptEdit((m) => { for (let i = a; i <= b; i++) m.weights[i] = val; },
        '帧 ' + a + '–' + b + ' 权重 = ' + val);
    });

    el.lockApply.addEventListener('click', applyLock);
    el.lockInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyLock(); });
    function applyLock() {
      const raw = el.lockInput.value.trim();
      const f = state.frame;
      if (raw === '' || !Number.isFinite(Number(raw))) {
        banner('error', '修改无效', '请先填写锁定曝光格（-96..96 的整数）。');
        return;
      }
      const v = Number(raw);
      attemptEdit((m) => {
        const idx = m.locks.findIndex((x) => x[0] === f);
        if (idx >= 0) m.locks[idx][1] = v; else m.locks.push([f, v]);
      }, '帧 ' + f + ' 锁定 ' + fmtGrid(v));
    }
    el.lockClear.addEventListener('click', () => {
      const f = state.frame;
      attemptEdit((m) => { m.locks = m.locks.filter((x) => x[0] !== f); }, '解除帧 ' + f + ' 锁定');
    });

    el.cutHere.addEventListener('click', () => {
      const f = state.frame;
      if (f === 0) return;
      const has = state.meta.cuts.includes(f);
      attemptEdit((m) => {
        if (has) m.cuts = m.cuts.filter((x) => x !== f);
        else { m.cuts.push(f); m.cuts.sort((a, b) => a - b); }
      }, has ? '移除帧 ' + f + ' 切点' : '在帧 ' + f + ' 切分');
    });

    el.pngSuggested.addEventListener('click', () => downloadPng('suggested'));
    el.pngActual.addEventListener('click', () => downloadPng('actual'));
    el.exportJson.addEventListener('click', downloadTable);

    document.addEventListener('keydown', onKey);
    wireChart();

    let rt;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (state.meta) { renderChart(); } }, 80);
    });
    ro.observe(el.chartWrap);
    window.addEventListener('resize', () => { layoutCanvases(); });

    // 拖放导入
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        importFiles(e.dataTransfer.files);
      }
    });
  }

  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (!state.meta) return;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); goto(state.frame - step); break;
      case 'ArrowRight': e.preventDefault(); goto(state.frame + step); break;
      case 'Home': e.preventDefault(); goto(0); break;
      case 'End': e.preventDefault(); goto(state.meta.pts_us.length - 1); break;
      case '[': e.preventDefault(); gotoShotStart(-1); break;
      case ']': e.preventDefault(); gotoShotStart(1); break;
      case 'l': case 'L': e.preventDefault(); el.lockApply.click(); break;
      case 'p': case 'P': e.preventDefault(); downloadPng('actual'); break;
      case 's': case 'S': e.preventDefault(); downloadPng('suggested'); break;
      case 'e': case 'E': e.preventDefault(); downloadTable(); break;
      default: break;
    }
  }

  /* ================= 示例 ================= */

  async function loadSample() {
    try {
      setBusy(true);
      const b64 = window.PQ_SAMPLE_B64;
      if (!b64) throw new Error('未找到内置示例数据');
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await importZipBuffer(u8.buffer, 'pq-exposure-cases.zip（示例）');
    } catch (e) {
      onImportError(e);
    } finally {
      setBusy(false);
    }
  }

  /* ================= 初始化 ================= */

  function init() {
    const ids = [
      'banner', 'banner-title', 'banner-text', 'banner-list', 'banner-actions', 'status', 'timing',
      'file-zip', 'file-raw', 'load-sample', 'theme-toggle',
      'cv-suggested', 'cv-actual', 'cap-sugg', 'cap-act', 'cap-note',
      'prev', 'next', 'prev-shot', 'next-shot', 'scrub', 'frame-input', 'frame-total',
      'm-time', 'm-pts', 'm-dur', 'm-p95', 'm-sugg', 'm-act', 'm-delta', 'm-shot',
      'weight-input', 'weight-apply', 'lock-input', 'lock-apply', 'lock-clear',
      'wr-from', 'wr-to', 'wr-val', 'wr-apply', 'cut-here',
      'png-suggested', 'png-actual', 'export-json',
      'chart-wrap', 'curve', 'tooltip', 'weights', 'shots', 'objective',
      'table-scroll', 'table-body', 'table-note', 'exposure-table',
    ];
    const camel = {
      'banner-title': 'bannerTitle', 'banner-text': 'bannerText', 'banner-list': 'bannerList',
      'banner-actions': 'bannerActions',
      'cv-suggested': 'cvSuggested', 'cv-actual': 'cvActual', 'cap-sugg': 'capSugg', 'cap-act': 'capAct', 'cap-note': 'capNote',
      'prev-shot': 'prevShot', 'next-shot': 'nextShot', 'frame-input': 'frameInput', 'frame-total': 'frameTotal',
      'm-time': 'mTime', 'm-pts': 'mPts', 'm-dur': 'mDur', 'm-p95': 'mP95', 'm-sugg': 'mSugg',
      'm-act': 'mAct', 'm-delta': 'mDelta', 'm-shot': 'mShot',
      'weight-input': 'weightInput', 'weight-apply': 'weightApply',
      'lock-input': 'lockInput', 'lock-apply': 'lockApply', 'lock-clear': 'lockClear',
      'wr-from': 'wrFrom', 'wr-to': 'wrTo', 'wr-val': 'wrVal', 'wr-apply': 'wrApply',
      'cut-here': 'cutHere',
      'png-suggested': 'pngSuggested', 'png-actual': 'pngActual', 'export-json': 'exportJson',
      'chart-wrap': 'chartWrap', 'table-scroll': 'tableScroll', 'table-body': 'tableBody',
      'table-note': 'tableNote', 'exposure-table': 'exposureTable',
      'file-zip': 'fileZip', 'file-raw': 'fileRaw', 'load-sample': 'loadSample',
      'theme-toggle': 'themeToggle', 'frame-total': 'frameTotal',
    };
    for (const id of ids) {
      const key = camel[id] || id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el[key] = $(id);
    }

    try {
      const saved = localStorage.getItem('pq-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    } catch (_) { /* 隐私模式等：忽略 */ }

    el.wrFrom.value = '';
    el.wrTo.value = '';
    bind();
    status('就绪 · 导入 ZIP 或载入示例', '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
