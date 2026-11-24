/* app.js — workbench UI glue. All DSP lives in dither-core.js. */
(function () {
  "use strict";
  const DC = window.DitherCore;
  const ZipImport = window.ZipImport;

  const MAX_SECONDS = 180;
  const RENDER_CHUNK = 262144; // samples per channel per macrotask

  const state = {
    fileName: null,
    wav: null,                 // parsed input {sampleRate, channels, frames, channelData}
    importedSettings: null,    // settings as imported (for "restore")
    settings: null,            // current editable {k, seeds, resets}
    outputs: null,             // Int16Array[] after render
    renderedSettings: null,    // settings snapshot used for current outputs
    detail: [],                // per-channel lazily-computed detail objects
    detailValidFor: [],        // settings snapshot per cached detail
    selection: null,           // [start, end) half-open, in frames
    audioCtx: null,
    currentSource: null,
    renderToken: 0,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    dropzone: $("dropzone"), fileInput: $("fileInput"), loadedName: $("loadedName"),
    fileMeta: $("fileMeta"), metaChannels: $("metaChannels"), metaRate: $("metaRate"),
    metaFrames: $("metaFrames"), metaDuration: $("metaDuration"),
    importAlert: $("importAlert"),
    kRange: $("kRange"), kNumber: $("kNumber"), hiHint: $("hiHint"),
    channelControls: $("channelControls"),
    renderBtn: $("renderBtn"), resetParamsBtn: $("resetParamsBtn"),
    progress: $("progress"), progressBar: $("progressBar"), renderStatus: $("renderStatus"),
    paramAlert: $("paramAlert"),
    canvas: $("waveform"),
    selStart: $("selStart"), selEnd: $("selEnd"),
    selAllBtn: $("selAllBtn"), selClearBtn: $("selClearBtn"), selInfo: $("selInfo"),
    playSelBtn: $("playSelBtn"), stopBtn: $("stopBtn"),
    exportSelBtn: $("exportSelBtn"), exportFullBtn: $("exportFullBtn"),
    inspectChannel: $("inspectChannel"), inspectFrame: $("inspectFrame"),
    inspectPrev: $("inspectPrev"), inspectNext: $("inspectNext"),
    inspectTable: $("inspectTable").querySelector("tbody"), resetHint: $("resetHint"),
  };

  function showAlert(el, msg) {
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.textContent = ""; el.hidden = true; }
  }

  function snapshot(s) {
    return JSON.parse(JSON.stringify({
      k: s.k,
      seeds: s.seeds.map((v) => v >>> 0),
      resets: s.resets.map((l) => l.slice().sort((a, b) => a - b)),
    }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ----------------------------- import ----------------------------- */

  function normalizeSettings(raw, channels) {
    const settings = {
      k: Number(raw.bits ?? raw.k),
      seeds: (raw.seeds || []).map((v) => Number(v) >>> 0),
      resets: Array.from({ length: channels }, (_, c) =>
        (raw.resets && raw.resets[c] ? raw.resets[c].map(Number) : [])),
    };
    while (settings.seeds.length < channels) {
      settings.seeds.push((settings.seeds.length + 1) * 1103515245 + 12345 >>> 0 || 1);
    }
    return settings;
  }

  async function handleFile(file) {
    showAlert(els.importAlert, null);
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      let wavBuffer = buf;
      let rawSettings = null;

      if (lower.endsWith(".zip")) {
        const entries = await ZipImport.readZip(buf);
        const settingsName = [...entries.keys()].find((n) =>
          n.split("/").pop().toLowerCase() === "settings.json");
        const wavName = [...entries.keys()].find((n) =>
          n.toLowerCase().endsWith(".wav"));
        if (!settingsName) throw new Error("ZIP 中未找到 settings.json");
        if (!wavName) throw new Error("ZIP 中未找到 WAV 文件");
        rawSettings = JSON.parse(new TextDecoder().decode(entries.get(settingsName)));
        wavBuffer = entries.get(wavName).buffer;
      } else if (lower.endsWith(".wav")) {
        // settings may be attached later; keep null
      } else {
        throw new Error("仅支持 .wav 或 .zip 文件");
      }

      const wav = DC.parseWav(wavBuffer);
      if (wav.sampleRate !== 48000) throw new Error("采样率必须为 48kHz");
      if (wav.frames / wav.sampleRate > MAX_SECONDS + 1e-9) {
        throw new Error("时长 " + (wav.frames / wav.sampleRate).toFixed(2) +
          " 秒，超过上限 " + MAX_SECONDS + " 秒");
      }

      if (!rawSettings) {
        rawSettings = {
          bits: 5,
          seeds: wav.channels === 1 ? [23] : [23, 91],
          resets: wav.channels === 1 ? [[]] : [[], []],
        };
      }
      const settings = normalizeSettings(rawSettings, wav.channels);
      const errors = DC.validateSettings(settings, wav.channels);
      if (errors.length) throw new Error("设置校验失败：\n" + errors.join("\n"));
      settings.resets.forEach((list) => list.sort((a, b) => a - b));

      // reset frames must lie inside the file
      settings.resets.forEach((list, c) => {
        list.forEach((f) => {
          if (f >= wav.frames) {
            throw new Error("声道 " + (c + 1) + " 的重置帧 " + f +
              " 超出文件长度（0–" + (wav.frames - 1) + "）");
          }
        });
      });

      stopPlayback();
      Object.assign(state, {
        fileName: file.name,
        wav,
        importedSettings: snapshot(settings),
        settings,
        outputs: null,
        renderedSettings: null,
        detail: new Array(wav.channels).fill(null),
        detailValidFor: new Array(wav.channels).fill(null),
        selection: null,
      });

      els.loadedName.textContent = file.name;
      els.fileMeta.hidden = false;
      els.metaChannels.textContent = wav.channels + " 声道";
      els.metaRate.textContent = wav.sampleRate + " Hz";
      els.metaFrames.textContent = wav.frames.toLocaleString() + " 帧";
      els.metaDuration.textContent = (wav.frames / wav.sampleRate).toFixed(3) + " 秒";

      buildChannelControls();
      syncControlsFromSettings();
      setPostImportUI();
      drawWaveform();
      updateSelectionUI();
      updateInspectorChannelOptions();
      clearInspector();
      setRenderStatus("已加载，点击「整轨渲染」开始", "");
    } catch (err) {
      showAlert(els.importAlert, err.message || String(err));
    }
  }

  /* --------------------------- param panel --------------------------- */

  function buildChannelControls() {
    const nch = state.wav.channels;
    const labels = nch === 1 ? ["单声道"] : ["左声道 (L)", "右声道 (R)"];
    els.channelControls.innerHTML = "";
    for (let c = 0; c < nch; c++) {
      const block = document.createElement("div");
      block.className = "channel-block";
      block.innerHTML =
        "<h3>" + labels[c] + "</h3>" +
        "<label>非零 32 位种子（1–4294967295）</label>" +
        '<input type="number" min="1" max="4294967295" step="1" data-role="seed" data-ch="' + c + '">' +
        "<label>重置帧（逗号分隔的帧号，可留空）</label>" +
        '<input type="text" data-role="resets" data-ch="' + c +
        '" placeholder="例如 4800, 9600" spellcheck="false">';
      els.channelControls.appendChild(block);
    }
    els.channelControls.querySelectorAll('input[data-role="seed"]').forEach((inp) => {
      inp.addEventListener("input", onParamEdit);
    });
    els.channelControls.querySelectorAll('input[data-role="resets"]').forEach((inp) => {
      inp.addEventListener("input", onParamEdit);
    });
  }

  function syncControlsFromSettings() {
    const s = state.settings;
    els.kRange.value = s.k;
    els.kNumber.value = s.k;
    els.hiHint.textContent = String(32768 - (1 << s.k));
    els.channelControls.querySelectorAll('[data-role="seed"]').forEach((inp) => {
      inp.value = s.seeds[Number(inp.dataset.ch)];
    });
    els.channelControls.querySelectorAll('[data-role="resets"]').forEach((inp) => {
      inp.value = (s.resets[Number(inp.dataset.ch)] || []).join(", ");
    });
  }

  function readControlsIntoSettings() {
    const s = state.settings;
    s.k = Number(els.kNumber.value);
    els.channelControls.querySelectorAll('[data-role="seed"]').forEach((inp) => {
      s.seeds[Number(inp.dataset.ch)] = Number(inp.value) >>> 0;
    });
    s.resets = s.resets.map((_, c) => {
      const inp = els.channelControls.querySelector(
        '[data-role="resets"][data-ch="' + c + '"]');
      const text = inp.value.trim();
      if (!text) return [];
      return text.split(/[,\s]+/).filter(Boolean).map(Number);
    });
  }

  function currentK() {
    const k = Number(els.kNumber.value);
    return Number.isInteger(k) ? Math.min(12, Math.max(2, k)) : 5;
  }

  function onParamEdit() {
    if (!state.wav) return;
    readControlsIntoSettings();
    els.hiHint.textContent = String(32768 - (1 << currentK()));
    markDirty();
  }

  function markDirty() {
    state.outputs = null;
    state.renderedSettings = null;
    state.detail = new Array(state.wav.channels).fill(null);
    state.detailValidFor = new Array(state.wav.channels).fill(null);
    els.renderBtn.disabled = false;
    setRenderStatus("参数已修改，需要重新渲染", "");
    els.exportFullBtn.disabled = true;
    els.exportSelBtn.disabled = true;
    els.playSelBtn.disabled = true;
    els.inspectPrev.disabled = true;
    els.inspectNext.disabled = true;
    clearInspector();
    drawWaveform();
  }

  function setPostImportUI() {
    els.renderBtn.disabled = false;
    els.resetParamsBtn.disabled = false;
    els.selAllBtn.disabled = false;
    els.selClearBtn.disabled = false;
    els.exportFullBtn.disabled = true;
    els.exportSelBtn.disabled = true;
    els.playSelBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.inspectPrev.disabled = true;
    els.inspectNext.disabled = true;
    els.selStart.max = String(state.wav.frames - 1);
    els.selEnd.max = String(state.wav.frames);
    els.inspectFrame.max = String(state.wav.frames - 1);
  }

  function setRenderStatus(msg, kind) {
    els.renderStatus.textContent = msg;
    els.renderStatus.className = "render-status" + (kind ? " " + kind : "");
  }

  /* ------------------------------ render ----------------------------- */

  async function renderAllChunked() {
    readControlsIntoSettings();
    const errors = DC.validateSettings(state.settings, state.wav.channels);
    if (errors.length) {
      showAlert(els.paramAlert, errors.join("\n"));
      return;
    }
    // normalize reset lists and range check
    state.settings.resets = state.settings.resets.map((list) =>
      [...new Set(list)].sort((a, b) => a - b));
    const rangeErr = [];
    state.settings.resets.forEach((list, c) => {
      list.forEach((f) => {
        if (!Number.isInteger(f) || f < 0 || f >= state.wav.frames) {
          rangeErr.push("声道 " + (c + 1) + " 重置帧 " + f +
            " 非法或越界（允许 0–" + (state.wav.frames - 1) + "）");
        }
      });
    });
    if (rangeErr.length) {
      showAlert(els.paramAlert, rangeErr.join("\n"));
      return;
    }
    showAlert(els.paramAlert, null);

    const token = ++state.renderToken;
    const settings = snapshot(state.settings);
    const nch = state.wav.channels;
    const frames = state.wav.frames;
    const outputs = [];
    els.progress.hidden = false;
    els.progressBar.style.width = "0%";
    els.renderBtn.disabled = true;
    setRenderStatus("渲染中…", "");
    const t0 = performance.now();

    try {
      for (let c = 0; c < nch; c++) {
        const out = new Int16Array(frames);
        const step = 1 << settings.k;
        const mask = step - 1;
        const lo = -32768;
        const hi = 32768 - step;
        let rng = settings.seeds[c] >>> 0;
        if (rng === 0) throw new Error("种子必须非零");
        let e = 0;
        const resets = settings.resets[c];
        let resetIdx = 0;

        for (let start = 0; start < frames; start += RENDER_CHUNK) {
          if (state.renderToken !== token) return; // superseded
          const end = Math.min(frames, start + RENDER_CHUNK);
          const src = state.wav.channelData[c];
          for (let i = start; i < end; i++) {
            while (resetIdx < resets.length && resets[resetIdx] < i) resetIdx++;
            if (resetIdx < resets.length && resets[resetIdx] === i) {
              rng = settings.seeds[c] >>> 0;
              e = 0;
              resetIdx++;
            }
            rng = DC.xorshift32(rng);
            const w1 = rng;
            rng = DC.xorshift32(rng);
            const w2 = rng;
            const d = (w1 & mask) - (w2 & mask);
            const v0 = src[i] + Math.floor((3 * e) / 4);
            const v = v0 + d;
            const q = DC.roundHalfEven(v, step);
            if (q < lo || q > hi) {
              out[i] = q < lo ? lo : hi;
              e = 0;
            } else {
              out[i] = q;
              e = v0 - q;
            }
          }
          const done = (c * frames + end) / (nch * frames);
          els.progressBar.style.width = (done * 100).toFixed(1) + "%";
          await sleep(0);
        }
        outputs.push(out);
      }
      if (state.renderToken !== token) return;

      state.outputs = outputs;
      state.renderedSettings = settings;
      state.detail = new Array(nch).fill(null);
      state.detailValidFor = new Array(nch).fill(null);
      const ms = performance.now() - t0;
      setRenderStatus("渲染完成：" + ms.toFixed(0) + " ms（" +
        frames.toLocaleString() + " 帧 × " + nch + " 声道，k=" + settings.k + "）", "ok");
      els.exportFullBtn.disabled = false;
      els.exportSelBtn.disabled = !state.selection;
      els.playSelBtn.disabled = !state.selection;
      els.inspectPrev.disabled = false;
      els.inspectNext.disabled = false;
      els.renderBtn.disabled = false;
      drawWaveform();
      refreshInspectorIfReady();
    } catch (err) {
      if (state.renderToken === token) {
        setRenderStatus("渲染失败", "bad");
        showAlert(els.paramAlert, err.message || String(err));
        els.renderBtn.disabled = false;
      }
    } finally {
      if (state.renderToken === token) els.progress.hidden = true;
    }
  }

  /* ---------------------------- waveform ----------------------------- */

  function drawWaveform() {
    const canvas = els.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = 180;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW, H = cssH, mid = H / 2;
    ctx.clearRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach((g) => {
      ctx.beginPath();
      ctx.moveTo(0, H * g);
      ctx.lineTo(W, H * g);
      ctx.stroke();
    });

    const wav = state.wav;
    if (!wav) return;
    const frames = wav.frames;
    const scale = mid / 32768;
    const buckets = Math.max(1, Math.floor(W));
    const per = frames / buckets;

    const drawTrace = (channelData, color, alpha, lineW) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      for (let b = 0; b < buckets; b++) {
        const a = Math.floor(b * per);
        const z = Math.min(frames, Math.floor((b + 1) * per));
        let mn = 32767, mx = -32768;
        for (let i = a; i < z; i++) {
          const v = channelData[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const x = b + 0.5;
        ctx.moveTo(x, mid - mx * scale);
        ctx.lineTo(x, mid - mn * scale);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // mix channels for display
    const mix = (arrays) => {
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (const a of arrays) sum += a[i];
        out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / arrays.length)));
      }
      return out;
    };
    const COLOR_IN = "#6d7f96";
    const COLOR_OUT = "#5aa7ff";
    drawTrace(mix(wav.channelData), COLOR_IN, 0.55, 1);
    if (state.outputs) drawTrace(mix(state.outputs), COLOR_OUT, 0.95, 1.2);

    // selection overlay
    if (state.selection) {
      const [s, e] = state.selection;
      const x0 = (s / frames) * W;
      const x1 = (e / frames) * W;
      ctx.fillStyle = "rgba(240,180,85,0.28)";
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.strokeStyle = "rgba(240,180,85,0.8)";
      ctx.beginPath();
      ctx.moveTo(x0, 0); ctx.lineTo(x0, H);
      ctx.moveTo(x1, 0); ctx.lineTo(x1, H);
      ctx.stroke();
    }
  }

  function frameAtEvent(ev) {
    const rect = els.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    return Math.min(state.wav.frames - 1, Math.floor((x / rect.width) * state.wav.frames));
  }

  let drag = null;
  els.canvas.addEventListener("pointerdown", (ev) => {
    if (!state.wav) return;
    els.canvas.setPointerCapture(ev.pointerId);
    drag = { start: frameAtEvent(ev), current: null };
  });
  els.canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    drag.current = frameAtEvent(ev);
    const a = Math.min(drag.start, drag.current);
    const b = Math.max(drag.start, drag.current) + 1; // half-open
    state.selection = [a, b];
    updateSelectionUI();
    drawWaveform();
  });
  els.canvas.addEventListener("pointerup", () => {
    if (drag && drag.current === null) {
      // click without drag: single-frame selection
      state.selection = [drag.start, drag.start + 1];
      updateSelectionUI();
      drawWaveform();
    }
    drag = null;
    if (state.outputs) {
      els.exportSelBtn.disabled = !state.selection;
      els.playSelBtn.disabled = !state.selection;
    }
  });

  /* ---------------------------- selection ---------------------------- */

  function updateSelectionUI() {
    if (!state.wav) return;
    const sel = state.selection;
    els.selStart.value = sel ? sel[0] : 0;
    els.selEnd.value = sel ? sel[1] : 0;
    if (sel) {
      const len = sel[1] - sel[0];
      els.selInfo.textContent = "长度 " + len.toLocaleString() + " 帧 / " +
        (len / state.wav.sampleRate).toFixed(4) + " 秒 · 区间 [" + sel[0] + ", " + sel[1] + ")";
    } else {
      els.selInfo.textContent = "未选择";
    }
  }

  function commitSelectionFromInputs() {
    if (!state.wav) return;
    let a = Number(els.selStart.value);
    let b = Number(els.selEnd.value);
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      showAlert(els.paramAlert, "选区端点必须是整数帧");
      return;
    }
    a = Math.max(0, a);
    b = Math.min(state.wav.frames, b);
    if (a >= b) {
      showAlert(els.paramAlert, "半开选区要求起点 < 终点（区间 [起点, 终点)）");
      return;
    }
    showAlert(els.paramAlert, null);
    state.selection = [a, b];
    updateSelectionUI();
    drawWaveform();
    if (state.outputs) {
      els.exportSelBtn.disabled = false;
      els.playSelBtn.disabled = false;
    }
  }
  els.selStart.addEventListener("change", commitSelectionFromInputs);
  els.selEnd.addEventListener("change", commitSelectionFromInputs);
  els.selAllBtn.addEventListener("click", () => {
    if (!state.wav) return;
    state.selection = [0, state.wav.frames];
    updateSelectionUI();
    drawWaveform();
    if (state.outputs) {
      els.exportSelBtn.disabled = false;
      els.playSelBtn.disabled = false;
    }
  });
  els.selClearBtn.addEventListener("click", () => {
    state.selection = null;
    updateSelectionUI();
    drawWaveform();
    els.exportSelBtn.disabled = true;
    els.playSelBtn.disabled = true;
  });

  /* ------------------------- playback / export ------------------------ */

  function stopPlayback() {
    if (state.currentSource) {
      try { state.currentSource.onended = null; state.currentSource.stop(); }
      catch (_) { /* already stopped */ }
      state.currentSource = null;
    }
    if (state.audioCtx && state.audioCtx.state !== "closed") {
      state.audioCtx.close().catch(() => {});
    }
    state.audioCtx = null;
    els.stopBtn.disabled = true;
  }

  async function playSelection() {
    if (!state.outputs || !state.selection) return;
    stopPlayback();
    const [a, b] = state.selection;
    const nch = state.wav.channels;
    const len = b - a;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = ctx.createBuffer(nch, len, state.wav.sampleRate);
    for (let c = 0; c < nch; c++) {
      const dst = buffer.getChannelData(c);
      const src = state.outputs[c];
      for (let i = 0; i < len; i++) dst[i] = src[a + i] / 32768;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.onended = () => {
      if (state.currentSource === node) {
        state.currentSource = null;
        els.stopBtn.disabled = true;
      }
    };
    state.audioCtx = ctx;
    state.currentSource = node;
    els.stopBtn.disabled = false;
    await ctx.resume();
    node.start();
  }

  function downloadBuffer(buffer, name) {
    const blob = new Blob([buffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function baseExportName() {
    const stem = (state.fileName || "audio").replace(/\.(wav|zip)$/i, "");
    return stem + "_k" + state.renderedSettings.k;
  }

  function exportFull() {
    if (!state.outputs) return;
    const buffer = DC.encodeWav(state.wav.sampleRate, state.outputs);
    downloadBuffer(buffer, baseExportName() + "_full.wav");
  }

  function exportSelection() {
    if (!state.outputs || !state.selection) return;
    const [a, b] = state.selection;
    const sliced = state.outputs.map((ch) => ch.subarray(a, b));
    const buffer = DC.encodeWav(state.wav.sampleRate, sliced);
    downloadBuffer(buffer, baseExportName() + "_" + a + "-" + b + ".wav");
  }

  /* ----------------------------- inspector ---------------------------- */

  function updateInspectorChannelOptions() {
    const nch = state.wav ? state.wav.channels : 0;
    const labels = nch === 1 ? ["单声道"] : ["左声道 (L)", "右声道 (R)"];
    els.inspectChannel.innerHTML = "";
    for (let c = 0; c < nch; c++) {
      const opt = document.createElement("option");
      opt.value = String(c);
      opt.textContent = labels[c];
      els.inspectChannel.appendChild(opt);
    }
  }

  function ensureDetail(channel) {
    if (!state.outputs) return null;
    const snap = state.renderedSettings;
    if (state.detail[channel] &&
        JSON.stringify(state.detailValidFor[channel]) === JSON.stringify(snap)) {
      return state.detail[channel];
    }
    const detail = {};
    DC.processChannel(state.wav.channelData[channel],
      snap.seeds[channel] >>> 0, snap.resets[channel] || [], snap.k, detail);
    state.detail[channel] = detail;
    state.detailValidFor[channel] = snapshot(snap);
    return detail;
  }

  function clearInspector() {
    els.inspectTable.innerHTML =
      '<tr><td colspan="2" style="color:var(--muted)">渲染后选择帧号查看逐样本数据</td></tr>';
    els.resetHint.textContent = "";
  }

  function refreshInspectorIfReady() {
    if (!state.outputs) { clearInspector(); return; }
    showInspector();
  }

  function showInspector() {
    if (!state.outputs || !state.wav) return;
    const c = Number(els.inspectChannel.value || 0);
    let frame = Number(els.inspectFrame.value || 0);
    frame = Math.max(0, Math.min(state.wav.frames - 1, frame));
    els.inspectFrame.value = frame;
    const d = ensureDetail(c);
    const x = state.wav.channelData[c][frame];
    const y = state.outputs[c][frame];
    const isReset = (state.renderedSettings.resets[c] || []).includes(frame);
    const rows = [
      ["帧号 n", frame, ""],
      ["输入样本 x", x, ""],
      ["随机字 w1（uint32）", d.w1[frame], "0x" + d.w1[frame].toString(16).padStart(8, "0")],
      ["随机字 w2（uint32）", d.w2[frame], "0x" + d.w2[frame].toString(16).padStart(8, "0")],
      ["随机差 d = (w1 mod 2^k) − (w2 mod 2^k)", d.d[frame], "低 " + state.renderedSettings.k + " 位之差"],
      ["反馈误差输入 e", d.eIn[frame], ""],
      ["加抖动前 v0 = x + ⌊3e/4⌋", d.v0[frame], ""],
      ["加抖动后 v = v0 + d", d.v[frame], ""],
      ["就近偶档量化 q", d.q[frame], "步长 2^" + state.renderedSettings.k + " = " + (1 << state.renderedSettings.k)],
      ["输出 y（写入 WAV）", y, d.clamped[frame] ? "已夹位" : ""],
      ["反馈误差输出 e′", d.eOut[frame], d.clamped[frame] ? "夹位清零" : "v0 − q"],
    ];
    els.inspectTable.innerHTML = rows.map(([label, val, note]) => {
      const field = label.split(" ")[0].replace(/[′']/g, "p");
      const cls = (label.startsWith("输出") && d.clamped[frame]) ? "num clamp-yes" : "num";
      return '<tr><td data-label>' + label + (note ? ' <span style="color:var(--muted)">(' + note + ")</span>" : "") +
        '</td><td class="' + cls + '" data-field="' + field + '">' + val + "</td></tr>";
    }).join("");
    els.resetHint.textContent = isReset
      ? "帧 " + frame + " 是该声道的重置帧：随机状态已恢复为种子，误差已清零。"
      : "";
    if (isReset) els.resetHint.className = "hint reset-yes";
  }

  els.inspectChannel.addEventListener("change", showInspector);
  els.inspectFrame.addEventListener("change", showInspector);
  els.inspectPrev.addEventListener("click", () => {
    els.inspectFrame.value = Math.max(0, Number(els.inspectFrame.value || 0) - 1);
    showInspector();
  });
  els.inspectNext.addEventListener("click", () => {
    els.inspectFrame.value = Math.min(state.wav.frames - 1,
      Number(els.inspectFrame.value || 0) + 1);
    showInspector();
  });

  /* ------------------------------ wiring ------------------------------ */

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", (ev) => {
    if (ev.target.files[0]) handleFile(ev.target.files[0]);
    ev.target.value = "";
  });
  ["dragenter", "dragover"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (ev) => {
      ev.preventDefault();
      els.dropzone.classList.add("drag");
    }));
  ["dragleave", "drop"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (ev) => {
      ev.preventDefault();
      els.dropzone.classList.remove("drag");
    }));
  els.dropzone.addEventListener("drop", (ev) => {
    const f = ev.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  els.kRange.addEventListener("input", () => {
    els.kNumber.value = els.kRange.value;
    onParamEdit();
  });
  els.kNumber.addEventListener("input", () => {
    els.kRange.value = els.kNumber.value;
    onParamEdit();
  });
  els.renderBtn.addEventListener("click", renderAllChunked);
  els.resetParamsBtn.addEventListener("click", () => {
    if (!state.importedSettings) return;
    state.settings = snapshot(state.importedSettings);
    syncControlsFromSettings();
    markDirty();
    showAlert(els.paramAlert, null);
  });
  els.playSelBtn.addEventListener("click", () => { playSelection().catch((err) =>
    showAlert(els.paramAlert, err.message || String(err))); });
  els.stopBtn.addEventListener("click", stopPlayback);
  els.exportFullBtn.addEventListener("click", exportFull);
  els.exportSelBtn.addEventListener("click", exportSelection);

  window.addEventListener("resize", () => { if (state.wav) drawWaveform(); });
})();
