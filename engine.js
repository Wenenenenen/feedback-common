/*
 * 序列帧标记事件引擎 —— 全程使用精确有理数（BigInt 分数）。
 *
 * 场景格式（与 samples/sprite-marker-transport.json 一致）：
 *   track: { id, mode: "loop"|"pingpong", duration,
 *            segments: [[主时钟起, 主时钟止, 未折返局部起点, 速度分子, 速度分母], ...],
 *            markers:  [[局部帧, 名称], ...] }
 *
 * 语义：
 *  - 段在主时钟区间 (t0, t1] 上生效：段尾算在当前段，段首跳转/停留只更新画面。
 *  - 只有移动途中经过的标记才触发；速度为 0 的段不触发。
 *  - loop：局部帧 = 未折返值 mod 周期；pingpong：以 2*周期 三角波折返。
 *  - 同一时刻按轨道编号、再按标记声明顺序输出。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpriteEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 分数： [分子, 分母]，BigInt，分母恒正、已约分 ----------
  function gcd(a, b) {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  }
  function frac(n, d) {
    n = BigInt(n); d = d === undefined ? 1n : BigInt(d);
    if (d === 0n) throw new Error('分母为 0');
    if (d < 0n) { n = -n; d = -d; }
    if (n === 0n) return [0n, 1n];
    const g = gcd(n, d);
    return [n / g, d / g];
  }
  const fadd = (a, b) => frac(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
  const fsub = (a, b) => frac(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
  const fmul = (a, b) => frac(a[0] * b[0], a[1] * b[1]);
  const fdiv = (a, b) => frac(a[0] * b[1], a[1] * b[0]);
  function fcmp(a, b) {
    const l = a[0] * b[1], r = b[0] * a[1];
    return l < r ? -1 : l > r ? 1 : 0;
  }
  function fstr(f) {
    return f[1] === 1n ? f[0].toString() : f[0].toString() + '/' + f[1].toString();
  }
  function fnum(f) { return Number(f[0]) / Number(f[1]); }

  // 向下取整除法（d > 0）
  function floorDiv(n, d) {
    let q = n / d;
    if (n % d !== 0n && n < 0n) q -= 1n;
    return q;
  }
  // 分数对正整数 m 取数学模，结果 ∈ [0, m)
  function fmod(u, m) {
    const k = floorDiv(u[0], u[1] * m);
    return fsub(u, [k * m, 1n]);
  }

  // ---------- 折返 ----------
  // 未折返局部值 u（分数） -> 画面局部帧（分数）
  function fold(track, u) {
    const d = BigInt(track.duration);
    if (track.mode === 'loop') return fmod(u, d);
    const p = 2n * d;
    const r = fmod(u, p);
    return fcmp(r, [d, 1n]) <= 0 ? r : fsub([p, 1n], r);
  }

  // 标记帧 f 对应的未折返剩余类：{ m: 模, rs: [剩余...] }（整数）
  function residues(track, f) {
    const d = track.duration;
    if (track.mode === 'loop') return { m: d, rs: [f] };
    const p = 2 * d;
    if (f === 0 || f === d) return { m: p, rs: [f] };
    return { m: p, rs: [f, p - f] };
  }

  // ---------- 事件计算 ----------
  // 返回 [{ time, track, marker }]，time 为分数；按 (时间, 轨道号, 标记声明序) 排序
  function computeEvents(tracks) {
    const events = [];
    tracks.forEach((tr, ti) => {
      tr.segments.forEach((seg) => {
        const [t0, t1, u0, vn, vd] = seg;
        if (vn === 0) return; // 停留段不触发
        const v = frac(vn, vd);
        const dt = t1 - t0;
        if (dt <= 0) return;
        // 段尾未折返值 uEnd = u0 + v*dt
        const uEnd = fadd(frac(u0), fmul(v, frac(dt)));
        const uStart = frac(u0);
        tr.markers.forEach((mk, mi) => {
          const f = mk[0];
          const { m, rs } = residues(tr, f);
          const mB = BigInt(m);
          rs.forEach((r) => {
            // 未折返目标 U = r + k*m，求落在移动区间内的 k
            let kLo, kHi;
            if (vn > 0) {
              // u0 < U <= uEnd
              kLo = floorDiv(BigInt(u0 - r), mB) + 1n;
              kHi = floorDiv(uEnd[0] - BigInt(r) * uEnd[1], uEnd[1] * mB);
            } else {
              // uEnd <= U < u0
              kLo = -floorDiv(-(uEnd[0] - BigInt(r) * uEnd[1]), uEnd[1] * mB);
              kHi = floorDiv(BigInt(u0 - r - 1), mB);
            }
            for (let k = kLo; k <= kHi; k++) {
              const U = BigInt(r) + k * mB;
              // t = t0 + (U - u0) / v
              const t = fadd(frac(t0), fdiv(frac(U - BigInt(u0)), v));
              events.push({ time: t, track: ti, marker: mi });
            }
          });
        });
      });
    });
    events.sort((a, b) =>
      fcmp(a.time, b.time) || a.track - b.track || a.marker - b.marker);
    return events;
  }

  // 导出为样例 expected 的格式： [["2/3","A","起"], ...]
  function formatEvents(tracks, events) {
    return events.map((e) => {
      const tr = tracks[e.track];
      return [fstr(e.time), tr.id, tr.markers[e.marker][1]];
    });
  }

  // ---------- 预览定位 ----------
  // 主时钟 t（分数）下某轨的画面局部帧（分数）。
  // 边界取右侧段的起点；最末边界显示末段终点。
  function positionAt(track, t) {
    const segs = track.segments;
    for (const seg of segs) {
      const [t0, t1, u0, vn, vd] = seg;
      if (fcmp(t, frac(t0)) >= 0 && fcmp(t, frac(t1)) < 0) {
        return fold(track, fadd(frac(u0), fmul(frac(vn, vd), fsub(t, frac(t0)))));
      }
    }
    const last = segs[segs.length - 1];
    if (last && fcmp(t, frac(last[1])) === 0) {
      const [t0, t1, u0, vn, vd] = last;
      return fold(track, fadd(frac(u0), fmul(frac(vn, vd), frac(t1 - t0))));
    }
    return null; // t 在轨道时间范围之外
  }

  // 主时钟范围 [start, end]（分数）
  function timelineRange(tracks) {
    let lo = null, hi = null;
    tracks.forEach((tr) => {
      tr.segments.forEach((s) => {
        const a = frac(s[0]), b = frac(s[1]);
        if (lo === null || fcmp(a, lo) < 0) lo = a;
        if (hi === null || fcmp(b, hi) > 0) hi = b;
      });
    });
    return [lo || [0n, 1n], hi || [0n, 1n]];
  }

  // ---------- 校验 ----------
  const MAX_TRACKS = 16, MAX_SEGMENTS = 64;
  function validate(tracks) {
    const problems = [];
    if (tracks.length > MAX_TRACKS) problems.push(`轨道数 ${tracks.length} 超过上限 ${MAX_TRACKS}`);
    tracks.forEach((tr, i) => {
      const name = tr.id || `#${i}`;
      if (tr.mode !== 'loop' && tr.mode !== 'pingpong')
        problems.push(`轨道 ${name}：模式须为 loop 或 pingpong`);
      if (!Number.isInteger(tr.duration) || tr.duration <= 0)
        problems.push(`轨道 ${name}：周期须为正整数`);
      if (tr.segments.length > MAX_SEGMENTS)
        problems.push(`轨道 ${name}：段数 ${tr.segments.length} 超过上限 ${MAX_SEGMENTS}`);
      tr.segments.forEach((s, j) => {
        if (s[1] <= s[0]) problems.push(`轨道 ${name} 段 ${j}：主时钟区间为空或倒置`);
        if (s[4] <= 0) problems.push(`轨道 ${name} 段 ${j}：速度分母须为正`);
        if (j > 0 && tr.segments[j - 1][1] !== s[0])
          problems.push(`轨道 ${name} 段 ${j}：与上一段不连续（${tr.segments[j - 1][1]} → ${s[0]}）`);
      });
      tr.markers.forEach((mk, j) => {
        const f = mk[0];
        const hi = tr.mode === 'loop' ? tr.duration - 1 : tr.duration;
        if (!Number.isInteger(f) || f < 0 || f > hi)
          problems.push(`轨道 ${name} 标记 ${j}：帧 ${f} 超出范围 0..${hi}`);
      });
    });
    return problems;
  }

  return {
    frac, fadd, fsub, fmul, fdiv, fcmp, fstr, fnum, fmod,
    fold, computeEvents, formatEvents, positionAt, timelineRange, validate,
    MAX_TRACKS, MAX_SEGMENTS,
  };
});
