/* 端到端冒烟测试：NODE_PATH=$(npm root -g) node tests/ui.smoke.mjs */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');
const shots = path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });

/* 极简静态服务器 */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(webDir, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(webDir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8931, r));

const browser = await chromium.launch();
const errors = [];
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  if (!cond) errors.push(name + (extra ? ' — ' + extra : ''));
}

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8931/index.html');
  await page.waitForSelector('.q-node', { timeout: 8000 });
  return { ctx, page };
}

/* ---------- 1. 初始装载：branch 样例终态 ---------- */
{
  const { ctx, page } = await newPage();
  await page.waitForTimeout(300);
  check('渲染 5 个任务节点', await page.locator('.q-node').count() === 5);
  check('游标 6/6', (await page.locator('#cursorNow').textContent()) === '6');
  check('余额 gold=10', (await page.locator('#balanceBar').textContent()).includes('10'));
  const rightMeta = await page.locator('.q-node[data-quest="right"] text.q-meta').textContent();
  check('right 节点显示失效', rightMeta.includes('失效'), rightMeta);
  const claimedMeta = await page.locator('.q-node[data-quest="left"] text.q-meta').textContent();
  check('left 节点显示已领取', claimedMeta.includes('已领取'), claimedMeta);
  check('日志有 6 行', await page.locator('.log-row').count() >= 6);
  const rejected = await page.locator('.log-row.st-rejected').count();
  const ignored = await page.locator('.log-row.st-ignored').count();
  check('无拒绝行', rejected === 0, 'rejected=' + rejected);
  check('存在忽略行（重复 claim）', ignored >= 1, 'ignored=' + ignored);
  await page.screenshot({ path: path.join(shots, '01-desktop-light.png') });

  /* ---------- 2. 时间轴定位：游标归零后余额与状态回退 ---------- */
  await page.locator('#cursorSlider').fill('0');
  await page.waitForTimeout(100);
  check('游标归零', (await page.locator('#cursorNow').textContent()) === '0');
  check('归零后余额为 0', (await page.locator('#balanceBar').textContent()).includes('0'));
  const leftAt0 = await page.locator('.q-node[data-quest="left"] text.q-meta').textContent();
  check('归零后 left 为进行中', leftAt0.includes('进行中'), leftAt0);

  /* 逐步前进到 2（claim 之后），gold 应为 10 */
  await page.locator('#cursorSlider').fill('2');
  await page.waitForTimeout(100);
  check('游标 2 时 gold=10', (await page.locator('#balanceBar').textContent()).includes('10'));
  await page.locator('#cursorSlider').fill('6');

  /* ---------- 3. 节点详情与锁定解释 ---------- */
  await page.locator('.q-node[data-quest="rightOnly"]').dispatchEvent('click');
  await page.waitForTimeout(100);
  const detail = await page.locator('#tabDetail').textContent();
  check('详情含失效原因', detail.includes('失效') || detail.includes('互斥'), detail.slice(0, 120));
  check('详情展示目标进度', detail.includes('目标进度'));

  /* ---------- 4. 事件详情解释 ---------- */
  await page.locator('.tab[data-tab="log"]').click();
  await page.locator('.log-row[data-idx="1"]').click();
  await page.waitForTimeout(100);
  const evDetail = await page.locator('#tabDetail').textContent();
  check('claim 事件详情含状态迁移', evDetail.includes('已领取'), evDetail.slice(0, 100));
  check('事件详情含目标变化小节', evDetail.includes('目标变化'));

  /* ---------- 5. 录入重复 eventId：冲突拒绝 ---------- */
  await page.locator('#btnAddEvent').click();
  await page.locator('#fEventId').fill('e1');
  await page.locator('#fType').fill('kill');
  await page.locator('#fAmount').fill('3');
  await page.locator('#matchRows .match-row button').click(); // 删掉默认空匹配行
  await page.locator('#mSave').click();
  await page.waitForTimeout(300);
  check('冲突事件被拒绝（toast）', (await page.locator('#toastRoot').textContent()).includes('拒绝'));
  check('冲突事件已记录位置（issues 计数提示）', (await page.locator('#logHint').textContent()).includes('拒绝'));
  // 回到日志标签，确认拒绝行已渲染（当前行数未超过容器，无需滚动）
  await page.locator('.tab[data-tab="log"]').click();
  await page.waitForTimeout(150);
  check('日志出现拒绝行', await page.locator('.log-row.st-rejected').count() >= 1);

  /* ---------- 6. 录入合法新事件并验证计数 ---------- */
  await page.locator('#btnAddEvent').click();
  await page.waitForSelector('#fEventId');
  const nextId = await page.locator('#fEventId').inputValue();
  await page.locator('#fType').fill('kill');
  const tagInput = await page.locator('#matchRows input').first();
  await tagInput.fill('tag');
  await page.locator('#matchRows input').nth(1).fill('wolf');
  await page.locator('#mSave').click();
  await page.waitForTimeout(300);
  check('新事件自动编号', /^e\d+$/.test(nextId), nextId);
  check('日志长度变为 8', (await page.locator('#cursorTotal').textContent()) === '8');

  /* ---------- 7. 历史编辑：改 e1 的 tag 后整链重算 ---------- */
  await page.locator('#btnBulkEdit').click();
  const edited = JSON.parse(fs.readFileSync(path.join(webDir, 'data', 'branch.json'), 'utf8'));
  edited.events[0].tag = 'boar';
  await page.locator('#bulkText').fill(JSON.stringify(edited.events, null, 2));
  await page.locator('#bSave').click();
  await page.waitForTimeout(400);
  check('改历史后日志回到 6 条', (await page.locator('#cursorTotal').textContent()) === '6');
  const claimRow = await page.locator('.log-row[data-idx="1"]').getAttribute('class');
  check('原 claim left 变为业务拒绝', claimRow.includes('st-rejected'), claimRow);
  check('余额回到 0', (await page.locator('#balanceBar').textContent()).includes('0'));
  const leftNow = await page.locator('.q-node[data-quest="left"] text.q-meta').textContent();
  check('left 回到进行中', leftNow.includes('进行中'), leftNow);
  await page.screenshot({ path: path.join(shots, '02-after-edit.png') });

  /* ---------- 8. 重算校验全部通过 ---------- */
  await page.locator('#btnVerify').click();
  await page.waitForSelector('.check-line');
  const badChecks = await page.locator('.check-line.bad').count();
  check('校验无失败项', badChecks === 0, 'bad=' + badChecks);
  await page.locator('#vClose').click();

  /* ---------- 9. 导出存档结构 ---------- */
  await page.locator('#btnExport').click();
  const saveText = await page.locator('#expText').inputValue();
  const save = JSON.parse(saveText);
  check('存档格式标识', save.format === 'quest-branch-replayer-save/v1');
  check('存档含 bundle/seen/collected/cursor',
    save.bundle && save.bundle.seen && save.bundle.collected && typeof save.cursor === 'number');
  await page.locator('#expClose').click();

  /* ---------- 9b. 存档往返：导出文本 -> 导入 -> 状态完全恢复 ---------- */
  await page.locator('#btnImport').click();
  await page.locator('#impText').fill(saveText);
  await page.locator('#iSave').click();
  await page.waitForTimeout(400);
  check('导入后游标恢复', (await page.locator('#cursorNow').textContent()) === String(save.cursor));
  check('导入后日志条数恢复', (await page.locator('#cursorTotal').textContent()) === String(save.log.length));
  check('导入后余额一致', (await page.locator('#balanceBar').textContent()).includes('0'));
  const restoredLeft = await page.locator('.q-node[data-quest="left"] text.q-meta').textContent();
  check('导入后 left 为进行中（改历史后的状态）', restoredLeft.includes('进行中'), restoredLeft);

  /* ---------- 9c. 篡改存档导入必须被自校验拒绝 ---------- */
  const tampered = JSON.parse(saveText);
  tampered.bundle.balances.gold = 999;
  await page.locator('#btnImport').click();
  await page.locator('#impText').fill(JSON.stringify(tampered));
  await page.locator('#iSave').click();
  await page.waitForTimeout(300);
  check('篡改存档被拒绝并提示', (await page.locator('#impMsg').textContent()).includes('自校验未通过'));
  await page.locator('#iCancel').click();

  await ctx.close();
}

