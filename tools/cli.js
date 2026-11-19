// 命令行批处理（与页面共用 js/core.js、js/project.js）。
//
// 用法：
//   node tools/cli.js --out out/ focus-0.png focus-1.png focus-2.png
//   node tools/cli.js --out out/ --levels 4 --lock lock.png a.png b.png
//   node tools/cli.js --out out/ --project project.json
//
// 产出：<out>/focus-stack.png、<out>/focus-stack-lock.png、<out>/project.json、<out>/report.json
// 参数与结果确定：相同输入与参数重复运行，PNG/JSON 逐字节相同。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { decodePng, encodePngRgb8, encodePngGray8 } from '../js/png.js';
import { runStack, applyLock, MAX_LEVELS } from '../js/core.js';
import { encodeProject, decodeProject, validateInputs, PROJECT_FORMAT, PROJECT_VERSION } from '../js/project.js';

function parseArgs(argv) {
  const opts = { levels: 5, lock: null, project: null, out: 'out', files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--levels') opts.levels = Number(argv[++i]);
    else if (a === '--lock') opts.lock = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.project && args.files.length === 0)) {
  console.log('用法: node tools/cli.js [--levels 1..6] [--lock lock.png] [--out 目录] a.png b.png ...');
  console.log('      node tools/cli.js [--out 目录] --project project.json');
  process.exit(args.help ? 0 : 2);
}

let images;
let levels = args.levels;
let labels = null;
if (args.project) {
  const proj = await decodeProject(await readFile(args.project, 'utf8'));
  images = proj.images;
  levels = proj.levels;
  labels = proj.labels;
} else {
  images = [];
  for (const path of args.files) {
    const bytes = await readFile(path);
    const dec = await decodePng(bytes);
    images.push({ name: basename(path), width: dec.width, height: dec.height, rgb8: dec.rgb8, colorType: dec.colorType, sourcePng: bytes });
  }
  if (args.lock) {
    const dec = await decodePng(await readFile(args.lock));
    if (!dec.gray8) throw new Error('锁定标签必须是灰度 PNG');
    labels = new Uint8Array(dec.gray8);
  }
}

const v = validateInputs(images);
if (!v.ok) throw new Error(v.errors.join('；'));
if (!Number.isInteger(levels) || levels < 1 || levels > MAX_LEVELS) throw new Error(`层数须为 1..${MAX_LEVELS}`);
if (labels && labels.length !== images[0].width * images[0].height) throw new Error('锁定标签尺寸与图像不符');

const t0 = performance.now();
const result = runStack({ images, levels });
const lock = applyLock(result.fusedRgb8, labels, images, result.width * result.height);

await mkdir(args.out, { recursive: true });
const png = await encodePngRgb8(result.width, result.height, lock.rgb8);
await writeFile(join(args.out, 'focus-stack.png'), png);

const lockPng = await encodePngGray8(
  result.width,
  result.height,
  labels || new Uint8Array(result.width * result.height),
);
await writeFile(join(args.out, 'focus-stack-lock.png'), lockPng);

const project = encodeProject({ images, levels: result.levels, labels, width: result.width, height: result.height });
await writeFile(join(args.out, 'project.json'), JSON.stringify(project));

// 报告不含耗时等非确定量，保证相同输入与参数下 report.json 也逐字节相同。
const report = {
  format: 'focus-pyramid-stack-report',
  version: PROJECT_VERSION,
  inputs: images.map((im, i) => ({ index: i + 1, name: im.name, width: im.width, height: im.height })),
  parameters: { levels: result.levels, requestedLevels: result.requestedLevels, epsilon: 1e-6, kernel: [1, 4, 6, 4, 1], border: 'reflect101' },
  sizes: result.sizes,
  stats: { ...result.stats, lockedPixelCount: lock.lockedPixels },
  lock: lock.lockedPixels ? { lockedPixels: lock.lockedPixels, file: 'focus-stack-lock.png' } : null,
};
await writeFile(join(args.out, 'report.json'), JSON.stringify(report, null, 2));

console.log(`输入 ${images.length} 张 ${result.width}×${result.height}，${result.levels} 层`);
console.log(`层尺寸 ${result.sizes.map((s) => `${s.w}×${s.h}`).join(' → ')}`);
console.log(`无纹理像素 ${result.stats.lowTexturePixels}，无效权重 ${result.stats.invalidWeightPixels}，超范围 ${result.stats.outOfRange}`);
console.log(`锁定像素 ${lock.lockedPixels}，耗时 ${(performance.now() - t0).toFixed(1)} ms`);
console.log(`已写入 ${join(args.out, 'focus-stack.png')}、focus-stack-lock.png、project.json、report.json`);
