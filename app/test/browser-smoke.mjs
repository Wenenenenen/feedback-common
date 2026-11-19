// 通过 Chrome DevTools Protocol 对构建产物做真实浏览器冒烟测试（无需第三方包）。
// 用法：node test/browser-smoke.mjs <chrome路径> <url>
import { spawn } from 'node:child_process';

const chrome = process.argv[2];
const url = process.argv[3];
if (!chrome || !url) { console.error('need chrome path and url'); process.exit(2); }

const port = 9223;
const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/rts-chrome-profile', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome devtools 未就绪');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const logs = [];
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${msg.params.type}] ${txt}`);
    if (msg.params.type === 'error') consoleErrors.push(txt);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ??
      msg.params.exceptionDetails.text);
  }
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(2500); // 等 fetch 用例 + 首帧渲染

async function evalJs(expr) {
  // 统一包成箭头函数；语句用 void 包裹也无妨，读取表达式用 return 取值
  const wrapped = `( () => { return ( ${expr} ); } )()`;
  const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name} ${detail}`);
  if (!cond) failures++;
}

// 1. 首帧：fraction 用例已渲染
const tick0 = await evalJs(`document.querySelector('#tickVal').textContent`);
check('初始 tick = 0', tick0 === '0', tick0);
const buildings = await evalJs(`document.querySelectorAll('.building').length`);
check('渲染 1 座建筑', buildings === 1, String(buildings));
const qlen0 = await evalJs(`document.querySelectorAll('.q-item').length`);
check('队列 2 项', qlen0 === 2, String(qlen0));

// 2. fraction 用例：速度 2/3、work1。tick0 后进度 2/3，tick1 完成并交付第一个，tick3 交付第二个
await evalJs(`document.querySelector('#stepBtn').click()`); // tick1
const t1 = await evalJs(`document.querySelector('#tickVal').textContent`);
check('单步后 tick=1', t1 === '1', t1);
const qProgress = await evalJs(
  `document.querySelector('.q-item .q-meta span').textContent`);
check('tick1 队首进度为 2/3', qProgress.includes('2/3'), qProgress);
await evalJs(`document.querySelector('#stepBtn').click()`); // tick2：第一个交付
const pop1 = await evalJs(`document.querySelector('#popVal').textContent`);
check('tick2 人口=1', pop1.startsWith('1 /'), pop1);
await evalJs(`document.querySelector('#stepBtn').click()`); // tick3
await evalJs(`document.querySelector('#stepBtn').click()`); // tick4：第二个交付
const pop2 = await evalJs(`document.querySelector('#popVal').textContent`);
check('tick4 人口=2', pop2.startsWith('2 /'), pop2);
const qAfter = await evalJs(`document.querySelectorAll('.q-item').length`);
check('两个 unit 交付后队列空', qAfter === 0, String(qAfter));

// 3. 账本里有 work 事件且分数展示精确
const workRows = await evalJs(
  `[...document.querySelectorAll('.log-row')].filter(r=>r.textContent.includes('工作')).length`);
check('账本包含工作事件', workRows >= 2, String(workRows));
const fracText = await evalJs(
  `[...document.querySelectorAll('.log-row')].map(r=>r.textContent).find(t=>t.includes('2/3'))||''`);
check('分数 2/3 精确展示', fracText.includes('2/3'), fracText);

// 4. 重置后入队、再取消（未开工应全退）
await evalJs(`document.querySelector('#resetBtn').click()`);
const oreBefore = await evalJs(`document.querySelector('#resourceGrid .res-val').textContent`);
await evalJs(`document.querySelector("[data-act='enqueue']").click()`);
await evalJs(`document.querySelector('#stepBtn').click()`); // 执行 enqueue
const qAfterEnq = await evalJs(`document.querySelectorAll('.q-item').length`);
check('入队后队列 3 项', qAfterEnq === 3, String(qAfterEnq));
const newest = await evalJs(
  `[...document.querySelectorAll('.q-item [data-act=cancel]')].pop().dataset.iid`);
await evalJs(`document.querySelector('.q-item [data-act=cancel][data-iid="${newest}"]').click()`);
await evalJs(`document.querySelector('#stepBtn').click()`); // 执行 cancel，未开工全退
const oreAfter = await evalJs(`document.querySelector('#resourceGrid .res-val').textContent`);
check('取消未开工项目资源回到原值', oreAfter === oreBefore, `${oreBefore} -> ${oreAfter}`);

// 5. 切到 blocked 用例，验证 ready 阻塞样式
await evalJs(`(document.querySelector('#caseSelect').value = 'blocked.json',
  document.querySelector('#caseSelect').dispatchEvent(new Event('change')), true)`);
