import { describe, expect, it } from 'vitest';
import { SceneStore } from '../../src/core/history';
import { applyTransform, parseSceneDocument, reparent, serializeScene, setLocalMatrix, worldMatrices } from '../../src/core/scene';
import { matricesClose, identity } from '../../src/core/matrix';
import type { SceneState } from '../../src/core/types';

const I = identity();

function tinyScene(): SceneState {
  return parseSceneDocument({
    nodes: [
      { id: 'a', parent: null, matrix: I, box: [1, 1, 1] },
      { id: 'b', parent: 'a', matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
      { id: 'c', parent: null, matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
    ],
    selection: ['b'],
    active: 'b',
  });
}

describe('transactional history', () => {
  it('restores hierarchy, matrices and selection on undo/redo', () => {
    const store = new SceneStore(tinyScene());
    const original = serializeScene(store.getState());
    store.transact('换父', (draft) => {
      const result = reparent(draft, ['b'], 'c');
      return result.state;
    });
    expect(store.getState().nodes.get('b')!.parent).toBe('c');
    store.updateSelection(['b', 'c'], 'b');
    expect(store.getState().selection).toEqual(['b', 'c']);

    expect(store.undo()).toBe(true);
    expect(serializeScene(store.getState())).toEqual(original);
    expect(store.getState().selection).toEqual(['b']);
    expect(store.redo()).toBe(true);
    expect(store.getState().nodes.get('b')!.parent).toBe('c');
    // Redo restores the transaction's committed selection; later selection-only
    // changes are not transactions and are not replayed.
    expect(store.getState().selection).toEqual(['b']);
  });

  it('rolls back completely when an operation throws', () => {
    const store = new SceneStore(tinyScene());
    const before = serializeScene(store.getState());
    const history = store.historyInfo();
    expect(() =>
      store.transact('非法换父', (draft) => {
        draft.nodes.get('c')!.matrix[0] = 0; // simulate partial mutation before failing
        return reparent(draft, ['a'], 'b').state;
      }),
    ).toThrowError(/循环/);
    expect(serializeScene(store.getState())).toEqual(before);
    expect(store.historyInfo().undoCount).toBe(history.undoCount);
    expect(store.historyInfo().canRedo).toBe(false);
  });

  it('does not record selection changes in history', () => {
    const store = new SceneStore(tinyScene());
    const before = serializeScene(store.getState());
    store.updateSelection(['a', 'c'], 'c');
    expect(store.historyInfo().undoCount).toBe(0);
    expect(serializeScene({ ...store.getState(), selection: [], active: null })).toEqual({ ...before, selection: [], active: null });
  });

  it('keeps at least 100 undo steps and drops the oldest beyond the limit', () => {
    const store = new SceneStore(tinyScene(), 120);
    for (let i = 1; i <= 130; i += 1) {
      store.transact(`平移 ${i}`, (draft) => applyTransform(draft, { mode: 'translate', space: 'world', axis: 'x', distance: 1 }).state);
    }
    expect(store.historyInfo().undoCount).toBe(120);
    let undone = 0;
    while (store.undo()) undone += 1;
    expect(undone).toBe(120);
    expect(store.historyInfo().redoCount).toBe(120);
  });

  it('supports 100+ undo/redo round trips returning to the exact document', () => {
    const store = new SceneStore(tinyScene());
    const start = serializeScene(store.getState());
    for (let i = 0; i < 110; i += 1) {
      store.transact(`步骤 ${i}`, (draft) => applyTransform(draft, { mode: 'rotate', space: 'world', axis: 'y', degrees: 1 }).state);
    }
    const end = serializeScene(store.getState());
    for (let i = 0; i < 110; i += 1) expect(store.undo()).toBe(true);
    expect(serializeScene(store.getState())).toEqual(start);
    for (let i = 0; i < 110; i += 1) expect(store.redo()).toBe(true);
    expect(serializeScene(store.getState())).toEqual(end);
  });

  it('clears redo after a new transaction', () => {
    const store = new SceneStore(tinyScene());
    store.transact('一', (draft) => applyTransform(draft, { mode: 'translate', space: 'world', axis: 'x', distance: 1 }).state);
    store.undo();
    expect(store.historyInfo().canRedo).toBe(true);
    store.transact('二', (draft) => applyTransform(draft, { mode: 'translate', space: 'world', axis: 'x', distance: 2 }).state);
    expect(store.historyInfo().canRedo).toBe(false);
  });
});

describe('export / reload round trip', () => {
  it('preserves world positions and shear across a JSON round trip', () => {
    const store = new SceneStore(tinyScene());
    // Mirror + shear + non-uniform scale.
    const tricky = [1, 0.6, 0, 3, 0, 2, 0.1, -1, 0, 0, -0.5, 2, 0, 0, 0, 1];
    store.transact('设置矩阵', (draft) => setLocalMatrix(draft, 'b', tricky));
    store.transact('换父', (draft) => reparent(draft, ['b'], 'c').state);
    const worldBefore = worldMatrices(store.getState());

    const json = JSON.stringify(serializeScene(store.getState()));
    const reloaded = parseSceneDocument(JSON.parse(json));
    const worldAfter = worldMatrices(reloaded);
    for (const id of ['a', 'b', 'c']) {
      expect(matricesClose(worldAfter.get(id)!, worldBefore.get(id)!, 1e-12)).toBe(true);
    }
    expect(reloaded.nodes.get('b')!.parent).toBe('c');
    expect(reloaded.nodes.get('b')!.matrix).toEqual(store.getState().nodes.get('b')!.matrix);
  });
});
