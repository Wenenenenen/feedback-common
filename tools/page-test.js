'use strict';
/* Playwright 页面回归：file:// 直接打开，检查首屏、交互、导出与 12 秒性能。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  try {
    ({ chromium } = require(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim() + '/playwright'));
  } catch (e2) {
    console.error('缺少 Playwright，跳过页面自检。先安装：npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'test-output');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

function parsePGM(buf) {
  // 读取 P5 头，返回 { width, height, maxval, samples }
  let p = 0;
  function token() {
    while (p < buf.length && /\s/.test(String.fromCharCode(buf[p]))) p++;
    if (buf[p] === 35) { while (buf[p] !== 10) p++; return token(); }
    let s = '';
    while (p < buf.length && !/\s/.test(String.fromCharCode(buf[p]))) { s += String.fromCharCode(buf[p]); p++; }
    return s;
  }
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const maxval = Number(token());
  p++;
  const bytes = maxval > 255 ? 2 : 1;
  const samples = new Array(width * height);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = bytes === 2 ? (buf[p + i * 2] << 8) | buf[p + i * 2 + 1] : buf[p + i];
  }
  return { magic, width, height, maxval, samples };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const n = document.getElementById('timing');
    return n && /耗时/.test(n.textContent);
  }, { timeout: 15000 });
  await page.waitForTimeout(200);

  /* 1. 首屏 */
  ok('加载无控制台错误', errors.length === 0, errors.join('\n       '));
  ok('记录胶囊显示样例尺寸', /12 × 10/.test(await page.locator('#recordPill').textContent()));
  const counts = await page.locator('#counts li').allTextContents();
  ok('状态分布列出 5 类 + 合计', counts.length === 6, counts.join(' | '));
  const emptyLabel = await page.locator('#counts li').nth(4).getAttribute('aria-label');
  ok('样例含 10 个无回波', /无回波 10 像素/.test(emptyLabel || ''), String(emptyLabel));

  /* 2. 点像素看详情 */
  const canvas = page.locator('#map');
  const box = await canvas.boundingBox();
  const scaleTxt = await page.locator('#mapZoom').textContent();
  const scale = Number((scaleTxt.match(/=\s*(\d+)\s*px/) || [])[1] || 1);
  // 点 (5,3)：两层深度 4 与 9
  await page.mouse.click(box.x + (5 + 0.5) * scale, box.y + (3 + 0.5) * scale);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  ok('点击像素后坐标更新', /\(5, 3\)/.test(await page.locator('#pixCoord').textContent()),
    await page.locator('#pixCoord').textContent());
  const insp = await page.locator('#inspContent').innerText();
  ok('详情显示两路槽读数', /第 1 路/.test(insp) && /第 2 路/.test(insp));
  ok('详情显示两层深度 4 / 9', /第 1 层/.test(insp) && /第 2 层/.test(insp) && /\b4\b/.test(insp) && /\b9\b/.test(insp), insp.slice(0, 300));

  /* 3. 空像素 */
  await page.mouse.click(box.x + 0.5 * scale, box.y + 0.5 * scale);
  await page.waitForTimeout(200);
  ok('空像素显示无回波', /无回波/.test(await page.locator('#pixStatusText').textContent()));

  /* 4. 状态图图例 */
  const legend = await page.locator('#legend').innerText();
  ok('图例含五类状态', ['无回波', '唯一单层', '唯一双层', '多组深度', '无解'].every(t => legend.includes(t)), legend);

  /* 5. 层视图 */
  await page.locator('#viewLayer0').click();
  await page.waitForTimeout(150);
  ok('层 1 视图显示深度色阶', await page.locator('#depthScale').isVisible());

  /* 6. 导出 P5 */
  const dlPromise = page.waitForEvent('download');
  await page.locator('#exportL0').click();
  const dl = await dlPromise;
  const file = path.join(OUT, 'layer1.pgm');
  await dl.saveAs(file);
  const pgm = parsePGM(fs.readFileSync(file));
  ok('P5 头为 12×10 65535', pgm.magic === 'P5' && pgm.width === 12 && pgm.height === 10 && pgm.maxval === 65535,
    `${pgm.magic} ${pgm.width} ${pgm.height} ${pgm.maxval}`);
  // 像素 (5,3) 层 1 深度 4 → 5；空像素 (0,0) → 0
  ok('唯一双层像素层 1 写深度 + 1', pgm.samples[3 * 12 + 5] === 5, String(pgm.samples[3 * 12 + 5]));
  ok('无回波像素写 0', pgm.samples[0] === 0, String(pgm.samples[0]));

  const dl2Promise = page.waitForEvent('download');
  await page.locator('#exportL1').click();
  const dl2 = await dl2Promise;
  const file2 = path.join(OUT, 'layer2.pgm');
  await dl2.saveAs(file2);
  const pgm2 = parsePGM(fs.readFileSync(file2));
  ok('层 2 在双层像素写深度 + 1', pgm2.samples[3 * 12 + 5] === 10, String(pgm2.samples[3 * 12 + 5]));
  ok('层 2 在单层像素写 0', pgm2.samples[1] === 0, String(pgm2.samples[1]));

  /* 7. 改上限 */
  await page.locator('#maxDepth').fill('5');
  await page.waitForTimeout(500);
  const t1 = await page.locator('#timing').textContent();
  ok('改上限后重算完成', /耗时/.test(t1), t1);

  /* 8. 非法记录：重复槽 */
  const bad = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'echo-depth.json'), 'utf8'));
  bad.pixels[bad.pixels.length - 1][0] = [[1, 5], [1, 6]];
  fs.writeFileSync('/tmp/_echo_bad.json', JSON.stringify(bad));
  await page.setInputFiles('#fileInput', '/tmp/_echo_bad.json');
  await page.waitForTimeout(300);
  ok('非法记录显示错误卡', await page.locator('#errorCard').isVisible());
  ok('错误指出像素与槽', /\(11, 9\)/.test(await page.locator('#errorList').innerText()) &&
    /槽 1/.test(await page.locator('#errorList').innerText()), await page.locator('#errorList').innerText());
  ok('旧图仍保留', /12 × 10/.test(await page.locator('#recordPill').textContent()));

  /* 9. 第三个 null */
  const bad2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'echo-depth.json'), 'utf8'));
  bad2.pixels[0][1] = [[1, null], [2, null], [3, null]];
  fs.writeFileSync('/tmp/_echo_bad2.json', JSON.stringify(bad2));
  await page.setInputFiles('#fileInput', '/tmp/_echo_bad2.json');
  await page.waitForTimeout(300);
  ok('第三个 null 被定位', /最多 2 处|null/.test(await page.locator('#errorList').innerText()));

  /* 10. 重新载入样例恢复 */
  await page.locator('#loadSample').click();
  await page.waitForTimeout(500);
  ok('重载样例后错误卡消失', !(await page.locator('#errorCard').isVisible()));

  /* 11. 满额图 12 秒 */
  await page.locator('#loadBig').click();
  const t0 = Date.now();
  await page.waitForFunction(() => {
    const pill = document.getElementById('recordPill');
    const timing = document.getElementById('timing');
    return /256 × 256/.test(pill.textContent) && /耗时/.test(timing.textContent);
  }, { timeout: 20000 });
  const bigMs = Date.now() - t0;
  ok('满额图 12 秒内显示结果', bigMs < 12000, bigMs + ' ms');
  const bigCounts = await page.locator('#counts li').allTextContents();
  ok('满额图统计满 65,536', bigCounts.join(' ').includes('65,536'), bigCounts.join(' | '));

  /* 12. 无横向滚动 */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('桌面无横向滚动', overflow <= 0, overflow + 'px');

  /* 13. 手机宽度 */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mpage = await mctx.newPage();
  const merrors = [];
  mpage.on('pageerror', e => merrors.push(e.message));
  await mpage.goto(URL, { waitUntil: 'load' });
  await mpage.waitForFunction(() => /耗时/.test(document.getElementById('timing').textContent), { timeout: 15000 });
  const mover = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('手机宽度无横向滚动', mover <= 0, mover + 'px');
  ok('手机端无脚本错误', merrors.length === 0, merrors.join(' | '));
  const mcanvas = await mpage.locator('#map').boundingBox();
  ok('手机端地图可见', !!mcanvas && mcanvas.width > 40 && mcanvas.height > 40, JSON.stringify(mcanvas));

  await browser.close();
  if (failures) {
    console.log('\n' + failures + ' 项失败');
    process.exit(1);
  }
  console.log('\n全部通过');
})().catch(e => { console.error(e); process.exit(1); });
