'use strict';
// 把 src/engine.js、src/app.js、src/ui.js 内联进 index.template.html，产出单文件 index.html
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');

let html = read('index.template.html');
const inlined = {
  '/*__ENGINE__*/': read('engine.js'),
  '/*__APP__*/': read('app.js'),
  '/*__UI__*/': read('ui.js'),
};
for (const [marker, code] of Object.entries(inlined)) {
  if (!html.includes(marker)) throw new Error('模板缺少占位符 ' + marker);
  html = html.replace(marker, () => code);
}
const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
console.log('已生成', out, `(${(html.length / 1024).toFixed(1)} KiB)`);
