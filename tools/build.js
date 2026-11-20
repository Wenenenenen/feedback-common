#!/usr/bin/env node
/*
 * Build the page.
 *
 *   dist/artifact.html                 body fragment for hosts that supply their
 *                                      own document skeleton (the Artifact tool)
 *   dist/boxed-hermite-extractor.html  a complete standalone document
 *   dist/data/samples/*.json           companion cases for the large samples
 *
 * Both HTML files inline the application code.  The four large sample cases
 * stay as companion JSON fetched by relative URL, so the HTML stays readable.
 * Serve dist/ with any static server (tools/serve.js) to view it locally.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'data', 'samples'), { recursive: true });

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

const head = read('src/head.html');
let body = read('src/index.template.html')
  .replace(/<!--__APP_SCRIPTS__-->\s*$/, '')
  .replace(/<script src="src\/(core|samples-inline|viewer|app)\.js"><\/script>\s*/g, '')
  .trimEnd();

const styles = read('src/styles.css');
const core = read('src/core.js');
const inlineSamples = read('src/samples-inline.js');
const viewer = read('src/viewer.js');
const app = read('src/app.js');

// ---- sample index ---------------------------------------------------------
const index = JSON.parse(read('data/samples/index.json'));
const caseNames = index.cases.map((c) => ({
  id: c.id, name: c.name, nameEn: c.nameEn, file: c.file, inline: !!c.inline,
}));
const caseScript = 'window.BHE_CASES = ' + JSON.stringify(caseNames) + ';\n';

for (const c of index.cases) {
  if (!c.inline) {
    fs.copyFileSync(path.join(root, 'data', 'samples', c.id + '.json'),
      path.join(outDir, c.file));
  }
}

// Embed the large cases as data URIs as well, so the page still opens with
// real data when it is loaded straight from disk (file://) or when the
// companion directory is missing.  The relative fetch is still tried first.
const embedded = {};
for (const c of index.cases) {
  if (c.inline) continue;
  const text = read(path.join('data', 'samples', c.id + '.json'));
  embedded[c.id] = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
}
const embeddedScript = 'window.BHE_CASE_DATA = ' + JSON.stringify(embedded) + ';\n';

let styleBlock = styles;
// In the body-fragment build the host supplies the skeleton's reset; nothing
// to change in our own CSS.
const pageStyles = '<style>\n' + styleBlock + '\n</style>\n';

const scripts =
  '<script>\n' + core + '\n</script>\n' +
  '<script>\n' + inlineSamples + '\n' + caseScript + embeddedScript + '</script>\n' +
  '<script>\n' + viewer + '\n</script>\n' +
  '<script>\n' + app + '\n</script>\n';

const artifact = head + '\n' + pageStyles + '\n' + body + '\n\n' + scripts;

const full =
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  head + '\n' + pageStyles +
  '</head>\n<body>\n' + body + '\n\n' + scripts +
  '</body>\n</html>\n';

fs.writeFileSync(path.join(outDir, 'artifact.html'), artifact);
fs.writeFileSync(path.join(outDir, 'boxed-hermite-extractor.html'), full);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KiB';
console.log('artifact.html                 ', kb(artifact));
console.log('boxed-hermite-extractor.html  ', kb(full));
console.log('companion cases               ', index.cases.filter((c) => !c.inline).map((c) => c.id).join(', '));
