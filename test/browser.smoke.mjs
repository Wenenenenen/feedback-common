// 浏览器冒烟测试：加载页面、运行页内自检、截图。
// 运行：node test/browser.smoke.mjs   （需要全局 playwright 与已缓存的 chromium）
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForTimeout(1500);

// 运行页内自检
await page.click('#selfcheckBtn');
await page.waitForTimeout(500);
const selfcheck = await page.textContent('#selfcheckOut');
console.log('--- 页内自检 ---');
console.log(selfcheck);

// 探针：在右侧（稳定模式）视图中心附近单击地面
const box = await page.locator('#gl').boundingBox();
await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.6);
await page.waitForTimeout(300);
const probe = await page.textContent('#probeOut');
console.log('--- 探针 ---');
console.log(probe);

// 导出
await page.click('#exportBtn');
const exported = await page.inputValue('#ioText');
const obj = JSON.parse(exported);
console.log('--- 导出校验 ---');
console.log('splits:', obj.splits.map((v) => v.toFixed(3)).join(', '));
console.log('级数:', obj.cascades.unstabilized.length, '/ 矩阵长度:',
  obj.cascades.unstabilized[0].lightViewProjRowMajor.length,
  '/ 纹素:', obj.cascades.stabilized[0].texelWorldSize.map((v) => v.toFixed(4)).join('x'));

// 导入复现：改参数 -> 导入旧 JSON -> 状态应还原
const importOK = await page.evaluate((json) => {
  const D = window.__CSB_DEBUG;
  D.state.lambda = 0.9; D.state.bias = 0.003; D.state.resolution = 256;
  document.getElementById('ioText').value = json;
  document.getElementById('importBtn').click();
  const s = D.state;
  return Math.abs(s.lambda - 0.5) < 1e-9 && Math.abs(s.bias - 0.0005) < 1e-9 && s.resolution === 512;
}, exported);
console.log('导入复现:', importOK ? '通过' : '失败');
if (!importOK) errors.push('import round-trip failed');

// 过渡带探针：分界 d1=16.0 附近（λ=0.5, w1=1.5）应报告过渡带混合
const band = await page.evaluate(() => {
  const D = window.__CSB_DEBUG;
  const f = D.lastFrame();
  // 在分界深度处构造地面点：cam.position + f * d1，投影到 y=0
  const cam = D.state.cam;
  const d1 = f.splits[1];
  // 沿相机前向找深度 d1 的点未必在地面；直接扫描地面点找 |depth-d1|<w1/2 的
  const C = window.CSM;
  const basis = f.camBasis;
  for (let z = -30; z < 12; z += 0.05) {
    const pt = [0, 0, z];
    const depth = C.vec.dot(C.vec.sub(pt, cam.position), basis.f);
    if (Math.abs(depth - d1) < f.bands[0] * 0.4) {
      const r = D.probeAt(pt, 'unstabilized');
      return { pt, depth, t: r.sel.t, from: r.sel.from, to: r.sel.to };
    }
  }
  return null;
});
console.log('过渡带探针:', JSON.stringify(band));
if (!band || band.to !== band.from + 1 || band.t <= 0 || band.t >= 1) {
  errors.push('transition band probe failed');
}

await page.screenshot({ path: '/tmp/csb-smoke.png' });
await browser.close();
server.close();

let failed = 0;
if (errors.length) { console.log('--- 控制台错误 ---\n' + errors.join('\n')); failed++; }
if (!selfcheck || selfcheck.split('\n').some((l) => l.startsWith('失败'))) { console.log('自检存在失败项'); failed++; }
if (!probe || !probe.includes('GPU 阴影值')) { console.log('探针无输出'); failed++; }
console.log(failed === 0 ? 'SMOKE_OK' : 'SMOKE_FAILED');
process.exit(failed === 0 ? 0 : 1);
