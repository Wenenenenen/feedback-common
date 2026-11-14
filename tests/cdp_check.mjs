// 零依赖 CDP 端到端测试：驱动无头 Chrome 加载真实页面，
// 验证 Worker 分带渲染、Canvas 像素、像素检查、错误保帧与帧去重。
// 用法：node tests/cdp_check.mjs <chrome 可执行> <base-url>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const invalidSceneText = readFileSync(
  new URL('../samples/extracted/invalid-duplicate.json', import.meta.url), 'utf8');

const chrome = process.argv[2];
const base = process.argv[3] || 'http://localhost:8000/';
// 可选第 4 参：CDP HTTP 基址（经 WSL->Windows 中继时与浏览器地址不同）
const cdpHttp = process.argv[4] || null;
const debugPort = Number(process.argv[5] || 9222);
if (!chrome) { console.error('用法: node cdp_check.mjs <chrome> [url] [cdp-http-base] [debug-port]'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
let proc = null;
// 经中继时 Chrome 已由编排脚本启动；仅当中继不可达才自启动
if (!cdpHttp) {
  proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const endpoint = cdpHttp ? `${cdpHttp}/json/version` : 'http://127.0.0.1:9222/json/version';
      const r = await fetch(endpoint);
      if (r.ok) {
        const info = await r.json();
        if (cdpHttp) {
          // 把 ws://127.0.0.1:9222/... 替换为中继基址（同源同路径）
          const u = new URL(info.webSocketDebuggerUrl);
          const relay = new URL(cdpHttp);
          u.host = relay.host;
          return u.toString();
        }
        return info.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools 未就绪');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
function send(method, params = {}, sid) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const msg = { id, method, params };
    if (sid) msg.sessionId = sid;   // flatten 模式：sessionId 在消息顶层
    ws.send(JSON.stringify(msg));
  });
}
const waitFor = async (pred, timeout = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const i = events.findIndex((e) => pred(e));
    if (i >= 0) return events.splice(i, 1)[0];
    if (Date.now() - t0 > timeout) {
      const summary = events.slice(-12).map((e) => e.method + (e.sessionId ? '@' + e.sessionId.slice(0, 4) : ''));
      throw new Error('等待事件超时 ' + pred.toString().slice(0, 50) + ' | 队列: ' + JSON.stringify(summary));
    }
    await sleep(50);
  }
};

await send('Target.setDiscoverTargets', { discover: true });
const { targetId } = (await waitFor((e) => e.method === 'Target.targetCreated' && e.params.targetInfo.type === 'page')).params.targetInfo;
const attached = await send('Target.attachToTarget', { targetId, flatten: true });
const sessionId = attached.result.sessionId;
const ssend = (method, params) => send(method, params, sessionId);
const swaitFor = (pred, to) => waitFor((e) => e.sessionId === sessionId && pred(e), to);

await ssend('Page.enable');
await ssend('Runtime.enable');
await ssend('Page.navigate', { url: base });
await swaitFor((e) => e.method === 'Page.loadEventFired', 15000);
await sleep(500);

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

async function evalJs(expr, awaitPromise = true) {
  const r = await ssend('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise,
  });
  if (r.result.exceptionDetails)
    throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result.result.value;
}

