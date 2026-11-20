/**
 * 真实浏览器冒烟测试（node tools/browser-smoke.mjs）：
 * 启动静态服务器 → 打开页面 → 注入样例文件 → 跑完整 UI 流程 → 截图。
 * 仅读取 samples/extracted 下的样例，路径通过参数传入。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildModel } from '../js/model.js';
import { conjugateGradient } from '../js/solver.js';
import { decodePng } from '../js/png-codec.js';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CASES = process.argv[2] || join(ROOT, 'samples', 'extracted');
const SHOTS = join(ROOT, '.smoke-shots');
const PORT = 8131;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 用项目自身算子独立生成灰度四相位的参考 float64 二进制（小端），供浏览器导出逐字节比对 */
async function makeGrayReference() {
  const cfg = JSON.parse(await readFile(join(CASES, 'four-phase.json'), 'utf8'));
  const dec0 = await decodePng(await readFile(join(CASES, cfg.frames[0].file)));
  const W = dec0.width, H = dec0.height, GW = 2 * W, GH = 2 * H;
  const model = buildModel(W, H, cfg.kernel, cfg.frames.map((fr) => ({ shift: fr.shift, weights: null })));
  const ys = [];
  for (const fr of cfg.frames) {
    const d = await decodePng(await readFile(join(CASES, fr.file)));
    ys.push(Float64Array.from({ length: W * H }, (_, q) => d.data[q] / 255));
  }
  const r = conjugateGradient(model, model.makeRhs(ys), 0, 1e-10, 300);
  const buf = new ArrayBuffer(GW * GH * 8);
  const dv = new DataView(buf);
  for (let n = 0; n < GW * GH; n++) dv.setFloat64(n * 8, r.x[n], true);
  const refPath = join(SHOTS, 'ref-gray-float.bin');
  await writeFile(refPath, new Uint8Array(buf));
  return refPath;
}

