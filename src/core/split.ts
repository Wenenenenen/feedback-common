import type { Corner, Diagnostic, Edge, Face, ParsedMesh } from './types.js';
import { edgeKey, normEdge } from './validate.js';

export interface ChartBuild {
  index: number;
  faces: number[];
  cutVertices: number[];
  interior: number[];
  boundary: number[];
  /** Ordered cut vertex ids; each loop starts at its smallest id. */
  loops: number[][];
  edgeCount: number;
  euler: number;
  errors: Diagnostic[];
}

export interface SplitResult {
  /** Per face corner (3 * face + corner) -> cut vertex, -1 when unavailable. */
  cutVertexOfCorner: number[];
  /** Per cut vertex -> original vertex id. */
  cutOriginalVertex: number[];
  /** Per cut vertex -> merged original face corners, sorted. */
  cutCorners: Corner[][];
  /** Per face -> chart index, or -1. */
  faceChart: number[];
  charts: ChartBuild[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

interface EdgeIncidence {
  a: number;
  b: number;
  faces: number[];
}

class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== cur) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }
}

function cornerIndexInFace(face: Face, vertex: number): number {
  if (face[0] === vertex) return 0;
  if (face[1] === vertex) return 1;
  return 2;
}

/**
 * Split mesh corners into cut vertices using only non-seam shared edges, then
 * assemble charts from face adjacency across those same edges and extract each
 * chart's boundary loops.
 *
 * Corners (not original vertices) are the atomic units, so a seam separates the
 * two sides of the edge and multi-fan vertices can not merge charts together.
 */
