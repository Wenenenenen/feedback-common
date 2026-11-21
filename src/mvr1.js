/*
 * MVR1 — closed-loop motion codec for 8-bit P5 grayscale frame sequences.
 *
 * Bitstream layout (all multi-byte integers little endian):
 *   magic          4 bytes  "MVR1"
 *   width          u16
 *   height         u16
 *   frameCount     u16
 *   keyInterval    u16
 *   quantStep      u16
 *   per frame:
 *     type         u8       0 = I, 1 = P
 *     payloadLen   u32
 *     payload      bytes
 *
 * The payload stores ceil(w/8) * ceil(h/8) blocks in row-major order.
 * The coded plane is edge-replicated to a multiple of 8 on the right/bottom.
 *
 * I block: residual = source - 128
 * P block: i8 dx, i8 dy (half-pixel units, -8..8), then
 *          prediction = bilinear(previous DECODED padded plane,
 *                               x + dx/2, y + dy/2),
 *          integer neighbours clamped, result rounded half up.
 *
 * Residuals are quantized with round-half-away-from-zero and coded as
 * segments of [u8 zero-run][i16 nonzero] until exactly 64 coefficients
 * are covered.  Decoding adds the dequantized residual to the prediction
 * and clamps to 0..255.
 *
 * This module is dependency-free and works as a classic browser script
 * (globalThis.MVR1) and as a CommonJS module (tests / CLI).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MVR1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_W = 192;
  var MAX_H = 128;
  var MAX_FRAMES = 48;
  var SEARCH = 8;          // half-pixel units per axis
  var HEADER_BYTES = 14;
  // A sample at x + dx/2 reads integer cells floor(x+dx/2) and +1, so the
  // widest reach is 4 px (dx = 8) plus one neighbour past the last pixel.
  var PAD = 5;             // phase-plane margin needed by ±8 half-pixel search
  var I_PRED = 128;

  /* ------------------------------------------------------------------ bytes */

  function ByteWriter(capacity) {
    this.buf = new Uint8Array(capacity || 4096);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  ByteWriter.prototype._ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  };
  ByteWriter.prototype.u8 = function (v) {
    this._ensure(1);
    this.buf[this.len++] = v & 0xff;
  };
  ByteWriter.prototype.i8 = function (v) {
    this._ensure(1);
    this.view.setInt8(this.len, v);
    this.len += 1;
  };
  ByteWriter.prototype.u16 = function (v) {
    this._ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
  };
  ByteWriter.prototype.u32 = function (v) {
    this._ensure(4);
    this.view.setUint32(this.len, v, true);
    this.len += 4;
  };
  ByteWriter.prototype.i16 = function (v) {
    this._ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
  };
  ByteWriter.prototype.patchU32 = function (at, v) {
    this.view.setUint32(at, v, true);
  };
  ByteWriter.prototype.bytes = function () {
    return this.buf.subarray(0, this.len);
  };

  function readU16(b, p) {
    return b[p] | (b[p + 1] << 8);
  }
  function readU32(b, p) {
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
  function readI16(b, p) {
    var v = b[p] | (b[p + 1] << 8);
    return v > 0x7fff ? v - 0x10000 : v;
  }
  function readI8(b, p) {
    var v = b[p];
    return v > 0x7f ? v - 0x100 : v;
  }

  function ascii(b, p, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
    return s;
  }

  /* ------------------------------------------------------------------ maths */

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function ceil8(v) {
    return Math.ceil(v / 8) * 8;
  }

  // Round-half-away-from-zero, exact integer arithmetic.
  function quantize(value, step) {
    if (value >= 0) return Math.floor((2 * value + step) / (2 * step));
    return -Math.floor((2 * -value + step) / (2 * step));
  }

  function padPlane(src, w, h, pw, ph) {
    var out = new Uint8Array(pw * ph);
    for (var y = 0; y < ph; y++) {
      var sy = (y < h ? y : h - 1) * w;
      var row = y * pw;
      for (var x = 0; x < pw; x++) out[row + x] = src[sy + (x < w ? x : w - 1)];
    }
    return out;
  }

  function cropPlane(padded, w, h, pw) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) out.set(padded.subarray(y * pw, y * pw + w), y * w);
    return out;
  }

  /*
   * Four bilinear phase planes, extended by PAD on every side.
   * A sample at sx = qx + ax/2, sy = qy + ay/2 uses fixed weights, so the
   * motion search only needs one table lookup per pixel.  Integer neighbours
   * are clamped before interpolation, exactly as the bitstream contract says.
   */
  function buildPhasePlanes(padded, pw, ph) {
    var ew = pw + PAD * 2;
    var eh = ph + PAD * 2;
    var n = ew * eh;
    var p00 = new Uint8Array(n); // ax=0 ay=0
    var p10 = new Uint8Array(n); // ax=1 ay=0
    var p01 = new Uint8Array(n); // ax=0 ay=1
    var p11 = new Uint8Array(n); // ax=1 ay=1
    for (var qy = -PAD; qy < ph + PAD; qy++) {
      var y0 = clamp(qy, 0, ph - 1);
      var y1 = clamp(qy + 1, 0, ph - 1);
      var r0 = y0 * pw;
      var r1 = y1 * pw;
      for (var qx = -PAD; qx < pw + PAD; qx++) {
        var x0 = clamp(qx, 0, pw - 1);
        var x1 = clamp(qx + 1, 0, pw - 1);
        var a = padded[r0 + x0];
        var b = padded[r0 + x1];
        var c = padded[r1 + x0];
        var d = padded[r1 + x1];
        var at = (qy + PAD) * ew + (qx + PAD);
        p00[at] = a;
        p10[at] = (2 * a + 2 * b + 2) >> 2;
        p01[at] = (2 * a + 2 * c + 2) >> 2;
        p11[at] = (a + b + c + d + 2) >> 2;
      }
    }
    return { planes: [p00, p10, p01, p11], ew: ew, eh: eh };
  }

  function phaseIndex(dx, dy) {
    var ax = ((dx % 2) + 2) % 2;
    var ay = ((dy % 2) + 2) % 2;
    return ax + ay * 2;
  }

  // Full-plane prediction for a fixed vector, from phase planes.
  function predictPlane(phases, dx, dy, pw, ph) {
    var out = new Uint8Array(pw * ph);
    var plane = phases.planes[phaseIndex(dx, dy)];
    var ew = phases.ew;
    var ox = Math.floor(dx / 2);
    var oy = Math.floor(dy / 2);
    for (var y = 0; y < ph; y++) {
      var base = (y + oy + PAD) * ew + PAD + ox;
      var row = y * pw;
      for (var x = 0; x < pw; x++) out[row + x] = plane[base + x];
    }
    return out;
  }

  function betterVector(sad, dx, dy, best) {
    if (sad !== best.sad) return sad < best.sad;
    var a = Math.abs(dx) + Math.abs(dy);
    var b = Math.abs(best.dx) + Math.abs(best.dy);
    if (a !== b) return a < b;
    if (dy !== best.dy) return dy < best.dy;
    return dx < best.dx;
  }

  function motionSearch(phases, srcPadded, pw, bx, by) {
    var ew = phases.ew;
    var sx = bx * 8;
    var sy = by * 8;
    var block = new Uint8Array(64);
    var k = 0;
    for (var yy = 0; yy < 8; yy++) {
      var row = (sy + yy) * pw + sx;
      for (var xx = 0; xx < 8; xx++) block[k++] = srcPadded[row + xx];
    }
    var best = { sad: Infinity, dx: 0, dy: 0 };
    for (var dy = -SEARCH; dy <= SEARCH; dy++) {
      var oy = Math.floor(dy / 2);
      var ay = ((dy % 2) + 2) % 2;
      for (var dx = -SEARCH; dx <= SEARCH; dx++) {
        var plane = phases.planes[((dx % 2) + 2) % 2 + ay * 2];
        var ox = Math.floor(dx / 2);
        var base = (sy + oy + PAD) * ew + (sx + ox + PAD);
        var sad = 0;
        for (var byi = 0; byi < 8; byi++) {
          var pi = base + byi * ew;
          var bi = byi * 8;
          for (var bxi = 0; bxi < 8; bxi++) {
            var d = plane[pi + bxi] - block[bi + bxi];
            sad += d < 0 ? -d : d;
          }
        }
        if (betterVector(sad, dx, dy, best)) best = { sad: sad, dx: dx, dy: dy };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ encode */

  function validateParams(width, height, frameCount, keyInterval, quantStep) {
    if (!(width >= 1 && width <= MAX_W)) throw new Error('宽度必须在 1..' + MAX_W + ' 之间（收到 ' + width + '）');
    if (!(height >= 1 && height <= MAX_H)) throw new Error('高度必须在 1..' + MAX_H + ' 之间（收到 ' + height + '）');
    if (!(frameCount >= 1 && frameCount <= MAX_FRAMES)) throw new Error('帧数必须在 1..' + MAX_FRAMES + ' 之间（收到 ' + frameCount + '）');
    if (!(keyInterval >= 1 && keyInterval <= 65535)) throw new Error('关键帧间隔必须是正整数（收到 ' + keyInterval + '）');
    if (!(quantStep >= 1 && quantStep <= 65535)) throw new Error('量化步长必须是正整数（收到 ' + quantStep + '）');
  }

  function Encoder(sequence, options) {
    options = options || {};
    this.width = sequence.width;
    this.height = sequence.height;
    this.frameCount = sequence.frames.length;
    this.keyInterval = options.keyInterval | 0;
    this.quantStep = options.quantStep | 0;
    validateParams(this.width, this.height, this.frameCount, this.keyInterval, this.quantStep);
    this.pw = ceil8(this.width);
    this.ph = ceil8(this.height);
    this.bw = this.pw / 8;
    this.bh = this.ph / 8;
    this.sequence = sequence;
    this.index = 0;
    this.lastDecoded = null;
    this.results = [];
    this.writer = new ByteWriter(4096);
    var w = this.writer;
    w.u8(0x4d); w.u8(0x56); w.u8(0x52); w.u8(0x31); // MVR1
    w.u16(this.width);
    w.u16(this.height);
    w.u16(this.frameCount);
    w.u16(this.keyInterval);
    w.u16(this.quantStep);
  }

  Object.defineProperty(Encoder.prototype, 'done', {
    get: function () { return this.index >= this.frameCount; },
  });

  Encoder.prototype.step = function () {
    if (this.done) return null;
    var i = this.index;
    var type = i % this.keyInterval === 0 ? 0 : 1;
    var origPadded = padPlane(this.sequence.frames[i].data, this.width, this.height, this.pw, this.ph);
    var predPadded = new Uint8Array(this.pw * this.ph);
    var recPadded = new Uint8Array(this.pw * this.ph);
    var payload = new ByteWriter(1024);
    var blocks = [];
    var phases = type === 1 ? buildPhasePlanes(this.lastDecoded, this.pw, this.ph) : null;

    for (var by = 0; by < this.bh; by++) {
      for (var bx = 0; bx < this.bw; bx++) {
        var blockStart = payload.len;
        var dx = 0, dy = 0, sad = null;
        if (type === 1) {
          var mv = motionSearch(phases, origPadded, this.pw, bx, by);
          dx = mv.dx; dy = mv.dy; sad = mv.sad;
          payload.i8(dx);
          payload.i8(dy);
        }
        var coeffs = new Int16Array(64);
        var nonzero = 0;
        var maxAbs = 0;
        var k = 0;
        for (var yy = 0; yy < 8; yy++) {
          var py = by * 8 + yy;
          var row = py * this.pw + bx * 8;
          for (var xx = 0; xx < 8; xx++) {
            var px = bx * 8 + xx;
            var pred;
            if (type === 0) {
              pred = I_PRED;
            } else {
              pred = phases.planes[phaseIndex(dx, dy)][
                (py + Math.floor(dy / 2) + PAD) * phases.ew + (px + Math.floor(dx / 2) + PAD)
              ];
            }
            predPadded[row + xx] = pred;
            var q = quantize(origPadded[row + xx] - pred, this.quantStep);
            coeffs[k] = q;
            if (q !== 0) { nonzero++; if (Math.abs(q) > maxAbs) maxAbs = Math.abs(q); }
            recPadded[row + xx] = clamp(pred + q * this.quantStep, 0, 255);
            k++;
          }
        }
        var run = 0;
        for (var c = 0; c < 64; c++) {
          if (coeffs[c] === 0) { run++; continue; }
          payload.u8(run);
          payload.i16(coeffs[c]);
          run = 0;
        }
        if (run > 0) payload.u8(run); // trailing zeros: run reaches the block end
        blocks.push({
          index: blocks.length,
          bx: bx,
          by: by,
          type: type,
          dx: type === 1 ? dx : null,
          dy: type === 1 ? dy : null,
          sad: sad,
          coeffs: coeffs,
          nonzero: nonzero,
          maxAbs: maxAbs,
          payloadStart: blockStart,
          payloadEnd: payload.len,
        });
      }
    }

    var frameStart = this.writer.len;
    this.writer.u8(type);
    var lenAt = this.writer.len;
    this.writer.u32(0);
    var payloadStart = this.writer.len;
    var plen = payload.len;
    this.writer._ensure(plen);
    this.writer.buf.set(payload.bytes(), this.writer.len);
    this.writer.len += plen;
    this.writer.patchU32(lenAt, plen);
    var payloadEnd = this.writer.len;

    var origCrop = cropPlane(origPadded, this.width, this.height, this.pw);
    var recCrop = cropPlane(recPadded, this.width, this.height, this.pw);
    var metrics = frameMetrics(origCrop, recCrop);
    var result = {
      index: i,
      type: type,
      frameStart: frameStart,
      payloadStart: payloadStart,
      payloadEnd: payloadEnd,
      payloadLen: plen,
      blocks: blocks,
      origPadded: origPadded,
      predPadded: predPadded,
      recPadded: recPadded,
      origCrop: origCrop,
      predCrop: cropPlane(predPadded, this.width, this.height, this.pw),
      recCrop: recCrop,
      metrics: metrics,
      incomplete: false,
    };
    this.lastDecoded = recPadded;
    this.index++;
    this.results.push(result);
    return result;
  };

  Encoder.prototype.header = function () {
    return {
      magic: 'MVR1',
      width: this.width,
      height: this.height,
      frameCount: this.frameCount,
      keyInterval: this.keyInterval,
      quantStep: this.quantStep,
      paddedWidth: this.pw,
      paddedHeight: this.ph,
    };
  };

  Encoder.prototype.finish = function () {
    if (!this.done) throw new Error('编码尚未完成');
    return {
      ok: true,
      header: this.header(),
      frames: this.results,
      bytes: this.writer.bytes(),
    };
  };

  function encodeAll(sequence, options) {
    var enc = new Encoder(sequence, options);
    while (!enc.done) enc.step();
    return enc.finish();
  }

  /* ------------------------------------------------------------------ decode */

  function decode(bytes) {
    var issues = [];
    var frames = [];
    var len = bytes.length;
    function issue(severity, kind, message, ctx, offset) {
      var item = {
        severity: severity,
        kind: kind,
        message: message,
        offset: offset == null ? null : offset,
      };
      if (ctx) {
        if (ctx.frame != null) item.frame = ctx.frame;
        if (ctx.block != null) item.block = ctx.block;
        if (ctx.bx != null) item.bx = ctx.bx;
        if (ctx.by != null) item.by = ctx.by;
        if (ctx.coef != null) item.coef = ctx.coef;
      }
      issues.push(item);
      return item;
    }
    function fatalResult(header) {
      return {
        ok: false,
        header: header || null,
        frames: frames,
        issues: issues,
        consumed: Math.min(len, consumed),
        fileLength: len,
      };
    }

    var consumed = 0;
    if (len < 4) {
      issue('error', 'truncated-header', '文件不足 4 字节，无法读取 MVR1 标识（文件共 ' + len + ' 字节）', null, 0);
      return fatalResult(null);
    }
    if (ascii(bytes, 0, 4) !== 'MVR1') {
      issue('error', 'bad-magic', '文件标识不是 MVR1（读到 "' + ascii(bytes, 0, 4).replace(/[^\x20-\x7e]/g, '?') + '"）', null, 0);
      return fatalResult(null);
    }
    if (len < HEADER_BYTES) {
      issue('error', 'truncated-header', '固定头被截断：需要 ' + HEADER_BYTES + ' 字节，实际只有 ' + len + ' 字节', null, len);
      return fatalResult(null);
    }

    var header = {
      magic: 'MVR1',
      width: readU16(bytes, 4),
      height: readU16(bytes, 6),
      frameCount: readU16(bytes, 8),
      keyInterval: readU16(bytes, 10),
      quantStep: readU16(bytes, 12),
    };
    try {
      validateParams(header.width, header.height, header.frameCount, header.keyInterval, header.quantStep);
    } catch (e) {
      issue('error', 'bad-header', '固定头参数非法：' + e.message, null, 4);
      return fatalResult(header);
    }
    header.paddedWidth = ceil8(header.width);
    header.paddedHeight = ceil8(header.height);
    var pw = header.paddedWidth;
    var ph = header.paddedHeight;
    var bw = pw / 8;
    var bh = ph / 8;

    var pos = HEADER_BYTES;
    var lastDecoded = null;
    var stopped = false;

    for (var fi = 0; fi < header.frameCount; fi++) {
      var frameStart = pos;
      if (pos + 1 > len) {
        issue('error', 'truncated-frame', '第 ' + fi + ' 帧缺失：帧类型字节被截断', { frame: fi }, pos);
        stopped = true;
        break;
      }
      var type = bytes[pos++];
      if (type !== 0 && type !== 1) {
        issue('error', 'illegal-frame-type', '第 ' + fi + ' 帧类型字节为 ' + type + '，只允许 0（I）或 1（P）', { frame: fi }, frameStart);
        stopped = true;
        break;
      }
      if (pos + 4 > len) {
        issue('error', 'truncated-frame', '第 ' + fi + ' 帧的载荷长度字段被截断', { frame: fi }, pos);
        stopped = true;
        break;
      }
      var plen = readU32(bytes, pos);
      pos += 4;
      var payloadStart = pos;
      if (plen > len - pos) {
        issue('error', 'truncated-payload',
          '第 ' + fi + ' 帧载荷被截断：声明 ' + plen + ' 字节，文件只剩 ' + (len - pos) + ' 字节',
          { frame: fi }, pos);
        stopped = true;
        break;
      }
      var payloadEnd = pos + plen;
      var expectedType = fi % header.keyInterval === 0 ? 0 : 1;
      if (type !== expectedType) {
        issue('error', 'type-mismatch',
          '第 ' + fi + ' 帧存储类型为 ' + (type ? 'P' : 'I') + '，但按关键帧间隔 ' + header.keyInterval + ' 应为 ' + (expectedType ? 'P' : 'I'),
          { frame: fi }, frameStart);
      }
      if (type === 1 && !lastDecoded) {
        issue('error', 'missing-reference', '第 ' + fi + ' 帧是 P 帧，但它前面没有可用的解码参考帧', { frame: fi }, frameStart);
        stopped = true;
        break;
      }

      var phases = type === 1 ? buildPhasePlanes(lastDecoded, pw, ph) : null;
      var predPadded = new Uint8Array(pw * ph);
      var recPadded = new Uint8Array(pw * ph);
      var blocks = [];
      var aborted = null;

      for (var byi = 0; byi < bh && !aborted; byi++) {
        for (var bxi = 0; bxi < bw; bxi++) {
          var blockIndex = byi * bw + bxi;
          var blockStart = pos;
          var dx = 0, dy = 0;
          if (type === 1) {
            if (pos + 2 > payloadEnd) {
              aborted = issue('error', 'truncated-block',
                '第 ' + fi + ' 帧块 (' + bxi + ',' + byi + ') 在运动矢量处被截断（需要 2 字节）',
                { frame: fi, block: blockIndex, bx: bxi, by: byi }, pos);
              break;
            }
            dx = readI8(bytes, pos);
            dy = readI8(bytes, pos + 1);
            pos += 2;
            if (dx < -SEARCH || dx > SEARCH || dy < -SEARCH || dy > SEARCH) {
              aborted = issue('error', 'illegal-vector',
                '第 ' + fi + ' 帧块 (' + bxi + ',' + byi + ') 运动矢量 (' + dx + ',' + dy + ') 超出 ±' + SEARCH + ' 半像素范围',
                { frame: fi, block: blockIndex, bx: bxi, by: byi }, blockStart);
              break;
            }
          }

          var coeffs = new Int16Array(64);
          var ci = 0;
          var bad = null;
          while (ci < 64) {
            if (pos >= payloadEnd) {
              bad = issue('error', 'truncated-block',
                '第 ' + fi + ' 帧块 (' + bxi + ',' + byi + ') 的残差在系数 ' + ci + ' 处截断（载荷已到末尾）',
                { frame: fi, block: blockIndex, bx: bxi, by: byi, coef: ci }, pos);
              break;
            }
            var run = bytes[pos++];
            if (ci + run > 64) {
              bad = issue('error', 'illegal-run',
                '第 ' + fi + ' 帧块 (' + bxi + ',' + byi + ') 的零游程 ' + run + ' 越过块尾（当前位置 ' + ci + '，共 64 项）',
                { frame: fi, block: blockIndex, bx: bxi, by: byi, coef: ci }, pos - 1);
              break;
            }
            ci += run;
            if (ci === 64) break;
            if (pos + 2 > payloadEnd) {
              bad = issue('error', 'truncated-block',
                '第 ' + fi + ' 帧块 (' + bxi + ',' + byi + ') 的残差在系数 ' + ci + ' 处截断（缺 i16 值）',
                { frame: fi, block: blockIndex, bx: bxi, by: byi, coef: ci }, pos);
              break;
            }
            coeffs[ci] = readI16(bytes, pos);
            pos += 2;
            ci++;
          }
          if (bad) { aborted = bad; break; }

          var nonzero = 0;
          var maxAbs = 0;
          var k = 0;
          for (var yy = 0; yy < 8; yy++) {
            var py = byi * 8 + yy;
            var row = py * pw + bxi * 8;
            for (var xx = 0; xx < 8; xx++) {
              var px = bxi * 8 + xx;
              var pred = type === 0 ? I_PRED : phases.planes[phaseIndex(dx, dy)][
                (py + Math.floor(dy / 2) + PAD) * phases.ew + (px + Math.floor(dx / 2) + PAD)
              ];
              predPadded[row + xx] = pred;
              var q = coeffs[k];
              if (q !== 0) { nonzero++; if (Math.abs(q) > maxAbs) maxAbs = Math.abs(q); }
              recPadded[row + xx] = clamp(pred + q * header.quantStep, 0, 255);
              k++;
            }
          }
          blocks.push({
            index: blockIndex,
            bx: bxi,
            by: byi,
            type: type,
            dx: type === 1 ? dx : null,
            dy: type === 1 ? dy : null,
            sad: null,
            coeffs: coeffs,
            nonzero: nonzero,
            maxAbs: maxAbs,
            payloadStart: blockStart - payloadStart,
            payloadEnd: pos - payloadStart,
          });
        }
      }

      if (aborted) {
        frames.push({
          index: fi,
          type: type,
          frameStart: frameStart,
          payloadStart: payloadStart,
          payloadEnd: payloadEnd,
          payloadLen: plen,
          blocks: blocks,
          predPadded: predPadded,
          recPadded: recPadded,
          incomplete: true,
          origCrop: null,
          predCrop: cropPlane(predPadded, header.width, header.height, pw),
          recCrop: cropPlane(recPadded, header.width, header.height, pw),
          metrics: null,
        });
        pos = payloadEnd;
        stopped = true;
        break;
      }

      if (pos < payloadEnd) {
        issue('error', 'extra-payload',
          '第 ' + fi + ' 帧载荷在解完 ' + blocks.length + ' 个块后还剩 ' + (payloadEnd - pos) + ' 字节',
          { frame: fi }, pos);
        pos = payloadEnd;
      }

      var recCrop = cropPlane(recPadded, header.width, header.height, pw);
      frames.push({
        index: fi,
        type: type,
        frameStart: frameStart,
        payloadStart: payloadStart,
        payloadEnd: payloadEnd,
        payloadLen: plen,
        blocks: blocks,
        predPadded: predPadded,
        recPadded: recPadded,
        incomplete: false,
        origCrop: null,
        predCrop: cropPlane(predPadded, header.width, header.height, pw),
        recCrop: recCrop,
        metrics: null,
      });
      lastDecoded = recPadded;
      consumed = payloadEnd;
    }

    if (!stopped && pos < len) {
      issue('error', 'trailing-bytes',
        '末帧之后还有 ' + (len - pos) + ' 字节额外数据（规范要求末帧后无额外数据）', null, pos);
      pos = len;
    }
    consumed = Math.max(consumed, pos);
    var hasError = issues.some(function (it) { return it.severity === 'error'; });
    return {
      ok: !hasError && frames.length === header.frameCount,
      header: header,
      frames: frames,
      issues: issues,
      consumed: consumed,
      fileLength: len,
    };
  }

  /* ------------------------------------------------------------------ metrics */

  function frameMetrics(a, b) {
    var n = a.length;
    var sumAbs = 0;
    var sumSq = 0;
    var maxErr = 0;
    for (var i = 0; i < n; i++) {
      var d = a[i] - b[i];
      if (d < 0) d = -d;
      sumAbs += d;
      sumSq += d * d;
      if (d > maxErr) maxErr = d;
    }
    var mse = n ? sumSq / n : 0;
    return {
      mae: n ? sumAbs / n : 0,
      mse: mse,
      psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
      maxErr: maxErr,
      pixels: n,
    };
  }

  function comparePlanes(a, b) {
    var n = Math.min(a.length, b.length);
    var mismatches = 0;
    var first = -1;
    for (var i = 0; i < n; i++) {
      if (a[i] !== b[i]) { mismatches++; if (first < 0) first = i; }
    }
    return { mismatches: mismatches, first: first, compared: n };
  }

  /* ------------------------------------------------------------------ PGM */

  function parsePGM(name, buffer) {
    var b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var p = 0;
    function isSpace(c) { return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32; }
    function skip() {
      while (p < b.length) {
        if (b[p] === 35) { while (p < b.length && b[p] !== 10) p++; }
        else if (isSpace(b[p])) p++;
        else break;
      }
    }
    function token() {
      skip();
      var s = p;
      while (p < b.length && !isSpace(b[p]) && b[p] !== 35) p++;
      if (s === p) throw new Error('PGM 头部不完整');
      return ascii(b, s, p - s);
    }
    var magic = token();
    if (magic !== 'P5') throw new Error('只支持 8 位 P5 灰度 PGM（文件 "' + name + '" 是 ' + magic + '）');
    var w = parseInt(token(), 10);
    var h = parseInt(token(), 10);
    var maxv = parseInt(token(), 10);
    if (!(w > 0 && h > 0)) throw new Error('PGM 尺寸非法：' + w + '×' + h);
    if (maxv !== 255) throw new Error('只支持 maxval=255 的 8 位 PGM（' + name + ' 的 maxval=' + maxv + '）');
    if (w > MAX_W || h > MAX_H) throw new Error('PGM 尺寸 ' + w + '×' + h + ' 超出 ' + MAX_W + '×' + MAX_H + ' 限制');
    if (p >= b.length) throw new Error('PGM 缺少像素数据');
    // Exactly one whitespace byte separates maxval from the raster (CRLF counts as one).
    if (b[p] === 13 && b[p + 1] === 10) p += 2;
    else if (isSpace(b[p])) p += 1;
    else throw new Error('PGM maxval 后缺少空白分隔符');
    var need = w * h;
    var have = b.length - p;
    if (have < need) throw new Error('PGM 像素数据不足：需要 ' + need + ' 字节，只有 ' + have + ' 字节');
    var warnings = [];
    if (have > need) warnings.push('像素数据后还有 ' + (have - need) + ' 字节，已忽略');
    var m = /(\d+)\s*$/.exec(String(name).replace(/\.[^./\\]+$/, ''));
    if (!m) throw new Error('无法从文件名 "' + name + '" 解析帧号');
    return {
      name: name,
      frameNumber: parseInt(m[1], 10),
      width: w,
      height: h,
      data: b.slice(p, p + need),
      warnings: warnings,
    };
  }

  function buildSequence(entries, name) {
    if (!entries.length) throw new Error('没有可导入的 PGM 文件');
    var parsed = entries.map(function (e) { return parsePGM(e.name, e.buffer); });
    var w = parsed[0].width;
    var h = parsed[0].height;
    parsed.forEach(function (f) {
      if (f.width !== w || f.height !== h) {
        throw new Error('帧尺寸不一致：' + f.name + ' 是 ' + f.width + '×' + f.height + '，首帧是 ' + w + '×' + h);
      }
    });
    parsed.sort(function (a, b) { return a.frameNumber - b.frameNumber; });
    var seen = Object.create(null);
    parsed.forEach(function (f) {
      if (seen[f.frameNumber] != null) throw new Error('帧号重复：' + f.frameNumber + '（' + seen[f.frameNumber] + ' 与 ' + f.name + '）');
      seen[f.frameNumber] = f.name;
    });
    if (parsed[0].frameNumber !== 0) throw new Error('帧号必须从 0 开始（首帧是 ' + parsed[0].frameNumber + '）');
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i].frameNumber !== i) {
        throw new Error('帧号不连续：缺少 ' + i + ' 号帧（现有 ' + parsed[i].frameNumber + '）');
      }
    }
    if (parsed.length > MAX_FRAMES) throw new Error('帧数 ' + parsed.length + ' 超过 ' + MAX_FRAMES + ' 帧限制');
    var warnings = [];
    parsed.forEach(function (f) { warnings.push.apply(warnings, f.warnings); });
    return {
      name: name || 'sequence',
      width: w,
      height: h,
      frames: parsed.map(function (f) { return { index: f.frameNumber, name: f.name, data: f.data }; }),
      warnings: warnings,
    };
  }

  return {
    MAX_W: MAX_W,
    MAX_H: MAX_H,
    MAX_FRAMES: MAX_FRAMES,
    SEARCH: SEARCH,
    HEADER_BYTES: HEADER_BYTES,
    I_PRED: I_PRED,
    Encoder: Encoder,
    encodeAll: encodeAll,
    decode: decode,
    parsePGM: parsePGM,
    buildSequence: buildSequence,
    frameMetrics: frameMetrics,
    comparePlanes: comparePlanes,
    padPlane: padPlane,
    cropPlane: cropPlane,
    buildPhasePlanes: buildPhasePlanes,
    phaseIndex: phaseIndex,
    motionSearch: motionSearch,
    quantize: quantize,
    ceil8: ceil8,
    readU16: readU16,
    readU32: readU32,
    readI16: readI16,
    readI8: readI8,
  };
});
