#!/usr/bin/env node
/* 浏览器端自检：样例首屏、点选叠加、导出、上传校验。需要 Playwright。 */
'use strict';
const path = require('path');
const fs = require('fs');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  try {
    ({ chromium } = require(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim() + '/playwright'));
  } catch (e2) {
    console.error('缺少 Playwright，跳过浏览器自检。先安装：npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

(async () => {
  const file = 'file://' + path.join(__dirname, '..', 'dist', 'index.html');
  const browser = await chromium.launch();
  const failures = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(file, { waitUntil: 'load' });

  await page.waitForFunction(() => !document.getElementById('runBtn').disabled && document.querySelectorAll('.result').length > 0, { timeout: 30000 });
  const count = await page.locator('.result').count();
  if (count !== 3) failures.push(`样例应得 3 处，实际 ${count}`);
  else console.log('✓ 样例首屏定位出 3 处');

  const noMirror = (await page.locator('.badge').allInnerTexts()).filter(t => t === '镜像').length;
  if (noMirror !== 1) failures.push('应恰有 1 处镜像结果');
  else console.log('✓ 镜像状态正确');

  await page.locator('.result').nth(2).click();
  await page.waitForTimeout(200);
  const detail = await page.locator('#selDetail').innerText();
  if (!/失配/.test(detail)) failures.push('选中项详情缺少失配计数');
  else console.log('✓ 选中项显示匹配/失配');

  const canvasBlank = await page.evaluate(() => {
    const c = document.getElementById('sceneCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // 匹配点用 --match (#0b6f63)：绿蓝明显高于红；失配用 --miss (#ad2146)：红明显高于绿。
    let teal = 0, pink = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (g > 70 && b > 60 && g > r + 40 && b > r + 30) teal++;
      if (r > 120 && r > g + 70 && b > g + 20) pink++;
    }
    return { teal, pink };
  });
  if (canvasBlank.teal < 50 || canvasBlank.pink < 10) failures.push('叠加图缺少匹配/失配点：' + JSON.stringify(canvasBlank));
  else console.log('✓ 叠加图同时画出匹配与失配边点');

  await page.locator('#exportBtn').click();
  await page.waitForTimeout(200);
  const data = JSON.parse(await page.locator('#exportCode').innerText());
  if (!data.poses || data.poses.length !== 3) failures.push('导出 JSON 姿态数量不对');
  else if (data.sort !== 'coverage desc, meanDistance asc') failures.push('导出排序说明缺失');
  else console.log('✓ 导出排序后的姿态 JSON');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) failures.push('页面出现横向滚动 ' + overflow + 'px');
  else console.log('✓ 无横向滚动');

  // 上传限制
  const big = Buffer.from(pgmBytes(400, 400));
  fs.writeFileSync('/tmp/_selftest_big.pgm', big);
  await page.setInputFiles('#sceneFile', '/tmp/_selftest_big.pgm');
  await page.waitForTimeout(150);
  const msg = await page.locator('#message').innerText();
  if (!/最多 384 px/.test(msg)) failures.push('超限场景未被拒绝：' + msg);
  else console.log('✓ 超限场景被拒绝');

  // 手机宽度
  const mctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
  const mp = await mctx.newPage();
  await mp.goto(file, { waitUntil: 'load' });
  await mp.waitForFunction(() => !document.getElementById('runBtn').disabled && document.querySelectorAll('.result').length > 0, { timeout: 30000 });
  const mOverflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mOverflow > 0) failures.push('手机宽度横向滚动 ' + mOverflow + 'px');
  else console.log('✓ 手机宽度无横向滚动');

  if (errors.length) failures.push('控制台错误：' + errors.join('; '));
  await browser.close();
  fs.rmSync('/tmp/_selftest_big.pgm', { force: true });

  if (failures.length) { console.error('\n失败：'); failures.forEach(f => console.error('  ✗ ' + f)); process.exit(1); }
  console.log('\n浏览器自检全部通过');
})();

function pgmBytes(w, h) {
  const head = Buffer.from(`P5\n${w} ${h}\n255\n`);
  const px = Buffer.alloc(w * h, 20);
  return Buffer.concat([head, px]);
}
