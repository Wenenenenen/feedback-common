import type { Axis, Mat4, SceneNode, SceneState, TransformRequest, Vec3 } from './types';
import { SceneError } from './types';
import {
  applyDirection,
  assertAffineMatrix,
  averageOrigin,
  cloneMatrix,
  columnVector,
  identity,
  invertAffine,
  isFiniteMatrix,
  isSingular,
  linearInfo,
  multiply,
  normalize3,
  originOf,
  pivotTransform,
  rotationMatrix,
  translationMatrix,
} from './matrix';

export const MAX_NODES = 500;
export const MIN_HISTORY = 100;

export interface SerializedScene {
  nodes: Array<{ id: string; parent: string | null; matrix: Mat4; box: Vec3 }>;
  selection: string[];
  active: string | null;
}

export interface ReparentResult {
  state: SceneState;
  moved: string[];
}

export interface TransformResult {
  state: SceneState;
  moved: string[];
  pivot: Vec3;
  axis: Vec3;
}

/** Makes a deep, independent copy of a scene state. */
export function cloneState(state: SceneState): SceneState {
  const nodes = new Map<string, SceneNode>();
  for (const id of state.order) {
    const node = state.nodes.get(id)!;
    nodes.set(id, {
      id: node.id,
      parent: node.parent,
      matrix: cloneMatrix(node.matrix),
      box: [node.box[0], node.box[1], node.box[2]],
    });
  }
  return {
    nodes,
    order: state.order.slice(),
    selection: state.selection.slice(),
    active: state.active,
  };
}

export function emptyScene(): SceneState {
  return { nodes: new Map(), order: [], selection: [], active: null };
}

function assertBox(box: unknown, id: string): asserts box is Vec3 {
  if (
    !Array.isArray(box) ||
    box.length !== 3 ||
    !box.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
  ) {
    throw new SceneError('invalid-node', `节点 ${id} 的 box 必须是 3 个正的有限数值`);
  }
}

/**
 * Validates and builds a scene from raw JSON. All-or-nothing: any invalid node,
 * matrix, parent reference, cycle or selection reference rejects the document.
 */
export function parseSceneDocument(raw: unknown): SceneState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SceneError('invalid-document', '场景必须是 JSON 对象');
  }
  const doc = raw as Record<string, unknown>;
  const rawNodes = doc.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new SceneError('invalid-document', 'nodes 必须是数组');
  }
  if (rawNodes.length > MAX_NODES) {
    throw new SceneError('limit', `节点数量 ${rawNodes.length} 超过上限 ${MAX_NODES}`);
  }
  const nodes = new Map<string, SceneNode>();
  const order: string[] = [];
  for (const item of rawNodes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SceneError('invalid-node', '节点必须是对象');
    }
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id.length === 0) {
      throw new SceneError('invalid-node', '节点 id 必须是非空字符串');
    }
    const id = n.id;
    if (nodes.has(id)) {
      throw new SceneError('duplicate-id', `节点 id 重复：${id}`);
    }
    const parent = n.parent;
    if (parent !== null && parent !== undefined && typeof parent !== 'string') {
      throw new SceneError('invalid-node', `节点 ${id} 的 parent 必须是字符串或 null`);
    }
    assertAffineMatrix(n.matrix, `节点 ${id} 的矩阵`);
    assertBox(n.box, id);
    nodes.set(id, {
      id,
      parent: typeof parent === 'string' ? parent : null,
      matrix: cloneMatrix(n.matrix as Mat4),
      box: [...(n.box as Vec3)] as Vec3,
    });
    order.push(id);
  }
  for (const id of order) {
    const parent = nodes.get(id)!.parent;
    if (parent !== null) {
      if (!nodes.has(parent)) {
        throw new SceneError('missing-parent', `节点 ${id} 的父节点 ${parent} 不存在`);
      }
      if (parent === id) {
        throw new SceneError('cycle', `检测到循环引用：节点 ${id} 以自己为父节点`);
      }
    }
  }
  assertAcyclic(nodes);

  const selectionRaw = doc.selection;
  const selection: string[] = [];
  if (selectionRaw !== undefined && selectionRaw !== null) {
    if (!Array.isArray(selectionRaw)) {
      throw new SceneError('invalid-document', 'selection 必须是数组');
    }
    const seen = new Set<string>();
    for (const id of selectionRaw) {
      if (typeof id !== 'string' || !nodes.has(id)) {
        throw new SceneError('invalid-selection', `selection 引用了不存在的节点：${String(id)}`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        selection.push(id);
      }
    }
  }
  const activeRaw = doc.active;
  let active: string | null = null;
  if (activeRaw !== undefined && activeRaw !== null) {
    if (typeof activeRaw !== 'string' || !nodes.has(activeRaw)) {
      throw new SceneError('invalid-selection', `active 引用了不存在的节点：${String(activeRaw)}`);
    }
    if (!selection.includes(activeRaw)) {
      throw new SceneError('invalid-selection', `active 节点 ${activeRaw} 必须属于 selection`);
    }
    active = activeRaw;
  }
  return { nodes, order, selection, active };
}

