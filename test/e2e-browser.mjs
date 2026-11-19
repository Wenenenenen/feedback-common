// 浏览器端到端验证：起静态服务 -> Playwright 导入样例 -> 校验建树/点选/过滤/导出。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sampleDir = path.join(root, 'samples/extracted');

const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8753, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:8753/');
await page.setInputFiles('#file-img', path.join(sampleDir, 'tiny.png'));
await page.waitForFunction(() => document.getElementById('st-nodes').textContent !== '—');

const stats1 = await page.evaluate(() => ({
  nodes: document.getElementById('st-nodes').textContent,
  roots: document.getElementById('st-roots').textContent,
  valid: document.getElementById('st-valid').textContent,
  cap: document.getElementById('orig-cap').textContent,
}));
console.log('tiny 无掩膜:', stats1);

// 加掩膜后重建
await page.setInputFiles('#file-mask', path.join(sampleDir, 'tiny-mask.png'));
await page.waitForFunction(() => document.getElementById('st-valid').textContent === '30');
const stats2 = await page.evaluate(() => ({
  nodes: document.getElementById('st-nodes').textContent,
  roots: document.getElementById('st-roots').textContent,
  valid: document.getElementById('st-valid').textContent,
}));
console.log('tiny 带掩膜:', stats2);

// 移除掩膜，与 expected.json 的无掩膜用例对齐
await page.evaluate(() => document.getElementById('mask-clear').click());
await page.waitForFunction(() => document.getElementById('st-valid').textContent === '36');

// 切到 max/c4/A=3，与 expected.json 第二组比对像素
await page.evaluate(() => {
  document.querySelector('#seg-tree button[data-v="max"]').click();
  document.querySelector('#seg-conn button[data-v="4"]').click();
});
await page.locator('#thr-num').fill('3');
await page.locator('#thr-num').dispatchEvent('input');
const expected = JSON.parse(fs.readFileSync(path.join(sampleDir, 'expected.json'), 'utf8'));
const wantA3 = expected.find((e) => e.tree === 'max' && e.connectivity === 4 && e.area === 3);
const gotA3 = await page.evaluate(() => {
  const cv = document.getElementById('cv-filt-base');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const rows = [];
  for (let y = 0; y < cv.height; y++) {
    const row = [];
    for (let x = 0; x < cv.width; x++) row.push(d[(y * cv.width + x) * 4]);
    rows.push(row);
  }
  return rows;
});
const matchA3 = JSON.stringify(gotA3) === JSON.stringify(wantA3.pixels);
console.log('A=3 过滤像素与 expected.json 一致:', matchA3);
if (!matchA3) {
  console.log('got ', JSON.stringify(gotA3));
  console.log('want', JSON.stringify(wantA3.pixels));
}

// 点选像素 (1,1)：灰度 90，路径应到根
const overlay = page.locator('#cv-orig-overlay');
const box = await overlay.boundingBox();
await page.mouse.click(box.x + (1.5 / 6) * box.width, box.y + (1.5 / 6) * box.height);
await page.waitForSelector('#path-list tr.node-row');
const pathInfo = await page.evaluate(() => ({
  head: document.getElementById('pixel-info').innerText.replace(/\n/g, ' '),
  rows: [...document.querySelectorAll('#path-list tr.node-row')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.innerText)),
}));
console.log('点选 (1,1):', pathInfo.head);
console.log('路径行数:', pathInfo.rows.length);

// 点树节点行 -> 高亮 overlay 非空
await page.evaluate(() => document.querySelector('#tree-list tr.node-row').click());
const overlayPixels = await page.evaluate(() => {
  const cv = document.getElementById('cv-orig-overlay');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
console.log('节点高亮像素数:', overlayPixels);

// 快照 + 调阈值 -> diff banner 与变化计数
await page.evaluate(() => document.getElementById('btn-snapshot').click());
await page.locator('#thr-num').fill('8');
await page.locator('#thr-num').dispatchEvent('input');
await page.waitForFunction(() => document.getElementById('diff-banner').classList.contains('on'));
const diff = await page.evaluate(() => ({
  banner: document.getElementById('diff-banner').classList.contains('on'),
  count: document.getElementById('diff-count').textContent,
}));
console.log('阈值对比:', diff);

// 切 min 树、8 邻接
await page.evaluate(() => {
  document.querySelector('#seg-tree button[data-v="min"]').click();
  document.querySelector('#seg-conn button[data-v="8"]').click();
});
await page.waitForFunction(() => document.getElementById('build-status').innerText.includes('min'));
const minStats = await page.evaluate(() => document.getElementById('build-status').innerText);
console.log('min/c8 状态:', minStats);

// 导出：监听下载
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() => document.getElementById('btn-export-png').click()),
]);
const dlPath = path.join(here, 'dl-filtered.png');
await download.saveAs(dlPath);
console.log('PNG 下载:', download.suggestedFilename(), fs.statSync(dlPath).size, '字节');

const [dlJson] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() => document.getElementById('btn-export-json').click()),
]);
const jsonPath = path.join(here, 'dl-tree.json');
await dlJson.saveAs(jsonPath);
const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
console.log('JSON 下载:', dlJson.suggestedFilename(),
  'schema keys:', ['width', 'height', 'tree', 'connectivity', 'area_threshold', 'nodes', 'pixel_nodes'].every((k) => k in exported),
  'nodes:', exported.nodes.length, 'pixel_nodes:', exported.pixel_nodes.length);

// medium.png 大一些的图
await page.setInputFiles('#file-img', path.join(sampleDir, 'medium.png'));
await page.waitForFunction(() => document.getElementById('st-nodes').textContent !== '—');
const med = await page.evaluate(() => ({
  nodes: document.getElementById('st-nodes').textContent,
  time: document.getElementById('st-time').textContent,
}));
console.log('medium:', med);

// 超大尺寸拒绝
const big = path.join(here, 'big.png');
{
  // 用页面自带编码器造一张 1025 宽图
  const buf = await page.evaluate(async () => {
    const { encodeGrayPNG } = await import('/src/image-io.mjs');
    const g = new Uint8ClampedArray(1025 * 4);
    return Array.from(await encodeGrayPNG(g, 1025, 4));
  });
  fs.writeFileSync(big, Buffer.from(buf));
  await page.setInputFiles('#file-img', big);
  await page.waitForTimeout(300);
}
const toast = await page.evaluate(() => document.getElementById('toast').textContent);
console.log('超限提示:', toast);

console.log('\n控制台错误:', errors.length ? errors : '无');
await browser.close();
server.close();
fs.rmSync(dlPath, { force: true });
fs.rmSync(jsonPath, { force: true });
fs.rmSync(big, { force: true });
if (!matchA3 || errors.length) process.exit(1);
console.log('\n端到端验证全部通过。');
