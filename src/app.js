/* 页面逻辑：导入、运行、单步、暂停续跑、点查、导出。
 *
 * 并发模型：求解跑在 Blob Worker 里；每次载入 / 改 z / 改 eta 都递增 epoch。
 * 主线程只接受与当前 epoch 相同的消息，旧任务回来的一律丢弃 —— 旧任务永远不会覆盖当前结果。
 */
(function () {
  'use strict';

  const S = {
    epoch: 0,          // 当前会话代际
    worker: null,
    busy: false,       // 有运行中任务
    playing: false,    // 处于“续跑”模式
    project: null,     // 已通过校验的原始项目对象（含 spec）
    engineMeta: null,  // { W, H, planeCount, waveCount }
    round: 0,
    loss: 0,
    planeLoss: [],
    stepSize: null,
    history: [],
    p: null, grad: null, intensity: null,
    z: [],             // 当前面距离
    eta: 1,
    targetSteps: 0,
    probe: null,       // { x, y } 或 null
    view: 'drive',     // drive / intensity / grad / loss
    planeIndex: 0,
    lastValidProject: null,
    timing: { t0: 0, elapsed: null },
  };

  const $ = (id) => document.getElementById(id);
  const byId = new Map();

  /* ---------------------------- Worker 封装 ---------------------------- */

  function spawnWorker() {
    const blob = new Blob([globalThis.PM_WORKER_SRC], { type: 'text/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    w.onerror = (e) => { logStatus('worker 错误：' + (e.message || '未知')); };
    return w;
  }

  const pending = new Map(); // id -> { resolve, reject, epoch }
  let nextId = 1;

  function call(type, payload, epochGuard) {
    return new Promise((resolve, reject) => {
      if (!S.worker) S.worker = spawnWorker();
      const id = nextId++;
      pending.set(id, { resolve, reject, epoch: epochGuard });
      S.worker.postMessage({ type, id, ...payload });
    });
  }

  function onWorkerMessage(ev) {
    const msg = ev.data || {};
    const slot = pending.get(msg.id);
    if (slot) { pending.delete(msg.id); slot.resolve(msg); }
  }

  /* ---------------------------- 数据视图 ---------------------------- */

  const canvas = () => $('view');
  let ctx2d = null;

  function ensureCanvas() {
    const c = canvas();
    if (!ctx2d) ctx2d = c.getContext('2d', { willReadFrequently: true });
    return c;
  }

  function fmt(v, digits = 6) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return v.toExponential(digits - 1);
    return v.toFixed(digits);
  }

  // 驱动值 → 8 位码
  const toByte = (v) => { const q = Math.floor(255 * v + 0.5); return q < 0 ? 0 : q > 255 ? 255 : q; };

  function draw() {
    const c = ensureCanvas();
    if (!S.engineMeta) return;
    const { W, H } = S.engineMeta;
    const srcW = W, srcH = H;
    if (c.width !== srcW || c.height !== srcH) { c.width = srcW; c.height = srcH; }
    const cw = c.width, ch = c.height;
    const img = ctx2d.createImageData(cw, ch);
    const d = img.data;
    const px = (x, y, r, g, b, a) => {
      const i = (y * cw + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    };
    if (!S.p) return;
    if (S.view === 'drive') {
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const idx = Math.min(S.p.length - 1, y * W + x);
          const v = S.p[idx];
          const g = Math.round(v * 255);
          px(x, y, g, g, g, 255);
        }
      }
    } else if (S.view === 'intensity') {
      const I = S.intensity ? S.intensity[S.planeIndex] : null;
      let lo = 0, hi = 1;
      if (I) {
        lo = Infinity; hi = -Infinity;
        for (let i = 0; i < W * H; i++) { if (I[i] < lo) lo = I[i]; if (I[i] > hi) hi = I[i]; }
        if (!Number.isFinite(lo) || hi <= lo) { lo = 0; hi = hi || 1; }
      }
      const span = (hi - lo) || 1;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const v = I ? I[Math.min(I.length - 1, y * W + x)] : 0;
          const t = Math.max(0, Math.min(1, (v - lo) / span));
          // 深蓝 → 青 → 黄 → 白
          px(x, y, Math.round(255 * Math.min(1, 1.5 * t)),
            Math.round(255 * Math.min(1, Math.max(0, t * 1.6 - 0.2))),
            Math.round(255 * Math.min(1, Math.max(0, 0.55 * t + (1 - t) * 0.5))), 255);
        }
      }
    } else if (S.view === 'grad') {
      const G = S.grad;
      let maxa = 1e-12;
      if (G) for (let i = 0; i < G.length; i++) maxa = Math.max(maxa, Math.abs(G[i]));
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const v = G ? G[Math.min(G.length - 1, y * W + x)] : 0;
          const t = v / maxa;              // [-1,1]
          const pos = Math.max(0, t), neg = Math.max(0, -t);
          px(x, y, Math.round(255 * (neg * 0.75 + (t < 0 ? 0 : t * 0.25)) + 20),
            Math.round(255 * (neg * 0.25 + pos * 0.2)),
            Math.round(255 * (neg * 0.9 + pos * 0.7)), 255);
        }
      }
    }
    ctx2d.putImageData(img, 0, 0);
    drawOverlay();
  }

  function drawOverlay() {
    // 用 DOM 叠加层标点查位置，避免污染像素数据
    const box = $('viewBox');
    if (!S.probe || !S.engineMeta) return;
    const { W, H } = S.engineMeta;
    const c = canvas();
    const rect = c.getBoundingClientRect();
    const bx = box.getBoundingClientRect();
    const left = rect.left - bx.left + (S.probe.x + 0.5) * (rect.width / W);
    const top = rect.top - bx.top + (S.probe.y + 0.5) * (rect.height / H);
    const mark = $('probeMark');
    mark.style.left = left + 'px';
    mark.style.top = top + 'px';
    mark.hidden = false;
  }

  /* ---------------------------- 状态与显示 ---------------------------- */

  function setBusy(b, label) {
    S.busy = b;
    $('btnStep').disabled = b;
    $('btnRun').disabled = b || !S.project;
    $('btnPause').disabled = !b;
    $('btnLoad').disabled = b;
    $('busyPill').hidden = !b;
    if (label) $('busyText').textContent = label;
    if (S.worker) updateStatus();
  }

  function updateStatus() {
    const text = statusLine();
    $('statusText').textContent = text;
    const pill = $('statusPill');
    pill.className = 'pill' + (S.busy ? ' warn' : S.done ? ' good' : '');
  }

  function renderAll() {
    $('metaW').textContent = S.engineMeta ? S.engineMeta.W : '—';
    $('metaH').textContent = S.engineMeta ? S.engineMeta.H : '—';
    $('metaWaves').textContent = S.engineMeta ? S.engineMeta.waveCount : '—';
    $('metaPlanes').textContent = S.engineMeta ? S.engineMeta.planeCount : '—';
    $('roundVal').textContent = String(S.round);
    $('stepVal').textContent = S.stepSize === null ? '—' : fmt(S.stepSize, 4);
    $('lossVal').textContent = fmt(S.loss, 8);
    updateStatus();
    // 逐面损失
    const tbody = $('planeRows');
    if (S.engineMeta && S.project) {
      tbody.innerHTML = '';
      for (let j = 0; j < S.project.planes.length; j++) {
        const pl = S.project.planes[j];
        const tr = document.createElement('tr');
        const cells = [
          String(j + 1),
          'λ' + (pl.wave + 1),
          fmt(pl.z, 4),
          fmt(S.planeLoss[j] === undefined ? 0 : S.planeLoss[j], 8),
          (pl.weight.every((v) => v === 0) ? '零权重' : ''),
        ];
        for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        if (S.planeIndex === j) tr.classList.add('sel');
        tr.addEventListener('click', () => { S.planeIndex = j; renderAll(); draw(); updateProbe(); });
        tbody.appendChild(tr);
      }
    } else {
      tbody.innerHTML = '';
    }
    // 目标/强度视图需要所选面
    const planeSel = $('planeSel');
    if (S.project) {
      planeSel.innerHTML = '';
      S.project.planes.forEach((pl, j) => {
        const o = document.createElement('option');
        o.value = String(j);
        o.textContent = `面 ${j + 1} · λ${pl.wave + 1} · z=${fmt(pl.z, 3)}`;
        planeSel.appendChild(o);
      });
      planeSel.value = String(S.planeIndex);
    }
    $('planeSel').disabled = !S.project || !(S.view === 'intensity');
    // 图表
    drawChart();
    updateProbe();
    draw();
  }

  function statusLine() {
    if (!S.project) return '未载入项目';
    if (S.busy) return S.playing ? '续跑中' : '单步中';
    if (S.done) return '已完成';
    if (S.round === 0) return '第 0 轮';
    return '已暂停';
  }

  /* ---------------------------- 损失曲线 ---------------------------- */

  const chart = () => $('chart');

  function drawChart() {
    const c = chart();
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 320, cssH = c.clientHeight || 140;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    if (!S.history.length) { g.fillStyle = 'rgba(127,137,148,0.8)'; g.font = '12px system-ui'; g.fillText('无运行数据', 12, 24); return; }
    const pad = { l: 52, r: 12, t: 12, b: 26 };
    const plotW = cssW - pad.l - pad.r, plotH = cssH - pad.t - pad.b;
    const losses = S.history.map((h) => h.loss);
    const lo = Math.min(...losses), hi = Math.max(...losses);
    const span = (hi - lo) || Math.abs(hi) || 1;
    const rMax = Math.max(S.targetSteps, S.round, 1);
    g.strokeStyle = 'rgba(127,137,148,0.35)'; g.lineWidth = 1;
    g.strokeRect(pad.l, pad.t, plotW, plotH);
    // 轴标签
    g.fillStyle = 'rgba(127,137,148,0.95)'; g.font = '11px ui-monospace,monospace';
    g.fillText(fmt(hi, 5), 4, pad.t + 8);
    g.fillText(fmt(lo, 5), 4, pad.t + plotH);
    g.fillText('轮', pad.l + plotW / 2 - 6, cssH - 6);
    // 折线
    g.beginPath();
    S.history.forEach((h, i) => {
      const x = pad.l + (rMax ? (h.round / rMax) * plotW : 0);
      const y = pad.t + plotH - ((h.loss - lo) / span) * plotH;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.strokeStyle = '#2f7fe0'; g.lineWidth = 1.6; g.stroke();
    // 步长柱（对数值）
    const steps = S.history.map((h) => h.stepSize);
    const maxRatio = 1;
    for (let i = 0; i < S.history.length; i++) {
      const t = steps[i];
      if (t === null || t === undefined) continue;
      const x = pad.l + (rMax ? (S.history[i].round / rMax) * plotW : 0);
      const r = Math.log2((t || 1e-9) / maxRatio);
      const hgt = Math.max(0, Math.min(1, (r + 8) / 8)) * (plotH * 0.4);
      g.fillStyle = t === 0 ? 'rgba(196,54,54,0.5)' : 'rgba(12,138,60,0.45)';
      g.fillRect(x - 1.5, pad.t + plotH - hgt, 3, hgt);
    }
  }

  /* ---------------------------- 点查 ---------------------------- */

  function updateProbe() {
    const rows = $('probeRows');
    rows.innerHTML = '';
    if (!S.probe || !S.project || !S.p) {
      $('probeHint').textContent = '在图上点一个像素';
      $('probeGrid').hidden = true;
      return;
    }
    $('probeHint').textContent = `像素 (${S.probe.x}, ${S.probe.y})`;
    $('probeGrid').hidden = false;
    const idx = S.probe.y * S.engineMeta.W + S.probe.x;
    const isLock = S.project.locks.some(([x, y]) => x === S.probe.x && y === S.probe.y);
    const lockEntry = S.project.locks.find(([x, y]) => x === S.probe.x && y === S.probe.y);
    const entries = [
      ['驱动 p', fmt(S.p[idx], 8)],
      ['8 位码', String(toByte(S.p[idx]))],
      ['损失梯度 G', S.grad ? fmt(S.grad[idx], 8) : '—'],
      ['所属面', `面 ${S.planeIndex + 1}`],
      ['预测强度 I', S.intensity && S.intensity[S.planeIndex] ? fmt(S.intensity[S.planeIndex][idx], 8) : '—'],
      ['目标强度 T', fmt(S.project.planes[S.planeIndex].target[idx], 6)],
      ['权重 w', fmt(S.project.planes[S.planeIndex].weight[idx], 3)],
      ['锁点', isLock ? `是 · q=${lockEntry[2]}（${fmt(lockEntry[2] / 255, 8)}）` : '否'],
      ['amp', fmt(S.project.amp[idx], 6)],
    ];
    for (const [k, v] of entries) {
      const dl = document.createElement('dt'); dl.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      rows.appendChild(dl); rows.appendChild(dd);
    }
    drawOverlay();
  }

  function canvasPick(ev) {
    if (!S.engineMeta) return;
    const c = canvas();
    const rect = c.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * S.engineMeta.W);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * S.engineMeta.H);
    if (x < 0 || y < 0 || x >= S.engineMeta.W || y >= S.engineMeta.H) return;
    S.probe = { x, y };
    updateProbe();
  }

  /* ---------------------------- 校验与导入 ---------------------------- */

  function describeErrors(errors) {
    return errors.slice(0, 6).map((e) => `${e.path}：${e.message}`).join('\n') +
      (errors.length > 6 ? `\n…另有 ${errors.length - 6} 项` : '');
  }

  function validate(raw) {
    return PM.validateProject(raw);
  }

  function loadProjectObject(raw, sourceName) {
    const v = validate(raw);
    if (!v.ok) {
      showLoadError(`无法载入 ${sourceName}：\n${describeErrors(v.errors)}`);
      return false;
    }
    S.lastValidProject = raw;
    acceptProject(raw, sourceName);
    return true;
  }

  function showLoadError(text) {
    $('loadStatus').textContent = text;
    $('loadStatus').classList.add('bad');
    // 保留上一份有效项目：不清空任何运行状态
  }

  function acceptProject(raw, sourceName) {
    S.epoch += 1;
    const epoch = S.epoch;
    S.project = JSON.parse(JSON.stringify(raw));
    S.z = S.project.planes.map((pl) => pl.z);
    S.eta = S.project.eta;
    S.targetSteps = S.project.steps;
    S.engineMeta = null;
    S.round = 0; S.loss = 0; S.planeLoss = []; S.stepSize = null; S.history = [];
    S.p = null; S.grad = null; S.intensity = null; S.done = false;
    S.playing = false; S.busy = false;
    S.timing = { t0: 0, elapsed: null };
    $('loadStatus').textContent =
      `已载入 ${sourceName} · ${S.project.W}×${S.project.H} · ${S.project.waves.length} 波长 · ${S.project.planes.length} 面`;
    $('loadStatus').classList.remove('bad');
    $('etaInput').value = String(S.eta);
    $('stepsInput').value = String(S.targetSteps);
    renderZInputs();
    renderAll();
    loadIntoWorker(epoch);
  }

  async function loadIntoWorker(epoch) {
    setBusy(true, '载入');
    try {
      const msg = await call('load', {
        project: S.project, eta: S.eta, steps: S.targetSteps,
      }, epoch);
      if (epoch !== S.epoch) return;                 // 旧任务：丢弃
      if (msg.type !== 'loaded') {
        $('loadStatus').textContent = '载入失败：' + describeErrors(msg.errors || []);
        $('loadStatus').classList.add('bad');
        return;
      }
      S.engineMeta = {
        W: msg.W, H: msg.H,
        waveCount: S.project.waves.length, planeCount: S.project.planes.length,
      };
      S.round = msg.round; S.loss = msg.loss; S.planeLoss = msg.planeLoss;
      S.history = msg.history; S.stepSize = null; S.done = false;
      const snap = await call('snapshot', {}, epoch);
      if (epoch !== S.epoch) return;
      applySnapshot(snap);
    } finally {
      if (epoch === S.epoch) setBusy(false);
      renderAll();
    }
  }

  function applySnapshot(msg) {
    S.round = msg.round; S.loss = msg.loss; S.planeLoss = msg.planeLoss;
    S.stepSize = msg.stepSize; S.p = msg.p; S.grad = msg.grad; S.intensity = msg.intensity;
    S.history = msg.history; S.done = msg.done;
    renderAll();
  }

  /* ---------------------------- 运行控制 ---------------------------- */

  function beginTimingIfNeeded() {
    if (S.timing.t0 === 0 && S.round === 0) S.timing.t0 = performance.now();
  }

  function markDoneTiming() {
    if (S.done && S.timing.elapsed === null) {
      S.timing.elapsed = performance.now() - (S.timing.t0 || performance.now());
    }
  }

  async function singleStep() {
    if (!S.project || S.busy || S.done) return;
    const epoch = S.epoch;
    beginTimingIfNeeded();
    setBusy(true, '单步');
    try {
      const msg = await call('step', {}, epoch);
      if (epoch !== S.epoch) return;                 // 旧任务：丢弃
      if (msg.type === 'stepped') {
        S.round = msg.round; S.loss = msg.loss; S.planeLoss = msg.planeLoss;
        S.stepSize = msg.stepSize; S.history = msg.history; S.done = msg.done;
        const snap = await call('snapshot', {}, epoch);
        if (epoch !== S.epoch) return;
        applySnapshot(snap);
      } else if (msg.type === 'error') {
        $('loadStatus').textContent = '运行出错：' + msg.message;
      }
      markDoneTiming();
      renderAll();
    } finally {
      if (epoch === S.epoch) setBusy(false);
    }
  }

  async function play() {
    if (!S.project || S.busy) return;
    S.playing = true;
    const epoch = S.epoch;
    beginTimingIfNeeded();
    setBusy(true, '续跑');
    try {
      while (S.playing && S.epoch === epoch && !S.done) {
        const msg = await call('step', {}, epoch);
        if (epoch !== S.epoch) return;
        if (msg.type !== 'stepped') break;
        S.round = msg.round; S.loss = msg.loss; S.planeLoss = msg.planeLoss;
        S.stepSize = msg.stepSize; S.history = msg.history; S.done = msg.done;
        if (!S.playing) break;                       // 暂停：当前轮已完整
        renderAll();
      }
      if (epoch !== S.epoch) return;
      const snap = await call('snapshot', {}, epoch);
      if (epoch !== S.epoch) return;
      applySnapshot(snap);
      markDoneTiming();
      renderAll();
    } finally {
      if (epoch === S.epoch) { S.playing = false; setBusy(false); }
    }
  }

  function pause() {
    S.playing = false;                               // 当前轮跑完后停
    $('btnPause').disabled = true;
  }

  /* ---------------------------- 参数修改 ---------------------------- */

  function resetToNewRound0(reason) {
    // 改 z 或 eta 后：以当前项目为新设置，重新载入，回到第 0 轮
    const raw = JSON.parse(JSON.stringify(S.project));
    raw.eta = S.eta;
    raw.steps = S.targetSteps;
    raw.planes.forEach((pl, j) => { pl.z = S.z[j]; });
    loadProjectObject(raw, `当前项目（${reason}）`);
  }

  function commitEta(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || !(v > 0 && v <= 1)) {
      $('paramMsg').textContent = 'eta 必须在 (0, 1] 内';
      $('etaInput').value = String(S.eta);
      return;
    }
    if (v === S.eta) { $('paramMsg').textContent = ''; return; }
    S.eta = v;
    $('paramMsg').textContent = '已改步长比 eta → 回到第 0 轮';
    resetToNewRound0('eta 变更');
  }

  function commitZ(j, value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 10000) {
      $('paramMsg').textContent = `面 ${j + 1} 的 z 必须在 0 到 10000 微米之间`;
      return;
    }
    if (v === S.z[j]) { $('paramMsg').textContent = ''; return; }
    S.z[j] = v;
    $('paramMsg').textContent = `已改面 ${j + 1} 的 z → 回到第 0 轮`;
    resetToNewRound0(`面 ${j + 1} 改 z`);
  }

  async function commitSteps(value) {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 1 || v > 120) {
      $('paramMsg').textContent = 'steps 必须是 1 到 120 的整数';
      $('stepsInput').value = String(S.targetSteps);
      return;
    }
    if (!S.project) { S.targetSteps = v; return; }
    S.targetSteps = v;
    S.project.steps = v;
    const epoch = S.epoch;
    const msg = await call('setSteps', { steps: v }, epoch);
    if (epoch !== S.epoch) return;
    if (msg.type === 'stepsSet') {
      S.done = msg.done; S.round = msg.round; S.loss = msg.loss;
      S.planeLoss = msg.planeLoss; S.history = msg.history;
    }
    $('paramMsg').textContent = '';
    renderAll();
  }

  function renderZInputs() {
    const wrap = $('zRows');
    wrap.innerHTML = '';
    if (!S.project) return;
    S.project.planes.forEach((pl, j) => {
      const row = document.createElement('div');
      row.className = 'zrow';
      const lab = document.createElement('label');
      lab.textContent = `面 ${j + 1}（λ${pl.wave + 1}）`;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = 'any'; inp.min = '0'; inp.max = '10000';
      inp.value = String(S.z[j]);
      inp.addEventListener('change', () => commitZ(j, inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitZ(j, inp.value); });
      row.appendChild(lab); row.appendChild(inp);
      wrap.appendChild(row);
    });
    $('zPanel').hidden = false;
  }

  /* ---------------------------- 导出 ---------------------------- */

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportDrive() {
    if (!S.project) return;
    const epoch = S.epoch;
    const msg = await call('export', {}, epoch);
    if (epoch !== S.epoch) return;
    const bytes = Uint8Array.from(msg.bytes);
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }),
      `phase-mask-${S.engineMeta.W}x${S.engineMeta.H}-step${msg.error.step}.bin`);
    $('exportNote').textContent =
      `已导出 ${bytes.length} 字节（step=${msg.error.step}），误差 JSON 用这些量化码重算：` +
      `E=${fmt(msg.error.loss, 8)}`;
  }

  async function exportError() {
    if (!S.project) return;
    const epoch = S.epoch;
    const msg = await call('export', {}, epoch);
    if (epoch !== S.epoch) return;
    const json = JSON.stringify(msg.error, null, 2) + '\n';
    downloadBlob(new Blob([json], { type: 'application/json' }),
      `phase-mask-error-step${msg.error.step}.json`);
    $('exportNote').textContent =
      `误差 JSON：step=${msg.error.step}，loss=${fmt(msg.error.loss, 8)}（由量化码 q/255 重新传播）`;
  }

  /* ---------------------------- 事件 ---------------------------- */

  function wire() {
    $('btnSample').addEventListener('click', async () => {
      try {
        const res = await fetch('./samples/phase-mask.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        loadProjectObject(raw, 'samples/phase-mask.json');
      } catch (e) {
        // file:// 下 fetch 本地文件受限：提示改用文件选择
        $('loadStatus').textContent =
          `读取内置样例失败（${e.message}）。file:// 打开时请用“导入 JSON”选择 samples/phase-mask.json。`;
        $('loadStatus').classList.add('bad');
      }
    });

    $('btnLoad').addEventListener('click', () => $('fileInput').click());

    $('fileInput').addEventListener('change', async () => {
      const file = $('fileInput').files && $('fileInput').files[0];
      if (!file) return;
      try {
        const text = await file.text();
        let raw;
        try { raw = JSON.parse(text); } catch (e) {
          const v = { ok: false, errors: [{ path: '(root)', message: 'JSON 解析失败：' + e.message }] };
          showLoadError(`无法载入 ${file.name}：\n${describeErrors(v.errors)}`);
          return;
        }
        loadProjectObject(raw, file.name);
      } finally {
        $('fileInput').value = '';
      }
    });

    $('btnStep').addEventListener('click', singleStep);
    $('btnRun').addEventListener('click', play);
    $('btnPause').addEventListener('click', pause);

    $('etaInput').addEventListener('change', () => commitEta($('etaInput').value));
    $('stepsInput').addEventListener('change', () => commitSteps($('stepsInput').value));

    $('viewTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-view]');
      if (!b) return;
      S.view = b.dataset.view;
      for (const x of $('viewTabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
      $('planeSel').disabled = !(S.project && (S.view === 'intensity'));
      draw();
    });

    $('planeSel').addEventListener('change', () => {
      S.planeIndex = Number($('planeSel').value);
      renderAll();
    });

    const c = canvas();
    c.addEventListener('click', canvasPick);
    c.addEventListener('keydown', (ev) => {
      if (!S.probe) return;
      let { x, y } = S.probe;
      if (ev.key === 'ArrowLeft') x -= 1;
      else if (ev.key === 'ArrowRight') x += 1;
      else if (ev.key === 'ArrowUp') y -= 1;
      else if (ev.key === 'ArrowDown') y += 1;
      else return;
      ev.preventDefault();
      if (x < 0) x = 0; if (y < 0) y = 0;
      if (x >= S.engineMeta.W) x = S.engineMeta.W - 1;
      if (y >= S.engineMeta.H) y = S.engineMeta.H - 1;
      S.probe = { x, y }; updateProbe();
    });

    $('btnExportDrive').addEventListener('click', exportDrive);
    $('btnExportError').addEventListener('click', exportError);
    $('btnExportBoth').addEventListener('click', async () => {
      await exportDrive();
      await exportError();
    });

    window.addEventListener('resize', () => drawChart());
  }

  function boot() {
    if (globalThis.PM_WORKER_SRC) {
      S.worker = spawnWorker();
      S.worker.onmessage = onWorkerMessage;
    } else {
      $('statusText').textContent = '未找到 worker 源码（请先运行 node tools/build-worker.mjs）';
    }
    wire();
    renderAll();
    // 试载入内置样例（http 下成功）
    if (location.protocol !== 'file:') $('btnSample').click();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供无浏览器测试（VM + DOM 桩）使用的钩子
  globalThis.__PM_APP__ = { S, loadProjectObject, singleStep, play, pause, exportDrive, exportError, draw };
})();
