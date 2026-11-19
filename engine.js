/*
 * 响应式行为树引擎（不依赖任何现成行为树库）
 * 语义依据 samples/说明.txt：
 *  - 每 tick 先按 seq 应用该 tick 的全部黑板输入，再从根求值，dt 固定 0.05s
 *  - reactiveSelector：每 tick 从首个孩子起取第一个非失败孩子；运行孩子与上 tick 不同
 *    时递归中止旧运行子树、清除动作进度并记录 abort；全部失败即失败
 *  - memorySequence：记住运行中的孩子，成功立即访问下一个，失败立即失败；
 *    结束时其整棵子树复位
 *  - condition：严格比较 JSON 标量，缺 key 视为失败；set：立即赋值并成功
 *  - wait：激活时计数 0 并 running，随后每次访问 +1，到 ticks 成功；ticks=0 激活即成功
 *  - move：激活 tick 也前进 speed*dt，沿直线朝 target，剩余距离不足时截到目标并成功；
 *    中止不回退角色位置
 *  - 根成功或失败时整树复位，下一 tick 可再次激活
 */
(function (global) {
  'use strict';

  const DT = 0.05;
  const MAX_NODES = 128;

  function deepCopy(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function isScalar(v) {
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  }

  /* ---------------- 校验：环、共享子节点、无效参数、可达性等 ---------------- */

  function validateTree(spec) {
    const errors = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, errors: ['文件不是 JSON 对象'] };
    }
    const { root, nodes } = spec;
    if (typeof root !== 'string' || !root) errors.push('缺少 root 或 root 不是字符串');
    if (!Array.isArray(nodes)) {
      errors.push('nodes 必须是数组');
      return { ok: false, errors };
    }
    if (nodes.length === 0) errors.push('nodes 为空');
    if (nodes.length > MAX_NODES) errors.push(`节点数 ${nodes.length} 超过上限 ${MAX_NODES}`);

    const byId = new Map();
    for (const n of nodes) {
      if (!n || typeof n.id !== 'string' || !n.id) { errors.push('存在缺少 id 的节点'); continue; }
      if (byId.has(n.id)) errors.push(`节点 id 重复: ${n.id}`);
      byId.set(n.id, n);
    }
    if (root && !byId.has(root)) errors.push(`root 指向不存在的节点: ${root}`);

    for (const n of byId.values()) {
      switch (n.type) {
        case 'reactiveSelector':
        case 'memorySequence':
          if (!Array.isArray(n.children) || n.children.length === 0) {
            errors.push(`${n.id}: ${n.type} 需要非空 children`);
          } else {
            for (const c of n.children) {
              if (!byId.has(c)) errors.push(`${n.id}: 子节点不存在: ${c}`);
            }
          }
          break;
        case 'condition':
          if (typeof n.key !== 'string') errors.push(`${n.id}: condition 需要字符串 key`);
          if (!isScalar(n.equals)) errors.push(`${n.id}: condition 的 equals 必须是 JSON 标量`);
          break;
        case 'set':
          if (typeof n.key !== 'string') errors.push(`${n.id}: set 需要字符串 key`);
          if (!('value' in n)) errors.push(`${n.id}: set 需要 value`);
          break;
        case 'wait':
          if (!Number.isInteger(n.ticks) || n.ticks < 0) {
            errors.push(`${n.id}: wait 的 ticks 必须是非负整数`);
          }
          break;
        case 'move':
          if (!Array.isArray(n.target) || n.target.length !== 2 || !n.target.every(Number.isFinite)) {
            errors.push(`${n.id}: move 的 target 必须是二维坐标`);
          }
          if (!(typeof n.speed === 'number' && Number.isFinite(n.speed) && n.speed > 0)) {
            errors.push(`${n.id}: move 的 speed 必须是正数`);
          }
          break;
        default:
          errors.push(`${n.id}: 未知类型 ${JSON.stringify(n.type)}`);
      }
    }

    // 每个非根节点恰有一个父节点（禁止共享子节点）
    const parentCount = new Map();
    for (const n of byId.values()) {
      if (Array.isArray(n.children)) {
        for (const c of n.children) parentCount.set(c, (parentCount.get(c) || 0) + 1);
      }
    }
    for (const [id, cnt] of parentCount) {
      if (cnt > 1) errors.push(`节点 ${id} 被 ${cnt} 个父节点共享（共享子节点不允许）`);
    }
    if (byId.has(root) && parentCount.has(root)) {
      errors.push(`root ${root} 不能同时是其他节点的孩子`);
    }

    // 可达性 + 环检测
    if (byId.has(root)) {
      const visited = new Set();
      const inStack = new Set();
      let cycleNode = null;
      function dfs(id) {
        if (cycleNode) return;
        if (inStack.has(id)) { cycleNode = id; return; }
        if (visited.has(id)) return;
        visited.add(id);
        inStack.add(id);
        const n = byId.get(id);
        if (n && Array.isArray(n.children)) {
          for (const c of n.children) if (byId.has(c)) dfs(c);
        }
        inStack.delete(id);
      }
      dfs(root);
      if (cycleNode) {
        errors.push(`检测到环，涉及节点: ${cycleNode}`);
      } else {
        for (const id of byId.keys()) {
          if (!visited.has(id)) errors.push(`节点 ${id} 从根不可达`);
        }
      }
    }

    if (spec.blackboard !== undefined &&
        (typeof spec.blackboard !== 'object' || spec.blackboard === null || Array.isArray(spec.blackboard))) {
      errors.push('blackboard 必须是对象');
    }
    if (!Array.isArray(spec.position) || spec.position.length !== 2 ||
        !spec.position.every(Number.isFinite)) {
      errors.push('position 必须是二维坐标');
    }
    if (spec.inputs !== undefined) {
      if (!Array.isArray(spec.inputs)) {
        errors.push('inputs 必须是数组');
      } else {
        spec.inputs.forEach((inp, i) => {
          if (!inp || typeof inp !== 'object') { errors.push(`inputs[${i}] 不是对象`); return; }
          if (!Number.isInteger(inp.tick) || inp.tick < 0) errors.push(`inputs[${i}]: tick 必须是非负整数`);
          if (!Number.isInteger(inp.seq)) errors.push(`inputs[${i}]: seq 必须是整数`);
          if (typeof inp.key !== 'string') errors.push(`inputs[${i}]: key 必须是字符串`);
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /* ---------------- 树版本（快照绑定） ---------------- */

  function treeVersion(tree) {
    const nodes = tree.nodes.map((n) => ({ ...n }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify({ root: tree.root, nodes });
  }

  function shortHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /* ---------------- 运行状态 ---------------- */

  function createRun(tree) {
    return {
      version: treeVersion(tree),
      tick: 0,
      blackboard: deepCopy(tree.blackboard || {}),
      position: deepCopy(tree.position),
      runtime: {}, // id -> { cursor } | { active, count } | { lastChild }
      status: {},  // id -> idle|running|success|failure|aborted（最近一次的展示状态）
      trace: [],   // {tick, node, from, to, reason?} 或 {tick, event, ...}
      inputs: deepCopy(tree.inputs || []),
    };
  }

  function setStatus(run, id, to, reason) {
    const from = run.status[id] || 'idle';
    if (from !== to || reason) {
      const entry = { tick: run.tick, node: id, from, to };
      if (reason) entry.reason = reason;
      run.trace.push(entry);
    }
    run.status[id] = to;
  }

  // 递归中止：清除整棵子树的运行时进度（等待计数、序列游标、选择器记忆），
  // 对处于 running 或持有运行时状态的节点记录 abort。move 的位置进度保留在角色身上，不回退。
  function abortSubtree(id, run, nodeMap, reason) {
    if (run.status[id] === 'running' || run.runtime[id] !== undefined) {
      setStatus(run, id, 'aborted', reason);
    }
    delete run.runtime[id];
    const n = nodeMap.get(id);
    if (n && Array.isArray(n.children)) {
      for (const c of n.children) abortSubtree(c, run, nodeMap, reason);
    }
  }

  // 正常复位（memorySequence 结束 / 根结束）：静默清理运行时状态，不记 abort
  function resetSubtree(id, run, nodeMap) {
    delete run.runtime[id];
    const n = nodeMap.get(id);
    if (n && Array.isArray(n.children)) {
      for (const c of n.children) resetSubtree(c, run, nodeMap);
    }
  }

  function evalNode(id, run, nodeMap) {
    const n = nodeMap.get(id);
    const rt = run.runtime;
    switch (n.type) {
      case 'condition': {
        const ok = Object.prototype.hasOwnProperty.call(run.blackboard, n.key) &&
                   run.blackboard[n.key] === n.equals;
        setStatus(run, id, ok ? 'success' : 'failure');
        return ok ? 'success' : 'failure';
      }
      case 'set': {
        run.blackboard[n.key] = deepCopy(n.value);
        setStatus(run, id, 'success');
        return 'success';
      }
      case 'wait': {
        let r = rt[id];
        if (!r || !r.active) {
          if (n.ticks === 0) {
            rt[id] = { active: false, count: 0 };
            setStatus(run, id, 'success');
            return 'success';
          }
          rt[id] = { active: true, count: 0 };
          setStatus(run, id, 'running');
          return 'running';
        }
        r.count += 1;
        if (r.count >= n.ticks) {
          r.active = false;
          r.count = 0;
          setStatus(run, id, 'success');
          return 'success';
        }
        setStatus(run, id, 'running');
        return 'running';
      }
      case 'move': {
        const [tx, ty] = n.target;
        const [px, py] = run.position;
        const dx = tx - px;
        const dy = ty - py;
        const dist = Math.hypot(dx, dy);
        const stepLen = n.speed * DT;
        if (dist === 0 || dist <= stepLen) {
          run.position = [tx, ty];
          setStatus(run, id, 'success');
          return 'success';
        }
        run.position = [px + (dx / dist) * stepLen, py + (dy / dist) * stepLen];
        setStatus(run, id, 'running');
        return 'running';
      }
      case 'memorySequence': {
        let r = rt[id];
        if (!r) r = rt[id] = { cursor: 0 };
        while (r.cursor < n.children.length) {
          const res = evalNode(n.children[r.cursor], run, nodeMap);
          if (res === 'running') { setStatus(run, id, 'running'); return 'running'; }
          if (res === 'failure') {
            resetSubtree(id, run, nodeMap);
            setStatus(run, id, 'failure');
            return 'failure';
          }
          r.cursor += 1; // 成功立即访问下一个
        }
        resetSubtree(id, run, nodeMap); // 结束时整棵子树复位
        setStatus(run, id, 'success');
        return 'success';
      }
      case 'reactiveSelector': {
        let chosen = null;
        let res = null;
        for (const c of n.children) {
          const r2 = evalNode(c, run, nodeMap);
          if (r2 !== 'failure') { chosen = c; res = r2; break; }
        }
        let rr = rt[id];
        if (!rr) rr = rt[id] = { lastChild: null };
        if (chosen === null) {
          rr.lastChild = null;
          setStatus(run, id, 'failure');
          return 'failure';
        }
        if (rr.lastChild !== null && rr.lastChild !== chosen) {
          abortSubtree(rr.lastChild, run, nodeMap,
            `reactiveSelector ${id} 抢占：${rr.lastChild} → ${chosen}`);
        }
        rr.lastChild = res === 'running' ? chosen : null;
        setStatus(run, id, res);
        return res;
      }
      default:
        throw new Error(`未知节点类型: ${n.type}`);
    }
  }

  // 推进一个 tick：先应用该 tick 的全部输入（按 seq），再从根求值
  function step(run, tree, nodeMap) {
    const due = run.inputs
      .filter((i) => i.tick === run.tick)
      .sort((a, b) => a.seq - b.seq);
    for (const inp of due) {
      run.blackboard[inp.key] = deepCopy(inp.value);
      run.trace.push({ tick: run.tick, event: 'input', key: inp.key, value: deepCopy(inp.value) });
    }
    const res = evalNode(tree.root, run, nodeMap);
    if (res !== 'running') {
      run.runtime = {}; // 根结束 → 整树复位
      run.trace.push({ tick: run.tick, event: 'reset', result: res });
    }
    run.tick += 1;
    return res;
  }

  /* ---------------- 快照：保留 tick、树版本、黑板、位置、序列游标、等待计数与运行分支 ---------------- */

  function snapshot(run) {
    return {
      tick: run.tick,
      version: run.version,
      blackboard: deepCopy(run.blackboard),
      position: deepCopy(run.position),
      runtime: deepCopy(run.runtime), // 序列游标 / 等待计数 / 选择器运行分支
      status: deepCopy(run.status),
    };
  }

  function restore(run, snap) {
    if (!snap || snap.version !== run.version) {
      throw new Error('快照与当前树版本不一致（树已被编辑），不能套用');
    }
    run.tick = snap.tick;
    run.blackboard = deepCopy(snap.blackboard);
    run.position = deepCopy(snap.position);
    run.runtime = deepCopy(snap.runtime);
    run.status = deepCopy(snap.status || {});
    run.trace.push({ tick: run.tick, event: 'restore' });
  }

  function buildNodeMap(tree) {
    return new Map(tree.nodes.map((n) => [n.id, n]));
  }

  const Engine = {
    DT, MAX_NODES,
    deepCopy, validateTree, treeVersion, shortHash,
    createRun, step, snapshot, restore, buildNodeMap,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else global.BTEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
