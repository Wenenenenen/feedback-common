/*
 * 浏览器端冒烟测试（Playwright）：
 * 加载 index.html -> 载入样例 -> 三模式切换 -> 点像素检查器 ->
 * 手动射线 -> 下载 JSON/PNG。运行：node scripts/browser-smoke.mjs
 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto('file://' + path.join(root, 'index.html'));
await page.waitForFunction(() => document.getElementById('engineState').textContent !== '未加载', { timeout: 5000 });
console.log('✓ 页面加载并自动载入样例：', await page.locator('#engineState').textContent());

// 三种模式
for (const mode of ['depth', 'normal', 'lit']) {
  await page.click(`button[data-mode="${mode}"]`);
  await page.waitForTimeout(60);
  const on = await page.locator(`button[data-mode="${mode}"]`).getAttribute('class');
  if (!on.includes('on')) throw new Error(mode + ' 模式未激活');
}
console.log('✓ 深度/法线/受光三模式切换');

// 统计行
const meta = await page.locator('#stageMeta').innerText();
if (!/命中 \d+\/6144/.test(meta)) throw new Error('命中统计异常: ' + meta);
console.log('✓ 统计行：', meta.replace(/\n/g, ' '));

// 点画布中心像素 -> 检查器出现逐格内容
const box = await page.locator('#view').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForSelector('#inspectBody details');
// 「逐格展开」默认折叠，先展开外层，再展开其中第一个格的子 details，
// 才能读到该格二次方程的判别式与根记录
await page.locator('#inspectBody details summary', { hasText: '逐格展开' }).click();
await page.locator('#inspectBody details details summary').first().click();
const inspectText = await page.locator('#inspectBody').innerText();
for (const needle of ['射线参数', '逐格展开', '判别式']) {
  if (!inspectText.includes(needle)) throw new Error('检查器缺少：' + needle);
}
console.log('✓ 像素点击展开格/根/判别式');

// 手动射线（用样例 saddle 第一条：双穿）
await page.fill('#rayOx', '0'); await page.fill('#rayOy', '0'); await page.fill('#rayOz', '0.75');
await page.fill('#rayDx', '2'); await page.fill('#rayDy', '1'); await page.fill('#rayDz', '0');
await page.fill('#rayT0', '0'); await page.fill('#rayT1', '1');
await page.click('#btnTrace');
await page.waitForFunction(() => /命中 t=0\.25/.test(document.getElementById('status').textContent));
const manual = await page.locator('#inspectBody').innerText();
if (!manual.includes('全部命中（2 次')) throw new Error('格内双穿未在检查器体现');
console.log('✓ 手动射线格内双穿，首根 t=0.25');

// 切触射线
await page.fill('#rayOz', '1');
await page.click('#btnTrace');
await page.waitForFunction(() => /切触/.test(document.getElementById('status').textContent));
console.log('✓ 切触射线计入命中：', (await page.locator('#status').textContent()).trim());

// 下载 JSON
const [jsonDlg] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownloadJson'),
]);
const jsonPath = path.join(root, '.cache-smoke', jsonDlg.suggestedFilename());
await jsonDlg.saveAs(jsonPath);
const hits = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(jsonPath, 'utf8')));
if (!Array.isArray(hits.pixels) || hits.pixels.length !== 6144 || hits.size[0] !== 96) throw new Error('JSON 像素数不符');
if (!hits.pixels.some((p) => p.hit)) throw new Error('JSON 无命中记录');
console.log('✓ 下载命中 JSON：', jsonDlg.suggestedFilename(), hits.pixels.length, '像素',
  'stats=', JSON.stringify(hits.stats.hits) + '命中');

// 下载 PNG
const [pngDlg] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownloadPng'),
]);
const pngPath = path.join(root, '.cache-smoke', pngDlg.suggestedFilename());
await pngDlg.saveAs(pngPath);
const { size } = await import('node:fs/promises').then((fs) => fs.stat(pngPath));
if (size < 1000) throw new Error('PNG 体积异常');
console.log('✓ 下载预览图 PNG：', pngDlg.suggestedFilename(), size, '字节');

// 非法间距应报错且不崩
await page.fill('#inSx', '-1');
await page.click('#btnApplyField');
await page.waitForFunction(() => document.getElementById('status').className.includes('err'));
console.log('✓ 非法 spacing 被拒绝：', (await page.locator('#status').textContent()).trim().slice(0, 40));

if (errors.length) {
  console.error('浏览器错误：\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\n全部浏览器冒烟通过，无控制台错误。');
}
await browser.close();
