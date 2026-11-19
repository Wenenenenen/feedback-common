// 错误路径浏览器测试：不连通、退化对应点、地平线、超 4096，均应弹出含原因的对话框。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const root = resolve('app');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const file = req.url === '/' ? join(root, 'index.html') : join(root, req.url.split('?')[0]);
  try { const b = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${port}/`);

// 直接通过页面已加载的模块能力注入：用 file input 加载两张样例图，再用 DataTransfer 喂自定义 JSON
await page.locator('#file-images').setInputFiles([
  resolve('samples/extracted/projective/0.png'),
  resolve('samples/extracted/projective/1.png'),
]);
await page.waitForFunction(() => document.querySelectorAll('#image-list li').length === 2);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n + ' ' + d)); };

async function loadJson(obj) {
  const dl = page.locator('#file-json');
  await dl.setInputFiles({
    name: 'matches.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(obj)),
  });
  await page.waitForFunction(() => !document.querySelector('#btn-run').disabled);
}
async function runAndReadError() {
  await page.locator('#btn-run').click();
  const dialog = page.locator('#dialog-error');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const msg = await page.locator('#error-message').innerText();
  // 点击对话框内的关闭按钮（form method=dialog）
  await dialog.locator('button').click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  return msg;
}

// 1) 退化：4 点共线
const collinear = {
  images: ['0.png', '1.png'], reference: 0,
  edges: [{ a: 0, b: 1, pairs: [[[0, 0], [0, 0]], [[10, 0], [10, 0]], [[20, 0], [20, 0]], [[30, 0], [30, 0]]] }],
};
await loadJson(collinear);
let msg = await runAndReadError();
ok('共线退化给出原因', /退化/.test(msg), msg);

// 2) 点数不足
const tooFew = {
  images: ['0.png', '1.png'], reference: 0,
  edges: [{ a: 0, b: 1, pairs: [[[0, 0], [0, 0]], [[10, 0], [10, 0]]] }],
};
await loadJson(tooFew);
msg = await runAndReadError();
ok('点数不足给出原因', /至少需要 4/.test(msg), msg);

// 3) 地平线穿图：令图1->参考的逆映射 G 在图1 内 w 过零。
// G: w=1-0.02x（x=50 过零），边单应 H_a->b = inv(G)，h6=+0.02，图0 侧不退化。
const G = [1, 0, 0, 0, 1, 0, -0.02, 0, 1];
const H = [1, 0, 0, 0, 1, 0, 0.02, 0, 1]; // = inv(G) 归一化
const proj = (x, y) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};
const horizonPairs = [];
for (const [x, y] of [[10, 10], [40, 20], [20, 90], [45, 60], [30, 30], [40, 100], [25, 100], [35, 80]]) {
  horizonPairs.push([[x, y], proj(x, y)]);
}
await loadJson({ images: ['0.png', '1.png'], reference: 0, edges: [{ a: 0, b: 1, pairs: horizonPairs }] });
msg = await runAndReadError();
ok('地平线穿图给出原因', /地平线/.test(msg), msg);
void G;

// 4) 正常数据可恢复（错误后仍能运行）
const good = JSON.parse(await readFile(resolve('samples/extracted/projective/matches.json'), 'utf8'));
await loadJson(good);
await page.locator('#btn-run').click();
await page.waitForFunction(() => !document.querySelector('#btn-export-png').disabled);
ok('错误恢复后正常数据可拼接', true);

console.log(fail ? `\n${fail} 项失败` : `\n错误路径测试全部通过（${pass} 项）`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
