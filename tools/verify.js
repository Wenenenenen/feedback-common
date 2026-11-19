// Node verification harness for the shared solver against sample reference data.
// Run: node tools/verify.js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { decodePNG, encodePNG } from '../src/png-codec.js';
import { buildGraph, solve, STATUS } from '../src/solver.js';

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);
// Copy into fresh, zero-offset buffers so decoder indexing is unambiguous.
const inflateFn = async (b) => Uint8Array.from(await inflate(Buffer.from(b)));
const deflateFn = async (b) => Uint8Array.from(await deflate(Buffer.from(b)));

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const S = path.join(root, 'samples', 'extracted');

async function loadGray16(p) {
  const img = await decodePNG(new Uint8Array(await readFile(p)), inflateFn);
  if (img.bitDepth !== 16 || img.colorType !== 0) throw new Error('bad depth png: ' + p);
  return img;
}
async function loadRGB(p) {
  const img = await decodePNG(new Uint8Array(await readFile(p)), inflateFn);
  if (img.bitDepth !== 8 || (img.colorType !== 2 && img.colorType !== 6)) throw new Error('bad guide png: ' + p);
  return img;
}
async function loadMask(p) {
  const img = await decodePNG(new Uint8Array(await readFile(p)), inflateFn);
  // treat first channel; any nonzero => 255
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = img.samples[i * img.channels] === 0 ? 0 : 255;
  return out;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

async function verifyLine() {
  console.log('\n[line] 7x3 uniform guide, two anchors per row');
  const guide = await loadRGB(path.join(S, 'line', 'guide.png'));
  const depth = await loadGray16(path.join(S, 'line', 'depth.png'));
  const ref = JSON.parse(await readFile(path.join(S, 'line', 'reference.json'), 'utf8'));

  for (const space of ['depth', 'inverse']) {
    const graph = buildGraph({
      width: depth.width, height: depth.height, guide, depth,
      sigma: ref.sigma, edgeThreshold: ref.edge_threshold,
    });
    const r = await solve(graph, { space, solver: 'pcg' });
    check(`line/${space} single component`, graph.componentCount === 1);
    check(`line/${space} converged`, r.stats.allConverged, `maxRes=${r.components[0].maxAbsResidual}`);
    const got = [];
    for (let y = 0; y < depth.height; y++) {
      const row = [];
      for (let x = 0; x < depth.width; x++) row.push(r.outMM[y * depth.width + x]);
      got.push(row);
    }
    const expect = space === 'depth' ? ref.depth_mm : ref.inverse_mm;
    let mismatch = 0;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 7; x++) if (got[y][x] !== expect[y][x]) mismatch++;
    check(`line/${space} mm values match reference`, mismatch === 0, mismatch ? `mismatches=${mismatch}` : '');
    check(`line/${space} residual <= 1e-5`,
      r.components[0].maxAbsResidual === null || r.components[0].maxAbsResidual <= 1e-5 + 1e-12);
    check(`line/${space} anchors strictly preserved`,
      r.outMM[0] === 1000 && r.outMM[6] === 7000 && r.outMM[7] === 1000);
    console.log('   row 0:', got[0].join(','));
  }

  // GS cross-check on depth space (fresh graph, solve does not mutate graph)
  const graphGS = buildGraph({ width: depth.width, height: depth.height, guide, depth, sigma: ref.sigma, edgeThreshold: ref.edge_threshold });
  const rgs = await solve(graphGS, { space: 'depth', solver: 'gs' });
  check('line/gs same mm values', rgs.outMM.every((v, i) => v === ref.depth_mm[Math.floor(i / 7)][i % 7]));
}

