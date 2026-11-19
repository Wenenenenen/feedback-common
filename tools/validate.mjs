// Validation against the shipped reference annotations (not used by the app).
// Run: node tools/validate.mjs
import { readFileSync } from "node:fs";
import { decodeWav } from "../src/wav.js";
import { trackPitch, noteFromHz } from "../src/tracker.js";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = ROOT + "samples/extracted/";
const DEFAULT_PARAMS = {
  windowMs: 80,
  fMin: 60,
  fMax: 1000,
  yinThreshold: 0.15,
  voicedThreshold: 0.5,
};

function load(wavName) {
  const buf = readFileSync(DATA + wavName);
  const { samples, sampleRate, bitsPerSample, duration } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { samples, sampleRate, bitsPerSample, duration };
}

function pct(n, d) { return (100 * n / d).toFixed(1) + "%"; }

async function checkPhrases(wavName, refName, params) {
  const { samples, sampleRate } = load(wavName);
  const ref = JSON.parse(readFileSync(DATA + refName, "utf8"));
  const t0 = Date.now();
  const out = await trackPitch(samples, sampleRate, params);
  console.log(`\n=== ${wavName} (${sampleRate} Hz, window ${params.windowMs}ms) ${Date.now() - t0}ms, ${out.frames.length} frames ===`);
  const excl = ref.boundaryExclusionMs ?? 100;
  let allOk = true;
  for (const seg of ref.segments) {
    const t0s = seg.start_frame / sampleRate + excl / 1000;
    const t1s = seg.end_frame / sampleRate - excl / 1000;
    const fr = out.frames.filter((f) => f.timeS >= t0s && f.timeS < t1s);
    const voiced = fr.filter((f) => f.voiced);
    if (seg.hz == null) {
      const bad = voiced.length;
      const ok = bad === 0;
      allOk &= ok;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${seg.kind.padEnd(18)} expect unvoiced: ${fr.length} frames, ${bad} wrongly voiced`);
    } else {
      const errs = voiced.map((f) => 1200 * Math.log2(f.hz / seg.hz));
      const med = errs.length ? Math.abs(errs.sort((a, b) => Math.abs(a) - Math.abs(b))[Math.floor(errs.length / 2)]) : NaN;
      const max = errs.length ? Math.max(...errs.map(Math.abs)) : NaN;
      const coverage = voiced.length / fr.length;
      const ok = coverage >= 0.9 && med < 50 && max < 120;
      allOk &= ok;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${seg.kind.padEnd(18)} expect ${seg.hz}Hz: coverage ${pct(voiced.length, fr.length)}, median |err| ${med.toFixed(1)} cents, max ${max.toFixed(1)}`);
    }
  }
  return allOk;
}

async function checkGlide(wavName, refName, params) {
  const { samples, sampleRate } = load(wavName);
  const ref = JSON.parse(readFileSync(DATA + refName, "utf8"));
  const out = await trackPitch(samples, sampleRate, params);
  console.log(`\n=== ${wavName} (glide+vibrato, window ${params.windowMs}ms) ===`);
  const byFrame = new Map(out.frames.map((f) => [f.centerFrame, f]));
  const errs = [];
  let unvoiced = 0;
  for (const p of ref) {
    const f = byFrame.get(p.center_frame);
    if (!f || !f.voiced) { unvoiced++; continue; }
    errs.push({ c: p.center_frame, cents: 1200 * Math.log2(f.hz / p.hz), got: f.hz, want: p.hz });
  }
  const abs = errs.map((e) => Math.abs(e.cents)).sort((a, b) => a - b);
  if (abs.length === 0) {
    console.log(`  FAIL coverage 0% (all ${unvoiced} frames unvoiced)`);
    return false;
  }
  const med = abs[Math.floor(abs.length / 2)];
  const p95 = abs[Math.floor(abs.length * 0.95)];
  const max = abs[abs.length - 1];
  // glide tracking: median within ~25 cents, coverage >= 95%
  const coverage = errs.length / ref.length;
  const ok = coverage >= 0.95 && med < 25 && p95 < 60;
  console.log(`  ${ok ? "PASS" : "FAIL"} coverage ${pct(errs.length, ref.length)} (${unvoiced} unvoiced), median |err| ${med.toFixed(1)} cents, p95 ${p95.toFixed(1)}, max ${max.toFixed(1)}`);
  // vibrato must be preserved: successive deltas should oscillate
  const voicedSeq = ref.map((p) => byFrame.get(p.center_frame)).filter((f) => f && f.voiced);
  let turns = 0;
  let prevDir = 0;
  for (let i = 2; i < voicedSeq.length; i++) {
    const d = voicedSeq[i].hz - voicedSeq[i - 1].hz;
    const dir = Math.sign(d);
    if (dir !== 0 && prevDir !== 0 && dir !== prevDir) turns++;
    if (dir !== 0) prevDir = dir;
  }
  console.log(`       vibrato direction reversals: ${turns} (expect many, >20)`);
  return ok && turns > 20;
}

