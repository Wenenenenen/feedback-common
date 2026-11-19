// node-test/run-tests.js — 用 cases/reference.json 的约定逐项校验
// 运行：node node-test/run-tests.js
import { readFileSync } from 'node:fs';
import { parseWav, encodeWav } from '../src/wav-codec.js';
import { detectTransients } from '../src/transient-detect.js';
import { timeStretch } from '../src/time-stretch.js';

const CASES = new URL('../cases/', import.meta.url);
const ref = JSON.parse(readFileSync(new URL('reference.json', CASES), 'utf8'));
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name} ${detail}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function load(fn) {
  const u8 = readFileSync(new URL(fn, CASES));
  return parseWav(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

function rms(x) { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }

// ---------- 格式校验：不支持/截断 ----------
console.log('[格式拒绝]');
for (const fn of ['pcm8-unsupported.wav', 'truncated.wav']) {
  try { load(fn); check(fn + ' 应被拒绝', false); }
  catch (e) { check(fn + ' 被拒绝: ' + e.message, true); }
}

// ---------- sine440：主频与幅度 ----------
console.log('[sine440-48k-24-stereo]');
{
  const a = load('sine440-48k-24-stereo.wav');
  check('帧数', a.frames === ref['sine440-48k-24-stereo.wav'].frames, `${a.frames}`);
  for (const speed of [0.5, 0.8, 1.25, 2.0]) {
    const { out, Nout } = await timeStretch(a.samples, speed, [], a.rate);
    check(`speed=${speed} 长度`, Nout === Math.floor(a.frames / speed + 0.5), `Nout=${Nout} 期望=${Math.floor(a.frames / speed + 0.5)}`);
    // 主频：过零率估计
    const x = out[0];
    let zc = 0;
    for (let i = 1; i < x.length; i++) if ((x[i - 1] <= 0) !== (x[i] <= 0)) zc++;
    const f0 = zc * a.rate / (2 * (x.length - 1));
    check(`speed=${speed} 主频 440±1Hz`, Math.abs(f0 - 440) <= 1, `f0=${f0.toFixed(2)}`);
    // 幅度：RMS 对比（dB），取输入输出等长的中间稳态区间（按各自长度的中间 50%）
    const inLo = Math.floor(a.frames * 0.25), inHi = Math.floor(a.frames * 0.75);
    const outLo = Math.floor(x.length * 0.25), outHi = Math.floor(x.length * 0.75);
    const r0 = rms(a.samples[0].slice(inLo, inHi));
    const r1 = rms(x.slice(outLo, outHi));
    const db = 20 * Math.log10(r1 / r0);
    check(`speed=${speed} 幅度变化 ≤0.5dB`, Math.abs(db) <= 0.5, `${db.toFixed(3)} dB`);
    // 双声道完全一致
    let same = out[0].length === out[1].length;
    for (let i = 0; same && i < out[0].length; i++) if (out[0][i] !== out[1][i]) same = false;
    check(`speed=${speed} 双声道逐样本相同`, same);
  }
}

// ---------- click-train：敲击不重复不丢失、位置、能量集中 ----------
console.log('[click-train-44k1-16]');
{
  const a = load('click-train-44k1-16.wav');
  const expect = ref['click-train-44k1-16.wav'].clicks;
  const det = await detectTransients(a.samples[0], a.rate);
  check(`检测到 ${expect.length} 个敲击`, det.length === expect.length, `实际 ${det.length}`);
  let detOk = 0;
  for (const p of expect) if (det.some(q => Math.abs(q - p) <= 0.005 * a.rate)) detOk++;
  check('每个参考敲击都被检出(±5ms)', detOk === expect.length, `${detOk}/${expect.length}`);
  for (const speed of [0.5, 1.5, 2.0]) {
    const { out, anchorsOut, Nout } = await timeStretch(a.samples, speed, det, a.rate);
    check(`speed=${speed} 长度`, Nout === Math.floor(a.frames / speed + 0.5));
    const tol = 0.005 * a.rate;
    // 权威验证：每个参考敲击都有【恰好一个】导出锚点落在映射位置 ±5ms，且不重复
    let okCount = 0;
    const used = new Set();
    for (const p of expect) {
      const target = Math.floor(p / speed + 0.5);
      const hits = [];
      anchorsOut.forEach((m, idx) => { if (Math.abs(m - target) <= tol) hits.push([m, idx]); });
      if (hits.length === 1 && !used.has(hits[0][1])) { okCount++; used.add(hits[0][1]); }
    }
    check(`speed=${speed} 敲击各出现一次且位置±5ms(锚点表)`, okCount === expect.length, `${okCount}/${expect.length}`);
    // 每个映射锚点处必须有显著能量峰（敲击未被吞掉/抹平）
    let peakOk = 0;
    for (const p of expect) {
      const t = Math.floor(p / speed + 0.5);
      let local = 0, base = 0, bn = 0;
      for (let i = Math.max(0, t - 200); i < t; i++) { base += out[0][i] ** 2; bn++; }
      for (let i = Math.max(0, t - 5); i < Math.min(out[0].length, t + 80); i++) local = Math.max(local, Math.abs(out[0][i]));
      const baseRms = bn ? Math.sqrt(base / bn) : 0;
      if (local > baseRms * 3 + 0.02) peakOk++;
    }
    check(`speed=${speed} 锚点处能量峰存在`, peakOk >= expect.length * 0.95, `${peakOk}/${expect.length}`);
    // 95% 能量集中在每个输出敲击起点后 10ms（用实际锚点位置对齐）
    let energyOk = 0;
    for (const p of expect) {
      const target = Math.floor(p / speed + 0.5);
      let t = target;
      for (const m of anchorsOut) if (Math.abs(m - target) <= tol) { t = m; break; }
      const win10 = 0.01 * a.rate;
      let eIn = 0, eAll = 0;
      for (let i = Math.max(0, t - 10); i < Math.min(out[0].length, t + win10); i++) eIn += out[0][i] ** 2;
      for (let i = Math.max(0, t - 10); i < Math.min(out[0].length, t + win10 * 3); i++) eAll += out[0][i] ** 2;
      if (eAll > 0 && eIn / eAll >= 0.95) energyOk++;
    }
    check(`speed=${speed} 95%能量集中在起点后10ms`, energyOk >= expect.length * 0.95, `${energyOk}/${expect.length}`);
    // 锚点输出数组与映射一致
    let anchorOk = anchorsOut.length === det.length;
    for (let i = 0; anchorOk && i < det.length; i++) {
      if (anchorsOut[i] !== Math.floor(det[i] / speed + 0.5)) anchorOk = false;
    }
    check(`speed=${speed} 导出锚点=round(p/speed)`, anchorOk);
  }
}

// ---------- stereo-itd：互相关峰值仍在 10 样本 ----------
console.log('[stereo-itd-44k1-16]');
{
  const a = load('stereo-itd-44k1-16.wav');
  const delay = ref['stereo-itd-44k1-16.wav'].delaySamples;
  for (const speed of [0.7, 1.3, 2.0]) {
    const det = await detectTransients(a.samples[0].map((v, i) => 0.5 * (v + a.samples[1][i])), a.rate);
    const { out } = await timeStretch(a.samples, speed, det, a.rate);
    const maxLag = 30;
    let bestLag = 0, bestV = -Infinity;
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < out[0].length; i++) s += out[0][i] * out[1][i + lag];
      if (s > bestV) { bestV = s; bestLag = lag; }
    }
    check(`speed=${speed} 互相关峰在 ${delay}±1 样本`, Math.abs(bestLag - delay) <= 1, `lag=${bestLag}`);
  }
}

