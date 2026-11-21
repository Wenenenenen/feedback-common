/* 端到端冒烟测试：无头浏览器加载页面，验证核心交互 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, '..', 'site', 'index.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(url);
await page.waitForFunction(() => document.querySelectorAll('#timeline .beat-cell').length === 3);

// 1. 首帧：样例已自动求解，状态条显示总成本 4，时间轴三个镜头 A B C
const status = await page.textContent('#statusPill');
assert.match(status, /总成本 4/);
const names = await page.$$eval('#timeline .shot-name', els => els.map(e => e.textContent));
assert.deepEqual(names, ['A', 'B', 'C']);

// 2. 汇总瓦片
const tiles = await page.$$eval('#summaryTiles .value', els => els.map(e => e.textContent));
assert.equal(tiles[0], '3');       // 总拍数
assert.equal(tiles[1], '4');       // 总成本
assert.equal(tiles[3], '2（硬切 0 次）'); // 切换代价（两次跟拍各 1，0 硬切）

// 3. 明细表三行，累计成本 0 / 3 / 4
const cumulative = await page.$$eval('#detailBody td:nth-child(7)', els => els.map(e => e.textContent));
assert.deepEqual(cumulative, ['0', '3', '4']);

// 4. 锁镜：点第二拍时间轴格，再点镜头 A 的芯片
await page.click('#timeline .beat-cell:nth-child(2)');
await page.waitForFunction(() => document.querySelector('#beatReadout').textContent.startsWith('拍 2'));
await page.click('#beatShotChips .shot-chip:nth-child(1)'); // A
await page.waitForFunction(() => /总成本 5/.test(document.querySelector('#statusPill').textContent));
const names2 = await page.$$eval('#timeline .shot-name', els => els.map(e => e.textContent));
assert.deepEqual(names2, ['A', 'A', 'C']);
// 硬切标记出现在第 3 拍
const cutMark = await page.textContent('#timeline .beat-cell:nth-child(3) .mark.cut');
assert.equal(cutMark, '切');

// 5. 清除锁定恢复 A B C
await page.click('#clearLocksBtn');
await page.waitForFunction(() => /总成本 4/.test(document.querySelector('#statusPill').textContent));

// 6. 失败用例
await page.click('#loadFailBtn');
await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('fail'));
const failStatus = await page.textContent('#statusPill');
assert.match(failStatus, /第 3 拍无法排镜/);
const banner = await page.textContent('#failureBanner');
assert.match(banner, /第 3 拍排不下去/);
assert.match(banner, /cutGap = 2/);
// 失败拍时间轴格高亮
const impossible = await page.$('#timeline .beat-cell.impossible');
assert.ok(impossible, '第 3 拍应有 impossible 样式');
// 导出按钮在失败时给出提示弹窗
await page.click('#exportBtn');
const modalText = await page.textContent('.modal');
assert.match(modalText, /不存在完整镜头单/);
await page.click('#modalClose2');

// 7. 导出弹窗（回到成功样例）
await page.click('#loadSampleBtn');
await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('ok'));
await page.click('#exportBtn');
await page.waitForSelector('.modal pre');
const csv1 = await page.textContent('#pre-csv1');
assert.match(csv1, /拍号\(1基\)/);
assert.match(csv1, /2,1,B,跟拍,A/);
const csv2 = await page.textContent('#pre-costCsv'.replace('costCsv', 'csv2'));
assert.match(csv2, /累计成本/);
const jsonText = await page.textContent('#pre-json');
const exported = JSON.parse(jsonText);
assert.equal(exported.status, 'solved');
assert.equal(exported.totalCost, 4);
assert.deepEqual(exported.cutBeatNumbers, []);
assert.equal(exported.shots[1].shot, 'B');
await page.click('#modalClose2');

// 8. 播放：点播放后读拍号推进
await page.click('#playBtn');
await page.waitForFunction(() => document.querySelector('#beatReadout').textContent.startsWith('拍 2'), { timeout: 3000 });
await page.click('#playBtn');

// 9. 改 inset 参数立即重算：inset 调到 4，第一拍所有镜头安全框都收得放不下必拍目标 -> 失败
await page.fill('#insetInput', '4');
await page.dispatchEvent('#insetInput', 'change');
await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('fail'));
const fail2 = await page.textContent('#statusPill');
assert.match(fail2, /第 1 拍无法排镜/);
// 还原
await page.fill('#insetInput', '1');
await page.dispatchEvent('#insetInput', 'change');
await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('ok'));

// 10. 场地 SVG 包含安全框与目标
const svgRects = await page.$$eval('#fieldSvg rect', els => els.length);
assert.ok(svgRects >= 5, 'SVG 至少包含场地、3 个镜头、安全框与目标矩形');

assert.equal(errors.length, 0, '控制台错误: ' + errors.join(' | '));
await browser.close();
console.log('ALL E2E CHECKS PASSED');
