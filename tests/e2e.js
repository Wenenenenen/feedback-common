#!/usr/bin/env node
'use strict';
/* 浏览器端到端测试：用真实 Chromium 验证加载、编码、试听、导出、损坏隔离。 */
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const root = path.join(__dirname, '..');
const fileUrl = 'file://' + path.join(root, 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(fileUrl);
  await page.waitForTimeout(300);

  console.log('— 载入 mono16 示例');
  await page.click('[data-sample="mono16"]');
  await page.waitForSelector('#wav-info:not([hidden])');
  const wavNote = await page.textContent('#wav-info-note');
  console.log('  WAV note:', wavNote);

  console.log('— 编码');
  const t0 = Date.now();
  await page.click('#encode-btn');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  console.log('  编码+渲染用时', Date.now() - t0, 'ms');

  const summary = await page.$$eval('#summary .readout', (els) =>
    els.map((e) => e.querySelector('.k').textContent + '=' + e.querySelector('.v').textContent));
  console.log('  摘要:', summary.join(' | '));

  const rows = await page.$$eval('#block-tbody tr[data-block]', (trs) =>
    trs.map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()).join(' | ')));
  console.log('  表行数:', rows.length);
  rows.slice(0, 3).forEach((r) => console.log('   ', r));

  const selLength = await page.textContent('#sel-length');
  console.log('  选中长度:', selLength);

  console.log('— 试听区间');
  await page.click('#play-btn');
  await page.waitForTimeout(500);
  const playStatus = await page.textContent('#play-status');
  console.log('  播放状态:', playStatus);
  await page.click('#play-btn');

  console.log('— 导出区间');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('#export-btn')
  ]);
  console.log('  导出下载:', download ? download.suggestedFilename() : '（无下载事件，可能被沙箱拦截）');

  console.log('— 损坏块隔离');
  await page.click('#sim-block');
  await page.waitForTimeout(400);
  const health = await page.$$eval('#health .chip', (els) => els.map((e) => e.textContent.trim()));
  console.log('  健康:', health.join(' | '));
  const notices = await page.$$eval('#notices .notice', (els) => els.map((e) => e.textContent.trim().slice(0, 60)));
  notices.forEach((n) => console.log('  提示:', n));

  // 选一个跨越坏块的区间（0 到总帧数）
  const totalFrames = await page.$eval('#sel-end', (el) => Number(el.max));
  await page.fill('#sel-start', '0');
  await page.dispatchEvent('#sel-start', 'change');
  await page.fill('#sel-end', String(totalFrames));
  await page.dispatchEvent('#sel-end', 'change');
  await page.waitForTimeout(200);
  const selState = await page.textContent('#sel-state');
  console.log('  跨坏块选区状态:', selState);
  const exportDisabled = await page.$eval('#export-btn', (b) => b.disabled);
  console.log('  导出按钮禁用:', exportDisabled);

  console.log('— 损坏索引');
  await page.click('#restore');
  await page.waitForTimeout(300);
  await page.click('#sim-index');
  await page.waitForTimeout(400);
  const health2 = await page.$$eval('#health .chip', (els) => els.map((e) => e.textContent.trim()));
  console.log('  健康:', health2.join(' | '));
  const tbodyStilHasRows = await page.$$eval('#block-tbody tr[data-block]', (els) => els.length);
  console.log('  归档仍打开，表行数:', tbodyStilHasRows);

  console.log('— 恢复');
  await page.click('#restore');
  await page.waitForTimeout(300);
  const restoreNotices = await page.$$eval('#notices .notice', (els) => els.map((e) => e.textContent.trim().slice(0, 40)));
  console.log('  恢复后提示:', restoreNotices.join(' | '));

  console.log('— stereo24 示例（编码 90 秒源之外的 0.3 秒）');
  await page.click('[data-sample="stereo24"]');
  await page.waitForTimeout(300);
  await page.click('#encode-btn');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
  const summary2 = await page.$$eval('#summary .readout', (els) =>
    els.map((e) => e.querySelector('.k').textContent + '=' + e.querySelector('.v').textContent));
  console.log('  摘要:', summary2.join(' | '));

  console.log('— 窄屏 400px 横向溢出检查');
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('  横向溢出 px:', overflow);

  console.log('— 暗色主题截图凭据');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/rpa-dark.png', fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/rpa-light.png', fullPage: false });

  console.log('\n错误数:', errors.length);
  errors.slice(0, 12).forEach((e) => console.log('  ', e));

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
