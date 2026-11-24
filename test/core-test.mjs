// core-test.mjs — 验收点数值用例 + 逐刻暴力模型随机对照。
// 运行：node test/core-test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const O = require('../optical-core.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${msg}（期望 ${e}，实际 ${a}）`);
}

// ---------------------------------------------------------- 验收点 2
console.log('\n[验收点2] 像素归一 / 半档取偶 / int16 夹取');
{
  const left = O.analyzeChannel([1, 3, [0, 2, 3]]);
  eq(left.normalized, [0, 0.5, 1], '左声道归一后为 0,0.5,1');
  ok(left.sample === 0, `左声道样本为 0（实际 ${left.sample}）`);

  const right = O.analyzeChannel([10, 20, [20, 20, 20, 20]]);
  ok(right.sample === 32767, `全亮夹到 32767（实际 ${right.sample}）`);

  // bright <= dark 无效
  ok(O.decodeChannel([5, 5, [5]]) === null, '亮参考等于暗参考 → 无效');
  ok(O.decodeChannel([9, 5, [7]]) === null, '亮参考小于暗参考 → 无效');
  ok(O.decodeChannel(null) === null, 'null 声道 → 无效');
  ok(O.decodeChannel([1, 9, null]) === null, 'values 为 null → 无效');
  ok(O.decodeChannel([1, 9, [4, null, 5]]) === null, '任一像素 null → 无效');
  ok(O.decodeChannel([null, 9, [4]]) === null, '暗参考 null → 无效');

  // 半档取偶：直接构造 unscaled 半值不容易，单测取整函数
  ok(O.roundHalfEven(0.5) === 0, 'roundHalfEven(0.5)=0');
  ok(O.roundHalfEven(1.5) === 2, 'roundHalfEven(1.5)=2');
  ok(O.roundHalfEven(2.5) === 2, 'roundHalfEven(2.5)=2');
  ok(O.roundHalfEven(-1.5) === -2, 'roundHalfEven(-1.5)=-2');
  ok(O.roundHalfEven(-2.5) === -2, 'roundHalfEven(-2.5)=-2');
  ok(O.roundHalfEven(1.4) === 1 && O.roundHalfEven(1.6) === 2, '普通四舍五入');
  // 整数除法半档取偶
  ok(O.divRoundHalfEven(480, 960) === 0, '480/960=0.5 → 偶数 0');
  ok(O.divRoundHalfEven(1440, 960) === 2, '1440/960=1.5 → 2');
  ok(O.divRoundHalfEven(2400, 960) === 2, '2400/960=2.5 → 2');
  ok(O.divRoundHalfEven(-1440, 960) === -2, '-1440/960=-1.5 → -2');
}

// ---------------------------------------------------------- 验收点 3
console.log('\n[验收点3] 重叠：编号最小有效条带 + 无效声道让位');
{
  // id2 覆盖 [0,960)，两声道归一 0.25 → -16384
  // id1 覆盖 [240,720)，左 0.75 → 16384，右参考相等无效
  const normCh = (x) => {
    // dark=0 bright=4 → 像素 x*4
    return [0, 4, [x * 4]];
  };
  const data = {
    frames: 1,
    strips: [
      {
        id: 1, start: 240, step: 480,
        rows: [[normCh(0.75), [5, 5, [5]]]], // [240,720)，右无效
      },
      {
        id: 2, start: 0, step: 960,
        rows: [[normCh(0.25), normCh(0.25)]], // [0,960)
      },
    ],
  };
  const r = O.renderStrips(data);
  ok(r.pcm[0] === 0, `左声道输出 0（实际 ${r.pcm[0]}）`);
  ok(r.pcm[1] === -16384, `右声道输出 -16384（实际 ${r.pcm[1]}）`);
  ok(r.coverage.left[0] === 960, `左覆盖 960（实际 ${r.coverage.left[0]}）`);
  ok(r.coverage.right[0] === 960, `右覆盖 960（实际 ${r.coverage.right[0]}）`);

  const info = r.inspectFrame(0);
  const rs = info.right.sources;
  eq(rs, [{ stripId: 2, ticks: 960 }], '右声道全段源自编号 2');
  const lMap = Object.fromEntries(info.left.sources.map((s) => [s.stripId, s.ticks]));
  eq(lMap, { 1: 480, 2: 480 }, '左声道 1/2 各 480 刻');
  // 左声道运行段顺序
  const stripSeq = info.left.runs.map((x) => x.stripId);
  eq(stripSeq, [2, 1, 2], '左声道来源段顺序 2→1→2');
  const intervals = info.left.runs.map((x) => [x.startTick, x.endTick]);
  eq(intervals, [[0, 240], [240, 720], [720, 960]], '左声道三段半开区间');
}

