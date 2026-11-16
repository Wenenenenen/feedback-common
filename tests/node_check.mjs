/*
 * Node 单元测试：直接测页面模块（不经过浏览器）。
 *
 * 运行：node tests/node_check.mjs [样例目录]
 * 覆盖：PFM 头/大小端/尺度/行序、立体角、积分、余弦卷积、旋转矩阵、
 *       JSON 导入导出往返与拒绝路径、色调映射不影响数值、取消。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleRoot = process.argv[2] || path.join(here, '..', 'samples', 'extracted');

const { parsePfm, PfmError } = await import('../src/web/js/pfm.js');
const {
  bakeEquirect, bakeEquirectAsync, convolve, deconvolve, rotateY, evaluate,
  l1Direction, basisAt, rowSolidAngles, luminance, BakeCancelledError,
  brightestDirection, directionAngles,
} = await import('../src/web/js/sh.js');
const {
  buildCoefficientJson, parseCoefficientJson, coefficientFileName,
  CoefficientJsonError,
} = await import('../src/web/js/coefficients.js');
const { displayRgb, toneMapScalar, srgbToLinear, TONE_MODES } = await import('../src/web/js/tonemap.js');
const { expectedChecks, rotateAxisY } = await import('../src/web/js/conformance.js');

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const relClose = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1e-12, Math.abs(b));

function readSample(name) {
  return fs.readFileSync(path.join(sampleRoot, name));
}

function bakeSample(name, opts = {}) {
  const parsed = parsePfm(readSample(name), opts);
  const baked = bakeEquirect(parsed.values, parsed.width, parsed.height);
  return { parsed, baked };
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const expected = JSON.parse(fs.readFileSync(path.join(sampleRoot, 'expected.json'), 'utf8'));

/* ── 1. PFM 解析 ─────────────────────────────────── */
console.log('\n[1] PFM 解析：字节序 / 尺度 / 行序 / 拒绝路径');
{
  const le = parsePfm(readSample('constant-le.pfm'));
  const be = parsePfm(readSample('constant-be-scale2.pfm'));
  check('小端样例 endian=little 且尺度为 −1', le.endian === 'little' && le.scale === -1);
  check('大端样例 endian=big 且尺度为 +2', be.endian === 'big' && be.scale === 2);
  check('大端 + 尺度 2 读出正常', be.factor === 2 && near(be.values[0], 1, 1e-6), String(be.values[0]));
  check('两份常量样例读出的像素完全一致', maxAbsDiff(le.values, be.values) === 0);
  check('尺寸 128×64', le.width === 128 && le.height === 64);
  check('逻辑顶行为 +y 极（常量样例看不出来，用 polar 验证）', true);

  const polar = parsePfm(readSample('polar.pfm'));
  check('polar 逻辑顶行（r=0）= 亮环 8.0', near(polar.values[0], 8, 1e-6), String(polar.values[0]));
  const lastRow = (polar.height - 1) * polar.width * 3;
  check('polar 逻辑底行（r=H−1）= 暗部 0.1', near(polar.values[lastRow], 0.1, 1e-7));

  // 顶行优先覆盖：把底行优先的图按顶行优先读，应得到镜像图
  const topOrdered = parsePfm(readSample('polar.pfm'), { rowOrder: 'top' });
  check('rowOrder=top 时顶底互换', near(topOrdered.values[0], 0.1, 1e-7)
    && near(topOrdered.values[lastRow], 8, 1e-6));

  // 字节序覆盖确实生效：把大端文件按小端读，数值会完全走样
  const wrongEndian = parsePfm(readSample('constant-be-scale2.pfm'), { byteOrder: 'little' });
  // 按小端读大端文件会得到极小的非规格化数，绝不等于 1.0
  check('byteOrder 覆盖被应用（按小端读大端文件 → 数值走样）',
    Math.abs(wrongEndian.values[0] - 1) > 1e-6,
    String(wrongEndian.values[0]));
  const scaleOverride = parsePfm(readSample('constant-be-scale2.pfm'), { scaleMode: 'one' });
  check('scaleMode=one 时忽略尺度（读出 0.5 而非 1.0）',
    near(scaleOverride.values[0], 0.5, 1e-6), String(scaleOverride.values[0]));

  const cases = [
    ['truncated.pfm', 'PFM_TRUNCATED'],
    ['nan.pfm', 'PFM_NONFINITE'],
  ];
  for (const [file, code] of cases) {
    let err = null;
    try {
      parsePfm(readSample(file));
    } catch (e) {
      err = e;
    }
    check(`${file} 抛 ${code}`, err instanceof PfmError && err.code === code, err?.code || '无异常');
  }

  let ertrunc = null;
  try {
    parsePfm(readSample('truncated.pfm'));
  } catch (e) {
    ertrunc = e;
  }
  check('截断错误报告缺失字节数', ertrunc?.details?.missing === 7, String(ertrunc?.details?.missing));

  let ernan = null;
  try {
    parsePfm(readSample('nan.pfm'));
  } catch (e) {
    ernan = e;
  }
  check('非有限值错误报告首个位置（行/列/通道）',
    ernan?.details?.first?.channel === 'B' && ernan?.details?.first?.row === 0,
    JSON.stringify(ernan?.details?.first || null));

  // 头错误
  const headerCases = [
    [Buffer.from(''), 'PFM_EMPTY'],
    [Buffer.from('Pf\n4 2\n-1\n' + '\0'.repeat(96)), 'PFM_HEADER'],
    [Buffer.from('P6\n4 2\n-1\n' + '\0'.repeat(96)), 'PFM_HEADER'],
    [Buffer.from('PF\nabc 64\n-1\n'), 'PFM_DIMENSIONS'],
    [Buffer.from('PF\n0 64\n-1\n'), 'PFM_DIMENSIONS'],
    [Buffer.from('PF\n2048 1024\n-1\n'), 'PFM_DIMENSIONS'],
    [Buffer.from('PF\n128 64\n0\n'), 'PFM_SCALE'],
    [Buffer.from('PF\n128 64\nabc\n'), 'PFM_SCALE'],
  ];
  for (const [buf, code] of headerCases) {
    let err = null;
    try {
      parsePfm(new Uint8Array(buf));
    } catch (e) {
      err = e;
    }
    check(`头错误 → ${code}`, err instanceof PfmError && err.code === code, err?.code || '无异常');
  }
  const oversizeErr = (() => {
    try {
      parsePfm(new Uint8Array(Buffer.from('PF\n2048 1024\n-1\n')));
    } catch (e) {
      return e;
    }
    return null;
  })();
  check('尺寸超限期报出上限 1024×512',
    oversizeErr?.details?.maxWidth === 1024 && oversizeErr?.details?.maxHeight === 512);
}

