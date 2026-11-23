/* Node 测试：node -I 不需要；直接 node tests/remap-core.test.js */
'use strict';
const assert = require('assert');
const C = require('../js/remap-core.js');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name); console.error(e && e.stack || e); process.exitCode = 1; }
}

// ---------- 独立参考实现：递归细分 + 矩形立体角闭式解 ----------
// 与核心共享的只有输入约定；立体角用矩形闭式公式（Urtasun 形式）独立计算，
// 源纹素归属由射线主导轴独立判定，不经过任何裁剪代码。
function rectSolidAngle(u0, u1, v0, v1) {
  const ang = (a, b) => Math.atan2(a * b, Math.sqrt(1 + a * a + b * b));
  return ang(u1, v1) - ang(u0, v1) - ang(u1, v0) + ang(u0, v0);
}

function locate(p, n) {
  const ax = Math.abs(p[0]), ay = Math.abs(p[1]), az = Math.abs(p[2]);
  let f;
  if (ax >= ay && ax >= az) f = p[0] >= 0 ? 0 : 1;
  else if (ay >= az) f = p[1] >= 0 ? 2 : 3;
  else f = p[2] >= 0 ? 4 : 5;
  let u, v;
  switch (f) {
    case 0: u = -p[2] / p[0]; v = -p[1] / p[0]; break;
    case 1: u = -p[2] / p[0]; v = p[1] / p[0]; break;
    case 2: u = p[0] / p[1]; v = p[2] / p[1]; break;
    case 3: u = -p[0] / p[1]; v = p[2] / p[1]; break;
    case 4: u = p[0] / p[2]; v = -p[1] / p[2]; break;
    case 5: u = p[0] / p[2]; v = p[1] / p[2]; break;
  }
  const h = 2 / n;
  let col = Math.floor((u + 1) / h), row = Math.floor((v + 1) / h);
  if (col < 0) col = 0; if (col >= n) col = n - 1;
  if (row < 0) row = 0; if (row >= n) row = n - 1;
  return { f, row, col };
}

function referenceTexel(input, tf, trow, tcol, depth) {
  const n = input.n, out = input.out;
  const R = C.quatToMatrix(input.q);
  const tb = C.texelBounds(out, trow, tcol);
  const hU = (tb.u1 - tb.u0) / (1 << depth);
  const hV = (tb.v1 - tb.v0) / (1 << depth);
  let wSum = 0, validW = 0;
  const num = [0, 0, 0];
  for (let i = 0; i < (1 << depth); i++) {
    for (let j = 0; j < (1 << depth); j++) {
      const u0 = tb.u0 + i * hU, u1 = u0 + hU;
      const v0 = tb.v0 + j * hV, v1 = v0 + hV;
      const w = rectSolidAngle(u0, u1, v0, v1);
      wSum += w;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const d = norm3(C.faceRay(tf, cu, cv));
      const p = C.rotateBack(R, d);
      const loc = locate(p, n);
      const tex = input.faces[loc.f][loc.row * n + loc.col];
      if (tex !== null) {
        validW += w;
        num[0] += tex[0] * w; num[1] += tex[1] * w; num[2] += tex[2] * w;
      }
    }
  }
  return { rgb: num.map(x => x / wSum), coverage: validW / wSum, wSum };
}
function norm3(p) { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; }

// ---------- 构造工具 ----------
function uniformFaces(n, v, nullRate = 0) {
  const faces = [];
  let k = 0;
  for (let f = 0; f < 6; f++) {
    const face = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (nullRate && ((k * 2654435761) % 100) / 100 < nullRate) face.push(null);
      else face.push(Array.isArray(v) ? v.slice() : [v, v, v]);
      k++;
    }
    faces.push(face);
  }
  return faces;
}
function randomFaces(n, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const face = [];
    for (let i = 0; i < n * n; i++) face.push([rnd(), rnd(), rnd()]);
    faces.push(face);
  }
  return faces;
}
function randomQuat() {
  const q = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
  const l = Math.hypot(...q) || 1;
  return q.map(x => x / l);
}
function resultArrays(res, out) {
  const rgb = [];
  for (let f = 0; f < 6; f++) {
    const face = [];
    for (let i = 0; i < out * out; i++) {
      const k = f * out * out + i;
      face.push([res.rgb[k * 3], res.rgb[k * 3 + 1], res.rgb[k * 3 + 2]]);
    }
    rgb.push(face);
  }
  return rgb;
}

