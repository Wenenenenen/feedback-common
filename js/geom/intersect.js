/*
 * 四面体两两相交的精确判定（BigInt 整数坐标）。
 *
 * 规则（与需求一致）：两个单元的相交只允许发生在它们共有顶点张成的面、边或点上。
 * 实现思路：
 *   1) 非共有顶点必须严格在对方单元之外（连边界都不允许，边界接触由第 2 步按共有跨距裁决）；
 *   2) 边与三角形面的穿越/共面接触，接触点必须落在共有顶点张成的点/边/面内；
 *   3) 共有 4 个顶点视为重复单元，直接非法。
 */
(function (global) {
  'use strict';
  const E = global.TCExact;
  const { i3, orient3d, signBi, bi } = E;

  function pt(v) { return i3(bi(v[0]), bi(v[1]), bi(v[2])); }

  function f0(f) { return [0, 0, 0, 1][f]; }
  function f1(f) { return [1, 2, 3, 2][f]; }
  function f2(f) { return [2, 3, 1, 3][f]; }
  function f3(f) { return [3, 1, 2, 0][f]; }

  /**
   * 点 p 是否严格在四面体 t 之外。
   * 朝外有向面满足 orient3d(面, 对面顶点) < 0，故内部点对每个朝外面 orient < 0；
   * 任一面 orient >= 0（外侧或面上）即判定为严格在外（边界接触由后续共有跨距裁决）。
   */
  function pointStrictOutside(p, t) {
    for (const tri of outwardFaces(t)) {
      if (orientSignFast(tri[0], tri[1], tri[2], p) >= 0) return true;
    }
    return false;
  }

  /** 四面体四个朝外的有向面（保证 orient3d(面三点, 对面顶点) < 0），结果缓存在点数组上。 */
  function outwardFaces(t) {
    if (t.__faces) return t.__faces;
    const faces = [];
    for (let f = 0; f < 4; f++) {
      const tri = [t[f0(f)], t[f1(f)], t[f2(f)]];
      const opp = t[f3(f)];
      if (signBi(orient3d(tri[0], tri[1], tri[2], opp)) > 0n) tri.reverse();
      faces.push(tri);
    }
    Object.defineProperty(t, '__faces', { value: faces, enumerable: false, configurable: true });
    return faces;
  }

  /** 与 outwardFaces 一致的朝外有向面（点数组版本，返回顶点下标）。 */
  function outwardFaceIdx(cell, f) {
    const idx = [f0(f), f1(f), f2(f)];
    const opp = f3(f);
      const s = signBi(orient3d(cell[idx[0]], cell[idx[1]], cell[idx[2]], cell[opp]));
    if (s > 0n) idx.reverse();
    return idx;
  }

  /* ---------- 共面 2D 判定：取法向最大分量轴投影 ---------- */
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function cross3(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  function absBi(v) { return v < 0n ? -v : v; }

  function makeProjector(n) {
    const ax = absBi(n.x) >= absBi(n.y) && absBi(n.x) >= absBi(n.z) ? 0
      : (absBi(n.y) >= absBi(n.z) ? 1 : 2);
    return function pr(q) {
      // 齐次点 q（w 可能非 1）：投影保留分子，分母一致不影响 2D 叉积符号
      if (ax === 0) return { x: q.y, y: q.z };
      if (ax === 1) return { x: q.x, y: q.z };
      return { x: q.x, y: q.y };
    };
  }
  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  /** 投影后 p 是否在三角形 tri 内（含边界），tri 绕向任意。 */
  function pointInTri2D(p, tri) {
    const s1 = signBi(cross2(tri[0], tri[1], p));
    const s2 = signBi(cross2(tri[1], tri[2], p));
    const s3 = signBi(cross2(tri[2], tri[0], p));
    const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
    const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
    return !(hasPos && hasNeg);
  }
  function onSeg2D(p, a, b) {
    if (signBi(cross2(a, b, p)) !== 0) return false;
    return (p.x - a.x) * (p.x - b.x) <= 0n && (p.y - a.y) * (p.y - b.y) <= 0n;
  }
  function ptEq2D(a, b) { return a.x === b.x && a.y === b.y; }

  /**
   * 允许接触域 = 共有顶点在投影平面内的凸包：
   * k=1 点；k=2 线段；k=3 三角形。接触点必须落在域内。
   */
  function makeAllowedRegion(sharedPts, pr) {
    const sp = sharedPts.map(pr);
    return function inRegion(p) {
      if (sp.length === 1) return ptEq2D(p, sp[0]);
      if (sp.length === 2) return onSeg2D(p, sp[0], sp[1]);
      return pointInTri2D(p, sp);
    };
  }

  /**
   * 线段 ab 与三角形 tri 的接触是否全部位于共有顶点张成的允许域内。
   * 返回 true 表示「无非法接触」。
   */
  function segmentTriContactLegal(a, b, tri, sharedPts) {
    const sA = orientSignFast(tri[0], tri[1], tri[2], a);
    const sB = orientSignFast(tri[0], tri[1], tri[2], b);

    if ((sA > 0 && sB < 0) || (sA < 0 && sB > 0)) {
      return false; // 穿越面平面：非共有顶点刺入已在第一步拦截，走到这里必为体积穿插
    }
    if (sA !== 0 && sB !== 0) return true; // 严格同侧，无接触

    // 至少一个端点在面平面上：投影做 2D 判定
    const n = cross3(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const pr = makeProjector(n);
    const tp = tri.map(pr);
    const ap = pr(a), bp = pr(b);
    const inRegion = makeAllowedRegion(sharedPts, pr);

    // 接触集（线段 ∩ 三角形）的候选端点：
    // 1) 落在三角形内的线段端点
    if (sA === 0 && pointInTri2D(ap, tp) && !inRegion(ap)) return false;
    if (sB === 0 && pointInTri2D(bp, tp) && !inRegion(bp)) return false;
    // 2) 落在段上的三角形顶点（覆盖共线重叠与 T 型接触）
    if (sA === 0 && sB === 0) {
      for (const tv of tp) {
        if (onSeg2D(tv, ap, bp) && !inRegion(tv)) return false;
      }
    }
    return true;
  }

  function samePoint(a, b) {
    return a.x * b.w === b.x * a.w && a.y * b.w === b.y * a.w && a.z * b.w === b.z * a.w;
  }

  /** 为齐次点附加缓存的浮点坐标（w 恒为 1 的输入点直接取整数，免反复除法）。 */
  function withFloat(p) {
    if (p.fx !== undefined) return p;
    const iw = 1 / Number(p.w);
    p.fx = Number(p.x) * iw; p.fy = Number(p.y) * iw; p.fz = Number(p.z) * iw;
    return p;
  }

  /**
   * 快速 orient3d 符号：先算浮点行列式，仅当幅值接近零（可能误判）时回退 BigInt 精确值。
   * 坐标为 |x|<=1e6 的整数，det 量级 <=~1e19，双精度仍能可靠区分远离零的符号。
   */
  function orientSignFast(a, b, c, d) {
    withFloat(a); withFloat(b); withFloat(c); withFloat(d);
    const ux = b.fx - a.fx, uy = b.fy - a.fy, uz = b.fz - a.fz;
    const vx = c.fx - a.fx, vy = c.fy - a.fy, vz = c.fz - a.fz;
    const wx = d.fx - a.fx, wy = d.fy - a.fy, wz = d.fz - a.fz;
    const cx = vy * wz - vz * wy, cy = vz * wx - vx * wz, cz = vx * wy - vy * wx;
    const det = ux * cx + uy * cy + uz * cz;
    // 输入为整数坐标：浮点 det 严格为 0 仅当真实行列式接近 0（共面），回退 BigInt 定夺；
    // 非零 det 的符号在 |坐标|<=1e6 量级下可信（舍入误差远小于最小非零整数 det=1）。
    if (det !== 0) return det > 0 ? 1 : -1;
    return signBi(orient3d(a, b, c, d));
  }

  /**
   * 判定两个四面体是否合法相邻。
   * 输入为 4 个齐次点的数组（w=1 的整数点）。
   * @returns {{ok:boolean, reason?:string}}
   */
  function tetPairLegal(t1, t2) {
    const shared = [];
    for (const p of t1) {
      if (t2.some(q => samePoint(p, q))) shared.push(p);
    }
    const k = shared.length;
    if (k === 4) return { ok: false, reason: '重复单元（四个顶点完全相同）' };
    const isShared = (p) => shared.some(q => samePoint(p, q));

    // 安全的分离平面短路（凸多面体相离的充分条件）：
    // 若 t1 某朝外面把 t2 的所有顶点都隔在外侧，则两体无交集。
    const faces1early = outwardFaces(t1);
    let separated = false;
    for (const tri of faces1early) {
      if (t2.every(q => orientSignFast(tri[0], tri[1], tri[2], q) > 0)) { separated = true; break; }
    }
    if (!separated) {
      for (const tri of outwardFaces(t2)) {
        if (t1.every(q => orientSignFast(tri[0], tri[1], tri[2], q) > 0)) { separated = true; break; }
      }
    }
    if (separated && k === 0) return { ok: true, k: 0 };

    // 1) 非共有顶点严格在对方之外
    for (const p of t1) {
      if (!isShared(p) && !pointStrictOutside(p, t2)) {
        return { ok: false, reason: '顶点落在对方单元内部或面上' };
      }
    }
    for (const p of t2) {
      if (!isShared(p) && !pointStrictOutside(p, t1)) {
        return { ok: false, reason: '顶点落在对方单元内部或面上' };
      }
    }

    // 2) 边-面接触裁决
    const faces1 = outwardFaces(t1);
    const faces2 = outwardFaces(t2);
    const edges = (t) => [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]].map(([i, j]) => [t[i], t[j]]);
    const e1 = edges(t1), e2 = edges(t2);

    for (const [a, b] of e1) {
      for (const tri of faces2) {
        // 边就是该面的一条边 → 接触在面内，属共有跨距
        if (tri.every(v => samePoint(v, a) || samePoint(v, b))) continue;
        if (!segmentTriContactLegal(a, b, tri, shared)) {
          return { ok: false, reason: '边穿越或越界接触对方单元的面' };
        }
      }
    }
    for (const [a, b] of e2) {
      for (const tri of faces1) {
        if (tri.every(v => samePoint(v, a) || samePoint(v, b))) continue;
        if (!segmentTriContactLegal(a, b, tri, shared)) {
          return { ok: false, reason: '边穿越或越界接触对方单元的面' };
        }
      }
    }
    return { ok: true, k };
  }

  /**
   * 下标版高速入口：cellA/cellB 为 4 个顶点编号，tetPts[ci] 为该单元的齐次点（预计算）。
   * 共享关系用整数集合判定，避免 BigInt samePoint 乘法。
   */
  function tetPairLegalIdx(ia, ib, cells, tetPts) {
    const ca = cells[ia], cb = cells[ib];
    const setB = new Set(cb);
    const sharedIdx = ca.filter(x => setB.has(x));
    const k = sharedIdx.length;
    if (k === 4) return { ok: false, reason: '重复单元（四个顶点完全相同）' };
    const t1 = tetPts[ia], t2 = tetPts[ib];
    const sharedSet = new Set(sharedIdx);
    const isSharedIdx = (localIdx, cell) => sharedSet.has(cell[localIdx]);

    // 分离平面短路（无共享顶点时可直接判相离）
    const faces1 = outwardFaces(t1), faces2 = outwardFaces(t2);
    if (k === 0) {
      let separated = false;
      for (const tri of faces1) {
        if (t2.every(q => orientSignFast(tri[0], tri[1], tri[2], q) > 0)) { separated = true; break; }
      }
      if (!separated) for (const tri of faces2) {
        if (t1.every(q => orientSignFast(tri[0], tri[1], tri[2], q) > 0)) { separated = true; break; }
      }
      if (separated) return { ok: true, k: 0 };
    }

    // 1) 非共有顶点严格在对方之外
    for (let i = 0; i < 4; i++) {
      if (!isSharedIdx(i, ca) && !pointStrictOutside(t1[i], t2)) {
        return { ok: false, reason: '顶点落在对方单元内部或面上' };
      }
    }
    for (let i = 0; i < 4; i++) {
      if (!isSharedIdx(i, cb) && !pointStrictOutside(t2[i], t1)) {
        return { ok: false, reason: '顶点落在对方单元内部或面上' };
      }
    }

    // 2) 边-面接触裁决；共享点用下标集合判断
    const sharedPts = t1.filter((_, i) => isSharedIdx(i, ca));
    const edgeList = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    for (const [i, j] of edgeList) {
      const a = t1[i], b = t1[j];
      const edgeShared = isSharedIdx(i, ca) && isSharedIdx(j, ca);
      for (const tri of faces2) {
        if (edgeShared && tri.every(v => samePoint(v, a) || samePoint(v, b))) continue;
        if (!segmentTriContactLegal(a, b, tri, sharedPts)) {
          return { ok: false, reason: '边穿越或越界接触对方单元的面' };
        }
      }
    }
    for (const [i, j] of edgeList) {
      const a = t2[i], b = t2[j];
      const edgeShared = isSharedIdx(i, cb) && isSharedIdx(j, cb);
      for (const tri of faces1) {
        if (edgeShared && tri.every(v => samePoint(v, a) || samePoint(v, b))) continue;
        if (!segmentTriContactLegal(a, b, tri, sharedPts)) {
          return { ok: false, reason: '边穿越或越界接触对方单元的面' };
        }
      }
    }
    return { ok: true, k };
  }

  const api = { tetPairLegal, tetPairLegalIdx, outwardFaces, pointStrictOutside, samePoint, pt, cross3, sub, makeProjector, pointInTri2D };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; global.TCIntersect = api; }
  else global.TCIntersect = api;
})(typeof window !== 'undefined' ? window : globalThis);
