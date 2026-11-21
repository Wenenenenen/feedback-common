/* Node verification: JS core vs Python reference JSON. Run from repo root:
 * node -I tools/verify-core.js   (Node 22 supports -I? use: node tools/verify-core.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const MtfCore = require(path.join(__dirname, "..", "web", "mtf-core.js"));

const root = path.join(__dirname, "..");
const imgPath = path.join(root, "samples", "_extracted", "chart.u16");
const metaPath = path.join(root, "samples", "_extracted", "chart.json");
const refPath = path.join(root, "tools", "reference_results.json");

const buf = fs.readFileSync(imgPath);
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
const { w, h, rois } = meta;
if (buf.length !== w * h * 2) throw new Error("size mismatch");
const img = new Uint16Array(w * h);
for (let i = 0; i < w * h; i++) img[i] = buf.readUInt16LE(i * 2);

let failures = 0;
const maxAbs = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

rois.forEach((roi, idx) => {
  const got = MtfCore.analyzeRoi(img, w, h, roi);
  const want = ref.results[idx];
  const tag = `ROI${idx}`;
  if (got.valid !== want.valid) {
    console.log(`${tag} VALID mismatch: js=${got.valid} py=${want.valid} reason=${got.reason}`);
    failures++;
    return;
  }
  if (!want.valid) {
    console.log(`${tag} both invalid: ${want.reason}`);
    return;
  }
  const checks = [
    ["slope", got.edge.slope, want.slope, 1e-12],
    ["mtf50", got.mtf50, want.mtf50, 1e-9],
    ["mtf10", got.mtf10, want.mtf10, 1e-9],
  ];
  for (const [name, g, p, tol] of checks) {
    const d = Math.abs(g - p);
    if (d > tol) { console.log(`${tag} ${name}: js=${g} py=${p} d=${d}`); failures++; }
  }
  const curves = [
    ["esf", got.esf, want.esf],
    ["lsf", got.lsf, want.lsf],
    ["mtf", got.mtf, want.mtf],
    ["binCenters", got.binCenters, want.bin_centers],
  ];
  for (const [name, g, p] of curves) {
    const d = maxAbs(g, p);
    if (d > 1e-7 * Math.max(1, ...p.map(Math.abs))) {
      console.log(`${tag} ${name} maxAbsDelta=${d}`);
      failures++;
    }
  }
  const rejJs = got.edge.inliers.filter((v) => !v).length;
  const rejPy = want.inliers.filter((v) => !v).length;
  if (rejJs !== rejPy) { console.log(`${tag} rejected count ${rejJs} vs ${rejPy}`); failures++; }
  console.log(
    `${tag} OK slope=${got.edge.slope.toFixed(4)} mtf50=${got.mtf50.toFixed(6)} ` +
      `mtf10=${got.mtf10 === null ? "null" : got.mtf10.toFixed(6)} rejected=${rejJs}`
  );
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll JS/Python checks match.");
