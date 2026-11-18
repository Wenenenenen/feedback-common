// 逐角切线空间计算，严格按样例包《格式说明》规则实现：
// 1. 每面按 UV 雅可比求原始 T、B；|UV 行列式| <= 1e-10 的面不参与累计。
// 2. 角度权重取三维内角弧度；按 (位置索引, UV 值, 法线值, UV 行列式符号) 分组累计。
// 3. T 对 N 做 Gram-Schmidt 并归一化；h = sign(dot(cross(N,T),B))，零取 +1。
// 4. 投影后 |T| <= 1e-10 时，取 N 绝对分量最小的坐标轴（同值 X、Y、Z）投影成 T，h=+1 并诊断。
// 5. 实例矩阵行主序 4x4：N 按逆转置，T 按线性部分变换后重新正交化，h 乘线性行列式符号，B = h*cross(N,T)。
import { v3, m3, m4 } from './math.js';

export const EPS = 1e-10;

function groupKey(posIdx, uv, n, detSign) {
  return `${posIdx}|${uv[0]},${uv[1]}|${n[0]},${n[1]},${n[2]}|${detSign}`;
}

// mesh: { positions: [[x,y,z]...], faces: [{ v:[i0,i1,i2], uv:[[u,v]x3], n:[[x,y,z]x3] }] }
// 返回 { corners, diagnostics, stats }
// corners 按面优先顺序，每项 { face, corner, T, B, N, h, fallback, uvDet, uvDetSign, groupId }
export function computeTangentFrames(mesh) {
  const { positions, faces } = mesh;
  const groups = new Map(); // key -> { T:[3], B:[3], members: [[fi,ci]...], detSign }
  const diagnostics = [];
  const cornerKeys = [];
  let skippedFaces = 0;

  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const p = f.v.map((i) => positions[i]);
    const e1 = v3.sub(p[1], p[0]);
    const e2 = v3.sub(p[2], p[0]);
    const d1 = [f.uv[1][0] - f.uv[0][0], f.uv[1][1] - f.uv[0][1]];
    const d2 = [f.uv[2][0] - f.uv[0][0], f.uv[2][1] - f.uv[0][1]];
    const det = d1[0] * d2[1] - d2[0] * d1[1];
    const keys = new Array(3);

    if (Math.abs(det) <= EPS) {
      skippedFaces++;
      diagnostics.push(
        `面 ${fi}：UV 面积为零（|det|=${Math.abs(det).toExponential(2)} ≤ 1e-10），不参与切线累计，相关角走回退`
      );
      for (let ci = 0; ci < 3; ci++) {
        keys[ci] = { key: groupKey(f.v[ci], f.uv[ci], f.n[ci], 0), det, detSign: 0 };
      }
    } else {
      const detSign = det > 0 ? 1 : -1;
      const T = [
        (d2[1] * e1[0] - d1[1] * e2[0]) / det,
        (d2[1] * e1[1] - d1[1] * e2[1]) / det,
        (d2[1] * e1[2] - d1[1] * e2[2]) / det,
      ];
      const B = [
        (-d2[0] * e1[0] + d1[0] * e2[0]) / det,
        (-d2[0] * e1[1] + d1[0] * e2[1]) / det,
        (-d2[0] * e1[2] + d1[0] * e2[2]) / det,
      ];
      for (let ci = 0; ci < 3; ci++) {
        // 三维内角（弧度）作为权重
        const a = v3.sub(p[(ci + 1) % 3], p[ci]);
        const b = v3.sub(p[(ci + 2) % 3], p[ci]);
        const la = v3.len(a), lb = v3.len(b);
        let w = 0;
        if (la > 0 && lb > 0) {
          w = Math.acos(Math.min(1, Math.max(-1, v3.dot(a, b) / (la * lb))));
        } else {
          diagnostics.push(`面 ${fi} 角 ${ci}：几何边长为零，角度权重取 0，该角本次不贡献累计`);
        }
        const key = groupKey(f.v[ci], f.uv[ci], f.n[ci], detSign);
        let g = groups.get(key);
        if (!g) {
          g = { T: [0, 0, 0], B: [0, 0, 0], members: [], detSign };
          groups.set(key, g);
        }
        for (let k = 0; k < 3; k++) {
          g.T[k] += w * T[k];
          g.B[k] += w * B[k];
        }
        g.members.push([fi, ci]);
        keys[ci] = { key, det, detSign };
      }
    }
    cornerKeys.push(keys);
  }

  // 逐组解算，回退诊断按组去重
  const groupResult = new Map(); // key -> { T, h, fallback, axis }
  for (const [key, g] of groups) {
    const n = v3.normalize(mesh.faces[g.members[0][0]].n[g.members[0][1]]);
    const Tp = v3.sub(g.T, v3.scale(n, v3.dot(n, g.T)));
    if (v3.len(Tp) <= EPS) {
      const comps = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
      const ai = comps.indexOf(Math.min(...comps));
      const axis = [0, 0, 0];
      axis[ai] = 1;
      const T = v3.normalize(v3.sub(axis, v3.scale(n, v3.dot(n, axis))));
      groupResult.set(key, { T, h: 1, fallback: true, axis: ai });
      const where = g.members.map(([fi, ci]) => `面${fi}角${ci}`).join('、');
      diagnostics.push(
        `切线回退（${where}）：累计/投影后切线长度 ≤ 1e-10（可能为零面积 UV 或正负手性抵消），` +
          `改用 ${'XYZ'[ai]} 轴投影，h=+1`
      );
    } else {
      const T = v3.normalize(Tp);
      const s = v3.dot(v3.cross(n, T), g.B);
      groupResult.set(key, { T, h: s >= 0 ? 1 : -1, fallback: false, axis: -1 });
    }
  }

  const corners = [];
  for (let fi = 0; fi < faces.length; fi++) {
    for (let ci = 0; ci < 3; ci++) {
      const n = v3.normalize(faces[fi].n[ci]);
      const { key, det, detSign } = cornerKeys[fi][ci];
      const g = groupResult.get(key);
      const T = g ? g.T : [1, 0, 0];
      const h = g ? g.h : 1;
      corners.push({
        face: fi,
        corner: ci,
        posIndex: faces[fi].v[ci],
        uv: faces[fi].uv[ci].slice(),
        T: T.slice(),
        N: n,
        B: v3.scale(v3.cross(n, T), h),
        h,
        fallback: g ? g.fallback : true,
        uvDet: det,
        uvDetSign: detSign,
        groupId: key,
      });
    }
  }

  const mirroredGroups = [...groups.values()].filter((g) => g.detSign < 0).length;
  const stats = {
    faceCount: faces.length,
    cornerCount: corners.length,
    groupCount: groups.size,
    mirroredGroups,
    skippedFaces,
    fallbackCount: corners.filter((c) => c.fallback).length,
  };
  if (mirroredGroups > 0) {
    diagnostics.push(
      `检测到 ${mirroredGroups} 个 UV 行列式为负的分组（镜像 UV），已与正向分组分开累计`
    );
  }
  return { corners, diagnostics, stats };
}

// 实例变换：M 行主序 4x4。返回与 corners 等长的数组 { T, B, N, h }，以及线性行列式。
export function transformFrames(corners, M) {
  const L = m4.linear(M);
  const detL = m3.det(L);
  if (!Number.isFinite(detL) || Math.abs(detL) <= 0) {
    throw new Error('实例矩阵线性部分不可逆（行列式为 0），缩放必须非零');
  }
  const invT = m3.inverseTranspose(L);
  const hSign = detL > 0 ? 1 : -1;
  const out = corners.map((c) => {
    let N = v3.normalize(m3.mulVec(invT, c.N));
    let T = m3.mulVec(L, c.T);
    T = v3.sub(T, v3.scale(N, v3.dot(N, T)));
    T = v3.len(T) > EPS ? v3.normalize(T) : v3.normalize(v3.cross(N, [1, 0, 0]));
    const h = c.h * hSign;
    return { T, N, B: v3.scale(v3.cross(N, T), h), h };
  });
  return { frames: out, detLinear: detL, hSign };
}
