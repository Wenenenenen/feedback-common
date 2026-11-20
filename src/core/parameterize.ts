import type { CsrMatrix } from './solver.js';
import { solveSparse } from './solver.js';
import { splitCharts, type ChartBuild } from './split.js';
import {
  LIMITS,
  type ChartResult,
  type CutVertex,
  type Diagnostic,
  type InteriorResidual,
  type ParameterizeResult,
  type ParsedMesh,
  type Timings,
  type UV,
} from './types.js';
import { cotAngle, distance, signedDoubleArea2 } from './vec.js';
import { validateInput } from './validate.js';

interface ChartSolveResult {
  uvs: Map<number, UV>;
  residuals: InteriorResidual[];
  solver: ChartResult['solver'];
  errors: Diagnostic[];
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Cotangent weights: each triangle contributes half the cotangent of the angle
 * opposite each edge, added to the pair of cut vertices at that edge's ends.
 * Negative cotangents are kept as-is (required for concave/obtuse behaviour).
 */
function accumulateWeights(
  mesh: ParsedMesh,
  chart: ChartBuild,
  cutOfCorner: Int32Array,
): { weights: Map<number, Map<number, number>>; nonFinite: number[] } {
  const weights = new Map<number, Map<number, number>>();
  const nonFinite: number[] = [];
  const add = (a: number, b: number, w: number): void => {
    if (a === b || w === 0) return;
    let row = weights.get(a);
    if (!row) {
      row = new Map();
      weights.set(a, row);
    }
    row.set(b, (row.get(b) ?? 0) + w);
  };
  for (const fi of chart.faces) {
    const f = mesh.faces[fi];
    const p = mesh.vertices[f[0]];
    const q = mesh.vertices[f[1]];
    const r = mesh.vertices[f[2]];
    // Corner k is the apex; its opposite edge joins corners k+1 and k+2.
    const opposite: [number, number][] = [
      [cutOfCorner[fi * 3 + 1], cutOfCorner[fi * 3 + 2]],
      [cutOfCorner[fi * 3 + 2], cutOfCorner[fi * 3 + 0]],
      [cutOfCorner[fi * 3 + 0], cutOfCorner[fi * 3 + 1]],
    ];
    const legs: [number, number, number][][] = [
      [p, q, r],
      [q, r, p],
      [r, p, q],
    ];
    for (let k = 0; k < 3; k++) {
      const [apex, one, two] = legs[k];
      const cot = cotAngle(apex, one, two);
      const w = 0.5 * cot;
      if (!Number.isFinite(w)) {
        // A zero-length edge or exactly-collinear corner makes the cotangent
        // infinite. Do not silently drop it: the chart's system is not solvable.
        nonFinite.push(fi);
        continue;
      }
      const [b, c] = opposite[k];
      add(b, c, w);
      add(c, b, w);
    }
  }
  return { weights, nonFinite };
}

/**
 * Place boundary vertices on the unit circle by arc length of the 3D boundary
 * polyline, starting at the loop's first (smallest-id) cut vertex.
 */
function boundaryOnCircle(
  mesh: ParsedMesh,
  cutOriginalVertex: readonly number[],
  loop: readonly number[],
): Map<number, UV> {
  if (loop.length === 0) return new Map();
  const positions = loop.map((cv) => mesh.vertices[cutOriginalVertex[cv]]);
  const cumulative = new Array<number>(loop.length).fill(0);
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    cumulative[i] = total;
    total += distance(positions[i], positions[(i + 1) % loop.length]);
  }
  const uvs = new Map<number, UV>();
  if (!(total > 0) || !Number.isFinite(total)) {
    // Degenerate (zero-length) boundary: all placed at the same point; the chart
    // will be reported as degenerate by the caller.
    for (const cv of loop) uvs.set(cv, [1, 0]);
    return uvs;
  }
  for (let i = 0; i < loop.length; i++) {
    const angle = (2 * Math.PI * cumulative[i]) / total;
    uvs.set(loop[i], [Math.cos(angle), Math.sin(angle)]);
  }
  return uvs;
}

