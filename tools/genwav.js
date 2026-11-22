#!/usr/bin/env node
'use strict';
/* 生成测试用 90 秒 48kHz 双声道 24 位 WAV：node tools/genwav.js */
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || '/tmp/big90.wav';
const rate = 48000, ch = 2, bits = 24, frames = rate * 90;
const align = ch * 3;
const dataSize = frames * align;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * align, 28); buf.writeUInt16LE(align, 32); buf.writeUInt16LE(bits, 34);
buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
let o = 44;
let seed = 12345;
function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const maxv = 0x7fffff;
for (let i = 0; i < frames; i++) {
  const t = i / rate;
  const l = Math.sin(2 * Math.PI * 440 * t) * 0.4 + Math.sin(2 * Math.PI * 97 * t) * 0.2 + (rnd() - 0.5) * 0.02;
  const r = Math.sin(2 * Math.PI * 443 * t) * 0.4 + (rnd() - 0.5) * 0.02;
  const li = Math.max(-maxv - 1, Math.min(maxv, Math.round(l * maxv)));
  const ri = Math.max(-maxv - 1, Math.min(maxv, Math.round(r * maxv)));
  buf.writeIntLE(li, o, 3); buf.writeIntLE(ri, o + 3, 3); o += 6;
}
fs.writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
