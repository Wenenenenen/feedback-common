/**
 * Export helpers: SVG of the 2-D section in millimetres and a JSON report.
 * SJON follows the schema documented in README.md.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function fmt(n, digits = 6) {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
}

/**
 * Build an SVG string where one user unit == one millimetre.
 * @param {object} section sliceMesh() result
 * @param {{label?: string, includeOpen?: boolean}} [options]
 */
export function sectionToSvg(section, options = {}) {
  if (!section || section.empty || section.loops.length === 0) {
    return null;
  }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const loop of section.loops) {
    for (const p of loop.points2d) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
  }
  if (!Number.isFinite(minx)) return null;
  const pad = Math.max(2, Math.max(maxx - minx, maxy - miny) * 0.02);
  // SVG y grows downward; flip so the drawing reads like the canvas, in mm.
  const width = maxx - minx + pad * 2;
  const height = maxy - miny + pad * 2;
  const vbX = minx - pad;
  const vbY = -(maxy + pad);

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<svg xmlns="${SVG_NS}" version="1.1" width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="${fmt(vbX, 9)} ${fmt(vbY, 9)} ${fmt(width, 9)} ${fmt(height, 9)}" ` +
    `data-unit="mm" data-plane-d-mm="${fmt(section.plane.dNormalized, 9)}">`,
  );
  parts.push(
    `<title>${escapeXml(options.label || 'section')}</title>`,
  );
  parts.push(
    `<desc>${escapeXml(
      `plane n·p=d with n=(${section.plane.nUnit.map((x) => fmt(x, 9)).join(', ')}) ` +
      `d=${fmt(section.plane.dNormalized, 9)} mm; units mm; ` +
      `material on left of loop walk; solid loops CCW, holes CW`,
    )}</desc>`,
  );
  // Millimetre grid: fine 1 mm, bold 10 mm, for inspection at 1:1.
  parts.push('<g id="grid" stroke="#d8dee9" stroke-width="0.05" fill="none">');
  for (let x = Math.ceil(minx); x <= maxx; x += 1) {
    const strong = x % 10 === 0;
    parts.push(
      `<line x1="${fmt(x)}" y1="${fmt(-maxy)}" x2="${fmt(x)}" y2="${fmt(-miny)}"` +
      ` stroke="${strong ? '#b8c2d4' : '#e6eaf1'}" stroke-width="${strong ? '0.12' : '0.04'}"/>`,
    );
  }
  for (let y = Math.ceil(miny); y <= maxy; y += 1) {
    const strong = y % 10 === 0;
    parts.push(
      `<line x1="${fmt(minx)}" y1="${fmt(-y)}" x2="${fmt(maxx)}" y2="${fmt(-y)}"` +
      ` stroke="${strong ? '#b8c2d4' : '#e6eaf1'}" stroke-width="${strong ? '0.12' : '0.04'}"/>`,
    );
  }
  parts.push('</g>');

  parts.push('<g id="loops" fill="none" stroke-linejoin="round" stroke-linecap="round">');
  for (const loop of section.loops) {
    if (loop.kind === 'open' && options.includeOpen === false) continue;
    const cls = loop.kind; // solid | hole | open
    let d = '';
    const pts = loop.points2d;
    for (let i = 0; i < pts.length; i++) {
      d += (i === 0 ? 'M' : 'L') + fmt(pts[i][0], 9) + ' ' + fmt(-pts[i][1], 9);
    }
    if (loop.closed) d += 'Z';
    const attrs =
      cls === 'solid'
        ? 'stroke="#1f6feb" stroke-width="0.35"'
        : cls === 'hole'
          ? 'stroke="#c2410c" stroke-width="0.35"'
          : 'stroke="#b91c1c" stroke-width="0.3" stroke-dasharray="1 0.6"';
    parts.push(
      `<path class="${cls}" data-body="${loop.bodyId ?? ''}" data-owner="${loop.ownerBodyId ?? ''}" ` +
      `data-area-mm2="${loop.area_mm2 == null ? '' : fmt(loop.area_mm2, 9)}" ` +
      `data-perimeter-mm="${fmt(loop.perimeter_mm, 9)}" d="${d}" ${attrs}/>`,
    );
  }
  parts.push('</g>');

  // A scale bar: 10 mm at 1 unit = 1 mm.
  const barLen = 10;
  const barX = minx + pad * 0.2;
  const barY = -miny - pad * 0.45;
  parts.push(
    `<g id="scale-bar" stroke="#334155" stroke-width="0.15" fill="none">` +
    `<line x1="${fmt(barX)}" y1="${fmt(barY)}" x2="${fmt(barX + barLen)}" y2="${fmt(barY)}"/>` +
    `<line x1="${fmt(barX)}" y1="${fmt(barY - 0.8)}" x2="${fmt(barX)}" y2="${fmt(barY + 0.8)}"/>` +
    `<line x1="${fmt(barX + barLen)}" y1="${fmt(barY - 0.8)}" x2="${fmt(barX + barLen)}" y2="${fmt(barY + 0.8)}"/>` +
    `</g>`,
  );
  parts.push(
    `<text x="${fmt(barX)}" y="${fmt(barY + 2.4)}" font-size="2" fill="#334155" ` +
    `font-family="sans-serif">${barLen} mm</text>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON report. Field names are stable: plane, loops2d (rings), intersections3d
 * (the 3-D cut points of every ring), hole ownership and measurements.
 */
export function sectionToJson(section, meshMeta, params = {}) {
  const loops = section.loops.map((l) => ({
    id: l.id,
    kind: l.kind,
    closed: l.closed,
    body_id: l.bodyId,
    hole_owner_body_id: l.ownerBodyId,
    area_mm2: l.area_mm2,
    perimeter_mm: l.perimeter_mm,
    // 2-D ring in the plane's orthonormal basis, millimetres.
    ring_2d_mm: l.points2d.map((p) => [+p[0].toFixed(9), +p[1].toFixed(9)]),
    // Same vertices in model coordinates (3-D intersection points), mm.
    intersections_3d_mm: l.points3d.map((p) => [+p[0].toFixed(9), +p[1].toFixed(9), +p[2].toFixed(9)]),
  }));
  return {
    schema: 'mesh-section-report/1',
    generated_at: new Date().toISOString(),
    units: 'mm',
    model: meshMeta
      ? {
          name: meshMeta.name,
          source: meshMeta.source,
          format: meshMeta.format,
          triangle_count: meshMeta.triangleCount,
          welded_vertex_count: meshMeta.weldedVertexCount,
          bbox_mm: meshMeta.bbox,
          diagnostics: params.diagnostics || null,
        }
      : null,
    plane: {
      n: section.plane.n,
      d: section.plane.d,
      n_unit: section.plane.nUnit.map((x) => +x.toFixed(12)),
      d_normalized: +section.plane.dNormalized.toFixed(12),
      origin_mm: section.plane.origin.map((x) => +x.toFixed(9)),
      basis_u: section.plane.u.map((x) => +x.toFixed(12)),
      basis_v: section.plane.v.map((x) => +x.toFixed(12)),
      convention: 'section is the limit approaching the plane along +n; u×v=n',
    },
    convention: {
      solid_loop_winding: 'ccw (positive signed area, material on the left)',
      hole_loop_winding: 'cw (negative signed area)',
      separate_parts: 'grouped by 3-D mesh connected component',
    },
    bodies: section.bodies,
    measurements: section.measurements,
    warnings: section.warnings,
    loops,
  };
}

/** Trigger a browser download for a generated string or blob. */
export function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
