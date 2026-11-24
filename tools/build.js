#!/usr/bin/env node
// 把 engine.js 内联进 index.src.html，产出自包含的 index.html。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.src.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
if (!src.includes('<!--__ENGINE__-->')) throw new Error('未找到引擎占位符');
const out = src.replace('<!--__ENGINE__-->', '<script>\n' + engine + '\n</script>');
fs.writeFileSync(path.join(root, 'index.html'), out);
console.log(`index.html 生成完成：${(out.length / 1024).toFixed(1)} KB`);
