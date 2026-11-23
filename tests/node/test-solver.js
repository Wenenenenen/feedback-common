/*
 * Node 正确性测试：node tests/node/test-solver.js
 * 用 `node -I` 运行，仅依赖内置断言。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const NR = require(path.join(__dirname, '..', '..', 'js', 'solver-core.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
    process.exitCode = 1;
  }
}

function flatSamples(n, nx, ny, nz, c) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [nx, ny, nz, c];
  return out;
}

/* 由高度函数生成解析法线样本：
 * gx = dh/dx, gy = dh/dy，法线正比于 (-gx, -gy, 1) */
function analyticField(W, H, dx, dy, gradFn, opts) {
  opts = opts || {};
  const samples = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (opts.hole && opts.hole(y, x)) { samples.push(null); continue; }
      const g = gradFn(x, y);
      let gx = g.gx, gy = g.gy;
      if (opts.confZero && opts.confZero(y, x)) {
        // 置信度 0 的格：法线照样填，但不产生边
      }
      const inv = 1 / Math.hypot(gx, gy, 1);
      let c = opts.conf ? opts.conf(y, x) : 8;
      if (opts.confZero && opts.confZero(y, x)) c = 0;
      samples.push([-gx * inv, -gy * inv, inv, c]);
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ */
console.log('1. 基础与校验');

test('样例文件 3x2 可解且通过 1e-7 验收', () => {
  const fs = require('fs');
  const input = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'samples', 'normal-relief.json'), 'utf8'));
  const r = NR.solve(input);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.verifyPassed, true, 'worst=' + r.worstCellRatio);
  assert.ok(r.worstCellRatio <= 1e-7);
  // 恒定梯度 + 锁 0：高度应线性
  const h = r.heights;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      const expectX = -(-0.3 / 1) * 1 * x; // g = -nx/nz * dx = 0.3
      const expectY = -(0.2 / 1) * 1.5 * y;
      assert.ok(Math.abs(h[y * 3 + x] - (expectX + expectY)) < 1e-9,
        'cell ' + (y * 3 + x) + ' got ' + h[y * 3 + x]);
    }
  }
});

test('非法锁点：孔格、重复、越界、超高都报格号', () => {
  const input = {
    width: 3, height: 2, spacing: [1, 1], wrap: [false, false],
    samples: [[0, 0, 1, 4], null, [0, 0, 1, 4], [0, 0, 1, 4], [0, 0, 1, 4], [0, 0, 1, 4]],
    pins: [[1, 0], [0, 1], [0, 2], [9, 0], [2, 99999]]
  };
  const v = NR.validateInput(input);
  assert.strictEqual(v.ok, false);
  const msg = v.errors.join('|');
  assert.ok(msg.includes('1'), '应标明孔格号 1: ' + msg);
  assert.ok(msg.includes('重复') && msg.includes('0'), '应标明重复格号 0');
  assert.ok(msg.includes('9'), '应标明越界格号 9');
  assert.ok(msg.includes('99999') && msg.includes('2'), '应标明超高锁点格号 2');
});

test('结构校验：spacing / wrap / 样本长度 / 置信度范围', () => {
  const base = {
    width: 3, height: 2, spacing: [1, 1], wrap: [false, false],
    samples: flatSamples(6, 0, 0, 1, 4), pins: []
  };
  assert.ok(!NR.validateInput(Object.assign({}, base, { spacing: [0.1, 1] })).ok);
  assert.ok(!NR.validateInput(Object.assign({}, base, { spacing: [5, 1] })).ok);
  assert.ok(!NR.validateInput(Object.assign({}, base, { wrap: [true, false], width: 2 })).ok);
  const bad = JSON.parse(JSON.stringify(base));
  bad.samples = bad.samples.slice(0, 5);
  assert.ok(!NR.validateInput(bad).ok);
  const bad2 = JSON.parse(JSON.stringify(base));
  bad2.samples[0] = [0, 0, 1, 17];
  assert.ok(!NR.validateInput(bad2).ok);
  const bad3 = JSON.parse(JSON.stringify(base));
  bad3.samples[0] = [2, 0, 1, 4];
  assert.ok(!NR.validateInput(bad3).ok);
  const bad4 = JSON.parse(JSON.stringify(base));
  bad4.samples[0] = [0, 0, 0.1, 4];
  assert.ok(!NR.validateInput(bad4).ok);
});

/* ------------------------------------------------------------------ */
console.log('2. 解析案例');

test('无周期平面：线性高度精确恢复（含权重均值）', () => {
  // gx=2, gy=0，dx=0.5 -> 边 g=1
  const W = 5, H = 3, dx = 0.5, dy = 1;
  const samples = analyticField(W, H, dx, dy, () => ({ gx: 2, gy: 0 }));
  const r = NR.solve({
    width: W, height: H, spacing: [dx, dy], wrap: [false, false],
    samples, pins: [[0, 0]]
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.verifyPassed, 'worst=' + r.worstCellRatio);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.ok(Math.abs(r.heights[y * W + x] - 2 * x * dx) < 1e-9);
    }
  }
});

