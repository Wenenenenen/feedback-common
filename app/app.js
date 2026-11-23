/* Page application.  Rendered by the build into index.html after the solver
 * and session sources.  Heavy probability work runs in a Worker built from an
 * inline blob so the page stays responsive; without Worker support (or for very
 * small decks) the same values are computed on the main thread. */
/* global ExpeditionSolver, ExpeditionSession, WORKER_SOURCE */
(function () {
  'use strict';
  var S = window.ExpeditionSolver;
  var Session = window.ExpeditionSession.Session;

  var STORAGE_KEY = 'expedition-draw-policy:v1';
  var SAMPLE = window.EXPEDITION_SAMPLE;

  var el = {
    roundBody: document.getElementById('round-body'),
    roundCount: document.getElementById('round-count'),
    valueBody: document.getElementById('value-body'),
    valueAside: document.getElementById('value-aside'),
    goalBody: document.getElementById('goal-body'),
    deckBody: document.getElementById('deck-body'),
    deckAside: document.getElementById('deck-aside'),
    logBody: document.getElementById('log-body'),
    logAside: document.getElementById('log-aside'),
    undoBtn: document.getElementById('undo-btn'),
    resetBtn: document.getElementById('reset-btn'),
    deckInput: document.getElementById('deck-input'),
    deckLoad: document.getElementById('deck-load'),
    deckSample: document.getElementById('deck-sample'),
    deckFile: document.getElementById('deck-file'),
    recordOut: document.getElementById('record-out'),
    recordIn: document.getElementById('record-in'),
    importBtn: document.getElementById('import-btn'),
    copyBtn: document.getElementById('copy-btn'),
    copyState: document.getElementById('copy-state'),
    recordMessage: document.getElementById('record-message'),
    footnote: document.getElementById('footnote')
  };

  var session = null;
  var preview = null;          // { index } — a trial take, not committed
  var notice = null;           // { kind, text }
  var position = null;         // session.position() for the current frame
  var values = null;           // { value, roundStartValue, options } or null
  var computing = false;
  var seq = 0;                 // position version; stale results are dropped
  var reqId = 0;               // worker request ids

  /* ---------------- worker plumbing ---------------- */

  var worker = null;
  var workerBroken = false;
  var pending = {};            // id -> { resolve, reject }

  function workerUsable() {
    return !workerBroken &&
      typeof Worker !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function';
  }

  function postInit(target) {
    if (!target) return;
    target.postMessage({ type: 'init', id: 'init-' + (++reqId), deck: session.deck.raw });
  }

  function startWorker() {
    if (!workerUsable()) return null;
    if (worker) return worker;
    try {
      var blob = new Blob([String(WORKER_SOURCE)], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = function (ev) {
        var m = ev.data || {};
        var entry = pending[m.id];
        if (!entry) return;
        delete pending[m.id];
        if (m.type === 'error') entry.reject(new Error(m.message));
        else entry.resolve(m);
      };
      worker.onerror = function () {
        workerBroken = true;
        var waiting = Object.keys(pending);
        waiting.forEach(function (id) {
          var entry = pending[id];
          delete pending[id];
          entry.reject(new Error('worker 出错'));
        });
      };
      postInit(worker);
      return worker;
    } catch (e) {
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function workerRequest(message) {
    var w = startWorker();
    if (!w) return Promise.reject(new Error('no worker'));
    var id = 'q' + (++reqId);
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      w.postMessage(Object.assign({ id: id }, message));
    });
  }

  /* ---------------- value computation ---------------- */

  function fractionFromWire(w) {
    return S.frac(BigInt(w.n), BigInt(w.d));
  }

  function localValues(query) {
    if (!query) return null;
    var engine = session.engine;
    var out = { value: null, roundStartValue: null, options: null };

    if (query.kind === 'decide') {
      var result = engine.takeOptions(query.state, query.held);
      out.value = result.bestValue;
      out.options = result.options.map(function (o, i) {
        return {
          index: o.index,
          legal: o.legal,
          reason: o.reason,
          recommended: i === result.bestIndex,
          value: o.legal ? o.value : null
        };
      });
    } else if (query.kind === 'after') {
      out.value = engine.afterRevealsValue(query.state, query.held);
    } else {
      out.value = engine.preValue(query.state);
    }

    if (query.roundStart) out.roundStartValue = engine.preValue(query.roundStart);
    return out;
  }

  function requestValues(query) {
    if (!query) return Promise.resolve(null);
    // Tiny positions are computed inline: a worker round-trip would only add
    // a flicker of "calculating".
    var small = session.deck.totalCards <= 9 && session.deck.rounds <= 3;
    if (small || !workerUsable()) {
      return Promise.resolve(localValues(query));
    }
    return workerRequest({
      kind: query.kind,
      state: query.state,
      held: query.held,
      roundStart: query.roundStart
    }).then(function (m) {
      return {
        value: fractionFromWire(m.value),
        roundStartValue: m.roundStart ? fractionFromWire(m.roundStart) : null,
        options: m.options ? m.options.map(function (o) {
          return {
            index: o.index,
            legal: o.legal,
            reason: o.reason,
            recommended: o.recommended,
            value: o.value ? fractionFromWire(o.value) : null
          };
        }) : null
      };
    });
  }

  /* ---------------- refresh pipeline ---------------- */

  function refresh() {
    position = session.position();
    values = null;
    var mySeq = ++seq;
    var query = session.valueQuery();

    if (!query) {
      // Success, or a game that ran out of cards/rounds: the value follows
      // from the phase with no work.
      values = {
        value: position.phase === 'success' ? S.ONE : S.ZERO,
        roundStartValue: null,
        options: null
      };
      if (position.takes) {
        values.options = position.takes.map(function (t) {
          return { index: t.index, legal: t.legal, reason: t.reason, recommended: false, value: null };
        });
      }
      computing = false;
      render();
      return;
    }

    computing = true;
    render();

    requestValues(query).then(function (result) {
      if (mySeq !== seq) return; // a newer position superseded this one
      values = result;
      computing = false;
      render();
      persist();
    }, function (err) {
      if (mySeq !== seq) return;
      // Worker died or failed: fall back to the main thread once.
      workerBroken = true;
      try {
        values = localValues(session.valueQuery());
        computing = false;
      } catch (e2) {
        notice = { kind: 'error', text: '概率计算失败：' + (e2.message || e2) };
        computing = false;
      }
      render();
    });
  }

  /* ---------------- formatting ---------------- */

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fracHTML(f) {
    return '<span class="frac">' + esc(S.fToString(f)) +
      ' <span class="pc">' + esc(S.fPercent(f)) + '</span></span>';
  }

  function barWidth(f) {
    var hundredths = Number((f.n * 10000n) / f.d); // percent * 100
    return Math.max(0, Math.min(100, hundredths / 100));
  }

  function cardChips(t) {
    var parts = ['<span class="eff ' + (t.points > 0 ? 'up' : t.points < 0 ? 'down' : 'zero') + '">' +
      (t.points === 0 ? '分数 ±0' : (t.points > 0 ? '+' : '') + t.points + ' 分') + '</span>'];
    if (t.tickets !== 0) {
      parts.push('<span class="eff ' + (t.tickets > 0 ? 'up' : 'down') + '">' +
        (t.tickets > 0 ? '+' : '') + t.tickets + ' 券</span>');
    }
    (t.badges || []).forEach(function (b) {
      parts.push('<span class="eff up">徽章 ' + esc(b) + '</span>');
    });
    return parts.join('');
  }

  /* ---------------- rendering ---------------- */

  function phasePill() {
    if (position.phase === 'success') return '<span class="pill win">已成功</span>';
    if (position.failed) return '<span class="pill lose">已失败</span>';
    if (position.phase === 'pre') return '<span class="pill live">待揭第一张</span>';
    if (position.phase === 'revealing') return '<span class="pill live">已揭一张</span>';
    return '<span class="pill live">请选择拿法</span>';
  }

  function optionOf(i) {
    if (!values || !values.options) return null;
    return values.options[i] || null;
  }

  function renderRound() {
    var st = position.state;
    var html = '<div class="status-row">' + phasePill() +
      '<span class="round-count">未知牌堆 ' + st.unknown.reduce(function (a, x) { return a + x.count; }, 0) +
      ' 张 · 公开队尾 ' + st.tail.length + ' 张</span></div>';

    if (position.endReason) {
      html += '<div class="message ' + (position.phase === 'success' ? 'ok' : 'warn') +
        '" style="margin-bottom:13px">' + esc(position.endReason) + '</div>';
    }

    if (position.phase === 'pre' || position.phase === 'revealing') {
      var need = position.revealTarget - position.held.length;
      html += '<div class="section-label">补录实际揭出的牌' +
        (position.phase === 'revealing' ? '（还需 ' + need + ' 张）' : '') + '</div>';
      if (position.reveals.length) {
        html += '<div class="reveal-grid">';
        position.reveals.forEach(function (r) {
          html += '<button class="reveal-btn" type="button" data-reveal="' + esc(r.name) + '">' +
            '<span class="nm">' + esc(r.name) + '</span>' +
            '<span class="meta">此牌还剩 ' + r.count + ' 张</span>' +
            '<span class="pct">P = ' + esc(S.fToString(r.prob)) + ' · ' + esc(S.fPercent(r.prob)) + '</span>' +
            '</button>';
        });
        html += '</div>';
      } else {
        html += '<p class="empty-note">当前没有可揭出的牌。</p>';
      }
    }

    if (position.held.length) {
      html += '<div class="section-label" style="margin-top:16px">本拍已揭</div><div class="tiles">';
      position.held.forEach(function (h, i) {
        var opt = position.takes ? position.takes[i] : null;
        var vals = optionOf(i);
        var best = vals && vals.recommended;
        html += '<div class="tile' + (best ? ' best' : '') + '">' +
          '<div class="tile-top"><span class="nm">' + esc(h.name) + '</span>' +
          (vals && vals.legal && vals.value ? '<span class="val">' + esc(S.fToString(vals.value)) + '</span>'
            : (computing ? '<span class="val muted">…</span>' : '')) +
          '</div><div class="effects">' + cardChips(h) + '</div>';
        if (!opt) {
          html += '<div class="tile-foot"><span class="hint">收牌中…</span></div>';
        } else if (!opt.legal) {
          html += '<div class="tile-foot"><span class="why">' + esc(opt.reason) + '</span></div>';
        } else {
          html += '<div class="tile-foot">' +
            '<button class="btn primary small" type="button" data-take="' + i + '">拿这张</button>' +
            '<button class="btn small" type="button" data-preview="' + i + '">试选</button>' +
            (best ? '<span class="hint">建议</span>' : '') +
            '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
      if (position.takes) {
        html += '<p class="hint" style="margin-top:9px">数字是拿它之后的最优成功率；同率时取揭示顺序靠前的一张。</p>';
      }
    }

    if (preview !== null && position.takes && position.takes[preview] && position.takes[preview].legal) {
      var pv = position.takes[preview];
      var applied = session.engine.applyTake(session.state, session.held, preview);
      var nd = S.describeState(session.deck, applied);
      var pvValue = optionOf(preview);
      html += '<div class="preview"><h3>试选：拿「' + esc(pv.name) + '」（尚未提交）</h3><div class="row">' +
        '<span class="chip">分数 <b>' + nd.points + '</b></span>' +
        '<span class="chip">通行券 <b>' + nd.tickets + '</b></span>' +
        '<span class="chip">徽章 <b>' + (nd.badges.length ? nd.badges.map(esc).join('、') : '无') + '</b></span>' +
        '<span class="chip">剩余拍数 <b>' + nd.roundsLeft + '</b></span>' +
        '<span class="chip">此拿法成功率 <b>' +
        (pvValue && pvValue.value ? esc(S.fToString(pvValue.value)) : (computing ? '计算中' : '—')) +
        '</b></span></div><div class="actions">' +
        '<button class="btn primary small" type="button" data-take="' + preview + '">确认此拿法</button>' +
        '<button class="btn small" type="button" data-preview-cancel="1">取消试选</button>' +
        '</div></div>';
    }

    el.roundBody.innerHTML = html;
    el.roundCount.textContent = '第 ' + (session.deck.rounds - position.state.roundsLeft + 1) +
      ' 拍 / 共 ' + session.deck.rounds + ' 拍';
  }

  function renderValue() {
    var html = '';
    var shown = values ? (values.roundStartValue || values.value) : null;
    var exact = values ? values.value : null;
    var label = values && values.roundStartValue ? '本拍揭牌前' : '当前局面';

    if (!shown) {
      html += '<div class="readout"><div class="big-frac">计算中…' +
        '<span class="pc">正在按最优策略汇总概率</span></div>' +
        '<div class="bar"><span style="width:0"></span></div></div>';
    } else {
      html += '<div class="readout"><div class="big-frac">' + esc(S.fToString(shown)) +
        '<span class="pc">' + esc(S.fPercent(shown)) + ' · ' + label + '</span></div>' +
        '<div class="bar" role="img" aria-label="成功率 ' + esc(S.fPercent(shown)) + '">' +
        '<span style="width:' + barWidth(shown) + '%"></span></div></div>';
    }

    if (values && values.roundStartValue && exact) {
      html += '<p class="readout-note">已揭一张后，按公开信息继续的最优值为 ' +
        fracHTML(exact) + '。</p>';
    }

    if (values && values.options && values.options.length) {
      html += '<div class="value-table">';
      values.options.forEach(function (o, i) {
        var t = position.takes[i];
        html += '<div class="value-row' + (o.recommended ? ' best' : '') + '">' +
          '<span class="k">拿「' + esc(t.name) + '」' +
          (o.legal ? (o.recommended ? ' · 建议' : '') : ' · 不合法') + '</span>' +
          '<span class="v">' + (o.legal && o.value ? fracHTML(o.value) : '—') + '</span></div>';
      });
      html += '</div>';
    }

    el.valueBody.innerHTML = html;
    el.valueAside.textContent = position.phase === 'pre' ? '揭牌前'
      : (position.phase === 'revealing' ? '已揭一张' : '');
  }

  function renderGoal() {
    var deck = session.deck;
    var st = position.state;
    var html = '<div class="chips" style="margin-bottom:11px">' +
      '<span class="chip' + (st.points >= deck.goal.points ? ' met' : '') + '">分数 <b>' + st.points +
      '</b> / ' + deck.goal.points + '</span>' +
      '<span class="chip">通行券 <b>' + st.tickets + '</b></span>' +
      '<span class="chip">剩余拍数 <b>' + st.roundsLeft + '</b></span>';
    deck.goal.badges.forEach(function (b) {
      var has = st.badges.indexOf(b) >= 0;
      html += '<span class="chip ' + (has ? 'met' : 'badge') + '">' +
        (has ? '✓ ' : '') + '徽章 ' + esc(b) + '</span>';
    });
    if (!deck.goal.badges.length) html += '<span class="chip">无徽章目标</span>';
    html += '</div><p class="hint">' +
      (st.badges.length ? '已得徽章：' + st.badges.map(esc).join('、') : '尚未获得徽章') + '</p>';
    el.goalBody.innerHTML = html;
  }

  function renderDeck() {
    var deck = session.deck;
    var st = position.state;
    var unknownLeft = st.unknown.reduce(function (a, x) { return a + x.count; }, 0);
    el.deckAside.textContent = unknownLeft + ' 张未知 · ' + st.tail.length + ' 张在队尾';

    var html = '<div style="overflow-x:auto"><table class="deck-table">' +
      '<thead><tr><th>牌</th><th>分数</th><th>券</th><th>徽章</th><th>未知余量</th></tr></thead><tbody>';
    deck.types.forEach(function (t, i) {
      html += '<tr><td><strong>' + esc(t.name) + '</strong></td>' +
        '<td class="num">' + (t.points > 0 ? '+' : '') + t.points + '</td>' +
        '<td class="num">' + (t.tickets > 0 ? '+' : '') + t.tickets + '</td>' +
        '<td class="badge-list">' + (t.badges.length ? t.badges.map(esc).join('、') : '—') + '</td>' +
        '<td class="num">' + (st.unknownCounts[i] || 0) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    html += '<div class="tail-wrap"><div class="section-label">公开队尾（先揭队首）</div>';
    if (st.tail.length) {
      html += '<div class="tail-list">';
      st.tail.forEach(function (name, i) {
        html += '<span class="tail-card' + (i === 0 ? ' head' : '') + '">' + esc(name) + '</span>';
      });
      html += '</div>';
    } else {
      html += '<p class="empty-note">队尾为空。未拿的牌会按揭示顺序排到这里。</p>';
    }
    html += '</div>';
    el.deckBody.innerHTML = html;
  }

  function renderLog() {
    var log = position.log;
    el.logAside.textContent = position.actions + ' 个动作';
    if (!log.length) {
      el.logBody.innerHTML = '<p class="empty-note">还没有记录。揭出第一张牌后会出现在这里。</p>';
      return;
    }
    var html = '<div class="log">';
    log.forEach(function (r) {
      html += '<div class="log-round"><span class="no">' + String(r.round).padStart(2, '0') +
        '</span><div class="flow">';
      r.reveals.forEach(function (c, i) {
        if (i > 0) html += '<span class="arrow">·</span>';
        html += '<span class="log-chip">' + esc(c) + '</span>';
      });
      html += r.take
        ? '<span class="arrow">→ 拿</span><span class="log-chip kept">' + esc(r.take) + '</span>'
        : '<span class="arrow">→ 待拿</span>';
      html += '</div></div>';
    });
    html += '</div>';
    el.logBody.innerHTML = html;
  }

  function renderRecord() {
    el.recordOut.value = JSON.stringify(session.exportRecord(), null, 2);
    el.undoBtn.disabled = session.history.length === 0;
    el.resetBtn.disabled = false;
    if (notice) {
      el.recordMessage.innerHTML = '<div class="message ' + notice.kind + '">' + esc(notice.text) + '</div>';
    } else {
      el.recordMessage.innerHTML = '';
    }
  }

  function render() {
    if (!position) return;
    renderRound();
    renderValue();
    renderGoal();
    renderDeck();
    renderLog();
    renderRecord();
    el.footnote.textContent = '本轮牌组 ' + session.deck.totalCards + ' 张 · ' +
      session.deck.types.length + ' 种 · 上限 8 种 / 28 张 / 6 拍';
  }

  /* ---------------- actions ---------------- */

  function fail(message) {
    notice = { kind: 'error', text: message };
    render();
  }

  function afterChange() {
    persist();
    refresh();
  }

  function doReveal(name) {
    notice = null;
    try {
      session.reveal(name);
      preview = null;
      afterChange();
    } catch (e) { fail(e.message); }
  }

  function doTake(index) {
    notice = null;
    try {
      session.take(index);
      preview = null;
      afterChange();
    } catch (e) { fail(e.message); }
  }

  function doUndo() {
    notice = null;
    preview = null;
    if (session.undo()) afterChange();
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session.exportRecord()));
    } catch (e) { /* storage unavailable: the page still works */ }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return Session.fromRecord(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function useSession(next) {
    session = next;
    preview = null;
    notice = null;
    if (worker) {
      postInit(worker);
    }
    afterChange();
  }

  /* ---------------- wiring ---------------- */

  el.roundBody.addEventListener('click', function (ev) {
    var target = ev.target.closest('[data-reveal],[data-take],[data-preview],[data-preview-cancel]');
    if (!target) return;
    if (target.hasAttribute('data-reveal')) doReveal(target.getAttribute('data-reveal'));
    else if (target.hasAttribute('data-take')) doTake(Number(target.getAttribute('data-take')));
    else if (target.hasAttribute('data-preview')) {
      preview = Number(target.getAttribute('data-preview'));
      notice = null;
      render();
    } else {
      preview = null;
      render();
    }
  });

  el.undoBtn.addEventListener('click', doUndo);

  el.resetBtn.addEventListener('click', function () {
    var actions = session.actions.length;
    if (actions === 0) { preview = null; notice = null; render(); return; }
    if (el.resetBtn.getAttribute('data-armed') !== '1') {
      el.resetBtn.setAttribute('data-armed', '1');
      el.resetBtn.textContent = '确认清空 ' + actions + ' 步';
      window.setTimeout(function () {
        if (el.resetBtn.getAttribute('data-armed') === '1') {
          el.resetBtn.removeAttribute('data-armed');
          el.resetBtn.textContent = '重开本局';
        }
      }, 4000);
      return;
    }
    el.resetBtn.removeAttribute('data-armed');
    el.resetBtn.textContent = '重开本局';
    session.reset();
    preview = null;
    notice = null;
    afterChange();
  });

  el.deckLoad.addEventListener('click', function () {
    notice = null;
    try {
      useSession(Session.fromDeckRaw(JSON.parse(el.deckInput.value)));
    } catch (e) {
      fail('牌组无法载入：' + e.message);
    }
  });

  el.deckSample.addEventListener('click', function () {
    el.deckInput.value = JSON.stringify(SAMPLE, null, 2);
    notice = null;
    try { useSession(Session.fromDeckRaw(SAMPLE)); } catch (e) { fail(e.message); }
  });

  el.deckFile.addEventListener('change', function () {
    var file = el.deckFile.files && el.deckFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      notice = null;
      try {
        useSession(Session.fromDeckRaw(JSON.parse(text)));
        el.deckInput.value = text;
      } catch (e) {
        fail('文件无法载入：' + e.message);
      }
    };
    reader.onerror = function () { fail('读取文件失败。'); };
    reader.readAsText(file);
  });

  el.importBtn.addEventListener('click', function () {
    notice = null;
    var text = el.recordIn.value;
    if (!String(text).trim()) { fail('导入失败：请先粘贴要导入的记录'); return; }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      fail('导入失败：记录不是合法 JSON（' + e.message + '）');
      return;
    }
    var next;
    try {
      next = Session.fromRecord(parsed);
    } catch (e) {
      fail('导入失败：' + e.message);
      return;
    }
    el.recordIn.value = '';
    session = next;
    preview = null;
    notice = { kind: 'ok', text: '已导入记录，共 ' + next.actions.length + ' 个动作，可以接着算。' };
    if (worker) {
      postInit(worker);
    }
    afterChange();
  });

  el.copyBtn.addEventListener('click', function () {
    var text = el.recordOut.value;
    function done() {
      el.copyState.textContent = '已复制';
      window.setTimeout(function () { el.copyState.textContent = ''; }, 2200);
    }
    function selectIt() {
      el.recordOut.focus();
      el.recordOut.select();
      el.copyState.textContent = '已选中，请手动复制';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, selectIt);
    } else {
      selectIt();
    }
  });

  /* ---------------- boot ---------------- */

  function start(restored) {
    session = restored || Session.fromDeckRaw(SAMPLE);
    el.deckInput.value = JSON.stringify(session.deck.raw, null, 2);
    startWorker();
    afterChange();
  }

  var restored = restore();
  var hot = window.claude && window.claude.hot;
  if (hot) {
    var begin = function (data) {
      var fromHot = null;
      try {
        if (data && data.record) fromHot = Session.fromRecord(data.record);
      } catch (e) { fromHot = null; }
      start(fromHot || restored);
    };
    if (hot.ready) hot.ready(begin); else begin(null);
    if (hot.snapshot) {
      hot.snapshot(function () {
        try {
          return { record: session.exportRecord() };
        } catch (e) {
          return {};
        }
      });
    }
  } else {
    start(restored);
  }
}());