const ok1 = await checkPhrases("phrases-48000-16.wav", "phrases-48000-16-reference.json", DEFAULT_PARAMS);
const ok2 = await checkPhrases("phrases-44100-24.wav", "phrases-44100-24-reference.json", DEFAULT_PARAMS);
const ok3 = await checkGlide("glide-vibrato.wav", "glide-vibrato-reference.json", DEFAULT_PARAMS);

// 40 ms window sanity
const ok4 = await checkPhrases("phrases-48000-16.wav", "phrases-48000-16-reference.json", { ...DEFAULT_PARAMS, windowMs: 40 });

// note naming sanity
const n = noteFromHz(440, 440);
console.log("\nnote naming:", noteFromHz(261.63, 440), noteFromHz(440, 442), n);

// ---- extended parameter robustness ----
let extOk = true;
extOk &&= await checkPhrases("phrases-48000-16.wav", "phrases-48000-16-reference.json",
  { ...DEFAULT_PARAMS, voicedThreshold: 0.85 });
// restricted search range that still contains all targets (60..1000 -> 80..500)
extOk &&= await checkPhrases("phrases-48000-16.wav", "phrases-48000-16-reference.json",
  { ...DEFAULT_PARAMS, fMin: 80, fMax: 500 });
// stricter YIN threshold still tracks clean tones
extOk &&= await checkPhrases("phrases-44100-24.wav", "phrases-44100-24-reference.json",
  { ...DEFAULT_PARAMS, yinThreshold: 0.1 });

// A4 reference range 416..466 and naming boundaries
const naming = [
  noteFromHz(440, 416), noteFromHz(440, 466),
  noteFromHz(261.6256, 440), // C4
  noteFromHz(277.1826, 440), // C#4
];
const namingOk = naming.every((x) => x.note && Number.isFinite(x.cents) && Math.abs(x.cents) <= 50);
console.log("A4-range naming:", namingOk ? "PASS" : "FAIL", JSON.stringify(naming));
extOk &&= namingOk;

// frame convention: center frames 0,H,2H,... while < L; H = rate/100
const { samples: s2, sampleRate: r2 } = load("phrases-48000-16.wav");
const out2 = await trackPitch(s2, r2, DEFAULT_PARAMS);
const H = Math.round(r2 / 100);
const convOk = out2.frames.every((f, i) => f.centerFrame === i * H) &&
  out2.frames[0].centerFrame === 0 &&
  out2.frames[out2.frames.length - 1].centerFrame < s2.length &&
  out2.frames.every((f) => f.voiced === (f.hz !== null));
console.log("frame convention + voiced/null invariant:", convOk ? "PASS" : "FAIL");
extOk &&= convOk;

console.log(ok1 && ok2 && ok3 && ok4 && extOk ? "\nALL PASS" : "\nSOME CHECKS FAILED");
process.exit(ok1 && ok2 && ok3 && ok4 && extOk ? 0 : 1);
