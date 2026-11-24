// 1800 帧端到端：导入大样本、改安全边距、量测轨迹更新耗时、核对两镜头独立、导出。
// 运行：先 `node tools/serve.mjs 8137`，并 `python3 tools/gen-large.py`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-output');
const BIG = path.join(OUT, 'large-1800.zip');

let chromium = null;
try {
  const pw = require(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright'));
  chromium = pw.chromium;
} catch { /* not installed */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const target = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
      if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('1800 帧端到端', async () => {
  if (!chromium) { console.log('SKIP: playwright 不可用'); return; }
  if (!fs.existsSync(BIG)) { console.log('SKIP: 先生成 test-output/large-1800.zip'); return; }
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => window.SAPApp && window.SAPApp.state.result, null, { timeout: 15000 });
    const zipBuf = fs.readFileSync(BIG);
    const t0 = Date.now();
    const loadRes = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const r = await window.SAPApp.importBuffer(arr.buffer, 'large-1800.zip');
      return { ok: r.ok, error: r.error };
    }, zipBuf.toString('base64'));
    const loadMs = Date.now() - t0;
    assert.ok(loadRes.ok, `导入大样本：${loadRes.error || ''}`);
    const info = await page.evaluate(() => ({
      frames: window.SAPApp.state.dataset.manifest.frameCount,
      shots: window.SAPApp.state.dataset.tracking.shots.length,
      starts: window.SAPApp.state.dataset.tracking.shots.map((s) => s.start),
      cw: window.SAPApp.state.result.params.cropW,
      pixels: window.SAPApp.state.dataset.totalPixels,
    }));
    console.log(` 导入 ${loadMs} ms；${info.frames} 帧，${info.shots} 个镜头，${(info.pixels / 1e6).toFixed(1)} M 像素`);
    assert.equal(info.frames, 1800);
    assert.equal(info.shots, 2, '900 帧硬切为两镜头');
    assert.deepEqual(info.starts, [0, 900]);

    // 量测：改安全边距 → 轨迹更新耗时（页面内）
    const timings = [];
    for (const margin of [2, 3, 4, 5, 6]) {
      const ms = await page.evaluate((m) => {
        const el = document.getElementById('marginNum');
        const t = performance.now();
        window.SAPApp.setParams({ margin: m });
        window.SAPApp.runFit({ announce: false });
        return performance.now() - t;
      }, margin);
      const ok = await page.evaluate(() => window.SAPApp.state.result.ok);
      assert.ok(ok, `边距 ${margin} 求解成功`);
      timings.push(ms);
    }
    const worst = Math.max(...timings);
    console.log(` 改安全边距耗时（页面内）：${timings.map((t) => t.toFixed(0)).join(', ')} ms；最慢 ${worst.toFixed(0)} ms`);
    assert.ok(worst < 8000, `1800 帧改边距 ${worst.toFixed(0)} ms < 8000 ms`);

    // 切点两侧独立：两镜头在切点处的偏移互不相等（各不相同）
    const boundary = await page.evaluate(() => ({
      ux899: window.SAPApp.state.result.ux[899],
      ux900: window.SAPApp.state.result.ux[900],
      p900: window.SAPApp.state.dataset.tracking.p[0][900],
      p899: window.SAPApp.state.dataset.tracking.p[0][899],
    }));
    assert.equal(boundary.p900, 0, '切点帧轨迹归零');
    assert.notEqual(boundary.p899, 0);
    console.log(` 切点：p[899]=${boundary.p899.toFixed(2)}，p[900]=0；u[899]=${boundary.ux899.toFixed(3)}，u[900]=${boundary.ux900.toFixed(3)}`);

    // 导出并核对
    const zipOut = await page.evaluate(async () => {
      const bytes = await window.SAPApp.exportZip();
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return btoa(s);
    });
    const outPath = path.join(OUT, 'large-export.zip');
    fs.writeFileSync(outPath, Buffer.from(zipOut, 'base64'));
    console.log(` 导出 ${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB`);
    const ZIP = require(path.join(ROOT, 'js', 'zip.js'));
    const files = await ZIP.unzip(fs.readFileSync(outPath));
    assert.ok(files.has('frames/0000.ppm') && files.has('frames/1799.ppm'), '导出帧号四位');
    const offs = JSON.parse(new TextDecoder().decode(files.get('offsets.json')));
    assert.equal(offs.length, 1800, '1800 条偏移');
    // 抽查两镜头
    for (const t of [100, 450, 1100, 1500]) {
      assert.ok(Array.isArray(offs[t]) && offs[t].length === 2, `偏移[${t}] 形状`);
    }
    assert.equal(errors.length, 0, `无页面错误：${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
