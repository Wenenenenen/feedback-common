// 输入校验与网格拓扑。错误必须指出文件内具体对象与索引。

const MAX_VERTS = 2000;
const MAX_TRIS = 4000;
const COORD_LIMIT = 10000;
const DEGEN_EPS = 1e-12;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 返回 { errors: string[], data: 规范化数据或 null }
export function validateMesh(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['根对象：必须是 JSON 对象，包含 rest、triangles、constraints 字段'], data: null };
  }

  // ---- rest ----
  const rest = input.rest;
  if (!Array.isArray(rest)) {
    errors.push('rest：必须是顶点坐标数组');
  } else if (rest.length < 1) {
    errors.push('rest：至少需要 1 个顶点');
  } else if (rest.length > MAX_VERTS) {
    errors.push(`rest：顶点数 ${rest.length} 超过上限 ${MAX_VERTS}`);
  }
  const n = Array.isArray(rest) ? rest.length : 0;
  const points = [];
  if (Array.isArray(rest)) {
    for (let i = 0; i < rest.length && i <= MAX_VERTS; i++) {
      const v = rest[i];
      if (!Array.isArray(v) || v.length !== 3 || !v.every(finiteNum)) {
        errors.push(`rest[${i}]：必须是 3 个有限数组成的坐标 [x,y,z]`);
        points.push([0, 0, 0]);
        continue;
      }
      if (v.some((c) => Math.abs(c) > COORD_LIMIT)) {
        errors.push(`rest[${i}]：坐标绝对值超过 ${COORD_LIMIT}（值为 [${v.join(', ')}]）`);
      }
      points.push([v[0], v[1], v[2]]);
    }
  }

  // ---- triangles ----
  const trisIn = input.triangles;
  const triangles = [];
  if (!Array.isArray(trisIn)) {
    errors.push('triangles：必须是三角索引数组');
  } else if (trisIn.length > MAX_TRIS) {
    errors.push(`triangles：三角形数 ${trisIn.length} 超过上限 ${MAX_TRIS}`);
  }
  if (Array.isArray(trisIn)) {
    const faceKeys = new Set();
    for (let f = 0; f < trisIn.length && f <= MAX_TRIS; f++) {
      const t = trisIn[f];
      if (!Array.isArray(t) || t.length !== 3) {
        errors.push(`triangles[${f}]：必须是 3 个整数索引`);
        continue;
      }
      const badIdx = t.some((idx) => !isInt(idx) || idx < 0 || idx >= n);
      if (badIdx) {
        errors.push(
          `triangles[${f}]：索引 [${t.join(', ')}] 存在非整数或越界（合法范围 0..${n - 1}）`
        );
        continue;
      }
      const [a, b, c] = t;
      if (a === b || b === c || a === c) {
        errors.push(`triangles[${f}]：面内索引重复 [${a}, ${b}, ${c}]（退化面）`);
        continue;
      }
      const key = (() => {
        const s = [a, b, c].sort((x, y) => x - y);
        return `${s[0]}|${s[1]}|${s[2]}`;
      })();
      if (faceKeys.has(key)) {
        errors.push(`triangles[${f}]：与更早的面重复（无向面 [${key.replaceAll('|', ', ')}]）`);
        continue;
      }
      faceKeys.add(key);
      // 叉积模长退化检查（rest 坐标无效时跳过，已单独报错）
      if (points.length === n) {
        const ab = [
          points[b][0] - points[a][0],
          points[b][1] - points[a][1],
          points[b][2] - points[a][2],
        ];
        const ac = [
          points[c][0] - points[a][0],
          points[c][1] - points[a][1],
          points[c][2] - points[a][2],
        ];
        const cx =
          ab[1] * ac[2] - ab[2] * ac[1];
        const cy = ab[2] * ac[0] - ab[0] * ac[2];
        const cz = ab[0] * ac[1] - ab[1] * ac[0];
        const area2 = Math.hypot(cx, cy, cz);
        if (area2 <= DEGEN_EPS) {
          errors.push(
            `triangles[${f}]：退化三角形 [${a}, ${b}, ${c}]，叉积模长 ${area2.toExponential(3)} 不大于 ${DEGEN_EPS}`
          );
          continue;
        }
      }
      triangles.push([a, b, c]);
    }
  }

  // ---- constraints ----
  const consIn = input.constraints;
  const constraints = [];
  if (consIn === undefined) {
    // 允许缺省，视为无约束
  } else if (!Array.isArray(consIn)) {
    errors.push('constraints：必须是约束数组');
  } else {
    const seen = new Set();
    for (let k = 0; k < consIn.length; k++) {
      const c = consIn[k];
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`constraints[${k}]：必须是含 vertex 与 target 的对象`);
        continue;
      }
      if (!isInt(c.vertex) || c.vertex < 0 || c.vertex >= n) {
        errors.push(
          `constraints[${k}].vertex：值 ${JSON.stringify(c.vertex)} 不是合法顶点索引（范围 0..${n - 1}）`
        );
        continue;
      }
      if (seen.has(c.vertex)) {
        errors.push(`constraints[${k}]：顶点 ${c.vertex} 的约束重复（该顶点已有约束）`);
        continue;
      }
      const t = c.target;
      if (!Array.isArray(t) || t.length !== 3 || !t.every(finiteNum)) {
        errors.push(`constraints[${k}]（顶点 ${c.vertex}）.target：必须是 3 个有限数`);
        continue;
      }
      if (t.some((v) => Math.abs(v) > COORD_LIMIT)) {
        errors.push(
          `constraints[${k}]（顶点 ${c.vertex}）.target：坐标绝对值超过 ${COORD_LIMIT}（值为 [${t.join(', ')}]）`
        );
        continue;
      }
      seen.add(c.vertex);
      constraints.push({ vertex: c.vertex, target: [t[0], t[1], t[2]] });
    }
  }

  if (errors.length > 0) return { errors, data: null };

  const topo = buildTopology(points, triangles);
  return { errors: [], data: { rest: points, triangles, constraints, ...topo } };
}

// 由三角形提取无向边（去重，单位边权），计算邻接表与连通分量。
export function buildTopology(rest, triangles) {
  const n = rest.length;
  const edgeSet = new Set();
  const neighbors = Array.from({ length: n }, () => []);
  const addEdge = (a, b) => {
    if (a === b) return;
    const key = a < b ? a * n + b : b * n + a;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      neighbors[a].push(b);
      neighbors[b].push(a);
    }
  };
  for (const [a, b, c] of triangles) {
    addEdge(a, b);
    addEdge(b, c);
    addEdge(a, c);
  }

  // 连通分量（孤立顶点自成一个分量）
  const compOf = new Int32Array(n).fill(-1);
  const components = [];
  for (let s = 0; s < n; s++) {
    if (compOf[s] !== -1) continue;
    const id = components.length;
    const verts = [];
    const stack = [s];
    compOf[s] = id;
    while (stack.length) {
      const i = stack.pop();
      verts.push(i);
      for (const j of neighbors[i]) {
        if (compOf[j] === -1) {
          compOf[j] = id;
          stack.push(j);
        }
      }
    }
    components.push(verts);
  }

  const degree = neighbors.map((nb) => nb.length);
  return { neighbors, degree, compOf, components, edgeCount: edgeSet.size };
}
