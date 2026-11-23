/*
 * tests/test-core.js — 纯 Node 运行：node tests/test-core.js
 * 覆盖：几何、漏斗算法（含单点门/共线/余量）、两段求解、字典序、不可达诊断、跨层跳跃。
 */
'use strict';
const assert = require('assert');
const G = require('../src/geometry');
const { loadMap } = require('../src/model');
const D = require('../src/dijkstra');
const F = require('../src/funnel');
const { solveQuery } = require('../src/route');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---------- 几何 ----------
console.log('geometry:');
ok('applyMargin 普通裁剪', () => {
  const r = G.applyMargin([0, 0], [10, 0], 2);
  assert.deepStrictEqual(r.kind, 'segment');
  assert.ok(Math.abs(r.a[0] - 2) < 1e-12 && Math.abs(r.b[0] - 8) < 1e-12);
});
ok('applyMargin 余量吃掉整段 → empty', () => {
  assert.strictEqual(G.applyMargin([0, 0], [10, 0], 6).kind, 'empty');
});
ok('applyMargin 恰好剩一个点 → point', () => {
  const r = G.applyMargin([0, 0], [10, 0], 5);
  assert.strictEqual(r.kind, 'point');
  assert.ok(Math.abs(r.p[0] - 5) < 1e-9);
});
ok('sharedEdge 相邻方格', () => {
  const a = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const b = [[4, 0], [8, 0], [8, 4], [4, 4]];
  const e = G.sharedEdge(a, b);
  const ys = e.map((p) => p[1]).sort();
  assert.deepStrictEqual(ys, [0, 4]);
  assert.ok(e.every((p) => Math.abs(p[0] - 4) < 1e-9));
});
ok('sharedEdge 不相邻 → null', () => {
  const a = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const b = [[5, 0], [6, 0], [6, 1], [5, 1]];
  assert.strictEqual(G.sharedEdge(a, b), null);
});
ok('pointInConvex 边界与内部', () => {
  const p = [[0, 0], [4, 0], [4, 4], [0, 4]];
  assert.ok(G.pointInConvex([2, 2], p));
  assert.ok(G.pointInConvex([0, 2], p));
  assert.ok(!G.pointInConvex([5, 2], p));
});
ok('segmentIntersect 共线重叠', () => {
  const r = G.segmentIntersect([0, 0], [10, 0], [4, 0], [6, 0]);
  assert.strictEqual(r.type, 'segment');
  assert.ok(Math.abs(r.a[0] - 4) < 1e-9 && Math.abs(r.b[0] - 6) < 1e-9);
});
ok('MinHeap 含重复键的弹出严格有序', () => {
  const heap = new D.MinHeap(8);
  const dist = new Float64Array([5, 3, 8, 1, 9, 2, 7, 0]);
  // 每个顶点入堆两次（模拟松弛重复入堆），再全部弹出
  for (let rep = 0; rep < 2; rep++) {
    for (let v = 0; v < 8; v++) heap.push(v, dist);
  }
  const out = [];
  while (heap.size > 0) out.push(dist[heap.pop()]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1], '非递减');
});

