/* 引擎校验：确定性用例、独立有理数参考实现交叉校验、守恒、性能。
 * 运行：node test/engine-check.js
 */
'use strict';
const assert = require('assert');
const E = require('../engine.js');
const { referencePixel } = require('./reference-sweep.js');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else passed++;
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) {
    console.error(`FAIL: ${msg} | 得到 ${a}，期望 ${b}（容差 ${tol}）`);
    failed++;
  } else passed++;
}

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function onePixel(sc, x, y, opts) {
  const { errors, prepared } = E.prepare(sc);
  assert.deepStrictEqual(errors, [], '场景应合法：' + errors.join('; '));
  return E.computePixel(prepared, x === undefined ? 0 : x, y === undefined ? 0 : y, opts || {});
}

const SQ = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
function base(extra) {
  return Object.assign({
    width: 1, height: 1, pupil: SQ,
    stop: { offset: [0, 0], slope: [0, 0] },
    bg: [0, 0, 0], triangles: [],
  }, extra);
}

// ---------------------------------------------------------------------------
// 1. 需求验收点（可直接对照题面）
// ---------------------------------------------------------------------------
{
  // 1a. 重叠只给最近片；同深度取小编号；前景/远景/背景份额 0.5 / 0.25 / 0.25
  const fg = { id: 1, depth: 1, s: 1, xy: [[0.5, -8], [0.5, 8], [-8, 0.5]], rgb: [1, 0, 0] };
  const far = { id: 2, depth: 2, s: 1, xy: [[-8, 0.5], [8, 0.5], [0.5, -8]], rgb: [0, 1, 0] };
  const r = onePixel(base({ bg: [0, 0, 0.5], triangles: [fg, far] }));
  near(r.triAreas.get(1), 2, 1e-12, '前景覆盖 u≥0 的半个孔径');
  near(r.triAreas.get(2), 1, 1e-12, '重叠部分只给更近的前景，远景只剩四分之一');
  near(r.bgArea, 1, 1e-12, '未遮挡份额');
  near(r.rgb[0], 0.5, 1e-12, '前景红占 0.5');
  near(r.rgb[1], 0.25, 1e-12, '远景绿占 0.25');
  near(r.rgb[2], 0.125, 1e-12, '背景蓝 0.25×0.5');

  // 同深度、不同编号：整个 0.5 份额归小编号
  const a = { id: 5, depth: 2, s: 1, xy: [[0.5, -8], [0.5, 8], [-8, 0.5]], rgb: [1, 0, 0] };
  const b = { id: 3, depth: 2, s: 1, xy: [[0.5, -8], [0.5, 8], [-8, 0.5]], rgb: [0, 1, 0] };
  const r2 = onePixel(base({ triangles: [a, b] }));
  near(r2.triAreas.get(3), 2, 1e-12, '同深度小编号拿走整块');
  ok(!r2.triAreas.has(5), '同深度大编号份额为零');

  // 1b. 光阑偏移 (0.5, 0)：背景 3、黑 1，RGB 每通道 0.75
  const r3 = onePixel(base({ stop: { offset: [0.5, 0], slope: [0, 0] }, bg: [1, 1, 1] }));
  near(r3.bgArea, 3, 1e-12, '光阑偏移后背景面积');
  near(r3.blackArea, 1, 1e-12, '光阑外的孔径份额算黑');
  near(r3.rgb[0], 0.75, 1e-12, '归一化仍用原始孔径面积 4');
  near(r3.rgb[1], 0.75, 1e-12, 'rgb.g');
  near(r3.rgb[2], 0.75, 1e-12, 'rgb.b');

  // 1c. 窄带 1/4096 宽：可见占比 1/8192（需要精确求积，不能靠采样）
  const e = 1 / 4096;
  const strip = { id: 1, depth: 1, s: 1, xy: [[-0.5 + e, -8], [-0.5 + e, 8], [-8, 0.5]], rgb: [1, 0, 0] };
  const r4 = onePixel(base({ triangles: [strip] }));
  near(r4.triAreas.get(1), 1 / 8192 * 4, 1e-12, '窄带面积');
  near(r4.rgb[0], 1 / 8192, 1e-12, '窄带占比 1/8192');

  // 1d. 焦面偏移系数：s=0 且在边界上 → 覆盖整个有效孔径
  const focal = { id: 1, depth: 1, s: 0, xy: [[0.5, -8], [0.5, 8], [-8, 0.5]], rgb: [1, 0, 0] };
  const r5 = onePixel(base({ triangles: [focal] }));
  near(r5.triAreas.get(1), 4, 1e-12, 's=0 且 q 在边界上，覆盖整个孔径');
  const r6 = onePixel(base({ stop: { offset: [0.5, 0], slope: [0, 0] }, triangles: [focal] }));
  near(r6.triAreas.get(1), 3, 1e-12, '光阑移开后该片份额同步变为 3');

  // 1e. 有效 s = s − f：f 等于 s 时该片变成“焦面全覆”
  const tri = { id: 1, depth: 1, s: 0.5, xy: [[0, 0], [4, 0], [0, 4]], rgb: [0, 1, 0] };
  const sc = { width: 4, height: 4, pupil: SQ, stop: { offset: [0, 0], slope: [0, 0] }, bg: [0, 0, 0], triangles: [tri] };
  const rf = onePixel(sc, 1, 1, { focusOffset: 0.5 });
  near(rf.triAreas.get(1), 4, 1e-9, 'f = s 时覆盖整个孔径');
  const rf2 = onePixel(sc, 3, 3, { focusOffset: 0.5 });
  ok(!rf2.triAreas.has(1), 'f = s 且 q 不在三角形内则为零');
  const rf3 = onePixel(sc, 1, 1, { focusOffset: 0.25 }); // 有效 s=0.25
  // 覆盖区 (q − T)/s 顶点为 (6,6)、(−10,6)、(6,−10)，远超孔径，应被裁到全部 4。
  near(rf3.triAreas.get(1), 4, 1e-9, '有效 s = s − f 后覆盖区随之缩放并裁到孔径');
}

