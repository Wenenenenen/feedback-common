// 导出独立复核：浏览器下载过滤 PNG 与层级 JSON，再用独立解码器和重算逻辑验证。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../src/image-io.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sampleDir = path.join(root, 'samples/extracted');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, p === '/' ? 'index.html' : p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8757, r));
const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8757/');
await page.setInputFiles('#file-img', path.join(sampleDir, 'tiny.png'));
await page.setInputFiles('#file-mask', path.join(sampleDir, 'tiny-mask.png'));
await page.waitForFunction(() => document.getElementById('st-valid').textContent === '30');
await page.evaluate(() => {
  document.querySelector('#seg-tree button[data-v="max"]').click();
  document.querySelector('#seg-conn button[data-v="4"]').click();
});
await page.locator('#thr-num').fill('8');
await page.locator('#thr-num').dispatchEvent('input');

const [dl1] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() => document.getElementById('btn-export-png').click()),
]);
const pngPath = path.join(here, 'tmp-filtered.png');
await dl1.saveAs(pngPath);
const [dl2] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() => document.getElementById('btn-export-json').click()),
]);
const jsonPath = path.join(here, 'tmp-tree.json');
await dl2.saveAs(jsonPath);
await browser.close();
server.close();

// ---- PNG：掩膜内对 expected.json，掩膜外照抄原图 ----
const dec = await decodePNG(new Uint8Array(fs.readFileSync(pngPath)));
const expected = JSON.parse(fs.readFileSync(path.join(sampleDir, 'expected.json'), 'utf8'));
const want = expected.find((e) => e.tree === 'max' && e.connectivity === 4 && e.area === 8);
const maskDec = await decodePNG(new Uint8Array(fs.readFileSync(path.join(sampleDir, 'tiny-mask.png'))));
const orig = await decodePNG(new Uint8Array(fs.readFileSync(path.join(sampleDir, 'tiny.png'))));
let insideOk = true, outsideOk = true;
for (let y = 0; y < 6; y++) {
  for (let x = 0; x < 6; x++) {
    const idx = y * 6 + x;
    if (maskDec.data[idx]) {
      if (dec.data[idx] !== want.pixels[y][x]) insideOk = false;
    } else if (dec.data[idx] !== orig.data[idx]) {
      outsideOk = false;
    }
  }
}

// ---- JSON：引用合法性 + 独立重算子树面积 + 掩膜标记 ----
const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const ids = new Set(j.nodes.map((n) => n.id));
let refsOk = true;
for (const n of j.nodes) {
  if (n.parent !== null && !ids.has(n.parent)) refsOk = false;
  if (n.representative.length !== 2) refsOk = false;
}
const own = new Array(j.nodes.length).fill(0);
for (const nid of j.pixel_nodes) if (nid >= 0) own[nid]++;
// 不动点传播子树面积
const sub = own.slice();
let changed = true;
while (changed) {
  changed = false;
  const add = new Array(j.nodes.length).fill(0);
  for (const n of j.nodes) if (n.parent !== null) add[n.parent] += sub[n.id];
  for (const n of j.nodes) {
    const v = own[n.id] + add[n.id];
    if (v !== sub[n.id]) { sub[n.id] = v; changed = true; }
  }
}
let areaOk = j.nodes.every((n) => sub[n.id] === n.area);
let maskMarkOk = true;
for (let i = 0; i < 36; i++) {
  const outside = !maskDec.data[i];
  if (outside && j.pixel_nodes[i] !== -1) maskMarkOk = false;
  if (!outside && j.pixel_nodes[i] < 0) maskMarkOk = false;
}

fs.rmSync(pngPath, { force: true });
fs.rmSync(jsonPath, { force: true });
console.log('PNG 掩膜内与 expected 一致:', insideOk, '| 掩膜外照抄原图:', outsideOk);
console.log('JSON 引用合法:', refsOk, '| 独立重算面积一致:', areaOk, '| 掩膜标记正确:', maskMarkOk,
  '| 控制台错误:', errs.length ? errs : '无');
if (!(insideOk && outsideOk && refsOk && areaOk && maskMarkOk && !errs.length)) process.exit(1);
console.log('导出复核通过。');