const server = spawn(process.execPath, [join(HERE, 'serve.mjs'), String(PORT)], { cwd: ROOT });
await new Promise((r) => server.stdout.on('data', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  check('页面加载，无控制台错误（初始）', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- 场景 A：四相位灰度 + JSON ----
  const files = [
    'four-phase.json', 'phase-0.png', 'phase-1.png', 'phase-2.png', 'phase-3.png',
  ].map((n) => join(CASES, n));
  await page.setInputFiles('#file-input', files);
  await sleep(300);
  check('JSON 导入后帧数为 4', await page.locator('#frame-count').textContent() === '4');
  check('lambda 从 JSON 同步为 0', await page.locator('#lambda').inputValue() === '0');

  await page.click('#run-btn');
  await page.waitForSelector('#results.visible', { timeout: 20000 });
  await sleep(300);
  const conv = await page.locator('#stat-conv').textContent();
  check('灰度场景完成且 CG 收敛', /converged/.test(conv), conv);
  const resTxt = await page.locator('#stat-boundary').textContent();
  check('统计块显示边界/缺测信息', /越界采样/.test(resTxt) && /零掩膜/.test(resTxt), resTxt);

  // 探查：点击残差图中心像素
  const resCanvas = page.locator('#residual-canvas');
  const box = await resCanvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await sleep(200);
  const probeText = await page.locator('#probe-detail').textContent();
  check('像素贡献面板出现且含覆盖率', /双线性覆盖率/.test(probeText) && /贡献系数之和/.test(probeText));

  // 收敛曲线 tooltip（元素相对坐标，避免全页缩放偏移）
  await page.locator('#conv-chart svg').hover({ position: { x: 360, y: 150 } });
  await page.waitForTimeout(120);
  const ttText = await page.locator('.chart-tooltip').first().textContent();
  check('悬停显示收敛 tooltip', (await page.locator('.chart-tooltip').first().evaluate((el) => !el.hidden))
    && /迭代/.test(ttText), ttText.replace(/\s+/g, ' ').trim());

  // 下载钩子：拦截三个导出
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.click('#export-png');
  await page.click('#export-float');
  await page.click('#export-params');
  await sleep(500);
  check('三个导出均触发下载', downloads.length === 3, downloads.join(', '));
  check('浮点导出文件名含 float64le', downloads.some((n) => n.includes('float64le')));
  check('PNG 导出为 .png', downloads.some((n) => n.endsWith('.png')));
  check('参数导出为 -params.json', downloads.some((n) => n.endsWith('-params.json')));

  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const refBinPath = await makeGrayReference();
  await page.screenshot({ path: join(SHOTS, 'gray-light.png'), fullPage: true });

  // 手机窄宽：无横向滚动
  await page.setViewportSize({ width: 400, height: 900 });
  await sleep(200);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  check('400px 窄宽下无横向滚动', scrollW <= 400, `scrollWidth=${scrollW}`);
  await page.screenshot({ path: join(SHOTS, 'gray-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1400 });

  // 浮点导出字节级校验：小端 float64、长度 = GW*GH*ch*8，首值与画布显示一致
  {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-float'),
    ]);
    const tmp = join(SHOTS, 'float-check.bin');
    await dl.saveAs(tmp);
    const buf = await readFile(tmp);
    const expectBytes = 32 * 24 * 1 * 8;
    check('float64 文件字节数 = GW·GH·ch·8', buf.length === expectBytes, `${buf.length} vs ${expectBytes}`);
    const dv = new DataView(buf.buffer, buf.byteOffset, 8);
    const first = dv.getFloat64(0, true);
    check('首值为有限浮点且在合理范围', Number.isFinite(first) && Math.abs(first) < 10, String(first));
    const beBytes = Buffer.from(buf.subarray(0, 8));
    const leVal = beBytes.readDoubleLE(0);
    const beVal = beBytes.readDoubleBE(0);
    check('按小端解读与 DataView 一致（非大端）', leVal === first && Math.abs(beVal - first) > 1e-12);
    // 与 Node 侧独立求解的参考二进制逐字节比对
    const ref = await readFile(refBinPath);
    check('浏览器导出与 Node 参考解逐字节一致', Buffer.compare(ref, buf) === 0,
      `${buf.length} bytes`);
  }

  // ---- 场景 B：非对称核 + 掩膜（手工配置，不用 JSON 的参数，改 λ 滑块）----
  await page.reload({ waitUntil: 'networkidle' });
  const asymFiles = [
    'asymmetric.json', 'blur-0.png', 'blur-1.png', 'blur-2.png', 'blur-3.png', 'mask.png',
  ].map((n) => join(CASES, n));
  await page.setInputFiles('#file-input', asymFiles);
  await sleep(300);
  check('非对称场景帧表含掩膜', (await page.locator('#frame-rows select').first().inputValue()) === 'mask.png');
  check('核和显示为 1', (await page.locator('#kernel-sum').textContent()).trim() === '1');
  await page.locator('#lambda').fill('0.05');
  await page.locator('#lambda').dispatchEvent('input');
  await page.click('#run-btn');
  await page.waitForSelector('#results.visible', { timeout: 30000 });
  await sleep(300);
  const boundary = await page.locator('#stat-boundary').textContent();
  check('非对称场景报告越界采样数 > 0', /越界采样 [1-9]/.test(boundary), boundary);
  const clipTxt = await page.locator('#stat-clip').textContent();
  check('截断情况块有内容', clipTxt.length > 4);
  await page.screenshot({ path: join(SHOTS, 'asym-light.png'), fullPage: true });

  // 取消：128×128 合成慢任务（上限内最大网格 + 300 次迭代），保证有可取消的运行窗口。
  // 用页面自带 codec 编码为 RGB（canvas.toBlob 产出 RGBA color type 6，不在支持范围内）。
  const dataUrls = await page.evaluate(async () => {
    const mod = await import('/js/png-codec.js');
    const W = 128, H = 128;
    async function makePng(seed) {
      const rgb = new Uint8Array(W * H * 3);
      for (let q = 0; q < W * H; q++) {
        const n = (Math.sin(q * 0.13 + seed) * 0.5 + 0.5) * 255;
        rgb[q * 3] = n;
        rgb[q * 3 + 1] = (n * 0.7) & 255;
        rgb[q * 3 + 2] = (n * 0.4) & 255;
      }
      const bytes = await mod.encodePng(W, H, rgb, 3);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return `data:image/png;base64,${btoa(bin)}`;
    }
    return Promise.all([makePng(0), makePng(2.1)]);
  });
  await page.reload({ waitUntil: 'networkidle' });
  const slowInputs = dataUrls.map((url, f) => ({
    name: `slow-${f}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(String(url).split(',')[1], 'base64'),
  }));
  await page.setInputFiles('#file-input', slowInputs);
  await sleep(300);
  check('慢任务帧数为 2', await page.locator('#frame-count').textContent() === '2');
  await page.locator('#max-iter').fill('300');
  await page.locator('#tol').fill('1e-10');
  await page.click('#run-btn');
  let cancelled = false;
  for (let i = 0; i < 400; i++) {
    if (await page.locator('#cancel-btn').isEnabled()) {
      await page.click('#cancel-btn');
      cancelled = true;
      break;
    }
    await sleep(10);
  }
  check('运行窗口内成功点下取消', cancelled);
  await sleep(150);
  const cancelTxt = await page.locator('#status-bar').textContent();
  check('取消后状态条明确提示', /已取消/.test(cancelTxt), cancelTxt);
  check('取消后运行按钮恢复', await page.locator('#run-btn').isEnabled());
  check('取消后未产出结果区',
    !(await page.locator('#results').evaluate((el) => el.classList.contains('visible'))));

  // 切深色
  await page.click('#theme-toggle');
  await sleep(200);
  check('深色主题生效', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.screenshot({ path: join(SHOTS, 'asym-dark.png'), fullPage: true });

  // 取消：用小尺寸快速任务验证按钮状态（重载后未运行时取消禁用；直接验证运行中可点）
  await page.click('#theme-toggle');
  // ---- 场景 C：RGB ----
  await page.reload({ waitUntil: 'networkidle' });
  const rgbFiles = [
    'four-phase-rgb.json', 'rgb-0.png', 'rgb-1.png', 'rgb-2.png', 'rgb-3.png',
  ].map((n) => join(CASES, n));
  await page.setInputFiles('#file-input', rgbFiles);
  await sleep(300);
  await page.click('#run-btn');
  await page.waitForSelector('#results.visible', { timeout: 20000 });
  await sleep(300);
  const rgbConv = await page.locator('#stat-conv').textContent();
  check('RGB 三通道均收敛', (rgbConv.match(/converged/g) || []).length === 3, rgbConv);
  const legendCount = await page.locator('.legend-item').count();
  check('收敛曲线含 3 项图例', legendCount === 3);
  await page.screenshot({ path: join(SHOTS, 'rgb-light.png'), fullPage: true });

  // ---- 校验拒绝逻辑：核和不为 1 ----
  await page.reload({ waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', [join(CASES, 'four-phase.json'), ...['phase-0.png', 'phase-1.png', 'phase-2.png', 'phase-3.png'].map((n) => join(CASES, n))]);
  await sleep(300);
  await page.locator('#kernel-size').selectOption('3');
  const firstKernel = page.locator('.kernel-input').first();
  await firstKernel.fill('0.9');
  await firstKernel.dispatchEvent('change');
  await page.click('#run-btn');
  await sleep(200);
  const errTxt = await page.locator('#status-bar').textContent();
  check('核和不为 1 时拒绝运行并报错', /权重之和必须恰为 1/.test(errTxt), errTxt);
  check('结果区未显示', !(await page.locator('#results').evaluate((el) => el.classList.contains('visible'))));

  check('全程无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\n浏览器冒烟全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