// ---------------------------------------------------------------------------
// 2. 校验：无效凸孔径必须指出问题
// ---------------------------------------------------------------------------
{
  const concave = [[-1, -1], [1, -1], [0, 0], [1, 1], [-1, 1]];
  ok(E.validate(base({ pupil: concave })).some(s => s.includes('内凹')), '检出内凹孔径');
  const tooMany = Array.from({ length: 17 }, (_, i) => [Math.cos(i), Math.sin(i)]);
  ok(E.validate(base({ pupil: tooMany })).some(s => s.includes('3–16')), '检出顶点数超限（>16）');
  ok(E.validate(base({ pupil: [[0, 0], [1, 0]] })).some(s => s.includes('3–16')), '检出顶点数不足（<3）');
  ok(E.validate(base({ pupil: [[0, 0], [1, 0], [2, 0]] })).some(s => s.includes('面积')), '检出退化/共线孔径');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, -1], [1, 1]] })).some(s => s.includes('重合')), '检出重合顶点');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], width: 97 })).some(s => s.includes('96')), '检出宽度超限');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height: 73 })).some(s => s.includes('72')), '检出高度超限');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], triangles: [{ id: 1, depth: 1, s: 1, xy: [[0, 0], [1, 0], [2, 0]], rgb: [0, 0, 0] }] }))
    .some(s => s.includes('面积须大于 0')), '检出退化三角形');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], triangles: [
    { id: 1, depth: 1, s: 1, xy: [[0, 0], [1, 0], [0, 1]], rgb: [0, 0, 0] },
    { id: 1, depth: 2, s: 1, xy: [[0, 0], [1, 0], [0, 1]], rgb: [0, 0, 0] },
  ] })).some(s => s.includes('id 与前面')), '检出重复 id');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], triangles: new Array(65).fill(null).map((_, i) => ({ id: i, depth: 1, s: 1, xy: [[0, 0], [1, 0], [0, 1]], rgb: [0, 0, 0] })) }))
    .some(s => s.includes('64')), '检出三角形数量超限');
  ok(E.validate(base({ pupil: [[-1, -1], [1, -1], [1, 1], [-1, 1]], bg: [1.2, 0, 0] })).some(s => s.includes('0–1')), '检出背景色越界');
  // 16 顶点凸孔径合法
  const hex = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);
  ok(E.validate(base({ pupil: hex })).length === 0, '16 顶点正十六边形合法');
}

