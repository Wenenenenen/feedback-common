/**
 * 对照 pipeline 中 qa_task#239 acceptance_points 的逐条确定性验收。
 * 运行：node tools/acceptance.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../js/evl-core.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} — ${detail}`); }
}
function rel(a, b) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30); }

/** 构造 EVL1：codes 为锚优先 codes[a][p]；events [[t,p,pol],...] */
function buildEVL({ w = 1, h = 1, times, codes, events = [] }) {
  const A = times.length, P = w * h, E = events.length;
  const buf = new ArrayBuffer(16 + A * (4 + 2 * P) + 8 * E);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  u8.set([0x45, 0x56, 0x4c, 0x31], 0);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  dv.setUint32(8, A, true); dv.setUint32(12, E, true);
  let pos = 16;
  for (let a = 0; a < A; a++) {
    dv.setUint32(pos, times[a], true); pos += 4;
    for (let p = 0; p < P; p++) { dv.setInt16(pos, codes[a][p], true); pos += 2; }
  }
  for (const [t, p, pol] of events) {
    dv.setUint32(pos, t >>> 0, true);
    const word = (p & 0x7fffffff) | (pol > 0 ? 0x80000000 : 0);
    dv.setUint32(pos + 4, word >>> 0, true);
    pos += 8;
  }
  return buf;
}
function oneWindow(buf, win, p = 0) {
  const d = C.parseEVL(buf);
  const r = C.computeAll(d, [win]);
  return { lum: r.lum[p], cov: r.cov[p], d };
}

// AP2：0/8000 两锚码0；4000 两正一负；两锚时标各写正事件
{
  const buf = buildEVL({
    times: [0, 8000], codes: [[0], [0]],
    events: [[0, 0, 1], [4000, 0, 1], [4000, 0, 1], [4000, 0, -1], [8000, 0, 1]],
  });
  const d = C.parseEVL(buf);
  const runs = C.buildPixelRuns(d, 0);
  check('AP2 one run', runs.length === 1);
  check('AP2 knots only 0,4000 (anchor-time events ignored)',
    runs[0].T.length === 2 && runs[0].T[0] === 0 && runs[0].T[1] === 4000,
    JSON.stringify(runs[0].T));
  check('AP2 jump post-value = 1/16', Math.abs(runs[0].Z[1] - 1 / 16) < 1e-12, `Z1=${runs[0].Z[1]}`);
  const r = C.computeAll(d, [[0, 8000]]);
  const expected = 8 * (Math.pow(2, 1 / 16) - Math.pow(2, -1 / 16)) / Math.LN2;
  check('AP2 whole-window mean literal formula', rel(r.lum[0], expected) < 1e-12,
    `got ${r.lum[0]} exp ${expected} rel ${rel(r.lum[0], expected)}`);
}

// AP3：码2016，1000 两正；窗[3000,5000) 夹断 + 解析积分
{
  const buf = buildEVL({
    times: [0, 8000], codes: [[2016], [2016]],
    events: [[1000, 0, 1], [1000, 0, 1]],
  });
  const { lum } = oneWindow(buf, [3000, 5000]);
  const expected = (256000 + 256 * 32000 * (1 - Math.pow(2, -1 / 32)) / Math.LN2) / 2000;
  check('AP3 clamp+analytic window mean literal formula', rel(lum, expected) < 1e-11,
    `got ${lum.toPrecision(12)} exp ${expected.toPrecision(12)} rel ${rel(lum, expected)}`);
}

// AP4：五锚 [0,10,20,30,40]，A 码 0,0,缺,256,256；B 全缺；窗[0,50)
{
  const M = C.LIMITS.missing;
  const buf = buildEVL({
    w: 1, h: 2,
    times: [0, 10, 20, 30, 40],
    codes: [
      [0, M], [0, M], [M, M], [256, M], [256, M],
    ],
  });
  const d = C.parseEVL(buf);
  const r = C.computeAll(d, [[0, 50]]);
  check('AP4 A luminance 1.5', r.lum[0] === 1.5, `got ${r.lum[0]}`);
  check('AP4 A coverage 0.4', r.cov[0] === 0.4, `got ${r.cov[0]}`);
  check('AP4 B luminance exact +0', r.lum[1] === 0 && 1 / r.lum[1] > 0);
  check('AP4 B coverage exact +0', r.cov[1] === 0 && 1 / r.cov[1] > 0);
}

// AP5：三锚码0 t0,10,20；末锚改缺；窗[9,11) -> 只覆盖[9,10) lum1 cov0.5；撤销后 cov1
{
  const M = C.LIMITS.missing;
  const buf = buildEVL({ times: [0, 10, 20], codes: [[0], [0], [0]] });
  const d = C.parseEVL(buf);
  d.codes[2] = M; // 像素0 * A + a
  let r = C.computeAll(d, [[9, 11]]);
  check('AP5 edited lum=1', r.lum[0] === 1, `got ${r.lum[0]}`);
  check('AP5 edited coverage=0.5', r.cov[0] === 0.5, `got ${r.cov[0]}`);
  d.codes[2] = 0; // 撤销
  r = C.computeAll(d, [[9, 11]]);
  check('AP5 undo coverage=1', r.cov[0] === 1, `got ${r.cov[0]}`);
  check('AP5 undo luminance=1', r.lum[0] === 1, `got ${r.lum[0]}`);
  const lum1 = C.encodeLUM1(r, 0);
  const dv = new DataView(lum1);
  check('AP5 export f32 lum=1 cov=1',
    dv.getFloat32(8, true) === 1 && dv.getFloat32(12, true) === 1);
}

// AP6：u32 末端时标；-6144 恒定 -> 2^-24 cov1；另一像素全缺精确零
{
  const M = C.LIMITS.missing;
  const buf = buildEVL({
    w: 1, h: 2,
    times: [4294967280, 4294967295],
    codes: [[-6144, M], [-6144, M]],
  });
  const d = C.parseEVL(buf);
  const r = C.computeAll(d, [[4294967280, 4294967295]]);
  check('AP6 low pixel lum=2^-24', r.lum[0] === Math.pow(2, -24), `got ${r.lum[0]}`);
  check('AP6 low pixel cov=1', r.cov[0] === 1);
  check('AP6 missing pixel exact zeros', r.lum[1] === 0 && r.cov[1] === 0);
  const lum1 = C.encodeLUM1(r, 0);
  const dv = new DataView(lum1);
  check('AP6 f32 2^-24 exact bit pattern', dv.getFloat32(8, true) === Math.pow(2, -24));
  check('AP6 f32 cov 1', dv.getFloat32(12, true) === 1);
  check('AP6 f32 missing lum +0 bits', dv.getUint32(16, true) === 0 && dv.getUint32(20, true) === 0);
}

// AP8：1x1 两锚一事件，位字截断 1 字节 -> 偏移32；越界像素位字 -> 32
{
  const full = buildEVL({ times: [0, 10], codes: [[0], [0]], events: [[5, 0, 1]] });
  const trunc = full.slice(0, full.byteLength - 1); // 36 -> 35，位字少最后一字节
  let off = null;
  try { C.parseEVL(trunc); } catch (e) { off = e.offset; }
  check('AP8 truncated word offset 32', off === 32, `off=${off}`);

  const dv = new DataView(full);
  dv.setUint32(32, 5, true); // idx=5 >= P=1（极性位为0）
  off = null;
  try { C.parseEVL(full); } catch (e) { off = e.offset; }
  check('AP8 out-of-range pixel word offset 32', off === 32, `off=${off}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
