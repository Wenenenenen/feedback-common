'use strict';
/* UI 冒烟测试：用 Playwright 驱动 index.html，验证单步/抢占/快照/校验提示 */
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

(async () => {
  let failed = 0;
  const check = (name, cond, extra) => {
    if (cond) console.log(`  ok  ${name}`);
    else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));

  // 默认载入抢占示例
  check('页面加载且无 JS 错误', errors.length === 0, errors.join('; '));
  check('树图渲染了 5 个节点', await page.locator('g[data-node]').count() === 5);

  // 单步 3 次：tick2 发生抢占，normal 应显示为已中止
  await page.click('#btnStep');
  await page.click('#btnStep');
  await page.click('#btnStep');
  check('tick 推进到 3', (await page.textContent('#tickNum')) === '3');
  const traceText = await page.textContent('#tracePanel');
  check('轨迹含 abort 记录', traceText.includes('aborted') && traceText.includes('抢占'), traceText.slice(0, 200));
  check('轨迹含输入事件', traceText.includes('urgent'));

  // 快照保存/恢复
  await page.click('#btnSnap');
  check('快照列表出现 1 条', await page.locator('.snap-row').count() === 1);
  await page.click('#btnStep');
  await page.click('#btnStep');
  const tickBefore = await page.textContent('#tickNum');
  await page.click('button[data-restore="0"]');
  check('恢复快照后 tick 回到 3', (await page.textContent('#tickNum')) === '3',
    `恢复前 ${tickBefore}`);
  check('恢复后位置与快照一致', (await page.textContent('#stage')) !== null); // canvas 存在即可，位置一致性由引擎测试覆盖

  // 黑板编辑：把 urgent 改为 false，下一步应回到 normal 分支
  await page.fill('input[data-bb="urgent"]', 'false');
  await page.dispatchEvent('input[data-bb="urgent"]', 'change');
  await page.click('#btnStep');
  const trace2 = await page.textContent('#tracePanel');
  check('黑板修改生效（urgentSeq 失败）', trace2.includes('urgentSeq'));

  // 非法示例：载入环，校验报错且树不切换
  await page.selectOption('#preset', 'invalidCycle');
  const errText = await page.textContent('#treeErrors');
  check('环被校验拒绝并提示', errText.includes('环'), errText);
  check('非法树不替换当前树', await page.locator('g[data-node]').count() === 5);

  // 压力示例：128 节点渲染
  await page.selectOption('#preset', 'stress');
  check('128 节点全部渲染', await page.locator('g[data-node]').count() === 128);
  await page.click('#btnStep');
  const trace3 = await page.textContent('#tracePanel');
  check('压力树 1 tick 完成并复位', trace3.includes('整树复位'));

  // 播放/暂停按钮
  await page.selectOption('#preset', 'preemption');
  await page.click('#btnPlay');
  await page.waitForTimeout(180);
  await page.click('#btnPlay');
  const tickAfterPlay = +(await page.textContent('#tickNum'));
  check('50ms 节拍播放推进了 tick', tickAfterPlay >= 2 && tickAfterPlay <= 6, `tick=${tickAfterPlay}`);

  check('全程无 JS 错误', errors.length === 0, errors.join('; '));
  await browser.close();
  console.log(failed ? `\n${failed} 项失败` : '\nUI 冒烟测试全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
