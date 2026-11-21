#!/usr/bin/env node
/* 功能检查：点选第 3 项、检查叠加图、导出 JSON、改参数后的脏提示。 */
'use strict';
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

(async () => {
  const file = 'file://' + path.resolve(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(file, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled && document.querySelectorAll('.result').length >= 3);
  console.log('results', await page.locator('.result').count());

  // 点击第 3 项（被遮挡的镜像目标）
  await page.locator('.result').nth(2).click();
  await page.waitForTimeout(300);
  console.log('detail:', (await page.locator('#selDetail').innerText()).replace(/\n/g, ' | '));
  await page.locator('.stage').screenshot({ path: path.join(__dirname, '..', '.shots', 'selected-3.png') });
  await page.locator('.results').screenshot({ path: path.join(__dirname, '..', '.shots', 'list-selected.png') });

  // 导出 JSON
  await page.locator('#exportBtn').click();
  await page.waitForTimeout(300);
  const json = await page.locator('#exportCode').innerText();
  const parsed = JSON.parse(json);
  console.log('export poses', parsed.poses.length, 'sort', parsed.sort, 'anchor', parsed.params.anchor, 'edge', parsed.params.edgeThreshold);
  console.log('first pose', JSON.stringify(parsed.poses[0]));
  await page.locator('#exportPanel').screenshot({ path: path.join(__dirname, '..', '.shots', 'export.png') });

  // 改参数 → 脏提示
  await page.locator('#minCoverage').fill('0.9');
  await page.locator('#minCoverage').dispatchEvent('input');
  await page.waitForTimeout(100);
  console.log('dirty visible', await page.locator('#dirtyNote').isVisible());

  // 重新定位 → 应少于 3 项
  await page.locator('#runBtn').click();
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
  await page.waitForTimeout(200);
  console.log('after raise threshold', await page.locator('.result').count());

  // 关闭镜像再跑
  await page.locator('#minCoverage').fill('0.62');
  await page.locator('#minCoverage').dispatchEvent('input');
  await page.locator('#mirrorSearch').uncheck();
  await page.locator('#runBtn').click();
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
  await page.waitForTimeout(200);
  const badges = await page.locator('.badge').allInnerTexts();
  console.log('mirror off badges', badges);

  // 空场景：清空结果 → 空状态
  await page.locator('#clearBtn').click();
  await page.waitForTimeout(100);
  console.log('after clear empty visible', await page.locator('#resultEmpty').isVisible(), 'export disabled', await page.locator('#exportBtn').isDisabled());

  await browser.close();
  if (errs.length) { console.log('ERRORS', errs); process.exitCode = 1; }
  else console.log('no errors');
})();
