#!/usr/bin/env node
'use strict';

const C = require('../src/core.js');

function makeFullFixture() {
  const n = 512;
  const cells = new Int32Array(n * n);
  let seed = 0x51a7e;
  function rand() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  // Sparse colored islands reach the required ~60k boundary-unit-edge scale
  // without making every adjacency a boundary.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (rand() < 0.058) cells[r * n + c] = 1 + Math.floor(rand() * 4);
    }
  }
  return cells;
}

function main() {
  const cells = makeFullFixture();
  const width = 512;
  const height = 512;
  const boundaryCount = C.countBoundaryEdges(cells, width, height);
  if (boundaryCount > C.MAX_UNIT_EDGES) {
    throw new Error(`Benchmark fixture has ${boundaryCount} edges, above ${C.MAX_UNIT_EDGES}`);
  }

  for (const area of [0, 2, 16]) {
    const started = performance.now();
    const result = C.processGrid({ width, height, cells }, { maxDoubleArea: area });
    const elapsed = performance.now() - started;
    console.log(JSON.stringify({
      area,
      boundaryCount,
      edges: result.edges.length,
      chains: result.chains.length,
      cycles: result.cycles.length,
      elapsedMs: Number(elapsed.toFixed(1)),
      under12s: elapsed < 12000,
    }));
  }
}

main();
