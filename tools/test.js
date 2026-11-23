/*
 * 自包含测试：node tools/test.js
 *
 * 覆盖：ZIP 读取、时间线校验、P95/建议格、求解器（样例 + 随机 + 穷举对照）、
 * SDR 渲染（黄金 SHA-256）、曝光表 PTS/时长保持、满预算性能。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('../src/core.js');
const pqzip = require('../src/zip.js');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  PASS ' + label); }
  else { failed++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function section(t) { console.log('\n' + t); }

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_ZIP = path.join(ROOT, 'samples', 'pq-exposure-cases.zip');

const GOLD = {
  p95: [61710, 66884, 80816, 87448, 286204, 244579, 151602, 130152],
  suggested: [11, 9, 5, 3, -24, -21, -10, -6],
  exposure: [11, 9, 5, 3, -25, -19, -11, -5],
  objective: 7,
  sdr: {
    '0,11': '3a01c8780a913a02bace8ab1e3558188420926205915aa40e78e3db8843c1d98',
    '4,-25': '813bf676b32db0d72033fd32604cf3c940dab1fc8899881ff31133f62dd27f1d',
    '7,-5': '9e1146ab5919670104a0c8703e951cad8887cb5abfd9b1765845ed965c2392de',
    '2,5': 'fc4127782c526099352920609eff3c96632fe143b17085f6d71f972f93b26f91',
    '5,-19': '0201aa1373ebe2cff9b77507b247c6a2d85464dda1a8c9f2d81c0f5b02ccc00e',
  },
};

function toU16(raw) {
  const copy = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
    ? new Uint8Array(raw.buffer) : raw.slice();
  return new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
}

async function loadSample() {
  const buf = fs.readFileSync(SAMPLE_ZIP);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const entries = await pqzip.readZip(ab);
  const tlRaw = await entries.find((e) => e.name.endsWith('timeline.json')).bytes();
  const frRaw = await entries.find((e) => e.name.endsWith('frames.rgb10')).bytes();
  return { entries, tl: JSON.parse(new TextDecoder().decode(tlRaw)), pixels: toU16(frRaw) };
}

/* ================= 1. ZIP 与校验 ================= */
async function testZipAndValidate(sample) {
  section('1. ZIP 读取与时间线校验');
  ok(sample.entries.length === 3, 'ZIP 读出 3 个文件（含约定.txt）', sample.entries.map((e) => e.name));
  ok(sample.entries.some((e) => e.name === '约定.txt'), 'ZIP 内的约定.txt 可解压');

  const v = core.validateTimeline(sample.tl);
  ok(v.ok, '样例 timeline 通过校验');
  ok(v.meta.width === 48 && v.meta.height === 24, '尺寸 48×24');

  const bad = [
    [{ ...sample.tl, width: 0 }, 'width=0 拒绝'],
    [{ ...sample.tl, width: 641 }, 'width=641 拒绝'],
    [{ ...sample.tl, height: 361 }, 'height=361 拒绝'],
    [{ ...sample.tl, pts_us: [0, 0, 2], end_us: 3, cuts: [0], weights: [1, 1, 1], locks: [] }, 'PTS 非严格递增拒绝'],
    [{ ...sample.tl, pts_us: [0, 1.5], end_us: 3, cuts: [0], weights: [1, 1], locks: [] }, 'PTS 非整数拒绝'],
    [{ ...sample.tl, end_us: sample.tl.pts_us[7] }, 'end_us 等于末 PTS 拒绝'],
    [{ ...sample.tl, cuts: [1, 0] }, 'cuts 未从 0 开始拒绝'],
    [{ ...sample.tl, cuts: [0, 8] }, 'cuts 越界拒绝'],
    [{ ...sample.tl, weights: [1, 2] }, 'weights 长度不足拒绝'],
    [{ ...sample.tl, weights: [0, 1, 1, 1, 1, 1, 1, 1] }, 'weights 含 0 拒绝'],
    [{ ...sample.tl, weights: [101, 1, 1, 1, 1, 1, 1, 1] }, 'weights 含 101 拒绝'],
    [{ ...sample.tl, locks: [[0, 97]] }, '锁值越界拒绝'],
    [{ ...sample.tl, locks: [[0, 1], [0, 2]] }, '重复锁定拒绝'],
    [{ ...sample.tl, locks: [[8, 1]] }, '锁定帧越界拒绝'],
    [{ ...sample.tl, locks: [[0]] }, '锁定项格式拒绝'],
    [null, 'null 拒绝'],
    [[], '数组拒绝'],
  ];
  for (const [tl, label] of bad) {
    const r = core.validateTimeline(tl);
    ok(!r.ok && r.errors.length > 0, label);
  }

  // 1800 帧上限与 2500 万像素
  const mk = (w, h, n) => ({
    width: w, height: h,
    pts_us: Array.from({ length: n }, (_, i) => i * 1000),
    end_us: n * 1000, cuts: [0], weights: new Array(n).fill(1), locks: [],
  });
  ok(!core.validateTimeline(mk(8, 8, 1801)).ok, '1801 帧拒绝');
  ok(core.validateTimeline(mk(640, 360, 3)).ok, '640×360×3 = 691,200 px 在预算内通过');
  ok(!core.validateTimeline(mk(640, 360, 109)).ok, '640×360×109 = 25,113,600 px 超预算拒绝');
  ok(core.validateTimeline(mk(640, 360, 108)).ok, '640×360×108 = 24,883,200 px 恰好通过');
}

