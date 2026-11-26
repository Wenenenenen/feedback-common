/*!
 * PDQ1 / PDM-decimation reel engine.
 * Pure, dependency-free. UMD: browser global `PDQEngine`, Node `module.exports`.
 *
 * Implements exactly the rules in 约定.txt:
 *  - PDQ1 header (LE): magic4, u32 anchor, u32 totalTicks, u8 channels, u8 D
 *  - records: u32 ts, u16 count, u8 mask, ceil(count*popcount(mask)/8) payload,
 *    u32 IEEE CRC32 over record header(7)+payload
 *  - payload tick-major then mask-bit low->high; bits LSB-first per byte
 *  - relTick = (ts - anchor) mod 2^32
 *  - records overwrite in file order; a record that fails CRC / legality is
 *    not adopted (so it never overwrites good data)
 *  - missing tick filled by parity of (anchor + relTick): even -> 0, odd -> 1
 *  - real/fill bit: 0 -> -1, 1 -> +1 ; t<0 -> 0
 *  - three cascaded length-D all-ones moving sums; outputs at D-1,2D-1,...
 *  - pcm = clamp16(roundHalfEven(exactSum*32768 / D^3))
 *  - dependency interval inclusive [T-3(D-1), T]; frame affected iff any
 *    real-domain dependency is a missing (parity-filled) tick.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDQEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEADER_LEN = 14;
  var RECORD_HEAD_LEN = 7;
  var CRC_LEN = 4;

  // ---------- utilities ----------
  function popcount8(x) {
    x = x & 0xff;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    return ((x + (x >> 4)) & 0x0f);
  }

  function createCrcTable() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }
  var CRC_TABLE = createCrcTable();

  // IEEE CRC32 of bytes[start..end) (unsigned).
  function crc32Range(bytes, start, end) {
    var crc = 0xFFFFFFFF;
    for (var i = start; i < end; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Round num/den to nearest, ties to even. den > 0. Exact integer arithmetic.
  function roundHalfEvenDiv(num, den) {
    if (den <= 0) throw new Error('den must be positive');
    if (num < 0) return -roundHalfEvenDiv(-num, den);
    var q = Math.floor(num / den);
    var r = num - q * den;
    var twice = 2 * r;
    if (twice < den) return q;
    if (twice > den) return q + 1;
    return ((q & 1) === 0) ? q : q + 1; // exact tie -> even neighbour
  }

  function clamp16(v) {
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return v;
  }

  function toUint8(input) {
    if (input instanceof Uint8Array) {
      // Zero-copy when the view already owns an origin-zero buffer (the browser
      // file.arrayBuffer() path). Copy only subviews / pooled Node Buffers so
      // relative offsets stay unambiguous.
      if (input.byteOffset === 0 &&
        input.byteLength === input.buffer.byteLength &&
        input.buffer instanceof ArrayBuffer) {
        return input;
      }
      var copy = new Uint8Array(input.length);
      copy.set(input);
      return copy;
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    }
    throw new Error('unsupported input: expected ArrayBuffer/TypedArray');
  }

  // ---------- parsing ----------
  function parsePDQ(input) {
    var bytes = toUint8(input);
    var size = bytes.length;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    var result = {
      ok: false,
      bytes: bytes,
      fileSize: size,
      headerOk: false,
      headerError: null,
      headerProblems: [],
      anchor: 0,
      totalTicks: 0,
      channels: 0,
      D: 0,
      records: [],
      truncated: null,
      trailingBytes: 0,
      consumedBytes: 0
    };

    if (size < HEADER_LEN) {
      result.headerError = '文件头被截断：至少需要 ' + HEADER_LEN + ' 字节，实际 ' + size + ' 字节';
      result.truncated = {
        recordIndex: 0, offset: Math.min(size, HEADER_LEN),
        have: size, need: HEADER_LEN, stage: 'header'
      };
      return result;
    }

    var magicOk = bytes[0] === 0x50 && bytes[1] === 0x44 && bytes[2] === 0x51 && bytes[3] === 0x31;
    if (!magicOk) {
      var tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      result.headerError = '魔数错误：期望 PDQ1，实际为 ' + JSON.stringify(tag);
      return result;
    }

    var anchor = dv.getUint32(4, true) >>> 0;
    var totalTicks = dv.getUint32(8, true) >>> 0;
    var channels = bytes[12];
    var D = bytes[13];

    result.anchor = anchor;
    result.totalTicks = totalTicks;
    result.channels = channels;
    result.D = D;

    var problems = [];
    if (D !== 32 && D !== 64) problems.push('抽取倍数 D 必须是 32 或 64（实际 ' + D + '）');
    if (!(totalTicks > 0)) problems.push('总 tick 必须为正数');
    else if ((D === 32 || D === 64) && (totalTicks % D) !== 0) {
      problems.push('总 tick ' + totalTicks + ' 不是 D=' + D + ' 的整数倍');
    }
    if (channels < 1 || channels > 8) problems.push('声道数必须在 1..8（实际 ' + channels + '）');
    result.headerProblems = problems;
    result.headerOk = problems.length === 0;

    var p = HEADER_LEN;
    var idx = 0;
    while (p < size) {
      if (size - p < RECORD_HEAD_LEN) {
        result.truncated = {
          recordIndex: idx, offset: p, have: size - p,
          need: RECORD_HEAD_LEN, stage: 'record-header'
        };
        result.trailingBytes = size - p;
        break;
      }

      var startTimestamp = dv.getUint32(p, true) >>> 0;
      var count = dv.getUint16(p + 4, true) & 0xffff;
      var mask = bytes[p + 6] & 0xff;
      var nset = popcount8(mask);
      var payloadBits = count * nset;
      var payloadLength = (payloadBits + 7) >> 3;
      var totalLength = RECORD_HEAD_LEN + payloadLength + CRC_LEN;
      var payloadOffset = p + RECORD_HEAD_LEN;
      var crcOffset = payloadOffset + payloadLength;

      if (size - p < totalLength) {
        result.truncated = {
          recordIndex: idx, offset: p, have: size - p, need: totalLength,
          stage: 'record-body', declaredCount: count, declaredMask: mask,
          payloadLength: payloadLength, crcOffset: crcOffset
        };
        result.trailingBytes = size - p;
        break;
      }

      var crcStored = dv.getUint32(crcOffset, true) >>> 0;
      var crcCalc = crc32Range(bytes, p, crcOffset) >>> 0;
      var crcOk = crcStored === crcCalc;

      // relative tick mod 2^32
      var relStart = (startTimestamp - anchor) >>> 0;

      var legal = true;
      var errors = [];
      if (count === 0) { legal = false; errors.push('tick 数为 0'); }
      if (mask === 0) { legal = false; errors.push('声道掩膜为 0'); }
      if (channels >= 1 && channels <= 8) {
        var highMask = mask & ~((1 << channels) - 1) & 0xff;
        if (highMask !== 0) {
          legal = false;
          errors.push('掩膜使用了超出声道数 ' + channels + ' 的位（0x' + highMask.toString(16) + '）');
        }
      }
      if (totalTicks > 0 && count > 0 && relStart + count > totalTicks) {
        legal = false;
        errors.push('记录越界：rel=' + relStart + ' +count=' + count + ' > total=' + totalTicks);
      }

      var adopted = !!(crcOk && legal && result.headerOk);

      result.records.push({
        index: idx,
        offset: p,
        startTimestamp: startTimestamp,
        relStart: relStart,
        count: count,
        mask: mask,
        nset: nset,
        payloadBits: payloadBits,
        payloadOffset: payloadOffset,
        payloadLength: payloadLength,
        crcOffset: crcOffset,
        crcStored: crcStored,
        crcCalc: crcCalc,
        crcOk: crcOk,
        legal: legal,
        errors: errors,
        adopted: adopted
      });

      p += totalLength;
      idx++;
    }
    result.consumedBytes = p;
    result.ok = result.headerOk;
    return result;
  }

  function readPayloadBit(bytes, rec, bitIndex) {
    var byte = bytes[rec.payloadOffset + (bitIndex >> 3)];
    return (byte >> (bitIndex & 7)) & 1;
  }

  // Build one channel grid: Int8Array(totalTicks), 0 = missing, +/-1 = real.
  function buildChannelGrid(parsed, ch) {
    var T = parsed.totalTicks;
    var grid = new Int8Array(T);
    var bytes = parsed.bytes;
    var recs = parsed.records;
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (!rec.adopted) continue;
      if ((rec.mask & (1 << ch)) === 0) continue;
      var rank = popcount8(rec.mask & ((1 << ch) - 1));
      var nset = rec.nset;
      var r0 = rec.relStart;
      var cnt = rec.count;
      var j = rank; // bit index for tick 0 of this channel, then stride nset
      for (var t = 0; t < cnt; t++, j += nset) {
        var bit = (bytes[rec.payloadOffset + (j >> 3)] >> (j & 7)) & 1;
        grid[r0 + t] = bit ? 1 : -1;
      }
    }
    return grid;
  }

  // Three cascaded D-boxcar sums via recurrences. Returns pcm Int16Array and
  // affected Uint8Array (one flag per output frame).
  function decimateGrid(grid, anchor, D) {
    var T = grid.length;
    var F = (T / D) | 0;
    var ring1 = new Int32Array(D);
    var ring2 = new Int32Array(D);
    var pcm = new Int16Array(F);
    var affected = new Uint8Array(F);
    var K = 3 * (D - 1);
    var Dmask = D - 1; // D is 32 or 64 -> power of two
    var den = D * D * D;

    var s1 = 0, s2 = 0, s3 = 0, miss = 0, f = 0;
    for (var t = 0; t < T; t++) {
      var code = grid[t];
      var xt;
      if (code === 0) xt = (((anchor + t) & 1) === 1) ? 1 : -1;
      else xt = code;

      var xd = 0;
      if (t >= D) {
        var cd = grid[t - D];
        if (cd !== 0) xd = cd;
        else xd = (((anchor + (t - D)) & 1) === 1) ? 1 : -1;
      }

      var slot = t & Dmask;
      var old1 = ring1[slot];
      var old2 = ring2[slot];

      s1 = s1 + xt - xd;
      s2 = s2 + s1 - old1;
      s3 = s3 + s2 - old2;
      ring1[slot] = s1;
      ring2[slot] = s2;

      if (code === 0) miss++;
      var rem = t - K - 1;
      if (rem >= 0 && grid[rem] === 0) miss--;

      if ((t & Dmask) === Dmask) {
        var v = roundHalfEvenDiv(s3 * 32768, den);
        pcm[f] = clamp16(v);
        affected[f] = miss > 0 ? 1 : 0;
        f++;
      }
    }
    return { pcm: pcm, affected: affected, frames: F };
  }

  function intervalsFromFlags(affected) {
    var out = [];
    var start = -1;
    for (var i = 0; i < affected.length; i++) {
      if (affected[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        out.push([start, i]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, affected.length]);
    return out;
  }

  // Full decode (synchronous). For staged UI progress use parsePDQ +
  // decodeChannel(stage) + finalizeInterleave separately.
  function decode(input) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var parsed = parsePDQ(input);
    var tParse = nowMs() - t0;
    if (parsed.headerError) {
      return { ok: false, parsed: parsed, timings: { parseMs: tParse, totalMs: tParse } };
    }

    var C = parsed.channels, D = parsed.D;
    var channels = [];
    var tCh0 = nowMs();
    for (var c = 0; c < C; c++) {
      var g0 = nowMs();
      var grid = buildChannelGrid(parsed, c);
      var tPaint = nowMs() - g0;
      var d0 = nowMs();
      var dec = decimateGrid(grid, parsed.anchor, D);
      var tFilt = nowMs() - d0;
      channels.push({
        index: c,
        pcm: dec.pcm,
        affected: dec.affected,
        intervals: intervalsFromFlags(dec.affected),
        missingTicks: countMissing(grid),
        paintMs: tPaint,
        filterMs: tFilt
      });
      grid = null; // release
    }
    var tCh = nowMs() - tCh0;

    var i0 = nowMs();
    var frames = parsed.totalTicks / D;
    var interleaved = new Int16Array(frames * C);
    for (var f = 0; f < frames; f++) {
      var base = f * C;
      for (var cc = 0; cc < C; cc++) interleaved[base + cc] = channels[cc].pcm[f];
    }
    var tInter = nowMs() - i0;

    var total = nowMs() - t0;
    return {
      ok: true,
      parsed: parsed,
      bytes: parsed.bytes,
      anchor: parsed.anchor,
      totalTicks: parsed.totalTicks,
      channels: C,
      D: D,
      sampleRate: 48000,
      frames: frames,
      frameRate: 48000,
      channelData: channels,
      interleaved: interleaved,
      timings: { parseMs: tParse, channelsMs: tCh, interleaveMs: tInter, totalMs: total }
    };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function countMissing(grid) {
    var n = 0;
    for (var i = 0; i < grid.length; i++) if (grid[i] === 0) n++;
    return n;
  }

  // Equivalent FIR kernel of three cascaded length-D boxcars.
  function decimationKernel(D) {
    var k = new Float64Array([1]);
    for (var stage = 0; stage < 3; stage++) {
      var next = new Float64Array(k.length + D - 1);
      for (var i = 0; i < k.length; i++) {
        for (var j = 0; j < D; j++) next[i + j] += k[i];
      }
      k = next;
    }
    return k; // length 3(D-1)+1 = 3D-2, offsets 0..3(D-1)
  }

  /*
   * Describe every input tick contributing to output frame `frame` on channel
   * `ch`. Re-derives provenance from records (last adopted record wins) and
   * lists every provider (including rejected / overridden ones).
   */
  function describeFrame(result, ch, frame) {
    var parsed = result.parsed || result;
    var bytes = parsed.bytes || result.bytes;
    var D = parsed.D, anchor = parsed.anchor;
    var K = 3 * (D - 1);
    var T = (frame + 1) * D - 1; // extraction instant (relative tick)
    var L = T - K;
    var lo = Math.max(0, L);
    var hi = T; // T <= totalTicks-1
    var span = hi - lo + 1;

    // per real tick in [lo,hi]: providers in file order + winner index
    var byTick = new Array(span);
    for (var i = 0; i < span; i++) byTick[i] = { providers: [], winner: -1 };

    var recs = parsed.records;
    for (var ri = 0; ri < recs.length; ri++) {
      var rec = recs[ri];
      if ((rec.mask & (1 << ch)) === 0) continue;
      var os = Math.max(lo, rec.relStart);
      var oe = Math.min(hi, rec.relStart + rec.count - 1);
      if (os > oe) continue;
      var rank = popcount8(rec.mask & ((1 << ch) - 1));
      var nset = rec.nset;
      for (var tick = os; tick <= oe; tick++) {
        var tInRec = tick - rec.relStart;
        var j = tInRec * nset + rank;
        var bit = readPayloadBit(bytes, rec, j);
        var slot = byTick[tick - lo];
        var prov = {
          recordIndex: rec.index,
          offset: rec.offset,
          bit: bit,
          crcOk: rec.crcOk,
          legal: rec.legal,
          adopted: rec.adopted,
          errors: rec.errors
        };
        slot.providers.push(prov);
        if (rec.adopted) slot.winner = rec.index; // file order -> last adopted wins
      }
    }

    var kernel = decimationKernel(D);
    var ticks = [];
    var exactSum = 0;
    var anyMissing = false;
    for (var t = L; t <= T; t++) {
      var weight = kernel[T - t];
      var entry = {
        tick: t,
        weight: weight,
        kind: null,       // 'prestart' | 'real' | 'fill'
        bit: null,
        value: 0,
        sourceIndex: -1,
        sourceOffset: -1,
        providers: []
      };
      if (t < 0) {
        entry.kind = 'prestart';
        entry.value = 0;
        entry.bit = null;
      } else {
        var slot2 = byTick[t - lo];
        entry.providers = slot2.providers;
        for (var qi = 0; qi < entry.providers.length; qi++) {
          entry.providers[qi].winner =
            slot2.winner >= 0 && entry.providers[qi].recordIndex === slot2.winner;
        }
        if (slot2.winner >= 0) {
          // find winning provider bit (last adopted)
          var winProv = null;
          for (var pi = slot2.providers.length - 1; pi >= 0; pi--) {
            if (slot2.providers[pi].adopted) { winProv = slot2.providers[pi]; break; }
          }
          entry.kind = 'real';
          entry.bit = winProv.bit;
          entry.value = winProv.bit ? 1 : -1;
          entry.sourceIndex = winProv.recordIndex;
          entry.sourceOffset = winProv.offset;
        } else {
          entry.kind = 'fill';
          entry.bit = ((anchor + t) & 1) ? 1 : 0;
          entry.value = entry.bit ? 1 : -1;
          anyMissing = true;
        }
      }
      entry.contribution = weight * entry.value;
      exactSum += entry.contribution;
      ticks.push(entry);
    }

    var raw = exactSum * 32768 / (D * D * D);
    var rounded = clamp16(roundHalfEvenDiv(exactSum * 32768, D * D * D));
    var expectedPcm = result.channelData ? result.channelData[ch].pcm[frame] : undefined;
    var expectedAff = result.channelData ? result.channelData[ch].affected[frame] : undefined;

    return {
      channel: ch,
      frame: frame,
      extractTick: T,
      leftTick: L,
      rightTick: T,
      kernelWidth: K + 1,
      ticks: ticks,
      exactSum: exactSum,
      rawScaled: raw,
      pcm: rounded,
      clamped: rounded !== roundHalfEvenDiv(exactSum * 32768, D * D * D),
      affected: anyMissing,
      expectedPcm: expectedPcm,
      expectedAffected: expectedAff,
      pcmConsistent: expectedPcm === undefined ? true : expectedPcm === rounded,
      affectedConsistent: expectedAff === undefined ? true : (!!expectedAff === anyMissing)
    };
  }

  // Build the exported affected-intervals report. `scope` is null for the full
  // track or {startFrame,endFrame}; scoped intervals are clipped but KEEP
  // absolute frame coordinates (same anchor / decimation phase).
  function buildIntervalsReport(result, scope) {
    var F = result.frames, C = result.channels, sr = result.sampleRate || 48000;
    var f0 = 0, f1 = F, scoped = false;
    if (scope && typeof scope.startFrame === 'number' && typeof scope.endFrame === 'number') {
      f0 = Math.max(0, scope.startFrame | 0);
      f1 = Math.min(F, scope.endFrame | 0);
      scoped = f1 > f0;
    }
    var byChannel = [];
    var verbose = [];
    for (var c = 0; c < C; c++) {
      var all = result.channelData[c].intervals;
      var ivs = [];
      for (var i = 0; i < all.length; i++) {
        var a = all[i][0], b = all[i][1];
        if (scoped) { a = Math.max(a, f0); b = Math.min(b, f1); if (a >= b) continue; }
        ivs.push([a, b]);
      }
      byChannel.push(ivs);
      verbose.push({
        channel: c,
        count: ivs.length,
        intervals: ivs.map(function (p) {
          return {
            startFrame: p[0], endFrame: p[1], frameCount: p[1] - p[0],
            startSecond: p[0] / sr, endSecond: p[1] / sr,
            durationMs: (p[1] - p[0]) / sr * 1000
          };
        })
      });
    }
    var report = {
      format: 'pdm-decimation-reel/affected-intervals',
      formatVersion: 1,
      sampleRate: sr,
      frameRate: sr,
      decimation: result.D,
      channels: C,
      totalFrames: F,
      anchor: result.anchor >>> 0,
      scope: scoped ? 'selection' : 'full',
      coordinateConvention: 'Zero-based output frames at 48 kHz. Intervals are maximal contiguous affected-frame runs as half-open [startFrame,endFrame). Absolute decimation phase is anchored at relative ticks D-1,2D-1,... and is not restarted at a selection boundary. seconds = frame / sampleRate.'
    };
    if (scoped) report.selection = { startFrame: f0, endFrame: f1 };
    report.intervalsByChannel = byChannel;
    report.intervals = byChannel; // canonical simple alias: intervals[ch] = [[start,end),...]
    report.channelIntervals = verbose;
    return report;
  }

  return {
    HEADER_LEN: HEADER_LEN,
    RECORD_HEAD_LEN: RECORD_HEAD_LEN,
    CRC_LEN: CRC_LEN,
    popcount8: popcount8,
    crc32Range: crc32Range,
    roundHalfEvenDiv: roundHalfEvenDiv,
    clamp16: clamp16,
    parsePDQ: parsePDQ,
    buildChannelGrid: buildChannelGrid,
    decimateGrid: decimateGrid,
    intervalsFromFlags: intervalsFromFlags,
    decimationKernel: decimationKernel,
    describeFrame: describeFrame,
    buildIntervalsReport: buildIntervalsReport,
    decode: decode
  };
});
