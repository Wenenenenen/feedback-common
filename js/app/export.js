/* 碎片结果导出：位置、单位法线、所属单元、原面编号。纯浏览器端，无外部依赖。 */
(function (global) {
  'use strict';

  function round6(x) {
    // 容差 1e-6：去掉浮点尾噪，保留 7 位有效小数
    const v = Math.abs(x) < 5e-10 ? 0 : x;
    return Number(v.toFixed(7));
  }
  function r3(p) { return [round6(p[0]), round6(p[1]), round6(p[2])]; }

  /**
   * 构造导出对象。
   * @param result worker 返回的 payload
   * @param mode 'deformed'（变形后位置+法线，默认）| 'rest'（原始位置+插值法线）
   */
  function buildExport(result, mode) {
    const useDeformed = mode !== 'rest';
    const records = [];
    for (const fr of result.fragments) {
      const positions = fr.vertIds.map(id => {
        const gv = result.verts[id];
        return r3(useDeformed ? gv.deformed : gv.rest);
      });
      let normals;
      if (useDeformed) {
        normals = fr.deformedNormals.map(r3);
      } else {
        // rest 姿态：直接归一化插值后的角法线
        normals = fr.cornerNormals.map(n => {
          const l = Math.hypot(n[0], n[1], n[2]) || 1;
          return r3([n[0] / l, n[1] / l, n[2] / l]);
        });
      }
      records.push({
        originFace: fr.faceId,
        cell: fr.cellId,
        positions,
        normals,
        area: round6(fr.area),
      });
    }
    return {
      schema: 'tetra-cage-fragments/1',
      mode: useDeformed ? 'deformed' : 'rest',
      generatedAt: new Date().toISOString(),
      counts: {
        fragments: records.length,
        rejectedFaces: result.badFaces.length,
        rejectedCells: result.badCells.length,
      },
      rejectedFaces: result.badFaces,
      rejectedCells: result.badCells,
      fragments: records,
    };
  }

  function toJSON(result, mode) {
    return JSON.stringify(buildExport(result, mode), null, 2);
  }

  function download(result, mode, filename) {
    const text = toJSON(result, mode);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || ('fragments-' + mode + '.json');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const api = { buildExport, toJSON, download, round6 };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; global.TCExport = api; }
  else global.TCExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
