/* 端到端测试：真实浏览器加载 index.html，导入样例 WAV，校验显示与导出。 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DIR = process.argv[2];          // 解压后的样例目录
const PAGE = 'file://' + path.resolve(__dirname, 'index.html');
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('ok:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(PAGE);

  // 采样率冲突：main-48000 + key-44100 必须拒绝并指出文件名与两个采样率
  await page.setInputFiles('#main-file', path.join(DIR, 'main-48000.wav'));
  await page.waitForTimeout(300);
  await page.setInputFiles('#key-file', path.join(DIR, 'key-44100.wav'));
  await page.waitForTimeout(300);
  const errText = await page.textContent('#errors');
  check(/采样率不一致/.test(errText) && errText.includes('main-48000.wav') &&
        errText.includes('key-44100.wav') && errText.includes('48000') && errText.includes('44100'),
        '采样率冲突报错含两个文件名与采样率: ' + errText);

  // 截断文件必须拒绝
  await page.setInputFiles('#key-file', path.join(DIR, 'invalid-truncated.wav'));
  await page.waitForTimeout(300);
  const errText2 = await page.textContent('#errors');
  check(/截断/.test(errText2), '截断文件被拒绝: ' + errText2);

  // 正确加载 48k 主轨 + 旁链
  await page.setInputFiles('#key-file', path.join(DIR, 'key-48000.wav'));
  await page.waitForTimeout(400);
  check((await page.textContent('#errors')) === '', '正确文件加载后无错误');
  check((await page.textContent('#main-info')).includes('48000 Hz'), '主轨信息正确');
  check((await page.textContent('#key-info')).includes('key-48000.wav'), '检测源为外部旁链');
  check((await page.textContent('#lookahead-info')).includes('L = 480'), '前瞻帧数显示正确');

  // 设置第一组 checks 参数（默认即该组），读取增益信息
  const gainInfo = await page.textContent('#gain-lane-info');
  console.log('  gain-lane-info:', gainInfo);

  const checks = JSON.parse(fs.readFileSync(path.join(DIR, 'checks.json'), 'utf8'));
  const kase = checks[0];

  // 导出 WAV：拦截下载，验证 24 位量化样值与 checks.json 一致
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-wav')
  ]);
  const wavPath = await download.path();
  const wavBuf = fs.readFileSync(wavPath);
  check(wavBuf.toString('ascii', 0, 4) === 'RIFF' && wavBuf.toString('ascii', 8, 12) === 'WAVE', '导出文件是 WAV');
  check(wavBuf.readUInt16LE(34) === 24, '导出为 24 位');
  check(wavBuf.readUInt32LE(24) === 48000, '导出采样率 48000');
  check(wavBuf.readUInt16LE(22) === 2, '导出双声道');
  const dataSize = wavBuf.readUInt32LE(40);
  check(dataSize === 57600 * 2 * 3, '导出帧数与主轨一致（前瞻未改变帧数）');

  // 对照 checks.json 的 unclipped 值（量化后误差 <= 2 LSB）
  function sampleAt(frame, ch) {
    const off = 44 + (frame * 2 + ch) * 3;
    let v = wavBuf[off] | (wavBuf[off + 1] << 8) | (wavBuf[off + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  }
  let maxErr = 0;
  for (const pt of kase.points) {
    for (let c = 0; c < 2; c++) {
      const got = sampleAt(pt.frame, c);
      // unclipped 是量化前浮点；导出值与之差应 <= 0.5 LSB 量化 + 2 LSB 容差
      const err = Math.abs(got - pt.unclipped[c]);
      if (err > maxErr) maxErr = err;
    }
  }
  check(maxErr <= 2.5 / 8388608, `导出样值与 checks.json 一致（最大误差 ${(maxErr * 8388608).toFixed(3)} LSB）`);

  // 导出 CSV
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-csv')
  ]);
  const csv = fs.readFileSync(await dl2.path(), 'utf8').trim().split('\n');
  check(csv[0] === 'frame,time_seconds,gain_db', 'CSV 表头正确');
  const step = Math.floor(48000 / 100);
  const expectRows = Math.ceil(57600 / step) + ((57600 - 1) % step !== 0 ? 1 : 0);
  check(csv.length - 1 === expectRows, `CSV 行数 ${csv.length - 1} == ${expectRows}`);
  check(csv[csv.length - 1].startsWith('57599,'), 'CSV 末行为 N-1');
  // CSV 中的 gain_db 与 checks.json 对照
  const row9600 = csv.find(l => l.startsWith('9600,'));
  check(row9600 && Math.abs(parseFloat(row9600.split(',')[2]) - (-7.773679257909426)) < 1e-9,
        'CSV gain_db 与 checks.json 一致: ' + row9600);

  // 削波场景：清除旁链，makeup=12，attack/release=0 → 左声道 480 个削波
  await page.click('#clear-key');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const set = (label, val) => {
      const rows = document.querySelectorAll('.param');
      for (const r of rows) {
        if (r.querySelector('label').textContent === label) {
          const num = r.querySelector('input[type=number]');
          num.value = val;
          num.dispatchEvent(new Event('change'));
          return;
        }
      }
    };
    set('启动 ms', 0); set('释放 ms', 0); set('补偿 dB', 12);
  });
  await page.waitForTimeout(400);
  const clipText = await page.textContent('#clip-report');
  check(/左声道\s*<span class="bad">480<\/span>|左声道.*480/.test(clipText.replace(/<[^>]+>/g, ' ')),
        '削波报告显示左声道 480: ' + clipText.replace(/<[^>]+>/g, ''));

  // 短旁链：不截短主轨
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.param');
    for (const r of rows) {
      const label = r.querySelector('label').textContent;
      const num = r.querySelector('input[type=number]');
      if (label === '补偿 dB') { num.value = 0; num.dispatchEvent(new Event('change')); }
      if (label === '启动 ms') { num.value = 5; num.dispatchEvent(new Event('change')); }
      if (label === '释放 ms') { num.value = 80; num.dispatchEvent(new Event('change')); }
    }
  });
  await page.setInputFiles('#key-file', path.join(DIR, 'key-short-48000.wav'));
  await page.waitForTimeout(400);
  check((await page.textContent('#key-info')).includes('短于主轨'), '短旁链提示补零');
  const [dl3] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-wav')
  ]);
  const wav3 = fs.readFileSync(await dl3.path());
  check(wav3.readUInt32LE(40) === 57600 * 2 * 3, '短旁链导出帧数仍为主轨 N');

  check(errors.length === 0, '页面无 JS 异常' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close();
  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n端到端全部通过');
})();
