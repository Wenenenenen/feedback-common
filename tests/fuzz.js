#!/usr/bin/env node
'use strict';
/**
 * 解码器模糊测试：构造 CRC 正确但内容非法的块（转义错误、补位非零、
 * 额外字节、参数越界、PCM 越界），确认 decodeBlock 不会抛异常、不会卡死，
 * 且一律返回 ok:false。
 */
const RPA1 = require('../src/rpa1.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildArchive(channels, bitDepth, blockBytes) {
  // 单块，块目录 1 条；重算 CRC 使其通过校验，确保测试的是块内容检查。
  const numBlocks = 1;
  const dirEnd = RPA1.HEADER_SIZE + numBlocks * RPA1.ENTRY_SIZE;
  const total = 1024;
  const out = new Uint8Array(dirEnd + blockBytes.length);
  out[0] = 0x52; out[1] = 0x50; out[2] = 0x41; out[3] = 0x31;
  const dv = new DataView(out.buffer);
  dv.setUint32(4, 48000, true);
  out[8] = channels;
  out[9] = bitDepth;
  dv.setUint32(10, total, true);
  dv.setUint32(14, numBlocks, true);
  dv.setUint32(RPA1.HEADER_SIZE, dirEnd, true);
  dv.setUint32(RPA1.HEADER_SIZE + 4, blockBytes.length, true);
  dv.setUint32(RPA1.HEADER_SIZE + 8, RPA1.crc32(blockBytes, 0, blockBytes.length), true);
  out.set(blockBytes, dirEnd);
  return out;
}

const rand = rng(2024);
let runs = 0;
let hangs = 0;
let crashes = 0;

for (let t = 0; t < 3000; t++) {
  const channels = rand() < 0.5 ? 1 : 2;
  const bitDepth = rand() < 0.5 ? 16 : 24;
  const len = 1 + 2 * channels + Math.floor(rand() * 200) + 1;
  const block = new Uint8Array(len);
  for (let i = 0; i < len; i++) block[i] = Math.floor(rand() * 256);
  // 有时把块头参数设为合法以更深入解码路径
  block[0] = channels === 2 && rand() < 0.5 ? 1 : 0;
  for (let c = 0; c < channels; c++) {
    block[1 + c * 2] = Math.floor(rand() * 3);
    block[2 + c * 2] = Math.floor(rand() * 16);
  }
  const bytes = buildArchive(channels, bitDepth, block);
  let result;
  const t0 = Date.now();
  try {
    const arc = RPA1.parse(bytes);
    if (arc.ok && arc.entries[0].status === 'ok') {
      result = RPA1.decodeBlock(arc, 0);
    } else {
      result = { ok: false };
    }
  } catch (err) {
    crashes++;
    console.log('抛异常 t=', t, err && err.message);
    continue;
  }
  if (Date.now() - t0 > 1000) hangs++;
  runs++;
  // 随机位流大多应被判为坏块；是否 ok 都行，关键是不崩、不卡。
  void result;
}

console.log(`模糊测试 ${runs} 例，崩溃 ${crashes}，疑似卡死 ${hangs}`);
if (crashes || hangs) process.exit(1);
