// 争地赛季地图版本校验 —— 核心拓扑引擎（纯算法，无 DOM 依赖）
//
// 模型：
//   版本 0 为底图；edits[i] 产生版本 i+1，parent 指向某个更早版本，每次只改一格。
//   同色领地按四邻相连；空地(".")按八邻相连。
//   领地分量报告 area / perimeter（贴地图边、贴异色格的边都算周长）。
//   空地分量报告 area / enclave（整块都不接地图外边才为 true）/
//     owner（共边阵营恰有一个时为该阵营，否则 null）。
//
// 满额规模：512×512 格、12 万改格、3 万查询。
// 离线做法：版本树 DFS 线性化 → 每条邻接边/归属关系的激活区间 →
//   时间线段树 + 可回滚并查集（按大小合并，无路径压缩）。
// 复杂度 O((段数 + Q) log V)。

'use strict';

// ---------------------------------------------------------------------------
// 常量与校验
// ---------------------------------------------------------------------------

const MAX_SIDE = 512;
const MAX_EDITS = 120000;
const MAX_QUERIES = 30000;
const EMPTY = '.';

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isSingleCodeUnit = (s) => typeof s === 'string' && s.length === 1;

/**
 * 校验导入 JSON。记录号从 1 开始，错误信息中标注 edits/queries 第 n 条。
 * @returns {{ok:true, project:object} | {ok:false, errors:string[]}}
 */
