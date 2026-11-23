/*
 * 浏览器端到端测试（全局 Playwright，无需本地依赖）：
 *   1) file:// 与 http:// 两种入口都能出可点画面（Blob Worker 兼容性）
 *   2) 100 万条交错样本：导入→可点画面 ≤ 10s
 *   3) 画布像素与引擎 Float64 结果一致（显示变换方向正确）
 *   4) 点击检查：段入射/出射透射率、预乘贡献与手工真值一致
 *   5) 导出 RGBA64 二进制：魔数/尺寸/Float64 值 ≤ 1e-12
 *   6) 导出 JSON：线性预乘、空像素全零
 *   7) 错误输入：错误带记录位置，且保留上一份可检查/导出结果
 *   8) 取消导入：保留上一份结果
 * 用法：node tests/e2e.mjs [base-url]
 */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { makeDir, writeStress1M, writeInvalid, writeTieCase } from './fixtures.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../web/engine.js');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const webIndex = join(root, 'web', 'index.html');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.stack || e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const approx = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;

const baseUrlArg = process.argv[2] || null;
const dir = makeDir();
const stress = writeStress1M(dir);
const invalid = writeInvalid(dir);
const tie = writeTieCase(dir);
console.log(`夹具目录：${dir}`);
console.log(`1M 夹具：${stress.layerCount.toLocaleString()} 层 / ${(stress.bytes / 1e6).toFixed(1)} MB`);