function buildLaplacian(
  interior: readonly number[],
  weights: ReadonlyMap<number, Map<number, number>>,
): { A: CsrMatrix; indexOf: Map<number, number> } {
  const indexOf = new Map<number, number>();
  interior.forEach((v, i) => indexOf.set(v, i));
  const n = interior.length;
  const rowPtr = new Int32Array(n + 1);
  const colIdx: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = interior[i];
    const row = weights.get(v);
    let diag = 0;
    const entries: [number, number][] = [];
    if (row) {
      for (const [j, w] of row) {
        if (j === v) continue;
        diag += w;
        const col = indexOf.get(j);
        if (col !== undefined) entries.push([col, -w]);
      }
    }
    entries.sort((a, b) => a[0] - b[0]);
    for (const [col, value] of entries) {
      colIdx.push(col);
      values.push(value);
    }
    colIdx.push(i);
    values.push(diag);
    rowPtr[i + 1] = colIdx.length;
  }
  return {
    A: {
      n,
      rowPtr,
      colIdx: Int32Array.from(colIdx),
      values: Float64Array.from(values),
    },
    indexOf,
  };
}

function solveChart(
  mesh: ParsedMesh,
  chart: ChartBuild,
  cutOfCorner: Int32Array,
  cutOriginalVertex: readonly number[],
): ChartSolveResult {
  const errors: Diagnostic[] = [];
  const { weights, nonFinite } = accumulateWeights(mesh, chart, cutOfCorner);
  const loop = chart.loops[0];
  if (nonFinite.length > 0) {
    errors.push({
      code: 'singular-system',
      severity: 'error',
      message:
        `图表 ${chart.index} 的余切权重出现非有限值（${new Set(nonFinite).size} 个面中有零长边或共线角），方程奇异，无法求解。`,
      elements: { chart: chart.index, faces: [...new Set(nonFinite)].sort((a, b) => a - b) },
    });
    return {
      uvs: new Map(),
      residuals: [],
      solver: { method: 'none', iterations: 0, converged: false, relativeResidual: Infinity },
      errors,
    };
  }
  const boundaryUV = boundaryOnCircle(mesh, cutOriginalVertex, loop);
  const boundarySet = new Set(loop);
  const interior = chart.cutVertices.filter((v) => !boundarySet.has(v));
  const uvs = new Map<number, UV>(boundaryUV);

  if (interior.length === 0) {
    return {
      uvs,
      residuals: [],
      solver: { method: 'none', iterations: 0, converged: true, relativeResidual: 0 },
      errors,
    };
  }

  const { A } = buildLaplacian(interior, weights);
  const n = interior.length;
  const rhsX = new Float64Array(n);
  const rhsY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const row = weights.get(interior[i]);
    if (!row) continue;
    for (const [j, w] of row) {
      if (!boundarySet.has(j)) continue;
      const target = boundaryUV.get(j);
      if (!target) continue;
      rhsX[i] += w * target[0];
      rhsY[i] += w * target[1];
    }
  }

  const solvedX = solveSparse(A, rhsX, { tolerance: 1e-13 });
  const solvedY = solveSparse(A, rhsY, { tolerance: 1e-13 });
  const relativeResidual = Math.max(solvedX.relativeResidual, solvedY.relativeResidual);
  const converged = solvedX.converged && solvedY.converged;
  const method = solvedX.method === 'none' ? solvedY.method : solvedX.method;
  const iterations = Math.max(solvedX.iterations, solvedY.iterations);

  for (let i = 0; i < n; i++) {
    uvs.set(interior[i], [solvedX.x[i], solvedY.x[i]]);
  }

  if (!converged) {
    errors.push({
      code: 'solver-failed',
      severity: 'error',
      message:
        `图表 ${chart.index} 的内部 UV 求解未在容差内收敛（相对残差 ${relativeResidual.toExponential(2)}）。` +
        ' 余切权重可能退化（共线三角形或极钝角）。',
      elements: { chart: chart.index, cutVertices: interior },
    });
  }

  // Residuals of the *reported* solution:
  // ||sum_j w_ij (uv_i - uv_j)|| / max(1, sum_j |w_ij|).
  const residuals: InteriorResidual[] = [];
  let maxResidual = 0;
  for (const v of interior) {
    const uv = uvs.get(v)!;
    const row = weights.get(v);
    let rx = 0;
    let ry = 0;
    let weightSum = 0;
    if (row) {
      for (const [j, w] of row) {
        const other = uvs.get(j);
        if (!other) continue;
        rx += w * (uv[0] - other[0]);
        ry += w * (uv[1] - other[1]);
        weightSum += Math.abs(w);
      }
    }
    const residual = Math.hypot(rx, ry);
    const normalized = residual / Math.max(1, weightSum);
    residuals.push({ cutVertex: v, residual, weightSum, normalized });
    if (normalized > maxResidual) maxResidual = normalized;
  }
  residuals.sort((a, b) => b.normalized - a.normalized || a.cutVertex - b.cutVertex);

  if (converged && maxResidual > 1e-8) {
    errors.push({
      code: 'solver-failed',
      severity: 'error',
      message:
        `图表 ${chart.index} 已解出，但方程残差仍过大（归一化最大值 ${maxResidual.toExponential(2)}）。`,
      elements: {
        chart: chart.index,
        cutVertices: residuals.slice(0, 12).map((r) => r.cutVertex),
      },
    });
  }

  return {
    uvs,
    residuals,
    solver: { method, iterations, converged, relativeResidual },
    errors,
  };
}

