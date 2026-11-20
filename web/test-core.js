/* Node test harness: node web/test-core.js
 * Cross-checks fbp-core.js against the Python reference outputs and the
 * shipped impulse-expected.json. Reads untrusted sample data via fs only. */
"use strict";
const fs = require("fs");
const path = require("path");
const FBP = require("./fbp-core.js");

const CASE = path.join(__dirname, "..", "_case_data");
const REF = "/tmp/fbp_ref_out";
let failures = 0;

function approx(a, b, tol) { return Math.abs(a - b) <= tol; }
function check(name, cond, detail) {
  if (cond) { console.log("PASS", name); }
  else { failures++; console.log("FAIL", name, detail || ""); }
}

function loadCase(jsonName) {
  const meta = JSON.parse(fs.readFileSync(path.join(CASE, jsonName), "utf8"));
  const bytes = fs.readFileSync(path.join(CASE, meta.data));
  // Buffer may share a pooled ArrayBuffer: hand over an exact-sized copy.
  const buf = bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return FBP.buildCase(meta, buf);
}

function readF32(file) {
  const b = fs.readFileSync(file);
  const n = b.length / 4;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = dv.getFloat32(i * 4, true);
  return a;
}

function readF64(file) {
  const b = fs.readFileSync(file);
  const n = b.length / 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = dv.getFloat64(i * 8, true);
  return a;
}

// ---- 1. impulse: exact match against shipped expected values ----
{
  const c = loadCase("impulse.json");
  const rec = FBP.reconstruct(c, { filtered: true });
  const expected = JSON.parse(
    fs.readFileSync(path.join(CASE, "impulse-expected.json"), "utf8")
  ).ram_lak_reconstruction;
  let ok = rec.image.length === expected.length;
  let worst = 0;
  for (let i = 0; ok && i < expected.length; i++) {
    worst = Math.max(worst, Math.abs(rec.image[i] - expected[i]));
    ok = ok && approx(rec.image[i], expected[i], 1e-15);
  }
  check("impulse Ram-Lak matches impulse-expected.json", ok,
    "worst=" + worst + " got=" + Array.from(rec.image));
}

// ---- 2. kernel literal values ----
{
  const h = FBP.ramLakKernel(5, 1);
  const exp = [0.25, -1 / (Math.PI * Math.PI), 0, -1 / (9 * Math.PI * Math.PI), 0];
  let ok = exp.every((v, i) => approx(h[i], v, 1e-18));
  check("kernel h[0], odd terms, even-zero convention", ok, Array.from(h));
}

// ---- 3. duplicate angle rejected ----
{
  let threw = false, msg = "";
  try {
    FBP.reconstruct(loadCase("duplicate-angle.json"), { filtered: true });
  } catch (e) { threw = true; msg = e.message; }
  check("duplicate angle rejected", threw && /重复角度/.test(msg), msg);
}

// ---- 4. phantom filtered/unfiltered match Python reference float-for-float-ish ----
{
  const c = loadCase("phantom.json");
  for (const [tag, filtered] of [["ramlak", true], ["unfilt", false]]) {
    const rec = FBP.reconstruct(c, { filtered });
    const ref = readF32(path.join(REF, `phantom-${tag}-ref.raw`));
    let worst = 0, worstRel = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(rec.image[i] - ref[i]);
      worst = Math.max(worst, d);
      // Python reference stores float32, so its rounding ceiling is ~6e-8*|v|.
      const tol = 1e-6 * Math.max(1, Math.abs(ref[i]));
      worstRel = Math.max(worstRel, d / tol);
    }
    check(`phantom ${tag} matches Python ref at float32 precision`,
      worstRel <= 1, "worst=" + worst + " worstTolRatio=" + worstRel);
    const ref64 = readF64(path.join(REF, `phantom-${tag}-ref.f64`));
    let worst64 = 0;
    for (let i = 0; i < ref64.length; i++) {
      worst64 = Math.max(worst64, Math.abs(rec.image[i] - ref64[i]));
    }
    check(`phantom ${tag} matches Python f64 arithmetic (tol 2e-13)`,
      worst64 <= 2e-13, "worst=" + worst64);
  }
}

// ---- 5. angle weights sum to pi ----
{
  const c = loadCase("phantom.json");
  const sorted = FBP.sortCase(c);
  const w = FBP.angleWeights(sorted.angles);
  const sum = w.reduce((a, b) => a + b, 0);
  check("phantom angle weights sum to pi", approx(sum, Math.PI, 1e-14),
    "sum=" + sum);
  const c1 = loadCase("impulse.json");
  const w1 = FBP.angleWeights(FBP.sortCase(c1).angles);
  check("single angle weight = pi", w1[0] === Math.PI);
}

// ---- 6. shuffled input gives identical reconstruction ----
{
  const meta = JSON.parse(fs.readFileSync(path.join(CASE, "phantom.json"), "utf8"));
  const A = meta.angles.length, D = meta.detectors;
  const rawBytes = fs.readFileSync(path.join(CASE, meta.data));
  const orig = new Float32Array(rawBytes.buffer.slice(
    rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength));
  const perm = Array.from({ length: A }, (_, i) => i);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = A - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const shuf = new Float32Array(A * D);
  const m2 = JSON.parse(JSON.stringify(meta));
  m2.angles = perm.map(i => meta.angles[i]);
  m2.offset = perm.map(i => meta.offset[i]);
  perm.forEach((src, r) => shuf.set(orig.subarray(src * D, src * D + D), r * D));
  const c1 = FBP.buildCase(meta, orig.buffer.slice(0));
  const c2 = FBP.buildCase(m2, shuf.buffer);
  const i1 = FBP.reconstruct(c1, { filtered: true }).image;
  const i2 = FBP.reconstruct(c2, { filtered: true }).image;
  let worst = 0;
  for (let i = 0; i < i1.length; i++) worst = Math.max(worst, Math.abs(i1[i] - i2[i]));
  check("shuffled-angle invariance (bit-identical)", worst === 0, "worst=" + worst);
}

