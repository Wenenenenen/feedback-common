// 平行移动扫掠核心：标架、闭环补偿、环与三角网格。
// 预览与导出共用本模块的唯一输出，保证二者一致。
// 约定来源：样例包内 说明.md（右手坐标、凸截面逆时针、阈值常量）。

export const EPS_LEN = 1e-10;
export const EPS_SUM = 1e-8;
export const EPS_DOT = 1e-10;
export const EPS_AREA = 1e-12;

// ---------- vec3 ----------
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  // Rodrigues 旋转
  rotateAxis(v, axis, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return v3.add(
      v3.add(v3.scale(v, c), v3.scale(v3.cross(axis, v), s)),
      v3.scale(axis, v3.dot(axis, v) * (1 - c))
    );
  },
};

// 相邻切线间的最小旋转移动。返回新的 n（已投影到 tNext 垂面并归一化）。
function transport(nPrev, tPrev, tNext) {
  const d = v3.dot(tPrev, tNext);
  let x;
  if (d < -1 + EPS_DOT) {
    // 近反向：绕上一 n 旋转 pi
    x = v3.rotateAxis(nPrev, nPrev, Math.PI);
  } else if (d > 1 - EPS_DOT) {
    // 近同向：直接投影
    x = v3.sub(nPrev, v3.scale(tNext, v3.dot(nPrev, tNext)));
  } else {
    const axis = v3.normalize(v3.cross(tPrev, tNext));
    const ang = Math.acos(Math.max(-1, Math.min(1, d)));
    x = v3.rotateAxis(nPrev, axis, ang);
    x = v3.sub(x, v3.scale(tNext, v3.dot(x, tNext)));
  }
  return v3.normalize(x);
}

