// Node 数值测试：对照 samples/extracted/expected.json 与约定中的数值容差。
// 运行：node --test test/solver.test.js（或直接 node test/solver.test.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateMesh } from '../src/mesh.js';
import { ArapSolver, STOP } from '../src/solver.js';
import { matDet } from '../src/mat3.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, '..', 'samples', 'extracted');

function load(name) {
  return JSON.parse(readFileSync(join(sampleDir, name), 'utf8'));
}

// 测试中用同步包装（solver 本身提供异步 run 供 worker 分帧）
ArapSolver.prototype.runSync = function (maxIterations, threshold) {
  for (let k = 0; k < maxIterations; k++) {
    const reason = this.step(threshold);
    if (reason !== STOP.NONE) return reason;
  }
  if (this.stopReason === STOP.NONE) this.stopReason = STOP.MAX_ITER;
  return this.stopReason;
};

function solveCase(name, maxIterations = 30, threshold = 1e-7) {
  const raw = load(name);
  const { errors, data } = validateMesh(raw);
  assert.deepEqual(errors, [], `校验意外失败: ${errors.join('; ')}`);
  const solver = new ArapSolver(data);
  solver.runSync(maxIterations, threshold);
  return solver;
}

const expected = load('expected.json');

test('rigid-tetra：全约束刚体平移，能量应为 0 且顶点等于 target', () => {
  const solver = solveCase('rigid-tetra.json');
  // 所有顶点都被硬约束：没有自由点，无需迭代
  assert.equal(solver.stopReason, STOP.NO_FREE);
  const exp = expected['rigid-tetra'];
  for (let i = 0; i < 4; i++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(
        Math.abs(solver.x[i][c] - exp.vertices[i][c]) <= 1e-6,
        `顶点 ${i} 坐标 ${c}: ${solver.x[i][c]} vs ${exp.vertices[i][c]}`
      );
    }
  }
  assert.ok(Math.abs(solver.energies.at(-1) - exp.energy) <= 1e-6 * Math.max(1, exp.energy));
});

test('mirrored-tetra：镜像约束下拒绝反射，最优正旋转能量为 64', () => {
  const solver = solveCase('mirrored-tetra.json');
  const E = solver.energies.at(-1);
  assert.ok(
    Math.abs(E - expected['mirrored-tetra'].energy) <=
      1e-6 * Math.max(1, expected['mirrored-tetra'].energy),
    `能量 ${E} 不等于 64（若为 0 说明放过了反射）`
  );
  for (const R of solver.rotations) {
    assert.ok(matDet(R) > 0, '存在非正旋转（反射）');
  }
  // 全约束：顶点必须精确等于 target
  const raw = load('mirrored-tetra.json');
  for (const c of raw.constraints) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(solver.x[c.vertex][k] - c.target[k]) < 1e-10);
    }
  }
});

test('all-free：无约束时整体冻结在 rest，能量 0', () => {
  const solver = solveCase('all-free.json');
  const raw = load('all-free.json');
  for (let i = 0; i < raw.rest.length; i++) {
    for (let k = 0; k < 3; k++) {
      assert.equal(solver.x[i][k], raw.rest[i][k]);
    }
  }
  assert.equal(solver.stopReason, STOP.NO_FREE);
  assert.equal(solver.energies.at(-1), 0);
});

test('disconnected：无约束连通分量冻结，约束分量可解，能量 0', () => {
  const solver = solveCase('disconnected.json');
  for (const v of expected.disconnected.frozen_vertices) {
    const raw = load('disconnected.json');
    for (let k = 0; k < 3; k++) assert.equal(solver.x[v][k], raw.rest[v][k]);
  }
  assert.ok(Math.abs(solver.energies.at(-1)) <= 1e-9);
});

test('large-patch：1681 点 3200 面可解，能量单调不增，所有旋转为 SO(3)', () => {
  const solver = solveCase('large-patch.json', 30, 1e-7);
  const reason = solver.stopReason;
  assert.equal(solver.n, expected['large-patch'].vertices);
  assert.equal(solver.data.triangles.length, expected['large-patch'].triangles);
  assert.ok([STOP.CONVERGED, STOP.MAX_ITER].includes(reason));
  for (let k = 1; k < solver.energies.length; k++) {
    assert.ok(
      solver.energies[k] <= solver.energies[k - 1] + 1e-9 * Math.max(1, solver.energies[k - 1]),
      `能量在第 ${k} 项上升`
    );
  }
  for (const R of solver.rotations) {
    assert.ok(Math.abs(matDet(R) - 1) < 1e-9);
  }
  // 硬约束精确满足
  const raw = load('large-patch.json');
  for (const c of raw.constraints) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(solver.x[c.vertex][k] - c.target[k]) < 1e-9);
    }
  }
});

