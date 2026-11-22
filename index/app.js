/*
 * app.js — 帧调度工作台界面逻辑
 * 依赖：model.js / scheduler.js / engine.js / samples.js（均挂在全局 Tfs）
 */
(function () {
  const Tfs = window.Tfs;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    dataset: null,            // 完整 JSON 文档
    caseIndex: 0,
    built: null,              // buildModel 结果
    schedule: null,           // 优化排程
    simOpt: null,             // 优化顺序模拟
    simDecl: null,            // 声明顺序模拟
    pinned: new Set(),
    step: 0,                  // 0..n（0=未开始，n=帧末）
    viewRef: null,            // 图像查看器当前版本
    playTimer: null,
    theme: null,
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => `${n} B`;

  // ---------------- 初始化 ----------------
  function init() {
    bindEvents();
    initTheme();
    state.dataset = JSON.parse(JSON.stringify(Tfs.EMBEDDED_SAMPLES));
    populateCaseSelect();
    selectCase(0);
  }

  function bindEvents() {
    $('#case-select').addEventListener('change', (e) => selectCase(Number(e.target.value)));
    $('#btn-import').addEventListener('click', openImport);
    $('#btn-export').addEventListener('click', openExport);
    $('#btn-theme').addEventListener('click', toggleTheme);

    $('#btn-first').addEventListener('click', () => setStep(0));
    $('#btn-prev').addEventListener('click', () => setStep(state.step - 1));
    $('#btn-next').addEventListener('click', () => setStep(state.step + 1));
    $('#btn-last').addEventListener('click', () => setStep(state.simOpt.steps.length));
    $('#btn-play').addEventListener('click', togglePlay);
    $('#step-range').addEventListener('input', (e) => setStep(Number(e.target.value)));
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowRight') setStep(state.step + 1);
      if (e.key === 'ArrowLeft') setStep(state.step - 1);
    });
  }

  function populateCaseSelect() {
    const sel = $('#case-select');
    sel.innerHTML = state.dataset.cases
      .map((c, i) => `<option value="${i}">${esc(c.id || `case ${i}`)}</option>`)
      .join('');
  }

  function selectCase(i) {
    stopPlay();
    state.caseIndex = i;
    state.pinned = new Set();
    state.step = 0;
    state.viewRef = null;
    $('#case-select').value = String(i);
    rebuild();
  }

  // ---------------- 核心重建 ----------------
  function rebuild() {
    const caseObj = state.dataset.cases[state.caseIndex];
    const built = Tfs.buildModel(caseObj);
    state.built = built;

    if (!built.ok) {
      renderErrors(built.errors);
      setPanelsEnabled(false);
      renderPassListRaw(caseObj);
      return;
    }
    $('#error-section').hidden = true;
    setPanelsEnabled(true);

    const model = built.model;
    state.schedule = Tfs.schedule(model, [...state.pinned]);
    state.simOpt = Tfs.simulate(model, state.schedule.order, [...state.pinned]);
    state.simDecl = Tfs.simulate(model, model.passes.map((_, i) => i), [...state.pinned]);

    state.step = Math.min(state.step, state.simOpt.steps.length);
    renderAll();
  }

  function setPanelsEnabled(on) {
    $('#btn-export').disabled = !on;
    ['btn-first', 'btn-prev', 'btn-play', 'btn-next', 'btn-last'].forEach((id) => ($(`#${id}`).disabled = !on));
    $('#step-range').disabled = !on;
    if (!on) {
      ['stat-peak-opt', 'stat-peak-decl', 'stat-total', 'stat-slots'].forEach((id) => ($(`#${id}`).textContent = '—'));
      ['stat-peak-opt-sub', 'stat-peak-decl-sub', 'stat-slots-sub'].forEach((id) => ($(`#${id}`).textContent = '—'));
      $('#pass-list').innerHTML = '';
      $('#ver-grid').innerHTML = '<div class="slot-empty">帧描述修复后显示版本与固定控件</div>';
      $('#cmp-table tbody').innerHTML = '<tr><td colspan="4" class="slot-empty">帧描述修复后显示顺序对比</td></tr>';
      $('#slot-list').innerHTML = '<div class="slot-empty">帧描述修复后显示槽位</div>';
      $('#chart-wrap').innerHTML = '<div class="slot-empty">帧描述修复后显示时间线</div>';
      $('#pixel-stage').innerHTML = '';
      $('#ver-picker').innerHTML = '';
      $('#pixel-caption').textContent = '修复错误后可查看像素';
      $('#now-pass').textContent = '无法执行。';
      $('#step-info').textContent = '— / —';
      $('#replay-mode-chip').textContent = '';
      $('#slot-bytes-chip').textContent = '';
      $('#pass-count').textContent = '';
    } else {
      $('#stat-peak-opt-sub').textContent = '最小可能峰值';
    }
  }

  function renderAll() {
    renderStats();
    renderPassList();
    renderVersions();
    renderCompare();
    renderReplay();
    renderSlots();
    renderChart();
    renderPixelPicker();
    renderPixel();
  }

  // ---------------- 错误 ----------------
  function renderErrors(errors) {
    $('#error-section').hidden = false;
    const label = {
      cycle: '依赖环', 'missing-read': '读取缺失', read: '读取错误', out: '写入错误',
      op: '操作语义', image: '图像定义', pass: '通道定义', export: '导出错误', schema: '结构',
    };
    $('#error-list').innerHTML = errors
      .map(
        (e) => `<div class="error-card">
          <span class="kind">${esc(label[e.kind] || e.kind)}</span>
          <div class="msg">${esc(e.message)}</div>
          ${e.refs && e.refs.length ? `<div class="refs">涉及版本：${e.refs.map(esc).join('，')}</div>` : ''}
        </div>`
      )
      .join('');
  }

  function renderPassListRaw(caseObj) {
    const list = $('#pass-list');
    if (!caseObj || !Array.isArray(caseObj.passes)) { list.innerHTML = ''; return; }
    list.innerHTML = caseObj.passes
      .map((p, i) => `<div class="pass-row">
        <div class="ord">${i + 1}</div>
        <div class="pass-main">
          <div class="pass-name">${esc(p.id || `(无 id #${i})`)} <span class="op-badge op-${esc(p.op || '?')}">${esc(p.op || '?')}</span></div>
          <div class="pass-refs">→ ${esc(p.out || '?')}${p.read && p.read.length ? `　← ${p.read.map(esc).join(', ')}` : ''}</div>
        </div>
      </div>`)
      .join('');
  }

  // ---------------- 指标 ----------------
  function renderStats() {
    const { model } = state.built;
    const s = state.schedule, o = state.simOpt, d = state.simDecl;
    $('#stat-peak-opt').textContent = s.peakBytes;
    $('#stat-peak-decl').textContent = d.ok ? d.peakBytes : '非法';
    $('#stat-total').textContent = o.totalBytes;
    $('#stat-slots').textContent = `${o.slots.length} / ${model.versions.length}`;
    const saved = d.ok ? d.peakBytes - s.peakBytes : 0;
    $('#stat-peak-decl-sub').textContent = d.ok
      ? (saved > 0 ? `优化降低 ${saved} 字节（${Math.round((saved / d.peakBytes) * 100)}%）` : '已是最优峰值')
      : '声明顺序不满足依赖';
    const reused = model.versions.length - o.slots.length;
    $('#stat-slots-sub').textContent = reused > 0 ? `复用减少 ${reused} 个槽` : '无寿命可复用';
  }

  // ---------------- 通道列表 ----------------
  function renderPassList() {
    const { model } = state.built;
    const done = new Set(state.schedule.order.slice(0, state.step));
    const activeIdx = state.step > 0 ? state.schedule.order[state.step - 1] : -1;
    $('#pass-count').textContent = `${model.passes.length} 通道`;
    $('#pass-list').innerHTML = model.passes
      .map((p, i) => {
        const v = model.versionMap.get(p.out);
        const reads = (p.read || []).map((r) => esc(r)).join(', ');
        const cls = i === activeIdx ? 'active' : done.has(i) ? 'done' : '';
        const pos = state.schedule.order.indexOf(i) + 1;
        return `<div class="pass-row ${cls}">
          <div class="ord">${pos}</div>
          <div class="pass-main">
            <div class="pass-name">${esc(p.id)} <span class="op-badge op-${esc(p.op)}">${esc(p.op)}</span></div>
            <div class="pass-refs"><b>→</b> ${esc(p.out)}${reads ? `　<b>←</b> ${reads}` : ''}</div>
          </div>
          <div class="pass-bytes">${v.bytes} B</div>
        </div>`;
      })
      .join('');
  }

  // ---------------- 版本卡片 + 固定 ----------------
  function renderVersions() {
    const { model } = state.built;
    const liveRefs = currentLiveRefs();
    $('#ver-grid').innerHTML = model.versions
      .map((v) => {
        const isExport = model.exportRefs.has(v.ref);
        const isPinned = state.pinned.has(v.ref);
        const retained = isExport || isPinned;
        const live = liveRefs.has(v.ref);
        const readers = v.readers.length
          ? v.readers.map((i) => model.passes[i].id).join(', ')
          : '无读者';
        return `<div class="ver-card ${retained ? 'retained' : ''} ${live ? 'live' : ''}">
          <div class="ver-head">
            <span class="ref" title="${esc(v.ref)}">${esc(v.ref)}</span>
            <span class="spacer"></span>
            ${isExport ? '<span class="chip export">导出</span>' : ''}
            ${live ? '<span class="chip live">存活</span>' : ''}
          </div>
          <div class="ver-meta"><span>${v.w}×${v.h} · ${v.format}</span><span>${v.bytes} B</span></div>
          <div class="ver-meta"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(readers)}">读者: ${esc(readers)}</span></div>
          <button class="pin-btn ${isPinned ? 'on' : ''}" data-pin="${esc(v.ref)}">
            ${isPinned ? '📌 已固定（取消）' : '固定到帧末'}
          </button>
        </div>`;
      })
      .join('');
    $('#ver-grid').querySelectorAll('[data-pin]').forEach((btn) =>
      btn.addEventListener('click', () => togglePin(btn.dataset.pin))
    );
  }

  function togglePin(ref) {
    stopPlay();
    if (state.pinned.has(ref)) state.pinned.delete(ref);
    else state.pinned.add(ref);
    state.step = 0;
    rebuild();
  }

  // ---------------- 顺序对比 ----------------
  function renderCompare() {
    const { model } = state.built;
    const tbody = $('#cmp-table tbody');
    const n = model.passes.length;
    let html = '';
    for (let k = 0; k < n; k++) {
      const optId = model.passes[state.schedule.order[k]].id;
      const declPass = model.passes[k];
      const same = optId === declPass.id;
      html += `<tr class="${same ? 'match' : 'diff'}">
        <td class="mono">${k + 1}</td>
        <td class="mono">${esc(optId)}</td>
        <td class="mono">${esc(declPass.id)}</td>
        <td>${same ? '一致' : '<span style="color:var(--amber)">重排</span>'}</td>
      </tr>`;
    }
    tbody.innerHTML = html;
  }

  // ---------------- 回放 ----------------
  function currentStepRecord() {
    return state.step === 0 ? null : state.simOpt.steps[state.step - 1];
  }
  function currentLiveRefs() {
    if (!state.simOpt) return new Set();
    if (state.step === 0) return new Set();
    return new Set(state.simOpt.steps[state.step - 1].liveRefs);
  }

  function setStep(k) {
    if (!state.simOpt) return;
    const n = state.simOpt.steps.length;
    state.step = Math.max(0, Math.min(n, k));
    renderReplay();
    renderPassList();
    renderVersions();
    renderSlots();
    renderPixel();
  }

  function renderReplay() {
    const n = state.simOpt.steps.length;
    $('#step-range').max = n;
    $('#step-range').value = state.step;
    $('#step-info').textContent = `${state.step} / ${n}`;
    const rec = currentStepRecord();
    $('#replay-mode-chip').textContent = `峰值 ${state.schedule.peakBytes} B`;
    if (!rec) {
      $('#now-pass').innerHTML = '尚未执行任何通道。拖动滑块或按 ▶ 单步执行。';
      return;
    }
    const pass = state.built.model.passes[rec.passIndex];
    const reads = rec.readSlots.map((r) => `${esc(r.ref)}@${esc(r.slotId)}`).join('，') || '无';
    const rel = rec.released.length
      ? rec.released.map((r) => `${esc(r.ref)}（槽 ${esc(r.slotId)} 回收）`).join('，')
      : '无版本释放';
    $('#now-pass').innerHTML = `
      <b>第 ${rec.index} 步</b> · 通道 <span class="mono">${esc(rec.passId)}</span>
      <span class="op-badge op-${esc(rec.op)}">${esc(rec.op)}</span><br>
      输出 <span class="mono">${esc(rec.outRef)}</span> 分配到槽 <span class="mono">${esc(rec.outSlot)}</span>；
      读取：${reads}<br>
      期间存活 <span class="mono">${rec.duringBytes} B</span>，结束后 <span class="mono">${rec.afterBytes} B</span>；
      释放：${rel}`;
  }

  function togglePlay() {
    if (state.playTimer) { stopPlay(); return; }
    if (state.step >= state.simOpt.steps.length) state.step = 0;
    $('#btn-play').textContent = '⏸';
    state.playTimer = setInterval(() => {
      if (state.step >= state.simOpt.steps.length) { stopPlay(); return; }
      setStep(state.step + 1);
    }, 900);
  }
  function stopPlay() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    const btn = $('#btn-play');
    if (btn) btn.textContent = '▶';
  }

  // ---------------- 槽位视图 ----------------
  function renderSlots() {
    const sim = state.simOpt;
    const n = sim.steps.length;
    const rec = currentStepRecord();
    $('#slot-bytes-chip').textContent = rec ? `当前 ${rec.afterBytes} B` : '当前 0 B';

    const rows = [...sim.slotIntervals.entries()].map(([slotId, intervals]) => {
      const slot = sim.slots.find((s) => s.id === slotId);
      const segs = intervals
        .map((iv) => {
          const left = ((iv.from - 1) / n) * 100;
          const to = iv.to === null ? n + 1 : iv.to;
          const width = ((to - iv.from + 1) / n) * 100;
          const retained = state.built.model.exportRefs.has(iv.ref) || state.pinned.has(iv.ref);
          const dead = iv.to !== null && iv.to <= state.step;
          return `<div class="slot-seg ${retained ? 'retained' : ''} ${dead ? 'dead' : ''}"
            style="left:${left.toFixed(2)}%;width:${Math.min(100 - left, width).toFixed(2)}%"
            title="${esc(iv.ref)}：第 ${iv.from} 步分配${iv.to === null ? '，保留至帧末' : `，第 ${iv.to} 步释放`}">${esc(iv.ref)}</div>`;
        })
        .join('');
      const cursor = state.step === 0 ? 0 : (state.step / n) * 100;
      return `<div class="slot-row">
        <span class="slot-id">${esc(slotId)}</span>
        <div class="slot-track">${segs}<div class="slot-cursor" style="left:${cursor}%"></div></div>
        <span class="slot-class">${esc(slot.classKey)}</span>
      </div>`;
    });
    $('#slot-list').innerHTML = rows.join('') || '<div class="slot-empty">暂无槽位</div>';
  }

  // ---------------- 时间线图表（内联 SVG） ----------------
  function renderChart() {
    const opt = state.simOpt, decl = state.simDecl;
    const W = 620, H = 240, padL = 44, padR = 14, padT = 14, padB = 34;
    const n = opt.steps.length;
    const allPeaks = opt.steps.map((s) => s.duringBytes).concat(
      decl.ok ? decl.steps.map((s) => s.duringBytes) : [0]
    );
    const maxV = Math.max(...allPeaks, 1);
    const x = (k) => padL + (n === 1 ? (W - padL - padR) / 2 : (k / (n - 1)) * (W - padL - padR));
    const y = (v) => padT + (1 - v / maxV) * (H - padT - padB);

    const gridVals = niceTicks(maxV);
    let grid = '';
    for (const gv of gridVals) {
      const gy = y(gv);
      grid += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}"></line>
        <text x="${padL - 6}" y="${gy + 3.5}" text-anchor="end">${gv}</text>`;
    }
    let xlabels = '';
    for (let k = 0; k < n; k++) {
      xlabels += `<text x="${x(k)}" y="${H - 12}" text-anchor="middle">${k + 1}</text>`;
    }
    xlabels += `<text x="${padL}" y="${H - 12}" text-anchor="middle" style="opacity:0">·</text>`;

    const series = (sim, color, dim, name) => {
      if (!sim.ok) return '';
      const pts = sim.steps.map((s, k) => [x(k), y(s.duringBytes)]);
      const line = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const dots = pts
        .map((p, k) => `<circle class="tt-dot" data-series="${name}" data-step="${k}" cx="${p[0]}" cy="${p[1]}" r="7" fill="transparent" pointer-events="all"/>
          <circle cx="${p[0]}" cy="${p[1]}" r="3.4" fill="${color}" stroke="var(--panel)" stroke-width="1.5"/>`)
        .join('');
      return `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".9"></path>${dots}`;
    };

    $('#chart-wrap').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="存活字节随执行步骤变化">
      ${grid}
      <line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${H - padB + 8}" y2="${H - padB + 8}"></line>
      ${xlabels}
      <text x="${padL}" y="${H - 0}" text-anchor="start" style="font-size:10px">执行步骤 →</text>
      ${series(decl, 'var(--amber)', true, '声明顺序')}
      ${series(opt, 'var(--cyan)', false, '优化顺序')}
    </svg>`;

    const tip = $('#chart-tooltip');
    $('#chart-wrap').querySelectorAll('.tt-dot').forEach((dot) => {
      dot.addEventListener('mousemove', (e) => {
        const k = Number(dot.dataset.step);
        const isOpt = dot.dataset.series === '优化顺序';
        const sim = isOpt ? opt : decl;
        const st = sim.steps[k];
        tip.style.display = 'block';
        tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 280) + 'px';
        tip.style.top = Math.max(8, e.clientY - 70) + 'px';
        tip.innerHTML = `<div class="tt-title">${dot.dataset.series} · 第 ${k + 1} 步 · ${esc(st.passId)}</div>
          <div class="tt-row"><span>执行期间</span><b>${st.duringBytes} B</b></div>
          <div class="tt-row"><span>结束后</span><b>${st.afterBytes} B</b></div>
          <div class="tt-row"><span>累计峰值</span><b>${st.peakBytes} B</b></div>`;
      });
      dot.addEventListener('mouseleave', () => (tip.style.display = 'none'));
      dot.addEventListener('click', () => { if (dot.dataset.series === '优化顺序') setStep(k + 1); });
    });
  }

  function niceTicks(maxV) {
    const out = [0];
    const step = maxV <= 4 ? 1 : Math.ceil(maxV / 4 / 4) * 4 || 1;
    for (let v = step; v < maxV; v += step) out.push(v);
    out.push(maxV);
    return [...new Set(out)];
  }

  // ---------------- 图像查看器 ----------------
  function renderPixelPicker() {
    const { model } = state.built;
    const producedUpTo = new Set();
    state.schedule.order.slice(0, state.step).forEach((i) => producedUpTo.add(model.passes[i].out));
    $('#ver-picker').innerHTML = model.versions
      .map((v) => {
        const avail = producedUpTo.has(v.ref);
        const on = state.viewRef === v.ref;
        return `<button class="ver-pick ${on ? 'on' : ''}" data-ref="${esc(v.ref)}" ${avail ? '' : 'disabled'}
          title="${avail ? '查看 ' + v.ref : '该版本尚未产出'}">${esc(v.ref)}</button>`;
      })
      .join('');
    $('#ver-picker').querySelectorAll('[data-ref]').forEach((b) =>
      b.addEventListener('click', () => { state.viewRef = b.dataset.ref; renderPixelPicker(); renderPixel(); })
    );
  }

  function renderPixel() {
    if (!state.viewRef) {
      // 默认展示当前步刚产出的版本
      const rec = currentStepRecord();
      if (rec) state.viewRef = rec.outRef;
    }
    const { model } = state.built;
    const v = state.viewRef ? model.versionMap.get(state.viewRef) : null;
    const stage = $('#pixel-stage');
    if (!v) {
      stage.innerHTML = '';
      $('#pixel-caption').textContent = '执行至少一步后可查看像素';
      return;
    }
    const producedUpTo = new Set();
    state.schedule.order.slice(0, state.step).forEach((i) => producedUpTo.add(model.passes[i].out));
    if (!producedUpTo.has(v.ref)) {
      stage.innerHTML = '';
      $('#pixel-caption').textContent = `${v.ref} 尚未在当前步骤之前产出`;
      return;
    }
    const data = state.simOpt.pixels.get(v.ref);
    const ch = v.channels;
    const cellMax = Math.max(14, Math.min(46, Math.floor(380 / v.w)));
    const cells = [];
    for (let py = 0; py < v.h; py++) {
      for (let px = 0; px < v.w; px++) {
        const idx = (py * v.w + px) * ch;
        let style, label, title;
        if (ch === 1) {
          const val = data[idx];
          style = `background:rgb(${val},${val},${val});width:${cellMax}px;height:${cellMax}px`;
          label = val;
          title = `(${px},${py}) = ${val}`;
        } else {
          const [r, g, b, a] = [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
          style = `background:rgba(${r},${g},${b},${(a / 255).toFixed(3)});width:${cellMax}px;height:${cellMax}px`;
          label = `${r},${g},${b},${a}`;
          title = `(${px},${py}) RGBA=${label}`;
        }
        const fontSize = ch === 1 ? 10 : 8.5;
        cells.push(`<div class="px r8" style="${style};font-size:${fontSize}px" title="${esc(title)}">
          <span style="color:${ch === 1 && data[(py * v.w + px) * ch] > 170 ? '#111' : 'rgba(255,255,255,.85)'}">${esc(label)}</span></div>`);
      }
    }
    stage.innerHTML = `<div class="pixel-grid" style="grid-template-columns:repeat(${v.w}, ${cellMax}px)">${cells.join('')}</div>`;
    const slot = findSlotOf(v.ref);
    $('#pixel-caption').innerHTML = `${esc(v.ref)} · ${v.w}×${v.h} · ${v.format} · ${v.bytes} B${slot ? ` · 槽 ${esc(slot)}` : ''}`;
  }

  function findSlotOf(ref) {
    const rec = currentStepRecord();
    if (!rec) return null;
    const hit = rec.slotSnapshot.find((s) => s.ref === ref);
    return hit ? hit.id : null;
  }

  // ---------------- 导入 / 导出 ----------------
  function openImport() {
    showModal(`<header><h2>导入帧描述 JSON</h2><span class="spacer"></span><button class="small ghost" data-close>关闭</button></header>
      <div class="body">
        <p class="section-note">粘贴整个文档（含 cases 数组），或单个 case 对象。也可用系统文件选择器读取 .json 文件。</p>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input type="file" id="import-file" accept=".json,application/json" style="font-size:12px">
        </div>
        <textarea id="import-text" placeholder='{"cases":[{"id":...}]}'></textarea>
        <div id="import-msg" style="margin-top:8px;font-size:12.5px;color:var(--danger)"></div>
      </div>
      <footer><button data-close>取消</button><button class="primary" id="import-confirm">导入并切换</button></footer>`);
    const modal = $('#modal-root .modal-backdrop');
    modal.querySelector('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => (modal.querySelector('#import-text').value = reader.result);
      reader.readAsText(file);
    });
    modal.querySelector('#import-confirm').addEventListener('click', () => {
      let doc;
      try { doc = JSON.parse(modal.querySelector('#import-text').value); }
      catch (err) { modal.querySelector('#import-msg').textContent = `JSON 解析失败：${err.message}`; return; }
      if (doc && !Array.isArray(doc.cases) && doc.passes) doc = { cases: [doc] };
      if (!doc || !Array.isArray(doc.cases) || !doc.cases.length) {
        modal.querySelector('#import-msg').textContent = '文档需要包含非空的 cases 数组';
        return;
      }
      state.dataset = doc;
      populateCaseSelect();
      closeModal();
      selectCase(0);
      toast(`已导入 ${doc.cases.length} 个用例`);
    });
  }

  function openExport() {
    const { model } = state.built;
    const s = state.schedule;
    const sim = state.simOpt;
    const payload = {
      case: model.id,
      generatedAt: new Date().toISOString(),
      objective: 'min-peak-live-bytes, tie-break lexicographic pass-id sequence',
      peakBytes: s.peakBytes,
      declaredOrderPeakBytes: state.simDecl.ok ? state.simDecl.peakBytes : null,
      totalVersionBytes: sim.totalBytes,
      slotCount: sim.slots.length,
      retainedVersions: s.retainedRefs,
      pinnedVersions: [...state.pinned],
      order: s.orderIds,
      steps: sim.steps.map((st) => ({
        step: st.index,
        pass: st.passId,
        op: st.op,
        out: st.outRef,
        slot: st.outSlot,
        reads: st.readSlots,
        released: st.released,
        liveBytesDuring: st.duringBytes,
        liveBytesAfter: st.afterBytes,
        peakBytes: st.peakBytes,
      })),
      slots: sim.slots.map((slot) => ({
        id: slot.id,
        class: slot.classKey,
        timeline: sim.slotIntervals.get(slot.id).map((iv) => ({
          version: iv.ref, from: iv.from, to: iv.to === null ? 'frame-end' : iv.to,
        })),
      })),
    };
    const text = JSON.stringify(payload, null, 2);
    showModal(`<header><h2>导出排程</h2><span class="spacer"></span><button class="small ghost" data-close>关闭</button></header>
      <div class="body">
        <p class="section-note">包含优化顺序、逐步字节、槽位时间线与保留集。可复制或下载。</p>
        <textarea id="export-text" readonly>${esc(text)}</textarea>
      </div>
      <footer>
        <button data-close>完成</button>
        <button id="export-copy" class="primary">复制到剪贴板</button>
        <button id="export-download">下载 .json</button>
      </footer>`);
    const modal = $('#modal-root .modal-backdrop');
    modal.querySelector('#export-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('排程已复制到剪贴板');
      } catch {
        const ta = modal.querySelector('#export-text');
        ta.select();
        document.execCommand('copy');
        toast('已选中文本，可手动复制');
      }
    });
    modal.querySelector('#export-download').addEventListener('click', () => {
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `schedule-${model.id}-${s.peakBytes}B.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  function showModal(inner) {
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal">${inner}</div></div>`;
    $('#modal-root').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    $('#modal-root .modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) closeModal();
    });
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ---------------- 主题 ----------------
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('tfs-theme'); } catch { /* 忽略 */ }
    if (saved) { state.theme = saved; document.documentElement.dataset.theme = saved; }
  }
  function toggleTheme() {
    const dark = state.theme !== 'dark';
    state.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    try { localStorage.setItem('tfs-theme', state.theme); } catch { /* 忽略 */ }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
