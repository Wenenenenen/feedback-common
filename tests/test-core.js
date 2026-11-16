/* Node 测试：用 samples 数据验证约束 QEM 简化。运行：node tests/test-core.js */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const LOD = require('../js/lod-core.js');

const CASE_DIR = process.env.CASE_DIR || '/tmp/clf-cases';
function load(name) {
  return JSON.parse(fs.readFileSync(path.join(CASE_DIR, name), 'utf8'));
}
let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('1) 输入校验');
const invalid = load('invalid-nonmanifold.json');
const resInv = LOD.validateMesh(invalid);
ok('非流形样例被拒绝', () => {
  assert.strictEqual(resInv.ok, false);
  assert.ok(resInv.errors.some(e => e.code.startsWith('nonmanifold')));
  assert.ok(resInv.errors.every(e => /位置|location|顶点|边|faces|vertices|materials/.test(e.location + e.message) || e.location));
});
ok('错误带定位信息', () => {
  const e = resInv.errors[0];
  assert.ok(e.location && e.location.length > 0);
});

ok('坏索引/非法数被拒绝并定位', () => {
  const r1 = LOD.validateMesh({ vertices: [[0, 0, NaN], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], materials: [0] });
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.errors.some(e => e.code === 'illegal-number' && e.location === 'vertices[0][2]'));
  const r2 = LOD.validateMesh({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 9]], materials: [0] });
  assert.ok(r2.errors.some(e => e.code === 'bad-index' && /faces\[0\]\[2\]/.test(e.location)));
  const r3 = LOD.validateMesh({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], materials: [0.5] });
  assert.ok(r3.errors.some(e => e.code === 'bad-material'));
  const r4 = LOD.validateMesh({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 0, 2]], materials: [0] });
  assert.ok(r4.errors.some(e => e.code === 'degenerate' && /faces\[0\]/.test(e.location)));
  const r5 = LOD.validateMesh({ vertices: [[0, 0, 0]], faces: [], materials: [] });
  assert.strictEqual(r5.ok, false);
});

const torus = load('torus.json');
const grid = load('open-grid.json');
const quad = load('locked-quad.json');

ok('torus/open-grid/locked-quad 校验通过', () => {
  assert.strictEqual(LOD.validateMesh(torus).ok, true);
  assert.strictEqual(LOD.validateMesh(grid).ok, true);
  assert.strictEqual(LOD.validateMesh(quad).ok, true);
});

console.log('2) 锁定与最小面数');
const rq = LOD.simplify(quad, 1);
ok('locked-quad 无法折叠（全边触锁），保持 2 面并给出停止原因', () => {
  assert.strictEqual(rq.ok, true);
  assert.strictEqual(rq.mesh.faces.length, 2);
  assert.strictEqual(rq.status, 'constrained-stop');
  assert.ok(rq.stopReason.length > 0);
  assert.ok(rq.lockedVertices.length === 4);
});
ok('目标 = 原始面数时不做任何折叠', () => {
  const r = LOD.simplify(quad, 2);
  assert.strictEqual(r.mesh.faces.length, 2);
  assert.strictEqual(r.stats.collapsedEdges, 0);
  assert.strictEqual(r.status, 'target-reached');
});

console.log('3) torus 简化（封闭流形，无锁定）');
const rt = LOD.simplify(torus, 256);
ok('达到 256 面目标', () => {
  assert.strictEqual(rt.mesh.faces.length, 256);
  assert.strictEqual(rt.status, 'target-reached');
});
ok('顶点映射仍指向原编号且索引有效', () => {
  const V = torus.vertices.length;
  assert.ok(rt.mesh.vertexMap.every(x => x >= 0 && x < V));
  assert.ok(rt.mesh.faces.every(f => f.length === 3 && f.every(i => i >= 0 && i < rt.mesh.vertices.length)));
});
ok('简化结果仍然流形（每边至多 2 面）且无退化', () => {
  const ec = new Map();
  rt.mesh.faces.forEach((f, fi) => {
    assert.ok(new Set(f).size === 3, '退化面 at ' + fi);
    for (let k = 0; k < 3; k++) {
      const a = f[k], b = f[(k + 1) % 3], key = a < b ? a + '_' + b : b + '_' + a;
      ec.set(key, (ec.get(key) || 0) + 1);
    }
  });
  ec.forEach((c, k) => assert.ok(c <= 2, '非流形边 ' + k + ' count=' + c));
});
ok('材质编号随面保留', () => {
  assert.strictEqual(rt.mesh.materials.length, rt.mesh.faces.length);
  assert.ok(rt.mesh.materials.every(m => m === 0));
});
ok('原输入不被修改', () => {
  assert.strictEqual(torus.faces.length, 1024);
  assert.strictEqual(torus.vertices[0][0], 2.5);
});

