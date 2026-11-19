// 组件树核心实现：最大树 / 最小树，四邻接 / 八邻接，可选二值掩膜。
// 自研 Salembier 式分层并查集漫洪算法：
//   按灰度极端方向逐层激活像素，层内先并同灰度平台，再并入已激活的异灰度分量；
//   每个 DSU 分量携带其当前树节点，被吸收的旧节点成为新节点的孩子。
// 每条像素邻边在整个构建中只扫描一次（非逐灰度全图重建），
// 不依赖任何现成组件树 / 面积开闭库。
//
// 不变量：
//  - 节点合并“同灰度且上层归属相同”的平台像素（平台像素本身可以不几何连通）；
//  - 节点面积 = 平台自身像素 + 全部后代像素；
//  - 最大树父节点灰度严格更小，最小树父节点灰度严格更大；
//  - 掩膜外像素不建树，pixelNode 记 -1，过滤时照抄原灰度。

const DIRS4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const DIRS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @param {Uint8Array|Uint8ClampedArray} gray 行优先 8 位灰度
 * @param {number} width
 * @param {number} height
 * @param {{tree?: 'max'|'min', connectivity?: 4|8, mask?: Uint8Array|null}} options
 */
export function buildComponentTree(gray, width, height, options = {}) {
  const treeKind = options.tree === 'min' ? 'min' : 'max';
  const connectivity = options.connectivity === 8 ? 8 : 4;
  const mask = options.mask ?? null;
  const dirs = connectivity === 8 ? DIRS8 : DIRS4;
  const N = width * height;

  const valid = new Uint8Array(N);
  for (let i = 0; i < N; i++) valid[i] = mask ? (mask[i] ? 1 : 0) : 1;

  // ---- 1. 灰度分桶（8 位 => 256 桶），统计有效像素 ----
  const buckets = Array.from({ length: 256 }, () => []);
  let nValid = 0;
  for (let p = 0; p < N; p++) {
    if (valid[p]) {
      buckets[gray[p]].push(p);
      nValid++;
    }
  }

  // 最大树：从高灰度向低灰度漫洪（根在最低灰度）；
  // 最小树：从低灰度向高灰度漫洪（根在最高灰度）。
  const levels = new Int32Array(256);
  for (let i = 0; i < 256; i++) levels[i] = i;
  if (treeKind === 'max') levels.reverse();

  const dsu = new Int32Array(N).fill(-1);      // 并查集父
  const carried = new Int32Array(N).fill(-1);  // DSU 根 -> 当前树节点 id
  const pixelNode = new Int32Array(N).fill(-1);
  const nodes = [];
  const treeParentNode = []; // 节点 id -> 父节点 id（构建期用，结束后写入 nodes）

  const find = (x) => {
    let r = x;
    while (dsu[r] !== r) r = dsu[r];
    while (dsu[x] !== x) { const nx = dsu[x]; dsu[x] = r; x = nx; } // 路径压缩
    return r;
  };

  // 旧节点去重：节点数不超过像素数 N，按层号保证每层每个节点至多登记一次。
  const absorbedNode = new Int32Array(N);
  const absorbedRoot = new Int32Array(N);
  const absorbedAt = new Uint32Array(N);
  let layerStamp = 0;

  for (let li = 0; li < 256; li++) {
    const L = levels[li];
    const bucket = buckets[L];
    if (bucket.length === 0) continue;
    layerStamp++;

    // ---- 2a. 激活本层像素 ----
    for (const p of bucket) dsu[p] = p;

    // ---- 2b. 合并：层内同灰度相邻 + 与已激活异灰度分量合并，记录被吸收旧节点 ----
    // 约定合并后 ra（含本层像素 p 的根）作为新根，保证最终 DSU 根始终落在本层像素上。
    // 同一旧节点在本层可能随 DSU 多次移动，按层号去重，只登记首次被吸收的位置。
    let nAbsorbed = 0;
    for (const p of bucket) {
      const px = p % width;
      const py = (p / width) | 0;
      for (let d = 0; d < dirs.length; d++) {
        const nx = px + dirs[d][0];
        const ny = py + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (dsu[q] === -1) continue; // 掩膜外或尚未激活
        const ra = find(p);
        const rb = find(q);
        if (ra === rb) continue;
        const cv = carried[rb];
        if (cv !== -1 && absorbedAt[cv] !== layerStamp) {
          absorbedAt[cv] = layerStamp;
          absorbedNode[nAbsorbed] = cv;
          absorbedRoot[nAbsorbed] = rb;
          nAbsorbed++;
        }
        dsu[rb] = ra; // ra 必含本层像素（find(p)），作为新根
      }
    }

    // ---- 2c. 合并全部结束后，每个含本层像素的最终 DSU 根生成一个节点 ----
    // 先统一做 find（可能再触发路径压缩），用最终根聚合，避免过渡根建出重复节点。
    const finalRootOfPixel = new Int32Array(bucket.length);
    const nodeOfRoot = new Map();
    for (let i = 0; i < bucket.length; i++) {
      finalRootOfPixel[i] = find(bucket[i]);
    }
    for (let i = 0; i < bucket.length; i++) {
      const p = bucket[i];
      const r = finalRootOfPixel[i];
      let id = nodeOfRoot.get(r);
      if (id === undefined) {
        id = nodes.length;
        nodeOfRoot.set(r, id);
        nodes.push({
          id,
          parent: null,
          level: L,
          area: 0,
          plateauArea: 0,
          representative: [p % width, (p / width) | 0],
          repIndex: p,
        });
        treeParentNode.push(-1);
      }
      const nd = nodes[id];
      nd.plateauArea++;
      nd.area++;
      pixelNode[p] = id;
      if (p < nd.repIndex) {
        nd.repIndex = p;
        nd.representative = [p % width, (p / width) | 0];
      }
    }

    // 新节点接管其 DSU 根上携带的分量
    for (const [r, id] of nodeOfRoot) carried[r] = id;

    // ---- 2d. 被吸收旧节点挂到对应新节点下（按合并后的最终 DSU 根分组）----
    for (let i = 0; i < nAbsorbed; i++) {
      const v = absorbedNode[i];
      const finalRoot = find(absorbedRoot[i]);
      const pid = nodeOfRoot.get(finalRoot);
      treeParentNode[v] = pid;
    }
  }

  // ---- 3. 节点父子关系、根、面积自底向上累加（DFS 后序，不依赖节点 id 顺序）----
  const children = Array.from({ length: nodes.length }, () => []);
  const roots = [];
  for (let id = 0; id < nodes.length; id++) {
    const pid = treeParentNode[id];
    if (pid === -1) {
      roots.push(id);
    } else {
      nodes[id].parent = pid;
      children[pid].push(id);
    }
  }
  const postorder = [];
  {
    const stack = [];
    for (const r of roots) stack.push({ id: r, phase: 0 });
    while (stack.length) {
      const frame = stack.pop();
      if (frame.phase === 0) {
        stack.push({ id: frame.id, phase: 1 });
        const kids = children[frame.id];
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ id: kids[i], phase: 0 });
        }
      } else {
        postorder.push(frame.id);
      }
    }
  }
  for (const id of postorder) {
    nodes[id].area = nodes[id].plateauArea;
    for (const cid of children[id]) nodes[id].area += nodes[cid].area;
  }

  // ---- 4. DFS 前序编号 tin/tout：子树归属查询 O(1) ----
  const tin = new Int32Array(nodes.length);
  const tout = new Int32Array(nodes.length);
  const preorder = [];
  {
    let timer = 0;
    const stack = [];
    for (const r of roots) stack.push({ id: r, phase: 0 });
    while (stack.length) {
      const frame = stack.pop();
      const nd = frame.id;
      if (frame.phase === 0) {
        tin[nd] = timer++;
        preorder.push(nd);
        stack.push({ id: nd, phase: 1 });
        const kids = children[nd];
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ id: kids[i], phase: 0 });
        }
      } else {
        tout[nd] = timer - 1;
      }
    }
  }

  return {
    tree: treeKind,
    connectivity,
    width,
    height,
    gray,
    valid,
    pixelNode,
    nodes,
    children,
    roots,
    tin,
    tout,
    preorder,
    nodeCount: nodes.length,
    validPixelCount: nValid,
  };
}

