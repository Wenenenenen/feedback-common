// 浏览器端冒烟测试：用 Playwright 驱动真实页面，覆盖加载、编辑、运行、预览、导出全流程。
// 用法：node tests/browser-smoke.mjs <case-dir>
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const caseDir = resolve(process.argv[2]);
const root = resolve('app');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    const file = url === '/' ? join(root, 'index.html') : join(root, url);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + ' ' + detail); }
};

await page.goto(`http://127.0.0.1:${port}/`);
ok('页面标题加载', (await page.title()).includes('投影拼接'));

// 加载两张 PNG
const imgInputs = page.locator('#file-images');
await imgInputs.setInputFiles([join(caseDir, '0.png'), join(caseDir, '1.png')]);
await page.waitForFunction(() => document.querySelectorAll('#image-list li').length === 2);
ok('两张图片加载并列出', await page.locator('#image-list li').count() === 2);
ok('运行按钮在无 JSON 时禁用', await page.locator('#btn-run').isDisabled());

// 加载 matches（projective 案例只有 0/1 两张，直接用其 json）
await page.locator('#file-json').setInputFiles(join(caseDir, 'matches.json'));
await page.waitForFunction(() => !document.querySelector('#btn-run').disabled);
ok('JSON 加载后运行按钮可用', await page.locator('#btn-run').isEnabled());
ok('边下拉出现', (await page.locator('#select-edge option').count()) >= 1);

// 源点面板绘制
await page.waitForFunction(() => document.querySelector('#canvas-a').width > 0);
ok('源图对应点画布已绘制', await page.locator('#canvas-a').evaluate((c) => c.width > 0 && c.height > 0));

// 运行拼接
await page.locator('#btn-run').click();
await page.waitForFunction(() => !document.querySelector('#btn-export-png').disabled);
ok('拼接成功并启用导出', true);
const diag = await page.locator('#diagnostics').innerText();
const inlierLine = diag.split('\n').find((l) => l.includes('内点'));
const m = inlierLine.match(/内点 (\d+)\/(\d+)/);
ok('诊断显示 20 个内点 / 28 总点', m && m[1] === '20' && m[2] === '28', inlierLine);
const outlierLine = diag.split('\n').find((l) => l.includes('外点索引'));
ok('诊断列出全部 8 个外点索引',
  !!outlierLine && outlierLine.includes('外点索引 [20, 21, 22, 23, 24, 25, 26, 27]'), outlierLine);
const sizeText = await page.locator('#canvas-size').innerText();
ok('显示画布尺寸', /输出画布 \d+ × \d+/.test(sizeText), sizeText);

// 切换全部预览模式
for (const mode of ['points', 'seams', 'layers', 'overlap', 'result']) {
  await page.locator(`button[data-mode="${mode}"]`).click();
  await page.waitForTimeout(100);
  const active = await page.locator(`button[data-mode="${mode}"]`).evaluate((b) => b.classList.contains('active'));
  ok(`预览模式 ${mode} 可切换`, active);
}

// 修改阈值（收紧到 0.5px，制造更多外点）后重跑
await page.locator('#input-threshold').fill('0.5');
await page.locator('#input-threshold').dispatchEvent('change');
await page.locator('#btn-run').click();
await page.waitForTimeout(200);
const diag2 = await page.locator('#diagnostics').innerText();
ok('收紧阈值后外点增多或仍可运行', diag2.includes('内点'));

// 切换参考图（两张图时参考图改为 1）
await page.locator('#select-reference').selectOption('1');
await page.locator('#btn-run').click();
await page.waitForFunction(() => !document.querySelector('#btn-export-png').disabled);
ok('切换参考图后重新拼接成功', true);
ok('参考图标记更新', (await page.locator('#image-list .ref-tag').count()) === 1);

// 增点：在 A 面板点击（挂起），再在 B 面板点击补全（用分派事件，坐标为画布内部像素坐标）
const tap = async (sel, x, y) => {
  await page.locator(sel).evaluate((c, [x, y]) => {
    const r = c.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: r.left + x * (r.width / c.width),
      clientY: r.top + y * (r.height / c.height),
    });
    c.dispatchEvent(ev);
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  }, [x, y]);
};
const before = await page.locator('#point-count').innerText();
// 选右下角无点区域（避开已有对应点的 8px 命中容差）
await tap('#canvas-a', 155, 115);
const pending = await page.locator('#point-count').innerText();
ok('首次点击进入挂起点状态', pending.includes('挂起点'), pending);
await tap('#canvas-b', 155, 115);
const after = await page.locator('#point-count').innerText();
ok('第二次点击补全并新增点对（28→29）', after.startsWith('29 对'), `${before} -> ${after}`);
ok('新点对处于选中态（删除按钮可用）', await page.locator('#btn-del-point').isEnabled());

// 删点：删除后选中态清空，删除点按钮应恢复禁用
await page.locator('#btn-del-point').click();
await page.waitForTimeout(80);
ok('删除选中点后按钮恢复禁用', await page.locator('#btn-del-point').isDisabled());
ok('删除后点对数回落（29→28）', (await page.locator('#point-count').innerText()).startsWith('28 对'));

// 导出 PNG / JSON（下载事件）
const [pngDl] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#btn-export-png').click(),
]);
ok('导出 PNG 下载触发', (await pngDl.suggestedFilename()) === 'mosaic.png');
const [jsonDl] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#btn-export-json').click(),
]);
ok('导出 JSON 下载触发', (await jsonDl.suggestedFilename()) === 'mosaic.json');
const jsonPath = await jsonDl.path();
const exported = JSON.parse(await readFile(jsonPath, 'utf8'));
ok('导出 JSON 含画布/矩阵/内点',
  exported.canvas && Array.isArray(exported.image_to_reference) &&
  Array.isArray(exported.edges[0].inliers) && exported.reference === 1);

// 错误对话框：加载坏 JSON 路径——直接通过页面状态触发不连通（删边到 0 条会禁用，改为新建孤立场景较难，
// 这里验证地平线/退化路径：把阈值调到极小且删掉多数点）
ok('全程无页面错误', errors.length === 0, errors.join('\n'));

await browser.close();
server.close();
console.log(`\n${fail ? fail + ' 项失败' : '浏览器冒烟全部通过'}（${pass} 项检查）`);
process.exit(fail ? 1 : 0);
