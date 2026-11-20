// WFC 回溯求解器：候选传播（AC-3）+ 熵选择 + 加权试选顺序 + 深度优先回溯。
// 严格按 samples 说明.md 的定义实现，确定性由 LCG 与固定处理顺序保证。
import { LCG } from './rng.js?v=5';

// 方向定义：边索引按 [北, 东, 南, 西]
export const DIRS = [
  { name: 'N', label: '北', edge: 0, opposite: 2, dx: 0, dy: -1 },
  { name: 'E', label: '东', edge: 1, opposite: 3, dx: 1, dy: 0 },
  { name: 'S', label: '南', edge: 2, opposite: 0, dx: 0, dy: 1 },
  { name: 'W', label: '西', edge: 3, opposite: 1, dx: -1, dy: 0 },
];

export const STATUS = {
  READY: 'ready',                 // 尚未开始
  RUNNING: 'running',             // 求解中
  PAUSED: 'paused',               // 暂停（可单步/继续）
  SOLVED: 'solved',               // 已求解
  UNSOLVABLE: 'unsolvable',       // 已证明无解
  BUDGET_EXHAUSTED: 'budget',     // 预算耗尽
  CANCELLED: 'cancelled',         // 任务被取消
};

const EPS = 1e-12;

export class ValidationError extends Error {}

// 校验并规范化配置；返回内部使用的深拷贝
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ValidationError('配置为空或格式错误');
  const width = Number(cfg.width);
  const height = Number(cfg.height);
  if (!Number.isInteger(width) || width < 1 || width > 32) throw new ValidationError('width 须为 1..32 的整数');
  if (!Number.isInteger(height) || height < 1 || height > 32) throw new ValidationError('height 须为 1..32 的整数');
  if (!Array.isArray(cfg.tiles) || cfg.tiles.length === 0 || cfg.tiles.length > 24) {
    throw new ValidationError('tiles 须为 1..24 种拼块');
  }
  const ids = new Set();
  const tiles = cfg.tiles.map((t) => {
    if (!t || typeof t.id !== 'string' || !t.id) throw new ValidationError('拼块缺少字符串 id');
    if (ids.has(t.id)) throw new ValidationError(`拼块 id 重复：${t.id}`);
    ids.add(t.id);
    const weight = Number(t.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new ValidationError(`拼块 ${t.id} 的 weight 须为正数`);
    if (!Array.isArray(t.edges) || t.edges.length !== 4 || !t.edges.every((e) => typeof e === 'string')) {
      throw new ValidationError(`拼块 ${t.id} 的 edges 须为 4 个字符串 [北,东,南,西]`);
    }
    return { id: t.id, weight, edges: [...t.edges], color: typeof t.color === 'string' ? t.color : '#8899aa' };
  });
  const pins = [];
  if (cfg.pins !== undefined && cfg.pins !== null) {
    if (!Array.isArray(cfg.pins)) throw new ValidationError('pins 须为数组');
    for (const p of cfg.pins) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isInteger(x) || x < 0 || x >= width || !Number.isInteger(y) || y < 0 || y >= height) {
        throw new ValidationError('pin 坐标越界');
      }
      if (!Array.isArray(p.allowed) || p.allowed.length === 0) throw new ValidationError(`pin (${x},${y}) 的 allowed 不能为空`);
      for (const id of p.allowed) {
        if (!ids.has(id)) throw new ValidationError(`pin (${x},${y}) 引用了不存在的拼块：${id}`);
      }
      pins.push({ x, y, allowed: [...new Set(p.allowed)] });
    }
  }
  const seed = Number(cfg.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new ValidationError('seed 须为 0..4294967295 的整数');
  const budget = Number(cfg.budget);
  if (!Number.isInteger(budget) || budget < 1) throw new ValidationError('budget 须为正整数');
  return {
    width,
    height,
    tiles,
    pins,
    wrapX: !!cfg.wrap_x,
    wrapY: !!cfg.wrap_y,
    seed: seed >>> 0,
    budget,
  };
}

