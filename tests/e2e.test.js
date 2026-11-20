/* 端到端：用 Playwright 驱动真实页面 */
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
let pass = 0;
function ok(name, cond, extra) {
  if (!cond) { console.error('FAIL:', name, extra || ''); process.exitCode = 1; }
  else { pass++; console.log('  ok -', name); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(300);

  // 1. 首屏自动载入 small
  ok('首屏自动载入 small（4 块）', await page.locator('.chart-row').count() === 4);
  ok('首屏无 JS 错误', errors.length === 0, errors.join(' | '));

  // 2. 重排：锁定 chart-0 保持 (2,2,0)，其余被放置且无冲突
  await page.click('#packBtn');
  await page.waitForTimeout(200);
  const statPlaced = await page.textContent('#statPlaced');
  ok('重排后 4/4 已放置', statPlaced.includes('4 / 4'), statPlaced);
  const conflicts = await page.textContent('#statConflicts');
  ok('重排后冲突数为 0', conflicts.trim() === '0', conflicts);
  const rows = await page.locator('.chart-row').allInnerTexts();
  ok('chart-0 锁定且位置 2,2', rows.some(r => r.includes('chart-0') && r.includes('2,2') && r.includes('锁定')), rows.join(' || '));
  ok('成功消息出现', (await page.locator('.msg.ok').count()) >= 1);

  // 3. 确定性：再点一次重排，布局 JSON 相同
  await page.click('#exportLayout');
  await page.waitForTimeout(100);
  const json1 = await page.textContent('#modalPre');
  await page.click('#modalClose');
  await page.click('#packBtn');
  await page.waitForTimeout(150);
  await page.click('#exportLayout');
  await page.waitForTimeout(100);
  const json2 = await page.textContent('#modalPre');
  await page.click('#modalClose');
  ok('同输入同锁定重排结果确定', json1 === json2);
  const parsed1 = JSON.parse(json1);
  ok('布局 JSON 含 stats 与 placements', parsed1.placements.length === 4 && parsed1.stats.occupiedCells > 0);

  // 4. 逐角 UV：v 向下、数值在 [0,1]
  await page.click('#exportUV');
  await page.waitForTimeout(100);
  const uvText = await page.textContent('#modalPre');
  const uv = JSON.parse(uvText);
  let uvOk = uv.charts.length === 4;
  uv.charts.forEach(ch => ch.triangles.forEach(t => t.corners.forEach(cn => {
    if (!(cn.uv[0] >= 0 && cn.uv[0] <= 1 && cn.uv[1] >= 0 && cn.uv[1] <= 1)) uvOk = false;
  })));
  ok('逐角 UV 四块齐全且全部在 [0,1]', uvOk);
  await page.click('#modalClose');

  // 5. 归属图：PNG dataURL/Blob 与色表，三类格子
  await page.click('#exportOwnership');
  await page.waitForTimeout(200);
  const imgSrc = await page.locator('#modalBody img').getAttribute('src');
  ok('归属图 PNG 已生成', imgSrc.startsWith('blob:'));
  const tableText = await page.textContent('#modalPre');
  const table = JSON.parse(tableText);
  ok('色表含 4 块且区分占用/补边/空白', table.colors.length === 4 &&
    table.colors.every(c => c.occupied && c.padding) && table.empty === '#FFFFFF');
  await page.click('#modalClose');

  // 6. 制造冲突：重排后把已放置的 chart-1 拖到 chart-0（锁定在 2,2）的占用区
  const cellInfo = await page.evaluate(() => {
    const c1 = document.querySelectorAll('.chart-row')[1];
    c1.click();
    return { cell: 24 };
  });
  // 确保 chart-1 未锁定
  let badge = await page.locator('.chart-row.selected .badge').innerText();
  if (badge.includes('锁定')) await page.click('#lockBtn');

  const box = await page.locator('#atlas').boundingBox();
  const cell = cellInfo.cell;
  // chart-1 当前包围框左上角（从列表 mini-pos 读取）
  const posText = await page.locator('.chart-row:nth-child(2) .mini-pos').innerText();
  const m = posText.match(/(-?\d+),(-?\d+)/);
  const sx = +m[1], sy = +m[2];
  // 从 chart-1 中心抓起，放到 chart-0 占用格 (3,3) 中心
  await page.mouse.move(box.x + (sx + 2) * cell, box.y + (sy + 2) * cell);
  await page.mouse.down();
  await page.mouse.move(box.x + 3.5 * cell, box.y + 3.5 * cell, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const errMsgs = await page.locator('.msg.error').count();
  ok('拖到重叠处产生冲突错误消息', errMsgs >= 1);
  const conflictText = await page.locator('.msg.error').first().innerText();
  ok('冲突消息指出图块', /chart-1/.test(conflictText), conflictText.slice(0, 80));
  ok('冲突消息含格子坐标', /\(\d+,\d+\)/.test(conflictText), conflictText.slice(0, 140));
  // 回退后 chart-1 仍在原位置
  const restored = await page.locator('.chart-row:nth-child(2) .mini-pos').innerText();
  ok('冲突后位置回退', restored.includes(sx + ',' + sy), restored);

  // 7. 微调按钮可用且合法移动
  await page.locator('.chart-row', { hasText: 'chart-2' }).click();
  const before = await page.locator('.chart-row.selected .mini-pos').innerText();
  await page.click('#rightBtn');
  const after = await page.locator('.chart-row.selected .mini-pos').innerText();
  ok('方向微调改变了位置', before !== after, before + ' -> ' + after);

  // 8. 旋转 90°：检查变换网格尺寸可能交换
  await page.click('#rotateBtn');
  await page.waitForTimeout(100);
  const rotNote = await page.textContent('#meshNote');
  ok('旋转后检查器说明更新', /旋转 90/.test(rotNote), rotNote);

  // 9. capacity 64 块
  await page.click('#sampleCapacity');
  await page.waitForTimeout(300);
  ok('载入 capacity 64 块', await page.locator('.chart-row').count() === 64);
  const t0 = Date.now();
  await page.click('#packBtn');
  await page.waitForFunction(() => /64 \/ 64/.test(document.querySelector('#statPlaced').textContent), { timeout: 15000 });
  const dt = Date.now() - t0;
  ok('capacity 在 15s 内全部放下', (await page.textContent('#statConflicts')).trim() === '0');
  console.log('     capacity 排布耗时 ' + dt + 'ms');

  // 10. impossible 样例：可证明无解
  await page.setInputFiles('#fileInput', {
    name: 'impossible.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(require('./fixtures/impossible.json')))
  });
  await page.waitForTimeout(200);
  await page.click('#packBtn');
  await page.waitForTimeout(200);
  const impossibleMsg = await page.locator('.msg.error').first().innerText();
  ok('impossible 报告可证明无解且不缩放', /可证明无解/.test(impossibleMsg) && /未缩放/.test(impossibleMsg), impossibleMsg.slice(0, 100));

  // 11. locked-conflict：逐格报告
  await page.setInputFiles('#fileInput', {
    name: 'locked-conflict.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(require('./fixtures/locked-conflict.json')))
  });
  await page.waitForTimeout(200);
  await page.click('#packBtn');
  await page.waitForTimeout(200);
  const lcAll = await page.locator('.msg.error').allInnerTexts();
  const lcMsg = lcAll.join(' ');
  ok('锁定冲突指出图块与格子',
    /locked-b/.test(lcMsg) && /locked-a/.test(lcMsg) && /\(\d+,\d+\)/.test(lcMsg),
    lcMsg.slice(0, 160));

  const finalErrors = errors.filter(e => !/favicon/.test(e));
  ok('全程无页面 JS 错误', finalErrors.length === 0, finalErrors.join(' | '));
  await browser.close();
  console.log('\n' + pass + ' 项端到端检查通过');
})().catch(e => { console.error(e); process.exit(1); });
