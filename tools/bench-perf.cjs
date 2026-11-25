/* 满额性能基准：64MiB 转储、64 对、500 万次标量写入。
 * node tools/bench-perf.cjs
 * 可选环境 WRITES 调整矩阵总数用于快速试跑。
 */
const L = require('../web/js/layout.js');
const E = require('../web/js/engine.js');

const TOTAL_MATS = parseInt(process.env.MATS || '625000', 10);
const SEG = 32;
const DUMP_LEN = 64 * 1024 * 1024;
const DST_START = 20_000_000;

// 前31段 19531，第32段 19539（合计 625000）
const counts = [];
let acc = 0;
for (let i = 0; i < SEG; i++) {
  const c = i < 31 ? 19531 : TOTAL_MATS - 31 * 19531;
  counts.push(c);
  acc += c;
}
if (acc !== TOTAL_MATS) { /* 缩放模式下重新均分 */
  counts.length = 0;
  const base = Math.floor(TOTAL_MATS / SEG);
  let rem = TOTAL_MATS - base * SEG;
  for (let i = 0; i < SEG; i++) { const c = base + (rem-- > 0 ? 1 : 0); counts.push(c); }
}

const views = [];
const pairs = [];
let srcOff = 0;
let dstOff = DST_START;
for (let i = 0; i < SEG; i++) {
  const n = counts[i];
  const srcLen = n * 16; // std430 row mat2 = 16
  const dstLen = n * 32; // std140 col mat2 = 32
  views.push({
    name: `s${i}`, offset: srcOff, length: srcLen, layout: 'std430', major: 'row', endian: 'little',
    members: [{ name: 'a', type: { array: null, of: { mat: [2, 2] } } }],
  });
  views.push({
    name: `d${i}`, offset: dstOff, length: dstLen, layout: 'std140', major: 'column', endian: 'big',
    members: [{ name: 'a', type: { array: null, of: { mat: [2, 2] } } }],
  });
  pairs.push([`s${i}`, `d${i}`]);
  pairs.push([`d${i}`, `s${i}`]);
  srcOff += srcLen;
  dstOff += dstLen;
}
console.log('views', views.length, 'pairs', pairs.length, 'mats', TOTAL_MATS);
console.log('src end', srcOff, 'dst end', dstOff);

const dump = new Uint8Array(DUMP_LEN);
dump.fill(0xCC); // 组外/填充哨兵
// 给两组分量写可辨识位型（这里只压测，不做独立参考）
const dv = new DataView(dump.buffer);
for (let m = 0; m < TOTAL_MATS; m++) {
  // src group: contiguous 16-byte mats, logical offsets row-major
  const so = m * 16;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    dv.setUint32(so + r * 8 + c * 4, (0x10000000 | (m * 4 + r * 2 + c)) >>> 0, true);
  }
  // dst group: 32-byte mats column-major big endian at DST_START
  const doff = DST_START + m * 32;
  for (let col = 0; col < 2; col++) for (let row = 0; row < 2; row++) {
    dv.setUint32(doff + col * 16 + row * 4, (0x20000000 | (m * 4 + col * 2 + row)) >>> 0, false);
  }
}

const store = E.createStore();
const t0 = performance.now();
E.importProject(store, { views }, dump);
const t1 = performance.now();
const result = E.runBatch(store, pairs);
const t2 = performance.now();
// 模拟“刷新可查结果”：若干次绝对偏移反查 + 路径解析
for (let i = 0; i < 200; i++) {
  const abs = (i * 123457) % DUMP_LEN;
  L.queryAbsolute(store.views, abs);
}
for (let i = 0; i < 200; i++) {
  L.resolvePath(store.views[i % store.views.length], `a[${i % 100}].m[${i & 1}][${(i >> 1) & 1}]`);
}
const t3 = performance.now();

console.log('writes', result.writes);
console.log('compile+bind ms', (t1 - t0).toFixed(1));
console.log('batch ms (plan+conflict+apply+history)', (t2 - t1).toFixed(1));
console.log('batch + refresh queries ms', (t3 - t1).toFixed(1));
console.log('TOTAL submit->queryable ms', (t3 - t1).toFixed(1));
if (process.env.CHECK_6S && t3 - t1 > 6000) { console.error('PERF FAIL >6s'); process.exit(1); }
