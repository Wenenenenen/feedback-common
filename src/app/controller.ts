import { SceneStore, type HistoryInfo } from '../core/history';
import {
  MAX_NODES,
  activeSelectionRoot,
  applyTransform,
  emptyScene,
  parseSceneDocument,
  reparent,
  selectionRoots,
  serializeScene,
  setLocalMatrix,
  worldMatrices,
} from '../core/scene';
import type { Mat4, SceneState, TransformRequest, Vec3 } from '../core/types';
import { SceneError } from '../core/types';
import { averageOrigin, columnVector, linearInfo, normalize3, originOf } from '../core/matrix';

export interface AppSnapshot {
  state: SceneState;
  worlds: Map<string, Mat4>;
  revision: number;
  history: HistoryInfo;
  selectionRoots: string[];
  activeRoot: string | null;
  pivot: Vec3 | null;
  localAxes: { x: Vec3; y: Vec3; z: Vec3 } | null;
}

type Listener = (snapshot: AppSnapshot) => void;
type Notice = (kind: 'success' | 'error' | 'info' | 'warn', title: string, detail?: string) => void;

export interface LoadResult {
  ok: boolean;
  error?: string;
  warnings: string[];
}

export class Controller {
  readonly store: SceneStore;
  private listeners = new Set<Listener>();
  private noticeListeners = new Set<Notice>();
  private worldCache: { state: SceneState; matrices: Map<string, Mat4> } | null = null;
  private sourceName = '未命名场景';
  private dirty = false;

  constructor(historyLimit = 200) {
    this.store = new SceneStore(emptyScene(), historyLimit);
  }

