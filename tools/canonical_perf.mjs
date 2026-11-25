/**
 * AP7 标准满额文件：512x384, A=12 (t=1600j), E=4e6,
 * event_i: t=1+floor(i/256), idx=i mod P, 极性正负交替。
 * 24 窗 [600j,600j+3000)。计时并导出角/中心像素供 Python 核对。
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../js/evl-core.js');

const W = 512, H = 384, P = W * H, A = 12, E = 4_000_000;
const buf = new ArrayBuffer(16 + A * (4 + 2 * P) + 8 * E);
const dv = new DataView(buf), u8 = new Uint8Array(buf);
u8.set([0x45, 0x56, 0x4c, 0x31], 0);
dv.setUint16(4, W, true); dv.setUint16(6, H, true);
dv.setUint32(8, A, true); dv.setUint32(12, E, true);
let pos = 16;
for (let a = 0; a < A; a++) {
  dv.setUint32(pos, 1600 * a, true); pos += 4;
  for (let p = 0; p < P; p++) {
    // 确定性码型：平滑斜坡 + 少量边界值（全部合法，无缺测）
    let code = ((p * 7 + a * 511) % 8193) - 6144; // -6144..2048
    if ((p + a * 97) % 1009 === 0) code = -6144;
    if ((p + a * 31) % 2003 === 0) code = 2048;
    dv.setInt16(pos, code, true); pos += 2;
  }
}
for (let i = 0; i < E; i++) {
  const t = 1 + Math.floor(i / 256);
  const idx = i % P;
  const polBit = (i % 2 === 0) ? 0x80000000 : 0;
  dv.setUint32(pos, t, true);
  dv.setUint32(pos + 4, polBit | idx, true);
  pos += 8;
}
writeFileSync('tools/generated/canonical.evl', Buffer.from(buf));

const wins = [];
for (let j = 0; j < 24; j++) wins.push([600 * j, 600 * j + 3000]);

let t0 = performance.now();
const data = C.parseEVL(buf);
const tParse = performance.now() - t0;
t0 = performance.now();
const res = C.computeAll(data, wins);
const tCalc = performance.now() - t0;
console.log(`canonical parse ${tParse.toFixed(0)}ms calc24 ${tCalc.toFixed(0)}ms total ${(tParse + tCalc).toFixed(0)}ms`);

const ps = [0, P - 1, 191 * W + 255, 192 * W + 256];
const dump = { wins, ps, rows: {} };
for (const p of ps) dump.rows[p] = wins.map((_, w) => [res.lum[w * P + p], res.cov[w * P + p]]);
writeFileSync('/tmp/canonical_js.json', JSON.stringify(dump));
console.log('dumped', ps);