// ---------------------------------------------------------------------------
// 3. 与独立有理数参考实现交叉校验
//    随机坐标先量化到 1/64（double 可精确表示），这样有理数分母不会爆炸，
//    参考实现能在毫秒级完成；引擎看到的仍是同一组 double，判定不受影响。
// ---------------------------------------------------------------------------
{
  const Q = 64;
  const quant = v => Math.round(v * Q) / Q;
  let maxDiff = 0;
  let worst = null;
  const cases = [];
  cases.push([require('../samples/pupil-coverage.json'), 0, 1, 1]);
  cases.push([require('../samples/pupil-coverage.json'), 0, 0, 0]);
  const rand = rng(20261125);
  for (let trial = 0; trial < 20; trial++) {
    let pupil;
    do {
      const pts = [];
      const n = 3 + Math.floor(rand() * 12);
      for (let i = 0; i < n; i++) pts.push([quant((rand() * 2 - 1) * 1.4), quant((rand() * 2 - 1) * 1.4)]);
      pupil = convexHull(pts);
    } while (pupil.length < 3 || Math.abs(E.signedArea(pupil)) < 0.3);
    const tris = [];
    const nt = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < nt; i++) {
      const cx = quant((rand() * 2 - 1) * 2), cy = quant((rand() * 2 - 1) * 2);
      const xy = [];
      for (let k = 0; k < 3; k++) xy.push([quant(cx + (rand() * 2 - 1) * 2), quant(cy + (rand() * 2 - 1) * 2)]);
      if (Math.abs(E.signedArea(xy)) < 0.08) { i--; continue; }
      const s = rand() < 0.12 ? 0 : quant((rand() * 2 - 1) * 2.5);
      tris.push({ id: i + 1, depth: 1 + Math.floor(rand() * 4), s, xy, rgb: [rand(), rand(), rand()] });
    }
    const sc = {
      width: 5, height: 4, pupil,
      stop: { offset: [quant(rand() * 0.6 - 0.3), quant(rand() * 0.6 - 0.3)], slope: [quant(rand() * 0.3 - 0.15), quant(rand() * 0.3 - 0.15)] },
      bg: [rand(), rand(), rand()], triangles: tris,
    };
    for (let p = 0; p < 4; p++) {
      cases.push([sc, quant((rand() - 0.5) * 1.2), Math.floor(rand() * 5), Math.floor(rand() * 4)]);
    }
  }
  for (const [sc, f, px, py] of cases) {
    const { errors, prepared } = E.prepare(sc);
    if (errors.length) continue;
    const a = E.computePixel(prepared, px, py, { focusOffset: f });
    const b = referencePixel(sc, px, py, { focusOffset: f });
    const ids = new Set([...a.triAreas.keys(), ...b.triAreas.keys()]);
    for (const id of ids) {
      const d = Math.abs((a.triAreas.get(id) || 0) - (b.triAreas.get(id) || 0));
      if (d > maxDiff) { maxDiff = d; worst = { f, px, py, id }; }
    }
    for (const [ka, kb, name] of [[a.bgArea, b.bgArea, 'bg'], [a.domainArea, b.domainArea, 'domain'], [a.blackArea, b.blackArea, 'black']]) {
      const d = Math.abs(ka - kb);
      if (d > maxDiff) { maxDiff = d; worst = { f, px, py, name }; }
    }
  }
  ok(maxDiff < 1e-9, `与有理数参考实现最大面积偏差 ${maxDiff.toExponential(2)} < 1e-9`);
  console.log(`参考交叉校验：${cases.length} 个像素，最大面积偏差 ${maxDiff.toExponential(2)}` +
    (worst ? `（出现在 f=${worst.f}, 像素 ${worst.px},${worst.py}）` : ''));
}

