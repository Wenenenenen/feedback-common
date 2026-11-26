#!/usr/bin/env node
/* 生成随机工程用于对拍/性能测试。
 * 用法: node gen-random.js <out_dir> <numSources> <secondsPerSource> <numDirs> <taps> <trackPoints> [seed]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RC = require('../render-core.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const [outDir, nSrcS, secS, nDirS, tapsS, nTrackS, seedS] = process.argv.slice(2);
const nSrc = +nSrcS, sec = +secS, nDir = +nDirS, L = +tapsS, nTrack = +nTrackS;
const rand = mulberry32(+(seedS || 12345));
const N = sec * 48000;

fs.mkdirSync(outDir, { recursive: true });

// 方位库：随机互异升序角度
const angleSet = new Set();
while (angleSet.size < nDir) angleSet.add(Math.floor(rand() * 36000));
const angles = [...angleSet].sort((a, b) => a - b);
const mkTaps = () => angles.map(() => Array.from({ length: L }, () => Math.floor(rand() * 65536) - 32768));
const mkDelays = () => angles.map(() => Math.floor(rand() * 65537));
const bank = {
  angles,
  left: mkTaps(), right: mkTaps(),
  left_delay: mkDelays(), right_delay: mkDelays(),
};

const sources = [];
for (let s = 0; s < nSrc; s++) {
  const name = `src${s}.wav`;
  // 随机 PCM：正弦扫频 + 噪声 + 静音段
  const pcm = new Int16Array(N);
  const f0 = 200 + rand() * 2000;
  for (let i = 0; i < N; i++) {
    if (i % 7 === 0) continue; // 撒一些零
    const t = i / 48000;
    pcm[i] = Math.round(12000 * Math.sin(2 * Math.PI * (f0 + 500 * t) * t) + (rand() - 0.5) * 8000);
  }
  // 写单声道 WAV
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(96000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  fs.writeFileSync(path.join(outDir, name), buf);

  // 轨迹：随机帧号（含 0 与末帧），随机角度（多圈、负值）
  const frameSet = new Set([0, N - 1]);
  while (frameSet.size < Math.min(nTrack, N)) frameSet.add(Math.floor(rand() * N));
  const frames = [...frameSet].sort((a, b) => a - b);
  const track = frames.map((f) => [f, Math.floor((rand() - 0.5) * 8 * 36000)]);
  sources.push({ wav: name, track });
}

fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify({ bank, sources }));
console.log(`工程已生成: ${outDir}  源=${nSrc} 每源${sec}s 方向=${nDir} 抽头=${L} 轨迹点/源≈${nTrack}`);
