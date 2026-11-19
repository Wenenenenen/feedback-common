/*
 * e2e.spec.js — Playwright 端到端测试（node tests/e2e.spec.js）
 * 用全局 playwright 包与 ms-playwright 缓存中的 chromium。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SAMPLES = path.join(ROOT, 'samples', 'extracted');
const OUT = path.join(ROOT, 'tests', 'e2e-out');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('file://' + path.join(SRC, 'index.html'));
  await sleep(300);

  // ---------- 1. 导入 stripe.png ----------
  console.log('1) 导入 stripe.png');
  await page.setInputFiles('#file-input', path.join(SAMPLES, 'stripe.png'));
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'), null, { timeout: 8000 });
  await sleep(200);
  const info = await page.textContent('#file-info');
  check('识别 128x96 -> 128x128', /128×96/.test(info) && /128×128/.test(info), info);

  // ---------- 2. 频谱点查 ----------
  console.log('2) 频谱点查');
  const box = await page.locator('#spectrum').boundingBox();
  // 居中画布：未 shift (16,0) 的居中坐标 = (64+16, 64) 比例位置
  const cx = box.x + ((16 + 64) / 128) * box.width;
  const cy = box.y + (64 / 128) * box.height;
  await page.mouse.click(cx, cy);
  await sleep(150);
  const probe = await page.textContent('#probe');
  check('点查显示 u=16 v=0', /u=16 v=0/.test(probe), probe);
  check('点查显示复数值', /re=/.test(probe) && /im=/.test(probe));

  // ---------- 3. 添加陷波（待确认 -> 确认） ----------
  console.log('3) 添加陷波组');
  await page.click('#add-btn');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(200);
  const count1 = await page.textContent('#notch-count');
  check('陷波计数 1/16', /1 \/ 16/.test(count1), count1);
  const rows1 = await page.locator('#notch-table tbody tr').count();
  check('报告出现两个唯一中心（共轭对）', rows1 === 2, 'rows=' + rows1);
  const tableText = await page.textContent('#notch-table');
  check('含 (16,0) 与 (112,0)', /\(16,0\)/.test(tableText) && /\(112,0\)/.test(tableText), tableText);
  const afterVals = await page.locator('#notch-table tbody tr td:last-child').allTextContents();
  check('两中心滤波后幅值近零', afterVals.every((v) => parseFloat(v) < 1e-6), JSON.stringify(afterVals));
  // 再点一次陷波标记，探针应吸附到精确中心并显示 H≈0、滤波后近零
  await page.mouse.click(cx, cy);
  await sleep(150);
  const probeAfter = await page.textContent('#probe');
  check('探针吸附陷波中心且显示 H≈0', /u=16 v=0/.test(probeAfter) && /H=0/.test(probeAfter), probeAfter);

  // ---------- 4. 直流禁止放置 ----------
  console.log('4) 直流保护');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(100);
  const addBtnText = await page.textContent('#add-btn');
  check('点直流后按钮仍提示先选位置（未挂待确认点）', !/\(0,0\)/.test(addBtnText), addBtnText);

  // ---------- 5. 奈奎斯特自共轭（nyquist.png, 64,0） ----------
  console.log('5) 奈奎斯特自共轭不重复抑制');
  await page.setInputFiles('#file-input', path.join(SAMPLES, 'nyquist.png'));
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(200);
  const box2 = await page.locator('#spectrum').boundingBox();
  // 128x64 填充；(64,0) 居中显示坐标 = ((64+64)%128=0, 32)
  const nx = box2.x + (0 / 128) * box2.width + box2.width / 128 / 2;
  const ny = box2.y + (32 / 64) * box2.height;
  await page.mouse.click(nx, ny);
  await sleep(100);
  const probe2 = await page.textContent('#probe');
  check('点查命中 (64,0)', /u=64 v=0/.test(probe2), probe2);
  await page.click('#add-btn');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(200);
  const rowsN = await page.locator('#notch-table tbody tr').count();
  check('自共轭中心仅一行', rowsN === 1, 'rows=' + rowsN);
  // 再尝试添加同一奈奎斯特位置：直接在页面内把待确认点设为 (64,0) 后点添加
  const blocked = await page.evaluate(() => {
    const fnc = window.__fnc;
    fnc.state.pendingUV = [64, 0];
    const before = fnc.state.notches.length;
    document.getElementById('add-btn').click();
    return { before, after: fnc.state.notches.length, toast: document.getElementById('toast').textContent };
  });
  await sleep(200);
  const countN = await page.textContent('#notch-count');
  check('重复奈奎斯特被拦截，仍为 1/16', blocked.before === 1 && blocked.after === 1 && /1 \/ 16/.test(countN),
    JSON.stringify(blocked) + ' ' + countN);
  check('提示冲突原因', /占用|奈奎斯特/.test(blocked.toast), blocked.toast);

  // ---------- 6. 拖动与共轭联动（用离轴点，避免主/共轭标记在边缘混淆） ----------
  console.log('6) 拖动陷波');
  await page.setInputFiles('#file-input', path.join(SAMPLES, 'stripe.png'));
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(150);
  // 放置 (20,10)：居中坐标 (84,74)，共轭 (108,118)，两者相距足够远
  const b3 = await page.locator('#spectrum').boundingBox();
  const px20 = b3.x + (84 / 128) * b3.width;
  const py10 = b3.y + (74 / 128) * b3.height;
  await page.mouse.click(px20, py10);
  await sleep(80);
  await page.click('#add-btn');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(150);
  check('初始位置 (20,10)', /\(20,10\)/.test(await page.textContent('#notch-list')));
  // 向右下拖动 3×2 格（居中坐标 +3,+2 -> 未 shift u+3,v+2）
  await page.mouse.move(px20, py10);
  await page.mouse.down();
  await page.mouse.move(px20 + (3 / 128) * b3.width, py10 + (2 / 128) * b3.height, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(200);
  const listText = await page.textContent('#notch-list');
  check('拖动后位置变为 (23,12)', /\(23,12\)/.test(listText), listText);
  check('共轭联动显示 (105,116)', /\(105,116\)/.test(listText), listText);

  // ---------- 7. 参数滑杆与删除 ----------
  console.log('7) 滑杆与删除');
  await page.locator('#edit-sigma').evaluate((el) => {
    el.value = '1.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#edit-strength').evaluate((el) => {
    el.value = '0.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(150);
  const meta = await page.textContent('#notch-list');
  check('σ/strength 更新到列表', /σ=1.5/.test(meta) && /s=0.5/.test(meta), meta);
  await page.click('#delete-btn');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(150);
  check('删除后计数归零', /0 \/ 16/.test(await page.textContent('#notch-count')));

  // ---------- 8. 预览切换与差值 ----------
  console.log('8) 预览切换');
  await page.click('.tab[data-view="original"]');
  await sleep(150);
  await page.click('.tab[data-view="diff"]');
  await sleep(150);
  const gainWrapVisible = await page.locator('#diff-gain-wrap').isVisible();
  check('差值视图显示增益滑杆', gainWrapVisible);
  await page.click('.tab[data-view="filtered"]');

  // ---------- 9. 空滤波器无损往返（odd.png，两种填充） ----------
  console.log('9) 空滤波器无损往返');
  for (const mode of ['reflect101', 'zero']) {
    await page.setInputFiles('#file-input', path.join(SAMPLES, 'odd.png'));
    await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
    await sleep(150);
    if (mode === 'zero') await page.click('#pad-seg button[data-mode="zero"]');
    else await page.click('#pad-seg button[data-mode="reflect101"]');
    await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
    await sleep(200);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-png-btn'),
    ]);
    const p = path.join(OUT, 'empty_' + mode + '.png');
    await dl.saveAs(p);
    const same = comparePNG(path.join(SAMPLES, 'odd.png'), p);
    check(mode + ' 空陷波导出像素逐字节一致', same, mode);
  }

  // ---------- 10. 导出 JSON 结构 ----------
  console.log('10) 导出报告 JSON');
  // 先加一组陷波
  await page.click('#pad-seg button[data-mode="reflect101"]');
  await sleep(100);
  const b4 = await page.locator('#spectrum').boundingBox();
  // 填充 128x64：(7,5) 的居中坐标 = (71, 37)；画布为方形，y 按 64 行映射
  await page.mouse.click(
    b4.x + (71 / 128) * b4.width,
    b4.y + (37 / 64) * b4.height
  );
  await sleep(80);
  const probeOdd = await page.textContent('#probe');
  check('点查命中 (7,5)', /u=7 v=5/.test(probeOdd), probeOdd);
  await page.click('#add-btn');
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('完成'));
  await sleep(200);
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-json-btn'),
  ]);
  const jp = path.join(OUT, 'report.json');
  await dl2.saveAs(jp);
  const rep = JSON.parse(fs.readFileSync(jp, 'utf8'));
  check('JSON 含填充尺寸', rep.padding && rep.padding.paddedSize.width === 128 && rep.padding.paddedSize.height === 64);
  check('JSON 含陷波参数', Array.isArray(rep.notches) && rep.notches[0].sigma === 0.6);
  check('JSON 含数值误差', isFinite(rep.numericErrors.maxImaginaryBeforeClip)
    && rep.numericErrors.meanBefore_linearRGB.length === 3);
  check('JSON 含陷波前后幅值', rep.notchMagnitudes[0].magnitudeBefore >= 0);

  // ---------- 11. 超限文件被拒 ----------
  console.log('11) 输入校验');
  const big = makePNG(path.join(OUT, 'big.png'), 513, 8);
  const err0 = errors.length;
  await page.setInputFiles('#file-input', big);
  await sleep(400);
  const toast = await page.textContent('#toast');
  check('513 宽被拒绝', /512/.test(toast), toast);
  check('拒绝时无未捕获异常', errors.length === err0, JSON.stringify(errors));

  // ---------- 12. 控制台无错误 ----------
  check('全程无 console error / 异常', errors.length === 0, JSON.stringify(errors));

  await page.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true });
  await browser.close();
  console.log('');
  if (failures) { console.error(failures + ' 项失败'); process.exit(1); }
  console.log('全部 E2E 通过');
})().catch((e) => { console.error(e); process.exit(1); });

/* ---- 辅助：纯 Node PNG 解码比对 + 造 PNG ---- */
const zlib = require('zlib');
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = chunk.readUInt32BE(0); h = chunk.readUInt32BE(4); ct = chunk[9]; }
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = ct === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const prev = Buffer.alloc(stride);
  const rows = [];
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v;
      if (f === 0) v = line[x];
      else if (f === 1) v = line[x] + a;
      else if (f === 2) v = line[x] + b;
      else if (f === 3) v = line[x] + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[x] = v & 255;
    }
    line.copy(prev);
    // 统一输出 RGB：RGBA 行每像素跳过 alpha
    const rgb = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      rgb[x * 3] = line[x * ch];
      rgb[x * 3 + 1] = line[x * ch + 1];
      rgb[x * 3 + 2] = line[x * ch + 2];
    }
    rows.push(rgb); }
  return { w, h, data: Buffer.concat(rows) };
}
function comparePNG(a, b) {
  // 约定要求“编码像素必须不变”：比较解码后的像素，而非压缩字节流
  const A = decodePNG(a), B = decodePNG(b);
  return A.w === B.w && A.h === B.h && A.data.equals(B.data);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}
function makePNG(file, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (1 + w * 3) + 1 + x] = (x + y) & 255;
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}
