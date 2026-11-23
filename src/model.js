/*
 * model.js — 地图数据模型
 * 解析 samples/corridor-guide.json 格式，建立稠密索引、邻接表，
 * 并按“门状态 + 余量”动态计算每条有向边的可通行门户（portal）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    const G = require('./geometry');
    module.exports = factory(G);
  } else root.CG = Object.assign(root.CG || {}, factory(root.CG));
})(typeof self !== 'undefined' ? self : globalThis, function (G) {
  'use strict';

  const { EPS, dist, sharedEdge, applyMargin, signedArea, pointInConvex, onSegment, centroid } = G;

  function isConvex(poly) {
    let sign = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const c = G.cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
      if (Math.abs(c) <= EPS) continue;
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // 统一成 CCW，返回新数组
  function normalizeWinding(poly) {
    const p = poly.map((v) => [v[0], v[1]]);
    if (signedArea(p) < 0) p.reverse();
    return p;
  }

  function loadMap(raw) {
    const warnings = [];
    if (!raw || !Array.isArray(raw.cells) || !Array.isArray(raw.edges)) {
      throw new Error('数据格式错误：顶层必须包含 cells 与 edges 数组');
    }

    // ---- cells ----
    const idToIdx = new Map();
    const cells = [];
    raw.cells.forEach((c, i) => {
      if (!Array.isArray(c.poly) || c.poly.length < 3) {
        throw new Error(`cell ${c.id} 不是有效多边形（至少 3 个顶点）`);
      }
      if (idToIdx.has(c.id)) throw new Error(`cell id 重复: ${c.id}`);
      const poly = normalizeWinding(c.poly);
      if (!isConvex(poly)) warnings.push(`cell ${c.id} 不是凸多边形，结果未定义`);
      idToIdx.set(c.id, i);
      cells.push({
        idx: i,
        id: c.id,
        floor: c.floor | 0,
        poly,
        center: centroid(poly),
      });
    });

    // ---- edges ----
    const edges = [];
    const edgeIds = new Set();
    raw.edges.forEach((e) => {
      if (edgeIds.has(e.id)) throw new Error(`edge id 重复: ${e.id}`);
      edgeIds.add(e.id);
      if (!idToIdx.has(e.from) || !idToIdx.has(e.to)) {
        throw new Error(`edge ${e.id} 引用了不存在的 cell: ${e.from} -> ${e.to}`);
      }
      const fromIdx = idToIdx.get(e.from);
      const toIdx = idToIdx.get(e.to);
      const a = cells[fromIdx], b = cells[toIdx];
      const crossFloor = a.floor !== b.floor;
      const hasLink = !!e.link;
      const hasDoor = !!e.door;

      if (crossFloor && !hasLink) {
        warnings.push(`edge ${e.id} 跨层但缺少 link，按不可通行处理`);
      }
      if (!crossFloor && hasLink) {
        warnings.push(`edge ${e.id} 同层却带 link，link 将被忽略`);
      }

      let kind;
      if (crossFloor && hasLink) kind = 'link';
      else if (hasDoor) kind = 'door';
      else kind = 'wall';

      let shared = null;
      let door = null;
      let link = null;

      if (!crossFloor) {
        shared = sharedEdge(a.poly, b.poly, 1e-9);
        if (!shared) warnings.push(`edge ${e.id} 的两个同层格 ${e.from}/${e.to} 没有共边线`);
        if (hasDoor) {
          door = [e.door[0].slice(), e.door[1].slice()];
          if (shared) {
            for (const p of door) {
              if (!onSegment(p, shared[0], shared[1], 1e-7)) {
                warnings.push(`edge ${e.id} 的门点 ${JSON.stringify(p)} 不在共边线上`);
              }
            }
          }
        }
      } else if (hasLink) {
        link = { entry: e.link[0].slice(), exit: e.link[1].slice() };
        if (!pointInConvex(link.entry, a.poly, 1e-7)) {
          warnings.push(`edge ${e.id} 入口点不在 cell ${e.from} 内`);
        }
        if (!pointInConvex(link.exit, b.poly, 1e-7)) {
          warnings.push(`edge ${e.id} 出口点不在 cell ${e.to} 内`);
        }
      }

      edges.push({
        id: e.id,
        index: edges.length,
        fromIdx,
        toIdx,
        fromId: e.from,
        toId: e.to,
        fromFloor: a.floor,
        toFloor: b.floor,
        fee: Number(e.fee) || 0,
        open: e.open !== false, // 缺省视为开
        kind, // 'door' | 'wall' | 'link'
        door,
        shared,
        link,
      });
    });

    // ---- 邻接表（按 edge id 排序，保证枚举确定性）----
    edges.sort((x, y) => x.id - y.id);
    edges.forEach((e, i) => { e.index = i; });
    const adj = cells.map(() => []);
    const revAdj = cells.map(() => []);
    for (const e of edges) {
      adj[e.fromIdx].push(e.index);
      revAdj[e.toIdx].push(e.index);
    }

    const floors = [...new Set(cells.map((c) => c.floor))].sort((x, y) => x - y);
    const cellsByFloor = floors.map(() => []);
    const floorIndex = new Map();
    floors.forEach((f, i) => floorIndex.set(f, i));
    for (const c of cells) cellsByFloor[floorIndex.get(c.floor)].push(c.idx);

    const map = {
      cells,
      edges,
      adj,
      revAdj,
      idToIdx,
      floors,
      cellsByFloor,
      floorIndex,
      warnings,
      cellCount: cells.length,
      edgeCount: edges.length,
    };

    // 动态门户：按当前门状态与余量计算
    // 返回 { usable, portal: [leftPt,rightPt] | {entry,exit}, reason }
    map.portalOf = function (edgeIdx, margin) {
      const e = edges[edgeIdx];
      if (!e.open) return { usable: false, reason: 'closed' };
      if (e.kind === 'link') {
        return { usable: true, kind: 'link', portal: { entry: e.link.entry, exit: e.link.exit } };
      }
      if (e.kind === 'door') {
        const cut = applyMargin(e.door[0], e.door[1], margin);
        if (cut.kind === 'empty') return { usable: false, reason: 'margin' };
        if (cut.kind === 'point') return { usable: true, kind: 'point', portal: [cut.p, cut.p] };
        return { usable: true, kind: 'segment', portal: [cut.a, cut.b] };
      }
      // wall：整条共边线通行；无共边则不可用
      if (!e.shared) return { usable: false, reason: 'no-shared-edge' };
      return { usable: true, kind: 'segment', portal: [e.shared[0], e.shared[1]] };
    };

    return map;
  }

  return { loadMap, isConvex, normalizeWinding };
});
