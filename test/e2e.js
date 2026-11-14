/* 端到端测试：NODE_PATH=$(npm root -g) node test/e2e.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const DSP = require('../dsp.js');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(__dirname, '.samples');
if (!fs.existsSync(path.join(SAMPLES, 'cases.json'))) {
  fs.mkdirSync(SAMPLES, { recursive: true });
  require('child_process').execSync(
    `unzip -o "${path.join(ROOT, 'samples', 'spectral-patches.zip')}" -d "${SAMPLES}"`);
}
const PORT = 8931;
let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.error('  ✗ ' + msg); }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

function loadWav(name) {
  const b = fs.readFileSync(path.join(SAMPLES, name));
  return DSP.decodeWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('dialog', d => d.dismiss());
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  console.log('E1. 页面加载与导入');
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.setInputFiles('#fileWav', path.join(SAMPLES, 'stereo-48k.wav'));
  await page.waitForFunction(() => state && state.audio && state.audio.frames === 288137);
  ok(true, 'stereo-48k.wav 导入成功 (288137 帧)');
  await page.waitForFunction(() => state.spec && state.spec.partial === state.spec.cols, null, { timeout: 30000 });
  ok(true, '频谱图计算完成');

  console.log('E2. 拖拽创建选框');
  const box = await page.locator('#specCanvas').boundingBox();
  const dur = 288137 / 48000, nyq = 24000;
  const px = t => box.x + (t / dur) * box.width;
  const py = f => box.y + (1 - f / nyq) * box.height;
  await page.mouse.move(px(1.0), py(1150));
  await page.mouse.down();
  await page.mouse.move(px(4.0), py(850), { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => state.boxes.length === 1);
  const b0 = await page.evaluate(() => state.boxes[0]);
  ok(Math.abs(b0.start - 1) < 0.05 && Math.abs(b0.end - 4) < 0.05, `时间范围 ≈1–4s (${b0.start.toFixed(2)}–${b0.end.toFixed(2)})`);
  ok(Math.abs(b0.low - 850) < 100 && Math.abs(b0.high - 1150) < 100, `频率范围 ≈850–1150Hz (${Math.round(b0.low)}–${Math.round(b0.high)})`);
  ok(b0.channels.length === 2, '双声道默认全选');

  console.log('E2b. 移动与缩放选框');
  // 框内拖动 → 移动（尺寸不变）
  const cx = px((b0.start + b0.end) / 2), cy = py((b0.low + b0.high) / 2);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + px(0.5) - px(0), cy + py(1000) - py(0), { steps: 5 });
  await page.mouse.up();
  let b1 = await page.evaluate(() => state.boxes[0]);
  ok(Math.abs((b1.end - b1.start) - (b0.end - b0.start)) < 0.01 &&
     Math.abs((b1.high - b1.low) - (b0.high - b0.low)) < 5, '移动后尺寸不变');
  ok(Math.abs(b1.start - (b0.start + 0.5)) < 0.05 && Math.abs(b1.high - (b0.high + 1000)) < 60,
     `移动量正确 (Δt=${(b1.start - b0.start).toFixed(2)}s, Δf=${Math.round(b1.high - b0.high)}Hz)`);
  // 拖右下角 → 只改变 end 和 low
  const bx = await page.locator('#specCanvas').boundingBox();
  const px2 = t => bx.x + (t / dur) * bx.width;
  const py2 = f => bx.y + (1 - f / nyq) * bx.height;
  await page.mouse.move(px2(b1.end) - 1, py2(b1.low) - 1);
  await page.mouse.down();
  await page.mouse.move(px2(b1.end + 0.4), py2(Math.max(0, b1.low - 300)), { steps: 5 });
  await page.mouse.up();
  const b2 = await page.evaluate(() => state.boxes[0]);
  ok(Math.abs(b2.start - b1.start) < 0.01 && Math.abs(b2.high - b1.high) < 5, '右下角缩放不影响 start/high');
  ok(Math.abs(b2.end - (b1.end + 0.4)) < 0.06 && b2.low < b1.low - 200, '右下角缩放量正确');
  // 还原为测试用框并继续
  await page.evaluate(() => {
    Object.assign(state.boxes[0], { start: 1, end: 4, low: 850, high: 1150, attenDb: 24 });
    commit(); scheduleProcess();
  });

  console.log('E3. 自动处理与导出');
  await page.waitForFunction(() => !state.dirty && state.processedInts, null, { timeout: 60000 });
  ok(true, '自动处理完成');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExport'),
  ]);
  const outPath = '/tmp/e2e-export.wav';
  await dl.saveAs(outPath);
  const src = loadWav('stereo-48k.wav');
  const out = DSP.decodeWav(fs.readFileSync(outPath).buffer);
  ok(out.sampleRate === 48000 && out.channels === 2 && out.bitsPerSample === 16, '导出参数一致 (48k/立体声/16bit)');
  ok(out.frames === src.frames, `导出帧数一致 (${out.frames})`);
  // 框外逐位一致（前 0.5s 与最后 1s）
  let exact = true;
  for (let c = 0; c < 2 && exact; c++)
    for (let i = 0; i < 0.5 * 48000; i++)
      if (out.ints[c][i] !== src.ints[c][i]) { exact = false; break; }
  for (let c = 0; c < 2 && exact; c++)
    for (let i = 5 * 48000; i < src.frames; i++)
      if (out.ints[c][i] !== src.ints[c][i]) { exact = false; break; }
  ok(exact, '选框区域外采样逐位不变');
  // 框内哨音被衰减
  function toneAmp(floats, from, to, freq) {
    let cr = 0, ci = 0;
    const i0 = Math.round(from * 48000), i1 = Math.round(to * 48000);
    for (let i = i0; i < i1; i++) {
      const ph = 2 * Math.PI * freq * i / 48000;
      cr += floats[i] * Math.cos(ph); ci -= floats[i] * Math.sin(ph);
    }
    return 2 * Math.hypot(cr, ci) / (i1 - i0);
  }
  const outFloats = out.ints[0].map ? null : null;
  const of = new Float64Array(out.frames);
  for (let i = 0; i < out.frames; i++) of[i] = out.ints[0][i] / 32768;
  const sf = new Float64Array(src.frames);
  for (let i = 0; i < src.frames; i++) sf[i] = src.ints[0][i] / 32768;
  const before = toneAmp(sf, 2, 3, 1000), after = toneAmp(of, 2, 3, 1000);
  const att = 20 * Math.log10(after / before);
  ok(att < -18, `框内 1kHz 哨音衰减 ${att.toFixed(1)}dB (期望 ≈-24)`);

  console.log('E4. 对照试听按钮');
  await page.click('#btnPlayOrig');
  await page.waitForTimeout(300);
  await page.click('#btnStop');
  await page.click('#btnPlayProc');
  await page.waitForTimeout(300);
  await page.click('#btnStop');
  ok(true, '原音/处理后播放无异常');

  console.log('E5. 撤销/重做');
  for (let i = 0; i < 12; i++) { // 撤销所有编辑历史
    if (await page.evaluate(() => state.boxes.length === 0)) break;
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => state.boxes.length === 0);
  ok(true, '撤销删除选框');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => state.boxes.length === 1);
  ok(true, '重做恢复选框');
  await page.evaluate(() => { // 恢复测试框
    Object.assign(state.boxes[0], { start: 1, end: 4, low: 850, high: 1150, attenDb: 24, enabled: true });
    commit(); scheduleProcess();
  });

  console.log('E6. 停用全部选框 → 导出还原原音');
  await page.evaluate(() => { state.boxes[0].enabled = false; });
  await page.evaluate(() => { scheduleProcess(); });
  await page.waitForFunction(() => !state.dirty, null, { timeout: 30000 });
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExport'),
  ]);
  const outPath2 = '/tmp/e2e-export-passthrough.wav';
  await dl2.saveAs(outPath2);
  const out2 = DSP.decodeWav(fs.readFileSync(outPath2).buffer);
  let allSame = out2.frames === src.frames;
  if (allSame) for (let c = 0; c < 2 && allSame; c++)
    for (let i = 0; i < src.frames; i++)
      if (out2.ints[c][i] !== src.ints[c][i]) { allSame = false; break; }
  ok(allSame, '全部停用时导出与原音逐位一致');

  console.log('E7. 工程保存与恢复');
  await page.evaluate(() => { state.boxes[0].enabled = true; });
  await page.evaluate(() => { commit(); scheduleProcess(); });
  const [dlProj] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnSaveProj'),
  ]);
  const projPath = '/tmp/e2e-project.json';
  await dlProj.saveAs(projPath);
  ok(fs.existsSync(projPath), '工程文件已保存');
  // 重新加载页面 → 导入同一音频 → 载入工程
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.setInputFiles('#fileWav', path.join(SAMPLES, 'stereo-48k.wav'));
  await page.waitForFunction(() => state && state.audio);
  await page.setInputFiles('#fileProj', projPath);
  await page.waitForFunction(() => state.boxes.length === 1);
  const rb = await page.evaluate(() => state.boxes[0]);
  ok(Math.abs(rb.start - 1) < 0.01 && Math.abs(rb.end - 4) < 0.01 &&
     Math.abs(rb.low - 850) < 1 && Math.abs(rb.high - 1150) < 1 && rb.attenDb === 24,
    '重新选择同一源音频后选框与参数恢复');

  console.log('E8. 拒绝非法文件');
  await page.setInputFiles('#fileWav', projPath); // 非 WAV
  await page.waitForTimeout(300);
  const stillOne = await page.evaluate(() => state.audio.fileName);
  ok(stillOne === 'stereo-48k.wav', '非 WAV 文件被拒绝且不影响当前音频');

  ok(errors.length === 0, `无页面 JS 错误${errors.length ? '：' + errors.join('; ') : ''}`);

  await browser.close();
  server.close();
  console.log(failures === 0 ? '\nE2E 全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