/* ================= 2. P95 与建议 ================= */
function testStats(sample) {
  section('2. P95 与建议曝光格');
  const st = core.computeStats(sample.pixels, sample.tl.width, sample.tl.height, sample.tl.pts_us.length);
  ok(eq(Array.from(st.p95), GOLD.p95), 'P95 与参考一致', Array.from(st.p95));
  ok(eq(Array.from(st.suggested), GOLD.suggested), '建议格与参考一致', Array.from(st.suggested));

  // P95 定义细节：升序第 ceil(95*n/100) 个（1 起）
  const w = 20, h = 5, n = 1; // 100 px -> k=95
  const px = new Uint16Array(w * h * 3);
  // 统一码值，使所有像素亮度相同：P95 即为该值
  px.fill(700);
  const st2 = core.computeStats(px, w, h, n);
  const npix = w * h;
  const sorted = new Array(npix).fill(Math.floor(1000 * core.PQ_LUT[700] + 0.5)).sort((a, b) => a - b);
  const k = Math.ceil((95 * npix) / 100);
  ok(st2.p95[0] === sorted[k - 1], 'P95 取第 ceil(95%·N) 个（1 起）', { got: st2.p95[0], want: sorted[k - 1] });
  ok(st2.suggested[0] === core.suggestFromP95(st2.p95[0]), '建议格公式一致');

  // 越界码值必须拒绝
  let threw = false;
  const badPx = new Uint16Array(w * h * 3).fill(1024);
  try { core.computeStats(badPx, w, h, 1); } catch (_) { threw = true; }
  ok(threw, '码值 > 1023 抛错（高 6 位非 0）');

  // P95 = 0/极小值不产生 ±Infinity
  const dark = new Uint16Array(3 * 4).fill(0);
  const st3 = core.computeStats(dark, 2, 2, 1);
  ok(st3.p95[0] === 0, '全黑帧 P95 = 0');
  ok(st3.suggested[0] === 96, '全黑帧建议格夹到 +96', st3.suggested[0]);
}

/* ================= 3. 求解器 ================= */
function mkMeta(weights, locks, cuts, n) {
  return {
    width: 1, height: 1,
    pts_us: Array.from({ length: n }, (_, i) => i * 1000),
    end_us: n * 1000,
    cuts: cuts || [0],
    weights, locks: locks || [],
  };
}

