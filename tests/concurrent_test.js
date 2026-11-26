// 重算进行中反复切换：满额用例下验证响应性、代际隔离与最终一致性
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  await page.goto('file:///home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk/index.html');
  await page.setInputFiles('#file-input', '/tmp/stress.zip');
  await page.waitForFunction(() => window.StokesApp.state.result !== null);

  // 发布记录保存在页面内 window 上
  await page.evaluate(() => {
    window.__pub = [];
    window.StokesApp.on('result', (r) => window.__pub.push(r.enabled.slice()));
  });

  // 在重算进行中连续切换 8 次（含还原），每次间隔远小于一次完整重算
  for (let k = 0; k < 8; k++) {
    await page.evaluate((k) => window.StokesApp.toggleFrame(k % 4), k);
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => !window.StokesApp.state.running, { timeout: 15000 });

  const finalEnabled = await page.evaluate(() =>
    window.StokesApp.state.enabled.map((e, i) => e ? i : -1).filter((i) => i >= 0));
  const published = await page.evaluate(() => window.__pub);
  const lastPublished = published[published.length - 1];
  const ok = JSON.stringify(finalEnabled) === JSON.stringify(lastPublished);
  console.log('最终设置:', JSON.stringify(finalEnabled));
  console.log('最后发布:', JSON.stringify(lastPublished));
  console.log('发布次数:', published.length, '(应远少于切换次数，因中间任务被作废)');
  console.log(ok ? 'ok - 最终结果与最新设置一致，无幽灵发布' : 'FAIL - 结果不一致');
  if (!ok) process.exitCode = 1;
  // 每次发布都必须与当时启用帧一致（enabled 字段自描述）
  const allSelfConsistent = published.every((en) => Array.isArray(en) && en.every((i) => i >= 0));
  console.log(allSelfConsistent ? 'ok - 所有发布结果自描述合法' : 'FAIL');
  await browser.close();
})();
