'use strict';
/*
 * 验收点逐条走查（浏览器 UI）：
 *  A. 偏移 −2 / 1 的两路读数 → 深度 1 与 6，幅度 4 与 5
 *  B. 255 与两路共同深度 → 和 260；第二路改 null → 单层 1，幅度 255..1023
 *  C. 周期 3/5、上限 14 → 两组 [0,1]、[6,10]；上限 8 → 唯一；恢复 14 → 两组
 *  D. 空列表 → 无回波；一侧正读数 → 无解
 *  E. 导出 16 位 P5 的取样
 *  F. 非法记录（重复槽、第三个 null）定位并保留旧图
 */
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  try { ({ chromium } = require(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim() + '/playwright')); }
  catch (e2) { console.error('缺少 Playwright'); process.exit(2); }
}

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const TMP = path.join(require('node:os').tmpdir(), 'echo-depth-acceptance');
fs.mkdirSync(TMP, { recursive: true });

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

function doc(periods, offsets, maxDepth, pixels, width, height) {
  return { width: width || 1, height: height || 1, periods, offsets, maxDepth, pixels };
}
function writeDoc(name, d) {
  const p = path.join(TMP, name + '.json');
  fs.writeFileSync(p, JSON.stringify(d));
  return p;
}
function parsePGM(buf) {
  let p = 0;
  const tok = () => {
    while (p < buf.length && /\s/.test(String.fromCharCode(buf[p]))) p++;
    let s = '';
    while (p < buf.length && !/\s/.test(String.fromCharCode(buf[p]))) { s += String.fromCharCode(buf[p]); p++; }
    return s;
  };
  const magic = tok(), w = +tok(), h = +tok(), max = +tok();
  p++;
  const bytes = max > 255 ? 2 : 1;
  const samples = [];
  for (let i = 0; i < w * h; i++) {
    samples.push(bytes === 2 ? (buf[p + i * 2] << 8) | buf[p + i * 2 + 1] : buf[p + i]);
  }
  return { magic, w, h, max, samples };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => /耗时/.test(document.getElementById('timing').textContent), { timeout: 15000 });

  async function load(d, name) {
    await page.setInputFiles('#fileInput', writeDoc(name, d));
    await page.waitForFunction(() => /耗时/.test(document.getElementById('timing').textContent), { timeout: 15000 });
    await page.waitForTimeout(120);
  }
  async function selectPx(x, y) {
    const box = await page.locator('#map').boundingBox();
    const st = await page.locator('#mapZoom').textContent();
    const scale = Number((st.match(/=\s*(\d+)\s*px/) || [])[1] || 1);
    await page.mouse.click(box.x + (x + 0.5) * scale, box.y + (y + 0.5) * scale);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
  }
  const inspText = () => page.locator('#inspContent').innerText();

  /* A. 偏移 −2 / 1 */
  await load(doc([5, 7], [-2, 1], 34, [[[[4, 9]], [[2, 4], [0, 5]]]]), 'a');
  await selectPx(0, 0);
  let t = await inspText();
  ok('A 最少 2 个回波', /最少需要 2 个回波/.test(t), t.slice(0, 160));
  ok('A 唯一深度组', /1 组/.test(t));
  ok('A 深度 1 与 6', /第 1 层[\s\S]{0,80}?\b1\b/.test(t) && /\b6\b/.test(t));
  ok('A 幅度 4 与 5', /第 1 层[\s\S]{0,40}?4/.test(t) && /\b5\b/.test(t), t.slice(0, 400));
  ok('A 偏移取模显示', /mod 5 = 3/.test(t) || /偏移 -2/.test(t), t.slice(0, 120));

  /* B1. 255 + 两路共同深度，和 260 */
  await load(doc([5, 7], [0, 0], 34, [[[[1, 255]], [[1, 120], [6, 140]]]]), 'b1');
  await selectPx(0, 0);
  t = await inspText();
  ok('B1 深度 1 与 6', /深度上下界[\s\S]{0,60}/.test(t) && /\b1\b/.test(t) && /\b6\b/.test(t), t.slice(0, 300));
  ok('B1 幅度 120 与 140', /\b120\b/.test(t) && /\b140\b/.test(t), t.slice(0, 300));
  ok('B1 导出提示 2 / 7', /本像素导出：层 1 = 2，层 2 = 7/.test(t), t.slice(-160));

  /* B2. 第二路改 null → 单层 1，幅度 255..1023 */
  await load(doc([5, 7], [0, 0], 34, [[[[1, 255]], [[1, null]]]]), 'b2');
  await selectPx(0, 0);
  t = await inspText();
  ok('B2 单层唯一', /最少需要 1 个回波/.test(t), t.slice(0, 160));
  ok('B2 幅度范围 255 – 1023', /255 – 1023/.test(t), t.slice(0, 400));

  /* C. 周期 3/5、上限 14 */
  await load(doc([3, 5], [0, 0], 14, [[[[0, 1], [1, 1]], [[0, 1], [1, 1]]]]), 'c');
  await selectPx(0, 0);
  t = await inspText();
  ok('C 两组深度', /共 2 组/.test(t), t.slice(0, 200));
  ok('C 层 1 范围 0 – 6', /0 – 6/.test(t), t.slice(0, 500));
  ok('C 层 2 范围 1 – 10', /1 – 10/.test(t), t.slice(0, 500));
  // 降上限到 8
  await page.locator('#maxDepth').fill('8');
  await page.locator('#maxDepth').press('Enter');
  await page.waitForTimeout(400);
  t = await inspText();
  ok('C 上限 8 → 唯一 [0,1]', /1 组/.test(t) && /最少需要 2 个回波/.test(t), t.slice(0, 200));
  ok('C 上限 8 导出 1 / 2', /层 1 = 1，层 2 = 2/.test(t), t.slice(-140));
  // 恢复 14
  await page.locator('#maxDepth').fill('14');
  await page.locator('#maxDepth').press('Enter');
  await page.waitForTimeout(400);
  t = await inspText();
  ok('C 恢复 14 → 两组', /共 2 组/.test(t), t.slice(0, 200));
  ok('C 点读仍是原始槽读数', /槽[\s\S]*?0[\s\S]*?精确 1/.test(t), t.slice(0, 500));

  /* D. 空列表 / 一侧正读数 */
  await load(doc([5, 7], [0, 0], 34, [[[], []]]), 'd1');
  await selectPx(0, 0);
  ok('D 空 → 无回波', /无回波/.test(await page.locator('#pixStatusText').textContent()));
  await load(doc([5, 7], [0, 0], 34, [[[[1, 3]], []]]), 'd2');
  await selectPx(0, 0);
  ok('D 一侧正读数 → 无解', /无解/.test(await page.locator('#pixStatusText').textContent()));

  /* E. 导出取样：单层唯一、双层唯一、多组深度同图 */
  await load(doc([5, 7], [0, 0], 34, [
    [[[0, 255]], [[0, null]]],            // 单层唯一，深度 0，幅度 255..1023 → 层1 = 1
    [[[1, 9]], [[1, 4], [6, 5]]],          // 双层唯一，深度 1、6 → (2, 7)
    [[[0, 1], [1, 1]], [[0, 1], [1, 1]]],  // 多组 → (0, 0)
  ], 3, 1), 'e');
  const dlP = page.waitForEvent('download');
  await page.locator('#exportL0').click();
  const dl = await dlP;
  const f1 = path.join(TMP, 'l1.pgm');
  await dl.saveAs(f1);
  const pgm1 = parsePGM(fs.readFileSync(f1));
  ok('E 头为 3×1 65535', pgm1.magic === 'P5' && pgm1.w === 3 && pgm1.h === 1 && pgm1.max === 65535);
  ok('E 单层写 1', pgm1.samples[0] === 1, String(pgm1.samples[0]));
  ok('E 双层写第一层深度+1', pgm1.samples[1] === 2, String(pgm1.samples[1]));
  ok('E 多组写 0', pgm1.samples[2] === 0, String(pgm1.samples[2]));

  const dlP2 = page.waitForEvent('download');
  await page.locator('#exportL1').click();
  const dl2 = await dlP2;
  const f2 = path.join(TMP, 'l2.pgm');
  await dl2.saveAs(f2);
  const pgm2 = parsePGM(fs.readFileSync(f2));
  ok('E 缺失层写 0', pgm2.samples[0] === 0, String(pgm2.samples[0]));
  ok('E 双层写第二层深度+1', pgm2.samples[1] === 7, String(pgm2.samples[1]));
  ok('E 多组第二层写 0', pgm2.samples[2] === 0, String(pgm2.samples[2]));

  /* F. 非法记录：重复槽 */
  await page.locator('#loadSample').click();
  await page.waitForFunction(() => /12 × 10/.test(document.getElementById('recordPill').textContent) &&
    /耗时/.test(document.getElementById('timing').textContent), { timeout: 15000 });
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'echo-depth.json'), 'utf8'));
  const dup = JSON.parse(JSON.stringify(good));
  const last = dup.pixels.length - 1;
  dup.pixels[last][0] = [[1, 5], [1, 6]];
  await page.setInputFiles('#fileInput', writeDoc('dup', dup));
  await page.waitForTimeout(300);
  ok('F 重复槽显示错误', await page.locator('#errorCard').isVisible());
  let errText = await page.locator('#errorList').innerText();
  ok('F 指出像素 (11, 9)', /\(11, 9\)/.test(errText), errText);
  ok('F 指出槽 1', /槽 1/.test(errText), errText);
  ok('F 旧图保留 12 × 10', /12 × 10/.test(await page.locator('#recordPill').textContent()));

  /* F2. 第三个 null */
  const three = JSON.parse(JSON.stringify(good));
  three.pixels[0][1] = [[1, null], [2, null], [3, null]];
  await page.setInputFiles('#fileInput', writeDoc('three', three));
  await page.waitForTimeout(300);
  errText = await page.locator('#errorList').innerText();
  ok('F 第三个 null 指出像素 (0, 0)', /\(0, 0\)/.test(errText), errText);
  ok('F 第三个 null 指出槽 3', /槽 3/.test(errText), errText);
  ok('F 旧图仍在', /12 × 10/.test(await page.locator('#recordPill').textContent()));

  /* G. 满额图 12 秒（周期 31/37、上限 1146、256×256） */
  await page.locator('#loadBig').click();
  const t0 = Date.now();
  await page.waitForFunction(() => /256 × 256/.test(document.getElementById('recordPill').textContent) &&
    /耗时/.test(document.getElementById('timing').textContent), { timeout: 20000 });
  const bigMs = Date.now() - t0;
  ok('G 满额图 12 秒内出结果', bigMs < 12000, bigMs + ' ms');
  const timing = await page.locator('#timing').textContent();
  ok('G 计时显示 < 12 s', /耗时/.test(timing), timing);

  /* H. 满额图上抽样几个像素，核对两路槽读数与首组深度自洽 */
  const rep = [];
  for (let k = 0; k < 6; k++) {
    const x = (k * 41 + 7) % 256, y = (k * 67 + 13) % 256;
    await selectPx(x, y);
    const txt = await inspText();
    const status = await page.locator('#pixStatusText').textContent();
    rep.push({ x, y, status, hasLanes: /第 1 路/.test(txt) && /第 2 路/.test(txt) });
  }
  ok('H 抽样像素都显示两路槽', rep.every(r => r.hasLanes), JSON.stringify(rep));

  ok('全程无脚本错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  if (failures) { console.log('\n' + failures + ' 项失败'); process.exit(1); }
  console.log('\n验收走查全部通过');
})().catch(e => { console.error(e); process.exit(1); });
