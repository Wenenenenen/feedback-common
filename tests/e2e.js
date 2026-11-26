'use strict';
/* 端到端：真实浏览器里驱动 index.html，验证 UI 与引擎联动 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');

const APP = 'file://' + path.resolve(__dirname, '..', 'app', 'index.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra || ''); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(APP);

  // 1. 空态存在，工作区隐藏
  check('初始空态显示', await page.isVisible('#dropzone'));
  check('工作区初始隐藏', await page.isHidden('#workspace'));

  // 2. 载入内嵌样例
  await page.click('#btnLoadSample');
  await sleep(200);
  check('样例加载后工作区可见', await page.isVisible('#workspace'));
  check('探针数提示 2 条', (await page.textContent('#probeHint')).includes('2'));

  // 3. 运行探针并核对字段（draw0 instance0 corner0）
  await page.click('#btnRunProbes');
  await sleep(100);
  check('探针耗时提示出现', (await page.textContent('#probeHint')).includes('ms'));
  const rows = await page.$$eval('#probeTable tbody tr', trs => trs.length);
  check('探针结果 2 行', rows === 2, 'rows=' + rows);
  const row0 = await page.$eval('#probeTable tbody tr', tr => tr.innerText);
  check('第一行 vertex=0 正常', /\b0\b/.test(row0) && row0.includes('正常'), row0);

  // 导出 JSON 并核对结构与样例约定字段
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExport')
  ]);
  const exported = fs.readFileSync(await download.path(), 'utf8');
  const arr = JSON.parse(exported);
  check('导出为 2 条 JSON 数组', Array.isArray(arr) && arr.length === 2);
  const p0 = arr[0];
  check('探针保留输入三编号', p0.draw === 0 && p0.instance === 0 && p0.corner === 0);
  check('含 vertex/skipped/fields', 'vertex' in p0 && 'skipped' in p0 && 'fields' in p0);
  for (const f of ['index', 'position', 'color', 'offset']) {
    check('字段 ' + f + ' 六件套齐全',
      ['buffer', 'address', 'hex', 'value', 'writers', 'error'].every(k => k in p0.fields[f]));
  }
  check('position 值为两个分量', p0.fields.position.value.length === 2);
  check('writers 为按地址数组且初始 -1', p0.fields.position.writers.every(w => w === -1));
  check('hex 为小写', p0.fields.position.hex === p0.fields.position.hex.toLowerCase());
  // draw2 的 color 前三字节 writer=1
  const p1 = arr[1];
  check('draw2 color 前三字节最后写入命令为 #1',
    p1.draw === 2 && p1.fields.color.writers.slice(0, 3).every(w => w === 1) &&
    p1.fields.color.writers[3] === -1);
  check('实例1 offset 槽正确（0.9）', Math.abs(p1.fields.offset.value[0] - 0.9) < 1e-7);

  // 4. 点选角点 -> 详情出现原始字节/地址/命令号
  await page.click('#probeTable tbody tr');
  await sleep(150);
  check('角详情出现字节格', await page.$$eval('.bytecell', els => els.length) > 0);
  check('详情含地址数字', (await page.textContent('#cornerDetail')).includes('地址'));
  check('详情含“命令#”或“初始”', /命令#|初始/.test(await page.textContent('#cornerDetail')));
  check('角标签更新', (await page.textContent('#cornerLabel')).includes('角'));

  // 5. 切到 draw#2，write 已生效
  await page.click('#btnNextDraw');
  await sleep(150);
  const drawLabel = await page.textContent('#drawLabel');
  check('切换到 draw #2', drawLabel.includes('#2'), drawLabel);

  // 6. 实例切换
  const instOpts = await page.$$eval('#instSelect option', os => os.length);
  check('实例数=2', instOpts === 2);
  await page.selectOption('#instSelect', '1');
  await sleep(100);

  // 7. 非法抓帧：应报错且保留旧帧
  const bad = JSON.stringify({
    buffers: { b: '00' },
    commands: [{ op: 'copy', src: 'b', dst: 'b', from: 0, at: 0, size: 99 }]
  });
  await page.evaluate((text) => {
    window.__bad = text;
  }, bad);
  await page.setInputFiles('#fileCapture', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(bad)
  });
  await sleep(200);
  const errText = await page.textContent('#loadError');
  check('非法命令指出编号 #0', errText.includes('#0') && errText.includes('越界'), errText);
  check('旧抓帧保留（工作区仍可见）', await page.isVisible('#workspace'));
  check('时间线仍是样例的 3 条命令', (await page.textContent('#cmdCount')).includes('3'));

  // 8. 非法探针整批拒绝
  const badProbe = JSON.stringify([{ draw: 999, instance: 0, corner: 0 }]);
  await page.setInputFiles('#fileProbes', {
    name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(badProbe)
  });
  await sleep(150);
  check('非法探针报错', (await page.textContent('#probeError')).includes('不是有效的绘制'));

  // 9. 主题切换无报错
  await page.click('#btnTheme');
  await sleep(50);
  check('主题切换生效', await page.$eval(':root', el => el.dataset.theme === 'dark' || el.dataset.theme === 'light'));

  // 10. 无控制台错误
  check('无 JS 控制台错误', errors.length === 0, errors.join(' | '));

  // 11. 窄屏不横向溢出
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('400px 窄屏无横向滚动', !overflow,
    'sw=' + await page.evaluate(() => document.documentElement.scrollWidth));

  await page.screenshot({ path: path.resolve(__dirname, '..', 'tests', 'shot-desktop.png'), fullPage: false });
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
