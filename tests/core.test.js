#!/usr/bin/env node
/* 核心函数单元测试：PGM 解析、姿态方向约定、评分、自动阈值、去重。 */
'use strict';
const assert = require('assert');
const ML = require('../js/locator.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { failed++; console.error('✗ ' + name + '\n  ' + e.message); }
}

function pgm(width, height, fill, extras) {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = typeof fill === 'function' ? fill(i % width, Math.floor(i / width)) : fill;
  return { width, height, data, ...(extras || {}) };
}

test('PGM P5 解析（含注释与多空白）', () => {
  const pixels = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const head = new TextEncoder().encode('P5\n# 注释行\n3 2\n255\n');
  const buf = new Uint8Array(head.length + 6);
  buf.set(head); buf.set(pixels, head.length);
  const img = ML.parsePGM(buf);
  assert.strictEqual(img.width, 3);
  assert.strictEqual(img.height, 2);
  assert.deepStrictEqual(Array.from(img.data), [1, 2, 3, 4, 5, 6]);
});

test('PGM P2 解析', () => {
  const buf = new TextEncoder().encode('P2\n2 2\n255\n0 128 255 7\n');
  const img = ML.parsePGM(buf);
  assert.deepStrictEqual(Array.from(img.data), [0, 128, 255, 7]);
});

test('PGM 拒绝 16 位与非 PGM', () => {
  assert.throws(() => ML.parsePGM(new TextEncoder().encode('P5\n2 2\n65535\n\u0000\u0000\u0000\u0000')), /8 位/);
  assert.throws(() => ML.parsePGM(new TextEncoder().encode('hello world')), /仅支持/);
  assert.throws(() => ML.parsePGM(new TextEncoder().encode('P5\n4 4\n255\n\u0001\u0002')), /像素数据不足/);
});

test('姿态方向：顺时针为正，y 向下', () => {
  const offs = ML._internal.mirroredOffset({ count: 1, x: new Float64Array([11]), y: new Float64Array([10]) }, 10, 10, false);
  const pr = ML._internal.projectOffsets(offs, { x: 50, y: 60, angle: 90, scale: 2 });
  // 模板偏移 (1,0)，顺时针 90° 后指向 +y；尺度 2
  assert.ok(Math.abs(pr.qx[0] - 50) < 1e-9);
  assert.ok(Math.abs(pr.qy[0] - 62) < 1e-9);
});

test('姿态方向：镜像先于缩放旋转', () => {
  const offs = ML._internal.mirroredOffset({ count: 1, x: new Float64Array([13]), y: new Float64Array([10]) }, 10, 10, true);
  const pr = ML._internal.projectOffsets(offs, { x: 0, y: 0, angle: 0, scale: 3 });
  // 镜像把 x 偏移变成 -3，再缩放 3 → -9
  assert.ok(Math.abs(pr.qx[0] + 9) < 1e-9);
  assert.ok(Math.abs(pr.qy[0]) < 1e-9);
});

test('评分：已知姿态在场景中达到满分', () => {
  // 模板 9×9，中心 3×3 亮块，锚点取模板中心 (4,4)。
  // 场景中心放 12×12 亮块（尺度 4），同向 0°。
  const tpl = pgm(9, 9, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5) ? 240 : 20);
  const scene = pgm(80, 80, (x, y) => (x >= 34 && x <= 45 && y >= 34 && y <= 45) ? 240 : 20);
  const s = ML.sobelEdges(scene, 200);
  const t = ML.sobelEdges(tpl, 200);
  assert.ok(t.count > 0);
  const ev = ML.evaluatePose({ x: 39.5, y: 39.5, angle: 0, scale: 4, mirror: false }, t, s, { anchor: [4, 4], keepPoints: true });
  assert.ok(ev.coverage > 0.9, 'coverage=' + ev.coverage);
  assert.ok(isFinite(ev.meanDist) && ev.meanDist < 2.5, 'meanDist=' + ev.meanDist);
  let flagged = 0;
  for (let i = 0; i < t.count; i++) if (ev.flags[i]) { flagged++; assert.ok(ev.pairIdx[i] >= 0); }
  assert.strictEqual(flagged, ev.matched);
});

test('评分：偏离后覆盖率下降', () => {
  const tpl = pgm(9, 9, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5) ? 240 : 20);
  const scene = pgm(80, 80, (x, y) => (x >= 34 && x <= 45 && y >= 34 && y <= 45) ? 240 : 20);
  const s = ML.sobelEdges(scene, 200), t = ML.sobelEdges(tpl, 200);
  const near = ML.evaluatePose({ x: 39.5, y: 39.5, angle: 0, scale: 4, mirror: false }, t, s, { anchor: [4, 4] });
  const far = ML.evaluatePose({ x: 62, y: 39.5, angle: 0, scale: 4, mirror: false }, t, s, { anchor: [4, 4] });
  assert.ok(far.coverage < near.coverage, `far=${far.coverage} near=${near.coverage}`);
});

test('自动边缘强度随模板对比度缩放', () => {
  const strong = pgm(20, 20, (x, y) => (x >= 5 && x <= 14 && y >= 5 && y <= 14) ? 240 : 20);
  const weak = pgm(20, 20, (x, y) => (x >= 5 && x <= 14 && y >= 5 && y <= 14) ? 120 : 20);
  const ts = ML.autoEdgeThreshold(strong);
  const tw = ML.autoEdgeThreshold(weak);
  assert.ok(ts > 0 && tw > 0);
  assert.ok(ts > tw * 1.3, `strong=${ts} weak=${tw}`);
});

test('去重：同姿态近邻只留一个，相邻真实标记都保留', () => {
  const opts = { angleStep: 12, scaleStep: 0.1 };
  const extent = 40;
  const a = { pose: { x: 50, y: 50, angle: 10, scale: 1, mirror: false }, coverage: 0.9, meanDist: 0.5 };
  const a2 = { pose: { x: 50.5, y: 50.2, angle: 11, scale: 1.02, mirror: false }, coverage: 0.88, meanDist: 0.6 };
  const b = { pose: { x: 70, y: 50, angle: 10, scale: 1, mirror: false }, coverage: 0.87, meanDist: 0.5 };
  const kept = ML.dedupe([a, a2, b], opts, extent);
  assert.strictEqual(kept.length, 2);
});

test('结果排序：覆盖率降序、均距升序', () => {
  const list = [
    { coverage: 0.8, meanDist: 0.5, x: 0, y: 0 },
    { coverage: 0.9, meanDist: 1.0, x: 0, y: 0 },
    { coverage: 0.9, meanDist: 0.4, x: 0, y: 0 }
  ];
  ML.sortResults(list);
  assert.strictEqual(list[0].coverage, 0.9);
  assert.strictEqual(list[0].meanDist, 0.4);
  assert.strictEqual(list[2].coverage, 0.8);
});

test('角度列表覆盖 -180..180，尺度列表包含端点', () => {
  const angles = ML.buildAngleList(12);
  assert.strictEqual(angles.length, 30);
  assert.strictEqual(angles[0], -180);
  assert.ok(angles[angles.length - 1] < 180);
  const scales = ML.buildScaleList(0.75, 1.4, 0.1);
  assert.ok(Math.abs(scales[0] - 0.75) < 1e-9);
  assert.ok(Math.abs(scales[scales.length - 1] - 1.4) < 1e-9);
});

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
