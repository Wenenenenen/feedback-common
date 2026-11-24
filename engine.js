/*
 * 磷光扫描拍屏曝光模拟引擎（浏览器 / Node 双端）。
 *
 * 模型：
 * - 行 y 第 j 帧扫描时刻 s = P*(j + y/H)（保留分数），j 从 0 起。
 * - 扫描时刻把该行驱动锁定为当前页（同刻换页先于扫描；同刻多条换页取文件里最后一条）。
 * - 一行只用自己的扫描时刻锁页，下次扫到前保持驱动；首扫前驱动和发光为 0。
 * - 恒定驱动 G（=锁定页像素/255）长度 s 内：L -> G+(L-G)*exp(-s/tau)，
 *   积分 = G*s + (L-G)*tau*(1-exp(-s/tau))。
 * - 相机行 y 积分窗 [start+y*rowDelay, start+y*rowDelay+duration)，
 *   积分/duration*255 四舍五入为 PNG 值。
 *
 * 实现要点：L 的递推对各页驱动是线性的，因此每行把“曝光起点亮度”和
 * “曝光窗积分”都分解为各页驱动的一次组合系数（每行 O(换页数)，每像素
 * O(页数)），跳到任意晚的时刻都与从头重演数学等价，无需逐次扫描。
 */