// ---------- 测试 ----------
test('六面纹素立体角之和 = 4π（n=1,3,7,64）', () => {
  for (const n of [1, 3, 7, 64]) {
    let s = 0;
    for (let f = 0; f < 6; f++) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      s += C.texelSolidAngle(f, n, r, c);
    }
    assert(Math.abs(s - 4 * Math.PI) < 1e-13, 'n=' + n + ' sum=' + s);
  }
});

test('矩形闭式立体角与三角扇形一致', () => {
  for (const n of [1, 4, 64]) {
    const b = C.texelBounds(n, Math.floor(n / 2), Math.floor(n / 3));
    const ref = rectSolidAngle(b.u0, b.u1, b.v0, b.v1);
    const got = C.texelSolidAngle(4, n, Math.floor(n / 2), Math.floor(n / 3));
    assert(Math.abs(ref - got) < 1e-15, ref + ' vs ' + got);
  }
});

test('恒等旋转 + 同尺寸：纹素严格映射到自身，权重=自身立体角', () => {
  const n = 8;
  const input = { n, out: n, q: [0, 0, 0, 1], faces: randomFaces(n, 7) };
  const params = C.buildParams(input);
  for (let f = 0; f < 6; f++) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const res = C.resampleTexel(params, f, r, c);
    assert.strictEqual(res.contributions.length, 1);
    const k = res.contributions[0];
    assert.strictEqual(k.face, f); assert.strictEqual(k.row, r); assert.strictEqual(k.col, c);
    assert(Math.abs(k.weight - res.omegaT) < 1e-15);
    const src = input.faces[f][r * n + c];
    for (let ch = 0; ch < 3; ch++) assert(Math.abs(res.rgb[ch] - src[ch]) < 1e-15);
    assert(Math.abs(res.coverage - 1) < 1e-14);
  }
});

test('恒等旋转 + 缺测：覆盖率 0、RGB 0、权重仍完整', () => {
  // 合法输入：面仍是长度 n^2 的数组，纹素本身为 null
  const input = { n: 1, out: 1, q: [0, 0, 0, 1],
    faces: [null, null, null, null, null, null].map(() => [null]) };
  const check = C.validateInput(input);
  assert(check.valid, JSON.stringify(check.errors));
  const params = C.buildParams(input);
  for (let f = 0; f < 6; f++) {
    const res = C.resampleTexel(params, f, 0, 0);
    assert(Math.abs(res.coverage) < 1e-15);
    assert(Math.abs(res.rgb[0]) + Math.abs(res.rgb[1]) + Math.abs(res.rgb[2]) < 1e-15);
    assert(Math.abs(res.weightSum - res.omegaT) < 1e-14);
    assert(res.contributions[0].missing);
  }
});

test('整面为 null（非数组）被校验拦下并标出面号', () => {
  const input = { n: 1, out: 1, q: [0, 0, 0, 1], faces: [null, null, null, null, null, null] };
  const check = C.validateInput(input);
  assert(!check.valid);
  assert.strictEqual(check.errors.length, 6);
  assert(check.errors.every(e => e.kind === 'face' && typeof e.face === 'number'));
});

test('均匀色立方图：任意旋转输出恒等（多组随机 q）', () => {
  const v = [0.37, 0.61, 0.83];
  for (let t = 0; t < 8; t++) {
    const input = { n: 5, out: 6, q: randomQuat(), faces: uniformFaces(5, v) };
    const res = C.resampleCubemap(input);
    assert(res.ok);
    for (let i = 0; i < res.rgb.length; i++) assert(Math.abs(res.rgb[i] - v[i % 3]) < 2e-14);
    for (let i = 0; i < res.coverage.length; i++) assert(Math.abs(res.coverage[i] - 1) < 1e-14);
  }
});

