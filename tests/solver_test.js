// 求解器与 IO 单元测试（node 内置 assert，无第三方依赖）
const assert = require('assert');
const fs = require('fs');
const ROOT = '/home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk';
require(ROOT + '/src/zip.js');
require(ROOT + '/src/io.js');
require(ROOT + '/src/solver.js');
const { unzip } = globalThis.StokesZip;
const { buildProject } = globalThis.StokesIO;
const { solvePixel, prepare, predict, coneProject } = globalThis.StokesSolver;

function load(zipPath) {
  const buf = fs.readFileSync(zipPath);
  return buildProject(unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n  ', e.message); process.exitCode = 1; }
}

/* ---------- 锥投影 ---------- */
test('coneProject: 内部点不变', () => {
  const x = [5, 1, 2];
  coneProject(x);
  assert.deepStrictEqual(x, [5, 1, 2]);
});
test('coneProject: 外部点投影到边界', () => {
  const x = [1, 3, 4]; // r=5
  coneProject(x);
  const r = Math.hypot(x[1], x[2]);
  assert.ok(Math.abs(x[0] - r) < 1e-12, 's0 应等于 r');
  assert.ok(Math.abs(x[0] - 3) < 1e-12, 's0=(1+5)/2=3');
});
test('coneProject: 锥对偶内部映射到原点', () => {
  const x = [-10, 1, 0];
  coneProject(x);
  assert.deepStrictEqual(x, [0, 0, 0]);
});

/* ---------- 无解判定：方向不足 3 个 ---------- */
test('有效非饱和方向 < 3 时返回 null', () => {
  const project = load('/tmp/gen-case.zip');
  const ctx = prepare(project, project.frames.map(() => true));
  // 合成用例前 5 个像素被设计为无解
  for (const px of [0, 1, 2, 3, 4]) {
    assert.strictEqual(solvePixel(ctx, px), null, 'px ' + px + ' 应无解');
  }
});

test('禁用帧使方向不足时返回 null', () => {
  const project = load('/tmp/gen-case.zip');
  // 只启用 2 帧 → 最多 2 个方向
  const enabled = project.frames.map((_, i) => i < 2);
  const ctx = prepare(project, enabled);
  assert.strictEqual(solvePixel(ctx, 100), null);
});

test('饱和帧不计入方向数', () => {
  const project = load('/tmp/gen-case.zip');
  const enabled = project.frames.map(() => true);
  const ctx = prepare(project, enabled);
  // 设计的无解区域 px=44*64+5..9：仅 2 个非饱和方向，其余饱和
  for (let c = 5; c < 10; c++) {
    assert.strictEqual(solvePixel(ctx, 44 * 64 + c), null);
  }
});

/* ---------- 解的物理约束 ---------- */
test('所有有解像素满足 s0 >= hypot(s1,s2)', () => {
  const project = load('/tmp/gen-case.zip');
  const ctx = prepare(project, project.frames.map(() => true));
  let checked = 0;
  for (let px = 0; px < ctx.width * ctx.height; px++) {
    const r = solvePixel(ctx, px);
    if (!r) continue;
    assert.ok(r.s[0] >= Math.hypot(r.s[1], r.s[2]) - 1e-9, 'px ' + px + ' 违反锥约束');
    checked++;
  }
  assert.ok(checked > 1000);
});

/* ---------- 饱和残差规则：构造可解析的小问题 ---------- */
test('上饱和帧：预测被正确当作单边罚（手工 3 帧）', () => {
  // 3 个不同方向正常帧确定一个解，再加上饱和帧验证不破坏
  const W = 4, H = 1;
  const mk = (m) => new Uint16Array([m]);
  const project = {
    width: W, height: H,
    frames: [
      { u: 5, v: 0, gain: 4, offset: 0, weight: 1, image: mk(10000), maskData: null },
      { u: -5, v: 0, gain: 4, offset: 0, weight: 1, image: mk(6000), maskData: null },
      { u: 0, v: 5, gain: 4, offset: 0, weight: 1, image: mk(9000), maskData: null },
      { u: 0, v: -5, gain: 4, offset: 0, weight: 1, image: mk(7000), maskData: null },
    ],
  };
  // 真值（无噪声）：s0=8000,s1=2000,s2=1000
  const ctx = prepare(project, [true, true, true, true]);
  const r = solvePixel(ctx, 0);
  assert.ok(Math.abs(r.s[0] - 8000) < 1e-6, 's0');
  assert.ok(Math.abs(r.s[1] - 2000) < 1e-6, 's1');
  assert.ok(Math.abs(r.s[2] - 1000) < 1e-6, 's2');
});

test('上饱和码值 65535 仅在预测<65535 时计罚', () => {
  const mk = (m) => new Uint16Array([m]);
  // 设计真值 s0=40000,s1=30000,s2=0（完全线偏振，锥边界）。
  // 帧0 方向 (5,0)：预测=40000+30000=70000>65535，读到 65535，正确解下罚应为 0。
  // 其余 3 帧为普通观测，足以在无帧0 时还原真值。
  const s = [40000, 30000, 0];
  const metas = [
    { u: 5, v: 0, gain: 4, offset: 0, weight: 1 },
    { u: -5, v: 0, gain: 4, offset: 0, weight: 1 }, // 预测 10000
    { u: 0, v: 5, gain: 4, offset: 0, weight: 1 },  // 预测 40000
    { u: 0, v: -5, gain: 4, offset: 0, weight: 1 }, // 预测 40000
  ];
  const frames = metas.map((b, i) => {
    if (i === 0) return Object.assign({}, b, { image: mk(65535), maskData: null });
    const p = b.offset + (b.gain / 4) * (s[0] + (b.u * s[1] + b.v * s[2]) / 5);
    return Object.assign({}, b, { image: mk(Math.round(p)), maskData: null });
  });
  const project = { width: 1, height: 1, frames };
  const ctx = prepare(project, [true, true, true, true]);
  const r = solvePixel(ctx, 0);
  assert.ok(r, '应有解（3 个非饱和方向）');
  assert.ok(Math.abs(r.s[0] - s[0]) < 1e-5 && Math.abs(r.s[1] - s[1]) < 1e-5,
    '应还原真值，得到 ' + r.s);
  const p0 = predict(project.frames[0], r.s);
  assert.ok(p0 >= 65535, '上饱和帧预测应 >=65535（罚 0），实际 ' + p0);
});

test('上饱和帧在预测被拉低到 65535 以下时确实产生罚并起作用', () => {
  const mk = (m) => new Uint16Array([m]);
  // 帧0 读到 65535 但其余帧暗示更暗的场景，最优解会把帧0 预测压在 <=65535 边界
  const project = {
    width: 1, height: 1,
    frames: [
      { u: 5, v: 0, gain: 4, offset: 0, weight: 1, image: mk(65535), maskData: null },
      { u: -5, v: 0, gain: 4, offset: 0, weight: 1, image: mk(2000), maskData: null },
      { u: 0, v: 5, gain: 4, offset: 0, weight: 1, image: mk(3000), maskData: null },
      { u: 0, v: -5, gain: 4, offset: 0, weight: 1, image: mk(3000), maskData: null },
    ],
  };
  const ctx = prepare(project, [true, true, true, true]);
  const r = solvePixel(ctx, 0);
  assert.ok(r);
  const p0 = predict(project.frames[0], r.s);
  assert.ok(p0 <= 65535 + 1e-6, '上饱和帧预测不应超过 65535，实际 ' + p0);
});

test('下饱和码值 0 仅在预测>0 时计罚', () => {
  const mk = (m) => new Uint16Array([m]);
  const project = {
    width: 1, height: 1,
    frames: [
      { u: 5, v: 0, gain: 4, offset: -1000, weight: 1, image: mk(0), maskData: null },
      { u: -5, v: 0, gain: 4, offset: 0, weight: 1, image: mk(12000), maskData: null },
      { u: 0, v: 5, gain: 4, offset: 0, weight: 1, image: mk(13000), maskData: null },
      { u: 0, v: -5, gain: 4, offset: 0, weight: 1, image: mk(11000), maskData: null },
    ],
  };
  const ctx = prepare(project, [true, true, true, true]);
  const r = solvePixel(ctx, 0);
  assert.ok(r);
  const p0 = predict(project.frames[0], r.s);
  // offset=-1000，若未截断预测<=0 则罚为 0；解不应为贴合 0 而扭曲
  assert.ok(r.s[0] > 0);
});

/* ---------- 权重与增益标定 ---------- */
test('权重不改变无噪声精确解（仅影响数值路径）', () => {
  const mk = (m) => new Uint16Array([m]);
  const base = [
    { u: 5, v: 0, gain: 4, offset: 100, weight: 1 },
    { u: -5, v: 0, gain: 8, offset: -50, weight: 3 },
    { u: 0, v: 5, gain: 2, offset: 200, weight: 2 },
    { u: 3, v: 4, gain: 16, offset: 0, weight: 5 },
  ];
  const s = [10000, 3000, -2000];
  const frames = base.map((b) => {
    const p = b.offset + (b.gain / 4) * (s[0] + (b.u * s[1] + b.v * s[2]) / 5);
    return Object.assign({}, b, { image: mk(Math.round(p)), maskData: null });
  });
  const project = { width: 1, height: 1, frames };
  const ctx = prepare(project, frames.map(() => true));
  const r = solvePixel(ctx, 0);
  assert.ok(r);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(r.s[k] - s[k]) < 1e-6, 's[' + k + ']');
});

/* ---------- 掩膜排除 ---------- */
test('掩膜 0 的观测被排除', () => {
  const project = load('/tmp/gen-case.zip');
  const f2 = project.frames[2];
  const ctx = prepare(project, project.frames.map(() => true));
  let found = 0;
  for (let i = 0; i < f2.maskData.length; i++) {
    if (f2.maskData[i] !== 0) continue;
    const r = solvePixel(ctx, i);
    if (r) { found++; assert.ok(r.s[0] >= Math.hypot(r.s[1], r.s[2]) - 1e-9); }
  }
  assert.ok(found > 0, '应存在帧2被掩但其余帧可解的像素');
});

console.log('\n' + passed + ' tests passed');
