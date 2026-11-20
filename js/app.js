/*
 * app.js — 演算台界面逻辑
 * 数据分层：formRules（表单可编辑草稿）→ validate → domain（生效规则）→ engine（演算）
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const V = window.GOAPValidate;
  const P = window.GOAP;
  const S = window.GOAPSim;

  /* ---------------- 全局状态 ---------------- */

  let formRules = clone(window.GOAPSamples.demo);
  let domain = null;
  let engine = null;
  let planView = 'static'; // static | runtime
  let playTimer = null;
  let progressTimer = null;
  let lastPlanResult = null; // 静态视角结果缓存
  let logFilter = 'all';

  /* ---------------- 工具 ---------------- */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }
  function setStatus(sel2, msg, kind) {
    const el = $(sel2);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'apply-status' + (kind ? ' is-' + kind : '');
  }
  function factNames() { return Object.keys(formRules.initial.facts); }
  function resNames() { return Object.keys(formRules.caps); }

  /* ---------------- 主题 ---------------- */

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('goap-theme'); } catch (e) { /* ignore */ }
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
    $('#btn-theme').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('goap-theme', next); } catch (e) { /* ignore */ }
    });
  }

  /* ---------------- Tabs ---------------- */

  function initTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        $$('.tabpane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
        if (name === 'json') $('#json-editor').value = JSON.stringify(formRules, null, 2);
      });
    });
  }

  /* ---------------- 表单渲染：状态与目标 ---------------- */

  function renderStateEditors() {
    // 布尔量
    const factBox = $('#fact-editor');
    factBox.innerHTML = '';
    factNames().forEach((name) => {
      const card = document.createElement('div');
      card.className = 'editor-card';
      card.innerHTML = `
        <div class="card-top">
          <input class="input fact-name-input" value="${esc(name)}" aria-label="布尔量名">
          <label class="fact-chip ${formRules.initial.facts[name] ? 'is-on' : ''}">
            <input type="checkbox" class="fact-value" ${formRules.initial.facts[name] ? 'checked' : ''}> 初值
          </label>
          <button class="card-remove" type="button" data-act="del-fact">删除</button>
        </div>`;
      card.querySelector('.fact-value').addEventListener('change', (e) => {
        formRules.initial.facts[name] = e.target.checked;
        card.querySelector('.fact-chip').classList.toggle('is-on', e.target.checked);
      });
      card.querySelector('.fact-name-input').addEventListener('change', (e) => {
        renameFact(name, e.target.value.trim(), e.target);
      });
      card.querySelector('[data-act="del-fact"]').addEventListener('click', () => deleteFact(name));
      factBox.appendChild(card);
    });

    // 资源
    const resBox = $('#res-editor');
    resBox.innerHTML = '';
    resNames().forEach((name) => {
      const card = document.createElement('div');
      card.className = 'editor-card';
      card.innerHTML = `
        <div class="card-top">
          <input class="input res-name-input" value="${esc(name)}" aria-label="资源名" style="max-width:160px">
          <button class="card-remove" type="button" data-act="del-res">删除</button>
        </div>
        <div class="card-grid">
          <div class="card-field">
            <label>上限 cap（正整数）</label>
            <input type="number" min="1" step="1" class="res-cap" value="${formRules.caps[name]}">
          </div>
          <div class="card-field">
            <label>初始值（0..cap）</label>
            <input type="number" min="0" step="1" class="res-init" value="${formRules.initial.resources[name]}">
          </div>
        </div>`;
      card.querySelector('.res-cap').addEventListener('change', (e) => {
        formRules.caps[name] = parseInt(e.target.value, 10);
      });
      card.querySelector('.res-init').addEventListener('change', (e) => {
        formRules.initial.resources[name] = parseInt(e.target.value, 10);
      });
      card.querySelector('.res-name-input').addEventListener('change', (e) => {
        renameRes(name, e.target.value.trim(), e.target);
      });
      card.querySelector('[data-act="del-res"]').addEventListener('click', () => deleteRes(name));
      resBox.appendChild(card);
    });

    // 目标
    const goalFact = $('#goal-fact-editor');
    goalFact.innerHTML = '';
    factNames().forEach((name) => {
      const inGoal = name in (formRules.goal.facts || {});
      const chip = document.createElement('label');
      chip.className = 'fact-chip' + (inGoal ? ' is-on' : '');
      chip.innerHTML = `
        <input type="checkbox" class="goal-fact-on" ${inGoal ? 'checked' : ''}>
        <span class="mono">${esc(name)}</span>
        <select class="goal-fact-val" ${inGoal ? '' : 'disabled'}>
          <option value="true" ${inGoal && formRules.goal.facts[name] === true ? 'selected' : ''}>true</option>
          <option value="false" ${inGoal && formRules.goal.facts[name] === false ? 'selected' : ''}>false</option>
        </select>`;
      const on = chip.querySelector('.goal-fact-on');
      const sel = chip.querySelector('.goal-fact-val');
      on.addEventListener('change', () => {
        formRules.goal.facts = formRules.goal.facts || {};
        if (on.checked) {
          formRules.goal.facts[name] = sel.value === 'true';
          sel.disabled = false;
          chip.classList.add('is-on');
        } else {
          delete formRules.goal.facts[name];
          sel.disabled = true;
          chip.classList.remove('is-on');
        }
      });
      sel.addEventListener('change', () => {
        formRules.goal.facts[name] = sel.value === 'true';
      });
      goalFact.appendChild(chip);
    });

    const goalRes = $('#goal-res-editor');
    goalRes.innerHTML = '';
    resNames().forEach((name) => {
      const row = document.createElement('div');
      row.className = 'goal-minmax-row';
      const gmin = formRules.goal.min && name in formRules.goal.min ? formRules.goal.min[name] : '';
      const gmax = formRules.goal.max && name in formRules.goal.max ? formRules.goal.max[name] : '';
      row.innerHTML = `
        <span class="mono">${esc(name)}</span>
        <label>min <input type="number" min="0" step="1" class="input input-narrow goal-min" value="${gmin}"></label>
        <label>max <input type="number" min="0" step="1" class="input input-narrow goal-max" value="${gmax}"></label>`;
      row.querySelector('.goal-min').addEventListener('change', (e) => {
        formRules.goal.min = formRules.goal.min || {};
        if (e.target.value === '') delete formRules.goal.min[name];
        else formRules.goal.min[name] = parseInt(e.target.value, 10);
      });
      row.querySelector('.goal-max').addEventListener('change', (e) => {
        formRules.goal.max = formRules.goal.max || {};
        if (e.target.value === '') delete formRules.goal.max[name];
        else formRules.goal.max[name] = parseInt(e.target.value, 10);
      });
      goalRes.appendChild(row);
    });

    $('#in-budget').value = formRules.budget;
    renderActionEditor();
    renderEventEditor();
  }

  function renameFact(oldName, newName, inputEl) {
    if (!newName || newName === oldName) { inputEl.value = oldName; return; }
    if (factNames().includes(newName)) { toast('名字已存在', 'err'); inputEl.value = oldName; return; }
    const map = (obj) => {
      if (!obj) return;
      if (oldName in obj) { obj[newName] = obj[oldName]; delete obj[oldName]; }
    };
    map(formRules.initial.facts);
    map(formRules.goal.facts);
    formRules.actions.forEach((a) => {
      map(a.pre);
      ['add', 'remove'].forEach((k) => {
        const i = a[k].indexOf(oldName);
        if (i >= 0) a[k][i] = newName;
      });
    });
    formRules.events.forEach((ev) => map(ev.set_facts));
    renderStateEditors();
  }

  function renameRes(oldName, newName, inputEl) {
    if (!newName || newName === oldName) { inputEl.value = oldName; return; }
    if (resNames().includes(newName)) { toast('名字已存在', 'err'); inputEl.value = oldName; return; }
    const map = (obj) => {
      if (!obj) return;
      if (oldName in obj) { obj[newName] = obj[oldName]; delete obj[oldName]; }
    };
    map(formRules.caps);
    map(formRules.initial.resources);
    map(formRules.goal.min);
    map(formRules.goal.max);
    formRules.actions.forEach((a) => { map(a.min); map(a.max); map(a.delta); });
    formRules.events.forEach((ev) => map(ev.set_resources));
    renderStateEditors();
  }

  function deleteFact(name) {
    delete formRules.initial.facts[name];
    delete formRules.goal.facts[name];
    formRules.actions.forEach((a) => {
      delete a.pre[name];
      a.add = a.add.filter((x) => x !== name);
      a.remove = a.remove.filter((x) => x !== name);
    });
    formRules.events.forEach((ev) => delete ev.set_facts[name]);
    renderStateEditors();
  }

  function deleteRes(name) {
    delete formRules.caps[name];
    delete formRules.initial.resources[name];
    delete formRules.goal.min[name];
    delete formRules.goal.max[name];
    formRules.actions.forEach((a) => { delete a.min[name]; delete a.max[name]; delete a.delta[name]; });
    formRules.events.forEach((ev) => delete ev.set_resources[name]);
    renderStateEditors();
  }

  /* ---------------- 表单渲染：动作 ---------------- */

  function renderActionEditor() {
    const box = $('#action-editor');
    box.innerHTML = '';
    $('#action-count').textContent = formRules.actions.length;
    formRules.actions.forEach((a, idx) => {
      const card = document.createElement('div');
      card.className = 'editor-card';
      card.innerHTML = `
        <div class="card-top">
          <input class="input action-id-input" value="${esc(a.id)}" aria-label="动作 id" style="max-width:150px">
          <label>cost <input type="number" min="1" step="1" class="input input-narrow action-cost" value="${a.cost}"></label>
          <label>时长 ms <input type="number" min="1" step="1" class="input input-narrow action-dur" value="${a.duration_ms}"></label>
          <button class="card-remove" type="button">删除</button>
        </div>
        <div class="card-grid">
          <div class="card-field">
            <label>前置 pre（布尔条件）</label>
            <div class="chip-grid action-pre"></div>
          </div>
          <div class="card-field">
            <label>资源 min / max</label>
            <div class="action-minmax"></div>
          </div>
          <div class="card-field">
            <label>效果 add / remove（互斥）</label>
            <div class="chip-grid action-effects"></div>
          </div>
          <div class="card-field">
            <label>资源 delta（非零整数）</label>
            <div class="action-delta"></div>
          </div>
        </div>`;

      card.querySelector('.action-id-input').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        if (!v) { e.target.value = a.id; return; }
        if (formRules.actions.some((x, j) => j !== idx && x.id === v)) { toast('动作 id 重复', 'err'); e.target.value = a.id; return; }
        a.id = v;
      });
      card.querySelector('.action-cost').addEventListener('change', (e) => { a.cost = parseInt(e.target.value, 10); });
      card.querySelector('.action-dur').addEventListener('change', (e) => { a.duration_ms = parseInt(e.target.value, 10); });
      card.querySelector('.card-remove').addEventListener('click', () => {
        formRules.actions.splice(idx, 1);
        renderActionEditor();
      });

      // pre 三态 chip：不约束 / true / false
      const preBox = card.querySelector('.action-pre');
      factNames().forEach((fn) => {
        const chip = document.createElement('label');
        chip.className = 'fact-chip' + (fn in a.pre ? 'is-on' : '');
        const state = fn in a.pre ? String(a.pre[fn]) : 'none';
        chip.innerHTML = `<span class="mono">${esc(fn)}</span>
          <select class="pre-sel">
            <option value="none" ${state === 'none' ? 'selected' : ''}>·</option>
            <option value="true" ${state === 'true' ? 'selected' : ''}>true</option>
            <option value="false" ${state === 'false' ? 'selected' : ''}>false</option>
          </select>`;
        const sel = chip.querySelector('.pre-sel');
        sel.addEventListener('change', () => {
          if (sel.value === 'none') delete a.pre[fn];
          else a.pre[fn] = sel.value === 'true';
          chip.classList.toggle('is-on', sel.value !== 'none');
        });
        preBox.appendChild(chip);
      });

      // min/max
      const mmBox = card.querySelector('.action-minmax');
      resNames().forEach((rn) => {
        const row = document.createElement('div');
        row.className = 'goal-minmax-row';
        row.innerHTML = `<span class="mono">${esc(rn)}</span>
          <input type="number" min="0" step="1" class="input input-narrow a-min" placeholder="min" value="${rn in a.min ? a.min[rn] : ''}">
          <input type="number" min="0" step="1" class="input input-narrow a-max" placeholder="max" value="${rn in a.max ? a.max[rn] : ''}">`;
        row.querySelector('.a-min').addEventListener('change', (e) => {
          if (e.target.value === '') delete a.min[rn];
          else a.min[rn] = parseInt(e.target.value, 10);
        });
        row.querySelector('.a-max').addEventListener('change', (e) => {
          if (e.target.value === '') delete a.max[rn];
          else a.max[rn] = parseInt(e.target.value, 10);
        });
        mmBox.appendChild(row);
      });

      // add/remove 互斥单选风格
      const effBox = card.querySelector('.action-effects');
      factNames().forEach((fn) => {
        const chip = document.createElement('label');
        const mode = a.add.includes(fn) ? 'add' : a.remove.includes(fn) ? 'remove' : 'none';
        chip.className = 'fact-chip' + (mode !== 'none' ? 'is-on' : '');
        chip.innerHTML = `<span class="mono">${esc(fn)}</span>
          <select class="eff-sel">
            <option value="none" ${mode === 'none' ? 'selected' : ''}>·</option>
            <option value="add" ${mode === 'add' ? 'selected' : ''}>add</option>
            <option value="remove" ${mode === 'remove' ? 'selected' : ''}>remove</option>
          </select>`;
        const sel = chip.querySelector('.eff-sel');
        sel.addEventListener('change', () => {
          a.add = a.add.filter((x) => x !== fn);
          a.remove = a.remove.filter((x) => x !== fn);
          if (sel.value === 'add') a.add.push(fn);
          if (sel.value === 'remove') a.remove.push(fn);
          chip.classList.toggle('is-on', sel.value !== 'none');
        });
        effBox.appendChild(chip);
      });

      // delta
      const dBox = card.querySelector('.action-delta');
      resNames().forEach((rn) => {
        const row = document.createElement('div');
        row.className = 'goal-minmax-row';
        row.innerHTML = `<span class="mono">${esc(rn)}</span>
          <input type="number" step="1" class="input input-narrow a-delta" placeholder="Δ" value="${rn in a.delta ? a.delta[rn] : ''}">`;
        row.querySelector('.a-delta').addEventListener('change', (e) => {
          if (e.target.value === '' || parseInt(e.target.value, 10) === 0) delete a.delta[rn];
          else a.delta[rn] = parseInt(e.target.value, 10);
        });
        dBox.appendChild(row);
      });

      box.appendChild(card);
    });
  }

  /* ---------------- 表单渲染：事件 ---------------- */

  function renderEventEditor() {
    const box = $('#event-editor');
    box.innerHTML = '';
    $('#event-count').textContent = formRules.events.length;
    formRules.events.forEach((ev, idx) => {
      const card = document.createElement('div');
      card.className = 'editor-card';
      card.innerHTML = `
        <div class="card-top">
          <label>t (ms) <input type="number" min="0" step="1" class="input input-narrow ev-t" value="${ev.t}"></label>
          <button class="card-remove" type="button">删除</button>
        </div>
        <div class="card-grid">
          <div class="card-field"><label>set_facts</label><div class="chip-grid ev-facts"></div></div>
          <div class="card-field"><label>set_resources</label><div class="ev-res"></div></div>
        </div>`;
      card.querySelector('.ev-t').addEventListener('change', (e) => { ev.t = parseInt(e.target.value, 10); });
      card.querySelector('.card-remove').addEventListener('click', () => {
        formRules.events.splice(idx, 1);
        renderEventEditor();
      });
      const fBox = card.querySelector('.ev-facts');
      factNames().forEach((fn) => {
        const chip = document.createElement('label');
        const on = fn in ev.set_facts;
        chip.className = 'fact-chip' + (on ? 'is-on' : '');
        chip.innerHTML = `<span class="mono">${esc(fn)}</span>
          <select class="ev-fact-sel" ${on ? '' : 'disabled'}>
            <option value="">不设置</option>
            <option value="true" ${on && ev.set_facts[fn] === true ? 'selected' : ''}>true</option>
            <option value="false" ${on && ev.set_facts[fn] === false ? 'selected' : ''}>false</option>
          </select>`;
        const sel = chip.querySelector('.ev-fact-sel');
        chip.addEventListener('change', () => {
          if (sel.value === '') { delete ev.set_facts[fn]; sel.disabled = true; chip.classList.remove('is-on'); }
          else { ev.set_facts[fn] = sel.value === 'true'; sel.disabled = false; chip.classList.add('is-on'); }
        });
        fBox.appendChild(chip);
      });
      const rBox = card.querySelector('.ev-res');
      resNames().forEach((rn) => {
        const row = document.createElement('div');
        row.className = 'goal-minmax-row';
        row.innerHTML = `<span class="mono">${esc(rn)}</span>
          <input type="number" min="0" step="1" class="input input-narrow ev-res-val" placeholder="设为" value="${rn in ev.set_resources ? ev.set_resources[rn] : ''}">`;
        row.querySelector('.ev-res-val').addEventListener('change', (e) => {
          if (e.target.value === '') delete ev.set_resources[rn];
          else ev.set_resources[rn] = parseInt(e.target.value, 10);
        });
        rBox.appendChild(row);
      });
      box.appendChild(card);
    });
  }

  /* ---------------- 增删按钮 ---------------- */

  function initAddButtons() {
    $('#btn-add-fact').addEventListener('click', () => {
      if (factNames().length >= V.MAX_FACTS) return toast(`最多 ${V.MAX_FACTS} 个布尔量`, 'err');
      const name = uniqueName('flag', factNames());
      formRules.initial.facts[name] = false;
      renderStateEditors();
    });
    $('#btn-add-res').addEventListener('click', () => {
      if (resNames().length >= V.MAX_RESOURCES) return toast(`最多 ${V.MAX_RESOURCES} 种资源`, 'err');
      const name = uniqueName('res', resNames());
      formRules.caps[name] = 5;
      formRules.initial.resources[name] = 0;
      renderStateEditors();
    });
    $('#btn-add-action').addEventListener('click', () => {
      if (formRules.actions.length >= V.MAX_ACTIONS) return toast(`最多 ${V.MAX_ACTIONS} 个动作`, 'err');
      const id = uniqueName('action', formRules.actions.map((a) => a.id));
      formRules.actions.push({
        id, cost: 1, duration_ms: 100, pre: {}, min: {}, max: {}, add: [], remove: [], delta: {},
      });
      renderActionEditor();
    });
    $('#btn-add-event').addEventListener('click', () => {
      formRules.events.push({ t: 0, set_facts: {}, set_resources: {} });
      renderEventEditor();
    });
    $('#in-budget').addEventListener('change', (e) => {
      formRules.budget = parseInt(e.target.value, 10);
    });
  }

  function uniqueName(base, used) {
    let n = base, i = 1;
    while (used.includes(n)) n = base + (++i);
    return n;
  }

  /* ---------------- 应用规则 ---------------- */

  function applyRules(showOk) {
    stopPlay();
    const result = V.validate(formRules);
    const statusSels = ['#rules-status', '#rules-status-2', '#rules-status-3'];
    if (result.errors.length) {
      statusSels.forEach((s) => setStatus(s, result.errors.join('；'), 'err'));
      return false;
    }
    statusSels.forEach((s) => setStatus(s, result.warnings.length ? result.warnings.join('；') : '规则已生效', result.warnings.length ? '' : 'ok'));
    domain = result.domain;
    engine = S.createEngine(domain, P);
    lastPlanResult = P.plan(domain, domain.initial);
    renderAll();
    if (showOk) toast('规则已应用，演算已复位', 'ok');
    return true;
  }

  /* ---------------- 计划渲染 ---------------- */

  function currentPlanResult() {
    if (planView === 'static' || !engine) return lastPlanResult;
    return P.plan(domain, engine.state);
  }

  function renderPlan() {
    const r = currentPlanResult();
    const banner = $('#plan-banner');
    const tbody = $('#plan-table').querySelector('tbody');
    const empty = $('#plan-empty');
    tbody.innerHTML = '';

    if (!r) {
      banner.className = 'banner banner-idle';
      banner.textContent = '尚无生效规则';
      $('#plan-meta').innerHTML = '';
      empty.hidden = false;
      empty.textContent = '应用规则后在此显示最优计划';
      return;
    }
    empty.hidden = true;

    const meta = $('#plan-meta');
    meta.innerHTML = `
      <span>视角：<strong>${planView === 'static' ? '初始状态静态规划' : `t=${engine.t} 当前状态规划`}</strong></span>
      <span>扩展状态：<strong>${r.expansions}</strong> / 预算 ${r.budget}</span>
      <span>到达状态数：<strong>${r.statesReached}</strong></span>
      <span>未检查候选：<strong>${r.remainingCandidates}</strong></span>`;

    if (r.status === 'solved') {
      banner.className = 'banner banner-solved';
      banner.innerHTML = `✓ 已找到最优计划：<small>${r.plan.length ? esc(r.plan.join(' → ')) : '空计划（当前状态已满足目标）'}　·　总成本 ${r.cost}</small>`;
      if (r.plan.length === 0) {
        empty.hidden = false;
        empty.textContent = '当前状态已满足目标，无需执行任何动作。';
      }
      r.steps.forEach((s, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="step-idx">${i + 1}</td>
          <td class="action-id">${esc(s.actionId)}</td>
          <td class="mono">${s.costAfter}</td>
          <td class="mono">${s.durationAfter}</td>
          <td><div class="state-cell">${stateChips(s.stateAfter)}</div></td>`;
        tbody.appendChild(tr);
      });
    } else if (r.status === 'unsolvable') {
      banner.className = 'banner banner-unsolvable';
      banner.innerHTML = `✕ 无解：<small>完整有限状态空间搜索完毕（队列为空），不存在可达目标的动作序列。</small>`;
      empty.hidden = false;
      empty.textContent = `已扩展 ${r.expansions} 个状态，未检查候选为 0。`;
    } else {
      banner.className = 'banner banner-budget';
      banner.innerHTML = `⏱ 搜索预算耗尽：<small>已扩展 ${r.expansions}/${r.budget} 个状态，仍有 ${r.remainingCandidates} 个未检查候选；当前不能证明最优，也不能判定无解。</small>`;
      empty.hidden = false;
      empty.textContent = '可在左侧调大预算后重新应用规则。';
    }
  }

  function stateChips(state) {
    const facts = Object.keys(state.facts).sort().map((n) =>
      `<span class="mini-chip ${state.facts[n] ? 'is-true' : 'is-false'}">${esc(n)}=${state.facts[n]}</span>`).join('');
    const res = Object.keys(state.resources).sort().map((n) =>
      `<span class="mini-chip res">${esc(n)}=${state.resources[n]}/${domain.caps[n]}</span>`).join('');
    return `<div class="state-line">${facts}</div><div class="state-line">${res}</div>`;
  }

  /* ---------------- 演算渲染 ---------------- */

  const STATUS_TEXT = {
    idle: ['待规划', 'idle'],
    running: ['演算中', 'running'],
    goal_reached: ['已到目标', 'goal_reached'],
    unsolvable: ['无解（已暂停）', 'unsolvable'],
    budget_exhausted: ['预算耗尽（已暂停）', 'budget_exhausted'],
  };

  function renderSim() {
    if (!engine) return;
    const snap = S.snapshot(engine);
    const [txt, cls] = STATUS_TEXT[engine.status] || [engine.status, 'idle'];
    $('#sim-stat').innerHTML = `<span class="status-pill ${cls}">${txt}</span>`;
    $('#sim-time').textContent = engine.t + ' ms';
    $('#sim-cost').textContent = engine.cost;
    $('#sim-replans').textContent = engine.replanCount;
    const b = S.peekBoundary(engine);
    $('#sim-boundary').textContent = b === null ? '—' : b + ' ms';

    // 在途
    const box = $('#inflight-box');
    if (engine.inflight) {
      box.hidden = false;
      const inf = engine.inflight;
      const action = domain.actions.find((a) => a.id === inf.actionId);
      $('#inflight-name').textContent = inf.actionId;
      $('#inflight-window').textContent = `${inf.start} → ${inf.finish} ms（cost ${action.cost}）`;
      updateProgress();
    } else {
      box.hidden = true;
    }

    // 当前状态可编辑
    renderStateEditor(snap.state);
    // 待触发
    renderPending();
    // 日志
    renderLog();
    // 按钮可用性
    const terminal = ['goal_reached', 'unsolvable', 'budget_exhausted'].includes(engine.status);
    $('#btn-play').disabled = terminal || playTimer !== null;
    $('#btn-step').disabled = terminal || S.peekBoundary(engine) === null;
  }

  function updateProgress() {
    if (!engine || !engine.inflight) return;
    const inf = engine.inflight;
    const pct = Math.min(100, Math.max(0, ((engine.t - inf.start) / (inf.finish - inf.start)) * 100));
    $('#inflight-bar').style.width = pct + '%';
  }

  function renderStateEditor(state) {
    const box = $('#state-editor');
    box.innerHTML = '';
    Object.keys(state.facts).sort().forEach((n) => {
      const item = document.createElement('div');
      item.className = 'state-item';
      item.innerHTML = `<span class="state-name">${esc(n)}</span>
        <label class="fact-chip ${state.facts[n] ? 'is-on' : ''}">
          <input type="checkbox" class="edit-fact" ${state.facts[n] ? 'checked' : ''}> ${state.facts[n]}
        </label>`;
      item.querySelector('.edit-fact').addEventListener('change', (e) => {
        engine.state.facts[n] = e.target.checked;
        afterManualStateEdit();
      });
      box.appendChild(item);
    });
    Object.keys(state.resources).sort().forEach((n) => {
      const item = document.createElement('div');
      item.className = 'state-item';
      item.innerHTML = `<span class="state-name">${esc(n)}/${domain.caps[n]}</span>
        <input type="number" min="0" max="${domain.caps[n]}" step="1" class="input edit-res" value="${state.resources[n]}">`;
      item.querySelector('.edit-res').addEventListener('change', (e) => {
        let v = parseInt(e.target.value, 10);
        if (!Number.isInteger(v)) v = engine.state.resources[n];
        v = Math.max(0, Math.min(domain.caps[n], v));
        e.target.value = v;
        engine.state.resources[n] = v;
        afterManualStateEdit();
      });
      box.appendChild(item);
    });
  }

  // 手动改状态：取消在途（无成本无效果）→ 判目标/重规划
  function afterManualStateEdit() {
    stopPlay();
    if (engine.inflight) {
      const act = engine.inflight;
      engine.canceled.push({ actionId: act.actionId, at: engine.t, eventIds: ['manual-edit'] });
      engine.log.push({
        seq: engine.log.length, kind: 'cancel', t: engine.t,
        message: `手动修改状态，取消在途动作「${act.actionId}」：不扣成本、不产生效果`,
      });
      engine.inflight = null;
    }
    if (P.isGoalState(domain, engine.state)) {
      engine.status = 'goal_reached';
      engine.log.push({ seq: engine.log.length, kind: 'goal', t: engine.t, message: '手动修改后状态已满足目标' });
    } else {
      const rr = replanFromEngine();
      if (rr.status === 'solved') startFromEnginePlan();
    }
    renderAll();
  }

  function replanFromEngine() {
    // 复用引擎内部重规划路径：通过注入一个同刻空事件不合适，直接调用内部行为
    // 引擎未暴露 replan，这里通过 plan + 手动启动等价完成
    const result = P.plan(domain, engine.state);
    engine.plan = result;
    engine.replanCount++;
    if (result.status === 'solved') {
      engine.status = engine.status === 'goal_reached' ? 'goal_reached' : 'running';
      engine.log.push({
        seq: engine.log.length, kind: 'replan', t: engine.t,
        message: `重规划成功：${result.plan.length ? result.plan.join(' → ') : '（空计划）'}，总成本 ${result.cost}`,
      });
    } else if (result.status === 'unsolvable') {
      engine.status = 'unsolvable';
      engine.log.push({ seq: engine.log.length, kind: 'unsolvable', t: engine.t, message: '规划失败：不存在可达目标的计划' });
    } else {
      engine.status = 'budget_exhausted';
      engine.log.push({ seq: engine.log.length, kind: 'budget', t: engine.t, message: `规划中止：预算 ${result.budget} 耗尽，剩 ${result.remainingCandidates} 个候选` });
    }
    return result;
  }

  function startFromEnginePlan() {
    if (!engine.plan || engine.plan.status !== 'solved' || engine.plan.plan.length === 0) {
      if (engine.plan && engine.plan.plan.length === 0) {
        engine.status = 'goal_reached';
      }
      return;
    }
    const id = engine.plan.plan[0];
    const action = domain.actions.find((a) => a.id === id);
    engine.inflight = { actionId: id, start: engine.t, finish: engine.t + action.duration_ms };
    engine.log.push({ seq: engine.log.length, kind: 'start', t: engine.t, message: `开始执行「${id}」，完成时刻 ${engine.inflight.finish}` });
  }

  function renderPending() {
    const box = $('#pending-list');
    box.innerHTML = '';
    const list = S.pendingEvents(engine);
    $('#pending-hint').textContent = list.length ? `${list.length} 个` : '无';
    if (!list.length) {
      box.innerHTML = '<div class="pending-empty">时间线上没有待触发事件。</div>';
      return;
    }
    list.forEach((ev) => {
      const item = document.createElement('div');
      item.className = 'pending-item';
      const f = Object.keys(ev.set_facts).map((k) => `${k}=${ev.set_facts[k]}`);
      const r = Object.keys(ev.set_resources).map((k) => `${k}=${ev.set_resources[k]}`);
      item.innerHTML = `
        <span class="mono">t=${ev.t}</span>
        <span class="pending-tag">${ev.source === 'injected' ? '插入' : '规则'}</span>
        <span class="pending-body">${esc([...f, ...r].join('，') || '（无赋值）')}</span>
        <button class="card-remove" type="button">移除</button>`;
      item.querySelector('button').addEventListener('click', () => {
        S.removePendingEvent(engine, ev.id);
        renderAll();
      });
      box.appendChild(item);
    });
  }

  function renderLog() {
    const box = $('#log-box');
    const groups = { plan: ['replan', 'unsolvable', 'budget', 'goal'], exec: ['start', 'complete', 'cancel', 'reset'], event: ['event', 'schedule'] };
    const lines = engine.log.filter((l) => {
      if (logFilter === 'all') return true;
      return groups[logFilter].includes(l.kind);
    });
    box.innerHTML = lines.map((l) => `
      <div class="log-line k-${l.kind}">
        <span class="log-t">${String(l.t).padStart(6, ' ')}ms</span>
        <span class="log-kind">${logKindLabel(l.kind)}</span>
        <span class="log-msg">${esc(l.message)}</span>
      </div>`).join('') || '<div class="pending-empty">暂无日志。</div>';
    box.scrollTop = box.scrollHeight;
  }

  function logKindLabel(k) {
    return {
      reset: '复位', start: '开始', complete: '完成', cancel: '中断',
      event: '事件', schedule: '登记', replan: '重规划',
      goal: '达目标', unsolvable: '无解', budget: '预算',
    }[k] || k;
  }

  function renderAll() {
    renderPlan();
    renderSim();
  }

  /* ---------------- 播放控制 ---------------- */

  function stopPlay() {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (engine) renderSim();
  }

  function play() {
    if (!engine || playTimer) return;
    if (['goal_reached', 'unsolvable', 'budget_exhausted'].includes(engine.status)) return;
    $('#btn-play').disabled = true;
    scheduleTick();
    progressTimer = setInterval(updateProgress, 80);
  }

  function scheduleTick() {
    const b = S.peekBoundary(engine);
    if (b === null) { stopPlay(); return; }
    const speed = parseInt($('#in-speed').value, 10);
    const delay = Math.max(40, (b - engine.t) * (speed / 1000));
    playTimer = setTimeout(() => {
      S.step(engine);
      renderAll();
      if (['goal_reached', 'unsolvable', 'budget_exhausted'].includes(engine.status) ||
          S.peekBoundary(engine) === null) {
        stopPlay();
        return;
      }
      scheduleTick();
    }, delay);
  }

  function initControls() {
    $('#btn-play').addEventListener('click', play);
    $('#btn-pause').addEventListener('click', () => { stopPlay(); toast('已暂停'); });
    $('#btn-step').addEventListener('click', () => {
      stopPlay();
      const r = S.step(engine);
      if (!r.advanced) toast('没有可推进的时间边界', 'err');
      renderAll();
    });
    $('#btn-reset').addEventListener('click', () => {
      stopPlay();
      S.reset(engine);
      renderAll();
      toast('演算已复位');
    });
    $('#in-speed').addEventListener('change', () => {
      if (playTimer) { stopPlay(); play(); }
    });
    $('#log-filter').addEventListener('change', (e) => { logFilter = e.target.value; renderLog(); });

    $('#seg-static').addEventListener('click', () => {
      planView = 'static';
      $('#seg-static').classList.add('is-active');
      $('#seg-runtime').classList.remove('is-active');
      renderPlan();
    });
    $('#seg-runtime').addEventListener('click', () => {
      planView = 'runtime';
      $('#seg-runtime').classList.add('is-active');
      $('#seg-static').classList.remove('is-active');
      renderPlan();
    });
  }

  /* ---------------- 事件注入 ---------------- */

  function renderInjectFields() {
    const box = $('#inject-fields');
    box.innerHTML = '';
    factNames().forEach((n) => {
      const item = document.createElement('div');
      item.className = 'state-item';
      item.innerHTML = `<span class="state-name">${esc(n)}</span>
        <select class="input inj-fact" data-name="${esc(n)}">
          <option value="">不修改</option>
          <option value="true">设为 true</option>
          <option value="false">设为 false</option>
        </select>`;
      box.appendChild(item);
    });
    resNames().forEach((n) => {
      const item = document.createElement('div');
      item.className = 'state-item';
      item.innerHTML = `<span class="state-name">${esc(n)}/${formRules.caps[n]}</span>
        <input type="number" min="0" max="${formRules.caps[n]}" step="1" class="input inj-res" data-name="${esc(n)}" placeholder="不修改">`;
      box.appendChild(item);
    });
    $('#in-ev-t').value = engine ? engine.t : 0;
    $('#in-ev-t-hint').textContent = engine ? `当前时刻 ${engine.t} ms` : '';
  }

  function initInject() {
    $('#btn-inject').addEventListener('click', () => {
      const t = parseInt($('#in-ev-t').value, 10);
      const set_facts = {};
      $$('.inj-fact').forEach((sel) => {
        if (sel.value !== '') set_facts[sel.dataset.name] = sel.value === 'true';
      });
      const set_resources = {};
      $$('.inj-res').forEach((inp) => {
        if (inp.value !== '') set_resources[inp.dataset.name] = parseInt(inp.value, 10);
      });
      const r = S.injectEvent(engine, { t, set_facts, set_resources });
      if (!r.ok) { setStatus('#inject-status', r.error, 'err'); return; }
      setStatus('#inject-status', `事件已${r.advanced ? '立即处理' : '登记'}`, 'ok');
      renderAll();
    });
  }

  /* ---------------- 导入 / 导出 ---------------- */

  function initImportExport() {
    const modalImp = $('#modal-import');
    const modalExp = $('#modal-export');

    $('#btn-import').addEventListener('click', () => {
      $('#import-text').value = '';
      setStatus('#import-status', '', '');
      modalImp.hidden = false;
    });
    $('#btn-export').addEventListener('click', () => {
      $('#export-text').value = buildExport('bundle');
      modalExp.hidden = false;
    });
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
      $('#' + b.dataset.close).hidden = true;
    }));
    [modalImp, modalExp].forEach((m) => m.addEventListener('click', (e) => {
      if (e.target === m) m.hidden = true;
    }));

    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { $('#import-text').value = reader.result; };
      reader.readAsText(file);
    });

    $('#btn-do-import').addEventListener('click', () => {
      let parsed;
      try { parsed = JSON.parse($('#import-text').value); }
      catch (e) { setStatus('#import-status', 'JSON 解析失败：' + e.message, 'err'); return; }
      const result = V.validate(parsed);
      if (result.errors.length) { setStatus('#import-status', result.errors.join('；'), 'err'); return; }
      formRules = clone(parsed);
      applyRules(false);
      renderStateEditors();
      renderInjectFields();
      modalImp.hidden = true;
      toast('规则导入成功，演算已复位', 'ok');
    });

    $$('[data-export]').forEach((btn) => btn.addEventListener('click', () => {
      $('#export-text').value = buildExport(btn.dataset.export);
      setStatus('#export-status', '已生成 ' + btn.textContent.trim(), 'ok');
    }));

    $('#btn-copy-export').addEventListener('click', async () => {
      const text = $('#export-text').value;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'ok');
      } catch (e) {
        $('#export-text').select();
        document.execCommand('copy');
        toast('已选中内容，可手动 Ctrl+C', '');
      }
    });

    $('#btn-download-export').addEventListener('click', () => {
      const text = $('#export-text').value;
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'goap-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  function buildExport(kind) {
    const snap = engine ? S.snapshot(engine) : null;
    if (kind === 'rules') return JSON.stringify(domain || formRules, null, 2);
    if (kind === 'plan') {
      const r = currentPlanResult();
      return JSON.stringify({
        view: planView,
        status: r.status,
        plan: r.plan,
        cost: r.cost,
        expansions: r.expansions,
        budget: r.budget,
        remainingCandidates: r.remainingCandidates,
        steps: r.steps,
      }, null, 2);
    }
    if (kind === 'log') {
      return JSON.stringify({
        t: engine.t,
        status: engine.status,
        totalCost: engine.cost,
        completed: engine.completed,
        canceled: engine.canceled,
        log: engine.log,
      }, null, 2);
    }
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      rules: domain || formRules,
      plan: (() => {
        const r = currentPlanResult();
        return { status: r.status, plan: r.plan, cost: r.cost, expansions: r.expansions, budget: r.budget, steps: r.steps };
      })(),
      execution: snap,
    }, null, 2);
  }

  /* ---------------- JSON 面板 ---------------- */

  function initJsonPane() {
    $('#btn-apply-json').addEventListener('click', () => {
      let parsed;
      try { parsed = JSON.parse($('#json-editor').value); }
      catch (e) { setStatus('#json-status', 'JSON 解析失败：' + e.message, 'err'); return; }
      const result = V.validate(parsed);
      if (result.errors.length) { setStatus('#json-status', result.errors.join('；'), 'err'); return; }
      formRules = clone(parsed);
      applyRules(false);
      renderStateEditors();
      renderInjectFields();
      setStatus('#json-status', 'JSON 已应用，演算已复位', 'ok');
    });
    $('#btn-refresh-json').addEventListener('click', () => {
      $('#json-editor').value = JSON.stringify(formRules, null, 2);
      setStatus('#json-status', '已从表单刷新', 'ok');
    });
  }

  /* ---------------- 样例加载 ---------------- */

  function initSamples() {
    $('#sample-select').addEventListener('change', (e) => {
      const key = e.target.value;
      if (!key) return;
      stopPlay();
      formRules = clone(window.GOAPSamples[key]);
      const result = V.validate(formRules);
      if (result.errors.length) { toast('样例校验失败：' + result.errors[0], 'err'); return; }
      domain = result.domain;
      engine = S.createEngine(domain, P);
      lastPlanResult = P.plan(domain, domain.initial);
      renderStateEditors();
      renderInjectFields();
      renderAll();
      toast(`已加载样例「${key}」`, 'ok');
      e.target.value = '';
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    initTheme();
    initTabs();
    initAddButtons();
    initControls();
    initInject();
    initImportExport();
    initJsonPane();
    initSamples();

    ['#btn-apply-rules', '#btn-apply-rules-2', '#btn-apply-rules-3'].forEach((sel) => {
      $(sel).addEventListener('click', () => {
        if (applyRules(true)) renderInjectFields();
      });
    });

    // 首次载入 demo
    const result = V.validate(formRules);
    domain = result.domain;
    engine = S.createEngine(domain, P);
    lastPlanResult = P.plan(domain, domain.initial);
    renderStateEditors();
    renderInjectFields();
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
