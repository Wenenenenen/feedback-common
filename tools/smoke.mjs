// 浏览器端冒烟测试：npx playwright chromium --headless 跑不了脚本，
// 这里用 playwright 库驱动（node tools/smoke.mjs）。
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8923';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? ` — ${detail}` : ''));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/index.html');
await page.waitForSelector('#stage');

// 可靠等待样例异步载入完成（fetch + 解码），避免与后续输入竞态
let loadGen = 0;
async function loadSample(selector) {
  const gen = loadGen + 1;
  await page.click(selector);
  await page.waitForFunction((g) => Number(document.body.dataset.loadGen || 0) >= g, gen);
  loadGen = gen;
}

// 1. 载入人物样例（含掩膜）
await loadSample('[data-sample="samples/portrait.png|samples/protect.png"]');
check('载入 portrait+protect 后尺寸徽标正确', true);
check('目标宽高自动填充', await page.inputValue('#target-w') === '48' && await page.inputValue('#target-h') === '36');

// 2. 缩小到 40×32（先宽后高），保护像素不被删除
await page.fill('#target-w', '40');
await page.fill('#target-h', '32');
await page.click('#run-btn');
await page.waitForSelector('#player-panel:not([hidden])');
const status1 = await page.textContent('#status');
check('缩图变换执行无停止', !status1.includes('提前停止'), status1);
const sliderMax = Number(await page.getAttribute('#player-slider', 'max'));
check('回放帧数 > 2（逐步缝线）', sliderMax >= 10, `max=${sliderMax}`);
await page.locator('#player-panel').scrollIntoViewIfNeeded();

// 3. 逐帧前进两次，标题变化
await page.click('#player-next');
const title1 = await page.textContent('#player-title');
await page.click('#player-next');
const title2 = await page.textContent('#player-title');
check('回放推进时帧标题变化', title1 !== title2, `${title1} || ${title2}`);
// 能量视图
await page.click('#player-energy');
await page.waitForTimeout(100);
check('能量视图可切换（无报错）', !errors.some((e) => e.includes('energy')));
await page.click('#player-energy');
await page.click('#player-close');
check('结果尺寸 40×32（关闭回放后徽标反映当前图）', (await page.textContent('#size-badge')) === '40 × 32');

// 4. 撤销恢复 48×36
await page.click('#undo-btn');
check('撤销后恢复原始尺寸', (await page.textContent('#size-badge')) === '48 × 36');
await page.click('#redo-btn');
await page.click('#player-close');
check('重做后回到结果尺寸', (await page.textContent('#size-badge')) === '40 × 32');

// 5. 导出按钮（headless 下下载会落盘，验证触发即可）
const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).then((d) => d.suggestedFilename()).catch(() => null);
await page.click('#export-image');
const dl1 = await downloadPromise;
check('结果图像导出触发下载', /retarget-40x32\.png$/.test(dl1 || ''), dl1);
const dl2Promise = page.waitForEvent('download', { timeout: 3000 }).then((d) => d.suggestedFilename()).catch(() => null);
await page.click('#export-mask');
const dl2 = await dl2Promise;
check('掩膜导出触发下载', /mask-40x32\.png$/.test(dl2 || ''), dl2);
const dl3Promise = page.waitForEvent('download', { timeout: 3000 }).then((d) => d.suggestedFilename()).catch(() => null);
await page.click('#export-record');
const dl3 = await dl3Promise;
check('缝线记录导出触发下载', /seam-record\.json$/.test(dl3 || ''), dl3);

// 6. JSON 查看模态
await page.click('#view-json');
await page.waitForSelector('#json-modal[open]');
const jsonText = await page.inputValue('#json-text');
const record = JSON.parse(jsonText);
check('JSON 记录可解析且含操作事件', Array.isArray(record.operations[0].events) && record.operations[0].events.length > 0);
check('JSON 含 shrink 类型与坐标', record.operations[0].events.some((e) => e.type === 'shrink' && e.seam[0].x !== undefined));
await page.click('#json-close');

// 7. 屏障样例：无合法路径应停止并保留原尺寸
await loadSample('[data-sample="samples/flat.png|samples/barrier-mask.png"]');
await page.fill('#target-w', '3');
await page.click('#run-btn');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('提前停止'));
check('屏障触发提前停止提示', (await page.textContent('#status')).includes('找不到合法缝线'));
check('屏障下保留上一步尺寸', (await page.textContent('#size-badge')) === '6 × 5');

// 8. 校验：超过 ±128 禁用执行
await loadSample('[data-sample="samples/flat.png|"]');
await page.fill('#target-w', '200');
await page.waitForFunction(() => document.getElementById('validation').textContent.includes('每轴变化最多 128px'));
check('超范围目标禁用运行按钮', await page.isDisabled('#run-btn'));
check('校验提示包含每轴 128 限制', (await page.textContent('#validation')).includes('每轴变化最多 128px'));
await page.fill('#target-w', '8');
check('合法目标启用运行按钮', await page.isEnabled('#run-btn'));

// 9. 扩图：6→10 触发批次发现/应用帧
await page.fill('#target-w', '10');
await page.click('#run-btn');
await page.waitForSelector('#player-panel:not([hidden])');
await page.locator('#player-panel').scrollIntoViewIfNeeded();
const titles = [];
const maxFrame = Number(await page.getAttribute('#player-slider', 'max'));
for (let i = 0; i <= maxFrame; i++) {
  titles.push(await page.textContent('#player-title'));
  if (i < maxFrame) await page.click('#player-next');
}
check('扩图回放含发现帧', titles.some((t) => t.includes('发现缝')));
check('扩图回放含应用帧', titles.some((t) => t.includes('插回')));
check('扩图结果 10×5', (await page.textContent('#size-badge')) === '10 × 5');
await page.click('#player-close');

// 10. 画笔：在 portrait 上画一笔，历史栈新增独立条目，撤销可回退
await loadSample('[data-sample="samples/portrait.png|samples/protect.png"]');
const before = await page.textContent('#history-label');
const box = await page.locator('#stage').boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(100);
const after = await page.textContent('#history-label');
check('画笔产生独立历史条目', before !== after && after.includes('画笔'), `${before} -> ${after}`);
// 撤销画笔
const undoCount = Number(await page.locator('#undo-btn').isEnabled());
check('画笔后可撤销', undoCount === 1);
await page.click('#undo-btn');
check('撤销画笔回到载入条目', (await page.textContent('#history-label')).includes('载入'));

check('全程无页面错误', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: 'tools/smoke-final.png' });
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
