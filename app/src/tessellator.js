/*
 * 自适应细分器
 *  - 每条边做一维屏幕误差自适应细分；接缝两边统一层级、共享位置索引（处理 reversed）
 *  - 片内四叉树递归细分，叶多边形收集边上全部已有顶点后扇形三角化 -> 无 T 形接点
 *  - 三角形屏幕误差：3 角 UV 重心 + 3 边 UV 中点，曲面真值投影 vs 三维线性插值投影
 *  - 支持取消令牌与协作式让出（每 N 个节点让出一次事件循环）
 */
(function (global) {
  'use strict';

  const { v3 } = global.Math3D;
  const B = global.Bezier;

  const YIELD_EVERY = 256;

  function makeToken() {
    return { cancelled: false };
  }

  function interrupted(token) {
    return !token || token.cancelled;
  }

  /* 边在给定层级下第 k 个点（k=0..2^level），自然参数 t */
  function edgePointAt(patch, edgeName, level, k) {
    const t = k / (1 << level);
    const [u, v] = B.edgeUV(edgeName, t);
    return { u, v, p: B.evalSurface(patch.points, u, v) };
  }

  /* 一维边细分：递归二分，直到屏幕误差达标或触顶；返回需要的层级 */
  function edgeRequiredLevel(ctx, patch, edgeName, t0, t1, depth, token) {
    if (depth >= ctx.maxDepth) return depth;
    const tm = (t0 + t1) / 2;
    const p0 = B.evalEdge(patch.points, edgeName, t0);
    const p1 = B.evalEdge(patch.points, edgeName, t1);
    const pm = B.evalEdge(patch.points, edgeName, tm);
    const pl = v3.lerp(p0, p1, 0.5);
    const err = ctx.camera.screenDistance(pm, pl);
    if (err <= ctx.pixelError) return depth;
    if (interrupted(token)) return depth;
    const dl = edgeRequiredLevel(ctx, patch, edgeName, t0, tm, depth + 1, token);
    const dr = edgeRequiredLevel(ctx, patch, edgeName, tm, t1, depth + 1, token);
    return Math.max(dl, dr);
  }

  function triangleScreenError(ctx, patch, corners) {
    // corners: [{u,v,p(3D网格点)}]，3 个，顺序 CCW
    const screen = corners.map((c) => ctx.camera.worldToScreen(c.p));
    let worst = 0;
    let worstSample = null;

    const samples = [
      // 逐角 UV 重心：三角形角点处，UV 取角点自身
      { u: corners[0].u, v: corners[0].v, s: screen[0], c: 0 },
      { u: corners[1].u, v: corners[1].v, s: screen[1], c: 1 },
      { u: corners[2].u, v: corners[2].v, s: screen[2], c: 2 },
      // 三边 UV 中点：曲面真值 vs 边两端三维线性插值
      { u: (corners[0].u + corners[1].u) / 2, v: (corners[0].v + corners[1].v) / 2,
        s: v3.lerp(screen[0], screen[1], 0.5) },
      { u: (corners[1].u + corners[2].u) / 2, v: (corners[1].v + corners[2].v) / 2,
        s: v3.lerp(screen[1], screen[2], 0.5) },
      { u: (corners[2].u + corners[0].u) / 2, v: (corners[2].v + corners[0].v) / 2,
        s: v3.lerp(screen[2], screen[0], 0.5) },
    ];

    for (const smp of samples) {
      const trueP = B.evalSurface(patch.points, smp.u, smp.v);
      const trueScreen = ctx.camera.worldToScreen(trueP);
      const d = Math.hypot(trueScreen[0] - smp.s[0], trueScreen[1] - smp.s[1]);
      if (d > worst) { worst = d; worstSample = smp; }
    }
    return { error: worst, sample: worstSample };
  }

  /* 节点四角误差测试：把节点当 2 个三角形，返回最大屏幕误差与是否达标 */
  function nodeTest(ctx, patch, u0, v0, u1, v1) {
    const c = [
      { u: u0, v: v0, p: B.evalSurface(patch.points, u0, v0) },
      { u: u1, v: v0, p: B.evalSurface(patch.points, u1, v0) },
      { u: u1, v: v1, p: B.evalSurface(patch.points, u1, v1) },
      { u: u0, v: v1, p: B.evalSurface(patch.points, u0, v1) },
    ];
    const t1 = triangleScreenError(ctx, patch, [c[0], c[1], c[2]]);
    const t2 = triangleScreenError(ctx, patch, [c[0], c[2], c[3]]);
    return Math.max(t1.error, t2.error);
  }

  async function tessellate(model, camera, options, onProgress) {
    const ctx = {
      camera,
      pixelError: options.pixelError,
      maxDepth: options.maxDepth,
    };
    const token = options.token || makeToken();
    const startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const positions = [];           // 全局共享位置（接缝共用索引）
    const keyToIndex = new Map();
    const triangles = [];
    const patchStats = [];
    let workCount = 0;
    const bump = async () => {
      if ((++workCount) % YIELD_EVERY === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    const addPosition = (key, p) => {
      const existing = keyToIndex.get(key);
      if (existing != null) return existing;
      const idx = positions.length;
      positions.push([p[0], p[1], p[2]]);
      keyToIndex.set(key, idx);
      return idx;
    };

    // ---- 1. 边层级：接缝统一 ----
    const edgeLevel = new Map();       // patchId.edge -> level
    const seamOfEdge = new Map();      // patchId.edge -> seam 对象
    model.seams.forEach((s) => {
      seamOfEdge.set(`${s.a[0]}.${s.a[1]}`, s);
      seamOfEdge.set(`${s.b[0]}.${s.b[1]}`, s);
    });

    const patchById = new Map(model.patches.map((p) => [p.id, p]));

    for (const patch of model.patches) {
      if (token.cancelled) return { cancelled: true };
      for (const edgeName of B.EDGES) {
        const key = `${patch.id}.${edgeName}`;
        const seam = seamOfEdge.get(key);
        const ownLevel = edgeRequiredLevel(ctx, patch, edgeName, 0, 1, 0, token);
        if (!seam) {
          edgeLevel.set(key, ownLevel);
        } else if (key === `${seam.a[0]}.${seam.a[1]}`) {
          // 接缝的 a 侧负责统一计算一次
          const other = patchById.get(seam.b[0]);
          const otherLevel = edgeRequiredLevel(ctx, other, seam.b[1], 0, 1, 0, token);
          const unified = Math.min(ctx.maxDepth, Math.max(ownLevel, otherLevel));
          edgeLevel.set(`${seam.a[0]}.${seam.a[1]}`, unified);
          edgeLevel.set(`${seam.b[0]}.${seam.b[1]}`, unified);
        }
      }
      await bump();
    }

    // ---- 2. 顶点解析器 ----
    const cornerUV = [[0, 0], [1, 0], [1, 1], [0, 1]];
    // 角点 -> 相邻边名（按 which: (u0v0),(u1v0),(u1v1),(u0v1)）
    const cornerEdges = [['v0', 'u0'], ['v0', 'u1'], ['v1', 'u1'], ['v1', 'u0']];

    // 接缝注册表：边 -> { seam, si, side: 'a'|'b' }，规范参数以 a 侧自然参数为准
    const edgeSeamInfo = new Map();
    model.seams.forEach((s, si) => {
      edgeSeamInfo.set(`${s.a[0]}.${s.a[1]}`, { seam: s, si, side: 'a' });
      edgeSeamInfo.set(`${s.b[0]}.${s.b[1]}`, { seam: s, si, side: 'b' });
    });

    /* 把某边自然参数 k（0..total）换算为所属接缝 a 侧的规范 kCanonical */
    function seamCanonicalK(info, total, k) {
      if (info.side === 'a') return k;
      return info.seam.reversed ? total - k : k;
    }

    /* 接缝顶点：键不含层级，用约分后的整数 dyadic 参数 (num/den)，任何深度都命中同一物理点 */
    function getSeamVertex(patch, edgeName, level, k) {
      const info = edgeSeamInfo.get(`${patch.id}.${edgeName}`);
      const total = 1 << level;
      const kc = seamCanonicalK(info, total, k);
      // 约分 kc/total
      let num = kc;
      let den = total;
      while (num > 0 && (num % 2) === 0 && den > 1) { num /= 2; den /= 2; }
      const key = `seam${info.si}:${num}/${den}`;
      if (keyToIndex.has(key)) return keyToIndex.get(key);
      const ep = edgePointAt(patch, edgeName, level, k);
      return addPosition(key, ep.p);
    }

    /* 角点规范键：优先取接缝端点键（跨片共享），否则边界端点键，最后片内角点键 */
    function getCorner(patch, which) {
      const [e1, e2] = cornerEdges[which];
      for (const edgeName of [e1, e2]) {
        const info = edgeSeamInfo.get(`${patch.id}.${edgeName}`);
        if (info) {
          const lv = edgeLevel.get(`${patch.id}.${edgeName}`);
          const total = 1 << lv;
          const myK = edgeStartCornerWhich(edgeName) === which ? 0 : total;
          return getSeamVertex(patch, edgeName, lv, myK);
        }
      }
      // 非接缝角点：边界端点键（同一角点的两条边指向同一索引）
      for (const edgeName of [e1, e2]) {
        const lv = edgeLevel.get(`${patch.id}.${edgeName}`);
        const myK = edgeStartCornerWhich(edgeName) === which ? 0 : (1 << lv);
        const bKey = `bnd:${patch.id}.${edgeName}:${lv}:${myK}`;
        if (keyToIndex.has(bKey)) return keyToIndex.get(bKey);
      }
      const key = `${patch.id}#c${which}`;
      if (keyToIndex.has(key)) return keyToIndex.get(key);
      const [u, v] = cornerUV[which];
      const idx = addPosition(key, B.evalSurface(patch.points, u, v));
      for (const edgeName of [e1, e2]) {
        const lv = edgeLevel.get(`${patch.id}.${edgeName}`);
        const myK = edgeStartCornerWhich(edgeName) === which ? 0 : (1 << lv);
        keyToIndex.set(`bnd:${patch.id}.${edgeName}:${lv}:${myK}`, idx);
      }
      return idx;
    }

    function edgeStartCornerWhich(edgeName) {
      // 边自然参数 t=0 处的角点编号
      switch (edgeName) {
        case 'u0': return 0;
        case 'u1': return 1;
        case 'v0': return 0;
        case 'v1': return 3;
        default: throw new Error('bad edge');
      }
    }

    /* 边上层级 level 的第 k 个点；角点走 getCorner，接缝内部点走共享键 */
    function getEdgeVertex(patch, edgeName, level, k) {
      const total = 1 << level;
      if (k === 0 || k === total) {
        const which = k === 0 ? edgeStartCornerWhich(edgeName) : edgeEndCornerWhich(edgeName);
        return getCorner(patch, which);
      }
      if (edgeSeamInfo.has(`${patch.id}.${edgeName}`)) {
        return getSeamVertex(patch, edgeName, level, k);
      }
      const bKey = `bnd:${patch.id}.${edgeName}:${level}:${k}`;
      if (keyToIndex.has(bKey)) return keyToIndex.get(bKey);
      const ep = edgePointAt(patch, edgeName, level, k);
      return addPosition(bKey, ep.p);
    }

    function getInteriorVertex(patch, level, gu, gv) {
      const n = 1 << level;
      if (gu === 0 || gv === 0 || gu === n || gv === n) {
        // 边界点绝不能走内部键（否则接缝产生重复点/T 接点）
        throw new Error(`内部顶点解析收到边界网格点 patch=${patch.id} level=${level} gu=${gu} gv=${gv} n=${n}`);
      }
      const key = `int:${patch.id}:${level}:${gu}:${gv}`;
      if (keyToIndex.has(key)) return keyToIndex.get(key);
      const u = gu / n;
      const v = gv / n;
      return addPosition(key, B.evalSurface(patch.points, u, v));
    }

    /* 任意参数网格 (level, gu, gv) 顶点：边界走边/角点解析，内部走内点解析 */
    function getGridVertex(patch, level, gu, gv) {
      const n = 1 << level;
      const onU0 = gu === 0;
      const onU1 = gu === n;
      const onV0 = gv === 0;
      const onV1 = gv === n;
      if (onV0 && onU0) return getCorner(patch, 0);
      if (onV0 && onU1) return getCorner(patch, 1);
      if (onV1 && onU1) return getCorner(patch, 2);
      if (onV1 && onU0) return getCorner(patch, 3);
      if (onV0) return getEdgeVertex(patch, 'v0', level, gu);
      if (onV1) return getEdgeVertex(patch, 'v1', level, gu);
      if (onU0) return getEdgeVertex(patch, 'u0', level, gv);
      if (onU1) return getEdgeVertex(patch, 'u1', level, gv);
      return getInteriorVertex(patch, level, gu, gv);
    }

    function edgeEndCornerWhich(edgeName) {
      // 边自然参数 t=1 处的角点编号
      switch (edgeName) {
        case 'u0': return 3;
        case 'u1': return 2;
        case 'v0': return 1;
        case 'v1': return 2;
        default: throw new Error('bad edge');
      }
    }

    // ---- 3. 片内四叉树（两遍）----
    // 3a. 第一遍：仅按误差与当前边层级决定叶节点，记录每片触边深度
    const patchPlans = new Map();
    for (const patch of model.patches) {
      if (token.cancelled) return { cancelled: true };
      const levels = {
        u0: edgeLevel.get(`${patch.id}.u0`),
        u1: edgeLevel.get(`${patch.id}.u1`),
        v0: edgeLevel.get(`${patch.id}.v0`),
        v1: edgeLevel.get(`${patch.id}.v1`),
      };
      const touch = { u0: 0, u1: 0, v0: 0, v1: 0 };
      const leaves = [];
      let maxNodeDepth = 0;
      let cappedLeaves = 0;

      const walk = async (u0, v0, size, depth) => {
        await bump();
        if (token.cancelled) return;
        maxNodeDepth = Math.max(maxNodeDepth, depth);
        const u1 = u0 + size;
        const v1 = v0 + size;

        // 边界约束：节点触及的边若要求更细，必须继续分裂
        let mustSplit = false;
        if (v0 === 0 && depth < levels.v0) mustSplit = true;
        if (u0 === 0 && depth < levels.u0) mustSplit = true;
        if (v1 === 1 && depth < levels.v1) mustSplit = true;
        if (u1 === 1 && depth < levels.u1) mustSplit = true;

        let capped = false;
        if (!mustSplit) {
          const err = nodeTest(ctx, patch, u0, v0, u1, v1);
          if (err > ctx.pixelError) {
            if (depth >= ctx.maxDepth) capped = true;
            else mustSplit = true;
          }
        } else if (depth >= ctx.maxDepth) {
          capped = true;
        }

        if (mustSplit && depth < ctx.maxDepth) {
          const h = size / 2;
          await walk(u0, v0, h, depth + 1);
          await walk(u0 + h, v0, h, depth + 1);
          await walk(u0, v0 + h, h, depth + 1);
          await walk(u0 + h, v0 + h, h, depth + 1);
          return;
        }

        // 叶节点：记录参数范围、深度、触边情况与触顶标记
        if (v0 === 0) touch.v0 = Math.max(touch.v0, depth);
        if (u0 === 0) touch.u0 = Math.max(touch.u0, depth);
        if (v1 === 1) touch.v1 = Math.max(touch.v1, depth);
        if (u1 === 1) touch.u1 = Math.max(touch.u1, depth);
        if (capped) cappedLeaves++;
        leaves.push({ u0, v0, u1, v1, depth, capped });
      };

      await walk(0, 0, 1, 0);
      patchPlans.set(patch.id, { levels, touch, leaves, maxNodeDepth, cappedLeaves });
    }

    // 3b. 接缝边层级统一为两片实际触边深度的最大值（消除 T 接点的关键）
    for (const s of model.seams) {
      const pa = patchPlans.get(s.a[0]);
      const pb = patchPlans.get(s.b[0]);
      const unified = Math.max(pa.touch[s.a[1]], pb.touch[s.b[1]],
        edgeLevel.get(`${s.a[0]}.${s.a[1]}`), edgeLevel.get(`${s.b[0]}.${s.b[1]}`));
      edgeLevel.set(`${s.a[0]}.${s.a[1]}`, unified);
      edgeLevel.set(`${s.b[0]}.${s.b[1]}`, unified);
      pa.levels[s.a[1]] = unified;
      pb.levels[s.b[1]] = unified;
    }

    // 3c. 第二遍：按最终层级生成顶点与三角形
    for (const patch of model.patches) {
      if (token.cancelled) return { cancelled: true };
      const plan = patchPlans.get(patch.id);
      const levels = plan.levels;
      const planar = global.PatchModel.isPlanar(patch.points);
      const stat = {
        id: patch.id,
        planar,
        edgeLevels: { ...levels },
        maxNodeDepth: plan.maxNodeDepth,
        leafCount: plan.leaves.length,
        triangleCount: 0,
        overLimitTriangles: 0,
        maxError: 0,
        cappedLeaves: plan.cappedLeaves,
      };

      function appendEdgeRing(edgeName, nodeDepth, gFrom, gTo, fixed, ring) {
        const isSeamEdge = edgeSeamInfo.has(`${patch.id}.${edgeName}`);
        // 接缝边：始终按最终统一层级采样，保证同一物理点全局唯一
        // 非接缝边：取叶深度与边层级的较深者（叶可能比一维边估计更细）
        const eLevel = isSeamEdge
          ? Math.max(levels[edgeName], nodeDepth)
          : Math.max(nodeDepth, levels[edgeName]);
        const eN = 1 << eLevel;
        const nodeN = 1 << nodeDepth;
        const scale = eN / nodeN;
        const from = gFrom * scale;
        const to = gTo * scale;
        const step = from < to ? 1 : -1;
        const k0 = from + (ring.length ? step : 0);
        for (let k = k0; step > 0 ? k <= to : k >= to; k += step) {
          let gu, gv;
          if (edgeName === 'v0' || edgeName === 'v1') {
            gu = k; gv = fixed * scale;
          } else {
            gu = fixed * scale; gv = k;
          }
          const idx = getGridVertex(patch, eLevel, gu, gv);
          ring.push({ idx, u: gu / eN, v: gv / eN });
        }
      }

      function emitTriangle(ringTri, capped) {
        const corners = ringTri.map((r) => ({
          u: r.u,
          v: r.v,
          p: positions[r.idx],
        }));
        const { error } = triangleScreenError(ctx, patch, corners);
        // 统一环绕方向：使 (p1-p0)×(p2-p0) 与该片 dP/du×dP/dv 法线同向
        const geoNormal = v3.cross(
          v3.sub(corners[1].p, corners[0].p),
          v3.sub(corners[2].p, corners[0].p)
        );
        const refNormal = B.evalNormal(patch.points, corners[0].u, corners[0].v);
        const ordered = v3.dot(geoNormal, refNormal) < 0
          ? [ringTri[0], ringTri[2], ringTri[1]]
          : ringTri;
        const tri = {
          patch: patch.id,
          position: ordered.map((r) => r.idx),
          uv: ordered.map((r) => [r.u, r.v]),
          normal: ordered.map((r) => B.evalNormal(patch.points, r.u, r.v)),
          error,
          overLimit: capped || error > ctx.pixelError,
        };
        triangles.push(tri);
        stat.triangleCount++;
        stat.maxError = Math.max(stat.maxError, error);
        if (tri.overLimit) stat.overLimitTriangles++;
      }

      for (const leaf of plan.leaves) {
        const { depth } = leaf;
        const gridN = 1 << depth;
        const gU0 = Math.round(leaf.u0 * gridN);
        const gV0 = Math.round(leaf.v0 * gridN);
        const gU1 = Math.round(leaf.u1 * gridN);
        const gV1 = Math.round(leaf.v1 * gridN);

        // 叶节点 CCW 多边形：底(v0) -> 右(u1) -> 顶(v1 反向) -> 左(u0 反向)
        const ring = [];
        appendEdgeRing('v0', depth, gU0, gU1, gV0, ring);
        appendEdgeRing('u1', depth, gV0, gV1, gU1, ring);
        appendEdgeRing('v1', depth, gU1, gU0, gV1, ring);
        appendEdgeRing('u0', depth, gV1, gV0, gU0, ring);

        // 闭合点去重
        if (ring.length > 1 && ring[ring.length - 1].idx === ring[0].idx) ring.pop();

        // 四边形沿 (0,2) 对角线分 2 个；边上补点的凸多边形用扇形
        const tris = ring.length === 4
          ? [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]]
          : (() => {
              const out = [];
              for (let ti = 1; ti < ring.length - 1; ti++) {
                out.push([ring[0], ring[ti], ring[ti + 1]]);
              }
              return out;
            })();
        for (const tri of tris) emitTriangle(tri, leaf.capped);
        await bump();
      }
      patchStats.push(stat);
      if (onProgress) onProgress(patchStats.length / model.patches.length);
    }

    if (token.cancelled) return { cancelled: true };

    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    const overLimitTriangles = triangles.filter((t) => t.overLimit).length;
    const result = {
      cancelled: false,
      positions,
      triangles,
      patchStats,
      edgeLevel: Array.from(edgeLevel.entries()),
      stats: {
        patchCount: model.patches.length,
        seamCount: model.seams.length,
        vertexCount: positions.length,
        triangleCount: triangles.length,
        overLimitTriangles,
        maxError: triangles.reduce((m, t) => Math.max(m, t.error), 0),
        pixelError: ctx.pixelError,
        maxDepth: ctx.maxDepth,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
      },
    };
    return result;
  }

  const api = { tessellate, makeToken, triangleScreenError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Tessellator = api;
})(typeof window !== 'undefined' ? window : globalThis);