// 控制台错误收集
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown')
    consoleErrors.push('未捕获: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});

// 1) 加载 crossing 并等待状态出现 512
await evalJs(`(async () => {
  const sel = document.getElementById('sample-select');
  sel.value = 'crossing.json';
  sel.dispatchEvent(new Event('change'));
  for (let i = 0; i < 100; i++) {
    if (document.getElementById('status').textContent.includes('512')) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('首帧未完成');
})()`);
ok(true, 'Worker 渲染首帧完成（真实浏览器）');

// 2) Canvas 像素与 expected (192,300)=[188,0,137]
const px = await evalJs(`(() => {
  const c = document.getElementById('view');
  const g = c.getContext('2d');
  const d = g.getImageData(192, 300, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
})()`);
ok(JSON.stringify(px.slice(0, 3)) === '[188,0,137]' && px[3] === 255, 'Canvas 像素 crossing(192,300)=[188,0,137],a=255', JSON.stringify(px));

// 3) 点击像素，检查片元表（近→远 id 1,2，含 rgba/depth/合成值）
const inspect = await evalJs(`(async () => {
  const c = document.getElementById('view');
  const r = c.getBoundingClientRect();
  const ev = new MouseEvent('click', {
    clientX: r.left + (192.5 / c.width) * r.width,
    clientY: r.top + (300.5 / c.height) * r.height, bubbles: true,
  });
  c.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 100));
  const rows = [...document.querySelectorAll('#inspect-panel tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].map(td => td.textContent));
  return { rows, text: document.getElementById('inspect-panel').textContent };
})()`);
ok(inspect.rows.length === 2 && inspect.rows[0][1] === '1' && inspect.rows[1][1] === '2',
  '点击 (192,300) 得到由近到远 id [1,2] 两个片元', JSON.stringify(inspect.rows));
ok(inspect.text.includes('该层合成值'), '检查面板含每片元合成值');

// 4) 不透明遮挡仍保留后方片元（occlusion: 3 层，最后一层在不透明面后）
await evalJs(`(async () => {
  const sel = document.getElementById('sample-select');
  sel.value = 'occlusion.json';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 1500));
})()`);
const occ = await evalJs(`(() => {
  const c = document.getElementById('view');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + (192.5 / c.width) * r.width,
    clientY: r.top + (300.5 / c.height) * r.height, bubbles: true,
  }));
  return [...document.querySelectorAll('#inspect-panel tbody tr')].map(tr => tr.querySelectorAll('td')[1].textContent);
})()`);
ok(JSON.stringify(occ) === '["41","42","43"]', '不透明面后片元保留：occlusion 三层 id [41,42,43]', JSON.stringify(occ));

// 5) 非法文件导入：保留上一帧（status 尺寸不变 + 错误条出现）
const before = await evalJs(`document.getElementById('status').textContent`);
await evalJs(`;(async () => {
  const dup = ${JSON.stringify(invalidSceneText)};
  const file = new File([dup], 'invalid-duplicate.json', { type: 'application/json' });
  const input = document.getElementById('file-input');
  // 构造最小 FileList 并直接定义到 input，绕开无头环境受限的 DataTransfer
  const fileList = { 0: file, length: 1, item: (i) => (i === 0 ? file : null) };
  Object.defineProperty(input, 'files', { value: fileList, configurable: true });
  input.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
})()`);
const after = await evalJs(`(() => ({
  status: document.getElementById('status').textContent,
  errShown: document.getElementById('error').classList.contains('show') || document.getElementById('error').textContent.length > 0,
}))()`);
ok(after.status === before && after.errShown, '非法输入拒绝且保留上一帧', JSON.stringify(after));

// 6) 帧去重：快速连续改尺寸，最终只渲染最新尺寸
const finalSize = await evalJs(`(async () => {
  const sel = document.getElementById('size-select');
  for (const s of ['64', '128', '256']) { sel.value = s; sel.dispatchEvent(new Event('change')); }
  // 放宽轮询：经中继时 Worker 连接需要排队，给足时间
  for (let i = 0; i < 400; i++) {
    if (document.getElementById('status').textContent.startsWith('256')) return 256;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
})()`);
ok(finalSize === 256, '连续变更只提交最新帧（最终 256）', String(finalSize));

// 7) 尺寸边界：选项恰为 64..1024
const sizes = await evalJs(`[...document.getElementById('size-select').options].map(o => Number(o.value))`);
ok(sizes[0] === 64 && sizes[sizes.length - 1] === 1024 && sizes.every((s, i) => i === 0 || s > sizes[i - 1]),
  '输出尺寸覆盖 64 至 1024 且递增', JSON.stringify(sizes));

// 8) 1024 也能渲染
const big = await evalJs(`(async () => {
  const sel = document.getElementById('size-select');
  sel.value = '1024'; sel.dispatchEvent(new Event('change'));
  for (let i = 0; i < 400; i++) {
    if (document.getElementById('status').textContent.startsWith('1024'))
      return document.getElementById('status').textContent;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
})()`);
ok(!!big && big.startsWith('1024'), '1024×1024 可渲染', String(big));

// 9) PNG 编码：直接复用页面同模块的编码器，校验魔数，不经 blob/网络
const pngHead = await evalJs(`(async () => {
  const pngMod = await import('/js/png.js');
  const frame = window.__frameForTest || null;
  // 用一个最小已知缓冲验证编码输出的 PNG 签名
  const rgb = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const bytes = pngMod.encodePng(rgb, 2, 2);
  return [...bytes.slice(0, 8)];
})()`);
ok(JSON.stringify(pngHead) === '[137,80,78,71,13,10,26,10]', 'PNG 编码器输出签名正确', JSON.stringify(pngHead));

// 10) 计算期间页面可响应：渲染中状态文本可被同步读取（不阻塞主线程）
const responsive = await evalJs(`(async () => {
  const sel = document.getElementById('size-select');
  sel.value = '512'; sel.dispatchEvent(new Event('change'));
  // 立即同步交互：更新 hover 坐标显示
  const c = document.getElementById('view');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 3, clientY: r.top + 5, bubbles: true }));
  const immediate = document.getElementById('hover-coord').textContent;
  for (let i = 0; i < 100; i++) {
    if (document.getElementById('status').textContent.startsWith('512')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return immediate;
})()`);
ok(responsive.includes('像素'), '渲染期间主线程仍响应交互', responsive);

ok(consoleErrors.length === 0, '浏览器控制台无错误', consoleErrors.join(' | '));

console.log(`\n${pass} 通过, ${fail} 失败`);
if (proc) proc.kill();
process.exit(fail ? 1 : 0);
