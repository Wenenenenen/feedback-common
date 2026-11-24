/* app.js — 互易辐射度校验台页面状态、交互、版本守卫和导出 */
(function () {
  'use strict';

  const Core = window.RadiosityCore;
  const $ = (selector) => document.querySelector(selector);

  const EMBEDDED_SAMPLE = {
    patches: [
      { area: 1, rect: [0, 0, 1, 1], rho: [0.4, 0.4, 0.4], E: [1, 0.35, 0.1] },
      { area: 2, rect: [1, 0, 2, 1], rho: [0.5, 0.6, 0.6], E: [0, 0, 0] },
    ],
    links: [[0, 1, 0.6], [1, 0, 0.4]],
  };

  const app = {
    version: 0,
    solveToken: 0,
    solvedVersion: -1,
    solving: false,

    patches: [],
    links: [],
    corr: null,
    L: null,
    stats: null,
    linkIndex: new Map(),

    selected: -1,
    hover: -1,
    undoStack: [],

    errors: [],
    errorOverflow: 0,
    errorLabel: '',

    importMs: 0,
    solveMs: 0,
    view: { scale: 1, ox: 0, oy: 0 },
  };

  window.RadiosityDesk = app;

  /* ---------------- 小工具 ---------------- */

  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function format6(x) {
    if (!Number.isFinite(x)) return '—';
    if (x !== 0 && (Math.abs(x) < 1e-4 || Math.abs(x) >= 1e12)) {
      return x.toExponential(6);
    }
    return x.toFixed(6);
  }

  function formatBound(x) {
    if (x === 0) return '0';
    return Number.isFinite(x) ? x.toExponential(2) : '—';
  }

  function toneMap(x) {
    if (!Number.isFinite(x)) return 0;
    const mapped = 1 - Math.exp(-Math.max(0, x));
    return Math.max(0, Math.min(255, Math.round(255 * mapped)));
  }

  function rebuildLinkIndex() {
    const n = app.patches.length;
    app.linkIndex = new Map();
    for (let index = 0; index < app.links.length; index++) {
      const row = app.links[index];
      app.linkIndex.set(row[0] * n + row[1], index);
    }
  }

  /* ---------------- 撤销 ---------------- */

  function updateUndoUI() {
    const button = $('#btnUndo');
    if (button) button.disabled = app.undoStack.length === 0;
  }

  function pushUndo(op) {
    app.undoStack.push(op);
    if (app.undoStack.length > 80) app.undoStack.shift();
    updateUndoUI();
  }

  function applyLink(i, j, f) {
    const n = app.patches.length;
    const key = i * n + j;
    const index = app.linkIndex.get(key);

    if (f === null || f === undefined) {
      if (index !== undefined) {
        app.links.splice(index, 1);
        rebuildLinkIndex();
      }
      return;
    }

    if (index === undefined) {
      app.links.push([i, j, f]);
      app.linkIndex.set(key, app.links.length - 1);
    } else {
      app.links[index] = [i, j, f];
    }
  }

  function undo() {
    const op = app.undoStack.pop();
    if (!op) {
      updateUndoUI();
      return;
    }

    if (op.kind === 'link') {
      applyLink(op.i, op.j, op.oldF);
    } else if (op.kind === 'patch') {
      app.patches[op.index][op.field] = op.oldValue.slice();
    } else if (op.kind === 'state') {
      app.patches = op.patches;
      app.links = op.links;
      rebuildLinkIndex();
    }

    afterModelChange();
    renderInspector();
    draw();
    updateUndoUI();
  }

  /* ---------------- 模型编辑 ---------------- */

  function setLink(i, j, f, recordUndo) {
    const n = app.patches.length;
    const index = app.linkIndex.get(i * n + j);
    const oldF = index === undefined ? null : app.links[index][2];

    if (recordUndo) {
      pushUndo({ kind: 'link', i, j, oldF });
    }

    applyLink(i, j, f);
    afterModelChange();
  }

  function setPatchComponent(index, field, channel, value) {
    const oldValue = app.patches[index][field].slice();
    const nextValue = oldValue.slice();
    nextValue[channel] = value;

    pushUndo({ kind: 'patch', index, field, oldValue });
    app.patches[index][field] = nextValue;
    afterModelChange();
  }

  function afterModelChange() {
    app.version += 1;

    if (app.selected >= app.patches.length) app.selected = -1;

    try {
      app.corr = Core.buildCorrection(app.patches, app.links);
    } catch (error) {
      app.corr = null;
      app.stats = {
        converged: false,
        errorBound: Infinity,
        fatal: error && error.message ? error.message : String(error),
      };
    }

    // 旧结果仍保留在 app.L 中供短暂对照，但 solvedVersion 已不等于当前版本。
    app.stats = null;
    scheduleSolve();

    renderVersion();
    renderStatus();
    renderSolveInfo();
    updateExportUI();
    updateUndoUI();
  }

  /* ---------------- 导入与错误保留 ---------------- */

  function importData(data, label) {
    const started = nowMs();
    let validation;

    try {
      validation = Core.validateData(data);
    } catch (error) {
      validation = {
        errors: [`数据无法读取：${error && error.message ? error.message : String(error)}`],
        overflow: 0,
      };
    }

    if (!validation || validation.errors.length) {
      app.errors = validation ? validation.errors : ['未知校验错误'];
      app.errorOverflow = validation ? validation.overflow : 0;
      app.errorLabel = label || '';
      renderErrors();
      setStatus('导入被拒绝，当前导出仍为旧版本', 'bad');
      updateExportUI();
      return false;
    }

    // 导入前留一个整体快照；初始空状态也入栈，保持自动化接口可观察。
    pushUndo({
      kind: 'state',
      patches: app.patches,
      links: app.links,
    });

    app.patches = Core.normalizePatches(data.patches);
    app.links = data.links.map((row) => [row[0], row[1], row[2]]);
    rebuildLinkIndex();

    app.errors = [];
    app.errorOverflow = 0;
    app.errorLabel = label || '';
    app.selected = -1;
    app.hover = -1;
    app.importMs = nowMs() - started;

    renderErrors();
    afterModelChange();
    return true;
  }

  function renderErrors() {
    const panel = $('#errPanel');
    if (!panel) return;

    if (!app.errors.length) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    const title = $('#errTitle');
    const list = $('#errList');
    const total = app.errors.length + (app.errorOverflow || 0);

    if (title) {
      title.textContent =
        `导入被拒绝，已保留原结果 — ${app.errorLabel || '数据'}：${total} 处问题` +
        (app.errorOverflow ? `（另有 ${app.errorOverflow} 条从略）` : '');
    }

    if (list) {
      // 先建占位 li，再用 textContent 写错误，避免把 JSON 中的异常值当 HTML。
      list.innerHTML = app.errors.map(() => '<li></li>').join('');
      const items = list.children;
      for (let i = 0; i < app.errors.length; i++) {
        if (items[i]) items[i].textContent = app.errors[i];
      }
    }
  }

  async function readImportFile(file) {
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch (error) {
      app.errors = [`JSON 解析失败：${error && error.message ? error.message : String(error)}`];
      app.errorOverflow = 0;
      app.errorLabel = file.name;
      renderErrors();
      setStatus('导入被拒绝，当前导出仍为旧版本', 'bad');
      return;
    }

    importData(data, file.name);
  }

  async function loadSample() {
    try {
      const response = await fetch('samples/reciprocal-patches.json', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        importData(data, 'samples/reciprocal-patches.json');
        return;
      }
    } catch (error) {
      // file:// 直接打开时浏览器可能拒绝 fetch，退回与样例文件一致的内置数据。
    }
    importData(EMBEDDED_SAMPLE, '内置样例');
  }

  /* ---------------- 版本守卫求解 ---------------- */

  async function scheduleSolve() {
    const version = app.version;
    const token = ++app.solveToken;
    app.solving = true;
    renderStatus();
    updateExportUI();

    await yieldToEventLoop();

    // 已有更新的编辑/导入：本次结果彻底丢弃，也不能复位新版本的 solving。
    if (token !== app.solveToken || version !== app.version) return;

    let solver;
    const started = nowMs();

    try {
      solver = Core.createSolver(app.patches, app.corr);
    } catch (error) {
      if (token !== app.solveToken || version !== app.version) return;
      app.solving = false;
      app.stats = {
        converged: false,
        errorBound: Infinity,
        fatal: error && error.message ? error.message : String(error),
      };
      renderStatus();
      updateExportUI();
      return;
    }

    try {
      for (;;) {
        const result = solver.step(20);

        if (token !== app.solveToken || version !== app.version) return;

        if (result.done) {
          const stats = solver.stats();
          app.L = solver.L;
          app.stats = stats;
          app.solveMs = nowMs() - started;
          app.solvedVersion = version;
          app.solving = false;
          renderAll();
          return;
        }

        setStatus(`求解中 · 第 ${result.sweeps} 次扫描`, 'busy');
        await yieldToEventLoop();

        if (token !== app.solveToken || version !== app.version) return;
      }
    } catch (error) {
      if (token !== app.solveToken || version !== app.version) return;
      app.solving = false;
      app.stats = {
        converged: false,
        errorBound: Infinity,
        fatal: error && error.message ? error.message : String(error),
      };
      renderAll();
    }
  }

  /* ---------------- 状态渲染 ---------------- */

  function setStatus(text, state) {
    const pill = $('#statusPill');
    if (!pill) return;
    pill.textContent = text;
    pill.dataset.state = state || '';
  }

  function renderVersion() {
    const pill = $('#versionPill');
    if (pill) pill.textContent = `v${app.version}`;
  }

  function isExportReady() {
    return Boolean(
      Core && app.corr && app.L && app.stats &&
      !app.solving &&
      app.solvedVersion === app.version &&
      Number.isFinite(app.stats.errorBound) &&
      app.stats.errorBound <= Core.EXPORT_TOL
    );
  }

  function renderStatus() {
    if (app.solving) {
      setStatus(`求解中 · v${app.version}`, 'busy');
      return;
    }

    if (app.L && app.solvedVersion === app.version && app.stats) {
      if (app.stats.errorBound <= Core.EXPORT_TOL) {
        setStatus(`已就绪 · 误差上界 ${formatBound(app.stats.errorBound)}`, 'ok');
      } else {
        const reason = app.stats.fatal ? `：${app.stats.fatal}` : '';
        setStatus(`未达到 1e-6 导出精度${reason}`, 'bad');
      }
      return;
    }

    if (app.patches.length) {
      setStatus('结果已过期，等待当前版本重解', 'busy');
    } else {
      setStatus('未载入数据', '');
    }
  }

  function renderSolveInfo() {
    const target = $('#solveInfo');
    if (!target) return;

    const rows = [];
    const row = (term, detail, className) => {
      rows.push(`<dt>${term}</dt><dd class="${className || ''}">${detail}</dd>`);
    };

    row('补丁 / 有向边', `${app.patches.length} / ${app.links.length}`);
    if (app.corr) row('校正无向边', String(app.corr.eg.length));
    row(
      '预览 / 模型版本',
      `v${app.solvedVersion < 0 ? '—' : app.solvedVersion} / v${app.version}`,
      app.solvedVersion === app.version ? 'good' : 'bad'
    );

    if (app.stats) {
      row('扫描次数', String(app.stats.sweeps || 0));
      row('最大残差', formatBound(app.stats.maxResidual));
      row(
        '误差上界',
        formatBound(app.stats.errorBound),
        app.stats.errorBound <= Core.EXPORT_TOL ? 'good' : 'bad'
      );
      if (app.stats.contraction !== undefined) {
        row('收敛系数', Number(app.stats.contraction).toFixed(6));
      }
    }

    if (app.solveMs) row('本次求解用时', `${app.solveMs.toFixed(0)} ms`);
    target.innerHTML = rows.join('');
  }

  /* ---------------- 检查器 ---------------- */

  function renderInspector() {
    const info = $('#patchInfo');
    const rawCard = $('#rawCard');
    const corrCard = $('#corrCard');
    const i = app.selected;
    const has = Number.isInteger(i) && i >= 0 && i < app.patches.length;

    if (rawCard) rawCard.hidden = !has;
    if (corrCard) corrCard.hidden = !has;

    if (!has) {
      if (info) info.innerHTML = '<p class="empty-note">尚未选中补丁。点击画布中的补丁开始检查。</p>';
      return;
    }

    const patch = app.patches[i];
    const outFraction = app.corr ? app.corr.outFrac[i] : 0;
    const scale = app.corr ? app.corr.s[i] : 1;
    const outClass = outFraction <= 1 + 1e-9 ? 'good' : 'bad';

    let html = '<dl class="kv">';
    html += `<dt>编号 / 面积</dt><dd>#${i} · A=${patch.area}</dd>`;
    html += `<dt>rect</dt><dd>[${patch.rect.map(format6).join(', ')}]</dd>`;
    html += `<dt>缩放因子 s(i)</dt><dd>${format6(scale)}</dd>`;
    html += `<dt>总出射比例</dt><dd class="${outClass}">${format6(outFraction)} ≤ 1</dd>`;
    html += '</dl>';

    html += '<div style="margin-top:9px">';
    html += '<div class="chan-row channel-row"><label for="rho0">ρ 反射</label>';
    for (let c = 0; c < 3; c++) {
      html += `<input id="rho${c}" type="number" min="0" max="${Core.RHO_LIMIT}" step="0.01" ` +
        `value="${patch.rho[c]}" data-act="rho" data-c="${c}" aria-label="反射率通道 ${c}">`;
    }
    html += '</div>';

    html += '<div class="chan-row channel-row"><label for="E0">E 自发光</label>';
    for (let c = 0; c < 3; c++) {
      html += `<input id="E${c}" type="number" min="0" max="1" step="0.01" ` +
        `value="${patch.E[c]}" data-act="E" data-c="${c}" aria-label="自发光通道 ${c}">`;
    }
    html += '</div>';

    if (app.L && app.solvedVersion === app.version) {
      const r = app.L[3 * i];
      const g = app.L[3 * i + 1];
      const b = app.L[3 * i + 2];
      const swatch = `rgb(${toneMap(r)},${toneMap(g)},${toneMap(b)})`;
      html += '<div class="chan-row channel-row"><label>L 稳态</label>' +
        `<span class="steady-values">${format6(r)} · ${format6(g)} · ${format6(b)}</span>` +
        `<span class="swatch" style="background:${swatch}" aria-hidden="true"></span></div>`;
    } else {
      html += '<div class="chan-row channel-row"><label>L 稳态</label>' +
        '<span class="steady-values muted">当前版本求解中…</span></div>';
    }
    html += '</div>';

    if (info) info.innerHTML = html;

    const rawRows = [];
    for (const row of app.links) {
      const a = row[0];
      const b = row[1];
      const f = row[2];
      if (a !== i && b !== i) continue;

      const outgoing = a === i;
      const peer = outgoing ? b : a;
      // data-i/data-j 始终是这条有向记录的真实源、端点；入边不能反写成出边。
      rawRows.push(
        '<tr>' +
        `<td>${outgoing ? '出 →' : '入 ←'}</td>` +
        `<td>${peer}</td>` +
        `<td><input type="number" min="0" max="1" step="0.01" value="${f}" ` +
        `data-act="edgeF" data-i="${a}" data-j="${b}" aria-label="边 ${a} 到 ${b} 的 F"></td>` +
        `<td><button class="btn tiny danger" type="button" data-act="edgeDel" ` +
        `data-i="${a}" data-j="${b}">删</button></td>` +
        '</tr>'
      );
    }

    const rawBody = $('#rawEdges');
    if (rawBody) {
      rawBody.innerHTML = rawRows.join('') ||
        '<tr><td colspan="4" class="empty-row">无原始边，可在下方新增</td></tr>';
    }

    const corrRows = [];
    if (app.corr) {
      const begin = app.corr.adjStart[i];
      const end = app.corr.adjStart[i + 1];
      for (let p = begin; p < end; p++) {
        const j = app.corr.adjJ[p];
        const g = app.corr.adjG[p];
        corrRows.push(`<tr><td>${j}</td><td>${format6(g)}</td><td>${format6(g / patch.area)}</td></tr>`);
      }
    }

    const corrBody = $('#corrEdges');
    if (corrBody) {
      corrBody.innerHTML = corrRows.join('') ||
        '<tr><td colspan="3" class="empty-row">无校正边</td></tr>';
    }
  }

  /* ---------------- Canvas 预览 ---------------- */

  const canvas = $('#stage');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;

  function cssVar(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (error) {
      return '';
    }
  }

  function drawPatchOutline(index, scale, ox, oy, color, width) {
    if (!ctx || index < 0 || index >= app.patches.length) return;
    const r = app.patches[index].rect;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(
      r[0] * scale + ox,
      r[1] * scale + oy,
      Math.max(1, r[2] * scale),
      Math.max(1, r[3] * scale)
    );
  }

  function draw() {
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--canvas-bg') || '#dfe6ef';
    ctx.fillRect(0, 0, width, height);

    const n = app.patches.length;
    if (!n) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const patch of app.patches) {
      const [x, y, w, h] = patch.rect;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    if (!Number.isFinite(minX)) {
      minX = 0; minY = 0; maxX = 1; maxY = 1;
    }

    const pad = 18;
    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const ox = pad + ((width - pad * 2) - spanX * scale) / 2 - minX * scale;
    const oy = pad + ((height - pad * 2) - spanY * scale) / 2 - minY * scale;
    app.view = { scale, ox, oy };

    const selected = app.selected;

    if (selected >= 0 && selected < n && app.corr) {
      const rect = app.patches[selected].rect;
      const cx = rect[0] * scale + ox + rect[2] * scale / 2;
      const cy = rect[1] * scale + oy + rect[3] * scale / 2;
      let gMax = 0;

      for (let p = app.corr.adjStart[selected]; p < app.corr.adjStart[selected + 1]; p++) {
        if (app.corr.adjG[p] > gMax) gMax = app.corr.adjG[p];
      }

      ctx.lineWidth = 1.1;
      const edgeColor = cssVar('--accent') || '#b45309';
      for (let p = app.corr.adjStart[selected]; p < app.corr.adjStart[selected + 1]; p++) {
        const j = app.corr.adjJ[p];
        const q = app.patches[j].rect;
        const jx = q[0] * scale + ox + q[2] * scale / 2;
        const jy = q[1] * scale + oy + q[3] * scale / 2;
        ctx.strokeStyle = edgeColor;
        ctx.globalAlpha = 0.13 + 0.58 * (app.corr.adjG[p] / (gMax || 1));
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(jx, jy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const solved = Boolean(app.L && app.solvedVersion === app.version);
    const fallback = cssVar('--line-strong') || '#c4cfdd';

    for (let k = 0; k < n; k++) {
      const rect = app.patches[k].rect;
      const x = rect[0] * scale + ox;
      const y = rect[1] * scale + oy;
      const w = Math.max(1, rect[2] * scale);
      const h = Math.max(1, rect[3] * scale);

      if (solved) {
        const r = toneMap(app.L[3 * k]);
        const g = toneMap(app.L[3 * k + 1]);
        const b = toneMap(app.L[3 * k + 2]);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = fallback;
      }
      ctx.fillRect(x, y, w, h);
    }

    if (app.hover >= 0 && app.hover < n && app.hover !== selected) {
      drawPatchOutline(app.hover, scale, ox, oy, cssVar('--faint') || '#98a2b3', 1.4);
    }
    if (selected >= 0 && selected < n) {
      drawPatchOutline(selected, scale, ox, oy, cssVar('--sel') || '#1d4ed8', 2.4);
    }
  }

  function patchAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { scale, ox, oy } = app.view;

    let nearest = -1;
    let nearestDistance = 8; // CSS px；环形全览时补丁可能不足 1px。

    // 从后向前：重叠时优先选择数组中更靠后的补丁。
    for (let k = app.patches.length - 1; k >= 0; k--) {
      const r = app.patches[k].rect;
      const x = r[0] * scale + ox;
      const y = r[1] * scale + oy;
      const w = Math.max(1, r[2] * scale);
      const h = Math.max(1, r[3] * scale);

      if (mx >= x && mx <= x + w && my >= y && my <= y + h) return k;

      const cx = x + w / 2;
      const cy = y + h / 2;
      const distance = Math.hypot(mx - cx, my - cy);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearest = k;
      }
    }

    return nearest;
  }

  if (canvas) {
    canvas.addEventListener('click', (event) => {
      app.selected = patchAt(event.clientX, event.clientY);
      renderInspector();
      draw();
    });

    canvas.addEventListener('mousemove', (event) => {
      const nextHover = patchAt(event.clientX, event.clientY);
      if (nextHover !== app.hover) {
        app.hover = nextHover;
        draw();
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (app.hover !== -1) {
        app.hover = -1;
        draw();
      }
    });
  }

  window.addEventListener('resize', draw);

  /* ---------------- 导出：必须与当前预览同版 ---------------- */

  function buildExportPayload() {
    if (!isExportReady()) return null;

    const correctedLinks = [];
    for (let k = 0; k < app.corr.eg.length; k++) {
      correctedLinks.push([app.corr.eu[k], app.corr.ev[k], app.corr.eg[k]]);
    }

    return {
      version: app.version,
      rule: Core && Core.ruleText ? Core.ruleText :
        'H(i,j)=(Ai*Fij+Aj*Fji)/2; s(i)=max(1,sum_j H(i,j)/Ai); ' +
        'G(i,j)=H(i,j)/max(s(i),s(j)); L(i)=E(i)+rho(i)*sum_j G(i,j)*L(j)/Ai',
      stats: {
        sweeps: app.stats.sweeps,
        maxResidual: app.stats.maxResidual,
        errorBound: app.stats.errorBound,
        contraction: app.stats.contraction,
        solveMs: Math.round(app.solveMs),
      },
      patches: app.patches.map((patch, i) => ({
        area: patch.area,
        rect: patch.rect,
        rho: patch.rho,
        E: patch.E,
        L: [app.L[3 * i], app.L[3 * i + 1], app.L[3 * i + 2]],
      })),
      correctedLinks,
    };
  }

  function updateExportUI() {
    const button = $('#btnExport');
    if (!button) return;

    const ready = isExportReady();
    button.disabled = !ready;
    button.textContent = ready ? `导出结果 (v${app.version})` : '导出结果';
  }

  function exportJSON() {
    if (!isExportReady()) return;
    const payload = buildExportPayload();
    if (!payload) return;

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `radiosity-v${app.version}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    if (typeof anchor.remove === 'function') anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- 全量渲染与事件绑定 ---------------- */

  function renderAll() {
    renderVersion();
    renderStatus();
    renderSolveInfo();
    renderInspector();
    updateExportUI();
    updateUndoUI();
    draw();
  }

  function bindEvents() {
    $('#btnUndo').addEventListener('click', undo);
    $('#btnExport').addEventListener('click', exportJSON);

    $('#btnImport').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) readImportFile(file);
    });

    $('#btnSample').addEventListener('click', loadSample);
    $('#btnRing').addEventListener('click', () => {
      setStatus('正在生成 4096 块环形样例…', 'busy');
      // 让状态先绘制，再执行一次性生成和校正。
      setTimeout(() => {
        try {
          const sample = Core.generateRingSample(4096, 36);
          importData(sample, '环形样例 4096 / 每侧 36');
        } catch (error) {
          app.errors = [error && error.message ? error.message : String(error)];
          renderErrors();
        }
      }, 12);
    });

    $('#btnAddEdge').addEventListener('click', () => {
      const i = app.selected;
      if (i < 0 || i >= app.patches.length) {
        setStatus('请先选择一个补丁', 'bad');
        return;
      }

      const targetInput = $('#addTarget');
      const fInput = $('#addF');
      const j = Number(targetInput.value);
      const f = Number(fInput.value);
      const n = app.patches.length;

      if (!Number.isInteger(j) || j < 0 || j >= n || j === i) {
        setStatus('目标编号无效：须为其他补丁的整数编号', 'bad');
        return;
      }
      if (!Number.isFinite(f) || f < 0 || f > 1) {
        setStatus('F 须为 [0, 1] 内的数', 'bad');
        return;
      }

      setLink(i, j, f, true);
      targetInput.value = '';
      fInput.value = '';
    });

    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readImportFile(file);
    });

    window.addEventListener('keydown', (event) => {
      const key = event.key ? event.key.toLowerCase() : '';
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        const target = event.target;
        let allowAppUndo = true;

        if (target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement ||
            (target && target.isContentEditable)) {
          allowAppUndo = false;
        } else if (target instanceof HTMLInputElement) {
          // 正在输入且框内是尚未提交的草稿时，把 Ctrl/⌘+Z 留给浏览器文本撤销。
          allowAppUndo = false;
          const selected = app.selected;
          const action = target.dataset && target.dataset.act;
          if (selected >= 0 && (action === 'rho' || action === 'E')) {
            const channel = Number(target.dataset.c);
            allowAppUndo = Number(target.value) === app.patches[selected][action][channel];
          } else if (selected >= 0 && action === 'edgeF') {
            const a = Number(target.dataset.i);
            const b = Number(target.dataset.j);
            const index = app.linkIndex.get(a * app.patches.length + b);
            const current = index === undefined ? null : app.links[index][2];
            allowAppUndo = current !== null && Number(target.value) === current;
          }
        }

        if (allowAppUndo) {
          event.preventDefault();
          undo();
        }
      }

      if (event.key === 'Escape') {
        app.selected = -1;
        renderInspector();
        draw();
      }
    });

    const aside = document.querySelector('aside');

    aside.addEventListener('change', (event) => {
      const element = event.target;
      if (!(element instanceof HTMLInputElement)) return;

      const action = element.dataset.act;
      const i = app.selected;
      if (i < 0 || i >= app.patches.length) return;

      if (action === 'rho' || action === 'E') {
        const channel = Number(element.dataset.c);
        const limit = action === 'rho' ? Core.RHO_LIMIT : 1;
        const value = Number(element.value);

        if (!Number.isFinite(value) || value < 0 || value > limit) {
          setStatus(`${action} 须在 [0, ${limit}] 内`, 'bad');
          element.value = app.patches[i][action][channel];
          return;
        }

        setPatchComponent(i, action, channel, value);
        return;
      }

      if (action === 'edgeF') {
        const a = Number(element.dataset.i);
        const b = Number(element.dataset.j);
        const value = Number(element.value);

        if (!Number.isFinite(value) || value < 0 || value > 1) {
          setStatus('F 须在 [0, 1] 内', 'bad');
          const index = app.linkIndex.get(a * app.patches.length + b);
          element.value = index === undefined ? 0 : app.links[index][2];
          return;
        }

        setLink(a, b, value, true);
      }
    });

    aside.addEventListener('click', (event) => {
      const deleteButton = event.target.closest ?
        event.target.closest('[data-act="edgeDel"]') : null;
      if (!deleteButton) return;

      const a = Number(deleteButton.dataset.i);
      const b = Number(deleteButton.dataset.j);
      setLink(a, b, null, true);
    });
  }

  // 供自动化测试和控制台检查；不影响普通页面使用。
  app.undo = undo;
  app.importData = importData;
  app.buildExportPayload = buildExportPayload;
  app.patchAt = patchAt;

  bindEvents();
  renderAll();
  loadSample();
})();
