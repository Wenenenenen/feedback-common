/* 网格 JSON 与细分报告导出 */
(function (global) {
  'use strict';

  const FORMAT_VERSION = '1.0';

  /* 网格：位置全局共享（接缝共用索引），UV/法线/片编号逐角不同 */
  function buildMeshJSON(model, tess, camera, options) {
    return {
      format: 'patch-seam-tessellator/mesh',
      version: FORMAT_VERSION,
      generated_at: new Date().toISOString(),
      parameters: {
        pixel_error: options.pixelError,
        max_depth: options.maxDepth,
      },
      camera: camera.describe(),
      positions: tess.positions.map((p) => [p[0], p[1], p[2]]),
      triangles: tess.triangles.map((t, i) => ({
        id: i,
        patch_id: t.patch,
        position_indices: t.position,
        corner_uv: t.uv.map((uv) => [uv[0], uv[1]]),
        corner_normals: t.normal.map((n) => [n[0], n[1], n[2]]),
        screen_error: t.error,
        over_limit: t.overLimit,
      })),
      seams: model.seams.map((s) => ({
        a: s.a,
        b: s.b,
        reversed: s.reversed,
      })),
    };
  }

  function buildReport(model, tess, camera, options, cancelled) {
    const overLimit = tess
      ? tess.triangles.map((t, i) => (t.overLimit ? i : -1)).filter((i) => i >= 0)
      : [];
    return {
      format: 'patch-seam-tessellator/report',
      version: FORMAT_VERSION,
      generated_at: new Date().toISOString(),
      status: cancelled ? 'cancelled' : 'complete',
      parameters: {
        pixel_error: options.pixelError,
        max_depth: options.maxDepth,
        error_rule:
          '每个三角形在逐角UV重心与三边UV中点共6处求曲面，投影后与三角形三维线性插值投影的最大像素距离',
      },
      camera: camera ? camera.describe() : null,
      summary: tess
        ? {
            patch_count: tess.stats.patchCount,
            seam_count: tess.stats.seamCount,
            vertex_count: tess.stats.vertexCount,
            triangle_count: tess.stats.triangleCount,
            over_limit_triangle_count: tess.stats.overLimitTriangles,
            max_screen_error_px: tess.stats.maxError,
            elapsed_ms: tess.stats.elapsedMs,
          }
        : null,
      patches: tess
        ? tess.patchStats.map((s) => ({
            patch_id: s.id,
            planar: s.planar,
            max_node_depth: s.maxNodeDepth,
            leaf_count: s.leafCount,
            triangle_count: s.triangleCount,
            capped_leaf_count: s.cappedLeaves,
            over_limit_triangle_count: s.overLimitTriangles,
            max_screen_error_px: s.maxError,
            edge_levels: s.edgeLevels,
          }))
        : [],
      seams: model.seams.map((s) => ({
        a: s.a,
        b: s.b,
        reversed: s.reversed,
      })),
      over_limit_triangle_ids: overLimit,
    };
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const api = { buildMeshJSON, buildReport, downloadJSON, FORMAT_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Exporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
