/* sim.js — 整数墨量输运模拟核心（浏览器与 Node 通用）
 *
 * 规则（与 samples/ink-flux.json 的 rules 字段一致）：
 * - 坐标左上原点，格编号 i = y*width + x；width、height 各 2..256。
 * - wrap = [横向, 纵向] 周期布尔值。
 * - 每格有非负整数质量 mass、墙标记 wall、出流权重 w = [左,右,上,下]（各项非负整数，总和 ≤ 1024）。
 * - 每步：先按顺序应用该步事件（wall / w），再按步首存量同时出流。
 * - 墙格质量冻结；指向墙或越界的份额退回本格；绕回同一目的地的份额先合并；
 *   留存份额 = 1024 − 出流总和，也并入本格。
 * - 每份先取整 floor(m*share/1024)，余量按精确分数余数 (m*share mod 1024) 从大到小逐一补 1，
 *   平局给目的格编号小的。每步总质量严格不变。
 * - 步编号从 0 开始；帧 0 为未执行任何一步的初始状态；帧 f 为执行完步 0..f-1 后的状态。
 */
(function (global) {
'use strict';

const DEN = 1024;
const MAX_TOTAL = 2 ** 40;
const SNAP = 60; // 快照间隔（步）

function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

function validateW(w) {
  if (!Array.isArray(w) || w.length !== 4) return 'w 须为 4 元数组（左、右、上、下）';
  let s = 0;
  for (const v of w) {
    if (!isInt(v) || v < 0) return 'w 各项须为非负整数';
    s += v;
  }
  if (s > DEN) return 'w 总和须 ≤ 1024（当前 ' + s + '）';
  return null;
}

/* 解析并校验配置文本。成功返回 {model}，失败返回 {errors:[{line,msg}]}（line 为 1 起始的条目行号，0 表示文件级）。 */
function parseModel(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    return { errors: [{ line: 0, msg: 'JSON 解析失败：' + e.message }] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { errors: [{ line: 0, msg: '根节点须为对象' }] };
  }
  const errors = [];
  const W = obj.width, H = obj.height, wrap = obj.wrap;
  if (!isInt(W) || W < 2 || W > 256) errors.push({ line: 0, msg: 'width 须为 2..256 的整数' });
  if (!isInt(H) || H < 2 || H > 256) errors.push({ line: 0, msg: 'height 须为 2..256 的整数' });
  if (!Array.isArray(wrap) || wrap.length !== 2 || typeof wrap[0] !== 'boolean' || typeof wrap[1] !== 'boolean') {
    errors.push({ line: 0, msg: 'wrap 须为 [横向, 纵向] 两个布尔值' });
  }
  if (errors.length) return { errors };
  const N = W * H;

  const mass0 = new Float64Array(N);
  const wall0 = new Uint8Array(N);
  const w0 = new Uint16Array(4 * N);
  const cells = obj.cells === undefined ? [] : obj.cells;
  if (!Array.isArray(cells)) return { errors: [{ line: 0, msg: 'cells 须为数组' }] };
  const seen = new Set();
  let total = 0;
  for (let idx = 0; idx < cells.length; idx++) {
    const line = idx + 1, c = cells[idx];
    if (!c || typeof c !== 'object') { errors.push({ line, msg: 'cells 第 ' + line + ' 条须为对象' }); continue; }
    if (!isInt(c.i) || c.i < 0 || c.i >= N) { errors.push({ line, msg: 'cells 第 ' + line + ' 条：编号 i 越界' }); continue; }
    if (seen.has(c.i)) { errors.push({ line, msg: 'cells 第 ' + line + ' 条：编号 ' + c.i + ' 重复定义' }); continue; }
    seen.add(c.i);
    const mass = c.mass === undefined ? 0 : c.mass;
    if (!isInt(mass) || mass < 0) { errors.push({ line, msg: 'cells 第 ' + line + ' 条：mass 须为非负整数' }); continue; }
    const wall = c.wall === undefined ? false : c.wall;
    if (typeof wall !== 'boolean') { errors.push({ line, msg: 'cells 第 ' + line + ' 条：wall 须为布尔值' }); continue; }
    const w = c.w === undefined ? [0, 0, 0, 0] : c.w;
    const ew = validateW(w);
    if (ew) { errors.push({ line, msg: 'cells 第 ' + line + ' 条：' + ew }); continue; }
    mass0[c.i] = mass; wall0[c.i] = wall ? 1 : 0; w0.set(w, c.i * 4); total += mass;
  }
  if (total > MAX_TOTAL) errors.push({ line: 0, msg: '总质量超过 2^40' });

  const events = obj.events === undefined ? [] : obj.events;
  if (!Array.isArray(events)) return { errors: [{ line: 0, msg: 'events 须为数组' }] };
  const evs = [];
  let maxEventStep = -1;
  for (let idx = 0; idx < events.length; idx++) {
    const line = idx + 1, e = events[idx];
    if (!e || typeof e !== 'object') { errors.push({ line, msg: 'events 第 ' + line + ' 条须为对象' }); continue; }
    if (!isInt(e.step) || e.step < 0) { errors.push({ line, msg: 'events 第 ' + line + ' 条：step 须为非负整数' }); continue; }
    if (!isInt(e.i) || e.i < 0 || e.i >= N) { errors.push({ line, msg: 'events 第 ' + line + ' 条：编号 i 越界' }); continue; }
    const hasWall = e.wall !== undefined, hasW = e.w !== undefined;
    if (!hasWall && !hasW) { errors.push({ line, msg: 'events 第 ' + line + ' 条：须含 wall 或 w' }); continue; }
    if (hasWall && typeof e.wall !== 'boolean') { errors.push({ line, msg: 'events 第 ' + line + ' 条：wall 须为布尔值' }); continue; }
    if (hasW) {
      const ew = validateW(e.w);
      if (ew) { errors.push({ line, msg: 'events 第 ' + line + ' 条：' + ew }); continue; }
    }
    evs.push({ seq: idx, step: e.step, i: e.i, wall: hasWall ? e.wall : undefined, w: hasW ? e.w.slice() : undefined });
    if (e.step > maxEventStep) maxEventStep = e.step;
  }
  if (errors.length) return { errors };
  return {
    model: {
      width: W, height: H, wrapH: wrap[0], wrapV: wrap[1], N,
      mass0, wall0, w0, events: evs, maxEventStep,
    },
  };
}

/* 由模型与事件表创建模拟器。事件表可被 setEvents 替换（用于撤销/重做与历史修改）。 */
function createSim(model, events) {
  const W = model.width, H = model.height, N = model.N;

  // 预计算四方向邻居编号（-1 表示越界封堵），顺序与 w 一致：左、右、上、下
  const nd = new Int32Array(4 * N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, b = 4 * i;
      nd[b]     = x > 0     ? i - 1 : (model.wrapH ? i + W - 1 : -1);
      nd[b + 1] = x < W - 1 ? i + 1 : (model.wrapH ? i - W + 1 : -1);
      nd[b + 2] = y > 0     ? i - W : (model.wrapV ? i + W * (H - 1) : -1);
      nd[b + 3] = y < H - 1 ? i + W : (model.wrapV ? i - W * (H - 1) : -1);
    }
  }

  let evs = [], evSteps = [], evPtr = 0, evVersion = 0;
  function setEventList(list) {
    evs = list.slice().sort((a, b) => a.step - b.step || a.seq - b.seq);
    evSteps = evs.map(e => e.step);
    evVersion++;
  }
  setEventList(events);

  const state = { step: 0, mass: model.mass0.slice(), wall: model.wall0.slice(), w: model.w0.slice() };
  let nextBuf = new Float64Array(N);
  const snapshots = new Map();
  snapshots.set(0, snap());

  function snap() {
    return { step: state.step, mass: state.mass.slice(), wall: state.wall.slice(), w: state.w.slice() };
  }
  function lowerBound(v) {
    let lo = 0, hi = evSteps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (evSteps[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }
  function applyEvents() {
    const s = state.step;
    while (evPtr < evs.length && evs[evPtr].step === s) {
      const e = evs[evPtr++];
      if (e.wall !== undefined) state.wall[e.i] = e.wall ? 1 : 0;
      if (e.w) state.w.set(e.w, e.i * 4);
    }
  }

  // 出流暂存
  const cd = new Int32Array(5), cs = new Int32Array(5);
  const amt = new Float64Array(5), rr = new Float64Array(5);

  function advect() {
    const mass = state.mass, wall = state.wall, w = state.w, next = nextBuf;
    next.set(mass);
    for (let src = 0; src < N; src++) {
      const m = mass[src];
      if (m === 0 || wall[src]) continue;
      const b = src * 4;
      const wl = w[b], wr = w[b + 1], wu = w[b + 2], wd = w[b + 3];
      const sum = wl + wr + wu + wd;
      if (sum === 0) continue;
      let cn = 0;
      const stay = DEN - sum;
      if (stay > 0) { cd[0] = src; cs[0] = stay; cn = 1; }
      if (wl > 0) {
        let d = nd[b]; if (d < 0) d = src; else if (wall[d]) d = src;
        let k = 0; while (k < cn && cd[k] !== d) k++;
        if (k < cn) cs[k] += wl; else { cd[cn] = d; cs[cn] = wl; cn++; }
      }
      if (wr > 0) {
        let d = nd[b + 1]; if (d < 0) d = src; else if (wall[d]) d = src;
        let k = 0; while (k < cn && cd[k] !== d) k++;
        if (k < cn) cs[k] += wr; else { cd[cn] = d; cs[cn] = wr; cn++; }
      }
      if (wu > 0) {
        let d = nd[b + 2]; if (d < 0) d = src; else if (wall[d]) d = src;
        let k = 0; while (k < cn && cd[k] !== d) k++;
        if (k < cn) cs[k] += wu; else { cd[cn] = d; cs[cn] = wu; cn++; }
      }
      if (wd > 0) {
        let d = nd[b + 3]; if (d < 0) d = src; else if (wall[d]) d = src;
        let k = 0; while (k < cn && cd[k] !== d) k++;
        if (k < cn) cs[k] += wd; else { cd[cn] = d; cs[cn] = wd; cn++; }
      }
      if (cn === 1) { // 全部留在本格或整体迁往唯一目的地，无需取整
        if (cd[0] !== src) { next[src] -= m; next[cd[0]] += m; }
        continue;
      }
      let rem = m;
      for (let k = 0; k < cn; k++) {
        const prod = m * cs[k];
        const f = Math.floor(prod / DEN);
        amt[k] = f; rem -= f; rr[k] = prod - f * DEN;
      }
      for (let j = 0; j < rem; j++) {
        let best = -1;
        for (let k = 0; k < cn; k++) {
          if (rr[k] < 0) continue;
          if (best < 0 || rr[k] > rr[best] || (rr[k] === rr[best] && cd[k] < cd[best])) best = k;
        }
        amt[best]++; rr[best] = -1;
      }
      next[src] -= m;
      for (let k = 0; k < cn; k++) next[cd[k]] += amt[k];
    }
    nextBuf = state.mass;
    state.mass = next;
  }

  function stepOnce() {
    applyEvents();
    advect();
    state.step++;
    effCache = null;
    if (state.step % SNAP === 0) snapshots.set(state.step, snap());
  }

  /* 当前步事件生效后的墙/出流视图（帧 f → f+1 的输运以此为据），按帧缓存 */
  let effCache = null;
  function effective() {
    if (effCache && effCache.step === state.step && effCache.ver === evVersion) return effCache;
    const wall = state.wall.slice(), w = state.w.slice();
    let p = lowerBound(state.step);
    while (p < evs.length && evs[p].step === state.step) {
      const e = evs[p++];
      if (e.wall !== undefined) wall[e.i] = e.wall ? 1 : 0;
      if (e.w) w.set(e.w, e.i * 4);
    }
    effCache = { step: state.step, ver: evVersion, wall, w };
    return effCache;
  }

  function nearestSnapshotStep(f) {
    let best = 0;
    for (const k of snapshots.keys()) if (k <= f && k > best) best = k;
    return best;
  }

  const sim = {
    state,
    get totalStepsHint() { return evs.length ? evs[evs.length - 1].step + 1 : 0; },

    stepOnce,

    snapshotSteps() { return [...snapshots.keys()].sort((a, b) => a - b); },

    restoreSnapshot(step) {
      const s = snapshots.get(step);
      if (!s) return false;
      state.step = s.step;
      state.mass = s.mass.slice();
      state.wall = s.wall.slice();
      state.w = s.w.slice();
      evPtr = lowerBound(state.step);
      effCache = null;
      return true;
    },

    /* 跳到不早于 f 的最近快照，准备向前重算 */
    rewindTo(f) {
      const s = nearestSnapshotStep(f);
      this.restoreSnapshot(s);
    },

    /* 替换事件表；affectedStep 为最早受影响的步号，其后的快照与游标缓存全部作废 */
    setEvents(list, affectedStep) {
      setEventList(list);
      effCache = null;
      for (const k of [...snapshots.keys()]) if (k > affectedStep) snapshots.delete(k);
      if (state.step > affectedStep) this.restoreSnapshot(nearestSnapshotStep(affectedStep));
      evPtr = lowerBound(state.step);
    },

    totalMass() {
      let t = 0;
      for (let i = 0; i < N; i++) t += state.mass[i];
      return t;
    },

    /* 单格出流分配明细（本帧 → 下一帧的输运，含本步事件生效后的墙/出流） */
    allocDetail(src) {
      const m = state.mass[src];
      const eff = effective();
      const wall = eff.wall, w = eff.w;
      const b = src * 4;
      const names = ['左', '右', '上', '下'];
      if (wall[src]) return { frozen: true, m, dirs: [], list: [] };
      const ws = [w[b], w[b + 1], w[b + 2], w[b + 3]];
      const sum = ws[0] + ws[1] + ws[2] + ws[3];
      const md = [], ms = [];
      const push = (d, s) => {
        const k = md.indexOf(d);
        if (k >= 0) ms[k] += s; else { md.push(d); ms.push(s); }
      };
      const dirs = [];
      for (let d = 0; d < 4; d++) {
        const wd = ws[d];
        let dest = null, note = '';
        if (wd > 0) {
          const nb = nd[b + d];
          if (nb < 0) { dest = src; note = '越界封堵，退回本格'; }
          else if (wall[nb]) { dest = src; note = '目的为墙，退回本格'; }
          else dest = nb;
          push(dest, wd);
        }
        dirs.push({ name: names[d], w: wd, dest, note });
      }
      const stay = DEN - sum;
      if (stay > 0) push(src, stay);
      const list = [];
      let rem = m;
      for (let k = 0; k < md.length; k++) {
        const prod = m * ms[k];
        const f = Math.floor(prod / DEN);
        list.push({ dest: md[k], share: ms[k], exact: prod / DEN, floor: f, remNum: prod - f * DEN, bonus: 0, amount: f });
        rem -= f;
      }
      for (let j = 0; j < rem; j++) {
        let best = -1;
        for (let k = 0; k < list.length; k++) {
          if (list[k].bonus) continue;
          if (best < 0 || list[k].remNum > list[best].remNum ||
              (list[k].remNum === list[best].remNum && list[k].dest < list[best].dest)) best = k;
        }
        list[best].bonus = 1; list[best].amount++;
      }
      return { frozen: false, m, stay, dirs, list };
    },

    /* 单格进流明细：邻居（含绕回）实际送入本格的量，以及本格自留/退回 */
    inflowDetail(src) {
      const eff = effective();
      if (eff.wall[src]) return { frozen: true, in: [] };
      const result = [];
      const self = this.allocDetail(src);
      for (const e of self.list) {
        if (e.dest === src && e.amount > 0) result.push({ from: src, self: true, share: e.share, amount: e.amount });
      }
      const seen = new Set([src]);
      const b = src * 4;
      for (let d = 0; d < 4; d++) {
        const nb = nd[b + d];
        if (nb < 0 || seen.has(nb)) continue;
        seen.add(nb);
        if (eff.wall[nb]) continue;
        const a = this.allocDetail(nb);
        for (const e of a.list) {
          if (e.dest === src && e.amount > 0) result.push({ from: nb, self: false, share: e.share, amount: e.amount });
        }
      }
      return { frozen: false, in: result };
    },
  };
  return sim;
}

const api = { parseModel, createSim, DEN, MAX_TOTAL };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.InkSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
