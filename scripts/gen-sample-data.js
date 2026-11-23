#!/usr/bin/env node
/*
 * 由 samples/relief-crossing-cases.json 重新生成内嵌样例脚本
 * samples/sample-data.js（file:// 打开页面时的加载兜底）。
 * 运行：node scripts/gen-sample-data.js
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const jsonPath = path.join(root, 'samples', 'relief-crossing-cases.json');
const outPath = path.join(root, 'samples', 'sample-data.js');

const docText = fs.readFileSync(jsonPath, 'utf8');
JSON.parse(docText); // 非法 JSON 直接抛错

const out =
  '/* 自动生成，请勿手改；数据源 relief-crossing-cases.json。\n' +
  '   供 file:// 直接打开页面时内嵌加载（浏览器禁止 file:// fetch）。*/\n' +
  'window.RELIEF_SAMPLE_DOC = ' + docText.trim() + ';\n';

fs.writeFileSync(outPath, out);
console.log('已生成', path.relative(root, outPath), `(${out.length} 字节)`);
