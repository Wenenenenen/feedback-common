#!/usr/bin/env node
'use strict';
/*
 * Builds the single-file page: inlines the stylesheet, engine and app into
 * src/page.template.html and writes ./index.html. The result has no external
 * dependencies besides the Google Fonts stylesheet, so file:// works offline.
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('src/page.template.html');
const css = read('src/styles.css');
const engine = read('src/engine.js');
const app = read('src/app.js');

// Inline engine: strip the UMD wrapper so it always attaches to window.
const engineInline = engine
  .replace("(function (root, factory) {\n  if (typeof module === 'object' && module.exports) module.exports = factory();\n  else root.ECSEngine = factory();\n})(typeof globalThis !== 'undefined' ? globalThis : this, function () {",
           "(function (root, factory) { root.ECSEngine = factory(); })(typeof globalThis !== 'undefined' ? globalThis : this, function () {");

if (engineInline === engine) throw new Error('engine UMD wrapper changed; update build.js');

html = html.replace('/*__STYLES__*/', () => css);
html = html.replace('/*__ENGINE__*/', () => engineInline);
html = html.replace('/*__APP__*/', () => app);

fs.writeFileSync(path.join(root, 'index.html'), html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('wrote index.html (' + kb + ' KiB)');
