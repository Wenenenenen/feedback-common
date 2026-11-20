/*
 * 浏览器端到端测试（Playwright）：node tests/e2e.ui.js
 * 覆盖：首屏计划、单步演算、事件打断与重规划、同成本决胜、无解/预算三态、
 * 手动改状态触发重规划、注入事件、导出 JSON。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, urlPath);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  let fails = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fails++; console.error('  ✗ ' + name + '\n    ' + e.message); }
  }
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const resValue = (page, name) =>
    page.$$eval('#state-editor .state-item', (items, n) => {
      const hit = items.find((it) => it.querySelector('.state-name').textContent.startsWith(n + '/') ||
                                    it.querySelector('.state-name').textContent === n);
      const inp = hit && hit.querySelector('input[type="number"]');
      return inp ? inp.value : null;
    }, name);
  const factValue = (page, name) =>
    page.$$eval('#state-editor .state-item', (items, n) => {
      const hit = items.find((it) => it.querySelector('.state-name').textContent === n);
      const inp = hit && hit.querySelector('input[type="checkbox"]');
      return inp ? inp.checked : null;
    }, name);

  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForSelector('.plan-table tbody tr');

  await check('首屏渲染 demo 静态最优计划 gather→gather→craft→deliver，成本 5', async () => {
    const banner = await page.textContent('#plan-banner');
    assert(banner.includes('最优计划') && banner.includes('总成本 5'), banner);
    const ids = await page.$$eval('.plan-table .action-id', (els) => els.map((e) => e.textContent));
    assert(JSON.stringify(ids) === JSON.stringify(['gather', 'gather', 'craft', 'deliver']), ids.join(','));
  });

  await check('步骤表显示各步累计成本与执行后资源', async () => {
    const costs = await page.$$eval('.plan-table tbody tr td:nth-child(3)', (els) => els.map((e) => e.textContent));
    assert(JSON.stringify(costs) === JSON.stringify(['1', '2', '4', '5']), costs.join(','));
    const lastState = await page.textContent('.plan-table tbody tr:last-child .state-cell');
    assert(lastState.includes('done=true'), lastState);
  });

  await check('单步演算：第一步在 t=100 完成 gather，ore=1，成本 1', async () => {
    await page.click('#btn-step');
    assert((await page.textContent('#sim-time')).includes('100'), await page.textContent('#sim-time'));
    assert((await page.textContent('#sim-cost')).trim() === '1', await page.textContent('#sim-cost'));
    assert((await resValue(page, 'ore')) === '1', 'ore 应为 1');
  });

  await check('t=150 事件打断在途 gather：无成本无效果并重规划为 buy→deliver', async () => {
    await page.click('#btn-step'); // 推进到 150
    assert((await page.textContent('#sim-time')).includes('150'), 't');
    assert((await page.textContent('#sim-cost')).trim() === '1', '成本仍为 1');
    assert((await resValue(page, 'ore')) === '1', '中断动作未加 ore，ore 应仍为 1');
    assert((await factValue(page, 'access')) === false, 'access 应为 false');
    const log = await page.textContent('#log-box');
    assert(log.includes('不扣成本'), log);
    // 切到运行时计划视角
    await page.click('#seg-runtime');
    const banner = await page.textContent('#plan-banner');
    assert(banner.includes('buy') && banner.includes('deliver'), banner);
    await page.click('#seg-static');
  });

  await check('运行到结束：轨迹与 expected.json 一致（buy@250, deliver@300，成本 8，ore=1）', async () => {
    await page.click('#btn-play');
    await page.waitForFunction(() => document.querySelector('#sim-time').textContent.includes('300'), { timeout: 8000 });
    await page.waitForSelector('.status-pill.goal_reached', { timeout: 4000 });
    assert((await page.textContent('#sim-cost')).trim() === '8', await page.textContent('#sim-cost'));
    assert((await resValue(page, 'ore')) === '1', '最终 ore 应为 1');
    const log = await page.textContent('#log-box');
    assert(log.includes('已到达目标'), log);
  });

  await check('复位后回到 t=0、成本 0、初始状态', async () => {
    await page.click('#btn-reset');
    assert((await page.textContent('#sim-time')).includes('0 ms'), 't');
    assert((await page.textContent('#sim-cost')).trim() === '0', 'cost');
  });

  await check('tie 样例：同成本按字典序选动作 a', async () => {
    await page.selectOption('#sample-select', 'tie');
    await page.waitForFunction(() => document.querySelector('#plan-banner').textContent.includes('总成本 2'));
    const ids = await page.$$eval('.plan-table .action-id', (els) => els.map((e) => e.textContent));
    assert(JSON.stringify(ids) === JSON.stringify(['a']), ids.join(','));
  });

  await check('unreachable 样例：独立显示无解状态', async () => {
    await page.selectOption('#sample-select', 'unreachable');
    await page.waitForSelector('.banner-unsolvable');
    const banner = await page.textContent('#plan-banner');
    assert(banner.includes('无解'), banner);
    await page.waitForSelector('.status-pill.unsolvable');
  });

  await check('预算耗尽与无解分开显示（预算调为 1）', async () => {
    await page.fill('#in-budget', '1');
    await page.click('#btn-apply-rules');
    await page.waitForSelector('.banner-budget');
    const banner = await page.textContent('#plan-banner');
    assert(banner.includes('预算耗尽') && banner.includes('未检查候选'), banner);
    await page.waitForSelector('.status-pill.budget_exhausted');
  });

  await check('手动编辑当前状态触发重规划（demo，access 置 false 改走 buy）', async () => {
    await page.selectOption('#sample-select', 'demo');
    await page.waitForSelector('.plan-table tbody tr');
    // 每次渲染后元素会重建，用 locator 即时查询
    const accessItem = page.locator('#state-editor .state-item', { hasText: 'access' }).first();
    await accessItem.locator('input[type="checkbox"]').uncheck();
    await page.click('#seg-runtime');
    const banner = await page.textContent('#plan-banner');
    assert(banner.includes('buy'), banner);
    await page.click('#seg-static');
  });

  await check('注入当前刻外部事件立即处理并重规划', async () => {
    await page.fill('#in-ev-t', '0');
    await page.selectOption('.inj-fact >> nth=0', 'false'); // access=false
    await page.click('#btn-inject');
    const status = await page.textContent('#inject-status');
    assert(status.includes('立即处理'), status);
    const log = await page.textContent('#log-box');
    assert(log.includes('外部事件'), log);
  });

  await check('注入过去时刻被拒绝并显示错误', async () => {
    await page.fill('#in-ev-t', '-5');
    await page.click('#btn-inject');
    const status = await page.textContent('#inject-status');
    assert(status.includes('非负整数') || status.includes('过去'), status);
  });

  await check('导出完整演算包为合法 JSON 且含 rules/plan/execution', async () => {
    await page.click('#btn-export');
    await page.click('[data-export="bundle"]');
    const text = await page.inputValue('#export-text');
    const parsed = JSON.parse(text);
    assert(parsed.rules && parsed.plan && parsed.execution, '缺少导出段落');
    assert(Array.isArray(parsed.execution.log), '日志缺字段');
    assert(parsed.rules.actions.length >= 1, '规则动作缺失');
    await page.click('#modal-export [data-close]');
  });

  await check('JSON 面板可校验应用（改 budget 后生效）', async () => {
    await page.click('.tab[data-tab="json"]');
    const raw = await page.inputValue('#json-editor');
    const parsed = JSON.parse(raw);
    parsed.budget = 7;
    await page.fill('#json-editor', JSON.stringify(parsed));
    await page.click('#btn-apply-json');
    const jstatus = await page.textContent('#json-status');
    assert(jstatus.includes('已应用'), jstatus);
  });

  await check('无效规则在应用时被拦截并显示错误', async () => {
    await page.click('.tab[data-tab="actions"]');
    await page.fill('.action-cost', '0');
    await page.click('#btn-apply-rules-2');
    await page.waitForFunction(() => document.querySelector('#rules-status-2').textContent.includes('正整数'));
    const st = await page.textContent('#rules-status-2');
    assert(st.includes('正整数'), st);
  });

  await check('整个会话无控制台错误', async () => {
    assert(errors.length === 0, errors.join(' | '));
  });

  await browser.close();
  server.close();
  if (fails) { console.error(`\n${fails} 项 E2E 失败`); process.exit(1); }
  console.log('\n全部 E2E 检查通过');
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
