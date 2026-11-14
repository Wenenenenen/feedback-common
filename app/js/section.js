/**
 * Plane-section engine.
 *
 * Plane: n · p = d, n need not be unit length. The section is the limit taken
 * approaching the plane along +n: a plane point q belongs to the section when
 * material exists at q + t n̂ for arbitrarily small t > 0. This is the same as
 * intersecting the mesh with the plane n · p = d + ε and letting ε → 0+.
 *
 * From that definition the classification is exact:
 *   a vertex is "above" iff s = n·p − d > 0 (strict), and vertices with
 *   s = 0 belong to the approach side's interior limit (they are below the
 *   ε-level plane). Therefore:
 *   - a triangle contributes cut line only if it has at least one strictly
 *     above vertex;
 *   - crossing points are where an edge goes from above to non-above; if the
 *     non-above endpoint has s = 0 the crossing is that vertex exactly;
 *   - a coplanar triangle contributes nothing directly. A face lying in the
 *     plane is still seen, because its neighbouring side faces generate the
 *     same boundary from their above vertices. A face touching the plane from
 *     the −n side produces no line at all.
 *   This yields "d = 12 → empty, d = 0 → still a ring, d = 12 from above → ring"
 *   without any special casing, and never invents geometry for open shells.
 *
 * Every segment is oriented so the material is on its left. In the plane basis
 * (u, v) with u × v = n̂, a solid body's outer boundary is then CCW (positive
 * signed area) and a hole boundary is CW (negative signed area). Segments
 * coming from coincident geometry are merged by exact endpoint identity;
 * opposite-direction duplicates are interior seams of zero width and cancel,
 * which rules out doubled lines. Zero-area walks are dropped, which rules out
 * spikes at vertex-touching cuts.
 *
 * Loops are traced with the face-walk rule (take the most clockwise edge from
 * the reversed incoming edge). Bodies are 3-D connected components of the mesh,
 * never inferred from 2-D nesting, so separate parts stay separate. Holes are
 * assigned to the body whose outer loop contains them.
 */

const EPS_SCALE = 3e-6;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Orthonormal basis (u, v) with u × v = n. Deterministic. */
export function planeBasis(n) {
  const nHat = norm(n) || [0, 0, 1];
  const ax = Math.abs(nHat[0]);
  const ay = Math.abs(nHat[1]);
  const az = Math.abs(nHat[2]);
  let helper;
  if (ax <= ay && ax <= az) helper = [1, 0, 0];
  else if (ay <= az) helper = [0, 1, 0];
  else helper = [0, 0, 1];
  const h = dot(helper, nHat);
  const u = norm([helper[0] - nHat[0] * h, helper[1] - nHat[1] * h, helper[2] - nHat[2] * h]) || [1, 0, 0];
  const v = cross(nHat, u);
  return { n: nHat, u, v };
}

function planeInfo(planeN, planeD, n, d, origin, u, v) {
  return { n: planeN.slice(), d: planeD, nUnit: n, dNormalized: d, origin, u, v };
}

function emptyResult(mesh, info, reason, started, warnings = []) {
  return {
    ok: true,
    empty: true,
    reason,
    plane: info,
    loops: [],
    bodies: [],
    measurements: {
      area_mm2: 0,
      perimeter_mm: 0,
      closedPerimeter_mm: 0,
      openPerimeter_mm: 0,
      loopCount: 0,
      solidLoopCount: 0,
      holeCount: 0,
      openChainCount: 0,
      bodyCount: 0,
    },
    warnings,
    elapsedMs: now() - started,
    diagnostics: mesh.diagnostics,
  };
}

/**
 * @param {object} mesh buildMesh() output
 * @param {number[]} planeN
 * @param {number} planeD
 */
