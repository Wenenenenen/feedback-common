/*
 * engine.js — 精确有理 B 样条引擎（无第三方样条库）。
 *
 * 曲线模型：
 *   degree p
 *   knots  U_0..U_{N+p}（N 个齐次控制点，节点数 N+p+1），非降、夹持
 *   points P_i = {X,Y,W}（齐次坐标；投影 (X/W, Y/W)）
 *
 * 所有相等性判定均使用 Frac 的 bigint 精确比较，不使用浮点容差。
 */
(function () {
  'use strict';

  let FracNS;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    FracNS = require('./frac.js');
  } else {
    FracNS = globalThis.RKS;
  }
  const { Frac } = FracNS;
  const ZERO = () => new Frac(0n, 1n);
  const ONE = () => new Frac(1n, 1n);
  const INT_MAX_CP = 512;

  function fail(error) { return { ok: false, error: String(error) }; }
  function ok(curve) { return { ok: true, curve }; }

  /* ------------------------------------------------------------------ */
  /* 解析 / 序列化 / 校验                                                */
  /* ------------------------------------------------------------------ */

  function parseFracStrict(v, what, errors) {
    try {
      return Frac.parse(v);
    } catch (e) {
      errors.push(what + ' 不是合法整数/分数: ' + JSON.stringify(v));
      return null;
    }
  }

  /** 把任意 JSON 输入解析成内部曲线；返回 {ok, curve, errors}。 */
  function parseCurveObject(obj) {
    const errors = [];
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); }
      catch (e) { return { ok: false, errors: ['JSON 解析失败: ' + e.message] }; }
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, errors: ['根节点必须是对象'] };
    }
    const p = Number(obj.degree);
    if (!Number.isInteger(p) || p < 0 || p > 20) {
      errors.push('degree 必须是 0..20 的整数（题目范围为 2..5）');
    }

    const rawPts = obj.points;
    if (!Array.isArray(rawPts) || rawPts.length === 0) {
      errors.push('points 必须是非空数组');
      return { ok: false, errors };
    }
    if (rawPts.length > INT_MAX_CP) {
      errors.push('控制点最多 ' + INT_MAX_CP + ' 个，当前 ' + rawPts.length + ' 个');
    }
    const points = [];
    rawPts.forEach((rp, i) => {
      if (!Array.isArray(rp) || rp.length < 3) {
        errors.push('points[' + i + '] 必须是 [X,Y,W] 三元组');
        return;
      }
      const X = parseFracStrict(rp[0], 'points[' + i + '][0]', errors);
      const Y = parseFracStrict(rp[1], 'points[' + i + '][1]', errors);
      const W = parseFracStrict(rp[2], 'points[' + i + '][2]', errors);
      if (X && Y && W) {
        if (W.isZero()) errors.push('points[' + i + '] 的权重 W 不能为 0（投影 X/W 无定义）');
        points.push({ X, Y, W });
      }
    });

    const rawKnots = obj.knots;
    if (!Array.isArray(rawKnots)) {
      errors.push('knots 必须是数组');
      return { ok: false, errors };
    }
    const knots = [];
    rawKnots.forEach((rk, i) => {
      const t = parseFracStrict(rk, 'knots[' + i + ']', errors);
      if (t) knots.push(t);
    });

    if (errors.length) return { ok: false, errors };

    const N = points.length;
    if (Number.isInteger(p)) {
      const needKnots = N + p + 1;
      if (knots.length !== needKnots) {
        errors.push('节点数应为 控制点数+p+1 = ' + needKnots + '，实际 ' + knots.length);
      }
      for (let i = 1; i < knots.length; i++) {
        if (knots[i].lt(knots[i - 1])) {
          errors.push('knots 必须非降，knots[' + (i - 1) + '] > knots[' + i + ']');
          break;
        }
      }
      if (knots.length === needKnots && p >= 0 && N > 0) {
        if (N < p + 1) {
          errors.push('夹持 ' + p + ' 次曲线至少需要 ' + (p + 1) + ' 个控制点');
        } else {
          const a = knots[0];
          const b = knots[knots.length - 1];
          for (let i = 0; i <= p && i < knots.length; i++) {
            if (!knots[i].eq(a)) errors.push('左端必须重复 ' + (p + 1) + ' 次（夹持）');
          }
          for (let i = knots.length - p - 1; i < knots.length; i++) {
            if (i >= 0 && !knots[i].eq(b)) errors.push('右端必须重复 ' + (p + 1) + ' 次（夹持）');
          }
          if (!a.lt(b)) errors.push('参数域必须非退化：首节点 < 末节点');
          // 内部重数 <= p
          for (let i = p + 1; i <= N - 1; ) {
            let j = i;
            while (j + 1 <= N - 1 && knots[j + 1].eq(knots[i])) j++;
            const mult = j - i + 1;
            if (mult > p) {
              errors.push('内部节点 ' + knots[i].toString() + ' 重数 ' + mult + ' 超过次数 p=' + p);
            }
            i = j + 1;
          }
        }
      }
    }

    if (errors.length) return { ok: false, errors };
    return { ok: true, curve: { degree: p, knots, points } };
  }

  /** 导出为题目约定的普通对象（所有分数均已约分、分母为正）。 */
  function curveToObject(curve, formatText) {
    const obj = {
      degree: curve.degree,
      knots: curve.knots.map((k) => k.toString()),
      points: curve.points.map((pt) => [pt.X.toString(), pt.Y.toString(), pt.W.toString()]),
    };
    if (formatText) obj.format = formatText;
    return obj;
  }

  function cloneCurve(c) {
    return {
      degree: c.degree,
      knots: c.knots.map((k) => new Frac(k.n, k.d)),
      points: c.points.map((pt) => ({
        X: new Frac(pt.X.n, pt.X.d),
        Y: new Frac(pt.Y.n, pt.Y.d),
        W: new Frac(pt.W.n, pt.W.d),
      })),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 区间定位与单侧 Cox–de Boor 基函数                                    */
  /* ------------------------------------------------------------------ */

  function domain(c) {
    return { a: c.knots[0], b: c.knots[c.knots.length - 1] };
  }

  /**
   * 找到求值区间下标 k：
   *   side='right'（默认）: U_k <= u < U_{k+1}；右端点 u=b 按题面取左极限，返回 N-1。
   *   side='left'         : U_k < u <= U_{k+1}。
   * 返回的 k 即 Cox 递推的活动区间，p 次活动基为 N_{k-p}..N_k。
   */
  function findSpan(c, u, side) {
    const U = c.knots;
    const N = c.points.length;
    const last = U.length - 1;
    if (side === 'left') {
      // 最大的满足 U[k] < u 的 k
      let k = -1;
      for (let i = 0; i < U.length; i++) {
        if (U[i].lt(u)) k = i;
        else break;
      }
      // u==b 时 k 为末端重复块前一位；保证 k+1 合法
      if (k < 0) k = 0;
      if (k > last - 1) k = last - 1;
      return k;
    }
    if (u.eq(U[last])) return N - 1; // 右端点左极限约定
    let k = -1;
    for (let i = 0; i < U.length - 1; i++) {
      if (U[i].lte(u) && u.lt(U[i + 1])) { k = i; break; }
    }
    if (k < 0) {
      // 退化为线性扫描兜底（理论上不会发生）
      for (let i = 0; i < U.length - 1; i++) if (U[i].lte(u)) k = i;
    }
    if (k > last - 1) k = last - 1;
    return k;
  }

  /**
   * 单侧 B 样条基 N_{i,q}(u)，精确 Frac。
   * side 决定 q=0 指示函数的端点归属：
   *   right -> [U_i,U_{i+1})
   *   left  -> (U_i,U_{i+1}]
   * 零分母项按题面取 0。
   */
  function basisValue(U, i, q, u, side, memo) {
    const key = i + ',' + q;
    if (memo && memo.has(key)) return memo.get(key);
    let v;
    if (q === 0) {
      let inside;
      if (side === 'left') inside = U[i].lt(u) && u.lte(U[i + 1]);
      else inside = U[i].lte(u) && u.lt(U[i + 1]);
      v = inside ? ONE() : ZERO();
    } else {
      v = ZERO();
      const d1 = U[i + q].sub(U[i]);
      if (!d1.isZero()) {
        const a = u.sub(U[i]).div(d1);
        if (!a.isZero()) v = v.add(a.mul(basisValue(U, i, q - 1, u, side, memo)));
      }
      const d2 = U[i + q + 1].sub(U[i + 1]);
      if (!d2.isZero()) {
        const b = U[i + q + 1].sub(u).div(d2);
        if (!b.isZero()) v = v.add(b.mul(basisValue(U, i + 1, q - 1, u, side, memo)));
      }
    }
    if (memo) memo.set(key, v);
    return v;
  }

  /** 求齐次点 H(u)=(Σ N_i X_i, Σ N_i Y_i, Σ N_i W_i)，指定单侧约定。 */
  function evalHomogeneousSide(c, u, side) {
    const p = c.degree;
    const N = c.points.length;
    const U = c.knots;
    const k = findSpan(c, u, side);
    const lo = Math.max(0, k - p);
    const hi = Math.min(N - 1, k);
    const memo = new Map();
    let X = ZERO(), Y = ZERO(), W = ZERO();
    for (let i = lo; i <= hi; i++) {
      const b = basisValue(U, i, p, u, side, memo);
      if (b.isZero()) continue;
      const pt = c.points[i];
      X = X.add(b.mul(pt.X));
      Y = Y.add(b.mul(pt.Y));
      W = W.add(b.mul(pt.W));
    }
    return { X, Y, W };
  }

  /**
   * 齐次曲线对原参数的单侧导数 H'(u)。
   * H'(u) = p Σ_{j=1}^{N-1} (P_j-P_{j-1}) / (U_{j+p}-U_j) * N_{j,p-1}(u)
   * 分母为 0 的项取 0。
   */
  function evalHomogeneousDerivativeSide(c, u, side) {
    const p = c.degree;
    const N = c.points.length;
    const U = c.knots;
    const memo = new Map();
    let dX = ZERO(), dY = ZERO(), dW = ZERO();
    if (p === 0) return { X: dX, Y: dY, W: dW };
    for (let j = 1; j < N; j++) {
      const den = U[j + p].sub(U[j]);
      if (den.isZero()) continue;
      const b = basisValue(U, j, p - 1, u, side, memo);
      if (b.isZero()) continue;
      const coef = new Frac(BigInt(p), 1n).div(den).mul(b);
      const p1 = c.points[j];
      const p0 = c.points[j - 1];
      dX = dX.add(coef.mul(p1.X.sub(p0.X)));
      dY = dY.add(coef.mul(p1.Y.sub(p0.Y)));
      dW = dW.add(coef.mul(p1.W.sub(p0.W)));
    }
    return { X: dX, Y: dY, W: dW };
  }

  function projectHomogeneous(H) {
    if (H.W.isZero()) return null;
    return { x: H.X.div(H.W), y: H.Y.div(H.W) };
  }

  function projectedDerivative(H, dH) {
    if (H.W.isZero()) return null;
    // x' = (X' W - X W') / W^2
    const w2 = H.W.mul(H.W);
    return {
      x: dH.X.mul(H.W).sub(H.X.mul(dH.W)).div(w2),
      y: dH.Y.mul(H.W).sub(H.Y.mul(dH.W)).div(w2),
    };
  }

  /** 只求精确投影点（不计算导数），供批量导出端点使用。 */
  function projectedPointExact(c, u) {
    if (!(u instanceof Frac)) u = Frac.parse(u);
    const atEnd = u.eq(c.knots[c.knots.length - 1]);
    const H = evalHomogeneousSide(c, u, atEnd ? 'left' : 'right');
    return projectHomogeneous(H);
  }

  /**
   * 指定参数处的精确坐标与左右导数。
   * 内部参数：u 可为 Frac 或可解析字符串。
   * 返回结构化结果；端点只给存在的一侧。
   */
  function queryAt(c, uInput) {
    let u;
    try { u = uInput instanceof Frac ? uInput : Frac.parse(uInput); }
    catch (e) { return { ok: false, error: e.message }; }
    const { a, b } = domain(c);
    if (u.lt(a) || u.gt(b)) {
      return { ok: false, error: '参数 u=' + u.toString() + ' 超出参数域 [' + a + ', ' + b + ']' };
    }
    const atStart = u.eq(a);
    const atEnd = u.eq(b);

    // 坐标按题面约定：右端点取左极限，其余用通常的右闭半开约定。
    const pointSide = atEnd ? 'left' : 'right';
    const H = evalHomogeneousSide(c, u, pointSide);
    const proj = projectHomogeneous(H);
    if (!proj) return { ok: false, error: 'u=' + u.toString() + ' 处齐次权重和 W(u)=0，投影坐标无定义' };

    const result = {
      ok: true,
      u,
      atStart,
      atEnd,
      point: { x: proj.x, y: proj.y, X: H.X, Y: H.Y, W: H.W },
      left: null,
      right: null,
    };

    if (!atStart) {
      const HL = evalHomogeneousSide(c, u, 'left');
      const dHL = evalHomogeneousDerivativeSide(c, u, 'left');
      const dp = projectedDerivative(HL, dHL);
      if (dp) result.left = { dx: dp.x, dy: dp.y, h: dHL, H: HL };
    }
    if (!atEnd) {
      const HR = evalHomogeneousSide(c, u, 'right');
      const dHR = evalHomogeneousDerivativeSide(c, u, 'right');
      const dp = projectedDerivative(HR, dHR);
      if (dp) result.right = { dx: dp.x, dy: dp.y, h: dHR, H: HR };
    }
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 节点插入（Boehm，精确）                                              */
  /* ------------------------------------------------------------------ */

  function knotMultiplicity(c, u) {
    let m = 0;
    for (const k of c.knots) if (k.eq(u)) m++;
    return m;
  }

  /**
   * 插入一个内部节点（每次只加一个）。
   * 精确有理运算保证齐次曲线完全不变。
   */
  function insertKnot(c, uInput) {
    let u;
    try { u = uInput instanceof Frac ? uInput : Frac.parse(uInput); }
    catch (e) { return fail('节点值无法解析: ' + e.message); }

    const { a, b } = domain(c);
    if (!u.gt(a) || !u.lt(b)) {
      return fail('只能插入严格位于参数域 (' + a + ', ' + b + ') 内的内部节点');
    }
    const N = c.points.length;
    if (N >= INT_MAX_CP) {
      return fail('控制点已达上限 ' + INT_MAX_CP + '，不能再插入节点');
    }
    const mult = knotMultiplicity(c, u);
    if (mult + 1 > c.degree) {
      return fail('插入后内部节点 ' + u.toString() + ' 重数将为 ' + (mult + 1) +
        '，超过次数 p=' + c.degree);
    }

    const k = findSpan(c, u, 'right');
    const p = c.degree;
    if (k < p || k >= c.knots.length - 1) {
      return fail('内部错误：插入区间下标 k=' + k + ' 非法');
    }

    const U = c.knots;
    const newKnots = U.slice(0, k + 1).concat([u]).concat(U.slice(k + 1));
    const Q = new Array(N + 1);

    for (let i = 0; i <= k - p; i++) Q[i] = clonePoint(c.points[i]);

    for (let i = k - p + 1; i <= k; i++) {
      const den = U[i + p].sub(U[i]);
      if (den.isZero()) return fail('插入失败：Boehm 系数分母为 0（下标 ' + i + '）');
      const alpha = u.sub(U[i]).div(den);
      const pi = c.points[i];
      const pm = c.points[i - 1];
      Q[i] = {
        X: alpha.mul(pi.X).add(ONE().sub(alpha).mul(pm.X)),
        Y: alpha.mul(pi.Y).add(ONE().sub(alpha).mul(pm.Y)),
        W: alpha.mul(pi.W).add(ONE().sub(alpha).mul(pm.W)),
      };
    }
    for (let i = k + 1; i <= N; i++) Q[i] = clonePoint(c.points[i - 1]);

    return ok({ degree: p, knots: newKnots, points: Q });
  }

  function clonePoint(pt) {
    return { X: new Frac(pt.X.n, pt.X.d), Y: new Frac(pt.Y.n, pt.Y.d), W: new Frac(pt.W.n, pt.W.d) };
  }

  /* ------------------------------------------------------------------ */
  /* 节点删除（逆 Boehm 构造候选 + 重插精确校验 + 正权重）                 */
  /* ------------------------------------------------------------------ */

  /** 可删除的内部节点“出现位置”下标范围 [p+1, N-1]（含端点）。 */
  function interiorOccurrenceRange(c) {
    const N = c.points.length;
    const p = c.degree;
    return { first: p + 1, last: N - 1 };
  }

  function homogeneousPointsEqual(a, b) {
    return a.X.eq(b.X) && a.Y.eq(b.Y) && a.W.eq(b.W);
  }

  /**
   * 尝试删除 knots[r] 这一次出现。
   * 成功条件（严格按题意）：
   *   1) 候选曲线所有权重 > 0；
   *   2) 把同一节点重插回候选曲线后，每个齐次控制点与当前曲线精确相等，
   *      且节点向量精确复原。
   * 任一不满足都返回失败，调用方不得改原曲线。
   */
  function removeKnotAt(c, r) {
    const N = c.points.length;
    const p = c.degree;
    const { first, last } = interiorOccurrenceRange(c);
    if (!Number.isInteger(r) || r < first || r > last) {
      return fail('删除下标 r=' + r + ' 不是内部节点出现位置（允许 ' + first + '..' + last + '）');
    }
    if (N <= p + 1) {
      return fail('控制点数量已是该次数的下限，无内部节点可删');
    }
    const u = c.knots[r];

    // 构造 U'：删去第 r 个节点
    const Uold = c.knots;
    const Unew = Uold.slice(0, r).concat(Uold.slice(r + 1));
    const candidate = { degree: p, knots: Unew, points: new Array(N - 1).fill(null) };

    // 重插位置 k（在 U' 中）
    const k = findSpan(candidate, u, 'right');
    if (!(k >= p && k <= N - 1)) {
      return fail('节点 ' + u.toString() + ' 不可删除（重插位置非法）');
    }

    const P = c.points;
    const C = candidate.points;
    // 左侧锚点：i <= k-p 时 C_i = P_i
    for (let i = 0; i <= k - p && i < N - 1; i++) C[i] = clonePoint(P[i]);
    // 右侧锚点：i >= k+1 时 Q_i = C_{i-1} = P_i  => C_j = P_{j+1}, j >= k
    for (let j = k; j <= N - 2; j++) C[j] = clonePoint(P[j + 1]);

    const alphaAt = (i) => {
      const den = Unew[i + p].sub(Unew[i]);
      if (den.isZero()) return null;
      return u.sub(Unew[i]).div(den);
    };

    // 左扫描：Q_i = alpha_i C_i + (1-alpha_i) C_{i-1}
    for (let i = k - p + 1; i <= k; i++) {
      if (i < 0 || i > N - 1) continue;
      if (C[i] || !C[i - 1]) continue;
      const alpha = alphaAt(i);
      if (alpha === null || alpha.isZero()) continue; // alpha=0 时该式不含 C_i
      // C_i = (P_i - (1-alpha) C_{i-1}) / alpha
      C[i] = {
        X: P[i].X.sub(ONE().sub(alpha).mul(C[i - 1].X)).div(alpha),
        Y: P[i].Y.sub(ONE().sub(alpha).mul(C[i - 1].Y)).div(alpha),
        W: P[i].W.sub(ONE().sub(alpha).mul(C[i - 1].W)).div(alpha),
      };
    }
    // 右扫描：由 C_i 反解 C_{i-1}
    for (let i = k; i >= k - p + 1; i--) {
      if (i < 1 || i > N - 1) continue;
      if (C[i - 1] || !C[i]) continue;
      const alpha = alphaAt(i);
      if (alpha === null) continue;
      const beta = ONE().sub(alpha);
      if (beta.isZero()) continue; // alpha=1 时该式不含 C_{i-1}
      C[i - 1] = {
        X: P[i].X.sub(alpha.mul(C[i].X)).div(beta),
        Y: P[i].Y.sub(alpha.mul(C[i].Y)).div(beta),
        W: P[i].W.sub(alpha.mul(C[i].W)).div(beta),
      };
    }

    if (C.some((pt) => pt === null)) {
      return fail('节点 ' + u.toString() + ' 不满足精确可约简条件（候选控制点不唯一/缺失），删除被拒绝');
    }

    // 正权重硬条件
    const badW = C.findIndex((pt) => pt.W.sign() <= 0);
    if (badW >= 0) {
      return fail('删除被拒绝：减点后第 ' + badW + ' 个控制点权重为 ' +
        C[badW].W.toString() + '，不满足权重为正');
    }

    // 决定性校验：把 u 重插回候选曲线，必须逐点完全相等
    const re = insertKnot(candidate, u);
    if (!re.ok) return fail('删除被拒绝：重插校验失败（' + re.error + '）');
    const restored = re.curve;

    if (restored.knots.length !== Uold.length ||
        !restored.knots.every((kk, i) => kk.eq(Uold[i]))) {
      return fail('删除被拒绝：重插后节点向量未精确复原');
    }
    if (restored.points.length !== P.length) {
      return fail('删除被拒绝：重插后控制点数不一致');
    }
    for (let i = 0; i < P.length; i++) {
      if (!homogeneousPointsEqual(restored.points[i], P[i])) {
        return fail('删除被拒绝：重插后第 ' + i + ' 个齐次控制点不完全相等' +
          '（说明形状已不允许消去该节点）');
      }
    }
    return ok(candidate);
  }

  /* ------------------------------------------------------------------ */
  /* 控制点编辑（投影移点保 W；改权重保投影位置）                           */
  /* ------------------------------------------------------------------ */

  /** 以投影坐标 (x,y) 移动第 i 点，保留 W：X=xW, Y=yW。 */
  function moveProjectedPoint(c, i, xInput, yInput) {
    if (!Number.isInteger(i) || i < 0 || i >= c.points.length) return fail('控制点下标非法: ' + i);
    let x, y;
    try { x = Frac.parse(xInput); y = Frac.parse(yInput); }
    catch (e) { return fail('坐标无法解析: ' + e.message); }
    const next = cloneCurve(c);
    const W = next.points[i].W;
    next.points[i].X = x.mul(W);
    next.points[i].Y = y.mul(W);
    return ok(next);
  }

  /**
   * 修改第 i 点权重为 w，并保持其投影坐标不变：
   *   x=X_old/W_old, y=Y_old/W_old  => X_new=x*w, Y_new=y*w。
   * 允许任意非 0 权重（题目仅要求“减点后”权重为正）；w=0 无投影定义，拒绝。
   */
  function setWeight(c, i, wInput) {
    if (!Number.isInteger(i) || i < 0 || i >= c.points.length) return fail('控制点下标非法: ' + i);
    let w;
    try { w = Frac.parse(wInput); }
    catch (e) { return fail('权重无法解析: ' + e.message); }
    if (w.isZero()) return fail('权重不能为 0（投影 X/W 无定义）');
    const old = c.points[i];
    if (old.W.isZero()) return fail('原权重为 0，无法保持投影坐标');
    const x = old.X.div(old.W);
    const y = old.Y.div(old.W);
    const next = cloneCurve(c);
    next.points[i].W = w;
    next.points[i].X = x.mul(w);
    next.points[i].Y = y.mul(w);
    return ok(next);
  }

  /** 直接设置齐次坐标（高级 API/测试用）。 */
  function setHomogeneousPoint(c, i, Xv, Yv, Wv) {
    if (!Number.isInteger(i) || i < 0 || i >= c.points.length) return fail('控制点下标非法: ' + i);
    let X, Y, W;
    try { X = Frac.parse(Xv); Y = Frac.parse(Yv); W = Frac.parse(Wv); }
    catch (e) { return fail('齐次坐标无法解析: ' + e.message); }
    if (W.isZero()) return fail('权重不能为 0');
    const next = cloneCurve(c);
    next.points[i] = { X, Y, W };
    return ok(next);
  }

  /* ------------------------------------------------------------------ */
  /* 浮点求值（仅用于绘制与自适应细分，不参与任何精确判定）                 */
  /* ------------------------------------------------------------------ */

  function floatKnots(c) { return c.knots.map((k) => k.toNumber()); }

  function findSpanFloat(U, p, N, u) {
    if (u >= U[U.length - 1]) return N - 1;
    if (u <= U[0]) return p;
    // 二分最大 k 使 U[k] <= u < U[k+1]
    let lo = 0, hi = U.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (U[mid] <= u) lo = mid; else hi = mid;
    }
    let k = lo;
    if (k > N - 1) k = N - 1;
    if (k < p) k = p;
    return k;
  }

  /** 浮点 Cox 基，返回下标 k-p..k 的 p+1 个基值（与 findSpanFloat 配套）。 */
  function basisFloat(U, p, k, u) {
    const N = new Array(p + 1).fill(0); // N[r] 对应实际下标 k-p+r
    N[0] = 1;
    const left = new Array(p + 1).fill(0);
    const right = new Array(p + 1).fill(0);
    for (let j = 1; j <= p; j++) {
      left[j] = u - U[k + 1 - j];
      right[j] = U[k + j] - u;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        let temp = 0;
        const den = U[k + r + 1] - U[k + r - j + 1];
        if (den !== 0) temp = N[r] / den;
        N[r] = saved + right[r + 1] * temp;
        saved = left[j - r] * temp;
      }
      N[j] = saved;
    }
    return N;
  }

  /** 浮点投影点 [x,y]；W 异常时返回 null。 */
  function evalPointFloat(c, Uf, u) {
    const p = c.degree;
    const N = c.points.length;
    if (!Uf) Uf = floatKnots(c);
    const k = findSpanFloat(Uf, p, N, u);
    const B = basisFloat(Uf, p, k, u);
    let X = 0, Y = 0, W = 0;
    for (let r = 0; r <= p; r++) {
      const idx = k - p + r;
      if (idx < 0 || idx >= N) continue;
      const b = B[r];
      const pt = c.points[idx];
      X += b * pt.X.toNumber();
      Y += b * pt.Y.toNumber();
      W += b * pt.W.toNumber();
    }
    if (!Number.isFinite(W) || Math.abs(W) < 1e-300) return null;
    return [X / W, Y / W];
  }

  const api = {
    INT_MAX_CP,
    parseCurveObject,
    curveToObject,
    cloneCurve,
    domain,
    findSpan,
    basisValue,
    evalHomogeneousSide,
    evalHomogeneousDerivativeSide,
    projectedPointExact,
    queryAt,
    insertKnot,
    removeKnotAt,
    interiorOccurrenceRange,
    knotMultiplicity,
    moveProjectedPoint,
    setWeight,
    setHomogeneousPoint,
    homogeneousPointsEqual,
    floatKnots,
    findSpanFloat,
    evalPointFloat,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') {
    globalThis.RKS = globalThis.RKS || {};
    Object.assign(globalThis.RKS, api);
  }
})();
