// 应用状态：图片、可编辑的对应点工作副本、参考图、阈值、最近一次管线结果。
import { decodePng } from '../png.js';

export const state = {
  images: [],          // { name, width, height, data, fileName }
  match: null,         // 工作副本 { images, reference, edges:[{a,b,pairs}] }
  threshold: 3,
  reference: 0,
  result: null,
  resultError: null,
  selected: null,      // { edgeIndex, pairIndex }
  previewMode: 'result',
};

export function resetProject() {
  state.images = [];
  state.match = null;
  state.result = null;
  state.resultError = null;
  state.selected = null;
  state.reference = 0;
}

// 读入 PNG（校验 2..4 张、单边 ≤1024、8 位 RGB/RGBA 由解码器保证）
export async function loadImage(file) {
  const buf = await file.arrayBuffer();
  const img = await decodePng(buf);
  if (state.images.length >= 4) throw new Error('最多支持 4 张图片');
  state.images.push({
    name: file.name,
    fileName: file.name,
    width: img.width,
    height: img.height,
    data: img.data,
  });
}

export function loadMatch(json) {
  if (!json || !Array.isArray(json.images) || !Array.isArray(json.edges)) {
    throw new Error('JSON 必须包含 images 与 edges 字段');
  }
  if (state.images.length && json.images.length !== state.images.length) {
    throw new Error(`JSON 记录 ${json.images.length} 张图，与已加载 ${state.images.length} 张不一致`);
  }
  // 深拷贝工作副本，编辑不影响原始数据
  state.match = JSON.parse(JSON.stringify({
    images: json.images,
    reference: json.reference ?? 0,
    edges: json.edges,
  }));
  state.reference = state.match.reference;
}

export function setReference(idx) {
  state.reference = idx;
  if (state.match) state.match.reference = idx;
}

export function setThreshold(t) {
  state.threshold = t;
}

// ---- 对应点增删改 ----
export function addPair(edgeIndex, a, b) {
  const edge = state.match.edges[edgeIndex];
  edge.pairs.push([[a[0], a[1]], [b[0], b[1]]]);
  state.selected = { edgeIndex, pairIndex: edge.pairs.length - 1 };
}

export function updatePair(edgeIndex, pairIndex, side, xy) {
  const pair = state.match.edges[edgeIndex].pairs[pairIndex];
  pair[side === 'a' ? 0 : 1] = [xy[0], xy[1]];
}

export function deletePair(edgeIndex, pairIndex) {
  state.match.edges[edgeIndex].pairs.splice(pairIndex, 1);
  // 保留所在边的选择，仅清空点级选中，避免界面丢失当前边上下文
  if (state.selected && state.selected.edgeIndex === edgeIndex &&
      state.selected.pairIndex === pairIndex) {
    state.selected.pairIndex = null;
  }
}

export function addEdge(a, b) {
  if (a === b) throw new Error('边的两端不能是同一张图');
  const exists = state.match.edges.some(
    (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)
  );
  if (exists) throw new Error('这两张图之间已存在对应边');
  state.match.edges.push({ a, b, pairs: [] });
  return state.match.edges.length - 1;
}

export function deleteEdge(edgeIndex) {
  state.match.edges.splice(edgeIndex, 1);
  state.selected = null;
}

export function currentEdges() {
  return state.match ? state.match.edges : [];
}
