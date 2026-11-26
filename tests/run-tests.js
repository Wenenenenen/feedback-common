/*
 * Node 无依赖测试台：精确数学、求解器、锁冲突、WAV 往返、ZIP 导入、60s 性能。
 * 运行：node tests/run-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'js', 'ccl-core.js'));
require(path.join(__dirname, '..', 'js', 'wav-codec.js'));
require(path.join(__dirname, '..', 'js', 'zip-read.js'));
const CCL = globalThis.CCL;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; failures.push(name); console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function eq(name, a, b) { ok(name, a === b, { a, b }); }

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- T1 插值 K = 公式 /128 ----------
console.log('\n[T1] 周期四点插值精确整数化');
{
  const rnd = mulberry(101);
  let good = true;
  for (let t = 0; t < 200000; t++) {
    const a = (rnd() * 65536 - 32768) | 0, b = (rnd() * 65536 - 32768) | 0;
    const c = (rnd() * 65536 - 32768) | 0, d = (rnd() * 65536 - 32768) | 0;
    for (let j = 0; j < 4; j++) {
      const s = j / 4;
      const direct = (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s
        + (-a + 3 * b - 3 * c + d) * s * s * s) / 2;
      const exact = CCL.interpK(a, b, c, d, j) / 128;
      if (direct !== exact && Math.abs(direct - exact) > 1e-9) { good = false; break; }
    }
    if (!good) break;
  }
  ok('20 万组随机码值 × 4 相位与浮点公式一致', good);
  ok('j=0 时插值严格等于 b（K=128b）', CCL.interpK(1, 12345, -9, 77, 0) === 128 * 12345);
  // 周期索引由调用方保证；这里验证 N=1 常数情形
  let constOk = true;
  for (let j = 0; j < 4; j++) if (CCL.interpK(777, 777, 777, 777, j) !== 128 * 777) constOk = false;
  ok('N=1 时四点全同 => 常数', constOk);
}

// ---------- T2 正中取偶 ----------
console.log('\n[T2] 精确四舍六入五成双');
{
  const D = 2 ** 23;
  eq('2.5 -> 2（偶数）', CCL.roundScaled(5 * 2 ** 22), 2);
  eq('3.5 -> 4（奇数进偶）', CCL.roundScaled(7 * 2 ** 22), 4);
  eq('-2.5 -> -2', CCL.roundScaled(-5 * 2 ** 22), -2);
  eq('-3.5 -> -4', CCL.roundScaled(-7 * 2 ** 22), -4);
  eq('2.4999999 -> 2', CCL.roundScaled(5 * 2 ** 22 - 1), 2);
  eq('2.5000001 -> 3', CCL.roundScaled(5 * 2 ** 22 + 1), 3);
  eq('整数 16000 精确', CCL.roundScaled(16000 * D), 16000);

  let mismatch = 0;
  for (let i = 0; i < 300000; i++) {
    const t = Math.floor((Math.random() * 2 - 1) * 4e12);
    const got = CCL.roundScaled(t);
    const bt = BigInt(t), BD = 8388608n;
    let neg = bt < 0n, x = neg ? -bt : bt;
    let q = x / BD, r = x - q * BD;
    if (r > BD / 2n || (r === BD / 2n && (q & 1n) === 1n)) q++;
    const exp = Number(neg ? -q : q);
    if (got !== exp) { mismatch++; if (mismatch < 4) console.log('   mismatch', t, got, exp); }
  }
  ok('30 万随机值与 BigInt 参考一致', mismatch === 0);
}

// ---------- T3 ceiling 帽 ----------
console.log('\n[T3] 每帧增益上限帽（舍入后检查）');
{
  let bad = 0;
  const rnd = mulberry(202);
  for (let t = 0; t < 500000; t++) {
    const K = (rnd() * 1.2e7 - 6e6) | 0;
    const C = (rnd() * 32768) | 0;
    const g = CCL.ceilingCapK(K, C);
    if (Math.abs(CCL.roundScaled(K * g)) > C) { bad++; if (bad <= 3) console.log('   invalid', K, C, g); }
    if (g < 65536 && Math.abs(CCL.roundScaled(K * (g + 1))) <= C) { bad++; if (bad <= 3) console.log('   not maximal', K, C, g); }
  }
  ok('50 万随机 (K,ceiling)：帽内合法且 +1 即越限', bad === 0);
  eq('K=0 时帽为 65536', CCL.ceilingCapK(0, 0), 65536);
}

// ---------- T4 传播求解器 ----------
console.log('\n[T4] 环上逐点最大传播');
function propagateOn2(hi, up, down) {
  const n = hi.length, g = new Array(n).fill(Infinity);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
    const f = (k - j + n) % n, b = (j - k + n) % n;
    g[k] = Math.min(g[k], hi[j] + up * f, hi[j] + down * b);
  }
  return g;
}
{
  let mismatch = 0, viol = 0;
  const rnd = mulberry(303);
  for (let it = 0; it < 20000; it++) {
    const n = 2 + ((rnd() * 30) | 0);
    const up = (rnd() * 8) | 0, down = (rnd() * 8) | 0;
    const hi = Array.from({ length: n }, () => (rnd() * 6) | 0);
    const got = CCL.propagateUpperBounds(Int32Array.from(hi), up, down);
    const exp = propagateOn2(hi, up, down);
    for (let k = 0; k < n; k++) {
      if (got[k] !== exp[k]) mismatch++;
      const nx = (k + 1) % n;
      if (got[nx] - got[k] > up || got[k] - got[nx] > down || got[k] > hi[k]) viol++;
    }
  }
  ok('2 万组随机环与 O(n²) 显式公式逐点相同', mismatch === 0);
  ok('全部满足升/降/上界（含首尾环边）', viol === 0);
}
// 穷举验证“逐点最大”
{
  function exhaustive(hi, up, down) {
    const n = hi.length, D = 4; let best = null; const g = new Array(n);
    (function rec(k) {
      if (k === n) {
        for (let i = 0; i < n; i++) { const nx = (i + 1) % n; if (g[nx] - g[i] > up || g[i] - g[nx] > down) return; }
        if (!best) best = g.slice(); else for (let i = 0; i < n; i++) best[i] = Math.max(best[i], g[i]);
        return;
      }
      for (let v = 0; v <= Math.min(D, hi[k]); v++) { g[k] = v; rec(k + 1); }
    })(0);
    return best;
  }
  let bad = 0;
  const rnd = mulberry(404);
  for (let it = 0; it < 3000; it++) {
    const n = 2 + ((rnd() * 5) | 0);
    const up = (rnd() * 3) | 0, down = (rnd() * 3) | 0;
    const hi = Array.from({ length: n }, () => (rnd() * 5) | 0);
    const got = CCL.propagateUpperBounds(Int32Array.from(hi), up, down);
    const exp = exhaustive(hi, up, down);
    for (let k = 0; k < n; k++) if (got[k] !== exp[k]) bad++;
  }
  ok('3000 个小系统与穷举所有增益组合得到的逐点最大解相同', bad === 0);
}

// ---------- T5 锁冲突 ----------
console.log('\n[T5] 锁与冲突语义');
{
  // n=10，up=down=1：帧0锁10、帧5锁0 -> 从5反向传播 5 步最多让0保持5，帧0不可达
  const caps = new Int32Array(10).fill(65536);
  const r = CCL.solveGains(caps, 1, 1, [[0, 10], [5, 0]]);
  ok('检测到 1 个冲突', !r.ok && r.conflicts.length === 1);
  eq('冲突帧为 0', r.conflicts[0] && r.conflicts[0].frame, 0);
  eq('帧0传播后最多 5', r.conflicts[0] && r.conflicts[0].achievable, 5);
  eq('帧5锁可达', r.gains[5], 0);

  // 兼容锁：距离足够
  const r2 = CCL.solveGains(caps, 10, 10, [[0, 10], [5, 0]]);
  ok('步率足够时无冲突且锁精确命中', r2.ok && r2.gains[0] === 10 && r2.gains[5] === 0);

  // ceiling 导致的不可达：ceiling=0 且该点 K!=0 => cap=0，锁100不可达（组合口径 A）
  const caps2 = new Int32Array(8).fill(65536);
  caps2[3] = 0;
  const r3 = CCL.solveGains(caps2, 100, 100, [[3, 100]]);
  ok('ceiling 帽低于锁目标 -> 组合传播列出该锁', !r3.ok && r3.conflicts.some((x) => x.frame === 3));
  // 约定字面“仅把锁当上限”口径：单锁无锁间冲突
  const lo = CCL.findLockOnlyConflicts(8, 100, 100, [[3, 100]]);
  ok('纯锁传播单锁无冲突（两种口径字段都保留）', lo.conflicts.length === 0);

  // 每帧至多一个锁：normalize 去重
  const nl = CCL.normalizeLocks([[2, 10], [2, 20]], 10);
  eq('重复帧归一为一个锁（后者覆盖）', nl.length, 1);
  eq('覆盖值为 20', nl[0].gain, 20);
}

// ---------- T6 真实案例 loop.wav + settings.json ----------
console.log('\n[T6] samples/loop.wav 端到端');
const wavPath = path.join(__dirname, '..', 'samples', 'loop.wav');
const zipPath = path.join(__dirname, '..', 'samples', 'cyclic-ceiling-cases.zip');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'settings.json'), 'utf8'));
let loopResult, decoded;
{
  const buf = fs.readFileSync(wavPath).buffer.slice(0);
  decoded = CCL.WAV.decodeWav(buf);
  eq('双声道', decoded.channels, 2);
  eq('48000 Hz', decoded.sampleRate, 48000);
  eq('PCM16', decoded.bitsPerSample, 16);
  eq('4800 基率帧', decoded.frames, 4800);

  const t0 = process.hrtime.bigint();
  loopResult = CCL.processCycle(
    { left: decoded.channelData[0], right: decoded.channelData[1], length: decoded.frames },
    settings
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  eq('输出 19200 帧 (4N)', loopResult.n, 19200);
  ok('默认设定无锁 => 可行', loopResult.ok === true);
  console.log('   loop 求解+逐码耗时', ms.toFixed(1), 'ms');

  let ceilViol = 0, slewViol = 0, rangeViol = 0, codeMismatch = 0;
  const { gains, caps, outL, outR, n, ceiling, up, down } = loopResult;
  const L = decoded.channelData[0], R = decoded.channelData[1], N = decoded.frames;
  for (let k = 0; k < n; k++) {
    if (gains[k] < 0 || gains[k] > 65536 || !Number.isInteger(gains[k])) rangeViol++;
    if (Math.abs(outL[k]) > ceiling || Math.abs(outR[k]) > ceiling) ceilViol++;
    const nx = (k + 1) % n;
    if (gains[nx] - gains[k] > up || gains[k] - gains[nx] > down) slewViol++;
  }
  // 独立按约定重算每个码
  for (let i = 0; i < N; i++) {
    const im = CCL.cycIdx(i - 1, N), i1 = CCL.cycIdx(i + 1, N), i2 = CCL.cycIdx(i + 2, N);
    for (let j = 0; j < 4; j++) {
      const k = 4 * i + j, g = gains[k];
      const eL = CCL.roundScaled(CCL.interpK(L[im], L[i], L[i1], L[i2], j) * g);
      const eR = CCL.roundScaled(CCL.interpK(R[im], R[i], R[i1], R[i2], j) * g);
      if (outL[k] !== eL || outR[k] !== eR) codeMismatch++;
      if (caps[k] > 65536) rangeViol++;
    }
  }
  eq('无越 ceiling 码', ceilViol, 0);
  eq('无升降幅违例（含首尾环边）', slewViol, 0);
  eq('增益全部为 0..65536 整数', rangeViol, 0);
  eq('全部输出码与独立重算逐码一致', codeMismatch, 0);

  // 逐点最大性抽查：对随机 200 点用 O(n²) 显式公式（ceiling 帽为上界）
  const rnd = mulberry(505);
  let maxBad = 0;
  for (let t = 0; t < 200; t++) {
    const k = (rnd() * n) | 0;
    let exp = Infinity;
    for (let j = 0; j < n; j++) {
      const f = (k - j + n) % n, b = (j - k + n) % n;
      exp = Math.min(exp, caps[j] + up * f, caps[j] + down * b);
    }
    if (gains[k] !== exp) maxBad++;
  }
  eq('200 随机点满足逐点最大显式解', maxBad, 0);
}

// ---------- T7 WAV 切片 / 整圈逐码一致 ----------
console.log('\n[T7] 192k WAV 编码与左闭右开切片');
{
  const { outL, outR, n } = loopResult;
  const full = CCL.WAV.encodeWav16([outL, outR], 192000);
  const back = CCL.WAV.decodeWav(full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength));
  eq('整圈编码后采样率 192000', back.sampleRate, 192000);
  eq('整圈编码后双声道', back.channels, 2);
  eq('整圈编码后帧数 n', back.frames, n);
  let mm = 0;
  for (let i = 0; i < n; i++) if (back.channelData[0][i] !== outL[i] || back.channelData[1][i] !== outR[i]) mm++;
  eq('整圈往返逐码一致', mm, 0);

  const s = 137, e = 4099;
  const slice = CCL.WAV.encodeWav16([outL, outR], 192000, s, e);
  const sb = CCL.WAV.decodeWav(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
  eq('切片帧数 = e-s（左闭右开）', sb.frames, e - s);
  let sm = 0;
  for (let i = s; i < e; i++) {
    if (sb.channelData[0][i - s] !== outL[i] || sb.channelData[1][i - s] !== outR[i]) sm++;
  }
  eq('切片与整圈对应区间逐码一致', sm, 0);

  // 整圈切片 [0,n) 与整圈导出字节完全相同
  const wholeSlice = CCL.WAV.encodeWav16([outL, outR], 192000, 0, n);
  ok('[0,n) 与整圈导出字节完全相同', Buffer.from(wholeSlice).equals(Buffer.from(full)));
}

// ---------- T8 ZIP 导入 ----------
console.log('\n[T8] cyclic-ceiling-cases.zip 读取');
(async () => {
  try {
    const zbuf = fs.readFileSync(zipPath);
    const entries = await CCL.Zip.unzip(zbuf.buffer.slice(zbuf.byteOffset, zbuf.byteOffset + zbuf.byteLength));
    const names = entries.map((e) => e.name);
    ok('包含 loop.wav / settings.json / 约定.txt',
      names.some((n) => /loop\.wav$/.test(n)) && names.some((n) => /settings\.json$/.test(n)) && names.some((n) => /约定\.txt$/.test(n)), names);
    const wavE = entries.find((e) => /loop\.wav$/.test(e.name));
    const disk = fs.readFileSync(wavPath);
    ok('ZIP 解出的 loop.wav 与目录副本字节一致', Buffer.from(wavE.bytes).equals(disk));
    const sj = JSON.parse(new TextDecoder().decode(entries.find((e) => /settings\.json$/.test(e.name)).bytes));
    eq('settings.ceiling=16000', sj.ceiling, 16000);
    eq('settings.up=30', sj.up, 30);
    eq('settings.down=120', sj.down, 120);
  } catch (e) {
    ok('ZIP 读取（当前 Node 支持 deflate-raw）: ' + e.message, false);
  }

  // ---------- T9 满长 60s 性能 ----------
  console.log('\n[T9] 60s 满长素材性能（提交 -> 增益曲线可得）');
  {
    const N = 60 * 48000; // 2,880,000
    const n = 4 * N;      // 11,520,000
    const rnd = mulberry(909);
    const left = new Int16Array(N), right = new Int16Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / 48000;
      // 类音乐信号 + 瞬态，覆盖各种帽
      left[i] = Math.max(-32768, Math.min(32767,
        12000 * Math.sin(2 * Math.PI * 110 * t) + 9000 * Math.sin(2 * Math.PI * 1760 * t) + (((rnd() * 4000) | 0) - 2000)));
      right[i] = Math.max(-32768, Math.min(32767,
        13000 * Math.sin(2 * Math.PI * 110.7 * t + 0.7) + 8000 * Math.sin(2 * Math.PI * 2200 * t) + (((rnd() * 4000) | 0) - 2000)));
    }
    // 选彼此兼容、且大概率高于这些帧 ceiling 帽需求的温和锁值
    const t0 = process.hrtime.bigint();
    const r = CCL.processCycle({ left, right, length: N },
      { ceiling: 12000, up: 40, down: 200, locks: [[0, 20000], [n - 100, 18000]] });
    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    ok('60s 处理成功（双锁可行）', r.ok === true, r.conflicts);
    eq('60s -> 11,520,000 帧', r.n, 11520000);
    let viol = 0;
    if (r.ok) for (let k = 0; k < n; k += 997) { // 抽样环约束
      const nx = (k + 1) % n;
      if (r.gains[nx] - r.gains[k] > 40 || r.gains[k] - r.gains[nx] > 200) viol++;
      if (Math.abs(r.outL[k]) > 12000 || Math.abs(r.outR[k]) > 12000) viol++;
    }
    eq('抽样无约束违例', viol, 0);
    console.log(`   60s 全链（caps+solve+逐码）耗时 ${totalMs.toFixed(0)} ms`);
    ok('提交到曲线可查 <= 12000 ms（Node 基准，浏览器另测）', totalMs < 12000, { totalMs });

    // 单独测纯求解（设定微调路径）
    const t1 = process.hrtime.bigint();
    CCL.solveGains(r.caps, 41, 201, []);
    const solveMs = Number(process.hrtime.bigint() - t1) / 1e6;
    console.log(`   60s 纯传播求解耗时 ${solveMs.toFixed(0)} ms`);
    ok('纯求解 < 4000 ms', solveMs < 4000, { solveMs });
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) { console.log('Failed:', failures); process.exit(1); }
})();
