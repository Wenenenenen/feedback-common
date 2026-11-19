/* ---------------------------------------------------------------------------
   UI layer for the ECS barrier inspector. Pure DOM, no framework.
--------------------------------------------------------------------------- */
(function () {
  'use strict';
  const E = window.ECSEngine;
  const { World, helpers } = E;
  const COMPONENTS = E.constants.COMPONENTS;
  const FIELDS = E.constants.FIELDS;
  const DEFAULT_FIELDS = {
    Position: { x: 0, y: 0 },
    Velocity: { x: 0, y: 0 },
    Health: { value: 10 },
    Poison: { amount: 1 },
    Frozen: {},
    Spawner: { period: 1, vx: 1, vy: 0 },
  };

  let world = new World();
  const state = {
    tab: 'prototypes',
    selected: null,        // {slot, generation}
    query: { include: [], exclude: [] },
    pages: { prototypes: {}, events: 0, query: 0, slots: 0 },
    eventTypes: new Set(['cmd', 'syscmd', 'migrate', 'integrate', 'damage', 'spawn', 'destroy']),
    eventsOnlyErrors: false,
    locate: null,
    demo: true,
    toastTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    if (typeof n !== 'number') return esc(n);
    if (!Number.isInteger(n)) return esc(n);
    const neg = n < 0;
    const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '-' : '') + s;
  };
  const hex8 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
  const compColorVar = (name) => 'var(--c-' + name.toLowerCase() + ')';

  // ---------------------------------------------------------------- elements
  function handleHTML(h, opts) {
    if (!h) return '';
    const lg = opts && opts.large ? ' handle-lg' : '';
    const live = !(opts && opts.plain);
    const attrs = live ? ' data-slot="' + h.slot + '" data-gen="' + h.generation + '" role="button" tabindex="0" title="按句柄定位  slot ' + h.slot + ', generation ' + h.generation + '"' : '';
    const cls = 'handle' + lg + (live ? ' is-live' : '');
    return '<span class="' + cls + '"' + attrs + '><span class="slot">' + h.slot + '</span><span class="sep">:</span><span class="gen">' + h.generation + '</span></span>';
  }
  function compChip(name) {
    return '<span class="comp" data-comp="' + name + '">' + name + '</span>';
  }
  function compList(names) {
    if (!names.length) return '<span class="comp comp-none">空原型</span>';
    return names.map(compChip).join('');
  }
  function valueText(name, v) {
    if (!v) return '';
    return FIELDS[name].map((f) => f + ' ' + fmt(v[f])).join(' · ');
  }
  function valuesInline(values) {
    const names = Object.keys(values);
    if (!names.length) return '<span class="dim">无组件</span>';
    return names.map((n) => {
      const t = valueText(n, values[n]);
      return '<span class="vgrp">' + compChip(n) + (t ? '<span class="vtext">' + esc(t) + '</span>' : '') + '</span>';
    }).join('');
  }
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' is-' + kind : '');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  // ---------------------------------------------------------------- clock strip
  function renderChrome() {
    const s = world.stats();
    $('m-tick').textContent = fmt(s.tick);
    $('m-alive').textContent = fmt(s.alive);
    $('m-ext').textContent = fmt(s.externalPending);
    $('m-sys').textContent = fmt(s.systemPending);
    $('m-proto').textContent = s.prototypes + ' / ' + s.slots;
    $('m-digest').textContent = s.eventDigest;
    document.querySelector('.metric-clock').classList.toggle('is-hot', s.tick > 0);
    $('m-ext').parentElement.classList.toggle('is-hot', s.externalPending > 0);
    $('m-sys').parentElement.classList.toggle('is-hot', s.systemPending > 0);

    $('q-ext-count').textContent = s.externalPending;
    $('q-sys-count').textContent = s.systemPending;
    const nextSeq = world.nextSuggestedSeq();
    $('seq-hint').textContent = '下一个 ' + nextSeq;
    const seqEl = $('seq-input');
    if (!form.seqTouched && document.activeElement !== seqEl && String(nextSeq) !== seqEl.value) {
      seqEl.value = nextSeq;
      updatePreview();
    }

    const demoNote = state.demo ? '<span class="dim">示例世界 · </span>' : '';
    const r = world.lastTickReport;
    if (!r) {
      $('laststep').innerHTML = '<span class="dim">尚未执行 tick。录入命令后单步。</span>';
    } else {
      const bits = [
        'tick ' + r.tick + ' 结束：外部 ' + r.external.count + '（失败 ' + r.external.failed + '）',
        'integrate ' + r.integrate.count + (r.integrate.overflow ? ' / 溢出 ' + r.integrate.overflow : ''),
        'damage ' + r.damage.count + (r.damage.queuedDestroy ? ' → 待销毁 ' + r.damage.queuedDestroy : ''),
        'emit ' + r.emit.count,
        '结构命令 ' + r.structural.count + '（失败 ' + r.structural.failed + '）',
        '存活 ' + world.aliveCount,
      ];
      const bad = r.external.failed + r.structural.failed + r.integrate.overflow + r.damage.overflow;
      $('laststep').innerHTML = demoNote + (bad ? '<span class="warn">⚠ </span>' : '') + esc(bits.join(' · ')) +
        (bad ? ' <span class="bad">本轮有 ' + bad + ' 处失败或溢出，见事件轨迹</span>' : '');
    }
  }

  // ---------------------------------------------------------------- queues
  function renderQueues() {
    const ext = world.externalPending.slice(0, 60);
    $('q-ext').innerHTML = ext.length
      ? ext.map((c) => {
        const detail = c.op === 'create'
          ? compKeyText(c.components)
          : (c.handle ? handleHTML(c.handle, { plain: true }) + ' ' + esc(c.component || '') : '');
        return '<li><span class="q-seq">' + esc(c.seq) + '</span><span class="q-op">' + esc(c.op) + '</span><span class="q-detail">' + detail + '</span></li>';
      }).join('') + (world.externalPending.length > 60 ? '<li class="queue-empty">…还有 ' + (world.externalPending.length - 60) + ' 条</li>' : '')
      : '<li class="queue-empty">队列为空</li>';

    const sys = world.systemPending.slice(0, 60);
    $('q-sys').innerHTML = sys.length
      ? sys.map((c) => {
        const detail = c.op === 'create'
          ? (c.parent ? '父 ' + handleHTML(c.parent, { plain: true }) + ' ' : '') + compKeyText(c.components)
          : (c.handle ? '销毁 ' + handleHTML(c.handle, { plain: true }) : '');
        return '<li><span class="q-seq">#' + esc(c.iseq) + '</span><span class="q-op">' + esc(c.op) + '</span><span class="q-detail">' + detail + '</span></li>';
      }).join('') + (world.systemPending.length > 60 ? '<li class="queue-empty">…还有 ' + (world.systemPending.length - 60) + ' 条</li>' : '')
      : '<li class="queue-empty">队列为空</li>';
  }
  function compKeyText(components) {
    const names = Object.keys(components || {});
    if (!names.length) return '<span class="dim">空原型</span>';
    return names.map((n) => '<span class="vgrp">' + compChip(n) + '</span>').join('');
  }

  // ---------------------------------------------------------------- panels
  const PANELS = {
    prototypes: renderPrototypes,
    query: renderQuery,
    migrations: renderMigrations,
    events: renderEvents,
    slots: renderSlots,
  };

  function renderPanel() {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === state.tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    const panel = $('panel');
    panel.setAttribute('aria-labelledby', 'tab-' + state.tab);
    panel.innerHTML = PANELS[state.tab]();
  }

  // ---- prototypes ----------------------------------------------------------
  function renderPrototypes() {
    const protos = world.prototypesView();
    if (!protos.length) {
      return '<div class="panel-head"><h2>原型与列</h2><p class="hint">每个不同的组件组合是一个原型，组件字段按列连续存储，句柄经 slot→(原型, 行) 映射。</p></div>' +
        '<div class="empty-note">世界还没有实体。载入样例或创建一条命令，然后单步。</div>';
    }
    protos.sort((a, b) => b.mask - a.mask);
    const total = protos.reduce((n, p) => n + p.count, 0);
    let html = '<div class="panel-head"><h2>原型与列</h2><p class="hint">每个不同的组件组合是一个原型；组件字段按列连续存储，句柄经 slot→(原型, 行) 映射。移动实体会迁移原型并重写映射。</p></div>';
    html += '<div class="panel-subhead"><h3>原型 ' + protos.length + ' 个</h3><span class="meta">共 ' + total + ' 行 · 迁出原型时行尾实体换位到空出的行</span></div>';
    html += '<div class="proto-list">';
    for (const p of protos) {
      const open = state.pages.prototypes[p.key] ? state.pages.prototypes[p.key].open : false;
      const page = state.pages.prototypes[p.key] ? state.pages.prototypes[p.key].page : 0;
      html += '<div class="proto' + (open ? ' is-open' : '') + '">';
      html += '<button class="proto-head" type="button" data-proto="' + esc(p.key) + '">';
      html += '<span class="proto-caret">▸</span>';
      html += '<span class="chipset">' + compList(p.components) + '</span>';
      html += '<span class="proto-meta"><span>mask ' + p.mask + '</span><span class="cnt">' + fmt(p.count) + ' 行</span></span>';
      html += '</button>';
      if (open) html += '<div class="proto-body">' + prototypeColumns(p, page) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function prototypeColumns(p, page) {
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(p.count / pageSize));
    const pg = Math.min(page, pages - 1);
    const start = pg * pageSize;
    const end = Math.min(p.count, start + pageSize);
    let html = '';
    if (!p.count) {
      html += '<div class="edge-none">没有行。原型保留以展示迁移边，但不含实体。</div>';
      return html;
    }
    html += '<div class="table-wrap"><table class="grid"><thead><tr><th>行</th><th>slot:gen</th>';
    for (const name of p.components) {
      for (const f of FIELDS[name]) html += '<th class="comp-col" data-comp="' + name + '">' + name + '.' + f + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (let r = start; r < end; r++) {
      const h = { slot: p.slots[r], generation: p.generations[r] };
      const sel = state.selected && state.selected.slot === h.slot && state.selected.generation === h.generation;
      html += '<tr class="is-row' + (sel ? ' is-selected' : '') + '" data-slot="' + h.slot + '" data-gen="' + h.generation + '">';
      html += '<td class="rowno">' + r + '</td><td>' + handleHTML(h, { plain: true }) + '</td>';
      for (const name of p.components) {
        for (const f of FIELDS[name]) {
          html += '<td class="num">' + fmt(p.columns[name][f][r]) + '</td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="pager"><span>第 ' + (start + 1) + '–' + end + ' 行 / 共 ' + fmt(p.count) + ' · 列存储按行号连续</span><span class="pager-btns">';
    html += '<button type="button" data-proto-page="' + esc(p.key) + '" data-delta="-1"' + (pg === 0 ? ' disabled' : '') + '>上一页</button>';
    html += '<button type="button" data-proto-page="' + esc(p.key) + '" data-delta="1"' + (pg >= pages - 1 ? ' disabled' : '') + '>下一页</button>';
    html += '</span></div>';
    return html;
  }

  function toggleProto(mask) {
    const cur = state.pages.prototypes[mask] || { open: false, page: 0 };
    cur.open = !cur.open;
    state.pages.prototypes[mask] = cur;
    renderPanel();
  }
  function pageProto(mask, delta) {
    const cur = state.pages.prototypes[mask] || { open: true, page: 0 };
    cur.page = Math.max(0, cur.page + delta);
    cur.open = true;
    state.pages.prototypes[mask] = cur;
    renderPanel();
  }

  // ---- query ---------------------------------------------------------------
  function renderQuery() {
    const inc = state.query.include, exc = state.query.exclude;
    let html = '<div class="panel-head"><h2>查询</h2><p class="hint">点击组件在 包含 → 排除 → 忽略 之间切换。一个组件只能在一侧，包含集与排除集不会交叠；结果按 slot、generation 稳定排序。</p></div>';
    html += '<div class="query-builder">';
    html += '<div class="qrow"><span class="rowlabel">组件</span>' + chipRow() + '</div>';
    html += '<div class="qrow"><span class="rowlabel">条件</span>' + querySummary() + '</div>';
    html += '<div class="qrow"><span class="rowlabel">预设</span>';
    html += '<button class="preset-btn" type="button" data-preset="move">Position+Velocity 且无 Frozen</button>';
    html += '<button class="preset-btn" type="button" data-preset="damage">Health+Poison</button>';
    html += '<button class="preset-btn" type="button" data-preset="spawn">Spawner+Position</button>';
    html += '<button class="preset-btn" type="button" data-preset="all">全部存活</button>';
    html += '<button class="preset-btn" type="button" data-preset="clear">清空</button>';
    html += '</div>';
    html += '</div>';

    let rows = [];
    let err = null;
    try { rows = world.query(inc, exc); } catch (e) { err = e.message; }
    if (err) {
      html += '<div class="result-head"><span class="count">查询非法：' + esc(err) + '</span></div>';
      return html;
    }
    const pageSize = 25;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const pg = Math.min(state.pages.query, pages - 1);
    const start = pg * pageSize;
    const view = rows.slice(start, start + pageSize);
    html += '<div class="result-head"><span class="count"><b>' + fmt(rows.length) + '</b> 个实体</span>';
    html += '<span class="order">排序 slot ↑, generation ↑ · ' + (inc.length ? '+' + inc.join(' +') : '无包含条件') + (exc.length ? ' −' + exc.join(' −') : '') + '</span></div>';
    if (!rows.length) {
      html += '<div class="empty-note">没有实体匹配。原型包含全部包含组件且不含任何排除组件才会入选。</div>';
      return html;
    }
    html += '<div class="table-wrap"><table class="grid"><thead><tr><th>#</th><th>句柄</th><th>原型</th><th>组件值</th></tr></thead><tbody>';
    view.forEach((ent, i) => {
      const sel = state.selected && state.selected.slot === ent.slot && state.selected.generation === ent.generation;
      html += '<tr class="is-row' + (sel ? ' is-selected' : '') + '" data-slot="' + ent.slot + '" data-gen="' + ent.generation + '">';
      html += '<td class="rowno">' + (start + i + 1) + '</td>';
      html += '<td>' + handleHTML(ent) + '</td>';
      html += '<td><span class="chipset">' + compList(helpers.namesOfMask(ent.mask)) + '</span></td>';
      html += '<td class="val">' + valuesInline(ent.values) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="pager"><span>第 ' + (start + 1) + '–' + Math.min(rows.length, start + pageSize) + ' / ' + fmt(rows.length) + '</span><span class="pager-btns">';
    html += '<button type="button" data-qpage="-1"' + (pg === 0 ? ' disabled' : '') + '>上一页</button>';
    html += '<button type="button" data-qpage="1"' + (pg >= pages - 1 ? ' disabled' : '') + '>下一页</button>';
    html += '</span></div>';
    return html;
  }
  function chipRow() {
    return COMPONENTS.map((name) => {
      const inInc = state.query.include.includes(name);
      const inExc = state.query.exclude.includes(name);
      const st = inInc ? 'include' : inExc ? 'exclude' : 'none';
      const label = inInc ? '含' : inExc ? '排' : '';
      return '<button class="qchip" type="button" data-qcomp="' + name + '" data-state="' + st + '" data-comp="' + name + '" aria-pressed="' + (st !== 'none') + '">' +
        (label ? '<span class="qstate">' + label + '</span>' : '') + name + '</button>';
    }).join('');
  }
  function querySummary() {
    const inc = state.query.include, exc = state.query.exclude;
    if (!inc.length && !exc.length) return '<span class="dim" style="font-family:var(--mono);font-size:11px">无包含条件 · 返回全部存活实体</span>';
    const part = (label, names, cls) => '<span class="vgrp" style="gap:5px"><span class="dim" style="font-family:var(--mono);font-size:10px">' + label + '</span>' +
      (names.length ? names.map((n) => '<span class="comp" data-comp="' + n + '">' + n + '</span>').join('') : '<span class="dim" style="font-family:var(--mono);font-size:11px">—</span>') + '</span>';
    return part('包含', inc) + part('排除', exc);
  }

  // ---- migrations ----------------------------------------------------------
  function renderMigrations() {
    const last = world.lastTickReport;
    let html = '<div class="panel-head"><h2>迁移与屏障</h2><p class="hint">一次 tick 的顺序固定：外部命令 → integrate → damage → emit → 结构命令屏障 → tick+1。结构变更在屏障后才生效，所以待销毁的生成器当步仍会生成子体。</p></div>';

    // barrier pipeline
    const steps = last ? [
      { k: '外部命令 flush', v: last.external.count, sub: '失败 ' + last.external.failed },
      { k: 'integrate', v: last.integrate.count, sub: 'P+V，无 Frozen' },
      { k: 'damage', v: last.damage.count, sub: '待销毁 ' + last.damage.queuedDestroy },
      { k: 'emit', v: last.emit.count, sub: 'Spawner+Position' },
      { k: '结构命令 flush', v: last.structural.count, sub: '失败 ' + last.structural.failed },
    ] : [
      { k: '外部命令 flush', v: 0, sub: '—' },
      { k: 'integrate', v: 0, sub: '—' },
      { k: 'damage', v: 0, sub: '—' },
      { k: 'emit', v: 0, sub: '—' },
      { k: '结构命令 flush', v: 0, sub: '—' },
    ];
    html += '<div class="panel-subhead"><h3>最近一次 tick 的屏障</h3><span class="meta">' + (last ? 'tick ' + last.tick : '尚未执行') + '</span></div>';
    html += '<div class="table-wrap"><table class="grid"><thead><tr><th>序</th><th>阶段</th><th>处理实体/命令</th><th>说明</th></tr></thead><tbody>';
    steps.forEach((s, i) => {
      html += '<tr><td class="rowno">' + (i + 1) + '</td><td class="mono">' + esc(s.k) + '</td><td class="num">' + fmt(s.v) + '</td><td class="dim">' + esc(s.sub) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // migration edges from events
    const edges = new Map();
    for (const e of world.events) {
      if (e.type !== 'migrate') continue;
      const key = e.from + ' → ' + e.to + ' · ' + e.cause;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
    html += '<div class="panel-subhead"><h3>原型迁移边</h3><span class="meta">来自当前保留的事件轨迹</span></div>';
    if (!edges.size) {
      html += '<div class="empty-note">还没有迁移。对实体 add 或 remove 组件会迁移原型。</div>';
    } else {
      html += '<div class="edges">';
      for (const [key, count] of [...edges.entries()].sort((a, b) => b[1] - a[1])) {
        const parts = key.split(' → ');
        const [to, cause] = [parts[1].split(' · ')[0], parts[1].split(' · ')[1]];
        html += '<div class="edge"><span class="chipset">' + protoChips(parts[0]) + '</span>';
        html += '<span class="edge-arrow">→</span>';
        html += '<span class="chipset">' + protoChips(to) + '</span>';
        html += '<span class="edge-spacer"></span><span class="edge-cause">' + esc(cause || '') + '</span><span class="edge-count">×' + fmt(count) + '</span></div>';
      }
      html += '</div>';
    }

    const migs = world.events.filter((e) => e.type === 'migrate').slice(-40).reverse();
    html += '<div class="panel-subhead"><h3>最近迁移</h3><span class="meta">最新在前</span></div>';
    if (!migs.length) html += '<div class="empty-note">没有迁移记录。</div>';
    else {
      html += '<div class="table-wrap"><table class="grid"><thead><tr><th>tick</th><th>句柄</th><th>迁移（从 → 到）</th><th>原因</th></tr></thead><tbody>';
      for (const e of migs) {
        const sel = state.selected && state.selected.slot === e.handle.slot && state.selected.generation === e.handle.generation;
        html += '<tr class="is-row' + (sel ? ' is-selected' : '') + '" data-slot="' + e.handle.slot + '" data-gen="' + e.handle.generation + '">';
        html += '<td class="rowno">' + e.tick + '</td><td>' + handleHTML(e.handle, { plain: true }) + '</td>';
        html += '<td class="val"><span class="mig-cell"><span class="chipset">' + protoChips(e.from) + '</span>' +
          '<span class="edge-arrow">→</span><span class="chipset">' + protoChips(e.to) + '</span></span></td>';
        html += '<td class="dim">' + esc(e.cause) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    return html;
  }
  function protoChips(key) {
    if (!key || key === '(空)') return '<span class="comp comp-none">空原型</span>';
    return key.split('+').map(compChip).join('');
  }

  // ---- events --------------------------------------------------------------
  const EVENT_LABEL = {
    cmd: '外部命令', syscmd: '系统命令', migrate: '迁移', integrate: '移动',
    damage: '伤害', spawn: '生成', destroy: '销毁', create: '创建', queue: '入队',
    overflow: '溢出', tick: 'tick',
  };
  function eventText(e) {
    switch (e.type) {
      case 'cmd': {
        if (e.ok) {
          if (e.op === 'create') return 'seq ' + e.seq + ' create ' + (e.handle ? handleHTML(e.handle) : '') + ' <span class="evmeta">' + esc(e.mask !== undefined ? helpers.maskKey(e.mask) : '') + '</span>';
          return 'seq ' + e.seq + ' ' + esc(e.op);
        }
        return 'seq ' + (e.seq === null ? '?' : e.seq) + ' ' + esc(e.op || '?') + ' <span class="evreason">✕ ' + esc(e.reason || '') + '</span>';
      }
      case 'syscmd': {
        const head = '#' + e.iseq + ' ' + esc(e.op);
        if (!e.ok) return head + ' <span class="evreason">✕ ' + esc(e.reason || '') + '</span>';
        return head + (e.handle ? ' ' + handleHTML(e.handle) : '');
      }
      case 'migrate':
        return handleHTML(e.handle) + ' <span class="evmeta">' + esc(e.cause) + '</span> <span class="chipset">' + protoChips(e.from) + '</span> <span class="evmeta">→</span> <span class="chipset">' + protoChips(e.to) + '</span>';
      case 'integrate':
        return handleHTML(e.handle) + ' <span class="evmeta">(' + e.from.x + ', ' + e.from.y + ') → (' + e.to.x + ', ' + e.to.y + ')</span>';
      case 'damage':
        return handleHTML(e.handle) + ' <span class="evmeta">生命 ' + e.from + ' − ' + e.amount + ' = ' + e.to + '</span>' + (e.queuedDestroy ? ' <span class="badge badge-destroy">排入销毁</span>' : '');
      case 'spawn':
        return '父 ' + handleHTML(e.parent) + ' <span class="evmeta">生成</span> <span class="chipset">' + protoChips(helpers.maskKey(helpers.maskOf(Object.keys(e.components)))) + '</span>';
      case 'destroy':
        return handleHTML(e.handle, { plain: true }) + ' <span class="evmeta">gen ' + e.fromGen + ' → ' + e.handle.generation + ' · ' + esc(e.cause) + '</span>';
      case 'create':
        return handleHTML(e.handle, { plain: true }) + ' <span class="chipset">' + protoChips(helpers.maskKey(e.mask)) + '</span>';
      case 'queue':
        return '#' + e.iseq + ' ' + esc(e.op) + ' ' + (e.handle ? handleHTML(e.handle, { plain: true }) : '');
      case 'overflow':
        return handleHTML(e.handle, { plain: true }) + ' <span class="evmeta">' + esc(e.system) + ' · ' + esc(e.detail) + '</span>';
      case 'tick':
        if (e.phase === 'start') return '开始 <span class="evmeta">flush 外部命令并依次运行 integrate / damage / emit</span>';
        return '结束 <span class="evmeta">外部 ' + e.summary.external + ' · 移动 ' + e.summary.integrate + ' · 伤害 ' + e.summary.damage + ' · 生成 ' + e.summary.spawned + ' · 结构 ' + e.summary.structural + ' · 存活 ' + e.summary.alive + '</span>';
      default:
        return esc(e.type);
    }
  }
  function eventHasHandle(e) {
    return !!(e.handle || e.parent);
  }
  function renderEvents() {
    const all = world.events;
    const filtered = all.filter((e) => {
      if (!state.eventTypes.has(e.type)) return false;
      if (state.eventsOnlyErrors && !(e.type === 'overflow' || (e.type === 'cmd' && !e.ok) || (e.type === 'syscmd' && !e.ok))) return false;
      return true;
    });
    let html = '<div class="panel-head"><h2>事件轨迹</h2><p class="hint">每个 tick 的全部步骤按发生顺序记录。点击带句柄的事件可在右侧定位实体。</p></div>';
    html += '<div class="evtools"><div class="typechips">';
    for (const t of ['cmd', 'syscmd', 'migrate', 'integrate', 'damage', 'spawn', 'destroy', 'overflow', 'tick']) {
      const on = state.eventTypes.has(t);
      html += '<button class="tchip" type="button" data-etype="' + t + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(EVENT_LABEL[t] || t) + '</button>';
    }
    html += '</div><label class="errtoggle"><input type="checkbox" id="only-errors"' + (state.eventsOnlyErrors ? ' checked' : '') + '> 只看失败与溢出</label></div>';

    const pageSize = 80;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const pg = Math.min(state.pages.events, pages - 1);
    const end = filtered.length - pg * pageSize;
    const start = Math.max(0, end - pageSize);
    const view = filtered.slice(start, end).reverse();
    html += '<div class="result-head"><span class="count"><b>' + fmt(filtered.length) + '</b> 条事件</span><span class="order">累计 ' + fmt(world.stats().events) + ' 条 · 内存保留最近 ' + fmt(all.length) + ' 条' +
      (world.eventsTruncated ? ' · 快照未含更早的 ' + fmt(world.eventsTruncated) + ' 条' : '') + '</span></div>';
    if (!filtered.length) {
      html += '<div class="empty-note">没有符合筛选条件的事件。</div>';
      return html;
    }
    html += '<div class="eventlist">';
    for (const e of view) {
      const cls = 'ev' + (eventHasHandle(e) ? ' has-entity' : '');
      const h = e.handle || e.parent;
      const attrs = eventHasHandle(e) ? ' data-slot="' + h.slot + '" data-gen="' + h.generation + '"' : '';
      html += '<div class="' + cls + '"' + attrs + '>';
      html += '<span class="evtick"><span>t' + e.tick + '</span><span class="evi">#' + e.i + '</span></span>';
      let typeCls = 'badge-' + e.type;
      let typeLabel = EVENT_LABEL[e.type] || e.type;
      if (e.type === 'cmd' || e.type === 'syscmd') {
        typeCls = e.ok ? 'badge-ok' : 'badge-err';
        typeLabel = e.ok ? '成功' : '失败';
      }
      html += '<span><span class="badge ' + typeCls + '">' + esc(typeLabel) + '</span></span>';
      html += '<span class="evbody">' + eventText(e) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="pager"><span>第 ' + (start + 1) + '–' + end + ' 条 / ' + fmt(filtered.length) + '（最新在前）</span><span class="pager-btns">';
    html += '<button type="button" data-epage="-1"' + (pg === 0 ? ' disabled' : '') + '>较新</button>';
    html += '<button type="button" data-epage="1"' + (pg >= pages - 1 ? ' disabled' : '') + '>较旧</button>';
    html += '</span></div>';
    return html;
  }

  // ---- slots ---------------------------------------------------------------
  function renderSlots() {
    const slots = world.slotView();
    let html = '<div class="panel-head"><h2>槽与代数</h2><p class="hint">销毁只把该槽的 generation 加 1 并放回空槽堆；分配总是取最小空槽，否则扩展。旧句柄的代数不再匹配，读写一律失败。</p></div>';
    if (!slots.length) return html + '<div class="empty-note">还没有分配任何槽。</div>';
    const pageSize = 40;
    const pages = Math.max(1, Math.ceil(slots.length / pageSize));
    const pg = Math.min(state.pages.slots, pages - 1);
    const start = pg * pageSize;
    const end = Math.min(slots.length, start + pageSize);
    html += '<div class="panel-subhead"><h3>槽表</h3><span class="meta">' + fmt(slots.length) + ' 个槽 · ' + fmt(world.aliveCount) + ' 存活 · ' + (slots.length - world.aliveCount) + ' 空槽</span></div>';
    html += '<div class="table-wrap"><table class="grid"><thead><tr><th>slot</th><th>generation</th><th>状态</th><th>原型</th><th>行</th><th>句柄</th></tr></thead><tbody>';
    for (let i = start; i < end; i++) {
      const s = slots[i];
      const h = { slot: s.slot, generation: s.generation };
      const sel = state.selected && state.selected.slot === s.slot && state.selected.generation === s.generation;
      html += '<tr class="is-row' + (sel ? ' is-selected' : '') + '" data-slot="' + s.slot + '" data-gen="' + s.generation + '">';
      html += '<td class="num">' + s.slot + '</td>';
      html += '<td class="num" style="color:var(--signal)">' + s.generation + '</td>';
      html += '<td>' + (s.alive ? '<span class="badge badge-ok">存活</span>' : '<span class="badge">空槽</span>') + '</td>';
      html += '<td class="chipset">' + (s.alive ? compList(helpers.namesOfMask(s.mask)) : '<span class="dim">—</span>') + '</td>';
      html += '<td class="num">' + (s.alive ? s.row : '—') + '</td>';
      html += '<td>' + (s.alive ? handleHTML(h) : '<span class="dim" style="font-family:var(--mono)">' + s.slot + ':' + s.generation + '</span>') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="pager"><span>第 ' + (start + 1) + '–' + end + ' / ' + fmt(slots.length) + '</span><span class="pager-btns">';
    html += '<button type="button" data-spage="-1"' + (pg === 0 ? ' disabled' : '') + '>上一页</button>';
    html += '<button type="button" data-spage="1"' + (pg >= pages - 1 ? ' disabled' : '') + '>下一页</button>';
    html += '</span></div>';
    return html;
  }

  // ---------------------------------------------------------------- inspector
  function renderInspector() {
    renderEntity();
    renderStats();
    renderLocate();
  }

  function renderEntity() {
    const out = $('entity-out');
    if (!state.selected) {
      out.innerHTML = '<div class="empty-note">尚未选择实体。点击任意句柄，或在上方按 slot/generation 定位。</div>';
      return;
    }
    const view = world.entityView(state.selected);
    if (!view.valid) {
      out.innerHTML = '<div class="invalid-state"><strong>' + esc(view.error) + '</strong>' +
        '<p>句柄 ' + state.selected.slot + ':' + state.selected.generation + ' 不能指向任何存活实体。' +
        (view.error === '过期句柄' ? '该槽已被复用，代数已增加；旧引用不能修改新实体。' : '') + '</p></div>';
      return;
    }
    const slotRow = world.slotView()[view.handle.slot];
    let html = '<div class="entity-head">' + handleHTML(view.handle, { large: true });
    html += '<span class="badge badge-ok">有效</span>';
    html += '<button class="btn btn-quiet" type="button" id="btn-use-handle">填入表单句柄</button>';
    html += '</div>';
    html += '<div class="entity-key chipset">' + compList(view.components) + '</div>';
    html += '<div class="entity-facts">';
    html += '<span class="k">原型 mask</span><span class="v">' + view.mask + '</span>';
    html += '<span class="k">槽 gen</span><span class="v">' + slotRow.generation + '</span>';
    html += '<span class="k">行号 / 行数</span><span class="v">' + view.row + ' / ' + view.rowCount + '</span>';
    html += '<span class="k">槽总数</span><span class="v">' + view.slotCount + '</span>';
    html += '</div>';
    if (view.components.length) {
      html += '<table class="value-table"><thead><tr><th>组件</th><th>字段</th><th style="text-align:right">值</th></tr></thead><tbody>';
      for (const name of view.components) {
        const v = view.values[name];
        FIELDS[name].forEach((f, i) => {
          html += '<tr><td>' + (i === 0 ? compChip(name) : '') + '</td><td class="dim">' + f + '</td><td class="n">' + fmt(v[f]) + '</td></tr>';
        });
        if (!FIELDS[name].length) html += '<tr><td>' + compChip(name) + '</td><td class="dim">—</td><td class="n dim">标记</td></tr>';
      }
      html += '</tbody></table>';
    }
    // recent history for this slot
    const hist = world.events.filter((e) => {
      const h = e.handle || e.parent;
      return h && h.slot === view.handle.slot;
    }).slice(-10).reverse();
    if (hist.length) {
      html += '<div><div class="panel-subhead" style="margin-top:4px"><h3>该槽最近事件</h3></div><ul class="timeline">';
      for (const e of hist) {
        html += '<li><span class="tt">t' + e.tick + '</span><span>' + eventText(e) + '</span></li>';
      }
      html += '</ul></div>';
    }
    out.innerHTML = html;
    const btn = $('btn-use-handle');
    if (btn) btn.addEventListener('click', () => {
      $('slot-input').value = view.handle.slot;
      $('gen-input').value = view.handle.generation;
      $('loc-slot').value = view.handle.slot;
      $('loc-gen').value = view.handle.generation;
      toast('已填入句柄 ' + view.handle.slot + ':' + view.handle.generation, 'ok');
    });
  }

  function renderStats() {
    const s = world.stats();
    const rows = [
      ['tick', fmt(s.tick), 'accent'],
      ['存活实体', fmt(s.alive) + ' / 10 000', ''],
      ['槽总数', fmt(s.slots), ''],
      ['空槽', fmt(s.freeSlots), ''],
      ['原型', fmt(s.prototypes), ''],
      ['下一个分配槽', fmt(s.nextHandleSlot), ''],
      ['externalPending', fmt(s.externalPending), ''],
      ['systemPending', fmt(s.systemPending), ''],
      ['seq 历史', fmt(s.externalSeqHistory), ''],
      ['内部命令计数', fmt(s.internalCounter), ''],
      ['事件总数', fmt(s.events), ''],
      ['事件指纹', s.eventDigest, 'digest'],
    ];
    $('stats-out').innerHTML = rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd class="' + r[2] + '">' + esc(r[1]) + '</dd>').join('');
  }

  function renderLocate() {
    const out = $('locate-out');
    if (!state.locate) { out.innerHTML = ''; return; }
    const view = world.entityView(state.locate);
    if (!view.valid) {
      out.innerHTML = '<div class="loc-card is-bad"><div class="loc-title">' + handleHTML(state.locate, { plain: true }) +
        '<span class="loc-msg">' + esc(view.error) + '</span></div>' +
        '<div class="loc-detail">代数不匹配或槽为空。请使用当前代数，或从表格/事件中点选句柄。</div></div>';
      return;
    }
    out.innerHTML = '<div class="loc-card"><div class="loc-title">' + handleHTML(view.handle, { large: true }) +
      '<span class="loc-ok">已定位</span></div>' +
      '<div class="loc-detail">' + esc(view.key) + '<br>原型 mask ' + view.mask + ' · 行 ' + view.row + ' / ' + view.rowCount + '</div></div>';
  }

  // ---------------------------------------------------------------- full render
  function renderAll() {
    renderChrome();
    renderQueues();
    renderPanel();
    renderInspector();
    renderSnapshotInfo();
  }

  // ---------------------------------------------------------------- selection
  function selectEntity(slot, gen) {
    state.selected = { slot: Number(slot), generation: Number(gen) };
    state.locate = { slot: Number(slot), generation: Number(gen) };
    $('loc-slot').value = slot;
    $('loc-gen').value = gen;
    renderInspector();
    renderPanel();
  }

  document.addEventListener('click', (ev) => {
    const protoHead = ev.target.closest('[data-proto]');
    if (protoHead) { toggleProto(protoHead.dataset.proto); return; }
    const protoPage = ev.target.closest('[data-proto-page]');
    if (protoPage) { pageProto(protoPage.dataset.protoPage, Number(protoPage.dataset.delta)); return; }
    const h = ev.target.closest('[data-slot][data-gen]');
    if (h) {
      if (ev.target.closest('button, input, select, a')) return;
      selectEntity(h.dataset.slot, h.dataset.gen);
      return;
    }
    const tab = ev.target.closest('.tab');
    if (tab) { switchTab(tab.dataset.tab); return; }

    const qchip = ev.target.closest('[data-qcomp]');
    if (qchip) { cycleQuery(qchip.dataset.qcomp); return; }
    const preset = ev.target.closest('[data-preset]');
    if (preset) { applyPreset(preset.dataset.preset); return; }
    const qp = ev.target.closest('[data-qpage]');
    if (qp) { state.pages.query = Math.max(0, state.pages.query + Number(qp.dataset.qpage)); renderPanel(); return; }
    const ep = ev.target.closest('[data-epage]');
    if (ep) { state.pages.events = Math.max(0, state.pages.events + Number(ep.dataset.epage)); renderPanel(); return; }
    const sp = ev.target.closest('[data-spage]');
    if (sp) { state.pages.slots = Math.max(0, state.pages.slots + Number(sp.dataset.spage)); renderPanel(); return; }
    const et = ev.target.closest('[data-etype]');
    if (et) {
      const t = et.dataset.etype;
      if (state.eventTypes.has(t)) state.eventTypes.delete(t); else state.eventTypes.add(t);
      if (!state.eventTypes.size) state.eventTypes.add(t);
      state.pages.events = 0;
      renderPanel();
      return;
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const h = ev.target.closest && ev.target.closest('[data-slot][data-gen]');
    if (h && h.getAttribute('tabindex') === '0') {
      ev.preventDefault();
      selectEntity(h.dataset.slot, h.dataset.gen);
    }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target && ev.target.id === 'only-errors') {
      state.eventsOnlyErrors = ev.target.checked;
      state.pages.events = 0;
      renderPanel();
    }
  });

  function switchTab(name) {
    state.tab = name;
    renderPanel();
    try { localStorage.setItem('ecs.tab', name); } catch (e) { /* private mode */ }
  }

  function cycleQuery(name) {
    const inc = state.query.include, exc = state.query.exclude;
    const inInc = inc.indexOf(name), inExc = exc.indexOf(name);
    if (inInc >= 0) { inc.splice(inInc, 1); exc.push(name); }
    else if (inExc >= 0) { exc.splice(inExc, 1); }
    else { inc.push(name); }
    // The sets must stay disjoint: a component is include XOR exclude.
    for (const n of exc.slice()) if (inc.includes(n)) exc.splice(exc.indexOf(n), 1);
    state.pages.query = 0;
    renderPanel();
  }
  function applyPreset(kind) {
    const set = (i, e) => { state.query.include = i.slice(); state.query.exclude = e.slice(); state.pages.query = 0; renderPanel(); };
    if (kind === 'move') set(['Position', 'Velocity'], ['Frozen']);
    else if (kind === 'damage') set(['Health', 'Poison'], []);
    else if (kind === 'spawn') set(['Spawner', 'Position'], []);
    else if (kind === 'all') set([], []);
    else set([], []);
  }

  // ---------------------------------------------------------------- command form
  const form = {
    op: 'create',
    component: 'Velocity',
    createInclude: { Position: true, Velocity: true, Health: false, Poison: false, Frozen: false, Spawner: false },
    values: JSON.parse(JSON.stringify(DEFAULT_FIELDS)),
    seqTouched: false,
  };

  function buildValueInputs(container, name, prefix) {
    container.innerHTML = FIELDS[name].map((f) =>
      '<label class="field" style="flex:1 1 70px"><span class="label">' + f + '</span>' +
      '<input class="input" type="number" step="1" inputmode="numeric" data-vfield="' + f + '" value="' + form.values[name][f] + '"></label>'
    ).join('') || '<span class="hint">Frozen 没有字段，是一个标记组件。</span>';
    container.className = 'field-row';
  }

  function buildForm() {
    const op = $('op-select').value;
    form.op = op;
    const needsHandle = op !== 'create';
    $('handle-row').hidden = !needsHandle;
    $('component-row').hidden = !(op === 'add' || op === 'remove' || op === 'set');
    const showValue = op === 'add' || op === 'set';
    $('value-fields').hidden = !showValue;
    $('create-components').hidden = op !== 'create';
    if (showValue) {
      buildValueInputs($('value-fields'), $('component-select').value, 'v');
    }
    if (op === 'create') {
      const wrap = $('create-components');
      wrap.innerHTML = '<span class="label" style="display:block;margin-bottom:5px">组件组合（构成原型）</span>' +
        COMPONENTS.map((name) => {
          const on = form.createInclude[name];
          return '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-family:var(--mono);font-size:11px;cursor:pointer">' +
            '<input type="checkbox" data-create-comp="' + name + '"' + (on ? ' checked' : '') + ' style="accent-color:var(--accent)">' +
            compChip(name) + '<span class="dim" style="font-size:10px">' + (FIELDS[name].length ? FIELDS[name].join(', ') : '—') + '</span></label>' +
            (on && FIELDS[name].length ? '<div style="display:flex;gap:6px;margin:0 0 4px 22px">' +
              FIELDS[name].map((f) => '<label style="display:flex;align-items:center;gap:3px;font-family:var(--mono);font-size:10px;color:var(--faint)">' + f +
                '<input class="input" style="width:64px;padding:3px 5px" type="number" step="1" inputmode="numeric" data-create-field="' + name + '.' + f + '" value="' + form.values[name][f] + '"></label>').join('') +
              '</div>' : '');
        }).join('');
    }
    if (!form.seqTouched) $('seq-input').value = world.nextSuggestedSeq();
    updatePreview();
  }

  function readFormCommand() {
    const op = form.op;
    const cmd = { seq: Number($('seq-input').value), op };
    if (op !== 'create') {
      const slot = Number($('slot-input').value);
      const generation = Number($('gen-input').value);
      cmd.handle = { slot, generation };
    }
    if (op === 'create') {
      const comps = {};
      for (const name of COMPONENTS) {
        if (!form.createInclude[name]) continue;
        const v = {};
        for (const f of FIELDS[name]) {
          const el = document.querySelector('[data-create-field="' + name + '.' + f + '"]');
          v[f] = el ? Number(el.value) : form.values[name][f];
        }
        comps[name] = v;
      }
      cmd.components = comps;
    } else if (op === 'add' || op === 'set') {
      cmd.component = $('component-select').value;
      const v = {};
      for (const f of FIELDS[cmd.component]) {
        const el = document.querySelector('[data-vfield="' + f + '"]');
        v[f] = el ? Number(el.value) : form.values[cmd.component][f];
      }
      cmd.value = v;
    } else if (op === 'remove') {
      cmd.component = $('component-select').value;
    }
    return cmd;
  }

  function updatePreview() {
    try {
      $('cmd-preview').textContent = JSON.stringify(readFormCommand());
    } catch (e) {
      $('cmd-preview').textContent = '(无法生成预览)';
    }
  }

  function setFormMsg(msg, kind) {
    const el = $('form-msg');
    el.textContent = msg || '';
    el.className = 'form-msg' + (kind ? ' ' + kind : '');
  }

  $('op-select').addEventListener('change', () => {
    buildForm();
    setFormMsg('');
  });
  $('component-select').addEventListener('change', () => {
    buildForm();
  });
  $('seq-input').addEventListener('input', () => {
    form.seqTouched = true;
    updatePreview();
  });
  $('seq-input').addEventListener('blur', () => {
    if ($('seq-input').value === '') { form.seqTouched = false; $('seq-input').value = world.nextSuggestedSeq(); }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.dataset && (t.dataset.createField || t.dataset.vfield)) {
      const [name, f] = t.dataset.createField ? t.dataset.createField.split('.') : [null, t.dataset.vfield];
      if (name) form.values[name][f] = Number(t.value);
      updatePreview();
    }
    if (t.id === 'slot-input' || t.id === 'gen-input') updatePreview();
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.createComp) {
      form.createInclude[t.dataset.createComp] = t.checked;
      const keep = t.dataset.createComp;
      buildForm();
      // restore focus to the same checkbox after the rebuild
      const again = document.querySelector('[data-create-comp="' + keep + '"]');
      if (again) again.focus();
    }
  });

  $('btn-enqueue').addEventListener('click', () => {
    const cmd = readFormCommand();
    try {
      world.enqueueExternal([cmd]);
      setFormMsg('已加入队列 · seq ' + cmd.seq + ' · 下一次单步在 tick 开头执行', 'ok');
      form.seqTouched = false;
      buildForm();
      renderChrome();
      renderQueues();
      renderSnapshotInfo();
      toast('已加入 externalPending', 'ok');
    } catch (err) {
      setFormMsg(err.message, 'err');
    }
  });
  $('btn-clear-form').addEventListener('click', () => {
    form.createInclude = { Position: true, Velocity: true, Health: false, Poison: false, Frozen: false, Spawner: false };
    form.values = JSON.parse(JSON.stringify(DEFAULT_FIELDS));
    form.seqTouched = false;
    $('slot-input').value = 0;
    $('gen-input').value = 1;
    buildForm();
    setFormMsg('');
  });

  // batch
  $('btn-batch-enqueue').addEventListener('click', () => {
    const raw = $('batch-input').value.trim();
    const msg = $('batch-msg');
    let list = pendingBatch;
    if (!list) {
      if (!raw) { msg.textContent = '先粘贴命令数组或载入样例。'; msg.className = 'form-msg warn'; return; }
      try { list = JSON.parse(raw); } catch (e) { msg.textContent = 'JSON 解析失败：' + e.message; msg.className = 'form-msg err'; return; }
      if (list && !Array.isArray(list) && Array.isArray(list.commands)) list = list.commands;
      if (!Array.isArray(list)) { msg.textContent = '需要一个命令数组。'; msg.className = 'form-msg err'; return; }
    }
    try {
      let stale = 0, dupes = 0;
      const seen = new Set();
      for (const c of list) {
        const q = c && c.seq;
        if (!Number.isInteger(q)) continue;
        if (world.externalSeqHistory.has(q)) stale++;
        else if (seen.has(q)) dupes++;
        seen.add(q);
      }
      world.enqueueExternal(list);
      msg.textContent = '已加入 ' + list.length + ' 条命令，等待下一次单步。' +
        (stale ? ' 其中 ' + stale + ' 条 seq 已被使用过，执行时会被拒绝。' : '') +
        (dupes ? ' 其中 ' + dupes + ' 条 seq 与同批命令重复。' : '');
      msg.className = 'form-msg ' + (stale || dupes ? 'warn' : 'ok');
      pendingBatch = null;
      $('sample-msg').textContent = '';
      renderChrome(); renderQueues(); renderSnapshotInfo();
      toast('已加入 ' + list.length + ' 条命令', 'ok');
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
    }
  });
  $('btn-batch-format').addEventListener('click', () => {
    const msg = $('batch-msg');
    try {
      const v = JSON.parse($('batch-input').value);
      $('batch-input').value = JSON.stringify(v, null, 2);
      msg.textContent = '已格式化。';
      msg.className = 'form-msg ok';
    } catch (e) {
      msg.textContent = 'JSON 解析失败：' + e.message;
      msg.className = 'form-msg err';
    }
  });

  // ---------------------------------------------------------------- samples
  function sampleCommands(kind) {
    if (kind === 'demo') {
      return [
        { seq: 1, op: 'create', components: { Position: { x: 0, y: 0 }, Velocity: { x: 2, y: 1 }, Health: { value: 6 } } },
        { seq: 2, op: 'create', components: { Position: { x: 10, y: 0 }, Velocity: { x: -1, y: 0 }, Health: { value: 5 }, Poison: { amount: 2 } } },
        { seq: 3, op: 'create', components: { Position: { x: 3, y: 3 }, Velocity: { x: 0, y: 1 }, Spawner: { period: 2, vx: 1, vy: 0 }, Health: { value: 4 } } },
        { seq: 4, op: 'add', handle: { slot: 0, generation: 1 }, component: 'Poison', value: { amount: 1 } },
        { seq: 5, op: 'add', handle: { slot: 1, generation: 1 }, component: 'Frozen', value: {} },
        { seq: 6, op: 'set', handle: { slot: 2, generation: 1 }, component: 'Health', value: { value: 3 } },
      ];
    }
    if (kind === 'reuse') return [
      { seq: 1, op: 'create', components: { Position: { x: 0, y: 0 } } },
      { seq: 2, op: 'create', components: { Health: { value: 10 } } },
      { seq: 3, op: 'destroy', handle: { slot: 0, generation: 1 } },
      { seq: 4, op: 'create', components: { Position: { x: 7, y: 8 } } },
      { seq: 5, op: 'set', handle: { slot: 0, generation: 1 }, component: 'Position', value: { x: 99, y: 99 } },
    ];
    if (kind === 'barrier') return [
      { seq: 1, op: 'create', components: {
        Position: { x: 0, y: 0 }, Velocity: { x: 1, y: 0 }, Health: { value: 1 },
        Poison: { amount: 1 }, Spawner: { period: 1, vx: 2, vy: 0 },
      } },
    ];
    if (kind === 'migration') return [
      { seq: 1, op: 'create', components: { Position: { x: 1, y: 2 } } },
      { seq: 2, op: 'create', components: { Position: { x: 3, y: 4 } } },
      { seq: 3, op: 'add', handle: { slot: 0, generation: 1 }, component: 'Velocity', value: { x: 1, y: 0 } },
    ];
    if (kind === 'stress') return helpers.stressCommands();
    return null;
  }
  let pendingBatch = null;
  $('btn-sample-load').addEventListener('click', () => {
    const kind = $('sample-select').value;
    const msg = $('sample-msg');
    if (!kind) { msg.textContent = '先选择一个样例。'; msg.className = 'form-msg warn'; return; }
    // Samples are written against slot 0, generation 1 and seq 1..n, so they only
    // make sense in a fresh world. Keep the old world as an undoable snapshot.
    state.demo = false;
    const hadHistory = world.stats().externalSeqHistory > 0 || world.stats().slots > 0;
    if (hadHistory) {
      lastSavedSnapshot = world.save();
      lastSavedLabel = '载入样例前的自动存档';
      $('btn-restore').disabled = false;
    }
    world = new World();
    state.selected = null; state.locate = null;
    state.pages = { prototypes: {}, events: 0, query: 0, slots: 0 };
    $('snap-check').innerHTML = hadHistory
      ? '<div class="sc-row"><span class="sc-mark">·</span><span class="sc-name">载入样例前已自动存档</span><span class="sc-detail">可用“恢复存档”回到之前的世界</span></div>'
      : '';
    const cmds = sampleCommands(kind);
    pendingBatch = null;
    $('batch-input').value = kind === 'stress' ? '' : JSON.stringify(cmds, null, 1);
    try {
      world.enqueueExternal(cmds);
      msg.innerHTML = (hadHistory ? '世界已重置。' : '') + '已加入 <b>' + cmds.length + '</b> 条命令到 externalPending，点“单步”执行。' +
        (kind === 'stress' ? ' 压力样例为 10000 个 Position+Velocity 实体，随后 10000 条 add Frozen。' : '') +
        (kind === 'stress' ? ' 批量 JSON 框留空以免重复录入，单步即可执行。' : '');
      msg.className = 'form-msg ' + (kind === 'stress' ? 'warn' : 'ok');
    } catch (err) {
      pendingBatch = cmds;
      msg.textContent = (hadHistory ? '世界已重置。' : '') + '生成 ' + cmds.length + ' 条命令，但加入队列失败：' + err.message;
      msg.className = 'form-msg err';
    }
    form.seqTouched = false;
    buildForm();
    renderChrome();
    renderQueues();
    renderSnapshotInfo();
  });

  // ---------------------------------------------------------------- run controls
  function doStep() {
    state.demo = false;
    try {
      world.step();
    } catch (err) {
      toast('单步失败：' + err.message, 'err');
      return;
    }
    renderAll();
    if (state.tab === 'events') renderPanel();
  }
  $('btn-step').addEventListener('click', doStep);
  $('btn-step10').addEventListener('click', () => {
    state.demo = false;
    for (let i = 0; i < 10; i++) {
      try { world.step(); } catch (e) { toast('单步失败：' + e.message, 'err'); break; }
    }
    renderAll();
  });
  let playing = null;
  $('btn-play').addEventListener('click', () => {
    const btn = $('btn-play');
    if (playing) {
      clearInterval(playing); playing = null;
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '播放';
      $('play-hint').textContent = '';
      return;
    }
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '暂停';
    $('play-hint').textContent = '每 400ms 一个 tick';
    playing = setInterval(doStep, 400);
  });
  $('btn-reset').addEventListener('click', () => {
    state.demo = false;
    if (playing) { clearInterval(playing); playing = null; $('btn-play').setAttribute('aria-pressed', 'false'); $('btn-play').textContent = '播放'; $('play-hint').textContent = ''; }
    world = new World();
    state.selected = null;
    state.locate = null;
    state.pages = { prototypes: {}, events: 0, query: 0, slots: 0 };
    $('batch-msg').textContent = '';
    $('snap-check').innerHTML = '';
    setFormMsg('');
    form.seqTouched = false;
    buildForm();
    renderAll();
    toast('世界已重置', 'ok');
  });

  $('btn-locate').addEventListener('click', () => {
    const slot = Number($('loc-slot').value);
    const gen = Number($('loc-gen').value);
    if (!Number.isInteger(slot) || !Number.isInteger(gen)) { toast('需要整数 slot 与 generation', 'err'); return; }
    selectEntity(slot, gen);
  });
  ['loc-slot', 'loc-gen'].forEach((id) => {
    $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-locate').click(); });
  });

  // ---------------------------------------------------------------- snapshot
  const SNAP_KEY = 'ecs.snapshot.v1';
  function renderSnapshotInfo() {
    const s = world.stats();
    $('snap-info').innerHTML =
      '<div><span class="k">当前世界</span> <span class="v">tick ' + fmt(s.tick) + '</span> · <span class="v">' + fmt(s.alive) + ' 实体</span> · <span class="v">' + fmt(s.slots) + ' 槽</span></div>' +
      '<div><span class="k">待执行</span> <span class="v">外部 ' + fmt(s.externalPending) + '</span> · <span class="v">系统 ' + fmt(s.systemPending) + '</span></div>' +
      '<div><span class="k">快照字段</span> 槽代数 · 空槽 · 原型列 · 句柄映射 · 两队列 · seq 历史 · 内部编号 · tick</div>' +
      '<div class="snap-checklist"><span>槽代数含空槽</span><span>待执行命令</span><span>系统时钟</span><span>事件指纹</span></div>';
    if (lastSavedSnapshot) {
      $('btn-restore').disabled = false;
    }
  }
  let lastSavedSnapshot = null;
  let lastSavedLabel = '';

  $('btn-save').addEventListener('click', () => {
    try {
      const snap = world.save();
      lastSavedSnapshot = snap;
      lastSavedLabel = new Date().toLocaleTimeString();
      const json = JSON.stringify(snap);
      try { localStorage.setItem(SNAP_KEY, json); } catch (e) { /* quota or private mode: keep in memory */ }
      $('snap-text').value = json;
      $('snap-text').hidden = false;
      const s = world.stats();
      $('snap-check').innerHTML = '<div class="sc-row"><span class="sc-mark">✓</span><span class="sc-name">已保存</span><span class="sc-detail">' +
        json.length.toLocaleString('en-US') + ' 字符 · ' + lastSavedLabel + ' · tick ' + s.tick + ' · ' + s.alive + ' 实体</span></div>';
      $('btn-restore').disabled = false;
      renderSnapshotInfo();
      toast('快照已保存', 'ok');
    } catch (err) {
      toast('保存失败：' + err.message, 'err');
    }
  });
  $('btn-restore').addEventListener('click', () => {
    if (!lastSavedSnapshot) { toast('还没有保存过快照', 'err'); return; }
    try {
      world = World.fromSnapshot(JSON.parse(JSON.stringify(lastSavedSnapshot)));
      state.selected = null; state.locate = null;
      state.pages = { prototypes: {}, events: 0, query: 0, slots: 0 };
      renderAll();
      buildForm();
      $('snap-check').innerHTML = '<div class="sc-row"><span class="sc-mark">✓</span><span class="sc-name">已恢复</span><span class="sc-detail">tick ' + world.tick + ' · ' + world.aliveCount + ' 实体 · 队列与代数已还原</span></div>';
      toast('已恢复快照，可继续单步', 'ok');
    } catch (err) {
      toast('恢复失败：' + err.message, 'err');
      $('snap-check').innerHTML = '<div class="sc-row bad"><span class="sc-mark">✕</span><span class="sc-name">恢复失败</span><span class="sc-detail">' + esc(err.message) + '</span></div>';
    }
  });
  $('btn-copy-snap').addEventListener('click', () => {
    const text = lastSavedSnapshot ? JSON.stringify(lastSavedSnapshot) : JSON.stringify(world.save());
    $('snap-text').value = text;
    $('snap-text').hidden = false;
    copyText(text);
  });
  function copyText(text) {
    const fallback = () => {
      const ta = $('snap-text');
      ta.value = text;
      ta.hidden = false;
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); toast('快照 JSON 已复制', 'ok'); } catch (e) { toast('请在文本框中手动复制', 'warn'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('快照 JSON 已复制', 'ok'), fallback);
    } else fallback();
  }
  $('btn-check-resume').addEventListener('click', () => {
    runResumeCheck();
  });
  $('snap-file').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        world = World.fromSnapshot(JSON.parse(String(reader.result)));
        state.selected = null; state.locate = null;
        state.pages = { prototypes: {}, events: 0, query: 0, slots: 0 };
        renderAll();
        buildForm();
        $('snap-check').innerHTML = '<div class="sc-row"><span class="sc-mark">✓</span><span class="sc-name">已从文件恢复</span><span class="sc-detail">' + esc(file.name) + ' · tick ' + world.tick + '</span></div>';
        toast('已从文件恢复', 'ok');
      } catch (err) {
        $('snap-check').innerHTML = '<div class="sc-row bad"><span class="sc-mark">✕</span><span class="sc-name">文件无效</span><span class="sc-detail">' + esc(err.message) + '</span></div>';
        toast('恢复失败：' + err.message, 'err');
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  /**
   * Non-destructive proof: clone the live world twice, run A straight through and
   * run B by saving and restoring at every tick boundary, then compare state,
   * handle allocation, queries and the event trace.
   */
  function runResumeCheck() {
    const out = $('snap-check');
    out.innerHTML = '<div class="sc-row"><span class="sc-mark">…</span><span class="sc-name">校验中</span><span class="sc-detail">克隆世界并对比 25 个 tick</span></div>';
    setTimeout(() => {
      try {
        const seed = JSON.parse(JSON.stringify(world.save()));
        const a = World.fromSnapshot(JSON.parse(JSON.stringify(seed)));
        let b = World.fromSnapshot(JSON.parse(JSON.stringify(seed)));
        let mismatch = null;
        for (let i = 0; i < 25 && !mismatch; i++) {
          a.step();
          // the resumed world crosses a JSON save/restore boundary every tick
          b = World.fromSnapshot(JSON.parse(JSON.stringify(b.save())));
          b.step();
          const digestA = a.digest(), digestB = b.digest();
          const slotA = JSON.stringify(a.slotView()), slotB = JSON.stringify(b.slotView());
          const qA = JSON.stringify(a.queryHandles([], [])), qB = JSON.stringify(b.queryHandles([], []));
          if (digestA !== digestB || slotA !== slotB || qA !== qB || a.eventsTotal !== b.eventsTotal) {
            mismatch = 'tick ' + a.tick + '：' + (digestA !== digestB ? '状态指纹不同 ' : '') +
              (slotA !== slotB ? '槽表不同 ' : '') + (qA !== qB ? '查询结果不同 ' : '') +
              (a.eventsTotal !== b.eventsTotal ? '事件数不同 ' + a.eventsTotal + '/' + b.eventsTotal : '');
          }
        }
        if (mismatch) {
          out.innerHTML = '<div class="sc-row bad"><span class="sc-mark">✕</span><span class="sc-name">恢复后不一致</span><span class="sc-detail">' + esc(mismatch) + '</span></div>';
        } else {
          out.innerHTML = '<div class="sc-row"><span class="sc-mark">✓</span><span class="sc-name">恢复与连续运行一致</span><span class="sc-detail">25 个 tick · 每步经 JSON 往返 · 状态指纹、槽表、查询、事件数全部相同</span></div>' +
            '<div class="sc-row"><span class="sc-mark">·</span><span class="sc-name">最终</span><span class="sc-detail">指纹 ' + esc(a.stats().eventDigest) + ' · tick ' + a.tick + ' · 存活 ' + a.aliveCount + '</span></div>';
        }
      } catch (err) {
        out.innerHTML = '<div class="sc-row bad"><span class="sc-mark">✕</span><span class="sc-name">校验失败</span><span class="sc-detail">' + esc(err.message) + '</span></div>';
      }
    }, 10);
  }

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) return;
    if (ev.key === 'n' || ev.key === 'N' || ev.key === 'ArrowRight') { ev.preventDefault(); doStep(); }
    else if (ev.key === '1') switchTab('prototypes');
    else if (ev.key === '2') switchTab('query');
    else if (ev.key === '3') switchTab('migrations');
    else if (ev.key === '4') switchTab('events');
    else if (ev.key === '5') switchTab('slots');
    else if (ev.key === 'Escape') {

      if (playing) { clearInterval(playing); playing = null; $('btn-play').setAttribute('aria-pressed', 'false'); $('btn-play').textContent = '播放'; $('play-hint').textContent = ''; }
    }
  });

  // ---------------------------------------------------------------- boot
  function boot() {
    // command component select
    $('component-select').innerHTML = COMPONENTS.map((n) => '<option value="' + n + '">' + n + (FIELDS[n].length ? ' {' + FIELDS[n].join(', ') + '}' : ' {}') + '</option>').join('');
    $('component-select').value = 'Velocity';
    try {
      const savedTab = localStorage.getItem('ecs.tab');
      if (savedTab && PANELS[savedTab]) state.tab = savedTab;
    } catch (e) { /* private mode */ }
    buildForm();
    // Seed a working state so the first frame shows the tool doing its job.
    world.enqueueExternal(sampleCommands('demo'));
    world.step();
    world.step();
    world.step();
    world.enqueueExternal([
      { seq: 7, op: 'set', handle: { slot: 0, generation: 1 }, component: 'Position', value: { x: 12, y: 5 } },
      { seq: 8, op: 'add', handle: { slot: 1, generation: 1 }, component: 'Frozen', value: {} },
    ]);
    const first = world.query([], [])[0];
    if (first) {
      state.selected = { slot: first.slot, generation: first.generation };
      state.locate = { slot: first.slot, generation: first.generation };
      $('loc-slot').value = first.slot;
      $('loc-gen').value = first.generation;
    }
    form.seqTouched = false;
    buildForm();
    renderAll();
  }
  boot();
})();