export function parameterize(raw: unknown): ParameterizeResult {
  const t0 = now();
  const validation = validateInput(raw);
  const validateMs = now() - t0;
  const rawObj = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const input = {
    vertices: Array.isArray(rawObj.vertices) ? rawObj.vertices.length : 0,
    faces: Array.isArray(rawObj.faces) ? rawObj.faces.length : 0,
    seams: Array.isArray(rawObj.seams) ? rawObj.seams.length : 0,
  };

  const errors: Diagnostic[] = [...validation.errors];
  const warnings: Diagnostic[] = [...validation.warnings];

  const timings: Timings = { totalMs: 0, validateMs, splitMs: 0, solveMs: 0 };
  const finish = (
    partial: Omit<ParameterizeResult, 'valid' | 'input' | 'errors' | 'warnings' | 'timings'>,
  ): ParameterizeResult => ({
    valid: partial.charts.length > 0 && errors.length === 0,
    input,
    errors,
    warnings,
    ...partial,
    timings: { ...timings, totalMs: now() - t0 },
  });

  if (!validation.mesh) {
    return finish({
      stats: {
        vertices: input.vertices,
        faces: input.faces,
        seams: 0,
        cutVertices: 0,
        charts: 0,
        validCharts: 0,
        boundaryLoops: 0,
        interiorVertices: 0,
        flippedFaces: 0,
        nearZeroFaces: 0,
        maxResidual: 0,
      },
      seams: [],
      cutVertices: [],
      charts: [],
      faceChart: new Array<number>(input.faces).fill(-1),
      cornerCutVertex: new Array<number>(input.faces * 3).fill(-1),
      cornerUV: new Array<UV | null>(input.faces * 3).fill(null),
    });
  }

  const mesh: ParsedMesh = validation.mesh;
  const tSplit = now();
  const split = splitCharts(mesh);
  timings.splitMs = now() - tSplit;
  warnings.push(...split.warnings);

  const cutVertices: CutVertex[] = split.cutCorners.map((corners, index) => ({
    index,
    originalVertex: split.cutOriginalVertex[index],
    corners,
    chart: split.faceChart[corners[0][0]] ?? -1,
    onBoundary: false,
    uv: null,
  }));
  const cutOfCorner = Int32Array.from(split.cutVertexOfCorner);
  const cornerUV: (UV | null)[] = new Array<UV | null>(mesh.faces.length * 3).fill(null);

  // Input rejected: report topology diagnostics but never pretend to solve.
  const inputRejected = validation.errors.length > 0;
  const tSolve = now();
  const charts: ChartResult[] = [];
  let totalBoundaryLoops = 0;
  let totalInterior = 0;
  let flippedFaces = 0;
  let nearZeroFaces = 0;
  let maxResidual = 0;

  for (let ci = 0; ci < split.charts.length; ci++) {
    const chart = split.charts[ci];
    const chartErrors = [...chart.errors];
    let chartUv = new Map<number, UV>();
    let residuals: InteriorResidual[] = [];
    let solver: ChartResult['solver'] = {
      method: 'none',
      iterations: 0,
      converged: true,
      relativeResidual: 0,
    };

    if (!inputRejected && chart.errors.length === 0) {
      const solve = solveChart(mesh, chart, cutOfCorner, split.cutOriginalVertex);
      chartErrors.push(...solve.errors);
      chartUv = solve.uvs;
      residuals = solve.residuals;
      solver = solve.solver;
    }
    // When the input was rejected upstream the top-level diagnostics already
    // explain why; charts stay invalid (no UV) without duplicating the reason.

    // Flip / near-zero classification uses the UV double area in *chart* order.
    const flipped: number[] = [];
    const nearZero: number[] = [];
    for (const fi of chart.faces) {
      if (chartUv.size === 0) break;
      const a = chartUv.get(cutOfCorner[fi * 3 + 0]);
      const b = chartUv.get(cutOfCorner[fi * 3 + 1]);
      const c = chartUv.get(cutOfCorner[fi * 3 + 2]);
      if (!a || !b || !c) continue;
      const area2 = signedDoubleArea2(a, b, c);
      if (area2 < LIMITS.flipDoubleArea) flipped.push(fi);
      else if (Math.abs(area2) <= LIMITS.nearZeroDoubleArea) nearZero.push(fi);
    }
    flippedFaces += flipped.length;
    nearZeroFaces += nearZero.length;

    let chartMax = 0;
    let sum = 0;
    for (const r of residuals) {
      chartMax = Math.max(chartMax, r.normalized);
      sum += r.normalized;
    }
    const mean = residuals.length > 0 ? sum / residuals.length : 0;
    maxResidual = Math.max(maxResidual, chartMax);

    const valid = chartErrors.length === 0 && chartUv.size > 0;
    const boundarySet = new Set(chart.boundary);
    for (const cv of chart.cutVertices) {
      const vertex = cutVertices[cv];
      vertex.chart = ci;
      vertex.onBoundary = boundarySet.has(cv);
      const uv = chartUv.get(cv);
      if (uv) {
        vertex.uv = [uv[0], uv[1]];
        for (const [face, corner] of vertex.corners) cornerUV[face * 3 + corner] = uv;
      }
    }

    charts.push({
      index: ci,
      valid,
      faces: chart.faces,
      cutVertices: chart.cutVertices,
      interiorVertices: chart.interior,
      boundaryVertices: chart.boundary,
      boundaryLoops: chart.loops,
      topology: {
        cutVertices: chart.cutVertices.length,
        edges: chart.edgeCount,
        faces: chart.faces.length,
        euler: chart.euler,
        boundaryLoops: chart.loops.length,
      },
      residuals: { max: chartMax, mean, interior: residuals },
      solver,
      flippedFaces: flipped,
      nearZeroFaces: nearZero,
      errors: chartErrors,
    });
    errors.push(...chartErrors);
    totalBoundaryLoops += chart.loops.length;
    totalInterior += chart.interior.length;
  }
  timings.solveMs = now() - tSolve;

  return finish({
    stats: {
      vertices: mesh.vertices.length,
      faces: mesh.faces.length,
      seams: mesh.seams.length,
      cutVertices: cutVertices.length,
      charts: charts.length,
      validCharts: charts.filter((c) => c.valid).length,
      boundaryLoops: totalBoundaryLoops,
      interiorVertices: totalInterior,
      flippedFaces,
      nearZeroFaces,
      maxResidual,
    },
    seams: mesh.seams,
    cutVertices,
    charts,
    faceChart: split.faceChart,
    cornerCutVertex: split.cutVertexOfCorner,
    cornerUV,
  });
}

export { validateInput };