// ---------------------------------------------------------- 验收点 4
console.log('\n[验收点4] 缺刻补零 / 实际覆盖加权 / 缺口半开区间');
{
  // 满亮行左覆盖 [480,960)：start=480, step=480
  const fullBright = [0, 4, [4, 4, 4, 4]]; // 32767
  const data = {
    frames: 1,
    strips: [{ id: 1, start: 480, step: 480, rows: [[fullBright, null]] }],
  };
  const r = O.renderStrips(data);
  ok(r.pcm[0] === 16384, `左值 16384（实际 ${r.pcm[0]}，行样本 ${O.decodeChannel(fullBright)}）`);
  ok(r.coverage.left[0] === 480, `左覆盖 480（实际 ${r.coverage.left[0]}）`);
  ok(r.pcm[1] === 0, `右值 0（实际 ${r.pcm[1]}）`);
  ok(r.coverage.right[0] === 0, `右覆盖 0（实际 ${r.coverage.right[0]}）`);
  eq(r.getGaps('left'), [[0, 480]], '左缺口 [0,480)');
  eq(r.getGaps('right'), [[0, 960]], '右缺口 [0,960)');
}

// ---------------------------------------------------------- 暴力模型对照
console.log('\n[随机对照] 逐 tick 暴力 oracle（含负起点/null/坏参考/奇数行宽）');

function bruteRender(data) {
  const P = O.parseDataset(data);
  const F = P.frameCount, T = F * 960;
  const pcm = new Int16Array(2 * F);
  const covL = new Uint32Array(F), covR = new Uint32Array(F);
  const numL = new Float64Array(F), numR = new Float64Array(F);
  const gapL = [], gapR = [];
  let runL = null, runR = null;
  for (let t = 0; t < T; t++) {
    let vL = null, idL = -1, vR = null, idR = -1;
    for (const s of P.strips) {
      if (t < s.start || t >= s.end) continue;
      const i = Math.floor((t - s.start) / s.step);
      if (i < 0 || i >= s.rowCount) continue;
      const sl = s.samplesL[i];
      if (vL === null && sl !== 2147483647) { vL = sl; idL = s.id; }
      const sr = s.samplesR[i];
      if (vR === null && sr !== 2147483647) { vR = sr; idR = s.id; }
    }
    const f = Math.floor(t / 960);
    if (vL !== null) { numL[f] += vL; covL[f]++; }
    if (vR !== null) { numR[f] += vR; covR[f]++; }
    // gap runs
    if (vL === null) { if (runL === null) runL = t; }
    else if (runL !== null) { gapL.push([runL, t]); runL = null; }
    if (vR === null) { if (runR === null) runR = t; }
    else if (runR !== null) { gapR.push([runR, t]); runR = null; }
  }
  if (runL !== null) gapL.push([runL, T]);
  if (runR !== null) gapR.push([runR, T]);
  for (let f = 0; f < F; f++) {
    pcm[2 * f] = O.clampInt16(O.divRoundHalfEven(numL[f], 960));
    pcm[2 * f + 1] = O.clampInt16(O.divRoundHalfEven(numR[f], 960));
  }
  return { pcm, covL, covR, gapL, gapR };
}

// 简单可复现 PRNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randChannel(rnd) {
  const kind = rnd();
  if (kind < 0.18) return null;
  const dark = Math.floor(rnd() * 40);
  let bright = dark + Math.floor(rnd() * 8);
  if (kind < 0.3) bright = dark; // 坏参考
  const n = 1 + Math.floor(rnd() * 6);
  const px = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.1) px.push(null);
    else px.push(Math.floor(rnd() * (bright + 10)) - 2);
  }
  return [dark, bright, px];
}

let bruteCases = 0;
for (let seed = 1; seed <= 60; seed++) {
  const rnd = mulberry32(seed * 7919 + 13);
  const F = 1 + Math.floor(rnd() * 6);
  const T = F * 960;
  const nStrips = 1 + Math.floor(rnd() * 4);
  const strips = [];
  for (let k = 0; k < nStrips; k++) {
    const step = [1, 3, 7, 16, 300, 479, 720, 960, 1441][Math.floor(rnd() * 9)];
    const start = Math.floor(rnd() * T) - Math.floor(rnd() * 400);
    const nRows = 1 + Math.floor(rnd() * 8);
    const rows = [];
    for (let i = 0; i < nRows; i++) rows.push([randChannel(rnd), randChannel(rnd)]);
    strips.push({ id: k + 1, start, step, rows });
  }
  const data = { frames: F, strips };
  const fast = O.renderStrips(data);
  const brute = bruteRender(data);
  bruteCases++;

  let pcmSame = true;
  for (let i = 0; i < fast.pcm.length; i++) {
    if (fast.pcm[i] !== brute.pcm[i]) { pcmSame = false;
      console.error(`    seed ${seed} pcm[${i}] fast=${fast.pcm[i]} brute=${brute.pcm[i]}`); break; }
  }
  ok(pcmSame, `seed ${seed}: PCM 与暴力模型一致`);

  let covSame = true;
  for (let f = 0; f < F; f++) {
    if (fast.coverage.left[f] !== brute.covL[f] ||
        fast.coverage.right[f] !== brute.covR[f]) {
      covSame = false;
      console.error(`    seed ${seed} f${f} cov fast=${fast.coverage.left[f]},${fast.coverage.right[f]} brute=${brute.covL[f]},${brute.covR[f]}`);
      break;
    }
  }
  ok(covSame, `seed ${seed}: 覆盖刻数一致`);
  eq(fast.getGaps('left'), brute.gapL, `seed ${seed}: 左缺口一致`);
  eq(fast.getGaps('right'), brute.gapR, `seed ${seed}: 右缺口一致`);

  // inspectFrame 的 sources ticks 之和必须等于 coverage
  for (let f = 0; f < F; f++) {
    const info = fast.inspectFrame(f);
    const sumL = info.left.sources.reduce((a, s) => a + s.ticks, 0);
    const sumR = info.right.sources.reduce((a, s) => a + s.ticks, 0);
    if (sumL !== info.coverage.left || sumR !== info.coverage.right) {
      ok(false, `seed ${seed} f${f}: inspect 来源刻数和 != coverage`);
      break;
    }
    const runL = info.left.runs.reduce((a, x) => a + x.ticks, 0);
    if (runL !== info.coverage.left) { ok(false, `seed ${seed} f${f}: runs 刻数和不符`); break; }
  }
}
console.log(`  （完成 ${bruteCases} 组随机对照）`);

