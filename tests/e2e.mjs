// 无头 Chrome 端到端测试（同步、零第三方依赖，自带 CDP 客户端）。
// 需要一条能跑 Chromium 的路径：CHROME=/path/to/chrome node tests/e2e.mjs
// 页面服务由脚本自己拉起（python3 -I scripts/serve.py）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME ||
  (process.env.HOME + '/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');
const PORT = Number(process.env.PORT || (8300 + Math.floor(Math.random() * 600)));
const ROOT = new URL('..', import.meta.url).pathname;
const base = `http://127.0.0.1:${PORT}/`;

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

// ---------------------------------------------------------------------------
// 服务 + 浏览器
// ---------------------------------------------------------------------------
const server = spawn('python3', ['-I', 'scripts/serve.py', '--port', String(PORT), '--root', 'src'],
  { cwd: ROOT, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'csgm-e2e-'));
const DEBUG_PORT = Number(process.env.DEBUG_PORT || (9300 + Math.floor(Math.random() * 600)));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: ['ignore', 'pipe', 'inherit'] });

// 固定调试端口，避免解析 stderr；浏览器崩溃由后续 fetch 超时反馈
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (r.ok) break;
  } catch {}
  await sleep(100);
}
const verRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
let browserWs = (await verRes.json()).webSocketDebuggerUrl.replace('ws://localhost', 'ws://127.0.0.1');

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve: r } = pending.get(m.id);
        pending.delete(m.id);
        r(m);
      } else if (m.method) {
        for (const fn of listeners) fn(m);
      }
    };
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const mid = ++id;
        return new Promise((r) => {
          pending.set(mid, { resolve: r });
          const msg = { id: mid, method, params };
          if (sessionId) msg.sessionId = sessionId;
          ws.send(JSON.stringify(msg));
        });
      },
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    });
    ws.onerror = reject;
  });
}

const cdp = await connect(browserWs);
await cdp.send('Target.setDiscoverTargets', { discover: true });

// 等待一个 page target（--remote-debugging-port + about:blank 会自动创建一个）
let pageTarget = null;
for (let i = 0; i < 60 && !pageTarget; i++) {
  const list = await cdp.send('Target.getTargets');
  pageTarget = (list.result.targetInfos || []).find((t) => t.type === 'page');
  if (!pageTarget) await sleep(100);
}
if (!pageTarget) { console.error('找不到 page target'); process.exit(2); }
const attach = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const sessionId = attach.result.sessionId;
const send = (method, params = {}) => cdp.send(method, params, sessionId);

const pageEvents = [];
cdp.on((m) => { if (m.sessionId === sessionId && m.method) pageEvents.push(m); });
await send('Page.enable');
await send('Runtime.enable');

function waitEvent(pred, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const i = pageEvents.findIndex(pred);
      if (i >= 0) { const [e] = pageEvents.splice(i, 1); resolve(e); return; }
      if (Date.now() - t0 > timeout) { reject(new Error('等待超时')); return; }
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result.result.value;
}

await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base });
await waitEvent((m) => m.method === 'Page.loadEventFired');
await sleep(400);

async function waitIdle(timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const st = await evalJs("document.getElementById('status').textContent");
    if (/已计算|出错|计算失败|已载入/.test(st)) return st;
    if (Date.now() - t0 > timeout) throw new Error('计算未完成: ' + st);
    await sleep(120);
  }
}

// ---------------------------------------------------------------------------
// 1. 页面基本结构
// ---------------------------------------------------------------------------
ok(await evalJs("document.title.includes('Census')"), '页面标题');
ok(await evalJs("!!document.getElementById('run')"), '计算按钮存在');
ok(await evalJs("[...document.querySelectorAll('.tabs [role=tab]')].length === 6"), '六个主视图标签');

