/* msdf-core.js — 矢量 MSDF 核心库
 * 解析轮廓、逐通道最近曲线点、端点伪距离修正、中位数/A 异号修正、
 * 距离编码与无损 PNG（线性、无预乘 RGBA）输出。
 * 浏览器挂 window.MSDF，Node 下 module.exports。
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.MSDF = M;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const COARSE = 24;                 // 曲线最近点粗采样数
  const MASKS = ['RG', 'GB', 'BR'];
  const BIT = { R: 4, G: 2, B: 1 };

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function median3(a, b, c) { return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  function maskBits(mask) {
    let b = 0;
    if (mask.indexOf('R') >= 0) b |= BIT.R;
    if (mask.indexOf('G') >= 0) b |= BIT.G;
    if (mask.indexOf('B') >= 0) b |= BIT.B;
    return b;
  }

  // ---------- 文档校验 ----------
  function validateDoc(doc) {
    const errors = [], warnings = [];
    if (!doc || typeof doc !== 'object') { errors.push('不是有效的 JSON 对象'); return { errors, warnings }; }
    const b = doc.bounds;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || !(b[2] > b[0]) || !(b[3] > b[1]))
      errors.push('bounds 应为 [minX, minY, maxX, maxY] 且非退化');
    if (!Array.isArray(doc.size) || doc.size.length !== 2 ||
        !doc.size.every(n => Number.isInteger(n) && n >= 1 && n <= 256))
      errors.push('size 应为 [w, h]，均为 1..256 的整数');
    if (!(typeof doc.range === 'number' && doc.range > 0)) errors.push('range 应为正数');
    if (!Array.isArray(doc.glyphs) || doc.glyphs.length === 0) {
      errors.push('glyphs 为空');
    } else {
      doc.glyphs.forEach((g, gi) => {
        const name = (g && g.id) || ('#' + gi);
        if (!Array.isArray(g.contours) || g.contours.length === 0) {
          warnings.push(`glyph ${name}: 没有轮廓`);
          return;
        }
        let nseg = 0;
        g.contours.forEach((c, ci) => {
          if (!Array.isArray(c) || c.length === 0) { warnings.push(`glyph ${name} 轮廓 ${ci}: 为空`); return; }
          c.forEach((s, si) => {
            nseg++;
            if (!s || MASKS.indexOf(s.mask) < 0)
              errors.push(`glyph ${name} 轮廓 ${ci} 段 ${si}: mask 须为 RG/GB/BR`);
            if (!s || !Array.isArray(s.p) || s.p.length < 2 || s.p.length > 4 ||
                !s.p.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)))
              errors.push(`glyph ${name} 轮廓 ${ci} 段 ${si}: p 须为 2~4 个 [x,y] 控制点`);
          });
          for (let si = 0; si < c.length; si++) {
            const cur = c[si], nxt = c[(si + 1) % c.length];
            if (!cur || !nxt || !Array.isArray(cur.p) || !Array.isArray(nxt.p)) continue;
            const end = cur.p[cur.p.length - 1], st = nxt.p[0];
            if (Math.hypot(end[0] - st[0], end[1] - st[1]) > 1e-6)
              warnings.push(`glyph ${name} 轮廓 ${ci}: 段 ${si} 终点与下一段起点不衔接（轮廓未闭合）`);
          }
        });
        if (nseg > 96) warnings.push(`glyph ${name}: 段数 ${nseg} 超过 96`);
      });
    }
    return { errors, warnings };
  }

  // ---------- 段预处理 ----------
  function prepSegments(glyph) {
    const segs = [];
    glyph.contours.forEach((c, ci) => {
      c.forEach((s, si) => {
        const p = s.p.map(pt => [pt[0], pt[1]]);
        const seg = {
          id: ci + '.' + si,
          contour: ci,
          index: si,
          type: p.length - 1,          // 1 直线 / 2 二次 / 3 三次
          mask: s.mask,
          bits: maskBits(s.mask),
          p,
          bbox: null,
          samples: null,
        };
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const pt of p) {
          if (pt[0] < mnx) mnx = pt[0];
          if (pt[1] < mny) mny = pt[1];
          if (pt[0] > mxx) mxx = pt[0];
          if (pt[1] > mxy) mxy = pt[1];
        }
        seg.bbox = [mnx, mny, mxx, mxy];
        if (p.length > 2) {
          const arr = new Float64Array((COARSE + 1) * 2);
          const out = [0, 0];
          for (let k = 0; k <= COARSE; k++) {
            evalAt(p, k / COARSE, out);
            arr[2 * k] = out[0]; arr[2 * k + 1] = out[1];
          }
          seg.samples = arr;
        }
        segs.push(seg);
      });
    });
    return segs;
  }

  // ---------- 曲线求值 ----------
  function evalAt(p, t, out) {
    if (p.length === 2) {
      out[0] = p[0][0] + (p[1][0] - p[0][0]) * t;
      out[1] = p[0][1] + (p[1][1] - p[0][1]) * t;
    } else if (p.length === 3) {
      const u = 1 - t;
      out[0] = u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0];
      out[1] = u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1];
    } else {
      const u = 1 - t;
      out[0] = u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0];
      out[1] = u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1];
    }
  }

  // 单位切向；退化时退化为弦方向，再退化为 (1,0)
  function tanAt(p, t, out) {
    if (p.length === 2) {
      out[0] = p[1][0] - p[0][0];
      out[1] = p[1][1] - p[0][1];
    } else if (p.length === 3) {
      const u = 1 - t;
      out[0] = 2 * (u * (p[1][0] - p[0][0]) + t * (p[2][0] - p[1][0]));
      out[1] = 2 * (u * (p[1][1] - p[0][1]) + t * (p[2][1] - p[1][1]));
    } else {
      const u = 1 - t;
      out[0] = 3 * (u * u * (p[1][0] - p[0][0]) + 2 * u * t * (p[2][0] - p[1][0]) + t * t * (p[3][0] - p[2][0]));
      out[1] = 3 * (u * u * (p[1][1] - p[0][1]) + 2 * u * t * (p[2][1] - p[1][1]) + t * t * (p[3][1] - p[2][1]));
    }
    let L = Math.hypot(out[0], out[1]);
    if (L < 1e-12) {
      const a = p[0], b = p[p.length - 1];
      out[0] = b[0] - a[0]; out[1] = b[1] - a[1];
      L = Math.hypot(out[0], out[1]);
      if (L < 1e-12) { out[0] = 1; out[1] = 0; return; }
    }
    out[0] /= L; out[1] /= L;
  }

  // ---------- 最近点 ----------
  const _d2s = new Float64Array(COARSE + 1);
  const _ra = [0, 0], _rb = [0, 0];

  function refineMin(p, px, py, a, b) {
    const INVPHI = 0.6180339887498949;
    let c = b - INVPHI * (b - a), d = a + INVPHI * (b - a);
    evalAt(p, c, _ra); let fc = (_ra[0] - px) * (_ra[0] - px) + (_ra[1] - py) * (_ra[1] - py);
    evalAt(p, d, _rb); let fd = (_rb[0] - px) * (_rb[0] - px) + (_rb[1] - py) * (_rb[1] - py);
    for (let it = 0; it < 28; it++) {
      if (fc < fd) {
        b = d; d = c; fd = fc;
        c = b - INVPHI * (b - a);
        evalAt(p, c, _ra); fc = (_ra[0] - px) * (_ra[0] - px) + (_ra[1] - py) * (_ra[1] - py);
      } else {
        a = c; c = d; fc = fd;
        d = a + INVPHI * (b - a);
        evalAt(p, d, _rb); fd = (_rb[0] - px) * (_rb[0] - px) + (_rb[1] - py) * (_rb[1] - py);
      }
    }
    return (a + b) / 2;
  }

  function nearestParamCurve(seg, px, py) {
    const s = seg.samples, n = COARSE, h = 1 / n, p = seg.p;
    for (let k = 0; k <= n; k++) {
      const dx = s[2 * k] - px, dy = s[2 * k + 1] - py;
      _d2s[k] = dx * dx + dy * dy;
    }
    let bestT = 0, bestD2 = _d2s[0];
    if (_d2s[n] < bestD2) { bestD2 = _d2s[n]; bestT = 1; }
    for (let k = 0; k <= n; k++) {
      let a, b;
      if (k === 0) { if (_d2s[0] > _d2s[1]) continue; a = 0; b = h; }
      else if (k === n) { if (_d2s[n] > _d2s[n - 1]) continue; a = 1 - h; b = 1; }
      else if (_d2s[k] <= _d2s[k - 1] && _d2s[k] <= _d2s[k + 1]) { a = (k - 1) * h; b = (k + 1) * h; }
      else continue;
      const t = refineMin(p, px, py, a, b);
      evalAt(p, t, _ra);
      const dx = _ra[0] - px, dy = _ra[1] - py, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestT = t; }
    }
    return bestT;
  }

  // ---------- 有符号距离（真实 + 伪距离） ----------
  const _pt = [0, 0], _tg = [0, 0];

  // out = {t, dTrue, dPseudo}；实心侧（前进方向左侧）为正
  function segDistance(seg, px, py, out) {
    const p = seg.p;
    let t;
    if (p.length === 2) {
      const dx = p[1][0] - p[0][0], dy = p[1][1] - p[0][1];
      const L2 = dx * dx + dy * dy;
      t = L2 > 1e-18 ? clamp01(((px - p[0][0]) * dx + (py - p[0][1]) * dy) / L2) : 0;
    } else {
      t = nearestParamCurve(seg, px, py);
    }
    evalAt(p, t, _pt);
    tanAt(p, t, _tg);
    const vx = px - _pt[0], vy = py - _pt[1];
    const dist = Math.hypot(vx, vy);
    const cross = _tg[0] * vy - _tg[1] * vx;   // 切向 × 指向点：左侧为正
    const dTrue = (cross < 0 ? -1 : 1) * dist;
    let dPseudo = dTrue;
    if (t <= 0) {
      tanAt(p, 0, _tg);
      const ax = px - p[0][0], ay = py - p[0][1];
      if (ax * _tg[0] + ay * _tg[1] < 0) {          // 超出起点切线端
        const pd = _tg[0] * ay - _tg[1] * ax;
        if (Math.abs(pd) <= Math.abs(dPseudo)) dPseudo = pd;
      }
    } else if (t >= 1) {
      tanAt(p, 1, _tg);
      const e = p[p.length - 1];
      const bx = px - e[0], by = py - e[1];
      if (bx * _tg[0] + by * _tg[1] > 0) {          // 超出终点切线端
        const pd = _tg[0] * by - _tg[1] * bx;
        if (Math.abs(pd) <= Math.abs(dPseudo)) dPseudo = pd;
      }
    }
    out.t = t; out.dTrue = dTrue; out.dPseudo = dPseudo;
    return out;
  }

  // ---------- 场计算 ----------
  function newField(w, h) {
    const n = w * h;
    return {
      w, h,
      R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n), A: new Float32Array(n),
      rawR: null, rawG: null, rawB: null,
      segR: new Int16Array(n).fill(-1), segG: new Int16Array(n).fill(-1),
      segB: new Int16Array(n).fill(-1), segA: new Int16Array(n).fill(-1),
      tR: new Float32Array(n), tG: new Float32Array(n), tB: new Float32Array(n), tA: new Float32Array(n),
      corrected: null, nCorr: 0,
    };
  }

  function computeRows(segs, w, h, bounds, j0, j1, F) {
    const bw = bounds[2] - bounds[0], bh = bounds[3] - bounds[1];
    const sd = { t: 0, dTrue: 0, dPseudo: 0 };
    for (let j = j0; j < j1; j++) {
      const py = bounds[1] + (j + 0.5) * bh / h;   // Y 向上：j=0 为底行
      for (let i = 0; i < w; i++) {
        const px = bounds[0] + (i + 0.5) * bw / w;
        let bR = Infinity, bG = Infinity, bB = Infinity, bA = Infinity;
        let sR = -1, sG = -1, sB = -1, sA = -1, tR = 0, tG = 0, tB = 0, tA = 0;
        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s], bb = seg.bbox;
          const cdx = Math.max(bb[0] - px, 0, px - bb[2]);
          const cdy = Math.max(bb[1] - py, 0, py - bb[3]);
          const lim = Math.abs(bA);               // A 取全体段，|bA| 不大于任一通道最优
          if (cdx * cdx + cdy * cdy > lim * lim) continue;
          segDistance(seg, px, py, sd);
          const at = Math.abs(sd.dTrue), ap = Math.abs(sd.dPseudo);
          if (at < Math.abs(bA)) { bA = sd.dTrue; sA = s; tA = sd.t; }
          if ((seg.bits & BIT.R) && ap < Math.abs(bR)) { bR = sd.dPseudo; sR = s; tR = sd.t; }
          if ((seg.bits & BIT.G) && ap < Math.abs(bG)) { bG = sd.dPseudo; sG = s; tG = sd.t; }
          if ((seg.bits & BIT.B) && ap < Math.abs(bB)) { bB = sd.dPseudo; sB = s; tB = sd.t; }
        }
        const idx = j * w + i;
        F.R[idx] = bR; F.G[idx] = bG; F.B[idx] = bB; F.A[idx] = bA;
        F.segR[idx] = sR; F.segG[idx] = sG; F.segB[idx] = sB; F.segA[idx] = sA;
        F.tR[idx] = tR; F.tG[idx] = tG; F.tB[idx] = tB; F.tA[idx] = tA;
      }
    }
  }

  // RGB 中位数与 A 异号的纹素用 A 修正
  function applyCorrection(F) {
    const n = F.w * F.h;
    F.rawR = F.R.slice(); F.rawG = F.G.slice(); F.rawB = F.B.slice();
    F.corrected = new Uint8Array(n);
    F.nCorr = 0;
    for (let idx = 0; idx < n; idx++) {
      const m = median3(F.R[idx], F.G[idx], F.B[idx]);
      const a = F.A[idx];
      if (m * a < 0) {
        F.R[idx] = F.G[idx] = F.B[idx] = a;
        F.corrected[idx] = 1;
        F.nCorr++;
      }
    }
    return F;
  }

  function computeFieldSync(segs, w, h, bounds) {
    const F = newField(w, h);
    computeRows(segs, w, h, bounds, 0, h, F);
    return applyCorrection(F);
  }

  async function computeField(segs, w, h, bounds, opts) {
    opts = opts || {};
    const F = newField(w, h);
    const step = opts.rowsPerChunk || 8;
    for (let j = 0; j < h; j += step) {
      computeRows(segs, w, h, bounds, j, Math.min(h, j + step), F);
      if (opts.onProgress) opts.onProgress(Math.min(h, j + step) / h);
      await new Promise(r => setTimeout(r, 0));
      if (opts.shouldCancel && opts.shouldCancel()) return null;
    }
    return applyCorrection(F);
  }

  // ---------- 编码 ----------
  // 零距离 → 0.5，+range → 1，-range → 0
  function encodeDist(d, range) {
    const v = 0.5 + 0.5 * d / range;
    return Math.round(clamp01(v) * 255);
  }

  // 返回 RGBA 字节，纹素顺序（j 向上）
  function encodeField(F, range) {
    const n = F.w * F.h;
    const out = new Uint8Array(n * 4);
    for (let idx = 0; idx < n; idx++) {
      out[idx * 4] = encodeDist(F.R[idx], range);
      out[idx * 4 + 1] = encodeDist(F.G[idx], range);
      out[idx * 4 + 2] = encodeDist(F.B[idx], range);
      out[idx * 4 + 3] = encodeDist(F.A[idx], range);
    }
    return out;
  }

  // 纹素序（j 向上）→ PNG 序（顶行在前）
  function flipRowsTopFirst(rgba, w, h) {
    const out = new Uint8Array(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const j = h - 1 - y;
      out.set(rgba.subarray(j * row, (j + 1) * row), y * row);
    }
    return out;
  }

  // ---------- PNG（8bit RGBA、无滤波、zlib 存储块；线性、无预乘、无色彩块） ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(8 + data.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const crc = crc32(out.subarray(4, 8 + data.length));
    dv.setUint32(8 + data.length, crc);
    return out;
  }

  function zlibStore(raw) {
    const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
    const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
    const dv = new DataView(out.buffer);
    out[0] = 0x78; out[1] = 0x01;
    let off = 0, pos = 2;
    do {
      const len = Math.min(65535, raw.length - off);
      const last = off + len >= raw.length;
      out[pos] = last ? 1 : 0;
      dv.setUint16(pos + 1, len, true);
      dv.setUint16(pos + 3, (~len) & 0xFFFF, true);
      out.set(raw.subarray(off, off + len), pos + 5);
      pos += 5 + len;
      off += len;
    } while (off < raw.length);
    dv.setUint32(pos, adler32(raw));
    return out;
  }

  // rgbaTopFirst：顶行在前的 RGBA 字节
  function pngEncode(w, h, rgbaTopFirst) {
    const stride = w * 4 + 1;
    const raw = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      raw[y * stride] = 0; // 滤波类型 0
      raw.set(rgbaTopFirst.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 8;  // 位深
    ihdr[9] = 6;  // RGBA
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibStore(raw)), pngChunk('IEND', new Uint8Array(0))];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  return {
    COARSE, MASKS, BIT,
    clamp01, median3, maskBits,
    validateDoc, prepSegments,
    evalAt, tanAt, segDistance,
    newField, computeRows, applyCorrection, computeFieldSync, computeField,
    encodeDist, encodeField, flipRowsTopFirst,
    crc32, adler32, zlibStore, pngEncode,
  };
});
