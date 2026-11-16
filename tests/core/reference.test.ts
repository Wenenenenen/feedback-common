import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyTransform,
  parseSceneDocument,
  reparent,
  selectionRoots,
  serializeScene,
  worldMatrices,
} from '../../src/core/scene';
import { invertAffine, multiply, matricesClose, identity } from '../../src/core/matrix';
import type { Mat4, SceneNode } from '../../src/core/types';

// Independent reference implementation using three.js column-major Matrix4.
function toThree(m: Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
}

function fromThree(m: THREE.Matrix4): Mat4 {
  const e = m.elements;
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}

function referenceWorld(nodes: Array<{ id: string; parent: string | null; matrix: Mat4 }>): Map<string, Mat4> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Mat4>();
  const resolve = (id: string, seen = new Set<string>()): Mat4 => {
    if (seen.has(id)) throw new Error('cycle');
    const cached = out.get(id);
    if (cached) return cached;
    seen.add(id);
    const node = byId.get(id)!;
    const parent = node.parent ? resolve(node.parent, seen) : identity();
    const world = fromThree(toThree(parent).multiply(toThree(node.matrix)));
    out.set(id, world);
    return world;
  };
  for (const n of nodes) resolve(n.id);
  return out;
}

function randomAffine(rng: () => number, opts: { mirror?: boolean; shear?: boolean } = {}): Mat4 {
  const rx = (rng() - 0.5) * Math.PI;
  const ry = (rng() - 0.5) * Math.PI;
  const rz = (rng() - 0.5) * Math.PI;
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  const sx = 0.3 + rng() * 2.5;
  const sy = 0.3 + rng() * 2.5;
  const sz = 0.3 + rng() * 2.5;
  const scale = new THREE.Matrix4().makeScale(opts.mirror && rng() > 0.5 ? -sx : sx, sy, sz);
  const shear = new THREE.Matrix4().set(1, opts.shear ? (rng() - 0.5) * 1.6 : 0, 0, (rng() - 0.5) * 4, 0, 1, opts.shear ? (rng() - 0.5) * 1.2 : 0, (rng() - 0.5) * 4, 0, 0, 1, (rng() - 0.5) * 4, 0, 0, 0, 1);
  const m = new THREE.Matrix4().multiply(rot).multiply(scale).multiply(shear);
  return fromThree(m);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('reference cross-check with three.js', () => {
  it('world composition matches three.js for 60 random hierarchies with mirror and shear', () => {
    const rng = mulberry32(1234);
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const nodes: Array<{ id: string; parent: string | null; matrix: Mat4 }> = [];
      const count = 2 + Math.floor(rng() * 10);
      for (let i = 0; i < count; i += 1) {
        const parent = i === 0 || rng() < 0.25 ? null : nodes[Math.floor(rng() * i)].id;
        nodes.push({ id: `n${i}`, parent, matrix: randomAffine(rng, { mirror: true, shear: true }) });
      }
      const state = parseSceneDocument({
        nodes: nodes.map((n) => ({ ...n, box: [1, 1, 1] })),
        selection: [],
        active: null,
      });
      const ours = worldMatrices(state);
      const reference = referenceWorld(nodes);
      for (const node of nodes) {
        expect(matricesClose(ours.get(node.id)!, reference.get(node.id)!, 1e-10), `node ${node.id} iter ${iteration}`).toBe(true);
      }
    }
  });

  it('preserve-world reparent matches three.js inverse reference and keeps shear exactly', () => {
    const rng = mulberry32(99);
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const target = randomAffine(rng, { mirror: true, shear: true });
      const payload = randomAffine(rng, { mirror: true, shear: true });
      const oldParent = randomAffine(rng, { shear: true });
      const nodes = [
        { id: 'old', parent: null, matrix: oldParent },
        { id: 'target', parent: null, matrix: target },
        { id: 'payload', parent: 'old', matrix: payload },
      ];
      const state = parseSceneDocument({ nodes: nodes.map((n) => ({ ...n, box: [1, 1, 1] })), selection: ['payload'], active: 'payload' });
      const oldWorld = referenceWorld(nodes).get('payload')!;
      const result = reparent(state, ['payload'], 'target');
      const local = result.state.nodes.get('payload')!.matrix;
      const expectedLocal = fromThree(toThree(invertAffine(target)).multiply(toThree(oldWorld)));
      expect(matricesClose(local, expectedLocal, 1e-10), `iteration ${iteration}`).toBe(true);
      // Recomposed world equals the original world (no TRS reconstruction).
      const recomposed = fromThree(toThree(target).multiply(toThree(local)));
      expect(matricesClose(recomposed, oldWorld, 1e-10)).toBe(true);
    }
  });

  it('rotation about the common pivot matches three.js matrices', () => {
    const rng = mulberry32(7);
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const a = randomAffine(rng, { shear: true });
      const b = randomAffine(rng, { mirror: true });
      const state = parseSceneDocument({
        nodes: [
          { id: 'a', parent: null, matrix: a, box: [1, 1, 1] },
          { id: 'b', parent: null, matrix: b, box: [1, 1, 1] },
        ],
        selection: ['a', 'b'],
        active: 'a',
      });
      const world = referenceWorld([
        { id: 'a', parent: null, matrix: a },
        { id: 'b', parent: null, matrix: b },
      ]);
      const pivot = new THREE.Vector3(
        (world.get('a')![3] + world.get('b')![3]) / 2,
        (world.get('a')![7] + world.get('b')![7]) / 2,
        (world.get('a')![11] + world.get('b')![11]) / 2,
      );
      const degrees = (rng() - 0.5) * 300;
      const axis = new THREE.Vector3(0, 1, 0);
      const op = new THREE.Matrix4()
        .makeTranslation(pivot.x, pivot.y, pivot.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(axis, (degrees * Math.PI) / 180))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      const result = applyTransform(state, { mode: 'rotate', space: 'world', axis: 'y', degrees });
      const after = worldMatrices(result.state);
      for (const id of ['a', 'b']) {
        const expected = fromThree(op.clone().multiply(toThree(world.get(id)!)));
        expect(matricesClose(after.get(id)!, expected, 1e-9), `node ${id}`).toBe(true);
      }
    }
  });
});

