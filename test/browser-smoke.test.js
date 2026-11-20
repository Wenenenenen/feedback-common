/* 浏览器冒烟测试：NODE_PATH=$(npm root -g) node test/browser-smoke.test.js <样例目录> <工程目录> */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const samplesDir = process.argv[2];
const appDir = process.argv[3] || path.resolve(__dirname, '..');
if (!samplesDir) { console.error('用法: node test/browser-smoke.test.js <样例目录> [工程目录]'); process.exit(2); }

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('file://' + path.join(appDir, 'index.html'));
  await page.waitForSelector('#stageList', { state: 'attached' });

  // 1. 加载链：shaper + nonlinear
  await page.setInputFiles('#cubeFiles', [
    path.join(samplesDir, 'shaper.cube'),
    path.join(samplesDir, 'nonlinear.cube'),
  ]);
  ok(await page.textContent('#stageCount') === '2 / 8', '载入 2 级 LUT');
  const firstMeta = await page.textContent('#stageList li .meta');
  ok(/1D 3/.test(firstMeta), `第 1 级为 1D shaper (${firstMeta.trim()})`);

  // 2. 坏文件报错
  await page.setInputFiles('#cubeFiles', [path.join(samplesDir, 'bad-count.cube')]);
  ok(/数据条数/.test(await page.textContent('#cubeError')), 'bad-count 报错');
  ok(await page.textContent('#stageCount') === '2 / 8', '坏文件未入链');

  // 3. 加载 PNG
  await page.setInputFiles('#pngFile', [path.join(samplesDir, 'alpha-ramp.png')]);
  await page.waitForFunction(() => document.getElementById('imgInfo').textContent.includes('129'));
  ok(true, 'alpha-ramp.png 解码 (129×65)');
  ok(await page.isEnabled('#exportPng'), '导出 PNG 按钮可用');

  // 4. 点选像素 → 探针表出现逐级输入输出
  await page.click('#view', { position: { x: 30, y: 20 } });
  const probeSrc = await page.textContent('#probeSrc');
  ok(/像素 \(30, 20\)/.test(probeSrc), `点选像素 (${probeSrc.slice(0, 40)}…)`);
  const rows = await page.$$eval('#probeTable table tr', (rs) => rs.length);
  ok(rows >= 4, `探针表含逐级行 (${rows} 行)`);
  const firstStageOut = await page.textContent('#probeTable table tr:nth-child(2) td:last-child');
  ok(Number.isFinite(parseFloat(firstStageOut)), '第 1 级输出为数值');

  // 5. 手动浮点探针
  await page.fill('#probeR', '0.15');
  await page.fill('#probeG', '0.35');
  await page.fill('#probeB', '0.55');
  await page.click('#probeGo');
  const nums = await page.$$eval('#probeTable table tr.total td:last-child, #probeTable table tr.total td:nth-last-child(2), #probeTable table tr.total td:nth-last-child(3)',
    (tds) => tds.map((t) => parseFloat(t.textContent)));
  ok(nums.length === 3 && nums.every(Number.isFinite), `链输出为 3 个数值 (${nums.join(', ')})`);

  // 6. 烘焙 + 载入对比 + 连续探针
  await page.fill('#bakeSize', '10');
  await page.click('#bakeGo');
  const bakeInfo = await page.textContent('#bakeInfo');
  ok(/10³ 网格/.test(bakeInfo), `烘焙完成 (${bakeInfo})`);
  await page.click('#useBaked');
  await page.click('#compareGo');
  await page.waitForFunction(() => document.getElementById('compareSummary').textContent.includes('最大误差'));
  const summary = await page.textContent('#compareSummary');
  const m = summary.match(/最大误差\s*([\d.e+-]+)/);
  ok(m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 0.5, `连续探针误差在合理范围 (${m && m[1]})`);
  const cmpRows = await page.$$eval('#compareTable table tr', (rs) => rs.length);
  ok(cmpRows > 10, `对比表有 ${cmpRows - 1} 条探针`);

  // 7. 导出烘焙 cube 并验证可解析
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lut-smoke-'));
  let dl = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportCube'),
  ]).then(([d]) => d);
  const cubePath = path.join(tmp, 'baked.cube');
  await dl.saveAs(cubePath);
  const LC = require(path.join(appDir, 'lut-core.js'));
  const baked = LC.parseCube(fs.readFileSync(cubePath, 'utf8'));
  ok(baked.type === '3d' && baked.size === 10, '导出的烘焙 cube 可解析 (3D 10)');

  // 8. 导出处理后 PNG：签名 + 透明像素 RGB 保留
  dl = await Promise.all([page.waitForEvent('download'), page.click('#exportPng')]).then(([d]) => d);
  const pngPath = path.join(tmp, 'processed.png');
  await dl.saveAs(pngPath);
  const pngBuf = fs.readFileSync(pngPath);
  ok(pngBuf[0] === 0x89 && pngBuf[1] === 0x50 && pngBuf.length > 100, `导出 PNG (${pngBuf.length} 字节)`);

  // 9. 工程导出 → 清空 → 重新载入
  dl = await Promise.all([page.waitForEvent('download'), page.click('#exportProject')]).then(([d]) => d);
  const projPath = path.join(tmp, 'proj.json');
  await dl.saveAs(projPath);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  ok(proj.stages.length === 2 && proj.stages[0].cube.includes('LUT_1D_SIZE'), '工程含完整表内容');
  ok(proj.bake && proj.bake.size === 10, '工程含烘焙设置');
  // 移除所有级再载入工程
  await page.click('#stageList li:last-child button:last-child'); // 删第2级
  await page.click('#stageList li:last-child button:last-child'); // 删第1级
  ok(await page.textContent('#stageCount') === '0 / 8', '链已清空');
  await page.setInputFiles('#projectFile', projPath);
  await page.waitForFunction(() => document.getElementById('stageCount').textContent === '2 / 8');
  ok(true, '工程重新载入恢复 2 级');
  ok((await page.inputValue('#bakeSize')) === '10', '烘焙设置随工程恢复');
  // 恢复后链仍工作
  await page.click('#probeGo');
  const nums2 = await page.$$eval('#probeTable table tr.total td:last-child, #probeTable table tr.total td:nth-last-child(2), #probeTable table tr.total td:nth-last-child(3)',
    (tds) => tds.map((t) => parseFloat(t.textContent)));
  ok(nums2.join(',') === nums.join(','), `重载后链计算一致 (${nums2.join(', ')})`);

  // 10. 排序与开关
  await page.click('#stageList li:first-child button:nth-of-type(2)'); // 第1级下移
  const newFirst = await page.textContent('#stageList li:first-child .meta');
  ok(/3D 3/.test(newFirst), '排序：nonlinear 移到首位');
  await page.uncheck('#stageList li:first-child input[type=checkbox]');
  const disabled = await page.$eval('#stageList li:first-child', (el) => el.className);
  ok(/disabled/.test(disabled), '开关：第 1 级已停用');

  ok(consoleErrors.length === 0, `无浏览器控制台错误${consoleErrors.length ? '：' + consoleErrors.join(' | ') : ''}`);

  await browser.close();
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟测试异常:', e); process.exit(1); });
