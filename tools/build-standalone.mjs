/**
 * 单文件构建：把 js/ 下的 ES 模块按依赖顺序内联进 index.html，
 * 产出 dist/亚像素重建台.html（含内联 Worker、PNG codec，完全离线、无外部资源）。
 * 仓库保留模块化结构；仅发布 Artifact 时使用本脚本。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'dist');

// 依赖顺序：被依赖者在前
const ORDER = [
  'js/model.js',
  'js/solver.js',
  'js/png-codec.js',
  'js/reconstruct.js',
  'js/heatmap.js',
  'js/chart.js',
  'js/export.js',
  'js/solver-worker.js',
  'js/app.js',
];

function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s[^;]+;\s*$/gm, '')   // 去 import（同源内联后直接共享作用域）
    .replace(/^\s*export\s+/gm, '');            // 去 export 关键字，声明保留
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  let html = await readFile(join(ROOT, 'index.html'), 'utf8');

  const parts = [];
  for (const rel of ORDER) {
    const code = await readFile(join(ROOT, rel), 'utf8');
    parts.push(`/* ===== ${rel} ===== */\n${stripModuleSyntax(code)}`);
  }
  // 全部模块共享同一个 IIFE 作用域，函数/常量声明互相可见
  const inline = ';(function () {\n' + parts.join('\n\n') + '\n})();';

  // 用内联脚本替换模块引用
  if (!html.includes('<script type="module" src="./js/app.js"></script>')) {
    throw new Error('index.html 中的模块引用标签未找到，构建中止');
  }
  html = html.replace(
    '<script type="module" src="./js/app.js"></script>',
    `<script>\n${inline}\n</script>`
  );

  // Worker 改为 Blob 内联（完整自带 model/solver/reconstruct，独立全局作用域）
  html = html.replace(
    /const worker = new Worker\('\.\/js\/solver-worker\.js', \{ type: 'module' \}\);/,
    `const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));`
  );

  // 在脚本顶部注入自包含 Worker 源码（Blob 内联，保证取消能力不依赖外部文件）
  const workerParts = ['js/model.js', 'js/solver.js', 'js/reconstruct.js']
    .map(async (rel) => `/* ===== ${rel} ===== */\n${stripModuleSyntax(await readFile(join(ROOT, rel), 'utf8'))}`);
  const workerCode = (await Promise.all(workerParts)).join('\n\n') +
    '\nself.onmessage = function(ev){' +
    'if(ev.data.type!=="start")return;' +
    'try{runReconstruction(ev.data.payload,function(m,t){self.postMessage(m,t||[]);});}' +
    'catch(e){self.postMessage({type:"error",message:e&&e.message?e.message:String(e)});}};';
  const workerInline = 'const WORKER_SOURCE = ' + JSON.stringify(workerCode) + ';';
  html = html.replace('<script>\n', `<script>\n${workerInline}\n`);

  const out = join(OUT_DIR, '亚像素重建台.html');
  await writeFile(out, html, 'utf8');
  const stat = await readFile(out);
  console.log(`已生成 ${out}（${(stat.length / 1024).toFixed(1)} KB）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
