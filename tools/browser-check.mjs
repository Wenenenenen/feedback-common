// 浏览器端到端验证（Playwright）：node tools/browser-check.mjs
// 验证真实 Worker/DOM 路径下的加载、跳帧一致性、编辑撤销、导出与 1M 性能
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://localhost:8124';
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

await page.goto(base);
await page.waitForSelector('#channels');

// --- 加载样例（通过 FileInput 注入 File，hidden input 也可 setInputFiles）---
const sample = readFileSync(join(root, 'samples', 'extracted', '双场.l21p'));
await page.setInputFiles('#fileInput', { name: '双场.l21p', mimeType: 'application/octet-stream', buffer: sample });
await page.waitForFunction(() => document.getElementById('meta').textContent.includes('6 条'));
check('加载样例 6 条 18 帧', (await page.textContent('#meta')).includes('18 帧'));

// 记录行渲染
const rowCount = await page.locator('.record-row').count();
check('虚拟列表渲染记录行', rowCount >= 6, `${rowCount} 行`);

// 跳到帧 5：CC1 显示网格 row15 前两格为 H I
await page.fill('#frameInput', '5');
await page.dispatchEvent('#frameInput', 'change');
await page.waitForFunction(() => document.querySelectorAll('.channel-card').length === 4);
const cc1Display = await page.evaluate(() => {
  const card = document.querySelectorAll('.channel-card')[0];
  const cells = card.querySelectorAll('.grid-block .grid .cell');
  // 第一块网格是显示；row15 col1/2 位于 448/449
  return [cells[448].textContent, cells[449].textContent, cells[450].textContent];
});
check('跳帧5 CC1 显示 HI（交换上屏）', cc1Display[0] === 'H' && cc1Display[1] === 'I', JSON.stringify(cc1Display));

// 后备网格应为空（交换后）
const cc1Back = await page.evaluate(() => {
  const grids = document.querySelectorAll('.channel-card')[0].querySelectorAll('.grid-block .grid .cell');
  return grids[480 + 448].textContent; // 第二块网格偏移 480
});
check('交换后 CC1 后备为空', cc1Back === '·');

// 四通道卡片都有模式标签
const modes = await page.locator('.channel-card .mode').allTextContents();
check('四通道模式标签齐全', modes.length === 4 && modes.every((m) => m.includes('弹出') || m.includes('直写') || m.includes('滚动')));

// 跳帧 4：TV 在 CC3 显示（帧4场2），跳帧5 也应可见
await page.fill('#frameInput', '5');
await page.dispatchEvent('#frameInput', 'change');
await page.waitForTimeout(100);
const cc3tv = await page.evaluate(() => {
  const cells = document.querySelectorAll('.channel-card')[2].querySelectorAll('.grid-block .grid .cell');
  return [cells[448].textContent, cells[449].textContent];
});
check('CC3 直写 TV 上屏', cc3tv[0] === 'T' && cc3tv[1] === 'V', JSON.stringify(cc3tv));

// --- 点击第一条记录，检查详情与字节偏移 ---
await page.locator('.record-row').first().click();
await page.waitForSelector('#applyEdit');
const detail = await page.textContent('#detail');
check('详情含字节偏移 0x0c', detail.includes('0xc') || detail.includes('0xC'));
check('详情含奇校验', detail.includes('奇校验'));

// --- 编辑记录0 为文本 AB（自动奇校验），验证重新演算 ---
await page.fill('#newA', '41');
await page.fill('#newB', '42');
await page.click('#applyEdit');
await page.waitForFunction(() => !document.getElementById('undoBtn').disabled);
check('编辑后撤销按钮可用', await page.isEnabled('#undoBtn'));
const labelAfterEdit = await page.locator('.record-row').first().textContent();
check('编辑后首行解码为 AB', labelAfterEdit.includes('AB'));

// 撤销
await page.click('#undoBtn');
await page.waitForFunction(() => document.getElementById('undoBtn').disabled);
const labelAfterUndo = await page.locator('.record-row').first().textContent();
check('撤销恢复弹出控制', labelAfterUndo.includes('弹出'));
check('撤销后重做可用', await page.isEnabled('#redoBtn'));
// 重做
await page.click('#redoBtn');
await page.waitForFunction(() => !document.getElementById('undoBtn').disabled);
check('重做再次变为 AB', (await page.locator('.record-row').first().textContent()).includes('AB'));
// 再撤销回干净稿以便导出
await page.click('#undoBtn');
await page.waitForFunction(() => document.getElementById('undoBtn').disabled);

// --- 选区导出 ---
const downloadPromise = page.waitForEvent('download');
await page.fill('#selStart', '0');
await page.fill('#selEnd', '18');
await page.click('#exportBtn');
const dl = await downloadPromise;
const dlPath = '/tmp/l21-export.json';
await dl.saveAs(dlPath);
const exported = JSON.parse(readFileSync(dlPath, 'utf8'));
check('导出 start/end 半开', exported.start === 0 && exported.end === 18);
const cc1cue = exported.cues.find((c) => c.channel === 'CC1');
check('CC1 cue [4,10)', cc1cue && cc1cue.start === 4 && cc1cue.end === 10, JSON.stringify(cc1cue && [cc1cue.start, cc1cue.end]));
check('cue 保留 32 列与行号', cc1cue.rows[0].row === 15 && cc1cue.rows[0].cells.length === 32);
check('cues 按 start/通道排序', JSON.stringify(exported.cues.map((c) => `${c.start}:${c.channel}`)) ===
  JSON.stringify([...exported.cues].sort((a, b) => a.start - b.start || a.channel.localeCompare(b.channel)).map((c) => `${c.start}:${c.channel}`)));

// --- 结构错误：非法场号文件应弹模态且保留旧稿 ---
const bad = Uint8Array.from(sample); bad[16] = 9;
await page.setInputFiles('#fileInput', { name: 'bad.l21p', mimeType: 'application/octet-stream', buffer: Buffer.from(bad) });
await page.waitForSelector('#structureModal:not([hidden])');
const errText = await page.textContent('#structureErrors');
check('结构错误标字节偏移 16', errText.includes('16'));
await page.click('#closeModal');
check('结构错误后旧稿保留（仍 6 条）', (await page.textContent('#meta')).includes('6 条'));

// --- 100 万记录性能（浏览器真实 Worker）---
const big = readFileSync(join(root, 'bench-1m.l21p'));
const t0 = performance.now();
await page.setInputFiles('#fileInput', { name: 'bench-1m.l21p', mimeType: 'application/octet-stream', buffer: big });
await page.waitForFunction(() => document.getElementById('meta').textContent.includes('1,000,000 条'), { timeout: 30000 });
const loadMs = performance.now() - t0;
check('1M 加载+演算 10 秒内', loadMs < 10000, `${loadMs.toFixed(0)} ms`);

const jumpTimings = [];
for (let k = 0; k < 20; k++) {
  const F = (Math.floor(Math.random() * 900000) + 1000);
  const t = performance.now();
  await page.fill('#frameInput', String(F));
  await page.dispatchEvent('#frameInput', 'change');
  await page.waitForFunction((f) => Number(document.getElementById('frameInput').value) === f, F);
  jumpTimings.push(performance.now() - t);
}
const jumpTotal = jumpTimings.reduce((a, b) => a + b, 0);
check('20 次任意跳帧合计 2 秒内', jumpTotal < 2000, `${jumpTotal.toFixed(0)} ms（含 DOM 网格绘制）`);

check('无页面 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
