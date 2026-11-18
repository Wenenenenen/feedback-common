/* 真实浏览器冒烟测试：渲染、逐层查看、选盒联动、孔洞重算、改盒、导出、主题 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const path = require('path');

const URL = 'file://' + path.join(__dirname, '..', 'web', 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL);
  await sleep(300);

  /* 1. 首屏自动加载 odd-standard，统计与判定正确 */
  const modeText = await page.textContent('#modeText');
  console.log('mode pill:', modeText);
  const verdicts = await page.textContent('#stVerdicts');
  console.log('verdicts:', verdicts);
  const consistency = await page.textContent('#consistencyPill');
  console.log('consistency:', consistency.trim());
  if (!consistency.includes('一致')) throw new Error('一致性徽章异常');

  /* 2. 逐层查看金字塔 */
  const levelCount = await page.$$eval('#levelTabs button', bs => bs.length);
  console.log('pyramid levels:', levelCount);
  for (let i = 0; i < levelCount; i++) {
    await page.click(`#levelTabs button[data-lvl="${i}"]`);
    const meta = await page.textContent('#pyrMeta');
    if (!meta.includes(`Level ${i}`)) throw new Error('层切换失败 L' + i);
  }

  /* 3. 选盒联动：点 blocked 行 */
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    tr.click();
  });
  await sleep(100);
  const detail = await page.textContent('#boxDetail');
  if (!detail.includes('occluded')) throw new Error('blocked 盒详情未显示 occluded');
  const traceNodes = await page.$$eval('#traceBox .node', ns => ns.length);
  console.log('blocked trace nodes:', traceNodes);
  if (traceNodes < 1) throw new Error('查询轨迹为空');
  const usedTags = await page.$$eval('#traceBox .node.used', ns => ns.length);
  console.log('consumed nodes:', usedTags);

  /* 4. 切到反向深度样例 */
  await page.selectOption('#sampleSelect', 'odd-reversed');
  await sleep(200);
  const revMode = await page.textContent('#modeText');
  if (!revMode.includes('reversed')) throw new Error('反向模式未切换');
  const revBlocked = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    return tr.querySelector('.badge').textContent;
  });
  console.log('reversed blocked badge:', revBlocked);
  if (revBlocked !== 'occluded') throw new Error('反向 blocked 应为 occluded');

  /* 5. 孔洞绘制：切回普通样例，在 blocked 矩形上画清屏值，应变 visible */
  await page.selectOption('#sampleSelect', 'odd-standard');
  await sleep(200);
  const before = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    return tr.querySelector('.badge').textContent;
  });
  await page.click('#toolSeg button[data-tool="paint"]');
  const box = await page.locator('#pyrCanvas').boundingBox();
  // blocked 矩形 [0,4,2,5] 在 7 宽图上 -> 左上角约 0..2/7, 4..5/5
  await page.mouse.move(box.x + box.width * 0.07, box.y + box.height * 0.85);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) {
    await page.mouse.move(box.x + box.width * (0.05 + i * 0.03), box.y + box.height * (0.82 + (i % 2) * 0.05));
  }
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    return tr.querySelector('.badge').textContent;
  });
  console.log('paint before/after:', before, '/', after);
  const holes = await page.textContent('#pyrMeta');
  console.log('meta after paint:', holes);

  /* 6. 清除孔洞恢复 */
  await page.click('#clearHolesBtn');
  await sleep(150);
  const restored = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    return tr.querySelector('.badge').textContent;
  });
  console.log('after clear:', restored);
  if (restored !== 'occluded') throw new Error('清孔洞后应恢复 occluded');

  /* 7. 编辑盒：把 blocked 盒拉远（改 min/max z），观察重算 */
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    tr.click();
  });
  await page.fill('#minZ', '0.1'); await page.fill('#maxZ', '0.2');
  await page.click('#applyBoxBtn');
  await sleep(150);
  const edited = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#boxTbody tr')].find(t => t.dataset.id === 'blocked');
    return tr.querySelector('.badge').textContent;
  });
  console.log('after editing box z to near plane:', edited);
  if (edited !== 'visible') throw new Error('近深度盒应 visible（等深/更近），得到 ' + edited);

  /* 8. 压力案例：访问次数对比显示 */
  await page.selectOption('#sampleSelect', 'stress');
  await sleep(400);
  const pyr = await page.textContent('#stPyr');
  const exh = await page.textContent('#stExh');
  console.log('stress pyramid visits:', pyr, 'exhaustive:', exh);
  if (!pyr.includes('278,491')) throw new Error('压力案例金字塔访问数不符: ' + pyr);
  if (!exh.includes('1,082,745')) throw new Error('压力案例穷举数不符: ' + exh);
  const rowsShown = await page.$$eval('#boxTbody tr', rs => rs.length);
  const capNote = await page.textContent('#rowCapNote');
  console.log('rows shown:', rowsShown, '|', capNote);

  /* 9. 过滤器 */
  await page.selectOption('#verdictFilter', 'visible');
  await sleep(100);
  const visibleRows = await page.$$eval('#boxTbody tr', rs => rs.length);
  console.log('visible-filtered rows:', visibleRows);
  if (visibleRows !== 8) throw new Error('visible 过滤应为 8 行');
  await page.selectOption('#verdictFilter', '');
  await page.fill('#boxFilter', '199');
  const matched = await page.$$eval('#boxTbody tr', rs => rs.map(r => r.dataset.id));
  console.log('id filter 199 matches:', matched.join(','));
  await page.fill('#boxFilter', '');

  /* 10. 导出 JSON 结构 */
  await page.click('#exportBtn');
  await sleep(200);
  const exportText = await page.evaluate(() => document.querySelector('#exportOverlay textarea').value);
  const parsed = JSON.parse(exportText);
  console.log('export schema:', parsed.schema, '| boxes:', parsed.boxes.length,
    '| summary:', JSON.stringify(parsed.summary));
  if (parsed.boxes[0].visited_nodes === undefined) throw new Error('导出缺少 visited_nodes');
  if (parsed.summary.pyramid_visits_total !== 278491) throw new Error('导出汇总访问数不符');
  const sampleNode = parsed.boxes.find(b => b.visited_nodes.length);
  console.log('sample visited node:', JSON.stringify(sampleNode.visited_nodes[0]));
  await page.click('#closeExport');

  /* 11. 保存/重载（localStorage） */
  await page.selectOption('#sampleSelect', 'odd-standard');
  await sleep(200);
  await page.click('#saveInputBtn');
  const saved = await page.evaluate(() => localStorage.getItem('hiz-culler-input-v1'));
  if (!saved) throw new Error('localStorage 未保存');
  await page.selectOption('#sampleSelect', 'stress');
  await sleep(300);
  await page.click('#loadSavedBtn');
  await sleep(300);
  const reloadName = await page.textContent('#datasetName');
  console.log('reloaded dataset:', reloadName);
  if (!reloadName.includes('odd-standard')) throw new Error('重载未回到保存的输入');

  /* 12. 主题切换无报错 */
  await page.click('#themeLight'); await sleep(80);
  await page.click('#themeDark'); await sleep(80);
  await page.click('#themeSys');

  /* 13. invalid-depth 报错路径 */
  await page.selectOption('#sampleSelect', 'invalid-depth');
  await sleep(200);
  const errMsg = await page.textContent('#inputMsg');
  if (!errMsg.includes('校验失败') || !errMsg.includes('超出 [0,1]')) throw new Error('非法深度未正确报错');
  console.log('invalid-depth error shown OK');

  /* 14. 移动端窄幅无横向滚动 */
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(200);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);
  console.log('mobile scrollWidth/clientWidth:', scrollW, clientW);
  if (scrollW > clientW + 1) throw new Error('窄幅出现横向滚动');

  if (errors.length) { console.log('\nJS 错误:'); errors.forEach(e => console.log(' -', e)); throw new Error('存在控制台错误'); }
  console.log('\n全部浏览器冒烟测试通过，无控制台错误');
  await browser.close();
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
