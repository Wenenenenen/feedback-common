/*
 * build-web.js — 把 src/*.js 与 web/app.js 内联进 index.template.html，
 * 产出自包含的 dist/index.html（无外部脚本依赖，可直接用浏览器打开）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = ['geometry.js', 'model.js', 'dijkstra.js', 'funnel.js', 'route.js']
  .map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8'));
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
let template = fs.readFileSync(path.join(root, 'web', 'index.template.html'), 'utf8');

const bundle = modules.join('\n\n') + '\n\n' + app;
const out = template.replace(
  '/* ================= 算法模块将在发布前由构建脚本内联到此处 ================= */',
  bundle
);

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'index.html');
fs.writeFileSync(outPath, out);
console.log(`已生成 ${outPath}（${(out.length / 1024).toFixed(1)} KB）`);
