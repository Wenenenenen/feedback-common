// 封闭网格壳层审计主引擎（纯 ESM，浏览器与 Node 通用，无 DOM 依赖）
import {
  toIntPoints, orient3, faceNormal, det6,
  projectAxis, testCoplanarPair, testNonCoplanarPair,
} from './exact-geometry.js';
const MAX_TRIANGLES = 20000;

function edgeKey(a, b, vertexCount) {
  return a < b ? a * vertexCount + b : b * vertexCount + a;
}
function edgeVerts(key, vertexCount) {
  return [Math.floor(key / vertexCount), key % vertexCount];
}

// ---------------- BVH（整数 AABB，仅用于宽相筛选） ----------------
function buildBVH(items) {
  const nodes = [];
  function makeBox(list) {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const it of list) {
      for (let k = 0; k < 3; k++) {
        if (it.min[k] < mn[k]) mn[k] = it.min[k];
        if (it.max[k] > mx[k]) mx[k] = it.max[k];
      }
    }
    return { min: mn, max: mx };
  }
  function build(list) {
    const node = { box: makeBox(list), left: -1, right: -1, faces: null };
    if (list.length <= 4) {
      node.faces = list.map((it) => it.face);
      nodes.push(node);
      return nodes.length - 1;
    }
    const b = node.box;
    const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const sorted = list.slice().sort((p, q) =>
      (p.min[axis] + p.max[axis]) - (q.min[axis] + q.max[axis]));
    const mid = sorted.length >> 1;
    node.left = build(sorted.slice(0, mid));
    node.right = build(sorted.slice(mid));
    nodes.push(node);
    return nodes.length - 1;
  }
  const root = build(items);
  return { nodes, root };
}

function boxesOverlap(a, b) {
  return !(a.max[0] < b.min[0] || b.max[0] < a.min[0] ||
           a.max[1] < b.min[1] || b.max[1] < a.min[1] ||
           a.max[2] < b.min[2] || b.max[2] < a.min[2]);
}

function orient2Local(a, b, c) {
  const s = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return s > 0n ? 1 : s < 0n ? -1 : 0;
}
// 齐次点 x/w 是否落在三角形的某条边上（精确）
function pointOnTriEdgeHomogeneous(x, w, a, b, c) {
  const n = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const axis = projectAxis(n);
  const i = (axis + 1) % 3, j = (axis + 2) % 3;
  const q2 = [x[i], x[j]];
  const edges = [[a, b], [b, c], [c, a]];
  for (const [p, r] of edges) {
    const p2 = [p[i] * w, p[j] * w];
    const r2 = [r[i] * w, r[j] * w];
    if (orient2Local(p2, r2, q2) === 0) {
      // 在边线上，再确认在边段内（坐标介于两端点之间）
      const minX = p2[0] < r2[0] ? p2[0] : r2[0];
      const maxX = p2[0] > r2[0] ? p2[0] : r2[0];
      const minY = p2[1] < r2[1] ? p2[1] : r2[1];
      const maxY = p2[1] > r2[1] ? p2[1] : r2[1];
      if (q2[0] >= minX && q2[0] <= maxX && q2[1] >= minY && q2[1] <= maxY) return true;
    }
  }
  return false;
}
function projectAxisLocal(n) {
  const ax = n[0] < 0n ? -n[0] : n[0];
  const ay = n[1] < 0n ? -n[1] : n[1];
  const az = n[2] < 0n ? -n[2] : n[2];
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}
// 齐次点 x/w 是否落在三角形上（含边界）
function pointOnTriHomogeneous(x, w, a, b, c) {
  const n = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const axis = projectAxisLocal(n);
  const i = (axis + 1) % 3, j = (axis + 2) % 3;
  const q2 = [x[i], x[j]];
  const t0 = [a[i] * w, a[j] * w];
  const t1 = [b[i] * w, b[j] * w];
  const t2 = [c[i] * w, c[j] * w];
  const o1 = orient2Local(t0, t1, q2);
  const o2 = orient2Local(t1, t2, q2);
  const o3 = orient2Local(t2, t0, q2);
  const pos = o1 > 0n || o2 > 0n || o3 > 0n;
  const neg = o1 < 0n || o2 < 0n || o3 < 0n;
  return !(pos && neg);
}

