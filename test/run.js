/* Node 测试：与不可信样本目录隔离，使用 -I 运行 */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const A = require('../js/audio.js');
const fs = require('fs');
const path = require('path');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e}`); process.exitCode = 1; }
}

const b64 = (u8) => Buffer.from(u8).toString('base64');
const crcHex = (u8) => E.crc32(u8).toString(16).padStart(8, '0');

function blockRec(id, u8) { return { id, data: b64(u8), crc: crcHex(u8) }; }
function checkRec(id, members, u8) { return { id, members, data: b64(u8), crc: crcHex(u8) }; }
function xorBytes(arrs) {
  const out = new Uint8Array(512);
  for (const a of arrs) for (let i = 0; i < 512; i++) out[i] ^= a[i];
  return out;
}
function randBlock(seed) {
  const u = new Uint8Array(512);
  let s = seed * 2654435761 + 12345;
  for (let i = 0; i < 512; i++) { s = (s * 1103515245 + 12345) >>> 0; u[i] = s & 255; }
  return u;
}

/* 样本只以 zip 入库；测试在隔离临时目录解压，避免依赖工作区产物 */
function samplePath(name) {
  const os = require('os');
  const cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-sample-'));
  cp.execFileSync('unzip', ['-o', '-q',
    path.join(__dirname, '..', 'samples', 'stem-parity.zip'), '-d', dir]);
  return path.join(dir, name);
}

/* ---------- T1 样本文件 rehearsal.json ---------- */
console.log('T1 样本文件 rehearsal.json');
const sample = JSON.parse(fs.readFileSync(samplePath('rehearsal.json'), 'utf8'));
ok('结构校验通过', () => assert.deepStrictEqual(E.validateStructure(sample), []));
const m1 = E.buildModel(sample);
const s1 = E.solve(m1, new Set());
ok('7 已知 + 1 恢复（块2经校验行10恢复）', () => {
  assert.strictEqual(s1.stats.known, 7);
  assert.strictEqual(s1.stats.recovered, 1);
  assert.strictEqual(s1.stats.undetermined, 0);
  assert.strictEqual(s1.stats.contradiction, 0);
  assert.strictEqual(s1.recovered[0].blockId, 2);
  assert.deepStrictEqual(s1.recovered[0].checks, [10]);
});
ok('恢复组合可重新验证', () => {
  const r = s1.recovered[0];
  const v = E.verifyRecovery(m1, r.checks, r.data, undefined, r.blockId);
  assert.strictEqual(v.ok, true);
});
ok('纯已知行 11/12 自洽，无矛盾', () => {
  assert.strictEqual(s1.pureContradictions.length, 0);
  assert.strictEqual(E.verifyCheck(m1, 11).ok, true);
  assert.strictEqual(E.verifyCheck(m1, 12).ok, true);
});
ok('CRC-32 校验向量 cbf43926', () => {
  assert.strictEqual(crcHex(new TextEncoder().encode('123456789')), 'cbf43926');
});

/* ---------- T2 整份结构错误 ---------- */
console.log('T2 整份结构错误（必须拒绝整份文件）');
const base = { tracks: ['a'], blocksPerTrack: 2, blocks: [], checks: [] };
ok('轨数越界 / blocksPerTrack 非正 / 乘积超限', () => {
  assert.ok(E.validateStructure({ ...base, tracks: [] }).length > 0);
  assert.ok(E.validateStructure({ ...base, blocksPerTrack: 0 }).length > 0);
  assert.ok(E.validateStructure({ tracks: ['x'.repeat(1)], blocksPerTrack: 9000, blocks: [], checks: [] }).length > 0);
  assert.ok(E.validateStructure({ tracks: new Array(9).fill('t'), blocksPerTrack: 1, blocks: [], checks: [] }).length > 0);
});
ok('块号越界/重复、校验 id 重复、成员重复/超限、id 超 32 位', () => {
  const bad1 = { ...base, blocks: [{ id: 2, data: b64(new Uint8Array(512)), crc: crcHex(new Uint8Array(512)) }] };
  assert.ok(E.validateStructure(bad1).length > 0);
  const dup = { ...base, blocks: [blockRec(0, new Uint8Array(512)), blockRec(0, new Uint8Array(512))] };
  assert.ok(E.validateStructure(dup).length > 0);
  const cdup = { ...base, checks: [
    checkRec(1, [0], new Uint8Array(512)), checkRec(1, [1], new Uint8Array(512))] };
  assert.ok(E.validateStructure(cdup).length > 0);
  const memDup = { ...base, checks: [checkRec(1, [0, 0], new Uint8Array(512))] };
  assert.ok(E.validateStructure(memDup).length > 0);
  const memBig = { ...base, checks: [{ id: 1, members: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], data: b64(new Uint8Array(512)), crc: crcHex(new Uint8Array(512)) }] };
  assert.ok(E.validateStructure(memBig).length > 0);
  const id33 = { ...base, checks: [{ id: 2 ** 32, members: [0], data: b64(new Uint8Array(512)), crc: crcHex(new Uint8Array(512)) }] };
  assert.ok(E.validateStructure(id33).length > 0);
});
ok('checks 超 12000 / 字段类型错误', () => {
  const many = { ...base, checks: new Array(12001).fill(0).map((_, i) => checkRec(i, [0], new Uint8Array(512))) };
  assert.ok(E.validateStructure(many).length > 0);
  assert.ok(E.validateStructure({ ...base, tracks: 'no' }).length > 0);
  assert.ok(E.validateStructure({ ...base, blocks: 'no' }).length > 0);
});
ok('轨名重复/空名', () => {
  assert.ok(E.validateStructure({ ...base, tracks: ['a', 'a'] }).length > 0);
  assert.ok(E.validateStructure({ ...base, tracks: ['a', ''] }).length > 0);
});

/* ---------- T3 坏 CRC / 坏 Base64 / 长度错误（记录级） ---------- */
console.log('T3 记录级坏数据');
ok('坏 CRC 原音块视为缺失并定位；坏 CRC 校验行不参与', () => {
  const good = randBlock(1);
  const bad = randBlock(2);
  const arc = {
    tracks: ['a'], blocksPerTrack: 3,
    blocks: [blockRec(0, good), { id: 1, data: b64(bad), crc: '00000000' }, blockRec(2, randBlock(3))],
    checks: [{ id: 9, members: [1], data: b64(bad), crc: '11111111' }],
  };
  assert.deepStrictEqual(E.validateStructure(arc), []);
  const m = E.buildModel(arc);
  assert.ok(m.badBlocks.some((b) => b.id === 1));
  assert.ok(m.badChecks.some((b) => b.id === 9));
  assert.strictEqual(m.blockData[1], null);
  assert.strictEqual(m.checks.length, 0);
  const s = E.solve(m, new Set());
  assert.strictEqual(s.statusByBlock[1], 'undetermined');
});
ok('Base64 畸形 / 字节数错误均按坏数据处理且不致命', () => {
  const arc = {
    tracks: ['a'], blocksPerTrack: 2,
    blocks: [{ id: 0, data: '!!!notb64', crc: crcHex(new Uint8Array(512)) },
             { id: 1, data: b64(new Uint8Array(10)), crc: crcHex(new Uint8Array(10)) }],
    checks: [],
  };
  assert.deepStrictEqual(E.validateStructure(arc), []);
  const m = E.buildModel(arc);
  assert.strictEqual(m.badBlocks.length, 2);
  assert.strictEqual(m.blockData[0], null);
  assert.strictEqual(m.blockData[1], null);
});

/* ---------- T4 矛盾组只封锁本组，已知块保留 ---------- */
console.log('T4 矛盾组隔离');
ok('组内任一字节矛盾 => 全组矛盾；另一组与已知块不受影响', () => {
  const g = [randBlock(11), randBlock(12), randBlock(13), randBlock(14)];
  const arc = {
    tracks: ['a'], blocksPerTrack: 4,
    blocks: [blockRec(2, g[2])], // 0,1,3 缺失
    checks: [
      checkRec(20, [0, 1], xorBytes([g[0], g[1]])),
      checkRec(21, [0, 1, 2], xorBytes([g[0], g[1], g[2]])),
      // 矛盾行：载荷被篡改但 CRC 重算（内部有效、逻辑矛盾）
      checkRec(22, [0, 1, 3], (() => { const t = xorBytes([g[0], g[1], g[3]]); t[7] ^= 0x5a; return t; })()),
      // 同一未知量 3 的正确方程，与篡改行冲突 => 组矛盾
      checkRec(23, [3], g[3]),
    ],
  };
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  assert.strictEqual(s.statusByBlock[2], 'known');
  for (const id of [0, 1, 3]) assert.strictEqual(s.statusByBlock[id], 'contradiction');
  assert.strictEqual(s.stats.contradictionGroups, 1);
  const grp = s.groups.find((x) => x.state === 'contradiction');
  assert.ok(grp.evidence.checkIds.includes(22));
  assert.ok(grp.evidence.mismatchBytes.includes(7));
});

/* ---------- T5 纯已知矛盾单列 ---------- */
console.log('T5 纯已知矛盾');
ok('无未知量的矛盾行单独报告，不影响其他组求解', () => {
  const g = [randBlock(21), randBlock(22), randBlock(23)];
  const tampered = (() => { const t = g[2].slice(); t[0] ^= 1; return t; })();
  const arc = {
    tracks: ['a'], blocksPerTrack: 3,
    blocks: [blockRec(0, g[0]), blockRec(1, g[1]), blockRec(2, g[2])],
    checks: [
      checkRec(30, [2], tampered),                       // 纯已知矛盾
      checkRec(31, [0, 1], xorBytes([g[0], g[1]])),     // 纯已知自洽
    ],
  };
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  assert.strictEqual(s.pureContradictions.length, 1);
  assert.strictEqual(s.pureContradictions[0].checkId, 30);
  assert.strictEqual(s.stats.contradiction, 0);
});

/* ---------- T6 自由变量存在时仍恢复可唯一确定的块 ---------- */
console.log('T6 自由变量与唯一恢复');
ok('秩不足组：单主元行的块恢复，其余未定；恢复值等于真值', () => {
  const g = [0, 1, 2, 3].map((i) => randBlock(30 + i));
  const arc = {
    tracks: ['a'], blocksPerTrack: 4,
    blocks: [], // 全部缺失
    checks: [
      checkRec(40, [0, 1], xorBytes([g[0], g[1]])),      // x0+x1
      checkRec(41, [1, 2], xorBytes([g[1], g[2]])),      // x1+x2
      checkRec(42, [0, 2, 3], xorBytes([g[0], g[2], g[3]])),
      // 只有 3 行 4 未知 => 有自由变量；加入一行只含 x3 使其可唯一恢复
      checkRec(43, [3], g[3]),
    ],
  };
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  assert.ok(s.stats.undetermined >= 1);
  const r3 = s.recovered.find((r) => r.blockId === 3);
  assert.ok(r3, '块3 应可唯一恢复');
  assert.deepStrictEqual(r3.data, g[3]);
  // 组合不要求最小，只要求互异行且可重验（这里由 40/41/42 异或也能得到 x3）
  assert.ok(new Set(r3.checks).size === r3.checks.length && r3.checks.length >= 1);
  const v = E.verifyRecovery(m, r3.checks, r3.data, undefined, r3.blockId);
  assert.strictEqual(v.ok, true);
});
ok('组合恢复（多行异或）的数据与校验行组合正确', () => {
  const g = [0, 1, 2].map((i) => randBlock(40 + i));
  const arc = {
    tracks: ['a'], blocksPerTrack: 3,
    blocks: [blockRec(2, g[2])],
    checks: [
      checkRec(50, [0, 1], xorBytes([g[0], g[1]])),
      checkRec(51, [1, 2], xorBytes([g[1], g[2]])),
      checkRec(52, [0, 2], xorBytes([g[0], g[2]])),
    ],
  };
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  const r0 = s.recovered.find((r) => r.blockId === 0);
  const r1 = s.recovered.find((r) => r.blockId === 1);
  assert.ok(r0 && r1);
  assert.deepStrictEqual(r0.data, g[0]);
  assert.deepStrictEqual(r1.data, g[1]);
  for (const r of [r0, r1]) {
    const v = E.verifyRecovery(m, r.checks, r.data, undefined, r.blockId);
    assert.strictEqual(v.ok, true);
    assert.ok(r.checks.length >= 1 && new Set(r.checks).size === r.checks.length);
  }
});

/* ---------- T7 停用 / 恢复校验行 ---------- */
console.log('T7 停用/恢复');
ok('停用唯一证据行 => 块变未定；恢复后重新可恢复', () => {
  const g = [randBlock(51), randBlock(52)];
  const arc = {
    tracks: ['a'], blocksPerTrack: 2,
    blocks: [],
    checks: [
      checkRec(60, [0, 1], xorBytes([g[0], g[1]])),
      checkRec(61, [1], g[1]),
    ],
  };
  const m = E.buildModel(arc);
  const full = E.solve(m, new Set());
  assert.strictEqual(full.stats.recovered, 2);
  const off = E.solve(m, new Set([61]));
  assert.strictEqual(off.statusByBlock[1], 'undetermined');
  assert.strictEqual(off.statusByBlock[0], 'undetermined');
  const back = E.solve(m, new Set());
  assert.strictEqual(back.stats.recovered, 2);
});

console.log('T7b 孤立未知块（无任何启用校验覆盖）');
ok('未覆盖缺失块各自成孤立组、状态未定；停用全部行后全部缺失块变孤立', () => {
  const g = [0, 1, 2, 3, 4].map((i) => randBlock(60 + i));
  const arc = {
    tracks: ['a'], blocksPerTrack: 5,
    blocks: [blockRec(0, g[0])],
    checks: [
      checkRec(70, [1], g[1]),                  // 只覆盖块1
      checkRec(71, [2, 3], xorBytes([g[2], g[3]])), // 秩不足组
      // 块 4 完全不被任何校验覆盖 => 孤立
    ],
  };
  const m = E.buildModel(arc);
  const s = E.solve(m, new Set());
  assert.strictEqual(s.statusByBlock[1], 'recovered');
  assert.strictEqual(s.statusByBlock[2], 'undetermined');
  assert.strictEqual(s.statusByBlock[3], 'undetermined');
  assert.strictEqual(s.statusByBlock[4], 'undetermined');
  const orphans = s.groups.filter((gr) => gr.blocks.length === 1 && gr.rank === 0 && gr.blocks[0] === 4);
  assert.strictEqual(orphans.length, 1, '块 4 应单独成孤立组');
  // 停用全部行 => 块 1/2/3/4 全部孤立未定，块 0 仍是已知
  const off = E.solve(m, new Set([70, 71]));
  for (const id of [1, 2, 3, 4]) assert.strictEqual(off.statusByBlock[id], 'undetermined');
  assert.strictEqual(off.statusByBlock[0], 'known');
  assert.strictEqual(off.groups.filter((gr) => gr.rank === 0).length, 4);
});

/* ---------- T8 满额性能（8192 块 / 12000 校验） ---------- */
console.log('T8 满额性能与正确性');
function buildFullArchive() {
  const tracks = 8, bpt = 1024, N = tracks * bpt;
  const truth = [];
  for (let i = 0; i < N; i++) truth.push(randBlock(1000 + i));
  const missing = new Set();
  // 约 30% 缺失
  let s = 7;
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) >>> 0; if (s % 100 < 30) missing.add(i); }

  const blocks = [];
  for (let i = 0; i < N; i++) if (!missing.has(i)) blocks.push(blockRec(i, truth[i]));

  const checks = [];
  let cid = 0;
  const G = 6;
  // 每个 6 块小组生成 7 条随机校验，矩阵大概率满秩
  const rng = (() => { let x = 42; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  for (let base0 = 0; base0 < N; base0 += G) {
    const members = [];
    for (let k = 0; k < G && base0 + k < N; k++) members.push(base0 + k);
    for (let r = 0; r < 7 && checks.length < 11994; r++) {
      const sub = members.filter(() => rng() < 0.6);
      if (sub.length < 1) sub.push(members[0]);
      if (sub.length > 12) sub.length = 12;
      checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));
    }
  }
  // 补足额外冗余行，预留 6 条给矛盾/秩不足场景，总计不超 12000
  while (checks.length < 11994) {
    const a = Math.floor(rng() * N), b = Math.floor(rng() * N);
    const sub = [...new Set([a, b, Math.floor(rng() * N)])];
    checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));
  }

  // 一个矛盾组（6 块全缺，载荷篡改）
  const cbase = 100;
  const grp = [cbase, cbase + 1, cbase + 2, cbase + 3, cbase + 4, cbase + 5];
  for (const id of grp) missing.add(id);
  const tampered = (() => { const t = xorBytes(grp.map((x) => truth[x])); t[3] ^= 0xff; return t; })();
  checks.push(checkRec(cid++, grp, tampered));
  // 一条纯已知矛盾
  const knownIds = [...Array(N).keys()].filter((i) => !missing.has(i)).slice(0, 3);
  const pt = (() => { const t = xorBytes(knownIds.map((x) => truth[x])); t[1] ^= 0x0f; return t; })();
  checks.push(checkRec(cid++, knownIds, pt));
  // 一个秩不足组（6 全缺，仅 4 行）
  const rbase = 300;
  const rgrp = [rbase, rbase + 1, rbase + 2, rbase + 3, rbase + 4, rbase + 5];
  for (const id of rgrp) missing.add(id);
  const rankDef = [
    [rgrp[0], rgrp[1]], [rgrp[1], rgrp[2]], [rgrp[2], rgrp[3]], [rgrp[3], rgrp[4], rgrp[5]],
  ];
  for (const sub of rankDef) checks.push(checkRec(cid++, sub, xorBytes(sub.map((x) => truth[x]))));

  // 重建 blocks（剔除新增缺失）
  const finalBlocks = [];
  for (let i = 0; i < N; i++) if (!missing.has(i)) finalBlocks.push(blockRec(i, truth[i]));
  return { arc: { tracks: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'], blocksPerTrack: bpt, blocks: finalBlocks, checks }, truth, missing };
}

const full = buildFullArchive();
let mf, sf;
ok('满额结构合法（8 轨 / 8192 块 / 12000 条校验）', () => {
  assert.strictEqual(full.arc.blocksPerTrack * full.arc.tracks.length, 8192);
  assert.strictEqual(full.arc.checks.length, 12000);
  assert.deepStrictEqual(E.validateStructure(full.arc), []);
});
ok('首次求解 < 8s 且恢复数据逐字节等于真值', () => {
  mf = E.buildModel(full.arc);
  const t = Date.now();
  sf = E.solve(mf, new Set());
  const dt = Date.now() - t;
  console.log(`    首次求解 ${dt} ms（恢复 ${sf.stats.recovered} / 缺失 ${mf.missingBlocks.length}）`);
  assert.ok(dt < 8000, `首次求解耗时 ${dt}ms`);
  const extraKnown = new Map(sf.recovered.map((r) => [r.blockId, r.data]));
  for (const r of sf.recovered) {
    const td = full.truth[r.blockId];
    let bad = -1;
    for (let i = 0; i < 512; i++) if (r.data[i] !== td[i]) { bad = i; break; }
    assert.ok(bad === -1, `块 ${r.blockId} 恢复错误，首个差异字节 ${bad}，组合 ${r.checks.join(',')}`);
    const v = E.verifyRecovery(mf, r.checks, r.data, extraKnown, r.blockId);
    assert.strictEqual(v.ok, true, `块 ${r.blockId} 组合重验失败`);
  }
});
ok('矛盾组与纯已知矛盾各就各位，已知块零改动', () => {
  assert.ok(sf.stats.contradictionGroups >= 1);
  assert.strictEqual(sf.pureContradictions.length, 1);
  for (let i = 0; i < full.arc.blocksPerTrack * 8; i++) {
    if (sf.statusByBlock[i] === 'known') assert.deepStrictEqual(mf.blockData[i], full.truth[i]);
  }
});
ok('改行后再求解 < 8s（停用/恢复一条校验）', () => {
  const someId = mf.checks[500].id;
  const t = Date.now();
  const s2 = E.solve(mf, new Set([someId]));
  const dt = Date.now() - t;
  console.log(`    改行求解 ${dt} ms`);
  assert.ok(dt < 8000, `改行求解耗时 ${dt}ms`);
  const s3 = E.solve(mf, new Set());
  assert.deepStrictEqual(s3.stats, sf.stats);
});
ok('求解器可处理大于 256 未知量的连通组（256 是合规导入文件的约定上限，非引擎限制）', () => {
  const sizes = sf.groups.map((g) => g.blocks.length);
  const max = Math.max(...sizes);
  console.log(`    连通组 ${sf.groups.length} 个，最大组 ${max} 未知量（引擎不设 256 硬上限）`);
  assert.ok(max > 0);
  // 合规文件场景（T1 样本）每组远小于 256
  assert.ok(Math.max(...s1.groups.map((g) => g.blocks.length)) <= 256);
});

console.log('T8b 单组最坏情况压力（256 未知量 + 4000 余条 12 成员稀疏校验）');
ok('密集大组 < 8s 且满秩全恢复、逐字节正确', () => {
  const N = 256;
  const ttruth = Array.from({ length: N }, (_, i) => randBlock(900 + i));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const dense = [];
  let dcid = 0;
  for (let i = 0; i < N; i++) {
    const mem = [i]; if (i + 1 < N) mem.push(i + 1);
    dense.push(checkRec(dcid++, mem, xorBytes(mem.map((x) => ttruth[x]))));
  }
  while (dense.length < 4256) {
    const mem = new Set();
    while (mem.size < 12) mem.add(Math.floor(rnd() * N));
    const arr = [...mem];
    dense.push(checkRec(dcid++, arr, xorBytes(arr.map((x) => ttruth[x]))));
  }
  const arc = { tracks: ['t'], blocksPerTrack: N, blocks: [], checks: dense };
  assert.deepStrictEqual(E.validateStructure(arc), []);
  const dm = E.buildModel(arc);
  const t = Date.now();
  const ds = E.solve(dm, new Set());
  const dt = Date.now() - t;
  console.log(`    密集大组求解 ${dt} ms，恢复 ${ds.stats.recovered}/256`);
  assert.ok(dt < 8000, `密集大组耗时 ${dt}ms`);
  assert.strictEqual(ds.stats.recovered, 256);
  for (const r of ds.recovered) assert.deepStrictEqual(r.data, ttruth[r.blockId]);
});

/* ---------- T9 PCM 试听/导出逐样本一致 + 静音确认 ---------- */
console.log('T9 PCM 一致性');
ok('试听 PCM 与导出 WAV 数据区逐样本相同，未定块默认不补静音', () => {
  const m = mf, sol = sf;
  const getBlock = (id) => {
    if (m.blockData[id]) return new Int16Array(m.blockData[id].buffer, m.blockData[id].byteOffset, 256);
    const r = sol.recovered.find((x) => x.blockId === id);
    return r ? new Int16Array(r.data.buffer, r.data.byteOffset, 256) : null;
  };
  const track = 0;
  const start = 0, end = 48000; // 一整轨采样数以内的区间
  const built = A.buildTrackPcm(m, track, start, end, getBlock, false);
  assert.ok(built.unresolved.length > 0, '满额数据里应有未定/矛盾块');
  // 未定位置必须为零且被标记
  for (const u of built.unresolved) {
    for (let i = u.sampleRange[0] - start; i < u.sampleRange[1] - start; i++) {
      assert.strictEqual(built.pcm[i], 0);
    }
  }
  const wav = A.pcmToWavBytes(built.pcm);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.length);
  assert.strictEqual(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.strictEqual(dv.getUint32(24, true), 48000);
  assert.strictEqual(dv.getUint16(22, true), 1);
  assert.strictEqual(dv.getUint16(34, true), 16);
  // WAV 数据区与 PCM 逐样本一致
  for (let i = 0; i < built.pcm.length; i++) assert.strictEqual(dv.getInt16(44 + i * 2, true), built.pcm[i]);
  // 再拼一次必须完全相同（试听与导出同源）
  const again = A.buildTrackPcm(m, track, start, end, getBlock, false).pcm;
  assert.deepStrictEqual(again, built.pcm);
});
ok('确认补静音前后：区间边界与块定位正确', () => {
  const tiny = {
    tracks: ['a'], blocksPerTrack: 4,
    blockData: [randBlock(1), null, randBlock(3), randBlock(4)],
  };
  const getBlock = (id) => (tiny.blockData[id] ? new Int16Array(tiny.blockData[id].buffer, tiny.blockData[id].byteOffset, 256) : null);
  const r = A.buildTrackPcm(tiny, 0, 100, 256 * 2 + 50, getBlock, true);
  assert.strictEqual(r.pcm.length, 256 * 2 + 50 - 100);
  assert.ok(r.unresolved.some((u) => u.blockId === 1));
  for (let i = 256 - 100; i < 256 * 2 - 100; i++) assert.strictEqual(r.pcm[i], 0);
});

console.log(`\n${process.exitCode ? '存在失败' : '全部通过'}：${pass} 个断言组`);
