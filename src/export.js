/* Export helpers: triangulation, query log, and a self-contained audit report.

   The audit report lets a lighting artist check a layout without the app: every
   tetrahedron with its volume, the hull, the probe table, and one row per query with
   the weights and the radiance that came out. */

'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.TETRA_EXPORT = factory(root.TETRA_CORE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CORE) {
  const round = (v, d) => {
    const m = Math.pow(10, d === undefined ? 6 : d);
    return Math.round(v * m) / m;
  };
  const fmt = (v, d) => {
    const dd = d === undefined ? 6 : d;
    return v === null || v === undefined ? '' : round(v, dd).toFixed(dd);
  };

  function tetVolume(points, t) {
    const v = CORE.detOrientBig(points[t[0]], points[t[1]], points[t[2]], points[t[3]]);
    return Math.abs(Number(v)) / 6;
  }

  /* Triangulation-only JSON: probes, tetrahedra with volumes, hull, validation. */
  function triangulationJSON(project) {
    const { probes, tri } = project;
    const points = probes.map((p) => p.position);
    return {
      format: 'tetra-probe-triangulation',
      version: 1,
      generated: new Date().toISOString(),
      fingerprint: tri.fingerprint,
      probeCount: probes.length,
      probes: probes.map((p, i) => ({
        index: i,
        id: p.id,
        position: p.position.slice(),
        coefficients: p.coefficients.map((c) => c.slice()),
      })),
      tetrahedra: tri.tets.map((t, i) => ({
        index: i,
        probes: t.slice(),
        volume: round(tetVolume(points, t), 4),
      })),
      hull: tri.hull.map((h) => ({ probes: h.tri.slice(), tet: h.tet })),
      validation: {
        ok: tri.validation.ok,
        errors: tri.validation.errors.slice(),
        hullFaces: tri.validation.hullFaces,
        sphereViolations: tri.validation.sphereViolations,
      },
    };
  }

  /* CSV export of the query log. One row per query. */
  function queryCSV(queries) {
    const header = [
      'seq', 'x', 'y', 'z',
      'region', 'category', 'tetrahedron', 'probe_0', 'probe_1', 'probe_2', 'probe_3',
      'w_0', 'w_1', 'w_2', 'w_3',
      'projected_x', 'projected_y', 'projected_z', 'distance',
      'normal_x', 'normal_y', 'normal_z',
      'raw_R', 'raw_G', 'raw_B', 'R', 'G', 'B', 'clamped',
    ];
    const rows = [header.join(',')];
    queries.forEach((q, i) => {
      const w = q.weights || [0, 0, 0, 0];
      const p = q.projected;
      const row = [
        i + 1,
        fmt(q.point[0], 3), fmt(q.point[1], 3), fmt(q.point[2], 3),
        q.region,
        q.category || '',
        (q.tet !== undefined && q.tet !== null) ? q.tet : '',
        ...(q.probes || [0, 0, 0, 0]),
        fmt(w[0], 6), fmt(w[1], 6), fmt(w[2], 6), fmt(w[3], 6),
        p ? fmt(p[0], 3) : '', p ? fmt(p[1], 3) : '', p ? fmt(p[2], 3) : '',
        fmt(q.distance || 0, 4),
        fmt(q.normal[0], 4), fmt(q.normal[1], 4), fmt(q.normal[2], 4),
        fmt(q.raw[0], 5), fmt(q.raw[1], 5), fmt(q.raw[2], 5),
        fmt(q.clamped[0], 5), fmt(q.clamped[1], 5), fmt(q.clamped[2], 5),
        q.negative.some(Boolean) ? 'yes' : 'no',
      ];
      rows.push(row.join(','));
    });
    return rows.join('\n') + '\n';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* Linear-light to sRGB hex for swatches in the report. */
  function toHex(v) {
    const g = Math.round(255 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2));
    return g.toString(16).padStart(2, '0');
  }
  function rgbHex(clamped) {
    return '#' + toHex(clamped[0]) + toHex(clamped[1]) + toHex(clamped[2]);
  }

  /* Self-contained HTML audit report with inline styles so it opens anywhere. */
  function reportHTML(project, queries) {
    const { probes, tri, caseName } = project;
    const points = probes.map((p) => p.position);
    const totalVolume = tri.tets.reduce((s, t) => s + tetVolume(points, t), 0);

    const tetRows = tri.tets.map((t, i) =>
      '<tr><td>' + i + '</td><td>' + t.map((x) => 'P' + x).join(' ') +
      '</td><td class="num">' + round(tetVolume(points, t), 2) + '</td></tr>'
    ).join('');

    const probeRows = probes.map((p, i) =>
      '<tr><td>' + i + '</td><td>' + escapeHTML(p.id) + '</td>' +
      '<td class="num">' + p.position.join(', ') + '</td>' +
      '<td class="num">' + p.coefficients.map(
        (c) => '[' + c.map((x) => round(x, 4)).join(', ') + ']').join('<br>') + '</td></tr>'
    ).join('');

    const queryRows = queries.map((q, i) =>
      '<tr><td>' + (i + 1) + '</td>' +
      '<td class="num">' + q.point.map((x) => round(x, 2)).join(', ') + '</td>' +
      '<td>' + (q.region === 'outside' ? '凸包外（投影）' : '凸包内') + '</td>' +
      '<td>' + (q.tet !== null && q.tet !== undefined ? q.tet : '—') + '</td>' +
      '<td class="num">' + (q.weights || []).map((w) => round(w, 4)).join(' / ') + '</td>' +
      '<td class="num">' + (q.projected
        ? q.projected.map((x) => round(x, 2)).join(', ') + ' · 距 ' + round(q.distance, 2)
        : '—') + '</td>' +
      '<td><span class="swatch" style="background:' + rgbHex(q.clamped) + '"></span>' +
      '<span class="num">' + q.clamped.map((x) => round(x, 3)).join(', ') + '</span></td>' +
      '</tr>'
    ).join('');

    return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>探针插值校验报告 · ' + escapeHTML(caseName || '') + '</title>' +
      '<style>' +
      'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;max-width:980px;margin:40px auto;padding:0 24px;color:#1b1f24;background:#fbfaf7}' +
      'h1{font-size:26px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}' +
      '.meta{color:#5a6068;font-size:13px;margin-bottom:24px}' +
      'table{border-collapse:collapse;width:100%;font-size:12.5px}' +
      'th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #e6e3dc;vertical-align:top}' +
      'th{font-weight:600;color:#5a6068}' +
      '.num{font-variant-numeric:tabular-nums}.swatch{display:inline-block;width:14px;height:14px;border-radius:3px;margin-right:6px;vertical-align:-2px;border:1px solid rgba(0,0,0,.15)}' +
      '.ok{color:#1c7a4b;font-weight:600}.bad{color:#b4372b;font-weight:600}' +
      'ul{margin:4px 0 0;padding-left:20px}code{background:#efece5;padding:1px 5px;border-radius:3px}' +
      '</style></head><body>' +
      '<h1>探针插值校验报告</h1>' +
      '<div class="meta">' + escapeHTML(caseName || '未命名用例') + ' · ' +
      probes.length + ' 个探针 · ' + tri.tets.length + ' 个四面体 · ' +
      tri.validation.hullFaces + ' 个凸包面 · 指纹 <code>' + tri.fingerprint + '</code> · ' +
      new Date().toLocaleString('zh-CN') + '</div>' +
      '<h2>剖分校验</h2><p class="' + (tri.validation.ok ? 'ok' : 'bad') + '">' +
      (tri.validation.ok
        ? '通过：每个探针都参与四面体，共享面成对出现，凸包体积闭合，外接球为空。'
        : '失败：' + tri.validation.errors.map(escapeHTML).join('；')) + '</p>' +
      '<ul><li>四面体体积合计：' + round(totalVolume, 2) + '</li>' +
      '<li>外接球包含其他探针的四面体：' + tri.validation.sphereViolations + '</li>' +
      '<li>剖分由精确整数行列式判定；同一点集在任何输入顺序下指纹一致。</li></ul>' +
      '<h2>探针</h2><table><thead><tr><th>#</th><th>编号</th><th>位置</th><th>系数 [常数, x, y, z] × RGB</th></tr></thead><tbody>' + probeRows + '</tbody></table>' +
      '<h2>四面体</h2><table><thead><tr><th>#</th><th>顶点（探针）</th><th>体积</th></tr></thead><tbody>' + tetRows + '</tbody></table>' +
      '<h2>查询记录</h2><table><thead><tr><th>#</th><th>查询点</th><th>区域</th><th>四面体</th><th>权重</th><th>投影点</th><th>颜色</th></tr></thead><tbody>' + queryRows + '</tbody></table>' +
      '</body></html>\n';
  }

  return { triangulationJSON, queryCSV, reportHTML, escapeHTML, tetVolume };
});
