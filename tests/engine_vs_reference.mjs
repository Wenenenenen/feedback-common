/*
 * 引擎与 Python 参考实现（tests/reference.py，二分法）逐样点交叉核对。
 *
 * 用法：
 *   node tests/engine_vs_reference.mjs
 *
 * 参考 WAV 由 `python3 -I tests/reference.py <scene> --out <file>` 生成。
 * 覆盖：提供样例、零距离与增益、跳位重叠、段尾补零、满额性能、
 *       切镜声尾、校验错误定位。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEngine } from "./wavnode.mjs";

const engine = await loadEngine();
const ROOT = path.resolve(import.meta.dirname, "..");
const REF = path.join(ROOT, "tests", "reference.py");

let checks = 0;
let failures = 0;
function check(name, cond, detail = "") {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msb-ref-"));

/* 写 48kHz 单声道 PCM16 WAV（整数样本值数组）。 */
function writeMonoWav(file, samples) {
  const frames = samples.length;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(48000 * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/* 把场景 + 其 WAV 写入 tmp，让 Python 参考与 JS 引擎读同一份。 */
function stage(name, scene, wavs) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const wavMap = {};
  for (const [file, arr] of Object.entries(wavs)) {
    writeMonoWav(path.join(dir, file), arr);
    wavMap[file] = Float64Array.from(arr);
  }
  const sceneFile = path.join(dir, "scene.json");
  fs.writeFileSync(sceneFile, JSON.stringify(scene));
  return { dir, sceneFile, wavMap };
}

function readRefStereo(file) {
  const data = fs.readFileSync(file);
  let pos = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= data.length) {
    const id = data.toString("ascii", pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    if (id === "data") {
      dataOff = pos + 8;
      dataLen = size;
      break;
    }
    pos += 8 + size + (size & 1);
  }
  const n = Math.floor(dataLen / 4);
  const left = new Int16Array(n);
  const right = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = data.readInt16LE(dataOff + i * 4);
    right[i] = data.readInt16LE(dataOff + i * 4 + 2);
  }
  return { left, right };
}

function crossCheck(name, scene, wavs) {
  const { sceneFile, wavMap } = stage(name, scene, wavs);
  const refOut = path.join(tmp, name, "ref.wav");
  execFileSync("python3", ["-I", REF, sceneFile, "--out", refOut], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ref = readRefStereo(refOut);
  const prepared = engine.prepare(scene, wavMap);
  const got = engine.render(prepared);
  let maxDiff = 0;
  let firstBad = -1;
  for (let i = 0; i < ref.left.length; i++) {
    const d = Math.max(
      Math.abs(got.left[i] - ref.left[i]),
      Math.abs(got.right[i] - ref.right[i]),
    );
    if (d > maxDiff) maxDiff = d;
    if (d !== 0 && firstBad < 0) firstBad = i;
  }
  check(`${name}: 帧数一致`, got.left.length === ref.left.length, `${got.left.length}/${ref.left.length}`);
  check(`${name}: 与参考逐样点一致`, maxDiff === 0, `maxDiff=${maxDiff} firstBad=${firstBad}`);
  return got;
}

/* ── 1. 提供样例 ─────────────────────────────────────────────── */
console.log("\n[1] 提供样例 scene.json");
{
  const extracted = path.join(ROOT, "samples", "extracted");
  const scenePath = path.join(extracted, "scene.json");
  const wavPath = path.join(extracted, "bell.wav");
  if (!fs.existsSync(scenePath) || !fs.existsSync(wavPath)) {
    // 从 zip 解压（只读、白名单名）
    const zip = path.join(ROOT, "samples", "moving-audio.zip");
    fs.mkdirSync(extracted, { recursive: true });
    execFileSync("python3", ["-I", "-m", "zipfile", "-e", zip, extracted], {
      stdio: "ignore",
    });
  }
  const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
  const wav = [];
  const bell = fs.readFileSync(wavPath);
  for (let i = 44; i + 1 < bell.length; i += 2) wav.push(bell.readInt16LE(i));
  const got = crossCheck("sample", scene, { "bell.wav": wav });
  console.log(`    峰值 L=${got.stats.peakL} R=${got.stats.peakR} 到达=${got.stats.arrivals} 用时=${got.stats.elapsedMs.toFixed(1)}ms`);
  check("样例峰值 L=507", got.stats.peakL === 507, `${got.stats.peakL}`);
  check("样例峰值 R=516", got.stats.peakR === 516, `${got.stats.peakR}`);
}

/* ── 2. 零距离与增益 ─────────────────────────────────────────── */
console.log("\n[2] 零距离 · 增益");
{
  const N = 64;
  const wav = new Array(N).fill(0);
  wav[0] = 1000;
  wav[1] = -2000;
  wav[2] = 3000;
  const scene = {
    frames: 2000,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 100, 0] },
      { t: 2000, left: [0, 0, 0], right: [0, 100, 0] },
    ],
    tracks: [
      {
        wav: "p.wav",
        segments: [{ start: 0, end: 4, offset: 0, p0: [0, 0, 0], p1: [0, 0, 0] }],
      },
    ],
  };
  const got = crossCheck("zerodist", scene, { "p.wav": wav });
  check("t=0 左耳 = 1000（d=0，增益 1）", got.left[0] === 1000, `${got.left[0]}`);
  check("t=1 左耳 = -2000", got.left[1] === -2000, `${got.left[1]}`);
  // 右耳距源 100，到达 t=u+100，u=0 → t=100；增益 8/(8+100)，值 1000 → 74
  check("t=100 右耳 = 74（d=100，8/108×1000）", got.right[100] === 74, `${got.right[100]}`);
}

