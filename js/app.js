/* global Cookfest */
(function () {
  'use strict';

  const FALLBACK_SAMPLE = {
    deadline: 12,
    stations: [{ id: 1, closed: [[4, 5]] }, { id: 2, closed: [] }],
    stock: { grain: 2, dough: 0 },
    tools: { mold: 1 },
    jobs: [
      {
        id: 1, after: [],
        modes: [{ id: 1, station: 1, ticks: 2, fee: 2, use: { grain: 1 }, yield: { dough: 1 }, hold: {} }]
      },
      {
        id: 2, after: [1],
        modes: [{ id: 1, station: 2, ticks: 2, fee: 1, use: { dough: 1 }, yield: {}, hold: { mold: 1 } }]
      }
    ],
    locks: {}
  };

  const CHECK_LABELS = {
    modeExists: '方案存在',
    startInteger: '开工拍',
    durationMatches: '工期',
    withinDeadline: '打烊时限',
    lock: '开工锁',
    precedence: '前置完工',
    stationOpen: '停用段',
    noStationConflict: '工作台互斥',
    materials: '汇总扣料',
    tools: '工具容量'
  };

  const state = {
    raw: null,
    problem: null,
    result: null,
    busy: false,
    onlyIssues: false,
    importedVerification: null,
    importView: null,
    importMeta: null,
    showImported: false
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function alertBox(message, kind = 'info', timeout = 0) {
    const slot = $('#alertSlot');
    const el = document.createElement('div');
    el.className = `alert ${kind}`;
    el.textContent = message;
    slot.appendChild(el);
    if (timeout) setTimeout(() => el.remove(), timeout);
    return el;
  }

  function clearAlerts() {
    $('#alertSlot').replaceChildren();
  }

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function dictChips(obj, options = {}) {
    const entries = Object.entries(obj || {}).filter(([, v]) => options.all || v !== 0);
    if (!entries.length) return '<span class="muted">—</span>';
    return `<span class="chip-list">${entries.map(([k, v]) =>
      `<span class="chip ${options.bad?.[k] ? 'bad' : ''}">${Cookfest.esc(k)}: <strong>${Cookfest.esc(v)}</strong></span>`).join('')}</span>`;
  }

  function formatDict(obj) {
    const entries = Object.entries(obj || {}).filter(([, v]) => v !== 0);
    return entries.length ? entries.map(([k, v]) => `${k}×${v}`).join('，') : '无';
  }

  async function fetchSample() {
    try {
      const res = await fetch('samples/cookfest-plan.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // 直接以 file:// 打开或路径不可达时，使用与 samples 相同的内置副本。
      return clone(FALLBACK_SAMPLE);
    }
  }

  function loadRaw(raw, options = {}) {
    clearAlerts();
    state.raw = raw;
    const norm = Cookfest.normalizeProblem(raw);
    if (!norm.ok) {
      state.problem = null;
      state.result = null;
      renderEditor();
      renderResults();
      alertBox(`输入数据有误：\n${norm.errors.join('\n')}`, 'error');
      return;
    }
    state.problem = norm.problem;
    state.importedVerification = options.verification || null;
    state.importView = options.importView || null;
    state.importMeta = options.meta || null;
    state.showImported = !!options.verification;
    renderEditor();
    renderJson();
    scheduleSolve();
    if (options.verification) renderVerification();
  }

  let solveTimer = null;
  function scheduleSolve() {
    clearTimeout(solveTimer);
    solveTimer = setTimeout(runSolve, 180);
  }

  async function runSolve() {
    if (!state.raw) return;
    const norm = Cookfest.normalizeProblem(state.raw);
    if (!norm.ok) {
      state.problem = null;
      state.result = { status: 'invalid', feasible: false, errors: norm.errors };
      renderResults();
      return;
    }
    state.problem = norm.problem;
    state.busy = true;
    renderSummary();
    // 让“计算中”状态先绘制，再执行同步精确搜索。
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      state.result = Cookfest.solvePlan(state.raw);
    } catch (err) {
      state.result = { status: 'error', feasible: false, errors: [err.stack || err.message] };
    } finally {
      state.busy = false;
      renderResults();
      renderJson();
    }
  }

  function commitRaw({ structural = false } = {}) {
    state.importedVerification = null;
    state.importView = null;
    state.showImported = false;
    const norm = Cookfest.normalizeProblem(state.raw);
    if (norm.ok) state.problem = norm.problem;
    renderJson();
    if (structural) renderEditor();
    scheduleSolve();
  }

  /* ---------------- 编辑器 ---------------- */

  function renderEditor() {
    renderMetaEditor();
    renderStations();
    renderJobs();
  }

  function renderMetaEditor() {
    const root = $('#metaEditor');
    if (!state.raw || !state.problem) {
      root.innerHTML = '<p class="muted">等待有效输入。</p>';
      return;
    }
    const rt = state.problem._runtime;
    root.innerHTML = `
      <div class="field-grid">
        <label for="deadlineInput">最晚完工拍</label>
        <input id="deadlineInput" type="number" min="0" max="60" value="${Cookfest.esc(state.raw.deadline)}" />
      </div>
      <div class="field-grid">
        <label>初始配料</label>
        <div class="chip-list">
          ${rt.ingredientNames.map((name) => `
            <label class="chip" style="gap:6px">${Cookfest.esc(name)}
              <input data-stock-name="${Cookfest.esc(name)}" type="number" min="0" value="${state.raw.stock?.[name] ?? 0}" style="width:64px;padding:2px 5px" />
            </label>`).join('')}
        </div>
      </div>
      <div class="field-grid">
        <label>工具容量</label>
        <div class="chip-list">
          ${rt.toolNames.length ? rt.toolNames.map((name) => `
            <label class="chip" style="gap:6px">${Cookfest.esc(name)}
              <input data-tool-name="${Cookfest.esc(name)}" type="number" min="0" value="${state.raw.tools?.[name] ?? 0}" style="width:56px;padding:2px 5px" />
            </label>`).join('') : '<span class="muted">无共享工具</span>'}
        </div>
      </div>`;

    $('#deadlineInput')?.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (Number.isInteger(v) && v >= 0 && v <= 60) {
        state.raw.deadline = v;
        commitRaw();
      } else {
        alertBox('deadline 必须是 0..60 的整数', 'error', 3000);
        e.target.value = state.raw.deadline;
      }
    });
    $$('[data-stock-name]', root).forEach((input) => input.addEventListener('change', () => {
      const v = Math.max(0, Number(input.value) || 0);
      state.raw.stock ||= {};
      state.raw.stock[input.dataset.stockName] = v;
      commitRaw();
    }));
    $$('[data-tool-name]', root).forEach((input) => input.addEventListener('change', () => {
      const v = Math.max(0, Number(input.value) || 0);
      state.raw.tools ||= {};
      state.raw.tools[input.dataset.toolName] = v;
      commitRaw();
    }));
  }

  function renderStations() {
    const root = $('#stationEditor');
    if (!state.raw?.stations) { root.innerHTML = ''; return; }
    root.innerHTML = state.raw.stations.map((station, si) => `
      <section class="station-block" data-station-index="${si}">
        <div class="station-title">
          <span>工作台 ${Cookfest.esc(station.id)}</span>
          <span class="muted" style="font-size:12px">${station.closed?.length || 0} 段</span>
        </div>
        <div class="segment-list">
          ${(station.closed || []).map((seg, ci) => {
            const [a, b] = Array.isArray(seg) ? seg : [seg.from, seg.to];
            return `
              <div class="segment-row" data-segment-index="${ci}">
                <input aria-label="工作台 ${Cookfest.esc(station.id)} 停用起点" data-closed-a type="number" min="0" value="${Cookfest.esc(a)}" />
                <span class="sep">至</span>
                <input aria-label="工作台 ${Cookfest.esc(station.id)} 停用终点（不含）" data-closed-b type="number" min="1" value="${Cookfest.esc(b)}" />
                <button class="btn tiny" type="button" data-remove-segment title="删除停用段">删</button>
              </div>`;
          }).join('')}
        </div>
        <button class="btn tiny add-segment" type="button" data-add-segment>+ 添加停用段</button>
      </section>`).join('');

    $$('.station-block', root).forEach((block) => {
      const si = Number(block.dataset.stationIndex);
      block.querySelector('[data-add-segment]').addEventListener('click', () => {
        const station = state.raw.stations[si];
        station.closed ||= [];
        const lastEnd = station.closed.at(-1)?.[1] ?? 0;
        station.closed.push([lastEnd + 1, lastEnd + 2]);
        commitRaw({ structural: true });
      });
      $$('.segment-row', block).forEach((row) => {
        const ci = Number(row.dataset.segmentIndex);
        row.querySelector('[data-remove-segment]').addEventListener('click', () => {
          state.raw.stations[si].closed.splice(ci, 1);
          commitRaw({ structural: true });
        });
        row.querySelector('[data-closed-a]').addEventListener('change', (e) => {
          state.raw.stations[si].closed[ci][0] = Math.max(0, Number(e.target.value) || 0);
          commitRaw();
        });
        row.querySelector('[data-closed-b]').addEventListener('change', (e) => {
          state.raw.stations[si].closed[ci][1] = Math.max(1, Number(e.target.value) || 1);
          commitRaw();
        });
      });
    });
  }

  function renderJobs() {
    const root = $('#jobEditor');
    if (!state.problem) { root.innerHTML = ''; return; }
    const jobs = state.problem._runtime.jobs;
    root.innerHTML = jobs.map((job) => {
      const key = String(job.id);
      const locked = Object.prototype.hasOwnProperty.call(state.raw.locks || {}, key);
      const lockStart = state.raw.locks?.[key] ?? 0;
      return `
        <section class="job-card" data-job-index="${job.index}">
          <div class="job-head">
            <div>
              <div class="job-title">工序 #${Cookfest.esc(job.id)}</div>
              <div class="job-after">前置：${job.after.length ? job.after.map((i) => '#' + Cookfest.esc(jobs[i].id)).join('、') : '无'}</div>
            </div>
            <div class="lock-box">
              <label class="lock-label">
                <input type="checkbox" data-lock-check ${locked ? 'checked' : ''} /> 锁开工
              </label>
              <input type="number" min="0" max="60" data-lock-start value="${Cookfest.esc(lockStart)}" ${locked ? '' : 'disabled'} aria-label="工序 ${Cookfest.esc(job.id)} 锁定开工拍" />
            </div>
          </div>
          <div class="modes">
            ${job.modes.map((m) => `
              <div class="mode-line">
                <strong>方案 ${Cookfest.esc(m.id)}</strong> · 工作台 ${Cookfest.esc(state.problem._runtime.stations[m.stationIndex].id)}
                · ${m.ticks} 拍 · 费用 ${m.fee}<br />
                用：${Cookfest.esc(formatDict(m.use))}；产：${Cookfest.esc(formatDict(m.yield))}；持：${Cookfest.esc(formatDict(m.hold))}
              </div>`).join('')}
          </div>
        </section>`;
    }).join('');

    $$('.job-card', root).forEach((card) => {
      const job = jobs[Number(card.dataset.jobIndex)];
      const key = String(job.id);
      const check = card.querySelector('[data-lock-check]');
      const startInput = card.querySelector('[data-lock-start]');
      check.addEventListener('change', () => {
        state.raw.locks ||= {};
        if (check.checked) {
          const currentStart = state.result?.assignments?.find((a) => a.jobIndex === job.index)?.start;
          const start = Number.isInteger(currentStart) ? currentStart : Math.max(0, Number(startInput.value) || 0);
          startInput.value = String(start);
          state.raw.locks[key] = start;
        } else {
          delete state.raw.locks[key];
        }
        commitRaw({ structural: true });
      });
      startInput.addEventListener('change', () => {
        state.raw.locks ||= {};
        state.raw.locks[key] = Math.max(0, Number(startInput.value) || 0);
        commitRaw();
      });
    });
  }

  /* ---------------- 结果渲染 ---------------- */

  function renderResults() {
    renderSummary();
    const view = currentView();
    renderGantt(view.assignments, view.verification?.ledger ? { rows: view.verification.ledger } : null);
    renderLedger(view.ledgerRows);
    renderVerification();
    $('#exportBtn').disabled = !state.result?.feasible;
  }

  function currentView() {
    if (state.showImported && state.importView && state.importedVerification) {
      return {
        assignments: state.importView,
        ledgerRows: state.importedVerification.ledger?.rows || [],
        verification: state.importedVerification,
        imported: true
      };
    }
    return {
      assignments: state.result?.assignments || [],
      ledgerRows: state.result?.ledger || [],
      verification: state.result?.verification || null,
      imported: false
    };
  }

  function renderSummary() {
    const pill = $('#statusPill');
    const body = $('#summaryBody');
    const r = state.result;
    if (state.busy) {
      pill.className = 'pill warn';
      pill.textContent = '求解中…';
      body.innerHTML = '<p class="muted">正在执行精确搜索。满规模紧约束时可能需要数秒。</p>';
      return;
    }
    if (!r) {
      pill.className = 'pill neutral';
      pill.textContent = '尚未求解';
      body.innerHTML = '<p class="muted">导入样例后会自动求解。</p>';
      return;
    }
    if (r.status === 'invalid') {
      pill.className = 'pill bad';
      pill.textContent = '输入无效';
      body.innerHTML = `<div class="alert error">${(r.errors || []).map(Cookfest.esc).join('<br>')}</div>`;
      return;
    }
    if (!r.feasible) {
      pill.className = 'pill bad';
      pill.textContent = '无解';
      body.innerHTML = `
        <p>${Cookfest.esc(r.reason || '找不到可行计划')}</p>
        <p class="muted">请放宽 deadline、停用段、开工锁或资源约束后重试。</p>`;
      return;
    }
    pill.className = 'pill good';
    pill.textContent = '最优计划';
    body.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="k">最早全完工</div><div class="v">${r.makespan}<span class="muted" style="font-size:12px"> 拍</span></div></div>
        <div class="stat"><div class="k">最低总费用</div><div class="v">${r.cost}</div></div>
        <div class="stat"><div class="k">工序数</div><div class="v">${r.assignments.length}</div></div>
      </div>
      <div class="kv-line">字典序签名（工序号 → 开工拍, 方案号）：<code>${r.signature.join(', ')}</code></div>
      <div class="kv-line">求解耗时 ${r.stats?.ms ?? '—'} ms${r.stats ? `；搜索节点 ${(r.stats.feasibilityNodes || 0) + (r.stats.costNodes || 0) + (r.stats.lexNodes || 0)}` : ''}</div>`;
  }

  function renderGantt(assignments) {
    const root = $('#ganttContainer');
    if (!state.problem) { root.innerHTML = '<div class="empty-state">等待有效输入。</div>'; return; }
    if (!assignments?.length) { root.innerHTML = '<div class="empty-state">没有可显示的计划；若状态为无解，请查看约束冲突。</div>'; return; }
    const D = state.problem.deadline;
    const stations = state.problem._runtime.stations;
    const axisTicks = Array.from({ length: D }, (_, t) => t);

    root.innerHTML = `
      <div class="gantt" style="--ticks:${D}">
        <div class="gantt-axis-row">
          <div class="gantt-corner">工作台 / 拍</div>
          <div class="gantt-axis">
            ${axisTicks.map((t) => `<div class="tick-label ${t % 5 === 0 ? 'major' : ''}">${t}</div>`).join('')}
          </div>
        </div>
        ${stations.map((station, si) => `
          <div class="gantt-row">
            <div class="row-label">工作台 ${Cookfest.esc(station.id)}<small>${station.closed.length ? station.closed.map(([a, b]) => `停 ${a}–${b}`).join('，') : '全天可用'}</small></div>
            <div class="gantt-track" style="--ticks:${D}">
              ${station.closed.map(([a0, b0]) => {
                const a = Math.max(0, a0);
                const b = Math.min(D, b0);
                if (a >= b) return '';
                return `<div class="closed-interval" style="grid-column:${a + 1} / ${b + 1}" data-tooltip="停用段 [${a0}, ${b0})">停用 ${a}–${b}</div>`;
              }).join('')}
              ${assignments.filter((a) => a.stationIndex === si || String(a.stationId) === station.idKey).map((a) => {
                const locked = state.problem._runtime.jobs[a.jobIndex]?.lock;
                const tip = `工序 #${a.jobId} 方案 ${a.modeId}\n工作台 ${station.id}\n占用 [${a.start}, ${a.end})，时长 ${a.ticks}\n费用 ${a.fee}`;
                return `
                  <div class="gantt-interval ${locked ? 'locked' : ''}" style="grid-column:${a.start + 1} / ${a.end + 1}" data-tooltip="${Cookfest.esc(tip)}" tabindex="0">
                    <span class="bar-title">#${Cookfest.esc(a.jobId)} · 方案${Cookfest.esc(a.modeId)}</span>
                    <span class="bar-meta">${a.start}–${a.end} · ¥${Cookfest.esc(a.fee)}</span>
                  </div>`;
              }).join('')}
            </div>
          </div>`).join('')}
      </div>`;

    $$('[data-tooltip]', root).forEach((el) => {
      el.addEventListener('mouseenter', showTooltip);
      el.addEventListener('mousemove', moveTooltip);
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('focus', showTooltip);
      el.addEventListener('blur', hideTooltip);
    });
  }

  const tooltip = $('#tooltip');
  function showTooltip(e) {
    tooltip.hidden = false;
    tooltip.textContent = e.currentTarget.dataset.tooltip;
    moveTooltip(e);
  }
  function moveTooltip(e) {
    if (tooltip.hidden) return;
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const rect = tooltip.getBoundingClientRect();
    if (x + rect.width > innerWidth - 8) x = e.clientX - rect.width - pad;
    if (y + rect.height > innerHeight - 8) y = e.clientY - rect.height - pad;
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTooltip() { tooltip.hidden = true; }

  function renderLedger(rows) {
    const root = $('#ledgerContainer');
    if (!rows?.length) { root.innerHTML = '<div class="empty-state">尚无账本。</div>'; return; }
    const visible = state.onlyIssues ? rows.filter((r) => !r.ok) : rows;
    if (!visible.length) {
      root.innerHTML = '<div class="empty-state">没有异常拍；所有汇总扣料和工具容量检查均通过。</div>';
      return;
    }
    root.innerHTML = `
      <table>
        <thead><tr>
          <th>拍</th><th>完工入库</th><th>开工 / 合计用料</th><th>入库后库存</th><th>扣后库存</th><th>工具占用</th><th>状态</th>
        </tr></thead>
        <tbody>
          ${visible.map((row) => `
            <tr class="${row.ok ? '' : 'bad'}">
              <td class="tick-num">${row.tick}</td>
              <td>
                <div class="chip-list">${row.completed.length ? row.completed.map((a) => `<span class="chip">#${Cookfest.esc(a.jobId)}/${Cookfest.esc(a.modeId)}</span>`).join('') : '<span class="muted">无完工</span>'}</div>
                <div style="margin-top:5px">${dictChips(row.outputs)}</div>
              </td>
              <td>
                <div class="chip-list">${row.started.length ? row.started.map((a) => `<span class="chip">#${Cookfest.esc(a.jobId)}/${Cookfest.esc(a.modeId)}</span>`).join('') : '<span class="muted">无开工</span>'}</div>
                <div style="margin-top:5px">${dictChips(row.demand, { bad: Object.fromEntries(Object.entries(row.shortage || {}).map(([k, v]) => [k, v > 0])) })}</div>
              </td>
              <td class="stock-cell">${dictChips(row.stockAfterOutput)}</td>
              <td class="stock-cell">${dictChips(row.stockAfter)}</td>
              <td class="stock-cell">${renderTools(row)}</td>
              <td>${row.ok ? '<span class="chip good">通过</span>' : `<span class="chip bad">异常</span><div class="issue-text" style="margin-top:5px">${row.issues.map(Cookfest.esc).join('<br>')}</div>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function renderTools(row) {
    const entries = Object.entries(row.toolInUse || {});
    if (!entries.length) return '<span class="muted">未使用</span>';
    return `<span class="chip-list">${entries.map(([k, used]) => {
      const cap = row.toolCapacity?.[k] ?? 0;
      const over = used > cap;
      return `<span class="chip ${over ? 'bad' : ''}">${Cookfest.esc(k)} ${used}/${cap}</span>`;
    }).join('')}</span>`;
  }

  function renderVerification() {
    const root = $('#verificationContainer');
    const imported = state.importedVerification;
    const v = imported || state.result?.verification;
    if (!v) {
      root.innerHTML = '<div class="empty-state">导出后重新导入该文件，即可在这里逐次核验开工。</div>';
      return;
    }
    const sourceBanner = imported ? `
      <div class="alert ${v.valid ? 'success' : 'error'}">
        <strong>已核验导入文件${state.importMeta?.exportedAt ? `（${Cookfest.esc(state.importMeta.exportedAt)}）` : ''}</strong>
        <div>${v.valid ? `全部 ${v.checkedStarts} 次开工均通过约束与逐拍汇总扣料检查。` : `发现 ${v.errors.length} 类问题，下列标签标出每次开工的失败项。`}</div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn tiny" type="button" id="toggleImportView">${state.showImported ? '返回当前求得的最优计划' : '在甘特图/账本中查看导入计划'}</button>
          <button class="btn tiny" type="button" id="dismissImportVerification">关闭导入核验</button>
        </div>
      </div>` : '';

    root.innerHTML = `
      ${sourceBanner}
      <div class="verify-summary">
        <span class="pill ${v.valid ? 'good' : 'bad'}">${v.valid ? '核验通过' : '核验失败'}</span>
        <span>共检查 <strong>${v.startChecks.length}</strong> 条开工记录</span>
        ${v.errors.length ? `<span class="issue-text">${v.errors.length} 个错误</span>` : ''}
      </div>
      ${v.errors.length && !imported ? `<div class="alert error">${[...new Set(v.errors)].slice(0, 20).map(Cookfest.esc).join('\n')}</div>` : ''}
      <div class="check-grid">
        ${v.startChecks.map((c) => `
          <section class="start-check ${c.valid ? 'valid' : 'invalid'}">
            <div class="start-check-head">
              <strong>工序 #${Cookfest.esc(c.jobId)} · 方案 ${Cookfest.esc(c.modeId)} · 第 ${Cookfest.esc(c.start)} 拍开工${c.end != null ? ` → ${Cookfest.esc(c.end)} 完工` : ''}</strong>
              <span class="pill ${c.valid ? 'good' : 'bad'}">${c.valid ? '通过' : '失败'}</span>
            </div>
            <div class="check-tags">
              ${Object.entries(c.checks || {}).map(([key, val]) => {
                if (typeof val !== 'boolean') return '';
                return `<span class="tag ${val ? 'ok' : 'no'}">${val ? '✓' : '×'} ${CHECK_LABELS[key] || key}</span>`;
              }).join('')}
            </div>
            ${c.material ? `<p class="kv-line" style="margin:8px 0 0">入库后：${Cookfest.esc(JSON.stringify(c.material.stockAfterOutput))}；本拍合计需求：${Cookfest.esc(JSON.stringify(c.material.demand))}</p>` : ''}
            ${c.issues.length ? `<ul class="check-issues">${c.issues.map((x) => `<li>${Cookfest.esc(x)}</li>`).join('')}</ul>` : ''}
          </section>`).join('')}
      </div>`;

    $('#toggleImportView')?.addEventListener('click', () => {
      state.showImported = !state.showImported;
      renderResults();
    });
    $('#dismissImportVerification')?.addEventListener('click', () => {
      state.importedVerification = null;
      state.importView = null;
      state.showImported = false;
      renderVerification();
    });
  }

  function renderJson() {
    $('#jsonPreview').textContent = state.raw ? JSON.stringify(state.raw, null, 2) : '';
  }

  /* ---------------- 导入导出 ---------------- */

  function download(filename, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleImportFile(file) {
    const text = await file.text();
    const parsed = Cookfest.parseImportText(text);
    if (!parsed.ok) {
      alertBox(`导入失败：\n${parsed.error}`, 'error');
      return;
    }
    const extracted = Cookfest.extractPlan(parsed.raw);
    let importView = null;
    if (parsed.assignments && parsed.problem) {
      importView = Cookfest.decorateAssignments(parsed.problem, parsed.assignments);
    }
    loadRaw(extracted.problemRaw, {
      verification: parsed.verification,
      importView,
      meta: parsed.meta
    });
    alertBox(parsed.verification
      ? (parsed.verification.valid ? '导入成功：开工核验全部通过。' : '导入成功，但计划核验失败，请查看红色检查项。')
      : '题目 JSON 导入成功，已开始求解。', parsed.verification && !parsed.verification.valid ? 'error' : 'success', 4000);
  }

  function bindEvents() {
    $('#loadSampleBtn').addEventListener('click', async () => {
      const raw = await fetchSample();
      loadRaw(clone(raw));
      alertBox('已载入 samples/cookfest-plan.json。', 'success', 2500);
    });
    $('#importBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await handleImportFile(file);
      e.target.value = '';
    });
    $('#solveBtn').addEventListener('click', runSolve);
    $('#exportBtn').addEventListener('click', () => {
      if (!state.result?.feasible || !state.problem) return;
      const pkg = Cookfest.makeExport(state.problem, state.result);
      download(`cookfest-plan-${state.result.makespan}t-${state.result.cost}.json`, JSON.stringify(pkg, null, 2));
      alertBox('已导出核验包；可立即通过“导入 JSON / 核验包”重导验证。', 'success', 3500);
    });
    $('#copyJsonBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#jsonPreview').textContent);
        alertBox('当前 JSON 已复制。', 'success', 2000);
      } catch {
        alertBox('复制失败，可手动选择 JSON 文本复制。', 'error', 3000);
      }
    });
    $('#onlyLedgerIssues').addEventListener('change', (e) => {
      state.onlyIssues = e.target.checked;
      renderLedger(currentView().ledgerRows);
    });

    // 支持直接把 JSON 文件拖到页面任意位置。
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) await handleImportFile(file);
    });
  }

  bindEvents();
  fetchSample().then((raw) => loadRaw(clone(raw)));
})();
