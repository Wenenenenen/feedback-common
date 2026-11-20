/* G53 核心逻辑的 Node 测试（node:zlib 作为注入的 zlib 实现） */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlibNode = require('zlib');
const G53 = require('../src/g53.js');

const zlib = {
  deflate: (u8) => zlibNode.deflateSync(Buffer.from(u8)),
  inflate: (u8) => new Uint8Array(zlibNode.inflateSync(Buffer.from(u8))),
};

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓', name);
}
function eq(name, a, b) {
  assert.deepStrictEqual(Array.from(a), Array.from(b), name);
  passed++;
  console.log('  ✓', name);
}

/* ---------- 1. 官方 probes：一维正变换 ---------- */
console.log('[1] forward1d probes');
eq('probe [0,1,2,3,4]',
  G53.forward1d([0, 1, 2, 3, 4]), [0, 2, 4, 0, 0]);
eq('probe [3,-2,7]',
  G53.forward1d([3, -2, 7]), [0, 4, -7]);
eq('probe 单元素',
  G53.forward1d([-5]), [-5]);

/* ---------- 2. 一维逆变换精确还原（含负数/各种长度） ---------- */
console.log('[2] inverse1d 精确还原');
for (let n = 1; n <= 64; n++) {
  const x = [];
  let seed = n * 7 + 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x.push((seed % 401) - 200); // 有正有负
  }
  const back = G53.inverse1d(G53.forward1d(x));
  eq('1D roundtrip n=' + n, back, x);
}

/* ---------- 3. 二维多级 roundtrip：含 1x1、单行、单列、奇数边长 ---------- */
console.log('[3] 二维多级无损 roundtrip');
const dims = [
  [1, 1], [1, 2], [2, 1], [1, 17], [19, 1], [3, 3], [5, 7], [17, 15],
  [65, 49], [64, 64], [33, 31], [100, 1], [1, 100], [2, 2], [1024, 8],
  [7, 1024], [13, 13],
];
for (const [w, h] of dims) {
  const n = w * h;
  const pix = new Array(n);
  let seed = w * 131 + h * 17 + 3;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pix[i] = seed & 0xff;
  }
  const maxL = G53.maxLevels(w, h);
  const levelSet = [...new Set([0, 1, Math.min(2, maxL), maxL])].filter(l => l <= maxL);
  for (const levels of levelSet) {
    const { coeff, dims: d } = G53.decompose(pix.map(p => p - 128), w, h, levels);
    const signed = G53.reconstruct(coeff, w, h, levels, d).map(v => v + 128);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(signed[i] - pix[i]));
    ok(`roundtrip ${w}x${h} L=${levels} maxErr=0`, maxErr === 0);
  }
}

/* ---------- 4. 样例 PNG 的完整 G53 流无损 ---------- */
console.log('[4] 样例 PNG 完整流 roundtrip');
const rawDir = path.join(__dirname, '..', 'work', 'sample-raw');
for (const fn of fs.readdirSync(rawDir).filter(f => f.endsWith('.u8'))) {
  const m = fn.match(/_(\d+)x(\d+)\.u8$/);
  const w = +m[1], h = +m[2];
  const pix = Array.from(fs.readFileSync(path.join(rawDir, fn)));
  const maxL = G53.maxLevels(w, h);
  for (const levels of [0, 1, maxL]) {
    const enc = G53.encodeStream(pix, w, h, levels, zlib);
    // 头校验
    const dv = new DataView(enc.stream.buffer, enc.stream.byteOffset, 14);
    ok(`${fn} L=${levels} 魔数`,
      String.fromCharCode(...enc.stream.slice(0, 4)) === 'G53A');
    ok(`${fn} L=${levels} 头宽高/层数`,
      dv.getUint32(4, true) === w && dv.getUint32(8, true) === h &&
      dv.getUint8(12) === levels);
    // 解析器一次性吃完整流
    const p = new G53.G53StreamParser(zlib);
    p.feed(enc.stream);
    ok(`${fn} L=${levels} 解析完成`, p.state === 'done' && !p.error);
    const rec = p.reconstructSigned();
    let maxErr = 0;
    for (let i = 0; i < pix.length; i++) maxErr = Math.max(maxErr, Math.abs(rec[i] - pix[i]));
    ok(`${fn} L=${levels} 逐像素无损`, maxErr === 0);
    // 层数连续性（全零流 highbit=255 时无层，属合法特例，另在第 5 组覆盖）
    if (enc.highbit !== 255) {
      const bits = p.layers.map(l => l.bit);
      const expect = [];
      for (let b = enc.highbit; b >= 0; b--) expect.push(b);
      eq(`${fn} L=${levels} 层位号连续递减`, bits, expect);
    }
  }
}

