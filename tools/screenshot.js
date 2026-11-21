#!/usr/bin/env node
/* 用 Playwright 渲染本地页面，截取桌面/手机、明/暗四种视图。 */
'use strict';
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

(async () => {
  const file = 'file://' + path.resolve(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const shots = [
    { name: 'desktop-light', width: 1440, height: 1100, scheme: 'light' },
    { name: 'desktop-dark', width: 1440, height: 1100, scheme: 'dark' },
    { name: 'phone-light', width: 390, height: 900, scheme: 'light' },
    { name: 'phone-dark', width: 390, height: 900, scheme: 'dark' }
  ];
  const errors = [];
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, colorScheme: s.scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(s.name + ': ' + m.text()); });
    page.on('pageerror', e => errors.push(s.name + ' pageerror: ' + e.message));
    await page.goto(file, { waitUntil: 'load' });
    // 等首屏样例自动定位结束
    await page.waitForFunction(() => {
      const b = document.getElementById('runBtn');
      return b && !b.disabled && document.querySelectorAll('.result').length > 0;
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(__dirname, '..', '.shots', s.name + '.png'), fullPage: true });
    // 溢出检查
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scrollW: d.scrollWidth, clientW: d.clientWidth, bodyScrollW: document.body.scrollWidth };
    });
    console.log(s.name, 'overflow', JSON.stringify(overflow));
    await ctx.close();
  }
  await browser.close();
  if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log(' ', e)); process.exitCode = 1; }
  else console.log('no console errors');
})();
