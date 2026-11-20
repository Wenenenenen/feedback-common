// 命令行批处理：对一张 8 位灰度 PNG 运行两阶段协同去噪，并写出与网页导出
// 相同格式的结果（初估/最终 PNG、.npy、报告）。用于批量回归与离线校验。
//
// 用法：
//   node tools/cli.js input.png [--patch 4] [--radius 4] [--stride 2]
//        [--capacity 4] [--sigma 18] [--threshold 2.7] [--reference clean.png]
//        [--out out/]

import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { decodePNG } from '../lib/png.js';
import { runDenoise, psnr, validateParams } from '../lib/engine.js';
import { referenceCenters } from '../lib/layout.js';
import {
  buildPilotPNG,
  buildFinalPNG,
  buildFloatNpy,
  buildReport,
} from '../app/js/export.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = value;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args._.length) {
  console.error('用法：node tools/cli.js input.png [--patch 4] [--radius 4] [--stride 2] [--capacity 4] [--sigma 18] [--threshold 2.7] [--reference clean.png] [--out out/]');
  process.exit(2);
}

const inputPath = resolve(args._[0]);
const outDir = resolve(args.out || 'out');
const overrides = {};
for (const key of ['patch', 'radius', 'stride', 'capacity', 'sigma', 'threshold']) {
  if (args[key] !== undefined) overrides[key] = Number(args[key]);
}
let params;
try {
  params = validateParams(overrides);
} catch (err) {
  console.error(`参数不合法：${err.message}`);
  process.exit(2);
}

let image;
try {
  image = await decodePNG(await readFile(inputPath));
} catch (err) {
  console.error(`无法读取图片：${err.message}`);
  process.exit(1);
}
let result;
try {
  result = await runDenoise(image, params);
} catch (err) {
  console.error(`计算失败：${err.message}`);
  process.exit(1);
}
if (result.canceled) {
  console.error('计算被取消');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const stem = basename(inputPath, extname(inputPath));
const name = (suffix) => join(outDir, `${stem}-${suffix}`);

await writeFile(name('pilot.png'), await buildPilotPNG(result));
await writeFile(name('final.png'), await buildFinalPNG(result));
await writeFile(name('float.npy'), buildFloatNpy(result));

let metrics = null;
if (args.reference) {
  const refPath = resolve(args.reference);
  const ref = await decodePNG(await readFile(refPath));
  if (ref.width !== image.width || ref.height !== image.height) {
    console.error(`参考图尺寸 ${ref.width}×${ref.height} 与输入 ${image.width}×${image.height} 不一致`);
    process.exit(2);
  }
  metrics = {
    reference: basename(refPath),
    psnrInput: psnr(ref.data, result.original, image.width, image.height),
    psnrPilot: psnr(ref.data, result.pilot, image.width, image.height),
    psnrFinal: psnr(ref.data, result.final, image.width, image.height),
  };
}

const refYs = referenceCenters(image.height, params.stride);
const refXs = referenceCenters(image.width, params.stride);
const report = buildReport(result, {
  sourceName: basename(inputPath),
  referenceCentersY: refYs,
  referenceCentersX: refXs,
  referenceGroupCount: refYs.length * refXs.length,
  metrics,
});
await writeFile(name('report.json'), JSON.stringify(report, null, 2));

const s1 = result.groups.stage1;
const s2 = result.groups.stage2;
console.log(`输入      ${basename(inputPath)}  ${image.width}×${image.height}`);
console.log(`参数      p=${params.patch} r=${params.radius} s=${params.stride} K=${params.capacity} σ=${params.sigma} 阈值=${params.threshold}×σ`);
console.log(`参考图块  ${refYs.length}×${refXs.length} = ${refYs.length * refXs.length}`);
console.log(`平均组员  ${s1.meanGroupSize.toFixed(2)} / ${s2.meanGroupSize.toFixed(2)}`);
console.log(`平均候选  ${s1.meanCandidates.toFixed(1)} / ${s2.meanCandidates.toFixed(1)}`);
console.log(`零权重像素 ${s1.zeroWeightPixels} / ${s2.zeroWeightPixels}`);
console.log(`耗时      ${result.timing.totalMs.toFixed(0)} ms（初估 ${result.timing.stage1Ms.toFixed(0)} / 维纳 ${result.timing.stage2Ms.toFixed(0)}）`);
if (metrics) {
  console.log(`PSNR      输入 ${metrics.psnrInput.toFixed(2)} → 初估 ${metrics.psnrPilot.toFixed(2)} → 最终 ${metrics.psnrFinal.toFixed(2)} dB`);
}
console.log(`输出      ${outDir}/${stem}-{pilot.png,final.png,float.npy,report.json}`);
