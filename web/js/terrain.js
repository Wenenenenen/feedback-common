// 分级地形核心算法：四叉树 LOD + 真共享顶点接缝三角化
// 纯 ES Module，浏览器与 Node 测试共用。所有坐标规则按 samples/extracted/说明.txt。

/** 校验输入高度场与相机参数，返回错误字符串；合法返回 null */
export function validateTerrain(input) {
  if (!input || typeof input !== 'object') return '输入不是 JSON 对象';
  const { size, heights, camera, pixelError } = input;
  if (!Number.isInteger(size) || size < 8 || size > 128) {
    return `size 必须是 8~128 的 2 的幂，收到 ${size}`;
  }
  if ((size & (size - 1)) !== 0) return `size 必须是 2 的幂，收到 ${size}`;
  if (!Array.isArray(heights)) return 'heights 必须是数组';
  const need = (size + 1) * (size + 1);
  if (heights.length !== need) {
    return `heights 长度应为 (N+1)^2 = ${need}，实际 ${heights.length}`;
  }
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (typeof h !== 'number' || !Number.isFinite(h)) {
      return `heights[${i}] 不是有限数值`;
    }
  }
  if (!camera || typeof camera !== 'object') return '缺少 camera 参数';
  const { position, fovY, viewportHeight, near } = camera;
  if (!Array.isArray(position) || position.length !== 3 ||
      position.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return 'camera.position 必须是 3 个有限数';
  }
  if (typeof fovY !== 'number' || !(fovY > 0) || fovY >= 180) return 'fovY 必须在 (0,180) 度之间';
  if (typeof viewportHeight !== 'number' || viewportHeight <= 0) return 'viewportHeight 必须为正';
  if (typeof near !== 'number' || !(near > 0)) return 'near 必须为正';
  if (typeof pixelError !== 'number' || !(pixelError > 0)) return 'pixelError 必须为正';
  return null;
}

const keyOf = (x, z, s) => `${x},${z},${s}`;

/**
 * 预计算全部四叉树节点的块误差 E（四角双线性插值最大偏差）与 AABB 高度范围。
 * 返回 Map: key -> { x, z, s, E, hmin, hmax }
 */
export function precomputeNodes(size, heights) {
  const W = size + 1;
  const H = (x, z) => heights[z * W + x];
  const nodes = new Map();

  const build = (x, z, s) => {
    const h00 = H(x, z);
    const h10 = H(x + s, z);
    const h01 = H(x, z + s);
    const h11 = H(x + s, z + s);
    let E = 0;
    let hmin = Infinity;
    let hmax = -Infinity;
    // 块内所有原始格点（含边界与四角）
    for (let iz = 0; iz <= s; iz++) {
      const v = iz / s;
      for (let ix = 0; ix <= s; ix++) {
        const u = ix / s;
        const h = H(x + ix, z + iz);
        if (h < hmin) hmin = h;
        if (h > hmax) hmax = h;
        // 四角双线性插值
        const bilinear =
          h00 * (1 - u) * (1 - v) +
          h10 * u * (1 - v) +
          h01 * (1 - u) * v +
          h11 * u * v;
        const d = Math.abs(h - bilinear);
        if (d > E) E = d;
      }
    }
    nodes.set(keyOf(x, z, s), { x, z, s, E, hmin, hmax });
    if (s > 2) {
      const h = s >> 1;
      build(x, z, h);
      build(x + h, z, h);
      build(x, z + h, h);
      build(x + h, z + h, h);
    }
  };
  build(0, 0, size);
  return nodes;
}

/** 相机到节点 AABB 最近点的欧氏距离 */
export function distanceToAABB(node, cameraPos) {
  const [cx, cy, cz] = cameraPos;
  const qx = Math.max(node.x, Math.min(cx, node.x + node.s));
  const qy = Math.max(node.hmin, Math.min(cy, node.hmax));
  const qz = Math.max(node.z, Math.min(cz, node.z + node.s));
  return Math.hypot(cx - qx, cy - qy, cz - qz);
}

/** f = viewportHeight / (2*tan(fovY/2))，角度单位度 */
export function focalLength(camera) {
  return camera.viewportHeight / (2 * Math.tan((camera.fovY * Math.PI) / 360));
}

/** 屏幕（像素）误差 rho = E*f/max(D,near) */
export function screenError(node, camera) {
  const D = distanceToAABB(node, camera.position);
  const f = focalLength(camera);
  return (node.E * f) / Math.max(D, camera.near);
}

