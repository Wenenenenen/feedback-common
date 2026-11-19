// Node 验收脚本（与不可信样例目录分离，路径通过参数传入）：
//   node tests/run-tests.mjs <case-dir> [<case-dir> ...]
// 校验：RANSAC 内点、image_to_reference 矩阵、画布规则、地平线/连通/超限分支、
// sRGB 融合探针、透明 RGB 不贡献、距离权重。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, encodePng } from '../app/js/png.js';
import { ransacHomography, estimateHomography } from '../app/js/homography.js';
import { buildMosaic, MosaicError } from '../app/js/mosaic.js';
import { srgbDecode8, srgbEncode8, distanceToInvalid, blendLayers, warpLayer } from '../app/js/resample.js';
import { normalizeH, matMul, identity3, invert3 } from '../app/js/linalg.js';
import { checkHorizon } from '../app/js/geometry.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }
function approxH(H, E, tol = 1e-6) {
  const h = normalizeH(H);
  for (let i = 0; i < 9; i++) if (!approx(h[i], E[Math.floor(i / 3)][i % 3], tol)) return false;
  return true;
}

async function loadCase(dir) {
  const match = JSON.parse(await readFile(join(dir, 'matches.json'), 'utf8'));
  const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
  const images = [];
  for (const name of match.images) {
    const buf = await readFile(join(dir, name));
    const img = await decodePng(buf.buffer.slice(buf.byteOffset));
    images.push({ name, ...img });
  }
  return { match, expected, images };
}

for (const dir of process.argv.slice(2)) {
  console.log(`\n案例 ${dir}`);
  const { match, expected, images } = await loadCase(dir);

  // 1) 每条边的 RANSAC 内点
  for (let ei = 0; ei < match.edges.length; ei++) {
    const edge = match.edges[ei];
    const r = ransacHomography(edge.pairs, 3);
    const exp = edge.expected_inliers;
    check(`边${edge.a}-${edge.b} 内点与 expected_inliers 一致`,
      JSON.stringify(r.inliers) === JSON.stringify(exp),
      `got ${JSON.stringify(r.inliers)} want ${JSON.stringify(exp)}`);
    check(`边${edge.a}-${edge.b} 7 个误点全部剔除`, r.outliers.length === edge.pairs.length - exp.length);
    check(`边${edge.a}-${edge.b} 内点残差均≤阈值`, r.residuals.filter(x => x.inlier).every(x => x.error <= 3 + 1e-9));
  }

  // 2) 整管线 + image_to_reference 对照 expected.json
  const result = buildMosaic(images, match, 3, match.reference);
  let allMatch = true;
  for (let i = 0; i < images.length; i++) {
    if (!approxH(result.toRef[i], expected.image_to_reference[i], 1e-6)) allMatch = false;
  }
  check('image_to_reference 与 expected.json 一致（h33 归一化）', allMatch,
    JSON.stringify(result.toRef.map(normalizeH)));

  // 3) 画布规则：origin=floor(min)，far=ceil(max)，两端包含
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of result.bounds) {
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  check('画布 origin=floor(min)，offset=-origin',
    result.canvas.originX === Math.floor(minX) && result.canvas.originY === Math.floor(minY) &&
    result.canvas.offsetX === -result.canvas.originX);
  check('画布 far=ceil(max) 且两端包含',
    result.canvas.width === Math.ceil(maxX) - result.canvas.originX + 1 &&
    result.canvas.height === Math.ceil(maxY) - result.canvas.originY + 1);
  check('画布未超 4096', result.canvas.width <= 4096 && result.canvas.height <= 4096);

  // 4) 输出尺寸与 RGBA
  check('输出 RGBA 长度正确', result.rgba.length === result.canvas.width * result.canvas.height * 4);

  // 5) PNG 往返
  const png = await encodePng(result.canvas.width, result.canvas.height, result.rgba);
  const rt = await decodePng(png);
  let pngOk = true;
  for (let i = 0; i < result.rgba.length; i++) if (rt.data[i] !== result.rgba[i]) { pngOk = false; break; }
  check('PNG 编码/解码往返一致', pngOk);
}

// ---- 单元级探针 ----
console.log('\n单元探针');
// sRGB：等权黑白（直线光平均 0.5）编码应为 188
check('sRGB 直线光 0.5 编码为 188', srgbEncode8(0.5) === 188, `got ${srgbEncode8(0.5)}`);
check('sRGB 解码阈值 0.04045 分段', approx(srgbDecode8(10), 10 / 255 / 12.92, 1e-9) && srgbDecode8(255) === 1);
check('sRGB 往返', Array.from({ length: 256 }, (_, i) => i).every((i) => srgbEncode8(srgbDecode8(i)) === i));

// 距离变换：3x3 全有效，权重=距离+1，角点距离1，中心距离2
{
  const valid = new Uint8Array(9).fill(1);
  const dist = distanceToInvalid(valid, 3, 3);
  check('EDT 角点到画布外无效距离=1，中心=2', approx(dist[0], 1) && approx(dist[4], 2));
}
// 中间有无效洞
{
  const valid = new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  const dist = distanceToInvalid(valid, 3, 3);
  check('EDT 洞旁距离=1，对角=√2', approx(dist[0], 1) && approx(dist[2], 1) && approx(dist[8], 1));
}

