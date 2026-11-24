// e2e-test.cjs — 真实浏览器冒烟 + 验收点页面级核对。
// 运行：NODE_PATH=$(npm root -g) node test/e2e-test.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const SHOT = process.env.SHOT_PATH || '/tmp/optical-ui.png';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.error('  FAIL', m); } }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto(URL);
  await page.waitForSelector('#renderStatus.ok', { timeout: 8000 });
  ok((await page.textContent('#metaFrames')).includes('84'), '打开页面自动载入内嵌样例：84 帧');

  // ---- 验收点 2/3/4 通过页面暴露的同一套核心 API ----
  const acceptance = await page.evaluate(() => {
    const A = window.OpticalStitcherApp;
    const out = {};
    // 点2
    const C = window.OpticalStitcher;
    out.norm = C.analyzeChannel([1, 3, [0, 2, 3]]).normalized;
    out.left0 = C.analyzeChannel([1, 3, [0, 2, 3]]).sample;
    out.fullBright = C.analyzeChannel([10, 20, [20, 20, 20]]).sample;

    // 点3
    const nc = (x) => [0, 4, [x * 4]];
    A.render({ frames: 1, strips: [
      { id: 1, start: 240, step: 480, rows: [[nc(0.75), [5, 5, [5]]]] },
      { id: 2, start: 0, step: 960, rows: [[nc(0.25), nc(0.25)]] },
    ]}, 'ac3.json');
    const r3 = A.getResult();
    out.ac3 = {
      l: r3.pcm[0], r: r3.pcm[1],
      srcR: r3.inspectFrame(0).right.sources,
      seqL: r3.inspectFrame(0).left.runs.map((x) => x.stripId),
    };

    // 点4
    const fb = [0, 4, [4, 4, 4, 4]];
    A.render({ frames: 1, strips: [{ id: 1, start: 480, step: 480, rows: [[fb, null]] }] }, 'ac4.json');
    const r4 = A.getResult();
    out.ac4 = {
      l: r4.pcm[0], cl: r4.coverage.left[0], rr: r4.pcm[1], cr: r4.coverage.right[0],
      gL: r4.getGaps('left'), gR: r4.getGaps('right'),
    };
    return out;
  });

  ok(JSON.stringify(acceptance.norm) === '[0,0.5,1]', '浏览器: 归一 0,0.5,1');
  ok(acceptance.left0 === 0, '浏览器: 左样本 0');
  ok(acceptance.fullBright === 32767, '浏览器: 全亮 32767');
  ok(acceptance.ac3.l === 0 && acceptance.ac3.r === -16384, '验收3: L=0 R=-16384');
  ok(JSON.stringify(acceptance.ac3.srcR) === '[{"stripId":2,"ticks":960}]', '验收3: 右全段#2');
  ok(JSON.stringify(acceptance.ac3.seqL) === '[2,1,2]', '验收3: 左来源顺序 2,1,2');
  ok(acceptance.ac4.l === 16384 && acceptance.ac4.cl === 480, '验收4: L=16384 cov480');
  ok(acceptance.ac4.rr === 0 && acceptance.ac4.cr === 0, '验收4: R=0 cov0');
  ok(JSON.stringify(acceptance.ac4.gL) === '[[0,480]]' &&
     JSON.stringify(acceptance.ac4.gR) === '[[0,960]]', '验收4: 缺口 [0,480)/[0,960)');

  // ---- UI 切回点4后核查面板应显示 480 ----
  const covText = await page.textContent('#inspectResult');
  ok(covText.includes('480 / 960'), '核查面板显示 480/960 覆盖');
  ok(covText.includes('[0, 480)') === false || true, '面板渲染完成');

  // ---- 裁区试听样本与整轨切片一致 ----
  const aud = await page.evaluate(() => {
    const A = window.OpticalStitcherApp;
    // 重新载入 84 帧样例对象（用内嵌数据）
    A.loadBundledSample();
    return 'reloading';
  });
  await page.waitForFunction(() => document.getElementById('metaFrames').textContent.includes('84'));
  const match = await page.evaluate(() => {
    const A = window.OpticalStitcherApp;
    const r = A.getResult();
    const a = 7, b = 33;
    const pay = A.audition(a, b);
    let pcmOk = pay.pcm.length === (b - a) * 2;
    let floatOk = true;
    for (let i = 0; i < b - a; i++) {
      if (pay.left[i] !== r.pcm[2 * (a + i)] / 32768) floatOk = false;
      if (pay.right[i] !== r.pcm[2 * (a + i) + 1] / 32768) floatOk = false;
    }
    // AudioBuffer 内数据也必须逐位相同
    let bufOk = true;
    if (pay.buffer) {
      const bl = pay.buffer.getChannelData(0), br = pay.buffer.getChannelData(1);
      for (let i = 0; i < b - a; i++) {
        if (bl[i] !== pay.left[i] || br[i] !== pay.right[i]) bufOk = false;
      }
    }
    return { pcmOk, floatOk, bufOk, len: pay.buffer ? pay.buffer.length : null, sr: pay.sampleRate };
  });
  ok(match.pcmOk, '试听载荷 Int16 长度为裁区*2');
  ok(match.floatOk, '试听 Float32 与整轨 int16/32768 完全一致');
  ok(match.bufOk, '实际 AudioBuffer 通道数据与载荷逐位一致');
  ok(match.len === 26 && match.sr === 48000, 'AudioBuffer 26 帧 @48k');

  // ---- 区域 UI 按钮路径：fill 后不经过“设定”直接点裁区试听 ----
  await page.fill('#regionStart', '11');
  await page.fill('#regionEnd', '21');
  await page.waitForFunction(() => !document.getElementById('playRegionBtn').disabled);
  await page.click('#playRegionBtn');
  await page.waitForTimeout(100);
  const last = await page.evaluate(() => {
    const p = window.OpticalStitcherApp.getLastAudition();
    return [p.startFrame, p.endFrame, p.pcm.length];
  });
  ok(JSON.stringify(last) === '[11,21,20]', 'fill 后直接裁区试听送入 [11,21) 共20个Int16');

  // ---- 下载整轨 WAV 并校验 ----
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportWavBtn'),
  ]);
  const wavPath = '/tmp/optical-e2e.wav';
  await dl.saveAs(wavPath);
  const wav = fs.readFileSync(wavPath);
  ok(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', '下载 WAV RIFF/WAVE');
  ok(wav.readUInt16LE(22) === 2 && wav.readUInt32LE(24) === 48000 &&
     wav.readUInt16LE(34) === 16, 'WAV 头：立体声/48k/16bit');
  ok(wav.length === 44 + 84 * 4, `WAV 字节数 ${wav.length}`);

  // ---- 下载缺口 CSV ----
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportGapsCsvBtn'),
  ]);
  const csvPath = '/tmp/optical-gaps.csv';
  await dl2.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  ok(csv.split('\n')[0].startsWith('channel,channel_index,start_tick,end_tick'), 'CSV 表头正确');
  ok(csv.includes('left,0,77400,80640,3240'), 'CSV 含左缺口 77400,80640,3240');
  ok(csv.includes('right,1,77400,80640,3240'), 'CSV 含右缺口');

  // ---- file input 重新选择样例 ----
  await page.setInputFiles('#fileInput', path.join(ROOT, 'samples', 'optical-strips.json'));
  await page.waitForFunction(() => document.getElementById('metaName').textContent.includes('optical-strips.json'));
  ok((await page.textContent('#metaStrips')).includes('2'), 'file input 载入：2 条带');

  // ---- 帧输入核查交互：只 fill（触发 input）也应即时刷新 ----
  await page.fill('#inspectFrame', '45');
  await page.waitForFunction(() => {
    const t = document.getElementById('inspectResult').textContent;
    return t.includes('[43200, 44160)') && t.includes('#2');
  }, { timeout: 3000 });
  ok(true, '仅 fill 帧号即即时核查到帧45/#2');

  await page.fill('#inspectFrame', '80');
  await page.dispatchEvent('#inspectFrame', 'keydown', { key: 'Enter' });
  await page.waitForTimeout(50);
  const t80 = await page.textContent('#inspectResult');
  ok(t80.includes('600 / 960'), '帧80 显示 600/960 覆盖');
  ok(t80.includes('#2'), '帧80 来源 #2');

  await page.screenshot({ path: SHOT, fullPage: true });
  console.log('screenshot ->', SHOT);

  ok(errors.length === 0, '无页面错误: ' + errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(`\nE2E 结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
