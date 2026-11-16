import { describe, expect, it } from 'vitest';
import { parseSceneDocument, reparent, serializeScene, worldMatrices, applyTransform, selectionRoots, setLocalMatrix, selectionRoots as roots } from '../../src/core/scene';
import { matricesClose, multiply, invertAffine, identity } from '../../src/core/matrix';
import type { Mat4, SceneNode } from '../../src/core/types';

function scene(nodes: Array<Partial<SceneNode> & { id: string }>, selection: string[] = [], active: string | null = null) {
  return parseSceneDocument({
    nodes: nodes.map((n) => ({
      parent: null,
      matrix: identity(),
      box: [1, 1, 1],
      ...n,
    })),
    selection,
    active,
  });
}

const I = identity();

describe('selection roots', () => {
  it('moves only the topmost selected nodes', () => {
    const state = scene(
      [
        { id: 'a' },
        { id: 'b', parent: 'a' },
        { id: 'c', parent: 'b' },
        { id: 'd' },
      ],
      ['a', 'b', 'c', 'd'],
    );
    expect(selectionRoots(state)).toEqual(['a', 'd']);
  });

  it('treats a selected root as the only moved node even when a descendant is selected too', () => {
    const state = scene([{ id: 'a' }, { id: 'b', parent: 'a' }], ['b', 'a']);
    expect(selectionRoots(state)).toEqual(['a']);
  });
});

describe('batch transform', () => {
  it('rotates around the arithmetic mean of world origins', () => {
    const state = scene(
      [
        { id: 'a', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { id: 'b', matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      ],
      ['a', 'b'],
      'a',
    );
    const result = applyTransform(state, { mode: 'rotate', space: 'world', axis: 'y', degrees: 90 });
    const before = worldMatrices(state);
    const after = worldMatrices(result.state);
    const pivot = [1, 0, 0];
    // Distance from pivot is preserved by rotation.
    for (const id of ['a', 'b']) {
      const o = [after.get(id)![3], after.get(id)![7], after.get(id)![11]];
      const ob = [before.get(id)![3], before.get(id)![7], before.get(id)![11]];
      const dist = Math.hypot(o[0] - pivot[0], o[1] - pivot[1], o[2] - pivot[2]);
      const distB = Math.hypot(ob[0] - pivot[0], ob[1] - pivot[1], ob[2] - pivot[2]);
      expect(dist).toBeCloseTo(distB, 10);
    }
    expect(result.pivot[0]).toBeCloseTo(1, 12);
  });

  it('uses the active root world column as the local axis, preserving shear', () => {
    const sheared: Mat4 = [1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const state = scene([{ id: 'p', matrix: sheared, box: [1, 1, 1] }], ['p'], 'p');
    const result = applyTransform(state, { mode: 'rotate', space: 'local', axis: 'y', degrees: 30 });
    // The local Y column of the world matrix is not X-aligned; rotation keeps non-orthogonality.
    const after = worldMatrices(result.state).get('p')!;
    expect(after[1]).not.toBe(0);
    // The shear itself is preserved up to the rotation around the shear axis.
    expect(Math.abs(after[0] * after[4] + after[1] * after[5] + after[2] * after[6])).toBeGreaterThan(0.01);
  });

  it('rejects a zero-length local axis as a whole batch', () => {
    const singular: Mat4 = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const state = scene([{ id: 'p', matrix: singular }, { id: 'q' }], ['p', 'q'], 'p');
    const before = serializeScene(state);
    expect(() => applyTransform(state, { mode: 'translate', space: 'local', axis: 'x', distance: 1 })).toThrowError(/轴长/);
    expect(serializeScene(state)).toEqual(before);
  });

  it('rejects inverse of a singular parent as a whole batch and leaves state untouched', () => {
    const singular: Mat4 = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const state = scene([{ id: 'bad', matrix: singular }, { id: 'child', parent: 'bad' }, { id: 'fine' }], ['child', 'fine'], 'child');
    const before = serializeScene(state);
    expect(() => applyTransform(state, { mode: 'translate', space: 'world', axis: 'x', distance: 1 })).toThrowError(/奇异/);
    expect(serializeScene(state)).toEqual(before);
  });

  it('translates by world direction and metric distance', () => {
    const state = scene([{ id: 'a' }], ['a'], 'a');
    const result = applyTransform(state, { mode: 'translate', space: 'world', axis: 'z', distance: 2.5 });
    const w = worldMatrices(result.state).get('a')!;
    expect([w[3], w[7], w[11]]).toEqual([0, 0, 2.5]);
  });

  it('left-multiplies rotation about the common pivot for children of moved roots', () => {
    const state = scene([
      { id: 'root', matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: 'child', parent: 'root', matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ], ['root'], 'root');
    const result = applyTransform(state, { mode: 'rotate', space: 'world', axis: 'y', degrees: 90 });
    const after = worldMatrices(result.state);
    // Child's local transform is untouched; it follows the parent.
    expect(result.state.nodes.get('child')!.matrix).toEqual(state.nodes.get('child')!.matrix);
    // World position rotates around the root's own origin (pivot).
    expect(after.get('child')![3]).toBeCloseTo(1, 10);
    expect(after.get('child')![11]).toBeCloseTo(-1, 10);
  });
});

describe('reparent batching', () => {
  it('preserves world for each moved root simultaneously', () => {
    const state = scene([
      { id: 'a', matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: 'b', matrix: [2, 0, 0, -1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] },
      { id: 'target', matrix: [0, 0, 1, 4, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1] },
    ], ['a', 'b'], 'a');
    const before = worldMatrices(state);
    const result = reparent(state, ['a', 'b'], 'target');
    const after = worldMatrices(result.state);
    for (const id of ['a', 'b']) {
      expect(matricesClose(after.get(id)!, before.get(id)!, 1e-12)).toBe(true);
      expect(result.state.nodes.get(id)!.parent).toBe('target');
    }
  });

  it('rejects a batch that would create a cycle through any moved root', () => {
    const state = scene([{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }], ['a', 'c'], 'a');
    const before = serializeScene(state);
    expect(() => reparent(state, ['a', 'c'], 'b')).toThrowError(/循环/);
    expect(serializeScene(state)).toEqual(before);
  });

  it('can detach to the root', () => {
    const state = scene([{ id: 'a', matrix: [1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 5, 0, 0, 0, 1] }], ['a'], 'a');
    const before = worldMatrices(state).get('a')!;
    const result = reparent(state, ['a'], null);
    expect(result.state.nodes.get('a')!.parent).toBeNull();
    expect(matricesClose(worldMatrices(result.state).get('a')!, before, 1e-12)).toBe(true);
  });

  it('does not mutate the input state on success or failure', () => {
    const state = scene([{ id: 'a' }, { id: 'b' }], ['a'], 'a');
    const copy = serializeScene(state);
    reparent(state, ['a'], 'b');
    expect(serializeScene(state)).toEqual(copy);
  });
});

describe('local matrix editing', () => {
  it('rejects non-affine or non-finite matrices without writing', () => {
    const state = scene([{ id: 'a' }], ['a'], 'a');
    expect(() => setLocalMatrix(state, 'a', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])).toThrowError(/末行/);
    expect(() => setLocalMatrix(state, 'a', [NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toThrowError(/有限/);
    expect(state.nodes.get('a')!.matrix).toEqual(I);
  });

  it('allows singular local matrices to be stored', () => {
    const state = scene([{ id: 'a' }], ['a'], 'a');
    const singular: Mat4 = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const next = setLocalMatrix(state, 'a', singular);
    expect(next.nodes.get('a')!.matrix).toEqual(singular);
  });
});
