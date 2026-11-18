/*
 * export.js — SVG / JSON 导出
 *
 * 区间判定在求解阶段已与像素分辨率无关地完成；
 * 这里只把 NDC 坐标按导出宽高做线性尺度映射，
 * 因此改变分辨率只改变坐标尺度，不改变任何区间。
 */
(function (global) {
  'use strict';

  const HLM = global.HLM || (global.HLM = {});
  const CAM = HLM.camera;

  function fmt(x) {
    // 保留足够精度，去掉多余尾零
    return Number(x.toFixed(4)).toString();
  }

  /** NDC 点 -> 导出像素坐标（左上原点） */
  function project(ndc, width, height) {
    const [x, y] = CAM.ndcToScreen(ndc, width, height);
    return [x, y];
  }

  function edgeScreenPoints(solved, width, height) {
    const c = solved.clip;
    const p0 = project(c.ndc0, width, height);
    const p1 = project(c.ndc1, width, height);
    // 屏幕位置 = 裁剪端点 + (u 差) * 全裁剪段方向
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const span = c.u1 - c.u0;
    return (iv) => {
      const t0 = (iv.u0 - c.u0) / span;
      const t1 = (iv.u1 - c.u0) / span;
      return {
        a: [p0[0] + dx * t0, p0[1] + dy * t0],
        b: [p0[0] + dx * t1, p0[1] + dy * t1],
      };
    };
  }

  /**
   * 生成 SVG 字符串。
   * 可见实线 / 隐藏虚线分层；非流形边用单独颜色标注。
   */
  function buildSVG(solution, mesh, width, height, options = {}) {
    const dash = options.dash || '7 5';
    const visibleColor = options.visibleColor || '#111827';
    const hiddenColor = options.hiddenColor || '#9ca3af';
    const nonmanifoldColor = options.nonmanifoldColor || '#dc2626';
    const strokeW = options.strokeWidth || Math.max(1, width / 640);

    const visLines = [], hidLines = [], nmLines = [];
    for (const e of solution.edges) {
      if (!e.feature || !e.clip || e.clip.pointProjected) continue;
      const toScreen = edgeScreenPoints(e, width, height);
      const isNM = e.types.nonmanifold;
      for (const iv of e.intervals) {
        const { a, b } = toScreen(iv);
        const line =
          `    <line x1="${fmt(a[0])}" y1="${fmt(a[1])}" ` +
          `x2="${fmt(b[0])}" y2="${fmt(b[1])}" ` +
          `data-edge="${e.edgeId}" data-u0="${fmt(iv.u0)}" data-u1="${fmt(iv.u1)}" ` +
          `data-occluders="${iv.occluderFaceIds.join(',')}"/>`;
        if (isNM) nmLines.push(line);
        else if (iv.visible) visLines.push(line);
        else hidLines.push(line);
      }
    }

    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
        `viewBox="0 0 ${width} ${height}">`,
      `  <rect width="100%" height="100%" fill="white"/>`,
      `  <g id="hidden" stroke="${hiddenColor}" stroke-width="${fmt(strokeW)}" ` +
        `stroke-dasharray="${dash}" fill="none" stroke-linecap="round">`,
      ...hidLines,
      `  </g>`,
      `  <g id="visible" stroke="${visibleColor}" stroke-width="${fmt(strokeW)}" ` +
        `fill="none" stroke-linecap="round">`,
      ...visLines,
      `  </g>`,
      `  <g id="nonmanifold" stroke="${nonmanifoldColor}" stroke-width="${fmt(strokeW * 1.4)}" ` +
        `fill="none" stroke-linecap="round">`,
      ...nmLines,
      `  </g>`,
      `</svg>`,
      '',
    ].join('\n');
  }

  /** 生成区间 JSON（区间与 width/height 无关，仅元数据记录导出尺寸） */
  function buildJSON(solution, mesh, cameraSpec, width, height) {
    return {
      format: 'analytic-hidden-line/1',
      exported_at: new Date().toISOString(),
      resolution: { width, height },
      camera: cameraSpec,
      depth_epsilon: HLM.solver.DEPTH_EPS,
      stats: solution.stats,
      faces: mesh.faces.map(f => ({
        id: f.id,
        verts: f.verts,
        front: f.front,
        degenerate: f.degenerate,
      })),
      edges: solution.edges.map(e => ({
        edge_id: e.edgeId,
        verts: e.verts,
        types: Object.keys(e.types).filter(k => e.types[k]),
        incident_face_ids: e.faceIds,
        clip: e.clip
          ? { u0: e.clip.u0, u1: e.clip.u1,
              point_projected: !!e.clip.pointProjected,
              ndc0: e.clip.ndc0.map(n => Number(n.toFixed(8))),
              ndc1: e.clip.ndc1.map(n => Number(n.toFixed(8))) }
          : null,
        intervals: e.intervals.map(iv => ({
          u0: iv.u0, u1: iv.u1,
          visible: iv.visible,
          occluder_face_ids: iv.occluderFaceIds,
        })),
      })),
    };
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  HLM.exporter = { buildSVG, buildJSON, download, project, edgeScreenPoints };
})(typeof window !== 'undefined' ? window : globalThis);
