// build.mjs — 把 src/ 下的 ES 模块与 worker 内联成单文件 web/index.html
// 运行：node tools/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// 1. 取各模块源码，去掉 import/export 关键字，合并到一个 IIFE 命名空间 TSD
const stripModule = (code) => code
  .replace(/export\s+class\s+/g, 'class ')
  .replace(/export\s+async\s+function\s+/g, 'async function ')
  .replace(/export\s+function\s+/g, 'function ')
  .replace(/export\s+const\s+/g, 'const ');

const modules = [
  'src/wav-codec.js',
  'src/transient-detect.js',
  'src/time-stretch.js',
  'src/fft-spectrogram.js',
].map(read).map(stripModule);

const tsdSource = `const TSD = (function () {
${modules.join('\n\n')}
  return { parseWav, encodeWav, detectTransients, timeStretch, fft, magnitudeSpectrum, buildSpectrogram };
})();`;

// 2. worker：去掉相对 import，改为引用已内联的同名定义（worker 内独立注入一份）
const workerRaw = read('src/worker.js');
const workerBody = workerRaw
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/self\.onmessage/, 'self.onmessage');

const workerModules = [
  'src/wav-codec.js',
  'src/transient-detect.js',
  'src/time-stretch.js',
].map(read).map(stripModule);

const workerSource = `// 内联 Worker：瞬态保护 WSOLA 处理管线（独立作用域，Blob 内运行）
(function () {
${workerModules.join('\n\n')}
${workerBody}
})();`;

const injection = `${tsdSource}
const TSD_WORKER_SOURCE = ${JSON.stringify(workerSource)};`;

// 3. 注入模板
const template = read('web/index.template.html');
const html = template.replace('/* __DSP_MODULES__ */', injection);
writeFileSync(join(root, 'web/index.html'), html);
console.log('已生成 web/index.html，大小', (html.length / 1024).toFixed(1), 'KB');
