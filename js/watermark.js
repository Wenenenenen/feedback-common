/*
 * 盲音频水印：周期性 chip 直接序列扩频（DSSS）+ 差分同步 + 差分载荷 + 密钥 CRC。
 *
 * 全部参数按 16 kHz 采样率设计，纯时域实现，无 FFT/无窗函数依赖。
 *
 * 帧结构（每 chip = 256 样本 = 16 ms，一个 ±1 符号）：
 *   63 个符号组成一块并沿全曲循环：
 *     位置 0..14   : 15 位 m 序列同步头
 *     位置 15..62  : 48 位载荷，采用相邻符号差分编码（bit1=翻转，bit0=不变），
 *                    以同步头末位符号为参考
 *
 * 为什么全链路差分：接收信号可能整体反相（宿主相关项导致），且 m 序列相关峰取
 *   绝对值无法判定极性。所有信息都编码在“相邻 chip 符号是否翻转”里，整体反相
 *   不改变翻转关系，因此无需判定绝对极性。
 *
 * 嵌入（逐样本）：
 *   密钥派生长度 C 的 ±1 伪随机码 pnChip，每 chip 周期重复 → 任意剪片只需对齐
 *   chip 网格即可盲同步，不需要片段在原曲中的绝对位置。
 *   w[n] = α · pnChip[n mod C] · block[floor(n/C) mod 63]，叠加宿主并限幅。
 *
 * 检测（盲验，无需原始音频）：
 *   1. 立体声下混；
 *   2. 遍历 C 种 chip 对齐（完整网格，步长 4 样本），对每 chip 做能量归一化相关
 *      并折叠到 63 个块位置；
 *   3. 同步：对折叠相关的相邻位置符号差分，与 m 序列差分模板做符合率相关，取峰；
 *   4. 载荷：在锁定的 (align, p0) 上对相邻折叠相关做符号差分，判决 48 个差分比特，
 *      CRC-16（与口令密钥混合）校验。
 *
 * 鲁棒性：
 *   - 等比例增益（含负增益）：能量归一化 + 差分，幅度缩放与整体反相均不可见；
 *   - 中间剪片：周期 chip 码 + 完整网格扫描，任意起点重新同步；
 *   - 加性底噪：chip 扩频处理增益 10·log10(256)≈24 dB，多块折叠相干积累；
 *   - 立体声下混：两通道嵌相同水印，下混后水印相干叠加。
 */
