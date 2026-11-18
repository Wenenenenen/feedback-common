/*
 * build.mjs — 把 hdr-engine.js 内联进 index.html，生成独立单文件 dist/hdr-standalone.html
 * 用法：node build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const engine = fs.readFileSync(path.join(here, 'hdr-engine.js'), 'utf8');

if (!html.includes('<script src="hdr-engine.js"></script>')) {
  throw new Error('index.html 中未找到引擎引用，无法内联');
}
const standalone = html.replace('<script src="hdr-engine.js"></script>',
  '<script>\n/* === hdr-engine.js 内联（构建产物，请勿手改） === */\n' + engine + '\n</script>');

const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, 'hdr-standalone.html');
fs.writeFileSync(out, standalone);
console.log('已生成 ' + path.relative(here, out) + '（' + (standalone.length / 1024).toFixed(1) + ' KB）');
