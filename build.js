#!/usr/bin/env node
'use strict';

/*
 * 把 src/ 下的样式与脚本内联进单页 index.html。
 * 单文件可以直接双击打开（file://），也便于发布为单页应用。
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = path.join(root, 'src');

function read(name) {
  return fs.readFileSync(path.join(src, name), 'utf8');
}

function inline(name, label) {
  const code = read(name);
  if (/<\/script/i.test(code)) {
    throw new Error(`${name} 含有 </script，内联会截断脚本`);
  }
  return `<!-- ${label} -->\n${code}`;
}

let html = read('index.template.html');

const styles = read('styles.css');
if (/<\/style/i.test(styles)) throw new Error('styles.css 含有 </style');
html = html.replace('/*__STYLES__*/', () => styles);

const slots = [
  ['/*__ENGINE__*/', './engine.js', 'engine.js · 图割引擎与 Worker 源码'],
  ['/*__PNG__*/', './png.js', 'png.js · PNG 解码 / 编码'],
  ['/*__CONFIG__*/', './config.js', 'config.js · 种子配置校验'],
  ['/*__SAMPLES__*/', './samples.js', 'samples.js · 内置示例'],
  ['/*__APP__*/', './app.js', 'app.js · 界面与交互']
];

for (const [marker, file, label] of slots) {
  const code = inline(file, label);
  if (!html.includes(marker)) throw new Error(`模板缺少占位符 ${marker}`);
  html = html.replace(marker, () => code);
}

const out = path.join(root, 'index.html');

// 模板已带完整文档结构；这里只在内联结果上补 doctype 与 lang。
const page = '<!doctype html>\n<html lang="zh-CN">\n' + html;

fs.writeFileSync(out, page);
const bytes = Buffer.byteLength(page);
console.log(`写入 ${path.relative(root, out)} · ${(bytes / 1024).toFixed(1)} KB`);

// 另存一份不带 <html>/<head>/<body> 外壳的片段，供以页面片段形式发布时使用
// （宿主会自动补上文档骨架）。
const fragment = html
  .replace(/^\s*<\/head>\s*<body>\s*/m, '\n')
  .replace(/\s*<\/body>\s*<\/html>\s*$/m, '\n');
if (!fragment.includes('<title>') || fragment.includes('<!doctype')) {
  throw new Error('片段生成失败：检查模板结构');
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const fragPath = path.join(root, 'dist', 'artifact.html');
fs.writeFileSync(fragPath, fragment);
console.log(`写入 ${path.relative(root, fragPath)} · ${(Buffer.byteLength(fragment) / 1024).toFixed(1)} KB`);
