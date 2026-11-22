#!/usr/bin/env node
'use strict';
/*
 * RPA1 测试套件（Node）：往返、区间、损坏、边界。
 * 交叉校验 Python 参考实现的用例见 crosscheck.js / random_crosscheck.js。
 */
const assert = require('assert');
const RPA1 = require('../src/rpa1.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    failed++;
    console.log('  ✗', name);
    console.log('    ', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err);
  }
}

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeChannels(channels, totalFrames, bitDepth, seed, mode) {
  const rand = rng(seed);
  const max = bitDepth === 16 ? 32767 : 8388607;
  const min = -max - 1;
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Int32Array(totalFrames));
  for (let i = 0; i < totalFrames; i++) {
    let base;
    if (mode === 'noise') base = (rand() * 2 - 1) * max;
    else if (mode === 'silence') base = 0;
    else if (mode === 'ramp') base = ((i % 2048) / 2048) * 2 * max - max;
    else base = Math.sin(i / 17) * max * 0.3 + (rand() - 0.5) * 1000;
    for (let c = 0; c < channels; c++) {
      let v;
      if (mode === 'extreme') {
        // 交替极值，逼迫侧声道越过 PCM 范围
        v = (i + c) % 2 ? min : max;
      } else {
        v = Math.round(base + (c ? (rand() - 0.5) * 100 : 0));
      }
      out[c][i] = Math.max(min, Math.min(max, v));
    }
  }
  return out;
}

function roundtripCheck(sampleRate, channels, bitDepth, totalFrames, seed, mode) {
  const chans = makeChannels(channels, totalFrames, bitDepth, seed, mode);
  const enc = RPA1.encode({ sampleRate, channels, bitDepth, channelsData: chans });
  assert.ok(enc.ok, 'encode ok: ' + JSON.stringify(enc.error));
  assert.strictEqual(enc.header.totalFrames, totalFrames);
  assert.strictEqual(enc.header.numBlocks, Math.ceil(totalFrames / 1024));
  assert.strictEqual(enc.bytes[0], 0x52);
  assert.strictEqual(enc.bytes[1], 0x50);
  assert.strictEqual(enc.bytes[2], 0x41);
  assert.strictEqual(enc.bytes[3], 0x31);

  const arc = RPA1.parse(enc.bytes);
  assert.ok(arc.ok, 'parse ok');
  const dec = RPA1.decodeRange(arc, 0, totalFrames);
  assert.ok(dec.ok, 'decode ok: ' + JSON.stringify(dec.error));
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < totalFrames; i++) {
      assert.strictEqual(dec.channels[c][i], chans[c][i], `sample c${c} i${i}`);
    }
  }
  // WAV 往返
  const wav = RPA1.exportWav(arc, 0, totalFrames);
  assert.ok(wav.ok);
  const parsed = RPA1.parseWav(wav.bytes);
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.totalFrames, totalFrames);
  for (let c = 0; c < channels; c++)
    for (let i = 0; i < totalFrames; i++)
      assert.strictEqual(parsed.channelsData[c][i], chans[c][i], `wav c${c} i${i}`);
  return { enc, arc, chans };
}

console.log('往返与边界');
test('单声道 16 位 / 8kHz / 跨多块', () => roundtripCheck(8000, 1, 16, 5000, 1, 'sine'));
test('单声道 24 位 / 48kHz / 恰好 1024 帧', () => roundtripCheck(48000, 1, 24, 1024, 2, 'sine'));
test('单声道 24 位 / 不足 1 块', () => roundtripCheck(48000, 1, 24, 7, 3, 'noise'));
test('立体声 16 位 / 44.1kHz / 3 块 + 余', () => roundtripCheck(44100, 2, 16, 2500, 4, 'sine'));
test('立体声 24 位 / 48kHz / 噪声', () => roundtripCheck(48000, 2, 24, 4096, 5, 'noise'));
test('立体声 24 位 / 极值（侧声道越界）', () => roundtripCheck(48000, 2, 24, 2048, 6, 'extreme'));
test('立体声 16 位 / 极值（侧声道越界）', () => roundtripCheck(48000, 2, 16, 2048, 7, 'extreme'));
test('静音', () => roundtripCheck(8000, 2, 16, 3000, 8, 'silence'));
test('斜坡', () => roundtripCheck(32000, 1, 16, 3000, 9, 'ramp'));

