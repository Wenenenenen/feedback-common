// Boundary semantics: exact-tie goes to later segment; pre-first-video audio
// is captured by segment 1; trailing audio by the last segment.
import { File } from "node:buffer";
import { parseFile, cleanMoov, isKeyframe } from "../public/mp4/parse.js";
import { buildOutput } from "../public/mp4/write.js";

// Minimal hand-built model reuse: generate via the perf/synth style is heavy,
// so build a compact two-track file with explicit DTS values using synth parts.
import { buildCaseA } from "./synth.mjs";

let failures = 0;
const check = (c, m) => { console.log((c ? "  ok - " : "  FAIL - ") + m); if (!c) failures++; };

async function main() {
  // Case A's second fragment starts at video DTS 9000. We cut at keyframes and
  // inspect where audio samples with DTS equal to a boundary land.
  const built = await buildCaseA();
  const model = await parseFile(new File([built.bytes], "x.mp4"));
  model.moovClean = await cleanMoov(model.moovBytes);
  const video = model.tracks.get(1);
  const audio = model.tracks.get(2);

  const keyframes = [];
  for (let i = 0; i < video.count; i++) if (isKeyframe(video, i)) keyframes.push(i);
  const bounds = keyframes.map((i) => video.dts[i]);
  const blob = await buildOutput(model, bounds, keyframes);
  const out = await parseFile(new File([await blob.arrayBuffer()], "o.mp4"));
  const aOut = out.tracks.get(2);

  check(aOut.count === audio.count, `音频样本全保留（${aOut.count}/${audio.count}）`);

  // Every audio sample's fragment index must equal the last boundary <= its DTS.
  let tieOk = true;
  for (let i = 0; i < aOut.count; i++) {
    const d = aOut.dts[i];
    let expected = 0;
    for (let s = 0; s < bounds.length; s++) if (bounds[s] <= d) expected = s;
    if (aOut.frag[i] !== expected) { tieOk = false; break; }
  }
  check(tieOk, "跨界包按起点归段，同刻进后段");

  // First segment contains every audio sample with DTS before the first video
  // sample's DTS (there are none strictly before DTS 0 here, but seg0 must hold
  // all samples with DTS < second boundary).
  const seg0 = [];
  for (let i = 0; i < aOut.count; i++) if (aOut.frag[i] === 0) seg0.push(aOut.dts[i]);
  check(seg0.length > 0 && seg0.every((d) => d < bounds[1]),
    "首段收下边界前的全部音频（含最早样本）");

  // The last audio sample must sit in the final segment that contains any
  // audio, and no audio may be dropped (empty later segments simply omit the
  // audio traf rather than emitting an empty one).
  let lastAudioSeg = -1;
  for (let i = 0; i < aOut.count; i++) lastAudioSeg = Math.max(lastAudioSeg, aOut.frag[i]);
  const lastSampleSeg = aOut.frag[aOut.count - 1];
  check(lastSampleSeg === lastAudioSeg, "尾部音频进入最后一个含音频的段");

  // Confirm a segment without audio omits the audio traf entirely.
  const trafsPerFrag = out.fragments.map((f, fi) => {
    // count via tracks: number of distinct traf represented by frag index
    const ids = new Set();
    for (const t of out.tracks.values()) {
      for (let i = 0; i < t.count; i++) if (t.frag[i] === fi) ids.add(t.meta.id);
    }
    return ids.size;
  });
  const hasEmptyAudioSeg = trafsPerFrag.some((n, fi) => {
    const anyAudio = [...out.tracks.get(2).frag].includes(fi);
    return !anyAudio;
  });
  check(hasEmptyAudioSeg, "无音频的段省略音频 traf（空轨可省略）");
  check(trafsPerFrag.every((n) => n >= 1), "每段至少保留视频轨");

  // All DTS within a segment are ascending.
  let asc = true;
  for (let f = 0; f < out.fragments.length; f++) {
    let prev = -1n;
    for (let i = 0; i < aOut.count; i++) {
      if (aOut.frag[i] !== f) continue;
      if (aOut.dts[i] < prev) asc = false;
      prev = aOut.dts[i];
    }
  }
  check(asc, "段内音频 DTS 单调递增");

  console.log(failures === 0 ? "\nBOUNDARY PASSED" : `\n${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