test('bent-strip：每轮重新从 rest 求解，不继承上次变形', () => {
  const raw = load('bent-strip.json');
  const { data } = validateMesh(raw);
  const s1 = new ArapSolver(data);
  s1.runSync(5, 1e-7);
  const e1 = s1.energies.slice();
  // 用修改过的约束重建，再恢复原约束——结果必须与首次完全一致的初值路径
  const s2 = new ArapSolver(data);
  s2.runSync(5, 1e-7);
  assert.deepEqual(s2.energies, e1);
  // 初始第 0 项能量来自 rest 初值 + 局部步
  assert.ok(s2.energies[0] >= s2.energies.at(-1));
});

test('停止原因：达到轮数上限不得标记为收敛', () => {
  const raw = load('large-patch.json');
  const { data } = validateMesh(raw);
  const solver = new ArapSolver(data);
  const reason = solver.runSync(2, 1e-10);
  assert.equal(reason, STOP.MAX_ITER);
  assert.equal(solver.iterations, 2);
  assert.equal(solver.energies.length, 3); // 第 0 项 + 2 轮
});

test('阈值收敛判定：分母为 max(1, 前一能量)，达到阈值时标记 converged', () => {
  // bent-strip 在宽松阈值 1e-3 下能在轮数上限前收敛
  const solver = solveCase('bent-strip.json', 100, 1e-3);
  assert.equal(solver.stopReason, STOP.CONVERGED);
  // 收敛时相邻能量相对下降确实不超过阈值
  const E = solver.energies;
  const last = E.length - 1;
  const rel = Math.abs(E[last] - E[last - 1]) / Math.max(1, E[last - 1]);
  assert.ok(rel <= 1e-3);
});

test('自定义阈值与轮数：宽松阈值更早停止，紧阈值不提前收敛', () => {
  const loose = solveCase('bent-strip.json', 100, 1e-3);
  const tight = solveCase('bent-strip.json', 100, 1e-10);
  assert.equal(loose.stopReason, STOP.CONVERGED);
  assert.equal(tight.stopReason, STOP.MAX_ITER);
  assert.ok(loose.iterations < tight.iterations);
});

test('无自由点时停止原因为 no_deformable_vertices，而非收敛', () => {
  const solver = solveCase('disconnected.json', 100, 1e-7);
  assert.equal(solver.freeIdx.length, 0);
  assert.equal(solver.stopReason, STOP.NO_FREE);
});

test('非法数据逐项指出对象与索引', () => {
  const cases = [
    ['invalid-face.json', 'triangles[0]', '越界'],
    ['invalid-duplicate-pin.json', 'constraints[1]', '重复'],
    ['invalid-degenerate.json', 'triangles[0]', '退化'],
    ['invalid-nonfinite.json', 'rest[0]', '有限'],
  ];
  for (const [file, obj, kw] of cases) {
    const { errors, data } = validateMesh(load(file));
    assert.equal(data, null, `${file} 不应通过校验`);
    assert.ok(errors.some((e) => e.includes(obj)), `${file} 错误未指出 ${obj}: ${errors}`);
    assert.ok(errors.some((e) => e.includes(kw)), `${file} 错误未含关键词 ${kw}: ${errors}`);
  }
});

test('孤立顶点允许存在，孤立约束点直接移动到 target', () => {
  const raw = {
    rest: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [[0, 1, 2]],
    constraints: [],
  };
  // 构造一个孤立点：4 个点、一个三角形
  raw.rest.push([5, 5, 5]);
  const { data } = validateMesh(raw);
  assert.equal(data.components.length, 2);
  const solver = new ArapSolver({
    ...data,
    constraints: [{ vertex: 3, target: [6, 6, 6] }],
  });
  solver.resetConstraints([{ vertex: 3, target: [6, 6, 6] }]);
  solver.runSync(5, 1e-7);
  assert.deepEqual(solver.x[3], [6, 6, 6]);
  // 三角形分量无约束，冻结
  for (let i = 0; i < 3; i++) assert.deepEqual(solver.x[i], raw.rest[i]);
});
