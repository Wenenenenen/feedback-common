// 浏览器冒烟测试：真实页面上跑通运行/暂停/单步/回放/导出/取消旧任务。
// 运行：node tests/browser.smoke.mjs（需先在仓库根启动 http.server，端口 8731）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
import assert from 'node:assert/strict';

const BASE = 'http://localhost:8731/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE);
await page.waitForSelector('canvas');

// 1. 加载 backtrack 样例并运行至结束
await page.click('#btn-sample-backtrack');
await page.waitForTimeout(300);
await page.click('#btn-run');
await page.waitForFunction(() => {
  const b = document.querySelector('#status-badge').textContent;
  return ['已求解', '证明无解', '预算耗尽', '任务已取消'].includes(b);
}, { timeout: 15000 });
const backtrackStatus = await page.textContent('#status-badge');
assert.equal(backtrackStatus, '已求解');
const trials = await page.textContent('#stat-trials');
assert.ok(Number(trials) >= 2, `backtrack 应至少 2 次试选，实际 ${trials}`);

// 2. 轨迹中存在 backtrack 事件
const traceText = await page.textContent('#trace-log');
assert.match(traceText, /backtrack/);
assert.match(traceText, /trial/);

// 3. checker-odd 必须显示“证明无解”
await page.click('#btn-sample-odd');
await page.waitForTimeout(300);
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('#status-badge').textContent === '证明无解', { timeout: 15000 });

// 4. 单步：加载可解样例，逐事件推进
await page.click('#btn-sample-even');
await page.waitForTimeout(300);
const eventsBefore0 = Number(await page.textContent('#stat-events'));
await page.click('#btn-step');
const eventsAfter0 = Number(await page.textContent('#stat-events'));
assert.equal(eventsAfter0, eventsBefore0 + 1);

// 5. 改约束自动取消旧任务：长任务低速运行中改边界，确保任务仍在运行
await page.evaluate(() => {
  const labels = ['l0', 'l1', 'l2'];
  const tiles = [];
  for (let i = 0; i < 24; i++) {
    tiles.push({ id: `tile${i}`, weight: (i % 5) + 1,
      edges: [labels[i % 3], labels[(i + 1) % 3], labels[i % 3], labels[(i + 1) % 3]], color: '#888888' });
  }
  window.__wfc.setConfig({ width: 32, height: 32, wrap_x: true, wrap_y: false, seed: 42, budget: 200000, tiles, pins: [] });
  document.getElementById('run-speed').value = '0';
});
await page.click('#btn-run');
await page.waitForTimeout(200);
assert.equal(await page.textContent('#status-badge'), '运行中');
const eventsAtCancel = Number(await page.textContent('#stat-events'));
assert.ok(eventsAtCancel > 1);
await page.check('#cfg-wrap-y'); // check 本身触发 change，无需再手动派发
await page.waitForTimeout(200);
assert.equal(await page.textContent('#status-badge'), '任务已取消');
// 取消后状态保持取消，不会自行恢复运行
await page.waitForTimeout(300);
assert.equal(await page.textContent('#status-badge'), '任务已取消');
const frozenEvents = Number(await page.textContent('#stat-events'));
await page.waitForTimeout(200);
assert.equal(Number(await page.textContent('#stat-events')), frozenEvents);

// 6. 候选查看：切 inspect 模式，先运行可解任务，再点格子看候选
await page.click('#pin-mode-inspect');
await page.fill('#run-speed', '3'); // 高速，确保 32×32 在超时内跑完
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('#status-badge').textContent === '已求解', { timeout: 30000 });
const box = await page.locator('canvas').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(100);
const cellHead = await page.textContent('#cell-head');
assert.match(cellHead, /格 \(/);

// 7. 导出按钮均产生下载
const downloads = [];
page.on('download', (d) => downloads.push(d.suggestedFilename()));
for (const id of ['#btn-export-map', '#btn-export-png', '#btn-export-config', '#btn-export-trace']) {
  await page.click(id);
  await page.waitForTimeout(150);
}
assert.equal(downloads.length, 4, `应触发 4 次下载，实际 ${downloads.join(',')}`);

// 8. 小预算 backtrack 必须显示“预算耗尽”
await page.click('#btn-sample-backtrack');
await page.waitForTimeout(200);
await page.fill('#cfg-budget', '1');
await page.dispatchEvent('#cfg-budget', 'change');
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('#status-badge').textContent === '预算耗尽', { timeout: 15000 });

// 9. 暂停语义：32×32 多拼块 + 每帧 1 事件，求解足够慢，可在运行中暂停再单步
await page.evaluate(() => {
  const labels = ['l0', 'l1', 'l2'];
  const tiles = [];
  for (let i = 0; i < 24; i++) {
    tiles.push({ id: `tile${i}`, weight: (i % 5) + 1,
      edges: [labels[i % 3], labels[(i + 1) % 3], labels[i % 3], labels[(i + 1) % 3]], color: '#888888' });
  }
  window.__wfc.setConfig({ width: 32, height: 32, wrap_x: true, wrap_y: false, seed: 42, budget: 200000, tiles, pins: [] });
  document.getElementById('run-speed').value = '0';
});
await page.click('#btn-run');
await page.waitForTimeout(250);
await page.click('#btn-pause');
await page.waitForTimeout(250);
const pausedBadge = await page.textContent('#status-badge');
assert.equal(pausedBadge, '已暂停');
const eventsBefore = Number(await page.textContent('#stat-events'));
assert.ok(eventsBefore > 0, '暂停时应已产生事件');
await page.click('#btn-step');
assert.equal(Number(await page.textContent('#stat-events')), eventsBefore + 1);
// 切回高速后继续运行至终态
await page.fill('#run-speed', '3');
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('#status-badge').textContent === '已求解', { timeout: 30000 });

// 10. 复算按钮在轨迹导入前禁用
assert.equal(await page.getAttribute('#btn-verify-replay', 'disabled'), '');

assert.equal(errors.length, 0, `页面报错：\n${errors.join('\n')}`);
console.log('浏览器冒烟测试全部通过，下载文件：', downloads.join(', '));
await browser.close();
