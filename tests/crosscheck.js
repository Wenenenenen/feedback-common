#!/usr/bin/env node
'use strict';
// 交叉校验：JS 编码结果应与 Python 参考实现逐字节相同。
const fs = require('fs');
const path = require('path');
const RPA1 = require('../src/rpa1.js');

function loadWav(p) {
  const bytes = new Uint8Array(fs.readFileSync(p));
  return RPA1.parseWav(bytes);
}

function main() {
  const cases = [
    ['/tmp/rpa_samples/mono16.wav', '/tmp/mono16.ref.rpa'],
    ['/tmp/rpa_samples/stereo24.wav', '/tmp/stereo24.ref.rpa']
  ];
  let failed = 0;
  for (const [wavPath, refPath] of cases) {
    const wav = loadWav(wavPath);
    if (!wav.ok) { console.error('WAV 解析失败', wavPath, wav.error); failed++; continue; }
    const t0 = Date.now();
    const enc = RPA1.encode({
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitDepth: wav.bitDepth,
      channelsData: wav.channelsData
    });
    const ms = Date.now() - t0;
    if (!enc.ok) { console.error('编码失败', enc.error); failed++; continue; }
    const ref = fs.readFileSync(refPath);
    const same = Buffer.compare(Buffer.from(enc.bytes), ref) === 0;
    console.log(path.basename(wavPath), 'JS', enc.bytes.length, 'ref', ref.length, 'identical=', same, `${ms}ms`);
    if (!same) {
      failed++;
      // 找到第一处差异
      const a = enc.bytes, b = new Uint8Array(ref);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) { console.log('first diff at', i, 'js=', a[i], 'ref=', b[i]); break; }
      }
    }

    // 往返：解码后逐样本相同
    const arc = RPA1.parse(enc.bytes);
    if (!arc.ok) { console.error('解析失败', arc.error); failed++; continue; }
    const dec = RPA1.decodeRange(arc, 0, wav.totalFrames);
    if (!dec.ok) { console.error('解码失败', dec.error); failed++; continue; }
    let mism = 0;
    for (let c = 0; c < wav.channels; c++) {
      for (let i = 0; i < wav.totalFrames; i++) {
        if (dec.channels[c][i] !== wav.channelsData[c][i]) {
          if (mism < 5) console.log('mismatch c', c, 'frame', i, dec.channels[c][i], wav.channelsData[c][i]);
          mism++;
        }
      }
    }
    console.log('  roundtrip mismatches:', mism);
    if (mism) failed++;
  }
  if (failed) { console.error('FAILED', failed); process.exit(1); }
  console.log('OK');
}

main();