/* ── 2. 立体角 ───────────────────────────────────── */
console.log('\n[2] 立体角');
{
  const { rowSolidAngles: rows, total } = rowSolidAngles(64);
  check('ΣΩ = 4π', near(total, 4 * Math.PI, 1e-12), String(total));
  check('expected.solid_angle 即 4π', near(expected.solid_angle, 4 * Math.PI, 1e-12));
  check('行立体角关于赤道对称', near(rows[0], rows[63], 1e-15));
  check('极区行 < 赤道行', rows[0] < rows[32]);
  check('顶行立体角 = 2π(1−cos(π/H))',
    near(rows[0], 2 * Math.PI * (1 - Math.cos(Math.PI / 64)), 1e-15));
  check('非 1024 宽也按 2:1 给出相同总立体角',
    near(rowSolidAngles(32).total, 4 * Math.PI, 1e-12));
}

/* ── 3. 积分与卷积 ───────────────────────────────── */
console.log('\n[3] 积分与余弦卷积');
let constBaked;
{
  const { baked } = bakeSample('constant-le.pfm');
  constBaked = baked;
  const rgb = expected.constant_rgb;
  const C0 = 4 * Math.PI * 0.28209479177387814;
  check('C₀ = 4π·Y00·L', [0, 1, 2].every((k) => relClose(baked.radiance[k], C0 * rgb[k], 1e-6)),
    Array.from(baked.radiance.slice(0, 3)).join(','));
  const worst = Math.max(...Array.from(baked.radiance.slice(3)).map(Math.abs));
  check('常量环境 l>0 离散残差 < 5e-3', worst < 5e-3, worst.toExponential(2));
  const e = convolve(baked.radiance);
  check('E₀ = π·C₀（逐通道）', [0, 1, 2].every((k) => relClose(e[k], Math.PI * baked.radiance[k], 1e-12)));
  const back = deconvolve(e);
  check('卷积后反卷积可还原', maxAbsDiff(back, baked.radiance) < 1e-15);
  check('l=1 卷积因子 2π/3', relClose(e[3], baked.radiance[3] * (2 * Math.PI / 3), 1e-15));
  const probe = Float64Array.from({ length: 27 }, (_, i) => i + 1);
  const probeE = convolve(probe);
  check('l=2 卷积因子 π/4（逐项核对 9 组）',
    [4, 5, 6, 7, 8].every((i) => relClose(probeE[i * 3], (i * 3 + 1) * Math.PI / 4, 1e-15))
      && relClose(probeE[0], 1 * Math.PI, 1e-15));
  const evalConst = evaluate(e, 0.3, 0.5, -0.8);
  check('常量环境任意方向 E(n) = π·L（离散残差 < 1e-3）',
    [0, 1, 2].every((k) => Math.abs(evalConst[k] - Math.PI * rgb[k]) < 1e-3),
    Array.from(evalConst).join(','));

  // 大端+尺度样例必须逐位一致
  const { baked: beBaked } = bakeSample('constant-be-scale2.pfm');
  check('大端 + 尺度 2 与 小端 + 尺度 1 的系数逐位一致',
    maxAbsDiff(beBaked.radiance, baked.radiance) === 0);

  // 每行贡献之和应等于总系数
  let maxDiff = 0;
  for (let j = 0; j < 27; j++) {
    let acc = 0;
    for (let r = 0; r < baked.height; r++) acc += baked.rowContrib[r * 27 + j];
    maxDiff = Math.max(maxDiff, Math.abs(acc - baked.radiance[j]));
  }
  check('逐行贡献之和 = 总系数', maxDiff < 1e-12, maxDiff.toExponential(2));
  check('weightedMean = C₀/(Y00·4π)',
    [0, 1, 2].every((k) => relClose(baked.weightedMean[k], baked.radiance[k] / (0.28209479177387814 * 4 * Math.PI), 1e-12)));
  check('常量环境直接平均 = 立体角加权', maxAbsDiff(baked.naiveMean, baked.weightedMean) < 1e-12);
}

