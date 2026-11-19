/* 小队流场寻路调试台 —— 界面与渲染。依赖 src/flow.js 暴露的 FlowField。 */
'use strict';

(function () {
  const F = window.FlowField;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const CASES = [
    { id: 'doorway', name: '门口拥堵（doorway）', desc: '20 个单位、多个门口与泥地' },
    { id: 'slit', name: '窄缝（slit）', desc: '尺寸 2 无法通过 1 格窄缝' },
    { id: 'multi-goal', name: '多目标（multi-goal）', desc: '目标合并为单一积分场' },
    { id: 'corridor-mud', name: '泥地走廊（corridor-mud）', desc: '步进代价 ×3 的最小样例' },
    { id: 'big-256', name: '大图 256×256', desc: '压力测试与增量重算' },
    { id: 'invalid', name: '非法地图（invalid）', desc: '演示输入校验' },
  ];

  const SIZE_COLOR_LIGHT = { 1: '#2a78d6', 2: '#eb6834', 3: '#1baf7a' };
  const SIZE_COLOR_DARK = { 1: '#3987e5', 2: '#d95926', 3: '#199e70' };
  const RAMP_LIGHT = ['#eef4fd', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const RAMP_DARK = ['#182430', '#122b46', '#17395e', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#a8cbf5'];

  const state = {
    engine: null,
    size: 1,
    zoom: 1,
    layers: { cost: true, integration: true, arrows: true, passable: false, units: true, goals: true, affected: false, numbers: false },
    affected: null,
    editMode: false,
    editChar: '#',
    cursor: 0,
    playing: false,
    timer: null,
    speed: 120,
    selected: null,
    hovered: null,
    lastRecompute: null,
    verify: null,
    caseName: '',
    dirtySim: false,
  };

  const canvas = $('#mapCanvas');
  const ctx = canvas.getContext('2d');

  /* ---------------- 主题 ---------------- */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() { return darkQuery.matches; }
  function sizeColor(k) { return (isDark() ? SIZE_COLOR_DARK : SIZE_COLOR_LIGHT)[k]; }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------------- 颜色工具 ---------------- */
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    const r = Math.round(A[0] + (B[0] - A[0]) * t);
    const g = Math.round(A[1] + (B[1] - A[1]) * t);
    const bl = Math.round(A[2] + (B[2] - A[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }
  function rampColor(t, ramp) {
    const x = Math.max(0, Math.min(1, t));
    const pos = x * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(pos));
    return mix(ramp[i], ramp[i + 1], pos - i);
  }
  function ramp() { return isDark() ? RAMP_DARK : RAMP_LIGHT; }

  /* ---------------- 引擎装载 ---------------- */
  function setBanner(message, kind) {
    const el = $('#banner');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'banner' + (kind ? ' ' + kind : '');
    el.innerHTML = message;
  }

  function loadEngine(input, caseName) {
    stopPlaying();
    let engine;
    try {
      engine = F.createEngine(input);
    } catch (err) {
      setBanner('<strong>地图不合法：</strong>' + escapeHtml(err.message), '');
      return false;
    }
    state.engine = engine;
    state.caseName = caseName || '自定义地图';
    state.cursor = 0;
    state.selected = null;
    state.verify = null;
    state.lastRecompute = null;
    state.dirtySim = false;

    const m = engine.map;
    const notes = [];
    if (engine.warnings.length) {
      notes.push('<strong>初始状态提示：</strong>' + engine.warnings.map(escapeHtml).join('；'));
    }
    if (notes.length) setBanner(notes.join('<br>'), 'warn');
    else setBanner('');

    $('#subtitle').textContent =
      `${state.caseName} · ${m.width}×${m.height} · ${engine.initialUnits.length} 个单位`;

    // 保证至少一个尺寸有可达锚点，否则自动切到可行的尺寸
    if (!hasReachable(engine, state.size)) {
      const alt = [1, 2, 3].find(k => hasReachable(engine, k));
      if (alt) state.size = alt;
    }
    syncSizeButtons();
    resetView();
    renderAll();
    return true;
  }

  function hasReachable(engine, k) {
    const f = engine.fields[k];
    for (let i = 0; i < f.integration.length; i++) if (f.integration[i] >= 0) return true;
    return false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 视图尺寸 ---------------- */
  function cellSize() {
    if (!state.engine) return 16;
    const m = state.engine.map;
    const scroll = $('#canvasScroll');
    const avail = Math.max(280, scroll.clientWidth - 26);
    const availH = Math.max(240, Math.min(window.innerHeight * 0.68, 720));
    const fit = Math.min(avail / m.width, availH / m.height);
    const base = Math.max(4, Math.min(42, Math.floor(fit)));
    return Math.max(3, Math.round(base * state.zoom));
  }

  function resetView() { state.zoom = 1; }

  function layoutCanvas() {
    if (!state.engine) return;
    const m = state.engine.map;
    const cell = cellSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = (m.width * cell) + 'px';
    canvas.style.height = (m.height * cell) + 'px';
    canvas.width = Math.round(m.width * cell * dpr);
    canvas.height = Math.round(m.height * cell * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return cell;
  }

  /* ---------------- 渲染 ---------------- */
  function currentFrameSnapshot() {
    const sim = state.engine && state.engine.sim;
    if (!sim) return null;
    const f = sim.frames[Math.min(state.cursor, sim.frames.length - 1)];
    return f || null;
  }

  function reachableRange(field) {
    let max = 0;
    for (let i = 0; i < field.integration.length; i++) {
      const v = field.integration[i];
      if (v > max) max = v;
    }
    return max;
  }

  function renderAll() {
    if (!state.engine) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      $('#arrivalTable').innerHTML = '';
      $('#inspector').className = 'inspector empty';
      $('#inspector').textContent = '点击地图上的格子查看数值';
      $('#frameSlider').max = 0;
      $('#frameNow').textContent = '0';
      $('#frameMax').textContent = '0';
      return;
    }
    const cell = layoutCanvas();
    renderMap(cell);
    renderLegend();
    renderInspector();
    renderTransport();
    renderArrivalTable();
    renderRecompute();
  }

  function renderMap(cell) {
    const eng = state.engine;
    const m = eng.map;
    const k = state.size;
    const field = eng.fields[k];
    const W = m.width, H = m.height;
    const surface = cssVar('--bg-elev') || '#ffffff';
    // 墙：明暗两种模式下都要与画布底色有明显区分
    const wallColor = isDark() ? '#2c3542' : '#2f3743';
    const L = state.layers;

    ctx.clearRect(0, 0, W * cell, H * cell);
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, W * cell, H * cell);

    const maxInteg = L.integration ? reachableRange(field) : 0;

    // 逐格绘制
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = m.grid[y][x];
        const px = x * cell, py = y * cell;
        if (ch === '#') {
          ctx.fillStyle = wallColor;
          ctx.fillRect(px, py, cell, cell);
          if (cell >= 6) {
            ctx.fillStyle = isDark() ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.10)';
            ctx.fillRect(px, py, cell, Math.max(1, cell * 0.16));
          }
          continue;
        }
        // 底色
        let base = surface;
        if (L.cost && ch === ',') base = mix(surface, isDark() ? '#6b4a22' : '#c79a5c', 0.55);
        else if (ch === ',') base = surface;
        ctx.fillStyle = base;
        ctx.fillRect(px, py, cell, cell);

        // 积分热力（仅该尺寸的锚点；尺寸>1 时锚点左上角对齐该格）
        if (L.integration && x <= field.W - 1 && y <= field.H - 1) {
          const i = y * field.W + x;
          if (field.pass[i]) {
            const v = field.integration[i];
            if (v >= 0) {
              const t = maxInteg > 0 ? v / maxInteg : 0;
              ctx.fillStyle = rampColor(t, ramp());
              ctx.fillRect(px, py, cell, cell);
            } else {
              ctx.fillStyle = isDark() ? 'rgba(120,132,150,.42)' : 'rgba(150,160,175,.45)';
              ctx.fillRect(px, py, cell, cell);
            }
          }
        }

        // 泥地纹理：叠在积分热力之上，保证高代价地块始终可辨认
        if (L.cost && ch === ',' && L.integration && cell >= 6) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(px, py, cell, cell);
          ctx.clip();
          ctx.strokeStyle = isDark() ? 'rgba(226,166,88,.62)' : 'rgba(138,84,18,.55)';
          ctx.lineWidth = Math.max(1, cell / 26);
          const step = Math.max(3, cell / 2.8);
          for (let d = -cell; d < cell * 2; d += step) {
            ctx.beginPath();
            ctx.moveTo(px + d, py + cell);
            ctx.lineTo(px + d + cell, py);
            ctx.stroke();
          }
          ctx.restore();
        }

        // 锚点范围外（尺寸 k 的 k×k 块放不下）：始终用斜纹标出
        if (x > field.W - 1 || y > field.H - 1) {
          ctx.fillStyle = isDark() ? 'rgba(5,8,12,.55)' : 'rgba(40,50,65,.10)';
          ctx.fillRect(px, py, cell, cell);
          if (cell >= 7) {
            hatch(px, py, cell, isDark() ? 'rgba(255,255,255,.10)' : 'rgba(30,40,60,.13)');
          }
        } else if (L.passable && !field.pass[y * field.W + x]) {
          // 不可通行锚点遮罩
          ctx.fillStyle = isDark() ? 'rgba(5,8,12,.62)' : 'rgba(40,50,65,.20)';
          ctx.fillRect(px, py, cell, cell);
          if (cell >= 8) hatch(px, py, cell, isDark() ? 'rgba(255,90,90,.16)' : 'rgba(150,30,30,.16)');
        }

        // 网格线
        if (cell >= 7) {
          ctx.strokeStyle = isDark() ? 'rgba(255,255,255,.045)' : 'rgba(20,30,50,.07)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
        }
      }
    }

    // 尺寸>1：锚点值代表的 k×k 占块用淡色铺满，便于看清“一块”而非一格
    if (k > 1 && L.integration) {
      for (let y = 0; y < field.H; y++) {
        for (let x = 0; x < field.W; x++) {
          const i = y * field.W + x;
          if (!field.pass[i] || field.integration[i] < 0) continue;
          const t = maxInteg > 0 ? field.integration[i] / maxInteg : 0;
          ctx.save();
          ctx.globalAlpha = 0.30;
          ctx.fillStyle = rampColor(t, ramp());
          for (let dy = 0; dy < k; dy++) {
            for (let dx = 0; dx < k; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (m.grid[y + dy][x + dx] === '#') continue;
              ctx.fillRect((x + dx) * cell, (y + dy) * cell, cell, cell);
            }
          }
          ctx.restore();
        }
      }
    }

    // 目标格
    if (L.goals) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (m.grid[y][x] !== 'G') continue;
          ctx.fillStyle = isDark() ? 'rgba(62,207,142,.22)' : 'rgba(18,136,90,.16)';
          ctx.fillRect(x * cell, y * cell, cell, cell);
          if (cell >= 9) {
            ctx.strokeStyle = cssVar('--goal') || '#39c88a';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
          }
        }
      }
      // 该尺寸的目标锚点（k×k 覆盖至少一个 G）：用淡色铺出锚点块，避免大量虚线重叠
      if (cell >= 5) {
        const goalInk = cssVar('--goal') || '#39c88a';
        ctx.save();
        for (let y = 0; y < field.H; y++) {
          for (let x = 0; x < field.W; x++) {
            if (!field.goal[y * field.W + x]) continue;
            if (field.size === 1) {
              ctx.strokeStyle = goalInk;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
            } else {
              ctx.globalAlpha = 0.10;
              ctx.fillStyle = goalInk;
              ctx.fillRect(x * cell, y * cell, field.size * cell, field.size * cell);
            }
          }
        }
        // k>1 时，只为“左上角锚点”画一条外框会割裂区域，这里改为给整个目标锚点集合画外缘
        if (field.size > 1) {
          const inGoal = field.goal;
          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = goalInk;
          ctx.lineWidth = 1.5;
          const W2 = field.W;
          const edge = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
          for (let y = 0; y < field.H; y++) {
            for (let x = 0; x < field.W; x++) {
              if (!inGoal[y * W2 + x]) continue;
              const x0 = x * cell, y0 = y * cell, s2 = field.size * cell;
              if (x === 0 || !inGoal[y * W2 + x - 1]) edge(x0, y0, x0, y0 + s2);
              if (x === field.W - 1 || !inGoal[y * W2 + x + 1]) edge(x0 + s2, y0, x0 + s2, y0 + s2);
              if (y === 0 || !inGoal[(y - 1) * W2 + x]) edge(x0, y0, x0 + s2, y0);
              if (y === field.H - 1 || !inGoal[(y + 1) * W2 + x]) edge(x0, y0 + s2, x0 + s2, y0 + s2);
            }
          }
        }
        ctx.restore();
      }
    }

    // 代价：单格代价数字（代价层开启且格子够大时）
    if (L.cost && cell >= 24) drawCellCosts(cell);

    // 数值：积分值（锚点格）；开启“数值”层时一并显示单格代价
    if (L.numbers && cell >= 14) drawNumbers(field, cell);

    // 方向箭头
    if (L.arrows && cell >= 6) drawArrows(field, cell);

    // 受影响区域（上一次地形改动时该尺寸重算过的锚点）
    if (L.affected && state.affected && state.affected[k]) drawAffected(k, field, cell);

    // 单位
    if (L.units) drawUnits(cell);

    // 光标 / 选中
    const selected = state.selected;
    const hovered = state.hovered;
    if (selected && selected.x < W && selected.y < H) {
      ctx.strokeStyle = cssVar('--accent') || '#5aa9ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(selected.x * cell + 1, selected.y * cell + 1, cell - 2, cell - 2);
    }
    // 悬停：标出尺寸 k 的 k×k 占块
    if (hovered && hovered.x < W && hovered.y < H) {
      ctx.strokeStyle = cssVar('--accent') || '#5aa9ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(hovered.x * cell + 1, hovered.y * cell + 1, k * cell - 2, k * cell - 2);
      ctx.setLineDash([]);
    }
  }

  function hatch(px, py, cell, color) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, cell, cell);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    const step = Math.max(4, cell / 2);
    for (let d = -cell; d < cell * 2; d += step) {
      ctx.beginPath();
      ctx.moveTo(px + d, py);
      ctx.lineTo(px + d + cell, py + cell);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 在格子上写数值：锚点格写积分值，左上角小字写单格代价。 */
  function drawNumbers(field, cell) {
    const eng = state.engine;
    const m = eng.map;
    const ink = isDark() ? 'rgba(240,246,255,.95)' : 'rgba(12,20,32,.92)';
    const halo = isDark() ? 'rgba(8,12,18,.85)' : 'rgba(255,255,255,.88)';
    const fs = Math.max(8, Math.min(12, cell * 0.3));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.font = `600 ${fs}px ui-monospace, monospace`;
    ctx.lineWidth = Math.max(2, fs / 4);
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    for (let y = 0; y < field.H; y++) {
      for (let x = 0; x < field.W; x++) {
        const i = y * field.W + x;
        if (!field.pass[i]) continue;
        const v = field.integration[i];
        if (v < 0) continue;
        // 放在锚点块的右下角，避开居中的方向箭头
        const cx = (x + field.size) * cell - 2;
        const cy = (y + field.size) * cell - 1;
        const text = String(v);
        ctx.strokeText(text, cx, cy);
        ctx.fillStyle = ink;
        ctx.fillText(text, cx, cy);
      }
    }
    drawCellCosts(cell, true);
    void m;
  }

  /** 单格代价（1 平地/目标，3 泥地），画在格子左上角。 */
  function drawCellCosts(cell, strong) {
    const m = state.engine.map;
    const cs = Math.max(8, Math.min(11, cell * 0.28));
    const halo = isDark() ? 'rgba(8,12,18,.8)' : 'rgba(255,255,255,.85)';
    ctx.font = `600 ${cs}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, cs / 4);
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const ch = m.grid[y][x];
        if (ch === '#') continue;
        const c = F.COST[ch];
        if (c === undefined) continue;
        const text = String(c);
        ctx.strokeText(text, x * cell + 2, y * cell + 1);
        ctx.fillStyle = ch === ','
          ? (isDark() ? 'rgba(240,190,120,.95)' : 'rgba(120,72,12,.95)')
          : (strong ? (isDark() ? 'rgba(215,226,240,.9)' : 'rgba(45,60,80,.9)') : (isDark() ? 'rgba(205,216,230,.62)' : 'rgba(60,75,95,.6)'));
        ctx.fillText(text, x * cell + 2, y * cell + 1);
      }
    }
  }

  function drawArrows(field, cell) {
    const eng = state.engine;
    const compact = state.layers.numbers;
    const m = eng.map;
    const ink = isDark() ? 'rgba(232,238,247,.82)' : 'rgba(18,26,40,.78)';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = Math.max(1, cell / (compact ? 20 : 14));
    const len = cell * (compact ? 0.24 : 0.34);
    const head = Math.max(2, cell * (compact ? 0.15 : 0.2));
    for (let y = 0; y < field.H; y++) {
      for (let x = 0; x < field.W; x++) {
        const d = field.direction[y * field.W + x];
        if (d < 0) continue;
        const dir = F.DIRS[d];
        const cx = x * cell + cell / 2, cy = y * cell + cell / 2;
        // 尺寸 >1 时锚点覆盖 k×k，箭头画在锚点块中心
        const ox = field.size > 1 ? (field.size - 1) * cell / 2 : 0;
        const sx = cx + ox, sy = cy + ox;
        const ex = sx + dir.dx * len, ey = sy + dir.dy * len;
        ctx.beginPath();
        ctx.moveTo(sx - dir.dx * len * 0.7, sy - dir.dy * len * 0.7);
        ctx.lineTo(ex + dir.dx * len * 0.3, ey + dir.dy * len * 0.3);
        ctx.stroke();
        const nx = -dir.dy, ny = dir.dx;
        const tipX = ex + dir.dx * len * 0.55;
        const tipY = ey + dir.dy * len * 0.55;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - dir.dx * head + nx * head * 0.62, tipY - dir.dy * head + ny * head * 0.62);
        ctx.lineTo(tipX - dir.dx * head - nx * head * 0.62, tipY - dir.dy * head - ny * head * 0.62);
        ctx.closePath();
        ctx.fill();
      }
    }
    void m;
  }

  /** 受影响锚点：半透明填色 + 外框；额外被降低的锚点再叠一个小方点。 */
  function drawAffected(k, field, cell) {
    const info = state.affected[k];
    if (!info) return;
    const color = sizeColor(k);
    ctx.save();
    ctx.globalAlpha = isDark() ? 0.24 : 0.16;
    ctx.fillStyle = color;
    for (const idx of info.affected) {
      if (!field.pass[idx]) continue;
      const x = idx % field.W, y = (idx / field.W) | 0;
      ctx.fillRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
    }
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cell / 26);
    // 只画区域外缘，避免网格线过密
    const inSet = info.affectedSet || (info.affectedSet = new Set(info.affected));
    for (const idx of info.affected) {
      const x = idx % field.W, y = (idx / field.W) | 0;
      if (!inSet.has(y * field.W + x - 1) || x === 0) edgeLine(x * cell, y * cell, x * cell, (y + 1) * cell);
      if (x === field.W - 1 || !inSet.has(y * field.W + x + 1)) edgeLine((x + 1) * cell, y * cell, (x + 1) * cell, (y + 1) * cell);
      if (y === 0 || !inSet.has((y - 1) * field.W + x)) edgeLine(x * cell, y * cell, (x + 1) * cell, y * cell);
      if (y === field.H - 1 || !inSet.has((y + 1) * field.W + x)) edgeLine(x * cell, (y + 1) * cell, (x + 1) * cell, (y + 1) * cell);
    }
    ctx.fillStyle = color;
    for (const idx of (info.improvedList || [])) {
      const x = idx % field.W, y = (idx / field.W) | 0;
      ctx.fillRect(x * cell + cell * 0.36, y * cell + cell * 0.36, cell * 0.28, cell * 0.28);
    }
    ctx.restore();
  }

  function edgeLine(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawUnits(cell) {
    const snap = currentFrameSnapshot();
    if (!snap) return;
    const surface = cssVar('--bg-elev') || '#ffffff';
    for (const u of snap.units) {
      const color = sizeColor(u.size);
      const x = u.x * cell, y = u.y * cell, s = u.size * cell;
      ctx.fillStyle = mix(color, surface, 0.72);
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, cell / 12);
      ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
      if (cell >= 13) {
        const label = String(u.id);
        ctx.font = `600 ${Math.min(Math.max(9, cell * 0.42), 15)}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cx = x + s / 2, cy = y + s / 2;
        ctx.fillStyle = isDark() ? '#eef4fb' : '#101823';
        ctx.fillText(label, cx, cy + 0.5);
      }
    }
  }

  /* ---------------- 图例 ---------------- */
  function renderLegend() {
    const eng = state.engine;
    const k = state.size;
    const field = eng.fields[k];
    const el = $('#legend');
    const parts = [];
    parts.push(`<span class="key"><span class="dot" style="background:${cssVar('--wall')}"></span>墙</span>`);
    parts.push(`<span class="key"><span class="dot" style="background:repeating-linear-gradient(45deg,${isDark() ? 'rgba(214,150,74,.8)' : 'rgba(150,96,26,.6)'} 0 1px,${cssVar('--bg-elev')} 1px 3px)"></span>泥地 代价 3（斜纹）</span>`);
    parts.push(`<span class="key"><span class="dot" style="background:${cssVar('--bg-elev')}"></span>平地 代价 1</span>`);
    parts.push(`<span class="key"><span class="dot" style="background:${ramp()[0]}"></span><span class="grad" style="background:linear-gradient(90deg,${ramp().join(',')})"></span><span class="dot" style="background:${ramp()[ramp().length - 1]}"></span>积分值 0 → ${reachableRange(field)}</span>`);
    parts.push(`<span class="key"><span class="dot" style="background:${isDark() ? 'rgba(120,132,150,.42)' : 'rgba(150,160,175,.45)'}"></span>可通行但不可达</span>`);
    if (k > 1) parts.push(`<span class="key"><span class="dot" style="background:transparent;background-image:repeating-linear-gradient(45deg,${cssVar('--text-faint')} 0 1px,transparent 1px 3px)"></span>锚点范围外（${k}×${k} 放不下）</span>`);
    for (const kk of [1, 2, 3]) {
      parts.push(`<span class="key"><span class="dot" style="background:${sizeColor(kk)}"></span>尺寸 ${kk} 单位</span>`);
    }
    if (!hasReachable(eng, k)) {
      parts.push(`<span class="key" style="color:var(--bad)">该尺寸共 ${field.W * field.H} 个锚点，全部不可达（没有目标锚点或全被挡住）</span>`);
    }
    if (state.layers.affected && state.affected && state.affected[k]) {
      const n = state.affected[k].affected.length;
      parts.push(`<span class="key"><span class="dot" style="background:${sizeColor(k)};opacity:.55"></span>受影响锚点 ${n} 个（上次改动，尺寸 ${k}）</span>`);
    }
    const goalCount = countGoals(field);
    parts.push(`<span class="key">目标锚点 ${goalCount} 个（合并为同一积分场）</span>`);
    el.innerHTML = parts.join('');
  }

  function countGoals(field) {
    let n = 0;
    for (let i = 0; i < field.goal.length; i++) n += field.goal[i];
    return n;
  }

  /* ---------------- 详情面板 ---------------- */
  function renderInspector() {
    const el = $('#inspector');
    const sel = state.selected;
    if (!state.engine || !sel) {
      el.className = 'inspector empty';
      el.textContent = '点击地图上的格子查看数值';
      return;
    }
    const eng = state.engine;
    const m = eng.map;
    const { x, y } = sel;
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) {
      el.className = 'inspector empty';
      el.textContent = '点击地图上的格子查看数值';
      return;
    }
    const ch = m.grid[y][x];
    const chName = { '.': '平地', ',': '泥地', '#': '墙', G: '目标格' }[ch] || ch;
    const cost = ch === '#' ? '—' : (F.COST[ch] ?? '—');

    const rows = [];
    for (const k of [1, 2, 3]) {
      const f = eng.fields[k];
      const inRange = x <= f.W - 1 && y <= f.H - 1;
      if (!inRange) {
        rows.push(`<div class="size-row${k === state.size ? ' cur' : ''}"><span><b style="color:${sizeColor(k)}">尺寸 ${k}</b></span><span class="dim">超出锚点范围</span><span class="n">—</span><span class="n">—</span></div>`);
        continue;
      }
      const i = y * f.W + x;
      const passable = f.pass[i] === 1;
      const v = f.integration[i];
      const dir = f.direction[i];
      const anchorCost = passable ? f.cost[i] : null;
      rows.push(
        `<div class="size-row${k === state.size ? ' cur' : ''}">` +
        `<span><b style="color:${sizeColor(k)}">尺寸 ${k}</b></span>` +
        `<span class="dim">${passable ? (f.goal[i] ? '目标锚点' : '可通行') : '不可通行'}${anchorCost !== null ? ' · 代价 ' + anchorCost : ''}</span>` +
        `<span class="n">${passable ? (v >= 0 ? v : '不可达') : '—'}</span>` +
        `<span class="n">${dir >= 0 ? F.DIRS[dir].name : (f.goal[i] ? '目标' : '—')}</span>` +
        `</div>`
      );
    }

    // 该格被哪些单位占块覆盖
    const snap = currentFrameSnapshot();
    const covering = snap ? snap.units.filter(u =>
      x >= u.x && x < u.x + u.size && y >= u.y && y < u.y + u.size) : [];

    const covered = covering.map(u => {
      const f = eng.fields[u.size];
      const i = u.y * f.W + u.x;
      const dir = f.direction[i];
      const arr = arrivalFrameOf(u.id);
      return `<div class="unit-card">
        <span class="uc-title"><span class="dot" style="background:${sizeColor(u.size)}"></span>单位 id=${u.id} · 尺寸 ${u.size}</span>
        <span class="uc-line">锚点 (${u.x}, ${u.y}) · 积分 ${f.integration[i] >= 0 ? f.integration[i] : '不可达'} · 方向 ${dir >= 0 ? F.DIRS[dir].name : (f.goal[i] ? '目标' : '—')}</span>
        <span class="uc-line">${arr !== null ? '到达帧 ' + arr : (u.blocked ? '被堵死' : (u.unreachable === false ? '未到达' : ''))}</span>
      </div>`;
    }).join('');

    el.className = 'inspector';
    el.innerHTML =
      `<div><span class="coord">(${x}, ${y})</span> · ${escapeHtml(chName)}（字符 “${escapeHtml(ch)}”） · 单格代价 ${cost}</div>` +
      `<div class="sizes">` +
      `<div class="size-row head"><span>尺寸</span><span>锚点状态</span><span class="n">积分值</span><span class="n">方向</span></div>` +
      rows.join('') +
      `</div>` +
      (covered ? `<div class="units-here">${covered}</div>` : '');
  }

  function arrivalFrameOf(id) {
    const sim = state.engine.sim;
    const a = sim.arrivals.find(r => r.id === id);
    return a ? a.frame : null;
  }

  /* ---------------- 传送控制 ---------------- */
  function renderTransport() {
    const sim = state.engine.sim;
    const last = sim.frames.length - 1;
    state.cursor = Math.max(0, Math.min(state.cursor, last));
    const slider = $('#frameSlider');
    slider.max = String(last);
    slider.value = String(state.cursor);
    $('#frameNow').textContent = String(sim.frames[state.cursor] ? sim.frames[state.cursor].frame : 0);
    $('#frameMax').textContent = String(sim.frames[last] ? sim.frames[last].frame : 0);

    const st = $('#simState');
    if (sim.deadlock) { st.textContent = '存在被堵死单位'; st.className = 'state stuck'; }
    else if (sim.finished) { st.textContent = '已结束'; st.className = 'state done'; }
    else if (state.playing) { st.textContent = '播放中'; st.className = 'state running'; }
    else if (state.cursor < last) { st.textContent = '回看历史'; st.className = 'state'; }
    else { st.textContent = '就绪'; st.className = 'state'; }

    const active = currentFrameSnapshot();
    const activeCount = active ? active.units.length : 0;
    const unitTotal = state.engine.initialUnits.length;
    const shownFrame = active ? active.frame : 0;
    // 统计跟随当前回看帧，而不是整个模拟的最终结果
    const arrived = sim.arrivals.filter(a => a.frame <= shownFrame).length;
    const unreach = sim.unreachableIds.length;
    const blocked = sim.blockedIds.filter(id => {
      const f = sim.blockedFrames ? sim.blockedFrames[id] : undefined;
      if (f === undefined) return sim.finished;
      return f <= shownFrame;
    }).length;

    const rows = [
      ['地图', `${state.engine.map.width} × ${state.engine.map.height}`],
      ['单位总数', unitTotal],
      ['当前在场', activeCount],
      ['已到达', arrived],
      ['不可达', unreach],
      ['被堵死', blocked],
    ];
    $('#simSummary').innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('');

    const done = sim.arrivals.length + sim.unreachableIds.length + sim.blockedIds.length;
    const finished = sim.finished;
    const tip = state.cursor >= last;
    $('#btnStep').disabled = finished && tip;
    $('#btnRun').textContent = state.playing ? '暂停播放' : '连续播放';
    $('#btnRunAll').disabled = finished;
    void done;
    renderEventLog();
  }

  function renderEventLog() {
    const sim = state.engine.sim;
    const shown = sim.frames[state.cursor] ? sim.frames[state.cursor].frame : 0;
    const evs = (sim.events || []).filter(e => e.frame <= shown);
    const recent = evs.slice(-40).reverse();
    const el = $('#eventLog');
    const count = $('#eventCount');
    if (count) count.textContent = evs.length ? `（${evs.length}）` : '';
    if (!recent.length) {
      el.innerHTML = '<li class="empty">暂无事件。播放或“跑到结束”后显示到达、退让与堵塞原因。</li>';
      return;
    }
    el.innerHTML = recent.map(e =>
      `<li class="${e.kind}"><span class="f">帧 ${e.frame}</span><span>${escapeHtml(e.text)}</span></li>`
    ).join('');
  }

  /* ---------------- 到达统计 ---------------- */
  function renderArrivalTable() {
    const eng = state.engine;
    const sim = eng.sim;
    const shownFrame = sim.frames[state.cursor] ? sim.frames[state.cursor].frame : 0;
    const rows = [];
    const all = eng.initialUnits.slice().sort((a, b) => a.id - b.id);
    for (const u of all) {
      const arrived = sim.arrivals.find(a => a.id === u.id);
      let status, cls;
      if (arrived) {
        if (arrived.frame <= shownFrame) { status = `第 ${arrived.frame} 帧到达`; cls = 'ok'; }
        else { status = '行进中'; cls = ''; }
      } else if (sim.unreachableIds.includes(u.id)) {
        status = '不可达'; cls = 'bad';
      } else if (sim.blockedIds.includes(u.id)) {
        status = '被堵死'; cls = 'warn';
      } else {
        status = '行进中'; cls = '';
      }
      rows.push(
        `<tr><td>#${u.id}</td><td class="mono">${u.size}</td>` +
        `<td class="mono">${u.x},${u.y}</td>` +
        `<td><span class="pill ${cls}">${status}</span></td></tr>`
      );
    }
    const empty = all.length === 0
      ? '<tr><td colspan="4" class="dim" style="text-align:left">该地图没有单位（可用“导入 JSON”加载带 units 的地图）</td></tr>'
      : '';
    $('#arrivalTable').innerHTML =
      `<table class="arr"><thead><tr><th>单位</th><th>尺寸</th><th>起点</th><th>状态</th></tr></thead><tbody>${empty}${rows.join('')}</tbody></table>`;
  }

  /* ---------------- 重算信息 ---------------- */
  function renderRecompute() {
    const el = $('#recomputeInfo');
    const r = state.lastRecompute;
    if (!r) {
      el.innerHTML = '<span class="dim">改动地形后显示受影响区域与耗时</span>';
      $('#verifyResult').innerHTML = '';
      return;
    }
    if (r.changed === 0) {
      el.innerHTML = '<span class="dim">没有实际改动</span>';
    } else {
      const rows = [1, 2, 3].map(k => {
        const p = r.perSize[k];
        return `<div class="row"><span>尺寸 ${k}</span><span>失效 ${p.invalidated} 锚点 · 改写 ${p.changedValues}</span></div>`;
      }).join('');
      el.innerHTML =
        `<div class="row"><span>改动格数</span><span>${r.changed}</span></div>` +
        rows +
        `<div class="row"><span>增量耗时</span><span>${r.ms.toFixed(2)} ms</span></div>` +
        (r.fullMs !== undefined ? `<div class="row"><span>全量耗时</span><span>${r.fullMs.toFixed(2)} ms</span></div>` : '');
    }

    const v = state.verify;
    const box = $('#verifyResult');
    if (!v) { box.innerHTML = ''; return; }
    const rows = [1, 2, 3].map(k => {
      const x = v[k];
      return `<div class="row"><span>尺寸 ${k}</span><span class="${x.identical ? 'ok' : 'bad'}">${x.identical ? '与全量一致' : `值差 ${x.valueDiffs} · 方向差 ${x.directionDiffs}`}</span></div>`;
    }).join('');
    box.innerHTML = `<div class="row"><span>增量 vs 全量</span><span></span></div>` + rows;
  }

  /* ---------------- 地形编辑 ---------------- */
  function applyEdit(x, y, ch) {
    const eng = state.engine;
    if (!eng) return;
    if (x < 0 || y < 0 || x >= eng.map.width || y >= eng.map.height) return;
    if (eng.map.grid[y][x] === ch) return;

    // 不允许把墙画到某个单位当前占块下（会让该单位卡在墙里）
    if (ch === '#') {
      for (const u of eng.initialUnits) {
        if (x >= u.x && x < u.x + u.size && y >= u.y && y < u.y + u.size) {
          setBanner(`<strong>不能改成墙：</strong>该格被单位 id=${u.id}（尺寸 ${u.size}）的起始占块覆盖。`, 'warn');
          return;
        }
      }
    }

    let res;
    try {
      res = F.applyTerrainEdits(eng, [{ x, y, ch }]);
    } catch (err) {
      setBanner('<strong>改地形失败：</strong>' + escapeHtml(err.message), '');
      return;
    }
    if (!res.changed) return;

    // 地形变化会使既有轨迹失效
    stopPlaying();
    F.resetSim(eng);
    state.cursor = 0;
    state.dirtySim = true;

    let fullMs;
    if ($('#verifyToggle').checked) {
      const t0 = performance.now();
      state.verify = F.verifyIncremental(eng);
      fullMs = performance.now() - t0;
    } else {
      state.verify = null;
    }
    res.fullMs = fullMs;
    state.lastRecompute = res;
    const aff = {};
    for (const kk of [1, 2, 3]) {
      const list = res.perSize[kk].affected || [];
      aff[kk] = { affected: list, affectedSet: new Set(list), improvedList: res.perSize[kk].improvedList || [] };
    }
    state.affected = aff;
    if (state.layers.affected !== true) {
      // 改动后自动打开“受影响区”便于观察；再次改动保持用户选择
      state.layers.affected = true;
      const chip = document.querySelector('.chip[data-layer="affected"]');
      if (chip) chip.classList.add('active');
    }

    const allSame = state.verify && [1, 2, 3].every(k => state.verify[k].identical);
    if (state.verify && !allSame) {
      setBanner('<strong>警告：</strong>增量重算与全量重算不一致，请反馈该地图与改动坐标。', '');
    } else if (state.verify) {
      setBanner('地形已更新，增量重算与全量重算逐位一致。', 'ok');
    } else {
      setBanner('');
    }
    renderAll();
  }

  /* ---------------- 模拟控制 ---------------- */
  function stepForward() {
    const eng = state.engine;
    if (!eng) return;
    const sim = eng.sim;
    const last = sim.frames.length - 1;
    if (state.cursor < last) {
      state.cursor++;
    } else if (!sim.finished) {
      F.stepSim(eng);
      state.cursor = eng.sim.frames.length - 1;
    }
    renderTransport();
    renderMap(cellSize());
    renderInspector();
    renderArrivalTable();
  }

  function runAll() {
    const eng = state.engine;
    if (!eng) return;
    const t0 = performance.now();
    F.runSim(eng, 20000);
    state.cursor = eng.sim.frames.length - 1;
    state.lastRunMs = performance.now() - t0;
    renderAll();
  }

  function togglePlay() {
    if (state.playing) { stopPlaying(); return; }
    state.playing = true;
    const tick = () => {
      if (!state.playing) return;
      const eng = state.engine;
      const sim = eng.sim;
      const last = sim.frames.length - 1;
      if (state.cursor < last) state.cursor++;
      else if (!sim.finished) { F.stepSim(eng); state.cursor = eng.sim.frames.length - 1; }
      else { stopPlaying(); return; }
      renderTransport();
      renderMap(cellSize());
      renderInspector();
      renderArrivalTable();
      state.timer = setTimeout(tick, state.speed);
    };
    state.timer = setTimeout(tick, state.speed);
    renderTransport();
  }

  function stopPlaying() {
    state.playing = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.engine) renderTransport();
  }

  function resetSim() {
    stopPlaying();
    if (!state.engine) return;
    F.resetSim(state.engine);
    state.cursor = 0;
    state.dirtySim = false;
    renderAll();
  }

  /* ---------------- 导出 ---------------- */
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportIntegration(k) {
    const data = F.integrationExport(state.engine, k);
    download(`${state.caseName}-integration-size${k}.json`, data);
  }

  function exportTrajectory() {
    const data = F.trajectoryExport(state.engine);
    download(`${state.caseName}-trajectory.json`, data);
  }

  function exportMap() {
    const eng = state.engine;
    const data = { rows: eng.map.rows.slice(), units: eng.initialUnits.map(u => ({ id: u.id, size: u.size, x: u.x, y: u.y })) };
    download(`${state.caseName}-map.json`, data);
  }

  function exportAll() {
    exportIntegration(1);
    setTimeout(() => exportIntegration(2), 120);
    setTimeout(() => exportIntegration(3), 240);
    setTimeout(() => exportTrajectory(), 360);
  }

  /* ---------------- 事件绑定 ---------------- */
  function syncSizeButtons() {
    $$('.seg-btn[data-size]').forEach(b => b.classList.toggle('active', Number(b.dataset.size) === state.size));
  }

  function canvasCellAt(evt) {
    const rect = canvas.getBoundingClientRect();
    const cell = cellSize();
    const x = Math.floor((evt.clientX - rect.left) / cell);
    const y = Math.floor((evt.clientY - rect.top) / cell);
    if (!state.engine) return null;
    if (x < 0 || y < 0 || x >= state.engine.map.width || y >= state.engine.map.height) return null;
    return { x, y };
  }

  function bind() {
    $('#caseSelect').innerHTML = '<option value="">— 选择样例地图 —</option>' +
      CASES.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    $('#caseSelect').addEventListener('change', async (e) => {
      const id = e.target.value;
      if (!id) return;
      try {
        const res = await fetch(`cases/${id}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const meta = CASES.find(c => c.id === id);
        if (loadEngine(data, meta ? meta.name.split('（')[0] : id)) {
          setBanner('');
        }
      } catch (err) {
        setBanner(`<strong>无法加载样例：</strong>${escapeHtml(err.message)}。<br>请通过本地 HTTP 服务打开本页（例如 <code>node tools/serve.js</code>），或使用“导入 JSON…”。`, '');
      }
    });

    $('#btnLoadFile').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          loadEngine(data, file.name.replace(/\.json$/i, ''));
        } catch (err) {
          setBanner('<strong>JSON 解析失败：</strong>' + escapeHtml(err.message), '');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $$('.seg-btn[data-size]').forEach(b => {
      b.addEventListener('click', () => {
        state.size = Number(b.dataset.size);
        syncSizeButtons();
        renderAll();
      });
    });

    $$('.chip[data-layer]').forEach(b => {
      b.addEventListener('click', () => {
        const key = b.dataset.layer;
        state.layers[key] = !state.layers[key];
        b.classList.toggle('active', state.layers[key]);
        renderMap(cellSize());
        renderLegend();
      });
    });

    $('#btnZoomIn').addEventListener('click', () => { state.zoom = Math.min(4, state.zoom * 1.25); renderAll(); });
    $('#btnZoomOut').addEventListener('click', () => { state.zoom = Math.max(0.35, state.zoom / 1.25); renderAll(); });

    $('#btnEditTerrain').addEventListener('click', () => {
      state.editMode = !state.editMode;
      const btn = $('#btnEditTerrain');
      btn.setAttribute('aria-pressed', String(state.editMode));
      $('#editPalette').hidden = !state.editMode;
      canvas.style.cursor = state.editMode ? 'copy' : 'crosshair';
    });
    $$('.swatch').forEach(b => {
      b.addEventListener('click', () => {
        state.editChar = b.dataset.char;
        $$('.swatch').forEach(s => s.classList.toggle('active', s === b));
      });
    });

    let painting = false;
    canvas.addEventListener('mousedown', (e) => {
      if (!state.editMode) return;
      painting = true;
      const cell = canvasCellAt(e);
      if (cell) applyEdit(cell.x, cell.y, state.editChar);
    });
    window.addEventListener('mouseup', () => { painting = false; });
    canvas.addEventListener('click', (e) => {
      if (state.editMode) return; // 编辑由 mousedown/mousemove 处理（单击也算一次 mousedown）
      const cell = canvasCellAt(e);
      if (!cell) return;
      state.selected = cell;
      renderInspector();
      renderMap(cellSize());
    });
    canvas.addEventListener('mousemove', (e) => {
      const cell = canvasCellAt(e);
      if (!cell) return;
      if (state.hovered && state.hovered.x === cell.x && state.hovered.y === cell.y) {
        if (!painting) return;
        applyEdit(cell.x, cell.y, state.editChar);
        return;
      }
      state.hovered = cell;
      if (painting) { applyEdit(cell.x, cell.y, state.editChar); return; }
      renderMap(cellSize());
    });
    canvas.addEventListener('mouseleave', () => {
      state.hovered = null;
      if (state.engine) renderMap(cellSize());
    });

    $('#btnStep').addEventListener('click', stepForward);
    $('#btnRun').addEventListener('click', togglePlay);
    $('#btnRunAll').addEventListener('click', runAll);
    $('#btnReset').addEventListener('click', resetSim);

    $('#frameSlider').addEventListener('input', (e) => {
      state.cursor = Number(e.target.value);
      renderTransport();
      renderMap(cellSize());
      renderInspector();
      renderArrivalTable();
    });

    $('#speedRange').addEventListener('input', (e) => {
      state.speed = Number(e.target.value);
      $('#speedLabel').textContent = state.speed + 'ms';
    });

    $$('[data-export]').forEach(b => {
      b.addEventListener('click', () => {
        if (!state.engine) return;
        const type = b.dataset.export;
        if (type === 'trajectory') exportTrajectory();
        else if (type === 'map') exportMap();
        else exportIntegration(Number(type.split('-')[1]));
      });
    });
    $('#btnExportAll').addEventListener('click', () => { if (state.engine) exportAll(); });

    $('#btnHelp').addEventListener('click', () => $('#helpDialog').showModal());
    $('#btnSelfCheck').addEventListener('click', runSelfCheck);

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stepForward(); }
      else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (state.engine) { state.cursor = Math.max(0, state.cursor - 1); renderTransport(); renderMap(cellSize()); renderInspector(); renderArrivalTable(); }
      } else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    });

    darkQuery.addEventListener('change', () => { if (state.engine) renderAll(); });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.engine) renderAll(); }, 150);
    });
  }

  /* ---------------- 自检 ---------------- */
  async function runSelfCheck() {
    const box = $('#selfCheckResult');
    box.innerHTML = '<span class="dim">自检中…</span>';
    try {
      const refRes = await fetch('cases/reference.json', { cache: 'no-cache' });
      if (!refRes.ok) throw new Error('无法读取 cases/reference.json');
      const ref = await refRes.json();

      const rows = [];
      let bad = 0;

      // 1) 与参考积分场/方向逐项比对
      for (const caseName of ['corridor-mud', 'slit', 'multi-goal']) {
        const res = await fetch(`cases/${caseName}.json`, { cache: 'no-cache' });
        const input = await res.json();
        const engine = F.createEngine(input);
        for (const k of [1, 2, 3]) {
          const got = F.integrationExport(engine, k);
          const want = ref[caseName][String(k)];
          let vd = 0, dd = 0;
          for (let i = 0; i < want.integration.length; i++) {
            if (got.integration[i] !== want.integration[i]) vd++;
            if (got.direction[i] !== want.direction[i]) dd++;
          }
          if (vd || dd) bad++;
          rows.push(`<div class="row"><span>${caseName} · 尺寸 ${k}</span><span class="${vd || dd ? 'bad' : 'ok'}">${vd || dd ? `值差 ${vd} · 方向差 ${dd}` : '一致'}</span></div>`);
        }
      }

      // 2) 每个样例做 8 轮随机地形改动，核对增量 == 全量
      let incBad = 0;
      for (const caseName of ['doorway', 'slit', 'multi-goal', 'corridor-mud']) {
        const res = await fetch(`cases/${caseName}.json`, { cache: 'no-cache' });
        const input = await res.json();
        const engine = F.createEngine(input);
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let round = 0; round < 8; round++) {
          const edits = [];
          for (let e = 0; e < 3; e++) {
            edits.push({
              x: Math.floor(rnd() * engine.map.width),
              y: Math.floor(rnd() * engine.map.height),
              ch: ['#', '.', ',', 'G'][Math.floor(rnd() * 4)],
            });
          }
          F.applyTerrainEdits(engine, edits);
          const v = F.verifyIncremental(engine);
          if (![1, 2, 3].every(k => v[k].identical)) incBad++;
        }
      }
      rows.push(`<div class="row"><span>增量 vs 全量（4 张图 × 8 轮）</span><span class="${incBad ? 'bad' : 'ok'}">${incBad ? incBad + ' 轮不一致' : '全部一致'}</span></div>`);

      // 3) 模拟不变量：不穿墙、不重叠、每帧至多一格
      let simBad = 0;
      for (const caseName of ['doorway', 'slit', 'multi-goal', 'corridor-mud']) {
        const res = await fetch(`cases/${caseName}.json`, { cache: 'no-cache' });
        const input = await res.json();
        const engine = F.createEngine(input);
        const sim = engine.sim;
        const start = sim.units.map(u => ({ id: u.id, x: u.x, y: u.y, size: u.size }));
        const initialOverlap = new Set();
        for (let i = 0; i < start.length; i++) {
          for (let j = i + 1; j < start.length; j++) {
            const a = start[i], b = start[j];
            if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) {
              initialOverlap.add([Math.min(a.id, b.id), Math.max(a.id, b.id)].join('-'));
            }
          }
        }
        let frames = 0;
        while (!sim.finished && frames < 5000) {
          const before = new Map(sim.units.map(u => [u.id, { x: u.x, y: u.y }]));
          F.stepSim(engine);
          frames++;
          for (const u of sim.units) {
            if (F.blockBlocked(engine.map.grid, u.x, u.y, u.size)) simBad++;
            const b = before.get(u.id);
            if (b && (Math.abs(u.x - b.x) > 1 || Math.abs(u.y - b.y) > 1)) simBad++;
          }
          for (let i = 0; i < sim.units.length; i++) {
            for (let j = i + 1; j < sim.units.length; j++) {
              const a = sim.units[i], b = sim.units[j];
              if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size) {
                const key = [Math.min(a.id, b.id), Math.max(a.id, b.id)].join('-');
                if (!initialOverlap.has(key)) simBad++;
              }
            }
          }
        }
        const accounted = sim.arrivals.length + sim.unreachableIds.length + sim.blockedIds.length;
        if (accounted !== engine.initialUnits.length) simBad++;
        rows.push(`<div class="row"><span>${caseName} 模拟</span><span class="${sim.finished ? 'ok' : 'bad'}">${frames} 帧 · 到达 ${sim.arrivals.length} · 不可达 ${sim.unreachableIds.length} · 堵死 ${sim.blockedIds.length}</span></div>`);
      }
      rows.push(`<div class="row"><span>模拟不变量</span><span class="${simBad ? 'bad' : 'ok'}">${simBad ? simBad + ' 处违规' : '无违规'}</span></div>`);

      const allOk = bad === 0 && incBad === 0 && simBad === 0;
      box.innerHTML = `<div class="row"><span>参考数据 & 不变量自检</span><span class="${allOk ? 'ok' : 'bad'}">${allOk ? '全部通过' : '存在失败项'}</span></div>` + rows.join('');
      setBanner(allOk ? '自检通过：参考数据、增量一致性、模拟不变量全部正确。' : '自检存在失败项，详见右侧“增量重算”面板。', allOk ? 'ok' : '');
    } catch (err) {
      box.innerHTML = `<div class="row"><span>自检失败</span><span class="bad">${escapeHtml(err.message)}</span></div>`;
    }
  }

  /* ---------------- 启动 ---------------- */
  bind();
  renderAll();

  // 默认载入门口样例，便于一打开就看到东西（失败时给出手动加载提示）
  (async function boot() {
    try {
      const res = await fetch('cases/doorway.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      loadEngine(data, '门口拥堵');
      $('#caseSelect').value = 'doorway';
    } catch (err) {
      setBanner('未自动载入样例（' + escapeHtml(err.message) + '）。请用本地 HTTP 服务打开本页（<code>node tools/serve.js</code>），或选择样例 / 导入 JSON。', 'warn');
    }
  })();

  // 测试与调试用的钩子
  window.__ff = { state, loadEngine, applyEdit, stepForward, runAll, renderAll };
})();
