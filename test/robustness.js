/*
 * robustness.js — 解析求解器的边界/对抗用例与性能测试
 * 运行: node test/robustness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['math.js', 'camera.js', 'clipper.js', 'mesh.js', 'solver.js', 'export.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), sandbox, { filename: f });
}
const HLM = sandbox.HLM;
const M = HLM.math;

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (d ? ' — ' + d : ''))); };
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const ORTHO = {
  type: 'orthographic', origin: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0],
  near: 0.1, far: 100, aspect: 1, height: 10,
};
function solve(data, crease = 45) {
  const cam = HLM.camera.createCamera(data.camera);
  const mesh = HLM.mesh.buildMesh(data, cam, crease);
  if (mesh.errors.length) throw new Error('mesh errors: ' + mesh.errors.join(';'));
  return { cam, mesh, sol: HLM.solver.solve(mesh, cam, mesh.positions) };
}
const edge0Hidden = sol => sol.edges[0].intervals.filter(i => !i.visible);

/* 1. 三角形与边深度恰好相切（D(u) 在一点触 0）：不得产生隐藏区间 */
console.log('\n== 深度相切 ==');
{
  // 边在 z=4，遮挡三角与边在 u=0.5 处等深、两侧更深（三角更远），D>=0 恒成立
  const data = {
    positions: [
      [-2, 0, 4], [2, 0, 4], [0, -2, 4],          // 边 0-1 + 后三角 0,1,2（关联面，被排除）
      [-1, -1, 4.5], [1, -1, 4.5], [0, 1, 4],      // 遮挡三角：顶点 5 在 (0,1,4) 与边等深
    ],
    triangles: [[0, 1, 2], [3, 4, 5]],
    camera: ORTHO, crease_degrees: 45,
  };
  const { sol } = solve(data);
  const h = edge0Hidden(sol);
  check('相切（D>=0，单点 D=0）不产生任何隐藏段', h.length === 0, JSON.stringify(h));
}

/* 2. 遮挡三角从边的一侧穿透：隐藏段恰为解析根之间 */
console.log('\n== 单侧穿透解析根 ==');
{
  // 遮挡三角 z=2（更近），但只覆盖边的右半屏幕范围
  const data = {
    positions: [
      [-2, 0, 4], [2, 0, 4], [0, -2, 4],
      [0, -1, 2], [2, -1, 2], [1, 1, 2],
    ],
    triangles: [[0, 1, 2], [3, 4, 5]],
    camera: ORTHO, crease_degrees: 45,
  };
  const { sol } = solve(data);
  const h = edge0Hidden(sol);
  check('穿透只产生一个隐藏段', h.length === 1, JSON.stringify(h));
  if (h.length === 1) {
    check('隐藏段边界严格在 (0,1) 内（端点未被误吞）',
      h[0].u0 > 0 && h[0].u1 < 1, `[${h[0].u0}, ${h[0].u1}]`);
    check('隐藏段记录遮挡面 ID = 1',
      h[0].occluderFaceIds.length === 1 && h[0].occluderFaceIds[0] === 1);
  }
}

/* 3. 共面且屏幕重叠：等深保留可见 */
console.log('\n== 共面重叠 ==');
{
  const data = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'samples', 'extracted', 'coplanar.json'), 'utf8'));
  const { sol } = solve(data);
  check('样例 coplanar 边 0 全程可见', edge0Hidden(sol).length === 0);
}

/* 4. 自身相邻面绝不遮挡自己的边 */
console.log('\n== 自身相邻面排除 ==');
{
  const data = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'samples', 'extracted', 'cube.json'), 'utf8'));
  const { sol } = solve(data);
  const anySelf = sol.edges.some(e =>
    e.intervals.some(iv => iv.occluderFaceIds.some(f => e.faceIds.includes(f))));
  check('任何区间的遮挡面都不属于该边的关联面', !anySelf);
}

