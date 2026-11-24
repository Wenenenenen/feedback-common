/*
 * Cookfest 排程核心：规范化、精确搜索、逐拍账本与导入核验。
 * 同时支持浏览器全局 Cookfest 与 Node CommonJS，便于无构建测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Cookfest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_JOBS = 16;
  const MAX_STATIONS = 6;
  const MAX_INGREDIENTS = 6;
  const MAX_TOOLS = 4;
  const MAX_DEADLINE = 60;

  function isInt(v) {
    return typeof v === 'number' && Number.isSafeInteger(v);
  }

  function toInt(v) {
    if (isInt(v)) return v;
    if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
    return null;
  }

  function deepClone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function emptyCounts(n) {
    return new Array(n).fill(0);
  }

  function quantMap(input, errors, path) {
    const out = {};
    if (input == null) return out;
    if (typeof input !== 'object' || Array.isArray(input)) {
      errors.push(`${path} 必须是对象`);
      return out;
    }
    for (const [key, raw] of Object.entries(input)) {
      if (!key.trim()) continue;
      const n = toInt(raw);
      if (n === null || n < 0) {
        errors.push(`${path}.${key} 必须是非负整数`);
      } else if (n > 0) {
        out[key] = n;
      }
    }
    return out;
  }

  function normalizeInterval(raw, errors, path) {
    let a, b;
    if (Array.isArray(raw) && raw.length >= 2) {
      a = toInt(raw[0]);
      b = toInt(raw[1]);
    } else if (raw && typeof raw === 'object') {
      a = toInt(raw.from ?? raw.start ?? raw[0]);
      b = toInt(raw.to ?? raw.end ?? raw[1]);
    }
    if (a === null || b === null || a === undefined || b === undefined || a < 0 || b <= a) {
      errors.push(`${path} 必须是 0 <= 起点 < 终点 的半开区间`);
      return null;
    }
    return [a, b];
  }

  function normalizeLocks(rawLocks, jobs, jobById, errors) {
    const locks = {};
    const specs = new Map();
    if (rawLocks == null) return { locks, specs };

    const entries = [];
    if (Array.isArray(rawLocks)) {
      for (const item of rawLocks) {
        if (item && typeof item === 'object') entries.push([item.job ?? item.id, item]);
      }
    } else if (typeof rawLocks === 'object') {
      for (const [key, value] of Object.entries(rawLocks)) entries.push([key, value]);
    } else {
      errors.push('locks 必须是对象或数组');
      return { locks, specs };
    }

    for (const [rawId, rawValue] of entries) {
      const idKey = String(rawId);
      const job = jobById.get(idKey);
      if (!job) {
        errors.push(`locks 引用了不存在的工序 ${rawId}`);
        continue;
      }
      let startRaw = rawValue;
      let modeRaw;
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        startRaw = rawValue.start ?? rawValue.at ?? rawValue.tick ?? rawValue.begin;
        modeRaw = rawValue.mode ?? rawValue.modeId ?? rawValue.plan ?? rawValue.planId;
      }
      const start = toInt(startRaw);
      if (start === null || start < 0) {
        errors.push(`工序 ${job.id} 的锁定开工拍必须是非负整数`);
        continue;
      }
      locks[idKey] = start;
      let modeId = null;
      if (modeRaw !== undefined) {
        modeId = toInt(modeRaw);
        if (modeId === null || !job.modes.some((m) => m.id === modeId)) {
          errors.push(`工序 ${job.id} 锁定了不存在的方案 ${modeRaw}`);
          modeId = null;
        }
      }
      specs.set(job.index, { start, modeId });
    }
    return { locks, specs };
  }

  function normalizeProblem(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['顶层 JSON 必须是对象'] };
    }

    const deadline = toInt(raw.deadline);
    if (deadline === null || deadline < 0 || deadline > MAX_DEADLINE) {
      errors.push(`deadline 必须是 0..${MAX_DEADLINE} 的整数`);
    }

    if (!Array.isArray(raw.stations) || raw.stations.length === 0) {
      errors.push('stations 必须是非空数组');
    } else if (raw.stations.length > MAX_STATIONS) {
      errors.push(`工作台最多 ${MAX_STATIONS} 座`);
    }

    const stations = [];
    const stationIds = new Set();
    for (const [i, sRaw] of (raw.stations || []).entries()) {
      if (!sRaw || typeof sRaw !== 'object') {
        errors.push(`stations[${i}] 必须是对象`);
        continue;
      }
      const id = toInt(sRaw.id) ?? (typeof sRaw.id === 'string' && sRaw.id.trim() ? sRaw.id.trim() : i + 1);
      const idKey = String(id);
      if (stationIds.has(idKey)) errors.push(`工作台 id ${id} 重复`);
      stationIds.add(idKey);
      const closed = [];
      const rawClosed = sRaw.closed ?? sRaw.down ?? sRaw.outages ?? [];
      if (!Array.isArray(rawClosed)) {
        errors.push(`工作台 ${id} 的 closed 必须是数组`);
      } else {
        rawClosed.forEach((seg, k) => {
          const interval = normalizeInterval(seg, errors, `工作台 ${id} 停用段[${k}]`);
          if (interval) closed.push(interval);
        });
      }
      closed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      stations.push({ id, idKey, closed });
    }

    const stock = quantMap(raw.stock, errors, 'stock');
    const toolCapacity = quantMap(raw.tools, errors, 'tools');

    if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) {
      errors.push('jobs 必须是非空数组');
    } else if (raw.jobs.length > MAX_JOBS) {
      errors.push(`必做工序最多 ${MAX_JOBS} 道`);
    }

    const rawJobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    const jobsUnsorted = [];
    const jobById = new Map();
    const jobIds = new Set();

    rawJobs.forEach((jRaw, inputIndex) => {
      if (!jRaw || typeof jRaw !== 'object') {
        errors.push(`jobs[${inputIndex}] 必须是对象`);
        return;
      }
      const id = toInt(jRaw.id) ?? (typeof jRaw.id === 'string' && jRaw.id.trim() ? jRaw.id.trim() : inputIndex + 1);
      const idKey = String(id);
      if (jobIds.has(idKey)) errors.push(`工序 id ${id} 重复`);
      jobIds.add(idKey);

      if (!Array.isArray(jRaw.modes) || jRaw.modes.length === 0) {
        errors.push(`工序 ${id} 至少需要一个方案`);
      } else {
        const modeIds = new Set();
        const modes = [];
        jRaw.modes.forEach((mRaw, mi) => {
          if (!mRaw || typeof mRaw !== 'object') {
            errors.push(`工序 ${id} modes[${mi}] 必须是对象`);
            return;
          }
          const modeId = toInt(mRaw.id) ?? mi + 1;
          if (modeIds.has(String(modeId))) errors.push(`工序 ${id} 的方案 id ${modeId} 重复`);
          modeIds.add(String(modeId));
          const stationId = mRaw.station ?? mRaw.stationId;
          const stationKey = String(stationId);
          if (!stationIds.has(stationKey)) errors.push(`工序 ${id} 方案 ${modeId} 引用了不存在的工作台 ${stationId}`);
          const ticks = toInt(mRaw.ticks ?? mRaw.duration);
          if (ticks === null || ticks <= 0) errors.push(`工序 ${id} 方案 ${modeId} 的 ticks 必须是正整数`);
          const fee = toInt(mRaw.fee ?? mRaw.cost ?? 0);
          if (fee === null || fee < 0) errors.push(`工序 ${id} 方案 ${modeId} 的 fee 必须是非负整数`);
          modes.push({
            id: modeId,
            stationKey,
            ticks,
            fee,
            use: quantMap(mRaw.use, errors, `工序 ${id} 方案 ${modeId} use`),
            yield: quantMap(mRaw.yield ?? mRaw.output, errors, `工序 ${id} 方案 ${modeId} yield`),
            hold: quantMap(mRaw.hold ?? mRaw.tools, errors, `工序 ${id} 方案 ${modeId} hold`)
          });
        });
        jobsUnsorted.push({
          id,
          idKey,
          inputIndex,
          afterRaw: Array.isArray(jRaw.after) ? jRaw.after : [],
          modes
        });
        jobById.set(idKey, jobsUnsorted[jobsUnsorted.length - 1]);
      }
    });

    // 按工序号数值排序；非纯数字 id 退化为本地化字符串排序。
    const allNumeric = jobsUnsorted.every((j) => isInt(j.id));
    const jobs = jobsUnsorted.slice().sort((a, b) => {
      if (allNumeric) return a.id - b.id;
      return String(a.id).localeCompare(String(b.id), 'zh-Hans-CN', { numeric: true });
    });
    jobs.forEach((j, index) => { j.index = index; });
    jobById.clear();
    jobs.forEach((j) => jobById.set(j.idKey, j));

    for (const job of jobs) {
      job.after = [];
      for (const pre of job.afterRaw) {
        const preJob = jobById.get(String(pre));
        if (!preJob) errors.push(`工序 ${job.id} 的前置 ${pre} 不存在`);
        else if (preJob.index === job.index) errors.push(`工序 ${job.id} 不能以前置指向自己`);
        else job.after.push(preJob.index);
      }
      job.after = [...new Set(job.after)];
    }

    // 环检测。
    const state = new Array(jobs.length).fill(0);
    function dfsCycle(i) {
      state[i] = 1;
      for (const p of jobs[i].after) {
        if (state[p] === 1) return true;
        if (state[p] === 0 && dfsCycle(p)) return true;
      }
      state[i] = 2;
      return false;
    }
    for (let i = 0; i < jobs.length; i++) {
      if (state[i] === 0 && dfsCycle(i)) {
        errors.push('工序前置关系存在环，无法排程');
        break;
      }
    }

    const { locks, specs: lockSpecs } = normalizeLocks(raw.locks, jobs, jobById, errors);

    // 汇总配料与工具名称。stock/tools 中的零值也保留名称。
    const ingredientNames = [];
    const ingSeen = new Set();
    function addIngName(name) {
      const key = String(name);
      if (!ingSeen.has(key)) { ingSeen.add(key); ingredientNames.push(key); }
    }
    Object.keys(stock).forEach(addIngName);
    jobs.forEach((j) => j.modes.forEach((m) => {
      Object.keys(m.use).forEach(addIngName);
      Object.keys(m.yield).forEach(addIngName);
    }));

    const toolNames = [];
    const toolSeen = new Set();
    function addToolName(name) {
      const key = String(name);
      if (!toolSeen.has(key)) { toolSeen.add(key); toolNames.push(key); }
    }
    Object.keys(toolCapacity).forEach(addToolName);
    jobs.forEach((j) => j.modes.forEach((m) => Object.keys(m.hold).forEach(addToolName)));

    if (ingredientNames.length > MAX_INGREDIENTS) errors.push(`配料最多 ${MAX_INGREDIENTS} 种，当前 ${ingredientNames.length} 种`);
    if (toolNames.length > MAX_TOOLS) errors.push(`共享工具最多 ${MAX_TOOLS} 种，当前 ${toolNames.length} 种`);

    if (errors.length) return { ok: false, errors };

    const stationIndexByKey = new Map(stations.map((s, i) => [s.idKey, i]));
    const ingIndex = new Map(ingredientNames.map((n, i) => [n, i]));
    const toolIndex = new Map(toolNames.map((n, i) => [n, i]));

    const stockVec = ingredientNames.map((n) => stock[n] ?? 0);
    const toolVec = toolNames.map((n) => toolCapacity[n] ?? 0);

    for (const job of jobs) {
      job.lock = lockSpecs.get(job.index) || null;
      for (const m of job.modes) {
        m.stationIndex = stationIndexByKey.get(m.stationKey);
        m.useVec = ingredientNames.map((n) => m.use[n] ?? 0);
        m.yieldVec = ingredientNames.map((n) => m.yield[n] ?? 0);
        m.holdVec = toolNames.map((n) => m.hold[n] ?? 0);
      }
    }

    const problem = {
      deadline,
      stations: stations.map((s) => ({ id: s.id, closed: s.closed })),
      stock,
      tools: toolCapacity,
      jobs: jobs.map((j) => ({
        id: j.id,
        after: j.after.map((idx) => jobs[idx].id),
        modes: j.modes.map((m) => ({
          id: m.id,
          station: stations[m.stationIndex].id,
          ticks: m.ticks,
          fee: m.fee,
          use: m.use,
          yield: m.yield,
          hold: m.hold
        }))
      })),
      locks
    };

    // 运行时索引结构挂在非枚举属性上，避免 JSON 导出重复内部数组。
    Object.defineProperties(problem, {
      _runtime: {
        value: {
          jobs,
          stations,
          ingredientNames,
          toolNames,
          stockVec,
          toolVec,
          ingIndex,
          toolIndex,
          stationIndexByKey
        },
        enumerable: false
      }
    });

    return { ok: true, problem };
  }

  function masksOverlap(a, b) {
    return (a & b) !== 0n;
  }

  function intervalMask(start, end) {
    return ((1n << BigInt(end - start)) - 1n) << BigInt(start);
  }

  function candidateAt(problem, D) {
    const rt = problem._runtime;
    const { jobs, stations } = rt;
    // byStart[j][t] = modes that can start at t under cutoff D.
    const byStart = jobs.map((job) => {
      const arr = Array.from({ length: D + 1 }, () => []);
      job.modes.forEach((mode, modeIndex) => {
        if (!isInt(mode.ticks) || mode.ticks <= 0) return;
        for (let start = 0; start <= D - mode.ticks; start++) {
          if (job.lock && job.lock.start !== start) continue;
          if (job.lock && job.lock.modeId !== null && job.lock.modeId !== mode.id) continue;
          const end = start + mode.ticks;
          const mask = intervalMask(start, end);
          const station = stations[mode.stationIndex];
          const hitsClosed = station.closed.some(([a, b]) => start < b && a < end);
          if (hitsClosed) continue;
          arr[start].push({
            jobIndex: job.index,
            modeIndex,
            modeId: mode.id,
            stationIndex: mode.stationIndex,
            start,
            end,
            ticks: mode.ticks,
            fee: mode.fee,
            useVec: mode.useVec,
            yieldVec: mode.yieldVec,
            holdVec: mode.holdVec,
            mask
          });
        }
      });
      for (const list of arr) list.sort((a, b) => a.modeId - b.modeId || a.modeIndex - b.modeIndex);
      return arr;
    });

    const minFee = jobs.map((job, j) => {
      let best = Infinity;
      for (const list of byStart[j]) for (const c of list) best = Math.min(best, c.fee);
      return best === Infinity ? Math.min(...job.modes.map((m) => m.fee)) : best;
    });
    return { byStart, minFee };
  }

  function criticalPathLowerBound(problem) {
    const jobs = problem._runtime.jobs;
    const minDur = jobs.map((j) => Math.min(...j.modes.map((m) => m.ticks)));
    const memo = new Array(jobs.length).fill(null);
    function endTime(i) {
      if (memo[i] !== null) return memo[i];
      let pre = 0;
      for (const p of jobs[i].after) pre = Math.max(pre, endTime(p));
      memo[i] = pre + minDur[i];
      return memo[i];
    }
    return jobs.reduce((mx, _, i) => Math.max(mx, endTime(i)), 0);
  }

  /*
   * 时间推进 DFS。
   * 每拍先在 tick() 中入库完工产物、释放工具；decide() 再按工序号逐个决定
   * 是否在本拍开工。同一拍的用料随分支逐笔扣减，因此两份用量 1 不会同时
   * 越过库存 1；最终账本仍按整拍汇总体检。
   */
  function makeSearch(problem, D) {
    const rt = problem._runtime;
    const n = rt.jobs.length;
    const R = rt.ingredientNames.length;
    const T = rt.toolNames.length;
    const S = rt.stations.length;
    const ALL = (1 << n) - 1;
    const { byStart, minFee } = candidateAt(problem, D);
    const latestStart = byStart.map((lists) => {
      let latest = -1;
      lists.forEach((list, t) => { if (list.length) latest = t; });
      return latest;
    });
    const minDuration = rt.jobs.map((j) => Math.min(...j.modes.map((m) => m.ticks)));

    function deadlinePrune(t, st) {
      // 动态关键路径：未分配工序最早也要等当前拍 + 前置最短工期。
      const memo = new Array(n).fill(null);
      function earliestEnd(i) {
        if (st.mask & (1 << i)) return st.ends[i];
        if (memo[i] !== null) return memo[i];
        let e = t;
        for (const p of rt.jobs[i].after) e = Math.max(e, earliestEnd(p));
        memo[i] = e + minDuration[i];
        return memo[i];
      }
      for (let i = 0; i < n; i++) {
        if (!(st.mask & (1 << i)) && earliestEnd(i) > D) return true;
      }

      // 工作台总工时容量（忽略方案选台差异，因此是必要条件而非充分条件）。
      let stationCapacity = 0;
      for (let s = 0; s < S; s++) {
        for (let k = t; k < D; k++) {
          const blocked = rt.stations[s].closed.some(([a, b]) => k >= a && k < b);
          if (!blocked) stationCapacity++;
        }
        if (st.busyUntil[s] > t) stationCapacity -= st.busyUntil[s] - t;
      }
      let stationDemand = 0;
      for (let j = 0; j < n; j++) if (!(st.mask & (1 << j))) stationDemand += minDuration[j];
      if (stationDemand > stationCapacity) return true;

      // 更精确的必要条件：每道未分配工序必须选一个方案，且该方案在所属
      // 工作台上的总加工拍数不能超过从当前拍到 deadline 的开放容量。
      const stationCaps = rt.stations.map((s, si) => {
        let cap = 0;
        for (let k = t; k < D; k++) {
          if (!s.closed.some(([a, b]) => k >= a && k < b)) cap++;
        }
        if (st.busyUntil[si] > t) cap -= st.busyUntil[si] - t;
        return cap;
      });
      const loadMemo = new Map();
      const remainingJobs = [];
      for (let j = 0; j < n; j++) if (!(st.mask & (1 << j))) remainingJobs.push(j);
      function modeLoadPossible(pos, loads) {
        if (pos === remainingJobs.length) return true;
        const key = `${pos}|${loads.join(',')}`;
        if (loadMemo.has(key)) return loadMemo.get(key);
        const j = remainingJobs[pos];
        let ok = false;
        for (const m of rt.jobs[j].modes) {
          const si = m.stationIndex;
          if (loads[si] + m.ticks <= stationCaps[si]) {
            loads[si] += m.ticks;
            if (modeLoadPossible(pos + 1, loads)) ok = true;
            loads[si] -= m.ticks;
            if (ok) break;
          }
        }
        loadMemo.set(key, ok);
        return ok;
      }
      if (!modeLoadPossible(0, new Array(S).fill(0))) return true;

      // 每种工具的“工具数量×拍数”容量。
      for (let q = 0; q < T; q++) {
        let occupied = st.toolUsed[q] || 0;
        let load = st.toolUsed[q] || 0;
        for (let k = t + 1; k < D; k++) {
          load -= st.toolRelease[k][q];
          occupied += Math.max(0, load);
        }
        const available = rt.toolVec[q] * (D - t) - occupied;
        let demand = 0;
        for (let j = 0; j < n; j++) {
          if (st.mask & (1 << j)) continue;
          let best = Infinity;
          for (const m of rt.jobs[j].modes) best = Math.min(best, m.holdVec[q] * m.ticks);
          demand += best;
        }
        if (demand > available) return true;
      }
      return false;
    }

    function stateKey(t, cursor, st) {
      return [
        t, cursor, st.mask,
        st.stock.join(','),
        st.toolUsed.join(','),
        st.busyUntil.join(','),
        st.ends.join(','),
        st.toolRelease.slice(t, D + 1).map((x) => x.join('')).join('|'),
        st.yieldAt.slice(t, D + 1).map((x) => x.join('')).join('|')
      ].join(';');
    }

    function createState() {
      return {
        mask: 0,
        cost: 0,
        stock: rt.stockVec.slice(),
        toolUsed: emptyCounts(T),
        toolRelease: Array.from({ length: D + 2 }, () => emptyCounts(T)),
        yieldAt: Array.from({ length: D + 2 }, () => emptyCounts(R)),
        busyUntil: emptyCounts(S),
        choices: new Array(n).fill(null),
        ends: emptyCounts(n),
        nodes: 0
      };
    }

    function canStart(c, st) {
      const job = rt.jobs[c.jobIndex];
      for (const p of job.after) {
        if (!(st.mask & (1 << p))) return false;
        if (c.start < st.ends[p]) return false;
      }
      if (st.busyUntil[c.stationIndex] > c.start) return false;
      for (let r = 0; r < R; r++) {
        if (st.stock[r] < c.useVec[r]) return false;
      }
      for (let q = 0; q < T; q++) {
        if (st.toolUsed[q] + c.holdVec[q] > rt.toolVec[q]) return false;
      }
      return true;
    }

    function applyStart(c, st) {
      const j = c.jobIndex;
      st.mask |= 1 << j;
      st.cost += c.fee;
      st.choices[j] = c;
      st.ends[j] = c.end;
      const oldBusy = st.busyUntil[c.stationIndex];
      st.busyUntil[c.stationIndex] = c.end;
      for (let r = 0; r < R; r++) st.stock[r] -= c.useVec[r];
      for (let q = 0; q < T; q++) {
        st.toolUsed[q] += c.holdVec[q];
        st.toolRelease[c.end][q] += c.holdVec[q];
      }
      for (let r = 0; r < R; r++) st.yieldAt[c.end][r] += c.yieldVec[r];
      c._oldBusy = oldBusy;
    }

    function undoStart(c, st) {
      const j = c.jobIndex;
      st.mask &= ~(1 << j);
      st.cost -= c.fee;
      st.choices[j] = null;
      st.ends[j] = 0;
      st.busyUntil[c.stationIndex] = c._oldBusy;
      for (let r = 0; r < R; r++) st.stock[r] += c.useVec[r];
      for (let q = 0; q < T; q++) {
        st.toolUsed[q] -= c.holdVec[q];
        st.toolRelease[c.end][q] -= c.holdVec[q];
      }
      for (let r = 0; r < R; r++) st.yieldAt[c.end][r] -= c.yieldVec[r];
    }

    function enterTick(t, st) {
      for (let r = 0; r < R; r++) st.stock[r] += st.yieldAt[t][r];
      for (let q = 0; q < T; q++) st.toolUsed[q] -= st.toolRelease[t][q];
    }

    function leaveTick(t, st) {
      for (let q = 0; q < T; q++) st.toolUsed[q] += st.toolRelease[t][q];
      for (let r = 0; r < R; r++) st.stock[r] -= st.yieldAt[t][r];
    }

    function lockedMustStartHere(j, t) {
      const lock = rt.jobs[j].lock;
      return !!lock && lock.start === t;
    }

    // 找到第一个可行解。modeOrder: 'lex' | 'fee'。
    function firstFeasible(options = {}) {
      const costCap = options.costCap ?? Infinity;
      const modeOrder = options.modeOrder || 'lex';
      const nodeBudget = options.nodeBudget ?? null;
      const st = createState();
      let answer = null;
      let budgetExceeded = false;
      const failedCost = new Map();

      function decide(t, cursor, minRemaining) {
        st.nodes++;
        if (nodeBudget !== null && st.nodes > nodeBudget) {
          budgetExceeded = true;
          return false;
        }
        if (answer) return true;
        if (st.mask === ALL) {
          answer = st.choices.slice();
          return true;
        }
        if (t > D) return false;
        if (deadlinePrune(t, st)) return false;

        const key = stateKey(t, cursor, st);
        const seenCost = failedCost.get(key);
        if (seenCost !== undefined && seenCost <= st.cost) return false;
        failedCost.set(key, st.cost);

        if (cursor >= n) return tick(t + 1, minRemaining);

        const j = cursor;
        if (st.mask & (1 << j)) return decide(t, j + 1, minRemaining);
        if (latestStart[j] < t) return false;

        let candidates = byStart[j][t] || [];
        if (modeOrder === 'fee') {
          candidates = candidates.slice().sort((a, b) =>
            a.fee - b.fee || a.start - b.start || a.modeId - b.modeId);
        }

        for (const c of candidates) {
          if (!canStart(c, st)) continue;
          const nextMin = minRemaining - minFee[j];
          if (st.cost + c.fee + nextMin > costCap) continue;
          applyStart(c, st);
          if (decide(t, j + 1, nextMin)) return true;
          undoStart(c, st);
        }

        // 锁定在本拍的工序不能跳过；静态上已无更晚可行开工拍时也不必跳过。
        if (!lockedMustStartHere(j, t) && latestStart[j] > t) {
          if (decide(t, j + 1, minRemaining)) return true;
        }
        return false;
      }

      function tick(t, minRemaining) {
        if (answer) return true;
        if (t > D) return false;
        enterTick(t, st);
        const ok = decide(t, 0, minRemaining);
        if (!ok) leaveTick(t, st);
        return ok;
      }

      const ok = tick(0, minFee.reduce((a, b) => a + b, 0));
      if (ok) return { choices: answer, nodes: st.nodes };
      return budgetExceeded ? { budget: true, nodes: st.nodes } : null;
    }

    // 求最低费用。initial 为一组已知可行 choices。
    function minCost(initial) {
      const st = createState();
      let bestCost = initial.reduce((sum, c) => sum + c.fee, 0);
      let bestChoices = initial.slice();
      let nodes = 0;

      // 把 initial 当成上界即可，不写入 st。
      function decide(t, cursor, minRemaining) {
        nodes++;
        if (st.mask === ALL) {
          if (st.cost < bestCost) {
            bestCost = st.cost;
            bestChoices = st.choices.slice();
          }
          return;
        }
        if (t > D) return;
        if (st.cost + minRemaining >= bestCost) return;

        if (cursor >= n) { tick(t + 1, minRemaining); return; }
        const j = cursor;
        if (st.mask & (1 << j)) { decide(t, j + 1, minRemaining); return; }

        let candidates = byStart[j][t] || [];
        candidates = candidates.slice().sort((a, b) =>
          a.fee - b.fee || a.modeId - b.modeId);

        for (const c of candidates) {
          if (!canStart(c, st)) continue;
          const nextMin = minRemaining - minFee[j];
          const nextCost = st.cost + c.fee;
          if (nextCost + nextMin >= bestCost) continue;
          applyStart(c, st);
          decide(t, j + 1, nextMin);
          undoStart(c, st);
        }

        if (!lockedMustStartHere(j, t)) decide(t, j + 1, minRemaining);
      }

      function tick(t, minRemaining) {
        if (t > D) return;
        enterTick(t, st);
        decide(t, 0, minRemaining);
        leaveTick(t, st);
      }

      tick(0, minFee.reduce((a, b) => a + b, 0));
      return { cost: bestCost, choices: bestChoices, nodes };
    }

    function signatureOf(choices) {
      const sig = [];
      for (let j = 0; j < n; j++) {
        const c = choices[j];
        sig.push(c ? c.start : Number.MAX_SAFE_INTEGER);
        sig.push(c ? c.modeId : Number.MAX_SAFE_INTEGER);
      }
      return sig;
    }

    function cmpSig(a, b) {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return 0;
    }

    // 在费用已固定为 targetCost 的所有方案中，保留工序号序列的字典序最小者。
    function lexMin(targetCost, initial) {
      const st = createState();
      let bestChoices = initial.slice();
      let bestSig = signatureOf(bestChoices);
      let nodes = 0;

      function prefixCannotBeatBest() {
        // 只有 0..k 连续已分配时，才能确定字典序前缀。
        let k = 0;
        while (k < n && st.choices[k]) k++;
        for (let j = 0; j < k; j++) {
          const pos = j * 2;
          const a = st.choices[j].start;
          const b = bestSig[pos];
          if (a !== b) return a > b;
          const ma = st.choices[j].modeId;
          const mb = bestSig[pos + 1];
          if (ma !== mb) return ma > mb;
        }
        return false;
      }

      function decide(t, cursor, minRemaining) {
        nodes++;
        if (st.mask === ALL) {
          if (st.cost <= targetCost) {
            const sig = signatureOf(st.choices);
            if (cmpSig(sig, bestSig) < 0) {
              bestSig = sig;
              bestChoices = st.choices.slice();
            }
          }
          return;
        }
        if (t > D) return;
        if (st.cost > targetCost || st.cost + minRemaining > targetCost) return;
        if (prefixCannotBeatBest()) return;

        if (cursor >= n) { tick(t + 1, minRemaining); return; }
        const j = cursor;
        if (st.mask & (1 << j)) { decide(t, j + 1, minRemaining); return; }

        const candidates = byStart[j][t] || [];
        // 字典序搜索也按 (方案号) 排序；时间由外层 t 递增。
        for (const c of candidates) {
          if (!canStart(c, st)) continue;
          const nextMin = minRemaining - minFee[j];
          if (st.cost + c.fee + nextMin > targetCost) continue;
          if (st.cost + c.fee > targetCost) continue;
          applyStart(c, st);
          decide(t, j + 1, nextMin);
          undoStart(c, st);
        }

        if (!lockedMustStartHere(j, t)) decide(t, j + 1, minRemaining);
      }

      function tick(t, minRemaining) {
        if (t > D) return;
        enterTick(t, st);
        decide(t, 0, minRemaining);
        leaveTick(t, st);
      }

      tick(0, minFee.reduce((a, b) => a + b, 0));
      return { choices: bestChoices, signature: bestSig, nodes };
    }

    return { firstFeasible, minCost, lexMin, createState, canStart, applyStart, undoStart, enterTick, leaveTick, ALL };
  }

  function candidateToAssignment(c, problem) {
    const rt = problem._runtime;
    const job = rt.jobs[c.jobIndex];
    const mode = job.modes[c.modeIndex];
    const station = rt.stations[c.stationIndex];
    return {
      jobId: job.id,
      job: job.id,
      jobIndex: c.jobIndex,
      modeId: c.modeId,
      mode: c.modeId,
      modeIndex: c.modeIndex,
      stationId: station.id,
      station: station.id,
      stationIndex: c.stationIndex,
      start: c.start,
      end: c.end,
      ticks: c.ticks,
      fee: c.fee,
      use: deepClone(mode.use),
      yield: deepClone(mode.yield),
      hold: deepClone(mode.hold)
    };
  }

  function solvePlan(rawInput) {
    const norm = normalizeProblem(rawInput);
    if (!norm.ok) {
      return { status: 'invalid', feasible: false, errors: norm.errors };
    }
    const problem = norm.problem;
    const rt = problem._runtime;
    const t0 = Date.now();

    const deadlineSearch = makeSearch(problem, problem.deadline);
    const feasibleAtDeadline = deadlineSearch.firstFeasible({ modeOrder: 'lex' });
    if (!feasibleAtDeadline) {
      return {
        status: 'unsolvable',
        feasible: false,
        deadline: problem.deadline,
        reason: '在时限、停用段、前置、库存、工作台和共享工具约束下找不到可行计划',
        errors: [],
        stats: { ms: Date.now() - t0 }
      };
    }

    const lb = Math.min(problem.deadline, criticalPathLowerBound(problem));
    let lo = Math.max(0, lb);
    let hi = problem.deadline;
    // 二元搜索最早全完工拍；可行性随 D 单调。
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const search = makeSearch(problem, mid);
      const found = search.firstFeasible({ modeOrder: 'lex' });
      if (found) hi = mid;
      else lo = mid + 1;
    }
    const makespan = lo;
    const search = makeSearch(problem, makespan);
    const first = search.firstFeasible({ modeOrder: 'lex' });
    if (!first) {
      // 理论上不应发生：二元搜索已验证。保守返回无解而不是伪造。
      return { status: 'unsolvable', feasible: false, reason: '内部一致性错误：最早时限复核失败' };
    }

    const costResult = search.minCost(first.choices);
    const lexResult = search.lexMin(costResult.cost, costResult.choices);
    const finalChoices = lexResult.choices || costResult.choices;
    const assignments = finalChoices.map((c) => candidateToAssignment(c, problem));
    const cost = assignments.reduce((s, a) => s + a.fee, 0);
    assignments.sort((a, b) => a.jobIndex - b.jobIndex);

    const ledger = buildLedger(problem, assignments);
    const verification = verifyAssignments(problem, assignments);
    const signature = [];
    for (const a of assignments) signature.push(a.start, a.modeId);

    return {
      status: 'optimal',
      feasible: true,
      optimal: true,
      makespan,
      deadline: problem.deadline,
      cost,
      totalFee: cost,
      signature,
      assignments,
      ledger: ledger.rows,
      verification,
      stats: {
        ms: Date.now() - t0,
        feasibilityNodes: first.nodes,
        costNodes: costResult.nodes,
        lexNodes: lexResult.nodes
      }
    };
  }

  function aggregateCounts(items, names, field) {
    const out = {};
    for (const name of names) out[name] = 0;
    for (const item of items) {
      const m = item[field] || {};
      for (const name of names) out[name] += m[name] ?? 0;
    }
    return out;
  }

  function buildLedger(rawProblem, assignmentsInput, options = {}) {
    const norm = rawProblem._runtime ? { ok: true, problem: rawProblem } : normalizeProblem(rawProblem);
    if (!norm.ok) return { rows: [], ok: false, errors: norm.errors };
    const problem = norm.problem;
    const rt = problem._runtime;
    const names = rt.ingredientNames;
    const toolNames = rt.toolNames;
    const assignments = (assignmentsInput || []).map(normalizeLooseAssignment).filter(Boolean);

    // 物料/工具用量以题目中的方案定义为准，不能信任导出记录里自带的数量。
    for (const a of assignments) {
      const job = rt.jobs.find((j) => j.idKey === String(a.jobId));
      const mode = job?.modes.find((m) => m.id === a.modeId || m.id === toInt(a.modeId));
      if (mode) {
        a.useVec = mode.useVec;
        a.yieldVec = mode.yieldVec;
        a.holdVec = mode.holdVec;
        a.stationIndex = mode.stationIndex;
        a.ticks = a.ticks ?? mode.ticks;
        if (a.end === null && a.start !== null) a.end = a.start + mode.ticks;
      }
    }

    let horizon = options.horizon;
    if (!isInt(horizon)) {
      horizon = assignments.reduce((mx, a) => Math.max(mx, toInt(a.end) ?? 0, toInt(a.start) ?? 0), 0);
    }
    horizon = Math.max(0, horizon);

    let stock = rt.stockVec.slice();
    const rows = [];
    let allOk = true;

    for (let t = 0; t <= horizon; t++) {
      const completed = assignments.filter((a) => a.end === t);
      const started = assignments.filter((a) => a.start === t);
      const stockStart = names.map((n, i) => stock[i]);

      const outputVec = emptyCounts(names.length);
      for (const a of completed) {
        for (let i = 0; i < names.length; i++) outputVec[i] += a.yieldVec?.[i] ?? (a.yield?.[names[i]] ?? 0);
      }
      const stockAfterOutputVec = stockStart.map((v, i) => v + outputVec[i]);

      const demandVec = emptyCounts(names.length);
      for (const a of started) {
        for (let i = 0; i < names.length; i++) demandVec[i] += a.useVec?.[i] ?? (a.use?.[names[i]] ?? 0);
      }
      const shortageVec = stockAfterOutputVec.map((v, i) => Math.max(0, demandVec[i] - v));
      // 只把“本拍有开工且汇总需求超过入库后库存”记为一次新的扣料失败；
      // 上一拍失败后延续的负库存由 stockNonnegative 展示，不重复报错。
      const materialOk = started.length === 0 || shortageVec.every((v) => v === 0);
      const stockAfterDeductVec = stockAfterOutputVec.map((v, i) => v - demandVec[i]);
      const stockNonnegative = stockAfterDeductVec.every((v) => v >= 0);
      if (!materialOk) allOk = false;

      // 半开区间 [start,end)：t 拍占用条件 start<=t<end。
      const active = assignments.filter((a) => a.start <= t && t < a.end);
      const toolInUseVec = emptyCounts(toolNames.length);
      for (const a of active) {
        for (let i = 0; i < toolNames.length; i++) toolInUseVec[i] += a.holdVec?.[i] ?? (a.hold?.[toolNames[i]] ?? 0);
      }
      const toolOverVec = toolInUseVec.map((v, i) => Math.max(0, v - rt.toolVec[i]));
      const toolOk = toolOverVec.every((v) => v === 0);
      if (!toolOk) allOk = false;

      const released = aggregateCounts(completed, toolNames, 'hold');
      const acquired = aggregateCounts(started, toolNames, 'hold');
      const outputs = aggregateCounts(completed, names, 'yield');
      const demand = aggregateCounts(started, names, 'use');

      rows.push({
        tick: t,
        completed: completed.map((a) => ({ jobId: a.jobId, modeId: a.modeId })),
        started: started.map((a) => ({ jobId: a.jobId, modeId: a.modeId })),
        stockStart: countsObject(names, stockStart),
        outputs,
        stockAfterOutput: countsObject(names, stockAfterOutputVec),
        demand,
        required: demand,
        shortage: countsObject(names, shortageVec.filter ? shortageVec : []),
        stockAfterDeduct: countsObject(names, stockAfterDeductVec),
        stockAfter: countsObject(names, stockAfterDeductVec),
        released,
        acquired,
        toolInUse: countsObject(toolNames, toolInUseVec),
        toolCapacity: countsObject(toolNames, rt.toolVec),
        toolOver: countsObject(toolNames, toolOverVec),
        materialOk,
        stockNonnegative,
        toolOk,
        ok: materialOk && stockNonnegative && toolOk,
        issues: [
          ...(materialOk ? [] : [`配料透支：${names.map((n, i) => shortageVec[i] > 0 ? `${n} 缺 ${shortageVec[i]}` : null).filter(Boolean).join('，')}`]),
          ...(materialOk && !stockNonnegative ? ['库存余额为负'] : []),
          ...(toolOk ? [] : [`工具超占：${toolNames.map((n, i) => toolOverVec[i] > 0 ? `${n} 超 ${toolOverVec[i]}` : null).filter(Boolean).join('，')}`])
        ]
      });

      stock = stockAfterDeductVec;
    }

    return { rows, ok: allOk, errors: [], ingredientNames: names, toolNames };
  }

  function countsObject(names, vec) {
    const out = {};
    names.forEach((n, i) => { out[n] = vec[i] ?? 0; });
    return out;
  }

  function normalizeLooseAssignment(a) {
    if (!a || typeof a !== 'object') return null;
    const jobId = a.jobId ?? a.job ?? a.id;
    const modeId = a.modeId ?? a.mode ?? a.planId ?? a.plan;
    const start = toInt(a.start ?? a.at ?? a.begin);
    let end = toInt(a.end ?? a.finish);
    const ticks = toInt(a.ticks ?? a.duration);
    if (end === null && start !== null && ticks !== null) end = start + ticks;
    return {
      jobId,
      modeId,
      start,
      end,
      ticks,
      fee: toInt(a.fee ?? a.cost) ?? 0,
      stationId: a.stationId ?? a.station,
      use: a.use || {},
      yield: a.yield || a.output || {},
      hold: a.hold || a.tools || {}
    };
  }

  function verifyAssignments(rawProblem, rawAssignments) {
    const norm = rawProblem._runtime ? { ok: true, problem: rawProblem } : normalizeProblem(rawProblem);
    if (!norm.ok) {
      return { ok: false, valid: false, errors: norm.errors, startChecks: [], ledger: null };
    }
    const problem = norm.problem;
    const rt = problem._runtime;
    const jobs = rt.jobs;
    const errors = [];
    const startChecks = [];
    const provided = (rawAssignments || []).map(normalizeLooseAssignment);

    const byJob = new Map();
    for (const a of provided) {
      const key = String(a.jobId);
      if (!byJob.has(key)) byJob.set(key, []);
      byJob.get(key).push(a);
    }

    for (const job of jobs) {
      const list = byJob.get(job.idKey) || [];
      if (list.length === 0) {
        errors.push(`缺少工序 ${job.id} 的开工记录`);
        startChecks.push({ jobId: job.id, valid: false, issues: ['缺少开工记录'], checks: {} });
        continue;
      }
      if (list.length > 1) errors.push(`工序 ${job.id} 有 ${list.length} 条开工记录，工序不能拆/重复`);
      for (const a of list) {
        const issues = [];
        const checks = {};
        const mode = job.modes.find((m) => m.id === a.modeId || m.id === toInt(a.modeId));
        checks.modeExists = !!mode;
        if (!mode) issues.push(`方案 ${a.modeId} 不存在`);

        checks.startInteger = a.start !== null && a.start >= 0;
        if (!checks.startInteger) issues.push('开工拍必须是非负整数');

        let end = a.end;
        if (mode && a.start !== null) {
          const expectedEnd = a.start + mode.ticks;
          if (end === null) end = expectedEnd;
          checks.durationMatches = end === expectedEnd;
          if (!checks.durationMatches) issues.push(`完工拍应为 ${expectedEnd}`);
        }

        checks.withinDeadline = a.start !== null && end !== null && end <= problem.deadline;
        if (!checks.withinDeadline) issues.push(`超出 deadline=${problem.deadline}`);

        if (job.lock) {
          checks.lock = a.start === job.lock.start &&
            (job.lock.modeId === null || a.modeId === job.lock.modeId);
          if (!checks.lock) issues.push(`应锁定在第 ${job.lock.start} 拍开工`);
        } else {
          checks.lock = true;
        }

        if (mode && a.start !== null && end !== null) {
          checks.precedence = job.after.every((p) => {
            const preList = byJob.get(jobs[p].idKey) || [];
            return preList.some((pa) => pa.end !== null && a.start >= pa.end);
          });
          if (!checks.precedence) issues.push('存在前置工序尚未完工');

          const station = rt.stations[mode.stationIndex];
          const interval = [a.start, end];
          checks.stationOpen = !station.closed.some(([x, y]) => a.start < y && x < end);
          if (!checks.stationOpen) issues.push(`占用了工作台 ${station.id} 的停用段`);

          const overlaps = [];
          for (const other of provided) {
            if (other === a || String(other.jobId) === job.idKey) continue;
            const otherMode = rt.jobs.find((j) => j.idKey === String(other.jobId))?.modes
              .find((m) => m.id === other.modeId || m.id === toInt(other.modeId));
            if (!otherMode || otherMode.stationIndex !== mode.stationIndex) continue;
            if (other.start === null || other.end === null) continue;
            if (a.start < other.end && other.start < end) {
              overlaps.push(other.jobId);
            }
          }
          checks.noStationConflict = overlaps.length === 0;
          if (!checks.noStationConflict) issues.push(`工作台与工序 ${overlaps.join('、')} 占用重叠`);
        } else {
          checks.precedence = false;
          checks.stationOpen = false;
          checks.noStationConflict = false;
        }

        startChecks.push({
          jobId: job.id,
          modeId: a.modeId,
          start: a.start,
          end,
          valid: issues.length === 0,
          issues,
          checks
        });
        if (issues.length) errors.push(`工序 ${job.id}：${issues.join('；')}`);
      }
    }

    for (const a of provided) {
      if (!jobs.some((j) => j.idKey === String(a.jobId))) errors.push(`导出记录包含未知工序 ${a.jobId}`);
    }

    const ledger = buildLedger(problem, provided.map((a) => {
      // 补向量以便 ledger 使用规范化 mode 的物料。
      const job = jobs.find((j) => j.idKey === String(a.jobId));
      const mode = job?.modes.find((m) => m.id === a.modeId || m.id === toInt(a.modeId));
      return {
        ...a,
        useVec: mode?.useVec,
        yieldVec: mode?.yieldVec,
        holdVec: mode?.holdVec
      };
    }), { horizon: problem.deadline });

    for (const row of ledger.rows) {
      if (!row.materialOk) errors.push(`第 ${row.tick} 拍汇总扣料失败：${row.issues.join('；')}`);
      if (!row.toolOk) errors.push(`第 ${row.tick} 拍工具容量失败：${row.issues.join('；')}`);
    }

    // 把每拍物料/工具证据挂到该拍所有开工记录。
    for (const check of startChecks) {
      const row = ledger.rows.find((r) => r.tick === check.start);
      if (row) {
        check.material = {
          ok: row.materialOk,
          stockAfterOutput: row.stockAfterOutput,
          demand: row.demand,
          shortage: row.shortage,
          stockAfter: row.stockAfterDeduct
        };
        check.tools = { ok: row.toolOk, inUse: row.toolInUse, capacity: row.toolCapacity, over: row.toolOver };
        check.checks.materials = row.materialOk;
        check.checks.tools = row.toolOk;
        if (!row.materialOk && check.valid) {
          check.valid = false;
          check.issues.push('本拍全部开工用料汇总后超过入库库存');
        }
      }
    }

    const valid = errors.length === 0;
    return {
      ok: valid,
      valid,
      errors: [...new Set(errors)],
      startChecks,
      ledger,
      checkedStarts: startChecks.length
    };
  }

  function decorateAssignments(rawProblem, rawAssignments) {
    const norm = rawProblem._runtime ? { ok: true, problem: rawProblem } : normalizeProblem(rawProblem);
    if (!norm.ok) return [];
    const problem = norm.problem;
    const rt = problem._runtime;
    return (rawAssignments || []).map((raw) => {
      const a = normalizeLooseAssignment(raw);
      if (!a) return null;
      const job = rt.jobs.find((j) => j.idKey === String(a.jobId));
      if (!job) return { ...a, validShape: false };
      const mode = job.modes.find((m) => m.id === a.modeId || m.id === toInt(a.modeId));
      if (!mode) return { ...a, jobIndex: job.index, validShape: false };
      const start = a.start;
      const end = a.end ?? (start !== null ? start + mode.ticks : null);
      return {
        ...a,
        jobIndex: job.index,
        modeIndex: mode.modeIndex ?? job.modes.indexOf(mode),
        stationIndex: mode.stationIndex,
        stationId: rt.stations[mode.stationIndex].id,
        ticks: a.ticks ?? mode.ticks,
        end,
        fee: a.fee ?? mode.fee,
        use: mode.use,
        yield: mode.yield,
        hold: mode.hold,
        useVec: mode.useVec,
        yieldVec: mode.yieldVec,
        holdVec: mode.holdVec,
        validShape: start !== null && end !== null
      };
    }).filter(Boolean);
  }

  function extractPlan(raw) {
    if (!raw || typeof raw !== 'object') return { problemRaw: raw, assignments: null, meta: {} };
    const problemRaw = raw.problem ?? raw.data ?? raw.input ?? raw;
    let assignments = raw.assignments
      ?? raw.schedule
      ?? raw.starts
      ?? raw.plan?.assignments
      ?? raw.plan?.schedule
      ?? raw.result?.assignments
      ?? raw.verification?.assignments
      ?? null;
    if (!assignments && Array.isArray(raw.plan)) assignments = raw.plan;
    if (!assignments && Array.isArray(raw) && raw.every((x) => x && (x.jobId ?? x.job))) assignments = raw;
    return {
      problemRaw,
      assignments,
      meta: {
        format: raw.format,
        exportedAt: raw.exportedAt,
        objective: raw.plan ? { makespan: raw.plan.makespan, cost: raw.plan.cost } : null
      }
    };
  }

  function parseImportText(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `JSON 解析失败：${e.message}` };
    }
    const extracted = extractPlan(raw);
    const norm = normalizeProblem(extracted.problemRaw);
    if (!norm.ok) return { ok: false, error: norm.errors.join('\n'), errors: norm.errors, raw };

    let verification = null;
    if (extracted.assignments) {
      verification = verifyAssignments(norm.problem, extracted.assignments);
    }
    return {
      ok: true,
      raw,
      problem: norm.problem,
      assignments: extracted.assignments,
      verification,
      meta: extracted.meta
    };
  }

  function makeExport(problem, result) {
    const cleanProblem = JSON.parse(JSON.stringify(problem));
    const verification = result?.verification || verifyAssignments(problem, result?.assignments || []);
    return {
      app: 'cookfest-station-plan',
      format: 'cookfest-plan-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      problem: cleanProblem,
      ...cleanProblem,
      plan: {
        status: result.status,
        feasible: result.feasible,
        optimal: result.optimal,
        makespan: result.makespan,
        deadline: result.deadline,
        cost: result.cost,
        signature: result.signature,
        assignments: result.assignments
      },
      schedule: result.assignments,
      ledger: result.ledger,
      verification,
      locks: cleanProblem.locks
    };
  }

  return {
    MAX_JOBS, MAX_STATIONS, MAX_INGREDIENTS, MAX_TOOLS, MAX_DEADLINE,
    normalizeProblem,
    solvePlan,
    buildLedger,
    verifyPlan: verifyAssignments,
    verifySchedule: verifyAssignments,
    verifyAssignments,
    parseImportText,
    extractPlan,
    decorateAssignments,
    makeExport,
    esc,
    // 导出给测试/调试。
    _internal: { candidateAt, makeSearch, criticalPathLowerBound, intervalMask }
  };
});
