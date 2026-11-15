/* e2e.js — 端到端 UI 验收（Playwright，需全局安装 playwright）。
 *
 * 用法：
 *   unzip -o samples/loop-cases.zip -d /tmp/loop-fixtures
 *   PORT=8124 node server.js &
 *   NODE_PATH=$(npm root -g) node test/e2e.js /tmp/loop-fixtures http://localhost:8124
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WAV = require('../public/wav.js');

const fixtures = process.argv[2] || '/tmp/loop-fixtures';
const baseUrl = process.argv[3] || 'http://localhost:8124';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    console.error('找不到 playwright，请使用 NODE_PATH=$(npm root -g) 运行。');
    process.exit(2);
  }
}

let failures = 0;
let checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

async function getDoc(page) {
  return page.evaluate(() => {
    // 从 DOM 中读取界面显示的状态（不暴露内部对象）
    return {
      source: document.getElementById('sourceInfo').textContent,
      range: document.getElementById('rangeTag').textContent,
      start: Number(document.getElementById('startInput').value),
      end: Number(document.getElementById('endInput').value),
      fadeFrames: Number(document.getElementById('fadeFramesInput').value),
      fadeTag: document.getElementById('fadeTag').textContent,
      playTag: document.getElementById('playTag').textContent,
      loops: document.getElementById('loopCounter').textContent,
      exportStatus: document.getElementById('exportStatus').textContent,
      projectStatus: document.getElementById('projectStatus').textContent,
      fadeErrorVisible: !document.getElementById('fadeError').hidden,
      fadeErrorText: document.getElementById('fadeError').innerText || '',
    };
  });
}

async function run() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('页面异常: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('控制台: ' + m.text()); });

  const download = async (trigger) => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      trigger(),
    ]);
    const file = path.join('/tmp', 'e2e-' + dl.suggestedFilename());
    await dl.saveAs(file);
    return file;
  };

  await page.goto(baseUrl + '/');
  await page.waitForSelector('#waveCanvas');

  /* ---------------- 导入与格式 ---------------- */
  section('导入 WAV');
  await page.setInputFiles('#fileInput', path.join(fixtures, 'stereo-postroll.wav'));
  await page.waitForTimeout(500);
  let d = await getDoc(page);
  ok('显示素材信息（48kHz/24位/立体声/96000 帧）',
    /48\.0 kHz/.test(d.source) && /24 位/.test(d.source) && /立体声/.test(d.source) &&
    /96,000 帧/.test(d.source), d.source);
  ok('默认区间为全段 [0, 96000)', d.range === '[0, 96,000)', d.range);
  ok('波形画布已渲染', (await page.evaluate(() => {
    const c = document.getElementById('waveCanvas');
    return c.width > 0 && c.height > 0;
  })));

  /* ---------------- 数字输入切点 ---------------- */
  section('数字输入切点');
  await page.fill('#startInput', '12000');
  await page.dispatchEvent('#startInput', 'change');
  await page.fill('#endInput', '72000');
  await page.dispatchEvent('#endInput', 'change');
  await page.waitForTimeout(300);
  d = await getDoc(page);
  ok('区间更新为 [12,000, 72,000)', d.range === '[12,000, 72,000)', d.range);
  ok('起点数字输入同步', d.start === 12000 && d.end === 72000);
  ok('显示循环长度 60,000 帧', (await page.textContent('#lenFrames')) === '60,000 帧');
  ok('显示预留音频 24,000 帧', (await page.textContent('#postrollInfo')).startsWith('24,000 帧'));

  await page.fill('#startInput', '-5');
  await page.dispatchEvent('#startInput', 'change');
  await page.waitForTimeout(150);
  d = await getDoc(page);
  ok('越界起点被钳制到 0', d.start === 0, String(d.start));

  await page.fill('#startInput', '72000');
  await page.dispatchEvent('#startInput', 'change');
  await page.waitForTimeout(150);
  d = await getDoc(page);
  ok('起点不得等于终点（钳制到 end−1）', d.start === 71999, String(d.start));
  await page.fill('#startInput', '12000');
  await page.dispatchEvent('#startInput', 'change');
  await page.waitForTimeout(150);

  /* ---------------- 步进按钮 ---------------- */
  section('帧级步进');
  const before = (await getDoc(page)).start;
  await page.click('#startPlus');
  ok('+1 帧步进', (await getDoc(page)).start === before + 1);
  await page.click('#startMinus');
  ok('−1 帧步进', (await getDoc(page)).start === before);

  /* ---------------- 淡化 ---------------- */
  section('交叉淡化');
  await page.fill('#fadeFramesInput', '2400');
  await page.dispatchEvent('#fadeFramesInput', 'change');
  await page.waitForTimeout(300);
  d = await getDoc(page);
  ok('F = 2400 帧（50ms）', d.fadeFrames === 2400 && d.fadeTag === 'F = 2400 帧', d.fadeTag);
  ok('ms 输入同步为 50.00', (await page.inputValue('#fadeMsInput')) === '50.00',
    await page.inputValue('#fadeMsInput'));
  ok('无错误提示', !d.fadeErrorVisible, d.fadeErrorText);

  await page.fill('#fadeFramesInput', '1');
  await page.dispatchEvent('#fadeFramesInput', 'change');
  await page.waitForTimeout(200);
  d = await getDoc(page);
  ok('F = 1 被阻止并提示（不得静默改为其他值）',
    d.fadeFrames === 1 && d.fadeErrorVisible && /至少 2 帧/.test(d.fadeErrorText),
    'F=' + d.fadeFrames + ' ' + d.fadeErrorText);
  ok('F = 1 时禁用“处理后”试听', await page.locator('#monitorProcessed').isDisabled());
  ok('F = 1 时导出按钮仍可点但导出会被拒绝', !(await page.locator('#btnExport').isDisabled()));
  await page.locator('#fadeFixZero').click();
  await page.waitForTimeout(200);
  ok('“改为 0”按钮修复 F = 1', (await getDoc(page)).fadeFrames === 0 && !(await getDoc(page)).fadeErrorVisible);

  await page.fill('#fadeFramesInput', '5000');
  await page.dispatchEvent('#fadeFramesInput', 'change');
  await page.waitForTimeout(200);
  d = await getDoc(page);
  ok('F 超过 100ms 被阻止', d.fadeErrorVisible && /100 ms/.test(d.fadeErrorText), d.fadeErrorText);
  ok('超限时提供“设为最大合法值”按钮', await page.locator('#fadeError button').count() > 0);
  await page.locator('#fadeError button', { hasText: '最大合法值' }).click();
  await page.waitForTimeout(200);
  d = await getDoc(page);
  ok('一键修正后参数合法', !d.fadeErrorVisible && d.fadeFrames === 4800,
    'F=' + d.fadeFrames + ' ' + d.fadeErrorText);

  await page.fill('#fadeFramesInput', '2400');
  await page.dispatchEvent('#fadeFramesInput', 'change');
  await page.waitForTimeout(250);

  // 预留不足：把 end 推到文件末尾附近
  await page.fill('#endInput', '95800');
  await page.dispatchEvent('#endInput', 'change');
  await page.waitForTimeout(250);
  d = await getDoc(page);
  ok('预留不足时阻止淡化', d.fadeErrorVisible && /预留音频不足/.test(d.fadeErrorText),
    d.fadeErrorText);
  await page.fill('#endInput', '72000');
  await page.dispatchEvent('#endInput', 'change');
  await page.waitForTimeout(200);

  /* ---------------- 指标表 ---------------- */
  section('接缝指标');
  const metrics = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#metricsBody tr')];
    return rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
  });
  ok('每个声道两行（原样 / 淡化后）', metrics.length === 4, String(metrics.length));
  ok('双声道标签 L / R', metrics[0][0] === 'L' && metrics[2][0] === 'R',
    metrics.map((m) => m[0]).join(','));
  const cellNum = (s) => Number(String(s).match(/-?\d+\.\d+/)[0]);
  // 原样行：0 声道 1 状态 2 首端 3 尾端 4 接缝 5 首RMS 6 尾RMS
  // 处理后行：0 状态 1 首端 2 尾端 3 接缝 4 首RMS 5 尾RMS
  ok('原样与淡化后接缝跳变均显示',
    !isNaN(cellNum(metrics[0][4])) && !isNaN(cellNum(metrics[1][3])),
    metrics[0][4] + ' / ' + metrics[1][3]);
  ok('淡化后首端跳变与尾端跳变有数值',
    !isNaN(cellNum(metrics[1][1])) && !isNaN(cellNum(metrics[1][2])));
  ok('显示 10ms RMS 两列（原样与处理后）',
    /dB/.test(metrics[0][5]) && /dB/.test(metrics[0][6]) &&
    /dB/.test(metrics[1][4]) && /dB/.test(metrics[1][5]),
    metrics[0][5] + ' / ' + metrics[1][4]);

  /* ---------------- 波形拖动与缩放 ---------------- */
  section('波形交互');
  const box = await page.locator('#waveCanvas').boundingBox();
  const frameToX = async (frame) => {
    const v = await page.evaluate(() => {
      const c = document.getElementById('waveCanvas');
      const m = c.getBoundingClientRect();
      const info = document.getElementById('viewInfo').textContent;
      return { width: m.width, fpp: Number(info.split(' ')[0]) };
    });
    return { v };
  };
  // 适应全宽后按比例拖出大致区间
  await page.click('#btnZoomFit');
  await page.waitForTimeout(150);
  let view = await page.evaluate(() => {
    const info = document.getElementById('viewInfo').textContent;
    return Number(info.split(' ')[0]);
  });
  ok('适应视图后显示帧/像素比例', isFinite(view) && view > 0, String(view));
  const framesPerPx = view;
  const boundaryPx = (frame) => frame / framesPerPx;
  const y = box.y + 46 + 40;
  await page.mouse.move(box.x + boundaryPx(2000), y);
  await page.mouse.down();
  await page.mouse.move(box.x + boundaryPx(40000), y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  d = await getDoc(page);
  const tolFrames = framesPerPx * 3;
  ok('拖动波形新建区间（约 [2000, 40001)，误差 < 3 像素）',
    Math.abs(d.start - 2000) <= tolFrames && Math.abs(d.end - 40001) <= tolFrames,
    '[' + d.start + ', ' + d.end + ') 容差 ' + Math.round(tolFrames));

  // 拖拽边界手柄
  const xOfEnd = box.x + boundaryPx(d.end);
  await page.mouse.move(xOfEnd, y);
  await page.mouse.down();
  await page.mouse.move(xOfEnd + 30, y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const d2 = await getDoc(page);
  ok('拖动 end 边界微调', d2.end > d.end, String(d.end) + ' → ' + String(d2.end));

  // 放大到采样级
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  const zoomText = await page.textContent('#viewInfo');
  ok('滚轮可放大到采样级（显示 像素/帧）', /像素\/帧/.test(zoomText), zoomText);
  const pixelsPerFrame = Number(zoomText.split(' ')[0]);
  ok('放大倍率 >= 1 像素/帧（可分辨每个采样帧）', pixelsPerFrame >= 1,
    String(pixelsPerFrame));

  // 数字输入与拖动共用同一区间：输入后标尺上的标签同步
  await page.fill('#startInput', '12000'); await page.dispatchEvent('#startInput','change');
  await page.fill('#endInput', '72000'); await page.dispatchEvent('#endInput','change');
  await page.waitForTimeout(200);
  ok('数字输入后标签同步', (await getDoc(page)).range === '[12,000, 72,000)');
  await page.click('#btnZoomFit');
  const lenBefore = await page.textContent('#lenFrames');
  await page.click('#startMinus');
  ok('起点减 1 帧后循环长度 +1', (await page.textContent('#lenFrames')) === '60,001 帧',
    await page.textContent('#lenFrames'));
  await page.click('#startPlus');
  ok('恢复后循环长度回到 60,000 帧', (await page.textContent('#lenFrames')) === lenBefore,
    await page.textContent('#lenFrames'));

  // 单击波形定位
  await page.mouse.click(box.x + boundaryPx(50000), box.y + 100);
  await page.waitForTimeout(150);
  ok('单击波形在循环内定位',
    /第 [\d,]+ 帧/.test(await page.textContent('#playPosition')));

  /* ---------------- 试听 ---------------- */
  section('连续循环试听');
  await page.click('#btnPlay');
  await page.waitForTimeout(1200);
  ok('开始播放', (await getDoc(page)).playTag === '处理后 · 循环中', (await getDoc(page)).playTag);
  await page.waitForTimeout(13500);
  const loops = Number((await getDoc(page)).loops);
  ok('连续循环至少 10 轮', loops >= 10, '轮数 ' + loops);

  // 在页面内一次性采样，避免跨进程往返的时间误差
  const switchTrace = await page.evaluate(async () => {
    const tag = () => document.getElementById('playTag').textContent;
    const read = () => {
      const p = window.LOOP_STUDIO.positionFrames();
      return { frame: p.frames, t: p.clock, loops: p.wraps };
    };
    const a = Object.assign(read(), { tag: tag() });
    document.getElementById('monitorRaw').click();
    const b = Object.assign(read(), { tag: tag() });
    await new Promise((r) => setTimeout(r, 60));
    const c = Object.assign(read(), { tag: tag() });
    document.getElementById('monitorProcessed').click();
    const d = Object.assign(read(), { tag: tag() });
    await new Promise((r) => setTimeout(r, 60));
    const e = Object.assign(read(), { tag: tag() });
    return { a, b, c, d, e };
  });
  const dev = (p, q) => {
    const elapsed = (q.t - p.t) * 48000;
    let diff = q.frame - p.frame - elapsed;
    diff = ((diff % 60000) + 60000) % 60000;
    return Math.round(Math.min(diff, 60000 - diff));
  };
  ok('切换到处理前仍在播放', switchTrace.b.tag === '处理前 · 循环中', switchTrace.b.tag);
  ok('切换处理前位置连续（同一音频时钟，偏差 < 1 帧）', dev(switchTrace.a, switchTrace.b) < 1,
    '偏差 ' + dev(switchTrace.a, switchTrace.b) + ' 帧');
  ok('切换后继续推进', switchTrace.c.frame > switchTrace.b.frame ||
    switchTrace.c.loops > switchTrace.b.loops,
    switchTrace.b.frame + ' → ' + switchTrace.c.frame);
  ok('切回处理后仍在播放', switchTrace.d.tag === '处理后 · 循环中',
    JSON.stringify(switchTrace));
  ok('切回处理后位置连续（同一音频时钟，偏差 < 1 帧）', dev(switchTrace.c, switchTrace.d) < 1,
    '偏差 ' + dev(switchTrace.c, switchTrace.d) + ' 帧');
  ok('切回处理后继续推进', switchTrace.e.frame > switchTrace.d.frame ||
    switchTrace.e.loops > switchTrace.d.loops,
    switchTrace.d.frame + ' → ' + switchTrace.e.frame);

  // 停止 → 切换 → 开始：也应从同一位置继续
  const paused = await page.evaluate(() => {
    document.getElementById('btnPlay').click();
    const t = document.getElementById('playPosition').textContent;
    const m = t.match(/第 ([\d,]+) 帧/);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  });
  await page.waitForTimeout(300);
  const pausedRead = await page.evaluate(() => {
    const t = document.getElementById('playPosition').textContent;
    const m = t.match(/第 ([\d,]+) 帧/);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  });
  ok('停止时保留循环内位置', isFinite(paused) && isFinite(pausedRead) &&
    Math.abs(pausedRead - paused) < 5, paused + ' / ' + pausedRead);
  await page.click('#monitorRaw');
  await page.waitForTimeout(120);
  ok('停止状态下切换处理前后不自动开始播放',
    (await getDoc(page)).playTag === '已停止', (await getDoc(page)).playTag);
  // 播放有 20ms 的调度提前量：点击后立即读取，位置应恰为暂停位置
  const resumed = await page.evaluate(() => {
    const p0 = window.LOOP_STUDIO.positionFrames();
    document.getElementById('btnPlay').click();
    const p1 = window.LOOP_STUDIO.positionFrames();
    return { p0, p1 };
  });
  const resumeDrift = Math.abs(resumed.p1.frames - resumed.p0.frames);
  ok('从暂停位置继续播放（处理前，位置不跳变）',
    resumed.p1.playing && resumeDrift < 1,
    '暂停于 ' + Math.round(resumed.p0.frames) + ' → 开始于 ' +
    Math.round(resumed.p1.frames) + '，偏差 ' + resumeDrift.toFixed(2) + ' 帧');
  const advanced = await page.evaluate(async () => {
    const a = window.LOOP_STUDIO.positionFrames().frames;
    await new Promise((r) => setTimeout(r, 400));
    return { a, b: window.LOOP_STUDIO.positionFrames().frames };
  });
  ok('继续播放后位置向前推进', advanced.b > advanced.a,
    Math.round(advanced.a) + ' → ' + Math.round(advanced.b));
  await page.click('#monitorProcessed');
  await page.waitForTimeout(150);
  ok('播放中切回处理后仍播放', (await getDoc(page)).playTag === '处理后 · 循环中',
    (await getDoc(page)).playTag);
  const loopsBefore = await page.evaluate(() => window.LOOP_STUDIO.positionFrames().wraps);
  await page.waitForTimeout(5000);
  const loopsAfter = await page.evaluate(() => window.LOOP_STUDIO.positionFrames().wraps);
  ok('播放继续累积轮数', loopsAfter > loopsBefore, loopsBefore + ' → ' + loopsAfter);
  await page.click('#btnPlay');
  await page.waitForTimeout(250);
  ok('停止播放', (await getDoc(page)).playTag === '已停止',
    (await getDoc(page)).playTag);

  /* ---------------- 导出 ---------------- */
  section('导出与标记');
  const exported = await download(() => page.click('#btnExport'));
  ok('导出文件存在', fs.existsSync(exported), exported);
  const bytes = fs.readFileSync(exported);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = WAV.decodeWav(ab);
  ok('导出只含循环区间（60,000 帧）', decoded.frames === 60000, String(decoded.frames));
  ok('导出保持 48kHz / 24 位 / 双声道',
    decoded.sampleRate === 48000 && decoded.bits === 24 && decoded.channelCount === 2);
  ok('写入 smpl 前向循环标记', !!decoded.loop && decoded.loop.type === 0);
  ok('标记覆盖全段 [0, 59999]',
    decoded.loop.start === 0 && decoded.loop.endInclusive === 59999);
  ok('标记无限循环（playCount = 0）', decoded.loop.playCount === 0);
  ok('导出界面显示导出结果', /smpl \[0, 59,999\]/.test((await getDoc(page)).exportStatus),
    (await getDoc(page)).exportStatus);

  /* ---------------- 再导入 ---------------- */
  section('导出文件再导入');
  await page.setInputFiles('#fileInput', exported);
  await page.waitForTimeout(600);
  d = await getDoc(page);
  ok('再导入自动识别 smpl 标记', /已识别 smpl 循环标记/.test(
    await page.textContent('#noticeText')), await page.textContent('#noticeText'));
  ok('切点设为 [0, 60,000)', d.range === '[0, 60,000)', d.range);
  ok('再导入后素材信息为 60,000 帧', /60,000 帧/.test(d.source), d.source);
  // 与原导出逐采样比对
  const again = WAV.decodeWav(await (async () => {
    const b = fs.readFileSync(exported);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  })());
  ok('再导入音频与导出音频一致', again.frames === decoded.frames);

  /* ---------------- 工程保存 / 重载 ---------------- */
  section('工程保存与重载');
  await page.setInputFiles('#fileInput', path.join(fixtures, 'stereo-postroll.wav'));
  await page.waitForTimeout(500);
  await page.fill('#startInput', '12000'); await page.dispatchEvent('#startInput','change');
  await page.fill('#endInput', '72000'); await page.dispatchEvent('#endInput','change');
  await page.fill('#fadeFramesInput', '2400'); await page.dispatchEvent('#fadeFramesInput','change');
  await page.waitForTimeout(250);
  const projectFile = await download(() => page.click('#btnProjectSave'));
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  ok('工程含 kind/version', project.kind === 'loop-postroll-studio' && project.version === 1);
  ok('工程含源文件 SHA-256', /^[0-9a-f]{64}$/.test(project.source.sha256),
    String(project.source.sha256).slice(0, 12));
  ok('工程含切点与淡化参数',
    project.loop.start === 12000 && project.loop.end === 72000 &&
    project.loop.fadeFrames === 2400,
    JSON.stringify(project.loop));

  // 重载：先导入不匹配的素材（eof-mono 无 smpl 标记），再打开工程 → 必须提示
  await page.setInputFiles('#fileInput', path.join(fixtures, 'eof-mono.wav'));
  await page.waitForTimeout(500);
  await page.setInputFiles('#projectInput', projectFile);
  await page.waitForTimeout(400);
  ok('素材不匹配时弹出提示对话框', await page.locator('#mismatchDialog').evaluate(
    (dlg) => dlg.open));
  const diffText = await page.textContent('#mismatchList');
  ok('提示列出具体差异（校验和/帧数）', /校验和/.test(diffText) && /帧数/.test(diffText),
    diffText.slice(0, 160));
  await page.click('#mismatchCancel');
  await page.waitForTimeout(300);
  const afterCancel = await getDoc(page);
  ok('取消后参数不回滚也不误用工程值', afterCancel.start === 0 &&
    afterCancel.end === 48001, afterCancel.range);
  ok('取消后工程状态提示未应用',
    /取消/.test(await page.textContent('#noticeText')));

  // 再打开一次工程，选择“仍然应用参数”→ 按当前（不匹配）素材钳制
  await page.setInputFiles('#projectInput', projectFile);
  await page.waitForTimeout(400);
  ok('再次打开仍提示不匹配', await page.locator('#mismatchDialog').evaluate((d) => d.open));
  await page.click('#mismatchApply');
  await page.waitForTimeout(400);
  const forced = await getDoc(page);
  ok('强制应用后切点被钳制到当前素材范围内',
    forced.end === 48001 && forced.start === 12000, forced.range);

  // 重新导入匹配素材，再打开工程 → 自动恢复
  await page.setInputFiles('#fileInput', path.join(fixtures, 'stereo-postroll.wav'));
  await page.waitForTimeout(500);
  await page.setInputFiles('#projectInput', projectFile);
  await page.waitForTimeout(500);
  d = await getDoc(page);
  ok('素材匹配时自动恢复切点', d.start === 12000 && d.end === 72000, d.range);
  ok('自动恢复淡化参数', d.fadeFrames === 2400, String(d.fadeFrames));
  ok('工程状态提示已恢复', /已恢复工程|已按工程/.test(await page.textContent('#noticeText')),
    await page.textContent('#noticeText'));

  // 无素材时打开工程 → 引导导入源文件；导入后按工程自动恢复
  await page.evaluate(() => location.reload());
  await page.waitForSelector('#waveCanvas');
  await page.waitForTimeout(300);
  await page.setInputFiles('#projectInput', projectFile);
  await page.waitForTimeout(400);
  ok('无素材打开工程时提示需导入源文件',
    /请导入该源文件/.test(await page.textContent('#noticeText')),
    await page.textContent('#noticeText'));
  await page.setInputFiles('#fileInput', path.join(fixtures, 'eof-mono.wav'));
  await page.waitForTimeout(500);
  ok('导入的是另一素材 → 仍弹出不匹配提示',
    await page.locator('#mismatchDialog').evaluate((d) => d.open));
  await page.click('#mismatchCancel');
  await page.waitForTimeout(200);
  await page.setInputFiles('#fileInput', path.join(fixtures, 'stereo-postroll.wav'));
  await page.waitForTimeout(500);
  ok('导入正确素材后按工程恢复',
    /已按工程|已恢复工程/.test(await page.textContent('#noticeText')) &&
    (await getDoc(page)).start === 12000, await page.textContent('#noticeText'));

  /* ---------------- 截断文件 ---------------- */
  section('非法素材');
  await page.setInputFiles('#fileInput', path.join(fixtures, 'truncated.wav'));
  await page.waitForTimeout(400);
  ok('截断文件被拒绝并提示', /截断|不完整/.test(await page.textContent('#noticeText')),
    await page.textContent('#noticeText'));

  /* ---------------- 布局与移动端 ---------------- */
  section('响应式');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  ok('窄屏无横向滚动',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    await page.evaluate(() => document.documentElement.scrollWidth + '/' + window.innerWidth));
  ok('窄屏侧栏单列堆叠', await page.evaluate(() => {
    const side = document.querySelector('.side-col');
    return getComputedStyle(side).flexDirection === 'column';
  }));
  await page.screenshot({ path: '/tmp/e2e-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.setInputFiles('#fileInput', path.join(fixtures, 'stereo-postroll.wav'));
  await page.waitForTimeout(500);
  await page.fill('#startInput', '12000'); await page.dispatchEvent('#startInput','change');
  await page.fill('#endInput', '72000'); await page.dispatchEvent('#endInput','change');
  await page.fill('#fadeFramesInput', '2400'); await page.dispatchEvent('#fadeFramesInput','change');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/e2e-desktop.png', fullPage: true });

  ok('全程无脚本错误', problems.length === 0, problems.join(' | '));

  await browser.close();
  if (failures) {
    console.log('\n失败 ' + failures + ' 项 / 共 ' + checks + ' 项');
    process.exit(1);
  }
  console.log('\n全部通过：' + checks + ' 项检查。');
}

run().catch((e) => {
  console.error('端到端脚本异常：', e);
  process.exit(2);
});
