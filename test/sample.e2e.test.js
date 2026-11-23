/*
 * 端到端：直接导入 samples/relief-crossing-cases.json，
 * 核对样例声明的射线行为与相机渲染管线。
 * 运行：node test/sample.e2e.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HeightField } = require('../src/field.js');
const { traceRay } = require('../src/ray.js');
const R = require('../src/render.js');

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

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'relief-crossing-cases.json'), 'utf8'));
console.log('样例文档结构:');

test('camera 与 light 字段齐全且尺寸在 192×128 以内', () => {
  for (const k of ['o', 'stepX', 'stepY', 'd', 't', 'size']) assert.ok(k in doc.camera, `缺 camera.${k}`);
  assert.ok(doc.camera.size[0] <= 192 && doc.camera.size[1] <= 128);
  for (const k of ['d', 't']) assert.ok(k in doc.light, `缺 light.${k}`);
});

console.log('saddle 用例（格内双穿 / 切触 / 区间裁剪）:');
const saddleDoc = doc.cases.find((c) => c.id === 'saddle');
const saddle = new HeightField(saddleDoc);

test('rays[0] 格内两次穿越，首根 t=0.25', () => {
  const r = saddleDoc.rays[0];
  const tr = traceRay(saddle, r.o, r.d, r.t[0], r.t[1]);
  assert.strictEqual(tr.hits.length, 2);
  approx(tr.hits[0].t, 0.25);
  approx(tr.hits[1].t, 0.75);
});

test('rays[1] 切触二重根计入，t=0.5', () => {
  const r = saddleDoc.rays[1];
  const tr = traceRay(saddle, r.o, r.d, r.t[0], r.t[1]);
  assert.ok(tr.hit && tr.hit.tangent);
  approx(tr.hit.t, 0.5);
});

test('rays[2] 区间 [0.5,1] 只保留 t=0.75', () => {
  const r = saddleDoc.rays[2];
  const tr = traceRay(saddle, r.o, r.d, r.t[0], r.t[1]);
  assert.strictEqual(tr.hits.length, 1);
  approx(tr.hit.t, 0.75);
});

console.log('wrap 用例（周期接缝）:');
const wrapDoc = doc.cases.find((c) => c.id === 'wrap');
const wrap = new HeightField(wrapDoc);

test('周期等价位置的射线命中高度与法线完全一致（无接缝亮线）', () => {
  // periodX=3：x=0.5、x=3.5、x=-2.5 是同一周期位置（u=0.5，h=1）
  const origins = [[0.5, 0.25, 3], [3.5, 0.25, 3], [-2.5, 0.25, 3]];
  const traces = origins.map((o) => traceRay(wrap, o, [0, 0, -1], 0, 4));
  assert.ok(traces.every((t) => t.hit));
  for (let i = 1; i < traces.length; i++) {
    approx(traces[0].hit.point[2], traces[i].hit.point[2]);
    for (let k = 0; k < 3; k++) approx(traces[0].hit.normal[k], traces[i].hit.normal[k], 1e-12);
    assert.deepStrictEqual(traces[0].hit.nodeCell, traces[i].hit.nodeCell);
  }
  // 世界格不同、节点格相同
  const cells = traces.map((t) => t.hit.cell[0]);
  assert.strictEqual(new Set(cells).size, 3);
});

test('样例声明的两条 wrap 射线都能稳定求交（负格与跨周期格）', () => {
  const traces = wrapDoc.rays.map((r) => traceRay(wrap, r.o, r.d, r.t[0], r.t[1]));
  assert.ok(traces.every((t) => t.hit));
  assert.ok(traces[0].hit.cell[0] < 0, '第一条落在负世界格');
  assert.ok(traces[1].hit.cell[0] >= 3, '第二条落在跨周期世界格');
});

console.log('渲染管线:');

test('三种模式都能渲染且每像素保留 trace', () => {
  const cam = { ...doc.camera, size: [24, 16] };
  const result = R.render(wrap, cam, doc.light);
  assert.strictEqual(result.width, 24);
  assert.strictEqual(result.height, 16);
  for (const mode of ['depth', 'normal', 'lit']) {
    R.shade(result, mode, cam, doc.light);
    assert.ok(result.pixels.every((row) => row.every((p) => p.rgb.length === 3)));
  }
  // 每个像素都带完整 trace（点击展开用）
  assert.ok(result.pixels[0][0].trace.cells.length >= 1 || result.pixels[0][0].trace.missReason);
});

test('相机尺寸超 192×128 被拒绝', () => {
  assert.throws(() => R.render(wrap, { ...doc.camera, size: [193, 128] }, doc.light));
});

test('受光图阴影像素可追踪到遮挡物', () => {
  const cam = { ...doc.camera, size: [24, 16] };
  const result = R.render(wrap, cam, doc.light);
  let shadowPixels = 0;
  for (const row of result.pixels) {
    for (const p of row) {
      if (p.shadow && p.shadow.shadowed) {
        shadowPixels++;
        assert.ok(p.shadow.blocker.t >= doc.light.t[0]);
      }
    }
  }
  assert.ok(shadowPixels > 0, '该灯向下应有自阴影像素');
});

console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
