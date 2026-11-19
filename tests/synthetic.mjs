// 合成场景测试：用已知单应生成对应点，验证闭环残差、参考图切换、误点剔除端到端。
import { ransacHomography } from '../app/js/homography.js';
import { buildMosaic, MosaicError } from '../app/js/mosaic.js';
import { normalizeH, matMul, invert3 } from '../app/js/linalg.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

// 已知单应（含透视项），约定 H_ab 把 a 坐标映到 b
const H01 = normalizeH([1, 0.05, 30, -0.03, 1, 12, 0.0004, -0.0002, 1]);
const H12 = normalizeH([1, -0.02, 40, 0.02, 1, -8, 0.0001, 0.0003, 1]);
// 0->2 的闭环真值：H_02 = H_12 * H_01
const H02 = normalizeH(matMul(H12, H01));

const apply = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

// 生成网格对应点（a->b 方向）
function genPairs(H_ab, pts) {
  return pts.map(([x, y]) => [[x, y], apply(H_ab, x, y)]);
}
const grid = [];
for (const x of [20, 60, 100, 140]) for (const y of [20, 50, 80, 110]) grid.push([x, y]);

const pairs01 = genPairs(H01, grid);
const pairs12 = genPairs(H12, grid);
const pairs02 = genPairs(H02, grid);

// 加入 2 个误点
const noisy01 = pairs01.concat([[[5, 5], [100, 100]], [[150, 100], [8, 90]]]);
const noisy12 = pairs12.concat([[[8, 8], [120, 40]]]);

const mkImg = (id) => ({ name: `${id}.png`, width: 160, height: 120, data: new Uint8ClampedArray(160 * 120 * 4).fill(128) });
for (const im of [0, 1, 2]) mkImg(im).data.fill(255);
const images = [mkImg(0), mkImg(1), mkImg(2)];
for (const img of images) for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;

const match = {
  images: ['0.png', '1.png', '2.png'],
  reference: 0,
  edges: [
    { a: 0, b: 1, pairs: noisy01 },
    { a: 1, b: 2, pairs: noisy12 },
    { a: 0, b: 2, pairs: pairs02 },
  ],
};

console.log('闭环合成场景');
const r = buildMosaic(images, match, 3, 0);
check('生成树使用 2 条边', r.tree.treeEdges.length === 2);
check('识别出 1 条闭环边', r.tree.nonTreeEdges.length === 1);
check('闭环残差接近 0（理想对应）', r.loops[0].maxResidual < 0.05, `max=${r.loops[0].maxResidual}`);
check('无误点闭环不产生警告', r.loopWarnings.length === 0);
check('边 0-1 剔除 2 个误点', r.edgeResults[0].outliers.length === 2, JSON.stringify(r.edgeResults[0].outliers));
check('边 1-2 剔除 1 个误点', r.edgeResults[1].outliers.length === 1);

// 恢复矩阵与真值一致
const rec01 = r.edgeResults[0].H;
let hMatch = true;
const H01n = normalizeH(H01);
for (let i = 0; i < 9; i++) if (!approx(rec01[i], H01n[i], 2e-4)) hMatch = false;
check('RANSAC 恢复的 H01 与真值一致', hMatch);

// 参考图切换：以 1 为参考重新组合
const rRef1 = buildMosaic(images, match, 3, 1);
check('参考图切换后图 1 为单位阵', rRef1.toRef[1].every((v, i) => approx(v, i % 4 === 0 ? 1 : 0, 1e-9) || i === 8));
check('参考图切换闭环仍一致', rRef1.loops[0].maxResidual < 0.05);

// 不一致闭环：把闭环边的点整体平移 5px
const badMatch = JSON.parse(JSON.stringify(match));
badMatch.edges[2].pairs = badMatch.edges[2].pairs.map(([a, b]) => [a, [b[0] + 5, b[1]]]);
const rBad = buildMosaic(images, badMatch, 3, 0);
check('超阈值闭环产生不一致警告', rBad.loopWarnings.length === 1 && /不一致/.test(rBad.loopWarnings[0]));
check('闭环残差明显超过 5px（透视会放大平移量）', rBad.loops[0].maxResidual > 5 && rBad.loops[0].maxResidual < 7,
  `got ${rBad.loops[0].maxResidual}`);

// 点数不足 4 的边在输入校验阶段拒绝
const sparseMatch = JSON.parse(JSON.stringify(match));
sparseMatch.edges[1].pairs = sparseMatch.edges[1].pairs.slice(0, 3);
try {
  buildMosaic(images, sparseMatch, 3, 0);
  check('点数不足 4 的边被拒绝', false);
} catch (e) {
  check('点数不足 4 的边报 BAD_INPUT', e instanceof MosaicError && e.code === 'BAD_INPUT', e.message);
}

// 全坏点：4 对近似共线错配，4 点采样全部退化，RANSAC 无法建模 -> 拒绝生成
const allBad = {
  images: ['0.png', '1.png'], reference: 0,
  edges: [{
    a: 0, b: 1,
    pairs: [[[10, 10], [140, 100]], [[30, 10], [130, 90]], [[50, 10], [140, 80]], [[70, 10], [100, 60]]],
  }],
};
try {
  buildMosaic(images.slice(0, 2), allBad, 3, 0);
  check('无可靠边时拒绝生成', false);
} catch (e) {
  check('无可靠边时拒绝生成（MosaicError）', e instanceof MosaicError, e.message);
}

// 超 4096：图1->参考为强透视（地平线在图外但四角被放至极远），完整管线应拒绝
{
  const G = normalizeH([1, 0, 0, 0, 1, 0, -0.0008, 0, 1]);
  const H = normalizeH(invert3(G));
  const proj = (M, x, y) => {
    const w = M[6] * x + M[7] * y + M[8];
    return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
  };
  const pairs = [];
  for (const x of [100, 300, 500, 700]) for (const y of [100, 400, 700]) pairs.push([[x, y], proj(H, x, y)]);
  const big = { name: 'big.png', width: 1024, height: 1024, data: new Uint8ClampedArray(1024 * 1024 * 4) };
  for (let i = 3; i < big.data.length; i += 4) big.data[i] = 255;
  try {
    buildMosaic([big, big], { images: ['a.png', 'b.png'], reference: 0, edges: [{ a: 0, b: 1, pairs }] }, 3, 0);
    check('超 4096 画布被管线拒绝', false);
  } catch (e) {
    check('超 4096 画布报 CANVAS_TOO_LARGE', e instanceof MosaicError && e.code === 'CANVAS_TOO_LARGE', e.message);
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);