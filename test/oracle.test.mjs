// 用法: node test/oracle.test.mjs <paths.json> <oracle.json> <invalid.json>
// 对照样例 oracle 验证:虚线区间、闭合接缝、弧长精度、弧长参数化、网格健康度。
import { readFileSync } from 'node:fs';
import { commandsToSubpaths, pointAtLength, matMaxScale } from '../js/geometry.js';
import { dashIntervals, dashPolylines, buildStrokeMesh } from '../js/stroker.js';
import { validateDoc, computePath, EXPORT_TOL_PX } from '../js/pipeline.js';

const [pathsFile, oracleFile, invalidFile] = process.argv.slice(2);
const doc = JSON.parse(readFileSync(pathsFile, 'utf8'));
const oracle = JSON.parse(readFileSync(oracleFile, 'utf8'));
const invalidDoc = JSON.parse(readFileSync(invalidFile, 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const byId = Object.fromEntries(doc.paths.map((p) => [p.id, p]));

// ---- 1. 直线虚线区间 ----
{
  const cp = computePath(byId['dash-line']);
  const iv = dashIntervals(cp.subpaths[0].length, [30, 10], 0, false).intervals;
  const got = iv.map((v) => [v.s0, v.s1]);
  check('dash-line 区间', JSON.stringify(got) === JSON.stringify(oracle.line_ranges),
    `got ${JSON.stringify(got)}`);
}

// ---- 2. 闭合路径虚线 + 接缝合并 ----
{
  const cp = computePath(byId['closed-seam']);
  const sp = cp.subpaths[0];
  check('closed-seam 闭合', sp.closed === true);
  check('closed-seam 周长', near(sp.length, 240, 1e-6), `got ${sp.length}`);
  const res = dashIntervals(sp.length, [50, 20], 10, true);
  const got = res.intervals.map((v) => [v.s0, v.s1]);
  // oracle 区间是未合并形式;合并后应为 [60,110],[130,180],[200,240+40=280]
  check('closed-seam 接缝合并', res.seamJoined === oracle.closed_seam_joined);
  const unwrapped = got.flatMap(([a, b]) => (b > 240 ? [[a, 240], [0, b - 240]] : [[a, b]]))
    .sort((x, y) => x[0] - y[0]);
  check('closed-seam 区间', JSON.stringify(unwrapped) === JSON.stringify(oracle.closed_ranges),
    `got ${JSON.stringify(unwrapped)}`);
  // 合并段折线应连续穿过接缝(点数 > 单边)
  const d = dashPolylines(sp, [50, 20], 10);
  const merged = d.polylines.find((p) => p.s1 > sp.length);
  check('closed-seam 合并段存在', !!merged && merged.pts.length >= 3);
}

// ---- 3. 三次曲线弧长 ----
{
  const cp = computePath(byId['cubic']);
  const sp = cp.subpaths[0];
  check('cubic 弧长', near(sp.length, oracle.cubic_length, 0.1),
    `got ${sp.length}, want ${oracle.cubic_length}`);
  console.log(`       cubic length = ${sp.length} (oracle ${oracle.cubic_length}, diff ${Math.abs(sp.length - oracle.cubic_length)})`);
  // ---- 4. 弧长参数化求点 ----
  for (const ep of oracle.cubic_endpoints) {
    const { point } = pointAtLength(sp, ep.s);
    const err = Math.hypot(point[0] - ep.xy[0], point[1] - ep.xy[1]);
    check(`cubic pointAt(s=${ep.s})`, err <= 0.05, `err=${err}`);
  }
}

// ---- 5. 曲线近似偏差(导出坐标 <= 0.25px) ----
{
  const { evalQuad, evalCubic } = await import('../js/geometry.js');
  for (const p of doc.paths) {
    const cp = computePath(p);
    const scale = matMaxScale(p.transform);
    // 独立采样:在弦段参数区间内量曲线到弦的距离(导出坐标)
    let maxDev = 0;
    for (const sp of cp.subpaths) {
      for (const pc of sp.pieces) {
        if (!pc.seg) continue;
        for (let i = 1; i < 8; i++) {
          const t = pc.t0 + ((pc.t1 - pc.t0) * i) / 8;
          const q = pc.seg.kind === 'quad'
            ? evalQuad(pc.seg.cps[0], pc.seg.cps[1], pc.seg.cps[2], t)
            : evalCubic(pc.seg.cps[0], pc.seg.cps[1], pc.seg.cps[2], pc.seg.cps[3], t);
          const dx = pc.p1[0] - pc.p0[0], dy = pc.p1[1] - pc.p0[1];
          const len = Math.hypot(dx, dy);
          const d = len < 1e-12 ? Math.hypot(q[0] - pc.p0[0], q[1] - pc.p0[1])
            : Math.abs(dx * (pc.p0[1] - q[1]) - (pc.p0[0] - q[0]) * dy) / len;
          maxDev = Math.max(maxDev, d * scale);
        }
      }
    }
    check(`${p.id} 曲线偏差 <= ${EXPORT_TOL_PX}px(导出坐标)`, maxDev <= EXPORT_TOL_PX + 1e-6,
      `maxDev=${maxDev}`);
  }
}

// ---- 6. 重复点不产生坏网格 ----
{
  const cp = computePath(byId['repeated']);
  const { positions, triangles } = cp.mesh;
  let bad = 0, nan = 0, oob = 0, zeroArea = 0;
  for (const v of positions) if (!isFinite(v)) nan++;
  for (const t of triangles) if (t < 0 || t * 2 + 1 >= positions.length) oob++;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    if (a === b || b === c || a === c) { bad++; continue; }
    const ax = positions[a * 2], ay = positions[a * 2 + 1];
    const bx = positions[b * 2], by = positions[b * 2 + 1];
    const cx = positions[c * 2], cy = positions[c * 2 + 1];
    const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    if (!(area > 1e-9)) zeroArea++;
  }
  check('repeated 网格无 NaN', nan === 0);
  check('repeated 索引合法', oob === 0);
  check('repeated 无重复索引三角形', bad === 0);
  check('repeated 无零面积三角形', zeroArea === 0, `zeroArea=${zeroArea}`);
  // 奇数虚线数组 [12,4,2] 重复两遍 -> 周期 36;相位 -5 -> 首段从 pattern 31 起
  const sp = cp.subpaths[0];
  const iv = dashIntervals(sp.length, [12, 4, 2], -5, false).intervals;
  check('repeated 虚线首段', near(iv[0].s0, 0, 1e-9) && near(iv[0].s1, 3, 1e-9),
    `got ${JSON.stringify(iv[0])}`);
  check('repeated 子路径长', near(sp.length, 80, 1e-9), `got ${sp.length}`);
}

// ---- 7. 仿射(非均匀缩放+镜像)网格健康 ----
{
  const cp = computePath(byId['affine']);
  const { positions, triangles } = cp.mesh;
  const okFinite = positions.every(isFinite);
  check('affine 网格有限', okFinite);
  check('affine 有三角形', triangles.length >= 6);
  // 镜像矩阵行列式为负
  const m = byId['affine'].transform;
  check('affine 矩阵镜像', m[0] * m[3] - m[1] * m[2] < 0);
}

// ---- 8. 全部路径网格健康 ----
{
  for (const p of doc.paths) {
    const cp = computePath(p);
    const { positions, triangles } = cp.mesh;
    const nan = positions.some((v) => !isFinite(v));
    const oob = triangles.some((t) => t < 0 || t * 2 + 1 >= positions.length);
    check(`${p.id} 网格健康`, !nan && !oob);
  }
}

// ---- 9. 非法文档被拒绝 ----
{
  const errs = validateDoc(invalidDoc);
  check('invalid.json 被拒绝', errs.length > 0 && errs.some((e) => e.includes('虚线')), errs.join(';'));
}

// ---- 10. 端帽/连接形态冒烟 ----
{
  const base = byId['dash-line'];
  for (const join of ['miter', 'bevel', 'round']) {
    for (const cap of ['butt', 'square', 'round']) {
      const p = { ...base, style: { ...base.style, join, cap, dash: [] } };
      const cp = computePath(p);
      const ok = cp.mesh.positions.every(isFinite) && cp.mesh.triangles.length > 0;
      check(`join=${join} cap=${cap}`, ok);
    }
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
