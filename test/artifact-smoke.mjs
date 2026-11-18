// artifact 单文件冒烟测试：服务 dist/，验证内联版本功能完整。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = join(ROOT, 'dist');
const SAMPLES = join(ROOT, '.work/samples-extract');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const f = join(BUILD, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (existsSync(f)) {
    res.setHeader('Content-Type', MIME[extname(f)] || 'application/octet-stream');
    createReadStream(f).pipe(res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(`http://localhost:${server.address().port}/index.html`, { waitUntil: 'networkidle' });
  ok((await page.title()) === '热方法曲面测距台', '单文件 artifact 加载（含 CDN UMD 依赖）');

  const upload = (id, name) =>
    page.setInputFiles(`#${id}`, { name, mimeType: 'application/json', buffer: readFileSync(join(SAMPLES, name)) });

  await page.click('#loadSampleBtn');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  ok(true, '内置样例自动求解');

  await upload('fileInput', 'flat.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  const diag = await page.textContent('#diagBox');
  ok(/热方程残差/.test(diag) && /1\.\d+e-1\d|2\.\d+e-1\d/.test(diag), '残差显示在 1e-14 量级');

  // 导出弹窗（artifact 沙箱下载失效，改用模态预览）
  await page.click('#exportDiagBtn');
  await page.waitForSelector('#modal:not(.hidden)');
  const modalText = await page.inputValue('#modalText');
  const parsed = JSON.parse(modalText);
  ok(parsed.components && parsed.cacheStats && parsed.excludedFaces, '诊断 JSON 模态预览内容合法');
  await page.click('#closeModal');

  // 对比
  await upload('fileInputB', 'folded.json');
  await page.waitForSelector('#compareBtn:not(:disabled)');
  await page.click('#compareBtn');
  await page.waitForFunction(() => /最大绝对差异：[\d.e+-]+/.test(document.querySelector('#compareResult').textContent));
  const diff = Number((await page.textContent('#compareResult')).match(/最大绝对差异：([\d.e+-]+)/)[1]);
  ok(diff <= 1e-6, `内联版折叠对比差异 ≤1e-6（${diff.toExponential(1)}）`);

  // 断开分量
  await upload('fileInput', 'disconnected.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('不可达顶点'));
  const un = await page.textContent('#unreachableCount');
  ok(un.trim() === '81', `不可达顶点 81（实测 ${un.trim()}）`);

  // 非流形拒绝
  await upload('fileInput', 'invalid-nonmanifold.json');
  await page.waitForSelector('#rejectMsg:not(.hidden)');
  ok((await page.textContent('#rejectMsg')).includes('非流形'), '非流形拒绝提示');

  await page.screenshot({ path: join(ROOT, '.work/artifact-screenshot.png') });
  ok(errors.filter((e) => !e.includes('deprecated')).length === 0, '无控制台错误（忽略 three r137 弃用警告）');
} catch (e) {
  fail++;
  console.error('  ✗', e.message);
}
await browser.close();
server.close();
console.log(`\nArtifact 冒烟测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
