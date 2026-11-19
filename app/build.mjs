// 构建：把 src/*.js ES 模块打包内联进 index.template.html，产出单文件 build/index.html。
// 不依赖第三方打包器：按 import 拓扑读取、剥掉 import/export 声明、按顺序拼接。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const buildDir = join(root, 'build');
mkdirSync(buildDir, { recursive: true });
mkdirSync(join(buildDir, 'cases'), { recursive: true });

function stripModule(code) {
  return code
    .split('\n')
    .filter(line => !/^\s*import\s/.test(line))
    // 用函数作替换值，避免替换串里的 $ 被当作特殊模式（如 $$、$'）
    .map(line => line.replace(/^export\s+(?=(?:default|class|function|const|let|var|async|\{))/, () => ''))
    .join('\n');
}

const order = ['fraction.js', 'engine.js', 'ui.js'];
const parts = order.map(f => {
  const code = readFileSync(join(srcDir, f), 'utf8');
  return `// ===== ${f} =====\n` + stripModule(code);
});
const bundled = '(function(){\n"use strict";\n' + parts.join('\n\n') + '\n})();\n';

const template = readFileSync(join(root, 'index.template.html'), 'utf8');
const scriptTag = `<script>\n${bundled}\n</script>`;
// 函数作替换值，避免 bundle 中的 $ 序列被 String.replace 特殊解析
const html = template.replace('<!--APP_JS-->', () => scriptTag);
writeFileSync(join(buildDir, 'index.html'), html, 'utf8');

// 复制样例 JSON 供 fetch
const casesSrc = join(root, '..', 'work', 'cases-extract');
for (const f of readdirSync(casesSrc)) {
  if (f.endsWith('.json')) copyFileSync(join(casesSrc, f), join(buildDir, 'cases', f));
}

console.log(`构建完成：build/index.html（${(html.length / 1024).toFixed(1)} KB），样例已复制到 build/cases/`);
