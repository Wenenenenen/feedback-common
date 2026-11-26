/*
 * 真实浏览器性能与补洞溯源测试（Playwright）。
 * 最大支持尺寸 960×540，单帧必须在 2 秒内出结果；
 * 大面积空洞时分类 3 必须能追到被复制的来源像素。
 * 运行：node tools/test_perf_browser.mjs
 */
import { chromium } from './playwright.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + join(root, 'index.html'));

const res = await page.evaluate(() => {
  const E = globalThis.FlowEngine;
  const W = 960;
  const H = 540;
  const N = W * H;
  const rgbA = new Uint8Array(N * 3);
  const rgbB = new Uint8Array(N * 3);
  const mk = (sign) => {
    const dx = new Int16Array(N);
    const dy = new Int16Array(N);
    const z = new Uint16Array(N);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const d = y * W + x;
        const fg = x >= 200 && x < 440 && y >= 120 && y < 360;
        dx[d] = sign * 8;
        z[d] = fg ? 40 : 100 + ((x * 7 + y * 3) % 60);
      }
    }
    return { dx, dy, z };
  };
  for (let d = 0; d < N; d += 1) {
    rgbA[d * 3] = (d * 3) & 255;
    rgbB[d * 3] = (d * 11) & 255;
  }
  const ds = { width: W, height: H, rgbA, rgbB, flowA: mk(1), flowB: mk(-1), names: {} };
  const passes = {
    passA: E.computeRoundTrip(ds.flowA, ds.flowB, W, H),
    passB: E.computeRoundTrip(ds.flowB, ds.flowA, W, H),
  };
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    E.renderFrame(ds, 32, 20, passes);
    times.push(performance.now() - t0);
  }
  // 极端空洞：仅左上角稀疏有效，其余全部补洞
  ds.flowA.z.fill(0);
  ds.flowB.z.fill(0);
  for (let i = 0; i < 2000; i += 1) {
    ds.flowA.z[i] = 60;
    ds.flowB.z[i] = 60;
  }
  const t0 = performance.now();
  const r = E.renderFrame(ds, 32, 20, passes);
  const holeMs = performance.now() - t0;
  const cnt = [0, 0, 0, 0, 0];
  for (const c of r.cls) cnt[c] += 1;
  const far = E.inspectPixel(r, ds, 900, 500);
  // 校验补洞来源确实是某个非空像素，且颜色被复制
  const farIdx = 500 * W + 900;
  const src = far.fillFrom ? far.fillFrom.index : -1;
  let colorCopied = false;
  if (src >= 0) {
    colorCopied = r.rgb[farIdx * 3] === r.rgb[src * 3]
      && r.rgb[farIdx * 3 + 1] === r.rgb[src * 3 + 1]
      && r.rgb[farIdx * 3 + 2] === r.rgb[src * 3 + 2];
  }
  return { times, holeMs, cnt, farClass: far.cls, hasFillFrom: !!far.fillFrom, colorCopied };
});

console.log('960×540 五次渲染 ms:', res.times.map((x) => x.toFixed(1)).join(', '));
console.log('大面积空洞渲染 ms:', res.holeMs.toFixed(1));
console.log('分类计数 [0,1,2,3,4]:', res.cnt.join(','));
const maxMs = Math.max(...res.times, res.holeMs);
assert.ok(maxMs < 2000, `单帧 ${maxMs.toFixed(1)}ms 超过 2000ms 限制`);
assert.ok(res.cnt[3] > 0, '应存在补洞像素（分类 3）');
assert.equal(res.farClass, 3, '远处像素应被补洞');
assert.ok(res.hasFillFrom, '补洞像素必须带可追查来源');
assert.ok(res.colorCopied, '补洞颜色必须复制自来源');
assert.equal(errors.length, 0, `浏览器报错：${errors.join('\n')}`);
console.log('性能与补洞溯源全部通过');
await browser.close();
