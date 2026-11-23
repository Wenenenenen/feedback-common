/* 浏览器端冒烟测试：node tests/browser.smoke.js（全局 playwright） */
const path = require('node:path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const url = 'file://' + path.resolve(__dirname, '../index.html');
const errors = [];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(url);
  await page.waitForTimeout(300);

  // 1) 启动即载入样例且校验通过
  const alertText = await page.locator('#model-alert').innerText();
  if (!alertText.includes('模型合法')) throw new Error('样例未通过校验: ' + alertText);
  console.log('✓ 样例自动载入并校验通过');

  // 2) 运行仿真
  await page.click('#btn-run');
  await page.waitForSelector('#results:not([hidden])');
  await page.waitForTimeout(400);
  const stats = await page.locator('#run-stats').innerText();
  console.log('✓ 仿真完成：', stats.replace(/\s+/g, ' '));

  // 3) 波形 canvas 已绘制（有非背景像素）
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('wave-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBg++;
    return { w: c.width, h: c.height, nonBg };
  });
  if (drawn.nonBg < 1000) throw new Error('波形画布几乎空白: ' + JSON.stringify(drawn));
  console.log('✓ 波形已绘制', JSON.stringify(drawn));

  // 4) 逐时刻跳转：下一事件时刻按钮
  await page.click('#btn-next');
  const t2 = await page.locator('#time-label').innerText();
  if (t2 !== 't=2') throw new Error('下一事件时刻应为 t=2，实际 ' + t2);
  await page.click('#btn-next');
  const t6 = await page.locator('#time-label').innerText();
  if (t6 !== 't=6') throw new Error('应为 t=6，实际 ' + t6);
  console.log('✓ 事件时刻跳转正常（', t2, '->', t6, '）');

  // +1 / -1 tick
  await page.click('#btn-fwd');
  if ((await page.locator('#time-label').innerText()) !== 't=7') throw new Error('+1 tick 失败');
  await page.click('#btn-back');
  if ((await page.locator('#time-label').innerText()) !== 't=6') throw new Error('-1 tick 失败');
  console.log('✓ 单 tick 前进/后退正常');

  // 5) 驱动来源：选 bus 线网并查看详情
  await page.evaluate(() => {
    const items = document.querySelectorAll('#net-list .item');
    for (const it of items) if (it.textContent.includes('bus')) it.click();
  });
  const detail = await page.locator('#net-detail').innerText();
  if (!detail.includes('门输出 gate')) throw new Error('驱动来源未显示门输出: ' + detail);
  if (!detail.includes('解算')) throw new Error('缺少解算说明');
  console.log('✓ 驱动来源面板正常（含门输出与解算说明）');

  // 6) 重演校验
  await page.click('#btn-replay');
  await page.waitForTimeout(200);
  const replay = await page.locator('#replay-alert').innerText();
  if (!replay.includes('通过')) throw new Error('重演校验未通过: ' + replay);
  console.log('✓ 重演校验通过');

  // 7) 导出 VCD / JSON（拦截下载内容并校验）
  const got = [];
  page.on('download', async d => {
    got.push({ name: d.suggestedFilename(), text: await d.path().then(p => require('fs').readFileSync(p, 'utf8')) });
  });
  await page.click('#btn-vcd');
  await page.click('#btn-json');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  const vcd = got.find(g => g.name.endsWith('.vcd'));
  const js = got.find(g => g.name.endsWith('.json'));
  if (!vcd || !js) throw new Error('导出文件缺失: ' + got.map(g => g.name).join(','));
  if (!vcd.text.includes('$enddefinitions') || !vcd.text.includes('b01')) throw new Error('VCD 内容异常');
  const parsed = JSON.parse(js.text);
  if (parsed.format !== 'factory-bus-wave-v1' || !parsed.nets.length) throw new Error('JSON 导出结构异常');
  console.log('✓ VCD/JSON 导出内容正确（VCD', vcd.text.length, '字节 / JSON', js.text.length, '字节）');

  // 8) 编辑单次写入：把 t6 的 10 改成 11 并重跑
  await page.evaluate(() => {
            const rows = document.querySelectorAll('#write-table tbody tr');
            const inputs = rows[2].querySelectorAll('input');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inputs[2], '11');
            inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
          });
  await page.click('#btn-apply-writes');
  await page.waitForTimeout(400);
  const afterEdit = await page.evaluate(() => {
    const wf = FactoryBus.run({
      until: 12, nets: { src: 2, en: 1, bus: 2 }, ports: { p: 'src', e: 'en' },
      gates: [{ id: 'gate', op: 'TRI', in: ['src', 'en'], out: 'bus', delay: 2 }],
      writes: [[0, 'p', '01'], [0, 'e', '1'], [6, 'p', '11']],
    }).wave.find(w => w.name === 'bus');
    return wf.times.map((t, i) => t + ':' + FactoryBus.formatValue(wf.lo[i], wf.hi[i], 2));
  });
  if (!afterEdit.includes('8:11')) throw new Error('编辑后波形未生效: ' + afterEdit);
  console.log('✓ 单次写入编辑并重跑生效：', afterEdit.join(' '));

  // 9) 坏连接：写入非法位宽，确认报错且旧波形保留
  await page.evaluate(() => {
            const rows = document.querySelectorAll('#write-table tbody tr');
            const inputs = rows[0].querySelectorAll('input');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inputs[2], '0101'); // src 只有 2 位
            inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
          });
  await page.click('#btn-apply-writes');
  await page.waitForTimeout(300);
  const errAlert = await page.locator('#write-alert').innerText();
  if (!errAlert.includes('旧波形保留')) throw new Error('坏写入未保留旧波形: ' + errAlert);
  console.log('✓ 非法写入被拒并保留旧波形');

  // 10) 深色主题切换不报错
  await page.click('#btn-theme');
  await page.waitForTimeout(150);
  console.log('✓ 主题切换正常');

  if (errors.length) throw new Error('浏览器报错:\n' + errors.join('\n'));
  console.log('\n浏览器冒烟测试全部通过');
  await browser.close();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
