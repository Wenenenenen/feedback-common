// svg.js —— 导出只包含保留线段的 SVG

/**
 * @param model buildModel 的结果
 * @param retained computeRetained 的结果
 * @param {{strokeWidth?: number}} opts
 */
export function exportSVG(model, retained, opts = {}) {
  const strokeWidth = opts.strokeWidth ?? 1;
  const { minX, minY, maxX, maxY } = model.bounds;
  const pad = Math.max(2, strokeWidth * 2);
  const w = maxX - minX, h = maxY - minY;
  const parts = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ` +
      `${w + pad * 2} ${h + pad * 2}" width="${w + pad * 2}" height="${h + pad * 2}">`,
    `<rect x="${minX - pad}" y="${minY - pad}" width="${w + pad * 2}" height="${h + pad * 2}" fill="white"/>`,
  );
  for (const st of model.strands) {
    const paths = retained.get(st.id) || [];
    if (paths.length === 0) continue;
    const color = strandColor(st.id, false);
    for (const path of paths) {
      if (path.length < 2) continue;
      const d = path
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`)
        .join(' ');
      parts.push(
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" ` +
          `stroke-linecap="butt" stroke-linejoin="miter" data-strand="${st.id}"/>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** 线条配色：HSL 均匀取色，暗色背景走高明度，SVG 走中等明度。 */
export function strandColor(id, dark) {
  const hue = (id * 47) % 360; // 质数步长，相邻编号色差明显
  const light = dark ? 68 : 42;
  return `hsl(${hue},68%,${light}%)`;
}
