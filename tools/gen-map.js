/*
 * gen-map.js — 满载测试地图生成器（Node 专用，不进网页）
 * 生成接近上限的多层凸多边形网格：
 *   - 每层一个规则方格阵列，格为凸四边形；
 *   - 同层相邻格之间生成有向边（含普通门/墙），双向各一条；
 *   - 层间在指定格对生成 link 跳跃边；
 *   - 门线段取共边线的中间子段，带随机开关。
 * 用法：node tools/gen-map.js [cells=20000] [edges=40000] [floors=3] [out=path]
 */
'use strict';
const fs = require('fs');

function generate(targetCells, targetEdges, floorCount) {
  const cells = [];
  const edges = [];
  // 每层近似正方形阵列
  const perFloor = Math.ceil(targetCells / floorCount);
  const cols = Math.ceil(Math.sqrt(perFloor));
  const rows = Math.ceil(perFloor / cols);
  const cellSize = 10;

  let cellId = 1;
  const floorCellIds = [];
  for (let f = 0; f < floorCount; f++) {
    const ids = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (cells.length >= targetCells) break;
        const x = c * cellSize, y = r * cellSize;
        cells.push({
          id: cellId, floor: f,
          poly: [[x, y], [x + cellSize, y], [x + cellSize, y + cellSize], [x, y + cellSize]],
        });
        ids.push(cellId);
        cellId++;
      }
      if (cells.length >= targetCells) break;
    }
    floorCellIds.push(ids);
  }

  // 同层邻接边：先建生成树保证每层连通，再补冗余边直到预算，剩余预算留给跨层 link。
  let edgeId = 1;
  const idAt = new Map(cells.map((c) => [c.id, c]));
  function addEdge(from, to, extra) {
    if (edges.length >= targetEdges) return false;
    edges.push(Object.assign({ id: edgeId++, from, to, fee: 1, open: true }, extra));
    return true;
  }

  // 收集每层所有候选邻接对（右邻、下邻）
  const floorPairs = floorCellIds.map((ids) => {
    const idx = new Set(ids);
    const pairs = [];
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const r = Math.floor(k / cols), c = k % cols;
      if (c + 1 < cols && idx.has(id + 1)) {
        const door = [[(c + 1) * cellSize, r * cellSize + 2], [(c + 1) * cellSize, (r + 1) * cellSize - 2]];
        pairs.push([id, id + 1, door]);
      }
      const below = id + cols;
      if (r + 1 < rows && idx.has(below)) {
        const door = [[c * cellSize + 2, (r + 1) * cellSize], [(c + 1) * cellSize - 2, (r + 1) * cellSize]];
        pairs.push([id, below, door]);
      }
    }
    return pairs;
  });

  // 预留跨层 link 预算（每层约 30 条双向），其余给层内边
  const linkBudget = (floorCount - 1) * 60;
  const intraBudget = targetEdges - linkBudget;

  // 第一轮：每层用并查集建生成树（双向边），保证连通；记录树边 id 不可关闭。
  // 生成树每格只需 1 条入边，N 格约 2N 条有向边，远小于边预算，故不设中断。
  const treeEdgeIds = new Set();
  const floorConnected = [];
  for (let f = 0; f < floorCount; f++) {
    const parent = new Map(floorCellIds[f].map((id) => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const [a, b, door] of floorPairs[f]) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) {
        parent.set(ra, rb);
        const before = edgeId;
        if (!addEdge(a, b, { door }) || !addEdge(b, a, { door: [door[1], door[0]] })) break;
        treeEdgeIds.add(before); treeEdgeIds.add(before + 1);
      }
    }
    // 连通性校验：本层所有格应在同一并查集
    const roots = new Set(floorCellIds[f].map((id) => find(id)));
    floorConnected.push(roots.size === 1);
  }
  // 第二轮：补冗余邻接边直到层内预算
  for (let f = 0; f < floorCount; f++) {
    const existing = new Set(edges.map((e) => `${e.from}>${e.to}`));
    for (const [a, b, door] of floorPairs[f]) {
      if (edges.length >= intraBudget) break;
      if (!existing.has(`${a}>${b}`)) {
        addEdge(a, b, { door });
        if (edges.length < intraBudget) addEdge(b, a, { door: [door[1], door[0]] });
      }
    }
  }

  // 层间 link：每层取若干格与上一层对应位置连接（双向）
  for (let f = 0; f + 1 < floorCount; f++) {
    const a = floorCellIds[f], b = floorCellIds[f + 1];
    const links = Math.min(20, Math.floor(a.length / 2));
    for (let t = 0; t < links; t++) {
      const ca = idAt.get(a[Math.floor((t + 0.5) / links * a.length)]);
      const cb = idAt.get(b[Math.floor((t + 0.5) / links * b.length)]);
      const entry = [ca.poly[0][0] + 5, ca.poly[0][1] + 5];
      const exit = [cb.poly[0][0] + 5, cb.poly[0][1] + 5];
      if (!addEdge(ca.id, cb.id, { fee: 5, link: [entry, exit] })) break;
      if (!addEdge(cb.id, ca.id, { fee: 5, link: [exit, entry] })) break;
    }
  }

  // 随机关闭约 5% 的【冗余】门（生成树边始终保持开启，保证骨架连通），制造诊断场景
  let closed = 0;
  for (const e of edges) {
    if (e.door && !treeEdgeIds.has(e.id) &&
        ((e.id * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff < 0.05) {
      e.open = false; closed++;
    }
  }

  // 查询：随机起终点，覆盖跨层
  const queries = [];
  let qseed = 987654321;
  const rnd = () => { qseed = (qseed * 1103515245 + 12345) & 0x7fffffff; return qseed / 0x7fffffff; };
  for (let q = 0; q < 200; q++) {
    const sf = Math.floor(rnd() * floorCount);
    const ef = Math.floor(rnd() * floorCount);
    const sId = floorCellIds[sf][Math.floor(rnd() * floorCellIds[sf].length)];
    const eId = floorCellIds[ef][Math.floor(rnd() * floorCellIds[ef].length)];
    const sc = idAt.get(sId), ec = idAt.get(eId);
    queries.push({
      start: { floor: sf, cell: sId, point: [sc.poly[0][0] + 1, sc.poly[0][1] + 1] },
      end: { floor: ef, cell: eId, point: [ec.poly[0][0] + 9, ec.poly[0][1] + 9] },
      margin: 0.5,
    });
  }

  return { cells, edges, queries, stats: { closedDoors: closed } };
}

module.exports = { generate };

if (require.main === module) {
  const targetCells = parseInt(process.argv[2] || '20000', 10);
  const targetEdges = parseInt(process.argv[3] || '40000', 10);
  const floors = parseInt(process.argv[4] || '3', 10);
  const out = process.argv[5] || 'samples/full-map.json';
  const data = generate(targetCells, targetEdges, floors);
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`生成 ${data.cells.length} 格 ${data.edges.length} 边 ${floors} 层，关闭门 ${data.stats.closedDoors}，查询 ${data.queries.length} 条 → ${out}`);
  console.log(`文件大小 ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}
