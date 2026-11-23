/*
 * app.js — 调试台交互逻辑，依赖全局 CG（geometry/model/dijkstra/funnel/route）
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    raw: null, map: null, query: null, result: null,
    doorOverrides: new Map(), // edgeId -> bool(false=强制关)
    activeFloor: 0, lastResultJson: null,
  };

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- 加载 ----------
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        loadMapData(raw);
        toast(`已加载 ${raw.cells.length} 格 / ${raw.edges.length} 连接`);
      } catch (err) {
        toast('解析失败：' + err.message);
      }
    };
    reader.readAsText(file);
  });

  function loadMapData(raw) {
    state.raw = raw;
    state.map = CG.loadMap(raw);
    state.doorOverrides = new Map();
    $('loadInfo').innerHTML = `${state.map.cellCount} 格 · ${state.map.edgeCount} 连接 · ${state.map.floors.length} 层` +
      (state.map.warnings.length ? `<br><span style="color:var(--warn)">${state.map.warnings.length} 条数据告警</span>` : '');
    $('statCells').textContent = state.map.cellCount;
    $('statEdges').textContent = state.map.edgeCount;
    buildFloorTabs();
    buildFloorSelects();
    buildDoorList();
    if (raw.queries && raw.queries[0]) {
      const q = raw.queries[0];
      $('startFloor').value = q.start.floor; $('startCell').value = q.start.cell;
      $('endFloor').value = q.end.floor; $('endCell').value = q.end.cell;
      if (q.margin != null) $('margin').value = q.margin;
    }
    state.activeFloor = state.map.floors[0];
    $('floorTabs').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.floor) === state.activeFloor));
    autoSolve();
  }

  function buildFloorTabs() {
    const tabs = $('floorTabs');
    tabs.innerHTML = '';
    state.map.floors.forEach((f) => {
      const b = document.createElement('button');
      b.textContent = `${f} 层`; b.dataset.floor = f;
      b.onclick = () => {
        state.activeFloor = f;
        tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        draw();
      };
      tabs.appendChild(b);
    });
  }

  function buildFloorSelects() {
    for (const sel of [$('startFloor'), $('endFloor')]) {
      sel.innerHTML = '';
      state.map.floors.forEach((f) => {
        const o = document.createElement('option'); o.value = f; o.textContent = `${f} 层`;
        sel.appendChild(o);
      });
    }
  }

  // ---------- 门列表 ----------
  function isEdgeOpen(e) {
    if (state.doorOverrides.has(e.id)) return state.doorOverrides.get(e.id);
    return e.open;
  }

  function buildDoorList() {
    const list = $('doorList');
    list.innerHTML = '';
    const filter = $('doorFilter').value.trim();
    const closedOnly = $('showClosedOnly').checked;
    const doors = state.map.edges.filter((e) => e.kind === 'door' || e.kind === 'link');
    doors.filter((e) => {
      if (closedOnly && isEdgeOpen(e)) return false;
      if (filter && !String(e.id).includes(filter)) return false;
      return true;
    }).forEach((e) => {
      const item = document.createElement('div');
      item.className = 'door-item' + (e.kind === 'link' ? ' jump' : '');
      const open = isEdgeOpen(e);
      item.innerHTML = `
        <span style="display:flex;align-items:center;gap:7px;min-width:0">
          <i class="dot ${open ? 'open' : 'closed'}"></i>
          <span style="min-width:0">
            <div style="font-family:var(--font-mono)">#${e.id} ${e.kind === 'link' ? '<span class="badge jump">跨层</span>' : ''}</div>
            <div class="meta">${e.fromId}→${e.toId} · F${e.fromFloor}→F${e.toFloor}</div>
          </span>
        </span>
        <button data-id="${e.id}">${open ? '开' : '关'}</button>`;
      item.querySelector('button').onclick = () => {
        state.doorOverrides.set(e.id, !open);
        buildDoorList(); autoSolve();
      };
      list.appendChild(item);
    });
  }
  $('doorFilter').addEventListener('input', buildDoorList);
  $('showClosedOnly').addEventListener('change', buildDoorList);

  // ---------- 求解 ----------
  function readQuery() {
    return {
      start: { floor: Number($('startFloor').value), cell: Number($('startCell').value) },
      end: { floor: Number($('endFloor').value), cell: Number($('endCell').value) },
      margin: Number($('margin').value) || 0,
    };
  }

  function autoSolve() {
    if (!state.map) return;
    try { solve(); } catch (err) { console.error(err); toast('求解异常：' + err.message); }
  }
  $('solveBtn').onclick = autoSolve;
  ['startFloor', 'startCell', 'endFloor', 'endCell', 'margin'].forEach((id) =>
    $(id).addEventListener('change', autoSolve));

  const REASON_TEXT = {
    topology: '拓扑不可达：忽略所有门状态后仍无路，起终点所在区域本就不连通。',
    'closed-door': '门已关闭：把下列门重新打开后即有路可达。',
    margin: '余量过大：当前门全部开启，但两端余量把门段吃光（或只剩不可达配置），调小余量即可。',
    'bad-start-cell': '起点格编号不存在。',
    'bad-end-cell': '终点格编号不存在。',
    'zero-fee-cycle': '数据异常：通行费构成的图中存在 0 费用环。',
  };

  function solve() {
    const q = readQuery();
    state.query = q;
    const r = CG.solveQuery(state.map, q, { doorOverrides: state.doorOverrides });
    state.result = r;
    $('statTime').textContent = r.elapsedMs.toFixed(2);
    const pill = $('statusPill');
    if (r.reachable) { pill.className = 'pill ok'; pill.textContent = '可达'; }
    else { pill.className = 'pill bad'; pill.textContent = '不可达'; }
    renderResult(r, q);
    state.lastResultJson = buildExport(r, q);
    draw();
  }

  function renderResult(r, q) {
    const panel = $('resultPanel');
    if (!r.reachable) {
      const blockers = r.diagnostics.blockerIds.length
        ? `阻挡连接：${r.diagnostics.blockerIds.join(', ')}` : '';
      panel.innerHTML = `<h2>求解结果 <span class="pill bad">不可达</span></h2>
        <div class="reason-box ${r.reason === 'margin' ? 'warn' : ''}">
          <div><b>${REASON_TEXT[r.reason] || r.reason}</b></div>
          ${blockers ? `<div class="hint" style="margin-top:6px">${blockers}</div>` : ''}
          <div class="hint" style="margin-top:6px">诊断级别 L${r.diagnostics.level}</div>
        </div>
        ${r.warnings.length ? `<pre class="export">${r.warnings.join('\n')}</pre>` : ''}`;
      return;
    }
    panel.innerHTML = `<h2>求解结果 <span class="pill ok">可达</span></h2>
      <dl class="kv">
        <dt>连接编号序列</dt><dd>${r.corridorEdges.join(' → ')}</dd>
        <dt>格序列</dt><dd>${r.corridorCells.join(' → ')}</dd>
        <dt>通行费总和</dt><dd>${r.totalFee}</dd>
        <dt>地面折线总长</dt><dd>${r.totalLength.toFixed(6)}</dd>
        <dt>同层折线段</dt><dd>${r.segments.length} 段（${r.segments.map((s) => 'F' + s.floor).join(', ')}）</dd>
        <dt>跨层跳跃</dt><dd>${r.jumps.length ? r.jumps.map((j) => `#${j.edgeId} F${j.fromFloor}→F${j.toFloor}`).join('；') : '无'}</dd>
        <dt>求解耗时</dt><dd>${r.elapsedMs.toFixed(3)} ms</dd>
      </dl>
      <pre class="export" id="exportPreview"></pre>`;
    $('exportPreview').textContent = JSON.stringify(state.lastResultJson, null, 1).slice(0, 1200);
  }

  function buildExport(r, q) {
    if (!r.reachable) {
      return {
        query: q, reachable: false, reason: r.reason,
        reasonText: REASON_TEXT[r.reason] || r.reason,
        diagnostics: r.diagnostics,
      };
    }
    return {
      query: q,
      reachable: true,
      corridorEdgeIds: r.corridorEdges,
      corridorCellIds: r.corridorCells,
      totalFee: r.totalFee,
      totalPolylineLength: Number(r.totalLength.toFixed(6)),
      segments: r.segments.map((s) => ({
        floor: s.floor, cells: s.cells,
        polyline: s.points.map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]),
        length: Number(s.length.toFixed(6)),
      })),
      jumps: r.jumps,
    };
  }

  $('exportBtn').onclick = async () => {
    if (!state.lastResultJson) { toast('请先求解'); return; }
    const text = JSON.stringify(state.lastResultJson, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast('导出 JSON 已复制到剪贴板');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('导出 JSON 已复制（兼容方式）');
    }
  };

  // ---------- 画布渲染 ----------
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0 };

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function floorBounds(floor) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ci of state.map.cellsByFloor[state.map.floorIndex.get(floor)]) {
      for (const p of state.map.cells[ci].poly) {
        minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
      }
    }
    return { minX, minY, maxX, maxY };
  }

  function fitView() {
    const rect = canvas.getBoundingClientRect();
    const b = floorBounds(state.activeFloor);
    const pad = 30;
    const sx = (rect.width - pad * 2) / Math.max(1, b.maxX - b.minX);
    const sy = (rect.height - pad * 2) / Math.max(1, b.maxY - b.minY);
    view.scale = Math.min(sx, sy);
    view.ox = pad - b.minX * view.scale;
    view.oy = pad - b.minY * view.scale;
  }
  const toScreen = (p) => [p[0] * view.scale + view.ox, p[1] * view.scale + view.oy];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function draw() {
    if (!state.map) return;
    fitView();
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const map = state.map;
    const floorIdx = map.floorIndex.get(state.activeFloor);
    const corridorCells = new Set();
    const corridorEdges = new Set();
    if (state.result && state.result.reachable) {
      state.result.corridorCells.forEach((id) => { if (map.cells[map.idToIdx.get(id)].floor === state.activeFloor) corridorCells.add(id); });
      state.result.corridorEdges.forEach((id) => corridorEdges.add(id));
    }

    // 格
    for (const ci of map.cellsByFloor[floorIdx]) {
      const c = map.cells[ci];
      ctx.beginPath();
      c.poly.forEach((p, k) => { const s = toScreen(p); k ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.closePath();
      const inCorr = corridorCells.has(c.id);
      ctx.fillStyle = inCorr && $('showCorridor').checked
        ? cssVar('--corridor') + '22' : cssVar('--panel-2');
      ctx.fill();
      ctx.strokeStyle = inCorr && $('showCorridor').checked ? cssVar('--corridor') : cssVar('--grid');
      ctx.lineWidth = inCorr ? 1.4 : 1;
      ctx.stroke();
    }

    // 门与连接
    if ($('showDoors').checked) {
      for (const e of map.edges) {
        if (e.fromFloor !== state.activeFloor && e.toFloor !== state.activeFloor) continue;
        const open = isEdgeOpen(e);
        if (e.kind === 'door' && e.door) {
          drawDoor(e, open);
        } else if (e.kind === 'link') {
          drawLinkPoint(e);
        }
      }
    }

    // 引导折线（同层段）+ 折点
    if (state.result && state.result.reachable) {
      for (const seg of state.result.segments) {
        if (seg.floor !== state.activeFloor) continue;
        ctx.beginPath();
        seg.points.forEach((p, k) => { const s = toScreen(p); k ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2.4;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
        if ($('showVertices').checked) {
          seg.points.forEach((p) => {
            const s = toScreen(p);
            ctx.beginPath(); ctx.arc(s[0], s[1], 3.2, 0, Math.PI * 2);
            ctx.fillStyle = cssVar('--accent'); ctx.fill();
            ctx.strokeStyle = cssVar('--panel'); ctx.lineWidth = 1; ctx.stroke();
          });
        }
      }
      // 跨层入口（本层的 entry 点）
      if ($('showJumps').checked) {
        for (const j of state.result.jumps) {
          const pt = j.fromFloor === state.activeFloor ? j.entry : (j.toFloor === state.activeFloor ? j.exit : null);
          if (!pt) continue;
          const s = toScreen(pt);
          ctx.beginPath(); ctx.arc(s[0], s[1], 6, 0, Math.PI * 2);
          ctx.fillStyle = cssVar('--jump'); ctx.fill();
          ctx.strokeStyle = cssVar('--panel'); ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = cssVar('--jump');
          ctx.font = '10px monospace'; ctx.fillText(`#${j.edgeId}`, s[0] + 8, s[1] - 6);
        }
      }
      // 起终点标记
      drawEndpoint(state.result.start, cssVar('--door-open'), 'S');
      drawEndpoint(state.result.end, cssVar('--danger'), 'T');
    }
  }

  function drawDoor(e, open) {
    const color = open ? cssVar('--door-open') : cssVar('--door-closed');
    const [a, b] = e.door;
    const sa = toScreen(a), sb = toScreen(b);
    ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]);
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
    if (!open) { // 关门画叉
      const d = 4;
      ctx.beginPath();
      ctx.moveTo(sa[0] - d, sa[1] - d); ctx.lineTo(sa[0] + d, sa[1] + d);
      ctx.moveTo(sa[0] + d, sa[1] - d); ctx.lineTo(sa[0] - d, sa[1] + d);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  function drawLinkPoint(e) {
    if (!$('showJumps').checked) return;
    const pt = e.fromFloor === state.activeFloor ? e.link.entry : e.link.exit;
    const s = toScreen(pt);
    ctx.beginPath(); ctx.arc(s[0], s[1], 4.5, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--jump'); ctx.fill();
    ctx.strokeStyle = cssVar('--panel'); ctx.lineWidth = 1; ctx.stroke();
  }

  function drawEndpoint(ep, color, label) {
    if (ep.floor !== state.activeFloor) return;
    const ci = state.map.idToIdx.get(ep.cell);
    if (ci == null) return;
    const pt = state.result.start === ep ? state.result.start.point : state.result.end.point;
    const s = toScreen(pt);
    ctx.beginPath(); ctx.arc(s[0], s[1], 6.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = cssVar('--panel'); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = color; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(label, s[0] + 9, s[1] + 4);
  }

  // 显示开关变化重绘
  ['showCorridor', 'showVertices', 'showJumps', 'showDoors'].forEach((id) =>
    $(id).addEventListener('change', draw));

  // 暴露给控制台调试
  window.__CG_DEBUG = { get state() { return state; } };
})();
