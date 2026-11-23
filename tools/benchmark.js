/*
 * benchmark.js — 满载性能基准：200 条查询须在 8 秒内算完（不含画图）。
 * 用法：node tools/benchmark.js [mapPath]
 * 不带参数时先用 gen-map 生成内存满载地图。
 */
'use strict';
const { loadMap } = require('../src/model');
const { solveQuery } = require('../src/route');
const { generate } = require('./gen-map');

async function main() {
  let raw, label;
  if (process.argv[2]) {
    const fs = require('fs');
    raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    label = process.argv[2];
  } else {
    raw = generate(20000, 40000, 2);
    label = '内存生成满载地图';
  }

  const tLoad0 = Date.now();
  const map = loadMap(raw);
  const loadMs = Date.now() - tLoad0;
  console.log(`${label}: ${map.cellCount} 格 ${map.edgeCount} 边 ${map.floors.length} 层`);
  console.log(`加载+建索引: ${loadMs} ms；数据告警 ${map.warnings.length} 条`);

  const queries = raw.queries.slice(0, 200);
  let reachable = 0, unreachable = 0;
  let totalFee = 0, totalLen = 0, maxMs = 0;
  const reasonCount = {};

  const t0 = Date.now();
  for (const q of queries) {
    const r = solveQuery(map, q);
    maxMs = Math.max(maxMs, r.elapsedMs);
    if (r.reachable) {
      reachable++;
      totalFee += r.totalFee;
      totalLen += r.totalLength;
    } else {
      unreachable++;
      reasonCount[r.reason] = (reasonCount[r.reason] || 0) + 1;
    }
  }
  const elapsed = Date.now() - t0;

  console.log(`\n200 条查询总耗时: ${elapsed} ms（要求 < 8000 ms）${elapsed < 8000 ? ' ✓' : ' ✗ 超时'}`);
  console.log(`单条最大: ${maxMs.toFixed(2)} ms，平均: ${(elapsed / queries.length).toFixed(2)} ms`);
  console.log(`可达 ${reachable}，不可达 ${unreachable}`, unreachable ? JSON.stringify(reasonCount) : '');
  if (reachable) console.log(`累计费用 ${totalFee}，累计折线长度 ${totalLen.toFixed(2)}`);

  // 合法性校验（满载可承受）：每条同层折线与每道门线的交点必须落在门段内。
  // 长度最优性的数值互验由单元测试在小地图上用独立采样 DP 完成，避免 O(n²) 拖慢基准。
  let checked = 0;
  for (const q of queries) {
    const r = solveQuery(map, q);
    if (!r.reachable) continue;
    for (const seg of r.segments) {
      const runCells = seg.cells.map((id) => map.cells[map.idToIdx.get(id)]);
      for (let k = 0; k + 1 < runCells.length; k++) {
        const a = runCells[k], b = runCells[k + 1];
        const edge = map.edges.find((e) =>
          (e.fromIdx === a.idx && e.toIdx === b.idx) ||
          (e.fromIdx === b.idx && e.toIdx === a.idx));
        const info = map.portalOf(edge.index, q.margin || 0);
        if (info.kind === 'link') throw new Error('同层段内出现 link，数据异常');
        // 门线 = 两格共边线，取其中点/端点确定直线；这里校验折线穿过该边的位置在门户内
        const shared = edge.shared;
        const hit = polylineCrossesEdge(seg.points, shared);
        if (hit == null) throw new Error(`折线未穿过格 ${a.id}/${b.id} 的共边线`);
        const [p0, p1] = info.kind === 'point' ? [info.portal[0], info.portal[0]] : info.portal;
        if (!pointOnSegmentWithin(hit, p0, p1)) {
          throw new Error(`折线穿墙：交点 ${JSON.stringify(hit)} 不在门户 ${JSON.stringify([p0, p1])} 内`);
        }
      }
    }
    checked++;
  }
  console.log(`合法性校验 ${checked} 条可达结果：所有折线均按序穿门、未穿墙`);
}

// 求折线与一条共边线段的交点（走廊单调推进时恰好相交一次）
function polylineCrossesEdge(points, edge) {
  const G = require('../src/geometry');
  for (let i = 0; i + 1 < points.length; i++) {
    const hit = G.segmentIntersect(points[i], points[i + 1], edge[0], edge[1], 1e-9);
    if (hit.type === 'point') return hit.a;
    if (hit.type === 'segment') return hit.a;
  }
  return null;
}

function pointOnSegmentWithin(p, a, b) {
  const G = require('../src/geometry');
  return G.onSegment(p, a, b, 1e-7);
}

main().catch((e) => { console.error(e); process.exit(1); });