/**
 * 平衡约束：共享正长度边的相邻块尺寸比超过 2 时，拆粗的那一块，固定点迭代到稳定。
 * 直接修改 leaves，并把 balance 类型写入 splitReasons。可独立用于单元测试。
 */
export function enforceBalance(nodes, size, camera, leaves, splitReasons) {
  const f = focalLength(camera);
  const metric = (node) => {
    const D = distanceToAABB(node, camera.position);
    return { D, rho: (node.E * f) / Math.max(D, camera.near) };
  };
  let changed = true;
  let guard = 0;
  const maxRounds = Math.log2(size) + 2;
  while (changed && guard <= maxRounds) {
    changed = false;
    guard++;
    // 每轮基于当前叶子重建空间索引（O(N²)，N≤128），邻居点查降为 O(1)
    const cell = buildCellIndex(leaves, size);
    for (const leaf of Array.from(leaves.values())) {
      const { x, z, s } = leaf;
      if (s <= 2) continue;
      let badNeighbor = null;
      for (let side = 0; side < 4; side++) {
        const n = findFinerNeighborAlongEdge(leaves, x, z, s, size, side, cell);
        if (n) { badNeighbor = n; break; }
      }
      if (badNeighbor) {
        leaves.delete(keyOf(x, z, s));
        splitReasons.set(keyOf(x, z, s), {
          type: 'balance',
          neighbor: { x: badNeighbor.x, z: badNeighbor.z, s: badNeighbor.s },
        });
        const h = s >> 1;
        for (const [cx, cz] of [[x, z], [x + h, z], [x, z + h], [x + h, z + h]]) {
          const cn = nodes.get(keyOf(cx, cz, h));
          const m = metric(cn);
          leaves.set(keyOf(cx, cz, h), {
            x: cx, z: cz, s: h, E: cn.E, hmin: cn.hmin, hmax: cn.hmax,
            D: m.D, rho: m.rho,
          });
        }
        changed = true;
      }
    }
  }
}

/**
 * 按像素误差选择四叉树叶块，再强制约束：共享正长度边的相邻块尺寸比 <= 1（层级差 <= 1）。
 * 返回 { leaves: Map(key->leafMeta), splitReasons: Map(key->reason) }
 * leafMeta: { x,z,s,E,D,rho, hmin,hmax, source }
 */
export function buildQuadtree(nodes, size, camera, pixelError) {
  const f = focalLength(camera);
  const leaves = new Map();
  const splitReasons = new Map();

  const metric = (node) => {
    const D = distanceToAABB(node, camera.position);
    const rho = (node.E * f) / Math.max(D, camera.near);
    return { D, rho };
  };

  // 1) 误差驱动拆分
  const refine = (x, z, s) => {
    const node = nodes.get(keyOf(x, z, s));
    const { D, rho } = metric(node);
    if (s > 2 && rho > pixelError) {
      splitReasons.set(keyOf(x, z, s), {
        type: 'error',
        rho,
        pixelError,
        E: node.E,
        D,
      });
      const h = s >> 1;
      refine(x, z, h);
      refine(x + h, z, h);
      refine(x, z + h, h);
      refine(x + h, z + h, h);
    } else {
      leaves.set(keyOf(x, z, s), {
        x, z, s, E: node.E, hmin: node.hmin, hmax: node.hmax, D, rho,
      });
    }
  };
  refine(0, 0, size);

  // 2) 邻块约束：尺寸比超过 2 就拆粗的那一块，迭代直到稳定
  enforceBalance(nodes, size, camera, leaves, splitReasons);

  // 3) 标注每个叶子的拆分来源
  for (const [k, leaf] of leaves) {
    const r = splitReasons.get(k);
    leaf.source = r ? r.type : (leaf.s === size ? 'root' : 'kept');
  }
  return { leaves, splitReasons };
}

/**
 * 空间索引：N×N 单元网格，每格记录覆盖它的叶块。
 * 构建 O(N²+L)，内部点查询 O(1)；整数边界点回退线性扫描以保证角点语义正确。
 */
function buildCellIndex(leaves, size) {
  const cell = new Array(size * size).fill(null);
  for (const leaf of leaves.values()) {
    for (let iz = leaf.z; iz < leaf.z + leaf.s; iz++) {
      const base = iz * size;
      for (let ix = leaf.x; ix < leaf.x + leaf.s; ix++) cell[base + ix] = leaf;
    }
  }
  return cell;
}

