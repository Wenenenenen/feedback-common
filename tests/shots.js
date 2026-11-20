const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
(async () => {
  const browser = await chromium.launch();
  // 桌面浅色
  let page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  await page.goto(URL); await page.waitForTimeout(400);
  await page.click('#packBtn'); await page.waitForTimeout(300);
  await page.locator('.chart-row', { hasText: 'chart-2' }).click();
  await page.screenshot({ path: '/tmp/shot-light.png', fullPage: false });

  // 桌面深色
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  await page.goto(URL); await page.waitForTimeout(400);
  await page.click('#packBtn'); await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/shot-dark.png', fullPage: false });

  // 手机窄屏
  page = await browser.newPage({ viewport: { width: 400, height: 900 }, colorScheme: 'light' });
  await page.goto(URL); await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/shot-phone.png', fullPage: true });

  // 归属图模态
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(URL); await page.waitForTimeout(400);
  await page.click('#packBtn'); await page.waitForTimeout(200);
  await page.click('#exportOwnership'); await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/shot-ownership.png' });
  await browser.close();
  console.log('shots done');
})();
