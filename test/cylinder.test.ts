import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parameterize } from '../src/core/parameterize.js';

const sample = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'public/samples', `${name}.json`), 'utf8'));

describe('cylinder-cut sample', () => {
  const result = parameterize(sample('cylinder-cut'));

  it('matches truth.json topology', () => {
    const truth = sample('truth');
    expect(result.valid).toBe(true);
    expect(result.stats.charts).toBe(truth['cylinder-cut'].charts);
    expect(result.stats.boundaryLoops).toBe(truth['cylinder-cut'].boundary_loops);
    expect(result.stats.cutVertices).toBe(truth['cylinder-cut'].cut_vertices);
    expect(result.stats.faces).toBe(truth['cylinder-cut'].faces);
  });

  it('splits exactly the seam-split vertices', () => {
    // Only original vertices that end up with more than one cut vertex were split.
    const counts = new Map<number, number>();
    for (const cv of result.cutVertices) {
      counts.set(cv.originalVertex, (counts.get(cv.originalVertex) ?? 0) + 1);
    }
    const split = [...counts].filter(([, n]) => n > 1).map(([v]) => v).sort((a, b) => a - b);
    // Vertex 0 sits on the bottom-cap seam; 8 and 16 on the vertical seam.
    expect(split).toEqual([0, 8, 16]);
  });

  it('produces one disk chart with euler 1', () => {
    const chart = result.charts[0];
    expect(chart.topology.euler).toBe(1);
    expect(chart.topology.boundaryLoops).toBe(1);
    expect(chart.boundaryLoops[0].length).toBe(20);
    expect(chart.boundaryLoops[0][0]).toBe(Math.min(...chart.boundaryLoops[0]));
  });

  it('places boundary vertices exactly on the unit circle', () => {
    const chart = result.charts[0];
    for (const cv of chart.boundaryVertices) {
      const uv = result.cutVertices[cv].uv!;
      expect(Math.hypot(uv[0], uv[1])).toBeCloseTo(1, 12);
    }
  });

  it('has tiny residuals, no flips', () => {
    expect(result.stats.maxResidual).toBeLessThan(1e-9);
    expect(result.stats.flippedFaces).toBe(0);
    expect(result.stats.nearZeroFaces).toBe(0);
    expect(result.charts[0].solver.converged).toBe(true);
  });

  it('keeps UVs of the same original vertex apart across the seam', () => {
    for (const original of [0, 8, 16]) {
      const group = result.cutVertices.filter((cv) => cv.originalVertex === original);
      expect(group.length).toBe(2);
      const keys = new Set(group.map((cv) => cv.uv!.map((x) => x.toFixed(9)).join(',')));
      expect(keys.size).toBe(2);
    }
  });
});

describe('cylinder-uncut sample', () => {
  const result = parameterize(sample('cylinder-uncut'));

  it('is rejected as a non-disk chart with two boundary loops', () => {
    const truth = sample('truth');
    expect(result.valid).toBeTruthy; // placeholder to keep types honest
    expect(result.valid).toBe(false);
    expect(result.stats.charts).toBe(1);
    expect(result.stats.boundaryLoops).toBe(truth['cylinder-uncut'].boundary_loops);
    const code = result.errors.map((e) => e.code);
    expect(code).toContain('chart-not-disk');
  });

  it('points at the offending chart and its loops', () => {
    const diag = result.errors.find((e) => e.code === 'chart-not-disk')!;
    expect(diag.elements?.chart).toBe(0);
    expect(diag.elements?.loops?.length).toBe(2);
    // Both rims are located by original vertex ids, not silently filled.
    const lengths = diag.elements!.loops!.map((l) => l.length);
    expect(lengths).toEqual([8, 8]);
    const verts = diag.elements!.loopVertices!;
    expect(verts).toHaveLength(2);
    for (const loop of verts) expect(new Set(loop).size).toBe(loop.length);
  });
});
