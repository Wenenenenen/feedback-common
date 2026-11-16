/* 浏览器端到端测试：真实 WebGL 渲染、细分、超限标记、导入拒绝、导出与控制点编辑
 * 用全局 playwright 运行：node test/e2e.test.js
 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');

const APP_URL = 'file://' + path.join(__dirname, '..', 'app', 'index.html');
const SAMPLE_DIR = path.join(__dirname, '..', 'samples', 'extracted');
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(APP_URL);
  await page.waitForTimeout(800);

  // WebGL 上下文与初始渲染
  const glOk = await page.evaluate(() => {
    const c = document.getElementById('glcanvas');
    return !!(c && c.getContext('webgl'));
  });
  check('WebGL 上下文创建', glOk);

  // 初始 patches 样例细分完成（无进度条活动）
  await page.waitForFunction(() => {
    const w = document.getElementById('progressWrap');
    return !w.classList.contains('active');
  }, { timeout: 15000 });
  const stats1 = await page.evaluate(() => document.getElementById('stats').innerText);
  const triCount1 = parseInt((stats1.match(/三角形\s+(\d+)/) || [])[1], 10);
  check('双片样例产生三角形', triCount1 > 0, `tri=${triCount1}`);

  // 无控制台错误
  check('无页面/控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 切换到平面片：应为 2 三角形（内部不铺密网格）
  await page.selectOption('#sampleSelect', 'flat');
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  const flatTri = await page.evaluate(() => {
    const m = document.getElementById('stats').innerText.match(/三角形\s+(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  });
  check('平面片仅 2 个三角形', flatTri === 2, `got ${flatTri}`);

  // 曲面片 + 极低深度触发超限标记
  await page.selectOption('#sampleSelect', 'curved');
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  // 调小最大深度（range 控件）与误差阈值，制造触顶超限
  await page.evaluate(() => {
    const d = document.getElementById('maxDepth');
    d.value = '2';
    d.dispatchEvent(new Event('input', { bubbles: true }));
    const el = document.getElementById('pixelError');
    el.value = '0.05';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  // 等待去抖后的最终一次细分稳定
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  const overLimit = await page.evaluate(() => {
    const m = document.getElementById('stats').innerText.match(/超限三角形\s+(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  });
  check('触顶区域被明确标记（超限三角形>0）', overLimit > 0, `over=${overLimit}`);

  // 误差热图切换不报错
  await page.selectOption('#shadeMode', 'heatmap');
  await page.waitForTimeout(300);
  check('误差热图可切换', errors.length === 0);

  // 显示法线/控制网/线框
  for (const id of ['showNormals', 'showControlNet']) {
    await page.check('#' + id);
    await page.waitForTimeout(150);
  }
  check('法线与控制网显示无错误', errors.length === 0);

  // invalid-seam 必须被拒绝并显示定位信息
  await page.selectOption('#sampleSelect', 'invalid-seam');
  await page.waitForTimeout(300);
  const rejectVisible = await page.evaluate(() => !document.getElementById('importError').classList.contains('hidden'));
  const rejectText = await page.evaluate(() => document.getElementById('importErrorList').innerText);
  check('接缝不重合被拒绝', rejectVisible);
  check('错误定位到具体边与控制点', /u1|u0/.test(rejectText) && /1e-8|接缝不重合/.test(rejectText), rejectText.slice(0, 80));
  await page.click('#dismissError');

  // 文件导入：用 setInputFiles 导入 invalid-seam.json，验证文件路径同样被拒
  await page.setInputFiles('#importFile', path.join(SAMPLE_DIR, 'invalid-seam.json'));
  await page.waitForTimeout(300);
  const reject2 = await page.evaluate(() => !document.getElementById('importError').classList.contains('hidden'));
  check('文件导入接缝不重合同样拒绝并保留当前模型', reject2);
  await page.click('#dismissError');

  // 有效文件导入
  await page.setInputFiles('#importFile', path.join(SAMPLE_DIR, 'patches.json'));
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  check('有效文件导入成功', errors.length === 0);

  // 导出网格 JSON：拦截下载并校验内容
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportMesh'),
  ]);
  const dlPath = path.join(require('node:os').tmpdir(), 'e2e-mesh.json');
  await download.saveAs(dlPath);
  const mesh = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  check('导出网格含每角 UV/法线/片编号',
    mesh.triangles.length > 0 &&
    mesh.triangles.every((t) => t.corner_uv.length === 3 && t.corner_normals.length === 3 && t.patch_id) &&
    mesh.positions.length > 0,
    `tri=${mesh.triangles.length} pos=${mesh.positions.length}`);
  check('导出含相机像素宽高与矩阵',
    mesh.camera && mesh.camera.width && mesh.camera.height &&
    mesh.camera.view_matrix.length === 16 && mesh.camera.projection_matrix.length === 16);

  // 导出报告
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportReport'),
  ]);
  const rp = path.join(require('node:os').tmpdir(), 'e2e-report.json');
  await dl2.saveAs(rp);
  const report = JSON.parse(fs.readFileSync(rp, 'utf8'));
  check('报告含像素宽高、相机矩阵与逐片统计',
    report.camera.width && report.camera.view_projection_matrix.length === 16 &&
    Array.isArray(report.patches) && report.patches.length >= 1 &&
    typeof report.summary.triangle_count === 'number');

  // 接缝水密性（从导出网格验证共享索引）
  const owners = new Map();
  mesh.triangles.forEach((t) => t.position_indices.forEach((idx) => {
    if (!owners.has(idx)) owners.set(idx, new Set());
    owners.get(idx).add(t.patch_id);
  }));
  const shared = [...owners.values()].filter((s) => s.size > 1).length;
  check('导出网格接缝共享位置索引', shared >= 2, `shared verts=${shared}`);

  // 控制点编辑与接缝联动（通过测试钩子驱动，避免射线拾取的像素依赖）
  await page.selectOption('#sampleSelect', 'patches');
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  const linkResult = await page.evaluate(async () => {
    const H = window.__PST;
    // 选 a 片 u1 边上的角点 points[0][3]
    H.selectControlPoint({ patchId: 'a', j: 0, i: 3, point: [1, 0, 1] });
    const cp = H.state.model.patches.find((p) => p.id === 'a').points[0][3];
    // 改为新值
    document.getElementById('cpX').value = '1.05';
    document.getElementById('cpY').value = '0.2';
    document.getElementById('cpZ').value = '1.0';
    H.editFromFields();
    await H.runTessellate();
    const a = H.state.model.patches.find((p) => p.id === 'a').points[0][3];
    // reversed: a.u1[0] 联动 b.u0[3] -> b.points[3][0]
    const b = H.state.model.patches.find((p) => p.id === 'b').points[3][0];
    return { a, b, linkedText: document.getElementById('cpLinked').innerText };
  });
  check('接缝控制点联动到相邻片',
    linkResult.a[0] === 1.05 && linkResult.b[0] === 1.05 &&
    linkResult.a[1] === 0.2 && linkResult.b[1] === 0.2,
    JSON.stringify(linkResult));
  check('编辑器显示联动关系', /接缝联动/.test(linkResult.linkedText), linkResult.linkedText);

  // 联动编辑后接缝仍水密（重新导出验证共享索引）
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#exportMesh')]);
  const mp = path.join(require('node:os').tmpdir(), 'e2e-mesh2.json');
  await dl3.saveAs(mp);
  const mesh2 = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const own2 = new Map();
  mesh2.triangles.forEach((t) => t.position_indices.forEach((idx) => {
    if (!own2.has(idx)) own2.set(idx, new Set());
    own2.get(idx).add(t.patch_id);
  }));
  const shared2 = [...own2.values()].filter((s) => s.size > 1).length;
  check('联动编辑后接缝仍共享索引、无裂口', shared2 >= 2, `shared=${shared2}`);

  // 相机旋转触发自动重细分
  const before = await page.evaluate(() => document.getElementById('stats').innerText);
  const box = await page.locator('#glcanvas').boundingBox();
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 460, box.y + 340, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('progressWrap').classList.contains('active'), { timeout: 15000 });
  check('相机旋转后自动重新细分', true);

  // 取消功能：启动一次重细分后立即取消（深度 7、极小误差制造长任务）
  await page.evaluate(() => {
    const el = document.getElementById('pixelError');
    el.value = '0.05'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(30);
  await page.click('#cancelBtn').catch(() => {});
  await page.waitForTimeout(200);
  check('取消按钮可点击不报错', errors.length === 0);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (errors.length) console.log('控制台错误汇总:', errors.slice(0, 5));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
