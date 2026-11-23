/*
 * 面沿四面体单元边界的精确裁分。
 *
 * - 每个输入三角形建立 (u,v) 参数系，重心权重 w=(1-u-v, u, v)；
 * - 单元面平面在 (u,v) 下是整系数线性式 αu+βv+γ（BigInt），
 *   裁分交点用 BigInt 有理数表示，符号判定精确，无浮点漂移；
 * - 碎片归属：重心落在单元内部优先；公共面上的碎片归编号最小的单元；
 * - 原面必须被完整覆盖，否则整面标记越界并拒绝；
 * - 碎片顶点在全局去重，共享顶点共享同一变形位置（无裂缝）。
 */
(function (global) {
  'use strict';
  const E = global.TCExact;
  const { bi, i3, orient3d, signBi } = E;

  /* ---------------- 输入校验 ---------------- */
  function validateFace(face, fi, nVerts) {
    if (!face || !Array.isArray(face.p) || face.p.length !== 3) {
      return { error: `原面 ${fi}：p 必须是 3 个点` };
    }
    if (!Array.isArray(face.n) || face.n.length !== 3) {
      return { error: `原面 ${fi}：n 必须是 3 个逐角法线` };
    }
    const p = face.p, n = face.n;
    for (let c = 0; c < 3; c++) {
      const q = p[c];
      if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)) {
        return { error: `原面 ${fi}：点坐标必须是 3 个有限数` };
      }
      const v = n[c];
      if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
        return { error: `原面 ${fi}：法线必须是 3 个有限数` };
      }
      if (v[0] === 0 && v[1] === 0 && v[2] === 0) {
        return { error: `原面 ${fi}：角 ${c} 法线为零向量` };
      }
    }
    if (p.some(q => q.some((x, k) => !Number.isInteger(x) || Math.abs(x) > 1000000))) {
      return { error: `原面 ${fi}：点必须是绝对值不超过 1e6 的整数` };
    }
    if (p.some((q, i) => p.some((r, j) => i < j && q[0] === r[0] && q[1] === r[1] && q[2] === r[2]))) {
      return { error: `原面 ${fi}：存在重复顶点` };
    }
    // 非共线：整数叉积
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx === 0 && cy === 0 && cz === 0) {
      return { error: `原面 ${fi}：三个顶点共线，面积为零` };
    }
    return { ok: true };
  }

  /* ---------------- 平面收集（单元朝外有向面） ---------------- */
  const FACE_IDX = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const FACE_OPP = [3, 2, 1, 0];

  function buildPlanes(points, cells, cellVolSign) {
    // key: 排序后的顶点三元组 -> 首个（最小编号）单元信息
    const map = new Map();
    cells.forEach((cell, ci) => {
      const flip = cellVolSign[ci] < 0;
      for (let f = 0; f < 4; f++) {
        const triIds = FACE_IDX[f].map(k => cell[k]);
        const oppId = cell[FACE_OPP[f]];
        const a = points[triIds[0]], b = points[triIds[1]], c = points[triIds[2]];
        let tri = [a, b, c];
        // 目标：朝外有向面（对面顶点 orient < 0）。正体积静态表给 +1 需翻转；负体积反之。
        if (flip) tri = [a, c, b];
        const vertIds = [...triIds].sort((x, y) => x - y);
        const key = vertIds.join('/');
        if (!map.has(key)) {
          const mn = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
          const mx = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
          map.set(key, {
            key,
            vertIds,
            a: tri[0], b: tri[1], c: tri[2],
            bb: { mn, mx },
            ownerCell: ci,
            cells: [ci],
          });
        } else {
          map.get(key).cells.push(ci);
        }
      }
    });
    return [...map.values()];
  }

  /* ---------------- 三角形参数系 ---------------- */
  function makeFrame(face) {
    const p = face.p;
    const o = p[0];
    const e1 = [p[1][0] - o[0], p[1][1] - o[1], p[1][2] - o[2]];
    const e2 = [p[2][0] - o[0], p[2][1] - o[1], p[2][2] - o[2]];
    return {
      o, e1, e2,
      // x = o + u e1 + v e2；对整平面 Ax+By+Cz+D=0，
      // α = A e1x+B e1y+C e1z, β = A e2x+B e2y+C e2z, γ = A ox+B oy+C oz+D
    };
  }

  function planeInUV(plane, frame) {
    const { a, b, c } = plane;
    const A = bi((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]));
    const B = bi((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]));
    const C = bi((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const D = -(A * bi(a[0]) + B * bi(a[1]) + C * bi(a[2]));
    const alpha = A * bi(frame.e1[0]) + B * bi(frame.e1[1]) + C * bi(frame.e1[2]);
    const beta = A * bi(frame.e2[0]) + B * bi(frame.e2[1]) + C * bi(frame.e2[2]);
    const gamma = A * bi(frame.o[0]) + B * bi(frame.o[1]) + C * bi(frame.o[2]) + D;
    return { alpha, beta, gamma };
  }

  /* ---------------- 整数齐次重心顶点（热循环零 gcd 约分） ----------------
   * 顶点 {d, b:[b0,b1,b2]}，重心权重 w_i = b_i/d，满足 b0+b1+b2=d；
   * 参数坐标 u=w1=b1/d, v=w2=b2/d。交点用未归一化整数对表示，
   * 同一交点被正/负两侧共享同一对象，天然保证共享边无缝。
   */
  function hVert(b0, b1, b2) { return normVert({ d: b0 + b1 + b2, b: [b0, b1, b2] }); }

  /** 归一化齐次重心顶点：约去公共因子，把 BigInt 位宽控制在常数范围。 */
  function normVert(v) {
    let g = E.gcd(E.gcd(E.gcd(v.b[0], v.b[1]), v.b[2]), v.d);
    if (g === 0n) g = 1n;
    if (g > 1n) return { d: v.d / g, b: [v.b[0] / g, v.b[1] / g, v.b[2] / g] };
    return v;
  }
  function vKey(v) {
    const q = normVert(v);
    return q.d + '/' + q.b[0] + '/' + q.b[1] + '/' + q.b[2];
  }

  /** 平面 L(u,v)=αu+βv+γ 在齐次重心顶点上的整数值（= d·L，符号即 L 的符号）。 */
  function evalPlaneI(v, puv) {
    // u=b1/d, v=b2/d, w0=b0/d → d·L = α·b1 + β·b2 + γ·d
    return puv.alpha * v.b[1] + puv.beta * v.b[2] + puv.gamma * v.d;
  }

  /** 边 va-vb 与平面的交点（sa、sb 异号或其一为零时调用）。 */
  function edgeIntersectI(va, vb, sa, sb) {
    // t = -sa/(sb-sa)，交点重心 = (vb·(-sa) + va·sb)/(sb-sa)，归一化控制位宽
    const wa = -sa, wb = sb;                 // 权重（均 >=0）
    const d = va.d * wb + vb.d * wa;
    const b = [0, 1, 2].map(k => va.b[k] * wb + vb.b[k] * wa);
    return normVert({ d, b });
  }

  /**
   * 沿平面把多边形分裂为两侧：pos 保留 >=0（含平面上的点），neg 保留 <0。
   */
  function splitPolygon(poly, puv) {
    const pos = [], neg = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      const sc = signBi(evalPlaneI(cur, puv));
      const sp = signBi(evalPlaneI(prev, puv));
      if (sc >= 0) {
        if (sp < 0) { const hit = edgeIntersectI(prev, cur, evalPlaneI(prev, puv), evalPlaneI(cur, puv)); pos.push(hit); neg.push(hit); }
        pos.push(cur);
      } else {
        if (sp >= 0) { const hit = edgeIntersectI(prev, cur, evalPlaneI(prev, puv), evalPlaneI(cur, puv)); pos.push(hit); neg.push(hit); }
        neg.push(cur);
      }
    }
    return { pos, neg };
  }

  /** 参数空间两倍面积（浮点，仅用于覆盖校验与碎片面积输出；归属判定仍走精确整数符号）。 */
  function polyArea2I(poly) {
    let acc = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ua = Number(a.b[1]) / Number(a.d), va = Number(a.b[2]) / Number(a.d);
      const ub = Number(b.b[1]) / Number(b.d), vb = Number(b.b[2]) / Number(b.d);
      acc += ua * vb - ub * va;
    }
    return acc;
  }

  /* ---------------- 空间网格：候选单元查询 ---------------- */
  function buildGrid(points, cells) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const n = Math.max(2, Math.round(Math.cbrt(cells.length)));
    const span = [hi[0] - lo[0] || 1, hi[1] - lo[1] || 1, hi[2] - lo[2] || 1];
    const map = new Map();
    cells.forEach((cell, ci) => {
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const id of cell) for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], points[id][k]); mx[k] = Math.max(mx[k], points[id][k]);
      }
      const g0 = [0, 1, 2].map(k => Math.min(n - 1, Math.max(0, Math.floor((mn[k] - lo[k]) / span[k] * n))));
      const g1 = [0, 1, 2].map(k => Math.min(n - 1, Math.max(0, Math.floor((mx[k] - lo[k]) / span[k] * n))));
      for (let x = g0[0]; x <= g1[0]; x++)
        for (let y = g0[1]; y <= g1[1]; y++)
          for (let z = g0[2]; z <= g1[2]; z++) {
            const key = x + ',' + y + ',' + z;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(ci);
          }
    });
    const cellOf = (p) => [0, 1, 2].map(k => Math.min(n - 1, Math.max(0, Math.floor((p[k] - lo[k]) / span[k] * n))));
    return {
      map, cellOf,
      query(p) {
        const key = cellOf(p).join(',');
        return map.get(key) || [];
      },
    };
  }

  /* ---------------- 整数齐次重心点 → 空间齐次点 ---------------- */
  function ratPoint3(frame, v) {
    // x = Σ w_i · p_i，w_i = b_i/d；直接用重心权重，避免单独的 u,v 推导
    const d = v.d, b = v.b;
    const P = frame.o, E1 = frame.e1, E2 = frame.e2;
    // p0=o, p1=o+e1, p2=o+e2 → x = (b0·o + b1·(o+e1) + b2·(o+e2))/d = o + (b1·e1 + b2·e2)/d
    const xn = bi(P[0]) * d + b[1] * bi(E1[0]) + b[2] * bi(E2[0]);
    const yn = bi(P[1]) * d + b[1] * bi(E1[1]) + b[2] * bi(E2[1]);
    const zn = bi(P[2]) * d + b[1] * bi(E1[2]) + b[2] * bi(E2[2]);
    const hp = E.h3(xn, yn, zn, d);
    hp.fx = Number(xn) / Number(d); hp.fy = Number(yn) / Number(d); hp.fz = Number(zn) / Number(d);
    return hp;
  }

  /** 预计算每个单元的朝内侧浮点面（内部 orient>0，负体积单元已翻转）。 */
  function buildCellFaces(points, cells, cellVolSign) {
    return cells.map((cell, ci) => {
      const flip = cellVolSign[ci] < 0;
      return FACE_IDX.map(ids0 => {
        const ids = flip ? [ids0[0], ids0[2], ids0[1]] : ids0;
        const a = points[cell[ids[0]]], b = points[cell[ids[1]]], c = points[cell[ids[2]]];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const d0 = -(nx * a[0] + ny * a[1] + nz * a[2]);
        return { nx, ny, nz, d0, ids };
      });
    });
  }

  /**
   * 有理点对单元的归属判定。
   * @returns {{kind:'inside'|'boundary', cell:number} | null}
   *   inside=严格内部；boundary=落在面上（调用方按最小编号裁决）；null=无单元包含。
   * cellVolSign：各单元体积符号（静态面表只在正体积时朝内，负体积需反向）。
   */
  function classifyPoint(rp, points, cells, grid, cellVolSign, cellFaces) {
    const x = rp.fx, y = rp.fy, z = rp.fz;
    const cands = grid.query([x, y, z]);
    let boundaryBest = -1;
    for (const ci of cands) {
      const faces = cellFaces[ci];
      let inside = true, onFace = false;
      for (let f = 0; f < 4; f++) {
        const fp = faces[f];
        const val = fp.nx * x + fp.ny * y + fp.nz * z + fp.d0;
        if (val > 0) continue;
        if (val < 0) { inside = false; break; }
        // 浮点为零：BigInt 精确裁决是否真共面
        const ids = fp.ids, cell = cells[ci];
        const a = points[cell[ids[0]]], b = points[cell[ids[1]]], c = points[cell[ids[2]]];
        const s = signBi(orient3d(
          i3(bi(a[0]), bi(a[1]), bi(a[2])), i3(bi(b[0]), bi(b[1]), bi(b[2])),
          i3(bi(c[0]), bi(c[1]), bi(c[2])), rp));
        if (s < 0) { inside = false; break; }
        if (s === 0) onFace = true;
      }
      if (inside) {
        if (!onFace) return { kind: 'inside', cell: ci };
        if (boundaryBest < 0 || ci < boundaryBest) boundaryBest = ci;
      }
    }
    return boundaryBest < 0 ? null : { kind: 'boundary', cell: boundaryBest };
  }

  /* ---------------- 主流程 ---------------- */
  function fragmentModel(data, transforms, onProgress) {
    const points = data.rest;
    const cells = data.cells;
    const faces = data.faces;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const cellVolSign = cells.map(cell => signBi(orient3d(
      i3(bi(points[cell[0]][0]), bi(points[cell[0]][1]), bi(points[cell[0]][2])),
      i3(bi(points[cell[1]][0]), bi(points[cell[1]][1]), bi(points[cell[1]][2])),
      i3(bi(points[cell[2]][0]), bi(points[cell[2]][1]), bi(points[cell[2]][2])),
      i3(bi(points[cell[3]][0]), bi(points[cell[3]][1]), bi(points[cell[3]][2])))));
    const allPlanes = buildPlanes(points, cells, cellVolSign);
    // 只有两个及以上单元共享的面才是内部裁分边界；外壳面不参与裁分（越界由归属判定发现）
    const planes = allPlanes.filter(pl => pl.cells.length >= 2);
    const grid = buildGrid(points, cells);
    const cellFaces = buildCellFaces(points, cells, cellVolSign);

    const globalVerts = new Map();   // vKey -> 全局顶点
    const allFragments = [];
    const badFaces = [];
    const faceErrors = [];
    const stats = { inputFaces: faces.length, fragments: 0, rejectedFaces: 0 };

    faces.forEach((face, fi) => {
      if (onProgress && (fi & 63) === 0) onProgress(fi / faces.length);
      const check = validateFace(face, fi, points.length);
      if (check.error) { faceErrors.push({ face: fi, error: check.error }); badFaces.push(fi); stats.rejectedFaces++; return; }

      const frame = makeFrame(face);
      // 初始三角形三个角点：单位齐次重心 (d=1)
      const c0 = hVert(1n, 0n, 0n), c1 = hVert(0n, 1n, 0n), c2 = hVert(0n, 0n, 1n);
      const cornerV = [c0, c1, c2];
      // 候选平面：有限面 AABB 与三角形 AABB 相交，且平面确实切开三角形（角点符号不一致）
      const triBB = faceBB(face);
      const puvList = [];
      for (const plane of planes) {
        if (!bbOverlap(plane.bb, triBB)) continue;
        const puv = planeInUV(plane, frame);
        if (puv.alpha === 0n && puv.beta === 0n) continue; // 共面/平行且不切
        const sg = cornerV.map(q => signBi(evalPlaneI(q, puv)));
        // 任一角点在负侧、另一些在非负侧 → 平面真正切开三角形
        if (sg.some(s => s < 0) && sg.some(s => s >= 0)) puvList.push(puv);
      }

      // 初始三角形（参数空间逆时针）
      let polys = [[c0, c1, c2]];
      const totalArea0 = polyArea2I(polys[0]);
      for (const puv of puvList) {
        const next = [];
        for (const poly of polys) {
          // 整块都在非负侧（含共面）→ 不分裂，原样保留
          if (poly.every(q => signBi(evalPlaneI(q, puv)) >= 0)) { next.push(poly); continue; }
          const { pos, neg } = splitPolygon(poly, puv);
          if (pos.length >= 3 && polyArea2I(pos) !== 0) next.push(pos);
          if (neg.length >= 3 && polyArea2I(neg) !== 0) next.push(neg);
        }
        polys = next;
      }

      // 覆盖校验：碎片参数面积之和必须等于原面
      let sumArea = 0;
      for (const poly of polys) sumArea += polyArea2I(poly);
      const coverRatio = Math.abs(sumArea / totalArea0 - 1);
      if (coverRatio > 1e-9) {
        faceErrors.push({ face: fi, error: `裁分未完整覆盖原面（面积比偏差 ${coverRatio.toExponential(2)}）` });
        badFaces.push(fi); stats.rejectedFaces++; return;
      }

      // 归属与输出
      const fragsOfFace = [];
      let faceOK = true;
      for (const poly of polys) {
        const owner = findOwner(poly, frame, points, cells, grid, cellVolSign, cellFaces);
        if (owner < 0) { faceOK = false; break; }
        fragsOfFace.push(buildFragment(poly, face, fi, owner, globalVerts, frame, points));
      }
      if (!faceOK) {
        faceErrors.push({ face: fi, error: '碎片越出原笼，没有任何单元包含该区域' });
        badFaces.push(fi); stats.rejectedFaces++; return;
      }
      for (const fr of fragsOfFace) allFragments.push(fr);
    });

    // 全局顶点变形位置（共享顶点取最小编号单元的变换，保证共享边位置一致）
    const vertList = [...globalVerts.values()];
    const deformed = new Array(vertList.length);
    for (const gv of vertList) {
      const tr = transforms[gv.ownerCell];
      deformed[gv.id] = cageApply(tr, gv.rest);
    }

    stats.fragments = allFragments.length;
    stats.uniqueVerts = vertList.length;
    stats.elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (onProgress) onProgress(1);
    return { fragments: allFragments, badFaces, faceErrors, globalVerts: vertList, deformed, stats };
  }

  /** 多边形重心的齐次重心坐标：各顶点 w_i 按 1/d 加权后取平均。 */
  function centroidVert(poly) {
    // 累加 b_k/d，再除以顶点数；用通分整数表示
    let den = 1n;
    for (const q of poly) {
      if (q.d === 0n) continue; // 防御：跳过退化点
      den *= q.d;
    }
    if (den === 0n) den = 1n;
    const acc = [0n, 0n, 0n];
    for (const q of poly) {
      if (q.d === 0n) continue;
      const f = den / q.d;
      for (let k = 0; k < 3; k++) acc[k] += q.b[k] * f;
    }
    const n = bi(poly.length);
    return { d: den * n, b: acc.map(x => x) }; // 权重 = acc/den，再 /n
  }

  /** 边上 37% 处样本点的齐次重心坐标。 */
  function edgeSampleVert(a, b) {
    // w = 0.63·wa + 0.37·wb → (63·wa·db + 37·wb·da)/(100·da·db)
    const da = a.d, db = b.d, base = 100n * da * db;
    const bb = [0, 1, 2].map(k => 63n * a.b[k] * db + 37n * b.b[k] * da);
    return { d: base, b: bb };
  }

  function findOwner(poly, frame, points, cells, grid, cellVolSign, cellFaces) {
    let r = classifyPoint(ratPoint3(frame, centroidVert(poly)), points, cells, grid, cellVolSign, cellFaces);
    if (r) return r.cell;
    // 重心落空（极端贴边）：在碎片各边内部取样本投票
    for (let i = 0; i < poly.length; i++) {
      const s = edgeSampleVert(poly[i], poly[(i + 1) % poly.length]);
      r = classifyPoint(ratPoint3(frame, s), points, cells, grid, cellVolSign, cellFaces);
      if (r) return r.cell;
    }
    return -1;
  }

  function buildFragment(poly, face, fi, ownerCell, globalVerts, frame, points) {
    const ids = [];
    for (const v of poly) {
      // 同一重心坐标在不同原面上是空间中不同的点，key 必须带原面编号
      const key = fi + '#' + vKey(v);
      let gv = globalVerts.get(key);
      if (!gv) {
        const rp = ratPoint3(frame, v);
        const rest = [Number(rp.x) / Number(rp.w), Number(rp.y) / Number(rp.w), Number(rp.z) / Number(rp.w)];
        const bary = v.b.map(x => Number(x) / Number(v.d));
        gv = { id: globalVerts.size, key, rest, ownerCell, bary };
        globalVerts.set(key, gv);
      } else if (ownerCell < gv.ownerCell) {
        gv.ownerCell = ownerCell;
      }
      ids.push(gv.id);
    }
    // 每角法线：按原三角形重心权重插值
    const cornerNormals = poly.map(v => {
      const w = v.b.map(x => Number(x) / Number(v.d));
      const nn = [0, 0, 0];
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) nn[k] += w[c] * face.n[c][k];
      return nn;
    });
    // 真实 3D 面积：参数面积（鞋带和/2）× |e1×e2|
    const cross = [
      frame.e1[1] * frame.e2[2] - frame.e1[2] * frame.e2[1],
      frame.e1[2] * frame.e2[0] - frame.e1[0] * frame.e2[2],
      frame.e1[0] * frame.e2[1] - frame.e1[1] * frame.e2[0],
    ];
    const areaScale = Math.hypot(cross[0], cross[1], cross[2]);
    const area3 = Math.abs(polyArea2I(poly) * 0.5) * areaScale;
    return { faceId: fi, cellId: ownerCell, vertIds: ids, cornerNormals, polyArea: area3 };
  }

  function cageApply(tr, x) {
    if (!tr) return [NaN, NaN, NaN];
    return [
      tr.F[0][0] * x[0] + tr.F[0][1] * x[1] + tr.F[0][2] * x[2] + tr.t[0],
      tr.F[1][0] * x[0] + tr.F[1][1] * x[1] + tr.F[1][2] * x[2] + tr.t[1],
      tr.F[2][0] * x[0] + tr.F[2][1] * x[1] + tr.F[2][2] * x[2] + tr.t[2],
    ];
  }

  function faceBB(face) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of face.p) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    return { mn, mx };
  }
  function bbOverlap(a, b) {
    return a.mn[0] <= b.mx[0] && b.mn[0] <= a.mx[0] &&
           a.mn[1] <= b.mx[1] && b.mn[1] <= a.mx[1] &&
           a.mn[2] <= b.mx[2] && b.mn[2] <= a.mx[2];
  }
  function planeAABBOverlap(plane, bb) {
    // 平面过 AABB 的最近/最远角点判定
    const { a, b, c } = plane;
    const A = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const B = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const C = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const D = -(A * a[0] + B * a[1] + C * a[2]);
    const An = [A, B, C];
    const near = [0, 1, 2].map(k => (An[k] >= 0 ? bb.mn[k] : bb.mx[k]));
    const far = [0, 1, 2].map(k => (An[k] >= 0 ? bb.mx[k] : bb.mn[k]));
    let sNear = D, sFar = D;
    for (let k = 0; k < 3; k++) { sNear += An[k] * near[k]; sFar += An[k] * far[k]; }
    return (sNear <= 0 && sFar >= 0) || (sFar <= 0 && sNear >= 0);
  }

  const api = {
    fragmentModel, validateFace, buildPlanes, classifyPoint, ratPoint3,
    planeInUV, splitPolygon, polyArea2I, buildGrid, cageApply, hVert, vKey,
    FACE_IDX, FACE_OPP,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; global.TCFrag = api; }
  else global.TCFrag = api;
})(typeof window !== 'undefined' ? window : globalThis);
