// tests/pyramid.test.js — 金字塔区间统计 vs 暴力逐样本
import { SourcePyramid, LEAF } from '../js/pyramid.js';
import { makePcm, bruteStat, assert, assertEq, assertStat } from './helpers.js';

// 1. 小块 + 全区间（含不完整叶子、不完整父节点）
{
  const n = LEAF * 3 + 37;
  const pcm = makePcm(n, 42);
  const py = new SourcePyramid([pcm], n, 't');
  assertStat(py.query(0, 0, n), bruteStat(pcm, 0, n), '全区间（含碎块）');
  assertStat(py.query(0, 0, 0), null, '空区间返回 null');
}

// 2. 穷举所有对齐叶子边界的区间
{
  const n = LEAF * 6 + 5;
  const pcm = makePcm(n, 99);
  const py = new SourcePyramid([pcm], n, 't');
  let tested = 0;
  for (let a = 0; a <= n; a += LEAF) {
    for (let b = a; b <= n; b += LEAF) {
      assertStat(py.query(0, a, b), bruteStat(pcm, a, b), `对齐区间 [${a},${b})`);
      tested++;
    }
  }
  assertEq(tested, 28, '对齐区间数量');
}

// 3. 随机任意区间 2000 个（覆盖头部散样本、尾巴碎块、跨多层）
{
  const n = LEAF * 20 + 123;
  const pcm = makePcm(n, 7);
  const py = new SourcePyramid([pcm], n, 't');
  let state = 12345;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  for (let t = 0; t < 2000; t++) {
    const a = Math.floor(rand() * (n + 1));
    const b = a + Math.floor(rand() * (n - a + 1));
    assertStat(py.query(0, a, b), bruteStat(pcm, a, b), `随机区间 [${a},${b})`);
  }
}

// 4. 单帧与越界
{
  const n = LEAF * 2;
  const pcm = makePcm(n, 5);
  const py = new SourcePyramid([pcm], n, 't');
  for (const f of [0, 1, LEAF - 1, LEAF, LEAF + 1, n - 1]) {
    assertStat(py.query(0, f, f + 1), bruteStat(pcm, f, f + 1), `单帧 ${f}`);
  }
  let threw = false;
  try { py.query(0, 0, n + 1); } catch { threw = true; }
  assert(threw, '越界查询抛错');
}

// 5. 满量程平方和精确（BigInt，十进制字符串）
{
  const n = LEAF * 4;
  const pcm = new Int16Array(n).fill(-32768);
  const py = new SourcePyramid([pcm], n, 't');
  const st = py.query(0, 0, n);
  const want = 32768n * 32768n * BigInt(n);
  assert(st.sumSq === want, `满量程平方和精确 (got ${st.sumSq}, want ${want})`);
  assertEq(st.sumSq.toString(), want.toString(), '平方和十进制字符串');
  assertEq(st.min, -32768, '满量程 min');
  assertEq(st.max, -32768, '满量程 max');
}

// 6. 双声道互不串扰
{
  const n = LEAF * 2 + 7;
  const l = makePcm(n, 1);
  const r = makePcm(n, 2);
  const py = new SourcePyramid([l, r], n, 'stereo');
  for (const [a, b] of [[0, n], [3, LEAF + 5], [LEAF, n - 1]]) {
    assertStat(py.query(0, a, b), bruteStat(l, a, b), `左声道 [${a},${b})`);
    assertStat(py.query(1, a, b), bruteStat(r, a, b), `右声道 [${a},${b})`);
  }
  assertEq(py.sample(1, 10), r[10], 'sample() 取右声道原值');
}

console.log('pyramid tests done');
