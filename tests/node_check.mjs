/*
 * Node 单元测试：与 Python 参考逐点核对（samples/matrix-room.zip）。
 *
 * 运行：node tests/node_check.mjs [samples/extracted 目录]
 * 参考值来自 cases.json：sparse 为逐点核对（含四条不同长度 IR 的矩阵卷积、
 * 预延迟、湿声比例与固定长度），clip 为峰值/超限样本核对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, encodeWav24 } from '../src/web/js/wav.js';
import { MatrixConvolver, convolveMatrix, predictLength } from '../src/web/js/dsp/convolver.js';
import { renderRange } from '../src/web/js/dsp/render-range.js';
import { validateFiles, fixedLength, tailLength } from '../src/web/js/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleRoot = process.argv[2] || path.join(here, '..', 'samples', 'extracted');

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function readWav(rel) {
  const buf = fs.readFileSync(path.join(sampleRoot, rel));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parseWav(ab);
}

function loadCase(id) {
  const files = { dry: null, LL: null, LR: null, RL: null, RR: null };
  for (const key of ['dry', 'LL', 'LR', 'RL', 'RR']) {
    const rel = `${id}/${key}.wav`;
    if (!fs.existsSync(path.join(sampleRoot, rel))) continue;
    files[key] = { name: `${key}.wav`, parsed: readWav(rel) };
  }
  return files;
}

function nonZero(arr, eps = 1e-12) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]) > eps) out.push([i, arr[i]]);
  return out;
}

function compareNonZero(name, actual, expected, eps = 1e-9) {
  const a = new Map(nonZero(actual, eps * 0.5).map(([i, v]) => [i, v]));
  const e = new Map(nonZero(expected, eps * 0.5).map(([i, v]) => [i, v]));
  const missing = [...e.keys()].filter((i) => !a.has(i));
  const extra = [...a.keys()].filter((i) => !e.has(i));
  const bad = [...e.keys()]
    .filter((i) => a.has(i) && !approx(a.get(i), e.get(i), eps))
    .map((i) => [i, a.get(i), e.get(i)]);
  check(
    name,
    missing.length === 0 && extra.length === 0 && bad.length === 0,
    JSON.stringify({ missing: missing.slice(0, 3), extra: extra.slice(0, 3), bad: bad.slice(0, 3) }),
  );
}

/* ── 参考实现（纯 JS，朴素卷积，用于独立核对） ───────── */
function naiveConvolve(x, h) {
  const y = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    if (x[i] === 0) continue;
    for (let j = 0; j < h.length; j++) y[i + j] += x[i] * h[j];
  }
  return y;
}

function naiveMatrix({ dryL, dryR, irs, predelayFrames, wetRatio }) {
  const addInto = (a, b) => {
    const n = Math.max(a.length, b.length);
    const out = new Float64Array(n);
    out.set(a);
    for (let i = 0; i < b.length; i++) out[i] += b[i];
    return out;
  };
  const wetL = addInto(naiveConvolve(dryL, irs[0]), naiveConvolve(dryR, irs[1]));
  const wetR = addInto(naiveConvolve(dryL, irs[2]), naiveConvolve(dryR, irs[3]));
  const maxIr = irs.reduce((m, h) => Math.max(m, h.length), 0);
  const total = predictLength({ dryFrames: Math.max(dryL.length, dryR.length), maxIrFrames: maxIr, predelayFrames });
  const L = new Float64Array(total);
  const R = new Float64Array(total);
  for (let t = 0; t < total; t++) {
    L[t] = (1 - wetRatio) * (t < dryL.length ? dryL[t] : 0);
    R[t] = (1 - wetRatio) * (t < dryR.length ? dryR[t] : 0);
  }
  for (let t = 0; t < wetL.length; t++) {
    const o = t + predelayFrames;
    if (o < total) L[o] += wetRatio * wetL[t];
  }
  for (let t = 0; t < wetR.length; t++) {
    const o = t + predelayFrames;
    if (o < total) R[o] += wetRatio * wetR[t];
  }
  return { L, R, total };
}

