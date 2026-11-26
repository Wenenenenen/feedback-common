// 坏输入校验测试：每个畸形 ZIP/JSON 必须抛出带文件或字段名的错误
const assert = require('assert');
const fs = require('fs');
const ROOT = '/home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk';
require(ROOT + '/src/zip.js');
require(ROOT + '/src/io.js');
const { unzip } = globalThis.StokesZip;
const { buildProject, parseCase, parseGrayPgm, parseMaskPgm } = globalThis.StokesIO;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n  ', e.message); process.exitCode = 1; }
}
function expectThrow(fn, keywords) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, '应抛出错误');
  for (const kw of keywords) {
    assert.ok(err.message.indexOf(kw) !== -1, '错误信息应包含 "' + kw + '"，实际: ' + err.message);
  }
}
function zipFrom(obj) {
  // 用存储方式手工拼一个最小 ZIP（本地头+中央目录+EOCD），无压缩
  const enc = (s) => new TextEncoder().encode(s);
  const chunks = [];
  const central = [];
  let offset = 0;
  const crcTable = [];
  // CRC
  let crc = 0xffffffff;
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = globalThis.__crc[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  globalThis.__crc = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let cc = n;
      for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
      t[n] = cc >>> 0;
    }
    return t;
  })();
  for (const [name, data] of Object.entries(obj)) {
    const nb = enc(name);
    const db = data instanceof Uint8Array ? data : enc(data);
    const cc = crc32(db);
    const local = new DataView(new ArrayBuffer(30 + nb.length + db.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true); local.setUint16(12, 0, true);
    local.setUint32(14, cc, true);
    local.setUint32(18, db.length, true);
    local.setUint32(22, db.length, true);
    local.setUint16(26, nb.length, true);
    local.setUint16(28, 0, true);
    new Uint8Array(local.buffer).set(nb, 30);
    new Uint8Array(local.buffer).set(db, 30 + nb.length);
    chunks.push(new Uint8Array(local.buffer));
    const cd = new DataView(new ArrayBuffer(46 + nb.length));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
    cd.setUint32(16, cc, true);
    cd.setUint32(20, db.length, true); cd.setUint32(24, db.length, true);
    cd.setUint16(28, nb.length, true); cd.setUint16(30, 0); cd.setUint16(32, 0);
    cd.setUint16(34, 0); cd.setUint16(36, 0); cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    new Uint8Array(cd.buffer).set(nb, 46);
    central.push(new Uint8Array(cd.buffer));
    offset += local.buffer.byteLength;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(obj).length, true);
  eocd.setUint16(10, Object.keys(obj).length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = concat([...chunks, ...central, new Uint8Array(eocd.buffer)]);
  return all.buffer;
}
function concat(arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
}
function build(obj) {
  return buildProject(unzip(zipFrom(obj)));
}
const goodFrame = (i) => JSON.stringify({
  u: [5, -5, 0, 0][i], v: [0, 0, 5, -5][i], gain: 4, offset: 0, weight: 1,
});
const goodCase = JSON.stringify({
  width: 2, height: 2,
  frames: [0, 1, 2, 3].map((i) => JSON.parse(goodFrame(i))),
});
const pgm = (w, h, max, bytes) => {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n${max}\n`);
  return concat([head, bytes]);
};
const grayBytes = (vals) => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => { b[i * 2] = v >> 8; b[i * 2 + 1] = v & 255; });
  return b;
};
function goodZip(over) {
  const o = {
    'case.json': goodCase,
    'frames/00.pgm': pgm(2, 2, 65535, grayBytes([100, 200, 300, 400])),
    'frames/01.pgm': pgm(2, 2, 65535, grayBytes([100, 200, 300, 400])),
    'frames/02.pgm': pgm(2, 2, 65535, grayBytes([100, 200, 300, 400])),
    'frames/03.pgm': pgm(2, 2, 65535, grayBytes([100, 200, 300, 400])),
  };
  return Object.assign(o, over || {});
}

test('缺少 case.json', () => {
  const z = goodZip(); delete z['case.json'];
  expectThrow(() => build(z), ['case.json']);
});
test('width 超出 256', () => {
  const c = JSON.parse(goodCase); c.width = 257;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['width']);
});
test('height 非整数', () => {
  const c = JSON.parse(goodCase); c.height = 3.5;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['height']);
});
test('frames 数量不足 4', () => {
  const c = JSON.parse(goodCase); c.frames = c.frames.slice(0, 3);
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['frames']);
});
test('u²+v²≠25 指出具体帧', () => {
  const c = JSON.parse(goodCase); c.frames[2].u = 3; c.frames[2].v = 3;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['frames[2]']);
});
test('重复 (u,v) 方向', () => {
  const c = JSON.parse(goodCase); c.frames[3].u = 5; c.frames[3].v = 0;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['frames[3]', '重复']);
});
test('gain 越界指出字段', () => {
  const c = JSON.parse(goodCase); c.frames[0].gain = 20;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['gain']);
});
test('缺少 weight 字段', () => {
  const c = JSON.parse(goodCase); delete c.frames[1].weight;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['frames[1]', 'weight']);
});
test('mask 非布尔', () => {
  const c = JSON.parse(goodCase); c.frames[0].mask = 'yes';
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['mask']);
});
test('mask=true 但缺少 masks 文件', () => {
  const c = JSON.parse(goodCase); c.frames[0].mask = true;
  expectThrow(() => build(goodZip({ 'case.json': JSON.stringify(c) })), ['masks/00.pgm']);
});
test('缺少帧图像文件', () => {
  const z = goodZip(); delete z['frames/02.pgm'];
  expectThrow(() => build(z), ['frames/02.pgm']);
});
test('PGM 尺寸不符指出文件', () => {
  expectThrow(() => build(goodZip({ 'frames/00.pgm': pgm(3, 2, 65535, grayBytes(new Array(6).fill(10))) })),
    ['frames/00.pgm']);
});
test('PGM 魔数错误', () => {
  const bad = new TextEncoder().encode('P6\n2 2\n65535\n');
  expectThrow(() => parseGrayPgm(concat([bad, grayBytes([1, 2, 3, 4])]), 'frames/00.pgm', 2, 2),
    ['P5']);
});
test('PGM 数据长度错误', () => {
  expectThrow(() => parseGrayPgm(pgm(2, 2, 65535, grayBytes([1, 2, 3])), 'frames/00.pgm', 2, 2),
    ['frames/00.pgm', '长度']);
});
test('掩膜出现非 0/255 字节', () => {
  const mb = new Uint8Array([255, 128, 0, 255]);
  expectThrow(() => parseMaskPgm(pgm(2, 2, 255, mb), 'masks/01.pgm', 2, 2), ['masks/01.pgm']);
});
test('未声明 mask 却存在 masks 文件', () => {
  expectThrow(() => build(goodZip({ 'masks/01.pgm': pgm(2, 2, 255, new Uint8Array([255, 255, 255, 255])) })),
    ['masks/01.pgm']);
});
test('非法 JSON 指出 case.json', () => {
  expectThrow(() => build(goodZip({ 'case.json': '{not json' })), ['case.json']);
});
test('ZIP 路径穿越被拒绝', () => {
  expectThrow(() => unzip(zipFrom({ '../evil.pgm': new Uint8Array([1]) })), ['非法']);
});
test('正常用例可成功构建', () => {
  const p = build(goodZip());
  assert.strictEqual(p.width, 2);
  assert.strictEqual(p.frames.length, 4);
  assert.strictEqual(p.frames[0].image[3], 400);
});

console.log('\n' + passed + ' validation tests passed');
