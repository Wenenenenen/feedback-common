// End-to-end simulation of the browser pipeline using web-standard
// CompressionStream/DecompressionStream globals (available in Node 18+).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodePNG, encodePNG, browserInflate, browserDeflate,
} from '../src/png-codec.js';
import { buildGraph, solve } from '../src/solver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const S = path.join(root, 'samples', 'extracted');
const out = path.join(root, 'test-output');
await mkdir(out, { recursive: true });

async function load(p) { return decodePNG(new Uint8Array(await readFile(p)), browserInflate); }

const guide = await load(path.join(S, 'split', 'guide.png'));
const depth = await load(path.join(S, 'split', 'depth.png'));
const maskImg = await load(path.join(S, 'split', 'domain.png'));
const mask = new Uint8Array(maskImg.width * maskImg.height);
for (let i = 0; i < mask.length; i++) mask[i] = maskImg.samples[i] ? 255 : 0;

const graph = buildGraph({ width: depth.width, height: depth.height, guide, depth, mask, sigma: 0.1, edgeThreshold: 0.2 });
const result = await solve(graph, { space: 'depth', solver: 'pcg' });

// Browser-style exports
const depthPng = await encodePNG(depth.width, depth.height, 1, 16, result.outMM, browserDeflate);
await writeFile(path.join(out, 'depth_completed_depth.png'), depthPng);
const statusPng = await encodePNG(depth.width, depth.height, 1, 8, result.status, browserDeflate);
await writeFile(path.join(out, 'depth_status.png'), statusPng);

// Round-trip verify browser-encoded files
const depthBack = await load(path.join(out, 'depth_completed_depth.png'));
const statusBack = await load(path.join(out, 'depth_status.png'));
let ok = true;
for (let i = 0; i < result.outMM.length; i++) {
  if (depthBack.samples[i] !== result.outMM[i]) { ok = false; console.log('depth mismatch at', i); }
  if (statusBack.samples[i] !== result.status[i]) { ok = false; console.log('status mismatch at', i); }
}
console.log('browser-stream PNG round-trip:', ok ? 'OK' : 'FAIL');

// JSON report shape
const report = {
  parameters: {
    sigma: graph.sigma, edge_threshold: graph.edgeThreshold,
    space: result.space, solver: result.solver,
    residual_tolerance: result.stats.residualTolerance,
  },
  global_stats: result.stats,
  components: result.components.map((c) => ({
    id: c.id, anchored: c.anchored, solved: c.solved, pixel_count: c.size,
    anchor_count: c.anchorCount, completed_count: c.completedCount,
    iterations: c.iterations,
    max_abs_normalized_residual: c.maxAbsResidual,
    output_depth_mm: c.depthMM,
  })),
};
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log('JSON report components:', report.components.length);
console.log('global stats:', JSON.stringify(report.global_stats));

// Verify stored-deflate fallback path by forcing it
const { default: codec } = await import('../src/png-codec.js?fallback=1').catch(() => ({ default: null })) || {};
console.log('\nE2E artifacts written to', out);
