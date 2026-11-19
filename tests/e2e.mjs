// 浏览器端到端测试：真实驾驶、HUD、违规记录、幽灵、导入导出与一致性。
// 依赖本机 Playwright Chromium；HTTP 服务由本文件自起自停（127.0.0.1）。
// Playwright 从全局 npm 目录解析，找不到再退回本机固定路径
async function loadChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    const mod = await import('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs');
    return mod.chromium;
  }
}
const chromium = await loadChromium();
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const abs = normalize(join(root, rel));
    if (!abs.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const data = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, msg, detail) => {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg + (detail ? ' — ' + detail : ''));
    console.error('  ✗ ' + msg + (detail ? ' — ' + detail : ''));
  }
};

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ---------------------------------------------------------------- 1. 首屏
ok(await page.locator('#track-canvas').isVisible(), '赛道画布可见');
const initial = await page.evaluate(() => window.__rally.getView());
ok(initial && initial.mode === 'drive', '默认进入驾驶模式');
ok(initial.progress.gatesPerLap >= 2, '默认赛道至少 2 道门', String(initial.progress.gatesPerLap));
ok((await page.locator('#target-num').innerText()).trim() === '0', '起始目标门显示 0');
ok((await page.locator('#gate-dots .dot').count()) === initial.progress.gatesPerLap, '门点阵数量与门数一致');
const dotsTarget = await page.locator('#gate-dots .dot.target').count();
ok(dotsTarget === 1, '恰好一个目标门高亮');

// ---------------------------------------------------------------- 2. 键盘真实驾驶
await page.keyboard.down('KeyW');
await page.waitForTimeout(2600);
await page.keyboard.up('KeyW');
await page.waitForTimeout(250);
const afterDrive = await page.evaluate(() => window.__rally.getView());
ok(afterDrive.tick > initial.tick, '按油门后逻辑步推进', `${initial.tick} -> ${afterDrive.tick}`);
ok(afterDrive.car.v > 1, '车辆速度上升', afterDrive.car.v.toFixed(3));
ok(afterDrive.progress.started, '穿过 0 号门后开始计时');
ok(afterDrive.progress.expectedGate === 1, '起步后期望门为 1', String(afterDrive.progress.expectedGate));
ok(afterDrive.lapTime > 0, '本圈计时开始累计');
const lapText = await page.locator('#big-timer').innerText();
ok(/[0-9]/.test(lapText), '大计时器显示数字', lapText.trim());

// 转向：按住 D 后 yaw 变化
const yawBefore = (await page.evaluate(() => window.__rally.getView())).car.yaw;
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyD');
await page.waitForTimeout(700);
await page.keyboard.up('KeyD');
await page.keyboard.up('KeyW');
await page.waitForTimeout(150);
const yawAfter = (await page.evaluate(() => window.__rally.getView())).car.yaw;
ok(Math.abs(yawAfter - yawBefore) > 1e-3, '转向改变航向', `${yawBefore.toFixed(3)} -> ${yawAfter.toFixed(3)}`);

// ---------------------------------------------------------------- 3. 暂停 / 恢复
await page.evaluate(() => window.__rally.start());
await page.keyboard.press('Space');
await page.waitForTimeout(120);
const pausedView = await page.evaluate(() => window.__rally.getView());
ok(pausedView.state === 'paused', '空格暂停', pausedView.state);
const tickPaused = pausedView.tick;
await page.waitForTimeout(450);
const stillPaused = await page.evaluate(() => window.__rally.getView());
ok(stillPaused.tick === tickPaused, '暂停期间逻辑步不推进', `${tickPaused} -> ${stillPaused.tick}`);
await page.keyboard.press('Space');
await page.waitForTimeout(350);
const resumed = await page.evaluate(() => window.__rally.getView());
ok(resumed.state === 'running' && resumed.tick > tickPaused, '空格恢复并继续推进', `${tickPaused} -> ${resumed.tick}`);

