/* 浏览器端到端冒烟测试（临时脚本，用全局 playwright 运行） */
'use strict';
const { chromium } = require('playwright');

const SAMPLES = process.argv[2] || '/tmp/png-samples';
const PAGE = 'file://' + require('path').resolve(__dirname, '..', 'index.html');

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [页面异常]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('  [console.error]', m.text()); });

  await page.goto(PAGE);

  // 1. 16 位灰度 Adam7
  console.log('\n[页面] gray16-adam7.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/gray16-adam7.png`);
  await page.waitForSelector('#result:not(.hidden)', { timeout: 5000 });
  const summary = await page.textContent('#summary');
  ok(summary.includes('13 × 9'), '概要显示尺寸 13×9');
  ok(summary.includes('Adam7'), '概要显示 Adam7');
  ok(summary.includes('16'), '概要显示位深 16');
  const passCount = await page.locator('#pass-list .pass').count();
  ok(passCount === 7, '显示 7 个 pass', `实际 ${passCount}`);
  const passText = await page.textContent('#pass-list');
  ok(/Pass 1[\s\S]*2 × 2/.test(passText), 'Pass 1 尺寸 2×2');
  ok(/Pass 7[\s\S]*13 × 4/.test(passText), 'Pass 7 尺寸 13×4');
  ok(passText.includes('压缩占比'), '显示压缩占比');
  const chunkRows = await page.locator('#chunk-table tbody tr').count();
  ok(chunkRows >= 3, `块表有 ${chunkRows} 行`);
  ok((await page.textContent('#chunk-table')).includes('✓'), '块 CRC 全部标记通过');

  // 点查像素（中心位置）
  const box = await page.locator('#preview').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pixelInfo = await page.textContent('#pixel-info');
  ok(pixelInfo.includes('原始样本'), '点查显示原始样本', pixelInfo);
  ok(/灰度=\d+/.test(pixelInfo), '灰度通道值不降位', pixelInfo);
  ok(pixelInfo.includes('预览 RGBA8'), '显示 RGBA8 预览值');

  // 重编码（自动）
  await page.click('#renc-btn');
  await page.waitForSelector('#renc-result:not(.hidden)');
  const rencStats = await page.textContent('#renc-stats');
  ok(rencStats.includes('自动择优'), '重编码统计含模式');
  ok(rencStats.includes('对比原文件'), '重编码统计含对比');

  // 下载重编码 PNG 并验证可解码
  const dl = page.waitForEvent('download');
  await page.click('#dl-png');
  const download = await dl;
  const dlPath = await download.path();
  ok(!!dlPath, '重编码 PNG 可下载');
  const PNGCore = require('../js/png-core.js');
  const fs = require('fs');
  const redec = await PNGCore.decode(new Uint8Array(fs.readFileSync(dlPath)));
  ok(redec.width === 13 && redec.height === 9 && redec.interlace === 0 && redec.depth === 16,
    '下载的重编码 PNG 可解码且非隔行 16 位');

  // 下载 JSON
  const dl2 = page.waitForEvent('download');
  await page.click('#dl-json');
  const download2 = await dl2;
  const rec = JSON.parse(fs.readFileSync(await download2.path(), 'utf8'));
  ok(rec.rows.length === 9 && rec.rows.every((r) => r.pass === 0), 'JSON 逐行记录 9 行均为 pass 0');
  ok(rec.interlace === 0 && rec.depth === 16, 'JSON 元数据正确');

  // 2. 索引色 1 位 Adam7 + tRNS
  console.log('\n[页面] palette-1.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/palette-1.png`);
  await page.waitForSelector('#result:not(.hidden)');
  const summary2 = await page.textContent('#summary');
  ok(summary2.includes('索引色') && summary2.includes('调色板'), '索引色概要含调色板');
  const box2 = await page.locator('#preview').boundingBox();
  await page.mouse.click(box2.x + 2, box2.y + 2);
  const pi2 = await page.textContent('#pixel-info');
  ok(pi2.includes('调色板['), '索引色点查显示调色板项', pi2);

  // 3. 损坏文件
  console.log('\n[页面] bad-crc.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/bad-crc.png`);
  await page.waitForSelector('#error-panel:not(.hidden)');
  ok((await page.textContent('#error-message')).includes('CRC'), 'CRC 错误信息');
  ok(await page.locator('#result').isHidden(), '出错时不显示结果区');
  ok((await page.textContent('#error-location')).includes('块 #'), '错误含块位置');

  console.log('\n[页面] unknown-critical.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/unknown-critical.png`);
  await page.waitForSelector('#error-panel:not(.hidden)');
  ok((await page.textContent('#error-message')).includes('未知关键块'), '未知关键块错误');

  console.log('\n[页面] truncated.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/truncated.png`);
  await page.waitForSelector('#error-panel:not(.hidden)');
  ok(/截断|不完整/.test(await page.textContent('#error-message')), '截断错误');

  // 4. 错误后恢复正常文件
  console.log('\n[页面] 错误后恢复 five-filters.png');
  await page.setInputFiles('#file-input', `${SAMPLES}/five-filters.png`);
  await page.waitForSelector('#result:not(.hidden)');
  ok(await page.locator('#error-panel').isHidden(), '错误面板已隐藏');
  ok((await page.locator('#pass-list .pass').count()) === 1, '非隔行显示 1 个 pass');

  await browser.close();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
