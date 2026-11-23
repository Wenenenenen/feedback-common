/*
 * 正交/世界射线与周期双线性高度场求交。
 *
 * 方法：不用按固定步长推进（浅槽掠射时一步会跨过同一格内的两次穿越），
 * 而是用精确 DDA 枚举射线 XY 投影经过的每一个格子，格内把射线代入
 * 双线性曲面得到关于 t 的二次方程，解析求全部根：
 *   切触（判别式≈0 的二重根）同样计入；
 *   格边格角按世界格坐标的半开归属 floor(x/sx)、floor(y/sy) 决定法线，
 *   同一次命中（t 相同）只记录一次。
 * 方向 D 全程保留原长度，不做归一化。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./math.js'), require('./field.js'));
  } else {
    global.ReliefRay = factory(global.ReliefMath, global.ReliefField);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (M, ReliefField) {
  'use strict';

  const T_EPS = 1e-10;      // t 相等判定的相对容差
  const UV_EPS = 2e-7;      // u/v 贴边判定：容忍 DDA 浮点漂移（如 (1/4)*4），又远小于真实出界
  const MAX_ITER = 1_000_000;

  function vec3(a) {
    return [a[0], a[1], a[2]];
  }

  // 把格内参数吸附到 [0,1]，返回吸附后的 u/v 与贴边标志
  function snapUV(u, v) {
    let su = u, sv = v;
    let onX = false, onY = false;
    if (Math.abs(su) <= UV_EPS) { su = 0; onX = true; }
    else if (Math.abs(su - 1) <= UV_EPS) { su = 1; onX = true; }
    if (Math.abs(sv) <= UV_EPS) { sv = 0; onY = true; }
    else if (Math.abs(sv - 1) <= UV_EPS) { sv = 1; onY = true; }
    return { u: su, v: sv, onX, onY };
  }

  // 世界点按半开区间归属到格坐标：格 [cx*sx, (cx+1)*sx)
  function ownerCell(x, y, sx, sy) {
    return [Math.floor(x / sx), Math.floor(y / sy)];
  }

  function sameT(t1, t2) {
    return Math.abs(t1 - t2) <= T_EPS * Math.max(1, Math.abs(t1), Math.abs(t2));
  }

  /*
   * 求一条射线的首个交点。
   * 参数 O=[ox,oy,oz]、D=[dx,dy,dz]（保留原长度）、闭区间 [tmin,tmax]。
   * 返回完整 trace：遍历过的格、每格的根、去重后的命中、首命中与选中原因。
   */
  function traceRay(field, O, D, tmin, tmax) {
    const sx = field.sx, sy = field.sy;
    const trace = {
      ray: { o: vec3(O), d: vec3(D), t: [tmin, tmax] },
      cells: [],
      candidates: [],
      hits: [],
      hit: null,
      missReason: null,
      iterations: 0,
    };

    if (![...O, ...D].every(Number.isFinite) ||
      !Number.isFinite(tmin) || !Number.isFinite(tmax)) {
      trace.missReason = '射线参数含非有限数值';
      return trace;
    }
    if (tmax < tmin) {
      trace.missReason = 't 区间为空（tmax < tmin）';
      return trace;
    }

    const ox = O[0], oy = O[1], oz = O[2];
    const dx = D[0], dy = D[1], dz = D[2];
    const tScale = Math.max(1, Math.abs(tmin), Math.abs(tmax));

    // 起点（t=tmin）所在格——半开归属，落在格边上天然取编号较小的格。
    // 世界格坐标保持原样（可为负、可超出周期），节点回绕在 HeightField 内完成。
    const px = ox + tmin * dx;
    const py = oy + tmin * dy;
    let cx = Math.floor(px / sx);
    let cy = Math.floor(py / sy);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      trace.missReason = 'XY 投影退化且起点不在有限格内';
      return trace;
    }

    // 到下一条 x/y 格线的参数 t
    function nextCrossX(cellX) {
      if (dx === 0) return Infinity;
      const line = dx > 0 ? (cellX + 1) * sx : cellX * sx;
      return (line - ox) / dx;
    }
    function nextCrossY(cellY) {
      if (dy === 0) return Infinity;
      const line = dy > 0 ? (cellY + 1) * sy : cellY * sy;
      return (line - oy) / dy;
    }

    let tNX = nextCrossX(cx);
    let tNY = nextCrossY(cy);
    let tCur = tmin;
    let anyDiscriminantNegative = false;
    let stopped = false;

    while (!stopped) {
      if (++trace.iterations > MAX_ITER) {
        trace.missReason = '遍历格数超过上限（射线区间过长？）';
        return trace;
      }

      // 本格与射线的参数重叠区间（闭区间，格线时刻由相邻格半开归属）
      const tLeave = Math.min(tmax, tNX, tNY);
      const cellRec = {
        cx, cy,
        nodeI: M.mod(cx, field.nx - 1),
        nodeJ: M.mod(cy, field.ny - 1),
        tEnter: tCur,
        tLeave,
        roots: [],
      };

      const x0 = cx * sx, y0 = cy * sy;
      const u0 = (ox - x0) / sx, du = dx / sx;
      const v0 = (oy - y0) / sy, dv = dy / sy;
      const cf = field.cellCoeffs(cx, cy);

      // h(u(t),v(t)) - z(t) = A t^2 + B t + C = 0，其中 z(t)=oz+dz*t。
      // 展开 d*u(t)*v(t)：d*u0*v0 归入 C，t 项 d*(du*v0+u0*dv) 归入 B，
      // t^2 项 d*du*dv 归入 A——切勿把 u0*v0 混进 B。
      const A = cf.d * du * dv;
      const B = cf.b * du + cf.c * dv + cf.d * (du * v0 + u0 * dv) - dz;
      const C = cf.a + cf.b * u0 + cf.c * v0 + cf.d * u0 * v0 - oz;

      const sol = M.solveQuadratic(A, B, C);
      cellRec.quadratic = {
        A, B, C,
        discriminant: B * B - 4 * A * C,
        tangent: sol.tangent,
        degenerate: sol.degenerate,
      };
      if (sol.roots.length === 0 && !sol.degenerate) anyDiscriminantNegative = true;

      for (const t of sol.roots) {
        const rootRec = { t, tangent: sol.tangent, status: 'rejected', reason: null };

        if (t < tmin - T_EPS * tScale || t > tmax + T_EPS * tScale) {
          rootRec.reason = '根在闭合 t 区间之外';
          cellRec.roots.push(rootRec);
          continue;
        }
        const tc = Math.max(tmin, Math.min(tmax, t));
        const uRaw = u0 + du * tc;
        const vRaw = v0 + dv * tc;

        if (uRaw < -UV_EPS || uRaw > 1 + UV_EPS || vRaw < -UV_EPS || vRaw > 1 + UV_EPS) {
          rootRec.reason = '根在本格 u/v 范围之外（属于相邻格的记录）';
          cellRec.roots.push(rootRec);
          continue;
        }

        const sn = snapUV(uRaw, vRaw);
        const hx = x0 + sn.u * sx;
        const hy = y0 + sn.v * sy;
        const [ownX, ownY] = ownerCell(hx, hy, sx, sy);
        const hz = oz + tc * dz;

        rootRec.u = sn.u;
        rootRec.v = sn.v;
        rootRec.point = [hx, hy, hz];
        rootRec.owner = [ownX, ownY];

        // 半开归属：格边/格角上的点归编号较大的相邻格，当前格只留重复记录
        if (ownX !== cx || ownY !== cy) {
          rootRec.reason = `格边/格角点，半开归属到格 (${ownX}, ${ownY})，本格不重复计命中`;
          cellRec.roots.push(rootRec);
          continue;
        }

        const hh = field.cellHeights(ownX, ownY);
        const normal = M.gradientNormal(hh.h00, hh.h10, hh.h01, hh.h11, sn.u, sn.v, sx, sy);
        const kind = sn.onX && sn.onY ? '格角' : sn.onX || sn.onY ? '格边' : '格内';
        rootRec.status = 'accepted';
        rootRec.reason = sol.tangent
          ? `${kind}切触（判别式≈0 的二重根），闭区间内有效，取为候选`
          : `${kind}有效根，闭区间内，取为候选`;
        rootRec.normal = normal;
        cellRec.roots.push(rootRec);

        trace.candidates.push({
          t: tc,
          point: [hx, hy, hz],
          cell: [ownX, ownY],
          nodeCell: [M.mod(ownX, field.nx - 1), M.mod(ownY, field.ny - 1)],
          u: sn.u,
          v: sn.v,
          normal,
          tangent: sol.tangent,
          kind,
          sourceCell: [cx, cy],
        });
      }

      trace.cells.push(cellRec);

      if (tLeave >= tmax - T_EPS * tScale) { stopped = true; break; }

      // 推进：x、y 同时到线则同时跨格（格角穿越）
      const crossX = tNX <= tNY + T_EPS * tScale && tNX <= tLeave + T_EPS * tScale && isFinite(tNX);
      const crossY = tNY <= tNX + T_EPS * tScale && tNY <= tLeave + T_EPS * tScale && isFinite(tNY);
      const advX = crossX && tNX > tCur + T_EPS * tScale;
      const advY = crossY && tNY > tCur + T_EPS * tScale;
      if (!advX && !advY) {
        // 数值卡住时按符号强推一格，避免死循环
        if (dx > 0) { cx += 1; tNX = nextCrossX(cx); }
        else if (dx < 0) { cx -= 1; tNX = nextCrossX(cx); }
        if (dy > 0) { cy += 1; tNY = nextCrossY(cy); }
        else if (dy < 0) { cy -= 1; tNY = nextCrossY(cy); }
        tCur = Math.max(tCur, tLeave);
      } else {
        if (advX) { cx += dx > 0 ? 1 : -1; tNX = nextCrossX(cx); }
        if (advY) { cy += dy > 0 ? 1 : -1; tNY = nextCrossY(cy); }
        tCur = tLeave;
      }
    }

    // 同一命中只记一次：按 t 聚合（不同格在共享格线上解出的根 t 相同）
    trace.candidates.sort((a, b) => a.t - b.t);
    for (const cand of trace.candidates) {
      const last = trace.hits[trace.hits.length - 1];
      if (last && sameT(last.t, cand.t)) {
        last.duplicates.push({ cell: cand.sourceCell, kind: cand.kind });
        continue;
      }
      trace.hits.push({
        t: cand.t,
        point: cand.point,
        cell: cand.cell,
        nodeCell: cand.nodeCell,
        u: cand.u,
        v: cand.v,
        normal: cand.normal,
        tangent: cand.tangent,
        kind: cand.kind,
        selectedReason: cand.tangent
          ? `切触二重根，t=${round(cand.t)} 为闭区间内首个有效命中`
          : `按 t 排序后的首个有效根（t=${round(cand.t)}，${cand.kind}命中）`,
        duplicates: [],
      });
    }

    if (trace.hits.length) {
      trace.hit = trace.hits[0];
    } else if (anyDiscriminantNegative) {
      trace.missReason = '经过的格内二次方程均无实根（射线未穿越曲面）';
    } else {
      trace.missReason = '闭 t 区间内没有落在格内的有效根';
    }
    return trace;
  }

  function round(x, digits = 6) {
    const p = 10 ** digits;
    return Math.round(x * p) / p;
  }

  /*
   * 自阴影：从命中点沿灯方向 Dlight（保留原长度）投一条有限射线，
   * 区间 [tmin, tmax]（默认起点 1e-5 偏移避免自交）。
   * 任何有效命中 => 处于阴影。
   */
  function shadowRay(field, hitPoint, Dlight, tmin, tmax) {
    const lo = tmin === undefined ? 1e-5 : tmin;
    const hi = tmax === undefined ? 5 : tmax;
    const tr = traceRay(field, hitPoint, Dlight, lo, hi);
    return {
      shadowed: tr.hit !== null,
      blocker: tr.hit,
      trace: tr,
      interval: [lo, hi],
    };
  }

  return { traceRay, shadowRay, ownerCell, snapUV, sameT };
});
