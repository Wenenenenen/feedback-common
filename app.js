/* App shell: state, rendering, playback, editing and export. */
(function () {
  'use strict';

  var SAMPLE = {
    columns: 8,
    intervalMs: 100,
    pages: [
      { tokens: [{ text: '屋屋屋屋，灯' }] },
      { tokens: [{ text: '甲乙丙（丁）' }] },
      {
        tokens: [
          { text: 'é👩🏽‍🚀' },
          { pauseMs: 300 },
          { icon: '铃' },
          { text: '灯' },
        ],
      },
      { tokens: [{ text: '甲乙ABCDEF灯' }] },
    ],
  };

  var STORAGE_KEY = 'dialogue-proof-v1';

  var state = {
    columns: SAMPLE.columns,
    intervalMs: SAMPLE.intervalMs,
    pages: SAMPLE.pages,
    pageIndex: 0,
    revealed: 0,
    elapsed: 0,
    playing: false,
    guide: true,
    fmt: 'lines',
  };

  var built = null;
  /* Playback position per page object, so flipping between pages while
     editing does not lose where the reveal had reached. Pages never played
     show complete, so each page reads as a proof at rest. */
  var pagePos = new WeakMap();
  var rafId = 0;
  var playWall = 0;
  var playBase = 0;
  var editTimer = 0;
  var toastTimer = 0;
  var resetArmed = 0;

  function $(id) { return document.getElementById(id); }

  var els = {
    pageTabs: $('pageTabs'),
    guideToggle: $('guideToggle'),
    frame: $('frame'),
    ruler: $('ruler'),
    gutter: $('gutter'),
    boxIn: $('boxIn'),
    nextMark: $('nextMark'),
    tagLeft: $('tagLeft'),
    tagRight: $('tagRight'),
    playBtn: $('playBtn'),
    playIcon: $('playIcon'),
    playLabel: $('playLabel'),
    stepBtn: $('stepBtn'),
    stepBackBtn: $('stepBackBtn'),
    endBtn: $('endBtn'),
    replayBtn: $('replayBtn'),
    prevPage: $('prevPage'),
    nextPage: $('nextPage'),
    pageCounter: $('pageCounter'),
    track: $('track'),
    fill: $('fill'),
    revealCount: $('revealCount'),
    itemCount: $('itemCount'),
    elapsed: $('elapsed'),
    duration: $('duration'),
    widthRange: $('widthRange'),
    widthOut: $('widthOut'),
    intervalInput: $('intervalInput'),
    lineList: $('lineList'),
    lineSummary: $('lineSummary'),
    draft: $('draft'),
    draftSummary: $('draftSummary'),
    addPage: $('addPage'),
    deletePage: $('deletePage'),
    resetSample: $('resetSample'),
    timeline: $('timeline'),
    timelineSummary: $('timelineSummary'),
    exportTabs: $('exportTabs'),
    exportOut: $('exportOut'),
    copyExport: $('copyExport'),
    statPages: $('statPages'),
    statCols: $('statCols'),
    statInterval: $('statInterval'),
    statDuration: $('statDuration'),
    scene: $('scene'),
    toast: $('toast'),
  };

  var PLAY_PATH = 'M5 3.1v9.8L12.9 8z';
  var PAUSE_PATH = 'M4.4 3.2h2.5v9.6H4.4zM9.1 3.2h2.5v9.6H9.1z';

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSeconds(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + ' s';
    return Math.round(ms) + ' ms';
  }

  function isEmoji(text) {
    try { return /\p{Extended_Pictographic}/u.test(text); } catch (e) { return false; }
  }

  function pageAt(i) { return state.pages[i] || state.pages[0]; }

  function currentTokens() { return pageAt(state.pageIndex).tokens || []; }

  /* preserve: keep the reveal position. keepTime: also keep elapsed as-is,
     which matters when a width change happens during a pause gap. */
  function rebuild(preserve, keepTime) {
    built = buildPage(currentTokens(), state.columns, state.intervalMs);
    var total = built.items.length;
    if (!preserve) {
      state.revealed = 0;
      state.elapsed = 0;
    } else {
      state.revealed = Math.max(0, Math.min(state.revealed, total));
      if (!keepTime) {
        state.elapsed = state.revealed > 0 ? built.items[state.revealed - 1].time : 0;
      }
      if (state.elapsed > built.duration) state.elapsed = built.duration;
    }
    if (state.playing) rebasePlayback();
  }

  function rebasePlayback() {
    playWall = performance.now();
    playBase = state.elapsed;
  }

  function revealedAt(elapsed) {
    var n = 0;
    while (n < built.items.length && built.items[n].time <= elapsed) n++;
    return n;
  }

  /* ---------- persistence ---------- */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        columns: state.columns,
        intervalMs: state.intervalMs,
        pages: state.pages,
        pageIndex: state.pageIndex,
      }));
    } catch (e) { /* storage may be unavailable */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.pages) || !data.pages.length) return false;
      state.pages = data.pages.filter(function (p) { return p && Array.isArray(p.tokens); });
      if (!state.pages.length) return false;
      state.columns = clampInt(data.columns, 8, 40, SAMPLE.columns);
      state.intervalMs = clampInt(data.intervalMs, 0, 2000, SAMPLE.intervalMs);
      state.pageIndex = clampInt(data.pageIndex, 0, state.pages.length - 1, 0);
      return true;
    } catch (e) { return false; }
  }

  function clampInt(value, min, max, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    els.frame.style.setProperty('--cols', state.columns);
    els.widthRange.value = state.columns;
    els.widthOut.textContent = state.columns + ' 列';
    els.intervalInput.value = state.intervalMs;
    els.guideToggle.checked = state.guide;
    els.frame.classList.toggle('guides', state.guide);
    renderStats();
    renderTabs();
    renderRuler();
    renderBox();
    renderGutter();
    renderLines();
    renderTimeline();
    renderExport();
    renderDraft();
    renderTransport();
    renderProgress();
    fitBox();
  }

  function renderTabs() {
    var html = '';
    state.pages.forEach(function (page, i) {
      var b = buildPage(page.tokens || [], state.columns, state.intervalMs);
      var flagged = b.lines.some(function (l) { return l.forced; });
      html += '<button class="ptab" type="button" role="tab" aria-selected="' +
        (i === state.pageIndex) + '" data-page="' + i + '" title="第 ' + (i + 1) + ' 页">' +
        'P' + pad2(i + 1) + (flagged ? '<span class="flag" aria-label="有强制断行"></span>' : '') +
        '</button>';
    });
    els.pageTabs.innerHTML = html;
    els.pageCounter.textContent = (state.pageIndex + 1) + ' / ' + state.pages.length;
    els.prevPage.disabled = state.pageIndex === 0;
    els.nextPage.disabled = state.pageIndex === state.pages.length - 1;
    els.deletePage.disabled = state.pages.length < 2;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function renderRuler() {
    var html = '';
    for (var i = 0; i < state.columns; i++) {
      var major = i % 4 === 0;
      html += '<div class="ruler-cell' + (major ? '' : ' minor') + '">' +
        (major && i < state.columns - 1 ? '<span>' + (i + 1) + '</span>' : '') + '</div>';
    }
    els.ruler.innerHTML = html;
    els.tagLeft.textContent = 'P.' + pad2(state.pageIndex + 1) + ' · ' + state.columns + ' COL';
  }

  function renderBox() {
    var html = '';
    built.lines.forEach(function (line) {
      html += '<div class="line">';
      for (var i = line.start; i < line.end; i++) {
        var item = built.items[i];
        var emoji = item.kind === 'grapheme' && isEmoji(item.text);
        html += '<span class="item' + (item.kind === 'icon' ? ' icon' : '') + '" data-i="' + i +
          '" data-on="false" data-w="' + item.cols + '" style="--w:' + item.cols + '"' +
          (emoji ? ' data-emoji="true"' : '') +
          '" title="第 ' + (i + 1) + ' 项 · ' + item.time + ' ms">' +
          '<span class="g">' + esc(item.text) + '</span></span>';
      }
      html += '</div>';
    });
    els.boxIn.innerHTML = html;
    var total = built.items.length;
    els.tagRight.textContent = total + ' ITEMS · ' + fmtSeconds(built.duration);
    fitBox();
    updateReveal();
  }

  function renderGutter() {
    var svgForced = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v6a1.5 1.5 0 0 0 1.5 1.5h4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6.8 7.4 9 9l-2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var svgWord = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2v8M8 2v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
    var html = '';
    built.lines.forEach(function (line, i) {
      var mark = line.forced ? svgForced : line.word ? svgWord : '';
      html += '<div class="g-line" data-forced="' + !!line.forced + '" data-word="' + !!line.word +
        '" title="' + (line.forced ? '没有合法断点，在最远处换行' : line.word ? '超长英数组被拆分' : '合法断点') + '">' +
        (mark ? '<span class="g-mark">' + mark + '</span>' : '') +
        '<span>' + pad2(i + 1) + '</span></div>';
    });
    els.gutter.innerHTML = html;
  }

  function itemLabel(item) {
    return item.kind === 'icon' ? '<' + item.text + '>' : item.text;
  }

  function renderLines() {
    var total = built.lines.length;
    var forced = built.lines.filter(function (l) { return l.forced; }).length;
    els.lineSummary.textContent = total + ' 行' + (forced ? ' · ' + forced + ' 处强制' : '');
    if (!total) {
      els.lineList.innerHTML = '<p class="t-empty">本页还没有内容。</p>';
      return;
    }
    var html = '';
    built.lines.forEach(function (line, i) {
      var items = built.items.slice(line.start, line.end);
      var text = items.map(function (it) {
        return it.kind === 'icon'
          ? '<span class="ic">&lt;' + esc(it.text) + '&gt;</span>'
          : esc(it.text);
      }).join('');
      var chips = '';
      if (line.forced) chips = '<span class="chip warn">强制</span>';
      else if (line.word) chips = '<span class="chip pause">拆英数</span>';
      html += '<div class="l-row" data-full="' + (line.width >= state.columns) + '" data-forced="' +
        !!line.forced + '" data-word="' + !!line.word + '" data-start="' + line.start +
        '" role="button" tabindex="0" title="跳到这一行开头">' +
        '<span class="l-no">' + pad2(i + 1) + '</span>' +
        '<span class="l-text">' + (text || '&nbsp;') + '</span>' +
        '<span class="l-meta">' + chips + '<span class="l-w">' + line.width + '/' + state.columns + '</span></span>' +
        '</div>';
    });
    els.lineList.innerHTML = html;
  }

  function renderTimeline() {
    var items = built.items;
    var pauses = built.pauses || [];
    els.timelineSummary.textContent = items.length + ' 项 · ' + fmtSeconds(built.duration);
    if (!items.length) {
      els.timeline.innerHTML = '<p class="t-empty">没有可揭示的项。</p>';
      return;
    }
    var rows = [];
    var p = 0;
    items.forEach(function (item, i) {
      while (p < pauses.length && pauses[p].after === i) {
        rows.push({ kind: 'pause', at: pauses[p].at, ms: pauses[p].ms });
        p++;
      }
      rows.push({ kind: 'item', index: i, item: item });
    });
    while (p < pauses.length) {
      rows.push({ kind: 'pause', at: pauses[p].at, ms: pauses[p].ms });
      p++;
    }
    var html = rows.map(function (row) {
      if (row.kind === 'pause') {
        return '<div class="t-row pause"><span class="t-i">—</span><span class="t-t">+' +
          row.ms + 'ms</span><span class="t-g">停顿</span><span class="t-k">PAUSE</span></div>';
      }
      var item = row.item;
      return '<div class="t-row" data-i="' + row.index + '" data-past="' +
        (row.index < state.revealed) + '" title="跳到这一项">' +
        '<span class="t-i">' + pad2(row.index + 1) + '</span>' +
        '<span class="t-t">' + item.time + '</span>' +
        '<span class="t-g">' + esc(itemLabel(item)) + '</span>' +
        '<span class="t-k">' + (item.kind === 'icon' ? 'ICON' : 'GRA') + '</span>' +
        '</div>';
    }).join('');
    els.timeline.innerHTML = html;
    if (document.activeElement === els.timeline) markCursor();
  }

  function summarizeDraft() {
    var tokens = currentTokens();
    var text = '';
    var icons = 0;
    var pauses = 0;
    tokens.forEach(function (t) {
      if (typeof t.text === 'string') text += t.text;
      if (typeof t.icon === 'string') icons++;
      if (t.pauseMs !== undefined && t.pauseMs !== null) pauses++;
    });
    var graphemes = splitGraphemes(text).filter(function (c) {
      return c !== '\n' && c !== '\r';
    }).length;
    els.draftSummary.textContent = graphemes + ' 字素 · ' + icons + ' 图标 · ' + pauses + ' 停顿';
  }

  function renderDraft() {
    if (document.activeElement !== els.draft) els.draft.value = tokensToDraft(currentTokens());
    summarizeDraft();
  }

  function renderTransport() {
    var playing = state.playing;
    els.playIcon.querySelector('path').setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
    els.playLabel.textContent = playing ? '暂停' : '播放';
    els.playBtn.setAttribute('aria-pressed', String(playing));
    els.playBtn.disabled = built.items.length === 0;
    els.stepBtn.disabled = built.items.length === 0 || state.revealed >= built.items.length;
    els.stepBackBtn.disabled = built.items.length === 0 || state.revealed <= 0;
    els.endBtn.disabled = built.items.length === 0 || state.revealed >= built.items.length;
  }

  function renderProgress() {
    var total = built.items.length;
    var pct = built.duration > 0 ? (state.elapsed / built.duration) * 100 : 0;
    els.fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    els.revealCount.textContent = state.revealed;
    els.itemCount.textContent = total;
    els.elapsed.textContent = Math.round(state.elapsed);
    els.duration.textContent = Math.round(built.duration);
  }

  function renderStats() {
    els.statPages.textContent = state.pages.length;
    els.statCols.textContent = state.columns;
    els.statInterval.textContent = state.intervalMs;
    els.statDuration.innerHTML = built.duration >= 1000
      ? (built.duration / 1000).toFixed(2) + '<small>s</small>'
      : Math.round(built.duration) + '<small>ms</small>';
  }

  function updateReveal() {
    var nodes = els.boxIn.querySelectorAll('.item');
    for (var i = 0; i < nodes.length; i++) {
      var on = i < state.revealed;
      nodes[i].setAttribute('data-on', String(on));
      nodes[i].classList.toggle('is-next', i === state.revealed);
    }
    positionCaret();
    renderTransport();
    renderProgress();
    // Timeline past-markers update cheaply.
    var rows = els.timeline.querySelectorAll('.t-row[data-i]');
    for (var r = 0; r < rows.length; r++) {
      rows[r].setAttribute('data-past', String(Number(rows[r].getAttribute('data-i')) < state.revealed));
    }
  }

  function positionCaret() {
    var idx = state.revealed;
    var item = built.items[idx];
    if (!item || state.revealed >= built.items.length) {
      els.nextMark.hidden = true;
      return;
    }
    els.nextMark.hidden = false;
    els.nextMark.style.setProperty('--x', item.column);
    els.nextMark.style.setProperty('--y', item.line);
  }

  /* ---------- geometry ---------- */

  var fitRaf = 0;
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitBox();
    });
  }

  function fitBox() {
    var scene = els.scene;
    var cs = getComputedStyle(scene);
    var avail = scene.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var frameCs = getComputedStyle(els.frame);
    var gutterW = els.gutter.offsetWidth + (parseFloat(frameCs.columnGap) || 10);
    // Column cells are 0.5em each; the box adds 2px border and 1em of
    // padding per side, and the frame needs the gutter plus a little air.
    var need = (avail - gutterW - 10) / (state.columns * 0.5 + 2 + 0.12);
    // Long pages shrink too: budget the box's height at about half the
    // viewport so a 20-line cue does not push the controls off screen.
    var lines = Math.max(1, built.lines.length);
    var heightBudget = Math.min(560, Math.max(280, window.innerHeight * 0.52));
    var byHeight = heightBudget / (lines * 1.7 + 1.82);
    var size = Math.max(10, Math.min(44, need, byHeight));
    els.frame.style.setProperty('--box-font', size.toFixed(2) + 'px');
    // Measure once and shrink if the real box still does not fit, so the
    // estimate never leaves a horizontal scrollbar behind.
    var frameW = els.frame.getBoundingClientRect().width;
    if (frameW > avail && frameW > 0) {
      size = Math.max(8, (size * avail) / frameW - 0.2);
      els.frame.style.setProperty('--box-font', size.toFixed(2) + 'px');
    }
  }

  /* ---------- playback ---------- */

  function startPlaying() {
    if (!built.items.length) return;
    if (state.revealed >= built.items.length) {
      state.revealed = 0;
      state.elapsed = 0;
      updateReveal();
    }
    state.playing = true;
    var last = state.revealed > 0 ? built.items[state.revealed - 1].time : 0;
    if (state.elapsed < last) state.elapsed = last;
    rebasePlayback();
    renderTransport();
    rafId = requestAnimationFrame(tick);
  }

  function stopPlaying(keepExact) {
    state.playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (!keepExact) {
      // Snap to the last revealed item's time unless the pause landed inside
      // a gap; a gap is preserved so resuming does not replay it.
      var last = state.revealed > 0 ? built.items[state.revealed - 1].time : 0;
      if (state.elapsed < last) state.elapsed = last;
    }
    updateReveal();
  }

  function tick(now) {
    if (!state.playing) return;
    var next = playBase + (now - playWall);
    if (next >= built.duration) {
      state.elapsed = built.duration;
      state.revealed = built.items.length;
      state.playing = false;
      rafId = 0;
      updateReveal();
      return;
    }
    state.elapsed = next;
    var n = revealedAt(next);
    if (n !== state.revealed) {
      state.revealed = n;
      updateReveal();
    } else {
      renderProgress();
    }
    rafId = requestAnimationFrame(tick);
  }

  function stepForward() {
    if (state.playing) stopPlaying(true);
    if (state.revealed >= built.items.length) return;
    state.revealed++;
    state.elapsed = built.items[state.revealed - 1].time;
    updateReveal();
  }

  function stepBack() {
    if (state.playing) stopPlaying(true);
    if (state.revealed <= 0) return;
    state.revealed--;
    state.elapsed = state.revealed > 0 ? built.items[state.revealed - 1].time : 0;
    updateReveal();
  }

  function showWholePage() {
    if (state.playing) stopPlaying(true);
    state.revealed = built.items.length;
    state.elapsed = built.duration;
    updateReveal();
  }

  function replay() {
    if (state.playing) stopPlaying(true);
    state.revealed = 0;
    state.elapsed = 0;
    updateReveal();
    startPlaying();
  }

  function seekItem(index) {
    if (state.playing) stopPlaying(true);
    if (!built.items[index]) return;
    state.revealed = index + 1;
    state.elapsed = built.items[index].time;
    updateReveal();
  }

  /* ---------- page navigation ---------- */

  function goPage(index) {
    var next = Math.max(0, Math.min(state.pages.length - 1, index));
    if (next === state.pageIndex) return;
    if (state.playing) stopPlaying(true);
    pagePos.set(pageAt(state.pageIndex), state.revealed);
    state.pageIndex = next;
    state.revealed = 0;
    state.elapsed = 0;
    rebuild(false);
    var saved = pagePos.get(pageAt(next));
    state.revealed = saved === undefined ? built.items.length : Math.min(saved, built.items.length);
    state.elapsed = state.revealed > 0 ? built.items[state.revealed - 1].time : 0;
    renderAll();
    save();
  }

  /* ---------- editing ---------- */

  function applyDraft() {
    var tokens = parseDraft(els.draft.value);
    pageAt(state.pageIndex).tokens = tokens;
    var wasPlaying = state.playing;
    rebuild(true, wasPlaying);
    renderTabs();
    renderBox();
    renderGutter();
    renderLines();
    renderTimeline();
    renderExport();
    summarizeDraft();
    if (wasPlaying) {
      rebasePlayback();
    }
    save();
  }

  function scheduleDraft() {
    clearTimeout(editTimer);
    editTimer = setTimeout(function () {
      editTimer = 0;
      applyDraft();
    }, 140);
  }

  /* ---------- export ---------- */

  function exportData() {
    return state.pages.map(function (page, pi) {
      var b = buildPage(page.tokens || [], state.columns, state.intervalMs);
      var lines = b.lines.map(function (line) {
        var items = b.items.slice(line.start, line.end);
        return {
          text: items.map(itemLabel).join(''),
          width: line.width,
          forced: !!line.forced,
          word: !!line.word,
        };
      });
      return {
        page: pi + 1,
        lines: lines,
        items: b.items.map(function (it, i) {
          return { index: i + 1, time: it.time, kind: it.kind, text: it.text };
        }),
        pauses: b.pauses,
        duration: b.duration,
      };
    });
  }

  function exportText(fmt) {
    var data = exportData();
    if (fmt === 'json') {
      return JSON.stringify({
        columns: state.columns,
        intervalMs: state.intervalMs,
        pages: data,
      }, null, 2);
    }
    var out = [];
    if (fmt === 'lines') {
      out.push('# 对白排版台 · ' + state.columns + ' 列 · 每项 ' + state.intervalMs + ' ms');
      data.forEach(function (p) {
        out.push('');
        out.push('P' + pad2(p.page) + '  ' + p.lines.length + ' 行');
        p.lines.forEach(function (line, i) {
          var marks = [];
          if (line.forced) marks.push('强制断行');
          if (line.word) marks.push('英数拆分');
          out.push('  ' + pad2(i + 1) + '  [' + line.width + '/' + state.columns + ']  ' +
            line.text + (marks.length ? '  ← ' + marks.join(' · ') : ''));
        });
      });
    } else {
      out.push('# 对白排版台 · 揭示时间 · 每项 ' + state.intervalMs + ' ms');
      data.forEach(function (p) {
        out.push('');
        out.push('P' + pad2(p.page) + '  共 ' + p.items.length + ' 项 · ' + p.duration + ' ms');
        var pauses = p.pauses.slice();
        p.items.forEach(function (item, i) {
          while (pauses.length && pauses[0].after === i) {
            out.push('  ··  ' + padTime(pauses[0].at) + '  +' + pauses[0].ms + ' ms 停顿');
            pauses.shift();
          }
          out.push('  ' + pad2(item.index) + '  ' + padTime(item.time) + '  ' +
            (item.kind === 'icon' ? item.text + '  [图标]' : item.text + '  [字素]'));
        });
        pauses.forEach(function (pause) {
          out.push('  ··  ' + padTime(pause.at) + '  +' + pause.ms + ' ms 停顿（结尾）');
        });
      });
    }
    return out.join('\n');
  }

  function padTime(ms) {
    return String(Math.round(ms)).padStart(6, ' ') + 'ms';
  }

  function renderExport() {
    els.exportOut.textContent = exportText(state.fmt);
    var tabs = els.exportTabs.querySelectorAll('.seg-btn');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-fmt') === state.fmt;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', String(on));
    }
  }

  function copyExport() {
    var text = els.exportOut.textContent;
    function fallback() {
      var range = document.createRange();
      range.selectNodeContents(els.exportOut);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('已选中导出内容，按 Ctrl/⌘+C 复制');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          toast('已复制 ' + text.split('\n').length + ' 行');
        }, fallback);
        return;
      }
    } catch (e) { /* fall through */ }
    fallback();
  }

  /* ---------- toast ---------- */

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('on');
    }, 2200);
  }

  /* ---------- events ---------- */

  els.lineList.addEventListener('click', function (e) {
    var row = e.target.closest('.l-row[data-start]');
    if (row) seekItem(Number(row.getAttribute('data-start')));
  });
  els.lineList.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest('.l-row[data-start]');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    seekItem(Number(row.getAttribute('data-start')));
  });

  els.pageTabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.ptab');
    if (btn) goPage(Number(btn.getAttribute('data-page')));
  });

  els.guideToggle.addEventListener('change', function () {
    state.guide = els.guideToggle.checked;
    els.frame.classList.toggle('guides', state.guide);
  });

  els.playBtn.addEventListener('click', function () {
    if (state.playing) stopPlaying(false);
    else startPlaying();
  });
  els.stepBtn.addEventListener('click', stepForward);
  els.stepBackBtn.addEventListener('click', stepBack);
  els.endBtn.addEventListener('click', showWholePage);
  els.replayBtn.addEventListener('click', replay);
  els.prevPage.addEventListener('click', function () { goPage(state.pageIndex - 1); });
  els.nextPage.addEventListener('click', function () { goPage(state.pageIndex + 1); });

  els.widthRange.addEventListener('input', function () {
    var w = clampInt(els.widthRange.value, 8, 40, 8);
    if (w === state.columns) return;
    state.columns = w;
    els.widthOut.textContent = w + ' 列';
    els.statCols.textContent = w;
    els.frame.style.setProperty('--cols', w);
    rebuild(true, true);
    renderTabs();
    renderRuler();
    renderBox();
    renderGutter();
    renderLines();
    renderExport();
    renderTransport();
    renderProgress();
    fitBox();
    save();
  });

  els.intervalInput.addEventListener('change', function () {
    var v = clampInt(els.intervalInput.value, 0, 2000, state.intervalMs);
    if (v === state.intervalMs) {
      els.intervalInput.value = state.intervalMs;
      return;
    }
    state.intervalMs = v;
    els.intervalInput.value = v;
    els.statInterval.textContent = v;
    var wasPlaying = state.playing;
    if (wasPlaying) stopPlaying(true);
    rebuild(true);
    renderStats();
    renderBox();
    renderGutter();
    renderLines();
    renderTimeline();
    renderExport();
    renderTabs();
    if (wasPlaying) startPlaying();
    save();
  });

  els.draft.addEventListener('input', scheduleDraft);
  els.draft.addEventListener('blur', function () {
    clearTimeout(editTimer);
    editTimer = 0;
    applyDraft();
  });

  els.addPage.addEventListener('click', function () {
    state.pages.push({ tokens: [] });
    state.pageIndex = state.pages.length - 1;
    state.revealed = 0;
    state.elapsed = 0;
    if (state.playing) stopPlaying(true);
    rebuild(false);
    renderAll();
    els.draft.value = '';
    els.draft.focus();
    save();
    toast('已新建第 ' + state.pages.length + ' 页');
  });

  els.deletePage.addEventListener('click', function () {
    if (state.pages.length < 2) return;
    var removed = state.pageIndex + 1;
    state.pages.splice(state.pageIndex, 1);
    state.pageIndex = Math.min(state.pageIndex, state.pages.length - 1);
    state.revealed = 0;
    state.elapsed = 0;
    if (state.playing) stopPlaying(true);
    rebuild(false);
    renderAll();
    save();
    toast('已删除第 ' + removed + ' 页');
  });

  els.resetSample.addEventListener('click', function () {
    var now = Date.now();
    if (now - resetArmed > 2600) {
      resetArmed = now;
      els.resetSample.textContent = '确认载入样例？';
      toast('再点一次会覆盖当前全部页');
      setTimeout(function () {
        if (Date.now() - resetArmed >= 2500) els.resetSample.textContent = '载入样例';
      }, 2600);
      return;
    }
    resetArmed = 0;
    els.resetSample.textContent = '载入样例';
    if (state.playing) stopPlaying(true);
    state.columns = SAMPLE.columns;
    state.intervalMs = SAMPLE.intervalMs;
    state.pages = JSON.parse(JSON.stringify(SAMPLE.pages));
    state.pageIndex = 0;
    state.revealed = 0;
    state.elapsed = 0;
    els.draft.value = tokensToDraft(currentTokens());
    rebuild(false);
    renderAll();
    save();
    toast('已载入样例');
  });

  els.timeline.addEventListener('click', function (e) {
    var row = e.target.closest('.t-row[data-i]');
    if (row) seekItem(Number(row.getAttribute('data-i')));
  });

  /* The timeline has one tab stop; arrows move a highlight, Enter seeks. */
  var tCursor = 0;
  function markCursor() {
    var rows = els.timeline.querySelectorAll('.t-row[data-i]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-cursor', Number(rows[i].getAttribute('data-i')) === tCursor);
    }
    var row = els.timeline.querySelector('.t-row.is-cursor');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  els.timeline.addEventListener('focus', function () {
    if (document.activeElement === els.timeline) markCursor();
  });
  els.timeline.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      var total = built.items.length;
      if (!total) return;
      if (e.key === 'ArrowDown') tCursor = Math.min(total - 1, tCursor + 1);
      else if (e.key === 'ArrowUp') tCursor = Math.max(0, tCursor - 1);
      else if (e.key === 'Home') tCursor = 0;
      else tCursor = total - 1;
      markCursor();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      seekItem(tCursor);
    }
  });

  els.exportTabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.fmt = btn.getAttribute('data-fmt');
    renderExport();
  });

  els.copyExport.addEventListener('click', copyExport);

  els.boxIn.addEventListener('click', function (e) {
    var item = e.target.closest('.item');
    if (item) seekItem(Number(item.getAttribute('data-i')));
  });

  window.addEventListener('resize', scheduleFit);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { scheduleFit(); });
  }

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' ||
      (e.target && e.target.isContentEditable);
    var nativeControl = tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY';
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      return;
    }
    if (typing) return;
    // Buttons already react to Space and Enter; let them, and only keep
    // the global shortcuts elsewhere.
    if (nativeControl && (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (state.playing) stopPlaying(false);
      else startPlaying();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepForward();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepBack();
    } else if (e.key === '[') {
      e.preventDefault();
      setWidth(state.columns - 1);
    } else if (e.key === ']') {
      e.preventDefault();
      setWidth(state.columns + 1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      goPage(state.pageIndex + 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      goPage(state.pageIndex - 1);
    }
  });

  function setWidth(w) {
    var next = Math.max(8, Math.min(40, w));
    if (next === state.columns) return;
    els.widthRange.value = next;
    els.widthRange.dispatchEvent(new Event('input'));
  }

  /* ---------- boot ---------- */

  load();
  rebuild(false);
  renderAll();
  // A first frame that shows the tool working: the sample's first page fully
  // revealed so the box is not empty before anyone presses play.
  state.revealed = built.items.length;
  state.elapsed = built.duration;
  updateReveal();
})();
