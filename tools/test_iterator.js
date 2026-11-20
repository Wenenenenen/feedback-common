// 验证: 迭代器逐轮驱动的最终结果与一次性 solve 完全一致 (单步/运行等价)
const fs = require("fs");
const path = require("path");
const { KinModel, IKIterator, solve } = require("../app/hinge-ik-solver.js");

const dir = path.resolve(__dirname, "..", "samples", "extracted");
let fail = 0;
for (const name of ["two-link", "unreachable", "shared", "locked"]) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
  const full = solve(new KinModel(json));

  const m2 = new KinModel(json);
  const it = new IKIterator(m2, m2.theta);
  const stepped = [];
  let guard = 0;
  while (!it.done && guard < m2.maxIter + 5) {
    const snap = it.next();
    stepped.push(snap.iteration);
    guard++;
  }
  const finalSnap = it._snapshot();
  const sameTheta = finalSnap.theta.every((v, i) => Math.abs(v - full.theta[i]) < 1e-15);
  const sameStatus = finalSnap.status === full.status;
  const sameCost = Math.abs(finalSnap.totalCost - full.totalCost) < 1e-18 * Math.max(1, Math.abs(full.totalCost));
  const sameIters = finalSnap.iteration === full.iterations;
  const ok = sameTheta && sameStatus && sameCost && sameIters;
  console.log(`${name}: step==run ${ok ? "OK" : "MISMATCH"} (iters ${finalSnap.iteration} vs ${full.iterations}, status ${finalSnap.status} vs ${full.status})`);
  if (!ok) {
    fail++;
    if (!sameTheta) console.log("  theta diff:", finalSnap.theta.map((v, i) => v - full.theta[i]));
  }

  // 确定性: 再跑一次迭代器, 轮次序列一致
  const it2 = new IKIterator(new KinModel(json), new KinModel(json).theta);
  const seq2 = [];
  while (!it2.done) seq2.push(it2.next().iteration);
  if (JSON.stringify(seq2) !== JSON.stringify(stepped)) { fail++; console.log("  iterator non-deterministic"); }
}
console.log(fail === 0 ? "ITERATOR EQUIVALENCE PASSED" : `${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