let server = null;
function startServer() {
  return new Promise((res2, rej) => {
    const s = spawn('python3', ['-I', join(root, 'src/server.py'), '--port', '8123'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    s.stdout.on('data', (d) => { if (String(d).includes('http://')) res2(s); });
    s.on('exit', (code) => rej(new Error('server exited ' + code)));
  });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return ctx;
}

async function setFileInput(page, path) {
  await page.setInputFiles('#file-input', path);
}

// 等待当前帧稳定（无进度条、可导出），并确认层数统计已切到期望帧
async function waitIdle(page, expectedLayers = null, timeout = 20000) {
  await page.waitForFunction((exp) => {
    const ready = document.getElementById('export-rgba64').disabled === false
      && !document.getElementById('progress').classList.contains('show');
    if (!ready) return false;
    if (exp === null) return true;
    return document.getElementById('stat-layers').textContent.trim() === exp;
  }, expectedLayers === null ? null : expectedLayers.toLocaleString('en-US'), { timeout });
}

async function waitError(page, timeout = 10000) {
  await page.waitForSelector('#err.show', { timeout });
}

// 等错误框出现且包含期望片段（避免读到上一轮残留文本或空文本）
async function waitErrorText(page, re, timeout = 10000) {
  await page.waitForFunction((pat) => {
    const el = document.getElementById('err');
    return el.classList.contains('show') && el.textContent.length > 0
      && new RegExp(pat).test(el.textContent);
  }, re.source, { timeout });
}

async function readCanvasPixel(page, x, y) {
  return page.evaluate(([x, y]) => {
    const c = document.getElementById('view');
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  }, [x, y]);
}

for (const entry of baseUrlArg ? [{ name: 'http', url: baseUrlArg }]
  : [{ name: 'file', url: pathToFileURL(webIndex).href },
     { name: 'http', url: 'http://127.0.0.1:8123/' }]) {
  if (entry.name === 'http' && !server) server = await startServer();
  console.log(`\n== 入口：${entry.name} (${entry.url}) ==`);
  const ctx = await newPage();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(entry.url);

  await check(`[${entry.name}] 首屏自动载入内置样例并可导出`, async () => {
    await waitIdle(page, 2);
    const disabled = await page.$('#export-rgba64:disabled');
    assert(!disabled, '导出按钮仍禁用');
    assert(errors.length === 0, '页面报错: ' + errors.join('; '));
  });

  await check(`[${entry.name}] 同深度次序/相交体积手工真值`, async () => {
    await setFileInput(page, tie.path);
    await waitIdle(page, 5);
    const stats = await page.textContent('#stat-layers');
    assert(stats.trim() === '5', '层数统计错误: ' + stats);
    // 点击唯一像素
    await page.click('#view');
    const text = await page.textContent('#inspect');
    assert(text.includes('体积积分段'), '缺少积分段表');
    // 事件次序标签
    const order = await page.$$eval('#inspect table:last-of-type tbody tr', rows =>
      rows.map(r => Array.from(r.querySelectorAll('td')).slice(0, 3).map(td => td.textContent.trim()).join(':')));
    const joined = order.join(' | ');
    assert(joined.includes('2:表面:2') && joined.indexOf('表面:2') < joined.indexOf('表面:7'),
      '表面未按 id 排列: ' + joined);
    assert(joined.indexOf('4:体积结束:1') < joined.indexOf('4:遮挡:9')
      && joined.indexOf('4:遮挡:9') < joined.indexOf('4:体积开始:4'),
      '同深度次序错误: ' + joined);
    // 数值：直接取页面帧缓冲与手工期望逐分量比对
    const frame = await page.evaluate(() => window.__DIC_TEST__.frame());
    const exp = tie.expected;
    const got = { r: frame.rgba[0], g: frame.rgba[1], b: frame.rgba[2], A: frame.rgba[3], T: frame.T[0] };
    for (const k of ['r', 'g', 'b', 'A', 'T']) {
      assert(approx(got[k], exp[k], 1e-12), `${k}: 页面 ${got[k]} vs 期望 ${exp[k]}`);
    }
  });

  await check(`[${entry.name}] 100 万交错样本 10 秒内出可点画面`, async () => {
    const t0 = Date.now();
    await setFileInput(page, stress.path);
    await waitIdle(page, stress.layerCount, 30000);
    const dt = Date.now() - t0;
    console.log(`      导入→可点耗时 ${dt} ms（${stress.layerCount.toLocaleString('en-US')} 层）`);
    assert(dt <= 10000, `耗时 ${dt}ms 超过 10s`);
    const layerStat = await page.textContent('#stat-layers');
    assert(layerStat.trim() === stress.layerCount.toLocaleString('en-US'),
      '层数统计异常: ' + layerStat);
    assert(stress.layerCount >= 1_000_000, `夹具未达 100 万层：${stress.layerCount}`);
    const sizeStat = await page.textContent('#stat-size');
    assert(sizeStat.includes('512×512'), '尺寸统计异常: ' + sizeStat);
    // 可点击：点击中心像素后检查面板出现
    await page.click('#view', { position: { x: 200, y: 200 } });
    await page.waitForFunction(() => document.getElementById('inspect').textContent.includes('像素 ('));
  });

  await check(`[${entry.name}] 画布显示与 Float64 引擎方向一致`, async () => {
    // 重新导入小场景，逐像素核对 sRGB 变换后的 8-bit 画布
    await setFileInput(page, tie.path);
    await waitIdle(page, 5);
    const scene = JSON.parse(readFileSync(tie.path, 'utf8'));
    const pack = E.parseAndPack(scene);
    const frame = E.compositeFrame(pack);
    const got = await readCanvasPixel(page, 0, 0);
    const lin2srgb = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    const a = frame.rgba[3];
    for (let c = 0; c < 3; c++) {
      const expect = Math.round(lin2srgb(frame.rgba[c] / a) * 255);
      assert(Math.abs(got[c] - expect) <= 1, `通道${c}: 画布${got[c]} vs 期望${expect}`);
    }
    assert(got[3] === Math.round(a * 255), 'alpha 通道不符');
  });

  await check(`[${entry.name}] 导出 RGBA64 与引擎 Float64 一致`, async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-rgba64'),
    ]);
    const outPath = join(dir, `out-${entry.name}.rgba64`);
    await download.saveAs(outPath);
    const buf = readFileSync(outPath);
    assert(buf.slice(0, 4).toString('ascii') === 'DIC1', '魔数错误');
    const W = buf.readUInt32LE(4), H = buf.readUInt32LE(8);
    assert(W === 1 && H === 1, '尺寸头错误');
    const dv = new DataView(buf.buffer, buf.byteOffset + 12);
    const scene = JSON.parse(readFileSync(tie.path, 'utf8'));
    const frame = E.compositeFrame(E.parseAndPack(scene));
    for (let i = 0; i < 4; i++) {
      assert(approx(dv.getFloat64(i * 8, true), frame.rgba[i], 1e-12),
        `RGBA[${i}] ${dv.getFloat64(i * 8, true)} vs ${frame.rgba[i]}`);
    }
  });

  await check(`[${entry.name}] 导出 JSON 线性预乘且空像素全零`, async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-json'),
    ]);
    const outPath = join(dir, `out-${entry.name}.json`);
    await download.saveAs(outPath);
    const doc = JSON.parse(readFileSync(outPath, 'utf8'));
    assert(doc.format === 'linear-premultiplied-rgba-float64', '格式标记错误');
    assert(Array.isArray(doc.emptyPixel) && doc.emptyPixel.every(v => v === 0), '空像素声明错误');
    const cell = doc.pixels.find(p => p.x === 0 && p.y === 0);
    const scene = JSON.parse(readFileSync(tie.path, 'utf8'));
    const frame = E.compositeFrame(E.parseAndPack(scene));
    for (let i = 0; i < 4; i++) assert(approx(cell.rgba[i], frame.rgba[i]), `JSON rgba[${i}] 不符`);
  });

  await check(`[${entry.name}] 错误输入带位置且保留上一份结果`, async () => {
    // 当前结果是 tie 场景；依次导入坏文件，每次错误后确认旧帧完好
    for (const [name, path] of Object.entries(invalid)) {
      await setFileInput(page, path);
      // 轮询直到错误框同时包含保帧提示与位置信息（Worker 回包异步，避免读到空文本）
      await page.waitForFunction(() => {
        const el = document.getElementById('err');
        const t = el.textContent;
        return el.classList.contains('show') && t.includes('保留上一份结果')
          && /位置|\$|pixels|layers|\.id|\.x|行第/.test(t);
      }, null, { timeout: 10000 });
      const errText = await page.textContent('#err');
      assert(await page.$('#export-rgba64:disabled') === null,
        '保帧期间导出被禁用: ' + name);
      await page.click('#view');
      const insp = await page.textContent('#inspect');
      assert(insp.includes('像素 (0, 0)'), '保帧期间检查面板失效: ' + name);
    }
  });

  await check(`[${entry.name}] 取消导入保留上一份结果`, async () => {
    // 先确保有一份有效结果（tie：1x1 / 5 层）
    await setFileInput(page, tie.path);
    await waitIdle(page, 5);
    // 注入读取延迟，保证取消发生在 Worker 启动前，结果确定
    await page.evaluate(() => window.__DIC_TEST__.setReadDelay(1500));
    await page.setInputFiles('#file-input', stress.path);
    await page.click('#cancel');
    await waitErrorText(page, /取消/);
    const errText = await page.textContent('#err');
    assert(errText.includes('取消'), '缺少取消提示');
    const sizeStat = await page.textContent('#stat-size');
    assert(sizeStat.includes('1×1'), '取消后未保留上一份画面: ' + sizeStat);
    assert(await page.$('#export-rgba64:disabled') === null, '取消后导出被禁用');
    // 延迟到期后旧代次不得覆盖当前帧
    await page.waitForTimeout(1800);
    const sizeStat2 = await page.textContent('#stat-size');
    assert(sizeStat2.includes('1×1'), '迟到回包覆盖了保留帧: ' + sizeStat2);
    await page.evaluate(() => window.__DIC_TEST__.setReadDelay(0));
  });

  await ctx.close();
}