/* ---------- 5. 全零系数特例（128 灰度图）：highbit=255，头后无层 ---------- */
console.log('[5] 全零系数流');
{
  const w = 9, h = 7;
  const pix = new Array(w * h).fill(128);
  const enc = G53.encodeStream(pix, w, h, 2, zlib);
  ok('全零 highbit=255', enc.highbit === 255);
  ok('全零流只有 14 字节头', enc.stream.length === 14);
  const p = new G53.G53StreamParser(zlib);
  p.feed(enc.stream);
  ok('全零流解析 done', p.state === 'done');
  const img = p.reconstructImage();
  ok('全零重建全 128', img.every(v => v === 128));
  // 全零流后多一个字节 → 硬错误
  const p2 = new G53.G53StreamParser(zlib);
  const junk = new Uint8Array(enc.stream.length + 1);
  junk.set(enc.stream);
  p2.feed(junk);
  ok('全零流后多余字节报错', p2.state === 'error' && /多余字节/.test(p2.error));
}

/* ---------- 6. 渐进喂入：逐字节 + 随机分片，未完等待、不报错 ---------- */
console.log('[6] 渐进喂入语义');
{
  const w = 65, h = 49;
  const pix = Array.from(fs.readFileSync(
    path.join(rawDir, 'odd-ramp_65x49.u8')));
  const enc = G53.encodeStream(pix, w, h, G53.maxLevels(w, h), zlib);
  const total = enc.stream.length;

  // 6a. 逐字节喂：在最后一个字节到达前，状态只能是 header/waiting，绝不 error
  const p1 = new G53.G53StreamParser(zlib);
  let waitingSeen = false;
  for (let i = 0; i < total - 1; i++) {
    p1.feed(enc.stream.subarray(i, i + 1));
    assert.ok(p1.state !== 'error', '逐字节喂入中途报错: ' + p1.error);
    if (p1.waiting) waitingSeen = true;
  }
  p1.feed(enc.stream.subarray(total - 1));
  ok('逐字节喂入出现过 waiting', waitingSeen);
  ok('逐字节喂入最终 done', p1.state === 'done');

  // 6b. 随机分片，每个前缀的重建都应能运行且与整流前缀一致
  const p2 = new G53.G53StreamParser(zlib);
  let pos = 0, seed = 99;
  const checkpoints = [];
  while (pos < total) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const step = 1 + (seed % 37);
    p2.feed(enc.stream.subarray(pos, Math.min(total, pos + step)));
    pos += step;
    assert.ok(p2.state !== 'error', '随机分片报错: ' + p2.error);
    if (p2.layers.length > 0) {
      const img = p2.reconstructImage();
      ok('分片中间可重建（层 ' + p2.layers.length + '）', img.length === w * h);
      checkpoints.push({ bytes: pos, layers: p2.layers.length });
    }
  }
  ok('随机分片产生过中间预览', checkpoints.length > 0);
  ok('随机分片最终 done', p2.state === 'done');
  const rec = p2.reconstructSigned();
  ok('随机分片无损', rec.every((v, i) => v === pix[i]));

  // 6c. 恰好截在半层：只喂 头+完整若干层+半条记录 → waiting 而非 error
  const full = new G53.G53StreamParser(zlib);
  full.feed(enc.stream);
  const layerCount = full.layers.length;
  // 找第二条记录负载中点
  let cut = 14 + 13 + enc.records[0].compLen + 13 + Math.floor(enc.records[1].compLen / 2);
  const p3 = new G53.G53StreamParser(zlib);
  p3.feed(enc.stream.subarray(0, cut));
  ok('半层截断为 waiting', p3.waiting && p3.state === 'records' && !p3.error);
  ok('半层只提交完整层', p3.layers.length === 1);
  // 继续喂到完整 → 成功
  p3.feed(enc.stream.subarray(cut));
  ok('补全后 done', p3.state === 'done' && p3.layers.length === layerCount);
}