export function serializeScene(state: SceneState): SerializedScene {
  return {
    nodes: state.order.map((id) => {
      const node = state.nodes.get(id)!;
      return {
        id: node.id,
        parent: node.parent,
        matrix: cloneMatrix(node.matrix),
        box: [...node.box] as Vec3,
      };
    }),
    selection: state.selection.slice(),
    active: state.active,
  };
}

export function assertAcyclic(nodes: Map<string, SceneNode>): void {  const state = new Map<string, 0 | 1 | 2>();
  for (const id of nodes.keys()) state.set(id, 0);
  for (const start of nodes.keys()) {
    if (state.get(start) !== 0) continue;
    const chain: string[] = [];
    let current: string | null = start;
    while (current !== null) {
      const status = state.get(current);
      if (status === 1) {
        throw new SceneError('cycle', `检测到循环引用：${[...chain, current].join(' → ')}`);
      }
      if (status === 2) break;
      state.set(current, 1);
      chain.push(current);
      current = nodes.get(current)!.parent;
    }
    for (const id of chain) state.set(id, 2);
  }
}

/** Returns the parent chain from the root down to (but excluding) the node. */
export function ancestorsOf(state: SceneState, id: string): string[] {
  const out: string[] = [];
  let current = state.nodes.get(id)?.parent ?? null;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) throw new SceneError('cycle', `节点 ${id} 的祖先链存在循环`);
    seen.add(current);
    out.push(current);
    current = state.nodes.get(current)?.parent ?? null;
  }
  return out;
}

export function isDescendantOf(state: SceneState, candidate: string, ancestor: string): boolean {
  return ancestorsOf(state, candidate).includes(ancestor);
}

export function worldMatrices(state: SceneState): Map<string, Mat4> {
  const cache = new Map<string, Mat4>();
  const resolve = (id: string, stack: Set<string>): Mat4 => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (stack.has(id)) throw new SceneError('cycle', `检测到循环引用：${id}`);
    const node = state.nodes.get(id);
    if (!node) throw new SceneError('not-found', `节点不存在：${id}`);
    stack.add(id);
    const parentWorld = node.parent === null ? identity() : resolve(node.parent, stack);
    stack.delete(id);
    const world = multiply(parentWorld, node.matrix);
    cache.set(id, world);
    return world;
  };
  for (const id of state.order) resolve(id, new Set());
  return cache;
}

export function worldMatrixOf(state: SceneState, id: string, cache?: Map<string, Mat4>): Mat4 {
  return (cache ?? worldMatrices(state)).get(id)!;
}

/**
 * Selected nodes with no selected ancestor, in document order. These are the
 * only nodes a batch operation moves; descendants follow their parents.
 */
