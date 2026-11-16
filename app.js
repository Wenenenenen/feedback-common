/* 界面逻辑：加载项目 → computeTimeline → renderAudio → 卷帘/游标/试听/导出。
   任何参数或项目变化都完整重算，不沿用旧缓存。 */
(function () {
  'use strict';
  const E = window.PedalVoiceEngine;
  const $ = (id) => document.getElementById(id);

  const SAMPLES = [
    'stolen-fifo', 'pedal-overlap', 'release-priority', 'same-tick',
    'tempo-unsorted', 'zero-envelope',
    'invalid-end-tick', 'invalid-tempo', 'invalid-channel',
  ];

  const COLORS = {
    held: '#3b82f6', pedal: '#f59e0b', release: '#34d399', stolen: '#ef4444',
  };
  const STATE_LABEL = {
    held: '按键', pedal: '踏板保持', release: 'release',
    stolen: '被偷声', ended: '已结束', pending: '未开始',
  };

  const state = {
    project: null, projectName: '',
    tl: null, render: null, report: null,
    cursorFrame: 0,
    pxPerSec: 120,
    // 播放
    ac: null, src: null, playT0: 0, playFrame0: 0, raf: 0,
  };

  // ---------- 参数 ----------
  const paramInputs = {
    attack_ms: $('pAttack'), decay_ms: $('pDecay'), sustain: $('pSustain'),
    release_ms: $('pRelease'), voices: $('pVoices'),
  };
  function readParams() {
    return {
      attack_ms: Number(paramInputs.attack_ms.value),
      decay_ms: Number(paramInputs.decay_ms.value),
      sustain: Number(paramInputs.sustain.value),
      release_ms: Number(paramInputs.release_ms.value),
      voices: Number(paramInputs.voices.value),
    };
  }
  function writeParams(p) {
    paramInputs.attack_ms.value = p.attack_ms;
    paramInputs.decay_ms.value = p.decay_ms;
    paramInputs.sustain.value = p.sustain;
    paramInputs.release_ms.value = p.release_ms;
    paramInputs.voices.value = p.voices;
  }

  // ---------- 重算 ----------
  function recompute() {
    stopPlayback();
    state.tl = state.render = state.report = null;
    hideErrors();
    if (!state.project) { drawEmpty(); updateButtons(); return; }

    const tl = E.computeTimeline(state.project, readParams());
    if (tl.errors && tl.errors.length) {
      showErrors(tl.errors);
      drawEmpty();
      updateButtons();
      $('stats').innerHTML = '';
      $('envInfo').textContent = '';
      $('cursorInfo').innerHTML = '<p style="color:var(--muted)">项目校验未通过。</p>';
      return;
    }
    const render = E.renderAudio(tl);
    state.tl = tl;
    state.render = render;
    state.report = E.buildReport(tl, render);
    state.cursorFrame = Math.min(state.cursorFrame, Math.max(0, tl.totalFrames - 1));

    $('envInfo').textContent =
      `包络帧数 A=${tl.A} D=${tl.D} R=${tl.R} ｜ 项目结束帧 ${tl.projectEndFrame} ｜ 总帧数 ${tl.totalFrames}（${(tl.totalFrames / E.SR).toFixed(3)}s）`;
    const clip = render.clipped;
    const unpaired = tl.unmatchedOffs.length;
    $('stats').innerHTML =
      `<span>声部 ${tl.voices.length}</span>` +
      `<span class="${clip ? 'bad' : ''}">削波采样 ${clip}${clip ? '（未归一化，已饱和）' : ''}</span>` +
      `<span class="${unpaired ? 'bad' : ''}">未配对 off ${unpaired}${unpaired ? '：事件 ' + tl.unmatchedOffs.join(', ') : ''}</span>`;
    drawRoll();
    updateCursorPanel();
    updateButtons();
  }

  function showErrors(errs) {
    const el = $('errors');
    el.style.display = 'block';
    el.innerHTML = '<b>校验错误</b><ul>' + errs.map((e) => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
  }
  function hideErrors() { $('errors').style.display = 'none'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function updateButtons() {
    const ready = !!state.render;
    $('playBtn').disabled = !ready;
    $('wavBtn').disabled = !ready;
    $('reportBtn').disabled = !ready;
  }

  // ---------- 钢琴卷帘 ----------
  const canvas = $('roll');
  const ctx = canvas.getContext('2d');
  const ROW_H = 15, KEY_W = 46, TOP = 6, PEDAL_LANE_H = 12;

  function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

  function voiceSegments(v) {
    const segs = [];
    const end = v.endFrame;
    const up = v.keyUpFrame, rel = v.releaseFrame;
    const heldEnd = up !== null ? Math.min(up, end) : (rel !== null ? Math.min(rel, end) : end);
    if (heldEnd > v.onFrame) segs.push({ from: v.onFrame, to: heldEnd, type: 'held' });
    if (up !== null && rel !== null && rel > up) segs.push({ from: up, to: Math.min(rel, end), type: 'pedal' });
    if (rel !== null && end > rel) segs.push({ from: rel, to: end, type: 'release' });
    return segs;
  }

  function pedalIntervals() {
    // 每通道踏板踩下区间 [downFrame, upFrame)
    const lanes = new Map();
    if (!state.tl) return lanes;
    const down = new Array(16).fill(null);
    for (const e of state.tl.events) {
      if (e.type !== 'pedal') continue;
      if (e.value >= 64) { if (down[e.channel] === null) down[e.channel] = e.frame; }
      else if (down[e.channel] !== null) {
        if (!lanes.has(e.channel)) lanes.set(e.channel, []);
        lanes.get(e.channel).push([down[e.channel], e.frame]);
        down[e.channel] = null;
      }
    }
    for (let ch = 0; ch < 16; ch++) {
      if (down[ch] !== null) {
        if (!lanes.has(ch)) lanes.set(ch, []);
        lanes.get(ch).push([down[ch], state.tl.totalFrames]);
      }
    }
    return lanes;
  }

  function drawEmpty() {
    canvas.width = 600; canvas.height = 120;
    ctx.fillStyle = cssVar('--panel') || '#171e2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = cssVar('--muted') || '#8b96ad';
    ctx.font = '13px sans-serif';
    ctx.fillText('请选择样例或导入 JSON 项目文件', 20, 60);
  }

  function drawRoll() {
    const tl = state.tl;
    if (!tl) { drawEmpty(); return; }
    const keys = tl.voices.map((v) => v.key);
    const loKey = Math.max(0, Math.min(...keys, 60) - 3);
    const hiKey = Math.min(127, Math.max(...keys, 72) + 3);
    const rows = hiKey - loKey + 1;
    const lanes = pedalIntervals();
    const laneCount = lanes.size;
    const width = KEY_W + Math.ceil((tl.totalFrames / E.SR) * state.pxPerSec) + 30;
    const height = TOP + rows * ROW_H + laneCount * PEDAL_LANE_H + 24;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const xOf = (f) => KEY_W + (f / E.SR) * state.pxPerSec;
    const yOf = (k) => TOP + (hiKey - k) * ROW_H;

    ctx.fillStyle = cssVar('--panel');
    ctx.fillRect(0, 0, width, height);

    // 秒刻度与网格
    ctx.font = '10px sans-serif';
    const totalSec = tl.totalFrames / E.SR;
    const step = totalSec > 12 ? 2 : totalSec > 5 ? 1 : 0.5;
    ctx.textAlign = 'left';
    for (let s = 0; s <= totalSec + 1e-9; s += step) {
      const x = xOf(s * E.SR);
      ctx.strokeStyle = cssVar('--line');
      ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, height - 20); ctx.stroke();
      ctx.fillStyle = cssVar('--muted');
      ctx.fillText(s.toFixed(step < 1 ? 1 : 0) + 's', x + 3, height - 8);
    }
    // 项目结束线
    ctx.strokeStyle = cssVar('--muted');
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(xOf(tl.projectEndFrame), TOP); ctx.lineTo(xOf(tl.projectEndFrame), height - 20); ctx.stroke();
    ctx.setLineDash([]);

    // 键行
    for (let k = loKey; k <= hiKey; k++) {
      const y = yOf(k);
      ctx.fillStyle = cssVar('--muted');
      ctx.textAlign = 'right';
      ctx.fillText('k' + k, KEY_W - 6, y + ROW_H - 4);
      ctx.strokeStyle = cssVar('--line');
      ctx.beginPath(); ctx.moveTo(KEY_W, y); ctx.lineTo(width - 4, y); ctx.stroke();
    }

    // 声部条
    for (const v of tl.voices) {
      const y = yOf(v.key) + 2, h = ROW_H - 5;
      for (const seg of voiceSegments(v)) {
        ctx.fillStyle = COLORS[seg.type];
        ctx.globalAlpha = seg.type === 'release' ? 0.75 : 0.95;
        ctx.fillRect(xOf(seg.from), y, Math.max(1, xOf(seg.to) - xOf(seg.from)), h);
      }
      ctx.globalAlpha = 1;
      if (v.reason === 'stolen') {
        ctx.strokeStyle = COLORS.stolen;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(xOf(v.onFrame) + 0.5, y + 0.5, Math.max(2, xOf(v.endFrame) - xOf(v.onFrame)) - 1, h - 1);
        // ✕ 标记截断点
        const x = xOf(v.endFrame);
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 2); ctx.lineTo(x + 4, y + h + 2);
        ctx.moveTo(x + 4, y - 2); ctx.lineTo(x - 4, y + h + 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = cssVar('--text');
      ctx.textAlign = 'left';
      ctx.fillText('#' + v.id, xOf(v.onFrame) + 2, y + h - 3);
    }

    // 踏板区间细条
    let li = 0;
    for (const [ch, intervals] of [...lanes.entries()].sort((a, b) => a[0] - b[0])) {
      const y = TOP + rows * ROW_H + 4 + li * PEDAL_LANE_H;
      ctx.fillStyle = cssVar('--muted');
      ctx.textAlign = 'right';
      ctx.fillText('ch' + ch + ' 踏板', KEY_W - 6, y + 8);
      ctx.fillStyle = cssVar('--pedal') || '#f59e0b';
      ctx.globalAlpha = 0.55;
      for (const [a, b] of intervals) ctx.fillRect(xOf(a), y, Math.max(1, xOf(b) - xOf(a)), 5);
      ctx.globalAlpha = 1;
      li++;
    }

    drawCursor();
  }

  function drawCursor() {
    const tl = state.tl;
    if (!tl) return;
    const x = KEY_W + (state.cursorFrame / E.SR) * state.pxPerSec;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.style.height ? parseFloat(canvas.style.height) : canvas.height); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 游标交互
  let dragging = false;
  function frameAtEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const f = Math.round(((x - KEY_W) / state.pxPerSec) * E.SR);
    return Math.max(0, Math.min(state.tl ? state.tl.totalFrames - 1 : 0, f));
  }
  canvas.addEventListener('mousedown', (ev) => {
    if (!state.tl) return;
    dragging = true;
    state.cursorFrame = frameAtEvent(ev);
    drawRoll(); updateCursorPanel();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging || !state.tl) return;
    state.cursorFrame = frameAtEvent(ev);
    drawRoll(); updateCursorPanel();
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  function updateCursorPanel() {
    const tl = state.tl;
    if (!tl) return;
    const f = state.cursorFrame;
    $('cursorTime').textContent = `游标 帧 ${f} / ${(f / E.SR).toFixed(4)}s`;
    const rows = tl.voices
      .filter((v) => f >= v.onFrame)
      .map((v) => {
        const st = E.voiceStateAt(v, f, tl);
        const color = COLORS[st.state] || 'var(--muted)';
        return `<tr>
          <td class="mono">#${v.id}</td><td>ch${v.channel}</td><td>k${v.key}</td>
          <td><span class="dot" style="background:${color}"></span>${STATE_LABEL[st.state]}</td>
          <td class="mono">${st.env.toFixed(4)}</td>
          <td style="color:var(--muted)">${v.reason || ''}</td>
        </tr>`;
      });
    $('cursorInfo').innerHTML = rows.length
      ? `<table><tr><th>声部</th><th>通道</th><th>键</th><th>状态</th><th>包络</th><th>原因</th></tr>${rows.join('')}</table>`
      : '<p style="color:var(--muted)">该帧没有已开始的声部。</p>';
  }

  // ---------- 播放 ----------
  function stopPlayback() {
    if (state.src) { try { state.src.stop(); } catch (_) {} state.src = null; }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    $('stopBtn').disabled = true;
  }
  function play() {
    if (!state.render) return;
    stopPlayback();
    if (!state.ac) state.ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: E.SR });
    const tl = state.tl;
    const buf = state.ac.createBuffer(1, tl.totalFrames, E.SR);
    buf.copyToChannel(state.render.samples, 0);
    const src = state.ac.createBufferSource();
    src.buffer = buf;
    src.connect(state.ac.destination);
    const offset = state.cursorFrame / E.SR;
    src.start(0, offset);
    state.src = src;
    state.playT0 = state.ac.currentTime;
    state.playFrame0 = state.cursorFrame;
    $('stopBtn').disabled = false;
    const tick = () => {
      if (!state.src) return;
      const f = state.playFrame0 + Math.floor((state.ac.currentTime - state.playT0) * E.SR);
      if (f >= tl.totalFrames) { stopPlayback(); return; }
      state.cursorFrame = f;
      drawRoll(); updateCursorPanel();
      state.raf = requestAnimationFrame(tick);
    };
    src.onended = () => stopPlayback();
    state.raf = requestAnimationFrame(tick);
  }

  // ---------- 导出 ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- 加载项目 ----------
  function loadProject(json, name) {
    try {
      const proj = typeof json === 'string' ? JSON.parse(json) : json;
      state.project = proj;
      state.projectName = name;
      state.cursorFrame = 0;
      if (proj.params) writeParams(proj.params); // 以文件参数为起点，之后可手改
      recompute();
    } catch (err) {
      state.project = null;
      showErrors(['JSON 解析失败：' + err.message]);
      drawEmpty();
      updateButtons();
    }
  }

  // ---------- 事件绑定 ----------
  const sel = $('sampleSel');
  for (const s of SAMPLES) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      const resp = await fetch('samples/pedal-voice-cases/' + sel.value + '.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      loadProject(await resp.json(), sel.value);
    } catch (err) {
      showErrors([`样例加载失败（${err.message}）。若用 file:// 打开请改用“导入”选择本地文件，或用 http 服务访问。`]);
    }
  });
  $('fileInput').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadProject(reader.result, file.name.replace(/\.json$/i, ''));
    reader.readAsText(file);
  });
  for (const input of Object.values(paramInputs)) {
    input.addEventListener('change', recompute); // 修改参数即整体重算
  }
  $('playBtn').addEventListener('click', play);
  $('stopBtn').addEventListener('click', stopPlayback);
  $('wavBtn').addEventListener('click', () => {
    const wav = E.encodeWav24(state.render.samples);
    download(new Blob([wav], { type: 'audio/wav' }), (state.projectName || 'render') + '-48k-mono-24bit.wav');
  });
  $('reportBtn').addEventListener('click', () => {
    download(
      new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' }),
      (state.projectName || 'render') + '-voice-report.json'
    );
  });

  drawEmpty();
  // 默认载入与用户问题最相关的样例
  sel.value = 'stolen-fifo';
  sel.dispatchEvent(new Event('change'));
})();
