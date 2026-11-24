// 由 samples/echo-depth.json 生成内嵌样例，供 file:// 直接打开时使用。
// 用法：node tools/gen-sample-data.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'samples', 'echo-depth.json');
const dst = path.join(root, 'src', 'sample-data.js');

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const banner = '/* 由 tools/gen-sample-data.js 从 samples/echo-depth.json 生成，请勿手改。 */\n';
const body = JSON.stringify(raw);
const out = banner +
  '(function (root) {\n' +
  '  var sample = ' + body + ';\n' +
  '  if (typeof module === "object" && module.exports) module.exports = sample;\n' +
  '  if (typeof self !== "undefined") self.EchoSample = sample;\n' +
  '})(typeof self !== "undefined" ? self : globalThis);\n';

fs.writeFileSync(dst, out, 'utf8');
console.log('wrote', path.relative(root, dst), (out.length / 1024).toFixed(1) + ' KB');
