/* 采样格谱校音台 —— 页面逻辑（无第三方依赖，依赖 TrackerEngine / TrackerIO 全局） */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const Q = TrackerEngine.Q;
  const SR = TrackerEngine.SR;

  // 内置示例（与包内 rehearsal.json 同构的合法短曲，保证首帧即处于可用工作态）
  const DEMO = {
    channels: 2, bpm: 125, speed: 4,
    samples: [
      { pcm: [0, 327, 653, 975, 1294, 1607, 1913, 2211, 2500, 2778, 3044, 3297, 3536, 3759, 3967, 4157,
        4330, 4484, 4619, 4735, 4830, 4904, 4957, 4989, 5000, 4989, 4957, 4904, 4830, 4735, 4619, 4484,
        4330, 4157, 3967, 3759, 3536, 3297, 3044, 2778, 2500, 2211, 1913, 1607, 1294, 975, 653, 327, 0,
        -327, -653, -975, -1294, -1607, -1913, -2211, -2500, -2778, -3044, -3297, -3536, -3759, -3967,
        -4157, -4330, -4484, -4619, -4735, -4830, -4904, -4957, -4989, -5000, -4989, -4957, -4904, -4830,
        -4735, -4619, -4484, -4330, -4157, -3967, -3759, -3536, -3297, -3044, -2778, -2500, -2211, -1913,
        -1607, -1294, -975, -653, -327], loop: [0, 96] },
      { pcm: [0, 1130, 2129, 2892, 3338, 3421, 3136, 2516, 1630, 577, -531, -1572, -2435, -3030, -3294,
        -3202, -2767, -2037, -1095, -43, 1005, 1936, 2651, 3075, 3165, 2914, 2352, 1541, 573, -449, -1414,
        -2218, -2777, -3032, -2959, -2569, -1906, -1045, -79, 887, 1748, 2414, 2814, 2908, 2689, 2182, 1446,
        562, -374, -1262, -2005, -2525, -2769, -2714, -2367, -1769, -988, -108, 775, 1566, 2180, 2554, 2650,
        2460, 2008, 1345, 544, -306, -1115, -1796, -2276, -2507, -2466, -2161, -1627, -924, -130, 670, 1389,
        1950, 2296, 2392, 2229, 1829, 1238, 520, -245, -975, -1592, -2030, -2246, -2217, -1952, -1479, -854,
        -145, 571, 1217, 1724, 2040, 2133, 1996, 1646, 1124, 489, -191, -841, -1392, -1787, -1985, -1967,
        -1738, -1326, -778, -153, 479, 1050, 1501, 1785, 1873, 1759, 1458, 1005, 451, -143, -713, -1198,
        -1309, -1465, -1461, -1301, -1004, -606, -150, 314, 734, 1068, 1281, 1353, 1279, 1069, 749, 355,
        -68, -475, -823, -1075, -1206, -1206, -1077, -835, -510, -138, 241, 585, 858, 1033, 1093, 1035,
        868, 612, 297, -41, -366, -643, -844, -949, -950, -850, -662, -408, -119, 175, 441, 652, 786,
        833, 789, 662, 469, 233, -20, -262, -468, -616, -693, -693, -620, -483, -300, -93, 116, 303, 450,
        542, 573, 541, 453, 321, 162, -7, -166, -298, -392, -439, -436, -387, -299, -186, -60, 63, 171,
        253, 301, 313, 291, 240, 168, 84, 0, -75, -134, -171, -185, -177, -151, -111, -66, -21, 17, 45,
        60, 62, 54, 40, 23, 9], loop: null },
    ],
    patterns: [
      [{ voices: [{ ch: 0, note: [0, 65536] }, { ch: 1, note: [1, 65536] }] },
      { bpm: 137, voices: [{ ch: 1, note: [1, 65536], delay: 1 }] }],
      [{ voices: [{ ch: 0, note: [0, 98304] }] }, { voices: [{ ch: 1, note: [1, 65536] }] }],
    ],
    order: [0, 1, 0],
  };

  const state = {
    song: null,          // 当前工作副本（可编辑）
    result: null,        // 最近一次成功渲染结果
    undoStack: [],       // 编辑前的 song 深拷贝
    selected: { pi: 0, ri: 0, tick: 0 },
    audioCtx: null,
    source: null,
  };

  const clone = (x) => JSON.parse(JSON.stringify(x));

  function alert(kind, html) {
    const host = $('alertHost');
    const div = document.createElement('div');
    div.className = `alert ${kind}`;
    div.innerHTML = html;
    host.prepend(div);
    clearTimeout(alert._t);
    alert._t = setTimeout(() => div.remove(), kind === 'bad' ? 9000 : 5000);
  }
  const clearAlerts = () => { $('alertHost').innerHTML = ''; };

  /* ---------------- 渲染与错误呈现（保留已生成版本） ---------------- */

  function render(showOk) {
    let res;
    try {
      res = TrackerEngine.renderSong(state.song);
    } catch (e) {
      if (e.kind === 'validation') {
        const items = e.errors.map((x) => `<li><span class="path">${x.path}</span> — ${x.message}</li>`).join('');
        alert('bad', `格谱存在 ${e.errors.length} 处非法编辑，已拒绝：<ul class="errlist">${items}</ul>`);
      } else {
        const loc = `位置 ${e.pos}（花样 ${e.pattern}）行 ${e.row}、tick ${e.tick}、帧 ${e.frame}`;
        alert('bad', `运行时超限/非法：${e.message}<br><span class="mini">定位：${loc}</span>`);
      }
      return false;
    }
    state.result = res;
    $('statusPill').textContent = `已渲染 ${res.totalTicks} tick / ${res.totalFrames} 帧`;
    $('statusPill').className = 'pill good';
    if (showOk) alert('good', `渲染成功：${res.totalTicks} tick，${(res.totalFrames / SR).toFixed(3)} 秒`);
    refreshAll();
    return true;
  }

  /* ---------------- 编辑与撤销 ---------------- */

  function pushUndo() {
    state.undoStack.push(clone(state.song));
    if (state.undoStack.length > 100) state.undoStack.shift();
    $('undoBtn').disabled = false;
  }

  function currentRow() {
    const { pi, ri } = state.selected;
    return state.song.patterns[pi][ri];
  }

  function readEditorIntoRow() {
    const row = currentRow();
    const numOrUndef = (v) => (v === '' || v == null ? undefined : Number(v));
    const bpm = numOrUndef($('edBpm').value);
    const speed = numOrUndef($('edSpeed').value);
    if (bpm === undefined) delete row.bpm; else row.bpm = bpm;
    if (speed === undefined) delete row.speed; else row.speed = speed;

    const backTo = numOrUndef($('edBackTo').value);
    const backN = numOrUndef($('edBackN').value);
    if (backTo === undefined || backN === undefined) delete row.back;
    else row.back = [backTo, backN];

    const brk = numOrUndef($('edBreak').value);
    if (brk === undefined) delete row.break; else row.break = brk;

    const voices = [];
    $('voiceEditor').querySelectorAll('[data-vvoice]').forEach((node) => {
      const get = (name) => node.querySelector(`[data-f="${name}"]`).value;
      const ch = Number(get('ch'));
      const v = { ch };
      const sIdx = get('sample');
      const step = get('step');
      if (sIdx !== '' && step !== '') v.note = [Number(sIdx), Number(step)];
      if (get('delay') !== '') v.delay = Number(get('delay'));
      if (get('retrig') !== '') v.retrig = Number(get('retrig'));
      if (get('slide') !== '') v.slide = Number(get('slide'));
      voices.push(v);
    });
    if (voices.length) row.voices = voices; else delete row.voices;
  }

  function applyEdit() {
    pushUndo();
    readEditorIntoRow();
    const ok = render(true);
    if (!ok) {
      // 保留当前已生成版本：工作副本保留编辑，但 result 不变；刷新编辑器显示工作副本
      refreshRowEditor();
    }
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.song = state.undoStack.pop();
    $('undoBtn').disabled = state.undoStack.length === 0;
    render(false);
    alert('good', '已撤销上一次编辑');
  }

  /* ---------------- 编辑器填充 ---------------- */

  function buildVoiceRow(v, idx) {
    const nSmp = state.song.samples.length;
    const opt = (i) => `<option value="${i}" ${v.note && v.note[0] === i ? 'selected' : ''}>采样 ${i}</option>`;
    const node = document.createElement('div');
    node.className = 'vrow';
    node.setAttribute('data-vvoice', idx);
    node.innerHTML = `
      <label class="field">ch<input class="mono" data-f="ch" type="number" min="0" max="${state.song.channels - 1}" value="${v.ch}" style="width:64px"></label>
      <label class="field">采样
        <select data-f="sample" style="min-width:84px">
          <option value="">—</option>${Array.from({ length: nSmp }, (_, i) => opt(i)).join('')}
        </select>
      </label>
      <label class="field">步长(1/65536)<input class="mono" data-f="step" type="number" min="1" max="1048576" value="${v.note ? v.note[1] : ''}" style="width:110px"></label>
      <label class="field">delay<input class="mono" data-f="delay" type="number" min="0" value="${v.delay !== undefined ? v.delay : ''}" style="width:60px"></label>
      <label class="field">retrig<input class="mono" data-f="retrig" type="number" min="1" max="32" value="${v.retrig !== undefined ? v.retrig : ''}" style="width:64px"></label>
      <label class="field">slide<input class="mono" data-f="slide" type="number" min="-1048576" max="1048576" value="${v.slide !== undefined ? v.slide : ''}" style="width:96px"></label>
      <button class="ghost danger" data-del type="button">删</button>`;
    node.querySelector('[data-del]').addEventListener('click', () => node.remove());
    return node;
  }

  function refreshRowEditor() {
    const { pi, ri } = state.selected;
    const row = state.song.patterns[pi][ri];
    $('rowPath').textContent = `patterns[${pi}][${ri}]`;
    $('edBpm').value = row.bpm !== undefined ? row.bpm : '';
    $('edSpeed').value = row.speed !== undefined ? row.speed : '';
    $('edBackTo').value = row.back ? row.back[0] : '';
    $('edBackN').value = row.back ? row.back[1] : '';
    $('edBreak').value = row.break !== undefined ? row.break : '';
    const host = $('voiceEditor');
    host.innerHTML = '';
    (row.voices || []).forEach((v, i) => host.appendChild(buildVoiceRow(v, i)));
  }

  function refreshSelectors() {
    const ps = $('patternSelect');
    ps.innerHTML = state.song.patterns.map((_, i) => `<option value="${i}">花样 ${i}</option>`).join('');
    ps.value = String(state.selected.pi);
    const rs = $('rowSelect');
    const nRows = state.song.patterns[state.selected.pi].length;
    rs.innerHTML = Array.from({ length: nRows }, (_, i) => `<option value="${i}">行 ${i}</option>`).join('');
    rs.value = String(state.selected.ri);
  }

  function refreshStats() {
    $('stChannels').textContent = state.song.channels;
    $('stBpm').textContent = state.song.bpm;
    $('stSpeed').textContent = state.song.speed;
    $('stOrder').textContent = state.song.order.length;
    const tb = $('sampleTable').querySelector('tbody');
    tb.innerHTML = state.song.samples.map((s, i) =>
      `<tr><td>${i}</td><td class="num">${s.pcm.length}</td><td>${s.loop ? `[${s.loop[0]},${s.loop[1]})` : 'null'}</td></tr>`).join('');
  }

  /* ---------------- 逐 tick 检视 ---------------- */

  function selectTick(t) {
    const r = state.result;
    if (!r) return;
    state.selected.tick = Math.max(0, Math.min(r.totalTicks - 1, t | 0));
    const tk = r.log[state.selected.tick];
    $('tickJump').value = tk.tick;
    $('tkAbs').textContent = tk.tick;
    $('tkLoc').textContent = `${tk.pos} / 花样 ${tk.pattern} / 行 ${tk.row}`;
    $('tkRowTick').textContent = `${tk.rowTick}（本行 speed ${tk.speed}）`;
    $('tkFrames').textContent = `[${tk.startFrame}, ${tk.endFrame})  长 ${tk.endFrame - tk.startFrame} 帧`;
    $('tkBpm').textContent = `${tk.bpm} / ${tk.speed}`;
    $('tkJump').textContent = tk.jump
      ? (tk.jump.type === 'end' ? '行末：结束'
        : `行末跳转：${tk.jump.type} → 位置 ${tk.jump.toPos} 行 ${tk.jump.toRow}` +
          (tk.jump.remaining !== null && tk.jump.remaining !== undefined ? `（剩余回跳 ${tk.jump.remaining}）` : ''))
      : '';

    const tag = { note: ['note', '新音'], retrig: ['retrig', '重触发'], none: ['none', '无触发'], off: ['off', '未发声'] };
    $('eventList').innerHTML = tk.events.map((ev) => {
      const [cls, label] = tag[ev.event];
      if (ev.event === 'off') return `<div class="ev off"><span class="ch">ch${ev.ch}</span><span>${label}</span></div>`;
      return `<div class="ev ${cls}"><span class="ch">ch${ev.ch}</span><span>${label}</span>
        <span>采样${ev.sample}</span><span>相位 ${ev.phase} (${(ev.phase / Q).toFixed(4)})</span>
        <span>步长 ${ev.step} (${(ev.step / Q).toFixed(4)})</span></div>`;
    }).join('');

    // 同步表格高亮
    $('tickTable').querySelectorAll('tr').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.tick) === tk.tick));
    const sel = $('tickTable').querySelector('tr.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function refreshTickTable() {
    const r = state.result;
    const tb = $('tickTable').querySelector('tbody');
    tb.innerHTML = r.log.map((tk) =>
      `<tr data-tick="${tk.tick}"><td>${tk.tick}</td><td>${tk.pos}</td><td>${tk.pattern}</td><td>${tk.row}</td>
       <td class="num">${tk.startFrame}</td><td class="num">${tk.endFrame}</td><td>${tk.bpm}</td></tr>`).join('');
    tb.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => selectTick(Number(tr.dataset.tick))));
    selectTick(state.selected.tick);
  }

  /* ---------------- 波形与区间 ---------------- */

  function drawWave() {
    const cv = $('waveCanvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const r = state.result;
    if (!r) return;
    const pcm = r.pcm;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fd6c8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(pcm.length / W));
    for (let x = 0; x < W; x++) {
      let mn = 32767, mx = -32768;
      const base = x * step;
      for (let i = 0; i < step && base + i < pcm.length; i++) {
        const v = pcm[base + i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const y1 = H / 2 - (mx / 32768) * (H / 2 - 4);
      const y2 = H / 2 - (mn / 32768) * (H / 2 - 4);
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();
    // 零轴
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#333';
    ctx.beginPath(); ctx.moveTo(0, H / 2 + .5); ctx.lineTo(W, H / 2 + .5); ctx.stroke();
    // 区间高亮
    const [a, b] = currentRange();
    const x1 = (a / pcm.length) * W;
    const x2 = (b / pcm.length) * W;
    ctx.fillStyle = 'rgba(79,214,200,.16)';
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), H);
  }

  function currentRange() {
    const r = state.result;
    let a = Number($('rangeStart').value) || 0;
    let b = Number($('rangeEnd').value);
    if (!Number.isFinite(b) || b <= 0) b = r.totalFrames;
    a = Math.max(0, Math.min(r.totalFrames, a));
    b = Math.max(a, Math.min(r.totalFrames, b));
    return [a, b];
  }

  function updateRangeInfo() {
    const [a, b] = currentRange();
    const n = b - a;
    $('rangeInfo').textContent = `区间 [${a},${b})：${n} 帧 = ${(n / SR).toFixed(4)} 秒；与全曲截取逐样本一致`;
  }

  /* ---------------- 试听 ---------------- */

  function ensureCtx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }

  function stopPlay() {
    if (state.source) {
      try { state.source.stop(); } catch (_) {}
      state.source = null;
    }
  }

  function playPcm(int16) {
    stopPlay();
    const ctx = ensureCtx();
    const buf = ctx.createBuffer(1, int16.length, SR);
    const f32 = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.onended = () => { if (state.source === node) state.source = null; };
    node.start();
    state.source = node;
  }

  /* ---------------- 导出（Blob 下载） ---------------- */

  function download(bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportWav(full) {
    const r = state.result;
    const [a, b] = full ? [0, r.totalFrames] : currentRange();
    const slice = r.pcm.subarray(a, b); // 同一缓冲切片，逐样本等于全曲截取
    const wav = TrackerIO.buildWav(slice, SR);
    download(wav, full ? 'tracker-full.wav' : `tracker-${a}-${b}.wav`, 'audio/wav');
    alert('good', `已导出 ${full ? '全曲' : `区间 [${a},${b})`} WAV，${slice.length} 帧`);
  }

  function exportLog(full) {
    const r = state.result;
    const [a, b] = full ? [0, r.totalFrames] : currentRange();
    const txt = TrackerEngine.formatLog(r, a, b);
    download(new TextEncoder().encode(txt), full ? 'tracker-full-log.txt' : `tracker-log-${a}-${b}.txt`, 'text/plain');
  }

  /* ---------------- 总刷新 ---------------- */

  function refreshAll() {
    refreshStats();
    refreshSelectors();
    refreshRowEditor();
    refreshTickTable();
    $('rangeEnd').value = state.result.totalFrames;
    $('rangeStart').value = 0;
    drawWave();
    updateRangeInfo();
  }

  /* ---------------- 载入 zip ---------------- */

  async function loadZip(file) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const files = await TrackerIO.readZip(buf);
      const j = files.find((f) => f.name.endsWith('.json'));
      if (!j) throw new Error('zip 内未找到 .json 格谱');
      const song = JSON.parse(new TextDecoder().decode(j.bytes));
      state.song = song;
      state.undoStack = [];
      state.selected = { pi: 0, ri: 0, tick: 0 };
      const ok = render(false);
      if (ok) {
        $('statusPill').textContent = `已载入 ${file.name}`;
        alert('good', `已从 ${file.name} 载入格谱并渲染`);
      } else {
        // 超限样例（如包内完整曲）仍载入工作副本，供编辑；提示无可用渲染
        $('statusPill').textContent = `已载入 ${file.name}（当前超限，需编辑）`;
        $('statusPill').className = 'pill warn';
        refreshStats(); refreshSelectors(); refreshRowEditor();
      }
    } catch (e) {
      alert('bad', `载入失败：${e.message}`);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('patternSelect').addEventListener('change', (e) => {
      state.selected.pi = Number(e.target.value);
      state.selected.ri = 0;
      refreshSelectors(); refreshRowEditor();
    });
    $('rowSelect').addEventListener('change', (e) => {
      state.selected.ri = Number(e.target.value);
      refreshRowEditor();
    });
    $('addVoiceBtn').addEventListener('click', () => {
      const used = new Set([...$('voiceEditor').querySelectorAll('[data-f="ch"]')].map((n) => Number(n.value)));
      let ch = 0;
      while (used.has(ch)) ch++;
      if (ch >= state.song.channels) { alert('warn', '所有声道已在本行使用'); return; }
      $('voiceEditor').appendChild(buildVoiceRow({ ch }, $('voiceEditor').children.length));
    });
    $('applyBtn').addEventListener('click', applyEdit);
    $('resetRowBtn').addEventListener('click', refreshRowEditor);
    $('undoBtn').addEventListener('click', undo);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    });

    $('tickGoBtn').addEventListener('click', () => selectTick(Number($('tickJump').value)));
    $('tickJump').addEventListener('keydown', (e) => { if (e.key === 'Enter') selectTick(Number(e.target.value)); });
    $('prevTickBtn').addEventListener('click', () => selectTick(state.selected.tick - 1));
    $('nextTickBtn').addEventListener('click', () => selectTick(state.selected.tick + 1));

    ['rangeStart', 'rangeEnd'].forEach((id) => $(id).addEventListener('input', () => { drawWave(); updateRangeInfo(); }));
    $('playRangeBtn').addEventListener('click', () => {
      const [a, b] = currentRange();
      playPcm(state.result.pcm.subarray(a, b));
    });
    $('playFullBtn').addEventListener('click', () => playPcm(state.result.pcm));
    $('stopBtn').addEventListener('click', stopPlay);

    $('exportWavBtn').addEventListener('click', () => exportWav(false));
    $('exportFullWavBtn').addEventListener('click', () => exportWav(true));
    $('exportLogBtn').addEventListener('click', () => exportLog(false));
    $('exportFullLogBtn').addEventListener('click', () => exportLog(true));

    // 主题
    const saved = (() => { try { return localStorage.getItem('tracker-theme'); } catch (_) { return null; } })();
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
    $('themeBtn').addEventListener('click', () => {
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      if (light) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'light');
      try { localStorage.setItem('tracker-theme', light ? 'dark' : 'light'); } catch (_) {}
      drawWave();
    });

    // 文件载入（点击 + 拖拽）
    const dz = $('dropzone');
    const fi = $('fileInput');
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => { if (fi.files[0]) loadZip(fi.files[0]); });
    ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadZip(f); });
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    bind();
    state.song = clone(DEMO);
    render(false);
    $('statusPill').textContent = '内置示例已就绪（可载入 zip 替换）';
    $('statusPill').className = 'pill';
  }
  start();
})();