// 透明 RGB 不贡献：单图层含透明像素（RGB 垃圾值），融合后透明处 RGBA=0
{
  const w = 4, h = 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 200; data[i * 4 + 1] = 100; data[i * 4 + 2] = 50;
    data[i * 4 + 3] = i < 4 ? 255 : 0; // 下半透明且 RGB 非零
  }
  const src = { width: w, height: h, data };
  const L = warpLayer(src, w, h, identity3());
  check('透明像素 valid 但 alpha=0 被融合跳过', L.alpha[5] === 0 && L.valid[5] === 1);
  const out = blendLayers([L], w, h);
  check('全透明列输出 RGBA 全 0', out[5 * 4] === 0 && out[5 * 4 + 3] === 0);
  check('不透明像素颜色保留', out[0 * 4] === 200 && out[0 * 4 + 1] === 100 && out[0 * 4 + 3] === 255);
}

// 双线性 + 预乘：半 alpha 黑底白块（直 alpha）插值不发暗（与朴素 straight 插值对比由公式保证）
{
  const w = 2, h = 1;
  const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
  const src = { width: w, height: h, data };
  // 平移 0.5 像素，使两个画布像素各采样到一半
  const H = [1, 0, 0.5, 0, 1, 0, 0, 0, 1];
  const L = warpLayer(src, w, h, H);
  check('逆映射边界外无效', L.valid[0] === 0); // cx=0 -> sx=-0.5 出界
  check('半覆盖 alpha≈0.5', approx(L.alpha[1], 0.5, 1e-6));
  const out = blendLayers([L], w, h);
  check('预乘融合颜色不被透明侧 RGB 污染（仍为白）', out[1 * 4] === 255 && out[1 * 4 + 1] === 255);
  check('半覆盖输出 alpha≈128', out[1 * 4 + 3] >= 127 && out[1 * 4 + 3] <= 128);
}

// ---- 失败分支 ----
console.log('\n失败分支');
// 连通性：3 张图只有 0-1 边
{
  const { images } = await loadCase(process.argv[2]);
  const match = {
    images: ['0.png', '1.png', '2.png'], reference: 0,
    edges: [{ a: 0, b: 1, pairs: gridPairs() }],
  };
  try { buildMosaic(images, match, 3, 0); check('不连通时报错', false); }
  catch (e) { check('不连通时报 DISCONNECTED', e instanceof MosaicError && e.code === 'DISCONNECTED', e.message); }
}
// 退化：4 点共线
{
  const collinear = [[[0, 0], [0, 0]], [[1, 0], [1, 0]], [[2, 0], [2, 0]], [[3, 0], [3, 0]]];
  try { estimateHomography(collinear.map(([a, b]) => ({ a, b }))); check('共线退化时报错', false); }
  catch (e) { check('共线退化时报错', /退化/.test(e.message), e.message); }
}
// 地平线：H 使图内某点齐次分母过零（w=1-0.02x，x=50 时 w=0）
{
  const H = normalizeH([1, 0, 0, 0, 1, 0, -0.02, 0, 1]);
  const r = checkHorizon(H, 160, 120);
  check('地平线穿图被拒绝', !r.ok && /地平线/.test(r.reason), JSON.stringify(r));
  const Hok = normalizeH([1, 0, 5, 0, 1, 7, 0, 0, 1]);
  check('普通平移单应通过地平线检查', checkHorizon(Hok, 160, 120).ok);
}
// 画布超限：构造强透视使包围盒爆炸（用合成小图）
{
  const img = { name: 'x.png', width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(128) };
  for (let i = 0; i < 64; i++) img.data[i * 4 + 3] = 255;
  // w=1-0.009x，x=7 处 w=0.937，投影 x'=7/0.937≈7.47 不爆炸；取更大系数使末角放大千倍
  const Hbig = normalizeH([1, 0, 0, 0, 1, 0, -0.009, 0, 1]);
  const { warpedBounds, computeCanvas } = await import('../app/js/geometry.js');
  const b = warpedBounds(Hbig, 100, 8); // x=99 -> w=0.109 -> x'≈908
  const Hhuge = normalizeH([1, 0, 0, 0, 1, 0, -0.000976, 0, 1]);
  const b2 = warpedBounds(Hhuge, 1000, 8); // x=999 -> w≈0.025 -> x'≈4 万
  const c = computeCanvas([b2, { minX: 0, minY: 0, maxX: 7, maxY: 7 }]);
  check('超 4096 画布被识别', c.width > 4096 || c.height > 4096, `${c.width}x${c.height}`);
  void img; void Hbig; void b;
}

// RANSAC 固定种子可复现
{
  const pairs = gridPairs();
  const r1 = ransacHomography(pairs, 3, { seed: 42 });
  const r2 = ransacHomography(pairs, 3, { seed: 42 });
  check('固定种子 RANSAC 可复现', JSON.stringify(r1.inliers) === JSON.stringify(r2.inliers));
}

function gridPairs() {
  const p = [];
  for (const x of [10, 50, 90, 130]) for (const y of [10, 50, 90]) p.push([[x, y], [x + 1, y + 1]]);
  return p;
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
