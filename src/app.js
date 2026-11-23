(function () {
  'use strict';

  var Engine = CutlineEngineFactory();
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var STORE_KEY = 'league-cutline.v1';
  var state = {
    data: null,
    qualifiers: 0,
    locks: {},
    engine: null,
    analysis: null,
    summary: null,
    selection: null,
    reqSeq: 0,
    busy: false,
    worker: null,
    restoreSel: null,
    autoSelect: false,
    elapsed: null,
    error: null
  };

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function pct(q, total) { return total > 0 ? (q * 100 / total) : 0; }
  function pctText(q, total) {
    var v = pct(q, total);
    if (v === 100) return '100%';
    if (v === 0) return '0%';
    if (v < 0.1) return '<0.1%';
    return v.toFixed(1) + '%';
  }
  function msText(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' 秒';
  }
  function matchLabel(m) { return '队 ' + m.left + ' vs 队 ' + m.right; }
  function scoreText(s) { return s[0] + '–' + s[1]; }
  function pendingBySlot() {
    return state.engine ? state.engine.pending : [];
  }
  function lockCount() { return Object.keys(state.locks).length; }

  function assignmentMap(assignment) {
    var out = {};
    var pend = pendingBySlot();
    for (var i = 0; i < pend.length; i++) out[pend[i].id] = assignment[i];
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* persistence                                                         */
  /* ------------------------------------------------------------------ */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        data: state.data, qualifiers: state.qualifiers, locks: state.locks
      }));
    } catch (e) { /* private window, quota — the page still works */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !saved.data) return null;
      return saved;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ */
  /* worker                                                              */
  /* ------------------------------------------------------------------ */
  var WORKER_BODY = [
    "self.onmessage = function (ev) {",
    "  var msg = ev.data;",
    "  var engine = CutlineEngineFactory();",
    "  try {",
    "    var e = engine.create(msg.raw, { qualifiers: msg.qualifiers, locks: msg.locks });",
    "    var analysis = e.analyze(function (done, total) {",
    "      self.postMessage({ id: msg.id, type: 'progress', done: done, total: total });",
    "    });",
    "    self.postMessage({ id: msg.id, type: 'done', analysis: analysis });",
    "  } catch (err) {",
    "    self.postMessage({ id: msg.id, type: 'error', message: (err && err.message) || String(err) });",
    "  }",
    "};"
  ].join('\n');

  function workerSupported() {
    try { return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && !!URL.createObjectURL; }
    catch (e) { return false; }
  }

  function makeWorker() {
    var src = 'var CutlineEngineFactory = ' + CutlineEngineFactory.toString() + ';\n' + WORKER_BODY;
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    var w;
    try {
      w = new Worker(url);
    } catch (e) {
      try { URL.revokeObjectURL(url); } catch (e2) { /* ignore */ }
      throw e;
    }
    w._blobUrl = url;
    return w;
  }

  function stopWorker() {
    if (state.worker) {
      var w = state.worker;
      state.worker = null;
      try { w.terminate(); } catch (e) { /* ignore */ }
      if (w._blobUrl) { try { URL.revokeObjectURL(w._blobUrl); } catch (e2) { /* ignore */ } }
    }
  }

  /* ------------------------------------------------------------------ */
  /* compute                                                             */
  /* ------------------------------------------------------------------ */
  function recompute() {
    var reqId = ++state.reqSeq;
    state.error = null;
    state.busy = true;
    // Keep the user's place when the new conditions still produce that rank.
    state.restoreSel = state.selection ? { teamId: state.selection.teamId, rank: state.selection.rank } : null;
    state.selection = null;
    setProgress(0, 1, '枚举中');
    renderAll(true);
    var payload = { id: reqId, raw: state.data, qualifiers: state.qualifiers, locks: state.locks };

    if (workerSupported()) {
      stopWorker();
      var w;
      try { w = makeWorker(); } catch (e) { w = null; }
      if (w) {
        state.worker = w;
        w.onmessage = function (ev) {
          if (ev.data.id !== state.reqSeq) return;
          if (ev.data.type === 'progress') {
            setProgress(ev.data.done, ev.data.total, '枚举中');
          } else if (ev.data.type === 'done') {
            complete(reqId, ev.data.analysis);
          } else if (ev.data.type === 'error') {
            fail(ev.data.message);
          }
        };
        w.onerror = function () {
          stopWorker();
          computeInline(reqId);
        };
        try { w.postMessage(payload); } catch (e) { stopWorker(); computeInline(reqId); }
        return;
      }
    }
    computeInline(reqId);
  }

  function computeInline(reqId) {
    // Main-thread fallback: paint the "working" state first, then block once.
    requestAnimationFrame(function () {
      if (reqId !== state.reqSeq) return;
      setTimeout(function () {
        if (reqId !== state.reqSeq) return;
        try {
          var engine = Engine.create(state.data, { qualifiers: state.qualifiers, locks: state.locks });
          var analysis = engine.analyze();
          complete(reqId, analysis);
        } catch (err) {
          fail(err && err.message ? err.message : String(err));
        }
      }, 30);
    });
  }

  function complete(reqId, analysis) {
    if (reqId !== state.reqSeq) return;
    state.busy = false;
    state.analysis = analysis;
    state.elapsed = analysis.elapsedMs;
    try {
      state.engine = Engine.create(state.data, { qualifiers: state.qualifiers, locks: state.locks });
      state.summary = Engine.summarize(analysis, state.qualifiers);
    } catch (err) {
      fail(err && err.message ? err.message : String(err));
      return;
    }
    if (state.restoreSel) {
      var keep = state.restoreSel;
      state.restoreSel = null;
      for (var i = 0; i < state.summary.teams.length; i++) {
        var t = state.summary.teams[i];
        if (t.id === keep.teamId && t.rankHist[keep.rank]) {
          state.selection = { teamId: keep.teamId, rank: keep.rank };
          break;
        }
      }
    }
    if (state.autoSelect) {
      state.autoSelect = false;
      autoSelectScenario();
    }
    stopWorker();
    setProgress(analysis.total, analysis.total, '已完成');
    renderAll(false);
  }

  function fail(message) {
    state.busy = false;
    state.error = message;
    stopWorker();
    setProgress(0, 1, '出错');
    renderAll(false);
  }

  /* First load only: open a replay that actually shows a recomputation. */
  function autoSelectScenario() {
    if (state.selection || !state.summary) return;
    var best = null;
    for (var i = 0; i < state.summary.teams.length; i++) {
      var t = state.summary.teams[i];
      var ranks = [];
      if (t.earliestQualifyRank !== null && t.earliestQualifyRank !== undefined) ranks.push(t.earliestQualifyRank);
      if (t.earliestEliminateRank !== null && t.earliestEliminateRank !== undefined) ranks.push(t.earliestEliminateRank);
      for (var r = 0; r < ranks.length; r++) {
        var rounds;
        try { rounds = state.engine.scenario(teamAnalysis(t.id).firstByRank[ranks[r]], true).rounds; }
        catch (e) { continue; }
        var pages = rounds.length;
        if (!best || pages > best.pages) best = { teamId: t.id, rank: ranks[r], pages: pages };
      }
      if (best && best.pages > 0) break;
    }
    if (best) state.selection = { teamId: best.teamId, rank: best.rank };
  }

  function pruneSelection() {
    if (!state.selection) return;
    var found = null;
    if (state.summary) {
      for (var i = 0; i < state.summary.teams.length; i++) {
        if (state.summary.teams[i].id === state.selection.teamId) found = state.summary.teams[i];
      }
    }
    if (!found || !found.rankHist[state.selection.rank]) state.selection = null;
  }

  function teamAnalysis(id) {
    if (!state.analysis) return null;
    for (var i = 0; i < state.analysis.teams.length; i++) {
      if (state.analysis.teams[i].id === id) return state.analysis.teams[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */
  function renderAll(isBusy) {
    renderTiles();
    renderControls(isBusy);
    renderTeams(isBusy);
    renderLocks();
    renderFixtures();
    renderScenario();
  }

  function renderTiles() {
    var analysis = state.analysis;
    var total = analysis ? analysis.total : 0;
    var html = '';
    html += tile('完整赛果', analysis ? fmt(total) : '—', '组',
      analysis
        ? (analysis.totalAll !== total
          ? '锁定前 ' + fmt(analysis.totalAll) + ' 组 · 全部精确枚举'
          : '精确枚举，无抽样')
        : '等待计算');
    html += tile('锁定比赛', analysis ? (lockCount() + ' / ' + analysis.pendingCount) : '—', '',
      analysis ? (lockCount() ? '其余待定比赛全部展开' : '全部待定比赛都在枚举范围内') : '等待计算');
    html += tile('出线名额', String(state.qualifiers), '',
      state.engine ? ('共 ' + state.engine.teamIds.length + ' 队 · 按总分与组内交手排序') : '按总分与组内交手排序');
    html += tile('枚举耗时', msText(state.elapsed), '',
      analysis ? ('单次计算 ' + fmt(analysis.leaves) + ' 组，不计画图') : '不计画图');
    $('.tiles').innerHTML = html;
    function tile(k, v, unit, sub) {
      return '<div class="tile"><div class="k">' + esc(k) + '</div>' +
        '<div class="v">' + esc(v) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>' +
        '<div class="sub">' + esc(sub) + '</div></div>';
    }
  }

  function renderControls(isBusy) {
    var n = state.engine ? state.engine.teamIds.length : (state.data ? state.data.teams.length : 0);
    $('#q-val').textContent = state.qualifiers;
    $('#q-minus').disabled = state.qualifiers <= 0;
    $('#q-plus').disabled = state.qualifiers >= n;
    $('#unlock-all').disabled = lockCount() === 0;
    $('#export-btn').disabled = !state.summary;
    var status;
    if (state.error) status = '出错：' + state.error;
    else if (state.busy) status = '精确枚举中';
    else if (state.summary) status = '共 ' + fmt(state.summary.total) + ' 组完整赛果 · 用时 ' + msText(state.elapsed);
    else status = '等待计算';
    $('#status').textContent = status;
    $('#status').title = status;
  }

  function setProgress(done, total, label) {
    var bar = $('#progress i');
    if (!bar) return;
    var ratio = total > 0 ? Math.min(1, done / total) : 0;
    bar.style.width = (ratio * 100).toFixed(2) + '%';
    var el = $('#status');
    if (el && state.busy) el.textContent = label + ' ' + fmt(done) + ' / ' + fmt(total);
  }

  function focusKey(el) {
    if (!el || !el.dataset) return null;
    if (el.dataset.act === 'scenario') return 'scenario:' + el.dataset.team + ':' + el.dataset.rank;
    if (el.dataset.act === 'toggle-lock') return 'lock:' + el.dataset.match + ':' + el.dataset.cand;
    if (el.dataset.act === 'rank') return 'rank:' + el.dataset.team + ':' + el.dataset.rank;
    return null;
  }
  function restoreFocus(key) {
    if (!key) return;
    var parts = key.split(':');
    var sel = null;
    if (parts[0] === 'scenario') sel = '.team-row[data-team="' + parts[1] + '"] [data-act="scenario"][data-rank="' + parts[2] + '"]';
    else if (parts[0] === 'lock') sel = '.cand[data-match="' + parts[1] + '"][data-cand="' + parts[2] + '"]';
    else if (parts[0] === 'rank') sel = '[data-act="rank"][data-team="' + parts[1] + '"][data-rank="' + parts[2] + '"]';
    if (!sel) return;
    var el = document.querySelector(sel);
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  function renderTeams() {
    var root = $('#team-list');
    var keepFocus = focusKey(document.activeElement);
    if (!state.summary) {
      root.innerHTML = '<li class="panel-empty" style="padding:18px 16px">' +
        (state.busy ? '正在展开全部赛果…' : state.error ? '计算失败：' + esc(state.error) : '等待数据') + '</li>';
      return;
    }
    var total = state.summary.total;
    var K = state.summary.K;
    var html = '';
    state.summary.teams.forEach(function (t) {
      var q = t.qualify, e = t.eliminate;
      var verdict, cls, label;
      if (q === total) { cls = 'in'; label = '确定出线'; }
      else if (q === 0) { cls = 'out'; label = '确定出局'; }
      else { cls = 'mid'; label = '看赛果'; }
      var qRank = t.earliestQualifyRank;
      var eRank = t.earliestEliminateRank;
      var selected = state.selection && state.selection.teamId === t.id;
      html += '<li class="team-row" data-team="' + t.id + '">' +
        '<div class="team-id"><span class="no">' + t.id + '</span><span class="lbl">队</span></div>' +
        '<div class="verdict ' + cls + '"><span class="pill"><span class="dot"></span>' + label + '</span></div>' +
        '<div class="team-stats">' +
          '<div class="counts"><span class="q">' + pctText(q, total) + '</span>' +
            '<span class="frac">出线 ' + fmt(q) + ' · 未出线 ' + fmt(e) + '</span></div>' +
          '<div class="bar" role="img" aria-label="出线赛果占 ' + pctText(q, total) + '"><i style="width:' +
            Math.max(q > 0 ? 1.5 : 0, pct(q, total)).toFixed(2) + '%"></i></div>' +
        '</div>' +
        '<div class="team-actions">' +
          '<button class="chip" data-act="scenario" data-team="' + t.id + '" data-rank="' + qRank + '"' +
            (qRank === null ? ' disabled' : '') + ' title="' + (qRank === null ? '没有任何赛果能让此队出线' : '最早一组可复演赛果') + '">' +
            '出线赛果</button>' +
          '<button class="chip" data-act="scenario" data-team="' + t.id + '" data-rank="' + eRank + '"' +
            (eRank === null ? ' disabled' : '') + ' title="' + (eRank === null ? '任何赛果下此队都出线' : '最早一组可复演赛果') + '">' +
            '未出线赛果</button>' +
        '</div>' +
      '</li>';
    });
    root.innerHTML = html;
    restoreFocus(keepFocus);
  }

  function renderLocks() {
    var root = $('#lock-list');
    var keepFocus = focusKey(document.activeElement);
    var pend = pendingBySlot();
    if (!pend.length) {
      root.innerHTML = '<div class="panel-empty">没有待定比赛，所有比分都已确定。</div>';
      return;
    }
    var html = '';
    pend.forEach(function (m) {
      var lockedAt = Object.prototype.hasOwnProperty.call(state.locks, m.id) ? state.locks[m.id] : -1;
      html += '<div class="lock-row" data-match="' + m.id + '">' +
        '<div class="match-meta"><span class="match-no">#' + m.id + '</span>' +
        '<span class="match-teams">队 ' + m.left + '<span class="vs">vs</span>队 ' + m.right + '</span>' +
        (lockedAt >= 0 ? '<span class="lock-flag">锁定</span>' : '') + '</div>' +
        '<div class="cands">';
      m.candidates.forEach(function (c, ci) {
        var cls = 'cand';
        if (lockedAt === ci) cls += ' locked';
        else if (lockedAt >= 0) cls += ' out';
        html += '<button class="' + cls + '" data-act="toggle-lock" data-match="' + m.id + '" data-cand="' + ci + '"' +
          ' aria-pressed="' + (lockedAt === ci) + '" title="候选位置 ' + ci + '，' + matchLabel(m) + ' ' + scoreText(c) + '">' +
          '<span class="pos">#' + ci + '</span>' + scoreText(c) + '</button>';
      });
      html += '</div></div>';
    });
    root.innerHTML = html;
    restoreFocus(keepFocus);
  }

  function renderFixtures() {
    var root = $('#fixture-list');
    if (!state.engine) { root.innerHTML = ''; return; }
    var fixed = state.engine.model.fixed;
    if (!fixed.length) { root.innerHTML = '<div class="panel-empty">没有已结束的比赛。</div>'; return; }
    root.innerHTML = fixed.map(function (m) {
      return '<span class="fx"><span class="no">#' + m.id + '</span><b>队 ' + m.left + '</b>' +
        '<span class="sc">' + scoreText(m.score) + '</span><b>队 ' + m.right + '</b></span>';
    }).join('');
  }

  /* ---------------- scenario ---------------- */
  function currentScenario() {
    var sel = state.selection;
    if (!sel || !state.engine || !state.analysis || !state.summary) return null;
    var team = null;
    for (var i = 0; i < state.summary.teams.length; i++) {
      if (state.summary.teams[i].id === sel.teamId) { team = state.summary.teams[i]; break; }
    }
    if (!team || !team.rankHist[sel.rank]) return null;
    var assignment = teamAnalysis(sel.teamId).firstByRank[sel.rank];
    if (!assignment) return null;
    var replay;
    try { replay = state.engine.scenario(assignment, true); }
    catch (e) { return null; }
    return {
      teamId: sel.teamId, rank: sel.rank, assignment: assignment,
      replay: replay, team: team,
      qualified: sel.rank < state.qualifiers
    };
  }

  function renderScenario() {
    var root = $('#scenario');
    var sc = currentScenario();
    if (!sc) {
      root.className = 'card scenario';
      root.innerHTML = '<div class="scenario-head"><div><h2>赛果回放</h2>' +
        '<p class="note">点任意一队旁的“出线赛果 / 未出线赛果”，这里展开那一组赛果的完整重算过程。</p></div></div>' +
        '<div class="empty-scenario">' + (state.analysis
          ? '尚未选择赛果。每组赛果都按比赛编号升序、候选位置升序取第一组，可原样复演。'
          : (state.busy ? '正在展开全部赛果…' : '等待数据。')) + '</div>';
      return;
    }
    var pend = pendingBySlot();
    var map = assignmentMap(sc.assignment);
    var chips = pend.map(function (m) {
      var ci = map[m.id];
      var locked = Object.prototype.hasOwnProperty.call(state.locks, m.id);
      return '<span class="a">#' + m.id + ' ' + m.left + '–' + m.right + ' <b>' + scoreText(m.candidates[ci]) + '</b>' +
        '<span class="pos">#' + ci + '</span>' + (locked ? '<span class="lk">锁</span>' : '') + '</span>';
    }).join('');

    var rankChips = '';
    for (var r = 0; r < sc.team.rankHist.length; r++) {
      if (!sc.team.rankHist[r]) continue;
      var on = r === sc.rank ? ' on' : '';
      rankChips += '<button class="chip sm' + on + '" data-act="rank" data-team="' + sc.teamId + '" data-rank="' + r + '"' +
        ' title="第 ' + (r + 1) + ' 名的最早一组赛果">第 ' + (r + 1) + ' 名 · ' + pctText(sc.team.rankHist[r], state.summary.total) + '</button>';
    }

    var html = '<div class="scenario-head">' +
      '<div style="min-width:0">' +
      '<h2>赛果回放 · 队 ' + sc.teamId + ' 第 ' + (sc.rank + 1) + ' 名 · ' +
      (sc.qualified ? '出线' : '未出线') + '</h2>' +
      '<p class="note">按比赛编号升序、候选位置升序找到的第一组赛果，共 ' + fmt(state.summary.total) +
      ' 组里此名次出现 ' + fmt(sc.team.rankHist[sc.rank]) + ' 次。</p>' +
      '<div class="assign">' + chips + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' +
      '<button class="btn sm" data-act="copy-scenario">复制赛果</button>' +
      '<button class="btn sm mark" data-act="lock-scenario">按此赛果锁定</button>' +
      '</div></div>' +
      '<div class="scenario-cols"><div>' +
      '<div class="subhead">最终总榜 · ' + state.qualifiers + ' 个出线名额</div>' +
      finalTable(sc) +
      '<div class="subhead" style="margin-top:14px">同队其他名次</div>' +
      '<div style="display:flex;gap:5px;flex-wrap:wrap">' + rankChips + '</div>' +
      '</div><div>' +
      '<div class="subhead">各轮重算' + (sc.replay.rounds.length ? ' · ' + sc.replay.rounds.length + ' 次' : '') + '</div>' +
      (sc.replay.rounds.length ? sc.replay.rounds.map(function (rd) { return roundHTML(rd, sc.replay.rounds); }).join('') :
        '<p class="round-note" style="margin-top:0">总榜没有同分切点，名次直接由总分决定，无需重算。</p>') +
      '</div></div>';
    root.className = 'card scenario';
    var keepFocus = focusKey(document.activeElement);
    root.innerHTML = html;
    restoreFocus(keepFocus);
  }

  function finalTable(sc) {
    var K = state.qualifiers;
    var showCut = K > 0 && K < sc.replay.standings.length;
    var rows = sc.replay.standings.map(function (s, i) {
      var after = '';
      if (showCut && i + 1 === K) {
        after = '</tbody><tbody class="cutline-row"><tr><td colspan="4" class="cutline"><span>出线线</span></td></tr></tbody><tbody>';
      }
      return '<tr class="' + (s.qualified ? 'q' : 'x') + '"><td class="rank">' + s.rank + '</td>' +
        '<td class="team-cell"><span class="tn">' + s.id + '</span></td>' +
        '<td class="num">' + s.points + '</td><td class="num">' + (s.diff > 0 ? '+' : '') + s.diff + '</td></tr>' + after;
    }).join('');
    return '<div style="overflow-x:auto"><table><thead><tr><th>名次</th><th>队伍</th>' +
      '<th class="num">总分</th><th class="num">局差</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function roundHTML(rd, allRounds) {
    var K = state.qualifiers;
    var parent = null;
    if (rd.level > 0 && rd.parentSeq !== null && rd.parentSeq !== undefined && allRounds) {
      parent = allRounds[rd.parentSeq] || null;
    }
    var flips = false;
    if (parent && parent.rows.length && rd.rows.length) {
      var prevFirst = parent.rows[0].id;
      var nowFirst = rd.rows[0].id;
      if (prevFirst !== nowFirst && rd.rows.some(function (r) { return r.id === prevFirst; })) {
        flips = true;
        rd._prevFirst = prevFirst;
        rd._nowFirst = nowFirst;
      }
    }
    var kindText = rd.kind === 'fallback' ? '总局差、队号定序' : '组内交手重算';
    var title = (rd.level === 0 ? '总榜同分' : '组内同分') + ' · ' + rd.size + ' 队 · ' + rd.points + ' 分';
    var lineage = parent ? '<span class="round-parent">接 R' + (parent.seq + 1) + '</span>' : '';
    var runs = rd.runs.map(function (x) { return x.len; });
    var note = '';
    if (rd.kind === 'fallback') {
      note = '组内积分与组内局差都相同，整组分不开，改用总局差、队号升序。';
    } else {
      var multi = runs.filter(function (x) { return x > 1; }).length;
      note = '只数这 ' + rd.size + ' 队彼此的比赛，按组内积分、组内局差排成 ' +
        runs.join(' + ') + ' 队' + (multi ? '，多队的那档继续往下重算。' : '，各档都只有一队。');
    }
    var used = rd.usedMatches && rd.usedMatches.length
      ? '组内比赛 ' + rd.usedMatches.map(function (id) { return '#' + id; }).join('、')
      : '这些队之间没有列出的比赛';
    // Ranks are shown per band: a run of tied teams shares a rank range and is
    // resolved by a deeper round, so a provisional order is never presented as final.
    var bands = [];
    var at = 0;
    for (var bi = 0; bi < rd.runs.length; bi++) {
      var runLen = rd.runs[bi].len;
      bands.push({ from: rd.rankStart + at, to: rd.rankStart + at + runLen - 1, len: runLen });
      at += runLen;
    }
    var rows = rd.rows.map(function (row, i) {
      var band = null;
      var acc = 0;
      for (var k = 0; k < rd.runs.length; k++) {
        if (i < acc + rd.runs[k].len) { band = bands[k]; break; }
        acc += rd.runs[k].len;
      }
      var rankCell = band && band.len > 1
        ? '<span class="band">' + band.from + '–' + band.to + '</span>'
        : String(row.rank);
      var placed = row.resolved && row.qualified === true;
      return '<tr class="' + (placed ? 'placed' : '') + (row.resolved ? '' : ' tied') + '">' +
        '<td class="rank">' + rankCell + '</td>' +
        '<td class="team-cell"><span class="tn">' + row.id + '</span></td>' +
        '<td class="num">' + row.hp + '</td>' +
        '<td class="num">' + (row.hd > 0 ? '+' : '') + row.hd + '</td>' +
        '<td class="num">' + (row.diff > 0 ? '+' : '') + row.diff + '</td></tr>';
    }).join('');

    var orderParts = [];
    var oi = 0;
    for (var rj = 0; rj < rd.runs.length; rj++) {
      var ids = [];
      for (var t = 0; t < rd.runs[rj].len; t++) ids.push(rd.rows[oi + t].id);
      orderParts.push(ids.join(' = '));
      oi += rd.runs[rj].len;
    }
    var orderLine = orderParts.join(' &gt; ');
    return '<div class="round" data-level="' + rd.level + '">' +
      '<div class="round-head"><span class="round-idx">R' + (rd.seq + 1) + '</span>' +
      '<span class="round-title">' + title + '</span>' + lineage +
      '<span class="tag-why">' + kindText + '</span>' +
      (flips ? '<span class="tag-flip">' + (rd.kind === 'h2h' ? '头名换人' : '兜底改序') + '</span>' : '') + '</div>' +
      (flips ? '<p class="round-note flip">' +
        (rd.kind === 'h2h'
          ? '上一轮里队 ' + rd._prevFirst + ' 排在并列档的最前面；这 ' + rd.size + ' 队只重算彼此交手后，队 ' +
            rd._nowFirst + ' 反超到本档最前。'
          : '上一轮排在最前的队 ' + rd._prevFirst + ' 与同伴在组内积分、局差上都分不开，改用总局差后队 ' +
            rd._nowFirst + ' 排到本档最前。') +
        '</p>' : '') +
      '<p class="round-note">' + note + ' <b>' + used + '</b></p>' +
      '<div style="overflow-x:auto"><table><thead><tr><th>名次</th><th>队伍</th>' +
      '<th class="num">组内分</th><th class="num">组内局差</th><th class="num">总局差</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<p class="round-out">本轮分出：<b>' + orderLine + '</b>' +
      (rd.rankStart <= K && rd.rankStart + rd.size - 1 >= K ? ' · 出线线落在本组内' : '') + '</p>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */
  function exportStats() {
    var s = state.summary;
    var pend = pendingBySlot();
    function witness(arr) {
      if (!arr) return null;
      return pend.map(function (m, i) {
        return { match: m.id, candidate: arr[i], score: m.candidates[arr[i]] };
      });
    }
    var out = {
      exportedAt: new Date().toISOString(),
      qualifiers: state.qualifiers,
      teamCount: state.engine ? state.engine.teamIds.length : 0,
      completeScenarios: s ? s.total : 0,
      totalWithoutLocks: state.analysis ? state.analysis.totalAll : 0,
      locks: state.locks,
      order: '按比赛编号升序、候选位置升序取第一组',
      teams: s ? s.teams.map(function (t) {
        return {
          team: t.id,
          qualify: t.qualify,
          eliminate: t.eliminate,
          qualifyPercent: Number(pct(t.qualify, s.total).toFixed(4)),
          rankCounts: t.rankHist,
          earliestQualify: witness(t.earliestQualify),
          earliestEliminate: witness(t.earliestEliminate)
        };
      }) : []
    };
    return JSON.stringify(out, null, 2);
  }

  function exportStatsCsv() {
    var s = state.summary;
    var pend = pendingBySlot();
    function code(arr) {
      if (!arr) return '';
      return pend.map(function (m, i) { return m.id + '#' + arr[i]; }).join(';');
    }
    var lines = ['队号,出线赛果数,未出线赛果数,出线比例,最早出线赛果,最早未出线赛果'];
    s.teams.forEach(function (t) {
      lines.push([t.id, t.qualify, t.eliminate, pct(t.qualify, s.total).toFixed(2) + '%',
        '"' + code(t.earliestQualify) + '"', '"' + code(t.earliestEliminate) + '"'].join(','));
    });
    return lines.join('\n');
  }

  function exportScenario() {
    var sc = currentScenario();
    if (!sc) return '';
    var pend = pendingBySlot();
    var out = {
      exportedAt: new Date().toISOString(),
      team: sc.teamId,
      rank: sc.rank + 1,
      qualified: sc.qualified,
      qualifiers: state.qualifiers,
      scenario: pend.map(function (m, i) {
        return { match: m.id, candidate: sc.assignment[i], score: m.candidates[sc.assignment[i]], locked: Object.prototype.hasOwnProperty.call(state.locks, m.id) };
      }),
      standings: sc.replay.standings.map(function (r) {
        return { rank: r.rank, team: r.id, points: r.points, diff: r.diff, qualified: r.qualified };
      }),
      rounds: sc.replay.rounds.map(function (rd) {
        return {
          round: rd.seq + 1, level: rd.level, kind: rd.kind, totalPoints: rd.points,
          rankFrom: rd.rankStart, size: rd.size, usedMatches: rd.usedMatches,
          rows: rd.rows.map(function (r) {
            return { rank: r.rank, team: r.id, headToHeadPoints: r.hp, headToHeadDiff: r.hd, totalDiff: r.diff };
          })
        };
      })
    };
    return JSON.stringify(out, null, 2);
  }

  /* ------------------------------------------------------------------ */
  /* dialogs                                                             */
  /* ------------------------------------------------------------------ */
  var dlg = { el: null, closeBtn: null, titleEl: null, bodyEl: null, footEl: null, onClose: null };

  function openDialog(title, bodyHTML, footHTML) {
    dlg.titleEl.textContent = title;
    dlg.bodyEl.innerHTML = bodyHTML;
    dlg.footEl.innerHTML = footHTML || '<button class="btn" data-close>关闭</button>';
    dlg.el.classList.remove('hidden');
    dlg.el.setAttribute('aria-hidden', 'false');
    var focusable = dlg.bodyEl.querySelector('textarea, input, button');
    if (focusable) setTimeout(function () { focusable.focus(); }, 20);
  }
  function closeDialog() {
    dlg.el.classList.add('hidden');
    dlg.el.setAttribute('aria-hidden', 'true');
  }

  function openImport() {
    var html = '<p class="mono-note">支持 samples/league-cutline.json 的格式：最多 8 队，每对最多两场，待定比赛最多 14 场，每场 1–3 个候选比分。</p>' +
      '<div class="file-row"><input type="file" id="file-input" accept=".json,application/json">' +
      '<span class="mono-note">或直接粘贴 JSON</span></div>' +
      '<textarea id="import-text" spellcheck="false" placeholder="粘贴 JSON 后点“载入数据”"></textarea>' +
      '<div class="err" id="import-err"></div>';
    var foot = '<button class="btn" data-act="load-sample">示例数据</button>' +
      '<button class="btn" data-act="load-flip">头名换人示例</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn primary" data-act="import">载入数据</button>';
    openDialog('导入数据', html, foot);
    $('#file-input').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        $('#import-text').value = String(reader.result);
        $('#import-err').textContent = '';
      };
      reader.onerror = function () { $('#import-err').textContent = '读不到这个文件，试试直接粘贴内容。'; };
      reader.readAsText(f);
    });
  }

  function loadData(rawText) {
    var raw;
    try { raw = JSON.parse(rawText); }
    catch (e) { $('#import-err').textContent = 'JSON 解析失败：' + e.message; return; }
    try {
      var model = Engine.normalize(raw);
      state.data = raw;
      state.qualifiers = model.qualifiers;
      state.locks = {};
      state.selection = null;
      $('#dataset-note').textContent = '导入的数据 · ' + model.n + ' 队 · ' + model.pending.length + ' 场待定';
      closeDialog();
      save();
      recompute();
    } catch (err) {
      $('#import-err').textContent = err && err.message ? err.message : String(err);
    }
  }

  function openExport() {
    var stats = exportStats();
    var csv = exportStatsCsv();
    var scen = exportScenario();
    var tabs = '<div class="tabs"><button class="tab on" data-tab="stats">统计 JSON</button>' +
      '<button class="tab" data-tab="csv">统计 CSV</button>' +
      '<button class="tab" data-tab="scen">当前赛果 JSON</button></div>';
    var body = tabs + '<textarea id="export-text" readonly spellcheck="false">' + esc(stats) + '</textarea>' +
      '<p class="mono-note" id="export-note">赛果按“比赛编号#候选位置”记录；候选位置从 0 开始。</p>';
    var foot = '<span class="spacer"></span><button class="btn" data-close>关闭</button>' +
      '<button class="btn primary" data-act="copy-export">复制内容</button>';
    openDialog('导出统计与赛果', body, foot);
    var contents = { stats: stats, csv: csv, scen: scen };
    var noteText = {
      stats: '统计包含每队出线 / 未出线赛果数、名次分布，以及两类各自的第一组可复演赛果。',
      csv: '同样的统计，CSV 两列赛果用 比赛编号#候选位置 表示，分号分隔。',
      scen: '当前回放的赛果，含最终总榜和每一次重算的小榜。'
    };
    dlg.el.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-tab');
        dlg.el.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('on', x === b); });
        $('#export-text').value = contents[key] || (key === 'scen' ? '还没有选择赛果。' : '');
        $('#export-note').textContent = noteText[key];
      });
    });
    if (!scen) {
      var scenTab = dlg.el.querySelector('[data-tab="scen"]');
      scenTab.textContent = '当前赛果（未选）';
    }
  }

  function openRules() {
    var html = '<ul class="rules-list">' +
      '<li><b>积分</b>：胜 3 分、平 1 分、负 0 分；局差按每场比分差累加。</li>' +
      '<li><b>总分同分</b>：先按组内交手积分、再按组内局差分组，只看同分组彼此之间实际列出的比赛。</li>' +
      '<li><b>递归</b>：分出的非单例小组继续只用该组自己的比赛重算，直到每组只剩一队。把第三队排出去以后，剩下的队伍往往要重新算交手，榜首可能在下一轮换人。</li>' +
      '<li><b>兜底</b>：整组成员在组内积分、组内局差上完全一样时，才用总局差、队号升序。</li>' +
      '<li><b>统计</b>：对每一组完整赛果精确计数，不抽样；锁定某场比赛后只枚举其余待定比赛。</li>' +
      '<li><b>最早赛果</b>：按比赛编号升序、候选位置升序枚举，第一个满足条件的组合即为可复演赛果。</li>' +
      '</ul>';
    openDialog('排序与统计规则', html, '<span class="spacer"></span><button class="btn" data-close>知道了</button>');
  }

  function copyText(text, button, fallbackTitle) {
    var flash = function (label) {
      if (!button) return;
      var old = button.textContent;
      button.textContent = label;
      setTimeout(function () { button.textContent = old; }, 1600);
    };
    var manual = function () {
      if (button) flash('请手动复制');
      var ta = $('#export-text');
      if (ta) { ta.focus(); ta.select(); return; }
      // Copying was refused (some desktop app views): show the text to select.
      openDialog(fallbackTitle || '复制内容',
        '<textarea id="copy-fallback" readonly spellcheck="false">' + esc(text) + '</textarea>' +
        '<p class="mono-note">选中上面的内容后按 Ctrl/Cmd+C 复制。</p>',
        '<span class="spacer"></span><button class="btn" data-close>关闭</button>');
      var area = $('#copy-fallback');
      if (area) { area.focus(); area.select(); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash('已复制'); }, manual);
    } else {
      manual();
    }
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */
  function selectScenario(teamId, rank) {
    if (!state.analysis || !state.summary) return;
    var t = null;
    for (var i = 0; i < state.summary.teams.length; i++) {
      if (state.summary.teams[i].id === teamId) { t = state.summary.teams[i]; break; }
    }
    if (!t || rank === null || rank === undefined || !t.rankHist[rank]) return;
    state.selection = { teamId: teamId, rank: Number(rank) };
    renderTeams();
    renderScenario();
    var root = $('#scenario');
    if (root && root.scrollIntoView) root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function bind() {
    dlg.el = $('#dialog');
    dlg.titleEl = $('#dlg-title');
    dlg.bodyEl = $('#dlg-body');
    dlg.footEl = $('#dlg-foot');

    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-act], [data-close]');
      if (!t) return;
      if (t.hasAttribute('data-close')) { closeDialog(); return; }
      var act = t.getAttribute('data-act');

      if (act === 'scenario') {
        var rank = t.getAttribute('data-rank');
        if (rank === null || rank === 'null') return;
        selectScenario(Number(t.getAttribute('data-team')), Number(rank));
      } else if (act === 'rank') {
        selectScenario(Number(t.getAttribute('data-team')), Number(t.getAttribute('data-rank')));
      } else if (act === 'toggle-lock') {
        var id = Number(t.getAttribute('data-match'));
        var ci = Number(t.getAttribute('data-cand'));
        if (state.locks[id] === ci) delete state.locks[id];
        else state.locks[id] = ci;
        save();
        recompute();
      } else if (act === 'unlock-all') {
        state.locks = {};
        save();
        recompute();
      } else if (act === 'import') {
        loadData($('#import-text').value);
      } else if (act === 'load-sample' || act === 'load-flip') {
        var source = act === 'load-flip' ? window.SAMPLE_FLIP : window.SAMPLE_DATA;
        state.data = JSON.parse(JSON.stringify(source));
        state.qualifiers = state.data.qualifiers;
        state.locks = {};
        state.selection = null;
        $('#dataset-note').textContent = sampleNote(state.data);
        closeDialog();
        save();
        recompute();
      } else if (act === 'export') {
        openExport();
      } else if (act === 'copy-export') {
        copyText($('#export-text').value, t);
      } else if (act === 'copy-scenario') {
        copyText(exportScenario(), t, '赛果 JSON');
      } else if (act === 'lock-scenario') {
        var sc = currentScenario();
        if (!sc) return;
        var standing = null;
        for (var si = 0; si < sc.replay.standings.length; si++) {
          if (sc.replay.standings[si].id === sc.teamId) standing = sc.replay.standings[si];
        }
        state.locks = assignmentMap(sc.assignment);
        // The locked scenario is the only one left, so keep showing it.
        state.restoreSel = standing ? { teamId: sc.teamId, rank: standing.rank - 1 } : null;
        save();
        recompute();
      } else if (act === 'rules') {
        openRules();
      } else if (act === 'import-open') {
        openImport();
      }
    });

    $('#q-minus').addEventListener('click', function () {
      if (state.qualifiers <= 0) return;
      state.qualifiers--;
      save();
      applyQualifiers();
    });
    $('#q-plus').addEventListener('click', function () {
      var n = state.engine ? state.engine.teamIds.length : 8;
      if (state.qualifiers >= n) return;
      state.qualifiers++;
      save();
      applyQualifiers();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !dlg.el.classList.contains('hidden')) closeDialog();
    });
    dlg.el.addEventListener('click', function (ev) {
      if (ev.target === dlg.el) closeDialog();
    });
  }

  /* Qualifier count never changes the enumeration: ranks are independent of
     how many places qualify, so re-summarize instantly. */
  function applyQualifiers() {
    if (state.analysis) {
      state.summary = Engine.summarize(state.analysis, state.qualifiers);
      if (state.engine) state.engine.setQualifiers(state.qualifiers);
      pruneSelection();
      renderAll(false);
    } else {
      renderControls(state.busy);
    }
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  function sampleNote(data) {
    try {
      if (window.SAMPLE_FLIP && JSON.stringify(data) === JSON.stringify(window.SAMPLE_FLIP)) return '示例 · 头名换人';
    } catch (e) { /* fall through */ }
    return '示例数据 · samples/league-cutline.json';
  }

  function boot() {
    bind();
    var saved = restore();
    var data;
    if (saved) {
      data = saved.data;
      state.qualifiers = saved.qualifiers;
      state.locks = saved.locks || {};
    } else {
      data = JSON.parse(JSON.stringify(window.SAMPLE_DATA));
      state.qualifiers = data.qualifiers;
      state.locks = {};
    }
    try {
      var model = Engine.normalize(data);
      state.data = data;
      if (typeof state.qualifiers !== 'number' || state.qualifiers < 0 || state.qualifiers > model.n) {
        state.qualifiers = model.qualifiers;
      }
      state.engine = Engine.create(state.data, { qualifiers: state.qualifiers, locks: state.locks });
      $('#dataset-note').textContent = saved ? '本机上次的数据' : sampleNote(state.data);
    } catch (err) {
      try {
        state.data = JSON.parse(JSON.stringify(window.SAMPLE_DATA));
        state.qualifiers = state.data.qualifiers;
        state.locks = {};
        state.engine = Engine.create(state.data, { qualifiers: state.qualifiers, locks: {} });
      } catch (e2) {
        state.data = null;
      }
    }
    if (!state.data) return;
    state.autoSelect = true;
    renderAll(true);
    recompute();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
