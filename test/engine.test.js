/* Node 测试：node -I test/engine.test.js （-I 隔离模式，防目录内注入） */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'src', 'engine.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

/* 稠密采样参考实现（独立写一遍，仅作对照，不作结论依据） */
function referenceEnvelope(model, ta, tb, n) {
  const sc = E.makeScratch(model);
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  const wit = Array.from({ length: 6 }, () => null);
  for (let i = 0; i <= n; i++) {
    const t = ta + (tb - ta) * (i / n);
    const world = E.evalWorldMatrices(model, t, sc);
    for (let vi = 0; vi < model.vertices.length; vi++) {
      const p = E.skinVertex(model, world, vi, sc.tmp, sc.pos);
      for (let r = 0; r < 3; r++) {
        if (p[r] < mn[r]) { mn[r] = p[r]; wit[2 * r] = { vertex: vi, t, coord: p[r] }; }
        if (p[r] > mx[r]) { mx[r] = p[r]; wit[2 * r + 1] = { vertex: vi, t, coord: p[r] }; }
      }
    }
  }
  return { mn, mx, wit };
}

function verifyBoxAgainstSample(name, model, ta, tb, n) {
  const res = E.computeEnvelope(model, ta, tb);
  const ref = referenceEnvelope(model, ta, tb, n);
  let ok = true; const details = [];
  for (let r = 0; r < 3; r++) {
    // 盒子必须包住采样到的全部极值
    if (res.box.min[r] > ref.mn[r] + 1e-9) { ok = false; details.push(`min${r} 不包极值`); }
    if (res.box.max[r] < ref.mx[r] - 1e-9) { ok = false; details.push(`max${r} 不包极值`); }
    // 盒面离采样极值 ≤ 0.01
    if (res.box.min[r] - ref.mn[r] > 0.01) { ok = false; details.push(`min${r} 间隙 ${(res.box.min[r] - ref.mn[r]).toFixed(4)}`); }
    if (ref.mx[r] - res.box.max[r] > 0.01) { ok = false; details.push(`max${r} 间隙 ${(ref.mx[r] - res.box.max[r]).toFixed(4)}`); }
  }
  // 见证有效性：跳回见证时刻，该顶点坐标与见证记录一致，且距对应面 ≤ 0.01
  const sc = E.makeScratch(model);
  for (let q = 0; q < 6; q++) {
    const f = res.faces[q];
    if (!f.witness) { ok = false; details.push(`面${q}无见证`); continue; }
    const w = E.evalWorldMatrices(model, f.witness.t, sc);
    const p = E.skinVertex(model, w, f.witness.vertex, sc.tmp, sc.pos);
    if (!approx(p[f.axis], f.witness.coord, 1e-9)) { ok = false; details.push(`面${q}见证坐标不符`); }
    const gap = f.isMin ? f.value - p[f.axis] : p[f.axis] - f.value;
    // 见证可在盒内（外扩边距），故允许小负距；超出 0.01 或在盒外均为失败
    if (gap > 0.01 + 1e-9 || gap < -(E.MARGIN + 1e-9)) { ok = false; details.push(`面${q}见证距面 ${gap.toFixed(4)}`); }
  }
  check(name, ok, details.join('; '));
  return res;
}

console.log('1) 样本文件：导入与整区间包围');
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'continuous-envelope.json'), 'utf8'));
  const { model, error } = E.validateModel(raw);
  check('样本导入成功', !!model, error);
  const res = verifyBoxAgainstSample('样本 [0,1] 连续包围（含见证校验）', model, 0, 1, 20000);
  // 解析值：xMax≈3, yMax≈3, zMax=1, zMin=0
  check('xMax≈3（顶点0转至 y 轴）', approx(res.box.max[0], 3, 0.01), res.box.max[0]);
  check('yMax≈3', approx(res.box.max[1], 3, 0.01), res.box.max[1]);
  check('zMin≈0', approx(res.box.min[2], 0, 0.01), res.box.min[2]);
}

console.log('2) 整圈问题：起止姿态相同，中间伸出盒子');
{
  // 骨 z 轴 0→1 圈；顶点 (10,0,0)；起止都在 (10,0)，但中间到达 (-10,0)、(0,±10)
  const raw = {
    bones: [{ parent: null, axis: 'z' }],
    keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 1]] }],
    vertices: [[[0, 65536, 10, 0, 0]]],
  };
  const { model } = E.validateModel(raw);
  const res = E.computeEnvelope(model, 0, 1);
  check('xMin≈-10（整圈中间极值，非起止姿态）', approx(res.box.min[0], -10, 0.01), res.box.min[0]);
  check('xMax≈10', approx(res.box.max[0], 10, 0.01), res.box.max[0]);
  check('yMin≈-10', approx(res.box.min[1], -10, 0.01), res.box.min[1]);
  check('yMax≈10', approx(res.box.max[1], 10, 0.01), res.box.max[1]);
  check('xMin 见证在 t≈0.5', approx(res.faces[0].witness.t, 0.5, 0.01), res.faces[0].witness.t);
  // 固定采样若只取两端会得到 x∈[10,10]：这里对比证明
  const scE = E.makeScratch(model);
  const pA = E.skinVertex(model, E.evalWorldMatrices(model, 0, scE), 0, scE.tmp, scE.pos);
  const pB = E.skinVertex(model, E.evalWorldMatrices(model, 1, scE), 0, scE.tmp, scE.pos);
  const endpointMin = Math.min(pA[0], pB[0]);
  check('对照：仅两端采样会漏掉 -10（复现引擎裁剪问题）', endpointMin === 10);
}

