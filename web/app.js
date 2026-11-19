/* 任务链演算台 —— 页面控制器（依赖 engine.js 暴露的 QREngine） */
(function () {
  'use strict';
  const E = window.QREngine;
  const LS_KEY = 'qbr-workspace-v1';
  const ROW_H = 46;
  const STATE_LABEL = { locked: '锁定', active: '进行中', ready: '可领取', claimed: '已领取', failed: '失效' };

  /* ---------------- 全局状态 ---------------- */
  const state = {
    quests: null,
    log: [],
    rt: null,
    cursor: 0,
    selectedQuest: null,
    selectedEvent: null,
    tab: 'log',
    view: { tx: 0, ty: 0, s: 1 },
    userMovedGraph: false
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function toast(msg, kind) {
    const root = $('toastRoot');
    while (root.children.length >= 3) root.children[0].remove();
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0'; el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  /* ---------------- 持久化（localStorage 仅作草稿便利，可靠持久化用导出存档） ---------------- */
  function saveDraft() {
    if (!state.quests) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        quests: state.quests, log: state.log,
        cursor: state.cursor, theme: document.documentElement.dataset.theme || ''
      }));
    } catch (_) { /* 存储不可用时静默降级 */ }
  }
  let draftTimer = null;
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }

  /* ---------------- 核心装载与重算 ---------------- */
  function loadWorkspace(quests, log, cursor) {
    const check = E.validateQuests(quests);
    if (!check.ok) return { ok: false, errors: check.errors };
    if (!Array.isArray(log)) return { ok: false, errors: ['事件日志必须是数组'] };
    if (log.length > E.LIMITS.MAX_LOG) return { ok: false, errors: ['日志项 ' + log.length + ' 超过上限 ' + E.LIMITS.MAX_LOG] };
    let rt;
    try { rt = E.replay(quests, log); }
    catch (err) { return { ok: false, errors: [String(err.message || err)] }; }
    state.quests = quests;
    state.log = log;
    state.rt = rt;
    state.cursor = Math.max(0, Math.min(log.length, cursor == null ? log.length : cursor));
    state.selectedQuest = null;
    state.selectedEvent = null;
    state.userMovedGraph = false;
    renderAll();
    scheduleDraft();
    return { ok: true };
  }

  function recompute(keepCursor) {
    if (!state.quests) return;
    state.rt = E.replay(state.quests, state.log);
    state.cursor = Math.max(0, Math.min(state.log.length, keepCursor == null ? state.log.length : keepCursor));
    if (state.selectedEvent != null) state.selectedEvent = Math.min(state.selectedEvent, state.log.length - 1);
    renderAll();
    scheduleDraft();
  }

  function currentCtx() { return E.viewAt(state.rt, state.cursor); }

  /* ---------------- 顶部余额 ---------------- */
  function renderBalances() {
    const bar = $('balanceBar');
    const ctx = currentCtx();
    const keys = Object.keys(ctx.balances).sort();
    bar.innerHTML = keys.length
      ? keys.map((k) => `<span class="balance-chip"><span class="cur">${esc(k)}</span><b class="num">${ctx.balances[k]}</b></span>`).join('')
      : '<span class="balance-chip"><span class="cur">余额</span><b class="num">0</b></span>';
  }

  /* ---------------- 时间轴 ---------------- */
  function renderCursor() {
    const n = state.log.length;
    const slider = $('cursorSlider');
    slider.max = n;
    slider.value = state.cursor;
    $('cursorNow').textContent = state.cursor;
    $('cursorTotal').textContent = n;
    const issueCount = state.rt.ctx.issues.length;
    $('logHint').textContent = n + ' 条日志' + (issueCount ? ' · ' + issueCount + ' 条拒绝/冲突' : '');
  }

  function setCursor(k) {
    state.cursor = Math.max(0, Math.min(state.log.length, k));
    renderCursor();
    renderBalances();
    renderGraph();
    renderLog();
    if (state.tab === 'detail') renderDetail();
    scheduleDraft();
  }

  /* ---------------- 任务图 ---------------- */
  let graphLayout = null;
  function renderGraph() {
    const svg = $('graphSvg');
    if (!state.quests) { $('graphEmpty').hidden = false; svg.innerHTML = ''; return; }
    $('graphEmpty').hidden = true;
    if (!graphLayout || graphLayout._sig !== signature()) {
      graphLayout = E.layoutGraph(state.quests);
      graphLayout._sig = signature();
      if (!state.userMovedGraph) fitGraph(false);
    }
    const L = graphLayout;
    const ctx = currentCtx();
    const pos = {};
    L.nodes.forEach((n) => { pos[n.id] = n; });

    const edgeHtml = L.edges.map((e) => {
      const a = pos[e.from], b = pos[e.to];
      const x1 = a.x + L.nodeW, y1 = a.y + L.nodeH / 2;
      const x2 = b.x, y2 = b.y + L.nodeH / 2;
      const mx = (x1 + x2) / 2;
      const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`;
      const failed = ctx.state[e.to] === 'failed' || ctx.state[e.from] === 'failed';
      const claimed = ctx.state[e.from] === 'claimed';
      const cls = 'edge' + (e.mode === 'any' ? ' mode-any' : '');
      const col = failed ? 'var(--st-failed)' : claimed ? 'var(--st-claimed)' : 'var(--border-strong)';
      const lx = mx, ly = (y1 + y2) / 2 - 4;
      return `<path class="edge-hit" data-edge="${esc(e.from)}=>${esc(e.to)}" d="${d}"></path>
              <path class="${cls}" d="${d}" stroke="${col}" marker-end="url(#arrow-${e.mode}${failed ? '-failed' : claimed ? '-claimed' : ''})"></path>
              ${Math.abs(y2 - y1) > 26 ? `<text class="edge-label" x="${lx}" y="${ly}" text-anchor="middle">${e.mode === 'any' ? 'any' : 'all'}</text>` : ''}`;
    }).join('');

    const nodeHtml = L.nodes.map((n) => {
      const q = state.rt.byId[n.id];
      const st = ctx.state[n.id];
      const done = q.objectives.filter((o) => ctx.progress[n.id][o.id] >= o.target).length;
      const sel = state.selectedQuest === n.id ? ' selected' : '';
      const group = q.choiceGroup ? `<text class="q-group" x="${n.x + 12}" y="${n.y + L.nodeH - 8}" fill="var(--fg-faint)">⎇ ${esc(q.choiceGroup)}</text>` : '';
      // 缩放自适应：极小只留状态点；较小显示短 id；正常显示完整信息
      const s = state.view.s;
      let inner;
      if (s < 0.32) {
        inner = `<circle cx="${L.nodeW / 2}" cy="${L.nodeH / 2}" r="9" fill="var(--st-${st})"></circle>`;
      } else if (s < 0.6) {
        const short = n.id.length > 10 ? n.id.slice(0, 9) + '…' : n.id;
        inner = `<circle cx="${L.nodeW - 14}" cy="13" r="5" fill="var(--st-${st})"></circle>
          <text class="q-title" x="12" y="${L.nodeH / 2 + 5}" fill="var(--fg)">${esc(short)}</text>`;
      } else {
        const title = n.id.length > 20 ? n.id.slice(0, 19) + '…' : n.id;
        inner = `<circle cx="${L.nodeW - 14}" cy="13" r="5" fill="var(--st-${st})"></circle>
          <text class="q-title" x="12" y="24" fill="var(--fg)">${esc(title)}</text>
          <text class="q-meta" x="12" y="42" fill="var(--fg-dim)">目标 ${done}/${q.objectives.length} · ${STATE_LABEL[st]}</text>
          ${group}`;
      }
      return `<g class="q-node${sel}" data-quest="${esc(n.id)}" transform="translate(${n.x},${n.y})">
        <title>${esc(n.id)}（${STATE_LABEL[st]}）</title>
        <rect class="body" width="${L.nodeW}" height="${L.nodeH}" rx="9"
          fill="var(--st-${st}-bg)" stroke="var(--st-${st})" ${st === 'failed' ? 'stroke-dasharray="5 3"' : ''}></rect>
        ${inner}
      </g>`;
    }).join('');

    // viewBox 跟随容器像素尺寸：1 用户单位 = 1 像素，平移/缩放的数学才与容器一致
    const wrapSize = $('graphWrap');
    svg.setAttribute('viewBox', `0 0 ${wrapSize.clientWidth || 800} ${wrapSize.clientHeight || 600}`);
    svg.innerHTML = `
      <defs>
        <marker id="arrow-all" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--border-strong)"></path></marker>
        <marker id="arrow-any" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--border-strong)"></path></marker>
        <marker id="arrow-all-failed" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--st-failed)"></path></marker>
        <marker id="arrow-all-claimed" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--st-claimed)"></path></marker>
        <marker id="arrow-any-failed" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--st-failed)"></path></marker>
        <marker id="arrow-any-claimed" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--st-claimed)"></path></marker>
      </defs>
      <g id="graphViewport" transform="translate(${state.view.tx},${state.view.ty}) scale(${state.view.s})">
        ${edgeHtml}${nodeHtml}
      </g>`;
  }

  function signature() { return state.quests ? state.quests.map((q) => q.id + ':' + q.requires.join('>')).join('|') : ''; }

  function fitGraph(useUserFlag) {
    if (!graphLayout) return;
    const wrap = $('graphWrap');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const L = graphLayout;
    const padX = 56, padY = 28; // 右侧留给缩放控件，上下留呼吸边距
    const s = Math.min((w - padX * 2) / L.width, (h - padY * 2) / L.height, 1.15);
    state.view.s = Math.max(.08, s);
    state.view.tx = (w - L.width * state.view.s) / 2;
    state.view.ty = (h - L.height * state.view.s) / 2;
    if (useUserFlag) state.userMovedGraph = true;
    applyView();
  }
  function applyView() {
    const g = $('graphViewport');
    if (g) g.setAttribute('transform', `translate(${state.view.tx},${state.view.ty}) scale(${state.view.s})`);
  }
  let graphRaf = null;
  function scheduleGraphRender() {
    if (graphRaf) return;
    graphRaf = requestAnimationFrame(() => {
      graphRaf = null;
      renderGraph();          // innerHTML 重建会丢失 transform
      applyView();            // 立即用最新平移/缩放补回
    });
  }

  /* 图交互：平移/缩放/点击 */
  function bindGraph() {
    const wrap = $('graphWrap');
    let drag = null;
    wrap.addEventListener('pointerdown', (ev) => {
      // 节点/边的点击交给 click；缩放控件等 UI 不启动拖拽，否则会吞掉按钮的 click
      if (ev.target.closest('.q-node, .edge-hit, .graph-controls, .legend, .empty-state')) return;
      drag = { x: ev.clientX, y: ev.clientY, tx: state.view.tx, ty: state.view.ty, moved: false };
      wrap.classList.add('dragging');
      wrap.setPointerCapture(ev.pointerId);
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.view.tx = drag.tx + dx; state.view.ty = drag.ty + dy;
      state.userMovedGraph = true;
      applyView();
    });
    wrap.addEventListener('pointerup', (ev) => {
      wrap.classList.remove('dragging');
      drag = null;
    });
    wrap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const factor = Math.exp(-ev.deltaY * .0012);
      const ns = Math.min(3, Math.max(.1, state.view.s * factor));
      state.view.tx = mx - (mx - state.view.tx) * (ns / state.view.s);
      state.view.ty = my - (my - state.view.ty) * (ns / state.view.s);
      state.view.s = ns;
      state.userMovedGraph = true;
      applyView();
      scheduleGraphRender(); // 跨文字分级阈值时切换节点标注
    }, { passive: false });
    $('graphSvg').addEventListener('click', (ev) => {
      const node = ev.target.closest('.q-node');
      if (node) {
        state.selectedQuest = node.dataset.quest;
        state.selectedEvent = null;
        switchTab('detail');
        renderGraph();
        renderDetail();
        return;
      }
      const edge = ev.target.closest('.edge-hit');
      if (edge) {
        const to = edge.dataset.edge.split('=>')[1];
        state.selectedQuest = to;
        state.selectedEvent = null;
        switchTab('detail');
        renderGraph();
        renderDetail();
      }
    });
    $('zoomIn').onclick = () => zoomAt(1.2);
    $('zoomOut').onclick = () => zoomAt(1 / 1.2);
    $('zoomFit').onclick = () => { state.userMovedGraph = false; fitGraph(false); };
    function zoomAt(f) {
      const wrap = $('graphWrap');
      const mx = wrap.clientWidth / 2, my = wrap.clientHeight / 2;
      const ns = Math.min(3, Math.max(.1, state.view.s * f));
      state.view.tx = mx - (mx - state.view.tx) * (ns / state.view.s);
      state.view.ty = my - (my - state.view.ty) * (ns / state.view.s);
      state.view.s = ns;
      renderGraph(); // 同步重建，节点文字分级随 scale 切换
    }
    window.addEventListener('resize', () => { if (!state.userMovedGraph) fitGraph(false); });
    // 初次渲染时 flex 布局可能尚未给容器定尺寸；尺寸变化后更新 viewBox 并重新适应
    let lastSize = '0x0';
    new ResizeObserver(() => {
      const key = wrap.clientWidth + 'x' + wrap.clientHeight;
      if (key === lastSize) return;
      lastSize = key;
      if (!graphLayout) return;
      if (!state.userMovedGraph) fitGraph(false);
      renderGraph(); // viewBox 需跟随新容器尺寸，状态色等也一并刷新
      applyView();  // renderGraph 重建了 DOM，补回当前 transform
    }).observe(wrap);
  }

  /* ---------------- 虚拟日志列表 ---------------- */
  let rowRenderRaf = null;
  function renderLog() {
    const scroller = $('logScroller');
    const total = state.log.length;
    const spacer = $('logSpacer');
    spacer.style.height = total * ROW_H + 'px';
    const top = scroller.scrollTop, h = scroller.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_H) - 6);
    const end = Math.min(total, Math.ceil((top + h) / ROW_H) + 6);
    const ctx = currentCtx();
    let html = '';
    for (let i = start; i < end; i++) {
      const ev = state.log[i];
      const tr = state.rt.traces[i];
      const isClaim = ev.type === 'claim';
      const summary = isClaim
        ? 'questId=' + esc(ev.questId)
        : [describeMatch(ev), ev.amount != null ? 'amount=' + ev.amount : '', ev.objectId != null ? 'objectId=' + esc(ev.objectId) : ''].filter(Boolean).join(' · ');
      const st = tr.status;
      const stLabel = { applied: '已结算', ignored: '忽略', rejected: '拒绝' }[st];
      html += `<div class="log-row st-${st} ${state.selectedEvent === i ? 'selected' : ''} ${i === state.cursor - 1 ? 'at-cursor' : ''}"
        data-idx="${i}" style="top:${i * ROW_H}px;height:${ROW_H}px">
        <span class="log-idx num">${i}</span>
        <span class="log-type ${isClaim ? 'claim' : ''}">${esc(ev.type)}</span>
        <span class="log-main">
          <div class="log-eid">${esc(ev.eventId)}</div>
          <div class="log-summary">${summary || '—'}</div>
        </span>
        <span class="log-status ${st}">${stLabel}</span>
        <span class="log-actions">
          <button data-act="edit" title="编辑">改</button>
          <button data-act="del" title="删除">删</button>
        </span>
      </div>`;
    }
    spacer.innerHTML = html;
  }
  function describeMatch(ev) {
    // 展示 type 之外携带的业务键
    const skip = new Set(['eventId', 'type', 'amount', 'objectId']);
    return Object.keys(ev).filter((k) => !skip.has(k)).map((k) => esc(k) + '=' + esc(ev[k])).join(' · ');
  }
  function bindLog() {
    const scroller = $('logScroller');
    scroller.addEventListener('scroll', () => {
      if (rowRenderRaf) return;
      rowRenderRaf = requestAnimationFrame(() => { rowRenderRaf = null; renderLog(); });
    });
    $('logSpacer').addEventListener('click', (ev) => {
      const row = ev.target.closest('.log-row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      const act = ev.target.dataset.act;
      if (act === 'edit') { openEventModal(idx); return; }
      if (act === 'del') { deleteEvent(idx); return; }
      state.selectedEvent = idx;
      state.selectedQuest = null;
      switchTab('detail');
      renderLog();
      renderDetail();
    });
  }
  function scrollToIndex(i) {
    const scroller = $('logScroller');
    const y = i * ROW_H;
    if (y < scroller.scrollTop || y + ROW_H > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
    }
  }

  /* ---------------- 详情与解释 ---------------- */
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('logScroller').hidden = tab !== 'log';
    $('tabDetail').hidden = tab !== 'detail';
    if (tab === 'detail') renderDetail();
    else requestAnimationFrame(renderLog); // 隐藏期间容器高度为 0，重新可见后需按真实窗口重渲染
  }

  function renderDetail() {
    const panel = $('tabDetail');
    if (!state.quests) { panel.innerHTML = '<p class="hint">先加载任务定义。</p>'; return; }
    const ctx = currentCtx();
    if (state.selectedEvent != null) { panel.innerHTML = eventDetailHtml(ctx); return; }
    if (state.selectedQuest) { panel.innerHTML = questDetailHtml(ctx); return; }
    panel.innerHTML = overviewHtml(ctx);
  }

  function overviewHtml(ctx) {
    const counts = { locked: 0, active: 0, ready: 0, claimed: 0, failed: 0 };
    state.quests.forEach((q) => { counts[ctx.state[q.id]]++; });
    const tiles = Object.keys(counts).map((k) =>
      `<div class="tile"><div class="num n st-${k}">${counts[k]}</div><div class="l">${STATE_LABEL[k]}</div></div>`).join('');
    const issues = state.rt.ctx.issues;
    const issueHtml = issues.length
      ? issues.slice(0, 12).map((x) => `<li class="err">#${x.index} ${esc(x.eventId || '')}：${esc(x.reason)}</li>`).join('')
        + (issues.length > 12 ? `<li class="err">…另有 ${issues.length - 12} 条，见日志中的红色行</li>` : '')
      : '<li class="ok">没有拒绝或冲突记录</li>';
    return `
      <div class="detail-section"><h3>任务状态总览（游标 ${state.cursor}/${state.log.length}）</h3>
        <div class="overview-tiles">${tiles}</div></div>
      <div class="detail-section"><h3>演算口径</h3>
        <ul class="reason-list">
          <li class="info">玩法事件只结算事件开始时 active 的任务；同一事件内新解锁的任务不追认。</li>
          <li class="info">eventId 相同且载荷一致 → 幂等忽略；载荷不一致 → 拒绝并记录位置，不计数不发奖。</li>
          <li class="info">claim 仅对 ready 有效；已 claimed 再 claim 忽略；互斥组领取后兄弟任务失效并沿依赖传播。</li>
        </ul></div>
      <div class="detail-section"><h3>拒绝 / 冲突记录</h3><ul class="reason-list">${issueHtml}</ul></div>
      <div class="detail-section"><h3>操作</h3>
        <button class="btn" id="detBulk">批量编辑日志</button>
        <button class="btn" id="detVerify">重算校验存档</button>
      </div>`;
  }

  function questDetailHtml(ctx) {
    const q = state.rt.byId[state.selectedQuest];
    const st = ctx.state[q.id];
    const objHtml = q.objectives.map((o) => {
      const p = ctx.progress[q.id][o.id];
      const pct = Math.min(100, Math.round(p / o.target * 100));
      const ids = o.kind === 'unique' ? ctx.collected[q.id][o.id] : [];
      const matchDesc = 'type=' + o.eventType + (o.match && Object.keys(o.match).length
        ? '，匹配 ' + Object.keys(o.match).map((k) => k + '=' + o.match[k]).join('、') : '（无附加匹配）');
      return `<div class="objective">
        <div class="obj-top"><span class="obj-name">${esc(o.id)} <span class="pill ${o.kind}">${o.kind === 'count' ? '计数' : '去重收集'}</span></span>
          <span class="obj-prog num">${p}/${o.target}</span></div>
        <div class="bar ${p >= o.target ? 'done' : ''}"><i style="width:${pct}%"></i></div>
        <div class="obj-desc">${esc(matchDesc)}${o.kind === 'count' ? '；每次推进 amount（缺省 1），截到 target' : '；按 objectId 去重，缺 objectId 的匹配事件会被拒绝'}</div>
        ${ids.length ? `<div class="obj-ids">${ids.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    const lockReasons = E.explainLock(ctx, q);
    const lockHtml = lockReasons.length
      ? `<ul class="reason-list">${lockReasons.map((r) => `<li class="warn">${esc(r)}</li>`).join('')}</ul>`
      : '<ul class="reason-list"><li class="ok">前置条件已满足或无前置</li></ul>';
    const rewardDesc = Object.keys(q.reward).length
      ? Object.keys(q.reward).map((k) => k + ' +' + q.reward[k]).join('，') : '无奖励';
    return `
      <div class="detail-section">
        <h3>任务</h3>
        <div class="kv">
          <span class="k">ID</span><span class="v mono">${esc(q.id)}</span>
          <span class="k">状态</span><span class="v"><span class="state-badge bg-${st}"><span class="dot ${st}"></span>${STATE_LABEL[st]}</span></span>
          <span class="k">前置</span><span class="v">${q.requires.length ? esc(q.requires.join('、')) + '（' + q.requireMode + '）' : '无，立即激活'}</span>
          <span class="k">互斥组</span><span class="v">${q.choiceGroup ? '⎇ ' + esc(q.choiceGroup) : '无'}</span>
          <span class="k">奖励</span><span class="v">${esc(rewardDesc)}</span>
        </div>
        ${st === 'ready' ? `<button class="btn primary" id="btnClaimHere" style="margin-top:10px">插入 claim 领取该任务</button>` : ''}
      </div>
      <div class="detail-section"><h3>无法解锁 / 失效原因</h3>${lockHtml}</div>
      <div class="detail-section"><h3>目标进度（游标位置）</h3>${objHtml}</div>`;
  }

  function eventDetailHtml(ctx) {
    const i = state.selectedEvent;
    const ev = state.log[i];
    const tr = state.rt.traces[i];
    const stCls = { applied: 'ok', ignored: 'warn', rejected: 'err' }[tr.status];
    const reasonItems = tr.reasons.length
      ? tr.reasons.map((r) => `<li class="info">${esc(r)}</li>`).join('') : '<li class="ok">无附加说明</li>';
    const changeItems = tr.changes.length
      ? tr.changes.map((c) => `<div class="change-line">
          <span class="path">${esc(c.questId)}/${esc(c.objectiveId)} <span class="pill ${c.kind}">${c.kind === 'count' ? '计数' : '去重'}</span></span>
          <span class="num">${c.from} → ${c.to}/${c.target}${c.kind === 'unique' ? '（' + esc(c.objectId) + '）' : '（+' + c.amount + '）'}</span>
        </div>`).join('') : '<div class="obj-desc">该事件没有产生目标进度变化</div>';
    const transItems = tr.transitions.length
      ? tr.transitions.map((t) => `<li class="${t.to === 'failed' ? 'err' : t.to === 'claimed' ? 'ok' : 'info'}">
          <b class="mono">${esc(t.questId)}</b>：${STATE_LABEL[t.from]} → ${STATE_LABEL[t.to]}<br><span class="obj-desc">${esc(t.reason)}</span></li>`).join('')
      : '<li class="ok">没有任务状态迁移</li>';
    const reward = tr.reward && Object.keys(tr.reward).length
      ? Object.keys(tr.reward).map((k) => k + ' +' + tr.reward[k]).join('，') : '无';
    return `
      <div class="detail-section"><h3>日志 #${i} <span class="state-badge bg-${tr.status === 'rejected' ? 'failed' : tr.status === 'ignored' ? 'locked' : 'claimed'}"><span class="dot ${tr.status === 'rejected' ? 'failed' : tr.status === 'ignored' ? 'locked' : 'claimed'}"></span>${{ applied: '已结算', ignored: '幂等忽略', rejected: '拒绝' }[tr.status]}</span></h3>
        <ul class="reason-list"><li class="${stCls}">${esc(tr.reasons[0] || '事件已正常结算')}</li></ul>
        <div class="kv" style="margin-top:8px">
          <span class="k">eventId</span><span class="v mono">${esc(ev.eventId)}</span>
          <span class="k">type</span><span class="v mono">${esc(ev.type)}</span>
          ${ev.type === 'claim' ? `<span class="k">questId</span><span class="v mono">${esc(ev.questId)}</span>` : ''}
          <span class="k">奖励入账</span><span class="v">${esc(reward)}</span>
        </div>
        <details style="margin-top:8px"><summary class="obj-desc" style="cursor:pointer">查看事件完整载荷</summary>
          <pre class="mono" style="background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:8px;overflow-x:auto;font-size:12px">${esc(JSON.stringify(ev, null, 2))}</pre></details>
      </div>
      <div class="detail-section"><h3>目标变化</h3>${changeItems}</div>
      <div class="detail-section"><h3>状态迁移与原因</h3><ul class="reason-list">${transItems}</ul></div>
      <div class="detail-section"><h3>全部说明</h3><ul class="reason-list">${reasonItems}</ul></div>
      <div class="detail-section">
        <button class="btn" id="evEdit">编辑此事件</button>
        <button class="btn danger" id="evDelete">删除此事件</button>
        <button class="btn ghost" id="evLocate">在日志中定位</button>
      </div>`;
  }

  function bindDetailDelegation() {
    $('tabDetail').addEventListener('click', (ev) => {
      if (ev.target.id === 'btnClaimHere') {
        openClaimModal(state.selectedQuest);
      } else if (ev.target.id === 'evEdit') {
        openEventModal(state.selectedEvent);
      } else if (ev.target.id === 'evDelete') {
        deleteEvent(state.selectedEvent);
      } else if (ev.target.id === 'evLocate') {
        switchTab('log');
        scrollToIndex(state.selectedEvent);
        renderLog();
      } else if (ev.target.id === 'detBulk') {
        openBulkModal();
      } else if (ev.target.id === 'detVerify') {
        openVerifyModal();
      }
    });
  }

  /* ---------------- 模态框框架 ---------------- */
  function modal({ title, wide, body, footer }) {
    closeModal();
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon ghost" id="modalClose">✕</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div></div>`;
    $('modalClose').onclick = closeModal;
    root.querySelector('.modal-backdrop').addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('modal-backdrop')) closeModal();
    });
    return root.querySelector('.modal');
  }
  function closeModal() { $('modalRoot').innerHTML = ''; }

  /* ---------------- 事件录入 / 编辑 ---------------- */
  function nextEventId() {
    let max = -1;
    state.log.forEach((e) => {
      const m = /^e(\d+)$/.exec(e.eventId || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'e' + (max + 1);
  }
  function knownEventTypes() {
    const s = new Set();
    state.quests.forEach((q) => q.objectives.forEach((o) => s.add(o.eventType)));
    return [...s];
  }

  function openEventModal(editIdx) {
    const editing = editIdx != null;
    const ev = editing ? clone(state.log[editIdx]) : { eventId: nextEventId(), type: '' };
    const matchPairs = Object.keys(ev).filter((k) => !['eventId', 'type', 'amount', 'objectId', 'questId'].includes(k))
      .map((k) => [k, String(ev[k])]);
    const datalist = knownEventTypes().map((t) => `<option value="${esc(t)}">`).join('');
    const m = modal({
      title: editing ? '编辑日志 #' + editIdx : '录入玩法事件（插入到游标位置）',
      body: `
      <div id="evFormErr"></div>
      <div class="field-row">
        <div class="field"><label>eventId（重传判定键）</label><input id="fEventId" type="text" value="${esc(ev.eventId)}"></div>
        <div class="field"><label>事件 type</label><input id="fType" type="text" list="typeList" value="${esc(ev.type)}" placeholder="如 kill / collect"><datalist id="typeList">${datalist}</datalist></div>
      </div>
      <div class="field-row">
        <div class="field"><label>amount（可选，正整数，缺省 1）</label><input id="fAmount" type="number" min="1" step="1" value="${ev.amount != null ? ev.amount : ''}"></div>
        <div class="field"><label>objectId（unique 目标必填）</label><input id="fObjectId" type="text" value="${ev.objectId != null ? esc(ev.objectId) : ''}"></div>
      </div>
      <div class="field"><label>严格匹配键值（事件须逐键等于目标 match）</label>
        <div id="matchRows"></div>
        <button class="btn sm" id="btnAddMatch" type="button">+ 添加匹配键</button>
      </div>`,
      footer: `<button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mSave">${editing ? '保存并重算' : '插入并演算'}</button>`
    });
    const rowsEl = m.querySelector('#matchRows');
    function addRow(k, v) {
      const row = document.createElement('div');
      row.className = 'match-row';
      row.innerHTML = `<input type="text" placeholder="键，如 tag" value="${esc(k || '')}">
        <input type="text" placeholder="值（数字/true/false 自动转型）" value="${esc(v || '')}">
        <button class="btn sm danger" type="button">删</button>`;
      row.querySelector('button').onclick = () => row.remove();
      rowsEl.appendChild(row);
    }
    matchPairs.forEach(([k, v]) => addRow(k, v));
    if (!matchPairs.length) addRow('tag', '');
    m.querySelector('#btnAddMatch').onclick = () => addRow('', '');
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mSave').onclick = () => {
      const errEl = m.querySelector('#evFormErr');
      const built = {
        eventId: m.querySelector('#fEventId').value.trim(),
        type: m.querySelector('#fType').value.trim()
      };
      const amountRaw = m.querySelector('#fAmount').value.trim();
      if (amountRaw !== '') {
        if (!/^\d+$/.test(amountRaw) || Number(amountRaw) < 1) {
          errEl.innerHTML = '<div class="modal-error">amount 必须是正整数</div>'; return;
        }
        built.amount = Number(amountRaw);
      }
      const objRaw = m.querySelector('#fObjectId').value.trim();
      if (objRaw !== '') built.objectId = objRaw;
      let bad = false;
      rowsEl.querySelectorAll('.match-row').forEach((row) => {
        const ins = row.querySelectorAll('input');
        const k = ins[0].value.trim(), v = ins[1].value.trim();
        if (!k) return;
        if (v === '') { bad = true; errEl.innerHTML = '<div class="modal-error">匹配键「' + esc(k) + '」的值不能为空</div>'; return; }
        built[k] = parseScalar(v);
      });
      if (bad) return;
      if (!built.eventId || !built.type) {
        errEl.innerHTML = '<div class="modal-error">eventId 与 type 均为必填</div>'; return;
      }
      if (editing) {
        state.log[editIdx] = built;
        closeModal();
        recompute(state.cursor);
        state.selectedEvent = editIdx;
        renderLog(); renderDetail();
        explainIfRejected(editIdx);
      } else {
        state.log.splice(state.cursor, 0, built);
        const idx = state.cursor;
        closeModal();
        recompute(idx + 1);
        state.selectedEvent = idx;
        switchTab('detail');
        scrollToIndex(idx);
        renderLog(); renderDetail();
        explainIfRejected(idx);
      }
    };
  }

  function parseScalar(v) {
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }

  function explainIfRejected(idx) {
    const tr = state.rt.traces[idx];
    if (tr.status === 'rejected') toast('事件被拒绝：' + tr.reasons[0], 'err');
    else if (tr.status === 'ignored') toast('事件幂等忽略：' + tr.reasons[0], 'warn');
    else toast('已结算，目标变化 ' + tr.changes.length + ' 处，状态迁移 ' + tr.transitions.length + ' 处', 'ok');
  }

  function deleteEvent(idx) {
    const keep = idx < state.cursor ? state.cursor - 1 : state.cursor;
    state.log.splice(idx, 1);
    state.selectedEvent = null;
    recompute(keep);
    toast('已删除 #' + idx + ' 并按完整日志重新演算');
  }

  /* ---------------- claim 录入 ---------------- */
  function openClaimModal(preselectQuest) {
    const ctx = currentCtx();
    const ready = state.quests.filter((q) => ctx.state[q.id] === 'ready');
    let maxClaim = -1;
    state.log.forEach((e) => {
      const m = /^claim-(\d+)$/.exec(e.eventId || '');
      if (m) maxClaim = Math.max(maxClaim, Number(m[1]));
    });
    const suggestId = 'claim-' + (maxClaim + 1);
    const m = modal({
      title: '录入领取事件 claim（插入到游标位置）',
      body: `
      <div id="claimErr"></div>
      <div class="field"><label>eventId</label><input id="cEventId" type="text" value="${suggestId}"></div>
      <div class="field"><label>questId</label><input id="cQuestId" type="text" value="${esc(preselectQuest || '')}" list="readyList">
        <datalist id="readyList">${ready.map((q) => `<option value="${esc(q.id)}">`).join('')}</datalist></div>
      <div class="field"><label>当前游标下可领取（ready）的任务</label>
        <div class="sample-grid">${ready.length ? ready.map((q) => {
          const r = Object.keys(q.reward).map((k) => k + ' +' + q.reward[k]).join('，') || '无奖励';
          return `<button class="sample-card" data-pick="${esc(q.id)}"><b>${esc(q.id)}</b><span>${esc(r)}</span></button>`;
        }).join('') : '<span class="obj-desc">当前没有 ready 任务；claim 非 ready 任务会被业务拒绝（可用于演练拒绝路径）。</span>'}</div>
      </div>`,
      footer: `<button class="btn ghost" id="cCancel">取消</button><button class="btn primary" id="cSave">插入并演算</button>`
    });
    m.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => { m.querySelector('#cQuestId').value = b.dataset.pick; };
    });
    m.querySelector('#cCancel').onclick = closeModal;
    m.querySelector('#cSave').onclick = () => {
      const built = {
        eventId: m.querySelector('#cEventId').value.trim(),
        type: 'claim',
        questId: m.querySelector('#cQuestId').value.trim()
      };
      if (!built.eventId || !built.questId) {
        m.querySelector('#claimErr').innerHTML = '<div class="modal-error">eventId 与 questId 均为必填</div>';
        return;
      }
      state.log.splice(state.cursor, 0, built);
      const idx = state.cursor;
      closeModal();
      recompute(idx + 1);
      state.selectedEvent = idx;
      switchTab('detail');
      scrollToIndex(idx);
      renderLog(); renderDetail();
      explainIfRejected(idx);
    };
  }

  /* ---------------- 批量编辑日志 ---------------- */
  function openBulkModal() {
    const m = modal({
      title: '批量编辑事件日志（修改历史后以完整新日志重算，不保留旧尾部状态）',
      wide: true,
      body: `<div id="bulkErr"></div>
        <div class="field"><textarea id="bulkText" rows="18">${esc(JSON.stringify(state.log, null, 2))}</textarea></div>
        <div class="obj-desc">粘贴完整事件数组后保存，演算结果等价于用新日志从零连续执行。</div>`,
      footer: `<button class="btn ghost" id="bCancel">取消</button><button class="btn primary" id="bSave">整体替换并重算</button>`
    });
    m.querySelector('#bCancel').onclick = closeModal;
    m.querySelector('#bSave').onclick = () => {
      let parsed;
      try { parsed = JSON.parse(m.querySelector('#bulkText').value); }
      catch (e) { m.querySelector('#bulkErr').innerHTML = '<div class="modal-error">JSON 解析失败：' + esc(e.message) + '</div>'; return; }
      if (!Array.isArray(parsed)) {
        m.querySelector('#bulkErr').innerHTML = '<div class="modal-error">日志必须是事件数组</div>'; return;
      }
      const r = loadWorkspace(state.quests, parsed, parsed.length);
      if (!r.ok) { m.querySelector('#bulkErr').innerHTML = '<div class="modal-error">' + r.errors.map(esc).join('<br>') + '</div>'; return; }
      closeModal();
      toast('日志已整体替换，重算 ' + parsed.length + ' 条事件');
    };
  }

  /* ---------------- 任务定义编辑 ---------------- */
  function openQuestsModal() {
    const m = modal({
      title: '任务定义（JSON）',
      wide: true,
      body: `<div id="qErr"></div>
        <div class="field"><textarea id="questsText" rows="20">${esc(JSON.stringify(state.quests || [], null, 2))}</textarea></div>
        <div class="obj-desc">字段：id、requires、requireMode(all/any)、choiceGroup（空串表示无）、objectives(1~16 个)、reward。定义不得含重复 ID、未知前置或依赖环。</div>`,
      footer: `<button class="btn ghost" id="qCancel">取消</button><button class="btn primary" id="qSave">校验并装载</button>`
    });
    m.querySelector('#qCancel').onclick = closeModal;
    m.querySelector('#qSave').onclick = () => {
      let parsed;
      try { parsed = JSON.parse(m.querySelector('#questsText').value); }
      catch (e) { m.querySelector('#qErr').innerHTML = '<div class="modal-error">JSON 解析失败：' + esc(e.message) + '</div>'; return; }
      const r = loadWorkspace(parsed, state.log, state.log.length);
      if (!r.ok) { m.querySelector('#qErr').innerHTML = '<div class="modal-error">' + r.errors.map(esc).join('<br>') + '</div>'; return; }
      closeModal();
      toast('任务定义已装载：' + parsed.length + ' 个任务');
    };
  }

  /* ---------------- 样例加载 ---------------- */
  function openSamplesModal() {
    const m = modal({
      title: '加载样例',
      body: `<div class="sample-grid">
        <button class="sample-card" data-sample="branch"><b>互斥分支样例</b><span>5 任务 / 6 事件，含重复 claim、去重收集与 expected 期望终态</span></button>
        <button class="sample-card" data-sample="stress"><b>压力样例</b><span>200 任务 / 5000 事件，验证规模与重放性能</span></button>
        <button class="sample-card" data-sample="cycle"><b>非法依赖环样例</b><span>装载应被定义校验拒绝，用于演示错误解释</span></button>
      </div>
      <div style="margin-top:14px"><button class="btn danger" id="clearDraft">清空本地草稿并重置</button></div>`,
      footer: `<button class="btn ghost" id="sCancel">关闭</button>`
    });
    m.querySelector('#sCancel').onclick = closeModal;
    m.querySelector('#clearDraft').onclick = () => {
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      closeModal();
      boot(true);
      toast('本地草稿已清空');
    };
    m.querySelectorAll('[data-sample]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.sample;
        try {
          const resp = await fetch('data/' + name + '.json');
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          if (name === 'cycle') {
            const r = E.validateQuests(data.quests);
            modal({
              title: '定义校验按预期拒绝了该样例',
              body: `<ul class="reason-list">${r.errors.map((x) => '<li class="err">' + esc(x) + '</li>').join('')}</ul>
                <div class="obj-desc">含依赖环的任务定义不会进入演算；修正环后才能装载。</div>`,
              footer: '<button class="btn primary" id="okClose">知道了</button>'
            });
            $('okClose').onclick = () => openSamplesModal();
            return;
          }
          const r = loadWorkspace(data.quests, data.events, data.events.length);
          if (!r.ok) throw new Error(r.errors.join('；'));
          closeModal();
          toast('已加载「' + (name === 'branch' ? '互斥分支样例' : '压力样例') + '」');
          if (name === 'branch') checkExpected(data);
        } catch (e) {
          toast('样例加载失败：' + e.message, 'err');
        }
      };
    });
  }

  function checkExpected(data) {
    if (!data.expected) return;
    const ctx = state.rt.ctx;
    const ok = Object.keys(data.expected.states).every((k) => ctx.state[k] === data.expected.states[k])
      && ctx.balances.gold === data.expected.gold
      && ctx.progress.next.c === data.expected.nextCount
      && ctx.progress.either.d === data.expected.uniqueCount;
    toast(ok ? 'branch 样例终态与包内 expected 完全一致' : '警告：终态与 expected 不一致', ok ? 'ok' : 'err');
  }

  /* ---------------- 导入 / 导出 / 校验 ---------------- */
  function openImportModal() {
    const m = modal({
      title: '导入存档或原始数据（JSON 文件 / 粘贴）',
      wide: true,
      body: `
      <div id="impMsg"></div>
      <div class="field"><label>从文件选择</label><input type="file" id="impFile" accept=".json,application/json"></div>
      <div class="field"><label>或粘贴 JSON</label><textarea id="impText" rows="10" placeholder='{"format":"quest-branch-replayer-save/v1",...} 或 {"quests":[...],"events":[...]}'></textarea></div>`,
      footer: `<button class="btn ghost" id="iCancel">取消</button><button class="btn primary" id="iSave">导入并演算</button>`
    });
    m.querySelector('#iCancel').onclick = closeModal;
    m.querySelector('#iSave').onclick = () => applyImport(m.querySelector('#impText').value, m.querySelector('#impMsg'));
    m.querySelector('#impFile').onchange = () => {
      const f = m.querySelector('#impFile').files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { m.querySelector('#impText').value = String(reader.result); };
      reader.readAsText(f);
    };
  }
  function applyImport(text, msgEl) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { msgEl.innerHTML = '<div class="modal-error">JSON 解析失败：' + esc(e.message) + '</div>'; return; }
    if (data && data.format === 'quest-branch-replayer-save/v1') {
      const v = E.verifySave(data);
      if (!v.ok) {
        msgEl.innerHTML = '<div class="modal-error">存档自校验未通过，已拒绝导入：<br>' + v.problems.map(esc).join('<br>') + '</div>';
        return;
      }
      const r = loadWorkspace(data.quests, data.log, data.cursor);
      if (!r.ok) { msgEl.innerHTML = '<div class="modal-error">' + r.errors.map(esc).join('<br>') + '</div>'; return; }
      closeModal();
      toast('存档已恢复至游标 ' + data.cursor + '/' + data.log.length + '，重算校验通过', 'ok');
      return;
    }
    if (data && Array.isArray(data.quests) && Array.isArray(data.events)) {
      const r = loadWorkspace(data.quests, data.events, data.events.length);
      if (!r.ok) { msgEl.innerHTML = '<div class="modal-error">' + r.errors.map(esc).join('<br>') + '</div>'; return; }
      closeModal();
      toast('原始数据已装载：' + data.quests.length + ' 任务 / ' + data.events.length + ' 事件');
      return;
    }
    msgEl.innerHTML = '<div class="modal-error">无法识别的数据结构：需要存档 format=quest-branch-replayer-save/v1，或含 quests/events 的对象</div>';
  }

  function openExportModal() {
    const save = E.exportSave(state.rt, state.cursor);
    const text = JSON.stringify(save, null, 2);
    const m = modal({
      title: '完整存档导出（含任务进度、unique 集合、奖励、已见事件、日志位置）',
      wide: true,
      body: `
      <div class="obj-desc" style="margin-bottom:8px">游标 ${save.cursor}/${save.log.length} 处的状态快照；导入时会重放日志逐项自校验。复制文本保存，或尝试下载文件（部分内嵌环境会拦截下载，以复制为准）。</div>
      <div class="field"><textarea id="expText" rows="16" readonly>${esc(text)}</textarea></div>`,
      footer: `
        <button class="btn" id="expCopy">复制存档</button>
        <button class="btn" id="expDownload">下载 .json</button>
        <button class="btn ghost" id="expClose">关闭</button>`
    });
    m.querySelector('#expClose').onclick = closeModal;
    m.querySelector('#expCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('存档已复制到剪贴板', 'ok');
      } catch (_) {
        const ta = m.querySelector('#expText');
        ta.focus(); ta.select();
        toast('剪贴板不可用，请手动全选复制', 'warn');
      }
    };
    m.querySelector('#expDownload').onclick = () => {
      try {
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'quest-replayer-save.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (_) { toast('下载被环境拦截，请改用复制', 'warn'); }
    };
  }

  function openVerifyModal() {
    const save = E.exportSave(state.rt, state.cursor);
    const v = E.verifySave(save);
    const expect = save.bundle;
    const actual = v.runtime ? v.runtime.ctx : null;
    const lines = [];
    function line(label, ok, detail) {
      lines.push(`<div class="check-line ${ok ? 'good' : 'bad'}"><span class="mark">${ok ? '✓' : '✗'}</span><span>${esc(label)}${detail ? '：' + esc(detail) : ''}</span></div>`);
    }
    line('任务定义校验（重复 ID / 未知前置 / 依赖环 / 目标数）', E.validateQuests(save.quests).ok);
    if (actual) {
      line('任务状态 state', E.stableStringify(expect.state) === E.stableStringify(actual.state));
      line('计数进度 progress', E.stableStringify(expect.progress) === E.stableStringify(actual.progress));
      line('unique 收集集合', E.stableStringify(normCol(expect.collected)) === E.stableStringify(normCol(actual.collected)));
      line('奖励余额 balances', E.stableStringify(expect.balances) === E.stableStringify(actual.balances));
      line('已见事件 seen（幂等依据）', E.stableStringify(expect.seen) === E.stableStringify(actual.seen));
      line('拒绝/冲突 issues', E.stableStringify(expect.issues.map(slim)) === E.stableStringify(actual.issues.map(slim)));
    }
    // 恢复后继续执行 == 连续执行：用完整日志重放与当前运行时末尾比对
    const full = E.replay(save.quests, save.log);
    const tailConsistent = E.stableStringify(full.ctx.state) === E.stableStringify(state.rt.ctx.state)
      && E.stableStringify(full.ctx.balances) === E.stableStringify(state.rt.ctx.balances);
    line('恢复后继续执行与连续执行一致（完整日志重放比对）', tailConsistent);
    modal({
      title: '存档重算校验',
      body: `${v.ok ? '<div class="modal-success">游标 ' + save.cursor + ' 处快照与日志重放结果全部一致，存档可信。</div>'
        : '<div class="modal-error">发现不一致：<br>' + v.problems.map(esc).join('<br>') + '</div>'}
        ${lines.join('')}
        <div class="obj-desc" style="margin-top:8px">校验方法：丢弃快照内的运行态，仅用任务定义 + 日志从零重放到游标，再逐字段比对快照。</div>`,
      footer: '<button class="btn primary" id="vClose">关闭</button>'
    });
    $('vClose').onclick = closeModal;
  }
  function slim(x) { return { index: x.index, eventId: x.eventId, kind: x.kind, reason: x.reason }; }
  function normCol(col) {
    const out = {};
    Object.keys(col || {}).forEach((qid) => {
      out[qid] = {};
      Object.keys(col[qid]).forEach((oid) => { out[qid][oid] = (col[qid][oid] || []).slice().sort(); });
    });
    return out;
  }

  /* ---------------- 主题 ---------------- */
  function initTheme() {
    let t = '';
    try { t = JSON.parse(localStorage.getItem(LS_KEY) || '{}').theme || ''; } catch (_) {}
    if (t) document.documentElement.dataset.theme = t;
    $('btnTheme').onclick = () => {
      const dark = document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      scheduleDraft();
    };
  }

  /* ---------------- 总渲染与绑定 ---------------- */
  function renderAll() {
    renderBalances();
    renderCursor();
    renderGraph();
    renderLog();
    renderDetail();
  }

  function bindToolbar() {
    $('btnSamples').onclick = openSamplesModal;
    $('btnQuests').onclick = openQuestsModal;
    $('btnImport').onclick = openImportModal;
    $('btnExport').onclick = openExportModal;
    $('btnVerify').onclick = openVerifyModal;
    $('btnAddEvent').onclick = () => openEventModal(null);
    $('btnAddClaim').onclick = () => openClaimModal(null);
    $('btnBulkEdit').onclick = openBulkModal;
    $('cursorSlider').addEventListener('input', (e) => setCursor(Number(e.target.value)));
    $('btnFirst').onclick = () => setCursor(0);
    $('btnPrev').onclick = () => setCursor(state.cursor - 1);
    $('btnNext').onclick = () => setCursor(state.cursor + 1);
    $('btnLast').onclick = () => setCursor(state.log.length);
    document.querySelectorAll('.tab').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ($('modalRoot').children.length) { if (e.key === 'Escape') closeModal(); return; }
      if (e.key === 'ArrowLeft') setCursor(state.cursor - 1);
      if (e.key === 'ArrowRight') setCursor(state.cursor + 1);
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot(forceSample) {
    let draft = null;
    if (!forceSample) {
      try { draft = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { draft = null; }
    }
    if (draft && Array.isArray(draft.quests)) {
      const r = loadWorkspace(draft.quests, draft.log || [], draft.cursor);
      if (r.ok) { toast('已恢复本地草稿（可靠存档请用导出/导入）'); return; }
    }
    try {
      const resp = await fetch('data/branch.json');
      const data = await resp.json();
      const r = loadWorkspace(data.quests, data.events, data.events.length);
      if (r.ok) checkExpected(data);
    } catch (e) {
      $('graphEmpty').hidden = false;
      $('graphEmpty').innerHTML = '<div>样例数据加载失败：' + esc(e.message) + '</div><div>可通过「任务定义」手动粘贴 JSON 开始</div>';
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    bindToolbar();
    bindGraph();
    bindLog();
    bindDetailDelegation();
    // 热更新：保存/恢复现场
    try {
      if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
        window.claude.hot.snapshot(() => ({ quests: state.quests, log: state.log, cursor: state.cursor }));
      }
    } catch (_) {}
    const start = (data) => {
      if (data && data.quests) loadWorkspace(data.quests, data.log || [], data.cursor);
      else boot(false);
    };
    if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start);
    else start(window.claude && window.claude.hot ? window.claude.hot.data : null);
  });
})();
