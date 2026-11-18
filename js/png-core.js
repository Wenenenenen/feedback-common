/*
 * png-core.js — PNG 扫描行级解码 / 重编码核心库
 *
 * 自行实现：块解析、CRC32、五种扫描行过滤、Adam7 隔行重组、位打包/解包。
 * 仅 zlib 压缩解压借助平台能力（DecompressionStream / CompressionStream，
 * 浏览器与 Node 18+ 均原生支持），不使用任何图像库或浏览器图像解码。
 *
 * 浏览器：挂到 window.PNGCore；Node：module.exports。
 *
 * 接受的格式（见 samples/约定.json）：
 *   颜色类型 0（灰度）8/16 位；类型 2（RGB）/6（RGBA）8 位；
 *   类型 3（索引色）1/2/4/8 位。压缩=0，过滤=0，隔行=0 或 1（Adam7）。
 *   宽高 1..2048，文件 ≤ 20MB。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PNGCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const MAX_DIM = 2048;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  // 约定允许的颜色类型 -> 位深组合（类型 4 不在范围内）
  const ALLOWED_DEPTHS = { 0: [8, 16], 2: [8], 3: [1, 2, 4, 8], 6: [8] };
  const COLOR_TYPE_NAMES = {
    0: '灰度', 2: 'RGB', 3: '索引色', 4: '灰度+Alpha', 6: 'RGBA',
  };
  const FILTER_NAMES = ['None', 'Sub', 'Up', 'Average', 'Paeth'];

  // Adam7: (startX, startY, stepX, stepY)，pass 编号 1..7
  const ADAM7 = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ];

  /** 带位置信息的错误，loc 形如 {chunkIndex,type,offset} 或 {pass,row} */
  class PNGError extends Error {
    constructor(message, loc) {
      super(message);
      this.name = 'PNGError';
      this.loc = loc || null;
      this.partialChunks = null; // 解析出错前已成功解析的块（供界面展示）
    }
  }

  /* ---------------- CRC32 ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- zlib（平台原生） ---------------- */
  async function inflate(data) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function deflate(data) {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* ---------------- 工具 ---------------- */
  function u32be(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function hex(n, w) {
    return '0x' + n.toString(16).toUpperCase().padStart(w, '0');
  }
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    // 平局按 左、上、左上 优先
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  /** bpp = max(1, ceil(通道数 * 位深 / 8)) */
  function bppOf(channels, depth) {
    return Math.max(1, Math.ceil((channels * depth) / 8));
  }
  function rowBytesOf(width, channels, depth) {
    return Math.ceil((width * channels * depth) / 8);
  }

  /* ---------------- 第一步：块解析 + CRC ---------------- */
  function parseChunks(bytes) {
    if (bytes.length > MAX_FILE_BYTES) {
      throw new PNGError(
        `文件大小 ${bytes.length} 字节，超过 20MB 限制`, null);
    }
    if (bytes.length < 8) {
      throw new PNGError(`文件仅 ${bytes.length} 字节，不足 PNG 签名长度（文件被截断）`, { offset: 0 });
    }
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) {
        throw new PNGError(
          `PNG 签名不匹配：字节 ${i} 为 ${hex(bytes[i])}，应为 ${hex(PNG_SIGNATURE[i])}`,
          { offset: i });
      }
    }
    const chunks = [];
    let off = 8;
    while (off < bytes.length) {
      const idx = chunks.length;
      if (off + 8 > bytes.length) {
        const e = new PNGError(
          `块 #${idx} 头部不完整：偏移 ${hex(off)} 处仅剩 ${bytes.length - off} 字节（文件被截断）`,
          { chunkIndex: idx, offset: off });
        e.partialChunks = chunks;
        throw e;
      }
      const length = u32be(bytes, off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (!/^[A-Za-z]{4}$/.test(type)) {
        const e = new PNGError(
          `块 #${idx}（偏移 ${hex(off)}）类型含非法字符`, { chunkIndex: idx, type, offset: off });
        e.partialChunks = chunks;
        throw e;
      }
      if (off + 12 + length > bytes.length) {
        const e = new PNGError(
          `块 #${idx} (${type}) 声明数据长度 ${length} 字节，超出文件剩余 ` +
          `${bytes.length - off - 12} 字节（文件被截断）`,
          { chunkIndex: idx, type, offset: off });
        e.partialChunks = chunks;
        throw e;
      }
      // CRC 覆盖 类型 + 数据
      const crcActual = crc32(bytes, off + 4, off + 8 + length);
      const crcExpected = u32be(bytes, off + 8 + length);
      if (crcActual !== crcExpected) {
        const e = new PNGError(
          `块 #${idx} (${type}) CRC 校验失败：存储值 ${hex(crcExpected, 8)}，` +
          `计算值 ${hex(crcActual, 8)}（偏移 ${hex(off)}，长度 ${length}）`,
          { chunkIndex: idx, type, offset: off });
        e.partialChunks = chunks;
        throw e;
      }
      chunks.push({
        index: idx, type, offset: off, length,
        data: bytes.subarray(off + 8, off + 8 + length),
        crc: crcExpected,
      });
      off += 12 + length;
    }
    return chunks;
  }

  /* ---------------- 第二步：结构校验 ---------------- */
  function validateStructure(chunks) {
    if (chunks.length === 0) throw new PNGError('文件内没有任何块');
    if (chunks[0].type !== 'IHDR') {
      throw new PNGError(
        `第一个块应为 IHDR，实际为 ${chunks[0].type}（块 #0，偏移 ${hex(chunks[0].offset)}）`,
        { chunkIndex: 0, type: chunks[0].type, offset: chunks[0].offset });
    }
    const count = (t) => chunks.filter((c) => c.type === t).length;
    if (count('IHDR') > 1) {
      const dup = chunks.filter((c) => c.type === 'IHDR')[1];
      throw new PNGError(`IHDR 块不唯一：第二个出现在块 #${dup.index}（偏移 ${hex(dup.offset)}）`,
        { chunkIndex: dup.index, type: 'IHDR', offset: dup.offset });
    }
    if (count('IEND') === 0) throw new PNGError('缺少 IEND 块（文件不完整）');
    if (count('IEND') > 1) {
      const dup = chunks.filter((c) => c.type === 'IEND')[1];
      throw new PNGError(`IEND 块不唯一：第二个出现在块 #${dup.index}`,
        { chunkIndex: dup.index, type: 'IEND', offset: dup.offset });
    }
    const last = chunks[chunks.length - 1];
    if (last.type !== 'IEND') {
      throw new PNGError(
        `IEND 之后存在块 #${last.index} (${last.type})（偏移 ${hex(last.offset)}），IEND 必须为最后一个块`,
        { chunkIndex: last.index, type: last.type, offset: last.offset });
    }
    if (last.length !== 0) {
      throw new PNGError(`IEND 块长度应为 0，实际 ${last.length}`,
        { chunkIndex: last.index, type: 'IEND', offset: last.offset });
    }

    // IHDR 字段
    const ihdrChunk = chunks[0];
    if (ihdrChunk.length !== 13) {
      throw new PNGError(`IHDR 长度应为 13，实际 ${ihdrChunk.length}`,
        { chunkIndex: 0, type: 'IHDR', offset: ihdrChunk.offset });
    }
    const d = ihdrChunk.data;
    const ihdr = {
      width: u32be(d, 0), height: u32be(d, 4),
      depth: d[8], colorType: d[9],
      compression: d[10], filter: d[11], interlace: d[12],
    };
    if (ihdr.width < 1 || ihdr.height < 1 || ihdr.width > MAX_DIM || ihdr.height > MAX_DIM) {
      throw new PNGError(
        `IHDR 尺寸 ${ihdr.width}×${ihdr.height} 超出允许范围 1..${MAX_DIM}`,
        { chunkIndex: 0, type: 'IHDR' });
    }
    const allowed = ALLOWED_DEPTHS[ihdr.colorType];
    if (!allowed) {
      throw new PNGError(
        `不支持的颜色类型 ${ihdr.colorType}` +
        (COLOR_TYPE_NAMES[ihdr.colorType] ? `（${COLOR_TYPE_NAMES[ihdr.colorType]}）` : '') +
        '（本工具接受 0/2/3/6）',
        { chunkIndex: 0, type: 'IHDR' });
    }
    if (!allowed.includes(ihdr.depth)) {
      throw new PNGError(
        `颜色类型 ${ihdr.colorType}（${COLOR_TYPE_NAMES[ihdr.colorType]}）不允许位深 ${ihdr.depth}` +
        `（允许 ${allowed.join('/')}）`,
        { chunkIndex: 0, type: 'IHDR' });
    }
    if (ihdr.compression !== 0) {
      throw new PNGError(`IHDR 压缩方法 ${ihdr.compression} 不支持（应为 0）`, { chunkIndex: 0, type: 'IHDR' });
    }
    if (ihdr.filter !== 0) {
      throw new PNGError(`IHDR 过滤方法 ${ihdr.filter} 不支持（应为 0）`, { chunkIndex: 0, type: 'IHDR' });
    }
    if (ihdr.interlace !== 0 && ihdr.interlace !== 1) {
      throw new PNGError(`IHDR 隔行方法 ${ihdr.interlace} 不支持（应为 0 或 1）`, { chunkIndex: 0, type: 'IHDR' });
    }

    // 顺序 / 未知关键块 / PLTE / tRNS / IDAT 连续性
    let plte = null, trns = null;
    const idatChunks = [];
    let idatStarted = false, idatEnded = false;
    for (const c of chunks) {
      if (c.type === 'IHDR' || c.type === 'IEND') continue;
      const isCritical = (c.type.charCodeAt(0) & 0x20) === 0;
      const known = c.type === 'PLTE' || c.type === 'tRNS' || c.type === 'IDAT';
      if (!known && isCritical) {
        throw new PNGError(
          `未知关键块 ${c.type}（块 #${c.index}，偏移 ${hex(c.offset)}，长度 ${c.length}），无法安全解码`,
          { chunkIndex: c.index, type: c.type, offset: c.offset });
      }
      if (c.type === 'IDAT') {
        if (idatEnded) {
          throw new PNGError(
            `IDAT 块不连续：块 #${c.index} 出现在其他块之后`,
            { chunkIndex: c.index, type: 'IDAT', offset: c.offset });
        }
        idatStarted = true;
        idatChunks.push(c);
        continue;
      }
      if (idatStarted) idatEnded = true;
      if (c.type === 'PLTE') {
        if (plte) {
          throw new PNGError(`PLTE 块不唯一：第二个出现在块 #${c.index}`,
            { chunkIndex: c.index, type: 'PLTE', offset: c.offset });
        }
        if (idatStarted) {
          throw new PNGError(`PLTE 必须位于 IDAT 之前（块 #${c.index}）`,
            { chunkIndex: c.index, type: 'PLTE', offset: c.offset });
        }
        if (c.length === 0 || c.length % 3 !== 0 || c.length / 3 > 256) {
          throw new PNGError(`PLTE 长度 ${c.length} 非法（应为 3..768 且为 3 的倍数）`,
            { chunkIndex: c.index, type: 'PLTE', offset: c.offset });
        }
        plte = c;
      } else if (c.type === 'tRNS') {
        if (trns) {
          throw new PNGError(`tRNS 块不唯一：第二个出现在块 #${c.index}`,
            { chunkIndex: c.index, type: 'tRNS', offset: c.offset });
        }
        if (idatStarted) {
          throw new PNGError(`tRNS 必须位于 IDAT 之前（块 #${c.index}）`,
            { chunkIndex: c.index, type: 'tRNS', offset: c.offset });
        }
        trns = c;
      }
      // 其他辅助块（tEXt、gAMA 等）：记录但忽略
    }

    // PLTE 必要性
    if (ihdr.colorType === 3 && !plte) {
      throw new PNGError('索引色（类型 3）缺少必需的 PLTE 块');
    }
    if (ihdr.colorType === 0 && plte) {
      throw new PNGError(`灰度（类型 0）不允许出现 PLTE 块（块 #${plte.index}）`,
        { chunkIndex: plte.index, type: 'PLTE', offset: plte.offset });
    }
    if (plte && ihdr.colorType === 3 && plte.length / 3 > (1 << ihdr.depth)) {
      throw new PNGError(
        `PLTE 条目数 ${plte.length / 3} 超过位深 ${ihdr.depth} 允许的最大值 ${1 << ihdr.depth}`,
        { chunkIndex: plte.index, type: 'PLTE', offset: plte.offset });
    }

    // tRNS 与颜色类型的匹配
    if (trns) {
      if (ihdr.colorType === 6 || ihdr.colorType === 4) {
        throw new PNGError(`颜色类型 ${ihdr.colorType} 不允许 tRNS 块（块 #${trns.index}）`,
          { chunkIndex: trns.index, type: 'tRNS', offset: trns.offset });
      }
      if (ihdr.colorType === 3) {
        if (plte && trns.length > plte.length / 3) {
          throw new PNGError(
            `tRNS 长度 ${trns.length} 超过 PLTE 条目数 ${plte.length / 3}`,
            { chunkIndex: trns.index, type: 'tRNS', offset: trns.offset });
        }
      } else {
        const need = ihdr.colorType === 0 ? 2 : 6;
        if (trns.length !== need) {
          throw new PNGError(
            `tRNS 长度应为 ${need}（颜色类型 ${ihdr.colorType}），实际 ${trns.length}`,
            { chunkIndex: trns.index, type: 'tRNS', offset: trns.offset });
        }
      }
    }

    if (idatChunks.length === 0) throw new PNGError('缺少 IDAT 块');

    const idatData = new Uint8Array(idatChunks.reduce((s, c) => s + c.length, 0));
    let p = 0;
    for (const c of idatChunks) { idatData.set(c.data, p); p += c.length; }

    // 解析 PLTE / tRNS 内容
    let palette = null;
    if (plte) {
      palette = [];
      for (let i = 0; i < plte.length; i += 3) {
        palette.push([plte.data[i], plte.data[i + 1], plte.data[i + 2]]);
      }
    }
    let transparency = null;
    if (trns) {
      if (ihdr.colorType === 3) {
        transparency = Array.from(trns.data);
      } else if (ihdr.colorType === 0) {
        transparency = [(trns.data[0] << 8) | trns.data[1]];
      } else {
        transparency = [
          (trns.data[0] << 8) | trns.data[1],
          (trns.data[2] << 8) | trns.data[3],
          (trns.data[4] << 8) | trns.data[5],
        ];
      }
    }

    return { ihdr, palette, transparency, idatData, idatChunks };
  }

  /* ---------------- 扫描行过滤 ---------------- */
  /** 对一行做反过滤。cur/prev 为 Uint8Array，结果写入 out（可与 cur 相同）。 */
  function unfilterRow(filter, cur, prev, out, bpp) {
    const n = cur.length;
    switch (filter) {
      case 0:
        out.set(cur);
        break;
      case 1: // Sub
        for (let i = 0; i < n; i++) {
          out[i] = (cur[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < n; i++) out[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3: // Average
        for (let i = 0; i < n; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          out[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < n; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          const c = i >= bpp ? prev[i - bpp] : 0;
          out[i] = (cur[i] + paeth(a, prev[i], c)) & 0xff;
        }
        break;
      default:
        throw new Error('unfilterRow: 非法过滤类型 ' + filter);
    }
  }

  /** 正向过滤：raw -> out（out 不得与 raw 相同） */
  function filterRow(filter, raw, prev, out, bpp) {
    const n = raw.length;
    switch (filter) {
      case 0:
        out.set(raw);
        break;
      case 1:
        for (let i = 0; i < n; i++) {
          out[i] = (raw[i] - (i >= bpp ? raw[i - bpp] : 0)) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < n; i++) out[i] = (raw[i] - prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < n; i++) {
          const a = i >= bpp ? raw[i - bpp] : 0;
          out[i] = (raw[i] - ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < n; i++) {
          const a = i >= bpp ? raw[i - bpp] : 0;
          const c = i >= bpp ? prev[i - bpp] : 0;
          out[i] = (raw[i] - paeth(a, prev[i], c)) & 0xff;
        }
        break;
      default:
        throw new Error('filterRow: 非法过滤类型 ' + filter);
    }
  }

  /** 过滤后字节按有符号 int8 取绝对值求和（自动择优的代价函数） */
  function filterCost(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] >= 128 ? buf[i] - 256 : buf[i];
      s += v < 0 ? -v : v;
    }
    return s;
  }

  /** 自动择优：五种过滤各算一遍，代价最小者，平局取编号小者 */
  function chooseFilter(raw, prev, bpp, scratch) {
    let best = 0, bestCost = Infinity;
    for (let f = 0; f <= 4; f++) {
      filterRow(f, raw, prev, scratch, bpp);
      const c = filterCost(scratch);
      if (c < bestCost) { bestCost = c; best = f; }
    }
    return best;
  }

  /* ---------------- 位打包 / 解包 ---------------- */
  /** 解包一行 packed 字节为样本，写入 samples（偏移 sampleOff）。16 位大端，低位深高位优先。 */
  function unpackRow(recon, width, channels, depth, samples, sampleOff) {
    const count = width * channels;
    if (depth === 16) {
      for (let i = 0; i < count; i++) {
        samples[sampleOff + i] = (recon[2 * i] << 8) | recon[2 * i + 1];
      }
    } else if (depth === 8) {
      samples.set(recon.subarray(0, count), sampleOff);
    } else {
      const mask = (1 << depth) - 1;
      for (let i = 0; i < count; i++) {
        const bit = i * depth;
        samples[sampleOff + i] = (recon[bit >> 3] >> (8 - depth - (bit & 7))) & mask;
      }
    }
  }

  /** 打包一行为 packed 字节（低位深行末填充位写 0，16 位大端） */
  function packRow(samples, sampleOff, width, channels, depth, out) {
    const count = width * channels;
    out.fill(0);
    if (depth === 16) {
      for (let i = 0; i < count; i++) {
        const v = samples[sampleOff + i];
        out[2 * i] = v >> 8;
        out[2 * i + 1] = v & 0xff;
      }
    } else if (depth === 8) {
      for (let i = 0; i < count; i++) out[i] = samples[sampleOff + i];
    } else {
      for (let i = 0; i < count; i++) {
        const bit = i * depth;
        out[bit >> 3] |= samples[sampleOff + i] << (8 - depth - (bit & 7));
      }
    }
  }

  /* ---------------- 解码 ---------------- */
  /**
   * 解码 PNG。成功返回结构化结果；任何损坏抛 PNGError（带块或 pass 位置），
   * 绝不返回部分图像。
   */
  async function decode(bytes) {
    const chunks = parseChunks(bytes);
    let s;
    try {
      s = validateStructure(chunks);
    } catch (e) {
      if (e instanceof PNGError) e.partialChunks = e.partialChunks || chunks;
      throw e;
    }
    const { ihdr, palette, transparency, idatData } = s;
    const ch = CHANNELS[ihdr.colorType];
    const bpp = bppOf(ch, ihdr.depth);
    const W = ihdr.width, H = ihdr.height;

    const passDefs = ihdr.interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
    const passes = passDefs.map((pd, i) => {
      const [sx, sy, dx, dy] = pd;
      const w = W > sx ? Math.ceil((W - sx) / dx) : 0;
      const h = H > sy ? Math.ceil((H - sy) / dy) : 0;
      return {
        index: ihdr.interlace === 1 ? i + 1 : 0,
        startX: sx, startY: sy, stepX: dx, stepY: dy,
        w, h, rowBytes: rowBytesOf(w, ch, ihdr.depth),
        rows: [],
      };
    });
    const scanlineBytes = passes.reduce(
      (sum, p) => sum + (p.w > 0 && p.h > 0 ? p.h * (1 + p.rowBytes) : 0), 0);

    // zlib 解压；按 pass 行长度精确限制总量，不接受尾随扫描流
    let raw;
    try {
      raw = await inflate(idatData);
    } catch (e) {
      throw new PNGError(`IDAT zlib 解压失败：${e.message || e}（数据损坏或被截断）`);
    }
    if (raw.length < scanlineBytes) {
      // 定位到具体 pass / 行
      let acc = 0;
      for (const p of passes) {
        if (p.w === 0 || p.h === 0) continue;
        for (let y = 0; y < p.h; y++) {
          const need = acc + 1 + p.rowBytes;
          if (raw.length < need) {
            throw new PNGError(
              `解压数据在 Pass ${p.index} 第 ${y} 行处耗尽：` +
              `需要 ${scanlineBytes} 字节，实际仅 ${raw.length} 字节（扫描流被截断）`,
              { pass: p.index, row: y });
          }
          acc = need;
        }
      }
      throw new PNGError(`解压数据不足：需要 ${scanlineBytes} 字节，实际 ${raw.length} 字节`);
    }
    if (raw.length > scanlineBytes) {
      throw new PNGError(
        `解压数据超出预期：需要 ${scanlineBytes} 字节，实际 ${raw.length} 字节` +
        `（存在 ${raw.length - scanlineBytes} 字节尾随扫描数据）`);
    }

    const samples = ihdr.depth === 16
      ? new Uint16Array(W * H * ch)
      : new Uint8Array(W * H * ch);

    let pos = 0;
    const allRows = [];
    for (const p of passes) {
      p.streamOffset = pos;
      if (p.w === 0 || p.h === 0) { p.streamLength = 0; continue; }
      const prev = new Uint8Array(p.rowBytes); // 每个 pass 首行上方全 0
      const recon = new Uint8Array(p.rowBytes);
      // 整行解包到临时缓冲（低位深像素不字节对齐，必须先整行解包再散布）
      const rowSamples = ihdr.depth === 16
        ? new Uint16Array(p.w * ch)
        : new Uint8Array(p.w * ch);
      for (let y = 0; y < p.h; y++) {
        const filter = raw[pos++];
        if (filter > 4) {
          throw new PNGError(
            `Pass ${p.index} 第 ${y} 行：未知过滤类型 ${filter}（合法值 0..4）`,
            { pass: p.index, row: y });
        }
        const cur = raw.subarray(pos, pos + p.rowBytes);
        unfilterRow(filter, cur, prev, recon, bpp);
        unpackRow(recon, p.w, ch, ihdr.depth, rowSamples, 0);
        // 写入最终图像位置（隔行时按 pass 参数散布）
        const imgY = p.startY + y * p.stepY;
        for (let x = 0; x < p.w; x++) {
          const imgX = p.startX + x * p.stepX;
          const dst = (imgY * W + imgX) * ch;
          for (let c = 0; c < ch; c++) samples[dst + c] = rowSamples[x * ch + c];
        }
        prev.set(recon);
        const rec = { pass: p.index, row: y, filter, bytes: p.rowBytes };
        p.rows.push(rec);
        allRows.push(rec);
        pos += p.rowBytes;
      }
      p.streamLength = pos - p.streamOffset;
    }

    return {
      width: W, height: H,
      depth: ihdr.depth, colorType: ihdr.colorType, interlace: ihdr.interlace,
      channels: ch, bpp,
      palette, transparency, samples,
      passes, rows: allRows,
      scanlineBytes, idatBytes: idatData.length,
      fileBytes: bytes.length,
      scanStream: raw, // 解压后的完整扫描流（各 pass 用 streamOffset/streamLength 切片）
      chunks: chunks.map((c) => ({
        index: c.index, type: c.type, offset: c.offset, length: c.length, crc: c.crc,
      })),
    };
  }

  /* ---------------- 重编码（输出非隔行 PNG） ---------------- */
  /**
   * decoded: decode() 的结果（保留原位深、颜色类型、PLTE、tRNS、像素）。
   * filterMode: 0..4 固定过滤器，或 'auto' 逐行择优。
   * 返回 { bytes, rows, scanlineBytes, idatBytes, fileBytes }。
   */
  async function encode(decoded, filterMode) {
    const { width: W, height: H, depth, colorType, channels: ch, samples } = decoded;
    const bpp = bppOf(ch, depth);
    const rowBytes = rowBytesOf(W, ch, depth);

    const stream = new Uint8Array(H * (1 + rowBytes));
    const rows = [];
    const raw = new Uint8Array(rowBytes);
    const prev = new Uint8Array(rowBytes);
    const filtered = new Uint8Array(rowBytes);
    const scratch = new Uint8Array(rowBytes);
    let pos = 0;
    for (let y = 0; y < H; y++) {
      packRow(samples, y * W * ch, W, ch, depth, raw);
      let f;
      if (filterMode === 'auto') {
        f = chooseFilter(raw, prev, bpp, scratch);
      } else {
        f = filterMode | 0;
        if (f < 0 || f > 4) throw new PNGError(`非法过滤模式 ${filterMode}`);
      }
      filterRow(f, raw, prev, filtered, bpp);
      stream[pos++] = f;
      stream.set(filtered, pos);
      pos += rowBytes;
      prev.set(raw);
      rows.push({ pass: 0, row: y, filter: f, bytes: rowBytes });
    }

    const idat = await deflate(stream);

    // 组块：签名 + IHDR + [PLTE] + [tRNS] + IDAT + IEND
    const parts = [];
    let total = 8;
    const pushChunk = (type, data) => {
      const buf = new Uint8Array(12 + data.length);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
      buf.set(data, 8);
      dv.setUint32(8 + data.length, crc32(buf, 4, 8 + data.length));
      parts.push(buf);
      total += buf.length;
    };

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W);
    dv.setUint32(4, H);
    ihdr[8] = depth;
    ihdr[9] = colorType;
    ihdr[10] = 0; // 压缩
    ihdr[11] = 0; // 过滤
    ihdr[12] = 0; // 非隔行
    pushChunk('IHDR', ihdr);

    if (decoded.palette) {
      const plte = new Uint8Array(decoded.palette.length * 3);
      decoded.palette.forEach((rgb, i) => plte.set(rgb, i * 3));
      pushChunk('PLTE', plte);
    }
    if (decoded.transparency) {
      let trns;
      if (colorType === 3) {
        trns = Uint8Array.from(decoded.transparency);
      } else {
        trns = new Uint8Array(decoded.transparency.length * 2);
        const tv = new DataView(trns.buffer);
        decoded.transparency.forEach((v, i) => tv.setUint16(i * 2, v));
      }
      pushChunk('tRNS', trns);
    }
    pushChunk('IDAT', idat);
    pushChunk('IEND', new Uint8Array(0));

    const out = new Uint8Array(total);
    out.set(PNG_SIGNATURE, 0);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }

    return {
      bytes: out, rows,
      scanlineBytes: stream.length,
      idatBytes: idat.length,
      fileBytes: out.length,
    };
  }

  /* ---------------- 预览（统一 RGBA8） ---------------- */
  /** 16 位 -> 8 位：floor(v*255/65535 + 0.5) */
  function scale16to8(v) {
    return Math.floor((v * 255) / 65535 + 0.5);
  }

  /** 生成 RGBA8 预览位图（仅用于显示，不参与处理结果） */
  function toRGBA8(dec) {
    const { width: W, height: H, depth, colorType, samples, palette, transparency } = dec;
    const out = new Uint8ClampedArray(W * H * 4);
    const maxV = (1 << depth) - 1;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (colorType === 0) {
        const v = samples[i];
        const g = depth === 16 ? scale16to8(v) : v;
        out[o] = out[o + 1] = out[o + 2] = g;
        // 透明色键按原始样本比较
        out[o + 3] = transparency && v === transparency[0] ? 0 : 255;
      } else if (colorType === 2) {
        const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = transparency &&
          r === transparency[0] && g === transparency[1] && b === transparency[2] ? 0 : 255;
      } else if (colorType === 3) {
        const idx = samples[i];
        const rgb = palette && palette[idx];
        out[o] = rgb ? rgb[0] : 0;
        out[o + 1] = rgb ? rgb[1] : 0;
        out[o + 2] = rgb ? rgb[2] : 0;
        // 索引透明表未提供项为 255
        out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      } else { // 6: RGBA8
        out[o] = samples[i * 4];
        out[o + 1] = samples[i * 4 + 1];
        out[o + 2] = samples[i * 4 + 2];
        out[o + 3] = samples[i * 4 + 3];
      }
    }
    return out;
  }

  /** 点查单个像素的原始通道值（不降位） */
  function pixelAt(dec, x, y) {
    const { width: W, channels: ch, samples, colorType, depth, palette, transparency } = dec;
    const off = (y * W + x) * ch;
    const values = [];
    for (let c = 0; c < ch; c++) values.push(samples[off + c]);
    const info = { x, y, values, maxValue: (1 << depth) - 1 };
    if (colorType === 3) {
      const idx = values[0];
      info.paletteIndex = idx;
      info.paletteRGB = palette && palette[idx] ? palette[idx].slice() : null;
      info.alpha = transparency && idx < transparency.length ? transparency[idx] : 255;
    } else if (colorType === 0) {
      info.alpha = transparency && values[0] === transparency[0] ? 0 : 255;
    } else if (colorType === 2) {
      info.alpha = transparency &&
        values[0] === transparency[0] && values[1] === transparency[1] &&
        values[2] === transparency[2] ? 0 : 255;
    } else {
      info.alpha = values[3];
    }
    return info;
  }

  return {
    PNGError,
    MAX_DIM, MAX_FILE_BYTES,
    CHANNELS, COLOR_TYPE_NAMES, FILTER_NAMES, ADAM7,
    crc32, paeth,
    inflate, deflate,
    parseChunks, validateStructure,
    unfilterRow, filterRow, filterCost, chooseFilter,
    unpackRow, packRow,
    decode, encode, toRGBA8, pixelAt, scale16to8,
    bppOf, rowBytesOf,
  };
});
