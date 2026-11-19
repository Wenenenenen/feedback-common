/* 无头浏览器端到端测试：真实加载 index.html，验证渲染与交互 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(
  require('os').homedir(),
  '.nvm/versions/node/v22.23.2/lib/node_modules/playwright'));

const FILE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(FILE_URL);
  await page.waitForTimeout(300);

  console.log('== 初始渲染 ==');
  check(await page.locator('#statusBar').innerText() !== '', '状态栏有内容');
  const status = await page.locator('#statusBar').innerText();
  console.log('   ', status.replace(/\s+/g, ' '));
  check(status.includes('接触'), '状态栏显示接触统计');
  check(await page.locator('.contact-row').count() === 1, '接触列表 1 行');
  check(await page.locator('#sceneCanvas').screenshot().then(b => b.length > 2000),
    '画布有实际绘制内容');

  console.log('== 播放与时间控制 ==');
  await page.locator('#btnPlay').click();
  await page.waitForTimeout(400);
  await page.locator('#btnPlay').click();
  const t1 = parseFloat(await page.locator('#timeInput').inputValue());
  check(t1 > 0 && t1 <= 1, '播放后时间推进 t=' + t1);
  await page.fill('#timeInput', '0.5');
  await page.locator('#timeInput').dispatchEvent('change');
  check(await page.locator('#timeInput').inputValue() === '0.5', '帧内时间输入生效');
  await page.locator('#btnNext').click();
  check(await page.locator('#timeInput').inputValue() === '0', '逐帧前进循环回 0');

  console.log('== 选中接触对与逐轴面板 ==');
  await page.locator('.contact-row').first().click();
  await page.waitForTimeout(100);
  const axesText = await page.locator('#axesPanel').innerText();
  check(axesText.includes('进入限制'), '显示进入限制轴');
  check(axesText.includes('离开限制'), '显示离开限制轴');
  check(axesText.includes('u=('), '显示轴单位向量');
  check(await page.locator('.axis-row').count() === 8, '方块对共 8 条边法线轴');
  check(await page.locator('.proj-bar').count() === 8, '8 个投影条');

  console.log('== 对照面板 ==');
  const cmp = await page.locator('#comparePanel').innerText();
  check(cmp.includes('全量精测'), '含全量精测基准');
  check(cmp.includes('漏报'), '含漏报统计');

  console.log('== 场景切换（各内置场景）==');
  const sceneCount = await page.locator('#sceneSelect option').count();
  check(sceneCount === 6, '6 个内置场景，实际 ' + sceneCount);
  for (let i = 0; i < sceneCount; i++) {
    await page.locator('#sceneSelect').selectOption(String(i));
    await page.waitForTimeout(50);
    const name = await page.locator('#sceneSelect option').nth(i).innerText();
    const st = await page.locator('#statusBar').innerText();
    console.log('   ', name, '→', st.replace(/\s+/g, ' ').slice(0, 80));
  }
  // 切到等速分离（0 接触）
  await page.locator('#sceneSelect').selectOption('3');
  await page.waitForTimeout(50);
  check(await page.locator('.contact-row').count() === 0, '等速分离场景无接触行');
  check((await page.locator('#contactList').innerText()).includes('无接触'), '显示无接触提示');
  // 传感器场景
  await page.locator('#sceneSelect').selectOption('5');
  await page.waitForTimeout(50);
  check(await page.locator('.sensor-pill').count() >= 1, '传感器场景显示传感器标记');

  console.log('== 物体编辑 ==');
  await page.locator('#sceneSelect').selectOption('0');
  await page.waitForTimeout(50);
  await page.locator('#btnAddBody').click();
  await page.waitForTimeout(50);
  check(await page.locator('.body-row').count() === 3, '新建后 3 个物体');
  await page.fill('#edPosX', '20');
  await page.locator('#editorForm').evaluate(f => f.dispatchEvent(
    new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(50);
  const st2 = await page.locator('#statusBar').innerText();
  check(st2.includes('3'), '编辑后状态栏反映 3 物体');
  // 非法顶点（凹多边形）
  await page.fill('#edVerts', '0,0\n2,0\n1,0.5\n2,2\n0,2');
  await page.locator('#editorForm').evaluate(f => f.dispatchEvent(
    new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(50);
  check((await page.locator('#statusBar').innerText()).includes('校验未通过'),
    '凹多边形被校验拦截');

  console.log('== 导出 ==');
  // 恢复合法数据：重新加载场景
  await page.locator('#sceneSelect').selectOption('0');
  await page.waitForTimeout(50);
  await page.locator('#btnExportResult').click();
  await page.waitForTimeout(100);
  const buf = await page.locator('#exportBuffer').inputValue();
  const parsed = JSON.parse(buf);
  check(Array.isArray(parsed.contacts) && parsed.contacts.length === 1,
    '导出结果含 1 条接触');
  const r = parsed.contacts[0];
  check(r.tEnter === 0.4 && r.tExit === 0.6 &&
    Math.abs(r.normal[0] + 1) < 1e-8 && r.normal[1] === 0,
    '导出字段符合规范（无调试字段）：' + JSON.stringify(r));
  check(!('_axes' in r) && !('a' in r && '_rawL' in r), '导出记录已剥离调试字段');

  console.log('== 导入结果对照（构造差异）==');
  const tweaked = JSON.stringify({
    dt: 1,
    contacts: [Object.assign({}, r, { tEnter: 0.99 }),
      { a: 'a', b: 'ghost', tEnter: 0, tExit: 1, startOverlap: true,
        normal: [1, 0], sensor: false }]
  });
  await page.evaluate(text => {
    const app = window.__app || null;
    return app;
  }, tweaked);
  // 通过 File API 无法直接构造，改用 app 实例方法验证差异逻辑
  const diffResult = await page.evaluate(text => {
    // app 在闭包内不可达，这里用 UI 的导入处理函数同样路径：直接 fetch 不行，
    // 改用 DataTransfer 构造文件输入
    const file = new File([text], 'r.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileResult');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, tweaked);
  await page.waitForTimeout(200);
  const cmp2 = await page.locator('#comparePanel').innerText();
  check(cmp2.includes('导入结果对照'), '显示导入结果对照区');
  check(cmp2.includes('字段值不一致') || cmp2.includes('多报'), '标出差异对');

  console.log('== 移动端布局 ==');
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(300);
  const scrollW = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth, document.body.scrollWidth));
  check(scrollW <= 400, '窄屏无横向滚动（scrollWidth=' + scrollW + '）');
  await page.setViewportSize({ width: 1400, height: 950 });

  console.log('== 控制台错误 ==');
  check(errors.length === 0, '无控制台错误：' + (errors.join(' | ') || '无'));

  await page.screenshot({ path: path.join(__dirname, 'screenshot-desktop.png'), fullPage: false });
  await browser.close();
  console.log('\n' + (failures === 0 ? '端到端测试全部通过 ✓' : failures + ' 项失败 ✗'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
