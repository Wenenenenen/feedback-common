// browser-test.mjs — 用 Playwright 在真实 Chromium 里驱动页面，验证完整交互。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = 'file://' + join(root, 'web/index.html');
const cases = join(root, 'cases');

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(pageUrl);

// 用 base64 在浏览器内重建 ArrayBuffer，避免 Buffer 跨进程序列化损坏
async function loadWav(name) {
  const b64 = readFileSync(join(cases, name)).toString('base64');
  await page.evaluate((b64Name) => {
    const [b64, fname] = b64Name;
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([buf.buffer], fname, { type: 'audio/wav' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [b64, name]);
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled,
    { timeout: 5000 }).catch(() => {});
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// 1. 正常文件载入
console.log('[载入 click-train]');
await loadWav('click-train-44k1-16.wav');
ok((await page.textContent('#mRate')).replace(/[,\s]/g, '').includes('44100'), '采样率显示 44100');
ok((await page.textContent('#mBits')).includes('16'), '位深显示 16');
ok((await page.textContent('#mFrames')).includes('352,800'), '帧数显示');

// 2. 不支持格式
console.log('[拒绝 8 位]');
await loadWav('pcm8-unsupported.wav').catch(() => {});
await page.waitForTimeout(200);
ok((await page.textContent('#status')).includes('无法导入'), '8 位被拒绝: ' + (await page.textContent('#status')));

// 3. 截断文件
console.log('[拒绝截断]');
await loadWav('truncated.wav').catch(() => {});
await page.waitForTimeout(200);
ok((await page.textContent('#status')).includes('无法导入'), '截断被拒绝');

// 4. 重新载入合法文件并处理（1.5x）
console.log('[处理 1.5x]');
await loadWav('click-train-44k1-16.wav');
await page.fill('#speed', '1.5');
await page.dispatchEvent('#speed', 'input');
await page.click('#runBtn');
await page.waitForSelector('#exportWav:not([disabled])', { timeout: 30000 });
ok((await page.textContent('#status')).includes('处理完成'), '处理完成状态');
ok((await page.textContent('#mOut')).includes('235,200'), '输出帧数 235200');
ok(!(await page.$('#vizPanel[hidden]')), '波形面板显示');
ok(!(await page.$('#specPanel[hidden]')), '频谱面板显示');
ok(!(await page.$('#tablePanel[hidden]')), '对照表显示');

// 5. canvas 确实绘制了内容
const wavePixels = await page.evaluate(() => {
  const c = document.getElementById('waveOut');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let nonBg = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBg++;
  return nonBg;
});
ok(wavePixels > 1000, `波形 canvas 有绘制内容 (${wavePixels} 像素)`);
const specPixels = await page.evaluate(() => {
  const c = document.getElementById('specOut');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let colored = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) > 20) colored++;
  return colored;
});
ok(specPixels > 100, `频谱 canvas 有彩色内容 (${specPixels})`);

// 6. 对照表行数 = 敲击数
const rows = await page.$$eval('#tableBody tr', trs => trs.length);
ok(rows === 32, `对照表 32 行 (实际 ${rows})`);

// 7. 导出按钮产生下载
console.log('[导出]');
const dlWav = page.waitForEvent('download', { timeout: 5000 });
await page.click('#exportWav');
const wavDl = await dlWav;
ok(wavDl.suggestedFilename().endsWith('.wav'), 'WAV 下载: ' + wavDl.suggestedFilename());
const dlJson = page.waitForEvent('download', { timeout: 5000 });
await page.click('#exportJson');
const jsonDl = await dlJson;
ok(jsonDl.suggestedFilename().endsWith('.json'), 'JSON 下载: ' + jsonDl.suggestedFilename());
const jsonPath = await jsonDl.path();
const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
ok(json.outputFrames === 235200, 'JSON outputFrames 正确');
ok(json.transients.length === 32, 'JSON 含 32 个敲击');
ok(json.transients[0].outputSample === json.transients[0].expected, '首锚点映射=round(p/speed)');

// 8. 立体声 0.5x
console.log('[立体声 0.5x]');
await loadWav('stereo-itd-44k1-16.wav');
await page.fill('#speed', '0.5');
await page.dispatchEvent('#speed', 'input');
await page.click('#runBtn');
await page.waitForSelector('#exportWav:not([disabled])', { timeout: 30000 });
ok((await page.textContent('#mCh')).includes('双声道'), '双声道识别');
ok((await page.textContent('#mOut')).includes('264,600'), '0.5x 输出帧 264600');

// 9. 取消功能（用 60s 文件）
console.log('[取消 60s]');
await loadWav('long-60s-48k-16.wav');
await page.click('#runBtn');
await page.waitForSelector('#cancelBtn:not([hidden])');
await page.click('#cancelBtn');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('取消'));
ok(true, '60s 处理可取消，页面未卡死');

ok(errors.length === 0, '无控制台错误' + (errors.length ? ': ' + errors.join(' | ') : ''));

await browser.close();
console.log(`\n浏览器测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