function testSolver(sample) {
  section('3. 求解器');
  const v = core.validateTimeline(sample.tl);
  const st = core.computeStats(sample.pixels, 48, 24, 8);
  const res = core.solveAll(v.meta, st.suggested);
  ok(res.ok, '样例可解');
  ok(eq(Array.from(res.exposure), GOLD.exposure), '样例曝光与参考一致（同成本字典序最小）', Array.from(res.exposure));
  ok(res.objective === GOLD.objective, '目标值 7', res.objective);

  // 切点两侧独立：末尾镜头首个差值不受前镜头约束
  const meta = mkMeta([1, 1, 1, 1, 1], [[3, 40]], [0, 3], 5);
  const r2 = core.solveAll(meta, Int16Array.from([0, 0, 0, 0, 0]));
  ok(r2.ok && r2.exposure[3] === 40, '切点后首帧可立刻跳到锁定值（镜头独立）', r2.exposure && Array.from(r2.exposure));
  ok(r2.ok && Math.abs(r2.exposure[4] - r2.exposure[3]) <= 12, '新镜头内仍受限速');
  ok(r2.ok && r2.exposure[2] === 0, '前一镜头不受后续锁定影响', r2.exposure && Array.from(r2.exposure));

  // 速度与加速度约束
  let r = core.solveAll(mkMeta([1, 1], [[0, -96], [1, 96]], [0], 2), Int16Array.from([0, 0]));
  ok(!r.ok, '相邻锁定差 192 > 12 → 无解');
  ok(r.conflicts.length === 1 && r.conflicts[0].frame === 1, '冲突定位到帧 1', r.conflicts);

  r = core.solveAll(mkMeta([1, 1, 1], [[0, 0], [1, -12], [2, 0]], [0], 3), Int16Array.from([0, 0, 0]));
  ok(!r.ok, 'd=-12,+12 加速度 24 > 2 → 无解');

  // 全片无解时不返回 partial exposure
  ok(r.exposure === null && r.objective === null, '无解时 exposure/objective 为 null');

  // 锁定值必须被精确采用
  const ml = mkMeta([1, 1, 1, 1], [[1, 3]], [0], 4);
  const rl = core.solveAll(ml, Int16Array.from([0, 0, 0, 0]));
  ok(rl.ok && rl.exposure[1] === 3, '锁定值精确采用');

  // 权重越大越贴近建议
  const mw = mkMeta([100, 1], [], [0], 2);
  const rw = core.solveAll(mw, Int16Array.from([0, 20]));
  ok(rw.ok && Math.abs(rw.exposure[0] - 0) <= Math.abs(rw.exposure[1] - 20), '高权重帧更贴近建议', Array.from(rw.exposure));

  // 单帧边界
  const m1 = mkMeta([5], [], [0], 1);
  const r1 = core.solveAll(m1, Int16Array.from([7]));
  ok(r1.ok && r1.exposure[0] === 7 && r1.objective === 0, '单帧片段直接等于建议');

  // 极值夹取
  const mEdge = mkMeta([1, 1, 1], [], [0], 3);
  const rEdge = core.solveAll(mEdge, Int16Array.from([96, 96, 96]));
  ok(rEdge.ok && Array.from(rEdge.exposure).every((e) => e <= 96), '建议格取 +96 时可解且不越界');

  // 与穷举对照（含同成本字典序）
  let bruteFails = 0;
  let seed = 4242;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  function brute(q, w, locks) {
    const L = q.length; const lk = new Map(locks);
    let best = Infinity; let seqBest = null; const seq = new Array(L);
    const dom = []; for (let e = -8; e <= 8; e++) dom.push(e);
    (function rec(k) {
      if (k === L) {
        let c = 0;
        for (let i = 0; i < L; i++) {
          if (lk.has(i) && lk.get(i) !== seq[i]) return;
          c += w[i] * (seq[i] - q[i]) ** 2;
          if (i > 0) {
            const d = seq[i] - seq[i - 1];
            if (Math.abs(d) > 12) return;
            if (i > 1 && Math.abs(d - (seq[i - 1] - seq[i - 2])) > 2) return;
          }
        }
        if (c < best) { best = c; seqBest = seq.slice(); }
        else if (c === best) {
          for (let i = 0; i < L; i++) {
            if (seq[i] < seqBest[i]) { seqBest = seq.slice(); break; }
            if (seq[i] > seqBest[i]) break;
          }
        }
        return;
      }
      for (const e of dom) { if (lk.has(k) && lk.get(k) !== e) continue; seq[k] = e; rec(k + 1); }
    })(0);
    return seqBest;
  }
  for (let t = 0; t < 250; t++) {
    const L = 1 + rnd(4);
    const q = Array.from({ length: L }, () => rnd(9) - 4);
    const w = Array.from({ length: L }, () => 1 + rnd(5));
    const nl = rnd(Math.min(L, 3) + 1);
    const frames = [];
    while (frames.length < nl) { const f = rnd(L); if (!frames.includes(f)) frames.push(f); }
    const locks = frames.map((f) => [f, q[f] + (rnd(3) - 1)]);
    const want = brute(q, w, locks);
    const got = core.solveAll(mkMeta(w, locks, [0], L), Int16Array.from(q));
    const gotSeq = got.ok ? Array.from(got.exposure) : null;
    if (!eq(gotSeq, want)) { bruteFails++; if (bruteFails <= 2) console.log('    差异:', { q, w, locks, gotSeq, want }); }
  }
  ok(bruteFails === 0, '250 组随机实例与穷举一致（含字典序同分）', bruteFails);

  // 多镜头穷举对照：切点两侧独立 + 全片字典序
  let multiFails = 0;
  let multiTried = 0;
  let seed2 = 777;
  const rnd2 = (n) => { seed2 = (seed2 * 1103515245 + 12345) >>> 0; return seed2 % n; };
  function bruteMulti(q, w, cuts, locks) {
    const L = q.length; const lk = new Map(locks);
    const shotOf = (i) => { let s = 0; for (let j = 0; j < cuts.length; j++) if (cuts[j] <= i) s = j; return s; };
    let best = Infinity; let seqBest = null; const seq = new Array(L);
    const dom = []; for (let e = -6; e <= 6; e++) dom.push(e);
    (function rec(k) {
      if (k === L) {
        let c = 0;
        for (let i = 0; i < L; i++) {
          if (lk.has(i) && lk.get(i) !== seq[i]) return;
          c += w[i] * (seq[i] - q[i]) ** 2;
          if (i > 0 && shotOf(i) === shotOf(i - 1)) {
            const d = seq[i] - seq[i - 1];
            if (Math.abs(d) > 12) return;
            if (i > 1 && shotOf(i - 1) === shotOf(i - 2) &&
                Math.abs(d - (seq[i - 1] - seq[i - 2])) > 2) return;
          }
        }
        if (c < best) { best = c; seqBest = seq.slice(); }
        else if (c === best) {
          for (let i = 0; i < L; i++) {
            if (seq[i] < seqBest[i]) { seqBest = seq.slice(); break; }
            if (seq[i] > seqBest[i]) break;
          }
        }
        return;
      }
      for (const e of dom) { if (lk.has(k) && lk.get(k) !== e) continue; seq[k] = e; rec(k + 1); }
    })(0);
    return seqBest;
  }
  for (let t = 0; t < 120; t++) {
    const L = 2 + rnd2(4); // 2..5
    const q = Array.from({ length: L }, () => rnd2(9) - 4);
    const w = Array.from({ length: L }, () => 1 + rnd2(5));
    const nCuts = 1 + rnd2(Math.min(2, L - 1));
    const cuts = [0];
    while (cuts.length < nCuts + 1) {
      const c = 1 + rnd2(L - 1);
      if (!cuts.includes(c)) { cuts.push(c); cuts.sort((a, b) => a - b); }
    }
    const nl = rnd2(3);
    const frames = [];
    while (frames.length < nl) { const f = rnd2(L); if (!frames.includes(f)) frames.push(f); }
    const locks = frames.map((f) => [f, q[f] + (rnd2(3) - 1)]);
    const want = bruteMulti(q, w, cuts, locks);
    const got = core.solveAll(mkMeta(w, locks, cuts, L), Int16Array.from(q));
    const gotSeq = got.ok ? Array.from(got.exposure) : null;
    multiTried++;
    if (!eq(gotSeq, want)) { multiFails++; if (multiFails <= 2) console.log('    多镜头差异:', { q, w, cuts, locks, gotSeq, want }); }
  }
  ok(multiFails === 0, multiTried + ' 组多镜头实例与穷举一致（切点独立 + 全片字典序）', multiFails);

  // 切点两侧独立：不切分时无解，切分后可解
  const noCut = core.solveAll(mkMeta([1, 1, 1, 1], [[1, -40], [2, 40]], [0], 4), Int16Array.from([0, 0, 0, 0]));
  ok(!noCut.ok, '不切分：相邻锁定 -40/+40 跨加速度约束无解');
  const withCut = core.solveAll(mkMeta([1, 1, 1, 1], [[1, -40], [2, 40]], [0, 2], 4), Int16Array.from([0, 0, 0, 0]));
  ok(withCut.ok && withCut.exposure[1] === -40 && withCut.exposure[2] === 40, '切分后两侧独立，各自精确取锁值');
}