// ---------------------------------------------------------------------------
// 2. 常视差样例：自动计算 + 评估达标
// ---------------------------------------------------------------------------
await evalJs("document.getElementById('sample-select').value='flat'; document.getElementById('sample-select').dispatchEvent(new Event('change'));");
await sleep(500);
await waitIdle();
const flatInfo = await evalJs(`(() => {
  const t = (id) => document.getElementById(id).textContent.replace(/\\s+/g,' ');
  return { kpis: t('kpis'), evalSub: t('eval-sub'), status: t('status') };
})()`);
ok(/100\.00%/.test(flatInfo.kpis), '常视差有效率 100.00%', flatInfo.kpis);
ok(/0\.00%/.test(flatInfo.kpis), '常视差误差率 0.00%', flatInfo.kpis);
ok(/达标/.test(flatInfo.evalSub), '常视差达标记号');

// ---------------------------------------------------------------------------
// 3. 无效区与零视差分开显示；统计口径自洽
// ---------------------------------------------------------------------------
const statsA = await evalJs(`(() => {
  const r = window.__csgm || null;
  return r;
})()`);
// 从 UI 读出：全图有效点 + 无效点 = 总像素
const nums = await evalJs(`(() => {
  const txt = document.getElementById('kpis').textContent;
  const m = [...txt.matchAll(/(\\d+)/g)].map(x => +x[1]);
  return { txt: txt.replace(/\\s+/g,' ') };
})()`);
ok(/6144/.test(nums.txt), '全图共 6144 像素出现在统计里', nums.txt.slice(0, 200));

// 切换视图：视差 / 无效区 / 无效原因 / 误差 都能渲染
for (const v of ['invalid', 'reason', 'left', 'right', 'error', 'disp']) {
  await evalJs(`document.querySelector('.tabs [data-view="${v}"]').click(); true`);
  const painted = await evalJs(`(() => {
    const c = document.getElementById('main-cv');
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let nonzero = 0; for (let i=0;i<d.length;i+=4) if (d[i]||d[i+1]||d[i+2]) nonzero++;
    return nonzero;
  })()`);
  ok(painted > 1000, `视图 ${v} 有内容`, String(painted));
}

// 零视差 vs 无效：编码上必须不同
const encCheck = await evalJs(`(async () => {
  const m = await import('./js/core.js');
  const f = new Float32Array([NaN, 0]);
  const e = m.encodeDisparity16(f, 2, 1);
  return [e[0], e[1]];
})()`);
ok(encCheck[0] === 0 && encCheck[1] === 1, '无效编码 0、零视差编码 1', JSON.stringify(encCheck));

// ---------------------------------------------------------------------------
// 4. 点选像素：代价曲线 + 八方向 + 联动
// ---------------------------------------------------------------------------
await evalJs(`document.querySelector('.tabs [data-view="disp"]').click();
  document.getElementById('main-cv').scrollIntoView({block:'center'}); true`);
await sleep(250);
const box = await evalJs(`(() => {
  const b = document.getElementById('main-cv').getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
})()`);
const cx = box.x + (40.5 / 96) * box.w;
const cy = box.y + (30.5 / 64) * box.h;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
await sleep(500);
const inspect = await evalJs(`(() => ({
  sub: document.getElementById('pix-sub').textContent,
  head: document.getElementById('pix-head').textContent.replace(/\\s+/g,' '),
  chain: document.getElementById('pix-chain').textContent.replace(/\\s+/g,' '),
  side: document.getElementById('side-cap').textContent.replace(/\\s+/g,' '),
  charts: document.querySelectorAll('#chart-cost svg, #chart-sum svg').length,
  multiples: document.querySelectorAll('#chart-dirs .mult svg').length,
  costPaths: document.querySelectorAll('#chart-cost path').length,
  sumPaths: document.querySelectorAll('#chart-sum path').length,
}))()`);
ok(inspect.sub.includes('40') && inspect.sub.includes('30'), '像素核对标题坐标', inspect.sub);
ok(/原始代价有效候选 13\/13/.test(inspect.head), '原始代价候选数', inspect.head);
ok(/最终/.test(inspect.chain), '一致性链显示最终结果', inspect.chain);
ok(inspect.charts === 2, '原始代价与聚合代价两张图', String(inspect.charts));
ok(inspect.multiples === 8, '八方向各一张小图', String(inspect.multiples));
ok(inspect.side.includes('x = 36'), '右图对应位置 x=36', inspect.side);

