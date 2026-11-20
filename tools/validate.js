#!/usr/bin/env node
/* Validate the in-page tracer engine against the packaged reference.json.
 * Run: node tools/validate.js [scene.json] [reference.json]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const tracerPath = path.join(__dirname, "..", "app", "tracer.js");
require(tracerPath); // IIFE attaches Tracer to globalThis
const Tracer = globalThis.Tracer;

const base = path.join(__dirname, "..", "sample-data");
const scenePath = process.argv[2] || path.join(base, "scene.json");
const refPath = process.argv[3] || path.join(base, "reference.json");
const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

let bad = 0;
for (const [k, ray] of scene.rays.entries()) {
  const got = Tracer.trace(scene, ray, "exhaustive");
  const want = ref[k];
  const problems = [];
  if (!got.hit && !want.hit) { /* both miss */ }
  else if (!got.hit || !want.hit) problems.push(`hit mismatch got=${JSON.stringify(got.hit)}`);
  else {
    if (JSON.stringify(got.hit.pixel) !== JSON.stringify(want.hit.pixel))
      problems.push(`pixel ${got.hit.pixel} != ${want.hit.pixel}`);
    for (const key of ["enter", "exit"]) {
      if (Math.abs(got.hit[key] - want.hit[key]) > 1e-9)
        problems.push(`${key} ${got.hit[key]} != ${want.hit[key]}`);
    }
  }
  if (got.candidates.length !== want.candidates.length) {
    problems.push(`cand count ${got.candidates.length} != ${want.candidates.length}`);
  } else {
    got.candidates.forEach((c, i) => {
      const w = want.candidates[i];
      if (JSON.stringify(c.pixel) !== JSON.stringify(w.pixel))
        problems.push(`cand${i} pixel`);
      for (const key of ["enter", "exit"]) {
        if (Math.abs(c[key] - w[key]) > 1e-9)
          problems.push(`cand${i} ${key} ${c[key]} != ${w[key]}`);
      }
    });
  }
  console.log(ray.id, problems.length ? "FAIL" : "OK ",
    `cands=${got.candidates.length} reason=${got.reason}`, problems.join("; "));
  if (problems.length) bad++;
}
console.log(bad ? "JS MISMATCH" : "JS ALL MATCH");
process.exit(bad ? 1 : 0);
