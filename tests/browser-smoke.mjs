// 浏览器端冒烟测试：真实加载 index.html，验证 Worker 推演、点击选/禁、撤回、导出、基准测速。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file://' + join(root, 'index.html');
const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(url);
await page.waitForFunction(() => document.querySelectorAll('.hero-card').length > 0, { timeout: 8000 });

// 1) 首手精确值徽标出现（示例包 2 个英雄、A 先选）
await page.waitForFunction(() => {
  const badges = [...document.querySelectorAll('.value-badge')];
  return badges.length === 2 && badges.every(b => !b.textContent.includes('推演中'));
}, { timeout: 8000 });
const badges = await page.$$eval('.value-badge', els => els.map(e => e.textContent));
console.log('首手值徽标:', JSON.stringify(badges));

// 2) 推演表有两行且含最优续手
const rowCount = await page.$$eval('table.moves tbody tr', r => r.length);
console.log('推演表行数:', rowCount);
if (rowCount !== 2) throw new Error('推演表应有 2 个合法首手');

// 3) 点第一个英雄卡片（A 选入），回合推进
await page.click('.hero-card:not(:disabled)');
await page.waitForTimeout(200);
const histAfter1 = await page.$$eval('.hist-chip', c => c.length);
console.log('落子后历史芯片数:', histAfter1);
if (histAfter1 !== 1) throw new Error('点击后应产生 1 条历史');

// 4) 撤一手
await page.click('#btn-undo');
await page.waitForTimeout(200);
const histAfterUndo = await page.$$eval('.hist-chip', c => c.length);
console.log('撤回后历史芯片数:', histAfterUndo);
if (histAfterUndo !== 0) throw new Error('撤回后历史应为空');

// 5) 导出序列（先展开折叠的数据包区域）
await page.$eval('details.pkg', d => { d.open = true; });
await page.click('#btn-export');
const exportText = await page.inputValue('#export-box');
const doc = JSON.parse(exportText);
if (doc.format !== 'draft-endgame-replay-v1') throw new Error('导出格式错误');
if (!Array.isArray(doc.rootValues) || doc.rootValues.length !== 2) throw new Error('导出应含 2 个首手快照');
console.log('导出首手快照数:', doc.rootValues.length, '格式:', doc.format);

// 6) 导回核验：把导出文本贴回导入框并核验
await page.fill('#import-box', exportText);
await page.click('#btn-import');
await page.waitForSelector('#verify-result:not([hidden])', { timeout: 5000 });
const verifyText = await page.textContent('#verify-result');
console.log('核验结果:', verifyText.split('\n')[0]);
if (!verifyText.includes('核验通过')) throw new Error('导回核验应通过');

// 7) 基准测速
await page.click('#pkg-bench');
await page.waitForFunction(() => {
  const el = document.querySelector('#bm-result');
  return el && !el.hidden && (el.textContent.includes('达标') || el.textContent.includes('未达标'));
}, { timeout: 20000 });
const bm = await page.textContent('#bm-result');
console.log('基准测速:\n' + bm);
if (!bm.includes('达标 ≤ 8s')) throw new Error('基准应在 8 秒内达标');

// 8) 主题切换不报错
await page.click('#theme-btn');
await page.waitForTimeout(100);

if (errors.length) {
  console.error('页面错误:', errors);
  process.exitCode = 1;
} else {
  console.log('\n全部浏览器冒烟检查通过，无 console/page 错误');
}
await browser.close();
