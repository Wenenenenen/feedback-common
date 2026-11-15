// pipeline.js — 文档校验 + 描边管线(命令 -> 子路径 -> 虚线 -> 三角网格)。
import { commandsToSubpaths, matMaxScale } from './geometry.js';
import { dashIntervals, dashPolylines, buildStrokeMesh } from './stroker.js';

export const EXPORT_TOL_PX = 0.25; // 导出坐标中曲线近似偏差上限

export function validateStyle(style) {
  const errs = [];
  if (!style || typeof style !== 'object') return ['缺少 style'];
  if (!(style.width > 0) || !isFinite(style.width)) errs.push('线宽 width 必须为正数');
  if (!['miter', 'bevel', 'round'].includes(style.join)) errs.push('join 必须是 miter/bevel/round');
  if (!['butt', 'square', 'round'].includes(style.cap)) errs.push('cap 必须是 butt/square/round');
  if (!(style.miterLimit >= 1) || !isFinite(style.miterLimit)) errs.push('miterLimit 必须为 >= 1 的数');
  if (!Array.isArray(style.dash)) errs.push('dash 必须是数组');
  else for (const d of style.dash) {
    if (!(d > 0) || !isFinite(d)) { errs.push('虚线项必须为正数'); break; }
  }
  if (!isFinite(style.dashOffset)) errs.push('dashOffset 必须为数值');
  if (!Array.isArray(style.color) || style.color.length !== 4 || style.color.some((c) => !isFinite(c) || c < 0 || c > 1)) {
    errs.push('color 必须为 [r,g,b,a],分量在 0..1');
  }
  return errs;
}

export function validateCommands(commands) {
  const errs = [];
  if (!Array.isArray(commands) || commands.length === 0) return ['commands 必须为非空数组'];
  const arity = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  if (commands[0][0] !== 'M') errs.push('子路径必须以 M 开始');
  commands.forEach((cmd, i) => {
    if (!Array.isArray(cmd) || typeof cmd[0] !== 'string' || !(cmd[0] in arity)) {
      errs.push(`命令 ${i}: 未知操作符`); return;
    }
    const need = arity[cmd[0]];
    if (cmd.length !== need + 1) { errs.push(`命令 ${i} (${cmd[0]}): 需要 ${need} 个参数`); return; }
    for (let j = 1; j < cmd.length; j++) {
      if (!isFinite(cmd[j])) { errs.push(`命令 ${i} (${cmd[0]}): 参数必须为有限数值`); return; }
    }
  });
  return errs;
}

export function validateTransform(m) {
  if (!Array.isArray(m) || m.length !== 6 || m.some((v) => !isFinite(v))) return ['transform 必须为 6 个有限数值 [a,b,c,d,e,f]'];
  return [];
}

export function validateDoc(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['文档不是对象'];
  if (!Array.isArray(doc.canvas) || doc.canvas.length !== 2 || doc.canvas.some((v) => !(v > 0))) {
    errs.push('canvas 必须为 [宽, 高]');
  }
  if (!Array.isArray(doc.paths)) { errs.push('缺少 paths 数组'); return errs; }
  doc.paths.forEach((p, i) => {
    const tag = p && p.id != null ? `路径 ${p.id}` : `路径 #${i}`;
    if (!p || typeof p !== 'object') { errs.push(`${tag}: 不是对象`); return; }
    for (const e of validateCommands(p.commands)) errs.push(`${tag}: ${e}`);
    for (const e of validateTransform(p.transform)) errs.push(`${tag}: ${e}`);
    for (const e of validateStyle(p.style)) errs.push(`${tag}: ${e}`);
  });
  return errs;
}

// 计算单条路径的全部派生数据(局部坐标)。
export function computePath(path) {
  const scale = matMaxScale(path.transform);
  const tol = EXPORT_TOL_PX / scale; // 局部坐标细分容差,保证导出偏差 <= 0.25px
  const subpaths = commandsToSubpaths(path.commands, tol);
  const dashes = []; // 每个子路径的虚线区间(用于点选查询)
  const polylines = [];
  let seamJoined = false;
  for (const sp of subpaths) {
    const res = dashIntervals(sp.length, path.style.dash, path.style.dashOffset, sp.closed);
    const d = dashPolylines(sp, path.style.dash, path.style.dashOffset);
    if (d.seamJoined) seamJoined = true;
    dashes.push({ subpath: sp, intervals: res.intervals });
    for (const pl of d.polylines) polylines.push(pl);
  }
  const mesh = buildStrokeMesh(polylines, path.style, tol);
  return { path, tol, subpaths, dashes, polylines, mesh, seamJoined };
}

export function computeDoc(doc) {
  return { doc, paths: doc.paths.map((p) => computePath(p)) };
}
