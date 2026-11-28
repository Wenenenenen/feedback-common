// tests/test-core.mjs —— 纯逻辑回归测试（node --test 风格，零依赖手写断言）
import { buildModel, ModelError } from '../src/model.js';
import { solve } from '../src/solver.js';
import { computeRetained } from '../src/gaps.js';
import { exportSVG } from '../src/svg.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
};
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`);

// ---- 1. 样例文件：3 线 2 交点，默认小编号在上 ----
{
  const fs = await import('node:fs');
  const data = JSON.parse(fs.readFileSync(new URL('../samples/woven-crossings.json', import.meta.url)));
  const m = buildModel(data);
  eq(m.crossings.length, 2, '样例交点数');
  eq(m.crossings[0].x, 3, 'cid0 按 y,x 排序取最上');
  const pinMap = new Map(m.pins.map((p) => [p.cid, p.above]));
  const r = solve(m, pinMap);
  eq(r.conflictCount, 0, '样例无矛盾');
  // (3,4) 锁了线1在上；(9,4) 沿线1交替 -> 线3在上
  const c34 = m.crossingMap.get('3,4'), c94 = m.crossingMap.get('9,4');
  eq(r.above[c34.cid], 1, '(3,4) 线1在上（锁定）');
  eq(r.above[c94.cid], 3, '(9,4) 线3在上（沿线1交替传播）');
  const retained = computeRetained(m, r.above);
  // 线1在 (3,4) 上穿、(9,4) 下穿 -> 只有 (9,4) 一处缺口
  const p1 = retained.get(1);
  eq(p1.length, 2, '线1被缺口分成两段');
  // 竖直线2在 (3,4) 下穿，gap=1：弧长 4±1 -> [3,5] 被挖
  const p2 = retained.get(2);
  eq(p2.length, 2, '线2分成两段');
  const svg = exportSVG(m, retained);
  ok(svg.includes('<svg') && svg.includes('data-strand'), 'SVG 结构正常');
  console.log('✓ 样例文件');
}

// ---- 2. 无锁网格：默认全部小号线在上；横竖各自交替约束是否一致 ----
{
  const data = {
    strands: [
      { id: 1, points: [[0, 2], [6, 2]], closed: false, gap: 0 },
      { id: 2, points: [[0, 4], [6, 4]], closed: false, gap: 0 },
      { id: 3, points: [[2, 0], [2, 6]], closed: false, gap: 0 },
      { id: 4, points: [[4, 0], [4, 6]], closed: false, gap: 0 },
    ],
  };
  const m = buildModel(data);
  eq(m.crossings.length, 4, '网格 4 交点');
  const r = solve(m, new Map());
  eq(r.conflictCount, 0, '网格无矛盾');
  // 整个网格是一个连通分量；最早交点（y 最小再 x 最小）= (2,2)，小号线1在上
  const earliest = m.crossings[0];
  eq(r.above[earliest.cid], earliest.a, '分量最早交点小号线在上');
  // 其余交点由交替决定：沿线1，(2,2) 上 -> (4,2) 下，故线4在上
  eq(r.above[m.crossingMap.get('4,2').cid], 4, '(4,2) 由交替决定为线4在上');
  // 逐线校验交替性
  for (const st of m.strands) {
    const ups = st.order.map(({ cid }) => r.above[cid] === st.id);
    for (let i = 1; i < ups.length; i++) ok(ups[i] !== ups[i - 1], `线${st.id}沿路交替`);
  }
  console.log('✓ 无锁默认规则');
}

// ---- 3. 锁定翻转传播：锁一个点，同分量远处交点跟着翻 ----
{
  const data = {
    strands: [
      { id: 1, points: [[0, 2], [6, 2]], closed: false, gap: 0 },
      { id: 2, points: [[0, 4], [6, 4]], closed: false, gap: 0 },
      { id: 3, points: [[2, 0], [2, 6]], closed: false, gap: 0 },
      { id: 4, points: [[4, 0], [4, 6]], closed: false, gap: 0 },
    ],
    pins: [{ at: [2, 2], above: 3 }], // 大号线3在上 -> 沿线3，(2,4) 翻成线2在上
  };
  const m = buildModel(data);
  const r = solve(m, new Map(m.pins.map((p) => [p.cid, p.above])));
  eq(r.conflictCount, 0, '单锁无矛盾');
  const c22 = m.crossingMap.get('2,2'), c24 = m.crossingMap.get('2,4');
  const c42 = m.crossingMap.get('4,2'), c44 = m.crossingMap.get('4,4');
  eq(r.above[c22.cid], 3, '(2,2) 线3在上');
  eq(r.above[c24.cid], 2, '(2,4) 沿线3交替 -> 线2在上');
  // 线1在 (2,2) 下穿 -> (4,2) 上穿（线1在上）
  eq(r.above[c42.cid], 1, '(4,2) 沿线1交替 -> 线1在上');
  // (4,4)：沿线2从 (2,4)（线上）翻到线下，沿线4从 (4,2)（线下）翻到线上
  eq(r.above[c44.cid], 4, '(4,4) 线4在上，两条传播链一致');
  console.log('✓ 锁定传播与交替一致');
}

// ---- 4. 奇环矛盾：闭合矩形折线被穿过奇数次，闭线首尾相邻要求偶数次交替 ----
{
  // 闭线1 矩形 (2,2)-(8,8)；线2 横穿 y=4 产生 2 个交点；
  // 线3 只穿顶边（端点在矩形外侧，交点严格在内部），再添 1 个，共 3 个。
  const data3 = {
    strands: [
      { id: 1, points: [[2, 2], [8, 2], [8, 8], [2, 8]], closed: true, gap: 0 },
      { id: 2, points: [[0, 4], [10, 4]], closed: false, gap: 0 },
      { id: 3, points: [[5, 0], [5, 1]], closed: false, gap: 0 }, // 与顶边 y=2 不相交
    ],
  };
  // 线3 需要真正穿顶边：竖直线跨过 y=2，且两端在矩形外
  data3.strands[2].points = [[5, 0], [5, 3]]; // 交点 (5,2)，端点 (5,3) 在矩形内部
  // (5,3) 是孤立端点，不与任何线接触，允许。
  const m3 = buildModel(data3);
  eq(m3.crossings.length, 3, '构造出 3 交点闭线');
  const r3 = solve(m3, new Map());
  ok(r3.conflictCount >= 1, '奇交点闭线产生矛盾');
  ok(r3.conflicts[0].path.length >= 3, '矛盾附带可核对的闭环链');
  console.log('✓ 奇环矛盾检测');
}

// ---- 5. 锁冲突：两个锁点经交替链要求相反 ----
{
  const data = {
    strands: [
      { id: 1, points: [[0, 2], [4, 2]], closed: false, gap: 0 },
      { id: 2, points: [[1, 0], [1, 4]], closed: false, gap: 0 },
      { id: 3, points: [[3, 0], [3, 4]], closed: false, gap: 0 },
    ],
    pins: [
      { at: [1, 2], above: 2 }, // 线2上 -> 沿线1，(3,2) 线1上
      { at: [3, 2], above: 3 }, // 却锁线3上，冲突
    ],
  };
  const m = buildModel(data);
  const r = solve(m, new Map(m.pins.map((p) => [p.cid, p.above])));
  ok(r.conflictCount >= 1, '锁冲突被检出');
  ok(r.conflicts.some((c) => c.kind === 'pin'), '冲突类型为 pin');
  console.log('✓ 锁冲突检测');
}

// ---- 6. 闭线跨接缝缺口连通 ----
{
  // 闭线周长 16（4x4 矩形），唯一交点放在弧长 1 处下穿、gap=3 -> 缺口 [-2,4]
  // 折叠为 [0,4] 与 [14,16)，接缝处连通成 [14,16)∪[0,4]
  const data = {
    strands: [
      { id: 1, points: [[0, 0], [4, 0], [4, 4], [0, 4]], closed: true, gap: 3 },
      { id: 2, points: [[1, -2], [1, 2]], closed: false, gap: 0 }, // 交点 (1,0)，弧长1
    ],
  };
  const m = buildModel(data);
  const r = solve(m, new Map());
  const retained = computeRetained(m, r.above);
  // 线1为小号线且在上 -> 不挖；线2下穿。反过来强制线1下穿：
  const forced = Int32Array.from(r.above);
  const cid = m.crossingMap.get('1,0').cid;
  forced[cid] = 2;
  const retained2 = computeRetained(m, forced);
  const paths = retained2.get(1);
  eq(paths.length, 1, '跨接缝缺口合并后只剩一段保留线');
  // 保留区间应为 [4,14]
  const first = paths[0][0], last = paths[0][paths[0].length - 1];
  ok(first[0] === 4 && first[1] === 0, `保留起点 (4,0)，实际 (${first})`);
  ok(last[0] === 0 && last[1] === 2, `保留终点 (0,2)，实际 (${last})`);
  console.log('✓ 闭线接缝缺口');
}

// ---- 7. 缺口重叠取并集 ----
{
  const data = {
    strands: [
      { id: 1, points: [[0, 0], [10, 0]], closed: false, gap: 2 },
      { id: 2, points: [[3, -2], [3, 2]], closed: false, gap: 0 },
      { id: 3, points: [[5, -2], [5, 2]], closed: false, gap: 0 },
      { id: 4, points: [[7, -2], [7, 2]], closed: false, gap: 0 },
    ],
  };
  const m = buildModel(data);
  // 让线1在三个点都下穿
  const forced = new Int32Array(m.crossings.length);
  m.crossings.forEach((c, i) => { forced[i] = c.v; });
  const retained = computeRetained(m, forced);
  // 缺口 [1,5]、[3,7]、[5,9] 并集 = [1,9]
  const paths = retained.get(1);
  eq(paths.length, 2, '并集后线1剩两段（0-1 与 9-10）');
  console.log('✓ 缺口并集');
}

// ---- 8. 输入校验 ----
{
  const bad1 = { strands: [{ id: 1, points: [[0, 0], [1, 1]], closed: false, gap: 1 }] };
  let caught = false;
  try { buildModel(bad1); } catch (e) { caught = e instanceof ModelError && e.issues.some((s) => s.includes('横竖')); }
  ok(caught, '斜线被拒');
  const bad2 = {
    strands: [
      { id: 1, points: [[0, 0], [2, 0]], closed: false, gap: 1 },
      { id: 2, points: [[2, -2], [2, 2]], closed: false, gap: 1 },
    ],
  };
  caught = false;
  try { buildModel(bad2); } catch (e) { caught = e instanceof ModelError && e.issues.some((s) => s.includes('内部') || s.includes('端点接触')); }
  ok(caught, '端点-端点接触被拒');
  const bad3 = {
    strands: [
      { id: 1, points: [[0, 0], [4, 0]], closed: false, gap: 1 },
      { id: 2, points: [[2, 0], [2, 4]], closed: false, gap: 1 },
    ],
  };
  caught = false;
  try { buildModel(bad3); } catch (e) { caught = e instanceof ModelError; }
  ok(caught, '交点在线段端点被拒');
  console.log('✓ 输入校验');
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
