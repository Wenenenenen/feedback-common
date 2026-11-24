// 真实浏览器回归：载入内置样例、检查联动、改参数、制造冲突、导出并校验 ZIP。
// 运行：先 `node tools/serve.mjs 8137`，再 `node tools/browser-test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = require(path.join(ROOT, 'js', 'zip.js'));
const PNM = require(path.join(ROOT, 'js', 'pnm.js'));

function loadReference() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'reference.json'), 'utf8'));
  const c = data.cases.find((x) => x.name === 'sample-default');
  return { sampleU0: c.ux[0], sampleCrops: c.crops };
}
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });

let chromium = null;
try {
  const pw = require(path.join(execGlobalRoot(), 'playwright'));
  chromium = pw.chromium;
} catch { /* not installed */ }
function execGlobalRoot() {
  const p = process.execPath;
  return path.join(path.dirname(p), '..', 'lib', 'node_modules');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip', '.ppm': 'image/x-portable-pixmap',
};
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const target = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
      if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let passed = 0; let failed = 0; const failures = [];
function check(cond, label, detail) {
  if (cond) { passed++; return true; }
  failed++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); return false;
}

async function withPage(fn) {
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => window.SAPApp && window.SAPApp.state.result, null, { timeout: 15000 });
    await fn(page, port);
    check(errors.length === 0, '无页面错误', errors.join(' | '));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

