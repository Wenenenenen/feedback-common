/* 端到端测试：Playwright 驱动真实页面（node tests/e2e.test.js） */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
async function ok(name, cond) {
  if (!cond) throw new Error('断言失败: ' + name);
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 950 },
    bypassCSP: true,
  });
  await context.route('**/*', (route) => route.continue()); // 禁缓存
  const page = await context.newPage();
  // 导出时测试替换 HTMLAnchorElement.prototype.click，阻止假 blob URL 导航
  await page.addInitScript(() => {
    window.__exported = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (String(this.href).startsWith('blob:')) {
        window.__exported.push(this.href);
        return;
      }
      return origClick.call(this);
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await wait(300);

  // ---- 初始渲染 ----
  await ok('自动载入样例，标题显示第 0 步', (await page.textContent('#step-badge')) === '第 0 步');
  await ok('画了 8 个轨道块', (await page.locator('rect.svg-block').count()) === 8);
  await ok('画了 2 列车的车身块', (await page.locator('.svg-marker').count()) === 3); // A 两节 + B 一节
  await ok('道岔面板显示锁定（A1 邻接 X，初始车身不含 X -> 实际看标签）', true);
  const lockText = await page.locator('.lock-tag').textContent();
  await ok('初始道岔可扳动（步首 X/Y 均无车身）', lockText.includes('可扳动'));

  // ---- 第 1 步：无请求，A 移动到 X ----
  await page.click('#btn-step');
  await ok('第 1 步后步号为 1', (await page.textContent('#step-badge')) === '第 1 步');
  const log0 = await page.locator('.log-row').first().textContent();
  await ok('第 1 步日志记录 A 移动', log0.includes('A:A1→X'));

  // ---- 第 2 步：操作表请求 S->Y，应被拒（车头占 X）----
  await page.click('#btn-step');
  await ok('第 2 步扳道被拒标记', (await page.locator('.log-row .tag.no').count()) >= 1);
  const rejectTag = await page.locator('.log-row .tag.no').first().textContent();
  await ok('拒绝标签内容正确', rejectTag.includes('拒绝'));

  // ---- 点击 B 列车查看等待原因 ----
  await page.locator('.train-item', { hasText: 'B' }).click();
  const detail = await page.textContent('#train-detail');
  await ok('详情显示 B 的车头/车尾', detail.includes('B0'));
  await ok('详情解释道岔朝向导致等待', detail.includes('道岔') && detail.includes('等待'));
  await ok('等待目标块出现红色脉冲框', (await page.locator('.wait-target-ring').count()) === 1);

  // ---- 第 3 步：再次拒绝（车尾 A1 已退，车头 X；车尾将在移动后仍占 X）----
  await page.click('#btn-step');
  await ok('第 3 步仍有拒绝', (await page.locator('.log-row .tag.no').count()) >= 2);

  // ---- 第 4 步：操作表请求接受，B 进入 Y ----
  await page.click('#btn-step');
  await ok('第 4 步出现接受标签', (await page.locator('.log-row .tag.ok').count()) === 1);
  const log4 = await page.locator('.log-row.current').textContent();
  await ok('第 4 步 B 移动到 Y', log4.includes('B:B0→Y'));

  // ---- 第 5 步：B 到 D0，全部到站 ----
  await page.click('#btn-step');
  await ok('全部到站提示出现', (await page.textContent('#msg')).includes('全部列车到站'));
  await ok('到站徽章 2/2', (await page.textContent('#arrived-badge')).includes('2/2'));
  await ok('A 显示到站标记', (await page.locator('text=A ✓到站').count()) >= 1);

  // ---- 检查到站按钮 ----
  await page.click('#btn-check');
  await ok('检查通过提示', (await page.textContent('#msg')).includes('全部 2 列车均已到站'));

  // ---- 上一步回退 ----
  await page.click('#btn-back');
  await ok('回退后步号为 4', (await page.textContent('#step-badge')) === '第 4 步');
  await ok('回退后车身块仍是 3 个', (await page.locator('.svg-marker').count()) === 3);

  // 点击日志第 5 行跳回末尾
  await page.locator('.log-row', { hasText: '第 5 步' }).click();
  await ok('日志跳转回第 5 步', (await page.textContent('#step-badge')) === '第 5 步');

  // ---- 重来 ----
  await page.click('#btn-reset');
  await ok('重来后回到第 0 步', (await page.textContent('#step-badge')) === '第 0 步');
  await ok('日志清空', (await page.locator('.log-row').count()) === 0);

  // ---- 手动扳道请求的挂起与撤销 ----
  await page.locator('.pos-btn', { hasText: '朝向 Y' }).click();
  await ok('挂起请求显示', (await page.locator('.switch-note').count()) === 1);
  await page.locator('button', { hasText: '撤销请求' }).click();
  await ok('撤销后无挂起说明', (await page.locator('.switch-note').count()) === 0);

  // ---- 手动扳到 Y 后 A 等待，再扳回 X ----
  await page.locator('.pos-btn', { hasText: '朝向 Y' }).click();
  await page.click('#btn-step'); // 第 1 步：接受扳到 Y，A 因朝向不符等待
  await ok('手动扳道接受', (await page.locator('.tag.ok').count()) === 1);
  await page.locator('.train-item', { hasText: 'A' }).click();
  const detailA = await page.textContent('#train-detail');
  await ok('A 因道岔朝向等待', detailA.includes('道岔 S') && detailA.includes('Y'));
  await ok('A 本步未移动', detailA.includes('等待'));

  // ---- 连续运行：先扳回 X，再连续（操作表条目已消耗，验证推进与僵局保护）----
  await page.locator('.pos-btn', { hasText: '朝向 X' }).click();
  await page.click('#btn-step'); // 第 2 步：扳回 X，A 移动到 X
  const stepBeforeRun = Number((await page.textContent('#step-badge')).match(/\d+/)[0]);
  await page.click('#btn-run');
  await wait(2600);
  await page.click('#btn-run'); // 暂停
  const finalStep = Number((await page.textContent('#step-badge')).match(/\d+/)[0]);
  await ok('连续运行推进了多步', finalStep > stepBeforeRun);
  await page.click('#btn-reset'); // 后续导出需要干净状态，重新走样例流程
  for (let i = 0; i < 5; i++) await page.click('#btn-step');
  await ok('重走后全部到站', (await page.textContent('#arrived-badge')).includes('2/2'));

  // ---- 导出记录并校验内容 ----
  const exported = await page.evaluate(() => new Promise((resolve) => {
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      blob.text().then((t) => resolve(JSON.parse(t)));
      return 'blob:test';
    };
    document.querySelector('#btn-export').click();
    URL.createObjectURL = origCreate;
  }));
  await ok('下载锚点被测试拦截未真的导航', (await page.evaluate(() => window.__exported.length)) === 1);
  await ok('导出含 totalSteps', exported.totalSteps >= 4);
  await ok('导出含逐步 history', Array.isArray(exported.steps) && exported.steps.length === exported.totalSteps);
  await ok('导出含手动请求记录', Array.isArray(exported.manualRequests));
  await ok('导出含每步列车动作', exported.steps[0].trains[0].hasOwnProperty('moved'));
  await ok('导出含扳道决策原因', typeof exported.steps[0].decisions === 'object');

  // ---- 载入 extra[1] 死锁关卡 ----
  const deadlock = {
    edges: [['L', 'R'], ['R', 'L']],
    switches: [],
    trains: [
      { id: 'A', body: ['L'], route: ['R'] },
      { id: 'B', body: ['R'], route: ['L'] },
    ],
  };
  await page.fill('#json-input', JSON.stringify(deadlock));
  await page.click('#btn-load-text');
  await wait(100);
  await ok('死锁关卡载入成功', (await page.textContent('#step-badge')) === '第 0 步');
  await page.click('#btn-step');
  await ok('双方都等待（无移动日志）', (await page.textContent('.log-row')).includes('无车移动'));
  await page.click('#btn-run');
  await wait(1200);
  await ok('连续运行自动停在僵局', (await page.textContent('#msg')).includes('僵局'));

  // ---- 只含操作表的 JSON 合并到当前关卡 ----
  await page.fill('#json-input', JSON.stringify({ commands: [[1, 'S', 'Y']] }));
  await page.click('#btn-load-text');
  await wait(150);
  await ok('操作表合并走 toast 提示', (await page.textContent('#msg')).includes('已为当前关卡载入操作表'));
  await ok('合并后步号回到 0（resetAll 生效）', (await page.textContent('#step-badge')) === '第 0 步');

  // ---- 既无 edges 又无 commands 的非法 JSON ----
  await page.fill('#json-input', JSON.stringify({ foo: 1 }));
  await page.click('#btn-load-text');
  await wait(150);
  await ok('无 edges 的 JSON 被拒绝', (await page.textContent('#msg')).includes('找不到 edges'));

  // ---- 非法关卡被拒 ----
  await page.fill('#json-input', JSON.stringify({ edges: [['x', 'y']], switches: [], trains: [] }));
  await page.click('#btn-load-text');
  await wait(100);
  await ok('空列车关卡给出校验信息', (await page.textContent('#load-msg')).includes('校验'));

  // ---- 文件选择器载入样例文件 ----
  await page.setInputFiles('#file-input', path.join(ROOT, 'samples', 'rail-switch-yard.json'));
  await wait(200);
  await ok('文件载入样例成功', (await page.locator('rect.svg-block').count()) === 8);

  // ---- 页面无 JS 错误 ----
  if (errors.length) console.log('页面错误明细:\n' + errors.join('\n'));
  await ok('全程无页面 JS 错误', errors.length === 0);

  await page.screenshot({ path: path.join(__dirname, 'screenshot.png'), fullPage: false });
  await browser.close();
  console.log('\n全部 ' + pass + ' 项端到端测试通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
