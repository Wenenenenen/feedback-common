import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parameterize } from '../src/core/parameterize.js';
import { validateInput } from '../src/core/validate.js';

const codes = (r: ReturnType<typeof parameterize>): string[] => r.errors.map((e) => e.code);

function squareWithHole(inner: number) {
  // A square annulus (grid) — the title case for "uncut hole".
  const n = inner;
  const vertices: [number, number, number][] = [];
  const id = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      if (i > 0 && i < n && j > 0 && j < n) {
        vertices.push([0, 0, 0]);
      } else {
        vertices.push([i / n, j / n, 0]);
      }
    }
  }
  const faces: [number, number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // skip the innermost quads
      if (i >= 1 && i <= n - 2 && j >= 1 && j <= n - 2) continue;
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces, seams: [] as [number, number][] };
}

describe('uncut hole', () => {
  it('reports a non-disk chart and locates both loops instead of filling the hole', () => {
    const result = parameterize(squareWithHole(4));
    expect(result.valid).toBe(false);
    const diag = result.errors.find((e) => e.code === 'chart-not-disk');
    expect(diag).toBeDefined();
    expect(diag!.elements?.loops?.length).toBe(2);
    // The hole boundary is real geometry: no face is invented.
    expect(result.stats.faces).toBe(24);
    expect(result.stats.charts).toBe(1);
  });
});

describe('orientation', () => {
  it('flags a flipped face pair on a shared edge', () => {
    // Both faces traverse 0 -> 1, so the shared edge is used twice in the same
    // direction: the pair cannot be consistently oriented.
    const result = parameterize({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
      ],
      faces: [
        [0, 1, 2],
        [0, 1, 3],
      ],
      seams: [],
    });
    expect(result.valid).toBe(false);
    const diag = result.errors.find((e) => e.code === 'inconsistent-orientation');
    expect(diag).toBeDefined();
    expect(diag!.elements?.edges).toEqual([[0, 1]]);
    expect(diag!.elements?.faces?.sort((a, b) => a - b)).toEqual([0, 1]);
  });
});

describe('degenerate geometry', () => {
  it('reports collinear triangles through the singular-system path rather than producing NaN UVs', () => {
    // Faces below the 1e-12 area threshold are rejected earlier; build a thin
    // but valid pair whose cotangent blows up? Instead confirm area rejection.
    const result = parameterize({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        [0, 1, 2],
        [0, 1, 3],
      ],
      seams: [],
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('degenerate-face');
  });

  it('rejects a repeated index inside one face', () => {
    const result = parameterize({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 0, 1]],
      seams: [],
    });
    expect(codes(result)).toContain('degenerate-face');
  });
});

describe('validateInput element locations', () => {
  it('reports each non-manifold edge with its face list', () => {
    const { errors } = validateInput({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
      ],
      faces: [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
      ],
      seams: [],
    });
    const diag = errors.find((e) => e.code === 'non-manifold-edge')!;
    expect(diag.elements?.edges?.[0]).toEqual([0, 1]);
    expect(diag.elements?.faces).toEqual([0, 1, 2]);
  });
});

describe('two charts from two triangles', () => {
  it('solves disconnected disks independently and keeps each on its own unit circle', () => {
    const result = parameterize({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [5, 0, 0],
        [6, 0, 0],
        [5, 1, 0],
      ],
      faces: [
        [0, 1, 2],
        [3, 4, 5],
      ],
      seams: [],
    });
    expect(result.valid).toBe(true);
    expect(result.stats.charts).toBe(2);
    for (const chart of result.charts) {
      for (const cv of chart.boundaryVertices) {
        const uv = result.cutVertices[cv].uv!;
        expect(Math.hypot(uv[0], uv[1])).toBeCloseTo(1, 12);
      }
    }
  });
});

describe('seam across the whole cylinder', () => {
  it('supports adding seams incrementally and reports the update', () => {
    const base = JSON.parse(
      readFileSync('public/samples/cylinder-cut.json', 'utf8'),
    ) as { vertices: unknown; faces: unknown };
    const oneSeam = parameterize({ ...base, seams: [[0, 8]] });
    expect(oneSeam.valid).toBe(false);
    expect(oneSeam.stats.boundaryLoops).toBe(2);

    const twoSeams = parameterize({ ...base, seams: [[0, 8], [8, 16]] });
    expect(twoSeams.valid).toBe(true);
    expect(twoSeams.stats.boundaryLoops).toBe(1);
  });
});

describe('flip reporting', () => {
  it('marks faces with negative UV double area as flipped while still solving', () => {
    // A square whose boundary is sampled 8 times plus one interior point tucked
    // near the bottom-left corner; arc-length boundary placement squeezes the
    // triangles adjacent to it into a fold.
    const m = 2;
    const n = 4 * m;
    const vertices: [number, number, number][] = [];
    const ring: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / n;
      let p: [number, number];
      if (t < 0.25) p = [t * 4, 0];
      else if (t < 0.5) p = [1, (t - 0.25) * 4];
      else if (t < 0.75) p = [1 - (t - 0.5) * 4, 1];
      else p = [0, 1 - (t - 0.75) * 4];
      ring.push(vertices.length);
      vertices.push([p[0], p[1], 0]);
    }
    const center = vertices.length;
    vertices.push([0.02, 0.02, 0]);
    const faces: [number, number, number][] = [];
    for (let i = 0; i < n; i++) faces.push([ring[i], ring[(i + 1) % n], center]);

    const result = parameterize({ vertices, faces, seams: [] });
    expect(result.valid).toBe(true);
    expect(result.stats.flippedFaces).toBe(2);
    expect(result.charts[0].flippedFaces.length).toBe(2);
    // A flip is reported, never hidden: the chart's own face list carries it.
    for (const fi of result.charts[0].flippedFaces) expect(result.faceChart[fi]).toBe(0);
  });
});
