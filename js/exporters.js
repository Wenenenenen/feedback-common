// 独立“符号图”SVG 导出（无 DOM 依赖，返回字符串，浏览器/Node 均可调用）
import { cellId, orientedVector } from './directors.js';
import { compColor, COLORS } from './palette.js';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function buildSymbolSVG(model, flips, options = {}) {
  const cell = options.cell || 40;
  const pad = 28;
  const W = model.width, H = model.height;
  const gridW = pad * 2 + W * cell;
  const pw = Math.max(gridW, 760);
  const ph = pad * 2 + H * cell + 40;
  const cx = (x) => pad + (x + 0.5) * cell;
  const cy = (y) => pad + (y + 0.5) * cell;
  const effective = options.anchors || null; // Map(compId -> anchor)
  const showComp = options.showComp !== false;

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}" font-family="ui-sans-serif, system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif">`);
  parts.push(`<defs>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="6.4" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L7,3 L0,6 Z" fill="${COLORS.ink}"/>
    </marker>
    <marker id="ahb" markerWidth="9" markerHeight="9" refX="6.6" refY="3.2" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L7,3.2 L0,6.4 Z" fill="${COLORS.bad}"/>
    </marker>
    <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="7" height="7" fill="${COLORS.spaceFill}"/>
      <line x1="0" y1="0" x2="0" y2="7" stroke="#dde3ee" stroke-width="2"/>
    </pattern>
  </defs>`);
  parts.push(`<rect x="0" y="0" width="${pw}" height="${ph}" fill="#ffffff"/>`);
  parts.push(`<text x="${pad}" y="20" font-size="14" font-weight="700" fill="${COLORS.ink}">纤维方向符号图 · ${W}×${H} · 违反总代价 ${options.totalCost ?? ''}</text>`);

  // 分量底色 + 空格
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = model.cells[cellId(x, y, W)];
      const rx = pad + x * cell + 1.5, ry = pad + y * cell + 1.5, s = cell - 3;
      if (!c) {
        parts.push(`<rect x="${rx}" y="${ry}" width="${s}" height="${s}" rx="6" fill="url(#hatch)" stroke="${COLORS.spaceLine}" stroke-dasharray="3 3"/>`);
        continue;
      }
      if (showComp) {
        const cid = model.compOfNode[c.i];
        parts.push(`<rect x="${rx}" y="${ry}" width="${s}" height="${s}" rx="6" fill="${compColor(cid)}" fill-opacity="0.08" stroke="${compColor(cid)}" stroke-opacity="0.35"/>`);
      }
    }
  }

  const badSet = new Set(options.violatedEdges || []);
  // 边
  for (const e of model.edges) {
    const x1 = cx(e.ax), y1 = cy(e.ay), x2 = cx(e.bx), y2 = cy(e.by);
    if (badSet.has(e.id)) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const gap = cell * 0.2;
      parts.push(`<line x1="${x1 + ux * gap * 0.4}" y1="${y1 + uy * gap * 0.4}" x2="${mx - ux * gap}" y2="${my - uy * gap}" stroke="${COLORS.bad}" stroke-width="2.4" stroke-dasharray="5 3" marker-end="url(#ahb)" opacity="0.9"/>`);
      parts.push(`<line x1="${x2 - ux * gap * 0.4}" y1="${y2 - uy * gap * 0.4}" x2="${mx + ux * gap}" y2="${my + uy * gap}" stroke="${COLORS.bad}" stroke-width="2.4" stroke-dasharray="5 3" marker-end="url(#ahb)" opacity="0.9"/>`);
      parts.push(`<circle cx="${mx}" cy="${my}" r="${cell * 0.17}" fill="#fff" stroke="${COLORS.bad}" stroke-width="2"/>`);
      parts.push(`<text x="${mx}" y="${my + cell * 0.085}" text-anchor="middle" font-size="${cell * 0.26}" font-weight="700" fill="${COLORS.bad}">✕</text>`);
    } else if (options.edges !== false) {
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.edgeOk}" stroke-width="1.6" opacity="0.55"/>`);
    }
  }

  // 箭头
  const L = cell * 0.30;
  for (const c of model.cells) {
    if (!c) continue;
    const s = flips[c.i];
    const [ox, oy] = orientedVector(c.dx, c.dy, s);
    const norm = Math.hypot(ox, oy) || 1;
    const ux = ox / norm, uy = oy / norm;
    const x = cx(c.x), y = cy(c.y);
    const q = Math.sqrt(c.conf / 255);
    const alpha = 0.6 + 0.4 * q;
    const sw = 1.5 + 2.2 * q;
    parts.push(`<line x1="${x - ux * L * 0.72}" y1="${y - uy * L * 0.72}" x2="${x + ux * L}" y2="${y + uy * L}" stroke="${COLORS.ink}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" marker-end="url(#ah)" opacity="${alpha.toFixed(2)}"/>`);
  }

  // 锚点 / 默认 root
  model.components.forEach((comp, cid) => {
    const a = effective ? effective.get(cid) : null;
    const target = a ? model.cells[a.i] : model.cells[comp.root];
    if (!target) return;
    const x = cx(target.x) + cell * 0.32, y = cy(target.y) - cell * 0.32;
    if (a) {
      parts.push(`<circle cx="${x}" cy="${y}" r="8.5" fill="${COLORS.anchor}" stroke="#fff" stroke-width="2"/>`);
      parts.push(`<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${a.sign > 0 ? '+' : '−'}</text>`);
    } else {
      parts.push(`<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2.5" fill="#fff" stroke="${COLORS.root}" stroke-width="2"/>`);
    }
  });

  parts.push(`<text x="${pad}" y="${ph - 14}" font-size="11" fill="#7a869c">箭头为定向结果；红色 ✕/虚线为被违反边（断线）；斜纹块为空格。${esc(options.formatVersion || '')}</text>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}
