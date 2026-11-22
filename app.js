/*
 * app.js — MIDI 乐句卷带台的界面与交互。
 * 核心解析 / 重排 / 导出在 midi-reel.js（浏览器与 Node 共用），这里只负责画面、剪辑单与导出。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const M = window.MidiReel;

  /* 样例包里的文件（samples/midi-reel-cases.zip）内嵌一份，file:// 与 http 都能用。 */
  const SAMPLES = {
    takes: 'TVRoZAAAAAYAAQADAAdNVHJrAAAAIAD/UQMHoSAE/1EDBhqBBP9RAwknwwT/UQMFFhUC/y8ATVRyawAAABcAkDxaAjxGAjwABD5gATwAAz4AAv8vAE1UcmsAAAARAZFBUARBAANBQAJBAAT/LwA=',
    single: 'TVRoZAAAAAYAAAABAeBNVHJrAAAADQCQPFCBAYA8AAH/LwA=',
    truncated: 'TVRoZAAAAAYAAQADAAdNVHJrAAAAIAD/UQMHoSAE/1EDBhqBBP9RAwknwwT/UQMFFhUC/y8ATVRyawAAABcAkDxaAjxGAjwABD5gATwAAz4AAv8vAE1UcmsAAAARAZFBUARBAANBQAJBAAT/',
    reel: 'eyJjbGlwcyI6IFtbMSwgOV0sIFs4LCAxNF0sIFsxLCA5XV19',
  };
  const SAMPLE_NAMES = { takes: 'takes.mid', single: 'single.mid', truncated: 'truncated.mid' };

  const TRACK_COLORS = Array.from({ length: 16 }, (_, i) => '--tc' + (i + 1));
  const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    song: null,
    songName: '',
    clips: [],
    arr: null,
    error: '',
    selected: -1,
    srcView: { start: 0, end: 1 },
    hover: null,
    drag: null,
    play: null,
    exportInfo: null,
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function basename(name) {
    return String(name).split(/[\\/]/).pop();
  }

  function b64ToText(b64) {
    return new TextDecoder().decode(b64ToBytes(b64));
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function pitchName(key) {
    return PITCH_NAMES[((key % 12) + 12) % 12] + (Math.floor(key / 12) - 1);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function fmtSeconds(us) {
    return (us / 1e6).toFixed(3) + ' s';
  }

  function beatLabel(tick, ppq) {
    const beat = tick / ppq;
    if (Math.abs(beat - Math.round(beat)) < 1e-9) return String(Math.round(beat));
    return String(Math.round(beat * 1000) / 1000);
  }

  function cssColor(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function setStatus(mode, text, file) {
    const el = $('status');
    el.classList.toggle('loading', mode === 'loading');
    el.classList.toggle('error', mode === 'error');
    $('statusText').textContent = text;
    if (file !== undefined) $('statusFile').textContent = file;
  }

  /* ------------------------------------------------------------------ *
   * 载入
   * ------------------------------------------------------------------ */

  function loadSong(bytes, name) {
    let song;
    try {
      song = M.parseMidi(bytes);
    } catch (err) {
      const kept = state.song ? `（仍显示 ${state.songName}）` : '';
      showLoadError(`无法读取 ${basename(name)}：${err.message}${kept}`);
      setStatus('error', '载入失败' + kept, state.song ? state.songName : basename(name));
      return false;
    }
    stopPlayback();
    state.song = song;
    state.songName = basename(name);
    state.clips = [];
    state.selected = -1;
    state.error = '';
    state.hover = null;
    fitView('src');
    showLoadInfo();
    setStatus('ready', `${song.format} 型 · PPQ ${song.ppq} · ${song.tracks.length} 轨`, state.songName);
    recompute();
    return true;
  }

  function showLoadInfo() {
    const s = state.song;
    const el = $('loadMsg');
    el.classList.remove('error');
    if (!s) { el.textContent = ''; return; }
    const notes = s.notes.length;
    const tempoCount = new Set(s.tempos.map((t) => t.tick + ':' + t.tempo)).size;
    el.innerHTML =
      `<b>${escapeHtml(state.songName)}</b> 已载入：${s.format} 型 · PPQ <b>${s.ppq}</b> · ${s.tracks.length} 轨 · ` +
      `${fmtInt(s.eventCount)} 条事件 · <b>${notes}</b> 个音符 · ${tempoCount} 个速度点` +
      (s.warnings.length ? ` · <span style="color:var(--warn)">${s.warnings.length} 条警告</span>` : '');
  }

  function showLoadError(message) {
    const el = $('loadMsg');
    el.classList.add('error');
    el.textContent = message;
  }

  function readFile(file, asText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = () => resolve(reader.result);
      if (asText) reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  async function openMidiFile(file) {
    try {
      const buf = await readFile(file);
      loadSong(new Uint8Array(buf), file.name);
    } catch (err) {
      showLoadError('读取文件失败：' + err.message);
    }
  }

  async function openReelFile(file) {
    try {
      const text = await readFile(file, true);
      applyReelJson(text);
    } catch (err) {
      showLoadError('剪辑单读取失败：' + err.message);
    }
  }

  /** 解析并应用剪辑单；非法内容整体拒绝，保留原来的剪辑单。 */
  function applyReelJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      showLoadError('剪辑单不是合法 JSON：' + err.message);
      return false;
    }
    const raw = Array.isArray(data) ? data : data && data.clips;
    if (!Array.isArray(raw)) {
      showLoadError('剪辑单缺少 clips 数组（应为 {"clips": [[start, end], …]}）');
      return false;
    }
    const clips = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      const start = Array.isArray(item) ? item[0] : item && item.start;
      const end = Array.isArray(item) ? item[1] : item && item.end;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        showLoadError(`剪辑单第 ${i + 1} 段不是整数 tick 的 [start, end)：${JSON.stringify(item)}`);
        return false;
      }
      if (start < 0 || end <= start) {
        showLoadError(`剪辑单第 ${i + 1} 段区间非法：[${start}, ${end})，需要 0 ≤ start < end`);
        return false;
      }
      clips.push({ start, end });
    }
    state.clips = clips.map((c) => ({ ...c }));
    state.selected = -1;
    state.error = '';
    if (state.song) {
      const length = state.song.lengthTicks;
      if (clips.some((c) => c.end > length)) {
        showLoadInfo();
        const el = $('loadMsg');
        el.innerHTML += ` · <span style="color:var(--warn)">有片段超出源长度 ${length} tick，超出部分是静音</span>`;
      }
      recompute();
      state.selected = clips.length ? 0 : -1;
      renderClipTable();
      drawSource();
    } else {
      showLoadError('剪辑单已读取，但还没有 MIDI 文件。请先载入一份 MIDI。');
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 重算
   * ------------------------------------------------------------------ */

  function recompute() {
    stopPlayback();
    state.error = '';
    state.arr = null;
    if (!state.song) {
      renderAll();
      return;
    }
    if (state.clips.length === 0) {
      renderAll();
      return;
    }
    try {
      state.arr = M.arrange(state.song, state.clips);
    } catch (err) {
      state.error = err.message;
    }
    if (state.arr && state.selected >= state.clips.length) state.selected = state.clips.length - 1;
    renderAll();
  }

  function renderAll() {
    $('sourceStep').hidden = !state.song;
    $('reelStep').hidden = !state.song;
    $('outStep').hidden = !state.song;
    if (!state.song) { $('facts').innerHTML = ''; return; }
    renderFacts();
    renderWarnings();
    renderLegend();
    renderClipTable();
    renderOutputSummary();
    renderManifest();
    updateExportButtons();
    drawSource();
    drawOutput();
    $('exportBox').hidden = true;
    $('copyNote').hidden = true;
  }

  function renderFacts() {
    const s = state.song;
    const keys = s.notes.map((n) => n.key);
    const lo = keys.length ? Math.min(...keys) : null;
    const hi = keys.length ? Math.max(...keys) : null;
    const tempoCount = new Set(s.tempos.map((t) => t.tick + ':' + t.tempo)).size;
    const items = [
      ['格式 / PPQ', `${s.format} 型<small> · PPQ ${s.ppq}</small>`],
      ['轨道', `${s.tracks.length}<small> 轨</small>`],
      ['音符', `${fmtInt(s.notes.length)}<small> 个</small>`],
      ['速度点', `${tempoCount}<small> 处</small>`],
      ['音域', lo === null ? '—<small> 无音符</small>' : `${pitchName(lo)}–${pitchName(hi)}`],
      ['源长度', `${fmtInt(s.lengthTicks)}<small> tick · ${beatLabel(s.lengthTicks, s.ppq)} 拍</small>`],
    ];
    $('facts').innerHTML = items
      .map(([k, v]) => `<div><dt>${k}</dt><dd title="${escapeHtml(String(v).replace(/<[^>]+>/g, ''))}">${v}</dd></div>`)
      .join('');
  }

  function renderWarnings() {
    const el = $('warnings');
    if (!state.song.warnings.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = '';
    const ul = document.createElement('ul');
    ul.style.margin = '0';
    ul.style.padding = '0 0 0 4px';
    ul.style.listStyle = 'disc';
    for (const w of state.song.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }

  function renderLegend() {
    const s = state.song;
    const el = $('trackLegend');
    const parts = [];
    s.tracks.forEach((track, ti) => {
      if (!track.notes.length) return;
      const channels = [...new Set(track.notes.map((n) => n.channel + 1))].sort((a, b) => a - b);
      const color = `var(${TRACK_COLORS[ti % 16]})`;
      const name = track.name ? escapeHtml(track.name) : `轨 ${ti + 1}`;
      const channelText = channels.length > 1 ? `通道 ${channels.join(' / ')}` : `通道 ${channels[0]}`;
      parts.push(
        `<span class="sw"><i style="--c:${color}"></i>${name}` +
        `<span style="color:var(--faint)"> · ${channelText} · ${track.notes.length} 个音符</span></span>`
      );
    });
    if (!parts.length) parts.push('<span>这个文件没有音符事件。</span>');
    parts.push('<span class="sw"><i style="--c:var(--accent)"></i>剪辑单切点</span>');
    el.innerHTML = parts.join('');
  }

  function clipStats(index) {
    if (!state.arr) return { cut: 0 };
    return { cut: state.arr.manifest.clips[index].clippedNotes };
  }

  function renderClipTable() {
    const body = $('clipBody');
    const foot = $('clipFoot');
    body.innerHTML = '';
    foot.innerHTML = '';
    const song = state.song;
    const arr = state.arr;

    state.clips.forEach((clip, i) => {
      const tr = document.createElement('tr');
      if (i === state.selected) tr.className = 'selected';
      tr.dataset.index = String(i);
      const manifest = arr ? arr.manifest.clips[i] : null;
      const startTempo = song ? M.tempoAt(song.tempos, clip.start) : 0;
      const stats = arr ? clipStats(i) : { cut: 0 };
      tr.innerHTML =
        `<td class="l"><span class="idx">${String(i + 1).padStart(2, '0')}</span></td>` +
        `<td><input type="number" inputmode="numeric" step="1" min="0" value="${clip.start}" data-i="${i}" data-f="start" aria-label="片段 ${i + 1} 的 start tick"></td>` +
        `<td><input type="number" inputmode="numeric" step="1" min="0" value="${clip.end}" data-i="${i}" data-f="end" aria-label="片段 ${i + 1} 的 end tick"></td>` +
        `<td>${clip.end - clip.start > 0 && Number.isInteger(clip.end - clip.start) ? fmtInt(clip.end - clip.start) : '—'}</td>` +
        `<td>${startTempo}</td>` +
        `<td>${stats.cut ? `<span class="cut">${stats.cut}</span>` : '<span class="zero">0</span>'}</td>` +
        (manifest
          ? `<td>${fmtInt(manifest.outputTick)}</td>` +
            `<td>${fmtInt(manifest.clipUs)}<span class="exact">${manifest.clipExact}</span></td>` +
            `<td>${fmtInt(manifest.cumulativeUs)}<span class="exact">${manifest.cumulativeExact}</span></td>`
          : '<td colspan="3" style="color:var(--faint)">—</td>') +
        `<td class="l"><span class="rowactions">` +
        `<button type="button" class="btn tiny icon" data-act="up" aria-label="上移第 ${i + 1} 段" ${i === 0 ? 'disabled' : ''}>↑</button>` +
        `<button type="button" class="btn tiny icon" data-act="down" aria-label="下移第 ${i + 1} 段" ${i === state.clips.length - 1 ? 'disabled' : ''}>↓</button>` +
        `<button type="button" class="btn tiny icon" data-act="dup" aria-label="复制第 ${i + 1} 段">⧉</button>` +
        `<button type="button" class="btn tiny icon" data-act="del" aria-label="删除第 ${i + 1} 段">✕</button>` +
        `</span></td>`;
      body.appendChild(tr);
    });

    if (!state.clips.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="l" colspan="10" style="color:var(--dim)">还没有片段。在源卷帘上拖动截取，或用上方按钮添加 / 载入剪辑单。</td>';
      body.appendChild(tr);
    }

    if (arr) {
      const totalCut = state.arr.manifest.clips.reduce((sum, _, i) => sum + clipStats(i).cut, 0);
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="l">合计</td><td></td><td></td><td>${fmtInt(arr.totalTicks)}</td><td></td>` +
        `<td>${totalCut || '<span class="zero">0</span>'}</td>` +
        `<td colspan="2"></td>` +
        `<td>${fmtInt(arr.totalUs)}<span class="exact">${arr.totalExact} · ${fmtSeconds(arr.totalUs)}</span></td>` +
        `<td></td>`;
      foot.appendChild(tr);
    }

    const errorEl = $('clipError');
    errorEl.hidden = !state.error;
    errorEl.textContent = state.error ? '剪辑单未生效：' + state.error : '';

    body.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.i);
        const field = inp.dataset.f;
        const value = Number(inp.value);
        if (!Number.isInteger(value) || value < 0) {
          showLoadError('start / end 必须是非负整数 tick');
          renderClipTable();
          return;
        }
        const next = { ...state.clips[i], [field]: value };
        state.clips[i] = next;
        state.selected = i;
        recompute();
      });
      inp.addEventListener('input', () => {
        const tr = inp.closest('tr');
        body.querySelectorAll('tr.selected').forEach((row) => row.classList.remove('selected'));
        if (tr) tr.classList.add('selected');
        if (tr && tr.dataset.index !== undefined) {
          state.selected = Number(tr.dataset.index);
          drawSource();
        }
      });
    });

    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.closest('tr').dataset.index);
        const act = btn.dataset.act;
        if (act === 'up' && i > 0) [state.clips[i - 1], state.clips[i]] = [state.clips[i], state.clips[i - 1]], state.selected = i - 1;
        if (act === 'down' && i < state.clips.length - 1) [state.clips[i + 1], state.clips[i]] = [state.clips[i], state.clips[i + 1]], state.selected = i + 1;
        if (act === 'dup') {
          state.clips.splice(i + 1, 0, { ...state.clips[i] });
          state.selected = i + 1;
        }
        if (act === 'del') {
          state.clips.splice(i, 1);
          state.selected = Math.min(i, state.clips.length - 1);
        }
        recompute();
      });
    });

    body.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('input,button')) return;
        if (row.dataset.index === undefined) return;
        state.selected = Number(row.dataset.index);
        renderClipTable();
        drawSource();
        drawOutput();
      });
    });
  }

  function updateExportButtons() {
    const ready = Boolean(state.arr);
    $('exportMidi').disabled = !ready;
    $('exportManifest').disabled = !ready;
    $('playBtn').disabled = !state.song || (!ready && state.song.notes.length === 0);
  }

  function renderOutputSummary() {
    const el = $('outSum');
    if (!state.arr) {
      const hasClips = state.clips.length > 0;
      el.innerHTML = hasClips && state.error
        ? `<span style="color:var(--err);font-size:12.5px">剪辑单有问题，暂时不能输出：${escapeHtml(state.error)}</span>`
        : '<span style="color:var(--dim);font-size:12.5px">还没有可输出的剪辑单。在卷帘上拖动截取，或载入样例剪辑单。</span>';
      return;
    }
    const arr = state.arr;
    const clipCount = arr.manifest.clips.length;
    const totalCut = arr.manifest.clips.reduce((sum, _, i) => sum + clipStats(i).cut, 0);
    const noteCount = arr.tracks.reduce((sum, t) => sum + t.length, 0);
    el.innerHTML = [
      ['片段', `${clipCount}<small> 段</small>`],
      ['输出长度', `${fmtInt(arr.totalTicks)}<small> tick</small>`],
      ['输出音符', `${fmtInt(noteCount)}<small> 个</small>`],
      ['补足事件', `${totalCut}<small> 个音符</small>`],
      ['总时长', `${fmtInt(arr.totalUs)}<small> µs · ${fmtSeconds(arr.totalUs)}</small>`],
      ['精确总长', `<span style="font-size:12px">${arr.totalExact}</span><small> µs</small>`],
    ].map(([k, v]) => `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  }

  function renderManifest() {
    const body = $('manifestBody');
    body.innerHTML = '';
    if (!state.arr) return;
    for (const c of state.arr.manifest.clips) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="l idx">${String(c.index).padStart(2, '0')}</td>` +
        `<td class="l">[${c.sourceStart}, ${c.sourceEnd})</td>` +
        `<td>${fmtInt(c.outputTick)}</td>` +
        `<td>${fmtInt(c.ticks)}</td>` +
        `<td>${c.tempo}</td>` +
        `<td>${fmtInt(c.clipUs)}</td>` +
        `<td>${fmtInt(c.cumulativeUs)}</td>` +
        `<td class="l" style="color:var(--dim)">${c.cumulativeExact}</td>`;
      body.appendChild(tr);
    }
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="l">合计</td><td class="l">${state.arr.manifest.clips.length} 段</td>` +
      `<td>${fmtInt(state.arr.totalTicks)}</td><td></td><td></td><td></td>` +
      `<td><b>${fmtInt(state.arr.manifest.totalUs)}</b></td>` +
      `<td class="l"><b>${state.arr.manifest.totalExact}</b></td>`;
    body.appendChild(tr);
  }

  /* ------------------------------------------------------------------ *
   * 钢琴卷帘绘制
   * ------------------------------------------------------------------ */

  function setupCanvas(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, canvas.parentElement.clientWidth);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = cssHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height: cssHeight, dpr };
  }

  function pitchWindow(notes) {
    if (!notes.length) return { lo: 55, hi: 72 };
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      if (n.key < lo) lo = n.key;
      if (n.key > hi) hi = n.key;
    }
    lo = Math.max(0, lo - 2);
    hi = Math.min(127, hi + 2);
    if (hi - lo < 11) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, Math.floor(mid - 6));
      hi = Math.min(127, lo + 12);
    }
    return { lo, hi };
  }

  const TEMPO_LANE = 62;
  const AXIS_LANE = 22;
  const GUTTER = 46;

  /** 行高与卷帘高度只在这里算一次，绘制和命中检测共用。 */
  function rollMetrics(pitch) {
    const rows = pitch.hi - pitch.lo + 1;
    const rowH = Math.max(7, Math.min(15, Math.floor(330 / rows)));
    return { rows, rowH, rollH: rows * rowH };
  }

  function drawRoll(canvas, opts) {
    const {
      notes, tempos, ppq, viewStart, viewEnd,
      bands, cutTicks, allowBandLabels, interactive,
    } = opts;
    const pitch = pitchWindow(opts.allNotes || notes);
    const { rowH, rollH } = rollMetrics(pitch);
    const height = rollH + TEMPO_LANE + AXIS_LANE;

    const { ctx, width } = setupCanvas(canvas, height);
    const gutter = GUTTER;
    const plotW = Math.max(1, width - gutter);
    const span = Math.max(1, viewEnd - viewStart);
    const pxPerTick = plotW / span;
    const xOf = (tick) => gutter + (tick - viewStart) * pxPerTick;
    const yOf = (key) => (pitch.hi - key) * rowH;

    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
    const line = cssColor('--line');
    const grid = cssColor('--grid');
    const gridMajor = cssColor('--grid-major');
    const gridFine = cssColor('--grid-fine');
    const roll = cssColor('--roll');
    const lane = cssColor('--lane');
    const accent = cssColor('--accent');
    const faint = cssColor('--faint');
    const dim = cssColor('--dim');
    const ink = cssColor('--ink');

    ctx.fillStyle = roll;
    ctx.fillRect(0, 0, width, height);

    // 黑白键行底色
    ctx.fillStyle = cssColor('--row-dark');
    for (let key = pitch.lo; key <= pitch.hi; key++) {
      const pc = ((key % 12) + 12) % 12;
      if (pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10) {
        ctx.fillRect(gutter, yOf(key), plotW, rowH);
      }
    }
    ctx.fillStyle = cssColor('--row-line');
    for (let key = pitch.lo; key <= pitch.hi; key++) {
      if (((key % 12) + 12) % 12 === 0) ctx.fillRect(gutter, yOf(key) + rowH - 1, plotW, 1);
    }

    // 左侧音名（只标 C，行高够时标全部 C）
    ctx.fillStyle = cssColor('--panel-2');
    ctx.fillRect(0, 0, gutter, rollH);
    ctx.fillStyle = cssColor('--line');
    ctx.fillRect(gutter - 1, 0, 1, rollH);
    ctx.font = '9.5px ' + mono;
    ctx.textAlign = 'right';
    for (let key = pitch.lo; key <= pitch.hi; key++) {
      if (((key % 12) + 12) % 12 !== 0) continue;
      const y = yOf(key) + rowH - 2;
      ctx.fillStyle = dim;
      ctx.fillText(pitchName(key), gutter - 6, y);
    }
    ctx.textAlign = 'left';

    // 片段色带（同一区间只画一次，序号并列）
    if (bands) {
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        if (band.end <= viewStart || band.start >= viewEnd) continue;
        const xa = Math.max(gutter, xOf(band.start));
        const xb = Math.min(width, xOf(band.end));
        ctx.fillStyle = i % 2 === 0 ? cssColor('--band-a') : cssColor('--band-b');
        ctx.fillRect(xa, 0, Math.max(1, xb - xa), rollH);
        if (band.selected) {
          ctx.strokeStyle = ink;
          ctx.globalAlpha = 0.42;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(xa + 1, 1, Math.max(1, xb - xa - 2), rollH - 2);
          ctx.globalAlpha = 1;
        }
        if (allowBandLabels && xb - xa > 20) {
          ctx.fillStyle = cssColor('--dim');
          ctx.font = '600 10px ' + mono;
          ctx.fillText(band.label || '#' + (i + 1), xa + 4, 11);
        }
      }
    }

    // 时间网格
    const beatPx = ppq * pxPerTick;
    let divisions = 1;
    if (beatPx < 40) divisions = 2;
    if (beatPx < 20) divisions = 4;
    if (beatPx * 4 < 24) divisions = 16;
    const step = ppq / divisions;
    for (let t = Math.floor(viewStart / step) * step; t <= viewEnd; t += step) {
      const beat = t / ppq;
      const isBeat = Math.abs(beat - Math.round(beat)) < 1e-9;
      const isBar = isBeat && Math.round(beat) % 4 === 0;
      ctx.fillStyle = isBar ? gridMajor : isBeat ? grid : gridFine;
      ctx.fillRect(Math.round(xOf(t)), 0, 1, rollH);
    }

    // 音符
    for (const note of notes) {
      if (note.end <= viewStart || note.start >= viewEnd) continue;
      const color = cssColor(TRACK_COLORS[(note.track || 0) % 16]);
      const x0 = xOf(Math.max(note.start, viewStart));
      const x1 = xOf(Math.min(note.end, viewEnd));
      const y = yOf(note.key);
      const w = Math.max(1.5, x1 - x0);
      const h = Math.max(2, rowH - 1.5);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x0, y + 0.75, w, h);
      ctx.globalAlpha = 1;
      if (w > 3) {
        ctx.strokeStyle = cssColor('--note-stroke');
        ctx.lineWidth = 0.75;
        ctx.strokeRect(x0 + 0.375, y + 1.125, w - 0.75, h - 0.75);
      }
      if (note.clippedStart || note.clippedEnd) {
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.7;
        if (note.clippedStart) ctx.fillRect(x0, y + 0.75, 1.5, h);
        if (note.clippedEnd) ctx.fillRect(x0 + w - 1.5, y + 0.75, 1.5, h);
        ctx.globalAlpha = 1;
      }
      if (note.selected) {
        ctx.strokeStyle = cssColor('--ink');
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1, y + 0.25, w + 2, h + 1);
      }
    }

    // 速度车道
    const laneY = rollH;
    ctx.fillStyle = lane;
    ctx.fillRect(0, laneY, width, TEMPO_LANE + AXIS_LANE);
    ctx.fillStyle = cssColor('--line');
    ctx.fillRect(0, laneY, width, 1);

    const values = [M.DEFAULT_TEMPO, ...tempos.map((t) => t.tempo)];
    let tMin = Math.min(...values);
    let tMax = Math.max(...values);
    if (tMin === tMax) { tMin -= 50000; tMax += 50000; }
    const padTop = 22;
    const padBottom = 14;
    const ty = (v) => laneY + padTop + (1 - (v - tMin) / (tMax - tMin)) * (TEMPO_LANE - padTop - padBottom);

    const segments = tempoSegments(tempos, viewStart, viewEnd);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const seg of segments) {
      const xa = Math.max(gutter, xOf(seg.start));
      const xb = Math.min(width, xOf(seg.end));
      if (xb <= xa) continue;
      ctx.moveTo(xa, ty(seg.tempo));
      ctx.lineTo(xb, ty(seg.tempo));
    }
    ctx.stroke();

    ctx.fillStyle = accent;
    for (const seg of segments) {
      if (seg.start <= viewStart) continue;
      ctx.beginPath();
      ctx.arc(xOf(seg.start), ty(seg.tempo), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 车道表头在左侧音名栏，不压住段内标注
    ctx.fillStyle = faint;
    ctx.font = '9.5px ' + mono;
    ctx.textAlign = 'right';
    ctx.fillText('速度', gutter - 6, laneY + 15);
    ctx.fillText('µs/♩', gutter - 6, laneY + 27);
    ctx.textAlign = 'left';

    // 切点（先画竖线，速度值标注随后用底色盖住穿过文字的线）
    if (cutTicks && cutTicks.length) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      for (const tick of cutTicks) {
        if (tick < viewStart || tick > viewEnd) continue;
        const x = Math.round(xOf(tick)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, laneY + TEMPO_LANE);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 段内标速度值：放得下、不重叠、不压切点、不出右边界才标
    ctx.font = '10px ' + mono;
    const cutXs = (cutTicks || [])
      .filter((t) => t > viewStart && t < viewEnd)
      .map((t) => Math.round(xOf(t)));
    let lastLabelEnd = -Infinity;
    const labelEnd = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const xa = Math.max(gutter, xOf(seg.start));
      const xb = Math.min(width, xOf(seg.end));
      const text = String(seg.tempo);
      const tw = ctx.measureText(text).width;
      const lx = xa + 5;
      if (xb - xa < tw + 12 || lx < lastLabelEnd + 8 || lx + tw > width - 6) { labelEnd.push(false); continue; }
      if (cutXs.some((cx) => cx >= lx - 3 && cx <= lx + tw + 3)) { labelEnd.push(false); continue; }
      const yLine = ty(seg.tempo);
      const below = yLine + 13 <= laneY + TEMPO_LANE - 2;
      const ly = below ? yLine + 12 : yLine - 5;
      ctx.fillStyle = lane;
      ctx.fillRect(lx - 2, ly - 9, tw + 4, 12);
      ctx.fillStyle = faint;
      ctx.fillText(text, lx, ly);
      lastLabelEnd = lx + tw;
      labelEnd.push(true);
    }

    // 右端收尾速度值：贴着右边界右对齐，避免被裁掉（末段已标过就不重复）
    const lastSeg = segments[segments.length - 1];
    if (lastSeg) {
      const text = String(lastSeg.tempo);
      const tw = ctx.measureText(text).width;
      const lx = width - tw - 6;
      const yLine = ty(lastSeg.tempo);
      const below = yLine + 13 <= laneY + TEMPO_LANE - 2;
      const already = labelEnd[segments.length - 1];
      if (!already && lx > lastLabelEnd + 8 && lx >= gutter) {
        const ly = below ? yLine + 12 : yLine - 5;
        ctx.fillStyle = lane;
        ctx.fillRect(lx - 2, ly - 9, tw + 4, 12);
        ctx.fillStyle = faint;
        ctx.fillText(text, lx, ly);
      }
    }

    // tick 轴
    const axisY = laneY + TEMPO_LANE;
    ctx.fillStyle = line;
    ctx.fillRect(0, axisY, width, 1);
    const labelStep = labelStepFor(beatPx);
    for (let t = Math.ceil(viewStart / labelStep) * labelStep; t <= viewEnd; t += labelStep) {
      const x = xOf(t);
      ctx.fillStyle = line;
      ctx.fillRect(Math.round(x), axisY, 1, 4);
      const beat = t / ppq;
      const label = Number.isInteger(beat) ? String(beat) : String(Math.round(beat * 1000) / 1000);
      ctx.font = '10px ' + mono;
      if (x + ctx.measureText(label).width + 6 < width) {
        ctx.fillStyle = dim;
        ctx.fillText(label, x + 4, axisY + 15);
      }
    }
    ctx.fillStyle = faint;
    ctx.font = '9.5px ' + mono;
    ctx.textAlign = 'right';
    ctx.fillText('拍', gutter - 6, axisY + 14);
    ctx.textAlign = 'left';

    // 拖动框选
    if (state.drag && interactive) {
      const a = Math.max(gutter, Math.min(xOf(state.drag.start), xOf(state.drag.end)));
      const b = Math.min(width, Math.max(xOf(state.drag.start), xOf(state.drag.end)));
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(a, 0, Math.max(1, b - a), rollH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(a + 0.5, 0.5, Math.max(1, b - a - 1), rollH - 1);
    }

    return { pxPerTick, xOf, pitch, rowH, rollH, width, gutter, plotW };
  }

  /** 视图内按速度点的分段（含起点生效值），供阶梯线与段内标注使用。 */
  function tempoSegments(tempos, start, end) {
    const out = [];
    let cursor = start;
    let tempo = M.tempoAt(tempos, start);
    for (const t of tempos) {
      if (t.tick <= start) continue;
      if (t.tick >= end) break;
      out.push({ start: cursor, end: t.tick, tempo });
      cursor = t.tick;
      tempo = t.tempo;
    }
    out.push({ start: cursor, end, tempo });
    return out;
  }

  function labelStepFor(beatPx) {
    const ppq = state.song ? state.song.ppq : 480;
    if (beatPx >= 60) return ppq;
    if (beatPx >= 26) return ppq * 2;
    if (beatPx >= 12) return ppq * 4;
    return ppq * 8;
  }

  /* 源卷帘 */

  function drawSource() {
    if (!state.song) return;
    const total = Math.max(1, state.song.lengthTicks);
    clampView('src', total);
    const view = state.srcView;
    const hovered = state.hover && !state.hover.dragging && state.hover.key !== null && state.hover.key !== undefined
      ? noteAt(state.hover.tick, state.hover.key)
      : null;
    const notes = state.song.notes.map((note) => ({ ...note, selected: note === hovered }));

    // 同一区间在剪辑单里出现多次时，色带只画一次，序号并列，避免颜色叠成一片
    const order = [];
    const byKey = new Map();
    state.clips.forEach((clip, i) => {
      const key = clip.start + ':' + clip.end;
      if (!byKey.has(key)) {
        const entry = { start: clip.start, end: clip.end, labels: [], selected: false };
        byKey.set(key, entry);
        order.push(entry);
      }
      const entry = byKey.get(key);
      entry.labels.push(i + 1);
      if (i === state.selected) entry.selected = true;
    });
    const bands = order.map((entry) => ({
      start: entry.start,
      end: entry.end,
      selected: entry.selected,
      label: entry.labels.map((n) => '#' + n).join(' '),
    }));

    drawRoll($('sourceCanvas'), {
      notes,
      allNotes: notes,
      tempos: state.song.tempos,
      ppq: state.song.ppq,
      viewStart: view.start,
      viewEnd: view.end,
      bands,
      cutTicks: cutTicksForSource(),
      selectedBand: -1,
      allowBandLabels: true,
      interactive: true,
    });
    updatePanControl('src', total);
  }

  function cutTicksForSource() {
    const ticks = new Set();
    let offset = 0;
    for (const clip of state.clips) {
      ticks.add(clip.start);
      ticks.add(clip.end);
    }
    return [...ticks].sort((a, b) => a - b);
  }

  /* 输出卷帘 */

  function drawOutput() {
    if (!state.arr) {
      const canvas = $('outCanvas');
      const width = Math.max(1, canvas.parentElement.clientWidth);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(96 * dpr);
      canvas.style.height = '96px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = cssColor('--roll');
      ctx.fillRect(0, 0, width, 96);
      ctx.fillStyle = cssColor('--faint');
      ctx.font = '12px ' + getComputedStyle(document.documentElement).getPropertyValue('--font-sans');
      ctx.textAlign = 'center';
      ctx.fillText(state.error ? '剪辑单需要先修正' : '还没有可输出的剪辑单', width / 2, 52);
      ctx.textAlign = 'left';
      $('outReadout').innerHTML = state.error
        ? '把剪辑单里标红的问题改好后，这里会重新画出输出卷帘。'
        : '还没有可输出的剪辑单。在卷帘上拖动截取，或载入样例剪辑单。';
      return;
    }
    const arr = state.arr;
    const total = Math.max(1, arr.totalTicks);
    const notes = [];
    arr.tracks.forEach((track, ti) => {
      for (const note of track) notes.push({ ...note, track: ti });
    });
    drawRoll($('outCanvas'), {
      notes,
      allNotes: notes,
      tempos: arr.tempoEvents,
      ppq: arr.ppq,
      viewStart: 0,
      viewEnd: total,
      totalTicks: total,
      bands: arr.manifest.clips.map((c) => ({
        start: c.outputTick,
        end: c.outputTick + c.ticks,
        label: '#' + c.index,
        selected: false,
      })),
      cutTicks: arr.manifest.clips.map((c) => c.outputTick).slice(1),
      allowBandLabels: true,
      interactive: false,
    });
    $('outReadout').innerHTML =
      `输出 <b>${total}</b> tick · <b>${fmtInt(arr.totalUs)}</b> µs <span class="accent">(${arr.totalExact} µs 精确值，向下取整)</span>` +
      ` · ${arr.manifest.clips.length} 段 · 竖虚线为片段边界`;
  }

  /* 视图 */

  function fitView(which) {
    if (which === 'out') return;
    const total = Math.max(1, state.song ? state.song.lengthTicks : 1);
    state.srcView.start = 0;
    state.srcView.end = total;
  }

  function clampView(which, total) {
    const view = state.srcView;
    let span = view.end - view.start;
    if (!(span > 0)) span = total;
    const minSpan = Math.max(1, Math.round(total / 400));
    if (span < minSpan) span = minSpan;
    if (span > total) span = total;
    let start = Math.min(Math.max(0, view.start), Math.max(0, total - span));
    view.start = start;
    view.end = start + span;
  }

  function updatePanControl(which, total) {
    const view = state.srcView;
    if (which === 'src') {
      $('viewFrom').textContent = Math.round(view.start);
      $('viewTo').textContent = Math.round(view.end);
      const ppq = state.song.ppq;
      const px = $('panRange');
      px.max = String(Math.max(0, Math.round(total - (view.end - view.start))));
      px.value = String(Math.round(view.start));
      px.disabled = total <= view.end - view.start;
      const plotW = Math.max(1, (($('sourceCanvas').getBoundingClientRect().width) || 1) - GUTTER);
      $('zoomLabel').textContent = (plotW / (view.end - view.start)).toFixed(2) + ' px/tick · 每拍 ' + (plotW / (view.end - view.start) * ppq).toFixed(0) + ' px';
    }
  }

  function zoomSource(factor, anchorTick) {
    const total = Math.max(1, state.song.lengthTicks);
    const view = state.srcView;
    const span = view.end - view.start;
    const minSpan = Math.max(1, Math.round(total / 400));
    const nextSpan = Math.max(minSpan, Math.min(total, Math.round(span / factor)));
    const anchor = anchorTick === undefined ? (view.start + view.end) / 2 : anchorTick;
    const ratio = (anchor - view.start) / Math.max(1, span);
    const start = Math.max(0, Math.min(total - nextSpan, anchor - ratio * nextSpan));
    view.start = Math.round(start);
    view.end = view.start + nextSpan;
    drawSource();
    updatePanControl('src', total);
  }

  function panSourceTo(tick) {
    const total = Math.max(1, state.song.lengthTicks);
    const span = state.srcView.end - state.srcView.start;
    state.srcView.start = Math.max(0, Math.min(total - span, tick));
    state.srcView.end = state.srcView.start + span;
    drawSource();
  }

  /* ------------------------------------------------------------------ *
   * 源卷帘交互
   * ------------------------------------------------------------------ */

  function eventTick(ev) {
    const canvas = $('sourceCanvas');
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - GUTTER);
    const x = Math.max(0, Math.min(plotW, ev.clientX - rect.left - GUTTER));
    const view = state.srcView;
    return Math.round(view.start + (x / plotW) * (view.end - view.start));
  }

  function eventPitch(ev) {
    const canvas = $('sourceCanvas');
    const rect = canvas.getBoundingClientRect();
    const pitch = pitchWindow(state.song.notes);
    const { rows, rowH, rollH } = rollMetrics(pitch);
    const y = ev.clientY - rect.top;
    if (y < 0 || y >= rollH) return null;
    const index = Math.min(rows - 1, Math.max(0, Math.floor(y / rowH)));
    return pitch.hi - index;
  }

  function noteAt(tick, key) {
    const song = state.song;
    let best = null;
    for (const note of song.notes) {
      if (note.key !== key) continue;
      if (tick < note.start || tick >= note.end) continue;
      if (!best || note.end - note.start < best.end - best.start) best = note;
    }
    return best;
  }

  $('sourceCanvas').addEventListener('pointerdown', (ev) => {
    if (!state.song) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    $('sourceCanvas').setPointerCapture(ev.pointerId);
    const tick = eventTick(ev);
    state.drag = { start: tick, end: tick, moved: false, pointerId: ev.pointerId };
  });

  $('sourceCanvas').addEventListener('pointermove', (ev) => {
    if (!state.song) return;
    const tick = eventTick(ev);
    const key = eventPitch(ev);
    if (state.drag && state.drag.pointerId === ev.pointerId) {
      state.drag.end = tick;
      state.drag.moved = Math.abs(state.drag.end - state.drag.start) >= 1;
      state.hover = { tick, key, dragging: state.drag };
      drawSource();
    } else {
      state.hover = { tick, key, dragging: null };
      updateSourceReadout(tick, key);
      drawSource();
      return;
    }
    updateSourceReadout(tick, key);
  });

  function finishDrag(ev) {
    if (!state.drag || !state.song) return;
    const drag = state.drag;
    if (drag.pointerId !== undefined && ev.pointerId !== undefined && drag.pointerId !== ev.pointerId) return;
    state.drag = null;
    const start = Math.max(0, Math.min(drag.start, drag.end));
    const end = Math.max(drag.start, drag.end);
    if (drag.moved && end > start) {
      state.clips.push({ start, end });
      state.selected = state.clips.length - 1;
      recompute();
    } else {
      // 单击选中该处片段，或在空白处取消选择
      const hit = state.clips.findIndex((c) => start >= c.start && start < c.end);
      state.selected = hit;
      renderClipTable();
      drawSource();
      drawOutput();
    }
    state.hover = null;
  }

  $('sourceCanvas').addEventListener('pointerup', finishDrag);
  $('sourceCanvas').addEventListener('pointercancel', () => {
    state.drag = null;
    drawSource();
  });

  $('sourceCanvas').addEventListener('pointerleave', () => {
    if (state.drag) return;
    state.hover = null;
    drawSource();
    $('sourceReadout').textContent = '把指针移到卷帘上查看 tick、拍位、速度与累计微秒。';
  });

  $('sourceCanvas').addEventListener('wheel', (ev) => {
    if (!state.song) return;
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const tick = eventTick(ev);
      zoomSource(ev.deltaY < 0 ? 1.25 : 0.8, tick);
    } else {
      const dx = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      const span = state.srcView.end - state.srcView.start;
      const plotW = Math.max(1, $('sourceCanvas').getBoundingClientRect().width - GUTTER);
      panSourceTo(state.srcView.start + (dx / plotW) * span);
    }
  }, { passive: false });

  function updateSourceReadout(tick, key) {
    const song = state.song;
    const tempo = M.tempoAt(song.tempos, tick);
    const time = M.timeAt(song.tempos, song.ppq, tick);
    const parts = [
      `tick <b>${tick}</b>`,
      `第 <b>${beatLabel(tick, song.ppq)}</b> 拍`,
      `生效 tempo <b>${tempo}</b> µs/♩`,
      `累计 <b>${fmtInt(time.us)}</b> µs`,
      `<span class="accent">${time.exact}</span>`,
    ];
    const note = key === null || key === undefined ? null : noteAt(tick, key);
    if (note) {
      parts.push(
        `<b>${pitchName(note.key)}</b> · 轨 ${note.track + 1} · 通道 ${note.channel + 1} · 力度 ${note.vel} · ` +
        `源 [${note.start}, ${note.end})`
      );
    }
    if (state.drag) {
      const a = Math.min(state.drag.start, state.drag.end);
      const b = Math.max(state.drag.start, state.drag.end);
      parts.push(`框选 <b>[${a}, ${b})</b> · ${b - a} tick`);
    }
    $('sourceReadout').innerHTML = parts.join(' · ');
  }

  /* ------------------------------------------------------------------ *
   * 工具栏
   * ------------------------------------------------------------------ */

  $('zoomIn').addEventListener('click', () => zoomSource(1.5));
  $('zoomOut').addEventListener('click', () => zoomSource(1 / 1.5));
  $('zoomFit').addEventListener('click', () => { fitView('src'); drawSource(); });
  $('panRange').addEventListener('input', () => panSourceTo(Number($('panRange').value)));

  /* ------------------------------------------------------------------ *
   * 剪辑单按钮
   * ------------------------------------------------------------------ */

  function defaultClip() {
    if (state.clips.length) {
      const last = state.clips[state.clips.length - 1];
      const length = last.end - last.start;
      const total = Math.max(1, state.song.lengthTicks);
      const start = Math.min(last.start, Math.max(0, total - length));
      return { start, end: Math.min(total, start + length) || start + length };
    }
    const total = Math.max(1, state.song.lengthTicks);
    const end = Math.min(total, state.song.ppq * 4);
    return { start: 0, end: Math.max(1, end) };
  }

  $('addClip').addEventListener('click', () => {
    if (!state.song) return;
    state.clips.push(defaultClip());
    state.selected = state.clips.length - 1;
    recompute();
  });

  $('dupLast').addEventListener('click', () => {
    if (!state.clips.length) return;
    state.clips.push({ ...state.clips[state.clips.length - 1] });
    state.selected = state.clips.length - 1;
    recompute();
  });

  $('clearClips').addEventListener('click', () => {
    state.clips = [];
    state.selected = -1;
    recompute();
    $('loadMsg').innerHTML =
      `<b>${escapeHtml(state.songName)}</b> 已载入，剪辑单已清空。在源卷帘上拖动截取，或用「添加片段」从头开始。`;
  });

  /* ------------------------------------------------------------------ *
   * 载入入口
   * ------------------------------------------------------------------ */

  $('pickMidi').addEventListener('click', () => $('midiInput').click());
  $('pickReel').addEventListener('click', () => $('reelInput').click());
  $('midiInput').addEventListener('change', (ev) => {
    if (ev.target.files[0]) openMidiFile(ev.target.files[0]);
    ev.target.value = '';
  });
  $('reelInput').addEventListener('change', (ev) => {
    if (ev.target.files[0]) openReelFile(ev.target.files[0]);
    ev.target.value = '';
  });

  const dropzone = $('dropzone');
  dropzone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dropzone.classList.remove('over');
    const file = ev.dataTransfer.files[0];
    if (!file) return;
    if (/\.json$/i.test(file.name)) openReelFile(file);
    else openMidiFile(file);
  });

  // 整页都能接收拖放
  window.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();
    dropzone.classList.add('over');
  });
  window.addEventListener('dragleave', (ev) => {
    if (ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth - 1 || ev.clientY >= window.innerHeight - 1) {
      dropzone.classList.remove('over');
    }
  });
  window.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    dropzone.classList.remove('over');
    const file = ev.dataTransfer.files[0];
    if (/\.json$/i.test(file.name)) openReelFile(file);
    else openMidiFile(file);
  });

  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sample;
      loadSong(b64ToBytes(SAMPLES[key]), SAMPLE_NAMES[key]);
    });
  });

  $('sampleReel').addEventListener('click', () => {
    if (!state.song) {
      loadSong(b64ToBytes(SAMPLES.takes), SAMPLE_NAMES.takes);
    }
    const ok = applyReelJson(b64ToText(SAMPLES.reel));
    if (ok) {
      state.selected = 0;
      renderClipTable();
      drawSource();
      drawOutput();
      $('loadMsg').innerHTML = '<b>reel.json</b> 已载入：三段剪辑 [1, 9) · [8, 14) · [1, 9)。可在剪辑单里改 tick、换顺序或继续加段。';
    }
  });

  /* ------------------------------------------------------------------ *
   * 试听（输出时间线上的简单合成音）
   * ------------------------------------------------------------------ */

  let audioCtx = null;

  function stopPlayback() {
    if (state.play) {
      for (const node of state.play.nodes) {
        try { node.stop(); } catch (e) { /* 已停止 */ }
      }
      state.play = null;
    }
    $('stopBtn').disabled = true;
    $('playBtn').textContent = '试听';
  }

  $('playBtn').addEventListener('click', () => {
    if (!state.song) return;
    if (state.play) { stopPlayback(); return; }
    const usingOutput = Boolean(state.arr);
    const notes = [];
    if (usingOutput) {
      state.arr.tracks.forEach((track, ti) => {
        for (const note of track) notes.push({ ...note, track: ti });
      });
    } else {
      for (const note of state.song.notes) notes.push({ ...note });
    }
    if (!notes.length) {
      $('sourceReadout').textContent = '没有可试听的音符。';
      return;
    }
    const tempos = usingOutput ? state.arr.tempoEvents : state.song.tempos;
    const ppq = state.song.ppq;
    const totalTicks = usingOutput ? state.arr.totalTicks : state.song.lengthTicks;
    const lengthUs = M.timeAt(tempos, ppq, totalTicks).us;
    const capUs = Math.min(lengthUs, 30000000);
    const capNotes = 4000;
    const scheduled = notes.slice(0, capNotes).filter((n) => M.timeAt(tempos, ppq, n.start).us < capUs);

    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      $('sourceReadout').textContent = '这个环境不支持 Web Audio，无法试听。';
      return;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const startAt = audioCtx.currentTime + 0.08;
    const master = audioCtx.createGain();
    master.gain.value = 0.16;
    master.connect(audioCtx.destination);
    const nodes = [];
    for (const note of scheduled) {
      const t0 = M.timeAt(tempos, ppq, note.start).us / 1e6;
      const t1 = M.timeAt(tempos, ppq, note.end).us / 1e6;
      const freq = 440 * Math.pow(2, (note.key - 69) / 12);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const duration = Math.max(0.02, t1 - t0);
      const peak = Math.max(0.05, Math.min(1, note.vel / 127));
      gain.gain.setValueAtTime(0, startAt + t0);
      gain.gain.linearRampToValueAtTime(peak, startAt + t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.6), startAt + t0 + Math.min(0.12, duration));
      gain.gain.setValueAtTime(Math.max(0.001, peak * 0.6), startAt + t1);
      gain.gain.linearRampToValueAtTime(0, startAt + t1 + 0.03);
      osc.connect(gain);
      gain.connect(master);
      osc.start(startAt + t0);
      osc.stop(startAt + t1 + 0.05);
      nodes.push(osc);
    }
    state.play = { nodes, started: performance.now(), capUs, truncated: scheduled.length < notes.length };
    $('stopBtn').disabled = false;
    $('playBtn').textContent = '停止试听';
    const label = usingOutput ? '重排后的输出' : '源片段（尚未重排）';
    const limited = [];
    if (scheduled.length < notes.length) limited.push(`只取前 ${scheduled.length} 个音符`);
    if (lengthUs > capUs) limited.push('只播放前 30 秒');
    $('sourceReadout').innerHTML =
      `正在试听<b>${label}</b> · ${scheduled.length} 个音符 · ${fmtSeconds(Math.min(lengthUs, capUs))}` +
      (limited.length ? ` · ${limited.join('，')}` : '');
    window.setTimeout(() => {
      if (state.play && state.play.nodes === nodes) stopPlayback();
    }, capUs / 1000 + 400);
  });

  $('stopBtn').addEventListener('click', stopPlayback);

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function downloadBlob(blob, name) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function showExport(name, bytes, meta, text) {
    state.exportInfo = { name, bytes, text };
    $('exportBox').hidden = false;
    $('exportName').textContent = name;
    $('exportMeta').textContent = meta;
    $('exportPayload').value = text;
    $('copyNote').hidden = true;
    $('exportHint').textContent = '预览器内可能拦截下载，可直接复制 Base64 保存为文件。在本地 http 或 file:// 打开时下载正常。';
  }

  $('exportMidi').addEventListener('click', () => {
    if (!state.arr) return;
    const bytes = M.exportMidi(state.song, state.arr);
    const b64 = bytesToB64(bytes);
    const noteTracks = state.arr.tracks.filter((t, ti) => state.song.tracks[ti].notes.length > 0).length;
    const meta = `1 型 · ${1 + noteTracks} 轨 · PPQ ${state.arr.ppq} · ${state.arr.totalUs} µs · ${bytes.length} 字节`;
    const ok = downloadBlob(new Blob([bytes], { type: 'audio/midi' }), 'reel-output.mid');
    showExport('reel-output.mid', bytes, meta, b64);
    if (!ok) $('exportHint').textContent = '下载被浏览器或预览器拦截。复制下面的 Base64，保存为 reel-output.mid.b64 后可解码。';
    setStatus('ready', '已生成 1 型 MIDI', state.songName);
  });

  $('exportManifest').addEventListener('click', () => {
    if (!state.arr) return;
    const manifest = M.buildManifest(state.song, state.arr);
    const text = JSON.stringify(manifest, null, 2);
    const bytes = new TextEncoder().encode(text);
    const ok = downloadBlob(new Blob([text], { type: 'application/json' }), 'reel-manifest.json');
    showExport('reel-manifest.json', bytes, `${state.arr.manifest.clips.length} 段 · 累计 ${state.arr.manifest.totalUs} µs · 精确 ${state.arr.manifest.totalExact}`, text);
    if (!ok) $('exportHint').textContent = '下载被浏览器或预览器拦截。复制下面的 JSON 保存为文件即可。';
    setStatus('ready', '已生成剪辑清单', state.songName);
  });

  $('copyPayload').addEventListener('click', async () => {
    const value = $('exportPayload').value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      $('copyNote').hidden = false;
      window.setTimeout(() => { $('copyNote').hidden = true; }, 2500);
    } catch (e) {
      const ta = $('exportPayload');
      ta.focus();
      ta.select();
      $('copyNote').hidden = false;
      $('copyNote').textContent = '已选中，请按 Ctrl/⌘+C 复制';
      window.setTimeout(() => {
        $('copyNote').hidden = true;
        $('copyNote').textContent = '已复制';
      }, 4000);
    }
  });

  $('retryDownload').addEventListener('click', () => {
    if (!state.exportInfo) return;
    const isMidi = /\.mid$/.test(state.exportInfo.name);
    const blob = new Blob([state.exportInfo.bytes], { type: isMidi ? 'audio/midi' : 'application/json' });
    downloadBlob(blob, state.exportInfo.name);
  });

  /* ------------------------------------------------------------------ *
   * 尺寸变化
   * ------------------------------------------------------------------ */

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.song) {
        drawSource();
        drawOutput();
      }
    }, 120);
  });

  /* ------------------------------------------------------------------ *
   * 首屏：直接进入工作状态（载入 takes.mid 与包内剪辑单）
   * ------------------------------------------------------------------ */

  function boot() {
    try {
      loadSong(b64ToBytes(SAMPLES.takes), SAMPLE_NAMES.takes);
      applyReelJson(b64ToText(SAMPLES.reel));
      state.selected = 0;
      renderClipTable();
      drawSource();
      drawOutput();
      $('loadMsg').innerHTML =
        '<b>takes.mid</b> 与样例剪辑单 <b>reel.json</b> 已载入。三段剪辑按顺序拼接，共 22 tick；' +
        '可以拖动改 tick、换顺序，或在源卷帘上继续截取。';
    } catch (err) {
      setStatus('error', '样例载入失败', '');
      showLoadError('样例载入失败：' + err.message);
    }
  }

  boot();
})();
