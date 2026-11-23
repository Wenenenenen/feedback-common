/*
 * 核心算法测试：node test/trace.test.js
 * 覆盖：稳定求根、格内双穿、切触计入、半开归属/去重、
 *       周期接缝一致性、梯度法线、自阴影。
 */
const assert = require('assert');
const M = require('../src/math.js');
const { HeightField } = require('../src/field.js');
const { traceRay, shadowRay } = require('../src/ray.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
const approx = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ---------- 稳定求根 ----------
console.log('solveQuadratic:');
test('两实根升序', () => {
  const r = M.solveQuadratic(1, -3, 2);
  assert.strictEqual(r.roots.length, 2);
  approx(r.roots[0], 1); approx(r.roots[1], 2);
  assert.strictEqual(r.tangent, false);
});
test('二重根判为切触且保留一个根', () => {
  const r = M.solveQuadratic(1, -2, 1); // (t-1)^2
  assert.strictEqual(r.roots.length, 1);
  approx(r.roots[0], 1);
  assert.strictEqual(r.tangent, true);
});
test('轻微负判别式夹到 0（数值误差下的切触）', () => {
  // 构造 disc 略负：放大系数制造舍入误差
  const r = M.solveQuadratic(1e8, 2e8, 1e8);
  assert.strictEqual(r.tangent, true);
  assert.strictEqual(r.roots.length, 1);
});
test('真正无实根返回空', () => {
  const r = M.solveQuadratic(1, 0, 1);
  assert.strictEqual(r.roots.length, 0);
});
test('退化为一次方程', () => {
  const r = M.solveQuadratic(0, 2, -4);
  approx(r.roots[0], 2);
});

// ---------- 双线性 saddle 场 ----------
// height[j][i] 行主序（i 沿 x/u，j 沿 y/v），spacing [sx=2, sy=1]
const saddle = new HeightField({ spacing: [2, 1], height: [[0, 2], [2, 0]] });
console.log('saddle 场:');

test('格内双穿：水平射线两次穿越都保留（对照样例 rays[0]）', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0, 1);
  assert.strictEqual(tr.hits.length, 2, '步进会漏掉的第二次穿越必须保留');
  approx(tr.hits[0].t, 0.25);
  approx(tr.hits[1].t, 0.75);
  assert.strictEqual(tr.hit.t, 0.25, '首个命中取小 t');
});

test('切触：样例 rays[1] 的二重根计入命中', () => {
  const tr = traceRay(saddle, [0, 0, 1], [2, 1, 0], 0, 1);
  assert.ok(tr.hit, '切触必须算命中');
  assert.strictEqual(tr.hit.tangent, true);
  approx(tr.hit.t, 0.5);
});

test('切触点落在裁剪区间外 => 未命中（对照样例 rays[2]）', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0.5, 1);
  assert.strictEqual(tr.hits.length, 1, '只剩区间内的一个根');
  approx(tr.hit.t, 0.75); // 0.25 的根被区间起点裁掉，0.75 成为首命中
});

test('无穿越射线正确报未命中（全程位于曲面上方）', () => {
  const tr = traceRay(saddle, [0, 0, 2], [2, 1, 0], 0, 1);
  assert.strictEqual(tr.hit, null);
});

test('区间起点在 t>0（裁剪后 DDA 起点正确）', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0.5, 1);
  // 起点被裁到 t=0.5，DDA 从该点所在格继续，仍能拿到 0.75 的根
  approx(tr.hit.t, 0.75);
});

// ---------- 周期 wrap 场 ----------
// 行主序 height[j][i]：脊线（h=2）在数组列 1（物理 x=1），沿 y 方向恒定，periodX=3
const wrap = new HeightField({
  spacing: [1, 1],
  height: [[0, 2, 0, 0], [0, 2, 0, 0]],
});
console.log('wrap 周期场（periodX=3，脊线在 x=1）:');

