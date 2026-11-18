/*
 * tests/run-tests.js — Node 单测（在仓库根目录运行：node tests/run-tests.js）
 * 对照 samples/extracted/reference.json 的期望 t/normal/leaf/status。
 * 另含结构校验、保守下界、内部起点、耗尽与未命中区分等测试。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const Mat4 = require('../app/mat4.js');
const SdfValidate = require('../app/validate.js');
const Sdf = require('../app/sdf.js');
const RayMarch = require('../app/raymarch.js');

const CASE_DIR = path.join(__dirname, '..', 'samples', 'extracted');
const load = (name) => JSON.parse(fs.readFileSync(path.join(CASE_DIR, name), 'utf8'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
function approx(a, b, tol = 1e-3) { return Math.abs(a - b) <= tol; }
function approxVec(a, b, tol = 1e-2) {
  return a.every((v, i) => approx(v, b[i], tol));
}

console.log('1) reference.json 数值对照');
const reference = load('reference.json');
for (const [sceneName, raysExpected] of Object.entries(reference)) {
  const scene = load(`${sceneName}.json`);
  const tree = Sdf.compile(scene);
  for (const ray of scene.rays) {
    const expected = raysExpected[ray.id];
    if (!expected) continue;
    test(`${sceneName}/${ray.id}`, () => {
      const r = RayMarch.trace(tree, ray, {});
      assert.strictEqual(r.status, expected.status || 'hit', `status=${r.status}`);
      if (r.status === 'hit') {
        assert.ok(approx(r.t, expected.t, 2e-3), `t=${r.t} 期望 ${expected.t}`);
        assert.ok(approxVec(r.normal, expected.normal), `normal=${r.normal} 期望 ${expected.normal}`);
        if (expected.leaf) assert.strictEqual(r.leaf, expected.leaf, `leaf=${r.leaf}`);
      }
    });
  }
}

console.log('2) 结构校验');
test('sphere 场景无错误', () => {
  const r = SdfValidate.validateScene(load('sphere.json'));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.stats.leafCount, 1);
  assert.strictEqual(r.stats.maxDepth, 1);
});
test('invalid-cycle 指出具体环节点 cut', () => {
  const r = SdfValidate.validateScene(load('invalid-cycle.json'));
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.node === 'cut' && /环/.test(e.message)), JSON.stringify(r.errors));
});
test('invalid-singular 指出奇异矩阵节点 outer', () => {
  const r = SdfValidate.validateScene(load('invalid-singular.json'));
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.node === 'outer' && /奇异/.test(e.message)), JSON.stringify(r.errors));
});
test('缺失引用、非法尺寸、零方向、坏矩阵分别带节点 id', () => {
  const bad = {
    nodes: {
      a: { kind: 'sphere', radius: -1 },
      b: { kind: 'box', half_size: [1, 1, 0] },
      op: { kind: 'union', left: 'a', right: 'ghost' },
      deg: { kind: 'sphere', radius: 1, matrix: [1, 2, 3, 0, 2, 4, 6, 0, 3, 6, 9, 0, 0, 0, 0, 1] },
    },
    root: 'op',
    rays: [{ id: 'z', origin: [0, 0, 0], direction: [0, 0, 0] }],
  };
  const r = SdfValidate.validateScene(bad);
  assert.ok(!r.ok);
  const has = (node, re) => r.errors.some((e) => e.node === node && re.test(e.message));
  assert.ok(has('a', /正数/), JSON.stringify(r.errors));
  assert.ok(has('b', /正数/));
  assert.ok(has('op', /不存在/));
  assert.ok(has('deg', /奇异/));
  assert.ok(has(null, /零向量/));
});
test('叶数 65 / 深度 17 被拒绝', () => {
  // 左链并集树：每层挂一个右侧叶，保证所有叶从 root 可达
  const nodes = { s0: { kind: 'sphere', radius: 1 } };
  let prev = 's0';
  for (let i = 1; i < 65; i++) {
    const leaf = `s${i}`;
    const op = `u${i}`;
    nodes[leaf] = { kind: 'sphere', radius: 1 };
    nodes[op] = { kind: 'union', left: prev, right: leaf };
    prev = op;
  }
  const deep = {};
  let dprev = 'd0';
  deep.d0 = { kind: 'sphere', radius: 1 };
  for (let i = 1; i <= 16; i++) {
    const id = `d${i}`;
    deep[id] = { kind: 'union', left: dprev, right: 'sibling' };
    deep.sibling = { kind: 'sphere', radius: 1 };
    dprev = id;
  }
  const r1 = SdfValidate.validateScene({ nodes, root: prev, rays: [] });
  assert.ok(!r1.ok && r1.errors.some((e) => /叶节点数/.test(e.message)), JSON.stringify(r1.errors));
  const r2 = SdfValidate.validateScene({ nodes: deep, root: dprev, rays: [] });
  assert.ok(!r2.ok && r2.errors.some((e) => /深度/.test(e.message)), JSON.stringify(r2.errors));
});
test('多父引用报错（两个不同父节点引用同一子树）', () => {
  const data = {
    nodes: {
      shared: { kind: 'sphere', radius: 1 },
      extra: { kind: 'sphere', radius: 1 },
      u1: { kind: 'union', left: 'shared', right: 'extra' },
      u2: { kind: 'union', left: 'shared', right: 'extra' },
      top: { kind: 'union', left: 'u1', right: 'u2' },
    },
    root: 'top', rays: [],
  };
  const r = SdfValidate.validateScene(data);
  assert.ok(!r.ok && r.errors.some((e) => /单父/.test(e.message)), JSON.stringify(r.errors));
});

console.log('3) 保守距离场下界');
test('非均匀缩放：任意世界点 |保守场| 推进不跨越表面（轴向与斜向扫描）', () => {
  const scene = load('scaled.json');
  const tree = Sdf.compile(scene);
  // 椭球 x²/4 + y² + z²/0.25 = 1；沿若干射线做球步进，命中点必须在真实表面容差内
  const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 1, 1], [0.3, -0.7, 0.6]];
  for (const d0 of dirs) {
    const d = Mat4.normalize3(d0);
    const r = RayMarch.trace(tree, { origin: [d[0] * 10, d[1] * 10, d[2] * 10], direction: d.map((v) => -v) }, {});
    assert.strictEqual(r.status, 'hit', `方向 ${d0} 状态 ${r.status}`);
    const p = r.point;
    const f = (p[0] * p[0]) / 4 + p[1] * p[1] + (p[2] * p[2]) / 0.25;
    assert.ok(Math.abs(f - 1) < 2e-3, `方向 ${d0} 命中点不在椭球面：f=${f}`);
  }
});
test('剪切薄壳：z 方向步进不跨过 0.25 厚壁，命中 t≈1.75', () => {
  const scene = load('sheared.json');
  const tree = Sdf.compile(scene);
  const r = RayMarch.trace(tree, scene.rays[0], {});
  assert.strictEqual(r.status, 'hit');
  assert.ok(approx(r.t, 1.75, 2e-3), `t=${r.t}`);
});

console.log('4) 起点在实体内部 / 差集空腔');
test('球内部射线从 t=0 负场推进到内壁', () => {
  const scene = load('sphere.json');
  const tree = Sdf.compile(scene);
  const inside = scene.rays.find((r) => r.id === 'inside');
  const r = RayMarch.trace(tree, inside, {});
  assert.strictEqual(r.status, 'hit');
  assert.ok(approx(r.t, 1, 2e-3), `t=${r.t}`);
  assert.ok(approxVec(r.normal, [1, 0, 0]));
  assert.ok(r.samples[0].d < 0, '首采样应为内部负距离');
});
test('差集空腔：命中 inner 且法线指向空腔中心（反向）', () => {
  const scene = load('shell.json');
  const tree = Sdf.compile(scene);
  const r = RayMarch.trace(tree, scene.rays.find((x) => x.id === 'inside'), {});
  assert.strictEqual(r.status, 'hit');
  assert.strictEqual(r.leaf, 'inner');
  assert.strictEqual(r.negated, true);
  assert.ok(approx(r.t, 0.5, 2e-3), `t=${r.t}`);
  assert.ok(approxVec(r.normal, [-1, 0, 0]));
});
test('差集外壁拾取仍指向 outer', () => {
  const scene = load('shell.json');
  const tree = Sdf.compile(scene);
  const r = RayMarch.trace(tree, scene.rays.find((x) => x.id === 'outside'), {});
  assert.strictEqual(r.status, 'hit');
  assert.strictEqual(r.leaf, 'outer');
  assert.strictEqual(r.negated, false);
});

console.log('5) miss 与 iteration_limit 区分');
test('越界射线 status=miss 且 t=20', () => {
  const scene = load('sphere.json');
  const tree = Sdf.compile(scene);
  const r = RayMarch.trace(tree, scene.rays.find((x) => x.id === 'miss'), {});
  assert.strictEqual(r.status, 'miss');
  assert.strictEqual(r.t, 20);
});
test('max_steps=1 强制耗尽，状态为 iteration_limit 而非 miss', () => {
  const scene = load('sphere.json');
  const tree = Sdf.compile(scene);
  const r = RayMarch.trace(tree, scene.rays.find((x) => x.id === 'outside'), { maxSteps: 1 });
  assert.strictEqual(r.status, 'iteration_limit');
  assert.strictEqual(r.steps, 1);
  assert.ok(r.lastDistance !== null);
});
test('max_steps 钳制在 [1,4096]', () => {
  assert.strictEqual(RayMarch.normalizeMaxSteps(0), 512);
  assert.strictEqual(RayMarch.normalizeMaxSteps(99999), 4096);
  assert.strictEqual(RayMarch.normalizeMaxSteps(100), 100);
});

console.log('6) CSG 相等取左与叶编号');
test('并集相等时取左分支叶', () => {
  const data = {
    nodes: {
      L: { kind: 'sphere', radius: 1 },
      R: { kind: 'sphere', radius: 1 },
      u: { kind: 'union', left: 'L', right: 'R' },
    },
    root: 'u', rays: [],
  };
  const tree = Sdf.compile(data);
  const f = Sdf.evalField(tree, 'u', 0, 0, 0);
  assert.strictEqual(f.leaf, 'L');
});
test('交集与差集在完全包含关系下的符号', () => {
  const data = load('shell.json');
  const tree = Sdf.compile(data);
  const origin = [0, 0, 0];
  const f = Sdf.evalField(tree, 'cut', ...origin);
  // 空腔内：outer 场 -1，-inner 场 +0.5，max => +0.5（在实体外/空腔内为正）
  assert.ok(approx(f.d, 0.5, 1e-9), `d=${f.d}`);
});

console.log('7) 叶公式与嵌套变换');
test('盒：角外距离、面外距离、内部负场', () => {
  const data = { nodes: { b: { kind: 'box', half_size: [1, 2, 3] } }, root: 'b', rays: [] };
  const tree = Sdf.compile(data);
  // 面外 1 单位（x 方向）：d=1
  assert.ok(approx(Sdf.evalDistance(tree, 'b', 2, 0, 0), 1, 1e-9));
  // 角外：q=(1,1,1) -> |q| = sqrt(3)
  assert.ok(approx(Sdf.evalDistance(tree, 'b', 2, 3, 4), Math.sqrt(3), 1e-9));
  // 内部：max(q)=0（点在盒内），min(...,0)=0 -> d=0 边界；深内部取最大分量
  assert.ok(approx(Sdf.evalDistance(tree, 'b', 0, 0, 0), -1, 1e-9)); // max(-1,-2,-3)=-1
  assert.ok(approx(Sdf.evalDistance(tree, 'b', 0, 0, 3.5), 0.5, 1e-9));
});
test('环面（绕 Y）：轴上点与管顶距离', () => {
  const data = { nodes: { t: { kind: 'torus', major: 1, minor: 0.2 } }, root: 't', rays: [] };
  const tree = Sdf.compile(data);
  // 原点：radial = |(0,0)|-1 = -1，d = hypot(-1,0)-0.2 = 0.8（在环面包围空腔内、实体外）
  assert.ok(approx(Sdf.evalDistance(tree, 't', 0, 0, 0), 0.8, 1e-9));
  // 管顶 x=major+minor：radial=0.2，d=hypot(0.2,0)-0.2=0
  assert.ok(approx(Sdf.evalDistance(tree, 't', 1.2, 0, 0), 0, 1e-9));
  // 环心管内：x=1（radial=0），y=0.1 -> d=0.1-0.2=-0.1
  assert.ok(approx(Sdf.evalDistance(tree, 't', 1, 0.1, 0), -0.1, 1e-9));
});
test('内部节点 matrix：嵌套 σ_min 链与局部系布尔运算', () => {
  // 差集节点整体 z 向缩放 0.4：子树在节点局部系求值后再乘 0.4
  const data = {
    nodes: {
      outer: { kind: 'sphere', radius: 1 },
      inner: { kind: 'sphere', radius: 0.5 },
      cut: {
        kind: 'difference', left: 'outer', right: 'inner',
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 1],
      },
    },
    root: 'cut',
    rays: [{ id: 'z', origin: [0, 0, 3], direction: [0, 0, -1] }],
  };
  const v = SdfValidate.validateScene(data);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const tree = Sdf.compile(data);
  // 世界点 (0,0,z)：局部 z'=z/0.4，外壳在局部 z'=1 => 世界 z=0.4
  const r = RayMarch.trace(tree, data.rays[0], {});
  assert.strictEqual(r.status, 'hit', r.status);
  assert.ok(approx(r.point[2], 0.4, 5e-3), `z=${r.point[2]}`);
  assert.strictEqual(r.leaf, 'outer');
  // 内部起点 (0,0,0.2) 在局部系 (0,0,0.5)：恰为 inner 表面
  const r2 = RayMarch.trace(tree, { origin: [0, 0, 0], direction: [0, 0, 1] }, {});
  assert.strictEqual(r2.status, 'hit');
  assert.strictEqual(r2.leaf, 'inner');
  assert.strictEqual(r2.negated, true);
  assert.ok(approx(r2.point[2], 0.2, 5e-3), `z=${r2.point[2]}`);
});
test('保守性随机抽查：球步进命中点到真实椭球面残差有界', () => {
  // 随机 20 个方向，检查非均匀缩放下不跨表面
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const scene = load('scaled.json');
  const tree = Sdf.compile(scene);
  for (let i = 0; i < 20; i++) {
    const d = Mat4.normalize3([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
    const r = RayMarch.trace(tree, { origin: [d[0] * 10, d[1] * 10, d[2] * 10], direction: d.map((x) => -x) }, {});
    assert.strictEqual(r.status, 'hit');
    const p = r.point;
    const f = (p[0] * p[0]) / 4 + p[1] * p[1] + (p[2] * p[2]) / 0.25;
    assert.ok(Math.abs(f - 1) < 3e-3, `残差 ${Math.abs(f - 1)}`);
  }
});

console.log(`\n${passed} 项通过`);
if (process.exitCode) console.error('存在失败项');