/* 5. 跨视锥近/远平面的边：裁剪后 u 端点正确且连续 */
console.log('\n== 跨视锥裁剪 ==');
{
  // 独立顶点的跨视锥边（仅属于自身三角形，避免拓扑共享干扰裁剪参数判断）
  // 该用例专用相机：far=20，使 z=20 恰好落在远平面
  const clipCam = { ...ORTHO, near: 0.1, far: 20 };
  const data = {
    positions: [
      [0, 0, -2], [0, 0, 30], [1, 1, -2],     // 0-1 跨视锥边；0,2,1 构成其关联面
      [-1, -1, 5], [1, -1, 5], [0, 1, 5],      // 独立遮挡三角形
    ],
    triangles: [[0, 2, 1], [3, 4, 5]],
    camera: clipCam, crease_degrees: 45,
  };
  const { sol } = solve(data);
  const e0 = sol.edges.find(e =>
    (e.verts[0] === 0 && e.verts[1] === 1) || (e.verts[0] === 1 && e.verts[1] === 0));
  check('跨视锥边被裁剪（u0>0 或 u1<1）', e0.clip && (e0.clip.u0 > 1e-9 || e0.clip.u1 < 1 - 1e-9),
    JSON.stringify(e0.clip && [e0.clip.u0, e0.clip.u1]));
  // 近平面 z=0.1：u=(0.1-(-2))/(30-(-2))=0.065625；远平面 z=20：u=0.6875
  check('近平面裁剪参数解析正确', e0.clip && approx(e0.clip.u0, 0.065625, 1e-9),
    String(e0.clip && e0.clip.u0));
  check('远平面裁剪参数解析正确', e0.clip && approx(e0.clip.u1, 0.6875, 1e-9),
    String(e0.clip && e0.clip.u1));
  check('裁剪后区间并集无缝覆盖 [u0,u1]',
    approx(e0.intervals[0].u0, e0.clip.u0) &&
    approx(e0.intervals[e0.intervals.length - 1].u1, e0.clip.u1));
}

/* 5b. 边沿视轴投影退化为屏幕点：保留裁剪区间但不产生笔划、不被整条丢弃 */
console.log('\n== 投影退化为点的边 ==');
{
  const data = {
    positions: [
      [0, 0, -2], [0, 0, 30], [1, 1, 6],      // 边 0-1 沿视轴
      [-1, -1, 8], [1, -1, 8], [0, 1, 8],
    ],
    triangles: [[0, 1, 2], [3, 4, 5]],
    camera: { ...ORTHO, far: 20 }, crease_degrees: 45,
  };
  const { sol } = solve(data);
  const e01 = sol.edges.find(e =>
    (e.verts[0] === 0 && e.verts[1] === 1) || (e.verts[0] === 1 && e.verts[1] === 0));
  check('视轴边未被丢弃，保留裁剪区间', !!e01.clip, 'clip=null');
  check('标记 pointProjected', e01.clip && e01.clip.pointProjected === true);
  check('仍输出区间供检视', e01.intervals.length >= 1);
  // SVG 导出不应包含该边的零长度 line
  const svg = HLM.exporter.buildSVG(sol, sol, 640, 480);
  const lineForEdge = (svg.match(new RegExp(`data-edge="${e01.edgeId}"`, 'g')) || []).length;
  check('SVG 不输出投影退化边的笔划', lineForEdge === 0, `lines=${lineForEdge}`);
}

/* 6. 多遮挡区间重叠：并集 + 遮挡面 ID 集合 */
console.log('\n== 多遮挡重叠的面 ID 并集 ==');
{
  const data = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'samples', 'extracted', 'overlapping-occluders.json'), 'utf8'));
  const { sol } = solve(data);
  const e0 = sol.edges[0];
  const hidden = e0.intervals.filter(i => !i.visible);
  check('重叠遮挡合并为单段', hidden.length === 1, JSON.stringify(hidden.map(h => [h.u0, h.u1])));
  check('合并段携带两个遮挡面 ID',
    hidden[0] && hidden[0].occluderFaceIds.length === 2,
    JSON.stringify(hidden[0] && hidden[0].occluderFaceIds));
}

