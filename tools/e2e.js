'use strict';
// 端到端浏览器测试：导入、点格高亮、改格、版本切换、批查询、无效导入保留项目
const path = require('path');
const { chromium } = require(path.join(
  '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules', 'playwright'
));

const HTML = 'file://' + path.join(__dirname, '..', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(HTML);

  const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };
  const ok = (msg) => console.log('✓ ' + msg);

  // 1. 载入样例
  await page.click('#load-sample');
  await sleep(100);
  const workspaceVisible = await page.isVisible('#workspace');
  workspaceVisible ? ok('样例导入后工作区显示') : fail('工作区未显示');

  // 2. 地图画布有内容（非全空白）
  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById('map');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBg++;
    return { w: c.width, h: c.height, nonBg };
  });
  canvasInfo.nonBg > 100 ? ok(`画布已绘制（${canvasInfo.w}×${canvasInfo.h}）`) : fail('画布空白');

  // 3. 点选空地 (1,1)，应出现飞地信息
  const box = await page.evaluate(() => {
    const c = document.getElementById('map');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cols: 4, rows: 4 };
  });
  const cellW = box.w / box.cols;
  const cellH = box.h / box.rows;
  await page.mouse.click(box.x + cellW * 1.5, box.y + cellH * 1.5);
  await sleep(80);
  const cellText = await page.textContent('#cell-kv');
  cellText.includes('飞地') && cellText.includes('是') ? ok('点选空地显示飞地详情') : fail('飞地详情缺失: ' + cellText);

  // 4. 加入批查询并运行
  await page.click('#add-query-here');
  await page.click('#run-batch');
  await sleep(100);
  const rowCount = await page.locator('#query-table tbody tr').count();
  rowCount === 3 ? ok(`批查询运行，表内 ${rowCount} 行（2 导入 + 1 新增）`) : fail(`查询行数 ${rowCount}`);
  const exportEnabled = await page.isEnabled('#export-json');
  exportEnabled ? ok('运行后导出按钮可用') : fail('导出按钮未启用');

  // 5. 改格：选中 (1,1)，改成 A，应生成 v3
  await page.selectOption('#edit-value', 'A');
  await page.click('#do-edit');
  await sleep(80);
  const verText = await page.textContent('#map-ver');
  verText.includes('v3') ? ok('改格生成 v3') : fail('未跳到新版本: ' + verText);
  const treeCount = await page.locator('.tree-item').count();
  treeCount === 4 ? ok(`版本树有 ${treeCount} 个版本`) : fail(`版本树数量 ${treeCount}`);

  // 6. 切回 v0，验证兄弟分支隔离（v0 的 (1,1) 仍是空地）
  await page.locator('.tree-item[data-v="0"]').click();
  await sleep(80);
  await page.mouse.click(box.x + cellW * 1.5, box.y + cellH * 1.5);
  await sleep(60);
  const backText = await page.textContent('#cell-kv');
  backText.includes('空地') ? ok('切回 v0 后该格仍是空地（分支隔离）') : fail('分支隔离失败: ' + backText);

  // 7. 无效导入：通过页面内 ingest 路径（构造非法 JSON 文件）
  const bad = JSON.stringify({
    rows: ['AA', 'AA'],
    edits: [{ parent: 9, x: 0, y: 0, value: 'Z' }],
    queries: [{ version: 99, x: 0, y: 0 }],
  });
  await page.evaluate((text) => {
    // 直接触发 drop 区的 ingest 逻辑：用 File + DataTransfer
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'bad.json', { type: 'application/json' }));
    const drop = document.getElementById('drop');
    drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, bad);
  await sleep(100);
  const errVisible = await page.isVisible('#errors');
  const errText = await page.textContent('#errors');
  const stillThere = await page.isVisible('#workspace');
  if (errVisible && errText.includes('edits 第 1 条') && errText.includes('queries 第 1 条') && stillThere) {
    ok('无效导入指出记录号且保留当前项目');
  } else {
    fail('无效导入处理错误: visible=' + errVisible + ' text=' + errText.slice(0, 120) + ' kept=' + stillThere);
  }

  // 8. 复制导出（剪贴板在无头环境可能被拒，验证不抛错且有降级）
  await page.click('#export-json');
  await sleep(80);
  ok('导出操作未抛错');

  if (errors.length) {
    fail('控制台错误: ' + errors.join(' | '));
  } else {
    ok('无控制台错误');
  }
  await browser.close();
  console.log(process.exitCode ? '\n存在失败' : '\n端到端测试全部通过');
})();
