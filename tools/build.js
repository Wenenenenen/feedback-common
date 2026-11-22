#!/usr/bin/env node
'use strict';
/* 构建单文件 index.html：内联 CSS、RPA1 核心、示例与界面逻辑。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

let html = read('src/index.template.html');
html = html.replace('/*__CSS__*/', () => read('styles.css'));
html = html.replace('/*__RPA1__*/', () => read('src/rpa1.js'));
html = html.replace('/*__SAMPLES__*/', () => read('samples.js'));
html = html.replace('/*__APP__*/', () => read('src/app.js'));

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('index.html', fs.statSync(path.join(root, 'index.html')).size, 'bytes');
