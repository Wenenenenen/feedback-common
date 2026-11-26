/* 稀疏角标增量编码 —— 求解器核心（浏览器与 Node 通用）
 *
 * 语义（与 samples/sparse-overlay.json 的约定一致）：
 * - 画布起始全 0；每帧从该帧候选窗口中选一个矩形写补丁：
 *   矩形内逐像素写“差异目标索引”，相同处写 0 表示跳过。
 *   因为写 0 = 跳过，所以“旧像素非 0 而目标为 0”的像素无法被任何补丁修复，
 *   只能靠上一帧的处置（清窗口 / 恢复）提前清掉。
 * - 显示后处置：0 保留画布；1 把整个窗口清成 0；2 恢复本帧之前的画布。
 * - 每帧代价 = 6 + 窗口面积，总代价求最小；同价按每步
 *   (y0, x0, y1, x1, 处置码) 组成的序列作字典序比较。
 *
 * 算法：任意帧处置后的画布必为 T_g 或 zero(T_g, w)（w 为帧 g 的某候选窗口），
 * 故状态数 ≤ 帧数 + 窗口总数。按帧分层做精确最短路 DP；
 * 可行性用差集位图 D 与“必清集”位图 M 判定，字典序用层内秩传递。
 */
(function (global) {
  'use strict';

  // ---------- 输入校验 ----------
  function validate(input) {
    const errs = [];
    if (!input || typeof input !== 'object') return ['输入不是 JSON 对象'];
    const W = input.width, H = input.height;
    if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1) {
      errs.push('画布尺寸非法'); return errs;
    }
    if (W > 128 || H > 72) errs.push(`画布 ${W}×${H} 超出 128×72 上限`);
    const pal = input.palette;
    if (!Array.isArray(pal) || pal.length < 1 || pal.length > 256) {
      errs.push('palette 需为 1 至 256 组 RGB');
    } else {
      for (let i = 0; i < pal.length; i++) {
        const c = pal[i];
        if (!Array.isArray(c) || c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
          errs.push(`palette[${i}] 不是合法 RGB`); break;
        }
      }
    }
    const frames = input.frames;
    if (!Array.isArray(frames)) { errs.push('缺少 frames 数组'); return errs; }
    if (frames.length > 240) errs.push(`帧数 ${frames.length} 超过 240 上限`);
    let totalWin = 0;
    for (let f = 0; f < frames.length; f++) {
      const fr = frames[f];
      if (!fr || !Array.isArray(fr.pixels) || fr.pixels.length !== H) {
        errs.push(`第 ${f + 1} 帧 pixels 行数应为 ${H}`); continue;
      }
      let badPix = false;
      for (let y = 0; y < H && !badPix; y++) {
        const row = fr.pixels[y];
        if (!Array.isArray(row) || row.length !== W) { errs.push(`第 ${f + 1} 帧第 ${y} 行长度应为 ${W}`); badPix = true; break; }
        for (let x = 0; x < W; x++) {
          const v = row[x];
          if (!Number.isInteger(v) || v < 0 || v > pal.length) {
            errs.push(`第 ${f + 1} 帧像素 (${x},${y}) 索引 ${v} 超出调色板范围 0..${pal.length}`); badPix = true; break;
          }
        }
      }
      if (badPix) continue;
      const ws = fr.windows;
      if (!Array.isArray(ws)) { errs.push(`第 ${f + 1} 帧缺少 windows`); continue; }
      if (ws.length > 48) errs.push(`第 ${f + 1} 帧候选窗口 ${ws.length} 个，超过 48 上限`);
      totalWin += ws.length;
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        if (!Array.isArray(w) || w.length !== 4 || w.some(v => !Number.isInteger(v))) {
          errs.push(`第 ${f + 1} 帧窗口 ${i} 格式应为 [x0,y0,x1,y1]`); continue;
        }
        const [x0, y0, x1, y1] = w;
        if (!(0 <= x0 && x0 < x1 && x1 <= W && 0 <= y0 && y0 < y1 && y1 <= H)) {
          errs.push(`第 ${f + 1} 帧窗口 ${i} [${w}] 为空或越出画布`);
        }
      }
    }
    if (totalWin > 6000) errs.push(`候选窗口总数 ${totalWin} 超过 6000 上限`);
    return errs;
  }

  // ---------- 输入规范化 ----------
  function normalize(input) {
    const W = input.width | 0, H = input.height | 0;
    const frames = input.frames || [];
    const F = frames.length;
    const WH = W * H;
    const palette = (input.palette || []).map(c => [c[0], c[1], c[2]]);
    const T = [new Uint8Array(WH)]; // T[0] = 起始全 0 画布
    const windows = [[]];
    for (let f = 0; f < F; f++) {
      const fr = frames[f];
      const a = new Uint8Array(WH);
      const pix = fr.pixels;
      if (Array.isArray(pix[0])) {
        for (let y = 0; y < H; y++) { const row = pix[y]; for (let x = 0; x < W; x++) a[y * W + x] = row[x]; }
      } else {
        for (let i = 0; i < WH; i++) a[i] = pix[i];
      }
      T.push(a);
      windows.push((fr.windows || []).map(w => ({ x0: w[0], y0: w[1], x1: w[2], y1: w[3], area: (w[2] - w[0]) * (w[3] - w[1]) })));
    }
    return { W, H, F, WH, palette, T, windows };
  }

  function pop32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  }

  // ---------- 求解器 ----------
  function createSolver(norm) {
    const { W, H, F, WH, T, windows } = norm;
    const NW = (WH + 31) >>> 5;

    // 每帧支撑集（非零像素）位图、bbox、非空行
    const Sbset = [null], Sbbox = [null], Srows = [null];
    for (let f = 1; f <= F; f++) {
      const b = new Uint32Array(NW);
      let minx = W, miny = H, maxx = -1, maxy = -1;
      const rowFlag = new Uint8Array(H);
      const Tf = T[f];
      for (let p = 0; p < WH; p++) {
        if (Tf[p] !== 0) {
          b[p >> 5] |= 1 << (p & 31);
          const y = (p / W) | 0, x = p - y * W;
          rowFlag[y] = 1;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
      const rows = [];
      for (let y = 0; y < H; y++) if (rowFlag[y]) rows.push(y);
      Sbset.push(b); Sbbox.push([minx, miny, maxx, maxy]); Srows.push(rows);
    }

    // (g,f) 对信息：D = T_g≠T_f 的差集位图，M = T_g≠0 且 T_f=0 的“必清集”位图
    const pairArr = new Array((F + 1) * (F + 1)).fill(null);
    function getPair(g, f) {
      if (g === 0) return { D: Sbset[f], M: null, cntM: 0, bx: Sbbox[f], rows: Srows[f] };
      let info = pairArr[g * (F + 1) + f];
      if (info) return info;
      const D = new Uint32Array(NW), M = new Uint32Array(NW);
      let cntM = 0, minx = W, miny = H, maxx = -1, maxy = -1;
      const rowFlag = new Uint8Array(H);
      const Tg = T[g], Tf = T[f];
      const n4 = WH >>> 2;
      const Tg32 = new Uint32Array(Tg.buffer, 0, n4);
      const Tf32 = new Uint32Array(Tf.buffer, 0, n4);
      const mark = (p) => {
        D[p >> 5] |= 1 << (p & 31);
        const y = (p / W) | 0, x = p - y * W;
        rowFlag[y] = 1;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      };
      for (let i = 0; i < n4; i++) {
        if (Tg32[i] === Tf32[i]) continue;
        for (let j = 0; j < 4; j++) {
          const p = (i << 2) + j, a = Tg[p], bb = Tf[p];
          if (a !== bb) {
            mark(p);
            if (a !== 0 && bb === 0) { M[p >> 5] |= 1 << (p & 31); cntM++; }
          }
        }
      }
      for (let p = n4 << 2; p < WH; p++) {
        const a = Tg[p], bb = Tf[p];
        if (a !== bb) {
          mark(p);
          if (a !== 0 && bb === 0) { M[p >> 5] |= 1 << (p & 31); cntM++; }
        }
      }
      const rows = [];
      for (let y = 0; y < H; y++) if (rowFlag[y]) rows.push(y);
      info = { D, M, cntM, bx: [minx, miny, maxx, maxy], rows };
      pairArr[g * (F + 1) + f] = info;
      return info;
    }

    // 清零态 (g,wi) 对帧 f 的信息，缓存为打包数值：
    //  -2 = 不可行（窗口外仍有必清像素）；0 = 可行且差集为空；否则打包 bbox
    const tri = new Float64Array((F + 1) * 64 * (F + 1)).fill(-1);
    function getTriple(g, wi, f) {
      const key = (g * 64 + wi) * (F + 1) + f;
      const cached = tri[key];
      if (cached !== -1) return cached;
      const w = windows[g][wi];
      const pair = getPair(g, f);
      const D = pair.D, M = pair.M;
      const wx0 = w.x0, wx1 = w.x1, wy0 = w.y0, wy1 = w.y1;
      let ok = true, minx = W, miny = H, maxx = -1, maxy = -1;
      const rows = pair.rows;
      for (let ri = 0; ri < rows.length && ok; ri++) {
        const y = rows[ri];
        const rowBase = y * W;
        const inside = y >= wy0 && y < wy1;
        const k0 = rowBase >> 5, k1 = (rowBase + W - 1) >> 5;
        for (let k = k0; k <= k1; k++) {
          const wBase = k << 5;
          const rLo = Math.max(rowBase, wBase), rHi = Math.min(rowBase + W - 1, wBase + 31);
          const rOff = rLo - wBase, rLen = rHi - rLo + 1;
          const rowMask = rLen === 32 ? -1 : ((1 << rLen) - 1) << rOff;
          let inMask = 0;
          if (inside) {
            const lo = Math.max(rowBase + wx0, wBase), hi = Math.min(rowBase + wx1 - 1, wBase + 31);
            if (lo <= hi) {
              const off = lo - wBase, len = hi - lo + 1;
              inMask = len === 32 ? -1 : ((1 << len) - 1) << off;
            }
          }
          const out = rowMask & ~inMask;
          if (M && (M[k] & out) !== 0) { ok = false; break; }
          const d = D[k] & out;
          if (d !== 0) {
            const lo = 31 - Math.clz32(d & -d), hi = 31 - Math.clz32(d);
            const px = wBase + lo - rowBase, qx = wBase + hi - rowBase;
            if (px < minx) minx = px; if (qx > maxx) maxx = qx;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
          }
        }
      }
      if (ok) {
        const Sf = Sbset[f], srows = Srows[f];
        for (let ri = 0; ri < srows.length; ri++) {
          const y = srows[ri];
          if (y < wy0 || y >= wy1) continue;
          const rowBase = y * W;
          const kA = (rowBase + wx0) >> 5, kB = (rowBase + wx1 - 1) >> 5;
          for (let k = kA; k <= kB; k++) {
            const wBase = k << 5;
            const lo = Math.max(rowBase + wx0, wBase), hi = Math.min(rowBase + wx1 - 1, wBase + 31);
            const off = lo - wBase, len = hi - lo + 1;
            const inMask = len === 32 ? -1 : ((1 << len) - 1) << off;
            const s = Sf[k] & inMask;
            if (s !== 0) {
              const lo2 = 31 - Math.clz32(s & -s), hi2 = 31 - Math.clz32(s);
              const px = wBase + lo2 - rowBase, qx = wBase + hi2 - rowBase;
              if (px < minx) minx = px; if (qx > maxx) maxx = qx;
              if (y < miny) miny = y; if (y > maxy) maxy = y;
            }
          }
        }
      }
      const packed = !ok ? -2 : (maxx < 0 ? 0 : 1 + minx + 256 * (miny + 256 * (maxx + 256 * maxy)));
      tri[key] = packed;
      return packed;
    }

    function decodeBBox(v) {
      const vv = v - 1;
      return [vv % 256, ((vv / 256) | 0) % 256, ((vv / 65536) | 0) % 256, ((vv / 16777216) | 0) % 256];
    }

    function winLess(a, b) { // (面积, y0, x0, y1, x1) 字典序
      return a.area < b.area || (a.area === b.area && (
        a.y0 < b.y0 || (a.y0 === b.y0 && (
          a.x0 < b.x0 || (a.x0 === b.x0 && (
            a.y1 < b.y1 || (a.y1 === b.y1 && a.x1 < b.x1)))))));
    }
    const P2_34 = 17179869184; // 2^34
    function stepSort(w, d) { // (y0,x0,y1,x1,d) 打包成一个可比较的数
      return (((w.y0 * 256 + w.x0) * 256 + w.y1) * 256 + w.x1) * 4 + d;
    }

    // 分层最短路 DP；生成器，定期 yield 进度，return 结果
    function* solve() {
      const SK = (F + 1) * 64;
      let cCost = new Float64Array(SK).fill(Infinity), cRank = new Int32Array(SK);
      let nCost = new Float64Array(SK), nSrc = new Int32Array(SK), nV = new Int16Array(SK),
          nD = new Uint8Array(SK), nRank = new Int32Array(SK), nSort = new Float64Array(SK);
      cCost[0] = 0; // key = g*64 + wi+1；key 0 = (g=0, wi=-1) 起始全 0 画布
      let cur = [0];
      const hist = [null];
      for (let f = 1; f <= F; f++) {
        nCost.fill(Infinity);
        const next = [];
        const ws = windows[f], nw = ws.length;
        function upd(tk, c, src, vi, d, sr) {
          const old = nCost[tk];
          if (c < old) {
            if (old === Infinity) next.push(tk);
            nCost[tk] = c; nSrc[tk] = src; nV[tk] = vi; nD[tk] = d;
            nSort[tk] = sr * P2_34 + stepSort(ws[vi], d);
          } else if (c === old) {
            const ns = sr * P2_34 + stepSort(ws[vi], d);
            if (ns < nSort[tk]) {
              nSrc[tk] = src; nV[tk] = vi; nD[tk] = d; nSort[tk] = ns;
            }
          }
        }
        for (let ki = 0; ki < cur.length; ki++) {
          const key = cur[ki];
          const g = (key / 64) | 0, wi = (key & 63) - 1;
          let bx0, by0, bx1, by1;
          if (wi < 0) {
            const p = getPair(g, f);
            if (p.cntM > 0) continue; // 有必清像素，任何候选都无法复现目标
            bx0 = p.bx[0]; by0 = p.bx[1]; bx1 = p.bx[2]; by1 = p.bx[3];
          } else {
            const v = getTriple(g, wi, f);
            if (v === -2) continue;
            if (v === 0) { bx0 = 0; by0 = 0; bx1 = -1; by1 = 0; }
            else { const b = decodeBBox(v); bx0 = b[0]; by0 = b[1]; bx1 = b[2]; by1 = b[3]; }
          }
          const empty = bx1 < 0;
          const sc = cCost[key], sr = cRank[key];
          let bestVi = -1;
          for (let vi = 0; vi < nw; vi++) {
            const wv = ws[vi];
            if (!empty && (wv.x0 > bx0 || wv.y0 > by0 || wv.x1 <= bx1 || wv.y1 <= by1)) continue;
            const c = sc + 6 + wv.area;
            upd(f * 64 + vi + 1, c, key, vi, 1, sr);      // 处置 1：清零本帧窗口
            if (bestVi < 0 || winLess(wv, ws[bestVi])) bestVi = vi;
          }
          if (bestVi >= 0) {
            const c = sc + 6 + ws[bestVi].area;
            upd(key, c, key, bestVi, 2, sr);              // 处置 2：恢复，画布随状态携带
            upd(f * 64, c, key, bestVi, 0, sr);           // 处置 0：保留为目标画布
          }
        }
        if (next.length === 0) {
          const failStates = cur.map(key => ({ g: (key / 64) | 0, wi: (key & 63) - 1, cost: cCost[key] }));
          failStates.sort((a, b) => a.cost - b.cost || a.g - b.g || a.wi - b.wi);
          return { ok: false, failFrame: f, failStates };
        }
        next.sort((a, b) => nSort[a] - nSort[b]);
        for (let i = 0; i < next.length; i++) nRank[next[i]] = i;
        const hk = new Int32Array(next.length), hr = new Int32Array(next.length);
        for (let i = 0; i < next.length; i++) {
          const k = next[i];
          hk[i] = k;
          hr[i] = nSrc[k] | (nV[k] << 14) | (nD[k] << 20);
        }
        hist[f] = { keys: hk, rec: hr, map: null };
        const tc = cCost; cCost = nCost; nCost = tc;
        const tr = cRank; cRank = nRank; nRank = tr;
        cur = next;
        if (f % 4 === 0 || f === F) yield { frame: f, states: cur.length };
      }
      let bestKey = -1, bestC = Infinity, bestR = Infinity;
      for (let i = 0; i < cur.length; i++) {
        const k = cur[i], c = cCost[k];
        if (c < bestC || (c === bestC && cRank[k] < bestR)) { bestC = c; bestKey = k; bestR = cRank[k]; }
      }
      const plan = new Array(F);
      let key = bestKey;
      for (let f = F; f >= 1; f--) {
        const h = hist[f];
        if (!h.map) { h.map = new Map(); for (let i = 0; i < h.keys.length; i++) h.map.set(h.keys[i], i); }
        const rec = h.rec[h.map.get(key)];
        const src = rec & 16383, vi = (rec >> 14) & 63, d = (rec >> 20) & 3;
        const w = windows[f][vi];
        plan[f - 1] = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, area: w.area, d, cost: 6 + w.area, vi };
        key = src;
      }
      return { ok: true, totalCost: bestC, plan };
    }

    // 状态 (g,wi) 对应的画布：T_g 被帧 g 的第 wi 个窗口清零（wi=-1 即 T_g 本身）
    function stateCanvas(g, wi) {
      const c = T[g].slice();
      if (wi >= 0) {
        const w = windows[g][wi];
        for (let y = w.y0; y < w.y1; y++) for (let x = w.x0; x < w.x1; x++) c[y * W + x] = 0;
      }
      return c;
    }

    // 诊断状态 (g,wi) 为何无法到达帧 f
    function diagnose(g, wi, f) {
      const pair = getPair(g, f);
      let bad = 0, bx = null;
      if (wi < 0) {
        bad = pair.cntM;
        bx = pair.bx;
      } else {
        const v = getTriple(g, wi, f);
        if (v === -2) {
          const w = windows[g][wi], M = pair.M;
          for (let ri = 0; ri < pair.rows.length; ri++) {
            const y = pair.rows[ri];
            const rowBase = y * W;
            const inside = y >= w.y0 && y < w.y1;
            const k0 = rowBase >> 5, k1 = (rowBase + W - 1) >> 5;
            for (let k = k0; k <= k1; k++) {
              const wBase = k << 5;
              const rLo = Math.max(rowBase, wBase), rHi = Math.min(rowBase + W - 1, wBase + 31);
              const rOff = rLo - wBase, rLen = rHi - rLo + 1;
              const rowMask = rLen === 32 ? -1 : ((1 << rLen) - 1) << rOff;
              let inMask = 0;
              if (inside) {
                const lo = Math.max(rowBase + w.x0, wBase), hi = Math.min(rowBase + w.x1 - 1, wBase + 31);
                if (lo <= hi) {
                  const off = lo - wBase, len = hi - lo + 1;
                  inMask = len === 32 ? -1 : ((1 << len) - 1) << off;
                }
              }
              bad += pop32(M[k] & rowMask & ~inMask);
            }
          }
        } else {
          bx = v === 0 ? [0, 0, -1, 0] : decodeBBox(v);
        }
      }
      let covered = false;
      if (bad === 0 && bx) {
        const empty = bx[2] < 0;
        for (const wv of windows[f]) {
          if (empty || (wv.x0 <= bx[0] && wv.y0 <= bx[1] && wv.x1 > bx[2] && wv.y1 > bx[3])) { covered = true; break; }
        }
      }
      return { bad, bbox: bx, covered };
    }

    return { norm, solve, stateCanvas, diagnose, getPair, getTriple };
  }

  // ---------- 按方案模拟，得到每帧 显示前/显示中/处置后 画布与补丁字节 ----------
  function simulate(norm, plan) {
    const { W, H, F, WH, T } = norm;
    const canvas = new Uint8Array(WH);
    const frames = [];
    for (let f = 1; f <= F; f++) {
      const st = plan[f - 1];
      const pre = canvas.slice();
      const patch = new Uint8Array(st.area);
      const Tf = T[f];
      let i = 0;
      for (let y = st.y0; y < st.y1; y++) {
        for (let x = st.x0; x < st.x1; x++) {
          const p = y * W + x, t = Tf[p];
          const b = canvas[p] !== t ? t : 0; // 0 = 跳过
          patch[i++] = b;
          if (b !== 0) canvas[p] = b;
        }
      }
      const disp = canvas.slice();
      let post;
      if (st.d === 0) {
        post = canvas.slice();
      } else if (st.d === 1) {
        for (let y = st.y0; y < st.y1; y++) for (let x = st.x0; x < st.x1; x++) canvas[y * W + x] = 0;
        post = canvas.slice();
      } else {
        canvas.set(pre);
        post = canvas.slice();
      }
      frames.push({ pre, disp, post, patch });
    }
    return frames;
  }

  // ---------- SOP1 导出 ----------
  function buildSOP1(norm, plan, simFrames) {
    const ncol = norm.palette.length;
    let size = 4 + 1 + 1 + 2 + 2 + ncol * 3;
    for (const st of plan) size += 6 + st.area;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    let o = 0;
    buf[o++] = 0x53; buf[o++] = 0x4F; buf[o++] = 0x50; buf[o++] = 0x31; // "SOP1"
    buf[o++] = norm.W; buf[o++] = norm.H;
    dv.setUint16(o, norm.F, true); o += 2;
    dv.setUint16(o, ncol, true); o += 2;
    for (const c of norm.palette) { buf[o++] = c[0]; buf[o++] = c[1]; buf[o++] = c[2]; }
    for (let f = 0; f < plan.length; f++) {
      const st = plan[f];
      buf[o++] = st.x0; buf[o++] = st.y0;
      buf[o++] = st.x1 - st.x0; buf[o++] = st.y1 - st.y0;
      buf[o++] = st.d; buf[o++] = 0;
      buf.set(simFrames[f].patch, o); o += st.area;
    }
    return buf;
  }

  // ---------- SOP1 导入 ----------
  function parseSOP1(buf) {
    if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
    if (buf.length < 10 || buf[0] !== 0x53 || buf[1] !== 0x4F || buf[2] !== 0x50 || buf[3] !== 0x31) {
      throw new Error('不是 SOP1 文件（魔数不符）');
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 4;
    const W = buf[o++], H = buf[o++];
    const F = dv.getUint16(o, true); o += 2;
    const ncol = dv.getUint16(o, true); o += 2;
    const palette = [];
    for (let i = 0; i < ncol; i++) { palette.push([buf[o], buf[o + 1], buf[o + 2]]); o += 3; }
    const records = [];
    for (let f = 0; f < F; f++) {
      if (o + 6 > buf.length) throw new Error(`第 ${f + 1} 帧记录头越界`);
      const x0 = buf[o++], y0 = buf[o++], w = buf[o++], h = buf[o++], d = buf[o++];
      o++; // 保留字节
      if (w < 1 || h < 1 || x0 + w > W || y0 + h > H) throw new Error(`第 ${f + 1} 帧窗口越界`);
      if (d > 2) throw new Error(`第 ${f + 1} 帧处置码 ${d} 非法`);
      if (o + w * h > buf.length) throw new Error(`第 ${f + 1} 帧补丁数据越界`);
      const patch = buf.slice(o, o + w * h); o += w * h;
      records.push({ x0, y0, w, h, d, patch });
    }
    if (o !== buf.length) throw new Error('文件尾部有多余字节');
    return { W, H, F, palette, records };
  }

  function simulateSOP1(parsed) {
    const { W, H } = parsed;
    const WH = W * H;
    const canvas = new Uint8Array(WH);
    const frames = [];
    for (const r of parsed.records) {
      const pre = canvas.slice();
      let i = 0;
      for (let y = r.y0; y < r.y0 + r.h; y++) {
        for (let x = r.x0; x < r.x0 + r.w; x++) {
          const b = r.patch[i++];
          if (b !== 0) canvas[y * W + x] = b;
        }
      }
      const disp = canvas.slice();
      let post;
      if (r.d === 0) {
        post = canvas.slice();
      } else if (r.d === 1) {
        for (let y = r.y0; y < r.y0 + r.h; y++) for (let x = r.x0; x < r.x0 + r.w; x++) canvas[y * W + x] = 0;
        post = canvas.slice();
      } else {
        canvas.set(pre);
        post = canvas.slice();
      }
      frames.push({ pre, disp, post });
    }
    return frames;
  }

  // ---------- 暴力求解（仅用于测试对拍）----------
  function seqLess(a, b) {
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < 5; j++) {
        if (a[i][j] !== b[i][j]) return a[i][j] < b[i][j];
      }
    }
    return false;
  }

  function bruteForce(norm) {
    const { W, H, F, WH, T, windows } = norm;
    const keyOf = c => c.join(',');
    const zero = new Uint8Array(WH);
    let cur = new Map([[keyOf(zero), { cost: 0, seq: [], canvas: zero }]]);
    for (let f = 1; f <= F; f++) {
      const next = new Map();
      const Tf = T[f];
      for (const st of cur.values()) {
        const C = st.canvas;
        let bad = false;
        for (let p = 0; p < WH; p++) if (C[p] !== 0 && Tf[p] === 0) { bad = true; break; }
        if (bad) continue;
        let minx = W, miny = H, maxx = -1, maxy = -1;
        for (let p = 0; p < WH; p++) {
          if (C[p] !== Tf[p]) {
            const y = (p / W) | 0, x = p - y * W;
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
          }
        }
        for (const wv of windows[f]) {
          if (maxx >= 0 && !(wv.x0 <= minx && wv.y0 <= miny && wv.x1 > maxx && wv.y1 > maxy)) continue;
          for (let d = 0; d < 3; d++) {
            const nc = C.slice();
            for (let y = wv.y0; y < wv.y1; y++) for (let x = wv.x0; x < wv.x1; x++) {
              const p = y * W + x;
              if (nc[p] !== Tf[p]) nc[p] = Tf[p];
            }
            if (d === 1) {
              for (let y = wv.y0; y < wv.y1; y++) for (let x = wv.x0; x < wv.x1; x++) nc[y * W + x] = 0;
            } else if (d === 2) {
              nc.set(C);
            }
            const cost = st.cost + 6 + wv.area;
            const seq = st.seq.concat([[wv.y0, wv.x0, wv.y1, wv.x1, d]]);
            const k = keyOf(nc);
            const old = next.get(k);
            if (!old || cost < old.cost || (cost === old.cost && seqLess(seq, old.seq))) {
              next.set(k, { cost, seq, canvas: nc });
            }
          }
        }
      }
      if (next.size === 0) return { ok: false, failFrame: f };
      cur = next;
    }
    let best = null;
    for (const st of cur.values()) {
      if (!best || st.cost < best.cost || (st.cost === best.cost && seqLess(st.seq, best.seq))) best = st;
    }
    return { ok: true, cost: best.cost, seq: best.seq };
  }

  const api = { validate, normalize, createSolver, simulate, buildSOP1, parseSOP1, simulateSOP1, bruteForce };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SparseSolver = api;
})(typeof window !== 'undefined' ? window : globalThis);
