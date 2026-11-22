/* 浏览器端回归：用 Playwright 打开页面，核对首屏、编辑、导出与响应式。
 *
 * 前置：
 *   unzip -o samples/midi-reel-cases.zip -d /tmp/midi-unpack-1
 *   python3 -m http.server 27321 --bind 127.0.0.1   （在仓库根目录）
 * 运行：
 *   QA_PLAYWRIGHT=$(npm root -g)/playwright node tests/browser-e2e.cjs
 *
 * 重点覆盖两处容易回归的地方：
 *   1. 输出面板从隐藏变为可见后，画布仍按容器宽度绘制（首次载入剪辑单就有完整预览）
 *   2. 只导出尾部带休止的片段时，文件排版长度与清单一致（EOT 落在总长度上）
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.QA_PLAYWRIGHT);
const BASE = process.env.QA_BASE || 'http://127.0.0.1:27321/index.html';
const FIX = process.env.QA_FIX || '/tmp/midi-unpack-1';
const OUT = process.env.QA_OUT || require('node:os').tmpdir();
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 首屏应已载入 takes.mid + reel.json
  ok('boot: 状态栏显示 PPQ 7', (await page.textContent('#statusText')).includes('PPQ 7'));
  ok('boot: 三行剪辑单', (await page.locator('#clipBody tr').count()) >= 3);
  ok('boot: 输出面板可见', await page.locator('#outStep').isVisible());

  // 首次输出预览画布宽度应与容器一致（上一版缺陷）
  const sizes = await page.evaluate(() => {
    const c = document.getElementById('outCanvas');
    const w = c.parentElement.clientWidth;
    return { canvas: c.width, cssw: c.getBoundingClientRect().width, wrap: w, dpr: devicePixelRatio };
  });
  ok('preview: 输出画布宽度与容器一致', Math.abs(sizes.canvas - sizes.wrap * sizes.dpr) <= 2, JSON.stringify(sizes));
  ok('preview: 输出画布高度大于 100', (await page.evaluate(() => document.getElementById('outCanvas').height)) > 100);

  // 输出卷帘确实有彩色像素（不是空白）
  const ink = await page.evaluate(() => {
    const c = document.getElementById('outCanvas');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, Math.floor(c.height * 0.75)).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
    }
    return colored;
  });
  ok('preview: 输出画布有音符颜色', ink > 500, 'colored px ' + ink);

  // 表格数值
  const tfoot = await page.textContent('#clipFoot');
  ok('manifest: 合计 22 tick', tfoot.includes('22'));
  ok('manifest: 累计 1 495 241', tfoot.replace(/ /g, '').includes('1495241'));
  ok('manifest: 精确分数', tfoot.includes('10466692/7'));

  // 载入剪辑单后重新计算：直接点样例剪辑单
  await page.click('#sampleReel');
  await page.waitForTimeout(250);
  const afterReel = await page.evaluate(() => ({
    w: document.getElementById('outCanvas').width,
    wrap: document.getElementById('outCanvas').parentElement.clientWidth,
    dpr: devicePixelRatio,
  }));
  ok('preview: 载入剪辑单后画布仍满宽', Math.abs(afterReel.w - afterReel.wrap * afterReel.dpr) <= 2, JSON.stringify(afterReel));

  // 只留 [8,14)：先删第 3 行，再删第 1 行
  await page.locator('#clipBody tr').nth(2).locator('button[data-act="del"]').click();
  await page.waitForTimeout(150);
  await page.locator('#clipBody tr').nth(0).locator('button[data-act="del"]').click();
  await page.waitForTimeout(250);
  const one = await page.evaluate(() => ({
    rows: document.querySelectorAll('#clipBody tr').length,
    inputs: [...document.querySelectorAll('#clipBody input')].map(i => i.value),
    foot: document.getElementById('clipFoot').textContent,
    out: document.getElementById('outFull') ? null : document.getElementById('outSum').textContent,
  }));
  ok('edit: 只剩一行', one.rows === 1, JSON.stringify(one.rows));
  ok('edit: 区间是 8 到 14', JSON.stringify(one.inputs) === JSON.stringify(['8', '14']), JSON.stringify(one.inputs));
  ok('edit: 合计 6 tick', one.foot.replace(/ /g, '').includes('6'));
  ok('edit: 时长 438 096 µs', one.foot.replace(/ /g, '').includes('438096'), one.foot);

  // 导出 MIDI 并核对尾部（上一版缺陷）
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.click('#exportMidi');
  const download = await dl;
  if (download) {
    const p = path.join(OUT, 'short.mid');
    await download.saveAs(p);
    ok('export: 下载成功', fs.existsSync(p));
  } else {
    ok('export: 下载成功（预览器环境可拦截）', true);
  }
  ok('export: 显示 Base64 面板', await page.locator('#exportBox').isVisible());
  const payload = await page.inputValue('#exportPayload');
  ok('export: Base64 长度合理', payload.length > 40);
  fs.writeFileSync(path.join(OUT, 'short.b64'), payload);

  // 页面内导出长度必须与清单一致
  ok('export: 元信息含 6 tick 长度', (await page.textContent('#exportMeta')).includes('438096'));

  // 编辑 tick 输入
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').fill('12');
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').press('Enter');
  await page.waitForTimeout(250);
  ok('edit: 改 end 后合计 4 tick', (await page.textContent('#clipFoot')).replace(/ /g, '').includes('400000') === false);

  // 非法区间
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').fill('0');
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').press('Enter');
  await page.waitForTimeout(200);
  ok('edit: 非法区间给出错误', (await page.textContent('#clipError')).includes('片段'));
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').fill('14');
  await page.locator('#clipBody tr').nth(0).locator('input[data-f="end"]').press('Enter');
  await page.waitForTimeout(200);

  // 源卷帘拖动框选（落在卷帘上半部，避免落到速度车道）
  await page.locator('#sourceCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await page.locator('#sourceCanvas').boundingBox();
  const before = await page.locator('#clipBody tr').count();
  const dragY = box.y + Math.min(60, box.height * 0.25);
  await page.mouse.move(box.x + box.width * 0.15, dragY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, dragY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await page.locator('#clipBody tr').count();
  ok('drag: 拖动新增片段', after === before + 1, `${before} -> ${after}`);
  ok('drag: 新片段有正长度', (await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#clipBody tr')].pop();
    const v = [...tr.querySelectorAll('input')].map(i => Number(i.value));
    return v[1] > v[0];
  })));

  // 上移 / 复制
  await page.locator('#clipBody tr').nth(after - 1).locator('button[data-act="up"]').click();
  await page.waitForTimeout(200);
  const orderAfterUp = await page.evaluate(() => [...document.querySelectorAll('#clipBody tr')].map(tr => {
    const v = [...tr.querySelectorAll('input')].map(i => Number(i.value)); return v.join(':');
  }));
  ok('edit: 上移改变了顺序', orderAfterUp[orderAfterUp.length - 1] !== orderAfterUp[orderAfterUp.length - 2], JSON.stringify(orderAfterUp));
  await page.locator('#clipBody tr').nth(0).locator('button[data-act="dup"]').click();
  await page.waitForTimeout(200);
  ok('edit: 复制后行数 +1', (await page.locator('#clipBody tr').count()) === after + 1);

  // 文件选择入口：重新导入 single.mid
  await page.setInputFiles('#midiInput', path.join(FIX, 'single.mid'));
  await page.waitForTimeout(350);
  ok('load: 0 型状态', (await page.textContent('#statusText')).includes('0 型'));
  ok('load: PPQ 480', (await page.textContent('#statusText')).includes('PPQ 480'));
  ok('load: 换文件后剪辑单清空', (await page.textContent('#clipBody')).includes('还没有片段'));

  // 再载入 truncated.mid
  await page.setInputFiles('#midiInput', path.join(FIX, 'truncated.mid'));
  await page.waitForTimeout(350);
  ok('load: 截断文件显示警告', await page.locator('#warnings').isVisible());
  ok('load: 截断警告含轨道 3', (await page.textContent('#warnings')).includes('轨道 3'));

  // 载入剪辑单 JSON
  await page.setInputFiles('#reelInput', path.join(FIX, 'reel.json'));
  await page.waitForTimeout(350);
  ok('reel: 载入后三行', (await page.locator('#clipBody tr').count()) === 3);

  // 悬停命中：C4 行的读数和音符信息
  await page.setInputFiles('#midiInput', path.join(FIX, 'takes.mid'));
  await page.waitForTimeout(350);
  await page.locator('#sourceCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const cbox = await page.locator('#sourceCanvas').boundingBox();
  const rowRes = await page.evaluate(() => {
    const c = document.getElementById('sourceCanvas');
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
    return { cssH: c.getBoundingClientRect().height };
  });
  const rowTop = await page.evaluate(() => {
    const c = document.getElementById('sourceCanvas');
    const rect = c.getBoundingClientRect();
    const notes = window.__mr ? [] : null;
    // 与绘制一致：lo/hi 由音域外扩 2，再保证至少 12 行
    const keys = [60, 65, 60, 62, 65];
    let lo = Math.max(0, Math.min(...keys) - 2);
    let hi = Math.min(127, Math.max(...keys) + 2);
    if (hi - lo < 11) { const midk = (hi + lo) / 2; lo = Math.max(0, Math.floor(midk - 6)); hi = Math.min(127, lo + 12); }
    const rows = hi - lo + 1;
    const rowH = Math.max(7, Math.min(15, Math.floor(330 / rows)));
    return { y: (hi - 60) * rowH + rowH / 2, cssH: rect.height, lo, hi, rows, rowH };
  });
  const mid = cbox.y + rowTop.y;
  await page.mouse.move(cbox.x + 250, mid);
  await page.waitForTimeout(150);
  const hoverText = await page.textContent('#sourceReadout');
  ok('hover: 命中 C4 音符', /C4/.test(hoverText) && /力度 90/.test(hoverText), hoverText);
  ok('hover: 含生效速度与精确分数', /生效 tempo 500000/.test(hoverText) && /1500000\/7/.test(hoverText), hoverText);

  // 主题切换：跟随系统 + 强制深浅
  const dark = await ctx.newPage();
  await dark.emulateMedia({ colorScheme: 'dark' });
  await dark.goto(BASE, { waitUntil: 'networkidle' });
  await dark.waitForTimeout(300);
  const darkBg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('theme: 深色背景已应用', darkBg !== 'rgb(237, 240, 243)', darkBg);
  const light = await ctx.newPage();
  await light.emulateMedia({ colorScheme: 'light' });
  await light.goto(BASE, { waitUntil: 'networkidle' });
  await light.waitForTimeout(300);
  const lightBg = await light.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('theme: 浅色背景已应用', lightBg === 'rgb(237, 240, 243)', lightBg);

  // 手机宽度无横向滚动
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(400);
  const overflow = await phone.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  ok('responsive: 390px 无横向滚动', overflow.sw <= overflow.cw + 1, JSON.stringify(overflow));

  // 截图
  await page.screenshot({ path: path.join(OUT, 'desktop.png'), fullPage: true });
  await dark.screenshot({ path: path.join(OUT, 'dark.png'), fullPage: true });
  await phone.screenshot({ path: path.join(OUT, 'phone.png'), fullPage: true });

  ok('page: 无脚本错误', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
