/* 浏览器端到端测试（可选，需要本机全局 Playwright 与 chromium headless shell）。
 *
 *   node test/ui.e2e.js
 *
 * 环境变量：
 *   UI_URL            覆盖页面地址，默认用内置静态服务
 *   PLAYWRIGHT_PATH   覆盖 playwright 模块路径
 *   CHROME_PATH       覆盖 chromium headless shell 可执行文件路径
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(process.env.HOME || '', '.nvm/versions/node', process.version, 'lib/node_modules/playwright')
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  // 常见 nvm 布局：扫描已安装的 node 版本
  try {
    const base = path.join(process.env.HOME || '', '.nvm/versions/node');
    for (const v of fs.readdirSync(base)) {
      try { return require(path.join(base, v, 'lib/node_modules/playwright')); } catch { /* next */ }
    }
  } catch { /* ignore */ }
  return null;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.HOME || '', '.cache/ms-playwright');
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell'));
    dirs.sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return undefined;
}

const pw = loadPlaywright();
if (!pw) {
  console.log('跳过浏览器测试：未找到 Playwright。');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip' };
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

(async () => {
  const { server, port } = await startServer();
  const URL = process.env.UI_URL || `http://127.0.0.1:${port}/`;
  const browser = await pw.chromium.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, acceptDownloads: true });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    console.log('1) 载入内置示例');
    await page.goto(URL);
    await page.click('#btnSample');
    await page.waitForFunction(() => window.__paperGrid && window.__paperGrid.state.cases.length > 0);
    const sample = await page.evaluate(() => {
      const c = window.__paperGrid.state.cases[0];
      return { loss: c.solved.result.loss, count: c.solved.result.count, edges: c.solved.edges.length };
    });
    ok('示例总损失 5083', sample.loss === 5083, String(sample.loss));
    ok('示例矩形数 5', sample.count === 5, String(sample.count));
    ok('内部短边 7 条', sample.edges === 7, String(sample.edges));

    console.log('2) 点边显示两种损失与强制相反结果');
    await page.click('#edgeBody tr:first-child');
    const detail = await page.evaluate(() => ({
      id: document.getElementById('edgeId').textContent,
      keep: document.getElementById('edgeKeep').textContent,
      remove: document.getElementById('edgeRemove').textContent,
      force: document.getElementById('forceResult').textContent
    }));
    ok('显示短边 v(0,1)', /v\(0,1\)/.test(detail.id), detail.id);
    ok('保留损失 9,555', detail.keep === '9,555', detail.keep);
    ok('去掉损失 390', detail.remove === '390', detail.remove);
    ok('强制相反显示 14,248', /14,248/.test(detail.force), detail.force);

    console.log('3) 锁定并重新求解');
    await page.click('#lockKeep');
    await page.waitForTimeout(200);
    const locked = await page.evaluate(() => {
      const c = window.__paperGrid.state.cases[0];
      return { loss: c.solved.result.loss, exportDisabled: document.getElementById('btnExport').disabled };
    });
    ok('锁定后总损失升为 14,248', locked.loss === 14248, String(locked.loss));
    ok('锁定后仍可导出', locked.exportDisabled === false);

    console.log('4) 制造 L 形冲突并禁止下载');
    await page.evaluate(() => {
      const g = window.__paperGrid;
      g.setLock(0, 'v', 0, 1, false, true);
      g.setLock(0, 'v', 1, 1, false, true);
      g.setLock(0, 'h', 1, 0, false, true);
      g.setLock(0, 'h', 1, 1, true, true);
      g.afterLockChange();
    });
    await page.waitForTimeout(200);
    const conflict = await page.evaluate(() => ({
      feasible: window.__paperGrid.state.cases[0].solved.result.feasible,
      banner: !document.getElementById('conflictBanner').hidden,
      exportDisabled: document.getElementById('btnExport').disabled,
      copyDisabled: document.getElementById('btnCopy').disabled
    }));
    ok('锁定组合不可行', conflict.feasible === false);
    ok('显示冲突条', conflict.banner === true);
    ok('禁止下载', conflict.exportDisabled === true);
    ok('禁止复制', conflict.copyDisabled === true);

    console.log('5) 解除冲突后恢复');
    await page.evaluate(() => {
      const g = window.__paperGrid;
      g.setLock(0, 'h', 1, 1, false, false);
      g.setLock(0, 'v', 0, 1, false, false);
      g.setLock(0, 'v', 1, 1, false, false);
      g.setLock(0, 'h', 1, 0, false, false);
      g.afterLockChange();
    });
    await page.waitForTimeout(200);
    const recovered = await page.evaluate(() => ({
      feasible: window.__paperGrid.state.cases[0].solved.result.feasible,
      bannerHidden: document.getElementById('conflictBanner').hidden,
      exportDisabled: document.getElementById('btnExport').disabled,
      loss: window.__paperGrid.state.cases[0].solved.result.loss
    }));
    ok('恢复可行', recovered.feasible === true);
    ok('冲突条消失', recovered.bannerHidden === true);
    ok('恢复原最优 5083', recovered.loss === 5083, String(recovered.loss));
    ok('导出重新可用', recovered.exportDisabled === false);

    console.log('6) 下载 JSON');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
    const dlPath = path.join(require('node:os').tmpdir(), 'pgc-e2e-' + Date.now() + '.json');
    await dl.saveAs(dlPath);
    const obj = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
    fs.unlinkSync(dlPath);
    ok('JSON 格式标记', obj.format === 'paper-grid-evidence/merge-review');
    ok('JSON 总损失一致', obj.totalLoss === 5083);
    ok('JSON 矩形数与损失自洽',
      obj.rectangles.length === obj.rectangleCount &&
      obj.edges.reduce((s, e) => s + (e.decision === 'keep' ? e.keepLoss : e.removeLoss), 0) === obj.totalLoss);

    console.log('7) 满额 24×8 计时');
    await page.click('#btnFull');
    await page.waitForFunction(() => {
      const c = window.__paperGrid.state.cases[0];
      return c && c.name === '满额 24×8' && c.solved;
    }, { timeout: 15000 });
    const full = await page.evaluate(() => {
      const c = window.__paperGrid.state.cases[0];
      const truth = c.truth.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
      const got = c.solved.result.rects;
      let diff = 0;
      for (let i = 0; i < Math.max(truth.length, got.length); i++) {
        if (JSON.stringify(truth[i]) !== JSON.stringify(got[i])) diff++;
      }
      return { ms: c.solveMs, diff, count: c.solved.result.count, feasible: c.solved.result.feasible };
    });
    ok('满额求解 5 秒内', full.ms < 5000, full.ms.toFixed(0) + ' ms');
    ok('满额解与合成真值一致', full.diff === 0, 'diff=' + full.diff);

    ok('无脚本错误', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