/* ── 0. WAV 拒绝路径 ─────────────────────────────────── */
console.log('\n[0] WAV 拒绝路径');
{
  const make = (tag, bits, { sr = 48000, ch = 1, frames = 4, truncate = 0 } = {}) => {
    const ba = (ch * bits) / 8;
    const dataLen = frames * ba;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(tag, 20);
    buf.writeUInt16LE(ch, 22);
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * ba, 28);
    buf.writeUInt16LE(ba, 32);
    buf.writeUInt16LE(bits, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    const out = truncate ? buf.subarray(0, buf.length - truncate) : buf;
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  };
  const expectError = (name, buffer, pattern) => {
    try {
      parseWav(buffer);
      check(name, false, '未拒绝');
    } catch (err) {
      check(name, pattern.test(err.message), err.message);
    }
  };
  expectError('拒绝浮点 WAV', make(3, 32), /不是整数 PCM/);
  expectError('拒绝 8-bit', make(1, 8), /不支持 8 bit/);
  expectError('拒绝 32-bit', make(1, 32), /不支持 32 bit/);
  expectError('拒绝截断文件', make(1, 16, { truncate: 10 }), /截断|缺少 data/);
  expectError('拒绝非 RIFF', new Uint8Array(20).buffer, /RIFF/);
}

/* ── 1. WAV 解析 ─────────────────────────────────────── */
console.log('\n[1] WAV 解析');
{
  const dry = readWav('sparse/dry.wav');
  check('干声为 24-bit 双声道 48k', dry.bitsPerSample === 24 && dry.channels === 2 && dry.sampleRate === 48000);
  check('干声 4099 帧', dry.frames === 4099, String(dry.frames));
  const ll = readWav('sparse/LL.wav');
  check('LL 为 16-bit 单声道', ll.bitsPerSample === 16 && ll.channels === 1);
  check('LL 1025 帧', ll.frames === 1025);
  check('24-bit 精确还原 0.5 / -0.25', approx(dry.data[0][0], 0.5) && approx(dry.data[0][1023], -0.25));
}

/* ── 2. 校验：采样率一致 / 时长 / 缺干声 ─────────────── */
console.log('\n[2] 导入校验');
{
  const v = validateFiles(loadCase('sparse'));
  check('sparse 校验通过', v.ok, JSON.stringify(v.errors));
  check('采样率 48000', v.sampleRate === 48000);
  check('最长 IR 1025', v.maxIrFrames === 1025);

  const v441 = validateFiles(loadCase('rate441'));
  check('rate441 校验通过', v441.ok, JSON.stringify(v441.errors));
  check('rate441 采样率为 44100', v441.sampleRate === 44100);

  // 故意混入 44.1k 的 LL
  const mixed = loadCase('sparse');
  mixed.LL = { name: 'LL-44k.wav', parsed: readWav('rate441/LL.wav') };
  const bad = validateFiles(mixed);
  check('采样率不一致被拒绝', !bad.ok);
  check(
    '错误信息点名文件',
    bad.errors.some((e) => e.message.includes('LL-44k.wav') && e.message.includes('44,100')),
    JSON.stringify(bad.errors),
  );

  // 缺干声：合法
  const noDry = loadCase('sparse');
  noDry.dry = null;
  const vNoDry = validateFiles(noDry);
  check('缺干声仍合法', vNoDry.ok, JSON.stringify(vNoDry.errors));
  check('缺干声时干声帧数为 0', vNoDry.dryFrames === 0);
  check(
    '缺干声时固定长度 = 最长 IR - 1',
    fixedLength({ dryFrames: 0, maxIrFrames: vNoDry.maxIrFrames, predelayFrames: 0 }) === 1024,
  );

  // IR 缺失
  const noRr = loadCase('sparse');
  noRr.RR = null;
  check('缺 RR 被拒绝', !validateFiles(noRr).ok);
}

/* ── 3. 固定长度 + 尾长 ──────────────────────────────── */
console.log('\n[3] 固定长度与尾长');
{
  const v = validateFiles(loadCase('sparse'));
  const N = fixedLength({ dryFrames: v.dryFrames, maxIrFrames: v.maxIrFrames, predelayFrames: 37 });
  check('sparse 固定长度 5160', N === 5160, String(N));
  check('尾长 1061', tailLength({ maxIrFrames: v.maxIrFrames, predelayFrames: 37 }) === 1061);
  const conv = new MatrixConvolver({
    dryL: v.dry.left,
    dryR: v.dry.right,
    irs: v.irs,
    predelayFrames: 37,
    wetRatio: 0,
  });
  check('w=0 时仍按固定长度输出', conv.totalFrames === 5160 && conv.wetFrames === 5123);
}

