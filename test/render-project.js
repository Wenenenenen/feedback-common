#!/usr/bin/env node
/* 用 render-core.js 渲染工程目录（project.json + wav），输出双声道 WAV。
 * 用法: node render-project.js <project_dir> <out.wav>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RC = require('../render-core.js');

function renderProject(projDir) {
  const proj = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8'));
  const bank = RC.normalizeBank(proj.bank);
  const sources = proj.sources.map((s) => {
    const wavBuf = fs.readFileSync(path.join(projDir, s.wav));
    const samples = RC.decodeWavPcm16Mono(wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength));
    const track = RC.normalizeTrack(s.track, samples.length);
    return { samples, track };
  });
  const maxN = Math.max(...sources.map((s) => s.samples.length));
  const total = RC.totalLength(maxN, bank.L);
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  for (const s of sources) {
    RC.renderSourceEar(s.samples, s.track.frames, s.track.angs, bank.angles, bank.left, bank.leftDelay, bank.L, left, null);
    RC.renderSourceEar(s.samples, s.track.frames, s.track.angs, bank.angles, bank.right, bank.rightDelay, bank.L, right, null);
  }
  return { left: RC.quantize(left), right: RC.quantize(right), total };
}

if (require.main === module) {
  const [projDir, outPath] = process.argv.slice(2);
  const { left, right, total } = renderProject(projDir);
  const wav = RC.encodeWavStereoPcm16(left, right, RC.SAMPLE_RATE);
  fs.writeFileSync(outPath, Buffer.from(wav));
  console.log('total frames:', total);
}

module.exports = { renderProject };