/* ================= 4. SDR 渲染 ================= */
function testSdr(sample) {
  section('4. SDR 渲染（黄金哈希）');
  const npix = 48 * 24;
  for (const key of Object.keys(GOLD.sdr)) {
    const [f, e] = key.split(',').map(Number);
    const px = sample.pixels.subarray(f * npix * 3, (f + 1) * npix * 3);
    const out = new Uint8ClampedArray(npix * 4);
    core.renderFrameRGBA(px, npix, e, out);
    const h = crypto.createHash('sha256').update(Buffer.from(out)).digest('hex');
    ok(h === GOLD.sdr[key], '帧 ' + f + ' @ ' + e + ' 格 RGBA 哈希一致', h);
  }
  // 10000 尼特 PQ 白经 g=0.01 的色调映射后并不是 1.0（约 0.99），按约定不得强行拉到 255
  const white = new Uint16Array([1023, 1023, 1023]);
  const out = new Uint8ClampedArray(4);
  core.renderFrameRGBA(white, 1, 0, out);
  ok(out[0] === 254 && out[1] === 254 && out[2] === 254 && out[3] === 255, '万尼特白色调映射后为 254（未额外夹取）', Array.from(out));
  // 黑
  core.renderFrameRGBA(new Uint16Array([0, 0, 0]), 1, 0, out);
  ok(out[0] === 0 && out[1] === 0 && out[2] === 0, '黑电平为 0');
  // sRGB 曲线分段边界
  ok(Math.abs(core.srgbEncode(0.0031308) - 12.92 * 0.0031308) < 1e-12, 'sRGB 线性段边界连续');
  ok(Math.abs(core.srgbEncode(1) - 1) < 1e-12, 'sRGB 在 1 处为 1');
}

