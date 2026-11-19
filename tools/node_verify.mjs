// Node-side verification: run the browser engine and compare every pixel
// against the independent Python reference export.
// Usage: node tools/node_verify.mjs <input.json> <python_export.json>
import { readFileSync } from "node:fs";
import { rasterizeScene, clipPolygon, PLANE_NAMES } from "../src/engine.js";

const [inputPath, refPath] = process.argv.slice(2);
const scene = JSON.parse(readFileSync(inputPath, "utf8"));
const ref = JSON.parse(readFileSync(refPath, "utf8"));

const t0 = performance.now();
const result = await rasterizeScene(scene, { yieldEvery: 4096 });
const elapsed = (performance.now() - t0).toFixed(1);

const failures = [];
const { width, height } = result;
const npix = width * height;

if (ref.width !== width || ref.height !== height) {
  failures.push(`size mismatch ${ref.width}x${ref.height} vs ${width}x${height}`);
}

// 1. Per-pixel face / depth / rgb comparison.
let depthMaxErr = 0;
let rgbMaxErr = 0;
for (let i = 0; i < npix; i++) {
  const rp = ref.pixels[i];
  const gotFace = result.faceBuffer[i];
  if (gotFace !== rp.face) {
    failures.push(`pixel ${i} face: got ${gotFace}, ref ${rp.face}`);
    if (failures.length > 15) break;
  }
  if (rp.depth === null) {
    if (Number.isFinite(result.depthBuffer[i])) {
      failures.push(`pixel ${i} should be uncovered but has depth`);
    }
  } else {
    const de = Math.abs(result.depthBuffer[i] - rp.depth);
    depthMaxErr = Math.max(depthMaxErr, de);
    if (de > 1e-10) failures.push(`pixel ${i} depth err ${de}`);
    for (let ch = 0; ch < 3; ch++) {
      const re = Math.abs(result.rgb[ch][i] - rp.rgb[ch]);
      rgbMaxErr = Math.max(rgbMaxErr, re);
      if (re > 1e-10) failures.push(`pixel ${i} rgb[${ch}] err ${re}`);
    }
  }
}
if (failures.length > 15) failures.push("...truncated...");

// 2. Coverage array matches the optional reference coverage.
if (ref.coverage) {
  for (let i = 0; i < npix; i++) {
    if (result.coverage[i] !== ref.coverage[i]) {
      failures.push(`pixel ${i} coverage got ${result.coverage[i]} ref ${ref.coverage[i]}`);
      break;
    }
  }
}

// 3. Clipping invariants: every emitted vertex inside all six planes, w > EPS.
const planeDist = [
  (v) => v.x[3] + v.x[0],
  (v) => v.x[3] - v.x[0],
  (v) => v.x[3] + v.x[1],
  (v) => v.x[3] - v.x[1],
  (v) => v.x[2],
  (v) => v.x[3] - v.x[2],
];
for (const rec of result.faceRecords) {
  if (!rec || rec.degenerate || !rec.clippedPoly) continue;
  for (const v of rec.clippedPoly) {
    planeDist.forEach((d, pi) => {
      if (d(v) < -1e-12) {
        failures.push(`face ${rec.faceId} vertex outside ${PLANE_NAMES[pi]}`);
      }
    });
  }
}

// 4. A framebuffer write needs a covering fragment; overwrites by strictly
//    closer faces are legal, equal-depth rejection is checked by the
//    dedicated equal-depth case (face 0 keeps every overlapping pixel).
for (let i = 0; i < npix; i++) {
  if (result.writes[i] > result.coverage[i]) {
    failures.push(`pixel ${i} written ${result.writes[i]} > coverage ${result.coverage[i]}`);
  }
  if (result.faceBuffer[i] >= 0 && result.writes[i] === 0) {
    failures.push(`pixel ${i} has face but no write recorded`);
  }
}

console.log(`engine stats:`, JSON.stringify(result.stats));
console.log(`depthMaxErr=${depthMaxErr.toExponential(2)} rgbMaxErr=${rgbMaxErr.toExponential(2)} time=${elapsed}ms`);
if (failures.length) {
  console.error(`FAIL ${inputPath}: ${failures.length} failures`);
  for (const f of failures.slice(0, 20)) console.error(" -", f);
  process.exit(1);
}
console.log(`PASS ${inputPath}: all ${npix} pixels match the Python reference`);
