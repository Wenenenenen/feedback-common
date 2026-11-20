#!/usr/bin/env node
/* Targeted checks for the five required miss classes and reflection build. */
"use strict";
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "app", "tracer.js"));
const T = globalThis.Tracer;
const base = path.join(__dirname, "..", "sample-data");
const scene = JSON.parse(fs.readFileSync(path.join(base, "scene.json"), "utf8"));
const W = scene.width;
const cam = scene.camera;

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "OK  " : "FAIL") + " " + name + (detail ? " — " + detail : ""));
  if (!cond) failures++;
}
let r;

// 1. near-plane miss: start behind near and head further backward
r = T.trace(scene, { id: "near", origin: [0, 0, 0.05], direction: [0, 0, -1] }, "dda");
check("near clip", r.reason === "near", r.reason);

// 2. off-screen miss: valid z range but projection never enters the screen rect
r = T.trace(scene, { id: "off", origin: [100, 100, 5], direction: [0, 0, 1] }, "dda");
check("off-screen clip", r.reason === "off-screen", r.reason + " cells=" + r.cells.length);

// 3. empty-depth: ray whose bearing is fixed on the null cell center, so the
// projection never leaves that one cell for the whole z range
const nullIdx = scene.depth.findIndex((d) => d === null);
const ny = Math.floor(nullIdx / W), nx = nullIdx % W;
const z0 = 1.5;
const oNull = [(nx + 0.5 - cam.cx) * z0 / cam.fx, (cam.cy - ny - 0.5) * z0 / cam.fy, z0];
const dNull = T.normalize(oNull).dir;
r = T.trace(scene, { id: "empty", origin: oNull, direction: dNull }, "dda");
check("empty-depth", r.reason === "empty-depth" && r.cells.length === 1
  && r.cells[0].status === "empty-depth",
  r.reason + " cells=" + r.cells.length);

// 4. backface: +z normal cell, direction +z -> n.d = +1
const bfIdx = scene.normal.findIndex((n) => n[2] > 0.99);
const by = Math.floor(bfIdx / W), bx = bfIdx % W;
const oBf = [(bx + 0.5 - cam.cx) * 5 / cam.fx, (cam.cy - by - 0.5) * 5 / cam.fy, 5];
r = T.trace(scene, { id: "back", origin: oBf, direction: [0, 0, 1] }, "dda");
const bfCell = r.cells.find((c) => c.pixel[0] === bx && c.pixel[1] === by);
check("backface cell classified", !!bfCell && bfCell.status === "backface",
  bfCell ? bfCell.status : "not walked: " + r.cells.map((c) => c.pixel.join()).join(","));

// 5. single-point graze: z-span ends exactly on a slab front face
const filled = scene.depth.findIndex((d) => d !== null);
const fy2 = Math.floor(filled / W), fx2 = filled % W;
const oG = [(fx2 + 0.5 - cam.cx) * 3 / cam.fx, (cam.cy - fy2 - 0.5) * 3 / cam.fy, 2.9];
const dG = T.normalize([0, 0, 1]).dir;
const grazeScene = Object.assign({}, scene, { maxDistance: 0.1 / dG[2] });
r = T.trace(grazeScene, { id: "graze", origin: oG, direction: dG }, "exhaustive");
check("graze (point contact rejected)", r.candidates.length === 0 &&
  r.reasonFactors.includes("graze"), r.reason + " " + JSON.stringify(r.reasonFactors));

// 6. source-only
r = T.trace(scene, scene.rays.find((x) => x.id === "source-skip"), "dda");
check("source-only", r.reason === "source-only" &&
  r.cells.every((c) => c.status === "source-skip"), r.reason);

// 7. far-plane: a short far plane ends the ray inside a walked cell region,
// and "far" must appear as a factor; a backward ray over no cells reports a
// ray-level primary reason.
const farWalked = Object.assign({}, scene, { far: 2.2 });
r = T.trace(farWalked, { id: "far2", origin: oNull, direction: dNull }, "dda");
check("far retained as factor on walked ray", r.reasonFactors.includes("far"),
  r.reason + " " + JSON.stringify(r.reasonFactors));
const farNone = Object.assign({}, scene, { far: 0.08 });
r = T.trace(farNone, { id: "far", origin: [100, 100, 5], direction: [0, 0, 1] }, "dda");
check("far/near primary when no cell walked",
  r.cells.length === 0 && (r.reason === "far" || r.reason === "near" || r.reason === "off-screen"),
  r.reason + " cells=" + r.cells.length);

// 8. reflection build geometry
const refl = T.reflectionFromPixel(scene, fx2, fy2);
check("reflection built", !!refl.ray && refl.ray.sourcePixel.join() === [fx2, fy2].join());
const n = scene.normal[filled];
const incident = T.normalize(refl.ray.origin).dir;
const dot = incident.reduce((s, iv, k) => s + iv * n[k], 0);
const expect = incident.map((v, k) => v - 2 * dot * n[k]);
const got = T.normalize(refl.ray.direction).dir;
check("reflection formula", expect.every((v, k) => Math.abs(v - got[k]) < 1e-12),
  "got " + got.map((v) => v.toFixed(4)).join(","));

// 9. axis reference and tie-break ordering path
r = T.trace(scene, scene.rays.find((x) => x.id === "axis"), "exhaustive");
check("axis reference", r.hit && r.hit.pixel.join() === "24,16" &&
  Math.abs(r.hit.enter - 2.0) < 1e-12, JSON.stringify(r.hit));

// 10. zero direction
r = T.trace(scene, { id: "zero", origin: [0, 0, 2], direction: [0, 0, 0] }, "dda");
check("zero direction", r.reason === "bad-direction", r.reason);

// 11. thickness/distance controls change results monotonically
const thin = Object.assign({}, scene, { thickness: 0.01 });
const thick = Object.assign({}, scene, { thickness: 0.5 });
const rt = T.trace(scene, scene.rays[0], "exhaustive");
const rThin = T.trace(thin, scene.rays[0], "exhaustive");
const rThick = T.trace(thick, scene.rays[0], "exhaustive");
check("thickness widens slab interval",
  (rThick.hit.exit - rThick.hit.enter) > (rt.hit.exit - rt.hit.enter) &&
  (rThin.hit.exit - rThin.hit.enter) < (rt.hit.exit - rt.hit.enter),
  `thin ${(rThin.hit.exit - rThin.hit.enter).toFixed(4)} < base ${(rt.hit.exit - rt.hit.enter).toFixed(4)} < thick ${(rThick.hit.exit - rThick.hit.enter).toFixed(4)}`);

console.log(failures ? "TARGETED FAIL" : "TARGETED PASS");
process.exit(failures ? 1 : 0);
