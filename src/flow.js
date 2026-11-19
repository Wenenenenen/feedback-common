/*!
 * flow.js — 小队流场寻路核心引擎（无 DOM 依赖，浏览器与 Node 共用）
 *
 * 约定见 cases/格式说明.md：
 *  - 尺寸 k 的单位占 k×k 格，以左上角为锚点；锚点可通行 = k×k 块全在地图内且无墙。
 *  - 锚点代价 = 块内各格代价最大值（, = 3，. / G = 1）。
 *  - 尺寸 k 的目标锚点 = 可通行且 k×k 块覆盖至少一个 G，积分值为 0。
 *  - 八方向扩展：步进代价取“被扩展的一格”（离目标较远的一格）的代价 ×10，斜向 ×14；
 *    斜向要求两个同侧正交相邻锚点都可通行（不能斜穿墙角）。
 *  - 流场方向：指向积分值最小的可通行相邻锚点，并列按 N, NE, E, SE, S, SW, W, NW。
 *  - 单位每帧最多走一格，按 id 升序决定，可等待；占块不得重叠、不得进入不可通行格；
 *    覆盖 G 即到达。
 *
 * 增量重算：地形改变后逐尺寸求出受影响锚点（k×k 块覆盖改动格），再沿父指针依赖树
 * 向下失效所有旧最短路经过改动区的锚点；未失效锚点保留旧值作为上界，随后只在这个
 * 集合上跑 Dijkstra（边界以未失效邻居为种子）。因为未失效值始终是可达上界，所以
 * 结果与全图重算逐位一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowField = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIRS = [
    { name: 'N', dx: 0, dy: -1, mult: 10 },
    { name: 'NE', dx: 1, dy: -1, mult: 14 },
    { name: 'E', dx: 1, dy: 0, mult: 10 },
    { name: 'SE', dx: 1, dy: 1, mult: 14 },
    { name: 'S', dx: 0, dy: 1, mult: 10 },
    { name: 'SW', dx: -1, dy: 1, mult: 14 },
    { name: 'W', dx: -1, dy: 0, mult: 10 },
    { name: 'NW', dx: -1, dy: -1, mult: 14 },
  ];
  const COST = Object.freeze({ '.': 1, ',': 3, G: 1 });
  const SIZES = [1, 2, 3];
  const INF = 0x3fffffff;

  function isLegalChar(ch) { return COST[ch] !== undefined || ch === '#'; }
  function hasCost(ch) { return COST[ch] !== undefined; }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /* ------------------------------------------------------------------ *
   * 地图与校验
   * ------------------------------------------------------------------ */

  function parseMap(input) {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('地图必须是 JSON 对象');
    }
    const rows = obj.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('地图必须包含至少一行 rows');
    const height = rows.length;
    const width = String(rows[0]).length;
    if (!width) throw new Error('rows 不能有空行');
    for (let y = 0; y < height; y++) {
      if (typeof rows[y] !== 'string') throw new Error(`第 ${y} 行不是字符串`);
      if (rows[y].length !== width) {
        throw new Error(`第 ${y} 行长度 ${rows[y].length} 与第 0 行长度 ${width} 不一致`);
      }
      for (let x = 0; x < width; x++) {
        const ch = rows[y][x];
        if (!isLegalChar(ch)) {
          throw new Error(`第 ${y} 行第 ${x} 列出现非法字符 "${ch}"（只允许 . , # G）`);
        }
      }
    }
    return {
      width,
      height,
      rows: rows.slice(),
      grid: rows.map(r => r.split('')),
    };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.size && b.x < a.x + a.size &&
           a.y < b.y + b.size && b.y < a.y + a.size;
  }

  function cellCost(ch) {
    return hasCost(ch) ? COST[ch] : null;
  }

  function inMap(map, x, y) {
    return Number.isInteger(x) && Number.isInteger(y) &&
           x >= 0 && y >= 0 && x < map.width && y < map.height;
  }

  function blockBlocked(grid, x, y, size) {
    for (let dy = 0; dy < size; dy++) {
      const row = grid[y + dy];
      for (let dx = 0; dx < size; dx++) {
        if (row[x + dx] === '#') return true;
      }
    }
    return false;
  }

  function blockCoversGoal(grid, x, y, size) {
    for (let dy = 0; dy < size; dy++) {
      const row = grid[y + dy];
      for (let dx = 0; dx < size; dx++) {
        if (row[x + dx] === 'G') return true;
      }
    }
    return false;
  }

  /** 锚点代价 = 块内格代价最大值；有墙或越界返回 null。 */
  function blockCost(grid, x, y, size) {
    let max = 0;
    for (let dy = 0; dy < size; dy++) {
      const row = grid[y + dy];
      if (!row) return null;
      for (let dx = 0; dx < size; dx++) {
        const c = COST[row[x + dx]];
        if (c === undefined) return null;
        if (c > max) max = c;
      }
    }
    return max;
  }

  /**
   * 校验单位列表。返回 { units, warnings }。
   * 初始占块重叠不作为致命错误（slit.json 样例即如此，用于演示脱离重叠），
   * 但会在 warnings 中报告；模拟过程中绝不允许产生新的重叠。
   */
  function validateUnits(rawUnits, map) {
    if (rawUnits === undefined || rawUnits === null) rawUnits = [];
    if (!Array.isArray(rawUnits)) throw new Error('units 必须是数组');
    const units = [];
    const warnings = [];
    const seenIds = new Set();
    for (let i = 0; i < rawUnits.length; i++) {
      const u = rawUnits[i];
      const label = `单位 #${i}` + (u && u.id !== undefined ? `（id=${u.id}）` : '');
      if (!u || typeof u !== 'object') throw new Error(`${label} 不是对象`);
      if (!Number.isInteger(u.id) || u.id < 0) throw new Error(`${label} 的 id 必须是非负整数`);
      if (seenIds.has(u.id)) throw new Error(`${label} 的 id 重复`);
      seenIds.add(u.id);
      if (!SIZES.includes(u.size)) throw new Error(`${label} 的 size 必须是 1、2 或 3`);
      if (!Number.isInteger(u.x) || !Number.isInteger(u.y)) {
        throw new Error(`${label} 的 x/y 必须是整数`);
      }
      if (u.x < 0 || u.y < 0 || u.x + u.size > map.width || u.y + u.size > map.height) {
        throw new Error(`${label} 的 ${u.size}×${u.size} 占块超出地图（锚点 ${u.x},${u.y}）`);
      }
      if (blockBlocked(map.grid, u.x, u.y, u.size)) {
        throw new Error(`${label} 的 ${u.size}×${u.size} 占块覆盖了墙（锚点 ${u.x},${u.y}）`);
      }
      for (const b of units) {
        if (rectsOverlap(u, b)) {
          warnings.push(`单位 id=${u.id} 与 id=${b.id} 初始占块重叠（${u.x},${u.y} / ${b.x},${b.y}）`);
        }
      }
      units.push({ id: u.id, size: u.size, x: u.x, y: u.y });
    }
    return { units, warnings };
  }

  /* ------------------------------------------------------------------ *
   * 锚点几何
   * ------------------------------------------------------------------ */

  function buildGeometry(map) {
    const geo = {};
    for (const k of SIZES) {
      const W = Math.max(0, map.width - k + 1);
      const H = Math.max(0, map.height - k + 1);
      const n = W * H;
      const pass = new Uint8Array(n);
      const goal = new Uint8Array(n);
      const cost = new Int32Array(n);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const c = blockCost(map.grid, x, y, k);
          if (c === null) continue;
          pass[i] = 1;
          cost[i] = c;
          goal[i] = blockCoversGoal(map.grid, x, y, k) ? 1 : 0;
        }
      }
      geo[k] = { size: k, W, H, pass, goal, cost };
    }
    return geo;
  }

  function refreshAnchor(geoK, map, ax, ay) {
    const i = ay * geoK.W + ax;
    const c = blockCost(map.grid, ax, ay, geoK.size);
    if (c === null) {
      geoK.pass[i] = 0; geoK.cost[i] = 0; geoK.goal[i] = 0;
    } else {
      geoK.pass[i] = 1; geoK.cost[i] = c;
      geoK.goal[i] = blockCoversGoal(map.grid, ax, ay, geoK.size) ? 1 : 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 最小堆
   * ------------------------------------------------------------------ */

  function Heap(capacity) {
    this.keys = new Float64Array(Math.max(16, capacity | 0));
    this.vals = new Int32Array(Math.max(16, capacity | 0));
    this.size = 0;
  }
  Heap.prototype.push = function (key, val) {
    if (this.size >= this.keys.length) {
      const cap = this.keys.length * 2;
      const nk = new Float64Array(cap); nk.set(this.keys);
      const nv = new Int32Array(cap); nv.set(this.vals);
      this.keys = nk; this.vals = nv;
    }
    const keys = this.keys, vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = key; vals[i] = val;
  };
  Heap.prototype.pop = function () {
    const keys = this.keys, vals = this.vals;
    const topKey = keys[0], topVal = vals[0];
    const n = --this.size;
    if (n === 0) return [topKey, topVal];
    const lastKey = keys[n], lastVal = vals[n];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= lastKey) break;
      keys[i] = keys[c]; vals[i] = vals[c];
      i = c;
    }
    keys[i] = lastKey; vals[i] = lastVal;
    return [topKey, topVal];
  };

  /* ------------------------------------------------------------------ *
   * 场：积分 / 方向 / 父指针
   * ------------------------------------------------------------------ */

  function newField(geoK, size) {
    const n = geoK.W * geoK.H;
    const field = {
      size,
      W: geoK.W,
      H: geoK.H,
      pass: geoK.pass,
      goal: geoK.goal,
      cost: geoK.cost,
      integration: new Int32Array(n),
      direction: new Int8Array(n),
      // 依赖 DAG：downhill[v] = 所有“下坡邻居”（积分值更小的合法邻居）。
      // 一个锚点的积分值只取决于它的下坡邻居的积分值。
      downhill: null,
    };
    field.integration.fill(-1);
    field.direction.fill(-1);
    return field;
  }

  function diagonalOK(pass, W, x, y, dx, dy) {
    return pass[y * W + x + dx] === 1 && pass[(y + dy) * W + x] === 1;
  }

  /** 从 (x,y) 沿 dir 走一步是否合法：目标在界内且可通行；斜向还要求两侧正交格可通行。 */
  function stepAllowed(geoK, x, y, dir) {
    const nx = x + dir.dx, ny = y + dir.dy;
    if (nx < 0 || ny < 0 || nx >= geoK.W || ny >= geoK.H) return false;
    if (geoK.pass[ny * geoK.W + nx] !== 1) return false;
    if (dir.dx !== 0 && dir.dy !== 0) {
      return diagonalOK(geoK.pass, geoK.W, x, y, dir.dx, dir.dy);
    }
    return true;
  }

  /** 方向：积分值最小的可走邻居；并列按 DIRS 顺序。目标与不可达返回 -1。 */
  function computeDirectionAt(field, geoK, x, y) {
    const i = y * geoK.W + x;
    if (!geoK.pass[i] || geoK.goal[i] || field.integration[i] < 0) return -1;
    let best = -1, bestVal = INF;
    for (let q = 0; q < 8; q++) {
      const dir = DIRS[q];
      if (!stepAllowed(geoK, x, y, dir)) continue;
      const v = field.integration[(y + dir.dy) * geoK.W + (x + dir.dx)];
      if (v < 0) continue;
      if (v < bestVal) { bestVal = v; best = q; }
    }
    return best;
  }

  function refreshDirections(field, geoK, indices) {
    for (const i of indices) {
      const x = i % geoK.W, y = (i / geoK.W) | 0;
      field.direction[i] = computeDirectionAt(field, geoK, x, y);
    }
  }

  function fullIntegrate(field, geoK) {
    const { W, H, pass, cost, goal } = geoK;
    const integ = field.integration;
    const n = W * H;
    integ.fill(-1);

    const heap = new Heap(n + 8);
    const done = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (pass[i] && goal[i]) { integ[i] = 0; heap.push(0, i); }
    }
    while (heap.size) {
      const [d, i] = heap.pop();
      if (done[i] || d !== integ[i]) continue;
      done[i] = 1;
      const x = i % W, y = (i / W) | 0;
      for (let q = 0; q < 8; q++) {
        const dir = DIRS[q];
        if (!stepAllowed(geoK, x, y, dir)) continue;
        const ni = (y + dir.dy) * W + (x + dir.dx);
        if (done[ni]) continue;
        const nd = d + cost[ni] * dir.mult;
        if (integ[ni] < 0 || nd < integ[ni]) {
          integ[ni] = nd;
          heap.push(nd, ni);
        }
      }
    }

    // 方向全量（按 DIRS 顺序优先）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        field.direction[y * W + x] = computeDirectionAt(field, geoK, x, y);
      }
    }
    field.downhill = buildDownhill(field, geoK);
    return field;
  }

  /* ------------------------------------------------------------------ *
   * 增量重算
   *
   * 核心事实：进入 v 的边权只取决于 v 自己的代价与方向倍数
   * （Dijkstra 中“被扩展的一格”永远是 v），因此
   *     integ[v] = min over 合法邻居 u ( integ[u] + cost[v] * mult )
   * 且能取到最小值的 u 必然满足 integ[u] < integ[v]（因为 mult ≥ 10 > 0）。
   *
   * 所以 v 的值只依赖它的“下坡邻居”集合。地形改动时：
   *   1) 种子 = 覆盖改动格的锚点；沿旧下坡依赖反向传播，得到必须重算的集合（覆盖值升高）。
   *   2) 在该集合上跑 Dijkstra，边界以集合外邻居的旧值作种子（旧值是可达到的上界）。
   *   3) 若集合外的邻居能通过集合内更小的新值被降低，把它拉进来继续松弛（覆盖值降低）。
   * 集合外的值不变或降低，集合内的值由 Dijkstra 精确求出，故与全量重算逐位一致。
   * ------------------------------------------------------------------ */

  /** downhill[v] = v 的所有下坡邻居（积分值更小、且 v 走的合法方向）。 */
  function buildDownhill(field, geoK) {
    const { W, H, pass, goal } = geoK;
    const integ = field.integration;
    const n = W * H;
    const list = new Array(n);
    for (let i = 0; i < n; i++) list[i] = null;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!pass[i] || goal[i] || integ[i] < 0) continue;
        const arr = [];
        for (let q = 0; q < 8; q++) {
          const dir = DIRS[q];
          if (!stepAllowed(geoK, x, y, dir)) continue;
          const ni = (y + dir.dy) * W + (x + dir.dx);
          if (integ[ni] >= 0 && integ[ni] < integ[i]) arr.push(ni);
        }
        list[i] = arr;
      }
    }
    return { list, reverse: buildReverse(n, list) };
  }

  function buildReverse(n, list) {
    const reverse = new Array(n);
    for (let i = 0; i < n; i++) reverse[i] = null;
    for (let v = 0; v < n; v++) {
      const arr = list[v];
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const u = arr[j];
        if (!reverse[u]) reverse[u] = [];
        reverse[u].push(v);
      }
    }
    return reverse;
  }

  /** 局部重建依赖：影响 dirSet 内锚点自身和指向它们的锚点。 */
  function updateDownhill(field, geoK, dirSet) {
    const { W, H, pass, goal } = geoK;
    const integ = field.integration;
    const n = W * H;
    const list = field.downhill.list;
    const reverse = field.downhill.reverse;
    const dirty = new Set(dirSet);
    for (const i of dirSet) {
      const x = i % W, y = (i / W) | 0;
      for (let q = 0; q < 8; q++) {
        const nx = x + DIRS[q].dx, ny = y + DIRS[q].dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        dirty.add(ny * W + nx);
      }
    }
    // 先摘除旧的反向引用
    for (const i of dirty) {
      const old = list[i];
      if (!old) continue;
      for (const u of old) {
        const arr = reverse[u];
        if (!arr) continue;
        const at = arr.indexOf(i);
        if (at >= 0) arr.splice(at, 1);
      }
    }
    for (const i of dirty) {
      if (!pass[i] || goal[i] || integ[i] < 0) { list[i] = null; continue; }
      const x = i % W, y = (i / W) | 0;
      const arr = [];
      for (let q = 0; q < 8; q++) {
        const dir = DIRS[q];
        if (!stepAllowed(geoK, x, y, dir)) continue;
        const ni = (y + dir.dy) * W + (x + dir.dx);
        if (integ[ni] >= 0 && integ[ni] < integ[i]) arr.push(ni);
      }
      list[i] = arr;
      for (const u of arr) {
        if (!reverse[u]) reverse[u] = [];
        if (!reverse[u].includes(i)) reverse[u].push(i);
      }
    }
    void n;
  }

  /**
   * 增量重算。seedIdx：几何已更新、值需重新确定的锚点索引。
   * 返回 { invalidated, improved, recomputed, changedValues, ms }。
   */
  function incrementalIntegrate(field, geoK, seedIdx, t0) {
    const { W, H, pass, cost, goal } = geoK;
    const integ = field.integration;
    const n = W * H;
    const downhill = field.downhill;

    // 1) 失效集：种子 + 旧依赖的反向传播
    const invalid = new Uint8Array(n);
    const stack = [];
    for (const s of seedIdx) {
      if (s < 0 || s >= n || invalid[s]) continue;
      invalid[s] = 1;
      stack.push(s);
    }
    while (stack.length) {
      const u = stack.pop();
      const dependents = downhill.reverse[u];
      if (!dependents) continue;
      for (let j = 0; j < dependents.length; j++) {
        const v = dependents[j];
        if (invalid[v]) continue;
        invalid[v] = 1;
        stack.push(v);
      }
    }
    const affected = [];
    for (let i = 0; i < n; i++) if (invalid[i]) affected.push(i);

    // 2) 失效区重置；目标为 0 种子，其余待定
    const tentative = new Map();
    const heap = new Heap(affected.length * 8 + 32);
    for (const i of affected) {
      if (pass[i] && goal[i]) {
        integ[i] = 0;
        tentative.set(i, 0);
        heap.push(0, i);
      } else if (!pass[i]) {
        integ[i] = -1;
      } else {
        integ[i] = INF;
      }
    }

    // 3) 边界种子：集合外邻居的旧值向内松弛（旧值是上界）
    for (const i of affected) {
      if (!pass[i] || goal[i]) continue;
      const x = i % W, y = (i / W) | 0;
      for (let q = 0; q < 8; q++) {
        const dir = DIRS[q];
        const nx = x + dir.dx, ny = y + dir.dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (invalid[ni] || !pass[ni] || integ[ni] < 0) continue;
        if (!stepAllowed(geoK, x, y, dir)) continue;
        const cand = integ[ni] + cost[i] * dir.mult;
        const cur = tentative.get(i);
        if (cur === undefined || cand < cur) {
          tentative.set(i, cand);
          heap.push(cand, i);
        }
      }
    }

    // 4) Dijkstra：集合内正常松弛；集合外只在能降低时拉进来并继续
    const settled = new Uint8Array(n);
    const improved = [];
    while (heap.size) {
      const [d, i] = heap.pop();
      if (settled[i]) continue;
      if (invalid[i]) {
        if (d !== tentative.get(i)) continue;
      } else if (d !== integ[i]) continue;
      settled[i] = 1;
      const x = i % W, y = (i / W) | 0;
      for (let q = 0; q < 8; q++) {
        const dir = DIRS[q];
        if (!stepAllowed(geoK, x, y, dir)) continue;
        const ni = (y + dir.dy) * W + (x + dir.dx);
        if (settled[ni]) continue;
        const nd = d + cost[ni] * dir.mult;
        if (invalid[ni]) {
          const cur = tentative.get(ni);
          if (cur === undefined || nd < cur) {
            tentative.set(ni, nd);
            heap.push(nd, ni);
          }
        } else if (integ[ni] < 0 || nd < integ[ni]) {
          if (integ[ni] < 0) improved.push(ni);
          else improved.push(ni);
          integ[ni] = nd;
          heap.push(nd, ni);
        }
      }
    }

    // 5) 落定失效区
    let changedValues = 0;
    for (const i of affected) {
      const tv = tentative.get(i);
      const v = pass[i] && tv !== undefined && tv < INF ? tv : -1;
      if (integ[i] !== v) changedValues++;
      integ[i] = v;
    }

    // 6) 方向：失效/被降低的锚点及其邻居（邻居方向可能指向数值变了的锚点）
    const dirSet = new Set();
    const touched = affected.concat(improved);
    for (const i of touched) {
      dirSet.add(i);
      const x = i % W, y = (i / W) | 0;
      for (let q = 0; q < 8; q++) {
        const nx = x + DIRS[q].dx, ny = y + DIRS[q].dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        dirSet.add(ny * W + nx);
      }
    }
    refreshDirections(field, geoK, dirSet);
    updateDownhill(field, geoK, dirSet);

    // 供界面高亮“受影响区域”：失效集与额外被降低的锚点
    return {
      invalidated: affected.length,
      improved: improved.length,
      recomputed: touched.length,
      changedValues,
      affected,
      improvedList: improved,
      ms: now() - t0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 引擎
   * ------------------------------------------------------------------ */

  function createEngine(mapInput) {
    const map = parseMap(mapInput);
    const { units, warnings } = validateUnits(mapInput.units, map);
    const engine = {
      map,
      geo: buildGeometry(map),
      fields: {},
      initialUnits: units.map(u => ({ ...u })),
      warnings,
      stats: { version: 0, lastRecompute: null, lastFullMs: 0 },
    };
    for (const k of SIZES) {
      const field = newField(engine.geo[k], k);
      fullIntegrate(field, engine.geo[k]);
      engine.fields[k] = field;
    }
    resetSim(engine);
    return engine;
  }

  function recomputeAll(engine) {
    const t0 = now();
    engine.geo = buildGeometry(engine.map);
    for (const k of SIZES) {
      const field = newField(engine.geo[k], k);
      fullIntegrate(field, engine.geo[k]);
      engine.fields[k] = field;
    }
    engine.stats.version++;
    engine.stats.lastFullMs = now() - t0;
    return { ms: engine.stats.lastFullMs };
  }

  /**
   * 修改地形并增量重算。edits: [{x,y,ch}]，返回统计。
   */
  function applyTerrainEdits(engine, edits) {
    const t0 = now();
    const changed = [];
    for (const e of edits) {
      if (!inMap(engine.map, e.x, e.y)) throw new Error(`地形改动坐标越界：(${e.x},${e.y})`);
      if (!isLegalChar(e.ch)) throw new Error(`地形改动出现非法字符 "${e.ch}"`);
      if (engine.map.grid[e.y][e.x] === e.ch) continue;
      engine.map.grid[e.y][e.x] = e.ch;
      engine.map.rows[e.y] = engine.map.grid[e.y].join('');
      changed.push({ x: e.x, y: e.y, ch: e.ch });
    }
    if (!changed.length) return { changed: 0, perSize: {}, ms: now() - t0 };

    const perSize = {};
    for (const k of SIZES) {
      const geoK = engine.geo[k];
      const seedSet = new Set();
      for (const e of changed) {
        for (let ay = e.y - k + 1; ay <= e.y; ay++) {
          for (let ax = e.x - k + 1; ax <= e.x; ax++) {
            if (ax < 0 || ay < 0 || ax >= geoK.W || ay >= geoK.H) continue;
            seedSet.add(ay * geoK.W + ax);
          }
        }
      }
      const seeds = Array.from(seedSet);
      for (const i of seeds) refreshAnchor(geoK, engine.map, i % geoK.W, (i / geoK.W) | 0);
      // 斜向规则使一个锚点能否斜走取决于它的正交邻居；几何变化须连带其八邻域一起失效
      const expanded = new Set(seeds);
      for (const i of seeds) {
        const x = i % geoK.W, y = (i / geoK.W) | 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= geoK.W || ny >= geoK.H) continue;
            expanded.add(ny * geoK.W + nx);
          }
        }
      }
      perSize[k] = incrementalIntegrate(engine.fields[k], geoK, Array.from(expanded), t0);
    }
    engine.stats.version++;
    const out = { changed: changed.length, cells: changed, perSize, ms: now() - t0 };
    engine.stats.lastRecompute = out;
    return out;
  }

  /**
   * 用全量重算核对增量结果；不改变引擎状态。
   * 返回 {1:{identical,valueDiffs,directionDiffs,sample}, 2:..., 3:...}
   */
  function verifyIncremental(engine) {
    const fresh = buildGeometry(engine.map);
    const results = {};
    for (const k of SIZES) {
      const geoK = fresh[k];
      const full = newField(geoK, k);
      fullIntegrate(full, geoK);
      const inc = engine.fields[k];
      let valueDiffs = 0, directionDiffs = 0;
      const sample = [];
      for (let i = 0; i < full.integration.length; i++) {
        if (full.integration[i] !== inc.integration[i]) {
          valueDiffs++;
          if (sample.length < 20) {
            sample.push({ x: i % geoK.W, y: (i / geoK.W) | 0, full: full.integration[i], inc: inc.integration[i] });
          }
        }
        if (full.direction[i] !== inc.direction[i]) directionDiffs++;
      }
      results[k] = {
        identical: valueDiffs === 0 && directionDiffs === 0,
        valueDiffs, directionDiffs, sample,
        nodes: geoK.W * geoK.H,
      };
    }
    return results;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  /** 积分场导出（行优先，按原地图坐标；不可通行的锚点为 null）。 */
  function integrationExport(engine, size) {
    const field = engine.fields[size];
    const { width, height } = engine.map;
    const integration = new Array(width * height).fill(null);
    const direction = new Array(width * height).fill(null);
    for (let y = 0; y < field.H; y++) {
      for (let x = 0; x < field.W; x++) {
        const i = y * field.W + x;
        if (!field.pass[i]) continue;
        const o = y * width + x;
        integration[o] = field.integration[i] >= 0 ? field.integration[i] : null;
        const d = field.direction[i];
        direction[o] = d >= 0 ? DIRS[d].name : null;
      }
    }
    return { size, width, height, integration, direction };
  }

  function trajectoryExport(engine) {
    const sim = engine.sim;
    return {
      width: engine.map.width,
      height: engine.map.height,
      frames: sim.frames.map(f => ({
        frame: f.frame,
        units: f.units.map(u => ({ id: u.id, size: u.size, x: u.x, y: u.y })),
      })),
      arrivals: sim.arrivals.map(a => ({ id: a.id, size: a.size, frame: a.frame })),
      unreachable: sim.unreachableIds.slice(),
      blocked: sim.blockedIds.slice(),
      blockedFrames: sim.blockedIds.map(id => ({ id, frame: sim.blockedFrames[id] ?? null })),
      finished: sim.finished,
      deadlock: !!sim.deadlock,
      deadlockedIds: (sim.deadlockedIds || []).slice(),
      totalFrames: sim.frames.length - 1,
    };
  }

  /* ------------------------------------------------------------------ *
   * 模拟
   *
   * 核心不变量（抑抖）：单位一旦移动，积分值必须严格下降。积分场在一次模拟中
   * 不变，因此单位永远不会回到曾经走过的更近的格子，也不可能 A-B-A 来回抖动。
   * 只有两种受控例外：
   *   - 分离初始重叠（样例 slit.json 故意给出重叠），允许一次任意方向的合法移动；
   *   - 死锁退让，允许一次积分值上升的移动，并伴随“停驻 + 禁忌源格”，
   *     确保退让后不会立刻回到原格形成循环。
   * 其余情况一律原地等待（门口排队即等待，无需侧移）。
   * ------------------------------------------------------------------ */

  function resetSim(engine) {
    const units = engine.initialUnits.map(u => ({
      id: u.id, size: u.size, x: u.x, y: u.y,
      waitFrames: 0,
      holdFrames: 0,
      tabu: null,          // {x,y,until} 退让后禁止短时间内回到的格子
      retreats: 0,
      bestValue: Infinity,
      unreachable: false,
      blocked: false,
      overlapStuckFrames: 0,
    }));
    const sim = {
      frame: 0,
      units,
      arrivals: [],
      frames: [],
      yields: [],
      events: [],
      finished: false,
      deadlock: false,
      deadlockedIds: [],
      stalledFrames: 0,
      noProgressFrames: 0,
      unreachableIds: [],
      blockedIds: [],
      blockedFrames: {},
    };
    for (const u of units) {
      if (blockCoversGoal(engine.map.grid, u.x, u.y, u.size)) {
        sim.arrivals.push({ id: u.id, size: u.size, frame: 0 });
        u.arrivedAtStart = true;
      }
    }
    sim.units = units.filter(u => !u.arrivedAtStart);
    for (const u of sim.units) {
      refreshUnreachable(engine, u);
      u.bestValue = integrationOf(engine, u);
    }
    sim.unreachableIds = sim.units.filter(u => u.unreachable).map(u => u.id);
    sim.frames.push(frameSnapshot(sim));
    sim.finished = sim.units.filter(u => !u.unreachable && !u.blocked).length === 0;
    engine.sim = sim;
    return sim;
  }

  function refreshUnreachable(engine, u) {
    const field = engine.fields[u.size];
    const i = u.y * field.W + u.x;
    u.unreachable = !(field.pass[i] && field.integration[i] >= 0);
  }

  function frameSnapshot(sim) {
    return { frame: sim.frame, units: sim.units.map(u => ({ id: u.id, size: u.size, x: u.x, y: u.y })) };
  }

  function integrationOf(engine, u) {
    const field = engine.fields[u.size];
    return field.integration[u.y * field.W + u.x];
  }

  /** (x,y) -> (nx,ny) 对尺寸 k 是否合法（不查单位）。 */
  function anchorMoveAllowed(engine, size, x, y, nx, ny) {
    const field = engine.fields[size];
    if (nx < 0 || ny < 0 || nx >= field.W || ny >= field.H) return false;
    if (!field.pass[ny * field.W + nx]) return false;
    const dx = nx - x, dy = ny - y;
    if (dx !== 0 && dy !== 0) {
      return field.pass[y * field.W + x + dx] === 1 && field.pass[(y + dy) * field.W + x] === 1;
    }
    return true;
  }

  function blockedByUnits(sim, unit, nx, ny) {
    for (const o of sim.units) {
      if (o === unit) continue;
      if (nx < o.x + o.size && o.x < nx + unit.size &&
          ny < o.y + o.size && o.y < ny + unit.size) return true;
    }
    return false;
  }

  function overlappingUnits(sim, unit) {
    const out = [];
    for (const o of sim.units) {
      if (o === unit) continue;
      if (unit.x < o.x + o.size && o.x < unit.x + unit.size &&
          unit.y < o.y + o.size && o.y < unit.y + unit.size) out.push(o);
    }
    return out;
  }

  /** 严格下坡候选（积分值更小），按值升序、再按方向顺序。 */
  function forwardSteps(engine, sim, unit) {
    const field = engine.fields[unit.size];
    const W = field.W;
    const own = field.integration[unit.y * W + unit.x];
    const out = [];
    for (let q = 0; q < 8; q++) {
      const d = DIRS[q];
      const nx = unit.x + d.dx, ny = unit.y + d.dy;
      if (!anchorMoveAllowed(engine, unit.size, unit.x, unit.y, nx, ny)) continue;
      if (blockedByUnits(sim, unit, nx, ny)) continue;
      if (unit.tabu && sim.frame < unit.tabu.until && unit.tabu.x === nx && unit.tabu.y === ny) continue;
      const v = field.integration[ny * W + nx];
      if (v < 0 || v >= own) continue;
      out.push({ x: nx, y: ny, dir: q, v });
    }
    out.sort((a, b) => (a.v - b.v) || (a.dir - b.dir));
    return out;
  }

  /** 任意合法空位（退让/分离用），按 (方向顺序) 枚举。 */
  function anyFreeSteps(engine, sim, unit) {
    const out = [];
    for (let q = 0; q < 8; q++) {
      const d = DIRS[q];
      const nx = unit.x + d.dx, ny = unit.y + d.dy;
      if (!anchorMoveAllowed(engine, unit.size, unit.x, unit.y, nx, ny)) continue;
      if (blockedByUnits(sim, unit, nx, ny)) continue;
      const field = engine.fields[unit.size];
      const v = field.integration[ny * field.W + nx];
      out.push({ x: nx, y: ny, dir: q, v });
    }
    return out;
  }

  /**
   * 单位是否已被“永不移动的单位”彻底堵死：它的每一条严格下坡路线都被
   * 不可达（自身无法通过该尺寸地形）的单位占块封住。这样的单位不会自己脱身。
   */
  function blockedForever(engine, sim, unit) {
    const field = engine.fields[unit.size];
    const W = field.W;
    const own = field.integration[unit.y * W + unit.x];
    let hasDownhill = false;
    for (let q = 0; q < 8; q++) {
      const d = DIRS[q];
      const nx = unit.x + d.dx, ny = unit.y + d.dy;
      if (!anchorMoveAllowed(engine, unit.size, unit.x, unit.y, nx, ny)) continue;
      const v = field.integration[ny * W + nx];
      if (v < 0 || v >= own) continue;
      hasDownhill = true;
      let occupied = false, onlyImmobile = true;
      for (const o of sim.units) {
        if (o === unit) continue;
        if (nx < o.x + o.size && o.x < nx + unit.size && ny < o.y + o.size && o.y < ny + unit.size) {
          occupied = true;
          if (!o.unreachable && !o.blocked) onlyImmobile = false;
        }
      }
      if (!occupied || !onlyImmobile) return false; // 至少有一条能走或被会动的单位占着
    }
    return hasDownhill;
  }

  /** 单位“最想走却走不了”的挡路者集合：只看严格下坡候选。 */
  function blockersOf(engine, sim, unit) {
    const field = engine.fields[unit.size];
    const W = field.W;
    const own = field.integration[unit.y * W + unit.x];
    const set = new Set();
    for (let q = 0; q < 8; q++) {
      const d = DIRS[q];
      const nx = unit.x + d.dx, ny = unit.y + d.dy;
      if (!anchorMoveAllowed(engine, unit.size, unit.x, unit.y, nx, ny)) continue;
      const v = field.integration[ny * W + nx];
      if (v < 0 || v >= own) continue;
      for (const o of sim.units) {
        if (o === unit || o.unreachable) continue;
        if (nx < o.x + o.size && o.x < nx + unit.size && ny < o.y + o.size && o.y < ny + unit.size) set.add(o.id);
      }
    }
    return set;
  }

  /** 等待图中的环（单位数不多，直接枚举简单环）。 */
  function waitCycles(engine, sim) {
    const graph = new Map();
    for (const u of sim.units) {
      if (u.unreachable) continue;
      graph.set(u.id, blockersOf(engine, sim, u));
    }
    const cycles = [];
    const seen = new Set();
    for (const start of graph.keys()) {
      const stack = [{ id: start, path: [start] }];
      while (stack.length) {
        const { id, path } = stack.pop();
        const next = graph.get(id);
        if (!next || path.length > 8) continue;
        for (const nid of next) {
          if (nid === start) {
            if (path.length > 1) {
              const key = path.slice().sort((a, b) => a - b).join(',');
              if (!seen.has(key)) { seen.add(key); cycles.push(path.slice()); }
            }
            continue;
          }
          if (path.includes(nid) || !graph.has(nid)) continue;
          stack.push({ id: nid, path: path.concat(nid) });
        }
      }
    }
    return cycles;
  }

  /**
   * 为一帧停滞选一个退让动作：环上积分值最大（离目标最远）的单位，
   * 挪到一个提升最少且不在环内成员紧邻处的空格；随后停驻并禁忌源格。
   */
  function planRetreat(engine, sim, cycleIds) {
    // 每个单位最多退让 2 次：反复让位说明局面无解（通常被不可达单位堵住），
    // 交给无进展看门狗判定，而不是无限让下去
    const members = cycleIds
      .map(id => sim.units.find(u => u.id === id))
      .filter(u => u && !u.unreachable && u.retreats < 4)
      .sort((a, b) => (integrationOf(engine, b) - integrationOf(engine, a)) || (b.id - a.id));
    for (const u of members) {
      const options = anyFreeSteps(engine, sim, u)
        .filter(o => o.v >= 0 && o.v > integrationOf(engine, u))
        .filter(o => !(u.tabu && sim.frame < u.tabu.until && u.tabu.x === o.x && u.tabu.y === o.y));
      if (!options.length) continue;
      // 偏好：不与环内其他成员占块相邻（给它们让出空间），其次积分值提升最小
      const crowded = (o) => {
        let n = 0;
        for (const id of cycleIds) {
          const c = sim.units.find(s => s.id === id);
          if (!c || c === u) continue;
          if (Math.abs(o.x - c.x) <= 1 && Math.abs(o.y - c.y) <= 1) n++;
        }
        return n;
      };
      options.sort((a, b) => (crowded(a) - crowded(b)) || (a.v - b.v) || (a.dir - b.dir));
      return { unit: u, step: options[0] };
    }
    return null;
  }

  function applyStep(unit, step) {
    unit.x = step.x; unit.y = step.y;
    unit.waitFrames = 0;
  }

  /** 初始重叠的分离：优先挪到严格下坡空位，否则任意空位。 */
  function separationStep(engine, sim, unit) {
    const fwd = forwardSteps(engine, sim, unit);
    if (fwd.length) return fwd[0];
    const any = anyFreeSteps(engine, sim, unit);
    any.sort((a, b) => (a.v - b.v) || (a.dir - b.dir));
    return any[0] || null;
  }

  function markArrived(sim, u, arrivedList) {
    u.arrivedNow = true;
    sim.arrivals.push({ id: u.id, size: u.size, frame: sim.frame });
    arrivedList.push({ id: u.id, frame: sim.frame });
  }

  /**
   * 推进一帧。按 id 升序决定，移动立即生效。
   * 返回 {frame, moves, arrived, finished, retreat, note}。
   */
  function stepSim(engine) {
    const sim = engine.sim;
    if (!sim || sim.finished) {
      return { frame: sim ? sim.frame : 0, finished: true, moves: [], arrived: [], retreat: null };
    }
    sim.frame++;
    const moves = [];
    const arrived = [];
    let movedAny = false;
    let progress = false;
    let retreat = null;
    let note = null;

    const ordered = sim.units.slice().sort((a, b) => a.id - b.id);
    for (const u of ordered) {
      const mv = { id: u.id, x: u.x, y: u.y, dir: null, waited: true, kind: 'wait' };

      // 初始重叠的分离优先于一切（即使该单位本身不可达，也不能让重叠持续）
      if (overlappingUnits(sim, u).length) {
        const sep = separationStep(engine, sim, u);
        if (sep) {
          applyStep(u, sep);
          movedAny = true;
          u.overlapStuckFrames = 0;
          mv.x = u.x; mv.y = u.y; mv.dir = DIRS[sep.dir].name; mv.waited = false; mv.kind = 'separate';
        } else {
          u.waitFrames++;
          // 被一个永远不动的大单位整个包住（slit.json 的 id=0 即如此）：据实标记为被堵死
          if (++u.overlapStuckFrames >= 20 && !u.blocked) {
            u.blocked = true;
            sim.blockedIds.push(u.id);
            sim.blockedFrames[u.id] = sim.frame;
            note = `id=${u.id} 被不可移动的单位占块包住，无法脱身`;
          }
        }
        refreshUnreachable(engine, u);
        moves.push(mv);
        if (blockCoversGoal(engine.map.grid, u.x, u.y, u.size)) markArrived(sim, u, arrived);
        continue;
      }

      if (u.holdFrames > 0) { u.holdFrames--; u.waitFrames++; moves.push(mv); continue; }
      refreshUnreachable(engine, u);
      if (u.unreachable || u.blocked) { u.waitFrames++; moves.push(mv); continue; }
      if (!u.blocked && blockedForever(engine, sim, u)) {
        u.blocked = true;
        sim.blockedIds.push(u.id);
        sim.blockedFrames[u.id] = sim.frame;
        u.waitFrames++;
        moves.push(mv);
        note = `id=${u.id} 的去路被不会移动的单位完全堵死`;
        continue;
      }

      const fwd = forwardSteps(engine, sim, u);
      if (fwd.length) {
        applyStep(u, fwd[0]);
        movedAny = true;
        mv.x = u.x; mv.y = u.y; mv.dir = DIRS[fwd[0].dir].name; mv.waited = false; mv.kind = 'forward';
      } else {
        u.waitFrames++;
      }
      moves.push(mv);
      if (blockCoversGoal(engine.map.grid, u.x, u.y, u.size)) markArrived(sim, u, arrived);
    }

    // 真正的进展 = 有单位刷新了自己的历史最好（最小）积分值。
    // 退让、原地等待、以及退让后的往复都不算进展。
    for (const u of sim.units) {
      if (u.unreachable || u.blocked) continue;
      const v = integrationOf(engine, u);
      if (v >= 0 && v < u.bestValue) { u.bestValue = v; progress = true; }
    }

    if (!movedAny && sim.units.some(u => !u.unreachable && !u.blocked)) {
      const cycles = waitCycles(engine, sim);
      if (cycles.length) {
        const cycleIds = Array.from(new Set(cycles.flat()));
        const plan = planRetreat(engine, sim, cycleIds);
        const u = plan ? plan.unit : sim.units.find(s => cycleIds.includes(s.id));
        if (plan) {
          const from = { x: u.x, y: u.y };
          applyStep(u, plan.step);
          // 退让后停驻并禁忌源格；退让次数越多，停驻越久（给其他单位让出通道）
          u.holdFrames = Math.min(14, 4 + u.retreats * 3);
          u.tabu = { x: from.x, y: from.y, until: sim.frame + 18 + u.retreats * 8 };
          u.retreats++;
          movedAny = true;
          retreat = { id: u.id, from: from.x + ',' + from.y, x: u.x, y: u.y, dir: DIRS[plan.step.dir].name };
          sim.yields.push({ frame: sim.frame, ...retreat });
          const mv = moves.find(m => m.id === u.id);
          if (mv) { mv.x = u.x; mv.y = u.y; mv.dir = DIRS[plan.step.dir].name; mv.waited = false; mv.kind = 'retreat'; }
          if (blockCoversGoal(engine.map.grid, u.x, u.y, u.size)) markArrived(sim, u, arrived);
          note = `检测到 ${cycles.length} 个单位等待环，id=${u.id} 退让一格解除死锁`;
        } else {
          // 环内没有可用空格：让环内离目标最远的单位停驻，等待后续机会
          if (u) { u.holdFrames = 4; note = `等待环存在但无可退空格，id=${u.id} 停驻`; }
        }
      } else if (sim.stalledFrames > 0) {
        note = '门口排队，等待前车通过';
      }
    }

    sim.units = sim.units.filter(u => !u.arrivedNow);
    if (arrived.length) progress = true;
    sim.frames.push(frameSnapshot(sim));

    const movingUnits = sim.units.filter(u => !u.unreachable && !u.blocked);
    if (movingUnits.length === 0) {
      sim.finished = true;
    } else if (!movedAny) {
      sim.stalledFrames++;
      // 长时间无任何前进且无环可解：判定为被不可解的开局堵死
      if (sim.stalledFrames >= 120) {
        sim.finished = true;
        sim.deadlock = true;
        sim.deadlockedIds = movingUnits.map(u => u.id);
        note = '长时间完全停滞，剩余单位判定为被堵死';
      }
    } else {
      sim.stalledFrames = 0;
    }

    // 记录本帧事件（到达 / 退让 / 堵塞 / 停滞说明）
    for (const a of arrived) sim.events.push({ frame: sim.frame, kind: 'arrive', text: `id=${a.id} 到达目标` });
    if (retreat) sim.events.push({ frame: sim.frame, kind: 'retreat', text: `id=${retreat.id} 从 (${retreat.from}) 退让到 (${retreat.x},${retreat.y})` });
    if (note) {
      const kind = note.includes('堵死') ? 'blocked' : note.includes('退让') || note.includes('停驻') ? 'retreat' : 'info';
      sim.events.push({ frame: sim.frame, kind, text: note });
    }
    if (sim.events.length > 4000) sim.events.splice(0, sim.events.length - 4000);

    // 无进展看门狗：以“刷新历史最小积分值”为进展，可终止退让引起的活锁
    // （典型成因：不可达的大单位堵住唯一通路，两个可动单位互相让位又互相挡回）。
    if (progress) sim.noProgressFrames = 0;
    else sim.noProgressFrames++;
    if (!sim.finished && sim.noProgressFrames >= 60 && movingUnits.length) {
      sim.finished = true;
      sim.deadlock = true;
      sim.deadlockedIds = movingUnits.map(u => u.id);
      for (const u of movingUnits) {
        u.blocked = true;
        sim.blockedIds.push(u.id);
        sim.blockedFrames[u.id] = sim.frame;
      }
      note = '长时间没有任何单位取得进展，剩余单位判定为被堵死';
    }
    return { frame: sim.frame, moves, arrived, finished: sim.finished, retreat, note };
  }

  function runSim(engine, maxFrames) {
    const limit = maxFrames || 5000;
    let guard = 0;
    while (!engine.sim.finished && guard++ < limit) stepSim(engine);
    return engine.sim;
  }

  /* ------------------------------------------------------------------ */

  return {
    DIRS, SIZES, COST, INF,
    parseMap, validateUnits, cellCost,
    blockBlocked, blockCoversGoal, blockCost,
    buildGeometry,
    createEngine, recomputeAll, applyTerrainEdits, verifyIncremental,
    integrationExport, trajectoryExport,
    resetSim, stepSim, runSim,
    fullIntegrate, newField, computeDirectionAt,
  };
}));
