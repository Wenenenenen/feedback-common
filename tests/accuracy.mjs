/*
 * 精度核对：引擎的牛顿/二分混合解 vs Python 二分参考（tol 1e-12）。
 * 随机抽样大量 (t, side, segment)，比较 u 与 gain 误差。
 * 规格：u 显示误差 ≤1e-5 帧，gain 误差 ≤1e-6。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEngine } from "./wavnode.mjs";

const engine = await loadEngine();
const ROOT = path.resolve(import.meta.dirname, "..");
const REF = path.join(ROOT, "tests", "reference.py");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msb-acc-"));

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
  buf.writeUInt32LE(96000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// 随机但合法的场景：耳速≤0.5，源速≤0.5，跨度大
function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const R = rnd(12345);
const ri = (a, b) => a + Math.floor(R() * (b - a + 1));

const frames = 200000;
const ears = [];
{
  // 8 个关键点，间隔 25000 帧，每步位移 ≤ 12500
  let L = [0, 0, 0];
  let Rt = [100, 0, 0];
  ears.push({ t: 0, left: L.slice(), right: Rt.slice() });
  for (let k = 1; k <= 8; k++) {
    const step = 25000;
    const mk = () => {
      const mag = R() * 0.5 * step * 0.98;
      const th = R() * Math.PI * 2;
      const ph = Math.acos(2 * R() - 1);
      return [
        Math.round(mag * Math.sin(ph) * Math.cos(th)),
        Math.round(mag * Math.sin(ph) * Math.sin(th)),
        Math.round(mag * Math.cos(ph)),
      ];
    };
    const dl = mk();
    const dr = mk();
    L = [L[0] + dl[0], L[1] + dl[1], L[2] + dl[2]];
    Rt = [Rt[0] + dr[0], Rt[1] + dr[1], Rt[2] + dr[2]];
    ears.push({ t: k * step, left: L.slice(), right: Rt.slice() });
  }
}

const segments = [];
for (let i = 0; i < 40; i++) {
  const start = ri(0, frames - 5000);
  const len = ri(500, 5000);
  const p0 = [ri(-5000, 5000), ri(-5000, 5000), ri(-5000, 5000)];
  const maxd = Math.floor(len * 0.5 * 0.95);
  // 方向随机、范数 ≤ maxd（避免三分量各自取满导致超速）
  const th = R() * Math.PI * 2;
  const ph = Math.acos(2 * R() - 1);
  const mag = Math.floor(R() * maxd);
  const dx = Math.round(mag * Math.sin(ph) * Math.cos(th));
  const dy = Math.round(mag * Math.sin(ph) * Math.sin(th));
  const dz = Math.round(mag * Math.cos(ph));
  segments.push({ start, end: start + len, offset: 0, p0, p1: [p0[0] + dx, p0[1] + dy, p0[2] + dz] });
}

// 保证同轨不重叠，但抽样只关心解，用多轨各 1 段更简单：拆成 40 轨非法（>8），
// 所以把 40 段分布到 8 轨，各自排序后允许不相邻（不重叠）
segments.sort((a, b) => a.start - b.start);
const tracks = Array.from({ length: 8 }, () => ({ wav: "a.wav", segments: [] }));
let cur = 0;
for (const s of segments) {
  tracks[cur % 8].segments.push(s);
  cur++;
}
// 每轨内部排序并确保不重叠：跳过与上一段冲突的
for (const tr of tracks) {
  tr.segments.sort((a, b) => a.start - b.start);
  const out = [];
  let prevEnd = -1;
  for (const s of tr.segments) {
    if (s.start >= prevEnd) {
      out.push(s);
      prevEnd = s.end;
    }
  }
  tr.segments = out;
}
const scene = { frames, ears, tracks };
const wav = new Array(20000);
for (let i = 0; i < wav.length; i++) wav[i] = ri(-20000, 20000);

const errs = engine.validateScene(scene, { "a.wav": { frames: wav.length } });
if (errs.length) {
  console.log("场景非法：", errs.slice(0, 5));
  process.exit(1);
}

const dir = path.join(tmp, "acc");
fs.mkdirSync(dir);
writeMonoWav(path.join(dir, "a.wav"), wav);
fs.writeFileSync(path.join(dir, "scene.json"), JSON.stringify(scene));
const prepared = engine.prepare(scene, { "a.wav": Float64Array.from(wav) });

// 抽样 400 个整数帧 × 2 耳，与 Python 参考逐项比较
const sampleFrames = [];
for (let i = 0; i < 400; i++) sampleFrames.push(ri(0, frames - 1));
sampleFrames.push(0, 1, frames - 1, frames - 2, 125000, 250000);

// Python：对每个抽样帧输出全部到达
const py = `
import json,sys
sys.path.insert(0,'${ROOT}/tests')
import reference as rf
scene=json.load(open('${path.join(dir, "scene.json")}'))
wavbt=open('${path.join(dir, "a.wav")}','rb').read()
wav=rf.read_wav_pcm16('${path.join(dir, "a.wav")}')
wavs=[wav]*len(scene["tracks"])
frames=[${sampleFrames.join(",")}]
out=[]
for t in frames:
    for side in ("left","right"):
        cs=rf.contributions_at(scene,wavs,t,side)
        for c in cs:
            out.append([t,side,c["track"],c["segment"],c["u"],c["gain"],c["value"],c["q"]])
print(json.dumps(out))
`;
const pyOut = execFileSync("python3", ["-I", "-c", py], { encoding: "utf8" });
const ref = JSON.parse(pyOut);

// 引擎：对同样帧做 inspectFrame
let maxUErr = 0;
let maxGainErr = 0;
let maxResidual = 0;
let compared = 0;
let mismatchedSets = 0;
const byFrame = new Map();
for (const r of ref) {
  const key = r[0] + "|" + r[1];
  if (!byFrame.has(key)) byFrame.set(key, []);
  byFrame.get(key).push(r);
}
for (const t of sampleFrames) {
  for (const side of ["left", "right"]) {
    const got = engine.inspectFrame(prepared, t, side);
    const want = byFrame.get(t + "|" + side) || [];
    if (got.length !== want.length) mismatchedSets++;
    const gs = new Map(got.map((g) => [`${g.track}|${g.segment}`, g]));
    for (const w of want) {
      const g = gs.get(`${w[2]}|${w[3]}`);
      if (!g) continue;
      maxUErr = Math.max(maxUErr, Math.abs(g.u - w[4]));
      maxGainErr = Math.max(maxGainErr, Math.abs(g.gain - w[5]));
      // 声程核对：||S(u)-E(t)|| vs d
      const p = segPoint(w[2], w[3], g.u);
      const E = earPoint(side, t);
      const dist = Math.hypot(p[0] - E[0], p[1] - E[1], p[2] - E[2]);
      maxResidual = Math.max(maxResidual, Math.abs(dist - (t - g.u)));
      compared++;
    }
  }
}
function segPoint(ti, si, u) {
  const s = scene.tracks[ti].segments[si];
  const f = (u - s.start) / (s.end - s.start);
  return [
    s.p0[0] + (s.p1[0] - s.p0[0]) * f,
    s.p0[1] + (s.p1[1] - s.p0[1]) * f,
    s.p0[2] + (s.p1[2] - s.p0[2]) * f,
  ];
}
function earPoint(side, t) {
  // 与引擎一致的分段线性
  let k = 0;
  const ts = ears.map((e) => e.t);
  while (k + 1 < ts.length && ts[k + 1] <= t) k++;
  const k2 = Math.min(k + 1, ts.length - 1);
  const f = ts[k2] > ts[k] ? (t - ts[k]) / (ts[k2] - ts[k]) : 0;
  const a = ears[k][side];
  const b = ears[k2][side];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

console.log(`比较到达项 ${compared}，集合不一致帧 ${mismatchedSets}`);
console.log(`max |Δu| = ${maxUErr.toExponential(3)} 帧（限 1e-5）`);
console.log(`max |Δgain| = ${maxGainErr.toExponential(3)}（限 1e-6）`);
console.log(`max 声程残差 = ${maxResidual.toExponential(3)}`);
const ok = compared > 200 && maxUErr <= 1e-5 && maxGainErr <= 1e-6 && maxResidual <= 1e-6;
console.log(ok ? "精度 OK" : "精度不足");
fs.rmSync(tmp, { recursive: true, force: true });
if (!ok) process.exitCode = 1;
