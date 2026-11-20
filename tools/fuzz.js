#!/usr/bin/env node
/* JS differential fuzz: DDA walk vs exhaustive analytic enumeration. */
"use strict";
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "app", "tracer.js"));
const T = globalThis.Tracer;

const base = path.join(__dirname, "..", "sample-data");
const small = JSON.parse(fs.readFileSync(path.join(base, "scene.json"), "utf8"));
const big = JSON.parse(fs.readFileSync(path.join(base, "capacity.json"), "utf8"));

function mulberry(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRay(rnd, cam, W, H) {
  const kind = Math.floor(rnd() * 7);
  let o, d;
  if (kind === 0) {
    const u = Math.floor(rnd() * W) + 0.5, v = Math.floor(rnd() * H) + 0.5;
    const z = 0.5 + rnd() * 9.5;
    o = [(u - cam.cx) * z / cam.fx, (cam.cy - v) * z / cam.fy, z];
    d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 1.5];
  } else if (kind === 1) {
    o = [-12 + rnd() * 9, -6 + rnd() * 12, 1 + rnd() * 7];
    d = [0.5 + rnd(), -1 + rnd() * 2, -0.5 + rnd() * 1.5];
  } else if (kind === 2) {
    o = [-3 + rnd() * 6, -3 + rnd() * 6, 2 + rnd() * 6];
    d = [rnd() * 2 - 1, rnd() * 2 - 1, -(0.2 + rnd())];
  } else if (kind === 3) {
    const k = Math.floor(rnd() * W), z = 1 + rnd() * 5;
    o = [(k - cam.cx) * z / cam.fx, 0, z]; d = [0, 0, 1];
  } else if (kind === 4) {
    o = [-2 + rnd() * 4, -2 + rnd() * 4, 2 + rnd() * 4];
    d = [(rnd() < 0.5 ? -1 : 1), -0.2 + rnd() * 0.4, -1e-5 + rnd() * 2e-5];
  } else if (kind === 5) {
    o = [0, 0, 1 + rnd() * 4];
    d = [(rnd() < 0.5 ? -0.3 : 0.3), (rnd() < 0.5 ? -0.3 : 0.3), 1];
  } else {
    const ci = 2 + Math.floor(rnd() * (W - 4));
    const cj = 2 + Math.floor(rnd() * (H - 4));
    const z = 2 + rnd() * 4;
    o = [(ci - cam.cx) * z / cam.fx, (cam.cy - cj) * z / cam.fy, z];
    d = [(rnd() < 0.5 ? -1 : 1), (rnd() < 0.5 ? -1 : 1), 0.2 + rnd()];
  }
  const ray = { id: "r" + Math.floor(rnd() * 1e9), origin: o, direction: d };
  if (rnd() < 0.1) ray.sourcePixel = [Math.floor(rnd() * W), Math.floor(rnd() * H)];
  return ray;
}

function fuzz(scene, n, seed) {
  const rnd = mulberry(seed);
  let bad = 0;
  const reasons = {};
  for (let k = 0; k < n; k++) {
    const ray = randomRay(rnd, scene.camera, scene.width, scene.height);
    const a = T.trace(scene, ray, "exhaustive");
    const b = T.trace(scene, ray, "dda");
    reasons[a.reason] = (reasons[a.reason] || 0) + 1;
    const ma = new Map(a.cells.map((c) => [c.pixel.join(","), c]));
    const mb = new Map(b.cells.map((c) => [c.pixel.join(","), c]));
    if (ma.size !== mb.size || [...ma.keys()].some((key) => !mb.has(key))) {
      bad++;
      if (bad <= 2) console.log("CELL MISMATCH", JSON.stringify(ray));
      continue;
    }
    for (const [key, ca] of ma) {
      const cb = mb.get(key);
      if (ca.status !== cb.status) { bad++; if (bad <= 2) console.log("STATUS", key); break; }
      if (ca.status === "candidate" &&
        (Math.abs(ca.enter - cb.enter) > 1e-9 || Math.abs(ca.exit - cb.exit) > 1e-9)) {
        bad++; if (bad <= 2) console.log("INTERVAL", key); break;
      }
    }
    if (a.reason !== b.reason) { bad++; console.log("REASON", a.reason, b.reason); }
  }
  console.log(`JS ${scene.width}x${scene.height}: ${n} rays, mismatches=${bad}, reasons=${JSON.stringify(reasons)}`);
  return bad;
}

const total = fuzz(small, 4000, 1234) + fuzz(big, 4000, 5678);
console.log(total ? "JS FUZZ FAIL" : "JS FUZZ PASS");
process.exit(total ? 1 : 0);
