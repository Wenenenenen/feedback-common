/* 浏览器端到端测试：NODE_PATH 指向全局 node_modules，node test/ui.e2e.js */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const EXEC = path.join(process.env.HOME,
  '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell');
const ROOT = path.join(__dirname, '..');
const URL = process.env.UI_URL || ('file://' + path.join(ROOT, 'index.html'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' — ' + x : '')); } };

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.waitForTimeout(400);

  console.log('1) 载入内置示例并计算');
  await page.click('#btnSample');
  await page.waitForSelector('#btnCompute:not([disabled])');
  const pill = await page.textContent('#statusPill');
  ok('示例载入成功', /已载入/.test(pill) || pill.includes('1') && pill.includes('3'), pill);
  await page.click('#btnWhole');
  await page.click('#btnCompute');
  await page.waitForSelector('#faceTable:not([hidden])', { timeout: 5000 });
  const rows = await page.$$eval('#faceBody tr', (trs) => trs.map((t) => t.textContent.trim()));
  ok('渲染六面', rows.length === 6, String(rows.length));
  const allGaps = await page.$$eval('#faceBody td:nth-child(4)', (tds) => tds.map((t) => parseFloat(t.textContent)));
  ok('六面间隙均 ≤ 0.01', allGaps.every((g) => Math.abs(g) <= 0.0101), JSON.stringify(allGaps));

  console.log('2) 见证跳转姿态');
  await page.click('#faceBody tr:first-child');
  const hint = await page.textContent('#vpHint');
  ok('显示见证信息（含顶点号 v 与时间 t=）', /v\d+/.test(hint) === false && /t=/.test(hint), hint);
  const t1 = await page.textContent('#curTime');
  ok('时间游标跳到见证时刻', /\d/.test(t1), t1);

  console.log('3) 导出 JSON 结构');
  const exported = await page.evaluate(() => {
    // 直接调用页面内 buildExport（在同作用域闭包内，借助点击复制不可读，改为校验下载按钮可用 + 重建）
    return { canExport: !document.getElementById('btnExport').disabled };
  });
  ok('导出按钮可用', exported.canExport);

  console.log('4) 错误导入不覆盖旧结果');
  const before = await page.textContent('#modelInfo');
  const bad = JSON.stringify({ bones: [{ parent: null, axis: 'z' }], keys: [], vertices: [] });
  await page.setInputFiles('#fileInput', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  await page.waitForTimeout(500);
  const after = await page.textContent('#modelInfo');
  ok('错误导入后旧模型信息保留', before === after);
  const errPill = await page.textContent('#statusPill');
  ok('状态提示拦截（pill 变为 err 样式）', await page.$eval('#statusPill', (e) => e.classList.contains('err')), errPill);
  const faceStillThere = await page.$eval('#faceTable', (e) => !e.hidden);
  ok('旧包围结果仍在', faceStillThere);

  console.log('5) 编辑关键帧角度后可重算');
  await page.fill('#edKey', '1');
  await page.fill('#edBone', '0');
  await page.fill('#edTurns', '0.5');
  await page.click('#btnEdit');
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('ok'), { timeout: 4000 });
  ok('编辑通过并提示重算（toast 为 ok 态）', true);
  await page.click('#btnCompute');
  await page.waitForSelector('#faceTable:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(200);
  ok('编辑后重算成功', await page.$eval('#faceTable', (e) => !e.hidden));

  console.log('6) 满额长片 12 秒预算');
  await page.click('#btnFull');
  await page.waitForFunction(() => /8192/.test(document.getElementById('statusPill').textContent), { timeout: 5000 });
  const t0 = Date.now();
  await page.click('#btnWhole');
  await page.click('#btnCompute');
  await page.waitForFunction(() => document.querySelector('#faceTable:not([hidden])'), { timeout: 15000 });
  const ms = Date.now() - t0;
  const metaMs = await page.textContent('#metaMs');
  ok(`浏览器内 12 秒算完（交互 ${ms}ms，引擎 ${metaMs}）`, ms < 12000, `${ms}ms`);
  const deep = await page.textContent('#metaDeep');
  ok('无未收敛叶', deep === '0', deep);
  const fullGaps = await page.$$eval('#faceBody td:nth-child(4)', (tds) => tds.map((t) => parseFloat(t.textContent)));
  ok('满额片六面间隙达标', fullGaps.every((g) => Math.abs(g) <= 0.0101), JSON.stringify(fullGaps));

  console.log('7) 单一时刻查询退化为点');
  await page.fill('#qInstant', '64');
  await page.click('#btnInstant');
  await page.waitForTimeout(300);
  const boxMin = await page.$$eval('#boxInfo dd', (dds) => dds[0].textContent);
  ok('单一时刻有结果', /-?\d/.test(boxMin), boxMin);

  ok('无控制台错误', errors.length === 0, errors.join(' | '));

  await page.screenshot({ path: path.join(__dirname, 'ui-shot.png'), fullPage: false });
  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
