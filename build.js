/* Build script: assembles dist/index.html (standalone) and dist/artifact.html
   (fragment for publishing, no doctype/html/head/body of its own).

   Run: node build.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const template = read('app/template.html');
const styleEnd = template.indexOf('</style>') + '</style>'.length;
if (styleEnd < 8) throw new Error('template.html is missing its </style> block');
const head = template.slice(0, styleEnd);
const bodyMarkup = template.slice(styleEnd);

const scripts = [
  'src/core.js',
  'src/tri.js',
  'src/query.js',
  'src/export.js',
  'app/cases.js',
  'app/app.js',
].map((f) => '<!-- ' + f + ' -->\n<script>\n' + read(f) + '\n</script>').join('\n');

const samples = JSON.stringify(JSON.parse(read('samples/tetra-probe-cases.json')));
const sampleTag = '<script type="application/json" id="sample-data">' + samples + '</script>';

const fragment =
  head + '\n' + bodyMarkup.trimEnd() + '\n\n' + sampleTag + '\n' + scripts + '\n';

const standalone =
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  head + '\n</head>\n<body>\n' + bodyMarkup.trim() + '\n\n' + sampleTag + '\n' + scripts +
  '\n</body>\n</html>\n';

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), standalone);
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), fragment);

const kb = (p) => (fs.statSync(path.join(root, p)).size / 1024).toFixed(1) + ' KB';
console.log('dist/index.html    ' + kb('dist/index.html'));
console.log('dist/artifact.html ' + kb('dist/artifact.html'));