test('接缝两侧等效射线命中高度与法线一致（消除亮线）', () => {
  // x=0.5、x=3.5、x=-2.5 互为周期 3 的等价位置，u=0.5 => h=1
  const origins = [[0.5, 0.25, 3], [3.5, 0.25, 3], [-2.5, 0.25, 3]];
  const traces = origins.map((o) => traceRay(wrap, o, [0, 0, -1], 0, 4));
  for (const tr of traces) {
    assert.ok(tr.hit);
    approx(tr.hit.point[2], 1);
  }
  for (let i = 1; i < traces.length; i++) {
    for (let k = 0; k < 3; k++) {
      approx(traces[0].hit.normal[k], traces[i].hit.normal[k], 1e-10);
    }
    assert.deepStrictEqual(traces[0].hit.nodeCell, traces[i].hit.nodeCell);
  }
});

test('周期回绕：世界格坐标 mod 到节点格', () => {
  const tr = traceRay(wrap, [3.5, 0.25, 3], [0, 0, -1], 0, 4);
  // x=3.5 => 世界格 3 => 节点格 mod(3,3)=0，u=0.5
  assert.deepStrictEqual(tr.hit.cell, [3, 0]);
  assert.deepStrictEqual(tr.hit.nodeCell, [0, 0]);
  approx(tr.hit.u, 0.5);
});

test('脊线 x=1 垂直射线命中 z=2', () => {
  const tr = traceRay(wrap, [1, 0.5, 3], [0, 0, -1], 0, 4);
  approx(tr.hit.point[2], 2);
});

// ---------- 半开归属与去重 ----------
console.log('格边格角半开归属:');

test('斜射线在格边上的根让位给半开归属格，命中只记一次', () => {
  // 沿 x 的斜坡 h=u（行主序：每行 [0,1,2,3]）；射线 v=0.5、z=0.5 水平向 +x，
  // 交点 h=u=0.5 在格 0 内部（t=0.125）；z=1 的射线则在 x=1 竖格边上（t=0.25）
  const rows = [[0, 1, 2, 3], [0, 1, 2, 3]];
  const field = new HeightField({ spacing: [1, 1], height: rows });
  const tr = traceRay(field, [0, 0.5, 1], [4, 0, 0], 0, 1);
  const edgeHits = tr.hits.filter((h) => Math.abs(h.t - 0.25) < 1e-8);
  assert.strictEqual(edgeHits.length, 1, '格边同一命中不得重复');
  assert.deepStrictEqual(edgeHits[0].cell, [1, 0], '半开归属 floor(1/1)=1');
  assert.strictEqual(edgeHits[0].kind, '格边');
  // 让出该根的格（cell 0）应保留带原因的拒绝记录
  const cell0 = tr.cells.find((c) => c.cx === 0 && c.cy === 0);
  assert.ok(cell0.roots.some((r) => r.status === 'rejected' && r.reason.includes('半开归属')));
});

test('格角点归属右上格且不重复', () => {
  // 同一场：射线在 t=0.5 穿过格角 (1,1)，此处 h=1
  const rows = [[0, 1, 2, 3], [0, 1, 2, 3]];
  const field = new HeightField({ spacing: [1, 1], height: rows });
  const tr = traceRay(field, [0, 0, 1], [2, 2, 0], 0, 1);
  const cornerHits = tr.hits.filter((h) => Math.abs(h.t - 0.5) < 1e-8);
  assert.strictEqual(cornerHits.length, 1, '格角命中只记一次');
  assert.deepStrictEqual(cornerHits[0].cell, [1, 1]);
  assert.strictEqual(cornerHits[0].kind, '格角');
});

test('DDA 跨多格按顺序遍历（含格角同时跨两格）', () => {
  const field = new HeightField({ spacing: [1, 1], height: [[0, 0], [0, 0]] });
  const tr = traceRay(field, [-0.5, -0.5, 1], [2, 2, -1], 0, 1);
  const keys = tr.cells.map((c) => `${c.cx},${c.cy}`);
  assert.deepStrictEqual(keys, ['-1,-1', '0,0', '1,1']);
});

// ---------- 梯度法线 ----------
console.log('梯度法线:');