test('两向周期 + 可积周期场：通过 1e-7 验收，周期边齐全', () => {
  const W = 16, H = 12, dx = 0.7, dy = 1.3;
  const kx = 2 * Math.PI / (W * dx), ky = 2 * Math.PI / (H * dy);
  const A = 1.7;
  const grad = (x, y) => ({
    gx: A * kx * Math.cos(kx * x * dx) * Math.sin(ky * y * dy),
    gy: A * ky * Math.sin(kx * x * dx) * Math.cos(ky * y * dy)
  });
  const samples = analyticField(W, H, dx, dy, grad);
  const r = NR.solve({
    width: W, height: H, spacing: [dx, dy], wrap: [true, true],
    samples, pins: []
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.verifyPassed, 'worst=' + r.worstCellRatio);
  // 高度与真值只差一个常数（单连通周期块自动锁 0）；
  // 边约束用两端均值梯度，与单点解析梯度有 O(dx²) 离散差，属正常量级
  const h0 = (x, y) => A * Math.sin(kx * x * dx) * Math.sin(ky * y * dy);
  const off = r.heights[0] - h0(0, 0);
  let maxErr = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      maxErr = Math.max(maxErr, Math.abs(r.heights[y * W + x] - (h0(x, y) + off)));
    }
  }
  assert.ok(maxErr < 0.05, 'maxErr=' + maxErr);
  // 周期边确实存在且数量正确（每列/每行一条回绕边）
  let wrapCount = 0;
  for (let e = 0; e < r.edgeCount; e++) if (r.model.edgeWrap[e]) wrapCount++;
  assert.strictEqual(wrapCount, W + H);
});

test('非周期线性场：均值梯度严格一致，残差降到机器精度', () => {
  const W = 12, H = 9, dx = 0.6, dy = 1.1;
  const gx = 1.4, gy = -0.8;
  const samples = analyticField(W, H, dx, dy, () => ({ gx, gy }));
  const r = NR.solve({
    width: W, height: H, spacing: [dx, dy], wrap: [false, false],
    samples, pins: [[0, 2.5]]
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.verifyPassed);
  assert.ok(r.wrms < 1e-10, 'wrms=' + r.wrms);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.ok(Math.abs(r.heights[y * W + x] - (2.5 + gx * x * dx + gy * y * dy)) < 1e-9);
    }
  }
});

test('残差符号约定：r = h终点 - h起点 - g', () => {
  // 一格边，g=0.3，锁起点 0、终点 10 -> r = 10 - 0 - 0.3 = 9.7
  const r = NR.solve({
    width: 2, height: 1, spacing: [1, 1], wrap: [false, false],
    samples: [[-0.3, 0, 1, 4], [-0.3, 0, 1, 4]],
    pins: [[0, 0], [1, 10]]
  });
  assert.strictEqual(r.edgeCount, 1);
  assert.strictEqual(r.model.edgeA[0], 0);
  assert.strictEqual(r.model.edgeB[0], 1);
  assert.ok(Math.abs(r.edgeResidual[0] - 9.7) < 1e-12);
});

/* ------------------------------------------------------------------ */
console.log('3. 孔、连通块与锁点');

test('孔把网格分成多块：每块自动锁最小编号格到 0', () => {
  // 4x1，格 1 是孔 -> 块 {0} 与 {2,3}
  const r = NR.solve({
    width: 4, height: 1, spacing: [1, 1], wrap: [false, false],
    samples: [[0, 0, 1, 4], null, [0, 0, 1, 4], [0, 0, 1, 4]],
    pins: []
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.model.autoPins).sort(), [0, 2]);
  assert.strictEqual(r.heights[0], 0);
  assert.strictEqual(r.heights[2], 0);
  assert.ok(Number.isNaN(r.heights[1]));
  assert.strictEqual(r.edgeCount, 1); // 只剩 2->3
});

test('用户锁定的连通块不再自动加锁，锁高原样保留', () => {
  const r = NR.solve({
    width: 4, height: 1, spacing: [1, 1], wrap: [false, false],
    samples: [[0, 0, 1, 4], null, [0, 0, 1, 4], [0, 0, 1, 4]],
    pins: [[3, 5.5]]
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.model.autoPins), [0]); // 第二块有用户锁
  assert.strictEqual(r.heights[3], 5.5);
  assert.strictEqual(r.heights[2], 5.5); // 块内 g=0
});

