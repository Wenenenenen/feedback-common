/* 剪点字幕台 · exact rational conform engine
 * ------------------------------------------------------------------------
 * Runs in the browser (window.CaptionEngine) and in Node (module.exports).
 * Every internal time is an exact reduced fraction of milliseconds; the
 * only float-ish math is the integer screening pass used to find candidate
 * intersections quickly.
 *
 * Package rules implemented:
 *  - source-relative cue × same-source clip positive-length intersection
 *  - word cues keep only words with positive intersection, joined by " "
 *  - clip-cut result cues keep the mapped cue∩clip bounds, not the first/last word
 *  - output length = (out - in) * q / p, gaps add duration_ms
 *  - sort by exact start, clip order, then source cue id (code-unit order)
 *  - id = clip id + ":" + cue id; reused clips each produce their own cues
 *  - WebVTT: start floor ms, end ceil ms, HH:MM:SS.mmm
 *  - JSON: fractions as reduced [numerator, denominator] decimal strings
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CaptionEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ZERO = 0n, ONE = 1n;

  function abs(n) { return n < ZERO ? -n : n; }
  function gcd(a, b) {
    a = abs(a); b = abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a || ONE;
  }
  function floorDiv(n, d) {
    if (n >= ZERO) return n / d;
    return -((-n + d - ONE) / d);
  }

  function Frac(n, d) {
    if (d === undefined) d = ONE;
    if (typeof n !== "bigint") n = BigInt(n);
    if (typeof d !== "bigint") d = BigInt(d);
    if (d === ZERO) throw new RangeError("zero denominator");
    if (d < ZERO) { n = -n; d = -d; }
    var g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  Frac.prototype.add = function (o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); };
  Frac.prototype.sub = function (o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); };
  Frac.prototype.mul = function (o) { return new Frac(this.n * o.n, this.d * o.d); };
  Frac.prototype.div = function (o) { return new Frac(this.n * o.d, this.d * o.n); };
  Frac.prototype.cmp = function (o) {
    var x = this.n * o.d, y = o.n * this.d;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  Frac.prototype.eq = function (o) { return this.n === o.n && this.d === o.d; };
  Frac.prototype.isZero = function () { return this.n === ZERO; };
  Frac.prototype.neg = function () { return new Frac(-this.n, this.d); };
  Frac.prototype.floor = function () { return floorDiv(this.n, this.d); };
  Frac.prototype.ceil = function () { return -floorDiv(-this.n, this.d); };
  Frac.prototype.toNumber = function () { return Number(this.n) / Number(this.d); };
  Frac.prototype.pair = function () { return [this.n.toString(), this.d.toString()]; };
  Frac.prototype.toString = function () { return this.n + "/" + this.d; };

  function frac(n, d) { return new Frac(n, d === undefined ? ONE : d); }
  var FRAC_ZERO = frac(0);

  // Dictionary order over UTF-16 code units, as Array.prototype.sort compares
  // strings. Explicit so the rule does not depend on locale settings.
  function compareCodeUnits(a, b) {
    a = String(a); b = String(b);
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = a.charCodeAt(i), y = b.charCodeAt(i);
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  function isInt(v) { return typeof v === "number" && Number.isSafeInteger(v); }
  function isNonEmptyString(v) { return typeof v === "string" && v.length > 0; }
  function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

  /* ------------------------------------------------------------------ *
   * Validation. Every issue carries enough identity for the UI to jump to
   * the exact input cell: sourceIndex / cueIndex / wordIndex / clipIndex.
   * ------------------------------------------------------------------ */

  function issue(p) {
    p.level = p.level || "error";
    return p;
  }

  function validateDoc(doc) {
    var errors = [];
    var notes = [];
    if (!isObject(doc)) {
      errors.push(issue({ scope: "doc", path: "$", where: "文档", message: "JSON 根节点必须是对象。" }));
      return { errors: errors, notes: notes };
    }
    var sources = doc.sources, clips = doc.clips;
    if (!Array.isArray(sources)) {
      errors.push(issue({ scope: "doc", path: "sources", where: "源素材", message: "sources 必须是数组。" }));
      sources = [];
    }
    if (!Array.isArray(clips)) {
      errors.push(issue({ scope: "doc", path: "clips", where: "剪辑单", message: "clips 必须是数组。" }));
      clips = [];
    }

    var sourceById = Object.create(null);
    var totalCues = 0, totalWords = 0;

    sources.forEach(function (src, si) {
      var sp = "sources[" + si + "]";
      if (!isObject(src)) {
        errors.push(issue({ scope: "source", sourceIndex: si, path: sp, where: "源 #" + (si + 1), message: "源必须是对象。" }));
        return;
      }
      var sid = src.id;
      var where = "源 " + (isNonEmptyString(sid) ? sid : "#" + (si + 1));
      if (!isNonEmptyString(sid)) {
        errors.push(issue({ scope: "source", sourceIndex: si, path: sp + ".id", where: where, message: "源 id 必须是非空字符串。" }));
      } else if (sourceById[sid]) {
        errors.push(issue({ scope: "source", sourceIndex: si, path: sp + ".id", where: where, message: "源 id“" + sid + "”重复，引用会产生歧义。" }));
      } else {
        sourceById[sid] = src;
      }
      var dur = src.duration_ms;
      if (!isInt(dur) || dur <= 0) {
        errors.push(issue({ scope: "source", sourceIndex: si, path: sp + ".duration_ms", where: where, message: "素材时长必须是大于 0 的整数毫秒。" }));
        dur = null;
      }
      if (!Array.isArray(src.cues)) {
        errors.push(issue({ scope: "source", sourceIndex: si, path: sp + ".cues", where: where, message: "cues 必须是数组。" }));
        return;
      }
      var cueIds = Object.create(null);      src.cues.forEach(function (cue, ci) {
        var cp = sp + ".cues[" + ci + "]";
        var cw = where + " · 字幕 #" + (ci + 1);
        if (!isObject(cue)) {
          errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp, where: cw, message: "字幕必须是对象。" }));
          return;
        }
        totalCues++;
        var cid = cue.id;
        if (!isNonEmptyString(cid)) {
          errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".id", where: cw, message: "字幕 id 必须是非空字符串。" }));
        } else {
          cw = where + " · 字幕 " + cid;
          if (cueIds[cid]) {
            errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".id", where: cw, message: "同一源内字幕 id“" + cid + "”重复。" }));
          }
          cueIds[cid] = true;
        }
        var cs = cue.start, ce = cue.end;
        var timesOk = true;
        if (!isInt(cs)) {
          errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".start", where: cw, message: "字幕起点必须是整数毫秒。" }));
          timesOk = false;
        }
        if (!isInt(ce)) {
          errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".end", where: cw, message: "字幕终点必须是整数毫秒。" }));
          timesOk = false;
        }
        if (timesOk) {
          if (cs < 0) {
            errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".start", where: cw, message: "字幕起点 " + cs + "ms 为负数，区间非法。" }));
          }
          if (ce <= cs) {
            errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".end", where: cw, message: "字幕区间 [" + cs + ", " + ce + ") 长度不为正，区间非法。" }));
          }
          if (dur !== null && ce > dur) {
            notes.push(issue({ level: "warn", scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".end", where: cw, message: "字幕终点 " + ce + "ms 越过素材时长 " + dur + "ms。" }));
          }
        }
        if (typeof cue.text !== "string") {
          errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".text", where: cw, message: "字幕 text 必须是字符串。" }));
        }
        if (cue.words !== undefined) {
          if (!Array.isArray(cue.words)) {
            errors.push(issue({ scope: "cue", sourceIndex: si, cueIndex: ci, path: cp + ".words", where: cw, message: "words 必须是数组。" }));
            return;
          }
          var prev = null;
          cue.words.forEach(function (w, wi) {
            var wp = cp + ".words[" + wi + "]";
            var ww = cw + " · 词 #" + (wi + 1);
            if (!isObject(w)) {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp, where: ww, message: "词必须是对象。" }));
              prev = null;
              return;
            }
            totalWords++;
            if (typeof w.text !== "string") {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".text", where: ww, message: "词 text 必须是字符串。" }));
            }
            var ws = w.start, we = w.end, ok = true;
            if (!isInt(ws)) {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".start", where: ww, message: "词起点必须是整数毫秒。" }));
              ok = false;
            }
            if (!isInt(we)) {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".end", where: ww, message: "词终点必须是整数毫秒。" }));
              ok = false;
            }
            if (!ok) { prev = null; return; }
            if (we <= ws) {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".end", where: ww, message: "词区间 [" + ws + ", " + we + ") 长度不为正，区间非法。" }));
            }
            if (timesOk && (ws < cs || we > ce)) {
              errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp, where: ww, message: "词区间 [" + ws + ", " + we + ") 不在所属字幕 [" + cs + ", " + ce + ") 内。" }));
            }
            if (prev) {
              if (ws < prev.start) {
                errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".start", where: ww, kind: "order", message: "错序词：起点 " + ws + "ms 早于前一词 #" + prev.index + " 的起点 " + prev.start + "ms。" }));
              } else if (ws < prev.end) {
                errors.push(issue({ scope: "word", sourceIndex: si, cueIndex: ci, wordIndex: wi, path: wp + ".start", where: ww, kind: "overlap", message: "词与前一词 #" + prev.index + " 时间重叠：前词止于 " + prev.end + "ms，本词起于 " + ws + "ms。" }));
              }
            }
            prev = { start: ws, end: we, index: wi + 1 };
          });
        }
      });
    });

    var clipIds = Object.create(null);
    clips.forEach(function (clip, ci) {
      var cp = "clips[" + ci + "]";
      var cw = "片段 #" + (ci + 1);
      if (!isObject(clip)) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp, where: cw, message: "片段必须是对象。" }));
        return;
      }
      var id = clip.id;
      if (!isNonEmptyString(id)) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".id", where: cw, message: "片段 id 必须是非空字符串。" }));
      } else {
        cw = "片段 " + id;
        if (clipIds[id]) errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".id", where: cw, message: "片段 id“" + id + "”重复。" }));
        clipIds[id] = true;
      }
      if (clip.source === null) {
        var gd = clip.duration_ms;
        if (!isInt(gd) || gd < 0) {
          errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".duration_ms", where: cw, message: "空白段时长必须是大于或等于 0 的整数毫秒。" }));
        }
        return;
      }
      if (!isNonEmptyString(clip.source)) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".source", where: cw, message: "普通片段必须指定 source；空白段请用 source: null。" }));
        return;
      }
      var src = sourceById[clip.source];
      if (!src) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".source", where: cw, message: "引用了不存在的源“" + clip.source + "”。" }));
        return;
      }
      var din = clip.in, dout = clip.out;
      var inOk = isInt(din), outOk = isInt(dout);
      if (!inOk) errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".in", where: cw, message: "入点必须是整数毫秒。" }));
      if (!outOk) errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".out", where: cw, message: "出点必须是整数毫秒。" }));
      if (inOk && outOk) {
        if (din < 0) {
          errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".in", where: cw, message: "入点 " + din + "ms 为负数，区间非法。" }));
        }
        if (dout <= din) {
          errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".out", where: cw, message: "片段区间 [" + din + ", " + dout + ") 长度不为正，区间非法。" }));
        }
        if (isInt(src.duration_ms) && dout > src.duration_ms) {
          errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".out", where: cw, message: "出点 " + dout + "ms 越过源“" + clip.source + "”时长 " + src.duration_ms + "ms。" }));
        }
        if (isInt(src.duration_ms) && din > src.duration_ms) {
          errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".in", where: cw, message: "入点 " + din + "ms 越过源“" + clip.source + "”时长 " + src.duration_ms + "ms。" }));
        }
      }
      var sp = clip.speed;
      if (!Array.isArray(sp) || sp.length !== 2 || !isInt(sp[0]) || !isInt(sp[1])) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".speed", where: cw, message: "速度必须是 [p, q] 两个整数。" }));
        return;
      }
      var p = sp[0], q = sp[1];
      if (p === 0 || q === 0) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".speed", where: cw, kind: "zero-speed", message: "速度不能为零（p/q = " + p + "/" + q + "）。" }));
        return;
      }
      if (p < 0 || q < 0) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".speed", where: cw, message: "速度分量必须为正整数。" }));
        return;
      }
      if (p > 1000 || q > 1000) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".speed", where: cw, message: "速度分量 p、q 必须在 1–1000 之间，当前为 " + p + "/" + q + "。" }));
        return;
      }
      var ratio = frac(p, q);
      if (ratio.cmp(frac(1, 4)) < 0 || ratio.cmp(frac(4, 1)) > 0) {
        errors.push(issue({ scope: "clip", clipIndex: ci, path: cp + ".speed", where: cw, message: "速度 " + p + "/" + q + " 超出 1/4–4 倍范围。" }));
      }
    });

    if (totalCues > 1500) notes.push(issue({ level: "warn", scope: "doc", path: "sources", where: "源素材", message: "源字幕共 " + totalCues + " 条，超过建议上限 1500 条。" }));
    if (totalWords > 10000) notes.push(issue({ level: "warn", scope: "doc", path: "sources", where: "源素材", message: "逐词时间共 " + totalWords + " 个，超过建议上限 10000 个。" }));
    if (clips.length > 500) notes.push(issue({ level: "warn", scope: "doc", path: "clips", where: "剪辑单", message: "片段共 " + clips.length + " 个，超过建议上限 500 个。" }));

    return { errors: errors, notes: notes };
  }

  /* ------------------------------------------------------------------ *
   * Conform. tolerant=true skips clips/cues/words that cannot be used so
   * the editor keeps previewing while the issue list points at each one.
   * ------------------------------------------------------------------ */

  function buildClipContext(doc) {
    var byId = Object.create(null);
    doc.sources.forEach(function (s, i) { if (isObject(s) && isNonEmptyString(s.id) && !byId[s.id]) byId[s.id] = s; });
    var index = Object.create(null);
    doc.sources.forEach(function (src, si) {
      if (!isObject(src) || !Array.isArray(src.cues)) return;
      var rows = [];
      src.cues.forEach(function (cue, ci) {
        if (!isObject(cue) || !isInt(cue.start) || !isInt(cue.end)) return;
        rows.push({ cue: cue, ci: ci, start: cue.start, end: cue.end });
      });
      rows.sort(function (a, b) { return a.start - b.start || a.end - b.end || a.ci - b.ci; });
      var suffixMax = new Array(rows.length + 1);
      var max = -Infinity;
      suffixMax[rows.length] = -Infinity;
      for (var k = rows.length - 1; k >= 0; k--) {
        if (rows[k].end > max) max = rows[k].end;
        suffixMax[k] = max;
      }
      index[si] = { rows: rows, starts: rows.map(function (r) { return r.start; }), suffixMax: suffixMax };
    });
    return { byId: byId, index: index };
  }

  function candidatesFor(index, inMs, outMs) {
    if (!index) return [];
    var starts = index.starts;
    var lo = 0, hi = starts.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] < outMs) lo = mid + 1; else hi = mid;
    }
    var out = [];
    for (var j = lo - 1; j >= 0; j--) {
      if (index.suffixMax[j] <= inMs) break;
      if (index.rows[j].end > inMs) out.push(index.rows[j]);
    }
    out.reverse();
    return out;
  }

  function clipOutputLength(clip) {
    if (clip.source === null) {
      return isInt(clip.duration_ms) && clip.duration_ms >= 0 ? frac(clip.duration_ms) : null;
    }
    if (!isInt(clip.in) || !isInt(clip.out) || !Array.isArray(clip.speed)) return null;
    var p = clip.speed[0], q = clip.speed[1];
    if (!isInt(p) || !isInt(q) || p === 0 || q === 0) return null;
    return frac(clip.out - clip.in).mul(frac(q, p));
  }

  function computeDuration(clips) {
    var t = FRAC_ZERO;
    for (var i = 0; i < clips.length; i++) {
      var l = clipOutputLength(clips[i]);
      if (l) t = t.add(l);
    }
    return t;
  }

  function conform(doc, options) {
    options = options || {};
    var tolerant = !!options.tolerant;
    var v = validateDoc(doc);
    var errors = v.errors, notes = v.notes;
    var blocking = errors.length > 0;
    if (blocking && !tolerant) {
      return { duration: FRAC_ZERO, cues: [], errors: errors, notes: notes, blocking: true, skippedClips: 0, usedClips: 0, sourceById: Object.create(null), cueCount: 0, overlapCount: 0, spans: [] };
    }

    var ctx = buildClipContext(doc);
    // Issues are tolerated one at a time: while the editor is open its own
    // fixable problems must not blank the whole timeline. In strict mode
    // (the default) any problem blocks, matching the package contract.
    var badClips = Object.create(null), badCues = Object.create(null), badWords = Object.create(null), badSources = Object.create(null);
    if (tolerant) {
      errors.forEach(function (e) {
        if (e.scope === "clip") badClips[e.clipIndex] = true;
        else if (e.scope === "cue") badCues[e.sourceIndex + ":" + e.cueIndex] = true;
        else if (e.scope === "word") badWords[e.sourceIndex + ":" + e.cueIndex + ":" + e.wordIndex] = true;
        else if (e.scope === "source") badSources[e.sourceIndex] = true;
      });
    }

    var clips = Array.isArray(doc.clips) ? doc.clips : [];
    var sources = Array.isArray(doc.sources) ? doc.sources : [];
    var out = [];
    var timeline = FRAC_ZERO;
    var usedClips = 0, skippedClips = 0;
    var spans = [];

    clips.forEach(function (clip, order) {
      var span = { index: order, valid: false, start: timeline, length: null, end: timeline };
      spans.push(span);
      if (!isObject(clip)) { skippedClips++; return; }
      if (badClips[order]) { skippedClips++; return; }
      if (clip.source === null) {
        var gd = isInt(clip.duration_ms) && clip.duration_ms >= 0 ? clip.duration_ms : 0;
        span.length = frac(gd);
        span.end = timeline.add(span.length);
        span.valid = true;
        timeline = span.end;
        usedClips++;
        return;
      }
      var src = ctx.byId[clip.source];
      if (!src) { skippedClips++; return; }
      var si = sources.indexOf(src);
      if (si >= 0 && badSources[si]) { skippedClips++; return; }
      span.sourceIndex = si;
      var p = clip.speed[0], q = clip.speed[1];
      var scale = frac(q, p);
      var inMs = clip.in, outMs = clip.out;
      var t0 = timeline;
      var clipEndOut = t0.add(frac(outMs - inMs).mul(scale));
      span.length = clipEndOut.sub(t0);
      span.end = clipEndOut;
      span.valid = true;
      usedClips++;

      var cands = candidatesFor(ctx.index[si], inMs, outMs);
      for (var k = 0; k < cands.length; k++) {
        var row = cands[k];
        var cue = row.cue, ci = row.ci;
        if (badCues[si + ":" + ci]) continue;
        var cutStart = Math.max(cue.start, inMs);
        var cutEnd = Math.min(cue.end, outMs);
        if (cutEnd <= cutStart) continue;

        var hasWords = Array.isArray(cue.words);
        var words = [];
        if (hasWords) {
          for (var wi = 0; wi < cue.words.length; wi++) {
            var w = cue.words[wi];
            if (!isObject(w)) continue;
            if (badWords[si + ":" + ci + ":" + wi]) continue;
            if (!isInt(w.start) || !isInt(w.end) || w.end <= w.start) continue;
            var ws = Math.max(w.start, inMs);
            var we = Math.min(w.end, outMs);
            if (we <= ws) continue;
            words.push({
              text: w.text,
              start: t0.add(frac(ws - inMs).mul(scale)),
              end: t0.add(frac(we - inMs).mul(scale)),
              srcStart: w.start,
              srcEnd: w.end,
              cutStart: ws,
              cutEnd: we,
              index: wi
            });
          }
          if (!words.length) continue;
        }

        out.push({
          id: clip.id + ":" + cue.id,
          key: order + ":" + ci,
          clipOrder: order,
          clipId: clip.id,
          sourceId: clip.source,
          sourceIndex: si,
          cueIndex: ci,
          cueId: cue.id,
          cueStart: cue.start,
          cueEnd: cue.end,
          clipIn: inMs,
          clipOut: outMs,
          speedP: p,
          speedQ: q,
          clipOutStart: t0,
          clipOutEnd: clipEndOut,
          cutStart: cutStart,
          cutEnd: cutEnd,
          start: t0.add(frac(cutStart - inMs).mul(scale)),
          end: t0.add(frac(cutEnd - inMs).mul(scale)),
          text: hasWords ? words.map(function (x) { return x.text; }).join(" ") : cue.text,
          words: words,
          hasWords: hasWords
        });
      }
      timeline = clipEndOut;
    });

    out.sort(function (a, b) {
      var c = a.start.cmp(b.start);
      if (c !== 0) return c;
      if (a.clipOrder !== b.clipOrder) return a.clipOrder - b.clipOrder;
      return compareCodeUnits(a.cueId, b.cueId);
    });

    var runningMax = null;
    var overlapCount = 0;
    out.forEach(function (r) {
      r.overlapsEarlier = runningMax !== null && r.start.cmp(runningMax) < 0;
      if (r.overlapsEarlier) overlapCount++;
      if (runningMax === null || r.end.cmp(runningMax) > 0) runningMax = r.end;
    });

    return {
      duration: timeline,
      cues: out,
      errors: errors,
      notes: notes,
      blocking: blocking,
      skippedClips: skippedClips,
      usedClips: usedClips,
      sourceById: ctx.byId,
      cueCount: out.length,
      overlapCount: overlapCount,
      spans: spans
    };
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  function pad(n, width) {
    var s = n.toString();
    while (s.length < width) s = "0" + s;
    return s;
  }

  function vttTime(ms) {
    var h = floorDiv(ms, 3600000n);
    var rest = ms - h * 3600000n;
    var m = rest / 60000n;
    rest -= m * 60000n;
    var s = rest / 1000n;
    var milli = rest - s * 1000n;
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(milli, 3);
  }

  function sanitizeLine(s) {
    return String(s).replace(/\r\n|\r|\n/g, " ");
  }

  // A cue identifier may not contain "-->" or span lines. Ids are otherwise
  // passed through unchanged, since they are how a result is traced back.
  function sanitizeId(id, index) {
    var s = sanitizeLine(id).replace(/-->/g, "--").trim();
    return s || "cue-" + (index + 1);
  }

  function toWebVTT(result) {
    var lines = ["WEBVTT", ""];
    result.cues.forEach(function (cue, i) {
      lines.push(sanitizeId(cue.id, i));
      lines.push(vttTime(cue.start.floor()) + " --> " + vttTime(cue.end.ceil()));
      lines.push(sanitizeLine(cue.text));
      lines.push("");
    });
    return lines.join("\n");
  }

  function toJSON(result) {
    return {
      duration: result.duration.pair(),
      cues: result.cues.map(function (c) {
        return {
          id: c.id,
          clip_order: c.clipOrder,
          start: c.start.pair(),
          end: c.end.pair(),
          text: c.text,
          words: c.words.map(function (w) {
            return { text: w.text, start: w.start.pair(), end: w.end.pair() };
          })
        };
      })
    };
  }

  return {
    Frac: Frac,
    frac: frac,
    validateDoc: validateDoc,
    conform: conform,
    computeDuration: computeDuration,
    clipOutputLength: clipOutputLength,
    toWebVTT: toWebVTT,
    toJSON: toJSON,
    vttTime: vttTime
  };
});
