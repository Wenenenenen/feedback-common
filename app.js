'use strict';

(() => {
  const Core = window.AnchoredPartialSynth;
  const $ = (id) => document.getElementById(id);

  const PAGE_SIZE = 100;
  const player = $('audio-player');

  const state = {
    doc: null,
    viewCompiled: null,
    compileError: null,
    good: null,
    selectedTrackId: null,
    selectedSegment: 0,
    anchorPage: 0,
    selectionStart: 0,
    selectionEnd: 0,
    soloTrackId: null,
    playerUrlKind: 'full',
    renderToken: 0,
    debounceTimer: 0,
    loadStartedAt: 0,
    lastRenderMs: null,
    lastTotalMs: null,
  };

  const api = { state };
  window.AnchoredPartialApp = api;

  function getSelectedTrack() {
    return state.doc?.tracks?.find((t) => String(t.id) === String(state.selectedTrackId)) || null;
  }

  function getCompiledTrack() {
    return state.viewCompiled?.tracks?.find((t) => String(t.id) === String(state.selectedTrackId)) || null;
  }

  function setStatus(kind, text, extra = {}) {
    const banner = $('status-banner');
    banner.dataset.state = kind;
    Object.entries(extra).forEach(([key, value]) => { banner.dataset[key] = value; });
    $('status-text').textContent = text;
  }

  function showToast(message, kind = '') {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function wavUrl(bytes) {
    const blob = new Blob([bytes], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  }

  function setPlayerSource(url, kind, autoplay = false) {
    const oldUrl = player.src?.startsWith('blob:') ? player.src : null;
    player.src = url;
    player.load();
    state.playerUrlKind = kind;
    if (autoplay) {
      const maybePlay = player.play();
      if (maybePlay && typeof maybePlay.catch === 'function') maybePlay.catch(() => {});
    }
    if (oldUrl && oldUrl !== url) {
      // Delay revocation so media elements have detached from the old resource.
      window.setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
    }
  }

  async function waitForAudioReady(token) {
    if (player.readyState < 1) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          player.removeEventListener('loadedmetadata', finish);
          player.removeEventListener('canplay', finish);
          player.removeEventListener('error', finish);
          window.setTimeout(resolve, 0);
        };
        player.addEventListener('loadedmetadata', finish, { once: true });
        player.addEventListener('canplay', finish, { once: true });
        player.addEventListener('error', finish, { once: true });
        window.setTimeout(finish, 1500);
      });
    }
    return token === state.renderToken;
  }

  function renderTrackList() {
    const list = $('track-list');
    list.innerHTML = '';
    if (!state.doc?.tracks?.length) {
      list.innerHTML = '<p class="muted small" style="padding:8px">尚无轨道</p>';
      return;
    }
    for (const track of state.doc.tracks) {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.dataset.trackId = track.id;
      if (String(track.id) === String(state.selectedTrackId)) row.classList.add('active');
      if (state.soloTrackId != null && String(track.id) === String(state.soloTrackId)) row.classList.add('solo');

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'track-select';
      select.dataset.action = 'select-track';
      select.innerHTML = `<strong></strong><span></span>`;
      select.querySelector('strong').textContent = track.id;
      select.querySelector('span').textContent = `${track.anchors.length} 锚点 · ${track.anchors.length - 1} 段`;

      const solo = document.createElement('button');
      solo.type = 'button';
      solo.className = `btn btn-small ${String(state.soloTrackId) === String(track.id) ? 'btn-warn' : ''}`;
      solo.dataset.action = 'solo-track';
      solo.textContent = String(state.soloTrackId) === String(track.id) ? '停止独听' : '独听';

      row.append(select, solo);
      list.appendChild(row);
    }
    $('solo-status').textContent = state.soloTrackId == null ? '当前：全部合听' : `当前：独听 ${state.soloTrackId}（仍保持全工程时长）`;
  }

  function hzValue(milliHz) {
    return Number.isFinite(Number(milliHz)) ? (Number(milliHz) / 1000).toFixed(3) : '';
  }

  function renderAnchorTable() {
    const track = getSelectedTrack();
    const tbody = $('anchor-tbody');
    tbody.innerHTML = '';
    if (!track) {
      $('anchor-page-label').textContent = '0/0';
      return;
    }
    const count = track.anchors.length;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    state.anchorPage = Math.min(state.anchorPage, totalPages - 1);
    const start = state.anchorPage * PAGE_SIZE;
    const end = Math.min(count, start + PAGE_SIZE);
    $('anchor-page-label').textContent = `${state.anchorPage + 1}/${totalPages}`;
    $('anchor-prev-page').disabled = state.anchorPage === 0;
    $('anchor-next-page').disabled = state.anchorPage >= totalPages - 1;

    for (let i = start; i < end; i += 1) {
      const a = track.anchors[i];
      const tr = document.createElement('tr');
      tr.dataset.anchorIndex = String(i);
      if (i === state.selectedSegment) tr.classList.add('selected');
      tr.innerHTML = `
        <td><button type="button" class="anchor-index btn btn-small btn-ghost" data-action="select-segment" data-segment="${i}">#${i}</button></td>
        <td><input aria-label="帧号 ${i}" data-field="x" data-anchor-index="${i}" inputmode="numeric"></td>
        <td><input aria-label="相位余数 ${i}" data-field="p" data-anchor-index="${i}" inputmode="numeric"></td>
        <td><input aria-label="频率毫赫兹 ${i}" data-field="f" data-anchor-index="${i}" inputmode="numeric"></td>
        <td><input class="freq-hz" aria-label="频率赫兹 ${i}" data-field="fHz" data-anchor-index="${i}" inputmode="decimal"></td>
        <td><input aria-label="左幅度 ${i}" data-field="aL" data-anchor-index="${i}" inputmode="numeric"></td>
        <td><input aria-label="右幅度 ${i}" data-field="aR" data-anchor-index="${i}" inputmode="numeric"></td>
        <td><button type="button" class="btn btn-small btn-ghost delete-anchor" data-action="delete-anchor" title="删除锚点">删</button></td>
      `;
      const fields = { x: 0, p: 1, f: 2, aL: 3, aR: 4 };
      for (const [field, col] of Object.entries(fields)) {
        tr.querySelector(`[data-field="${field}"]`).value = a[col] ?? '';
      }
      tr.querySelector('[data-field="fHz"]').value = hzValue(a[2]);
      tbody.appendChild(tr);
    }
  }

  function renderSegmentDetails() {
    const inspector = $('segment-inspector');
    const details = $('segment-details');
    const compiledTrack = getCompiledTrack();
    const maxSegment = compiledTrack ? compiledTrack.segments.length - 1 : -1;
    state.selectedSegment = Math.max(0, Math.min(state.selectedSegment, Math.max(0, maxSegment)));
    const indexInput = $('segment-index');
    indexInput.max = String(Math.max(0, maxSegment));
    indexInput.value = String(state.selectedSegment);
    $('prev-segment').disabled = state.selectedSegment <= 0;
    $('next-segment').disabled = state.selectedSegment >= maxSegment;

    const seg = compiledTrack?.segments?.[state.selectedSegment];
    inspector.dataset.trackId = state.selectedTrackId ?? '';
    inspector.dataset.segmentIndex = String(state.selectedSegment);
    if (!seg) {
      inspector.dataset.feasible = 'unknown';
      delete inspector.dataset.k;
      details.innerHTML = '<p class="muted">选择轨道和段后显示整数圈数与瞬时频率极值。</p>';
      return;
    }

    inspector.dataset.feasible = String(Boolean(seg.feasible));
    inspector.dataset.k = seg.feasible ? String(seg.k) : '';
    inspector.dataset.fMinMhz = seg.minMhz ?? '';
    inspector.dataset.fMaxMhz = seg.maxMhz ?? '';

    const fMin = seg.feasible ? `${(seg.minMhz / 1000).toFixed(6)} Hz` : '—';
    const fMax = seg.feasible ? `${(seg.maxMhz / 1000).toFixed(6)} Hz` : '—';
    const k = seg.feasible ? String(seg.k) : '无可用圈数';
    const range = seg.kMin != null ? `${seg.kMin} … ${seg.kMax}` : '—';
    const target = Number.isFinite(seg.targetK) ? seg.targetK.toFixed(6) : '—';
    const objectiveError = Number.isFinite(seg.objectiveError) ? seg.objectiveError.toExponential(3) : '—';
    const phaseDelta = seg.feasible
      ? (seg.a1.p / Core.PHASE_STEPS + seg.k - seg.a0.p / Core.PHASE_STEPS).toFixed(9)
      : '—';
    const averagePhase = (seg.h * (seg.a0.f + seg.a1.f) / 96000000).toFixed(9);
    const endpointFreq = `${(seg.a0.f / 1000).toFixed(3)} → ${(seg.a1.f / 1000).toFixed(3)} Hz`;

    details.innerHTML = `
      <div class="metric-grid">
        <div class="metric"><div class="label">轨 / 段</div><div class="value" id="seg-locator">${seg.trackId} · #${seg.index}（第 ${seg.index + 1} 段）</div></div>
        <div class="metric"><div class="label">帧区间 / 长度</div><div class="value" id="seg-frames">${seg.x0}→${seg.x1}<br>h=${seg.h}</div></div>
        <div class="metric ${seg.feasible ? 'good' : 'bad'}"><div class="label">选定整圈数 k</div><div class="value" id="seg-turns" data-testid="segment-turns">${k}</div></div>
        <div class="metric"><div class="label">可行 k 范围</div><div class="value" id="seg-k-range">${range}</div></div>
        <div class="metric"><div class="label">最接近平均频率的目标 k</div><div class="value" id="seg-target-k">${target}</div></div>
        <div class="metric"><div class="label">实际相位增量 Δφ</div><div class="value" id="seg-phase-delta">${phaseDelta}</div></div>
        <div class="metric"><div class="label">平均频率对应增量</div><div class="value" id="seg-average-phase">${averagePhase}</div></div>
        <div class="metric"><div class="label">圈数目标误差</div><div class="value" id="seg-objective-error">${objectiveError}</div></div>
        <div class="metric"><div class="label">端点频率</div><div class="value" id="seg-endpoint-freq">${endpointFreq}</div></div>
        <div class="metric good"><div class="label">瞬时频率最小值</div><div class="value" id="seg-f-min" data-testid="segment-f-min">${fMin}</div></div>
        <div class="metric good"><div class="label">瞬时频率最大值</div><div class="value" id="seg-f-max" data-testid="segment-f-max">${fMax}</div></div>
      </div>
      <p class="segment-note">频率极值按 Hermite 相位导数的二次多项式在闭区间 [0,1] 上求端点与顶点；边界 20 Hz / 20000 Hz 均允许。并列时由 BigInt 有理数距离判定并取较小 k。</p>
    `;
  }

  function showCompileError(error) {
    const banner = $('error-banner');
    state.compileError = error;
    const firstIssue = error.issue || (Array.isArray(error.issues) ? error.issues[0] : null);
    const issueObject = firstIssue && typeof firstIssue === 'object' ? firstIssue : null;
    if (issueObject) {
      const issue = issueObject;
      banner.dataset.trackId = issue.trackId ?? '';
      banner.dataset.segmentIndex = issue.segmentIndex ?? '';
      const more = error.issues?.length > 1 ? `<br>另有 ${error.issues.length - 1} 个段无可用圈数。` : '';
      banner.innerHTML = `<b>无可用圈数：</b><code>${issue.message}</code>${more}<br><span>已保留上一版成功合成的 PCM 与 WAV。</span>`;
    } else {
      delete banner.dataset.trackId;
      delete banner.dataset.segmentIndex;
      const details = Array.isArray(error.issues) ? error.issues.filter((x) => typeof x === 'string').join('；') : '';
      banner.textContent = details ? `${error.message}：${details}` : (error.message || String(error));
    }
    banner.hidden = false;
    if (state.good) {
      setStatus('error', `约束无解；仍保留上一版（${state.good.compiled.duration} 帧，渲染 ${state.good.renderMs.toFixed(0)} ms）`);
    } else {
      setStatus('error', '工程无效，且暂无上一版可播放/导出');
    }
    $('export-status').textContent = state.good ? '导出按钮使用上一版成功结果。' : '';
  }

  function clearCompileError() {
    state.compileError = null;
    const banner = $('error-banner');
    banner.hidden = true;
    banner.textContent = '';
  }

  async function yieldToBrowser() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function renderCompiledAsync(compiled, token) {
    const frameCount = compiled.duration;
    const left = new Float64Array(frameCount);
    const right = new Float64Array(frameCount);
    for (let i = 0; i < compiled.tracks.length; i += 1) {
      Core.renderTrackInto(left, right, compiled.tracks[i], {
        startFrame: 0,
        endFrame: frameCount,
      });
      if (i % 4 === 3 || i === compiled.tracks.length - 1) {
        $('status-text').textContent = `正在合成 ${i + 1}/${compiled.tracks.length} 轨…`;
        await yieldToBrowser();
        if (token !== state.renderToken) return null;
      }
    }
    $('status-text').textContent = '正在舍入、削顶并编码 WAV…';
    await yieldToBrowser();
    if (token !== state.renderToken) return null;
    const pcm = Core.finalizePcm16({ left, right });
    return pcm;
  }

  function updateSelectionMeta() {
    const start = Number($('selection-start').value);
    const end = Number($('selection-end').value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
      $('selection-frames').textContent = '区间无效';
      $('selection-seconds').textContent = '需要 0 ≤ start < end';
      return false;
    }
    const frames = end - start;
    $('selection-frames').textContent = `${frames.toLocaleString()} 帧 [${start}, ${end})`;
    $('selection-seconds').textContent = `${(frames / Core.SAMPLE_RATE).toFixed(6)} s · ${(frames * 4 / 1024).toFixed(1)} KiB PCM`;
    state.selectionStart = start;
    state.selectionEnd = end;
    drawWaveform();
    return true;
  }

  function clampSelectionToDuration(duration) {
    $('selection-start').max = String(duration);
    $('selection-end').max = String(duration);
    if (!Number.isInteger(state.selectionStart) || state.selectionStart < 0 || state.selectionStart >= duration) {
      state.selectionStart = 0;
    }
    if (!Number.isInteger(state.selectionEnd) || state.selectionEnd <= state.selectionStart || state.selectionEnd > duration) {
      state.selectionEnd = duration;
    }
    $('selection-start').value = String(state.selectionStart);
    $('selection-end').value = String(state.selectionEnd);
    updateSelectionMeta();
  }

  async function recommit() {
    if (!state.doc) return false;
    window.clearTimeout(state.debounceTimer);
    const token = ++state.renderToken;
    let compiled;
    try {
      compiled = Core.compileProject(state.doc);
    } catch (error) {
      state.viewCompiled = error.compiled || state.viewCompiled;
      const issue = error.issue || error.issues?.[0];
      if (issue && typeof issue === 'object' && issue.trackId != null) {
        const trackChanged = String(state.selectedTrackId) !== String(issue.trackId);
        state.selectedTrackId = String(issue.trackId);
        state.selectedSegment = issue.segmentIndex ?? 0;
        state.anchorPage = Math.floor(state.selectedSegment / PAGE_SIZE);
        renderTrackList();
        if (trackChanged) renderAnchorTable();
      }
      showCompileError(error);
      renderSegmentDetails();
      updateExportButtons();
      return false;
    }

    clearCompileError();
    state.viewCompiled = compiled;
    renderSegmentDetails();
    clampSelectionToDuration(compiled.duration);
    updateExportButtons();
    setStatus('rendering', '正在合成 PCM…', { state: 'rendering' });

    const renderStarted = performance.now();
    const pcm = await renderCompiledAsync(compiled, token);
    if (!pcm || token !== state.renderToken) return false;

    const renderMs = performance.now() - renderStarted;
    const wavBytes = Core.encodeWav(pcm);
    const url = wavUrl(wavBytes);
    const totalMs = state.loadStartedAt ? performance.now() - state.loadStartedAt : null;
    const previousUrl = state.good?.url;
    if (previousUrl) window.setTimeout(() => URL.revokeObjectURL(previousUrl), 2000);
    state.good = { compiled, pcm, wavBytes, url, renderMs, at: new Date() };
    state.lastRenderMs = renderMs;
    state.lastTotalMs = totalMs;

    setPlayerSource(url, 'full', false);
    updateExportButtons();
    drawWaveform();
    const audioCurrent = await waitForAudioReady(token);
    if (!audioCurrent || token !== state.renderToken) return false;

    const quotaText = compiled.tracks.length >= 128 || compiled.tracks.reduce((n, t) => n + t.anchors.length, 0) >= 50000
      ? `；从载入到可播放 ${totalMs?.toFixed(0) ?? '—'} ms`
      : '';
    setStatus('ready', `可播放：${compiled.tracks.length} 轨 / ${compiled.duration.toLocaleString()} 帧，渲染 ${renderMs.toFixed(0)} ms${quotaText}`, {
      renderMs: renderMs.toFixed(1),
      totalMs: totalMs ? totalMs.toFixed(1) : '',
      duration: compiled.duration,
      audioReadyState: String(player.readyState),
    });
    $('export-status').textContent = `上一版/当前版 PCM：${pcm.length / 2} 立体声帧，${(wavBytes.length / 1048576).toFixed(2)} MiB WAV。`;
    return true;
  }

  function scheduleRecommit() {
    window.clearTimeout(state.debounceTimer);
    state.debounceTimer = window.setTimeout(() => { void recommit(); }, 160);
  }

  function updateExportButtons() {
    const hasGood = Boolean(state.good);
    $('export-full').disabled = !hasGood;
    $('export-selection').disabled = !hasGood;
    $('audition-selection').disabled = !hasGood;
    $('play-full').disabled = !hasGood;
  }

  async function loadDocument(data, source = 'JSON') {
    state.loadStartedAt = performance.now();
    let normalized;
    try {
      normalized = Core.normalizeProject(data);
    } catch (error) {
      showToast(`导入失败：${error.message}`, 'error');
      const banner = $('error-banner');
      banner.hidden = false;
      banner.removeAttribute('data-track-id');
      banner.removeAttribute('data-segment-index');
      banner.textContent = error.issues?.length ? `${error.message}：${error.issues.join('；')}` : error.message;
      setStatus('error', `导入失败，保留当前上一版（来源：${source}）`);
      return false;
    }

    state.doc = JSON.parse(JSON.stringify(data));
    if (!Array.isArray(state.doc.tracks)) state.doc = { tracks: state.doc };
    state.selectedTrackId = normalized.tracks[0]?.id ?? null;
    state.selectedSegment = 0;
    state.anchorPage = 0;
    state.selectionStart = 0;
    state.selectionEnd = normalized.duration;
    state.soloTrackId = null;
    renderTrackList();
    renderAnchorTable();
    renderSegmentDetails();
    clampSelectionToDuration(normalized.duration);
    setStatus('rendering', `已载入${source}，开始合成…`);
    return recommit();
  }

  function readSelectionOrToast() {
    if (!updateSelectionMeta()) {
      showToast('请输入合法帧区间：整数且 0 ≤ start < end ≤ 工程时长', 'error');
      return null;
    }
    if (!state.good) {
      showToast('还没有成功合成的上一版 PCM', 'error');
      return null;
    }
    const duration = state.good.compiled.duration;
    const { selectionStart: start, selectionEnd: end } = state;
    if (start < 0 || end > duration || start >= end) {
      showToast(`选区必须在 0…${duration} 帧内且 start < end`, 'error');
      return null;
    }
    return { start, end };
  }

  function auditionSelection() {
    const range = readSelectionOrToast();
    if (!range) return;
    const slice = state.good.pcm.subarray(range.start * 2, range.end * 2);
    const bytes = Core.encodeWav(slice, Core.SAMPLE_RATE, Core.CHANNELS);
    const url = wavUrl(bytes);
    setPlayerSource(url, 'selection', true);
    state.lastSelectionBytes = bytes;
    state.lastSelectionPcm = slice;
  }

  function exportSelection() {
    const range = readSelectionOrToast();
    if (!range) return;
    const slice = state.good.pcm.subarray(range.start * 2, range.end * 2);
    const bytes = Core.encodeWav(slice, Core.SAMPLE_RATE, Core.CHANNELS);
    state.lastSelectionBytes = bytes;
    downloadBytes(bytes, `anchored-partials_${range.start}-${range.end}.wav`);
  }

  function exportFull() {
    if (!state.good) return showToast('还没有可导出的成功合成结果', 'error');
    downloadBytes(state.good.wavBytes, 'anchored-partials_full-48k-stereo-pcm16.wav');
  }

  function playFull() {
    if (!state.good) return;
    if (state.soloTrackId != null) {
      state.soloTrackId = null;
      renderTrackList();
    }
    setPlayerSource(state.good.url, 'full', true);
  }

  async function soloTrack(trackId) {
    if (!state.good) {
      showToast('尚无成功合成的上一版，无法独听', 'error');
      return;
    }
    state.soloTrackId = String(trackId);
    renderTrackList();
    setStatus('rendering', `正在保持全工程时长渲染独听轨 ${trackId}…`);
    await yieldToBrowser();
    const t0 = performance.now();
    // No start/end: renderPcm16 allocates and returns the full project duration.
    const pcm = Core.renderPcm16(state.good.compiled, { audibleIds: [String(trackId)] });
    const bytes = Core.encodeWav(pcm);
    const url = wavUrl(bytes);
    setPlayerSource(url, 'solo', true);
    setStatus('ready', `独听 ${trackId}：仍为 ${state.good.compiled.duration} 帧，渲染 ${(performance.now() - t0).toFixed(0)} ms`);
  }

  function clearSoloAndPlay() {
    state.soloTrackId = null;
    renderTrackList();
    if (state.good) setPlayerSource(state.good.url, 'full', true);
  }

  /* ---------------- Canvas waveform ---------------- */

  let canvasCssWidth = 1200;
  function drawWaveform() {
    const canvas = $('waveform');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvasCssWidth = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 1200));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(canvasCssWidth * dpr);
    canvas.height = 210 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvasCssWidth;
    const H = 210;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#08101b';
    ctx.fillRect(0, 0, W, H);

    const pcm = state.good?.pcm;
    const duration = state.good?.compiled.duration || state.viewCompiled?.duration || 1;
    if (!pcm) {
      ctx.strokeStyle = '#2b405e';
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      ctx.fillStyle = '#7890af';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText('等待 PCM 渲染…', 16, H / 2 - 12);
      return;
    }

    const lanes = [
      { center: 55, color: 'rgba(93,214,199,.82)', channel: 0 },
      { center: 155, color: 'rgba(138,180,255,.82)', channel: 1 },
    ];
    for (const lane of lanes) {
      const halfH = 39;
      ctx.strokeStyle = 'rgba(145,166,194,.22)';
      ctx.beginPath(); ctx.moveTo(0, lane.center); ctx.lineTo(W, lane.center); ctx.stroke();
      const min = new Float32Array(W);
      const max = new Float32Array(W);
      for (let x = 0; x < W; x += 1) { min[x] = 1; max[x] = -1; }
      const frames = pcm.length / 2;
      for (let frame = 0; frame < frames; frame += 1) {
        const x = Math.min(W - 1, Math.floor((frame * W) / duration));
        const v = pcm[frame * 2 + lane.channel] / 32768;
        if (v < min[x]) min[x] = v;
        if (v > max[x]) max[x] = v;
      }
      ctx.fillStyle = lane.color;
      for (let x = 0; x < W; x += 1) {
        if (max[x] < min[x]) continue;
        const y1 = lane.center - max[x] * halfH;
        const y2 = lane.center - min[x] * halfH;
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      ctx.fillStyle = 'rgba(232,241,255,.55)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(lane.channel === 0 ? 'L' : 'R', 8, lane.center - halfH + 10);
    }

    const start = Math.max(0, Math.min(duration, state.selectionStart || 0));
    const end = Math.max(0, Math.min(duration, state.selectionEnd || duration));
    const x0 = (start / duration) * W;
    const x1 = (end / duration) * W;
    ctx.fillStyle = 'rgba(93,214,199,.10)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
    ctx.strokeStyle = '#5dd6c7';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
    ctx.strokeStyle = '#f2b84b';
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
  }

  let dragAnchorFrame = null;
  function frameFromPointer(event) {
    const canvas = $('waveform');
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const duration = state.good?.compiled.duration || state.viewCompiled?.duration || 1;
    return Math.max(0, Math.min(duration - 1, Math.floor((x / rect.width) * duration)));
  }

  function bindWaveform() {
    const canvas = $('waveform');
    canvas.addEventListener('pointerdown', (event) => {
      if (!state.good) return;
      canvas.setPointerCapture(event.pointerId);
      dragAnchorFrame = frameFromPointer(event);
      state.selectionStart = dragAnchorFrame;
      state.selectionEnd = Math.min(state.good.compiled.duration, dragAnchorFrame + 1);
      $('selection-start').value = String(state.selectionStart);
      $('selection-end').value = String(state.selectionEnd);
      updateSelectionMeta();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (dragAnchorFrame == null || !state.good) return;
      const frame = frameFromPointer(event);
      state.selectionStart = Math.min(dragAnchorFrame, frame);
      state.selectionEnd = Math.min(state.good.compiled.duration, Math.max(dragAnchorFrame, frame) + 1);
      $('selection-start').value = String(state.selectionStart);
      $('selection-end').value = String(state.selectionEnd);
      updateSelectionMeta();
    });
    const endDrag = () => { dragAnchorFrame = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => drawWaveform());
  }

  /* ---------------- Editing ---------------- */

  function selectTrack(trackId) {
    state.selectedTrackId = String(trackId);
    state.selectedSegment = 0;
    state.anchorPage = 0;
    renderTrackList();
    renderAnchorTable();
    renderSegmentDetails();
  }

  function onAnchorInput(event) {
    const input = event.target.closest('input[data-field]');
    if (!input) return;
    const track = getSelectedTrack();
    const index = Number(input.dataset.anchorIndex);
    if (!track || !Number.isInteger(index)) return;
    const anchor = track.anchors[index];
    const field = input.dataset.field;
    const column = { x: 0, p: 1, f: 2, aL: 3, aR: 4 }[field];

    if (field === 'fHz') {
      const hz = Number(input.value);
      if (Number.isFinite(hz)) {
        anchor[2] = Math.round(hz * 1000);
        const mHzInput = $(`anchor-tbody`).querySelector(`input[data-field="f"][data-anchor-index="${index}"]`);
        if (mHzInput && document.activeElement !== mHzInput) mHzInput.value = String(anchor[2]);
      } else {
        anchor[2] = input.value;
      }
    } else if (column != null) {
      // Anchor cells use inputmode rather than type=number for dense editing.
      // HTMLInputElement.valueAsNumber is NaN for those text inputs.
      const numericValue = input.value === '' ? NaN : Number(input.value);
      anchor[column] = Number.isFinite(numericValue) ? numericValue : input.value;
      if (field === 'f') {
        const hzInput = document.querySelector(`input[data-field="fHz"][data-anchor-index="${index}"]`);
        if (hzInput && document.activeElement !== hzInput) hzInput.value = hzValue(anchor[2]);
      }
    }
    scheduleRecommit();
  }

  function onAnchorChange(event) {
    if (event.target.closest('input[data-field]')) void recommit();
  }

  function deleteAnchor(index) {
    const track = getSelectedTrack();
    if (!track) return;
    if (track.anchors.length <= 2) {
      showToast('每条轨至少需要两个锚点', 'error');
      return;
    }
    track.anchors.splice(index, 1);
    state.selectedSegment = Math.max(0, Math.min(state.selectedSegment, track.anchors.length - 2));
    renderAnchorTable();
    renderSegmentDetails();
    void recommit();
  }

  function addAnchor() {
    const track = getSelectedTrack();
    const compiledTrack = getCompiledTrack();
    if (!track) return;
    let segmentIndex = Math.min(state.selectedSegment, track.anchors.length - 2);
    let a0 = track.anchors[segmentIndex];
    let a1 = track.anchors[segmentIndex + 1];
    let x;
    if (a1[0] - a0[0] >= 2) {
      x = Math.floor((a0[0] + a1[0]) / 2);
      if (x <= a0[0]) x = a0[0] + 1;
      if (x >= a1[0]) x = a1[0] - 1;
    } else {
      const later = track.anchors[track.anchors.length - 1][0] + 4800;
      if (later <= Core.MAX_FRAMES) {
        segmentIndex = track.anchors.length - 1;
        a0 = track.anchors[segmentIndex];
        a1 = null;
        x = later;
      } else {
        showToast('当前段没有可插入的整数帧，且工程末尾没有扩展空间', 'error');
        return;
      }
    }

    let p;
    let f;
    let aL;
    let aR;
    if (a1) {
      const h = a1[0] - a0[0];
      const u = (x - a0[0]) / h;
      const seg = compiledTrack?.segments?.[segmentIndex];
      let phase;
      if (seg?.feasible) {
        const y0 = a0[1] / Core.PHASE_STEPS;
        const y1 = a1[1] / Core.PHASE_STEPS + seg.k;
        const m0 = (h * a0[2]) / 48000000;
        const m1 = (h * a1[2]) / 48000000;
        const c2 = -3 * y0 - 2 * m0 + 3 * y1 - m1;
        const c3 = 2 * y0 + m0 - 2 * y1 + m1;
        phase = ((c3 * u + c2) * u + m0) * u + y0;
        p = Math.round((phase - Math.floor(phase)) * Core.PHASE_STEPS) % Core.PHASE_STEPS;
      } else {
        p = Math.round(a0[1] + (a1[1] - a0[1]) * u);
      }
      f = Math.round(a0[2] + (a1[2] - a0[2]) * u);
      aL = Math.round(a0[3] + (a1[3] - a0[3]) * u);
      aR = Math.round(a0[4] + (a1[4] - a0[4]) * u);
    } else {
      p = a0[1];
      f = a0[2];
      aL = a0[3];
      aR = a0[4];
    }
    const anchor = [x, p, f, aL, aR];
    track.anchors.splice(segmentIndex + 1, 0, anchor);
    state.selectedSegment = segmentIndex + 1;
    state.anchorPage = Math.floor((segmentIndex + 1) / PAGE_SIZE);
    renderAnchorTable();
    renderTrackList();
    renderSegmentDetails();
    void recommit();
  }

  function addTrack() {
    if (!state.doc) state.doc = { tracks: [] };
    if (state.doc.tracks.length >= Core.MAX_TRACKS) {
      showToast(`最多 ${Core.MAX_TRACKS} 轨`, 'error');
      return;
    }
    let n = state.doc.tracks.length + 1;
    let id = `T${n}`;
    const ids = new Set(state.doc.tracks.map((t) => String(t.id)));
    while (ids.has(id)) { n += 1; id = `T${n}`; }
    state.doc.tracks.push({
      id,
      anchors: [
        [0, 0, 440000, 8000, 8000],
        [4800, 0, 440000, 8000, 8000],
      ],
    });
    selectTrack(id);
    void recommit();
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await loadDocument(data, file.name);
    } catch (error) {
      showToast(`读取 JSON 失败：${error.message}`, 'error');
    }
  }

  async function loadSampleDocument() {
    let data = window.ANCHORED_PARTIAL_SAMPLE;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      try {
        const response = await fetch('samples/anchored-partials.json', { cache: 'no-store' });
        if (response.ok) data = await response.json();
      } catch { /* embedded fallback */ }
    }
    return loadDocument(data, 'samples/anchored-partials.json');
  }

  function bindEvents() {
    $('load-sample').addEventListener('click', () => void loadSampleDocument());
    $('file-input').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = ''; // allow selecting the same repaired file again
      void handleFile(file);
    });
    $('generate-quota').addEventListener('click', async () => {
      const data = Core.generateQuotaProject();
      await loadDocument(data, '满额压测工程');
    });
    $('add-track').addEventListener('click', addTrack);
    $('clear-solo').addEventListener('click', clearSoloAndPlay);

    $('track-list').addEventListener('click', (event) => {
      const row = event.target.closest('.track-row');
      const actionButton = event.target.closest('[data-action]');
      if (!row) return;
      const id = row.dataset.trackId;
      if (actionButton?.dataset.action === 'solo-track') {
        if (state.soloTrackId != null && String(state.soloTrackId) === String(id)) clearSoloAndPlay();
        else void soloTrack(id);
      } else {
        selectTrack(id);
      }
    });

    $('anchor-tbody').addEventListener('input', onAnchorInput);
    $('anchor-tbody').addEventListener('change', onAnchorChange);
    $('anchor-tbody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const index = Number(button.dataset.anchorIndex ?? button.dataset.segment);
      if (button.dataset.action === 'delete-anchor') deleteAnchor(index);
      if (button.dataset.action === 'select-segment' && Number.isInteger(index)) {
        state.selectedSegment = Math.min(index, Math.max(0, (getSelectedTrack()?.anchors.length || 2) - 2));
        renderAnchorTable();
        renderSegmentDetails();
      }
    });

    $('add-anchor').addEventListener('click', addAnchor);
    $('anchor-prev-page').addEventListener('click', () => { state.anchorPage -= 1; renderAnchorTable(); });
    $('anchor-next-page').addEventListener('click', () => { state.anchorPage += 1; renderAnchorTable(); });

    $('segment-index').addEventListener('input', (event) => {
      const value = Number(event.target.value);
      if (Number.isInteger(value) && value >= 0) {
        state.selectedSegment = value;
        renderAnchorTable();
        renderSegmentDetails();
      }
    });
    $('segment-index').addEventListener('change', () => renderSegmentDetails());
    $('prev-segment').addEventListener('click', () => { state.selectedSegment -= 1; renderAnchorTable(); renderSegmentDetails(); });
    $('next-segment').addEventListener('click', () => { state.selectedSegment += 1; renderAnchorTable(); renderSegmentDetails(); });

    $('selection-start').addEventListener('input', updateSelectionMeta);
    $('selection-end').addEventListener('input', updateSelectionMeta);
    $('rerender').addEventListener('click', () => void recommit());
    $('audition-selection').addEventListener('click', auditionSelection);
    $('play-full').addEventListener('click', playFull);
    $('stop-play').addEventListener('click', () => { player.pause(); });
    $('export-selection').addEventListener('click', exportSelection);
    $('export-full').addEventListener('click', exportFull);

    bindWaveform();
    updateExportButtons();
  }

  api.loadDocument = loadDocument;
  api.loadSampleDocument = loadSampleDocument;
  api.recommit = recommit;
  api.selectTrack = selectTrack;
  api.auditionSelection = auditionSelection;
  api.exportSelection = exportSelection;
  api.exportFull = exportFull;
  api.soloTrack = soloTrack;
  api.drawWaveform = drawWaveform;

  // Convenient aliases for DevTools or browser automation.
  window.synth = Core;
  window.synthApp = api;

  window.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    void loadSampleDocument();
  });
})();
