#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../src/qg01-core.js');

const samplePath = path.join(__dirname, '..', 'samples', 'quadtree-archive', 'gray.pgm');
const maskPath = path.join(__dirname, '..', 'samples', 'quadtree-archive', 'valid.pgm');
const gray = Q.parsePGM(fs.readFileSync(samplePath));
const mask = Q.parsePGM(fs.readFileSync(maskPath));
const plan = Q.encodeOptimal({ data: gray.data, width: 16, mask: mask.data, budget: 400 });
const valid = Q.encodeQG01(plan);
const smallPlan = Q.encodeOptimal({ data: gray.data, width: 16, mask: mask.data, budget: 10 });
const valid10 = Q.encodeQG01(smallPlan);
assert.equal(valid10.length, 12);
const decoded = Q.decodeQG01(valid);
assert.equal(decoded.width, 16);
assert.ok(Buffer.from(decoded.pixels).equals(Buffer.from(plan.reconstructed)));

function header(side, bits, payloadBytes) {
  const buf = Buffer.alloc(10 + payloadBytes.length);
  buf.write('QG01', 0, 'ascii');
  buf.writeUInt16LE(side, 4);
  buf.writeUInt32LE(bits >>> 0, 6);
  payloadBytes.forEach((b, i) => { buf[10 + i] = b; });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function expectCode(fn, code, position) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    if (position !== undefined) {
      const actual = error.bitStart ?? error.bitPosition ?? error.byteOffset;
      assert.equal(actual, position);
    }
    assert.match(error.toReport(), /位置/);
  }
}

// 文件截断。
expectCode(() => Q.decodeQG01(valid.slice(0, valid.length - 1)), 'truncated-file');

// 位读取中途截断：声明 8 位，但常值叶还要 8 位灰度。
const truncatedBits = header(16, 8, Uint8Array.from([0x00]));
expectCode(() => Q.decodeQG01(truncatedBits), 'truncated', 2);

// 1×1 非法四分的最小位流：单个分支位 1 + 7 个零填充。
const tinyIllegal = header(1, 1, Uint8Array.from([0b10000000]));
expectCode(() => Q.decodeQG01(tinyIllegal), 'illegal-split', 0);

// 1×1 非法四分，路径为 root/TL/TL/TL/TL，第五位是 1。
const illegalSplit = header(16, 5, Uint8Array.from([0b11111000]));
expectCode(() => Q.decodeQG01(illegalSplit), 'illegal-split', 4);

// 末字节未用低位非零。
const badPad = Uint8Array.from(valid10);
badPad[11] |= 0x01;
expectCode(() => Q.decodeQG01(badPad), 'nonzero-padding', 10);

// 声明 16 位，树后剩余位中出现非零填充。
const trailingOne = (() => {
  const bytes = Uint8Array.from(valid10);
  new DataView(bytes.buffer).setUint32(6, 16, true);
  bytes[11] |= 0x01; // 载荷位 15
  return bytes;
})();
expectCode(() => Q.decodeQG01(trailingOne), 'nonzero-padding', 15);

// 树提前结束且剩余为零也必须拒绝，因为树未正好用尽声明位数。
const trailingZero = (() => {
  const bytes = Uint8Array.from(valid10);
  new DataView(bytes.buffer).setUint32(6, 16, true);
  return bytes;
})();
expectCode(() => Q.decodeQG01(trailingZero), 'trailing-bits', 10);

// 额外字节。
const extra = Uint8Array.from([...valid, 0]);
expectCode(() => Q.decodeQG01(extra), 'extra-bytes', valid.length);

// 边长不是二次幂（解码器允许 1–512 的小二次幂，但不接受 3）。
const badSide = header(3, 10, Uint8Array.from([0, 0]));
expectCode(() => Q.decodeQG01(badSide), 'bad-dimensions', 4);

console.log('codec-errors: roundtrip and 9 malformed-input position checks passed');
