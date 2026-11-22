/*
 * live-tile-strokes 引擎（自研同步与撤销，不依赖任何协同编辑库）
 *
 * 语义：
 * - 操作 = { by, n, deps, paint } 或 { by, n, deps, set }。
 * - 每条操作隐式依赖同作者的上一条操作 (by, n-1)；deps 为至多 16 个显式依赖。
 * - 依赖未齐的操作先挂起，依赖到齐后自动生效；时钟 = 所有依赖（含隐式）的最大时钟 + 1，无依赖从 1 开始。
 * - 每格取生效笔画里时钟最大的一笔，同钟取作者编号（字典序）较大者。
 * - 撤销/重做 = 作者对自己早先整笔的 set 新操作，按最后一次切换决定是否生效，失效后显露底下的笔画。
 * - 重复操作只记一次；操作号冲突或依赖成环时拒绝整批并保留原状态。
 * - 导出为规范化 JSON（操作按 (by, n) 排序、键序固定），同一操作集无论怎么分批送达都逐字节一致。
 *
 * 实现要点：
 * - 挂起用增量等待表（waiters: 依赖 -> 等待者，rec.unmet: 未满足依赖数），
 *   每批导入代价只与本批新操作及被唤醒的操作成正比。
 * - 环必含本批新操作（既有挂起集无环），环检测在新操作的反向可达闭包内做。
 * - set 目标若已记录（含本批）必须指向笔画，否则整批拒绝；目标未记录时挂起等待，
 *   目标随后续批次到达时由 setTargetIndex 触发同样的校验。
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) root.TileEngine = M;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 与 samples/live-tile-strokes.json 保持一致的规则说明，导出时原样带上。
  const RULES = [
    '作者编号为非空ASCII串，按字典序比较。n为从1起的作者序号，deps为至多16个显式依赖。',
    'paint里的每项是[x,y,瓦片号]，坐标从0起，每笔不可重复写同一格，瓦片号0清空。set为[同作者更小的笔画序号,是否生效]，指向非笔画时报错。',
    'width和height给地图大小，operations可单批或拆批导入，每项只含paint和set中的一种。',
    '操作内容按字段值判等，JSON对象键顺序不改变内容。',
  ];

  const MAX_DEPS = 16;
  const MAX_DIM = 4096;

  const keyOf = (by, n) => by + '\n' + n;

  function isAuthor(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
    return true;
  }
  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  function createDoc(width, height) {
    if (!isInt(width) || !isInt(height) || width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
      throw new Error('非法地图尺寸: ' + width + 'x' + height);
    return {
      width,
      height,
      ops: new Map(), // key -> rec（已记录的全部操作，含挂起）
      maxN: new Map(), // by -> 已记录的最大 n
      applied: new Set(), // 已生效的 key
      pending: new Map(), // 挂起的 key -> rec（rec.unmet = 未满足依赖数）
      waiters: new Map(), // 未满足依赖 key -> Set<挂起操作 key>
      setTargetIndex: new Map(), // 挂起 set 操作的目标 key -> Set<挂起 set 操作 key>
      clock: new Map(), // key -> 时钟（仅已生效）
      strokes: new Map(), // key -> {key, by, n, clock, effective, lastSetN, cells:[[idx,tile]...]}
      cells: new Array(width * height).fill(null), // idx -> {list:[[strokeKey,tile]...], winner}
      grid: new Uint32Array(width * height), // 每格当前赢者写下的瓦片号（0 = 空）
    };
  }

  // 显式依赖 + 隐式依赖（同作者上一条），按 key 去重（同一依赖只等待一次）
  function depsOf(rec) {
    if (!rec._allDeps) {
      const seen = new Set();
      const d = [];
      for (const [b, nn] of rec.deps) {
        const k = keyOf(b, nn);
        if (!seen.has(k)) {
          seen.add(k);
          d.push([b, nn]);
        }
      }
      if (rec.n > 1) {
        const k = keyOf(rec.by, rec.n - 1);
        if (!seen.has(k)) d.push([rec.by, rec.n - 1]);
      }
      rec._allDeps = d;
    }
    return rec._allDeps;
  }

  // ---------- 解析与校验 ----------

  function parseOp(raw, idx, width, height) {
    const where = 'operations[' + idx + ']';
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(where + ': 不是对象');
    for (const k of Object.keys(raw))
      if (k !== 'by' && k !== 'n' && k !== 'deps' && k !== 'paint' && k !== 'set')
        throw new Error(where + ': 未知字段 ' + JSON.stringify(k));
    const { by, n } = raw;
    if (!isAuthor(by)) throw new Error(where + ': by 须为非空ASCII串');
    if (!isInt(n) || n < 1) throw new Error(where + ': n 须为从1起的整数');
    const hasPaint = 'paint' in raw;
    const hasSet = 'set' in raw;
    if (hasPaint === hasSet) throw new Error(where + ': 每项只含 paint 和 set 中的一种');

    let deps = raw.deps;
    if (deps === undefined) deps = [];
    if (!Array.isArray(deps) || deps.length > MAX_DEPS)
      throw new Error(where + ': deps 须为至多' + MAX_DEPS + '个依赖的数组');
    const pdeps = deps.map((d, i) => {
      if (!Array.isArray(d) || d.length !== 2 || !isAuthor(d[0]) || !isInt(d[1]) || d[1] < 1)
        throw new Error(where + ': deps[' + i + '] 须为 [作者, 序号]');
      return [d[0], d[1]];
    });

    if (hasPaint) {
      const p = raw.paint;
      if (!Array.isArray(p) || p.length < 1) throw new Error(where + ': paint 须为非空数组');
      const seen = new Set();
      const paint = p.map((c, i) => {
        if (
          !Array.isArray(c) || c.length !== 3 ||
          !isInt(c[0]) || !isInt(c[1]) || !isInt(c[2]) ||
          c[0] < 0 || c[0] >= width || c[1] < 0 || c[1] >= height || c[2] < 0
        )
          throw new Error(where + ': paint[' + i + '] 须为 [x,y,瓦片号]，坐标越界或值非法');
        const ci = c[1] * width + c[0];
        if (seen.has(ci)) throw new Error(where + ': 一笔不可重复写同一格');
        seen.add(ci);
        return [c[0], c[1], c[2]];
      });
      return { by, n, deps: pdeps, type: 'paint', paint, set: null };
    }

    const s = raw.set;
    if (!Array.isArray(s) || s.length !== 2 || !isInt(s[0]) || s[0] < 1 || s[0] >= n || typeof s[1] !== 'boolean')
      throw new Error(where + ': set 须为 [同作者更小的笔画序号, 是否生效]');
    return { by, n, deps: pdeps, type: 'set', paint: null, set: [s[0], s[1]] };
  }

  // 操作内容按字段值判等（数组顺序属于值的一部分）
  function sameOp(a, b) {
    if (a.by !== b.by || a.n !== b.n || a.type !== b.type) return false;
    if (a.deps.length !== b.deps.length) return false;
    for (let i = 0; i < a.deps.length; i++)
      if (a.deps[i][0] !== b.deps[i][0] || a.deps[i][1] !== b.deps[i][1]) return false;
    if (a.type === 'paint') {
      if (a.paint.length !== b.paint.length) return false;
      for (let i = 0; i < a.paint.length; i++) {
        const x = a.paint[i], y = b.paint[i];
        if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
      }
    } else if (a.set[0] !== b.set[0] || a.set[1] !== b.set[1]) return false;
    return true;
  }

  // ---------- 格子赢者维护 ----------

  // a 是否胜过 b：时钟大者胜，同钟作者编号（字典序）大者胜
  function beats(a, b) {
    if (a.clock !== b.clock) return a.clock > b.clock;
    return a.by > b.by;
  }

  function cellAddStroke(doc, idx, stroke, tile) {
    let c = doc.cells[idx];
    if (!c) c = doc.cells[idx] = { list: [], winner: null };
    c.list.push([stroke.key, tile]);
    if (!stroke.effective) return;
    if (c.winner === null || beats(stroke, doc.strokes.get(c.winner))) {
      c.winner = stroke.key;
      doc.grid[idx] = tile;
    }
  }

  function rescanWinner(doc, idx) {
    const c = doc.cells[idx];
    let best = null, bestTile = 0;
    for (const [sk, t] of c.list) {
      const s = doc.strokes.get(sk);
      if (!s.effective) continue;
      if (best === null || beats(s, doc.strokes.get(best))) {
        best = sk;
        bestTile = t;
      }
    }
    c.winner = best;
    doc.grid[idx] = best === null ? 0 : bestTile;
  }

  function setStrokeEffective(doc, stroke, val) {
    if (stroke.effective === val) return;
    stroke.effective = val;
    for (const [idx, tile] of stroke.cells) {
      const c = doc.cells[idx];
      if (val) {
        if (c.winner === null || beats(stroke, doc.strokes.get(c.winner))) {
          c.winner = stroke.key;
          doc.grid[idx] = tile;
        }
      } else if (c.winner === stroke.key) {
        rescanWinner(doc, idx); // 赢者失效，重新显露底下的笔画
      }
    }
  }

  function applyOp(doc, rec) {
    const k = keyOf(rec.by, rec.n);
    let clk = 0;
    for (const d of depsOf(rec)) {
      const c = doc.clock.get(keyOf(d[0], d[1]));
      if (c > clk) clk = c;
    }
    clk += 1;
    doc.clock.set(k, clk);
    doc.applied.add(k);
    doc.pending.delete(k);
    if (rec.type === 'paint') {
      const stroke = {
        key: k, by: rec.by, n: rec.n, clock: clk, effective: true, lastSetN: 0,
        cells: rec.paint.map(([x, y, t]) => [y * doc.width + x, t]),
      };
      doc.strokes.set(k, stroke);
      for (const [idx, tile] of stroke.cells) cellAddStroke(doc, idx, stroke, tile);
    } else {
      // set 的目标是同作者更小序号，经隐式链必然先生效，且导入时已校验指向笔画
      const stroke = doc.strokes.get(keyOf(rec.by, rec.set[0]));
      if (rec.n > stroke.lastSetN) stroke.lastSetN = rec.n; // 同作者操作按序号顺序生效
      setStrokeEffective(doc, stroke, rec.set[1]);
    }
  }

  // 操作生效后，唤醒等待它的挂起操作（级联）
  function cascade(doc, startKey, queue) {
    const ws = doc.waiters.get(startKey);
    if (!ws) return;
    doc.waiters.delete(startKey);
    for (const wk of ws) {
      const wrec = doc.pending.get(wk);
      if (--wrec.unmet === 0) queue.push(wk);
    }
  }

  function removeFromWaiters(doc, rec) {
    for (const d of depsOf(rec)) {
      const dk = keyOf(d[0], d[1]);
      const ws = doc.waiters.get(dk);
      if (ws) {
        ws.delete(keyOf(rec.by, rec.n));
        if (ws.size === 0) doc.waiters.delete(dk);
      }
    }
  }

  // ---------- 批次导入 ----------

  // 拒绝时返回 {ok:false, error}，且保证不改动 doc 的任何状态
  function importBatch(doc, rawOps) {
    if (!Array.isArray(rawOps)) return { ok: false, error: '批次须为操作数组' };

    // 1) 结构校验（纯解析，无副作用）
    let parsed;
    try {
      parsed = rawOps.map((r, i) => parseOp(r, i, doc.width, doc.height));
    } catch (e) {
      return { ok: false, error: e.message };
    }

    // 2) 去重 / 操作号冲突（重复操作只记一次；同号不同内容拒绝整批）
    const batchMap = new Map();
    let duplicated = 0;
    for (const rec of parsed) {
      const k = keyOf(rec.by, rec.n);
      const exist = doc.ops.get(k) || batchMap.get(k);
      if (exist) {
        if (!sameOp(exist, rec))
          return { ok: false, error: '操作号冲突: ' + rec.by + '#' + rec.n + ' 内容不一致，整批拒绝' };
        duplicated++;
        continue;
      }
      batchMap.set(k, rec);
    }
    if (batchMap.size === 0)
      return { ok: true, added: 0, duplicated, applied: 0, pending: doc.pending.size };

    // 3) set 指向校验：
    //    a. 本批新 set 操作的目标若已记录（既有或本批），必须指向笔画；
    //    b. 本批新操作若是某挂起 set 操作的目标，也必须指向笔画。
    //    目标未记录的 set 操作会随隐式链挂起，等目标到达时由 (b) 校验。
    for (const rec of batchMap.values()) {
      const k = keyOf(rec.by, rec.n);
      if (rec.type === 'set') {
        const t = doc.ops.get(keyOf(rec.by, rec.set[0])) || batchMap.get(keyOf(rec.by, rec.set[0]));
        if (t && t.type !== 'paint')
          return { ok: false, error: 'set 指向非笔画: ' + rec.by + '#' + rec.n + ' -> ' + rec.by + '#' + rec.set[0] + '，整批拒绝' };
      }
      const waitingSets = doc.setTargetIndex.get(k);
      if (waitingSets && waitingSets.size > 0 && rec.type !== 'paint') {
        const wk = waitingSets.values().next().value;
        const w = doc.pending.get(wk);
        return { ok: false, error: 'set 指向非笔画: ' + w.by + '#' + w.n + ' -> ' + rec.by + '#' + rec.n + '，整批拒绝' };
      }
    }

    // 4) 依赖成环检测。环必含本批新操作（既有挂起集无环）；
    //    环上的操作都能经反向等待边到达新操作，故只需在反向可达闭包内做前向 DFS。
    {
      const suspect = new Set(batchMap.keys());
      const stack = [...batchMap.keys()];
      while (stack.length) {
        const k = stack.pop();
        const ws = doc.waiters.get(k);
        if (!ws) continue;
        for (const wk of ws) {
          if (!suspect.has(wk)) {
            suspect.add(wk);
            stack.push(wk);
          }
        }
      }
      const color = new Map(); // 1=灰 2=黑
      const dfsStack = [];
      for (const startKey of batchMap.keys()) {
        if (color.get(startKey) === 2) continue;
        color.set(startKey, 1);
        dfsStack.push([startKey, 0]);
        while (dfsStack.length) {
          const top = dfsStack[dfsStack.length - 1];
          const rec = batchMap.get(top[0]) || doc.pending.get(top[0]);
          const deps = depsOf(rec);
          if (top[1] < deps.length) {
            const dk = keyOf(deps[top[1]][0], deps[top[1]][1]);
            top[1]++;
            if (!suspect.has(dk)) continue; // 不在闭包内的边不可能成环
            const c = color.get(dk) || 0;
            if (c === 1) return { ok: false, error: '依赖成环，整批拒绝' };
            if (c === 0) {
              color.set(dk, 1);
              dfsStack.push([dk, 0]);
            }
          } else {
            color.set(top[0], 2);
            dfsStack.pop();
          }
        }
      }
    }

    // 5) 提交：以上校验全部通过，应用本身不会再失败
    const queue = [];
    for (const [k, rec] of batchMap) {
      doc.ops.set(k, rec);
      const m = doc.maxN.get(rec.by) || 0;
      if (rec.n > m) doc.maxN.set(rec.by, rec.n);
      let unmet = 0;
      for (const d of depsOf(rec)) {
        const dk = keyOf(d[0], d[1]);
        if (doc.applied.has(dk)) continue;
        unmet++;
        let ws = doc.waiters.get(dk);
        if (!ws) doc.waiters.set(dk, (ws = new Set()));
        ws.add(k);
      }
      if (unmet === 0) {
        queue.push(k);
      } else {
        rec.unmet = unmet;
        doc.pending.set(k, rec);
        if (rec.type === 'set') {
          const tk = keyOf(rec.by, rec.set[0]);
          let idx = doc.setTargetIndex.get(tk);
          if (!idx) doc.setTargetIndex.set(tk, (idx = new Set()));
          idx.add(k);
        }
      }
    }
    let appliedCount = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const k = queue[qi];
      const rec = doc.ops.get(k);
      if (rec.type === 'set') {
        const tk = keyOf(rec.by, rec.set[0]);
        const idx = doc.setTargetIndex.get(tk);
        if (idx) {
          idx.delete(k);
          if (idx.size === 0) doc.setTargetIndex.delete(tk);
        }
      }
      removeFromWaiters(doc, rec);
      applyOp(doc, rec);
      appliedCount++;
      cascade(doc, k, queue);
    }

    return { ok: true, added: batchMap.size, duplicated, applied: appliedCount, pending: doc.pending.size };
  }

  // ---------- JSON 导入导出 ----------

  function importJSON(doc, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'JSON 解析失败: ' + e.message };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { ok: false, error: '顶层须为对象' };
    if (!isInt(data.width) || !isInt(data.height) || data.width < 1 || data.height < 1 ||
        data.width > MAX_DIM || data.height > MAX_DIM)
      return { ok: false, error: 'width/height 非法' };
    if (!Array.isArray(data.operations)) return { ok: false, error: '缺少 operations 数组' };
    if (doc.ops.size === 0 && (doc.width !== data.width || doc.height !== data.height)) {
      // 空文档采纳文件尺寸
      doc.width = data.width;
      doc.height = data.height;
      doc.cells = new Array(data.width * data.height).fill(null);
      doc.grid = new Uint32Array(data.width * data.height);
    }
    if (doc.width !== data.width || doc.height !== data.height)
      return { ok: false, error: '地图尺寸不一致: 文件 ' + data.width + 'x' + data.height + '，当前 ' + doc.width + 'x' + doc.height };
    return importBatch(doc, data.operations);
  }

  function cmpOps(a, b) {
    if (a.by !== b.by) return a.by < b.by ? -1 : 1;
    return a.n - b.n;
  }

  // 规范化导出：操作按 (by, n) 排序、键序固定、紧凑分隔 —— 同一操作集逐字节一致
  function exportJSON(doc) {
    const ops = [...doc.ops.values()].sort(cmpOps).map((o) => {
      const deps = o.deps.map((d) => [d[0], d[1]]);
      if (o.type === 'paint')
        return { by: o.by, n: o.n, deps, paint: o.paint.map((p) => [p[0], p[1], p[2]]) };
      return { by: o.by, n: o.n, deps, set: [o.set[0], o.set[1]] };
    });
    return JSON.stringify({ rules: RULES, width: doc.width, height: doc.height, operations: ops });
  }

  // ---------- 查询接口（界面/测试用） ----------

  function nextSeq(doc, by) {
    return (doc.maxN.get(by) || 0) + 1;
  }

  function cellInfo(doc, x, y) {
    const idx = y * doc.width + x;
    const c = doc.cells[idx];
    const out = { x, y, tile: doc.grid[idx], winner: null, candidates: [] };
    if (!c) return out;
    for (const [sk, t] of c.list) {
      const s = doc.strokes.get(sk);
      out.candidates.push({
        by: s.by, n: s.n, clock: s.clock, tile: t, effective: s.effective, winner: sk === c.winner,
      });
    }
    out.candidates.sort((a, b) => (b.clock - a.clock) || (a.by < b.by ? 1 : a.by > b.by ? -1 : 0));
    if (c.winner !== null) {
      const s = doc.strokes.get(c.winner);
      out.winner = { by: s.by, n: s.n, clock: s.clock, tile: doc.grid[idx] };
    }
    return out;
  }

  function pendingInfo(doc) {
    const out = [];
    for (const rec of doc.pending.values()) {
      out.push({
        by: rec.by,
        n: rec.n,
        type: rec.type,
        missing: depsOf(rec)
          .filter((d) => !doc.applied.has(keyOf(d[0], d[1])))
          .map(([b, nn]) => ({
            by: b,
            n: nn,
            implicit: nn === rec.n - 1 && b === rec.by && !rec.deps.some((d) => d[0] === b && d[1] === nn),
            status: doc.pending.has(keyOf(b, nn)) ? '挂起中' : '未到达',
          })),
      });
    }
    out.sort(cmpOps);
    return out;
  }

  function listOps(doc, limit) {
    const arr = [...doc.ops.values()].sort(cmpOps);
    if (limit && arr.length > limit) arr.length = limit;
    return arr.map((o) => ({
      by: o.by,
      n: o.n,
      type: o.type,
      status: doc.applied.has(keyOf(o.by, o.n)) ? '已生效' : '挂起',
      clock: doc.clock.get(keyOf(o.by, o.n)) || null,
      desc:
        o.type === 'paint'
          ? 'paint ' + o.paint.length + ' 格'
          : 'set ' + o.by + '#' + o.set[0] + ' -> ' + (o.set[1] ? '生效' : '失效'),
    }));
  }

  // 撤销：当前生效的、序号最大的本人笔画 -> set 失效
  function makeUndoOp(doc, by) {
    let best = null;
    for (const s of doc.strokes.values())
      if (s.by === by && s.effective && (!best || s.n > best.n)) best = s;
    if (!best) return null;
    return { by, n: nextSeq(doc, by), deps: [], set: [best.n, false] };
  }

  // 重做：最近一次被切掉的本人笔画（按最后一次切换的 set 序号）-> set 生效
  function makeRedoOp(doc, by) {
    let best = null;
    for (const s of doc.strokes.values())
      if (s.by === by && !s.effective && (!best || s.lastSetN > best.lastSetN)) best = s;
    if (!best) return null;
    return { by, n: nextSeq(doc, by), deps: [], set: [best.n, true] };
  }

  return {
    RULES,
    createDoc,
    importBatch,
    importJSON,
    exportJSON,
    nextSeq,
    cellInfo,
    pendingInfo,
    listOps,
    makeUndoOp,
    makeRedoOp,
    keyOf,
  };
});
