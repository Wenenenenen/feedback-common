/*
 * 真实浏览器端到端测试（Playwright + Chromium）。
 * 覆盖：
 *  - 内置演示数据载入、时间轴/容差联动、端点原帧、分类统计
 *  - 点击像素的检查器（zmin、供色来源、往返状态）
 *  - 分类叠加开关
 *  - 文件载入失败（截断、尺寸错配）时指出文件名并保留上一次画面
 *  - 导出 ZIP 下载，解压后与页面当前帧逐字节一致
 * 运行：node tools/test_e2e.mjs
 */
import { chromium } from './playwright.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = 'file://' + join(root, 'index.html');
const sample = join(root, 'samples', 'extracted');
const tmp = mkdtempSync(join(tmpdir(), 'flow-e2e-'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(pageUrl);

// 1. 载入演示数据
await page.click('#demoBtn');
await page.waitForSelector('#statusBar.status.ok');
const info = await page.textContent('#datasetInfo');
assert.ok(info.includes('64×36'), info);
console.log('  演示数据载入：', info);

// 2. 默认 n=32 渲染信息与分类统计
const renderInfo = await page.textContent('#renderInfo');
assert.ok(renderInfo.includes('n=32'), renderInfo);
const chips = await page.$$eval('#classStats .chip', (ns) => ns.map((n) => n.textContent.trim()));
assert.ok(chips.length === 5, '应有 5 个分类 chip');
assert.ok(chips.some((c) => c.includes('往返通过供色')), chips.join('|'));
console.log('  分类统计：', chips.map((c) => c.replace(/\s+/g, ' ')).join(' | '));

// 3. 端点 n=0 必须等于 a 原帧
await page.fill('#stepSlider', '0');
await page.dispatchEvent('#stepSlider', 'input');
await page.waitForFunction(() => document.getElementById('renderInfo').textContent.includes('n=0'));
const endpointInfo = await page.textContent('#renderInfo');
assert.ok(endpointInfo.includes('端点'), endpointInfo);

// 4. 切回中间档，调容差，检查渲染耗时显示
await page.fill('#stepSlider', '32');
await page.dispatchEvent('#stepSlider', 'input');
await page.fill('#tolNum', '100');
await page.dispatchEvent('#tolNum', 'change');
await page.waitForFunction(() => document.getElementById('tolValue').textContent === '100');
const tolInfo = await page.textContent('#renderInfo');
assert.ok(tolInfo.includes('容差 ±100'), tolInfo);
assert.ok(/渲染 [\d.]+ ms/.test(tolInfo), tolInfo);
console.log('  容差联动：', tolInfo);

// 5. 点击像素，检查器出现 zmin 与供色表
await page.check('#overlayChk');
const box = await page.locator('#view').boundingBox();
// 画面 64×36，点前景区域附近 (20, 8)
const px = box.x + (20.5 / 64) * box.width;
const py = box.y + (8.5 / 36) * box.height;
await page.mouse.click(px, py);
await page.waitForSelector('#inspector table.contrib');
const inspText = await page.textContent('#inspector');
assert.ok(inspText.includes('zmin='), inspText);
assert.ok(inspText.includes('源坐标'), inspText);
const contribRows = await page.$$eval('#inspector table.contrib tbody tr', (rs) => rs.length);
assert.ok(contribRows > 0, '应至少有一条供色贡献');
console.log(`  像素检查器：${contribRows} 条贡献，含 zmin 与来源明细`);

// 5b. 拖动时间轴后，检查器应自动刷新到新档位（时间权重随 t 变化）
const weightAt32 = await page.textContent('#inspector table.contrib tbody tr:first-child td:nth-child(4)');
await page.fill('#stepSlider', '16');
await page.dispatchEvent('#stepSlider', 'input');
await page.waitForFunction(() => document.getElementById('renderInfo').textContent.includes('n=16'));
const headAfter = await page.textContent('#inspector .insp-head');
assert.ok(headAfter.includes('x=20') && headAfter.includes('y=8'), '检查器应停留在同一像素');
const weightAt16 = await page.textContent('#inspector table.contrib tbody tr:first-child td:nth-child(4)');
assert.notEqual(weightAt16, weightAt32, `时间权重应随档位变化：${weightAt32} -> ${weightAt16}`);
console.log(`  检查器自动刷新：同像素权重随档位变化 ${weightAt32.trim()} -> ${weightAt16.trim()}`);
// 回到 32 继续后续步骤
await page.fill('#stepSlider', '32');
await page.dispatchEvent('#stepSlider', 'input');
await page.fill('#tolNum', '100');
await page.dispatchEvent('#tolNum', 'change');

// 6. 记录当前画布像素，制造一次失败载入，确认画面保留
const beforeFail = await page.evaluate(() => {
  const c = document.getElementById('view');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 12);
});
const writeCase = (dir, mutator) => {
  mkdirSync(dir, { recursive: true });
  const paths = {
    aPPM: join(dir, 'a.ppm'),
    bPPM: join(dir, 'b.ppm'),
    aBIN: join(dir, 'a.bin'),
    bBIN: join(dir, 'b.bin'),
  };
  writeFileSync(paths.aPPM, readFileSync(join(sample, 'a.ppm')));
  writeFileSync(paths.bPPM, readFileSync(join(sample, 'b.ppm')));
  writeFileSync(paths.aBIN, readFileSync(join(sample, 'a.bin')));
  writeFileSync(paths.bBIN, readFileSync(join(sample, 'b.bin')));
  if (mutator) mutator(paths);
  return [paths.aPPM, paths.bPPM, paths.aBIN, paths.bBIN];
};
const pickCase = async (dir, mutator) => {
  await page.setInputFiles('#fileInput', []); // 清空，避免浏览器复用旧文件句柄
  const list = writeCase(dir, mutator);
  await page.setInputFiles('#fileInput', list);
};

// 6a. 截断 a.ppm
const dirTrunc = join(tmp, 'trunc');
const trunc = readFileSync(join(sample, 'a.ppm'));
await pickCase(dirTrunc, (paths) => {
  writeFileSync(paths.aPPM, trunc.subarray(0, trunc.length - 50));
});
await page.waitForSelector('#statusBar.status.error');
const errText = await page.textContent('#statusBar');
assert.ok(errText.includes('a.ppm'), `错误应指出文件名：${errText}`);
assert.ok(errText.includes('保留上一次画面'), errText);
const afterFail = await page.evaluate(() => {
  const c = document.getElementById('view');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 12);
});
assert.deepEqual(Array.from(afterFail), Array.from(beforeFail), '失败后画面必须保留');
console.log('  截断文件：错误指出 a.ppm 且画面逐像素保留');

