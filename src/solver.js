/*
 * solver.js — 解析隐线求解（无像素采样、无第三方隐线库）
 *
 * 核心原理：
 *  1. 特征边与所有遮挡三角形都先经过齐次六平面裁剪；
 *  2. 在屏幕（NDC xy）平面上，用 Sutherland–Hodgman 求边与遮挡三角形
 *     的重叠参数区间（u 为原始边的世界线段参数，裁剪交点线性继承）；
 *  3. NDC 深度在屏幕参数下：
 *       - 对边是 u 的一次函数；
 *       - 对三角形可用二维重心坐标线性插值，同样是 u 的一次函数；
 *     因此深度差 D(u)=zTri(u)-zEdge(u) 是一次函数，解析求根；
 *  4. 仅当 D(u) < -DEPTH_EPS 才隐藏（等深、相切保留可见，避免假缺口）；
 *  5. 多遮挡区间取并集，记录每个隐藏区间的遮挡面 ID 集合。
 * 全程在 NDC/参数空间完成，与导出分辨率无关。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});
  const M = HLM.math;
  const CAM = HLM.camera;
  const CLIP = HLM.clipper;

  const DEPTH_EPS = 1e-6;     // 严格深度差阈值（格式说明约定）
  const GEOM_EPS = 1e-12;     // 二维包含/裁剪数值容差
  const GRID_N = 32;          // NDC 空间均匀网格，加速边-三角检索

  /**
   * 求解入口。
   * @param mesh buildMesh 产出（边已按当前折痕角分类）
   * @param camera createCamera 产出
   * @param positions 世界顶点
   */
  function solve(mesh, camera, positions) {
    const triGeom = buildOccluderGeometry(mesh, camera, positions);
    const grid = buildGrid(triGeom);
    const edges = mesh.edges.map(e =>
      solveEdge(e, mesh, camera, positions, triGeom, grid));
    return {
      edges,
      triangles: triGeom,
      stats: {
        faceCount: mesh.faces.length,
        edgeCount: mesh.edges.length,
        featureCount: mesh.edges.filter(HLM.mesh.isFeatureEdge).length,
        clipTriangleCount: triGeom.length,
      },
    };
  }

  /* ---------------- 遮挡三角形几何（裁剪 + 扇形三角化） ---------------- */

  function buildOccluderGeometry(mesh, camera) {
    const out = [];
    for (const face of mesh.faces) {
      if (face.degenerate) continue;
      const [i0, i1, i2] = face.verts;
      const c0 = CAM.worldToClip(camera, mesh.positions[i0]);
      const c1 = CAM.worldToClip(camera, mesh.positions[i1]);
      const c2 = CAM.worldToClip(camera, mesh.positions[i2]);
      const poly = CLIP.clipPolygon([{ c: c0 }, { c: c1 }, { c: c2 }]);
      if (poly.length < 3) continue;
      const ndc = poly.map(v => CAM.clipToNdc(v.c));
      // 凸多边形扇形三角化；同一原始面的所有子三角形保留同一 faceId
      for (let k = 1; k + 1 < ndc.length; k++) {
        const tri = [ndc[0], ndc[k], ndc[k + 1]];
        if (triArea2(tri) <= GEOM_EPS) continue; // 投影零面积忽略
        out.push({ faceId: face.id, tri });
      }
    }
    return out;
  }

  function triArea2(tri) {
    return Math.abs(cross2(
      sub2(tri[1], tri[0]),
      sub2(tri[2], tri[0])
    ));
  }

  /* ---------------- 屏幕空间均匀网格 ---------------- */

  function buildGrid(tris) {
    const cells = Array.from({ length: GRID_N * GRID_N }, () => []);
    tris.forEach((g, idx) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of g.tri) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      const c0 = cellRange(minX, 'x'), c1 = cellRange(maxX, 'x');
      const r0 = cellRange(minY, 'y'), r1 = cellRange(maxY, 'y');
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) cells[r * GRID_N + c].push(idx);
      }
    });
    return cells;
  }

  function cellRange(v) {
    const idx = Math.floor((v + 1) * 0.5 * GRID_N);
    return M.clamp(idx, 0, GRID_N - 1);
  }

  function queryGrid(grid, segA, segB, out) {
    const minX = Math.min(segA[0], segB[0]), maxX = Math.max(segA[0], segB[0]);
    const minY = Math.min(segA[1], segB[1]), maxY = Math.max(segA[1], segB[1]);
    for (let r = cellRange(minY); r <= cellRange(maxY); r++) {
      for (let c = cellRange(minX); c <= cellRange(maxX); c++) {
        for (const idx of grid[r * GRID_N + c]) out.add(idx);
      }
    }
  }

  /* ---------------- 单条边求解 ---------------- */

  function solveEdge(e, mesh, camera, positions, triGeom, grid) {
    const base = {
      edgeId: e.id,
      verts: [e.a, e.b],
      types: { ...e.types },
      feature: HLM.mesh.isFeatureEdge(e),
      faceIds: e.faceIds.slice(),
      clip: null,
      intervals: [],
    };

    const pA = positions[e.a], pB = positions[e.b];
    if (M.length(M.sub(pB, pA)) <= 1e-20) return base; // 世界零长度退化边，忽略

    const seg = CLIP.clipSegment(
      CAM.worldToClip(camera, pA),
      CAM.worldToClip(camera, pB)
    );
    if (!seg) return base; // 整条边在视锥外

    const n0 = CAM.clipToNdc(seg.c0);
    const n1 = CAM.clipToNdc(seg.c1);
    // 屏幕投影退化为点（如沿视轴的边）：保留裁剪区间与深度信息，
    // 但标记 pointProjected，渲染/导出时不产生笔划，遮挡解析也无二维区间可求。
    const screenLen = Math.hypot(n1[0] - n0[0], n1[1] - n0[1]);
    const pointProjected = screenLen <= GEOM_EPS;

    const clip = {
      u0: seg.t0, u1: seg.t1,
      ndc0: n0, ndc1: n1,
      pointProjected,
    };
    base.clip = clip;

    if (!base.feature) return base;      // 非特征边不做遮挡解析
    if (pointProjected) {
      // 退化为屏幕点：输出单段可见区间（深度归属由该点处的面遮挡关系决定，
      // 无线段区间，按可见处理并保留 u 范围供检视）。
      base.intervals = [{ u0: seg.t0, u1: seg.t1, visible: true, occluderFaceIds: [] }];
      return base;
    }

    const candidates = new Set();
    queryGrid(grid, [n0[0], n0[1]], [n1[0], n1[1]], candidates);

    const fragments = [];
    for (const idx of candidates) {
      const g = triGeom[idx];
      if (e.faceIds.includes(g.faceId)) continue; // 排除自身所有关联面
      testOccluder(clip, g, fragments);
    }

    base.intervals = assembleIntervals(seg.t0, seg.t1, fragments);
    return base;
  }

  /**
   * 单个遮挡三角形对一条裁剪后边的解析测试。
   * 命中时向 fragments 推入 {u0,u1,faceId}。
   */
  function testOccluder(clip, g, fragments) {
    const A = clip.ndc0, B = clip.ndc1;
    const tri = g.tri;
    const overlap = segmentTriangleOverlap(A, B, tri);
    if (!overlap) return;
    const [lo, hi] = overlap;
    if (hi - lo <= GEOM_EPS) return;

    // 端点处的边深度（NDC z 沿边为 u 的一次函数）
    const zEdgeLo = A[2] + (B[2] - A[2]) * lo;
    const zEdgeHi = A[2] + (B[2] - A[2]) * hi;
    // 端点处的三角形深度（二维重心插值，NDC z 为屏幕坐标一次函数）
    const wLo = baryWeights(pointAt(A, B, lo), tri);
    const wHi = baryWeights(pointAt(A, B, hi), tri);
    const zTriLo = wLo[0] * tri[0][2] + wLo[1] * tri[1][2] + wLo[2] * tri[2][2];
    const zTriHi = wHi[0] * tri[0][2] + wHi[1] * tri[1][2] + wHi[2] * tri[2][2];

    const dLo = zTriLo - zEdgeLo;
    const dHi = zTriHi - zEdgeHi;
    const hiddenLo = dLo < -DEPTH_EPS;
    const hiddenHi = dHi < -DEPTH_EPS;

    if (hiddenLo && hiddenHi) {
      fragments.push({ u0: lo, u1: hi, faceId: g.faceId });
      return;
    }
    if (!hiddenLo && !hiddenHi) {
      // 一次函数两端均不隐藏：整体可见（等深/相切 D≈0 自然落入此分支）
      return;
    }
    // 一端隐藏：解析求 D(u)=0 的根，在根两侧按严格阈值划分
    const tRoot = -dLo / (dHi - dLo);
    if (!Number.isFinite(tRoot) || tRoot <= GEOM_EPS || tRoot >= 1 - GEOM_EPS) return;
    const uRoot = lo + (hi - lo) * tRoot;
    if (hiddenLo) {
      fragments.push({ u0: lo, u1: uRoot, faceId: g.faceId });
    } else {
      fragments.push({ u0: uRoot, u1: hi, faceId: g.faceId });
    }
  }

  /**
   * 扫描线合并：把所有遮挡片段取并集，输出 [u0,u1] 上互斥且有序的区间序列，
   * 每段带 visible 标志与遮挡面 ID 集合。相切的零长度重叠不会产生片段。
   */
  function assembleIntervals(u0, u1, fragments) {
    if (fragments.length === 0) {
      return [{ u0, u1, visible: true, occluderFaceIds: [] }];
    }
    const events = [];
    for (const f of fragments) {
      events.push({ u: f.u0, start: true, faceId: f.faceId });
      events.push({ u: f.u1, start: false, faceId: f.faceId });
    }
    events.sort((a, b) => {
      if (a.u !== b.u) return a.u - b.u;
      // 同一坐标先处理结束再处理开始，保证切点不残留零长度隐藏段
      return (a.start ? 1 : 0) - (b.start ? 1 : 0);
    });

    const active = new Set();
    const raw = [];
    let cursor = u0;
    const emit = (end) => {
      if (end - cursor <= GEOM_EPS) return;
      raw.push({
        u0: cursor, u1: end,
        visible: active.size === 0,
        occluderFaceIds: [...active].sort((a, b) => a - b),
      });
    };

    for (const ev of events) {
      if (ev.u > cursor + GEOM_EPS) emit(Math.min(ev.u, u1));
      cursor = Math.max(cursor, Math.min(ev.u, u1));
      if (ev.start) active.add(ev.faceId); else active.delete(ev.faceId);
      if (cursor >= u1) break;
    }
    if (cursor < u1 - GEOM_EPS) emit(u1);

    // 相邻隐藏段合并（遮挡面交接不产生假缺口），遮挡面 ID 取并集；
    // 可见段与隐藏段之间保持分界。
    const result = [];
    for (const seg of raw) {
      const prev = result[result.length - 1];
      if (prev && !prev.visible && !seg.visible &&
          Math.abs(seg.u0 - prev.u1) <= GEOM_EPS) {
        prev.u1 = seg.u1;
        const merged = new Set([...prev.occluderFaceIds, ...seg.occluderFaceIds]);
        prev.occluderFaceIds = [...merged].sort((a, b) => a - b);
      } else {
        result.push({ ...seg });
      }
    }
    return result;
  }

  /* ---------------- 二维几何工具 ---------------- */

  function sub2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
  function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.hypot(dx, dy);
  }
  function pointAt(A, B, t) {
    return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  }

  /**
   * 线段 A->B（参数 t∈[0,1]）与三角形的二维重叠，返回 [t0,t1] 或 null。
   * 逐边 Sutherland–Hodgman 裁剪，内部用带符号 cross 判别，顺/逆时针三角皆可。
   */
  function segmentTriangleOverlap(A, B, tri) {
    let lo = 0, hi = 1;
    const d = sub2(B, A);
    for (let i = 0; i < 3; i++) {
      const P = tri[i], Q = tri[(i + 1) % 3];
      const e = sub2(Q, P);
      const sA = cross2(e, sub2(A, P));
      const sB = cross2(e, sub2(B, P));
      const inA = sA >= -GEOM_EPS;
      const inB = sB >= -GEOM_EPS;
      if (inA && inB) continue;
      if (!inA && !inB) return null;
      const t = sA / (sA - sB);
      if (inA) hi = Math.min(hi, t); else lo = Math.max(lo, t);
      if (lo > hi + GEOM_EPS) return null;
    }
    lo = M.clamp(lo, 0, 1);
    hi = M.clamp(hi, 0, 1);
    if (hi - lo <= GEOM_EPS) return null;
    return [lo, hi];
  }

  /** 点相对三角形的重心坐标 */
  function baryWeights(p, tri) {
    const [A, B, C] = tri;
    const den = cross2(sub2(B, A), sub2(C, A));
    const w0 = cross2(sub2(B, p), sub2(C, p)) / den;
    const w1 = cross2(sub2(C, p), sub2(A, p)) / den;
    return [w0, w1, 1 - w0 - w1];
  }

  HLM.solver = {
    solve, DEPTH_EPS,
    // 导出供测试直接调用
    segmentTriangleOverlap, baryWeights, assembleIntervals, testOccluder,
  };
})(typeof window !== 'undefined' ? window : globalThis);