// ---------------------------------------------------------------- 4. 违规：倒车穿回已过的门
const reverseTest = await page.evaluate(() => {
  const R = window.__rally;
  R.setTrack('直道多门', 1);
  const s = R.session();
  s.start(performance.now());
  // 先向前跨过 0、1 号门
  const inputs = [];
  for (let i = 0; i < 900; i++) inputs.push({ throttle: 1, steer: 0, brake: false });
  R.driveScript(inputs);
  const afterForward = R.getResult();
  // 刹车到停，再倒车穿回 1 号门
  const back = [];
  for (let i = 0; i < 180; i++) back.push({ throttle: 0, steer: 0, brake: true });
  for (let i = 0; i < 1400; i++) back.push({ throttle: -1, steer: 0, brake: false });
  R.driveScript(back);
  return R.getResult();
});
ok(reverseTest.violationCounts.reverse >= 1, '倒车穿门记 reverse', JSON.stringify(reverseTest.violationCounts));
ok(
  reverseTest.violations.some((v) => v.kind === 'reverse'),
  '违规列表里有反向记录',
  String(reverseTest.violations.length)
);
const violRows = await page.locator('#violation-list .feed-row').count();
ok(violRows >= 1, '页面显示违规记录', String(violRows));
const violText = await page.locator('#violation-list').innerText();
ok(/反向/.test(violText), '违规行文本含“反向”', violText.split('\n')[0]);

// ---------------------------------------------------------------- 5. 顺序外：跳过目标门
const outOfOrderTest = await page.evaluate(() => {
  const R = window.__rally;
  R.setTrack('直道多门', 1);
  const race = R.session().race;
  // 手工构造：0 号门起步后，立刻把车挪到 2 号门前面再向前开，跳过 1 号门
  const gates = R.app.track.gates;
  const g2 = gates[2];
  race.state.x = (g2.a[0] + g2.b[0]) / 2 - 3;
  race.state.y = (g2.a[1] + g2.b[1]) / 2;
  race.state.yaw = 0;
  race.state.v = 20;
  // 起步已发生？先把仲裁器设为已起步、期望 1
  race.arbiter.started = true;
  race.arbiter.expectedGate = 1;
  race.started = true;
  const inputs = [];
  for (let i = 0; i < 200; i++) inputs.push({ throttle: 0.2, steer: 0, brake: false });
  R.driveScript(inputs);
  return R.getResult();
});
ok(outOfOrderTest.violationCounts.outOfOrder >= 1, '跳过目标门记 outOfOrder', JSON.stringify(outOfOrderTest.violationCounts));

// ---------------------------------------------------------------- 6. 一步跨多门
const multiGate = await page.evaluate(() => {
  const E = window.RallyEngine;
  const gates = E.prepareGates([
    { a: [0, -4], b: [0, 4], normal: [1, 0] },
    { a: [0.05, -4], b: [0.05, 4], normal: [1, 0] },
    { a: [0.1, -4], b: [0.1, 4], normal: [1, 0] },
  ]);
  const cs = E.gateCrossings({ x: -1, y: 0 }, { x: 1, y: 0 }, gates);
  return cs.map((c) => ({ gate: c.gate, t: c.t }));
});
ok(multiGate.length === 3, '一段跨三门全部检出', JSON.stringify(multiGate.map((c) => c.gate)));
ok(
  multiGate[0].t < multiGate[1].t && multiGate[1].t < multiGate[2].t,
  '跨门按 t 升序',
  JSON.stringify(multiGate.map((c) => +c.t.toFixed(6)))
);
const multiInTrack = await page.evaluate(() => {
  const R = window.__rally;
  R.setTrack('直道多门', 2);
  const auto = R.runAutopilot({ raceOptions: { lapsToFinish: 2 } });
  const byTick = {};
  for (const a of auto.result.accepted) (byTick[a.tick] = byTick[a.tick] || []).push(a.gate);
  return Object.entries(byTick)
    .filter(([, v]) => v.length > 1)
    .map(([t, v]) => ({ tick: Number(t), gates: v }));
});
ok(multiInTrack.length >= 1, '内置赛道出现一步跨多门', JSON.stringify(multiInTrack[0] || null));
ok(
  multiInTrack.every((m) => m.gates.every((g, i, arr) => i === 0 || g === arr[i - 1] + 1)),
  '一步跨多门按门序号连续结算',
  JSON.stringify(multiInTrack)
);

