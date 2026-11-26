#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8137/index.html';
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg01-browser-'));

function header(side, bits, payload) {
  const buf = Buffer.alloc(10 + payload.length);
  buf.write('QG01', 0, 'ascii');
  buf.writeUInt16LE(side, 4);
  buf.writeUInt32LE(bits >>> 0, 6);
  payload.forEach((b, i) => { buf[10 + i] = b; });
  return buf;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.stack || error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.QG01 && !!window.QG01App);

  await page.click('[data-testid="load-sample"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="stat-used"]');
    return el && /\d+\s*位/.test(el.textContent || '');
  }, null, { timeout: 15000 });
  await page.waitForSelector('.qrect', { timeout: 15000 });

  // 10 位预算必须得到整图常值块。
  await page.fill('[data-testid="budget-input"]', '10');
  await page.dispatchEvent('[data-testid="budget-input"]', 'change');
  await page.click('[data-testid="encode-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="stat-used"]')?.textContent === '10 位');
  assert.equal(await page.locator('.qrect').count(), 1, 'budget 10 should have one leaf');

  // 400 位预算在样图上的精确结果是 395 位。
  await page.fill('[data-testid="budget-input"]', '400');
  await page.dispatchEvent('[data-testid="budget-input"]', 'change');
  await page.click('[data-testid="encode-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="stat-used"]')?.textContent === '395 位');

  await page.click('.qrect');
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="block-bit-range"]')?.textContent || '';
    return /\[\d+, \d+\)/.test(text);
  });
  const blockMode = await page.textContent('[data-testid="block-mode"]');
  if (!blockMode || blockMode === '未选择') throw new Error('block was not selected');

  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-testid="export-qg01"]');
  const download = await downloadPromise;
  const qgPath = path.join(outDir, download.suggestedFilename());
  await download.saveAs(qgPath);
  const qgBytes = fs.readFileSync(qgPath);
  if (qgBytes.subarray(0, 4).toString('ascii') !== 'QG01') throw new Error('bad exported magic');

  await page.setInputFiles('[data-testid="qg01-input"]', qgPath);
  await page.waitForSelector('[data-testid="roundtrip-success"]:not([hidden])', { timeout: 5000 });

  // 截断文件必须报错并保留当前预览/统计。
  const beforeNegative = await page.textContent('[data-testid="stat-used"]');
  const truncPath = path.join(outDir, 'truncated.qg01');
  fs.writeFileSync(truncPath, qgBytes.subarray(0, qgBytes.length - 2));
  await page.setInputFiles('[data-testid="qg01-input"]', truncPath);
  await page.waitForSelector('[data-testid="import-error"]:not([hidden])');
  const truncError = await page.textContent('[data-testid="import-error"]');
  if (!/截断|位置/.test(truncError)) throw new Error(`truncation error lacks position: ${truncError}`);
  const afterNegative = await page.textContent('[data-testid="stat-used"]');
  assert.equal(afterNegative, beforeNegative, 'failed import must not overwrite preview');

  // 非法四分：11111000，1×1 处分支位 1 位于 bit 4。
  const illegalPath = path.join(outDir, 'illegal-split.qg01');
  fs.writeFileSync(illegalPath, header(16, 5, Buffer.from([0b11111000])));
  await page.setInputFiles('[data-testid="qg01-input"]', illegalPath);
  await page.waitForFunction(() => /非法分块[\s\S]*\[4, 5\)/.test(document.querySelector('[data-testid="import-error"]')?.textContent || ''));

  // 非零填充：10 位常值流的末字节最低位改成 1。
  const padBytes = Buffer.from(QG01encode10());
  padBytes[11] |= 0x01;
  const padPath = path.join(outDir, 'nonzero-padding.qg01');
  fs.writeFileSync(padPath, padBytes);
  await page.setInputFiles('[data-testid="qg01-input"]', padPath);
  await page.waitForFunction(() => /非零[\s\S]*字节偏移 11/.test(document.querySelector('[data-testid="import-error"]')?.textContent || ''));

  await page.screenshot({ path: path.join(outDir, 'app.png'), fullPage: true });
  console.log(`browser-smoke: passed; artifacts in ${outDir}`);
  if (consoleErrors.length) {
    console.error(consoleErrors.join('\n'));
    process.exitCode = 1;
  }
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function QG01encode10() {
  // 直接构造一个合法 10 位常值 QG01：00 + 灰度 0x48，载荷二进制 0001001000，
  // 打包为 0x12 0x00? Let's compute via page not available here; use core require.
  const Q = require('../src/qg01-core.js');
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const gray = Q.parsePGM(fs2.readFileSync(path2.join(__dirname, '..', 'samples', 'quadtree-archive', 'gray.pgm')));
  const plan = Q.encodeOptimal({ data: gray.data, width: 16, budget: 10 });
  return Q.encodeQG01(plan);
}
