'use strict';
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
(async () => {
  const file = 'file://' + path.resolve(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(file, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled);

  await page.setInputFiles('#tplFile', '/tmp/tpl_custom.pgm');
  await page.setInputFiles('#sceneFile', '/tmp/scene_custom.pgm');
  await page.waitForTimeout(200);
  console.log('tpl label:', await page.locator('#tplName').innerText());
  console.log('scene label:', await page.locator('#sceneName').innerText());
  // 设锚点为角 (10,10)
  await page.locator('#anchorX').fill('10');
  await page.locator('#anchorX').dispatchEvent('input');
  await page.locator('#anchorY').fill('10');
  await page.locator('#anchorY').dispatchEvent('input');
  // 放宽尺度范围以覆盖 0.75
  await page.locator('#minScale').fill('0.6');
  await page.locator('#minScale').dispatchEvent('input');
  await page.locator('#runBtn').click();
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, { timeout: 60000 });
  await page.waitForTimeout(300);
  const count = await page.locator('.result').count();
  const texts = await page.locator('.result').allInnerTexts();
  console.log('found', count);
  texts.forEach(t => console.log('  ', t.replace(/\n+/g, ' | ')));
  await page.locator('.stage').screenshot({ path: path.join(__dirname, '..', '.shots', 'custom.png') });

  // 超限文件
  await page.setInputFiles('#sceneFile', '/tmp/scene_custom.pgm'); // keep
  // 生成一个 400x400 的
  const big = await page.evaluate(async () => {
    const w=400,h=400; const a=new Uint8Array(w*h); a.fill(20); for(let i=0;i<200;i++)a[i]=230;
    const head='P5\n400 400\n255\n';
    const bytes=new TextEncoder().encode(head);
    const all=new Uint8Array(bytes.length+w*h); all.set(bytes); all.set(a,bytes.length);
    return Array.from(all);
  });
  // 写到磁盘再用 setInputFiles
  const fs = require('fs');
  fs.writeFileSync('/tmp/big_scene.pgm', Buffer.from(big));
  await page.setInputFiles('#sceneFile', '/tmp/big_scene.pgm');
  await page.waitForTimeout(200);
  console.log('limit msg:', await page.locator('#message').innerText(), 'visible', await page.locator('#message').isVisible());

  // 非 PGM
  fs.writeFileSync('/tmp/notpgm.txt', 'hello');
  await page.setInputFiles('#tplFile', '/tmp/notpgm.txt');
  await page.waitForTimeout(200);
  console.log('non-pgm msg:', await page.locator('#message').innerText());

  await browser.close();
  if (errs.length) { console.log('ERRORS', errs); process.exitCode=1; } else console.log('no errors');
})();
