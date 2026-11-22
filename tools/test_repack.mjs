// Node-side round-trip test for the fMP4 repacker.
// Run: node --experimental-vm-modules tools/test_repack.mjs
import { readFile, writeFile } from "node:fs/promises";
import { File } from "node:buffer";
import { parseFile, cleanMoov, isKeyframe } from "../public/mp4/parse.js";
import { buildOutput, buildOriginal } from "../public/mp4/write.js";

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ok -", msg);
  } else {
    failures++;
    console.error("  FAIL -", msg);
  }
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// Compare every sample's bytes/flags/dts/pts/duration between two models.
function compareSamples(a, b, label) {
  check(a.trackOrder.length === b.trackOrder.length, `${label}: 轨数一致`);
  for (const id of a.trackOrder) {
    const ta = a.tracks.get(id);
    const tb = b.tracks.get(id);
    check(!!tb, `${label}: 轨 ${id} 存在`);
    if (!tb) continue;
    check(ta.count === tb.count, `${label} 轨 ${id}: 样本数 ${ta.count} === ${tb.count}`);
    let mismatch = 0;
    for (let i = 0; i < ta.count; i++) {
      if (ta.dts[i] !== tb.dts[i] ||
          BigInt(ta.cts[i]) !== BigInt(tb.cts[i]) ||
          ta.duration[i] !== tb.duration[i] ||
          ta.size[i] !== tb.size[i] ||
          ta.sampleFlags[i] !== tb.sampleFlags[i]) mismatch++;
    }
    check(mismatch === 0, `${label} 轨 ${id}: 全部 DTS/CTS/时长/大小/标志一致${mismatch ? `（${mismatch} 处不符）` : ""}`);
  }
}

async function payloadBytesOf(model, trackId, gi) {
  const t = model.tracks.get(trackId);
  const buf = await model.file.slice(t.offset[gi], t.offset[gi] + t.size[gi]).arrayBuffer();
  return new Uint8Array(buf);
}

async function comparePayloadBytes(a, b, label) {
  for (const id of a.trackOrder) {
    const ta = a.tracks.get(id);
    const tb = b.tracks.get(id);
    let bad = 0;
    for (let i = 0; i < ta.count; i++) {
      const x = await payloadBytesOf(a, id, i);
      const y = await payloadBytesOf(b, id, i);
      if (x.length !== y.length || x.some((v, j) => v !== y[j])) bad++;
    }
    check(bad === 0, `${label} 轨 ${id}: 逐样本压缩字节完全一致${bad ? `（${bad} 个不符）` : ""}`);
  }
}

async function parseBytes(name, bytes) {
  const file = new File([bytes], name, { type: "video/mp4" });
  return parseFile(file);
}

