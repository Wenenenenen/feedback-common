/* 浏览器端到端冒烟：node tools/e2e-smoke.cjs
 * 启动静态服务 web/，用 Playwright 驱动真实页面。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..', 'web');
const PORT = 21188;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.zip': 'application/zip', '.bin': 'application/octet-stream' };

let failures = 0;
function check(c, m) { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) failures++; }

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => window.Rebinder && document.body.dataset.ready === '1', { timeout: 8000 });
  check(true, 'sample auto-loaded over http');

  let views = await page.evaluate(() => Rebinder.views().map((v) => v.name));
  check(JSON.stringify(views) === JSON.stringify(['legacy', 'reload']), 'two sample views: ' + views);

  /* ---- 路径定位 ---- */
  const r1 = await page.evaluate(() => Rebinder.resolvePath('legacy', 'basis.m[1][2]'));
  check(r1.abs === 84, 'legacy basis.m[1][2] abs84, got ' + r1.abs);
  const r2 = await page.evaluate(() => Rebinder.resolvePath('reload', 'basis[1][2]'));
  check(r2.abs === 136, 'shorthand reload basis[1][2] abs136, got ' + r2.abs);

  /* ---- 偏移反查 ---- */
  const q = await page.evaluate(() => Rebinder.setOffsetQuery(21));
  check(q.length === 1 && q[0].view === 'legacy' && q[0].padding, 'sample offset21 only legacy covers and is stride padding, got ' + JSON.stringify(q.map((x) => ({ v: x.view, pad: x.padding }))));

  /* ---- UI 执行样例迁移并下载 ---- */
  await page.selectOption('#pair-src', 'legacy');
  await page.selectOption('#pair-dst', 'reload');
  await page.click('#btn-add-pair');
  await page.click('#btn-run-batch');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('ok'));
  const writes = await page.evaluate(() => Rebinder.summary().pairs.length);
  check(writes === 1, 'batch ran with 1 pair');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const dlPath = path.join(require('os').tmpdir(), 'rb-export.bin');
  await download.saveAs(dlPath);
  const exported = fs.readFileSync(dlPath);
  check(exported.length === 144, 'export length == dump.bin 144, got ' + exported.length);
  // reload gain compacted values at 96..
  check(exported.readFloatLE(96) === 1 && exported.readFloatLE(100) === 0.5 && exported.readFloatLE(104) === 2, 'exported reload gains migrated');
  // logical matrix spot: reload row-major m[1][2] abs136 should be 13
  check(Math.abs(exported.readFloatLE(136) - 13) < 1e-6, 'reload basis m[1][2]=13 at 136, got ' + exported.readFloatLE(136));

  /* ---- 撤销 / 重做 导出对照 ---- */
  await page.click('#btn-undo');
  const afterUndo = await page.evaluate(() => Array.from(Rebinder.dumpBytes().slice(96, 144)).every((b) => b === 0xa5));
  check(afterUndo, 'undo restores reload target sentinel bytes');
  await page.click('#btn-redo');
  check((await page.evaluate(() => Rebinder.dumpHex(136, 4))) === '00005041', 'redo restores migrated m12 bytes 00 00 50 41');

  /* ---- HEX 编辑与跨视图刷新 ---- */
  await page.evaluate(() => Rebinder.editHex('legacy', 'gain[0]', 'deadbeef'));
  const hw = await page.evaluate(() => Rebinder.dumpHex(0, 4));
  check(hw === 'efbeadde', 'LE view writes deadbeef as ef be ad de, got ' + hw);
  // 撤销编辑
  await page.keyboard.press('Control+z');
  check((await page.evaluate(() => Rebinder.dumpHex(0, 4))) === '0000803f', 'ctrl+z restores gain0 1.0 bytes');

  /* ---- AP2 自定义 256 字节案例经 API 加载 ---- */
  const ap2 = buildAP2();
  await page.evaluate(({ layout, dump }) => Rebinder.loadObjects(layout, new Uint8Array(dump), 'ap2'), { layout: ap2.layout, dump: Array.from(ap2.dump) });
  const ap2checks = await page.evaluate(() => {
    const a = (v, p) => Rebinder.resolvePath(v, p).abs;
    return {
      qs140: a('s140', 'head.qs[1].f'), qs430: a('s430', 'head.qs[1].f'),
      pose140: a('s140', 'pose[1].m[1][2]'), pose430: a('s430', 'pose[1][1][2]'),
      tail140: a('s140', 'tail'), tail430: a('s430', 'tail'),
      q21: Rebinder.queryOffset(21).map((x) => ({ v: x.view, pad: x.padding, p: x.path, b: x.byteIndex })),
      q187: Rebinder.queryOffset(187).map((x) => ({ v: x.view, p: x.path, b: x.byteIndex, pad: x.padding })),
    };
  });
  check(ap2checks.qs140 === 32 && ap2checks.qs430 === 20, 'AP2 qs offsets ' + JSON.stringify([ap2checks.qs140, ap2checks.qs430]));
  check(ap2checks.pose140 === 212 && ap2checks.pose430 === 184, 'AP2 pose offsets ' + JSON.stringify([ap2checks.pose140, ap2checks.pose430]));
  check(ap2checks.tail140 === 224 && ap2checks.tail430 === 192, 'AP2 tail offsets');
  const q21_430 = ap2checks.q21.find((x) => x.v === 's430');
  const q21_140 = ap2checks.q21.find((x) => x.v === 's140');
  check(q21_430 && !q21_430.pad && q21_430.p === 'head.qs[1].f' && q21_430.b === 1, 'AP2 off21 s430 component+1');
  check(q21_140 && q21_140.pad, 'AP2 off21 s140 padding');
  const q187 = ap2checks.q187.find((x) => x.v === 's430');
  check(q187 && q187.p === 'pose[1].m[1][2]' && q187.b === 3, 'AP2 off187 intra byte 3');

  /* ---- 坏导入保留旧项目 ---- */
  const beforeBad = await page.evaluate(() => Rebinder.views().length);
  const badResult = await page.evaluate(() => {
    try {
      Rebinder.loadObjects({ views: [{ name: 'bad', offset: 0, length: 8, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'a', type: 'u32', offset: 1 }, { name: 'b', type: 'u32' }] }] }, new Uint8Array(8));
      return 'no-throw';
    } catch (e) { return e.message; }
  });
  check(/对齐|offset/.test(badResult), 'bad import rejected: ' + badResult);
  const afterBad = await page.evaluate(() => Rebinder.views().length);
  check(beforeBad === afterBad && afterBad === 2, 'previous project retained after bad import');

  /* ---- 重叠视图：一个视图改写，另一端序视图立即读到新位型 ---- */
  const overlap = await page.evaluate(() => {
    Rebinder.loadObjects({ views: [
      { name: 'ovLE', offset: 0, length: 4, layout: 'std430', major: 'row', endian: 'little', members: [{ name: 'x', type: 'u32' }] },
      { name: 'ovBE', offset: 0, length: 4, layout: 'std430', major: 'row', endian: 'big', members: [{ name: 'x', type: 'u32' }] },
    ] }, new Uint8Array(4));
    Rebinder.editHex('ovLE', 'x', 'deadbeef');
    const q = Rebinder.queryOffset(0);
    const beWord = new DataView(Rebinder.dumpBytes().buffer).getUint32(0, false) >>> 0;
    // 模拟 UI：切到 BE 视图解析同路径，检查 inspector 数据源
    const resolved = Rebinder.resolvePath('ovBE', 'x');
    return { bytes: Rebinder.dumpHex(0, 4), beWord: beWord.toString(16), covers: q.length, beAbs: resolved.abs };
  });
  check(overlap.bytes === 'efbeadde' && overlap.beWord === 'efbeadde', 'overlap edit LE writes bytes and BE view reads same bit pattern word, got ' + JSON.stringify(overlap));
  check(overlap.covers === 2, 'offset0 covered by both overlapping views');

  /* ---- 65 对限制经 UI API ---- */
  const limitMsg = await page.evaluate(() => {
    try { Rebinder.runBatch(Array.from({ length: 65 }, () => ['s140', 's430'])); return 'no-throw'; }
    catch (e) { return e.message; }
  });
  check(/64/.test(limitMsg), '65 pairs rejected clearly');

  await page.screenshot({ path: path.join(__dirname, '..', '.cache', 'smoke.png'), fullPage: false });
  const aria = await page.locator('body').ariaSnapshot();
  fs.writeFileSync(path.join(__dirname, '..', '.cache', 'aria.txt'), aria);

  check(errors.length === 0, 'no uncaught page errors: ' + errors.slice(0, 3).join(' | '));
  const unexpectedConsole = consoleErrors.filter((t) => !/SpecError|迁移类型不匹配|已拒绝|无法通过 fetch|Failed to load resource/i.test(t));
  check(unexpectedConsole.length === 0, 'no unexpected console errors: ' + unexpectedConsole.slice(0, 2).join(' | '));
  await browser.close();
  server.close();
  console.log(`\n${failures === 0 ? 'ALL E2E PASS' : failures + ' FAILURES'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

function buildAP2() {
  const view = (name, std, major) => ({
    name, offset: 0, length: 256, layout: std, major, endian: 'little',
    members: [
      { name: 'head', type: { struct: [
        { name: 'v3', type: { vec: 3, of: 'f32' } },
        { name: 'x', type: 'f32' },
        { name: 'qs', type: { array: 2, of: { struct: [{ name: 'f', type: 'u32' }] } } },
      ] } },
      { name: 'pose', align: 64, offset: 128, type: { array: 2, of: { mat: [2, 3] } } },
      { name: 'tail', type: 'u32' },
    ],
  });
  return { layout: { views: [view('s140', 'std140', 'column'), view('s430', 'std430', 'row')] }, dump: new Uint8Array(256) };
}
