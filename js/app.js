// 页面控制器：键盘驾驶、固定步推进、HUD、导入导出与一致性自检。
// 逻辑全部交给 engine / session / recorder；这里只负责 DOM 与渲染循环。
(function () {
  'use strict';

  var E = window.RallyEngine;
  var S = window.RallySession;
  var T = window.RallyTracks;

  var $ = function (id) {
    return document.getElementById(id);
  };

  var app = {
    track: null,
    session: null,
    input: null,
    renderer: null,
    ghostVisible: true,
    feeds: { violations: [], events: [] },
    cache: { hud: '', dots: '', laps: '', viol: '', events: '', controls: '', kv: '', ghost: '' },
  };

  // 键盘：W/↑ 油门，S/↓ 刹车（停住后继续按为倒车），A D/← → 转向
  var KEYMAP = {
    KeyW: 'up',
    ArrowUp: 'up',
    KeyS: 'down',
    ArrowDown: 'down',
    KeyA: 'left',
    ArrowLeft: 'left',
    KeyD: 'right',
    ArrowRight: 'right',
  };
  var held = { up: false, down: false, left: false, right: false };

  function readHold() {
    var forward = held.up ? 1 : 0;
    var backward = held.down ? 1 : 0;
    var speed = 0;
    if (app.session) speed = app.session.race.getState().v;
    // 行驶中按 ↓ 先当刹车；停稳后继续按才是倒车
    var braking = backward && speed > 0.05;
    var throttle = forward - backward;
    if (throttle < 0 && braking) throttle = 0;
    var steer = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    return { throttle: throttle, steer: steer, brake: braking };
  }

  // ------------------------------------------------------------ toast

  function toast(msg, kind, ms) {
    var layer = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    layer.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .22s, transform .22s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-5px)';
      setTimeout(function () {
        el.remove();
      }, 240);
    }, ms || 2600);
    while (layer.children.length > 4) layer.firstChild.remove();
    return el;
  }

  // ------------------------------------------------------------ format

  function fmtSec(t) {
    if (t == null || !isFinite(t)) return '—';
    return t.toFixed(3);
  }
  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '—';
    if (t < 60) return t.toFixed(3) + 's';
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  }
  function pad8(s) {
    return String(s || '00000000').padStart(8, '0');
  }
  function lastLapOf(laps) {
    return laps.length ? laps[laps.length - 1].time : null;
  }
  function bestLapOf(laps) {
    if (!laps.length) return null;
    return laps.reduce(function (m, l) {
      return m == null || l.time < m ? l.time : m;
    }, null);
  }

  // ------------------------------------------------------------ session

  function normalize(track, laps) {
    return E.normalizeTrack({
      name: track.name,
      params: track.params,
      initial: track.initial,
      gates: track.gates,
      laps: laps != null ? laps : track.laps,
      waypoints: track.waypoints,
      roadHalfWidth: track.roadHalfWidth,
    });
  }

  function startSession(opts) {
    opts = opts || {};
    var laps = opts.laps != null ? opts.laps : readLaps();
    var ghost = opts.ghost !== undefined ? opts.ghost : app.session ? app.session.ghost : null;
    var prepared = normalize(opts.track || app.track, laps);
    if (!prepared.ok) {
      toast('赛道无效：' + prepared.errors[0], 'bad', 4200);
      return false;
    }
    app.track = prepared.track;
    app.input = S.createKeyboardInput(readHold);
    var session;
    try {
      session = S.createSession({
        track: prepared.track,
        inputSource: opts.replay ? null : app.input,
        replay: opts.replay || null,
        ghost: ghost,
        lapsToFinish: opts.replay ? null : laps,
      });
    } catch (err) {
      toast('无法开始：' + err.message, 'bad', 4200);
      return false;
    }
    if (opts.replay) app.track = session.track;
    app.session = session;
    app.feeds = { violations: [], events: [] };
    app.cache = { hud: '', dots: '', laps: '', viol: '', events: '', controls: '', kv: '', ghost: '' };
    app.renderer.setTrack(app.track);
    app.renderer.clearTrails();
    bindSession(session);
    session.start(performance.now());
    renderFeeds();
    updateHud(true);
    updateControls(true);
    return true;
  }

  function bindSession(session) {
    session.on('cross', function (events) {
      // 同一步跨多门时，给每条事件标出整步的门数与序号
      var byTick = {};
      for (var i = 0; i < events.length; i++) {
        var key = events[i].tick;
        (byTick[key] || (byTick[key] = [])).push(events[i]);
      }
      for (var j = 0; j < events.length; j++) {
        var ev = events[j];
        var group = byTick[ev.tick];
        ev.stepGateCount = group.length;
        ev.stepGateIndex = group.indexOf(ev) + 1;
        if (ev.outcome === 'reverse' || ev.outcome === 'outOfOrder') {
          pushFeed('violations', ev);
          app.renderer.addEffect(ev.point[0], ev.point[1], 'violation');
        } else {
          pushFeed('events', ev);
          app.renderer.addEffect(ev.point[0], ev.point[1], ev.outcome === 'advance' ? 'pass' : ev.outcome);
        }
      }
      renderFeeds();
    });
    session.on('finish', function (result) {
      onFinished(result, false);
    });
    session.on('timeout', function (result) {
      onFinished(result, true);
    });
    session.on('restart', function () {
      app.feeds = { violations: [], events: [] };
      app.renderer.clearTrails();
      renderFeeds();
      updateHud(true);
      updateControls(true);
    });
    session.on('ghost', function () {
      updateHud(true);
    });
  }

  function pushFeed(kind, ev) {
    var arr = app.feeds[kind];
    arr.push(ev);
    if (arr.length > 60) arr.shift();
  }

  function onFinished(result, timedOut) {
    var laps = result.laps;
    if (timedOut) {
      toast('已达到 10000 逻辑步上限，本场结束', 'warn', 4600);
    } else if (laps.length) {
      var best = bestLapOf(laps);
      var ghost = app.session && app.session.ghost;
      var beat = ghost && ghost.bestLapTime != null && best < ghost.bestLapTime;
      toast(
        '完赛 · ' + laps.length + ' 圈 · 最快 ' + fmtTime(best) + (beat ? ' · 快过幽灵 ' + (ghost.bestLapTime - best).toFixed(3) + 's' : ''),
        beat ? 'good' : '',
        5400
      );
      app.renderer.addEffect(result.final.x, result.final.y, 'lap');
    }
    updateHud(true);
    updateControls(true);
  }

  function readLaps() {
    var v = parseInt($('laps-input').value, 10);
    if (!isFinite(v) || v < 1) v = 1;
    if (v > 99) v = 99;
    return v;
  }

  // ------------------------------------------------------------ HUD

  function setHtml(id, cacheKey, html) {
    if (app.cache[cacheKey] === html) return;
    app.cache[cacheKey] = html;
    $(id).innerHTML = html;
  }

  function updateHud(force) {
    var s = app.session;
    if (!s) return;
    var view = s.getView();
    var p = view.progress;

    // 状态灯
    var stateText =
      view.mode === 'replay'
        ? view.state === 'running'
          ? '回放中'
          : view.state === 'paused'
          ? '回放暂停'
          : view.state === 'finished'
          ? '回放结束'
          : '回放待机'
        : view.state === 'running'
        ? '行驶中'
        : view.state === 'paused'
        ? '已暂停'
        : view.state === 'finished'
        ? '已完赛'
        : '就绪';
    var ledKey = view.state + '|' + view.mode;
    if (app.cache.led !== ledKey) {
      app.cache.led = ledKey;
      $('state-led').className = 'led ' + (view.state === 'running' ? 'running' : view.state === 'paused' ? 'paused' : view.state === 'finished' ? 'finished' : '');
      $('state-text').textContent = stateText;
    }
    $('pill-tick').textContent = String(view.tick);
    $('pill-sum').textContent = pad8(view.checksum);

    // 目标门
    var card = $('target-card');
    var tKey = (p.finished ? 'f' : p.started ? 'r' : 'n') + '|' + p.expectedGate + '|' + p.currentLap;
    if (app.cache.target !== tKey) {
      app.cache.target = tKey;
      card.classList.toggle('done', !!p.finished);
      if (p.finished) {
        $('target-num').textContent = '✓';
        $('target-label').textContent = '完赛';
        $('target-name').textContent = '最快圈 ' + fmtTime(bestLapOf(view.laps));
      } else if (!p.started) {
        $('target-num').textContent = '0';
        $('target-label').textContent = '等待起步 · 正向穿过';
        $('target-name').textContent = '门 0 · 起点';
      } else {
        $('target-num').textContent = String(p.expectedGate);
        $('target-label').textContent = '第 ' + p.currentLap + ' 圈 · 正向穿过';
        $('target-name').textContent = '门 ' + p.expectedGate + (p.expectedGate === 0 ? ' · 终点' : '');
      }
    }

    // 门点阵
    var dots = $('gate-dots');
    var total = p.gatesPerLap;
    if (dots.childElementCount !== total) {
      dots.innerHTML = '';
      for (var i = 0; i < total; i++) {
        var d = document.createElement('div');
        d.className = 'dot';
        d.textContent = String(i);
        dots.appendChild(d);
      }
      app.cache.dotState = '';
    }
    var passedThisLap = p.started ? p.gatesThisLap : 0;
    var dotKey = (p.started ? 1 : 0) + '|' + (p.finished ? 1 : 0) + '|' + p.expectedGate + '|' + passedThisLap + '|' + total;
    if (app.cache.dotState !== dotKey) {
      app.cache.dotState = dotKey;
      for (var k = 0; k < dots.children.length; k++) {
        var targetIdx = p.finished ? -1 : p.started ? p.expectedGate : 0;
        var isTarget = k === targetIdx;
        var isDone = p.finished || k < passedThisLap;
        dots.children[k].className = 'dot' + (isDone ? ' done' : '') + (isTarget ? ' target' : '');
      }
    }

    // 计时（每帧更新）
    var curLap = p.started && !p.finished ? view.lapTime : p.finished ? lastLapOf(view.laps) : 0;
    var lapTxt = fmtSec(curLap);
    if ($('lap-time').textContent !== lapTxt + 's') {
      $('lap-time').innerHTML = lapTxt + '<small>s</small>';
      $('big-timer').innerHTML = lapTxt + '<small> s</small>';
    }
    $('last-lap').textContent = fmtTime(lastLapOf(view.laps));
    $('best-lap').textContent = fmtTime(bestLapOf(view.laps));
    var spd = Math.abs(view.car.v).toFixed(1);
    if ($('speed').textContent !== spd + 'm/s') $('speed').innerHTML = spd + '<small>m/s</small>';
    $('gate-progress').textContent =
      (p.started ? p.gatesThisLap : 0) + ' / ' + p.gatesPerLap + (p.currentLap ? ' · 第 ' + p.currentLap + ' 圈' : '');
    $('lap-hint').textContent = p.finished
      ? '已完成 ' + view.laps.length + ' 圈'
      : p.lapTarget
      ? '第 ' + (p.started ? p.currentLap : 1) + ' / ' + p.lapTarget + ' 圈'
      : '第 ' + (p.started ? p.currentLap : 1) + ' 圈';

    renderLapList(view);
    $('viol-count').textContent = view.violationCounts.outOfOrder + view.violationCounts.reverse + ' 次';

    // 右侧数据
    var kvKey = [app.track ? app.track.name : '', view.mode, view.tick, view.checksum].join('|');
    if (app.cache.kv !== kvKey) {
      app.cache.kv = kvKey;
      $('kv-track').textContent = app.track ? app.track.name : '—';
      $('kv-mode').textContent = view.mode === 'replay' ? '回放' : '驾驶';
      $('kv-ticks').textContent = String(view.tick);
      $('kv-sum').textContent = pad8(view.checksum);
      if (s.mode === 'drive') {
        var rp = s.exportReplay();
        $('kv-inputs').textContent = rp.inputs.length + ' 条变化';
      } else {
        $('kv-inputs').textContent = '只读回放';
      }
    }

    updateGhostInfo(view);
    if (force) updateControls(true);
  }

  function renderLapList(view) {
    var laps = view.laps;
    var key = laps.map(function (l) {
      return l.index + ':' + l.time;
    }).join(',');
    if (app.cache.laps === key) return;
    app.cache.laps = key;
    var el = $('lap-list');
    if (!laps.length) {
      el.innerHTML = '<div class="empty">完成第一圈后在此列出分圈成绩。</div>';
      return;
    }
    var best = bestLapOf(laps);
    var html = '';
    for (var i = laps.length - 1; i >= 0; i--) {
      var l = laps[i];
      var isBest = Math.abs(l.time - best) < 1e-9;
      html +=
        '<div class="lap-row' +
        (isBest ? ' best' : '') +
        '"><span class="n">L' +
        l.index +
        '</span><span class="t">' +
        fmtTime(l.time) +
        '</span><span class="b">' +
        (isBest ? 'BEST' : l.splits.length + ' 段') +
        '</span></div>';
    }
    el.innerHTML = html;
  }

  function renderFeeds() {
    renderViolations();
    renderEvents();
  }

  function renderViolations() {
    var key = app.feeds.violations.length + ':' + (app.feeds.violations.length ? app.feeds.violations[app.feeds.violations.length - 1].tick : 0);
    if (app.cache.viol === key) return;
    app.cache.viol = key;
    var el = $('violation-list');
    var arr = app.feeds.violations;
    if (!arr.length) {
      el.innerHTML = '<div class="empty">还没有违规记录。倒车穿门记“反向”，跳门记“顺序外”。</div>';
      return;
    }
    var html = '';
    for (var i = arr.length - 1; i >= 0; i--) {
      var v = arr[i];
      html +=
        '<div class="feed-row ' +
        (v.outcome === 'reverse' ? 'rev' : 'bad') +
        '"><span class="tm">' +
        v.time.toFixed(3) +
        's</span><span class="gt">门 ' +
        v.gate +
        '</span><span class="ms">' +
        (v.outcome === 'reverse' ? '反向穿门' : '顺序外 · 期望 ' + v.expectedBefore) +
        '</span></div>';
    }
    el.innerHTML = html;
  }

  function renderEvents() {
    var e0 = app.feeds.events;
    var key = e0.length + ':' + (e0.length ? e0[e0.length - 1].tick + ':' + e0[e0.length - 1].gate : 0);
    if (app.cache.events === key) return;
    app.cache.events = key;
    var el = $('event-feed');
    var arr = app.feeds.events;
    if (!arr.length) {
      el.innerHTML = '<div class="empty">起步穿过 0 号门后开始计时。</div>';
      return;
    }
    var html = '';
    for (var i = arr.length - 1; i >= 0; i--) {
      var ev = arr[i];
      var text =
        ev.outcome === 'start'
          ? '起步 · 开始计时'
          : ev.outcome === 'lap'
          ? '收圈 · 完成一圈并开始下一圈'
          : '顺序推进';
      var multi = ev.stepGateCount > 1 ? ' <b class="multi">同一步 ' + ev.stepGateIndex + '/' + ev.stepGateCount + ' 门</b>' : '';
      html +=
        '<div class="feed-row ok"><span class="tm">' +
        ev.time.toFixed(3) +
        's</span><span class="gt">门 ' +
        ev.gate +
        '</span><span class="ms">' +
        text +
        ' · t=' +
        ev.t.toFixed(4) +
        multi +
        '</span></div>';
    }
    el.innerHTML = html;
  }

  function updateGhostInfo(view) {
    var s = app.session;
    if (!s) return;
    var g = s.ghost;
    var pill = $('pill-ghost');
    var show = !!(g && app.ghostVisible);
    if (pill.hidden !== !show) pill.hidden = !show;
    if (show) {
      var txt = '幽灵';
      if (g.bestLapTime != null) txt += ' ' + g.bestLapTime.toFixed(2) + 's';
      $('ghost-pill-text').textContent = txt;
    }
    var key = [g ? 1 : 0, app.ghostVisible, g && g.ticks, Math.floor(view.tick / 15)].join('|');
    if (app.cache.ghost === key) return;
    app.cache.ghost = key;
    $('ghost-source').textContent = g ? (g.meta && g.meta.label ? g.meta.label : '上次运行') : '无';
    var gt = null;
    if (g) gt = g.bestLapTime != null ? g.bestLapTime : g.lapTime != null ? g.lapTime : null;
    $('ghost-time').textContent = gt != null ? fmtTime(gt) : g ? '未收圈' : '—';
    $('ghost-progress').textContent = g && view ? Math.min(100, (view.tick / Math.max(1, g.ticks)) * 100).toFixed(1) + '% · ' + g.ticks + ' 步' : '—';
  }

  function updateControls(force) {
    var s = app.session;
    if (!s) return;
    var key = [s.state, s.mode, app.ghostVisible, app.renderer.getCameraMode(), !!s.ghost].join('|');
    if (!force && app.cache.controls === key) return;
    app.cache.controls = key;
    var st = s.state;
    var startBtn = $('btn-start');
    startBtn.disabled = st === 'running';
    startBtn.innerHTML = st === 'finished' ? '<span class="t">重新开始</span> <kbd>R</kbd>' : '<span class="t">开始</span> <kbd>⏎</kbd>';
    var pauseBtn = $('btn-pause');
    pauseBtn.disabled = st !== 'running' && st !== 'paused';
    pauseBtn.innerHTML = st === 'paused' ? '<span class="t">继续</span> <kbd>Space</kbd>' : '<span class="t">暂停</span> <kbd>Space</kbd>';
    $('btn-ghost-toggle').classList.toggle('ghost-on', app.ghostVisible && !!s.ghost);
    $('chk-ghost').checked = app.ghostVisible;
    $('btn-camera').innerHTML = '<span class="t">' + (app.renderer.getCameraMode() === 'fit' ? '全景' : '跟随') + '</span>';
    var endBtn = $('btn-replay-end');
    if (endBtn) endBtn.hidden = s.mode !== 'replay';
  }

  // ------------------------------------------------------------ render loop

  function frameLoop(now) {
    var dt = now - (app.lastNow || now);
    app.lastNow = now;
    if (dt < 0) dt = 0;
    if (dt > 100) dt = 100;

    var s = app.session;
    if (s) {
      // 固定帧率模式下由 advanceFixedFrames 手动推进，rAF 只负责绘制
      if (!app.fixedFrameRate) s.frame(now);
      var view = s.getView(now);
      app.renderer.pushTrail(view, dt);
      app.renderer.draw(view, dt);
      updateHud(false);
    }
    requestAnimationFrame(frameLoop);
  }

  // ------------------------------------------------------------ keyboard

  function onKeyDown(e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // 模态框打开时只响应 Esc（关闭），不响应驾驶键
    if (!$('modal-back').hidden) return;
    var action = KEYMAP[e.code];
    if (action) {
      e.preventDefault();
      held[action] = true;
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) togglePause();
    } else if (e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat) onStart();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      if (!e.repeat) onRestart();
    } else if (e.code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) togglePause();
    }
  }

  function onKeyUp(e) {
    var action = KEYMAP[e.code];
    if (action) {
      e.preventDefault();
      held[action] = false;
    }
  }

  function clearHeld() {
    for (var k in held) held[k] = false;
  }

  // ------------------------------------------------------------ actions

  function onStart() {
    if (!app.session) return;
    if (app.session.state === 'finished') {
      onRestart();
      return;
    }
    app.session.start(performance.now());
    updateControls(true);
    updateHud(true);
  }

  function togglePause() {
    if (!app.session) return;
    if (app.session.state === 'ready') {
      app.session.start(performance.now());
    } else {
      app.session.togglePause(performance.now());
    }
    updateControls(true);
    updateHud(true);
  }

  function onRestart() {
    if (!app.session) return;
    var captured = app.session.restart({ nowMs: performance.now() });
    app.feeds = { violations: [], events: [] };
    app.renderer.clearTrails();
    renderFeeds();
    updateHud(true);
    updateControls(true);
    toast(captured ? '已重开 · 上次运行已存为幽灵' : '已重开', captured ? 'good' : '', 2200);
  }

  // ------------------------------------------------------------ modal

  var modal = {
    onAction: null,
    open: function (opts) {
      $('modal-title').textContent = opts.title || '导入';
      $('modal-note').textContent = opts.note || '';
      $('modal-note').className = 'note';
      $('modal-status').textContent = opts.status || '';
      $('modal-status').className = 'note';
      var ta = $('modal-text');
      ta.value = opts.text || '';
      ta.readOnly = !!opts.readOnly;
      $('modal-action').textContent = opts.actionLabel || '导入';
      $('modal-back').hidden = false;
      modal.onAction = opts.onAction || null;
      setTimeout(function () {
        ta.focus();
        if (opts.selectAll) ta.select();
        else ta.setSelectionRange(0, 0);
      }, 0);
    },
    close: function () {
      $('modal-back').hidden = true;
      modal.onAction = null;
    },
    runAction: function () {
      if (!modal.onAction) return;
      var res = modal.onAction($('modal-text').value);
      if (res && res.ok === false) {
        $('modal-status').textContent = res.error || '导入失败';
        $('modal-status').className = 'note bad';
        return;
      }
      modal.close();
    },
  };

  function pickFile(cb) {
    var input = $('file-input');
    input.value = '';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        cb(String(reader.result));
      };
      reader.readAsText(f);
      input.onchange = null;
    };
    input.click();
  }

  function downloadJson(name, obj) {
    var text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 3000);
  }

  function showExport(title, name, obj) {
    var text = JSON.stringify(obj, null, 2);
    modal.open({
      title: title,
      note: '可直接复制，或点“下载”保存为 ' + name + '。',
      status: text.length + ' 字节 · 已全选',
      text: text,
      actionLabel: '下载',
      selectAll: true,
      onAction: function () {
        downloadJson(name, text);
        toast('已下载 ' + name, 'good');
        return { ok: true };
      },
    });
  }

  // ------------------------------------------------------------ import

  function isTrackJson(data) {
    if (!data || typeof data !== 'object') return false;
    var raw = data.track && typeof data.track === 'object' ? data.track : data;
    return Array.isArray(raw.gates) && !Array.isArray(raw.inputs);
  }
  function isReplayJson(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.inputs)) return true;
    return !!(data.replay && Array.isArray(data.replay.inputs));
  }

  function importTrackText(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: 'JSON 解析失败：' + err.message };
    }
    var raw = data && data.track ? data.track : data;
    var prepared = E.normalizeTrack(raw);
    if (!prepared.ok) return { ok: false, error: '赛道无效：' + prepared.errors.slice(0, 4).join('；') };
    app.track = prepared.track;
    var sel = $('track-select');
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === app.track.name) {
        found = true;
        break;
      }
    }
    if (!found) {
      var opt = document.createElement('option');
      opt.value = app.track.name;
      opt.textContent = app.track.name + ' · 导入';
      sel.appendChild(opt);
    }
    sel.value = app.track.name;
    if (app.track.laps) $('laps-input').value = String(app.track.laps);
    startSession({ track: app.track, ghost: null });
    toast(
      '已导入赛道「' + app.track.name + '」· ' + app.track.gates.length + ' 道门' + (prepared.warnings.length ? ' · ' + prepared.warnings[0] : ''),
      'good',
      3600
    );
    return { ok: true };
  }

  function importReplayText(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: 'JSON 解析失败：' + err.message };
    }
    var raw = data && data.replay && Array.isArray(data.replay.inputs) ? data.replay : data;
    var errors = E.validateReplay(raw);
    if (errors.length) return { ok: false, error: '回放无效：' + errors.slice(0, 4).join('；') };
    // 回放里的 waypoints / roadHalfWidth 只是显示与自动驾驶用的可选辅助，
    // 回放校验不依赖它们；这里透传给页面，保持回放时的路面视图。
    var prepared = E.normalizeTrack({
      name: raw.name || '导入回放',
      params: raw.params,
      initial: raw.initial,
      gates: raw.gates,
      laps: raw.laps,
      waypoints: raw.waypoints,
      roadHalfWidth: raw.roadHalfWidth,
    });
    if (!prepared.ok) return { ok: false, error: '回放赛道无效：' + prepared.errors.join('；') };
    var ok = startSession({ replay: raw, track: prepared.track, ghost: null });
    if (!ok) return { ok: false, error: '回放无法启动' };
    // 载入后停在 tick 0 并暂停：按“开始/Space”实时观看，或点“跳到结尾”直接看成绩
    var s2 = app.session;
    s2.pause(performance.now());
    toast(
      '已载入回放 · ' + raw.inputs.length + ' 段输入 · 共 ' + (raw.ticks != null ? raw.ticks : '至终局') + ' 步 · 按 Space 播放',
      'good',
      4200
    );
    updateHud(true);
    updateControls(true);
    return { ok: true };
  }

  // ------------------------------------------------------------ verify

  function trackFromReplay(replay) {
    return E.normalizeTrack({
      name: replay.name,
      params: replay.params,
      initial: replay.initial,
      gates: replay.gates,
      laps: replay.laps,
    }).track;
  }

  // 用给定渲染帧率把时间切成帧，每帧按 elapsed 换算固定 tick。
  // 帧到达哪些 tick 由帧率决定，但每个 tick 的状态只由 tick 序号和输入决定，
  // 因此假设恒定输入时结果应与 tick 数完全一致。返回 race 结果（跑到 ticks 为止）。
  function simulateAtFrameRate(replay, ticks, hz) {
    var track = trackFromReplay(replay);
    var race = E.createRace(track, { lapsToFinish: track.laps });
    var reader = E.createInputReader(replay.inputs);
    // 真实时间用帧号的精确有理数换算，避免每秒累积舍入误差
    var frame = 0;
    var guard = 0;
    while (race.tick < ticks && !race.done && guard++ < 1000000) {
      frame += 1;
      var elapsedMicros = Math.round((frame * 1000000) / hz);
      var target = Math.min(ticks, Math.floor((elapsedMicros * E.TICK_RATE) / 1000000));
      while (race.tick < target && !race.done) race.step(reader.at(race.tick));
      if (frame * 1000000 / hz > (ticks / E.TICK_RATE) * 1000000 + 1000000) break;
    }
    while (race.tick < ticks && !race.done) race.step(reader.at(race.tick));
    var r = race.getResult();
    return { checksum: r.checksum, ticks: r.ticks, result: r };
  }

  // 暂停：一段时间不累计，恢复后从当前 tick 继续。暂停时长不进入逻辑。
  function simulateWithPauses(replay, ticks, hz, pauseAt, pauseSeconds) {
    var track = trackFromReplay(replay);
    var race = E.createRace(track, { lapsToFinish: track.laps });
    var reader = E.createInputReader(replay.inputs);
    var frame = 0;
    var pauseFrames = Math.round(pauseSeconds * hz);
    var pauseTick = Math.floor(ticks * pauseAt);
    var pausedFrames = 0;
    var guard = 0;
    while (race.tick < ticks && !race.done && guard++ < 1000000) {
      frame += 1;
      if (race.tick >= pauseTick && pausedFrames < pauseFrames) {
        pausedFrames += 1;
        continue; // 暂停的那一帧时间不前进
      }
      // 暂停的帧不累计：把帧号回退相应数量，等效于时间基准前移
      var elapsedMicros = Math.round(((frame - pausedFrames) * 1000000) / hz);
      var target = Math.min(ticks, Math.floor((elapsedMicros * E.TICK_RATE) / 1000000));
      while (race.tick < target && !race.done) race.step(reader.at(race.tick));
      if (frame / hz > ticks / E.TICK_RATE + 1) break;
    }
    while (race.tick < ticks && !race.done) race.step(reader.at(race.tick));
    var r = race.getResult();
    return { checksum: r.checksum, ticks: r.ticks, result: r };
  }

  function runVerification() {
    var box = $('verify-box');
    var s = app.session;
    if (!s) {
      box.textContent = '还没有可检查的比赛。';
      return { ok: false };
    }
    var lines = [];
    var allOk = true;
    var pass = function (cond, label, detail) {
      lines.push((cond ? '<span class="ok">✓ </span>' : '<span class="bad">✗ </span>') + label + (detail ? ' — ' + detail : ''));
      if (!cond) allOk = false;
    };

    var replay = s.exportReplay();
    var online = s.getResult();
    var ticks = online.ticks;

    if (ticks === 0) {
      box.innerHTML = '<span class="bad">✗ </span>本次还没有任何输入记录\n\n先按 W 或 → 开始驾驶，再运行一致性检查。';
      toast('还没有输入可检查', 'warn', 2800);
      return { ok: false, lines: [] };
    }
    var again = E.simulateReplay(replay, { ticks: ticks });
    var same =
      again.ok &&
      again.checksum === online.checksum &&
      again.ticks === online.ticks &&
      JSON.stringify(again.laps) === JSON.stringify(online.laps) &&
      JSON.stringify(again.accepted) === JSON.stringify(online.accepted) &&
      JSON.stringify(again.violations) === JSON.stringify(online.violations) &&
      again.final.x === online.final.x &&
      again.final.y === online.final.y;
    pass(same, '从头重放', again.ok ? '校验和 ' + again.checksum + ' · ' + again.ticks + ' 步' : (again.errors || []).join('；'));

    var rates = [24, 30, 60, 75, 144, 240];
    var base = null;
    var rateOk = true;
    var rateDetail = [];
    for (var i = 0; i < rates.length; i++) {
      var sim = simulateAtFrameRate(replay, ticks, rates[i]);
      if (base == null) base = sim.checksum;
      var ok = sim.checksum === base && sim.ticks === ticks;
      if (!ok) rateOk = false;
      rateDetail.push(rates[i] + 'Hz ' + sim.checksum);
    }
    pass(rateOk && base === online.checksum, '多渲染帧率推进一致', rateDetail.join(' · '));

    var pauseChecks = [0.13, 0.4, 0.72, 0.93];
    var pauseOk = true;
    var pauseDetail = [];
    for (var j = 0; j < pauseChecks.length; j++) {
      var simP = simulateWithPauses(replay, ticks, 60, pauseChecks[j], 1.7 + j * 0.6);
      var okP = simP.checksum === online.checksum && simP.ticks === ticks;
      if (!okP) pauseOk = false;
      pauseDetail.push('@' + pauseChecks[j].toFixed(2) + (okP ? '✓' : '✗'));
    }
    pass(pauseOk, '暂停恢复一致', pauseDetail.join(' '));

    // 幽灵只读：重新构建幽灵并重算，结果必须与在线状态一致
    var ghostRebuild = null;
    if (s.ghost && s.ghost.replay) {
      ghostRebuild = window.RallyRecorder.buildGhost(s.ghost.replay, s.ghost.meta || {});
    }
    pass(
      !ghostRebuild || (ghostRebuild.ok && ghostRebuild.result.checksum === again.checksum),
      '幽灵只读不参与逻辑',
      s.ghost ? (ghostRebuild && ghostRebuild.ok ? '重建幽灵 ' + ghostRebuild.ticks + ' 步 · 校验和一致' : '幽灵重建失败') : '无幽灵'
    );

    // 逐步插值采样不改变逻辑：取几个 alpha 只读取样后，在线状态不变
    var beforeSample = s.race.checksum;
    if (s.ghost) {
      for (var q = 0; q < 8; q++) {
        window.RallyRecorder.sampleTrace(s.ghost.trace, Math.floor(ticks * (q / 8)), q / 8);
      }
    }
    pass(s.race.checksum === beforeSample, '渲染插值只读', 'alpha 0..7/8 取样后校验和不变');

    var stepTimesOk = true;
    var badStep = null;
    for (var k = 0; k < online.accepted.length; k++) {
      var a = online.accepted[k];
      var expect = (a.tick + a.t) / 120;
      if (Math.abs(expect - a.time) > 1e-12) {
        stepTimesOk = false;
        badStep = a;
        break;
      }
    }
    pass(stepTimesOk, '圈速用步内交点时刻', badStep ? '门 ' + badStep.gate + ' 偏差' : online.accepted.length + ' 个过门时刻');

    var orderOk = true;
    var exp = 0;
    var started = false;
    var gateCount = app.track ? app.track.gates.length : 1;
    for (var m = 0; m < online.accepted.length; m++) {
      var ac = online.accepted[m];
      if (!started) {
        if (ac.gate !== 0) {
          orderOk = false;
          break;
        }
        started = true;
        exp = 1;
        continue;
      }
      if (ac.gate !== exp) {
        orderOk = false;
        break;
      }
      exp = (ac.gate + 1) % gateCount;
    }
    pass(orderOk, '接受的门顺序严格递增', started ? '共 ' + online.accepted.length + ' 次' : '尚未起步');

    box.innerHTML = lines.join('\n') + '\n\n' + (allOk ? '<span class="ok">全部通过</span>' : '<span class="bad">存在不一致</span>');
    toast(allOk ? '一致性检查全部通过' : '一致性检查发现差异', allOk ? 'good' : 'bad', 3200);
    return { ok: allOk, lines: lines };
  }

  // ------------------------------------------------------------ track / theme

  function fillTrackSelect() {
    var sel = $('track-select');
    sel.innerHTML = '';
    T.TRACKS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name + ' · ' + t.gates.length + ' 门';
      sel.appendChild(opt);
    });
    sel.value = T.TRACKS[0].name;
  }

  function applyTrackSelection() {
    var name = $('track-select').value;
    var t = T.byName(name);
    var laps = readLaps();
    var prepared = normalize(t, laps);
    if (!prepared.ok) {
      toast('赛道无效：' + prepared.errors[0], 'bad', 4000);
      return;
    }
    app.track = prepared.track;
    // 同一条赛道重开时保留幽灵，方便追击；换赛道则清掉（门位置不同，没有可比性）
    var sameTrack = app.session && app.session.track && app.session.track.name === app.track.name;
    startSession({ track: app.track, ghost: sameTrack ? app.session.ghost : null, laps: laps });
    toast('「' + t.name + '」· ' + t.gates.length + ' 门 · ' + laps + ' 圈', '', 2200);
  }

  function applyTheme(name) {
    document.documentElement.dataset.theme = name;
    if (app.renderer) app.renderer.setTheme(name);
    try {
      localStorage.setItem('rally-theme', name);
    } catch (e) {
      /* 隐私模式忽略 */
    }
    $('theme-icon').textContent = name === 'dark' ? '◐' : '☀';
  }

  // ------------------------------------------------------------ init

  function init() {
    fillTrackSelect();
    app.renderer = window.RallyRender.createRenderer($('track-canvas'), $('minimap'));

    var savedTheme = 'dark';
    try {
      savedTheme = localStorage.getItem('rally-theme') || 'dark';
    } catch (e) {
      savedTheme = 'dark';
    }
    applyTheme(savedTheme === 'light' ? 'light' : 'dark');

    var first = T.TRACKS[0];
    $('laps-input').value = String(first.laps || 3);
    app.track = normalize(first, first.laps || 3).track;
    startSession({ track: app.track, ghost: null, laps: first.laps || 3 });

    window.addEventListener('resize', function () {
      app.renderer.resize();
    });
    app.renderer.resize();

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearHeld);
    // 标签页隐藏时自动暂停：避免后台期间时间继续累积、切回时跨门
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) return;
      clearHeld();
      if (app.session && app.session.state === 'running') {
        app.session.pause(performance.now());
        updateControls(true);
        updateHud(true);
      }
    });

    $('btn-start').addEventListener('click', onStart);
    $('btn-pause').addEventListener('click', togglePause);
    $('btn-restart').addEventListener('click', onRestart);
    $('btn-camera').addEventListener('click', function () {
      app.renderer.setCameraMode(app.renderer.getCameraMode() === 'fit' ? 'follow' : 'fit');
      updateControls(true);
    });
    $('btn-zoom-in').addEventListener('click', function () {
      app.renderer.zoomBy(1.25);
      app.renderer.setCameraMode('follow');
      updateControls(true);
    });
    $('btn-zoom-out').addEventListener('click', function () {
      app.renderer.zoomBy(0.8);
      app.renderer.setCameraMode('follow');
      updateControls(true);
    });
    $('btn-ghost-toggle').addEventListener('click', function () {
      app.ghostVisible = !app.ghostVisible;
      updateControls(true);
      updateHud(true);
    });
    $('chk-ghost').addEventListener('change', function () {
      app.ghostVisible = $('chk-ghost').checked;
      updateControls(true);
      updateHud(true);
    });
    $('btn-apply-track').addEventListener('click', applyTrackSelection);
    $('track-select').addEventListener('change', applyTrackSelection);
    $('laps-input').addEventListener('change', function () {
      if (app.session && app.session.mode === 'drive') startSession({ track: app.track, laps: readLaps() });
    });

    $('btn-theme').addEventListener('click', function () {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    $('btn-capture-ghost').addEventListener('click', function () {
      var g = app.session && app.session.captureGhost({ label: '手动封存' });
      if (g) {
        toast('已设为幽灵 · ' + g.ticks + ' 步' + (g.bestLapTime != null ? ' · 最快 ' + g.bestLapTime.toFixed(3) + 's' : ''), 'good', 3200);
        app.ghostVisible = true;
        updateHud(true);
        updateControls(true);
      } else {
        toast('本次还没有有效输入，无法生成幽灵', 'warn', 2600);
      }
    });
    $('btn-clear-ghost').addEventListener('click', function () {
      if (app.session) app.session.clearGhost();
      updateHud(true);
      updateControls(true);
    });

    $('btn-export-result').addEventListener('click', function () {
      showExport('导出成绩 JSON', 'rally-result-' + stamp() + '.json', app.session.exportResult());
    });
    $('btn-export-input').addEventListener('click', function () {
      showExport('导出输入回放 JSON', 'rally-input-' + stamp() + '.json', app.session.exportReplay());
    });
    $('btn-export-track').addEventListener('click', function () {
      showExport('导出当前赛道', 'rally-track-' + stamp() + '.json', T.toExport(app.track));
    });

    $('btn-replay-end').addEventListener('click', function () {
      var s3 = app.session;
      if (!s3 || s3.mode !== 'replay') return;
      var rp = s3.exportReplay();
      var target = rp.ticks != null ? rp.ticks : E.MAX_TICKS;
      s3.stepTicks(Math.max(0, target - s3.getResult().ticks));
      s3.pause(performance.now());
      app.renderer.clearTrails();
      updateHud(true);
      updateControls(true);
    });

    $('btn-verify').addEventListener('click', runVerification);

    $('btn-sample-check').addEventListener('click', function () {
      var res = window.RallySampleCheck.run(E);
      var html = res.summary
        .split('\n')
        .map(function (line) {
          var cls = line.indexOf('✓') === 0 ? 'ok' : 'bad';
          return '<span class="' + cls + '">' + line + '</span>';
        })
        .join('\n');
      $('sample-box').innerHTML = html + '\n\n' + (res.ok ? '<span class="ok">全部通过（' + res.pass + '/' + res.total + '）</span>' : '<span class="bad">' + res.pass + '/' + res.total + ' 通过</span>');
      toast(res.ok ? '包内样例全部通过' : '样例校验存在差异', res.ok ? 'good' : 'bad', 3000);
    });

    $('btn-import-track').addEventListener('click', function () {
      modal.open({
        title: '导入赛道',
        note: '支持 {name, params, initial, gates, laps}，params / initial 可省略；gates 为有向线段 {a, b, normal}，2–64 道。',
        status: '也可以把 JSON 文件直接拖到页面上。',
        actionLabel: '导入赛道',
        onAction: importTrackText,
      });
    });
    $('btn-import-replay').addEventListener('click', function () {
      modal.open({
        title: '导入回放',
        note: '支持 {initial, params, gates, inputs, ticks?, laps?}；inputs 是稀疏变化表，首项 tick 必须为 0。',
        status: '导入后进入回放模式，可逐帧重放。',
        actionLabel: '载入回放',
        onAction: importReplayText,
      });
    });

    $('modal-close').addEventListener('click', modal.close);
    $('modal-cancel').addEventListener('click', modal.close);
    $('modal-action').addEventListener('click', modal.runAction);
    $('modal-load-file').addEventListener('click', function () {
      pickFile(function (text) {
        $('modal-text').value = text;
        $('modal-status').textContent = '已读取文件，点击“' + $('modal-action').textContent + '”继续。';
      });
    });
    $('modal-back').addEventListener('click', function (e) {
      if (e.target === $('modal-back')) modal.close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modal-back').hidden) modal.close();
    });

    setupTouchControls();
    setupDragDrop();
    updateHud(true);
    updateControls(true);
    requestAnimationFrame(frameLoop);

    // 自动化钩子：只读 + 明确的动作入口
    window.__rally = {
      app: app,
      engine: E,
      tracks: T,
      session: function () {
        return app.session;
      },
      getView: function () {
        return app.session ? app.session.getView() : null;
      },
      getResult: function () {
        return app.session ? app.session.getResult() : null;
      },
      start: onStart,
      pause: togglePause,
      restart: onRestart,
      verify: runVerification,
      importTrackText: importTrackText,
      importReplayText: importReplayText,
      setTrack: function (name, laps) {
        $('track-select').value = name;
        if (laps) $('laps-input').value = String(laps);
        applyTrackSelection();
      },
      stepTicks: function (n) {
        var st = app.session ? app.session.stepTicks(n) : 0;
        updateHud(true);
        updateControls(true);
        return st;
      },
      // 用给定逐 tick 输入驱动页面会话（测试用）。走正常 stepOnce 路径，
      // 因此记录器、幽灵与暂停语义与真实驾驶一致。返回实际推进步数。
      driveScript: function (inputs) {
        if (!app.session) return 0;
        var n = 0;
        if (app.session.mode === 'drive') {
          var prevSample = app.input.sample;
          var idx = 0;
          app.input.sample = function () {
            return inputs[Math.min(idx++, inputs.length - 1)];
          };
          n = app.session.stepTicks(inputs.length);
          app.input.sample = prevSample;
        } else {
          n = app.session.stepTicks(inputs.length);
        }
        updateHud(true);
        updateControls(true);
        return n;
      },
      // 把当前赛道用自动驾驶跑完整场（测试用），并返回成绩与回放
      runAutopilot: function (opts) {
        opts = opts || {};
        var result = window.RallyAutopilot.driveRace(app.track, opts);
        return {
          result: result.result,
          inputs: result.inputs.map(function (e) {
            return { tick: e.tick, throttle: e.throttle, steer: e.steer, brake: e.brake };
          }),
        };
      },
      // 切换固定帧率模拟（自检/自动化用）：null 为真实 rAF 时间
      setFrameRate: function (hz) {
        app.fixedFrameRate = hz || null;
        app.fixedClock = 0;
        if (app.session) app.session.restart({ nowMs: 0, capture: false });
        updateHud(true);
        updateControls(true);
      },
      // 用固定帧率推进 n 个渲染帧（每帧调用 session.frame 并取样）
      advanceFixedFrames: function (frames) {
        if (!app.session) return 0;
        var hz = app.fixedFrameRate || 60;
        var steps = 0;
        for (var i = 0; i < frames; i++) {
          app.fixedClock += 1000 / hz;
          steps += app.session.frame(app.fixedClock);
        }
        updateHud(true);
        updateControls(true);
        return steps;
      },
      simulateAtFrameRate: simulateAtFrameRate,
      simulateWithPauses: simulateWithPauses,
      sampleCheck: function () {
        return window.RallySampleCheck.run(E);
      },
      toast: toast,
    };
  }

  function stamp() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 触摸驾驶：按住方向盘/油门按钮 = 对应按键按下；离开或取消即松开。
  function setupTouchControls() {
    var pad = $('touch-pad');
    if (!pad) return;
    var active = new Map(); // pointerId -> action
    function sync() {
      var actions = { up: false, down: false, left: false, right: false };
      active.forEach(function (action) {
        actions[action] = true;
      });
      held.up = actions.up;
      held.down = actions.down;
      held.left = actions.left;
      held.right = actions.right;
      var btns = pad.querySelectorAll('[data-hold]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('held', !!actions[btns[i].getAttribute('data-hold')]);
      }
    }
    pad.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('[data-hold]');
      if (!btn) return;
      e.preventDefault();
      if (app.session && app.session.state === 'ready') app.session.start(performance.now());
      try {
        pad.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 捕获失败不影响按键 */
      }
      active.set(e.pointerId, btn.getAttribute('data-hold'));
      sync();
    });
    var release = function (e) {
      if (!active.has(e.pointerId)) return;
      active.delete(e.pointerId);
      sync();
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    pad.addEventListener('pointerleave', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', function () {
      active.clear();
      sync();
    });
  }

  function setupDragDrop() {
    var veil = $('drop-veil');
    var depth = 0;
    function hasFiles(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      veil.classList.add('on');
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) veil.classList.remove('on');
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.classList.remove('on');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        var data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          toast('文件不是合法 JSON：' + err.message, 'bad', 4200);
          return;
        }
        if (isReplayJson(data)) {
          var rr = importReplayText(text);
          if (!rr.ok) toast(rr.error, 'bad', 4200);
        } else if (isTrackJson(data)) {
          var r = importTrackText(text);
          if (!r.ok) toast(r.error, 'bad', 4200);
        } else {
          toast('无法识别：既不是赛道也不是回放', 'bad', 4000);
        }
      };
      reader.readAsText(f);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