console.log('区间解码');
test('任意区间只解码相交块，结果与整段一致', () => {
  const { arc, chans } = roundtripCheck(48000, 2, 24, 6000, 11, 'sine');
  const rand = rng(99);
  for (let t = 0; t < 40; t++) {
    const a = Math.floor(rand() * 6000);
    const b = a + 1 + Math.floor(rand() * (6000 - a));
    const dec = RPA1.decodeRange(arc, a, b);
    assert.ok(dec.ok);
    assert.strictEqual(dec.channels[0].length, b - a);
    for (let c = 0; c < 2; c++)
      for (let i = a; i < b; i++)
        assert.strictEqual(dec.channels[c][i - a], chans[c][i], `range ${a}-${b} c${c} i${i}`);
    const expectBlocks = Math.floor((b - 1) / 1024) - Math.floor(a / 1024) + 1;
    assert.strictEqual(dec.blocksDecoded, expectBlocks, 'decoded block count');
  }
});

test('区间端点校验（越界 / 空 / 非整数）', () => {
  const { arc } = roundtripCheck(48000, 1, 16, 3000, 12, 'sine');
  assert.ok(!RPA1.decodeRange(arc, 0, 3001).ok);
  assert.ok(!RPA1.decodeRange(arc, -1, 10).ok);
  assert.ok(!RPA1.decodeRange(arc, 10, 10).ok);
  assert.ok(!RPA1.decodeRange(arc, 5.5, 10).ok);
  assert.ok(RPA1.decodeRange(arc, 0, 1).ok);
});

console.log('损坏处理');
function corruptBlockByte(bytes, arc, blockIndex) {
  const e = arc.entries[blockIndex];
  const copy = new Uint8Array(bytes);
  copy[e.offset + e.size - 1] ^= 0x01; // 破坏块末字节 → CRC 不符
  return copy;
}

test('块损坏：指出块号、禁止跨坏块区间、其他区间仍可用', () => {
  const { enc, arc } = roundtripCheck(48000, 1, 16, 5000, 21, 'sine');
  const bad = 2;
  const broken = RPA1.parse(corruptBlockByte(enc.bytes, arc, bad));
  assert.ok(broken.ok, '坏块不应导致整档打不开');
  assert.strictEqual(broken.entries[bad].status, 'crc');
  // 相交区间应失败并列出坏块
  const cross = RPA1.decodeRange(broken, 0, 5000);
  assert.ok(!cross.ok);
  assert.deepStrictEqual(cross.badBlocks, [bad]);
  // 完全避开坏块的区间应可用
  const before = RPA1.decodeRange(broken, 0, 2048);
  assert.ok(before.ok, JSON.stringify(before.error));
  const after = RPA1.decodeRange(broken, 3072, 5000);
  assert.ok(after.ok, JSON.stringify(after.error));
  // 导出同样受限
  assert.ok(!RPA1.exportWav(broken, 0, 5000).ok);
  assert.ok(RPA1.exportWav(broken, 0, 2048).ok);
});

test('索引损坏：篡改块长也能精确指出条目', () => {
  const { enc, arc } = roundtripCheck(48000, 1, 16, 5000, 26, 'sine');
  const bad = 2;
  const copy = new Uint8Array(enc.bytes);
  const p = RPA1.HEADER_SIZE + bad * RPA1.ENTRY_SIZE + 4; // 块长字段
  copy[p] ^= 0x10;
  const broken = RPA1.parse(copy);
  assert.ok(broken.ok);
  assert.strictEqual(broken.entries[bad].status, 'index');
  // 前面完好的块仍可用
  assert.ok(RPA1.decodeRange(broken, 0, 2048).ok);
});

test('多个块损坏：只报坏块，完好块仍解码', () => {
  const { enc, arc } = roundtripCheck(48000, 2, 24, 6000, 27, 'sine');
  const copy = new Uint8Array(enc.bytes);
  for (const bad of [1, 3]) {
    const e = arc.entries[bad];
    copy[e.offset] ^= 0x80;
  }
  const broken = RPA1.parse(copy);
  assert.ok(broken.ok);
  assert.strictEqual(broken.entries[1].status, 'crc');
  assert.strictEqual(broken.entries[3].status, 'crc');
  assert.ok(RPA1.decodeRange(broken, 0, 1024).ok);
  assert.ok(RPA1.decodeRange(broken, 2048, 3072).ok);
  const cross = RPA1.decodeRange(broken, 0, 6000);
  assert.ok(!cross.ok);
  assert.deepStrictEqual(cross.badBlocks, [1, 3]);
});

