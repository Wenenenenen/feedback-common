// 浏览器冒烟测试:加载页面、检查控制台错误、验证半透明像素、点选、导出。
// 用法: NODE_PATH=$(npm root -g) node test/browser.smoke.mjs <页面URL>
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
};

check('无控制台错误', errors.length === 0, errors.join(' | '));

// 半透明一致性:单条路径内部(含 round 连接/端帽等三角形重叠区)alpha 不得超过 128。
// 先把文档换成单条急转弯路径(内部大量三角形重叠),再全画布统计。
const alphaStats = await page.evaluate(() => {
  const studio = window.__strokeStudio;
  studio.state.doc = {
    canvas: [240, 160],
    paths: [{
      id: 'solo', commands: [['M', 20, 80], ['L', 120, 80], ['L', 40, 40], ['C', 60, 120, 180, 120, 200, 60]],
      transform: [1, 0, 0, 1, 0, 0],
      style: { width: 14, join: 'round', cap: 'round', miterLimit: 4, dash: [], dashOffset: 0, color: [0, 0, 0, 0.5] },
    }],
  };
  studio.state.view = { fill: true, wireframe: false, centerline: false, native: false };
  studio.recompute();
  const canvas = document.querySelector('#view');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let maxAlpha = 0, over = 0, painted = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a > 0) painted++;
    if (a > maxAlpha) maxAlpha = a;
    if (a > 128) over++;
  }
  return { maxAlpha, over, painted };
});
console.log('       单路径 maxAlpha =', alphaStats.maxAlpha, ' 超128像素 =', alphaStats.over, ' 着色像素 =', alphaStats.painted);
check('半透明内部不变深(maxAlpha<=128)', alphaStats.maxAlpha <= 128 && alphaStats.painted > 1000,
  `maxAlpha=${alphaStats.maxAlpha} over=${alphaStats.over}`);

// 恢复内置示例文档
await page.evaluate(() => {
  const studio = window.__strokeStudio;
  studio.state.doc = null;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// 点选虚线:点击 dash-line 路径(局部 y=20,文档坐标 x=50,y=20,缩放 3)
await page.click('#view', { position: { x: 50 * 3, y: 20 * 3 } });
const pickText = await page.textContent('#pick-info');
console.log('       点选结果:', pickText);
check('点选显示弧长区间', /dash-line.*\[\d+\.?\d*, \d+\.?\d*\]/.test(pickText), pickText);
check('点选区间正确(40,70)', /\[40\.00, 70\.00\]/.test(pickText), pickText);

// 叠加层开关不报错
for (const id of ['#tg-wireframe', '#tg-centerline', '#tg-native']) {
  await page.click(id);
  await page.waitForTimeout(100);
}
check('叠加层开关后无错误', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: '/tmp/stroke-smoke-overlays.png' });
for (const id of ['#tg-wireframe', '#tg-centerline', '#tg-native']) await page.click(id);

// 编辑:把 dash-line 的 join 改为 round 并应用
await page.selectOption('#ed-join', 'round');
await page.click('#btn-apply');
await page.waitForTimeout(100);
check('编辑应用后无错误', errors.length === 0, errors.join(' | '));
const errText = await page.textContent('#ed-error');
check('编辑无校验错误', errText.trim() === '', errText);

// 非法输入被拒绝:虚线填 0
await page.fill('#ed-dash', '0, 0');
await page.click('#btn-apply');
const errText2 = await page.textContent('#ed-error');
check('非法虚线被拒绝', /虚线项必须为正数/.test(errText2), errText2);
await page.fill('#ed-dash', '30, 10');
await page.click('#btn-apply');

// 导出网格 JSON(拦截下载)
const dl = page.waitForEvent('download', { timeout: 5000 });
await page.click('#btn-export-mesh');
const download = await dl;
const meshPath = await download.path();
const { readFileSync } = await import('node:fs');
const mesh = JSON.parse(readFileSync(meshPath, 'utf8'));
check('网格 JSON 结构', Array.isArray(mesh.paths) && mesh.paths.length === 6
  && mesh.paths.every((p) => p.positions.length > 0 && p.triangles.length > 0));
check('网格坐标在画布范围内', mesh.paths.every((p) => {
  for (let i = 0; i < p.positions.length; i += 2) {
    if (p.positions[i] < -100 || p.positions[i] > 340) return false;
    if (p.positions[i + 1] < -100 || p.positions[i + 1] > 260) return false;
  }
  return true;
}));

// 导出 PNG
const dl2 = page.waitForEvent('download', { timeout: 5000 });
await page.click('#btn-export-png');
await dl2;
check('PNG 导出触发下载', true);

await page.screenshot({ path: '/tmp/stroke-smoke.png' });
await browser.close();
console.log(failures === 0 ? '\n冒烟测试全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