let linearBaked;
{
  const { baked } = bakeSample('linear.pfm');
  linearBaked = baked;
  const e = convolve(baked.radiance);
  let worst = 0;
  for (const [x, y, z] of [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const got = evaluate(e, x, y, z);
    const base = 1 + (2 / 3) * (0.6 * x + 0.2 * y);
    const want = [Math.PI * base, Math.PI * 2 * base, Math.PI * 0.5 * base];
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - want[k]) / Math.abs(want[k]));
  }
  check('E(n) = π·C·(1 + ⅔(0.6nx + 0.2ny))，6 方向 < 2e-4', worst < 2e-4, worst.toExponential(2));
  check('l=1 x 系数为正（亮部在 +x）', baked.radiance[9] > 0);
  check('l=1 y 系数为正（亮部偏上）', baked.radiance[3] > 0);
}

{
  const { baked } = bakeSample('polar.pfm');
  const naive = baked.naiveMean[0];
  const weighted = baked.weightedMean[0];
  check('极区样例：直接平均 > 立体角加权 ×1.5', naive > weighted * 1.5, `${naive} vs ${weighted}`);
  const l1 = l1Direction(baked.radiance);
  check('极区亮部指向 +y', l1 && l1.y > 0.99999, l1 ? String(l1.y) : 'null');
  check('极区样例行平均在顶部远高于底部',
    baked.rowMeanLuminance[0] > baked.rowMeanLuminance[baked.height - 1] * 5);
}

