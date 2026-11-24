// 生成合成测量包（满额 / 冲突 / 补零 / 长扫频等），供性能测试与单元测试使用。
//
// 用法：
//   node tools/make-case.mjs --out tests/fixtures/edge-cases.zip
//   node tools/make-case.mjs --out /tmp/full.zip --full
//   node tools/make-case.mjs --list
//
// 扫频为解析指数扫频（与常规 ESS 同相），采集由「直达 + 2/3/4 次谐波 + 噪声」构成，
// 各阶谐波按 1/q 时间压缩后延迟到理论中心位置。生成物只用于测试，不进产品路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Wav = require(path.join(ROOT, 'src/js/wav.js'));
const Zip = require(path.join(ROOT, 'src/js/zip.js'));
const Core = require(path.join(ROOT, 'src/js/core.js'));

const SR = 48000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* 解析指数扫频：x[n] = A*sin(2π f0 T/L (exp(L t/T) - 1)) */
function makeSweep({ f0, f1, seconds, amp = 0.4 }) {
  const N = Math.round(seconds * SR);
  const T = N / SR;
  const L = Math.log(f1 / f0);
  const x = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const ph = 2 * Math.PI * f0 * T / L * (Math.exp(L * t / T) - 1);
    x[n] = amp * Math.sin(ph);
  }
  return x;
}

/*
 * 生成采集通道：直达 + 各阶谐波 + 噪声。
 *
 * 谐波用「相位 ×q」的解析模型（无记忆非线性失真的标准描述）：
 *   y[n] = Σ_q g_q · sin(q·φ(n-d))，φ 为扫频相位
 * 线性反卷积后第 q 阶峰落在 (N-1) + d - shift_q，shift_q = floor(N·ln q / ln(f1/f0) + 0.5)。
 * 因此把直达零点放在 rel = zeroRel 时取 d = zeroRel 即可。
 */
function makeCaptureChannel(x, cfg) {
  const { zeroRel, orders, frames } = cfg;
  const rnd = rng(cfg.seed || 1);
  const N = x.length;
  const out = new Float64Array(frames);
  const d = zeroRel;
  for (const o of orders) {
    for (let n = Math.max(0, d); n < frames; n++) {
      const k = n - d;
      if (k >= N) break;
      // 相位取自扫频本身：x[k] 的解析相位为 2π f0 T/L (exp(L k/(N T))·T - 1)
      const L = Math.log(cfg.f1 / cfg.f0);
      const T = N / SR;
      const ph = 2 * Math.PI * cfg.f0 * T / L * (Math.exp(L * (k / SR) / T) - 1);
      out[n] += o.gain * Math.sin(o.q * ph);
    }
  }
  const noise = cfg.noise || 0;
  for (let n = 0; n < frames; n++) out[n] += noise * (rnd() * 2 - 1);
  return out;
}

function encodePcm16(channels, frames) {
  const ch = channels.length;
  const dataBytes = frames * ch * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let v = Math.max(-1, Math.min(1, channels[c][i]));
      let q = Math.round(v * 32767);
      if (q > 32767) q = 32767;
      if (q < -32768) q = -32768;
      buf.writeInt16LE(q, p);
      p += 2;
    }
  }
  return new Uint8Array(buf);
}

/* 解析命令行 */
function parseArgs(argv) {
  const out = { out: null, full: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--full') out.full = true;
    else if (a === '--list') out.list = true;
  }
  return out;
}

