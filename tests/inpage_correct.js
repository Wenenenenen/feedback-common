#!/usr/bin/env node
'use strict';
/* 页内解码正确性：在浏览器里调用全局 RPA1 解码，逐样本核对，
 * 并验证导出 WAV 经解析后与原 WAV 区间逐个相同。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const root = path.join(__dirname, '..');
const fileUrl = 'file://' + path.join(root, 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(fileUrl);

  const result = await page.evaluate(async () => {
    const R = window.RPA1;
    // 用示例 WAV 构造，并在浏览器里编码/解码
    const s = window.RPA_SAMPLES.stereo24;
    const bin = atob(s.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const wav = R.parseWav(bytes);
    const enc = R.encode({
      sampleRate: wav.sampleRate, channels: wav.channels, bitDepth: wav.bitDepth, channelsData: wav.channelsData
    });
    const arc = R.parse(enc.bytes);
    const dec = R.decodeRange(arc, 0, wav.totalFrames);
    let mism = 0;
    for (let c = 0; c < wav.channels; c++)
      for (let i = 0; i < wav.totalFrames; i++)
        if (dec.channels[c][i] !== wav.channelsData[c][i]) mism++;

    // 任意区间批量核对
    let rangeMism = 0;
    const total = wav.totalFrames;
    for (let t = 0; t < 30; t++) {
      const a = Math.floor(Math.random() * total);
      const b = a + 1 + Math.floor(Math.random() * (total - a));
      const dr = R.decodeRange(arc, a, b);
      if (!dr.ok) { rangeMism++; continue; }
      for (let c = 0; c < wav.channels; c++)
        for (let i = a; i < b; i++)
          if (dr.channels[c][i - a] !== wav.channelsData[c][i]) rangeMism++;
    }

    // 导出 WAV 再解析核对
    const exported = R.exportWav(arc, 100, 1200);
    const reparsed = R.parseWav(exported.bytes);
    let expMism = 0;
    for (let c = 0; c < wav.channels; c++)
      for (let i = 100; i < 1200; i++)
        if (reparsed.channelsData[c][i - 100] !== wav.channelsData[c][i]) expMism++;

    // 编码字节与 Node 参考一致（用 Python 生成的比较在别处，这里检查自洽）
    return {
      mismatchFull: mism,
      rangeMism,
      exportMism: expMism,
      blocks: arc.header.numBlocks,
      sameBytes: R.crc32(enc.bytes, 0, enc.bytes.length)
    };
  });

  console.log('页内解码：', JSON.stringify(result));
  await browser.close();
  const ok = result.mismatchFull === 0 && result.rangeMism === 0 && result.exportMism === 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