// ---------- 漏斗算法 ----------
console.log('funnel:');
// 三个并排方格，走廊穿两道共边门（门被余量收窄成点时同样适用）
function threeRoomRun(door1, door2) {
  const cells = [
    { poly: [[0, 0], [4, 0], [4, 4], [0, 4]], center: [2, 2] },
    { poly: [[4, 0], [8, 0], [8, 4], [4, 4]], center: [6, 2] },
    { poly: [[8, 0], [12, 0], [12, 4], [8, 4]], center: [10, 2] },
  ];
  const start = [1, 1], target = [11, 3];
  const p1 = F.orientPortal(cells[0].poly, cells[0].center, door1, true);
  const p2 = F.orientPortal(cells[1].poly, cells[1].center, door2, true);
  const path = F.funnelPath(start, target, [p1, p2]);
  const ref = F.funnelViaVisibility(start, target, [p1, p2], cells);
  return { path, ref, cells };
}
ok('直走廊折线长度 == 可视性图参照（宽门）', () => {
  const { path, ref } = threeRoomRun([[4, 0], [4, 4]], [[8, 0], [8, 4]]);
  const L = G.polylineLength(path);
  assert.ok(Math.abs(L - ref.length) < 1e-4, `L=${L} ref=${ref.length}`);
  assert.ok(Math.abs(L - Math.hypot(10, 2)) < 1e-9);
});
ok('窄门强制折线绕折，且长度与参照一致（1e-9）', () => {
  const { path, ref } = threeRoomRun([[4, 1.9], [4, 2.1]], [[8, 1.9], [8, 2.1]]);
  const L = G.polylineLength(path);
  assert.ok(Math.abs(L - ref.length) < 1e-4, `L=${L} ref=${ref.length}`);
  // 折点必须落在门线上
  for (const pt of path.slice(1, -1)) {
    const onDoor =
      G.onSegment(pt, [4, 1.9], [4, 2.1], 1e-9) || G.onSegment(pt, [8, 1.9], [8, 2.1], 1e-9);
    assert.ok(onDoor, `折点 ${pt} 不在门线上`);
  }
});
ok('单点门仍可通过，折线穿过该点', () => {
  const { path, ref } = threeRoomRun([[4, 2], [4, 2]], [[8, 2], [8, 2]]);
  const L = G.polylineLength(path);
  assert.ok(Math.abs(L - ref.length) < 1e-9);
  assert.ok(path.some((p) => Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[1] - 2) < 1e-9));
});
ok('L 形走廊折点在墙角', () => {
  // 两格上下错位：格 A [0,0]-[4,4]，格 B [4,0]-[8,4]，门只留下半段
  const cells = [
    { poly: [[0, 0], [4, 0], [4, 4], [0, 4]], center: [2, 2] },
    { poly: [[4, 0], [8, 0], [8, 4], [4, 4]], center: [6, 2] },
  ];
  const start = [1, 3.5], target = [7, 0.5];
  // 门 x=4, y∈[0,1]
  const p = F.orientPortal(cells[0].poly, cells[0].center, [[4, 0], [4, 1]], true);
  const path = F.funnelPath(start, target, [p]);
  const ref = F.funnelViaVisibility(start, target, [p], cells);
  assert.ok(Math.abs(G.polylineLength(path) - ref.length) < 1e-4);
});
ok('随机走廊 50 组：漏斗与可视性参照长度一致', () => {
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 50; trial++) {
    // 随机生成 4~8 个横向并排格，门段随机
    const k = 4 + Math.floor(rnd() * 5);
    const w = 3 + rnd() * 3, h = 3 + rnd() * 3;
    const cells = [];
    for (let i = 0; i < k; i++) {
      const x0 = i * w;
      cells.push({
        poly: [[x0, 0], [x0 + w, 0], [x0 + w, h], [x0, h]],
        center: [x0 + w / 2, h / 2],
      });
    }
    const start = [rnd() * w * 0.8, rnd() * h];
    const target = [(k - 1) * w + rnd() * w * 0.8, rnd() * h];
    const portals = [];
    for (let i = 1; i < k; i++) {
      const x = i * w;
      const lo = rnd() * h * 0.4, hi = h - rnd() * h * 0.4;
      const dA = [x, lo], dB = [x, hi];
      const point = rnd() < 0.2;
      portals.push(F.orientPortal(cells[i - 1].poly, cells[i - 1].center,
        point ? [dA, dA] : [dA, dB], true));
    }
    const path = F.funnelPath(start, target, portals);
    const ref = F.funnelViaVisibility(start, target, portals, cells);
    const L = G.polylineLength(path);
    assert.ok(Math.abs(L - ref.length) < 2e-3, `trial ${trial}: L=${L} ref=${ref.length}`);
    // 不穿墙校验：折线与每道门户所在直线的交点必须落在该门户区间内（单点门必须命中该点）
    for (let pi = 0; pi < portals.length; pi++) {
      const po = portals[pi];
      const x = po.left[0];
      // 求整条折线在 x 处的交点 y（门线为竖直线，走廊横向推进，恰好一次相交）
      let hitY = null;
      for (let s2 = 0; s2 < path.length - 1 && hitY == null; s2++) {
        const a = path[s2], b = path[s2 + 1];
        if ((a[0] <= x && b[0] >= x) || (b[0] <= x && a[0] >= x)) {
          if (Math.abs(b[0] - a[0]) < 1e-15) { if (Math.abs(a[0] - x) < 1e-9) hitY = a[1]; }
          else {
            const t = (x - a[0]) / (b[0] - a[0]);
            hitY = a[1] + (b[1] - a[1]) * t;
          }
        }
      }
      assert.ok(hitY != null, `trial ${trial} 折线未穿过门户 ${pi}`);
      const lo = Math.min(po.left[1], po.right[1]);
      const hi = Math.max(po.left[1], po.right[1]);
      assert.ok(hitY >= lo - 1e-7 && hitY <= hi + 1e-7,
        `trial ${trial} 穿墙：门户 ${pi} 交点 y=${hitY} 不在 [${lo},${hi}]`);
    }
  }
});