/* ---------- 7. 完整但 CRC 错 → 硬错误，不能当成截断 ---------- */
console.log('[7] CRC 损坏语义');
{
  const w = 17, h = 15;
  const pix = Array.from(fs.readFileSync(path.join(rawDir, 'impulse_17x15.u8')));
  const enc = G53.encodeStream(pix, w, h, 3, zlib);
  // 场景 A：解压成功但 CRC 不符（规范明确要求必须报错，不能当成截断）
  {
    const r0 = enc.records[0];
    const raw0 = zlib.inflate(enc.stream.slice(14 + 13, 14 + 13 + r0.compLen));
    const badRaw = new Uint8Array(raw0);
    badRaw[0] ^= 0x01;
    const badComp = zlib.deflate(badRaw);
    const corrupt = new Uint8Array(enc.stream.length - r0.compLen + badComp.length);
    corrupt.set(enc.stream.subarray(0, 14 + 13), 0);
    corrupt.set(badComp, 14 + 13);
    corrupt.set(enc.stream.subarray(14 + 13 + r0.compLen), 14 + 13 + badComp.length);
    const p = new G53.G53StreamParser(zlib);
    p.feed(corrupt);
    ok('完整记录 CRC 错 → error', p.state === 'error' && /CRC32/.test(p.error));
    // 再喂正确的后续字节也不能恢复
    p.feed(enc.stream.subarray(corrupt.length));
    ok('错误状态持续', p.state === 'error');
  }
  // 场景 B：压缩流本身损坏导致无法解压，同样是硬错误而非截断
  {
    const corrupt = new Uint8Array(enc.stream);
    corrupt[14 + 13 + 5] ^= 0xff;
    const p = new G53.G53StreamParser(zlib);
    p.feed(corrupt);
    ok('压缩负载损坏 → 硬错误', p.state === 'error' &&
      (/CRC32|zlib/.test(p.error)));
  }

  // 损坏头（魔数）
  const badMagic = new Uint8Array(enc.stream);
  badMagic[0] = 0x00;
  const p2 = new G53.G53StreamParser(zlib);
  p2.feed(badMagic);
  ok('魔数错误报错', p2.state === 'error' && /魔数/.test(p2.error));

  // 层号不连续：手工把第二条记录位号改掉
  const badSeq = new Uint8Array(enc.stream);
  const rec1Start = 14 + 13 + enc.records[0].compLen;
  badSeq[rec1Start] = enc.records[1].bit + 3;
  const p3 = new G53.G53StreamParser(zlib);
  p3.feed(badSeq);
  ok('层号不连续报错', p3.state === 'error' && /不连续/.test(p3.error));
}

/* ---------- 8. 补齐位：非零补齐必须报错 ---------- */
console.log('[8] 补齐位处理');
{
  const w = 3, h = 3; // 9 系数，最高层 9 个幅值位 + 可能符号位，天然非字节对齐
  const pix = [0, 50, 255, 128, 9, 200, 1, 254, 77];
  const enc = G53.encodeStream(pix, w, h, 2, zlib);
  const p = new G53.G53StreamParser(zlib);
  p.feed(enc.stream);
  ok('正常补齐（全 0）通过', p.state === 'done');

  // 手工构造一条补齐位非 0 的负载并重新压缩替换
  const rec0 = enc.records[0];
  const raw0 = zlib.inflate(enc.stream.slice(14 + 13, 14 + 13 + rec0.compLen));
  if (raw0.length > 0) {
    const tampered = new Uint8Array(raw0);
    tampered[tampered.length - 1] |= 0x01; // 最后一字节最低位（补齐区）置 1
    const recomp = zlib.deflate(tampered);
    const bad = new Uint8Array(14 + 13 + recomp.length);
    bad.set(enc.stream.subarray(0, 14), 0);
    const dv = new DataView(bad.buffer);
    dv.setUint8(14, rec0.bit);
    dv.setUint32(15, tampered.length, true);
    dv.setUint32(19, recomp.length, true);
    dv.setUint32(23, G53.crc32(tampered), true);
    bad.set(recomp, 27);
    const pp = new G53.G53StreamParser(zlib);
    pp.feed(bad);
    ok('非零补齐位报错', pp.state === 'error' && /补齐位/.test(pp.error));
  }
}

