#!/usr/bin/env node
/* Render the built page with Playwright and capture screenshots + console errors. */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const url = process.argv[2] || 'http://localhost:4173/';
const outDir = process.argv[3] || '/tmp/bhe-shots';
const fs = require('fs');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const mode of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      colorScheme: mode,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push('[' + mode + '] ' + m.type() + ': ' + m.text());
    });
    page.on('pageerror', (e) => errors.push('[' + mode + '] pageerror: ' + e.message));
    page.on('requestfailed', (r) => errors.push('[' + mode + '] requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, 'desktop-' + mode + '.png'), fullPage: true });
    await ctx.close();
  }

  // phone
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('[phone] pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[phone] console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, 'phone.png'), fullPage: true });
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  await ctx.close();
  await browser.close();

  console.log(JSON.stringify({ overflow, errors }, null, 2));
})();
