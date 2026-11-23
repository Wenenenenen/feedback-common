/*
 * route.js — 两段求解编排
 *   阶段 1：门状态/余量 → 临时通行图 → 最小费用 + 连接编号序列最早的走廊
 *   阶段 2：按跨层跳跃把走廊切成同层段，每段独立跑漏斗算法求最短折线
 * 跨层入口→出口只记录为 jump，绝不画成地面折线。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./geometry'),
      require('./dijkstra'),
      require('./funnel')
    );
  } else root.CG = Object.assign(root.CG || {}, factory(root.CG, root.CG, root.CG));
})(typeof self !== 'undefined' ? self : globalThis, function (G, D, F) {
  'use strict';

  const { EPS, dist, pointInConvex } = G;

  function resolvePoint(map, cellIdx, point) {
    const c = map.cells[cellIdx];
    if (Array.isArray(point) && point.length >= 2) {
      const p = [point[0], point[1]];
      const inside = pointInConvex(p, c.poly, 1e-7);
      return { point: p, inside, fallback: false };
    }
    return { point: c.center.slice(), inside: true, fallback: true };
  }

  /**
   * @param map     loadMap 的结果
   * @param query   {start:{floor,cell,point?}, end:{...}, margin:number}
   * @param options {doorOverrides?: Map(edgeId->bool), marginOverride?}
   */
  function solveQuery(map, query, options) {
    options = options || {};
    const margin = options.marginOverride != null ? options.marginOverride : Number(query.margin || 0);
    const overrides = options.doorOverrides;

    // ---- 起终点解析 ----
    const startIdx = map.idToIdx.get(query.start.cell);
    const endIdx = map.idToIdx.get(query.end.cell);
    const result = {
      reachable: false,
      reason: null,
      start: null,
      end: null,
      corridorEdges: [],   // 连接编号序列（跨层边在内）
      corridorCells: [],   // 格编号序列
      totalFee: 0,
      segments: [],        // 同层折线 {floor, cells:[idx], points:[xy], length}
      jumps: [],           // {edgeId, fromFloor,toFloor, entry, exit}
      totalLength: 0,
      diagnostics: null,
      warnings: [],
      elapsedMs: 0,
    };

    if (startIdx == null) { result.reason = 'bad-start-cell'; return result; }
    if (endIdx == null) { result.reason = 'bad-end-cell'; return result; }
    const s = resolvePoint(map, startIdx, query.start.point);
    const t = resolvePoint(map, endIdx, query.end.point);
    result.start = { floor: query.start.floor, cell: query.start.cell, point: s.point };
    result.end = { floor: query.end.floor, cell: query.end.cell, point: t.point };
    if (!s.inside) result.warnings.push(`起点不在 cell ${query.start.cell} 内（仍按给定坐标求解）`);
    if (!t.inside) result.warnings.push(`终点不在 cell ${query.end.cell} 内（仍按给定坐标求解）`);
    if (map.cells[startIdx].floor !== query.start.floor) {
      result.warnings.push(`起点楼层与 cell ${query.start.cell} 所在楼层不一致`);
    }
    if (map.cells[endIdx].floor !== query.end.floor) {
      result.warnings.push(`终点楼层与 cell ${query.end.cell} 所在楼层不一致`);
    }

    // ---- 本次查询的可通行性与门户缓存 ----
    const nE = map.edgeCount;
    const passable = new Uint8Array(nE);
    const portalCache = new Array(nE);
    const isDoor = (ei) => map.edges[ei].kind === 'door';
    for (let ei = 0; ei < nE; ei++) {
      const e = map.edges[ei];
      if (overrides && overrides.has(e.id) && !overrides.get(e.id)) continue;
      const p = map.portalOf(ei, margin);
      portalCache[ei] = p;
      if (p.usable) passable[ei] = 1;
    }
    const canPass = (ei) => passable[ei] === 1;
    // 合并 UI 门状态覆盖后的“门是否开启”判定（不含余量因素）
    const isOpen = (ei) => {
      const e = map.edges[ei];
      if (overrides && overrides.has(e.id)) return !!overrides.get(e.id);
      return e.open;
    };

    // ---- 阶段 1：走廊选择 ----
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const diag = D.diagnose(map, startIdx, endIdx, canPass, isDoor, isOpen);
    result.diagnostics = {
      level: diag.level,
      reason: diag.reason,
      blockerIds: diag.blockers.map((ei) => map.edges[ei].id),
    };
    if (!Number.isFinite(diag.dist[startIdx])) {
      result.reason = diag.reason; // topology | closed-door | margin
      result.elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return result;
    }

    const walk = D.lexMinWalk(map, startIdx, diag.dist, canPass);
    if (!walk) {
      result.reason = 'zero-fee-cycle';
      result.elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return result;
    }

    result.corridorEdges = walk.edgePath.map((ei) => map.edges[ei].id);
    result.corridorCells = walk.cellPath.map((ci) => map.cells[ci].id);
    result.totalFee = diag.dist[startIdx];

    // ---- 阶段 2：按跨层 link 切段，段内漏斗 ----
    let runStart = 0; // cellPath 下标
    const edgePath = walk.edgePath;
    const cellPath = walk.cellPath;

    const buildRun = (runEnd, startPt, endPt) => {
      const floor = map.cells[cellPath[runStart]].floor;
      const runCells = cellPath.slice(runStart, runEnd + 1).map((ci) => map.cells[ci]);
      const portals = [];
      for (let k = runStart; k < runEnd; k++) {
        const ei = edgePath[k];
        const e = map.edges[ei];
        const portalInfo = portalCache[ei];
        const forward = e.fromIdx === cellPath[k];
        const fromCell = map.cells[cellPath[k]];
        let portalPts;
        if (portalInfo.kind === 'point') portalPts = [portalInfo.portal[0], portalInfo.portal[0]];
        else portalPts = portalInfo.portal; // [a,b]
        const oriented = F.orientPortal(fromCell.poly, fromCell.center, portalPts, forward);
        portals.push(oriented);
      }
      const points = F.funnelPath(startPt, endPt, portals);
      let length = 0;
      for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
      return {
        floor,
        cells: runCells.map((c) => c.id),
        points,
        length,
      };
    };

    let currentPoint = s.point;
    for (let k = 0; k < edgePath.length; k++) {
      const e = map.edges[edgePath[k]];
      if (e.kind === 'link') {
        // 同层段：runStart..k（格链 cellPath[runStart..k]）
        const seg = buildRun(k, currentPoint, e.link.entry);
        result.segments.push(seg);
        result.totalLength += seg.length;
        result.jumps.push({
          edgeId: e.id,
          fromFloor: e.fromFloor,
          toFloor: e.toFloor,
          entry: e.link.entry.slice(),
          exit: e.link.exit.slice(),
        });
        runStart = k + 1;
        currentPoint = e.link.exit;
      }
    }
    // 末段
    const lastSeg = buildRun(edgePath.length, currentPoint, t.point);
    result.segments.push(lastSeg);
    result.totalLength += lastSeg.length;

    result.reachable = true;
    result.elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return result;
  }

  return { solveQuery, resolvePoint };
});
