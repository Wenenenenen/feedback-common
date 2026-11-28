/* 端到端流程测试：嵌入 → 旁车 JSON → 读回验证（含篡改用例）。node test/sidecar-flow.js */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../embed.js');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed++;
}
process.on('uncaughtException', (e) => {
  console.error('FAIL: ' + e.message);
  process.exit(1);
});

const sample = R.parsePGM(fs.readFileSync(path.join(__dirname, '..', 'samples', 'seal-gray.pgm')));
const mask = Uint8Array.from({ length: sample.width * sample.height }, (_, i) => (i * 7 % 13 < 9 ? 255 : 0));

/* —— 嵌入侧（对应页面第 2 步） —— */
function embedSidecar(orig, maskPixels, payloadHex) {
  const plan = R.computePlan(orig.width, orig.height, orig.pixels, maskPixels);
  const bits = R.hexToBits(payloadHex);
  const marked = R.embedBits(orig.pixels, plan.pairs, bits, orig.width);
  const used = plan.pairs.slice(0, bits.length);
  const sidecar = {
    format: 'reversible-scan-stamp',
    version: 1,
    image: { width: orig.width, height: orig.height },
    bitCount: bits.length,
    payloadHex,
    originalCrc32: R.crc32(orig.pixels),
    maskCrc32: maskPixels ? R.crc32(maskPixels) : null,
    pairs: used.map((p) => [p.x1, p.y1, p.x2, p.y2]),
  };
  return { marked, sidecarText: JSON.stringify(sidecar, null, 2) + '\n' };
}

/* —— 验证侧（对应页面第 3 步的六项检查） —— */
let caseLabel = '';
function verify(markedImg, sidecarText, maskPixels) {
  const sc = JSON.parse(sidecarText);
  const A = (cond, msg) => assert(cond, caseLabel + msg);
  A(sc.image.width === markedImg.width && sc.image.height === markedImg.height, '尺寸一致');
  A(Number.isInteger(sc.bitCount) && sc.bitCount > 0 && sc.bitCount % 4 === 0, '位数合法');
  A(sc.payloadHex.length * 4 === sc.bitCount, '载荷长度与位数一致');
  A(Array.isArray(sc.pairs) && sc.pairs.length === sc.bitCount, '坐标数量与位数一致');
  if (sc.maskCrc32 != null) {
    A(maskPixels && R.crc32(maskPixels) === sc.maskCrc32, '掩膜 CRC32 一致');
  } else {
    A(maskPixels == null, '未使用掩膜');
  }
  const pairs = sc.pairs.map((p) => ({ x1: p[0], y1: p[1], x2: p[2], y2: p[3] }));
  const { bits, restored } = R.extractBits(markedImg.pixels, pairs, sc.bitCount, markedImg.width);
  A(R.bitsToHex(bits) === sc.payloadHex, '提取载荷一致');
  A(R.crc32(restored) === sc.originalCrc32, '原栅格 CRC32 一致');
  const plan = R.computePlan(markedImg.width, markedImg.height, restored, maskPixels);
  A(plan.pairs.length >= sc.bitCount, '重算容量足够');
  for (let i = 0; i < sc.bitCount; i++) {
    const a = plan.pairs[i], b = pairs[i];
    A(a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2, '坐标前缀一致 #' + i);
  }
  return { restored, payloadHex: sc.payloadHex };
}

const payloadHex = Buffer.from('批次2026-A01', 'utf8').toString('hex');

/* 1. 无掩膜全流程 */
caseLabel = '用例1: ';
{
  const { marked, sidecarText } = embedSidecar(sample, null, payloadHex);
  const markedImg = R.parsePGM(R.writePGM(sample.width, sample.height, marked)); // 模拟写盘再读回
  const r = verify(markedImg, sidecarText, null);
  assert(Buffer.compare(Buffer.from(r.restored), Buffer.from(sample.pixels)) === 0, '无掩膜：原图取回一致');
}

/* 2. 有掩膜全流程 */
caseLabel = '用例2: ';
{
  const { marked, sidecarText } = embedSidecar(sample, mask, payloadHex);
  const markedImg = { width: sample.width, height: sample.height, pixels: marked };
  const r = verify(markedImg, sidecarText, mask);
  assert(Buffer.compare(Buffer.from(r.restored), Buffer.from(sample.pixels)) === 0, '有掩膜：原图取回一致');
  // 掩膜之外（被禁用的像素）不得被改动
  for (let i = 0; i < marked.length; i++) {
    if (mask[i] === 0) assert(marked[i] === sample.pixels[i], '掩膜禁用像素未改动 #' + i);
  }
}

/* 3. 篡改标记图 → CRC 必失败 */
caseLabel = '用例3: ';
{
  const { marked, sidecarText } = embedSidecar(sample, null, payloadHex);
  const tampered = new Uint8Array(marked);
  tampered[tampered.length - 1] ^= 0xff; // 改一个未被嵌入使用的像素
  let threw = false;
  try { verify({ width: sample.width, height: sample.height, pixels: tampered }, sidecarText, null); }
  catch (e) { threw = true; }
  assert(threw, '篡改标记图被拒绝');
}

/* 4. 错误掩膜 → 拒绝 */
caseLabel = '用例4: ';
{
  const { marked, sidecarText } = embedSidecar(sample, mask, payloadHex);
  const wrongMask = new Uint8Array(mask);
  wrongMask[0] = wrongMask[0] ? 0 : 255;
  let threw = false;
  try { verify({ width: sample.width, height: sample.height, pixels: marked }, sidecarText, wrongMask); }
  catch (e) { threw = true; }
  assert(threw, '错误掩膜被拒绝');
}

/* 5. 篡改旁车坐标 → 拒绝 */
caseLabel = '用例5: ';
{
  const { marked, sidecarText } = embedSidecar(sample, null, payloadHex);
  const sc = JSON.parse(sidecarText);
  sc.pairs[0] = [sc.pairs[0][0], sc.pairs[0][1], sc.pairs[0][2], sc.pairs[0][3] === 0 ? 1 : 0];
  let threw = false;
  try { verify({ width: sample.width, height: sample.height, pixels: marked }, JSON.stringify(sc), null); }
  catch (e) { threw = true; }
  assert(threw, '篡改坐标被拒绝');
}

/* 6. 换批次号重嵌 */
caseLabel = '用例6: ';
{
  const first = embedSidecar(sample, null, payloadHex);
  const r = verify({ width: sample.width, height: sample.height, pixels: first.marked }, first.sidecarText, null);
  const payload2 = Buffer.from('批次2026-B02', 'utf8').toString('hex');
  const reembed = embedSidecar({ width: sample.width, height: sample.height, pixels: r.restored }, null, payload2);
  const direct = embedSidecar(sample, null, payload2);
  assert(Buffer.compare(Buffer.from(reembed.marked), Buffer.from(direct.marked)) === 0, '重嵌与直接嵌入一致');
  const r2 = verify({ width: sample.width, height: sample.height, pixels: reembed.marked }, reembed.sidecarText, null);
  assert(r2.payloadHex === payload2, '重嵌后取回新批次号');
}

console.log('全流程测试通过，共', passed, '项断言。');
