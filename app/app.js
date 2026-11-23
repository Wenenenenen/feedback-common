/* 起音网格拟合台 —— 页面交互层（无外部库） */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = window.OnsetSolver, W = window.OnsetWav;
  var FRAME = 240, SR = 48000, HIST_MAX = 100, ROW_CAP = 300;

  // ---------- 文档与历史 ----------
  var doc = null;          // {beats, anchors:Map<beat,frame>, onsets:Map<frame,[won,woff]>}
  var audio = null;        // {samples, sampleCount, frameCount, name}
  var solution = null;     // 求解结果
  var selected = -1;
  var undoStack = [], redoStack = [];
  var onsetFilter = '';
  var actx = null;
  var play = { src: null, mode: 'orig', offsetSec: 0, playing: false, raf: 0, startedAt: 0, _startOffset: 0 };
  var cached = { orig: null, click: null, both: null };

  function snapshot() {
    return {
      beats: doc.beats,
      anchors: new Map(doc.anchors),
      // 权重数组是可变嵌套结构，必须逐个数组深拷贝，否则历史与当前状态共享引用
      onsets: new Map(Array.from(doc.onsets, function (e) { return [e[0], [e[1][0], e[1][1]]]; }))
    };
  }
  function restore(s) {
    doc = { beats: s.beats, anchors: new Map(s.anchors), onsets: new Map() };
    s.onsets.forEach(function (v, k) { doc.onsets.set(k, v.slice()); });
  }
  function commit(mutator) {
    if (!doc) return;
    undoStack.push(snapshot());
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack.length = 0;
    mutator();
    selected = -1;
    resolveAndRender();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    selected = -1;
    resolveAndRender();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    selected = -1;
    resolveAndRender();
  }

  function metaFromDoc() {
    return {
      beats: doc.beats,
      anchors: Array.from(doc.anchors.entries()).sort(function (a, b) { return a[0] - b[0]; }),
      onsets: Array.from(doc.onsets.entries()).map(function (e) { return [e[0], e[1][0], e[1][1]]; })
    };
  }

  // ---------- 求解 ----------
  function resolveAndRender() {
    solution = null;
    // 解依赖权重与锚点，任何重解都让试听缓存与播放位置失效
    cached = { orig: null, click: null, both: null };
    if (play.playing) stopPlay(false);
    if (audio) { play.offsetSec = 0; $('seek').value = 0; }
    var meta = metaFromDoc();
    var v = S.validate({
      beats: meta.beats, frameCount: audio.frameCount,
      anchors: meta.anchors, onsets: meta.onsets
    });
    if (!v.ok) {
      renderAll({ validationErrors: v.errors });
      return;
    }
    var res = S.solve({
      beats: meta.beats, frameCount: audio.frameCount,
      anchorFrame: v.anchorFrame, onsets: meta.onsets
    });
    solution = res;
    if (res.feasible && selected >= res.beats.length) selected = -1;
    renderAll({ validationErrors: [] });
  }

  // ---------- 状态条 / 横幅 ----------
  function renderStatus(extra) {
    var pill = $('statePill'), txt = $('stateText');
    pill.className = 'pill';
    if (extra.validationErrors.length) {
      pill.classList.add('bad');
      txt.textContent = '输入不合法';
    } else if (!solution.feasible) {
      pill.classList.add('bad');
      txt.textContent = '无解：不沿用旧网格';
    } else {
      pill.classList.add('ok');
      txt.textContent = '当前版本解';
    }
    var feasible = solution && solution.feasible;
    $('scoreVal').textContent = feasible ? String(solution.score) : '–';
    $('beatsVal').textContent = String(doc.beats);
    $('penaltyVal').textContent = feasible ? String(solution.stats.totalPenalty) : '–';
    $('timeVal').textContent = feasible ? solution.stats.elapsedMs.toFixed(1) + ' ms' : '–';
    $('undoBtn').disabled = undoStack.length === 0;
    $('redoBtn').disabled = redoStack.length === 0;
    $('exportJsonBtn').disabled = !feasible;
    $('exportWavBtn').disabled = !feasible;
    $('playBtn').disabled = !audio;

    var ez = $('errorZone');
    ez.innerHTML = '';
    if (extra.validationErrors.length) {
      var d = document.createElement('div');
      d.className = 'error-banner';
      d.innerHTML = '<div>⚠️</div><div><strong>输入校验未通过，已停止求解：</strong><ul>' +
        extra.validationErrors.map(function (e) { return '<li></li>'; }).join('') + '</ul></div>';
      var lis = d.querySelectorAll('li');
      extra.validationErrors.forEach(function (e, i) { lis[i].textContent = e; });
      ez.appendChild(d);
    } else if (!solution.feasible) {
      var w = document.createElement('div');
      w.className = 'warn-banner';
      w.textContent = '当前锚点与候选下不存在可行网格：' + solution.reason + '。画布与导出均不保留旧网格，可撤销或调整锚点。';
      ez.appendChild(w);
    }
  }

  // ---------- 画布 ----------
  var canvas = $('stage'), ctx = canvas.getContext('2d');
  var cssW = 900, cssH = 320;

  function resizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    cssW = Math.max(320, rect.width);
    cssH = 320;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  }
  function xOfFrame(f) { return f / audio.frameCount * cssW; }
  function frameOfX(x) { return Math.round(x / cssW * audio.frameCount); }

  var css = getComputedStyle(document.documentElement);
  function tok(name) { return css.getPropertyValue(name).trim(); }

  function drawWave() {
    var n = audio.sampleCount, cols = Math.max(1, Math.floor(cssW));
    var mid = cssH * 0.62, amp = cssH * 0.30;
    var s = audio.samples;
    // 自适应增益：以全局峰值归一，但限制在 8 倍内，避免噪声被放大成满幅
    var globalPeak = 1;
    for (var g = 0; g < n; g += 8) { var a = Math.abs(s[g]); if (a > globalPeak) globalPeak = a; }
    var gain = Math.min(8, 32768 / Math.max(globalPeak, 1));
    // 中心参考线
    ctx.strokeStyle = tok('--line');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(cssW, mid); ctx.stroke();
    ctx.fillStyle = tok('--ink-2');
    ctx.globalAlpha = 0.55;
    // 逐列 min/max 包络；对稀疏脉冲素材，非零列给最小可见高度
    var per = n / cols;
    for (var c = 0; c < cols; c++) {
      var i0 = Math.floor(c * per), i1 = Math.max(i0 + 1, Math.floor((c + 1) * per));
      var mn = 0, mx = 0, nz = false;
      for (var i = i0; i < i1 && i < n; i++) {
        var v = s[i] * gain;
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        if (s[i] !== 0) nz = true;
        if (v < mn) mn = v; else if (v > mx) mx = v;
      }
      if (!nz) continue;
      var yHi = mid - Math.max(2, mx / 32768 * amp);
      var yLo = mid + Math.max(2, -mn / 32768 * amp);
      ctx.fillRect(c, yHi, 1, Math.max(3, yLo - yHi));
    }
    ctx.globalAlpha = 1;
    // 时间轴刻度（秒）
    ctx.fillStyle = tok('--ink-2');
    ctx.font = '10px ' + tok('--mono');
    ctx.textAlign = 'center';
    var dur = n / SR, step = dur > 60 ? 10 : dur > 20 ? 5 : 2;
    for (var sec = 0; sec <= dur; sec += step) {
      var x = sec / dur * cssW;
      ctx.fillStyle = tok('--line');
      ctx.fillRect(x, cssH - 16, 1, 12);
      ctx.fillStyle = tok('--ink-2');
      ctx.fillText(sec + 's', x, cssH - 4);
    }
  }

  function drawOnsets() {
    var maxW = 1;
    doc.onsets.forEach(function (v) { if (v[0] > maxW) maxW = v[0]; if (v[1] > maxW) maxW = v[1]; });
    var base = cssH - 18, hMax = cssH * 0.40;
    doc.onsets.forEach(function (v, f) {
      var x = xOfFrame(f);
      if (x < -2 || x > cssW + 2) return;
      if (v[0] > 0) {
        ctx.fillStyle = tok('--accent');
        ctx.globalAlpha = 0.5;
        var h0 = Math.max(2, v[0] / maxW * hMax);
        ctx.fillRect(x - 0.5, base - h0, 1.6, h0);
      }
      if (v[1] > 0) {
        ctx.fillStyle = tok('--offbeat');
        ctx.globalAlpha = 0.5;
        var h1 = Math.max(2, v[1] / maxW * hMax);
        ctx.fillRect(x + 0.6, base - h1, 1.6, h1);
      }
    });
    ctx.globalAlpha = 1;
  }

  function drawGrid() {
    if (!solution || !solution.feasible) return;
    var beats = solution.beats;
    for (var b = 0; b < beats.length; b++) {
      var r = beats[b];
      var x = xOfFrame(r.frame);
      var sel = b === selected;
      // 正拍
      ctx.fillStyle = tok('--accent');
      ctx.fillRect(x - 0.75, 26, sel ? 3 : 1.5, cssH - 44);
      ctx.beginPath();
      ctx.moveTo(x, 18); ctx.lineTo(x - 4.5, 27); ctx.lineTo(x + 4.5, 27);
      ctx.closePath(); ctx.fill();
      // 反拍
      var offFrame = r.frame + (r.swing === 0 ? r.period / 2 : 2 * r.period / 3);
      var xo = xOfFrame(offFrame);
      ctx.fillStyle = tok('--offbeat');
      ctx.fillRect(xo - 0.75, 70, 1.5, cssH - 88);
      ctx.fillRect(xo - 2.5, 64, 5, 2);
      if (sel) {
        ctx.strokeStyle = tok('--accent');
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(x - 6, 12, 12, cssH - 30);
        ctx.globalAlpha = 1;
      }
    }
    // 锚点
    ctx.fillStyle = tok('--ink');
    doc.anchors.forEach(function (frame, beat) {
      var x = xOfFrame(frame);
      ctx.beginPath();
      ctx.moveTo(x, 2); ctx.lineTo(x + 5, 9); ctx.lineTo(x, 16); ctx.lineTo(x - 5, 9);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = tok('--ink');
      ctx.font = '9px ' + tok('--mono');
      ctx.textAlign = 'center';
      ctx.fillText(String(beat), x, 26);
    });
  }

  function drawPlayhead() {
    if (play.offsetSec <= 0) return; // 未播放时不画播放头，避免与帧 0 的正拍线重叠
    var frac = play.offsetSec / (audio.sampleCount / SR);
    var x = frac * cssW;
    ctx.fillStyle = tok('--danger');
    ctx.fillRect(x - 0.75, 0, 1.5, cssH - 16);
  }

  function drawCanvas() {
    if (!audio) return;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = tok('--bg');
    ctx.fillRect(0, 0, cssW, cssH);
    drawWave();
    drawOnsets();
    drawGrid();
    drawPlayhead();
  }

  canvas.addEventListener('click', function (e) {
    if (!audio) return;
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    if (e.altKey) {
      tryAddAnchorFromCanvas(x);
      return;
    }
    if (!solution || !solution.feasible) return;
    var best = -1, bestD = 10;
    solution.beats.forEach(function (r, b) {
      var d = Math.abs(xOfFrame(r.frame) - x);
      if (d < bestD) { bestD = d; best = b; }
    });
    if (best >= 0) { selected = best; renderAll({ validationErrors: [] }); }
  });

  function tryAddAnchorFromCanvas(x) {
    var frame = frameOfX(x);
    frame = Math.max(0, Math.min(audio.frameCount, frame - frame % 6));
    // 优先把锚点挂到最近的已有拍号；无解时按帧在锚点间的比例估一个拍号
    var best = -1, bestD = Infinity;
    if (solution && solution.feasible) {
      solution.beats.forEach(function (r, b) {
        var d = Math.abs(r.frame - frame);
        if (d < bestD) { bestD = d; best = b; }
      });
    } else {
      var rows = Array.from(doc.anchors.entries()).sort(function (a, b) { return a[0] - b[0]; });
      for (var i = 0; i < rows.length - 1; i++) {
        if (frame >= rows[i][1] && frame <= rows[i + 1][1]) {
          var span = rows[i + 1][1] - rows[i][1];
          best = rows[i][0] + Math.round((frame - rows[i][1]) / span * (rows[i + 1][0] - rows[i][0]));
          best = Math.max(rows[i][0] + 1, Math.min(rows[i + 1][0] - 1, best));
          break;
        }
      }
    }
    if (best < 0) return;
    if (doc.anchors.has(best)) { toast('拍号 ' + best + ' 已有锚点，请先在侧栏删除'); return; }
    var ok = true;
    doc.anchors.forEach(function (f, b) {
      if (b < best && f >= frame) ok = false;
      if (b > best && f <= frame) ok = false;
    });
    if (!ok) { toast('帧 ' + frame + ' 与相邻锚点的增序冲突'); return; }
    commit(function () { doc.anchors.set(best, frame); });
    toast('已在拍号 ' + best + '、帧 ' + frame + ' 添加锚点');
  }

  // ---------- 侧栏表格 ----------
  function renderOnsetTable() {
    var tb = $('onsetTbody');
    tb.innerHTML = '';
    var rows = Array.from(doc.onsets.entries()).sort(function (a, b) { return a[0] - b[0]; });
    if (onsetFilter !== '') {
      var key = parseInt(onsetFilter, 10);
      rows = rows.filter(function (e) { return Math.abs(e[0] - key) <= 60; });
    }
    var shown = rows.slice(0, ROW_CAP);
    var frag = document.createDocumentFragment();
    shown.forEach(function (e) {
      var f = e[0], won = e[1][0], woff = e[1][1];
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="num"></td><td class="num"><input class="w-input" type="number" min="0" max="1000" data-k="on"></td>' +
        '<td class="num"><input class="w-input" type="number" min="0" max="1000" data-k="off"></td><td><button class="row-btn" title="删除候选">✕</button></td>';
      tr.children[0].textContent = String(f);
      var inOn = tr.children[1].firstChild, inOff = tr.children[2].firstChild;
      inOn.value = won; inOff.value = woff;
      inOn.addEventListener('change', function () { setWeight(f, 'on', inOn.value); });
      inOff.addEventListener('change', function () { setWeight(f, 'off', inOff.value); });
      tr.children[3].firstChild.addEventListener('click', function () {
        commit(function () { doc.onsets.delete(f); });
      });
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    if (rows.length > ROW_CAP) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" style="color:var(--ink-2);text-align:center">仅显示前 ' + ROW_CAP +
        ' 条，共 ' + rows.length + ' 条；在上方输入帧号过滤附近 ±60 帧</td>';
      tb.appendChild(tr);
    }
  }

  // 过滤输入框动态插入（表头上方）
  function ensureFilterBox() {
    if ($('onsetFilter')) return;
    var box = document.createElement('div');
    box.style.cssText = 'padding:0 0 8px';
    box.innerHTML = '<input id="onsetFilter" class="w-input" style="width:100%" placeholder="按帧号过滤（显示附近 ±60 帧）">';
    $('paneOnsets').querySelector('.panel-b').insertBefore(box, $('paneOnsets').querySelector('.table-scroll'));
    box.firstChild.addEventListener('input', function (e) {
      onsetFilter = e.target.value.trim();
      renderOnsetTable();
    });
  }

  function setWeight(frame, kind, raw) {
    var v = parseInt(raw, 10);
    if (!Number.isInteger(v) || v < 0 || v > 1000) { toast('权重须为 0–1000 的整数'); renderOnsetTable(); return; }
    var cur = doc.onsets.get(frame);
    var idx = kind === 'on' ? 0 : 1;
    if (cur[idx] === v) return; // 值未变化（含重复事件），不产生历史条目
    commit(function () { cur[idx] = v; });
  }

  function renderAnchorTable() {
    var tb = $('anchorTbody');
    tb.innerHTML = '';
    var rows = Array.from(doc.anchors.entries()).sort(function (a, b) { return a[0] - b[0]; });
    var frag = document.createDocumentFragment();
    rows.forEach(function (e) {
      var b = e[0], f = e[1];
      var required = (b === 0 || b === doc.beats);
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="num"></td><td class="num"></td><td></td>';
      tr.children[0].textContent = String(b) + (required ? ' *' : '');
      tr.children[1].textContent = String(f);
      if (!required) {
        var btn = document.createElement('button');
        btn.className = 'row-btn';
        btn.textContent = '✕';
        btn.title = '删除锚点';
        btn.addEventListener('click', function () {
          commit(function () { doc.anchors.delete(b); });
        });
        tr.children[2].appendChild(btn);
      }
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
  }

  function renderBeatTables() {
    var tb = $('beatTbody'), det = $('beatDetail');
    tb.innerHTML = '';
    if (!solution || !solution.feasible) {
      det.innerHTML = '<div class="empty">当前无可行解，没有可展示的拍。</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    solution.beats.forEach(function (r, b) {
      var tr = document.createElement('tr');
      if (b === selected) tr.className = 'sel';
      tr.innerHTML = '<td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td>';
      tr.children[0].textContent = String(b);
      tr.children[1].textContent = String(r.frame);
      tr.children[2].textContent = String(r.period);
      tr.children[3].textContent = String(r.swing);
      tr.children[4].textContent = String(r.penalty);
      tr.addEventListener('click', function () { selected = b; renderAll({ validationErrors: [] }); });
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    renderBeatDetail();
  }

  function renderBeatDetail() {
    var det = $('beatDetail');
    if (selected < 0 || !solution || !solution.feasible) {
      det.innerHTML = '<div class="empty">点击画布上的一拍或下方拍表，查看匹配来源与小分。</div>';
      return;
    }
    var r = solution.beats[selected];
    var prev = selected > 0 ? solution.beats[selected - 1] : null;
    var dp = prev ? Math.abs(r.period - prev.period) / 6 : 0;
    var swCost = prev && r.swing !== prev.swing ? 7 : 0;
    var offFrame = r.frame + (r.swing === 0 ? r.period / 2 : 2 * r.period / 3);
    function card(kind, title, posFrame, match, score) {
      return '<div class="match-card ' + kind + '"><h3>' + title + '（位置帧 ' + posFrame + '）</h3>' +
        '<dl class="kv" style="grid-template-columns:80px 1fr">' +
        '<dt>匹配候选</dt><dd>' + (match === null ? '未匹配（null）' : '帧 ' + match) + '</dd>' +
        '<dt>匹配分</dt><dd>' + score + '</dd></dl></div>';
    }
    det.innerHTML =
      '<dl class="kv">' +
      '<dt>拍号</dt><dd>' + selected + '</dd>' +
      '<dt>正拍帧</dt><dd>' + r.frame + '（样本 ' + (r.frame * FRAME) + '）</dd>' +
      '<dt>拍长 P</dt><dd>' + r.period + ' 帧（' + (r.period / 6) + ' 个 6 帧单位）</dd>' +
      '<dt>反拍类型</dt><dd>s=' + r.swing + '（' + (r.swing === 0 ? '半拍 P/2' : '三分之二拍 2P/3') + '，反拍帧 ' + offFrame + '）</dd>' +
      '<dt>本拍扣分</dt><dd>' + r.penalty + '（变速 ' + (3 * dp) + ' + 切换 ' + swCost + '）</dd>' +
      '</dl>' +
      card('on', '正拍匹配', r.frame, r.onMatch, r.onScore) +
      card('off', '反拍匹配', offFrame, r.offMatch, r.offScore);
  }

  function renderAll(extra) {
    renderStatus(extra || { validationErrors: [] });
    resizeCanvas();
    drawCanvas();
    ensureFilterBox();
    renderOnsetTable();
    renderAnchorTable();
    renderBeatTables();
  }

  // ---------- 增删表单 ----------
  $('addOnsetBtn').addEventListener('click', function () {
    var f = parseInt($('newOnsetFrame').value, 10);
    var won = parseInt($('newOnsetWon').value, 10);
    var woff = parseInt($('newOnsetWoff').value, 10);
    if (!Number.isInteger(f) || f < 0 || f >= audio.frameCount) return toast('帧号须在 0..' + (audio.frameCount - 1));
    if (doc.onsets.has(f)) return toast('帧 ' + f + ' 已有候选，直接在表中改权重或先删除');
    if (!Number.isInteger(won) || !Number.isInteger(woff) || won < 0 || woff < 0 || won > 1000 || woff > 1000) {
      return toast('两个权重须为 0–1000 的整数');
    }
    commit(function () { doc.onsets.set(f, [won, woff]); });
    $('newOnsetFrame').value = ''; $('newOnsetWon').value = ''; $('newOnsetWoff').value = '';
  });
  $('addAnchorBtn').addEventListener('click', function () {
    var b = parseInt($('newAnchorBeat').value, 10);
    var f = parseInt($('newAnchorFrame').value, 10);
    if (!Number.isInteger(b) || b < 0 || b > doc.beats) return toast('拍号须在 0..' + doc.beats);
    if (doc.anchors.has(b)) return toast('拍号 ' + b + ' 已有锚点');
    if (!Number.isInteger(f) || f % 6 !== 0 || f < 0 || f > audio.frameCount) {
      return toast('锚点帧须为 0..' + audio.frameCount + ' 内 6 的倍数');
    }
    var conflict = false;
    doc.anchors.forEach(function (af, ab) {
      if (ab < b && af >= f) conflict = true;
      if (ab > b && af <= f) conflict = true;
    });
    if (conflict) return toast('锚点帧须随拍号严格增序');
    commit(function () { doc.anchors.set(b, f); });
    $('newAnchorBeat').value = ''; $('newAnchorFrame').value = '';
  });

  // ---------- 标签页 ----------
  [['tabOnsets', 'paneOnsets'], ['tabAnchors', 'paneAnchors'], ['tabBeat', 'paneBeat']].forEach(function (pair) {
    $(pair[0]).addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.tabpane').forEach(function (p) { p.classList.remove('active'); });
      $(pair[0]).setAttribute('aria-selected', 'true');
      $(pair[1]).classList.add('active');
    });
  });

  // ---------- 文件载入 ----------
  function loadJsonText(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return toast('JSON 解析失败：' + e.message); }
    if (!data || !Number.isInteger(data.beats) || !Array.isArray(data.anchors) || !Array.isArray(data.onsets)) {
      return toast('JSON 须含 beats（整数）、anchors、onsets');
    }
    if (data.beats < 1 || data.beats > 192) return toast('beats 超出 1..192');
    if (data.onsets.length > 24000) return toast('起音候选超过 24000');
    var anchors = new Map(), onsets = new Map();
    data.anchors.forEach(function (a) { anchors.set(a[0], a[1]); });
    data.onsets.forEach(function (o) { onsets.set(o[0], [o[1], o[2]]); });
    doc = { beats: data.beats, anchors: anchors, onsets: onsets };
    undoStack.length = 0; redoStack.length = 0; selected = -1;
    if (audio) {
      hideToast();
      $('dropZone').hidden = true; $('work').hidden = false;
      resolveAndRender();
    } else {
      toast('JSON 已载入，请再选择 WAV');
    }
  }

  function loadWavBuffer(buf, name) {
    var parsed;
    try { parsed = W.parseWav(buf); }
    catch (e) { return toast(e.message); }
    if (parsed.sampleCount > SR * 120) return toast('音频超过 120 秒上限');
    audio = parsed; audio.name = name || '';
    $('audioVal').textContent = (parsed.sampleCount / SR).toFixed(2) + 's · ' + parsed.frameCount + ' 帧';
    stopPlay(false);
    play.offsetSec = 0;
    $('seek').value = 0;
    $('seek').disabled = false;
    $('timeLabel').textContent = '00:00.00 / ' + fmtTime(parsed.sampleCount / SR);
    if (doc) {
      hideToast();
      $('dropZone').hidden = true; $('work').hidden = false;
      resolveAndRender();
    } else {
      toast('WAV 已载入，请再选择候选 JSON');
    }
  }

  $('wavFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    f.arrayBuffer().then(function (b) { loadWavBuffer(b, f.name); });
    e.target.value = '';
  });
  $('jsonFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    f.text().then(loadJsonText);
    e.target.value = '';
  });

  // 拖放
  var dz = $('dropZone');
  ['dragover', 'dragenter'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); dz.querySelector('.drop-hint').classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      dz.querySelector('.drop-hint').classList.remove('drag');
    });
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach(function (f) {
      if (/\.wav$/i.test(f.name)) f.arrayBuffer().then(function (b) { loadWavBuffer(b, f.name); });
      else if (/\.json$/i.test(f.name)) f.text().then(loadJsonText);
      else toast('忽略不支持的文件：' + f.name);
    });
  });

  // 示例数据（与页面同目录发布）
  var sampleBtn = document.createElement('button');
  sampleBtn.className = 'btn';
  sampleBtn.textContent = '载入内置示例';
  sampleBtn.style.marginTop = '10px';
  $('dropHint').appendChild(sampleBtn);
  sampleBtn.addEventListener('click', function () {
    Promise.all([
      fetch('guide.json').then(function (r) { if (!r.ok) throw new Error('guide.json ' + r.status); return r.text(); }),
      fetch('guide.wav').then(function (r) { if (!r.ok) throw new Error('guide.wav ' + r.status); return r.arrayBuffer(); })
    ]).then(function (rs) {
      loadJsonText(rs[0]);
      loadWavBuffer(rs[1], 'guide.wav');
    }).catch(function (e) { toast('示例载入失败：' + e.message); });
  });

  // ---------- 撤销/重做 ----------
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  window.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---------- 导出 ----------
  function download(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  $('exportJsonBtn').addEventListener('click', function () {
    if (!solution || !solution.feasible) return;
    var text = W.buildGridJson(solution.score, solution.beats);
    download('grid.json', new Blob([text], { type: 'application/json' }));
  });
  $('exportWavBtn').addEventListener('click', function () {
    if (!solution || !solution.feasible) return;
    var clicks = W.buildClickTrack(audio.sampleCount, solution.beats, audio.frameCount);
    var bytes = W.buildWav(clicks);
    download('grid-click.wav', new Blob([bytes], { type: 'audio/wav' }));
  });

  // ---------- 试听 ----------
  function ensureCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function pcmToBuffer(ctx, int16) {
    var buf = ctx.createBuffer(1, int16.length, SR);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    return buf;
  }
  // 预览用短音（规范只要求可听辨，脉冲数值限定于导出 WAV）
  function blipBuffer(ctx, len) {
    var buf = ctx.createBuffer(1, len, SR), ch = buf.getChannelData(0);
    solution.beats.forEach(function (r) {
      tone(ch, r.frame * FRAME, 880, 0.045, 0.55);
      var offFrame = r.frame + (r.swing === 0 ? r.period / 2 : 2 * r.period / 3);
      tone(ch, offFrame * FRAME, 587, 0.035, 0.4);
    });
    return buf;
    function tone(ch, idx, freq, dur, gain) {
      var n = Math.floor(dur * SR);
      for (var i = 0; i < n && idx + i < ch.length; i++) {
        var env = Math.exp(-i / (SR * dur * 0.35));
        ch[idx + i] += Math.sin(2 * Math.PI * freq * i / SR) * env * gain;
      }
    }
  }
  function mixBuffer(ctx, a, b) {
    var buf = ctx.createBuffer(1, a.length, SR), ch = buf.getChannelData(0);
    for (var i = 0; i < a.length; i++) {
      var v = (a ? a[i] : 0) + (b ? b[i] : 0);
      ch[i] = Math.max(-1, Math.min(1, v));
    }
    return buf;
  }
  function buildBuffers() {
    var ctx = ensureCtx();
    cached.orig = pcmToBuffer(ctx, audio.samples);
    var blip = blipBuffer(ctx, audio.sampleCount);
    cached.click = blip;
    cached.both = mixBuffer(ctx, cached.orig.getChannelData(0), blip.getChannelData(0));
  }
  function currentBuffer() { return cached[play.mode] || cached.orig; }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60), cs = Math.floor((sec * 100) % 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }
  function tick() {
    if (!play.playing) return;
    var dur = audio.sampleCount / SR;
    play.offsetSec = Math.min(dur, actx.currentTime - play.startedAt + play._startOffset);
    $('seek').value = Math.round(play.offsetSec / dur * 1000);
    $('timeLabel').textContent = fmtTime(play.offsetSec) + ' / ' + fmtTime(dur);
    drawCanvas();
    if (play.offsetSec >= dur - 0.002) { stopPlay(true); return; }
    play.raf = requestAnimationFrame(tick);
  }
  function startPlay() {
    if (!audio) return;
    var ctx = ensureCtx();
    if (!cached.orig) buildBuffers();
    var src = ctx.createBufferSource();
    src.buffer = currentBuffer();
    src.connect(ctx.destination);
    var dur = audio.sampleCount / SR;
    play._startOffset = play.offsetSec;
    src.start(0, play.offsetSec);
    play.startedAt = ctx.currentTime;
    play.src = src; play.playing = true;
    $('playBtn').textContent = '⏸ 暂停';
    src.onended = function () { if (play.src === src) stopPlay(true); };
    play.raf = requestAnimationFrame(tick);
  }
  function stopPlay(ended) {
    if (play.src) {
      try { play.src.onended = null; play.src.stop(); } catch (e) {}
      play.src = null;
    }
    play.playing = false;
    cancelAnimationFrame(play.raf);
    $('playBtn').textContent = '▶ 试听';
    if (ended) {
      var dur = audio.sampleCount / SR;
      if (play.offsetSec >= dur - 0.002) { play.offsetSec = 0; $('seek').value = 0; $('timeLabel').textContent = '00:00.00 / ' + fmtTime(dur); drawCanvas(); }
    }
  }
  $('playBtn').addEventListener('click', function () {
    if (!audio) return;
    if (play.playing) {
      stopPlay(false);
    } else startPlay();
  });
  [['mixOriginal', 'orig'], ['mixClick', 'click'], ['mixBoth', 'both']].forEach(function (pair) {
    $(pair[0]).addEventListener('click', function () {
      play.mode = pair[1];
      ['mixOriginal', 'mixClick', 'mixBoth'].forEach(function (id) { $(id).setAttribute('aria-pressed', String(id === pair[0])); });
      if (play.playing) { stopPlay(false); startPlay(); }
    });
  });
  $('seek').addEventListener('input', function (e) {
    if (!audio) return;
    var dur = audio.sampleCount / SR;
    play.offsetSec = e.target.value / 1000 * dur;
    $('timeLabel').textContent = fmtTime(play.offsetSec) + ' / ' + fmtTime(dur);
    if (play.playing) { stopPlay(false); startPlay(); } else drawCanvas();
  });
  // ---------- toast ----------
  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').classList.remove('show');
  }
  window.toast = toast;

  window.addEventListener('resize', function () { if (audio) { resizeCanvas(); drawCanvas(); } });
})();
