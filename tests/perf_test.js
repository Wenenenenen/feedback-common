// 满额性能：浏览器内导入 256x256x12 帧，测 导入→结果可导出 的总时长
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk/index.html');
  const t0 = Date.now();
  await page.setInputFiles('#file-input', '/tmp/stress.zip');
  await page.waitForFunction(() => {
    const b = document.getElementById('export-btn');
    return !b.disabled;
  }, null, { timeout: 15000 });
  const t1 = Date.now();
  const stats = await page.evaluate(() => {
    const r = window.StokesApp.state.result;
    return { solved: Array.from(r.solved).reduce((a, b) => a + b, 0), total: r.solved.length, enabled: r.enabled.length };
  });
  // 再测一次“重算”（切走一帧再切回），稳态重算耗时
  const t2 = Date.now();
  await page.evaluate(() => {
    const App = window.StokesApp;
    App.toggleFrame(0);
  });
  await page.waitForFunction(() => !window.StokesApp.state.running, null, { timeout: 15000 });
  const t3 = Date.now();
  await page.evaluate(() => window.StokesApp.toggleFrame(0));
  await page.waitForFunction(() => !window.StokesApp.state.running, null, { timeout: 15000 });
  const t4 = Date.now();
  console.log('导入到可导出:', t1 - t0, 'ms', JSON.stringify(stats));
  console.log('稳态重算(切帧):', t3 - t2, 'ms /', t4 - t3, 'ms');
  console.log('8 秒预算:', (t1 - t0) < 8000 ? '达标' : '超标');
  await browser.close();
})();
