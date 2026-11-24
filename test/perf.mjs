// perf.mjs — 满额数据渲染性能与抽查：64 条、30 万行、288 万帧（60 秒）。
// 运行：node test/perf.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const O = require('../optical-core.js');

const TPF = 960;
const FRAMES = O.MAX_FRAMES; // 2,880,000
const T = FRAMES * TPF;
const STRIPS = 64;
const ROWS = 300000;

function buildMaxFixture() {
  const rowsPer = Math.floor(ROWS / STRIPS);
  const extra = ROWS - rowsPer * STRIPS;
  const widths = [479, 960, 1441];
  const strips = [];
  let id = 1;
  for (let k = 0; k < STRIPS; k++) {
    const n = rowsPer + (k < extra ? 1 : 0);
    const step = widths[k % widths.length];
    // 起点在整条 60 秒时间线上错开
    const start = Math.floor((k / (STRIPS - 1)) * (T - n * step - 1000)) + k * 37;
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = 40 + ((i * 7 + k * 13) % 140);
      const ch = [16, 216, [p, p + 6, p + 11, p + 17]];
      // 交替让左 / 右声道无效
      if (i % 2 === 0) rows[i] = [null, ch];
      else rows[i] = [ch, null];
    }
    strips.push({ id: id++, start, step, rows });
  }
  return { frames: FRAMES, strips };
}

const data = buildMaxFixture();
console.log('fixture ready:', data.strips.length, 'strips');

// “载入”完成后计时渲染（含解码）
const t0 = process.hrtime.bigint();
const r = O.renderStrips(data);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`render: ${ms.toFixed(0)} ms`, r.stats);

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
}

check(r.frameCount === FRAMES, `帧数 ${FRAMES}`);
check(r.pcm.length === FRAMES * 2, '交错 PCM 长度正确');
check(ms < 10000, `渲染 ${ms.toFixed(0)}ms < 10000ms`);

// 不变量 + 抽查已知满覆盖 / 部分覆盖 / 空白位置
let inRange = true, covOk = true;
for (let f = 0; f < FRAMES; f++) {
  const l = r.pcm[2 * f], rr = r.pcm[2 * f + 1];
  if (l < -32768 || l > 32767 || rr < -32768 || rr > 32767) inRange = false;
  if (r.coverage.left[f] > 960 || r.coverage.right[f] > 960) covOk = false;
}
check(inRange, '全部 PCM 在 int16 范围');
check(covOk, '全部覆盖刻数 <= 960');

// 找一个满覆盖、一个部分覆盖、一个零覆盖帧做 inspect 抽查
let full = -1, partial = -1, blank = -1;
for (let f = 0; f < FRAMES; f++) {
  const c = r.coverage.left[f] + r.coverage.right[f];
  if (full < 0 && r.coverage.left[f] === 960 && r.coverage.right[f] === 960) full = f;
  if (partial < 0 && c > 0 && c < 1920) partial = f;
  if (blank < 0 && c === 0) blank = f;
  if (full >= 0 && partial >= 0 && blank >= 0) break;
}
console.log('spot frames:', { full, partial, blank });
for (const [kind, f] of [['full', full], ['partial', partial], ['blank', blank]]) {
  if (f < 0) { console.log(`  (未找到 ${kind} 帧，跳过)`); continue; }
  const info = r.inspectFrame(f);
  const sumL = info.left.sources.reduce((a, s) => a + s.ticks, 0);
  const sumR = info.right.sources.reduce((a, s) => a + s.ticks, 0);
  check(sumL === info.coverage.left && sumR === info.coverage.right,
    `${kind} 帧 ${f}: 来源刻数和=覆盖刻数 (${sumL},${sumR})`);
  check(info.sample.left === r.pcm[2 * f], `${kind} 帧 ${f}: inspect 样本一致`);
}

// WAV 编码计时
const w0 = process.hrtime.bigint();
const wav = O.encodeWavPcm(r.pcm);
const wms = Number(process.hrtime.bigint() - w0) / 1e6;
console.log(`wav encode: ${wms.toFixed(0)} ms, ${(wav.length / 1048576).toFixed(1)} MiB`);
check(wav.length === 44 + FRAMES * 4, 'WAV 字节数 = 44 + 帧*4');

// 缺口表生成计时
const g0 = process.hrtime.bigint();
const csv = O.gapsToCsv(r);
const gms = Number(process.hrtime.bigint() - g0) / 1e6;
console.log(`gap csv: ${gms.toFixed(0)} ms, ${(csv.length / 1048576).toFixed(1)} MiB,`,
  r.gapCount, 'gaps');

console.log(failures ? `\n性能测试失败 ${failures}` : '\n性能测试全部通过');
process.exit(failures ? 1 : 0);
