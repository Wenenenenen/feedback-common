import { describe, expect, it } from 'vitest';
import { readSampleArchive } from '../helpers/samples';
import { parseSceneDocument, reparent, serializeScene, worldMatrices } from '../../src/core/scene';
import { invertAffine, multiply, matricesClose, determinant3 } from '../../src/core/matrix';
import type { Mat4 } from '../../src/core/types';

const samples = readSampleArchive();

function flatten(m: Mat4): number[] {
  return m;
}

describe('sample fixture', () => {
  it('computes the documented initial world transform', () => {
    const state = parseSceneDocument(samples.scene);
    const world = worldMatrices(state);
    expect(flatten(world.get('payload')!)).toEqual(samples.expected.payload_initial_world);
  });

  it('preserves world when reparenting payload under new-parent', () => {
    const state = parseSceneDocument(samples.scene);
    const result = reparent(state, ['payload'], 'new-parent');
    const payload = result.state.nodes.get('payload')!;
    const expected = samples.expected.payload_reparent_new_parent_local as Mat4;
    const tol = samples.expected.reparent_preserve_tolerance as number;
    expect(matricesClose(payload.matrix, expected, tol)).toBe(true);

    // World origin and full world matrix are both preserved.
    const before = worldMatrices(state).get('payload')!;
    const after = worldMatrices(result.state).get('payload')!;
    expect(matricesClose(after, before, tol)).toBe(true);
    // Local shear is retained (no TRS reconstruction).
    expect(payload.matrix[1]).not.toBe(0);
  });

  it('rejects cyclic documents', () => {
    expect(() => parseSceneDocument(samples.invalidCycle)).toThrowError(/循环/);
  });

  it('rejects reparenting a node under its own descendant', () => {
    const state = parseSceneDocument(samples.scene);
    const before = serializeScene(state);
    expect(() => reparent(state, ['parent'], 'payload')).toThrowError(/循环/);
    expect(serializeScene(state)).toEqual(before);
  });

  it('rejects reparenting under a singular world matrix without mutating', () => {
    const state = parseSceneDocument(samples.scene);
    const before = serializeScene(state);
    expect(() => reparent(state, ['payload'], 'singular')).toThrowError(/奇异/);
    expect(serializeScene(state)).toEqual(before);
  });

  it('keeps singular nodes loadable and invertible when not required', () => {
    const state = parseSceneDocument(samples.scene);
    expect(state.nodes.get('singular')!.matrix[0]).toBe(0);
    expect(Math.abs(determinant3(state.nodes.get('singular')!.matrix))).toBeLessThan(1e-12);
    const w = worldMatrices(state);
    expect(() => invertAffine(w.get('singular')!)).toThrowError(/奇异/);
  });
});

describe('matrix helpers', () => {
  it('multiplies in row-major order matching the sample', () => {
    const parent = samples.sceneNodes.parent.matrix as Mat4;
    const local = samples.sceneNodes.payload.matrix as Mat4;
    expect(flatten(multiply(parent, local))).toEqual(samples.expected.payload_initial_world);
  });
});
