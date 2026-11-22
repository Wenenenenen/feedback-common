/**
 * 真实浏览器冒烟测试（node tools/browser-smoke.mjs）：
 * 启动静态服务器 → 打开页面 → 校验样例渲染 → 对像素点击、参数调节、导入非法 JSON、
 * 下载导出文件逐字节比对 → 截图。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildScene, parseCaseSet, integratePixel } from '../js/shutter.js';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(ROOT, '.smoke-shots');
const PORT = 8137;
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await mkdir(SHOTS, { recursive: true });
const server = spawn(process.execPath, [join(HERE, 'serve.mjs'), String(PORT), ROOT], { cwd: ROOT });
await new Promise((r) => server.stdout.on('data', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => d.dismiss());

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });

  // 1. 初始样例渲染
  const caseOptions = await page.$$eval('#caseSelect option', (os) => os.map((o) => o.textContent));
  check('样例 case 列表', JSON.stringify(caseOptions) === JSON.stringify(['flash', 'cross', 'curved-event']), JSON.stringify(caseOptions));
  const integratedSize = await page.evaluate(() => ({ w: document.getElementById('integratedCanvas').width, h: document.getElementById('integratedCanvas').height }));
  check('积分画布已渲染', integratedSize.w > 0 && integratedSize.h > 0, JSON.stringify(integratedSize));

  // 2. cross 中心像素应约为 R=0.5,B=0.5
  await page.selectOption('#caseSelect', { label: 'cross' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
  await page.waitForTimeout(150);
  const crossCenter = await page.evaluate(() => {
    const cv = document.getElementById('integratedCanvas');
    const ctx = cv.getContext('2d');
    const scale = cv.width / 5;
    const d = ctx.getImageData(Math.floor(2.5 * scale), Math.floor(2.5 * scale), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  // 线性 0.5 经 sRGB 编码 ≈ 188
  check('cross 中心像素约 (R≈0.5,B≈0.5) sRGB', Math.abs(crossCenter[0] - 188) <= 2 && crossCenter[1] === 0 && Math.abs(crossCenter[2] - 188) <= 2, JSON.stringify(crossCenter));

  // 3. 点击像素 → 探查面板
  await page.click('#integratedCanvas', { position: { x: 40, y: 40 } });
  await page.waitForSelector('.seg-table', { timeout: 5000 });
  const segRows = await page.$$eval('.seg-table tbody tr', (rows) => rows.length);
  check('点击后出现分段表', segRows >= 1, `rows=${segRows}`);
  const probeMeta = await page.textContent('#probeMeta');
  check('探查元信息包含像素坐标', /像素 \(\d+, \d+\)/.test(probeMeta), probeMeta);
  const timeline = await page.$('#timelineSvg');
  check('时间轴 SVG 存在', !!timeline);

  // 4. 切换 case：flash 与 curved-event
  for (const label of ['flash', 'curved-event']) {
    await page.selectOption('#caseSelect', { label });
    await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
    const visible = await page.isVisible('#integratedCanvas');
    check(`${label} 渲染且画布可见`, visible);
  }

  // 5. 参数调节后重算
  await page.selectOption('#caseSelect', { label: 'flash' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
  await page.fill('#startRange', '0.25');
  await page.dispatchEvent('#startRange', 'input');
  await page.fill('#durationRange', '0.4');
  await page.dispatchEvent('#durationRange', 'input');
  await page.click('[data-weight="triangle"]');
  await page.click('[data-scan="up"]');
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
  const windowInfo = await page.textContent('#windowInfo');
  check('参数变化后窗口信息更新', windowInfo.startsWith('窗口'));
  const scanDirActive = await page.$eval('[data-scan="up"]', (b) => b.classList.contains('active'));
  check('扫描方向按钮状态切换', scanDirActive);

  // 6. 下载线性像素并与 Node 侧独立计算逐字节比对
  await page.selectOption('#caseSelect', { label: 'flash' });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
  // 重置参数到默认（用恢复样例按钮会回到 flash 默认参数？参数不改；显式设回）
  await page.evaluate(() => {
    const s = document.getElementById('startRange');
    s.value = '0'; s.dispatchEvent(new Event('input'));
    const d = document.getElementById('durationRange');
    d.value = '1'; d.dispatchEvent(new Event('input'));
    const sd = document.getElementById('scanDelayRange');
    sd.value = '0'; sd.dispatchEvent(new Event('input'));
    document.querySelector('[data-weight="uniform"]').click();
    document.querySelector('[data-scan="down"]').click();
  });
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlLinear'),
  ]);
  const dlPath = join(SHOTS, 'downloaded-linear.bin');
  await download.saveAs(dlPath);
  const dlBytes = await readFile(dlPath);
  check('线性下载长度 = W*H*3*8', dlBytes.length === 5 * 4 * 3 * 8, `${dlBytes.length}`);

  // Node 侧独立计算参考
  const raw = JSON.parse(await readFile(join(ROOT, 'samples', 'shutter-integral-cases.json'), 'utf8'));
  const set = parseCaseSet(raw);
  const flash = set.cases.find((c) => c.id === 'flash');
  const scene = buildScene(flash);
  const params = { start: 0, duration: 1, scanDelay: 0, scanDir: 'down', weight: 'uniform' };
  const dv = new DataView(dlBytes.buffer, dlBytes.byteOffset, dlBytes.byteLength);
  let maxDiff = 0;
  for (let py = 0; py < scene.H; py++) {
    for (let px = 0; px < scene.W; px++) {
      const r = integratePixel(scene, px, py, params, false);
      const o = (py * scene.W + px) * 3;
      for (let k = 0; k < 3; k++) {
        const got = dv.getFloat64((o + k) * 8, true);
        maxDiff = Math.max(maxDiff, Math.abs(got - r.rgb[k]));
      }
    }
  }
  check('浏览器下载的线性数据与 Node 参考一致', maxDiff < 1e-12, `maxDiff=${maxDiff}`);

  // 7. 下载 PNG 并校验签名/尺寸
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlPng'),
  ]);
  const pngPath = join(SHOTS, 'downloaded-preview.png');
  await pngDownload.saveAs(pngPath);
  const pngBytes = await readFile(pngPath);
  check('PNG 签名正确', pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47);
  const pngW = pngBytes.readUInt32BE(16);
  const pngH = pngBytes.readUInt32BE(20);
  check('PNG 尺寸正确', pngW === scene.W && pngH === scene.H, `${pngW}x${pngH}`);

  // 8. 导入非法 JSON → 错误横幅且原场景不变
  const badPath = join(SHOTS, 'bad.json');
  await writeFile(badPath, JSON.stringify({ cases: [{ size: [4, 4], cards: [{ id: 'x', rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0]], depth: [1, 1], f: [[0, 1, 2]] }] }] }));
  await page.setInputFiles('#fileInput', badPath);
  await page.waitForSelector('#errorBanner:not([hidden])', { timeout: 5000 });
  const errText = await page.textContent('#errorList');
  check('非法导入显示错误', errText.includes('一致'), errText.slice(0, 80));
  const stillFlash = await page.textContent('#caseSelect');
  check('非法导入后场景未变', stillFlash.includes('flash'));

  // 9. 导入合法 JSON（单个 case 形态）
  const goodCase = {
    size: [8, 6],
    background: [0.05, 0.05, 0.08],
    cards: [{
      id: 'sweep', rgb: [0.2, 0.9, 0.4],
      xy0: [[0, 2], [1, 2], [1, 4], [0, 4]],
      xy1: [[7, 2], [8, 2], [8, 4], [7, 4]],
      depth: [1, 1],
      f: [[0, 1, 2], [0, 2, 3]],
    }],
  };
  const goodPath = join(SHOTS, 'good.json');
  await writeFile(goodPath, JSON.stringify(goodCase));
  await page.setInputFiles('#fileInput', goodPath);
  await page.waitForFunction(() => document.getElementById('runText').textContent === '完成', null, { timeout: 15000 });
  const summary = await page.textContent('#caseSummary');
  check('合法导入后尺寸更新为 8×6', summary.includes('8 × 6'), summary.replace(/\s+/g, ' ').slice(0, 80));

  // 10. 无控制台错误
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: join(SHOTS, 'final.png'), fullPage: true });
  console.log(`\n截图：${join(SHOTS, 'final.png')}`);
} catch (e) {
  failures++;
  console.log(`FAIL  冒烟流程异常 — ${e.stack || e}`);
  try { await page.screenshot({ path: join(SHOTS, 'failure.png'), fullPage: true }); } catch {}
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
