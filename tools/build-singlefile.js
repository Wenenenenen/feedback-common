#!/usr/bin/env node
/*
 * 把 index.html、js/core.js、js/page.js、data/sample.js 打成一个自包含 HTML，
 * 便于直接双击打开或放到任意静态位置（无服务器、无外部依赖）。
 *
 * 用法：node tools/build-singlefile.js
 * 输出：dist/pulldown-restorer.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'js', 'core.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'js', 'page.js'), 'utf8');
const sample = fs.readFileSync(path.join(root, 'data', 'sample.js'), 'utf8');

function inline(tag, code) {
  const re = new RegExp('<script src="' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"></script>');
  if (!re.test(html)) throw new Error('找不到脚本标签：' + tag);
  /* 用 </script> 拆分防止提前闭合 */
  html = html.replace(re, '<script>\n' + code.replace(/<\/script>/gi, '<\\/script>') + '\n</script>');
}

inline('js/core.js', core);
inline('js/page.js', page);
inline('data/sample.js', sample);

/* 内联字体链接保留（Artifact 允许 Google Fonts）；本地打开也工作 */
if (html.includes('src="')) {
  const leftover = html.match(/src="[^"]+"/g);
  if (leftover) throw new Error('仍有外部脚本：' + leftover.join(', '));
}

const out = path.join(dist, 'pulldown-restorer.html');
fs.writeFileSync(out, html);
console.log('写出 ' + path.relative(root, out) + '（' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' KB）');
