// 命令行批量处理：node tools/cli.js <raw文件> <白平衡json> <算法> [输出目录]
// 产出：<case>-<algo>.png（16 位 RGB）与 <case>-<algo>.json（参数 + 指标）。
// 若同目录存在 truth/<case>.png 会自动计算 PSNR；否则指标字段置 null。
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { basename, join, dirname } from 'node:path';
import { processRaw, comparePsnr } from '../lib/pipeline.js';
import { encodePng16, decodePng } from '../lib/png.js';
import { ALGORITHMS } from '../lib/demosaic.js';

const [, , rawPath, wbPath, algoId, outArg] = process.argv;
if (!rawPath || !wbPath || !algoId) {
  console.error('用法: node tools/cli.js <raw.raw> <wb.json> <bilinear|hamiltonAdams> [输出目录]');
  process.exit(2);
}
if (!ALGORITHMS[algoId]) {
  console.error(`未知算法 "${algoId}"，可选：${Object.keys(ALGORITHMS).join(', ')}`);
  process.exit(2);
}

const outDir = outArg || join(dirname(rawPath), 'out');
await mkdir(outDir, { recursive: true });

const rawBytes = await readFile(rawPath);
const wb = JSON.parse(await readFile(wbPath, 'utf8'));

let result;
try {
  result = processRaw(rawBytes, wb, algoId);
} catch (e) {
  console.error(`RAW 解析失败：${e.message}`);
  process.exit(1);
}
const { raw, rgb16 } = result;
const caseName = basename(rawPath, '.raw');

const png = await encodePng16(raw.width, raw.height, rgb16);
const pngPath = join(outDir, `${caseName}-${algoId}.png`);
await writeFile(pngPath, png);

// 寻找同目录 truth/<case>.png
let psnr = null;
const truthPath = join(dirname(rawPath), 'truth', `${caseName}.png`);
try {
  await access(truthPath);
  const truth = await decodePng(await readFile(truthPath));
  psnr = comparePsnr(rgb16, truth.data);
} catch {
  // 无参考图时指标留空
}

const report = {
  case: caseName,
  algorithm: algoId,
  generatedAt: new Date().toISOString(),
  raw: {
    width: raw.width,
    height: raw.height,
    bits: raw.bits,
    pattern: raw.patternName,
    blackLevel: raw.black,
    whiteLevel: raw.white,
  },
  whiteBalance: wb,
  processing: {
    order: 'normalization -> white-balance -> clamp(0,1) -> demosaic -> 16bit quantize',
    boundary: 'mirror（-1->1, w->w-2），未裁剪',
    quantization: 'floor(v*65535+0.5)',
  },
  metrics: psnr && {
    psnrDb: Number(psnr.overall.toFixed(4)),
    perChannelPsnrDb: {
      r: Number(psnr.perChannel[0].toFixed(4)),
      g: Number(psnr.perChannel[1].toFixed(4)),
      b: Number(psnr.perChannel[2].toFixed(4)),
    },
    definition: '10*log10(65535^2/MSE)，三通道全部像素',
    reference: 'truth/' + `${caseName}.png`,
  },
  output: basename(pngPath),
};
const jsonPath = join(outDir, `${caseName}-${algoId}.json`);
await writeFile(jsonPath, JSON.stringify(report, null, 2));

console.log(`已导出 ${pngPath}（${raw.width}x${raw.height}, 16-bit RGB）`);
console.log(`已导出 ${jsonPath}`);
if (psnr) console.log(`PSNR(vs truth) = ${psnr.overall.toFixed(3)} dB`);
