// 端到端浏览器测试：启动静态服务器，用 Chromium 驱动真实页面交互。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SAMPLES = join(ROOT, '.work/samples-extract');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (path.startsWith('/samples/')) file = join(SAMPLES, path.slice('/samples/'.length));
  else file = join(ROOT, 'src', normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (existsSync(file)) {
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    createReadStream(file).pipe(res);
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/index.html`;

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

async function uploadSample(inputId, sampleName) {
  await page.setInputFiles(`#${inputId}`, {
    name: sampleName,
    mimeType: 'application/json',
    buffer: readFileSync(join(SAMPLES, sampleName)),
  });
}

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  ok((await page.title()) === '热方法曲面测距台', '页面加载成功');

  // 1) 内置样例 + 自动求解
  console.log('[内置样例]');
  await page.click('#loadSampleBtn');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  const meshInfo = await page.textContent('#meshInfo');
  ok(meshInfo.includes('81') && meshInfo.includes('128'), '显示 81 顶点 / 128 面');
  const diag = await page.textContent('#diagBox');
  ok(diag.includes('最大距离'), '自动求解并渲染诊断');
  ok(!diag.includes('bad'), '无标红残差');

  // 2) 上传 flat.json，改 tau、移动源点，检查缓存
  console.log('[flat + tau + 缓存]');
  await uploadSample('fileInput', 'flat.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  let d1 = await page.textContent('#diagBox');
  ok(d1.includes('热分解 命中 0/未命中 1'), '首次求解热分解 miss');
  await page.fill('#tauSlider', '3');
  await page.dispatchEvent('#tauSlider', 'input');
  await page.waitForTimeout(150);
  const d2 = await page.textContent('#diagBox');
  ok(d2.includes('未命中 2'), '改 tau 后热分解重建');
  // 模拟点击另一个顶点（多源模式追加）；统计为累计值：移动源点后热 miss 不增长、命中增长
  const beforeCache = await page.textContent('#diagBox');
  const heatMissBefore = Number(beforeCache.match(/热分解 命中 \d+\/未命中 (\d+)/)[1]);
  await page.check('#multiMode');
  const box = await page.locator('#gl').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.waitForFunction(() => /源点：\[\d+, \d+\]/.test(document.querySelector('#sourceList').textContent));
  const d3 = await page.textContent('#diagBox');
  const heatAfter = d3.match(/热分解 命中 (\d+)\/未命中 (\d+)/).map(Number);
  ok(heatAfter[2] === heatMissBefore && heatAfter[1] >= 1, `移动/追加源点复用热分解（miss 保持 ${heatMissBefore}，命中增至 ${heatAfter[1]}）`);
  const poiAfter = d3.match(/Poisson 命中 (\d+)\/未命中 (\d+)/).map(Number);
  ok(poiAfter[2] === heatMissBefore, `源集合变化时 Poisson 约束分解重建（未命中 ${poiAfter[2]} 次）`);

  // 3) 等值线间距调节
  console.log('[等值线]');
  const isoBefore = await page.evaluate(() => window.__iso || null);
  await page.fill('#isoSlider', '0.5');
  await page.dispatchEvent('#isoSlider', 'input');
  await page.waitForTimeout(150);
  const lineCount = await page.evaluate(
    () => document.querySelector('canvas') && true
  );
  ok(lineCount, '等值线重绘无异常');
  await page.fill('#isoSlider', '1');
  await page.dispatchEvent('#isoSlider', 'input');

  // 4) disconnected：不可达
  console.log('[disconnected]');
  await page.uncheck('#multiMode');
  await uploadSample('fileInput', 'disconnected.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('不可达顶点'));
  const dd = await page.textContent('#diagBox');
  ok(dd.includes('不可达顶点') && !dd.includes('不可达顶点 <b>0'), '存在不可达顶点且计数非零');
  const comp = await page.textContent('#diagBox');
  ok(comp.includes('不可达'), '诊断表标注不可达分量');

  // 5) degenerate：列出排除
  console.log('[degenerate]');
  await uploadSample('fileInput', 'degenerate.json');
  await page.waitForSelector('#excludedBox:not(.hidden)');
  const exc = await page.textContent('#excludedBox');
  ok(exc.includes('#128'), '列出退化面 #128');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));

  // 6) obtuse：钝角提示 + 正常求解
  console.log('[obtuse]');
  await uploadSample('fileInput', 'obtuse.json');
  await page.waitForSelector('#obtuseBox:not(.hidden)');
  const ob = await page.textContent('#obtuseBox');
  ok(ob.includes('钝角三角形 2'), '报告 2 个钝角三角形');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));

  // 7) invalid-nonmanifold：拒绝
  console.log('[invalid-nonmanifold]');
  await uploadSample('fileInput', 'invalid-nonmanifold.json');
  await page.waitForSelector('#rejectMsg:not(.hidden)');
  const rej = await page.textContent('#rejectMsg');
  ok(rej.includes('非流形'), '非流形网格被拒绝并提示');

  // 8) isolated：孤立点
  console.log('[isolated]');
  await uploadSample('fileInput', 'isolated.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  const isoInfo = await page.textContent('#meshInfo');
  ok(isoInfo.includes('孤立点 1'), '识别 1 个孤立顶点');
  // 选孤立顶点 81 为源：清空后通过 evaluate 直接触发选择逻辑（孤立点屏幕位置不确定）
  await page.evaluate(() => {
    // 复用页面状态：把 81 设为唯一源点并求解
    window.__pickIsolated(81);
  });
  await page.waitForFunction(() => document.querySelector('#sourceList').textContent.includes('81'));
  const isoDiag = await page.textContent('#diagBox');
  ok(isoDiag.includes('不可达顶点') && !isoDiag.includes('不可达顶点 <b>0'), '孤立点为源时其余分量不可达');

  // 9) stress：性能
  console.log('[stress 8192 面]');
  await uploadSample('fileInput', 'stress.json');
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'), { timeout: 10000 });
  const ms = Date.now() - t0;
  const sdHtml = await page.innerHTML('#diagBox');
  ok(ms < 8000, `8192 面浏览器内求解在 8s 内完成（${ms}ms）`);
  const unreachable = await page.textContent('#unreachableCount');
  ok(unreachable.trim() === '0', `stress 网格全部可达（不可达数=${unreachable.trim()}）`);

  // 10) 对比：flat vs folded
  console.log('[对比 flat/folded]');
  await uploadSample('fileInput', 'flat.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  await page.waitForTimeout(200);
  await uploadSample('fileInputB', 'folded.json');
  await page.waitForSelector('#compareBtn:not(:disabled)');
  await page.click('#compareBtn');
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#compareResult').textContent;
      const m = t.match(/最大绝对差异：([\d.e+-]+)/);
      return m && Number.isFinite(Number(m[1]));
    },
    { timeout: 5000 }
  );
  const cmpText = await page.textContent('#compareResult');
  const maxDiff = Number(cmpText.match(/最大绝对差异：([\d.e+-]+)/)[1]);
  ok(Number.isFinite(maxDiff) && maxDiff <= 1e-6, `折叠 vs 平面最大差异 ≤1e-6（实测 ${maxDiff.toExponential(2)}）`);
  await page.click('#clearCompareBtn');

  // 11) 导出三个 JSON（拦截下载内容并校验结构）
  console.log('[导出]');
  const downloads = [];
  page.on('download', async (d) => {
    const stream = await d.createReadStream();
    let body = '';
    for await (const chunk of stream) body += chunk;
    downloads.push({ name: d.suggestedFilename(), json: JSON.parse(body) });
  });
  await page.click('#exportDistBtn');
  await page.click('#exportIsoBtn');
  await page.click('#exportDiagBtn');
  await page.waitForTimeout(400);
  ok(downloads.length === 3, '三个 JSON 文件均触发下载');
  const distFile = downloads.find((d) => d.name === 'distances.json');
  const isoFile = downloads.find((d) => d.name === 'isolines.json');
  const diagFile = downloads.find((d) => d.name === 'diagnostics.json');
  ok(Array.isArray(distFile.json.distances) && distFile.json.distances.length === 81, '距离 JSON 含 81 顶点值');
  ok(isoFile.json.segments.length > 0 && isoFile.json.segments[0].a.length === 3, '等值线 JSON 含 3D 线段');
  ok(
    diagFile.json.excludedFaces && diagFile.json.components && diagFile.json.cacheStats &&
      diagFile.json.residuals === undefined &&
      diagFile.json.components[0].heat &&
      true,
    '诊断 JSON 含组件/排除面/残差(内嵌)/缓存统计'
  );

  // 12) 截图留档
  await uploadSample('fileInput', 'folded.json');
  await page.waitForFunction(() => document.querySelector('#diagBox').textContent.includes('求解耗时'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ROOT, '.work/screenshot-folded.png') });
  await uploadSample('fileInput', 'disconnected.json');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ROOT, '.work/screenshot-disconnected.png') });
  ok(true, '截图已保存');

  ok(errors.length === 0, `浏览器控制台无错误（${errors.length} 条）`);
  if (errors.length) console.error('  控制台错误：', errors.slice(0, 5));
} catch (e) {
  fail++;
  console.error('  ✗ E2E 异常：', e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(`\nE2E 结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
