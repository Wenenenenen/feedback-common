#!/usr/bin/env node
/* Inline src/styles.css, src/engine.js, src/app.js and the sample dataset into
   a single self-contained HTML file at build/league-cutline.html. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const styles = read('src/styles.css');
const engine = read('src/engine.js');
const app = read('src/app.js');
const page = read('src/page.html');
const sample = JSON.parse(read('samples/league-cutline.json'));
const sampleFlip = JSON.parse(read('samples/leader-flip.json'));

function assertNoClosingScript(src, label) {
  if (/<\/script/i.test(src)) {
    throw new Error(label + ' contains a literal "</script" and cannot be inlined as-is');
  }
}

for (const [src, label] of [[engine, 'src/engine.js'], [app, 'src/app.js']]) {
  assertNoClosingScript(src, label);
}

const encode = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const sampleJson = encode(sample);
const sampleFlipJson = encode(sampleFlip);

const html = page
  .replace('/*__STYLES__*/', () => styles)
  .replace('/*__SAMPLE__*/', () => sampleJson)
  .replace('/*__SAMPLE_FLIP__*/', () => sampleFlipJson)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__APP__*/', () => app);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build/league-cutline.html'), html);
console.log('built build/league-cutline.html  ' + (html.length / 1024).toFixed(1) + ' KB');
