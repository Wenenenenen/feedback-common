// 页面应用逻辑：文件导入、建树、过滤、画布渲染、节点探查、导出。
import { buildComponentTree, applyAreaFilter, buildExportJSON, pathToRoot } from './component-tree.mjs';
import { decodePNG, toGrayChannel, toMask, encodeGrayPNG } from './image-io.mjs';

const MAX_SIDE = 1024;

export const state = {
  fileName: '',
  width: 0,
  height: 0,
  gray: null,          // Uint8ClampedArray
  mask: null,          // Uint8Array | null
  treeKind: 'max',
  connectivity: 4,
  threshold: 10,
  tree: null,          // 当前组件树
  filtered: null,      // 当前过滤结果
  selectedPixel: null, // [x,y]
  selectedNode: null,  // 节点 id
  hoverNode: null,
  diffMode: false,     // 阈值对比：差异叠加
  compareThreshold: null,
  compareFiltered: null,
  building: false,
};

/** 读取并校验图像文件 */
export async function loadImageFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const decoded = await decodePNG(buf);
  if (decoded.width > MAX_SIDE || decoded.height > MAX_SIDE) {
    throw new Error(`图像单边不得超过 ${MAX_SIDE}px，当前为 ${decoded.width}×${decoded.height}`);
  }
  const gray = toGrayChannel(decoded);
  state.fileName = file.name;
  state.width = decoded.width;
  state.height = decoded.height;
  state.gray = gray;
  state.selectedPixel = null;
  state.selectedNode = null;
  rebuild();
}

/** 读取并校验掩膜文件 */
export async function loadMaskFile(file) {
  if (!state.gray) throw new Error('请先导入灰度图');
  const buf = new Uint8Array(await file.arrayBuffer());
  const decoded = await decodePNG(buf);
  if (decoded.width !== state.width || decoded.height !== state.height) {
    throw new Error(`掩膜尺寸 ${decoded.width}×${decoded.height} 与原图 ${state.width}×${state.height} 不一致`);
  }
  state.mask = toMask(decoded);
  state.selectedPixel = null;
  state.selectedNode = null;
  rebuild();
}

export function clearMask() {
  state.mask = null;
  state.selectedPixel = null;
  state.selectedNode = null;
  rebuild();
}

export function setTreeKind(kind) {
  state.treeKind = kind;
  rebuild();
}

export function setConnectivity(conn) {
  state.connectivity = conn;
  rebuild();
}

export function setThreshold(A) {
  state.threshold = Math.max(1, Math.min(state.width * state.height, Math.floor(A)));
  refreshFilter();
}

function rebuild() {
  if (!state.gray) return;
  state.building = true;
  state.tree = buildComponentTree(state.gray, state.width, state.height, {
    tree: state.treeKind,
    connectivity: state.connectivity,
    mask: state.mask,
  });
  state.selectedNode = null;
  state.compareThreshold = null;
  state.compareFiltered = null;
  state.building = false;
  refreshFilter();
  onTreeChange?.();
}

function refreshFilter() {
  if (!state.tree) return;
  state.filtered = applyAreaFilter(state.tree, state.threshold);
  if (state.compareThreshold !== null) {
    state.compareFiltered = applyAreaFilter(state.tree, state.compareThreshold);
  }
  onFilterChange?.();
}

export function snapshotCompare() {
  state.compareThreshold = state.threshold;
  state.compareFiltered = applyAreaFilter(state.tree, state.threshold);
  onFilterChange?.();
}

export function clearCompare() {
  state.compareThreshold = null;
  state.compareFiltered = null;
  onFilterChange?.();
}

export function selectPixel(x, y) {
  if (!state.tree) return;
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
  state.selectedPixel = [x, y];
  const nid = state.tree.pixelNode[y * state.width + x];
  state.selectedNode = nid >= 0 ? nid : null;
  onSelectionChange?.();
}

export function selectNode(id) {
  state.selectedNode = id;
  if (id !== null) {
    const rep = state.tree.nodes[id].representative;
    state.selectedPixel = rep;
  }
  onSelectionChange?.();
}

/** 节点完整连通区域（含全部后代）的像素索引 */
export function nodeRegionPixels(nodeId) {
  const t = state.tree;
  const out = [];
  const lo = t.tin[nodeId], hi = t.tout[nodeId];
  for (let p = 0; p < t.width * t.height; p++) {
    const nid = t.pixelNode[p];
    if (nid >= 0 && t.tin[nid] >= lo && t.tin[nid] <= hi) out.push(p);
  }
  return out;
}

export function pixelPathInfo(x, y) {
  const t = state.tree;
  const idx = y * t.width + x;
  const nid = t.pixelNode[idx];
  if (nid < 0) {
    return { masked: true, gray: t.gray[idx], path: [] };
  }
  return {
    masked: false,
    gray: t.gray[idx],
    nodeId: nid,
    path: pathToRoot(t, nid).map((id) => ({
      id,
      level: t.nodes[id].level,
      area: t.nodes[id].area,
      plateauArea: t.nodes[id].plateauArea,
      representative: t.nodes[id].representative,
      kept: t.nodes[id].parent === null || t.nodes[id].area >= state.threshold,
    })),
  };
}

export async function exportFilteredPNG() {
  const bytes = await encodeGrayPNG(state.filtered, state.width, state.height, 8);
  downloadBytes(bytes, exportBaseName() + `-filtered-A${state.threshold}.png`, 'image/png');
}

export function exportTreeJSON() {
  const payload = buildExportJSON(state.tree, state.threshold);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  downloadBytes(bytes, exportBaseName() + `-tree-${state.treeKind}-c${state.connectivity}-A${state.threshold}.json`, 'application/json');
}

function exportBaseName() {
  return state.fileName.replace(/\.png$/i, '') || 'image';
}

function downloadBytes(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// UI 层注入的回调
export let onTreeChange = () => {};
export let onFilterChange = () => {};
export let onSelectionChange = () => {};
export function bindUI(callbacks) {
  onTreeChange = callbacks.onTreeChange ?? onTreeChange;
  onFilterChange = callbacks.onFilterChange ?? onFilterChange;
  onSelectionChange = callbacks.onSelectionChange ?? onSelectionChange;
}