// ---------- dual-mono：两声道完全相同 ----------
console.log('[dual-mono-44k1-16]');
{
  const a = load('dual-mono-44k1-16.wav');
  let inputSame = true;
  for (let i = 0; i < a.frames; i++) if (a.samples[0][i] !== a.samples[1][i]) inputSame = false;
  check('输入双声道相同', inputSame);
  for (const speed of [0.6, 1.7]) {
    const det = await detectTransients(a.samples[0], a.rate);
    const { out } = await timeStretch(a.samples, speed, det, a.rate);
    let same = true;
    for (let i = 0; i < out[0].length; i++) if (out[0][i] !== out[1][i]) { same = false; break; }
    check(`speed=${speed} 输出双声道逐样本相同`, same);
  }
}

// ---------- drum-loop：鼓点不重复不丢失 ----------
console.log('[drum-loop-44k1-16-stereo]');
{
  const a = load('drum-loop-44k1-16-stereo.wav');
  const expect = ref['drum-loop-44k1-16-stereo.wav'].clicks;
  const mono = a.samples[0].map((v, i) => 0.5 * (v + a.samples[1][i]));
  const det = await detectTransients(mono, a.rate);
  // 参考含位置 0 的鼓点
  const detOk = expect.filter(p => p === 0 || det.some(q => Math.abs(q - p) <= 0.005 * a.rate)).length;
  check(`鼓点检出（参考 ${expect.length} 个，含起点 0）`, detOk >= expect.length - 1, `检测 ${det.length} 个，命中 ${detOk}`);
  for (const speed of [0.5, 1.5, 2.0]) {
    const { out, anchorsOut, Nout } = await timeStretch(a.samples, speed, det, a.rate);
    check(`speed=${speed} 长度`, Nout === Math.floor(a.frames / speed + 0.5));
    const tol = 0.005 * a.rate;
    const outMono = out[0].map((v, i) => 0.5 * (v + out[1][i]));
    // 权威验证：每个参考鼓点对应恰好一个导出锚点（不重复不丢失）
    let ok = 0;
    const used = new Set();
    for (const p of expect) {
      if (p === 0) {
        // 位置 0 的鼓点：时间伸缩保证段首锁定，验证输出起点即有能量峰
        let e0 = 0; for (let i = 0; i < 80; i++) e0 = Math.max(e0, Math.abs(outMono[i] || 0));
        if (e0 > 0.1) ok++;
        continue;
      }
      const target = Math.floor(p / speed + 0.5);
      const hits = [];
      anchorsOut.forEach((m, idx) => { if (Math.abs(m - target) <= tol) hits.push(idx); });
      if (hits.length === 1 && !used.has(hits[0])) { ok++; used.add(hits[0]); }
    }
    check(`speed=${speed} 鼓点不重复不丢失(锚点表)`, ok === expect.length, `${ok}/${expect.length}`);
    // 锚点处能量峰确实存在（未被抹平）
    let peakOk = 0;
    for (const p of expect) {
      if (p === 0) continue;
      const target = Math.floor(p / speed + 0.5);
      let local = 0, base = 0, bn = 0;
      for (let i = Math.max(0, target - 200); i < target; i++) { base += outMono[i] ** 2; bn++; }
      for (let i = Math.max(0, target - 5); i < Math.min(outMono.length, target + 80); i++) local = Math.max(local, Math.abs(outMono[i]));
      if (local > Math.sqrt(bn ? base / bn : 0) * 2 + 0.01) peakOk++;
    }
    check(`speed=${speed} 鼓点能量峰保留`, peakOk >= expect.length - 2, `${peakOk}/${expect.length - 1}`);
  }
}