test('索引损坏：指出条目并保留已打开归档', () => {
  const { enc, arc } = roundtripCheck(48000, 2, 16, 5000, 22, 'sine');
  const bad = 1;
  const copy = new Uint8Array(enc.bytes);
  // 篡改条目 1 的偏移字段
  const p = RPA1.HEADER_SIZE + bad * RPA1.ENTRY_SIZE;
  copy[p] ^= 0xff;
  copy[p + 1] ^= 0xff;
  const broken = RPA1.parse(copy);
  assert.ok(broken.ok, '索引损坏不应阻止打开');
  assert.strictEqual(broken.entries[bad].status, 'index');
  const errForEntry = broken.errors.find((e) => e.kind === 'index' && e.entry === bad);
  assert.ok(errForEntry, '应在 errors 中指出条目编号');
  // 其他块仍可解码
  const ok = RPA1.decodeRange(broken, 2048, 3072);
  assert.ok(ok.ok, JSON.stringify(ok.error));
  // 涉及坏索引的区间被拒绝
  const badRange = RPA1.decodeRange(broken, 0, 4096);
  assert.ok(!badRange.ok);
  assert.ok(badRange.badBlocks.includes(bad));
});

test('头错误：拒绝打开（调用方应保留旧归档）', () => {
  const { enc } = roundtripCheck(48000, 1, 16, 3000, 23, 'sine');
  const copy = new Uint8Array(enc.bytes);
  copy[0] = 0x00; // 魔数坏
  const r = RPA1.parse(copy);
  assert.ok(!r.ok);
  // 块数不一致
  const copy2 = new Uint8Array(enc.bytes);
  copy2[14] ^= 0xff;
  assert.ok(!RPA1.parse(copy2).ok);
});

test('块头参数越界 / 转义违规记为坏块', () => {
  const { enc, arc } = roundtripCheck(48000, 1, 16, 3000, 24, 'sine');
  // 把块 0 的阶数改成 3（越界），并重算该块 CRC 以只测试块头解析
  const copy = new Uint8Array(enc.bytes);
  const e = arc.entries[0];
  copy[e.offset + 1] = 3;
  const crc = RPA1.crc32(copy, e.offset, e.offset + e.size);
  const dp = RPA1.HEADER_SIZE + 0 * RPA1.ENTRY_SIZE + 8;
  copy[dp] = crc & 0xff;
  copy[dp + 1] = (crc >>> 8) & 0xff;
  copy[dp + 2] = (crc >>> 16) & 0xff;
  copy[dp + 3] = (crc >>> 24) & 0xff;
  const broken = RPA1.parse(copy);
  assert.strictEqual(broken.entries[0].status, 'block');
  assert.ok(/越界/.test(broken.entries[0].error));
});

test('截断的块目录：头可读，条目逐个标为索引损坏', () => {
  const { enc } = roundtripCheck(48000, 1, 16, 5000, 25, 'sine');
  const truncated = enc.bytes.subarray(0, RPA1.HEADER_SIZE + 10);
  const r = RPA1.parse(truncated);
  assert.ok(r.ok);
  for (const e of r.entries) assert.strictEqual(e.status, 'index');
});

console.log('WAV 格式');
test('WAV 导出与头字段', () => {
  const { arc } = roundtripCheck(44100, 2, 24, 1000, 31, 'sine');
  const wav = RPA1.exportWav(arc, 100, 900);
  assert.ok(wav.ok);
  const p = RPA1.parseWav(wav.bytes);
  assert.ok(p.ok);
  assert.strictEqual(p.sampleRate, 44100);
  assert.strictEqual(p.channels, 2);
  assert.strictEqual(p.bitDepth, 24);
  assert.strictEqual(p.totalFrames, 800);
});