async function verifySplit() {
  console.log('\n[split] 11x5 domain mask, color edge, out-of-domain measurement');
  const guide = await loadRGB(path.join(S, 'split', 'guide.png'));
  const depth = await loadGray16(path.join(S, 'split', 'depth.png'));
  const mask = await loadMask(path.join(S, 'split', 'domain.png'));
  const ref = JSON.parse(await readFile(path.join(S, 'split', 'reference.json'), 'utf8'));

  const graph = buildGraph({
    width: depth.width, height: depth.height, guide, depth, mask,
    sigma: ref.sigma, edgeThreshold: ref.edge_threshold,
  });
  check('split component count', graph.componentCount === ref.expected_components,
    `got=${graph.componentCount} want=${ref.expected_components}`);
  check('split ignored out-of-domain measurement',
    graph.ignoredMeasurements === ref.ignored_measurements, `got=${graph.ignoredMeasurements}`);

  const r = await solve(graph, { space: 'depth', solver: 'pcg' });
  const unanchored = r.components.filter((c) => !c.anchored);
  check('split one unanchored component', unanchored.length === 1);
  check('split unanchored x = 8,9,10',
    unanchored[0].size === 15 && unanchored[0].pixels === undefined &&
    unanchored[0].id >= 0 &&
    graph.compPixels[unanchored[0].id].every((p) => p % 11 >= 8));
  check('split unanchored stays unsolved (depth 0)',
    graph.compPixels[unanchored[0].id].every((p) => r.outMM[p] === 0 && r.status[p] === STATUS.UNANCHORED));

  const idx = (x, y) => y * 11 + x;
  check('split left anchor 1000 preserved', r.outMM[idx(1, 2)] === ref.left_mm);
  check('split middle anchor 4000 preserved', r.outMM[idx(5, 2)] === ref.middle_mm);
  check('split outside measurement excluded', r.outMM[idx(7, 0)] === 0 && r.status[idx(7, 0)] === STATUS.OUTSIDE);
  check('split all anchored comps converged', r.stats.allConverged,
    JSON.stringify(r.components.map((c) => c.maxAbsResidual)));
  check('split status codes',
    r.status[idx(1, 2)] === STATUS.ANCHOR &&
    r.status[idx(0, 0)] === STATUS.COMPLETED &&
    r.status[idx(8, 0)] === STATUS.UNANCHORED &&
    r.status[idx(7, 0)] === STATUS.OUTSIDE);

  // Inverse space also converges
  const graph2 = buildGraph({ width: depth.width, height: depth.height, guide, depth, mask, sigma: ref.sigma, edgeThreshold: ref.edge_threshold });
  const ri = await solve(graph2, { space: 'inverse', solver: 'pcg' });
  check('split inverse converged', ri.stats.allConverged);
  check('split inverse anchor preserved', ri.outMM[idx(1, 2)] === 1000 && ri.outMM[idx(5, 2)] === 4000);

  // Round-trip encode/decode of output 16-bit PNG
  const png = await encodePNG(depth.width, depth.height, 1, 16, r.outMM, deflateFn);
  const back = await decodePNG(png, inflateFn);
  let rt = 0;
  for (let i = 0; i < r.outMM.length; i++) if (back.samples[i] !== r.outMM[i]) rt++;
  check('16-bit PNG round-trip', rt === 0);
  const statPng = await encodePNG(depth.width, depth.height, 1, 8, r.status, deflateFn);
  const statBack = await decodePNG(statPng, inflateFn);
  check('status PNG round-trip', statBack.samples.every((v, i) => v === r.status[i]));
}

async function verifyEdgeCases() {
  console.log('\n[edge cases]');
  // All-missing depth on a tiny guide
  const w = 4, h = 4;
  const guide = { width: w, height: h, bitDepth: 8, colorType: 2, channels: 3, samples: new Uint16Array(w * h * 3).fill(100) };
  const depth = { width: w, height: h, bitDepth: 16, colorType: 0, channels: 1, samples: new Uint16Array(w * h) };
  const g = buildGraph({ width: w, height: h, guide, depth, sigma: 0.1, edgeThreshold: 0.2 });
  const r = await solve(g, { space: 'depth' });
  check('all-missing: one unanchored component, all zeros',
    r.stats.componentCount === 1 && r.stats.unanchoredComponents === 1 && r.outMM.every((v) => v === 0));

  // Empty mask
  const mask = new Uint8Array(w * h);
  const g2 = buildGraph({ width: w, height: h, guide, depth, mask, sigma: 0.1, edgeThreshold: 0.2 });
  const r2 = await solve(g2, { space: 'depth' });
  check('empty mask: zero components, all outside',
    g2.componentCount === 0 && r2.outMM.every((v) => v === 0) && r2.status.every((v) => v === STATUS.OUTSIDE));

  // Single anchor, rest of connected region solved to the anchor value
  const d3 = new Uint16Array(w * h);
  d3[0] = 2500;
  const depth3 = { ...depth, samples: d3 };
  const g3 = buildGraph({ width: w, height: h, guide, depth: depth3, sigma: 0.1, edgeThreshold: 0.2 });
  const r3 = await solve(g3, { space: 'depth' });
  check('single anchor: whole component = 2500mm',
    r3.outMM.every((v) => v === 2500) && r3.stats.allConverged);

  // Edge threshold zero: only equal-color neighbors connect
  const g4 = buildGraph({ width: w, height: h, guide, depth: depth3, sigma: 0.1, edgeThreshold: 0 });
  check('threshold 0 still connects equal colors', g4.componentCount === 1 && g4.edgeCount === 24);
}

async function main() {
  await verifyLine();
  await verifySplit();
  await verifyEdgeCases();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
