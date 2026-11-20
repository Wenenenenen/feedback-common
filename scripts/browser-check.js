// 无头浏览器验证：控制台错误、求解渲染、交互、响应式与主题截图
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const fs = require('node:fs');

const BASE = 'http://127.0.0.1:8917/index.html';
const OUT = '/tmp/terrain-shots';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 1) 初始 ridge 求解结果
  const validity = await page.textContent('#validity');
  const stats = await page.textContent('#stats');
  console.log('validity:', validity.trim());
  console.log('stats:', stats.replace(/\s+/g, ' ').trim().slice(0, 200));
  const canvasCount = await page.locator('#viewport canvas').count();
  console.log('canvas 数量:', canvasCount);

  // 2) 切换样例
  for (const s of ['flat.json', 'peak.json', 'capacity.json']) {
    await page.click(`button[data-sample="${s}"]`);
    await page.waitForTimeout(500);
    const v = await page.textContent('#validity');
    const st = await page.textContent('#stats');
    console.log(`样例 ${s}:`, v.includes('合法') ? '合法' : v.trim(), '|',
      st.replace(/\s+/g, ' ').trim().slice(0, 90));
  }
  await page.click('button[data-sample="ridge.json"]');
  await page.waitForTimeout(500);

  // 3) 像素误差滑块
  await page.fill('#pixelError', '12');
  await page.dispatchEvent('#pixelError', 'input');
  await page.waitForTimeout(400);
  console.log('pe=12 后:', (await page.textContent('#stats')).replace(/\s+/g, ' ').trim().slice(0, 80));
  await page.fill('#pixelError', '1');
  await page.dispatchEvent('#pixelError', 'input');
  await page.waitForTimeout(400);
  console.log('pe=1 后:', (await page.textContent('#stats')).replace(/\s+/g, ' ').trim().slice(0, 80));
  await page.fill('#pixelError', '4');
  await page.dispatchEvent('#pixelError', 'input');
  await page.waitForTimeout(400);

  // 4) 显示开关
  await page.uncheck('#togWire');
  await page.uncheck('#togLevel');
  await page.uncheck('#togSeam');
  await page.waitForTimeout(300);
  await page.check('#togWire'); await page.check('#togLevel'); await page.check('#togSeam');

  // 5) 相机手动输入触发重算
  await page.fill('#camX', '10');
  await page.dispatchEvent('#camX', 'input');
  await page.waitForTimeout(400);
  console.log('移动相机后 validity:', (await page.textContent('#validity')).trim().slice(0, 60));

  // 6) 点选块（点击视口中心）
  const box = await page.locator('#viewport').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(400);
  const info = await page.textContent('#blockInfo');
  console.log('点选块信息含 E/D:', info.includes('块误差 E') && info.includes('距离 D'),
    '|', info.replace(/\s+/g, ' ').trim().slice(0, 140));

  // 7) 导出按钮不报错
  page.on('dialog', (d) => { errors.push('意外弹窗: ' + d.message()); d.dismiss(); });
  await page.click('#exportObj');
  await page.click('#exportJson');
  await page.waitForTimeout(300);

  await page.screenshot({ path: `${OUT}/desktop-light.png` });

  // 8) 深色主题
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/desktop-dark.png` });

  // 9) 手机宽度
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('手机宽度横向溢出:', overflowX);
  await page.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });

  console.log('\n=== 控制台/页面错误 ===');
  console.log(errors.length ? errors.join('\n') : '无错误');
  await browser.close();
  fs.writeFileSync('/tmp/terrain-shots/errors.txt', errors.join('\n'));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