function validateProject(input) {
  const errors = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['根节点必须是 JSON 对象，包含 rows / edits / queries 字段'] };
  }

  // ---- rows ----
  let width = 0;
  let height = 0;
  const allowedValues = new Set([EMPTY]);
  if (!Array.isArray(input.rows)) {
    errors.push('rows 必须是字符串数组');
  } else if (input.rows.length === 0 || input.rows.length > MAX_SIDE) {
    errors.push(`rows 行数须在 1..${MAX_SIDE} 之间，实际为 ${input.rows.length}`);
  } else {
    height = input.rows.length;
    width = input.rows[0].length;
    if (width === 0 || width > MAX_SIDE) {
      errors.push(`每行长度须在 1..${MAX_SIDE} 之间，首行长度为 ${width}`);
      width = 0;
    }
    if (width > 0) {
      for (let i = 0; i < height; i++) {
        const row = input.rows[i];
        if (!isNonEmptyString(row)) {
          errors.push(`rows[${i}] 必须是非空字符串`);
          break;
        }
        if (row.length !== width) {
          errors.push(`rows[${i}] 长度 ${row.length} 与首行长度 ${width} 不一致（地图必须为矩形）`);
          break;
        }
        for (let j = 0; j < width; j++) {
          const ch = row[j];
          if (!isSingleCodeUnit(ch)) {
            errors.push(`rows[${i}] 含多码位字符，每格只允许单个字符`);
            break;
          }
          allowedValues.add(ch);
        }
      }
    }
  }

  const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y)
    && x >= 0 && y >= 0 && x < width && y < height;

  // ---- edits（缺省视为空数组）----
  const edits = Array.isArray(input.edits) ? input.edits
    : (input.edits === undefined ? [] : null);
  if (edits === null) {
    errors.push('edits 必须是数组');
  } else if (edits.length > MAX_EDITS) {
    errors.push(`edits 最多 ${MAX_EDITS} 条，实际 ${edits.length} 条`);
  } else {
    for (let i = 0; i < edits.length; i++) {
      const rec = edits[i];
      const tag = `edits 第 ${i + 1} 条`;
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        errors.push(`${tag}：必须是对象`);
        continue;
      }
      if (!Number.isInteger(rec.parent) || rec.parent < 0 || rec.parent > i) {
        errors.push(`${tag}：parent 必须是 [0, ${i}] 内的整数（只能引用更早版本），实际为 ${JSON.stringify(rec.parent)}`);
      }
      if (!inBounds(rec.x, rec.y)) {
        errors.push(`${tag}：坐标 (${rec.x}, ${rec.y}) 越界，地图范围 x∈[0,${width - 1}] y∈[0,${height - 1}]`);
      }
      if (!isSingleCodeUnit(rec.value) || !allowedValues.has(rec.value)) {
        errors.push(`${tag}：value 必须是底图中出现过的单字符或 "."，实际为 ${JSON.stringify(rec.value)}`);
      }
    }
  }

  // ---- queries ----
  const editCount = edits ? edits.length : 0;
  const versionCount = editCount + 1;
  const queries = Array.isArray(input.queries) ? input.queries
    : (input.queries === undefined ? [] : null);
  if (queries === null) {
    errors.push('queries 必须是数组');
  } else if (queries.length > MAX_QUERIES) {
    errors.push(`queries 最多 ${MAX_QUERIES} 条，实际 ${queries.length} 条`);
  } else {
    for (let i = 0; i < queries.length; i++) {
      const rec = queries[i];
      const tag = `queries 第 ${i + 1} 条`;
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        errors.push(`${tag}：必须是对象`);
        continue;
      }
      if (!Number.isInteger(rec.version) || rec.version < 0 || rec.version >= versionCount) {
        errors.push(`${tag}：version 必须是 [0, ${versionCount - 1}] 内的整数，实际为 ${JSON.stringify(rec.version)}`);
      }
      if (!inBounds(rec.x, rec.y)) {
        errors.push(`${tag}：坐标 (${rec.x}, ${rec.y}) 越界，地图范围 x∈[0,${width - 1}] y∈[0,${height - 1}]`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    project: {
      rows: input.rows.slice(),
      edits: edits.map((e) => ({ parent: e.parent, x: e.x, y: e.y, value: e.value })),
      queries: queries.map((q) => ({ version: q.version, x: q.x, y: q.y })),
    },
  };
}

// ---------------------------------------------------------------------------
// 分块整数数组：避免单 TypedArray 长度上限，push/random access 均 O(1)
// ---------------------------------------------------------------------------

class ChunkInts {
  constructor(chunkShift = 16) {
    this.shift = chunkShift;
    this.chunkSize = 1 << chunkShift;
    this.chunks = [];
    this.length = 0;
  }
  push(...values) {
    for (const v of values) {
      const i = this.length++;
      const ci = i >> this.shift;
      const off = i & (this.chunkSize - 1);
      if (off === 0) this.chunks.push(new Int32Array(this.chunkSize));
      this.chunks[ci][off] = v;
    }
  }
  set(i, v) {
    this.chunks[i >> this.shift][i & (this.chunkSize - 1)] = v;
  }
  get(i) {
    return this.chunks[i >> this.shift][i & (this.chunkSize - 1)];
  }
}

// ---------------------------------------------------------------------------
// 交互态工具：版本取图 / 泛洪取整块
// ---------------------------------------------------------------------------

/** 沿 parent 链重放，得到 version 时刻的整图（码值数组，'.'=0） */
function materializeGrid(project, version, charToCode) {
  const { rows, edits } = project;
  const h = rows.length;
  const w = rows[0].length;
  const grid = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) grid[y * w + x] = charToCode(rows[y][x]);
  }
  const chain = [];
  let v = version;
  while (v > 0) {
    chain.push(v - 1);
    v = edits[v - 1].parent;
  }
  for (let k = chain.length - 1; k >= 0; k--) {
    const e = edits[chain[k]];
    grid[e.y * w + e.x] = charToCode(e.value);
  }
  return grid;
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = DIRS4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

/**
 * 泛洪取 (x,y) 所在分量（交互/参考实现用）。
 * connectivity: 4（同色领地）或 8（空地，调用方保证起点为空地）。
 */
function floodBlock(project, version, x, y, connectivity, charToCode) {
  const { rows } = project;
  const h = rows.length;
  const w = rows[0].length;
  const grid = materializeGrid(project, version, charToCode);
  const start = y * w + x;
  const target = grid[start];
  const isEmptyRun = target === 0;
  const dirs = connectivity === 8 ? DIRS8 : DIRS4;

  const seen = new Uint8Array(w * h);
  const stack = [start];
  const cells = [];
  seen[start] = 1;
  let touchesBoundary = false;
  let perimeter = 0;
  const ownerSet = new Set();

  while (stack.length) {
    const c = stack.pop();
    cells.push(c);
    const cx = c % w;
    const cy = (c - cx) / w;
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBoundary = true;

    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        perimeter++;
      } else {
        const nv = grid[ny * w + nx];
        if (nv !== target) {
          perimeter++;
          if (isEmptyRun && nv !== 0) ownerSet.add(nv);
        }
      }
    }

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nc = ny * w + nx;
      if (seen[nc] || grid[nc] !== target) continue;
      seen[nc] = 1;
      stack.push(nc);
    }
  }

  return {
    cells: Int32Array.from(cells),
    area: cells.length,
    perimeter,
    touchesBoundary,
    enclave: isEmptyRun ? !touchesBoundary : false,
    ownerCodes: ownerSet,
  };
}

