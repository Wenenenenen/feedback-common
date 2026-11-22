/*
 * RPA1 — 录音无损归档编解码核心
 *
 * 纯 JavaScript（无 DOM / 无 Node 内建依赖），浏览器与 Node 共用。
 * 格式细节见 samples/格式.txt 与 README.md。
 *
 *   WAV 子集：小端 RIFF / PCM(格式码 1) / 一个 fmt + 一个 data，区块按偶数字节补齐。
 *   RPA1 头 ："RPA1" | u32 sampleRate | u8 channels | u8 bitDepth
 *             | u32 totalFrames | u32 numBlocks
 *   目录    ：numBlocks 条 u32 offset / u32 size / u32 crc32
 *   块      ：u8 mode | (u8 order, u8 k) × channels | 各路位流（各自补齐到整块末尾）
 *
 * 位流：MSB first；Rice 码 q<31 写 q 个 0 + 1 + k 位余数；
 *       q>=31 写 31 个 0 + 28 位原始 u。整个块末尾补最少的 0 到字节边界。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RPA1 = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAGIC = 0x31504152; // "RPA1" little-endian u32
  var HEADER_SIZE = 18;
  var ENTRY_SIZE = 12;
  var FRAMES_PER_BLOCK = 1024;
  var MAX_SECONDS = 90;
  var MIN_RATE = 8000;
  var MAX_RATE = 48000;
  var ESCAPE_Q = 31;
  var ESCAPE_BITS = 28;

  /* ------------------------------------------------------------------ */
  /* CRC32（与 Python zlib.crc32 一致）                                  */
  /* ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, start, end) {
    var c = 0xffffffff;
    var s = start === undefined ? 0 : start;
    var e = end === undefined ? bytes.length : end;
    for (var i = s; i < e; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function ceilDiv(a, b) {
    return Math.floor((a + b - 1) / b);
  }

  function bitDepthRange(bitDepth) {
    return { min: -Math.pow(2, bitDepth - 1), max: Math.pow(2, bitDepth - 1) - 1 };
  }

  function failure(kind, message, extra) {
    var err = { kind: kind, message: message };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) err[key] = extra[key];
      }
    }
    return err;
  }

  function readU32(bytes, offset) {
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    );
  }

  function writeU32(bytes, offset, value) {
    value = value >>> 0;
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function concatChunks(chunks, total) {
    var out = new Uint8Array(total);
    var pos = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], pos);
      pos += chunks[i].length;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* WAV 解析 / 生成                                                     */
  /* ------------------------------------------------------------------ */

  function parseWav(bytes) {
    if (!bytes || bytes.length < 12) {
      return { ok: false, error: failure('wav', '文件太小，不是有效的 WAV。') };
    }
    if (
      bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 ||
      bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45
    ) {
      return { ok: false, error: failure('wav', 'RIFF/WAVE 标识不匹配。') };
    }

    var pos = 12;
    var fmtChunk = null;
    var dataChunk = null;
    var chunkCount = 0;
    while (pos + 8 <= bytes.length) {
      var id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      var size = readU32(bytes, pos + 4);
      var body = pos + 8;
      if (body + size > bytes.length) {
        return { ok: false, error: failure('wav', '区块 “' + id + '” 越过文件结尾。') };
      }
      if (id === 'fmt ') {
        if (fmtChunk) return { ok: false, error: failure('wav', 'WAV 含多个 fmt 区块。') };
        fmtChunk = { offset: body, size: size };
      } else if (id === 'data') {
        if (dataChunk) return { ok: false, error: failure('wav', 'WAV 含多个 data 区块。') };
        dataChunk = { offset: body, size: size };
      }
      chunkCount++;
      pos = body + size + (size & 1);
    }

    if (pos !== bytes.length) {
      return { ok: false, error: failure('wav', 'RIFF 区块长度与文件不一致。') };
    }
    if (!fmtChunk || !dataChunk) {
      return { ok: false, error: failure('wav', 'WAV 必须恰好包含一个 fmt 和一个 data 区块。') };
    }
    if (fmtChunk.size < 16) {
      return { ok: false, error: failure('wav', 'fmt 区块长度不足 16 字节。') };
    }

    var fmt = fmtChunk.offset;
    var audioFormat = bytes[fmt] | (bytes[fmt + 1] << 8);
    var channels = bytes[fmt + 2] | (bytes[fmt + 3] << 8);
    var sampleRate = readU32(bytes, fmt + 4);
    var byteRate = readU32(bytes, fmt + 8);
    var blockAlign = bytes[fmt + 12] | (bytes[fmt + 13] << 8);
    var bitDepth = bytes[fmt + 14] | (bytes[fmt + 15] << 8);

    if (audioFormat !== 1) {
      return { ok: false, error: failure('wav', '仅支持 PCM（格式码 1），实际为 ' + audioFormat + '。') };
    }
    if (channels !== 1 && channels !== 2) {
      return { ok: false, error: failure('wav', '仅支持单声道或双声道，实际 ' + channels + ' 声道。') };
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      return { ok: false, error: failure('wav', '仅支持 16 或 24 位，实际 ' + bitDepth + ' 位。') };
    }
    if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) {
      return { ok: false, error: failure('wav', '采样率须在 8–48 kHz，实际 ' + sampleRate + ' Hz。') };
    }
    var bytesPerSample = bitDepth / 8;
    var expectedAlign = channels * bytesPerSample;
    if (blockAlign !== expectedAlign) {
      return { ok: false, error: failure('wav', 'blockAlign=' + blockAlign + '，与声道数/位深推算的 ' + expectedAlign + ' 不符。') };
    }
    // byteRate 在部分录音设备写入不准，且不影响帧计数，这里仅在明显为零时提示性忽略，不做硬校验。
    void byteRate;
    if (dataChunk.size % blockAlign !== 0) {
      return { ok: false, error: failure('wav', 'data 字节数不是整帧。') };
    }
    var totalFrames = dataChunk.size / blockAlign;
    if (totalFrames <= 0) {
      return { ok: false, error: failure('wav', 'data 区块为空。') };
    }
    if (totalFrames > MAX_SECONDS * sampleRate) {
      return {
        ok: false,
        error: failure('wav', '录音长度 ' + (totalFrames / sampleRate).toFixed(2) + ' 秒，超过 90 秒上限。')
      };
    }

    var channelsData = [];
    for (var c = 0; c < channels; c++) channelsData.push(new Int32Array(totalFrames));
    var dataOffset = dataChunk.offset;
    var frameBytes = blockAlign;
    var i;
    if (bitDepth === 16) {
      if (channels === 1) {
        var mono16 = channelsData[0];
        for (i = 0; i < totalFrames; i++) {
          var o16 = dataOffset + i * 2;
          mono16[i] = (bytes[o16] | (bytes[o16 + 1] << 8)) << 16 >> 16;
        }
      } else {
        var l16 = channelsData[0];
        var r16 = channelsData[1];
        for (i = 0; i < totalFrames; i++) {
          var p16 = dataOffset + i * 4;
          l16[i] = (bytes[p16] | (bytes[p16 + 1] << 8)) << 16 >> 16;
          r16[i] = (bytes[p16 + 2] | (bytes[p16 + 3] << 8)) << 16 >> 16;
        }
      }
    } else {
      if (channels === 1) {
        var mono24 = channelsData[0];
        for (i = 0; i < totalFrames; i++) {
          var o24 = dataOffset + i * 3;
          var v = bytes[o24] | (bytes[o24 + 1] << 8) | (bytes[o24 + 2] << 16);
          mono24[i] = (v << 8) >> 8;
        }
      } else {
        var l24 = channelsData[0];
        var r24 = channelsData[1];
        for (i = 0; i < totalFrames; i++) {
          var p24 = dataOffset + i * 6;
          var lv = bytes[p24] | (bytes[p24 + 1] << 8) | (bytes[p24 + 2] << 16);
          var rv = bytes[p24 + 3] | (bytes[p24 + 4] << 8) | (bytes[p24 + 5] << 16);
          l24[i] = (lv << 8) >> 8;
          r24[i] = (rv << 8) >> 8;
        }
      }
    }

    return {
      ok: true,
      sampleRate: sampleRate,
      channels: channels,
      bitDepth: bitDepth,
      totalFrames: totalFrames,
      channelsData: channelsData
    };
  }

  /**
   * 生成 WAV 字节。channelsData 为各声道的 Int32Array（整段），
   * start/end 为左闭右开帧区间。
   */
  function encodeWav(sampleRate, channels, bitDepth, channelsData, start, end) {
    start = start === undefined ? 0 : start;
    end = end === undefined ? channelsData[0].length : end;
    var frames = end - start;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = channels * bytesPerSample;
    var dataSize = frames * blockAlign;
    var pad = dataSize & 1;
    var riffSize = 4 + 8 + 16 + 8 + dataSize + pad;
    var out = new Uint8Array(8 + riffSize);

    out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;
    writeU32(out, 4, riffSize);
    out[8] = 0x57; out[9] = 0x41; out[10] = 0x56; out[11] = 0x45;
    out[12] = 0x66; out[13] = 0x6d; out[14] = 0x74; out[15] = 0x20;
    writeU32(out, 16, 16);
    out[20] = 1; out[21] = 0;
    out[22] = channels & 0xff; out[23] = channels >> 8;
    writeU32(out, 24, sampleRate);
    writeU32(out, 28, sampleRate * blockAlign);
    out[32] = blockAlign & 0xff; out[33] = blockAlign >> 8;
    out[34] = bitDepth & 0xff; out[35] = bitDepth >> 8;
    out[36] = 0x64; out[37] = 0x61; out[38] = 0x74; out[39] = 0x61;
    writeU32(out, 40, dataSize);

    var pos = 44;
    if (bitDepth === 16) {
      if (channels === 1) {
        var m = channelsData[0];
        for (var i = start; i < end; i++) {
          var s = m[i];
          out[pos++] = s & 0xff;
          out[pos++] = (s >> 8) & 0xff;
        }
      } else {
        var l = channelsData[0];
        var r = channelsData[1];
        for (var j = start; j < end; j++) {
          var a = l[j], b = r[j];
          out[pos++] = a & 0xff; out[pos++] = (a >> 8) & 0xff;
          out[pos++] = b & 0xff; out[pos++] = (b >> 8) & 0xff;
        }
      }
    } else {
      if (channels === 1) {
        var mm = channelsData[0];
        for (var q = start; q < end; q++) {
          var v = mm[q];
          out[pos++] = v & 0xff;
          out[pos++] = (v >> 8) & 0xff;
          out[pos++] = (v >> 16) & 0xff;
        }
      } else {
        var ll = channelsData[0];
        var rr = channelsData[1];
        for (var t = start; t < end; t++) {
          var lv = ll[t], rv = rr[t];
          out[pos++] = lv & 0xff; out[pos++] = (lv >> 8) & 0xff; out[pos++] = (lv >> 16) & 0xff;
          out[pos++] = rv & 0xff; out[pos++] = (rv >> 8) & 0xff; out[pos++] = (rv >> 16) & 0xff;
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 位写入 / 位读取                                                     */
  /* ------------------------------------------------------------------ */

  function BitWriter(buf, offset) {
    this.buf = buf;
    this.pos = offset;
    this.acc = 0;
    this.nbits = 0;
  }

  // 追加 n (<=24) 位，高位先写。
  BitWriter.prototype.append = function (value, n) {
    if (n <= 0) return;
    var mask = n === 32 ? 0xffffffff : (1 << n) - 1;
    this.acc = ((this.acc << n) | (value & mask)) >>> 0;
    this.nbits += n;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      this.buf[this.pos++] = (this.acc >>> this.nbits) & 0xff;
    }
    this.acc &= (1 << this.nbits) - 1;
  };

  BitWriter.prototype.zeros = function (n) {
    while (n > 24) {
      this.append(0, 24);
      n -= 24;
    }
    this.append(0, n);
  };

  BitWriter.prototype.bits28 = function (value) {
    this.append(value >>> 4, 24);
    this.append(value & 0xf, 4);
  };

  // 最少的 0 补到字节边界。
  BitWriter.prototype.finish = function () {
    if (this.nbits > 0) {
      this.buf[this.pos++] = (this.acc << (8 - this.nbits)) & 0xff;
      this.acc = 0;
      this.nbits = 0;
    }
  };

  function BitReader(bytes, start, end) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.acc = 0;
    this.nbits = 0;
    this.bitPos = start * 8;
  }

  // 读 n (<=24) 位；越界返回 -1。
  BitReader.prototype.read = function (n) {
    if (n === 0) return 0;
    while (this.nbits < n) {
      if (this.pos >= this.end) return -1;
      this.acc = ((this.acc << 8) | this.bytes[this.pos++]) >>> 0;
      this.nbits += 8;
    }
    this.nbits -= n;
    var v = (this.acc >>> this.nbits) & ((1 << n) - 1);
    this.acc &= (1 << this.nbits) - 1;
    this.bitPos += n;
    return v;
  };

  // 读一元前缀里的 0 的个数，最多 31；遇 1 返回计数，遇 31 个 0 返回 31。
  BitReader.prototype.unary = function () {
    var q = 0;
    while (q < ESCAPE_Q) {
      var b = this.read(1);
      if (b < 0) return -1;
      if (b === 1) return q;
      q++;
    }
    return ESCAPE_Q;
  };

  BitReader.prototype.bits28 = function () {
    var hi = this.read(24);
    if (hi < 0) return -1;
    var lo = this.read(4);
    if (lo < 0) return -1;
    return hi * 16 + lo;
  };

  /* ------------------------------------------------------------------ */
  /* 预测与残差                                                          */
  /* ------------------------------------------------------------------ */

  // 把 src[start..start+n) 按给定预测阶变换为映射后的 u 序列（u >= 0）。
  function residualU(src, start, n, order) {
    var u = new Int32Array(n);
    var i, r, prev, prev2;
    if (order === 0) {
      for (i = 0; i < n; i++) {
        r = src[start + i];
        u[i] = r >= 0 ? r * 2 : -r * 2 - 1;
      }
    } else if (order === 1) {
      prev = 0;
      for (i = 0; i < n; i++) {
        var v1 = src[start + i];
        r = v1 - prev;
        prev = v1;
        u[i] = r >= 0 ? r * 2 : -r * 2 - 1;
      }
    } else {
      prev = 0;
      prev2 = 0;
      for (i = 0; i < n; i++) {
        var v2 = src[start + i];
        r = v2 - (2 * prev - prev2);
        prev2 = prev;
        prev = v2;
        u[i] = r >= 0 ? r * 2 : -r * 2 - 1;
      }
    }
    return u;
  }

  // 某路所有 k 的位数（未补齐），带转义开销。
  // 返回 Float64Array(16)；顺带返回总额最小的 k 与索引。
  function costAllK(u) {
    var n = u.length;
    var costs = new Float64Array(16);
    var k, i;
    // 展开 16 个累加器，避免内层数组访问开销。
    var c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0;
    var c8 = 0, c9 = 0, c10 = 0, c11 = 0, c12 = 0, c13 = 0, c14 = 0, c15 = 0;
    for (i = 0; i < n; i++) {
      var v = u[i];
      var q;
      q = v; c0 += q < 31 ? q + 1 : 59;
      q = v >>> 1; c1 += q < 31 ? q + 2 : 59;
      q = v >>> 2; c2 += q < 31 ? q + 3 : 59;
      q = v >>> 3; c3 += q < 31 ? q + 4 : 59;
      q = v >>> 4; c4 += q < 31 ? q + 5 : 59;
      q = v >>> 5; c5 += q < 31 ? q + 6 : 59;
      q = v >>> 6; c6 += q < 31 ? q + 7 : 59;
      q = v >>> 7; c7 += q < 31 ? q + 8 : 59;
      q = v >>> 8; c8 += q < 31 ? q + 9 : 59;
      q = v >>> 9; c9 += q < 31 ? q + 10 : 59;
      q = v >>> 10; c10 += q < 31 ? q + 11 : 59;
      q = v >>> 11; c11 += q < 31 ? q + 12 : 59;
      q = v >>> 12; c12 += q < 31 ? q + 13 : 59;
      q = v >>> 13; c13 += q < 31 ? q + 14 : 59;
      q = v >>> 14; c14 += q < 31 ? q + 15 : 59;
      q = v >>> 15; c15 += q < 31 ? q + 16 : 59;
    }
    costs[0] = c0; costs[1] = c1; costs[2] = c2; costs[3] = c3;
    costs[4] = c4; costs[5] = c5; costs[6] = c6; costs[7] = c7;
    costs[8] = c8; costs[9] = c9; costs[10] = c10; costs[11] = c11;
    costs[12] = c12; costs[13] = c13; costs[14] = c14; costs[15] = c15;
    return costs;
  }

  // 每路：在 0..2 阶 × 0..15 k 中选位数最短者；同长按阶数、k 升序。
  function pickChannel(src, start, n) {
    var best = { total: Infinity, order: 0, k: 0, u: null };
    for (var order = 0; order < 3; order++) {
      var u = residualU(src, start, n, order);
      var costs = costAllK(u);
      for (var k = 0; k < 16; k++) {
        var total = costs[k];
        if (
          total < best.total ||
          (total === best.total && (order < best.order || (order === best.order && k < best.k)))
        ) {
          best.total = total;
          best.order = order;
          best.k = k;
          best.u = u;
        }
      }
    }
    return best;
  }

  function writeChannel(writer, u, k) {
    var n = u.length;
    for (var i = 0; i < n; i++) {
      var v = u[i];
      var q = v >>> k;
      if (q < ESCAPE_Q) {
        if (q > 0) writer.zeros(q);
        writer.append(1, 1);
        if (k > 0) writer.append(v & ((1 << k) - 1), k <= 24 ? k : 24);
      } else {
        writer.zeros(ESCAPE_Q);
        writer.bits28(v);
      }
    }
  }

  /**
   * 编码一个块。channels 为各声道 Int32Array（整段），start 为块起始帧，
   * frames 为本块帧数。返回 { bytes, info } 或 { error }。
   */
  function encodeBlock(channels, start, frames, bitDepth, stereo) {
    var modes = stereo ? [0, 1] : [0];
    var best = null;
    var mode, c;

    for (var mi = 0; mi < modes.length; mi++) {
      mode = modes[mi];
      var work = [];
      if (!stereo) {
        work.push({ arr: channels[0], start: start });
      } else if (mode === 0) {
        work.push({ arr: channels[0], start: start });
        work.push({ arr: channels[1], start: start });
      } else {
        var l = channels[0], r = channels[1];
        var mid = new Int32Array(frames);
        var side = new Int32Array(frames);
        for (c = 0; c < frames; c++) {
          var sum = l[start + c] + r[start + c];
          side[c] = r[start + c] - l[start + c];
          mid[c] = sum >= 0 ? sum >> 1 : -((-sum + 1) >> 1); // floor((L+R)/2)
        }
        work.push({ arr: mid, start: 0 });
        work.push({ arr: side, start: 0 });
      }

      var picks = [];
      var total = 0;
      for (var ch = 0; ch < work.length; ch++) {
        var pick = pickChannel(work[ch].arr, work[ch].start, frames);
        picks.push(pick);
        total += pick.total;
      }

      if (
        best === null ||
        total < best.total ||
        (total === best.total && mode < best.mode) ||
        (total === best.total &&
          mode === best.mode &&
          tieCompare(picks, best.picks) < 0)
      ) {
        best = { total: total, mode: mode, picks: picks };
      }
    }

    var headerLen = 1 + 2 * (stereo ? 2 : 1);
    var byteLen = headerLen + ceilDiv(best.total, 8);
    var out = new Uint8Array(byteLen);
    out[0] = best.mode;
    var hp = 1;
    for (var p = 0; p < best.picks.length; p++) {
      out[hp++] = best.picks[p].order;
      out[hp++] = best.picks[p].k;
    }
    var writer = new BitWriter(out, headerLen);
    for (var w = 0; w < best.picks.length; w++) {
      writeChannel(writer, best.picks[w].u, best.picks[w].k);
    }
    writer.finish();

    return {
      bytes: out,
      info: {
        mode: best.mode,
        orders: best.picks.map(function (x) { return x.order; }),
        ks: best.picks.map(function (x) { return x.k; }),
        bits: best.total
      }
    };
  }

  // 同长时比较：模式之后依次第一路阶数、第一路 k、第二路阶数、第二路 k。
  function tieCompare(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i].order !== b[i].order) return a[i].order - b[i].order;
      if (a[i].k !== b[i].k) return a[i].k - b[i].k;
    }
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* 整档编码                                                            */
  /* ------------------------------------------------------------------ */

  function encode(options) {
    var channels = options.channelsData;
    var sampleRate = options.sampleRate;
    var bitDepth = options.bitDepth;
    var channelsCount = options.channels || channels.length;
    var totalFrames = channels[0].length;
    var stereo = channelsCount === 2;

    if (!totalFrames) return { ok: false, error: failure('encode', '没有可编码的帧。') };
    if (channelsCount !== 1 && channelsCount !== 2) {
      return { ok: false, error: failure('encode', '仅支持单声道或双声道。') };
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      return { ok: false, error: failure('encode', '仅支持 16 或 24 位。') };
    }
    if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) {
      return { ok: false, error: failure('encode', '采样率须在 8–48 kHz。') };
    }
    if (totalFrames > MAX_SECONDS * sampleRate) {
      return { ok: false, error: failure('encode', '录音超过 90 秒上限。') };
    }

    var numBlocks = ceilDiv(totalFrames, FRAMES_PER_BLOCK);
    var dirEnd = HEADER_SIZE + numBlocks * ENTRY_SIZE;
    var chunks = [];
    var entries = new Array(numBlocks);
    var offset = dirEnd;

    for (var b = 0; b < numBlocks; b++) {
      var start = b * FRAMES_PER_BLOCK;
      var frames = Math.min(FRAMES_PER_BLOCK, totalFrames - start);
      var result = encodeBlock(channels, start, frames, bitDepth, stereo);
      if (result.error) return { ok: false, error: result.error };
      var block = result.bytes;
      var crc = crc32(block, 0, block.length);
      entries[b] = { offset: offset, size: block.length, crc: crc, info: result.info, frames: frames };
      offset += block.length;
      chunks.push(block);
      if (options.onProgress && b % 64 === 0) {
        options.onProgress(b + 1, numBlocks);
      }
    }

    var out = new Uint8Array(offset);
    out[0] = 0x52; out[1] = 0x50; out[2] = 0x41; out[3] = 0x31;
    writeU32(out, 4, sampleRate);
    out[8] = channelsCount;
    out[9] = bitDepth;
    writeU32(out, 10, totalFrames);
    writeU32(out, 14, numBlocks);

    var dp = HEADER_SIZE;
    for (var e = 0; e < numBlocks; e++) {
      writeU32(out, dp, entries[e].offset);
      writeU32(out, dp + 4, entries[e].size);
      writeU32(out, dp + 8, entries[e].crc);
      dp += ENTRY_SIZE;
    }
    var pos = dirEnd;
    for (var ci = 0; ci < chunks.length; ci++) {
      out.set(chunks[ci], pos);
      pos += chunks[ci].length;
    }

    return {
      ok: true,
      bytes: out,
      entries: entries,
      header: {
        sampleRate: sampleRate,
        channels: channelsCount,
        bitDepth: bitDepth,
        totalFrames: totalFrames,
        numBlocks: numBlocks
      }
    };
  }

  /**
   * 异步分块编码：每若干块让出事件循环，便于界面显示进度而保持响应。
   * options 与 encode 相同，另接受 onProgress(done, total) 与 chunk（每批块数）。
   */
  function encodeAsync(options) {
    var channels = options.channelsData;
    var sampleRate = options.sampleRate;
    var bitDepth = options.bitDepth;
    var channelsCount = options.channels || channels.length;
    var totalFrames = channels[0].length;
    var stereo = channelsCount === 2;

    if (!totalFrames) return Promise.resolve({ ok: false, error: failure('encode', '没有可编码的帧。') });
    if (channelsCount !== 1 && channelsCount !== 2) {
      return Promise.resolve({ ok: false, error: failure('encode', '仅支持单声道或双声道。') });
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      return Promise.resolve({ ok: false, error: failure('encode', '仅支持 16 或 24 位。') });
    }
    if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) {
      return Promise.resolve({ ok: false, error: failure('encode', '采样率须在 8–48 kHz。') });
    }
    if (totalFrames > MAX_SECONDS * sampleRate) {
      return Promise.resolve({ ok: false, error: failure('encode', '录音超过 90 秒上限。') });
    }

    var numBlocks = ceilDiv(totalFrames, FRAMES_PER_BLOCK);
    var dirEnd = HEADER_SIZE + numBlocks * ENTRY_SIZE;
    var entries = new Array(numBlocks);
    var chunks = new Array(numBlocks);
    var offset = dirEnd;
    var chunkSize = options.chunk || 32;
    var b = 0;

    function step() {
      var end = Math.min(numBlocks, b + chunkSize);
      for (; b < end; b++) {
        var start = b * FRAMES_PER_BLOCK;
        var frames = Math.min(FRAMES_PER_BLOCK, totalFrames - start);
        var result = encodeBlock(channels, start, frames, bitDepth, stereo);
        if (result.error) return { ok: false, error: result.error };
        var block = result.bytes;
        chunks[b] = block;
        entries[b] = {
          offset: offset,
          size: block.length,
          crc: crc32(block, 0, block.length),
          info: result.info,
          frames: frames
        };
        offset += block.length;
      }
      if (options.onProgress) options.onProgress(b, numBlocks);
      if (b >= numBlocks) return null;
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(step());
        }, 0);
      });
    }

    function finalize() {
      var out = new Uint8Array(offset);
      out[0] = 0x52; out[1] = 0x50; out[2] = 0x41; out[3] = 0x31;
      writeU32(out, 4, sampleRate);
      out[8] = channelsCount;
      out[9] = bitDepth;
      writeU32(out, 10, totalFrames);
      writeU32(out, 14, numBlocks);
      var dp = HEADER_SIZE;
      for (var e = 0; e < numBlocks; e++) {
        writeU32(out, dp, entries[e].offset);
        writeU32(out, dp + 4, entries[e].size);
        writeU32(out, dp + 8, entries[e].crc);
        dp += ENTRY_SIZE;
      }
      var pos = dirEnd;
      for (var ci = 0; ci < numBlocks; ci++) {
        out.set(chunks[ci], pos);
        pos += chunks[ci].length;
      }
      return {
        ok: true,
        bytes: out,
        entries: entries,
        header: {
          sampleRate: sampleRate,
          channels: channelsCount,
          bitDepth: bitDepth,
          totalFrames: totalFrames,
          numBlocks: numBlocks
        }
      };
    }

    return new Promise(function (resolve) {
      function drive() {
        var r = step();
        if (r === null) {
          resolve(finalize());
        } else if (r && r.ok === false) {
          resolve(r);
        } else {
          r.then(drive);
        }
      }
      drive();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 归档解析                                                            */
  /* ------------------------------------------------------------------ */

  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_SIZE) {
      return { ok: false, error: failure('header', '文件不足 18 字节，无法读取 RPA1 头。') };
    }
    if (bytes[0] !== 0x52 || bytes[1] !== 0x50 || bytes[2] !== 0x41 || bytes[3] !== 0x31) {
      return { ok: false, error: failure('header', 'RPA1 魔数不匹配。') };
    }
    var sampleRate = readU32(bytes, 4);
    var channels = bytes[8];
    var bitDepth = bytes[9];
    var totalFrames = readU32(bytes, 10);
    var numBlocks = readU32(bytes, 14);

    if (channels !== 1 && channels !== 2) {
      return { ok: false, error: failure('header', '声道数字段非法：' + channels + '。') };
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      return { ok: false, error: failure('header', '位深字段非法：' + bitDepth + '。') };
    }
    if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) {
      return { ok: false, error: failure('header', '采样率字段非法：' + sampleRate + '。') };
    }
    if (totalFrames <= 0) {
      return { ok: false, error: failure('header', '总帧数为 0。') };
    }
    if (totalFrames > MAX_SECONDS * sampleRate) {
      return { ok: false, error: failure('header', '总帧数超过 90 秒上限。') };
    }
    var expectBlocks = ceilDiv(totalFrames, FRAMES_PER_BLOCK);
    if (numBlocks !== expectBlocks) {
      return {
        ok: false,
        error: failure('header', '块数 ' + numBlocks + ' 与总帧数推算的 ' + expectBlocks + ' 不符。')
      };
    }

    return {
      ok: true,
      header: {
        sampleRate: sampleRate,
        channels: channels,
        bitDepth: bitDepth,
        totalFrames: totalFrames,
        numBlocks: numBlocks
      }
    };
  }

  /**
   * 解析 RPA1（含索引容错）。头错误返回 ok:false（调用方应保留旧归档）。
   * 索引错误不阻止打开：对应条目 status='index'，并在 errors 中记录条目号。
   */
  function parse(bytes) {
    var parsed = parseHeader(bytes);
    if (!parsed.ok) return { ok: false, error: parsed.error, errors: [parsed.error] };
    var header = parsed.header;
    var errors = [];
    var dirEnd = HEADER_SIZE + header.numBlocks * ENTRY_SIZE;
    var entries = new Array(header.numBlocks);

    if (bytes.length < dirEnd) {
      // 目录本身被截断：保留头信息，全部条目标记为索引损坏。
      errors.push(
        failure('index', '块目录被截断：需要 ' + dirEnd + ' 字节，文件只有 ' + bytes.length + ' 字节。', {
          entry: 0
        })
      );
      for (var z = 0; z < header.numBlocks; z++) {
        entries[z] = makeEntry(z, header, 0, 0, 0, 'index', '目录被截断', dirEnd, bytes.length);
      }
      return { ok: true, header: header, dirEnd: dirEnd, bytes: bytes, entries: entries, errors: errors };
    }

    // 先读目录。
    var raw = new Array(header.numBlocks);
    for (var i = 0; i < header.numBlocks; i++) {
      var p = HEADER_SIZE + i * ENTRY_SIZE;
      raw[i] = { offset: readU32(bytes, p), size: readU32(bytes, p + 4), crc: readU32(bytes, p + 8) };
    }

    // 每个条目先判“几何是否落在合法范围内”，并算一次 CRC。
    // anchor 表示“在目录声明的 (偏移, 块长) 处 CRC 与目录一致”——数据与索引都对得上。
    var minBlock = 1 + 2 * header.channels;
    var bound = new Array(header.numBlocks);
    var anchor = new Array(header.numBlocks);
    var actualCrc = new Array(header.numBlocks);
    for (var b0 = 0; b0 < header.numBlocks; b0++) {
      var r0 = raw[b0];
      bound[b0] = r0.offset >= dirEnd && r0.size >= minBlock && r0.offset + r0.size <= bytes.length;
      actualCrc[b0] = bound[b0] ? crc32(bytes, r0.offset, r0.offset + r0.size) : null;
      anchor[b0] = bound[b0] && actualCrc[b0] === r0.crc;
    }

    // 用“目录声明值”判断某条目是否与相邻条目首尾相接（连续铺排是格式硬约束）：
    //   · 数据损坏不会改动目录，故该条目几何仍与邻居严丝合缝；
    //   · 索引损坏改动了偏移或块长，该条目几何必然与邻居对不上。
    // 于是：anchor → 好块；几何自洽但 CRC 不符 → 块损坏；几何对不上 → 索引损坏。
    // 这样不论篡改偏移还是块长，都能精确指到条目，完好的块始终可用。
    for (var j = 0; j < header.numBlocks; j++) {
      var e = raw[j];
      var localConsistent = bound[j];
      if (localConsistent) {
        if (j === 0) {
          if (e.offset !== dirEnd) localConsistent = false;
        } else if (e.offset !== raw[j - 1].offset + raw[j - 1].size) {
          localConsistent = false;
        }
        if (localConsistent) {
          var endHere = e.offset + e.size;
          if (j === header.numBlocks - 1) {
            if (endHere !== bytes.length) localConsistent = false;
          } else if (endHere !== raw[j + 1].offset) {
            localConsistent = false;
          }
        }
      }

      var status;
      var problem = null;
      if (anchor[j]) {
        status = 'ok';
      } else if (localConsistent) {
        status = 'crc';
        problem = 'CRC32 校验失败（目录 0x' + hex8(e.crc) + '，实际 0x' + hex8(actualCrc[j]) + '）。';
      } else {
        status = 'index';
        if (!bound[j]) {
          if (e.size < minBlock) problem = '块长 ' + e.size + ' 小于块头最小长度 ' + minBlock + '。';
          else if (e.offset < dirEnd) problem = '偏移 ' + e.offset + ' 落在目录区内（目录结束于 ' + dirEnd + '）。';
          else problem = '偏移+长度 ' + (e.offset + e.size) + ' 越过文件尾 ' + bytes.length + '。';
        } else if (j === 0 ? e.offset !== dirEnd : e.offset !== raw[j - 1].offset + raw[j - 1].size) {
          problem = '偏移 ' + e.offset + ' 与相邻块首尾不对接（上一块结束于 ' +
            (j === 0 ? dirEnd : raw[j - 1].offset + raw[j - 1].size) + '）。';
        } else {
          problem = '块长 ' + e.size + ' 与下一块起始 ' +
            (j < header.numBlocks - 1 ? raw[j + 1].offset : bytes.length) + ' 不对接。';
        }
      }

      entries[j] = makeEntry(j, header, e.offset, e.size, e.crc, status, problem, dirEnd, bytes.length);
      entries[j].actualCrc = actualCrc[j];
      if (status !== 'ok') {
        // 损坏条目仍尝试读块头用于展示，但不信任其内容。
        entries[j].headerInfo = tryParseBlockHeader(bytes, entries[j], header);
      }
      if (status === 'index') {
        errors.push(failure('index', problem, { entry: j }));
      } else if (status === 'crc') {
        errors.push(failure('block', problem, { entry: j }));
      } else {
        entries[j].headerInfo = tryParseBlockHeader(bytes, entries[j], header);
        if (!entries[j].headerInfo.ok) {
          entries[j].status = 'block';
          entries[j].error = entries[j].headerInfo.error;
          errors.push(failure('block', entries[j].error, { entry: j }));
        }
      }
    }

    return {
      ok: true,
      header: header,
      dirEnd: dirEnd,
      bytes: bytes,
      entries: entries,
      errors: errors
    };
  }

  function makeEntry(index, header, offset, size, crc, status, error, dirEnd, fileLength) {
    var startFrame = index * FRAMES_PER_BLOCK;
    return {
      index: index,
      offset: offset,
      size: size,
      crc: crc,
      actualCrc: null,
      status: status,
      error: error || null,
      startFrame: startFrame,
      frames: Math.min(FRAMES_PER_BLOCK, Math.max(0, header.totalFrames - startFrame)),
      endFrame: Math.min(header.totalFrames, startFrame + FRAMES_PER_BLOCK),
      dirEnd: dirEnd,
      fileLength: fileLength,
      headerInfo: null
    };
  }

  function hex8(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function tryParseBlockHeader(bytes, entry, header) {
    if (entry.size < 1 + 2 * header.channels) {
      return { ok: false, error: '块头长度不足。' };
    }
    var p = entry.offset;
    var mode = bytes[p];
    if (mode !== 0 && mode !== 1) return { ok: false, error: '块模式 ' + mode + ' 非法。' };
    if (mode === 1 && header.channels !== 2) return { ok: false, error: '单声道块使用了中侧模式。' };
    var chans = header.channels;
    var orders = [];
    var ks = [];
    for (var c = 0; c < chans; c++) {
      var order = bytes[p + 1 + c * 2];
      var k = bytes[p + 2 + c * 2];
      if (order > 2) return { ok: false, error: '第 ' + (c + 1) + ' 路预测阶 ' + order + ' 越界。' };
      if (k > 15) return { ok: false, error: '第 ' + (c + 1) + ' 路 Rice 参数 ' + k + ' 越界。' };
      orders.push(order);
      ks.push(k);
    }
    return { ok: true, mode: mode, orders: orders, ks: ks, headerLen: 1 + 2 * chans };
  }

  /* ------------------------------------------------------------------ */
  /* 块解码                                                              */
  /* ------------------------------------------------------------------ */

  function decodeBlockPayload(bytes, entry, header, headerInfo) {
    var chans = header.channels;
    var n = entry.frames;
    var headerLen = headerInfo.headerLen;
    var reader = new BitReader(bytes, entry.offset + headerLen, entry.offset + entry.size);
    var decoded = [];
    var range = bitDepthRange(header.bitDepth);
    // 中侧模式下中间量（含“侧”）可超 PCM 范围，只有还原出的 L/R 才做范围校验；
    // 但仍需一个量级上界，防止 CRC 自洽但内容被构造的块让预测器发散并静默回绕 int32。
    // 合法侧声道最大约 2^(bitDepth)，这里留足余量。
    var checkIntermediate = headerInfo.mode !== 1;
    var intermediateMax = Math.pow(2, header.bitDepth + 2);
    var c, i;

    function bad(message) {
      return { ok: false, error: failure('block', message) };
    }

    for (c = 0; c < chans; c++) {
      var order = headerInfo.orders[c];
      var k = headerInfo.ks[c];
      var out = new Int32Array(n);
      var prev = 0;
      var prev2 = 0;
      for (i = 0; i < n; i++) {
        var q = reader.unary();
        if (q < 0) return bad('第 ' + (c + 1) + ' 路位流在第 ' + i + ' 个样本处提前结束。');
        var u;
        if (q === ESCAPE_Q) {
          u = reader.bits28();
          if (u < 0) return bad('第 ' + (c + 1) + ' 路转义位流提前结束。');
          if ((u >>> k) < ESCAPE_Q) {
            return bad('第 ' + (c + 1) + ' 路转义中 q=' + (u >>> k) + ' 小于 31。');
          }
        } else {
          var rem = reader.read(k);
          if (rem < 0) return bad('第 ' + (c + 1) + ' 路余数位流提前结束。');
          u = q * Math.pow(2, k) + rem;
        }
        var r = u & 1 ? -((u + 1) / 2) : u / 2;
        var pred = order === 0 ? 0 : order === 1 ? prev : 2 * prev - prev2;
        var value = pred + r;
        if (checkIntermediate) {
          if (value < range.min || value > range.max) {
            return bad('第 ' + (c + 1) + ' 路解码出超出 ' + header.bitDepth + ' 位范围的值 ' + value + '。');
          }
        } else if (value < -intermediateMax || value > intermediateMax) {
          return bad('第 ' + (c + 1) + ' 路中间量 ' + value + ' 超出允许量级。');
        }
        out[i] = value;
        prev2 = prev;
        prev = value;
      }
      decoded.push(out);
    }

    // 补齐位与额外字节检查。
    var consumedBits = reader.bitPos - (entry.offset + headerLen) * 8;
    var payloadBytes = ceilDiv(consumedBits, 8);
    if (headerLen + payloadBytes !== entry.size) {
      if (headerLen + payloadBytes < entry.size) {
        return bad('块尾部多出 ' + (entry.size - headerLen - payloadBytes) + ' 字节。');
      }
      return bad('块位流超出块长。');
    }
    var padBits = payloadBytes * 8 - consumedBits;
    if (padBits > 0) {
      var last = bytes[entry.offset + entry.size - 1];
      if ((last & ((1 << padBits) - 1)) !== 0) {
        return bad('块末尾补位非零。');
      }
    }

    if (headerInfo.mode === 1) {
      var mid = decoded[0];
      var side = decoded[1];
      var left = new Int32Array(n);
      var right = new Int32Array(n);
      for (i = 0; i < n; i++) {
        var s = side[i];
        var half = s >= 0 ? s >> 1 : -((-s + 1) >> 1); // floor(side / 2)
        var lv = mid[i] - half;
        var rv = lv + s;
        if (lv < range.min || lv > range.max || rv < range.min || rv > range.max) {
          return bad('中侧解码出超出 ' + header.bitDepth + ' 位范围的 PCM 值。');
        }
        left[i] = lv;
        right[i] = rv;
      }
      decoded = [left, right];
    }

    return { ok: true, channels: decoded };
  }

  /**
   * 解码单个块。返回 { ok, channels } 或 { ok:false, error }。
   * 索引损坏 / CRC 不符 / 块结构错误的块均拒绝解码。
   */
  function decodeBlock(archive, index) {
    var entry = archive.entries[index];
    if (!entry) return { ok: false, error: failure('block', '块 ' + index + ' 不存在。') };
    if (entry.status === 'index') {
      return { ok: false, error: failure('index', '索引条目 ' + index + ' 损坏：' + entry.error, { entry: index }) };
    }
    if (entry.status === 'crc') {
      return { ok: false, error: failure('block', '块 ' + index + ' CRC 校验失败。', { entry: index }) };
    }
    if (entry.status !== 'ok') {
      return { ok: false, error: failure('block', '块 ' + index + ' 不可解码：' + entry.error, { entry: index }) };
    }
    if (!entry.headerInfo || !entry.headerInfo.ok) {
      return { ok: false, error: failure('block', '块 ' + index + ' 块头非法：' + (entry.headerInfo && entry.headerInfo.error)) };
    }
    var result = decodeBlockPayload(archive.bytes, entry, archive.header, entry.headerInfo);
    if (!result.ok) {
      result.error.entry = index;
      return result;
    }
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 区间解码 / 导出                                                     */
  /* ------------------------------------------------------------------ */

  function blockIndexForFrame(frame) {
    return Math.floor(frame / FRAMES_PER_BLOCK);
  }

  /**
   * 解码 [start, end) 帧区间，只解码相交块。
   * 任一相交块损坏时返回 ok:false 并列出坏块号（禁止跨坏块导出）。
   */
  function decodeRange(archive, start, end) {
    var total = archive.header.totalFrames;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, error: failure('range', '区间端点必须是整数帧。') };
    }
    if (start < 0 || end > total || start >= end) {
      return { ok: false, error: failure('range', '区间 [' + start + ', ' + end + ') 超出 0..' + total + '。') };
    }
    var firstBlock = blockIndexForFrame(start);
    var lastBlock = blockIndexForFrame(end - 1);
    var bad = [];
    var pieces = [];
    for (var b = firstBlock; b <= lastBlock; b++) {
      var entry = archive.entries[b];
      if (!entry || entry.status !== 'ok') {
        bad.push(b);
        continue;
      }
      var decoded = decodeBlock(archive, b);
      if (!decoded.ok) {
        bad.push(b);
        continue;
      }
      pieces.push({ block: b, channels: decoded.channels, startFrame: entry.startFrame, frames: entry.frames });
    }
    if (bad.length) {
      return {
        ok: false,
        error: failure('block', '区间跨越损坏块 ' + bad.join(', ') + '，已禁止解码/导出。', { blocks: bad }),
        badBlocks: bad
      };
    }

    var count = end - start;
    var chans = archive.header.channels;
    var out = [];
    for (var c = 0; c < chans; c++) out.push(new Int32Array(count));
    var outPos = 0;
    for (var p = 0; p < pieces.length; p++) {
      var piece = pieces[p];
      var from = Math.max(start, piece.startFrame);
      var to = Math.min(end, piece.startFrame + piece.frames);
      var len = to - from;
      if (len <= 0) continue;
      var sourceOffset = from - piece.startFrame;
      for (var cc = 0; cc < chans; cc++) {
        out[cc].set(piece.channels[cc].subarray(sourceOffset, sourceOffset + len), outPos);
      }
      outPos += len;
    }
    return { ok: true, channels: out, blocksDecoded: pieces.length };
  }

  function exportWav(archive, start, end) {
    var decoded = decodeRange(archive, start, end);
    if (!decoded.ok) return decoded;
    var h = archive.header;
    var bytes = encodeWav(h.sampleRate, h.channels, h.bitDepth, decoded.channels, 0, decoded.channels[0].length);
    return { ok: true, bytes: bytes, channels: decoded.channels, blocksDecoded: decoded.blocksDecoded };
  }

  /* ------------------------------------------------------------------ */
  /* 描述信息                                                            */
  /* ------------------------------------------------------------------ */

  function describe(archive) {
    var h = archive.header;
    var okBlocks = 0, badBlocks = 0, indexBlocks = 0;
    for (var i = 0; i < archive.entries.length; i++) {
      var s = archive.entries[i].status;
      if (s === 'ok') okBlocks++;
      else if (s === 'index') indexBlocks++;
      else badBlocks++;
    }
    return {
      sampleRate: h.sampleRate,
      channels: h.channels,
      bitDepth: h.bitDepth,
      totalFrames: h.totalFrames,
      numBlocks: h.numBlocks,
      duration: h.totalFrames / h.sampleRate,
      okBlocks: okBlocks,
      badBlocks: badBlocks,
      indexBlocks: indexBlocks
    };
  }

  return {
    MAGIC: MAGIC,
    HEADER_SIZE: HEADER_SIZE,
    ENTRY_SIZE: ENTRY_SIZE,
    FRAMES_PER_BLOCK: FRAMES_PER_BLOCK,
    MAX_SECONDS: MAX_SECONDS,
    MIN_RATE: MIN_RATE,
    MAX_RATE: MAX_RATE,
    crc32: crc32,
    parseWav: parseWav,
    encodeWav: encodeWav,
    encodeBlock: encodeBlock,
    encode: encode,
    encodeAsync: encodeAsync,
    parse: parse,
    parseHeader: parseHeader,
    decodeBlock: decodeBlock,
    decodeRange: decodeRange,
    exportWav: exportWav,
    describe: describe
  };
});