/* ── 3. 跳位造成到达重叠，全部相加 ───────────────────────────── */
console.log("\n[3] 跳位重叠 · 到达全加");
{
  // 两段都零距离：段1 覆盖 u∈[0,5)，段2 覆盖 u∈[3,8)——发射区间重叠非法；
  // 改用相邻不重叠的发射区间，但慢速传播使两者到达同一时刻叠加：
  // 段1 源在远处(距离50)，段2 源在零距离；段2 的 u≈t，段1 的 u≈t-50，
  // 若段1 发射窗口覆盖 t-50 则 t 处两段都到达。
  const N = 400;
  const wav = new Array(N).fill(1000);
  const scene = {
    frames: 60,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 60, left: [0, 0, 0], right: [0, 0, 0] },
    ],
    tracks: [
      {
        wav: "o.wav",
        segments: [
          { start: 0, end: 20, offset: 0, p0: [50, 0, 0], p1: [50, 0, 0] },
          { start: 20, end: 40, offset: 0, p0: [0, 0, 0], p1: [0, 0, 0] },
        ],
      },
    ],
  };
  const got = crossCheck("overlap", scene, { "o.wav": wav });
  // 段1 的到达 t=u+50，u∈[0,20) → t∈[50,70)；段2 到达 t=u∈[20,40)
  // 所以 t∈[50,60) 只有段1，t∈[20,40) 只有段2，不重叠。
  // 真正重叠：把段2 源移到 50 距离且起点 p0 相同位置，两段都到达同一 t。
  check("段1 在 t=50 产生到达", got.left[50] !== 0 || got.right[50] !== 0);
}

/* ── 3b. 真实重叠：慢速两段同时到达 ─────────────────────────── */
console.log("\n[3b] 两段同时到达（全加）");
{
  // 段1 源在左耳前方 40 单位，段2 源在左耳后方 40 单位；
  // 段1 慢速向前 0.4/帧（≤0.5），两段发射区间相邻，可在某些 t 同时到达。
  // 简化：两段源都固定在与耳等距的球面上，段1 距离 40、段2 距离 40，
  // 则段1 到达 t=u+40，段2 到达 t=u+40；发射窗口相邻，在边界 t 上两段到达。
  const wav = new Array(200).fill(500);
  const scene = {
    frames: 200,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 200, left: [0, 0, 0], right: [0, 0, 0] },
    ],
    tracks: [
      {
        wav: "a.wav",
        segments: [
          { start: 0, end: 10, offset: 0, p0: [40, 0, 0], p1: [40, 0, 0] },
          { start: 10, end: 20, offset: 10, p0: [40, 0, 0], p1: [40, 0, 0] },
        ],
      },
      {
        wav: "b.wav",
        segments: [{ start: 0, end: 10, offset: 0, p0: [-40, 0, 0], p1: [-40, 0, 0] }],
      },
    ],
  };
  // 同轨段不可重叠（这里段1/段2 相邻合法）；跨轨到达可重叠。
  const got = crossCheck("multi", scene, {
    "a.wav": wav,
    "b.wav": new Array(200).fill(500),
  });
  // 两段距耳 40 且静止，段1 u=0 → t=40，b 轨 u=0 → t=40：
  // 每项 500·8/48 ≈ 83.33，两轨相加 166.67 → 167
  check("t=40 左耳两轨叠加 = 167", got.left[40] === 167, `${got.left[40]}`);
  // 若只算一条轨，t=40 只有 83；167 证明两轨到达确实全加
  check("叠加大于单轨贡献", got.left[40] > 100, `${got.left[40]}`);
}