  onNotice(listener: Notice): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  notify(kind: 'success' | 'error' | 'info' | 'warn', title: string, detail?: string): void {
    for (const listener of this.noticeListeners) listener(kind, title, detail);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  snapshot(): AppSnapshot {
    const state = this.store.getState();
    const roots = selectionRoots(state);
    const matrices = this.worlds();
    return {
      state,
      worlds: matrices,
      revision: this.store.getRevision(),
      history: this.store.historyInfo(),
      selectionRoots: roots,
      activeRoot: activeSelectionRoot(state, roots),
      pivot: roots.length > 0 ? averageOrigin(roots.map((id) => matrices.get(id)!)) : null,
      // Local axes always come from the active selection root, matching applyTransform.
      localAxes: this.localAxesForRoot(this.worlds().get(activeSelectionRoot(state, roots) ?? '') ?? null),
    };
  }

  /**
   * Columns of the root's world matrix, normalized. A zero-length column is a
   * singular axis, not a crash: the axes are reported as null so read-only
   * snapshots never throw, and the transform itself still rejects the operation.
   */
  private localAxesForRoot(world: Mat4 | null) {
    if (!world) return null;
    const columns = [columnVector(world, 0), columnVector(world, 1), columnVector(world, 2)];
    for (const column of columns) {
      if (!column.every((v) => Number.isFinite(v)) || Math.hypot(...column) === 0) return null;
    }
    return {
      x: normalize3(columns[0]),
      y: normalize3(columns[1]),
      z: normalize3(columns[2]),
    };
  }

  /** World matrices shared with the viewport; invalidated on every state change. */
  worlds(): Map<string, Mat4> {
    const state = this.store.getState();
    if (this.worldCache?.state !== state) {
      this.worldCache = { state, matrices: worldMatrices(state) };
    }
    return this.worldCache.matrices;
  }

  get source(): string {
    return this.sourceName;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  loadDocument(raw: unknown, sourceName: string): LoadResult {
    try {
      const state = parseSceneDocument(raw);
      this.store.load(state);
      this.worldCache = null;
      this.sourceName = sourceName;
      this.dirty = false;
      this.emit();
      const warnings: string[] = [];
      const singular = state.order.filter((id) => linearInfo(this.worlds().get(id)!).singular);
      if (singular.length > 0) {
        warnings.push(`包含 ${singular.length} 个世界矩阵奇异的节点（需保留世界换父时会拒绝）`);
      }
      const mirrored = state.order.filter((id) => {
        const info = linearInfo(this.worlds().get(id)!);
        return info.mirrored && !info.singular;
      });
      if (mirrored.length > 0) warnings.push(`包含 ${mirrored.length} 个镜像节点`);
      const sheared = state.order.filter((id) => linearInfo(this.worlds().get(id)!).sheared);
      if (sheared.length > 0) warnings.push(`包含 ${sheared.length} 个剪切节点，矩阵按完整仿射保存`);
      return { ok: true, warnings };
    } catch (error) {
      const message = error instanceof SceneError ? error.message : error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, warnings: [] };
    }
  }

  loadEmpty(): void {
    this.store.load(emptyScene());
    this.worldCache = null;
    this.sourceName = '未命名场景';
    this.dirty = false;
    this.emit();
  }

  updateSelection(ids: readonly string[], active: string | null): boolean {
    try {
      this.store.updateSelection(ids, active);
      this.emit();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  toggleSelection(id: string, additive: boolean): void {
    const state = this.store.getState();
    if (!additive) {
      this.updateSelection([id], id);
      return;
    }
    const selection = state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id];
    const active = state.selection.includes(id) ? (selection.length > 0 ? selection[selection.length - 1] : null) : id;
    this.updateSelection(selection, active);
  }

  setActive(id: string, additive = false): void {
    const state = this.store.getState();
    if (additive) {
      if (!state.selection.includes(id)) {
        this.updateSelection([...state.selection, id], id);
      } else {
        this.updateSelection(state.selection, id);
      }
    } else if (state.selection.length === 1 && state.selection[0] === id) {
      this.updateSelection(state.selection, id);
    } else {
      this.updateSelection([id], id);
    }
  }

  clearSelection(): void {
    this.updateSelection([], null);
  }

  selectAll(): void {
    const state = this.store.getState();
    if (state.order.length === 0) return;
    const active = state.active ?? state.order[0];
    this.updateSelection(state.order, active);
  }

  private reportError(error: unknown): void {
    if (error instanceof SceneError) {
      const label = ERROR_LABELS[error.code] ?? error.code;
      this.notify('error', error.message, `错误码 ${error.code} · ${label} · 已回滚，未改动任何数据`);
    } else if (error instanceof Error) {
      this.notify('error', error.message);
    } else {
      this.notify('error', String(error));
    }
  }

  private runTransaction(label: string, operation: (draft: SceneState) => SceneState, success?: string): boolean {
    try {
      this.store.transact(label, operation);
      this.worldCache = null;
      this.dirty = true;
      this.emit();
      if (success) this.notify('success', success);
      return true;
    } catch (error) {
      // Store.transact never mutates the committed document on failure.
      this.reportError(error);
      return false;
    }
  }

  reparentSelection(targetId: string | null, preserveWorld: boolean): boolean {
    const state = this.store.getState();
    return this.reparentNodes(state.selection, targetId, preserveWorld);
  }

  /**
   * Reparents exactly the given nodes (or their topmost selected ancestors),
   * committing hierarchy, matrices and the resulting selection in one transaction.
   */
  reparentNodes(ids: readonly string[], targetId: string | null, preserveWorld: boolean): boolean {
    const state = this.store.getState();
    const selected = new Set(ids.filter((id) => state.nodes.has(id)));
    if (selected.size === 0) {
      this.notify('warn', '请先选择要换父的节点');
      return false;
    }
    const roots = selectionRootsOf(state, [...selected]);
    if (roots.length === 0) {
      this.notify('warn', '请先选择要换父的节点');
      return false;
    }
    if (targetId !== null && !state.nodes.has(targetId)) {
      this.notify('error', '目标父节点不存在');
      return false;
    }
    const targetLabel = targetId === null ? '根节点' : targetId;
    const noop = roots.every((id) => state.nodes.get(id)!.parent === targetId);
    if (noop) {
      this.notify('info', '层级没有变化', roots.length > 1 ? `这 ${roots.length} 个顶层节点已经属于 ${targetLabel}` : undefined);
      return false;
    }
    const label = `换父 ${roots.length > 1 ? `${roots.length} 个顶层节点` : roots[0]} → ${targetLabel}`;
    // Dragging a node that is not part of the selection adopts that node as the
    // selection inside the same transaction, so hierarchy and selection undo together.
    const adoptSelection = !state.selection.includes(roots[0]) || roots.some((id) => !state.selection.includes(id));
    return this.runTransaction(
      label,
      (draft) => {
        if (adoptSelection) {
          draft.selection = [...selected];
          draft.active = roots.includes(draft.active ?? '') ? draft.active : roots[0];
          // Keep the active node inside the selection.
          if (draft.active === null || !draft.selection.includes(draft.active)) draft.active = roots[0];
        }
        return reparent(draft, roots, targetId, { preserveWorld }).state;
      },
      preserveWorld ? `已换父并保留世界变换 · ${roots.length} 个顶层节点` : `已换父（未保留世界变换）· ${roots.length} 个顶层节点`,
    );
  }

  translate(space: 'world' | 'local', axis: 'x' | 'y' | 'z', distance: number): boolean {
    if (!Number.isFinite(distance) || distance === 0) {
      if (!Number.isFinite(distance)) this.notify('error', '平移距离必须是有限数值');
      return false;
    }
    const roots = selectionRoots(this.store.getState());
    if (roots.length === 0) {
      this.notify('warn', '请先选择节点');
      return false;
    }
    const request: TransformRequest = { mode: 'translate', space, axis, distance };
    return this.runTransaction(
      `平移 ${space === 'world' ? '世界' : '本地'} ${axis.toUpperCase()} ${formatNumber(distance)} m`,
      (draft) => applyTransform(draft, request).state,
      `已平移 ${roots.length} 个顶层节点`,
    );
  }

  rotate(space: 'world' | 'local', axis: 'x' | 'y' | 'z', degrees: number): boolean {
    if (!Number.isFinite(degrees) || degrees === 0) {
      if (!Number.isFinite(degrees)) this.notify('error', '旋转角度必须是有限数值');
      return false;
    }
    const roots = selectionRoots(this.store.getState());
    if (roots.length === 0) {
      this.notify('warn', '请先选择节点');
      return false;
    }
    const request: TransformRequest = { mode: 'rotate', space, axis, degrees };
    return this.runTransaction(
      `旋转 ${space === 'world' ? '世界' : '本地'} ${axis.toUpperCase()} ${formatNumber(degrees)}°`,
      (draft) => applyTransform(draft, request).state,
      `已旋转 ${roots.length} 个顶层节点（右手定则）`,
    );
  }

  applyActiveMatrix(matrix: Mat4): boolean {
    const state = this.store.getState();
    const id = state.active;
    if (id === null) {
      this.notify('warn', '请先选择一个节点');
      return false;
    }
    const current = state.nodes.get(id)!.matrix;
    if (current.length === matrix.length && current.every((v, i) => v === matrix[i])) {
      this.notify('info', '矩阵没有变化');
      return false;
    }
    return this.runTransaction(`编辑矩阵 ${id}`, (draft) => setLocalMatrix(draft, id, matrix), `已写入 ${id} 的局部矩阵`);
  }

  setLocalMatrixDirect(id: string, matrix: Mat4): boolean {
    const current = this.store.getState().nodes.get(id);
    if (!current) {
      this.notify('error', `节点不存在：${id}`);
      return false;
    }
    if (current.matrix.length === matrix.length && current.matrix.every((v, i) => Object.is(v, matrix[i]))) {
      this.notify('info', '矩阵没有变化', id);
      return false;
    }
    return this.runTransaction(`编辑矩阵 ${id}`, (draft) => setLocalMatrix(draft, id, matrix), `已写入 ${id} 的局部矩阵`);
  }

  undo(): boolean {
    if (!this.store.undo()) {
      this.notify('info', '没有可撤销的操作');
      return false;
    }
    this.worldCache = null;
    this.dirty = true;
    this.emit();
    const info = this.store.historyInfo();
    this.notify('info', '已撤销', info.redoLabels[info.redoLabels.length - 1]);
    return true;
  }

  redo(): boolean {
    if (!this.store.redo()) {
      this.notify('info', '没有可重做的操作');
      return false;
    }
    this.worldCache = null;
    this.dirty = true;
    this.emit();
    const info = this.store.historyInfo();
    this.notify('info', '已重做', info.undoLabels[info.undoLabels.length - 1]);
    return true;
  }

  /** Serializes the full document; local matrices keep all affine components. */
  exportDocument(): string {
    return JSON.stringify(serializeScene(this.store.getState()));
  }

  /** Compares a serialized round trip against the live scene. */
  verifyRoundTrip(): { ok: boolean; maxWorldDelta: number; maxLocalDelta: number; nodes: number; error?: string } {
    try {
      const json = this.exportDocument();
      const reloaded = parseSceneDocument(JSON.parse(json));
      const before = this.worlds();
      this.worldCache = null;
      const after = worldMatrices(reloaded);
      let maxWorldDelta = 0;
      let maxLocalDelta = 0;
      for (const id of reloaded.order) {
        const a = before.get(id);
        const b = after.get(id);
        if (!a || !b) return { ok: false, maxWorldDelta: Infinity, maxLocalDelta: Infinity, nodes: reloaded.order.length, error: `缺少节点 ${id}` };
        maxWorldDelta = Math.max(maxWorldDelta, maxDelta(a, b));
        maxLocalDelta = Math.max(maxLocalDelta, maxDelta(reloaded.nodes.get(id)!.matrix, this.store.getState().nodes.get(id)!.matrix));
      }
      this.worldCache = null;
      return {
        ok: maxWorldDelta <= 1e-9 && maxLocalDelta <= 0,
        maxWorldDelta,
        maxLocalDelta,
        nodes: reloaded.order.length,
      };
    } catch (error) {
      return {
        ok: false,
        maxWorldDelta: Infinity,
        maxLocalDelta: Infinity,
        nodes: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  nodeSummary(id: string) {
    const state = this.store.getState();
    const node = state.nodes.get(id);
    if (!node) return null;
    const world = this.worlds().get(id)!;
    return {
      node,
      world,
      origin: originOf(world),
      info: linearInfo(world),
      localInfo: linearInfo(node.matrix),
      parent: node.parent,
      depth: depthOf(state, id),
    };
  }

  layoutInfo(): { nodes: number; maxNodes: number; singular: number; mirrored: number; sheared: number } {
    const state = this.store.getState();
    let singular = 0;
    let mirrored = 0;
    let sheared = 0;
    for (const id of state.order) {
      const info = linearInfo(this.worlds().get(id)!);
      if (info.singular) singular += 1;
      else {
        if (info.mirrored) mirrored += 1;
        if (info.sheared) sheared += 1;
      }
    }
    return { nodes: state.order.length, maxNodes: MAX_NODES, singular, mirrored, sheared };
  }
}

function selectionRootsOf(state: SceneState, ids: readonly string[]): string[] {
  const idSet = new Set(ids);
  return ids.filter((id) => {
    let current = state.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      if (idSet.has(current)) return false;
      current = state.nodes.get(current)?.parent ?? null;
    }
    return true;
  });
}

function depthOf(state: SceneState, id: string): number {
  let depth = 0;
  let current = state.nodes.get(id)?.parent ?? null;
  while (current !== null) {
    depth += 1;
    current = state.nodes.get(current)?.parent ?? null;
  }
  return depth;
}

function maxDelta(a: Mat4, b: Mat4): number {
  let max = 0;
  for (let i = 0; i < 16; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

const ERROR_LABELS: Record<string, string> = {
  'invalid-document': '文档格式错误',
  'invalid-node': '节点格式错误',
  'invalid-matrix': '矩阵非法',
  'non-finite': '存在非法数值',
  'duplicate-id': '重复 id',
  'missing-parent': '父节点不存在',
  cycle: '循环引用',
  limit: '超出节点上限',
  'not-found': '节点不存在',
  'empty-selection': '未选择节点',
  'zero-axis': '轴长为零',
  'singular-parent': '父矩阵奇异',
  'invalid-selection': '选择非法',
  internal: '内部校验失败',
};

export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 100000 || abs < 0.0001)) return value.toExponential(3);
  const rounded = Number(value.toFixed(digits));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
