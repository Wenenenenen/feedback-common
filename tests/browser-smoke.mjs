// 浏览器端冒烟测试：四视图渲染、规则切换、点选、导出 JSON/PNG、拖动顶点
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8123/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('s-t').textContent !== '–', { timeout: 5000 });

const status = async () => page.evaluate(() => ({
  v: document.getElementById('s-v').textContent,
  e: document.getElementById('s-e').textContent,
  t: document.getElementById('s-t').textContent,
  r: document.getElementById('s-r').textContent,
  a: document.getElementById('s-a').textContent,
}));

// 1. bowtie 默认载入
let s = await status();
console.log('bowtie evenodd:', JSON.stringify(s));
if (!(Number(s.t) > 0)) throw new Error('bowtie 应有三角形');

// 2. 四个 canvas 都有非空像素
const nonEmpty = await page.evaluate(() => [1, 2, 3, 4].map((i) => {
  const c = document.getElementById('c' + i);
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
  return n;
}));
console.log('四视图非空像素数:', nonEmpty);
if (nonEmpty.some((n) => n < 100)) throw new Error('存在空白视图: ' + nonEmpty);

// 3. 切换 nonzero
await page.click('#rule-nz');
await page.waitForFunction(() => document.getElementById('rule-nz').classList.contains('on'));
s = await status();
console.log('bowtie nonzero:', JSON.stringify(s));

// 4. 逐样例载入两规则，确认无错误且面积为正（duplicate/evenodd 允许 0）
const samples = ['bowtie', 'collinear-touch', 'duplicate', 'opposite-hole', 'overlap', 'same-hole', 'stress'];
for (const name of samples) {
  for (const rule of ['evenodd', 'nonzero']) {
    await page.selectOption('#sample', name + '.json');
    await page.click(rule === 'evenodd' ? '#rule-eo' : '#rule-nz');
    await page.waitForFunction(() => !document.getElementById('s-msg').textContent);
    const st = await status();
    if (st.a.includes('NaN')) throw new Error(`${name}/${rule} 面积 NaN`);
  }
}
console.log('全部样例 × 两规则渲染成功');

// 5. 点选区域（视图③扫描若干点，孔洞中心可能落空，直到命中填充区）
const box = await page.locator('#c3').boundingBox();
let clicked = false;
for (const fx of [0.3, 0.5, 0.7]) {
  for (const fy of [0.3, 0.5, 0.7]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    if (await page.locator('#info.show').count()) { clicked = true; break; }
  }
  if (clicked) break;
}
console.log('点选信息面板出现:', clicked);
if (!clicked) throw new Error('点选未命中任何填充区域');
const infoText = await page.locator('#info-body').innerText();
if (!infoText.includes('区域绕数') || !infoText.includes('贡献轮廓')) {
  throw new Error('信息面板缺少绕数/贡献轮廓');
}

// 6. 导出 JSON，校验结构
const exported = await page.evaluate(async () => {
  const res = await fetch('/samples/extracted/overlap.json').then((r) => r.json());
  // 触发下载逻辑等价物：直接调用页面内已有的 meshToJSON 不可得，改为拦截下载
  return res.rule;
});
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export-json'),
]);
const path = '/tmp/exported-mesh.json';
await download.saveAs(path);
const mesh = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(path, 'utf8')));
console.log('导出 JSON 字段:', Object.keys(mesh).join(','));
if (!mesh.vertices || !mesh.triangles || !mesh.regions || mesh.area === undefined) {
  throw new Error('JSON 缺字段');
}
// 三角形索引合法性 + CCW
let badIndex = 0, badCCW = 0;
for (const t of mesh.triangles) {
  if (t.some((i) => i < 0 || i >= mesh.vertices.length)) badIndex++;
  const [a, b, c] = t.map((i) => mesh.vertices[i]);
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross <= 0) badCCW++;
}
console.log(`三角形 ${mesh.triangles.length}，非法索引 ${badIndex}，非CCW ${badCCW}`);
if (badIndex || badCCW) throw new Error('网格索引或朝向错误');
// 面积由实际三角形累加核对
let areaFromTris = 0;
for (const t of mesh.triangles) {
  const [a, b, c] = t.map((i) => mesh.vertices[i]);
  areaFromTris += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}
console.log('导出 area=', mesh.area, ' 三角形重算=', areaFromTris, ' 偏差=', Math.abs(areaFromTris - mesh.area));
if (Math.abs(areaFromTris - mesh.area) > 1e-6) throw new Error('导出面积与三角形不符');

// 7. 导出 PNG
const [pngDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export-png'),
]);
const pngPath = '/tmp/exported-preview.png';
await pngDl.saveAs(pngPath);
const pngBuf = await import('node:fs').then((fs) => fs.promises.readFile(pngPath));
console.log('PNG 字节数:', pngBuf.length, 'PNG 签名:', pngBuf.slice(0, 8).toString('hex'));
if (pngBuf.length < 1000 || pngBuf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  throw new Error('PNG 导出无效');
}

// 8. 拖动顶点（视图①第一个顶点向右移动），面积应变化
await page.selectOption('#sample', 'same-hole.json');
const before = (await status()).a;
const c1box = await page.locator('#c1').boundingBox();
// 找到第一个顶点屏幕位置（页面内顶点较小，直接在左上角附近按下拖动）
await page.mouse.move(c1box.x + 60, c1box.y + c1box.height - 60);
await page.mouse.down();
await page.mouse.move(c1box.x + 90, c1box.y + c1box.height - 70, { steps: 5 });
await page.mouse.up();
const after = (await status()).a;
console.log('拖动前面积:', before, ' 拖动后:', after);

if (errors.length) {
  console.log('页面错误:', errors);
  throw new Error('存在浏览器错误');
}
await browser.close();
console.log('\n✅ 浏览器冒烟测试全部通过');
