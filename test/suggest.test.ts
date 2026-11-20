import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { suggestSeamPath } from '../src/core/suggest.js';
import { parameterize } from '../src/core/parameterize.js';
import type { ParsedMesh } from '../src/core/types.js';

const sample = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'public/samples', `${name}.json`), 'utf8'));

const asMesh = (raw: unknown): ParsedMesh => {
  const obj = raw as { vertices: [number, number, number][]; faces: [number, number, number][]; seams?: [number, number][] };
  return { vertices: obj.vertices, faces: obj.faces, seams: (obj.seams ?? []) as [number, number][] };
};

describe('suggestSeamPath', () => {
  it('suggests a valid cut for the uncut cylinder', () => {
    const mesh = asMesh(sample('cylinder-uncut'));
    const suggestion = suggestSeamPath(mesh);
    expect(suggestion.allDisks).toBe(true);
    expect(suggestion.seams.length).toBeGreaterThan(0);

    const result = parameterize({
      vertices: mesh.vertices,
      faces: mesh.faces,
      seams: suggestion.seams,
    });
    expect(result.valid).toBe(true);
    expect(result.stats.charts).toBe(1);
    expect(result.stats.boundaryLoops).toBe(1);
    expect(result.stats.maxResidual).toBeLessThan(1e-9);
  });

  it('reports no work needed for an existing disk', () => {
    const suggestion = suggestSeamPath(asMesh(sample('obtuse-disk')));
    expect(suggestion.allDisks).toBe(true);
    expect(suggestion.seams).toEqual([]);
  });

  it('explains when no cut can make the mesh a disk', () => {
    // A closed tetrahedron has no boundary to cut from.
    const suggestion = suggestSeamPath({
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      faces: [
        [0, 2, 1],
        [0, 1, 3],
        [1, 2, 3],
        [2, 0, 3],
      ],
      seams: [],
    });
    expect(suggestion.allDisks).toBe(false);
    expect(suggestion.reason.length).toBeGreaterThan(0);
  });
});
