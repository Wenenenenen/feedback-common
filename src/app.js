/* RPA1 归档抽查 — 界面逻辑
 * 依赖全局 RPA1（src/rpa1.js）与可选的 RPA_SAMPLES（samples.js）。
 */
(function () {
  'use strict';

  var R = window.RPA1;
  var FPB = R.FRAMES_PER_BLOCK;

  /* ---------------- DOM 助手 ---------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function fmtSeconds(frames, rate) {
    if (!rate) return '';
    var s = frames / rate;
    return s >= 60
      ? Math.floor(s / 60) + ':' + ('0' + (s % 60).toFixed(3)).slice(-6)
      : s.toFixed(3) + 's';
  }
  function hex(v) { return '0x' + ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* 图标（内联 SVG，随 currentColor 着色） */
  var ICONS = {
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></svg>'
  };
  function icon(name, cls) {
    var span = document.createElement('span');
    span.className = cls || '';
    span.innerHTML = ICONS[name] || '';
    var svg = span.firstChild;
    if (svg) { svg.style.display = 'block'; svg.style.width = '100%'; svg.style.height = '100%'; }
    return span;
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    archive: null,          // RPA1.parse 的结果
    bytes: null,            // 当前归档字节
    sourceName: 'archive',
    kind: 'rpa',            // 'rpa' | 'wav'
    wavMeta: null,          // 若来自 WAV，保留元信息
    selection: { start: 0, end: 0 },
    peaks: null,
    peaksReady: false,
    mapGeom: null,
    page: 0,
    pageSize: 50,
    filter: 'all',
    expanded: -1,
    playing: null,
    audioCtx: null,
    autoDownloaded: false
  };

  /* ---------------- 提示 ---------------- */
  function toast(message, kind, timeout) {
    var host = $('toasts');
    // 最多同时显示 3 条，避免连点操作时堆叠遮挡。
    while (host.children.length >= 3) host.removeChild(host.firstChild);
    var t = el('div', { class: 'toast ' + (kind || '') });
    if (kind) t.appendChild(icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'alert', 't-ico'));
    t.appendChild(el('span', { text: message }));
    host.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      t.style.transition = 'opacity .2s, transform .2s';
      setTimeout(function () { t.remove(); }, 220);
    }, timeout || 4200);
  }

  /* ---------------- 下载 ---------------- */
  function downloadBytes(bytes, filename, mime) {
    try {
      var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return true;
    } catch (err) {
      toast('无法触发下载：' + err.message, 'crit');
      return false;
    }
  }

  function baseName(name) {
    return (name || 'archive').replace(/\.[^.]+$/, '');
  }

  /* ---------------- 加载 ---------------- */
  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      handleUploadedBytes(bytes, file.name);
    };
    reader.onerror = function () { toast('读取文件失败。', 'crit'); };
    reader.readAsArrayBuffer(file);
  }

  function handleUploadedBytes(bytes, name) {
    // 先按 WAV 试解析，再按 RPA1。
    var isWav = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x46;
    var isRpa = bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x50 &&
      bytes[2] === 0x41 && bytes[3] === 0x31;
    if (isWav) {
      prepareWav(bytes, name);
    } else if (isRpa) {
      openArchive(bytes, name, 'rpa', null);
    } else {
      toast('无法识别的文件：既不是 WAV 也不是 RPA1 归档。', 'crit');
    }
  }

  /* ---------------- WAV 准备 ---------------- */
  var pendingWav = null;

  function prepareWav(bytes, name) {
    var parsed = R.parseWav(bytes);
    if (!parsed.ok) {
      toast('WAV 解析失败：' + parsed.error.message, 'crit', 7000);
      return;
    }
    pendingWav = { parsed: parsed, name: name };
    state.wavMeta = parsed;
    state.sourceName = name;
    state.kind = 'wav';

    var p = parsed;
    $('wav-info').hidden = false;
    $('wav-info-body').innerHTML = '';
    var rows = [
      ['采样率', fmtInt(p.sampleRate) + ' Hz'],
      ['声道', p.channels === 1 ? '单声道' : '双声道（立体声）'],
      ['位深', p.bitDepth + ' 位'],
      ['帧数', fmtInt(p.totalFrames)],
      ['时长', fmtTime(p.totalFrames / p.sampleRate)],
      ['源大小', fmtBytes(bytes.length)]
    ];
    rows.forEach(function (r) {
      $('wav-info-body').appendChild(el('div', { class: 'readout' }, [
        el('div', { class: 'k', text: r[0] }),
        el('div', { class: 'v', text: r[1] })
      ]));
    });
    var blocks = Math.ceil(p.totalFrames / FPB);
    $('wav-info-note').textContent = '将切成 ' + fmtInt(blocks) + ' 个 1024 帧块独立编码。';
    $('encode-btn').disabled = false;
    $('wav-info').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m > 0 ? m + ' 分 ' + s.toFixed(2) + ' 秒' : s.toFixed(2) + ' 秒';
  }

  /* ---------------- 编码 ---------------- */
  function runEncode() {
    if (!pendingWav) return;
    var p = pendingWav.parsed;
    var btn = $('encode-btn');
    btn.disabled = true;
    $('encode-bar').classList.add('on');
    $('encode-bar').setAttribute('aria-busy', 'true');
    var t0 = performance.now();
    state.autoDownloaded = false;

    var progEl = $('encode-progress-i');
    var metaEl = $('encode-meta');

    R.encodeAsync({
      sampleRate: p.sampleRate,
      channels: p.channels,
      bitDepth: p.bitDepth,
      channelsData: p.channelsData,
      chunk: 24,
      onProgress: function (done, total) {
        var pct = Math.round((done / total) * 100);
        progEl.style.width = pct + '%';
        metaEl.innerHTML = '';
        metaEl.appendChild(el('span', { text: '编码中 ' + done + ' / ' + total + ' 块' }));
        metaEl.appendChild(el('span', { text: pct + '%' }));
      }
    }).then(function (res) {
      $('encode-bar').classList.remove('on');
      $('encode-bar').removeAttribute('aria-busy');
      btn.disabled = false;
      if (!res.ok) {
        toast('编码失败：' + (res.error && res.error.message), 'crit', 7000);
        return;
      }
      var ms = performance.now() - t0;
      var outName = baseName(pendingWav.name) + '.rpa';
      // 立即触发下载，满足「可下载」时限；随后再渲染工作台。
      downloadBytes(res.bytes, outName, 'application/octet-stream');
      state.autoDownloaded = true;
      toast('已编码并下载 ' + outName + '（' + fmtBytes(res.bytes.length) + '，用时 ' + (ms / 1000).toFixed(2) + ' 秒）', 'ok', 8000);
      openArchive(res.bytes, outName, 'rpa', pendingWav.parsed, outName, ms);
    });
  }

  /* ---------------- 打开归档 ---------------- */
  function openArchive(bytes, name, kind, wavParsed, downloadName, encodeMs) {
    var arc = R.parse(bytes);
    if (!arc.ok) {
      // 头错误：保留已打开的归档，只提示错误。
      toast('无法打开：' + arc.error.message + '（已保留上一个归档）', 'crit', 8000);
      return;
    }
    stopPlayback();
    state.archive = arc;
    state.bytes = bytes;
    state.sourceName = name;
    state.kind = kind;
    state.wavMeta = wavParsed || null;
    state.selection = { start: 0, end: arc.header.totalFrames };
    state.page = 0;
    state.filter = 'all';
    state.expanded = -1;
    state.peaks = null;
    state.peaksReady = false;
    state.encodeMs = encodeMs || null;
    state.downloadName = downloadName || (kind === 'rpa' ? name : null);
    state.baseDownloadName = state.downloadName;
    state.originalBytes = bytes.slice();

    renderWorkspace();
    computePeaksAsync();
  }

  /* ---------------- 工作台渲染 ---------------- */
  function renderWorkspace() {
    var arc = state.archive;
    $('workspace').classList.add('live');
    $('workspace').hidden = false;

    // 文件行
    $('fname').textContent = state.sourceName;
    $('fkind').textContent = state.kind === 'wav' ? 'WAV 源' : 'RPA1 归档';
    var dl = $('download-archive');
    if (state.downloadName) {
      dl.hidden = false;
      dl.disabled = false;
    } else {
      dl.hidden = true;
    }

    // 摘要
    var h = arc.header;
    var summary = $('summary');
    summary.innerHTML = '';
    var cells = [
      ['采样率', fmtInt(h.sampleRate) + ' ', 'Hz'],
      ['声道', h.channels === 1 ? '单声道' : '双声道', ''],
      ['位深', h.bitDepth + ' ', '位'],
      ['总帧', fmtInt(h.totalFrames), ''],
      ['时长', (h.totalFrames / h.sampleRate).toFixed(3) + ' ', '秒'],
      ['块数', fmtInt(h.numBlocks), ''],
      ['归档大小', fmtBytes(state.bytes.length), '']
    ];
    if (state.encodeMs != null) cells.push(['编码用时', (state.encodeMs / 1000).toFixed(2) + ' ', '秒']);
    cells.forEach(function (c) {
      var v = el('div', { class: 'v' });
      v.appendChild(document.createTextNode(c[1]));
      if (c[2]) v.appendChild(el('small', { text: c[2] }));
      summary.appendChild(el('div', { class: 'readout' }, [
        el('div', { class: 'k', text: c[0] }), v
      ]));
    });

    // 健康 chips
    var chips = $('health');
    chips.innerHTML = '';
    var okCount = 0, crcCount = 0, idxCount = 0;
    for (var hi = 0; hi < arc.entries.length; hi++) {
      var hs = arc.entries[hi].status;
      if (hs === 'ok') okCount++;
      else if (hs === 'index') idxCount++;
      else crcCount++;
    }
    if (okCount) chips.appendChild(chip('ok', '完好块', okCount));
    if (crcCount) chips.appendChild(chip('crit', '损坏块', crcCount));
    if (idxCount) chips.appendChild(chip('index', '索引损坏', idxCount));

    // 全局提示
    var notices = $('notices');
    notices.innerHTML = '';
    var idxEntries = [];
    var badEntries = [];
    for (var q = 0; q < arc.entries.length; q++) {
      var s = arc.entries[q].status;
      if (s === 'index') idxEntries.push(arc.entries[q].index);
      else if (s === 'crc' || s === 'block') badEntries.push(arc.entries[q].index);
    }
    if (idxEntries.length) {
      notices.appendChild(notice('index', '索引损坏',
        '块目录有 ' + idxEntries.length + ' 个条目异常：条目 ' + summarizeList(idxEntries) +
        '。归档已保持打开，其余块仍可试听与导出；涉及这些条目的区间会被拒绝。'));
    }
    if (badEntries.length) {
      notices.appendChild(notice('crit', '块损坏',
        '校验失败：块 ' + summarizeList(badEntries) + '。已禁止导出跨越这些坏块的区间；坏块之外的区间仍可正常试听与导出。'));
    }
    if (!badEntries.length && !idxEntries.length) {
      notices.appendChild(notice('ok', '全部校验通过',
        '每个块的 CRC32 与块头均正常，可对任意区间试听与导出。'));
    }

    // 选择与播放
    $('sel-start').max = String(h.totalFrames);
    $('sel-end').max = String(h.totalFrames);
    $('sel-start').value = String(state.selection.start);
    $('sel-end').value = String(state.selection.end);
    setSelection(state.selection.start, state.selection.end, true);

    renderBlockMap();
    renderSelectionState();
    state.page = 0;
    renderTable();
    requestAnimationFrame(drawWaveform);
  }

  function chip(kind, label, n) {
    return el('span', { class: 'chip ' + kind }, [
      el('i', { class: 'dot' }),
      document.createTextNode(label + ' '),
      el('b', { text: fmtInt(n) })
    ]);
  }

  // 列出编号，过多时截断，便于在提示里直接点名条目 / 块号。
  function summarizeList(list, max) {
    max = max || 12;
    if (list.length <= max) return list.join('、');
    return list.slice(0, max).join('、') + ' 等 ' + list.length + ' 个';
  }

  function notice(kind, title, body) {
    var n = el('div', { class: 'notice ' + kind });
    n.appendChild(icon(kind === 'ok' ? 'check' : kind === 'index' ? 'info' : 'alert', 'n-ico'));
    n.appendChild(el('div', { class: 'n-body' }, [
      el('b', { text: title + '　' }),
      document.createTextNode(body)
    ]));
    return n;
  }

  /* ---------------- 选择 ---------------- */
  function setSelection(start, end, fromInput) {
    var total = state.archive.header.totalFrames;
    start = Math.max(0, Math.min(total, Math.round(start)));
    end = Math.max(0, Math.min(total, Math.round(end)));
    if (end < start) { var t = start; start = end; end = t; }
    state.selection.start = start;
    state.selection.end = end;
    if (!fromInput) {
      $('sel-start').value = String(start);
      $('sel-end').value = String(end);
    }
    updateSelectionLabels();
    renderSelectionState();
    drawWaveform();
    renderBlockMap();
    markSelectedRows();
  }

  function updateSelectionLabels() {
    var rate = state.archive.header.sampleRate;
    $('sel-start-hint').textContent = fmtSeconds(state.selection.start, rate);
    $('sel-end-hint').textContent = fmtSeconds(state.selection.end, rate);
    var len = state.selection.end - state.selection.start;
    $('sel-length').textContent = fmtInt(len) + ' 帧（' + fmtSeconds(len, rate) + '）';
  }

  // 选区是否跨越坏块；返回相交坏块编号数组。
  function badBlocksInRange(start, end) {
    if (end <= start) return [];
    var first = Math.floor(start / FPB);
    var last = Math.floor((end - 1) / FPB);
    var bad = [];
    for (var b = first; b <= last; b++) {
      var e = state.archive.entries[b];
      if (!e || e.status !== 'ok') bad.push(b);
    }
    return bad;
  }

  function renderSelectionState() {
    var host = $('sel-state');
    host.innerHTML = '';
    var bad = badBlocksInRange(state.selection.start, state.selection.end);
    if (state.selection.end <= state.selection.start) {
      host.appendChild(el('span', { class: 'cross', text: '区间为空。请设置结束帧大于起始帧。' }));
      $('play-btn').disabled = true;
      $('export-btn').disabled = true;
      return;
    }
    if (bad.length) {
      host.appendChild(el('span', { class: 'cross' }, [
        document.createTextNode('所选区间跨越损坏块 ' + bad.join('、') + '，已禁止试听与导出。请缩小到坏块之外。')
      ]));
      $('play-btn').disabled = true;
      $('export-btn').disabled = true;
      return;
    }
    $('play-btn').disabled = false;
    $('export-btn').disabled = false;
    var len = state.selection.end - state.selection.start;
    host.appendChild(el('span', {
      text: '区间可用：' + fmtInt(len) + ' 帧，始于 ' + fmtInt(state.selection.start) + ' 帧。'
    }));
  }

  /* ---------------- 块图 ---------------- */
  function renderBlockMap() {
    var canvas = $('map-canvas');
    var wrap = $('map-canvas-wrap');
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(wrap.clientWidth));
    var hgt = Math.max(1, Math.round(wrap.clientHeight));
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = hgt + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    var arc = state.archive;
    var n = arc.entries.length;
    var style = getComputedStyle(document.documentElement);
    var colOk = style.getPropertyValue('--ok').trim();
    var colCrit = style.getPropertyValue('--crit').trim();
    var colIndex = style.getPropertyValue('--index').trim();
    var colFaint = style.getPropertyValue('--faint').trim();
    var colAccent = style.getPropertyValue('--accent').trim();

    var barTop = 6, barH = hgt - 20;
    ctx.fillStyle = colFaint;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, barTop, w, barH);
    ctx.globalAlpha = 1;

    var bw = w / n;
    for (var i = 0; i < n; i++) {
      var s = arc.entries[i].status;
      var color = s === 'ok' ? colOk : s === 'index' ? colIndex : colCrit;
      ctx.fillStyle = color;
      if (s !== 'ok') ctx.globalAlpha = 0.9;
      var x = i * bw;
      var ww = Math.max(bw, 1);
      ctx.fillRect(x, barTop, ww, barH);
      ctx.globalAlpha = 1;
    }

    // 选区覆盖
    var total = arc.header.totalFrames;
    var sx = (state.selection.start / total) * w;
    var ex = (state.selection.end / total) * w;
    ctx.fillStyle = colAccent;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(sx, 0, Math.max(1, ex - sx), hgt);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colAccent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx + 0.75, 0.75, Math.max(1, ex - sx) - 1.5, hgt - 1.5);

    state.mapGeom = { w: w, n: n, total: total };
    $('map-hint-l').textContent = '帧 0';
    $('map-hint-r').textContent = '帧 ' + fmtInt(total) + '（共 ' + fmtInt(n) + ' 块）';
    wrap.setAttribute('aria-label', '块状态图，共 ' + n + ' 块，点击可定位');
  }

  function mapClick(ev) {
    if (!state.mapGeom) return;
    var rect = $('map-canvas-wrap').getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    var total = state.archive.header.totalFrames;
    var frame = Math.floor(frac * total);
    var b = Math.min(state.archive.entries.length - 1, Math.floor(frame / FPB));
    var e = state.archive.entries[b];
    var start = e.startFrame != null ? e.startFrame : b * FPB;
    var end = Math.min(total, start + FPB);
    setSelection(start, end);
    state.expanded = b;
    state.page = Math.floor(b / state.pageSize);
    state.filter = 'all';
    renderTable();
    toast('已定位到块 ' + b + '（帧 ' + start + '–' + end + '）');
  }

  /* ---------------- 表格 ---------------- */
  function statusMeta(entry) {
    switch (entry.status) {
      case 'ok': return { cls: 's-ok', label: '完好', color: 'ok' };
      case 'crc': return { cls: 's-crc', label: 'CRC 失败', color: 'crit' };
      case 'block': return { cls: 's-block', label: '块损坏', color: 'crit' };
      case 'index': return { cls: 's-index', label: '索引损坏', color: 'index' };
      default: return { cls: 's-crc', label: entry.status, color: 'crit' };
    }
  }

  function filteredEntries() {
    var all = state.archive.entries;
    if (state.filter === 'all') return all.slice();
    return all.filter(function (e) {
      if (state.filter === 'bad') return e.status !== 'ok';
      if (state.filter === 'ok') return e.status === 'ok';
      if (state.filter === 'index') return e.status === 'index';
      if (state.filter === 'crc') return e.status === 'crc' || e.status === 'block';
      return true;
    });
  }

  function renderTable() {
    var tbody = $('block-tbody');
    tbody.innerHTML = '';
    var rows = filteredEntries();
    var arc = state.archive;
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    var from = state.page * state.pageSize;
    var to = Math.min(total, from + state.pageSize);

    if (!total) {
      var tr = el('tr');
      tr.appendChild(el('td', { colspan: '8', class: 'empty-row', text: '没有符合筛选条件的块。' }));
      tr.style.cursor = 'default';
      tbody.appendChild(tr);
    }

    for (var i = from; i < to; i++) {
      var e = rows[i];
      var st = statusMeta(e);
      var info = e.headerInfo && e.headerInfo.ok ? e.headerInfo : null;
      var modeTxt = info ? (info.mode === 1 ? '中侧' : (arc.header.channels === 2 ? '原始 L/R' : '原始')) : '—';
      var lTxt = info ? '<b>' + info.orders[0] + '</b>阶 <b>' + info.ks[0] + '</b>' : '—';
      var rTxt = info && arc.header.channels === 2 ? '<b>' + info.orders[1] + '</b>阶 <b>' + info.ks[1] + '</b>' : (arc.header.channels === 1 ? '—' : '—');

      var tr = el('tr', { 'data-block': String(e.index) });
      if (e.index === state.expanded) tr.classList.add('sel');
      tr.appendChild(el('td', { class: 'num', text: String(e.index) }));
      tr.appendChild(el('td', { class: 'num', text: fmtInt(e.frames) }));
      tr.appendChild(el('td', { class: 'num', text: fmtInt(e.offset) }));
      tr.appendChild(el('td', { class: 'num', text: fmtInt(e.size) }));
      tr.appendChild(el('td', {}, [el('span', { class: 'mode-pill ' + (info && info.mode === 1 ? 'ms' : ''), text: modeTxt })]));
      var ltd = el('td', { class: 'par' }); ltd.innerHTML = lTxt; tr.appendChild(ltd);
      var rtd = el('td', { class: 'par' }); rtd.innerHTML = rTxt; tr.appendChild(rtd);
      tr.appendChild(el('td', {}, [
        el('span', { class: 'st ' + st.cls }, [el('i'), document.createTextNode(st.label)])
      ]));
      tr.addEventListener('click', onRowClick);
      tbody.appendChild(tr);

      if (e.index === state.expanded) {
        var detailTr = el('tr', { class: 'detail-row' });
        var td = el('td', { colspan: '8' });
        td.appendChild(buildDetail(e, st));
        detailTr.appendChild(td);
        detailTr.style.cursor = 'default';
        tbody.appendChild(detailTr);
      }
    }

    $('pager-info').textContent = total
      ? '第 ' + (from + 1) + '–' + to + ' 条，共 ' + fmtInt(total) + ' 条'
      : '共 0 条';
    $('prev-page').disabled = state.page <= 0;
    $('next-page').disabled = state.page >= pages - 1;
    $('page-label').textContent = (state.page + 1) + ' / ' + pages;
  }

  function buildDetail(e, st) {
    var card = el('div', { class: 'detail-card' });
    var info = e.headerInfo;
    var title = el('h4', { text: '块 ' + e.index + ' 详情' });
    card.appendChild(title);
    var dl = el('dl');
    function add(k, v, mono) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { class: mono === false ? '' : '', text: v }));
    }
    add('帧范围', fmtInt(e.startFrame) + ' – ' + fmtInt(e.endFrame) + '（' + fmtInt(e.frames) + ' 帧）');
    add('字节偏移', fmtInt(e.offset));
    add('块字节数', fmtInt(e.size));
    add('目录 CRC32', hex(e.crc));
    add('实际 CRC32', e.actualCrc == null ? '未能读取' : hex(e.actualCrc));
    if (info && info.ok) {
      add('模式', info.mode === 1 ? '1 · 中侧（mid/side）' : '0 · 原始' + (state.archive.header.channels === 2 ? ' L/R' : ''));
      add('第 1 路', '预测 ' + info.orders[0] + ' 阶 · Rice k=' + info.ks[0]);
      if (state.archive.header.channels === 2)
        add('第 2 路', '预测 ' + info.orders[1] + ' 阶 · Rice k=' + info.ks[1]);
    } else if (info && info.error) {
      add('块头', info.error);
    }
    card.appendChild(dl);
    if (e.error) card.appendChild(el('div', { class: 'err', text: e.error }));
    var bar = el('div', { class: 'quick', style: 'margin-top:11px' });
    var selBtn = el('button', { class: 'btn small', type: 'button', text: '选中此块试听' });
    selBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setSelection(e.startFrame, e.endFrame);
      $('sel-start').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    selBtn.disabled = e.status !== 'ok';
    bar.appendChild(selBtn);
    card.appendChild(bar);
    return card;
  }

  function onRowClick(ev) {
    var tr = ev.currentTarget;
    var idx = Number(tr.getAttribute('data-block'));
    state.expanded = state.expanded === idx ? -1 : idx;
    renderTable();
    markSelectedRows();
  }

  function markSelectedRows() {
    var rows = $('block-tbody').querySelectorAll('tr[data-block]');
    rows.forEach(function (tr) {
      tr.classList.remove('sel');
    });
    if (state.expanded >= 0) {
      var found = $('block-tbody').querySelector('tr[data-block="' + state.expanded + '"]');
      if (found) found.classList.add('sel');
    }
  }

  /* ---------------- 波形 ---------------- */
  function computePeaksAsync() {
    var arc = state.archive;
    var total = arc.header.totalFrames;
    var cols = Math.max(200, Math.min(1200, Math.round(($('wave-canvas').parentElement.clientWidth || 800))));
    var peaks = new Float32Array(cols * 2); // min,max per column
    var has = new Uint8Array(cols);
    var badCols = new Uint8Array(cols);
    state.peaks = { cols: cols, data: peaks, has: has, bad: badCols };
    state.peaksReady = false;
    $('wave-empty').textContent = '正在解码校验与绘制波形…';
    $('wave-empty').hidden = false;

    var n = arc.entries.length;
    var b = 0;
    var chunk = 120;
    var framesPerCol = total / cols;
    var scale = normScale();
    var chanCount = arc.header.channels;

    function step() {
      var end = Math.min(n, b + chunk);
      for (; b < end; b++) {
        var entry = arc.entries[b];
        if (entry.status !== 'ok') {
          // 标记该块覆盖的列
          var c0 = Math.floor(entry.startFrame / framesPerCol);
          var c1 = Math.min(cols - 1, Math.floor((entry.endFrame - 1) / framesPerCol));
          for (var bc = c0; bc <= c1; bc++) badCols[bc] = 1;
          continue;
        }
        var dec = R.decodeBlock(arc, b);
        if (!dec.ok) {
          var d0 = Math.floor(entry.startFrame / framesPerCol);
          var d1 = Math.min(cols - 1, Math.floor((entry.endFrame - 1) / framesPerCol));
          for (var dc = d0; dc <= d1; dc++) badCols[dc] = 1;
          continue;
        }
        var chans = dec.channels;
        var base = entry.startFrame;
        var ch0 = chans[0];
        var ch1 = chanCount === 2 ? chans[1] : null;
        for (var i = 0; i < entry.frames; i++) {
          var col = Math.floor((base + i) / framesPerCol);
          if (col >= cols) col = cols - 1;
          var v = ch0[i];
          var min = v, max = v;
          if (ch1) {
            var vv = ch1[i];
            if (vv < min) min = vv;
            if (vv > max) max = vv;
          }
          var lo = min / scale;
          var hi = max / scale;
          if (!has[col]) { peaks[col * 2] = lo; peaks[col * 2 + 1] = hi; has[col] = 1; }
          else {
            if (lo < peaks[col * 2]) peaks[col * 2] = lo;
            if (hi > peaks[col * 2 + 1]) peaks[col * 2 + 1] = hi;
          }
        }
      }
      if (b < n) {
        $('wave-empty').textContent = '正在解码校验 ' + Math.round((b / n) * 100) + '%';
        setTimeout(step, 0);
      } else {
        state.peaksReady = true;
        $('wave-empty').hidden = true;
        drawWaveform();
        renderSelectionState();
      }
    }
    setTimeout(step, 0);
  }

  function normScale() {
    return Math.pow(2, state.archive.header.bitDepth - 1);
  }

  function drawWaveform() {
    var canvas = $('wave-canvas');
    var wrap = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(wrap.clientWidth));
    var h = 108;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var style = getComputedStyle(document.documentElement);
    var colLine = style.getPropertyValue('--line').trim();
    var colAccent = style.getPropertyValue('--accent').trim();
    var colCrit = style.getPropertyValue('--crit').trim();
    var colFaint = style.getPropertyValue('--faint').trim();

    var mid = h / 2;
    ctx.strokeStyle = colLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    if (!state.peaks) return;
    var peaks = state.peaks;
    var cols = peaks.cols;
    var data = peaks.data, has = peaks.has, bad = peaks.bad;
    var total = state.archive.header.totalFrames;
    var selS = (state.selection.start / total) * w;
    var selE = (state.selection.end / total) * w;

    // 选区底色
    ctx.fillStyle = colAccent;
    ctx.globalAlpha = 0.09;
    ctx.fillRect(selS, 0, Math.max(1, selE - selS), h);
    ctx.globalAlpha = 1;

    var colW = w / cols;
    var amp = mid - 6;
    for (var c = 0; c < cols; c++) {
      var x = c * colW;
      if (bad[c]) {
        ctx.fillStyle = colCrit;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(x, 0, Math.max(1, colW), h);
        ctx.globalAlpha = 1;
        continue;
      }
      if (!has[c]) continue;
      var lo = data[c * 2], hi = data[c * 2 + 1];
      var y1 = mid - hi * amp;
      var y2 = mid - lo * amp;
      ctx.fillStyle = colAccent;
      ctx.fillRect(x, Math.min(y1, y2), Math.max(1, colW * 0.9), Math.max(1, Math.abs(y2 - y1)));
    }

    // 选区边界
    ctx.strokeStyle = colAccent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(selS + 0.5, 0); ctx.lineTo(selS + 0.5, h);
    ctx.moveTo(selE - 0.5, 0); ctx.lineTo(selE - 0.5, h);
    ctx.stroke();

    // 播放头
    if (state.playing && state.playHead != null) {
      var px = (state.playHead / total) * w;
      ctx.strokeStyle = colFaint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  /* ---------------- 播放 ---------------- */
  function ensureAudio() {
    if (!state.audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { toast('此浏览器不支持 Web Audio，无法试听。', 'crit'); return null; }
      state.audioCtx = new Ctx();
    }
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }

  function stopPlayback() {
    if (state.playing) {
      try { state.playing.stop(); } catch (e) { /* 已停止 */ }
      state.playing = null;
    }
    state.playHead = null;
    $('play-status').textContent = '';
    $('play-btn').innerHTML = '';
    $('play-btn').appendChild(icon('play', 'b-ico'));
    $('play-btn').appendChild(document.createTextNode('试听区间'));
    drawWaveform();
  }

  function playSelection() {
    if (state.playing) { stopPlayback(); return; }
    var sel = state.selection;
    if (sel.end <= sel.start) { toast('请先设置有效区间。', 'warn'); return; }
    var bad = badBlocksInRange(sel.start, sel.end);
    if (bad.length) {
      toast('区间跨越损坏块 ' + bad.join('、') + '，已禁止试听。', 'crit', 6000);
      return;
    }
    var dec = R.decodeRange(state.archive, sel.start, sel.end);
    if (!dec.ok) {
      toast(dec.error.message, 'crit', 6000);
      return;
    }
    var ctx = ensureAudio();
    if (!ctx) return;

    var h = state.archive.header;
    var len = sel.end - sel.start;
    var buffer = ctx.createBuffer(h.channels, len, h.sampleRate);
    var scale = 1 / normScale();
    for (var c = 0; c < h.channels; c++) {
      var ch = buffer.getChannelData(c);
      var src = dec.channels[c];
      for (var i = 0; i < len; i++) ch[i] = src[i] * scale;
    }

    var srcNode = ctx.createBufferSource();
    srcNode.buffer = buffer;
    srcNode.connect(ctx.destination);
    var startedAt = ctx.currentTime;
    var dur = len / h.sampleRate;

    srcNode.onended = function () {
      if (state.playing === srcNode) stopPlayback();
    };
    srcNode.start();

    state.playing = srcNode;
    state.playHead = sel.start;
    $('play-btn').innerHTML = '';
    $('play-btn').appendChild(icon('stop', 'b-ico'));
    $('play-btn').appendChild(document.createTextNode('停止'));
    $('play-status').textContent = '播放中 · ' + fmtSeconds(len, h.sampleRate);

    function tick() {
      if (state.playing !== srcNode) return;
      var elapsed = ctx.currentTime - startedAt;
      if (elapsed >= dur) { stopPlayback(); return; }
      state.playHead = sel.start + elapsed * h.sampleRate;
      $('play-status').textContent = '播放中 · ' + elapsed.toFixed(2) + ' / ' + dur.toFixed(2) + 's';
      drawWaveform();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------------- 导出 ---------------- */
  function exportSelection() {
    var sel = state.selection;
    if (sel.end <= sel.start) { toast('请先设置有效区间。', 'warn'); return; }
    var bad = badBlocksInRange(sel.start, sel.end);
    if (bad.length) {
      toast('区间跨越损坏块 ' + bad.join('、') + '，已禁止导出。', 'crit', 6000);
      return;
    }
    var res = R.exportWav(state.archive, sel.start, sel.end);
    if (!res.ok) {
      if (res.badBlocks && res.badBlocks.length) {
        toast('导出被拒绝：区间跨越损坏块 ' + res.badBlocks.join('、') + '。', 'crit', 6000);
      } else {
        toast('导出失败：' + (res.error && res.error.message), 'crit', 6000);
      }
      return;
    }
    var name = baseName(state.downloadName || state.sourceName) + '_' +
      sel.start + '-' + sel.end + '.wav';
    downloadBytes(res.bytes, name, 'audio/wav');
    toast('已导出 ' + name + '（' + fmtInt(sel.end - sel.start) + ' 帧，' + fmtBytes(res.bytes.length) + '）', 'ok', 6000);
  }

  /* ---------------- 损坏演示 ---------------- */
  function corruptIndexEntry() {
    if (!state.archive) return;
    var total = state.archive.header.numBlocks;
    if (total < 2) { toast('块太少，无法演示索引损坏。', 'warn'); return; }
    // 选一个非首非尾的条目，改其偏移字段，保证与相邻块不再首尾相接。
    var idx = Math.min(total - 2, Math.max(1, Math.floor(total / 2)));
    if (idx < 0) idx = 0;
    var copy = new Uint8Array(state.bytes);
    var p = R.HEADER_SIZE + idx * R.ENTRY_SIZE;
    copy[p] ^= 0xff;
    copy[p + 1] ^= 0x7f;
    applyCorruption(copy, '已损坏索引条目 ' + idx + '（偏移字段）。');
  }

  function corruptBlock() {
    if (!state.archive) return;
    var usable = state.archive.entries.filter(function (e) { return e.status === 'ok'; });
    if (!usable.length) { toast('没有完好的块可供破坏。', 'warn'); return; }
    var e = usable[Math.floor(usable.length / 2)];
    var copy = new Uint8Array(state.bytes);
    copy[e.offset] ^= 0xff; // 破坏块首字节，使 CRC 失配
    applyCorruption(copy, '已损坏块 ' + e.index + ' 的数据（CRC 将失配）。');
  }

  function applyCorruption(copy, message) {
    stopPlayback();
    var arc = R.parse(copy);
    if (!arc.ok) { toast('损坏导致头错误，已保留原归档。', 'warn'); return; }
    state.archive = arc;
    state.bytes = copy;
    state.peaks = null;
    state.peaksReady = false;
    state.expanded = -1;
    state.page = 0;
    state.filter = 'all';
    state.downloadName = null;
    toast(message, 'warn', 6000);
    renderWorkspace();
    computePeaksAsync();
  }

  function restoreArchive() {
    if (!state.originalBytes) { toast('没有可恢复的原始字节。', 'warn'); return; }
    var arc = R.parse(state.originalBytes);
    if (!arc.ok) { toast('恢复失败。', 'crit'); return; }
    stopPlayback();
    state.archive = arc;
    state.bytes = state.originalBytes;
    state.peaks = null;
    state.peaksReady = false;
    state.expanded = -1;
    state.page = 0;
    state.filter = 'all';
    state.downloadName = state.baseDownloadName;
    renderWorkspace();
    computePeaksAsync();
    toast('已恢复到校验通过的归档。', 'ok');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    var fileInput = $('file-input');
    $('drop').addEventListener('click', function () { fileInput.click(); });
    $('drop').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
      fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      $('drop').addEventListener(evt, function (e) {
        e.preventDefault(); $('drop').classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      $('drop').addEventListener(evt, function (e) {
        e.preventDefault(); $('drop').classList.remove('dragging');
      });
    });
    $('drop').addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });

    $('encode-btn').addEventListener('click', runEncode);
    $('download-archive').addEventListener('click', function () {
      if (!state.bytes || !state.downloadName) return;
      downloadBytes(state.bytes, state.downloadName, 'application/octet-stream');
    });

    // 示例
    document.querySelectorAll('[data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sample');
        var s = window.RPA_SAMPLES && window.RPA_SAMPLES[key];
        if (!s) { toast('示例不可用。', 'warn'); return; }
        var bin = atob(s.b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        handleUploadedBytes(bytes, s.name);
      });
    });

    // 选择输入
    function readFrameInput(input, fallback) {
      var v = parseInt(input.value, 10);
      if (isNaN(v)) return fallback;
      return v;
    }
    $('sel-start').addEventListener('change', function () {
      setSelection(readFrameInput($('sel-start'), state.selection.start), state.selection.end);
    });
    $('sel-end').addEventListener('change', function () {
      setSelection(state.selection.start, readFrameInput($('sel-end'), state.selection.end));
    });
    $('sel-all').addEventListener('click', function () {
      setSelection(0, state.archive.header.totalFrames);
    });
    $('sel-first-sec').addEventListener('click', function () {
      var rate = state.archive.header.sampleRate;
      setSelection(state.selection.start, Math.min(state.archive.header.totalFrames, state.selection.start + rate));
    });
    $('sel-nudge-l').addEventListener('click', function () {
      setSelection(state.selection.start - 1024, state.selection.end);
    });
    $('sel-nudge-r').addEventListener('click', function () {
      setSelection(state.selection.start, state.selection.end + 1024);
    });

    $('play-btn').addEventListener('click', playSelection);
    $('export-btn').addEventListener('click', exportSelection);

    // 表格分页与筛选
    document.querySelectorAll('.seg [data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.seg [data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        state.filter = b.getAttribute('data-filter');
        state.page = 0;
        renderTable();
      });
    });
    $('prev-page').addEventListener('click', function () {
      if (state.page > 0) { state.page--; renderTable(); }
    });
    $('next-page').addEventListener('click', function () {
      state.page++; renderTable();
    });
    $('jump-input').addEventListener('change', function () {
      var v = parseInt($('jump-input').value, 10);
      if (isNaN(v)) return;
      var b = Math.max(0, Math.min(state.archive.entries.length - 1, v));
      state.expanded = b;
      state.page = Math.floor(b / state.pageSize);
      state.filter = 'all';
      renderTable();
      var row = $('block-tbody').querySelector('tr[data-block="' + b + '"]');
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    $('map-canvas-wrap').addEventListener('click', mapClick);
    $('map-canvas-wrap').addEventListener('keydown', function (ev) {
      if (!state.archive) return;
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      var n = state.archive.entries.length;
      var current = state.expanded >= 0 ? state.expanded : 0;
      var target = Math.min(n - 1, Math.max(0, current));
      var e = state.archive.entries[target];
      setSelection(e.startFrame, e.endFrame);
      state.expanded = target;
      state.page = Math.floor(target / state.pageSize);
      renderTable();
    });

    $('sim-index').addEventListener('click', corruptIndexEntry);
    $('sim-block').addEventListener('click', corruptBlock);
    $('restore').addEventListener('click', restoreArchive);

    window.addEventListener('resize', debounce(function () {
      if (!state.archive) return;
      renderBlockMap();
      drawWaveform();
    }, 150));
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments;
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
