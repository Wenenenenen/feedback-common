/**
 * 生产构建冒烟测试。
 *
 * 生产包里没有测试钩子，因此全程通过界面操作：导入 → 预览播放 → 打开导出对话框。
 * 目的是确认打包后的代码能真正跑起来，而不只是开发环境可用。
 */
import { chromium } from 'playwright-core';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.tmp-export');
const URL = 'http://127.0.0.1:5201/';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  check('生产包加载', (await page.locator('.brand-name').textContent()) === 'ClipCut');

  // 生产环境不应暴露测试钩子
  const hasHook = await page.evaluate(() => typeof window.__clipcut);
  check('测试钩子未进入生产包', hasHook === 'undefined', hasHook);

  // 走界面导入（文件选择器）
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入视频' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(join(root, 'samples', 'sintel_trailer-720p.mp4'));
  await page.waitForTimeout(3500);

  const clipCount = await page.locator('.clip-block').count();
  const thumbCount = await page.locator('.thumb-cell').evaluateAll(
    (els) => els.filter((el) => el.style.backgroundImage).length,
  );
  check('界面导入素材', clipCount === 1, `${clipCount} 个片段`);
  check('缩略图生成', thumbCount > 0, `${thumbCount} 格有图`);

  // 点播放，等 2 秒，确认时间码推进
  const before = await page.locator('.timecode').textContent();
  await page.locator('.btn.play').click();
  await page.waitForTimeout(2200);
  const after = await page.locator('.timecode').textContent();
  await page.locator('.btn.play').click();
  check('界面播放推进时间码', before !== after, `${before} → ${after}`);

  // 打开导出对话框（验证导出模块能被按需加载）
  await page.getByRole('button', { name: '导出 MP4' }).click();
  await page.waitForTimeout(600);
  const dialogVisible = await page.locator('.modal').count();
  check('导出对话框可打开', dialogVisible === 1);

  // 拖拽导入提示层（模拟 dragenter）
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    const file = new File(['x'], 'demo.mp4', { type: 'video/mp4' });
    transfer.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }));
  });
  await page.waitForTimeout(300);
  const overlay = await page.locator('.drop-overlay').evaluate((el) => getComputedStyle(el).display);
  check('拖拽导入提示', overlay === 'flex', overlay);

  await page.screenshot({ path: join(outDir, 'prod-ui.png') });
} catch (error) {
  check('脚本执行', false, String(error));
} finally {
  const fatal = errors.filter((t) => !t.includes('favicon') && !t.includes('Failed to load resource'));
  check('生产包无致命错误', fatal.length === 0, fatal.slice(0, 2).join(' | ') || '无');
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n汇总：${passed}/${results.length} 项通过`);
  await browser.close();
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}
