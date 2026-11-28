// tools/benchmark-browser.mjs —— 满额数据在真实浏览器中的渲染/交互性能
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); process.exit(1); });
await page.goto('http://localhost:8923/index.html', { waitUntil: 'networkidle' });

// 把满额 JSON 注入文件输入
await page.locator('#file-input').setInputFiles('/tmp/woven-full.json');
await page.waitForFunction(() => window.__view && window.__view.model);
const loadMs = await page.evaluate(() => {
  const t = document.querySelector('#timing').textContent;
  return t;
});
console.log('求解阶段:', loadMs);

// 首帧绘制耗时（fit 已在 setData 内调用，这里再触发一次 draw 测量）
const drawMs = await page.evaluate(() => {
  const v = window.__view;
  const t0 = performance.now();
  v.draw();
  return performance.now() - t0;
});
console.log(`一次全量重绘: ${drawMs.toFixed(1)} ms`);

// 放大后的视口裁剪效果：缩放到局部后再测
const zoomDrawMs = await page.evaluate(() => {
  const v = window.__view;
  v.scale = v.scale * 8;
  const t0 = performance.now();
  v.draw();
  return performance.now() - t0;
});
console.log(`放大 8 倍后重绘（视口裁剪）: ${zoomDrawMs.toFixed(1)} ms`);

// 命中检测性能：模拟鼠标移动查找
const pickMs = await page.evaluate(() => {
  const v = window.__view;
  const t0 = performance.now();
  let hit = 0;
  for (let i = 0; i < 1000; i++) {
    if (v.pick((i * 37) % v.w, (i * 53) % v.h) >= 0) hit++;
  }
  return { ms: performance.now() - t0, hit };
});
console.log(`1000 次命中检测: ${pickMs.ms.toFixed(1)} ms（命中 ${pickMs.hit} 次）`);

if (drawMs > 300) throw new Error('全量重绘超过 300ms，交互可能卡顿');
console.log('\n✓ 浏览器渲染性能达标');
await browser.close();
