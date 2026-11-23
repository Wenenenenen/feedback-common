/* 浏览器端性能压测：node tests/browser.perf.js */
const path = require('node:path');
const { chromium } = require('/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');
const url = 'file://' + path.resolve(__dirname, '../index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);

  const report = await page.evaluate(async () => {
    const G = 4096, W = 200000;
    const nets = {}, ports = {}, gates = [];
    for (let i = 0; i < G; i++) {
      nets['a' + i] = 1; nets['y' + i] = 1;
      ports['p' + i] = 'a' + i;
      gates.push({ id: 'inv' + i, op: 'NOT', in: ['a' + i], out: 'y' + i, delay: 1 });
    }
    const writes = new Array(W);
    for (let k = 0; k < W; k++) writes[k] = [1 + k, 'p' + (k % G), k % 2 === 0 ? '1' : '0'];
    const model = { until: W + 2, nets, ports, gates, writes };

    const t0 = performance.now();
    const res = FactoryBus.run(model);
    const t1 = performance.now();
    const vcd = FactoryBusExport.exportVcd(res);
    const json = FactoryBusExport.exportJson(res);
    const t2 = performance.now();
    const replay = FactoryBus.verifyReplay(model, res);
    const t3 = performance.now();
    return {
      ok: res.ok, kernelMs: Math.round(t1 - t0), exportMs: Math.round(t2 - t1),
      replayMs: Math.round(t3 - t2), totalMs: Math.round(t2 - t0),
      vcdBytes: vcd.length, jsonBytes: json.length, replayOk: replay.ok,
    };
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || !report.replayOk) { console.error('功能失败'); process.exit(1); }
  if (report.totalMs >= 10000) { console.error('超 10s 预算'); process.exit(1); }
  if (errors.length) { console.error('页面错误:', errors); process.exit(1); }
  console.log('浏览器端 10 秒预算内完成（内核+导出），重演一致');
  await browser.close();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