// ---------------- 主入口 ----------------
export function auditMesh(inputVertices, inputFaces) {
  const t0 = performance.now();
  const issues = [];
  const push = (type, severity, message, faces = [], vertices = []) =>
    issues.push({ type, severity, message, faces, vertices });

  // ---------- 1. 输入校验 ----------
  if (!Array.isArray(inputVertices) || !Array.isArray(inputFaces)) {
    throw new Error('输入必须包含 vertices 与 faces 两个数组');
  }
  const vertexCount = inputVertices.length;
  const faceCount = inputFaces.length;
  if (faceCount > MAX_TRIANGLES) {
    throw new Error(`三角形数量 ${faceCount} 超过上限 ${MAX_TRIANGLES}`);
  }
  const vertices = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const v = inputVertices[i];
    if (!Array.isArray(v) || v.length !== 3 ||
        !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || !Number.isInteger(v[2])) {
      throw new Error(`顶点 ${i} 不是三个整数`);
    }
    if (Math.abs(v[0]) > 1e6 || Math.abs(v[1]) > 1e6 || Math.abs(v[2]) > 1e6) {
      throw new Error(`顶点 ${i} 坐标绝对值超过 1000000`);
    }
    vertices[i] = [v[0], v[1], v[2]];
  }
  const faces = new Array(faceCount);
  for (let i = 0; i < faceCount; i++) {
    const f = inputFaces[i];
    if (!Array.isArray(f) || f.length !== 3) {
      throw new Error(`面 ${i} 不是三元组`);
    }
    for (const idx of f) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
        throw new Error(`面 ${i} 含非法顶点索引 ${idx}`);
      }
    }
    faces[i] = [f[0], f[1], f[2]];
  }

  const points = toIntPoints(vertices);
  const normals = new Array(faceCount);
  const degenerate = new Uint8Array(faceCount);
  const faceItems = [];

  for (let fi = 0; fi < faceCount; fi++) {
    const f = faces[fi];
    const n = faceNormal(points, f);
    normals[fi] = n;
    if (n[0] === 0n && n[1] === 0n && n[2] === 0n) {
      degenerate[fi] = 1;
      push('degenerate', 'error', `面 ${fi} 退化（重复索引或三点共线）`, [fi], [...new Set(f)]);
    } else {
      const mn = [Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity];
      for (const vi of f) {
        for (let k = 0; k < 3; k++) {
          const c = vertices[vi][k];
          if (c < mn[k]) mn[k] = c;
          if (c > mx[k]) mx[k] = c;
        }
      }
      faceItems.push({ face: fi, min: mn, max: mx });
    }
  }

  // ---------- 2. 边拓扑 ----------
  const edgeMap = new Map();   // key -> [{face, slot, dir}]
  const faceEdges = new Array(faceCount);
  const triKeySet = new Set();

  for (let fi = 0; fi < faceCount; fi++) {
    if (degenerate[fi]) { faceEdges[fi] = []; continue; }
    const [a, b, c] = faces[fi];
    const triKey = [a, b, c].slice().sort((x, y) => x - y).join(',');
    if (triKeySet.has(triKey)) {
      push('duplicate-face', 'error', `面 ${fi} 与另一三角形索引完全相同（重复面）`, [fi],
        [a, b, c].slice().sort((x, y) => x - y));
    } else {
      triKeySet.add(triKey);
    }
    const defs = [
      { verts: [a, b], dir: a < b ? 1 : -1 },
      { verts: [b, c], dir: b < c ? 1 : -1 },
      { verts: [c, a], dir: c < a ? 1 : -1 },
    ];
    faceEdges[fi] = defs.map((d) => ({
      key: edgeKey(d.verts[0], d.verts[1], vertexCount),
      dir: d.dir, verts: d.verts,
    }));
    for (let slot = 0; slot < 3; slot++) {
      const e = faceEdges[fi][slot];
      let arr = edgeMap.get(e.key);
      if (!arr) { arr = []; edgeMap.set(e.key, arr); }
      arr.push({ face: fi, slot, dir: e.dir });
    }
  }

  const boundaryEdges = [];
  const nonManifoldEdges = [];
  for (const [key, arr] of edgeMap) {
    if (arr.length === 1) {
      boundaryEdges.push(key);
      push('boundary-edge', 'error',
        `边 ${edgeVerts(key, vertexCount).join('-')} 只有面 ${arr[0].face} 引用（开口边）`,
        [arr[0].face], edgeVerts(key, vertexCount));
    } else if (arr.length > 2) {
      nonManifoldEdges.push(key);
      push('non-manifold-edge', 'error',
        `边 ${edgeVerts(key, vertexCount).join('-')} 被 ${arr.length} 个面引用（流形边必须恰有两面）`,
        arr.map((x) => x.face), edgeVerts(key, vertexCount));
    }
  }

  // ---------- 3. 顶点面扇：必须是一环 ----------
  const vertFaces = new Map();
  for (let fi = 0; fi < faceCount; fi++) {
    if (degenerate[fi]) continue;
    for (const vi of new Set(faces[fi])) {
      let arr = vertFaces.get(vi);
      if (!arr) { arr = []; vertFaces.set(vi, arr); }
      arr.push(fi);
    }
  }
  const badFanVertices = [];
  for (const [vi, flist] of vertFaces) {
    if (flist.length < 3) {
      badFanVertices.push(vi);
      push('bad-fan', 'error',
        `顶点 ${vi} 的面扇只有 ${flist.length} 个面，无法构成闭合环`, flist, [vi]);
      continue;
    }
    const link = new Map();
    for (const fi of flist) {
      const nbs = [];
      for (const e of faceEdges[fi]) {
        if (!e.verts.includes(vi)) continue;
        const arr = edgeMap.get(e.key);
        if (arr.length !== 2) continue;
        const other = arr[0].face === fi ? arr[1].face : arr[0].face;
        if (flist.includes(other)) nbs.push(other);
      }
      link.set(fi, nbs);
    }
    let singleRing = true;
    for (const fi of flist) {
      if (link.get(fi).length !== 2) { singleRing = false; break; }
    }
    if (singleRing) {
      const start = flist[0];
      let prev = -1, cur = start, count = 0;
      const seen = new Set();
      while (count <= flist.length) {
        if (seen.has(cur)) break;
        seen.add(cur);
        const nbs = link.get(cur);
        const next = nbs[0] === prev ? nbs[1] : nbs[0];
        prev = cur; cur = next; count++;
      }
      if (seen.size !== flist.length || cur !== start) singleRing = false;
    }
    if (!singleRing) {
      badFanVertices.push(vi);
      push('bad-fan', 'error',
        `顶点 ${vi} 的面扇不是单环（${flist.length} 个面在该点拼接异常，可能是多壳夹点或锥点）`,
        flist, [vi]);
    }
  }

  // ---------- 4. 连通分量 + 可定向性（沿共享边 BFS 传播绕序） ----------
  const componentOf = new Int32Array(faceCount).fill(-1);
  const components = [];
  for (let fi = 0; fi < faceCount; fi++) {
    if (degenerate[fi] || componentOf[fi] !== -1) continue;
    const cid = components.length;
    const queue = [fi];
    componentOf[fi] = cid;
    const members = [];
    while (queue.length) {
      const cur = queue.pop();
      members.push(cur);
      for (const e of faceEdges[cur]) {
        const arr = edgeMap.get(e.key);
        if (arr.length !== 2) continue;
        const other = arr[0].face === cur ? arr[1].face : arr[0].face;
        if (!degenerate[other] && componentOf[other] === -1) {
          componentOf[other] = cid;
          queue.push(other);
        }
      }
    }
    components.push({ id: cid, faces: members });
  }

  // BFS 只做两件事：(1) 验证可定向性（沿每条双面边，两面绕序必须协调）；
  // (2) 记录“相对参考面是否需要翻转”。最终翻面对象在体积阶段按深度奇偶统一决定，
  // 不依赖遍历起始面。
  const flip = new Uint8Array(faceCount);
  const nonOrientable = [];
  for (const comp of components) {
    const start = comp.faces[0];
    const queue = [start];
    const seen = new Set([start]);
    let orientable = true;
    while (queue.length) {
      const cur = queue.pop();
      for (const e of faceEdges[cur]) {
        const arr = edgeMap.get(e.key);
        if (arr.length !== 2) continue;
        const rec = arr.find((x) => x.face !== cur);
        const other = rec.face;
        if (degenerate[other]) continue;
        const eCur = faceEdges[cur].find((x) => x.key === e.key);
        // dir 相同 => 两面在共享边上走向相同 => 定向不协调，邻面需相对翻转
        const wantFlipOther = eCur.dir === rec.dir ? flip[cur] ^ 1 : flip[cur];
        if (!seen.has(other)) {
          seen.add(other);
          flip[other] = wantFlipOther;
          queue.push(other);
        } else if (flip[other] !== wantFlipOther) {
          orientable = false;
        }
      }
    }
    if (!orientable) {
      nonOrientable.push(comp.id);
      push('non-orientable', 'error',
        `分量 ${comp.id}（${comp.faces.length} 面）绕序冲突，无法定向（含莫比乌斯式拼接）`,
        comp.faces);
    }
  }

  // ---------- 5. 几何接触宽相（BVH）+ 精相（BigInt 谓词） ----------
  const tBVH0 = performance.now();
  const bvh = buildBVH(faceItems);
  const tBVH1 = performance.now();

  function sharedSimplex(fi, fj) {
    const sA = new Set(faces[fi]);
    const common = faces[fj].filter((x) => sA.has(x));
    if (common.length === 0) return null;
    if (common.length === 1) return { kind: 'vertex', verts: [common[0]] };
    if (common.length === 2) return { kind: 'edge', verts: common };
    return { kind: 'triangle', verts: common };
  }

  let pairTests = 0;
  const tPair0 = performance.now();
  const seenPairs = new Set();
  function handlePair(fi, fj) {
    const lo = fi < fj ? fi : fj;
    const hi = fi < fj ? fj : fi;
    if (lo === hi) return;
    const pk = lo * faceCount + hi;
    if (seenPairs.has(pk)) return;
    seenPairs.add(pk);
    pairTests++;
    const simplex = sharedSimplex(lo, hi);
    if (simplex && simplex.kind === 'triangle') return;
    const coplanar =
      orient3(points[faces[lo][0]], points[faces[lo][1]], points[faces[lo][2]], points[faces[hi][0]]) === 0 &&
      orient3(points[faces[lo][0]], points[faces[lo][1]], points[faces[lo][2]], points[faces[hi][1]]) === 0 &&
      orient3(points[faces[lo][0]], points[faces[lo][1]], points[faces[lo][2]], points[faces[hi][2]]) === 0;
    let result;
    if (coplanar) {
      const axis = projectAxis(normals[lo]);
      result = testCoplanarPair(points, faces[lo], faces[hi], simplex, axis);
    } else {
      result = testNonCoplanarPair(points, faces[lo], faces[hi], simplex);
    }
    if (result.type === 'touch') {
      push('bad-contact', 'error',
        `面 ${lo} 与面 ${hi} 存在非拓扑点接触：${result.detail}`, [lo, hi]);
    } else if (result.type === 'overlap') {
      push('coplanar-overlap', 'error',
        `面 ${lo} 与面 ${hi} 共面重叠：${result.detail}`, [lo, hi]);
    } else if (result.type === 'cross') {
      push('crossing', 'error',
        `面 ${lo} 与面 ${hi} 穿越相交：${result.detail}`, [lo, hi]);
    }
  }
  function traverse(li, ri) {
    if (li === ri) {
      const node = bvh.nodes[li];
      if (node.faces) {
        // 叶子自访：枚举叶内所有面面对
        const lf = node.faces;
        for (let x = 0; x < lf.length; x++) {
          for (let y = x + 1; y < lf.length; y++) {
            handlePair(lf[x], lf[y]);
          }
        }
        return;
      }
      // 同一内部节点：子树对 + 各自内部
      traverse(node.left, node.right);
      traverse(node.left, node.left);
      traverse(node.right, node.right);
      return;
    }
    const L = bvh.nodes[li], R = bvh.nodes[ri];
    if (!boxesOverlap(L.box, R.box)) return;
    if (L.faces && R.faces) {
      for (const fi of L.faces) {
        for (const fj of R.faces) handlePair(fi, fj);
      }
      return;
    }
    if (L.faces) {
      // L 是叶子，R 是内部
      traverse(li, R.left);
      traverse(li, R.right);
      return;
    }
    if (R.faces) {
      // R 是叶子，L 是内部
      traverse(L.left, ri);
      traverse(L.right, ri);
      return;
    }
    // 两个内部节点
    traverse(L.left, R.left);
    traverse(L.left, R.right);
    traverse(L.right, R.left);
    traverse(L.right, R.right);
  }
  traverse(bvh.root, bvh.root);
  const tPair1 = performance.now();

  // ---------- 6. 壳与包含树（实体内部，严格包含） ----------
  const badFanSet = new Set(badFanVertices);
  const nmEdgeSet = new Set(nonManifoldEdges);
  const bEdgeSet = new Set(boundaryEdges);
  const shells = [];
  for (const comp of components) {
    let closed = true;
    const vset = new Set();
    for (const fi of comp.faces) {
      for (const e of faceEdges[fi]) {
        if (bEdgeSet.has(e.key) || nmEdgeSet.has(e.key)) { closed = false; break; }
      }
      for (const vi of faces[fi]) vset.add(vi);
    }
    let manifoldVerts = true;
    for (const vi of vset) if (badFanSet.has(vi)) manifoldVerts = false;
    const orientable = !nonOrientable.includes(comp.id);
    shells.push({
      componentId: comp.id,
      faces: comp.faces,
      vertices: [...vset],
      closed, manifoldVerts, orientable,
      valid: closed && manifoldVerts && orientable,
      parent: null, depth: 0, volume6: null, volume6String: null, box: null,
    });
  }
  for (const sh of shells) {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const vi of sh.vertices) {
      for (let k = 0; k < 3; k++) {
        if (vertices[vi][k] < mn[k]) mn[k] = vertices[vi][k];
        if (vertices[vi][k] > mx[k]) mx[k] = vertices[vi][k];
      }
    }
    sh.box = { min: mn, max: mx };
  }

  function boxContains(outer, inner) {
    for (let k = 0; k < 3; k++) {
      if (inner.min[k] < outer.min[k] || inner.max[k] > outer.max[k]) return false;
    }
    return true;
  }

  // 严格点在壳内：测试点为齐次坐标 q/w（内部点，w>0），射线 q/w + t*d (t>0)。
  // 三角形平面用 BigInt 平面方程 N·x = D0（N=面法线，D0=N·a）。
  // 交点 t = (D0*w - N·q) / (N·d)，有理数精确；t>0 且交点落在三角形内则计一次。
  function pointStrictlyInShell(q, w, sh) {
    const dirs = [
      [1n, 0n, 0n], [0n, 1n, 0n], [0n, 0n, 1n],
      [1n, 1n, 0n], [1n, 0n, 1n], [0n, 1n, 1n], [1n, 1n, 1n],
      [3n, 5n, 7n], [11n, 13n, 17n], // 非对称质数方向，规避规则擦边
    ];
    for (const dir of dirs) {
      let inside = false;
      let boundary = false;
      for (const fi of sh.faces) {
        const [ia, ib, ic] = faces[fi];
        const a = points[ia], b = points[ib], c = points[ic];
        const N = [
          (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        const D0 = N[0] * a[0] + N[1] * a[1] + N[2] * a[2];
        const Nq = N[0] * q[0] + N[1] * q[1] + N[2] * q[2];
        const Nd = N[0] * dir[0] + N[1] * dir[1] + N[2] * dir[2];
        const num = D0 * w - Nq;   // 真实点代入：N·(q/w) - D0 的分子
        if (num === 0n) { boundary = true; break; } // 起点在面平面上，换方向
        if (Nd === 0n) continue;  // 射线与平面平行
        // t = num / (Nd*w)，要求 t>0
        const den = Nd * w;
        if ((num > 0n) !== (den > 0n)) continue;
        // 交点齐次坐标 X/W = q/w + t*d = (q*den + num*d*w)/(w*den)
        const W = w * (den < 0n ? -den : den);
        const sgn = den < 0n ? -1n : 1n;
        const X = [
          q[0] * (sgn * den) + num * dir[0] * w,
          q[1] * (sgn * den) + num * dir[1] * w,
          q[2] * (sgn * den) + num * dir[2] * w,
        ];
        const hit = pointOnTriHomogeneous(X, W, a, b, c);
        if (hit) {
          // 若交点落在三角形边上，射线擦边，该方向计数有歧义，换方向重测
          if (pointOnTriEdgeHomogeneous(X, W, a, b, c)) { boundary = true; break; }
          inside = !inside;
        }
      }
      if (boundary) continue;
      return inside;
    }
    return null;
  }

  const validShells = shells.filter((s) => s.valid);
  for (const sh of validShells) {
    // 内部测试点：取壳第一个面的非对称凸组合 (4a+2b+c)/7（权重 7）。
    // 非对称权重打破中心对称，避免轴对齐射线规律性命中边；
    // 凸组合保证严格位于面内侧，对封闭壳即为实体内部点。
    const fi = sh.faces[0];
    const [ia, ib, ic] = faces[fi];
    const w = 7n;
    const q = [
      4n * points[ia][0] + 2n * points[ib][0] + points[ic][0],
      4n * points[ia][1] + 2n * points[ib][1] + points[ic][1],
      4n * points[ia][2] + 2n * points[ib][2] + points[ic][2],
    ];
    const containers = [];
    for (const other of validShells) {
      if (other === sh) continue;
      if (!boxContains(other.box, sh.box)) continue;
      const r = pointStrictlyInShell(q, w, other);
      if (r === null) {
        push('containment-ambiguous', 'warning',
          `分量 ${sh.componentId} 相对分量 ${other.componentId} 的包含射线全部擦边，包含关系存疑`,
          sh.faces);
      } else if (r) {
        containers.push(other);
      }
    }
    if (containers.length) {
      // 最近外层 = 嵌套最深的容器
      let best = null, bestDepth = -1;
      for (const cand of containers) {
        let d = 0, cur = cand;
        const guard = new Set();
        while (cur.parent && !guard.has(cur)) { guard.add(cur); cur = cur.parent; d++; }
        if (d > bestDepth) { bestDepth = d; best = cand; }
      }
      sh.parent = best;
    }
  }
  {
    let changed = true;
    while (changed) {
      changed = false;
      for (const sh of validShells) {
        const d = sh.parent ? sh.parent.depth + 1 : 0;
        if (d !== sh.depth) { sh.depth = d; changed = true; }
      }
    }
  }

  // ---------- 7. 体积、交替定向、修正索引 ----------
  let totalVolume6 = 0n;
  for (const sh of validShells) {
    let vol = 0n;
    for (const fi of sh.faces) {
      const [a, b, c] = faces[fi];
      const term = det6(points[a], points[b], points[c]);
      vol += flip[fi] ? -term : term;
    }
    const targetPositive = sh.depth % 2 === 0;
    const needShellFlip = targetPositive ? vol < 0n : vol > 0n;
    if (needShellFlip) {
      for (const fi of sh.faces) flip[fi] = flip[fi] ^ 1;
      vol = -vol;
    }
    if (vol === 0n) {
      push('zero-volume-shell', 'error',
        `分量 ${sh.componentId} 闭合但六倍带符号体积为零（自交/退化封闭面）`, sh.faces);
      sh.valid = false;
      continue;
    }
    sh.volume6 = vol;
    sh.volume6String = vol.toString();
    totalVolume6 += vol;
  }

  // ---------- 8. 汇总 ----------
  const t1 = performance.now();
  const errorCount = issues.filter((x) => x.severity === 'error').length;
  const legal = errorCount === 0;

  const correctedFaces = legal ? faces.map((f, fi) =>
    flip[fi] ? [f[0], f[2], f[1]] : [f[0], f[1], f[2]]) : null;

  return {
    legal,
    stats: {
      vertexCount, faceCount,
      shellCount: validShells.length,
      pairTests,
      timingsMs: {
        total: Math.round(t1 - t0),
        bvh: Math.round(tBVH1 - tBVH0),
        pairTests: Math.round(tPair1 - tPair0),
      },
    },
    issues,
    shells: shells.map((sh) => ({
      componentId: sh.componentId,
      faces: sh.faces,
      vertices: sh.vertices,
      depth: sh.depth,
      parent: sh.parent ? sh.parent.componentId : null,
      closed: sh.closed,
      manifoldVerts: sh.manifoldVerts,
      orientable: sh.orientable,
      valid: sh.valid,
      volume6: sh.volume6String,
    })),
    totalVolume6: legal ? totalVolume6.toString() : null,
    correctedFaces,
    flip: Array.from(flip),
    normals: normals.map((n) => [n[0].toString(), n[1].toString(), n[2].toString()]),
    vertices,
    faces,
  };
}