/* ---------- 10. 非法环样例被定义校验拒绝 ---------- */
{
  const { ctx, page } = await newPage();
  await page.locator('#btnSamples').click();
  await page.locator('[data-sample="cycle"]').click();
  await page.waitForSelector('.reason-list .err');
  const errText = await page.locator('.modal .reason-list').textContent();
  check('环样例报依赖环错误', errText.includes('依赖环'), errText.slice(0, 80));
  await ctx.close();
}

/* ---------- 11. 压力样例 200×5000 ---------- */
{
  const { ctx, page } = await newPage();
  await page.locator('#btnSamples').click();
  await page.locator('[data-sample="stress"]').click();
  await page.waitForTimeout(1500);
  check('压力样例节点 200', await page.locator('.q-node').count() === 200);
  check('压力样例游标 5000', (await page.locator('#cursorTotal').textContent()) === '5000');
  // 适应屏幕时缩放很小，节点只画状态点；放大后文字标注恢复
  check('小缩放下 q0 仅渲染状态点', await page.locator('.q-node[data-quest="q0"] circle').count() >= 1);
  check('小缩放下隐藏 q-meta 文字', await page.locator('.q-node[data-quest="q0"] text.q-meta').count() === 0);
  await page.locator('#zoomIn').click();
  await page.locator('#zoomIn').click();
  await page.locator('#zoomIn').click();
  await page.locator('#zoomIn').click();
  await page.waitForTimeout(350);
  check('放大后恢复文字标注', await page.locator('.q-node[data-quest="q0"] text.q-meta').count() === 1);
  const q0 = await page.locator('.q-node[data-quest="q0"] text.q-meta').textContent();
  check('q0 目标 1/1 且可领取', q0.includes('1/1') && q0.includes('可领取'), q0);
  await page.locator('#zoomFit').click();
  await page.waitForTimeout(200);
  const t0 = Date.now();
  await page.locator('#cursorSlider').fill('2500');
  await page.waitForTimeout(200);
  // 游标变化后状态色仍正确（通过 rect 的 stroke 变量与节点 title 校验）
  const q0title = await page.locator('.q-node[data-quest="q0"] title').textContent();
  check('游标 2500 时 q0 为进行中', q0title.includes('进行中'), q0title);
  check('时间轴定位响应 < 1.5s', Date.now() - t0 < 1500, Date.now() - t0 + 'ms');
  /* 虚拟列表：5000 行只渲染可见窗口，滚动后行号随位置变化 */
  const beforeRows = await page.locator('.log-row').count();
  check('虚拟列表只渲染少量行（< 60）', beforeRows < 60, 'rows=' + beforeRows);
  await page.locator('#logScroller').evaluate((el) => { el.scrollTop = 2000 * 46; });
  await page.waitForTimeout(250);
  const midFirst = await page.locator('.log-row').first().getAttribute('data-idx');
  check('滚动后渲染窗口移动到中段（首行 idx ≥ 1990）', Number(midFirst) >= 1990, 'firstIdx=' + midFirst);
  await page.screenshot({ path: path.join(shots, '03-stress.png') });
  await ctx.close();
}

/* ---------- 12. 手机宽度 + 深色 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8931/index.html');
  await page.waitForSelector('.q-node', { timeout: 8000 });
  await page.waitForTimeout(400);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  check('手机宽度无横向滚动', scrollW <= 390, 'scrollWidth=' + scrollW);
  await page.screenshot({ path: path.join(shots, '04-phone-dark.png'), fullPage: true });
  await ctx.close();
}

/* ---------- 13. 刷新后草稿恢复 ---------- */
{
  const { ctx, page } = await newPage();
  await page.locator('#cursorSlider').fill('3');
  await page.waitForTimeout(700); // 等待草稿防抖写入
  await page.reload();
  await page.waitForSelector('.q-node');
  await page.waitForTimeout(300);
  check('刷新后游标恢复为 3', (await page.locator('#cursorNow').textContent()) === '3');
  await ctx.close();
}

await browser.close();
server.close();

let pass = 0;
for (const r of results) {
  console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.extra ? ' (' + r.extra + ')' : ''));
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} 通过`);
if (errors.length) { console.error('\n浏览器错误：'); errors.forEach((e) => console.error(' - ' + e)); process.exit(1); }
process.exit(pass === results.length ? 0 : 1);