// 额外：1M 场景与 Python 参考实现抽像素交叉核对（取若干随机像素）
console.log('\n== 1M 夹具 Python 参考实现交叉核对（抽样像素） ==');
{
  const { execFileSync } = await import('node:child_process');
  const pyOut = join(dir, 'stress-py.json');
  execFileSync('python3', ['-I', join(root, 'tools/reference.py'), 'render', stress.path, '-o', pyOut],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const py = JSON.parse(readFileSync(pyOut, 'utf8'));
  const scene = JSON.parse(readFileSync(stress.path, 'utf8'));
  const pack = E.parseAndPack(scene);
  const js = E.compositeFrame(pack);
  const rng = (seed) => () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = rng(42);
  let worst = 0;
  const pyMap = new Map(py.pixels.map(c => [c.y * py.width + c.x, c]));
  for (let i = 0; i < 200; i++) {
    const p = Math.floor(rnd() * 512 * 512);
    const cell = pyMap.get(p);
    const o = p * 4;
    if (!cell) {
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(js.rgba[o + c]));
      continue;
    }
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(js.rgba[o + c] - cell[['r', 'g', 'b', 'A'][c]]));
  }
  await check('200 个随机像素 JS/Python 偏差 ≤ 1e-12', async () =>
    assert(worst <= 1e-12, 'worst=' + worst));
  console.log(`      抽样最大偏差 ${worst.toExponential(3)}`);
}

if (server) server.kill();
await browser.close();
console.log(failures === 0 ? '\nE2E 全部通过。' : `\n${failures} 项 E2E 失败。`);
process.exit(failures === 0 ? 0 : 1);
