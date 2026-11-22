// Parser coverage tests against synthetic fMP4 files.
import { File } from "node:buffer";
import { parseFile, cleanMoov, isKeyframe } from "../public/mp4/parse.js";
import { buildOutput, buildOriginal } from "../public/mp4/write.js";
import { buildCaseA, buildBroken } from "./synth.mjs";

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else { failures++; console.error("  FAIL -", msg); }
}

async function parse(bytes, name) {
  return parseFile(new File([bytes], name));
}

async function main() {
  console.log("== synthetic valid case ==");
  const a = await buildCaseA();
  const model = await parse(a.bytes, "syn_valid.mp4");
  const v = model.tracks.get(1);
  const au = model.tracks.get(2);
  check(model.fragments.length === 2, "两个分片");
  check(v.count === 5, `视频 5 样本（实际 ${v.count}）`);
  check(au.count === 3, `音频 3 样本（实际 ${au.count}）`);
  check(v.dts[0] === 0n && v.dts[3] === 9000n, "tfdt v0/v1 初值与累加 DTS 正确");
  check(v.duration[3] === 3000 && v.cts[4] === -1500, "trun v1 有符号 CTS 正确");
  // trun v0 cts -1 was encoded as u32 0xffffffff => parsed as 4294967295
  check(v.cts[2] === 4294967295, "trun v0 的 u32 CTS 按无符号解析");
  check(v.sampleFlags[0] === 0x02000000, "first_sample_flags 覆盖首样本");
  check(v.sampleFlags[1] === 0, "其余样本回落 trex 默认 flags=0（关键帧）");
  check(au.duration[0] === 1024, "音频时长取 tfhd 默认值");
  check(au.size[1] === 42, "音频大小逐样本覆盖");
  check(isKeyframe(v, 0) && isKeyframe(v, 1), "默认 flags=0 识别为关键帧");
  check(model.rangeErrors.length === 0, "无越界/重叠");
  // second trun continued at first trun's end: sample index 4 offset = p2 + 60
  const p2 = model.fragments[1].payloadStart;
  check(v.offset[4] === p2 + 60 && v.size[4] === 55, "无 data_offset 的 trun 续接上一 trun 末尾");

  // repack the synthetic file
  model.moovClean = await cleanMoov(model.moovBytes);
  const keyframes = [];
  for (let i = 0; i < v.count; i++) if (isKeyframe(v, i)) keyframes.push(i);
  const blob = await buildOutput(model, keyframes.map((i) => v.dts[i]), keyframes);
  const out = new Uint8Array(await blob.arrayBuffer());
  const model2 = await parse(out, "syn_out.mp4");
  check(model2.fragments.length === keyframes.length, `重封装段数=${keyframes.length}`);
  const v2 = model2.tracks.get(1);
  let same = 0;
  for (let i = 0; i < v.count; i++) {
    if (v2.dts[i] === v.dts[i] && v2.cts[i] === v.cts[i] &&
        v2.duration[i] === v.duration[i] && v2.size[i] === v.size[i] &&
        v2.sampleFlags[i] === v.sampleFlags[i]) same++;
  }
  check(same === v.count, "重封装后逐样本字段不变");
  const blobOrig = await buildOriginal(model);
  check(blobOrig.size > 0, "原方案导出可用");

  console.log("\n== broken: sample overruns mdat ==");
  const over = await buildBroken("overrun");
  const mOver = await parse(over.bytes, "over.mp4");
  check(mOver.rangeErrors.some((e) => e.kind === "out-of-mdat"),
    "报告越界样本与偏移：" + JSON.stringify(mOver.rangeErrors.find((e) => e.kind === "out-of-mdat")));
  mOver.moovClean = await cleanMoov(mOver.moovBytes);
  const recBlob = await buildOriginal(mOver);
  const mRec = await parse(new Uint8Array(await recBlob.arrayBuffer()), "rec.mp4");
  check(mRec.tracks.get(1).count === 2, "失败后原方案仍能导出");

  console.log("\n== broken: overlapping sample ranges ==");
  const ov = await buildBroken("overlap");
  const mOv = await parse(ov.bytes, "ov.mp4");
  const overlapErr = mOv.rangeErrors.find((e) => e.kind === "overlap");
  check(!!overlapErr, "报告重叠样本与偏移：" + JSON.stringify(overlapErr));
  mOv.moovClean = await cleanMoov(mOv.moovBytes);
  const ovBlob = await buildOriginal(mOv);
  const mOvRec = await parse(new Uint8Array(await ovBlob.arrayBuffer()), "ovrec.mp4");
  check(mOvRec.tracks.get(1).count === 3, "重叠失败后原方案仍能导出");

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