describe('spec edge cases', () => {
  it('reparent without preserving world leaves the local matrix untouched', () => {
    const state = parseSceneDocument({
      nodes: [
        { id: 'a', parent: null, matrix: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
        { id: 'b', parent: null, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
      ],
      selection: ['a'],
      active: 'a',
    });
    const originalLocal = [...state.nodes.get('a')!.matrix];
    const result = reparent(state, ['a'], 'b', { preserveWorld: false });
    expect(result.state.nodes.get('a')!.matrix).toEqual(originalLocal);
    expect(result.state.nodes.get('a')!.parent).toBe('b');
  });

  it('allows reparenting under a singular parent when world is not preserved', () => {
    const singular: Mat4 = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const state = parseSceneDocument({
      nodes: [
        { id: 'a', parent: null, matrix: identity(), box: [1, 1, 1] },
        { id: 'bad', parent: null, matrix: singular, box: [1, 1, 1] },
      ],
      selection: ['a'],
      active: 'a',
    });
    expect(() => reparent(state, ['a'], 'bad')).toThrowError(/奇异/);
    const result = reparent(state, ['a'], 'bad', { preserveWorld: false });
    expect(result.state.nodes.get('a')!.parent).toBe('bad');
  });

  it('rejects a self-parent document and duplicate selection entries are deduplicated', () => {
    expect(() =>
      parseSceneDocument({
        nodes: [{ id: 'a', parent: 'a', matrix: identity(), box: [1, 1, 1] }],
      }),
    ).toThrowError(/循环/);
    const state = parseSceneDocument({
      nodes: [
        { id: 'a', parent: null, matrix: identity(), box: [1, 1, 1] },
        { id: 'b', parent: null, matrix: identity(), box: [1, 1, 1] },
      ],
      selection: ['a', 'a', 'b'],
      active: 'a',
    });
    expect(state.selection).toEqual(['a', 'b']);
  });

  it('honours the 1e-12 determinant singular threshold', () => {
    const atThreshold = [1e-12, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const above = [2e-12, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const state = parseSceneDocument({
      nodes: [
        { id: 'edge', parent: null, matrix: atThreshold, box: [1, 1, 1] },
        { id: 'ok', parent: null, matrix: above, box: [1, 1, 1] },
        { id: 'a', parent: null, matrix: identity(), box: [1, 1, 1] },
      ],
      selection: ['a'],
      active: 'a',
    });
    expect(() => reparent(state, ['a'], 'edge')).toThrowError(/奇异/);
    // A determinant above the threshold is invertible and must be accepted.
    expect(() => reparent(state, ['a'], 'ok')).not.toThrow();
  });

  it('keeps every selected descendant in place when only its ancestor moves', () => {
    const nodes: SceneNode[] = [
      { id: 'root', parent: null, matrix: identity(), box: [1, 1, 1] },
      { id: 'mid', parent: 'root', matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
      { id: 'leaf', parent: 'mid', matrix: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
      { id: 'other', parent: null, matrix: identity(), box: [1, 1, 1] },
    ];
    const state = parseSceneDocument({ nodes, selection: ['mid', 'leaf'], active: 'leaf' });
    expect(selectionRoots(state)).toEqual(['mid']);
    const beforeLeafLocal = [...state.nodes.get('leaf')!.matrix];
    const result = applyTransform(state, { mode: 'translate', space: 'world', axis: 'x', distance: 3 });
    expect(result.moved).toEqual(['mid']);
    expect(result.state.nodes.get('leaf')!.matrix).toEqual(beforeLeafLocal);
    const world = worldMatrices(result.state);
    expect(world.get('leaf')![3]).toBeCloseTo(3 + 1 + 1, 12);
  });
});