/* ---------- 9. 头校验：层数超限、边长越界 ---------- */
console.log('[9] 头合法性');
{
  const pix = new Array(16).fill(200);
  const enc = G53.encodeStream(pix, 4, 4, 1, zlib);
  const bad = new Uint8Array(enc.stream);
  bad[12] = 99; // 层数超限（4x4 最多 2 层）
  const p = new G53.G53StreamParser(zlib);
  p.feed(bad);
  ok('层数超限报错', p.state === 'error' && /可变换次数/.test(p.error));

  const bad2 = new Uint8Array(enc.stream);
  const dv = new DataView(bad2.buffer);
  dv.setUint32(4, 1025, true); // 边长越界
  const p2 = new G53.G53StreamParser(zlib);
  p2.feed(bad2);
  ok('边长越界报错', p2.state === 'error' && /边长越界/.test(p2.error));

  assert.throws(() => G53.encodeStream(pix, 4, 4, 5, zlib), /层数非法/);
  ok('编码侧拒绝非法层数', true);
}

/* ---------- 10. 渐进过程中误差单调下降，最终 maxErr=0 ---------- */
console.log('[10] 渐进误差曲线');
{
  const w = 33, h = 31;
  let seed = 7;
  const pix = new Array(w * h);
  for (let i = 0; i < pix.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pix[i] = seed & 0xff;
  }
  const enc = G53.encodeStream(pix, w, h, G53.maxLevels(w, h), zlib);
  const p = new G53.G53StreamParser(zlib);
  p.feed(enc.stream.subarray(0, 14)); // 先喂头
  const errs = [];
  let pos = 14;
  for (let r = 0; r < enc.records.length; r++) {
    const end = pos + 13 + enc.records[r].compLen;
    p.feed(enc.stream.subarray(pos, end));
    pos = end;
    assert.ok(p.state === 'records' || p.state === 'done');
    const rec = p.reconstructSigned();
    let e = 0;
    for (let i = 0; i < pix.length; i++) e = Math.max(e, Math.abs(rec[i] - pix[i]));
    errs.push(e);
  }
  ok('每层后误差非增', errs.every((e, i) => i === 0 || e <= errs[i - 1]));
  ok('末层误差为 0', errs[errs.length - 1] === 0);
  ok('首层已有粗略预览（误差有限）', errs[0] <= 255);
}

/* ---------- 11. 单行 / 单列 专项 ---------- */
console.log('[11] 单行单列');
for (const [w, h, file] of [
  [19, 1, 'single-row_19x1.u8'],
  [1, 17, 'single-column_1x17.u8'],
]) {
  const pix = Array.from(fs.readFileSync(path.join(rawDir, file)));
  const maxL = G53.maxLevels(w, h);
  const enc = G53.encodeStream(pix, w, h, maxL, zlib);
  const p = new G53.G53StreamParser(zlib);
  p.feed(enc.stream);
  ok(`${file} 解析完成`, p.state === 'done');
  const rec = p.reconstructSigned();
  ok(`${file} 无损`, rec.every((v, i) => v === pix[i]));
  // 单轴为 1 时 dims 另一轴仍在缩小
  ok(`${file} 轮次尺寸正确`,
    p.dims.every(d => d.w >= 1 && d.h >= 1) &&
    p.dims[p.dims.length - 1].w === 1 && p.dims[p.dims.length - 1].h === 1);
}

/* ---------- 12. 与 Python 独立参考实现交叉验证 ---------- */
console.log('[12] Python 参考交叉验证（若参考输出存在）');
const refFile = path.join(__dirname, '..', 'work', 'reference');
if (fs.existsSync(refFile)) {
  for (const fn of fs.readdirSync(refFile).filter(f => f.endsWith('.g53'))) {
    const g53 = fs.readFileSync(path.join(refFile, fn));
    const base = fn.replace('.g53', '');
    const m = base.match(/(\d+)x(\d+)-L(\d+)/);
    const w = +m[1], h = +m[2], levels = +m[3];
    const raw = fs.readFileSync(path.join(refFile, base + '.u8'));
    const p = new G53.G53StreamParser(zlib);
    p.feed(g53);
    ok(`解析 Python 流 ${fn}`, p.state === 'done' && p.levels === levels);
    const rec = p.reconstructSigned();
    ok(`Python 流 ${fn} 无损还原`, rec.every((v, i) => v === raw[i]));
  }
} else {
  console.log('  （跳过：稍后生成参考实现）');
}

console.log(`\n全部通过：${passed} 项断言`);
