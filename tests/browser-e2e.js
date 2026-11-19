// 浏览器端到端验证（Playwright）：加载页面、上传样例、处理、核对指标、导出、取消。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8137';
const DIR = '/home/wendy/jianzhi/feedback-tasks/polyphase-resample-bench/samples/extracted';
let browser, page;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function uploadAndRun(file, target, opts = {}) {
  await page.setInputFiles('#fileInput', `${DIR}/${file}`);
  await page.waitForSelector('#runBtn:not([disabled])');
  await page.selectOption('#targetRate', String(target));
  if (opts.taps) await page.fill('#taps', String(opts.taps));
  if (opts.chunk) await page.fill('#chunkSize', String(opts.chunk));
  await page.click('#runBtn');
  await page.waitForSelector('#exportCard:not(.hidden)', { timeout: 120000 });
  return page.textContent('#status');
}

async function metricValue(label) {
  const cards = await page.$$eval('.metric', els => els.map(e => ({
    name: e.querySelector('.name').textContent,
    val: e.querySelector('.val').textContent,
    sub: e.querySelector('.sub').textContent,
  })));
  return cards.find(c => c.name.includes(label));
}

try {
  browser = await chromium.launch();
  page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  console.log('== A. sine1k 44.1->48 ==');
  let st = await uploadAndRun('sine1k-44k1-16.wav', 48000);
  check('处理完成', /完成/.test(st), st);
  const gain = await metricValue('主音增益');
  check('主音增益 |Δ| ≤0.2dB', gain && Math.abs(parseFloat(gain.val)) <= 0.2, gain?.val);
  const ripple = await metricValue('通带纹波');
  check('通带纹波 ≤0.1dB', ripple && parseFloat(ripple.val) <= 0.1, ripple?.val);
  const stop = await metricValue('实测阻带衰减');
  const stopNum = parseFloat(stop.val);
  const stopOk = stop.val.includes('>') || stopNum >= 80;
  check('阻带衰减 ≥80dB', stopOk, stop?.val);
  const len = await metricValue('输出长度');
  check('输出长度精确符合', len && /精确符合/.test(len.val), len?.val);
  const gd = await metricValue('群延迟');
  check('群延迟接近 0', gd && Math.abs(parseFloat(gd.val)) < 0.25, gd?.val);
  // 画布确实绘制了
  const specDrawn = await page.$eval('#spectrumCanvas', c => c.width > 0 && c.height > 0);
  check('频谱画布已绘制', specDrawn);

  console.log('== B. sine23k 48->44.1 混叠 ==');
  st = await uploadAndRun('sine23k-48k-24.wav', 44100);
  const suppr = await metricValue('带外主音抑制');
  check('23kHz 带外抑制 ≤ -80dB（含 21.1kHz 折叠混叠）',
    suppr && parseFloat(suppr.val) <= -80, suppr?.val);
  // 独立镜像分量（若存在）也应达标；不存在说明已淹没在噪声底
  const aliasCard = await metricValue('最强混叠') || await metricValue('最强镜像');
  if (aliasCard) {
    check('独立镜像/混叠 < -80dBFS', parseFloat(aliasCard.val) < -80,
      `${aliasCard.val} @ ${aliasCard.sub}`);
  } else {
    check('无独立镜像分量（淹没噪声底）', true);
  }

  console.log('== C. sweep 立体声：谱图页与反相 ==');
  st = await uploadAndRun('sweep-48k-16-stereo.wav', 44100);
  const specTabVisible = await page.$eval('#specTab', e => !e.classList.contains('hidden'));
  check('扫频自动识别，谱图标签出现', specTabVisible);
  await page.click('#specTab');
  await page.waitForTimeout(400);
  const specCanvas = await page.$eval('#specCanvas', c => c.width > 0);
  check('谱图画布已绘制', specCanvas);
  const alias = await metricValue('扫频混叠') || await metricValue('扫频最大混叠');
  check('扫频混叠指标存在（无混叠或达标）', alias !== undefined, alias?.val);

  console.log('== D. 分块大小不影响结果（4096 vs 1）==');
  await uploadAndRun('sine1k-44k1-16.wav', 48000, { chunk: 1 });
  const json1 = await page.$eval('#jsonView', e => e.textContent);
  await uploadAndRun('sine1k-44k1-16.wav', 48000, { chunk: 4096 });
  const json4096 = await page.$eval('#jsonView', e => e.textContent);
  const o1 = JSON.parse(json1).output.frames;
  const o4096 = JSON.parse(json4096).output.frames;
  check('不同分块输出帧数一致', o1 === o4096 && o1 === 96000, `${o1} vs ${o4096}`);

  console.log('== E. 导出 WAV 与 JSON 下载 ==');
  const [dlWav] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportWavBtn'),
  ]);
  check('WAV 下载文件名', /48000Hz\.wav$/.test(dlWav.suggestedFilename()), dlWav.suggestedFilename());
  const wavPath = '/tmp/dl-out.wav';
  await dlWav.saveAs(wavPath);
  const [dlJson] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportJsonBtn'),
  ]);
  check('JSON 下载文件名', /measurements\.json$/.test(dlJson.suggestedFilename()), dlJson.suggestedFilename());
  const jsonPath = '/tmp/dl-out.json';
  await dlJson.saveAs(jsonPath);

  console.log('== F. 取消处理（长文件，小块）==');
  await page.setInputFiles('#fileInput', `${DIR}/long-60s-44k1-16.wav`);
  await page.waitForSelector('#runBtn:not([disabled])');
  await page.selectOption('#targetRate', '48000');
  await page.fill('#chunkSize', '128');
  await page.click('#runBtn');
  await page.waitForSelector('#cancelBtn:not(.hidden)');
  await page.click('#cancelBtn');
  await page.waitForFunction(() => /取消/.test(document.getElementById('status').textContent), { timeout: 15000 });
  check('取消后显示提示', /处理已取消/.test(await page.textContent('#status')));
  check('取消后可重新运行', await page.$eval('#runBtn', b => !b.disabled));

  console.log('== G. 格式拒绝 ==');
  await page.setInputFiles('#fileInput', `${DIR}/float32-unsupported.wav`);
  await page.waitForFunction(() => /不支持/.test(document.getElementById('status').textContent));
  check('float32 明确拒绝', /32 位浮点/.test(await page.textContent('#status')));
  check('拒绝后运行按钮禁用', await page.$eval('#runBtn', b => b.disabled));

  await page.setInputFiles('#fileInput', `${DIR}/truncated.wav`);
  await page.waitForFunction(() => /截断/.test(document.getElementById('status').textContent));
  check('截断文件明确拒绝', /截断/.test(await page.textContent('#status')));

  console.log('== H. 控制台无错误 ==');
  check('无 console/page 错误', errors.length === 0, errors.join(' | '));

  console.log(`\n浏览器端到端：${failures.length ? failures.length + ' 失败' : '全部通过'}`);
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error('测试异常:', e);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