/* ── 4. 基函数与旋转 ─────────────────────────────── */
console.log('\n[4] 基函数与绕 y 轴旋转');
{
  const b = basisAt(1, 0, 0);
  check('Y00 = 0.28209479177387814', near(b[0], 0.28209479177387814, 1e-16));
  check('+x 只有 Y11 非零', near(b[3], 0.4886025119029199, 1e-16) && near(b[1], 0, 1e-16));
  check('+y 只有 Y1−1 非零', near(basisAt(0, 1, 0)[1], 0.4886025119029199, 1e-16));
  check('+z 只有 Y10 非零', near(basisAt(0, 0, 1)[2], 0.4886025119029199, 1e-16));
  check('Y20(+z) = 0.630783…', near(basisAt(0, 0, 1)[6], 2 * 0.31539156525252005, 1e-16));

  // 正交性：数值蒙特卡洛（球面均匀采样 + 立体角权重由等距柱状积分等价代换）
  let gram = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const { rowSolidAngles: rows, total } = rowSolidAngles(64);
  for (let r = 0; r < 64; r++) {
    const th = (Math.PI * (r + 0.5)) / 64;
    for (let c = 0; c < 64; c++) {
      const ph = (2 * Math.PI * (c + 0.5)) / 64;
      const v = basisAt(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      const dw = (rows[r] / 64);
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) gram[i][j] += v[i] * v[j] * dw;
    }
  }
  let worstOrtho = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) worstOrtho = Math.max(worstOrtho, Math.abs(gram[i][j] - (i === j ? 1 : 0)));
  }
  check('基在整球上正交归一（离散误差 < 5e-3）', worstOrtho < 5e-3, worstOrtho.toExponential(2));
  check('采样立体角仍为 4π', near(total, 4 * Math.PI, 1e-12));

  const c = linearBaked.radiance;
  const r90 = rotateY(c, 90);
  // R(90°) 把 +x 送到 −z，故 C'(z) = −C(x)、C'(x) = C(z)
  check('+90°：C(z) → −C(x) 且 C(x) → C(z)',
    near(r90[6], -c[9], 1e-15) && near(r90[9], c[6], 1e-15),
    `z' ${r90[6]} / x' ${r90[9]}`);
  check('+90°：C(y) 不变', near(r90[3], c[3], 1e-15));
  check('+90°：C₀ 不变', near(r90[0], c[0], 1e-15));

  // 与「旋转后重新积分」交叉验证（导言所给等价形式：C'_i = ∫L(m)Y_i(Rm)dm）
  const parsed = parsePfm(readSample('linear.pfm'));
  const t = Math.PI / 6;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const direct = new Float64Array(27);
  const om = rowSolidAngles(parsed.height).rowSolidAngles;
  for (let r = 0; r < parsed.height; r++) {
    const th = (Math.PI * (r + 0.5)) / parsed.height;
    const sinT = Math.sin(th);
    const y0 = Math.cos(th);
    const dw = om[r] / parsed.width;
    for (let col = 0; col < parsed.width; col++) {
      const ph = (2 * Math.PI * (col + 0.5)) / parsed.width;
      const x0 = sinT * Math.cos(ph);
      const z0 = sinT * Math.sin(ph);
      const x = ct * x0 + st * z0;
      const z = -st * x0 + ct * z0;
      const bf = basisAt(x, y0, z);
      const o = (r * parsed.width + col) * 3;
      for (let i = 0; i < 9; i++) {
        for (let k = 0; k < 3; k++) direct[i * 3 + k] += bf[i] * parsed.values[o + k] * dw;
      }
    }
  }
  const r30 = rotateY(linearBaked.radiance, 30);
  check('30°：矩阵旋转与重新积分一致（<1e-12 相对）',
    maxAbsDiff(r30, direct) < 3e-13, maxAbsDiff(r30, direct).toExponential(2));

  const back = rotateY(rotateY(c, 37), -37);
  check('旋转可逆（37° 后 −37° 还原）', maxAbsDiff(back, c) < 1e-15);
  const sum = rotateY(rotateY(c, 71), 289);
  check('旋转 360° 还原', maxAbsDiff(sum, c) < 1e-13, maxAbsDiff(sum, c).toExponential(2));
  check('rotateAxisY(90) 把 +x 送到 −z',
    near(rotateAxisY(90, 1, 0, 0).z, -1, 1e-12) && near(rotateAxisY(90, 1, 0, 0).x, 0, 1e-12));
  check('非有限角抛错', (() => {
    try {
      rotateY(c, NaN);
      return false;
    } catch {
      return true;
    }
  })());

  const bright = brightestDirection(convolve(c), 2048);
  check('最亮方向搜索落在 +x 附近', bright && bright.x > 0.9, bright ? String(bright.x) : 'null');
  const { theta, phi } = directionAngles(1, 0, 0);
  check('方向角：+x → θ 90°、φ 0°', near(theta, 90, 1e-12) && near(phi, 0, 1e-12), `${theta},${phi}`);
  const ang2 = directionAngles(0, 1, 0);
  check('方向角：+y → θ 0°', near(ang2.theta, 0, 1e-12));
}

