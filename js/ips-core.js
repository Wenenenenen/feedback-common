/* 核心算法：sRGB 转换、颜色统计、确定性中位切分、线性 RGB 最近色、蛇形误差扩散
 * 细则见 samples 包内《约定.json》。本文件不依赖 DOM，可在 Node 中测试。 */
(function () {
  const IPS = (globalThis.IPS = globalThis.IPS || {});

  // ---------- 校验和 ----------
  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  IPS.crc32 = function (data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  IPS.adler32 = function (data) {
    let a = 1, b = 0;
    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  };

  // ---------- sRGB <-> 线性 RGB ----------
  const S2L = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  IPS.SRGB_TO_LINEAR = S2L;
  IPS.linearToSrgbByte = function (l) {
    if (!(l > 0)) return 0;
    if (l >= 1) return 255;
    const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return Math.round(c * 255);
  };

  // ---------- 图像内容哈希（用于把图片集规范化为与导入顺序无关的顺序） ----------
  // cyrb53 变体，对 宽高+像素 做 53 位哈希；相同内容必然同哈希。
  IPS.imageHash = function (img) {
    const d = img.data;
    let h1 = 0xdeadbeef ^ img.width ^ (img.height << 8);
    let h2 = 0x41c6ce57 ^ img.height ^ (img.width << 8);
    for (let i = 0; i < d.length; i++) {
      h1 = Math.imul(h1 ^ d[i], 2654435761);
      h2 = Math.imul(h2 ^ d[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  };

  // ---------- 颜色统计 ----------
  // 仅 alpha>=128 参与；编码 RGB 各右移 3 位组成 5 位颜色箱；
  // 箱记录像素数与各线性 RGB 通道和。返回按箱键升序的数组（顺序确定）。
  IPS.buildBins = function (images) {
    const map = new Map(); // key -> {key,count,sr,sg,sb}
    for (const img of images) {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let bin = map.get(key);
        if (!bin) {
          bin = { key, count: 0, sr: 0, sg: 0, sb: 0 };
          map.set(key, bin);
        }
        bin.count++;
        bin.sr += S2L[r];
        bin.sg += S2L[g];
        bin.sb += S2L[b];
      }
    }
    return [...map.values()].sort((a, b) => a.key - b.key);
  };

  // ---------- 确定性中位切分 ----------
  function makeBox(bins, created) {
    let pop = 0;
    let minR = 32, maxR = -1, minG = 32, maxG = -1, minB = 32, maxB = -1;
    let minKey = Infinity;
    for (const bin of bins) {
      pop += bin.count;
      const r = (bin.key >> 10) & 31, g = (bin.key >> 5) & 31, b = bin.key & 31;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
      if (bin.key < minKey) minKey = bin.key;
    }
    return {
      bins, created, pop, minKey,
      minR, maxR, minG, maxG, minB, maxB,
      range: Math.max(maxR - minR, maxG - minG, maxB - minB),
    };
  }

  // bins：buildBins 的输出；maxColors：不透明代表色上限（K-1）
  IPS.medianCut = function (bins, maxColors) {
    if (bins.length === 0 || maxColors <= 0) return [];
    let created = 0;
    let boxes = [makeBox(bins, created++)];
    while (boxes.length < maxColors) {
      // 选最大坐标极差最高的可分盒；平局依次以人口多、创建序号小破平局
      let bi = -1;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.bins.length < 2) continue; // 不能再分则跳过
        if (bi < 0) { bi = i; continue; }
        const a = boxes[bi];
        if (
          b.range > a.range ||
          (b.range === a.range &&
            (b.pop > a.pop || (b.pop === a.pop && b.created < a.created)))
        ) {
          bi = i;
        }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      // 切轴：最大极差，平局 R 再 G 再 B
      const rR = box.maxR - box.minR, rG = box.maxG - box.minG, rB = box.maxB - box.minB;
      const axis = rR >= rG && rR >= rB ? 0 : rG >= rB ? 1 : 2;
      const shift = axis === 0 ? 10 : axis === 1 ? 5 : 0;
      // 按该轴再 RGB 箱键字典序排序
      const sorted = box.bins.slice().sort((a, b) => {
        const ca = (a.key >> shift) & 31, cb = (b.key >> shift) & 31;
        return ca - cb || a.key - b.key;
      });
      // 累计人口首次达到总人口一半的位置；若会使右侧空则在最后一箱之前切
      const total = box.pop;
      let cum = 0, cut = sorted.length - 1;
      for (let i = 0; i < sorted.length; i++) {
        cum += sorted[i].count;
        if (cum * 2 >= total) { cut = i + 1; break; }
      }
      if (cut >= sorted.length) cut = sorted.length - 1;
      const left = makeBox(sorted.slice(0, cut), created++); // 左盒先创建
      const right = makeBox(sorted.slice(cut), created++);
      boxes.splice(bi, 1, left, right);
    }
    return boxes;
  };

  // ---------- 色表 ----------
  // 盒代表色 = 盒内实际像素的线性 RGB 加权均值，sRGB 编码并四舍五入；
  // 最终盒按最小 RGB 箱键排序分配槽 1 起；槽 0 固定为黑色透明槽。
  IPS.buildPalette = function (boxes) {
    const colors = [{ r: 0, g: 0, b: 0, a: 0 }];
    const sorted = boxes.slice().sort((a, b) => a.minKey - b.minKey);
    for (const box of sorted) {
      let sr = 0, sg = 0, sb = 0;
      for (const bin of box.bins) {
        sr += bin.sr;
        sg += bin.sg;
        sb += bin.sb;
      }
      colors.push({
        r: IPS.linearToSrgbByte(sr / box.pop),
        g: IPS.linearToSrgbByte(sg / box.pop),
        b: IPS.linearToSrgbByte(sb / box.pop),
        a: 255,
      });
    }
    return colors;
  };

  // 不透明槽（1..n-1）解码后的线性 RGB，供最近色距离使用
  function paletteLinear(colors) {
    const n = colors.length - 1;
    const out = new Float64Array(Math.max(0, n) * 3);
    for (let i = 1; i < colors.length; i++) {
      out[(i - 1) * 3] = S2L[colors[i].r];
      out[(i - 1) * 3 + 1] = S2L[colors[i].g];
      out[(i - 1) * 3 + 2] = S2L[colors[i].b];
    }
    return out;
  }
  IPS.paletteLinear = paletteLinear;

  // 线性 RGB 平方距离最近色，平局取最小索引；返回 0 基的不透明槽序号
  function nearest(r, g, b, pal) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i += 3) {
      const dr = r - pal[i], dg = g - pal[i + 1], db = b - pal[i + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i / 3; }
    }
    return best;
  }

  // ---------- 量化单张图 ----------
  // img: {width,height,data(RGBA)}；colors：含槽 0 的色表；dither：是否蛇形误差扩散
  // 返回 {indices, heat, usage}：槽索引、线性 RGB 均方根误差热图（透明为 0）、各槽使用量（含槽 0）
  IPS.quantizeImage = function (img, colors, dither) {
    const w = img.width, h = img.height, data = img.data;
    const nSlots = colors.length;
    const indices = new Uint8Array(w * h);
    const heat = new Float32Array(w * h);
    const usage = new Uint32Array(nSlots);
    const pal = paletteLinear(colors);
    const nOpaque = pal.length / 3;
    if (nOpaque === 0) {
      // 全透明组：色表只有透明槽，全部像素落槽 0
      usage[0] = w * h;
      return { indices, heat, usage };
    }
    const opaqueMask = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      opaqueMask[p] = data[i + 3] >= 128 ? 1 : 0;
    }

    if (!dither) {
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        if (!opaqueMask[p]) { usage[0]++; continue; }
        const r = S2L[data[i]], g = S2L[data[i + 1]], b = S2L[data[i + 2]];
        const s = nearest(r, g, b, pal);
        indices[p] = s + 1;
        usage[s + 1]++;
        const dr = r - pal[s * 3], dg = g - pal[s * 3 + 1], db = b - pal[s * 3 + 2];
        heat[p] = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      }
      return { indices, heat, usage };
    }

    // 蛇形 Floyd–Steinberg 误差扩散：偶数行从左往右，奇数行镜像
    const acc = new Float64Array(w * h * 3);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (!opaqueMask[p]) continue;
      acc[p * 3] = S2L[data[i]];
      acc[p * 3 + 1] = S2L[data[i + 1]];
      acc[p * 3 + 2] = S2L[data[i + 2]];
    }
    for (let y = 0; y < h; y++) {
      const ltr = y % 2 === 0;
      for (let xi = 0; xi < w; xi++) {
        const x = ltr ? xi : w - 1 - xi;
        const p = y * w + x;
        if (!opaqueMask[p]) continue; // 透明像素不接收、不传播
        let r = acc[p * 3], g = acc[p * 3 + 1], b = acc[p * 3 + 2];
        // 累积误差后先逐通道限幅到 [0,1]
        r = r < 0 ? 0 : r > 1 ? 1 : r;
        g = g < 0 ? 0 : g > 1 ? 1 : g;
        b = b < 0 ? 0 : b > 1 ? 1 : b;
        const s = nearest(r, g, b, pal);
        indices[p] = s + 1;
        usage[s + 1]++;
        const er = r - pal[s * 3], eg = g - pal[s * 3 + 1], eb = b - pal[s * 3 + 2];
        heat[p] = Math.sqrt((er * er + eg * eg + eb * eb) / 3);
        const dx = ltr ? 1 : -1;
        // 右 7/16、下左 3/16、下 5/16、下右 1/16（奇数行镜像）；越界权重丢弃
        if (x + dx >= 0 && x + dx < w) spread(p + dx, 7 / 16);
        if (y + 1 < h) {
          if (x - dx >= 0 && x - dx < w) spread(p + w - dx, 3 / 16);
          spread(p + w, 5 / 16);
          if (x + dx >= 0 && x + dx < w) spread(p + w + dx, 1 / 16);
        }
        function spread(q, f) {
          if (!opaqueMask[q]) return; // 透明像素不接收
          acc[q * 3] += er * f;
          acc[q * 3 + 1] += eg * f;
          acc[q * 3 + 2] += eb * f;
        }
      }
    }
    return { indices, heat, usage };
  };
})();