export class Solver {
  constructor(rawConfig) {
    // 兼容两种入参：原始配置（wrap_x）走校验规范化；已规范化配置（wrapX）直接使用，
    // 避免对 validateConfig 的产物二次校验时读不到 wrap_x 而丢失周期边界。
    const cfg = ('wrapX' in rawConfig) ? rawConfig : validateConfig(rawConfig);
    this.width = cfg.width;
    this.height = cfg.height;
    this.tiles = cfg.tiles;                       // 已按输入顺序；内部另建 id→idx
    this.tileCount = cfg.tiles.length;
    this.idToIndex = new Map(cfg.tiles.map((t, i) => [t.id, i]));
    this.weights = Float64Array.from(cfg.tiles, (t) => t.weight);
    this.wrapX = cfg.wrapX;
    this.wrapY = cfg.wrapY;
    this.seed = cfg.seed;
    this.budget = cfg.budget;
    this.pins = cfg.pins;
    this.N = this.width * this.height;
    const full = (1 << this.tileCount) - 1;

    // 邻接表与支持掩码（support[fromIdx][dir][tileIdx] -> 邻格候选掩码）
    this.neighbors = new Array(this.N);
    this.support = new Array(this.N);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = y * this.width + x;
        const nbs = [];
        for (const d of DIRS) {
          let nx = x + d.dx;
          let ny = y + d.dy;
          if (nx < 0 || nx >= this.width) {
            if (!this.wrapX) continue;
            nx = (nx + this.width) % this.width;
          }
          if (ny < 0 || ny >= this.height) {
            if (!this.wrapY) continue;
            ny = (ny + this.height) % this.height;
          }
          // 尺寸1的周期轴：邻格即自身，检查自身相邻边（说明明确要求）
          nbs.push({ cell: ny * this.width + nx, dir: d.name, dirIndex: DIRS.indexOf(d) });
        }
        this.neighbors[c] = nbs;
        const cellSupport = nbs.map((nb) => {
          const masks = new Array(this.tileCount);
          for (let i = 0; i < this.tileCount; i++) {
            let mask = 0;
            const edgeHere = this.tiles[i].edges[nb.dirIndex];
            for (let j = 0; j < this.tileCount; j++) {
              if (this.tiles[j].edges[DIRS[nb.dirIndex].opposite] === edgeHere) mask |= 1 << j;
            }
            masks[i] = mask;
          }
          return masks;
        });
        this.support[c] = cellSupport;
      }
    }

    // 初始域：全集，再施加 pins（同格多条取交集）
    this.domains = new Uint32Array(this.N).fill(full);
    for (const p of this.pins) {
      let m = 0;
      for (const id of p.allowed) m |= 1 << this.idToIndex.get(id);
      this.domains[p.y * this.width + p.x] &= m;
    }

    this.rng = new LCG(this.seed);
    this.status = STATUS.READY;
    this.trialsUsed = 0;
    this.trace = [];                              // 完整求解轨迹
    this.assignment = new Int8Array(this.N).fill(-1);

    // 显式状态机
    this._phase = 'pins';                         // pins -> propagate -> decide -> trial -> backtrack
    this._pinCursor = 0;
    this._queue = [];                             // 待处理弧；_queueHead 为队头下标
    this._queued = new Set();
    this._queueHead = 0;
    this._node = null;                            // 当前搜索节点
    this._stack = [];
    this._pendingContradiction = null;            // 域清空后待发出的 contradiction 事件
  }

  // ---- 域工具 ----
  static popcount(m) {
    m = m - ((m >>> 1) & 0x55555555);
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  static *bits(mask) {
    let m = mask;
    let i = 0;
    while (m) {
      if (m & 1) yield i;
      m >>>= 1;
      i++;
    }
  }

  maskToIds(mask) {
    const out = [];
    for (const i of Solver.bits(mask)) out.push(this.tiles[i].id);
    return out;
  }

  // ---- 队列（固定入队顺序 + 去重；队头指针顺序消费，避免 splice 游标错位）----
  _enqueue(cell, dirIndex) {
    const key = cell * 4 + dirIndex;
    if (!this._queued.has(key)) {
      this._queued.add(key);
      this._queue.push({ cell, dirIndex });
    }
  }

  _enqueueAll() {
    for (let c = 0; c < this.N; c++) {
      for (let k = 0; k < this.neighbors[c].length; k++) this._enqueue(c, this.neighbors[c][k].dirIndex);
    }
  }

  _clearQueue() {
    this._queue.length = 0;
    this._queued.clear();
    this._queueHead = 0;
  }

  _emit(ev) {
    this.trace.push(ev);
    return ev;
  }

  // 推进一个可观察步骤（一次 pin / 一次删除 / 一次试选 / 一次回溯）。
  // 返回该步骤事件；终态后再调用返回 null。
  step() {
    if (this.status !== STATUS.READY && this.status !== STATUS.RUNNING && this.status !== STATUS.PAUSED) return null;
    this.status = STATUS.RUNNING;
    const ev = this._pump();
    if (ev === null || ev.type === 'solved' || ev.type === 'unsolvable' || ev.type === 'budget_exhausted') {
      // 终态在 _finish 内已设置
    } else {
      this.status = STATUS.PAUSED;
    }
    return ev;
  }

  // 连续运行至终态；可通过 token.cancelled 中断（中断后可继续/单步）。
  // maxEvents 限制单次同步执行的事件数，避免长任务阻塞 UI。
  run(token = { cancelled: false }, maxEvents = 20000) {
    if (this.status === STATUS.READY || this.status === STATUS.PAUSED || this.status === STATUS.RUNNING) {
      let n = 0;
      while (n < maxEvents) {
        if (token.cancelled) {
          this.status = STATUS.PAUSED;
          return { done: false, reason: 'cancelled' };
        }
        const ev = this._pump();
        n++;
        if (ev === null) return { done: true, reason: 'terminal' };
        if (ev.type === 'solved' || ev.type === 'unsolvable' || ev.type === 'budget_exhausted') {
          return { done: true, reason: 'terminal' };
        }
      }
      this.status = STATUS.RUNNING;
      return { done: false, reason: 'yield' };
    }
    return { done: true, reason: 'terminal' };
  }

  cancel() {
    if (this.status === STATUS.RUNNING || this.status === STATUS.PAUSED) {
      this.status = STATUS.CANCELLED;
      this._emit({ type: 'cancelled', trialsUsed: this.trialsUsed });
    }
  }

  _finish(status, ev) {
    this.status = status;
    this._emit(ev);
    return ev;
  }

  // 迭代状态机：每次调用恰好产出一个事件（直到终态返回终态事件本身，之后返回 null），
  // 全程无递归，避免深轨迹下爆栈
  _pump() {
    for (;;) {
      // 上一泵产生了域清空：先发 removal，这一泵补发独立的 contradiction 事件
      if (this._pendingContradiction) {
        const ev = this._pendingContradiction;
        this._pendingContradiction = null;
        this._phase = 'backtrack';
        return this._emit(ev);
      }
      switch (this._phase) {
        case 'pins': {
          const ev = this._doPin();
          if (ev) return ev;
          break;
        }
        case 'propagate': {
          const ev = this._doPropagate();
          if (ev) return ev;
          break;
        }
        case 'decide':
          return this._doDecide();
        case 'trial':
          return this._doTrial();
        case 'backtrack':
          return this._doBacktrack();
        default:
          return null;
      }
    }
  }

  _doPin() {
    if (this._pinCursor >= this.pins.length) {
      // pins 处理完毕（含无 pin 的情况）：初始传播，全部弧入队
      this._enqueueAll();
      this._phase = 'propagate';
      return null;
    }
    const p = this.pins[this._pinCursor++];
    if (this._pinCursor >= this.pins.length) this._enqueueAll();
    const cell = p.y * this.width + p.x;
    const mask = this.domains[cell];
    if (mask === 0) {
      // 交集为空：初始矛盾
      this._enqueueAll();
      this._phase = 'backtrack';
      return this._emit({
        type: 'contradiction',
        phase: 'init',
        cell, x: p.x, y: p.y,
        reason: 'pin_empty',
        detail: `固定地块 (${p.x},${p.y}) 约束交集为空`,
      });
    }
    return this._emit({
      type: 'pin',
      cell, x: p.x, y: p.y,
      allowed: this.maskToIds(mask),
    });
  }

  // 传播：每泵处理队头一条弧，返回该弧产生的第一个删除事件。
  // 有删除 → 弧保留在队头，下一泵继续检查其剩余候选；无删除 → 队头指针推进。
  _doPropagate() {
    if (this._queueHead >= this._queue.length) {
      this._clearQueue();
      this._phase = 'decide';
      return null;
    }
    const arc = this._queue[this._queueHead];
    // neighbors 与 support 同序，直接用邻居在邻接表中的下标取支持掩码
    const nbIndex = this._neighborIndex(arc.cell, arc.dirIndex);
    const nb = this.neighbors[arc.cell][nbIndex];
    const supportMasks = this.support[arc.cell][nbIndex];
    const neighborMask = this.domains[nb.cell];

    for (const tileIdx of Solver.bits(this.domains[arc.cell])) {
      if ((supportMasks[tileIdx] & neighborMask) === 0) {
        this.domains[arc.cell] &= ~(1 << tileIdx);
        const removed = this.tiles[tileIdx].id;
        const remainingMask = this.domains[arc.cell];
        const ev = {
          type: 'removal',
          cell: arc.cell,
          x: arc.cell % this.width,
          y: Math.floor(arc.cell / this.width),
          tile: removed,
          dir: nb.dir,
          dirLabel: DIRS[arc.dirIndex].label,
          neighbor: nb.cell,
          neighborX: nb.cell % this.width,
          neighborY: Math.floor(nb.cell / this.width),
          neighborCandidates: this.maskToIds(neighborMask),
          remaining: this.maskToIds(remainingMask),
        };
        if (remainingMask === 0) {
          // 矛盾：清空队列；本泵先返回 removal，下一泵补发 contradiction，再进入回溯
          this._clearQueue();
          this._pendingContradiction = {
            type: 'contradiction',
            phase: 'propagate',
            cell: arc.cell,
            x: arc.cell % this.width,
            y: Math.floor(arc.cell / this.width),
            reason: 'domain_empty',
            dir: nb.dir,
            neighbor: nb.cell,
            lastRemoved: removed,
          };
          return this._emit(ev);
        }
        // 域缩小：把指向本格的入边重新入队（固定顺序，去重）；当前弧保留队头
        for (let c = 0; c < this.N; c++) {
          this.neighbors[c].forEach((z) => {
            if (z.cell === arc.cell) this._enqueue(c, z.dirIndex);
          });
        }
        return this._emit(ev); // 同弧剩余候选下一泵继续检查
      }
    }
    // 该弧无删除：移出队头
    this._queued.delete(arc.cell * 4 + arc.dirIndex);
    this._queueHead++;
    // 已消费过半时压缩数组，避免长任务下队列无限增长
    if (this._queueHead > 64 && this._queueHead >= this._queue.length / 2) {
      this._queue = this._queue.slice(this._queueHead);
      this._queueHead = 0;
    }
    return null;
  }

  // 预建每格邻居在邻接表中的位置查找（方向 → 下标），避免反复 find/indexOf
  _neighborIndex(cell, dirIndex) {
    let table = this._nbIndexCache?.get(cell);
    if (!table) {
      table = new Map();
      this.neighbors[cell].forEach((nb, i) => table.set(nb.dirIndex, i));
      (this._nbIndexCache ??= new Map()).set(cell, table);
    }
    return table.get(dirIndex);
  }

  _entropy(cell) {
    const mask = this.domains[cell];
    let sum = 0;
    let wlnw = 0;
    for (const i of Solver.bits(mask)) {
      const w = this.weights[i];
      sum += w;
      wlnw += w * Math.log(w);
    }
    return Math.log(sum) - wlnw / sum;
  }

  _doDecide() {
    // 全部单值？
    let target = -1;
    let bestH = Infinity;
    for (let c = 0; c < this.N; c++) {
      const cnt = Solver.popcount(this.domains[c]);
      if (cnt === 0) {
        this._phase = 'backtrack';
        return this._emit({ type: 'contradiction', phase: 'decide', cell: c, reason: 'domain_empty' });
      }
      if (cnt > 1) {
        // 扫描顺序 y,x 天然破同分；差 <=1e-12 视为相同，保留先出现者
        const h = this._entropy(c);
        if (h < bestH - EPS) {
          bestH = h;
          target = c;
        }
      }
    }
    if (target === -1) {
      // 全单值：最终校验所有邻边合法后求解
      for (let c = 0; c < this.N; c++) {
        for (let k = 0; k < this.neighbors[c].length; k++) {
          const nb = this.neighbors[c][k];
          const t = Solver.bits(this.domains[c]).next().value;
          const u = Solver.bits(this.domains[nb.cell]).next().value;
          if (this.tiles[t].edges[nb.dirIndex] !== this.tiles[u].edges[DIRS[nb.dirIndex].opposite]) {
            this._phase = 'backtrack';
            return this._emit({
              type: 'contradiction', phase: 'final_check', cell: c, reason: 'edge_mismatch',
              detail: `格 ${c} 与格 ${nb.cell} 的${DIRS[nb.dirIndex].label}边不兼容`,
            });
          }
        }
      }
      for (let c = 0; c < this.N; c++) this.assignment[c] = Solver.bits(this.domains[c]).next().value;
      return this._finish(STATUS.SOLVED, {
        type: 'solved',
        trialsUsed: this.trialsUsed,
        budget: this.budget,
      });
    }

    // 按 id 升序列出剩余候选，加权抽取并移除，形成完整试选顺序；单候选直接加入
    const idxs = [...Solver.bits(this.domains[target])].sort((a, b) => {
      const ia = this.tiles[a].id;
      const ib = this.tiles[b].id;
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    const order = [];
    if (idxs.length === 1) {
      order.push(idxs[0]);
    } else {
      const pool = idxs.slice();
      while (pool.length > 1) {
        let total = 0;
        for (const i of pool) total += this.weights[i];
        const r = this.rng.next();
        let acc = 0;
        let chosen = pool[pool.length - 1];
        for (let k = 0; k < pool.length; k++) {
          acc += this.weights[pool[k]];
          if (r * total < acc) { chosen = pool[k]; break; }
        }
        order.push(chosen);
        pool.splice(pool.indexOf(chosen), 1);
      }
      order.push(pool[0]); // 最后一个不再调用随机数
    }

    const snapshot = this.domains.slice();
    this._node = {
      cell: target,
      order,
      cursor: 0,
      rngState: this.rng.snapshot(),
      snapshot,
    };
    this._stack.push(this._node);
    this._phase = 'trial';
    return this._emit({
      type: 'select',
      cell: target,
      x: target % this.width,
      y: Math.floor(target / this.width),
      candidates: idxs.map((i) => this.tiles[i].id),
      trialOrder: order.map((i) => this.tiles[i].id),
      entropy: bestH === Infinity ? null : bestH,
      rngState: this.rng.snapshot(),
      depth: this._stack.length,
    });
  }

  _doTrial() {
    const node = this._node;
    if (node.cursor >= node.order.length) {
      // 该节点所有试选均失败：交给回溯阶段
      this._phase = 'backtrack';
      return null;
    }
    if (this.trialsUsed >= this.budget) {
      // 需要下一次试选但预算用尽
      return this._finish(STATUS.BUDGET_EXHAUSTED, {
        type: 'budget_exhausted',
        trialsUsed: this.trialsUsed,
        budget: this.budget,
        cell: node.cell,
      });
    }
    const tileIdx = node.order[node.cursor++];
    this.trialsUsed++;
    this.domains[node.cell] = 1 << tileIdx;

    // 全量弧入队：与初始传播保持完全一致的固定处理顺序，保证确定性轨迹。
    // 未受影响的弧 Revise 自然无删除，正确性不受影响（AC-3 允许超集入队）。
    this._enqueueAll();
    this._phase = 'propagate';
    return this._emit({
      type: 'trial',
      cell: node.cell,
      x: node.cell % this.width,
      y: Math.floor(node.cell / this.width),
      tile: this.tiles[tileIdx].id,
      trialIndex: node.cursor - 1,
      trialsUsed: this.trialsUsed,
      depth: this._stack.length,
    });
  }

  _doBacktrack() {
    if (this._stack.length === 0) {
      // 搜索穷尽：证明无解
      return this._finish(STATUS.UNSOLVABLE, {
        type: 'unsolvable',
        trialsUsed: this.trialsUsed,
        budget: this.budget,
      });
    }
    const node = this._stack[this._stack.length - 1];
    if (node.cursor >= node.order.length) {
      // 节点耗尽：弹出，恢复到进入该分支前的候选域，继续回溯
      this._stack.pop();
      this.domains.set(node.snapshot);
      this._node = this._stack[this._stack.length - 1] || null;
      this._clearQueue();
      this._phase = 'backtrack';
      return this._emit({
        type: 'backtrack',
        cell: node.cell,
        x: node.cell % this.width,
        y: Math.floor(node.cell / this.width),
        exhausted: true,
        restoredTo: 'parent',
        depth: this._stack.length,
        rngState: this.rng.snapshot(), // 随机状态不回退
      });
    }
    // 节点还有未试候选：恢复分支前域，回到 trial 阶段试下一个
    this.domains.set(node.snapshot);
    this._clearQueue();
    this._phase = 'trial';
    return this._emit({
      type: 'backtrack',
      cell: node.cell,
      x: node.cell % this.width,
      y: Math.floor(node.cell / this.width),
      exhausted: false,
      nextTrialIndex: node.cursor,
      depth: this._stack.length,
      rngState: this.rng.snapshot(),
    });
  }

  // 深拷贝当前求解状态（供轨迹回放的检查点分叉使用）
  clone() {
    const copy = Object.create(Solver.prototype);
    copy.width = this.width;
    copy.height = this.height;
    copy.tiles = this.tiles;                   // 不可变配置，共享
    copy.tileCount = this.tileCount;
    copy.idToIndex = this.idToIndex;
    copy.weights = this.weights;               // 不可变
    copy.wrapX = this.wrapX;
    copy.wrapY = this.wrapY;
    copy.seed = this.seed;
    copy.budget = this.budget;
    copy.pins = this.pins;
    copy.N = this.N;
    copy.neighbors = this.neighbors;
    copy.support = this.support;
    copy.domains = this.domains.slice();
    copy.rng = new LCG(this.rng.snapshot());
    copy.status = this.status;
    copy.trialsUsed = this.trialsUsed;
    copy.trace = this.trace.slice();
    copy.assignment = this.assignment.slice();
    copy._phase = this._phase;
    copy._pinCursor = this._pinCursor;
    copy._queue = this._queue.map((a) => ({ ...a }));
    copy._queued = new Set(this._queued);
    copy._queueHead = this._queueHead;
    copy._node = this._node ? { ...this._node, snapshot: this._node.snapshot.slice() } : null;
    copy._stack = this._stack.map((n) => ({ ...n, snapshot: n.snapshot.slice() }));
    copy._pendingContradiction = this._pendingContradiction ? { ...this._pendingContradiction } : null;
    copy._nbIndexCache = this._nbIndexCache; // 纯派生缓存，共享即可
    return copy;
  }

  // ---- 结果导出辅助 ----
  getGrid() {
    const grid = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        const c = y * this.width + x;
        const cnt = Solver.popcount(this.domains[c]);
        row.push(cnt === 1 ? this.tiles[Solver.bits(this.domains[c]).next().value].id : null);
      }
      grid.push(row);
    }
    return grid;
  }

  getCandidateGrid() {
    const grid = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        row.push(this.maskToIds(this.domains[y * this.width + x]));
      }
      grid.push(row);
    }
    return grid;
  }

  exportConfig() {
    return {
      format: 'wfc-tile-foundry-config',
      version: 1,
      width: this.width,
      height: this.height,
      wrap_x: this.wrapX,
      wrap_y: this.wrapY,
      seed: this.seed,
      budget: this.budget,
      tiles: this.tiles.map((t) => ({ id: t.id, weight: t.weight, edges: t.edges, color: t.color })),
      pins: this.pins.map((p) => ({ x: p.x, y: p.y, allowed: p.allowed })),
    };
  }

  exportTrace() {
    let finalGrid = null;
    if (this.status === STATUS.SOLVED) finalGrid = this.getGrid();
    return {
      format: 'wfc-tile-foundry-trace',
      version: 1,
      config: this.exportConfig(),
      status: this.status,
      trialsUsed: this.trialsUsed,
      rngFinalState: this.rng.snapshot(),
      grid: finalGrid,
      trace: this.trace,
    };
  }
}
