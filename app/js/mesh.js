/**
 * Mesh preparation: vertex welding, orientation, topology diagnostics,
 * connected components. Pure functions, no DOM, safe to run in a worker.
 */

import { StlError } from './stl.js';

const EMPTY = Object.freeze([]);

/** Union-find with path halving. */
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
    return true;
  }
}

function bboxOfPositions(positions, count) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 3; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Spatial hash of integer cell coordinates. Collisions are harmless: every
 *  candidate is distance-checked before merging. */
function cellHash(ix, iy, iz) {
  return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
}

class VertexWelder {
  constructor(tolerance) {
    this.tol = tolerance;
    this.cells = new Map();
    this.coords = [];
  }
  add(x, y, z) {
    const tol = this.tol;
    // Round, not floor: with round the candidate cell is within ±tol/2, so
    // only the 8 cells below the rounded coordinates can hold a match.
    const ix = Math.round(x / tol);
    const iy = Math.round(y / tol);
    const iz = Math.round(z / tol);
    const tol2 = tol * tol;
    for (let dx = -1; dx <= 0; dx++) {
      for (let dy = -1; dy <= 0; dy++) {
        for (let dz = -1; dz <= 0; dz++) {
          const bucket = this.cells.get(cellHash(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const id = bucket[bi];
            const o = id * 3;
            const ddx = this.coords[o] - x;
            const ddy = this.coords[o + 1] - y;
            const ddz = this.coords[o + 2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) return id;
          }
        }
      }
    }
    const id = this.coords.length / 3;
    this.coords.push(x, y, z);
    const k = cellHash(ix, iy, iz);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(id);
    else this.cells.set(k, [id]);
    return id;
  }
}

/**
 * @param {{positions: Float32Array, normals: Float32Array, triangleCount: number,
 *          format: string, warnings: string[]}} parsed
 * @param {{name?: string, source?: string}} meta
 */
export function buildMesh(parsed, meta = {}) {
  const triCount = parsed.triangleCount;
  const raw = parsed.positions;

  // Bounding box of the raw triangle soup drives all tolerances.
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triCount * 9; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = raw[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diagonal = Math.hypot(extent[0], extent[1], extent[2]);
  if (!(diagonal > 0) || !Number.isFinite(diagonal)) {
    throw new StlError('degenerate-model', '模型包围盒为空或尺寸非有限值');
  }

  // Orientation: use signed volume of the triangle soup. STL is supposed to be
  // outward oriented; many files are not. Flip once, globally, so that the
  // section's "material on the left" convention is meaningful.
  let signedVolume = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = raw[o], ay = raw[o + 1], az = raw[o + 2];
    const bx = raw[o + 3], by = raw[o + 4], bz = raw[o + 5];
    const cx = raw[o + 6], cy = raw[o + 7], cz = raw[o + 8];
    signedVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  const volumeScale = extent[0] * extent[1] * extent[2];
  const flip = signedVolume < 0;

  // Welding tolerance. Float32 STL vertices have ~1e-7 relative precision;
  // use a small multiple of the diagonal so split vertices still merge, while
  // keeping it far below any plausible printed feature size.
  const weldTolerance = Math.max(1e-9, diagonal * 2e-7);

  const welder = new VertexWelder(weldTolerance);
  const triVerts = new Uint32Array(triCount * 3);
  let degenerateTriangles = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    let i0, i1, i2;
    if (!flip) {
      i0 = welder.add(raw[o], raw[o + 1], raw[o + 2]);
      i1 = welder.add(raw[o + 3], raw[o + 4], raw[o + 5]);
      i2 = welder.add(raw[o + 6], raw[o + 7], raw[o + 8]);
    } else {
      // Swap two corners to reverse winding.
      i0 = welder.add(raw[o], raw[o + 1], raw[o + 2]);
      i1 = welder.add(raw[o + 6], raw[o + 7], raw[o + 8]);
      i2 = welder.add(raw[o + 3], raw[o + 4], raw[o + 5]);
    }
    triVerts[t * 3] = i0;
    triVerts[t * 3 + 1] = i1;
    triVerts[t * 3 + 2] = i2;
    if (i0 === i1 || i1 === i2 || i0 === i2) degenerateTriangles++;
  }

  const verts = Float32Array.from(welder.coords);
  const vertCount = verts.length / 3;
  if (vertCount < 3) {
    throw new StlError('degenerate-model', '焊接后顶点不足以构成三角面');
  }

  // Edge topology diagnostics. Packed numeric keys stay exact for
  // vertCount < 2^26; anything above that falls back to string keys.
  const edgeUse = new Map();
  const numericKeys = vertCount < 67_000_000;
  const keyBase = vertCount;
  const edgeKey = numericKeys
    ? (a, b) => (a < b ? a * keyBase + b : b * keyBase + a)
    : (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  let openEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let t = 0; t < triCount; t++) {
    const a = triVerts[t * 3];
    const b = triVerts[t * 3 + 1];
    const c = triVerts[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const pairs = [[a, b], [b, c], [c, a]];
    for (const [i, j] of pairs) {
      const k = edgeKey(i, j);
      let e = edgeUse.get(k);
      if (!e) {
        e = { count: 0, forward: 0, backward: 0 };
        edgeUse.set(k, e);
      }
      e.count++;
      if (i < j) e.forward++; else e.backward++;
    }
  }
  for (const e of edgeUse.values()) {
    if (e.count === 1) openEdges++;
    else if (e.count > 2) nonManifoldEdges++;
    else if (e.forward === 2 || e.backward === 2) inconsistentEdges++;
  }

  // Connected components over welded vertices.
  const uf = new UnionFind(vertCount);
  for (let t = 0; t < triCount; t++) {
    const a = triVerts[t * 3];
    const b = triVerts[t * 3 + 1];
    const c = triVerts[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    uf.union(a, b);
    uf.union(b, c);
  }
  const rootToComponent = new Map();
  const triComponent = new Uint32Array(triCount);
  const componentVerts = new Map();
  for (let v = 0; v < vertCount; v++) {
    const r = uf.find(v);
    let list = componentVerts.get(r);
    if (!list) {
      list = [];
      componentVerts.set(r, list);
      rootToComponent.set(r, rootToComponent.size);
    }
    list.push(v);
  }
  let touchedComponents = 0;
  for (let t = 0; t < triCount; t++) {
    const r = uf.find(triVerts[t * 3]);
    const comp = rootToComponent.get(r);
    triComponent[t] = comp;
    const a = triVerts[t * 3], b = triVerts[t * 3 + 1], c = triVerts[t * 3 + 2];
    if (a !== b && b !== c && a !== c) touchedComponents = Math.max(touchedComponents, comp + 1);
  }

  // Render arrays: oriented triangles as a flat Float32Array plus per-triangle
  // component ids, so the renderer can tint separate bodies.
  const renderPositions = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ia = triVerts[t * 3], ib = triVerts[t * 3 + 1], ic = triVerts[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      renderPositions[o + k] = verts[ia * 3 + k];
      renderPositions[o + 3 + k] = verts[ib * 3 + k];
      renderPositions[o + 6 + k] = verts[ic * 3 + k];
    }
  }

  const warnings = [...parsed.warnings];
  if (openEdges > 0) {
    warnings.push(`模型有 ${openEdges} 条边界边（开口）。截面只按真实表面计算，断口不会被补成实体。`);
  }
  if (nonManifoldEdges > 0) {
    warnings.push(`模型有 ${nonManifoldEdges} 条非流形边（被 3 个以上三角面共用）。`);
  }
  if (inconsistentEdges > 0) {
    warnings.push(`模型有 ${inconsistentEdges} 条方向不一致的共享边。`);
  }
  if (degenerateTriangles > 0) {
    warnings.push(`模型有 ${degenerateTriangles} 个退化三角面（零面积或重复顶点），已从拓扑统计中忽略。`);
  }
  if (flip) {
    warnings.push('模型整体绕序为内向，已统一翻转为外向（不影响几何）。');
  }

  const bbox = bboxOfPositions(verts, vertCount);
  const diagnostics = {
    openEdges,
    nonManifoldEdges,
    inconsistentEdges,
    degenerateTriangles,
    connectedComponents: touchedComponents,
    signedVolume,
    volumeScale,
    closed: openEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0,
    orientationFlipped: flip,
  };

  return {
    meta: {
      name: meta.name || 'model.stl',
      source: meta.source || 'upload',
      format: parsed.format,
      triangleCount: triCount,
      weldedVertexCount: vertCount,
      bbox,
      extent,
      diagonal,
      units: 'mm',
      weldTolerance,
      warnings,
    },
    diagnostics,
    verts,
    triVerts,
    renderPositions,
    triComponent,
    componentCount: touchedComponents,
    triangleCount: triCount,
  };
}
