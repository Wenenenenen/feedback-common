/*
 * run-tests.js — Node 算法测试台（不使用 node_modules，直接 vm 加载 src）
 * 运行: node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'samples', 'extracted');

const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['math.js', 'camera.js', 'clipper.js', 'mesh.js', 'solver.js', 'export.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
}
const HLM = sandbox.HLM;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

function loadCase(file) {
  const data = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, file), 'utf8'));
  const camera = HLM.camera.createCamera(data.camera);
  const mesh = HLM.mesh.buildMesh(data, camera, data.crease_degrees);
  const solution = HLM.solver.solve(mesh, camera, mesh.positions);
  return { data, camera, mesh, solution };
}

function findEdge(solution, verts) {
  const [a, b] = verts;
  return solution.edges.find(e =>
    (e.verts[0] === a && e.verts[1] === b) ||
    (e.verts[0] === b && e.verts[1] === a));
}
function hiddenIntervals(edge) {
  return edge.intervals.filter(i => !i.visible).map(i => [
    Number(i.u0.toFixed(6)), Number(i.u1.toFixed(6))
  ]);
}

console.log('\n== reference.json 标准答案 ==');
const ref = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'reference.json'), 'utf8'));

{
  const { solution } = loadCase('single-occluder.json');
  const e = findEdge(solution, ref['single-occluder'].edge);
  const got = hiddenIntervals(e);
  const want = ref['single-occluder'].hidden;
  check('single-occluder 隐藏区间 = [0.375, 0.625]',
    got.length === want.length && got.every((g, i) =>
      approx(g[0], want[i][0], 1e-6) && approx(g[1], want[i][1], 1e-6)),
    JSON.stringify(got));
}
{
  const { solution } = loadCase('overlapping-occluders.json');
  const e = findEdge(solution, ref['overlapping-occluders'].edge);
  const got = hiddenIntervals(e);
  const want = ref['overlapping-occluders'].hidden;
  check('overlapping-occluders 并集 = [0.375, 0.825]',
    got.length === want.length && got.every((g, i) =>
      approx(g[0], want[i][0], 1e-6) && approx(g[1], want[i][1], 1e-6)),
    JSON.stringify(got));
}
{
  const { solution } = loadCase('coplanar.json');
  const e = findEdge(solution, ref.coplanar.edge);
  const got = hiddenIntervals(e);
  check('coplanar 等深不产生隐藏（相切/共面无假缺口）', got.length === 0, JSON.stringify(got));
}

console.log('\n== 分辨率不变性 ==');
{
  const { solution, mesh, data, camera } = loadCase('single-occluder.json');
  const j1 = HLM.exporter.buildJSON(solution, mesh, data.camera, 640, 480);
  const j2 = HLM.exporter.buildJSON(solution, mesh, data.camera, 1280, 960);
  const sig = j => JSON.stringify(j.edges.map(e => e.intervals.map(i => [i.u0, i.u1, i.visible])));
  check('640x480 与 1280x960 区间完全一致', sig(j1) === sig(j2));
  const svg1 = HLM.exporter.buildSVG(solution, mesh, 640, 480);
  const svg2 = HLM.exporter.buildSVG(solution, mesh, 1280, 960);
  const p1 = (svg1.match(/x1="([^"]+)"/) || [])[1];
  const p2 = (svg2.match(/x1="([^"]+)"/) || [])[1];
  check('SVG 坐标随分辨率等比放大（2x）', approx(Number(p2), Number(p1) * 2, 1e-3),
    `${p1} vs ${p2}`);
}

console.log('\n== 非流形 / 非法索引 ==');
{
  const { solution } = loadCase('nonmanifold.json');
  const nm = solution.edges.filter(e => e.types.nonmanifold);
  check('nonmanifold 存在被标记的非流形边且仍保留', nm.length >= 1,
    `count=${nm.length}`);
}
{
  const data = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'invalid-index.json'), 'utf8'));
  const camera = HLM.camera.createCamera(data.camera);
  const mesh = HLM.mesh.buildMesh(data, camera, data.crease_degrees);
  check('invalid-index 被拒绝并给出错误', mesh.errors.length > 0,
    JSON.stringify(mesh.errors));
}

console.log('\n== 立方体（折痕/轮廓/边界分类） ==');
{
  const { solution, mesh } = loadCase('cube.json');
  // 立方体 12 个三角形、顶点不焊接：6 面 × 3 边 = 18 条索引边，每条关联两面
  check('立方体拓扑为 18 条两面共享索引边（按索引构建、不焊接）',
    mesh.edges.length === 18 && mesh.edges.every(e => e.faceIds.length === 2),
    `edges=${mesh.edges.length}`);
  // 每个四边形面拆出的 2 个三角形共享一条面内对角线（法线相同，非折痕）：
  // 12 条跨面棱是折痕，6 条面内对角线不是任何特征边
  const creases = mesh.edges.filter(e => e.types.crease);
  const diagonals = mesh.edges.filter(e => !HLM.mesh.isFeatureEdge(e));
  check('12 条跨面棱为折痕、6 条共面三角形对角线非特征边',
    creases.length === 12 && diagonals.length === 6,
    `creases=${creases.length}, nonFeature=${diagonals.length}`);
  // 正视立方体：前后 4 条轮廓边（前后层 z 不同，正面判定相同，轮廓来自侧棱）
  const silhouette = mesh.edges.filter(e => e.types.silhouette);
  check('立方体存在轮廓边', silhouette.length >= 4, `count=${silhouette.length}`);
  check('立方体无边界/非流形边',
    !mesh.edges.some(e => e.types.boundary || e.types.nonmanifold));
  check('所有特征边区间并集恰好覆盖裁剪段 [u0,u1]',
    solution.edges.filter(e => e.feature).every(e => {
      if (!e.clip) return true;
      const first = e.intervals[0], last = e.intervals[e.intervals.length - 1];
      return approx(first.u0, e.clip.u0) && approx(last.u1, e.clip.u1);
    }));
}

console.log('\n== 透视相机 / 跨相机近平面 ==');
{
  const { solution } = loadCase('perspective.json');
  const e = findEdge(solution, [0, 1]);
  check('perspective 特征边完成解析且区间覆盖完整',
    e && e.feature && e.intervals.length >= 1 &&
    approx(e.intervals[0].u0, e.clip.u0) &&
    approx(e.intervals[e.intervals.length - 1].u1, e.clip.u1));
}
{
  const { solution } = loadCase('near-cross.json');
  check('near-cross 跨近平面边被裁剪后仍可求解（无 NaN）',
    solution.edges.every(e => !e.clip ||
      [e.clip.u0, e.clip.u1, ...e.clip.ndc0, ...e.clip.ndc1].every(Number.isFinite)));
}

console.log('\n== 折痕角联动 ==');
{
  const data = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'cube.json'), 'utf8'));
  const camera = HLM.camera.createCamera(data.camera);
  const mesh180 = HLM.mesh.buildMesh(data, camera, 180);
  check('折痕角 180° 时立方体无折痕边', mesh180.edges.every(e => !e.types.crease));
  const mesh0 = HLM.mesh.buildMesh(data, camera, 0);
  check('折痕角 0° 时所有两面边均为折痕',
    mesh0.edges.filter(e => e.faceIds.length === 2).every(e => e.types.crease));
}

console.log('\n== 自身相邻面不造成假缺口 ==');
{
  const { solution } = loadCase('cube.json');
  // 立方体边的关联面被排除后，不存在其它遮挡面，因此所有边应全程可见
  const allVis = solution.edges.filter(e => e.feature && e.clip)
    .every(e => e.intervals.every(i => i.visible));
  check('立方体自身相邻面全部排除、无假缺口', allVis);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
