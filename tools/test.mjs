/**
 * 数值与报错偏移交叉验证：JS 核心 vs Python 独立参考生成的 oracle.json。
 * 运行：node tools/test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../js/evl-core.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, 'generated');
const oracle = JSON.parse(readFileSync(join(GEN, 'oracle.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`FAIL  ${name} — ${detail}`); }
}

function relErr(a, b) {
  const d = Math.abs(a - b);
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? d : d / m;
}

let worstLumRel = 0, worstCovAbs = 0;

for (const tc of oracle.valid) {
  const bytes = readFileSync(join(GEN, tc.file));
  let data;
  try {
    data = C.parseEVL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (e) {
    ok(false, `parse ${tc.file}`, `意外抛错 ${e.name}@${e.offset}: ${e.message}`);
    continue;
  }
  ok(data.width === tc.w && data.height === tc.h, `header ${tc.file}`);
  const res = C.computeAll(data, tc.windows);
  const P = tc.w * tc.h;
  for (let wi = 0; wi < tc.windows.length; wi++) {
    for (let p = 0; p < P; p++) {
      const expLum = tc.expected[wi][p][0];
      const expCov = tc.expected[wi][p][1];
      const gotLum = res.lum[wi * P + p];
      const gotCov = res.cov[wi * P + p];
      const rl = relErr(gotLum, expLum);
      const ac = Math.abs(gotCov - expCov);
      if (rl > worstLumRel) worstLumRel = rl;
      if (ac > worstCovAbs) worstCovAbs = ac;
      // 评分容差是 1e-5；自测收紧到 2e-7
      if (!(rl <= 2e-7 || Math.abs(gotLum - expLum) <= 1e-12)) {
        ok(false, `lum ${tc.file} w${wi} p${p}`,
          `got=${gotLum.toPrecision(12)} exp=${expLum.toPrecision(12)} rel=${rl}`);
      }
      if (!(ac <= 1e-10)) {
        ok(false, `cov ${tc.file} w${wi} p${p}`, `got=${gotCov} exp=${expCov} abs=${ac}`);
      }
    }
  }
  ok(true, `calc ${tc.file} (${tc.windows.length} windows x ${P}px)`);

  // LUM1 回读：交错 f32，零必须精确为零
  const buf = C.encodeLUM1(res, 0);
  const dv = new DataView(buf);
  ok(dv.getUint8(0) === 0x4c && dv.getUint8(3) === 0x31, `lum1 magic ${tc.file}`);
  ok(dv.getUint16(4, true) === tc.w && dv.getUint16(6, true) === tc.h, `lum1 dims ${tc.file}`);
  ok(buf.byteLength === 8 + 8 * P, `lum1 size ${tc.file}`);
  for (let p = 0; p < P; p++) {
    const fL = dv.getFloat32(8 + p * 8, true);
    const fC = dv.getFloat32(8 + p * 8 + 4, true);
    const lum = res.lum[p];
    const cov = res.cov[p];
    if (lum === 0) ok(Object.is(fL, 0) && 1 / fL > 0, `zero lum +0 ${tc.file} p${p}`);
    if (cov === 0) ok(Object.is(fC, 0) && 1 / fC > 0, `zero cov +0 ${tc.file} p${p}`);
    if (lum !== 0) {
      const r = Math.abs(fL - lum) / Math.max(Math.abs(lum), 1e-30);
      if (!(r <= 1e-6)) ok(false, `f32 lum ${tc.file} p${p}`, `rel=${r} ${fL} vs ${lum}`);
    }
  }
}

// 畸形文件偏移
for (const mc of oracle.malformed) {
  const u8 = Uint8Array.from(Buffer.from(mc.b64, 'base64'));
  let threw = null;
  try {
    C.parseEVL(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  } catch (e) { threw = e; }
  if (mc.offset === null || mc.offset === undefined) {
    ok(threw === null, `malformed-ok ${mc.name}`, threw ? `不应报错却报 ${threw.offset}` : '');
  } else {
    ok(threw instanceof C.EVLFormatError, `malformed-type ${mc.name}`, `got ${threw}`);
    ok(threw && threw.offset === mc.offset, `malformed-offset ${mc.name}`,
      `期望 ${mc.offset} 实得 ${threw && threw.offset} (${threw && threw.field})`);
  }
}

// 锚值修改 -> 仅该像素变化；撤销（恢复码）后逐位复现
{
  const bytes = readFileSync(join(GEN, 'sample.evl'));
  const data = C.parseEVL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const wins = [[0, 36000], [1000, 15000]];
  const before = C.computeAll(data, wins);
  const p = 5;
  const A = data.anchorCount;
  const old = data.codes[p * A + 1];
  data.codes[p * A + 1] = C.LIMITS.missing;
  const edited = C.computeAll(data, wins);
  let changed = false;
  for (let w = 0; w < wins.length; w++) {
    for (let q = 0; q < data.pixels; q++) {
      const i = w * data.pixels + q;
      if (q === p) { if (before.lum[i] !== edited.lum[i] || before.cov[i] !== edited.cov[i]) changed = true; }
      else if (before.lum[i] !== edited.lum[i] || before.cov[i] !== edited.cov[i]) {
        ok(false, 'edit isolation', `w${w} p${q} 被连带修改`);
      }
    }
  }
  ok(changed, 'edit changes target pixel');
  data.codes[p * A + 1] = old;
  const undone = C.computeAll(data, wins);
  let identical = true;
  for (let i = 0; i < before.lum.length; i++) {
    if (before.lum[i] !== undone.lum[i] || before.cov[i] !== undone.cov[i]) identical = false;
  }
  ok(identical, 'undo restores bit-identical results');
}

console.log(`\n最坏亮度相对误差 ${worstLumRel.toExponential(3)}，最坏覆盖率绝对误差 ${worstCovAbs.toExponential(3)}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.slice(0, 20).join('\n')); process.exit(1); }
