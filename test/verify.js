#!/usr/bin/env node
/* 用样例包 expected.json 回归验证 sim.js。
 * 用法: node test/verify.js <样例目录>   （目录含 tiles.json / mini.json / expected.json）
 */
const fs = require("fs");
const path = require("path");
const sim = require(path.join(__dirname, "..", "sim.js"));

const dir = process.argv[2];
if (!dir) {
  console.error("用法: node test/verify.js <样例目录>");
  process.exit(2);
}

const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const mini = load("mini.json");
const tiles = load("tiles.json");
const expected = load("expected.json");

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
};

// 1. mini 的 请求/取消/完成/忽略晚到 事件必须与 expected.json 完全一致
const miniRun = sim.simulate(mini, mini.frames, mini.capacity, mini.maxInflight);
const mine = miniRun.log.filter((e) => e[1] !== "淘汰" && e[1] !== "失败");
check(
  "mini 事件序列与 expected.json 一致",
  JSON.stringify(mine) === JSON.stringify(expected["mini事件"]),
  `\n  mine=${JSON.stringify(mine)}\n  exp =${JSON.stringify(expected["mini事件"])}`
);

// 2. 根页始终驻留、从不淘汰
const tilesRun = sim.simulate(tiles, tiles.frames, tiles.capacity, tiles.maxInflight);
const root = expected["根页"];
check(
  "tiles 全程根页驻留且未被淘汰",
  tilesRun.frames.every((f) => f.resident.includes(root)) &&
    !tilesRun.log.some((e) => e[1] === "淘汰" && e[2] === root),
  ""
);

// 3. 失败页 3/2/2：失败后最早下帧重试，且最终完成
const ev322 = tilesRun.log.filter((e) => e[2] === "3/2/2");
const failAt = ev322.find((e) => e[1] === "失败");
const retryAfter = failAt && ev322.find((e) => e[1] === "请求" && e[0] > failAt[0]);
const noSameFrameRetry =
  failAt && !ev322.some((e) => e[1] === "请求" && e[0] === failAt[0]);
check(
  "3/2/2 首到期失败、不在同帧重试、下帧重试并最终完成",
  !!failAt && noSameFrameRetry && !!retryAfter && ev322.some((e) => e[1] === "完成"),
  JSON.stringify(ev322)
);

// 4. 取消后晚到不污染：每个“忽略晚到”的代号都不是该页当前有效请求
let pollution = false;
for (const run of [miniRun, tilesRun]) {
  const seen = new Set();
  for (const e of run.log) {
    if (e[1] === "完成" && seen.has(`late:${e[2]}:${e[3]}`)) pollution = true;
    if (e[1] === "忽略晚到") seen.add(`late:${e[2]}:${e[3]}`);
  }
}
check("被忽略的晚到代号从未入槽（无污染）", !pollution, "");

// 5. 确定性：同轨迹重放两次，日志与采样完全一致
const again = sim.simulate(tiles, tiles.frames, tiles.capacity, tiles.maxInflight);
check(
  "重放确定性（日志+采样逐帧相同）",
  JSON.stringify(again.log) === JSON.stringify(tilesRun.log) &&
    JSON.stringify(again.frames.map((f) => f.samples)) ===
      JSON.stringify(tilesRun.frames.map((f) => f.samples)),
  ""
);

// 6. 缓存容量与并发上限全程不超
const capOK = tilesRun.frames.every((f) => f.resident.length <= tiles.capacity);
const inflOK = tilesRun.frames.every((f) => f.inflight.length <= tiles.maxInflight);
check("驻留数 ≤ 容量且在途数 ≤ 并发上限", capOK && inflOK, "");

process.exit(failures ? 1 : 0);