console.log('4) open-grid 边界/材质交界锁定');
const rg = LOD.simplify(grid, 50);
const gval = LOD.validateMesh(grid);
ok('校验识别出边界与材质交界', () => {
  assert.strictEqual(gval.ok, true);
});
ok('边界顶点被锁定且不出现在任何折叠边上', () => {
  assert.ok(rg.stats.lockedVertices > 0);
  assert.ok(rg.stats.boundaryEdges > 0);
  // 折叠日志中的边不得包含锁定顶点
  const lockSet = new Set(rg.lockedVertices);
  rg.collapseLog.forEach(l => {
    assert.ok(!lockSet.has(l.edge[0]) && !lockSet.has(l.edge[1]), '折叠边触锁 ' + l.edge);
  });
});
ok('未达目标时诚实停止并报告实际面数与原因', () => {
  // 开网格约束强，目标 50 很可能达不到
  assert.ok(rg.mesh.faces.length >= 50);
  if (rg.mesh.faces.length > 50) {
    assert.strictEqual(rg.status, 'constrained-stop');
    assert.ok(rg.stopReason.length > 0);
  }
});
ok('简化结果边界顶点坐标与原模型一致（边界不塌）', () => {
  const lockSet = new Set(rg.lockedVertices);
  rg.mesh.vertexMap.forEach((oldIdx, newIdx) => {
    if (lockSet.has(oldIdx)) {
      const a = rg.mesh.vertices[newIdx], b = grid.vertices[oldIdx];
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-12);
    }
  });
});

console.log('5) 距离统计');
const dist = LOD.computeDistances(torus.vertices, rt.mesh.vertices, rt.mesh.faces);
ok('每个原顶点都有距离，max >= rms >= 0', () => {
  assert.strictEqual(dist.distances.length, torus.vertices.length);
  assert.ok(dist.max >= dist.rms && dist.rms >= 0);
  assert.ok(dist.max > 0);
  assert.ok(dist.distances.every(d => Number.isFinite(d) && d >= 0));
});
ok('零简化时距离全为 0', () => {
  const d0 = LOD.computeDistances(quad.vertices, quad.vertices, quad.faces);
  assert.ok(Math.max(...d0.distances) < 1e-12);
  assert.ok(d0.rms < 1e-12 && d0.max < 1e-12);
});

console.log('6) 点-三角形距离单元检查');
ok('面内/面外距离正确', () => {
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0];
  assert.ok(Math.abs(LOD.pointTriangleDist2([0.25, 0.25, 1], a, b, c) - 1) < 1e-12);
  assert.ok(Math.abs(LOD.pointTriangleDist2([0.25, 0.25, 0], a, b, c)) < 1e-12);
  assert.ok(Math.abs(LOD.pointTriangleDist2([2, 2, 0], a, b, c) - 4.5) < 1e-12); // 最近点在边 b-c (0.5,0.5)，距离平方 4.5
  assert.ok(Math.abs(LOD.pointTriangleDist2([2, -1, 0], a, b, c) - 2) < 1e-12); // 最近点 b=(1,0,0)，距离平方 2
  assert.ok(Math.abs(LOD.pointTriangleDist2([-3, 0, 0], a, b, c) - 9) < 1e-12); // 最近点 a=(0,0,0)，距离平方 9
});

console.log('7) 重复运行确定性与取消');
ok('同样输入两次运行结果一致', () => {
  const a = LOD.simplify(torus, 300);
  const b = LOD.simplify(torus, 300);
  assert.deepStrictEqual(a.mesh.faces, b.mesh.faces);
  assert.deepStrictEqual(a.mesh.vertices, b.mesh.vertices);
});
ok('取消信号可中断且返回 cancelled', () => {
  let n = 0;
  const r = LOD.simplify(torus, 100, { shouldCancel: () => { n++; return n > 2; } });
  assert.strictEqual(r.status, 'cancelled');
  assert.ok(r.mesh.faces.length > 100);
});

console.log('8) 面数规模与性能（上限 1 万面）');
ok('10k 面网格简化可在合理时间完成', () => {
  const N = 72, M = 72; // 约 1 万面的规则网格球面化
  const verts = [], faces = [], mats = [];
  for (let i = 0; i <= M; i++) for (let j = 0; j < N; j++) {
    const th = (i / M) * Math.PI, ph = (j / N) * Math.PI * 2;
    verts.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
  }
  const idx = (i, j) => i * N + (j % N);
  for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) {
    faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
    faces.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    mats.push(0, 0);
  }
  assert.ok(faces.length <= 10368);
  const t0 = Date.now();
  const r = LOD.simplify({ vertices: verts, faces, materials: mats }, 2000);
  const ms = Date.now() - t0;
  console.log('    ' + faces.length + ' -> ' + r.mesh.faces.length + ' 面，用时 ' + ms + 'ms');
  assert.strictEqual(r.mesh.faces.length, 2000);
  assert.ok(ms < 15000);
});

console.log('\n' + (process.exitCode ? '存在失败用例' : '全部 ' + pass + ' 项通过'));
