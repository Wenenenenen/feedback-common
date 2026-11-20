import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parameterize } from '../src/core/parameterize.js';
import { buildExportJson } from '../src/core/export.js';

const sample = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'public/samples', `${name}.json`), 'utf8'));

const codes = (r: ReturnType<typeof parameterize>): string[] => r.errors.map((e) => e.code);

describe('obtuse-disk', () => {
  const result = parameterize(sample('obtuse-disk'));

  it('solves a single disk chart', () => {
    expect(result.valid).toBe(true);
    expect(result.stats.charts).toBe(1);
    expect(result.charts[0].topology.euler).toBe(1);
    expect(result.stats.maxResidual).toBeLessThan(1e-9);
  });

  it('reports the obtuse interior vertex with a thin residual', () => {
    expect(result.stats.interiorVertices).toBe(1);
    expect(result.charts[0].residuals.interior).toHaveLength(1);
  });
});

describe('bowtie', () => {
  const result = parameterize(sample('bowtie'));

  it('produces two separate charts instead of merging through a non-manifold vertex', () => {
    // The two triangles meet only at vertex 0; by the fan rule this is a bow-tie
    // vertex and must be rejected instead of silently merged or split.
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('non-manifold-vertex');
    const diag = result.errors.find((e) => e.code === 'non-manifold-vertex')!;
    expect(diag.elements?.vertices).toEqual([0]);
    expect(diag.elements?.vertexFans?.[0].vertex).toBe(0);
    expect(diag.elements?.vertexFans?.[0].fans.length).toBe(2);
  });
});

describe('nonmanifold', () => {
  const result = parameterize(sample('nonmanifold'));

  it('locates the non-manifold edge and both offending faces', () => {
    expect(result.valid).toBe(false);
    const diag = result.errors.find((e) => e.code === 'non-manifold-edge');
    expect(diag).toBeDefined();
    expect(diag!.elements?.edges).toBeDefined();
    expect(diag!.elements?.faces?.sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(diag!.elements?.edges?.length).toBeGreaterThan(0);
  });
});

describe('degenerate', () => {
  const result = parameterize(sample('degenerate'));

  it('rejects the zero-area triangle and names the face', () => {
    expect(result.valid).toBe(false);
    const diag = result.errors.find((e) => e.code === 'degenerate-face');
    expect(diag).toBeDefined();
    expect(diag!.elements?.faces).toEqual([0]);
    // Topology is still reported for inspection, but no chart is valid.
    expect(result.charts.every((c) => !c.valid)).toBe(true);
  });
});

describe('seam validation', () => {
  it('rejects a seam that is not an existing mesh edge', () => {
    const base = sample('obtuse-disk') as { vertices: unknown; faces: unknown };
    const input = { ...base, seams: [[0, 2]] };
    const result = parameterize(input);
    expect(result.valid).toBe(false);
    const diag = result.errors.find((e) => e.code === 'seam-not-found');
    expect(diag).toBeDefined();
    expect(diag!.elements?.seam).toEqual([0, 2]);
  });

  it('rejects a self-referential seam', () => {
    const base = sample('obtuse-disk') as { vertices: unknown; faces: unknown };
    const result = parameterize({ ...base, seams: [[3, 3]] });
    expect(codes(result)).toContain('seam-degenerate');
  });

  it('rejects out-of-range seam endpoints', () => {
    const base = sample('obtuse-disk') as { vertices: unknown; faces: unknown };
    const result = parameterize({ ...base, seams: [[0, 9999]] });
    expect(codes(result)).toContain('seam-not-found');
  });

  it('warns about duplicate seams and seams already on the boundary', () => {
    const base = sample('obtuse-disk') as { vertices: unknown; faces: unknown };
    // (0, 1) is a boundary edge of the obtuse disk.
    const result = parameterize({ ...base, seams: [[0, 1], [1, 0]] });
    const warnCodes = result.warnings.map((w) => w.code);
    expect(warnCodes).toContain('seam-on-boundary');
    expect(warnCodes).toContain('duplicate-seam');
    expect(result.seams).toEqual([[0, 1]]);
  });
});

describe('input limits', () => {
  it('rejects non-integer and bad-length faces', () => {
    const result = parameterize({
      vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      faces: [[0, 1], [0, 'x', 2]],
      seams: [],
    });
    expect(codes(result)).toContain('invalid-face');
    expect(result.cutVertices).toEqual([]);
  });

  it('rejects NaN vertices', () => {
    const result = parameterize({
      vertices: [[0, 0, 0], [1, 0, 0], [Number.NaN, 1, 0]],
      faces: [[0, 1, 2]],
      seams: [],
    });
    expect(codes(result)).toContain('invalid-vertex');
    expect(result.errors.find((e) => e.code === 'invalid-vertex')!.elements?.vertices).toEqual([2]);
  });

  it('rejects more than 5000 triangles', () => {
    const n = 5001;
    const vertices: number[][] = [];
    const faces: number[][] = [];
    for (let i = 0; i < n; i++) {
      vertices.push([i, 0, 0], [i + 1, 0, 0], [i, 1, 0]);
      faces.push([i * 3, i * 3 + 1, i * 3 + 2]);
    }
    // 15003 vertices, overlapping faces — only the count limit matters here.
    const result = parameterize({ vertices, faces, seams: [] });
    expect(codes(result)).toContain('triangle-limit');
  });

  it('rejects an empty mesh', () => {
    expect(codes(parameterize({ vertices: [], faces: [], seams: [] }))).toContain('empty-mesh');
  });

  it('rejects garbage input without throwing', () => {
    for (const bad of [null, 42, 'x', [], { vertices: 'a', faces: 3 }]) {
      const result = parameterize(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('export JSON', () => {
  const result = parameterize(sample('cylinder-cut'));
  const json = buildExportJson(result);

  it('has one per-corner entry per face corner', () => {
    expect(json.perCornerUV).toHaveLength(result.input.faces);
    for (let fi = 0; fi < json.perCornerUV.length; fi++) {
      expect(json.perCornerUV[fi]).toHaveLength(3);
      for (let c = 0; c < 3; c++) {
        expect(json.perCornerUV[fi][c].face).toBe(fi);
        expect(json.perCornerUV[fi][c].corner).toBe(c);
      }
    }
  });

  it('records split-vertex correspondence only for split vertices', () => {
    expect(json.splitVertices.map((s) => s.originalVertex)).toEqual([0, 8, 16]);
    for (const s of json.splitVertices) {
      expect(s.cutVertices.length).toBe(2);
      const corners = s.cutVertices.flatMap((c) => c.corners);
      expect(new Set(corners.map(([f, c]) => f * 3 + c)).size).toBe(corners.length);
    }
  });

  it('is JSON-serialisable and round-trips', () => {
    const text = JSON.stringify(json);
    expect(text.length).toBeGreaterThan(1000);
    expect(JSON.parse(text).stats.cutVertices).toBe(27);
  });

  it('carries diagnostics with element locations', () => {
    const bad = buildExportJson(parameterize(sample('nonmanifold')));
    expect(bad.valid).toBe(false);
    const diag = bad.errors.find((e) => e.code === 'non-manifold-edge')!;
    expect(diag.elements?.faces?.length).toBeGreaterThan(0);
  });
});
