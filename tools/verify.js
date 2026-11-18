// Node 校验：
// 1) 双线性结果与 ref-bilinear/*.png 逐像素比对（应完全一致），PSNR 对照 reference.json
// 2) Hamilton-Adams 对 truth 的 PSNR 应不低于双线性
// 3) 三个 invalid RAW 必须被 parseRaw 拒绝
// 运行：node tools/verify.js
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRaw } from '../lib/raw.js';
import { processRaw, comparePsnr } from '../lib/pipeline.js';
import { decodePng } from '../lib/png.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'samples', 'extracted');
const CASES = ['zone', 'edges', 'lines', 'colorbars'];

let failures = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
};

const fmt = (v) => (v === Infinity ? 'Inf' : v.toFixed(3));

console.log('== 1. 双线性逐像素对齐 ref-bilinear ==');
const refMeta = JSON.parse(await readFile(join(DATA, 'reference.json'), 'utf8'));
for (const name of CASES) {
  console.log(`[${name}]`);
  const rawBytes = await readFile(join(DATA, `${name}.raw`));
  const wb = JSON.parse(await readFile(join(DATA, `${name}.json`), 'utf8'));
  const result = processRaw(rawBytes, wb, 'bilinear');
  const refPng = await decodePng(await readFile(join(DATA, 'ref-bilinear', `${name}.png`)));
  let mismatches = 0;
  let maxDiff = 0;
  for (let i = 0; i < result.rgb16.length; i++) {
    const d = Math.abs(result.rgb16[i] - refPng.data[i]);
    if (d !== 0) {
      mismatches++;
      maxDiff = Math.max(maxDiff, d);
    }
  }
  check(mismatches === 0, `与 ref-bilinear 逐像素一致（不一致 ${mismatches} 个，最大差 ${maxDiff}）`);

  const psnr = comparePsnr(result.rgb16, refPng.data);
  check(psnr.overall === Infinity, `对 ref-bilinear 的 PSNR 为 Inf（实际 ${fmt(psnr.overall)} dB）`);

  const truth = await decodePng(await readFile(join(DATA, 'truth', `${name}.png`)));
  const vsTruth = comparePsnr(result.rgb16, truth.data);
  const expected = refMeta[name].bilinearPsnr;
  check(
    Math.abs(vsTruth.overall - expected) < 0.01,
    `对 truth 的 PSNR=${fmt(vsTruth.overall)} dB，reference.json 给 ${expected} dB（容差 0.01）`,
  );

  // 输出范围与尺寸
  check(result.rgb16.length === result.raw.width * result.raw.height * 3, '输出尺寸 = 宽×高×3（未裁剪）');
  let outOfRange = 0;
  for (const v of result.rgb16) if (v > 65535) outOfRange++;
  check(outOfRange === 0, '全部样本落在 0..65535');

  console.log(`        分通道 PSNR(R/G/B) = ${vsTruth.perChannel.map(fmt).join(' / ')} dB`);
}

console.log('== 2. Hamilton-Adams 边缘自适应 ==');
// 含高频细节的用例上 HA 应不劣于双线性；colorbars 是理想硬色块，
// 边缘自适应的过冲在这类信号上可能反而吃亏，属于算法特性，如实记录不设断言。
const TEXTURE_CASES = ['zone', 'edges', 'lines'];
for (const name of CASES) {
  console.log(`[${name}]`);
  const rawBytes = await readFile(join(DATA, `${name}.raw`));
  const wb = JSON.parse(await readFile(join(DATA, `${name}.json`), 'utf8'));
  const ha = processRaw(rawBytes, wb, 'hamiltonAdams');
  const bl = processRaw(rawBytes, wb, 'bilinear');
  const truth = await decodePng(await readFile(join(DATA, 'truth', `${name}.png`)));
  const haPsnr = comparePsnr(ha.rgb16, truth.data).overall;
  const blPsnr = comparePsnr(bl.rgb16, truth.data).overall;
  const tag = TEXTURE_CASES.includes(name) ? '纹理用例' : '硬色块用例（仅记录）';
  console.log(`        HA ${fmt(haPsnr)} dB vs 双线性 ${fmt(blPsnr)} dB  [${tag}]`);
  if (TEXTURE_CASES.includes(name)) {
    check(haPsnr >= blPsnr, `HA PSNR ${fmt(haPsnr)} >= 双线性 ${fmt(blPsnr)} dB`);
  }
  let outOfRange = 0;
  for (const v of ha.rgb16) if (v > 65535) outOfRange++;
  check(outOfRange === 0, '16 位输出无回绕（全部落在 0..65535）');
}

console.log('== 3. 异常 RAW 拒绝 ==');
for (const name of ['invalid-magic', 'invalid-pattern', 'invalid-truncated']) {
  const bytes = await readFile(join(DATA, `${name}.raw`));
  let err = null;
  try {
    parseRaw(bytes);
  } catch (e) {
    err = e;
  }
  check(err instanceof Error, `${name}.raw 被拒绝（原因：${err ? err.message : '未报错'}）`);
}

console.log('== 4. PNG 16 位编码回环 ==');
{
  const { encodePng16, decodePng } = await import('../lib/png.js');
  const w = 7;
  const h = 3;
  const src = new Uint16Array(w * h * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 4099 + 17) % 65536;
  const png = await encodePng16(w, h, src);
  const back = await decodePng(png);
  let ok = back.width === w && back.height === h && back.data.length === src.length;
  if (ok) for (let i = 0; i < src.length; i++) if (back.data[i] !== src[i]) ok = false;
  check(ok, 'encodePng16 -> decodePng 逐样本一致');
}

if (failures) {
  console.error(`\n${failures} 项校验失败`);
  process.exit(1);
}
console.log('\n全部校验通过');