// 输入 data: {points, radii, profile, closed, twist, caps, compensate?}
// compensate 仅闭合时有意义；关闭仅用于诊断，不改变闭合拓扑。
export function buildSweep(data) {
  const points = data.points.map((p) => [p[0], p[1], p[2]]);
  const radii = data.radii.slice();
  const profile = data.profile.map((q) => [q[0], q[1]]);
  const closed = !!data.closed;
  const twist = Number(data.twist) || 0;
  const caps = !!data.caps;
  const compensate = data.compensate !== false; // 默认开

  const n = points.length;
  const m = profile.length;
  const diag = {
    errors: [],
    frameJumps: [],
    zeroSegments: [],
    degenerateFaces: [],
    selfIntersectingFaces: [],
    seamTwistDeg: null,
    warnings: [],
  };

  // ---------- 输入校验 ----------
  if (n < 2) diag.errors.push('路径至少需要 2 个点');
  if (!(m >= 3 && m <= 32)) diag.errors.push('截面顶点数必须在 3 到 32 之间');
  if (radii.length !== n) diag.errors.push('半径数量必须与路径点数量相同');
  if (radii.some((r) => !(r > 0))) diag.errors.push('所有半径必须 > 0');
  if (closed) {
    const k = twist / (2 * Math.PI);
    // 与量级相关的容差，避免 twist=0 时浮点噪声把整数 0 判为非整数
    if (Math.abs(k - Math.round(k)) > 1e-9 * (1 + Math.abs(k))) {
      diag.errors.push('闭合路径的总扭转必须是 2π 的整数倍');
    }
  }
  if (n > 256) diag.errors.push('路径点最多 256 个');

  // ---------- 段（闭合追加绕回首点的一段） ----------
  const segCount = closed ? n : n - 1;
  const segDirs = new Array(segCount);
  const segLens = new Array(segCount);
  for (let k = 0; k < segCount; k++) {
    const a = points[k];
    const b = points[(k + 1) % n];
    const d = v3.sub(b, a);
    const L = v3.norm(d);
    segLens[k] = L;
    if (L < EPS_LEN) {
      diag.zeroSegments.push(k);
      diag.errors.push(`第 ${k} 段长度 ${L.toExponential(2)} 小于 ${EPS_LEN}，无法定义切线`);
      segDirs[k] = null;
    } else {
      segDirs[k] = v3.scale(d, 1 / L);
    }
  }

  if (diag.errors.length) return { valid: false, diagnostics: diag };

  // ---------- 切线 ----------
  const tangents = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (!closed) {
      if (i === 0) {
        t = segDirs[0];
      } else if (i === n - 1) {
        t = segDirs[n - 2];
      } else {
        const s = v3.add(segDirs[i - 1], segDirs[i]);
        t = v3.norm(s) < EPS_SUM ? segDirs[i] : v3.normalize(s);
      }
    } else {
      const prevD = segDirs[(i - 1 + n) % n];
      const nextD = segDirs[i];
      const s = v3.add(prevD, nextD);
      t = v3.norm(s) < EPS_SUM ? nextD : v3.normalize(s);
    }
    tangents.push(t);
  }

  // ---------- 初始标架：与 t0 绝对点积最小的世界轴 ----------
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const order = [0, 1, 2].sort(
    (a, b) => Math.abs(v3.dot(tangents[0], axes[a])) -
              Math.abs(v3.dot(tangents[0], axes[b]))
  );
  const firstAxis = axes[order[0]];
  const n0 = v3.normalize(
    v3.sub(firstAxis, v3.scale(tangents[0], v3.dot(firstAxis, tangents[0])))
  );
  const baseNormals = [n0];
  const baseBinormals = [v3.cross(tangents[0], n0)];

  // ---------- 平行移动 ----------
  for (let i = 1; i < n; i++) {
    const ni = transport(baseNormals[i - 1], tangents[i - 1], tangents[i]);
    const ang = Math.acos(
      Math.max(-1, Math.min(1, v3.dot(tangents[i - 1], tangents[i])))
    );
    if (ang >= Math.PI / 2) {
      diag.frameJumps.push({ at: i, angleDeg: ang * 180 / Math.PI });
    }
    baseNormals.push(ni);
    baseBinormals.push(v3.cross(tangents[i], ni));
  }

  // ---------- 闭环接缝扭角 ----------
  let seamTwist = 0;
  if (closed) {
    const nReturn = transport(baseNormals[n - 1], tangents[n - 1], tangents[0]);
    seamTwist = Math.atan2(
      v3.dot(tangents[0], v3.cross(n0, nReturn)),
      v3.dot(n0, nReturn)
    );
    diag.seamTwistDeg = seamTwist * 180 / Math.PI;
  }

  // ---------- 弧长 ----------
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + segLens[i - 1]);
  const L = segLens.reduce((a, b) => a + b, 0);

  // ---------- 总扭转 + 闭环补偿，得到最终环标架 ----------
  const ringNormals = [];
  const ringBinormals = [];
  const ringTwistAngles = [];
  for (let i = 0; i < n; i++) {
    let phi = twist * s[i] / L;
    if (closed && compensate) phi += -seamTwist * s[i] / L;
    ringTwistAngles.push(phi);
    const c = Math.cos(phi), sn = Math.sin(phi);
    ringNormals.push(
      v3.add(v3.scale(baseNormals[i], c), v3.scale(baseBinormals[i], sn))
    );
    ringBinormals.push(
      v3.add(v3.scale(baseNormals[i], -sn), v3.scale(baseBinormals[i], c))
    );
  }

  // ---------- 环顶点 P + r*(u*n + v*b) ----------
  const rings = [];
  for (let i = 0; i < n; i++) {
    const ring = [];
    for (const [u, v] of profile) {
      const off = v3.add(
        v3.scale(ringNormals[i], u * radii[i]),
        v3.scale(ringBinormals[i], v * radii[i])
      );
      ring.push(v3.add(points[i], off));
    }
    rings.push(ring);
  }

  // ---------- 侧面三角形 ----------
  // 四边形 (a_i,j, b_i,j+1, c_i+1,j, d_i+1,j+1) -> (a,b,d),(a,d,c)
  const sideVerts = rings.flat();
  const sideIndex = (i, j) => (i % n) * m + (j % m);
  const sideTris = [];
  const bandCount = closed ? n : n - 1;
  for (let i = 0; i < bandCount; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const a = sideIndex(i, j);
      const b = sideIndex(i, j2);
      const c = sideIndex(i2, j);
      const d = sideIndex(i2, j2);
      sideTris.push([a, b, d], [a, d, c]);
    }
  }

  const triCross = (tri, verts) => {
    const p0 = verts[tri[0]], p1 = verts[tri[1]], p2 = verts[tri[2]];
    return v3.cross(v3.sub(p1, p0), v3.sub(p2, p0));
  };

  // 侧面退化面
  sideTris.forEach((tri, k) => {
    if (v3.norm(triCross(tri, sideVerts)) < EPS_AREA) {
      diag.degenerateFaces.push({ triangle: k, where: 'side' });
    }
  });

  // 侧面自交面：发夹弯等情况下相邻环空间穿插，面的几何法线会指向管轴。
  // 这是几何自交而非绕序错误（绕序约定在非自交处始终朝外）。
  sideTris.forEach((tri, k) => {
    const cr = triCross(tri, sideVerts);
    if (v3.norm(cr) < EPS_AREA) return; // 退化面已另行报告
    const ringI = Math.floor(tri[0] / m);
    const fc = [0, 1, 2].map((q) =>
      (sideVerts[tri[0]][q] + sideVerts[tri[1]][q] + sideVerts[tri[2]][q]) / 3);
    const radial = v3.sub(fc, points[ringI]);
    if (v3.dot(cr, radial) < 0) {
      diag.selfIntersectingFaces.push({ triangle: k, ring: ringI });
    }
  });

  // ---------- 侧面法线：邻接非退化面叉积之和归一化 ----------
  const sideNormals = Array.from({ length: n * m }, () => [0, 0, 0]);
  for (const tri of sideTris) {
    const cr = triCross(tri, sideVerts);
    if (v3.norm(cr) < EPS_AREA) continue;
    for (const vi of tri) {
      sideNormals[vi] = v3.add(sideNormals[vi], cr);
    }
  }
  for (let i = 0; i < n * m; i++) {
    if (v3.norm(sideNormals[i]) > 0) {
      sideNormals[i] = v3.normalize(sideNormals[i]);
    } else {
      // 兜底：沿截面径向，仍是朝外的确定法线
      const ringI = Math.floor(i / m);
      const rad = v3.sub(sideVerts[i], points[ringI]);
      sideNormals[i] = v3.norm(rad) > 0
        ? v3.normalize(rad)
        : v3.normalize(ringNormals[ringI]);
    }
  }

  // ---------- 端盖（仅开放路径；复制截面环与中心，三角扇） ----------
  // 独立顶点，不与侧面共享，法线为各自恒定朝向。
  // capTris 存 capVerts 的局部索引；OBJ/JSON 导出时加 sideVerts.length 的全局偏移。
  const capVerts = [];
  const capTris = [];
  const capNormals = [];
  if (!closed && caps) {
    // 起点盖：朝 -t0
    const base0 = capVerts.length;
    capVerts.push(...rings[0].map((p) => p.slice()));
    capVerts.push(points[0].slice());
    const center0 = base0 + m;
    for (let j = 0; j < m; j++) {
      capTris.push([center0, base0 + ((j + 1) % m), base0 + j]);
    }
    const nStart = v3.scale(tangents[0], -1);
    for (let k = 0; k < m + 1; k++) capNormals.push(nStart);

    // 终点盖：朝 +t_end
    const base1 = capVerts.length;
    capVerts.push(...rings[n - 1].map((p) => p.slice()));
    capVerts.push(points[n - 1].slice());
    const center1 = base1 + m;
    for (let j = 0; j < m; j++) {
      capTris.push([center1, base1 + j, base1 + ((j + 1) % m)]);
    }
    const nEnd = tangents[n - 1].slice();
    for (let k = 0; k < m + 1; k++) capNormals.push(nEnd);
  }

  capTris.forEach((tri, k) => {
    const p0 = capVerts[tri[0]], p1 = capVerts[tri[1]], p2 = capVerts[tri[2]];
    const cr = v3.cross(v3.sub(p1, p0), v3.sub(p2, p0));
    if (v3.norm(cr) < EPS_AREA) {
      diag.degenerateFaces.push({ triangle: sideTris.length + k, where: 'cap' });
    }
  });

  if (!diag.frameJumps.length) {
    diag.warnings.push('相邻切线夹角均小于 90°，无框架跳变');
  }

  return {
    valid: true,
    n, m, closed, caps,
    arcLength: L,
    s,
    tangents,
    baseNormals,
    baseBinormals,
    ringNormals,
    ringBinormals,
    ringTwistAngles,
    seamTwist,
    rings,
    sideVerts,
    sideTris,
    sideNormals,
    capVerts,
    capTris,
    capNormals,
    diagnostics: diag,
  };
}
