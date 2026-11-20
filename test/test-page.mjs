/* 页面端到端冒烟测试：node test/test-page.mjs（需先 python3 -m http.server 8765） */
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('http://127.0.0.1:8919/index.html');
await page.waitForTimeout(3000); // 等默认 basic 样例加载+裁剪

let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };

const status = await page.textContent('#status');
console.log('状态栏:', JSON.stringify(status));
check('默认样例裁剪完成', /裁剪完成/.test(status) && !/失败|超过/.test(status));

const stats = await page.textContent('#stats');
console.log('统计:', stats.replace(/\s+/g, ' ').trim());
check('统计含输出三角形', /输出/.test(stats));

// 自检按钮
await page.click('#btnSelfTest');
await page.waitForTimeout(1500);
const selftest = await page.textContent('#status');
console.log('自检:', selftest.replace(/\s+/g, ' ').trim());
check('自检全部✓', (selftest.match(/✓/g) || []).length === 5 && !selftest.includes('✗'));

// 切换 affine 样例（镜像+剪切）
await page.click('[data-sample="affine"]');
await page.waitForTimeout(1500);
const st2 = await page.textContent('#status');
check('affine 样例裁剪完成', /裁剪完成/.test(st2));
const stats2 = await page.textContent('#stats');
check('affine 两盒均有输出', (stats2.match(/输出\s*\d*[1-9]/g) || []).length >= 2);

// 调整角度阈值滑块 → 触发重算
await page.click('[data-sample="basic"]');
await page.waitForTimeout(1000);
await page.locator('#pj-a-0').fill('10');
await page.waitForTimeout(500);
const st3 = await page.textContent('#status');
check('调整角度阈值后重算', /裁剪完成/.test(st3));

// 投射盒面板存在且方向显示
const dir = await page.textContent('#pj-dir-0');
check('投射方向显示', /方向 \(/.test(dir));

// 导出按钮可点击（下载事件）
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.click('#btnSrc');
const d = await dl;
check('来源JSON可导出', !!d);
if (d) {
  const path = await d.path();
  const { readFileSync } = await import('node:fs');
  const j = JSON.parse(readFileSync(path, 'utf8'));
  check('来源JSON字段齐全', j.length > 0 && j[0].projectorId && j[0].instanceId && j[0].meshId
    && Number.isInteger(j[0].sourceTriangle) && j[0].barycentric.length === 3);
}

// 模拟点击画布中央（拾取贴花）
await page.mouse.click(400, 300);
await page.waitForTimeout(300);

check('无页面JS错误', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));

await browser.close();
console.log(failed ? `\n${failed} 项失败` : '\n页面冒烟测试全部通过');
process.exit(failed ? 1 : 0);
