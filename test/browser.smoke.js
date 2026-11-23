// test/browser.smoke.js — Playwright 冒烟测试：node test/browser.smoke.js
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const FILE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const SAMPLE = path.join(__dirname, '..', 'samples', 'retained-tile-cases.json');

let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? '  ok - ' : 'FAIL - ') + name + (cond ? '' : ' ' + (detail || '')));
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(FILE_URL);
  // file:// 下自动 fetch 样例会失败，用 setInputFiles 导入
  await page.setInputFiles('#file-input', SAMPLE);
  await page.waitForFunction(() => document.querySelectorAll('.tree-node').length > 0, null, { timeout: 5000 });

  ok('图层树渲染', await page.locator('.tree-node').count() >= 6);
  ok('状态栏显示节点数', (await page.locator('#st-nodes').innerText()).includes('节点'));
  const diffText = await page.locator('#st-diff').innerText();
  ok('prime 后逐像素一致', diffText.includes('逐像素一致'), diffText);

  // 重算瓦片初始统计
  ok('prime 有重算瓦片', Number(await page.locator('#num-recomputed').innerText()) > 0);

  // 选中 inner 组并加入平移补丁
  await page.locator('.tree-node', { hasText: 'inner' }).first().click();
  await page.waitForSelector('#off-0');
  await page.fill('#off-0', '18');
  await page.click('#btn-add-offset');
  ok('队列出现 1 个补丁', (await page.locator('#queue-count').innerText()).startsWith('1'));

  // 再加一个裁框补丁到 outer
  await page.locator('.tree-node', { hasText: 'outer' }).first().click();
  await page.check('#clip-enable');
  await page.fill('#clip-0', '31'); await page.fill('#clip-1', '12');
  await page.fill('#clip-2', '8'); await page.fill('#clip-3', '10');
  await page.click('#btn-add-clip');
  ok('队列出现 2 个补丁', (await page.locator('#queue-count').innerText()).startsWith('2'));

  await page.click('#btn-apply-batch');
  await page.waitForTimeout(200);
  const afterBatch = await page.locator('#st-diff').innerText();
  ok('批次后仍逐像素一致', afterBatch.includes('逐像素一致'), afterBatch);
  ok('时间线出现 1 条事务', (await page.locator('.tl-item').count()) === 1);

  // 视图切换
  for (const v of ['full', 'diff', 'tiles', 'incremental']) {
    await page.click('.view-opt[data-view="' + v + '"]');
    await page.waitForTimeout(80);
  }
  ok('四个视图可切换', true);

  // 差异视图应显示 0 差异
  await page.click('.view-opt[data-view="diff"]');
  const diffBadge = await page.locator('.tl-badge').first().innerText();
  ok('时间线标记逐像素一致', diffBadge.includes('逐像素一致'), diffBadge);

  // 撤销 / 重做
  await page.click('#btn-undo');
  await page.waitForTimeout(150);
  ok('撤销后时间线清空当前', (await page.locator('.tl-item.is-current').count()) === 0);
  const undoneDiff = await page.locator('#st-diff').innerText();
  ok('撤销后仍与全量一致', undoneDiff.includes('逐像素一致'), undoneDiff);
  await page.click('#btn-redo');
  await page.waitForTimeout(150);
  ok('重做后恢复事务', (await page.locator('.tl-item.is-current').count()) === 1);

  // 像素探针：点击画布中一个明确像素（用 canvas 盒原点 + 画布坐标×实际缩放）
  await page.click('.view-opt[data-view="incremental"]');
  const pbox = await page.locator('#canvas-view').boundingBox();
  const sx = pbox.width / 96, sy = pbox.height / 64;
  await page.mouse.click(pbox.x + 10 * sx + sx / 2, pbox.y + 10 * sy + sy / 2);
  await page.waitForSelector('#probe-table-wrap:not([hidden])', { timeout: 5000 });
  ok('像素探针出现链路', (await page.locator('.probe-table tr').count()) >= 1);

  // 拖拽平移 far 组（far 内容在画布 x≈72..94, y≈31..54）
  const startX = pbox.x + (80.5 / 96) * pbox.width;
  const startY = pbox.y + (42.5 / 64) * pbox.height;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 30, startY + 10, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragDiff = await page.locator('#st-diff').innerText();
  ok('拖拽事务后逐像素一致', dragDiff.includes('逐像素一致'), dragDiff);
  ok('拖拽产生事务', (await page.locator('.tl-item').count()) === 2);

  // PNG 导出（监听 download）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('#btn-export-png')
  ]);
  ok('PNG 导出触发下载', !!download);
  if (download) ok('PNG 文件名正确', download.suggestedFilename().endsWith('.png'));

  // 日志导出
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('#btn-export-log')
  ]);
  ok('重绘日志导出触发下载', !!dl2);
  if (dl2) {
    const stream = await dl2.createReadStream();
    let chunks = '';
    for await (const c of stream) chunks += c;
    const parsed = JSON.parse(chunks);
    ok('日志含 transactions 数组', Array.isArray(parsed.transactions) && parsed.transactions.length === 2);
    ok('日志记录 recomputedTiles', JSON.stringify(parsed.transactions[0]).includes('recomputedTiles'));
  }

  // 缩放
  await page.click('#zoom-in');
  await page.click('#zoom-fit');
  ok('缩放控件可用', (await page.locator('#zoom-label').innerText()).includes('%'));

  // 主题切换
  await page.click('.theme-opt[data-theme-v="dark"]');
  ok('深色主题切换', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.click('.theme-opt[data-theme-v="light"]');

  await page.waitForTimeout(200);
  ok('无 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n浏览器冒烟全部通过 ✔' : '\n' + failures + ' 项失败 ✘');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
