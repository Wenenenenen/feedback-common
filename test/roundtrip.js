/* Node 往返测试：node test/roundtrip.js */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../embed.js');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  passed++;
}

function roundTrip(width, height, pixels, mask, payloadHex, label) {
  const plan = R.computePlan(width, height, pixels, mask);
  const bits = R.hexToBits(payloadHex);
  assert(bits.length <= plan.capacityBits, label + ': 容量足够');
  const marked = R.embedBits(pixels, plan.pairs, bits, width);
  // 未使用的像素不应改变之外，标记图必须仍在 [0,255]（Uint8Array 天然保证，此处显式校验）
  for (let i = 0; i < marked.length; i++) assert(marked[i] >= 0 && marked[i] <= 255, label + ': 像素在界内');
  const { bits: got, restored } = R.extractBits(marked, plan.pairs, bits.length, width);
  assert(R.bitsToHex(got) === payloadHex.toLowerCase(), label + ': 载荷一致');
  assert(Buffer.compare(Buffer.from(restored), Buffer.from(pixels)) === 0, label + ': 原图还原一致');
  assert(R.crc32(restored) === R.crc32(pixels), label + ': CRC32 一致');
  // 用还原图重算规划，坐标前缀必须与使用的一致（读回验证的核心检查）
  const plan2 = R.computePlan(width, height, restored, mask);
  assert(plan2.pairs.length === plan.pairs.length, label + ': 重算容量一致');
  for (let i = 0; i < bits.length; i++) {
    const a = plan.pairs[i];
    const b = plan2.pairs[i];
    assert(a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2, label + ': 坐标前缀一致 #' + i);
  }
  return plan;
}

/* 1. 样图 */
const sample = R.parsePGM(fs.readFileSync(path.join(__dirname, '..', 'samples', 'seal-gray.pgm')));
assert(sample.width === 49 && sample.height === 33, '样图尺寸 49×33');
assert(sample.pixels.length === 49 * 33, '样图栅格长度');
const payloadHex = Buffer.from('批次2026-A01', 'utf8').toString('hex');
const plan = roundTrip(sample.width, sample.height, sample.pixels, null, payloadHex, '样图');
console.log('样图容量:', plan.capacityBits, '位 =', Math.floor(plan.capacityBits / 8), '字节;',
  '块数:', plan.blocks.length,
  '横向块:', plan.blocks.filter(b => b.dir === 'h').length,
  '纵向块:', plan.blocks.filter(b => b.dir === 'v').length);

/* 2. 样图 + 随机掩膜 */
let rnd = 12345;
function rand() { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x80000000; }
const mask = new Uint8Array(sample.width * sample.height);
for (let i = 0; i < mask.length; i++) mask[i] = rand() < 0.6 ? 255 : 0;
roundTrip(sample.width, sample.height, sample.pixels, mask, 'cafe01', '样图+掩膜');

/* 3. 纯黑 / 纯白 / 近黑白边界 */
const black = new Uint8Array(16 * 16); // 全 0
const planBlack = R.computePlan(16, 16, black, null);
assert(planBlack.capacityBits === 128, '纯黑图容量满（16×16/2）');
roundTrip(16, 16, black, null, 'ff00ff00', '纯黑');

const white = new Uint8Array(16 * 16).fill(255);
const planWhite = R.computePlan(16, 16, white, null);
assert(planWhite.capacityBits === 0, '纯白图容量为 0（(255,255) 嵌 b=1 会越界）');

// 0 与 255 横向交替：横向对 (0,255) 的 h=±255 必越界不可用；
// 纵向相邻同值，(0,0) 可用、(255,255) 不可用 → 每块全取纵向，容量 64
const zebra = new Uint8Array(16 * 16);
for (let i = 0; i < zebra.length; i++) zebra[i] = i % 2 ? 255 : 0;
const planZebra = R.computePlan(16, 16, zebra, null);
assert(planZebra.capacityBits === 64, '黑白交替图容量 64（仅纵向 (0,0) 对）');
assert(planZebra.blocks.every(b => b.dir === 'v' && b.hCount === 0), '黑白交替图全部选纵向');
roundTrip(16, 16, zebra, null, 'aa55', '黑白交替');

// 254/255 混合可嵌
const near = new Uint8Array(8 * 8).fill(254);
roundTrip(8, 8, near, null, '0f', '近白(254)');

/* 4. 随机模糊测试 */
for (let t = 0; t < 200; t++) {
  const w = 1 + Math.floor(rand() * 40);
  const h = 1 + Math.floor(rand() * 40);
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) {
    const r = rand();
    // 掺入大量极端值，专门压边界
    px[i] = r < 0.2 ? 0 : r < 0.4 ? 255 : r < 0.5 ? 254 : r < 0.6 ? 1 : Math.floor(rand() * 256);
  }
  const m = rand() < 0.5 ? null : Uint8Array.from({ length: px.length }, () => (rand() < 0.7 ? 255 : 0));
  const p2 = R.computePlan(w, h, px, m);
  if (p2.capacityBits < 4) continue;
  const nNib = 1 + Math.floor(rand() * Math.floor(p2.capacityBits / 4));
  let hex = '';
  for (let i = 0; i < nNib; i++) hex += Math.floor(rand() * 16).toString(16);
  roundTrip(w, h, px, m, hex, '随机#' + t + '(' + w + 'x' + h + ')');
}

/* 5. PGM 写出/解析往返 */
const rewritten = R.parsePGM(R.writePGM(sample.width, sample.height, sample.pixels));
assert(Buffer.compare(Buffer.from(rewritten.pixels), Buffer.from(sample.pixels)) === 0, 'PGM 写出解析往返');

/* 6. 非法输入 */
for (const bad of ['P2\n1 1\n255\n0', 'P5\n2049 1\n255\n' + '\0'.repeat(2049), 'P5\n2 2\n128\nabcd']) {
  let threw = false;
  try { R.parsePGM(Buffer.from(bad, 'latin1')); } catch (e) { threw = true; }
  assert(threw, '拒绝非法 PGM: ' + JSON.stringify(bad.slice(0, 20)));
}
let threw = false;
try { R.hexToBits('zz'); } catch (e) { threw = true; }
assert(threw, '拒绝非十六进制载荷');

console.log('全部通过，共', passed, '项断言。');