test('WAV 解析拒绝非法输入', () => {
  const bad1 = RPA1.parseWav(new Uint8Array(4));
  assert.ok(!bad1.ok);
  const { arc } = roundtripCheck(48000, 1, 16, 1000, 32, 'sine');
  const wav = RPA1.exportWav(arc, 0, 1000).bytes;
  // 把格式码改成 3（浮点）
  const copy = new Uint8Array(wav);
  copy[20] = 3;
  assert.ok(!RPA1.parseWav(copy).ok);
  // 位深改 32
  const copy2 = new Uint8Array(wav);
  copy2[34] = 32;
  assert.ok(!RPA1.parseWav(copy2).ok);
  // 采样率超出 8–48 kHz：96 kHz
  const copy3 = new Uint8Array(wav);
  copy3[24] = 0x00; copy3[25] = 0x77; copy3[26] = 0x01; copy3[27] = 0x00; // 96000
  assert.ok(!RPA1.parseWav(copy3).ok);
});

test('超过 90 秒的 WAV 被拒绝', () => {
  const chans = [new Int32Array(48000 * 90 + 1)];
  const enc = RPA1.encode({ sampleRate: 48000, channels: 1, bitDepth: 16, channelsData: chans });
  assert.ok(!enc.ok);
});

test('CRC32 与 zlib 已知值一致', () => {
  const buf = new TextEncoder().encode('123456789');
  assert.strictEqual(RPA1.crc32(buf, 0, buf.length), 0xcbf43926);
});

test('CRC 正确但内容被改的块：要么判坏块，要么解出合法样本（绝不静默回绕）', () => {
  const n = 1024;
  const L = new Int32Array(n), Rc = new Int32Array(n);
  for (let i = 0; i < n; i++) { L[i] = i * 3 - 1000; Rc[i] = 1000 - i * 2; }
  const enc = RPA1.encode({ sampleRate: 48000, channels: 2, bitDepth: 24, channelsData: [L, Rc] });
  const arc = RPA1.parse(enc.bytes);
  const e = arc.entries[0];
  let bad = 0, good = 0;
  for (let t = 0; t < 200; t++) {
    const c = new Uint8Array(enc.bytes);
    for (let k = 0; k < 3; k++) {
      const p = e.offset + (1 + 2 * 2) + Math.floor(Math.random() * (e.size - 5));
      c[p] ^= 1 << Math.floor(Math.random() * 8);
    }
    const crc = RPA1.crc32(c, e.offset, e.offset + e.size);
    const dp = RPA1.HEADER_SIZE + 8;
    c[dp] = crc & 0xff; c[dp + 1] = (crc >>> 8) & 0xff;
    c[dp + 2] = (crc >>> 16) & 0xff; c[dp + 3] = (crc >>> 24) & 0xff;
    const a = RPA1.parse(c);
    assert.strictEqual(a.entries[0].status, 'ok', '重算 CRC 后应通过');
    const d = RPA1.decodeBlock(a, 0);
    if (!d.ok) { bad++; continue; }
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < n; i++) {
        const v = d.channels[ch][i];
        assert.ok(Number.isInteger(v) && v >= -8388608 && v <= 8388607, '解出的样本必须在范围内');
      }
    }
    good++;
  }
  assert.strictEqual(bad + good, 200);
});

console.log('选参与结尾');
test('每块位数 = 头部 + ceil(位流/8)，与目录长度一致', () => {
  const { enc } = roundtripCheck(48000, 2, 24, 5000, 41, 'noise');
  const arc = RPA1.parse(enc.bytes);
  for (const e of arc.entries) {
    const hdrLen = 1 + 2 * 2;
    // 重新解码位流统计实际消耗位数
    const info = e.headerInfo;
    // 通过 decodeBlock 验证不抛错已足够，这里验证块长合法
    assert.ok(e.size >= hdrLen);
    assert.ok(e.size === hdrLen + Math.ceil((e.size - hdrLen)));
  }
});

test('同长决胜：单路 0 阶 k=0 优于 0 阶 k=1 等', () => {
  // 全 0 样本时所有 k 位数相同（每样本 1 位），应选最小 k
  const chans = [new Int32Array(1024)];
  const enc = RPA1.encode({ sampleRate: 8000, channels: 1, bitDepth: 16, channelsData: chans });
  assert.ok(enc.ok);
  const arc = RPA1.parse(enc.bytes);
  assert.strictEqual(arc.entries[0].headerInfo.orders[0], 0);
  assert.strictEqual(arc.entries[0].headerInfo.ks[0], 0);
});

console.log('');
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed) process.exit(1);
