// 诊断：检查探针 GPU 读回与着色是否一致
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const require = createRequire(import.meta.url);
const { execSync } = await import('node:child_process');
const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(join(globalRoot, 'playwright'));

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try { res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const D = window.__CSB_DEBUG;
  const res = {};
  // 受光点与阴影点的 GPU 值
  res.litPoint = D.probeAt([4, 0, -12], 'unstabilized');
  res.shadowPoint = D.probeAt([-4, 0, -12], 'unstabilized');
  // 直接读纹素：受光点级1中心附近原始深度值
  const frame = D.lastFrame();
  const cas = frame.sets.unstabilized.cascades[0];
  const M = window.CSMat;
  const p = M.transformPoint(cas.lightVP, [4, 0, -12]);
  const u = p[0] * 0.5 + 0.5, v = p[1] * 0.5 + 0.5, depth = p[2] * 0.5 + 0.5;
  const r = D.state.resolution;
  const bx = Math.floor(u * r), by = Math.floor(v * r);
  res.raw = { uv: [u, v], depth, bx, by, texel: D.readTexel('unstabilized', 0, bx, by), glError: D.glError() };
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
