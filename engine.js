/*
 * 铁路编组场调度模拟引擎（无 DOM 依赖，浏览器与 Node 通用）
 *
 * 每步顺序：
 *   1. 步首占用检查：处理本步道岔扳动请求。道岔的任一位置块在步首被车身占用即锁定，
 *      请求拒绝；全部空闲才接受并改向。两个方向共用一把锁。
 *   2. 按列车编号（自然序）依次判定进车：目标块被步首车身占用、或已被本步更早的车
 *      抢到，则本车等待；否则抢到目标块。
 *   3. 所有抢到目标的车一起移动（车身整体向前挪一块，车尾退出最后一块）。
 * 到站列车（剩余路线为空）不再移动，但仍占用其车身所在轨道块。
 */
(function (global) {
  'use strict';

  /** 编号自然序：A < B < A2 < A10（含数字时按数值比较） */
  function naturalCompare(a, b) {
    const ra = String(a).match(/\d+|\D+/g) || [];
    const rb = String(b).match(/\d+|\D+/g) || [];
    const n = Math.min(ra.length, rb.length);
    for (let i = 0; i < n; i++) {
      const da = /^\d+$/.test(ra[i]);
      const db = /^\d+$/.test(rb[i]);
      if (da && db) {
        const d = Number(ra[i]) - Number(rb[i]);
        if (d !== 0) return d;
      } else if (ra[i] !== rb[i]) {
        return ra[i] < rb[i] ? -1 : 1;
      }
    }
    return ra.length - rb.length;
  }

  function deepCopy(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /** 校验关卡/操作表，返回 { errors:[], warnings:[] } */
  function validate(level) {
    const errors = [];
    const warnings = [];
    if (!level || typeof level !== 'object') {
      return { errors: ['关卡数据必须是 JSON 对象'], warnings };
    }
    const { edges, switches, trains, commands } = level;

    if (!Array.isArray(edges)) errors.push('edges 必须是数组');
    if (!Array.isArray(switches)) errors.push('switches 必须是数组');
    if (!Array.isArray(trains)) errors.push('trains 必须是数组');
    if (errors.length) return { errors, warnings };

    if (trains.length > 16) errors.push(`列车最多 16 列，当前 ${trains.length} 列`);

    const blocks = new Set();
    for (const e of edges) {
      if (!Array.isArray(e) || e.length !== 2 || !e[0] || !e[1]) {
        errors.push(`非法边: ${JSON.stringify(e)}`);
        continue;
      }
      blocks.add(e[0]);
      blocks.add(e[1]);
    }
    if (blocks.size > 80) errors.push(`轨道块最多 80 个，当前 ${blocks.size} 个`);

    const adj = new Set();
    for (const e of edges) {
      if (!Array.isArray(e) || e.length !== 2 || !e[0] || !e[1]) continue; // 非法边已在上面记录
      adj.add(e[0] + ' ' + e[1]);
    }
    const hasEdge = (u, v) => adj.has(u + ' ' + v) || adj.has(v + ' ' + u);

    const switchIds = new Set();
    const blockToSwitch = new Map();
    for (const s of switches) {
      if (!s || typeof s.id !== 'string' || !Array.isArray(s.positions) || s.positions.length < 2) {
        errors.push(`非法道岔定义: ${JSON.stringify(s)}`);
        continue;
      }
      if (switchIds.has(s.id)) errors.push(`道岔 id 重复: ${s.id}`);
      switchIds.add(s.id);
      if (!s.positions.includes(s.initial)) {
        errors.push(`道岔 ${s.id} 的初始方向 ${s.initial} 不在位置表中`);
      }
      for (const p of s.positions) {
        if (!blocks.has(p)) errors.push(`道岔 ${s.id} 的位置块 ${p} 不在 edges 中`);
        if (blockToSwitch.has(p) && blockToSwitch.get(p) !== s.id) {
          errors.push(`轨道块 ${p} 被多个道闸占用: ${blockToSwitch.get(p)}、${s.id}`);
        }
        blockToSwitch.set(p, s.id);
      }
    }

    const trainIds = new Set();
    const initialOcc = new Set();
    for (const t of trains) {
      if (!t || typeof t.id !== 'string' || !Array.isArray(t.body) || !Array.isArray(t.route)) {
        errors.push(`非法列车定义: ${JSON.stringify(t)}`);
        continue;
      }
      if (trainIds.has(t.id)) errors.push(`列车 id 重复: ${t.id}`);
      trainIds.add(t.id);
      if (t.body.length === 0) errors.push(`列车 ${t.id} 的车身不能为空`);
      for (let i = 0; i < t.body.length; i++) {
        const b = t.body[i];
        if (!blocks.has(b)) errors.push(`列车 ${t.id} 车身块 ${b} 不在 edges 中`);
        if (initialOcc.has(b)) errors.push(`步首时刻轨道块 ${b} 被多列车重叠占用`);
        initialOcc.add(b);
        if (i > 0 && !hasEdge(t.body[i - 1], b)) {
          warnings.push(`列车 ${t.id} 车身块 ${t.body[i - 1]} 与 ${b} 之间没有边相连`);
        }
      }
      for (const r of t.route) {
        if (!blocks.has(r)) errors.push(`列车 ${t.id} 路线块 ${r} 不在 edges 中`);
      }
    }

    if (Array.isArray(commands)) {
      let lastStep = 0;
      for (const c of commands) {
        if (!Array.isArray(c) || c.length !== 3) {
          errors.push(`非法操作表条目: ${JSON.stringify(c)}`);
          continue;
        }
        const [step, sid, pos] = c;
        if (!Number.isInteger(step) || step < 1) errors.push(`操作步号必须为正整数: ${JSON.stringify(c)}`);
        if (step < lastStep) errors.push(`操作表步号必须非递减: 第 ${step} 步`);
        lastStep = step;
        if (!switchIds.has(sid)) errors.push(`操作表引用了不存在的道岔: ${sid}`);
        else if (!switches.find((s) => s.id === sid).positions.includes(pos)) {
          errors.push(`道岔 ${sid} 不存在方向 ${pos}`);
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * 创建一局模拟。
   * @param {object} level 关卡（含 edges/switches/trains，可选 commands）
   * @param {Array} [commands] 可选操作表 [[step, switchId, position], ...]
   */
  function createSimulation(level, commands) {
    const cmds = Array.isArray(commands)
      ? commands
      : Array.isArray(level.commands)
        ? level.commands
        : [];

    const sortedTrains = level.trains.slice().sort((a, b) => naturalCompare(a.id, b.id));
    const trains = sortedTrains.map((t) => ({
      id: t.id,
      body: deepCopy(t.body), // body[body.length-1] 为车头，body[0] 为车尾
      remaining: deepCopy(t.route), // 车头尚未到达的路线块
    }));

    const switches = level.switches.map((s) => ({
      id: s.id,
      positions: s.positions.slice(),
      position: s.initial,
    }));

    const blockToSwitch = new Map();
    for (const s of switches) for (const p of s.positions) blockToSwitch.set(p, s.id);

    const state = {
      step: 0,
      switches,
      trains,
      pending: {}, // 本步手动扳动请求 { switchId: position }
      history: [], // 每步一条记录
      commands: cmds.map((c) => ({ step: c[0], switchId: c[1], position: c[2], consumed: false })),
      finished: false,
    };

    /** 步首（当前状态下）所有车身占用的轨道块 */
    function occupiedBlocks() {
      const occ = new Set();
      for (const t of state.trains) for (const b of t.body) occ.add(b);
      return occ;
    }

    /** 道岔是否锁定：任一道岔位置块在步首被车身占用 */
    function isSwitchLocked(switchId) {
      const sw = state.switches.find((s) => s.id === switchId);
      if (!sw) return false;
      const occ = occupiedBlocks();
      return sw.positions.some((p) => occ.has(p));
    }

    /** 当前各列车车头（按列车编号顺序） */
    function heads() {
      return state.trains.map((t) => t.body[t.body.length - 1]);
    }

    function trainById(id) {
      return state.trains.find((t) => t.id === id);
    }

    /**
     * 推进一个步。
     * @param {Object<string,string>} [manualRequests] 本步手动扳动请求
     * @returns {object} 本步记录
     */
    function step(manualRequests) {
      const stepNo = state.step + 1;
      const occAtStart = occupiedBlocks();
      const decisions = [];

      // 收集本步请求：手动请求与操作表同步条目合并，手动优先
      const requests = [];
      const seen = new Set();
      const manual = manualRequests || state.pending || {};
      for (const [sid, pos] of Object.entries(manual)) {
        requests.push({ switchId: sid, position: pos, source: 'manual' });
        seen.add(sid);
      }
      for (const c of state.commands) {
        if (!c.consumed && c.step === stepNo && !seen.has(c.switchId)) {
          requests.push({ switchId: c.switchId, position: c.position, source: 'table' });
          seen.add(c.switchId);
        }
      }
      for (const c of state.commands) {
        if (!c.consumed && c.step === stepNo) c.consumed = true;
      }

      // 1) 步首占用检查扳动请求（两个方向共用一把锁）
      for (const req of requests) {
        const sw = state.switches.find((s) => s.id === req.switchId);
        if (!sw) {
          decisions.push({
            switchId: req.switchId,
            requested: req.position,
            from: null,
            accepted: false,
            reason: '道岔不存在',
            source: req.source,
          });
          continue;
        }
        const locked = sw.positions.some((p) => occAtStart.has(p));
        if (locked) {
          const blocker = sw.positions.filter((p) => occAtStart.has(p)).join('、');
          decisions.push({
            switchId: sw.id,
            requested: req.position,
            from: sw.position,
            accepted: false,
            reason: `道岔锁定：位置块 ${blocker} 步首被车身占用，车尾完全退出后的下一步才能扳动`,
            source: req.source,
          });
        } else {
          const changed = sw.position !== req.position;
          const from = sw.position;
          sw.position = req.position;
          decisions.push({
            switchId: sw.id,
            requested: req.position,
            from,
            accepted: true,
            changed,
            reason: changed ? '道岔位置块全部空闲，扳动接受' : '方向与当前一致，无需扳动',
            source: req.source,
          });
        }
      }
      state.pending = {};

      // 2) 按列车编号顺序判定进车（步首占用 + 本步已抢到的目标都要让后来的车等待）
      const claimed = new Set();
      const actions = [];
      for (const t of state.trains) {
        const rec = {
          trainId: t.id,
          head: t.body[t.body.length - 1],
          tail: t.body[0],
          body: deepCopy(t.body),
          remaining: deepCopy(t.remaining),
          moved: false,
          target: null,
          waitReason: null,
          arrived: t.remaining.length === 0,
        };
        if (t.remaining.length === 0) {
          rec.waitReason = '已到站，仍占用车身所在轨道';
        } else {
          const target = t.remaining[0];
          rec.target = target;
          const sw = blockToSwitch.get(target);
          if (occAtStart.has(target)) {
            rec.waitReason = `目标块 ${target} 在步首被车身占用，等待`;
          } else if (claimed.has(target)) {
            rec.waitReason = `目标块 ${target} 本步已被编号更靠前的列车抢到，等待`;
          } else if (sw && state.switches.find((s) => s.id === sw).position !== target) {
            const sObj = state.switches.find((s) => s.id === sw);
            rec.waitReason =
              `道岔 ${sw} 当前朝向 ${sObj.position}，本车目标 ${target} 不可进入，等待扳道`;
          } else {
            claimed.add(target);
            rec.moved = true;
          }
        }
        actions.push(rec);
      }

      // 3) 一起移动
      for (const rec of actions) {
        if (!rec.moved) continue;
        const t = trainById(rec.trainId);
        t.body.push(t.remaining.shift());
        t.body.shift(); // 车尾退出
        rec.headAfter = t.body[t.body.length - 1];
        rec.tailAfter = t.body[0];
        rec.bodyAfter = deepCopy(t.body);
        rec.remainingAfter = deepCopy(t.remaining);
        rec.arrived = t.remaining.length === 0; // 移动后若路线走完，本步即到站
      }
      for (const rec of actions) {
        if (!rec.moved) {
          rec.headAfter = rec.head;
          rec.tailAfter = rec.tail;
          rec.bodyAfter = deepCopy(rec.body);
          rec.remainingAfter = deepCopy(rec.remaining);
        }
      }

      state.step = stepNo;
      const record = {
        step: stepNo,
        decisions,
        trains: actions,
        occupied: Array.from(occupiedBlocks()).sort(naturalCompare),
        heads: heads(),
      };
      state.history.push(record);
      return record;
    }

    /** 连续运行：无列车能动且无待处理扳道/操作表条目时判定僵局并停止 */
    function canAnyTrainMove() {
      const occ = occupiedBlocks();
      const claimed = new Set();
      for (const t of state.trains) {
        if (t.remaining.length === 0) continue;
        const target = t.remaining[0];
        if (occ.has(target) || claimed.has(target)) continue;
        const sw = blockToSwitch.get(target);
        if (sw && state.switches.find((s) => s.id === sw).position !== target) continue;
        return true;
      }
      return false;
    }

    function allArrived() {
      return state.trains.every((t) => t.remaining.length === 0);
    }

    return {
      state,
      step,
      heads,
      occupiedBlocks,
      isSwitchLocked,
      canAnyTrainMove,
      allArrived,
      naturalCompare,
    };
  }

  /** 跑到无变化（无车可动、无待决请求、无剩余操作表条目）或全部到站，返回模拟对象 */
  function run(level, commands, maxSteps) {
    const sim = createSimulation(level, commands);
    const limit = maxSteps || 1000;
    for (let i = 0; i < limit; i++) {
      const pendingTable = sim.state.commands.some((c) => !c.consumed);
      const pendingManual = Object.keys(sim.state.pending).length > 0;
      if (sim.allArrived() || (!sim.canAnyTrainMove() && !pendingTable && !pendingManual)) break;
      sim.step();
    }
    return sim;
  }

  /**
   * 校验 expected（样例格式：expected.heads 逐步车头 + expected.switchChanges 接受/拒绝，
   * 或 extra 格式：expectedHeads 终局车头映射）。
   */
  function checkExpected(level, commands, expected) {
    if (!expected) return { ok: true, errors: [] };
    const sim = run(level, commands);
    const errors = [];

    if (expected.heads) {
      const got = sim.state.history.map((r) => r.heads);
      const want = expected.heads;
      const n = Math.max(got.length, want.length);
      for (let i = 0; i < n; i++) {
        const g = JSON.stringify(got[i] || []);
        const w = JSON.stringify(want[i] || []);
        if (g !== w) errors.push(`第 ${i + 1} 步车头: 期望 ${w}，实际 ${g}`);
      }
    }
    if (Array.isArray(expected.switchChanges)) {
      const got = sim.state.history
        .flatMap((r) => r.decisions)
        .map((d) => (d.accepted ? '接受' : '拒绝'));
      const want = expected.switchChanges;
      const n = Math.max(got.length, want.length);
      for (let i = 0; i < n; i++) {
        if (got[i] !== want[i]) {
          errors.push(`第 ${i + 1} 次扳道: 期望 ${want[i]}，实际 ${got[i] || '无'}`);
        }
      }
    }
    if (expected.expectedHeads) {
      const byId = {};
      for (const t of sim.state.trains) byId[t.id] = t.body[t.body.length - 1];
      for (const [id, want] of Object.entries(expected.expectedHeads)) {
        if (byId[id] !== want) errors.push(`列车 ${id} 终局车头: 期望 ${want}，实际 ${byId[id]}`);
      }
    }
    return { ok: errors.length === 0, errors, sim };
  }

  const api = { validate, createSimulation, run, checkExpected, naturalCompare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RailEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
