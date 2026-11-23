/*
 * factory-bus 时序内核（纯手写，禁用任何电路仿真库）
 *
 * 四值逻辑，两位编码（每条 16 位以内的总线压成一个整数，位运算逐位并行）：
 *   Z = 00 (0)  高阻/无驱动
 *   X = 01 (1)  冲突或未知
 *   0 = 10 (2)  逻辑低
 *   1 = 11 (3)  逻辑高
 * 整数的 bit b：lo 平面存低位，hi 平面存高位。
 *
 * 同文件可在浏览器（window.FactoryBus）与 Node（module.exports）中使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FactoryBus = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 四值常量 ----
  const Z = 0, X = 1, L = 2, H = 3;
  const CHAR_TO_VAL = { '0': L, '1': H, X: X, Z: Z, x: X, z: Z };
  const VAL_TO_CHAR = [ 'Z', 'X', '0', '1' ];

  const OPS = { NOT: 'NOT', AND: 'AND', OR: 'OR', TRI: 'TRI', DFF: 'DFF' };
  const COMB_OPS = new Set([ 'NOT', 'AND', 'OR', 'TRI' ]);

  const maskOf = (w) => (1 << w) - 1;

  /** 四值串（高位在左，首字符为最高位）-> {lo, hi} */
  function parseValue(str, w) {
    let lo = 0, hi = 0;
    for (let j = 0; j < w; j++) {
      const v = CHAR_TO_VAL[str[j]];
      const shift = w - 1 - j; // 首字符落到最高位
      if (v & 1) lo |= 1 << shift;
      if (v & 2) hi |= 1 << shift;
    }
    return { lo, hi };
  }

  /** {lo, hi} -> 四值串（高位在左） */
  function formatValue(lo, hi, w) {
    let out = '';
    for (let j = 0; j < w; j++) {
      const bit = w - 1 - j;
      const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      out += VAL_TO_CHAR[v];
    }
    return out;
  }

  // ---- 最小堆（时刻用，纯数组，零依赖）----
  function MinHeap() { this.a = []; }
  MinHeap.prototype.push = function (x) {
    const a = this.a;
    let i = a.length;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= x) break;
      a[i] = a[p]; i = p;
    }
    a[i] = x;
  };
  MinHeap.prototype.pop = function () {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= a.length) break;
        const r = l + 1;
        let m = l;
        if (r < a.length && a[r] < a[l]) m = r;
        if (last <= a[m]) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  };

  /**
   * 校验模型。返回 errors 数组，空数组即合法。
   * 坏连接必须指出门号；与具体门无关的问题 gateId 为 null。
   */
  function validateModel(m) {
    const errors = [];
    const err = (gateId, message) => errors.push({ gateId: gateId == null ? null : String(gateId), message });

    if (!m || typeof m !== 'object') { err(null, '模型不是对象'); return errors; }
    if (!Number.isInteger(m.until) || m.until < 0) err(null, 'until 必须为非负整数');
    if (!m.nets || typeof m.nets !== 'object') { err(null, '缺少 nets 线网宽度表'); return errors; }

    const netIdx = new Map();
    let ni = 0;
    for (const [name, w] of Object.entries(m.nets)) {
      if (!Number.isInteger(w) || w <= 0 || w > 16) { err(null, `线网 ${name} 宽度非法（需 1..16 的整数）`); continue; }
      netIdx.set(name, ni++);
    }
    const netNames = [ ...netIdx.keys() ];
    const netW = netNames.map(n => m.nets[n]);

    if (!m.ports || typeof m.ports !== 'object') err(null, '缺少 ports 端口表');
    const portNet = new Map();
    if (m.ports) for (const [p, netName] of Object.entries(m.ports)) {
      if (!netIdx.has(netName)) { err(null, `端口 ${p} 指向不存在的线网 ${netName}`); continue; }
      portNet.set(p, netIdx.get(netName));
    }

    const gateIds = new Set();
    const gateList = Array.isArray(m.gates) ? m.gates : [];
    if (!Array.isArray(m.gates)) err(null, 'gates 必须为数组');
    gateList.forEach((g, gi) => {
      const tag = g && g.id != null ? String(g.id) : `#${gi}`;
      if (!g || typeof g !== 'object') return err(tag, '门不是对象');
      if (g.id == null) err(tag, '门缺少 id');
      else if (gateIds.has(g.id)) err(tag, `门 id 重复：${g.id}`);
      else gateIds.add(g.id);
      if (!OPS[g.op]) return err(tag, `未知门类型 op=${g.op}`);
      if (!Number.isInteger(g.delay) || g.delay <= 0) return err(tag, 'delay 必须为正整数');
      if (!Array.isArray(g.in) || !g.in.length) return err(tag, 'in 输入线网数组为空');
      for (const n of g.in) if (!netIdx.has(n)) err(tag, `输入线网 ${n} 不存在`);
      if (!netIdx.has(g.out)) { err(tag, `输出线网 ${g.out} 不存在`); return; }

      const wOut = netW[netIdx.get(g.out)];
      const widthOf = (n) => netW[netIdx.get(n)];
      if (g.op === 'NOT') {
        if (g.in.length !== 1) err(tag, 'NOT 只能有 1 个输入');
        else if (widthOf(g.in[0]) !== wOut) err(tag, `NOT 输入位宽 ${widthOf(g.in[0])} 与输出位宽 ${wOut} 不一致`);
      } else if (g.op === 'AND' || g.op === 'OR') {
        if (g.in.length < 2) err(tag, `${g.op} 至少需要 2 个输入`);
        for (const n of g.in) if (widthOf(n) !== wOut) err(tag, `${g.op} 输入 ${n} 位宽 ${widthOf(n)} 与输出位宽 ${wOut} 不一致`);
      } else { // TRI / DFF：数据 + 1 位控制
        if (g.in.length !== 2) err(tag, `${g.op} 需要恰好 2 个输入（数据, 控制）`);
        else {
          if (widthOf(g.in[0]) !== wOut) err(tag, `${g.op} 数据位宽 ${widthOf(g.in[0])} 与输出位宽 ${wOut} 不一致`);
          if (widthOf(g.in[1]) !== 1) err(tag, `${g.op} 控制位 ${g.in[1]} 必须为 1 位`);
        }
      }
    });

    if (!Array.isArray(m.writes)) err(null, 'writes 必须为数组');
    else m.writes.forEach((wr, i) => {
      if (!Array.isArray(wr) || wr.length !== 3) return err(null, `writes[${i}] 应为 [时刻, 端口, 四值串]`);
      const [t, p, s] = wr;
      if (!Number.isInteger(t) || t < 0) return err(null, `writes[${i}] 时刻非法：${t}`);
      if (!portNet.has(p)) return err(null, `writes[${i}] 端口不存在：${p}`);
      const w = netW[portNet.get(p)];
      if (typeof s !== 'string' || s.length !== w) return err(null, `writes[${i}] 值 "${s}" 长度需为端口 ${p} 的位宽 ${w}`);
      for (const c of s) if (!(c in CHAR_TO_VAL)) return err(null, `writes[${i}] 值 "${s}" 含非法字符（只允许 0/1/X/Z）`);
    });

    return errors;
  }

  /** 编译模型为平面结构。假设已通过 validateModel。 */
  function compile(m) {
    const netNames = Object.keys(m.nets);
    const netIdx = new Map(netNames.map((n, i) => [n, i]));
    const netW = netNames.map(n => m.nets[n]);
    const N = netNames.length;

    // 驱动：每个外部端口一个、每个门输出一个
    const drivers = [];
    const driverOfPort = new Map();
    for (const [p, netName] of Object.entries(m.ports)) {
      driverOfPort.set(p, drivers.length);
      drivers.push({ kind: 'port', ref: String(p), net: netIdx.get(netName), w: m.nets[netName] });
    }
    const driverOfGate = new Map();
    for (const g of m.gates) {
      driverOfGate.set(g.id, drivers.length);
      drivers.push({ kind: 'gate', ref: String(g.id), net: netIdx.get(g.out), w: m.nets[g.out] });
    }
    const D = drivers.length;

    const netDrivers = Array.from({ length: N }, () => []);
    drivers.forEach((d, id) => netDrivers[d.net].push(id));

    const gates = m.gates.map((g, gi) => ({
      idx: gi,
      id: String(g.id),
      op: g.op,
      comb: COMB_OPS.has(g.op),
      inNets: g.in.map(n => netIdx.get(n)),
      outNet: netIdx.get(g.out),
      outDriver: driverOfGate.get(g.id),
      delay: g.delay,
      w: m.nets[g.out],
      mask: maskOf(m.nets[g.out]),
      pendExp: COMB_OPS.has(g.op) ? new Int32Array(m.nets[g.out]).fill(-1) : null,
      pendLo: 0, pendHi: 0,
      prevClk: Z, stateLo: 0, stateHi: 0, // DFF 内部状态
    }));

    const netReaders = Array.from({ length: N }, () => []);
    gates.forEach(g => g.inNets.forEach(n => netReaders[n].push(g.idx)));

    // 写入按时刻排序；同刻同端口后项覆盖，编译期合并为该刻最终值（中间值不进驱动历史）
    const sortedWrites = m.writes
      .filter(wr => wr[0] <= m.until)
      .slice()
      .sort((a, b) => a[0] - b[0]);
    const writeTimes = [];
    const writeGroups = [];
    let lastTime = -1;
    let portFinal = new Map();
    const flush = () => {
      if (portFinal.size === 0) return;
      writeTimes.push(lastTime);
      writeGroups.push([...portFinal.values()]);
      portFinal = new Map();
    };
    for (const wr of sortedWrites) {
      const t = wr[0];
      if (t !== lastTime) { flush(); lastTime = t; }
      const net = netIdx.get(m.ports[wr[1]]);
      const { lo, hi } = parseValue(wr[2], m.nets[m.ports[wr[1]]]);
      portFinal.set(driverOfPort.get(wr[1]), { driver: driverOfPort.get(wr[1]), net, lo, hi });
    }
    flush();

    return {
      until: m.until, netNames, netW, N, drivers, D, netDrivers,
      gates, netReaders, writeTimes, writeGroups,
    };
  }

  // ---- 组合逻辑：返回 {lo, hi}，宽度均为门输出宽度 ----
  function evalComb(g, netLo, netHi) {
    const mask = g.mask;
    if (g.op === 'NOT') {
      const lo = netLo[g.inNets[0]], hi = netHi[g.inNets[0]];
      // 真值表：Z->X, X->X, 0->1, 1->0；即 out_hi=hi，out_lo=~(lo&hi)
      return { lo: (~(lo & hi)) & mask, hi };
    }
    if (g.op === 'AND') {
      let anyL = 0, allH = mask;
      for (const n of g.inNets) {
        const lo = netLo[n], hi = netHi[n];
        anyL |= hi & ~lo;
        allH &= hi & lo;
      }
      return { lo: ~anyL & mask, hi: anyL | allH };
    }
    if (g.op === 'OR') {
      let anyH = 0, allL = mask;
      for (const n of g.inNets) {
        const lo = netLo[n], hi = netHi[n];
        anyH |= hi & lo;
        allL &= hi & ~lo;
      }
      return { lo: ~allL & mask, hi: anyH | allL };
    }
    // TRI：in0 数据，in1 一位使能。使能0出Z，1透传（含Z），X/Z出X
    const dLo = netLo[g.inNets[0]], dHi = netHi[g.inNets[0]];
    const eHi = netHi[g.inNets[1]] & 1;
    const pass = eHi ? mask : 0;          // 使能 1：逐位透传数据
    const bad = eHi ? 0 : mask;            // 使能 X 或 Z：输出 X
    return { lo: (pass & dLo) | bad, hi: pass & dHi };
  }

  /**
   * 跑完整仿真。opts.onProgress(done) 可选。
   * 时间推进：外部写入时刻（已排序）与门事件堆归并，空档零开销。
   * 每时刻顺序：一起应用外部写入与已到期驱动 -> 解算脏线网 -> 读门 -> 记变值。
   */
  function run(model, opts = {}) {
    const errors = validateModel(model);
    if (errors.length) return { ok: false, errors };

    const c = compile(model);
    const {
      until, N, D, gates, netDrivers, netReaders,
      writeTimes, writeGroups,
    } = c;
    const G = gates.length;

    const dLo = new Uint32Array(D), dHi = new Uint32Array(D);   // 驱动当前值，初态全 Z
    const netLo = new Uint32Array(N), netHi = new Uint32Array(N);

    const wave = c.netNames.map((name, i) => ({ name, width: c.netW[i], times: [], lo: [], hi: [] }));
    const dHist = Array.from({ length: D }, () => ({ times: [], lo: [], hi: [] }));

    // 全局事件表：每个调度事件唯一 id，内容不可变；时刻桶只存事件 id。
    // 组合门逐位事件：{t, kind:'c', gate, bit, val}，触发时用 pendExp 判陈旧
    // DFF 整向量事件：{t, kind:'d', gate, lo, hi}（传输队列，天然有序）
    const eventTable = [];
    const buckets = new Map(); // time -> 事件 id 数组
    const eventHeap = new MinHeap();
    const heapTimes = new Set();
    const pushEvent = (evt) => {
      const id = eventTable.length;
      eventTable.push(evt);
      let arr = buckets.get(evt.t);
      if (!arr) { arr = []; buckets.set(evt.t, arr); }
      arr.push(id);
      if (!heapTimes.has(evt.t)) { heapTimes.add(evt.t); eventHeap.push(evt.t); }
    };
    const scheduleComb = (t, gate, bit, val) => {
      if (t <= until) pushEvent({ t, kind: 'c', gate: gate.idx, bit, val });
    };
    const scheduleDff = (t, gate, lo, hi) => {
      if (t <= until) pushEvent({ t, kind: 'd', gate: gate.idx, lo, hi });
    };

    const resolveNet = (n) => {
      let xAny = 0, hAny = 0, lAny = 0;
      const list = netDrivers[n];
      for (let k = 0; k < list.length; k++) {
        const id = list[k];
        const lo = dLo[id], hi = dHi[id];
        xAny |= lo & ~hi;
        hAny |= hi & lo;
        lAny |= hi & ~lo;
      }
      const conflict = hAny & lAny;
      // lo 平面：X 驱动、高低冲突，或确定的高电平（11 的低位为 1）
      return { lo: (xAny | conflict | hAny) >>> 0, hi: (~xAny & ~conflict) & (hAny | lAny) };
    };

    const recordDriver = (id, t, lo, hi) => {
      const h = dHist[id];
      const last = h.times.length - 1;
      if (last < 0 || h.lo[last] !== lo || h.hi[last] !== hi) {
        h.times.push(t); h.lo.push(lo); h.hi.push(hi);
      }
    };
    const recordNet = (n, t, lo, hi) => {
      const wf = wave[n];
      const last = wf.times.length - 1;
      if (last < 0 || wf.lo[last] !== lo || wf.hi[last] !== hi) {
        wf.times.push(t); wf.lo.push(lo); wf.hi.push(hi);
      }
    };

    // 组合门：逐位惯性延迟排队（同目标保期、异目标替换、回当前值撤销）
    const evalCombGate = (g, t) => {
      const out = evalComb(g, netLo, netHi);
      const drv = g.outDriver, curLo = dLo[drv], curHi = dHi[drv];
      for (let bit = 0; bit < g.w; bit++) {
        const bm = 1 << bit;
        const target = ((out.hi & bm) ? 2 : 0) | ((out.lo & bm) ? 1 : 0);
        const cur = ((curHi & bm) ? 2 : 0) | ((curLo & bm) ? 1 : 0);
        if (target === cur) { g.pendExp[bit] = -1; continue; }
        if (g.pendExp[bit] < 0) {
          const exp = t + g.delay;
          g.pendExp[bit] = exp;
          if (out.lo & bm) g.pendLo |= bm; else g.pendLo &= ~bm;
          if (out.hi & bm) g.pendHi |= bm; else g.pendHi &= ~bm;
          scheduleComb(exp, g, bit, target);
        } else {
          const pVal = ((g.pendHi & bm) ? 2 : 0) | ((g.pendLo & bm) ? 1 : 0);
          if (pVal === target) continue;
          const exp = t + g.delay;
          g.pendExp[bit] = exp;
          if (out.lo & bm) g.pendLo |= bm; else g.pendLo &= ~bm;
          if (out.hi & bm) g.pendHi |= bm; else g.pendHi &= ~bm;
          scheduleComb(exp, g, bit, target);
        }
      }
    };

    // DFF：只认最终时钟 0->1，采当刻最终数据，Z 输入按 X；传输延迟保留每次采样
    const evalDffGate = (g, t) => {
      const clkNet = g.inNets[1], dataNet = g.inNets[0];
      const clk = (((netHi[clkNet] & 1) << 1) | (netLo[clkNet] & 1));
      if (g.prevClk === L && clk === H) {
        const rawLo = netLo[dataNet] & g.mask, rawHi = netHi[dataNet] & g.mask;
        // 采样数据中的 Z(00) 变 X(01)；X/0/1 原样
        const zBits = ~(rawLo | rawHi) & g.mask;
        scheduleDff(t + g.delay, g, rawLo | zBits, rawHi);
      }
      g.prevClk = clk;
    };

    const dirty = new Uint8Array(N);
    const driverDirty = new Uint8Array(D);
    const evalMark = new Uint8Array(G);
    const dirtyList = [];
    const driverDirtyList = [];
    const evalList = [];
    let evalStamp = 0;
    const processedTimes = [];
    let wi = 0;
    let steps = 0;

    const nextTime = () => {
      const tw = wi < writeTimes.length ? writeTimes[wi] : Infinity;
      const te = eventHeap.a.length ? eventHeap.a[0] : Infinity;
      return Math.min(tw, te);
    };

    let t = 0;
    while (t <= until) {
      processedTimes.push(t);
      steps++;
      evalStamp++;

      // 1) 一起应用外部写入
      if (wi < writeTimes.length && writeTimes[wi] === t) {
        const group = writeGroups[wi++];
        for (let k = 0; k < group.length; k++) {
          const wr = group[k];
          dLo[wr.driver] = wr.lo; dHi[wr.driver] = wr.hi;
          if (!dirty[wr.net]) { dirty[wr.net] = 1; dirtyList.push(wr.net); }
          if (!driverDirty[wr.driver]) { driverDirty[wr.driver] = 1; driverDirtyList.push(wr.driver); }
        }
      }

      // 2) 一起应用已到期门驱动事件（陈旧事件丢弃；同驱动多位事件合并记一次）
      if (heapTimes.has(t) && eventHeap.a[0] === t) {
        eventHeap.pop();
        heapTimes.delete(t);
        const ids = buckets.get(t);
        for (let k = 0; k < ids.length; k++) {
          const evt = eventTable[ids[k]];
          if (evt.kind === 'd') {
            const g = gates[evt.gate];
            const drv = g.outDriver;
            dLo[drv] = evt.lo; dHi[drv] = evt.hi;
            g.stateLo = evt.lo; g.stateHi = evt.hi;
            if (!dirty[g.outNet]) { dirty[g.outNet] = 1; dirtyList.push(g.outNet); }
            if (!driverDirty[drv]) { driverDirty[drv] = 1; driverDirtyList.push(drv); }
          } else {
            const g = gates[evt.gate];
            const bit = evt.bit, val = evt.val;
            if (g.pendExp[bit] !== t) continue; // 陈旧事件：已撤销或被替换
            const bm = 1 << bit;
            const pVal = ((g.pendHi & bm) ? 2 : 0) | ((g.pendLo & bm) ? 1 : 0);
            if (pVal !== val) continue;
            g.pendExp[bit] = -1;
            const drv = g.outDriver;
            if (val & 1) dLo[drv] |= bm; else dLo[drv] &= ~bm;
            if (val & 2) dHi[drv] |= bm; else dHi[drv] &= ~bm;
            if (!dirty[g.outNet]) { dirty[g.outNet] = 1; dirtyList.push(g.outNet); }
            if (!driverDirty[drv]) { driverDirty[drv] = 1; driverDirtyList.push(drv); }
          }
        }
        buckets.delete(t);
      }

      // 3) 解算脏线网（正延迟：驱动此刻不会再被门改动，单遍即终值）
      const changed = [];
      for (let k = 0; k < dirtyList.length; k++) {
        const n = dirtyList[k];
        dirty[n] = 0;
        const r = resolveNet(n);
        if (r.lo !== netLo[n] || r.hi !== netHi[n]) {
          netLo[n] = r.lo; netHi[n] = r.hi;
          changed.push(n);
        }
      }

      // 4) 读门：
      //   组合门 t=0 全量评估，之后仅在输入线网变化时评估；
      //   DFF 每个处理时刻都要评估（只认最终时钟 0->1，与数据是否变化无关）
      if (t === 0) {
        for (let gi = 0; gi < G; gi++) if (gates[gi].comb) evalList.push(gi);
      }
      for (let k = 0; k < changed.length; k++) {
        const readers = netReaders[changed[k]];
        for (let j = 0; j < readers.length; j++) {
          const gi = readers[j];
          if (evalMark[gi] !== evalStamp) { evalMark[gi] = evalStamp; evalList.push(gi); }
        }
      }
      for (let gi = 0; gi < G; gi++) {
        if (!gates[gi].comb && evalMark[gi] !== evalStamp) {
          evalMark[gi] = evalStamp; evalList.push(gi);
        }
      }
      for (let k = 0; k < evalList.length; k++) {
        const g = gates[evalList[k]];
        if (g.comb) evalCombGate(g, t);
        else evalDffGate(g, t);
      }

      // 5) 记录：t=0 建全部线网初态；之后只记实际变值的线网；驱动史按驱动合并
      if (t === 0) {
        for (let n = 0; n < N; n++) recordNet(n, 0, netLo[n], netHi[n]);
      } else {
        for (let k = 0; k < changed.length; k++) {
          const n = changed[k];
          recordNet(n, t, netLo[n], netHi[n]);
        }
      }
      for (let k = 0; k < driverDirtyList.length; k++) {
        const id = driverDirtyList[k];
        driverDirty[id] = 0;
        recordDriver(id, t, dLo[id], dHi[id]);
      }
      dirtyList.length = 0;
      driverDirtyList.length = 0;
      evalList.length = 0;

      if (opts.onProgress && (steps & 2047) === 0) {
        opts.onProgress(steps / Math.max(1, writeTimes.length));
      }

      const nt = nextTime();
      if (nt === Infinity) break;
      t = nt;
    }
    if (opts.onProgress) opts.onProgress(1);

    return {
      ok: true,
      compiled: c,
      wave,
      driverHist: dHist,
      driverInfo: c.drivers.map((d, id) => ({
        id, kind: d.kind, ref: d.ref, net: d.net, netName: c.netNames[d.net], width: d.w,
      })),
      netNames: c.netNames,
      netWidths: c.netW,
      times: processedTimes,
      until,
    };
  }

  /** 在变值记录中二分查找 t 时刻的值（值在记录时刻之间保持） */
  function valueAt(hist, t) {
    const ts = hist.times;
    let lo = 0, hi = ts.length - 1;
    if (hi < 0 || t < ts[0]) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return { lo: hist.lo[lo], hi: hist.hi[lo] };
  }

  /** 从头重演并与首次结果逐条比对，验证导出波形与重演一致 */
  function verifyReplay(model, firstResult) {
    const again = run(model);
    if (!again.ok) return { ok: false, reason: '重演校验失败：模型不再合法', errors: again.errors };
    if (again.wave.length !== firstResult.wave.length)
      return { ok: false, reason: '重演线网数不一致' };
    for (let i = 0; i < firstResult.wave.length; i++) {
      const a = firstResult.wave[i], b = again.wave[i];
      if (a.times.length !== b.times.length)
        return { ok: false, reason: `线网 ${a.name} 变值次数不一致` };
      for (let k = 0; k < a.times.length; k++) {
        if (a.times[k] !== b.times[k] || a.lo[k] !== b.lo[k] || a.hi[k] !== b.hi[k])
          return { ok: false, reason: `线网 ${a.name} 在时刻 ${a.times[k]} 重演结果不一致` };
      }
    }
    return { ok: true };
  }

  return {
    Z, X, L, H, OPS,
    parseValue, formatValue,
    validateModel, compile, run, valueAt, verifyReplay,
    evalComb,
  };
});
