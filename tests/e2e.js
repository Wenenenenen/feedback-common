/* 端到端测试：无头 Chromium 驱动真实页面（node tests/e2e.js） */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok - ' + name); }
  else { failures++; console.error('FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}

function makeChain(N, witnessAt) {
  const events = new Array(N);
  for (let i = 0; i < N; i++) {
    events[i] = {
      id: 'e' + i, frame: i,
      kind: i === witnessAt ? 'boom' : 'idle',
      deps: i === 0 ? [] : ['e' + (i - 1)],
    };
  }
  return {
    initial: { s: 0 }, observe: ['s'],
    old: { boom: [[null, 'add', 's', 1]] },
    next: { boom: [[null, 'add', 's', 2]] },
    events,
  };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(PAGE);

  // 1. 样本载入并锁定见证
  await page.click('#sampleBtn');
  await page.click('#loadBtn');
  await page.waitForSelector('#witnessCard:not([hidden])');
  const witText = await page.textContent('#witnessGrid');
  check('样本见证事件号 #1', /#1/.test(witText));
  check('样本见证字段 score', /score/.test(witText));
  check('样本见证符号 +', /\+/.test(witText));
  check('旧→新值 2 → 3', /2\s*→\s*3/.test(witText));
  check('三项锁定标记存在', (await page.$$eval('#lockCheck .item', (els) => els.length)) === 3);

  // 2. 缩减到 2 事件
  await page.click('#startBtn');
  await page.waitForSelector('#runPill.pill.ok', { timeout: 8000 });
  const kept = await page.textContent('#stKept');
  check('样本缩减后保留 2 个事件', kept.trim() === '2', kept);
  const roundsText = await page.textContent('#roundsBody');
  check('轮次日志含判定文案', /接受|拒绝/.test(roundsText));
  check('试删范围显示原事件号', /#0|#1|#2/.test(roundsText));

  // 3. 独立重演校验
  await page.click('#verifyBtn');
  const verifyText = await page.textContent('#verifyBox');
  check('独立重演三项一致', /三项完全一致/.test(verifyText), verifyText);

  // 4. 导出重演包：JSON 可解析、自洽、可重新导入
  await page.click('#buildExportBtn');
  const exportRaw = await page.inputValue('#exportBox');
  const exp = JSON.parse(exportRaw);
  check('导出 schema 正确', exp.schema === 'replay-witness-shrink/1');
  check('导出事件数=2', exp.events.length === 2);
  check('导出自校验通过', exp.verification.witnessReproduced === true);
  check('导出保留原帧', exp.events[0].frame === 0 && exp.events[1].frame === 2);
  check('导出含完整规则', !!exp.source.old && !!exp.source.next && Array.isArray(exp.source.observe));
  check('导出含缩减统计', exp.shrink.trials >= 1);

  // 重新导入重演包
  await page.fill('#jsonInput', exportRaw);
  await page.click('#loadBtn');
  await wait(100);
  const reWit = await page.textContent('#witnessGrid');
  check('重演包重新导入仍锁定 #1/score/+', /#1/.test(reWit) && /score/.test(reWit));

  // 5. 坏依赖：指出事件号与依赖 id
  const bad = JSON.parse(JSON.stringify(JSON.parse(await page.inputValue('#jsonInput'))));
  bad.events[1].deps = ['ghost'];
  await page.fill('#jsonInput', JSON.stringify(bad));
  await page.click('#loadBtn');
  const errText = await page.textContent('#errList');
  check('坏依赖指出事件号', /事件 #1/.test(errText), errText);
  check('坏依赖指出依赖 id', /ghost/.test(errText), errText);

  // 6. 无差异提示
  const noDiffDoc = makeChain(3, -1);
  noDiffDoc.next = JSON.parse(JSON.stringify(noDiffDoc.old));
  await page.fill('#jsonInput', JSON.stringify(noDiffDoc));
  await page.click('#loadBtn');
  check('无差异提示出现', await page.isVisible('#noDiffBox'));
  check('无差异时开始按钮禁用', await page.isDisabled('#startBtn'));

  // 7. 5 万单链、差异在链尾：8 秒内完成并可导出
  const big = makeChain(50000, 49999);
  await page.fill('#jsonInput', JSON.stringify(big));
  await page.click('#loadBtn');
  const t0 = Date.now();
  await page.click('#startBtn');
  await page.waitForSelector('#runPill.pill.ok', { timeout: 15000 });
  const elapsed = Date.now() - t0;
  check('5 万链 8 秒内完成（实际 ' + elapsed + 'ms）', elapsed < 8000);
  const bigKept = await page.textContent('#stKept');
  check('5 万链无法再缩减，保留 50000', bigKept.trim() === '50000', bigKept);
  const bigTrials = await page.textContent('#stTrials');
  check('试删次数过万', Number(bigTrials.trim()) > 40000, bigTrials);
  await page.click('#buildExportBtn');
  const tExp0 = Date.now();
  const bigExport = await page.inputValue('#exportBox');
  const tExp = Date.now() - tExp0;
  const bigParsed = JSON.parse(bigExport);
  check('5 万导出包可解析且自校验通过', bigParsed.verification.witnessReproduced === true && bigParsed.events.length === 50000);
  check('导出生成在 2 秒内（' + tExp + 'ms）', tExp < 2000);

  // 8. 取消：保留上一份可重演结果（用非链 DAG 制造足够的取消窗口）
  const N8 = 20000;
  const cancelEvents = new Array(N8);
  for (let i = 0; i < N8; i++) {
    const deps = [];
    if (i > 0) deps.push('e' + (i - 1));
    if (i === 3) deps.push('e1'); // 钻石，破坏单链，走通用试删路径
    cancelEvents[i] = { id: 'e' + i, frame: i, kind: i === N8 - 1 ? 'boom' : 'idle', deps };
  }
  const cancelDoc = {
    initial: { s: 0 }, observe: ['s'],
    old: { boom: [[null, 'add', 's', 1]] },
    next: { boom: [[null, 'add', 's', 2]] },
    events: cancelEvents,
  };
  await page.fill('#jsonInput', JSON.stringify(cancelDoc));
  await page.click('#loadBtn');
  await page.click('#startBtn');
  await page.waitForSelector('#cancelBtn:not([disabled])', { timeout: 5000 });
  await page.click('#cancelBtn');
  await page.waitForSelector('#runPill.pill.warn', { timeout: 10000 });
  const cancelKept = Number((await page.textContent('#stKept')).trim());
  check('取消后保留数量有效（1..20000）', cancelKept >= 1 && cancelKept <= N8, String(cancelKept));
  await page.click('#verifyBtn');
  const cancelVerify = await page.textContent('#verifyBox');
  check('取消结果可独立重演', /三项完全一致/.test(cancelVerify), cancelVerify);

  check('页面无 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  if (failures) { console.error('\n' + failures + ' 个端到端检查失败'); process.exitCode = 1; }
  else console.log('\n全部端到端检查通过');
})().catch((e) => { console.error(e); process.exitCode = 1; });
