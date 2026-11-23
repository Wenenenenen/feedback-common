/* 端到端冒烟：无头浏览器加载页面，核对求解、选拍、编辑、播放、导出与重导核算。 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// 用静态服务器提供 site/ 与 samples/，模拟真实 HTTP 环境
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let file = path.join(root, urlPath === '/' ? 'site/index.html' : urlPath);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  // /samples/... 在仓库根；/site/... 在 site
  if (urlPath === '/' ) file = path.join(root, 'site/index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/site/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(base);

// 1) 首屏自动载入样例并求解：状态条出现“最优 3”
await page.waitForFunction(() => /最优/.test(document.getElementById('statusText').textContent), { timeout: 8000 });
const status1 = await page.textContent('#statusText');
assert.match(status1, /最优 3/);
console.log('样例求解状态:', status1);

// 2) 时间轴 2 拍，明细表 2 行，选中样本 1 / 2
const ticks = await page.$$eval('#timeline .tick-cell', els => els.length);
assert.equal(ticks, 2);
const sampleCells = await page.$$eval('#detailBody tr td:nth-child(2)', els => els.map(e => e.textContent));
assert.deepEqual(sampleCells, ['1', '2']);
const cumulative = await page.$$eval('#detailBody tr td:nth-child(9)', els => els.map(e => e.textContent));
assert.deepEqual(cumulative, ['1', '3']);
console.log('明细样本:', sampleCells, '累计:', cumulative);

// 3) 场地脚印：选中拍 2 后左右脚印存在
await page.click('#timeline .tick-cell:nth-child(2)');
await page.waitForFunction(() => document.getElementById('playReadout').textContent.includes('拍 2'));
const soles = await page.$$eval('#fieldSvg .sole', els => els.length);
assert.ok(soles >= 2, '场地应画出脚印');
const jumpBadge = await page.textContent('#detailBody tr:nth-child(2) td:nth-child(4)');
assert.match(jumpBadge, /边·冷0/, '样例最优走普通边 1->2');
console.log('场地脚印块:', soles);

// 4) 候选列表：拍 2 有 2 个候选
const candRows = await page.$$eval('#candList tbody tr', r => r.length);
assert.equal(candRows, 2);

// 5) 编辑根位置，令旧路径失效：把拍 2 根改到 (5,0)，样本2 左脚世界落点变化 -> 只能走 3
//    先记录当前选中脚印的屏幕位置，编辑后未重解时脚印应随根实时平移
const beforeSoles = await page.$$eval('#fieldSvg .sole', els => els.map(e => ({ x: +e.getAttribute('x'), y: +e.getAttribute('y') })));
await page.fill('#rootX', '5');
await page.dispatchEvent('#rootX', 'change');
await page.waitForFunction(() => !document.getElementById('failureBanner').hidden);
const dirtyText = await page.textContent('#failureBanner');
assert.match(dirtyText, /重新求解/);
const afterSoles = await page.$$eval('#fieldSvg .sole', els => els.map(e => ({ x: +e.getAttribute('x'), y: +e.getAttribute('y') })));
assert.notDeepEqual(beforeSoles, afterSoles, '编辑根后未重解时脚印也应实时移动');
await page.click('#solveBtn');
await page.waitForFunction(() => /最优/.test(document.getElementById('statusText').textContent) && !document.getElementById('statusText').textContent.includes('求解中'), { timeout: 8000 });
const sampleAfter = await page.$$eval('#detailBody tr td:nth-child(2)', els => els.map(e => e.textContent));
assert.deepEqual(sampleAfter, ['1', '3']);
console.log('编辑后样本:', sampleAfter);

// 6) 撤销编辑 + 重解 -> 回到 1,2
await page.click('#resetTrackBtn');
await page.click('#solveBtn');
await page.waitForFunction(() => {
  const tds = [...document.querySelectorAll('#detailBody tr td:nth-child(2)')].map(e => e.textContent);
  return tds.length === 2 && tds[1] === '2';
}, { timeout: 8000 });

// 7) 播放推进当前拍
await page.click('#timeline .tick-cell:nth-child(1)');
await page.click('#playBtn');
await page.waitForFunction(() => document.getElementById('playReadout').textContent.includes('拍 2'), { timeout: 5000 });
await page.click('#playBtn'); // 暂停

// 8) 导出 → 重导核算
await page.click('#exportBtn');
const exportText = await page.inputValue('#exportBox');
const doc = JSON.parse(exportText);
assert.equal(doc.format, 'footlock-lattice-replay-v1');
assert.equal(doc.totalCost, '3');
assert.deepEqual(doc.sequenceIds, [1, 2]);
assert.equal(doc.ticks.length, 2);
await page.click('#importBtn');
await page.waitForFunction(() => !document.getElementById('verifyResult').hidden, { timeout: 8000 });
const verifyText = await page.textContent('#verifyResult');
assert.match(verifyText, /重导核算通过/);
console.log('重导核算:', verifyText.slice(0, 80));

// 9) 篡改导出总价后应核算失败
const badDoc = JSON.parse(exportText);
badDoc.totalCost = '4';
await page.fill('#exportBox', JSON.stringify(badDoc));
await page.click('#importBtn');
await page.waitForFunction(() => /未通过/.test(document.getElementById('verifyResult').textContent), { timeout: 6000 });

// 10) 满额基准：容量 240 拍 / 4096 样本 / 60000 边可求解且尾段完整
await page.click('#loadLargeBtn');
await page.waitForFunction(() => {
  const t = document.getElementById('statusText').textContent;
  return (/最优|无解/.test(t)) && !t.includes('求解中') && !t.includes('生成');
}, { timeout: 60000 });
const bigStatus = await page.textContent('#statusText');
console.log('满额基准状态:', bigStatus);
const bigTicks = await page.$$eval('#timeline .tick-cell', els => els.length);
assert.equal(bigTicks, 240);
const summary = await page.$$eval('#summaryTiles .tile .v', els => els.map(e => e.textContent));
assert.ok(summary.includes('4096 / 60000'), '应显示 4096 样本 / 60000 边, 实际: ' + JSON.stringify(summary));
const bigDetailRows = await page.$$eval('#detailBody tr', els => els.length);
assert.ok(/最优/.test(bigStatus), '满额基准应有解，实际状态: ' + bigStatus);
assert.equal(bigDetailRows, 240, '满额结果应覆盖全部 240 拍');
const lastDetail = await page.$$eval('#detailBody tr:last-child td', els => els.map(e => e.textContent));
console.log('满额瓦片:', summary.join(' | '));
console.log('满额末拍:', lastDetail.join(' / '));

if (errors.length) {
  console.error('页面错误:', errors);
  process.exitCode = 1;
} else {
  console.log('\n全部浏览器冒烟检查通过，无 console/page 错误');
}

await browser.close();
server.close();
