// 导出工具：顶点距离 JSON、等值线段 JSON、计算诊断 JSON。
import { extractIsolines } from './heat-method.js';

export function buildDistanceExport(analysis, result) {
  return {
    type: 'heat-surface-ruler/distances',
    version: 1,
    generatedAt: new Date().toISOString(),
    vertexCount: analysis.nV,
    sources: result.sources,
    tau: result.tau,
    maxDistance: result.maxDistance,
    // null 表示不可达分量上的顶点
    distances: result.distances.map((d) => (d === null ? null : Number(d.toPrecision(10)))),
  };
}

export function buildIsolineExport(analysis, result, spacing) {
  const segments = extractIsolines(result, analysis, spacing);
  return {
    type: 'heat-surface-ruler/isolines',
    version: 1,
    generatedAt: new Date().toISOString(),
    spacing,
    maxDistance: result.maxDistance,
    segmentCount: segments.length,
    levels: [...new Set(segments.map((s) => s.level))].sort((a, b) => a - b),
    segments: segments.map((s) => ({
      level: Number(s.level.toPrecision(10)),
      face: s.face,
      a: s.a.map((c) => Number(c.toPrecision(10))),
      b: s.b.map((c) => Number(c.toPrecision(10))),
    })),
  };
}

export function buildDiagnosticExport(analysis, result, spacing, isoSegments, extra = {}) {
  return {
    type: 'heat-surface-ruler/diagnostics',
    version: 1,
    generatedAt: new Date().toISOString(),
    ...extra,
    tau: result.tau,
    sources: result.sources,
    heatTimePerComponent: result.tPerComponent,
    mesh: {
      vertexCount: analysis.nV,
      faceCount: analysis.nF,
      validFaceCount: analysis.validFaces.length,
      boundaryEdgeCount: analysis.boundaryEdges.length,
      obtuseFaceCount: analysis.obtuseFaces.length,
      nonManifoldReject: false,
    },
    excludedFaces: analysis.excludedFaces,
    obtuseFaces: analysis.obtuseFaces,
    components: result.componentDiagnostics,
    cacheStats: result.cacheStats,
    unreachableVertexCount: result.unreachableCount,
    solveMs: result.solveMs,
    isoline: {
      spacing,
      segmentCount: isoSegments.length,
    },
  };
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
