// 共享关节耦合测试: 只动一条链的目标, 共享 root 必须变化并联动另一条链。
// node tools/test_coupling.js
const fs = require("fs");
const path = require("path");
const { KinModel, solve, DEG } = require("../app/hinge-ik-solver.js");

const dir = path.resolve(__dirname, "..", "samples", "extracted");
const json = JSON.parse(fs.readFileSync(path.join(dir, "shared.json"), "utf8"));

const m = new KinModel(JSON.parse(JSON.stringify(json)));
const r = solve(m);
const rootBefore = r.theta[m.index["root"]];
const tipB_before = m.fk(r.theta).pts[1];

const moved = JSON.parse(JSON.stringify(json));
moved.effectors[0].target = [3.0, 0.5, 0]; // 只移动 arm-a 目标
const m2 = new KinModel(moved);
const r2 = solve(m2, r.theta);
const rootAfter = r2.theta[m2.index["root"]];
const tipB_after = m2.fk(r2.theta).pts[1];

const rootMoved = Math.abs(rootAfter - rootBefore) > 1e-9;
const tipB_moved = Math.hypot(
  tipB_after[0] - tipB_before[0],
  tipB_after[1] - tipB_before[1],
  tipB_after[2] - tipB_before[2]
);
console.log("root 角度(deg):", (rootBefore / DEG).toFixed(4), "->", (rootAfter / DEG).toFixed(4));
console.log("arm-b 末端联动位移:", tipB_moved.toFixed(5));
console.log("两末端残差:", r2.errors.map((e) => e.toExponential(3)));

let fail = 0;
if (!rootMoved) { fail++; console.log("FAIL: 共享 root 未变化"); }
if (!(tipB_moved > 1e-6)) { fail++; console.log("FAIL: 另一条链未被联动"); }
// 残差必须被如实报告 (此目标对有限位的 root 是折中, 不假装收敛)
if (r2.reached && r2.errors.some((e) => e >= m2.tol)) { fail++; console.log("FAIL: 残差超阈却报 reached"); }
console.log(fail === 0 ? "COUPLING PASSED" : `${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
