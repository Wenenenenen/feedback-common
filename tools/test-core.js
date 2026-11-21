/* Node test: read the sample raw files and check against truth.json. */
const fs = require("fs");
const path = require("path");
const LogCore = require("./log-core.js");

const dataDir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "image.json"), "utf8"));
const truth = JSON.parse(fs.readFileSync(path.join(dataDir, "truth.json"), "utf8"));
const { w, h, dx, dy, sigma0, ratio, levels, threshold } = meta;
const n = w * h;

const imgBuf = fs.readFileSync(path.join(dataDir, "spots.f32"));
const image = new Float64Array(n);
for (let i = 0; i < n; i++) image[i] = imgBuf.readFloatLE(i * 4);

let mask = new Uint8Array(n).fill(1);
const maskPath = path.join(dataDir, "mask.u8");
if (fs.existsSync(maskPath)) {
  const mBuf = fs.readFileSync(maskPath);
  for (let i = 0; i < n; i++) mask[i] = mBuf[i] ? 1 : 0;
}

const t0 = Date.now();
const { volume, peaks } = LogCore.run({
  width: w, height: h, dx, dy, sigma0, ratio, levels,
  image, mask,
  brightThreshold: threshold,
  darkThreshold: threshold,
});
const elapsed = Date.now() - t0;

for (let k = 0; k < levels; k++) {
  const nvalid = volume.valids[k].reduce((a, b) => a + b, 0);
  console.log(
    `level ${k} sigma=${volume.sigmas[k].toFixed(4)} nvalid=${nvalid}`
  );
}
console.log(`\n${peaks.length} peaks in ${elapsed} ms`);
for (const p of peaks) {
  console.log(
    `${p.kind} k=${p.level} row=${p.row} col=${p.col} ` +
      `resp=${p.response.toFixed(6)} refined=${p.refined}`
  );
  if (p.refined) {
    console.log(
      `   phys=(${p.refinedX.toFixed(3)}, ${p.refinedY.toFixed(3)}) ` +
        `sigma=${p.refinedSigma.toFixed(3)} ` +
        `resp_r=${p.refinedResponse.toFixed(6)} ` +
        `delta=(${p.deltaLevel.toFixed(3)},${p.deltaRow.toFixed(3)},` +
        `${p.deltaCol.toFixed(3)})`
    );
  }
}

// assertions against truth
const assertClose = (a, b, tol, label) => {
  if (Math.abs(a - b) > tol) {
    console.error(`FAIL ${label}: got ${a}, expected ${b}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}: ${a.toFixed(4)} ~ ${b}`);
  }
};
if (peaks.length !== 2) {
  console.error(`FAIL expected 2 peaks, got ${peaks.length}`);
  process.exitCode = 1;
}
const byKind = Object.fromEntries(peaks.map((p) => [p.kind, p]));
for (const [kind, t] of [["bright", truth.visible[0]], ["dark", truth.visible[1]]]) {
  const p = byKind[kind];
  if (!p) {
    console.error(`FAIL missing ${kind} peak`);
    process.exitCode = 1;
    continue;
  }
  assertClose(p.refinedX, t[0], 0.05, `${kind} x`);
  assertClose(p.refinedY, t[1], 0.05, `${kind} y`);
  assertClose(p.refinedSigma, t[2], 0.1, `${kind} sigma`);
  if (kind === "bright" && !(p.refinedResponse > 0)) {
    console.error("FAIL bright response sign");
    process.exitCode = 1;
  }
  if (kind === "dark" && !(p.refinedResponse < 0)) {
    console.error("FAIL dark response sign");
    process.exitCode = 1;
  }
}
// excluded blobs must not appear near truth.excluded positions
for (const e of truth.excluded) {
  for (const p of peaks) {
    if (Math.hypot(p.refinedX - e[0], p.refinedY - e[1]) < 1.0) {
      console.error(`FAIL excluded blob detected at ${e[0]},${e[1]}`);
      process.exitCode = 1;
    }
  }
}
console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