export function selectionRoots(state: SceneState): string[] {
  const selected = new Set(state.selection);
  return state.selection.filter((id) => {
    for (const ancestor of ancestorsOf(state, id)) {
      if (selected.has(ancestor)) return false;
    }
    return true;
  });
}

/** The selection root that contains the active node, falling back to the first root. */
export function activeSelectionRoot(state: SceneState, roots = selectionRoots(state)): string | null {
  if (roots.length === 0) return null;
  if (state.active !== null) {
    const chain = new Set([state.active, ...ancestorsOf(state, state.active)]);
    for (const root of roots) {
      if (chain.has(root)) return root;
    }
  }
  return roots[0];
}

export function setSelection(state: SceneState, ids: readonly string[], active: string | null): void {
  const seen = new Set<string>();
  const selection: string[] = [];
  for (const id of ids) {
    if (!state.nodes.has(id)) {
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
  state.selection = selection;
  state.active = active;
}

export interface ReparentOptions {
  /** Default true: new local = inverse(new parent world) * old world. */
  preserveWorld?: boolean;
}

/**
 * Reparents the topmost selected roots. When preserving world transforms, the
 * whole batch is validated against the final hierarchy before any matrix is
 * written; a cycle, singular target parent or non-finite result rejects it all.
 */
export function reparent(
  base: SceneState,
  nodeIds: readonly string[],
  newParentId: string | null,
  options: ReparentOptions = {},
): ReparentResult {
  const preserveWorld = options.preserveWorld ?? true;
  const state = cloneState(base);
  if (nodeIds.length === 0) {
    throw new SceneError('empty-selection', '没有可移动的节点');
  }
  for (const id of nodeIds) {
    if (!state.nodes.has(id)) throw new SceneError('not-found', `节点不存在：${id}`);
  }
  if (newParentId !== null && !state.nodes.has(newParentId)) {
    throw new SceneError('not-found', `目标父节点不存在：${newParentId}`);
  }
  const ids = selectionRootsOf(state, nodeIds);
  if (ids.length === 0) {
    throw new SceneError('empty-selection', '没有可移动的节点');
  }

  const oldWorld = worldMatrices(state);
  const before = new Map<string, Mat4>();
  const oldParents = new Map<string, string | null>();
  for (const id of ids) {
    before.set(id, oldWorld.get(id)!);
    oldParents.set(id, state.nodes.get(id)!.parent);
  }

  for (const id of ids) {
    state.nodes.get(id)!.parent = newParentId;
  }
  // Full-hierarchy cycle check (a new parent may be inside another moved root).
  assertAcyclic(state.nodes);

  if (preserveWorld) {
    const newWorld = worldMatrices(state);
    for (const id of ids) {
      const node = state.nodes.get(id)!;
      const parentWorld = node.parent === null ? identity() : newWorld.get(node.parent)!;
      const local = multiply(invertAffine(parentWorld, `目标父节点 ${node.parent} 的世界矩阵奇异，无法保留世界变换`), before.get(id)!);
      assertResultMatrix(local, id);
      node.matrix = local;
    }
  }

  // A preserved-world batch must leave every moved root exactly at its old world.
  if (preserveWorld) {
    const finalWorld = worldMatrices(state);
    for (const id of ids) {
      if (!matricesNearlyEqual(finalWorld.get(id)!, before.get(id)!)) {
        throw new SceneError('internal', `节点 ${id} 换父后未能保持世界变换`);
      }
    }
  }
  return { state, moved: ids };
}

function selectionRootsOf(state: SceneState, ids: readonly string[]): string[] {
  const idSet = new Set(ids);
  return ids.filter((id) => {
    for (const ancestor of ancestorsOf(state, id)) {
      if (idSet.has(ancestor)) return false;
    }
    return true;
  });
}

function assertResultMatrix(m: Mat4, id: string): void {
  if (!isFiniteMatrix(m)) {
    throw new SceneError('non-finite', `节点 ${id} 的变换结果不是有限数值`);
  }
  assertAffineMatrix(m, `节点 ${id} 的变换结果`);
}

function matricesNearlyEqual(a: Mat4, b: Mat4, eps = 1e-7): boolean {
  let scale = 1;
  for (let i = 0; i < 16; i += 1) scale = Math.max(scale, Math.abs(a[i]), Math.abs(b[i]));
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(a[i] - b[i]) > eps * scale) return false;
  }
  return true;
}

