/* msdf-core 单元测试：node test/msdf-core.test.js */
'use strict';
const assert = require('assert');
const zlib = require('zlib');
const MSDF = require('../msdf-core.js');

const DOC = require('../samples/vector-msdf-cases.json');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}
function approx(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= (eps || 1e-6), `${msg || ''} 期望 ${b}，实际 ${a}`);
}

// ---------- 校验 ----------
ok('validateDoc 接受内置样例', () => {
  const { errors } = MSDF.validateDoc(DOC);
  assert.deepStrictEqual(errors, []);
});
ok('validateDoc 拒绝坏 mask / 检出未闭合', () => {
  const bad = { bounds: [0, 0, 1, 1], size: [8, 8], range: 1, glyphs: [{ id: 'x', contours: [[{ mask: 'RB', p: [[0, 0], [1, 0]] }, { mask: 'RG', p: [[2, 0], [0, 0]] }]] }] };
  const r = MSDF.validateDoc(bad);
  assert.ok(r.errors.some(e => e.includes('mask')));
  assert.ok(r.warnings.some(e => e.includes('未闭合')));
});

// ---------- 求值 / 切向 ----------
ok('evalAt/tanAt 直线与二次曲线', () => {
  const out = [0, 0], tg = [0, 0];
  MSDF.evalAt([[0, 0], [4, 0]], 0.25, out);
  approx(out[0], 1, 1e-12); approx(out[1], 0, 1e-12);
  MSDF.evalAt([[0, 0], [1, 2], [2, 0]], 0.5, out);
  approx(out[0], 1, 1e-12); approx(out[1], 1, 1e-12);
  MSDF.tanAt([[0, 0], [1, 2], [2, 0]], 0.5, tg);
  approx(tg[0], 1, 1e-9); approx(tg[1], 0, 1e-9);
});

// ---------- 伪距离 ----------
ok('端点超出切线端时伪距离修正', () => {
  const segs = MSDF.prepSegments({ contours: [[{ mask: 'RG', p: [[2, 2], [14, 2]] }]] });
  const sd = { t: 0, dTrue: 0, dPseudo: 0 };
  MSDF.segDistance(segs[0], 0.25, 0.25, sd);
  approx(sd.t, 0, 1e-12);
  approx(sd.dTrue, -Math.hypot(1.75, 1.75), 1e-9, '真实距离');
  approx(sd.dPseudo, -1.75, 1e-9, '伪距离');
  // 未超出切线端：不做修正
  MSDF.segDistance(segs[0], 8, 0.5, sd);
  approx(sd.dPseudo, -1.5, 1e-9);
  approx(sd.dTrue, -1.5, 1e-9);
});

ok('二次曲线最近点与符号（左侧为正）', () => {
  const segs = MSDF.prepSegments({ contours: [[{ mask: 'RG', p: [[0, 0], [1, 2], [2, 0]] }]] });
  const sd = { t: 0, dTrue: 0, dPseudo: 0 };
  MSDF.segDistance(segs[0], 1, 0.5, sd);   // 顶点 (1,1) 下方 → 右侧 → 负
  approx(sd.t, 0.5, 1e-4);
  approx(sd.dTrue, -0.5, 1e-4);
  MSDF.segDistance(segs[0], 1, 1.5, sd);   // 上方 → 左侧 → 正
  approx(sd.dTrue, 0.5, 1e-4);
});

ok('三次曲线最近点不发散', () => {
  const segs = MSDF.prepSegments({ contours: [[{ mask: 'GB', p: [[0, 0], [0, 2], [2, 2], [2, 0]] }]] });
  const sd = { t: 0, dTrue: 0, dPseudo: 0 };
  MSDF.segDistance(segs[0], 1, 1.8, sd);   // 拱顶 (1,1.5) 上方
  assert.ok(Number.isFinite(sd.dTrue) && Number.isFinite(sd.t));
  approx(sd.t, 0.5, 1e-3);
  approx(sd.dTrue, 0.3, 1e-3);
});

// ---------- 场计算：方形 ----------
function glyphSegs(gi) { return MSDF.prepSegments(DOC.glyphs[gi]); }

ok('方形：内部为正、外部为负、角外 RGB 用伪距离', () => {
  const segs = glyphSegs(0);
  const F = MSDF.computeFieldSync(segs, 32, 32, DOC.bounds);
  const at = (i, j) => j * 32 + i;
  // 中心纹素 (15,15) → p=(8.25,8.25)，最近边 x=14 → +5.75
  approx(F.A[at(15, 15)], 5.75, 1e-4, '中心 A');
  assert.ok(F.A[at(15, 15)] > 0);
  // 角外纹素 (0,0) → p=(0.25,0.25)：A 为真实距离，RGB 为伪距离
  approx(F.A[at(0, 0)], -Math.hypot(1.75, 1.75), 1e-4, '角外 A');
  approx(F.rawR[at(0, 0)], -1.75, 1e-4, '角外 R 伪距离');
  approx(F.rawG[at(0, 0)], -1.75, 1e-4, '角外 G 伪距离');
  approx(F.rawB[at(0, 0)], -1.75, 1e-4, '角外 B 伪距离');
  assert.strictEqual(F.corrected[at(0, 0)], 0, '同号不应修正');
  // 命中段记录
  assert.ok(F.segA[at(15, 15)] >= 0);
});

