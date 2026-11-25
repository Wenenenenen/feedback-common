/* 生成 AP8 满额用例到 .cache/perf-layout.json + perf-dump.bin */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '.cache');
fs.mkdirSync(OUT, { recursive: true });

const SEG = 32;
const TOTAL = 625000;
const DUMP_LEN = 64 * 1024 * 1024;
const DST_START = 20_000_000;

const counts = [];
for (let i = 0; i < 31; i++) counts.push(19531);
counts.push(19539);
if (counts.reduce((a, b) => a + b, 0) !== TOTAL) throw new Error('count sum');

const views = [];
const pairs = [];
let srcOff = 0, dstOff = DST_START;
for (let i = 0; i < SEG; i++) {
  const n = counts[i];
  const srcLen = n * 16, dstLen = n * 32;
  views.push({ name: `s${i}`, offset: srcOff, length: srcLen, layout: 'std430', major: 'row', endian: 'little',
    members: [{ name: 'a', type: { array: null, of: { mat: [2, 2] } } }] });
  views.push({ name: `d${i}`, offset: dstOff, length: dstLen, layout: 'std140', major: 'column', endian: 'big',
    members: [{ name: 'a', type: { array: null, of: { mat: [2, 2] } } }] });
  pairs.push([`s${i}`, `d${i}`]);
  pairs.push([`d${i}`, `s${i}`]);
  srcOff += srcLen; dstOff += dstLen;
}

const dump = Buffer.alloc(DUMP_LEN, 0xcc);
// 源组：LE 行主，逻辑索引编码
for (let m = 0; m < TOTAL; m++) {
  const so = m * 16;
  let k = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    dump.writeUInt32LE((0x10000000 | (m * 4 + k)) >>> 0, so + r * 8 + c * 4);
    k++;
  }
  const doff = DST_START + m * 32;
  k = 0;
  for (let col = 0; col < 2; col++) for (let row = 0; row < 2; row++) {
    dump.writeUInt32BE((0x20000000 | (m * 4 + k)) >>> 0, doff + col * 16 + row * 4);
    k++;
  }
}

fs.writeFileSync(path.join(OUT, 'perf-layout.json'), JSON.stringify({ views }));
fs.writeFileSync(path.join(OUT, 'perf-dump.bin'), dump);
fs.writeFileSync(path.join(OUT, 'perf-pairs.json'), JSON.stringify(pairs));
console.log('written', views.length, 'views', pairs.length, 'pairs; srcEnd', srcOff, 'dstEnd', dstOff);

/* 独立参考：从批前快照按格式约定计算期望整份导出 */
function referenceExpected(snapshot) {
  const expected = Buffer.from(snapshot);
  const rd32 = (off, le) => le ? snapshot.readUInt32LE(off) : snapshot.readUInt32BE(off);
  const wr32 = (off, le, w) => le ? expected.writeUInt32LE(w >>> 0, off) : expected.writeUInt32BE(w >>> 0, off);
  let writes = 0;
  // 全局连续矩阵编号（分段连续）
  for (let dir = 0; dir < 2; dir++) {
    // dir0 s->d ; dir1 d->s，均从 snapshot 读
    for (let m = 0; m < TOTAL; m++) {
      for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
        const sOff = m * 16 + r * 8 + c * 4;             // std430 row
        const dOff = DST_START + m * 32 + c * 16 + r * 4; // std140 column，逻辑[r][c]
        if (dir === 0) wr32(dOff, false, rd32(sOff, true));
        else wr32(sOff, true, rd32(dOff, false));
        writes++;
      }
    }
  }
  if (writes !== 5000000) throw new Error('ref writes ' + writes);
  return expected;
}

module.exports = { referenceExpected, DUMP_LEN, DST_START, TOTAL };

if (require.main === module) {
  const t0 = Date.now();
  const expected = referenceExpected(dump);
  fs.writeFileSync(path.join(OUT, 'perf-expected.bin'), expected);
  console.log('reference expected built in', Date.now() - t0, 'ms');
}