export function splitCharts(mesh: ParsedMesh): SplitResult {
  const { faces, seams } = mesh;
  const faceCount = faces.length;
  const seamKeys = new Set<string>(seams.map(([a, b]) => edgeKey(a, b)));
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  const edges = new Map<string, EdgeIncidence>();
  for (let fi = 0; fi < faceCount; fi++) {
    const f = faces[fi];
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = edgeKey(a, b);
      const existing = edges.get(key);
      if (existing) existing.faces.push(fi);
      else edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [fi] });
    }
  }

  // ---- Corner connectivity ----
  const cornerCount = faceCount * 3;
  const corners = new UnionFind(cornerCount);
  for (const [key, inc] of edges) {
    if (seamKeys.has(key) || inc.faces.length !== 2) continue;
    const [f1, f2] = inc.faces;
    for (const v of [inc.a, inc.b]) {
      const c1 = cornerIndexInFace(faces[f1], v);
      const c2 = cornerIndexInFace(faces[f2], v);
      corners.union(f1 * 3 + c1, f2 * 3 + c2);
    }
  }

  const cornersByRoot = new Map<number, number[]>();
  for (let corner = 0; corner < cornerCount; corner++) {
    const root = corners.find(corner);
    const list = cornersByRoot.get(root);
    if (list) list.push(corner);
    else cornersByRoot.set(root, [corner]);
  }

  // Stable order: by minimum (face, corner) of the component, i.e. min corner id.
  const rootMin = new Map<number, number>();
  for (const [root, list] of cornersByRoot) rootMin.set(root, list[0]);
  const orderedRoots = [...cornersByRoot.keys()].sort(
    (x, y) => rootMin.get(x)! - rootMin.get(y)!,
  );

  const cutVertexOfCorner = new Array<number>(cornerCount).fill(-1);
  const cutOriginalVertex: number[] = [];
  const cutCorners: Corner[][] = [];
  const rootToCut = new Map<number, number>();
  for (let cut = 0; cut < orderedRoots.length; cut++) {
    const root = orderedRoots[cut];
    const list = cornersByRoot.get(root)!;
    rootToCut.set(root, cut);
    const cornerList: Corner[] = list
      .map((c) => [Math.floor(c / 3), c % 3] as Corner)
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    cutCorners.push(cornerList);
    cutOriginalVertex.push(faces[cornerList[0][0]][cornerList[0][1]]);
    for (const c of list) cutVertexOfCorner[c] = cut;
  }

  // ---- Charts from face adjacency across non-seam shared edges ----
  const faceSets = new UnionFind(faceCount);
  for (const [key, inc] of edges) {
    if (seamKeys.has(key) || inc.faces.length !== 2) continue;
    faceSets.union(inc.faces[0], inc.faces[1]);
  }
  const facesByRoot = new Map<number, number[]>();
  for (let fi = 0; fi < faceCount; fi++) {
    const root = faceSets.find(fi);
    const list = facesByRoot.get(root);
    if (list) list.push(fi);
    else facesByRoot.set(root, [fi]);
  }
  const chartRoots = [...facesByRoot.keys()].sort((x, y) => {
    const a = facesByRoot.get(x)!;
    const b = facesByRoot.get(y)!;
    return Math.min(...a) - Math.min(...b);
  });

  const faceChart = new Array<number>(faceCount).fill(-1);
  const charts: ChartBuild[] = [];

  for (let ci = 0; ci < chartRoots.length; ci++) {
    const root = chartRoots[ci];
    const chartFaces = facesByRoot.get(root)!.sort((a, b) => a - b);
    for (const fi of chartFaces) faceChart[fi] = ci;

    const chartErrors: Diagnostic[] = [];
    const cutSet = new Set<number>();
    const edgeSet = new Set<string>();
    const directed = new Set<number>(); // a * cutCount + b
    const cutCount = orderedRoots.length;

    // Triangle cut-vertex triples, in input face order.
    const tris = chartFaces.map(
      (fi) =>
        [
          cutVertexOfCorner[fi * 3 + 0],
          cutVertexOfCorner[fi * 3 + 1],
          cutVertexOfCorner[fi * 3 + 2],
        ] as [number, number, number],
    );
    for (const tri of tris) {
      cutSet.add(tri[0]);
      cutSet.add(tri[1]);
      cutSet.add(tri[2]);
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        edgeSet.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        directed.add(a * cutCount + b);
      }
    }

    // Directed boundary edges: an oriented edge whose reverse is absent in the chart.
    const boundaryEdges: Edge[] = [];
    const out = new Map<number, number[]>();
    const inn = new Map<number, number[]>();
    for (const tri of tris) {
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        if (directed.has(b * cutCount + a)) continue;
        boundaryEdges.push([a, b]);
        const o = out.get(a);
        if (o) o.push(b);
        else out.set(a, [b]);
        const i = inn.get(b);
        if (i) i.push(a);
        else inn.set(b, [a]);
      }
    }

    const boundaryCut = [...new Set(boundaryEdges.flat())].sort((a, b) => a - b);
    const branching: number[] = [];
    for (const v of boundaryCut) {
      const o = out.get(v)?.length ?? 0;
      const i = inn.get(v)?.length ?? 0;
      if (o !== 1 || i !== 1) branching.push(v);
    }

    let loops: number[][] = [];
    if (branching.length > 0) {
      chartErrors.push({
        code: 'boundary-branching',
        severity: 'error',
        message: `图表 ${ci} 的边界在 ${branching.length} 个 cut 顶点处分叉（出度/入度不为 1），无法形成简单边界环。`,
        elements: { chart: ci, cutVertices: branching },
      });
    } else {
      const visited = new Set<number>();
      for (const [startA, startB] of boundaryEdges) {
        if (visited.has(startA * cutCount + startB)) continue;
        const loop: number[] = [startA];
        let cur = startA;
        let nxt = startB;
        let guard = 0;
        while (true) {
          visited.add(cur * cutCount + nxt);
          loop.push(nxt);
          if (nxt === startA) {
            loop.pop();
            break;
          }
          cur = nxt;
          const nextList = out.get(cur);
          if (!nextList || nextList.length !== 1) break;
          nxt = nextList[0];
          if (++guard > boundaryEdges.length + 2) break;
        }
        if (loop.length > 0 && new Set(loop).size !== loop.length) {
          chartErrors.push({
            code: 'boundary-branching',
            severity: 'error',
            message: `图表 ${ci} 的边界环重复经过 cut 顶点，拓扑为夹点，不是圆盘。`,
            elements: { chart: ci, cutVertices: loop },
          });
        }
        loops.push(loop);
      }
      // Rotate each loop so it starts at its smallest cut vertex id.
      loops = loops.map((loop) => {
        let minPos = 0;
        for (let i = 1; i < loop.length; i++) if (loop[i] < loop[minPos]) minPos = i;
        if (minPos === 0) return loop;
        return [...loop.slice(minPos), ...loop.slice(0, minPos)];
      });
      loops.sort((x, y) => x[0] - y[0] || x.length - y.length);
    }

    const cutVertices = [...cutSet].sort((a, b) => a - b);
    const boundarySet = new Set(boundaryCut);
    const euler = cutVertices.length - edgeSet.size + chartFaces.length;

    // A zero-length boundary would place every boundary point at the same spot;
    // report it instead of producing a collapsed chart.
    if (loops.length === 1 && chartErrors.length === 0) {
      let total = 0;
      const loop = loops[0];
      for (let i = 0; i < loop.length; i++) {
        const a = cutOriginalVertex[loop[i]];
        const b = cutOriginalVertex[loop[(i + 1) % loop.length]];
        const pa = mesh.vertices[a];
        const pb = mesh.vertices[b];
        total += Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
      }
      if (!(total > 0) || !Number.isFinite(total)) {
        chartErrors.push({
          code: 'degenerate-boundary',
          severity: 'error',
          message: `图表 ${ci} 的边界总长度为 0，无法按弧长放到单位圆。`,
          elements: { chart: ci, cutVertices: loop },
        });
      }
    }

    if (loops.length !== 1 || euler !== 1) {
      const loopDesc = loops.length === 0 ? '没有边界环' : `有 ${loops.length} 个边界环`;
      chartErrors.push({
        code: 'chart-not-disk',
        severity: 'error',
        message:
          `图表 ${ci} 不是拓扑圆盘：${loopDesc}，V-E+F=${euler}（需要 1 个边界环且 V-E+F=1）。` +
          (loops.length > 1 ? ' 可能存在未切开的孔洞或未完成的切缝。' : ''),
        elements: {
          chart: ci,
          loops,
          loopVertices: loops.map((loop) => loop.map((cv) => cutOriginalVertex[cv])),
          cutVertices: cutVertices.filter((v) => boundarySet.has(v)),
          faces: chartFaces,
        },
      });
    }

    errors.push(...chartErrors);
    charts.push({
      index: ci,
      faces: chartFaces,
      cutVertices,
      interior: cutVertices.filter((v) => !boundarySet.has(v)),
      boundary: cutVertices.filter((v) => boundarySet.has(v)),
      loops,
      edgeCount: edgeSet.size,
      euler,
      errors: chartErrors,
    });
  }

  return {
    cutVertexOfCorner,
    cutOriginalVertex,
    cutCorners,
    faceChart,
    charts,
    errors,
    warnings,
  };
}

export { normEdge };
