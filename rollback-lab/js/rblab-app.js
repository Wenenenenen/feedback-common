/*
 * rblab-app.js — 页面控制器。
 * 只负责读取控件、驱动 Experiment、渲染状态与处理导入导出；
 * 所有确定性逻辑都在引擎/网络层，本文件不做任何物理或随机计算。
 */
(function () {
  'use strict';

  var R = window.RBLab;
  var engine = R.engine, lab = R.lab, selftest = R.selftest, samples = R.samples;

  var el = function (id) { return document.getElementById(id); };
  var state = {
    exp: null,
    log: null,
    logName: 'basic',
    running: false,
    timer: null,
    stopOnDivergence: true,
    lastFxKeys: { c1: {}, c2: {} }
  };

  /* ---------- 小工具 ---------- */
  function toast(msg, isErr) {
    var t = el('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  function netConfig() {
    return {
      delayMs: parseInt(el('in-delay').value, 10) || 0,
      jitterMs: parseInt(el('in-jitter').value, 10) || 0,
      lossPct: Math.max(0, Math.min(100, parseInt(el('in-loss').value, 10) || 0)),
      seed: parseInt(el('in-seed').value, 10) || 1
    };
  }

  function rbMax() { return Math.max(1, parseInt(el('in-rbmax').value, 10) || 8); }

  /* ---------- 样例下拉 ---------- */
  function fillSampleSelect() {
    var sel = el('sample-select');
    var opts = [
      ['basic', 'basic.json · 走位接招（600 帧）'],
      ['trade', 'trade.json · 同帧互击（60 帧）'],
      ['block', 'block.json · 格挡（60 帧）'],
      ['ko', 'ko.json · KO 冻结（400 帧）'],
      ['randomLong', 'random-long.json · 长随机（3600 帧）'],
      ['invalid', 'invalid.json · 非法日志（应被拒绝）']
    ];
    sel.innerHTML = opts.map(function (o) {
      return '<option value="' + o[0] + '">' + o[1] + '</option>';
    }).join('');
  }

  /* ---------- 实验生命周期 ---------- */
  function buildExperiment(logObj) {
    stopLoop();
    state.log = logObj;
    state.lastFxKeys = { c1: {}, c2: {} };
    state.exp = new lab.Experiment({
      log: logObj,
      net: netConfig(),
      rollbackMax: rbMax()
    });
    el('divergence-panel').hidden = true;
    renderAll();
    setRunningUI(false);
  }

  function startFromSelected() {
    var key = el('sample-select').value;
    var logObj = samples[key];
    state.logName = key;
    var validation = engine.validateLog(logObj);
    if (!validation.ok) {
      toast('该日志非法，无法开始：' + validation.errors[0], true);
      buildExperiment(logObj); // 仍加载以便查看校验错误
      el('selftest-summary').textContent = '日志校验失败：' + validation.errors.join('；');
      return;
    }
    buildExperiment(logObj);
    startLoop();
  }

  function setRunningUI(running) {
    state.running = running;
    el('btn-pause').disabled = !state.exp;
    el('btn-pause').textContent = running ? '暂停' : '继续';
    el('btn-step').disabled = !state.exp;
  }

  function startLoop() {
    if (!state.exp) { return; }
    stopLoop();
    setRunningUI(true);
    var speed = parseInt(el('in-speed').value, 10);
    if (speed === 0) {
      // 一次跑到底
      while (!state.exp.finished) { advance(); }
      setRunningUI(false);
      renderAll();
      return;
    }
    var interval = speed >= 30 ? 16 : speed >= 10 ? 50 : 140;
    var perTick = speed >= 30 ? 4 : speed >= 10 ? 2 : 1;
    state.timer = setInterval(function () {
      for (var i = 0; i < perTick && !state.exp.finished; i++) { advance(); }
      renderAll();
      if (state.exp.finished) { stopLoop(); setRunningUI(false); }
    }, interval);
  }

  function stopLoop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function advance() {
    var exp = state.exp;
    if (!exp || exp.finished) { return; }
    var rec = exp.step();
    if (state.stopOnDivergence && exp.firstDivergence) {
      stopLoop();
      setRunningUI(false);
      renderAll();
      toast('已停在首处校验和分歧：帧 ' + exp.firstDivergence.frame, true);
    }
    return rec;
  }

  /* ---------- 渲染 ---------- */
  function actLabel(f) {
    if (f.act === 'attack') { return 'attack·' + (f.move || '?') + '#' + f.actFrame; }
    if (f.act === 'hitstun' || f.act === 'blockstun') { return f.act + '(' + f.stun + ')'; }
    return f.act;
  }

  function renderStatus() {
    var exp = state.exp;
    el('st-tick').textContent = exp ? exp.tickCount : 0;
    var n = state.log ? state.log.frames.length : 0;
    el('st-frame').textContent = exp ? (Math.max(exp.c1.frameCount, exp.c2.frameCount) + ' / ' + n) : ('0 / ' + n);

    var phaseEl = el('st-phase');
    if (!exp) {
      phaseEl.innerHTML = '<span class="pill dim">未开始</span>';
    } else if (exp.firstDivergence) {
      phaseEl.innerHTML = '<span class="pill hit"><span class="dot"></span>分歧停机</span>';
    } else if (exp.finished) {
      phaseEl.innerHTML = '<span class="pill ok"><span class="dot"></span>已收敛</span>';
    } else if (exp.c1.lastTickWaited || exp.c2.lastTickWaited) {
      phaseEl.innerHTML = '<span class="pill wait"><span class="dot"></span>等待远端输入</span>';
    } else {
      phaseEl.innerHTML = '<span class="pill run"><span class="dot"></span>推进中</span>';
    }

    if (exp) {
      el('st-rb1').textContent = exp.c1.rollbackCount + ' / ' + exp.c1.maxRollbackDepth;
      el('st-rb2').textContent = exp.c2.rollbackCount + ' / ' + exp.c2.maxRollbackDepth;
      el('st-wait').textContent = exp.c1.waitTicks + ' / ' + exp.c2.waitTicks;
      var cs = exp.link.channelStats();
      el('st-loss').textContent =
        cs.p1ToP2.sent + '/' + cs.p1ToP2.dropped + ' · ' + cs.p2ToP1.sent + '/' + cs.p2ToP1.dropped;
      el('st-div').textContent = exp.firstDivergence ? ('帧 ' + exp.firstDivergence.frame) : '无';
      el('st-div').style.color = exp.firstDivergence ? 'var(--hit)' : '';
    }
  }

  function renderClient(prefix, client, otherClient, side) {
    if (!state.exp) { return; }
    var st = client.state;
    var f = st.fighters;

    // 位置（坐标 0..60000 映射为百分比）
    for (var p = 0; p < 2; p++) {
      var fighterEl = el('f-' + prefix + '-p' + (p + 1));
      fighterEl.style.left = (f[p].x / 60000 * 100) + '%';
      fighterEl.querySelector('.hpbar i').style.width = (f[p].hp / engine.MAX_HP * 100) + '%';
      fighterEl.querySelector('.hpbar i').style.background =
        f[p].act === 'hitstun' ? 'var(--hit)' : f[p].act === 'blockstun' ? 'var(--ok)' : 'var(--ok)';
    }
    el('flag-' + side).textContent = '帧 ' + st.frame + (st.over ? ' · KO 冻结' : '');

    // 药丸
    var pill = el('pill-' + side);
    if (client.lastTickWaited) {
      pill.innerHTML = '<span class="pill wait"><span class="dot"></span>等待</span>';
    } else if (client.predictedFrames[client.frameCount - 1]) {
      pill.innerHTML = '<span class="pill run"><span class="dot"></span>含预测帧</span>';
    } else {
      pill.innerHTML = '<span class="pill ok"><span class="dot"></span>已确认</span>';
    }

    // 元数据
    var s = client.stats();
    var meta = [
      ['本地帧号', s.frameCount], ['确认到帧', s.confirmedFrame], ['预测领先', s.predictedLead],
      ['回滚次数', s.rollbackCount], ['最深回滚', s.maxRollbackDepth], ['等待帧', s.waitTicks]
    ];
    el('meta-' + side).innerHTML = meta.map(function (m) {
      return '<div class="m"><div class="k">' + m[0] + '</div><div class="v">' + m[1] + '</div></div>';
    }).join('');

    el('state-' + side).innerHTML =
      '<b>P1</b> x=<b>' + f[0].x + '</b> hp=<b>' + f[0].hp + '</b> ' + actLabel(f[0]) +
      ' &nbsp;|&nbsp; <b>P2</b> x=<b>' + f[1].x + '</b> hp=<b>' + f[1].hp + '</b> ' + actLabel(f[1]) +
      '<br><span class="mini">当前帧校验和 ' + (client.frameCount > 0 ? client.checksums[client.frameCount - 1] : '—') +
      ' · 状态串 ' + engine.checksumString(st) + '</span>';

    renderFx(prefix, client);
  }

  /* 命中特效：按事件键对账，重算仍发生不重复播放，撤销的划线撤掉 */
  function renderFx(prefix, client) {
    var seen = {};
    var list = client.eventList();
    list.forEach(function (ev) {
      seen[ev.key] = ev;
      var fxEl = el('fx-' + prefix + '-p' + (ev.defender + 1));
      var prev = state.lastFxKeys[prefix][ev.key];
      if (ev.revoked) {
        fxEl.textContent = ev.kind === 'hit' ? '命中撤销' : '格挡撤销';
        fxEl.className = 'fx show revoked-fx';
      } else if (!prev) {
        // 首次出现（重算后仍存在的同一事件键不会再次进入这里）
        fxEl.textContent = ev.kind === 'hit' ? ('命中 -' + ev.damage) : '格挡';
        fxEl.className = 'fx show ' + (ev.kind === 'hit' ? 'hit-fx' : 'block-fx');
      }
    });
    // 消失的键：清掉特效
    Object.keys(state.lastFxKeys[prefix]).forEach(function (key) {
      if (!seen[key]) {
        var evOld = state.lastFxKeys[prefix][key];
        var fxEl = el('fx-' + prefix + '-p' + (evOld.defender + 1));
        fxEl.className = 'fx';
      }
    });
    state.lastFxKeys[prefix] = seen;
  }

  function renderChecksumTable() {
    var exp = state.exp;
    var tbody = el('checksum-tbody');
    if (!exp) { tbody.innerHTML = ''; return; }
    var common = Math.min(exp.c1.frameCount, exp.c2.frameCount);
    var ref = exp.ref.frames;
    var rows = [];
    var curFrame = Math.max(exp.c1.frameCount, exp.c2.frameCount) - 1;
    for (var f = 0; f < common; f++) {
      var a = exp.c1.checksums[f], b = exp.c2.checksums[f], r = ref[f] ? ref[f].checksum : '';
      var match = a === b;
      var divergeCls = (!match && exp.c1.remoteKnown[f] && exp.c2.remoteKnown[f]) ? 'diverge' : '';
      var curCls = f === curFrame ? 'current' : '';
      var p1Flag = exp.c1.predictedFrames[f] ? '<span class="flag-pred">预测</span>' : '<span class="flag-conf">确认</span>';
      var p2Flag = exp.c2.predictedFrames[f] ? '<span class="flag-pred">预测</span>' : '<span class="flag-conf">确认</span>';
      rows.push(
        '<tr class="' + divergeCls + ' ' + curCls + '">' +
        '<td>' + f + '</td>' +
        '<td class="ck ' + (a === r ? 'match' : 'mismatch') + '">' + a + '</td>' +
        '<td class="ck ' + (b === r ? 'match' : 'mismatch') + '">' + b + '</td>' +
        '<td class="mini">' + r + '</td>' +
        '<td>' + p1Flag + '</td><td>' + p2Flag + '</td>' +
        '<td>' + (match ? '<span class="pill ok">一致</span>' : '<span class="pill hit">不一致</span>') + '</td>' +
        '</tr>'
      );
    }
    tbody.innerHTML = rows.join('');
  }

  function renderEvents(id, list) {
    var box = el(id);
    if (!list.length) { box.innerHTML = '<span class="hint">暂无事件</span>'; return; }
    box.innerHTML = list.slice().reverse().map(function (ev) {
      var life = ev.revoked
        ? '<span class="pill hit">已撤销</span>'
        : ev.confirmed ? '<span class="pill ok">已确认</span>'
        : '<span class="pill wait">预测中</span>';
      return '<div class="ev' + (ev.revoked ? ' revoked' : '') + '">' +
        '<span class="fr">帧 ' + ev.frame + '</span>' +
        '<span class="kind ' + ev.kind + '">' + (ev.kind === 'hit' ? '命中' : '格挡') + '</span>' +
        '<span class="desc">P' + (ev.attacker + 1) + ' ' + ev.move + ' → P' + (ev.defender + 1) +
        (ev.kind === 'hit' ? ' · -' + ev.damage + 'hp' : ' · 无伤') + '</span>' +
        '<span class="life">' + life + '</span></div>';
    }).join('');
  }

  function renderDivergence() {
    var exp = state.exp;
    var panel = el('divergence-panel');
    if (!exp || !exp.firstDivergence) { panel.hidden = true; return; }
    panel.hidden = false;
    var d = exp.firstDivergence;
    var rows = [];
    d.diff.fighters.forEach(function (fd) {
      Object.keys(fd.fields).forEach(function (k) {
        rows.push('<tr><td>' + fd.player + '.</td><td>' + k + '</td>' +
          '<td class="val-c1">' + JSON.stringify(fd.fields[k].c1) + '</td>' +
          '<td class="val-c2">' + JSON.stringify(fd.fields[k].c2) + '</td></tr>');
      });
    });
    el('divergence-body').innerHTML =
      '<h3>帧 ' + d.frame + ' 两边都已确认但校验和不同</h3>' +
      '<div class="row" style="margin-bottom:10px;">' +
      '<span class="pill hit">P1 ' + d.checksum1 + '</span>' +
      '<span class="pill hit">P2 ' + d.checksum2 + '</span></div>' +
      '<table><thead><tr><th>角色</th><th>字段</th><th>客户端1</th><th>客户端2</th></tr></thead>' +
      '<tbody>' + (rows.join('') || '<tr><td colspan="4" class="mini">字段快照缺失</td></tr>') + '</tbody></table>' +
      '<p class="hint" style="margin-top:10px;">上下文：c1 远端输入=' + d.diff.context.c1UsedRemote +
      '（' + (d.diff.context.c1Predicted ? '预测' : '确认') + '），c2 远端输入=' + d.diff.context.c2UsedRemote +
      '（' + (d.diff.context.c2Predicted ? '预测' : '确认') + '）。确定性引擎下出现真分歧通常意味着两边逻辑版本或起始状态不一致。</p>';
  }

  function renderAll() {
    if (!state.exp) { renderStatus(); return; }
    renderStatus();
    renderClient('c1', state.exp.c1, state.exp.c2, 'c1');
    renderClient('c2', state.exp.c2, state.exp.c1, 'c2');
    renderChecksumTable();
    renderEvents('events-c1', state.exp.c1.eventList());
    renderEvents('events-c2', state.exp.c2.eventList());
    renderDivergence();
  }

  /* ---------- 导入导出 ---------- */
  function exportCurrentLog() {
    if (!state.log) { toast('没有可导出的日志', true); return; }
    download((state.logName || 'input') + '-input-log.json', JSON.stringify(state.log, null, 2));
    toast('已导出输入日志');
  }

  function exportFrames() {
    if (!state.exp) { toast('请先运行一次实验', true); return; }
    var payload = state.exp.exportFramesJSON();
    download((state.logName || 'run') + '-frames.json', JSON.stringify(payload, null, 2));
    toast('已导出逐帧状态 JSON（' + payload.reference.length + ' 帧）');
  }

  function importLog(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try {
        obj = JSON.parse(reader.result);
      } catch (e) {
        toast('文件不是合法 JSON：' + e.message, true);
        return;
      }
      var validation = engine.validateLog(obj);
      if (!validation.ok) {
        toast('日志校验失败：' + validation.errors[0], true);
        return;
      }
      state.logName = file.name.replace(/\.json$/i, '') || 'imported';
      el('sample-select').value = '';
      buildExperiment(obj);
      startLoop();
      toast('已导入 ' + obj.frames.length + ' 帧日志并开始运行');
    };
    reader.readAsText(file);
  }

  /* ---------- 自测 ---------- */
  function runSelfTest() {
    var list = el('selftest-list');
    list.innerHTML = '<span class="hint">运行中…</span>';
    setTimeout(function () {
      var cases = selftest.buildCases(samples);
      var results = selftest.runAll(cases);
      var failed = 0;
      list.innerHTML = results.map(function (r, i) {
        if (!r.ok) { failed++; }
        return '<div class="st-case ' + (r.ok ? 'pass' : 'fail') + '">' +
          '<span class="mark">' + (r.ok ? 'PASS' : 'FAIL') + '</span>' +
          '<div>' + (i + 1) + '. ' + r.name + (r.ok ? '' : '<span class="err">' + r.error + '</span>') + '</div></div>';
      }).join('');
      var sum = el('selftest-summary');
      sum.textContent = (results.length - failed) + '/' + results.length + ' 通过';
      sum.style.color = failed ? 'var(--hit)' : 'var(--ok)';
      el('determinism-badge').textContent = failed ? '确定性：自测失败' : '确定性：全部通过';
      el('determinism-badge').style.color = failed ? 'var(--hit)' : 'var(--ok)';
      toast(failed ? ('自测 ' + failed + ' 项失败') : '自测全部通过');
    }, 30);
  }

  /* ---------- 主题 ---------- */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('rblab-theme'); } catch (e) { /* 忽略 */ }
    if (saved) { document.documentElement.setAttribute('data-theme', saved); }
    el('theme-toggle').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('rblab-theme', next); } catch (e) { /* 忽略 */ }
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    el('btn-run').addEventListener('click', startFromSelected);
    el('btn-pause').addEventListener('click', function () {
      if (state.running) { stopLoop(); setRunningUI(false); }
      else { if (state.exp && !state.exp.finished) { startLoop(); } }
    });
    el('btn-step').addEventListener('click', function () {
      stopLoop(); setRunningUI(false);
      if (state.exp && !state.exp.finished) { advance(); renderAll(); }
    });
    el('btn-stop-div').addEventListener('click', function () {
      state.stopOnDivergence = !state.stopOnDivergence;
      this.textContent = state.stopOnDivergence ? '停在首处分歧（开）' : '停在首处分歧（关）';
      toast(state.stopOnDivergence ? '将在首处真分歧处停机' : '分歧时继续运行');
    });
    el('sample-select').addEventListener('change', function () {
      var key = this.value;
      var v = engine.validateLog(samples[key]);
      el('selftest-summary').textContent = v.ok
        ? (key + '.json 校验通过，' + samples[key].frames.length + ' 帧')
        : ('注意：' + v.errors[0]);
    });
    el('btn-import').addEventListener('click', function () { el('file-import').click(); });
    el('file-import').addEventListener('change', function (e) {
      if (e.target.files[0]) { importLog(e.target.files[0]); }
      e.target.value = '';
    });
    el('btn-export-log').addEventListener('click', exportCurrentLog);
    el('btn-export-frames').addEventListener('click', exportFrames);
    el('btn-selftest').addEventListener('click', runSelfTest);

    // 键盘：空格暂停/继续，→ 单步，R 重置
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { return; }
      if (e.code === 'Space') { e.preventDefault(); el('btn-pause').click(); }
      else if (e.code === 'ArrowRight') { el('btn-step').click(); }
      else if (e.code === 'KeyR') { startFromSelected(); }
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    initTheme();
    fillSampleSelect();
    bind();
    // 首次载入 basic 样例作为工作态（不自动跑，先呈现完整界面）
    buildExperiment(samples.basic);
    el('selftest-summary').textContent = 'basic.json 校验通过，' + samples.basic.frames.length + ' 帧 · 点“开始/重置”运行';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
