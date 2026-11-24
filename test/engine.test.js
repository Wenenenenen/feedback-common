'use strict';
/*
 * 引擎测试：
 * 1. 内置样例的解析解向量；
 * 2. 随机用例下系数法与逐次扫描暴力重演对拍（含同刻换页、整数扫描时刻、
 *    首扫前曝光、巨大 tau 等边界）；
 * 3. 像素记录与渲染结果一致；
 * 4. 满额输入（256×144、32 页、2 万换页、跳到第 10 亿扫）5 秒内出图。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

// ---- 暴力参考：逐次扫描重演 ---------------------------------------------
function bruteAvg(model, cam, x, y) {
  const { P, tau, H, W, swT, swPage } = model;
  const t0 = cam.start + y * cam.rowDelay;
  const t1 = t0 + cam.duration;
  const off = P * y / H;
  const pageAt = (s) => {
    let pg = -1;
    for (let k = 0; k < swT.length; k++) {
      if (swT[k] <= s) pg = swPage[k]; else break;
    }
    return pg;
  };
  const G = (p) => (p >= 0 ? model.pages[p][y * W + x] / 255 : 0);
  // 重演 t0 之前的所有扫描，求 L(t0)
  let L = 0, Gprev = 0, jLast = -1;
  for (let j = 0; ; j++) {
    const sj = off + P * j;
    if (sj > t0) break;
    if (j > 0) L = Gprev + (L - Gprev) * Math.exp(-P / tau);
    Gprev = G(pageAt(sj));
    jLast = j;
  }
  let curPage = -1;
  if (jLast >= 0) {
    L = Gprev + (L - Gprev) * Math.exp(-(t0 - (off + P * jLast)) / tau);
    curPage = pageAt(off + P * jLast);
  }
  // 分段积分
  let I = 0, t = t0, j = jLast + 1;
  while (t < t1) {
    const sj = off + P * j;
    const nextT = Math.min(sj, t1);
    const s = nextT - t;
    const g = G(curPage);
    I += g * s + (L - g) * (-tau * Math.expm1(-s / tau));
    L = g + (L - g) * Math.exp(-s / tau);
    t = nextT;
    if (nextT === sj) { curPage = pageAt(sj); j++; }
  }
  return I / cam.duration;
}

// ---- 1. 样例向量 ---------------------------------------------------------
{
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'phosphor-scanout.json'), 'utf8'));
  const model = E.makeModel(sample);
  const img = E.render(model, sample.camera);
  // 手算：行0 [4,16) 在 t=8 换页；行1 [5,17) 在 t=4 已锁页1，t=12 再扫
  const expected = [111, 22, 42, 210];
  assert.deepStrictEqual(Array.from(img), expected, '样例像素不符: ' + Array.from(img));
  // 与暴力重演对拍
  const f = E.renderFloat(model, sample.camera);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const avg = bruteAvg(model, sample.camera, x, y);
      assert.ok(Math.abs(f[y * 2 + x] - avg * 255) < 1e-9, `样例(${x},${y}) 与暴力不符`);
    }
  }
  const rec = E.pixelRecord(model, sample.camera, 1, 1);
  assert.strictEqual(rec.pngValue, 210);
  assert.strictEqual(rec.segments.length, 1); // 窗内驱动恒定（页1），合并为一段
  assert.strictEqual(rec.segments[0].scans, 1); // 段内仅 t=12 一次扫描（t=4 在曝光前）
  assert.strictEqual(rec.locks.length, 2); // 曝光前 t=4 锁页 + 窗内 t=12 锁页
  console.log('✓ 样例向量', Array.from(img), '像素(1,1)锁页数', rec.locks.length);
}

// ---- 2. 随机对拍 ---------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

{
  const rnd = mulberry32(20261125);
  const ri = (n) => Math.floor(rnd() * n);
  let checked = 0;
  for (let caseNo = 0; caseNo < 400; caseNo++) {
    const W = 1 + ri(5), H = 1 + ri(4);
    const P = [1, 2, 3, 8, 8, 17, 100, 997][ri(8)];
    const tau = [1, 2, 3, 3, 10, 60, 2000, 1000000000][ri(8)];
    const np = 1 + ri(4);
    const pages = Array.from({ length: np }, () =>
      Array.from({ length: W * H }, () => ri(256)));
    const nsw = ri(13);
    const switches = Array.from({ length: nsw }, () => [ri(240), ri(np)]);
    const cam = { start: ri(400), duration: 1 + ri(150), rowDelay: ri(4) };
    const model = E.makeModel({ size: [W, H], P, tau, pages, switches });
    const f = E.renderFloat(model, cam);
    const img = E.render(model, cam);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const avg = bruteAvg(model, cam, x, y);
        const got = f[y * W + x];
        assert.ok(Math.abs(got - avg * 255) < 1e-6,
          `用例${caseNo} (${x},${y}): 系数法 ${got} vs 暴力 ${avg * 255}`);
        // 像素记录一致
        const rec = E.pixelRecord(model, cam, x, y);
        assert.ok(Math.abs(rec.average * 255 - got) < 1e-6, `用例${caseNo} (${x},${y}) 记录均值不符`);
        assert.strictEqual(rec.pngValue, img[y * W + x], `用例${caseNo} (${x},${y}) 记录PNG值与图不符`);
        checked++;
      }
    }
  }
  console.log('✓ 随机对拍 400 用例，共校验', checked, '像素（系数法=暴力重演，记录=图）');
}

// ---- 3. 同刻换页取文件最后一条 / 同刻换页先于扫描 --------------------------
{
  // P=H=2 → 行0扫描时刻为整数 0,2,4,...；t=0 三条换页同刻，应取最后的页2
  const model = E.makeModel({
    size: [1, 2], P: 2, tau: 5,
    pages: [[10, 10], [20, 20], [200, 200]],
    switches: [[0, 0], [0, 2], [0, 1], [4, 0]], // 同刻文件最后一条是页1？不，[0,1]在最后
  });
  // 文件次序: (0,0),(0,2),(0,1) → 同刻取页1；t=4 换页0
  const cam = { start: 0, duration: 2, rowDelay: 0 };
  const rec = E.pixelRecord(model, cam, 0, 0);
  assert.strictEqual(rec.segments[0].page, 1, '同刻应取文件最后一条（页1）');
  assert.strictEqual(rec.locks[0].page, 1);
  console.log('✓ 同刻换页取文件最后一条，且先于扫描生效');
}

// ---- 4. 满额性能：256×144、32 页、2 万换页、跳到第 10 亿扫 -----------------
{
  const W = 256, H = 144;
  const full = {
    size: [W, H], P: 997, tau: 2000,
    pages: Array.from({ length: 32 }, (_, i) => new Array(W * H).fill(i < 31 ? i : 255)),
    switches: Array.from({ length: 20000 }, (_, i) => [1009 * i, i % 32]),
    camera: { start: 997 * 1e9, duration: 100, rowDelay: 1 },
  };
  const model = E.makeModel(full);
  const t0 = process.hrtime.bigint();
  const img = E.render(model, full.camera);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let mean = 0;
  for (const v of img) mean += v;
  mean /= img.length;
  console.log(`✓ 满额渲染 ${ms.toFixed(1)} ms（限 5000 ms），平均亮度 ${mean.toFixed(6)}`);
  assert.ok(ms < 5000, '满额渲染超时');
  // 像素记录与图一致（独立逐段路径）
  for (const [x, y] of [[0, 0], [255, 143], [123, 45], [7, 100], [200, 72]]) {
    const rec = E.pixelRecord(model, full.camera, x, y);
    assert.strictEqual(rec.pngValue, img[y * W + x], `满额 (${x},${y}) 记录与图不符`);
  }
  console.log('✓ 满额像素记录与图一致');
}

console.log('\n全部测试通过');
