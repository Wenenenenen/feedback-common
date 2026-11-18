/*
 * tools/build-samples.js
 * 从 samples/extracted 的 JSON 生成 src/samples.js（内置样例，避免 file:// 下 fetch 受限）。
 * 用法: node tools/build-samples.js <样例目录> <输出文件>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [sampleDir, outFile] = process.argv.slice(2);
if (!sampleDir || !outFile) {
  console.error('用法: node tools/build-samples.js <样例目录> <输出文件>');
  process.exit(1);
}

const CASES = [
  'cube.json',
  'single-occluder.json',
  'overlapping-occluders.json',
  'coplanar.json',
  'perspective.json',
  'near-cross.json',
  'nonmanifold.json',
  'invalid-index.json',
];

const samples = {};
for (const f of CASES) {
  const p = path.resolve(sampleDir, f);
  samples[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(p, 'utf8'));
}

const banner = '// 由 tools/build-samples.js 自动生成，请勿手改。数据源: samples/extracted/*.json\n';
const body = 'window.HLM_SAMPLES = ' + JSON.stringify(samples, null, 2) + ';\n';
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, banner + body);
console.log(`已写入 ${outFile}，含 ${CASES.length} 个样例`);