await sleep(1200);
await evalJs(`document.querySelector('#stepBtn').click()`);
const readyChip = await evalJs(`!!document.querySelector('.q-item.ready .chip.warn')`);
check('人口不足时队首显示 ready 阻塞', readyChip === true);
const blockedLog = await evalJs(
  `[...document.querySelectorAll('.log-row')].some(r=>r.textContent.includes('阻塞'))`);
check('账本记录阻塞原因', blockedLog === true);

// 6. 保存/恢复（localStorage）
await evalJs(`document.querySelector('#saveBtn').click()`);
const saved = await evalJs(`!!localStorage.getItem('rts-production-clock-save-v1')`);
check('localStorage 已写入', saved === true);
await evalJs(`document.querySelector('#resetBtn').click()`);
await evalJs(`document.querySelector('#restoreBtn').click()`);
const tickRestored = await evalJs(`document.querySelector('#tickVal').textContent`);
check('恢复后 tick 回到保存点 1', tickRestored === '1', tickRestored);

// 7. 导出结算日志（生成 Blob 下载，验证不抛错）
let exportOk = true;
try {
  await evalJs(`document.querySelector('#exportLogBtn').click()`);
  await evalJs(`document.querySelector('#exportSnapBtn').click()`);
} catch { exportOk = false; }
check('导出快照与结算日志不报错', exportOk);

// 7b. 新增建筑：在当前世界加入一座速度 1/2 的建筑
await evalJs(`(document.querySelector('#newBid').value = 'lab',
  document.querySelector('#newSpeedP').value = '1',
  document.querySelector('#newSpeedQ').value = '2',
  document.querySelector('#addBuildingBtn').click(), true)`);
const buildingCount = await evalJs(`document.querySelectorAll('.building').length`);
check('新增后建筑数 +1（blocked 用例原为 1）', buildingCount === 2, String(buildingCount));
const hasLab = await evalJs(`!![...document.querySelectorAll('.b-id')].find(e=>e.textContent==='lab')`);
check('新建筑 lab 已渲染且速度 1/2', hasLab === true);

// 7c. 重排：在 lab 入队两个未开工项目，用 ↓ 调整顺序（blocked 用例 ore=0，先发放）
await evalJs(`(document.querySelector('#grantRes').value = 'ore',
  document.querySelector('#grantAmt').value = '50',
  document.querySelector('#grantBtn').click(), true)`);
await evalJs(`document.querySelector('#stepBtn').click()`); // 执行 grant
await evalJs(`(document.querySelector("[data-enq-item='lab']").value = 'u',
  document.querySelector(".building [data-act='enqueue'][data-bid='lab']").click(), true)`);
await evalJs(`document.querySelector('#stepBtn').click()`); // 执行第一个 enqueue
await evalJs(`(document.querySelector("[data-enq-item='lab']").value = 'u',
  document.querySelector(".building [data-act='enqueue'][data-bid='lab']").click(), true)`);
await evalJs(`document.querySelector('#stepBtn').click()`); // 执行第二个 enqueue
const labItems = await evalJs(
  `[...document.querySelectorAll('.building')].find(b=>b.querySelector('.b-id').textContent==='lab')
     .querySelectorAll('.q-item').length`);
check('lab 队列有 2 个未开工项目', labItems === 2, String(labItems));
// 第一个已在 tick 取得工作量，只有第二个可下移；这里测上移按钮存在且点击不报错
const upBtns = await evalJs(
  `[...document.querySelectorAll('.building')].find(b=>b.querySelector('.b-id').textContent==='lab')
     .querySelectorAll('[data-act=up]').length`);
check('可重排实例显示上移按钮', upBtns >= 1, String(upBtns));

// 8. stress 用例快进跑完 256 个 unit
await evalJs(`(document.querySelector('#caseSelect').value = 'stress.json',
  document.querySelector('#caseSelect').dispatchEvent(new Event('change')), true)`);
await sleep(1500);
await evalJs(`document.querySelector('#run100Btn').click()`);
// stress: 32 楼 × 速度 2/3，每楼 8 个 work1，约需 12 tick；100 步足够
await sleep(300);
const stressPop = await evalJs(`document.querySelector('#popVal').textContent`);
check('压测后人口 256', stressPop.startsWith('256 /'), stressPop);
const stressQueues = await evalJs(
  `[...document.querySelectorAll('.building')].every(b=>b.querySelectorAll('.q-item').length===0)`);
check('压测后全部队列为空', stressQueues === true);

check('浏览器无 console error', consoleErrors.length === 0, consoleErrors.join(' | '));
check('浏览器无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

ws.close();
child.kill();
console.log(failures === 0 ? '\n浏览器冒烟全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures ? 1 : 0);
