// app.js — 扬声器单纯形声像校验网页主逻辑
(function () {
  const E = window.SimplexEngine;
  const W = window.SimplexWav;
  const $ = (id) => document.getElementById(id);

  const state = {
    scene: null,
    audio: null,           // { sampleRate, samples, nFrames }
    layout: null,
    view: null,
    frame: 0,
    lastFace: -1,
    gains: null,
    activeFaces: null,     // 全帧面片索引（懒计算）
    zeroFrames: null,
    fallbackFrames: null,
    playing: false,
    raf: null,
    audioCtx: null,
  };

  // ---------- 状态提示 ----------
  function setStatus(kind, msg) {
    const el = $('status');
    el.className = 'status ' + kind;
    el.textContent = msg;
  }

  // ---------- 文件导入 ----------
  async function handleFiles(fileList) {
    const files = [...fileList];
    try {
      let layoutFile = files.find((f) => /\.json$/i.test(f.name));
      let wavFile = files.find((f) => /\.wav$/i.test(f.name));
      const zipFile = files.find((f) => /\.zip$/i.test(f.name));

      if (zipFile) {
        const buf = await zipFile.arrayBuffer();
        const entries = await W.readZipEntries(buf);
        const lj = entries.get('layout.json');
        const wv = entries.get('source.wav');
        if (!lj || !wv) throw E.makeError('BAD_ZIP', '压缩包需包含 layout.json 与 source.wav');
        state.layout = JSON.parse(new TextDecoder().decode(lj));
        state.audio = W.parseMonoPcm16(wv.buffer.slice(wv.byteOffset, wv.byteOffset + wv.length));
      } else {
        if (!layoutFile || !wavFile) {
          throw E.makeError('BAD_INPUT', '请选择 .zip 压缩包，或同时选择 layout.json 与 source.wav');
        }
        state.layout = JSON.parse(await layoutFile.text());
        const wb = await wavFile.arrayBuffer();
        state.audio = W.parseMonoPcm16(wb);
      }
      buildAndRender();
    } catch (err) {
      setStatus('error', '导入失败：' + err.message);
    }
  }

  // ---------- 构建场景并渲染 ----------
  function buildAndRender() {
    try {
      const scene = E.buildScene(state.layout);
      // 末帧与音频对齐校验
      const lastPath = scene.path[scene.path.length - 1].frame;
      if (lastPath !== state.audio.nFrames - 1) {
        throw E.makeError('BAD_PATH',
          '轨迹末点 frame=' + lastPath + ' 与音频最后一帧 ' + (state.audio.nFrames - 1) + ' 不一致');
      }
      state.scene = scene;
      state.gains = new Float64Array(scene.n);
      state.frame = 0;
      state.lastFace = -1;
      state.activeFaces = null;
      if (state.view) state.view.setScene(scene);
      else state.view = new window.View3D($('view3d'), scene);
      state.view.onPick = handlePick;

      // 全帧诊断
      const diag = E.computeAll(scene, state.audio.nFrames);
      state.activeFaces = diag.activeFaces;
      state.zeroFrames = diag.zeroFrames;
      state.fallbackFrames = diag.fallbackFrames;

      $('frameSlider').max = state.audio.nFrames - 1;
      $('frameSlider').value = 0;
      state.frame = 0;
      updateFrame(0, true);
      renderSpeakerTable();
      renderPathTable();

      const warn = [];
      if (diag.zeroFrames.length) warn.push('零方向帧 ' + diag.zeroFrames.length + ' 个（已保留上次结果）');
      setStatus(warn.length ? 'warn' : 'ok',
        '已加载：' + scene.n + ' 只扬声器，' + scene.faces.length + ' 个三角面，' +
        state.audio.nFrames + ' 帧' + (warn.length ? '；' + warn.join('；') : '；几何校验通过'));
      $('exportBtn').disabled = false;
      $('playBtn').disabled = false;
    } catch (err) {
      setStatus('error', '场景构建失败：' + err.message);
      $('exportBtn').disabled = true;
      $('playBtn').disabled = true;
    }
  }

  // ---------- 单帧更新 ----------
  function updateFrame(frame, force) {
    if (!state.scene) return;
    frame = Math.max(0, Math.min(state.audio.nFrames - 1, Math.round(frame)));
    if (!force && frame === state.frame) return;
    state.frame = frame;
    const r = E.frameGains(state.scene, frame, state.gains, state.lastFace);
    let faceIndex = state.lastFace;
    if (r.zero) {
      faceIndex = state.lastFace;
    } else if (r.fallback) {
      faceIndex = state.lastFace;
    } else {
      state.lastFace = r.faceIndex;
      faceIndex = r.faceIndex;
    }
    const dir = E.frameDirection(state.scene, frame);
    state.view.setFrame({ faceIndex, sourceVec: dir.d, zero: r.zero });
    $('frameNum').textContent = frame;
    $('frameTime').textContent = (frame / 48000).toFixed(4) + ' s';
    $('dirVal').textContent = '(' + dir.d.map((x) => x.toFixed(4)).join(', ') + ')' +
      (r.zero ? '  ⚠ 零方向' : '');

    const f = faceIndex >= 0 ? state.scene.faces[faceIndex] : null;
    $('faceVal').textContent = f ? ('id {' + f.key.join(', ') + '}  三角面 #' + faceIndex) : '—';
    renderGains(faceIndex, r);
    // 滑块同步
    if ($('frameSlider').value !== String(frame)) $('frameSlider').value = frame;
  }

  // ---------- 增益表 ----------
  function renderGains(faceIndex, r) {
    const tbody = $('gainBody');
    const active = new Set();
    if (faceIndex >= 0) state.scene.faces[faceIndex].vSorted.forEach((vi) => active.add(vi));
    const rows = state.scene.ids.map((id, vi) => {
      const g = state.gains[vi];
      const cls = active.has(vi) ? ' class="active"' : '';
      const pct = Math.max(0, Math.min(1, Math.abs(g)));
      return '<tr' + cls + '><td class="num">' + id + '</td>' +
        '<td class="num">' + g.toFixed(6) + '</td>' +
        '<td class="bar"><div class="barfill" style="width:' + (pct * 100).toFixed(1) + '%"></div></td></tr>';
    });
    tbody.innerHTML = rows.join('');
  }

  // ---------- 扬声器表 ----------
  function renderSpeakerTable() {
    const s = state.scene;
    $('speakerBody').innerHTML = s.ids.map((id, vi) => {
      const c = s.coords[vi];
      return '<tr><td class="num">' + id + '</td><td class="num">' + c.join(', ') + '</td>' +
        '<td class="num">' + Math.hypot(...c).toFixed(4) + '</td></tr>';
    }).join('');
  }

  // ---------- 轨迹关键点表 ----------
  function renderPathTable() {
    $('pathBody').innerHTML = state.scene.path.map((p) =>
      '<tr><td class="num">' + p.frame + '</td><td class="num">(' + p.xyz.join(', ') + ')</td>' +
      '<td class="num">' + (p.frame / 48000).toFixed(4) + ' s</td></tr>').join('');
  }

  // ---------- 三维点查 ----------
  function handlePick(info) {
    if (info.type === 'face') {
      const f = state.scene.faces[info.faceIndex];
      setStatus('ok', '点选面片：扬声器 id {' + f.key.join(', ') + '}，三角面 #' + info.faceIndex);
      state.view.highlightFace = info.faceIndex;
      state.view.draw();
      // 在增益区高亮该面
      const active = new Set(f.vSorted);
      [...$('gainBody').rows].forEach((tr, vi) => {
        tr.classList.toggle('active', active.has(vi));
      });
    } else if (info.type === 'speaker') {
      const id = state.scene.ids[info.index];
      const c = state.scene.coords[info.index];
      setStatus('ok', '点选扬声器 id=' + id + '，坐标 (' + c.join(', ') + ')');
    }
  }

  // ---------- 播放（WebAudio 实时听感，可选）----------
  async function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    state.playing = true;
    $('playBtn').textContent = '停止';
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    const startAudioTime = ctx.currentTime + 0.05;
    const startFrame = state.frame;
    const perfNow = performance.now();
    const tick = () => {
      if (!state.playing) return;
      const elapsed = (performance.now() - perfNow) / 1000;
      const f = startFrame + Math.floor(elapsed * 48000);
      if (f >= state.audio.nFrames) { stopPlay(); updateFrame(state.audio.nFrames - 1); return; }
      updateFrame(f);
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
    // 播放当前帧之后的源声（单声道），便于对照
    const nLeft = state.audio.nFrames - startFrame;
    const buf = ctx.createBuffer(1, nLeft, 48000);
    buf.copyToChannel(state.audio.samples.subarray(startFrame), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(startAudioTime);
    state._srcNode = src;
  }
  function stopPlay() {
    state.playing = false;
    $('playBtn').textContent = '播放';
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state._srcNode) { try { state._srcNode.stop(); } catch (e) { /* 已停止 */ } state._srcNode = null; }
  }

  // ---------- 导出多声道 float32 WAV ----------
  async function exportWav() {
    if (!state.scene) return;
    const btn = $('exportBtn');
    btn.disabled = true;
    setStatus('ok', '正在混音导出…');
    await new Promise((r) => setTimeout(r, 10)); // 让状态先渲染
    try {
      const t0 = performance.now();
      const scene = state.scene;
      const N = state.audio.nFrames;
      const channels = scene.ids.map(() => new Float32Array(N));
      const gains = new Float64Array(scene.n);
      let lastFace = -1;
      for (let f = 0; f < N; f++) {
        const r = E.frameGains(scene, f, gains, lastFace);
        if (!r.zero && !r.fallback) lastFace = r.faceIndex;
        const s = state.audio.samples[f];
        for (let ch = 0; ch < scene.n; ch++) channels[ch][f] = s * gains[ch];
      }
      const blob = W.writeFloatWav(channels, 48000);
      const ms = (performance.now() - t0).toFixed(0);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'surround-' + scene.n + 'ch-float32.wav';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('ok', '导出完成：' + scene.n + ' 声道 float32 WAV，' +
        (blob.size / 1048576).toFixed(1) + ' MiB，混音耗时 ' + ms + ' ms');
    } catch (err) {
      setStatus('error', '导出失败：' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 事件绑定 ----------
  function init() {
    const drop = $('dropzone');
    const fileInput = $('fileInput');
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    ['dragover', 'dragenter'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

    $('frameSlider').addEventListener('input', (e) => updateFrame(e.target.value));
    $('playBtn').addEventListener('click', togglePlay);
    $('exportBtn').addEventListener('click', exportWav);
    window.addEventListener('resize', () => state.view && state.view.resize());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
