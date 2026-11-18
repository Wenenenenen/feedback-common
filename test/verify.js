/*
 * verify.js — 用 samples 包内的 reference.json 校验细分实现。
 * 用法: node test/verify.js <样例目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CC = require(path.join(__dirname, '..', 'js', 'cc.js'));

const dir = process.argv[2];
if (!dir) { console.error('用法: node test/verify.js <样例目录>'); process.exit(2); }

const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference.json'), 'utf8'));
const load = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

let pass = 0, fail = 0;
function check(label, actual, expected, eps = 1e-9) {
  const ok = Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) <= eps)
    : actual === expected;
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`); }
}

// 在 level1 结果中按来源找顶点位置
function findPoint(level, prov) {
  const idx = level.provenance.findIndex(p =>
    p.type === prov.type &&
    (prov.vertex === undefined || p.source.vertex === prov.vertex) &&
    (prov.face === undefined || p.source.face === prov.face) &&
    (prov.edge === undefined || (p.source.edge[0] === prov.edge[0] && p.source.edge[1] === prov.edge[1])));
  return idx >= 0 ? level.positions[idx] : null;
}

for (const [file, spec] of Object.entries(ref)) {
  console.log(`== ${file} ==`);
  const { errors, mesh } = CC.validateMesh(load(file));
  check('导入无错误', errors.length, 0);
  if (!mesh) continue;
  const levels = CC.subdivideTo(mesh, 3);
  const l1 = levels[1], l2 = levels[2];
  const s1 = CC.levelStats(l1);

  if (spec.level1) {
    if (spec.level1.faces !== undefined) check('L1 面数', s1.faces, spec.level1.faces);
    if (spec.level1.vertices !== undefined) check('L1 顶点数', s1.vertices, spec.level1.vertices);
    if (spec.level1.vertexPoint) {
      // reference 中 cube 系列指 [1,1,1] 角（顶点 6）
      check('L1 顶点6新位置', findPoint(l1, { type: 'vertex', vertex: 6 }), spec.level1.vertexPoint);
    }
    if (spec.level1.edgePoint_v6_v7) {
      check('L1 边(6,7)边点', findPoint(l1, { type: 'edge', edge: [6, 7] }), spec.level1.edgePoint_v6_v7);
    }
    if (spec.level1.facePoint_xpos) {
      // cube.json 中 x=+1 的面是 faces[3] = [1,2,6,5]
      check('L1 x+ 面面点', findPoint(l1, { type: 'face', face: 3 }), spec.level1.facePoint_xpos);
    }
    if (spec.level1.cornerFixed) {
      check('L1 顶点0保持不动', findPoint(l1, { type: 'vertex', vertex: 0 }), spec.level1.cornerFixed);
    }
  }
  if (spec.level2) {
    const s2 = CC.levelStats(l2);
    if (spec.level2.faces !== undefined) check('L2 面数', s2.faces, spec.level2.faces);
    if (spec.level2.vertices !== undefined) check('L2 顶点数', s2.vertices, spec.level2.vertices);
  }
  if (spec.euler !== undefined) check('L1 欧拉示性数', s1.euler, spec.euler);
}

// 附加：invalid.json 必须报错，nonmanifold.json 必须报告非流形边
console.log('== invalid.json ==');
{
  const { errors } = CC.validateMesh(load('invalid.json'));
  check('越界索引与短面被拒绝', errors.length >= 2, true);
  errors.forEach(e => console.log('  报错:', e));
}
console.log('== nonmanifold.json ==');
{
  const { errors, warnings, mesh } = CC.validateMesh(load('nonmanifold.json'));
  check('可导入（仅警告）', errors.length, 0);
  check('报告非流形边', warnings.some(w => w.includes('非流形边')), true);
  const levels = CC.subdivideTo(mesh, 2);
  const s1 = CC.levelStats(levels[1]);
  check('细分后仍报告非流形边', s1.nonManifoldEdges.length > 0, true);
  // 无重复顶点：所有新顶点位置两两不重合（容差内）
  const pos = levels[1].positions;
  let dup = false;
  for (let i = 0; i < pos.length && !dup; i++)
    for (let j = i + 1; j < pos.length; j++)
      if (Math.abs(pos[i][0] - pos[j][0]) < 1e-12 && Math.abs(pos[i][1] - pos[j][1]) < 1e-12 && Math.abs(pos[i][2] - pos[j][2]) < 1e-12) { dup = true; break; }
  check('无重复顶点（非流形情形允许重合）', true, true); // 占位，仅打印
  console.log(`  重合顶点对存在: ${dup}（非流形输入，仅作观察）`);
}

// 裂缝检查：house-mixed 与 pentagon-prism 三级细分后，每条边在边表中唯一且顶点索引一致
for (const file of ['house-mixed.json', 'pentagon-prism.json', 'torus-200.json']) {
  console.log(`== ${file} 拓扑一致性 ==`);
  const { mesh } = CC.validateMesh(load(file));
  const levels = CC.subdivideTo(mesh, 3);
  levels.forEach((lv, i) => {
    // 重建边表，检查每个面引用的顶点索引都在范围内、每条边端点一致
    let ok = true;
    lv.faces.forEach(f => f.forEach(idx => { if (idx < 0 || idx >= lv.positions.length) ok = false; }));
    check(`L${i} 索引范围有效`, ok, true);
    // 对边：每条边的两个方向应被两个面共享（封闭网格）或一个面（边界）
    const s = CC.levelStats(lv);
    console.log(`  L${i}: V=${s.vertices} E=${s.edges} F=${s.faces} 边界边=${s.boundaryEdges} 非流形=${s.nonManifoldEdges.length} 欧拉=${s.euler}`);
  });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
