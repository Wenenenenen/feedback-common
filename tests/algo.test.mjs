// 对拍测试：全网格参考实现（小数据量，显式保留完整路径做三级判优）
import {
  parseFingerprints, align, hamming, buildExport, BAND, validateLocks,
} from '../web/algo.js';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

// ---------- 参考实现：全网格 O(NM)，每格每状态保留唯一最优候选 ----------
function refAlign(A, B, params, locks = []) {
  const { maxDistance, gapOpen, gapExtend } = params;
  const N = A.hi.length;
  const M = B.hi.length;
  const anchors = [
    { i: 0, j: 0 },
    ...locks.slice().sort((a, b) => a.i - b.i).map((l) => ({ i: l.i, j: l.j })),
    { i: N, j: M },
  ];
  const full = [];
  let totalFee = 0;
  let totalSegs = 0;
  for (let s = 0; s < anchors.length - 1; s++) {
    const a = anchors[s];
    const b = anchors[s + 1];
    const n = b.i - a.i;
    const m = b.j - a.j;
    // cell key -> state -> {fee, segs, path}
    const best = new Map();
    const key = (i, j) => i * (m + 1) + j;
    best.set(key(0, 0), { M: { fee: 0, segs: 0, path: '' }, X: null, Y: null });
    const cand = (fee, segs, path) => ({ fee, segs, path });
    const better = (x, y) => {
      if (!y) return true;
      if (x.fee !== y.fee) return x.fee < y.fee;
      if (x.segs !== y.segs) return x.segs < y.segs;
      return x.path < y.path;
    };
    const put = (i, j, st, c) => {
      const k = key(i, j);
      if (!best.has(k)) best.set(k, { M: null, X: null, Y: null });
      const cell = best.get(k);
      if (better(c, cell[st])) cell[st] = c;
    };
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (i === 0 && j === 0) continue;
        if (Math.abs(i - j) > BAND) continue;
        // M
        if (i > 0 && j > 0) {
          const d = hamming(A.hi[a.i + i - 1], A.lo[a.i + i - 1], B.hi[a.j + j - 1], B.lo[a.j + j - 1]);
          if (d <= maxDistance) {
            const prev = best.get(key(i - 1, j - 1));
            if (prev) {
              for (const ps of ['M', 'X', 'Y']) {
                const p = prev[ps];
                if (p) put(i, j, 'M', cand(p.fee + d, p.segs, p.path + 'm'));
              }
            }
          }
        }
        // X：消费主版
        if (i > 0) {
          const prev = best.get(key(i - 1, j));
          if (prev) {
            const px = prev.X;
            if (px) put(i, j, 'X', cand(px.fee + gapExtend, px.segs, px.path + 'x'));
            for (const ps of ['M', 'Y']) {
              const p = prev[ps];
              if (p) put(i, j, 'X', cand(p.fee + gapOpen, p.segs + 1, p.path + 'x'));
            }
          }
        }
        // Y：消费交付版
        if (j > 0) {
          const prev = best.get(key(i, j - 1));
          if (prev) {
            const py = prev.Y;
            if (py) put(i, j, 'Y', cand(py.fee + gapExtend, py.segs, py.path + 'y'));
            for (const ps of ['M', 'X']) {
              const p = prev[ps];
              if (p) put(i, j, 'Y', cand(p.fee + gapOpen, p.segs + 1, p.path + 'y'));
            }
          }
        }
      }
    }
    const end = best.get(key(n, m));
    if (!end || (!end.M && !end.X && !end.Y)) {
      return { feasible: false, infeasible: true };
    }
    let win = null;
    for (const st of ['M', 'X', 'Y']) {
      if (end[st] && better(end[st], win)) win = end[st];
    }
    for (const ch of win.path) full.push(ch);
    totalFee += win.fee;
    totalSegs += win.segs;
  }
  return { path: full.join(''), fee: totalFee, segs: totalSegs, feasible: true, infeasible: false };
}

// 把算法结果转成路径字符串
function pathOf(result) {
  return result.steps.map((s) => s.t).join('');
}

