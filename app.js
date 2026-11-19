'use strict';
/* 行为树调试器 UI：树图、角色预览、黑板编辑、单步/50ms 播放、快照、轨迹 */
(function () {
  const E = window.BTEngine;
  const $ = (id) => document.getElementById(id);

  /* ---------------- 内置示例 ---------------- */
  const PRESETS = {
    preemption: {
      root: 'r',
      nodes: [
        { id: 'r', type: 'reactiveSelector', children: ['urgentSeq', 'normal'] },
        { id: 'urgentSeq', type: 'memorySequence', children: ['test', 'urgentMove'] },
        { id: 'test', type: 'condition', key: 'urgent', equals: true },
        { id: 'urgentMove', type: 'move', target: [-1, 0], speed: 1 },
        { id: 'normal', type: 'move', target: [1, 0], speed: 1 },
      ],
      blackboard: { urgent: false },
      position: [0, 0],
      inputs: [{ tick: 2, seq: 1, key: 'urgent', value: true }],
    },
    memory: {
      root: 's',
      nodes: [
        { id: 's', type: 'memorySequence', children: ['set', 'wait', 'done'] },
        { id: 'set', type: 'set', key: 'counter', value: 1 },
        { id: 'wait', type: 'wait', ticks: 3 },
        { id: 'done', type: 'set', key: 'done', value: true },
      ],
      blackboard: {},
      position: [0, 0],
      inputs: [{ tick: 1, seq: 1, key: 'counter', value: 9 }],
    },
    stress: (() => {
      const children = Array.from({ length: 127 }, (_, i) => `n${i}`);
      return {
        root: 's',
        nodes: [
          { id: 's', type: 'memorySequence', children },
          ...children.map((id) => ({ id, type: 'wait', ticks: 0 })),
        ],
        blackboard: {},
        position: [0, 0],
      };
    })(),
    invalidCycle: {
      root: 'a',
      nodes: [
        { id: 'a', type: 'memorySequence', children: ['b'] },
        { id: 'b', type: 'reactiveSelector', children: ['a'] },
      ],
      blackboard: {},
      position: [0, 0],
    },
  };

  const TYPE_LABEL = {
    reactiveSelector: '响应式选择器', memorySequence: '记忆序列',
    condition: '条件', set: '黑板赋值', wait: '等待', move: '移动',
  };

  /* ---------------- 全局状态 ---------------- */
  let tree = null;
  let nodeMap = null;
  let run = null;
  let selectedId = null;
  let snapshots = []; // {name, snap}
  let playing = false;
  let timer = null;
  let trail = []; // 角色位置轨迹

  /* ---------------- 载入 / 校验 ---------------- */
  function loadTree(spec, sourceLabel) {
    const v = E.validateTree(spec);
    if (!v.ok) {
      $('treeErrors').textContent =
        `「${sourceLabel}」校验失败（${v.errors.length} 项）：\n` + v.errors.join('\n');
      return false;
    }
    $('treeErrors').textContent = '';
    tree = E.deepCopy(spec);
    nodeMap = E.buildNodeMap(tree);
    run = E.createRun(tree);
    trail = [[...run.position]];
    selectedId = tree.root;
    if (playing) togglePlay();
    $('treeJson').value = JSON.stringify(tree, null, 2);
    $('inputsJson').value = JSON.stringify(tree.inputs || [], null, 2);
    renderAll();
    return true;
  }

  function resetRun() {
    run = E.createRun(tree);
    trail = [[...run.position]];
    renderAll();
  }

  /* ---------------- 推进 ---------------- */
  function doStep() {
    E.step(run, tree, nodeMap);
    trail.push([...run.position]);
    if (trail.length > 400) trail.shift();
    renderAll();
  }

  function togglePlay() {
    playing = !playing;
    $('btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing) timer = setInterval(doStep, 50); // 固定 50ms 节拍
    else clearInterval(timer);
  }

  /* ---------------- 渲染：工具栏 ---------------- */
  function renderToolbar() {
    $('tickNum').textContent = run.tick;
    $('verHash').textContent = E.shortHash(run.version);
  }

  /* ---------------- 渲染：树图 ---------------- */
  const NW = 150; // 节点宽
  const NH = 46;  // 节点高
  const GX = 22;  // 水平间距
  const GY = 64;  // 垂直间距

  function layoutTree() {
    const pos = {};
    let slot = 0;
    (function place(id, depth) {
      const n = nodeMap.get(id);
      const kids = n.children || [];
      if (!kids.length) {
        pos[id] = { x: slot++, y: depth };
      } else {
        kids.forEach((k) => place(k, depth + 1));
        pos[id] = { x: (pos[kids[0]].x + pos[kids[kids.length - 1]].x) / 2, y: depth };
      }
    })(tree.root, 0);
    return pos;
  }

  function paramSummary(n) {
    switch (n.type) {
      case 'condition': return `${n.key} === ${JSON.stringify(n.equals)}`;
      case 'set': return `${n.key} = ${JSON.stringify(n.value)}`;
      case 'wait': {
        const r = run.runtime[n.id];
        const cur = r && r.active ? ` (${r.count}/` : ` (0/`;
        return `ticks=${n.ticks}${cur}${n.ticks})`;
      }
      case 'move': return `→(${n.target[0]}, ${n.target[1]}) v=${n.speed}`;
      case 'memorySequence': {
        const r = run.runtime[n.id];
        return r ? `游标 ${r.cursor}/${n.children.length}` : `0/${n.children.length}`;
      }
      case 'reactiveSelector': {
        const r = run.runtime[n.id];
        return r && r.lastChild ? `运行分支: ${r.lastChild}` : `${n.children.length} 分支`;
      }
      default: return '';
    }
  }

  function renderTree() {
    const pos = layoutTree();
    const ids = Object.keys(pos);
    const maxX = Math.max(...ids.map((i) => pos[i].x));
    const maxY = Math.max(...ids.map((i) => pos[i].y));
    const W = (maxX + 1) * (NW + GX) + GX;
    const H = (maxY + 1) * (NH + GY) + GY;
    const cx = (id) => GX + pos[id].x * (NW + GX) + NW / 2;
    const cy = (id) => GY + pos[id].y * (NH + GY);

    let edges = '';
    for (const id of ids) {
      const n = nodeMap.get(id);
      for (const c of n.children || []) {
        edges += `<path d="M ${cx(id)} ${cy(id) + NH / 2} C ${cx(id)} ${cy(id) + NH / 2 + GY / 2},` +
                 ` ${cx(c)} ${cy(c) - GY / 2}, ${cx(c)} ${cy(c) - NH / 2}" ` +
                 `fill="none" stroke="#b9c2d0" stroke-width="1.5"/>`;
      }
    }

    let nodes = '';
    for (const id of ids) {
      const n = nodeMap.get(id);
      const st = run.status[id] || 'idle';
      const x = cx(id) - NW / 2;
      const y = cy(id) - NH / 2;
      const sel = id === selectedId ? 'stroke-width="3" stroke-dasharray="5 3"' : 'stroke-width="2"';
      nodes += `<g data-node="${id}" style="cursor:pointer">` +
        `<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="8" fill="#fff" ` +
        `stroke="var(--c-${st})" ${sel}/>` +
        `<rect x="${x}" y="${y}" width="5" height="${NH}" rx="2" fill="var(--c-${st})"/>` +
        `<text x="${x + 12}" y="${y + 17}" font-size="12" font-weight="600" fill="#1f2733">${esc(id)}</text>` +
        `<text x="${x + 12}" y="${y + 31}" font-size="10" fill="#667">${TYPE_LABEL[n.type] || n.type}</text>` +
        `<text x="${x + 12}" y="${y + 42}" font-size="10" fill="#889">${esc(paramSummary(n))}</text>` +
        `</g>`;
    }
    $('treeWrap').innerHTML =
      `<svg width="${W}" height="${H}" style="display:block">${edges}${nodes}</svg>`;
    $('treeWrap').querySelectorAll('g[data-node]').forEach((g) => {
      g.addEventListener('click', () => { selectedId = g.dataset.node; renderAll(); });
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- 渲染：角色预览 ---------------- */
  function renderStage() {
    const cv = $('stage');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 视野：包含原点、角色、轨迹与所有 move 目标
    const pts = [[0, 0], run.position, ...trail];
    for (const n of tree.nodes) if (n.type === 'move') pts.push(n.target);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs) - 1; const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys) - 1; const maxY = Math.max(...ys) + 1;
    const scale = Math.min(w / (maxX - minX), h / (maxY - minY));
    const ox = (w - (maxX - minX) * scale) / 2;
    const oy = (h - (maxY - minY) * scale) / 2;
    const px = (x) => ox + (x - minX) * scale;
    const py = (y) => oy + (y - minY) * scale;

    // 网格（1m）
    ctx.strokeStyle = '#e6eaf1';
    ctx.lineWidth = 1;
    for (let gx = Math.ceil(minX); gx <= maxX; gx++) {
      ctx.beginPath(); ctx.moveTo(px(gx), 0); ctx.lineTo(px(gx), h); ctx.stroke();
    }
    for (let gy = Math.ceil(minY); gy <= maxY; gy++) {
      ctx.beginPath(); ctx.moveTo(0, py(gy)); ctx.lineTo(w, py(gy)); ctx.stroke();
    }
    // 坐标轴
    ctx.strokeStyle = '#c3ccd9';
    ctx.beginPath(); ctx.moveTo(px(0), 0); ctx.lineTo(px(0), h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, py(0)); ctx.lineTo(w, py(0)); ctx.stroke();

    // move 目标点
    ctx.font = '10px sans-serif';
    for (const n of tree.nodes) {
      if (n.type !== 'move') continue;
      const active = run.status[n.id] === 'running';
      ctx.strokeStyle = active ? '#2b8cff' : '#9aa3b2';
      ctx.lineWidth = active ? 2 : 1;
      const tx = px(n.target[0]); const ty = py(n.target[1]);
      ctx.beginPath();
      ctx.moveTo(tx - 5, ty - 5); ctx.lineTo(tx + 5, ty + 5);
      ctx.moveTo(tx + 5, ty - 5); ctx.lineTo(tx - 5, ty + 5);
      ctx.stroke();
      ctx.fillStyle = '#889';
      ctx.fillText(`${n.id} (${n.target[0]}, ${n.target[1]})`, tx + 7, ty - 4);
    }

    // 轨迹
    if (trail.length > 1) {
      ctx.strokeStyle = 'rgba(43,140,255,.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trail.forEach((p, i) => { i ? ctx.lineTo(px(p[0]), py(p[1])) : ctx.moveTo(px(p[0]), py(p[1])); });
      ctx.stroke();
    }

    // 角色
    const [ax, ay] = run.position;
    ctx.fillStyle = '#2b8cff';
    ctx.beginPath();
    ctx.arc(px(ax), py(ay), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NPC', px(ax), py(ay) + 3);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#334';
    ctx.fillText(`(${ax.toFixed(3)}, ${ay.toFixed(3)})`, px(ax) + 12, py(ay) + 14);
  }

  /* ---------------- 渲染：黑板 ---------------- */
  function renderBlackboard() {
    const keys = Object.keys(run.blackboard);
    let html = '<table class="bb">';
    for (const k of keys) {
      html += `<tr><td style="width:38%"><code>${esc(k)}</code></td>` +
        `<td><input data-bb="${esc(k)}" value="${esc(JSON.stringify(run.blackboard[k]))}"></td>` +
        `<td style="width:26px"><button data-bbdel="${esc(k)}" title="删除">×</button></td></tr>`;
    }
    html += `<tr><td><input id="bbNewKey" placeholder="新 key"></td>` +
      `<td><input id="bbNewVal" placeholder='JSON 值，如 true 或 3'></td>` +
      `<td><button id="bbAdd" title="添加">＋</button></td></tr></table>`;
    $('bbPanel').innerHTML = html;
    $('bbPanel').querySelectorAll('input[data-bb]').forEach((inp) => {
      inp.addEventListener('change', () => {
        try {
          run.blackboard[inp.dataset.bb] = JSON.parse(inp.value);
          inp.style.borderColor = '';
        } catch (e) { inp.style.borderColor = 'var(--c-failure)'; }
        renderTrace(); // 黑板变化会影响后续求值，轨迹面板无需变，但树图可能引用
      });
    });
    $('bbPanel').querySelectorAll('button[data-bbdel]').forEach((b) => {
      b.addEventListener('click', () => { delete run.blackboard[b.dataset.bbdel]; renderBlackboard(); });
    });
    $('bbAdd').addEventListener('click', () => {
      const k = $('bbNewKey').value.trim();
      if (!k) return;
      try {
        run.blackboard[k] = JSON.parse($('bbNewVal').value);
        renderBlackboard();
      } catch (e) { $('bbNewVal').style.borderColor = 'var(--c-failure)'; }
    });
  }

  /* ---------------- 渲染：快照 ---------------- */
  function renderSnapshots() {
    if (!snapshots.length) {
      $('snapPanel').innerHTML = '<span class="hint">暂无快照。运行中点击「保存快照」。</span>';
      return;
    }
    $('snapPanel').innerHTML = snapshots.map((s, i) => {
      const stale = s.snap.version !== run.version;
      return `<div class="snap-row"><span class="name">${esc(s.name)}` +
        ` <span class="hint">v:${E.shortHash(s.snap.version)}</span>` +
        (stale ? ' <span class="stale">树已编辑，不可恢复</span>' : '') +
        `</span><button data-restore="${i}" ${stale ? 'disabled' : ''}>恢复</button>` +
        `<button data-snapdel="${i}">删除</button></div>`;
    }).join('');
    $('snapPanel').querySelectorAll('button[data-restore]').forEach((b) => {
      b.addEventListener('click', () => {
        try {
          E.restore(run, snapshots[+b.dataset.restore].snap);
          trail = [[...run.position]];
          renderAll();
        } catch (e) { alert(e.message); }
      });
    });
    $('snapPanel').querySelectorAll('button[data-snapdel]').forEach((b) => {
      b.addEventListener('click', () => { snapshots.splice(+b.dataset.snapdel, 1); renderSnapshots(); });
    });
  }

  /* ---------------- 渲染：轨迹 ---------------- */
  function renderTrace() {
    const rows = run.trace.slice(-600);
    let html = '<table class="trace-table"><tr><th>tick</th><th>节点</th><th>变化</th><th>原因</th></tr>';
    for (const e of rows) {
      if (e.event === 'input') {
        html += `<tr><td>${e.tick}</td><td colspan="3">⌨ 输入 ${esc(e.key)} = ${esc(JSON.stringify(e.value))}</td></tr>`;
      } else if (e.event === 'reset') {
        html += `<tr><td>${e.tick}</td><td colspan="3">↺ 根结束（${e.result}），整树复位</td></tr>`;
      } else if (e.event === 'restore') {
        html += `<tr><td>${e.tick}</td><td colspan="3">⤺ 从快照恢复</td></tr>`;
      } else {
        html += `<tr><td>${e.tick}</td><td><code>${esc(e.node)}</code></td>` +
          `<td><span class="st st-${e.from}">${e.from}</span> → <span class="st st-${e.to}">${e.to}</span></td>` +
          `<td>${e.reason ? esc(e.reason) : ''}</td></tr>`;
      }
    }
    $('tracePanel').innerHTML = html + '</table>';
    $('tracePanel').scrollTop = $('tracePanel').scrollHeight;
  }

  /* ---------------- 渲染：节点编辑器 ---------------- */
  function renderNodeEditor() {
    const n = nodeMap.get(selectedId);
    if (!n) { $('nodeEditor').innerHTML = '<span class="hint">在树图中点击节点进行编辑</span>'; return; }
    let html = `<div class="field"><label>id</label><input id="neId" value="${esc(n.id)}"></div>` +
      `<div class="field"><label>类型</label><select id="neType">` +
      Object.keys(TYPE_LABEL).map((t) =>
        `<option value="${t}" ${t === n.type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('') +
      `</select></div><div id="neParams"></div>`;

    if (n.children) {
      html += `<h2 style="font-size:12px;color:#667;margin:8px 0 2px">子节点（顺序敏感）</h2><div id="neChildren"></div>` +
        `<div class="field"><select id="neNewType">` +
        ['condition', 'set', 'wait', 'move', 'reactiveSelector', 'memorySequence']
          .map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('') +
        `</select><button id="neAddChild">＋ 添加子节点</button></div>`;
    }
    html += `<div style="margin-top:8px;display:flex;gap:6px">` +
      `<button id="neApply" class="primary">应用修改</button>` +
      (n.id !== tree.root ? `<button id="neDelete">删除子树</button>` : '') + `</div>` +
      `<div class="errors" id="neErrors"></div>`;
    $('nodeEditor').innerHTML = html;
    renderParams(n);
    if (n.children) renderChildren(n);

    $('neType').addEventListener('change', () => {
      const t = $('neType').value;
      // 切换类型时给出该类型的默认参数
      const defaults = {
        condition: { key: 'flag', equals: true }, set: { key: 'flag', value: true },
        wait: { ticks: 1 }, move: { target: [0, 0], speed: 1 },
        reactiveSelector: { children: n.children && n.children.length ? n.children : [] },
        memorySequence: { children: n.children && n.children.length ? n.children : [] },
      };
      for (const k of ['key', 'equals', 'value', 'ticks', 'target', 'speed', 'children']) delete n[k];
      n.type = t;
      Object.assign(n, E.deepCopy(defaults[t]));
      if ((t === 'reactiveSelector' || t === 'memorySequence') && !n.children.length) {
        delete n.children; // 空 children 不合法，提示用户添加
        n.children = [];
      }
      commitTreeEdit();
    });
    $('neApply').addEventListener('click', applyNodeEdit);
    const del = $('neDelete');
    if (del) del.addEventListener('click', () => {
      if (!confirm(`删除节点 ${n.id} 及其整棵子树？`)) return;
      deleteSubtree(n.id);
      selectedId = tree.root;
      commitTreeEdit();
    });
  }

  function renderParams(n) {
    const box = $('neParams');
    let html = '';
    if (n.type === 'condition') {
      html = `<div class="field"><label>key</label><input id="npKey" value="${esc(n.key)}"></div>` +
        `<div class="field"><label>equals</label><input id="npEquals" value="${esc(JSON.stringify(n.equals))}"></div>`;
    } else if (n.type === 'set') {
      html = `<div class="field"><label>key</label><input id="npKey" value="${esc(n.key)}"></div>` +
        `<div class="field"><label>value</label><input id="npValue" value="${esc(JSON.stringify(n.value))}"></div>`;
    } else if (n.type === 'wait') {
      html = `<div class="field"><label>ticks</label><input id="npTicks" type="number" min="0" step="1" value="${n.ticks}"></div>`;
    } else if (n.type === 'move') {
      html = `<div class="field"><label>target x</label><input id="npTx" type="number" step="0.5" value="${n.target[0]}"></div>` +
        `<div class="field"><label>target y</label><input id="npTy" type="number" step="0.5" value="${n.target[1]}"></div>` +
        `<div class="field"><label>speed</label><input id="npSpeed" type="number" min="0.01" step="0.1" value="${n.speed}"></div>`;
    }
    box.innerHTML = html;
  }

  function renderChildren(n) {
    const box = $('neChildren');
    box.innerHTML = n.children.map((c, i) =>
      `<div class="child-row"><span class="cid">${i}: ${esc(c)}</span>` +
      `<button data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>` +
      `<button data-down="${i}" ${i === n.children.length - 1 ? 'disabled' : ''}>↓</button>` +
      `<button data-rm="${i}">×</button></div>`).join('') ||
      '<span class="hint">暂无子节点（校验要求至少 1 个）</span>';
    box.querySelectorAll('button[data-up]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.up;
      [n.children[i - 1], n.children[i]] = [n.children[i], n.children[i - 1]];
      renderNodeEditor();
    }));
    box.querySelectorAll('button[data-down]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.down;
      [n.children[i], n.children[i + 1]] = [n.children[i + 1], n.children[i]];
      renderNodeEditor();
    }));
    box.querySelectorAll('button[data-rm]').forEach((b) => b.addEventListener('click', () => {
      n.children.splice(+b.dataset.rm, 1);
      renderNodeEditor();
    }));
    $('neAddChild').addEventListener('click', () => {
      const t = $('neNewType').value;
      const id = uniqueId(t);
      const node = { id, type: t };
      if (t === 'condition') { node.key = 'flag'; node.equals = true; }
      if (t === 'set') { node.key = 'flag'; node.value = true; }
      if (t === 'wait') node.ticks = 1;
      if (t === 'move') { node.target = [0, 0]; node.speed = 1; }
      if (t === 'reactiveSelector' || t === 'memorySequence') node.children = [];
      tree.nodes.push(node);
      n.children.push(id);
      commitTreeEdit();
      selectedId = id;
      renderAll();
    });
  }

  function uniqueId(prefix) {
    let i = 1;
    while (nodeMap.has(`${prefix}_${i}`)) i++;
    return `${prefix}_${i}`;
  }

  function deleteSubtree(id) {
    const n = nodeMap.get(id);
    for (const c of n.children || []) deleteSubtree(c);
    tree.nodes = tree.nodes.filter((x) => x.id !== id);
    for (const p of tree.nodes) {
      if (p.children) p.children = p.children.filter((c) => c !== id);
    }
  }

  function applyNodeEdit() {
    const n = nodeMap.get(selectedId);
    const err = $('neErrors');
    err.textContent = '';
    const newId = $('neId').value.trim();
    try {
      if (!newId) throw new Error('id 不能为空');
      if (newId !== n.id && nodeMap.has(newId)) throw new Error(`id ${newId} 已存在`);
      if (n.type === 'condition') {
        n.key = $('npKey').value;
        n.equals = JSON.parse($('npEquals').value);
      } else if (n.type === 'set') {
        n.key = $('npKey').value;
        n.value = JSON.parse($('npValue').value);
      } else if (n.type === 'wait') {
        n.ticks = Number($('npTicks').value);
      } else if (n.type === 'move') {
        n.target = [Number($('npTx').value), Number($('npTy').value)];
        n.speed = Number($('npSpeed').value);
      }
      if (newId !== n.id) renameNode(n.id, newId);
    } catch (e) { err.textContent = String(e.message || e); return; }
    commitTreeEdit();
  }

  function renameNode(oldId, newId) {
    const n = nodeMap.get(oldId);
    n.id = newId;
    if (tree.root === oldId) tree.root = newId;
    for (const p of tree.nodes) {
      if (p.children) p.children = p.children.map((c) => (c === oldId ? newId : c));
    }
    selectedId = newId;
  }

  // 树被编辑：重新校验、重建运行状态；旧快照因版本变化自动失效
  function commitTreeEdit() {
    const v = E.validateTree(tree);
    if (!v.ok) {
      $('treeErrors').textContent = `当前编辑使树非法：\n${v.errors.join('\n')}`;
    }
    nodeMap = E.buildNodeMap(tree);
    run = E.createRun(tree);
    trail = [[...run.position]];
    $('treeJson').value = JSON.stringify(tree, null, 2);
    renderAll();
  }

  /* ---------------- 渲染汇总 ---------------- */
  function renderAll() {
    renderToolbar();
    renderTree();
    renderStage();
    renderBlackboard();
    renderSnapshots();
    renderTrace();
    renderNodeEditor();
  }

  /* ---------------- 事件绑定 ---------------- */
  $('btnStep').addEventListener('click', doStep);
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnReset').addEventListener('click', resetRun);
  $('btnSnap').addEventListener('click', () => {
    snapshots.push({ name: `快照 @tick ${run.tick}`, snap: E.snapshot(run) });
    renderSnapshots();
  });
  $('preset').addEventListener('change', () => {
    const p = $('preset').value;
    if (p && PRESETS[p]) loadTree(E.deepCopy(PRESETS[p]), p);
    $('preset').value = '';
  });
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { loadTree(JSON.parse(rd.result), f.name); }
      catch (e) { $('treeErrors').textContent = `JSON 解析失败: ${e.message}`; }
    };
    rd.readAsText(f);
    ev.target.value = '';
  });
  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'behavior-tree.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('btnApplyTree').addEventListener('click', () => {
    try { loadTree(JSON.parse($('treeJson').value), '文本框'); }
    catch (e) { $('treeErrors').textContent = `JSON 解析失败: ${e.message}`; }
  });
  $('btnApplyInputs').addEventListener('click', () => {
    try {
      const arr = JSON.parse($('inputsJson').value);
      if (!Array.isArray(arr)) throw new Error('必须是数组');
      arr.forEach((inp, i) => {
        if (!Number.isInteger(inp.tick) || inp.tick < 0) throw new Error(`[${i}] tick 必须是非负整数`);
        if (!Number.isInteger(inp.seq)) throw new Error(`[${i}] seq 必须是整数`);
        if (typeof inp.key !== 'string') throw new Error(`[${i}] key 必须是字符串`);
      });
      run.inputs = E.deepCopy(arr);
      $('inputsErrors').textContent = '';
    } catch (e) { $('inputsErrors').textContent = String(e.message || e); }
  });
  window.addEventListener('resize', renderStage);

  /* ---------------- 启动 ---------------- */
  loadTree(E.deepCopy(PRESETS.preemption), 'preemption');
})();