// ---------------------------------------------------------- 样例文件
console.log('\n[样例] samples/optical-strips.json');
{
  const json = JSON.parse(readFileSync(join(__dirname, '..', 'samples', 'optical-strips.json'), 'utf8'));
  const r = O.renderStrips(json);
  eq(r.frameCount, 84, '样例 84 帧');
  eq(r.stats.stripCount, 2, '样例 2 条带');
  eq(r.stats.totalRows, 105, '样例共 105 行');
  ok(r.pcm.length === 84 * 2, 'PCM 长度 168');
  // 几何重叠 [41400,43200) 内 id1 全程有效且编号更小，故重叠帧仍只来自 id1；
  // id1 在 43200 半开结束，恰为第 45 帧起点，之后才完全由 id2 覆盖。
  eq(r.inspectFrame(43).left.sources, [{ stripId: 1, ticks: 960 }], '帧43 由编号1覆盖');
  eq(r.inspectFrame(44).left.sources, [{ stripId: 1, ticks: 960 }], '帧44 由编号1覆盖');
  eq(r.inspectFrame(45).left.sources, [{ stripId: 2, ticks: 960 }], '帧45 起由编号2覆盖');
  eq(r.getGaps('left'), [[77400, 80640]], '样例左声道尾部缺口 [77400,80640)');
  // WAV 头
  const wav = O.encodeWavPcm(r.pcm);
  const dv = new DataView(wav.buffer);
  ok(wav[0] === 0x52 && wav[1] === 0x49, 'WAV RIFF 头');
  eq(dv.getUint16(22, true), 2, 'WAV 双声道');
  eq(dv.getUint32(24, true), 48000, 'WAV 48kHz');
  eq(dv.getUint16(34, true), 16, 'WAV 16bit');
  eq(dv.getUint32(40, true), r.pcm.length * 2, 'WAV data 长度');
  // CSV 头与半开区间
  const csv = O.gapsToCsv(r);
  ok(csv.startsWith('channel,channel_index,start_tick'), 'CSV 表头');
  ok(csv.includes('left,0,'), 'CSV 含左声道行');
  ok(csv.includes('right,1,'), 'CSV 含右声道行');
}

// ---------------------------------------------------------- 区域切片一致性
console.log('\n[切片] pcmSlice / float 与整轨对应位置逐位一致');
{
  const json = JSON.parse(readFileSync(join(__dirname, '..', 'samples', 'optical-strips.json'), 'utf8'));
  const r = O.renderStrips(json);
  const a = 10, b = 40;
  const sl = r.pcmSlice(a, b);
  ok(sl.length === (b - a) * 2, '切片长度');
  let same = true;
  for (let i = 0; i < sl.length; i++) if (sl[i] !== r.pcm[2 * a + i]) same = false;
  ok(same, 'Int16 切片是整轨的逐位 subarray 副本');
  const fl = r.toFloatChannels(a, b);
  let floatSame = true;
  for (let i = 0; i < b - a; i++) {
    if (fl.left[i] !== r.pcm[2 * (a + i)] / 32768) floatSame = false;
    if (fl.right[i] !== r.pcm[2 * (a + i) + 1] / 32768) floatSame = false;
  }
  ok(floatSame, '试听 Float32 样本与整轨 int16/32768 完全一致');
  const wavAll = O.encodeWavPcm(r.pcm);
  const wavRegion = O.encodeWavPcm(sl, { frames: b - a });
  // 去掉 44 字节头后，区域 WAV 数据必须等于整轨 WAV 对应字节段
  const allBytes = new Uint8Array(wavAll);
  const regBytes = new Uint8Array(wavRegion);
  let wavSame = true;
  const startByte = 44 + a * 4; // 立体声16bit = 4 字节/帧
  for (let i = 0; i < regBytes.length - 44; i++) {
    if (regBytes[44 + i] !== allBytes[startByte + i]) { wavSame = false; break; }
  }
  ok(wavSame, '裁区 WAV 的 data 与整轨 WAV 半开切片逐字节一致');
}

console.log(`\n结果：${passes} 通过，${failures} 失败`);
process.exit(failures ? 1 : 0);
