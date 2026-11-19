#!/usr/bin/env node
/* 用真实浏览器加载页面，截图并捕获控制台错误。用法：node tools/shot.js [输出前缀] [宽x高] */
'use strict';

const path = require('path');

function loadPlaywright() {
  const candidates = [
    'playwright',
    path.join(process.env.HOME || '', '.nvm/versions/node', process.version, 'lib/node_modules/playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 继续尝试 */ }
  }
  throw new Error('未找到 playwright，请先 npm i -g playwright');
}
const { chromium } = loadPlaywright();

const BASE = process.env.FF_URL || 'http://localhost:8123/';
const OUT = process.argv[2] || '/tmp/ff-shot';
const VIEW = process.argv[3] || '1600x1000';

(async () => {
  const [w, h] = VIEW.split('x').map(Number);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const info = await page.evaluate(() => {
    const st = window.__ff && window.__ff.state;
    return {
      hasEngine: !!st.engine,
      caseName: st.caseName,
      units: st.engine ? st.engine.initialUnits.length : 0,
      frames: st.engine ? st.engine.sim.frames.length : 0,
      banner: document.querySelector('#banner').hidden ? null : document.querySelector('#banner').textContent.trim(),
      canvas: (() => { const c = document.querySelector('#mapCanvas'); return [c.width, c.height]; })(),
    };
  });

  await page.screenshot({ path: OUT + '-overview.png', fullPage: true });

  // 逐帧播放若干帧后截图
  await page.evaluate(() => { for (let i = 0; i < 12; i++) window.__ff.stepForward(); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '-playing.png', fullPage: true });

  // 选一个格子
  await page.evaluate(() => {
    const st = window.__ff.state;
    st.selected = { x: 10, y: 7 };
    window.__ff.renderAll();
  });
  await page.waitForTimeout(150);

  // 尺寸 3
  await page.click('.seg-btn[data-size="3"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: OUT + '-size3.png', fullPage: true });

  console.log(JSON.stringify({ info, errors }, null, 2));
  await browser.close();
  if (errors.length) process.exitCode = 1;
})();
