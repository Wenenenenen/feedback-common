/*
 * tiff.js — sparse tiled TIFF reader for the ROI inspector.
 *
 * Implemented locally (no TIFF library):
 *   - Classic TIFF / BigTIFF, little and big endian
 *   - IFD chain + one level of SubIFDs, with cycle and bounds detection
 *   - tiled addressing for chunky and planar (channel, tile-row, tile-col) layouts
 *   - Deflate (compression 8), no compression (1) and predictor 1/2
 *   - orientations 1, 3, 6, 8 with display-oriented ROI coordinates
 *   - random-access byte sources (memory or Blob slices) so only the tile
 *     ranges an ROI needs are ever read
 *   - a global LRU of at most 32 decoded blocks
 *   - per-pixel validity mask (missing tile => mask 0)
 *
 * fflate is used only for generic zlib inflation.
 *
 * UMD: window.TiffRoi in the browser, module.exports under Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/fflate.js'));
  } else {
    root.TiffRoi = factory(root.fflate);
  }
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  const CACHE_LIMIT = 32;
  const FAIL_CACHE_LIMIT = 64;
  const MAX_ROI = 1024;
  const SUPPORTED_MAX_DIM = 32768;
  const IO_CONCURRENCY = 8;

  const STATUS = Object.freeze({
    PRESENT: 0,
    MISSING: 1,
    INVALID: 2,
    OUT_OF_BOUNDS: 3,
    CORRUPT: 4
  });

  const STATUS_LABEL = Object.freeze({
    0: '已读取',
    1: '缺块',
    2: '偏移/字节数单项为 0',
    3: '偏移越界',
    4: '损坏块'
  });

  const TYPE_LENGTH = {    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4,
    10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8
  };

  const TAG = {
    NEW_SUBFILE_TYPE: 254,
    IMAGE_WIDTH: 256,
    IMAGE_LENGTH: 257,
    BITS_PER_SAMPLE: 258,
    COMPRESSION: 259,
    PHOTOMETRIC: 262,
    STRIP_OFFSETS: 273,
    ORIENTATION: 274,
    SAMPLES_PER_PIXEL: 277,
    ROWS_PER_STRIP: 278,
    STRIP_BYTE_COUNTS: 279,
    PLANAR_CONFIG: 284,
    PREDICTOR: 317,
    TILE_WIDTH: 322,
    TILE_LENGTH: 323,
    TILE_OFFSETS: 324,
    TILE_BYTE_COUNTS: 325,
    SUB_IFDS: 330,
    SAMPLE_FORMAT: 339
  };

  const TAG_LABEL = {
    254: 'NewSubfileType', 256: 'ImageWidth', 257: 'ImageLength',
    258: 'BitsPerSample', 259: 'Compression', 262: 'Photometric',
    273: 'StripOffsets', 274: 'Orientation', 277: 'SamplesPerPixel',
    278: 'RowsPerStrip', 279: 'StripByteCounts', 284: 'PlanarConfig',
    317: 'Predictor', 322: 'TileWidth', 323: 'TileLength',
    324: 'TileOffsets', 325: 'TileByteCounts', 330: 'SubIFDs',
    339: 'SampleFormat'
  };

  const ORIENTATION_LABEL = {
    1: '1 · 左上原点',
    3: '3 · 旋转 180°',
    6: '6 · 顺时针旋转 90°',
    8: '8 · 逆时针旋转 90°'
  };

  class TiffError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'TiffError';
      this.code = code;
      this.detail = detail || null;
    }
  }

  // --- byte sources -------------------------------------------------------

  class MemorySource {
    constructor(bytes, name) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.size = this.bytes.byteLength;
      this.name = name || 'memory';
    }
    async read(offset, length) {
      if (offset >= this.size || length <= 0) return new Uint8Array(0);
      const end = Math.min(this.size, offset + length);
      return this.bytes.subarray(offset, end);
    }
  }

  class BlobSource {
    constructor(blob, name) {
      this.blob = blob;
      this.size = blob.size;
      this.name = name || blob.name || 'blob';
    }
    async read(offset, length) {
      if (offset >= this.size || length <= 0) return new Uint8Array(0);
      const end = Math.min(this.size, offset + length);
      const buf = await this.blob.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    }
  }

  // --- small helpers ------------------------------------------------------

  function dvOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function readTagValues(view, en, type, count, fileSize) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = i * TYPE_LENGTH[type];
      switch (type) {
        case 1: case 7: out.push(view.getUint8(p)); break;
        case 6: out.push(view.getInt8(p)); break;
        case 3: out.push(view.getUint16(p, en)); break;
        case 8: out.push(view.getInt16(p, en)); break;
        case 4: case 13: out.push(view.getUint32(p, en)); break;
        case 9: out.push(view.getInt32(p, en)); break;
        case 16: case 18: out.push(Number(view.getBigUint64(p, en))); break;
        case 17: out.push(Number(view.getBigInt64(p, en))); break;
        case 5: {
          const a = view.getUint32(p, en);
          const b = view.getUint32(p + 4, en);
          out.push(b === 0 ? 0 : a / b);
          break;
        }
        case 10: {
          const a = view.getInt32(p, en);
          const b = view.getInt32(p + 4, en);
          out.push(b === 0 ? 0 : a / b);
          break;
        }
        case 11: out.push(view.getFloat32(p, en)); break;
        case 12: out.push(view.getFloat64(p, en)); break;
        case 2: {
          // ASCII: one char per byte, enough for inspection
          out.push(String.fromCharCode(view.getUint8(p)));
          break;
        }
        default: throw new TiffError('tag-type', '不支持的字段类型 ' + type);
      }
    }
    void fileSize;
    return out;
  }

  function inflateTile(raw, compression) {
    if (compression === 1) return new Uint8Array(raw);
    if (compression === 8) return fflate.unzlibSync(raw);
    throw new Error('不支持的压缩方式 ' + compression);
  }

  function applyPredictor(bytes, dir, planeChannels) {
    if (dir.predictor !== 2) return;
    const littleEndian = dir.littleEndian;
    const dv = dvOf(bytes);
    const tw = dir.tileWidth;
    const th = dir.tileLength;
    const ch = planeChannels;
    for (let y = 0; y < th; y++) {
      const row = y * tw * ch;
      for (let x = 1; x < tw; x++) {
        for (let c = 0; c < ch; c++) {
          const cur = row + x * ch + c;
          const prev = row + (x - 1) * ch + c;
          const value = (dv.getUint16(cur * 2, littleEndian) +
            dv.getUint16(prev * 2, littleEndian)) & 0xffff;
          dv.setUint16(cur * 2, value, littleEndian);
        }
      }
    }
  }

  function toUint16(bytes, littleEndian, count) {
    const dv = dvOf(bytes);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getUint16(i * 2, littleEndian);
    return out;
  }

  function toByte(v) {
    const n = Math.max(0, Math.min(65535, v | 0));
    return Math.round((n * 255) / 65535);
  }

  // --- reader -------------------------------------------------------------

  class TiffReader {
    /**
     * @param {MemorySource|BlobSource} source
     * @param {{name?: string}} [options]
     */
    constructor(source, options) {
      const opts = options || {};
      this.source = source;
      this.name = opts.name || source.name || 'TIFF';
      this.size = source.size;
      this.directories = [];
      this.errors = [];
      this._cache = new Map();      // decoded blocks, LRU, max CACHE_LIMIT
      this._failCache = new Map();  // non-present / undecodable blocks
      this._tileInfoCache = new Map();
      this._stats = this._emptyStats();
    }

    static async open(source, options) {
      const reader = new TiffReader(source, options);
      await reader.init();
      return reader;
    }

    static async fromBytes(bytes, options) {
      return TiffReader.open(new MemorySource(bytes), options);
    }

    _emptyStats() {
      return {
        bytesRead: 0,
        metaBytes: 0,
        tileBytes: 0,
        reads: 0,
        decodes: 0,
        cacheHits: 0
      };
    }

    resetStats() {
      this._stats = this._emptyStats();
    }

    get stats() {
      return {
        bytesRead: this._stats.bytesRead,
        metaBytes: this._stats.metaBytes,
        tileBytes: this._stats.tileBytes,
        reads: this._stats.reads,
        decodes: this._stats.decodes,
        cacheHits: this._stats.cacheHits,
        cached: this._cache.size
      };
    }

    cacheSize() {
      return this._cache.size;
    }

    clearCache() {
      this._cache.clear();
      this._failCache.clear();
    }

    async _read(offset, length, bucket) {
      const bytes = await this.source.read(offset, length);
      this._stats.bytesRead += bytes.byteLength;
      this._stats.reads += 1;
      if (bucket === 'tile') this._stats.tileBytes += bytes.byteLength;
      else this._stats.metaBytes += bytes.byteLength;
      return bytes;
    }

    // --- directory parsing ------------------------------------------------

    async init() {
      if (this.size < 8) throw new TiffError('bad-header', '文件太短，不是 TIFF');
      const head = await this._read(0, Math.min(16, this.size), 'meta');
      if (head.byteLength < 8) throw new TiffError('bad-header', '文件头不完整');
      const hv = dvOf(head);
      const b0 = hv.getUint8(0), b1 = hv.getUint8(1);
      let en;
      if (b0 === 0x49 && b1 === 0x49) en = true;
      else if (b0 === 0x4d && b1 === 0x4d) en = false;
      else throw new TiffError('bad-header', '不是 TIFF：字节序标记无效');
      this.littleEndian = en;
      this.en = en;
      const magic = hv.getUint16(2, en);
      if (magic === 42) this.big = false;
      else if (magic === 43) this.big = true;
      else throw new TiffError('bad-header', '不是 TIFF：版本号 ' + magic);

      let offset = this.big
        ? (head.byteLength >= 16 ? Number(hv.getBigUint64(8, en)) : 0)
        : hv.getUint32(4, en);

      if (!offset) {
        this.errors.push({
          scope: 'directory', ifdIndex: 0, offset: 0,
          message: '头部的第一个 IFD 偏移为 0，没有目录可读'
        });
        throw new TiffError('no-directory', '没有可用的图像目录');
      }

      const visited = new Set();
      let displayIndex = 0;
      let chainIndex = 0;

      while (offset) {
        if (visited.has(offset)) {
          this.errors.push({
            scope: 'directory', ifdIndex: chainIndex, offset,
            message: '目录循环：IFD #' + chainIndex + ' 指回已解析偏移 ' + offset
          });
          break;
        }
        visited.add(offset);
        let dir;
        try {
          dir = await this.readIfd(offset, { kind: 'top', chainIndex, ifdIndex: chainIndex });
        } catch (err) {
          this.errors.push({
            scope: 'directory', ifdIndex: chainIndex, offset,
            message: 'IFD #' + chainIndex + '（偏移 ' + offset + '）解析失败：' + err.message
          });
          break;
        }
        dir.displayIndex = displayIndex++;
        this.directories.push(dir);

        if (dir.subIfdOffsets.length) {
          for (let i = 0; i < dir.subIfdOffsets.length; i++) {
            const subOff = dir.subIfdOffsets[i];
            if (!subOff) continue;
            if (visited.has(subOff)) {
              this.errors.push({
                scope: 'directory', ifdIndex: chainIndex, offset: subOff,
                message: 'SubIFD #' + i + ' 重复指向偏移 ' + subOff + '（IFD #' + chainIndex + '）'
              });
              continue;
            }
            visited.add(subOff);
            try {
              const sub = await this.readIfd(subOff, {
                kind: 'sub', chainIndex, ifdIndex: chainIndex, subIndex: i
              });
              sub.displayIndex = displayIndex++;
              this.directories.push(sub);
            } catch (err) {
              this.errors.push({
                scope: 'directory', ifdIndex: chainIndex, offset: subOff,
                message: 'SubIFD #' + i + '（IFD #' + chainIndex + '，偏移 ' + subOff +
                  '）解析失败：' + err.message
              });
            }
          }
        }
        offset = dir.nextOffset;
        chainIndex++;
        if (chainIndex > 4096) {
          this.errors.push({
            scope: 'directory', ifdIndex: chainIndex, offset,
            message: '目录链过长，已停止解析'
          });
          break;
        }
      }

      if (!this.directories.length) throw new TiffError('no-directory', '没有可用的图像目录');
      this.layers = this.directories.filter((d) => d.isTiled);
      if (!this.layers.length) {
        throw new TiffError('no-tiles', '没有任何目录包含图块（TileWidth/TileLength）');
      }
      for (const d of this.directories) {
        if (!d.isTiled) {
          d.unsupportedReason = d.stripBased
            ? '条带（strip）布局不在支持范围'
            : '缺少 TileWidth / TileLength';
        }
      }
    }

    async readIfd(offset, meta) {
      const en = this.en;
      const big = this.big;
      const countSize = big ? 8 : 4;
      const entrySize = big ? 20 : 12;
      const headerSize = big ? 8 : 2;

      if (offset + headerSize > this.size) {
        throw new TiffError('ifd-oob', '目录偏移越界（' + offset + '）');
      }
      const header = await this._read(offset, headerSize, 'meta');
      if (header.byteLength < headerSize) {
        throw new TiffError('ifd-oob', '目录头读取不完整（' + offset + '）');
      }
      const hv = dvOf(header);
      const nEntries = big ? Number(hv.getBigUint64(0, en)) : hv.getUint16(0, en);
      const tableLen = nEntries * entrySize + countSize;
      const tableStart = offset + headerSize;
      if (nEntries > 262144 || tableStart + tableLen > this.size) {
        throw new TiffError('ifd-oob',
          '目录条目表越界（条目 ' + nEntries + '，结束 ' + (tableStart + tableLen) + '）');
      }
      const table = await this._read(tableStart, tableLen, 'meta');
      if (table.byteLength < tableLen) {
        throw new TiffError('ifd-oob', '目录条目表读取不完整');
      }
      const tv = dvOf(table);

      const tags = new Map();
      const rawTags = [];
      for (let i = 0; i < nEntries; i++) {
        const pos = i * entrySize;
        const tag = tv.getUint16(pos, en);
        const type = tv.getUint16(pos + 2, en);
        const count = big ? Number(tv.getBigUint64(pos + 4, en)) : tv.getUint32(pos + 4, en);
        const valuePos = pos + (big ? 12 : 8);
        if (!TYPE_LENGTH[type]) {
          rawTags.push({ tag, type, count, error: '未知字段类型 ' + type });
          continue;
        }
        const total = TYPE_LENGTH[type] * count;
        let entry;
        try {
          let dataView;
          if (total <= countSize) {
            const inline = table.subarray(valuePos, valuePos + countSize);
            dataView = dvOf(inline);
          } else {
            const dataPos = big
              ? Number(tv.getBigUint64(valuePos, en))
              : tv.getUint32(valuePos, en);
            if (dataPos + total > this.size) {
              throw new TiffError('tag-oob',
                '字段数据越界（tag ' + tag + '，偏移 ' + dataPos + '，长度 ' + total +
                '，文件 ' + this.size + '）');
            }
            if (total > 64 * 1024 * 1024) {
              throw new TiffError('tag-too-large', '字段数组过大（' + total + ' 字节）');
            }
            const data = await this._read(dataPos, total, 'meta');
            if (data.byteLength < total) {
              throw new TiffError('tag-oob', '字段数据读取不完整（tag ' + tag + '）');
            }
            dataView = dvOf(data);
          }
          const values = readTagValues(dataView, en, type, count, this.size);
          entry = { type, count, values };
          tags.set(tag, entry);
          rawTags.push({ tag, type, count, values });
        } catch (err) {
          rawTags.push({ tag, type, count, error: err.message });
          if (tag === TAG.TILE_OFFSETS || tag === TAG.TILE_BYTE_COUNTS) throw err;
        }
      }

      const nextOffset = big
        ? Number(tv.getBigUint64(nEntries * entrySize, en))
        : tv.getUint32(nEntries * entrySize, en);

      const scalar = (tag, fallback) => {
        const t = tags.get(tag);
        return t && t.values.length ? t.values[0] : fallback;
      };
      const arr = (tag) => {
        const t = tags.get(tag);
        return t ? t.values.slice() : null;
      };

      const width = scalar(TAG.IMAGE_WIDTH, 0);
      const height = scalar(TAG.IMAGE_LENGTH, 0);
      const spp = scalar(TAG.SAMPLES_PER_PIXEL, 1);
      const bitsRaw = arr(TAG.BITS_PER_SAMPLE);
      const bits = bitsRaw && bitsRaw.length ? bitsRaw[0] : 1;
      const compression = scalar(TAG.COMPRESSION, 1);
      const photometric = scalar(TAG.PHOTOMETRIC, 1);
      const orientation = scalar(TAG.ORIENTATION, 1);
      const planar = scalar(TAG.PLANAR_CONFIG, 1);
      const predictor = scalar(TAG.PREDICTOR, 1);
      const tileWidth = scalar(TAG.TILE_WIDTH, 0);
      const tileLength = scalar(TAG.TILE_LENGTH, 0);
      const tileOffsets = arr(TAG.TILE_OFFSETS);
      const tileCounts = arr(TAG.TILE_BYTE_COUNTS);
      const subIfdOffsets = arr(TAG.SUB_IFDS) || [];
      const sampleFormat = scalar(TAG.SAMPLE_FORMAT, 1);
      const newSubfileType = scalar(TAG.NEW_SUBFILE_TYPE, 0);
      const stripBased = tags.has(TAG.STRIP_OFFSETS);
      const isTiled = tileWidth > 0 && tileLength > 0;

      const dir = {
        offset, kind: meta.kind, chainIndex: meta.chainIndex,
        ifdIndex: meta.ifdIndex, subIndex: meta.subIndex,
        nextOffset, tags, rawTags,
        littleEndian: this.en, bigTiff: this.big,
        width, height, spp, bits, bitsPerSampleRaw: bitsRaw,
        photometric, isRgb: photometric === 2,
        compression, orientation, planar, predictor,
        tileWidth, tileLength, tileOffsets, tileCounts,
        sampleFormat, newSubfileType, subIfdOffsets,
        isTiled, stripBased
      };
      dir.problems = [];
      if (!(width > 0 && height > 0)) dir.problems.push('ImageWidth / ImageLength 缺失或为 0');
      if (width > SUPPORTED_MAX_DIM || height > SUPPORTED_MAX_DIM) {
        dir.problems.push('单边超过 ' + SUPPORTED_MAX_DIM + ' 像素，超出支持范围');
      }
      if (isTiled) {
        if (!tileOffsets || !tileCounts) dir.problems.push('缺少图块偏移或字节数数组');
        if (![1, 3, 6, 8].includes(orientation)) {
          dir.problems.push('不支持的方向标签 ' + orientation + '（仅支持 1/3/6/8）');
        }
        if (compression !== 1 && compression !== 8) {
          dir.problems.push('不支持的压缩方式 ' + compression + '（仅支持 1 与 8）');
        }
        if (predictor !== 1 && predictor !== 2) {
          dir.problems.push('不支持的预测器 ' + predictor + '（仅支持 1 与 2）');
        }
        if (bits !== 16) dir.problems.push('仅支持 16 位采样，当前 ' + bits + ' 位');
        if (photometric !== 1 && photometric !== 2) {
          dir.problems.push('不支持的光度解释 ' + photometric + '（仅支持灰度与 RGB）');
        }
        if (planar !== 1 && planar !== 2) {
          dir.problems.push('不支持的 PlanarConfig ' + planar);
        }
        if (sampleFormat !== 1) dir.problems.push('仅支持无符号整数采样');
        const across = Math.ceil(width / tileWidth);
        const down = Math.ceil(height / tileLength);
        const expected = across * down * (planar === 2 ? spp : 1);
        if (tileOffsets && tileOffsets.length < expected) {
          dir.problems.push('图块偏移数量不足（' + tileOffsets.length + ' < ' + expected + '）');
        }
        if (tileCounts && tileCounts.length < expected) {
          dir.problems.push('图块字节数数量不足（' + tileCounts.length + ' < ' + expected + '）');
        }
      }
      void newSubfileType;
      return dir;
    }

    // --- geometry ---------------------------------------------------------

    tileGrid(dir) {
      return {
        across: Math.ceil(dir.width / dir.tileWidth),
        down: Math.ceil(dir.height / dir.tileLength)
      };
    }

    displaySize(dir) {
      if (dir.orientation === 6 || dir.orientation === 8) {
        return { width: dir.height, height: dir.width };
      }
      return { width: dir.width, height: dir.height };
    }

    displayToStorage(dir, dx, dy) {
      const W = dir.width, H = dir.height;
      switch (dir.orientation) {
        case 3: return { x: W - 1 - dx, y: H - 1 - dy };
        case 6: return { x: dy, y: H - 1 - dx };
        case 8: return { x: W - 1 - dy, y: dx };
        default: return { x: dx, y: dy };
      }
    }

    storageToDisplay(dir, sx, sy) {
      const W = dir.width, H = dir.height;
      switch (dir.orientation) {
        case 3: return { x: W - 1 - sx, y: H - 1 - sy };
        case 6: return { x: H - 1 - sy, y: sx };
        case 8: return { x: sy, y: W - 1 - sx };
        default: return { x: sx, y: sy };
      }
    }

    /** Storage-space rectangle covered by a display-space ROI (a rotation). */
    describeRoiMapping(dir, roi) {
      const corners = [
        this.displayToStorage(dir, roi.x, roi.y),
        this.displayToStorage(dir, roi.x + roi.width - 1, roi.y),
        this.displayToStorage(dir, roi.x, roi.y + roi.height - 1),
        this.displayToStorage(dir, roi.x + roi.width - 1, roi.y + roi.height - 1)
      ];
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      return {
        x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
        y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys)
      };
    }

    // --- tiles ------------------------------------------------------------

    tileIndex(dir, channel, tileRow, tileCol) {
      const { across, down } = this.tileGrid(dir);
      if (dir.planar === 2) return channel * across * down + tileRow * across + tileCol;
      return tileRow * across + tileCol;
    }

    tileStatus(dir, index) {
      const offs = dir.tileOffsets || [];
      const counts = dir.tileCounts || [];
      if (index >= offs.length || index >= counts.length) return STATUS.INVALID;
      const offset = offs[index];
      const count = counts[index];
      if (offset === 0 && count === 0) return STATUS.MISSING;
      if (!offset || !count) return STATUS.INVALID;
      if (offset < (this.big ? 16 : 8) || offset + count > this.size) return STATUS.OUT_OF_BOUNDS;
      return STATUS.PRESENT;
    }

    tileInfo(dir, index) {
      const key = dir.offset + ':' + index;
      if (this._tileInfoCache.has(key)) return this._tileInfoCache.get(key);
      const status = this.tileStatus(dir, index);
      const info = {
        index, status, statusLabel: STATUS_LABEL[status],
        offset: (dir.tileOffsets || [])[index] || 0,
        byteCount: (dir.tileCounts || [])[index] || 0
      };
      this._tileInfoCache.set(key, info);
      return info;
    }

    _cacheKey(dir, index) {
      return dir.offset + ':' + index;
    }

    _lruTouch(key, block) {
      this._cache.delete(key);
      this._cache.set(key, block);
      while (this._cache.size > CACHE_LIMIT) {
        this._cache.delete(this._cache.keys().next().value);
      }
    }

    _failTouch(key, block) {
      this._failCache.delete(key);
      this._failCache.set(key, block);
      while (this._failCache.size > FAIL_CACHE_LIMIT) {
        this._failCache.delete(this._failCache.keys().next().value);
      }
    }

    /**
     * Decode one block (one tile of one channel when planar, the whole
     * chunky tile otherwise). Never reads a missing / out-of-bounds block.
     * @returns {Promise<object>} block record
     */
    async decodeBlock(dir, index) {
      const key = this._cacheKey(dir, index);
      if (this._cache.has(key)) {
        const hit = this._cache.get(key);
        this._lruTouch(key, hit);
        this._stats.cacheHits++;
        return hit;
      }
      if (this._failCache.has(key)) {
        const hit = this._failCache.get(key);
        this._failTouch(key, hit);
        return hit;
      }
      const info = this.tileInfo(dir, index);
      if (info.status !== STATUS.PRESENT) {
        const block = {
          index, ok: false, status: info.status,
          error: STATUS_LABEL[info.status],
          offset: info.offset, byteCount: info.byteCount,
          samples: null, channels: 0
        };
        this._failTouch(key, block);
        return block;
      }

      const planeChannels = dir.planar === 2 ? 1 : dir.spp;
      const expected = dir.tileWidth * dir.tileLength * planeChannels * 2;
      this._stats.decodes++;
      try {
        const raw = await this._read(info.offset, info.byteCount, 'tile');
        if (raw.byteLength < info.byteCount) {
          throw new Error('读取不完整：需要 ' + info.byteCount + ' 字节，实际 ' + raw.byteLength);
        }
        const inflated = inflateTile(raw, dir.compression);
        if (inflated.byteLength !== expected) {
          throw new Error('解压长度 ' + inflated.byteLength + ' 与预期 ' + expected + ' 不符');
        }
        applyPredictor(inflated, dir, planeChannels);
        const samples = toUint16(
          inflated, dir.littleEndian, dir.tileWidth * dir.tileLength * planeChannels
        );
        const block = {
          index, ok: true, status: STATUS.PRESENT, error: null,
          offset: info.offset, byteCount: info.byteCount,
          samples, channels: planeChannels
        };
        this._lruTouch(key, block);
        return block;
      } catch (err) {
        const block = {
          index, ok: false, status: STATUS.CORRUPT, error: err.message,
          offset: info.offset, byteCount: info.byteCount,
          samples: null, channels: 0
        };
        this._failTouch(key, block);
        return block;
      }
    }

    // --- ROI --------------------------------------------------------------

    _clipRoi(dir, roi) {
      const ds = this.displaySize(dir);
      const req = {
        x: Math.floor(roi.x), y: Math.floor(roi.y),
        width: Math.floor(roi.width), height: Math.floor(roi.height)
      };
      if (!isFinite(req.x) || !isFinite(req.y) ||
          !isFinite(req.width) || !isFinite(req.height)) {
        throw new TiffError('bad-roi', '裁区坐标必须是数字');
      }
      if (req.width <= 0 || req.height <= 0) throw new TiffError('bad-roi', '裁区宽高必须为正');
      if (req.width > MAX_ROI || req.height > MAX_ROI) {
        throw new TiffError('bad-roi', '裁区不能超过 ' + MAX_ROI + '×' + MAX_ROI);
      }
      const x0 = Math.max(0, req.x);
      const y0 = Math.max(0, req.y);
      const x1 = Math.min(ds.width, req.x + req.width);
      const y1 = Math.min(ds.height, req.y + req.height);
      if (x1 <= x0 || y1 <= y0) {
        throw new TiffError('bad-roi',
          '裁区在图像范围之外（显示尺寸 ' + ds.width + '×' + ds.height + '）');
      }
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }

    /**
     * Display-space rectangle covered by one storage-space tile.
     * Orientations 1/3/6/8 map axis-aligned rects to axis-aligned rects.
     */
    tileDisplayRect(dir, tc, tr) {
      const x0 = tc * dir.tileWidth;
      const y0 = tr * dir.tileLength;
      const x1 = Math.min((tc + 1) * dir.tileWidth, dir.width) - 1;
      const y1 = Math.min((tr + 1) * dir.tileLength, dir.height) - 1;
      const a = this.storageToDisplay(dir, x0, y0);
      const b = this.storageToDisplay(dir, x1, y1);
      return {
        x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
        y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y)
      };
    }

    /**
     * Read a display-space ROI (<= 1024×1024). Only blocks whose display
     * rectangle intersects the ROI are read and decoded, one block at a time,
     * so the 32-block cache is never bypassed.
     *
     * Result fields:
     *   roi, displaySize, width, height, channels, samplesPerPixel,
     *   values (Uint16Array, channels interleaved, missing pixel => 0),
     *   raw (Int32Array, -1 = missing channel), mask (Uint8Array),
     *   rgba (Uint8ClampedArray), mapping (storage bbox),
     *   tileDetails, hitTiles, missingTiles, corruptTiles, oobTiles,
     *   invalidTiles, decodes, cacheHits, stats
     */
    async readRoi(dir, roi) {
      const clipped = this._clipRoi(dir, roi);
      const tw = dir.tileWidth, th = dir.tileLength;
      const mapping = this.describeRoiMapping(dir, clipped);
      const { across, down } = this.tileGrid(dir);
      const spp = dir.spp;
      const nch = Math.min(3, Math.max(1, spp));
      // only the channels we report are read (an RGBA file reports RGB)
      const planes = dir.planar === 2 ? Math.min(spp, nch) : 1;

      const outW = clipped.width;
      const outH = clipped.height;
      const raw = new Int32Array(outW * outH * nch).fill(-1);
      const values = new Uint16Array(outW * outH * nch);
      const mask = new Uint8Array(outW * outH);
      const rgba = new Uint8ClampedArray(outW * outH * 4);
      const roiX1 = clipped.x + outW - 1;
      const roiY1 = clipped.y + outH - 1;

      const tc0 = Math.floor(mapping.x0 / tw);
      const tc1 = Math.floor(mapping.x1 / tw);
      const tr0 = Math.floor(mapping.y0 / th);
      const tr1 = Math.floor(mapping.y1 / th);

      const before = { decodes: this._stats.decodes, hits: this._stats.cacheHits };
      const touched = new Map(); // index -> small metadata record (no samples)

      for (let c = 0; c < planes; c++) {
        for (let tr = tr0; tr <= tr1; tr++) {
          for (let tc = tc0; tc <= tc1; tc++) {
            const drect = this.tileDisplayRect(dir, tc, tr);
            if (drect.x1 < clipped.x || drect.x0 > roiX1 ||
                drect.y1 < clipped.y || drect.y0 > roiY1) {
              continue;
            }
            const index = this.tileIndex(dir, c, tr, tc);
            const block = await this.decodeBlock(dir, index);
            touched.set(index, {
              index,
              ok: block.ok,
              status: block.status,
              error: block.error,
              offset: block.offset,
              byteCount: block.byteCount
            });
            if (!block.ok) continue;

            // write the tile's pixels that land inside the ROI
            const sx0 = Math.max(tc * tw, mapping.x0);
            const sx1 = Math.min((tc + 1) * tw - 1, mapping.x1);
            const sy0 = Math.max(tr * th, mapping.y0);
            const sy1 = Math.min((tr + 1) * th - 1, mapping.y1);
            for (let sy = sy0; sy <= sy1; sy++) {
              for (let sx = sx0; sx <= sx1; sx++) {
                const d = this.storageToDisplay(dir, sx, sy);
                if (d.x < clipped.x || d.x > roiX1 || d.y < clipped.y || d.y > roiY1) continue;
                const lx = sx - tc * tw;
                const ly = sy - tr * th;
                const o = (d.y - clipped.y) * outW + (d.x - clipped.x);
                if (dir.planar === 2) {
                  raw[o * nch + c] = block.samples[ly * tw + lx];
                } else {
                  const src = (ly * tw + lx) * spp;
                  for (let k = 0; k < nch; k++) raw[o * nch + k] = block.samples[src + k];
                }
              }
            }
          }
        }
      }

      for (let o = 0; o < outW * outH; o++) {
        let allPresent = true;
        const base = o * nch;
        for (let c = 0; c < nch; c++) {
          if (raw[base + c] < 0) { allPresent = false; break; }
        }
        mask[o] = allPresent ? 1 : 0;
        for (let c = 0; c < nch; c++) {
          values[base + c] = allPresent ? raw[base + c] : 0;
        }
        const v0 = allPresent ? raw[base] : 0;
        const v1 = nch > 1 ? (allPresent ? raw[base + 1] : 0) : v0;
        const v2 = nch > 2 ? (allPresent ? raw[base + 2] : 0) : v1;
        const p = o * 4;
        rgba[p] = toByte(v0);
        rgba[p + 1] = toByte(v1);
        rgba[p + 2] = toByte(v2);
        rgba[p + 3] = allPresent ? 255 : 0;
      }

      const tileDetails = [...touched.values()].map((t) => {
        let channel = null;
        let local = t.index;
        if (dir.planar === 2) {
          channel = Math.floor(t.index / (across * down));
          local = t.index % (across * down);
        }
        return {
          index: t.index, channel,
          tileRow: Math.floor(local / across), tileCol: local % across,
          ok: t.ok, status: t.status, statusLabel: STATUS_LABEL[t.status],
          error: t.error, offset: t.offset, byteCount: t.byteCount
        };
      }).sort((a, b) => a.index - b.index);

      const pick = (status) => tileDetails.filter((t) => t.status === status).map((t) => t.index);

      return {
        roi: clipped,
        displaySize: this.displaySize(dir),
        width: outW, height: outH,
        channels: nch, samplesPerPixel: spp,
        values, raw, mask, rgba,
        mapping,
        tileDetails,
        hitTiles: [...touched.keys()].sort((a, b) => a - b),
        missingTiles: pick(STATUS.MISSING),
        corruptTiles: pick(STATUS.CORRUPT),
        oobTiles: pick(STATUS.OUT_OF_BOUNDS),
        invalidTiles: pick(STATUS.INVALID),
        decodes: this._stats.decodes - before.decodes,
        cacheHits: this._stats.cacheHits - before.hits,
        stats: this.stats,
        dir,
        step: 1
      };
    }

    /** Single display pixel, including per-channel nulls. */
    async pixelAt(dir, dx, dy) {
      const sp = this.displayToStorage(dir, dx, dy);
      if (sp.x < 0 || sp.y < 0 || sp.x >= dir.width || sp.y >= dir.height) {
        return { display: { x: dx, y: dy }, storage: sp, outOfBounds: true, channels: [], tiles: [] };
      }
      const tw = dir.tileWidth, th = dir.tileLength;
      const tc = Math.floor(sp.x / tw);
      const tr = Math.floor(sp.y / th);
      const lx = sp.x - tc * tw;
      const ly = sp.y - tr * th;
      const channels = [];
      const tiles = [];
      const shown = Math.min(3, Math.max(1, dir.spp));
      if (dir.planar === 2) {
        for (let c = 0; c < shown; c++) {
          const idx = this.tileIndex(dir, c, tr, tc);
          const block = await this.decodeBlock(dir, idx);
          channels.push(block.ok ? block.samples[ly * tw + lx] : null);
          tiles.push({ index: idx, channel: c, status: block.status,
            label: STATUS_LABEL[block.status], offset: block.offset,
            byteCount: block.byteCount, error: block.error });
        }
      } else {
        const idx = this.tileIndex(dir, 0, tr, tc);
        const block = await this.decodeBlock(dir, idx);
        for (let c = 0; c < shown; c++) {
          channels.push(block.ok ? block.samples[(ly * tw + lx) * dir.spp + c] : null);
          tiles.push({ index: idx, channel: dir.spp > 1 ? c : null, status: block.status,
            label: STATUS_LABEL[block.status], offset: block.offset,
            byteCount: block.byteCount, error: block.error });
        }
      }
      return { display: { x: dx, y: dy }, storage: sp, outOfBounds: false, channels, tiles };
    }

    /** Count blocks by status. Cheap: only touches the offset arrays. */
    countTiles(dir) {
      if (dir._counts) return dir._counts;
      const { across, down } = this.tileGrid(dir);
      const planes = dir.planar === 2 ? dir.spp : 1;
      const total = across * down * planes;
      const counts = { total, present: 0, missing: 0, invalid: 0, oob: 0 };
      for (let i = 0; i < total; i++) {
        const st = this.tileStatus(dir, i);
        if (st === STATUS.PRESENT) counts.present++;
        else if (st === STATUS.MISSING) counts.missing++;
        else if (st === STATUS.INVALID) counts.invalid++;
        else counts.oob++;
      }
      dir._counts = counts;
      return counts;
    }

    /**
     * Tile-map raster in display space: one texel per tile-status sample,
     * colored by the block's status. Never reads or decodes pixel data, so it
     * is safe for 32768² sparse images. The raster is O(output texels), not
     * O(tiles), which matters for images with millions of blocks.
     *
     * @param {object} [options]
     * @param {number} [options.maxDim] longest raster side in texels
     * @param {{x:number,y:number,width:number,height:number}} [options.viewport]
     *        display-space region to rasterise (defaults to the whole image)
     */
    buildTileMap(dir, options) {
      const opts = options || {};
      const maxDim = opts.maxDim || 460;
      const ds = this.displaySize(dir);
      let viewport = opts.viewport;
      if (!viewport) viewport = { x: 0, y: 0, width: ds.width, height: ds.height };
      const vx0 = Math.max(0, Math.min(viewport.x, ds.width));
      const vy0 = Math.max(0, Math.min(viewport.y, ds.height));
      const vx1 = Math.max(vx0 + 1, Math.min(viewport.x + viewport.width, ds.width));
      const vy1 = Math.max(vy0 + 1, Math.min(viewport.y + viewport.height, ds.height));
      const vw = vx1 - vx0;
      const vh = vy1 - vy0;

      const step = Math.max(1, Math.ceil(Math.max(vw, vh) / maxDim));
      const outW = Math.ceil(vw / step);
      const outH = Math.ceil(vh / step);
      const rgba = new Uint8ClampedArray(outW * outH * 4);
      const planes = dir.planar === 2 ? dir.spp : 1;

      const colors = {};
      colors[STATUS.PRESENT] = [96, 186, 226];
      colors[STATUS.MISSING] = [48, 38, 56];
      colors[STATUS.INVALID] = [196, 108, 64];
      colors[STATUS.OUT_OF_BOUNDS] = [222, 74, 96];
      const colorOf = (st) => colors[st] || [20, 25, 31];

      for (let oy = 0; oy < outH; oy++) {
        const dy = Math.min(ds.height - 1, Math.floor(vy0 + (oy + 0.5) * step));
        for (let ox = 0; ox < outW; ox++) {
          const dx = Math.min(ds.width - 1, Math.floor(vx0 + (ox + 0.5) * step));
          const sp = this.displayToStorage(dir, dx, dy);
          const tc = Math.floor(sp.x / dir.tileWidth);
          const tr = Math.floor(sp.y / dir.tileLength);
          // worst status across planes wins
          let st = STATUS.PRESENT;
          for (let c = 0; c < planes; c++) {
            const s = this.tileStatus(dir, this.tileIndex(dir, c, tr, tc));
            if (s === STATUS.OUT_OF_BOUNDS) { st = s; break; }
            if (s === STATUS.INVALID) { st = s; continue; }
            if (s === STATUS.MISSING && st === STATUS.PRESENT) st = s;
          }
          const col = colorOf(st);
          const p = (oy * outW + ox) * 4;
          rgba[p] = col[0]; rgba[p + 1] = col[1]; rgba[p + 2] = col[2];
          rgba[p + 3] = 255;
        }
      }

      // Tile grid lines once a tile is a few texels wide.
      if (dir.tileWidth / step >= 5) {
        const { across, down } = this.tileGrid(dir);
        const tc0 = Math.max(0, Math.floor(this.describeRoiMapping(dir,
          { x: vx0, y: vy0, width: vw, height: vh }).x0 / dir.tileWidth));
        const tr0 = Math.max(0, Math.floor(this.describeRoiMapping(dir,
          { x: vx0, y: vy0, width: vw, height: vh }).y0 / dir.tileLength));
        for (let tr = tr0; tr < down; tr++) {
          const rect = this.tileDisplayRect(dir, tc0, tr);
          if (rect.y0 < vy0) continue;
          if (rect.y0 > vy0 + vh) break;
          const y = Math.floor((rect.y0 - vy0) / step);
          if (y < 0 || y >= outH) continue;
          for (let x = 0; x < outW; x++) {
            const p = (y * outW + x) * 4;
            rgba[p] *= 0.55; rgba[p + 1] *= 0.55; rgba[p + 2] *= 0.55;
          }
        }
        for (let tc = tc0; tc < across; tc++) {
          const rect = this.tileDisplayRect(dir, tc, tr0);
          if (rect.x0 < vx0) continue;
          if (rect.x0 > vx0 + vw) break;
          const x = Math.floor((rect.x0 - vx0) / step);
          if (x < 0 || x >= outW) continue;
          for (let y = 0; y < outH; y++) {
            const p = (y * outW + x) * 4;
            rgba[p] *= 0.55; rgba[p + 1] *= 0.55; rgba[p + 2] *= 0.55;
          }
        }
      }

      return {
        mode: 'tiles',
        width: outW, height: outH, step,
        viewport: { x: vx0, y: vy0, width: vw, height: vh },
        displaySize: ds, rgba
      };
    }

    /**
     * Full audit of every block of a directory without decoding: counts per
     * status plus the first few problem block numbers.
     */
    auditTiles(dir) {
      const counts = this.countTiles(dir);
      const { across, down } = this.tileGrid(dir);
      const planes = dir.planar === 2 ? dir.spp : 1;
      const problems = [];
      if (counts.invalid || counts.oob) {
        for (let i = 0; i < counts.total; i++) {
          const st = this.tileStatus(dir, i);
          if (st === STATUS.INVALID || st === STATUS.OUT_OF_BOUNDS) {
            problems.push({ index: i, status: st });
            if (problems.length >= 200) break;
          }
        }
      }
      return { total: counts.total, across, down, planes, counts, problems };
    }
  }

  return {
    TiffReader,
    TiffError,
    MemorySource,
    BlobSource,
    STATUS,
    STATUS_LABEL,
    TAG,
    TAG_LABEL,
    ORIENTATION_LABEL,
    CACHE_LIMIT,
    MAX_ROI,
    SUPPORTED_MAX_DIM,
    toByte
  };
});
