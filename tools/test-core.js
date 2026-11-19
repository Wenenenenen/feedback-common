/* Node 测试：JS 核心 vs Python 参考实现（tools/expected/*.json） */
"use strict";
const fs = require("fs");
const path = require("path");
const CC = require("../js/cluster-core.js");

const casesDir = path.join(__dirname, "..", "samples", "extracted");
const expectedDir = path.join(__dirname, "expected");
const cases = ["boundary", "invalid-radius", "odd-size", "overflow", "stress"];

let totalChecks = 0, failedChecks = 0;
function check(name, cond, extra) {
  totalChecks++;
  if (!cond) {
    failedChecks++;
    console.log("  FAIL " + name + (extra !== undefined ? "  " + String(extra) : ""));
  }
}
function close(a, b, tol) {
  if (a === b) return true;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

for (const name of cases) {
  console.log("== " + name + " ==");
  const raw = JSON.parse(fs.readFileSync(path.join(casesDir, name + ".json"), "utf8"));
  const exp = JSON.parse(fs.readFileSync(path.join(expectedDir, name + ".expected.json"), "utf8"));
  const v = CC.validateCase(raw);
  const res = CC.analyze(raw);

  check("dims ntx", res.meta.ntx === exp.dims.ntx, res.meta.ntx);
  check("dims nty", res.meta.nty === exp.dims.nty);
  check("nClusters", res.meta.nClusters === exp.dims.n_clusters);
  check("invalid lights", JSON.stringify(res.invalidLightIds) === JSON.stringify(exp.invalid_light_ids),
    JSON.stringify(res.invalidLightIds));
  check("valid light count", res.lights.length === exp.valid_light_count);

  // 深度边
  check("edge count", res.meta.edges.length === exp.depth_edges.length);
  for (let k = 0; k < exp.depth_edges.length; k++)
    check("edge " + k, close(res.meta.edges[k], exp.depth_edges[k], 1e-14),
      res.meta.edges[k] + " vs " + exp.depth_edges[k]);

  // 簇成员与计数
  check("cluster count len", res.clusters.length === exp.cluster_members.length);
  let maxCount = 0;
  for (let c = 0; c < exp.cluster_members.length; c++) {
    check("members c" + c,
      JSON.stringify(res.clusters[c].members) === JSON.stringify(exp.cluster_members[c]),
      JSON.stringify(res.clusters[c].members) + " vs " + JSON.stringify(exp.cluster_members[c]));
    check("count c" + c, res.clusterCounts[c] === exp.cluster_counts[c]);
    maxCount = Math.max(maxCount, res.clusterCounts[c]);
  }
  check("max lights/cluster", maxCount === exp.max_lights_per_cluster, maxCount);

  // 像素所属簇
  let bgOk = true;
  for (let i = 0; i < res.pixelCluster.length; i++) {
    const js = res.pixelCluster[i];
    const py = exp.pixel_cluster[i];
    if (py === null) { if (js !== -1) bgOk = false; }
    else if (js !== py) bgOk = false;
  }
  check("pixel cluster ids", bgOk);

  // 线性颜色：分簇与穷举，逐通道
  const N = raw.width * raw.height;
  let colorMaxDiff = 0;
  for (let i = 0; i < N * 3; i++) {
    colorMaxDiff = Math.max(colorMaxDiff, Math.abs(res.clusterRGB[i] - exp.cluster_color[Math.floor(i / 3)][i % 3]));
    colorMaxDiff = Math.max(colorMaxDiff, Math.abs(res.exhRGB[i] - exp.exhaustive_color[Math.floor(i / 3)][i % 3]));
  }
  check("linear RGB vs python (max abs <1e-12)", colorMaxDiff < 1e-12, colorMaxDiff);

  // 内部一致性：分簇与穷举必须完全一致（同一套候选覆盖）
  let selfErr = 0;
  for (let i = 0; i < N * 3; i++) selfErr = Math.max(selfErr, Math.abs(res.clusterRGB[i] - res.exhRGB[i]));
  check("cluster==exhaustive", selfErr === 0, selfErr);
  check("maxError field", res.maxError === exp.max_abs_error, res.maxError);

  // 求值次数
  let totCT = 0, totAE = 0, totET = 0, totEE = 0;
  let evalMatch = true, testMatch = true;
  for (let i = 0; i < N; i++) {
    totCT += res.candTests[i]; totAE += res.actualEvals[i];
    totET += res.exhTests[i]; totEE += res.exhEvals[i];
    if (res.actualEvals[i] !== exp.cluster_evals[i]) evalMatch = false;
    if (res.candTests[i] !== exp.cluster_tests[i]) testMatch = false;
    if (res.exhEvals[i] !== exp.exhaustive_evals[i]) evalMatch = false;
    if (res.exhTests[i] !== exp.exhaustive_tests[i]) testMatch = false;
  }
  check("per-pixel eval counts", evalMatch);
  check("per-pixel test counts", testMatch);
  check("totals candidate tests", totCT === exp.total_cluster_tests, totCT);
  check("totals actual evals", totAE === exp.total_cluster_evals, totAE);
  check("totals exhaustive tests", totET === exp.total_exhaustive_tests, totET);
  check("totals exhaustive evals", totEE === exp.total_exhaustive_evals, totEE);

  // pixelDetail 抽查：中心像素
  const cx = Math.floor(raw.width / 2), cy = Math.floor(raw.height / 2);
  const det = CC.pixelDetail(res, cx, cy);
  check("detail cluster index", det.clusterIndex === res.pixelCluster[cy * raw.width + cx]);
  check("detail rows = lights", det.rows.length === res.lights.length);
  let sumContrib = [0, 0, 0];
  for (const row of det.rows) for (let k = 0; k < 3; k++) sumContrib[k] += row.contribution[k];
  const ci = (cy * raw.width + cx) * 3;
  check("detail contributions sum to pixel color",
    close(sumContrib[0], res.clusterRGB[ci], 1e-12) &&
    close(sumContrib[1], res.clusterRGB[ci + 1], 1e-12) &&
    close(sumContrib[2], res.clusterRGB[ci + 2], 1e-12),
    JSON.stringify(sumContrib));

  // 截断诊断：cap=常见上限 128 时 overflow 必须出现差异（证明上限机制可观测，默认路径不截断）
  if (name === "overflow") {
    const capped = CC.analyze(raw, { cap: 128 });
    let cappedMax = 0, anyTruncated = false;
    for (const c of capped.clusters) {
      if (c.members.length > 128) anyTruncated = true;
      cappedMax = Math.max(cappedMax, c.truncatedMembers.length);
    }
    check("cap path truncates", anyTruncated && cappedMax === 128);
    check("uncapped path never truncates", Math.max(...res.clusterCounts) === 300);
  }
  console.log("  validation warnings: " + v.warnings.length +
    (v.errors.length ? "  ERRORS:" + JSON.stringify(v.errors) : ""));
}

// 拖拽重算：移动一个灯后成员列表随之变化且颜色重算
{
  const raw = JSON.parse(fs.readFileSync(path.join(casesDir, "odd-size.json"), "utf8"));
  const base = CC.analyze(raw);
  const before = base.clusters.map((c) => c.count);
  const moved = CC.analyze(raw, {
    overrides: new Map([[0, { position: [100, 100, 100] }]]),
  });
  const after = moved.clusters.map((c) => c.count);
  check("drag recomputes membership", JSON.stringify(before) !== JSON.stringify(after));
  let colorChanged = false;
  for (let i = 0; i < base.clusterRGB.length; i++)
    if (base.clusterRGB[i] !== moved.clusterRGB[i]) colorChanged = true;
  check("drag recomputes colors", colorChanged);
}

// 合成用例：null 背景像素 + 前向受光，验证背景归零、不属簇、分簇=穷举
{
  const W = 5, H = 5;
  const raw = {
    width: W, height: H, tile_size: 16, slices: 2, near: 1, far: 16, fov_y: 90,
    depth: [], normals: [], albedo: [],
    lights: [{ id: 0, position: [0.6, 0.3, 4.5], radius: 4, intensity: [2, 3, 4] }],
  };
  for (let i = 0; i < W * H; i++) {
    const px = i % W, py = (i / W) | 0;
    const corner = (px === 0 || px === W - 1) && (py === 0 || py === H - 1);
    raw.depth.push(corner ? null : 6);
    raw.normals.push([0, 0, -1]);
    raw.albedo.push([0.5, 0.5, 0.5]);
  }
  const r = CC.analyze(raw);
  let bgOk = true, fgLit = false;
  for (let i = 0; i < W * H; i++) {
    if (raw.depth[i] === null) {
      check("bg pixel has no cluster", r.pixelCluster[i] === -1);
      check("bg pixel zero color", r.clusterRGB[i * 3] === 0 && r.exhRGB[i * 3] === 0);
      check("bg pixel flagged", r.isBg[i] === 1);
      if (r.pixelCluster[i] !== -1 || r.clusterRGB[i * 3] !== 0 || !r.isBg[i]) bgOk = false;
    } else if (r.clusterRGB[i * 3] > 0) fgLit = true;
  }
  check("foreground receives light", fgLit);
  check("cluster==exhaustive with background", r.maxError === 0);
  const det = CC.pixelDetail(r, 0, 0);
  check("bg detail reports background", det.background === true && det.clusterIndex === -1);
}

console.log("\n" + (failedChecks === 0 ? "ALL PASS" : failedChecks + " FAILURES") +
  "  (" + totalChecks + " checks)");
process.exit(failedChecks ? 1 : 0);
