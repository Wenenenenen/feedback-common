/*
 * Node 自检：用 node --experimental-vm-modules 不需要，直接 ESM 运行。
 * 对照 samples/extracted/*-expected.json 校验逐包状态、逐槽 deadline/source、PCM sha256。
 * 运行：node tools/node-test.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzePlayout, buildExportJson } from "../js/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, "..", "samples", "extracted");

let failures = 0;

for (const name of ["mono", "stereo"]) {
  const doc = JSON.parse(readFileSync(join(samples, `${name}.json`), "utf8"));
  const expectedList = JSON.parse(
    readFileSync(join(samples, `${name}-expected.json`), "utf8"),
  );

  for (const exp of expectedList) {
    const res = analyzePlayout(doc, exp.delay_ms, exp.policy);
    if (!res.ok) {
      console.log(`FAIL ${name} ${exp.delay_ms}ms ${exp.policy}: engine errors`, res.errors);
      failures++;
      continue;
    }
    const gotStatus = {};
    for (const v of res.packets) gotStatus[v.id] = v.status;
    const statusOk = JSON.stringify(gotStatus) === JSON.stringify(exp.packets);

    let slotsOk = res.slots.length === exp.slots.length;
    if (slotsOk) {
      for (let i = 0; i < exp.slots.length; i++) {
        const g = res.slots[i];
        const w = exp.slots[i];
        if (g.slot !== w.slot || g.deadline_us !== w.deadline_us || g.source !== w.source) {
          slotsOk = false;
          break;
        }
      }
    }

    const sha = createHash("sha256").update(res.pcm).digest("hex");
    const shaOk = sha === exp.pcm_sha256;
    const lengthOk =
      res.pcm.length === doc.total_packets * doc.frames_per_packet * doc.channels * 2;

    const verdict =
      statusOk && slotsOk && shaOk && lengthOk ? "OK  " : "FAIL";
    if (verdict === "FAIL") failures++;
    console.log(
      `${verdict} ${name.padEnd(7)} delay=${String(exp.delay_ms).padStart(2)} ` +
        `policy=${exp.policy.padEnd(12)} status=${statusOk} slots=${slotsOk} ` +
        `length=${lengthOk} sha=${shaOk}`,
    );
    if (!shaOk) {
      console.log("   want", exp.pcm_sha256);
      console.log("   got ", sha);
    }
    if (!statusOk) {
      for (const [id, want] of Object.entries(exp.packets)) {
        if (gotStatus[id] !== want) {
          console.log(`   status diff ${id}: want ${want} got ${gotStatus[id]}`);
        }
      }
    }

    // 导出 JSON 结构自检
    const exported = buildExportJson(res);
    if (
      exported.delay_ms !== exp.delay_ms ||
      exported.policy !== exp.policy ||
      exported.slots.length !== doc.total_packets ||
      Object.keys(exported.packets).length !== doc.packets.length
    ) {
      console.log(`FAIL ${name}: export JSON structure`);
      failures++;
    }
  }

  // 边界：恰好等于 deadline 的包必须 accepted
  const edge = analyzePlayout(doc, 10, "zero");
  const onDeadline = edge.packets.filter((p) => p.arrival_us === p.deadline_us);
  for (const p of onDeadline) {
    if (p.status !== "accepted") {
      console.log(`FAIL edge: ${p.id} arrived exactly on deadline but got ${p.status}`);
      failures++;
    }
  }
  console.log(`     恰好赶上截止时间的包：${onDeadline.length} 个，全部 accepted`);
}

// 边界：迟到包绝不能改写已播放内容 —— 调整 delay 让某些包在 late/accepted 间切换，
// 验证 late 状态下对应槽 source 为 null 或补偿数据
{
  const doc = JSON.parse(readFileSync(join(samples, "mono.json"), "utf8"));
  const r0 = analyzePlayout(doc, 0, "zero");
  const r200 = analyzePlayout(doc, 200, "zero");
  let violated = 0;
  for (const s of r0.slots) {
    if (s.source === null) continue;
    const owner = r0.packets.find((p) => p.id === s.source);
    if (owner && owner.status !== "accepted") violated++;
  }
  console.log(`     零延迟下所有 slot.source 均来自 accepted 包：${violated === 0}`);
  if (violated) failures++;
  console.log(`     delay=200ms 时 accepted 数 ≥ delay=0 时：`,
    r200.packets.filter((p) => p.status === "accepted").length >=
      r0.packets.filter((p) => p.status === "accepted").length);
}

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
