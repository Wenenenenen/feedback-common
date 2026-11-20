/* 透明像素 RGB 端到端保留测试：空链下 解码→处理→导出PNG 应逐字节还原未预乘像素
 * NODE_PATH=$(npm root -g) node test/alpha-roundtrip.test.js <样例目录> [工程目录] */
'use strict';
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const samplesDir = process.argv[2];
const appDir = process.argv[3] || path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('页面异常:', e); process.exit(1); });
  await page.goto('file://' + path.join(appDir, 'index.html'));
  await page.waitForSelector('#stageList', { state: 'attached' });

  // 空链（直通）加载 alpha-ramp.png
  await page.setInputFiles('#pngFile', [path.join(samplesDir, 'alpha-ramp.png')]);
  await page.waitForFunction(() => document.getElementById('imgInfo').textContent.includes('129'));

  // 从页面取出解码后的原始未预乘像素
  const origB64 = await page.evaluate(() => {
    const img = window.__state_image_orig();
    let bin = '';
    const chunk = 32768;
    for (let i = 0; i < img.length; i += chunk)
      bin += String.fromCharCode.apply(null, img.subarray(i, i + chunk));
    return btoa(bin);
  });
  const orig = Buffer.from(origB64, 'base64');

  // 导出处理后的 PNG
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportPng')]);
  const pngPath = path.join(require('os').tmpdir(), 'alpha-roundtrip.png');
  await dl.saveAs(pngPath);
  await browser.close();

  // 在 Node 中解码导出的 PNG（我们的编码器：filter 0，单 IDAT）
  const png = require('fs').readFileSync(pngPath);
  let off = 8, idat = null, w = 0, h = 0;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat = idat ? Buffer.concat([idat, data]) : data;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  const stride = 1 + w * 4;
  const decoded = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(decoded, y * w * 4, y * stride + 1, (y + 1) * stride);

  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
  ok(w === 129 && h === 65, `尺寸 ${w}×${h}`);
  ok(decoded.length === orig.length, '像素数据长度一致');
  let diff = 0, alphaZeroWithRGB = 0;
  for (let i = 0; i < decoded.length; i++) if (decoded[i] !== orig[i]) diff++;
  for (let i = 0; i < decoded.length; i += 4)
    if (decoded[i + 3] === 0 && (decoded[i] || decoded[i + 1] || decoded[i + 2])) alphaZeroWithRGB++;
  ok(diff === 0, `空链导出逐字节一致（差异字节 ${diff}）`);
  ok(alphaZeroWithRGB > 0, `存在 alpha=0 且 RGB 非零的像素（${alphaZeroWithRGB} 个），其 RGB 被保留`);
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