test('样例载入与联动', async () => {
  if (!chromium) { console.log('SKIP: playwright/chromium 不可用'); return; }
  await withPage(async (page) => {
    // 读取样例参考
    const ref = loadReference();
    check(ref, '参考数据可加载');
    const state = await page.evaluate(() => ({
      ok: window.SAPApp.state.result.ok, frameCount: window.SAPApp.state.dataset.manifest.frameCount,
      shots: window.SAPApp.state.dataset.tracking.shots.length,
      crop: window.SAPApp.state.result.params.cropW + 'x' + window.SAPApp.state.result.params.cropH,
      boundX: window.SAPApp.state.result.boundX, boundY: window.SAPApp.state.result.boundY,
      u0: window.SAPApp.state.result.ux[0], u5: window.SAPApp.state.result.ux[5],
    }));
    check(state.ok, '初始求解成功');
    check(state.frameCount === 6, `6 帧（${state.frameCount}）`);
    check(state.shots === 1, `1 个镜头（${state.shots}）`);
    check(state.crop === '56x36', `默认裁幅 56×36（${state.crop}）`);
    check(Math.abs(state.boundX - 3) < 1e-9, `横向允许范围 3（${state.boundX}）`);
    check(Math.abs(state.boundY - 1) < 1e-9, `纵向允许范围 1（${state.boundY}）`);
    check(Math.abs(state.u0 - ref.sampleU0) < 1e-9, `首帧偏移 ${state.u0}`);

    // 帧导航
    await page.evaluate(() => window.SAPApp.setFrame(3));
    const f = await page.evaluate(() => window.SAPApp.state.frame);
    check(f === 3, '跳转到第 3 帧');

    // 参数联动：改宽
    await page.evaluate(() => {
      window.SAPApp.setParams({ cropW: 48, cropH: 36 });
      return window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => ({
      boundX: window.SAPApp.state.result.boundX, crop: window.SAPApp.state.result.params.cropW,
    }));
    check(after.crop === 48, '改宽后裁幅更新');
    check(Math.abs(after.boundX - ((64 - 48) / 2 - 1)) < 1e-9, `边界随裁幅更新 x（${after.boundX}）`);
  });
});

test('冲突：边距过大保留上次结果，恢复后重算', async () => {
  if (!chromium) return;
  await withPage(async (page) => {
    // 边距加大到不可行（余量 (64-56)/2=4；先锁一个 3.0 的偏移再设边距 2）
    await page.evaluate(() => {
      window.SAPApp.setParams({ pins: [{ frame: 0, x: 3.0, y: 0 }] });
      window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(60);
    const withPin = await page.evaluate(() => ({
      ok: window.SAPApp.state.result.ok, u0: window.SAPApp.state.result.ux[0],
    }));
    check(withPin.ok, '边距 1 时可锁定 3.0');
    check(Math.abs(withPin.u0 - 3.0) < 1e-9, `锁定值精确生效（${withPin.u0}）`);
    await page.evaluate(() => {
      window.SAPApp.setParams({ margin: 2 });
      window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(80);
    const conflict = await page.evaluate(() => ({
      stale: window.SAPApp.state.stale,
      errText: document.getElementById('banner').textContent,
      status: document.getElementById('statusText').textContent,
      u0: window.SAPApp.state.result.ux[0],
      crop: window.SAPApp.state.result.params.cropW,
    }));
    check(conflict.stale, '边距 2 时判为冲突');
    check(/允许范围|第 0 帧/.test(conflict.errText), `冲突提示说明原因：${conflict.errText.slice(0, 60)}`);
    check(Math.abs(conflict.u0 - withPin.u0) < 1e-12, '保留上次偏移');
    check(conflict.status.includes('上次结果') || conflict.status.includes('上次'), `状态显示保留：${conflict.status}`);

    // 恢复可行
    await page.evaluate(() => {
      window.SAPApp.setParams({ margin: 1 });
      window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(60);
    const restored = await page.evaluate(() => ({ stale: window.SAPApp.state.stale, ok: window.SAPApp.state.result.ok }));
    check(restored.ok && !restored.stale, '恢复可行后重新计算');
  });
});

test('冲突：锁点越界', async () => {
  if (!chromium) return;
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.SAPApp.setParams({ pins: [{ frame: 3, x: 10, y: 0 }] });
      window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(80);
    const r = await page.evaluate(() => ({
      stale: window.SAPApp.state.stale, text: document.getElementById('banner').textContent,
    }));
    check(r.stale, '锁点越界判为冲突');
    check(/第 3 帧/.test(r.text), '指出具体帧');
  });
});

test('导出 ZIP 结构与像素', async () => {
  if (!chromium) return;
  await withPage(async (page) => {
    // 浏览器内导出并回读
    const result = await page.evaluate(async () => {
      const bytes = await window.SAPApp.exportZip();
      return Array.from(bytes.slice(0, 8));
    });
    check(result.length === 8, '导出返回字节');
    // 通过浏览器下载重定向拿到完整文件
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => document.getElementById('exportBtn').click()),
    ]);
    const tmp = path.join(OUT, 'browser-export.zip');
    await download.saveAs(tmp);
    const files = await ZIP.unzip(fs.readFileSync(tmp));
    const names = [...files.keys()].sort();
    check(names.length === 7, `ZIP 含 6 帧 + 1 JSON（${names.length}）`);
    check(names.includes('frames/0000.ppm') && names.includes('frames/0005.ppm'), '帧号四位');
    const offsets = JSON.parse(new TextDecoder().decode(files.get('offsets.json')));
    check(Array.isArray(offsets) && offsets.length === 6 && offsets.every((o) => o.length === 2), '偏移 JSON 形状');
    const ref = loadReference();
    check(Math.abs(offsets[0][0] - ref.sampleU0) < 1e-4, `导出偏移与参考一致（${offsets[0][0]}）`);
    // 帧尺寸
    const info = PNM.readPnmInfo(files.get('frames/0000.ppm'));
    check(info.width === 56 && info.height === 36, 'P6 尺寸 56×36');
  });
});

test('像素检视与主题', async () => {
  if (!chromium) return;
  await withPage(async (page) => {
    // 在裁后图上移动指针
    const box = await page.locator('#cropCanvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(60);
    const insp = await page.evaluate(() => ({
      out: document.getElementById('inspOut').textContent,
      rgb: document.getElementById('inspRgb').textContent,
      weights: document.getElementById('inspWeights').textContent,
    }));
    check(insp.out !== '—', '光标悬停给出输出坐标');
    check(/\d+,\s*\d+,\s*\d+/.test(insp.rgb), `给出输出 RGB：${insp.rgb}`);
    check(insp.weights !== '—', '给出双线性权重');

    // 主题切换
    const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    await page.evaluate(() => window.SAPApp.applyTheme('dark'));
    const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    check(before !== after, '主题切换改变配色令牌');
  });
});

test('不可行：输出画幅超过源', async () => {
  if (!chromium) return;
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.SAPApp.setParams({ cropW: 70, cropH: 36 });
      window.SAPApp.runFit({ announce: false });
    });
    await page.waitForTimeout(60);
    const r = await page.evaluate(() => ({ stale: window.SAPApp.state.stale, text: document.getElementById('banner').textContent }));
    check(r.stale, '画幅超源判为冲突');
  });
});

process.on('exit', () => {
  console.log(`\n${failed === 0 ? 'BROWSER TEST PASSED' : 'BROWSER TEST FAILED'} — ${passed} 通过，${failed} 失败`);
  for (const f of failures) console.log(` ✗ ${f}`);
  if (failed) process.exitCode = 1;
});