// ---------- speed=1 透传误差 ----------
console.log('[speed=1 透传]');
{
  const a = load('sine440-48k-24-stereo.wav');
  const { out } = await timeStretch(a.samples, 1, [], a.rate);
  let maxErr = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < a.frames; i++) maxErr = Math.max(maxErr, Math.abs(out[c][i] - a.samples[c][i]));
  check('最大误差 ≤1e-3 FS', maxErr <= 1e-3, `maxErr=${maxErr}`);
}

// ---------- 60s 文件可完成且不崩 ----------
console.log('[long-60s-48k-16 性能]');
{
  const t0 = Date.now();
  const a = load('long-60s-48k-16.wav');
  const t1 = Date.now();
  const det = await detectTransients(a.samples[0], a.rate);
  const t2 = Date.now();
  const { out, Nout } = await timeStretch(a.samples, 1.5, det, a.rate);
  const t3 = Date.now();
  check('处理完成', Nout === Math.floor(a.frames / 1.5 + 0.5), `Nout=${Nout}`);
  check(`耗时可接受（解析${t1 - t0}ms 检测${t2 - t1}ms 伸缩${t3 - t2}ms，敲击${det.length}）`, t3 - t0 < 60000);
}

// ---------- WAV 往返位深 ----------
console.log('[WAV 编码往返]');
{
  const a = load('sine440-48k-24-stereo.wav');
  const blob = encodeWav(a.samples, a.rate, 24);
  const ab = await blob.arrayBuffer();
  const b = parseWav(ab);
  check('24位往返参数', b.bits === 24 && b.rate === 48000 && b.channels === 2 && b.frames === a.frames);
  let maxErr = 0;
  for (let i = 0; i < 1000; i++) maxErr = Math.max(maxErr, Math.abs(b.samples[0][i] - a.samples[0][i]));
  check('24位量化误差 ≤1 LSB', maxErr <= 1 / 8388608 + 1e-9, `${maxErr}`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