/** 点 (px,pz) 落在哪个叶子内（越界返回 null）。有索引走 O(1)，否则线性扫描。 */
function findLeafAt(leaves, px, pz, size, cell) {
  if (px < 0 || pz < 0 || px > size || pz > size) return null;
  if (cell) {
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    // 严格内部点（非整数边界）唯一属于一个单元
    if (Number.isInteger(px) === false && Number.isInteger(pz) === false &&
        ix >= 0 && iz >= 0 && ix < size && iz < size) {
      return cell[iz * size + ix];
    }
  }
  for (const leaf of leaves.values()) {
    if (px >= leaf.x && px <= leaf.x + leaf.s &&
        pz >= leaf.z && pz <= leaf.z + leaf.s) {
      return leaf;
    }
  }
  return null;
}

/**
 * 沿块 (x,z,s) 某条边扫描全部相邻叶子，若存在尺寸 < s/2 的邻居则返回它。
 * 共享正长度边的邻居起点都落在该边的 s/2 步进格点上。
 */
function findFinerNeighborAlongEdge(leaves, x, z, s, size, side, cell) {
  const half = s >> 1;
  const q = half / 2;
  const eps = 1e-6;
  for (let t = 0; t < s; t += half) {
    // 半边中点沿边方向，再向邻居侧（垂直于边）推进 eps，避开角点对角块的闭 AABB
    let px, pz;
    if (side === 0) { px = x - eps; pz = z + t + q; }
    else if (side === 1) { px = x + s + eps; pz = z + t + q; }
    else if (side === 2) { px = x + t + q; pz = z - eps; }
    else { px = x + t + q; pz = z + s + eps; }
    const n = findLeafAt(leaves, px, pz, size, cell);
    if (n && n.s < half) return n;
  }
  return null;
}

/**
 * 沿块 (x,z,s) 某条边返回全部共享正长度边的相邻叶子（按半边归属，去重）。
 * 平衡约束保证邻居尺寸只可能是 s（同级，1 个）或 s/2（更细，2 个）；域外返回空数组。
 * 探测点取半边中点并向邻居侧推进微小量，角点处对角相接的块不会被误判。
 */
function neighborsAlongSide(leaves, x, z, s, size, side, cell) {
  const half = s >> 1;
  const q = half / 2;
  const eps = 1e-6;
  const found = [];
  const seen = new Set();
  for (let t = 0; t < s; t += half) {
    let px, pz;
    if (side === 0) { px = x - eps; pz = z + t + q; }
    else if (side === 1) { px = x + s + eps; pz = z + t + q; }
    else if (side === 2) { px = x + t + q; pz = z - eps; }
    else { px = x + t + q; pz = z + s + eps; }
    if (px < 0 || pz < 0 || px > size || pz > size) continue;
    const n = findLeafAt(leaves, px, pz, size, cell);
    if (n) {
      const k = n.x + ',' + n.z + ',' + n.s;
      if (!seen.has(k)) { seen.add(k); found.push(n); }
    }
  }
  return found;
}

/**
 * 邻接信息：每个叶子四条边的邻居。
 * side: 0=左(-x) 1=右(+x) 2=上(-z) 3=下(+z)
 * 邻居更细时返回两个 s/2 块；同级返回一个；域外返回 null。
 */
export function buildAdjacency(leaves, size) {
  const list = Array.from(leaves.values()).sort((a, b) => b.s - a.s || a.z - b.z || a.x - b.x);
  const cell = buildCellIndex(leaves, size);
  const adj = [];
  for (const leaf of list) {
    const { x, z, s } = leaf;
    const neighbors = {};
    for (let side = 0; side < 4; side++) {
      const ns = neighborsAlongSide(leaves, x, z, s, size, side, cell);
      // 按边方向排序，保证更细的两个邻居顺序稳定（沿边起点->终点）
      ns.sort((a, b) => (side < 2 ? a.z - b.z : a.x - b.x));
      neighbors[side] = ns.length ? ns.map((n) => ({ x: n.x, z: n.z, s: n.s })) : null;
    }
    adj.push({ x, z, s, neighbors });
  }
  return adj;
}