// 6b. 尺寸错配（独立目录，b.ppm 换成 4×4），同样必须报错并保留画面
const dirSize = join(tmp, 'size');
const tiny = Buffer.concat([
  Buffer.from('P6\n4 4\n255\n'),
  Buffer.alloc(4 * 4 * 3, 7),
]);
await pickCase(dirSize, (paths) => {
  writeFileSync(paths.bPPM, new Uint8Array(tiny));
});
await page.waitForFunction(
  () => document.getElementById('statusBar').className.includes('error')
    && document.getElementById('statusBar').textContent.includes('尺寸'),
  { timeout: 5000 },
);
const errText2 = await page.textContent('#statusBar');
assert.ok(errText2.includes('尺寸'), errText2);
const afterFail2 = await page.evaluate(() => {
  const c = document.getElementById('view');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 12);
});
assert.deepEqual(Array.from(afterFail2), Array.from(beforeFail), '尺寸错配后画面仍须保留');
console.log('  尺寸错配：错误指出尺寸问题且画面保留');

// 6c. 恢复正确文件，确认能重新载入并覆盖现场
const dirGood = join(tmp, 'good');
await pickCase(dirGood, null);
await page.waitForFunction(() => document.getElementById('statusBar').className.includes('ok'));
console.log('  错误恢复：修正文件后可正常重新载入');

