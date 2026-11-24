/*
 * opus-core.js — Ogg Opus 无重编码裁切核心
 *
 * 只处理容器（RFC 3533 §6）与 Opus 成帧/时长（RFC 6716 §3、RFC 7845 §3–5），
 * 不进入压缩帧内部，因此裁切前后音频包字节完全一致。
 * 浏览器（window.OpusCut）与 Node（module.exports）通用，无外部依赖。
 *
 * 约定（同样例 约定.txt）：
 *   链        一条 Ogg 逻辑流（BOS…EOS），输入中按源顺序首尾相接。
 *   B         链原点：首个结束音频包的页粒度 G 减去该页完成的样本数 D。
 *             该页无 EOS 时 B = G - D（不得为负）；有 EOS 时 B = max(0, G - D)。
 *   pre-skip  OpusHead 里的预跳过样本数。
 *   可播区间  [B + pre-skip, E)，E 为末页粒度，末页裁量已扣掉尾部填充。
 *   全局轴    各链可播长度依次拼接，从 0 开始，单位 48 kHz 样本。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpusCut = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var PREROLL = 3840;                     // 80 ms @ 48 kHz
  var SAMPLE_RATE = 48000;
  var MAX_SAFE_GRANULE = 9007199254740991; // 2^53 - 1
  var DEFAULT_LIMITS = { maxBytes: 512 * 1024 * 1024, maxPackets: 4000000, maxPages: 4000000 };

  /* ------------------------------------------------------------------ *
   * Ogg CRC32：多项式 0x04c11db7，MSB-first，初值 0，无终异或。
   * slicing-by-8，128 MiB 约 0.2 s。
   * ------------------------------------------------------------------ */
  var CRC_TABLES = (function () {
    var t0 = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var r = i << 24;
      for (var k = 0; k < 8; k++) r = ((r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1)) >>> 0;
      t0[i] = r;
    }
    var tables = [t0];
    for (var n = 1; n < 8; n++) {
      var prev = tables[n - 1], t = new Uint32Array(256);
      for (var j = 0; j < 256; j++) t[j] = ((((prev[j] << 8) >>> 0) ^ t0[(prev[j] >>> 24) & 0xff]) >>> 0);
      tables.push(t);
    }
    return tables;
  })();

  // 计算 buf[start,end) 的 Ogg CRC32（可从中途状态续算）。
  function crcUpdate(c, buf, start, end) {
    var T = CRC_TABLES;
    var i = start;
    for (; i + 8 <= end; i += 8) {
      c = (T[7][((c >>> 24) ^ buf[i]) & 0xff] ^
           T[6][((c >>> 16) ^ buf[i + 1]) & 0xff] ^
           T[5][((c >>> 8) ^ buf[i + 2]) & 0xff] ^
           T[4][(c ^ buf[i + 3]) & 0xff] ^
           T[3][buf[i + 4]] ^ T[2][buf[i + 5]] ^ T[1][buf[i + 6]] ^ T[0][buf[i + 7]]) >>> 0;
    }
    for (; i < end; i++) c = ((((c << 8) >>> 0) ^ T[0][((c >>> 24) ^ buf[i]) & 0xff]) >>> 0);
    return c >>> 0;
  }
  function crcZeroBytes(c, k) {
    var T0 = CRC_TABLES[0];
    for (var i = 0; i < k; i++) c = ((((c << 8) >>> 0) ^ T0[(c >>> 24) & 0xff]) >>> 0);
    return c >>> 0;
  }
  // 页 CRC：CRC 字段按 0 计算（RFC 3533 §6）。
  function pageCrc(buf, start, end, crcOff) {
    var c = crcUpdate(0, buf, start, crcOff);
    c = crcZeroBytes(c, 4);
    return crcUpdate(c, buf, crcOff + 4, end);
  }

  /* ------------------------------------------------------------------ *
   * 读工具：小端；粒度按有符号 64 位读，-1 表示"本页无包结束"。
   * ------------------------------------------------------------------ */
  function u32(buf, o) { return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0; }
  function i16(buf, o) { var v = buf[o] | (buf[o + 1] << 8); return (v & 0x8000) ? v - 0x10000 : v; }
  function u16(buf, o) { return buf[o] | (buf[o + 1] << 8); }
  // 返回 {lo, hi}：hi 为高 21 位、lo 为低 32 位。超出 2^53 时 exact=false。
  function granule(buf, o) {
    var lo = u32(buf, o), hi = (buf[o + 4] | (buf[o + 5] << 8) | (buf[o + 6] << 16) | (buf[o + 7] << 24)) >>> 0;
    var neg = hi >= 0x80000000;
    return { lo: lo, hi: hi, neg: neg, exact: hi < 0x200000 };
  }

  /* ------------------------------------------------------------------ *
   * Opus 成帧与时长（RFC 6716 §3）。只解析 TOC/帧长，不动压缩数据。
   * ------------------------------------------------------------------ */
  // 单帧样本数：SILK 10/20/40/60 ms，Hybrid 10/20 ms，CELT 2.5/5/10/20 ms。
  var FRAME_SAMPLES = [
    480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
    480, 960, 480, 960,
    120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960
  ];

  // 解析一个 Opus 包：返回 {samples, frames, frameSamples, vocal()} 或抛 OpusFrameError。
  // 校验 RFC 6716 §3.4 的 [R1]–[R7]，不解码载荷。
  function parseOpusPacket(p, base) {
    var n = p.length;
    if (n < 1) return bad('空 Opus 包（[R1]）', base);
    var toc = p[0];
    var config = toc >> 3, code = toc & 3;
    var fs = FRAME_SAMPLES[config];
    var frames;
    if (code === 0) {
      frames = 1;
    } else if (code === 1) {
      if (((n - 1) & 1) !== 0) return bad('code 1 载荷字节数非偶（[R3]）', base);
      frames = 2;
    } else if (code === 2) {
      if (n < 2) return bad('code 2 包不足 2 字节（[R4]）', base);
      var b0 = p[1], n1, pLen;
      if (b0 < 252) { n1 = b0; pLen = 2; }
      else { if (n < 3) return bad('code 2 帧长需要第二字节（[R4]）', base); n1 = p[2] * 4 + b0; pLen = 3; }
      if (pLen + n1 > n) return bad('code 2 首帧长超出剩余字节（[R4]）', base);
      frames = 2;
    } else {
      if (n < 2) return bad('code 3 包不足 2 字节（[R6/R7]）', base);
      var fc = p[1], vbr = (fc & 0x80) !== 0, pad = (fc & 0x40) !== 0;
      frames = fc & 0x3f;
      if (frames < 1) return bad('code 3 帧数为 0（[R5]）', base);
      if (frames * fs > 5760) return bad('code 3 音频时长超过 120 ms（[R5]）', base);
      var pos = 2, padTotal = 0, tailPad = 0;
      if (pad) {
        for (;;) {
          if (pos >= n) return bad('code 3 填充长度越界（[R6/R7]）', base);
          var v = p[pos++];
          tailPad += (v === 255 ? 254 : v);
          if (v !== 255) break;
        }
        padTotal = tailPad + (pos - 2);      // P = 尾部填充字节 + 长度字节
        if (padTotal > n - 2) return bad('code 3 填充 P 超过 N-2（[R6/R7]）', base);
      }
      var payloadEnd = n - tailPad;
      if (vbr) {
        var sum = 0;
        for (var i = 0; i < frames - 1; i++) {
          if (pos >= n) return bad('code 3 VBR 帧长越界（[R7]）', base);
          var lb = p[pos];
          if (lb < 252) { sum += lb; pos += 1; }
          else { if (pos + 1 >= n) return bad('code 3 VBR 两字节帧长越界（[R7]）', base); sum += p[pos + 1] * 4 + lb; pos += 2; }
        }
        if (pos + sum > payloadEnd) return bad('code 3 VBR 载荷不足（[R7]）', base);
      } else {
        var rem = payloadEnd - pos;          // R = N - 2 - P 的等价形式
        if (rem < 0 || rem % frames !== 0) return bad('code 3 CBR 载荷不能被帧数整除（[R6]）', base);
      }
    }
    return { samples: fs * frames, frames: frames, frameSamples: fs, toc: toc, channels: (toc & 4) ? 2 : 1 };
  }

  /* ------------------------------------------------------------------ *
   * 错误：一律带字节偏移，便于"报偏移并保留上一次有效索引"。
   * ------------------------------------------------------------------ */
  function CutError(msg, offset, kind) {
    var e = new Error(msg);
    e.name = 'OpusCutError';
    e.offset = (offset == null ? null : offset);
    e.kind = kind || 'format';
    return e;
  }
  function bad(msg, offset, kind) { throw CutError(msg, offset, kind); }
  function hex32(v) { return '0x' + (v >>> 0).toString(16).padStart(8, '0'); }

  /* ------------------------------------------------------------------ *
   * Ogg 页解析（RFC 3533 §6）。
   *
   * 返回页描述数组。每页：
   *   {off, len, version, flags, gran, serial, seq, crcStored, crcOk, segs,
   *    bodyOff, bodyLen, firstPacketIdx, packetsEnded, contStart}
   * 页内每个 lacing 值 <255 结束一个包；恰好 255 表示跨页续传。
   *
   * 损坏处理：capture 缺失/版本不符/CRC 不符/长度截断 → 抛 CutError(含偏移)，
   * 调用方保留此前已解析的有效页。
   * ------------------------------------------------------------------ */
  // 扫描页：成功返回 {pages}；失败返回 {pages（此前的有效页）, error}。
  // 从不抛异常，好让调用方"报偏移并保留上一次有效索引"。
  function scanPages(buf, offset, end, limits) {
    limits = limits || DEFAULT_LIMITS;
    var pages = [];
    var p = offset;
    try {
      while (p < end) {
        if (pages.length >= limits.maxPages) throw CutError('页数超过上限 ' + limits.maxPages, p, 'limit');
        if (end - p < 27) throw CutError('页头被截断（剩余 ' + (end - p) + ' 字节）', p, 'truncated');
        if (buf[p] !== 0x4f || buf[p + 1] !== 0x67 || buf[p + 2] !== 0x67 || buf[p + 3] !== 0x53) {
          throw CutError('缺少 OggS 捕获图案', p, 'capture');
        }
        var version = buf[p + 4];
        if (version !== 0) throw CutError('不支持的 Ogg 版本 ' + version, p, 'version');
        var flags = buf[p + 5];
        var g = granule(buf, p + 6);
        if (g.neg && !(g.hi === 0xffffffff && g.lo === 0xffffffff)) {
          throw CutError('粒度位置是非法负值（仅 -1 表示本页无包结束）', p, 'granule');
        }
        var serial = u32(buf, p + 14);
        var seq = u32(buf, p + 18);
        var crcStored = u32(buf, p + 22);
        var nsegs = buf[p + 26];
        var hdrLen = 27 + nsegs;
        if (p + hdrLen > end) throw CutError('段表被截断（需 ' + hdrLen + ' 字节页头）', p, 'truncated');
        var bodyLen = 0;
        for (var s = 0; s < nsegs; s++) bodyLen += buf[p + 27 + s];
        var total = hdrLen + bodyLen;
        if (p + total > end) throw CutError('页体被截断（需 ' + total + ' 字节，仅剩 ' + (end - p) + '）', p, 'truncated');
        var calc = pageCrc(buf, p, p + total, p + 22);
        if (calc !== crcStored) {
          // 坏页：报偏移并停在此页之前，保留此前有效索引
          throw CutError('页 CRC 不匹配（存储 ' + hex32(crcStored) + '，计算 ' + hex32(calc) + '）', p, 'crc');
        }
        pages.push({
          index: pages.length, off: p, len: total, version: version, flags: flags,
          gran: g, granuleRaw: g.neg ? -1 : (g.hi * 4294967296 + g.lo),
          granuleExact: g.exact, serial: serial, seq: seq,
          crcStored: crcStored, crcOk: calc === crcStored,
          nsegs: nsegs, segs: buf.subarray(p + 27, p + 27 + nsegs),
          bodyOff: p + hdrLen, bodyLen: bodyLen,
        });
        p += total;
      }
    } catch (e) {
      return { pages: pages, error: e, stoppedAt: p };
    }
    return { pages: pages, error: null, stoppedAt: p };
  }

  /* ------------------------------------------------------------------ *
   * 逻辑流切分 + 音频包组装。
   *
   * 输入页按源顺序首尾相接，序列号不重复、无交错。每遇到 BOS 开一条链；
   * 页进入链时校验序号连续、续传标志与 lacing 状态吻合、CRC 正确。
   * 音频包允许跨页（页末 lacing=255 续到下一页）。
   * ------------------------------------------------------------------ */
  var FLAG_CONT = 0x01, FLAG_BOS = 0x02, FLAG_EOS = 0x04;

  function buildChains(buf, pages, warnings) {
    var chains = [];
    var cur = null;
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      if (pg.flags & FLAG_BOS) {
        if (cur) {
          // 上一条链没有 EOS 就遇到新 BOS：按截断链收尾并告警
          if (!cur.eos) { warnings.push({ kind: 'missing-eos', offset: cur.endOff, msg: '链 ' + cur.ordinal + ' 未见 EOS 即遇到新链 BOS' }); }
          finalizeChain(cur, warnings);
        }
        cur = {
          ordinal: chains.length, serial: pg.serial, pages: [],
          startOff: pg.off, endOff: pg.off + pg.len, eos: false,
          packets: [], openPacket: null, errors: [],
        };
        chains.push(cur);
      } else if (!cur) {
        warnings.push({ kind: 'prelude', offset: pg.off, msg: '首个 BOS 之前有页，已忽略' });
        continue;
      } else if (pg.serial !== cur.serial) {
        warnings.push({ kind: 'serial-switch', offset: pg.off, msg: '序列号在链 ' + cur.ordinal + ' 内变化（' + cur.serial + '→' + pg.serial + '）' });
        continue;
      }
      // 序号连续性（32 位回绕）：每条链首号应为 0，其后逐页 +1
      var expectSeq;
      if (cur.pages.length === 0) {
        expectSeq = 0;
        if (pg.seq !== 0) warnings.push({ kind: 'seq-gap', offset: pg.off, msg: '链 ' + cur.ordinal + ' 首号应为 0，实为 ' + pg.seq });
      } else {
        expectSeq = (cur.pages[cur.pages.length - 1].seq + 1) >>> 0;
        if (pg.seq !== expectSeq) warnings.push({ kind: 'seq-gap', offset: pg.off, msg: '页序号不连续：期望 ' + expectSeq + '，实得 ' + pg.seq });
      }
      if (!pg.crcOk) {
        warnings.push({ kind: 'crc', offset: pg.off, msg: '页 CRC 不匹配（seq ' + pg.seq + '）' });
      }
      cur.pages.push(pg);
      cur.endOff = pg.off + pg.len;
      if (pg.flags & FLAG_EOS) cur.eos = true;
      ingestPageBody(buf, pg, cur, warnings);
    }
    if (cur) {
      if (!cur.eos) warnings.push({ kind: 'missing-eos', offset: cur.endOff, msg: '链 ' + cur.ordinal + ' 结束处没有 EOS' });
      finalizeChain(cur, warnings);
    }
    return chains;
  }

  // 页体按 lacing 切包，续传拼装到 cur.openPacket。
  function ingestPageBody(buf, pg, chain, warnings) {
    var off = pg.bodyOff, segs = pg.segs, n = pg.nsegs;
    var continuing = (pg.flags & FLAG_CONT) !== 0;
    if (pg.nsegs > 0) {
      var endsContinued = segs[pg.nsegs - 1] === 255;
      // 续传标志与 lacing 状态必须吻合
      if (continuing && !chain.openPacket) {
        warnings.push({ kind: 'orphan-cont', offset: pg.off, msg: '页标记续传但上一页无未完成包（seq ' + pg.seq + '），丢弃本页首包' });
      } else if (!continuing && chain.openPacket) {
        warnings.push({ kind: 'lost-cont', offset: pg.off, msg: '上一页包未完成但本页未标续传（seq ' + pg.seq + '），丢弃未完成包子' });
        chain.openPacket = null;
      }
      for (var s = 0; s < n; s++) {
        var lace = segs[s];
        if (!chain.openPacket) {
          chain.openPacket = { parts: [], segPages: [], off: off, len: 0 };
        }
        if (chain.openPacket.segPages[chain.openPacket.segPages.length - 1] !== pg.index) {
          chain.openPacket.segPages.push(pg.index);
        }
        chain.openPacket.parts.push({ start: off, end: off + lace });
        chain.openPacket.len += lace;
        off += lace;
        if (lace < 255) {
          pushPacket(chain, buf, chain.openPacket, pg.index, warnings);
          chain.openPacket = null;
        }
      }
      void endsContinued;
    } else if (chain.openPacket) {
      // 空页不结束包，状态保持
    }
  }

  function pushPacket(chain, buf, open, lastPageIdx, warnings) {
    // 用一次拷贝得到连续包体，后续解析与输出都以它为准
    var len = open.len;
    var body;
    if (open.parts.length === 1) {
      body = buf.subarray(open.parts[0].start, open.parts[0].end);
    } else {
      body = new Uint8Array(len);
      var at = 0;
      for (var k = 0; k < open.parts.length; k++) {
        var pt = open.parts[k];
        body.set(buf.subarray(pt.start, pt.end), at);
        at += pt.end - pt.start;
      }
    }
    chain.packets.push({
      body: body, off: open.off, len: len,
      pages: open.segPages.slice(), lastPage: lastPageIdx,
      spansPages: open.segPages.length > 1,
    });
  }

  /* ------------------------------------------------------------------ *
   * 链收尾：识别 OpusHead / OpusTags / 音频包，算 B、可播区间与全局轴。
   *
   *   OpusHead  第 1 个包：19 字节、版本 1、映射族 0、声道 1/2。
   *   OpusTags  第 2 个包：'OpusTags' 开头，可跨页，原样保留。
   *   音频包    第 3 个包起；逐个解析 TOC 得未裁切样本时长。
   * ------------------------------------------------------------------ */
  function finalizeChain(chain, warnings) {
    var pkts = chain.packets;
    chain.header = null; chain.tags = null; chain.audio = [];
    chain.fatal = null;
    if (pkts.length < 2) {
      chain.fatal = CutError('缺少 OpusHead/OpusTags（仅有 ' + pkts.length + ' 个包）', chain.startOff, 'header');
      return;
    }
    var head = parseOpusHead(pkts[0].body);
    if (!head.ok) {
      chain.fatal = CutError('OpusHead 无效：' + head.msg, pkts[0].off, 'header');
      return;
    }
    var tagsPkt = pkts[1];
    if (!isMagic(tagsPkt.body, 'OpusTags')) {
      chain.fatal = CutError('第 2 个包不是 OpusTags', tagsPkt.off, 'header');
      return;
    }
    chain.header = head;
    chain.tags = tagsPkt;

    // 音频包：逐个解析，遇到坏包记错误并中断本链音频部分
    var audio = [];
    var samples = 0;
    for (var i = 2; i < pkts.length; i++) {
      var pk = pkts[i];
      var info;
      try {
        info = parseOpusPacket(pk.body, pk.off);
      } catch (e) {
        // 坏包：记录偏移，截断本链此后的音频，但保留已解析的有效前缀
        chain.badPacket = { offset: pk.off, message: e.message, packetIndex: i - 2, lastPage: pk.lastPage, pageSeq: pageSeqOf(chain, pk.lastPage) };
        warnings.push({ kind: 'bad-packet', offset: pk.off, msg: '链 ' + chain.ordinal + ' 第 ' + (i - 2) + ' 个音频包解析失败：' + e.message + '（此后音频截断）' });
        break;
      }
      audio.push({
        index: i - 2, pkt: pk, startSample: samples, samples: info.samples,
        frames: info.frames, frameSamples: info.frameSamples, toc: info.toc,
      });
      samples += info.samples;
    }
    if (audio.length === 0) {
      chain.fatal = CutError('没有可用的音频包（首个音频包即无效）', chain.startOff, 'empty');
      return;
    }
    chain.audio = audio;
    chain.totalSamples = samples;

    computePlayable(chain, warnings);
  }

  function pageSeqOf(chain, pageIndex) {
    for (var i = 0; i < chain.pages.length; i++) if (chain.pages[i].index === pageIndex) return chain.pages[i].seq;
    return null;
  }

  function isMagic(body, magic) {
    if (!body || body.length < magic.length) return false;
    for (var i = 0; i < magic.length; i++) if (body[i] !== magic.charCodeAt(i)) return false;
    return true;
  }

  function parseOpusHead(body) {
    if (!body || body.length < 19) return { ok: false, msg: '不足 19 字节' };
    if (!isMagic(body, 'OpusHead')) return { ok: false, msg: '缺少 OpusHead 魔数' };
    var version = body[8];
    if (version !== 1) return { ok: false, msg: '版本 ' + version + '（需要 1）' };
    var channels = body[9];
    if (channels !== 1 && channels !== 2) return { ok: false, msg: '声道数 ' + channels + '（映射族 0 只能是 1 或 2）' };
    var family = body[18];
    if (family !== 0) return { ok: false, msg: '映射族 ' + family + '（需要 0）' };
    return {
      ok: true, version: version, channels: channels,
      preSkip: u16(body, 10), inputRate: u32(body, 12),
      outputGain: i16(body, 14), family: family,
      body: body,
    };
  }

  /* ------------------------------------------------------------------ *
   * 计算可播区间与全局轴。
   *
   * 步骤：
   *   1. 统计每个音频页完成的样本数（按"结束于该页的音频包"累加）。
   *   2. 首个结束音频包的页：G=该页粒度，D=该页完成样本数。
   *      无 EOS → B=G-D（负数即无效）；有 EOS → B=max(0,G-D)。
   *   3. 逐页核对粒度：非 EOS 页应等于 B+累进样本；EOS 页 ≤ 期望且
   *      裁量小于末包样本数；无包结束的页粒度应为 -1。
   *   4. E=末页粒度；可播区间=[B+preSkip, E)，长度须 > 0。
   * ------------------------------------------------------------------ */
  function computePlayable(chain, warnings) {
    var pages = chain.pages, audio = chain.audio;
    // 每页完成的音频样本数与包数
    var perPage = {};
    for (var i = 0; i < audio.length; i++) {
      var lp = audio[i].pkt.lastPage;
      var rec = perPage[lp] || (perPage[lp] = { samples: 0, packets: 0, lastPacket: null });
      rec.samples += audio[i].samples;
      rec.packets += 1;
      rec.lastPacket = audio[i];
    }
    chain.pageStats = [];
    var firstAudioPagePos = -1;
    for (var p = 0; p < pages.length; p++) {
      var pg = pages[p];
      var rec = perPage[pg.index] || null;
      chain.pageStats.push({
        page: pg, completedSamples: rec ? rec.samples : 0,
        completedPackets: rec ? rec.packets : 0, lastPacket: rec ? rec.lastPacket : null,
        isAudio: !!rec,
      });
      if (rec && firstAudioPagePos < 0) firstAudioPagePos = p;
    }
    if (firstAudioPagePos < 0) {
      chain.fatal = CutError('没有结束音频包的页', chain.startOff, 'empty');
      return;
    }
    var firstRec = chain.pageStats[firstAudioPagePos];
    var G = firstRec.page.granuleRaw;
    var D = firstRec.completedSamples;
    var firstHasEos = (firstRec.page.flags & FLAG_EOS) !== 0;
    var B;
    if (G < 0) { chain.fatal = CutError('首个音频页粒度无效（-1）', firstRec.page.off, 'granule'); return; }
    if (firstHasEos) {
      // 单页即 EOS：粒度可小于页内已完成样本数（整段被裁），此时原点夹到 0
      B = Math.max(0, G - D);
      chain.originClamped = (G < D);
    } else {
      B = G - D;
      if (B < 0) {
        chain.fatal = CutError('链原点为负（G=' + G + ' − D=' + D + '）', firstRec.page.off, 'granule');
        return;
      }
    }
    chain.B = B; chain.G = G; chain.D = D; chain.firstAudioPage = firstRec.page;

    // 逐页核对粒度
    var cum = 0;
    var badPage = chain.badPacket ? chain.badPacket.lastPage : -1;
    for (var q = 0; q < chain.pageStats.length; q++) {
      var st = chain.pageStats[q], pg2 = st.page;
      var isEosPage = (pg2.flags & FLAG_EOS) !== 0;
      cum += st.completedSamples;
      var expected = B + cum;
      st.expectedGranule = expected;
      if (badPage >= 0 && pg2.index >= badPage) {
        // 坏包页及其后：粒度反映的是完整包流，无法按截断前缀核对
        st.granuleOk = null;
      } else if (q === firstAudioPagePos && chain.originClamped) {
        // 首个音频页即 EOS 且原点被夹到 0：以页面自身粒度为准，不做常规核对
        st.granuleOk = true;
      } else if (st.completedPackets === 0) {
        // 包头页粒度应为 0；被单个跨页包完全覆盖的音频页应为 -1
        st.granuleOk = pg2.granuleRaw === 0 || pg2.granuleRaw === -1;
        if (!st.granuleOk) st.granuleNote = '无包结束的页粒度应为 0 或 -1，实为 ' + pg2.granuleRaw;
      } else if (isEosPage) {
        var lastPktSamples = st.lastPacket ? st.lastPacket.samples : 0;
        var trim = expected - pg2.granuleRaw;
        st.trim = trim;
        st.granuleOk = pg2.granuleRaw <= expected && trim >= 0 && trim < lastPktSamples && pg2.granuleRaw >= 0;
        if (!st.granuleOk) st.granuleNote = 'EOS 粒度 ' + pg2.granuleRaw + ' 与期望 ' + expected + ' 不符（裁量 ' + trim + '，末包 ' + lastPktSamples + '）';
      } else {
        st.granuleOk = pg2.granuleRaw === expected;
        if (!st.granuleOk) st.granuleNote = '粒度 ' + pg2.granuleRaw + ' ≠ 期望 ' + expected;
      }
      if (!st.granuleOk && st.granuleNote) {
        warnings.push({ kind: 'granule', offset: pg2.off, msg: '链 ' + chain.ordinal + ' 页 ' + pg2.seq + '：' + st.granuleNote });
      }
    }

    // 坏包导致的音频截断：前缀仍可用于索引，但本链不参与输出
    if (chain.badPacket) {
      chain.truncated = true;
      chain.playStart = B + chain.header.preSkip;
      // 有效尾部 = 最后一个有效包结束点（不含被截断后的样本）
      var lastOk = audio[audio.length - 1];
      chain.E = B + lastOk.startSample + lastOk.samples;
      chain.playLen = chain.E - chain.playStart;
      chain.playLenValid = chain.playLen > 0;
      for (var a0 = 0; a0 < audio.length; a0++) {
        audio[a0].unt_start = B + audio[a0].startSample;
        audio[a0].unt_end = audio[a0].unt_start + audio[a0].samples;
      }
      return;
    }
    // EOS 必须在末页且结束至少一个音频包
    var lastPage = pages[pages.length - 1];
    if (!(lastPage.flags & FLAG_EOS)) {
      chain.fatal = CutError('末页未标 EOS（文件可能被截断）', chain.endOff, 'eos');
      return;
    }
    var lastStat = chain.pageStats[chain.pageStats.length - 1];
    if (lastStat.completedPackets === 0) {
      chain.fatal = CutError('EOS 页未结束任何音频包', lastPage.off, 'eos');
      return;
    }
    var E = lastPage.granuleRaw;
    if (E < 0) { chain.fatal = CutError('末页粒度无效（-1）', lastPage.off, 'granule'); return; }
    chain.E = E;
    var playStart = B + chain.header.preSkip;
    var playLen = E - playStart;
    chain.playStart = playStart;
    chain.playLen = playLen;
    if (playLen <= 0) {
      chain.fatal = CutError('可播长度不为正（[B+pre-skip, E)=[' + playStart + ',' + E + ')）', lastPage.off, 'playable');
      return;
    }
    // 每包未裁切区间
    for (var a = 0; a < audio.length; a++) {
      audio[a].unt_start = B + audio[a].startSample;
      audio[a].unt_end = audio[a].unt_start + audio[a].samples;
    }
  }

  /* ------------------------------------------------------------------ *
   * 顶层解析：输入一段字节，返回完整索引（链、页、包、全局轴、诊断）。
   * 坏页/坏包/截断都会报偏移，并保留此前解析出的有效索引。
   * ------------------------------------------------------------------ */
  function parse(buf, opts) {
    opts = opts || {};
    var limits = {
      maxBytes: opts.maxBytes || DEFAULT_LIMITS.maxBytes,
      maxPackets: opts.maxPackets || DEFAULT_LIMITS.maxPackets,
      maxPages: opts.maxPages || DEFAULT_LIMITS.maxPages,
    };
    var warnings = [];
    var t0 = now();
    if (buf.length > limits.maxBytes) bad('输入超过上限 ' + limits.maxBytes + ' 字节', 0, 'limit');
    if (buf.length === 0) bad('输入为空', 0, 'empty');

    var scan = scanPages(buf, 0, buf.length, limits);
    var pages = scan.pages;
    var scanError = scan.error;
    if (pages.length === 0) {
      // 一个有效页都没有：直接报出首个偏移
      bad(scanError ? scanError.message : '没有可解析的 Ogg 页', scanError ? scanError.offset : 0, scanError ? scanError.kind : 'empty');
    }
    var chains = buildChains(buf, pages, warnings);
    if (chains.length === 0) bad('没有找到任何逻辑流（缺少 BOS 页）', 0, 'empty');

    // 计数与全局轴。坏包截断的链只保留索引，不进入可播轴。
    var globalSamples = 0;
    var totalPackets = 0;
    for (var c = 0; c < chains.length; c++) {
      var ch = chains[c];
      totalPackets += ch.packets.length;
      if (ch.fatal || !(ch.playLen > 0) || ch.truncated) continue;
      ch.globalStart = globalSamples;
      ch.globalEnd = globalSamples + ch.playLen;
      globalSamples += ch.playLen;
    }
    if (totalPackets > limits.maxPackets) bad('音频包数超过上限 ' + limits.maxPackets, 0, 'limit');

    // 首个致命错误作为顶层错误（但索引仍返回）
    var firstFatal = null;
    for (var f = 0; f < chains.length; f++) {
      if (chains[f].fatal) { firstFatal = chains[f].fatal; break; }
    }

    var index = {
      version: VERSION,
      byteLength: buf.length,
      buffer: buf,
      pages: pages,
      chains: chains,
      warnings: warnings,
      scanError: scanError,
      globalSamples: globalSamples,
      packetCount: totalPackets,
      pageCount: pages.length,
      parseMs: now() - t0,
    };
    return index;
  }

  // 全局轴样本 → {chain, localSample}（localSample 为链内可播坐标，从 0 起）
  function locate(index, sample) {
    for (var i = 0; i < index.chains.length; i++) {
      var ch = index.chains[i];
      if (ch.fatal || ch.globalStart == null) continue;
      if (sample >= ch.globalStart && sample < ch.globalEnd) {
        return { chain: ch, chainIndex: i, local: sample - ch.globalStart };
      }
    }
    return null;
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /* ------------------------------------------------------------------ *
   * 剪选：给定全局半开区间 [S,T)，为每条相交链定起始/终止包。
   *
   *   起始包：起点不晚于 max(B, S_i-3840) 的最后一个包（预卷不足则取链首）。
   *   终止包：结束点首次达到 T_i 的包。
   *   新原点 K=起始包起点；pre-skip=S_i-K；EOS 粒度=T_i-K。
   *   S_i/T_i 是把全局区间映射回该链粒度坐标系后的边界。
   * ------------------------------------------------------------------ */
  function select(index, S, T, opts) {
    opts = opts || {};
    if (!(T > S)) bad('区间需要 T > S（收到 [' + S + ',' + T + '））', null, 'range');
    var plans = [];
    var skipped = [];
    for (var c = 0; c < index.chains.length; c++) {
      var ch = index.chains[c];
      if (ch.fatal || ch.globalStart == null) { skipped.push({ chainIndex: c, reason: ch.fatal ? ch.fatal.message : '无全局轴' }); continue; }
      var iS = Math.max(S, ch.globalStart), iE = Math.min(T, ch.globalEnd);
      if (iE <= iS) continue;
      var Si = ch.playStart + (iS - ch.globalStart);
      var Ti = ch.playStart + (iE - ch.globalStart);
      var plan = planChain(ch, Si, Ti, c);
      if (plan.error) { skipped.push({ chainIndex: c, reason: plan.error.message }); continue; }
      plans.push(plan);
    }
    return { plans: plans, skipped: skipped };
  }

  function planChain(ch, Si, Ti, chainIndex) {
    var audio = ch.audio;
    // 起始包：unt_start <= max(B, Si-3840) 的最后一个包
    var target = Math.max(ch.B, Si - PREROLL);
    var startIdx = 0;
    // unt_start 单调递增，二分最后一个 <= target
    var lo = 0, hi = audio.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (audio[mid].unt_start <= target) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    startIdx = found >= 0 ? found : 0;
    // 终止包：unt_end >= Ti 的第一个包
    var endIdx = audio.length - 1;
    var l2 = 0, h2 = audio.length - 1, f2 = -1;
    while (l2 <= h2) {
      var m2 = (l2 + h2) >> 1;
      if (audio[m2].unt_end >= Ti) { f2 = m2; h2 = m2 - 1; }
      else l2 = m2 + 1;
    }
    if (f2 < 0) return { error: CutError('链 ' + ch.ordinal + '：找不到结束点达到 T 的包', null, 'range') };
    endIdx = f2;
    if (endIdx < startIdx) endIdx = startIdx;
    var K = audio[startIdx].unt_start;
    var preSkipNew = Si - K;
    var eosGran = Ti - K;
    if (preSkipNew < 0) return { error: CutError('链 ' + ch.ordinal + '：新 pre-skip 为负', null, 'range') };
    if (preSkipNew > 65535) return { error: CutError('链 ' + ch.ordinal + '：新 pre-skip ' + preSkipNew + ' 超出 16 位', null, 'range') };
    if (eosGran < 0 || eosGran > MAX_SAFE_GRANULE) return { error: CutError('链 ' + ch.ordinal + '：EOS 粒度不可表示', null, 'range') };
    var selected = audio.slice(startIdx, endIdx + 1);
    var fullSamples = 0;
    for (var i = 0; i < selected.length; i++) fullSamples += selected[i].samples;
    var trim = fullSamples - eosGran;
    var lastSamples = selected[selected.length - 1].samples;
    if (trim < 0) return { error: CutError('链 ' + ch.ordinal + '：EOS 粒度超过所选包总时长', null, 'range') };
    if (trim >= lastSamples) return { error: CutError('链 ' + ch.ordinal + '：末页裁量 ' + trim + ' 不小于末包样本数 ' + lastSamples, null, 'range') };
    return {
      chainIndex: chainIndex, chain: ch,
      startIdx: startIdx, endIdx: endIdx,
      K: K, preSkip: preSkipNew, eosGranule: eosGran,
      Si: Si, Ti: Ti, trim: trim,
      packets: selected,
      rawSamples: fullSamples,
    };
  }

  /* ------------------------------------------------------------------ *
   * 封装输出。
   *
   * 每条选中链独立成一条逻辑流（自有 OpusHead / OpusTags / EOS），
   * 按源顺序首尾相接。音频包原字节不变；OpusHead 只改 pre-skip。
   * 输出链序列号互异、页序号从 0 起。整包优先成页，整包放不下才跨页续传。
   * ------------------------------------------------------------------ */
  var MAX_SEGMENTS = 255;

  function laceLengths(len) {
    var out = [];
    var k = Math.floor(len / 255);
    for (var i = 0; i < k; i++) out.push(255);
    out.push(len - k * 255);
    return out;
  }

  // 把一串逻辑包装成 Ogg 页。
  //   items[i] = {data:Uint8Array, endSample:number|null}
  //     endSample 为该包结束时的累计样本（相对 K）；null 表示该包不结束任何音频
  // 页策略：整包尽量进一页；段表最多 255 段，一个包超过整页容量时自然跨页续传。
  // 页粒度默认为"本页最后结束包的 endSample"，本页未结束任何包时为 -1。
  // 返回 [{data, seq, granule, flags, eos, cont}]。
  function muxPages(items, opts) {
    opts = opts || {};
    var pages = [];
    var segs = [], bodyParts = [], bodyLen = 0;
    var contStart = false;         // 本页首段是否为上一页未完包
    var lastEnd = null;            // 本页最后结束包的 endSample
    var completedOnPage = 0;

    function flush() {
      if (segs.length === 0) return;
      pages.push(assemblePage({
        segs: segs, bodyParts: bodyParts, bodyLen: bodyLen,
        cont: contStart, granule: (completedOnPage > 0 ? lastEnd : -1),
      }, opts, pages.length));
      segs = []; bodyParts = []; bodyLen = 0;
      contStart = false; lastEnd = null; completedOnPage = 0;
    }

    for (var i = 0; i < items.length; i++) {
      var data = items[i].data;
      var laces = laceLengths(data.length);
      if (segs.length > 0 && segs.length + laces.length > MAX_SEGMENTS) flush();
      var off = 0;
      for (var k = 0; k < laces.length; k++) {
        if (segs.length >= MAX_SEGMENTS) {
          // 包未结束而段表已满：切页，余下各段在下一页续传
          flush();
          contStart = true;
        }
        var lace = laces[k];
        segs.push(lace);
        if (lace > 0) { bodyParts.push({ data: data, start: off, end: off + lace }); bodyLen += lace; }
        off += lace;
        if (lace < 255) { completedOnPage++; lastEnd = items[i].endSample; }
      }
    }
    flush();
    return pages;
  }

  function assemblePage(p, opts, pageIndex) {
    var nseg = p.segs.length;
    var hdrLen = 27 + nseg;
    var total = hdrLen + p.bodyLen;
    var out = new Uint8Array(total);
    out[0] = 0x4f; out[1] = 0x67; out[2] = 0x67; out[3] = 0x53;
    out[4] = 0;
    var flags = 0;
    if (p.cont) flags |= FLAG_CONT;
    if (pageIndex === 0) flags |= FLAG_BOS;
    if (p.eos) flags |= FLAG_EOS;
    out[5] = flags;
    writeGranule(out, 6, p.granule);
    writeU32(out, 14, opts.serial);
    writeU32(out, 18, pageIndex);
    writeU32(out, 22, 0);
    out[26] = nseg;
    for (var i = 0; i < nseg; i++) out[27 + i] = p.segs[i];
    var at = hdrLen;
    for (var b = 0; b < p.bodyParts.length; b++) {
      var part = p.bodyParts[b];
      out.set(part.data.subarray(part.start, part.end), at);
      at += part.end - part.start;
    }
    writeU32(out, 22, pageCrc(out, 0, total, 22));
    return {
      data: out, seq: pageIndex, granule: p.granule, flags: flags,
      eos: !!p.eos, cont: !!p.cont,
    };
  }

  function finalizePage(p) {
    var out = p.data;
    out[5] = p.flags;
    writeGranule(out, 6, p.granule);
    writeU32(out, 22, 0);
    writeU32(out, 22, pageCrc(out, 0, out.length, 22));
  }

  function writeU32(buf, o, v) {
    buf[o] = v & 0xff; buf[o + 1] = (v >>> 8) & 0xff; buf[o + 2] = (v >>> 16) & 0xff; buf[o + 3] = (v >>> 24) & 0xff;
  }
  function writeGranule(buf, o, v) {
    var lo, hi;
    if (v < 0) { lo = 0xffffffff; hi = 0xffffffff; }
    else { lo = v >>> 0; hi = Math.floor(v / 4294967296) >>> 0; }
    writeU32(buf, o, lo); writeU32(buf, o + 4, hi);
  }

  /* ------------------------------------------------------------------ *
   * 输出组装：把选择方案变成实际字节。
   *
   * 每条选中链生成一条独立逻辑流：
   *   1. OpusHead（19 字节，只改 pre-skip 和声道数保持一致）
   *   2. OpusTags（原链原字节，可跨页）
   *   3. 选中音频包（原字节），起始包起点即新原点 K
   *   4. 末页 EOS，粒度 = T_i - K
   *
   * 音频包若自身超过一页容量（> 255 段），会自然跨页，续传标志自动处理。
   * 序列号在整份输出里互异。
   * ------------------------------------------------------------------ */
  function buildOutput(index, plans, opts) {
    opts = opts || {};
    var usedSerials = {};
    var chainBytes = [];
    var report = [];
    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      var ch = plan.chain;
      var serial = chooseSerial(ch.serial, usedSerials, opts.serialSeed || 0);
      usedSerials[serial] = true;
      var bytes = buildOneChain(plan, serial);
      chainBytes.push(bytes);
      report.push({
        chainIndex: plan.chainIndex, ordinal: ch.ordinal, serial: serial,
        preSkip: plan.preSkip, eosGranule: plan.eosGranule,
        K: plan.K, Si: plan.Si, Ti: plan.Ti,
        packets: plan.packets.length, bytes: bytes.length,
        playableSamples: plan.Ti - plan.Si,   // 该输出链的可播长度
      });
    }
    var total = 0;
    for (var b = 0; b < chainBytes.length; b++) total += chainBytes[b].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (var c = 0; c < chainBytes.length; c++) { out.set(chainBytes[c], at); at += chainBytes[c].length; }
    return { data: out, chains: report, totalBytes: total };
  }

  function chooseSerial(src, used, seed) {
    var s = (src ^ seed) >>> 0;
    var guard = 0;
    while (used[s] !== undefined) {
      s = (s + 0x9E3779B1) >>> 0;  // 黄金比例步进，保证不重复
      if (++guard > 0xffffffff) throw CutError('无法分配唯一的输出序列号', null, 'serial');
    }
    return s;
  }

  function buildOneChain(plan, serial) {
    var ch = plan.chain;
    // OpusHead：复制原 19 字节，只改 pre-skip（16 位小端，位于偏移 10）
    var head = new Uint8Array(ch.header.body.subarray(0, 19));
    head[10] = plan.preSkip & 0xff;
    head[11] = (plan.preSkip >>> 8) & 0xff;

    var tagsData = ch.tags.body;

    // 音频包：endSample = 相对 K 的累计样本
    var audioItems = [];
    var cum = 0;
    for (var i = 0; i < plan.packets.length; i++) {
      cum += plan.packets[i].samples;
      audioItems.push({ data: plan.packets[i].pkt.body, endSample: cum });
    }
    var eosGranule = plan.eosGranule;

    // OpusHead 单独一页，粒度 0（RFC 7845 §4）
    var headPage = muxPages([{ data: head, endSample: 0 }], { serial: serial });
    headPage[0].granule = 0; finalizePage(headPage[0]);
    // OpusTags：可跨页。RFC 7845 §4：标签完成的页粒度 0；
    // 被同一标签包完全覆盖、未结束任何包的中间页粒度为 -1。
    var tagsPages = muxPages([{ data: tagsData, endSample: null }], { serial: serial });
    for (var t = 0; t < tagsPages.length; t++) {
      tagsPages[t].granule = (t === tagsPages.length - 1) ? 0 : -1;
      finalizePage(tagsPages[t]);
    }
    // 音频页
    var audioPages = muxPages(audioItems, { serial: serial });
    // 末页粒度设为 eosGranule，并标 EOS
    var lastAudio = audioPages[audioPages.length - 1];
    lastAudio.granule = eosGranule; lastAudio.eos = true; lastAudio.flags |= FLAG_EOS;
    finalizePage(lastAudio);

    // 拼装：head + tags + audio，页序号连续、只有第一页 BOS、只有最后一页 EOS
    var allPages = headPage.concat(tagsPages, audioPages);
    for (var p = 0; p < allPages.length; p++) {
      setSeq(allPages[p], p);
      setFlags(allPages[p], {
        bos: p === 0,
        eos: p === allPages.length - 1,
        cont: allPages[p].cont,
      });
    }
    var totalLen = 0;
    for (var q = 0; q < allPages.length; q++) totalLen += allPages[q].data.length;
    var out = new Uint8Array(totalLen);
    var at = 0;
    for (var r = 0; r < allPages.length; r++) { out.set(allPages[r].data, at); at += allPages[r].data.length; }
    return out;
  }

  function setSeq(page, seq) { writeU32(page.data, 18, seq); page.seq = seq; }
  function setFlags(page, f) {
    var flags = 0;
    if (f.cont) flags |= FLAG_CONT;
    if (f.bos) flags |= FLAG_BOS;
    if (f.eos) flags |= FLAG_EOS;
    page.flags = flags;
    finalizePage(page);
  }

  /* ------------------------------------------------------------------ *
   * 便捷入口
   * ------------------------------------------------------------------ */

  // 解析并返回可播总长（48 kHz 样本）与简要统计。
  function summarize(index) {
    var bad = [];
    for (var i = 0; i < index.chains.length; i++) {
      var ch = index.chains[i];
      var first = ch.pages[0];
      bad.push({
        ordinal: ch.ordinal, serial: ch.serial, pages: ch.pages.length,
        packets: ch.packets.length, audioPackets: ch.audio ? ch.audio.length : 0,
        channels: ch.header ? ch.header.channels : null,
        preSkip: ch.header ? ch.header.preSkip : null,
        B: ch.B != null ? ch.B : null, E: ch.E != null ? ch.E : null,
        playStart: ch.playStart != null ? ch.playStart : null,
        playLen: ch.playLen != null ? ch.playLen : null,
        globalStart: ch.globalStart != null ? ch.globalStart : null,
        globalEnd: ch.globalEnd != null ? ch.globalEnd : null,
        fatal: ch.fatal ? ch.fatal.message : null,
        truncated: !!ch.truncated, badPacket: ch.badPacket || null,
        offset: ch.startOff,
      });
    }
    return {
      chains: bad, globalSamples: index.globalSamples,
      packetCount: index.packetCount, pageCount: index.pageCount,
      byteLength: index.byteLength, parseMs: index.parseMs,
      warnings: index.warnings, scanError: index.scanError,
    };
  }

  // 生成一份带诊断的页/包索引表（供 UI 渲染）。
  // 每页：偏移、序列号、页序号、CRC、粒度、结束包数、状态。
  // 每包：跨过的页、未裁切区间、样本数。
  function tabulate(index) {
    var rows = { pages: [], packets: [] };
    for (var c = 0; c < index.chains.length; c++) {
      var ch = index.chains[c];
      for (var p = 0; p < ch.pages.length; p++) {
        var pg = ch.pages[p];
        var st = ch.pageStats ? ch.pageStats[p] : null;
        rows.pages.push({
          chain: ch.ordinal, index: pg.index, off: pg.off, len: pg.len,
          serial: pg.serial, seq: pg.seq,
          crc: pg.crcStored, crcOk: pg.crcOk, flags: pg.flags,
          granule: pg.granuleRaw, expected: st ? st.expectedGranule : null,
          granuleOk: st ? st.granuleOk : null,
          completedPackets: st ? st.completedPackets : 0,
          cont: (pg.flags & FLAG_CONT) !== 0, bos: (pg.flags & FLAG_BOS) !== 0, eos: (pg.flags & FLAG_EOS) !== 0,
        });
      }
      if (!ch.audio) continue;
      for (var a = 0; a < ch.audio.length; a++) {
        var pk = ch.audio[a];
        rows.packets.push({
          chain: ch.ordinal, index: pk.index, off: pk.pkt.off,
          pages: pk.pkt.pages, spansPages: pk.pkt.spansPages,
          unt_start: pk.unt_start, unt_end: pk.unt_end, samples: pk.samples,
          frames: pk.frames, frameSamples: pk.frameSamples, toc: pk.toc,
        });
      }
    }
    return rows;
  }

  return {
    VERSION: VERSION, PREROLL: PREROLL, SAMPLE_RATE: SAMPLE_RATE,
    parse: parse, select: select, buildOutput: buildOutput,
    summarize: summarize, tabulate: tabulate, locate: locate,
    parseOpusPacket: parseOpusPacket, crcUpdate: crcUpdate, pageCrc: pageCrc,
    _internal: {
      scanPages: scanPages, buildChains: buildChains, laceLengths: laceLengths,
      muxPages: muxPages, parseOpusHead: parseOpusHead, planChain: planChain,
    },
  };
});
