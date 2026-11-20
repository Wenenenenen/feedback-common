// 零依赖打包：把 app/js + lib 的 ES 模块按依赖顺序拼成两个经典脚本，
// 生成可直接双击打开的 dist/。不引入任何第三方构建工具。
//
// 产物：
//   dist/index.html       （内联 CSS 引用与经典脚本）
//   dist/app.js           （页面逻辑）
//   dist/worker-src.js    （把 worker 源码作为字符串注册到全局，供 Blob Worker 使用）
//
// 源码模式（npm run serve）不受影响，仍使用原生 ES 模块。

import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

// 依赖顺序（被依赖者在前）。与应用实际 import 关系一致。
const MAIN_ORDER = [
  'lib/crc32.js',
  'lib/png.js',
  'lib/layout.js',
  'lib/transform.js',
  'lib/engine.js',
  'app/js/export.js',
  'app/js/render.js',
  'app/js/samples.js',
  'app/js/main.js',
];

const WORKER_ORDER = ['lib/crc32.js', 'lib/png.js', 'lib/layout.js', 'lib/transform.js', 'lib/engine.js', 'app/js/worker.js'];

const IMPORT_RE = /^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm;
const EXPORT_DECL_RE = /^(\s*)export\s+(?=(async\s+)?(function|class|const|let|var)\b)/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{[^}]*\};?\s*$/gm;

function stripModuleSyntax(source, relPath) {
  let out = source.replace(IMPORT_RE, '');
  out = out.replace(EXPORT_LIST_RE, '');
  out = out.replace(EXPORT_DECL_RE, '$1');
  if (/\bexport\s/.test(out)) {
    throw new Error(`${relPath} 仍有未处理的 export 语句，打包器需要更新`);
  }
  if (/\bimport\.meta\b/.test(out)) {
    out = out.replace(/import\.meta\.url/g, 'document.baseURI');
  }
  return out;
}

function collectTopLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) names.add(m[1]);
  }
  return names;
}

async function bundle(files, banner) {
  const seen = new Set();
  const conflicts = new Map();
  const chunks = [];
  for (const rel of files) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const raw = await readFile(join(ROOT, rel), 'utf8');
    const stripped = stripModuleSyntax(raw, rel);
    for (const name of collectTopLevelNames(stripped)) {
      if (conflicts.has(name) && conflicts.get(name) !== rel) {
        throw new Error(`打包冲突：${name} 同时定义于 ${conflicts.get(name)} 与 ${rel}`);
      }
      conflicts.set(name, rel);
    }
    chunks.push(`// ---- ${rel} ----\n${stripped}`);
  }
  return `/* ${banner} */\n(() => {\n'use strict';\n${chunks.join('\n')}\n})();\n`;
}

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'css'), { recursive: true });

  const appJs = await bundle(MAIN_ORDER, 'group-transform-denoiser · 应用（自动生成，请勿手改）');
  const workerJs = await bundle(WORKER_ORDER, 'group-transform-denoiser · Worker（自动生成）');
  const workerSrcJs = `/* 将 worker 源码注册给主线程，用 Blob 构造 Worker，从而支持 file:// 直接打开 */\nself.__GTD_WORKER_SOURCE = ${JSON.stringify(workerJs)};\n`;

  await writeFile(join(OUT, 'app.js'), appJs);
  await writeFile(join(OUT, 'worker-src.js'), workerSrcJs);

  let html = await readFile(join(ROOT, 'app', 'index.html'), 'utf8');
  html = html
    .replace('<link rel="stylesheet" href="css/style.css" />', '<link rel="stylesheet" href="css/style.css" />')
    .replace('<script type="module" src="js/main.js"></script>', '<script src="worker-src.js"></script>\n  <script src="app.js"></script>');
  await writeFile(join(OUT, 'index.html'), html);
  await cp(join(ROOT, 'app', 'css', 'style.css'), join(OUT, 'css', 'style.css'));

  const sizes = await Promise.all(
    ['index.html', 'app.js', 'worker-src.js', 'css/style.css'].map(async (f) => {
      const s = await readFile(join(OUT, f));
      return `${f}: ${(s.length / 1024).toFixed(1)} KB`;
    }),
  );
  console.log(`构建完成 → dist/\n  ${sizes.join('\n  ')}`);
}

build().catch((err) => {
  console.error('构建失败：', err.message);
  process.exitCode = 1;
});