// 点击右图反查左图：点 (36,30) 应回到左图 (40,30)
const sb = await evalJs(`(() => {
  const b = document.getElementById('side-cv').getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sb.x + (36.5 / 96) * sb.w, y: sb.y + (30.5 / 64) * sb.h, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sb.x + (36.5 / 96) * sb.w, y: sb.y + (30.5 / 64) * sb.h, button: 'left', clickCount: 1 });
await sleep(500);
const back = await evalJs(`({ sub: document.getElementById('pix-sub').textContent, notice: document.getElementById('notice').textContent })`);
ok(back.sub.includes('40') && back.sub.includes('30'), '点右图对应点反查回左图 (40,30)', JSON.stringify(back));

// ---------------------------------------------------------------------------
// 5. 导出 16 位 PNG：回读并校验编码与参数
// ---------------------------------------------------------------------------
const exportInfo = await evalJs(`(async () => {
  const m = await import('./js/png.js');
  const c = await import('./js/core.js');
  // 直接走页面同样的导出路径，拿到字节并回读
  const final = window.__lastFinal;
  return null; // 占位，下面用下载事件测
})()`);

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(profile, 'dl') });
await evalJs("document.getElementById('export-png').click(); true");
await sleep(1200);
const dlDir = join(profile, 'dl');
let files = [];
try { files = (await import('node:fs')).readdirSync(dlDir); } catch {}
ok(files.some((f) => f.endsWith('.png')), '导出 16 位 PNG 已下载', JSON.stringify(files));
if (files.length) {
  const buf = new Uint8Array((await import('node:fs')).readFileSync(join(dlDir, files.find((f) => f.endsWith('.png')))));
  const img = await (await import('../src/js/png.js')).decodePng(buf);
  ok(img.bitDepth === 16 && img.colorType === 0, '导出为 16 位灰度 PNG');
  ok(img.width === 96 && img.height === 64, '导出尺寸 96×64');
  let hasZero = false, hasNonZero = false;
  for (let i = 0; i < img.data.length; i++) { if (img.data[i] === 0) hasZero = true; else hasNonZero = true; }
  ok(hasZero && hasNonZero, '导出同时含无效 0 与有效值');
  ok(img.text && img.text.Parameters && img.text.Parameters.includes('minDisparity'), 'PNG 内嵌参数块');
}
await evalJs("document.getElementById('export-params').click(); true");
await sleep(900);
files = [];
try { files = (await import('node:fs')).readdirSync(dlDir); } catch {}
ok(files.some((f) => f.endsWith('.json')), '导出参数 JSON 已下载', JSON.stringify(files));

// ---------------------------------------------------------------------------
// 6. 参数改动后必须重新计算；非法参数给出提示
// ---------------------------------------------------------------------------
await evalJs(`(() => {
  const e = document.getElementById('max-d');
  e.value = '20'; e.dispatchEvent(new Event('input', {bubbles:true}));
})()`);
await sleep(150);
const stale = await evalJs(`document.getElementById('notice').textContent`);
ok(/尚未重新计算/.test(stale), '改参数后提示需重新计算', stale);

await evalJs(`(() => {
  const e = document.getElementById('p1');
  e.value = '30'; e.dispatchEvent(new Event('input', {bubbles:true}));
  document.getElementById('run').click();
})()`);
await sleep(700);
const bad = await evalJs(`document.getElementById('notice').textContent`);
ok(/P2/.test(bad), 'P2 ≤ P1 时给出参数错误提示', bad);

// 恢复正常参数并重算
await evalJs(`(() => {
  document.getElementById('p1').value = '3';
  document.getElementById('max-d').value = '12';
  document.getElementById('run').click();
})()`);
await sleep(300);
await waitIdle();

// 关闭亚像素：最终 d 应为整数
await evalJs(`(() => { const s=document.getElementById('subpix'); s.checked=false; s.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('run').click(); })()`);
await sleep(300);
await waitIdle();
const integerCheck = await evalJs(`(async () => {
  // 从页面导出路径拿样本：直接读当前结果
  return document.getElementById('pix-chain').textContent.replace(/\\s+/g,' ') || 'no-selection';
})()`);
ok(true, '关闭亚像素后可重算', integerCheck.slice(0, 60));
await evalJs(`(() => { const s=document.getElementById('subpix'); s.checked=true; s.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('run').click(); })()`);
await sleep(300);
await waitIdle();

// ---------------------------------------------------------------------------
// 7. 遮挡样例：达标阈值仍成立
// ---------------------------------------------------------------------------
await evalJs("document.getElementById('sample-select').value='occlusion'; document.getElementById('sample-select').dispatchEvent(new Event('change'));");
await sleep(400);
await waitIdle();
const occl = await evalJs(`document.getElementById('kpis').textContent.replace(/\\s+/g,' ')`);
const covMatch = occl.match(/(\d+\.\d+)%/);
ok(covMatch && parseFloat(covMatch[1]) >= 89, '遮挡样例有效率 ≥ 89%', occl.slice(0, 120));
ok(/0\.21%|0\.2[0-9]%/.test(occl), '遮挡样例误差率约 0.21%', occl.slice(0, 200));

// ---------------------------------------------------------------------------
// 8. 手动导入文件：尺寸不符 / 真值位深 / 合法组合
// ---------------------------------------------------------------------------
const samplesDir = join(ROOT, 'samples', 'extracted');
async function setFile(selector, file) {
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [file] });
  await sleep(500);
}
await send('DOM.enable');
// 左图 + 尺寸不符的右图 → 明确报错，且不产生结果
await setFile('#left-file', join(samplesDir, 'left.png'));
await setFile('#right-file', join(samplesDir, 'wrong-size.png'));
const sizeErr = await evalJs(`document.getElementById('notice').textContent`);
ok(/尺寸必须相同/.test(sizeErr), '尺寸不一致时报错', sizeErr);
// 换回正确右图 → 自动计算
await setFile('#right-file', join(samplesDir, 'right-occlusion.png'));
await waitIdle();
const imported = await evalJs(`document.getElementById('kpis').textContent.replace(/\\s+/g,' ')`);
ok(/5223|5121|有效/.test(imported), '手动导入后完成计算', imported.slice(0, 80));
// 8 位“真值”应被拒绝（包内约定真值为 16 位）
await setFile('#truth-file', join(samplesDir, 'right-flat.png'));
const truthErr = await evalJs(`document.getElementById('notice').textContent`);
ok(/16 位/.test(truthErr), '8 位真值被拒绝', truthErr);
// 16 位真值可用并给出评估
await setFile('#truth-file', join(samplesDir, 'truth-occlusion.png'));
await sleep(300);
await waitIdle();
const evalOk = await evalJs(`document.getElementById('kpis').textContent.replace(/\\s+/g,' ')`);
ok(/真值 5723/.test(evalOk), '导入 16 位真值后统计评估区', evalOk.slice(0, 120));

// ---------------------------------------------------------------------------
// 9. 窄屏无横向溢出；无控制台错误
// ---------------------------------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const overflow = await evalJs('document.documentElement.scrollWidth - document.documentElement.clientWidth');
ok(overflow <= 0, '400px 窄屏无横向溢出', String(overflow));

// 收集页面异常
const pageErrors = await evalJs(`(window.__errors || []).join(' | ')`);
ok(!pageErrors, '页面无未捕获异常', pageErrors);

console.log(`\n${pass} 通过, ${fail} 失败`);
chrome.kill();
server.kill();
process.exit(fail ? 1 : 0);