/* ================= 5. 曝光表 ================= */
function testTable(sample) {
  section('5. 曝光表');
  const v = core.validateTimeline(sample.tl);
  const st = core.computeStats(sample.pixels, 48, 24, 8);
  const res = core.solveAll(v.meta, st.suggested);
  const table = core.buildTable(v.meta, st, res.exposure);
  ok(table.frames.length === 8, '8 行');
  ok(eq(table.frames.map((f) => f.pts_us), sample.tl.pts_us), '原 PTS 逐帧保持不变');
  const dur = [];
  for (let i = 0; i < 8; i++) {
    dur.push((i + 1 < 8 ? sample.tl.pts_us[i + 1] : sample.tl.end_us) - sample.tl.pts_us[i]);
  }
  ok(eq(table.frames.map((f) => f.duration_us), dur), '帧持续时间保持（含末帧到 end_us）', table.frames.map((f) => f.duration_us));
  ok(eq(table.frames.map((f) => f.p95_millinit), GOLD.p95), 'P95 列');
  ok(eq(table.frames.map((f) => f.suggested), GOLD.suggested), '建议列');
  ok(eq(table.frames.map((f) => f.exposure), GOLD.exposure), '曝光列');
  ok(table.objective === GOLD.objective, 'objective 字段');
  const keys = Object.keys(table.frames[0]).sort();
  ok(eq(keys, ['duration_us', 'exposure', 'p95_millinit', 'pts_us', 'suggested']), '每项字段齐全', keys);
}

/* ================= 6. 性能 ================= */
async function testPerf() {
  section('6. 满预算性能（1800 帧 / 24.88M 像素）');
  const W = 144, H = 96, N = 1800;
  const total = W * H * N;
  ok(total <= core.MAX_PIXELS && N <= core.MAX_FRAMES, '构造的规模在上限内（' + total + ' px）');
  const px = new Uint16Array(W * H * 3 * N);
  let seed = 7;
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; px[i] = seed % 1024; }
  const meta = {
    width: W, height: H,
    pts_us: Array.from({ length: N }, (_, i) => i * 33367),
    end_us: N * 33367,
    cuts: [0, 268, 488, 758, 1115, 1214, 1237],
    weights: new Array(N).fill(1),
    locks: [[100, 0], [900, 0]],
  };
  const t0 = performance.now();
  const st = core.computeStats(px, W, H, N);
  const tStats = performance.now();
  const res = core.solveAll(meta, st.suggested);
  const tSolve = performance.now();
  const table = core.buildTable(meta, st, res.exposure);
  const tTable = performance.now();
  const totalMs = tTable - t0;
  ok(res.ok && table.frames.length === N, '满预算片段求解成功');
  ok(totalMs < 25000, '统计+求解+出表 ' + totalMs.toFixed(0) + ' ms < 25000 ms（Node）',
    { stats: +(tStats - t0).toFixed(0), solve: +(tSolve - tStats).toFixed(0), table: +(tTable - tSolve).toFixed(0) });
}

(async () => {
  console.log('PQ 曝光校片台 — 测试');
  const sample = await loadSample();
  await testZipAndValidate(sample);
  testStats(sample);
  testSolver(sample);
  testSdr(sample);
  testTable(sample);
  await testPerf();
  console.log('\n' + (failed ? '✗ ' + failed + ' 失败' : '✓ 全部通过') + '（' + passed + ' 项）');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
