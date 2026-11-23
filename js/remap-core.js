/*
 * 环境立方图旋转重采样 —— 纯计算核心（无 DOM 依赖，浏览器 / Node 通用）
 *
 * 约定（与 samples/solid-angle-cubemap.json 的 rules 一致）：
 *  面序 0..5 = +X, -X, +Y, -Y, +Z, -Z
 *  未归一方向：+X(1,-v,-u) -X(-1,-v,u) +Y(u,1,v) -Y(u,-1,-v) +Z(u,-v,1) -Z(-u,-v,-1)
 *  u、v 随列、行在 [-1,1] 均分 n 格；q=(x,y,z,w) 归一化右手主动旋转（源方向 -> 目标方向）
 *
 * 权重即球面多边形的精确立体角：目标纹素四角射线逆旋转回源空间后，
 * 用过原点的半空间做 Sutherland-Hodgman 裁剪分到各源面棱锥，
 * 再在源面 uv 平面按纹素网格裁剪，三角扇形 + Van Oosterom 四面体立体角公式求和。
 * 每个源纹素份额由互斥的网格单元给出，跨面 / 跨顶角只计一次。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CubemapRemap = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  const FACE_AXIS = [0, 0, 1, 1, 2, 2];
  const FACE_SIGN = [1, -1, 1, -1, 1, -1];
  const DEDUP_EPS = 1e-14;

  // ---------- 向量工具 ----------
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function norm3(p) {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l];
  }

  // ---------- 立方图几何 ----------
  function faceRay(f, u, v) {
    switch (f) {
      case 0: return [1, -v, -u];
      case 1: return [-1, -v, u];
      case 2: return [u, 1, v];
      case 3: return [u, -1, -v];
      case 4: return [u, -v, 1];
      case 5: return [-u, -v, -1];
      default: throw new Error('bad face ' + f);
    }
  }

  // 射线 p 投影到面 f 的 (u, v)（调用前应保证 p 落在该面棱锥内）
  function projectToFace(f, p) {
    const x = p[0], y = p[1], z = p[2];
    switch (f) {
      case 0: return [-z / x, -y / x];
      case 1: return [-z / x, y / x];
      case 2: return [x / y, z / y];
      case 3: return [-x / y, z / y];
      case 4: return [x / z, -y / z];
      case 5: return [x / z, y / z];
      default: throw new Error('bad face ' + f);
    }
  }

  // 面 f 的棱锥半空间：s·p_axis ± p_other >= 0（共 4 个过原点平面，法向即平面系数）
  function facePlanes(f) {
    const axis = FACE_AXIS[f], s = FACE_SIGN[f];
    const planes = [];
    for (let j = 0; j < 3; j++) {
      if (j === axis) continue;
      const n1 = [0, 0, 0], n2 = [0, 0, 0];
      n1[axis] = s; n1[j] = -1;
      n2[axis] = s; n2[j] = 1;
      planes.push(n1, n2);
    }
    return planes;
  }
  const ALL_FACE_PLANES = [0, 1, 2, 3, 4, 5].map(facePlanes);

  function texelBounds(size, row, col) {
    const h = 2 / size;
    const u0 = -1 + col * h, u1 = u0 + h;
    const v0 = -1 + row * h, v1 = v0 + h;
    return { u0, u1, v0, v1, h };
  }

  // 目标 / 源纹素四角的单位射线（顺序 (u0,v0),(u1,v0),(u1,v1),(u0,v1)）
  function texelCorners(f, size, row, col) {
    const b = texelBounds(size, row, col);
    return [
      norm3(faceRay(f, b.u0, b.v0)),
      norm3(faceRay(f, b.u1, b.v0)),
      norm3(faceRay(f, b.u1, b.v1)),
      norm3(faceRay(f, b.u0, b.v1)),
    ];
  }

  // ---------- 立体角 ----------
  // 单位射线 a,b,c 张成的球面三角形有向立体角，Van Oosterom & Strackee (1983)
  function triSolidAngle(a, b, c) {
    const num = dot(a, cross(b, c));
    const den = 1 + dot(a, b) + dot(b, c) + dot(c, a);
    return 2 * Math.atan2(num, den);
  }

  // 凸球面多边形（单位射线，绕序一致）的立体角
  function polygonSolidAngle(pts) {
    if (pts.length < 3) return 0;
    let s = 0;
    const a = pts[0];
    for (let i = 1; i + 1 < pts.length; i++) {
      s += triSolidAngle(a, pts[i], pts[i + 1]);
    }
    return Math.abs(s);
  }

  function texelSolidAngle(f, size, row, col) {
    return polygonSolidAngle(texelCorners(f, size, row, col));
  }

  // ---------- 裁剪 ----------
  function lerpAt(a, b, da, db) {
    const t = da / (da - db);
    return add(a, scale(sub(b, a), t));
  }

  function dedup3D(pts) {
    const out = [];
    for (const p of pts) {
      const q = out.length ? out[out.length - 1] : null;
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > DEDUP_EPS) out.push(p);
    }
    if (out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= DEDUP_EPS) out.pop();
    }
    return out;
  }

  // 三维 Sutherland-Hodgman：保留 n·p >= 0 一侧（平面过原点，交线即大圆）
  function clip3D(poly, n) {
    if (poly.length < 3) return poly;
    const out = [];
    let prev = poly[poly.length - 1];
    let dp = dot(n, prev);
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const dc = dot(n, cur);
      const inC = dc >= 0, inP = dp >= 0;
      if (inC) {
        if (!inP) out.push(lerpAt(prev, cur, dp, dc));
        out.push(cur);
      } else if (inP) {
        out.push(lerpAt(prev, cur, dp, dc));
      }
      prev = cur;
      dp = dc;
    }
    return dedup3D(out);
  }

  function dedup2D(pts) {
    const out = [];
    for (const p of pts) {
      const q = out.length ? out[out.length - 1] : null;
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > DEDUP_EPS) out.push(p);
    }
    if (out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= DEDUP_EPS) out.pop();
    }
    return out;
  }

  // 二维 Sutherland-Hodgman：保留 dist(p) >= 0 一侧
  function clip2D(poly, dist) {
    if (poly.length < 3) return poly;
    const out = [];
    let prev = poly[poly.length - 1];
    let dp = dist(prev);
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const dc = dist(cur);
      const inC = dc >= 0, inP = dp >= 0;
      if (inC) {
        if (!inP) {
          const t = dp / (dp - dc);
          out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
        }
        out.push(cur);
      } else if (inP) {
        const t = dp / (dp - dc);
        out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
      }
      prev = cur;
      dp = dc;
    }
    return dedup2D(out);
  }

  // ---------- 旋转 ----------
  function quatToMatrix(q) {
    let x = q[0], y = q[1], z = q[2], w = q[3];
    const l = Math.hypot(x, y, z, w);
    x /= l; y /= l; z /= l; w /= l;
    const x2 = x * x, y2 = y * y, z2 = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (y2 + z2), 2 * (xy - wz), 2 * (xz + wy),
      2 * (xy + wz), 1 - 2 * (x2 + z2), 2 * (yz - wx),
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (x2 + y2),
    ];
  }

  // R^T p：把目标空间射线变回源空间
  function rotateBack(R, p) {
    return [
      R[0] * p[0] + R[3] * p[1] + R[6] * p[2],
      R[1] * p[0] + R[4] * p[1] + R[7] * p[2],
      R[2] * p[0] + R[5] * p[1] + R[8] * p[2],
    ];
  }

  // 欧拉角（弧度，外旋 XYZ 即 R = Rz(g) Ry(b) Rx(a)）转四元数 (x,y,z,w)
  function eulerToQuat(a, b, g) {
    const ca = Math.cos(a / 2), sa = Math.sin(a / 2);
    const cb = Math.cos(b / 2), sb = Math.sin(b / 2);
    const cg = Math.cos(g / 2), sg = Math.sin(g / 2);
    return [
      sa * cb * cg - ca * sb * sg,
      ca * sb * cg + sa * cb * sg,
      ca * cb * sg - sa * sb * cg,
      ca * cb * cg + sa * sb * sg,
    ];
  }

  // 矩阵 -> 欧拉角（弧度，与 eulerToQuat 互逆；R = Rz(g) Ry(b) Rx(a)）
  function eulerFromMatrix(R) {
    const sb = -R[6]; // R20 = -sin(b)
    const b = Math.asin(Math.max(-1, Math.min(1, sb)));
    let a, g;
    if (Math.abs(Math.cos(b)) > 1e-9) {
      a = Math.atan2(R[7], R[8]);
      g = Math.atan2(R[3], R[0]);
    } else {
      a = 0;
      g = Math.atan2(-R[1], R[4]);
    }
    return [a, b, g];
  }

  function eulerFromQuat(q) {
    return eulerFromMatrix(quatToMatrix(q));
  }

  // ---------- 输入校验 ----------
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  function validateInput(d) {
    const errors = [];
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      errors.push({ kind: 'param', field: 'root', message: '根节点必须是 JSON 对象' });
      return { valid: false, errors };
    }

    let n = d.n, out = d.out;
    if (!Number.isInteger(n) || n < 1 || n > 64) {
      errors.push({ kind: 'param', field: 'n', message: '源边长 n 必须是 1 到 64 的整数，当前为 ' + JSON.stringify(d.n) });
      n = null;
    }
    if (!Number.isInteger(out) || out < 1 || out > 64) {
      errors.push({ kind: 'param', field: 'out', message: '目标边长 out 必须是 1 到 64 的整数，当前为 ' + JSON.stringify(d.out) });
    }

    if (!Array.isArray(d.q) || d.q.length !== 4) {
      errors.push({ kind: 'rotation', field: 'q', message: '旋转 q 必须是长度 4 的数组 [x,y,z,w]' });
    } else {
      const comps = ['x', 'y', 'z', 'w'];
      d.q.forEach((v, i) => {
        if (!isFiniteNum(v)) {
          errors.push({ kind: 'rotation', field: 'q', component: comps[i],
            message: '旋转参数 ' + comps[i] + ' 不是有限数，当前为 ' + JSON.stringify(v) });
        }
      });
      if (d.q.every(isFiniteNum)) {
        const ql = Math.hypot(d.q[0], d.q[1], d.q[2], d.q[3]);
        if (ql < 1e-12) {
          errors.push({ kind: 'rotation', field: 'q', message: '四元数模长为 0，无法归一化（旋转无效）' });
        }
      }
    }

    if (!Array.isArray(d.faces) || d.faces.length !== 6) {
      errors.push({ kind: 'param', field: 'faces', message: 'faces 必须是长度 6 的数组（六面）' });
    } else if (n !== null) {
      const expect = n * n;
      d.faces.forEach((face, f) => {
        if (!Array.isArray(face) || face.length !== expect) {
          errors.push({ kind: 'face', face: f,
            message: '源面 ' + f + '（' + FACE_NAMES[f] + '）必须是长度 ' + expect +
              ' 的纹素数组（纹素本身可以为 null），实际为 ' +
              (Array.isArray(face) ? '长度 ' + face.length + ' 的数组' : JSON.stringify(face)) });
          return;
        }
        face.forEach((tex, i) => {
          if (tex === null) return;
          const row = Math.floor(i / n), col = i % n;
          const where = '源面 ' + f + '（' + FACE_NAMES[f] + '）纹素 (行' + row + ', 列' + col + ')';
          if (!Array.isArray(tex) || tex.length !== 3) {
            errors.push({ kind: 'face', face: f, index: i, row, col,
              message: where + ' 必须是 null 或长度 3 的 RGB 数组' });
            return;
          }
          tex.forEach((v, c) => {
            if (!isFiniteNum(v) || v < 0 || v > 1) {
              errors.push({ kind: 'face', face: f, index: i, row, col, component: c,
                message: where + ' 的 ' + 'RGB'[c] + ' 分量必须在 [0,1]，当前为 ' + JSON.stringify(v) });
            }
          });
        });
      });
    }

    return { valid: errors.length === 0, errors };
  }

  // ---------- 重采样 ----------
  function buildParams(input) {
    const n = input.n, out = input.out;
    const R = quatToMatrix(input.q);
    const srcFlat = input.faces;
    // 同面纹素立体角随位置变化，必须逐块预计算
    const srcSA = [0, 1, 2, 3, 4, 5].map(f => {
      const arr = new Float64Array(n * n);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        arr[r * n + c] = texelSolidAngle(f, n, r, c);
      }
      return arr;
    });
    const dstSA = [0, 1, 2, 3, 4, 5].map(f => {
      const arr = new Float64Array(out * out);
      for (let r = 0; r < out; r++) for (let c = 0; c < out; c++) {
        arr[r * out + c] = texelSolidAngle(f, out, r, c);
      }
      return arr;
    });
    return { n, out, R, srcFlat, srcSA, dstSA };
  }

  // 单个目标纹素：返回 rgb（分母为整块目标立体角）、覆盖率、全部源贡献
  function resampleTexel(params, tf, trow, tcol) {
    const { n, out, R, srcFlat } = params;
    const omegaT = params.dstSA[tf][trow * out + tcol];

    // 四角射线逆旋转回源空间
    const corners = texelCorners(tf, out, trow, tcol).map(p => norm3(rotateBack(R, p)));

    const contributions = [];
    let weightSum = 0, validWeight = 0;
    const num = [0, 0, 0];

    for (let f = 0; f < 6; f++) {
      let poly = corners;
      const planes = ALL_FACE_PLANES[f];
      for (let k = 0; k < planes.length && poly.length >= 3; k++) {
        poly = clip3D(poly, planes[k]);
      }
      if (poly.length < 3) continue;

      let uv = poly.map(p => {
        const q = projectToFace(f, norm3(p));
        return q;
      });
      // 数值安全：钳回 [-1,1] 方域
      uv = clip2D(uv, p => p[0] + 1);
      uv = clip2D(uv, p => 1 - p[0]);
      uv = clip2D(uv, p => p[1] + 1);
      uv = clip2D(uv, p => 1 - p[1]);
      if (uv.length < 3) continue;

      let uMin = 1, uMax = -1, vMin = 1, vMax = -1;
      for (const q of uv) {
        if (q[0] < uMin) uMin = q[0];
        if (q[0] > uMax) uMax = q[0];
        if (q[1] < vMin) vMin = q[1];
        if (q[1] > vMax) vMax = q[1];
      }
      const h = 2 / n;
      const c0 = Math.max(0, Math.floor((uMin + 1) / h - 1e-12));
      const c1 = Math.min(n - 1, Math.floor((uMax + 1) / h + 1e-12));
      const r0 = Math.max(0, Math.floor((vMin + 1) / h - 1e-12));
      const r1 = Math.min(n - 1, Math.floor((vMax + 1) / h + 1e-12));

      for (let c = c0; c <= c1; c++) {
        const gu0 = -1 + c * h, gu1 = gu0 + h;
        const colPoly = clip2D(clip2D(uv, p => p[0] - gu0), p => gu1 - p[0]);
        if (colPoly.length < 3) continue;
        for (let r = r0; r <= r1; r++) {
          const gv0 = -1 + r * h, gv1 = gv0 + h;
          const cell = clip2D(clip2D(colPoly, p => p[1] - gv0), p => gv1 - p[1]);
          if (cell.length < 3) continue;
          const pts3 = cell.map(q => norm3(faceRay(f, q[0], q[1])));
          const w = polygonSolidAngle(pts3);
          if (!(w > 0) || !Number.isFinite(w)) continue;

          weightSum += w;
          const idx = r * n + c;
          const color = srcFlat[f][idx];
          const missing = color === null;
          if (!missing) {
            validWeight += w;
            num[0] += color[0] * w;
            num[1] += color[1] * w;
            num[2] += color[2] * w;
          }
          contributions.push({
            face: f, row: r, col: c, weight: w, missing,
            u: (gu0 + gu1) / 2, v: (gv0 + gv1) / 2,
          });
        }
      }
    }

    contributions.sort((a, b) => b.weight - a.weight);
    return {
      omegaT,
      weightSum,
      validWeight,
      coverage: validWeight / omegaT,
      rgb: [num[0] / omegaT, num[1] / omegaT, num[2] / omegaT],
      contributions,
    };
  }

  function resampleCubemap(input, opts) {
    opts = opts || {};
    const check = validateInput(input);
    if (!check.valid) return { ok: false, errors: check.errors };

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const params = buildParams(input);
    const { n, out, srcFlat, srcSA, dstSA } = params;
    const count = 6 * out * out;
    const rgb = new Float64Array(count * 3);
    const coverage = new Float64Array(count);
    const cancel = opts.cancel || null;
    const chunk = opts.chunk || 128;

    let maxAbsResidual = 0, maxRelResidual = 0;
    let k = 0;
    for (let f = 0; f < 6; f++) {
      for (let row = 0; row < out; row++) {
        for (let col = 0; col < out; col++) {
          if (cancel && cancel.cancelled) {
            return { ok: true, cancelled: true, done: k, count };
          }
          const res = resampleTexel(params, f, row, col);
          rgb[k * 3] = res.rgb[0];
          rgb[k * 3 + 1] = res.rgb[1];
          rgb[k * 3 + 2] = res.rgb[2];
          coverage[k] = res.coverage;
          const resid = Math.abs(res.weightSum - res.omegaT);
          if (resid > maxAbsResidual) maxAbsResidual = resid;
          const rel = resid / res.omegaT;
          if (rel > maxRelResidual) maxRelResidual = rel;
          k++;
          if (opts.onProgress && (k % chunk === 0 || k === count)) opts.onProgress(k / count);
        }
      }
    }

    // 旋转前后每通道立体角加权总量（缺测按零）
    const srcTotal = [0, 0, 0], dstTotal = [0, 0, 0];
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < n * n; i++) {
        const t = srcFlat[f][i];
        if (t !== null) {
          const saS = srcSA[f][i];
          srcTotal[0] += t[0] * saS;
          srcTotal[1] += t[1] * saS;
          srcTotal[2] += t[2] * saS;
        }
      }
      for (let i = 0; i < out * out; i++) {
        const idx = f * out * out + i;
        const saT = dstSA[f][i];
        dstTotal[0] += rgb[idx * 3] * saT;
        dstTotal[1] += rgb[idx * 3 + 1] * saT;
        dstTotal[2] += rgb[idx * 3 + 2] * saT;
      }
    }
    const conservationDiff = [
      Math.abs(srcTotal[0] - dstTotal[0]),
      Math.abs(srcTotal[1] - dstTotal[1]),
      Math.abs(srcTotal[2] - dstTotal[2]),
    ];

    let minCoverage = 1, maxCoverage = 0;
    for (let i = 0; i < count; i++) {
      if (coverage[i] < minCoverage) minCoverage = coverage[i];
      if (coverage[i] > maxCoverage) maxCoverage = coverage[i];
    }

    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return {
      ok: true,
      cancelled: false,
      n, out,
      rgb, coverage,
      stats: {
        elapsedMs,
        srcTotal, dstTotal, conservationDiff,
        maxAbsResidual, maxRelResidual,
        minCoverage, maxCoverage,
        sphereSA: 4 * Math.PI,
        weightTotal: dstSA.reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0),
      },
    };
  }

  // 结果转可导出 JSON（六面线性 RGB + 覆盖率，按行嵌套）
  function resultToJSON(input, result) {
    const { out } = result;
    const ql = Math.hypot(...input.q);
    const faces = [], coverage = [];
    for (let f = 0; f < 6; f++) {
      const face = [], cov = [];
      for (let i = 0; i < out * out; i++) {
        const idx = f * out * out + i;
        face.push([result.rgb[idx * 3], result.rgb[idx * 3 + 1], result.rgb[idx * 3 + 2]]);
        cov.push(result.coverage[idx]);
      }
      faces.push(face);
      coverage.push(cov);
    }
    return {
      rules: '目标 faces 为按行的 out^2 个线性 RGB 三元组（缺测按零计入），coverage 为有效覆盖率；两者分母均为目标纹素整块立体角',
      n: input.n,
      out: input.out,
      q: [input.q[0] / ql, input.q[1] / ql, input.q[2] / ql, input.q[3] / ql],
      faces,
      coverage,
      stats: result.stats,
    };
  }

  return {
    FACE_NAMES,
    faceRay,
    projectToFace,
    texelBounds,
    texelCorners,
    texelSolidAngle,
    polygonSolidAngle,
    triSolidAngle,
    quatToMatrix,
    rotateBack,
    eulerToQuat,
    eulerFromMatrix,
    eulerFromQuat,
    validateInput,
    buildParams,
    resampleTexel,
    resampleCubemap,
    resultToJSON,
  };
});
