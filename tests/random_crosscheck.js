#!/usr/bin/env node
'use strict';
/**
 * 随机交叉校验：生成多组随机 WAV（覆盖 8–48kHz、16/24 位、单/双声道、
 * 各长度与信号形态），分别交 JS 与 Python 参考实现编码，逐字节比较；
 * 再用 JS 解码并逐样本核对。用法：node tests/random_crosscheck.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const RPA1 = require('../src/rpa1.js');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-xcheck-'));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeWav(rate, ch, bits, frames, seed, mode) {
  const align = ch * (bits / 8);
  const dataSize = frames * align;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * align, 28);
  buf.writeUInt16LE(align, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  const rand = rng(seed);
  const max = bits === 16 ? 32767 : 8388607;
  const min = -max - 1;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let v;
      if (mode === 'noise') v = Math.round((rand() * 2 - 1) * max);
      else if (mode === 'silence') v = 0;
      else if (mode === 'extreme') v = i % 2 ? max : min;
      else {
        v = Math.round(Math.sin(i / (13 + c * 7)) * max * (0.1 + 0.8 * rand()) + (rand() - 0.5) * max * 0.01);
      }
      v = Math.max(min, Math.min(max, v));
      if (bits === 16) buf.writeInt16LE(v, o);
      else buf.writeIntLE(v, o, 3);
      o += bits / 8;
    }
  }
  return buf;
}

const configs = [
  [8000, 1, 16, 1], [8000, 1, 16, 1023], [8000, 1, 16, 1025],
  [11025, 1, 24, 3000], [16000, 2, 16, 2048], [22050, 1, 16, 777],
  [32000, 2, 24, 1500], [44100, 2, 16, 4097], [44100, 1, 24, 2600],
  [48000, 2, 24, 5000], [48000, 1, 16, 1024], [48000, 2, 16, 3]
];
const modes = ['sine', 'noise', 'silence', 'extreme'];
let cases = 0, bad = 0;

for (const [rate, ch, bits, frames] of configs) {
  for (const mode of modes) {
    const seed = (rate + ch * 7 + bits * 13 + frames + mode.length) >>> 0;
    const wavPath = path.join(tmp, `c_${rate}_${ch}_${bits}_${frames}_${mode}.wav`);
    fs.writeFileSync(wavPath, makeWav(rate, ch, bits, frames, seed, mode));
    const refPath = wavPath + '.ref.rpa';
    execFileSync('python3', ['-I', path.join(root, 'tools/reference.py'), wavPath, refPath]);

    const wav = RPA1.parseWav(new Uint8Array(fs.readFileSync(wavPath)));
    if (!wav.ok) { console.log('WAV 解析失败', wavPath, wav.error); bad++; continue; }
    const enc = RPA1.encode({
      sampleRate: wav.sampleRate, channels: wav.channels, bitDepth: wav.bitDepth, channelsData: wav.channelsData
    });
    if (!enc.ok) { console.log('编码失败', wavPath, enc.error); bad++; continue; }
    const ref = fs.readFileSync(refPath);
    if (Buffer.compare(Buffer.from(enc.bytes), ref) !== 0) {
      console.log('字节不一致:', path.basename(wavPath), enc.bytes.length, ref.length);
      bad++;
    }
    // 解码核对
    const arc = RPA1.parse(enc.bytes);
    const dec = RPA1.decodeRange(arc, 0, wav.totalFrames);
    if (!dec.ok) { console.log('解码失败', wavPath, dec.error); bad++; continue; }
    let mism = 0;
    for (let c = 0; c < wav.channels; c++)
      for (let i = 0; i < wav.totalFrames; i++)
        if (dec.channels[c][i] !== wav.channelsData[c][i]) mism++;
    if (mism) { console.log('样本不一致', path.basename(wavPath), mism); bad++; }
    cases++;
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`交叉校验 ${cases} 组，失败 ${bad}`);
if (bad) process.exit(1);
