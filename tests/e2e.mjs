// tests/e2e.mjs — Playwright 端到端（真实 Chromium，ES module + canvas）
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8747';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  ', msg); };

await page.goto(BASE + '/index.html');
await page.waitForFunction(() => document.querySelectorAll('#sourceList .source-row').length === 1, { timeout: 5000 });
ok(await page.textContent('#sourceList .source-name') === 'wave-edit-source.wav', '样例源轨自动载入');
await page.waitForFunction(() => document.querySelectorAll('#segBody tr').length === 3);
ok((await page.locator('#segBody tr').count()) === 3, '预置 3 段（正向/倒序/静音）');

// 区间聚合应与后端一致（总帧 48000，三段总长 24000+24000+2000=50000）
const meta = await page.textContent('#viewMeta');
ok(/总长 50,000 帧/.test(meta), '总长 50000 帧: ' + meta);
const sumsqText = await page.locator('#aggregate .sumsq').first().textContent();
ok(/^\d+$/.test(sumsqText.trim()), '平方和为精确十进制字符串: ' + sumsqText.trim().slice(0, 30) + '…');

// B 滑块切到 64，列数变化且空列规则不报错
await page.locator('#bRange').evaluate((el) => { el.value = '64'; el.dispatchEvent(new Event('input', { bubbles: true })); });
ok((await page.textContent('#bValue')) === '64', 'B 可调到 64');

// 单帧定位：点击波形中部
const box = await page.locator('#waveCanvas').boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForFunction(() => document.querySelector('#inspector .inspect-grid') !== null);
const insp = await page.textContent('#inspector');
ok(/源帧号/.test(insp) && /左声道值/.test(insp) && /右声道值/.test(insp), '单帧定位显示源位置与双声道值');

// 选择静音段（第 3 段）并验证标记
await page.locator('#segBody tr').nth(2).click();
ok((await page.locator('#segBody tr.sel').count()) === 1, '段表可选中段');

// 倒序切换：选第 2 段（倒序）→ 再切换变成正向，段数不变
await page.locator('#segBody tr').nth(1).click();
const beforeCount = await page.locator('#segBody tr').count();
await page.click('#btnReverse');
ok((await page.locator('#segBody tr').count()) === beforeCount, '倒序切换不改段数');

// 拆分：先点波形定位光标，再拆分，段数 +1
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
await page.click('#btnSplit');
ok((await page.locator('#segBody tr').count()) === 4, '拆分后段数 3→4（实际 ' + await page.locator('#segBody tr').count() + '）');

// 撤销：拆分应回退（4→3），再撤销倒序切换
await page.click('#btnUndo');
ok((await page.locator('#segBody tr').count()) === 3, '撤销拆分恢复 3 段');
// 重做可用
ok((await page.isEnabled('#btnRedo')), '撤销后重做按钮可用');
// 撤销后再编辑 → 重做栈清空
await page.locator('#segBody tr').first().click();
await page.click('#btnMute');
ok(await page.isDisabled('#btnRedo'), '撤销后新编辑清空重做栈');
ok((await page.locator('#segBody tr').count()) === 3, '静音切换不改段数');

// 导出弹窗
await page.click('#btnExport');
ok(await page.locator('#exportModal').isVisible(), '导出弹窗打开');
const json = await page.locator('#exportJson').inputValue();
const parsed = JSON.parse(json);
ok(parsed.format === 'waveform-edit-pyramid/1' && parsed.columns.B === 64, '导出 JSON 结构与 B=64');
ok(parsed.columns.list.length === 64, '导出 64 列');
ok(typeof parsed.columns.list[0].left.sumSq === 'string', '导出列平方和为字符串');
ok(Array.isArray(parsed.segments) && parsed.segments.length === 3, '导出含 3 段清单');
const csv = await page.locator('#exportCsv').inputValue();
ok(csv.startsWith('column,startFrame,endFrame,frameCount,leftMin'), 'CSV 表头正确');
ok(csv.trim().split('\n').length === 65, 'CSV 64 行数据 + 表头');
await page.click('#closeExport');

// 复制按钮不报错
await page.click('#btnExport');
await page.click('#copyJson');
await page.click('#copyCsv');
await page.click('#closeExport');

// 缩到整段
await page.click('#btnFullView');
const meta2 = await page.textContent('#viewMeta');
ok(/区间 0–50,000/.test(meta2), '缩到整段: ' + meta2);

// 明暗切换
await page.click('#themeToggle');
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '可切暗色');
await page.click('#themeToggle');
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', '可切亮色');

// 控制台无错误
ok(errors.length === 0, '浏览器控制台无错误（实际: ' + JSON.stringify(errors) + '）');

// 截图（桌面）
await page.setViewportSize({ width: 1366, height: 900 });
await page.screenshot({ path: '/tmp/app-desktop.png', fullPage: true });
// 手机宽度
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
const clientW = await page.evaluate(() => document.documentElement.clientWidth);
ok(scrollW <= clientW, '手机宽度无横向滚动（' + scrollW + ' <= ' + clientW + '）');
await page.screenshot({ path: '/tmp/app-mobile.png', fullPage: false });

await browser.close();
console.log('e2e done');
