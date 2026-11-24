// 精确整数几何谓词。输入坐标全部为不超过 1e6 的整数，统一转 BigInt。
// 任何判定都不使用浮点、不使用容差：相近但不相接的面绝不会被合并。

export function toIntPoints(vertices) {
  return vertices.map(([x, y, z]) => [BigInt(x), BigInt(y), BigInt(z)]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// cross(b-a, c-a) 点 (d-a)：正/负/零
export function orient3(a, b, c, d) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const s = cx * wx + cy * wy + cz * wz;
  return s > 0n ? 1 : s < 0n ? -1 : 0;
}

// 面法线（未归一化，整数精确）
export function faceNormal(p, face) {
  const [a, b, c] = face.map((i) => p[i]);
  const u = sub(b, a), v = sub(c, a);
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

// 六倍带符号体积项 dot(a, cross(b, c))，a/b/c 为点
export function det6(a, b, c) {
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  );
}

// ---- 有理数 [num, den]，den > 0 ----
function rat(n, d) {
  if (d < 0n) { n = -n; d = -d; }
  return [n, d];
}
export function ratCmp(r1, r2) {
  const [n1, d1] = r1, [n2, d2] = r2;
  const l = n1 * d2, r = n2 * d1;
  return l > r ? 1 : l < r ? -1 : 0;
}
const ratEq = (r1, r2) => ratCmp(r1, r2) === 0;
const ratMin = (r1, r2) => (ratCmp(r1, r2) <= 0 ? r1 : r2);
const ratMax = (r1, r2) => (ratCmp(r1, r2) >= 0 ? r1 : r2);

// ---- 共面投影：丢弃法线绝对值最大的轴 ----
export function projectAxis(n) {
  const ax = n[0] < 0n ? -n[0] : n[0];
  const ay = n[1] < 0n ? -n[1] : n[1];
  const az = n[2] < 0n ? -n[2] : n[2];
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}
const proj2 = (pt, axis) => {
  const i = (axis + 1) % 3, j = (axis + 2) % 3;
  return [pt[i], pt[j]];
};

// 2D 定向：cross(b-a, c-a)
export function orient2(a, b, c) {
  const s =
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return s > 0n ? 1 : s < 0n ? -1 : 0;
}

// 点是否严格在三角形内部（三条有向边同号）
function pointStrictInTri2(q, t0, t1, t2) {
  const s1 = orient2(t0, t1, q);
  const s2 = orient2(t1, t2, q);
  const s3 = orient2(t2, t0, q);
  return (s1 > 0 && s2 > 0 && s3 > 0) || (s1 < 0 && s2 < 0 && s3 < 0);
}

// 2D 线段相交：'cross' 内部穿越 | 'point' 端点接触（给端点下标，-1 表示内部）|
// 'collinear' 共线重叠（给区间端点下标）| 'none'
// 注意：orient2=0 只表示点在直线上，必须再验证是否落在线段范围内。
export function segSeg2(p, q, r, s) {
  const o1 = orient2(p, q, r);
  const o2 = orient2(p, q, s);
  const o3 = orient2(r, s, p);
  const o4 = orient2(r, s, q);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return { kind: 'cross' };
  }
  // 点 pt 是否落在线段 [u,v] 的包围盒内（含边界）
  const onSegBox = (pt, u, v) =>
    pt[0] >= (u[0] < v[0] ? u[0] : v[0]) && pt[0] <= (u[0] > v[0] ? u[0] : v[0]) &&
    pt[1] >= (u[1] < v[1] ? u[1] : v[1]) && pt[1] <= (u[1] > v[1] ? u[1] : v[1]);
  if (o1 === 0 && o2 === 0) {
    // 两线段共线：比较一维区间
    const d = [q[0] - p[0], q[1] - p[1]];
    const onLine = (pt) => d[0] === 0n ? pt[1] - p[1] : pt[0] - p[0];
    const vr = onLine(r), vs = onLine(s);
    const lo = vr < vs ? vr : vs, hi = vr < vs ? vs : vr;
    if (hi < 0n || lo > 0n) return { kind: 'none' };
    return {
      kind: 'collinear',
      a: vr < vs ? 2 : 3,
      b: vr < vs ? 3 : 2,
    };
  }
  if (o1 === 0 && onSegBox(r, p, q)) return { kind: 'point', u: 2, v: -1 };
  if (o2 === 0 && onSegBox(s, p, q)) return { kind: 'point', u: 3, v: -1 };
  if (o3 === 0 && onSegBox(p, r, s)) return { kind: 'point', u: -1, v: 0 };
  if (o4 === 0 && onSegBox(q, r, s)) return { kind: 'point', u: -1, v: 1 };
  return { kind: 'none' };
}

