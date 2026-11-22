#!/usr/bin/env node
'use strict';
/* 浏览器产出的 90 秒归档与 Python 参考实现逐字节比较。 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const root = path.join(__dirname, '..');
const fileUrl = 'file://' + path.join(root, 'index.html');
const WAV = '/tmp/big90.wav';

(async () => {
  if (!fs.existsSync(WAV)) { console.error('先运行 tools/genwav.js 生成 /tmp/big90.wav'); process.exit(1); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(fileUrl);
  await page.setInputFiles('#file-input', WAV);
  await page.waitForSelector('#wav-info:not([hidden])', { timeout: 20000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#encode-btn');
  const download = await downloadPromise;
  const out = '/tmp/big90_browser.rpa';
  await download.saveAs(out);
  await browser.close();

  const ref = '/tmp/big90.ref.rpa';
  if (!fs.existsSync(ref)) {
    console.log('生成 Python 参考归档（可能较慢）…');
    execFileSync('python3', ['-I', path.join(root, 'tools/reference.py'), WAV, ref], { stdio: 'inherit', timeout: 600000 });
  }
  const a = fs.readFileSync(out);
  const b = fs.readFileSync(ref);
  const same = Buffer.compare(a, b) === 0;
  console.log('浏览器产出', a.length, '字节；参考', b.length, '字节；逐字节一致:', same);
  if (!same) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log('首个差异字节', i, '浏览器', a[i], '参考', b[i]); break; }
    }
  }
  process.exit(same ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
