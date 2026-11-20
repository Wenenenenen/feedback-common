import { cross, length, sub } from './vec.js';
import {
  LIMITS,
  type Diagnostic,
  type Edge,
  type Face,
  type ParsedMesh,
  type Vec3Like,
} from './types.js';

type Vec3 = [number, number, number];

interface RawInput {
  vertices: unknown;
  faces: unknown;
  seams?: unknown;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isIndex = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

function err(
  code: Diagnostic['code'],
  message: string,
  elements?: Diagnostic['elements'],
): Diagnostic {
  return { code, severity: 'error', message, elements };
}

function warn(
  code: Diagnostic['code'],
  message: string,
  elements?: Diagnostic['elements'],
): Diagnostic {
  return { code, severity: 'warning', message, elements };
}

/** Normalise an undirected edge so that a < b. */
export function normEdge(a: number, b: number): Edge {
  return a < b ? [a, b] : [b, a];
}

export interface ValidationResult {
  /** Parsed geometry; null only when the structure itself is unusable. */
  mesh: ParsedMesh | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** False when validation found any error, so topology can not be trusted. */
  canProceed: boolean;
}

export interface TopologyMaps {
  /** Undirected edge -> incident faces. */
  edgeFaces: Map<string, number[]>;
  /** Directed edge "a:b" -> face id. */
  directed: Map<string, number>;
  /** Vertex -> incident faces. */
  vertexFaces: Map<number, number[]>;
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function buildTopologyMaps(faces: readonly Face[]): TopologyMaps {
  const edgeFaces = new Map<string, number[]>();
  const directed = new Map<string, number>();
  const vertexFaces = new Map<number, number[]>();
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = edgeKey(a, b);
      const list = edgeFaces.get(key);
      if (list) list.push(fi);
      else edgeFaces.set(key, [fi]);
      directed.set(`${a}:${b}`, fi);
      const vf = vertexFaces.get(a);
      if (vf) vf.push(fi);
      else vertexFaces.set(a, [fi]);
    }
  }
  return { edgeFaces, directed, vertexFaces };
}

/**
 * Parse and validate the raw mesh.
 *
 * Structural problems (bad shapes, indices) stop parsing. Topological problems
 * (degenerate faces, non-manifold edges/vertices, inconsistent orientation,
 * bad seams) are all collected with element locations so the UI can show them.
 */
