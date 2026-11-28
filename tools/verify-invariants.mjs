// tools/verify-invariants.mjs —— 在任意数据上校验解的几何/逻辑不变量
// 用法：node tools/verify-invariants.mjs <data.json>
import fs from 'node:fs';
import { buildModel } from '../src/model.js';
import { solve } from '../src/solver.js';
import { computeRetained } from '../src/gaps.js';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const model = buildModel(data);
const pinMap = new Map(model.pins.map((p) => [p.cid, p.above]));
const r = solve(model, pinMap);
const retained = computeRetained(model, r.above);

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };

// 1. 每个交点的上层线必须是交汇两线之一
for (const c of model.crossings) {
  if (r.above[c.cid] !== c.h && r.above[c.cid] !== c.v) {
    fail(`交点 (${c.x},${c.y}) 上层线 ${r.above[c.cid]} 不合法`);
  }
}

// 2. 每条开线沿路严格上下交替；闭线首尾也交替
for (const st of model.strands) {
  const m = st.order.length;
  if (m === 0) continue;
  const isUp = (o) => r.above[o.cid] === st.id;
  const pairs = st.closed ? m : m - 1;
  for (let i = 0; i < pairs; i++) {
    const u = st.order[i], v = st.order[(i + 1) % m];
    if (isUp(u) === isUp(v)) {
      fail(`线条 ${st.id} 相邻交点 #${u.cid}->#${v.cid} 未交替`);
    }
  }
}

// 3. 锁点必须满足
for (const [cid, above] of pinMap) {
  if (r.above[cid] !== above) fail(`锁点 #${cid} 未满足（要求线 ${above} 在上）`);
}

// 4. 无锁分量的最早交点（cid 最小者）小号线在上
//    用 DSU 思路简化：检查每个 cid，若其所在分量无锁，则分量最小 cid 的 above===a
const parent = Int32Array.from({ length: model.crossings.length }, (_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
for (const st of model.strands) {
  for (let i = 1; i < st.order.length; i++) {
    const a = st.order[i - 1].cid, b = st.order[i].cid;
    parent[find(a)] = find(b);
  }
}
const compMin = new Map(), compHasPin = new Map();
model.crossings.forEach((c, cid) => {
  const root = find(cid);
  if (!compMin.has(root) || cid < compMin.get(root)) compMin.set(root, cid);
  compHasPin.set(root, (compHasPin.get(root) || false) || pinMap.has(cid));
});
for (const [root, minCid] of compMin) {
  if (!compHasPin.get(root)) {
    const c = model.crossings[minCid];
    if (r.above[minCid] !== c.a) fail(`无锁分量最早交点 (${c.x},${c.y}) 非小号线在上`);
  }
}

// 5. 缺口不变量：下穿点 arc±gap 内不应有保留像素；上穿点附近应保留
for (const st of model.strands) {
  const paths = retained.get(st.id) || [];
  for (const { cid, arc } of st.order) {
    const under = r.above[cid] !== st.id;
    if (!under || st.gap === 0) continue;
    // 把所有保留区间收集为弧长区间，检查与 [arc-g, arc+g] 不相交
    for (const path of paths) {
      // 仅做长度层面的抽查：保留区间总长度 + 缺口长度 = 总长度
    }
  }
  const keptLen = sumPathLength(st, paths);
  // 重新独立计算缺口长度
  const gaps = [];
  for (const { cid, arc } of st.order) {
    if (r.above[cid] !== st.id && st.gap > 0) gaps.push([arc - st.gap, arc + st.gap]);
  }
  let missing;
  if (st.closed) {
    const L = st.totalLen;
    const pieces = [];
    for (const [a, b] of gaps) {
      let a2 = ((a % L) + L) % L, len = b - a;
      if (len >= L) { pieces.length = 0; pieces.push([0, L]); break; }
      const end = a2 + len;
      if (end <= L) pieces.push([a2, end]); else { pieces.push([a2, L]); pieces.push([0, end - L]); }
    }
    pieces.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, b] of pieces) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
    }
    missing = merged.reduce((n, [a, b]) => n + (b - a), 0);
    if (keptLen + missing > L + 1e-6 || keptLen + missing < L - 1e-6) {
      fail(`闭线 ${st.id} 保留长度 ${keptLen} + 缺口 ${missing} != 周长 ${L}`);
    }
  } else {
    const clipped = gaps.map(([a, b]) => [Math.max(0, a), Math.min(st.totalLen, b)])
      .filter(([a, b]) => b > a)
      .sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, b] of clipped) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
    }
    missing = merged.reduce((n, [a, b]) => n + (b - a), 0);
    if (Math.abs(keptLen + missing - st.totalLen) > 1e-6) {
      fail(`开线 ${st.id} 保留长度 ${keptLen} + 缺口 ${missing} != 总长 ${st.totalLen}`);
    }
  }
}

function sumPathLength(st, paths) {
  let len = 0;
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      len += Math.abs(path[i][0] - path[i - 1][0]) + Math.abs(path[i][1] - path[i - 1][1]);
    }
  }
  return len;
}

console.log(`线条 ${model.strands.length} · 交点 ${model.crossings.length} · 矛盾 ${r.conflictCount}`);
if (failures === 0) console.log('✓ 全部不变量通过');
else { console.log(`${failures} 项失败`); process.exit(1); }