ok('带孔尖峰：孔内为负、实心为正', () => {
  const segs = glyphSegs(1);
  const F = MSDF.computeFieldSync(segs, 32, 32, DOC.bounds);
  const at = (i, j) => j * 32 + i;
  // p=(8.25,5.25) 在孔 (7..9, 4..6) 内
  assert.ok(F.A[at(16, 10)] < 0, '孔内应为负，实际 ' + F.A[at(16, 10)]);
  // p=(8.25,10.25) 在山峰实心内
  assert.ok(F.A[at(16, 20)] > 0, '实心应为正，实际 ' + F.A[at(16, 20)]);
  // p=(0.25,0.25) 在外部
  assert.ok(F.A[at(0, 0)] < 0);
});

// ---------- 中位数/A 异号修正 ----------
ok('中位数与 A 异号时用 A 修正', () => {
  const F = MSDF.newField(2, 1);
  F.R.set([1, -1]); F.G.set([1, -0.8]); F.B.set([-0.2, -0.6]); F.A.set([-0.5, -0.4]);
  MSDF.applyCorrection(F);
  assert.strictEqual(F.nCorr, 1);
  assert.strictEqual(F.corrected[0], 1);
  approx(F.R[0], -0.5, 0); approx(F.G[0], -0.5, 0); approx(F.B[0], -0.5, 0);
  approx(F.rawR[0], 1, 0, '修正前保留');
  assert.strictEqual(F.corrected[1], 0, '同号不动');
});

// ---------- 编码 ----------
ok('距离编码：0→0.5，±range→1/0，越界截断', () => {
  assert.strictEqual(MSDF.encodeDist(0, 4), 128);
  assert.strictEqual(MSDF.encodeDist(4, 4), 255);
  assert.strictEqual(MSDF.encodeDist(-4, 4), 0);
  assert.strictEqual(MSDF.encodeDist(99, 4), 255);
  assert.strictEqual(MSDF.encodeDist(-99, 4), 0);
  assert.strictEqual(MSDF.encodeDist(2, 4), 191); // 0.75*255=191.25
});

// ---------- PNG ----------
function parsePng(buf) {
  assert.deepStrictEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    assert.strictEqual(MSDF.crc32(buf.subarray(pos + 4, pos + 8 + len)), crc, type + ' CRC');
    chunks.push({ type, data });
    pos += 12 + len;
  }
  return chunks;
}

ok('PNG：结构、CRC、顶行在前、无预乘 RGBA', () => {
  const w = 2, h = 2;
  // 纹素序（j 向上）：底行 j=0 → R=10,11；顶行 j=1 → R=20,21；A 通道放不同值验证不预乘
  const rgba = new Uint8Array([
    10, 1, 2, 30, 11, 1, 2, 31,   // j=0
    20, 1, 2, 32, 21, 1, 2, 33,   // j=1
  ]);
  const top = MSDF.flipRowsTopFirst(rgba, w, h);
  const png = MSDF.pngEncode(w, h, top);
  const chunks = parsePng(Buffer.from(png));
  const ihdr = chunks.find(c => c.type === 'IHDR');
  assert.strictEqual(ihdr.data.readUInt32BE(0), 2);
  assert.strictEqual(ihdr.data.readUInt32BE(4), 2);
  assert.strictEqual(ihdr.data[8], 8);
  assert.strictEqual(ihdr.data[9], 6);
  assert.ok(!chunks.some(c => c.type === 'gAMA' || c.type === 'iCCP' || c.type === 'sRGB'), '不应有色彩块');
  const idat = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
  const raw = zlib.inflateSync(idat);
  assert.strictEqual(raw.length, (w * 4 + 1) * h);
  assert.strictEqual(raw[0], 0, '滤波类型 0');
  // 第一行应为顶行 j=1
  assert.strictEqual(raw[1], 20);
  assert.strictEqual(raw[5], 21);
  // 第二行为 j=0（滤波字节在 raw[9]），且 alpha=30 时 RGB 不被预乘
  assert.strictEqual(raw[9], 0, '第二行滤波类型 0');
  assert.strictEqual(raw[10], 10);
  assert.strictEqual(raw[13], 30);
  assert.strictEqual(chunks[chunks.length - 1].type, 'IEND');
});

console.log(`\n全部通过（${passed} 项）`);
