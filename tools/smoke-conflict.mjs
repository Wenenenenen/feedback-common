// tools/smoke-conflict.mjs —— 矛盾纹样的浏览器展示测试
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';

// 3 交点闭线（奇环）：矩形被一条横线穿 2 次、一条竖线穿 1 次
const data = {
  strands: [
    { id: 1, points: [[2, 2], [8, 2], [8, 8], [2, 8]], closed: true, gap: 1 },
    { id: 2, points: [[0, 4], [10, 4]], closed: false, gap: 1 },
    { id: 3, points: [[5, 0], [5, 3]], closed: false, gap: 1 },
  ],
};
fs.writeFileSync('/tmp/woven-conflict.json', JSON.stringify(data));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8923/index.html', { waitUntil: 'networkidle' });

// 通过文件选择器载入
await page.locator('#file-input').setInputFiles('/tmp/woven-conflict.json');
await page.waitForSelector('#conflict-panel:not([hidden])');
const conflictTitle = await page.locator('#conflict-panel h2').innerText();
console.log('矛盾面板标题:', conflictTitle);
if (!conflictTitle.includes('矛盾')) throw new Error('矛盾面板未出现');

const itemCount = await page.locator('.conflict-item').count();
console.log('矛盾条目数:', itemCount);
if (itemCount < 1) throw new Error('无矛盾条目');

// 点击第一条矛盾，验证画布出现高亮环
await page.locator('.conflict-head').first().click();
await page.waitForTimeout(150);
const highlighted = await page.evaluate(() => window.__view.highlight.size);
console.log('高亮链交点数:', highlighted);
if (highlighted < 3) throw new Error('矛盾链未在画布高亮');

// 链节点可点击定位
await page.locator('.chain-node').first().click();
await page.waitForSelector('#inspector:not([hidden])');
console.log('链节点追查面板:', await page.locator('#inspector h2').innerText());

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('\n✓ 矛盾展示测试通过');
await browser.close();