/**
 * Applies a world-space translate or rotate to the selection roots.
 *
 * Pivot: arithmetic mean of the roots' world origins. Axis: standard XYZ for
 * world space, or the normalized column of the active root's world matrix for
 * local space (not re-orthogonalized, so sheared matrices keep their axis).
 * The operation is left-multiplied in world space; each local is rewritten as
 * inverse(parent world) * new world.
 */
export function applyTransform(base: SceneState, request: TransformRequest): TransformResult {
  const state = cloneState(base);
  const roots = selectionRoots(state);
  if (roots.length === 0) {
    throw new SceneError('empty-selection', '没有选中可变换的节点');
  }
  if (request.mode === 'translate' && !Number.isFinite(request.distance)) {
    throw new SceneError('non-finite', '平移距离必须是有限数值');
  }
  if (request.mode === 'rotate' && !Number.isFinite(request.degrees)) {
    throw new SceneError('non-finite', '旋转角度必须是有限数值');
  }

  const world = worldMatrices(state);
  const pivot = averageOrigin(roots.map((id) => world.get(id)!));

  let axis: Vec3;
  if (request.space === 'world') {
    axis = request.axis === 'x' ? [1, 0, 0] : request.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  } else {
    const activeRoot = activeSelectionRoot(state, roots);
    if (activeRoot === null) throw new SceneError('empty-selection', '没有活动节点可用于本地轴');
    const axisIndex = request.axis === 'x' ? 0 : request.axis === 'y' ? 1 : 2;
    axis = normalize3(columnVector(world.get(activeRoot)!, axisIndex));
  }

  let worldOperation: Mat4;
  if (request.mode === 'translate') {
    worldOperation = translationMatrix([
      axis[0] * request.distance,
      axis[1] * request.distance,
      axis[2] * request.distance,
    ]);
  } else {
    worldOperation = pivotTransform(pivot, rotationMatrix(axis, (request.degrees * Math.PI) / 180));
  }

  const results: Array<{ id: string; local: Mat4 }> = [];
  for (const id of roots) {
    const node = state.nodes.get(id)!;
    const parentWorld = node.parent === null ? identity() : world.get(node.parent)!;
    const newWorld = multiply(worldOperation, world.get(id)!);
    const local = multiply(invertAffine(parentWorld, `节点 ${id} 的父节点世界矩阵奇异，无法写回局部变换`), newWorld);
    assertResultMatrix(local, id);
    results.push({ id, local });
  }
  // Commit only after every root validated.
  for (const { id, local } of results) state.nodes.get(id)!.matrix = local;
  return { state, moved: roots, pivot, axis };
}

/**
 * Writes a local matrix to one node (used by numeric editing). Singular
 * matrices are allowed in the document; only finite affine ones are accepted.
 */
export function setLocalMatrix(base: SceneState, id: string, matrix: Mat4): SceneState {
  if (!base.nodes.has(id)) throw new SceneError('not-found', `节点不存在：${id}`);
  assertAffineMatrix(matrix, `节点 ${id} 的矩阵`);
  const state = cloneState(base);
  state.nodes.get(id)!.matrix = cloneMatrix(matrix);
  return state;
}

/** Convenience for numeric matrix editing: parse text cells strictly. */
/** Human-readable world origin helper used by the UI and tests. */
export function worldPosition(state: SceneState, id: string): Vec3 {
  return originOf(worldMatrixOf(state, id));
}

/** Translation helper shared by UI world gizmo previews. */