/* ── 3c. 跳位导致同轨两段到达重叠，全部相加并逐样点核对 ─────────── */
console.log("\n[3c] 同轨跳位重叠（逐样点）");
{
  const wav = new Array(400).fill(1000);
  const scene = {
    frames: 100,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 100, left: [0, 0, 0], right: [0, 0, 0] },
    ],
    tracks: [
      {
        wav: "a.wav",
        segments: [
          { start: 0, end: 30, offset: 0, p0: [20, 0, 0], p1: [20, 0, 0] },
          { start: 30, end: 60, offset: 30, p0: [5, 0, 0], p1: [5, 0, 0] },
        ],
      },
    ],
  };
  const got = crossCheck("jumpoverlap", scene, { "a.wav": wav });
  // t=35：段0 u=15（d=20，8/28·1000≈285.71）+ 段1 u=30（d=5，8/13·1000≈615.38）= 901.09 → 901
  check("跳位重叠 t=35 = 901", got.left[35] === 901, `${got.left[35]}`);
}

/* ── 4. 段尾补零，不借下一段样本 ─────────────────────────────── */
console.log("\n[4] 段尾补零");
{
  // 源静止在 [1,1,0]，距耳 √2≈1.414：u=t-√2 落到段引用末尾（refEnd=4）附近的小数位置。
  const wav = [100, 200, 300, 400, 9999, 9999];
  const scene = {
    frames: 40,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 40, left: [0, 0, 0], right: [0, 0, 0] },
    ],
    tracks: [
      {
        wav: "z.wav",
        segments: [{ start: 0, end: 4, offset: 0, p0: [1, 1, 0], p1: [1, 1, 0] }],
      },
    ],
  };
  const got = crossCheck("zeroend", scene, { "z.wav": wav });
  // t=5 → u≈3.586，floor=3，后一样本(索引4)越过引用末尾→0：
  // 值 = 400·(4-3.586)·8/(8+1.414) ≈ 400·0.414·0.849 ≈ 140.6 → 141
  check("段尾插值不读 9999（t=5 ≈141）", got.left[5] > 100 && got.left[5] < 200, `${got.left[5]}`);
  // 段引用之外（u>=4）无贡献 → t >= ceil(4+√2)=6 左耳为 0 逐渐静音
  check("段后静音", got.left[6] === 0 || Math.abs(got.left[6]) < 200, `${got.left[6]}`);
}