test('每通道立体角加权总量守恒（随机旋转、有无缺测各若干组）', () => {
  for (const nullRate of [0, 0.2]) {
    for (let t = 0; t < 6; t++) {
      const n = 1 + (t % 9), out = 1 + ((t * 3 + 2) % 12);
      const input = { n, out, q: randomQuat(), faces: uniformFaces(n, [0.2 + 0.1 * t, 0.5, 0.7], nullRate) };
      const res = C.resampleCubemap(input);
      assert(res.ok);
      const d = res.stats.conservationDiff;
      assert(Math.max(...d) < 2e-13, 'diff=' + d.join(','));
    }
  }
});

test('JS 内部细分参考（深度加细自洽，5e-5 内）', () => {
  // 与核心不同的数值路线（矩形立体角闭式 + 主导轴定位），但同样基于分段常数最近邻，
  // 在面界为 O(h) 不收敛；仅作快速自洽检查。1e-6 级精度的独立证据见
  // tests/cross-validation.js（Python 自适应/外推参考，完全独立的实现）。
  const cases = [
    { n: 4, out: 3, seed: 11 }, { n: 7, out: 5, seed: 23 }, { n: 2, out: 8, seed: 37 },
  ];
  let worst = 0, worstCov = 0;
  for (const cs of cases) {
    const input = { n: cs.n, out: cs.out, q: [0.31, -0.52, 0.67, 0.42], faces: randomFaces(cs.n, cs.seed) };
    const l = Math.hypot(...input.q); input.q = input.q.map(x => x / l);
    const res = C.resampleCubemap(input);
    assert(res.ok);
    const got = resultArrays(res, cs.out);
    for (let f = 0; f < 6; f++) for (let r = 0; r < cs.out; r++) for (let c = 0; c < cs.out; c++) {
      const ref = referenceTexel(input, f, r, c, 10);
      const g = got[f][r * cs.out + c];
      for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(g[ch] - ref.rgb[ch]));
      worstCov = Math.max(worstCov,
        Math.abs(res.coverage[f * cs.out * cs.out + r * cs.out + c] - ref.coverage));
    }
  }
  console.log('    depth=10 中点细分自洽：最大 RGB 偏差 ' + worst.toExponential(2) +
    '，覆盖率偏差 ' + worstCov.toExponential(2));
  assert(worst < 5e-5);
  assert(worstCov < 5e-5);
});

test('+90° 绕 Z：源 +X 亮斑整体落到目标 +Y 面，质量守恒', () => {
  const n = 6;
  const faces = uniformFaces(n, [0, 0, 0]);
  faces[0][2 * n + 2] = [1, 1, 1]; // +X 中心纹素
  const q = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const input = { n, out: n, q, faces };
  const res = C.resampleCubemap(input);
  const got = resultArrays(res, n);
  let yMass = 0, otherMass = 0;
  for (let f = 0; f < 6; f++) for (const px of got[f]) {
    const m = (px[0] + px[1] + px[2]) / 3;
    if (f === 2) yMass += m; else if (m > 0) otherMass += m;
  }
  const srcSA = C.texelSolidAngle(0, n, 2, 2);
  // +Y 面上的逐纹素立体角加权质量应等于源纹素立体角
  let yExact = 0;
  for (let i = 0; i < n * n; i++) {
    const r = Math.floor(i / n), c = i % n;
    yExact += got[2][i][0] * C.texelSolidAngle(2, n, r, c);
  }
  assert(Math.abs(yExact - srcSA) < 1e-13, 'yExact=' + yExact + ' srcSA=' + srcSA);
  assert(otherMass < 1e-15, 'otherMass=' + otherMass);
  // 方向映射：R(+X)=+Y
  const R = C.quatToMatrix(q);
  const rx = [R[0], R[3], R[6]];
  assert(Math.abs(rx[0]) < 1e-15 && Math.abs(rx[1] - 1) < 1e-15 && Math.abs(rx[2]) < 1e-15);
});

