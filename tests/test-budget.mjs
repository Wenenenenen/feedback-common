// 对拍：随机小树用暴力枚举（2^n 子集）验证前缀闭合配额 DP 的最优性与三级并列规则
import { solveBudget, comparePath } from '../src/beam.js';

let seed = 123456789;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function makeTree(spec) {
  // spec: 嵌套数组描述，节点 {id, score, kids}
  let counter = 0;
  const all = [];
  const build = (node, parent, path) => {
    const beam = {
      path: path.concat(node.id), depth: path.length + 1, score: node.score,
      children: [], parent, id: node.id,
    };
    all.push(beam);
    for (const k of node.kids || []) {
      beam.children.push(build(k, beam, beam.path));
    }
    return beam;
  };
  const root = { path: [], depth: 0, children: [], parent: null };
  for (const n of spec) root.children.push(build(n, root, []));
  all.forEach((b) => { b._key = b.path.join('>'); });
  return { root, all };
}

function bruteForce(tree, K) {
  const beams = tree.all.slice(1);
  const parentOf = new Map(beams.map((b) => [b, b.parent]));
  let best = null; // {score, count, paths:sorted string[]}
  const n = beams.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const set = new Set();
    let ok = true;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) set.add(beams[i]);
    if (set.size > K) continue;
    for (const b of set) {
      if (b.depth >= 2 && !set.has(b.parent)) { ok = false; break; }
    }
    if (!ok) continue;
    const score = [...set].reduce((s, b) => s + b.score, 0);
    const paths = [...set].map((b) => b.path.slice()).sort(comparePath);
    const cand = { score, count: set.size, paths };
    if (!best
      || cand.score > best.score
      || (cand.score === best.score && cand.count > best.count)
      || (cand.score === best.score && cand.count === best.count
        && JSON.stringify(cand.paths) < JSON.stringify(best.paths))) {
      best = cand;
    }
  }
  return best;
}

function dpResult(tree, K) {
  const { selected, totalScore } = solveBudget(tree, K);
  return {
    score: totalScore,
    count: selected.size,
    paths: [...selected].map((b) => b.path.slice()).sort(comparePath),
  };
}

function randomTree(maxDepth, maxKids) {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  let idc = 0;
  const gen = (depth) => {
    const node = { id: ids[idc++ % ids.length] + idc, score: Math.floor(rnd() * 1000), kids: [] };
    if (depth < maxDepth) {
      const nk = Math.floor(rnd() * (maxKids + 1));
      for (let i = 0; i < nk; i++) node.kids.push(gen(depth + 1));
    }
    return node;
  };
  const roots = [];
  const nr = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < nr; i++) roots.push(gen(0));
  return roots;
}

let fails = 0;
for (let t = 0; t < 300; t++) {
  const spec = randomTree(2, 3);
  const tree = makeTree(spec);
  if (tree.all.length - 1 > 14) continue; // 暴力 2^n 限制
  for (const K of [1, 2, 3, 4, 6, 8]) {
    const bf = bruteForce(tree, K);
    const dp = dpResult(tree, K);
    if (bf.score !== dp.score || bf.count !== dp.count
      || JSON.stringify(bf.paths) !== JSON.stringify(dp.paths)) {
      fails++;
      console.log('MISMATCH K=', K);
      console.log('brute', bf);
      console.log('dp   ', dp);
      if (fails > 5) process.exit(1);
    }
  }
}
// 刻意制造并列得分场景验证字典序
const tieSpec = [
  { id: 'X', score: 100, kids: [{ id: 'X1', score: 50, kids: [] }] },
  { id: 'Y', score: 100, kids: [{ id: 'Y1', score: 50, kids: [] }] },
];
const tt = makeTree(tieSpec);
for (const K of [1, 2]) {
  const bf = bruteForce(tt, K), dp = dpResult(tt, K);
  if (JSON.stringify(bf) !== JSON.stringify(dp)) {
    fails++; console.log('TIE MISMATCH K=', K, bf, dp);
  }
}
console.log(fails === 0 ? 'DP 对拍全部通过（300 随机树 × 6 个 K + 并列用例）' : `失败 ${fails} 例`);
process.exit(fails ? 1 : 0);