(function (global) {
  'use strict';

  // 换页折叠：按时间稳定排序（保持文件次序），同刻取文件里最后一条。
  function collapseSwitches(switches) {
    const indexed = switches.map((s, i) => ({ t: Number(s[0]), p: Number(s[1]), i }));
    indexed.sort((a, b) => (a.t - b.t) || (a.i - b.i));
    const T = [], P = [];
    for (const s of indexed) {
      if (T.length && T[T.length - 1] === s.t) P[P.length - 1] = s.p;
      else { T.push(s.t); P.push(s.p); }
    }
    return { T, P };
  }

  function makeModel(data) {
    if (!data || !Array.isArray(data.size) || data.size.length !== 2) {
      throw new Error('缺少 size [W,H]');
    }
    const W = Number(data.size[0]), H = Number(data.size[1]);
    if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > 256 || H > 144) {
      throw new Error('尺寸须为 1..256 × 1..144 的整数');
    }
    const P = Number(data.P), tau = Number(data.tau);
    if (!(P > 0) || !(tau > 0)) throw new Error('P、tau 须为正数（微秒）');
    if (!Array.isArray(data.pages) || data.pages.length < 1 || data.pages.length > 32) {
      throw new Error('页数须为 1..32');
    }
    const pages = data.pages.map((pg, i) => {
      if (!Array.isArray(pg) && !(pg instanceof Uint8Array)) {
        throw new Error('第 ' + i + ' 页不是数组');
      }
      if (pg.length !== W * H) {
        throw new Error('第 ' + i + ' 页长度 ' + pg.length + ' ≠ ' + W + '×' + H);
      }
      const u = new Uint8Array(W * H);
      for (let k = 0; k < u.length; k++) {
        const v = Number(pg[k]);
        if (!Number.isInteger(v) || v < 0 || v > 255) {
          throw new Error('第 ' + i + ' 页像素 ' + k + ' 非 0..255 整数: ' + pg[k]);
        }
        u[k] = v;
      }
      return u;
    });
    const switches = data.switches || [];
    if (!Array.isArray(switches)) throw new Error('switches 须为数组');
    if (switches.length > 20000) throw new Error('换页最多 20000 条');
    switches.forEach((s, i) => {
      if (!Array.isArray(s) || s.length < 2) throw new Error('换页 #' + i + ' 须为 [t,page]');
      if (!(Number(s[1]) >= 0 && Number(s[1]) < pages.length)) {
        throw new Error('换页 #' + i + ' 页索引越界: ' + s[1]);
      }
    });
    const collapsed = collapseSwitches(switches);
    return { W, H, P, tau, pages, swT: collapsed.T, swPage: collapsed.P };
  }

  // arr 中 <= x 的元素个数（arr 升序）。
  function upperBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 最小的整数 j 使 off + P*j >= t（带浮点校正）。
  function ceilScan(off, P, t) {
    let j = Math.ceil((t - off) / P - 1e-9);
    while (off + P * j < t) j++;
    while (off + P * (j - 1) >= t) j--;
    return j;
  }

  // 时刻 s 的锁定页（最后一条 t<=s 的换页；无则 -1 表示驱动 0）。
  function pageAt(model, s) {
    const hi = upperBound(model.swT, s);
    return hi > 0 ? model.swPage[hi - 1] : -1;
  }

  /*
   * 行 y 在时刻 t0 的状态系数：
   *   L(t0) = (1-B)*G(lastPage) + Σ_p C[p]*G(p)
   * 其中 G(p) 为页 p 在该像素的驱动（像素值/255），lastPage 为最后一次
   * 扫描（<=t0）锁定的页，B 为自该扫描到 t0 的衰减因子。
   */
  function rowCoeffs(model, y, t0) {
    const { H, P, tau, swT, swPage } = model;
    const np = model.pages.length;
    const off = P * y / H;
    const C = new Float64Array(np);
    let jLast = Math.floor((t0 - off) / P);
    while (off + P * (jLast + 1) <= t0) jLast++;
    while (jLast >= 0 && off + P * jLast > t0) jLast--;
    if (jLast < 0) return { off, jLast: -1, sLast: NaN, B: 0, lastPage: -1, C };
    const sLast = off + P * jLast;
    const B = Math.exp(-(t0 - sLast) / tau);
    const hi = upperBound(swT, sLast);
    const lastPage = hi > 0 ? swPage[hi - 1] : -1;
    const jLim = jLast - 1; // 扫描 jLast 的驱动尚未作用于 L(t0) 的积分部分之外
    for (let k = 0; k < hi; k++) {
      let lo = ceilScan(off, P, swT[k]);
      if (lo < 0) lo = 0;
      if (lo > jLim) continue;
      let hik = (k + 1 < hi) ? ceilScan(off, P, swT[k + 1]) - 1 : jLast;
      if (hik > jLim) hik = jLim;
      if (lo > hik) continue;
      const n = hik - lo + 1;
      // Σ_{i=lo..hik} B*(1-q)*q^(jLast-1-i) = B*q^(jLast-1-hik)*(1-q^n)
      C[swPage[k]] += B * Math.exp(-(jLast - 1 - hik) * P / tau) * (-Math.expm1(-n * P / tau));
    }
    return { off, jLast, sLast, B, lastPage, C };
  }

  /*
   * 行曝光窗 [t0,t1) 的积分系数：
   *   积分 = d*L0 + Σ_p e[p]*G(p)
   * L0 为 t0 时刻亮度。按“驱动恒定段”（同一页连续多次扫描合并）解析积分。
   */
  function rowIntegral(model, row, t0, t1) {
    const { P, tau, swT } = model;
    const np = model.pages.length;
    const c = new Float64Array(np), e = new Float64Array(np);
    let a = 1, d = 0;
    let t = t0;
    let curPage = row.lastPage;
    let swIdx = row.jLast >= 0 ? upperBound(swT, row.sLast) : 0;
    let j = row.jLast + 1;
    while (t < t1) {
      // 下一次可能换页的扫描：第一条未生效换页之后的首个扫描
      let sChange = Infinity, jChange = Infinity;
      if (swIdx < swT.length) {
        jChange = ceilScan(row.off, P, swT[swIdx]);
        if (jChange < j) jChange = j;
        sChange = row.off + P * jChange;
      }
      if (sChange <= t) { // 浮点边界：立即生效
        curPage = pageAt(model, sChange);
        swIdx = upperBound(swT, sChange);
        j = jChange + 1;
        continue;
      }
      const nextT = sChange < t1 ? sChange : t1;
      const s = nextT - t;
      const E = Math.exp(-s / tau);
      const m = -tau * Math.expm1(-s / tau); // tau*(1-E)
      if (curPage >= 0) e[curPage] += s - m;
      d += m * a;
      for (let p = 0; p < np; p++) e[p] += m * c[p];
      a *= E;
      for (let p = 0; p < np; p++) c[p] *= E;
      if (curPage >= 0) c[curPage] += 1 - E;
      t = nextT;
      if (nextT === sChange) {
        curPage = pageAt(model, sChange);
        swIdx = upperBound(swT, sChange);
        j = jChange + 1;
      }
    }
    return { d, e };
  }

  /*
   * 整幅预览。返回 Float64Array(W*H)，值为 积分/duration*255（未取整）。
   * 每像素：I = Σ_p K[p]*页p像素值/255，K 由行系数合并而来。
   */
  function renderFloat(model, cam) {
    const { W, H } = model;
    const np = model.pages.length;
    const out = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
      const t0 = cam.start + y * cam.rowDelay;
      const t1 = t0 + cam.duration;
      const row = rowCoeffs(model, y, t0);
      const ic = rowIntegral(model, row, t0, t1);
      const K = new Float64Array(np);
      for (let p = 0; p < np; p++) K[p] = ic.e[p] + ic.d * row.C[p];
      if (row.lastPage >= 0) K[row.lastPage] += ic.d * (1 - row.B);
      const nz = [];
      for (let p = 0; p < np; p++) if (K[p] !== 0) nz.push(p);
      const base = y * W;
      for (let x = 0; x < W; x++) {
        const px = base + x;
        let acc = 0;
        for (let i = 0; i < nz.length; i++) {
          const p = nz[i];
          acc += K[p] * model.pages[p][px];
        }
        out[px] = acc / cam.duration; // ΣK*(val/255)*255/duration
      }
    }
    return out;
  }

  // 四舍五入并截断到 0..255 的 PNG 灰度。
  function render(model, cam) {
    const f = renderFloat(model, cam);
    const out = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.round(f[i]);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  }

  /*
   * 单像素详细记录：相关锁页时间、驱动、各积分段（恒定驱动段，含扫描次数）、
   * 曝光起点亮度、积分、平均值与 PNG 值。曝光之前的重复扫描按规则省略，
   * 只保留曝光起点亮度与曝光前最后一次锁页。
   */
  function pixelRecord(model, cam, x, y) {
    const { W, P, tau, swT } = model;
    const t0 = cam.start + y * cam.rowDelay;
    const t1 = t0 + cam.duration;
    const row = rowCoeffs(model, y, t0);
    const px = y * W + x;
    const G = (p) => (p >= 0 ? model.pages[p][px] / 255 : 0);
    let L0 = 0;
    if (row.jLast >= 0) {
      L0 = (1 - row.B) * G(row.lastPage);
      for (let p = 0; p < model.pages.length; p++) {
        if (row.C[p] !== 0) L0 += row.C[p] * G(p);
      }
    }
    const locks = [];
    if (row.jLast >= 0) {
      locks.push({ scanTime: row.sLast, page: row.lastPage, drive: G(row.lastPage), note: '曝光前最后一次锁页（更早的重复扫描已省略，其效果含于曝光起点亮度）' });
    }
    // 曝光窗内的每次扫描都是一次锁页；过多时把同页连续扫描折叠为计数条目
    const inWin = [];
    for (let j = row.jLast + 1; ; j++) {
      const sj = row.off + P * j;
      if (!(sj < t1)) break;
      const pg = pageAt(model, sj);
      inWin.push({ scanTime: sj, page: pg, drive: G(pg) });
    }
    if (inWin.length <= 1000) {
      locks.push(...inWin);
    } else {
      for (const lk of inWin) {
        const last = locks[locks.length - 1];
        if (last && last.page === lk.page && !last.note) last.scans = (last.scans || 1) + 1;
        else locks.push({ scanTime: lk.scanTime, page: lk.page, drive: lk.drive, scans: 1 });
      }
    }
    const segments = [];
    let L = L0, I = 0, t = t0;
    let curPage = row.lastPage;
    let swIdx = row.jLast >= 0 ? upperBound(swT, row.sLast) : 0;
    let j = row.jLast + 1;
    while (t < t1) {
      let sChange = Infinity, jChange = Infinity;
      if (swIdx < swT.length) {
        jChange = ceilScan(row.off, P, swT[swIdx]);
        if (jChange < j) jChange = j;
        sChange = row.off + P * jChange;
      }
      if (sChange <= t) {
        curPage = pageAt(model, sChange);
        swIdx = upperBound(swT, sChange);
        j = jChange + 1;
        continue;
      }
      const nextT = sChange < t1 ? sChange : t1;
      const s = nextT - t;
      const E = Math.exp(-s / tau);
      const m = -tau * Math.expm1(-s / tau);
      const g = G(curPage);
      const segI = g * s + (L - g) * m;
      const Lend = g + (L - g) * E;
      const jEnd = nextT === sChange ? jChange : ceilScan(row.off, P, nextT);
      segments.push({
        start: t, end: nextT, page: curPage, drive: g,
        scans: Math.max(0, jEnd - j),
        Lstart: L, Lend, integral: segI,
      });
      I += segI; L = Lend; t = nextT;
      if (nextT === sChange) {
        curPage = pageAt(model, sChange);
        swIdx = upperBound(swT, sChange);
        j = jChange + 1;
      }
    }
    const average = I / cam.duration;
    let pngValue = Math.round(average * 255);
    if (pngValue < 0) pngValue = 0; else if (pngValue > 255) pngValue = 255;
    return {
      pixel: { x, y },
      params: { P, tau, start: cam.start, duration: cam.duration, rowDelay: cam.rowDelay },
      window: [t0, t1],
      exposureStartLum: L0,
      locks,
      segments,
      integral: I,
      average,
      pngValue,
    };
  }

  const Engine = { makeModel, collapseSwitches, rowCoeffs, rowIntegral, renderFloat, render, pixelRecord };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else global.PhosphorEngine = Engine;
})(typeof self !== 'undefined' ? self : this);