/* 用例定义：每个用例 = {name, sweep, capture 通道, setup} */
export function buildCases(onlyFull) {
  const cases = [];
  if (onlyFull) {
    // 满额：20 s 扫频 + 25 s 四通道采集
    const sweep = makeSweep({ f0: 20, f1: 20000, seconds: 20, amp: 0.45 });
    const frames = 25 * SR;
    const chans = [];
    for (let c = 0; c < 4; c++) {
      chans.push(makeCaptureChannel(sweep, {
        f0: 20, f1: 20000, zeroRel: 480 + c * 97, frames,
        orders: [
          { q: 1, gain: 0.30 - 0.03 * c },
          { q: 2, gain: 0.030 },
          { q: 3, gain: 0.006 },
          { q: 4, gain: 0.002 },
        ],
        noise: 1e-4, seed: 100 + c,
      }));
    }
    cases.push({
      name: 'full',
      sweep,
      capture: chans,
      setup: { f0: 20, f1: 20000, lo: 300, hi: 1300, pre: 80, post: 480 },
    });
    return cases;
  }

  // 基础样例：1 s 扫频、2 通道
  const sweepA = makeSweep({ f0: 80, f1: 6000, seconds: 1, amp: 0.4 });
  const capA = [
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 480, frames: 51000,
      orders: [{ q: 1, gain: 0.5 }, { q: 2, gain: 0.04 }], noise: 1e-5, seed: 7,
    }),
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 813, frames: 51000,
      orders: [{ q: 1, gain: -0.35 }, { q: 2, gain: 0.035 }, { q: 3, gain: 0.004 }], noise: 1e-5, seed: 8,
    }),
  ];
  cases.push({
    name: 'basic',
    sweep: sweepA,
    capture: capA,
    setup: { f0: 80, f1: 6000, lo: 300, hi: 1300, pre: 80, post: 480 },
  });

  // 窗冲突：pre/post 很大，四阶窗互相重叠
  const capB = [
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 500, frames: 51000,
      orders: [{ q: 1, gain: 0.5 }, { q: 2, gain: 0.04 }], noise: 1e-5, seed: 11,
    }),
  ];
  cases.push({
    name: 'conflict',
    sweep: sweepA,
    capture: capB,
    setup: { f0: 80, f1: 6000, lo: 300, hi: 900, pre: 4000, post: 4800 },
  });

  // 窗越界补零（左）：pre 大于 q4 中心到 0 的距离，q3/q4 窗左端落到负索引
  const capC = [
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 120, frames: 51000,
      orders: [{ q: 1, gain: 0.5 }, { q: 2, gain: 0.04 }], noise: 1e-5, seed: 13,
    }),
  ];
  cases.push({
    name: 'zeropad',
    sweep: sweepA,
    capture: capC,
    setup: { f0: 80, f1: 6000, lo: 50, hi: 300, pre: 40000, post: 480 },
  });

  // 窗越界补零（右）：post 极大，q1 窗右端越过反卷积数据末尾
  const capE = [
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 400, frames: 51000,
      orders: [{ q: 1, gain: 0.5 }, { q: 2, gain: 0.04 }], noise: 1e-5, seed: 14,
    }),
  ];
  cases.push({
    name: 'zeropad-right',
    sweep: sweepA,
    capture: capE,
    setup: { f0: 80, f1: 6000, lo: 200, hi: 600, pre: 20, post: 52000 },
  });

  // 单声道采集（1–4 通道里的最小情形），文件名仍带 sweep/capture 提示
  const capF = [
    makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 350, frames: 51000,
      orders: [{ q: 1, gain: 0.45 }, { q: 2, gain: 0.03 }], noise: 1e-5, seed: 15,
    }),
  ];
  cases.push({
    name: 'mono',
    sweep: sweepA,
    capture: capF,
    setup: { f0: 80, f1: 6000, lo: 100, hi: 700, pre: 60, post: 300 },
  });

  // 三通道（1/3/4 阶合成），验证逐通道独立零点
  const capD = [];
  for (let c = 0; c < 3; c++) {
    capD.push(makeCaptureChannel(sweepA, {
      f0: 80, f1: 6000, zeroRel: 200 + c * 250, frames: 51000,
      orders: [
        { q: 1, gain: 0.4 - 0.05 * c },
        { q: 2, gain: 0.02 + 0.01 * c },
        { q: 3, gain: 0.003 },
        { q: 4, gain: 0.002 },
      ], noise: 1e-5, seed: 20 + c,
    }));
  }
  cases.push({
    name: 'threech',
    sweep: sweepA,
    capture: capD,
    setup: { f0: 80, f1: 6000, lo: 150, hi: 1000, pre: 60, post: 300 },
  });

  return cases;
}

export function caseToZip(c) {
  const setupJson = new TextEncoder().encode(JSON.stringify(c.setup));
  const entries = [
    { name: 'sweep.wav', data: encodePcm16([c.sweep], c.sweep.length) },
    { name: 'capture.wav', data: encodePcm16(c.capture, c.capture[0].length) },
    { name: 'setup.json', data: setupJson },
  ];
  return Zip.zipStore(entries);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error('用法：node tools/make-case.mjs --out <file.zip> [--full]');
    process.exit(1);
  }
  const t0 = Date.now();
  const cases = buildCases(args.full);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  if (args.full) {
    const z = caseToZip(cases[0]);
    fs.writeFileSync(args.out, z);
    console.log(`写出 ${args.out}（${(z.length / 1048576).toFixed(1)} MiB，${((Date.now() - t0) / 1000).toFixed(1)} s）`);
    return;
  }
  // 非满额时给每个用例单独一个 zip：<out 目录>/<name>.zip
  const dir = path.resolve(args.out);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of cases) {
    const file = path.join(dir, c.name + '.zip');
    fs.writeFileSync(file, caseToZip(c));
    console.log('写出', path.relative(process.cwd(), file));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