async function main() {
  const path = process.argv[2] || "samples/extracted/two-tracks.mp4";
  const raw = await readFile(path);
  const file = new File([raw], "two-tracks.mp4", { type: "video/mp4" });

  console.log("== parse original ==");
  const model = await parseFile(file);
  check(model.trackOrder.length === 2, "两条轨");
  const video = model.tracks.get(model.videoId);
  const audio = model.tracks.get(model.audioId);
  console.log(`  video samples=${video.count} audio samples=${audio.count} fragments=${model.fragments.length}`);
  check(model.rangeErrors.length === 0, "无越界/重叠错误");
  check(isKeyframe(video, 0), "首视频样本为关键帧");
  const keyframes = [];
  for (let i = 0; i < video.count; i++) if (isKeyframe(video, i)) keyframes.push(i);
  console.log("  keyframes at", keyframes);
  check(keyframes.length >= 2, "存在多个关键帧");

  // display order differs from decode order somewhere (B frames)
  let reordered = false;
  for (let i = 0; i < video.count; i++) {
    if (video.displayOrder[i] !== i) { reordered = true; break; }
  }
  check(reordered, "视频显示顺序与解码顺序不同（含 B 帧重排）");

  // negative CTS present
  check(video.cts.some((v) => v < 0), "存在负 CTS 偏移");

  console.log("\n== case A: no extra cuts (single segment) ==");
  model.moovClean = await cleanMoov(model.moovBytes);
  const blobA = await buildOutput(model, [video.dts[0]], [0]);
  const bytesA = await blobBytes(blobA);
  await writeFile("/tmp/repack_A.mp4", bytesA);
  const modelA = await parseBytes("A.mp4", bytesA);
  check(modelA.fragments.length === 1, "输出仅 1 个段");
  compareSamples(model, modelA, "A");
  await comparePayloadBytes(model, modelA, "A");

  console.log("\n== case B: cut at every keyframe ==");
  const boundsB = keyframes.map((gi) => video.dts[gi]);
  const blobB = await buildOutput(model, boundsB, keyframes);
  const bytesB = await blobBytes(blobB);
  await writeFile("/tmp/repack_B.mp4", bytesB);
  const modelB = await parseBytes("B.mp4", bytesB);
  check(modelB.fragments.length === keyframes.length, `段数=${keyframes.length}`);
  compareSamples(model, modelB, "B");
  await comparePayloadBytes(model, modelB, "B");

  console.log("\n== case C: one middle cut ==");
  const cut = keyframes[Math.min(2, keyframes.length - 1)];
  const blobC = await buildOutput(model, [video.dts[0], video.dts[cut]], [0, cut]);
  const bytesC = await blobBytes(blobC);
  await writeFile("/tmp/repack_C.mp4", bytesC);
  const modelC = await parseBytes("C.mp4", bytesC);
  check(modelC.fragments.length === 2, "输出 2 个段");
  compareSamples(model, modelC, "C");
  await comparePayloadBytes(model, modelC, "C");
  // segment 1 must start at a keyframe
  const vC = modelC.tracks.get(modelC.videoId);
  check(isKeyframe(vC, 0) && vC.frag[0] === 0, "段1首样本为关键帧");

  console.log("\n== case D: original-scheme export ==");
  const blobD = await buildOriginal(model);
  const bytesD = await blobBytes(blobD);
  // moov is cleaned (index boxes dropped) but every moof/mdat byte is verbatim.
  const modelD = await parseBytes("D.mp4", bytesD);
  check(modelD.fragments.length === model.fragments.length, "原方案导出保留全部分片");
  let verbatim = true;
  for (let i = 0; i < model.fragments.length; i++) {
    const f = model.fragments[i];
    const g = modelD.fragments[i];
    if (f.moofSize !== g.moofSize || f.payloadEnd - f.payloadStart !== g.payloadEnd - g.payloadStart) {
      verbatim = false;
      break;
    }
    const oldPart = new Uint8Array(await model.file.slice(f.moofStart, f.payloadEnd).arrayBuffer());
    const newPart = new Uint8Array(await modelD.file.slice(g.moofStart, g.payloadEnd).arrayBuffer());
    if (oldPart.length !== newPart.length || oldPart.some((v, j) => v !== newPart[j])) {
      verbatim = false;
      break;
    }
  }
  check(verbatim, "原方案导出的 moof+mdat 字节与原文件逐字节一致");
  compareSamples(model, modelD, "D");

  console.log("\n== audio boundary tie rule ==");
  // Pick a boundary equal to an audio DTS and verify it lands in the later seg.
  const modelB2 = modelB;
  const a2 = modelB2.tracks.get(modelB2.audioId);
  let tieOk = true;
  for (let i = 0; i < a2.count; i++) {
    const d = a2.dts[i];
    const inSeg = a2.frag[i];
    // expected: last boundary <= d
    let expected = 0;
    for (let s = 0; s < boundsB.length; s++) if (boundsB[s] <= d) expected = s;
    if (inSeg !== expected) { tieOk = false; break; }
  }
  check(tieOk, "音频跨界包按起点归段、同刻进后段");

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