// ---- 7. extra offset changes geometry; contribution sum equals image ----
{
  const c = loadCase("phantom.json");
  const rec = FBP.reconstruct(c, { filtered: true, extraOffset: 0 });
  const rec2 = FBP.reconstruct(c, { filtered: true, extraOffset: 1 });
  const diff = Math.max(...Array.from(rec.image, (v, i) => Math.abs(v - rec2.image[i])));
  check("extra offset moves reconstruction", diff > 0.5, "diff=" + diff);

  let sum = new Float64Array(rec.W * rec.H);
  for (let a = 0; a < rec.A; a++) {
    const contrib = FBP.angleContribution(rec, a);
    for (let i = 0; i < sum.length; i++) sum[i] += contrib[i];
  }
  let worst = 0;
  for (let i = 0; i < sum.length; i++) worst = Math.max(worst, Math.abs(sum[i] - rec.image[i]));
  check("per-angle contributions sum to reconstruction", worst <= 1e-10,
    "worst=" + worst);
}

// ---- 8. output size / pixel size options + limits ----
{
  const c = loadCase("phantom.json");
  const rec = FBP.reconstruct(c, { W: 48, H: 40, pixelSize: 1.25, filtered: true });
  check("custom W/H/pixelSize", rec.W === 48 && rec.H === 40 &&
    rec.image.length === 48 * 40 && rec.pixelSize === 1.25);
  let threw = false;
  try { FBP.reconstruct(c, { W: 257, H: 257 }); } catch (e) { threw = true; }
  check("257 output rejected", threw);
}

// ---- 9. PFM round trip: header, endianness, bottom-row order, negatives ----
{
  const W = 3, H = 2;
  // top-row-first image with a negative value
  const img = Float64Array.from([1, -2, 3, 4, 5.5, -6]);
  const bytes = FBP.encodePFM(img, W, H);
  const text = Buffer.from(bytes).toString("latin1");
  const headEnd = text.indexOf("\n", text.indexOf("\n", text.indexOf("\n") + 1) + 1) + 1;
  const header = text.slice(0, headEnd);
  check("PFM header", header === "Pf\n3 2\n-1.0\n", JSON.stringify(header));
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headEnd);
  const got = [];
  for (let i = 0; i < W * H; i++) got.push(dv.getFloat32(i * 4, true));
  // bottom row first: original row 1 then row 0
  const expect = [4, 5.5, -6, 1, -2, 3];
  const ok = got.every((v, i) => approx(v, expect[i], 0));
  check("PFM bottom-row order, LE, negatives preserved", ok, String(got));
}

// ---- 10. unfiltered path really uses q=p ----
{
  const c = loadCase("impulse.json");
  const rec = FBP.reconstruct(c, { filtered: false });
  const q0 = Array.from(rec.q);
  check("unfiltered q equals raw p", q0.every((v, i) => v === [0, 0, 1, 0, 0][i]),
    String(q0));
}

// ---- 11. PFM round trip against the actual reconstruction (bottom-row order) ----
{
  const c = loadCase("phantom.json");
  const rec = FBP.reconstruct(c, { filtered: true });
  const bytes = FBP.encodePFM(rec.image, rec.W, rec.H);
  const text = Buffer.from(bytes).toString("latin1");
  const headEnd = text.indexOf("\n", text.indexOf("\n", text.indexOf("\n") + 1) + 1) + 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headEnd);
  let worst = 0;
  for (let r = 0; r < rec.H; r++) {
    for (let col = 0; col < rec.W; col++) {
      const fileIndex = (rec.H - 1 - r) * rec.W + col; // bottom row first
      const got = dv.getFloat32(fileIndex * 4, true);
      const want = rec.image[r * rec.W + col];
      worst = Math.max(worst, Math.abs(got - Math.fround(want)));
    }
  }
  check("PFM pixel values match f32(rec), row order correct", worst === 0,
    "worst=" + worst);
}

// ---- 12. maximum output size 256x256 runs and is well-formed ----
{
  const c = loadCase("phantom.json");
  const rec = FBP.reconstruct(c, { W: 256, H: 256, filtered: true });
  let finite = true;
  for (const v of rec.image) if (!isFinite(v)) finite = false;
  check("256x256 reconstruction finite and sized",
    rec.image.length === 256 * 256 && finite);
  let threw = false;
  try { FBP.reconstruct(c, { W: 1, H: 257 }); } catch (e) { threw = true; }
  check("H=257 rejected", threw);
}

// ---- 13. detector interpolation: out-of-range t is exactly zero ----
{
  const q = Float64Array.from([1, 2, 3, 4]);
  check("interp out-of-range zero (left/right/NaN)",
    FBP.sampleQ(q, 4, -0.001) === 0 && FBP.sampleQ(q, 4, 3.001) === 0 &&
    FBP.sampleQ(q, 4, NaN) === 0);
  check("interp inner value", FBP.sampleQ(q, 4, 1.5) === 2.5);
  check("interp endpoint", FBP.sampleQ(q, 4, 3) === 4);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
