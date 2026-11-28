// tools/smoke-browser.mjs —— 无头浏览器端到端冒烟测试
// 直接引用全局 Playwright（本机已全局安装）。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8923/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#stats').textContent.length > 0, { timeout: 5000 });

const nums = await page.locator('.stat-num').allInnerTexts();
console.log('统计数字 [线条,线段,交点,锁定,矛盾]:', nums.slice(0, 5));
if (!nums.slice(0, 3).every((v) => Number(v) > 0)) throw new Error('统计未填充');

// 1. 画布确实绘制了内容
const canvas = page.locator('#canvas');
const hasPixels = await canvas.evaluate((c) => {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonBg = 0;
  for (let i = 3; i < d.length; i += 4 * 200) if (d[i] > 0) nonBg++;
  return nonBg > 10;
});
console.log('画布有绘制内容:', hasPixels);
if (!hasPixels) throw new Error('画布空白');

// 2. 通过视图句柄精确点击样例交点 (3,4)
const pos = await page.evaluate(() => {
  const v = window.__view;
  const c = v.model.crossingMap.get('3,4');
  const [sx, sy] = v.toScreen(c.x, c.y);
  return { x: sx, y: sy };
});
await canvas.click({ position: { x: pos.x, y: pos.y } });
await page.waitForSelector('#inspector:not([hidden])');
const inspTitle = await page.locator('#inspector h2').innerText();
console.log('选中交点面板:', inspTitle);
if (!inspTitle.includes('3, 4')) throw new Error('交点追查面板未打开');

// 3. 锁定/解除往返：样例该点已锁线1，改锁线2 应替换上层（锁定总数不变）
const layerBadge = () => page.locator('#inspector .layer-badge').first().innerText();
console.log('初始上层徽标:', await layerBadge());
await page.locator('#inspector [data-pin="2"]').click();
await page.waitForTimeout(150);
const sub1 = await page.locator('#inspector .insp-sub').innerText();
if (!sub1.includes('锁定线 2')) throw new Error('改锁线2未生效: ' + sub1);
console.log('改锁线2生效:', sub1);
// 再点同一按钮解除
await page.locator('#inspector [data-pin="2"]').click();
await page.waitForTimeout(150);
const sub2 = await page.locator('#inspector .insp-sub').innerText();
if (!sub2.includes('未锁定')) throw new Error('解除锁定未生效: ' + sub2);
console.log('解除锁定生效，往返正常');

// 4. 状态条
const status = await page.locator('#status').innerText();
console.log('状态条:', status);

// 5. 导出 SVG
await page.locator('#btn-export').click();
await page.waitForSelector('#svg-fallback:not([hidden])');
const svgText = await page.locator('#svg-out').inputValue();
const pathCount = (svgText.match(/<path /g) || []).length;
console.log('导出 SVG 路径数:', pathCount, '字节:', svgText.length);
if (!svgText.startsWith('<?xml') || pathCount === 0) throw new Error('SVG 导出异常');

// 6. 主题切换不报错
await page.locator('#btn-theme').click();
await page.waitForTimeout(100);

if (errors.length) {
  console.error('控制台错误:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✓ 浏览器冒烟测试通过，无控制台错误');
await browser.close();
