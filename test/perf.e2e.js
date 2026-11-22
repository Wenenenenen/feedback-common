'use strict';
// 端到端性能：在真实浏览器里从点击「计算」到结果可导出。
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL);
  await page.waitForTimeout(500);

  // 通过 JSON 一次性设置 1024×1024、半径 16 格的两层物种
  await page.locator('.tab[data-tab="config"]').click();
  const config = {
    seed: 42,
    species: [
      [{ id: 'tree', radius: 16 * 256 }],
      [{ id: 'grass', radius: 16 * 256 }]
    ],
    base: [[1], [1]],
    patches: [],
    window: [-512, -512, 1024, 1024]
  };
  await page.locator('#config-json').fill(JSON.stringify(config, null, 2));
  await page.locator('#apply-json').click();
  await page.waitForTimeout(300);

  await page.locator('.tab[data-tab="windows"]').click();

  const timings = [];
  for (let t = 0; t < 3; t++) {
    const t0 = Date.now();
    await page.locator('.window-card .btn.primary').nth(0).click();
    await page.waitForFunction(() => {
      const chip = document.querySelector('.window-card .chip');
      return chip && /已完成/.test(chip.textContent);
    }, { timeout: 30000 });
    timings.push(Date.now() - t0);
  }
  const best = Math.min.apply(null, timings);
  const rows = await page.evaluate(() => {
    const st = document.querySelector('.window-card .status').textContent;
    return st;
  });
  console.log('浏览器端到端（点击→可导出）用时：' + timings.map(x => x + 'ms').join(', '));
  console.log('最快 ' + best + ' ms，预算 10000 ms，' + (best < 10000 ? '通过' : '超出'));
  console.log('状态：' + rows);

  // 导出确认
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.locator('.window-card .btn', { hasText: '导出 TSV' }).first().click()
  ]);
  console.log('可导出：' + (download ? download.suggestedFilename() : '失败'));

  await page.screenshot({ path: path.join(ROOT, 'test', 'page-1024.png') });
  await browser.close();
  process.exit(best < 10000 && download ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