/* ── 4. sparse 逐点核对（FFT 路径 vs 朴素卷积） ───────── */
console.log('\n[4] sparse 逐点核对');
{
  const files = loadCase('sparse');
  const v = validateFiles(files);
  const params = { predelayFrames: 37, wetRatio: 0.65 };

  const fftOut = convolveMatrix({ dryL: v.dry.left, dryR: v.dry.right, irs: v.irs, ...params });
  const naive = naiveMatrix({
    dryL: v.dry.left,
    dryR: v.dry.right,
    irs: v.irs,
    ...params,
  });

  check('输出 5160 帧', fftOut.totalFrames === 5160, String(fftOut.totalFrames));
  let maxDiff = 0;
  for (let i = 0; i < fftOut.totalFrames; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(fftOut.left[i] - naive.L[i]), Math.abs(fftOut.right[i] - naive.R[i]));
  }
  check('FFT 结果与朴素卷积一致（<1e-12）', maxDiff < 1e-12, String(maxDiff));

  let peak = 0;
  for (const arr of [fftOut.left, fftOut.right]) for (const x of arr) peak = Math.max(peak, Math.abs(x));
  check('峰值 0.24375', approx(peak, 0.24375, 1e-9), String(peak));

  check('L[0] = 0.175（干声 0.5×0.35）', approx(fftOut.left[0], 0.175, 1e-12), String(fftOut.left[0]));
  check('L[37] = 0.1625', approx(fftOut.left[37], 0.1625, 1e-12), String(fftOut.left[37]));
  check('R[2085] = 0.24375', approx(fftOut.right[2085], 0.24375, 1e-12), String(fftOut.right[2085]));
  check('L[5159] = -0.0203125（尾段末尾）', approx(fftOut.left[5159], -0.0203125, 1e-12));
  check('干声结束后 L[5159] 仍有尾段能量', Math.abs(fftOut.left[5159]) > 0);

  // 首字母=输出、次字母=输入：仅 LR 有能量时，湿声只出现左声道
  const onlyLR = [new Float64Array(1), v.irs[1], new Float64Array(1), new Float64Array(1)];
  const routeTest = convolveMatrix({
    dryL: new Float64Array(0),
    dryR: v.dry.right,
    irs: onlyLR,
    predelayFrames: 0,
    wetRatio: 1,
  });
  let energyL = 0;
  let energyR = 0;
  for (let i = 0; i < routeTest.totalFrames; i++) {
    energyL += routeTest.left[i] * routeTest.left[i];
    energyR += routeTest.right[i] * routeTest.right[i];
  }
  check('LR 只驱动左输出', energyL > 0 && energyR === 0, `${energyL} / ${energyR}`);

  // renderRange 与整段结果一致（试听分段路径）
  const conv = new MatrixConvolver({ dryL: v.dry.left, dryR: v.dry.right, irs: v.irs, ...params });
  for (const [start, end] of [[0, 5160], [0, 100], [1000, 2000], [4000, 5160], [5159, 5160]]) {
    const seg = renderRange({
      dryL: v.dry.left,
      dryR: v.dry.right,
      irSpectra: conv.irSpectra,
      fftSize: conv.fftSize,
      block: conv.block,
      totalFrames: conv.totalFrames,
      wetRatio: params.wetRatio,
      predelayFrames: params.predelayFrames,
      start,
      end,
      fft: conv.fft,
    });
    let diff = 0;
    for (let i = 0; i < end - start; i++) {
      diff = Math.max(diff, Math.abs(seg.outL[i] - fftOut.left[start + i]), Math.abs(seg.outR[i] - fftOut.right[start + i]));
    }
    check(`renderRange [${start},${end}) 与整段一致`, diff < 1e-12, String(diff));
  }
}

