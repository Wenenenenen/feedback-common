#!/usr/bin/env node
// render.mjs — 命令行把 optical-strips JSON 渲染成 WAV + 缺口 CSV。
// 用法：node cli/render.mjs <input.json> [out.wav] [gaps.csv]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const O = require('../optical-core.js');

const input = process.argv[2];
if (!input) {
  console.error('用法: node cli/render.mjs <input.json> [out.wav] [gaps.csv]');
  process.exit(64);
}
const json = JSON.parse(readFileSync(input, 'utf8'));
const r = O.renderStrips(json);

const stem = basename(input).replace(/\.json$/i, '');
const dir = dirname(input);
const wavPath = process.argv[3] || join(dir, stem + '.render.wav');
const csvPath = process.argv[4] || join(dir, stem + '.gaps.csv');

writeFileSync(wavPath, Buffer.from(O.encodeWavPcm(r.pcm, { frames: r.frameCount })));
writeFileSync(csvPath, O.gapsToCsv(r, 'both'));

console.log(JSON.stringify({
  frameCount: r.frameCount,
  seconds: r.frameCount / O.SAMPLE_RATE,
  pcmSamples: r.pcm.length,
  gaps: r.gapCount,
  renderMs: Math.round(r.stats.renderMs),
  wavPath,
  csvPath,
  warnings: r.warnings,
}, null, 2));