// ---------------------------------------------------------------- 7. 幽灵：封存、显示、只读
const ghostRun = await page.evaluate(() => {
  const R = window.__rally;
  R.setTrack('窄门练习场', 1);
  const auto = R.runAutopilot({ raceOptions: { lapsToFinish: 1 } });
  const rp = R.session().exportReplay();
  rp.inputs = auto.inputs;
  rp.ticks = auto.result.ticks;
  R.importReplayText(JSON.stringify(rp));
  const s = R.session();
  const ghost = window.RallyRecorder.buildGhost(rp, { label: 'E2E 幽灵' });
  s.setGhost(ghost);
  const before = s.race.checksum;
  // 取样插值若干次（渲染路径）
  for (let i = 0; i < 50; i++) window.RallyRecorder.sampleTrace(ghost.trace, i * 7, i / 50);
  return {
    ghostTicks: ghost.ticks,
    ghostLaps: ghost.result.laps.length,
    sameChecksum: s.race.checksum === before,
    pillVisible: !document.getElementById('pill-ghost').hidden,
    ghostSource: document.getElementById('ghost-source').textContent,
  };
});
ok(ghostRun.ghostTicks > 100, '幽灵轨迹有足够 tick', String(ghostRun.ghostTicks));
ok(ghostRun.ghostLaps >= 1, '幽灵自身跑完一圈');
ok(ghostRun.sameChecksum, '幽灵插值取样不改变逻辑校验和');
ok(ghostRun.pillVisible, '幽灵状态胶囊显示');
ok(/E2E/.test(ghostRun.ghostSource), '幽灵来源文本更新', ghostRun.ghostSource);

// ---------------------------------------------------------------- 8. 导出 / 导入成绩与输入
await page.click('#btn-export-input');
await page.waitForSelector('#modal-back:not([hidden])');
const exportedReplay = await page.locator('#modal-text').inputValue();
const replayJson = JSON.parse(exportedReplay);
ok(replayJson.format === 'rally-gate-steward/replay-v1', '回放导出带格式标识', replayJson.format);
ok(Array.isArray(replayJson.inputs) && replayJson.inputs.length > 0, '回放导出含输入');
ok(replayJson.inputs[0].tick === 0, '回放首项 tick 0');
ok(Array.isArray(replayJson.gates) && replayJson.gates.length >= 2, '回放导出含门');
await page.click('#modal-cancel');

await page.click('#btn-export-result');
await page.waitForSelector('#modal-back:not([hidden])');
const exportedResult = JSON.parse(await page.locator('#modal-text').inputValue());
ok(exportedResult.format === 'rally-gate-steward/result-v1', '成绩导出带格式标识', exportedResult.format);
ok(exportedResult.result && exportedResult.replay, '成绩导出同时含成绩与回放');
ok(Array.isArray(exportedResult.result.laps), '成绩含分圈');
await page.click('#modal-cancel');

await page.click('#btn-export-track');
await page.waitForSelector('#modal-back:not([hidden])');
const exportedTrack = JSON.parse(await page.locator('#modal-text').inputValue());
ok(Array.isArray(exportedTrack.gates) && exportedTrack.gates.length >= 2, '赛道导出含门');
ok(!!exportedTrack.params && !!exportedTrack.initial, '赛道导出含参数与初始状态');
await page.click('#modal-cancel');

// 重新导入回放，必须进入回放模式并可从头重放
const importOut = await page.evaluate((text) => {
  const R = window.__rally;
  const res = R.importReplayText(text);
  const s = R.session();
  const first = R.getResult();
  return {
    res,
    mode: s.mode,
    state: s.state,
    ticks: first.ticks,
    checksum: first.checksum,
    laps: first.laps.length,
  };
}, exportedReplay);
ok(importOut.res.ok, '导入回放成功', JSON.stringify(importOut.res));
ok(importOut.mode === 'replay', '导入后处于回放模式', importOut.mode);
ok(importOut.ticks === 0, '回放载入后停在开头', String(importOut.ticks));
// 跳到结尾后步数与分圈必须与导出一致
const replayEnd = await page.evaluate(() => {
  document.getElementById('btn-replay-end').click();
  const r = window.__rally.getResult();
  return { ticks: r.ticks, laps: r.laps.length, sum: r.checksum, visible: !document.getElementById('btn-replay-end').hidden };
});
ok(replayEnd.visible, '回放模式显示“跳到结尾”');
ok(replayEnd.ticks === replayJson.ticks, '跳到结尾后步数与导出一致', `${replayEnd.ticks} vs ${replayJson.ticks}`);
ok(replayEnd.laps >= 1, '回放产出分圈成绩', String(replayEnd.laps));

