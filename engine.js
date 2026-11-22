/*
 * 回放见证缩减器 —— 手写解释器与缩减引擎（无任何第三方依赖）
 * UMD：浏览器挂载 globalThis.RWS，Node 下 module.exports。
 *
 * 缩减策略（严格按 samples/replay-witness.json 内规则）：
 *  - 按执行序把当前存活事件均分为 k 个连续块（较长块靠前），k 从 2 起
 *  - 从前到后试删；试删一个块 = 删种子 + 沿依赖反向边递归级联删除
 *  - 接受条件：缩减后重放，首次差异的【原事件号、字段名、新版-旧版符号】三项全中
 *  - 首次成功即回到 k=2；一轮全失败则 k 翻倍（上限=剩余长度）；单条轮全失败结束
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RWS = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const toI32 = (x) => x | 0;

  // ---------- 校验 ----------
  // 错误一律带事件号（数组下标）与事件 id；依赖问题同时指出坏依赖 id。
  function validate(doc) {
    const errors = [];
    const push = (eventIndex, eventId, depId, message) =>
      errors.push({ eventIndex, eventId, depId: depId === undefined ? null : depId, message });

    if (!doc || typeof doc !== 'object') return { ok: false, errors: [{ eventIndex: -1, eventId: null, depId: null, message: '顶层必须是 JSON 对象' }] };
    if (!doc.initial || typeof doc.initial !== 'object' || Array.isArray(doc.initial))
      push(-1, null, undefined, 'initial 必须是字段→整数的对象');
    if (!Array.isArray(doc.observe) || doc.observe.length === 0)
      push(-1, null, undefined, 'observe 必须是非空字段名数组');
    for (const v of ['old', 'next']) {
      if (!doc[v] || typeof doc[v] !== 'object') push(-1, null, undefined, v + ' 程序表缺失或格式错误');
    }
    if (!Array.isArray(doc.events)) {
      push(-1, null, undefined, 'events 必须是数组');
      return { ok: false, errors };
    }

    const idAt = new Map();
    doc.events.forEach((ev, i) => {
      const label = ev && ev.id != null ? String(ev.id) : null;
      if (!ev || typeof ev !== 'object') return push(i, null, undefined, '事件不是对象');
      if (typeof ev.id !== 'string' || ev.id.length === 0)
        return push(i, label, undefined, 'id 必须是非空 ASCII 串');
      if (/[^\x00-\x7F]/.test(ev.id))
        return push(i, ev.id, undefined, 'id 必须是 ASCII 串');
      if (idAt.has(ev.id))
        return push(i, ev.id, undefined, 'id 与事件 #' + idAt.get(ev.id) + ' 重复');
      idAt.set(ev.id, i);
      if (!Number.isInteger(ev.frame) || ev.frame < 0)
        return push(i, ev.id, undefined, 'frame 必须是非负整数');
      if (!Array.isArray(ev.deps))
        return push(i, ev.id, undefined, 'deps 必须是 id 数组');
    });

    // 依赖：必须存在且严格指向执行序更早的事件
    doc.events.forEach((ev, i) => {
      if (!ev || !Array.isArray(ev.deps)) return;
      for (const d of ev.deps) {
        if (!idAt.has(d))
          return push(i, ev.id, d, '依赖 "' + d + '" 不存在（坏依赖）');
        const j = idAt.get(d);
        if (j >= i)
          return push(i, ev.id, d, '依赖 "' + d + '" 指向事件 #' + j + '，不是严格更早的事件（坏依赖）');
      }
    });

    // 程序指令形状
    for (const v of ['old', 'next']) {
      const table = doc[v];
      if (!table || typeof table !== 'object') continue;
      for (const kind of Object.keys(table)) {
        const list = table[kind];
        if (!Array.isArray(list)) { push(-1, null, undefined, v + '.' + kind + ' 必须是指令列表'); continue; }
        list.forEach((ins, ii) => {
          if (!Array.isArray(ins) || ins.length !== 4)
            return push(-1, null, undefined, v + '.' + kind + '[' + ii + '] 必须是 [条件, 操作, 字段, 整数]');
          const [cond, op, field, arg] = ins;
          if (cond !== null && (!Array.isArray(cond) || cond.length !== 3 ||
              typeof cond[0] !== 'string' || (cond[1] !== 'eq' && cond[1] !== 'lt') || !Number.isInteger(cond[2])))
            return push(-1, null, undefined, v + '.' + kind + '[' + ii + '] 条件形状应为 [字段, "eq"|"lt", 整数] 或 null');
          if ((op !== 'set' && op !== 'add') || typeof field !== 'string' || !Number.isInteger(arg))
            return push(-1, null, undefined, v + '.' + kind + '[' + ii + '] 操作形状应为 ("set"|"add", 字段, 整数)');
        });
      }
    }
    if (Array.isArray(doc.observe)) {
      for (const f of doc.observe) if (typeof f !== 'string') push(-1, null, undefined, 'observe 必须全部是字段名字符串');
    }
    return { ok: errors.length === 0, errors };
  }

  // ---------- 编译模型 ----------
  function buildModel(doc) {
    const fieldIndex = new Map();
    const fi = (name) => {
      let i = fieldIndex.get(name);
      if (i === undefined) { i = fieldIndex.size; fieldIndex.set(name, i); }
      return i;
    };

    const initial = doc.initial && typeof doc.initial === 'object' ? doc.initial : {};
    Object.keys(initial).forEach(fi);

    // 指令编译为定长数组：[条件字段idx(-1=无条件), 条件码(0无/1eq/2lt), 条件参数, 目标字段idx, 操作码(1set/2add), 参数]
    const compileTable = (table) => {
      const kinds = new Map();
      for (const kind of Object.keys(table)) {
        kinds.set(kind, table[kind].map((ins) => {
          const c = ins[0];
          return [
            c ? fi(c[0]) : -1,
            c ? (c[1] === 'eq' ? 1 : 2) : 0,
            c ? toI32(c[2]) : 0,
            fi(ins[2]),
            ins[1] === 'set' ? 1 : 2,
            toI32(ins[3]),
          ];
        }));
      }
      return kinds;
    };
    const oldKinds = compileTable(doc.old || {});
    const nextKinds = compileTable(doc.next || {});

    const allKinds = new Set([...oldKinds.keys(), ...nextKinds.keys()]);
    const kindId = new Map();
    const oldLists = [];
    const nextLists = [];
    let kc = 0;
    for (const kind of allKinds) {
      kindId.set(kind, kc);
      oldLists.push(oldKinds.get(kind) || null);
      nextLists.push(nextKinds.get(kind) || null);
      kc++;
    }

    const n = doc.events.length;
    const events = doc.events;
    const idOf = new Array(n);
    const kindOf = new Int32Array(n);
    const rev = new Array(n); // 反向边：rev[x] = 直接依赖 x 的事件下标
    for (let i = 0; i < n; i++) rev[i] = [];
    const idToIndex = new Map();
    events.forEach((ev, i) => {
      idToIndex.set(ev.id, i);
      idOf[i] = ev.id;
    });
    events.forEach((ev, i) => {
      kindOf[i] = kindId.has(ev.kind) ? kindId.get(ev.kind) : -1;
      for (const d of ev.deps) rev[idToIndex.get(d)].push(i);
    });

    const F = fieldIndex.size;
    const fields = new Array(F);
    for (const [name, idx] of fieldIndex) fields[idx] = name;
    const initialVec = new Int32Array(F);
    for (const [name, idx] of fieldIndex) initialVec[idx] = toI32(initial[name] || 0);

    const observeIdx = doc.observe.map(fi);

    // 单条相邻链结构检测（deps 严格指向前一个事件）——命中后试删可 O(1) 判定
    let isChain = n > 0 && events[0].deps.length === 0;
    for (let i = 1; i < n && isChain; i++) {
      const d = events[i].deps;
      if (d.length !== 1 || idToIndex.get(d[0]) !== i - 1) isChain = false;
    }

    return {
      doc, n, F, fields, events, idOf, kindOf, rev, idToIndex,
      oldLists, nextLists, observeIdx, initialVec, isChain,
    };
  }

  // ---------- 解释器 ----------
  function runList(list, state) {
    for (let i = 0; i < list.length; i++) {
      const ins = list[i];
      if (ins[0] >= 0) {
        const cur = state[ins[0]];
        if (ins[1] === 1) { if (cur !== ins[2]) continue; }
        else if (!(cur < ins[2])) continue;
      }
      if (ins[4] === 1) state[ins[3]] = ins[5];
      else state[ins[3]] = (state[ins[3]] + ins[5]) | 0; // add 按有符号 32 位回绕
    }
  }

  // 快照表：row 0 = initial，row p+1 = 执行完 alive[p] 后的两版状态
  function buildSnapshots(model, alive) {
    const { F, n } = model;
    const stride = 2 * F;
    const m = alive.length;
    const snap = new Int32Array((m + 1) * stride);
    const so = model.initialVec.slice();
    const sn = model.initialVec.slice();
    snap.set(so, 0);
    snap.set(sn, F);
    for (let p = 0; p < m; p++) {
      const oi = alive[p];
      const ki = model.kindOf[oi];
      if (ki >= 0) {
        const lo = model.oldLists[ki];
        const ln = model.nextLists[ki];
        if (lo) runList(lo, so);
        if (ln) runList(ln, sn);
      }
      const base = (p + 1) * stride;
      snap.set(so, base);
      snap.set(sn, base + F);
    }    return { snap, stride, m, F };
  }

  function signOf(d) { return d > 0 ? '+' : '-'; }

  // 在快照行里找首次差异；返回见证（原事件号=原始下标）
  function firstDiffFromSnapshots(model, alive, table) {
    const { snap, stride, F } = table;
    const obs = model.observeIdx;
    for (let row = 1; row <= alive.length; row++) {
      const base = row * stride;
      for (let j = 0; j < obs.length; j++) {
        const f = obs[j];
        const ov = snap[base + f];
        const nv = snap[base + F + f];
        if (ov !== nv) {
          const eventIndex = alive[row - 1];
          return {
            eventIndex,
            eventId: model.idOf[eventIndex],
            field: model.fields[f],
            sign: signOf(nv - ov), // 数学差值，不做 32 位回绕
            oldValue: ov,
            nextValue: nv,
          };
        }
      }
    }
    return null;
  }

  // 基线：全量重放 + 快照 + 锁定见证
  function baseline(model) {
    const alive = new Int32Array(model.n);
    for (let i = 0; i < model.n; i++) alive[i] = i;
    const table = buildSnapshots(model, alive);
    const witness = firstDiffFromSnapshots(model, alive, table);
    return { alive, table, witness };
  }

  // 对任意存活下标序列独立重放（导出校验/重演用）
  function replayReduced(model, positions) {
    const so = model.initialVec.slice();
    const sn = model.initialVec.slice();
    let first = null;
    const obs = model.observeIdx;
    for (let p = 0; p < positions.length; p++) {
      const oi = positions[p];
      const ki = model.kindOf[oi];
      if (ki >= 0) {
        const lo = model.oldLists[ki];
        const ln = model.nextLists[ki];
        if (lo) runList(lo, so);
        if (ln) runList(ln, sn);
      }
      if (!first) {
        for (let j = 0; j < obs.length; j++) {
          const f = obs[j];
          if (so[f] !== sn[f]) {
            first = {
              eventIndex: oi,
              eventId: model.idOf[oi],
              field: model.fields[f],
              sign: signOf(sn[f] - so[f]),
              oldValue: so[f],
              nextValue: sn[f],
            };
            break;
          }
        }
      }
    }
    return { firstDiff: first, finalOld: so, finalNext: sn };
  }

  // 均分为 k 个连续块，较长块靠前；返回 [start,end)（alive 坐标）
  function splitBlocks(m, k) {
    const q = (m / k) | 0;
    const rem = m % k;
    const blocks = new Array(k);
    let cur = 0;
    for (let b = 0; b < k; b++) {
      const len = q + (b < rem ? 1 : 0);
      blocks[b] = [cur, cur + len];
      cur += len;
    }
    return blocks;
  }

  // 试删一个块（alive 坐标 [lo,hi)），带依赖级联，返回删除印记与计数
  function markCascade(model, alive, lo, hi, delGen, gen, stack) {
    for (let p = lo; p < hi; p++) delGen[alive[p]] = gen;
    stack.length = 0;
    for (let p = lo; p < hi; p++) stack.push(alive[p]);
    let cascaded = 0;
    const seedCount = hi - lo;
    while (stack.length) {
      const x = stack.pop();
      const dependents = model.rev[x];
      for (let j = 0; j < dependents.length; j++) {
        const y = dependents[j];
        if (delGen[y] !== gen) {
          delGen[y] = gen;
          cascaded++;
          stack.push(y);
        }
      }
    }
    return { seedCount, removedTotal: seedCount + cascaded, cascaded };
  }

  // 通用试删重放：从块前快照恢复，跳过被删事件，找首次差异并与见证三项比对
  function trialReplay(model, alive, table, lo, hi, delGen, gen, witness, workOld, workNext) {
    const { snap, stride, F } = table;
    const obs = model.observeIdx;
    let found = null;

    // 块前的存活事件未受影响：其首发差异直接在快照区间 [1, lo] 中定位
    for (let row = 1; row <= lo; row++) {
      const base = row * stride;
      for (let j = 0; j < obs.length; j++) {
        const f = obs[j];
        const ov = snap[base + f];
        const nv = snap[base + F + f];
        if (ov !== nv) {
          const ei = alive[row - 1];
          found = {
            eventIndex: ei,
            eventId: model.idOf[ei],
            field: model.fields[f],
            sign: signOf(nv - ov),
            oldValue: ov,
            nextValue: nv,
          };
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      // 块前无差异：从 row lo 恢复种子状态，继续重放块后存活事件
      const baseRow = lo * stride;
      workOld.set(snap.subarray(baseRow, baseRow + F));
      workNext.set(snap.subarray(baseRow + F, baseRow + 2 * F));
      for (let p = hi; !found && p < alive.length; p++) {
        const oi = alive[p];
        if (delGen[oi] === gen) continue;
        const ki = model.kindOf[oi];
        if (ki >= 0) {
          const lo2 = model.oldLists[ki];
          const ln2 = model.nextLists[ki];
          if (lo2) runList(lo2, workOld);
          if (ln2) runList(ln2, workNext);
        }
        for (let j = 0; j < obs.length; j++) {
          const f = obs[j];
          if (workOld[f] !== workNext[f]) {
            found = {
              eventIndex: oi,
              eventId: model.idOf[oi],
              field: model.fields[f],
              sign: signOf(workNext[f] - workOld[f]),
              oldValue: workOld[f],
              nextValue: workNext[f],
            };
            break;
          }
        }
      }
    }
    if (!found) return { verdict: 2, found: null }; // 差异消失 → 故障未复现
    const match = found.eventIndex === witness.eventIndex &&
      found.field === witness.field && found.sign === witness.sign;
    return { verdict: match ? 0 : 3, found }; // 0 接受 / 3 见证失配（漂成了另一种差异）
  }

  /**
   * 缩减主循环。hooks（可选）：
   *   isCancelled() -> bool   每轮/每试删检查
   *   shouldYield() -> bool   UI 让出主线程
   *   doYield() -> Promise
   *   onRound(rec) / onTrial(rec)
   */
  async function shrink(model, base, hooks) {
    hooks = hooks || {};
    const witness = base.witness;
    if (!witness) return { status: 'no-diff', alive: base.alive, rounds: [], trials: 0, accepts: 0, elapsedMs: 0, witness: null };

    const n = model.n;
    let alive = Array.from(base.alive);
    let table = base.table;
    const delGen = new Int32Array(n);
    let gen = 0;
    const stack = [];
    const workOld = new Int32Array(model.F);
    const workNext = new Int32Array(model.F);
    const aliveIndex = new Int32Array(n);
    const reindex = () => {
      aliveIndex.fill(-1);
      for (let p = 0; p < alive.length; p++) aliveIndex[alive[p]] = p;
    };
    reindex();

    const rounds = [];
    let trials = 0;
    let accepts = 0;
    const t0 = Date.now();
    let status = 'finished';
    let k = 2;

    outer:
    for (;;) {
      if (hooks.isCancelled && hooks.isCancelled()) { status = 'cancelled'; break; }
      if (k > alive.length) break;
      const m = alive.length;
      const blocks = splitBlocks(m, k);
      const round = {
        k, mStart: m,
        sizes: blocks.map((b) => b[1] - b[0]),
        // 每块映射到原事件号（含），供界面展示试删范围
        ranges: blocks.map((b) => [alive[b[0]], alive[b[1] - 1]]),
        accepted: false, blockIdx: -1,
        trials: [],
      };
      rounds.push(round);
      hooks.onRound && hooks.onRound(round);

      for (let bi = 0; bi < blocks.length; bi++) {
        if (hooks.isCancelled && hooks.isCancelled()) { status = 'cancelled'; break outer; }
        const [lo, hi] = blocks[bi];
        gen++;
        let rec;

        if (model.isChain) {
          // 单链：删 [lo,hi) 必级联清空 lo 之后的全部节点；前缀状态不变
          const removedTotal = m - lo;
          const wPos = aliveIndex[witness.eventIndex];
          if (lo <= wPos) {
            // 见证事件被级联删除，缩减重放中已无该差异：差异字段留空，由判定码说明原因
            rec = [lo, hi, removedTotal, 1, -1, null, null, null, null];
          } else {
            // 见证事件位于未受影响前缀中，状态逐事件一致 → 三项必然全中，直接接受
            alive = alive.slice(0, lo);
            reindex();
            table = buildSnapshots(model, alive);
            round.accepted = true;
            round.blockIdx = bi;
            rec = [lo, hi, removedTotal, 0, witness.eventIndex, witness.field, witness.sign, witness.oldValue, witness.nextValue];
            round.trials.push(rec);
            trials++;
            accepts++;
            hooks.onTrial && hooks.onTrial(rec);
            k = 2;
            continue outer;
          }
        } else {
          const cas = markCascade(model, alive, lo, hi, delGen, gen, stack);
          const r = trialReplay(model, alive, table, lo, hi, delGen, gen, witness, workOld, workNext);
          if (r.verdict === 0) {
            const kept = [];
            for (let p = 0; p < m; p++) if (delGen[alive[p]] !== gen) kept.push(alive[p]);
            alive = kept;
            reindex();
            table = buildSnapshots(model, alive);
            round.accepted = true;
            round.blockIdx = bi;
            rec = [lo, hi, cas.removedTotal, 0, r.found.eventIndex, r.found.field, r.found.sign, r.found.oldValue, r.found.nextValue];
            round.trials.push(rec);
            trials++;
            accepts++;
            hooks.onTrial && hooks.onTrial(rec);
            k = 2;
            continue outer;
          }
          rec = [
            lo, hi, cas.removedTotal, r.verdict,
            r.found ? r.found.eventIndex : -1,
            r.found ? r.found.field : null,
            r.found ? r.found.sign : null,
            r.found ? r.found.oldValue : null,
            r.found ? r.found.nextValue : null,
          ];
        }
        round.trials.push(rec);
        trials++;
        hooks.onTrial && hooks.onTrial(rec);
        if (hooks.shouldYield && hooks.shouldYield()) await hooks.doYield();
      }

      if (hooks.isCancelled && hooks.isCancelled()) { status = 'cancelled'; break; }
      if (k >= m) break;          // 单条试删轮全失败 → 结束
      k = Math.min(k * 2, m);     // 块数翻倍，上限剩余长度
      if (hooks.shouldYield && hooks.shouldYield()) await hooks.doYield();
    }

    return {
      status,
      alive: Int32Array.from(alive),
      rounds, trials, accepts,
      elapsedMs: Date.now() - t0,
      witness,
    };
  }

  // ---------- 导出（可独立重演：含全套规则、缩减事件、见证与校验） ----------
  function buildExport(model, alive, witness, meta) {
    const positions = Array.from(alive);
    const verify = replayReduced(model, positions);
    const reducedEvents = positions.map((oi) => model.doc.events[oi]);
    const ok = !!verify.firstDiff &&
      verify.firstDiff.eventIndex === witness.eventIndex &&
      verify.firstDiff.field === witness.field &&
      verify.firstDiff.sign === witness.sign;
    return {
      schema: 'replay-witness-shrink/1',
      exportedAt: new Date().toISOString(),
      source: {
        initial: model.doc.initial,
        observe: model.doc.observe,
        old: model.doc.old,
        next: model.doc.next,
        ...(Array.isArray(model.doc.rules) ? { rules: model.doc.rules } : {}),
      },
      witness: {
        eventIndex: witness.eventIndex,
        eventId: witness.eventId,
        field: witness.field,
        sign: witness.sign,
      },
      events: reducedEvents,
      verification: {
        witnessReproduced: ok,
        firstDiff: verify.firstDiff,
      },
      shrink: Object.assign({
        originalCount: model.n,
        reducedCount: positions.length,
      }, meta || {}),
    };
  }

  // 识别本工具导出的重演包
  function isExport(doc) {
    return doc && doc.schema === 'replay-witness-shrink/1' && doc.source && Array.isArray(doc.events);
  }

  function exportToSource(doc) {
    return {
      initial: doc.source.initial,
      observe: doc.source.observe,
      old: doc.source.old,
      next: doc.source.next,
      ...(Array.isArray(doc.source.rules) ? { rules: doc.source.rules } : {}),
      events: doc.events,
    };
  }

  // 试删判定码（trial 记录第 4 项）
  const VERDICT = {
    ACCEPTED: 0,       // 见证三项全中，接受缩减
    DEP_LOST: 1,       // 级联删除吞掉见证事件（单链快路专用）
    NO_DIFF: 2,        // 差异消失，故障未复现
    WITNESS_MISMATCH: 3, // 首次差异漂成了另一种（事件号/字段/符号对不上）
  };
  const VERDICT_LABEL = {
    0: '接受：见证三项全中',
    1: '拒绝：级联删除吞掉见证事件',
    2: '拒绝：差异消失',
    3: '拒绝：首次差异漂移，见证失配',
  };

  return {
    validate, buildModel, baseline, shrink, replayReduced,
    buildExport, isExport, exportToSource, splitBlocks,
    VERDICT, VERDICT_LABEL,
  };
});
