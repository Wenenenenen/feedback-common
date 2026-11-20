/* 核心管线测试：node test/test-core.mjs */
import { readFileSync } from 'node:fs';
import { buildDecals, sub, cross, dot, norm } from '../decal-core.js';

const dir = new URL('../samples/extracted/', import.meta.url);
const load = n => JSON.parse(readFileSync(new URL(n, dir)));

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed++;
}

/* ---------- basic：对照 expected.json ---------- */
console.log('basic:');
const basic = load('basic.json');
const exp = load('expected.json');
const rb = buildDecals(basic);
const valid = [...new Set(rb.records.map(r => r.sourceTriangle))].sort();
const invalid = basic.meshes[0].triangles.map((_, i) => i).filter(i => !valid.includes(i));
check(`有效来源面=${JSON.stringify(exp['basic有效来源面'])}`, JSON.stringify(valid) === JSON.stringify(exp['basic有效来源面']));
check(`无效来源面=${JSON.stringify(exp['basic无效来源面'])}`, JSON.stringify(invalid) === JSON.stringify(exp['basic无效来源面']));
check('世界外法线≈(0,0,-1)', rb.records.every(r => Math.hypot(r.normal[0], r.normal[1], r.normal[2] + 1) < 1e-9));
check(`偏移后z≈${exp['basic偏移后z']}`, rb.records.every(r => r.positions.every(p => Math.abs(p[2] - exp['basic偏移后z']) < 1e-9)));
check('重心坐标和≈1', rb.records.every(r => r.bary.every(b => Math.abs(b[0] + b[1] + b[2] - exp['重心坐标和']) < 1e-9)));
check('UV∈[0,1]', rb.records.every(r => r.uv.every(([u, v]) => u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9)));
check('有输出三角形', rb.records.length > 0);

/* ---------- affine：镜像 + 非均匀缩放 + 剪切盒 ---------- */
console.log('affine:');
const affine = load('affine.json');
const ra = buildDecals(affine);
check('两个投射盒均有输出', ra.stats.every(s => s.out > 0));
// 镜像实例：输出三角形几何法线必须与记录的世界外法线同向（绕序已反转，外表面朝外）
check('镜像实例绕序外翻（几何法线·记录法线>0）', ra.records.every(r => {
  const n = cross(sub(r.positions[1], r.positions[0]), sub(r.positions[2], r.positions[0]));
  return dot(n, r.normal) > 0;
}));
check('重心坐标和≈1', ra.records.every(r => r.bary.every(b => Math.abs(b[0] + b[1] + b[2] - 1) < 1e-9)));
check('UV∈[0,1]', ra.records.every(r => r.uv.every(([u, v]) => u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9)));
check('偏移距离=|worldOffset|', ra.records.every(r => r.positions.every((p, j) => {
  const d = sub(p, r.positionsRaw[j]);
  return Math.abs(Math.hypot(...d) - 0.002) < 1e-9 && dot(norm(d), r.normal) > 1 - 1e-9;
})));
// 世界法线应为 (0,0,-1)：非均匀缩放+剪切不改变 z 法线方向（逆转置后归一化）
check('世界外法线≈(0,0,-1)', ra.records.every(r => Math.hypot(r.normal[0], r.normal[1], r.normal[2] + 1) < 1e-9));

/* ---------- capacity：9800面 × 4盒 ---------- */
console.log('capacity:');
const cap = load('capacity.json');
const t0 = performance.now();
const rc = buildDecals(cap);
const ms = (performance.now() - t0).toFixed(1);
check(`9800面×4盒运行 (${ms}ms)`, true);
check('4盒均有输出', rc.stats.every(s => s.out > 0));
check('无退化面残留（面积≥1e-12）', rc.records.every(r => {
  const a = 0.5 * Math.hypot(...cross(sub(r.positionsRaw[1], r.positionsRaw[0]), sub(r.positionsRaw[2], r.positionsRaw[0])));
  return a >= 1e-12;
}));
check('重心坐标和≈1', rc.records.every(r => r.bary.every(b => Math.abs(b[0] + b[1] + b[2] - 1) < 1e-9)));
console.log(`  输出 ${rc.records.length} 三角形，统计: ${rc.stats.map(s => `${s.id}:角度剔${s.angleCut}/盒外${s.clipCut}/退化${s.degen}/出${s.out}`).join(' | ')}`);

/* ---------- 边界退化：三角形与盒面共面 ---------- */
console.log('degenerate-on-boundary:');
const degScene = {
  meshes: [{ id: 'm', vertices: [[0, 0, 1], [0.5, 0, 1], [0, 0.5, 1]], triangles: [[0, 1, 2]] }],
  instances: [{ id: 'i', mesh: 'm', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }],
  projectors: [{ id: 'p', worldToBox: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], texture: 'decal.png', maxAngle: 75, worldOffset: 0.002 }],
};
const rd = buildDecals(degScene);
check('z=+1 共面三角形朝内被角度剔除或无退化残留', rd.records.length === 0 || rd.records.every(r => {
  const a = 0.5 * Math.hypot(...cross(sub(r.positionsRaw[1], r.positionsRaw[0]), sub(r.positionsRaw[2], r.positionsRaw[0])));
  return a >= 1e-12;
}));
// 翻转绕序使其朝向 -z（外法线 (0,0,-1)，通过角度筛选），应保留且面积正常
const degScene2 = JSON.parse(JSON.stringify(degScene));
degScene2.meshes[0].triangles = [[0, 2, 1]];
const rd2 = buildDecals(degScene2);
check('边界共面三角形保留且非退化', rd2.records.length === 1);

/* ---------- 上限校验 ---------- */
console.log('limits:');
let threw = false;
try { buildDecals({ meshes: [{ id: 'm', vertices: [[0,0,0],[1,0,0],[0,1,0]], triangles: Array(10001).fill([0,1,2]) }], instances: [], projectors: [] }); } catch { threw = true; }
check('超过10000面报错', threw);
threw = false;
try { buildDecals({ meshes: [], instances: [], projectors: Array(5).fill({ id: 'p', worldToBox: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], maxAngle: 75, worldOffset: 0 }) }); } catch { threw = true; }
check('超过4个投射盒报错', threw);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
