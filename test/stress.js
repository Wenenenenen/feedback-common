/* End-to-end stress test: random layouts through triangulate + evaluate + export.

   Run: node test/stress.js */
'use strict';
const path = require('path');
const TRI = require(path.join(__dirname, '..', 'src', 'tri.js'));
const QUERY = require(path.join(__dirname, '..', 'src', 'query.js'));
const EXPORT = require(path.join(__dirname, '..', 'src', 'export.js'));
const CORE = require(path.join(__dirname, '..', 'src', 'core.js'));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomPoints(n, seed) {
  const r = rng(seed);
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const p = [
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
    ];
    const key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function shellPoints(n, seed) {
  const r = rng(seed);
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const p = [
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
      Math.floor(r() * 2001) - 1000,
    ];
    p[Math.floor(r() * 3)] = r() < 0.5 ? -1000 : 1000;
    const key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function lattice(dims, step) {
  const out = [];
  for (let x = 0; x < dims[0]; x++)
    for (let y = 0; y < dims[1]; y++)
      for (let z = 0; z < dims[2]; z++) out.push([x * step, y * step, z * step]);
  return out;
}

/* Coarse random unit vectors for the normal. */
function normals(seed) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const z = r() * 2 - 1;
    const t = r() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    out.push([s * Math.cos(t), s * Math.sin(t), z]);
  }
  return out;
}

let failures = 0;
let checked = 0;
let slowest = 0;

function run(name, points, seed) {
  const t0 = Date.now();
  const r = TRI.triangulate(points);
  const dt = Date.now() - t0;
  slowest = Math.max(slowest, dt);
  if (!r.ok) {
    failures++;
    console.log('FAIL ' + name + ': ' + r.code + ' ' + r.message);
    return;
  }
  if (!r.validation.ok) {
    failures++;
    console.log('INVALID ' + name + ': ' + r.validation.errors.join('; '));
    return;
  }
  const coeffs = points.map((p, i) => [
    [0.1 + (i % 7) * 0.05, 0.2, 0.1, 0.0],
    [0.15, 0.1 + (i % 5) * 0.04, 0.05, 0.1],
    [0.2, 0.05, 0.1, 0.1 + (i % 3) * 0.05],
  ]);
  const ns = normals(seed);
  const rnd = rng(seed + 1);

  /* In-hull sweep, inside a shrunken box. */
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  let inside = 0, outside = 0;
  for (let i = 0; i < 80; i++) {
    const q = [0, 1, 2].map((k) => lo[k] + rnd() * (hi[k] - lo[k]));
    const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, q, ns[i % ns.length]);
    checked++;
    if (!res.ok) { failures++; console.log('FAIL evaluate ' + name); return; }
    const sum = res.weights.reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 1) > 1e-8) { failures++; console.log('FAIL weight sum ' + name + ' ' + sum); return; }
    for (const w of res.weights) {
      if (w < -1e-12) { failures++; console.log('FAIL negative weight ' + name + ' ' + w); return; }
    }
    for (const v of res.clamped) {
      if (v < 0) { failures++; console.log('FAIL negative clamped ' + name); return; }
    }
    if (res.outside) outside++; else inside++;
  }

  /* Far outside: projection must stay on the hull and weights bounded. */
  for (let i = 0; i < 25; i++) {
    const dir = ns[i % ns.length];
    const d = 1500 + rnd() * 4000;
    const q = [0, 1, 2].map((k) => hi[k] / 2 + lo[k] / 2 + dir[k] * d);
    const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, q, ns[(i + 3) % ns.length]);
    checked++;
    if (!res.ok || !res.outside || !res.projected) {
      failures++; console.log('FAIL projection ' + name); return;
    }
  }

  /* Flip through every tetrahedron: each must be locatable from its centroid. */
  for (let ti = 0; ti < r.tets.length; ti++) {
    const t = r.tets[ti];
    const c = [0, 1, 2].map((k) =>
      (points[t[0]][k] + points[t[1]][k] + points[t[2]][k] + points[t[3]][k]) / 4);
    const hit = QUERY.locate(points, r.tets, c);
    if (!hit) { failures++; console.log('FAIL locate ' + name + ' tet ' + ti); return; }
    const res = QUERY.evaluate(points, r.tets, r.hull, coeffs, c, [0, 1, 0]);
    for (const w of res.weights) {
      if (w < -1e-9) { failures++; console.log('FAIL centroid weight ' + name); return; }
    }
  }

  /* Export round-trip: tri JSON parses and its counts agree. */
  const project = { probes: points.map((p, i) => ({ id: String(i), position: p, coefficients: coeffs[i] })), tri: r, caseName: name };
  const json = JSON.parse(JSON.stringify(EXPORT.triangulationJSON(project)));
  if (json.tetrahedra.length !== r.tets.length || json.hull.length !== r.hull.length) {
    failures++; console.log('FAIL export ' + name); return;
  }
  const csv = EXPORT.queryCSV([]);
  if (!csv.startsWith('seq,x,y,z')) { failures++; console.log('FAIL csv header'); return; }

  /* Shuffle stability. */
  const idx = points.map((_, i) => i);
  let s = seed * 2654435761;
  for (let i = idx.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  const sh = idx.map((i) => points[i]);
  const r2 = TRI.triangulate(sh);
  if (!r2.ok || r2.fingerprint !== r.fingerprint) {
    failures++; console.log('FAIL shuffle ' + name); return;
  }
}

const start = Date.now();
for (let seed = 1; seed <= 60; seed++) {
  const n = 4 + Math.floor(rng(seed)() * 61);
  run('rand' + n + '_' + seed, randomPoints(n, seed), seed);
}
for (let seed = 1; seed <= 20; seed++) {
  run('shell' + seed, shellPoints(20 + (seed % 30), seed + 500), seed + 50);
}
run('grid3', lattice([3, 3, 3], 100), 7);
run('grid4', lattice([4, 4, 4], 100), 8);
run('gridbox', lattice([2, 3, 4], 100), 9);

console.log('\n' + checked + ' evaluations, slowest triangulation ' + slowest + ' ms, total ' +
  ((Date.now() - start) / 1000).toFixed(1) + ' s');
console.log(failures ? failures + ' FAILURES' : 'all layouts passed');
process.exit(failures ? 1 : 0);
