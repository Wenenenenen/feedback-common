/* Playwright 端到端冒烟（CommonJS，便于 require 全局 playwright）
 * 运行：node tests/browser.smoke.cjs
 * 可选：PORT 无关（内部起随机端口静态服务）；DL_DIR 指定下载产物目录。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');

const PW_PATH = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium;
try {
  ({ chromium } = require(PW_PATH));
} catch (e) {
  ({ chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright'));
}

const ROOT = path.join(__dirname, '..');
const DL_DIR = process.env.DL_DIR || fs.mkdtempSync('/tmp/gk-e2e-');
fs.mkdirSync(DL_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.zip': 'application/zip', '.csv': 'text/csv',
  '.ppm': 'image/x-portable-pixmap', '.pgm': 'image/x-portable-graymap',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

function pnmP6(w, h, rgbBytes) {
  return Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii'), Buffer.from(rgbBytes)]);
}
function pnmP5(w, h, g) {
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii'), Buffer.from(g)]);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const exe = process.env.PW_EXE || path.join(process.env.HOME || '', '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell');
  const browser = await chromium.launch({ executablePath: process.env.PW_EXE || (fs.existsSync(exe) ? exe : undefined), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));

  const getDl = async (clickSelector, saveName) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(clickSelector)]);
    const target = path.join(DL_DIR, saveName || dl.suggestedFilename());
    await dl.saveAs(target);
    return { target, name: dl.suggestedFilename() };
  };

  const currentRev = () => page.evaluate(() => window.genlock.getState().revision);
  const waitNewRev = async (oldRev) =>
    page.waitForFunction((r) => window.genlock.getState().revision > r, oldRev, { timeout: 20000 });
  const uiSolve = async (mutate) => {
    const r = await currentRev();
    if (mutate) await mutate();
    await page.click('#solveBtn');
    await waitNewRev(r);
  };

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GKEngine && window.GKCodec && window.genlock, null, { timeout: 8000 });
    console.log('✓ 页面与全局接口加载');

    // ---- 真实文件输入：样例 zip ----
    const zipPath = path.join(ROOT, 'samples', 'genlock-key-cases.zip');
    await page.setInputFiles('#fileInput', zipPath);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已读入'), null, { timeout: 10000 });
    {
      const r = await currentRev();
      await page.click('#solveBtn');
      await waitNewRev(r);
    }
    let sum = await page.evaluate(() => window.genlock.getSummary());
    if (sum.pair_count !== 3 || sum.total_abs_dt !== 1) throw new Error('zip 样例结果不符: ' + JSON.stringify(sum));
    console.log('✓ zip 上传+提交：3 对，总时差1，候选', sum.candidate_count);

    // ---- 内置样例按钮（用 revision 等待全新结果，避免读到旧状态） ----
    {
      const r = await currentRev();
      await page.click('#loadSampleBtn');
      await waitNewRev(r);
    }
    console.log('✓ 内置样例按钮');

    // ---- 编辑 offset/tolerance 两次求解 ----
    await uiSolve(async () => { await page.fill('#toleranceInput', '0'); });
    let s0 = await page.evaluate(() => window.genlock.getSummary());
    if (s0.tolerance !== 0 || s0.pair_count !== 2) throw new Error('tol0 应配2对，实际' + JSON.stringify(s0));
    console.log('✓ 第一次改参求解 tol=0 -> 2 对');

    await uiSolve(async () => { await page.fill('#offsetInput', '3'); await page.fill('#toleranceInput', '1'); });
    let s3 = await page.evaluate(() => window.genlock.getSummary());
    if (s3.offset !== 3 || s3.tolerance !== 1 || s3.pair_count !== 3 || s3.total_abs_dt !== 2) {
      throw new Error('offset3 tol1 应3对总误差2: ' + JSON.stringify(s3));
    }
    console.log('✓ 第二次改 offset=3,tol=1 -> 3 对，总误差2');

    // 恢复样例参数
    await uiSolve(async () => { await page.fill('#offsetInput', '2'); await page.fill('#toleranceInput', '1'); });
    await page.waitForFunction(() => window.genlock.getSummary().total_abs_dt === 1);

    // ---- 跳到填充位置1，核对 UI 与表一致 ----
    await page.fill('#frameJump', '1');
    await page.click('#jumpBtn');
    await page.waitForFunction(() => document.getElementById('framePosLabel').textContent.includes('1 / 共 3'));
    const detailText = await page.$eval('#frameDetail', (el) => el.innerText);
    if (!/键排序位置[\s\S]*1/.test(detailText)) throw new Error('详情应含键排序位置1');
    if (!/带符号时差 dt[\s\S]*\+1/.test(detailText)) throw new Error('详情应含 dt +1: ' + detailText);
    if (!/键原始输入位置[\s\S]*2（第 3 条/.test(detailText)) throw new Error('详情应含键原始位置2/第3条');
    console.log('✓ 跳到帧1：键排序1、原始2、dt=+1 均显示');

    // ---- 下载 JSON 配对表 ----
    const tableDl = await getDl('#downloadTableJson', 'table.json');
    const table = JSON.parse(fs.readFileSync(tableDl.target, 'utf8'));
    if (!Array.isArray(table) || table.length !== 3) throw new Error('JSON 表应为长度3的顶层数组');
    if (table[1].dt !== 1 || table[1].key_original_position !== 2) throw new Error('表第2行数据不符');
    console.log('✓ 下载 JSON 配对表（顶层数组，3 行，字段一致）');

    const csvDl = await getDl('#downloadTableCsv', 'table.csv');
    const csv = fs.readFileSync(csvDl.target, 'utf8');
    if (!/fill_sorted_position/.test(csv) || csv.split('\r\n').length !== 4) throw new Error('CSV 应有表头+3行');
    console.log('✓ 下载 CSV');

    // ---- AP5 像素规则（页面内精确断言） ----
    const W = 3, H = 1;
    const fillBytes = pnmP6(W, H, [1,1,1, 1,1,1, 200,100,50]);
    const keyBytes = pnmP5(W, H, [6, 2, 0]);
    const b64 = (b) => b.toString('base64');
    const pixelReport = await page.evaluate(async (imgs) => {
      const proj = {
        width: 3, height: 1, modulus: 8, fill_mode: 'premult', offset: 0, tolerance: 0,
        fill: [{ t: 0, id: 0, image: 'f.ppm' }, { t: 100, id: 7, image: 'f.ppm' }],
        key: [{ t: 0, id: 8, image: 'k.pgm' }],
      };
      const r = await window.genlock.loadCase({ project: proj, images: { 'f.ppm': imgs.f, 'k.pgm': imgs.k } });
      if (!r.ok) return { error: r.error };
      const pm = window.genlock.compositeRGBA(0, 'premult');
      const st = window.genlock.compositeRGBA(0, 'straight');
      const un = window.genlock.compositeRGBA(1, 'premult');
      const px = (a, i) => [a[i*4], a[i*4+1], a[i*4+2], a[i*4+3]];
      return {
        premult: [px(pm,0), px(pm,1), px(pm,2)],
        straight: [px(st,0), px(st,1), px(st,2)],
        unpaired: [px(un,0), px(un,1), px(un,2)],
        table: window.genlock.getTable(),
      };
    }, { f: b64(fillBytes), k: b64(keyBytes) });

    if (pixelReport.error) throw new Error('AP5 loadCase 失败: ' + pixelReport.error);
    const expect = (got, want, name) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name} 期望 ${want} 实得 ${got}`); };
    expect(pixelReport.premult[0], [42,42,42,6], '预乘 c1/a6 ->42');
    expect(pixelReport.premult[1], [128,128,128,2], '预乘 c1/a2 ->128');
    expect(pixelReport.premult[2], [0,0,0,0], 'a0 预乘 RGB0');
    expect(pixelReport.straight[0], [1,1,1,6], '直通保留源色');
    expect(pixelReport.straight[2], [200,100,50,0], '直通第三像素');
    expect(pixelReport.unpaired.every((p) => p.every((v) => v === 0)), true, '未配帧全0');
    if (pixelReport.table[1].key_sorted_position !== null || pixelReport.table[1].dt !== null) throw new Error('未配行键字段应为 null');
    console.log('✓ AP5 像素：42/128/a0清零/直通保源/未配全0，表 null');

    // 下载该 1.png 供外部 Pillow 解码
    await page.evaluate(() => window.genlock.showFrame(0));
    const pngDl = await getDl('#downloadPngBtn', 'pixel-0.png');
    console.log('✓ 下载当前帧 PNG:', pngDl.name);

    // ---- 区间 ZIP（左闭右开，最多120） ----
    // 回到样例三帧工程
    {
      const r = await currentRev();
      await page.click('#loadSampleBtn');
      await waitNewRev(r);
    }
    await page.fill('#rangeStart', '0');
    await page.fill('#rangeEnd', '2');
    const zipDl = await getDl('#downloadRangeBtn', 'range.zip');
    console.log('✓ 下载区间 ZIP:', zipDl.name);

    // 121 帧应被拦截（构造 130 帧工程）
    const overRange = await page.evaluate(() => {
      const fill = [], key = [];
      for (let i = 0; i < 130; i++) { fill.push({ t: i, id: 0, image: 'f.ppm' }); key.push({ t: i, id: 0, image: 'k.pgm' }); }
      return { fill, key };
    });
    // 用真实 1x1 PPM/PGM base64
    const f1 = pnmP6(1,1,[10,20,30]).toString('base64');
    const k1 = pnmP5(1,1,[200]).toString('base64');
    await page.evaluate(async (args) => {
      await window.genlock.loadCase({
        project: { width:1,height:1,modulus:2,fill_mode:'straight',offset:0,tolerance:0, fill: args.fill, key: args.key },
        images: { 'f.ppm': args.f1, 'k.pgm': args.k1 },
      });
    }, { fill: overRange.fill, key: overRange.key, f1, k1 });
    await page.fill('#rangeStart', '0');
    await page.fill('#rangeEnd', '121');
    await page.click('#downloadRangeBtn');
    await page.waitForFunction(() => /超过上限 120/.test(document.getElementById('rangeHint').textContent));
    console.log('✓ 区间 121 帧被拒绝并提示上限120');
    // 120 帧应成功
    await page.fill('#rangeEnd', '120');
    const zip120 = await getDl('#downloadRangeBtn', 'range120.zip');
    console.log('✓ 区间 120 帧 ZIP 可下载');

    // ---- AP6：第17条填充坏引用，报错含位置/路径，旧结果保留 ----
    const bad = await page.evaluate(async (imgs) => {
      const fill = [];
      for (let i = 0; i < 20; i++) {
        fill.push(i === 16 ? { t: i, id: 0, image: 'missing-17.ppm' } : { t: i, id: 0, image: 'f.ppm' });
      }
      const key = [{ t: 0, id: 0, image: 'k.pgm' }];
      return await window.genlock.loadCase({
        project: { width:1,height:1,modulus:2,fill_mode:'straight',offset:0,tolerance:50, fill, key },
        images: { 'f.ppm': imgs.f, 'k.pgm': imgs.k },
      });
    }, { f: f1, k: k1 });
    if (bad.ok) throw new Error('坏引用工程应当失败');
    const stBad = await page.evaluate(() => window.genlock.getState());
    const msg = stBad.error.message;
    if (!/第 17 条/.test(msg) || !/位置 16/.test(msg) || !/missing-17\.ppm/.test(msg)) {
      throw new Error('坏引用错误需含第17条/位置16/路径: ' + msg);
    }
    if (!stBad.hasResult || stBad.summary.fill_count !== 130) throw new Error('失败后应保留上一版130帧结果');
    const rowsStill = await page.evaluate(() => window.genlock.getTable().length);
    if (rowsStill !== 130) throw new Error('旧配对表仍应可取130行');
    if (await page.$('#downloadTableJson[disabled]')) throw new Error('旧 JSON 下载按钮应仍可用');
    console.log('✓ AP6 坏引用定位第17条/原始位置16/路径，旧130行结果与下载保留');

    // ---- AP6：候选 >100 万失败，保留上一版 ----
    const overflow = await page.evaluate(async (imgs) => {
      const N = 1200, fill = [], key = [];
      for (let i = 0; i < N; i++) { fill.push({ t: 100, id: 0, image: 'f.ppm' }); key.push({ t: 100, id: 0, image: 'k.pgm' }); }
      return await window.genlock.loadCase({
        project: { width:1,height:1,modulus:2,fill_mode:'straight',offset:0,tolerance:0, fill, key },
        images: imgs,
      });
    }, { 'f.ppm': f1, 'k.pgm': k1 });
    if (overflow.ok || !/1[,.]?000[,.]?000/.test(overflow.error || '')) {
      throw new Error('候选超限应失败并提示上限，实际: ' + JSON.stringify(overflow));
    }
    const stAfter = await page.evaluate(() => window.genlock.getState());
    if (!stAfter.hasResult || stAfter.summary.fill_count !== 130) throw new Error('超限失败后仍应保留130行旧结果');
    console.log('✓ AP6 候选>100万快速失败，上一版结果保留');

    // ---- AP7：浏览器内满额 18 万 / 100 万，计时 ----
    const perf = await page.evaluate(async (imgs) => {
      const fill = [], key = [];
      let g = 0;
      const add = (size) => { const t = g * 3; for (let q=0;q<size;q++){ fill.push({t,id:0,image:'f.ppm'}); key.push({t,id:0,image:'k.pgm'});} g++; };
      for (let i=0;i<32000;i++) add(5);
      for (let i=0;i<2000;i++) add(10);
      // 全部同余即可（id=0）
      const t0 = performance.now();
      const r = await window.genlock.loadCase({
        project: { width:1,height:1,modulus:8,fill_mode:'premult',offset:0,tolerance:0, fill, key },
        images: imgs,
      });
      const ms = performance.now() - t0;
      if (!r.ok) return { ok:false, error:r.error };
      const table = window.genlock.getTable();
      let allZero = true, diagonal = true;
      for (let i=0;i<table.length;i++){
        if (table[i].dt !== 0) allZero = false;
        if (table[i].key_sorted_position !== i) diagonal = false;
      }
      return { ok:true, ms, rows: table.length, pairs: window.genlock.getSummary().pair_count,
        candidates: window.genlock.getSummary().candidate_count, allZero, diagonal };
    }, { 'f.ppm': f1, 'k.pgm': k1 });
    if (!perf.ok) throw new Error('满额工程失败: ' + perf.error);
    if (perf.rows !== 180000 || perf.pairs !== 180000 || perf.candidates !== 1000000) throw new Error('满额数量不对: ' + JSON.stringify(perf));
    if (!perf.allZero || !perf.diagonal) throw new Error('满额 dt/对角不正确');
    console.log(`✓ AP7 浏览器满额：${perf.rows} 行，${perf.candidates} 候选，全 dt0 对角；loadCase 总耗时 ${perf.ms.toFixed(0)} ms`);
    if (perf.ms > 12000) throw new Error('超过12秒预算: ' + perf.ms);

    if (errors.length) {
      const serious = errors.filter((m) => !/favicon|Download is starting|Multiple downloads/.test(m));
      if (serious.length) throw new Error('浏览器控制台错误:\n' + serious.join('\n'));
    }
    console.log('\n全部浏览器冒烟通过。下载产物目录：' + DL_DIR);
    console.log('DL_FILES=' + JSON.stringify(fs.readdirSync(DL_DIR)));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => { console.error(e); process.exit(1); });