console.log('3) 不折最短转角：按原写圈数插值（1.5 圈）');
{
  const raw = {
    bones: [{ parent: null, axis: 'z' }],
    keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 1.5]] }],
    vertices: [[[0, 65536, 1, 0, 0]]],
  };
  const { model } = E.validateModel(raw);
  // 1.5 圈终点在 (cos3π, sin3π)=(-1,0)；若错误折成 -0.5 圈终点也是 (-1,0)，
  // 但中途覆盖范围不同：1.5 圈 y 极值 ±1 都会出现（与 0.5 圈仅 -1 区分）
  const res = E.computeEnvelope(model, 0, 1);
  // 严格极值以证书界 bound 为准（采样种子可能略偏，盒面与 bound 间隙 ≤ 0.001）
  check('yMax 证书界≈1（长路径覆盖，短路径插值会缺失）', approx(res.faces[3].bound, 1, 1e-9), res.faces[3].bound);
  check('yMin 证书界≈-1', approx(res.faces[2].bound, -1, 1e-9), res.faces[2].bound);
  check('yMax 盒面离真实极值 ≤ 0.01', res.box.max[1] - 1 <= 0.01 + 1e-9);
}

console.log('4) 父子骨链 + 同刻多骨权重合成');
{
  // 根 z 轴 0→1 圈；子骨父=根，z 轴 0→1 圈，平移 (5,0,0)
  // 顶点：半权重绑根局部 (1,0,0)，半权重绑子局部 (0,0,0)
  const raw = {
    bones: [{ parent: null, axis: 'z' }, { parent: 0, axis: 'z' }],
    keys: [
      { t: 0, pose: [[0, 0, 0, 0], [5, 0, 0, 0]] },
      { t: 1, pose: [[0, 0, 0, 1], [5, 0, 0, 1]] },
    ],
    vertices: [[[0, 32768, 1, 0, 0], [1, 32768, 0, 0, 0]]],
  };
  const { model } = E.validateModel(raw);
  verifyBoxAgainstSample('骨链+多骨权重与稠密参考一致', model, 0, 1, 30000);
  // 子骨世界点 = R(t)R(t)(5,0)，角速度 2 圈/秒；蒙皮点 = 0.5 R(t)(1,0)+0.5 R(2t)(5,0)
  // x 最大约 3（t=0），最小约 -3
  const res = E.computeEnvelope(model, 0, 1);
  check('xMax≈3', approx(res.box.max[0], 3, 0.02), res.box.max[0]);
  check('xMin≈-3', approx(res.box.min[0], -3, 0.02), res.box.min[0]);
}

console.log('5) 子区间框选与单一时刻查询');
{
  const raw = {
    bones: [{ parent: null, axis: 'z' }],
    keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 2, pose: [[0, 0, 0, 1]] }],
    vertices: [[[0, 65536, 10, 0, 0]]],
  };
  const { model } = E.validateModel(raw);
  // 只查 [0, 0.5]：角度 0→90°，x∈[0,10], y∈[0,10]
  const sub = E.computeEnvelope(model, 0, 0.5);
  check('子区间 xMin≈0', approx(sub.box.min[0], 0, 0.01), sub.box.min[0]);
  check('子区间 yMax≈10', approx(sub.box.max[1], 10, 0.01), sub.box.max[1]);
  // 单一时刻 t=0.25：角度45°
  const inst = E.computeEnvelope(model, 0.25, 0.25);
  const sc = E.makeScratch(model);
  const w = E.evalWorldMatrices(model, 0.25, sc);
  const p = E.skinVertex(model, w, 0, sc.tmp, sc.pos);
  check('单一时刻盒退化为点 x≈10cos45°', approx(inst.box.min[0], p[0], 1e-9), `${inst.box.min[0]} vs ${p[0]}`);
  check('单一时刻 min=max', approx(inst.box.min[0], inst.box.max[0], 1e-9));
  // 越界查询报错
  let threw = false;
  try { E.computeEnvelope(model, -1, 1); } catch (e) { threw = true; }
  check('越界查询抛错', threw);
  threw = false;
  try { E.computeEnvelope(model, 1, 0.5); } catch (e) { threw = true; }
  check('反向区间抛错', threw);
}