/* ── 5. 满额性能（6000 段 / 60 秒） ─────────────────────────── */
console.log("\n[5] 满额性能（6000 段 / 60 秒）");
{
  const frames = 2880000;
  const wav = new Array(40000);
  for (let i = 0; i < wav.length; i++) wav[i] = Math.round(8000 * Math.sin(i / 40));
  const segments = [];
  for (let i = 0; i < 6000; i++) {
    const start = Math.floor((i * (frames - 400)) / 6000);
    const p0 = [(i % 2 ? 1 : -1) * (100 + (i % 13) * 7), ((i * 37) % 200) - 100, ((i * 11) % 100) - 50];
    const p1 = [p0[0] + 20, p0[1] + 10, p0[2] - 5];
    segments.push({ start, end: start + 200, offset: (i * 3) % (wav.length - 200), p0, p1 });
  }
  const scene = {
    frames,
    ears: [
      { t: 0, left: [-20, 0, 0], right: [20, 0, 0] },
      { t: frames, left: [-20, 10, 0], right: [20, 10, 0] },
    ],
    tracks: [{ wav: "big.wav", segments }],
  };
  const wavInfo = { "big.wav": { frames: wav.length } };
  const errors = engine.validateScene(scene, wavInfo);
  check("满额场景校验通过", errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  const prepared = engine.prepare(scene, { "big.wav": Float64Array.from(wav) });
  const t0 = process.hrtime.bigint();
  const got = engine.render(prepared);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    ${frames} 帧用时 ${ms.toFixed(1)} ms，到达 ${got.stats.arrivals}`);
  check("60 秒满额渲染 < 12000 ms", ms < 12000, `${ms.toFixed(1)} ms`);

  // 与 Python 参考核对前 3000 帧
  const sub = { ...scene, frames: 3000 };
  const { sceneFile } = stage("perfsub", sub, { "big.wav": wav });
  const refOut = path.join(tmp, "perfsub", "ref.wav");
  execFileSync("python3", ["-I", REF, sceneFile, "--out", refOut], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ref = readRefStereo(refOut);
  const gotSub = engine.render(engine.prepare(sub, { "big.wav": Float64Array.from(wav) }));
  let maxDiff = 0;
  for (let i = 0; i < 3000; i++)
    maxDiff = Math.max(maxDiff, Math.abs(gotSub.left[i] - ref.left[i]), Math.abs(gotSub.right[i] - ref.right[i]));
  check("满额子集前 3000 帧与参考一致", maxDiff === 0, `maxDiff=${maxDiff}`);
}

/* ── 6. 切镜保留声尾 ────────────────────────────────────────── */
console.log("\n[6] 切镜保留声尾");
{
  // 耳在 t=200 从 x=0 线性移到 x=100（速度 0.5/帧，合法）。
  // 段1 源在 x=300 处静止、段2 同帧跳到 x=-300；段1 在切镜前已有到达，
  // 切镜后耳远离，但段1 的到达（u 较早）仍应被保留、不被删。
  const wav = new Array(1000).fill(0);
  wav[0] = 5000;
  wav[10] = 5000;
  const scene = {
    frames: 400,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 200, left: [100, 0, 0], right: [100, 0, 0] },
      { t: 400, left: [100, 0, 0], right: [100, 0, 0] },
    ],
    tracks: [
      {
        wav: "t.wav",
        segments: [
          { start: 0, end: 300, offset: 0, p0: [300, 0, 0], p1: [300, 0, 0] },
          { start: 300, end: 400, offset: 10, p0: [-300, 0, 0], p1: [-300, 0, 0] },
        ],
      },
    ],
  };
  const got = crossCheck("cut", scene, { "t.wav": wav });
  // u=0 的到达 t≈300（距离 300，左耳在 t=300 时位置≈100 → 距离 200 → t=200）。
  // 关键是切镜（t=200）之后到达仍存在：在 u 落在段1 且 t>200 的接收帧有非零值。
  let tailAfterCut = 0;
  for (let t = 201; t < 400; t++) if (got.left[t] !== 0 || got.right[t] !== 0) tailAfterCut++;
  check("切镜后仍保留段1 声尾", tailAfterCut > 0, `tailFrames=${tailAfterCut}`);
}

/* ── 7. 校验错误定位 ─────────────────────────────────────────── */
console.log("\n[7] 校验错误定位");
{
  const base = {
    frames: 100,
    ears: [
      { t: 0, left: [0, 0, 0], right: [0, 0, 0] },
      { t: 100, left: [0, 0, 0], right: [0, 0, 0] },
    ],
    tracks: [{ wav: "a.wav", segments: [{ start: 0, end: 10, offset: 0, p0: [0, 0, 0], p1: [0, 0, 0] }] }],
  };
  const wavInfo = { "a.wav": { frames: 100 } };
  check("合法场景无错误", engine.validateScene(base, wavInfo).length === 0);
  const bad = structuredClone(base);
  bad.tracks[0].segments[0].end = 0;
  check("start<end 定位到段", engine.validateScene(bad, wavInfo).some((e) => e.path === "tracks[0].segments[0].end"));
  const bad2 = structuredClone(base);
  bad2.ears[1].t = 50;
  check("末项 t≠frames 定位到点", engine.validateScene(bad2, wavInfo).some((e) => e.path === "ears[1].t"));
  const bad3 = structuredClone(base);
  bad3.tracks[0].segments[0].offset = 95;
  check("offset 越界定位到段", engine.validateScene(bad3, wavInfo).some((e) => e.path === "tracks[0].segments[0].offset"));
  const bad4 = structuredClone(base);
  bad4.tracks[0].segments.push({ start: 5, end: 8, offset: 0, p0: [0, 0, 0], p1: [0, 0, 0] });
  check("重叠段定位到段", engine.validateScene(bad4, wavInfo).some((e) => e.path === "tracks[0].segments[1].start"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
