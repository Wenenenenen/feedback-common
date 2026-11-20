// node 对拍: JS 求解器 vs 样例期望。用 node 运行 (CommonJS)。
const fs = require("fs");
const path = require("path");
const { KinModel, solve, DEG } = require("../app/hinge-ik-solver.js");

const dir = path.resolve(__dirname, "..", "samples", "extracted");
const cases = ["two-link", "unreachable", "shared", "locked"];
let fail = 0;

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

for (const name of cases) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
  const m = new KinModel(json);
  const r = solve(m);
  const r2 = solve(new KinModel(json));
  const det = JSON.stringify(r.log) === JSON.stringify(r2.log);
  console.log(`== ${name}`);
  console.log("  status   :", r.status, "-", r.reason);
  console.log("  reached  :", r.reached, " iters:", r.iterations);
  console.log("  errors   :", r.errors.map((d) => Number(d.toFixed(6))));
  console.log("  cost p/r/t:", r.positionCost.toExponential(3), r.regCost.toExponential(3), r.totalCost.toExponential(3));
  console.log("  angles°  :", r.theta.map((a) => Number((a / DEG).toFixed(4))));
  console.log("  deterministic:", det);
  if (!det) { fail++; console.log("  !! NON-DETERMINISTIC"); }

  // 期望断言
  if (name === "two-link") {
    if (!(r.reached && approx(r.errors[0], 0, 1e-6))) { fail++; console.log("  !! two-link should reach"); }
    if (!approx(r.theta[0] / DEG, 53.1301, 1e-3) || !approx(r.theta[1] / DEG, -90, 1e-3)) {
      fail++; console.log("  !! unexpected angles");
    }
  }
  if (name === "shared") {
    if (!r.reached) { fail++; console.log("  !! shared should reach"); }
    // 应收敛到 known-pose: root=25, arm-a=40, arm-b=-30 (允许镜像解, 但此初值下应匹配)
    const exp = { root: 25, "arm-a": 40, "arm-b": -30 };
    for (const [id, deg] of Object.entries(exp)) {
      const got = r.theta[m.index[id]] / DEG;
      if (!approx(got, deg, 1e-2)) { fail++; console.log(`  !! ${id} expected ${deg}, got ${got}`); }
    }
  }
  if (name === "unreachable" || name === "locked") {
    if (r.reached) { fail++; console.log(`  !! ${name} must NOT report reached`); }
    if (r.status !== "stalled") { fail++; console.log(`  !! ${name} expected stalled, got ${r.status}`); }
  }
  if (name === "locked") {
    // 锁定关节角度必须保持 20
    if (!approx(r.theta[m.index["base"]] / DEG, 20, 1e-9)) {
      fail++; console.log("  !! locked base joint moved");
    }
  }
}

// known-pose FK 校验: 给定姿态末端应精确命中目标
const poses = JSON.parse(fs.readFileSync(path.join(dir, "known-pose.json"), "utf8"));
for (const [caseName, pose] of Object.entries(poses)) {
  const file = caseName === "two-link" ? "two-link.json" : "shared.json";
  const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const m = new KinModel(json);
  const th = m.theta.slice();
  for (const [id, deg] of Object.entries(pose)) th[m.index[id]] = deg * DEG;
  const { pts } = m.fk(th);
  m.effectors.forEach((e, ei) => {
    const d = Math.hypot(pts[ei][0] - e.target[0], pts[ei][1] - e.target[1], pts[ei][2] - e.target[2]);
    if (!(d < 1e-9)) { fail++; console.log(`!! FK mismatch ${caseName}/${e.id}: ${d}`); }
  });
  console.log(`FK known-pose ${caseName}: OK`);
}

console.log(fail === 0 ? "\nALL JS CROSS-CHECKS PASSED" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