console.log('6) 错误导入不覆盖旧结果 + 各类校验');
{
  const good = {
    bones: [{ parent: null, axis: 'z' }],
    keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0.25]] }],
    vertices: [[[0, 65536, 1, 0, 0]]],
  };
  const r1 = E.validateModel(good);
  check('合法模型通过', !!r1.model);
  const badCases = [
    ['缺 bones', {}],
    ['骨号越界', { bones: [{ parent: null, axis: 'z' }], keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0]] }], vertices: [[[1, 65536, 1, 0, 0]]] }],
    ['权重和错误', { bones: [{ parent: null, axis: 'z' }], keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0]] }], vertices: [[[0, 1, 1, 0, 0]]] }],
    ['时间未递增', { bones: [{ parent: null, axis: 'z' }], keys: [{ t: 1, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0]] }], vertices: [[[0, 65536, 1, 0, 0]]] }],
    ['骨骼循环', { bones: [{ parent: 1, axis: 'z' }, { parent: 0, axis: 'z' }], keys: [{ t: 0, pose: [[0, 0, 0, 0], [0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0], [0, 0, 0, 0]] }], vertices: [[[0, 65536, 1, 0, 0]]] }],
    ['角差超 2 圈', { bones: [{ parent: null, axis: 'z' }], keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 2.5]] }], vertices: [[[0, 65536, 1, 0, 0]]] }],
    ['超 64 骨', { bones: Array.from({ length: 65 }, () => ({ parent: null, axis: 'z' })), keys: [{ t: 0, pose: Array(65).fill([0, 0, 0, 0]) }, { t: 1, pose: Array(65).fill([0, 0, 0, 0]) }], vertices: [[[0, 65536, 1, 0, 0]]] }],
    ['非法 axis', { bones: [{ parent: null, axis: 'w' }], keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0]] }], vertices: [[[0, 65536, 1, 0, 0]]] }],
    ['重复绑骨', { bones: [{ parent: null, axis: 'z' }], keys: [{ t: 0, pose: [[0, 0, 0, 0]] }, { t: 1, pose: [[0, 0, 0, 0]] }], vertices: [[[0, 32768, 1, 0, 0], [0, 32768, 2, 0, 0]]] }],
  ];
  let allBad = true;
  for (const [name, bad] of badCases) {
    const r = E.validateModel(bad);
    if (!r.error) { allBad = false; console.log(`    未拦截: ${name}`); }
  }
  check('9 类非法输入全部拦截且返回 error', allBad);
  // 旧结果不被覆盖：模拟 UI 逻辑（只在无 error 时替换）
  let current = r1.model;
  for (const [, bad] of badCases) {
    const r = E.validateModel(bad);
    if (!r.error) current = r.model;
  }
  check('错误导入后旧模型仍保留', current === r1.model);
}

console.log('7) 满额长片性能（12 秒预算）与正确性');
{
  const raw = E.buildFullLengthFilm();
  const { model, error } = E.validateModel(raw);
  check('满额片导入成功（64骨/8192顶点/129帧/128区间）', !!model, error);
  const t0 = Date.now();
  const res = E.computeEnvelope(model, 0, 128);
  const ms = Date.now() - t0;
  console.log(`    计算耗时 ${ms} ms（区间求值 ${res.stats.evalCount} 次，深叶 ${res.stats.deepLeaves.length}）`);
  check('12 秒内算完', ms < 12000, `${ms}ms`);
  check('无未收敛深叶', res.stats.deepLeaves.length === 0);
  // 每顶点 (10,0,z)：z=i%8；xy 旋转半径 10
  check('xMin≈-10', approx(res.box.min[0], -10, 0.01), res.box.min[0]);
  check('xMax≈10', approx(res.box.max[0], 10, 0.01), res.box.max[0]);
  check('yMin≈-10', approx(res.box.min[1], -10, 0.01), res.box.min[1]);
  check('yMax≈10', approx(res.box.max[1], 10, 0.01), res.box.max[1]);
  check('zMin≈0', approx(res.box.min[2], 0, 0.01), res.box.min[2]);
  check('zMax≈7', approx(res.box.max[2], 7, 0.01), res.box.max[2]);
  // 六个面都有见证
  check('六面均有见证', res.faces.every((f) => f.witness !== null));
  // 盒面间隙证书 ≤ 0.01
  const certOk = res.faces.every((f) => (f.isMin ? f.value - f.bound : f.bound - f.value) <= 0.01 + 1e-9);
  check('六面证书间隙均 ≤ 0.01', certOk);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
