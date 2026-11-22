// 端到端测试：驱动无头 Chromium 加载真实页面，验证调度语义、单步/断点、
// 快照续跑一致、错误隔离、导入拒绝、性能基准与响应式布局。
//
// 用法：node tests/e2e.mjs [base-url]
// 依赖：本地 Playwright（全局安装即可），以及已启动的服务（scripts/start.sh）。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:8000/';
const tmp = mkdtempSync(join(tmpdir(), 'lfv-e2e-'));
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', msg); }
}

const browser = await chromium.launch({ acceptDownloads: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

const text = (sel) => page.locator(sel).innerText();
const status = async () => ({
  frame: await text('#statusFrame'),
  phase: await text('#statusPhase'),
  instr: await text('#statusInstr'),
  core: await text('#statusCore'),
});
const logs = () => page.locator('.log-row').allInnerTexts();
const logRows = async () => (await logs()).map((s) => s.split('\n'));

async function loadSample(path) {
  await page.selectOption('#sampleSelect', path);
  await page.waitForTimeout(160);
}
async function runToEnd() {
  await page.click('#btnRun');
  await page.waitForFunction(() => {
    const el = document.getElementById('statusCore');
    return el && /结束|帧数|死锁|停止/.test(el.textContent);
  }, null, { timeout: 15000 });
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  // ---------------------------------------------------------- 1. 首屏
  ok((await page.title()) === '关卡协程调试台', '页面标题');
  ok(await page.locator('#codeList .code-row').count() > 0, '默认载入样例并渲染指令');
  ok((await page.locator('.slot').count()) === 32, '共享槽 32 格');
  ok((await page.locator('.fiber-row').count()) === 1, '初始 1 个协程');
  ok((await status()).instr === '0', '初始指令数为 0');

  // ---------------------------------------------------------- 2. 单步：样例
  // 样例：FORK→WAIT→EMIT→HALT / PUSH→STORE→HALT，事件 frame2 bell=7
  for (let i = 0; i < 3; i++) await page.click('#btnStep');
  const s3 = await status();
  ok(s3.instr === '3', `单步 3 次后执行 3 条（实际 ${s3.instr}）`);
  ok((await page.locator('.fiber-row').count()) === 2, 'FORK 后出现第 2 个协程');
  // 第 3 条是子协程 PUSH 9，此时槽未变
  ok((await page.locator('.slot .v').first().innerText()) === '0', '第 3 条尚未写槽');

  // 单步直到结束
  for (let i = 0; i < 20; i++) {
    const st = await status();
    if (!(await page.locator('#btnStep').isEnabled())) break;
    await page.click('#btnStep');
  }
  const rows = await logRows();
  ok(rows.length === 1, '单步运行只产生 1 条输出');
  ok(rows[0] && rows[0][0] === 'f2' && rows[0][2] === 'gate' && rows[0][3] === '7', '样例输出 f2 gate 7');
  ok((await page.locator('.slot .v').first().innerText()) === '9', '样例共享槽 s0 = 9');

  // ---------------------------------------------------------- 3. 连续运行与单步一致
  await loadSample('level-fibers.json');
  await runToEnd();
  const runRows = await logRows();
  ok(JSON.stringify(runRows) === JSON.stringify(rows), '连续运行输出与单步一致');
  ok((await status()).core.includes('结束'), '连续运行后状态为已结束');

  // ---------------------------------------------------------- 4. 同名事件只收首条
  await loadSample('cases/event-first-only.json');
  await runToEnd();
  const firstOnly = await logRows();
  ok(firstOnly.every((r) => r[3] === '1'), '同名事件两协程都只收首条值 1');

  // ---------------------------------------------------------- 5. 共享槽同帧可见
  await loadSample('cases/shared-same-frame.json');
  await runToEnd();
  const shared = await logRows();
  ok(shared.length === 2, '共享槽用例两条输出');
  ok(shared[1] && shared[1][3] === '42', '后运行协程读到同帧写入的 42');

  // ---------------------------------------------------------- 6. 有符号 32 位回绕
  await loadSample('cases/arith-wrap.json');
  await runToEnd();
  const wrap = await logRows();
  ok(wrap[0] && wrap[0][3] === '-2147483648', '2147483647+1 回绕为 -2147483648');
  ok(wrap[1] && wrap[1][3] === '2147483647', '-2147483648-1 回绕为 2147483647');

  // ---------------------------------------------------------- 7. 运行错误只结束故障协程
  await loadSample('cases/fault-isolates-fiber.json');
  await runToEnd();
  const faultText = await text('#faultList');
  ok(/帧 1 · 协程 1 · 指令 5/.test(faultText), '错误记录帧号/协程号/指令号');
  ok((await logRows()).some((r) => r[2] === 'ok'), '正常协程仍产出输出');

  // ---------------------------------------------------------- 8. 越界跳转拒绝导入并指出指令号
  await loadSample('cases/invalid/jump-out-of-range.json');
  await page.waitForTimeout(120);
  const dlgText = await text('#msgDialog');
  ok(dlgText.includes('导入被拒绝'), '越界跳转弹出拒绝对话框');
  ok(/指令\s*1/.test(dlgText), '拒绝信息指出指令号 1');
  await page.locator('#msgDialog [data-close]').click();
  // 原脚本不受影响：仍是上一个有效用例的指令
  ok((await page.locator('.code-row').count()) > 0, '拒绝导入不改动已载入脚本');

  // ---------------------------------------------------------- 9. 断点停在执行前 + 继续
  await loadSample('cases/call-per-fiber.json');
  await page.locator('.code-row .bp[data-pc="7"]').click();
  await page.click('#btnRun');
  await page.waitForFunction(() => document.getElementById('statusCore').textContent === '已暂停', null, { timeout: 8000 });
  const bpStatus = await status();
  ok(bpStatus.core === '已暂停', '断点处暂停');
  ok(/断点/.test(await text('#toast')), '断点提示可见');
  // 继续到结束
  await page.click('#btnContinue');
  await page.waitForFunction(() => /结束/.test(document.getElementById('statusCore').textContent), null, { timeout: 8000 });
  const afterBp = await logRows();
  ok(afterBp.length === 2, '断点后继续运行产生全部输出');

  // ---------------------------------------------------------- 10. 快照：帧中导出 → 恢复 → 续跑
  await loadSample('cases/sample-echo.json');
  await page.waitForTimeout(120);
  for (let i = 0; i < 4; i++) await page.click('#btnStep');
  const beforeSnap = await status();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSnapExport')]);
  const snapPath = join(tmp, 'snap.json');
  await dl.saveAs(snapPath);
  const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
  ok(snap.format === 'level-fiber-snapshot', '导出的快照格式正确');
  ok(snap.state.phase === 'run', '快照记录帧中阶段');

  const page2 = await ctx.newPage();
  const err2 = [];
  page2.on('pageerror', (e) => err2.push(e.message));
  await page2.goto(base, { waitUntil: 'networkidle' });
  await page2.waitForTimeout(250);
  await page2.setInputFiles('#fileInput', snapPath);
  await page2.waitForTimeout(250);
  ok((await page2.locator('#statusFrame').innerText()) === beforeSnap.frame, '恢复后帧号一致');
  ok((await page2.locator('#statusInstr').innerText()) === beforeSnap.instr, '恢复后指令数一致');
  await page2.click('#btnRun');
  await page2.waitForFunction(() => /结束/.test(document.getElementById('statusCore').textContent), null, { timeout: 8000 });
  const restoredLogs = await page2.locator('.log-row').allInnerTexts();
  await page.click('#btnRun');
  await page.waitForFunction(() => /结束/.test(document.getElementById('statusCore').textContent), null, { timeout: 8000 });
  const originalLogs = await logs();
  ok(JSON.stringify(restoredLogs) === JSON.stringify(originalLogs), '快照恢复续跑日志逐条相同');
  ok(err2.length === 0, '恢复页面无脚本错误');
  await page2.close();

  // ---------------------------------------------------------- 11. 快照自检
  await loadSample('cases/shared-same-frame.json');
  await page.waitForTimeout(120);
  await page.click('#selfCheckBtn');
  await page.waitForTimeout(1200);
  const selfCheck = await text('#msgDialog');
  ok(selfCheck.includes('全部切点续跑输出逐条相同'), '快照自检：全部切点一致');
  await page.locator('#msgDialog [data-close]').click();

  // ---------------------------------------------------------- 12. 对照 Python
  await loadSample('cases/call-per-fiber.json');
  await page.waitForTimeout(120);
  await page.click('#crossCheckBtn');
  await page.waitForTimeout(600);
  const cross = await text('#msgDialog');
  ok(cross.includes('两份实现逐项一致'), 'JS 与 Python 参考实现逐项一致');
  await page.locator('#msgDialog [data-close]').click();

  // ---------------------------------------------------------- 13. 性能基准
  await page.click('#benchBtn');
  await page.waitForTimeout(3500);
  const bench = await text('#msgDialog');
  ok(/1,000,003 条指令/.test(bench), '基准纯计算档执行约 100 万条指令');
  ok(/1,250,003 条指令/.test(bench), '基准带日志档执行约 125 万条指令');
  ok(bench.includes('通过'), '基准在 8 秒内完成');
  await page.locator('#msgDialog [data-close]').click();

  // ---------------------------------------------------------- 14. 响应式：窄屏无横向溢出、按钮可点
  for (const [w, h] of [[1024, 760], [390, 844]]) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForTimeout(300);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(!overflow, `${w}px 宽无横向溢出`);
    await p.click('#btnRun');
    await p.waitForTimeout(500);
    ok(errs.length === 0, `${w}px 宽无脚本错误`);
    await p.close();
  }

  ok(consoleErrors.length === 0, `主页面无控制台错误（${consoleErrors.slice(0, 3).join('; ')}）`);
} catch (e) {
  fail++;
  console.log('  EXCEPTION:', e.message);
} finally {
  await browser.close();
}

console.log(`\ne2e: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
