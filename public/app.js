/* app.js — 主线程 UI：文件导入、分析调度（Worker）、波形显示、预听、导出、项目存取。 */
'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  idle: '待分析', analyzing: '分析中', done: '已校准',
  manual: '手动锚点', insufficient: '证据不足', error: '错误',
};

const S = {
  ref: null,          // {name,size,hash,rate,channels,bits,duration,mono}
  tracks: [],         // 见 makeTrack
  selId: null,
  pending: null,      // 打开项目后待关联的文件 {ref, tracks:[]}
  range: null,        // 导出范围 {t0,t1}（参考时间）
  waveCache: null,    // {key, W, peaksRef, peaksTrk}
};

let trackSeq = 0;

function makeTrack(info) {
  return Object.assign({
    id: ++trackSeq,
    status: 'idle', message: '', progress: 0,
    a: null, b: null, anchors: null, coverageSec: 0, rmsMs: 0, meanScore: 0,
    manual: null, worker: null, gen: 0,
  }, info);
}

/* ---------- 工具 ---------- */

function fmtT(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)} s`;
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const info = WAV.decodeWav(buf); // 不满足格式/时长约束时抛错
  return {
    name: file.name, size: file.size, hash: fnv1a(new Uint8Array(buf)),
    rate: info.sampleRate, channels: info.channels, bits: info.bits,
    duration: info.duration, mono: info.mono,
  };
}

function banner(msg) {
  const el = $('banner');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false; el.textContent = msg;
}

function sel() { return S.tracks.find(t => t.id === S.selId) || null; }

/* ---------- 导入 ---------- */

$('btnImportRef').onclick = () => $('fileRef').click();
$('btnImportTracks').onclick = () => $('fileTracks').click();
$('btnSaveProj').onclick = saveProject;
$('btnOpenProj').onclick = () => $('fileProj').click();

$('fileRef').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const info = await decodeFile(f);
    const pend = S.pending && S.pending.ref && S.pending.ref.name === info.name ? S.pending.ref : null;
    if (pend) {
      S.pending.ref = null;
      if (pend.hash !== info.hash || pend.size !== info.size) {
        if (!confirm(`同名文件内容不同：${info.name}\n项目保存的校准结果可能不再有效，仍要作为参考使用吗？`)) {
          updatePendingBanner(); return;
        }
      }
    }
    S.ref = info;
    S.range = { t0: 0, t1: info.duration };
    // 仅重新分析尚无映射的轨道；项目恢复的映射（含手动锚点）保留，可逐轨“重新自动分析”
    for (const t of S.tracks) {
      if (t.a != null) continue;
      stopAnalysis(t); t.gen++;
      t.status = 'idle'; t.message = '';
      maybeAnalyze(t);
    }
    markBufDirty(); refreshAll(); updatePendingBanner();
  } catch (err) { alert('参考导入失败：' + err.message); }
};

$('fileTracks').onchange = async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  for (const f of files) {
    let info;
    try { info = await decodeFile(f); }
    catch (err) { alert(`「${f.name}」导入失败：${err.message}`); continue; }
    // 同名替换
    const old = S.tracks.find(t => t.name === info.name);
    if (old) { stopAnalysis(old); S.tracks.splice(S.tracks.indexOf(old), 1); }
    const tr = makeTrack(info);
    S.tracks.push(tr);
    // 项目待关联匹配
    let entry = null;
    if (S.pending) {
      const i = S.pending.tracks.findIndex(t => t.name === info.name);
      if (i >= 0) entry = S.pending.tracks.splice(i, 1)[0];
    }
    if (entry) {
      const same = entry.hash === info.hash && entry.size === info.size;
      const use = same || confirm(`同名文件内容不同：${info.name}\n仍要恢复该项目中保存的校准参数吗？`);
      if (!same && !use) banner(`「${info.name}」与项目记录内容不同，已按新文件处理。`);
      if (use) {
        tr.a = entry.a; tr.b = entry.b;
        tr.manual = entry.manual || null;
        tr.status = entry.mode === 'manual' ? 'manual' : 'done';
        tr.message = same ? '' : '注意：文件内容与项目记录不一致，映射可能失效。';
      }
    }
    if (tr.status === 'idle') maybeAnalyze(tr);
    if (!S.selId) S.selId = tr.id;
  }
  markBufDirty(); refreshAll(); updatePendingBanner();
};

/* ---------- 分析调度 ---------- */

function maybeAnalyze(tr) {
  if (!S.ref || tr.status === 'analyzing') return;
  tr.gen++;
  const gen = tr.gen;
  const refSnap = S.ref;
  tr.status = 'analyzing'; tr.progress = 0; tr.message = '';
  const w = new Worker('worker.js');
  tr.worker = w;
  w.postMessage({
    gen,
    ref: { mono: refSnap.mono, rate: refSnap.rate },
    track: { mono: tr.mono, rate: tr.rate },
  });
  w.onmessage = (e) => {
    // 旧任务（gen 过期或参考已更换）不得覆盖后续编辑
    if (tr.gen !== gen || S.ref !== refSnap) return;
    const d = e.data;
    if (d.type === 'progress') { tr.progress = d.pct; renderList(); return; }
    stopAnalysis(tr);
    if (d.type === 'error') {
      tr.status = 'error'; tr.message = d.message;
    } else if (d.result.ok) {
      const r = d.result;
      Object.assign(tr, {
        status: 'done', a: r.a, b: r.b, anchors: r.anchors,
        coverageSec: r.coverageSec, rmsMs: r.rmsMs, meanScore: r.meanScore,
      });
    } else {
      tr.status = 'insufficient'; tr.message = d.result.reason;
      tr.a = null; tr.b = null;
    }
    markBufDirty(); refreshAll();
  };
  w.onerror = (e) => {
    if (tr.gen !== gen) return;
    stopAnalysis(tr);
    tr.status = 'error'; tr.message = e.message || '分析失败';
    refreshAll();
  };
}

function stopAnalysis(tr) {
  if (tr.worker) { tr.worker.terminate(); tr.worker = null; } // 取消立即生效
}

function cancelAnalysis(tr) {
  tr.gen++;
  stopAnalysis(tr);
  tr.status = 'idle'; tr.message = '已取消';
  refreshAll();
}

/* ---------- 手动锚点 ---------- */

$('btnApplyManual').onclick = () => {
  const tr = sel();
  if (!tr) return;
  const t1 = parseFloat($('maT1').value), r1 = parseFloat($('maR1').value);
  const t2 = parseFloat($('maT2').value), r2 = parseFloat($('maR2').value);
  if (![t1, r1, t2, r2].every(Number.isFinite)) { alert('请填写两对完整的时间锚点。'); return; }
  if (Math.abs(t2 - t1) < 1) { alert('两个锚点的待校准轨时间至少相隔 1 秒。'); return; }
  const a = (r2 - r1) / (t2 - t1);
  const b = r1 - a * t1;
  if (!(a > 0.9 && a < 1.1)) { alert('由锚点算出的漂移异常（a=' + a.toFixed(5) + '），请检查输入。'); return; }
  tr.gen++;            // 使进行中的分析结果失效
  stopAnalysis(tr);
  tr.a = a; tr.b = b;
  tr.manual = { t1, r1, t2, r2 };
  tr.status = 'manual'; tr.message = '';
  markBufDirty(); refreshAll();
};

$('btnReanalyze').onclick = () => {
  const tr = sel();
  if (!tr) return;
  tr.manual = null;
  maybeAnalyze(tr);
  refreshAll();
};

$('btnCancel').onclick = () => { const tr = sel(); if (tr) cancelAnalysis(tr); };

/* ---------- 预听 ---------- */

let AC = null, playBuf = null, bufDirty = true;
let src = null, playing = false, playStartAt = 0, playOffset = 0, rafId = 0;

function markBufDirty() { bufDirty = true; }

function ensureCtx() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
}

function rebuildBuffer() {
  playBuf = null;
  const tr = sel();
  if (S.ref && tr && tr.a != null) {
    // 预听与导出共用同一映射渲染
    const { left, right } = DSP.renderRange(
      S.ref.mono, S.ref.rate, tr.mono, tr.rate, tr.a, tr.b, 0, S.ref.duration, 48000);
    playBuf = AC.createBuffer(2, left.length, 48000);
    playBuf.getChannelData(0).set(left);   // 左 = 参考
    playBuf.getChannelData(1).set(right);  // 右 = 待校准轨
  }
  bufDirty = false;
}

function currentPlayTime() {
  return playing ? Math.min(playOffset + AC.currentTime - playStartAt, S.ref ? S.ref.duration : 0) : playOffset;
}

function stopSrc(natural) {
  if (src) { const s = src; src = null; s.onended = null; try { s.stop(); } catch (_) {} }
  playing = false;
  cancelAnimationFrame(rafId);
}

function playFrom(t) {
  const tr = sel();
  if (!S.ref || !tr || tr.a == null) return;
  ensureCtx();
  if (bufDirty) rebuildBuffer();
  if (!playBuf) return;
  stopSrc();
  src = AC.createBufferSource();
  src.buffer = playBuf;
  src.connect(AC.destination);
  playOffset = Math.max(0, Math.min(t, S.ref.duration));
  playStartAt = AC.currentTime;
  src.onended = () => { if (src) { playOffset = 0; stopSrc(true); updateTransport(); drawWave(); } };
  src.start(0, playOffset);
  playing = true;
  updateTransport();
  rafLoop();
}

function rafLoop() {
  if (!playing) return;
  updateTransport();
  drawWave();
  rafId = requestAnimationFrame(rafLoop);
}

function updateTransport() {
  $('playTime').textContent = fmtT(currentPlayTime());
  $('btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 预听';
}

$('btnPlay').onclick = () => {
  if (playing) { playOffset = currentPlayTime(); stopSrc(); updateTransport(); drawWave(); }
  else playFrom(playOffset);
};

/* ---------- 导出 ---------- */

$('btnExport').onclick = () => {
  const tr = sel();
  if (!S.ref || !tr || tr.a == null) { alert('当前轨道没有可用的映射。'); return; }
  const t0 = parseFloat($('exStart').value), t1 = parseFloat($('exEnd').value);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0 || t1 > S.ref.duration + 1e-6) {
    alert(`导出范围无效（应在 0 ~ ${S.ref.duration.toFixed(2)} 秒之间）。`); return;
  }
  // 与预听同一映射渲染，缺失区补零
  const { left, right } = DSP.renderRange(
    S.ref.mono, S.ref.rate, tr.mono, tr.rate, tr.a, tr.b, t0, t1, 48000);
  const buf = WAV.encodeWav16Stereo(left, right, 48000);
  const blob = new Blob([buf], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aligned_${tr.name.replace(/\.wav$/i, '')}_${t0.toFixed(2)}-${t1.toFixed(2)}s.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------- 项目存取（JSON 不含音频） ---------- */

function saveProject() {
  if (!S.ref) { alert('请先导入参考录音。'); return; }
  const proj = {
    app: 'recorder-drift-align', version: 1, savedAt: new Date().toISOString(),
    reference: { name: S.ref.name, size: S.ref.size, hash: S.ref.hash, duration: S.ref.duration },
    tracks: S.tracks.filter(t => t.a != null).map(t => ({
      name: t.name, size: t.size, hash: t.hash, duration: t.duration,
      mode: t.status === 'manual' ? 'manual' : 'auto',
      a: t.a, b: t.b, manual: t.manual,
    })),
  };
  const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'drift-align-project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('fileProj').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let proj;
  try { proj = JSON.parse(await f.text()); }
  catch { alert('项目文件不是有效的 JSON。'); return; }
  if (proj.app !== 'recorder-drift-align') { alert('不是本应用保存的项目文件。'); return; }
  // 清空当前会话，等待重新关联音频文件
  for (const t of S.tracks) stopAnalysis(t);
  stopSrc();
  S.tracks = []; S.selId = null; S.ref = null; S.range = null;
  S.pending = { ref: proj.reference || null, tracks: proj.tracks || [] };
  markBufDirty(); refreshAll(); updatePendingBanner();
};

function updatePendingBanner() {
  if (!S.pending) return;
  const missing = [];
  if (S.pending.ref) missing.push('参考：' + S.pending.ref.name);
  for (const t of S.pending.tracks) missing.push('待校准：' + t.name);
  if (missing.length === 0) { S.pending = null; banner('项目已恢复完成。'); setTimeout(() => banner(''), 3000); }
  else banner('项目已载入。请重新导入以下音频文件以恢复校准（项目文件不含音频）：\n' + missing.join('\n'));
}

/* ---------- 界面渲染 ---------- */

function refreshAll() {
  renderRefInfo(); renderList(); refreshDetail(); drawWave();
}

function renderRefInfo() {
  $('refInfo').textContent = S.ref
    ? `参考：${S.ref.name}（${fmtT(S.ref.duration)} · ${S.ref.rate}Hz · ${S.ref.channels === 2 ? '双声道' : '单声道'} · ${S.ref.bits}bit）`
    : '尚未导入参考录音。';
}

function renderList() {
  const ul = $('trackList');
  ul.innerHTML = '';
  for (const t of S.tracks) {
    const li = document.createElement('li');
    li.className = 'track-item' + (t.id === S.selId ? ' sel' : '');
    li.dataset.id = t.id;
    const mapTxt = t.a != null
      ? `b=${t.b.toFixed(3)}s · ${((t.a - 1) * 1e6 >= 0 ? '+' : '')}${((t.a - 1) * 1e6).toFixed(1)}ppm`
      : '';
    const statusTxt = t.status === 'analyzing'
      ? `分析中 ${Math.round(t.progress * 100)}%` : STATUS_TEXT[t.status];
    li.innerHTML =
      `<div class="name"></div>` +
      `<div class="meta">${fmtT(t.duration)} · ${t.rate}Hz · ${t.channels === 2 ? '双声道' : '单声道'} · ${t.bits}bit</div>` +
      `<div class="row"><span class="badge ${t.status}">${statusTxt}</span><span class="meta">${mapTxt}</span></div>` +
      (t.message ? `<div class="meta">${t.message}</div>` : '') +
      `<div class="row"><span></span><span>` +
      (t.status === 'analyzing' ? `<button data-act="cancel">取消</button>` : '') +
      `<button data-act="remove">移除</button></span></div>`;
    li.querySelector('.name').textContent = t.name;
    ul.appendChild(li);
  }
}

$('trackList').onclick = (e) => {
  const li = e.target.closest('.track-item');
  if (!li) return;
  const tr = S.tracks.find(t => t.id === Number(li.dataset.id));
  if (!tr) return;
  const act = e.target.dataset && e.target.dataset.act;
  if (act === 'remove') {
    stopAnalysis(tr);
    S.tracks.splice(S.tracks.indexOf(tr), 1);
    if (S.selId === tr.id) { S.selId = S.tracks.length ? S.tracks[0].id : null; stopSrc(); playOffset = 0; }
    markBufDirty(); refreshAll(); updateTransport();
    return;
  }
  if (act === 'cancel') { cancelAnalysis(tr); return; }
  if (S.selId !== tr.id) {
    S.selId = tr.id;
    stopSrc(); playOffset = 0;
    markBufDirty(); refreshAll(); updateTransport();
  }
};

function refreshDetail() {
  const tr = sel();
  $('detail').hidden = !tr;
  $('noSel').hidden = !!tr;
  if (!tr) return;
  $('detailTitle').textContent = tr.name;
  if (tr.a != null) {
    const ppm = (tr.a - 1) * 1e6;
    $('mapInfo').innerHTML =
      `t_ref = ${tr.a.toFixed(8)} · t_track ${tr.b >= 0 ? '+' : '−'} ${Math.abs(tr.b).toFixed(4)} s<br>` +
      `b = <b>${tr.b.toFixed(4)} s</b>　漂移 = <span class="ppm">${ppm >= 0 ? '+' : ''}${ppm.toFixed(2)} ppm</span>`;
  } else {
    $('mapInfo').textContent = '暂无可用映射。';
  }
  const ev = $('evidence');
  if (tr.status === 'done') {
    ev.className = 'evidence';
    ev.textContent = `自动估计：共同覆盖 ${tr.coverageSec.toFixed(1)} s · 拟合残差 ${tr.rmsMs.toFixed(2)} ms · 平均相关 ${tr.meanScore.toFixed(2)}`;
  } else if (tr.status === 'manual') {
    ev.className = 'evidence';
    ev.textContent = '当前映射来自手动锚点。';
  } else if (tr.status === 'insufficient' || tr.status === 'error') {
    ev.className = 'evidence bad';
    ev.textContent = tr.message;
  } else if (tr.status === 'analyzing') {
    ev.className = 'evidence';
    ev.textContent = `分析中… ${Math.round(tr.progress * 100)}%（页面可继续操作）`;
  } else {
    ev.className = 'evidence';
    ev.textContent = tr.message || '';
  }
  // 手动锚点预填
  const m = tr.manual;
  if (m) {
    $('maT1').value = m.t1; $('maR1').value = m.r1;
    $('maT2').value = m.t2; $('maR2').value = m.r2;
  } else if (tr.a != null) {
    $('maT1').value = '0'; $('maR1').value = tr.b.toFixed(3);
    $('maT2').value = tr.duration.toFixed(3);
    $('maR2').value = (tr.a * tr.duration + tr.b).toFixed(3);
  }
  // 导出范围
  const r = S.range || { t0: 0, t1: S.ref ? S.ref.duration : 0 };
  $('exStart').value = r.t0.toFixed(3);
  $('exEnd').value = r.t1.toFixed(3);
  // 按钮状态
  const hasMap = tr.a != null;
  $('btnPlay').disabled = !hasMap;
  $('btnExport').disabled = !hasMap;
  $('btnCancel').hidden = tr.status !== 'analyzing';
  $('btnReanalyze').disabled = !S.ref;
}

/* ---------- 波形 ---------- */

const cvs = $('wave');
const ctx2d = cvs.getContext('2d');

function wavePeaks(W, dur) {
  const tr = sel();
  const key = [W, S.ref && S.ref.name, tr && tr.id, tr && tr.a, tr && tr.b].join('|');
  if (S.waveCache && S.waveCache.key === key) return S.waveCache;
  const peaksRef = new Float32Array(W);
  const peaksTrk = new Float32Array(W);
  if (S.ref) {
    const m = S.ref.mono, rate = S.ref.rate;
    for (let x = 0; x < W; x++) {
      const s0 = Math.floor(x / W * dur * rate);
      const s1 = Math.min(m.length, Math.ceil((x + 1) / W * dur * rate));
      let p = 0;
      for (let i = s0; i < s1; i++) { const v = Math.abs(m[i]); if (v > p) p = v; }
      peaksRef[x] = p;
    }
    if (tr && tr.a != null) {
      const tm = tr.mono, trate = tr.rate, a = tr.a, b = tr.b;
      for (let x = 0; x < W; x++) {
        const tt0 = (x / W * dur - b) / a, tt1 = ((x + 1) / W * dur - b) / a;
        const s0 = Math.max(0, Math.floor(tt0 * trate));
        const s1 = Math.min(tm.length, Math.ceil(tt1 * trate));
        let p = 0;
        for (let i = s0; i < s1; i++) { const v = Math.abs(tm[i]); if (v > p) p = v; }
        peaksTrk[x] = p;
      }
    }
  }
  S.waveCache = { key, peaksRef, peaksTrk };
  return S.waveCache;
}

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const W = cvs.clientWidth || 600, H = 340;
  if (cvs.width !== Math.round(W * dpr)) { cvs.width = Math.round(W * dpr); cvs.height = H * dpr; }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);
  if (!S.ref) return;
  const dur = S.ref.duration;
  const tr = sel();
  const { peaksRef, peaksTrk } = wavePeaks(W, dur);
  const topH = 130, botH = 130, topY = 10, botY = 170;
  // 导出选区
  if (S.range) {
    const x0 = S.range.t0 / dur * W, x1 = S.range.t1 / dur * W;
    ctx2d.fillStyle = 'rgba(79,156,249,0.10)';
    ctx2d.fillRect(x0, 0, x1 - x0, H - 24);
  }
  const drawPeaks = (peaks, y0, h, color) => {
    ctx2d.strokeStyle = color;
    ctx2d.beginPath();
    for (let x = 0; x < W; x++) {
      const p = peaks[x] * (h / 2 - 2);
      ctx2d.moveTo(x + 0.5, y0 + h / 2 - p);
      ctx2d.lineTo(x + 0.5, y0 + h / 2 + p);
    }
    ctx2d.stroke();
  };
  drawPeaks(peaksRef, topY, topH, '#4f9cf9');
  if (tr && tr.a != null) drawPeaks(peaksTrk, botY, botH, '#f0a24b');
  // 中线
  ctx2d.strokeStyle = '#2a2f3a';
  ctx2d.beginPath();
  ctx2d.moveTo(0, topY + topH + 8); ctx2d.lineTo(W, topY + topH + 8);
  ctx2d.stroke();
  // 时间刻度
  ctx2d.fillStyle = '#9aa3b2';
  ctx2d.font = '11px Consolas, monospace';
  ctx2d.textAlign = 'center';
  const step = dur > 120 ? 20 : dur > 60 ? 10 : 5;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = t / dur * W;
    ctx2d.fillText(fmtT(t).replace(' s', 's'), x, H - 8);
    ctx2d.fillRect(x, H - 22, 1, 5);
  }
  // 播放头
  const pt = currentPlayTime();
  if (pt > 0 || playing) {
    const x = pt / dur * W;
    ctx2d.strokeStyle = '#e6e8ec';
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H - 24); ctx2d.stroke();
  }
}

let dragX0 = null;
cvs.addEventListener('mousedown', (e) => { dragX0 = e.offsetX; });
cvs.addEventListener('mouseup', (e) => {
  if (dragX0 == null || !S.ref) return;
  const W = cvs.clientWidth, dur = S.ref.duration;
  const x0 = dragX0, x1 = e.offsetX;
  dragX0 = null;
  if (Math.abs(x1 - x0) < 4) {
    // 点击：跳转预听
    const t = Math.max(0, Math.min(x1 / W * dur, dur));
    const tr = sel();
    if (tr && tr.a != null) playFrom(t);
    else { playOffset = t; updateTransport(); drawWave(); }
  } else {
    // 拖动：选择导出范围
    const t0 = Math.max(0, Math.min(x0, x1) / W * dur);
    const t1 = Math.min(dur, Math.max(x0, x1) / W * dur);
    S.range = { t0, t1 };
    $('exStart').value = t0.toFixed(3);
    $('exEnd').value = t1.toFixed(3);
    drawWave();
  }
});

$('exStart').onchange = $('exEnd').onchange = () => {
  const t0 = parseFloat($('exStart').value), t1 = parseFloat($('exEnd').value);
  if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) { S.range = { t0, t1 }; drawWave(); }
};

window.addEventListener('resize', drawWave);

updateTransport();
