// tests/wav.test.js — WAV 严格解析与格式拒绝
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWav, WavFormatError, SAMPLE_RATE } from '../js/wav.js';
import { assert, assertEq } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

// Node Buffer 可能来自共享内存池，转成独立 ArrayBuffer
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function riffChunk(id, body) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'ascii');
  h.writeUInt32LE(body.length, 4);
  const pad = body.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([h, body, pad]);
}

function makeWav({ channels = 2, sampleRate = 48000, bits = 16, audioFormat = 1, frames = 100, extraChunks = [] }) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(audioFormat, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  const blockAlign = channels * (bits / 8);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bits, 14);
  const data = Buffer.alloc(frames * blockAlign);
  for (let i = 0; i < frames * channels; i++) data.writeInt16LE((i * 37) % 32768 - 16000, i * 2);
  const parts = [riffChunk('fmt ', fmt), ...extraChunks, riffChunk('data', data)];
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), ...parts]);
  riff.writeUInt32LE(riff.length - 8, 4);
  return riff;
}

// 1. 真实样例
{
  const buf = await readFile(join(here, '..', 'samples', 'wave-edit-source.wav'));
  const w = parseWav(ab(buf), 'wave-edit-source.wav');
  assertEq(w.sampleRate, SAMPLE_RATE, '样例采样率 48000');
  assertEq(w.channels, 2, '样例双声道');
  assertEq(w.bitsPerSample, 16, '样例 16 位');
  assertEq(w.frameCount, 48000, '样例 48000 帧（1 秒）');
  assertEq(w.frames.length, 2, '返回两个声道数组');
  assertEq(w.frames[0].length, 48000, '左声道长度');
  // 与原始字节交叉存储核对前 4 帧（data 块头在文件偏移 36，数据起始 44）
  const dv = new DataView(buf.buffer, buf.byteOffset);
  for (let f = 0; f < 4; f++) {
    assertEq(w.frames[0][f], dv.getInt16(44 + f * 4, true), `样例左声道帧 ${f}`);
    assertEq(w.frames[1][f], dv.getInt16(44 + f * 4 + 2, true), `样例右声道帧 ${f}`);
  }
}

// 2. 合法合成 WAV（带 LIST 块与奇数填充）
{
  const list = riffChunk('LIST', Buffer.from('TEST')); // 4 字节，偶长度
  const w = parseWav(ab(makeWav({ frames: 257, extraChunks: [list] })), 'x.wav');
  assertEq(w.frameCount, 257, '带 LIST 块仍正确解析');
}

// 3. 各种非法格式必须被拒绝
const reject = (opts, label) => {
  let threw = false;
  try { parseWav(ab(makeWav(opts)), 'bad.wav'); } catch (e) {
    threw = e instanceof WavFormatError;
  }
  assert(threw, `拒绝：${label}`);
};
reject({ channels: 1 }, '单声道');
reject({ sampleRate: 44100 }, '44.1kHz');
reject({ bits: 24 }, '24 位');
reject({ audioFormat: 3 }, 'IEEE float');
reject({ frames: 10 * 60 * 48000 + 1 }, '超过 10 分钟');

// 4. 结构性错误
for (const [label, buf] of [
  ['非 RIFF', Buffer.from('XXXXxxxxWAVE')],
  ['截断文件', Buffer.alloc(20)],
  ['无 WAVE 标识', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('XXXX')])],
]) {
  let threw = false;
  try { parseWav(ab(buf), 'bad.wav'); } catch (e) { threw = e instanceof WavFormatError; }
  assert(threw, `拒绝：${label}`);
}

console.log('wav tests done');