/* ── 5. 色调映射不影响数值 ───────────────────────── */
console.log('\n[5] 显示映射与数值解耦');
{
  const rgb = [4, 1, 0.25];
  const outA = displayRgb(rgb, 1, 'reinhard', [0, 0, 0]);
  const outB = displayRgb(rgb, 4, 'aces', [0, 0, 0]);
  check('不同曝光/曲线得到不同显示像素', outA.join() !== outB.join());
  check('显示值在 0..255', outA.every((v) => v >= 0 && v <= 255));
  check('sRGB 往返稳定', near(srgbToLinear(255), 1, 1e-12));
  check('线性截断：超 1 截断', toneMapScalar(10, 1, 'linear-clip') === 1);
  check('Reinhard：大值趋近 1', toneMapScalar(1e6, 1, 'reinhard') > 0.9999);
  check('ACI 等曲线均有限', TONE_MODES.every((m) => Number.isFinite(toneMapScalar(3, 2, m.id))));

  const { baked } = bakeSample('linear.pfm');
  check('积分结果与色调映射无关（同一源就是同一系数）',
    maxAbsDiff(baked.radiance, linearBaked.radiance) === 0);
}

/* ── 6. 系数 JSON 往返 ───────────────────────────── */
console.log('\n[6] 系数 JSON 导出 / 导入');
{
  const rad = linearBaked.radiance;
  const irr = convolve(rad);
  const jsonR = buildCoefficientJson({ kind: 'radiance', coefficients: rad, rotationDeg: 0 });
  const jsonE = buildCoefficientJson({ kind: 'irradiance', coefficients: irr, rotationDeg: 0 });
  check('两种 kind 的单位不同', jsonR.units === 'W/(m^2 sr)' && jsonE.units === 'W/m^2');
  check('两种 kind 的文件名不同',
    coefficientFileName('radiance', 0) !== coefficientFileName('irradiance', 0),
    `${coefficientFileName('radiance', 0)} / ${coefficientFileName('irradiance', 0)}`);
  check('旋转角写进文件名', coefficientFileName('radiance', -90).includes('m90deg'),
    coefficientFileName('radiance', -90));
  check('导出含基标识', jsonR.basis.id === 'irradiance-sh-baker.real-sh-acn-l2-yup');
  check('导出含 9 组 RGB', jsonR.coefficients.length === 9 && jsonR.coefficients[0].length === 3);

  const backR = parseCoefficientJson(JSON.stringify(jsonR));
  check('radiance 往返：辐亮度系数逐位一致', maxAbsDiff(backR.radiance, rad) === 0);
  const backE = parseCoefficientJson(JSON.stringify(jsonE));
  check('irradiance 往返：内部辐亮度系数还原', maxAbsDiff(backE.radiance, rad) < 1e-14);
  check('irradiance 往返：辐照度系数逐位一致', maxAbsDiff(backE.irradiance, irr) === 0);

  // 导出 → 导入 → 再导出应完全相同
  const round2 = buildCoefficientJson({
    kind: 'radiance', coefficients: backR.radiance, rotationDeg: backR.rotationDeg,
  });
  check('二次导出数值完全一致',
    JSON.stringify(round2.coefficients) === JSON.stringify(jsonR.coefficients));

  const rotated = buildCoefficientJson({
    kind: 'radiance', coefficients: rotateY(rad, 90), rotationDeg: 90,
  });
  const backRot = parseCoefficientJson(JSON.stringify(rotated));
  check('旋转角 90° 被记录为已烘焙', backRot.rotationDeg === 90);
  check('导入旋转后系数不会再次旋转', maxAbsDiff(backRot.radiance, rotateY(rad, 90)) === 0);

  // 拒绝路径
  const rejects = [
    ['缺基标识', { kind: 'radiance', coefficients: jsonR.coefficients }, 'COEF_BASIS_MISSING'],
    ['基标识不符', { basis: { id: 'fuma' }, kind: 'radiance', coefficients: jsonR.coefficients }, 'COEF_BASIS_MISMATCH'],
    ['kind 缺失', { basis: { id: jsonR.basis.id }, coefficients: jsonR.coefficients }, 'COEF_KIND'],
    ['kind 拼错', { basis: { id: jsonR.basis.id }, kind: 'irradiancex', coefficients: jsonR.coefficients }, 'COEF_KIND'],
    ['units 不匹配', {
      basis: { id: jsonR.basis.id }, kind: 'radiance', units: 'W/m^2', coefficients: jsonR.coefficients,
    }, 'COEF_UNITS'],
    ['只有 8 组', {
      basis: { id: jsonR.basis.id }, kind: 'radiance', coefficients: jsonR.coefficients.slice(0, 8),
    }, 'COEF_SHAPE'],
    ['某组只有 2 个数', {
      basis: { id: jsonR.basis.id }, kind: 'radiance',
      coefficients: [jsonR.coefficients[0], [1, 2], ...jsonR.coefficients.slice(2)],
    }, 'COEF_SHAPE'],
    ['非有限值', {
      basis: { id: jsonR.basis.id }, kind: 'radiance',
      coefficients: [[1, 2, null], ...jsonR.coefficients.slice(1)],
    }, 'COEF_SHAPE'],
    ['NaN 数值', {
      basis: { id: jsonR.basis.id }, kind: 'radiance',
      coefficients: [[1, 2, 'NaN'], ...jsonR.coefficients.slice(1)],
    }, 'COEF_SHAPE'],
    ['rotation 非数字', {
      basis: { id: jsonR.basis.id }, kind: 'radiance', rotation: { degrees: 'x' },
      coefficients: jsonR.coefficients,
    }, 'COEF_ROTATION'],
    ['rotation 轴不是 y', {
      basis: { id: jsonR.basis.id }, kind: 'radiance', rotation: { axis: 'z', degrees: 0 },
      coefficients: jsonR.coefficients,
    }, 'COEF_ROTATION'],
    ['声明未烘焙', {
      basis: { id: jsonR.basis.id }, kind: 'radiance',
      rotation: { degrees: 0, bakedIntoCoefficients: false }, coefficients: jsonR.coefficients,
    }, 'COEF_ROTATION'],
    ['基函数列表不符', {
      basis: { id: jsonR.basis.id, functions: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
      kind: 'radiance', coefficients: jsonR.coefficients,
    }, 'COEF_BASIS_MISMATCH'],
  ];
  for (const [name, payload, code] of rejects) {
    let err = null;
    try {
      parseCoefficientJson(JSON.stringify(payload));
    } catch (e) {
      err = e;
    }
    check(`拒绝：${name} → ${code}`, err instanceof CoefficientJsonError && err.code === code,
      err ? `${err.code}: ${err.message}` : '未报错');
  }
  let syntaxErr = null;
  try {
    parseCoefficientJson('{nope');
  } catch (e) {
    syntaxErr = e;
  }
  check('拒绝：JSON 语法错误', syntaxErr?.code === 'COEF_JSON_PARSE');
  check('拒绝：导出非有限系数', (() => {
    const bad = Float64Array.from(rad);
    bad[4] = NaN;
    try {
      buildCoefficientJson({ kind: 'radiance', coefficients: bad, rotationDeg: 0 });
      return false;
    } catch {
      return true;
    }
  })());
  // 缺 units 只警告，不拒绝
  const noUnits = JSON.parse(JSON.stringify(jsonR));
  delete noUnits.units;
  const parsedNoUnits = parseCoefficientJson(JSON.stringify(noUnits));
  check('缺 units 时警告但接受', parsedNoUnits.warnings.some((w) => w.includes('units')));
}

/* ── 7. 取消 ─────────────────────────────────────── */
console.log('\n[7] 取消烘焙');
{
  const parsed = parsePfm(readSample('linear.pfm'));
  let err = null;
  try {
    bakeEquirect(parsed.values, parsed.width, parsed.height, { shouldCancel: () => true });
  } catch (e) {
    err = e;
  }
  check('同步烘焙可被取消', err instanceof BakeCancelledError);

  let calls = 0;
  let asyncErr = null;
  try {
    await bakeEquirectAsync(parsed.values, parsed.width, parsed.height, {
      chunkRows: 1,
      yieldFn: async () => {},
      shouldCancel: () => ++calls > 2,
    });
  } catch (e) {
    asyncErr = e;
  }
  check('异步烘焙在让出点检查取消', asyncErr instanceof BakeCancelledError, String(calls));

  const full = await bakeEquirectAsync(parsed.values, parsed.width, parsed.height, {
    chunkRows: 4,
    yieldFn: async () => {},
  });
  check('异步结果与同步结果逐位一致', maxAbsDiff(full.radiance, linearBaked.radiance) === 0);

  let lengthErr = null;
  try {
    bakeEquirect(new Float32Array(10), 4, 4);
  } catch (e) {
    lengthErr = e;
  }
  check('像素长度不符抛 TypeError', lengthErr instanceof TypeError);
}

/* ── 8. 参考值核对 ───────────────────────────────── */
console.log('\n[8] 与 expected.json 的核对');
{
  const { baked } = bakeSample('constant-le.pfm');
  const checksConst = expectedChecks(expected, 'constant-le', baked);
  check('常量样例全部核对通过', checksConst.length >= 4 && checksConst.every((c) => c.pass),
    checksConst.filter((c) => !c.pass).map((c) => c.name).join('; '));

  const lin = bakeSample('linear.pfm').baked;
  const checksLin = expectedChecks(expected, 'linear', lin);
  check('线性样例全部核对通过', checksLin.length >= 4 && checksLin.every((c) => c.pass),
    checksLin.filter((c) => !c.pass).map((c) => `${c.name}:${c.detail}`).join('; '));

  const pol = bakeSample('polar.pfm').baked;
  const checksPol = expectedChecks(expected, 'polar', pol);
  check('极区样例全部核对通过', checksPol.every((c) => c.pass),
    checksPol.filter((c) => !c.pass).map((c) => c.name).join('; '));
}

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