export function validateInput(raw: unknown): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(err('invalid-input', '输入必须是包含 vertices、faces、seams 的 JSON 对象。'));
    return { mesh: null, errors, warnings, canProceed: false };
  }

  const input = raw as RawInput;

  if (!Array.isArray(input.vertices)) {
    errors.push(err('invalid-input', '缺少 vertices 数组。'));
  }
  if (!Array.isArray(input.faces)) {
    errors.push(err('invalid-input', '缺少 faces 数组。'));
  }
  if (!Array.isArray(input.vertices) || !Array.isArray(input.faces)) {
    return { mesh: null, errors, warnings, canProceed: false };
  }

  const vertexCount = input.vertices.length;
  const faceCount = input.faces.length;

  if (faceCount === 0) {
    errors.push(err('empty-mesh', '网格没有任何三角形面。', { faces: [] }));
    return { mesh: null, errors, warnings, canProceed: false };
  }
  if (faceCount > LIMITS.maxTriangles) {
    errors.push(
      err(
        'triangle-limit',
        `三角形数量 ${faceCount} 超过限制 ${LIMITS.maxTriangles}。`,
        { faces: Array.from({ length: faceCount }, (_, i) => i) },
      ),
    );
    return { mesh: null, errors, warnings, canProceed: false };
  }

  const vertices: Vec3[] = [];
  const badVertices: number[] = [];
  for (let vi = 0; vi < vertexCount; vi++) {
    const v = input.vertices[vi] as unknown;
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !isFiniteNumber(v[0]) ||
      !isFiniteNumber(v[1]) ||
      !isFiniteNumber(v[2]) ||
      Math.abs(v[0]) > LIMITS.maxCoordinate ||
      Math.abs(v[1]) > LIMITS.maxCoordinate ||
      Math.abs(v[2]) > LIMITS.maxCoordinate
    ) {
      badVertices.push(vi);
      vertices.push([0, 0, 0]);
    } else {
      vertices.push([v[0], v[1], v[2]]);
    }
  }
  if (badVertices.length > 0) {
    errors.push(
      err(
        'invalid-vertex',
        `有 ${badVertices.length} 个顶点不是有限的 [x, y, z] 数值。`,
        { vertices: badVertices },
      ),
    );
  }

  const faces: Face[] = [];
  const badFaces: number[] = [];
  const badIndexFaces: number[] = [];
  const badIndexValues: number[] = [];
  const repeatedFaces: number[] = [];
  for (let fi = 0; fi < faceCount; fi++) {
    const f = input.faces[fi] as unknown;
    if (!Array.isArray(f) || f.length !== 3 || !isIndex(f[0]) || !isIndex(f[1]) || !isIndex(f[2])) {
      badFaces.push(fi);
      faces.push([0, 0, 0]);
      continue;
    }
    if (f[0] >= vertexCount || f[1] >= vertexCount || f[2] >= vertexCount) {
      badIndexFaces.push(fi);
      for (const idx of f) if (idx >= vertexCount) badIndexValues.push(idx);
    }
    if (f[0] === f[1] || f[1] === f[2] || f[2] === f[0]) repeatedFaces.push(fi);
    faces.push([f[0], f[1], f[2]]);
  }
  if (badFaces.length > 0) {
    errors.push(
      err('invalid-face', `有 ${badFaces.length} 个面不是三个整数索引。`, { faces: badFaces }),
    );
  }
  if (badIndexFaces.length > 0) {
    errors.push(
      err(
        'invalid-index',
        `有 ${badIndexFaces.length} 个面引用了不存在的顶点（0..${vertexCount - 1}）。`,
        { faces: badIndexFaces, vertices: [...new Set(badIndexValues)].sort((a, b) => a - b) },
      ),
    );
  }
  if (badFaces.length > 0 || badIndexFaces.length > 0) {
    return { mesh: null, errors, warnings, canProceed: false };
  }

  // --- Seams ---
  const rawSeams = input.seams;
  const seamSet = new Set<string>();
  const seams: Edge[] = [];
  const invalidSeamEntries: number[] = [];
  if (rawSeams !== undefined) {
    if (!Array.isArray(rawSeams)) {
      errors.push(err('invalid-input', 'seams 必须是边数组 [[a, b], ...]。'));
      return { mesh: null, errors, warnings, canProceed: false };
    }
    const topology = buildTopologyMaps(faces);
    for (let si = 0; si < rawSeams.length; si++) {
      const s = rawSeams[si] as unknown;
      if (!Array.isArray(s) || s.length !== 2 || !isIndex(s[0]) || !isIndex(s[1])) {
        invalidSeamEntries.push(si);
        continue;
      }
      const [a, b] = s;
      if (a === b) {
        errors.push(
          err('seam-degenerate', `切缝 #${si} 的两个端点相同 (${a}, ${b})。`, { seam: [a, b] }),
        );
        continue;
      }
      if (a >= vertexCount || b >= vertexCount) {
        errors.push(
          err(
            'seam-not-found',
            `切缝 #${si} (${a}, ${b}) 引用了不存在的顶点。`,
            { seam: [a, b] },
          ),
        );
        continue;
      }
      const edge = normEdge(a, b);
      const key = edgeKey(edge[0], edge[1]);
      const incident = topology.edgeFaces.get(key);
      if (!incident) {
        errors.push(
          err(
            'seam-not-found',
            `切缝 #${si} (${a}, ${b}) 不是网格中的边。`,
            { seam: edge },
          ),
        );
        continue;
      }
      if (incident.length > 2) {
        // Already reported as a non-manifold edge; a seam here can't be applied.
        errors.push(
          err(
            'seam-not-found',
            `切缝 #${si} (${a}, ${b}) 位于非流形边上，无法切开。`,
            { seam: edge, edges: [edge] },
          ),
        );
        continue;
      }
      if (seamSet.has(key)) {
        warnings.push(
          warn('duplicate-seam', `切缝 #${si} (${a}, ${b}) 重复，已忽略。`, { seam: edge }),
        );
        continue;
      }
      seamSet.add(key);
      seams.push(edge);
      if (incident.length === 1) {
        warnings.push(
          warn(
            'seam-on-boundary',
            `切缝 #${si} (${a}, ${b}) 已经位于边界上，切开不产生新边界。`,
            { seam: edge, edges: [edge] },
          ),
        );
      }
    }
    if (invalidSeamEntries.length > 0) {
      errors.push(
        err('invalid-input', `seams 中有 ${invalidSeamEntries.length} 项不是整数端点对。`),
      );
    }
  }

  // --- Degenerate faces ---
  const repeatedSet = new Set(repeatedFaces);
  const degenerateFaces: number[] = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const p = vertices[f[0]];
    const q = vertices[f[1]];
    const r = vertices[f[2]];
    const area = length(cross(sub(q, p), sub(r, p))) * 0.5;
    if (!(area >= LIMITS.degenerateArea) || repeatedSet.has(fi)) degenerateFaces.push(fi);
  }
  if (degenerateFaces.length > 0) {
    const repeated = degenerateFaces.filter((fi) => repeatedSet.has(fi));
    const suffix = repeated.length > 0 ? `（其中 ${repeated.length} 个面重复使用同一顶点）` : '';
    errors.push(
      err(
        'degenerate-face',
        `有 ${degenerateFaces.length} 个三角形面积小于 ${LIMITS.degenerateArea}${suffix}。`,
        { faces: degenerateFaces },
      ),
    );
  }

  const topology = buildTopologyMaps(faces);
  const { edgeFaces, directed } = topology;

  // --- Non-manifold edges & orientation ---
  const nonManifoldEdges: Edge[] = [];
  const nonManifoldFaces: number[] = [];
  const wrongOrientationEdges: Edge[] = [];
  const wrongOrientationFaces: number[] = [];
  const seenOrientation = new Set<string>();
  for (const [key, incident] of edgeFaces) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    if (incident.length > 2) {
      nonManifoldEdges.push([a, b]);
      nonManifoldFaces.push(...incident);
      continue;
    }
    if (incident.length === 2) {
      const hasForward = directed.has(`${a}:${b}`);
      const hasBackward = directed.has(`${b}:${a}`);
      if (!(hasForward && hasBackward)) {
        const sig = `${Math.min(...incident)}:${Math.max(...incident)}`;
        if (!seenOrientation.has(sig)) {
          seenOrientation.add(sig);
          wrongOrientationEdges.push([a, b]);
          wrongOrientationFaces.push(...incident);
        }
      }
    }
  }
  if (nonManifoldEdges.length > 0) {
    errors.push(
      err(
        'non-manifold-edge',
        `有 ${nonManifoldEdges.length} 条边被超过两个面共用。`,
        {
          edges: nonManifoldEdges.sort((x, y) => x[0] - y[0] || x[1] - y[1]),
          faces: [...new Set(nonManifoldFaces)].sort((x, y) => x - y),
        },
      ),
    );
  }
  if (wrongOrientationEdges.length > 0) {
    errors.push(
      err(
        'inconsistent-orientation',
        `有 ${wrongOrientationEdges.length} 条边两侧的面方向不一致（未反向遍历）。`,
        {
          edges: wrongOrientationEdges.sort((x, y) => x[0] - y[0] || x[1] - y[1]),
          faces: [...new Set(wrongOrientationFaces)].sort((x, y) => x - y),
        },
      ),
    );
  }

  // --- Vertex fans (bow-tie test) ---
  const badVerticesFan: number[] = [];
  const fansOut: { vertex: number; fans: number[][] }[] = [];
  for (const [vertex, incident] of topology.vertexFaces) {
    if (incident.length < 2) continue;
    // Local adjacency between incident faces: share an edge containing `vertex`.
    const local = new Map<number, number[]>();
    for (const fi of incident) local.set(fi, []);
    for (const fi of incident) {
      const f = faces[fi];
      for (let k = 0; k < 3; k++) {
        if (f[k] !== vertex) continue;
        const otherA = f[(k + 1) % 3];
        const otherB = f[(k + 2) % 3];
        for (const other of [otherA, otherB]) {
          const key = edgeKey(vertex, other);
          const list = edgeFaces.get(key);
          if (!list || list.length < 2) continue;
          for (const fj of list) {
            if (fj !== fi) {
              local.get(fi)!.push(fj);
            }
          }
        }
      }
    }
    const seen = new Set<number>();
    const fans: number[][] = [];
    for (const start of incident) {
      if (seen.has(start)) continue;
      const comp: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nb of local.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      fans.push(comp.sort((a, b) => a - b));
    }
    if (fans.length > 1) {
      badVerticesFan.push(vertex);
      fansOut.push({ vertex, fans: fans.sort((a, b) => a[0] - b[0]) });
    }
  }
  if (badVerticesFan.length > 0) {
    errors.push(
      err(
        'non-manifold-vertex',
        `有 ${badVerticesFan.length} 个顶点周围的邻面被拆成多个扇（蝴蝶顶点）。`,
        {
          vertices: badVerticesFan.sort((a, b) => a - b),
          vertexFans: fansOut.sort((a, b) => a.vertex - b.vertex),
        },
      ),
    );
  }

  const canProceed = errors.length === 0;
  return {
    mesh: { vertices, faces, seams },
    errors,
    warnings,
    canProceed,
  };
}

/** Convenience for callers that only need the mesh to render. */
export function parseVertices(raw: unknown): Vec3[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Vec3[] = [];
  for (const v of raw) {
    if (!Array.isArray(v) || v.length < 3) return null;
    const [x, y, z] = v;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
    out.push([x, y, z]);
  }
  return out;
}

export type { Vec3Like };