test('样本文件端到端：n=1,out=2 的缺测覆盖率与守恒', () => {
  const fs = require('fs');
  const input = JSON.parse(fs.readFileSync(__dirname + '/../samples/solid-angle-cubemap.json', 'utf8'));
  const res = C.resampleCubemap(input);
  assert(res.ok);
  assert.strictEqual(res.rgb.length, 6 * 4 * 3);
  // n=1/out=2 同网格对齐：源 -Z 面（全缺测）恰好覆盖目标 -Z 面 4 个纹素 => 覆盖率 0；
  // 其余五个面完整有效 => 覆盖率 1
  for (let f = 0; f < 5; f++) for (let i = 0; i < 4; i++) {
    assert(Math.abs(res.coverage[f * 4 + i] - 1) < 2e-15, 'face' + f + ' cov=' + res.coverage[f * 4 + i]);
  }
  for (let i = 0; i < 4; i++) assert(Math.abs(res.coverage[5 * 4 + i]) < 2e-15);
  assert(Math.max(...res.stats.conservationDiff) < 2e-14);
  // 导出结构
  const exp = C.resultToJSON(input, res);
  assert.strictEqual(exp.faces.length, 6);
  assert.strictEqual(exp.faces[0].length, 4);
  assert.strictEqual(exp.coverage[5].length, 4);
});

test('输入校验：标出源面与纹素位置', () => {
  const base = { n: 2, out: 2, q: [0, 0, 0, 1], faces: uniformFaces(2, [0.5, 0.5, 0.5]) };
  const bad1 = JSON.parse(JSON.stringify(base)); bad1.faces[3][1] = [0.5, 2, 0.5];
  const e1 = C.validateInput(bad1);
  assert(!e1.valid);
  assert(e1.errors.some(e => e.kind === 'face' && e.face === 3 && e.row === 0 && e.col === 1 && e.component === 1));
  const bad2 = JSON.parse(JSON.stringify(base)); bad2.faces[2] = bad2.faces[2].slice(0, 3);
  const e2 = C.validateInput(bad2);
  assert(e2.errors.some(e => e.kind === 'face' && e.face === 2 && /纹素数/.test(e.message)));
  const bad3 = JSON.parse(JSON.stringify(base)); bad3.faces[0][0] = [0.1];
  assert(!C.validateInput(bad3).valid);
  assert(C.validateInput(base).valid);
});

test('旋转校验：非有限数、零模长、错误形状分别标出', () => {
  const base = { n: 1, out: 1, q: [0, 0, 0, 1], faces: uniformFaces(1, [0.2, 0.3, 0.4]) };
  const b1 = { ...base, q: [NaN, 0, 0, 1] };
  const e1 = C.validateInput(b1);
  assert(e1.errors.some(e => e.kind === 'rotation' && e.component === 'x'));
  const b2 = { ...base, q: [0, 0, 0, 0] };
  assert(C.validateInput(b2).errors.some(e => e.kind === 'rotation' && /模长/.test(e.message)));
  const b3 = { ...base, q: [0, 0, 1] };
  assert(C.validateInput(b3).errors.some(e => e.kind === 'rotation'));
  const b4 = { ...base, q: [1e-13, 0, 0, 0] };
  assert(C.validateInput(b4).errors.some(e => e.kind === 'rotation'));
});

test('参数校验：n/out 越界与类型', () => {
  const base = { n: 2, out: 2, q: [0, 0, 0, 1], faces: uniformFaces(2, [0.5, 0.5, 0.5]) };
  for (const v of [0, 65, 1.5, '4', null]) {
    const e = C.validateInput({ ...base, n: v });
    assert(e.errors.some(x => x.field === 'n'), 'n=' + v);
  }
  for (const v of [0, 65, -1]) {
    const e = C.validateInput({ ...base, out: v });
    assert(e.errors.some(x => x.field === 'out'), 'out=' + v);
  }
});

