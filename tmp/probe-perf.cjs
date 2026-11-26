const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8137/');
  await page.addScriptTag({ url: '/js/engine.js' });
  const result = await page.evaluate(async () => {
    const t0 = performance.now();
    const resp = await fetch('/tmp/full-d64.pdq');
    const buf = await resp.arrayBuffer();
    const tFetch = performance.now() - t0;
    const d0 = performance.now();
    const r = PDQEngine.decode(buf);
    const decodeMs = performance.now() - d0;
    return {
      bytes: buf.byteLength,
      fetchMs: Math.round(tFetch),
      ok: r.ok, records: r.parsed.records.length, frames: r.frames,
      intervals: r.channelData.map(c => c.intervals.length),
      timings: {
        parse: Math.round(r.timings.parseMs),
        channels: Math.round(r.timings.channelsMs),
        total: Math.round(r.timings.totalMs)
      },
      decodeWallMs: Math.round(decodeMs),
      mem: performance.memory ? { usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1048576) } : null
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
