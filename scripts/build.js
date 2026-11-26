#!/usr/bin/env node
/* 单文件构建：把 engine.js / io.js / app.js 内联进 index.html，产出 dist/tracker.html */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

const inline = (file) => {
  const code = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  return `<script>\n${code}\n</script>`;
};

// 用函数返回替换值：内联代码里的 $ 不会被当作替换模式解析
html = html.replace(/<script src="engine\.js"><\/script>/, () => inline('engine.js'));
html = html.replace(/<script src="io\.js"><\/script>/, () => inline('io.js'));
html = html.replace(/<script src="app\.js"><\/script>/, () => inline('app.js'));

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist/tracker.html');
fs.writeFileSync(out, html);
const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`构建完成 ${out} (${kb} KB)`);