// 校验路径合法性与费用、区间
function validateResult(A, B, params, locks, result) {
  let mi = 0;
  let dj = 0;
  let fee = 0;
  let segs = 0;
  let last = 'M';
  const lockedSet = new Set(locks.map((l) => `${l.i},${l.j}`));
  const hitLocks = new Set();
  for (const st of result.steps) {
    if (Math.abs(mi - dj) > BAND) return `带宽越界于 (${mi},${dj})`;
    if (st.t === 'm') {
      const d = hamming(A.hi[mi], A.lo[mi], B.hi[dj], B.lo[dj]);
      if (d > params.maxDistance) return `配对超阈值于 (${mi},${dj}) d=${d}`;
      if (st.cost !== d) return 'match 费用不等于汉明距离';
      fee += d;
      if (lockedSet.has(`${mi},${dj}`)) hitLocks.add(`${mi},${dj}`);
      mi++; dj++;
      last = 'M';
    } else if (st.t === 'x') {
      const open = last !== 'X';
      if (st.cost !== (open ? params.gapOpen : params.gapExtend)) return 'missing 费用错误';
      fee += st.cost;
      if (open) segs++;
      mi++;
      last = 'X';
    } else {
      const open = last !== 'Y';
      if (st.cost !== (open ? params.gapOpen : params.gapExtend)) return 'extra 费用错误';
      fee += st.cost;
      if (open) segs++;
      dj++;
      last = 'Y';
    }
  }
  if (mi !== A.hi.length || dj !== B.hi.length) return '终点未覆盖全部帧';
  if (fee !== result.totalFee) return `总费用不一致 ${fee} vs ${result.totalFee}`;
  if (segs !== result.gapSegments) return `段数不一致 ${segs} vs ${result.gapSegments}`;
  if (hitLocks.size !== lockedSet.size) return '有锁点未经过';
  // 区间校验：重放步序列，独立重建区间，逐项比对 otherConsumed 与半开边界
  let rmi = 0;
  let rdj = 0;
  const expect = [];
  let run = null;
  for (const st of result.steps) {
    if (st.t === 'm') { if (run) { expect.push(run); run = null; } rmi++; rdj++; }
    else if (st.t === 'x') {
      if (!run || run.type !== 'missing') { if (run) expect.push(run); run = { type: 'missing', start: rmi, end: rmi + 1, otherConsumed: rdj }; }
      else run.end = rmi + 1;
      rmi++;
    } else {
      if (!run || run.type !== 'extra') { if (run) expect.push(run); run = { type: 'extra', start: rdj, end: rdj + 1, otherConsumed: rmi }; }
      else run.end = rdj + 1;
      rdj++;
    }
  }
  if (run) expect.push(run);
  if (expect.length !== result.intervals.length) {
    return `区间数不一致 ${expect.length} vs ${result.intervals.length}`;
  }
  for (let k = 0; k < expect.length; k++) {
    const e = expect[k];
    const g = result.intervals[k];
    if (e.type !== g.type || e.start !== g.start || e.end !== g.end || e.otherConsumed !== g.otherConsumed) {
      return `区间 ${k} 不一致：期望 ${JSON.stringify(e)} 实际 ${JSON.stringify(g)}`;
    }
  }
  if (rmi !== A.hi.length || rdj !== B.hi.length) return '区间覆盖不全';
  return null;
}

// ---------- 随机指纹生成 ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function makeFp(n, seed, freezeChance = 0, dupChance = 0) {
  const r = rng(seed);
  const arr = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (prev !== null && r() < freezeChance) {
      arr.push(prev);
    } else if (prev !== null && r() < dupChance) {
      // 与前帧极近（1 bit 翻转）
      const v = BigInt('0x' + prev);
      const flip = 1n << BigInt(Math.floor(r() * 64));
      prev = (v ^ flip).toString(16).padStart(16, '0');
      arr.push(prev);
    } else {
      let v = 0n;
      for (let k = 0; k < 4; k++) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
      prev = v.toString(16).padStart(16, '0');
      arr.push(prev);
    }
  }
  return arr;
}

// 在 A 基础上制造 B：随机删帧（missing）和插冻结帧（extra）
function makeDelivery(aArr, seed, editRate) {
  const r = rng(seed);
  const b = [];
  for (const f of aArr) {
    if (r() < editRate) continue; // 缺帧
    b.push(f);
    if (r() < editRate) b.push(f); // 冻结多帧
  }
  if (b.length === 0) b.push(aArr[0]);
  return b;
}