/**
 * 生成接缝三角网格：每块以真实高度中心点为扇心，边界逆时针顶点扇形三角化；
 * 邻块更细的边加入真实高度中点，其余边不加中点；同坐标点全局焊接。
 * 返回 { positions:Float32Array, indices:Uint32Array, triBlocks:Uint32Array(每三角形对应叶子序号),
 *         leafList, vertexCount, triangleCount, edgeKeys:Set(内部边), boundaryEdgeKeys:Set }
 */
export function buildMesh(terrain, leaves) {
  const { size, heights } = terrain;
  const W = size + 1;
  const H = (x, z) => heights[z * W + x];
  const leafList = Array.from(leaves.values()).sort((a, b) => a.z - b.z || a.x - b.x || b.s - a.s);
  const cell = buildCellIndex(leaves, size);

  // 全局焊接：键为整数格点 (ix, iz)，中点本身也是整数格点
  const vertCache = new Map();
  const positions = [];
  const vid = (ix, iz) => {
    const k = ix + ',' + iz;
    let id = vertCache.get(k);
    if (id === undefined) {
      id = positions.length / 3;
      vertCache.set(k, id);
      positions.push(ix, H(ix, iz), iz);
    }
    return id;
  };

  const indices = [];
  const triBlocks = [];
  const internalEdges = new Set();
  const boundaryEdges = new Set();
  const ekey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  leafList.forEach((leaf, blockIdx) => {
    const { x, z, s } = leaf;
    const h = s >> 1;
    // 邻居更细（尺寸 = s/2）的边需要在边中点插入真实高度顶点。
    // 沿整条边扫描：只要该边任一段贴着 s/2 的细块，就加中点。
    const finer = [false, false, false, false]; // 左 右 上 下
    for (let side = 0; side < 4; side++) {
      finer[side] = neighborsAlongSide(leaves, x, z, s, size, side, cell)
        .some((n) => n.s === h);
    }

    // 边界顶点（从左下角起：下->右->上->左），配合 (center,a,b) 扇形绕序法线朝 +Y
    const ring = [];
    ring.push(vid(x, z + s));                   // 左下
    if (finer[3]) ring.push(vid(x + h, z + s));   // 下边中点
    ring.push(vid(x + s, z + s));               // 右下
    if (finer[1]) ring.push(vid(x + s, z + h));   // 右边中点
    ring.push(vid(x + s, z));                   // 右上
    if (finer[2]) ring.push(vid(x + h, z));       // 上边中点
    ring.push(vid(x, z));                       // 左上
    if (finer[0]) ring.push(vid(x, z + h));       // 左边中点

    const center = vid(x + h, z + h);         // 真实高度中心点（全局焊接）

    // 边记账：用于悬挂边校验与接缝标记
    const sideEnds = [
      [vid(x, z + s), vid(x + s, z + s), finer[3] ? vid(x + h, z + s) : null], // 下
      [vid(x + s, z + s), vid(x + s, z), finer[1] ? vid(x + s, z + h) : null], // 右
      [vid(x + s, z), vid(x, z), finer[2] ? vid(x + h, z) : null],             // 上
      [vid(x, z), vid(x, z + s), finer[0] ? vid(x, z + h) : null],             // 左
    ];
    for (const [a, b, mid] of sideEnds) {
      const seg = mid ? [[a, mid], [mid, b]] : [[a, b]];
      for (const [p, q] of seg) {
        const k = ekey(p, q);
        if (internalEdges.has(k) || boundaryEdges.has(k)) {
          boundaryEdges.delete(k);
          internalEdges.add(k);
        } else {
          boundaryEdges.add(k);
        }
      }
    }

    // 扇形三角化（ring 已为逆时针）
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      indices.push(center, a, b);
      triBlocks.push(blockIdx);
    }
  });

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triBlocks: new Uint32Array(triBlocks),
    leafList,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    internalEdges,
    boundaryEdges,
  };
}

/** 完整流水线：校验通过后返回求解结果，错误返回 { error }。可传入缓存的 nodes 复用预计算。 */
export function solveTerrain(input, cachedNodes = null) {
  const err = validateTerrain(input);
  if (err) return { error: err };
  const { size, heights, camera, pixelError } = input;
  const nodes = cachedNodes || precomputeNodes(size, heights);
  const { leaves, splitReasons } = buildQuadtree(nodes, size, camera, pixelError);
  const adjacency = buildAdjacency(leaves, size);
  const mesh = buildMesh({ size, heights }, leaves);
  return { size, heights, camera, pixelError, nodes, leaves, splitReasons, adjacency, mesh };
}