(function (global) {
  'use strict';

  var WM = global.WM || (global.WM = {});

  var FS = 16000;
  var CHIP = 256;          // 16 ms/chip
  var SYNC_LEN = 15;
  var PAYLOAD_BITS = 48;
  var BLOCK = SYNC_LEN + PAYLOAD_BITS; // 63
  var DEFAULT_ALPHA = 0.01;
  var SYNC_THRESHOLD = 0.45;    // 差分模板符合率阈值（用于锁相位）
  var STRENGTH_THRESHOLD = 0.08; // 折叠相关归一化强度门限（裸宿主实测最大 0.066）
  var MARGIN_THRESHOLD = 0.20;  // 最弱载荷差分软值裕量
  var ALIGN_STEP = 4;
  var MIN_CHIPS = BLOCK + SYNC_LEN;

  // ---------- 密钥与伪随机 ----------

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function chipCode(key) {
    var rng = mulberry32((key ^ 0x9E3779B9) >>> 0);
    var s = new Int8Array(CHIP);
    for (var i = 0; i < CHIP; i++) s[i] = rng() < 0.5 ? -1 : 1;
    return s;
  }

  function mSequence15() {
    var state = 0xF, out = [];
    for (var i = 0; i < 15; i++) {
      var lsb = state & 1;
      out.push(lsb ? 1 : -1);
      var fb = ((state & 1) ^ ((state >> 1) & 1)) & 1;
      state = (state >> 1) | (fb << 3);
    }
    return out;
  }
  var MSEQ = mSequence15();

  // m 序列差分模板 D[i]=m[i]·m[i−1]（循环），整体反相下不变
  var MSEQ_DIFF = (function () {
    var d = new Int8Array(SYNC_LEN);
    for (var i = 0; i < SYNC_LEN; i++) d[i] = MSEQ[i] * MSEQ[(i - 1 + SYNC_LEN) % SYNC_LEN];
    return d;
  })();

  function crc16Ccitt(bytes) {
    var crc = 0xFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (var j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc & 0xFFFF;
  }

  function deriveKey(passphrase) {
    if (!passphrase || !String(passphrase).length) throw new Error('必须填写口令');
    return fnv1a(String(passphrase));
  }

  function payloadChecksum(id32, key) {
    var bytes = [(id32 >>> 24) & 255, (id32 >>> 16) & 255, (id32 >>> 8) & 255, id32 & 255];
    var crc = crc16Ccitt(bytes);
    return (crc ^ (key & 0xFFFF) ^ ((key >>> 16) & 0xFFFF)) & 0xFFFF;
  }

  function payloadBits(idHex, key) {
    if (!/^[0-9a-fA-F]{8}$/.test(idHex)) throw new Error('编号必须是 8 位十六进制（0-9 A-F）');
    var id32 = parseInt(idHex, 16) >>> 0;
    var check = payloadChecksum(id32, key);
    var bits = new Uint8Array(PAYLOAD_BITS);
    for (var i = 31; i >= 0; i--) bits[31 - i] = (id32 >>> i) & 1;
    for (var i2 = 15; i2 >= 0; i2--) bits[32 + (15 - i2)] = (check >>> i2) & 1;
    return { bits: bits, id32: id32, check: check };
  }

  // 构造 63 符号块。同步头为 m 序列；载荷差分编码，首符号以同步头末位为参考。
  function buildBlock(idHex, key) {
    var pl = payloadBits(idHex, key);
    var block = new Int8Array(BLOCK);
    for (var p = 0; p < SYNC_LEN; p++) block[p] = MSEQ[p];
    var prev = MSEQ[SYNC_LEN - 1];
    for (var b = 0; b < PAYLOAD_BITS; b++) {
      var sym = pl.bits[b] ? -prev : prev;
      block[SYNC_LEN + b] = sym;
      prev = sym;
    }
    return block;
  }

  // ---------- 嵌入 ----------

  function embed(wav, idHex, passphrase, opts) {
    if (wav.sampleRate !== FS) throw new Error('仅支持 16 kHz 输入，当前为 ' + wav.sampleRate + ' Hz');
    var alpha = opts && opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
    if (!(alpha >= 0.002 && alpha <= 0.05)) throw new Error('强度 alpha 必须在 0.002–0.05 之间');

    var key = deriveKey(passphrase);
    var block = buildBlock(idHex, key);
    var pn = chipCode(key);
    var L = wav.length;
    var out = [];
    for (var ch = 0; ch < wav.channels; ch++) {
      var x = wav.samples[ch];
      var y = new Float32Array(L);
      for (var n = 0; n < L; n++) {
        var v = x[n] + alpha * pn[n % CHIP] * block[((n / CHIP) | 0) % BLOCK];
        y[n] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
      out.push(y);
    }
    return { samples: out, chips: Math.floor(L / CHIP), alpha: alpha, key: key };
  }

  // ---------- 检测 ----------

  function downmix(wav) {
    if (wav.channels === 1) return wav.samples[0];
    var a = wav.samples[0], b = wav.samples[1], n = a.length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) mono[i] = 0.5 * (a[i] + b[i]);
    return mono;
  }

  function foldAtAlign(x, align, pn) {
    var nChips = Math.floor((x.length - align) / CHIP);
    var A = new Float64Array(BLOCK), E = new Float64Array(BLOCK), Cc = new Float64Array(BLOCK);
    for (var i = 0; i < nChips; i++) {
      var r = 0, e = 0;
      var base = align + i * CHIP;
      for (var u = 0; u < CHIP; u++) {
        var v = x[base + u];
        r += v * pn[u];
        e += v * v;
      }
      var p = i % BLOCK;
      A[p] += r; E[p] += e; Cc[p]++;
    }
    return { A: A, E: E, Cc: Cc, nChips: nChips };
  }

  // 相邻位置符号差分（与整体极性无关）
  function signDiff(A, p) {
    var prev = (p - 1 + BLOCK) % BLOCK;
    return A[p] * A[prev] >= 0 ? 1 : -1;
  }

  // 差分模板符合率同步。corr∈[-1,1]，正确对齐且锁相时接近 1。
  function syncSearch(folded) {
    var A = folded.A, Cc = folded.Cc;
    var best = { p0: 0, corr: -2, positions: 0 };
    for (var p0 = 0; p0 < BLOCK; p0++) {
      var num = 0, positions = 0;
      for (var i = 0; i < SYNC_LEN; i++) {
        var p = (p0 + i) % BLOCK;
        var prev = (p - 1 + BLOCK) % BLOCK;
        if (Cc[p] === 0 || Cc[prev] === 0) continue;
        num += MSEQ_DIFF[i] * signDiff(A, p);
        positions++;
      }
      if (positions < 10) continue;
      var corr = num / positions;
      if (corr > best.corr) best = { p0: p0, corr: corr, positions: positions };
    }
    return best;
  }

  // 差分载荷软判决。软值取归一化符号差分（[-1,1]），多块已在折叠 A 相干累加。
  function decodePayload(folded, sync) {
    var A = folded.A, Cc = folded.Cc;
    var id32 = 0, check = 0, missing = 0;
    var margin = Infinity;
    var soft = new Float64Array(PAYLOAD_BITS);
    for (var b = 0; b < PAYLOAD_BITS; b++) {
      var idx = (sync.p0 + SYNC_LEN + b) % BLOCK;
      var prev = (idx - 1 + BLOCK) % BLOCK;
      if (Cc[idx] === 0 || Cc[prev] === 0) { missing++; soft[b] = 0; continue; }
      var denom = Math.abs(A[idx]) * Math.abs(A[prev]);
      var d = denom > 1e-12 ? (A[idx] * A[prev]) / denom : 0; // >0 不变→bit0，<0 翻转→bit1
      soft[b] = d;
      margin = Math.min(margin, Math.abs(d));
      var bit = d < 0 ? 1 : 0;
      if (b < 32) id32 = (id32 << 1) | bit;
      else check = (check << 1) | bit;
    }
    return { id32: id32 >>> 0, check: check & 0xFFFF, missing: missing, margin: margin, soft: soft };
  }

  // 折叠相关的归一化强度（连续、不饱和）：所有块位置 |A[p]|/√(C·E[p]) 的中位数。
  // 裸宿主该值 <0.07；含水印时随 α 与积累块数上升，是区分“有信号/无信号”的主门限。
  function foldStrength(folded) {
    var vals = [];
    for (var p = 0; p < BLOCK; p++) {
      if (folded.Cc[p] > 0) vals.push(Math.abs(folded.A[p]) / Math.sqrt(CHIP * Math.max(folded.E[p], 1e-12)));
    }
    if (!vals.length) return 0;
    vals.sort(function (a, b) { return a - b; });
    return vals[Math.floor(vals.length / 2)];
  }

  // 在给定对齐下，对全部 63 个候选块相位尝试差分载荷解码，返回通过 CRC 的候选及证据。
  // 15 位差分同步模板可能在少数相位上歧义（符合率并列 1.0），故最终相位由 48 位
  // 载荷（32 位编号 + 16 位密钥 CRC）唯一裁决；同步符合率仅作门限与证据。
  function tryAllPhases(folded, key) {
    var A = folded.A, Cc = folded.Cc;
    var results = [];
    for (var p0 = 0; p0 < BLOCK; p0++) {
      var conf = 0, positions = 0;
      for (var i = 0; i < SYNC_LEN; i++) {
        var p = (p0 + i) % BLOCK;
        var prev = (p - 1 + BLOCK) % BLOCK;
        if (Cc[p] === 0 || Cc[prev] === 0) continue;
        conf += MSEQ_DIFF[i] * signDiff(A, p);
        positions++;
      }
      if (positions < 10) continue;
      conf = conf / positions;
      var decoded = decodePayload(folded, { p0: p0 });
      var expectedCheck = payloadChecksum(decoded.id32, key);
      var crcPass = decoded.missing === 0 && decoded.check === expectedCheck;
      results.push({ p0: p0, conf: conf, decoded: decoded, crcPass: crcPass });
    }
    return results;
  }

  function toHex32(v) {
    var s = (v >>> 0).toString(16).toUpperCase();
    while (s.length < 8) s = '0' + s;
    return s;
  }

  function verify(wav, passphrase, opts) {
    if (wav.sampleRate !== FS) throw new Error('仅支持 16 kHz 输入，当前为 ' + wav.sampleRate + ' Hz');
    var key = deriveKey(passphrase);
    var threshold = (opts && opts.syncThreshold != null) ? opts.syncThreshold : SYNC_THRESHOLD;
    var pn = chipCode(key);
    var mono = downmix(wav);
    var L = mono.length;

    // 两阶段搜索：
    //  阶段一：遍历全部 chip 对齐，每对齐用同步符合率找峰，收集峰最高的若干对齐；
    //  阶段二：对候选对齐的全部 63 个块相位做 CRC 解码，由载荷 CRC 唯一裁决正确相位。
    var alignCandidates = [];
    for (var o = 0; o < CHIP; o += ALIGN_STEP) {
      var folded = foldAtAlign(mono, o, pn);
      if (folded.nChips < MIN_CHIPS) continue;
      var sync = syncSearch(folded);
      alignCandidates.push({ align: o, folded: folded, sync: sync });
    }
    if (alignCandidates.length === 0) {
      return { detected: false, reason: 'too-short', checks: [], durationSec: L / FS };
    }
    // 按同步符合率降序，只在峰附近（含并列歧义相位）的对齐上做全相位 CRC
    alignCandidates.sort(function (a, b) { return b.sync.corr - a.sync.corr; });
    var topConf = alignCandidates[0].sync.corr;
    var shortlist = alignCandidates.filter(function (c) { return c.sync.corr >= topConf - 0.2; })
      .slice(0, 8);

    var winner = null;       // CRC 通过的最佳候选
    var bestNoCrc = null;    // 未通过时保留证据最强的候选，用于报告
    for (var ci = 0; ci < shortlist.length; ci++) {
      var cand = shortlist[ci];
      var strength = foldStrength(cand.folded);
      var phases = tryAllPhases(cand.folded, key);
      for (var pi = 0; pi < phases.length; pi++) {
        var ph = phases[pi];
        var cur = {
          align: cand.align, folded: cand.folded, p0: ph.p0, conf: ph.conf, strength: strength,
          decoded: ph.decoded, crcPass: ph.crcPass
        };
        if (!bestNoCrc || ph.conf > bestNoCrc.conf) bestNoCrc = cur;
        if (ph.crcPass && ph.decoded.margin >= MARGIN_THRESHOLD && strength >= STRENGTH_THRESHOLD) {
          if (!winner || ph.decoded.margin > winner.decoded.margin) winner = cur;
        }
      }
    }

    var chosen = winner || bestNoCrc;
    var sync = { corr: chosen.conf, positions: 10, p0: chosen.p0 };
    var decoded = chosen.decoded;
    var crcPass = !!winner;
    var best = { align: chosen.align, folded: chosen.folded };

    var T = chosen.folded.nChips;
    var blockStarts = [];
    for (var g = -1; g < Math.ceil(T / BLOCK) + 1; g++) {
      var t0 = chosen.p0 + g * BLOCK;
      if (t0 >= 0 && t0 < T) blockStarts.push(t0);
    }
    var completeBlocks = 0;
    for (var bi = 0; bi < blockStarts.length; bi++) {
      if (blockStarts[bi] + BLOCK - 1 < T) completeBlocks++;
    }
    var firstSyncSample = chosen.align + chosen.p0 * CHIP;
    var lastEndChip = blockStarts.length ? blockStarts[blockStarts.length - 1] + BLOCK - 1 : 0;
    var spanSamples = lastEndChip * CHIP + CHIP - firstSyncSample;

    var sigLevel = 0, sigCount = 0;
    for (var p = 0; p < BLOCK; p++) if (chosen.folded.Cc[p] > 0) {
      sigLevel += Math.abs(chosen.folded.A[p]) / Math.sqrt(CHIP * Math.max(chosen.folded.E[p], 1e-12));
      sigCount++;
    }
    sigLevel = sigCount ? sigLevel / sigCount : 0;

    var checks = [
      { name: '同步符合率', pass: chosen.conf >= threshold,
        value: chosen.conf.toFixed(3), threshold: threshold,
        detail: 'm 序列差分模板符合率，用于锁定块相位' },
      { name: '信号强度', pass: chosen.strength >= STRENGTH_THRESHOLD,
        value: chosen.strength.toFixed(3), threshold: STRENGTH_THRESHOLD,
        detail: '折叠相关归一化强度中位数；裸宿主实测 <0.07' },
      { name: '完整块数量', pass: completeBlocks >= 1,
        value: completeBlocks + ' 块', threshold: '≥1' },
      { name: '载荷校验和', pass: crcPass,
        value: crcPass ? '通过' : '不通过', threshold: 'CRC-16 与口令派生值一致' },
      { name: '判决裕量', pass: decoded.margin >= MARGIN_THRESHOLD,
        value: decoded.margin.toFixed(2), threshold: '≥' + MARGIN_THRESHOLD }
    ];
    var detected = crcPass && chosen.conf >= threshold &&
      chosen.strength >= STRENGTH_THRESHOLD &&
      completeBlocks >= 1 && decoded.margin >= MARGIN_THRESHOLD;

    var expectedCheck = payloadChecksum(decoded.id32, key);
    var report = {
      detected: detected,
      durationSec: L / FS,
      chipAlign: chosen.align,
      syncCorr: chosen.conf,
      strength: chosen.strength,
      blockPhase: chosen.p0,
      blocksCovered: completeBlocks,
      blockStartChips: blockStarts,
      payloadMargin: decoded.margin,
      meanCorrLevel: sigLevel,
      crcPass: crcPass,
      checks: checks,
      position: {
        firstSyncSample: firstSyncSample,
        firstSyncSec: firstSyncSample / FS,
        spanSec: spanSamples / FS,
        blockStartSec: blockStarts.map(function (tc) { return (chosen.align + tc * CHIP) / FS; })
      }
    };
    if (detected) {
      report.idHex = toHex32(decoded.id32);
    } else {
      report.reason = chosen.strength < STRENGTH_THRESHOLD ? 'no-signal'
        : !crcPass && chosen.conf >= threshold ? 'crc-failed'
        : chosen.conf < threshold ? 'no-sync' : 'insufficient-evidence';
      report.diagnostics = {
        candidateHex: toHex32(decoded.id32),
        candidateCheck: '0x' + decoded.check.toString(16).toUpperCase().padStart(4, '0'),
        expectedCheck: '0x' + expectedCheck.toString(16).toUpperCase().padStart(4, '0'),
        note: '候选编号未通过校验，不得采信'
      };
    }
    return report;
  }

  WM.FS = FS; WM.CHIP = CHIP; WM.BLOCK = BLOCK; WM.SYNC_LEN = SYNC_LEN;
  WM.PAYLOAD_BITS = PAYLOAD_BITS; WM.DEFAULT_ALPHA = DEFAULT_ALPHA;
  WM.SYNC_THRESHOLD = SYNC_THRESHOLD; WM.STRENGTH_THRESHOLD = STRENGTH_THRESHOLD;
  WM.MARGIN_THRESHOLD = MARGIN_THRESHOLD;
  WM.MSEQ = MSEQ; WM.MSEQ_DIFF = MSEQ_DIFF;
  WM.deriveKey = deriveKey;
  WM.buildBlock = buildBlock;
  WM.payloadBits = payloadBits;
  WM.chipCode = chipCode;
  WM.payloadChecksum = payloadChecksum;
  WM.crc16Ccitt = crc16Ccitt;
  WM.embed = embed;
  WM.verify = verify;
  WM.downmix = downmix;
  WM.foldAtAlign = foldAtAlign;
  WM.syncSearch = syncSearch;
  WM.decodePayload = decodePayload;
  WM.toHex32 = toHex32;
})(typeof globalThis !== 'undefined' ? globalThis : this);
