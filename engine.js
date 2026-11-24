/*
 * 孔径覆盖渲染 · 核心引擎
 * ---------------------------------------------------------------------------
 * 规则（取自 samples/pupil-coverage.json 的 rules 字段）：
 *   · 像素中心 q = (x + 0.5, y + 0.5)，孔径坐标 (u, v)。
 *   · 矩形光阑中心 = offset + slope · (q − 画面中心)，两轴半宽均为 1。
 *   · 每个孔径点 (u, v) 把三角形顶点平移 s · (u, v)；覆盖 q 的最小 depth 为
 *     所见，同 depth 取小 id，边界算覆盖。
 *   · 孔径内且光阑内没有命中则取背景；光阑外的孔径份额算黑。
 *   · 归一化始终使用原始孔径面积。
 *
 * 焦面偏移系数 f 是校片工具附加的参数：有效 s = s − f。f 等于某片的 s 时，
 * 该片位于焦面上（覆盖 q 即覆盖整个孔径）；f = 0 时严格回到样例规则。
 *
 * 求积方法
 *   固定 q、s，三角形 T 在孔径平面覆盖的区域是 { p : q − s·p ∈ T }。按 T 的
 *   CCW 边 (a→b)、边向量 e = b − a，它等价于三个闭半平面之交：
 *
 *       s · cross(e, p)  ≤  cross(e, q − a)
 *
 *   逐半平面对 D（孔径∩光阑）先取 cross(e, p) 的极值，判定它是“整个 D 都满足
 *   （可删）”“整个 D 都违反（该片不可见）”还是真正切割 D；只有真正切割时，
 *   才把不等式化成 cross(e, p) ≤ Bq/s（s ≠ 0）后裁剪。由于切割判定已保证
 *   商落在 D 的坐标范围内，这一步不会产生大数或溢出。s = 0 时条件退化为
 *   “q 是否在 T 内（边界算内）”，正好是“覆盖 q 即覆盖整个孔径”。
 *
 *   逐像素：先裁出 D，再按 (depth, id) 升序处理三角形，每个三角形与当前尚未
 *   被更近片占走的凸碎片求交，得到实际可见的凸多边形；再从碎片中减去它。
 *   全程只有凸多边形半平面裁剪与鞋带公式求面积，没有随机采样，也没有固定
 *   网格射线估计。
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) root.PupilEngine = M;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 相对原始孔径面积的碎片丢弃阈值：只丢数值噪声（≪1e-6 指标）。
  const REL_AREA_EPS = 1e-13;
  // 顶点去重阈值（坐标平方距离）。
  const DUP_EPS2 = 1e-24;

  // -------------------------------------------------------------------------
  // 基础几何
  // -------------------------------------------------------------------------

  function signedArea(poly) {
    let a = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function polyArea(poly) {
    return poly && poly.length >= 3 ? Math.abs(signedArea(poly)) : 0;
  }

  function ensureCCW(poly) {
    return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  }

  function dedupe(poly) {
    const n = poly.length;
    if (n < 3) return poly.slice(0, Math.max(0, n));
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const dx = p[0] - q[0], dy = p[1] - q[1];
      if (dx * dx + dy * dy > DUP_EPS2) out.push(p);
    }
    return out;
  }

  // 保留半平面 A·p ≤ B 的一侧（含边界）。
  function clipLeq(poly, Ax, Ay, B) {
    const n = poly.length;
    if (n < 3) return [];
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const da = Ax * a[0] + Ay * a[1] - B;
      const db = Ax * b[0] + Ay * b[1] - B;
      const ina = da <= 0, inb = db <= 0;
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return dedupe(out);
  }

  // 多边形所有顶点是否满足 A·p ≤ B（闭）。
  function allInside(poly, Ax, Ay, B) {
    for (let i = 0, n = poly.length; i < n; i++) {
      if (Ax * poly[i][0] + Ay * poly[i][1] - B > 0) return false;
    }
    return true;
  }

  // 点是否在三角形内（边界算覆盖）。
  function pointInTri(x, y, xy) {
    let pos = false, neg = false;
    for (let i = 0; i < 3; i++) {
      const a = xy[i], b = xy[(i + 1) % 3];
      const z = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (z > 0) pos = true;
      else if (z < 0) neg = true;
    }
    return !(pos && neg);
  }

  // -------------------------------------------------------------------------
  // 场景校验
  // -------------------------------------------------------------------------

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isPt(p) {
    return Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
  }

  function isRGB(c) {
    return Array.isArray(c) && c.length === 3 &&
      c.every(v => isNum(v) && v >= 0 && v <= 1);
  }

  function findRepeatedVertex(poly) {
    for (let i = 0; i < poly.length; i++) {
      for (let j = i + 1; j < poly.length; j++) {
        const dx = poly[i][0] - poly[j][0], dy = poly[i][1] - poly[j][1];
        if (dx * dx + dy * dy <= 1e-26) return [i, j];
      }
    }
    return null;
  }

  // 返回错误信息数组；空数组表示合法。每条错误都指向具体位置/原因。
  function validate(scene) {
    const errors = [];
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      return ['场景不是有效的 JSON 对象'];
    }
    const { width, height, pupil, stop, bg, triangles } = scene;

    if (!Number.isInteger(width) || width < 1 || width > 96) {
      errors.push(`画面宽度 width 须为 1–96 的整数，当前为 ${JSON.stringify(width)}`);
    }
    if (!Number.isInteger(height) || height < 1 || height > 72) {
      errors.push(`画面高度 height 须为 1–72 的整数，当前为 ${JSON.stringify(height)}`);
    }

    // ---- 凸孔径 ----
    if (!Array.isArray(pupil)) {
      errors.push('pupil 须为顶点数组');
    } else if (pupil.length < 3 || pupil.length > 16) {
      errors.push(`凸孔径顶点数须为 3–16，当前为 ${pupil.length}`);
    } else {
      let ptsOk = true;
      for (let i = 0; i < pupil.length; i++) {
        if (!isPt(pupil[i])) {
          errors.push(`孔径顶点 #${i}（从 0 计）不是有效的 [u, v] 数值对`);
          ptsOk = false;
        }
      }
      if (ptsOk) {
        const repeat = findRepeatedVertex(pupil);
        if (repeat !== null) {
          errors.push(`孔径顶点 #${repeat[0]} 与 #${repeat[1]}（从 0 计）重合，多边形退化`);
        } else {
          let scale = 1;
          for (const p of pupil) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
          const tol = 1e-12 * scale * scale;
          const A = signedArea(pupil);
          if (Math.abs(A) <= tol) {
            errors.push('凸孔径的面积必须为正（当前面积接近 0，顶点共线或退化）');
          } else {
            const sgn = A > 0 ? 1 : -1;
            let bad = null;
            for (let i = 0; i < pupil.length; i++) {
              const a = pupil[i];
              const b = pupil[(i + 1) % pupil.length];
              const c = pupil[(i + 2) % pupil.length];
              const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
              if (Math.abs(z) <= tol) { bad = { kind: 'collinear', at: (i + 1) % pupil.length }; break; }
              if (z * sgn < 0) { bad = { kind: 'concave', at: (i + 1) % pupil.length }; break; }
            }
            if (bad) {
              errors.push(bad.kind === 'collinear'
                ? `孔径第 ${bad.at} 个顶点处三点接近共线，多边形退化`
                : `孔径顶点 #${bad.at}（从 0 计）处内凹，pupil 不是凸多边形`);
            }
          }
        }
      }
    }

    // ---- 光阑 ----
    if (!stop || typeof stop !== 'object' || Array.isArray(stop) ||
        !isPt(stop.offset) || !isPt(stop.slope)) {
      errors.push('stop.offset 与 stop.slope 须各为两个有限数 [x, y]');
    }

    // ---- 背景色 ----
    if (!isRGB(bg)) {
      errors.push('bg 须为 0–1 的线性 RGB 三元组');
    }

    // ---- 三角形 ----
    if (!Array.isArray(triangles)) {
      errors.push('triangles 须为数组');
    } else {
      if (triangles.length > 64) {
        errors.push(`三角形数量须不超过 64，当前为 ${triangles.length}`);
      }
      const seen = new Set();
      for (let k = 0; k < triangles.length; k++) {
        const t = triangles[k];
        const tag = `三角形 #${k}` + (t && t.id !== undefined ? `（id=${t.id}）` : '');
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push(`${tag} 不是对象`);
          continue;
        }
        if (!Number.isInteger(t.id)) {
          errors.push(`${tag} 的 id 须为整数`);
        } else if (seen.has(t.id)) {
          errors.push(`${tag} 的 id 与前面的三角形重复`);
        } else {
          seen.add(t.id);
        }
        if (!Number.isInteger(t.depth)) errors.push(`${tag} 的 depth 须为整数`);
        if (!isNum(t.s)) errors.push(`${tag} 的 s 须为有限数`);
        if (!isRGB(t.rgb)) errors.push(`${tag} 的 rgb 须为 0–1 的线性 RGB 三元组`);
        if (!Array.isArray(t.xy) || t.xy.length !== 3 || !t.xy.every(isPt)) {
          errors.push(`${tag} 的 xy 须为 3 个有效的 [x, y] 顶点`);
        } else if (findRepeatedVertex(t.xy) !== null) {
          errors.push(`${tag} 存在重合顶点，面积须大于 0`);
        } else if (Math.abs(signedArea(t.xy)) <= 1e-12) {
          errors.push(`${tag} 的面积须大于 0（顶点共线或退化）`);
        }
      }
    }

    return errors;
  }

  // 校验并预计算。返回 {errors, prepared}；errors 非空时 prepared 为 null。
  function prepare(scene) {
    const errors = validate(scene);
    if (errors.length) return { errors, prepared: null };

    const pupilCCW = ensureCCW(scene.pupil);
    const pupilArea = Math.abs(signedArea(pupilCCW));
    const tris = scene.triangles.map(t => {
      const xy = ensureCCW(t.xy);
      // 每条边的向量 (ex, ey) 与 cross(e, −a) = −ex·ay + ey·ax。
      const edges = new Float64Array(9);
      for (let k = 0; k < 3; k++) {
        const a = xy[k], b = xy[(k + 1) % 3];
        edges[3 * k] = b[0] - a[0];
        edges[3 * k + 1] = b[1] - a[1];
        edges[3 * k + 2] = -a[1] * b[0] + a[0] * b[1]; // cross(e, −a)
      }
      return { id: t.id, depth: t.depth, s: t.s, rgb: t.rgb.slice(), xy, edges };
    });
    tris.sort((a, b) => a.depth - b.depth || a.id - b.id);

    return {
      errors: [],
      prepared: {
        width: scene.width,
        height: scene.height,
        pupil: scene.pupil,
        pupilCCW,
        pupilArea,
        stop: { offset: scene.stop.offset.slice(), slope: scene.stop.slope.slice() },
        bg: scene.bg.slice(),
        triangles: tris,
        triById: new Map(tris.map(t => [t.id, t])),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 单像素：孔径平面展开
  // -------------------------------------------------------------------------

  // 像素的孔径平面数据。opts: { focusOffset?, stop? }
  // 返回 { qx, qy, D, items, stopPoly, domainArea }。
  // items[i] = { id, depth, planes: [{Ax, Ay, B}], coversAll }
  function pixelSetup(prepared, px, py, opts) {
    opts = opts || {};
    const f = isNum(opts.focusOffset) ? opts.focusOffset : 0;
    const stop = opts.stop && isPt(opts.stop.offset) && isPt(opts.stop.slope)
      ? opts.stop : prepared.stop;

    const qx = px + 0.5, qy = py + 0.5;
    const cx = stop.offset[0] + stop.slope[0] * (qx - prepared.width / 2);
    const cy = stop.offset[1] + stop.slope[1] * (qy - prepared.height / 2);

    // D = 凸孔径 ∩ 光阑矩形
    let D = prepared.pupilCCW;
    D = clipLeq(D, 1, 0, cx + 1);
    if (D.length >= 3) D = clipLeq(D, -1, 0, -(cx - 1));
    if (D.length >= 3) D = clipLeq(D, 0, 1, cy + 1);
    if (D.length >= 3) D = clipLeq(D, 0, -1, -(cy - 1));
    if (D.length < 3) D = [];
    const domainArea = polyArea(D);

    const stopPoly = [[cx - 1, cy - 1], [cx + 1, cy - 1], [cx + 1, cy + 1], [cx - 1, cy + 1]];
    const items = [];
    if (domainArea > 0) {
      const nd = D.length;
      const tris = prepared.triangles;
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        const s = t.s - f;
        const e = t.edges;
        const planes = [];
        let empty = false;
        for (let k = 0; k < 3 && !empty; k++) {
          const ex = e[3 * k], ey = e[3 * k + 1];
          // 条件 s·cross(e, p) ≤ cross(e, q − a) = cross(e, q) + cross(e, −a)
          const Bq = ex * qy - ey * qx + e[3 * k + 2];
          // cross(e, p) 在 D 上的极值（线性函数在顶点取到）。
          let lo = Infinity, hi = -Infinity;
          for (let m = 0; m < nd; m++) {
            const v = ex * D[m][1] - ey * D[m][0];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (s > 0) {
            if (Bq >= s * hi) continue;          // 整个 D 满足 → 该半平面冗余
            if (Bq < s * lo) { empty = true; break; } // 整个 D 违反 → 无可见
            // 除以 s > 0：cross(e, p) ≤ Bq/s。
            planes.push({ Ax: -ey, Ay: ex, B: Bq / s });
          } else if (s < 0) {
            // 除以 s < 0：cross(e, p) ≥ Bq/s，写成 −cross(e, p) ≤ −Bq/s。
            if (Bq >= s * lo) continue;               // 整个 D 满足 → 冗余
            if (Bq < s * hi) { empty = true; break; }  // 整个 D 违反 → 无可见
            planes.push({ Ax: ey, Ay: -ex, B: -Bq / s });
          } else {
            // s = 0：条件退化为 q 是否在 T 内（边界算内）。
            if (Bq < 0) { empty = true; break; }
          }
        }
        if (!empty) items.push({ id: t.id, depth: t.depth, planes });
      }
    }
    return { qx, qy, D, items, stopPoly, domainArea };
  }

  // 对每个 item 计算它实际赢得的凸碎片。
  // collect=true 时同时收集可见多边形。
  function solveVisibility(D, items, collect) {
    const domainArea = polyArea(D);
    const areaTol = REL_AREA_EPS * (domainArea || 1);
    const areas = new Map();
    const visible = collect ? new Map() : null;
    let pieces = D.length >= 3 ? [D] : [];

    for (let it = 0; it < items.length && pieces.length; it++) {
      const planes = items[it].planes;
      const wins = [];
      const next = [];
      const np = planes.length;

      for (let pi = 0; pi < pieces.length; pi++) {
        const piece = pieces[pi];
        // 逐半平面分类：只要一个半平面把整块排除，本片与这块无交。
        let disjoint = false, insideAll = true;
        for (let k = 0; k < np; k++) {
          const pl = planes[k];
          let outsideAll = true;
          for (let m = 0, n = piece.length; m < n; m++) {
            if (pl.Ax * piece[m][0] + pl.Ay * piece[m][1] - pl.B <= 0) {
              outsideAll = false;
              break;
            }
          }
          if (outsideAll) { disjoint = true; break; }
          if (insideAll && !allInside(piece, pl.Ax, pl.Ay, pl.B)) insideAll = false;
        }
        if (disjoint) { next.push(piece); continue; }
        if (insideAll) { wins.push(piece); continue; }

        // 部分重叠：交集归本片，余下部分继续参与更远片判定。
        let inter = piece;
        for (let k = 0; k < np && inter.length >= 3; k++) {
          const pl = planes[k];
          inter = clipLeq(inter, pl.Ax, pl.Ay, pl.B);
        }
        const interArea = polyArea(inter);
        if (interArea <= areaTol) {
          // 只碰到边界或重叠小到数值噪声级：不切分，整块留给更远的片/背景。
          next.push(piece);
          continue;
        }
        wins.push(inter);

        // piece \ inter 的凸碎片：逐个半平面切出“界外”部分。
        let remain = piece;
        for (let k = 0; k < np && remain.length >= 3; k++) {
          const pl = planes[k];
          const outside = clipLeq(remain, -pl.Ax, -pl.Ay, -pl.B);
          if (polyArea(outside) > areaTol) next.push(outside);
          remain = clipLeq(remain, pl.Ax, pl.Ay, pl.B);
        }
      }

      let sum = 0;
      for (let wi = 0; wi < wins.length; wi++) sum += polyArea(wins[wi]);
      if (sum > areaTol) {
        areas.set(items[it].id, (areas.get(items[it].id) || 0) + sum);
        if (collect) {
          const arr = visible.get(items[it].id) || [];
          for (let wi = 0; wi < wins.length; wi++) arr.push(wins[wi]);
          visible.set(items[it].id, arr);
        }
      } else {
        // 数值噪声级胜负区不记，并回剩余碎片（视作背景）。
        for (let wi = 0; wi < wins.length; wi++) next.push(wins[wi]);
      }
      pieces = next;
    }

    let bgArea = 0;
    for (let i = 0; i < pieces.length; i++) bgArea += polyArea(pieces[i]);
    return { areas, bgArea, bgPieces: pieces, visible };
  }

  // 单像素求值：线性 RGB + 各项面积。
  function computePixel(prepared, px, py, opts) {
    const setup = pixelSetup(prepared, px, py, opts);
    const res = solveVisibility(setup.D, setup.items, false);
    const inv = 1 / prepared.pupilArea;
    const rgb = [0, 0, 0];
    for (const [id, area] of res.areas) {
      const t = prepared.triById.get(id);
      const w = area * inv;
      rgb[0] += w * t.rgb[0];
      rgb[1] += w * t.rgb[1];
      rgb[2] += w * t.rgb[2];
    }
    const bgW = res.bgArea * inv;
    rgb[0] += bgW * prepared.bg[0];
    rgb[1] += bgW * prepared.bg[1];
    rgb[2] += bgW * prepared.bg[2];

    return {
      rgb,
      triAreas: res.areas,
      bgArea: res.bgArea,
      blackArea: prepared.pupilArea - setup.domainArea,
      domainArea: setup.domainArea,
      pupilArea: prepared.pupilArea,
      qx: setup.qx,
      qy: setup.qy,
      stopPoly: setup.stopPoly,
    };
  }

  // 单像素求值，面积与占比一起给出，供检查表与导出使用。
  // 占比一律除以原始孔径面积；bg + black + Σtri 占比 = 1。
  function computePixelShares(prepared, px, py, opts) {
    const r = computePixel(prepared, px, py, opts);
    const inv = 1 / r.pupilArea;
    const tri = [];
    let sum = 0;
    for (const [id, area] of r.triAreas) {
      const t = prepared.triById.get(id);
      tri.push({ id, depth: t.depth, sEff: t.s - (opts && isNum(opts.focusOffset) ? opts.focusOffset : 0),
        area, share: area * inv, rgb: t.rgb.slice() });
      sum += area * inv;
    }
    tri.sort((a, b) => a.depth - b.depth || a.id - b.id);
    const bg = { area: r.bgArea, share: r.bgArea * inv };
    const black = { area: r.blackArea, share: r.blackArea * inv };
    const cx = r.stopPoly[0][0] + 1, cy = r.stopPoly[0][1] + 1;
    return {
      x: px, y: py, q: [r.qx, r.qy],
      rgb: r.rgb.slice(),
      tri, bg, black,
      domainArea: r.domainArea,
      pupilArea: r.pupilArea,
      stopCenter: [cx, cy],
      shareSum: sum + bg.share + black.share,
    };
  }

  // 像素的可见区域多边形（点击检查与孔径平面可视化用）。
  function computePixelRegions(prepared, px, py, opts) {
    const setup = pixelSetup(prepared, px, py, opts);
    const res = solveVisibility(setup.D, setup.items, true);
    return {
      pupil: prepared.pupil,
      pupilCCW: prepared.pupilCCW,
      stopPoly: setup.stopPoly,
      domain: setup.D,
      visible: res.visible,
      bgPieces: res.bgPieces,
      triAreas: res.areas,
      bgArea: res.bgArea,
      blackArea: prepared.pupilArea - setup.domainArea,
      domainArea: setup.domainArea,
      pupilArea: prepared.pupilArea,
      qx: setup.qx,
      qy: setup.qy,
    };
  }

  return {
    validate,
    prepare,
    computePixel,
    computePixelShares,
    computePixelRegions,
    signedArea,
    polyArea,
    ensureCCW,
    pointInTri,
  };
});
