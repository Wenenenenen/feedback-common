/*
 * 浏览器端到端验收（Playwright，无第三方测试框架）。
 * 运行：NODE_PATH=$(npm root -g) node tests/browser-verify.js
 * 环境若无 playwright：npm i -g playwright 或在本目录 npm i -D playwright。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('未找到 playwright，请设置 NODE_PATH=$(npm root -g) 或先安装。');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js', 'ccl-core.js'));
require(path.join(ROOT, 'js', 'wav-codec.js'));
const CCL = globalThis.CCL;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => window.__ccl && window.__ccl.snapshot().n === 19200, null, { timeout: 15000 });
  console.log('\n[B1] 内置案例自动载入');
  let snap = await page.evaluate(() => window.__ccl.snapshot());
  check('自动载入 loop，n=19200', snap.n === 19200, snap);
  check('默认 ceiling=16000/up=30/down=120', snap.settings.ceiling === 16000 && snap.settings.up === 30 && snap.settings.down === 120, snap.settings);
  check('首版可行曲线', snap.hasFeasibleCurve && snap.rev === 1);
  check('无页面错误', errors.length === 0, errors);

  await page.screenshot({ path: '/tmp/ccl-1-loaded.png', fullPage: false });

  console.log('\n[B2] 改 ceiling 并应用，峰值受约束');
  await page.fill('#input-ceiling', '12000');
  const t0 = Date.now();
  await page.click('#btn-apply');
  await page.waitForFunction((rev) => {
    const s = window.__ccl.snapshot();
    return s.rev >= rev && s.settings.ceiling === 12000;
  }, snap.rev + 1, { timeout: 15000 });
  const wallMs = Date.now() - t0;
  snap = await page.evaluate(() => window.__ccl.snapshot());
  const peaks = await page.evaluate(() => {
    const r = window.CCL.lastResult;
    return { l: r.outPeakL, r: r.outPeakR, ceil: r.ceiling, ms: window.__ccl.snapshot().timings.solveMs };
  });
  check('限幅后 L/R 峰值 <= 12000', peaks.l <= 12000 && peaks.r <= 12000, peaks);
  check('UI 墙钟（点击->可查）< 12s（小案例）', wallMs < 12000, { wallMs });
  console.log('   loop apply wall', wallMs, 'ms core', peaks.ms, 'ms');

  console.log('\n[B3] 锁冲突：列出冲突帧并保留上次曲线');
  const revBeforeConflict = snap.rev;
  // n=19200；0 锁 60000，5 锁 0，up=down=1 => 帧0最多 5
  const conflictSum = await page.evaluate(() => window.__ccl.applySettings({
    up: 1, down: 1, locks: [[0, 60000], [5, 0]],
  }));
  check('applySettings 返回 ok=false 与冲突', conflictSum.ok === false && conflictSum.conflicts.length >= 1, conflictSum);
  check('冲突包含帧 0（achievable=5）', conflictSum.conflicts.some((c) => c.frame === 0 && c.achievable === 5), conflictSum.conflicts);
  snap = await page.evaluate(() => window.__ccl.snapshot());
  check('snapshot 标记冲突面板可见', snap.conflictPanelVisible === true);
  check('可行曲线版本号未前进（保留上次）', snap.rev === revBeforeConflict, { rev: snap.rev, revBeforeConflict });
  const domItems = await page.$$eval('#conflict-list .conflict-item', (els) => els.map((e) => e.dataset.frame));
  check('DOM 冲突列表渲染帧 0', domItems.includes('0'), domItems);
  await page.screenshot({ path: '/tmp/ccl-2-conflict.png', fullPage: false });

  console.log('\n[B4] 改为兼容锁后恢复可行');
  // 先在 Node oracle 里取 ceiling=12000/up30/down120 基准曲线在两帧的真实增益，
  // 锁到这些值必然可行（最大曲线本身在这些点取该值）。
  const wav0 = CCL.WAV.decodeWav(fs.readFileSync(path.join(ROOT, 'samples', 'loop.wav')).buffer.slice(0));
  const base12k = CCL.processCycle(
    { left: wav0.channelData[0], right: wav0.channelData[1], length: wav0.frames },
    { ceiling: 12000, up: 30, down: 120, locks: [] }
  );
  const lock1 = base12k.gains[100], lock2 = base12k.gains[9000];
  const okSum = await page.evaluate(([a, b]) => window.__ccl.applySettings({
    up: 30, down: 120, locks: [[100, a], [9000, b]],
  }), [lock1, lock2]);
  check('兼容锁求解成功', okSum.ok === true, okSum);
  const lockVals = await page.evaluate(() => [window.__ccl.gainAt(100), window.__ccl.gainAt(9000)]);
  check('两个锁值精确命中', lockVals[0] === lock1 && lockVals[1] === lock2, { lockVals, lock1, lock2 });
  const lockRows = await page.$$eval('#lock-list [data-frame]', (els) => els.length);
  check('锁列表有 2 行', lockRows >= 2, { lockRows });

  console.log('\n[B5] 选区下载与 Node oracle 逐码一致');
  await page.fill('#sel-start', '137');
  await page.fill('#sel-end', '4099');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btn-download-sel'),
  ]);
  const dlPath = '/tmp/ccl-slice.wav';
  await download.saveAs(dlPath);
  const dl = CCL.WAV.decodeWav(fs.readFileSync(dlPath).buffer.slice(0));
  check('下载 WAV 为 192000/双声道/3962 帧',
    dl.sampleRate === 192000 && dl.channels === 2 && dl.frames === 3962,
    { rate: dl.sampleRate, ch: dl.channels, frames: dl.frames });

  // Node oracle：与页面相同设定（含两个基准值锁）重算
  const oracle = CCL.processCycle(
    { left: wav0.channelData[0], right: wav0.channelData[1], length: wav0.frames },
    { ceiling: 12000, up: 30, down: 120, locks: [[100, lock1], [9000, lock2]] }
  );
  let mism = 0;
  for (let i = 137; i < 4099; i++) {
    if (dl.channelData[0][i - 137] !== oracle.outL[i] || dl.channelData[1][i - 137] !== oracle.outR[i]) mism++;
  }
  check('下载切片与独立 oracle 逐码一致', mism === 0, { mism });

  // 整圈下载
  const [dlFull] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btn-download-full'),
  ]);
  const fullPath = '/tmp/ccl-full.wav';
  await dlFull.saveAs(fullPath);
  const full = CCL.WAV.decodeWav(fs.readFileSync(fullPath).buffer.slice(0));
  let fm = 0;
  for (let i = 0; i < oracle.n; i++) if (full.channelData[0][i] !== oracle.outL[i] || full.channelData[1][i] !== oracle.outR[i]) fm++;
  check('整圈下载 19200 帧且逐码一致', full.frames === 19200 && fm === 0, { frames: full.frames, fm });

  console.log('\n[B6] 通过文件输入导入 cyclic-ceiling-cases.zip');
  await page.setInputFiles('#file-input', path.join(ROOT, 'samples', 'cyclic-ceiling-cases.zip'));
  await page.waitForFunction(() => {
    const s = window.__ccl.snapshot();
    return s.n === 19200 && s.settings.ceiling === 16000 && s.rev >= 1;
  }, null, { timeout: 15000 });
  snap = await page.evaluate(() => window.__ccl.snapshot());
  check('ZIP 导入后应用 settings.json (16000/30/120)', snap.settings.ceiling === 16000 && snap.settings.up === 30 && snap.settings.down === 120, snap.settings);
  await page.screenshot({ path: '/tmp/ccl-3-zip.png' });

  console.log('\n[B6+] 播放中改设定：当前音频缓冲必须随可行曲线热替换');
  await page.evaluate(() => window.__ccl.applySettings({
    ceiling: 16000, up: 30, down: 120, locks: [],
  }));
  await page.click('#btn-play');
  await page.waitForFunction(() => /播放中/.test(document.querySelector('#play-state').textContent), null, { timeout: 5000 });
  const beforeLive = await page.evaluate(() => {
    const src = window.__ccl.state.srcNode;
    const d = src.buffer.getChannelData(0);
    let max = 0;
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
    return { sampleRate: src.buffer.sampleRate, length: src.buffer.length, max };
  });
  check('热替换前确实在播放非零限幅缓冲', beforeLive.sampleRate === 192000 && beforeLive.length === 19200 && beforeLive.max > 0.01, beforeLive);

  await page.evaluate(() => window.__ccl.applySettings({ ceiling: 0 }));
  await page.waitForFunction(() => {
    const src = window.__ccl.state.srcNode;
    if (!src || !src.buffer || src.buffer.sampleRate !== 192000 || src.buffer.length !== 19200) return false;
    for (let ch = 0; ch < 2; ch++) {
      const d = src.buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
    }
    return true;
  }, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const level = window.__ccl.playbackLevel();
    return level.active && level.peak === 0 && level.rms === 0;
  }, null, { timeout: 5000 });
  check('ceiling=0 后正在播放的缓冲立即变成全零（不再循环旧声音）', true);

  const revBeforePlaybackConflict = await page.evaluate(() => window.__ccl.snapshot().rev);
  await page.evaluate(() => { window.__retainedBuffer = window.__ccl.state.srcNode.buffer; });
  const liveConflict = await page.evaluate(() => window.__ccl.applySettings({
    up: 1, down: 1, locks: [[0, 60000], [5, 0]],
  }));
  const retained = await page.evaluate((rev) => ({
    conflict: window.__ccl.snapshot().conflicts.length > 0,
    sameBuffer: window.__ccl.state.srcNode && window.__ccl.state.srcNode.buffer === window.__retainedBuffer,
    sameRev: window.__ccl.snapshot().rev === rev,
  }), revBeforePlaybackConflict);
  check('播放中遇锁冲突：列出冲突且继续保留上次可行缓冲/曲线',
    liveConflict.ok === false && retained.conflict && retained.sameBuffer && retained.sameRev,
    { liveConflict, retained });
  await page.click('#btn-stop');
  await page.evaluate(() => window.__ccl.applySettings({
    ceiling: 16000, up: 30, down: 120, locks: [],
  }));

  console.log('\n[B6++] 新素材首次求解冲突时不得残留上一份素材的统计');
  await page.evaluate(() => window.__ccl.applySettings({
    up: 1, down: 1, locks: [[0, 60000], [5, 0]],
  }));
  await page.click('#btn-play');
  await page.waitForFunction(() => /播放中/.test(document.querySelector('#play-state').textContent), null, { timeout: 5000 });
  const firstConflictWav = path.join(os.tmpdir(), 'ccl-first-conflict.wav');
  {
    const N = 64;
    const L = new Int16Array(N), R = new Int16Array(N);
    for (let i = 0; i < N; i++) { L[i] = (i * 97) % 1000 - 500; R[i] = (i * 53) % 1000 - 500; }
    fs.writeFileSync(firstConflictWav, Buffer.from(CCL.WAV.encodeWav16([L, R], 48000)));
  }
  await page.setInputFiles('#file-input', firstConflictWav);
  await page.waitForFunction(() => {
    const s = window.__ccl.snapshot();
    return s.N === 64 && s.n === 256 && s.conflictPanelVisible && !s.hasFeasibleCurve;
  }, null, { timeout: 10000 });
  const importStop = await page.evaluate(() => ({
    active: !!window.__ccl.state.srcNode,
    text: document.querySelector('#play-state').textContent,
  }));
  check('播放中导入新素材会停止旧素材节点', importStop.active === false && /已停止/.test(importStop.text), importStop);
  const freshStats = await page.evaluate(() => ({
    length: document.querySelector('#stat-length').textContent,
    outL: document.querySelector('#peak-out-l').textContent,
    outR: document.querySelector('#peak-out-r').textContent,
    meta: document.querySelector('#source-meta').textContent,
  }));
  check('统计条切换到新 64→256 帧素材', /64→256/.test(freshStats.length), freshStats);
  check('限幅后峰值不残留旧素材 11142/16000',
    !freshStats.length.includes('19,200') && freshStats.outL.includes('无可行锁') && freshStats.outR.includes('无可行锁'),
    freshStats);
  await page.evaluate(() => window.__ccl.applySettings({ up: 30, down: 120, locks: [] }));

  console.log('\n[B7] 60s 满长素材性能（UI 真实路径）');
  const longPath = path.join(os.tmpdir(), 'ccl-long60.wav');
  if (!fs.existsSync(longPath)) {
    const N = 60 * 48000;
    const L = new Int16Array(N), R = new Int16Array(N);
    let seed = 42;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < N; i++) {
      const t = i / 48000;
      L[i] = Math.max(-32768, Math.min(32767, 11000 * Math.sin(2 * Math.PI * 110 * t) + 8000 * Math.sin(2 * Math.PI * 1320 * t) + ((rnd() * 3000) | 0) - 1500));
      R[i] = Math.max(-32768, Math.min(32767, 12000 * Math.sin(2 * Math.PI * 110.4 * t + .5) + 7000 * Math.sin(2 * Math.PI * 1760 * t) + ((rnd() * 3000) | 0) - 1500));
    }
    const bytes = CCL.WAV.encodeWav16([L, R], 48000);
    fs.writeFileSync(longPath, Buffer.from(bytes));
  }
  await page.setInputFiles('#file-input', longPath);
  await page.waitForFunction(() => window.__ccl.snapshot().n === 11520000, null, { timeout: 60000 });
  check('60s 素材载入 n=11,520,000', true);
  // 改一个限幅设定并提交
  await page.fill('#input-ceiling', '9000');
  const perf = await page.evaluate(async () => {
    const t = performance.now();
    const sum = window.__ccl.applySettings({ ceiling: 9000, up: 25, down: 180 });
    // applySettings 同步完成；再等一帧确保绘制提交
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { wall: performance.now() - t, sum, snap: window.__ccl.snapshot() };
  });
  check('60s 设定修改成功', perf.sum.ok === true, perf.sum.conflicts);
  check('提交 -> 曲线可查（含两帧绘制）< 12000ms', perf.wall < 12000, { wall: Math.round(perf.wall) });
  console.log('   browser 60s apply wall', Math.round(perf.wall), 'ms; core', perf.snap.timings.solveMs, 'ms');
  const bigPeaks = await page.evaluate(() => ({ l: CCL.lastResult.outPeakL, r: CCL.lastResult.outPeakR }));
  check('60s 输出峰值 <= 9000', bigPeaks.l <= 9000 && bigPeaks.r <= 9000, bigPeaks);
  await page.screenshot({ path: '/tmp/ccl-4-long60.png' });

  console.log('\n[B8] 试听控件可启动/停止');
  let audioOk = true;
  try {
    await page.click('#btn-play');
    await page.waitForTimeout(600);
    const stateTxt = await page.textContent('#play-state');
    audioOk = /播放中/.test(stateTxt);
    await page.click('#btn-stop');
  } catch (e) { audioOk = false; }
  check('播放 -> 状态文本变化 -> 停止', audioOk);

  console.log('\n[B9] 指针框选 / 表单锁 / 曲线单击锁');
  // 在 after 波形上从 20% 拖到 45%
  const box = await page.locator('#wave-after').boundingBox();
  await page.mouse.move(box.x + box.width * 0.20, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  let sel = await page.evaluate(() => {
    const s = window.__ccl.snapshot();
    return { selection: s.selection, n: s.n };
  });
  check('拖动产生选区且 0<start<end<n',
    sel.selection.start > 0 && sel.selection.end > sel.selection.start && sel.selection.end < sel.n, sel);
  const startVal = await page.inputValue('#sel-start');
  check('选区起点同步到数字输入框', Number(startVal) === sel.selection.start, { startVal, sel: sel.selection });

  // 表单精确加锁：锁到该帧当前增益，必然可行
  const g500 = await page.evaluate(() => window.__ccl.gainAt(500));
  await page.fill('#lock-frame', '500');
  await page.fill('#lock-gain', String(g500));
  await page.click('#btn-add-lock');
  await page.waitForSelector('[data-testid="lock-gain-row-500"]', { timeout: 5000 });
  const lockOk = await page.evaluate(() => {
    const s = window.__ccl.snapshot();
    return s.rev >= 1 && s.locks.some((l) => l.frame === 500 && l.gain === window.__ccl.gainAt(500));
  });
  check('表单加锁后曲线仍可行且命中', lockOk);

  // 在增益曲线 70% 处单击，应新增一个锁
  const gbox = await page.locator('#gain-canvas').boundingBox();
  const locksBefore = (await page.evaluate(() => window.__ccl.snapshot().locks.length));
  await page.mouse.click(gbox.x + gbox.width * 0.7, gbox.y + gbox.height * 0.55);
  await page.waitForTimeout(150);
  const locksAfter = await page.evaluate(() => window.__ccl.snapshot().locks.length);
  check('增益图单击新增锁', locksAfter === locksBefore + 1, { locksBefore, locksAfter });

  console.log('\n[B10] 收尾错误检查');
  check('file:// 下全程无未捕获页面错误', errors.length === 0, errors.slice(0, 5));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));

  await browser.close();
  console.log(`\n==== browser: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
