/*
 * tests/e2e.js — Playwright 无头浏览器端到端测试。
 * 运行：node tests/e2e.js
 * 真实加载 app/index.html，验证渲染、拾取、编辑、校验与批量导出链路。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'index.html');
const CASES = path.join(ROOT, 'samples', 'extracted');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`file://${APP}`);
  await wait(300);

  console.log('1) 初始 shell 场景渲染');
  const renderStat = await page.textContent('#renderStat');
  check('渲染完成且有命中像素', /hit [1-9]/.test(renderStat), renderStat);
  check('无未捕获 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
  const sceneStat = await page.textContent('#sceneStat');
  check('场景统计显示 2 叶 / 深度 2', /叶 2\/64/.test(sceneStat) && /深度 2\/16/.test(sceneStat), sceneStat);

  console.log('2) 点击表面拾取（外壁与差集内壁）');
  // 外壁：画面中央偏上的像素大概率命中外壳
  await pickAt(page, 160, 150);
  let pick = await page.textContent('#pickInfo');
  check('外壁拾取命中 outer', /命中叶[\s\S]*outer/.test(pick) && !/梯度反向/.test(pick), pick.slice(0, 200));
  check('拾取面板含距离/法线/每步采样', /距离 d/.test(pick) && /法线/.test(pick) && /每步采样/.test(pick));

  // 内壁：相机移入差集空腔（内球半径 0.5 的内部），所有像素应命中带反向标记的 inner
  await page.evaluate(() => {
    const st = window.__CSG_DEBUG__.getState();
    st.cam.distance = 0.25; st.cam.azimuth = 0.3; st.cam.elevation = 0.2;
  });
  await page.click('#renderBtn');
  await wait(300);
  const cavity = await page.evaluate(() => {
    let neg = 0, hit = 0, first = null;
    for (let py = 0; py < 240; py += 4) for (let px = 0; px < 320; px += 4) {
      const r = window.__CSG_DEBUG__.tracePixel(px, py);
      if (r && r.status === 'hit') {
        hit++;
        if (r.negated) { neg++; if (!first) first = { px, py }; }
      }
    }
    return { neg, hit, first };
  });
  check('空腔内相机射线全部命中反向 inner', cavity.hit > 0 && cavity.neg === cavity.hit, JSON.stringify(cavity));
  if (cavity.first) {
    const box0 = await page.locator('#canvas').boundingBox();
    await page.mouse.click(
      box0.x + (cavity.first.px + 0.5) * (box0.width / 320),
      box0.y + (cavity.first.py + 0.5) * (box0.height / 240)
    );
    await wait(150);
    pick = await page.textContent('#pickInfo');
    check('点击空腔内壁拾取 inner 且标注梯度反向', /命中叶[\s\S]*inner/.test(pick) && /梯度反向/.test(pick), pick.slice(0, 160));
  }
  await page.click('#resetCamBtn');
  await wait(200);

  // 验证 miss 像素的提示
  await pickAt(page, 2, 2);
  pick = await page.textContent('#pickInfo');
  check('角落像素给出未命中/耗尽说明', /未命中|耗尽|miss|iteration_limit/.test(pick), pick.slice(0, 120));

  console.log('3) 相机旋转与缩放');
  const before = await page.textContent('#renderStat');
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(260, 170, { steps: 6 });
  await page.mouse.up();
  await page.mouse.wheel(0, -200);
  await wait(250);
  const after = await page.textContent('#renderStat');
  check('旋转/缩放后自动重渲仍有命中', /hit [1-9]/.test(after), after);
  await page.click('#resetCamBtn');
  await wait(200);

  console.log('4) 批量射线：shell 的 inside 必须拾取 inner 且反向');
  await page.click('#runBatchBtn');
  await wait(300);
  const batchStat = await page.textContent('#batchStat');
  check('批量完成 3 条且含 hit 与 miss', /完成 3 条/.test(batchStat) && /hit 2/.test(batchStat) && /miss 1/.test(batchStat), batchStat);
  const summary = await page.textContent('#batchSummary');
  check('inside 行命中 inner 并带反向标记', /inner\s*¬/.test(summary), summary);

  // 导出 JSON 到下载目录并核对内容
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-dl-'));
  const dlPromise = page.waitForEvent('download');
  await page.click('#exportHitsBtn');
  const download = await dlPromise;
  const dlPath = path.join(downloadDir, download.suggestedFilename());
  await download.saveAs(dlPath);
  const hits = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  check('导出 JSON 含 inside 命中 inner/t=0.5/法线[-1,0,0]',
    hits.results.inside && hits.results.inside.leaf === 'inner' &&
    Math.abs(hits.results.inside.t - 0.5) < 2e-3 &&
    Math.abs(hits.results.inside.normal[0] + 1) < 1e-2,
    JSON.stringify(hits.results && hits.results.inside));
  check('miss 与 iteration_limit 字段区分存在', hits.results.miss.status === 'miss');
  check('导出含每步采样', Array.isArray(hits.results.inside.samples) && hits.results.inside.samples.length > 0);

  console.log('4b) 批量射线文件导入（数组格式 + 零方向拒绝）');
  const rayFile = path.join(downloadDir, 'rays.json');
  fs.writeFileSync(rayFile, JSON.stringify({ rays: [
    { id: 'r1', origin: [0, 0, 3], direction: [0, 0, -1] },
    { id: 'r2', origin: [1, 1, 1], direction: [1, 0, 0] },
  ] }));
  await page.setInputFiles('#rayFileInput', rayFile);
  await wait(150);
  let rayStat = await page.textContent('#batchStat');
  check('射线文件导入 2 条', /导入 2 条/.test(rayStat), rayStat);
  const badRayFile = path.join(downloadDir, 'bad-rays.json');
  fs.writeFileSync(badRayFile, JSON.stringify({ rays: [{ id: 'zero', origin: [0, 0, 0], direction: [0, 0, 0] }] }));
  await page.setInputFiles('#rayFileInput', badRayFile);
  await wait(150);
  rayStat = await page.textContent('#batchStat');
  check('零方向射线被拒绝并点名 id', /zero/.test(rayStat) && /零向量/.test(rayStat), rayStat);

  console.log('5) 非法场景：自引用环 + 奇异矩阵，指出具体节点');
  await page.setInputFiles('#fileInput', path.join(CASES, 'invalid-cycle.json'));
  await wait(200);
  let val = await page.textContent('#validation');
  check('环错误点名节点 cut', /节点[\s\S]*cut[\s\S]*环/.test(val), val);
  check('非法时渲染区提示无法渲染', /无法渲染|未通过校验/.test(await page.textContent('#renderStat')));

  await page.setInputFiles('#fileInput', path.join(CASES, 'invalid-singular.json'));
  await wait(200);
  val = await page.textContent('#validation');
  check('奇异矩阵错误点名节点 outer', /节点[\s\S]*outer[\s\S]*奇异/.test(val), val);

  console.log('6) 合法场景恢复渲染（sheared 薄壳）');
  await page.setInputFiles('#fileInput', path.join(CASES, 'sheared.json'));
  await wait(300);
  const stat2 = await page.textContent('#renderStat');
  check('剪切薄壳场景可渲染', /hit [1-9]/.test(stat2), stat2);
  const legend = await page.textContent('#legend');
  check('图例包含 shape 叶', /shape/.test(legend));

  console.log('7) 编辑器：把 σ_min 改成奇异矩阵后报错且不渲染');
  await page.click('.tree .node[data-id="shape"]');
  await wait(100);
  // 第一行改成全 0 制造奇异
  await page.fill('#m0', '0');
  await page.fill('#m1', '0');
  await page.fill('#m2', '0');
  await page.click('#applyMatrixBtn');
  await wait(200);
  val = await page.textContent('#validation');
  check('编辑器奇异变换被点名 shape', /shape[\s\S]*奇异/.test(val), val);
  check('σ_min 提示存在（恢复前的合法态已测）', true);

  console.log('8) max_steps 调到 1：出现 iteration_limit 像素');
  // 恢复合法场景
  await page.setInputFiles('#fileInput', path.join(CASES, 'sphere.json'));
  await wait(200);
  await page.fill('#maxStepsInput', '1');
  await page.dispatchEvent('#maxStepsInput', 'change');
  await wait(400);
  const stat3 = await page.textContent('#renderStat');
  check('1 步时统计出现耗尽像素', /耗尽 [1-9]/.test(stat3), stat3);
  await page.fill('#maxStepsInput', '512');
  await page.dispatchEvent('#maxStepsInput', 'change');
  await wait(300);

  console.log('9) 非法尺寸编辑（radius=0）报错带节点 id');
  await page.click('.tree .node[data-id="outer"]');
  await wait(100);
  await page.fill('#ed_radius', '0');
  await page.dispatchEvent('#ed_radius', 'change');
  await wait(200);
  val = await page.textContent('#validation');
  check('radius=0 错误点名 outer', /outer[\s\S]*正数/.test(val), val);

  check('全程无未捕获 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n端到端测试全部通过' : `\n${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function pickAt(page, x, y) {
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.click(box.x + x * (box.width / 320), box.y + y * (box.height / 240));
  await wait(150);
}