/* 7. 非流形边：三面共享，标记保留且仍做解析 */
console.log('\n== 非流形 ==');
{
  const data = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'samples', 'extracted', 'nonmanifold.json'), 'utf8'));
  const { mesh, sol } = solve(data);
  const nm = mesh.edges.filter(e => e.types.nonmanifold);
  check('存在非流形标记', nm.length >= 1);
  const nmSolved = sol.edges.filter(e => e.types.nonmanifold);
  check('非流形边保留在输出中且含区间/裁剪信息',
    nmSolved.every(e => e.verts && Array.isArray(e.intervals)));
}

/* 8. 透视相机：深度差仍为屏幕参数一次函数，解析结果有限 */
console.log('\n== 透视相机 ==');
{
  const data = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'samples', 'extracted', 'perspective.json'), 'utf8'));
  const { sol } = solve(data);
  const finite = sol.edges.every(e => e.intervals.every(iv =>
    Number.isFinite(iv.u0) && Number.isFinite(iv.u1)));
  check('透视下全部区间参数有限', finite);
}

/* 9. 输出区间互斥、有序、完整拼接 */
console.log('\n== 区间结构不变量 ==');
{
  for (const f of ['single-occluder.json', 'overlapping-occluders.json', 'cube.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'extracted', f), 'utf8'));
    const { sol } = solve(data);
    let ok = true;
    for (const e of sol.edges) {
      if (!e.feature || !e.clip) continue;
      const ivs = e.intervals;
      if (!ivs.length) { ok = false; break; }
      if (!approx(ivs[0].u0, e.clip.u0) || !approx(ivs[ivs.length - 1].u1, e.clip.u1)) { ok = false; break; }
      for (let i = 1; i < ivs.length; i++) {
        if (!approx(ivs[i - 1].u1, ivs[i].u0) || ivs[i].u0 >= ivs[i].u1) { ok = false; }
      }
    }
    check(`${f} 区间有序/互斥/无缝`, ok);
  }
}

/* 10. 5000 面性能与分辨率独立性 */
console.log('\n== 5000 面性能 / 分辨率独立 ==');
{
  const N = 5000;
  const positions = [];
  const triangles = [];
  // 规则三角网格（z 方向起伏形成自遮挡）
  const cols = 51, rows = 99;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    positions.push([(c / cols - 0.5) * 8, (r / rows - 0.5) * 8,
      4 + Math.sin(c * 0.5) * Math.cos(r * 0.4)]);
  }
  const idx = (r, c) => r * (cols + 1) + c;
  for (let r = 0; r < rows && triangles.length < N; r++) {
    for (let c = 0; c < cols && triangles.length < N - 1; c++) {
      triangles.push([idx(r, c), idx(r + 1, c), idx(r, c + 1)]);
      if (triangles.length < N) triangles.push([idx(r + 1, c), idx(r + 1, c + 1), idx(r, c + 1)]);
    }
  }
  const data = { positions, triangles: triangles.slice(0, N), camera: ORTHO, crease_degrees: 30 };
  const t0 = Date.now();
  const { mesh, sol } = solve(data, 30);
  const dt = Date.now() - t0;
  check(`5000 面在 2 秒内完成解析（实测 ${dt}ms）`, dt < 2000);
  check('5000 面全部进入统计', mesh.faces.length === N);

  const j1 = HLM.exporter.buildJSON(sol, mesh, ORTHO, 640, 480);
  const j2 = HLM.exporter.buildJSON(sol, mesh, ORTHO, 3840, 2160);
  const sig = j => JSON.stringify(j.edges.map(e => e.intervals.map(i => [i.u0, i.u1, i.visible])));
  check('4K 与 640 宽区间判定逐位一致', sig(j1) === sig(j2));
}

console.log(`\n健壮性: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
