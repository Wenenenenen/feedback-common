/* 对照 samples 包内 reference.json 与《格式说明.md》规则的引擎自检 */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'js', 'engine.js'));
const SAMPLES = require(path.join(__dirname, '..', 'js', 'samples.js'));

const REF = SAMPLES['reference'];
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  PASS ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

function renderAll(scene, opts) {
  const st = E.createRender(scene, opts);
  while (!E.renderBatch(st, 1e9)) {}
  return st;
}
function allFinite(arr) {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

/* 1. 黑场景:全零且无非法值 */
console.log('[black]');
{
  const scene = E.buildScene(SAMPLES['black']);
  const st = renderAll(scene, { mode: 'mis', spp: 8, seed: 1, maxDepth: 8 });
  const { rgb, variance } = E.resultArrays(st);
  check('rgb 全零', rgb.every(v => v === 0));
  check('variance 全零', variance.every(v => v === 0));
  check('无非法值', allFinite(rgb) && allFinite(variance));
  check('完成路径数 = 8*64*64', st.stats.completedPaths === 8 * 64 * 64,
    'got ' + st.stats.completedPaths);
}

/* 2. 零面积发光面:忽略并计数,无非法值 */
console.log('[zero-area]');
{
  const scene = E.buildScene(SAMPLES['zero-area']);
  check('忽略零面积面数 = 1', scene.ignoredZeroArea === 1, 'got ' + scene.ignoredZeroArea);
  check('有效灯数 = 2', scene.lights.length === 2, 'got ' + scene.lights.length);
  for (const mode of ['brdf', 'light', 'mis']) {
    const st = renderAll(scene, { mode, spp: 4, seed: 7, maxDepth: 8 });
    const { rgb, variance } = E.resultArrays(st);
    check(mode + ' 模式无非法值', allFinite(rgb) && allFinite(variance));
  }
}

/* 3. 按功率选灯:概率 = 面积*亮度 归一化 */
console.log('[unequal-lights]');
{
  const scene = E.buildScene(SAMPLES['unequal-lights']);
  const probs = scene.lights.map(fi => scene.faces[fi].selectProb);
  check('选择概率 ≈ [2/3, 1/3]',
    approx(probs[0], REF.unequal_light_probabilities[0], 1e-12) &&
    approx(probs[1], REF.unequal_light_probabilities[1], 1e-12),
    'got ' + probs.join(', '));
  // 大样本下选择次数比例应贴近概率
  const st = renderAll(scene, { mode: 'light', spp: 64, seed: 3, maxDepth: 1 });
  const picks = st.stats.lightPicks;
  const total = picks[0] + picks[1];
  check('选择次数比例 ≈ 2/3', total > 0 && approx(picks[0] / total, 2 / 3, 0.02),
    'got ' + (picks[0] / total));
}

/* 4. 直接光探针:收敛到 reference.probe_rgb */
console.log('[direct-probe]');
{
  const scene = E.buildScene(SAMPLES['direct-probe']);
  const p = SAMPLES['direct-probe'].probe;
  const r = E.probeDirect(scene, p.point, p.normal, p.rho, 200000, 42);
  const exp = REF.probe_rgb;
  for (let k = 0; k < 3; k++) {
    check('probe[' + k + '] ≈ ' + exp[k],
      approx(r.rgb[k], exp[k], 0.01), 'got ' + r.rgb[k]);
  }
  // 黑场景探针应为 0
  const black = E.buildScene(SAMPLES['black']);
  const rb = E.probeDirect(black, p.point, p.normal, p.rho, 1000, 1);
  check('黑场景探针 = 0', rb.rgb.every(v => v === 0));
}

/* 5. 固定种子:分批/暂停续算与一次算完逐比特一致 */
console.log('[determinism]');
{
  const scene = E.buildScene(SAMPLES['bounce-room']);
  const oneShot = renderAll(scene, { mode: 'mis', spp: 8, seed: 99, maxDepth: 8 });
  // 模拟暂停/续算:小批次推进
  const chunked = E.createRender(scene, { mode: 'mis', spp: 8, seed: 99, maxDepth: 8 });
  let guard = 0;
  while (!chunked.done && guard++ < 100000) E.renderBatch(chunked, 0); // budget 0ms → 每批 256 路径
  check('分批完成', chunked.done);
  let same = oneShot.sum.length === chunked.sum.length;
  for (let i = 0; same && i < oneShot.sum.length; i++) same = oneShot.sum[i] === chunked.sum[i];
  check('sum 逐比特一致', same);
  check('完成路径数一致', oneShot.stats.completedPaths === chunked.stats.completedPaths);
}

/* 6. 三模式在直接照明场景下均值互相吻合(不算两遍灯) */
console.log('[modes agree: direct-only]');
{
  const scene = E.buildScene(SAMPLES['direct-only']);
  const means = {};
  for (const mode of ['brdf', 'light', 'mis']) {
    const st = renderAll(scene, { mode, spp: 256, seed: 5, maxDepth: 8 });
    const { rgb } = E.resultArrays(st);
    let s = 0;
    for (let i = 0; i < rgb.length; i++) s += rgb[i];
    means[mode] = s / (rgb.length / 3);
  }
  console.log('  均值: brdf=%s light=%s mis=%s',
    means.brdf.toFixed(5), means.light.toFixed(5), means.mis.toFixed(5));
  // 该场景几乎全是直接照明;MIS 与灯光模式应很接近,BRDF 噪声大但均值应同量级
  check('mis ≈ light (2%)', approx(means.mis, means.light, 0.02 * means.light),
    means.mis + ' vs ' + means.light);
  check('brdf ≈ mis (5%)', approx(means.brdf, means.mis, 0.05 * means.mis),
    means.brdf + ' vs ' + means.mis);
}

/* 7. 间接照明:bounce-room 地面应收到红色墙面的间接光(三模式均值吻合) */
console.log('[modes agree: bounce-room]');
{
  const scene = E.buildScene(SAMPLES['bounce-room']);
  const means = {};
  for (const mode of ['light', 'mis']) {
    const st = renderAll(scene, { mode, spp: 256, seed: 11, maxDepth: 8 });
    const { rgb } = E.resultArrays(st);
    let s = 0;
    for (let i = 0; i < rgb.length; i++) s += rgb[i];
    means[mode] = s / (rgb.length / 3);
  }
  console.log('  均值: light=%s mis=%s', means.light.toFixed(5), means.mis.toFixed(5));
  check('mis ≈ light (3%)', approx(means.mis, means.light, 0.03 * means.light),
    means.mis + ' vs ' + means.light);
}

/* 8. 深度规则:maxDepth=0 只看灯 */
console.log('[maxDepth]');
{
  const scene = E.buildScene(SAMPLES['direct-only']);
  const st = renderAll(scene, { mode: 'mis', spp: 16, seed: 2, maxDepth: 0 });
  const { rgb } = E.resultArrays(st);
  // 相机 (0,-4,2) 看向原点:灯在 z=2 顶部,视场内应有一部分像素直接看到灯,其余全黑;
  // maxDepth=0 时任何漫反射面贡献都必须为 0 —— 检查图像中没有"非灯"亮度:
  // 直接看灯的像素值应等于 8(发射值),其余为 0
  let ok = true;
  for (let i = 0; i < rgb.length; i++) {
    const v = rgb[i];
    if (!(v === 0 || approx(v, 8, 1e-9))) { ok = false; break; }
  }
  check('maxDepth=0 像素非 0 即 8', ok);
}

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