// ---------------------------------------------------------------------------
// 4. 守恒与占比一致性
// ---------------------------------------------------------------------------
{
  const rand = rng(7);
  let maxCons = 0, maxShare = 0;
  for (let trial = 0; trial < 25; trial++) {
    let pupil;
    do {
      const pts = [];
      for (let i = 0; i < 3 + Math.floor(rand() * 12); i++) pts.push([(rand() * 2 - 1) * 1.3, (rand() * 2 - 1) * 1.3]);
      pupil = convexHull(pts);
    } while (pupil.length < 3 || Math.abs(E.signedArea(pupil)) < 0.3);
    const tris = [];
    for (let i = 0; i < 1 + Math.floor(rand() * 10); i++) {
      const cx = rand() * 4 - 2, cy = rand() * 4 - 2;
      const xy = [];
      for (let k = 0; k < 3; k++) xy.push([cx + (rand() * 2 - 1) * 2, cy + (rand() * 2 - 1) * 2]);
      if (Math.abs(E.signedArea(xy)) < 0.08) { i--; continue; }
      tris.push({ id: i + 1, depth: 1 + Math.floor(rand() * 5), s: (rand() * 2 - 0.4) * 2, xy, rgb: [rand(), rand(), rand()] });
    }
    const sc = { width: 7, height: 6, pupil, stop: { offset: [rand() * 0.6 - 0.3, rand() * 0.6 - 0.3], slope: [rand() * 0.2 - 0.1, rand() * 0.2 - 0.1] }, bg: [rand(), rand(), rand()], triangles: tris };
    const { errors, prepared } = E.prepare(sc);
    if (errors.length) continue;
    for (let p = 0; p < 8; p++) {
      const px = Math.floor(rand() * 7), py = Math.floor(rand() * 6);
      const f = (rand() - 0.5) * 1.5;
      const rec = E.computePixelShares(prepared, px, py, { focusOffset: f });
      const cons = Math.abs(rec.shareSum - 1);
      if (cons > maxCons) maxCons = cons;
      // 占比之和 × 原始孔径面积 == 面积之和
      let area = rec.bg.area + rec.black.area;
      for (const t of rec.tri) area += t.area;
      const ds = Math.abs(area - rec.pupilArea);
      if (ds > maxShare) maxShare = ds;
      // RGB 与占比一致
      let rr = rec.bg.share * prepared.bg[0] + rec.black.share * 0;
      for (const t of rec.tri) rr += t.share * t.rgb[0];
      near(rec.rgb[0], rr, 1e-12, 'RGB 与占比一致');
    }
  }
  ok(maxCons < 1e-12, `占比合计与 1 的最大偏差 ${maxCons.toExponential(2)}`);
  ok(maxShare < 1e-12, `面积合计与原始孔径面积的最大偏差 ${maxShare.toExponential(2)}`);
  console.log(`守恒校验：占比合计最大偏差 ${maxCons.toExponential(2)}，面积合计最大偏差 ${maxShare.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 5. 性能：96×72 + 64 片，覆盖苛刻摆放
// ---------------------------------------------------------------------------
{
  function hardScene() {
    const tris = [];
    const q0 = [48, 36];
    const rand = rng(12345);
    for (let i = 0; i < 64; i++) {
      const cx = (rand() * 2 - 1) * 0.9, cy = (rand() * 2 - 1) * 0.9;
      const r = 0.25 + rand() * 0.2, a0 = rand() * 6.283;
      const C = [
        [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r],
        [cx + Math.cos(a0 + 2.1) * r, cy + Math.sin(a0 + 2.1) * r],
        [cx + Math.cos(a0 + 4.2) * r, cy + Math.sin(a0 + 4.2) * r],
      ];
      tris.push({ id: i, depth: i, s: 1, xy: C.map(p => [q0[0] - p[0], q0[1] - p[1]]), rgb: [rand(), rand(), rand()] });
    }
    return { width: 96, height: 72, pupil: SQ, stop: { offset: [0, 0], slope: [0.02, 0.01] }, bg: [0.1, 0.2, 0.3], triangles: tris };
  }
  const sc = hardScene();
  const { errors, prepared } = E.prepare(sc);
  assert.deepStrictEqual(errors, []);
  const t0 = process.hrtime.bigint();
  let residual = 0;
  for (let y = 0; y < 72; y++) {
    for (let x = 0; x < 96; x++) {
      const r = E.computePixelShares(prepared, x, y, {});
      const d = Math.abs(r.shareSum - 1);
      if (d > residual) residual = d;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`96×72 × 64 片全帧渲染 ${ms.toFixed(0)} ms（预算 8000 ms），抽样占比偏差 ${residual.toExponential(1)}`);
  ok(ms < 8000, '性能预算内');
  ok(residual < 1e-12, '全部像素占比守恒');
}

// ---------------------------------------------------------------------------
// 6. 导出（Session）行为：无效场景保留上一次结果
// ---------------------------------------------------------------------------
{
  const { Session } = require('../session.js');
  const s = new Session();
  ok(s.loadScene(JSON.parse(JSON.stringify(require('../samples/pupil-coverage.json')))).ok, '载入样例成功');
  const res1 = s.render();
  ok(res1 && res1.pixels.length === 12, '样例渲染 4×3');
  const export1 = s.exportObject();
  ok(export1.pixels.length === 12, '导出行数');
  ok(Object.keys(export1.pixels[0].tri).length >= 0, '导出含 tri 键');
  // 归类检查：每个像素 tri 之和 + bg + black = 1
  for (const p of export1.pixels) {
    let sum = p.bg + p.black;
    for (const k of Object.keys(p.tri)) sum += p.tri[k];
    near(sum, 1, 1e-12, '导出占比合计为 1');
  }
  // 无效孔径
  const bad = JSON.parse(JSON.stringify(require('../samples/pupil-coverage.json')));
  bad.pupil = [[-1, -1], [1, -1], [0, 0], [1, 1], [-1, 1]];
  const badRes = s.loadScene(bad);
  ok(!badRes.ok && badRes.keptResult, '无效场景被拒并标记保留旧结果');
  ok(badRes.errors.some(e => e.includes('内凹')), '错误指出内凹位置');
  // 旧结果仍可检查与导出
  ok(s.result === res1, '渲染结果未被替换');
  const insp = s.inspect(1, 1);
  ok(insp && insp.pixel && insp.regions, '拒绝后仍可点查');
  ok(s.exportJSON() === JSON.stringify(export1, null, 0), '拒绝后仍可导出同样的数据');
  // 非法光阑参数不改变状态
  const st = s.stop;
  const r = s.setStop([NaN, 0], [0, 0]);
  ok(!r.ok && s.stop === st, '非法光阑参数不改变现有状态');
  const r2 = s.setFocusOffset(Infinity);
  ok(!r2.ok && s.focusOffset === 0, '非法 f 不改变现有状态');
}

console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 项通过，${failed} 项失败`);
if (failed) process.exitCode = 1;
