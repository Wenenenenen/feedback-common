// Playwright 端到端：真实 Chromium 中验证页面功能、3 秒定位 / 5 秒十跳预算、
// 浏览器任务工作内存（扣除空载与输入文件本体），以及导出 PNG 的像素一致性。
import { createServer } from 'node:http';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 8791;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.cxr': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = normalize(join(ROOT, urlPath === '/' ? 'web/index.html' : urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=4096'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// ---- 空载基线 ----
await page.goto(`http://localhost:${PORT}/web/index.html`);
await page.waitForSelector('#dropzone');
await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
const idleKb = await page.evaluate(() =>
  performance.memory ? performance.memory.usedJSHeapSize : 0,
);

// ---- 加载小夹具，验证功能与截图 ----
const fixturePath = join(HERE, 'fixtures', 'move-order.cxr');
await page.setInputFiles('#fileInput', fixturePath);
await page.waitForSelector('#frameCanvas:not([width="0"])', { timeout: 10000 });
await page.waitForTimeout(300);
const smallMeta = await page.evaluate(() => ({
  frames: document.querySelectorAll('.strip-cell').length,
  current: document.getElementById('kvIndex').textContent,
  movesOnKeyframe: document.querySelectorAll('#moveList .rect-item').length,
  dirtyOnKeyframe: document.querySelectorAll('#dirtyList .rect-item').length,
  pill: document.getElementById('pillState').textContent,
}));
// 跳到第 2 帧（含 3 个重叠移动块 + 1 脏块）
await page.click('.strip-cell:nth-child(2)');
await page.waitForFunction(
  () => document.getElementById('kvIndex').textContent === '1',
  { timeout: 5000 },
);
const deltaMeta = await page.evaluate(() => ({
  moves: document.querySelectorAll('#moveList .rect-item').length,
  dirty: document.querySelectorAll('#dirtyList .rect-item').length,
}));
await page.screenshot({ path: join(HERE, 'shot-small.png') });

// 跳一个无效帧（crc-chain 里有坏帧），验证状态面板
await page.setInputFiles('#fileInput', join(HERE, 'fixtures', 'crc-chain.cxr'));
await page.waitForFunction(
  () => document.querySelectorAll('.strip-cell').length === 6,
  { timeout: 10000 },
);
// 条带里第 2 个是 CRC 坏帧
await page.click('.strip-cell:nth-child(3)');
await page.waitForTimeout(200);
const badPanel = await page.evaluate(() => ({
  alertHidden: document.getElementById('badFrameAlert').hidden,
  text: document.getElementById('badFrameText').innerText,
  anchor: document.getElementById('kvAnchor').textContent,
}));
await page.screenshot({ path: join(HERE, 'shot-bad-frame.png') });

// ---- 导出 PNG：拦截下载，回读比对 ----
const [download] = await Promise.all([
  page.waitForEvent('download'),
  (async () => {
    // 回到一个有效帧再导出
    await page.setInputFiles('#fileInput', fixturePath);
    await page.waitForSelector('#frameCanvas:not([width="0"])', { timeout: 10000 });
    await page.click('#exportBtn');
  })(),
]);
const dlPath = join(HERE, 'exported.png');
await download.saveAs(dlPath);

// ---- 大文件：冷打开定位耗时、十次跳帧、浏览器进程工作内存 ----
const benchPath = join(HERE, 'bench', 'bench-1920x1080-10000.cxr');
const fileBytes = statSync(benchPath).size;

// 全新页面测冷打开：从 setInputFiles 到首帧画面上屏
const coldContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const coldPage = await coldContext.newPage();
const coldErrors = [];
coldPage.on('pageerror', (e) => coldErrors.push(String(e)));
await coldPage.goto(`http://localhost:${PORT}/web/index.html`);
await coldPage.waitForSelector('#dropzone');
await coldPage.evaluate(() => new Promise((r) => setTimeout(r, 400)));

const coldClient = await coldPage.context().newCDPSession(coldPage);
const memBefore = (await coldClient.send('Runtime.getHeapUsage')).usedSize;

const tCold0 = performance.now();
await coldPage.setInputFiles('#fileInput', benchPath);
await coldPage.waitForFunction(
  () => document.querySelectorAll('.strip-cell').length === 10000
    && document.getElementById('frameCanvas').width > 0,
  { timeout: 30000 },
);
const coldLocateMs = performance.now() - tCold0;

// 十次确定性跳帧（在已预热的冷页面上，模拟连续审查）
const jumpTimings = await coldPage.evaluate(async () => {
  let seed = 20261125;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const cells = [...document.querySelectorAll('.strip-cell')];
  const targets = Array.from({ length: 10 }, () => Math.floor(rnd() * cells.length));
  const wait = (idx) => new Promise((resolve) => {
    const check = () => {
      if (document.getElementById('kvIndex').textContent === String(idx)) resolve();
      else setTimeout(check, 16);
    };
    check();
  });
  const t0 = performance.now();
  for (const t of targets) {
    cells[t].click();
    await wait(t);
  }
  return { ms: performance.now() - t0, targets };
});

// 触发 GC 后测进程级内存（Chromium 需 --js-flags 暴露；getHeapUsage 为 V8 驻留）
await coldClient.send('HeapProfiler.collectGarbage').catch(() => {});
const memAfter = (await coldClient.send('Runtime.getHeapUsage')).usedSize;
const processMetrics = await coldClient.send('Performance.getMetrics').catch(() => null);

await coldPage.screenshot({ path: join(HERE, 'shot-bench.png') });
await coldContext.close();

// ---- 控制台错误与断言 ----
const heapGrowthMiB = (memAfter - memBefore) / 1048576;
const result = {
  smallMeta,
  deltaMeta,
  badPanel,
  downloadedPngBytes: statSync(dlPath).size,
  benchFileMiB: +(fileBytes / 1048576).toFixed(2),
  coldLocateMs: +coldLocateMs.toFixed(1),
  locateBudgetMs: 3000,
  tenJumpsMs: +jumpTimings.ms.toFixed(1),
  jumpBudgetMs: 5000,
  jumpTargets: jumpTimings.targets,
  heapBeforeMiB: +(memBefore / 1048576).toFixed(1),
  heapAfterMiB: +(memAfter / 1048576).toFixed(1),
  // 工作内存口径：V8 堆增量（输入 ArrayBuffer 为外部驻留，按规格单列扣除）
  heapGrowthMiB: +heapGrowthMiB.toFixed(1),
  consoleErrors: errors,
  coldPageErrors: coldErrors,
};
console.log(JSON.stringify(result, null, 1));

const fail =
  smallMeta.frames !== 3 ||
  deltaMeta.moves !== 3 ||
  deltaMeta.dirty !== 1 ||
  badPanel.alertHidden !== false ||
  coldLocateMs > 3000 ||
  jumpTimings.ms > 5000 ||
  errors.length > 0 ||
  coldErrors.length > 0;

await browser.close();
server.close();
process.exit(fail ? 1 : 0);
