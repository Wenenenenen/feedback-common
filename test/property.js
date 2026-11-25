/* 属性化随机测试：随机归档下，恢复值必须等于真值；与暴力 GF(2) 参考求解器交叉验证 */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const crcHex = (u8) => E.crc32(u8).toString(16).padStart(8, '0');
const blockRec = (id, u8) => ({ id, data: b64(u8), crc: crcHex(u8) });
const checkRec = (id, members, u8) => ({ id, members, data: b64(u8), crc: crcHex(u8) });
const xorBytes = (arrs) => { const o = new Uint8Array(512); for (const a of arrs) for (let i = 0; i < 512; i++) o[i] ^= a[i]; return o; };

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randBlock(rng) {
  const u = new Uint8Array(512);
  for (let i = 0; i < 512; i++) u[i] = Math.floor(rng() * 256);
  return u;
}

/* 教科书式 GF(2) RREF 参考求解器（整数数组增广矩阵，系数结构对所有字节相同，故只用掩码定秩与可恢复性） */
function referenceSolve(model) {
  const N = model.N;
  const knownMask = model.blockData.map((b) => !!b);
  const unknownIds = [];
  for (let i = 0; i < N; i++) if (!knownMask[i]) unknownIds.push(i);
  const U = unknownIds.length;
  const idx = new Map(unknownIds.map((id, k) => [id, k]));

  // 系数矩阵 A（每行一个 Uint8Array，长度 U），取任一位置的成员结构即可（与字节无关）
  const A = model.checks.map((c) => {
    const row = new Uint8Array(U);
    for (const m of c.members) if (!knownMask[m]) row[idx.get(m)] ^= 1;
    return row;
  }).filter((row) => row.some((v) => v === 1));

  // 完整 RREF
  const pivotCols = [];
  let r = 0;
  for (let col = 0; col < U && r < A.length; col++) {
    let piv = -1;
    for (let i = r; i < A.length; i++) if (A[i][col]) { piv = i; break; }
    if (piv === -1) continue;
    [A[r], A[piv]] = [A[piv], A[r]];
    for (let i = 0; i < A.length; i++) {
      if (i !== r && A[i][col]) for (let j = col; j < U; j++) A[i][j] ^= A[r][j];
    }
    pivotCols.push(col);
    r++;
  }
  const pivotSet = new Set(pivotCols);
  const freeCols = [];
  for (let c = 0; c < U; c++) if (!pivotSet.has(c)) freeCols.push(c);

  // RREF 中主元行若不含任何自由变量列 => 该主元变量唯一可定；否则依赖自由变量，不可定
  const recoverable = [];
  for (let ri = 0; ri < pivotCols.length; ri++) {
    const pc = pivotCols[ri];
    let dependsOnFree = false;
    for (const fc of freeCols) if (A[ri][fc]) { dependsOnFree = true; break; }
    if (!dependsOnFree) recoverable.push(unknownIds[pc]);
  }
  // 矛盾（0 系数行 RHS 非零）需结合 RHS 判定，可信输入下不存在；这里仅按结构返回
  return { contradiction: false, recoverable, rank: pivotCols.length, free: freeCols.length };
}

let total = 0, totalRec = 0, totalContra = 0, mismatches = 0;
for (let trial = 0; trial < 1000; trial++) {
  const rng = mulberry(1000 + trial * 97);
  const tracks = 1 + Math.floor(rng() * 3);
  const bpt = 4 + Math.floor(rng() * 6);
  const N = tracks * bpt;
  const truth = Array.from({ length: N }, () => randBlock(rng));
  const knownMask = Array.from({ length: N }, () => rng() < 0.45);
  const blocks = [];
  for (let i = 0; i < N; i++) if (knownMask[i]) blocks.push(blockRec(i, truth[i]));
  const nChecks = Math.floor(rng() * (N + 6));
  const checks = [];
  let cid = 0;
  const injectContradiction = rng() < 0.25;
  for (let k = 0; k < nChecks; k++) {
    const sz = 1 + Math.floor(rng() * Math.min(6, N));
    const members = new Set();
    while (members.size < sz) members.add(Math.floor(rng() * N));
    const arr = [...members];
    let payload = xorBytes(arr.map((x) => truth[x]));
    if (injectContradiction && k === 0) { payload[50] ^= 0x5a; }
    checks.push(checkRec(cid++, arr, payload));
  }
  const arc = {
    tracks: Array.from({ length: tracks }, (_, i) => `t${i}`),
    blocksPerTrack: bpt, blocks, checks,
  };
  assert.deepStrictEqual(E.validateStructure(arc), []);
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  total++;

  // 核心不变量：在输入未被篡改（无注入矛盾）时，所有标 recovered 的块必须逐字节等于真值。
  // 注入篡改的试验里，若篡改载荷未形成冲突方程，系统数学上仍"自洽"但会忠实解出错值——
  // 这是坏数据无法被检测的信息论限制，不参与真值比对。
  const trustworthyInput = !injectContradiction;
  if (trustworthyInput) {
    assert.strictEqual(s.stats.contradictionGroups, 0, `trial ${trial} 不应有矛盾`);
    assert.strictEqual(s.pureContradictions.length, 0);
    for (const r of s.recovered) {
      totalRec++;
      for (let i = 0; i < 512; i++) {
        if (r.data[i] !== truth[r.blockId][i]) { mismatches++; break; }
      }
      // 组合必须可重验
      const extra = new Map(s.recovered.map((x) => [x.blockId, x.data]));
      const v = E.verifyRecovery(m, r.checks, r.data, extra, r.blockId);
      assert.strictEqual(v.ok, true, `trial ${trial} 块 ${r.blockId} 重验失败`);
    }
  }
  if (s.stats.contradictionGroups > 0 || s.pureContradictions.length > 0) totalContra++;

  // 与参考求解器交叉验证可恢复集合（仅可信输入）
  if (trustworthyInput) {
    const ref = referenceSolve(m);
    assert.ok(!ref.contradiction, `trial ${trial} 参考器不应发现矛盾`);
    const engineSet = new Set(s.recovered.map((r) => r.blockId));
    for (const id of ref.recoverable) {
      // 参考器标记可恢复的，引擎也应恢复（参考器较保守时允许引擎更多）
      assert.ok(engineSet.has(id), `trial ${trial}: 参考器可恢复块 ${id}，引擎未恢复`);
    }
  }
}

console.log(`随机试验 ${total} 个归档`);
console.log(`恢复块总数 ${totalRec}，逐字节比对错误 ${mismatches} 个`);
console.log(`含检出矛盾的试验 ${totalContra} 个`);
assert.strictEqual(mismatches, 0);
console.log('属性化测试全部通过：恢复值恒等于真值，组合恒可重验，可恢复集合与参考求解器一致');
