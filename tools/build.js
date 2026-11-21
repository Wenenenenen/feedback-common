#!/usr/bin/env node
/*
 * 把 index.html 与 js/*.js 打包成单文件 dist/index.html，
 * 便于离线打开，而不改变源文件结构。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<script src="js\/([^"]+)"><\/script>/g, (m, name) => {
  const code = fs.readFileSync(path.join(root, 'js', name), 'utf8');
  return '<script>\n' + code + '\n</script>';
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log('wrote dist/index.html', (html.length / 1024).toFixed(1) + ' KB');
