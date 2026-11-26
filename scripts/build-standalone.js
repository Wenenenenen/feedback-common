#!/usr/bin/env node
/* Inline CSS/JS into a standalone local page and an Artifact fragment. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const strip = read('strip-forge.js');
const app = read('app.js');

const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<script\s+src="strip-forge\.js"><\/script>/);
if (!bodyMatch) throw new Error('Could not locate body markup before strip-forge.js');
let markup = bodyMatch[1];
// Remove the external app tag if it remains in the captured region boundary.
markup = markup.replace(/<script\s+src="app\.js"><\/script>\s*$/i, '').trim();

const inlineScripts = `<script>\n${strip}\n</script>\n<script>\n${app}\n</script>`;

const standalone = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Ordered Strip Forge</title>
    <style>
${css}
    </style>
  </head>
  <body>
${markup}
${inlineScripts}
  </body>
</html>
`;

const fragment = `<title>Ordered Strip Forge</title>
<meta name="claude:viewport-fit-sides" content="cover" />
<style>
${css}
</style>
${markup}
${inlineScripts}
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'ordered-strip-forge.html'), standalone);
fs.writeFileSync(path.join(root, 'dist', 'artifact-fragment.html'), fragment);
console.log('Built dist/ordered-strip-forge.html and dist/artifact-fragment.html');