// ---------------------------------------------------------------------------
// 可回滚并查集
// 栈帧（变长，首字为 tag）：
//   合并帧 [0, ra, rb, sizeRa, perimRa, touchRa, ownerRa]
//   边调整帧 [1, root, delta] —— 同色边无论是否触发合并都要扣周长
// ---------------------------------------------------------------------------

class RollbackDSU {
  constructor(numNodes) {
    this.parent = new Int32Array(numNodes);
    this.size = new Int32Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
      this.parent[i] = i;
      this.size[i] = 1;
    }
    this.area = new Int32Array(numNodes);
    this.perim = new Int32Array(numNodes);
    this.touch = new Uint8Array(numNodes);
    this.ownerState = new Int8Array(numNodes); // -1 多方, 0 无主, >0 阵营码
    this.stack = new ChunkInts();
  }
  find(x) {
    while (this.parent[x] !== x) x = this.parent[x];
    return x;
  }
  checkpoint() { return this.stack.length; }
  /** 合并两个分量；ownerCode 仅用于 token 合并时显式给出阵营 */
  union(a, b, ownerCode) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) { const t = ra; ra = rb; rb = t; }
    // 定长 7 字帧，tag=0 在栈顶：[0, ra, rb, sizeRa, perimRa, touchRa, ownerRa]
    this.stack.push(0, ra, rb, this.size[ra], this.perim[ra], this.touch[ra], this.ownerState[ra]);
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    this.area[ra] = this.size[ra];
    this.perim[ra] += this.perim[rb];
    this.touch[ra] = this.touch[ra] | this.touch[rb];
    const oa = this.ownerState[ra];
    const ob = ownerCode !== undefined ? ownerCode : this.ownerState[rb];
    let merged;
    if (oa === -1 || ob === -1) merged = -1;
    else if (oa === 0) merged = ob;
    else if (ob === 0) merged = oa;
    else merged = (oa === ob ? oa : -1);
    this.ownerState[ra] = merged;
  }
  /** 一条同色边激活：两端分量周长各减 1（合并后整体减 2），no-op 也要计 */
  applyColorEdge(u) {
    const root = this.find(u);
    this.perim[root] -= 2;
    // 定长 7 字帧，tag=1 在帧首（栈底方向）：[1, root, -2, 0, 0, 0, 0]
    this.stack.push(1, root, -2, 0, 0, 0, 0);
  }
  rollback(cp) {
    const st = this.stack;
    let len = st.length;
    while (len > cp) {
      const tag = st.get(len - 7); // 定长帧：tag 固定在帧首
      if (tag === 1) {
        // [1, root, delta, ...]
        const root = st.get(len - 6);
        const delta = st.get(len - 5);
        len -= 7;
        this.perim[root] -= delta; // delta=-2 → 回滚 +2
      } else {
        // [0, ra, rb, sizeRa, perimRa, touchRa, ownerRa]
        const ra = st.get(len - 6);
        const rb = st.get(len - 5);
        const sizeRa = st.get(len - 4);
        const perimRa = st.get(len - 3);
        const touchRa = st.get(len - 2);
        const ownerRa = st.get(len - 1);
        len -= 7;
        this.parent[rb] = rb;
        this.size[ra] = sizeRa;
        this.area[ra] = sizeRa;
        this.perim[ra] = perimRa;
        this.touch[ra] = touchRa;
        this.ownerState[ra] = ownerRa;
      }
    }
    st.length = len;
  }
}

// ---------------------------------------------------------------------------
// 离线批处理
// ---------------------------------------------------------------------------