test('物理间距参与梯度（sx=2 使 x 方向法线分量减半）', () => {
  // 斜面 h=u：j=0 行 [0,1]，j=1 行 [0,1]
  const f2 = new HeightField({ spacing: [2, 1], height: [[0, 1], [0, 1]] });
  const f1 = new HeightField({ spacing: [1, 1], height: [[0, 1], [0, 1]] });
  const tr2 = traceRay(f2, [1, 0.5, 2], [0, 0, -1], 0, 3);
  const tr1 = traceRay(f1, [0.5, 0.5, 2], [0, 0, -1], 0, 3);
  // sx=2: n=(-0.5,0,1)/|..|；sx=1: n=(-1,0,1)/|..|
  approx(tr2.hit.normal[0], -0.5 / Math.hypot(0.5, 1));
  approx(tr1.hit.normal[0], -1 / Math.hypot(1, 1));
  assert.ok(Math.abs(tr2.hit.normal[0]) < Math.abs(tr1.hit.normal[0]));
});

test('法线恒朝上方（nz>0）', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0, 1);
  for (const h of tr.hits) assert.ok(h.normal[2] > 0);
});

test('解析法线与数值差分一致', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0, 1);
  const h = tr.hit;
  const num = M.numericalNormal(saddle, h.cell[0], h.cell[1], h.u, h.v);
  for (let k = 0; k < 3; k++) approx(h.normal[k], num[k], 1e-5);
});

// ---------- 自阴影 ----------
console.log('自阴影:');

test('向上的灯不被挡 => 无阴影', () => {
  const tr = traceRay(wrap, [1, 0.5, 3], [0, 0, -1], 0, 4);
  const sh = shadowRay(wrap, tr.hit.point, [0.3, 0, 1], 1e-5, 5);
  assert.strictEqual(sh.shadowed, false);
});

test('水平灯被相邻周期的脊线挡住 => 阴影', () => {
  // 命中点在谷 x=0 处（z=0），灯朝 +x，脊线 x=1 高 2
  const tr = traceRay(wrap, [0, 0.5, 3], [0, 0, -1], 0, 4);
  approx(tr.hit.point[2], 0, 1e-8);
  const sh = shadowRay(wrap, tr.hit.point, [1, 0, 0.3], 1e-5, 5);
  assert.strictEqual(sh.shadowed, true);
  assert.ok(sh.blocker);
});

test('阴影射线区间排除近段自交', () => {
  const tr = traceRay(wrap, [1, 0.5, 3], [0, 0, -1], 0, 4);
  // tmin=1e-5 偏移：正上方灯不会把自身当遮挡
  const sh = shadowRay(wrap, tr.hit.point, [0, 0, 1], 1e-5, 5);
  assert.strictEqual(sh.shadowed, false);
});

// ---------- 边界情况 ----------
console.log('边界情况:');

test('D 保留原长度：缩放 D 等价缩放 t（命中点不变）', () => {
  const a = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0, 1);
  const b = traceRay(saddle, [0, 0, 0.75], [4, 2, 0], 0, 0.5);
  assert.strictEqual(b.hits.length, 2);
  approx(b.hits[0].t, a.hits[0].t / 2);
  approx(b.hits[0].point[0], a.hits[0].point[0]);
  approx(b.hits[1].point[0], a.hits[1].point[0]);
});

test('闭合区间端点上的根计入', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 0.25, 0.75);
  assert.strictEqual(tr.hits.length, 2, '两个端点根都计入');
  approx(tr.hit.t, 0.25);
  approx(tr.hits[1].t, 0.75);
});

test('tmax<tmin 报空区间', () => {
  const tr = traceRay(saddle, [0, 0, 0.75], [2, 1, 0], 1, 0);
  assert.strictEqual(tr.hit, null);
  assert.ok(tr.missReason.includes('空'));
});

test('XY 投影为零的静止射线也能求交', () => {
  // 垂直向下，只经过一个格；起点 (0.5,0.25) 在格内
  const tr = traceRay(saddle, [0.5, 0.25, 2], [0, 0, -1], 0, 3);
  assert.ok(tr.hit);
  assert.strictEqual(tr.cells.length, 1);
});

test('输入校验拒绝超 128 节点与坏 spacing', () => {
  assert.throws(() => new HeightField({
    spacing: [1, 1],
    height: [new Array(129).fill(0), new Array(129).fill(0)],
  }));
  assert.throws(() => new HeightField({ spacing: [-1, 1], height: [[0, 1], [0, 1]] }));
});

console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
