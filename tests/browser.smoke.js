/* 页面级冒烟测试：用 Playwright 驱动真实浏览器验证交互 */
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const path = require('path');

const URL = 'http://127.0.0.1:8731/index.html';
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('tState').textContent !== '未编码', null, { timeout: 8000 });

  // 1. 默认样例自动编码且无损
  const state0 = await readState(page);
  check('默认样例自动进入完整态', state0.pill === '完整流已接收', state0.pill);
  check('完整流 maxErr=0', state0.maxErr === '0', state0.maxErr);
  check('无损横幅出现', await page.isVisible('#losslessBanner'));
  check('PSNR 无穷大', state0.psnr.includes('∞'), state0.psnr);
  check('有效层计数正确', /^\d+ \/ \d+$/.test(state0.layers), state0.layers);

  // 2. 切到单行样例
  await page.click('.sample-btn[data-file="assets/samples/single-row.png"]');
  await page.waitForTimeout(300);
  const row = await readState(page);
  check('单行样例无损', row.maxErr === '0', row.maxErr);
  check('单行记录表面板可切换', await switchTab(page, 'records'));
  const recRows = await page.locator('#recordsBody tr').count();
  check('单行有层记录行', recRows >= 8, String(recRows));

  // 3. 单列
  await page.click('.sample-btn[data-file="assets/samples/single-column.png"]');
  await page.waitForTimeout(300);
  check('单列样例无损', (await readState(page)).maxErr === '0');

  // 4. 全零系数
  await page.click('.sample-btn[data-file="assets/samples/zero-coefficients.png"]');
  await page.waitForTimeout(300);
  const zero = await readState(page);
  check('全零流有效层 0/0', zero.layers === '0 / 0', zero.layers);
  check('全零流无损', zero.maxErr === '0', zero.maxErr);
  const zeroChips = await page.locator('#layerChips .chip').innerText();
  check('全零流芯片说明', zeroChips.includes('highbit=255'), zeroChips);

  // 5. 回到 odd-ramp，滑块拖到中间 → 出现 waiting 或部分层
  await page.click('.sample-btn[data-file="assets/samples/odd-ramp.png"]');
  await page.waitForTimeout(400);
  const total = await page.inputValue('#byteRange');
  await page.fill('#byteRange', String(Math.floor(total * 0.35)));
  await page.dispatchEvent('#byteRange', 'input');
  await page.waitForTimeout(200);
  const mid = await readState(page);
  check('35% 字节时有效层少于总数', mid.layerCount < mid.totalLayers,
    `${mid.layerCount}/${mid.totalLayers}`);
  check('35% 字节状态为等待/接收中', ['等待数据', '接收中'].includes(mid.pill), mid.pill);
  check('等待横幅显示', await page.isVisible('#waitBanner'));
  check('中间预览仍有有限误差', +mid.maxErr > 0, mid.maxErr);

  // 6. “截在半层”按钮
  await page.click('#halfBtn');
  await page.waitForTimeout(200);
  const half = await readState(page);
  check('半层截断处于等待', half.pill === '等待数据', half.pill);
  check('半层只提交完整层', half.layerCount >= 1, String(half.layerCount));

  // 7. 逐字节喂入按钮
  await page.click('#resetBtn');
  await page.selectOption('#chunkSize', '1');
  for (let i = 0; i < 30; i++) await page.click('#feedBtn');
  const byte30 = await readState(page);
  check('逐字节喂入 30 次未报错', byte30.pill !== '错误', byte30.pill);
  check('逐字节喂入已收 30B', byte30.bytes === '30', byte30.bytes);

  // 8. 回到完整 → 无损
  await page.fill('#byteRange', total);
  await page.dispatchEvent('#byteRange', 'input');
  await page.waitForTimeout(200);
  const full = await readState(page);
  check('拖回完整后无损', full.maxErr === '0', full.maxErr);

  // 9. CRC 损坏演示
  await page.check('#corruptChk');
  await page.waitForTimeout(300);
  const corrupt = await readState(page);
  check('损坏流硬错误', corrupt.pill === '错误', corrupt.pill);
  check('错误横幅出现且含 CRC/zlib 字样',
    await page.locator('#errText code').innerText().then(t => /CRC32|zlib/.test(t)));
  await page.uncheck('#corruptChk');
  await page.waitForTimeout(300);

  // 10. 系数热图与检视器
  await switchTab(page, 'coeff');
  const coeffSize = await page.evaluate(() => {
    const c = document.getElementById('coeffCanvas');
    return { w: c.width, h: c.height };
  });
  check('系数热图已渲染', coeffSize.w > 0 && coeffSize.h > 0, JSON.stringify(coeffSize));
  await page.click('#coeffCanvas', { position: { x: 10, y: 10 } });
  const insp = await page.locator('#inspCur').innerText();
  check('系数检视器有值', /^-?\d+$/.test(insp), insp);
  await page.selectOption('#bandLevel', '1');
  const bandText = await page.locator('#inspBand').innerText();
  check('子带归属已计算', /LL|HL|LH|HH/.test(bandText), bandText);

  // 11. 层数选择：0 层与最大层
  const maxL = await page.inputValue('#levelRange');
  await page.fill('#levelRange', '0');
  await page.dispatchEvent('#levelRange', 'change');
  await page.waitForTimeout(300);
  check('0 层也无损', (await readState(page)).maxErr === '0');
  await page.fill('#levelRange', maxL);
  await page.dispatchEvent('#levelRange', 'change');
  await page.waitForTimeout(300);
  check('最大层数无损', (await readState(page)).maxErr === '0');

  // 12. 导出 → 重新导入（在页面内用 Base64 往返）
  await page.click('#copyB64Btn');
  await page.waitForTimeout(100);
  const b64 = await page.evaluate(async () => {
    // 直接复用剪贴板可能被拒，改从导出的 blob 读取
    return new Promise((resolve) => {
      // 通过重新编码取得 base64：触发一次 textarea 内容回退路径不可靠，
      // 这里用页面内函数等价生成
      resolve(document.getElementById('b64Input').value || '');
    });
  });
  let importB64 = b64;
  if (!importB64) {
    importB64 = await page.evaluate(() => {
      // 手工触发：读取剪贴板失败时按钮已把内容放进 textarea
      return document.getElementById('b64Input').value;
    });
  }
  check('导出 Base64 可用', importB64.startsWith('data:application/octet-stream;base64,'),
    importB64.slice(0, 40));
  await page.fill('#b64Input', importB64);
  await page.click('#b64ImportBtn');
  await page.waitForTimeout(300);
  const reimp = await readState(page);
  check('重新导入后完整态', reimp.pill === '完整流已接收', reimp.pill);
  check('重新导入后无损', reimp.maxErr === '0', reimp.maxErr);

  // 13. 手机宽度无横向滚动
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(200);
  const scroll = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  check('手机宽度无横向滚动', scroll.sw <= scroll.iw, JSON.stringify(scroll));

  check('无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

  // 14. 文件上传路径：1x1 与 1024 最大边
  for (const f of ['assets/samples/1x1-mid.png', 'assets/samples/strip-1024x8.png']) {
    await page.setInputFiles('#pngInput', path.resolve(__dirname, '..', f));
    await page.waitForTimeout(300);
    const s = await readState(page);
    check(`上传 ${f.split('/').pop()} 无损`, s.maxErr === '0',
      `${s.pill} maxErr=${s.maxErr}`);
    check(`上传 ${f.split('/').pop()} 无错误`, s.pill !== '错误', s.pill);
  }

  // 15. 导入被截断的流 → 等待而非报错
  const truncated = await page.evaluate(() => {
    // 重新编码当前图并取前 60% 字节转 base64
    return new Promise((resolve) => {
      const ta = document.getElementById('b64Input');
      // 用当前导出能力取得完整流：通过下载链路不可行，改为滑块截断后读取 parser 内部
      resolve(null);
    });
  });
  void truncated;
  const truncB64 = await page.evaluate(() => {
    // 直接从页面状态构造：把字节滑块设到 40%，再用 fetch 无法拿到内部流，
    // 因此用 XMLHttpRequest 重新取样例并在页面内编码
    return fetch('assets/samples/impulse.png')
      .then(r => r.arrayBuffer())
      .then((buf) => {
        const png = new Uint8Array(buf);
        const dec = PNG8.decode(png, zlibAdapter);
        const enc = G53.encodeStream(Array.from(dec.pixels), dec.width, dec.height, 3, zlibAdapter);
        const cut = Math.floor(enc.stream.length * 0.4);
        let bin = '';
        for (let i = 0; i < cut; i++) bin += String.fromCharCode(enc.stream[i]);
        return 'data:application/octet-stream;base64,' + btoa(bin);
      });
  });
  await page.fill('#b64Input', truncB64);
  await page.click('#b64ImportBtn');
  await page.waitForTimeout(300);
  const truncState = await readState(page);
  check('截断流导入为等待态', ['等待数据', '接收中'].includes(truncState.pill), truncState.pill);
  check('截断流没有硬错误', truncState.pill !== '错误');
  check('截断流至少未误报完整', truncState.pill !== '完整流已接收');

  check('无控制台错误（最终）', consoleErrors.length === 0,
    consoleErrors.join(' | ').slice(0, 200));

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n冒烟测试：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

async function readState(page) {
  return page.evaluate(() => ({
    pill: document.getElementById('tState').textContent.trim(),
    bytes: document.getElementById('tBytes').textContent.trim(),
    layers: document.getElementById('tLayers').textContent.trim(),
    layerCount: document.querySelectorAll('#layerChips .chip.verified').length,
    totalLayers: document.querySelectorAll('#layerChips .chip').length,
    maxErr: document.getElementById('tMaxErr').textContent.trim(),
    psnr: document.getElementById('tPsnr').textContent.trim(),
  }));
}

async function switchTab(page, name) {
  await page.click(`.tab[data-tab="${name}"]`);
  return page.isVisible(`#tab-${name}`);
}