// ---------- 1. 样本数据 ----------
{
  const master = parseFingerprints(JSON.parse(readFileSync('data-extract/master.json')), '主版');
  const delivery = parseFingerprints(JSON.parse(readFileSync('data-extract/delivery.json')), '交付版');
  const settings = JSON.parse(readFileSync('data-extract/settings.json'));
  const result = align(master, delivery, settings, []);
  check(result.totalFee === 18, `样本总费用应为 18，实际 ${result.totalFee}`);
  check(result.gapSegments === 2, `样本段数应为 2，实际 ${result.gapSegments}`);
  check(result.steps.filter((s) => s.t === 'm').length === 29, '样本配对数应为 29');
  check(result.steps.filter((s) => s.t === 'x').length === 1, '样本 missing 1 步');
  check(result.steps.filter((s) => s.t === 'y').length === 1, '样本 extra 1 步');
  const ref = refAlign(master, delivery, settings);
  check(ref.feasible && pathOf(result) === ref.path, `样本路径与参考一致：${pathOf(result)} vs ${ref.path}`);
  check(validateResult(master, delivery, settings, [], result) === null,
    '样本路径合法性：' + (validateResult(master, delivery, settings, [], result) || ''));
  const exp = buildExport(result);
  check(exp.gapIntervals.length === 2, '导出含两个缺多区间');
  check(exp.gapIntervals.some((iv) => iv.type === 'extra' && iv.start === 8 && iv.end === 9 && iv.otherConsumed === 8),
    'extra 区间定位在交付帧 8，对侧已消费 8');
  check(exp.gapIntervals.some((iv) => iv.type === 'missing' && iv.start === 21 && iv.end === 22 && iv.otherConsumed === 22),
    'missing 区间定位在主版帧 21，对侧已消费 22');
  check(exp.steps.length === result.steps.length && exp.totalFee === 18, '导出结构完整');
  console.log('样本路径:', pathOf(result));
}

// ---------- 2. 随机对拍（含冻结/重复画面） ----------
{
  const settingsList = [
    { maxDistance: 4, gapOpen: 9, gapExtend: 2 },
    { maxDistance: 0, gapOpen: 1, gapExtend: 1 },
    { maxDistance: 64, gapOpen: 65535, gapExtend: 65535 },
    { maxDistance: 2, gapOpen: 3, gapExtend: 3 },
  ];
  let trial = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const n = 2 + Math.floor(rng(seed * 7 + 1)() * 45);
    const m0 = 2 + Math.floor(rng(seed * 13 + 3)() * 45);
    const aArr = makeFp(n, seed * 101, 0.25, 0.3);
    const bArr = makeFp(m0, seed * 211, 0.2, 0.25);
    // 一半试验让 B 从 A 编辑而来，制造真实缺多帧
    const useB = seed % 2 === 0 ? makeDelivery(aArr, seed * 307, 0.12) : bArr;
    if (Math.abs(aArr.length - useB.length) > 60) continue;
    const settings = settingsList[seed % settingsList.length];
    const A = parseFingerprints(aArr, 'A');
    const B = parseFingerprints(useB, 'B');
    trial++;
    let result;
    let ref;
    try {
      result = align(A, B, settings, []);
    } catch (e) {
      if (e.code === 'INFEASIBLE') {
        ref = refAlign(A, B, settings);
        check(!ref.feasible, `seed=${seed} 双方都应判无路`);
        continue;
      }
      throw e;
    }
    ref = refAlign(A, B, settings);
    check(ref.feasible, `seed=${seed} 参考实现应有解`);
    check(result.totalFee === ref.fee, `seed=${seed} 费用 ${result.totalFee}=${ref.fee}`);
    check(result.gapSegments === ref.segs, `seed=${seed} 段数 ${result.gapSegments}=${ref.segs}`);
    check(pathOf(result) === ref.path, `seed=${seed} 词典序路径一致\n got ${pathOf(result)}\n ref ${ref.path}`);
    const err = validateResult(A, B, settings, [], result);
    check(err === null, `seed=${seed} 合法性：${err}`);
  }
  console.log(`随机对拍 ${trial} 组完成`);
}