// ---------------------------------------------------------------- 9. 一致性自检
const verify = await page.evaluate(() => {
  const v = window.__rally.verify();
  return { ok: v.ok, lines: v.lines.map((l) => l.replace(/<[^>]+>/g, '')) };
});
ok(verify.ok, '页面一致性自检全部通过', verify.lines.filter((l) => l.startsWith('✗')).join(' | '));

// ---------------------------------------------------------------- 10. 包内样例校验
const sample = await page.evaluate(() => window.__rally.sampleCheck());
ok(sample.ok, '包内样例校验全部通过', `${sample.pass}/${sample.total}`);
await page.click('#btn-sample-check');
await page.waitForTimeout(200);
const sampleBox = await page.locator('#sample-box').innerText();
ok(/全部通过/.test(sampleBox), '样例校验结果显示在页面', sampleBox.split('\n').slice(-1)[0]);

// ---------------------------------------------------------------- 11. 帧率无关（真实页面会话）
const rates = await page.evaluate(() => {
  const R = window.__rally;
  const s = R.session();
  const rp = s.exportReplay();
  rp.ticks = Math.min(rp.ticks, 600);
  const out = {};
  for (const hz of [24, 30, 60, 75, 144, 240]) {
    const sim = R.simulateAtFrameRate(rp, rp.ticks, hz);
    out[hz] = sim.checksum;
  }
  const ref = window.RallyEngine.simulateReplay(rp, { ticks: rp.ticks }).checksum;
  return { out, ref };
});
const rateValues = Object.values(rates.out);
ok(rateValues.every((v) => v === rates.ref), '多帧率结果与纯重放一致', JSON.stringify(rates));

// ---------------------------------------------------------------- 12. 校验与边界输入
const invalid = await page.evaluate(() => {
  const R = window.__rally;
  const res1 = R.importReplayText(JSON.stringify({ initial: {}, params: {}, gates: [], inputs: [] }));
  const res2 = R.importTrackText('{ not json');
  const res3 = R.importTrackText(JSON.stringify({ gates: [{ a: [0, 0], b: [0, 1], normal: [1, 0] }] }));
  return { res1, res2, res3 };
});
ok(invalid.res1.ok === false, '空回放被拒绝');
ok(invalid.res2.ok === false, '非法 JSON 被拒绝');
ok(invalid.res3.ok === false, '少于 2 道门的赛道被拒绝');
// 页面仍正常
ok((await page.evaluate(() => window.__rally.session().mode)) === 'replay', '拒绝非法输入后页面仍可继续');

// ---------------------------------------------------------------- 13. 主题与移动端
await page.click('#btn-theme');
await page.waitForTimeout(150);
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', '切换到浅色主题');
await page.click('#btn-theme');
await page.waitForTimeout(150);
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '切回深色主题');

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
mobile.on('pageerror', (e) => errors.push('MOBILE-PAGEERROR: ' + e.message));
await mobile.goto(base, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(500);
const mobileInfo = await mobile.evaluate(() => {
  const pad = document.getElementById('touch-pad');
  const rect = pad.getBoundingClientRect();
  return {
    touchVisible: getComputedStyle(pad).display !== 'none',
    padWidth: rect.width,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    dots: document.querySelectorAll('#gate-dots .dot').length,
  };
});
ok(mobileInfo.touchVisible, '移动端显示触摸方向键');
ok(mobileInfo.overflowX <= 1, '移动端无横向滚动', String(mobileInfo.overflowX));
// 触摸油门
const mTickBefore = await mobile.evaluate(() => window.__rally.getView().tick);
const upBtn = mobile.locator('[data-hold="up"]');
await upBtn.dispatchEvent('pointerdown', { pointerId: 1, bubbles: true });
await mobile.waitForTimeout(800);
await upBtn.dispatchEvent('pointerup', { pointerId: 1, bubbles: true });
await mobile.waitForTimeout(150);
const mTickAfter = await mobile.evaluate(() => window.__rally.getView().tick);
ok(mTickAfter > mTickBefore, '移动端触摸油门推进逻辑', `${mTickBefore} -> ${mTickAfter}`);
await mobile.close();

// ---------------------------------------------------------------- 收尾
ok(errors.length === 0, '全程无控制台错误', errors.join(' | '));

await browser.close();
server.close();
console.log(`\nE2E 结果：${pass} 通过，${fail} 失败`);
if (fail) {
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
