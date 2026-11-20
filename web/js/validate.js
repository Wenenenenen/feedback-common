// 网格完整性校验：无悬挂边、无退化面、无重叠面、朝向统一、层级差 <= 1、全局焊接

const EPS = 1e-9;

function normalY(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return uz * vx - ux * vz; // u×v 的 Y 分量
}

export function validateMesh(result) {
  const { mesh, leaves, size } = result;
  const problems = [];
  const { positions, indices, triBlocks, leafList } = mesh;

  // 1) 退化面 + 统一朝上
  const triKeySet = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const area2 = Math.hypot(
      (by - ay) * (cz - az) - (bz - az) * (cy - ay),
      (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
    );
    if (area2 <= EPS) problems.push(`三角形 ${t / 3} 退化（面积≈0）`);
    const ny = normalY(ax, ay, az, bx, by, bz, cx, cy, cz);
    // 完全水平的平地三角形 ny≈0 视为朝上；仅当显著为负才算朝下
    if (ny < -EPS) problems.push(`三角形 ${t / 3} 法线未朝高度场上方 (ny=${ny.toExponential(2)})`);
    // 重叠面：同一组三个顶点（排序后）只允许出现一次
    const sig = [ia, ib, ic].sort((a, b) => a - b).join(',');
    if (triKeySet.has(sig)) problems.push(`三角形 ${t / 3} 与其他面重复（重叠面）`);
    triKeySet.add(sig);
  }

  // 2) 悬挂边：每条边必须出现 1 次（域外边界）或 2 次（内部共享边）
  const edgeCount = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const k = a < b ? a + '|' + b : b + '|' + a;
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  let hanging = 0;
  for (const [k, c] of edgeCount) {
    if (c !== 1 && c !== 2) {
      problems.push(`边 ${k} 被 ${c} 个三角形引用（悬挂/非流形）`);
      hanging++;
    }
  }
  // 出现 1 次的边必须位于高度场外边界 x/z ∈ {0,size}
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    const [a, b] = k.split('|').map(Number);
    for (const id of [a, b]) {
      const x = positions[id * 3], z = positions[id * 3 + 2];
      const onBorder = Math.abs(x) < EPS || Math.abs(z) < EPS ||
        Math.abs(x - size) < EPS || Math.abs(z - size) < EPS;
      if (!onBorder) {
        problems.push(`内部边 ${k} 只有一个面（悬挂边）`);
        hanging++;
        break;
      }
    }
  }

  // 3) 全局焊接检查：相同 (x,z) 格点必须共用一个顶点 id
  const gridIds = new Map();
  for (let id = 0; id < positions.length / 3; id++) {
    const x = positions[id * 3], z = positions[id * 3 + 2];
    const gk = x + ',' + z;
    if (gridIds.has(gk) && gridIds.get(gk) !== id) {
      problems.push(`格点 (${gk}) 未全局焊接`);
    }
    gridIds.set(gk, id);
  }

  // 4) 四叉树层级差 <= 1（共享正长度边）：半边中点向邻居侧推进 eps，角点对角块不算邻居
  let balanceViolation = 0;
  const list = Array.from(leaves.values());
  const leafAt = (px, pz) =>
    list.find((o) => px >= o.x && px <= o.x + o.s && pz >= o.z && pz <= o.z + o.s);
  for (const leaf of list) {
    const { x, z, s } = leaf;
    const half = s >> 1;
    const q = half / 2;
    const eps = 1e-6;
    for (let side = 0; side < 4; side++) {
      for (let t = 0; t < s; t += half) {
        let px, pz;
        if (side === 0) { px = x - eps; pz = z + t + q; }
        else if (side === 1) { px = x + s + eps; pz = z + t + q; }
        else if (side === 2) { px = x + t + q; pz = z - eps; }
        else { px = x + t + q; pz = z + s + eps; }
        if (px < 0 || pz < 0 || px > size || pz > size) continue;
        const n = leafAt(px, pz);
        if (n && n !== leaf && (n.s > s * 2 || s > n.s * 2)) {
          problems.push(`块 (${x},${z},${s}) 与邻居 (${n.x},${n.z},${n.s}) 尺寸比超过 2`);
          balanceViolation++;
        }
      }
    }
  }

  // 5) 覆盖性：叶子恰好铺满整个高度场且互不重叠
  const covered = new Set();
  for (const leaf of list) {
    for (let iz = leaf.z; iz < leaf.z + leaf.s; iz++) {
      for (let ix = leaf.x; ix < leaf.x + leaf.s; ix++) {
        const ck = ix + ',' + iz;
        if (covered.has(ck)) problems.push(`单元 (${ck}) 被多个叶块覆盖`);
        covered.add(ck);
      }
    }
  }
  if (covered.size !== size * size) {
    problems.push(`叶块覆盖 ${covered.size} 个单元，应为 ${size * size}`);
  }

  // 6) 最小块尺寸
  for (const leaf of list) {
    if (leaf.s < 2) problems.push(`存在小于 2×2 的叶块 s=${leaf.s}`);
  }

  // 7) 三角形归属完整
  if (triBlocks.length !== mesh.triangleCount) {
    problems.push('三角形块归属数组长度不符');
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: {
      vertices: mesh.vertexCount,
      triangles: mesh.triangleCount,
      leaves: leafList.length,
      edgeKinds: {
        internal: mesh.internalEdges.size,
        boundary: mesh.boundaryEdges.size,
        hanging,
        balanceViolation,
      },
    },
  };
}
