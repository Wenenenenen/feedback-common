/* 浏览器端冒烟测试：加载页面、检查渲染、交互编辑、导出结构。 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto('http://localhost:8123/index.html');
  await page.waitForTimeout(600);

  // 初始加载 case1
  const stats1 = await page.locator('#statsBox').innerText();
  console.log('case1 stats:\n' + stats1.replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/shot_case1_slice.png' });

  // 切到 case2（双壳空腔）
  await page.selectOption('#sampleSelect', 'case2_hollow_double_shell');
  await page.waitForTimeout(400);
  const comps = await page.locator('#compTable').innerText();
  console.log('\ncase2 components:\n' + comps.replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/shot_case2.png' });

  // case3 + 切 6 连通/26 漫水参数，查 3D
  await page.selectOption('#sampleSelect', 'case3_slanted_thin_wall');
  await page.waitForTimeout(300);
  await page.click('button[data-tab="3d"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/shot_case3_3d.png' });
  const mode = await page.locator('#renderMode').innerText();
  console.log('\n3D render mode:', mode);

  // 回到切片，做一次框选填充：直接在 slice canvas 中心拖拽
  await page.click('button[data-tab="slice"]');
  await page.waitForTimeout(200);
  const box = await page.locator('#sliceCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const stack = await page.locator('#editStack').innerText();
  console.log('after box edit:', stack);

  // 撤销
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  const stack2 = await page.locator('#editStack').innerText();
  console.log('after undo:', stack2);

  // 一致性自检
  await page.click('#btnVerify');
  await page.waitForTimeout(500);
  const toast = await page.locator('.toast').last().innerText();
  console.log('verify toast:', toast.replace(/\n/g, ' '));

  // 导出 JSON 结构
  const exported = await page.evaluate(async () => {
    const blob = await new Promise((resolve) => {
      // 复用引擎全局状态，直接调用 exportJSON
      resolve(window.VF.exportJSON(window.__st || null));
    });
    return blob;
  }).catch(() => null);
  // st 是闭包内变量，改为验证下载：拦截
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExport'),
  ]);
  const path = '/tmp/export.json';
  await dl.saveAs(path);
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  const required = ['meshId', 'separatingMode', 'floodConnectivity', 'dims', 'spacing',
    'counts', 'materialHistogram', 'diagonalLeaks', 'enclosedComponents'];
  const missing = required.filter((k) => !(k in j));
  console.log('\nexport keys ok:', missing.length === 0, 'missing:', missing);
  console.log('export counts:', JSON.stringify(j.counts));

  // 切模式：薄壳 + 26 漫水，加载陡斜验证漏孔面板——用 case3 切参数
  await page.selectOption('#selMode', '6-separating');
  await page.selectOption('#selFlood', '26');
  await page.waitForTimeout(300);
  await page.click('button[data-tab="comps"]');
  await page.waitForTimeout(200);
  const leakSummary = await page.locator('#leakSummary').innerText();
  console.log('leak panel:', leakSummary);

  // 非法文件导入：构造非法 JSON 并注入文件选择
  const bad = JSON.stringify({
    meshId: 'bad', grid: { origin: [0, 0, 0], dims: [10, 10, 10], spacing: [1, 0, 1] },
    separatingMode: '6-separating', floodConnectivity: 6, vertices: [[0, 0, 0]],
    triangles: [{ id: 0, indices: [0, 0, 0], material: 20, group: 'g', enabled: true }], edits: [],
  });
  await page.setInputFiles('#fileInput', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  await page.waitForTimeout(400);
  const errToast = await page.locator('.toast.error').last().innerText();
  console.log('\nreject toast:\n' + errToast);
  // 原结果仍可用：统计仍在
  const statsStill = await page.locator('#statsBox b').first().innerText();
  console.log('previous result still available, first stat =', statsStill);

  await page.screenshot({ path: '/tmp/shot_final.png' });
  console.log('\nconsole errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