/* ── 5. clip：峰值与超限 ─────────────────────────────── */
console.log('\n[5] clip 峰值与超限');
{
  const v = validateFiles(loadCase('clip'));
  const out = convolveMatrix({
    dryL: v.dry.left,
    dryR: v.dry.right,
    irs: v.irs,
    predelayFrames: 0,
    wetRatio: 1,
  });
  let peak = 0;
  let over = 0;
  for (const arr of [out.left, out.right]) {
    for (const x of arr) {
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (a > 1) over++;
    }
  }
  check('clip 输出 4099 帧', out.totalFrames === 4099, String(out.totalFrames));
  check('clip 峰值 3.375', approx(peak, 3.375, 1e-12), String(peak));
  check('clip 超限 8198 样本', over === 8198, String(over));

  const enc = encodeWav24([out.left, out.right], 48000);
  check('导出报告峰值 3.375', approx(enc.peak, 3.375, 1e-12));
  check('导出报告超限 8198', enc.overCount === 8198, String(enc.overCount));
  check('导出时限幅 8198 样本', enc.clampCount === 8198, String(enc.clampCount));
  check('处理后数组未被限幅修改', approx(out.left[1], 1.125, 1e-12) || Math.abs(out.left[1]) > 1);

  // 限幅后的样本必须是满刻度
  const view = new DataView(enc.buffer);
  let sawFullScale = false;
  for (let p = 44; p < enc.buffer.byteLength; p += 3) {
    const q = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
    if (q === 0x7fffff) sawFullScale = true;
  }
  check('限幅样本写入满刻度 0x7FFFFF', sawFullScale);
}

/* ── 6. long：长度 ───────────────────────────────────── */
console.log('\n[6] long 固定长度');
{
  const v = validateFiles(loadCase('long'));
  check('long 校验通过', v.ok, JSON.stringify(v.errors));
  const conv = new MatrixConvolver({
    dryL: v.dry.left,
    dryR: v.dry.right,
    irs: v.irs,
    predelayFrames: 0,
    wetRatio: 1,
  });
  check('long 输出 3,071,999 帧', conv.totalFrames === 3071999, String(conv.totalFrames));
}

/* ── 7. zero：零 IR ──────────────────────────────────── */
console.log('\n[7] zero 零输入');
{
  const files = loadCase('zero');
  files.dry = { name: 'silence.wav', parsed: readWav('silence.wav') };
  const v = validateFiles(files);
  const out = convolveMatrix({
    dryL: v.dry.left,
    dryR: v.dry.right,
    irs: v.irs,
    predelayFrames: 0,
    wetRatio: 1,
  });
  check('zero 输出全为 0', out.left.every((x) => x === 0) && out.right.every((x) => x === 0));
  check('zero 长度 = 干声 + 0 - 1 + 0', out.totalFrames === 4099, String(out.totalFrames));
}

/* ── 8. 24-bit 导出格式 ──────────────────────────────── */
console.log('\n[8] 24-bit WAV 导出');
{
  const n = 4;
  const l = Float64Array.from([0, 0.5, -0.5, 1 / 8388608]);
  const r = Float64Array.from([0.25, -0.25, 0.75, 0]);
  const enc = encodeWav24([l, r], 44100);
  const view = new DataView(enc.buffer);
  const ascii = (o, len) => String.fromCharCode(...new Uint8Array(enc.buffer, o, len));
  check('RIFF/WAVE 头', ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE');
  check('PCM 格式 1', view.getUint16(20, true) === 1);
  check('双声道', view.getUint16(22, true) === 2);
  check('采样率 44100', view.getUint32(24, true) === 44100);
  check('24-bit', view.getUint16(34, true) === 24);
  check('data 长度 = 帧数 × 6', view.getUint32(40, true) === n * 6);
  check('RIFF 长度 = 36 + data', view.getUint32(4, true) === 36 + n * 6);
  const q = (p) => {
    const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
    return v & 0x800000 ? v - 0x1000000 : v;
  };
  // 交错布局：帧 i 的 L 在 44+6i，R 在 47+6i
  check('L[0] = 0 → 0', q(44) === 0, String(q(44)));
  check('L[1] = 0.5 → 0x400000', q(50) === 0x400000, String(q(50)));
  check('L[2] = -0.5 → -0x400000', q(56) === -0x400000, String(q(56)));
  check('L[3] = 1 LSB → 1', q(62) === 1, String(q(62)));
  check('R[0] = 0.25 → 0x200000', q(47) === 0x200000, String(q(47)));
}

/* ── 汇总 ────────────────────────────────────────────── */
console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