function runBatch(project) {
  const { rows, edits, queries } = project;
  const h = rows.length;
  const w = rows[0].length;
  const n = w * h;
  const V = edits.length + 1;

  // 字符码：0 固定给空地
  const charToCodeMap = new Map([[EMPTY, 0]]);
  let nextCode = 1;
  const charToCode = (ch) => {
    let c = charToCodeMap.get(ch);
    if (c === undefined) {
      c = nextCode++;
      charToCodeMap.set(ch, c);
    }
    return c;
  };
  let codeToChar = null; // 所有码分配完后建立（见 runBatch 后段）

  const initialGrid = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) initialGrid[y * w + x] = charToCode(rows[y][x]);
  }

  // 版本树
  const children = new Array(V);
  for (let i = 0; i < V; i++) children[i] = [];
  for (let i = 0; i < edits.length; i++) children[edits[i].parent].push(i + 1);

  // 邻接边：4 邻（右、下）+ 8 邻补充（两个对角）
  const e4u = new ChunkInts();
  const e4v = new ChunkInts();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (x + 1 < w) { e4u.push(c); e4v.push(c + 1); }
      if (y + 1 < h) { e4u.push(c); e4v.push(c + w); }
    }
  }
  const E4 = e4u.length;
  const e8u = new ChunkInts();
  const e8v = new ChunkInts();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (x + 1 < w && y + 1 < h) { e8u.push(c); e8v.push(c + w + 1); }
      if (x - 1 >= 0 && y + 1 < h) { e8u.push(c); e8v.push(c + w - 1); }
    }
  }
  const E8extra = e8u.length;
  const edgeEndU = (eid) => (eid < E4 ? e4u.get(eid) : e8u.get(eid - E4));
  const edgeEndV = (eid) => (eid < E4 ? e4v.get(eid) : e8v.get(eid - E4));

  // 每格关联边表（CSR 扁平结构，避免海量 JS 小数组对象）：
  // inc4Offset[c]..inc4Offset[c+1] 为格 c 的 4 邻边 id；inc8 同理
  function buildIncident(includeDiagonal) {
    const deg = new Int32Array(n + 1);
    for (let eid = 0; eid < E4; eid++) {
      deg[e4u.get(eid) + 1]++;
      deg[e4v.get(eid) + 1]++;
    }
    if (includeDiagonal) {
      for (let k = 0; k < E8extra; k++) {
        deg[e8u.get(k) + 1]++;
        deg[e8v.get(k) + 1]++;
      }
    }
    const offset = new Int32Array(n + 1);
    for (let c = 0; c < n; c++) offset[c + 1] = offset[c] + deg[c + 1];
    const total = offset[n];
    const edges = new Int32Array(total);
    const cursor = Int32Array.from(offset);
    for (let eid = 0; eid < E4; eid++) {
      const u = e4u.get(eid);
      const v = e4v.get(eid);
      edges[cursor[u]++] = eid;
      edges[cursor[v]++] = eid;
    }
    if (includeDiagonal) {
      for (let k = 0; k < E8extra; k++) {
        const eid = E4 + k;
        const u = e8u.get(k);
        const v = e8v.get(k);
        edges[cursor[u]++] = eid;
        edges[cursor[v]++] = eid;
      }
    }
    return { offset, edges };
  }
  const inc4 = buildIncident(false);
  const inc8 = buildIncident(true);

  // 查询分桶
  const queriesByVersion = new Array(V);
  for (let i = 0; i < V; i++) queriesByVersion[i] = [];
  for (let i = 0; i < queries.length; i++) queriesByVersion[queries[i].version].push(i);
  const queryCellCode = new Int32Array(queries.length);

  // -----------------------------------------------------------------------
  // 版本树 DFS（迭代，非破坏式）：entry/exit 时间戳 + 工作格重放/回滚
  // -----------------------------------------------------------------------
  const entry = new Int32Array(V);
  const exitT = new Int32Array(V);
  const versionAtTime = new Int32Array(V); // DFS 时间戳 -> 版本号

  function traverseTree(enterNode, exitNode) {
    const work = new Int32Array(initialGrid);
    const stack = [0];
    const stage = new Uint8Array(V);       // 1=已进入 2=孩子处理完
    const childIdx = new Int32Array(V);
    const savedCode = new Int32Array(V);
    let timer = 0;
    entry[0] = timer;
    versionAtTime[timer] = 0;
    enterNode(0, -1, work);
    timer++;
    stage[0] = 1;
    while (stack.length) {
      const node = stack[stack.length - 1];
      if (stage[node] === 1) {
        const kids = children[node];
        if (childIdx[node] < kids.length) {
          const child = kids[childIdx[node]++];
          const ed = edits[child - 1];
          const cell = ed.y * w + ed.x;
          savedCode[child] = work[cell];
          work[cell] = charToCode(ed.value);
          entry[child] = timer;
          versionAtTime[timer] = child;
          enterNode(child, cell, work);
          timer++;
          stage[child] = 1;
          stack.push(child);
        } else {
          stage[node] = 2;
        }
      } else {
        stack.pop();
        exitT[node] = timer - 1;
        const exitCell = node === 0 ? -1 : edits[node - 1].y * w + edits[node - 1].x;
        if (node !== 0) {
          const ed = edits[node - 1];
          work[ed.y * w + ed.x] = savedCode[node]; // 先回滚格值
        }
        exitNode(node, exitCell, work);             // 再回调，保证读到父状态
      }
    }
    return timer;
  }

  // 第一遍：查询时刻格值码（区分空地/阵营查询）
  traverseTree((node, cell, work) => {
    const qs = queriesByVersion[node];
    for (let qi = 0; qi < qs.length; qi++) {
      const qidx = qs[qi];
      const q = queries[qidx];
      queryCellCode[qidx] = work[q.y * w + q.x];
    }
  }, () => {});

  // -----------------------------------------------------------------------
  // 边激活区间收集
  // -----------------------------------------------------------------------
  function buildEdgeSegments(edgeCount, inc, activeTest, outRefs, outL, outR) {
    // activeStart[e]：边 e 当前激活段的起点（-1 表示未激活）。
    // 进入子节点：应用改格 → 同步 incident 边；退出子节点：回滚改格 → 再次同步恢复。
    const activeStart = new Int32Array(edgeCount).fill(-1);

    const sync = (eid, timePoint, work) => {
      const nowOn = activeTest(work, edgeEndU(eid), edgeEndV(eid));
      const wasOn = activeStart[eid] !== -1;
      if (nowOn && !wasOn) {
        activeStart[eid] = timePoint;
      } else if (!nowOn && wasOn) {
        outRefs.push(eid);
        outL.push(activeStart[eid]);
        outR.push(timePoint - 1);
        activeStart[eid] = -1;
      }
    };
    const syncCell = (cell, timePoint, work) => {
      for (let p = inc.offset[cell]; p < inc.offset[cell + 1]; p++) {
        sync(inc.edges[p], timePoint, work);
      }
    };

    traverseTree((node, cell, work) => {
      if (node === 0) {
        for (let eid = 0; eid < edgeCount; eid++) {
          if (activeTest(work, edgeEndU(eid), edgeEndV(eid))) activeStart[eid] = 0;
        }
      } else {
        syncCell(cell, entry[node], work);
      }
    }, (node, cell, work) => {
      if (node === 0) {
        for (let eid = 0; eid < edgeCount; eid++) {
          if (activeStart[eid] !== -1) {
            outRefs.push(eid);
            outL.push(activeStart[eid]);
            outR.push(exitT[0]);
            activeStart[eid] = -1;
          }
        }
      } else {
        syncCell(cell, exitT[node] + 1, work);
      }
    });
  }

  // 4 邻：同色且非空地
  const seg4Ref = new ChunkInts();
  const seg4L = new ChunkInts();
  const seg4R = new ChunkInts();
  buildEdgeSegments(
    E4, inc4,
    (g, u, v) => g[u] !== 0 && g[u] === g[v],
    seg4Ref, seg4L, seg4R
  );

  // 8 邻：两端皆空地
  const seg8Ref = new ChunkInts();
  const seg8L = new ChunkInts();
  const seg8R = new ChunkInts();
  buildEdgeSegments(
    E4 + E8extra, inc8,
    (g, u, v) => g[u] === 0 && g[v] === 0,
    seg8Ref, seg8L, seg8R
  );

  // -----------------------------------------------------------------------
  // 归属 token：某空地格 c 与阵营 f 共边的时间段
  // token 在创建时分配槽位（tokCell/tokFaction 立即落位，R 收尾时回填）
  // -----------------------------------------------------------------------
  const tokCell = new ChunkInts();
  const tokFaction = new ChunkInts();
  const tokL = new ChunkInts();
  const tokR = new ChunkInts();
  let tokenCount = 0;

  const localSets = new Array(n);
  for (let c = 0; c < n; c++) localSets[c] = new Map(); // faction -> tokenIdx
  const tokenStart = new Map();                          // c*BIG+f -> start time
  const BIG = nextCode + 2;
  const keyOf = (c, f) => c * BIG + f;

  function neighborFactions(work, c) {
    const cx = c % w;
    const cy = (c - cx) / w;
    const set = new Set();
    if (cx + 1 < w) { const v = work[c + 1]; if (v) set.add(v); }
    if (cx - 1 >= 0) { const v = work[c - 1]; if (v) set.add(v); }
    if (cy + 1 < h) { const v = work[c + w]; if (v) set.add(v); }
    if (cy - 1 >= 0) { const v = work[c - w]; if (v) set.add(v); }
    return set;
  }

  function closeToken(c, f, endTime) {
    const key = keyOf(c, f);
    const start = tokenStart.get(key);
    const idx = localSets[c].get(f);
    tokR.set(idx, endTime);
    tokenStart.delete(key);
    localSets[c].delete(f);
  }
  function openToken(c, f, startTime) {
    const idx = tokenCount++;
    tokCell.push(c);
    tokFaction.push(f);
    tokL.push(startTime);
    tokR.push(-1);
    localSets[c].set(f, idx);
    tokenStart.set(keyOf(c, f), startTime);
  }

  // 把某格 c 的共边阵营集合同步成 work 现状；timePoint 为变化生效的时间点
  function syncCellTokens(c, timePoint, work) {
    if (work[c] !== 0) {
      // 非空地：其全部 token 在此前结束
      for (const f of Array.from(localSets[c].keys())) closeToken(c, f, timePoint - 1);
      return;
    }
    const want = neighborFactions(work, c);
    for (const f of Array.from(localSets[c].keys())) {
      if (!want.has(f)) closeToken(c, f, timePoint - 1);
    }
    for (const f of want) {
      if (!localSets[c].has(f)) openToken(c, f, timePoint);
    }
  }

  traverseTree((node, cell, work) => {
    if (node === 0) {
      for (let c = 0; c < n; c++) syncCellTokens(c, 0, work);
    } else {
      const cx = cell % w;
      const cy = (cell - cx) / w;
      syncCellTokens(cell, entry[node], work);
      if (cx + 1 < w) syncCellTokens(cell + 1, entry[node], work);
      if (cx - 1 >= 0) syncCellTokens(cell - 1, entry[node], work);
      if (cy + 1 < h) syncCellTokens(cell + w, entry[node], work);
      if (cy - 1 >= 0) syncCellTokens(cell - w, entry[node], work);
    }
  }, (node, cell, work) => {
    if (node === 0) {
      for (let c = 0; c < n; c++) {
        for (const f of Array.from(localSets[c].keys())) {
          tokR.set(localSets[c].get(f), exitT[0]);
        }
        localSets[c].clear();
      }
      tokenStart.clear();
    } else {
      // work 已回滚到父状态；受影响格同样是改格本身 + 四邻
      const cx = cell % w;
      const cy = (cell - cx) / w;
      const tp = exitT[node] + 1;
      syncCellTokens(cell, tp, work);
      if (cx + 1 < w) syncCellTokens(cell + 1, tp, work);
      if (cx - 1 >= 0) syncCellTokens(cell - 1, tp, work);
      if (cy + 1 < h) syncCellTokens(cell + w, tp, work);
      if (cy - 1 >= 0) syncCellTokens(cell - w, tp, work);
    }
  });

  // -----------------------------------------------------------------------
  // 时间线段树（迭代树型，S=V 个叶子对应 DFS 时刻）
  // head[node] 为链表头；ref>=0 邻接边，ref<0 token（-(idx+1)）
  // -----------------------------------------------------------------------
  function buildSegmentBuckets(refs, ls, rs) {
    const S = V;
    const head = new ChunkInts();
    for (let i = 0; i < 2 * S; i++) head.push(-1);
    const next = new ChunkInts();
    const segRef = new ChunkInts();
    const segCount = refs.length;
    for (let si = 0; si < segCount; si++) {
      let l = ls.get(si) + S;
      let r = rs.get(si) + S;
      const ref = refs.get(si);
      while (l <= r) {
        if (l & 1) {
          next.push(head.get(l));
          segRef.push(ref);
          head.set(l, segRef.length - 1);
          l++;
        }
        if (!(r & 1)) {
          next.push(head.get(r));
          segRef.push(ref);
          head.set(r, segRef.length - 1);
          r--;
        }
        l >>= 1;
        r >>= 1;
      }
    }
    return { head, next, segRef, S };
  }

  function solve(mode, buckets, dsu, totalRefs) {
    const { head, next, segRef, S } = buckets;
    const results = new Array(queries.length);

    const applyRef = (ref) => {
      if (ref >= 0) {
        const u = edgeEndU(ref);
        const v = edgeEndV(ref);
        if (mode === 'color') {
          dsu.union(u, v);
          dsu.applyColorEdge(u); // 即使 no-op 也扣 2
        } else {
          dsu.union(u, v);
        }
      } else {
        const tidx = -ref - 1;
        dsu.union(tokCell.get(tidx), n + tidx, tokFaction.get(tidx));
      }
    };

    const dfs = (node) => {
      const cp = dsu.checkpoint();
      for (let p = head.get(node); p !== -1; p = next.get(p)) applyRef(segRef.get(p));
      if (node >= S) {
        const version = versionAtTime[node - S]; // 叶子是 DFS 时间戳，反查版本号
        for (const qidx of queriesByVersion[version]) {
          const q = queries[qidx];
          const cell = q.y * w + q.x;
          const root = dsu.find(cell);
          if (mode === 'color') {
            if (queryCellCode[qidx] === 0) continue;
            results[qidx] = {
              type: 'territory',
              version: q.version,
              x: q.x,
              y: q.y,
              faction: codeToChar[queryCellCode[qidx]],
              area: dsu.area[root],
              perimeter: dsu.perim[root],
            };
          } else {
            if (queryCellCode[qidx] !== 0) continue;
            const os = dsu.ownerState[root];
            results[qidx] = {
              type: 'empty',
              version: q.version,
              x: q.x,
              y: q.y,
              area: dsu.area[root],
              enclave: dsu.touch[root] === 0,
              owner: os > 0 ? codeToChar[os] : null,
            };
          }
        }
      } else {
        if (node * 2 < 2 * S) dfs(node * 2);
        if (node * 2 + 1 < 2 * S) dfs(node * 2 + 1);
      }
      dsu.rollback(cp);
    };
    dfs(1);
    return results;
  }

  // 所有 charToCode 调用（底图 + 全部 edit）此时已完成，建立反查表
  codeToChar = new Array(nextCode);
  for (const [ch, code] of charToCodeMap) codeToChar[code] = ch;

  // ---- 领地遍 ----
  const dsu4 = new RollbackDSU(n);
  for (let c = 0; c < n; c++) {
    dsu4.area[c] = 1;
    dsu4.perim[c] = 4;
  }
  const buckets4 = buildSegmentBuckets(seg4Ref, seg4L, seg4R);
  const resultsColor = solve('color', buckets4, dsu4);

  // ---- 空地遍（边区间 + token 区间合并为同一 ref 流）----
  const allRef = new ChunkInts();
  const allL = new ChunkInts();
  const allR = new ChunkInts();
  for (let i = 0; i < seg8Ref.length; i++) {
    allRef.push(seg8Ref.get(i));
    allL.push(seg8L.get(i));
    allR.push(seg8R.get(i));
  }
  for (let t = 0; t < tokenCount; t++) {
    allRef.push(-(t + 1));
    allL.push(tokL.get(t));
    allR.push(tokR.get(t));
  }
  const dsu8 = new RollbackDSU(n + tokenCount);
  for (let c = 0; c < n; c++) {
    dsu8.area[c] = 1;
    const cx = c % w;
    const cy = (c - cx) / w;
    dsu8.touch[c] = (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) ? 1 : 0;
    dsu8.ownerState[c] = 0;
  }
  for (let t = 0; t < tokenCount; t++) {
    // token 是面积为 0 的附属节点；size=0 保证按大小合并时它永远作为孩子挂到格点根下
    dsu8.size[n + t] = 0;
    dsu8.area[n + t] = 0;
    dsu8.ownerState[n + t] = tokFaction.get(t);
  }
  const buckets8 = buildSegmentBuckets(allRef, allL, allR);
  const resultsEmpty = solve('empty', buckets8, dsu8);

  const finalResults = new Array(queries.length);
  for (let i = 0; i < queries.length; i++) {
    finalResults[i] = resultsColor[i] || resultsEmpty[i];
  }
  return finalResults;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const engine = {
  EMPTY,
  MAX_SIDE,
  MAX_EDITS,
  MAX_QUERIES,
  validateProject,
  materializeGrid,
  floodBlock,
  runBatch,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = engine;
}
if (typeof window !== 'undefined') {
  window.FrontierEngine = engine;
}
