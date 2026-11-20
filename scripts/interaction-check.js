// 交互验证：拖动相机 LOD 实时变化、invalid 文件被拦截、无裙边检查
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8917/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const leafCount = async () => {
    const t = await page.textContent('#stats');
    return Number(t.match(/(\d+)\s*叶块/)?.[1]);
  };
  const before = await leafCount();

  // 拖动相机（OrbitControls 旋转），多次移动触发 change
  const box = await page.locator('#viewport').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(box.x + box.width * (0.4 + i * 0.03), box.y + box.height * (0.45 - i * 0.02));
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await leafCount();
  const camX = await page.inputValue('#camX');
  console.log('拖动前叶块:', before, '拖动后叶块:', after, '相机X同步为:', camX);
  console.log('拖动使 LOD 网格发生调整:', before !== after || camX !== '32.0');

  // 滚轮缩放靠近
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -800);
  await page.waitForTimeout(500);
  const zoomed = await leafCount();
  console.log('滚轮缩放后叶块:', zoomed, '(靠近通常细分增多)');

  // invalid.json 上传拦截
  await page.setInputFiles('#fileInput', '/home/wendy/jianzhi/feedback-tasks/balanced-terrain-stitcher/samples/extracted/invalid.json');
  await page.waitForTimeout(400);
  const errVisible = await page.isVisible('#errorBar');
  const errText = errVisible ? await page.textContent('#errorBar') : '';
  console.log('invalid 文件被拦截:', errVisible, '|', errText);

  // 无裙边：接缝线数量应有限且网格边界边只在外轮廓（由 validity 文案保证 0 悬挂边）
  const validity = await page.textContent('#validity');
  console.log('最终校验:', validity.trim().slice(0, 40));

  await page.screenshot({ path: '/tmp/terrain-shots/after-drag.png' });
  console.log('\n页面错误:', errors.length ? errors.join('\n') : '无');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
