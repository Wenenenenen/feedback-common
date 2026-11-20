/* 剪点字幕台 · workspace
 * Loads a {sources, clips} document, previews the exact-fraction conformed
 * timeline, links every result back to its source word, edits the edit list,
 * and exports WebVTT plus the exact JSON.
 */
(function () {
  "use strict";

  var E = window.CaptionEngine;
  var LIMITS = { cues: 1500, words: 10000, clips: 500 };
  var NATURAL_LIMIT = 320;

  /* ================================================================== *
   * Built-in documents
   * ================================================================== */

  var DEMO = {
    sources: [{
      id: "a",
      duration_ms: 10000,
      cues: [
        { id: "c1", start: 0, end: 3000, text: "甲 乙 丙", words: [
          { text: "甲", start: 0, end: 1000 },
          { text: "乙", start: 1000, end: 2000 },
          { text: "丙", start: 2000, end: 3000 }
        ] },
        { id: "c2", start: 2500, end: 5000, text: "无逐词字幕" }
      ]
    }],
    clips: [
      { id: "p1", source: "a", in: 500, out: 2000, speed: [3, 2] },
      { id: "gap", source: null, duration_ms: 333 },
      { id: "p2", source: "a", in: 2000, out: 5000, speed: [7, 3] },
      { id: "p3", source: "a", in: 500, out: 2000, speed: [3, 2] }
    ]
  };

  var TOUR = {
    sources: [
      {
        id: "host",
        duration_ms: 12000,
        cues: [
          { id: "h1", start: 0, end: 3200, text: "我们 从头 开始 吧", words: [
            { text: "我们", start: 0, end: 560 },
            { text: "从头", start: 560, end: 1180 },
            { text: "开始", start: 1180, end: 2100 },
            { text: "吧", start: 2100, end: 3140 }
          ] },
          { id: "h2", start: 3000, end: 6200, text: "这其实是一个漫长的过程" },
          { id: "h3", start: 6000, end: 9000, text: "我 觉得 没有 问题 了", words: [
            { text: "我", start: 6000, end: 6440 },
            { text: "觉得", start: 6440, end: 7060 },
            { text: "没有", start: 7060, end: 7680 },
            { text: "问题", start: 7680, end: 8520 },
            { text: "了", start: 8520, end: 8940 }
          ] },
          { id: "h4", start: 8900, end: 11000, text: "那就 这样 定 了", words: [
            { text: "那就", start: 8900, end: 9420 },
            { text: "这样", start: 9420, end: 9980 },
            { text: "定", start: 9980, end: 10480 },
            { text: "了", start: 10480, end: 10960 }
          ] }
        ]
      },
      {
        id: "guest",
        duration_ms: 9000,
        cues: [
          { id: "g1", start: 0, end: 2600, text: "其实 我 也 不 确定", words: [
            { text: "其实", start: 0, end: 480 },
            { text: "我", start: 480, end: 780 },
            { text: "也", start: 780, end: 1080 },
            { text: "不", start: 1080, end: 1560 },
            { text: "确定", start: 1560, end: 2540 }
          ] },
          { id: "g2", start: 2500, end: 5200, text: "但 我们 可以 再 试 一次", words: [
            { text: "但", start: 2500, end: 2780 },
            { text: "我们", start: 2780, end: 3340 },
            { text: "可以", start: 3340, end: 3920 },
            { text: "再", start: 3920, end: 4320 },
            { text: "试", start: 4320, end: 4760 },
            { text: "一次", start: 4760, end: 5140 }
          ] },
          { id: "g3", start: 5000, end: 8800, text: "结果 比 想象 中 好" }
        ]
      }
    ],
    clips: [
      { id: "c1", source: "host", in: 0, out: 4000, speed: [1, 1] },
      { id: "pause", source: null, duration_ms: 250 },
      { id: "c2", source: "guest", in: 200, out: 3000, speed: [3, 2] },
      { id: "c3", source: "host", in: 3000, out: 6500, speed: [1, 1] },
      { id: "c4", source: "guest", in: 200, out: 3000, speed: [1, 1] },
      { id: "beat", source: null, duration_ms: 500 },
      { id: "c5", source: "host", in: 6000, out: 9000, speed: [4, 3] },
      { id: "c6", source: "guest", in: 5000, out: 8800, speed: [2, 3] }
    ]
  };

  /* ================================================================== *
   * State
   * ================================================================== */

  var state = {
    doc: null,
    docName: "demo.json",
    result: null,
    errors: [],
    notes: [],
    byClip: new Map(),
    byCue: new Map(),
    activeSource: 0,
    activeClip: -1,
    selection: null,
    traceTab: "trace",
    undo: [],
    redo: [],
    lists: {}
  };

  /* ================================================================== *
   * Helpers
   * ================================================================== */

  function $(id) { return document.getElementById(id); }

  function el(tag, opts) {
    var n = document.createElement(tag);
    if (opts) {
      if (opts.class) n.className = opts.class;
      if (opts.text !== undefined && opts.text !== null) n.textContent = String(opts.text);
      if (opts.attrs) for (var a in opts.attrs) if (opts.attrs[a] !== null && opts.attrs[a] !== undefined) n.setAttribute(a, opts.attrs[a]);
      if (opts.style) n.style.cssText = opts.style;
      if (opts.data) for (var d in opts.data) n.dataset[d] = opts.data[d];
      if (opts.on) for (var ev in opts.on) n.addEventListener(ev, opts.on[ev]);
    }
    for (var i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }

  function append(n, c) {
    if (c === null || c === undefined) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(n, x); }); return; }
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }

  function clear(node) {
    // replaceChildren detaches in one operation; the old loop can throw when a
    // blur handler re-renders while the browser is still removing a focused node.
    if (typeof node.replaceChildren === "function") node.replaceChildren();
    else node.textContent = "";
  }
  function pad2(v) { return String(v).padStart(2, "0"); }

  function uiTime(ms) {
    if (ms < 0n) ms = 0n;
    var h = ms / 3600000n;
    var mm = (ms % 3600000n) / 60000n;
    var ss = (ms % 60000n) / 1000n;
    var mmm = ms % 1000n;
    var base = pad2(mm) + ":" + pad2(ss) + "." + String(mmm).padStart(3, "0");
    return h > 0n ? String(h).padStart(2, "0") + ":" + base : base;
  }

  function floorUi(f) { return uiTime(f.floor()); }
  function ceilUi(f) { return uiTime(f.ceil()); }
  function msUi(ms) { return uiTime(BigInt(ms)); }
  function fracText(f) { return f.n + "/" + f.d; }

  function fracDecimal(f, digits) {
    digits = digits === undefined ? 3 : digits;
    var scale = 1n;
    for (var i = 0; i < digits; i++) scale *= 10n;
    var neg = f.n < 0n;
    var n = neg ? -f.n : f.n;
    var q = (n * scale) / f.d;
    var s = q.toString();
    while (s.length <= digits) s = "0" + s;
    return (neg ? "-" : "") + s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
  }

  function fracApprox(f) { return "≈" + fracDecimal(f, 3); }

  function sourceAt(si) { return state.doc.sources && state.doc.sources[si]; }
  function sourceLabel(si) {
    var s = sourceAt(si);
    return s && typeof s.id === "string" ? s.id : "源 #" + (si + 1);
  }
  function cueAt(si, ci) {
    var s = sourceAt(si);
    return s && Array.isArray(s.cues) ? s.cues[ci] : null;
  }
  function cueLabel(si, ci) {
    var c = cueAt(si, ci);
    return c && typeof c.id === "string" ? c.id : "#" + (ci + 1);
  }
  function durOf(src) {
    return src && typeof src.duration_ms === "number" && src.duration_ms >= 0 ? src.duration_ms : 0;
  }
  function isPlainObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function countWords(doc) {
    var n = 0;
    (doc.sources || []).forEach(function (s) {
      if (!s || !Array.isArray(s.cues)) return;
      s.cues.forEach(function (c) { if (c && Array.isArray(c.words)) n += c.words.length; });
    });
    return n;
  }
  function countCues(doc) {
    var n = 0;
    (doc.sources || []).forEach(function (s) { if (s && Array.isArray(s.cues)) n += s.cues.length; });
    return n;
  }

  /* ================================================================== *
   * Document lifecycle
   * ================================================================== */

  function normalizeDoc(raw) {
    var doc = clone(raw);
    if (!isPlainObj(doc)) throw new Error("根节点不是对象");
    if (!Array.isArray(doc.sources)) doc.sources = [];
    if (!Array.isArray(doc.clips)) doc.clips = [];
    return doc;
  }

  function loadDoc(raw, name, opts) {
    opts = opts || {};
    var doc;
    try { doc = normalizeDoc(raw); }
    catch (e) { toast("JSON 无法使用：" + e.message, true); return false; }
    state.doc = doc;
    state.docName = name || "导入.json";
    state.undo = [];
    state.redo = [];
    state.activeSource = 0;
    state.activeClip = -1;
    state.selection = null;
    state.traceTab = "trace";
    $("docName").textContent = state.docName;
    $("docChip").classList.toggle("is-custom", state.docName !== "demo.json" && state.docName !== "tour.json");
    recompute();
    if (state.result.cues.length) selectOut(0);
    else if (state.doc.clips.length) selectClip(0);
    else if (state.doc.sources.length && sourceAt(0) && Array.isArray(sourceAt(0).cues) && sourceAt(0).cues.length) selectSourceCue(0, 0);
    else renderAll();
    if (!opts.quiet) {
      var n = state.errors.length;
      toast(n ? "已载入 · " + n + " 个问题待处理" : "已载入 " + state.docName, false);
    }
    persist();
    return true;
  }

  function persist() {
    try {
      localStorage.setItem("caption-conformer:doc", JSON.stringify({ name: state.docName, doc: state.doc }));
    } catch (e) { /* storage unavailable; page still works */ }
  }

  function restore() {
    try {
      var stored = localStorage.getItem("caption-conformer:doc");
      if (!stored) return false;
      var parsed = JSON.parse(stored);
      if (!parsed || !parsed.doc) return false;
      var doc = normalizeDoc(parsed.doc);
      loadDoc(doc, parsed.name || "上次的剪辑单.json", { quiet: true });
      return true;
    } catch (e) { return false; }
  }

  function undoable(fn) {
    state.undo.push(JSON.stringify(state.doc));
    if (state.undo.length > 60) state.undo.shift();
    state.redo.length = 0;
    fn();
    recompute();
    persist();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.undo.pop());
    state.selection = null;
    recompute();
    persist();
    toast("已撤销", false, 1200);
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.doc));
    state.doc = JSON.parse(state.redo.pop());
    state.selection = null;
    recompute();
    persist();
    toast("已重做", false, 1200);
  }

  function updateUndoButtons() {
    $("btnUndo").disabled = state.undo.length === 0;
    $("btnRedo").disabled = state.redo.length === 0;
  }

  /* ================================================================== *
   * Conform + indexes
   * ================================================================== */

  function recompute() {
    // Remember what the selection pointed at by stable identity, then re-find
    // it: edits can reorder results without the reader having moved.
    var anchor = null;
    var sel = state.selection;
    if (sel) {
      if (sel.type === "out" || sel.type === "word") {
        var prev = state.result && state.result.cues[sel.index];
        if (prev) anchor = { kind: "out", id: prev.id, wordIndex: sel.type === "word" ? sel.wordIndex : undefined };
      } else if (sel.type === "clip") {
        var pc = state.doc.clips[sel.index];
        if (pc && typeof pc.id === "string") anchor = { kind: "clip", id: pc.id };
      }
    }

    state.result = E.conform(state.doc, { tolerant: true });
    state.errors = state.result.errors || [];
    state.notes = state.result.notes || [];
    buildIndexes();

    if (anchor) {
      if (anchor.kind === "out") {
        var found = -1;
        for (var i = 0; i < state.result.cues.length; i++) {
          if (state.result.cues[i].id === anchor.id) { found = i; break; }
        }
        if (found >= 0) {
          state.selection = anchor.wordIndex === undefined
            ? { type: "out", index: found }
            : { type: "word", index: found, wordIndex: anchor.wordIndex };
        } else {
          state.selection = null;
        }
      } else {
        var ci = -1;
        for (var j = 0; j < state.doc.clips.length; j++) {
          if (state.doc.clips[j] && state.doc.clips[j].id === anchor.id) { ci = j; break; }
        }
        state.selection = ci >= 0 ? { type: "clip", index: ci } : null;
        if (ci >= 0) state.activeClip = ci;
      }
    }
    renderAll();
  }

  function pushMap(map, key, val) {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(val);
  }

  // Result indices grouped by clip and by source cue. Word-level usage is
  // derived on demand from these, so a 1500×500 run (750k results) only pays
  // for what is visible.
  function buildIndexes() {
    var cues = state.result.cues;
    state.byClip = new Map();
    state.byCue = new Map();
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      pushMap(state.byClip, c.clipOrder, i);
      pushMap(state.byCue, c.sourceIndex + ":" + c.cueIndex, i);
    }
    state.usageCache = new Map();
  }

  function outputsForClip(clipIndex) {
    return state.byClip.get(clipIndex) || [];
  }

  function outputsForSourceCue(si, ci) {
    return state.byCue.get(si + ":" + ci) || [];
  }

  // Map of source word index -> list of result cues that kept it.
  function usedWordsFor(si, ci) {
    var key = si + ":" + ci;
    var cached = state.usageCache.get(key);
    if (cached) return cached;
    var map = new Map();
    outputsForSourceCue(si, ci).forEach(function (oi) {
      var oc = state.result.cues[oi];
      if (!oc || !oc.hasWords) return;
      oc.words.forEach(function (w) {
        var arr = map.get(w.index);
        if (!arr) { arr = []; map.set(w.index, arr); }
        arr.push({ clipId: oc.clipId, clipOrder: oc.clipOrder, cutStart: w.cutStart, cutEnd: w.cutEnd });
      });
    });
    state.usageCache.set(key, map);
    return map;
  }

  /* ================================================================== *
   * Selection
   * ================================================================== */

  function selectOut(index, wordIndex) {
    var cue = state.result.cues[index];
    if (!cue) return;
    state.selection = wordIndex === undefined || wordIndex === null
      ? { type: "out", index: index }
      : { type: "word", index: index, wordIndex: wordIndex };
    state.activeSource = cue.sourceIndex;
    state.activeClip = cue.clipOrder;
    state.traceTab = "trace";
    renderAll();
    scrollOutIntoView(index);
    var sc = cueAt(cue.sourceIndex, cue.cueIndex);
    if (sc) scrollSourceIntoView(cue.cueIndex);
  }

  function selectClip(index) {
    if (!state.doc.clips[index]) return;
    state.selection = { type: "clip", index: index };
    state.activeClip = index;
    var c = state.doc.clips[index];
    if (c && typeof c.source === "string") {
      for (var i = 0; i < state.doc.sources.length; i++) {
        if (state.doc.sources[i] && state.doc.sources[i].id === c.source) { state.activeSource = i; break; }
      }
    }
    state.traceTab = "trace";
    renderAll();
    scrollClipIntoView(index);
    // If the clip's first output names a source cue, show it in the source pane.
    var first = outputsForClip(index)[0];
    if (first !== undefined) {
      var oc = state.result.cues[first];
      if (oc) scrollSourceIntoView(oc.cueIndex);
    }
  }

  function selectSourceCue(si, ci, wi) {
    state.selection = { type: "src", sourceIndex: si, cueIndex: ci, wordIndex: wi };
    state.activeSource = si;
    state.traceTab = "trace";
    renderAll();
    scrollSourceIntoView(ci);
  }

  // The source cue and word that the current selection points at, whatever
  // pane the selection came from.
  function sourceSelection() {
    var sel = state.selection;
    if (!sel) return null;
    if (sel.type === "src") return { si: sel.sourceIndex, ci: sel.cueIndex, wi: sel.wordIndex };
    if (sel.type === "out" || sel.type === "word") {
      var cue = state.result.cues[sel.index];
      if (!cue) return null;
      var wi;
      if (sel.type === "word") {
        var w = cue.words[sel.wordIndex];
        if (w) wi = w.index;
      }
      return { si: cue.sourceIndex, ci: cue.cueIndex, wi: wi };
    }
    return null;
  }

  function currentSourceIndex() {
    var list = state.doc.sources || [];
    if (state.activeSource >= 0 && state.activeSource < list.length) return state.activeSource;
    return 0;
  }

  function scrollSourceIntoView(ci) {
    var list = state.lists.source;
    if (list) list.scrollToIndex(ci, true);
  }
  function scrollOutIntoView(i) {
    var list = state.lists.out;
    if (list) list.scrollToIndex(i, true);
  }
  function scrollClipIntoView(i) {
    var row = document.querySelector('.clip-row[data-clip="' + i + '"]');
    var host = $("clipList");
    if (!row || !host) return;
    var rt = row.offsetTop, rh = row.offsetHeight;
    if (rt < host.scrollTop || rt + rh > host.scrollTop + host.clientHeight) {
      host.scrollTop = Math.max(0, rt - 8);
    }
  }

  /* ================================================================== *
   * Ledger
   * ================================================================== */

  function renderLedger() {
    var host = $("ledger");
    clear(host);
    var doc = state.doc;
    var result = state.result;
    var srcCount = (doc.sources || []).length;
    var clipCount = (doc.clips || []).length;
    var gapCount = (doc.clips || []).filter(function (c) { return c && c.source === null; }).length;
    var errCount = state.errors.length;
    var warnCount = state.notes.length;
    var outCount = result.cues.length;
    var cueCount = countCues(doc);
    var wordCount = countWords(doc);

    function stat(label, value, sub, cls, onClick, title) {
      var node = el("div", {
        class: "stat" + (cls ? " " + cls : "") + (onClick ? " is-click" : ""),
        attrs: title ? { title: title } : null,
        on: onClick ? { click: onClick } : null
      });
      node.appendChild(el("div", { class: "stat-label", text: label }));
      var v = el("div", { class: "stat-value" });
      v.appendChild(document.createTextNode(value));
      if (sub) v.appendChild(el("small", { text: sub }));
      node.appendChild(v);
      return node;
    }

    host.appendChild(stat("源素材 / 源字幕", srcCount + " / " + cueCount, wordCount ? wordCount + " 词" : "", "", null, "源文件数量与源字幕条数，逐词时间共 " + wordCount + " 个"));
    host.appendChild(stat("片段 / 空白", (clipCount - gapCount) + " / " + gapCount, "", "", null, "剪辑单中的普通片段与空白段"));
    host.appendChild(stat("成片字幕", String(outCount), "", outCount ? "" : "is-warn", function () { switchPane("out"); }, "按规则裁切映射后的字幕条数"));
    var durationLabel = result.duration.d === 1n ? result.duration.n.toString() : fracDecimal(result.duration, 3);
    host.appendChild(stat("成片时长", durationLabel, "ms", "", null, "精确时长 " + fracText(result.duration) + " 毫秒"));
    host.appendChild(stat("问题", errCount ? String(errCount) : "0", errCount ? "个" : "通过", errCount ? "is-bad" : "is-ok", function () { openIssues(); }, "非法区间、零速度、错序词等硬性错误"));
    host.appendChild(stat("提醒", warnCount ? String(warnCount) : "0", warnCount ? "条" : "无", warnCount ? "is-warn" : "", function () { openIssues(); }, "越界或超出建议容量的提醒"));

    var summary = el("div", { class: "ledger-summary" });
    if (errCount) {
      summary.appendChild(el("span", { class: "chip bad", text: "× " + errCount + " 错误" }));
      var first = state.errors[0];
      summary.appendChild(el("span", { text: first.where + " — " + first.message }));
      summary.appendChild(el("button", { class: "btn tiny", attrs: { type: "button" }, text: "逐条定位", on: { click: openIssues } }));
    } else {
      summary.appendChild(el("span", { class: "chip out", text: "✓ 规则校验通过" }));
      summary.appendChild(el("span", { text: "内部以约分分数计算，导出时起点 floor、终点 ceil 到毫秒。" }));
    }
    var over = [];
    if (cueCount > LIMITS.cues) over.push("字幕 " + cueCount + " > 1500");
    if (wordCount > LIMITS.words) over.push("词 " + wordCount + " > 10000");
    if (clipCount > LIMITS.clips) over.push("片段 " + clipCount + " > 500");
    if (over.length) summary.appendChild(el("span", { class: "chip warn", text: over.join(" · ") }));
    var spacer = el("span", { style: "margin-left:auto" });
    summary.appendChild(spacer);
    var exact = el("span", { class: "chip plain", attrs: { title: "成片的精确时长（毫秒，最简分数）" } });
    exact.appendChild(document.createTextNode("时长 "));
    exact.appendChild(el("code", { text: fracText(result.duration) }));
    summary.appendChild(exact);
    host.appendChild(summary);
  }

  /* ================================================================== *
   * Rulers
   * ================================================================== */

  function chooseStep(durNum) {
    var steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
    for (var i = 0; i < steps.length; i++) if (durNum / steps[i] <= 6) return steps[i];
    return steps[steps.length - 1];
  }

  function renderRuler(host, durNum, mode) {
    clear(host);
    if (!(durNum > 0)) return;
    var step = chooseStep(durNum);
    for (var t = 0; t <= durNum + 0.0001; t += step) {
      var tick = el("div", { class: "tick", style: "left:" + (t / durNum) * 100 + "%" });
      tick.appendChild(el("span", { text: uiTime(BigInt(Math.round(t))) }));
      host.appendChild(tick);
    }
  }

  /* ================================================================== *
   * Source pane
   * ================================================================== */

  function renderSourcePane() {
    var tabsHost = $("sourceTabs");
    clear(tabsHost);
    var sources = state.doc.sources || [];
    if (sources.length > 1) {
      sources.forEach(function (s, si) {
        var tab = el("button", {
          class: "tab", attrs: { type: "button", role: "tab", "aria-selected": String(si === currentSourceIndex()) },
          on: { click: function () { state.activeSource = si; renderAll(); } }
        });
        tab.appendChild(document.createTextNode(s && typeof s.id === "string" ? s.id : "源 #" + (si + 1)));
        tab.appendChild(el("span", { class: "n", text: String(s && Array.isArray(s.cues) ? s.cues.length : 0) }));
        tabsHost.appendChild(tab);
      });
      tabsHost.hidden = false;
    } else {
      tabsHost.hidden = true;
    }

    var si = currentSourceIndex();
    var src = sources[si];
    var cues = src && Array.isArray(src.cues) ? src.cues : [];
    var ruler = $("sourceRuler");
    var dur = durOf(src);
    if (dur > 0) {
      renderRuler(ruler, dur, "src");
      renderClipBand(ruler, si, dur);
      ruler.hidden = false;
    } else {
      clear(ruler);
      ruler.hidden = true;
    }

    var list = getList("source", $("sourceList"));
    var srcHost = $("sourceList");
    var srcEmpty = srcHost.querySelector(".empty-state");
    if (srcEmpty) srcEmpty.remove();
    if (!cues.length) {
      list.setItems(0, function () { return 24; }, function () { return el("div"); });
      srcHost.appendChild(el("div", { class: "empty-state" }, [
        el("strong", { text: src ? "这个源没有字幕" : "还没有源素材" }),
        document.createTextNode(src ? "源「" + sourceLabel(si) + "」的 cues 是空的；导入带字幕的 JSON 才会产出成片字幕。" : "导入 JSON（sources + clips）或载入示例开始。也可以把 .json 文件直接拖进页面。")
      ]));
    } else {
      list.setItems(cues.length, function (ci) { return sourceRowHeight(si, ci); }, function (ci) { return sourceRow(si, ci); });
    }

    var foot = $("sourceFoot");
    clear(foot);
    if (!src) {
      foot.appendChild(el("span", { text: "没有源素材 — 导入 JSON 或选择示例。" }));
    } else {
      foot.appendChild(el("span", { text: "源 " + sourceLabel(si) }));
      foot.appendChild(el("span", { class: "sep", text: "·" }));
      foot.appendChild(el("span", { text: cues.length + " 条字幕" }));
      foot.appendChild(el("span", { class: "sep", text: "·" }));
      foot.appendChild(el("span", { text: "时长 " + msUi(dur) }));
      foot.appendChild(el("span", { class: "sep", text: "·" }));
      foot.appendChild(el("span", { text: "区间左闭右开" }));
      var rel = relatedClip();
      if (rel && rel.clip && rel.clip.source === (src && src.id)) {
        foot.appendChild(el("span", { class: "chip clip", text: "高亮 = 片段 " + rel.clip.id + " 的取用范围" }));
      }
    }
  }

  function relatedClip() {
    var sel = state.selection;
    if (!sel) return null;
    if (sel.type === "clip") return { clip: state.doc.clips[sel.index], index: sel.index };
    var idx = sel.type === "out" || sel.type === "word" ? (state.result.cues[sel.index] && state.result.cues[sel.index].clipOrder) : -1;
    if (idx !== undefined && idx >= 0) return { clip: state.doc.clips[idx], index: idx };
    return null;
  }

  function renderClipBand(ruler, si, dur) {
    var rel = relatedClip();
    var src = sourceAt(si);
    if (!rel || !rel.clip || !src || rel.clip.source !== src.id) return;
    var clip = rel.clip;
    if (typeof clip.in !== "number" || typeof clip.out !== "number") return;
    var band = el("div", { class: "range-band", attrs: { title: "片段 " + clip.id + " 在源中的区间 [" + clip.in + ", " + clip.out + ") ms" } });
    band.style.left = Math.max(0, (clip.in / dur) * 100) + "%";
    band.style.width = Math.max(0.4, Math.min(100, ((clip.out - clip.in) / dur) * 100)) + "%";
    ruler.appendChild(band);
  }

  function sourceRowHeight(si, ci) {
    var cue = cueAt(si, ci);
    if (!cue) return 48;
    var chars = 0;
    if (Array.isArray(cue.words) && cue.words.length) {
      cue.words.forEach(function (w) { chars += w && typeof w.text === "string" ? w.text.length + 1 : 0; });
    } else if (typeof cue.text === "string") chars = cue.text.length;
    var lines = Math.max(1, Math.ceil(chars / 26));
    var h = 22 + lines * 19 + 18;
    var ss = sourceSelection();
    var selected = !!ss && ss.si === si && ss.ci === ci;
    if (selected && Array.isArray(cue.words) && cue.words.length) {
      var stripRows = Math.max(1, Math.ceil(cue.words.length / 4));
      h += 6 + stripRows * 21;
    }
    return Math.min(h, 240);
  }

  function wordTitle(w) {
    return (w && typeof w.text === "string" ? w.text : "") + " · " + (typeof w.start === "number" ? w.start : "?") + "–" + (typeof w.end === "number" ? w.end : "?") + " ms";
  }

  function sourceRow(si, ci) {
    var cue = cueAt(si, ci) || {};
    var ss = sourceSelection();
    var selected = !!ss && ss.si === si && ss.ci === ci;
    var selectedWord = selected ? ss.wi : undefined;
    var issue = cueIssueFor(si, ci);
    var row = el("div", {
      class: "src-row" + (selected ? " is-active" : "") + (issue ? " is-bad" : ""),
      data: { ci: ci, si: si },
      attrs: { role: "option", tabindex: "0", "aria-selected": String(!!selected) },
      on: {
        click: function () { selectSourceCue(si, ci); },
        keydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSourceCue(si, ci); } }
      }
    });

    var tc = el("div", { class: "tc" });
    tc.appendChild(el("b", { text: typeof cue.start === "number" ? String(cue.start) : "—" }));
    tc.appendChild(el("span", { text: typeof cue.end === "number" ? String(cue.end) : "—" }));
    row.appendChild(tc);

    var body = el("div", { class: "body" });
    var text = el("div", { class: "text" });
    var usedWords = Array.isArray(cue.words) ? usedWordsFor(si, ci) : new Map();
    if (Array.isArray(cue.words) && cue.words.length) {
      cue.words.forEach(function (w, wi) {
        var used = usedWords.get(wi);
        var isSel = selected && selectedWord === wi;
        text.appendChild(el("span", {
          class: "w" + (used && used.length ? " used" : "") + (isSel ? " sel" : ""),
          text: w && w.text !== undefined ? w.text : "",
          attrs: { title: wordTitle(w) }
        }));
        text.appendChild(document.createTextNode(" "));
      });
    } else {
      text.appendChild(document.createTextNode(typeof cue.text === "string" ? cue.text : ""));
    }
    body.appendChild(text);

    var meta = el("div", { class: "meta" });
    meta.appendChild(el("span", { class: "chip plain", text: typeof cue.id === "string" ? cue.id : "#" + (ci + 1) }));
    if (Array.isArray(cue.words)) meta.appendChild(el("span", { class: "chip", text: cue.words.length + " 词" }));
    var outs = outputsForSourceCue(si, ci);
    if (outs.length) {
      var seen = Object.create(null);
      var clipIds = [];
      outs.forEach(function (oi) {
        var oc = state.result.cues[oi];
        if (!oc || seen[oc.clipOrder]) return;
        seen[oc.clipOrder] = 1;
        clipIds.push(oc.clipId);
      });
      clipIds.slice(0, 3).forEach(function (cid) {
        meta.appendChild(el("span", { class: "chip clip", text: cid }));
      });
      if (clipIds.length > 3) meta.appendChild(el("span", { class: "chip", text: "+" + (clipIds.length - 3) }));
    } else {
      meta.appendChild(el("span", { class: "chip", text: "未入片" }));
    }
    if (issue) meta.appendChild(el("span", { class: "chip bad", text: issue.kind === "order" ? "错序" : issue.level === "warn" ? "提醒" : "非法" }));
    body.appendChild(meta);
    row.appendChild(body);

    if (selected && Array.isArray(cue.words) && cue.words.length) {
      var strip = el("div", { class: "wstrip" });
      cue.words.forEach(function (w, wi) {
        var used = usedWords.get(wi);
        var chip = el("button", {
          class: "wchip" + (selectedWord === wi ? " is-sel" : "") + (used && used.length ? " is-hit" : ""),
          attrs: { type: "button", title: wordTitle(w) + (used && used.length ? " · 出现在 " + used.length + " 条成片字幕" : " · 被剪掉") },
          on: { click: function (e) { e.stopPropagation(); selectSourceCue(si, ci, wi); } }
        });
        chip.appendChild(document.createTextNode(w && typeof w.text === "string" ? w.text : ""));
        chip.appendChild(el("span", { class: "wt", text: typeof w.start === "number" ? String(w.start) : "?" }));
        strip.appendChild(chip);
      });
      row.appendChild(strip);
    }
    return row;
  }

  function cueIssueFor(si, ci) {
    for (var i = 0; i < state.errors.length; i++) {
      var e = state.errors[i];
      if ((e.scope === "cue" || e.scope === "word") && e.sourceIndex === si && e.cueIndex === ci) return e;
    }
    for (var j = 0; j < state.notes.length; j++) {
      var n = state.notes[j];
      if ((n.scope === "cue" || n.scope === "word") && n.sourceIndex === si && n.cueIndex === ci) return n;
    }
    return null;
  }

  /* ================================================================== *
   * Clip pane
   * ================================================================== */

  function renderClipPane() {
    var clips = state.doc.clips || [];
    var timeline = $("clipTimeline");
    clear(timeline);
    if (clips.length) {
      var track = el("div", { class: "otrack", attrs: { "aria-label": "按成片顺序排列的片段" } });
      var duration = state.result.duration;
      var durNum = duration.toNumber();
      var spans = state.result.spans || [];
      spans.forEach(function (sp) {
        var lenNum = sp.length ? sp.length.toNumber() : 0;
        if (!(lenNum > 0)) return;
        var clip = clips[sp.index];
        var seg = el("div", {
          class: "seg" + (clip && clip.source === null ? " gap" : " used") + (sp.index === state.activeClip ? " is-active" : "") + (clipIsBad(sp.index) ? " is-bad" : ""),
          data: { clip: sp.index },
          attrs: { title: (clip && clip.id ? clip.id : "#" + (sp.index + 1)) + " · " + fracDecimal(sp.length, 3) + " ms · 点击选中" }
        });
        seg.style.left = (durNum > 0 ? (sp.start.toNumber() / durNum) * 100 : 0) + "%";
        seg.style.width = Math.max(0.25, durNum > 0 ? (lenNum / durNum) * 100 : 100) + "%";
        seg.addEventListener("click", function () { selectClip(sp.index); });
        track.appendChild(seg);
      });
      timeline.appendChild(track);
      var scale = el("div", { class: "scale" });
      scale.appendChild(el("span", { text: "00:00.000" }));
      scale.appendChild(el("span", { text: "成片 " + fracText(duration) + " ms" }));
      scale.appendChild(el("span", { text: uiTime(duration.ceil()) }));
      timeline.appendChild(scale);
    }

    var host = $("clipList");
    clear(host);
    if (!clips.length) {
      host.appendChild(el("div", { class: "empty-state" }, [
        el("strong", { text: "剪辑单是空的" }),
        document.createTextNode("用「+ 片段」取一段源素材，「+ 空白」插入停顿。片段可以重复使用同一段素材。")
      ]));
    } else {
      clips.forEach(function (clip, index) { host.appendChild(clipRow(clip, index)); });
    }

    var foot = $("clipFoot");
    clear(foot);
    foot.appendChild(el("span", { text: clips.length + " 段" }));
    foot.appendChild(el("span", { class: "sep", text: "·" }));
    foot.appendChild(el("span", { text: state.result.usedClips + " 有效" }));
    if (state.result.skippedClips) {
      foot.appendChild(el("span", { class: "sep", text: "·" }));
      foot.appendChild(el("span", { class: "chip bad", text: state.result.skippedClips + " 跳过" }));
    }
    var tail = el("span", { style: "margin-left:auto", text: "T + (s − in) × q/p" });
    foot.appendChild(tail);
  }

  function clipIsBad(index) {
    return state.errors.some(function (e) { return e.scope === "clip" && e.clipIndex === index; });
  }

  function clipIssue(index) {
    for (var i = 0; i < state.errors.length; i++) if (state.errors[i].scope === "clip" && state.errors[i].clipIndex === index) return state.errors[i];
    for (var j = 0; j < state.notes.length; j++) if (state.notes[j].scope === "clip" && state.notes[j].clipIndex === index) return state.notes[j];
    return null;
  }

  function clipRow(clip, index) {
    var isGap = clip && clip.source === null;
    var row = el("div", {
      class: "clip-row" + (isGap ? " is-gap" : "") + (index === state.activeClip ? " is-active" : "") + (clipIsBad(index) ? " is-bad" : ""),
      data: { clip: index },
      on: { click: function (e) { if (e.target.closest("input,button,select")) return; selectClip(index); } }
    });

    var lead = el("div", { class: "lead" });
    lead.appendChild(el("div", { class: "ord", text: "#" + String(index + 1).padStart(2, "0") }));
    lead.appendChild(el("div", { class: "cid", text: clip && typeof clip.id === "string" ? clip.id : "(无 id)" }));
    var span = state.result.spans && state.result.spans[index];
    lead.appendChild(el("div", { class: "dur", text: span && span.length ? fracApprox(span.length) + " ms" : "—" }));

    var actions = el("div", { class: "actions" });
    [["↑", "上移", -1], ["↓", "下移", 1]].forEach(function (def) {
      var disabled = def[2] < 0 ? index === 0 : index === state.doc.clips.length - 1;
      actions.appendChild(el("button", {
        class: "act", attrs: { type: "button", title: def[1], "aria-label": def[1], disabled: disabled ? "" : null }, text: def[0],
        on: { click: function (e) { e.stopPropagation(); if (!disabled) moveClip(index, def[2]); } }
      }));
    });
    actions.appendChild(el("button", {
      class: "act", attrs: { type: "button", title: "复制这一段（重复使用素材）", "aria-label": "复制片段" }, text: "⧉",
      on: { click: function (e) { e.stopPropagation(); duplicateClip(index); } }
    }));
    actions.appendChild(el("button", {
      class: "act del", attrs: { type: "button", title: "删除", "aria-label": "删除片段" }, text: "✕",
      on: { click: function (e) { e.stopPropagation(); deleteClip(index); } }
    }));
    lead.appendChild(actions);
    row.appendChild(lead);

    var body = el("div", { class: "body" });
    if (isGap) {
      var l1 = el("div", { class: "line" });
      l1.appendChild(el("span", { class: "gap-swatch" }));
      l1.appendChild(el("span", { text: "空白段 · 不产出字幕" }));
      body.appendChild(l1);
      var l2 = el("div", { class: "line" });
      l2.appendChild(el("span", { class: "arr", text: "时长" }));
      l2.appendChild(numberField(clip, "duration_ms", index, "空白时长", "ms"));
      l2.appendChild(el("span", { class: "chip out", text: "推进时间轴" }));
      body.appendChild(l2);
    } else if (!clip || typeof clip.source !== "string") {
      body.appendChild(el("div", { class: "line", text: "缺少 source" }));
    } else {
      var srcSel = el("select", {
        class: "mini-select", attrs: { "aria-label": "源素材" },
        on: { change: function (e) { updateClip(index, { source: e.target.value }, "切换源"); } }
      });
      var sourceMissing = true;
      (state.doc.sources || []).forEach(function (s) {
        if (!s || typeof s.id !== "string") return;
        if (s.id === clip.source) sourceMissing = false;
        srcSel.appendChild(el("option", { text: s.id, attrs: { value: s.id } }));
      });
      if (sourceMissing) srcSel.appendChild(el("option", { text: clip.source + "（缺失）", attrs: { value: clip.source } }));
      srcSel.value = clip.source;

      var line1 = el("div", { class: "line" });
      line1.appendChild(srcSel);
      line1.appendChild(el("span", { class: "arr", text: "[ " }));
      line1.appendChild(numberField(clip, "in", index, "入点", ""));
      line1.appendChild(el("span", { class: "arr", text: " , " }));
      line1.appendChild(numberField(clip, "out", index, "出点", ""));
      line1.appendChild(el("span", { class: "arr", text: " )" }));
      line1.appendChild(el("span", { class: "arr", text: "×" }));
      line1.appendChild(speedField(clip, index));
      body.appendChild(line1);

      var line2 = el("div", { class: "line" });
      var mapped = span && span.valid ? uiTime(span.start.floor()) + " → " + uiTime(span.end.ceil()) : "未生效";
      line2.appendChild(el("span", { class: "arr", text: "成片 " + mapped }));
      line2.appendChild(el("span", { class: "chip out", text: outputsForClip(index).length + " 条" }));
      var iss = clipIssue(index);
      if (iss) line2.appendChild(el("span", { class: "chip " + (iss.level === "warn" ? "warn" : "bad"), text: iss.message }));
      body.appendChild(line2);

      var srco = state.doc.sources.find(function (s) { return s && s.id === clip.source; });
      var sdur = durOf(srco);
      if (sdur > 0 && typeof clip.in === "number" && typeof clip.out === "number") {
        var bar = el("div", { class: "bar", attrs: { title: "取用范围在原素材中的位置" } });
        var fill = el("i", { class: "cut" });
        var left = Math.max(0, Math.min(100, (clip.in / sdur) * 100));
        var width = Math.max(0.2, Math.min(100 - left, ((clip.out - clip.in) / sdur) * 100));
        fill.style.left = left + "%";
        fill.style.width = width + "%";
        bar.appendChild(fill);
        body.appendChild(bar);
      }
    }
    row.appendChild(body);
    return row;
  }

  function numberField(obj, key, index, label, suffix) {
    var val = obj && typeof obj[key] === "number" ? String(obj[key]) : "";
    var input = el("input", {
      class: "mini-num", attrs: { type: "text", inputmode: "numeric", value: val, "aria-label": label + "（毫秒）", title: label + "：整数毫秒，左闭右开" },
      data: { field: key },
      on: {
        change: function () { commitNumber(input, index, key); },
        keydown: function (e) { if (e.key === "Enter") { e.preventDefault(); commitNumber(input, index, key); input.blur(); } }
      }
    });
    if (typeof (obj && obj[key]) !== "number") input.classList.add("is-invalid");
    if (!suffix) return input;
    var wrap = el("span", { class: "num-wrap" });
    wrap.appendChild(input);
    wrap.appendChild(el("span", { class: "suffix", text: suffix }));
    return wrap;
  }

  function commitNumber(input, index, key) {
    var raw = input.value.trim();
    if (!/^-?\d+$/.test(raw)) { input.classList.add("is-invalid"); toast("请输入整数毫秒", true); return; }
    var v = Number(raw);
    if (!Number.isSafeInteger(v)) { input.classList.add("is-invalid"); toast("数字超出安全范围", true); return; }
    updateClip(index, makePatch(key, v), key === "duration_ms" ? "改空白时长" : key === "in" ? "改入点" : "改出点");
    input.classList.remove("is-invalid");
  }

  function makePatch(key, v) { var p = {}; p[key] = v; return p; }

  function speedField(clip, index) {
    var wrap = el("span", { class: "speed-fields" });
    var input = el("input", {
      class: "mini-num speed",
      attrs: { type: "text", value: clip && Array.isArray(clip.speed) ? clip.speed[0] + "/" + clip.speed[1] : "1/1", "aria-label": "速度 p/q", title: "倍速 p/q：源时间以 p/q 倍前进，范围 1/4–4" },
      on: {
        change: function () { commitSpeed(input, index); },
        keydown: function (e) { if (e.key === "Enter") { e.preventDefault(); commitSpeed(input, index); input.blur(); } }
      }
    });
    if (!isValidSpeed(clip && clip.speed)) input.classList.add("is-invalid");
    var ratio = clip && Array.isArray(clip.speed) && clip.speed[1] ? clip.speed[0] / clip.speed[1] : 1;
    var badge = el("span", { class: "ratio " + (ratio > 1.0001 ? "fast" : ratio < 0.9999 ? "slow" : ""), text: (Math.round(ratio * 100) / 100) + "×" });
    wrap.appendChild(input);
    wrap.appendChild(badge);
    return wrap;
  }

  function isValidSpeed(sp) {
    return Array.isArray(sp) && sp.length === 2 &&
      Number.isInteger(sp[0]) && Number.isInteger(sp[1]) &&
      sp[0] > 0 && sp[1] > 0 && sp[0] <= 1000 && sp[1] <= 1000 &&
      sp[0] / sp[1] >= 0.25 && sp[0] / sp[1] <= 4;
  }

  function commitSpeed(input, index) {
    var raw = input.value.trim().replace(/\s+/g, "");
    var m = /^(\d+)\/(\d+)$/.exec(raw);
    if (!m) { input.classList.add("is-invalid"); toast("速度写成 p/q，例如 3/2", true); return; }
    updateClip(index, { speed: [Number(m[1]), Number(m[2])] }, "改速度");
  }

  function updateClip(index, patch, label) {
    // Pin the selection to the clip being edited before the doc changes, so
    // recompute's identity remap cannot land on a different result.
    var clip = state.doc.clips[index];
    if (clip && typeof clip.id === "string") state.selection = { type: "clip", index: index };
    undoable(function () {
      var c = state.doc.clips[index];
      if (!c) return;
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k];
    });
    state.activeClip = index;
    var own = null;
    for (var i = 0; i < state.errors.length; i++) {
      if (state.errors[i].scope === "clip" && state.errors[i].clipIndex === index) { own = state.errors[i]; break; }
    }
    if (own) toast(own.message, true, 2800);
    else toast(label + " · 已重算", false, 1300);
  }

  function moveClip(index, dir) {
    var clips = state.doc.clips;
    var target = index + dir;
    if (target < 0 || target >= clips.length) return;
    // Selection follows the identity that was selected, not position, so
    // reordering a different row does not steal the selection or the scroll.
    var sel = state.selection;
    var keepClipId = sel && sel.type === "clip" && clips[sel.index] ? clips[sel.index].id : null;
    var keepOutId = null, keepWordIndex = null;
    if (sel && (sel.type === "out" || sel.type === "word")) {
      var c = state.result.cues[sel.index];
      if (c) { keepOutId = c.id; keepWordIndex = sel.type === "word" ? sel.wordIndex : null; }
    }
    undoable(function () { var tmp = clips[index]; clips[index] = clips[target]; clips[target] = tmp; });
    if (keepClipId !== null) {
      var ci = -1;
      for (var i = 0; i < clips.length; i++) if (clips[i] && clips[i].id === keepClipId) { ci = i; break; }
      state.selection = ci >= 0 ? { type: "clip", index: ci } : null;
      if (ci >= 0) state.activeClip = ci;
      scrollClipIntoView(ci >= 0 ? ci : target);
    } else if (keepOutId) {
      var ni = state.result.cues.findIndex(function (x) { return x.id === keepOutId; });
      if (ni >= 0) state.selection = keepWordIndex === null ? { type: "out", index: ni } : { type: "word", index: ni, wordIndex: keepWordIndex };
      scrollClipIntoView(target);
    } else {
      scrollClipIntoView(target);
    }
    renderAll();
  }

  function uniqueClipId(base) {
    var used = Object.create(null);
    state.doc.clips.forEach(function (c) { if (c && typeof c.id === "string") used[c.id] = true; });
    var n = 1, id = base + "-" + n;
    while (used[id]) { n++; id = base + "-" + n; }
    return id;
  }

  function duplicateClip(index) {
    var src = state.doc.clips[index];
    if (!src) return;
    var copy = clone(src);
    copy.id = uniqueClipId(String(src.id || "clip"));
    undoable(function () { state.doc.clips.splice(index + 1, 0, copy); });
    selectClip(index + 1);
    toast("已复制为 " + copy.id, false, 1400);
  }

  function deleteClip(index) {
    var clip = state.doc.clips[index];
    if (!clip) return;
    state.selection = null;
    state.activeClip = -1;
    undoable(function () { state.doc.clips.splice(index, 1); });
    toast("已删除片段 " + (clip.id || "#" + (index + 1)), false, 1400);
  }

  function insertClipAt() {
    return state.activeClip >= 0 && state.activeClip < state.doc.clips.length ? state.activeClip + 1 : state.doc.clips.length;
  }

  function addClip(sourceId, inMs, outMs, speed) {
    var clip = { id: uniqueClipId("clip"), source: sourceId, in: inMs, out: outMs, speed: speed };
    var at = insertClipAt();
    undoable(function () { state.doc.clips.splice(at, 0, clip); });
    selectClip(at);
    toast("已添加片段 " + clip.id, false, 1400);
  }

  function addGap(durationMs) {
    var clip = { id: uniqueClipId("gap"), source: null, duration_ms: durationMs };
    var at = insertClipAt();
    undoable(function () { state.doc.clips.splice(at, 0, clip); });
    selectClip(at);
    toast("已添加空白段 " + clip.id, false, 1400);
  }

  /* ================================================================== *
   * Output pane
   * ================================================================== */

  function renderOutPane() {
    var ruler = $("outRuler");
    var dur = state.result.duration.ceil();
    var durNum = Number(dur);
    if (durNum > 0) {
      renderRuler(ruler, durNum, "out");
      var prevEnd = null;
      state.result.cues.forEach(function (c) {
        if (prevEnd !== null && c.start.cmp(prevEnd) < 0) {
          // Mark only the actual overlap: from this cue's start to the
          // earlier cue's end, not the whole cue.
          var overlapEnd = c.end.cmp(prevEnd) < 0 ? c.end : prevEnd;
          var fromMs = Number(c.start.floor());
          var toMs = Number(overlapEnd.ceil());
          var band = el("div", {
            class: "ovl-band",
            attrs: { title: "重叠 " + fracText(c.start) + " → " + fracText(overlapEnd) + " ms（已保留）" }
          });
          band.style.left = (fromMs / durNum) * 100 + "%";
          band.style.width = Math.max(0.25, ((toMs - fromMs) / durNum) * 100) + "%";
          ruler.appendChild(band);
        }
        if (prevEnd === null || c.end.cmp(prevEnd) > 0) prevEnd = c.end;
      });
      ruler.hidden = false;
    } else {
      clear(ruler);
      ruler.hidden = true;
    }

    var cues = state.result.cues;
    var list = getList("out", $("outList"));
    if (!cues.length) {
      list.setItems(0, function () { return 24; }, function () { return el("div"); });
      var outHost = $("outList");
      var prevEmpty = outHost.querySelector(".empty-state");
      if (prevEmpty) prevEmpty.remove();
      var why, detail;
      if (!state.doc.clips.length) {
        why = "剪辑单是空的";
        detail = "成片字幕由片段裁切而来：先在「剪辑单」里加入片段或空白段。";
      } else if (state.errors.length) {
        why = "暂时没有可用字幕";
        detail = "当前有 " + state.errors.length + " 个问题导致片段被跳过；在下方「问题」里逐条定位修正。";
      } else {
        why = "片段里没有字幕";
        detail = "现有片段的区间没有与任何源字幕相交，或字幕的词全被剪掉。调整入出点或换一段素材试试。";
      }
      outHost.appendChild(el("div", { class: "empty-state" }, [el("strong", { text: why }), document.createTextNode(detail)]));
    } else {
      var staleOut = $("outList").querySelector(".empty-state");
      if (staleOut) staleOut.remove();
      list.setItems(cues.length, function (i) { return outRowHeight(i); }, function (i) { return outRow(i); });
    }

    var foot = $("outFoot");
    clear(foot);
    foot.appendChild(el("span", { text: cues.length + " 条" }));
    foot.appendChild(el("span", { class: "sep", text: "·" }));
    foot.appendChild(el("span", { text: "时长 " + fracApprox(state.result.duration) }));
    var overlaps = state.result.overlapCount || 0;
    if (overlaps) {
      foot.appendChild(el("span", { class: "sep", text: "·" }));
      foot.appendChild(el("span", { class: "chip warn", text: overlaps + " 条重叠（保留）" }));
    }
    foot.appendChild(el("span", { style: "margin-left:auto", text: "VTT: 起点 floor / 终点 ceil" }));
  }

  function outRowHeight(i) {
    var cue = state.result.cues[i];
    if (!cue) return 60;
    var chars = 0;
    if (cue.hasWords) cue.words.forEach(function (w) { chars += (w.text || "").length + 1; });
    else chars = (cue.text || "").length;
    var lines = Math.max(1, Math.ceil(chars / 27));
    return 22 + lines * 19 + 20;
  }

  function outRow(i) {
    var cue = state.result.cues[i];
    if (!cue) return el("div");
    var sel = state.selection;
    var active = sel && (sel.type === "out" || sel.type === "word") && sel.index === i;
    var row = el("div", {
      class: "out-row" + (active ? " is-active" : "") + (cue.overlapsEarlier ? " is-overlap" : ""),
      data: { i: i }, attrs: { role: "option", tabindex: "0", "aria-selected": String(!!active) },
      on: {
        click: function () { selectOut(i); },
        keydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectOut(i); } }
      }
    });
    var tc = el("div", { class: "tc" });
    tc.appendChild(el("b", { text: floorUi(cue.start) }));
    tc.appendChild(el("span", { text: ceilUi(cue.end) }));
    row.appendChild(tc);

    var body = el("div", { class: "body" });
    var text = el("div", { class: "text" });
    if (cue.hasWords) {
      var focusWord = sel && sel.index === i && (sel.type === "word" ? sel.wordIndex : 0);
      cue.words.forEach(function (w, wi) {
        var isSel = focusWord !== undefined && focusWord !== null && focusWord === wi;
        text.appendChild(el("span", {
          class: "w" + (isSel ? " sel" : ""),
          text: w.text,
          attrs: { title: w.text + " · 成片 " + fracText(w.start) + "–" + fracText(w.end) + " ms" },
          on: { click: function (e) { e.stopPropagation(); selectOut(i, wi); } }
        }));
        text.appendChild(document.createTextNode(" "));
      });
    } else {
      text.appendChild(document.createTextNode(cue.text));
    }
    body.appendChild(text);

    var sub = el("div", { class: "sub" });
    sub.appendChild(el("span", { class: "chip src", text: cue.sourceId }));
    sub.appendChild(el("span", { class: "chip clip", text: cue.clipId }));
    sub.appendChild(el("span", { text: cue.hasWords ? "词级" : "整句" }));
    if (cue.overlapsEarlier) sub.appendChild(el("span", { class: "ovflag", text: "重叠" }));
    body.appendChild(sub);
    row.appendChild(body);
    return row;
  }

  /* ================================================================== *
   * Trace rail
   * ================================================================== */

  function renderTrace() {
    var host = $("trace");
    clear(host);

    var head = el("div", { class: "trace-head" });
    head.appendChild(el("span", { class: "eyebrow", text: "LINK" }));
    head.appendChild(el("button", {
      class: "trace-tab" + (state.traceTab === "trace" ? " is-on" : ""),
      attrs: { type: "button" }, text: "追溯链路",
      on: { click: function () { state.traceTab = "trace"; renderTrace(); } }
    }));
    head.appendChild(el("button", {
      class: "trace-tab" + (state.traceTab === "issues" ? " is-on" : ""),
      attrs: { type: "button" },
      text: "问题 " + state.errors.length + (state.notes.length ? " · 提醒 " + state.notes.length : ""),
      on: { click: function () { state.traceTab = "issues"; renderTrace(); } }
    }));
    if (state.traceTab === "trace") head.appendChild(el("span", { class: "hint", text: selectionHint() }));
    else head.appendChild(el("span", { class: "hint", text: "点击任意一条定位到输入" }));
    host.appendChild(head);

    var body = el("div", { class: "trace-body" });
    if (state.traceTab === "issues") {
      body.appendChild(issuesBody());
      host.appendChild(body);
      return;
    }

    var sel = state.selection;
    if (!sel) {
      body.appendChild(el("div", { class: "notice" }, [
        el("span", { class: "nk", text: "提示" }),
        document.createTextNode("点选成片字幕、源字幕或片段，这里显示从源词到成片的完整链路和精确分数。")
      ]));
      host.appendChild(body);
      return;
    }

    if (sel.type === "out" || sel.type === "word") {
      var cue = state.result.cues[sel.index];
      if (cue) body.appendChild(outputChain(cue, sel.type === "word" ? sel.wordIndex : undefined));
    } else if (sel.type === "clip") {
      body.appendChild(clipChain(sel.index));
    } else if (sel.type === "src") {
      body.appendChild(sourceChain(sel.sourceIndex, sel.cueIndex, sel.wordIndex));
    }
    host.appendChild(body);
  }

  function selectionHint() {
    var sel = state.selection;
    if (!sel) return "联动三个面板";
    if (sel.type === "clip") {
      var c = state.doc.clips[sel.index];
      return "片段 " + (c && c.id ? c.id : "#" + (sel.index + 1)) + " 的取用与产出";
    }
    if (sel.type === "src") return "源字幕 " + cueLabel(sel.sourceIndex, sel.cueIndex) + " 的去向";
    return "成片 → 片段 → 源字幕 → 源词";
  }

  function chainNode(kind, key, title, rows, extra) {
    var n = el("div", { class: "chain-node " + kind });
    n.appendChild(el("div", { class: "cn-k", text: key }));
    n.appendChild(el("div", { class: "cn-t", text: title, attrs: { title: title } }));
    (rows || []).forEach(function (r) { if (r !== null && r !== undefined) n.appendChild(el("div", { class: "cn-d", text: r })); });
    if (extra) n.appendChild(extra);
    return n;
  }

  function fracLine(label, f) {
    var d = el("div", { class: "cn-frac" });
    d.appendChild(document.createTextNode(label + " "));
    d.appendChild(el("code", { text: fracText(f) }));
    d.appendChild(document.createTextNode(" ms"));
    return d;
  }

  function outputChain(cue, wordIndex) {
    var chain = el("div", { class: "chain" });

    var outNode = chainNode("out", "成片字幕", cue.id, [
      floorUi(cue.start) + " → " + ceilUi(cue.end) + "  (VTT)",
      "精确 " + fracText(cue.start) + " → " + fracText(cue.end) + " ms"
    ]);
    outNode.appendChild(el("div", { class: "cn-txt", text: cue.text || "(空)" }));
    chain.appendChild(outNode);

    var clip = state.doc.clips[cue.clipOrder] || {};
    var len = E.clipOutputLength(clip);
    chain.appendChild(chainNode("clip", "片段", String(cue.clipId), [
      "源 " + cue.sourceId + "  [" + cue.clipIn + ", " + cue.clipOut + ") ms",
      "速度 " + cue.speedP + "/" + cue.speedQ + " · 片段长 " + (len ? fracText(len) : "?") + " ms",
      "映射 T + (s − " + cue.clipIn + ") × " + cue.speedQ + "/" + cue.speedP
    ]));

    var srcCue = cueAt(cue.sourceIndex, cue.cueIndex);
    var srcNode = chainNode("src", "源字幕", cue.cueId, [
      sourceLabel(cue.sourceIndex) + "  [" + cue.cueStart + ", " + cue.cueEnd + ") ms",
      "与片段交集 [" + cue.cutStart + ", " + cue.cutEnd + ") ms",
      cue.hasWords ? "保留 " + cue.words.length + " 个词" : "整句文本（无逐词时间）"
    ]);
    if (srcCue) srcNode.appendChild(el("div", { class: "cn-txt", text: srcCue.text || "" }));
    chain.appendChild(srcNode);

    if (cue.hasWords) {
      // Selecting a result already lands on its first kept word, so the chain
      // is complete without a second click; the chips switch between words.
      var chosen = wordIndex !== undefined ? wordIndex : 0;
      var word = cue.words[chosen] || cue.words[0];
      var wordNode = el("div", { class: "chain-node word" });
      wordNode.appendChild(el("div", { class: "cn-k", text: "源词" + (cue.words.length > 1 ? " " + (chosen + 1) + "/" + cue.words.length : "") }));
      if (word) {
        wordNode.appendChild(el("div", { class: "cn-t", text: word.text, attrs: { title: word.text } }));
        wordNode.appendChild(el("div", { class: "cn-d", text: "源 " + word.srcStart + "–" + word.srcEnd + " ms" }));
        wordNode.appendChild(el("div", { class: "cn-d", text: "裁到片段 " + word.cutStart + "–" + word.cutEnd + " ms" }));
        wordNode.appendChild(fracLine("成片起", word.start));
        wordNode.appendChild(fracLine("成片止", word.end));
      }
      if (cue.words.length > 1) {
        var picks = el("div", { class: "word-picks" });
        cue.words.slice(0, 16).forEach(function (w, wi) {
          picks.appendChild(el("button", {
            class: "wchip" + (wi === chosen ? " is-sel" : ""),
            attrs: { type: "button", title: w.srcStart + "–" + w.srcEnd + " ms → " + fracText(w.start) + " ms" },
            text: w.text,
            on: { click: function () { selectOut(state.selection.index, wi); } }
          }));
        });
        if (cue.words.length > 16) picks.appendChild(el("span", { class: "cn-d", text: "…另 " + (cue.words.length - 16) + " 个" }));
        wordNode.appendChild(picks);
      }
      chain.appendChild(wordNode);
    }
    return chain;
  }

  function clipChain(index) {
    var chain = el("div", { class: "chain" });
    var clip = state.doc.clips[index];
    if (!clip) return chain;
    var span = state.result.spans && state.result.spans[index];
    if (clip.source === null) {
      chain.appendChild(chainNode("clip", "空白段", String(clip.id), [
        "时长 " + (typeof clip.duration_ms === "number" ? clip.duration_ms : "?") + " ms",
        "成片 " + (span && span.valid ? uiTime(span.start.floor()) + " → " + uiTime(span.end.ceil()) : "未生效"),
        "不产出字幕，只推进时间轴"
      ]));
      return chain;
    }
    var len = E.clipOutputLength(clip);
    chain.appendChild(chainNode("clip", "片段", String(clip.id), [
      "源 " + clip.source + "  [" + clip.in + ", " + clip.out + ") ms",
      "速度 " + clip.speed[0] + "/" + clip.speed[1] + " · 源长 " + (clip.out - clip.in) + " ms",
      "成片长 " + (len ? fracText(len) : "?") + " ms"
    ]));
    if (span && span.valid) {
      chain.appendChild(chainNode("out", "成片位置", uiTime(span.start.floor()) + " → " + uiTime(span.end.ceil()),
        ["精确 " + fracText(span.start) + " → " + fracText(span.end) + " ms"]));
    }
    var ids = outputsForClip(index);
    var listNode = el("div", { class: "chain-node out" });
    listNode.appendChild(el("div", { class: "cn-k", text: "产出字幕" }));
    listNode.appendChild(el("div", { class: "cn-t", text: ids.length + " 条" }));
    if (!ids.length) {
      listNode.appendChild(el("div", { class: "cn-d", text: "这个区间里没有字幕——可能落在停顿上。" }));
    } else {
      var picks = el("div", { class: "word-picks" });
      ids.slice(0, 12).forEach(function (oi) {
        var oc = state.result.cues[oi];
        picks.appendChild(el("button", {
          class: "wchip", attrs: { type: "button", title: floorUi(oc.start) + " → " + ceilUi(oc.end) },
          text: oc.id,
          on: { click: function () { selectOut(oi); } }
        }));
      });
      if (ids.length > 12) picks.appendChild(el("span", { class: "cn-d", text: "…另 " + (ids.length - 12) + " 条" }));
      listNode.appendChild(picks);
    }
    chain.appendChild(listNode);
    return chain;
  }

  function sourceChain(si, ci, wi) {
    var chain = el("div", { class: "chain" });
    var cue = cueAt(si, ci);
    if (!cue) return chain;
    var srcNode = chainNode("src", "源字幕", cue.id || "#" + (ci + 1), [
      sourceLabel(si) + "  [" + (typeof cue.start === "number" ? cue.start : "?") + ", " + (typeof cue.end === "number" ? cue.end : "?") + ") ms",
      Array.isArray(cue.words) ? cue.words.length + " 个词" : "无逐词时间"
    ]);
    srcNode.appendChild(el("div", { class: "cn-txt", text: cue.text || "" }));
    chain.appendChild(srcNode);

    if (wi !== undefined && Array.isArray(cue.words) && cue.words[wi]) {
      var w = cue.words[wi];
      chain.appendChild(chainNode("word", "源词", w.text, ["源 " + w.start + "–" + w.end + " ms"]));
    }

    var ids = outputsForSourceCue(si, ci);
    var listNode = el("div", { class: "chain-node out" });
    listNode.appendChild(el("div", { class: "cn-k", text: "去向" }));
    if (!ids.length) {
      listNode.appendChild(el("div", { class: "cn-d", text: "没有任何片段取用这条字幕。" }));
    } else {
      listNode.appendChild(el("div", { class: "cn-t", text: ids.length + " 条成片字幕" }));
      var picks = el("div", { class: "word-picks" });
      ids.slice(0, 12).forEach(function (oi) {
        var oc = state.result.cues[oi];
        picks.appendChild(el("button", {
          class: "wchip", attrs: { type: "button", title: oc.clipId + " · " + floorUi(oc.start) },
          text: oc.id,
          on: { click: function () { selectOut(oi); } }
        }));
      });
      if (ids.length > 12) picks.appendChild(el("span", { class: "cn-d", text: "…另 " + (ids.length - 12) + " 条" }));
      listNode.appendChild(picks);
    }
    chain.appendChild(listNode);
    return chain;
  }

  /* ================================================================== *
   * Issues
   * ================================================================== */

  function issuesBody() {
    var wrap = document.createDocumentFragment();
    var all = state.errors.concat(state.notes);
    if (!all.length) {
      wrap.appendChild(el("div", { class: "issues-empty" }, [
        el("span", { class: "tick", text: "✓" }),
        document.createTextNode("没有发现问题：区间合法、速度在范围内、词序正确。")
      ]));
      return wrap;
    }
    var list = el("div", { class: "issues" });
    var show = all.slice(0, 200);
    show.forEach(function (iss) {
      var btn = el("button", {
        class: "issue" + (iss.level === "warn" ? " warn" : ""),
        attrs: { type: "button", title: "定位到 " + iss.path },
        on: { click: function () { gotoIssue(iss); } }
      });
      btn.appendChild(el("span", { class: "mk", text: iss.level === "warn" ? "!" : "×" }));
      var msg = el("span", { class: "msg" });
      msg.appendChild(el("span", { class: "where", text: iss.where || "" }));
      msg.appendChild(el("span", { class: "what", text: iss.message }));
      btn.appendChild(msg);
      btn.appendChild(el("span", { class: "path", text: iss.path }));
      list.appendChild(btn);
    });
    wrap.appendChild(list);
    if (all.length > show.length) {
      wrap.appendChild(el("div", { class: "notice", text: "还有 " + (all.length - show.length) + " 条未列出；修正前面的条目会继续显示。" }));
    }
    return wrap;
  }

  function openIssues() {
    state.traceTab = "issues";
    renderTrace();
    var trace = $("trace");
    if (trace.scrollIntoView) trace.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function gotoIssue(iss) {
    if (iss.scope === "doc") {
      toast(iss.where + "：" + iss.message, true, 3200);
      return;
    }
    if (iss.scope === "source") {
      if (iss.sourceIndex !== undefined) { state.activeSource = iss.sourceIndex; }
      state.traceTab = "issues";
      renderAll();
      toast(iss.where + "：" + iss.message, true, 3200);
      return;
    }
    // Jump to the input, then keep the issue list in place so the next entry
    // is one click away.
    if (iss.scope === "clip") {
      selectClip(iss.clipIndex);
      focusClipField(iss.clipIndex, iss.path);
      state.traceTab = "issues";
      renderTrace();
      return;
    }
    if (iss.scope === "cue" || iss.scope === "word") {
      state.activeSource = iss.sourceIndex;
      selectSourceCue(iss.sourceIndex, iss.cueIndex, iss.scope === "word" ? iss.wordIndex : undefined);
      flashSourceRow(iss.cueIndex, iss.scope === "word" ? iss.wordIndex : null);
      state.traceTab = "issues";
      renderTrace();
    }
  }

  function focusClipField(index, path) {
    var row = document.querySelector('.clip-row[data-clip="' + index + '"]');
    if (!row) return;
    scrollClipIntoView(index);
    var field = null;
    if (/\.in$/.test(path)) field = row.querySelector('[data-field="in"]');
    else if (/\.out$/.test(path)) field = row.querySelector('[data-field="out"]');
    else if (/\.duration_ms$/.test(path)) field = row.querySelector('[data-field="duration_ms"]');
    else if (/\.speed$/.test(path)) field = row.querySelector("input.speed");
    if (field) { field.focus(); if (field.select) field.select(); }
    row.classList.add("is-flash");
    setTimeout(function () { row.classList.remove("is-flash"); }, 1400);
  }

  function flashSourceRow(ci, wi) {
    setTimeout(function () {
      var row = document.querySelector('.src-row[data-ci="' + ci + '"]');
      if (!row) return;
      var host = $("sourceList");
      var rt = row.offsetTop, rh = row.offsetHeight;
      if (rt < host.scrollTop || rt + rh > host.scrollTop + host.clientHeight) host.scrollTop = Math.max(0, rt - 8);
      row.classList.add("is-flash");
      var chips = row.querySelectorAll(".wchip");
      if (wi !== null && wi !== undefined && chips[wi]) chips[wi].classList.add("is-flash");
      setTimeout(function () { row.classList.remove("is-flash"); }, 1500);
    }, 80);
  }

  /* ================================================================== *
   * Lists
   * ================================================================== */

  function ListView(host) {
    var spacer = el("div", { class: "vspacer" });
    host.appendChild(spacer);
    var count = 0, heightFn = null, renderFn = null;
    var offsets = null, heights = null, virtual = false;
    var lastKey = "";
    var self = {};

    function rebuild() {
      offsets = new Float64Array(count + 1);
      heights = new Float64Array(count);
      var acc = 0;
      for (var i = 0; i < count; i++) {
        var h = Math.max(24, heightFn(i) || 48);
        heights[i] = h;
        offsets[i] = acc;
        acc += h;
      }
      offsets[count] = acc;
      if (virtual) spacer.style.height = acc + "px";
      else spacer.style.height = "auto";
      lastKey = "";
    }

    function indexAt(y) {
      var lo = 0, hi = count - 1, ans = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (offsets[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    function draw() {
      if (!count) { clear(spacer); return; }
      if (!virtual) {
        var key = "all";
        if (key === lastKey && spacer.childElementCount === count) return;
        lastKey = key;
        clear(spacer);
        for (var i = 0; i < count; i++) spacer.appendChild(renderFn(i));
        return;
      }
      var top = host.scrollTop;
      var vh = host.clientHeight || 420;
      var start = Math.max(0, indexAt(top) - 4);
      var end = Math.min(count, indexAt(top + vh) + 5);
      var key = start + ":" + end;
      if (key === lastKey) return;
      lastKey = key;
      clear(spacer);
      for (var j = start; j < end; j++) {
        var node = renderFn(j);
        node.style.position = "absolute";
        node.style.top = offsets[j] + "px";
        node.style.left = "0";
        node.style.right = "0";
        node.style.height = heights[j] + "px";
        spacer.appendChild(node);
      }
    }

    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; draw(); });
    }
    host.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    self.setItems = function (n, hf, rf) {
      var nextVirtual = n > NATURAL_LIMIT;
      if (nextVirtual !== virtual) { virtual = nextVirtual; lastKey = ""; }
      var prevCount = count;
      count = n; heightFn = hf; renderFn = rf;
      rebuild();
      // Keep the reader's place across edits; only clamp when the list shrank
      // past the current scroll position.
      var maxTop = Math.max(0, (virtual ? offsets[count] : host.scrollHeight) - host.clientHeight);
      if (prevCount !== n && host.scrollTop > maxTop) host.scrollTop = maxTop;
      draw();
    };
    // Scroll only this list's own scroll box. scrollIntoView would also
    // scroll the page, which yanks the workspace away on narrow screens.
    function revealInHost(top, h, center) {
      var vh = host.clientHeight || 420;
      if (top < host.scrollTop || top + h > host.scrollTop + vh) {
        host.scrollTop = center ? Math.max(0, top - vh / 2 + h / 2) : Math.max(0, top - 8);
      }
    }

    self.scrollToIndex = function (idx, center) {
      if (!count) return;
      idx = Math.max(0, Math.min(count - 1, idx));
      if (!virtual) {
        revealInHost(offsets[idx], heights[idx] || 48, center);
        return;
      }
      var top = offsets[idx];
      var h = heights[idx] || 48;
      var vh = host.clientHeight || 420;
      if (top < host.scrollTop || top + h > host.scrollTop + vh) {
        host.scrollTop = center ? Math.max(0, top - vh / 2 + h / 2) : Math.max(0, top - 8);
      }
      draw();
    };
    self.refresh = function () { rebuild(); draw(); };
    return self;
  }

  function getList(key, host) {
    if (!state.lists[key]) state.lists[key] = ListView(host);
    return state.lists[key];
  }

  /* ================================================================== *
   * Render all / pane switch
   * ================================================================== */

  function renderAll() {
    renderLedger();
    renderSourcePane();
    renderClipPane();
    renderOutPane();
    renderTrace();
    updateUndoButtons();
  }

  function switchPane(name) {
    $("app").dataset.pane = name;
    document.querySelectorAll(".pane-switch button").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.goto === name));
    });
    var panel = document.querySelector('.panel[data-pane="' + name + '"]');
    if (panel && window.matchMedia("(max-width: 860px)").matches) {
      // On narrow screens the swapped-in panel should sit at the top of the
      // viewport instead of staying below the ledger.
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ================================================================== *
   * Export
   * ================================================================== */

  function buildExports() {
    return {
      vtt: E.toWebVTT(state.result),
      json: JSON.stringify(E.toJSON(state.result), null, 2),
      doc: JSON.stringify(state.doc, null, 2)
    };
  }

  function openExport() {
    var data = buildExports();
    var modal = $("modal");
    clear(modal);
    var head = el("div", { class: "modal-head" });
    head.appendChild(el("h2", { text: "导出", attrs: { id: "modalTitle" } }));
    head.appendChild(el("span", { class: "sub", text: state.result.cues.length + " 条 · 时长 " + fracText(state.result.duration) + " ms" }));
    head.appendChild(el("button", { class: "x", attrs: { type: "button", "aria-label": "关闭" }, text: "✕", on: { click: closeModal } }));
    modal.appendChild(head);

    if (state.errors.length) {
      var banner = el("div", { class: "modal-warn" }, [
        el("strong", { text: "当前文档有 " + state.errors.length + " 个问题" }),
        document.createTextNode("导出的内容按「容错预览」生成：有问题的片段或字幕已被跳过，可能不满足包内规则。修正后再导出更稳妥。")
      ]);
      modal.appendChild(banner);
    }
    var tabs = el("div", { class: "modal-tabs", attrs: { role: "tablist" } });
    modal.appendChild(tabs);
    var body = el("div", { class: "modal-body" });
    modal.appendChild(body);
    var foot = el("div", { class: "modal-foot" });
    var note = el("span", { class: "note" });
    var selectBtn = el("button", { class: "btn", attrs: { type: "button" }, text: "全选" });
    var copyBtn = el("button", { class: "btn primary", attrs: { type: "button" }, text: "复制全文" });
    foot.appendChild(note);
    foot.appendChild(el("span", { style: "margin-left:auto" }));
    foot.appendChild(selectBtn);
    foot.appendChild(copyBtn);
    foot.appendChild(el("button", { class: "btn ghost", attrs: { type: "button" }, text: "关闭", on: { click: closeModal } }));
    modal.appendChild(foot);

    var defs = [
      { key: "vtt", label: "WebVTT", text: data.vtt, desc: "起点 floor 毫秒、终点 ceil 毫秒，保留重叠。" },
      { key: "json", label: "JSON · 精确时间", text: data.json, desc: "分数 [分子, 分母]，id 为「片段:字幕」，clip_order 标明片段顺序。" },
      { key: "doc", label: "剪辑单", text: data.doc, desc: "当前的 sources + clips，可再次导入。" }
    ];

    function renderTab(key) {
      clear(tabs);
      defs.forEach(function (t) {
        tabs.appendChild(el("button", {
          class: "modal-tab", attrs: { type: "button", role: "tab", "aria-selected": String(t.key === key) },
          text: t.label,
          on: { click: function () { renderTab(t.key); } }
        }));
      });
      clear(body);
      var def = null;
      defs.forEach(function (t) { if (t.key === key) def = t; });
      var bytes = new Blob([def.text]).size;
      var previewCap = 400000;
      var shown = bytes > previewCap * 2 ? def.text.slice(0, previewCap) : def.text;
      var ta = el("textarea", { attrs: { readonly: "", spellcheck: "false", "aria-label": def.label } });
      ta.value = shown;
      body.appendChild(ta);
      if (shown.length < def.text.length) {
        body.appendChild(el("p", {
          class: "modal-note",
          text: "文件共 " + fmtBytes(bytes) + "，预览只显示前 " + fmtBytes(previewCap) + "。「复制全文」会复制完整内容（" + def.text.length.toLocaleString("en-US") + " 字符），复制可能需要几秒。"
        }));
      }
      note.textContent = def.desc + " · " + fmtBytes(bytes);
      var truncated = shown.length < def.text.length;
      selectBtn.disabled = truncated;
      selectBtn.title = truncated ? "预览被截断，请用「复制全文」" : "";
      selectBtn.onclick = function () { ta.focus(); ta.select(); };
      copyBtn.onclick = function () { copyText(def.text, copyBtn); };
    }
    renderTab("vtt");
    openModal();
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!ok) { toast("浏览器拒绝写入剪贴板，请点「全选」后手动复制", true, 3200); return; }
      var old = btn.textContent;
      btn.textContent = "已复制";
      toast("已复制全文", false, 1500);
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) { done(false); return; }
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
  }

  /* ================================================================== *
   * Modals
   * ================================================================== */

  function openModal() {
    $("scrim").hidden = false;
    $("modal").hidden = false;
  }
  function closeModal() {
    $("scrim").hidden = true;
    $("modal").hidden = true;
    clear($("modal"));
  }

  function modalShell(title, sub, description) {
    var modal = $("modal");
    clear(modal);
    var head = el("div", { class: "modal-head" });
    head.appendChild(el("h2", { text: title, attrs: { id: "modalTitle" } }));
    if (sub) head.appendChild(el("span", { class: "sub", text: sub }));
    head.appendChild(el("button", { class: "x", attrs: { type: "button", "aria-label": "关闭" }, text: "✕", on: { click: closeModal } }));
    modal.appendChild(head);
    var body = el("div", { class: "modal-body" });
    if (description) body.appendChild(el("p", { class: "modal-note", text: description }));
    modal.appendChild(body);
    var foot = el("div", { class: "modal-foot" });
    modal.appendChild(foot);
    return { modal: modal, body: body, head: head, footBar: foot };
  }

  function field(label, control) {
    var f = el("div", { class: "field" });
    f.appendChild(el("label", { text: label }));
    f.appendChild(control);
    return f;
  }

  function openPaste() {
    var shell = modalShell("粘贴 JSON", "sources + clips", "支持多个源、空白段与 [p, q] 有理数速度。示例格式见「规则」。");
    var ta = el("textarea", { attrs: { placeholder: '{\n  "sources": [ ... ],\n  "clips": [ ... ]\n}', spellcheck: "false", "aria-label": "JSON 文本" } });
    shell.body.appendChild(ta);
    shell.footBar.appendChild(el("span", { class: "note", text: "区间左闭右开，源时间一律整数毫秒。" }));
    shell.footBar.appendChild(el("span", { style: "margin-left:auto" }));
    shell.footBar.appendChild(el("button", { class: "btn ghost", attrs: { type: "button" }, text: "取消", on: { click: closeModal } }));
    shell.footBar.appendChild(el("button", {
      class: "btn primary", attrs: { type: "button" }, text: "载入",
      on: { click: function () {
        var raw;
        try { raw = JSON.parse(ta.value); } catch (e) { toast("JSON 解析失败：" + e.message, true, 3200); return; }
        closeModal();
        loadDoc(raw, "粘贴.json");
      } }
    }));
    openModal();
    setTimeout(function () { ta.focus(); }, 30);
  }

  function openAddClip() {
    if (!state.doc.sources.length) { toast("先导入至少一个源素材", true); return; }
    var srcIdx = currentSourceIndex();
    var src = sourceAt(srcIdx);
    var dur = durOf(src);
    var selCue = null;
    if (state.selection && state.selection.type === "src" && state.selection.sourceIndex === srcIdx) selCue = cueAt(srcIdx, state.selection.cueIndex);
    var defIn = selCue && typeof selCue.start === "number" ? selCue.start : 0;
    var defOut = selCue && typeof selCue.end === "number" ? selCue.end : Math.min(dur, Math.max(1000, Math.round(dur / 2)));

    var shell = modalShell("新建片段", state.activeClip >= 0 ? "插入到片段 #" + (state.activeClip + 1) + " 之后" : "追加到末尾");
    var grid = el("div", { class: "form-grid" });
    var srcSel = el("select", { attrs: { "aria-label": "源素材" } });
    state.doc.sources.forEach(function (s) {
      if (s && typeof s.id === "string") srcSel.appendChild(el("option", { text: s.id, attrs: { value: s.id } }));
    });
    if (src) srcSel.value = src.id;
    var inInput = el("input", { attrs: { type: "number", step: "1", min: "0", value: String(defIn), "aria-label": "入点（毫秒）" } });
    var outInput = el("input", { attrs: { type: "number", step: "1", min: "1", value: String(defOut), "aria-label": "出点（毫秒）" } });
    var spInput = el("input", { attrs: { type: "text", value: "1/1", placeholder: "3/2", "aria-label": "速度 p/q" } });
    grid.appendChild(field("源素材", srcSel));
    grid.appendChild(field("速度 p/q（1/4–4）", spInput));
    grid.appendChild(field("入点（毫秒，含）", inInput));
    grid.appendChild(field("出点（毫秒，不含）", outInput));
    shell.body.appendChild(grid);
    shell.body.appendChild(el("p", { class: "modal-note", text: "源 " + (src ? src.id : "?") + " 时长 " + dur + " ms；片段产出时长 =（出点 − 入点）× q / p。" }));
    shell.footBar.appendChild(el("span", { style: "margin-left:auto" }));
    shell.footBar.appendChild(el("button", { class: "btn ghost", attrs: { type: "button" }, text: "取消", on: { click: closeModal } }));
    shell.footBar.appendChild(el("button", {
      class: "btn primary", attrs: { type: "button" }, text: "添加",
      on: { click: function () {
        var p = parseInt(inInput.value, 10), o = parseInt(outInput.value, 10);
        var m = /^(\d+)\s*\/\s*(\d+)$/.exec(spInput.value.trim());
        if (!m) { toast("速度写成 p/q，例如 3/2", true); return; }
        var sp = [Number(m[1]), Number(m[2])];
        if (!Number.isInteger(p) || !Number.isInteger(o)) { toast("入点与出点必须是整数毫秒", true); return; }
        if (p < 0 || o <= p) { toast("片段区间长度必须为正", true); return; }
        if (sp[0] === 0 || sp[1] === 0) { toast("速度不能为零", true); return; }
        closeModal();
        addClip(srcSel.value, p, o, sp);
      } }
    }));
    openModal();
    setTimeout(function () { inInput.focus(); inInput.select(); }, 30);
  }

  function openAddGap() {
    var shell = modalShell("新建空白段", "成片里没有源素材的一段");
    var input = el("input", { attrs: { type: "number", step: "1", min: "0", value: "500", "aria-label": "空白时长（毫秒）" }, style: "width:100%;padding:8px;border:1px solid var(--line);border-radius:5px;background:var(--bg);font-family:var(--mono)" });
    var f = field("时长（毫秒）", input);
    shell.body.appendChild(f);
    shell.body.appendChild(el("p", { class: "modal-note", text: "空白段不产出字幕，只把后面的时间轴往后推。它可以为 0，也可以插在任意两个片段之间。" }));
    shell.footBar.appendChild(el("span", { style: "margin-left:auto" }));
    shell.footBar.appendChild(el("button", { class: "btn ghost", attrs: { type: "button" }, text: "取消", on: { click: closeModal } }));
    shell.footBar.appendChild(el("button", {
      class: "btn primary", attrs: { type: "button" }, text: "添加",
      on: { click: function () {
        var d = parseInt(input.value, 10);
        if (!Number.isInteger(d) || d < 0) { toast("时长必须是大于或等于 0 的整数毫秒", true); return; }
        closeModal();
        addGap(d);
      } }
    }));
    openModal();
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }

  function openRules() {
    var shell = modalShell("重排规则", "来自样例包 说明.md", null);
    var rules = [
      ["区间", "所有源时间都是整数毫秒，区间左闭右开。词必须按起点排序、互不重叠，并包含在所属字幕内。"],
      ["片段", "clips 按成片顺序连接。普通片段取源上的 [in, out)，speed 为 [p, q]；空白段 source 为 null，只有 duration_ms。"],
      ["长度", "片段成片长度 =（out − in）× q / p。内部全部用约分分数，不做浮点累计。"],
      ["裁切", "每条字幕与每个同源片段求正长度交集。无 words 时保留整句 text；有 words 时只保留与片段有正长度交集的词，按词序用单个空格连接，一个词都不剩就不产出字幕。"],
      ["边界", "结果字幕的起止是「原字幕 ∩ 片段」边界映射后的值，不缩到首尾词。映射为 T +（s − in）× q / p。"],
      ["重复", "同一片段可重复使用，每次单独产出字幕；每片段每字幕至多一条结果，不跨片段合并。"],
      ["排序与 id", "按精确 start、片段顺序、源字幕 id 字典序排序。来源 id 为「片段 id:字幕 id」。"],
      ["WebVTT", "保留重叠；起点取 floor 毫秒、终点取 ceil 毫秒；时间格式 HH:MM:SS.mmm，小时至少两位。"],
      ["JSON", "分数统一为 [分子字符串, 分母字符串]，十进制整数、最简、分母为正；带 clip_order 与精确起止。"],
      ["非法输入", "非法区间、零速度、错序词会被逐条标出位置（sources[…] / clips[…] 路径），编辑面板与问题列表同步高亮。"]
    ];
    var list = el("div", { class: "rules" });
    rules.forEach(function (r) {
      var item = el("div", { class: "rule" });
      item.appendChild(el("div", { class: "rule-k", text: r[0] }));
      item.appendChild(el("div", { class: "rule-v", text: r[1] }));
      list.appendChild(item);
    });
    shell.body.appendChild(list);
    shell.footBar.appendChild(el("span", { class: "note", text: "样例：demo.zip · 许可 CC0-1.0" }));
    shell.footBar.appendChild(el("span", { style: "margin-left:auto" }));
    shell.footBar.appendChild(el("button", { class: "btn primary", attrs: { type: "button" }, text: "知道了", on: { click: closeModal } }));
    openModal();
  }

  /* ================================================================== *
   * Import / drop
   * ================================================================== */

  function readFile(file) {
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) { toast("文件超过 24 MB", true, 3200); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try { raw = JSON.parse(String(reader.result)); }
      catch (e) { toast("JSON 解析失败：" + e.message, true, 3200); return; }
      loadDoc(raw, file.name || "导入.json");
    };
    reader.onerror = function () { toast("文件读取失败", true); };
    reader.readAsText(file);
  }

  function wireDrop() {
    var overlay = $("dropOverlay");
    var depth = 0;
    window.addEventListener("dragenter", function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("dragleave", function () {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) readFile(files[0]);
    });
  }

  /* ================================================================== *
   * Toast
   * ================================================================== */

  var toastTimer = null;
  function toast(msg, bad, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.toggle("bad", !!bad);
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2400);
  }

  /* ================================================================== *
   * Wiring
   * ================================================================== */

  function wire() {
    $("btnImport").addEventListener("click", function () { $("fileInput").click(); });
    $("fileInput").addEventListener("change", function (e) { readFile(e.target.files && e.target.files[0]); e.target.value = ""; });
    $("btnPaste").addEventListener("click", openPaste);
    $("btnSample").addEventListener("click", function () { loadDoc(clone(DEMO), "demo.json"); });
    $("btnRules").addEventListener("click", openRules);
    $("btnExport").addEventListener("click", function () { if (state.doc) openExport(); });
    $("btnAddClip").addEventListener("click", openAddClip);
    $("btnAddGap").addEventListener("click", openAddGap);
    $("btnUndo").addEventListener("click", undo);
    $("btnRedo").addEventListener("click", redo);
    $("scrim").addEventListener("click", closeModal);
    $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
    document.querySelectorAll(".pane-switch button").forEach(function (b) {
      b.addEventListener("click", function () { switchPane(b.dataset.goto); });
    });
    var tourBtn = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "多源示例", on: { click: function () { loadDoc(clone(TOUR), "tour.json"); } } });
    $("btnRules").parentNode.insertBefore(tourBtn, $("btnRules"));

    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); redo(); }
      else if (e.key === "Escape" && !$("modal").hidden) closeModal();
    });
    wireDrop();
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  function boot() {
    wire();
    updateUndoButtons();
    var restored = restore();
    if (!restored) loadDoc(clone(DEMO), "demo.json", { quiet: true });
    if (state.result.cues.length) selectOut(0);
    else if (state.doc.clips.length) selectClip(0);
    else if (state.doc.sources.length && state.doc.sources[0] && Array.isArray(state.doc.sources[0].cues) && state.doc.sources[0].cues.length) selectSourceCue(0, 0);
    else renderAll();
  }

  window.CaptionWorkspace = {
    load: function (doc, name) { return loadDoc(doc, name || "外部载入.json"); },
    exportVTT: function () { return E.toWebVTT(state.result); },
    exportJSON: function () { return JSON.stringify(E.toJSON(state.result), null, 2); },
    getDoc: function () { return clone(state.doc); },
    getResult: function () { return state.result; },
    getErrors: function () { return state.errors.slice(); },
    state: state
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