// ---- 共面两面的精确交集判定 ----
// 返回 {type:'ok'|'overlap'|'touch', detail}
// sharedSimplex: 两面共享索引构成的允许单纯形
//   {kind:'edge', verts:[i,j]} | {kind:'vertex', verts:[i]} | null
export function testCoplanarPair(points, f1, f2, sharedSimplex, axis) {
  const A = f1.map((i) => proj2(points[i], axis));
  const B = f2.map((i) => proj2(points[i], axis));

  // 1) 任一顶点严格落在另一三角形内部 => 面积重叠
  for (let k = 0; k < 3; k++) {
    if (pointStrictInTri2(B[k], A[0], A[1], A[2])) {
      return { type: 'overlap', detail: `顶点 ${f2[k]} 落在面 ${f1.join(',')} 内部` };
    }
    if (pointStrictInTri2(A[k], B[0], B[1], B[2])) {
      return { type: 'overlap', detail: `顶点 ${f1[k]} 落在面 ${f2.join(',')} 内部` };
    }
  }

  // 2) 边对检测
  const eA = [[0, 1], [1, 2], [2, 0]];
  const eB = [[0, 1], [1, 2], [2, 0]];
  let pointContact = null;   // {va: 全局顶点索引或 null, vb}
  let segmentContact = null; // 共线重叠的边顶点
  for (const [ia, ja] of eA) {
    for (const [ib, jb] of eB) {
      const r = segSeg2(A[ia], A[ja], B[ib], B[jb]);
      if (r.kind === 'cross') {
        return { type: 'overlap', detail: '边在内部穿越（共面）' };
      }
      if (r.kind === 'collinear') {
        const loB = r.a === 2 ? B[ib] : B[jb];
        // 完整重合判定（区间端点逐点比较）
        const same1 = A[ia][0] === B[ib][0] && A[ia][1] === B[ib][1];
        const same2 = A[ja][0] === B[jb][0] && A[ja][1] === B[jb][1];
        const same3 = A[ia][0] === B[jb][0] && A[ia][1] === B[jb][1];
        const same4 = A[ja][0] === B[ib][0] && A[ja][1] === B[ib][1];
        const identical = (same1 && same2) || (same3 && same4);
        if (identical) {
          segmentContact = { edgeA: [f1[ia], f1[ja]], edgeB: [f2[ib], f2[jb]] };
        } else {
          return {
            type: 'overlap',
            detail: '共线边部分重叠（重叠段超出共享边）',
          };
        }
      } else if (r.kind === 'point') {
        const gVA = r.u === -1 ? null : f1[r.u === 0 ? ia : ja];
        const gVB = r.v === -1 ? null : f2[r.v === 0 ? ib : jb];
        pointContact = { va: gVA, vb: gVB };
      }
    }
  }

  // 3) 边界点落在另一三角形边上（segSeg 已覆盖）；再查边界点落在另一三角形内部不可能（strict 已查）
  if (segmentContact) {
    if (sharedSimplex && sharedSimplex.kind === 'edge') {
      const sa = new Set(sharedSimplex.verts);
      if (sa.has(segmentContact.edgeA[0]) && sa.has(segmentContact.edgeA[1])) {
        return { type: 'ok' }; // 几何交集恰为共享边
      }
    }
    return { type: 'overlap', detail: '共面边重叠但两面未拓扑共享该边' };
  }
  if (pointContact) {
    if (sharedSimplex && sharedSimplex.kind === 'vertex' &&
        pointContact.va !== null && pointContact.vb !== null &&
        pointContact.va === pointContact.vb &&
        sharedSimplex.verts[0] === pointContact.va) {
      return { type: 'ok' }; // 交集恰为共享顶点
    }
    const name = pointContact.va !== null ? `顶点 ${pointContact.va}`
      : pointContact.vb !== null ? `顶点 ${pointContact.vb}` : '边内点';
    return { type: 'touch', detail: `${name} 与另一面非拓扑接触` };
  }
  return { type: 'ok' };
}

