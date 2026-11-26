/*
 * 单文件构建：把 app/ 下的引擎、ZIP、UI 与内置演示数据内联进 index.html。
 * 输出到仓库根目录 index.html，可直接双击用 file:// 打开，无需服务器。
 * 运行：node tools/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const app = join(root, 'app');

const read = (p) => readFileSync(p, 'utf8');

// ESM -> 浏览器普通脚本：去掉 export 语句与 CommonMS 守卫（守卫本身已被 typeof 保护）
function stripModuleSyntax(code) {
  return code
    .replace(/^export\s*\{[\s\S]*?\};\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

function stripCjsGuard(code) {
  // 仅删除 CommonJS 的 module.exports 守卫；
  // 保留 globalThis.X 赋值，它负责在浏览器 IIFE 内把公共对象挂到全局。
  return code.replace(/if \(typeof module !== 'undefined'[\s\S]*?\n\}\n/g, '');
}

function toBrowserScript(code) {
  const body = stripCjsGuard(stripModuleSyntax(code));
  // 每段脚本独立 IIFE，避免顶层 const 在多 <script> 间冲突；
  // 模块内部通过 globalThis.X 显式暴露公共对象。
  return `(function () {\n${body}\n})();`;
}

function base64Of(p) {
  return readFileSync(p).toString('base64');
}

const engine = toBrowserScript(read(join(app, 'engine.js')));
const zip = toBrowserScript(read(join(app, 'zip.js')));
const ui = `(function () {\n${stripModuleSyntax(read(join(app, 'ui.js')))}\n})();`;

const sampleDir = join(root, 'samples', 'extracted');
const demo = `// 内置演示数据（samples/flow-inbetween-cases，base64 内嵌）
globalThis.FlowDemoData = {
  aPPM: ${JSON.stringify(base64Of(join(sampleDir, 'a.ppm')))},
  bPPM: ${JSON.stringify(base64Of(join(sampleDir, 'b.ppm')))},
  aBIN: ${JSON.stringify(base64Of(join(sampleDir, 'a.bin')))},
  bBIN: ${JSON.stringify(base64Of(join(sampleDir, 'b.bin')))},
};`;

let html = read(join(app, 'index.src.html'));
const replacements = {
  '/*__ENGINE__*/': `<script>\n${engine}\n</script>`,
  '/*__ZIP__*/': `<script>\n${zip}\n</script>`,
  '/*__DEMO__*/': `<script>\n${demo}\n</script>`,
  '/*__UI__*/': `<script>\n${ui}\n</script>`,
};
for (const [marker, value] of Object.entries(replacements)) {
  if (!html.includes(marker)) throw new Error(`模板缺少占位符 ${marker}`);
  html = html.replace(marker, value);
}

const out = join(root, 'index.html');
writeFileSync(out, html);
console.log(`已生成单文件 ${out}（${(html.length / 1024).toFixed(1)} KiB）`);
