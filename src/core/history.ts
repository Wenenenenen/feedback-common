import type { SceneState } from './types';
import { SceneError } from './types';
import { MIN_HISTORY, cloneState } from './scene';

export type HistoryLabel = string;

interface Snapshot {
  nodes: Map<string, { id: string; parent: string | null; matrix: number[]; box: [number, number, number] }>;
  order: string[];
}

interface HistoryEntry {
  label: HistoryLabel;
  before: Snapshot;
  after: Snapshot;
  beforeSelection: string[];
  beforeActive: string | null;
  afterSelection: string[];
  afterActive: string | null;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  undoLabels: string[];
  redoLabels: string[];
  limit: number;
}

function snapshot(state: SceneState): Snapshot {
  const nodes: Snapshot['nodes'] = new Map();
  for (const id of state.order) {
    const node = state.nodes.get(id)!;
    nodes.set(id, {
      id: node.id,
      parent: node.parent,
      matrix: node.matrix.slice(),
      box: [node.box[0], node.box[1], node.box[2]],
    });
  }
  return { nodes, order: state.order.slice() };
}

function restoreSnapshot(snap: Snapshot, selection: string[], active: string | null): SceneState {
  const nodes = new Map<string, { id: string; parent: string | null; matrix: number[]; box: [number, number, number] }>();
  for (const id of snap.order) {
    const node = snap.nodes.get(id)!;
    nodes.set(id, {
      id: node.id,
      parent: node.parent,
      matrix: node.matrix.slice(),
      box: [node.box[0], node.box[1], node.box[2]],
    });
  }
  const selectionPresent = selection.filter((id) => nodes.has(id));
  const activePresent = active !== null && selectionPresent.includes(active) ? active : selectionPresent[0] ?? null;
  return { nodes, order: snap.order.slice(), selection: selectionPresent, active: activePresent };
}

/**
 * Scene document plus transactional undo/redo history. A transaction is atomic:
 * nodes, parent references, matrices, selection and active are committed
 * together, and any thrown error leaves both the document and the history
 * exactly as they were. Selection changes outside transactions only touch the
 * selection/active fields and never rewrite matrices.
 */
export class SceneStore {
  private current: SceneState;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(state: SceneState, history: HistoryInfo) => void>();
  readonly historyLimit: number;
  /** Monotonic document revision; changes whenever transforms or hierarchy change. */
  private revision = 0;

  constructor(initial: SceneState, historyLimit = 200) {
    if (historyLimit < MIN_HISTORY) throw new SceneError('internal', `撤销步数下限为 ${MIN_HISTORY}`);
    this.current = cloneState(initial);
    this.historyLimit = historyLimit;
  }

  getState(): SceneState {
    return this.current;
  }

  getRevision(): number {
    return this.revision;
  }

  private touch(): void {
    this.revision += 1;
  }

  subscribe(listener: (state: SceneState, history: HistoryInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const history = this.historyInfo();
    for (const listener of this.listeners) listener(this.current, history);
  }

  historyInfo(): HistoryInfo {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      undoLabels: this.undoStack.map((entry) => entry.label),
      redoLabels: this.redoStack.map((entry) => entry.label),
      limit: this.historyLimit,
    };
  }

  /** Loads a fresh document and clears both history stacks. */
  load(state: SceneState): void {
    this.current = cloneState(state);
    this.undoStack = [];
    this.redoStack = [];
    this.touch();
    this.emit();
  }

  /** Selection-only update; never records history nor modifies matrices. */
  updateSelection(ids: readonly string[], active: string | null): void {
    const seen = new Set<string>();
    const selection: string[] = [];
    for (const id of ids) {
      if (!this.current.nodes.has(id)) {
        throw new SceneError('invalid-selection', `无法选择不存在的节点：${id}`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        selection.push(id);
      }
    }
    if (active !== null && !seen.has(active)) {
      throw new SceneError('invalid-selection', `活动节点 ${active} 必须属于选择集`);
    }
    this.current.selection = selection;
    this.current.active = selection.length === 0 ? null : active ?? selection[0];
    this.emit();
  }

  /**
   * Runs `operation` against the current document and commits the result as one
   * transaction. On failure nothing is written and history is untouched.
   * The operation must return the new document; it may mutate a draft state.
   */
  transact(label: string, operation: (draft: SceneState) => SceneState): SceneState {
    const draft = cloneState(this.current);
    const next = operation(draft);
    if (next.nodes.size > this.current.nodes.size) {
      // Node creation is not part of this editor; guard against accidental growth.
      throw new SceneError('internal', '事务不能新增节点');
    }
    const entry: HistoryEntry = {
      label,
      before: snapshot(this.current),
      after: snapshot(next),
      beforeSelection: this.current.selection.slice(),
      beforeActive: this.current.active,
      afterSelection: next.selection.slice(),
      afterActive: next.active,
    };
    this.current = next;
    this.touch();
    this.undoStack.push(entry);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    return next;
  }

  /** Replaces the document state inside a transaction (used by imports/edits). */
  replaceInTransaction(label: string, next: SceneState): SceneState {
    return this.transact(label, () => next);
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(entry);
    this.current = restoreSnapshot(entry.before, entry.beforeSelection, entry.beforeActive);
    this.touch();
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push(entry);
    this.current = restoreSnapshot(entry.after, entry.afterSelection, entry.afterActive);
    this.touch();
    this.emit();
    return true;
  }
}
