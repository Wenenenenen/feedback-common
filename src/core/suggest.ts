import { splitCharts } from './split.js';
import type { Edge, Face, ParsedMesh } from './types.js';
import { edgeKey, normEdge } from './validate.js';

interface HeapItem {
  vertex: number;
  dist: number;
}

/** Tiny binary min-heap so the suggestion pass stays dependency-free. */
class MinHeap {
  private readonly items: HeapItem[] = [];

  push(item: HeapItem): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].dist <= items[i].dist) break;
      const tmp = items[parent];
      items[parent] = items[i];
      items[i] = tmp;
      i = parent;
    }
  }

  pop(): HeapItem | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && items[l].dist < items[best].dist) best = l;
        if (r < items.length && items[r].dist < items[best].dist) best = r;
        if (best === i) break;
        const tmp = items[best];
        items[best] = items[i];
        items[i] = tmp;
        i = best;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface SeamSuggestion {
  seams: Edge[];
  /** Charts produced when the suggestion is applied. */
  charts: number;
  /** Whether every chart is a topological disk. */
  allDisks: boolean;
  reason: string;
}

function buildAdjacency(vertices: readonly [number, number, number][], faces: readonly Face[]) {
  const adjacency = new Map<number, { to: number; length: number }[]>();
  const push = (a: number, b: number) => {
    const pa = vertices[a];
    const pb = vertices[b];
    const length = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    const list = adjacency.get(a);
    if (list) list.push({ to: b, length });
    else adjacency.set(a, [{ to: b, length }]);
  };
  for (const [a, b, c] of faces) {
    push(a, b);
    push(b, c);
    push(c, a);
  }
  return adjacency;
}

function shortestPath(
  adjacency: Map<number, { to: number; length: number }[]>,
  start: number,
  goal: number,
): number[] | null {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap = new MinHeap();
  dist.set(start, 0);
  heap.push({ vertex: start, dist: 0 });
  const settled = new Set<number>();
  while (heap.size > 0) {
    const cur = heap.pop()!;
    if (settled.has(cur.vertex)) continue;
    settled.add(cur.vertex);
    if (cur.vertex === goal) break;
    for (const { to, length } of adjacency.get(cur.vertex) ?? []) {
      const next = cur.dist + length;
      const known = dist.get(to);
      if (known === undefined || next < known) {
        dist.set(to, next);
        prev.set(to, cur.vertex);
        heap.push({ vertex: to, dist: next });
      }
    }
  }
  if (!dist.has(goal)) return null;
  const path: number[] = [goal];
  let cur = goal;
  while (cur !== start) {
    const parent = prev.get(cur);
    if (parent === undefined) return null;
    path.push(parent);
    cur = parent;
  }
  return path.reverse();
}

function allChartsAreDisks(mesh: ParsedMesh, seams: Edge[]): { charts: number; allDisks: boolean } {
  const result = splitCharts({ ...mesh, seams });
  return {
    charts: result.charts.length,
    allDisks: result.charts.length > 0 && result.charts.every((chart) => chart.errors.length === 0),
  };
}

/**
 * Suggest one cut path that turns every chart into a topological disk.
 *
 * Candidate endpoints are boundary vertices picked by farthest-point sampling,
 * each pair is connected by the shortest edge path over the mesh, and the
 * candidate is accepted only when the resulting topology (checked by the same
 * split pass the solver uses) is all disks. The shortest accepted path wins so
 * the suggestion stays as small as possible.
 */
export function suggestSeamPath(mesh: ParsedMesh): SeamSuggestion {
  const { vertices, faces } = mesh;
  const { charts, allDisks } = allChartsAreDisks(mesh, mesh.seams);
  if (allDisks) {
    return {
      seams: [],
      charts,
      allDisks: true,
      reason: '当前网格已经是圆盘，不需要额外切缝。',
    };
  }

  const incidence = new Map<string, number>();
  for (const [a, b, c] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edgeKey(u, v);
      incidence.set(key, (incidence.get(key) ?? 0) + 1);
    }
  }
  const boundaryVertices = new Set<number>();
  for (const [key, count] of incidence) {
    if (count !== 1) continue;
    const [a, b] = key.split(':').map(Number);
    boundaryVertices.add(a);
    boundaryVertices.add(b);
  }
  const uniqueBoundary = [...boundaryVertices].sort((a, b) => a - b);
  if (uniqueBoundary.length < 2) {
    return {
      seams: [],
      charts,
      allDisks: false,
      reason: '找不到两个边界顶点来放置切缝。',
    };
  }

  // Farthest-point sampling keeps candidates spread over the boundary.
  const picked: number[] = [uniqueBoundary[0]];
  const maxCandidates = Math.min(8, uniqueBoundary.length);
  while (picked.length < maxCandidates) {
    let best = -1;
    let bestDist = -1;
    for (const v of uniqueBoundary) {
      let nearest = Infinity;
      for (const p of picked) {
        const d = Math.hypot(
          vertices[v][0] - vertices[p][0],
          vertices[v][1] - vertices[p][1],
          vertices[v][2] - vertices[p][2],
        );
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = v;
      }
    }
    if (best < 0 || picked.includes(best)) break;
    picked.push(best);
  }

  const adjacency = buildAdjacency(vertices, faces);
  const existing = new Set(mesh.seams.map(([a, b]) => edgeKey(a, b)));
  let bestCandidate: { path: Edge[]; length: number; charts: number } | null = null;

  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const path = shortestPath(adjacency, picked[i], picked[j]);
      if (!path || path.length < 2) continue;
      const pathEdges: Edge[] = [];
      let length = 0;
      for (let k = 0; k + 1 < path.length; k++) {
        const a = path[k];
        const b = path[k + 1];
        pathEdges.push(normEdge(a, b));
        length += Math.hypot(
          vertices[b][0] - vertices[a][0],
          vertices[b][1] - vertices[a][1],
          vertices[b][2] - vertices[a][2],
        );
      }
      const newEdges = pathEdges.filter(([a, b]) => !existing.has(edgeKey(a, b)));
      if (newEdges.length === 0) continue;
      const seams = [...mesh.seams, ...newEdges];
      const check = allChartsAreDisks(mesh, seams);
      if (!check.allDisks) continue;
      if (
        !bestCandidate ||
        check.charts < bestCandidate.charts ||
        (check.charts === bestCandidate.charts && length < bestCandidate.length)
      ) {
        bestCandidate = { path: newEdges, length, charts: check.charts };
      }
    }
  }

  if (!bestCandidate) {
    return {
      seams: [],
      charts,
      allDisks: false,
      reason: '在边界顶点之间找不到能让所有图表成为圆盘的切缝路径；请手动选择切缝。',
    };
  }

  return {
    seams: bestCandidate.path,
    charts: bestCandidate.charts,
    allDisks: true,
    reason: `建议 ${bestCandidate.path.length} 条切缝，切分后得到 ${bestCandidate.charts} 个圆盘图表。`,
  };
}