/** 节点 v 是否为节点 u 的后代（含自身），基于 tin/tout */
export function isDescendant(tree, u, v) {
  return tree.tin[u] <= tree.tin[v] && tree.tout[v] <= tree.tout[u];
}

/** 像素所属节点到根的路径（节点 id 数组，自身在前、根在最后） */
export function pathToRoot(tree, nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur !== null && cur !== undefined) {
    path.push(cur);
    cur = tree.nodes[cur].parent;
  }
  return path;
}

/** 像素坐标 -> 节点 id；掩膜外返回 -1 */
export function nodeAtPixel(tree, x, y) {
  return tree.pixelNode[y * tree.width + x];
}

/**
 * 面积过滤：area >= threshold 的节点保留，根无条件保留；
 * 被过滤节点降到最近保留祖先的原图灰度。掩膜外照抄原图。
 * 返回新的 Uint8ClampedArray。
 */
export function applyAreaFilter(tree, threshold, out = null) {
  const { width, height, gray, valid, pixelNode, nodes, preorder } = tree;
  const N = width * height;
  const result = out ?? new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) result[i] = valid[i] ? 0 : gray[i];

  const filteredLevel = new Int32Array(nodes.length);
  for (const id of preorder) {
    const nd = nodes[id];
    if (nd.parent === null || nd.area >= threshold) {
      filteredLevel[id] = nd.level; // 根无条件保留
    } else {
      filteredLevel[id] = filteredLevel[nd.parent]; // 降到最近保留祖先
    }
  }
  for (let p = 0; p < N; p++) {
    if (valid[p]) result[p] = filteredLevel[pixelNode[p]];
  }
  return result;
}

/** 构建约定 schema 的导出对象 */
export function buildExportJSON(tree, threshold) {
  return {
    width: tree.width,
    height: tree.height,
    tree: tree.tree,
    connectivity: tree.connectivity,
    area_threshold: threshold,
    masked: tree.validPixelCount < tree.width * tree.height,
    nodes: tree.nodes.map((nd) => ({
      id: nd.id,
      parent: nd.parent,
      level: nd.level,
      area: nd.area,
      plateau_area: nd.plateauArea,
      representative: nd.representative,
    })),
    pixel_nodes: Array.from(tree.pixelNode), // 掩膜外为 -1
  };
}
