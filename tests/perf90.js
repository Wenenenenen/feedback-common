#!/usr/bin/env node
'use strict';
/* 关键时限测试：90 秒 48kHz 双声道 24 位，点击编码后 8 秒内必须触发下载。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const root = path.join(__dirname, '..');
const fileUrl = 'file://' + path.join(root, 'index.html');
const WAV = '/tmp/big90.wav';

(async () => {
  if (!fs.existsSync(WAV)) { console.error('缺少 /tmp/big90.wav，先运行 tools/genwav.js'); process.exit(1); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fileUrl);

  await page.setInputFiles('#file-input', WAV);
  await page.waitForSelector('#wav-info:not([hidden])', { timeout: 20000 });
  const note = await page.textContent('#wav-info-note');
  console.log('WAV:', note);

  const t0 = Date.now();
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#encode-btn');
  const download = await downloadPromise;
  const elapsed = Date.now() - t0;
  console.log(`点击到下载事件: ${elapsed} ms  (要求 < 8000 ms)  →  ${elapsed < 8000 ? '通过' : '超时'}`);
  console.log('文件名:', download.suggestedFilename());

  // 保存并用 Node 解码校验
  const outPath = '/tmp/big90_browser.rpa';
  await download.saveAs(outPath);
  const RPA1 = require(path.join(root, 'src/rpa1.js'));
  const bytes = new Uint8Array(fs.readFileSync(outPath));
  const arc = RPA1.parse(bytes);
  console.log('归档解析:', arc.ok ? '成功' : '失败');
  if (arc.ok) {
    const d = RPA1.describe(arc);
    console.log(`  块数 ${d.numBlocks}，完好 ${d.okBlocks}，坏 ${d.badBlocks}，索引坏 ${d.indexBlocks}`);
    // 用参考实现独立校验几个块的字节一致性
    const wav = RPA1.parseWav(new Uint8Array(fs.readFileSync(WAV)));
    // 全量往返
    const tdec = Date.now();
    const dec = RPA1.decodeRange(arc, 0, wav.totalFrames);
    let mism = 0;
    if (dec.ok) {
      for (let c = 0; c < wav.channels; c++)
        for (let i = 0; i < wav.totalFrames; i += 997)
          if (dec.channels[c][i] !== wav.channelsData[c][i]) mism++;
    }
    console.log(`  全量解码 ${Date.now() - tdec} ms，抽样比对失配 ${mism}`);
  }

  // 下载后的归档仍能打开并展示
  await page.waitForSelector('#workspace:not([hidden])');
  const blocks = await page.$$eval('#block-tbody tr[data-block]', (els) => els.length);
  console.log('页面表行数（首屏）:', blocks);

  console.log('错误:', errors.length);
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(1); });