// ---- 非共面两面的精确交集判定 ----
// 两平面交线 L: p = P0 + t*D。每个三角形与 L 的交是一个 t 区间（有理数端点）。
// 所有区间基于同一 D、同一参数轴，严格精确，无浮点、无容差。
export function testNonCoplanarPair(points, f1, f2, sharedSimplex) {
  const t1v = f1.map((i) => points[i]);
  const t2v = f2.map((i) => points[i]);
  const [a, b, c] = t1v;
  const [d, e, f] = t2v;
  const s2 = [d, e, f].map((pt) => orient3(a, b, c, pt)); // f2 顶点相对平面1（Number 符号）
  // 快速拒绝：全严格同侧
  if ((s2[0] > 0 && s2[1] > 0 && s2[2] > 0) ||
      (s2[0] < 0 && s2[1] < 0 && s2[2] < 0)) {
    return { type: 'ok' };
  }
  const s1 = [a, b, c].map((pt) => orient3(d, e, f, pt));
  if ((s1[0] > 0 && s1[1] > 0 && s1[2] > 0) ||
      (s1[0] < 0 && s1[1] < 0 && s1[2] < 0)) {
    return { type: 'ok' };
  }

  const n1 = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const n2 = [
    (e[1] - d[1]) * (f[2] - d[2]) - (e[2] - d[2]) * (f[1] - d[1]),
    (e[2] - d[2]) * (f[0] - d[0]) - (e[0] - d[0]) * (f[2] - d[2]),
    (e[0] - d[0]) * (f[1] - d[1]) - (e[1] - d[1]) * (f[0] - d[0]),
  ];
  const D = [
    n1[1] * n2[2] - n1[2] * n2[1],
    n1[2] * n2[0] - n1[0] * n2[2],
    n1[0] * n2[1] - n1[1] * n2[0],
  ];
  let axis = 0;
  while (axis < 3 && D[axis] === 0n) axis++;
  if (axis === 3) return { type: 'ok' };

  // 选一个严格跨面（两顶点非零且异号）的边，取其与另一平面的交点为交线基准点 P0（齐次）
  let P0 = null;
  for (const [verts, signs] of [[t1v, s1], [t2v, s2]]) {
    for (let k = 0; k < 3 && !P0; k++) {
      const k2 = (k + 1) % 3;
      if (signs[k] !== 0 && signs[k2] !== 0 && ((signs[k] > 0) !== (signs[k2] > 0))) {
        const ak = BigInt(Math.abs(signs[k]));
        const bk = BigInt(Math.abs(signs[k2]));
        const w = ak + bk;
        P0 = {
          w,
          x: [
            verts[k][0] * w + ak * (verts[k2][0] - verts[k][0]),
            verts[k][1] * w + ak * (verts[k2][1] - verts[k][1]),
            verts[k][2] * w + ak * (verts[k2][2] - verts[k][2]),
          ],
        };
      }
    }
  }

  // 真实点 pt 在交线上的 t（有理数）：pt = P0.x/P0.w + t*D
  const tOfVertex = (pt) =>
    rat(pt[axis] * P0.w - P0.x[axis], D[axis] * P0.w);

  // 三角形在交线上覆盖的 t 端点集合：
  //  - 落在另一平面上的顶点（sign=0）直接贡献一个 t
  //  - 严格跨面边的交点贡献一个 t（齐次换算）
  const intervalOf = (verts, signs) => {
    const vals = [];
    for (let k = 0; k < 3; k++) {
      if (signs[k] === 0) vals.push(tOfVertex(verts[k]));
      const k2 = (k + 1) % 3;
      if (signs[k] !== 0 && signs[k2] !== 0 && ((signs[k] > 0) !== (signs[k2] > 0))) {
        const ak = BigInt(Math.abs(signs[k]));
        const bk = BigInt(Math.abs(signs[k2]));
        const w2 = ak + bk;
        const x2 = verts[k][axis] * w2 + ak * (verts[k2][axis] - verts[k][axis]);
        vals.push(rat(x2 * P0.w - P0.x[axis] * w2, D[axis] * P0.w * w2));
      }
    }
    const out = [];
    for (const r of vals) if (!out.some((q) => ratEq(q, r))) out.push(r);
    return out;
  };

  let i1, i2;
  if (!P0) {
    // 无严格跨面边：交集只能由“在另一平面上的顶点”构成（点或共线段）。
    const zero1 = [], zero2 = [];
    for (let k = 0; k < 3; k++) {
      if (s1[k] === 0) zero1.push({ pt: t1v[k], idx: f1[k] });
      if (s2[k] === 0) zero2.push({ pt: t2v[k], idx: f2[k] });
    }
    if (zero1.length === 0 && zero2.length === 0) return { type: 'ok' };
    const basePt = (zero1[0] || zero2[0]).pt;
    const tLocal = (pt) => rat(pt[axis] - basePt[axis], D[axis]);
    // 只保留真正落在另一三角形上的接触点（零符号只保证在平面上，不保证在三角形内）
    const contacts = [];
    for (const z of zero1) {
      if (pointOnTriPlane(z.pt, t2v)) contacts.push({ t: tLocal(z.pt), idx: z.idx });
    }
    for (const z of zero2) {
      if (pointOnTriPlane(z.pt, t1v)) contacts.push({ t: tLocal(z.pt), idx: z.idx });
    }
    if (contacts.length === 0) return { type: 'ok' };
    const tVals = contacts.map((x) => x.t);
    const allSame = tVals.every((r) => ratEq(r, tVals[0]));
    if (allSame) {
      // 点接触
      if (sharedSimplex && sharedSimplex.kind === 'vertex') {
        const tq = tLocal(points[sharedSimplex.verts[0]]);
        if (ratEq(tq, tVals[0]) && contacts.every((x) => x.idx === sharedSimplex.verts[0])) {
          return { type: 'ok' };
        }
      }
      return { type: 'touch', detail: '顶点在另一三角形平面上且落在其内部' };
    }
    // 多点 => 沿交线的一段（共享边或穿越段）
    if (sharedSimplex && sharedSimplex.kind === 'edge') {
      const te = sharedSimplex.verts.map((vi) => tLocal(points[vi]));
      const eLo = te.reduce(ratMin), eHi = te.reduce(ratMax);
      const cLo = tVals.reduce(ratMin), cHi = tVals.reduce(ratMax);
      if (ratEq(eLo, cLo) && ratEq(eHi, cHi)) return { type: 'ok' };
    }
    return { type: 'cross', detail: '两面沿交线存在非拓扑线段相交' };
  }

  i1 = intervalOf(t1v, s1);
  i2 = intervalOf(t2v, s2);
  if (i1.length === 0 || i2.length === 0) return { type: 'ok' };
  const lo1 = i1.reduce(ratMin), hi1 = i1.reduce(ratMax);
  const lo2 = i2.reduce(ratMin), hi2 = i2.reduce(ratMax);
  const lo = ratMax(lo1, lo2), hi = ratMin(hi1, hi2);
  const cmp = ratCmp(lo, hi);
  if (cmp > 0) return { type: 'ok' };

  if (cmp === 0) {
    if (sharedSimplex && sharedSimplex.kind === 'vertex') {
      const tq = tOfVertex(points[sharedSimplex.verts[0]]);
      if (ratEq(tq, lo)) return { type: 'ok' };
    }
    return { type: 'touch', detail: '两面在非拓扑点上接触' };
  }
  if (sharedSimplex && sharedSimplex.kind === 'edge') {
    const tu = tOfVertex(points[sharedSimplex.verts[0]]);
    const tv = tOfVertex(points[sharedSimplex.verts[1]]);
    const eLo = ratMin(tu, tv), eHi = ratMax(tu, tv);
    if (ratEq(eLo, lo) && ratEq(eHi, hi)) return { type: 'ok' };
  }
  return { type: 'cross', detail: '两面在内部穿越相交' };
}

// 点与三角形共面前提下，是否落在三角形上（含边界），精确 BigInt
function pointOnTriPlane(pt, tri) {
  const [a, b, c] = tri;
  if (orient3(a, b, c, pt) !== 0) return false;
  const n = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const axis = projectAxis(n);
  const i = (axis + 1) % 3, j = (axis + 2) % 3;
  const q = [pt[i], pt[j]];
  const o1 = orient2([a[i], a[j]], [b[i], b[j]], q);
  const o2 = orient2([b[i], b[j]], [c[i], c[j]], q);
  const o3 = orient2([c[i], c[j]], [a[i], a[j]], q);
  const pos = o1 > 0 || o2 > 0 || o3 > 0;
  const neg = o1 < 0 || o2 < 0 || o3 < 0;
  return !(pos && neg);
}
