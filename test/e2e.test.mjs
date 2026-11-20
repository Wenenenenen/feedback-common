// 端到端 UI 测试：静态服务器 + Playwright，覆盖导入、选点、约束、单轮/全量求解、导出与非法数据。
// 运行：node test/e2e.test.mjs（需先有全局 playwright）
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = 8753;

const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.json': 'application/json;charset=utf-8' };
const server = createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(port, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

try {
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForSelector('canvas#view');
  await page.waitForTimeout(300);

  // 1. 载入内置示例
  await page.click('#loadSample');
  await page.waitForFunction(() => document.getElementById('infoVerts').textContent !== '—');
  check('内置示例导入后显示顶点数', (await page.textContent('#infoVerts')) === '45');
  check('三角形数 64', (await page.textContent('#infoTris')) === '64');
  check('初始约束数 4', (await page.textContent('#infoPins')) === '4');

  // 2. 等待 worker 初始化完成（能量出现第 0 项）
  await page.waitForFunction(() => document.getElementById('curEnergy').textContent !== '—');
  check('初始化后记录第 0 项能量', !isNaN(parseFloat((await page.textContent('#curEnergy')).replace(/,/g, ''))));

  // 3. 按编号定位顶点（选一个无约束的自由点 22）
  await page.fill('#locateInput', '22');
  await page.click('#locateBtn');
  check('定位后选中标题为 #22', (await page.textContent('#selTitle')).trim() === '#22');

  // 4. 添加约束并输入目标
  await page.waitForSelector('#addPinBtn:not([disabled])');
  await page.click('#addPinBtn');
  await page.waitForSelector('#pinEditor:not([hidden])');
  await page.fill('#targetZ', '2.5');
  await page.dispatchEvent('#targetZ', 'change');
  check('约束数变为 5', (await page.textContent('#infoPins')) === '5');

  // 5. 单轮推进
  const eBefore = await page.textContent('#curEnergy');
  await page.click('#stepBtn');
  await page.waitForFunction((eb) => document.getElementById('curEnergy').textContent !== eb, eBefore);
  check('单轮后轮数=1', (await page.textContent('#iterCount')) === '1');

  // 6. 全量求解（worker 分帧，期间尝试旋转视角验证不卡死）
  await page.click('#runBtn');
  await page.waitForSelector('#cancelBtn', { state: 'visible' });
  // 求解中拖动 canvas
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(460, 260, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('#runBtn', { state: 'visible', timeout: 15000 });
  const stop = await page.textContent('#stopReason');
  check('全量求解结束有停止原因', stop.includes('收敛') || stop.includes('轮数') || stop.includes('自由点'), stop);
  check('能量曲线 SVG 已绘制', (await page.$$eval('#energyChart polyline', (els) => els.length)) === 1);

  // 7. 原网格叠加开关
  await page.uncheck('#overlayToggle');
  check('关闭叠加后 checkbox 未选中', !(await page.isChecked('#overlayToggle')));
  await page.check('#overlayToggle');

  // 8. 导出 OBJ 与诊断 JSON（拦截下载）
  const downloads = [];
  page.on('download', async (d) => {
    const tmp = join(here, 'dl-' + d.suggestedFilename());
    await d.saveAs(tmp);
    downloads.push({ name: d.suggestedFilename(), path: tmp });
  });
  await page.click('#exportObj');
  await page.click('#exportJson');
  await page.waitForTimeout(400);
  check('触发两个下载', downloads.length === 2, `got ${downloads.length}`);
  const objDl = downloads.find((d) => d.name.endsWith('.obj'));
  const jsonDl = downloads.find((d) => d.name.endsWith('.json'));
  if (objDl) {
    const obj = readFileSync(objDl.path, 'utf8');
    const vCount = (obj.match(/^v /gm) || []).length;
    const fCount = (obj.match(/^f /gm) || []).length;
    check('OBJ 顶点数保持 45', vCount === 45, `got ${vCount}`);
    check('OBJ 面数保持 64', fCount === 64, `got ${fCount}`);
    check('OBJ 索引从 1 开始', obj.includes('f 1 '));
  }
  if (jsonDl) {
    const diag = JSON.parse(readFileSync(jsonDl.path, 'utf8'));
    check('诊断 JSON 含 rotations 且逐点 9 元素', diag.rotations.length === 45 && diag.rotations[0].length === 9);
    check('诊断 JSON 含 energies 第 0 项', Array.isArray(diag.energies) && diag.energies.length >= 2);
    check('诊断 JSON 含 constraints', diag.constraints.length === 5);
    check('诊断 JSON 含 stop_reason', typeof diag.stop_reason === 'string');
    check('诊断 JSON 保持原三角形', diag.triangles.length === 64);
  }

  // 9. 重置清空约束并恢复
  await page.click('#resetBtn');
  await page.waitForFunction(() => document.getElementById('infoPins').textContent === '0');
  check('重置后约束清空', (await page.textContent('#infoPins')) === '0');

  // 10. 非法数据校验（通过页面内 validateMesh 间接测：用 fetch 注入无效 JSON 到文件输入流程较难，
  //     直接在页面上下文调用模块逻辑验证错误指出具体对象）
  const invalidResult = await page.evaluate(async () => {
    const mod = await import('./src/mesh.js');
    return mod.validateMesh({
      rest: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
      triangles: [[0, 1, 9]],
      constraints: [],
    });
  });
  check('非法面索引报错且指出 triangles[0]', invalidResult.data === null && invalidResult.errors.some((e) => e.includes('triangles[0]')));

  // 11. 真实样例文件（mirrored-tetra）能量 64 的端到端校验
  const mirrored = JSON.parse(readFileSync(join(root, 'samples', 'extracted', 'mirrored-tetra.json'), 'utf8'));
  const mirrorCheck = await page.evaluate((input) => new Promise((resolve) => {
    const w = new Worker('./src/worker.js', { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'state' && (e.data.stopReason === 'no_deformable_vertices' || e.data.energies.length >= 1)) {
        resolve({ energy: e.data.energies.at(-1), reason: e.data.stopReason });
        w.terminate();
      }
      if (e.data.type === 'invalid') { resolve({ error: e.data.errors }); w.terminate(); }
    };
    w.postMessage({ type: 'init', input });
  }), mirrored);
  check('镜像四面体全约束能量=64（拒绝反射）', Math.abs(mirrorCheck.energy - 64) < 1e-6, `got ${mirrorCheck.energy}`);

  check('运行期间无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\nE2E: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
