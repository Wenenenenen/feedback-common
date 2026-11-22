/* 支撑场承重引擎：精确分数载荷计算 + 逐轮失稳模拟。
 * 浏览器里挂到 window.Engine，Node 里 module.exports，便于测试。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 精确分数（BigInt 分子分母，永远约分） ---------- */
  function bgcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) { const t = a % b; a = b; b = t; }
    return a === 0n ? 1n : a;
  }

  class Fr {
    constructor(n, d) {
      n = BigInt(n); d = d === undefined ? 1n : BigInt(d);
      if (d === 0n) throw new Error('分母为 0');
      if (d < 0n) { n = -n; d = -d; }
      const g = bgcd(n, d);
      this.n = n / g; this.d = d / g;
    }
    static of(v) { return v instanceof Fr ? v : new Fr(v); }
    add(o) { o = Fr.of(o); return new Fr(this.n * o.d + o.n * this.d, this.d * o.d); }
    mul(o) { o = Fr.of(o); return new Fr(this.n * o.n, this.d * o.d); }
    div(o) { o = Fr.of(o); return new Fr(this.n * o.d, this.d * o.n); }
    cmp(o) { o = Fr.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
    gt(o) { return this.cmp(o) > 0; }
    toString() { return this.d === 1n ? this.n.toString() : this.n + '/' + this.d; }
  }

  /* ---------- 板件规范化 ----------
   * 内部表示：{id, x, y, z, w, l, weight, cap}，均为整数，w/l >= 1。 */
  function normalizeSlab(s) {
    return {
      id: String(s.id),
      x: s.x | 0, y: s.y | 0, z: s.z | 0,
      w: s.w | 0, l: s.l | 0,
      weight: s.weight | 0, cap: s.cap | 0,
    };
  }

  function fromSampleFormat(s) {
    return normalizeSlab({
      id: s.id,
      x: s.footprint[0], y: s.footprint[1], z: s.footprint[2],
      w: s.footprint[3], l: s.footprint[4],
      weight: s.load[0], cap: s.load[1],
    });
  }

  function toSampleFormat(s) {
    return { id: s.id, footprint: [s.x, s.y, s.z, s.w, s.l], load: [s.weight, s.cap] };
  }

  function overlap1D(a0, a1, b0, b1) { return Math.min(a1, b1) > Math.max(a0, b0); }

  /* s 是否直接支撑 t：t 恰好在 s 正上方一层，且水平投影有重叠（面积大小无关）。 */
  function directlySupports(s, t) {
    return s.z === t.z - 1 &&
      overlap1D(s.x, s.x + s.w, t.x, t.x + t.w) &&
      overlap1D(s.y, s.y + s.l, t.y, t.y + t.l);
  }

  /* 同层板件是否重叠（不允许）。 */
  function slabsCollide(a, b) {
    return a.z === b.z &&
      overlap1D(a.x, a.x + a.w, b.x, b.x + b.w) &&
      overlap1D(a.y, a.y + a.l, b.y, b.y + b.l);
  }

  /* ---------- 单轮载荷计算 ----------
   * 返回 {
   *   loads:      Map id -> Fr   总载荷 = 自重 + 收到的载荷
   *   supporters: Map id -> [id] 直接支撑它的板件（下一层）
   *   incoming:   Map id -> [{from, amount:Fr}]  载荷来源（上一层谁传了多少）
   *   outgoing:   Map id -> [{to, amount:Fr}]    载荷去向（均分给支撑者）
   * } */
  function computeLoads(slabs) {
    const received = new Map();
    const incoming = new Map();
    const outgoing = new Map();
    const supporters = new Map();
    for (const s of slabs) {
      received.set(s.id, new Fr(0));
      incoming.set(s.id, []);
      outgoing.set(s.id, []);
      supporters.set(s.id, []);
    }
    for (const t of slabs) {
      for (const s of slabs) {
        if (s !== t && directlySupports(s, t)) supporters.get(t.id).push(s.id);
      }
      supporters.get(t.id).sort();
    }
    // 自上而下：每块的总载荷确定后，均分给它的直接支撑者。
    const order = [...slabs].sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : 1));
    const loads = new Map();
    for (const s of order) {
      const total = new Fr(s.weight).add(received.get(s.id));
      loads.set(s.id, total);
      const sup = supporters.get(s.id);
      if (sup.length) {
        const share = total.div(new Fr(sup.length));
        for (const id of sup) {
          received.set(id, received.get(id).add(share));
          incoming.get(id).push({ from: s.id, amount: share });
          outgoing.get(s.id).push({ to: id, amount: share });
        }
      }
    }
    return { loads, supporters, incoming, outgoing };
  }

  /* ---------- 逐轮失稳模拟 ----------
   * 每轮用同一份布局算载荷，超载（载荷 > 承重上限，严格大于）与
   * 没有直接支撑的非底层板件一并移除，再算下一轮，直到稳定。
   * 返回 {
   *   initialLoads: {id: "n/d"},   首轮（当前布局）载荷
   *   waves: [{round, overload:[id], unsupported:[id], loads:{id:"n/d"}}],
   *   survivors: [slab],           最终留下的板件（规范化副本）
   *   finalLoads: {id: "n/d"},     稳定后的载荷
   * } */
  function simulate(inputSlabs) {
    let current = inputSlabs.map(normalizeSlab);
    const waves = [];
    let res = computeLoads(current);
    const initialLoads = {};
    for (const s of current) initialLoads[s.id] = res.loads.get(s.id).toString();
    let finalLoads = initialLoads;
    while (current.length) {
      res = computeLoads(current);
      const overload = [];
      const unsupported = [];
      for (const s of current) {
        if (res.loads.get(s.id).gt(new Fr(s.cap))) overload.push(s.id);
        else if (s.z > 0 && res.supporters.get(s.id).length === 0) unsupported.push(s.id);
      }
      overload.sort(); unsupported.sort();
      if (!overload.length && !unsupported.length) {
        finalLoads = {};
        for (const s of current) finalLoads[s.id] = res.loads.get(s.id).toString();
        break;
      }
      const loads = {};
      for (const s of current) loads[s.id] = res.loads.get(s.id).toString();
      waves.push({ round: waves.length + 1, overload, unsupported, loads });
      const removed = new Set([...overload, ...unsupported]);
      current = current.filter(s => !removed.has(s.id));
    }
    return { initialLoads, waves, survivors: current, finalLoads };
  }

  return { Fr, normalizeSlab, fromSampleFormat, toSampleFormat, directlySupports, slabsCollide, computeLoads, simulate };
});