// 8. 选当前档并导出 ZIP，下载后校验与预览一致
await page.click('#selCurrent');
await page.selectOption?.('#stepSlider', '32').catch(() => {});
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#exportBtn'),
]);
const zipPath = join(tmp, 'downloaded.zip');
await download.saveAs(zipPath);
const unzipDir = join(tmp, 'unzipped');
execFileSync('unzip', ['-q', zipPath, '-d', unzipDir]);
const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
assert.ok(listing.includes('frame_32.ppm') && listing.includes('class_32.p5'), listing);

// 用 Node 引擎独立复算 n=32 tol=100，逐字节比对导出内容
const E = await import(join(root, 'app', 'engine.js'));
const refPpm = readFileSync(join(unzipDir, 'frame_32.ppm'));
const refP5 = readFileSync(join(unzipDir, 'class_32.p5'));
assert.ok(refPpm.toString('latin1').startsWith('P6\n64 36\n255\n'));
assert.ok(refP5.toString('latin1').startsWith('P5\n64 36\n255\n'));
const load = (p) => new Uint8Array(readFileSync(p));
const ds = E.loadDataset({
  aPPM: { name: 'a.ppm', bytes: load(join(sample, 'a.ppm')) },
  bPPM: { name: 'b.ppm', bytes: load(join(sample, 'b.ppm')) },
  aBIN: { name: 'a.bin', bytes: load(join(sample, 'a.bin')) },
  bBIN: { name: 'b.bin', bytes: load(join(sample, 'b.bin')) },
});
const passes = {
  passA: E.computeRoundTrip(ds.flowA, ds.flowB, 64, 36),
  passB: E.computeRoundTrip(ds.flowB, ds.flowA, 64, 36),
};
const r = E.renderFrame(ds, 32, 100, passes);
const expectPpm = E.encodePPM(r.rgb, 64, 36);
const expectP5 = E.encodeP5(r.cls, 64, 36);
assert.deepEqual(new Uint8Array(refPpm), expectPpm, '导出 PPM 必须与引擎/预览一致');
assert.deepEqual(new Uint8Array(refP5), expectP5, '导出 P5 必须与引擎/预览一致');
console.log('  导出 ZIP：frame_32.ppm / class_32.p5 与引擎输出逐字节一致');

// 9. 全空场景下分类 4 与全黑像素（在浏览器内构造数据集）
const allEmptyOk = await page.evaluate(() => {
  const Eng = globalThis.FlowEngine;
  const W = 8, H = 8, N = W * H;
  const zero = new Uint8Array(N * 6); // dx/dy/z 全 0 => z 全 0
  const rgb = new Uint8Array(N * 3).fill(200);
  const dsx = Eng.loadDataset({
    aPPM: { name: 'a.ppm', bytes: Eng.encodePPM(rgb, W, H) },
    bPPM: { name: 'b.ppm', bytes: Eng.encodePPM(rgb, W, H) },
    aBIN: { name: 'a.bin', bytes: zero },
    bBIN: { name: 'b.bin', bytes: zero },
  });
  const ps = {
    passA: Eng.computeRoundTrip(dsx.flowA, dsx.flowB, W, H),
    passB: Eng.computeRoundTrip(dsx.flowB, dsx.flowA, W, H),
  };
  const rr = Eng.renderFrame(dsx, 10, 0, ps);
  return rr.cls.every((c) => c === 4) && rr.rgb.every((v) => v === 0);
});
assert.ok(allEmptyOk, '全空必须分类 4 且填黑');
console.log('  全空场景：分类 4、像素填黑');

assert.equal(errors.length, 0, `浏览器控制台报错：\n${errors.join('\n')}`);
await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log('\n端到端测试全部通过');
