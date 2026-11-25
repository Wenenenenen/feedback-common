/**
 * 满额性能与体积验证：生成 512x384 / 12 锚 / 400 万事件文件，
 * 计时 parseEVL + computeAll(24 窗)，并落盘 full.evl 供浏览器冒烟。
 * 运行：node tools/perf.mjs [concentrated]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../js/evl-core.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, 'generated');
mkdirSync(GEN, { recursive: true });

const W = 512, H = 384, A = 12, E = 4_000_000;
const P = W * H;
const T = 2_000_000;

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFull({ concentrated = false, missingRate = 0.02, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const anchorDt = Math.floor(T / (A - 1));
  const total = 16 + A * (4 + 2 * P) + 8 * E;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x45, 0x56, 0x4c, 0x31], 0);
  dv.setUint16(4, W, true);
  dv.setUint16(6, H, true);
  dv.setUint32(8, A, true);
  dv.setUint32(12, E, true);
  let pos = 16;
  const anchorTimes = [];
  for (let a = 0; a < A; a++) {
    const t = a === A - 1 ? T : a * anchorDt;
    anchorTimes.push(t);
    dv.setUint32(pos, t, true); pos += 4;
    for (let p = 0; p < P; p++) {
      let code;
      if (rand() < missingRate) code = -32768;
      else code = -6144 + Math.floor(rand() * (2048 + 6144 + 1));
      dv.setInt16(pos, code, true); pos += 2;
    }
  }
  for (let i = 0; i < E; i++) {
    // 非降时标，均匀铺开，带少量同刻聚集
    let t = Math.floor((i / E) * T);
    if (i % 97 === 0) t = Math.floor((Math.floor(i / 97) * 97 / E) * T);
    t = Math.max(anchorTimes[0], Math.min(T, t));
    let idx;
    if (concentrated) idx = (i % 3 === 0) ? 12345 : 22222; // 聚集到两个像素
    else idx = Math.floor(rand() * P);
    const pol = rand() < 0.5 ? 0 : 0x80000000;
    dv.setUint32(pos, t, true);
    dv.setUint32(pos + 4, pol | (idx & 0x7fffffff), true);
    pos += 8;
  }
  if (pos !== total) throw new Error('size mismatch');
  return buf;
}

function makeWindows() {
  const wins = [];
  for (let i = 0; i < 24; i++) {
    const s = Math.floor((i / 24) * T * 0.9);
    let e = s + Math.floor(T * (0.05 + (i % 5) * 0.03));
    if (i % 7 === 0) { // 越界窗
      e = T + 50000 + i;
    }
    wins.push([s, Math.min(e, 4294967295)]);
  }
  return C.validateWindows(wins);
}

const mode = process.argv[2] || 'uniform';
const concentrated = mode === 'concentrated';
console.log(`building full EVL (${mode}) ...`);
let t0 = performance.now();
const buf = buildFull({ concentrated });
writeFileSync(join(GEN, concentrated ? 'full-concentrated.evl' : 'full.evl'), Buffer.from(buf));
console.log(`built ${(buf.byteLength / 1048576).toFixed(1)} MiB in ${(performance.now() - t0).toFixed(0)} ms`);

t0 = performance.now();
const data = C.parseEVL(buf);
const tParse = performance.now() - t0;
console.log(`parse+group: ${tParse.toFixed(0)} ms (E=${data.eventCount})`);

const wins = makeWindows();
t0 = performance.now();
const res = C.computeAll(data, wins);
const tCalc = performance.now() - t0;
console.log(`compute 24 windows: ${tCalc.toFixed(0)} ms`);
console.log(`TOTAL parse+compute: ${(tParse + tCalc).toFixed(0)} ms  (limit 12000 ms)`);

// 基本健全性：结果有限，零/非零统计
let zeros = 0, bad = 0;
for (let i = 0; i < res.lum.length; i++) {
  if (res.lum[i] === 0) zeros++;
  if (!Number.isFinite(res.lum[i]) || !Number.isFinite(res.cov[i])) bad++;
  if (res.cov[i] < 0 || res.cov[i] > 1 + 1e-12) bad++;
}
console.log(`entries=${res.lum.length}, zeroLum=${zeros}, bad=${bad}`);
if (tParse + tCalc > 12000) { console.log('PERF FAIL'); process.exit(1); }
if (bad) { console.log('SANITY FAIL'); process.exit(1); }
console.log('PERF OK');
