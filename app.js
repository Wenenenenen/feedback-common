/* 铁路编组场调度 —— 界面与交互层 */
(function () {
  'use strict';

  const PALETTE = [
    '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
    '#db2777', '#4d7c0f', '#ea580c', '#4f46e5', '#0d9488', '#be185d',
    '#65a30d', '#9333ea', '#0369a1', '#b91c1c',
  ];
  const PAD = 70;
  const BLOCK_W = 58;
  const BLOCK_H = 32;
  const BASE_W = 1060;
  const BASE_H = 740;
  let W = BASE_W;
  let H = BASE_H;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);

  let level = null;
  let sim = null;
  let layout = null; // blockId -> {x, y}
  let trainColor = new Map();
  let selectedTrainId = null;
  let pending = {}; // 待下一步步首检查的手动扳道请求
  let requestLog = []; // 每步实际提交的手动请求，用于回退/重来时重放
  let allRecords = []; // 已产生过的逐步记录（回退不删除，分叉推进时截断）
  let runTimer = null;

  // ---------- 工具 ----------
  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function htmlEl(tag, attrs, parent) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const m = $('msg');
    m.textContent = msg;
    m.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { m.className = ''; }, 2800);
  }

  function colorFor(trainId) {
    return trainColor.get(trainId) || '#64748b';
  }

  function currentRecord() {
    const h = sim.state.history;
    return h.length ? h[h.length - 1] : null;
  }

  function trainRec(record, id) {
    return record && record.trains.find((t) => t.trainId === id);
  }

  // ---------- 确定性力导向布局 ----------
  function computeLayout(lvl) {
    const nodes = new Set();
    for (const [u, v] of lvl.edges) { nodes.add(u); nodes.add(v); }
    const ids = Array.from(nodes);
    // 节点越多画布越大（SVG 自适应容器，可缩放），保证块间不挤压
    const cols = Math.ceil(Math.sqrt(ids.length * 1.4));
    W = Math.max(BASE_W, cols * 130);
    H = Math.max(BASE_H, Math.ceil(ids.length / cols) * 120 + 120);
    const pos = new Map();
    const vel = new Map();

    if (lvl.positions && typeof lvl.positions === 'object') {
      for (const id of ids) {
        const p = lvl.positions[id];
        if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) {
          pos.set(id, { x: p[0], y: p[1] });
          vel.set(id, { x: 0, y: 0 });
        }
      }
    }
    // 未指定坐标的节点先在圆周上初始化
    const missing = ids.filter((id) => !pos.has(id));
    missing.forEach((id, i) => {
      const ang = (2 * Math.PI * i) / Math.max(missing.length, 1);
      const r = 260;
      pos.set(id, { x: W / 2 + r * Math.cos(ang), y: H / 2 + r * Math.sin(ang) });
      vel.set(id, { x: 0, y: 0 });
    });

    const springs = [];
    const seenEdge = new Set();
    for (const [u, v] of lvl.edges) {
      const key = u < v ? u + '|' + v : v + '|' + u;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      springs.push([u, v]);
    }

    const k0 = 105;
    for (let tick = 0; tick < 420; tick++) {
      // 斥力
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i]);
          const b = pos.get(ids[j]);
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = 0.1; dy = 0.1; d2 = 0.02; }
          const f = 9000 / d2;
          const d = Math.sqrt(d2);
          const fx = (f * dx) / d;
          const fy = (f * dy) / d;
          vel.get(ids[i]).x += fx;
          vel.get(ids[i]).y += fy;
          vel.get(ids[j]).x -= fx;
          vel.get(ids[j]).y -= fy;
        }
      }
      // 弹簧
      for (const [u, v] of springs) {
        const a = pos.get(u);
        const b = pos.get(v);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(Math.hypot(dx, dy), 0.1);
        const f = (d - k0) * 0.12;
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        vel.get(u).x += fx;
        vel.get(u).y += fy;
        vel.get(v).x -= fx;
        vel.get(v).y -= fy;
      }
      // 向心引力 + 阻尼积分
      for (const id of ids) {
        const p = pos.get(id);
        const vv = vel.get(id);
        vv.x += (W / 2 - p.x) * 0.01;
        vv.y += (H / 2 - p.y) * 0.01;
        vv.x *= 0.82;
        vv.y *= 0.82;
        p.x += vv.x;
        p.y += vv.y;
      }
    }

    // 自定义坐标的节点在分离阶段保持不动
    const fixed = new Set();
    if (lvl.positions && typeof lvl.positions === 'object') {
      for (const id of ids) {
        const p = lvl.positions[id];
        if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) fixed.add(id);
      }
    }

    // 先归一化到画布
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = pos.get(id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const sx = (W - PAD * 2) / Math.max(maxX - minX, 1);
    const sy = (H - PAD * 2) / Math.max(maxY - minY, 1);
    const s = Math.min(sx, sy);
    const ox = PAD + (W - PAD * 2 - (maxX - minX) * s) / 2 - minX * s;
    const oy = PAD + (H - PAD * 2 - (maxY - minY) * s) / 2 - minY * s;
    const out = new Map();
    for (const id of ids) {
      const p = pos.get(id);
      out.set(id, { x: p.x * s + ox, y: p.y * s + oy });
    }

    // 归一化后在屏幕坐标做 AABB 防重叠松弛（按块实际尺寸 + 间隙）
    const gapX = BLOCK_W + 18;
    const gapY = BLOCK_H + 22;
    for (let pass = 0; pass < 300; pass++) {
      let moved = false;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (fixed.has(ids[i]) && fixed.has(ids[j])) continue;
          const a = out.get(ids[i]);
          const b = out.get(ids[j]);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (Math.abs(dx) >= gapX || Math.abs(dy) >= gapY) continue;
          // 重叠：沿中心连线把两者沿最松的轴推开
          let ux, uy;
          if (Math.abs(dx) > Math.abs(dy)) {
            ux = dx >= 0 ? 1 : -1; uy = 0;
          } else {
            ux = 0; uy = dy >= 0 ? 1 : -1;
          }
          const pushX = ux * (gapX - Math.abs(dx)) / 2;
          const pushY = uy * (gapY - Math.abs(dy)) / 2;
          if (!fixed.has(ids[i])) { a.x -= pushX; a.y -= pushY; moved = true; }
          if (!fixed.has(ids[j])) { b.x += pushX; b.y += pushY; moved = true; }
        }
      }
      if (!moved) break;
    }
    return out;
  }

  // ---------- 渲染 ----------
  function render() {
    renderBoard();
    renderSwitchPanel();
    renderTrainList();
    renderTrainDetail();
    renderLog();
    renderHeader();
  }

  function renderHeader() {
    $('step-badge').textContent = '第 ' + sim.state.step + ' 步';
    const total = sim.state.trains.length;
    const arrived = sim.state.trains.filter((t) => t.remaining.length === 0).length;
    const badge = $('arrived-badge');
    badge.textContent = '到站 ' + arrived + '/' + total;
    badge.style.background = arrived === total ? 'var(--good-soft)' : 'var(--panel-2)';
    badge.style.color = arrived === total ? 'var(--good)' : 'var(--text-dim)';
  }

  function renderBoard() {
    const svg = $('board');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    // 边（去重）
    const seenEdge = new Set();
    const edgeLayer = el('g', {}, svg);
    for (const [u, v] of level.edges) {
      const key = u < v ? u + '|' + v : v + '|' + u;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const a = layout.get(u);
      const b = layout.get(v);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'svg-edge' }, edgeLayer);
    }

    // 剩余路线（相对轨道线做垂直偏移的彩色虚线 + 箭头 + 编号）
    const routeLayer = el('g', {}, svg);
    const trainIndex = new Map(sim.state.trains.map((t, i) => [t.id, i]));
    for (const t of sim.state.trains) {
      if (t.remaining.length === 0) continue;
      const color = colorFor(t.id);
      const offset = 7 + (trainIndex.get(t.id) % 4) * 3; // 不同列车错开，避免重叠
      const headBlock = t.body[t.body.length - 1];
      const pts = [layout.get(headBlock)].concat(t.remaining.map((b) => layout.get(b)));

      const shifted = pts.map((p, i) => {
        if (i === 0) return p;
        const prev = pts[i - 1];
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const len = Math.max(Math.hypot(dx, dy), 0.1);
        return { x: p.x + (-dy / len) * offset, y: p.y + (dx / len) * offset };
      });
      // 起点沿首段方向同样偏移，保证整条线平行
      if (shifted.length > 1) {
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        const len = Math.max(Math.hypot(dx, dy), 0.1);
        shifted[0] = { x: pts[0].x + (-dy / len) * offset, y: pts[0].y + (dx / len) * offset };
      }
      const d = shifted.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
      el('path', { d, class: 'svg-route', stroke: color }, routeLayer);

      t.remaining.forEach((b, i) => {
        const p = shifted[i + 1];
        el('circle', { cx: p.x, cy: p.y, r: 9, fill: color }, routeLayer);
        const txt = el('text', { x: p.x, y: p.y + 0.5, class: 'svg-route-num' }, routeLayer);
        txt.textContent = String(i + 1);
      });

      // 末端箭头
      if (shifted.length >= 2) {
        const end = shifted[shifted.length - 1];
        const prev = shifted[shifted.length - 2];
        const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
        const ax = end.x - Math.cos(ang) * 13;
        const ay = end.y - Math.sin(ang) * 13;
        const ah = 24;
        const ptsTri = [
          [ax, ay],
          [ax - Math.cos(ang - 0.45) * ah, ay - Math.sin(ang - 0.45) * ah],
          [ax - Math.cos(ang + 0.45) * ah, ay - Math.sin(ang + 0.45) * ah],
        ].map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');
        el('polygon', { points: ptsTri, fill: color }, routeLayer);
      }
    }

    // 选中列车的等待目标块：红色脉冲框 + 角标
    const record = currentRecord();
    const selRec = trainRec(record, selectedTrainId);
    if (selRec && !selRec.moved && selRec.target) {
      const p = layout.get(selRec.target);
      el('rect', {
        x: p.x - BLOCK_W / 2 - 5, y: p.y - BLOCK_H / 2 - 5,
        width: BLOCK_W + 10, height: BLOCK_H + 10, rx: 11,
        class: 'wait-target-ring', fill: 'none',
      }, svg);
      const badge = el('g', {}, svg);
      el('circle', { cx: p.x + BLOCK_W / 2, cy: p.y - BLOCK_H / 2, r: 11, fill: 'var(--bad)' }, badge);
      const t1 = el('text', {
        x: p.x + BLOCK_W / 2, y: p.y - BLOCK_H / 2 + 0.5,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 13, 'font-weight': 800, fill: '#fff',
      }, badge);
      t1.textContent = '!';
      const t2 = el('text', {
        x: p.x + BLOCK_W / 2 - 4, y: p.y - BLOCK_H / 2 - 16,
        'text-anchor': 'end', 'font-size': 11, 'font-weight': 700, fill: 'var(--bad)',
      }, badge);
      t2.textContent = selRec.trainId + ' 的等待目标';
    }

    // 轨道块
    const blockLayer = el('g', {}, svg);
    const switchByBlock = new Map();
    for (const sw of sim.state.switches) {
      for (const p of sw.positions) switchByBlock.set(p, sw);
    }
    const occ = sim.occupiedBlocks();
    for (const [id, p] of layout.entries()) {
      const sw = switchByBlock.get(id);
      const cls = 'svg-block' + (sw ? ' switch' : '');
      el('rect', {
        x: p.x - BLOCK_W / 2, y: p.y - BLOCK_H / 2,
        width: BLOCK_W, height: BLOCK_H, rx: 8, class: cls,
        fill: sw && sw.position === id ? 'var(--accent-soft)' : undefined,
      }, blockLayer);
      const label = el('text', { x: p.x, y: p.y + (sw ? 2 : 1), class: 'svg-block-label' }, blockLayer);
      label.textContent = id;
      if (sw) {
        const tag = el('text', { x: p.x, y: p.y + BLOCK_H / 2 + 14, class: 'svg-switch-tag' }, blockLayer);
        tag.textContent = sw.id + '→' + sw.position + (occ.has(id) ? ' ·占用' : ' ·空闲');
      }
    }

    // 车身（尾 -> 头）
    const trainLayer = el('g', {}, svg);
    for (const t of sim.state.trains) {
      const color = colorFor(t.id);
      t.body.forEach((blockId, idx) => {
        const p = layout.get(blockId);
        const g = el('g', { style: 'cursor:pointer' }, trainLayer);
        el('rect', {
          x: p.x - BLOCK_W / 2 + 3, y: p.y - BLOCK_H / 2 + 3,
          width: BLOCK_W - 6, height: BLOCK_H - 6, rx: 7,
          fill: color, 'fill-opacity': selectedTrainId && selectedTrainId !== t.id ? 0.45 : 0.9,
          stroke: selectedTrainId === t.id ? '#fff' : 'none', 'stroke-width': 2,
        }, g);
        const isHead = idx === t.body.length - 1;
        const isTail = idx === 0;
        const marker = el('text', { x: p.x, y: p.y + 1, class: 'svg-marker' }, g);
        marker.textContent = t.body.length === 1 ? '头/尾' : isHead ? '头' : isTail ? '尾' : '';
        g.addEventListener('click', () => {
          selectedTrainId = t.id;
          render();
        });
      });
      // 车头旁标注车号与到站状态
      const hp = layout.get(t.body[t.body.length - 1]);
      const chip = el('text', {
        x: hp.x, y: hp.y - BLOCK_H / 2 - 20,
        'text-anchor': 'middle', 'font-size': 11, 'font-weight': 800, fill: color,
      }, trainLayer);
      chip.textContent = t.id + (t.remaining.length === 0 ? ' ✓到站' : '');
    }
  }

  function renderSwitchPanel() {
    const panel = $('switch-panel');
    panel.innerHTML = '';
    if (sim.state.switches.length === 0) {
      panel.innerHTML = '<div class="hint">本关卡没有道岔。</div>';
      return;
    }
    const occ = sim.occupiedBlocks();
    for (const sw of sim.state.switches) {
      const locked = sw.positions.some((p) => occ.has(p));
      const row = htmlEl('div', { class: 'switch-row' }, panel);
      const meta = htmlEl('div', { class: 'switch-meta' }, row);
      htmlEl('span', { class: 'switch-id', text: '道岔 ' + sw.id }, meta);
      const tag = htmlEl('span', { class: 'lock-tag ' + (locked ? 'locked' : 'free') }, meta);
      tag.textContent = locked
        ? '锁定：' + sw.positions.filter((p) => occ.has(p)).join('、') + ' 被占'
        : '可扳动（位置块全空闲）';
      const btns = htmlEl('div', { class: 'pos-btns' }, row);
      for (const pos of sw.positions) {
        const cls = 'pos-btn' + (sw.position === pos ? ' current' : '') + (pending[sw.id] === pos ? ' pending' : '');
        const btn = htmlEl('button', { class: cls, text: '朝向 ' + pos }, btns);
        btn.title = locked
          ? '道岔锁定中：车尾完全退出后的下一步才能扳动'
          : '设为下一步的扳动请求（步首占用检查）';
        btn.addEventListener('click', () => {
          pending[sw.id] = pos;
          render();
        });
      }
      if (pending[sw.id]) {
        const note = htmlEl('div', { class: 'switch-note' }, row);
        note.textContent = '待检查请求：→ ' + pending[sw.id] + '（下一步步首判定）';
        const cancel = htmlEl('button', { text: '撤销请求', style: 'margin-top:4px;padding:2px 8px;font-size:12px' }, row);
        cancel.addEventListener('click', () => {
          delete pending[sw.id];
          render();
        });
      }
    }
  }

  function renderTrainList() {
    const list = $('train-list');
    list.innerHTML = '';
    $('train-count').textContent = '共 ' + sim.state.trains.length + ' 列';
    const record = currentRecord();
    for (const t of sim.state.trains) {
      const rec = trainRec(record, t.id);
      const item = htmlEl('div', {
        class: 'train-item' + (selectedTrainId === t.id ? ' selected' : ''),
      }, list);
      htmlEl('span', { class: 'train-dot', style: 'background:' + colorFor(t.id) }, item);
      htmlEl('span', { class: 'name', text: t.id }, item);
      const status = htmlEl('span', { class: 'status' }, item);
      if (t.remaining.length === 0) {
        status.className = 'status arrived';
        status.textContent = '已到站 · 车头 ' + t.body[t.body.length - 1];
      } else if (rec && rec.moved) {
        status.className = 'status moved';
        status.textContent = '本步移动 → ' + rec.headAfter;
      } else if (rec && rec.waitReason) {
        status.className = 'status waiting';
        status.textContent = '等待中';
      } else {
        status.textContent = '车头 ' + t.body[t.body.length - 1];
      }
      item.addEventListener('click', () => {
        selectedTrainId = t.id;
        render();
      });
    }
  }

  function renderTrainDetail() {
    const box = $('train-detail');
    box.innerHTML = '';
    if (!selectedTrainId) {
      box.className = 'hint';
      box.textContent = '点击列车或图上车身，查看本步动作与等待原因。';
      return;
    }
    const t = sim.state.trains.find((x) => x.id === selectedTrainId);
    if (!t) return;
    const record = currentRecord();
    const rec = trainRec(record, selectedTrainId);
    box.className = '';

    const line = (k, v) => {
      const d = htmlEl('div', {}, box);
      htmlEl('span', { class: 'kv', text: k + '：' }, d);
      htmlEl('span', { text: v }, d);
    };
    line('列车', t.id);
    line('车头', t.body[t.body.length - 1]);
    line('车尾', t.body[0]);
    line('车身（尾→头）', t.body.join(' → '));

    const routeDiv = htmlEl('div', { style: 'margin-top:4px' }, box);
    htmlEl('span', { class: 'kv', text: '剩余路线：' }, routeDiv);
    const chips = htmlEl('span', { class: 'route-chips' }, routeDiv);
    if (t.remaining.length === 0) {
      htmlEl('span', { class: 'chip head', text: '全部走完，已到站' }, chips);
    } else {
      t.remaining.forEach((b, i) => {
        htmlEl('span', { class: 'chip' + (i === 0 ? ' head' : ''), text: (i + 1) + '. ' + b }, chips);
      });
    }

    if (rec) {
      const r = htmlEl('div', {
        class: 'reason-box' + (rec.moved ? ' ok' : ''),
      }, box);
      if (rec.arrived && !rec.moved) {
        r.textContent = '第 ' + record.step + ' 步：已到站，不再移动，仍占用车身所在轨道块。';
      } else if (rec.moved) {
        r.textContent = '第 ' + record.step + ' 步：抢到目标块 ' + rec.target + '，车头 ' +
          rec.head + ' → ' + rec.headAfter + '，车尾退出 ' + rec.body[0] + '。';
      } else {
        r.textContent = '第 ' + record.step + ' 步等待：' + rec.waitReason;
      }
    } else {
      const r = htmlEl('div', { class: 'reason-box ok' }, box);
      r.textContent = '初始状态（第 0 步），尚未推进。';
    }
  }

  function renderLog() {
    const log = $('log');
    log.innerHTML = '';
    if (allRecords.length === 0) {
      log.innerHTML = '<div class="hint">尚未推进。</div>';
      return;
    }
    allRecords.forEach((record) => {
      const row = htmlEl('div', {
        class: 'log-row' + (record.step === sim.state.step ? ' current' : ''),
      }, log);
      const head = htmlEl('div', {}, row);
      htmlEl('span', { class: 'n', text: '第 ' + record.step + ' 步 ' }, head);
      for (const d of record.decisions) {
        const tag = htmlEl('span', { class: 'tag ' + (d.accepted ? 'ok' : 'no') }, head);
        tag.textContent = d.switchId + '→' + d.requested + ' ' + (d.accepted ? '接受' : '拒绝');
      }
      const moved = record.trains.filter((t) => t.moved).map((t) => t.trainId + ':' + t.head + '→' + t.headAfter);
      const waited = record.trains.filter((t) => !t.moved).map((t) => t.trainId);
      const body = htmlEl('div', { style: 'color:var(--text-dim)' }, row);
      body.textContent = (moved.length ? '移动 ' + moved.join('，') : '无车移动') +
        (waited.length ? '；等待 ' + waited.join('、') : '');
      row.title = record.trains.map((t) => t.trainId + '：' + (t.moved ? '移动' : t.waitReason)).join('\n');
      row.addEventListener('click', () => replayTo(record.step));
    });
  }

  // ---------- 推进 / 回退 / 重来 ----------
  function rebuildAndReplay(upTo) {
    sim = RailEngine.createSimulation(level, level.commands || []);
    for (let i = 0; i < upTo; i++) {
      sim.step(requestLog[i] || {});
    }
    // 回退重建后，用新引擎产生的记录刷新 allRecords 的前缀，后缀保留
    allRecords = sim.state.history.concat(allRecords.slice(upTo));
    render();
  }

  // 回退到第 stepNo 步：完整请求日志保留，仅重建模拟到该步；
  // 之后若从旧状态继续推进，再截断分叉后的历史。
  function replayTo(stepNo) {
    stopRun();
    if (stepNo < 0 || stepNo > requestLog.length) return;
    const restoredPending = stepNo < requestLog.length
      ? Object.assign({}, requestLog[stepNo])
      : {};
    rebuildAndReplay(stepNo);
    pending = restoredPending;
    render();
  }

  function doStep() {
    // 从回退点继续推进：丢弃分叉后的旧历史
    if (requestLog.length > sim.state.step) {
      requestLog = requestLog.slice(0, sim.state.step);
      allRecords = allRecords.slice(0, sim.state.step);
    }
    const snapshot = Object.assign({}, pending);
    requestLog.push(snapshot);
    const record = sim.step(snapshot);
    allRecords.push(record);
    pending = {};
    render();

    if (sim.allArrived()) {
      stopRun();
      toast('全部列车到站，共 ' + sim.state.step + ' 步', 'good');
      return;
    }
    // 僵局：没有车能动、没有待检查请求、操作表也没有后续条目
    const tableLeft = sim.state.commands.some((c) => !c.consumed);
    if (!sim.canAnyTrainMove() && Object.keys(pending).length === 0 && !tableLeft) {
      stopRun();
      const stuck = sim.state.trains.filter((t) => t.remaining.length > 0).map((t) => t.id).join('、');
      if (sim.state.step === 0) {
        toast('初始状态即无车可动（未到站：' + stuck + '），请检查关卡或先扳道', 'warn');
      } else {
        toast('僵局：没有可移动的列车（未到站：' + stuck + '），可重来调整扳道时机', 'warn');
      }
    }
  }

  function stopRun() {
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
      $('btn-run').textContent = '连续运行';
    }
  }

  function toggleRun() {
    if (runTimer) {
      stopRun();
      return;
    }
    $('btn-run').textContent = '暂停';
    const interval = Number($('speed').value);
    runTimer = setInterval(() => {
      if (sim.allArrived()) { stopRun(); return; }
      const tableLeft = sim.state.commands.some((c) => !c.consumed);
      if (!sim.canAnyTrainMove() && Object.keys(pending).length === 0 && !tableLeft) {
        stopRun();
        doStep(); // 触发僵局提示
        return;
      }
      if (sim.state.step >= 500) {
        stopRun();
        toast('已达 500 步保护上限，连续运行停止', 'warn');
        return;
      }
      doStep();
    }, interval);
  }

  // ---------- 载入 / 校验 / 导出 ----------
  function loadLevel(obj) {
    const wrapper = obj.level && obj.level.edges ? obj.level : obj;
    if (!wrapper.edges) {
      // 只带操作表的 JSON：合并到当前关卡
      if (Array.isArray(wrapper.commands) && level) {
        level.commands = wrapper.commands;
        toast('已为当前关卡载入操作表（' + wrapper.commands.length + ' 条）', 'good');
        resetAll();
        return true;
      }
      toast('JSON 中找不到 edges 字段', 'bad');
      return false;
    }
    const { errors, warnings } = RailEngine.validate(wrapper);
    const msg = $('load-msg');
    if (errors.length) {
      msg.style.color = 'var(--bad)';
      msg.textContent = '校验失败：' + errors.join('；');
      toast('关卡校验失败，未载入', 'bad');
      return false;
    }
    level = wrapper;
    msg.style.color = warnings.length ? 'var(--warn)' : 'var(--good)';
    msg.textContent = (warnings.length ? '已载入（警告：' + warnings.join('；') + '）' : '校验通过，已载入。') +
      ' 轨道块 ' + new Set(level.edges.flat()).size + ' 个，列车 ' + level.trains.length + ' 列。';
    resetAll();
    return true;
  }

  function resetAll() {
    stopRun();
    sim = RailEngine.createSimulation(level, level.commands || []);
    layout = computeLayout(level);
    trainColor = new Map();
    level.trains
      .slice()
      .sort((a, b) => RailEngine.naturalCompare(a.id, b.id))
      .forEach((t, i) => trainColor.set(t.id, PALETTE[i % PALETTE.length]));
    selectedTrainId = null;
    pending = {};
    requestLog = [];
    allRecords = [];
    render();
  }

  function checkArrival() {
    const ok = sim.allArrived();
    const detail = sim.state.trains.map((t) => ({
      id: t.id,
      head: t.body[t.body.length - 1],
      remaining: t.remaining.length,
    }));
    if (ok) {
      toast('检查通过：全部 ' + detail.length + ' 列车均已到站', 'good');
    } else {
      const stuck = detail.filter((d) => d.remaining > 0).map((d) => d.id + '（余 ' + d.remaining + ' 块）').join('、');
      toast('尚有列车未到站：' + stuck, 'warn');
    }
    renderTrainDetail();
    // 在详情区展示逐车结论
    const box = $('train-detail');
    const list = htmlEl('div', { class: 'verdict-list' }, box);
    detail.forEach((d) => {
      const row = htmlEl('div', { class: 'verdict-row' }, list);
      htmlEl('span', { text: '列车 ' + d.id + '（车头 ' + d.head + '）' }, row);
      htmlEl('span', {
        style: d.remaining === 0 ? 'color:var(--good)' : 'color:var(--warn)',
        text: d.remaining === 0 ? '已到站' : '剩 ' + d.remaining + ' 块',
      }, row);
    });
  }

  function exportRecord() {
    const payload = {
      level: {
        edges: level.edges,
        switches: level.switches,
        trains: level.trains,
        commands: level.commands || [],
      },
      totalSteps: sim.state.step,
      allArrived: sim.allArrived(),
      manualRequests: requestLog,
      final: {
        trains: sim.state.trains.map((t) => ({
          id: t.id,
          head: t.body[t.body.length - 1],
          tail: t.body[0],
          body: t.body,
          remaining: t.remaining,
          arrived: t.remaining.length === 0,
        })),
        switches: sim.state.switches.map((s) => ({ id: s.id, position: s.position })),
      },
      steps: sim.state.history,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rail-switch-yard-record-step' + sim.state.step + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出逐步记录（' + sim.state.step + ' 步）', 'good');
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('btn-step').addEventListener('click', () => { stopRun(); doStep(); });
    $('btn-run').addEventListener('click', toggleRun);
    $('btn-reset').addEventListener('click', () => { resetAll(); toast('已重来，回到第 0 步'); });
    $('btn-back').addEventListener('click', () => replayTo(Math.max(0, sim.state.step - 1)));
    $('btn-check').addEventListener('click', checkArrival);
    $('btn-export').addEventListener('click', exportRecord);

    $('btn-load-text').addEventListener('click', () => {
      const txt = $('json-input').value.trim();
      if (!txt) { toast('请先粘贴 JSON', 'warn'); return; }
      try {
        loadLevel(JSON.parse(txt));
      } catch (e) {
        $('load-msg').style.color = 'var(--bad)';
        $('load-msg').textContent = 'JSON 解析失败：' + e.message;
      }
    });

    $('file-input').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result));
          $('json-input').value = JSON.stringify(obj, null, 2);
          loadLevel(obj);
        } catch (e) {
          $('load-msg').style.color = 'var(--bad)';
          $('load-msg').textContent = 'JSON 解析失败：' + e.message;
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });

    $('btn-load-sample').addEventListener('click', async () => {
      if (location.protocol === 'file:') {
        $('load-msg').style.color = 'var(--warn)';
        $('load-msg').textContent = 'file:// 直接打开时浏览器禁止 fetch 本地文件，请用“选择文件”载入 samples/rail-switch-yard.json；通过 http 服务打开时可一键载入。';
        return;
      }
      try {
        const resp = await fetch('samples/rail-switch-yard.json');
        const obj = await resp.json();
        $('json-input').value = JSON.stringify(obj, null, 2);
        loadLevel(obj);
      } catch (e) {
        $('load-msg').style.color = 'var(--warn)';
        $('load-msg').textContent = '无法读取样例文件（' + e.message + '），请用“选择文件”载入。';
      }
    });

    document.addEventListener('keydown', (ev) => {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        stopRun();
        doStep();
      } else if (ev.key === 'r' || ev.key === 'R') {
        resetAll();
      }
    });
  }

  // ---------- 启动 ----------
  bind();
  // 内置样例兜底（file:// 直接打开时 fetch 受限）
  const builtinSample = {
    edges: [['A0', 'A1'], ['A1', 'X'], ['X', 'C0'], ['C0', 'C1'], ['B0', 'Y'], ['Y', 'D0']],
    switches: [{ id: 'S', positions: ['X', 'Y'], initial: 'X' }],
    trains: [
      { id: 'A', body: ['A0', 'A1'], route: ['X', 'C0', 'C1'] },
      { id: 'B', body: ['B0'], route: ['Y', 'D0'] },
    ],
    commands: [[2, 'S', 'Y'], [3, 'S', 'Y'], [4, 'S', 'Y']],
  };
  loadLevel(builtinSample);
  $('json-input').value = JSON.stringify(builtinSample, null, 2);
  $('load-msg').textContent = '已自动载入内置样例；也可粘贴完整关卡 JSON 或选择 samples/rail-switch-yard.json。';
  $('load-msg').style.color = 'var(--text-dim)';
})();
