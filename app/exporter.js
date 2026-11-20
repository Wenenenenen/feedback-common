// 导出 SVG 与 JSON。所有坐标均为物理坐标；改间距后由调用方传入最新几何，
// 因此显示与导出天然同步。
// SVG 约定：只有真正闭环（open=false）写 Z；开放线绝不封口。

function fmt(x) {
  // 紧凑且足够精度的数字格式
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(6)));
}

// 每阈值一种颜色（循环取色），与 UI 保持一致由调用方传入调色板
export function buildSvg(geom, { palette = DEFAULT_PALETTE, imageName = "" } = {}) {
  const allPts = geom.levels.flatMap((lv) => lv.lines.flatMap((l) => l.points));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of allPts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = geom.origin[0]; minY = geom.origin[1];
    maxX = minX + 1; maxY = minY + 1;
  }
  const padX = (maxX - minX || 1) * 0.04;
  const padY = (maxY - minY || 1) * 0.04;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  const width = maxX - minX;
  const height = maxY - minY;
  // SVG 屏幕坐标：X 平移到 0 起；Y 绕包围盒翻转（物理 Y 增大在屏幕上朝上）再平移到正空间
  const sx = (x) => x - minX;
  const sy = (y) => maxY - y;

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  // 导出为屏幕坐标：X 不变，Y 绕包围盒翻转（物理 Y 增大在屏幕上朝上），再平移到正空间。
  // 原始物理坐标与坐标参数完整保留在 JSON 导出中。
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" ` +
    `width="${fmt(width)}" height="${fmt(height)}" ` +
    `data-origin-x="${fmt(geom.origin[0])}" data-origin-y="${fmt(geom.origin[1])}" ` +
    `data-spacing-x="${fmt(geom.spacing[0])}" data-spacing-y="${fmt(geom.spacing[1])}"` +
    (imageName ? ` data-image="${escapeAttr(imageName)}"` : "") + `>`);
  parts.push(`<title>等值线${imageName ? "：" + escapeAttr(imageName) : ""}</title>`);
  parts.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">`);
  geom.levels.forEach((lv, li) => {
    const color = palette[li % palette.length];
    parts.push(`<g data-level="${fmt(lv.level)}" stroke="${color}" stroke-width="${fmt(Math.max(width, height) / 600)}">`);
    for (const line of lv.lines) {
      const d = line.points.map((p, i) =>
        `${i === 0 ? "M" : "L"}${fmt(sx(p[0]) - minX)},${fmt(sy(p[1]) - minY)}`).join("") +
        (line.open ? "" : "Z"); // 仅真正闭环写 Z
      parts.push(`  <path data-id="${escapeAttr(line.id)}" ` +
        `data-open="${line.open}" ` +
        (line.parentId ? `data-parent="${escapeAttr(line.parentId)}" ` : "") +
        `data-points="${line.pointCount}" ` +
        `data-length="${fmt(line.length)}" ` +
        (line.area === null ? "" : `data-area="${fmt(line.area)}" `) +
        `d="${d}"/>`);
    }
    parts.push(`</g>`);
  });
  parts.push(`</g></svg>`);
  return parts.join("\n");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// 结构化 JSON：保留开闭、父环、物理坐标点、长度、面积，以及坐标参数
export function buildJson(geom, meta = {}) {
  return {
    schema: "saddle-contour-atlas/1",
    exportedAt: new Date().toISOString(),
    image: meta.image ?? null,
    mask: meta.mask ?? null,
    grid: {
      nodesX: meta.nodesX ?? null,
      nodesY: meta.nodesY ?? null,
    },
    origin: geom.origin,
    spacing: geom.spacing,
    levels: geom.levels.map((lv) => ({
      level: lv.level,
      lines: lv.lines.map((line) => ({
        id: line.id,
        open: line.open,
        parentId: line.parentId,
        pointCount: line.pointCount,
        points: line.points.map((p) => [round(p[0]), round(p[1])]),
        length: round(line.length),
        area: line.area === null ? null : round(line.area),
      })),
    })),
  };
}

function round(x) {
  // 去除浮点尾差，保留 9 位有效小数
  return Number(x.toFixed(9));
}

export const DEFAULT_PALETTE = [
  "#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed",
  "#0891b2", "#be185d", "#65a30d", "#ea580c", "#4f46e5",
  "#0d9488", "#a16207", "#9d174d", "#15803d", "#1d4ed8",
  "#b91c1c", "#0e7490", "#6d28d9", "#a16207", "#9f1239",
];
