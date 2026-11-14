/* app.js — 页面逻辑：导入/分析/事件编辑/试听/导出。依赖全局 DTMF（dtmf.js）。 */
(function () {
  'use strict';

  const ALLOWED_RATES = [8000, 16000, 48000];
  const MAX_SECONDS = 60;

  // ------------------------------------------------------------ 状态
  let wav = null;        // {name, sampleRate, numChannels, numFrames, int16, floats, buffer}
  let events = [];       // {id, key, channel, startFrame, endFrame}（帧号为真源，结束帧不含）
  let nextId = 1;
  let selectedId = null;
  let audioCtx = null;
  let decodedOriginal = null; // 原音频的 AudioBuffer（试听用）

  const $ = (id) => document.getElementById(id);
  const ms2frame = (ms) => Math.round((ms * wav.sampleRate) / 1000);
  const frame2ms = (f) => (f / wav.sampleRate) * 1000;

  // ------------------------------------------------------------ 文件导入
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resetState();
    try {
      const buffer = await file.arrayBuffer();
      const decoded = DTMF.decodeWav(buffer);
      if (!ALLOWED_RATES.includes(decoded.sampleRate)) {
        throw new Error(`采样率 ${decoded.sampleRate}Hz 不受支持（仅 8/16/48kHz）`);
      }
      const seconds = decoded.numFrames / decoded.sampleRate;
      if (seconds > MAX_SECONDS + 1e-6) {
        throw new Error(`时长 ${seconds.toFixed(2)}s 超过 60 秒上限`);
      }
      wav = {
        name: file.name,
        sampleRate: decoded.sampleRate,
        numChannels: decoded.numChannels,
        numFrames: decoded.numFrames,
        int16: decoded.int16,
        floats: decoded.int16.map(DTMF.toFloat),
        buffer,
      };
      decodedOriginal = null;
      $('fileInfo').innerHTML =
        `<b>${escapeHtml(file.name)}</b> · ${wav.sampleRate}Hz · ` +
        `${wav.numChannels === 1 ? '单声道' : '双声道'} · ${wav.numFrames} 帧 · ${seconds.toFixed(3)}s`;
      $('analyzeBtn').disabled = false;
      $('status').textContent = '文件已加载，可开始分析';
      $('wavePanel').classList.remove('hidden');
      drawWaveform();
    } catch (err) {
      $('status').innerHTML = `<span class="err">导入失败：${escapeHtml(err.message)}</span>`;
      $('fileInfo').textContent = '未加载文件';
    }
  });

  function resetState() {
    wav = null; events = []; selectedId = null; decodedOriginal = null;
    $('analyzeBtn').disabled = true;
    $('eventsPanel').classList.add('hidden');
    $('exportPanel').classList.add('hidden');
    $('wavePanel').classList.add('hidden');
    $('progressWrap').style.display = 'none';
    $('status').textContent = '';
  }

  // ------------------------------------------------------------ 分析
  $('analyzeBtn').addEventListener('click', async () => {
    if (!wav) return;
    $('analyzeBtn').disabled = true;
    $('progressWrap').style.display = 'block';
    $('status').textContent = '分析中…';
    try {
      const detected = await DTMF.detectAudio(wav.floats, wav.sampleRate, async (p) => {
        $('progressBar').style.width = `${Math.round(p * 100)}%`;
        await new Promise((r) => setTimeout(r, 0)); // 让 UI 刷新
      });
      events = detected.map((e) => ({
        id: nextId++,
        key: e.key,
        channel: e.channel,
        startFrame: Math.max(0, ms2frame(e.startMs)),
        endFrame: Math.min(wav.numFrames, ms2frame(e.endMs)),
      })).filter((e) => e.endFrame > e.startFrame);
      sortEvents();
      selectedId = null;
      $('status').textContent = `分析完成，识别到 ${events.length} 个按键事件`;
      renderEvents();
      drawWaveform();
      $('eventsPanel').classList.remove('hidden');
      $('exportPanel').classList.remove('hidden');
    } catch (err) {
      $('status').innerHTML = `<span class="err">分析失败：${escapeHtml(err.message)}</span>`;
    } finally {
      $('progressWrap').style.display = 'none';
      $('progressBar').style.width = '0';
      $('analyzeBtn').disabled = false;
    }
  });

  function sortEvents() {
    events.sort((a, b) => a.startFrame - b.startFrame || a.channel - b.channel);
  }

  // ------------------------------------------------------------ 事件表格
  function renderEvents() {
    $('eventCount').textContent = events.length;
    const tbody = $('eventRows');
    tbody.innerHTML = '';
    events.forEach((ev, idx) => {
      const tr = document.createElement('tr');
      if (ev.id === selectedId) tr.className = 'selected';
      tr.dataset.id = ev.id;

      const keySel = `<select data-act="key">${DTMF.KEYS.map((k) =>
        `<option ${k === ev.key ? 'selected' : ''}>${k}</option>`).join('')}</select>`;

      tr.innerHTML =
        `<td>${idx + 1}</td>` +
        `<td>${ev.channel}</td>` +
        `<td>${keySel}</td>` +
        `<td class="mono">${ev.startFrame}</td>` +
        `<td class="mono">${ev.endFrame}</td>` +
        `<td><input class="ms mono" data-act="start" value="${frame2ms(ev.startFrame).toFixed(1)}"></td>` +
        `<td><input class="ms mono" data-act="end" value="${frame2ms(ev.endFrame).toFixed(1)}"></td>` +
        `<td class="mono">${(frame2ms(ev.endFrame) - frame2ms(ev.startFrame)).toFixed(1)}</td>` +
        `<td>` +
        `<button class="small" data-act="play">试听</button> ` +
        `<button class="small danger" data-act="del">删除</button>` +
        `</td>`;
      tbody.appendChild(tr);
    });

    // 填充新事件表单的声道选项（保留已选值）
    const chSel = $('addChannel');
    const prevCh = chSel.value;
    chSel.innerHTML = '';
    for (let c = 0; c < (wav ? wav.numChannels : 1); c++) {
      chSel.innerHTML += `<option value="${c}">${c}</option>`;
    }
    if (prevCh !== '' && Number(prevCh) < chSel.options.length) chSel.value = prevCh;
    const keySel2 = $('addKey');
    if (!keySel2.options.length) {
      keySel2.innerHTML = DTMF.KEYS.map((k) => `<option>${k}</option>`).join('');
    }
  }

  $('eventRows').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const ev = events.find((x) => x.id === Number(tr.dataset.id));
    if (!ev) return;
    const act = e.target.dataset.act;
    if (act === 'play') {
      await playRange(ev.channel, frame2ms(ev.startFrame), frame2ms(ev.endFrame));
    } else if (act === 'del') {
      events = events.filter((x) => x.id !== ev.id);
      if (selectedId === ev.id) selectedId = null;
      renderEvents(); drawWaveform();
    } else if (!e.target.closest('input,select,button')) {
      // 点击行空白处选中；点击输入框/下拉框不打断编辑
      selectedId = ev.id;
      renderEvents(); drawWaveform();
    }
  });

  $('eventRows').addEventListener('change', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const ev = events.find((x) => x.id === Number(tr.dataset.id));
    if (!ev) return;
    const act = e.target.dataset.act;
    if (act === 'key') {
      ev.key = e.target.value;
    } else if (act === 'start' || act === 'end') {
      const ms = Number(e.target.value);
      if (!Number.isFinite(ms)) { renderEvents(); return; }
      const f = Math.max(0, Math.min(wav.numFrames, ms2frame(ms)));
      if (act === 'start') ev.startFrame = Math.min(f, ev.endFrame - 1);
      else ev.endFrame = Math.max(f, ev.startFrame + 1);
      sortEvents();
    }
    selectedId = ev.id;
    renderEvents(); drawWaveform();
  });

  // ------------------------------------------------------------ 手工新增
  $('addBtn').addEventListener('click', () => {
    $('addErr').textContent = '';
    if (!wav) return;
    const channel = Number($('addChannel').value);
    const key = $('addKey').value;
    const startMs = Number($('addStart').value);
    const endMs = Number($('addEnd').value);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      $('addErr').textContent = '请填写合法区间（0 ≤ 开始 < 结束）';
      return;
    }
    const startFrame = ms2frame(startMs);
    const endFrame = ms2frame(endMs);
    if (endFrame > wav.numFrames) {
      $('addErr').textContent = `结束超出总帧数 ${wav.numFrames}`;
      return;
    }
    const ev = { id: nextId++, key, channel, startFrame, endFrame };
    events.push(ev);
    sortEvents();
    selectedId = ev.id;
    renderEvents(); drawWaveform();
  });

  // ------------------------------------------------------------ 试听
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  async function getDecodedOriginal() {
    if (!decodedOriginal) {
      // decodeAudioData 会 detach buffer，传副本
      decodedOriginal = await getCtx().decodeAudioData(wav.buffer.slice(0));
    }
    return decodedOriginal;
  }

  async function playRange(channel, startMs, endMs) {
    try {
      const buf = await getDecodedOriginal();
      const pad = 150; // 前后各带 150ms 上下文，便于确认边界
      const offset = Math.max(0, startMs - pad) / 1000;
      const endSec = Math.min(buf.duration, (endMs + pad) / 1000);
      const src = getCtx().createBufferSource();
      src.buffer = buf;
      src.connect(getCtx().destination);
      src.start(0, offset, Math.max(0.05, endSec - offset));
    } catch (err) {
      $('status').innerHTML = `<span class="err">试听失败：${escapeHtml(err.message)}</span>`;
    }
  }

  $('playRedactedBtn').addEventListener('click', async () => {
    if (!wav) return;
    try {
      const out = currentRedaction();
      const buf = DTMF.encodeWav(out, wav.sampleRate, wav.numFrames);
      const decoded = await getCtx().decodeAudioData(buf.slice(0));
      const src = getCtx().createBufferSource();
      src.buffer = decoded;
      src.connect(getCtx().destination);
      src.start();
    } catch (err) {
      $('status').innerHTML = `<span class="err">试听失败：${escapeHtml(err.message)}</span>`;
    }
  });

  // ------------------------------------------------------------ 脱敏与导出
  function currentMode() {
    return document.querySelector('input[name=mode]:checked').value;
  }

  function currentRedaction() {
    return DTMF.redact(wav.int16, wav.sampleRate, wav.numFrames, events, currentMode());
  }

  $('exportWavBtn').addEventListener('click', () => {
    if (!wav) return;
    const out = currentRedaction();
    const buf = DTMF.encodeWav(out, wav.sampleRate, wav.numFrames);
    const base = wav.name.replace(/\.wav$/i, '');
    download(new Blob([buf], { type: 'audio/wav' }), `${base}-redacted.wav`);
  });

  $('exportCsvBtn').addEventListener('click', () => {
    if (!wav) return;
    const rows = [...events].sort((a, b) => a.channel - b.channel || a.startFrame - b.startFrame);
    const lines = ['channel,key,start_frame,end_frame,start_ms,end_ms'];
    for (const ev of rows) {
      lines.push([
        ev.channel, ev.key, ev.startFrame, ev.endFrame,
        frame2ms(ev.startFrame).toFixed(3), frame2ms(ev.endFrame).toFixed(3),
      ].join(','));
    }
    const base = wav.name.replace(/\.wav$/i, '');
    download(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), `${base}-events.csv`);
  });

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ------------------------------------------------------------ 波形图
  const KEY_COLORS = {};
  DTMF.KEYS.forEach((k, i) => {
    KEY_COLORS[k] = `hsl(${(i * 137) % 360}, 70%, 45%)`;
  });

  function drawWaveform() {
    const canvas = $('wave');
    if (!wav) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || canvas.parentElement.clientWidth - 40;
    const rows = wav.numChannels;
    const rowH = 56, gap = 8, pad = 4;
    const H = rows * rowH + (rows - 1) * gap + pad * 2;
    canvas.style.height = `${H}px`;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const N = wav.numFrames;
    for (let c = 0; c < rows; c++) {
      const top = pad + c * (rowH + gap);
      const mid = top + rowH / 2;
      // 波形（min/max 列）
      ctx.strokeStyle = '#94a3b8';
      ctx.beginPath();
      const data = wav.int16[c];
      for (let px = 0; px < W; px++) {
        const i0 = Math.floor((px / W) * N);
        const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / W) * N));
        let mn = 32767, mx = -32768;
        for (let i = i0; i < i1; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const y0 = mid - (mx / 32768) * (rowH / 2 - 1);
        const y1 = mid - (mn / 32768) * (rowH / 2 - 1);
        ctx.moveTo(px + 0.5, y0);
        ctx.lineTo(px + 0.5, Math.max(y0 + 0.5, y1));
      }
      ctx.stroke();
      // 事件色块
      for (const ev of events) {
        if (ev.channel !== c) continue;
        const x0 = (ev.startFrame / N) * W;
        const x1 = (ev.endFrame / N) * W;
        ctx.fillStyle = KEY_COLORS[ev.key] + '33';
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), rowH);
        ctx.strokeStyle = KEY_COLORS[ev.key];
        ctx.lineWidth = ev.id === selectedId ? 2.5 : 1;
        ctx.strokeRect(x0, top, Math.max(1, x1 - x0), rowH);
        ctx.fillStyle = KEY_COLORS[ev.key];
        ctx.font = '11px sans-serif';
        ctx.fillText(ev.key, x0 + 3, top + 13);
      }
      ctx.fillStyle = '#6b7280';
      ctx.font = '10px sans-serif';
      ctx.fillText(`ch${c}`, 4, top + rowH - 4);
    }
    canvas._layout = { W, H, rows, rowH, gap, pad };
  }

  $('wave').addEventListener('click', (e) => {
    if (!wav) return;
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { W, rows, rowH, gap, pad } = e.target._layout || {};
    if (!W) return;
    const ch = rows === 1 ? 0 : Math.min(rows - 1, Math.floor((y - pad) / (rowH + gap)));
    const frame = Math.round((x / W) * wav.numFrames);
    // 命中事件则选中，否则仅记录
    const hit = events.find((ev) => ev.channel === ch && frame >= ev.startFrame && frame < ev.endFrame);
    if (hit) {
      selectedId = hit.id;
      renderEvents(); drawWaveform();
    }
  });

  window.addEventListener('resize', () => { if (wav) drawWaveform(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
