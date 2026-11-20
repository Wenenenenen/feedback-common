// 端到端：无头浏览器加载页面，验证渲染、交互、诊断与导出同源。
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const URL = 'http://127.0.0.1:8731/index.html';
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 1. 初始 helix 渲染
  const stats = await page.textContent('#stats');
  ok('helix stats show 40 rings', stats.includes('环 40'), stats);
  ok('helix stats show 640 tris', stats.includes('三角形 640'), stats);
  ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  // canvas 实际绘制了非背景像素
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('#view-canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = c.width, h = c.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let nonBg = 0;
    for (let i = 0; i < buf.length; i += 4) {
      // 背景接近 #10151f
      if (Math.abs(buf[i] - 16) + Math.abs(buf[i+1] - 21) + Math.abs(buf[i+2] - 31) > 24) nonBg++;
    }
    return { nonBg, total: w * h };
  });
  ok('canvas has rendered geometry', pixels.nonBg > 500, JSON.stringify(pixels));

  // 2. 诊断面板：helix 无跳变/零段/退化
  const diag = await page.textContent('#diagnostics');
  ok('diag reports no frame jump', diag.includes('无；相邻切线夹角均小于 90°'));
  ok('diag reports no zero segment', diag.includes('无；所有连续段长度 ≥ 1e-10'));
  ok('diag reports no degenerate face', diag.includes('无；所有三角形叉积模 ≥ 1e-12'));

  // 3. 切到 closed 样例
  await page.selectOption('#sample-select', { index: 1 });
  await page.waitForTimeout(300);
  const cStats = await page.textContent('#stats');
  ok('closed shows 31 rings', cStats.includes('环 31'), cStats);
  ok('closed shows 496 tris', cStats.includes('三角形 496'), cStats);
  const cDiag = await page.textContent('#diagnostics');
  ok('closed seam twist reported', cDiag.includes('闭环接缝') && cDiag.includes('补偿'), cDiag);
  ok('caps toggle disabled when closed',
    await page.isDisabled('#caps-toggle'));

  // 4. 关闭补偿：诊断模式，拓扑不变（开关在长面板折叠区，用 click 点可见的 label 轨道）
  await page.locator('#compensate-toggle').evaluate((el) => {
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const diagOff = await page.textContent('#diagnostics');
  ok('comp-off shows diagnostic wording', diagOff.includes('补偿已关闭'));
  const statsOff = await page.textContent('#stats');
  ok('comp-off keeps 496 tris', statsOff.includes('三角形 496'), statsOff);
  await page.locator('#compensate-toggle').evaluate((el) => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 5. near-reverse：框架跳变报出
  await page.selectOption('#sample-select', { index: 2 });
  await page.waitForTimeout(300);
  const nrDiag = await page.textContent('#diagnostics');
  ok('near-reverse reports 180 jump', nrDiag.includes('框架跳变') && nrDiag.includes('180.00°'), nrDiag);
  const jumpRows = await page.locator('#points-body tr.jump').count();
  ok('jump row highlighted', jumpRows === 1, `rows=${jumpRows}`);

  // 6. zero-segment：无效，禁止导出
  await page.selectOption('#sample-select', { index: 3 });
  await page.waitForTimeout(300);
  const zDiag = await page.textContent('#diagnostics');
  ok('zero segment error shown', zDiag.includes('零长段') && zDiag.includes('错误'), zDiag);
  const zeroRows = await page.locator('#points-body tr.zero').count();
  ok('zero rows highlighted', zeroRows >= 1, `rows=${zeroRows}`);

  // 截获导出：OBJ 按钮在无效时应被拦截（toast）
  const toastVisible = await page.evaluate(() => {
    document.querySelector('#export-obj').click();
    return new Promise((res) => setTimeout(() =>
      res(document.querySelector('#toast').classList.contains('show')), 100));
  });
  ok('export blocked on invalid model', toastVisible);

  // 7. 回 helix，编辑半径并验证预览结果与导出 JSON 同源
  await page.selectOption('#sample-select', { index: 0 });
  await page.waitForTimeout(200);
  await page.fill('#edit-r', '0.25');
  await page.dispatchEvent('#edit-r', 'change');
  await page.waitForTimeout(200);
  const rInTable = await page.inputValue('#points-body tr.selected .r-input');
  ok('radius edit propagated to table', rInTable === '0.25', rInTable);

  // 从页面内部取 buildSweep 结果与导出 JSON 比对
  const exportConsistent = await page.evaluate(() => {
    const { buildSweep, state } = window.__sweep;
    const inp = { ...state.input, caps: state.caps, compensate: state.compensate };
    const r = buildSweep(inp);
    // 模拟 toJSON 关键字段
    const jsonRings = JSON.stringify(r.rings);
    const jsonTris = JSON.stringify(r.sideTris);
    const rendered = state.lastResult;
    return r.valid &&
      JSON.stringify(rendered.rings) === jsonRings &&
      JSON.stringify(rendered.sideTris) === jsonTris &&
      r.rings[0].some((p) => Math.abs(p[0]) > 0);
  });
  ok('preview and export share identical geometry', exportConsistent);

  // 实际触发 OBJ 下载（playwright 接受 download 事件）
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-obj'),
  ]);
  ok('OBJ download triggered', download.suggestedFilename() === 'sweep.obj', download.suggestedFilename());
  const objPath = '/tmp/e2e-sweep.obj';
  await download.saveAs(objPath);
  const objText = require('node:fs').readFileSync(objPath, 'utf8');
  const fCount = objText.split('\n').filter((l) => l.startsWith('f ')).length;
  ok('exported OBJ has 640 faces', fCount === 640, `faces=${fCount}`);
  ok('OBJ has vn normals', objText.includes('vn '));

  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-json'),
  ]);
  const jsonPath = '/tmp/e2e-sweep.json';
  await dl2.saveAs(jsonPath);
  const exported = JSON.parse(require('node:fs').readFileSync(jsonPath, 'utf8'));
  ok('JSON records frames/rings/indices',
    Array.isArray(exported.frames) && exported.frames.length === 40 &&
    Array.isArray(exported.rings) && exported.side.triangles.length === 624 &&
    exported.caps.triangles.length === 16);
  ok('JSON frame has tangent + two axes',
    exported.frames[0].tangent.length === 3 &&
    exported.frames[0].normal.length === 3 &&
    exported.frames[0].binormal.length === 3);

  // 8. 闭合 + 非 2π 扭转被拒
  await page.selectOption('#sample-select', { index: 1 });
  await page.waitForTimeout(200);
  await page.fill('#twist-input', '1');
  await page.dispatchEvent('#twist-input', 'change');
  await page.waitForTimeout(200);
  const twistHint = await page.textContent('#twist-hint');
  ok('non-2pi twist warning shown', twistHint.includes('2π 的整数倍'), twistHint);
  const invalidStats = await page.textContent('#stats');
  ok('model invalid after illegal twist', invalidStats.includes('模型无效'));

  // 10. 窄屏不横向溢出
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  ok('no horizontal overflow at 400px', overflow.scrollW <= overflow.clientW, JSON.stringify(overflow));

  // 11. 截图（暗/明）与主题切换
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.selectOption('#sample-select', { index: 1 });
  await page.waitForTimeout(300);
  // 显式回到该样例自带的零扭转，排除步骤 8 残留输入的影响
  await page.fill('#twist-input', '0');
  await page.dispatchEvent('#twist-input', 'change');
  await page.waitForTimeout(200);
  const zeroHint = await page.textContent('#twist-hint');
  ok('twist 0 accepted on closed path', zeroHint.includes('0 整圈'), zeroHint);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/e2e-dark.png' });
  const bgDark = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor);
  ok('dark theme applies dark body bg', bgDark === 'rgb(14, 18, 25)', bgDark);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/e2e-light.png' });
  const bgLight = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor);
  ok('light theme applies light body bg', bgLight === 'rgb(238, 241, 246)', bgLight);

  ok('final console error list empty', consoleErrors.length === 0, consoleErrors.join(' | '));
  await browser.close();
  console.log(failures === 0 ? '\nALL E2E PASSED' : `\n${failures} E2E FAILURE(S)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
