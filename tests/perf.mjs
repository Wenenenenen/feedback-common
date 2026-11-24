// 满额输入性能测试：20 s 扫频 + 25 s 四通道采集，在真实 Chromium 里计时。
// 要求：从导入完成到预览可用的总耗时 < 10 s（4 逻辑核 / 8 GiB 模拟）。
//
// 用法：node tests/perf.mjs [--json]
// 无 Playwright 时退出码 2（跳过）。
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function globalRoot() {
  return path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
}
let chromium = null;
try {
  ({ chromium } = require(path.join(globalRoot(), 'playwright')));
} catch {
  console.error('跳过：未安装 Playwright');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.wav': 'audio/wav',
};

/* 生成满额测试包（缓存在 .cache/perf） */
async function ensureFullCase() {
  const dir = path.join(ROOT, '.cache', 'perf');
  const file = path.join(dir, 'full.zip');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const { buildCases, caseToZip } = await import('../tools/make-case.mjs');
  const [c] = buildCases(true);
  fs.writeFileSync(file, caseToZip(c));
  return file;
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const f = path.normalize(path.join(ROOT, u === '/' ? 'index.html' : u));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = process.argv.includes('--json');

const zipFile = await ensureFullCase();
const size = fs.statSync(zipFile).size;
const { server, port } = await serve();
const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=4096'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  // 以页面内 performance.now 计时：从选择文件到四个通道结果齐全、图表已画
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', zipFile);
  await page.waitForFunction(
    () => {
      const s = window.__shm && window.__shm.state;
      if (!s) return false;
      const cap = s.capture;
      if (!cap) return false;
      return s.results.length === cap.info.channels && s.results.every((r) => r && r.analysis && r.analysis.overview);
    },
    null,
    { timeout: 120000, polling: 50 },
  );
  // 等两帧，确保画布已重绘
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const elapsed = Date.now() - t0;
  const info = await page.evaluate(() => {
    const s = window.__shm.state;
    return {
      channels: s.results.map((r) => ({
        ch: r.channel + 1,
        zero: r.analysis.zero,
        rel: r.analysis.zeroRel,
        windows: r.analysis.windows.map((w) => ({ q: w.q, center: w.center, energy: w.energy })),
      })),
      lastMs: s.lastMs,
      sweeFrames: s.sweep.info.frames,
      captureFrames: s.capture.info.frames,
      captureChannels: s.capture.info.channels,
    };
  });
  const ok = elapsed < 10000 && errors.length === 0;
  const report = { ok, elapsed_ms: elapsed, page_ms: Math.round(info.lastMs), zip_mib: +(size / 1048576).toFixed(1), ...info, errors };
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`满额输入：扫频 ${info.sweeFrames} 帧（20 s）、采集 ${info.captureFrames} 帧（25 s）× ${info.captureChannels} 声道`);
    console.log(`包大小 ${report.zip_mib} MiB；预览总耗时 ${elapsed} ms（页面内部计时 ${report.page_ms} ms）`);
    for (const c of info.channels) {
      console.log(`  通道 ${c.ch}：零点 ${c.zero}（rel ${c.rel}）` + c.windows.map((w) => ` · q${w.q} E=${w.energy.toExponential(2)}`).join(''));
    }
    if (errors.length) console.log('页面错误：', errors);
    console.log(ok ? '通过：满额输入 < 10 s 生成预览' : '未通过');
  }
  if (!ok) exitCode = 1;
} catch (e) {
  console.error('性能测试失败：', e.message);
  if (errors.length) console.error('页面错误：', errors.join(' | '));
  exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
process.exit(exitCode);