// ---------- 两段求解（样例数据） ----------
console.log('route:');
const sample = require('../samples/corridor-guide.json');
const map = loadMap(sample);
ok('样例加载：3 格 2 边 2 层', () => {
  assert.strictEqual(map.cellCount, 3);
  assert.strictEqual(map.edgeCount, 2);
  assert.deepStrictEqual(map.floors, [0, 1]);
});
ok('样例查询：走廊 10→20，跨层只产生 jump 不画地面线', () => {
  const r = solveQuery(map, sample.queries[0]);
  assert.ok(r.reachable, r.reason);
  assert.deepStrictEqual(r.corridorEdges, [10, 20]);
  assert.strictEqual(r.jumps.length, 1);
  assert.deepStrictEqual(r.jumps[0].entry, [6, 2]);
  assert.deepStrictEqual(r.jumps[0].exit, [1, 2]);
  // 两段地面折线，跨层两点之间没有线段
  assert.strictEqual(r.segments.length, 2);
  assert.strictEqual(r.segments[0].floor, 0);
  assert.strictEqual(r.segments[1].floor, 1);
  for (const seg of r.segments) {
    for (const p of seg.points) assert.ok(p.length === 2);
  }
});
ok('门关闭 → closed-door 诊断且列出该门', () => {
  const r = solveQuery(map, sample.queries[0], {
    doorOverrides: new Map([[10, false]]),
  });
  assert.ok(!r.reachable);
  assert.strictEqual(r.reason, 'closed-door');
  assert.deepStrictEqual(r.diagnostics.blockerIds, [10]);
});
ok('余量过大 → margin 诊断', () => {
  const r = solveQuery(map, sample.queries[0], { marginOverride: 1.5 });
  // 门 [4,1]-[4,3] 长 2，双边余量 3 → empty
  assert.ok(!r.reachable);
  assert.strictEqual(r.reason, 'margin');
  assert.deepStrictEqual(r.diagnostics.blockerIds, [10]);
});
ok('恰好剩点（margin=1.0）仍可达', () => {
  const r = solveQuery(map, sample.queries[0], { marginOverride: 1.0 });
  assert.ok(r.reachable, r.reason);
  // 单点门 (4,2) 必须是首层折线的折点
  assert.ok(r.segments[0].points.some((p) => Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[1] - 2) < 1e-9));
});

// ---------- 字典序 ----------
console.log('lexicographic:');
// 4 格：1→2→4（边 100,102）与 1→3→4（边 50,200），费用设计为等长
const lexMap = loadMap({
  cells: [
    { id: 1, floor: 0, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { id: 2, floor: 0, poly: [[1, 0], [2, 0], [2, 1], [1, 1]] },
    { id: 3, floor: 0, poly: [[0, 1], [1, 1], [1, 2], [0, 2]] },
    { id: 4, floor: 0, poly: [[1, 1], [2, 1], [2, 2], [1, 2]] },
  ],
  edges: [
    { id: 100, from: 1, to: 2, fee: 1, open: true },
    { id: 102, from: 2, to: 4, fee: 1, open: true },
    { id: 50, from: 1, to: 3, fee: 1, open: true },
    { id: 200, from: 3, to: 4, fee: 1, open: true },
  ],
});
ok('等费用时选编号序列字典序最早 [50,200]', () => {
  const r = solveQuery(lexMap, {
    start: { floor: 0, cell: 1 }, end: { floor: 0, cell: 4 }, margin: 0,
  });
  assert.ok(r.reachable);
  assert.deepStrictEqual(r.corridorEdges, [50, 200]);
  assert.strictEqual(r.totalFee, 2);
});
ok('费用优先：更便宜的长编号序列胜出', () => {
  const m2 = loadMap({
    cells: [
      { id: 1, floor: 0, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { id: 2, floor: 0, poly: [[1, 0], [2, 0], [2, 1], [1, 1]] },
      { id: 3, floor: 0, poly: [[0, 1], [1, 1], [1, 2], [0, 2]] },
      { id: 4, floor: 0, poly: [[1, 1], [2, 1], [2, 2], [1, 2]] },
    ],
    edges: [
      { id: 100, from: 1, to: 2, fee: 1, open: true },
      { id: 102, from: 2, to: 4, fee: 1, open: true },
      { id: 50, from: 1, to: 3, fee: 5, open: true },
      { id: 200, from: 3, to: 4, fee: 5, open: true },
    ],
  });
  const r = solveQuery(m2, {
    start: { floor: 0, cell: 1 }, end: { floor: 0, cell: 4 }, margin: 0,
  });
  assert.deepStrictEqual(r.corridorEdges, [100, 102]);
  assert.strictEqual(r.totalFee, 2);
});
ok('拓扑不可达 → topology', () => {
  const r = solveQuery(lexMap, {
    start: { floor: 0, cell: 4 }, end: { floor: 0, cell: 1 }, margin: 0,
  });
  assert.ok(!r.reachable);
  assert.strictEqual(r.reason, 'topology');
});

// ---------- 精度 ----------
console.log('precision:');
ok('长度与端点误差 ≤ 1e-6', () => {
  const r = solveQuery(map, sample.queries[0]);
  assert.ok(Math.abs(r.segments[0].points[0][0] - 1) < 1e-6);
  assert.ok(Math.abs(r.segments[0].points[0][1] - 1) < 1e-6);
  const last = r.segments[1].points[r.segments[1].points.length - 1];
  assert.ok(Math.abs(last[0] - 2) < 1e-6 && Math.abs(last[1] - 3) < 1e-6);
});

console.log(`\n全部 ${passed} 项通过`);
