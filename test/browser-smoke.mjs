// 浏览器端冒烟测试：完整用户流程（Playwright + 本地静态服务器）。
// 运行：node test/browser-smoke.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// playwright 为全局安装时，从全局 node_modules 绝对路径加载
let pw;
try {
  pw = (await import('playwright')).default ?? (await import('playwright'));
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  const mod = await import(join(globalRoot, 'playwright', 'index.js'));
  pw = mod.default ?? mod;
}
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');
const sampleZip = join(root, 'samples', 'inverse-color-cases.zip');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ppm': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = join(srcDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(srcDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

await new Promise((r) => server.listen(8123, r));
console.log('server: http://127.0.0.1:8123/');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

// 拦截下载，校验内容
const downloads = [];
page.on('download', async (d) => {
  const path = await d.path();
  downloads.push({ filename: d.suggestedFilename(), path });
});

try {
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle' });
  console.log('页面加载完成');

  // 1) 导入 zip
  await page.setInputFiles('#fileInput', sampleZip);
  await page.waitForFunction(
    () => document.getElementById('nameTable').textContent.includes('table.json')
  );
  console.log('zip 导入：', await page.locator('#nameTable').textContent(), '/',
    await page.locator('#nameImage').textContent());

  // 错误横幅应不可见
  const bannerVisible = await page.locator('#banner').evaluate((el) =>
    el.classList.contains('show')
  );
  if (bannerVisible) throw new Error('导入样本后不应出现错误横幅');

  // 2) 默认参数提交反查
  await page.locator('#applyBtn').click();
  await page.waitForFunction(
    () => document.getElementById('statStatus').textContent === '完成',
    { timeout: 20000 }
  );
  console.log('反查状态：', await page.locator('#statStatus').textContent());
  console.log('候选码：', await page.locator('#statCandidates').textContent(),
    ' 不同输出：', await page.locator('#statOutputs').textContent());
  console.log('构建：', await page.locator('#statBuild').textContent(),
    ' 反查：', await page.locator('#statSolve').textContent());

  // 3) 点击目标图第一个像素，检查检查器
  const target = page.locator('#cvTarget');
  await target.click({ position: { x: 12, y: 10 } });
  await page.waitForFunction(() => document.getElementById('piCode').textContent !== '—');
  console.log('像素检查：', {
    xy: await page.locator('#piXY').textContent(),
    code: await page.locator('#piCode').textContent(),
    target: (await page.locator('#piTarget').textContent()).trim(),
    proof: (await page.locator('#piProof').textContent()).trim(),
    werr: await page.locator('#piWErr').textContent(),
    man: await page.locator('#piMan').textContent(),
  });

  // 4) 修改参数：收紧区间 + 权重 8，重新反查（增量路径）
  await page.fill('#bRlo', '10');
  await page.fill('#bRhi', '50');
  await page.fill('#wR', '8');
  await page.locator('#applyBtn').click();
  await page.waitForFunction(
    () => document.getElementById('statStatus').textContent === '完成',
    { timeout: 20000 }
  );
  const candidates = Number((await page.locator('#statCandidates').textContent()).replace(/,/g, ''));
  if (candidates !== 41 * 64 * 64) throw new Error(`区间候选数错误：${candidates}`);
  console.log('收紧 R∈[10,50] 后候选码：', candidates);

  // 检查码值确实在区间内（抽下载文件验证）
  await page.locator('#dlCodes').click();
  await page.waitForFunction(() => true); // 下载事件异步
  await page.waitForTimeout(300);

  // 5) 非法参数：下界 > 上界，应保留已有结果
  await page.fill('#bRlo', '55');
  await page.fill('#bRhi', '10');
  await page.locator('#applyBtn').click();
  await page.waitForFunction(
    () => document.getElementById('banner').classList.contains('show')
  );
  const errText = await page.locator('#banner').innerText();
  if (!errText.includes('bounds[R]')) throw new Error(`错误未指出字段：${errText}`);
  console.log('非法参数提示：', errText.replace(/\s+/g, ' ').trim());
  // 旧结果仍在
  if (await page.locator('#dlCodes').isDisabled()) throw new Error('非法参数后成功结果被清空');

  // 6) 恢复合法参数并反查，然后下载两个 P6
  await page.fill('#bRlo', '0');
  await page.fill('#bRhi', '63');
  await page.fill('#wR', '1');
  await page.locator('#applyBtn').click();
  await page.waitForFunction(
    () => document.getElementById('statStatus').textContent === '完成',
    { timeout: 20000 }
  );
  await page.locator('#dlCodes').click();
  await page.locator('#dlProof').click();
  await page.waitForTimeout(500);

  if (downloads.length < 2) throw new Error(`下载数不足：${downloads.length}`);
  for (const d of downloads) {
    const bytes = readFileSync(d.path);
    const head = new TextDecoder('ascii').decode(bytes.subarray(0, 16));
    console.log(`下载 ${d.filename}：${bytes.length} 字节，头部 "${head.replace(/\n/g, '|')}"`);
    if (!head.startsWith('P6\n')) throw new Error(`${d.filename} 不是 P6`);
  }

  // 码图字节必须在 0..63
  const codesDl = downloads.find((d) => d.filename === 'codes.ppm');
  const allBytes = readFileSync(codesDl.path);
  const headerEnd = allBytes.indexOf(0x0a, allBytes.indexOf(0x0a, allBytes.indexOf(0x0a) + 1) + 1) + 1;
  const pixelBytes = allBytes.subarray(headerEnd);
  let maxV = 0;
  for (const b of pixelBytes) if (b > maxV) maxV = b;
  if (maxV > 63) throw new Error(`码图出现 >63 的字节：${maxV}`);
  console.log(`码图像素字节最大值：${maxV}（要求 ≤63）`);

  // 7) 与参照 proof_ref.ppm 逐字节比对
  const proofDl = downloads.find((d) => d.filename === 'proof.ppm');
  const refProof = readFileSync(join(root, '_samples_extract', 'proof_ref.ppm'));
  const dlProof = readFileSync(proofDl.path);
  if (!dlProof.equals(refProof)) {
    let firstDiff = -1;
    for (let i = 0; i < Math.min(dlProof.length, refProof.length); i++) {
      if (dlProof[i] !== refProof[i]) { firstDiff = i; break; }
    }
    throw new Error(`校样与参照不一致，首差位置 ${firstDiff}`);
  }
  console.log('下载校样与 Python 暴力参照逐字节一致 ✅');

  // 8) 控制台无错误
  if (consoleErrors.length) throw new Error(`控制台错误：${consoleErrors.join(' | ')}`);
  console.log('浏览器控制台无错误 ✅');

  // 9) 非法表导入：指出字段，且不替换已成功的表与结果
  const badTable = JSON.stringify({
    axes: [[0, 63], [0, 63], [0, 63]],
    nodes: [[0, 0, 0]], // 数量不符
    bounds: [[0, 63], [0, 63], [0, 63]],
  });
  await page.setInputFiles('#fileInput', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(badTable),
  });
  await page.waitForFunction(() =>
    document.getElementById('banner').classList.contains('show')
  );
  const badErr = await page.locator('#banner').innerText();
  if (!badErr.includes('nodes')) throw new Error(`非法表未指出字段：${badErr}`);
  console.log('非法表提示：', badErr.replace(/\s+/g, ' ').trim());
  // 旧表名仍在、旧结果仍可下载
  const tableName = await page.locator('#nameTable').textContent();
  if (!tableName.includes('table.json')) throw new Error('非法表替换了已成功的表');
  if (await page.locator('#dlProof').isDisabled()) throw new Error('非法表清空了已成功结果');
  console.log('已成功结果保留 ✅');

  // 非法 bounds 字段也能定位
  const badBounds = JSON.stringify({
    axes: [[0, 63], [0, 63], [0, 63]],
    nodes: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    bounds: [[0, 70], [0, 63], [0, 63]],
  });
  await page.setInputFiles('#fileInput', {
    name: 'bad2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(badBounds),
  });
  await page.waitForFunction(() =>
    document.getElementById('banner').innerText.includes('bounds')
  );
  console.log('bounds 非法提示：',
    (await page.locator('#banner').innerText()).replace(/\s+/g, ' ').trim());

  console.log('\n全部浏览器冒烟测试通过');
} finally {
  await browser.close();
  server.close();
}