test('零置信度格不产生任何边，孤立非孔格自锁 0', () => {
  const r = NR.solve({
    width: 3, height: 1, spacing: [1, 1], wrap: [false, false],
    samples: [[0, 0, 1, 4], [0, 0, 1, 0], [0, 0, 1, 4]],
    pins: []
  });
  assert.strictEqual(r.edgeCount, 0);
  assert.deepStrictEqual(Array.from(r.model.autoPins).sort(), [0, 1, 2]);
  assert.strictEqual(r.nFree, 0);
  assert.strictEqual(r.verifyPassed, true);
});

test('权重取两端较小置信度，且按权重进入残差和', () => {
  // 三个格两条边，置信度 16 与 1：边权应为 1
  const r = NR.solve({
    width: 3, height: 1, spacing: [1, 1], wrap: [false, false],
    samples: [[0, 0, 1, 16], [0, 0, 1, 1], [0, 0, 1, 16]],
    pins: [[0, 0]]
  });
  assert.strictEqual(r.model.edgeW[0], 1);
  assert.strictEqual(r.model.edgeW[1], 1);
  assert.ok(r.verifyPassed);
});

test('周期轴上带孔：周期边只在两端均非孔且权正时生成', () => {
  const r = NR.solve({
    width: 4, height: 1, spacing: [1, 1], wrap: [true, false],
    samples: [[0, 0, 1, 4], [0, 0, 1, 4], null, [0, 0, 1, 4]],
    pins: []
  });
  // 普通边 0->1；孔 2 切断 1->2、2->3；周期边 3->0 两端有效
  assert.strictEqual(r.edgeCount, 2);
  assert.strictEqual(r.model.edgeA[1], 3);
  assert.strictEqual(r.model.edgeB[1], 0);
  assert.strictEqual(r.model.edgeWrap[1], 1);
  assert.ok(r.verifyPassed);
});

/* ------------------------------------------------------------------ */
console.log('4. 性能与数值');

test('384x384 带孔 + 两向周期：15 秒内通过 1e-7 验收', () => {
  const W = 384, H = 384, dx = 1, dy = 1;
  const kx = 2 * Math.PI / (W * dx), ky = 2 * Math.PI / (H * dy);
  const A = 2.5;
  const grad = (x, y) => ({
    gx: A * kx * Math.cos(kx * x * dx) * Math.sin(ky * y * dy),
    gy: A * ky * Math.sin(kx * x * dx) * Math.cos(ky * y * dy)
  });
  // 随机但确定的孔（约 3%）
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const hole = (y, x) => rand() < 0.03;
  const conf = (y, x) => 1 + Math.floor(rand() * 16);
  const samples = analyticField(W, H, dx, dy, grad, { hole, conf });

  const t0 = Date.now();
  const r = NR.solve({
    width: W, height: H, spacing: [dx, dy], wrap: [true, true],
    samples, pins: []
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.verifyPassed, 'worst=' + r.worstCellRatio + ' cell=' + r.worstCell);
  assert.ok(r.worstCellRatio <= 1e-7);
  console.log('    边数=' + r.edgeCount + ' 自由格=' + r.nFree +
    ' 迭代=' + r.iterations + ' 建模=' + r.buildMs.toFixed(0) +
    'ms 求解=' + r.solveMs.toFixed(0) + 'ms 总=' + elapsed + 'ms');
  assert.ok(elapsed < 15000, '总耗时 ' + elapsed + 'ms 超过 15s');
});

test('warm start 后再次求解更快且仍达标', () => {
  const W = 256, H = 256, dx = 0.8, dy = 1.2;
  const kx = 2 * Math.PI / (W * dx), ky = 2 * Math.PI / (H * dy);
  const grad = (x, y) => ({
    gx: Math.cos(kx * x * dx) * Math.sin(ky * y * dy),
    gy: Math.sin(kx * x * dx) * Math.cos(ky * y * dy)
  });
  const samples = analyticField(W, H, dx, dy, grad);
  const input = { width: W, height: H, spacing: [dx, dy], wrap: [true, true], samples, pins: [] };
  const r1 = NR.solve(input);
  assert.ok(r1.verifyPassed);
  const r2 = NR.solve(input, { warm: r1.heights });
  assert.ok(r2.verifyPassed, 'worst=' + r2.worstCellRatio);
  assert.ok(r2.iterations <= r1.iterations);
});

test('取消回调可中止求解且不产生结果覆盖', () => {
  const W = 128, H = 128;
  const grad = (x, y) => ({ gx: Math.sin(x * 0.3), gy: Math.cos(y * 0.2) });
  const samples = analyticField(W, H, 1, 1, grad);
  const v = NR.validateInput({
    width: W, height: H, spacing: [1, 1], wrap: [true, true], samples, pins: []
  });
  const model = NR.buildModel(v.data);
  let calls = 0;
  const out = NR.solveModel(model, { shouldCancel: () => ++calls > 0 });
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(out.heights, undefined);
});

console.log('\n' + (process.exitCode ? '存在失败用例' : passed + ' 个测试全部通过'));