export function sliceMesh(mesh, planeN, planeD) {
  const started = now();
  if (!Array.isArray(planeN) || planeN.length !== 3 || !planeN.every(Number.isFinite)) {
    throw new Error('平面法线 n 需要 3 个有限数');
  }
  if (!Number.isFinite(planeD)) throw new Error('平面常数 d 需要有限数');
  const rawLen = Math.hypot(planeN[0], planeN[1], planeN[2]);
  if (!(rawLen > 0)) throw new Error('平面法线不能为零向量');

  const n = [planeN[0] / rawLen, planeN[1] / rawLen, planeN[2] / rawLen];
  const d = planeD / rawLen;
  const { u, v } = planeBasis(n);
  const origin = [n[0] * d, n[1] * d, n[2] * d];
  const info = planeInfo(planeN, planeD, n, d, origin, u, v);

  const { verts, triVerts, triComponent, triangleCount, meta, diagnostics } = mesh;
  const vertCount = verts.length / 3;
  const eps = Math.max(1e-12, meta.diagonal * EPS_SCALE);

  // Signed distances, snapped so "touching" is exact.
  const s = new Float64Array(vertCount);
  let aboveCount = 0;
  for (let i = 0; i < vertCount; i++) {
    let si = n[0] * verts[i * 3] + n[1] * verts[i * 3 + 1] + n[2] * verts[i * 3 + 2] - d;
    if (Math.abs(si) <= eps) si = 0;
    s[i] = si;
    if (si > 0) aboveCount++;
  }
  if (aboveCount === 0) {
    return emptyResult(mesh, info, '沿 +n 方向没有实体（平面贴在模型表面外侧或完全在外）', started);
  }

  // ---------------------------------------------------------------------
  // Cut points: mesh vertices on the plane, plus crossings keyed by mesh
  // edge. Exact keys guarantee adjacent triangles share endpoints, so loops
  // close exactly with no tolerance welding of the geometry itself.
  // ---------------------------------------------------------------------
  const points = [];           // flat xyz
  const pointKeys = new Map(); // key -> id
  function addPoint(x, y, z, key) {
    const hit = pointKeys.get(key);
    if (hit !== undefined) return hit;
    const id = points.length / 3;
    points.push(x, y, z);
    pointKeys.set(key, id);
    return id;
  }
  function vertexPoint(vi) {
    return addPoint(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2], `v${vi}`);
  }
  function edgePoint(pa, pb, sa, sb) {
    const key = pa < pb ? `e${pa},${pb}` : `e${pb},${pa}`;
    const hit = pointKeys.get(key);
    if (hit !== undefined) return hit;
    const t = sa / (sa - sb);
    return addPoint(
      verts[pa * 3] + (verts[pb * 3] - verts[pa * 3]) * t,
      verts[pa * 3 + 1] + (verts[pb * 3 + 1] - verts[pa * 3 + 1]) * t,
      verts[pa * 3 + 2] + (verts[pb * 3 + 2] - verts[pa * 3 + 2]) * t,
      key,
    );
  }
  const project2d = (pid) => {
    const x = points[pid * 3] - origin[0];
    const y = points[pid * 3 + 1] - origin[1];
    const z = points[pid * 3 + 2] - origin[2];
    return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]];
  };

  const rawA = [];
  const rawB = [];
  const rawComp = [];
  const rawDir = []; // material-left unit direction in (u,v)

  const triPoint = [-1, -1];
  for (let t = 0; t < triangleCount; t++) {
    const ia = triVerts[t * 3];
    const ib = triVerts[t * 3 + 1];
    const ic = triVerts[t * 3 + 2];
    if (ia === ib || ib === ic || ia === ic) continue;
    const sa = s[ia], sb = s[ib], sc = s[ic];
    if (sa <= 0 && sb <= 0 && sc <= 0) continue;   // nothing strictly above
    if (sa > 0 && sb > 0 && sc > 0) continue;      // no crossing
    const ids = [ia, ib, ic];
    const sv = [sa, sb, sc];
    let nPts = 0;
    for (let e = 0; e < 3 && nPts < 2; e++) {
      const i = e, j = (e + 1) % 3;
      if (sv[i] > 0 && sv[j] <= 0) {
        triPoint[nPts++] = sv[j] === 0 ? vertexPoint(ids[j]) : edgePoint(ids[i], ids[j], sv[i], sv[j]);
      } else if (sv[i] <= 0 && sv[j] > 0) {
        triPoint[nPts++] = sv[i] === 0 ? vertexPoint(ids[i]) : edgePoint(ids[i], ids[j], sv[i], sv[j]);
      }
    }
    if (nPts !== 2 || triPoint[0] === triPoint[1]) continue;

    const a3 = [verts[ia * 3], verts[ia * 3 + 1], verts[ia * 3 + 2]];
    const b3 = [verts[ib * 3], verts[ib * 3 + 1], verts[ib * 3 + 2]];
    const c3 = [verts[ic * 3], verts[ic * 3 + 1], verts[ic * 3 + 2]];
    const f = cross(sub(b3, a3), sub(c3, a3));
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (!(fl > 0)) continue;
    const fx = (f[0] * u[0] + f[1] * u[1] + f[2] * u[2]) / fl;
    const fy = (f[0] * v[0] + f[1] * v[1] + f[2] * v[2]) / fl;
    const dl = Math.hypot(fx, fy);
    if (!(dl > 1e-12)) continue;
    // Outward normal projected into the plane points away from material;
    // rotate +90° to walk with material on the left.
    const dirU = -fy / dl;
    const dirV = fx / dl;

    const p0 = project2d(triPoint[0]);
    const p1 = project2d(triPoint[1]);
    const ex = p1[0] - p0[0];
    const ey = p1[1] - p0[1];
    const el = Math.hypot(ex, ey);
    if (!(el > 1e-14)) continue;
    const align = (ex * dirU + ey * dirV) / el;
    if (Math.abs(align) < 1e-9) continue;
    rawA.push(triPoint[0]);
    rawB.push(triPoint[1]);
    rawComp.push(triComponent[t]);
    if (align > 0) rawDir.push(1);
    else rawDir.push(-1);
  }

  if (rawA.length === 0) {
    return emptyResult(mesh, info, '该平面不与模型表面相交', started);
  }

  // ---------------------------------------------------------------------
  // Weld cut points by position.
  //
  // Points created from a shared mesh edge always get the same key, but two
  // separate solids can share a coincident seam (e.g. two boxes touching wall
  // to wall) without sharing welded vertices. That produces two cut points at
  // the same place from different triangles. A spatial weld makes such points
  // a single node, so the seam is one segment instead of two coincident ones.
  // Tolerance is far below any printable feature and above float32 noise.
  // ---------------------------------------------------------------------
  const weldTol = Math.max(1e-9, meta.diagonal * 1e-7);
  const weldCells = new Map();
  const canvasPointToNode = new Int32Array(points.length / 3).fill(-1);
  const nodeX = [];
  const nodeY = [];
  const nodeZ = [];
  const cellHash = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  function nodeOf(pid) {
    if (canvasPointToNode[pid] >= 0) return canvasPointToNode[pid];
    const x = points[pid * 3];
    const y = points[pid * 3 + 1];
    const z = points[pid * 3 + 2];
    const ix = Math.round(x / weldTol);
    const iy = Math.round(y / weldTol);
    const iz = Math.round(z / weldTol);
    const tol2 = weldTol * weldTol;
    for (let dx = -1; dx <= 0; dx++) {
      for (let dy = -1; dy <= 0; dy++) {
        for (let dz = -1; dz <= 0; dz++) {
          const bucket = weldCells.get(cellHash(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const id of bucket) {
            const ex = nodeX[id] - x;
            const ey = nodeY[id] - y;
            const ez = nodeZ[id] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              canvasPointToNode[pid] = id;
              return id;
            }
          }
        }
      }
    }
    const id = nodeX.length;
    nodeX.push(x);
    nodeY.push(y);
    nodeZ.push(z);
    const k = cellHash(ix, iy, iz);
    const bucket = weldCells.get(k);
    if (bucket) bucket.push(id);
    else weldCells.set(k, [id]);
    canvasPointToNode[pid] = id;
    return id;
  }
  for (let i = 0; i < rawA.length; i++) {
    const a = nodeOf(rawA[i]);
    const b = nodeOf(rawB[i]);
    rawA[i] = a;
    rawB[i] = b;
  }

  // ---------------------------------------------------------------------
  // Split segments at T-junctions: a cut point that lies in the interior of
  // another segment (typically a vertex of one part sitting on the wall of
  // another, or a coarse triangle meeting a finer one) would otherwise never
  // become a graph node. Splitting keeps the boundary graph consistent, so
  // loops close instead of producing open chains.
  // ---------------------------------------------------------------------
  {
    const nNodes = nodeX.length;
    const bucketsByX = new Map(); // 1-D spatial buckets in the plane's u,v
    const uvs = new Float64Array(nNodes * 2);
    for (let i = 0; i < nNodes; i++) {
      const x = nodeX[i] - origin[0];
      const y = nodeY[i] - origin[1];
      const z = nodeZ[i] - origin[2];
      uvs[i * 2] = x * u[0] + y * u[1] + z * u[2];
      uvs[i * 2 + 1] = x * v[0] + y * v[1] + z * v[2];
    }
    const sorted = [];
    for (let i = 0; i < nNodes; i++) sorted.push(i);
    sorted.sort((p, q) => uvs[p * 2] - uvs[q * 2]);
    // For each segment, find nodes with u within [u_lo, u_hi] that lie on the
    // segment's line within tolerance and strictly between the endpoints.
    const splitEdges = [];
    const lineTol = Math.max(1e-7, meta.diagonal * 1e-6);
    for (let i = 0; i < rawA.length; i++) {
      const a = rawA[i];
      const b = rawB[i];
      const ax = uvs[a * 2], ay = uvs[a * 2 + 1];
      const bx = uvs[b * 2], by = uvs[b * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const len = Math.sqrt(len2);
      const uMin = Math.min(ax, bx) - lineTol;
      const uMax = Math.max(ax, bx) + lineTol;
      // Binary search the sorted node list for the u range.
      let lo = 0, hi = nNodes;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (uvs[sorted[mid] * 2] < uMin) lo = mid + 1;
        else hi = mid;
      }
      const mids = [];
      for (let k = lo; k < nNodes; k++) {
        const node = sorted[k];
        const ux = uvs[node * 2];
        if (ux > uMax) break;
        if (node === a || node === b) continue;
        const t = ((ux - ax) * dx + (uvs[node * 2 + 1] - ay) * dy) / len2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const px = ax + t * dx;
        const py = ay + t * dy;
        const ex = ux - px;
        const ey = uvs[node * 2 + 1] - py;
        if (ex * ex + ey * ey <= lineTol * lineTol) {
          mids.push({ node, t });
        }
      }
      if (mids.length > 0) {
        mids.sort((p, q) => p.t - q.t);
        splitEdges.push({ index: i, mids });
      }
    }
    if (splitEdges.length > 0) {
      const splitByIndex = new Map();
      for (const e of splitEdges) splitByIndex.set(e.index, e);
      const newA = [];
      const newB = [];
      const newComp = [];
      const newDir = [];
      for (let i = 0; i < rawA.length; i++) {
        let chain;
        const entry = splitByIndex.get(i);
        if (entry) chain = [rawA[i], ...entry.mids.map((m) => m.node), rawB[i]];
        else chain = [rawA[i], rawB[i]];
        for (let k = 0; k + 1 < chain.length; k++) {
          const p = chain[k];
          const q = chain[k + 1];
          if (p === q) continue;
          newA.push(p);
          newB.push(q);
          newComp.push(rawComp[i]);
          newDir.push(rawDir[i]);
        }
      }
      rawA.length = 0;
      rawA.push(...newA);
      rawB.length = 0;
      rawB.push(...newB);
      rawComp.length = 0;
      rawComp.push(...newComp);
      rawDir.length = 0;
      rawDir.push(...newDir);
    }
  }

  // ---------------------------------------------------------------------
  // Merge coincident segments. Same unordered node pair: cancel if both
  // orientations appear (zero-width seam); otherwise keep one.
  // ---------------------------------------------------------------------
  const groups = new Map();
  for (let i = 0; i < rawA.length; i++) {
    const a = rawA[i];
    const b = rawB[i];
    if (a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * 4294967296 + hi;
    let g = groups.get(key);
    if (!g) { g = { lo, hi, dir: 0, comp: rawComp[i] }; groups.set(key, g); }
    g.dir += (a === lo ? 1 : -1) * rawDir[i];
  }
  const segA = [];
  const segB = [];
  const segComp = [];
  for (const g of groups.values()) {
    if (g.dir === 0) continue; // opposite copies: interior seam
    if (g.dir > 0) { segA.push(g.lo); segB.push(g.hi); }
    else { segA.push(g.hi); segB.push(g.lo); }
    segComp.push(g.comp);
  }
  if (segA.length === 0) {
    return emptyResult(mesh, info, '截面退化为零宽度线（仅相切），未生成环', started);
  }

  const nodeCount = points.length / 3;
  const px = new Float64Array(nodeCount);
  const py = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const p = project2d(i);
    px[i] = p[0];
    py[i] = p[1];
  }

  // ---------------------------------------------------------------------
  // Trace loops with the face-walk rule.
  // ---------------------------------------------------------------------
  const segCount = segA.length;
  const outgoing = new Map();
  const outCount = new Int32Array(nodeCount);
  const inCount = new Int32Array(nodeCount);
  for (let i = 0; i < segCount; i++) {
    let list = outgoing.get(segA[i]);
    if (!list) { list = []; outgoing.set(segA[i], list); }
    list.push(i);
    outCount[segA[i]]++;
    inCount[segB[i]]++;
  }
  const used = new Uint8Array(segCount);
  const dirsX = new Float64Array(segCount);
  const dirsY = new Float64Array(segCount);
  for (let i = 0; i < segCount; i++) {
    const dx = px[segB[i]] - px[segA[i]];
    const dy = py[segB[i]] - py[segA[i]];
    const l = Math.hypot(dx, dy);
    dirsX[i] = l > 0 ? dx / l : 1;
    dirsY[i] = l > 0 ? dy / l : 0;
  }

  function stepChoice(cur, prev, inDx, inDy) {
    const list = outgoing.get(cur);
    if (!list) return -1;
    let best = -1;
    let bestAngle = -Infinity;
    for (const cand of list) {
      if (used[cand]) continue;
      if (segB[cand] === prev) continue; // do not immediately backtrack
      const cr = inDx * dirsY[cand] - inDy * dirsX[cand];
      const dt = inDx * dirsX[cand] + inDy * dirsY[cand];
      const ang = Math.atan2(cr, dt);
      if (ang > bestAngle) { bestAngle = ang; best = cand; }
    }
    return best;
  }

  const closedWalks = [];
  const openWalks = [];
  const traceFrom = (startNode) => {
    // Start with an unused segment that leaves startNode, if any.
    while (true) {
      const list = outgoing.get(startNode);
      let seed = -1;
      if (list) for (const seg of list) if (!used[seg]) { seed = seg; break; }
      if (seed < 0) return;
      used[seed] = 1;
      const nodes = [startNode, segB[seed]];
      const compVotes = new Map();
      compVotes.set(segComp[seed], 1);
      let cur = segB[seed];
      let prev = startNode;
      let inDx = dirsX[seed];
      let inDy = dirsY[seed];
      let closed = false;
      let guard = segCount + 4;
      while (--guard > 0) {
        if (cur === startNode) { closed = true; break; }
        const nxt = stepChoice(cur, prev, inDx, inDy);
        if (nxt < 0) break;
        used[nxt] = 1;
        prev = cur;
        cur = segB[nxt];
        nodes.push(cur);
        compVotes.set(segComp[nxt], (compVotes.get(segComp[nxt]) || 0) + 1);
        inDx = dirsX[nxt];
        inDy = dirsY[nxt];
      }
      let comp = -1, bestCount = -1;
      for (const [c, count] of compVotes) if (count > bestCount) { bestCount = count; comp = c; }
      if (closed) { nodes.pop(); closedWalks.push({ nodes, comp }); }
      else openWalks.push({ nodes, comp });
    }
  };

  // Prefer starting at nodes that have more outgoing than incoming: these are
  // open-chain ends, so chains are traced whole instead of split in the middle.
  for (const [node] of outgoing) {
    if (outCount[node] > inCount[node]) traceFrom(node);
  }
  for (let i = 0; i < segCount; i++) {
    if (!used[i]) traceFrom(segA[i]);
  }

  // ---------------------------------------------------------------------
  // Turn node walks into measured, cleaned polylines.
  // ---------------------------------------------------------------------
  const minStep = Math.max(1e-12, meta.diagonal * 1e-12);

  function cleanWalk(nodes, closed) {
    const pts = [];
    const ids = [];
    for (const node of nodes) {
      const x = px[node];
      const y = py[node];
      if (pts.length > 0) {
        const dx = x - pts[pts.length - 1][0];
        const dy = y - pts[pts.length - 1][1];
        if (dx * dx + dy * dy <= minStep * minStep) continue;
      }
      pts.push([x, y]);
      ids.push(node);
    }
    if (closed && pts.length > 1) {
      const dx = pts[0][0] - pts[pts.length - 1][0];
      const dy = pts[0][1] - pts[pts.length - 1][1];
      if (dx * dx + dy * dy <= minStep * minStep) {
        pts.pop();
        ids.pop();
      }
    }
    // Collinear cleanup. Closed walks consider every vertex; open chains keep
    // both endpoints even if they happen to be collinear.
    const kx = [];
    const ky = [];
    const kIds = [];
    const nPts = pts.length;
    for (let i = 0; i < nPts; i++) {
      if (!closed && (i === 0 || i === nPts - 1)) {
        kx.push(pts[i][0]);
        ky.push(pts[i][1]);
        kIds.push(ids[i]);
        continue;
      }
      const prev = pts[(i - 1 + nPts) % nPts];
      const cur = pts[i];
      const next = pts[(i + 1) % nPts];
      const ax = cur[0] - prev[0], ay = cur[1] - prev[1];
      const bx = next[0] - cur[0], by = next[1] - cur[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < minStep || lb < minStep) continue;
      const cr = ax * by - ay * bx;
      if (Math.abs(cr) <= 1e-10 * la * lb && ax * bx + ay * by > 0) continue;
      kx.push(cur[0]);
      ky.push(cur[1]);
      kIds.push(ids[i]);
    }
    if (kIds.length < 2) return null;
    let perimeter = 0;
    let area2 = 0;
    const m = kx.length;
    const pairs = closed ? m : m - 1;
    for (let i = 0; i < pairs; i++) {
      const j = (i + 1) % m;
      perimeter += Math.hypot(kx[j] - kx[i], ky[j] - ky[i]);
      if (closed) area2 += kx[i] * ky[j] - kx[j] * ky[i];
    }
    return {
      ids: kIds,
      points: kx.map((x, i) => [x, ky[i]]),
      perimeter,
      area: closed ? area2 / 2 : null,
    };
  }

  const areaTol = Math.max(1e-16, meta.diagonal * meta.diagonal * 1e-16);
  const loops = [];
  const chains = [];
  const degenerate = [];
  for (const walk of closedWalks) {
    const { nodes, comp } = walk;
    const w = cleanWalk(nodes, true);
    if (!w) { degenerate.push({ reason: 'too-short' }); continue; }
    if (Math.abs(w.area) <= areaTol) {
      // A closed walk enclosing no area is a folded/duplicated line, not a
      // section region. Dropping it is what rules out spikes.
      degenerate.push({ reason: 'zero-area', perimeter: w.perimeter });
      continue;
    }
    loops.push({ ...w, kind: w.area > 0 ? 'solid' : 'hole', component: comp });
  }
  for (const walk of openWalks) {
    const { nodes, comp } = walk;
    const w = cleanWalk(nodes, false);
    if (!w || !(w.perimeter > minStep)) continue;
    chains.push({ ...w, component: comp });
  }

  // ---------------------------------------------------------------------
  // Bodies and hole ownership.
  // ---------------------------------------------------------------------
  const bodyMap = new Map();
  const bodyFor = (comp) => {
    let body = bodyMap.get(comp);
    if (!body) {
      body = { component: comp, id: -1, outer: [], holes: [], area: 0, bbox: null, perimeter: 0 };
      bodyMap.set(comp, body);
    }
    return body;
  };
  for (const loop of loops) {
    const body = bodyFor(loop.component);
    if (loop.kind === 'solid') body.outer.push(loop);
    else body.holes.push(loop);
  }

  // Assign each hole to the body whose outer loop contains it. The probe is
  // taken just inside the hole (right of its CW walk), so it cannot sit on a
  // boundary. Bodies are tested by bounding box first: with many disjoint
  // parts this turns a quadratic all-pairs test into a handful of candidates.
  const bodyBBox = new Map();
  for (const body of bodyMap.values()) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const l of [...body.outer, ...body.holes]) {
      for (const p of l.points) {
        if (p[0] < minx) minx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] > maxy) maxy = p[1];
      }
    }
    bodyBBox.set(body, Number.isFinite(minx) ? [minx, miny, maxx, maxy] : null);
  }
  for (const body of [...bodyMap.values()]) {
    for (const hole of body.holes) {
      const probe = holeProbe(hole.points);
      let owner = null;
      let ownerArea = Infinity;
      for (const candidate of bodyMap.values()) {
        const bb = bodyBBox.get(candidate);
        if (bb && (probe[0] < bb[0] || probe[0] > bb[2] || probe[1] < bb[1] || probe[1] > bb[3])) {
          continue;
        }
        for (const outer of candidate.outer) {
          if (pointInPolygon(probe, outer.points)) {
            const a = Math.abs(outer.area);
            if (a < ownerArea) { ownerArea = a; owner = candidate; }
          }
        }
      }
      hole.ownerComponent = owner ? owner.component : null;
      if (owner && owner !== body) {
        body.holes.splice(body.holes.indexOf(hole), 1);
        owner.holes.push(hole);
      }
    }
  }

  const bodyList = [...bodyMap.values()].filter((b) => b.outer.length > 0 || b.holes.length > 0);
  for (const body of bodyList) {
    // A body with holes but no closed outer loop has an open/undefined outer
    // boundary. Filling it in would invent material, so its area stays
    // unknown (0) and the holes are reported as unowned.
    let area = 0;
    if (body.outer.length > 0) {
      for (const l of body.outer) area += l.area;
      for (const h of body.holes) area += h.area;
    } else {
      for (const h of body.holes) h.ownerComponent = null;
    }
    body.area = area;
    let perimeter = 0;
    for (const l of body.outer) perimeter += l.perimeter;
    for (const h of body.holes) perimeter += h.perimeter;
    body.perimeter = perimeter;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const l of [...body.outer, ...body.holes]) {
      for (const p of l.points) {
        if (p[0] < minx) minx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] > maxy) maxy = p[1];
      }
    }
    body.bbox = Number.isFinite(minx) ? [minx, miny, maxx, maxy] : null;
  }
  bodyList.sort((a, b) => b.area - a.area || a.component - b.component);
  for (let i = 0; i < bodyList.length; i++) bodyList[i].id = i;

  // ---------------------------------------------------------------------
  // Serialise.
  // ---------------------------------------------------------------------
  const loopsOut = [];
  let loopId = 0;
  for (const body of bodyList) {
    for (const l of body.outer) {
      loopsOut.push({
        id: loopId++,
        kind: 'solid',
        closed: true,
        bodyId: body.id,
        ownerBodyId: null,
        area_mm2: l.area,
        perimeter_mm: l.perimeter,
        points2d: l.points,
        points3d: l.ids.map((node) => [points[node * 3], points[node * 3 + 1], points[node * 3 + 2]]),
      });
    }
    for (const h of body.holes) {
      const owner = h.ownerComponent != null
        ? bodyList.find((b) => b.component === h.ownerComponent)
        : null;
      loopsOut.push({
        id: loopId++,
        kind: 'hole',
        closed: true,
        bodyId: owner ? owner.id : null,
        ownerBodyId: owner ? owner.id : null,
        area_mm2: h.area,
        perimeter_mm: h.perimeter,
        points2d: h.points,
        points3d: h.ids.map((node) => [points[node * 3], points[node * 3 + 1], points[node * 3 + 2]]),
      });
    }
  }
  for (const c of chains) {
    loopsOut.push({
      id: loopId++,
      kind: 'open',
      closed: false,
      bodyId: null,
      ownerBodyId: null,
      area_mm2: null,
      perimeter_mm: c.perimeter,
      points2d: c.points,
      points3d: c.ids.map((node) => [points[node * 3], points[node * 3 + 1], points[node * 3 + 2]]),
    });
  }

  const solidLoopCount = loops.filter((l) => l.kind === 'solid').length;
  const holeLoopCount = loops.filter((l) => l.kind === 'hole').length;
  // Orphan holes (no closed outer loop encloses them) come from an open shell:
  // their signed area would be negative, but the true area is unknown. Report
  // them but never subtract them from a total that has no outer loop.
  const orphanHoles = bodyList.filter((b) => b.outer.length === 0).flatMap((b) => b.holes);
  let areaSum = 0;
  for (const b of bodyList) areaSum += b.area;
  let closedPerimeter = 0;
  for (const l of loops) closedPerimeter += l.perimeter;
  let openPerimeter = 0;
  for (const c of chains) openPerimeter += c.perimeter;

  const warnings = [];
  if (chains.length > 0) {
    warnings.push(
      `截面有 ${chains.length} 条开放边界（模型开口或非流形），未补成实体，面积只统计闭合外环内的区域。`,
    );
  }
  if (orphanHoles.length > 0) {
    warnings.push(
      `有 ${orphanHoles.length} 条孔洞边界找不到闭合外环（模型开口），面积记为未知而不是负值。`,
    );
  }
  if (degenerate.length > 0) {
    warnings.push(`已忽略 ${degenerate.length} 条零面积 / 退化边界，避免重线与尖刺。`);
  }

  return {
    ok: true,
    empty: false,
    plane: info,
    loops: loopsOut,
    bodies: bodyList.map((b) => ({
      id: b.id,
      component: b.component,
      loopCount: b.outer.length,
      holeCount: b.holes.length,
      area_mm2: b.area,
      perimeter_mm: b.perimeter,
      bbox2d: b.bbox,
    })),
    measurements: {
      area_mm2: areaSum,
      perimeter_mm: closedPerimeter + openPerimeter,
      closedPerimeter_mm: closedPerimeter,
      openPerimeter_mm: openPerimeter,
      loopCount: loops.length,
      solidLoopCount,
      holeCount: holeLoopCount,
      bodyCount: bodyList.length,
      openChainCount: chains.length,
      orphanHoleCount: orphanHoles.length,
    },
    warnings,
    elapsedMs: now() - started,
    diagnostics,
  };
}

/** A point strictly inside a CW hole loop: step right from an edge midpoint. */
function holeProbe(pts) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (!(l > 0)) continue;
    const step = Math.min(l * 1e-4, 1e-6 * Math.max(l, 1e-3) + 1e-9);
    const mx = (a[0] + b[0]) * 0.5;
    const my = (a[1] + b[1]) * 0.5;
    return [mx + (dy / l) * step, my - (dx / l) * step];
  }
  return [pts[0][0], pts[0][1]];
}

export function pointInPolygon(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Range of d = n̂·p for which the plane meets the model's bounding box. */
export function dRangeForBBox(bbox, n) {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0)) return [0, 0];
  const nn = [n[0] / len, n[1] / len, n[2] / len];
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [bbox.min[0], bbox.max[0]]) {
    for (const y of [bbox.min[1], bbox.max[1]]) {
      for (const z of [bbox.min[2], bbox.max[2]]) {
        const value = x * nn[0] + y * nn[1] + z * nn[2];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
  }
  return [lo, hi];
}
