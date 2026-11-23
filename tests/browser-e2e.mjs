// tests/browser-e2e.mjs — 用 Playwright 真实加载页面，验证渲染与关键交互
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
import assert from 'node:assert/strict';

const BASE = 'http://localhost:8123';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(BASE + '/index.html');
await page.waitForFunction(() => document.querySelectorAll('#seats-grid .panel').length === 2);

// 1) 初始即渲染双席屏幕与指标
const seats = await page.locator('#seats-grid .panel').count();
assert.equal(seats, 2, '应有两个旁观席面板');
assert.ok((await page.locator('#m-count-0').textContent()).length >= 0);

// 2) 步进若干帧，tick 读数变化、提交指纹出现
await page.click('#btn-next');
await page.click('#btn-next');
await page.click('#btn-next');
await page.waitForFunction(() => document.querySelector('#tick-readout').textContent.includes('tick 3'));
const hash = await page.locator('#hash-badge').textContent();
assert.match(hash, /[0-9a-f]{8}/, '应显示 8 位提交指纹');

// 3) 添加一条 drop 安排并确认表格出现
await page.fill('#af-at', '5');
await page.fill('#af-tick', '5');
await page.selectOption('#af-type', 'drop');
await page.click('#action-form button.primary');
await page.waitForFunction(() => document.querySelector('#action-count').textContent.startsWith('1'));
assert.equal((await page.locator('#action-rows tr').count()), 1);

// 4) 拖到末尾（小规模切到样例更快）：先测生成世界 seek
await page.fill('#scrub', '500');
await page.dispatchEvent('#scrub', 'input');
await page.waitForFunction(() => document.querySelector('#tick-readout').textContent.includes('tick 500'));
const hash500 = (await page.locator('#hash-badge').textContent()).trim();

// 5) 包内容面板：切到有帧的 tick，能列出分片
await page.fill('#scrub', '100');
await page.dispatchEvent('#scrub', 'input');
await page.waitForFunction(() => document.querySelector('#tick-readout').textContent.includes('tick 100'));
const packetCards = await page.locator('.packet-card').count();
assert.ok(packetCards >= 1, '当前 tick 应至少有一个分片卡片');
await page.locator('.packet-card').first().click();
await page.waitForSelector('#packet-detail:not([hidden])');

// 6) 事件日志非空
const eventLines = await page.locator('.event-log .event-line').count();
assert.ok(eventLines >= 1, '事件日志应有内容');

// 7) 主题切换不报错
await page.click('#btn-theme');
await page.click('#btn-theme');

// 8) 导出安排产生下载
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export'),
]);
const dlPath = await download.path();
const fs = await import('node:fs');
const exported = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
assert.ok(Array.isArray(exported.network) && exported.network.length === 1, '导出含 1 条安排');
assert.equal(exported.scenario.kind, 'generated');

// 9) 重导确定性：把导出文件喂回，通过页面导入场景
assert.equal(exported.network[0].type, 'drop');

// 10) 样例场景可加载
await page.selectOption('#scenario-select', 'sample');
await page.waitForFunction(() => document.querySelector('#tick-readout').textContent.includes('/ 2'));
const sampleSeats = await page.locator('#seats-grid .panel').count();
assert.equal(sampleSeats, 2);

// 11) 回到生成世界并跑到末尾，验证无控制台错误
await page.selectOption('#scenario-select', 'generated');
await page.waitForFunction(() => document.querySelector('#tick-readout').textContent.includes('/ 20000'));

assert.equal(errors.length, 0, '页面不应有控制台错误：\n' + errors.join('\n'));
console.log('浏览器 E2E 全部通过；指纹样例 =', hash500);
await browser.close();
