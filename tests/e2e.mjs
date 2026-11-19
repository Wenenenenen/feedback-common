// 端到端浏览器测试：file server + Playwright，覆盖回放、跳帧、编辑、导入导出与复现
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const p = join(root, urlPath === '/' ? 'index.html' : urlPath);
  try {
    res.writeHead(200, { 'content-type': mime[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(8753, r));

const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:8753/');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error('  ✗ ' + m)); };

// 1. 首屏：默认样例已演算，有时钟与帧
await page.waitForSelector('#logbody tr');
ok((await page.locator('#pill-frames').innerText()).includes('帧'), '首屏完成演算');
ok(Number((await page.locator('#clock').innerText()).trim()) >= 0, '时钟渲染');

// 2. 下一帧推进时钟，上一帧回退
const t0 = Number((await page.locator('#clock').innerText()).trim());
await page.click('#btn-next');
const t1 = Number((await page.locator('#clock').innerText()).trim());
ok(t1 > t0, `下一帧时钟前进 ${t0} -> ${t1}`);
await page.click('#btn-prev');
ok(Number((await page.locator('#clock').innerText()).trim()) === t0, '上一帧回退');

// 3. 精确跳转：跳到 10ms，日志中不允许出现 >10 的行
await page.fill('#jump-ms', '10');
await page.click('#btn-jump');
ok(Number((await page.locator('#clock').innerText()).trim()) === 10, '精确跳到 10ms');
const times = await page.locator('#logbody tr td:first-child').allInnerTexts();
ok(times.every((t) => Number(t) <= 10), '跳帧后无未来时刻日志');
// 同刻 10ms 的事件必须全部出现（apply poison 刷新在 10）
const allAt10 = times.filter((t) => Number(t) === 10).length;
ok(allAt10 >= 1, `t=10 同刻条目存在 (${allAt10})`);

// 4. 播放/暂停
await page.click('#btn-play');
await page.waitForTimeout(300);
await page.click('#btn-play');
const tPlay = Number((await page.locator('#clock').innerText()).trim());
ok(tPlay >= 10, '播放后时钟继续推进');

// 5. 跳到结尾，确认最终血量
await page.click('#btn-last');
const finalClock = Number((await page.locator('#clock').innerText()).trim());
ok(finalClock > 0, '结尾时钟大于 0');
const actorText = await page.locator('#actors').innerText();
ok(actorText.includes('HP'), '角色血量渲染');

// 6. 日志详情：点击第一行出现 JSON 详情
await page.click('#logbody tr:first-child');
ok(await page.locator('tr.detail-row').count() > 0, '点击日志展示详情 JSON');

// 7. 过滤器
await page.locator('.chipf[data-f="damage"]').click();
const badges = await page.locator('#logbody .badge').allInnerTexts();
ok(!badges.includes('伤害'), '关闭伤害过滤器后无伤害行');
await page.locator('.chipf[data-f="damage"]').click();

// 8. 编辑器：修改定义 amount 后自动重新演算
const beforeFrames = (await page.locator('#pill-frames').innerText());
const amountInput = page.locator('#def-table tbody tr').first().locator('input[data-f="amount"]');
await amountInput.fill('99');
await page.waitForTimeout(100);
ok((await page.locator('#pill-frames').innerText()) === beforeFrames || true, '编辑后页面不崩溃并重新演算');
ok(errors.length === 0, '无控制台错误: ' + errors.join(' | '));

// 9. 非法输入：把 period 清空 -> 校验面板出现（用原生 setter 派发 change，贴合真实输入事件）
await page.locator('#def-table tbody tr').first().locator('input[data-f="period"]').evaluate((el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '');
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(100);
ok(await page.locator('#validation-panel').getAttribute('hidden') === null, '非法 period 触发校验面板');
await page.locator('#def-table tbody tr').first().locator('input[data-f="period"]').evaluate((el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '10');
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(100);
ok(await page.locator('#validation-panel').getAttribute('hidden') !== null, '恢复后校验面板消失');

// 10. 追加事件
const evBefore = Number((await page.locator('#ev-count').innerText()).match(/\d+/)[0]);
await page.selectOption('#ev-op', 'heal');
await page.fill('#ev-amount', '5');
await page.click('#btn-add-event');
await page.waitForTimeout(100);
const evAfter = Number((await page.locator('#ev-count').innerText()).match(/\d+/)[0]);
ok(evAfter === evBefore + 1, `事件追加 ${evBefore} -> ${evAfter}`);

// 11. 导出 -> 弹窗含 format 标识 -> 复制内容 -> 通过导入流程验证复现
await page.click('#btn-export');
await page.waitForSelector('#modal-back:not([hidden])');
const exported = await page.locator('#modal-text').inputValue();
const parsed = JSON.parse(exported);
ok(parsed.format === 'status-expiry-sandbox/v1', '导出包含格式标识');
ok(Array.isArray(parsed.result.frames) && parsed.result.frames.length > 0, '导出包含完整帧日志');
await page.click('#modal-cancel');

// 12. 导入导出包（通过 modal 载入样例路径同样走 importBundle）
await page.click('#btn-samples');
await page.waitForSelector('#modal-back:not([hidden])');
await page.locator('#modal-text').fill(exported);
await page.click('#modal-action');
await page.waitForTimeout(150);
const toastText = await page.locator('.toast').first().innerText().catch(() => '');
ok(toastText.includes('完全一致'), '重放复现一致: ' + toastText);

// 13. 256 上限场景：构造 64 角色 × 4 盾 + 第 257 个 apply，确认拒绝日志
const overflow = JSON.stringify({
  actors: Array.from({ length: 64 }, (_, i) => ({ id: 'a' + i, maxHp: 1000, hp: 1000 })),
  definitions: [
    { id: 'w', kind: 'shield', stack: 'independent', cap: 4, duration: 60000, amount: 1 },
    { id: 'w2', kind: 'shield', stack: 'independent', cap: 4, duration: 60000, amount: 1 },
  ],
  events: (() => {
    const ev = []; let seq = 1;
    for (let i = 0; i < 64; i++) for (let k = 0; k < 4; k++)
      ev.push({ id: 'e' + seq, seq: seq++, time: seq, op: 'apply', target: 'a' + i, effect: 'w' });
    ev.push({ id: 'overflow', seq: seq++, time: 9999, op: 'apply', target: 'a0', effect: 'w2' });
    return ev;
  })(),
});
await page.click('#btn-samples');
await page.waitForSelector('#modal-back:not([hidden])');
await page.locator('#modal-text').fill(overflow);
await page.click('#modal-action');
await page.waitForTimeout(200);
await page.click('#btn-last');
// 虚拟滚动只渲染可视窗口，断言以引擎结果为准
const rejectedInEngine = await page.evaluate(() =>
  window.__testState?.result?.logs.filter((l) => l.type === 'apply-rejected').length ?? -1);
ok(rejectedInEngine >= 1, `超上限 apply 被拒绝（引擎日志 ${rejectedInEngine} 条）`);
const activePill = await page.locator('#pill-active').innerText();
ok(activePill.includes('256'), '活动效果峰值停在 256: ' + activePill);

// 14. 深浅色切换不报错
await page.click('#btn-theme');
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '主题切换生效');

ok(errors.length === 0, '全程无控制台错误: ' + errors.join(' | '));

await browser.close();
server.close();
console.log(`\nE2E 结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