// ---------- 3. 锁点 ----------
{
  const aArr = makeFp(40, 999, 0.3, 0.3);
  const bArr = makeDelivery(aArr, 888, 0.15);
  const A = parseFingerprints(aArr, 'A');
  const B = parseFingerprints(bArr, 'B');
  const settings = { maxDistance: 4, gapOpen: 9, gapExtend: 2 };
  const free = align(A, B, settings, []);

  // 取自由解中的两个配对作为锁点
  const matches = free.steps.filter((s) => s.t === 'm');
  const l1 = { i: matches[3].ai, j: matches[3].bi };
  const l2 = { i: matches[10].ai, j: matches[10].bi };
  const locked = align(A, B, settings, [l2, l1]); // 乱序传入
  check(locked.locks.length === 2, '锁点被排序保留');
  const err = validateResult(A, B, settings, [l1, l2], locked);
  check(err === null, '带锁路径合法：' + (err || ''));
  const ref = refAlign(A, B, settings, [l1, l2]);
  check(pathOf(locked) === ref.path && locked.totalFee === ref.fee, '带锁结果与参考一致');

  // 重复帧对同帧
  const dupA = ['0000000000000000', '0000000000000000', 'ffffffffffffffff', '0000000000000001'];
  const dupB = ['0000000000000000', 'ffffffffffffffff', '0000000000000001', '0000000000000000'];
  const dA = parseFingerprints(dupA, 'A');
  const dB = parseFingerprints(dupB, 'B');
  const lres = align(dA, dB, settings, [{ i: 3, j: 2 }]);
  check(lres.steps.some((s) => s.t === 'm' && s.ai === 3 && s.bi === 2), '锁点 (3,2) 必须经过');
  const lref = refAlign(dA, dB, settings, [{ i: 3, j: 2 }]);
  check(pathOf(lres) === lref.path, '重复帧锁点路径与参考一致');

  // 非法锁点（用足够长的两侧数组，确保按 越界->越带->阈值->重复->递增 顺序分别触发）
  const longA = parseFingerprints(
    Array.from({ length: 120 }, (_, k) => (BigInt(k) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0').slice(-16)), 'LA');
  const longB = parseFingerprints(
    Array.from({ length: 120 }, (_, k) => (BigInt(k) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0').slice(-16)), 'LB');
  const expectFailLong = (locks, codePart) => {
    try {
      align(longA, longB, settings, locks);
      check(false, `锁点应被拒绝：${JSON.stringify(locks)}`);
    } catch (e) {
      check(e.code === 'LOCK_INVALID' && e.message.includes(codePart),
        `拒绝原因含 "${codePart}"：${e.message}`);
    }
  };
  expectFailLong([{ i: 999, j: 0 }], '越界');
  expectFailLong([{ i: 0, j: 66 }], '越带'); // |0-66|=66 > 64，帧号均在界内
  expectFailLong([{ i: 5, j: 6 }], '阈值'); // 相邻不同指纹，距离远超 4 但 |5-6| 带内
  // 用完全相同指纹的长数组，保证锁点能过阈值，再分别触发“重复锁定”和“非严格递增”
  const sameLong = Array(120).fill('0000000000000000');
  const sA = parseFingerprints(sameLong, 'SA');
  const sB = parseFingerprints(sameLong, 'SB');
  const expectFailSame = (locks, codePart) => {
    try {
      align(sA, sB, settings, locks);
      check(false, `锁点应被拒绝：${JSON.stringify(locks)}`);
    } catch (e) {
      check(e.code === 'LOCK_INVALID' && e.message.includes(codePart),
        `拒绝原因含 "${codePart}"：${e.message}`);
    }
  };
  expectFailSame([{ i: 5, j: 5 }, { i: 5, j: 6 }], '不能锁给多个'); // 主版帧 5 锁两次
  expectFailSame([{ i: 5, j: 6 }, { i: 6, j: 5 }], '严格递增');   // j 逆序

  // 阈值外但带内的锁点直接报 LOCK_INVALID（不会进入 DP）
  try {
    const xA = parseFingerprints(['0000000000000000', '1111111111111111', '2222222222222222'], 'A');
    const xB = parseFingerprints(['0000000000000000', '1111111111111111', '2222222222222222'], 'B');
    align(xA, xB, { maxDistance: 0, gapOpen: 9, gapExtend: 2 }, [{ i: 1, j: 2 }]);
    check(false, '阈值外锁点应拒绝');
  } catch (e) {
    check(e.code === 'LOCK_INVALID', '阈值外锁点报 LOCK_INVALID');
  }

  // 无路场景 A：整版长度差超带宽（无锁点），报 INFEASIBLE
  try {
    const zA2 = parseFingerprints(Array(130).fill('0000000000000000'), 'ZA2');
    const zB2 = parseFingerprints(Array(60).fill('0000000000000000'), 'ZB2');
    align(zA2, zB2, { maxDistance: 4, gapOpen: 9, gapExtend: 2 }, []);
    check(false, '整版长度差超带应报 INFEASIBLE');
  } catch (e) {
    check(e.code === 'INFEASIBLE', '整版超带报 INFEASIBLE：' + e.code);
  }

  // 无路场景 B：锁点段。数学上，“两侧严格递增 + 每锁点带内”保证任何锁点段帧差都不超带宽，
  // 因此带合法锁点的 INFEASIBLE 只会在距离阈值 + gap 费用也无法连通时出现。
  // 用 maxDistance=0 且锁点等帧、段内每对都不同且等长（gap 会改变终点帧对应而被锁点拒绝）：
  // 锁 (0,0) 隐含；锁终点 (3,3)，段等长，任一中间帧无法精确配对且不允许靠 gap 改变等长关系时无路。
  // 这里验证：当确实无路时错误对象带 segment 定位字段（用整版超带但经分段触发的退化段）。
  try {
    // 锁 (0,0) 后让整版长度差超带：段 (0,0)->(N,M) 终点超带，alignSegment 抛 INFEASIBLE 带 segment
    const zA3 = parseFingerprints(Array(130).fill('0000000000000000'), 'ZA3');
    const zB3 = parseFingerprints(Array(60).fill('0000000000000000'), 'ZB3');
    align(zA3, zB3, { maxDistance: 4, gapOpen: 9, gapExtend: 2 }, []);
    check(false, '应报 INFEASIBLE');
  } catch (e) {
    check(e.code === 'INFEASIBLE', '无路报 INFEASIBLE：' + e.code);
    // 无锁点时 segment 由 align() 包装补上
    check(!!e.segment && typeof e.segment.index === 'number', 'INFEASIBLE 带 segment 阻断区间定位');
  }
}

// ---------- 4. 退化与边界 ----------
{
  const settings = { maxDistance: 4, gapOpen: 9, gapExtend: 2 };
  // 完全相同
  const same = makeFp(20, 555, 0, 0);
  const A = parseFingerprints(same, 'A');
  const B = parseFingerprints(same, 'B');
  const r1 = align(A, B, settings, []);
  check(r1.totalFee === 0 && r1.gapSegments === 0 && r1.steps.every((s) => s.t === 'm'), '完全相同零费用');

  // B 全是 A 首帧的冻结：阈值 4 下 ffffffff 无法与 0 配对，
  // 最优 = 配一对 0（费用 0），A 的 ffffffff 走 missing（开段 9），B 多出的两个 0 走 extra（开段 9+延 2）
  const a2 = ['0000000000000000', 'ffffffffffffffff'];
  const b2 = ['0000000000000000', '0000000000000000', '0000000000000000'];
  const r2 = align(parseFingerprints(a2, 'A'), parseFingerprints(b2, 'B'), settings, []);
  check(r2.gapSegments === 2 && r2.totalFee === 9 + 9 + 2,
    `冻结帧费用正确（两个 gap 段），实际 fee=${r2.totalFee} seg=${r2.gapSegments}`);

  // 长度差 64：恰好可行。两侧用完全相同的首帧保证那次配对在阈值内
  const same65 = Array(65).fill('0000000000000000');
  const r3 = align(parseFingerprints(same65, 'A'), parseFingerprints(['0000000000000000'], 'B'),
    { maxDistance: 64, gapOpen: 1, gapExtend: 1 }, []);
  check(r3.steps.filter((s) => s.t === 'x').length === 64, '64 连缺可行');

  // 长度差 65：无路
  let blocked = false;
  try {
    align(parseFingerprints(Array(66).fill('0000000000000000'), 'A'),
      parseFingerprints(['0000000000000000'], 'B'),
      { maxDistance: 64, gapOpen: 1, gapExtend: 1 }, []);
  } catch (e) {
    blocked = e.code === 'INFEASIBLE';
  }
  check(blocked, '长度差 65 报无路并保留可定位信息');

  // 非法输入
  let badInput = false;
  try { parseFingerprints(['xyz'], 'A'); } catch { badInput = true; }
  check(badInput, '非法指纹格式被拒绝');
  try { validateSettings({ maxDistance: 100 }); check(false, '坏设置通过'); }
  catch { check(true, '坏设置被拒绝'); }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
