/* Node tests for rectifier.js. Run: node tools/test-rectifier.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../rectifier.js");

const dataDir = process.argv[2] || "samples/extracted";
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL - ${name}: ${e.message}`);
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------- sample probes ----------
for (const name of ["still", "down", "up", "partial"]) {
  const params = loadJson(path.join(dataDir, `${name}.json`));
  const probes = loadJson(path.join(dataDir, `${name}-probes.json`));
  const height = 96, width = 128;
  const integ = R.createIntegrator(params.gyro);

  check(`${name}: forward projection matches probes`, () => {
    for (const [px, py, ex, ey] of probes) {
      const got = R.forwardPoint(params, integ, height, px, py, params.t_ref);
      assert.ok(Math.hypot(got.x - ex, got.y - ey) < 1e-9,
        `(${px},${py}) got (${got.x},${got.y}) want (${ex},${ey})`);
    }
  });

  check(`${name}: inverse resampling round-trips`, () => {
    for (const [px, py] of probes) {
      const fwd = R.forwardPoint(params, integ, height, px, py, params.t_ref);
      const inv = R.inversePoint(params, integ, width, height, fwd.x, fwd.y,
        params.t_ref);
      assert.ok(inv, "bracket missing");
      assert.ok(Math.hypot(inv.x - px, inv.y - py) < 1e-7,
        `roundtrip (${px},${py}) -> (${inv.x},${inv.y})`);
    }
  });
}

// ---------- row timing conventions ----------
check("row times: down first row 0 fraction, up last row 0 fraction", () => {
  const base = { start: 0, readout: 0.04, height: 96 };
  const down = { ...base, direction: "down" };
  const up = { ...base, direction: "up" };
  assert.strictEqual(R.rowTime(down, 0, 96), 0);
  assert.strictEqual(R.rowTime(down, 95, 96), 0.04);
  assert.strictEqual(R.rowTime(up, 95, 96), 0);
  assert.strictEqual(R.rowTime(up, 0, 96), 0.04);
  assert.strictEqual(R.rowTime(down, 48, 96),
    0.04 * 48 / 95);
});

// ---------- coverage flags ----------
check("partial case: rows 0..23 and 72..95 outside gyro coverage", () => {
  const params = loadJson(path.join(dataDir, "partial.json"));
  const integ = R.createIntegrator(params.gyro);
  for (let y = 0; y < 96; y++) {
    const t = R.rowTime(params, y, 96);
    const expectCovered = integ.tMin <= t && t <= integ.tMax;
    if (y >= 24 && y <= 71) assert.ok(expectCovered, `row ${y} should cover`);
    else assert.ok(!expectCovered, `row ${y} should not cover`);
  }
  // inverse point on an uncovered row must report covered=false
  const hit = R.inversePoint(params, integ, 128, 96, 64, 0, params.t_ref);
  assert.ok(hit && !hit.covered, "top row must be uncovered");
});

// ---------- variable omega, non-uniform times ----------
// Ground truth convention: angular velocity is linearly interpolated between
// samples (per 说明.txt). A reference built from tiny constant-omega
// microsteps would solve a *different* ODE, so we validate two ways:
//   1) self-convergence: halving the effective step cap must stop changing
//      the result (the integrator has converged to its own limit);
//   2) cross-check against an independent Python implementation of the same
//      convention (see tools/verify_math.py), expected below 1e-11.
check("non-uniform variable-omega integration has converged", () => {
  const w = (t) => [0.2 * t, -0.1 * Math.sin(t), 0.5];
  const ts = [0, 0.013, 0.041, 0.09, 0.22, 0.4, 0.71];
  const gyro = ts.map((t) => [t, ...w(t)]);
  const integ = R.createIntegrator(gyro);
  const got = integ.rotation(0.31, 0.58);

  // Independent fine midpoint solver honoring linear inter-ample interpolation.
  function fine(t0, t1, perStep) {
    const bounds = [t0, ...ts.filter((t) => t0 < t && t < t1), t1];
    let Q = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let s = 0; s < bounds.length - 1; s++) {
      const a = bounds[s], b = bounds[s + 1], span = b - a;
      const n = Math.max(1, Math.ceil(span / perStep));
      const h = span / n;
      for (let k = 0; k < n; k++) {
        const tm = a + h * (k + 0.5);
        Q = R.matMul(Q, R.rodrigues(integ.wAt(tm), h));
      }
    }
    return Q;
  }
  const f1 = fine(0.31, 0.58, 1e-3);
  const f2 = fine(0.31, 0.58, 2.5e-4);
  const f3 = fine(0.31, 0.58, 6.25e-5);
  let convErr = 0;
  for (let i = 0; i < 9; i++) {
    convErr = Math.max(convErr, Math.abs(f2[i] - f3[i]));
  }
  assert.ok(convErr < 1e-9, `reference not converged: ${convErr}`);

  let err = 0;
  for (let i = 0; i < 9; i++) {
    err = Math.max(err, Math.abs(got[i] - f2[i]));
  }
  assert.ok(err < 1e-9, `integrator vs fine reference: ${err}`);

  // Independently computed by tools/verify_math.py (same conventions).
  const pythonRef = [
    [0.990837565707, -0.134711865033, -0.009676352817],
    [0.134439069608, 0.990611734192, -0.024789688276],
    [0.012924973786, 0.023261674516, 0.999645857067],
  ].flat();
  let crossErr = 0;
  for (let i = 0; i < 9; i++) {
    crossErr = Math.max(crossErr, Math.abs(got[i] - pythonRef[i]));
  }
  assert.ok(crossErr < 1e-10, `cross-language mismatch: ${crossErr}`);

  // backwards in time must be the transpose (inverse)
  const back = integ.rotation(0.58, 0.31);
  const prod = R.matMul(got, back);
  for (let i = 0; i < 9; i++) {
    const diag = i % 4 === 0 ? 1 : 0;
    assert.ok(Math.abs(prod[i] - diag) < 1e-10, "inverse mismatch");
  }
});

// ---------- still case is identity mapping ----------
check("still image maps every pixel to itself", () => {
  const params = loadJson(path.join(dataDir, "still.json"));
  const integ = R.createIntegrator(params.gyro);
  for (const [x, y] of [[0, 0], [63.5, 47.5], [127, 95], [10, 88]]) {
    const p = R.forwardPoint(params, integ, 96, x, y, params.t_ref);
    assert.ok(Math.abs(p.x - x) < 1e-12 && Math.abs(p.y - y) < 1e-12);
  }
});

// ---------- t_ref outside coverage ----------
check("t_ref outside gyro range marks points uncovered", () => {
  const params = loadJson(path.join(dataDir, "down.json"));
  const integ = R.createIntegrator(params.gyro);
  const p = R.forwardPoint(params, integ, 96, 35, 25, 0.5);
  assert.ok(!p.covered);
});

// ---------- validation ----------
check("rejects non-increasing gyro times and malformed samples", () => {
  assert.throws(() => R.createIntegrator([[0, 0, 0, 0], [0, 1, 1, 1]]));
  assert.throws(() => R.createIntegrator([[0, 0, 0]]));
  assert.throws(() => R.createIntegrator([[0, 0, 0, NaN]]));
});

// ---------- full rectify: still image is copied, alpha 255 ----------
check("rectifyImage keeps still image identical and fully opaque", () => {
  const params = loadJson(path.join(dataDir, "still.json"));
  const integ = R.createIntegrator(params.gyro);
  const w = 128, h = 96;
  const src = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    src[i * 4] = seed % 256;
    src[i * 4 + 1] = (seed >> 3) % 256;
    src[i * 4 + 2] = (seed >> 7) % 256;
    src[i * 4 + 3] = 255;
  }
  const { out, stats } = R.rectifyImage(params, integ, src, w, h,
    params.t_ref);
  assert.strictEqual(stats.nUncovered, 0);
  assert.strictEqual(stats.nOutside, 0);
  let maxDiff = 0;
  for (let i = 0; i < w * h * 4; i++) maxDiff = Math.max(maxDiff,
    Math.abs(out[i] - src[i]));
  // bilinear sampling at identical integer coords is exact
  assert.strictEqual(maxDiff, 0);
});

// The page inlines a hand-copied Rectifier in index.html; guard against drift
// by requiring byte-identical rectification output from both implementations.
(function checkInlineCopy() {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(
    /const Rectifier = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
  if (!match) { failures++; return console.error("  FAIL - inline block missing"); }
  const tmp = path.join(require("os").tmpdir(), `inline-rect-${process.pid}.cjs`);
  fs.writeFileSync(tmp, match[0].replace("const Rectifier =", "module.exports ="));
  delete require.cache[tmp];
  const Inline = require(tmp);
  fs.rmSync(tmp);
  const params = loadJson(path.join(dataDir, "partial.json"));
  const w = 128, h = 96;
  const src = new Uint8ClampedArray(w * h * 4);
  let seed = 11;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    src[i * 4] = seed % 256;
    src[i * 4 + 1] = (seed >> 4) % 256;
    src[i * 4 + 2] = (seed >> 9) % 256;
    src[i * 4 + 3] = 255;
  }
  const a = R.rectifyImage(params, R.createIntegrator(params.gyro),
    src, w, h, params.t_ref).out;
  const b = Inline.rectifyImage(params, Inline.createIntegrator(params.gyro),
    src, w, h, params.t_ref).out;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  if (diffs === 0) console.log("  ok - index.html inline core matches rectifier.js");
  else { failures++; console.error(`  FAIL - inline core drifts: ${diffs} bytes`); }
})();

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
