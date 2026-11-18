/*
 * CLAHE（限制对比度的自适应直方图均衡）核心实现。
 * 约定（与 samples/clahe-tile-equalizer-cases.zip 内《格式说明.md》一致）：
 * - 分块边界：第 i 列分块覆盖 x 从 floor(i*W/tx) 到 floor((i+1)*W/tx)-1，行同理。
 * - 裁剪上限 limit = max(1, floor(clip*N/256))；clip 为 0 表示不裁剪。
 * - 超出总数 E 先截到 limit，再给每个 bin 加 floor(E/256)，余数 r=E mod 256
 *   分给下标 0..r-1 的 bin 各加 1，不再重复裁剪。
 * - 映射表 map[v] = floor(255*cdf[v]/N + 0.5)，cdf 为含 v 的累计和。
 * - 分块中心取像素下标 (左边界+右边界)/2；中心之外用最近分块，否则双线性插值；
 *   灰度输出 floor(Y'+0.5)。
 * - RGB：Y = 0.299R+0.587G+0.114B，yi = floor(Y+0.5) 查表并插值得 Y'；
 *   Y 为 0 时三通道都输出 floor(Y'+0.5)，否则 min(255, floor(c*Y'/Y+0.5))。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CLAHE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 每个分块在该轴上的 [起, 止] 像素下标（含止）
  function tileBounds(len, n) {
    const b = [];
    for (let i = 0; i < n; i++) {
      b.push([Math.floor((i * len) / n), Math.floor(((i + 1) * len) / n) - 1]);
    }
    return b;
  }

  // 统计各分块直方图、裁剪并重分配、生成映射表。
  // luma: Uint8Array(W*H)。返回行优先排列的分块数组。
  function computeTiles(luma, W, H, tx, ty, clip) {
    const xb = tileBounds(W, tx);
    const yb = tileBounds(H, ty);
    const tiles = [];
    for (let j = 0; j < ty; j++) {
      for (let i = 0; i < tx; i++) {
        const x0 = xb[i][0], x1 = xb[i][1];
        const y0 = yb[j][0], y1 = yb[j][1];
        const N = (x1 - x0 + 1) * (y1 - y0 + 1);
        const hist = new Uint32Array(256);
        for (let y = y0; y <= y1; y++) {
          const row = y * W;
          for (let x = x0; x <= x1; x++) hist[luma[row + x]]++;
        }
        const clipped = Uint32Array.from(hist);
        if (clip > 0) {
          const limit = Math.max(1, Math.floor((clip * N) / 256));
          let E = 0;
          for (let v = 0; v < 256; v++) {
            if (clipped[v] > limit) {
              E += clipped[v] - limit;
              clipped[v] = limit;
            }
          }
          const add = Math.floor(E / 256);
          const r = E % 256;
          for (let v = 0; v < 256; v++) clipped[v] += add;
          for (let v = 0; v < r; v++) clipped[v] += 1;
        }
        const map = new Uint8Array(256);
        let cdf = 0;
        for (let v = 0; v < 256; v++) {
          cdf += clipped[v];
          map[v] = Math.floor((255 * cdf) / N + 0.5);
        }
        tiles.push({ x0, x1, y0, y1, N, hist, clipped, map });
      }
    }
    return tiles;
  }

  // 沿一个轴为每个像素预计算相邻分块下标与插值权重
  function axisWeights(len, n) {
    const bounds = tileBounds(len, n);
    const centers = bounds.map((b) => (b[0] + b[1]) / 2);
    const i0 = new Uint16Array(len);
    const i1 = new Uint16Array(len);
    const f = new Float64Array(len);
    for (let p = 0; p < len; p++) {
      if (n === 1 || p <= centers[0]) {
        i0[p] = i1[p] = 0;
      } else if (p >= centers[n - 1]) {
        i0[p] = i1[p] = n - 1;
      } else {
        let i = 0;
        while (p > centers[i + 1]) i++;
        i0[p] = i;
        i1[p] = i + 1;
        f[p] = (p - centers[i]) / (centers[i + 1] - centers[i]);
      }
    }
    return { i0, i1, f };
  }

  // 对整图的每个亮度值做双线性插值查表，返回 Float64Array(W*H) 的 Y'
  function interpolateMaps(tiles, W, H, tx, ty, values) {
    const ax = axisWeights(W, tx);
    const ay = axisWeights(H, ty);
    const out = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
      const j0 = ay.i0[y], j1 = ay.i1[y], fy = ay.f[y];
      const rowA = j0 * tx, rowB = j1 * tx;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i0 = ax.i0[x], i1 = ax.i1[x], fx = ax.f[x];
        const v = values[row + x];
        const m00 = tiles[rowA + i0].map[v];
        const m01 = tiles[rowA + i1].map[v];
        const m10 = tiles[rowB + i0].map[v];
        const m11 = tiles[rowB + i1].map[v];
        // 双线性组合（不取整）；用 (1-f)*a+f*b 的加权形式，
        // 与包内约定在 .5 边界上的浮点行为一致
        const top = m00 * (1 - fx) + m01 * fx;
        const bot = m10 * (1 - fx) + m11 * fx;
        out[row + x] = top * (1 - fy) + bot * fy;
      }
    }
    return out;
  }

  // 灰度图：luma 即输入，返回 { out: Uint8Array, tiles }
  function applyGray(luma, W, H, tx, ty, clip) {
    const tiles = computeTiles(luma, W, H, tx, ty, clip);
    const yp = interpolateMaps(tiles, W, H, tx, ty, luma);
    const out = new Uint8Array(W * H);
    for (let p = 0; p < out.length; p++) out[p] = Math.floor(yp[p] + 0.5);
    return { out, tiles };
  }

  // 彩色图：rgb 为 Uint8Array(W*H*3)，只处理亮度。
  // 返回 { out: Uint8Array(W*H*3), luma: Uint8Array, tiles }
  function applyRgb(rgb, W, H, tx, ty, clip) {
    const n = W * H;
    const luma = new Uint8Array(n);
    const yFloat = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      const r = rgb[p * 3], g = rgb[p * 3 + 1], b = rgb[p * 3 + 2];
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      yFloat[p] = Y;
      luma[p] = Math.floor(Y + 0.5);
    }
    const tiles = computeTiles(luma, W, H, tx, ty, clip);
    const yp = interpolateMaps(tiles, W, H, tx, ty, luma);
    const out = new Uint8Array(W * H * 3);
    for (let p = 0; p < n; p++) {
      const Y = yFloat[p];
      const Yp = yp[p];
      if (Y === 0) {
        const v = Math.floor(Yp + 0.5);
        out[p * 3] = out[p * 3 + 1] = out[p * 3 + 2] = v;
      } else {
        for (let c = 0; c < 3; c++) {
          out[p * 3 + c] = Math.min(255, Math.floor((rgb[p * 3 + c] * Yp) / Y + 0.5));
        }
      }
    }
    return { out, luma, tiles };
  }

  // 导出映射表 JSON 对象（行优先）
  function mapsToJSON(tiles, tx, ty, clip) {
    return {
      tiles: [tx, ty],
      clip,
      maps: tiles.map((t) => Array.from(t.map)),
    };
  }

  return { tileBounds, computeTiles, applyGray, applyRgb, mapsToJSON };
});
