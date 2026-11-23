/* 共用提示校验台 —— 界面逻辑。求解全部委托 SharedSignalSolver。 */
(function () {
  'use strict';
  const S = window.SharedSignalSolver;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SAMPLE_PATH = 'samples/shared-signal.json';
  const EMBEDDED_SAMPLE = {
    horizon: 3,
    initial: [1, 2],
    states: [
      { id: 1, hint: '未亮' }, { id: 2, hint: '未亮' },
      { id: 3, hint: '左灯' }, { id: 4, hint: '右灯' },
      { id: 5, hint: '完成', goal: true }
    ],
    actions: [
      { id: 1, name: '一起试灯' }, { id: 2, name: '确认左侧' }, { id: 3, name: '确认右侧' }
    ],
    transitions: [[1, 1, [3]], [2, 1, [4]], [3, 2, [5]], [4, 3, [5]]],
    rules: '起始集合非空且提示相同；每次联合动作耗一拍，先更新所有可能后继，再观察新提示。若时限耗尽且未保证成功，该分支失败。'
  };

  /* ---------------- 全局状态 ---------------- */
  const state = {
    raw: JSON.parse(JSON.stringify(EMBEDDED_SAMPLE))
  };
  let build = null;       // { ok, errors, warnings, model }
  let model = null;
  let path = [];          // 工作台历史：[{ mask, t, chosenAi }]
  let currentMask = null;
  let currentT = 0;
  let selectedAi = null;  // 工作台当前选中的动作（用于单步选观察）
  let role = 'tester';
  let theme = 'system';

  /* ---------------- 模型装载 ---------------- */

  function loadModel(raw, sourceLabel) {
    state.raw = raw;
    build = S.buildModel(raw);
    if (!build.ok) {
      model = null;
      showBuildErrors(build.errors, build.warnings);
      return false;
    }
    model = build.model;
    currentMask = model.initialMask;
    currentT = model.horizon;
    path = [];
    selectedAi = null;
    renderAll();
    if (build.warnings.length) showBuildErrors([], build.warnings);
    else clearEditorMsgs();
    if (sourceLabel) flashEditor('已载入：' + sourceLabel, 'ok');
    return true;
  }

  function rootResult() {
    return S.evaluate(model, model.initialMask, model.horizon);
  }
  function currentResult() {
    return S.evaluate(model, currentMask, currentT);
  }

  /* ---------------- 标签页 / 视角 / 主题 ---------------- */

  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.setAttribute('aria-selected', t === tab));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.tab));
    if (tab.dataset.tab === 'policy') renderPolicy();
    if (tab.dataset.tab === 'editor') syncEditorFromModel();
  }));

  function setRole(r) {
    role = r;
    document.body.dataset.role = r;
    $('#role-tester').setAttribute('aria-pressed', String(r === 'tester'));
    $('#role-player').setAttribute('aria-pressed', String(r === 'player'));
    renderWorkbench();
  }
  $('#role-tester').addEventListener('click', () => setRole('tester'));
  $('#role-player').addEventListener('click', () => setRole('player'));

  $('#theme-toggle').addEventListener('click', () => {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    applyTheme();
  });
  function applyTheme() {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    $('#theme-toggle').textContent = theme === 'system' ? '主题：自动' : theme === 'light' ? '主题：浅色' : '主题：深色';
    try { localStorage.setItem('ssp-theme', theme); } catch (e) { /* 无存储也可用 */ }
  }
  try {
    const saved = localStorage.getItem('ssp-theme');
    if (saved) theme = saved;
  } catch (e) { /* 忽略 */ }
  applyTheme();

  /* ---------------- 工作台 ---------------- */

  function currentHint() {
    const ids = S.maskIds(currentMask, model.states);
    const hints = new Set(ids.map(id => model.stateById.get(id).hint));
    return hints.size === 1 ? [...hints][0] : '（候选状态提示不一致）';
  }

  function renderVerdict() {
    const root = rootResult();
    const slot = $('#verdict-slot');
    if (root.win) {
      slot.innerHTML = `<div class="verdict good">
        <span class="badge good"><span class="dot"></span>可保证过关</span>
        <div>
          <div class="v-title">存在保证策略，最坏 ${root.cost} 拍通关</div>
          <div class="v-body">首选动作「${esc(model.actions[root.action].name)}」（动作 ${model.actions[root.action].id}）。每个观察分支都已验证可达全终点集合。</div>
        </div>
      </div>`;
    } else {
      slot.innerHTML = `<div class="verdict bad">
        <span class="badge bad"><span class="dot"></span>无法保证过关</span>
        <div>
          <div class="v-title">${esc(root.reason || '不存在保证策略')}</div>
          <div class="v-body">在下方任选一个合法首动作，可查看一个会让它无法保证过关的后续提示（对抗轨迹）。</div>
        </div>
      </div>`;
    }
  }

  function renderBeatbar() {
    const used = model.horizon - currentT;
    let html = '';
    for (let i = 1; i <= model.horizon; i++) {
      const cls = i <= used ? 'beat used' : i === used + 1 ? 'beat current' : 'beat';
      html += `<div class="${cls}">${i}</div>`;
    }
    $('#wb-beats').innerHTML = html;
    $('#wb-beat-label').textContent = `剩余 ${currentT} 拍 / 共 ${model.horizon} 拍`;
  }

  function beliefChips(mask) {
    return S.maskIds(mask, model.states).map(id => {
      const st = model.stateById.get(id);
      return `<span class="chip ${st.goal ? 'goal' : ''}">
        <span class="st-id">#${st.id}</span>
        <span class="st-hint">${esc(st.hint)}</span>
        ${st.goal ? '<span class="goal-flag">终点</span>' : ''}
      </span>`;
    }).join('');
  }

  function renderWorkbench() {
    if (!model) return;
    renderVerdict();
    renderBeatbar();
    $('#wb-hint').textContent = currentHint();

    const ids = S.maskIds(currentMask, model.states);
    $('#wb-belief-count').innerHTML = `${ids.length} 个可能状态`;
    $('#wb-belief-note').textContent = '测试员能看到这些隐藏状态；玩家只能看到左侧共用提示。';
    $('#wb-belief').innerHTML = beliefChips(currentMask);
    $('#wb-belief-player-note').hidden = role !== 'player';
    $('#wb-player-card-note').hidden = role !== 'player';

    const cur = currentResult();
    $('#wb-act-hint').textContent = cur.win
      ? (cur.cost === 0 ? '当前候选集已全部是终点，无需再选动作。'
        : `此节点可保证，最坏还需 ${cur.cost} 拍。动作仅能基于已看到的共用提示选择。`)
      : '此节点无法保证过关；可点合法动作查看致命观察。';

    renderActionTable();
    renderObsPanel();
    renderCounterPanel();
  }

  function renderActionTable() {
    const rows = S.analyzeActions(model, currentMask, currentT);
    const tbody = $('#wb-actions tbody');
    tbody.innerHTML = rows.map(r => {
      const status = !r.legal
        ? '<span class="badge bad">非法</span>'
        : r.chosen ? '<span class="badge accent">最优选择</span>'
          : r.guaranteed ? '<span class="badge good">可保证</span>'
            : '<span class="badge warn">会被淘汰</span>';
      let detail;
      if (!r.legal) {
        detail = `<span class="reason bad">${esc(r.eliminatedReason)}</span>`;
      } else if (!r.guaranteed) {
        const pills = r.branches.map(b => `<span class="branch-pill ${b.win ? 'win' : 'fail'}">
          <span class="b-hint">${esc(b.hint)}</span>
          ${b.win ? `<span class="b-cost">${b.cost} 拍</span>` : '<span class="b-cost">失败</span>'}
        </span>`).join('');
        detail = `<div class="branch-pills">${pills}
          <span class="reason bad">${esc(r.eliminatedReason)}</span></div>`;
      } else {
        const pills = r.branches.map(b => `<span class="branch-pill win">
          <span class="b-hint">${esc(b.hint)}</span><span class="b-cost">${b.cost} 拍</span></span>`).join('');
        detail = `<div class="branch-pills">${pills}
          ${r.eliminatedReason ? `<span class="reason">${esc(r.eliminatedReason)}</span>` : ''}</div>`;
      }
      const canPick = r.legal;
      return `<tr class="${r.chosen ? 'chosen' : ''}" data-ai="${r.index}">
        <td><span class="act-name">${esc(r.name)}</span><br><span class="act-id">动作 ${r.id}</span></td>
        <td>${status}</td>
        <td style="min-width:200px">${detail}</td>
        <td>${canPick ? `<button class="btn small ${r.chosen ? 'primary' : ''}" data-pick="${r.index}" type="button">选择</button>` : ''}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-pick]').forEach(btn => btn.addEventListener('click', () => {
      selectedAi = Number(btn.dataset.pick);
      renderObsPanel();
      btn.closest('tr').classList.add('pulse');
    }));
  }

  function renderObsPanel() {
    const slot = $('#wb-obs');
    if (selectedAi === null || !S.legalActions(model, currentMask).includes(selectedAi)) {
      slot.innerHTML = '<p class="muted">先在右侧选择一个合法动作。</p>';
      return;
    }
    const applied = S.applyAction(model, currentMask, selectedAi);
    const act = model.actions[selectedAi];
    let html = `<p class="muted" style="margin-top:0">已选「${esc(act.name)}」。按下后所有允许后继都可能发生，同一提示的后继已合并为一个候选集，选择实际观察到的提示：</p>`;
    html += '<div class="obs-grid">' + applied.branches.map(b => {
      const ev = S.evaluate(model, b.mask, currentT - 1);
      const n = S.maskIds(b.mask, model.states).length;
      const meta = role === 'tester'
        ? `${n} 个候选状态 · ${ev.win ? `可保证（${ev.cost} 拍）` : '无法保证'}`
        : ev.win ? `可保证（${ev.cost} 拍）` : '无法保证';
      return `<button class="obs-btn" data-branch="${esc(b.hint)}" type="button">
        <span class="o-hint">${esc(b.hint)}</span>
        <span class="o-meta">${meta}</span>
        <span class="o-arrow">→</span>
      </button>`;
    }).join('') + '</div>';
    slot.innerHTML = html;
    slot.querySelectorAll('[data-branch]').forEach(btn => btn.addEventListener('click', () => {
      const hint = btn.dataset.branch;
      const target = applied.branches.find(b => b.hint === hint);
      path.push({ mask: currentMask, t: currentT, chosenAi: selectedAi });
      currentMask = target.mask;
      currentT -= 1;
      selectedAi = null;
      renderWorkbench();
    }));
  }

  function renderCounterPanel() {
    const slot = $('#wb-counter');
    const cur = currentResult();
    const overall = rootResult().win;
    if (cur.win) {
      slot.innerHTML = overall
        ? '<p class="muted">当前节点存在保证策略，无需反例。可在「保证策略」页查看完整分支树。</p>'
        : '<p class="muted">这个局部节点能保证过关，但模型整体在其他分支上无解。</p>';
      return;
    }
    const legal = S.legalActions(model, currentMask);
    if (!legal.length) {
      slot.innerHTML = '<p class="muted">当前候选集上没有任何合法动作（存在状态缺少该动作的转移）。</p>';
      return;
    }
    let html = `<p class="muted" style="margin-top:0">${overall ? '当前局部节点无法保证过关。' : '整体无保证方案。'}选择一个合法动作，系统给出一个使其失败的后续提示及完整对抗轨迹：</p>`;
    html += '<div class="btn-row" style="margin-bottom:12px">' + legal.map(ai =>
      `<button class="btn small" data-counter="${ai}" type="button">${esc(model.actions[ai].name)} <span class="act-id">#${model.actions[ai].id}</span></button>`
    ).join('') + '</div><div id="trace-slot"></div>';
    slot.innerHTML = html;
    slot.querySelectorAll('[data-counter]').forEach(btn => btn.addEventListener('click', () => {
      const ai = Number(btn.dataset.counter);
      const trace = S.counterTrace(model, currentMask, currentT, ai);
      const target = $('#trace-slot');
      if (!trace.ok) {
        target.innerHTML = `<div class="msg ok">${esc(trace.reason)}</div>`;
        return;
      }
      target.innerHTML = `<div class="msg error" style="margin-bottom:10px">对抗结论：${esc(trace.endReason)}</div>
        <div class="trace">${trace.steps.map(st => `
          <div class="trace-step">
            <div class="ts-act">按出「${esc(st.actionName)}」（动作 ${st.actionId}）</div>
            <div class="ts-hint">观察到提示：${esc(st.hint)}</div>
            <div class="ts-belief tester-only">新候选集 {${st.belief.join(', ')}} · 剩 ${st.remaining} 拍</div>
            <div class="ts-belief player-only">剩 ${st.remaining} 拍</div>
          </div>`).join('')}</div>`;
    }));
  }

  /* ---------------- 策略树与重放 ---------------- */

  function renderPolicy() {
    if (!model) return;
    const root = rootResult();
    const v = $('#policy-verdict');
    if (!root.win) {
      v.innerHTML = `<div class="verdict bad"><span class="badge bad"><span class="dot"></span>无法保证过关</span>
        <div><div class="v-title">没有可导出的保证策略</div>
        <div class="v-body">请回到工作台查看对抗轨迹，或在数据编辑页调整时限、提示或转移。</div></div></div>`;
      $('#policy-tree').innerHTML = '<p class="muted">无解。</p>';
      $('#replay').innerHTML = '<p class="muted">无解。</p>';
      $('#export-btn').disabled = true;
      $('#download-btn').disabled = true;
      return;
    }
    $('#export-btn').disabled = false;
    $('#download-btn').disabled = false;
    v.innerHTML = `<div class="verdict good"><span class="badge good"><span class="dot"></span>可保证过关</span>
      <div><div class="v-title">最坏 ${root.cost} 拍 · 时限 ${model.horizon} 拍</div>
      <div class="v-body">每个节点标注候选信念集（测试员视角）与该拍应选动作；边上是玩家看到的共用提示。</div></div></div>`;

    const tree = S.policyTree(model);
    $('#policy-tree').innerHTML = renderTreeNode(tree);
    renderReplayer(tree);
  }

  function renderTreeNode(node) {
    if (node.terminal) {
      return `<div class="tree-node term">
        <strong>✓ 全终点</strong>
        <div class="tree-meta tester-only">信念集 {${node.belief.join(', ')}} · 剩余 ${node.remaining} 拍</div>
      </div>`;
    }
    const kids = node.branches.map(b => `
      <div>
        <div class="tree-edge">观察到 <span class="e-hint">${esc(b.hint)}</span></div>
        ${renderTreeNode(b.node)}
      </div>`).join('');
    return `<div class="tree-node">
      <div><span class="tree-act">▶ ${esc(node.actionName)}</span> <span class="act-id">动作 ${node.action}</span></div>
      <div class="tree-meta tester-only">候选集 {${node.belief.join(', ')}} · 最坏 ${node.worstCaseSteps} 拍 · 剩余 ${node.remaining} 拍</div>
      <div class="tree-children">${kids}</div>
    </div>`;
  }

  function renderReplayer(tree) {
    let node = tree;
    const slot = $('#replay');
    function draw() {
      if (node.terminal) {
        slot.innerHTML = `<div class="msg ok">✓ 到达全终点集合，通关保证成立。</div>
          <button class="btn small" id="rp-reset" type="button">重新重放</button>`;
      } else {
        slot.innerHTML = `
          <div class="rule-box" style="margin-bottom:10px">
            本拍动作：<strong style="color:var(--accent)">${esc(node.actionName)}</strong>（动作 ${node.action}）
            <div class="muted" style="margin-top:4px">最坏 ${node.worstCaseSteps} 拍 · 剩余 ${node.remaining} 拍</div>
          </div>
          <label class="field"><span style="font-size:12px;color:var(--fg-2)">选择实际观察到的提示</span>
            <select id="rp-select">${node.branches.map((b, i) => `<option value="${i}">${esc(b.hint)}</option>`).join('')}</select>
          </label>
          <div class="btn-row">
            <button class="btn primary small" id="rp-go" type="button">应用观察 →</button>
            <button class="btn small ghost" id="rp-reset" type="button">重置</button>
          </div>`;
      }
      const reset = $('#rp-reset');
      if (reset) reset.addEventListener('click', () => { node = tree; draw(); });
      const go = $('#rp-go');
      if (go) go.addEventListener('click', () => {
        node = node.branches[Number($('#rp-select').value)].node;
        draw();
      });
    }
    draw();
  }

  /* ---------------- 导出 ---------------- */

  function policyJson() {
    return JSON.stringify(S.exportPolicy(model), null, 2);
  }

  $('#export-btn').addEventListener('click', async () => {
    const text = policyJson();
    const msg = $('#export-msg');
    try {
      await navigator.clipboard.writeText(text);
      msg.innerHTML = '<div class="msg ok">已复制完整策略 JSON（可按观察分支重放）。</div>';
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      msg.innerHTML = '';
      msg.appendChild(ta);
      ta.select();
      msg.insertAdjacentHTML('beforeend', '<div class="msg warn">剪贴板不可用，已在文本框中给出，可手动复制。</div>');
    }
  });

  $('#download-btn').addEventListener('click', () => {
    const blob = new Blob([policyJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shared-signal-policy.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  /* ---------------- 编辑器 ---------------- */

  function showBuildErrors(errors, warnings) {
    const slot = $('#editor-msgs');
    let html = '';
    if (errors.length) html += `<div class="msg error"><strong>校验未通过（${errors.length}）</strong><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    if (warnings.length) html += `<div class="msg warn"><strong>提醒（${warnings.length}）</strong><ul>${warnings.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    slot.innerHTML = html;
  }
  function clearEditorMsgs() { $('#editor-msgs').innerHTML = ''; }
  function flashEditor(text, kind) {
    $('#editor-msgs').innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
  }

  function syncEditorFromModel() {
    if (!state.raw) return;
    $('#json-text').value = JSON.stringify(state.raw, null, 2);
    if (!model) { renderStructuredFromRaw(); return; }
    renderStructuredFromRaw();
    $('#ed-rules').textContent = state.raw.rules || '（未提供规则说明）';
  }

  function renderStructuredFromRaw() {
    const raw = state.raw;
    $('#ed-horizon').value = raw.horizon ?? '';
    const initial = new Set(raw.initial || []);

    $('#ed-states tbody').innerHTML = (raw.states || []).map((s, i) => `
      <tr data-si="${i}">
        <td><input type="number" class="ed-s-id" value="${esc(s.id)}" style="width:64px"></td>
        <td><input type="text" class="ed-s-hint" value="${esc(s.hint ?? '')}"></td>
        <td style="text-align:center"><input type="checkbox" class="ed-s-goal" ${s.goal ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="ed-s-init" ${initial.has(s.id) ? 'checked' : ''}></td>
        <td><button class="btn small ghost ed-del-state" type="button">删</button></td>
      </tr>`).join('');

    $('#ed-actions tbody').innerHTML = (raw.actions || []).map((a, i) => `
      <tr data-ai="${i}">
        <td><input type="number" class="ed-a-id" value="${esc(a.id)}" style="width:64px"></td>
        <td><input type="text" class="ed-a-name" value="${esc(a.name ?? '')}"></td>
        <td><button class="btn small ghost ed-del-action" type="button">删</button></td>
      </tr>`).join('');

    const stateIds = (raw.states || []).map(s => s.id);
    $('#ed-trans').innerHTML = '<table><thead><tr><th>状态</th><th>动作</th><th>后继状态（可多选）</th><th></th></tr></thead><tbody>' +
      (raw.transitions || []).map((tr, i) => {
        const [sid, aid, nxt] = tr;
        const nxtSet = new Set(nxt);
        return `<tr data-ti="${i}">
          <td><select class="ed-t-s">${stateIds.map(id => `<option value="${esc(id)}" ${id === sid ? 'selected' : ''}>#${esc(id)}</option>`).join('')}</select></td>
          <td><select class="ed-t-a">${(raw.actions || []).map(a => `<option value="${esc(a.id)}" ${a.id === aid ? 'selected' : ''}>${esc(a.name || a.id)}</option>`).join('')}</select></td>
          <td><div class="succ-box">${stateIds.map(id => `<label class="succ-pick"><input type="checkbox" class="ed-t-n" value="${esc(id)}" ${nxtSet.has(id) ? 'checked' : ''}>#${esc(id)}</label>`).join('')}</div></td>
          <td><button class="btn small ghost ed-del-trans" type="button">删</button></td>
        </tr>`;
      }).join('') + '</tbody></table>';

    wireEditorRowEvents();
  }

  function wireEditorRowEvents() {
    $$('.ed-del-state').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.closest('tr').dataset.si);
      state.raw.states.splice(i, 1);
      renderStructuredFromRaw();
    }));
    $$('.ed-del-action').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.closest('tr').dataset.ai);
      state.raw.actions.splice(i, 1);
      renderStructuredFromRaw();
    }));
    $$('.ed-del-trans').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.closest('tr').dataset.ti);
      state.raw.transitions.splice(i, 1);
      renderStructuredFromRaw();
    }));
  }

  function collectStructured() {
    const states = $$('#ed-states tbody tr').map(tr => ({
      id: Number(tr.querySelector('.ed-s-id').value),
      hint: tr.querySelector('.ed-s-hint').value,
      goal: tr.querySelector('.ed-s-goal').checked
    }));
    const initial = $$('#ed-states tbody tr').filter(tr => tr.querySelector('.ed-s-init').checked)
      .map(tr => Number(tr.querySelector('.ed-s-id').value));
    const actions = $$('#ed-actions tbody tr').map(tr => ({
      id: Number(tr.querySelector('.ed-a-id').value),
      name: tr.querySelector('.ed-a-name').value
    }));
    const transitions = $$('#ed-trans tbody tr').map(tr => [
      Number(tr.querySelector('.ed-t-s').value),
      Number(tr.querySelector('.ed-t-a').value),
      Array.from(tr.querySelectorAll('.ed-t-n:checked')).map(cb => Number(cb.value))
    ]);
    return {
      horizon: Number($('#ed-horizon').value),
      states, actions, initial, transitions,
      rules: state.raw.rules || ''
    };
  }

  $('#ed-add-state').addEventListener('click', () => {
    const nextId = Math.max(0, ...(state.raw.states || []).map(s => s.id)) + 1;
    state.raw.states.push({ id: nextId, hint: '新提示' });
    renderStructuredFromRaw();
  });
  $('#ed-add-action').addEventListener('click', () => {
    const nextId = Math.max(0, ...(state.raw.actions || []).map(a => a.id)) + 1;
    state.raw.actions.push({ id: nextId, name: '新动作' });
    renderStructuredFromRaw();
  });
  $('#ed-add-trans').addEventListener('click', () => {
    const s0 = state.raw.states[0]?.id;
    const a0 = state.raw.actions[0]?.id;
    if (s0 == null || a0 == null) { flashEditor('先创建至少一个状态和一个动作。', 'warn'); return; }
    state.raw.transitions.push([s0, a0, [s0]]);
    renderStructuredFromRaw();
  });
  $('#ed-rebuild').addEventListener('click', () => {
    const candidate = collectStructured();
    $('#json-text').value = JSON.stringify(candidate, null, 2);
    loadModel(candidate, '结构化编辑');
  });

  $('#json-apply').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('#json-text').value);
      loadModel(parsed, 'JSON 文本');
    } catch (e) {
      showBuildErrors(['JSON 解析失败：' + e.message], []);
    }
  });
  $('#json-sync').addEventListener('click', () => {
    $('#json-text').value = JSON.stringify(state.raw, null, 2);
    flashEditor('已把当前模型写回文本框。', 'ok');
  });
  $('#load-sample').addEventListener('click', async () => {
    try {
      const resp = await fetch(SAMPLE_PATH);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      loadModel(await resp.json(), 'samples/shared-signal.json');
    } catch (e) {
      loadModel(JSON.parse(JSON.stringify(EMBEDDED_SAMPLE)), '内置样例（外部文件不可达）');
    }
  });
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { loadModel(JSON.parse(reader.result), '文件 ' + file.name); }
      catch (err) { showBuildErrors(['文件不是合法 JSON：' + err.message], []); }
    };
    reader.readAsText(file);
  });

  /* ---------------- 工作台导航 ---------------- */
  $('#wb-reset').addEventListener('click', () => {
    currentMask = model.initialMask;
    currentT = model.horizon;
    path = [];
    selectedAi = null;
    renderWorkbench();
  });
  $('#wb-back').addEventListener('click', () => {
    const prev = path.pop();
    if (!prev) return;
    currentMask = prev.mask;
    currentT = prev.t;
    selectedAi = null;
    renderWorkbench();
  });

  function renderAll() {
    syncEditorFromModel();
    renderWorkbench();
    if ($('#panel-policy').classList.contains('active')) renderPolicy();
  }

  /* ---------------- 启动 ---------------- */
  loadModel(JSON.parse(JSON.stringify(EMBEDDED_SAMPLE)), null);
})();
