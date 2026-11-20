export type UV = [number, number];
export type Vec3Like = [number, number, number];
export type Edge = [number, number];
export type Face = [number, number, number];
export type Corner = [face: number, corner: number];

export type DiagnosticCode =
  | 'invalid-input'
  | 'invalid-vertex'
  | 'invalid-face'
  | 'invalid-index'
  | 'empty-mesh'
  | 'triangle-limit'
  | 'degenerate-face'
  | 'non-manifold-edge'
  | 'inconsistent-orientation'
  | 'non-manifold-vertex'
  | 'seam-degenerate'
  | 'seam-not-found'
  | 'seam-on-boundary'
  | 'duplicate-seam'
  | 'chart-not-disk'
  | 'boundary-branching'
  | 'degenerate-boundary'
  | 'singular-system'
  | 'solver-failed';

export interface EdgeFaces {
  edge: Edge;
  faces: number[];
}

export interface VertexFans {
  vertex: number;
  fans: number[][];
}

export interface DiagnosticElements {
  faces?: number[];
  vertices?: number[];
  edges?: Edge[];
  seam?: Edge;
  chart?: number;
  loops?: number[][];
  /** Original vertex ids for each boundary loop (parallel to `loops`). */
  loopVertices?: number[][];
  /** Cut vertex ids implicated by the diagnostic. */
  cutVertices?: number[];
  edgeFaces?: EdgeFaces[];
  vertexFans?: VertexFans[];
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  elements?: DiagnosticElements;
}

export interface ParsedMesh {
  vertices: [number, number, number][];
  faces: Face[];
  /** Undirected, normalised (a < b), de-duplicated seams that exist in the mesh. */
  seams: Edge[];
}

export interface CutVertex {
  index: number;
  originalVertex: number;
  /** Original face corners merged into this cut vertex, sorted by (face, corner). */
  corners: Corner[];
  chart: number;
  onBoundary: boolean;
  uv: UV | null;
}

export interface ChartTopology {
  cutVertices: number;
  edges: number;
  faces: number;
  euler: number;
  boundaryLoops: number;
}

export interface InteriorResidual {
  cutVertex: number;
  /** || sum_j w_ij (uv_i - uv_j) || */
  residual: number;
  /** sum_j |w_ij| */
  weightSum: number;
  /** residual / max(1, weightSum) */
  normalized: number;
}

export interface ChartResult {
  index: number;
  valid: boolean;
  faces: number[];
  cutVertices: number[];
  interiorVertices: number[];
  boundaryVertices: number[];
  /** Each loop is an ordered list of cut vertex ids, starting at the smallest id. */
  boundaryLoops: number[][];
  topology: ChartTopology;
  residuals: {
    max: number;
    mean: number;
    interior: InteriorResidual[];
  };
  solver: {
    method: 'none' | 'cg' | 'bicgstab';
    iterations: number;
    converged: boolean;
    relativeResidual: number;
  };
  flippedFaces: number[];
  nearZeroFaces: number[];
  errors: Diagnostic[];
}

export interface ParameterizeStats {
  vertices: number;
  faces: number;
  seams: number;
  cutVertices: number;
  charts: number;
  validCharts: number;
  boundaryLoops: number;
  interiorVertices: number;
  flippedFaces: number;
  nearZeroFaces: number;
  maxResidual: number;
}

export interface Timings {
  totalMs: number;
  validateMs: number;
  splitMs: number;
  solveMs: number;
}

export interface ParameterizeResult {
  valid: boolean;
  input: { vertices: number; faces: number; seams: number };
  errors: Diagnostic[];
  warnings: Diagnostic[];
  stats: ParameterizeStats;
  seams: Edge[];
  cutVertices: CutVertex[];
  charts: ChartResult[];
  /** Chart index per original face, -1 when the face produced no chart (input rejected). */
  faceChart: number[];
  /** Cut vertex index per face corner (corner = 3 * face + corner), -1 when unavailable. */
  cornerCutVertex: number[];
  /** Per face-corner UV (corner = 3 * face + corner); null when the chart is invalid. */
  cornerUV: (UV | null)[];
  timings: Timings;
}

export const LIMITS = {
  maxTriangles: 5000,
  degenerateArea: 1e-12,
  flipDoubleArea: -1e-10,
  nearZeroDoubleArea: 1e-10,
  maxCoordinate: 1e15,
} as const;
