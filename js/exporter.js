/*
 * exporter.js — 叠加层 SVG 与落位 JSON 导出（纯函数，无 DOM 依赖）
 */
import { REASON_TEXT } from './solver.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * 生成当前帧叠加层 SVG。
 * @param data 原始数据集
 * @param frameResult solveSequence 中单帧结果（含 ctx/assign/hidden）
 * @param opts {scale:number, showDepth:boolean, showHidden:boolean, conflicts:Array}
 */
export function buildFrameSVG(data, frameResult, opts = {}) {
  const scale = opts.scale ?? 8;
  const W = data.size[0];
  const H = data.size[1];
  const { ctx, assign } = frameResult;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" ` +
      `viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">`
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#0f1420"/>`);

  // 深度缓冲（灰度：越近越亮）
  if (opts.showDepth) {
    const dep = ctx.frame.depth;
    let maxD = 1;
    for (const d of dep) if (d > maxD) maxD = d;
    const cells = [];
    for (let p = 0; p < dep.length; p++) {
      if (dep[p] > 0) {
        const g = Math.round(40 + (dep[p] / maxD) * 150);
        cells.push(`<rect x="${p % W}" y="${Math.floor(p / W)}" width="1" height="1" fill="rgb(${g},${g},${g + 20})"/>`);
      }
    }
    parts.push(`<g>${cells.join('')}</g>`);
  }

  // 预留区
  for (const r of data.reserved || []) {
    parts.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="rgba(245,158,11,0.25)" ` +
        `stroke="#f59e0b" stroke-width="0.25" stroke-dasharray="1 0.8"/>`
    );
  }

  // 冲突高亮（填充层先画，描边层最后画，避免盖住标签图元）
  const conflictStrokes = [];
  if (opts.conflicts) {
    for (const c of opts.conflicts) {
      if (c.type === 'pair') {
        conflictStrokes.push(
          `<rect x="${fmt(c.rectA.x)}" y="${fmt(c.rectA.y)}" width="${c.rectA.w}" height="${c.rectA.h}" ` +
            `fill="none" stroke="#ef4444" stroke-width="0.35" stroke-dasharray="1 0.6"/>`
        );
        conflictStrokes.push(
          `<rect x="${fmt(c.rectB.x)}" y="${fmt(c.rectB.y)}" width="${c.rectB.w}" height="${c.rectB.h}" ` +
            `fill="none" stroke="#ef4444" stroke-width="0.35" stroke-dasharray="1 0.6"/>`
        );
      } else if (c.type === 'infeasible' && c.rect) {
        parts.push(
          `<rect x="${fmt(c.rect.x)}" y="${fmt(c.rect.y)}" width="${c.rect.w}" height="${c.rect.h}" ` +
            `fill="rgba(239,68,68,0.18)" stroke="none"/>`
        );
        conflictStrokes.push(
          `<rect x="${fmt(c.rect.x)}" y="${fmt(c.rect.y)}" width="${c.rect.w}" height="${c.rect.h}" ` +
            `fill="none" stroke="#ef4444" stroke-width="0.3" stroke-dasharray="0.8 0.6"/>`
        );
      }
    }
  }

  // 标签：连线 → 框 → 文本；锚点（含隐藏红点）统一最后画，保证不被任何填充盖住
  const anchorMarks = [];
  ctx.labels.forEach((label, li) => {
    const ci = assign[li];
    const info = ctx.labelInfo[li];
    if (ci < 0) {
      if (opts.showHidden && info.vis.visible) {
        anchorMarks.push(
          `<circle cx="${fmt(info.vis.proj.u)}" cy="${fmt(info.vis.proj.v)}" r="0.55" fill="none" stroke="#64748b" stroke-width="0.25"/>`
        );
      } else if (opts.showHidden && !info.vis.visible && info.vis.px >= 0) {
        anchorMarks.push(
          `<circle cx="${info.vis.px}" cy="${info.vis.py}" r="0.55" fill="#ef4444" stroke="none">` +
            `<title>${esc(label.id)}: ${REASON_TEXT[info.vis.reason] || info.vis.reason}</title></circle>`
        );
      } else if (opts.showHidden && !info.vis.visible && info.vis.proj) {
        anchorMarks.push(
          `<circle cx="${fmt(info.vis.proj.u)}" cy="${fmt(info.vis.proj.v)}" r="0.55" fill="#ef4444" stroke="none">` +
            `<title>${esc(label.id)}: ${REASON_TEXT[info.vis.reason] || info.vis.reason}</title></circle>`
        );
      }
      return;
    }
    const g = ctx.labelRanges[li].start + ci;
    const opt = ctx.options[g];
    const r = opt.rect;
    // 连线
    parts.push(
      `<line x1="${fmt(opt.line.x1)}" y1="${fmt(opt.line.y1)}" x2="${fmt(opt.line.x2)}" y2="${fmt(opt.line.y2)}" ` +
        `stroke="#7dd3fc" stroke-width="0.22"/>`
    );
    // 框
    parts.push(
      `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${r.w}" height="${r.h}" rx="0.4" ` +
        `fill="rgba(56,189,248,0.18)" stroke="#38bdf8" stroke-width="0.28"/>`
    );
    // 文本（适配小框尺寸，字号取框高的 0.62）
    const fs = Math.max(1, r.h * 0.62);
    parts.push(
      `<text x="${fmt(r.x + r.w / 2)}" y="${fmt(r.y + r.h / 2 + fs * 0.35)}" font-size="${fmt(fs)}" ` +
        `fill="#e2e8f0" text-anchor="middle">${esc(label.text || label.id)}</text>`
    );
    anchorMarks.push(
      `<circle cx="${fmt(info.vis.proj.u)}" cy="${fmt(info.vis.proj.v)}" r="0.45" fill="#7dd3fc" stroke="none"/>`
    );
  });

  // 锚点置于标签填充之上
  if (anchorMarks.length) parts.push(anchorMarks.join('\n'));
  // 冲突虚线描边置于最上层
  if (conflictStrokes.length) parts.push(conflictStrokes.join('\n'));

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * 生成落位 JSON（全帧序列）。
 */
export function buildPlacementJSON(data, seq, opts = {}) {
  const out = {
    source: opts.source || 'depth-label-cases',
    size: data.size,
    camera: data.camera,
    switchPenalty: opts.switchPenalty ?? 2,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    frames: seq.map((fr) => ({
      frame: fr.frame,
      score: fr.score,
      labels: fr.ctx.labels.map((label, li) => {
        const ci = fr.assign[li];
        const info = fr.ctx.labelInfo[li];
        if (ci < 0) {
          return {
            id: label.id,
            visible: false,
            reason: info.vis.visible ? 'suppressed-by-solver' : info.vis.reason,
          };
        }
        const g = fr.ctx.labelRanges[li].start + ci;
        const opt = fr.ctx.options[g];
        return {
          id: label.id,
          visible: true,
          choice: ci,
          rect: {
            x: Math.round(opt.rect.x * 1000) / 1000,
            y: Math.round(opt.rect.y * 1000) / 1000,
            w: opt.rect.w,
            h: opt.rect.h,
          },
          anchor: {
            x: Math.round(info.vis.proj.u * 1000) / 1000,
            y: Math.round(info.vis.proj.v * 1000) / 1000,
          },
          cost: opt.cost,
        };
      }),
    })),
  };
  return JSON.stringify(out, null, 2);
}
