// Verify the pixel inspector re-derives stored framebuffer values.
import { readFileSync } from "node:fs";
import { rasterizeScene } from "../src/engine.js";
import { inspectPixel } from "../src/inspector.js";

const scene = JSON.parse(readFileSync(process.argv[2], "utf8"));
const r = await rasterizeScene(scene, { yieldEvery: 4096 });
const { width, height } = r;
let checked = 0;
let uncovered = 0;
const failures = [];

for (let py = 0; py < height; py++) {
  for (let px = 0; px < width; px++) {
    const idx = py * width + px;
    const info = inspectPixel(r, scene, px, py);
    if (r.faceBuffer[idx] < 0) {
      if (info.covered || info.faceId !== -1) failures.push(`uncovered pixel ${px},${py} misreported`);
      uncovered++;
      continue;
    }
    if (!info.covered || info.faceId !== r.faceBuffer[idx]) {
      failures.push(`pixel ${px},${py} face mismatch`);
      continue;
    }
    const d = info.derivation;
    if (!d) {
      failures.push(`pixel ${px},${py} missing derivation`);
      continue;
    }
    // barycentric weights sum to 1
    if (Math.abs(d.barySum - 1) > 1e-10) failures.push(`pixel ${px},${py} bary sum ${d.barySum}`);
    // re-derived depth/color match the stored framebuffer
    if (Math.abs(d.depth - r.depthBuffer[idx]) > 1e-12)
      failures.push(`pixel ${px},${py} depth ${d.depth} vs ${r.depthBuffer[idx]}`);
    for (let ch = 0; ch < 3; ch++) {
      if (Math.abs(d.color[ch] - r.rgb[ch][idx]) > 1e-12)
        failures.push(`pixel ${px},${py} rgb[${ch}] mismatch`);
    }
    // all weights non-negative for an interior sample
    const w = [d.barycentric.a, d.barycentric.b, d.barycentric.c];
    if (w.some((x) => x < -1e-12)) failures.push(`pixel ${px},${py} negative bary ${w}`);
    checked++;
  }
}

// degenerate / invalid faces must produce a record but no sub-triangles
const badFaces = r.faceRecords.filter((rec) => rec && (rec.degenerate || !rec.valid));
for (const rec of badFaces) {
  if (rec.subTriangles && rec.subTriangles.length) failures.push(`face ${rec.faceId} should have no sub-triangles`);
}

console.log(`inspector: checked ${checked} covered, ${uncovered} uncovered, ${badFaces.length} skipped faces`);
if (failures.length) {
  console.error(`FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 15)) console.error(" -", f);
  process.exit(1);
}
console.log("PASS: inspector re-derivation matches framebuffer for every pixel");