test('取消：取消后返回 cancelled，且不破坏上一份完整结果', () => {
  const input = { n: 32, out: 32, q: [0, 0, 0, 1], faces: uniformFaces(32, [0.3, 0.4, 0.5]) };
  const first = C.resampleCubemap(input);
  assert(first.ok && !first.cancelled);
  const snapshot = first.rgb.slice(0, 100);
  const cancel = { cancelled: false };
  // 同步代码中立即置位：首批之前即取消
  cancel.cancelled = true;
  const second = C.resampleCubemap(input, { cancel });
  assert(second.ok && second.cancelled);
  for (let i = 0; i < 100; i++) assert(first.rgb[i] === snapshot[i]);
  // 中途取消（在 onProgress 回调里取消）
  const cancel2 = { cancelled: false };
  const third = C.resampleCubemap(input, {
    cancel: cancel2,
    onProgress: (p) => { if (p > 0.3) cancel2.cancelled = true; },
  });
  assert(third.cancelled, 'should have cancelled mid-run');
});

test('64→64 性能基准（10 秒预算）', () => {
  const input = { n: 64, out: 64, q: randomQuat(), faces: randomFaces(64, 99) };
  const t0 = Date.now();
  const res = C.resampleCubemap(input);
  const ms = Date.now() - t0;
  assert(res.ok);
  console.log('    64x64 耗时 ' + ms + ' ms（预算 10000 ms）');
  assert(ms < 10000);
  assert(Math.max(...res.stats.conservationDiff) < 1e-10);
  assert(res.stats.maxRelResidual < 1e-12, 'residual=' + res.stats.maxRelResidual);
});

test('权重分割残差：所有纹素 weightSum ≈ omegaT', () => {
  const input = { n: 5, out: 9, q: [0.31, -0.52, 0.67, 0.42], faces: randomFaces(5, 3) };
  const l = Math.hypot(...input.q); input.q = input.q.map(x => x / l);
  const res = C.resampleCubemap(input);
  assert(res.stats.maxAbsResidual < 1e-14, 'maxAbs=' + res.stats.maxAbsResidual);
  assert(Math.abs(res.stats.weightTotal - 4 * Math.PI) < 1e-12);
});

test('导出 JSON 可往返且数值一致', () => {
  const input = { n: 3, out: 4, q: [0, 0, 0.5, 0.8660254037844386], faces: randomFaces(3, 5) };
  const res = C.resampleCubemap(input);
  const exp = C.resultToJSON(input, res);
  const text = JSON.stringify(exp);
  const back = JSON.parse(text);
  assert.strictEqual(back.out, 4);
  const k = 3 * 16 + 5;
  assert(Math.abs(back.faces[3][5][1] - res.rgb[k * 3 + 1]) < 1e-18);
  assert(Math.abs(back.coverage[3][5] - res.coverage[k]) < 1e-18);
});

test('欧拉角助手：绕 Z 90° 与直接四元数矩阵一致', () => {
  const q1 = C.eulerToQuat(0, 0, Math.PI / 2);
  const R1 = C.quatToMatrix(q1);
  const q2 = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const R2 = C.quatToMatrix(q2);
  for (let i = 0; i < 9; i++) assert(Math.abs(R1[i] - R2[i]) < 1e-15);
});

test('欧拉角往返：任意角度 q -> 欧拉 -> q 矩阵一致（含接近万向锁）', () => {
  const d = Math.PI / 180;
  const cases = [[30, 45, 20], [-80, 10, 170], [0, 0, 0], [10, 89.9, 5], [10, -89.9, -5], [120, -30, -170]];
  let worst = 0;
  for (const [a, b, g] of cases) {
    const q = C.eulerToQuat(a * d, b * d, g * d);
    const q2 = C.eulerToQuat(...C.eulerFromQuat(q));
    const m1 = C.quatToMatrix(q), m2 = C.quatToMatrix(q2);
    const diff = Math.max(...m1.map((v, i) => Math.abs(v - m2[i])));
    worst = Math.max(worst, diff);
  }
  assert(worst < 1e-13, 'worst=' + worst);
});

console.log(process.exitCode ? '\n有测试失败' : '\n全部 ' + pass + ' 项测试通过');
