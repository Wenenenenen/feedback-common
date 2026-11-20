import type { Diagnostic, ParameterizeResult, UV } from './types.js';
import type { Edge } from './types.js';

const round = (v: number, digits = 9): number => {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

const roundUV = (uv: UV | null, digits = 9): [number, number] | null =>
  uv ? [round(uv[0], digits), round(uv[1], digits)] : null;

export interface ExportOptions {
  digits?: number;
}

/**
 * Export per-corner UVs, the split-vertex correspondence and diagnostics as a
 * single JSON object. Face-corner order is the input order: corner c of face f
 * is at index 3 * f + c.
 */
export function buildExportJson(result: ParameterizeResult, options: ExportOptions = {}) {
  const digits = options.digits ?? 9;
  const { faces } = result.input;

  const charts = result.charts.map((chart) => ({
    chart: chart.index,
    valid: chart.valid,
    faces: chart.faces,
    cutVertices: chart.cutVertices,
    interiorVertices: chart.interiorVertices,
    boundaryVertices: chart.boundaryVertices,
    boundaryLoops: chart.boundaryLoops,
    topology: {
      cutVertices: chart.topology.cutVertices,
      edges: chart.topology.edges,
      faces: chart.topology.faces,
      euler: chart.topology.euler,
      boundaryLoops: chart.topology.boundaryLoops,
      eulerCheck: chart.topology.euler === 1 && chart.topology.boundaryLoops === 1,
    },
    flippedFaces: chart.flippedFaces,
    nearZeroFaces: chart.nearZeroFaces,
    residuals: {
      max: round(chart.residuals.max, 12),
      mean: round(chart.residuals.mean, 12),
      interior: chart.residuals.interior.map((r) => ({
        cutVertex: r.cutVertex,
        residual: r.residual,
        weightSum: round(r.weightSum, digits),
        normalized: r.normalized,
      })),
    },
    solver: {
      method: chart.solver.method,
      iterations: chart.solver.iterations,
      converged: chart.solver.converged,
      relativeResidual: chart.solver.relativeResidual,
    },
    errors: chart.errors,
  }));

  const cutVertices = result.cutVertices.map((cv) => ({
    cutVertex: cv.index,
    originalVertex: cv.originalVertex,
    chart: cv.chart,
    onBoundary: cv.onBoundary,
    corners: cv.corners,
    uv: roundUV(cv.uv, digits),
  }));

  // Original vertices that were split into more than one cut vertex, with the
  // full correspondence between the original vertex and the pieces.
  const byOriginal = new Map<number, typeof result.cutVertices>();
  for (const cv of result.cutVertices) {
    const list = byOriginal.get(cv.originalVertex);
    if (list) list.push(cv);
    else byOriginal.set(cv.originalVertex, [cv]);
  }
  const splitMap = [...byOriginal]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([originalVertex, list]) => ({
      originalVertex,
      cutVertices: list.map((cv) => ({
        cutVertex: cv.index,
        chart: cv.chart,
        onBoundary: cv.onBoundary,
        corners: cv.corners,
        uv: roundUV(cv.uv, digits),
      })),
    }));

  const perCorner = Array.from({ length: faces }, (_, fi) =>
    [0, 1, 2].map((corner) => {
      const idx = fi * 3 + corner;
      return {
        face: fi,
        corner,
        cutVertex: result.cornerCutVertex[idx] ?? -1,
        uv: roundUV(result.cornerUV[idx] ?? null, digits),
      };
    }),
  );

  const seams: Edge[] = result.seams.map(([a, b]) => [a, b]);

  return {
    format: 'cut-chart-parameterizer/v1',
    valid: result.valid,
    input: result.input,
    seams,
    stats: {
      ...result.stats,
      maxResidual: result.stats.maxResidual,
    },
    timings: {
      totalMs: round(result.timings.totalMs, 3),
      validateMs: round(result.timings.validateMs, 3),
      splitMs: round(result.timings.splitMs, 3),
      solveMs: round(result.timings.solveMs, 3),
    },
    charts,
    cutVertices,
    splitVertices: splitMap,
    perCornerUV: perCorner,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export type ExportJson = ReturnType<typeof buildExportJson>;

function compact(value: unknown): string {
  return JSON.stringify(value);
}

/** Also emit a plain [u, v, u, v, ...] stream in face-corner order for DCC tools. */
export function buildCornerUvStream(result: ParameterizeResult, digits = 9): number[] {
  const out: number[] = [];
  for (let i = 0; i < result.cornerUV.length; i++) {
    const uv = result.cornerUV[i];
    out.push(uv ? round(uv[0], digits) : 0, uv ? round(uv[1], digits) : 0);
  }
  return out;
}

export function exportFileName(prefix = 'cut-chart'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${prefix}-${stamp}.json`;
}

export function diagnosticsToText(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const loc: string[] = [];
      const e = d.elements;
      if (e?.chart !== undefined) loc.push(`chart ${e.chart}`);
      if (e?.faces?.length) loc.push(`faces [${e.faces.join(', ')}]`);
      if (e?.vertices?.length) loc.push(`vertices [${e.vertices.join(', ')}]`);
      if (e?.edges?.length) loc.push(`edges [${e.edges.map((x) => `(${x[0]},${x[1]})`).join(', ')}]`);
      if (e?.cutVertices?.length) loc.push(`cutVertices [${e.cutVertices.join(', ')}]`);
      return `[${d.severity}] ${d.code}: ${d.message}${loc.length ? ` — ${loc.join('; ')}` : ''}`;
    })
    .join('\n');
}

export { compact };
