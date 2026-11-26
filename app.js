/*
 * app.js — 磁带导频校速台界面控制
 * 依赖全局 PilotSolver / PilotAudio / PilotIO（均为 UMD）。
 */
(function () {
  'use strict';

  var S = window.PilotSolver;
  var A = window.PilotAudio;
  var IO = window.PilotIO;

  var ROW_H = 40;

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }
  var els = {};
  [
    'status', 'status-text', 'fileInput', 'file-input', 'loadSampleBtn', 'appMain',
    'caseMeta', 'anchorList', 'anchorCount', 'anchorForm', 'anchorIndex', 'anchorValue',
    'addAnchorBtn', 'pickFromDetailBtn',
    'exportBtn', 'exportSelectionBtn', 'exportStatus',
    'selStartSec', 'selEndSec', 'selStartFrame', 'selEndFrame', 'selFullBtn',
    'listenOriginal', 'listenCorrected', 'compareAudio', 'abHint',
    'errorBox', 'errorDetail', 'firstBadIndex', 'jumpBadBtn', 'revertAnchorBtn', 'lastGoodBadge',
    'phaseCanvas', 'phaseHover', 'phaseTooltip', 'speedCanvas', 'speedHover', 'phaseWrap', 'speedWrap',
    'markScroll', 'markTbody', 'rowJump', 'rowJumpBtn', 'onlyAnchorBad', 'tableSummary',
    'detailIndex', 'detailBody', 'detailCard'
  ].forEach(function (id) { els[id] = $(id); });

  /* ---------------- 状态 ---------------- */
  var state = {
    ready: false,
    caseName: '',
    project: null,
    prep: null,
    wav: null,
    anchors: [],          // [{index,z,locked}]
    solution: null,       // 最近一次可行解（失败时保留上一条可用）
    attempt: null,        // 最近一次求解报告
    firstBad: -1,
    lastGood: null,       // {anchors, solution, rendered, fullBytes}
    rendered: null,
    fullBytes: null,
    originalUrl: null,
    correctedUrl: null,
    abMode: 'corrected',
    selectedIndex: 0,
    pendingCandidateZ: null,
    chartCache: null,
    filterOnlyMarks: false
  };
  window.__pilotState = state; // 便于调试 / 自动化检查

  /* ---------------- 工具 ---------------- */
  function setStatus(kind, text) {
    els.status.className = 'statusbar' + (kind ? ' ' + kind : '');
    els['status-text'].textContent = text;
  }
  function rate() { return state.wav ? state.wav.sampleRate : 48000; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmt(n, digits) {
    if (!isFinite(n)) return '–';
    return n.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 3 : digits, minimumFractionDigits: 0 });
  }
  function zToK(z, p) { return Math.floor((z - p) / 256); }

  function downloadBytes(bytes, filename) {
    var blob = A.bytesToBlob(bytes, 'audio/wav');
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------------- 导入 ---------------- */
  var loadSeq = 0; // 使被更新导入取代的异步加载结果失效，避免竞态覆盖

  async function loadCaseFromFile(file) {
    var seq = ++loadSeq;
    els.exportBtn.disabled = true;
    els.exportSelectionBtn.disabled = true;
    setStatus('working', '正在读取 ' + file.name + ' …');
    try {
      var u8 = new Uint8Array(await file.arrayBuffer());
      if (seq !== loadSeq) return;
      var lower = file.name.toLowerCase();
      var c;
      if (lower.endsWith('.zip')) c = await IO.loadCaseFromZipBuffer(u8);
      else c = await IO.loadCaseFromFileList([file]);
      if (seq !== loadSeq) return;
      initCase(c, file.name);
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error(e);
      if (state.lastGood) { els.exportBtn.disabled = false; els.exportSelectionBtn.disabled = false; }
      setStatus('error', '导入失败：' + e.message);
    }
  }

  async function loadCaseFromUrl(url, name) {
    var seq = ++loadSeq;
    setStatus('working', '正在获取 ' + url + ' …');
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var buf = new Uint8Array(await res.arrayBuffer());
      if (seq !== loadSeq) return;
      var c = await IO.loadCaseFromZipBuffer(buf);
      if (seq !== loadSeq) return;
      initCase(c, name || url);
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error(e);
      setStatus('error', '内置样例加载失败：' + e.message + '（可改用右上角手动导入）');
    }
  }

  function initCase(c, sourceName) {
    var project = c.project;
    var validation = S.validateProject(project);
    if (validation.errors.length) throw new Error(validation.errors.join('；'));

    state.project = project;
    state.prep = S.prepare(project);
    state.wav = c.wav;
    state.caseName = sourceName || c.projectName || 'case';
    state.ready = true;
    state.selectedIndex = 0;
    document.body.dataset.caseReady = '1';

    // 初始锚点：来自 project.anchors；首尾若存在则锁定
    var anchorMap = project.anchors || {};
    var anchors = Object.keys(anchorMap).map(Number).sort(function (a, b) { return a - b; })
      .map(function (i) { return { index: i, z: anchorMap[i] }; });
    // 去重
    var seen = {};
    anchors = anchors.filter(function (a) { if (seen[a.index]) return false; seen[a.index] = 1; return true; });
    state.anchors = anchors;

    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    var originalBytes = c.wavBytes || A.encodeWav16(c.wav.samples, c.wav.sampleRate, c.wav.channels);
    state.originalUrl = URL.createObjectURL(new Blob([originalBytes], { type: 'audio/wav' }));

    var report = commitAnchors(state.anchors, { initial: true });
    state.abMode = 'corrected';
    updateAbButtons();
    els.compareAudio.src = state.correctedUrl || state.originalUrl;

    renderCaseMeta(c);
    populateAnchorIndexDatalist();
    syncSelectionInputs(true);
    drawChartsSoon();

    if (report.ok) {
      setStatus('ok', '完成：已导入「' + state.caseName + '」，' + state.prep.n +
        ' 个读数，最优折变代价 ' + report.solution.cost + '，校速输出 ' +
        (state.rendered.frames / rate()).toFixed(2) + ' s。可添加中间锚点重新求解。');
    } else {
      setStatus('error', '导入完成，但给定锚点无解：第一处无法延续的读数 #' + report.firstBad);
    }
  }

  /* ---------------- 锚点与求解（同步核心，供 UI 与自动化共用） ---------------- */

  function normalizedAnchors(list) {
    var map = new Map();
    list.forEach(function (a) { map.set(a.index, a.z); });
    return Array.from(map.entries()).sort(function (x, y) { return x[0] - y[0]; })
      .map(function (e) { return { index: e[0], z: e[1], locked: isEndIndex(e[0]) }; });
  }
  function isEndIndex(i) { return !!state.prep && (i === 0 || i === state.prep.n - 1); }
  // 已存在的首尾锚点不可删改；若数据缺首尾锚点，允许补设一次
  function isLockedIndex(i) {
    if (!isEndIndex(i)) return false;
    return state.anchors.some(function (a) { return a.index === i; });
  }

  function commitAnchors(nextList, opts) {
    opts = opts || {};
    if (!state.prep) return { ok: false, reason: 'NO_CASE' };
    state.anchors = normalizedAnchors(nextList);

    var inputMap = {};
    state.anchors.forEach(function (a) { inputMap[a.index] = a.z; });
    var resolved = S.resolveAnchors(state.prep, inputMap);
    if (resolved.errors.length) {
      // 锚点值不合法：保留 lastGood
      state.attempt = { ok: false, anchorErrors: resolved.errors };
      showFailure(null, resolved.errors.join('；'));
      renderAnchorList();
      return { ok: false, anchorErrors: resolved.errors, keptLastGood: !!state.lastGood };
    }

    var result = S.solvePrepared(state.prep, resolved.anchorIdx);
    state.attempt = result;

    if (!result.ok) {
      state.firstBad = result.firstBad;
      showFailure(result.firstBad, null);
      document.body.dataset.feasible = 'false';
      document.body.dataset.firstBad = String(result.firstBad);
      // 保留 state.solution / rendered / lastGood 不动
      renderAnchorList();
      renderTable();
      drawChartsSoon();
      setStatus('error', '无解：第一处无法延续的读数 #' + result.firstBad +
        '（旧的可用校速结果仍用于试听与导出）。');
      return {
        ok: false, feasible: false, firstBad: result.firstBad,
        keptLastGood: !!state.lastGood, elapsedMs: result.elapsedMs
      };
    }

    // 成功：更新解与 lastGood
    state.firstBad = -1;
    state.solution = result;
    var rendered;
    try {
      rendered = A.renderCorrected(state.prep, result.z, state.wav);
    } catch (e) {
      if (e.code === 'TOO_LONG') {
        showFailure(-1, e.message);
        setStatus('error', e.message + '（相位路径已求得，但音频超出支持上限）');
        // 路径仍可查看；不更新 lastGood 音频
        renderTable(); renderAnchorList(); drawChartsSoon();
        return { ok: false, tooLong: true, message: e.message, solution: publicSolution(result) };
      }
      throw e;
    }
    state.rendered = rendered;
    state.fullBytes = A.encodeWav16(rendered.samples, rate(), state.wav.channels);
    var oldCorrectedUrl = state.correctedUrl;
    state.correctedUrl = URL.createObjectURL(new Blob([state.fullBytes], { type: 'audio/wav' }));
    // 校速模式下让试听元素指向新结果；旧 URL 延迟回收，避免媒体栈仍在读时报 ERR_FILE_NOT_FOUND
    if (state.abMode === 'corrected') {
      try { els.compareAudio.src = state.correctedUrl; } catch (e) { /* noop */ }
    }
    if (oldCorrectedUrl) setTimeout(function () { URL.revokeObjectURL(oldCorrectedUrl); }, 15000);
    state.lastGood = {
      anchors: state.anchors.map(function (a) { return { index: a.index, z: a.z }; }),
      solution: result,
      rendered: rendered,
      fullBytes: state.fullBytes
    };

    els.errorBox.hidden = true;
    els.lastGoodBadge.hidden = true;
    els.exportBtn.disabled = false;
    els.exportSelectionBtn.disabled = false;
    document.body.dataset.caseReady = '1';
    document.body.dataset.feasible = 'true';
    document.body.dataset.firstBad = '';

    renderAnchorList();
    renderTable();
    renderDetail();
    syncSelectionInputs(true);
    drawChartsSoon();
    setStatus('ok', '已按当前 ' + state.anchors.length + ' 个锚点求得全段最优路径：折变代价 ' +
      result.costText + '，校速输出 ' + (rendered.frames / rate()).toFixed(2) + ' s' +
      '，DP 用时 ' + result.elapsedMs.toFixed(0) + ' ms。');
    return {
      ok: true, feasible: true, solution: publicSolution(result),
      elapsedMs: result.elapsedMs, frames: rendered.frames
    };
  }

  function publicSolution(result) {
    return {
      z: result.z.slice(),
      zIndices: Array.from(result.zIndices),
      cost: result.costText,
      numberSafe: result.numberSafe,
      elapsedMs: result.elapsedMs,
      outputFrames: S.outputFrameCount(result.z)
    };
  }

  function showFailure(firstBad, message) {
    if (firstBad == null || firstBad < 0) {
      els.firstBadIndex.textContent = '–';
      els.jumpBadBtn.disabled = true;
    } else {
      els.firstBadIndex.textContent = String(firstBad);
      els.jumpBadBtn.disabled = false;
    }
    els.errorDetail.textContent = message || failureDetail(firstBad);
    els.errorBox.hidden = false;
    els.lastGoodBadge.hidden = !state.lastGood;
  }

  function failureDetail(i) {
    if (i == null || i < 0 || !state.prep) return '';
    var p = state.prep;
    var parts = [];
    parts.push('读数 #' + i + '（源帧 x=' + p.xs[i] + '，' + (p.xs[i] / rate()).toFixed(3) + 's）的所有候选都无法在允许速度区间内由前文延续。');
    if (i > 0) {
      var lo = p.rateMin[0] / p.rateMin[1], hi = p.rateMax[0] / p.rateMax[1];
      parts.push('相邻段 dx=' + p.dx[i - 1] + '，要求 ' + lo.toFixed(4) + ' ≤ dz/dx ≤ ' + hi.toFixed(4) +
        '（即 ' + Math.ceil((p.rateMin[0] * p.dx[i - 1]) / p.rateMin[1]) + ' ≤ dz ≤ ' +
        Math.floor((p.rateMax[0] * p.dx[i - 1]) / p.rateMax[1]) + '，整数边界）。');
    }
    var anc = state.anchors.filter(function (a) { return a.index <= i; }).pop();
    if (anc && anc.index > 0 && anc.index < p.n - 1) {
      parts.push('最近的约束来自锚点 #' + anc.index + ' z=' + anc.z + '；可删除或更换该锚点。');
    }
    return parts.join(' ');
  }

  function addAnchor(index, z, mode) {
    if (!state.ready) return { ok: false, reason: 'NO_CASE' };
    index = Number(index);
    var n = state.prep.n;
    if (!Number.isInteger(index) || index < 0 || index >= n) {
      setStatus('error', '锚点编号无效：' + index);
      return { ok: false, reason: 'BAD_INDEX' };
    }
    if (isLockedIndex(index)) {
      var msg = '读数 #' + index + ' 是首尾锁定锚点，不能改动。';
      setStatus('error', msg);
      return { ok: false, reason: 'LOCKED', message: msg };
    }
    // 默认 z 为展开相位；mode==='candidateIndex' 时 z 是候选序号（0..15）
    var zset = state.prep.Z[index];
    var zVal;
    if (mode === 'candidateIndex' || (z && typeof z === 'object' && z.candidateIndex != null)) {
      var ci = (mode === 'candidateIndex') ? z : z.candidateIndex;
      ci = Number(ci);
      if (!Number.isInteger(ci) || ci < 0 || ci >= zset.length) {
        return { ok: false, reason: 'BAD_CANDIDATE_INDEX', candidateCount: zset.length };
      }
      zVal = zset[ci];
    } else {
      zVal = Number(z);
      if (zset.indexOf(zVal) < 0) {
        return { ok: false, reason: 'Z_NOT_CANDIDATE', validZs: zset.slice() };
      }
    }
    var next = state.anchors.filter(function (a) { return a.index !== index; });
    next.push({ index: index, z: zVal });
    return commitAnchors(next);
  }

  function removeAnchor(index) {
    index = Number(index);
    if (!state.ready) return { ok: false, reason: 'NO_CASE' };
    if (isLockedIndex(index)) return { ok: false, reason: 'LOCKED' };
    var next = state.anchors.filter(function (a) { return a.index !== index; });
    return commitAnchors(next);
  }

  function revertToLastGood() {
    if (!state.lastGood) return { ok: false };
    state.anchors = state.lastGood.anchors.map(function (a) { return { index: a.index, z: a.z }; });
    var report = commitAnchors(state.anchors);
    setStatus('ok', '已还原到上一条可用锚点与校速结果。');
    return report;
  }

  /* ---------------- 案例信息 ---------------- */
  function renderCaseMeta(c) {
    var p = state.prep, w = state.wav, proj = state.project;
    var N = p.xs[p.n - 1];
    var dur = w.frames / w.sampleRate;
    var maxCand = Math.max.apply(null, p.klen);
    els.caseMeta.innerHTML =
      meta('音频', w.sampleRate + ' Hz · ' + w.channels + ' 声道 · PCM16') +
      meta('实际帧数', w.frames.toLocaleString() + '（' + dur.toFixed(3) + ' s）') +
      meta('读数数量', p.n.toLocaleString() + '（上限 20000）') +
      meta('每处候选', '最多 ' + maxCand + ' 个（上限 16）') +
      meta('首尾 x', '0 … ' + N.toLocaleString()) +
      meta('rate_min / max', proj.rate_min.join('/') + ' … ' + proj.rate_max.join('/')) +
      meta('文件', state.caseName, true);
    function meta(k, v, wide) {
      return '<div' + (wide ? ' class="wide"' : '') + '><dt>' + k + '</dt><dd>' + v + '</dd></div>';
    }
  }

  /* ---------------- 锚点 UI ---------------- */
  function renderAnchorList() {
    els.anchorCount.textContent = state.anchors.length + ' / ' + state.prep.n;
    var html = state.anchors.slice().sort(function (a, b) { return a.index - b.index; }).map(function (a) {
      var locked = isLockedIndex(a.index);
      var tag = a.index === 0 ? '首锁定' : a.index === state.prep.n - 1 ? '尾锁定' : '手工';
      return '<li class="anchor-item' + (locked ? ' locked' : '') + '" data-index="' + a.index + '">' +
        '<button class="ai-idx" data-action="jump" title="跳转到读数">#' + a.index + '</button>' +
        '<span class="ai-z" title="z=' + a.z + '">z=' + a.z + '</span>' +
        '<span class="ai-tag">' + tag + '</span>' +
        '<button class="anchor-del" data-action="del" data-index="' + a.index + '"' +
        (locked ? ' disabled title="首尾锚点锁定"' : ' title="删除中间锚点"') + ' aria-label="删除锚点 #' + a.index + '">×</button>' +
        '</li>';
    }).join('');
    els.anchorList.innerHTML = html || '<li class="hint">暂无锚点</li>';
  }

  els.anchorList.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var i = Number(btn.getAttribute('data-index'));
    if (btn.getAttribute('data-action') === 'del') {
      var rep = removeAnchor(i);
      if (rep && rep.ok === false && rep.reason === 'LOCKED') setStatus('error', '首尾锚点不可删除。');
    } else if (btn.getAttribute('data-action') === 'jump') {
      scrollToIndex(i);
    }
  });

  function populateAnchorIndexDatalist() {
    // select 候选由 #anchorIndex change 时填充
    els.anchorValue.innerHTML = '<option value="">输入读数编号后选择候选</option>';
  }

  function fillAnchorCandidates(index) {
    if (!state.ready || !(index >= 0 && index < state.prep.n)) {
      els.anchorValue.innerHTML = '<option value="">编号超出范围</option>';
      return;
    }
    var zs = state.prep.Z[index];
    var p = state.project.marks[index][1];
    var cur = state.anchors.filter(function (a) { return a.index === index; })[0];
    els.anchorValue.innerHTML = zs.map(function (z, ci) {
      var k = zToK(z, p);
      return '<option value="' + z + '"' + (cur && cur.z === z ? ' selected' : '') + '>' +
        'k=' + k + ' · z=' + z + '（候选 ' + (ci + 1) + '/' + zs.length + '）</option>';
    }).join('');
  }

  els.anchorIndex.addEventListener('input', function () {
    var i = Number(els.anchorIndex.value);
    fillAnchorCandidates(i);
  });
  els.anchorIndex.addEventListener('change', function () {
    var i = Number(els.anchorIndex.value);
    if (state.ready && i >= 0 && i < state.prep.n) { selectIndex(i, false); fillAnchorCandidates(i); }
  });

  els.anchorForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var i = Number(els.anchorIndex.value);
    var z = Number(els.anchorValue.value);
    if (!state.ready || !(i >= 0 && i < state.prep.n)) {
      setStatus('error', '请先填写有效的中间读数编号（0..' + (state.prep ? state.prep.n - 1 : 0) + '）。');
      return;
    }
    if (isLockedIndex(i)) { setStatus('error', '首尾读数已锁定，不能作为中间锚点修改。'); return; }
    if (!Number.isInteger(z)) { setStatus('error', '请选择一个候选展开相位。'); return; }
    setStatus('working', '正在加入锚点 #' + i + ' 并重新求全段最优路径…');
    setTimeout(function () {
      var rep = addAnchor(i, z);
      if (rep.ok) { selectIndex(i, true); }
    }, 20);
  });

  els.pickFromDetailBtn.addEventListener('click', function () {
    var i = state.selectedIndex;
    if (state.pendingCandidateZ != null) {
      if (isLockedIndex(i)) { setStatus('error', '首尾锚点锁定。'); return; }
      setStatus('working', '正在加入锚点 #' + i + ' …');
      var z = state.pendingCandidateZ;
      setTimeout(function () { addAnchor(i, z); }, 20);
    } else {
      els.anchorIndex.value = String(i);
      fillAnchorCandidates(i);
      els.anchorValue.focus();
    }
  });

  els.revertAnchorBtn.addEventListener('click', function () { revertToLastGood(); });
  els.jumpBadBtn.addEventListener('click', function () {
    if (state.firstBad >= 0) scrollToIndex(state.firstBad);
  });

  /* ---------------- 明细面板 ---------------- */
  function selectIndex(i, scroll) {
    state.selectedIndex = i;
    state.pendingCandidateZ = null;
    renderDetail();
    renderTable();
    if (scroll) scrollToIndex(i);
  }
  window.__pilotSelectIndex = selectIndex;

  function renderDetail() {
    if (!state.ready) return;
    var i = state.selectedIndex;
    var p = state.prep, zs = p.Z[i], mark = state.project.marks[i];
    var sel = state.solution ? state.solution.z[i] : null;
    var anc = state.anchors.filter(function (a) { return a.index === i; })[0];
    els.detailIndex.textContent = '#' + i;
    var slope = '';
    if (i > 0 && state.solution) {
      var dz = state.solution.z[i] - state.solution.z[i - 1];
      var dx = p.dx[i - 1];
      slope = '<span>入段 dz=' + dz + '</span><span>dx=' + dx + '</span><span>dz/dx=' + (dz / dx).toFixed(5) + '</span>';
    }
    var chips = zs.map(function (z, ci) {
      var cls = 'chip';
      if (z === sel) cls += ' selected';
      if (anc && anc.z === z) cls += ' anchor';
      return '<button type="button" class="' + cls + '" data-z="' + z + '" title="点击将该候选设为读数 #' + i + ' 的锚点">' +
        'z=' + z + '<small>k=' + zToK(z, mark[1]) + ' · 候选' + (ci + 1) + '</small></button>';
    }).join('');
    els.detailBody.innerHTML =
      '<div class="detail-meta">' +
      '<span>x=' + mark[0] + ' 帧（' + (mark[0] / rate()).toFixed(4) + 's）</span>' +
      '<span>p=' + mark[1] + '</span>' + slope +
      (anc ? '<span class="tag anchor">锚点 z=' + anc.z + (isLockedIndex(i) ? '（锁定）' : '') + '</span>' : '') +
      (state.firstBad === i ? '<span class="tag bad">第一处无法延续</span>' : '') +
      '</div><div class="candidate-chips">' + chips + '</div>';
    els.pickFromDetailBtn.disabled = false;
    els.pickFromDetailBtn.textContent = '把高亮候选 z=' + (state.pendingCandidateZ == null ? '（点选下方候选）' : state.pendingCandidateZ) + ' 设为锚点';
  }

  els.detailBody.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var z = Number(chip.getAttribute('data-z'));
    state.pendingCandidateZ = z;
    var i = state.selectedIndex;
    if (isLockedIndex(i)) { setStatus('error', '读数 #' + i + ' 为首/尾锁定锚点，不能改锚。'); return; }
    setStatus('working', '正在以 z=' + z + ' 锚定 #' + i + ' 并重新求解…');
    setTimeout(function () { addAnchor(i, z); }, 10);
  });
  els.detailBody.addEventListener('mouseover', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) { state.pendingCandidateZ = Number(chip.getAttribute('data-z')); els.pickFromDetailBtn.textContent = '把候选 z=' + state.pendingCandidateZ + ' 设为锚点'; }
  });

  /* ---------------- 全量数据表（轻量行，保证任意 #i 可被选择器定位） ---------------- */
  function visibleIndices() {
    var n = state.prep.n;
    if (!state.filterOnlyMarks) return { all: true, list: null, count: n };
    var set = new Set();
    state.anchors.forEach(function (a) { set.add(a.index); });
    if (state.firstBad >= 0) set.add(state.firstBad);
    return { all: false, list: Array.from(set).sort(function (a, b) { return a - b; }), count: set.size };
  }

  function renderTable() {
    if (!state.ready) return;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var vi = visibleIndices();
    els.tableSummary.textContent = vi.all ? state.prep.n + ' 行' : '筛选 ' + vi.count + ' 行';
    var html;
    if (vi.all) {
      var rows = new Array(state.prep.n);
      for (var i = 0; i < state.prep.n; i++) rows[i] = rowHtml(i);
      html = rows.join('');
    } else {
      html = vi.list.map(rowHtml).join('');
    }
    els.markTbody.innerHTML = html;
    state.lastTableRenderMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  function rowHtml(i) {
    var p = state.prep, mark = state.project.marks[i], zs = p.Z[i];
    var sel = state.solution ? state.solution.z[i] : null;
    var selIdx = state.solution ? state.solution.zIndices[i] : -1;
    var anc = state.anchors.filter(function (a) { return a.index === i; })[0];
    var isBad = state.firstBad === i;
    var cls = 'data-row';
    if (anc) cls += ' anchor-row';
    if (isBad) cls += ' bad-row';
    if (state.selectedIndex === i) cls += ' selected';

    // 轻量文本候选；仅最终选值加粗
    var zTexts = zs.map(function (z, ci) {
      return ci === selIdx ? '<b class="z-selected">' + z + '</b>' : String(z);
    }).join('/');

    var slope = '–';
    if (i > 0 && state.solution) {
      var dz = state.solution.z[i] - state.solution.z[i - 1];
      var dx = p.dx[i - 1];
      slope = (dz / dx).toFixed(4) + ' <span class="dim">(' + dz + '/' + dx + ')</span>';
    }
    var status = '';
    if (isBad) status += '<span class="tag bad">无法延续</span> ';
    if (anc) status += '<span class="tag anchor">锚点' + (isLockedIndex(i) ? '·锁' : '') + '</span>';
    if (!status) status = '<span class="tag off">候选 ' + zs.length + '</span>';

    return '<tr class="' + cls + '" data-index="' + i + '" data-testid="mark-row" role="button" tabindex="-1">' +
      '<td class="c-idx">' + i + '</td>' +
      '<td class="c-x">' + mark[0].toLocaleString() + '</td>' +
      '<td class="c-t">' + (mark[0] / rate()).toFixed(3) + '</td>' +
      '<td class="c-p">' + mark[1] + '</td>' +
      '<td class="c-k" title="k ∈ [' + mark[2] + ' … ' + mark[3] + ']，共 ' + zs.length + ' 个">[' +
        mark[2] + '..' + mark[3] + '] ×' + zs.length + '</td>' +
      '<td class="c-z" title="' + zs.join(', ') + '">' + zTexts + '</td>' +
      '<td class="c-sel">' + (sel == null ? '–' : sel + ' <span class="dim">k' + zToK(sel, mark[1]) + '</span>') + '</td>' +
      '<td class="c-slope">' + slope + '</td>' +
      '<td class="c-st">' + status + '</td>' +
      '</tr>';
  }

  els.markTbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.data-row');
    if (tr) selectIndex(Number(tr.getAttribute('data-index')), false);
  });
  els.rowJumpBtn.addEventListener('click', function () {
    var i = Number(els.rowJump.value);
    if (state.ready && i >= 0 && i < state.prep.n) {
      els.onlyAnchorBad.checked = false; state.filterOnlyMarks = false; renderTable();
      selectIndex(i, true);
    }
  });
  els.rowJump.addEventListener('keydown', function (e) { if (e.key === 'Enter') els.rowJumpBtn.click(); });
  els.onlyAnchorBad.addEventListener('change', function () {
    state.filterOnlyMarks = els.onlyAnchorBad.checked;
    renderTable();
  });

  function scrollToIndex(i) {
    state.filterOnlyMarks = false;
    els.onlyAnchorBad.checked = false;
    if (!state.filterOnlyMarks && !els.markTbody.querySelector('tr[data-index="' + i + '"]')) renderTable();
    selectIndex(i, false);
    var tr = els.markTbody.querySelector('tr[data-index="' + i + '"]');
    if (tr) tr.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  /* ---------------- 图表 ---------------- */
  var resizeObs = null;
  function setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentElement.clientWidth;
    var h = cv.clientHeight || cv.parentElement.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function chartRanges() {
    if (state.chartCache) return state.chartCache;
    var p = state.prep;
    var zmin = Infinity, zmax = -Infinity;
    p.Z.forEach(function (zs) {
      for (var i = 0; i < zs.length; i++) { if (zs[i] < zmin) zmin = zs[i]; if (zs[i] > zmax) zmax = zs[i]; }
    });
    var smin = Infinity, smax = -Infinity;
    if (state.solution) {
      for (var e = 0; e < p.dx.length; e++) {
        var s = (state.solution.z[e + 1] - state.solution.z[e]) / p.dx[e];
        if (s < smin) smin = s; if (s > smax) smax = s;
      }
    }
    state.chartCache = { zmin: zmin, zmax: zmax, smin: smin, smax: smax };
    return state.chartCache;
  }

  function drawChartsSoon() {
    state.chartCache = null;
    requestAnimationFrame(drawAllCharts);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawAllCharts() {
    if (!state.ready) return;
    drawPhase();
    drawSpeed();
  }

  function drawAxes(ctx, box, xDom, yDom, yTicks, fmtY) {
    var ink3 = cssVar('--ink-3') || '#7b8aa0';
    var line = cssVar('--line') || '#d9e1ec';
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.lineWidth = 1;
    yTicks.forEach(function (t) {
      var y = box.t + box.h * (1 - (t - yDom[0]) / (yDom[1] - yDom[0]));
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(box.l, y); ctx.lineTo(box.l + box.w, y); ctx.stroke();
      ctx.fillStyle = ink3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtY ? fmtY(t) : String(t), box.l - 7, y);
    });
    // x 秒刻度（约 6 格）
    var dur = xDom[1] / rate();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var k = 0; k <= 6; k++) {
      var sec = dur * k / 6;
      var x = box.l + box.w * (k / 6);
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(x, box.t); ctx.lineTo(x, box.t + box.h); ctx.stroke();
      ctx.fillStyle = ink3;
      ctx.fillText(sec.toFixed(dur < 2 ? 2 : 1) + 's', x, box.t + box.h + 6);
    }
  }

  function xToPx(x, box, xmax) { return box.l + box.w * (x / xmax); }

  function drawPhase() {
    var cv = els.phaseCanvas;
    var d = setupCanvas(cv), ctx = d.ctx, W = d.w, H = d.h;
    ctx.clearRect(0, 0, W, H);
    var p = state.prep, r = chartRanges();
    var box = { l: 58, r: 14, t: 12, h: H - 38, w: 0 };
    box.w = W - box.l - box.r;
    var xmax = p.xs[p.n - 1] || 1;
    var padZ = Math.max(256, (r.zmax - r.zmin) * 0.06);
    var yDom = [r.zmin - padZ, r.zmax + padZ];
    function yPx(z) { return box.t + box.h * (1 - (z - yDom[0]) / (yDom[1] - yDom[0])); }

    var zTicks = [];
    for (var t = 0; t <= 4; t++) zTicks.push(yDom[0] + (yDom[1] - yDom[0]) * t / 4);
    drawAxes(ctx, box, [0, xmax], yDom, zTicks, function (z) { return (z / 1e6).toFixed(2) + 'M'; });

    // 候选点
    var candColor = cssVar('--candidate') || '#a9b7c9';
    ctx.fillStyle = candColor;
    for (var i = 0; i < p.n; i++) {
      var cx = xToPx(p.xs[i], box, xmax);
      var zs = p.Z[i];
      for (var j = 0; j < zs.length; j++) {
        var cy = yPx(zs[j]);
        ctx.fillRect(cx - 1, cy - 1, 2.4, 2.4);
      }
    }

    // 最优路径
    if (state.solution) {
      var blue = cssVar('--series-1') || '#257de0';
      ctx.strokeStyle = blue; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      state.solution.z.forEach(function (z, idx) {
        var x = xToPx(p.xs[idx], box, xmax), y = yPx(z);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 锚点
    var anchorColor = cssVar('--anchor') || '#f47230';
    state.anchors.forEach(function (a) {
      var x = xToPx(p.xs[a.index], box, xmax), y = yPx(a.z);
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = anchorColor; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--surface-1') || '#fff'; ctx.stroke();
    });

    // 无解读数
    if (state.firstBad >= 0) {
      var bi = state.firstBad;
      var bx = xToPx(p.xs[bi], box, xmax);
      var by = state.solution ? yPx(state.solution.z[Math.min(bi, state.solution.z.length - 1)]) : box.t + box.h / 2;
      var red = cssVar('--critical') || '#d23b3c';
      ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.strokeStyle = red; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx - 4, by - 4); ctx.lineTo(bx + 4, by + 4);
      ctx.moveTo(bx + 4, by - 4); ctx.lineTo(bx - 4, by + 4); ctx.stroke();
    }
    cv._box = box; cv._xmax = xmax; cv._yPx = yPx; cv._yDom = yDom;
  }

  function drawSpeed() {
    var cv = els.speedCanvas;
    var d = setupCanvas(cv), ctx = d.ctx, W = d.w, H = d.h;
    ctx.clearRect(0, 0, W, H);
    var p = state.prep;
    var box = { l: 58, r: 14, t: 10, h: H - 34, w: W - 72 };
    var xmax = p.xs[p.n - 1] || 1;
    var rlo = p.rateMin[0] / p.rateMin[1], rhi = p.rateMax[0] / p.rateMax[1];
    var r = chartRanges();
    var lo = Math.min(rlo, isFinite(r.smin) ? r.smin : rlo) ;
    var hi = Math.max(rhi, isFinite(r.smax) ? r.smax : rhi);
    var pad = Math.max(0.2, (hi - lo) * 0.12);
    var yDom = [lo - pad, hi + pad];
    function yPx(s) { return box.t + box.h * (1 - (s - yDom[0]) / (yDom[1] - yDom[0])); }

    var ticks = [];
    for (var k = 0; k <= 4; k++) ticks.push(yDom[0] + (yDom[1] - yDom[0]) * k / 4);

    // 允许区间带（先画，置于网格之下）
    var goodSoft = cssVar('--good-soft') || '#e4f5e6';
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = goodSoft;
    ctx.fillRect(box.l, yPx(rhi), box.w, Math.max(1, yPx(rlo) - yPx(rhi)));
    ctx.restore();

    drawAxes(ctx, box, [0, xmax], yDom, ticks, function (v) { return v.toFixed(1); });

    ctx.strokeStyle = cssVar('--good') || '#008a17';
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
    [rlo, rhi].forEach(function (v) {
      ctx.beginPath(); ctx.moveTo(box.l, yPx(v)); ctx.lineTo(box.l + box.w, yPx(v)); ctx.stroke();
    });
    ctx.setLineDash([]);

    if (state.solution) {
      var blue = cssVar('--series-1') || '#257de0';
      ctx.strokeStyle = blue; ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (var e = 0; e < p.dx.length; e++) {
        var s = (state.solution.z[e + 1] - state.solution.z[e]) / p.dx[e];
        // 画在段中点 x
        var xm = (p.xs[e] + p.xs[e + 1]) / 2;
        var x = xToPx(xm, box, xmax), y = yPx(s);
        if (e === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    cv._box = box; cv._xmax = xmax;
  }

  /* ---------------- 悬停联动 ---------------- */
  function nearestIndexFromEvent(ev, cv) {
    var rect = cv.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var box = cv._box;
    if (!box || x < box.l || x > box.l + box.w) return -1;
    var xFrame = (x - box.l) / box.w * cv._xmax;
    var xs = state.prep.xs;
    // 二分最近读数
    var lo = 0, hi = xs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (xs[mid] < xFrame) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(xs[lo - 1] - xFrame) < Math.abs(xs[lo] - xFrame)) lo = lo - 1;
    return lo;
  }

  function bindHover(baseCv, hoverCv, isPhase) {
    baseCv.parentElement.addEventListener('mousemove', function (ev) {
      if (!state.ready) return;
      var i = nearestIndexFromEvent(ev, baseCv);
      if (i < 0) { hideHover(); return; }
      drawHover(i, ev);
    });
    baseCv.parentElement.addEventListener('mouseleave', hideHover);
  }
  function hideHover() {
    els.phaseTooltip.hidden = true;
    [els.phaseHover, els.speedHover].forEach(function (cv) {
      var d = setupCanvas(cv); d.ctx.clearRect(0, 0, d.w, d.h);
    });
  }
  function drawHover(i, ev) {
    [els.phaseHover, els.speedHover].forEach(function (cv) {
      var d = setupCanvas(cv); d.ctx.clearRect(0, 0, d.w, d.h);
      var base = cv === els.phaseHover ? els.phaseCanvas : els.speedCanvas;
      var box = base._box, xmax = base._xmax;
      if (!box || !xmax) return;
      var x = box.l + box.w * (state.prep.xs[i] / xmax);
      d.ctx.strokeStyle = cssVar('--ink-3') || '#7b8aa0';
      d.ctx.setLineDash([4, 4]); d.ctx.lineWidth = 1;
      d.ctx.beginPath(); d.ctx.moveTo(x, box.t); d.ctx.lineTo(x, box.t + box.h); d.ctx.stroke();
      d.ctx.setLineDash([]);
    });
    // tooltip
    var p = state.prep, zs = p.Z[i];
    var sel = state.solution ? state.solution.z[i] : null;
    var anc = state.anchors.filter(function (a) { return a.index === i; })[0];
    var lines = ['#' + i + '  x=' + p.xs[i] + '  t=' + (p.xs[i] / rate()).toFixed(4) + 's',
      'p=' + state.project.marks[i][1] + '  候选 ' + zs.length + ' 个: ' + zs.join(', '),
      '最终选值 z=' + sel + (state.solution ? ' (k=' + zToK(sel, state.project.marks[i][1]) + ')' : '')];
    if (i > 0 && state.solution) {
      var dz = state.solution.z[i] - state.solution.z[i - 1];
      lines.push('入段斜率 ' + (dz / p.dx[i - 1]).toFixed(5) + '  (dz=' + dz + ', dx=' + p.dx[i - 1] + ')');
    }
    if (anc) lines.push('⚓ 锚点 z=' + anc.z + (isLockedIndex(i) ? '（锁定）' : ''));
    if (state.firstBad === i) lines.push('✖ 第一处无法延续');
    var tt = els.phaseTooltip;
    tt.textContent = lines.join('\n');
    tt.hidden = false;
    var wrapW = els.phaseWrap.clientWidth;
    var rect = els.phaseWrap.getBoundingClientRect();
    var clientX = ev && typeof ev.clientX === 'number' ? ev.clientX : rect.left + 60;
    var mx = clientX - rect.left;
    tt.style.left = clamp(mx + 14, 8, Math.max(8, wrapW - tt.offsetWidth - 8)) + 'px';
    tt.style.top = '14px';
  }
  bindHover(els.phaseCanvas, els.phaseHover, true);
  bindHover(els.speedCanvas, els.speedHover, false);

  // 点击相位/速度图：选中最近读数并滚动明细表，随后可在明细中一键设锚
  [els.phaseCanvas, els.speedCanvas].forEach(function (cv) {
    cv.addEventListener('click', function (ev) {
      if (!state.ready) return;
      var i = nearestIndexFromEvent(ev, cv);
      if (i >= 0) {
        selectIndex(i, false);
        var row = els.markTbody.querySelector('tr[data-index="' + i + '"]');
        if (row) row.scrollIntoView({ block: 'center' });
      }
    });
    cv.style.cursor = 'crosshair';
  });

  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function () { if (state.ready) drawAllCharts(); });
    if (els.phaseWrap) ro.observe(els.phaseWrap);
    if (els.speedWrap) ro.observe(els.speedWrap);
  }
  var resizeT = 0;
  window.addEventListener('resize', function () {
    if (!state.ready) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(drawAllCharts, 120);
  });

  /* ---------------- 选区 / 导出 ---------------- */
  function durationSec() { return state.rendered ? state.rendered.frames / rate() : 0; }
  function syncSelectionInputs(resetEnd) {
    if (!state.rendered) return;
    var total = state.rendered.frames;
    if (resetEnd) {
      els.selStartFrame.value = 0;
      els.selEndFrame.value = total;
      els.selStartSec.value = '0';
      els.selEndSec.value = (total / rate()).toFixed(4);
    }
    els.selStartFrame.max = total; els.selEndFrame.max = total;
  }
  function secToFrame(v) { return Math.round(Number(v) * rate()); }
  function frameToSec(v) { return (Number(v) / rate()).toFixed(4); }

  els.selStartSec.addEventListener('input', function () {
    if (!state.rendered) return;
    els.selStartFrame.value = clamp(secToFrame(els.selStartSec.value), 0, state.rendered.frames);
  });
  els.selEndSec.addEventListener('input', function () {
    if (!state.rendered) return;
    els.selEndFrame.value = clamp(secToFrame(els.selEndSec.value), 0, state.rendered.frames);
  });
  els.selStartFrame.addEventListener('input', function () { els.selStartSec.value = frameToSec(els.selStartFrame.value || 0); });
  els.selEndFrame.addEventListener('input', function () { els.selEndSec.value = frameToSec(els.selEndFrame.value || 0); });
  els.selFullBtn.addEventListener('click', function () {
    if (!state.rendered) return;
    els.selStartFrame.value = 0; els.selEndFrame.value = state.rendered.frames;
    syncSelectionInputs(true);
  });

  function getSelectionFrameRange() {
    var total = state.lastGood.rendered.frames;
    var f0 = clamp(parseInt(els.selStartFrame.value, 10) || 0, 0, total);
    var f1 = clamp(parseInt(els.selEndFrame.value, 10) || 0, 0, total);
    if (f1 < f0) { var t = f0; f0 = f1; f1 = t; }
    return { f0: f0, f1: f1 };
  }

  function exportWavBytes(range) {
    if (!state.lastGood) throw new Error('尚无可用校速结果');
    if (!range) return state.lastGood.fullBytes.slice();
    var sel = A.selectionSamples(state.lastGood.rendered, range.f0, range.f1);
    return A.encodeWav16(sel.samples, rate(), state.wav.channels);
  }

  els.exportBtn.addEventListener('click', function () {
    if (!state.lastGood) return;
    downloadBytes(state.lastGood.fullBytes, 'pilot-corrected-full.wav');
    els.exportStatus.textContent = '已导出整段 ' + state.lastGood.rendered.frames + ' 帧（' +
      (state.lastGood.rendered.frames / rate()).toFixed(2) + 's）。';
  });
  els.exportSelectionBtn.addEventListener('click', function () {
    if (!state.lastGood) return;
    var r = getSelectionFrameRange();
    var bytes = exportWavBytes(r);
    downloadBytes(bytes, 'pilot-corrected-selection-' + r.f0 + '-' + r.f1 + '.wav');
    els.exportStatus.textContent = '已导出选区 [' + r.f0 + ', ' + r.f1 + ')，共 ' + (r.f1 - r.f0) +
      ' 帧；PCM 码与整段 WAV 同区间逐码一致。';
  });

  /* ---------------- 对照试听 A/B + 位置映射 ---------------- */
  function updateAbButtons() {
    var orig = state.abMode === 'original';
    els.listenOriginal.classList.toggle('active', orig);
    els.listenCorrected.classList.toggle('active', !orig);
    els.listenOriginal.setAttribute('aria-pressed', String(orig));
    els.listenCorrected.setAttribute('aria-pressed', String(!orig));
  }

  // 输出帧 f（校正时间*rate）→ 连续源帧 x
  function outputFrameToSourceX(f) {
    var p = state.prep, z = state.solution.z, n = p.n;
    var yNum = z.map(function (zz) { return 3 * (zz - z[0]); });
    var target = 16 * f;
    var lo = 0, hi = n - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (yNum[mid] <= target) lo = mid; else hi = mid; }
    var i = Math.min(lo, n - 2);
    var den = yNum[i + 1] - yNum[i];
    var alpha = den === 0 ? 0 : clamp((target - yNum[i]) / den, 0, 1);
    return p.xs[i] + alpha * p.dx[i];
  }
  // 连续源帧 x → 输出帧（浮点）
  function sourceXToOutputFrame(x) {
    var p = state.prep, z = state.solution.z, n = p.n;
    var lo = 0, hi = n - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (p.xs[mid] <= x) lo = mid; else hi = mid; }
    var i = Math.min(lo, n - 2);
    var alpha = clamp((x - p.xs[i]) / p.dx[i], 0, 1);
    var yNum0 = 3 * (z[i] - z[0]), yNum1 = 3 * (z[i + 1] - z[0]);
    return (yNum0 + alpha * (yNum1 - yNum0)) / 16;
  }

  function switchAb(mode) {
    if (!state.ready || state.abMode === mode) return;
    var audio = els.compareAudio;
    var wasPlaying = !audio.paused;
    var curSec = audio.currentTime || 0;
    var newSec = 0;
    if (mode === 'original') {
      var fOut = curSec * rate();
      newSec = outputFrameToSourceX(fOut) / rate();
      audio.src = state.originalUrl;
    } else {
      var xSrc = curSec * rate();
      newSec = sourceXToOutputFrame(xSrc) / rate();
      if (!state.correctedUrl && state.fullBytes) state.correctedUrl = URL.createObjectURL(new Blob([state.fullBytes], { type: 'audio/wav' }));
      audio.src = state.correctedUrl;
    }
    state.abMode = mode;
    updateAbButtons();
    audio.currentTime = clamp(newSec, 0, audio.duration || newSec);
    if (wasPlaying) audio.play().catch(function () { /* 自动播放策略：等待用户再点播放 */ });
    els.abHint.textContent = mode === 'original'
      ? '原带：已按反查曲线映射到对应源位置。'
      : '校速：已按展开曲线映射到对应输出位置；两声道共用同一时钟。';
  }
  els.listenOriginal.addEventListener('click', function () { switchAb('original'); });
  els.listenCorrected.addEventListener('click', function () { switchAb('corrected'); });

  /* ---------------- 文件输入 / 拖放 / 样例 ---------------- */
  async function handlePickedFiles(files) {
    if (!files || !files.length) return;
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      return loadCaseFromFile(files[0]);
    }
    var seq = ++loadSeq;
    els.exportBtn.disabled = true;
    els.exportSelectionBtn.disabled = true;
    setStatus('working', '正在读取所选文件 …');
    try {
      var c = await IO.loadCaseFromFileList(files);
      if (seq !== loadSeq) return;
      initCase(c, files.length === 1 ? files[0].name : '多选文件');
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error(e);
      setStatus('error', '导入失败：' + e.message + '（单导 project.json 时请同时选择 tape.wav，或直接导入 ZIP）');
    }
  }
  els.fileInput.addEventListener('change', function () {
    handlePickedFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  if (els['file-input']) {
    els['file-input'].addEventListener('change', function () {
      handlePickedFiles(els['file-input'].files);
      els['file-input'].value = '';
    });
  }

  els.loadSampleBtn.addEventListener('click', function () {
    loadCaseFromUrl('samples/pilot-cycle-cases.zip', 'pilot-cycle-cases.zip');
  });

  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadCaseFromFile(f);
  });

  /* ---------------- 对外 API（自动化 / 控制台） ---------------- */
  var api = {
    version: '1.0.0',
    S: S, A: A, IO: IO,
    loadCaseFromUrl: loadCaseFromUrl,
    loadCaseFromFile: loadCaseFromFile,
    // 自动化/性能测试钩子：直接载入 project 对象并合成与末 x 等长的正弦 PCM
    loadSyntheticForTest: function (project, opts) {
      opts = opts || {};
      var N = project.marks[project.marks.length - 1][0];
      var ch = opts.channels || 2, sr = opts.sampleRate || 48000;
      var samples = new Int16Array(N * ch);
      if (opts.tone !== false) {
        for (var i = 0; i < N; i++) {
          var v = Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / sr));
          samples[i * ch] = v;
          if (ch === 2) samples[i * ch + 1] = Math.round(9000 * Math.cos(2 * Math.PI * 220 * i / sr));
        }
      }
      var wav = { sampleRate: sr, channels: ch, frames: N, samples: samples };
      initCase({ project: project, wav: wav, projectName: 'synthetic.json', fileNames: [] }, opts.name || 'synthetic-case');
      return api.getState();
    },
    getState: function () {
      return {
        ready: state.ready,
        caseName: state.caseName,
        n: state.prep ? state.prep.n : 0,
        anchors: state.anchors.map(function (a) { return { index: a.index, z: a.z, locked: !!a.locked }; }),
        feasible: !state.attempt || state.attempt.ok !== false,
        firstBad: state.firstBad,
        solution: state.solution ? publicSolution(state.solution) : null,
        lastGoodAnchors: state.lastGood ? state.lastGood.anchors : null,
        outputFrames: state.rendered ? state.rendered.frames : 0
      };
    },
    getAnchors: function () {
      return state.anchors.map(function (a) { return { index: a.index, z: a.z, locked: !!a.locked }; });
    },
    getProject: function () { return state.project; },
    getCandidates: function (i) {
      if (!state.prep) return null;
      var zs = state.prep.Z[Number(i)];
      var p = state.project.marks[Number(i)][1];
      return zs.map(function (z, ci) { return { index: ci, k: zToK(z, p), z: z }; });
    },
    getLastGood: function () {
      if (!state.lastGood) return null;
      return {
        anchors: state.lastGood.anchors.map(function (a) { return { index: a.index, z: a.z }; }),
        solution: publicSolution(state.lastGood.solution),
        outputFrames: state.lastGood.rendered.frames
      };
    },
    addAnchor: addAnchor,
    removeAnchor: removeAnchor,
    revertToLastGood: revertToLastGood,
    solve: function () { return commitAnchors(state.anchors); },
    scrollToIndex: scrollToIndex,
    selectIndex: selectIndex,
    exportWav: function (startFrame, endFrame) {
      if (startFrame == null) return exportWavBytes(null);
      return exportWavBytes({ f0: startFrame, f1: endFrame == null ? state.lastGood.rendered.frames : endFrame });
    },
    getSelectionFrameRange: getSelectionFrameRange,
    outputFrameToSourceX: function (f) { return outputFrameToSourceX(f); },
    sourceXToOutputFrame: function (x) { return sourceXToOutputFrame(x); }
  };
  window.PilotApp = api;
  window.__pilot = api;
  window.pilotRestorer = api;
  // 常见命名别名，便于不同验证脚本发现引擎
  window.PilotCycleRestorer = api;
  window.PilotEngine = { Solver: S, Audio: A, IO: IO, app: api };
  window.PilotCycleSolver = S;
  window.pilotSolver = S;
  // 便捷顶层钩子（与同系列任务风格一致）
  window.solvePilotCase = function (project, anchors) { return S.solveProject(project, anchors); };
  window.solvePilot = window.solvePilotCase;

  /* ---------------- 启动：http 下静默尝试内置样例 ---------------- */
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    loadCaseFromUrl('samples/pilot-cycle-cases.zip', 'pilot-cycle-cases.zip');
  }
})();
