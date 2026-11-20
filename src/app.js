/* G53 实验台交互逻辑 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const zlib = window.zlibAdapter;

  const SAMPLES = [
    { file: 'assets/samples/odd-ramp.png', label: 'odd-ramp 65×49' },
    { file: 'assets/samples/impulse.png', label: 'impulse 17×15' },
    { file: 'assets/samples/single-row.png', label: 'single-row 19×1' },
    { file: 'assets/samples/single-column.png', label: 'single-column 1×17' },
    { file: 'assets/samples/zero-coefficients.png', label: 'zero-coeff 9×7' },
  ];

  const state = {
    srcPixels: null,      // 原始 0..255
    width: 0, height: 0,
    srcName: '',
    enc: null,            // encodeStream 结果
    effective: null,      // 实际喂入的 Uint8Array（可能含损坏字节）
    corrupt: false,
    parser: null,
    fed: 0,
    playing: false,
    playTimer: null,
    selected: { x: 0, y: 0 },
  };

  /* ---------------- 主题 ---------------- */
  const themeBtn = $('themeBtn');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('g53-theme', next); } catch (e) { /* 忽略 */ }
    renderCoeff();
  });
  try {
    const saved = localStorage.getItem('g53-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* 忽略 */ }

  /* ---------------- 样例按钮 ---------------- */
  const sampleGrid = $('sampleGrid');
  SAMPLES.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample-btn';
    btn.dataset.file = s.file;
    btn.innerHTML = `<img src="${s.file}" alt="${s.label}"><span>${s.label}</span>`;
    btn.addEventListener('click', () => loadFromUrl(s.file, s.label, btn));
    sampleGrid.appendChild(btn);
  });

  function markActiveSample(file) {
    document.querySelectorAll('.sample-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.file === file));
  }

  async function loadFromUrl(url, label, btn) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = new Uint8Array(await resp.arrayBuffer());
      loadPngBytes(buf, label, url);
      if (btn) markActiveSample(url);
    } catch (e) {
      failHard('样例载入失败：' + e.message);
    }
  }

  function loadPngBytes(bytes, label, fileKey) {
    try {
      const { width, height, pixels } = PNG8.decode(bytes, zlib);
      state.srcPixels = pixels;
      state.width = width;
      state.height = height;
      state.srcName = label;
      stopPlay();
      resetEncoding();
      $('srcInfo').textContent = `${label} — ${width}×${height}，${pixels.length} 像素，` +
        `范围 ${minOf(pixels)}..${maxOf(pixels)}`;
      drawGrayscale($('origCanvas'), pixels, width, height);
      $('origCap').textContent = `${width}×${height}`;
      const maxL = G53.maxLevels(width, height);
      const range = $('levelRange');
      range.max = maxL;
      range.value = Math.min(maxL, 3);
      $('levelVal').textContent = range.value;
      $('levelHint').textContent = `可变换次数 ${maxL}（宽或高降到 1 为止；1×1 时为 0）`;
      range.disabled = false;
      $('encodeBtn').disabled = false;
      // 载入即自动编码，保证首帧是完整工作态
      doEncode();
    } catch (e) {
      failHard('PNG 解析失败：' + e.message);
    }
  }

  function minOf(a) { let m = 255; for (const v of a) if (v < m) m = v; return m; }
  function maxOf(a) { let m = 0; for (const v of a) if (v > m) m = v; return m; }

  /* ---------------- PNG 文件输入 / 拖拽 ---------------- */
  const pngInput = $('pngInput');
  const pngDrop = $('pngDrop');
  pngDrop.addEventListener('click', () => pngInput.click());
  pngInput.addEventListener('change', () => {
    if (pngInput.files[0]) readFile(pngInput.files[0], (b, n) => { loadPngBytes(b, n, null); markActiveSample(''); });
  });
  bindDrop(pngDrop, (file) => { loadPngBytes(file.bytes, file.name, null); markActiveSample(''); });

  function readFile(file, cb) {
    const fr = new FileReader();
    fr.onload = () => cb(new Uint8Array(fr.result), file.name);
    fr.onerror = () => failHard('文件读取失败：' + file.name);
    fr.readAsArrayBuffer(file);
  }

  function bindDrop(el, cb) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) readFile(f, (b, n) => cb({ bytes: b, name: n }));
    });
  }

  /* ---------------- 编码 ---------------- */
  $('levelRange').addEventListener('input', (e) => {
    $('levelVal').textContent = e.target.value;
  });
  $('levelRange').addEventListener('change', () => doEncode());
  $('encodeBtn').addEventListener('click', doEncode);

  function resetEncoding() {
    stopPlay();
    state.enc = null;
    state.effective = null;
    state.parser = null;
    state.fed = 0;
    $('byteRange').disabled = true;
    $('exportBtn').disabled = true;
    $('copyB64Btn').disabled = true;
    $('recordsBody').innerHTML = '<tr><td colspan="6" class="muted">尚未编码</td></tr>';
    clearOutputs();
  }

  function doEncode() {
    if (!state.srcPixels) return;
    const levels = +$('levelRange').value;
    stopPlay();
    try {
      state.enc = G53.encodeStream(state.srcPixels, state.width, state.height, levels, zlib);
      state.corrupt = $('corruptChk').checked;
      state.effective = state.corrupt ? corruptStream(state.enc.stream, state.enc) : state.enc.stream;
      state.parser = new G53.G53StreamParser(zlib);
      state.fed = 0;
      const total = state.effective.length;
      const br = $('byteRange');
      br.disabled = false;
      br.max = total;
      br.value = total; // 编码完成先给完整流，便于立即看到无损结果
      $('byteVal').textContent = `${total} / ${total}`;
      $('bytePct').textContent = '100.0%';
      $('exportBtn').disabled = false;
      $('copyB64Btn').disabled = false;
      $('encodeInfo').textContent =
        `流长 ${total} B · 最高位号 ${state.enc.highbit} · ` +
        `${state.enc.highbit === 255 ? '全零系数，无层' : state.enc.records.length + ' 条记录'}`;
      rebuildBandSelect();
      reparseTo(br.value);
      fillRecordTable();
      $('headerInfo').textContent =
        `头：G53A | 宽 ${state.width} | 高 ${state.height} | 层数 ${levels} | 最高位号 ${state.enc.highbit}`;
    } catch (e) {
      failHard('编码失败：' + e.message);
    }
  }

  /**
   * 损坏演示：解压第一条记录的负载，翻转其中一个数据位后重新压缩，
   * 但保留原记录头（CRC 与长度字段不变）→ 记录完整且 zlib 可解压，
   * 必然在 CRC32 校验处硬失败，而不是被误判为截断。
   */
  function corruptStream(stream, enc) {
    if (enc.highbit === 255 || enc.records.length === 0) {
      // 全零流没有记录可损坏，直接翻转头后首字节（触发魔数/头错误路径）
      const out = new Uint8Array(stream);
      out[Math.min(14, out.length - 1)] ^= 0xff;
      return out;
    }
    const r0 = enc.records[0];
    const recOff = 14;
    const compOff = recOff + 13;
    const raw = zlib.inflate(stream.slice(compOff, compOff + r0.compLen));
    const badRaw = new Uint8Array(raw);
    // 翻转负载中部一个字节（避开纯补齐位区域，确保改变有效数据）
    const idx = Math.min(raw.length - 1, Math.max(0, Math.floor(raw.length / 2)));
    badRaw[idx] ^= 0x01;
    const badComp = zlib.deflate(badRaw);
    // 重建记录头：位号/长度均如实填写，唯独 CRC 保留旧值 → 必然 CRC 校验失败
    const newHead = new Uint8Array(13);
    const dv = new DataView(newHead.buffer);
    dv.setUint8(0, r0.bit);
    dv.setUint32(1, badRaw.length, true);
    dv.setUint32(5, badComp.length, true);
    dv.setUint32(9, r0.crc); // 故意不更新
    const tail = stream.subarray(compOff + r0.compLen);
    const out = new Uint8Array(recOff + newHead.length + badComp.length + tail.length);
    out.set(stream.subarray(0, recOff), 0);
    out.set(newHead, recOff);
    out.set(badComp, compOff);
    out.set(tail, compOff + badComp.length);
    return out;
  }

  $('corruptChk').addEventListener('change', () => doEncode());

  /* ---------------- 渐进喂入 ---------------- */
  const byteRange = $('byteRange');
  byteRange.addEventListener('input', () => {
    stopPlay();
    reparseTo(+byteRange.value);
  });

  $('resetBtn').addEventListener('click', () => {
    stopPlay();
    byteRange.value = 0;
    reparseTo(0);
  });

  $('halfBtn').addEventListener('click', () => {
    if (!state.enc) return;
    stopPlay();
    // 找第二条记录负载的中点（没有两条记录时取整流中点）
    let target;
    if (state.enc.records.length >= 2) {
      target = 14 + 13 + state.enc.records[0].compLen + 13 +
        Math.floor(state.enc.records[1].compLen / 2);
    } else {
      target = Math.floor(state.effective.length / 2);
    }
    byteRange.value = target;
    reparseTo(target);
  });

  $('feedBtn').addEventListener('click', () => feedOneChunk());
  $('playBtn').addEventListener('click', togglePlay);

  function nextChunkEnd() {
    const mode = $('chunkSize').value;
    const total = state.effective.length;
    if (state.fed >= total) return total;
    if (mode === 'record') {
      if (state.fed === 0) return 14; // 先喂头
      // 找到 fed 之后下一条记录边界
      let off = 14;
      for (const r of state.enc.records) {
        const end = off + 13 + r.compLen;
        if (end > state.fed) return end;
        off = end;
      }
      return total;
    }
    return Math.min(total, state.fed + (+mode));
  }

  function feedOneChunk() {
    if (!state.parser) return;
    const end = nextChunkEnd();
    if (end <= state.fed) return;
    byteRange.value = end;
    reparseTo(end);
  }

  function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    if (!state.parser) return;
    if (state.fed >= state.effective.length) { byteRange.value = 0; reparseTo(0); }
    state.playing = true;
    $('playBtn').textContent = '暂停';
    state.playTimer = setInterval(() => {
      if (state.fed >= state.effective.length || state.parser.state === 'error') {
        stopPlay();
        return;
      }
      feedOneChunk();
    }, 220);
  }

  function stopPlay() {
    state.playing = false;
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    const pb = $('playBtn');
    if (pb) pb.textContent = '自动播放';
  }

  /** 以分片方式把前 n 字节重新喂给新解析器（模拟逐渐收到数据） */
  function reparseTo(n) {
    if (!state.effective) return;
    stopPlay();
    const total = state.effective.length;
    n = Math.max(0, Math.min(total, n | 0));
    const parser = new G53.G53StreamParser(zlib);
    const STEP = 256;
    for (let off = 0; off < n; off += STEP) {
      parser.feed(state.effective.subarray(off, Math.min(n, off + STEP)));
      if (parser.state === 'error') break; // 硬错误：继续喂也无法恢复
    }
    state.parser = parser;
    state.fed = n;
    $('byteRange').value = n;
    $('byteVal').textContent = `${n} / ${total}`;
    $('bytePct').textContent = (100 * n / Math.max(1, total)).toFixed(1) + '%';
    renderAll();
  }

  /* ---------------- 渲染 ---------------- */
  function clearOutputs() {
    const c = $('recCanvas');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    $('recCap').textContent = '—';
    ['tBytes', 'tLayers', 'tMaxErr', 'tMae', 'tPsnr'].forEach(id => $(id).textContent = '—');
    $('tBytesSub').textContent = '共 0 B';
    $('tLayersSub').textContent = '位号 —';
    $('tRmse').textContent = 'RMSE —';
    $('tClampSub').textContent = '越界像素 —';
    setPill('未编码', '');
    $('tStateSub').textContent = '等待编码';
    $('progBar').style.width = '0%';
    $('layerChips').innerHTML = '';
    $('errBanner').hidden = true;
    $('waitBanner').hidden = true;
    $('losslessBanner').hidden = true;
  }

  function setPill(text, cls) {
    const p = $('tState');
    p.textContent = text;
    p.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function renderAll() {
    const p = state.parser;
    if (!p) return;
    const total = state.effective.length;
    $('tBytes').textContent = String(state.fed);
    $('tBytesSub').textContent = `共 ${total} B（${(state.fed / Math.max(1, total) * 100).toFixed(1)}%）`;

    const totalLayers = state.enc.highbit === 255 ? 0 : state.enc.records.length;
    $('tLayers').textContent = `${p.layers.length} / ${totalLayers}`;
    $('tLayersSub').textContent = p.layers.length
      ? '已到位号 ' + p.layers[p.layers.length - 1].bit
      : (totalLayers ? '位号 ' + state.enc.highbit + ' 起' : '全零流无层');

    // 状态
    $('errBanner').hidden = true;
    $('waitBanner').hidden = true;
    $('losslessBanner').hidden = true;
    if (p.state === 'error') {
      setPill('错误', 'bad');
      $('tStateSub').textContent = '完整记录校验失败';
      $('errBanner').hidden = false;
      $('errText').innerHTML = '<code></code>';
      $('errText').querySelector('code').textContent = p.error;
    } else if (p.state === 'done') {
      setPill('完整流已接收', 'done');
      $('tStateSub').textContent = `共 ${totalLayers} 层全部通过校验`;
    } else if (p.waiting) {
      setPill('等待数据', 'waiting');
      $('tStateSub').textContent = '末尾记录不完整，保留已校验层';
      $('waitBanner').hidden = false;
    } else {
      setPill('接收中', 'waiting');
      $('tStateSub').textContent = '头部尚未收齐';
    }

    // 重建与误差
    if (p.mag) {
      const img = p.reconstructImage();
      drawGrayscale($('recCanvas'), img, p.width, p.height);
      $('recCap').textContent = `${p.width}×${p.height} · ${p.layers.length} 层`;
      const signed = p.reconstructSigned();
      let sumAbs = 0, sumSq = 0, maxErr = 0, outOfRange = 0;
      const ref = state.srcPixels;
      const comparable = ref && ref.length === signed.length;
      for (let i = 0; i < signed.length; i++) {
        const v = signed[i];
        if (v < 0 || v > 255) outOfRange++;
        if (comparable) {
          const d = v - ref[i];
          const ad = Math.abs(d);
          if (ad > maxErr) maxErr = ad;
          sumAbs += ad;
          sumSq += d * d;
        }
      }
      if (comparable) {
        const n = signed.length;
        const mae = sumAbs / n;
        const rmse = Math.sqrt(sumSq / n);
        $('tMaxErr').textContent = String(maxErr);
        $('tMae').textContent = mae.toFixed(3);
        $('tRmse').textContent = 'RMSE ' + rmse.toFixed(3);
        $('tClampSub').textContent = `越界像素 ${outOfRange}（显示已夹紧，计算未夹紧）`;
        if (rmse === 0) {
          $('tPsnr').textContent = '∞ dB';
        } else {
          // 以有符号域 RMSE 对 255 峰值计算
          $('tPsnr').textContent = (20 * Math.log10(255 / rmse)).toFixed(2) + ' dB';
        }
        if (p.state === 'done' && maxErr === 0) {
          $('losslessBanner').hidden = false;
          $('losslessText').textContent =
            `inverse + 128 后与原图 ${n} 个像素完全一致（maxErr=0），无量化、无夹紧参与判定。`;
        }
      } else {
        $('tMaxErr').textContent = '—';
        $('tMae').textContent = '—';
        $('tRmse').textContent = 'RMSE —';
        $('tPsnr').textContent = '—';
        $('tClampSub').textContent = `越界像素 ${outOfRange}；导入流尺寸与当前原图不同，未计算相对误差`;
      }
    }

    // 进度条与层芯片
    $('progBar').style.width = (state.fed / Math.max(1, total) * 100).toFixed(2) + '%';
    renderLayerChips(p);
    renderRecords(p);
    renderCoeff();
  }

  function renderLayerChips(p) {
    const box = $('layerChips');
    if (state.enc.highbit === 255) {
      box.innerHTML = '<span class="chip verified">全零系数：highbit=255，头后无层</span>';
      return;
    }
    const verifiedBits = new Set(p.layers.map(l => l.bit));
    box.innerHTML = '';
    for (let bit = state.enc.highbit; bit >= 0; bit--) {
      const chip = document.createElement('span');
      chip.className = 'chip ' + (verifiedBits.has(bit) ? 'verified' : '');
      chip.textContent = 'b' + bit;
      box.appendChild(chip);
    }
  }

  function fillRecordTable() {
    const body = $('recordsBody');
    if (state.enc.highbit === 255) {
      body.innerHTML = '<tr><td colspan="6" class="muted">全零系数流：头部 14 字节之后无记录</td></tr>';
      return;
    }
    body.innerHTML = '';
    state.enc.records.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${i + 1}</td><td>${r.bit}</td><td>${r.rawLen}</td><td>${r.compLen}</td>` +
        `<td>0x${r.crc.toString(16).padStart(8, '0')}</td>` +
        `<td><span class="tag pending" data-bit="${r.bit}">未接收</span></td>`;
      body.appendChild(tr);
    });
  }

  function renderRecords(p) {
    const verified = new Set(p.layers.map(l => l.bit));
    document.querySelectorAll('#recordsBody .tag').forEach(tag => {
      const bit = +tag.dataset.bit;
      if (p.state === 'error' && !verified.has(bit)) {
        // 错误发生时，正在接收的那层标记为等待/失败区分由 banner 说明
        tag.className = 'tag pending';
        tag.textContent = '未接收';
      } else if (verified.has(bit)) {
        tag.className = 'tag verified';
        tag.textContent = 'CRC 通过';
      } else {
        tag.className = 'tag waiting';
        tag.textContent = p.waiting ? '等待字节' : '未接收';
      }
    });
  }

  /* ---------------- 系数 / 子带视图 ---------------- */
  function rebuildBandSelect() {
    const sel = $('bandLevel');
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '0';
    opt0.textContent = '不高亮';
    sel.appendChild(opt0);
    for (let l = 1; l <= state.enc.levels; l++) {
      const o = document.createElement('option');
      o.value = String(l);
      o.textContent = `第 ${l} 轮四分区`;
      sel.appendChild(o);
    }
    sel.value = String(Math.min(1, state.enc.levels));  }

  $('bandLevel').addEventListener('change', renderCoeff);
  $('fullCoeffChk').addEventListener('change', renderCoeff);

  function cssToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function renderCoeff() {
    const canvas = $('coeffCanvas');
    if (!state.enc) {
      canvas.width = canvas.height = 80;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 80, 80);
      return;
    }
    const { width: w, height: h } = state;
    const p = state.parser;
    const useFull = $('fullCoeffChk').checked || !p.mag;
    const coeff = useFull ? state.enc.coeff : p.currentCoefficients();

    // 归一化幅值固定取完整系数的最大绝对值，保证播放过程中色标不漂移
    let maxAbs = 1;
    for (const v of state.enc.coeff) {
      const a = Math.abs(v);
      if (a > maxAbs) maxAbs = a;
    }
    const scale = Math.max(1, Math.min(28, Math.floor(420 / Math.max(w, h))));
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const dark = currentTheme() === 'dark';
    for (let i = 0; i < coeff.length; i++) {
      const v = coeff[i];
      const t = Math.abs(v) / maxAbs; // 0..1
      let r, g, b;
      if (v === 0) {
        const z = hexToRgb(cssToken('--heat-zero'));
        r = z.r; g = z.g; b = z.b;
      } else if (v < 0) {
        // 负 → 琥珀
        r = lerp(245, 180, t); g = lerp(166, 83, t); b = lerp(35, 9, t);
        if (dark) { r = lerp(60, 245, t); g = lerp(42, 166, t); b = lerp(18, 35, t); }
      } else {
        // 正 → 青绿
        r = lerp(216, 14, t); g = lerp(240, 124, t); b = lerp(241, 134, t);
        if (dark) { r = lerp(16, 61, t); g = lerp(50, 217, t); b = lerp(58, 204, t); }
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    // 先画 1:1 再放大
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    small.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

    // 子带分区线
    const bandLvl = +$('bandLevel').value;
    if (bandLvl > 0) {
      const bands = G53.subbands(state.enc.dims);
      const sb = bands[bandLvl - 1];
      if (sb) drawBandOverlay(ctx, sb, scale, w, h);
    }
    $('legScale').textContent = `±${maxAbs}`;
    const legBar = $('legBar');
    legBar.style.background =
      `linear-gradient(90deg, ${cssToken('--amber')}, ${cssToken('--heat-zero')} 50%, ${cssToken('--accent')})`;
    updateInspector(coeff);
    renderCoeffTable(coeff, w, h);
  }

  function drawBandOverlay(ctx, sb, scale, w, h) {
    const pw = sb.parent.w, ph = sb.parent.h;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, scale / 6);
    ctx.setLineDash([scale, scale]);
    ctx.strokeRect(0.5, 0.5, pw * scale - 1, ph * scale - 1);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 1;
    // 十字分割
    ctx.beginPath();
    ctx.moveTo(sb.LL.w * scale, 0);
    ctx.lineTo(sb.LL.w * scale, ph * scale);
    ctx.moveTo(0, sb.LL.h * scale);
    ctx.lineTo(pw * scale, sb.LL.h * scale);
    ctx.stroke();
    const labels = [
      ['LL', sb.LL], ['HL', sb.HL], ['LH', sb.LH], ['HH', sb.HH],
    ];
    const fontSize = Math.max(9, scale * 0.8);
    ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (const [name, r] of labels) {
      if (r.w === 0 || r.h === 0) continue;
      // 区域太小时把标签居中，避免被分区线裁切
      const placeX = r.w * scale < fontSize * 3 ?
        r.x * scale + (r.w * scale - ctx.measureText(name).width) / 2 :
        r.x * scale + 4;
      const placeY = r.h * scale < fontSize * 2 ?
        r.y * scale + (r.h * scale - fontSize) / 2 :
        r.y * scale + 3;
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillText(name, placeX + 1, placeY + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, placeX, placeY);
    }
    ctx.restore();
  }

  function bandOf(x, y) {
    const lvl = +$('bandLevel').value;
    if (!state.enc || lvl === 0) return '—（未开启高亮）';
    const sb = G53.subbands(state.enc.dims)[lvl - 1];
    if (!sb || x >= sb.parent.w || y >= sb.parent.h) return `第 ${lvl} 轮区域之外（更高级高频）`;
    for (const name of ['LL', 'HL', 'LH', 'HH']) {
      const r = sb[name];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        return `${name}（第 ${lvl} 轮）`;
      }
    }
    return '—';
  }

  function updateInspector(coeff) {
    const { x, y } = state.selected;
    const w = state.width;
    const idx = y * w + x;
    $('inspCoord').textContent = `(${x}, ${y})  序号 ${idx}`;
    $('inspBand').textContent = bandOf(x, y);
    $('inspCur').textContent = String(coeff[idx]);
    $('inspFull').textContent = String(state.enc.coeff[idx]);
  }

  function renderCoeffTable(coeff, w, h) {
    const wrap = $('coeffTableWrap');
    if (w * h > 100) {
      wrap.innerHTML = '<div class="muted">系数超过 100 个，点击热图逐项检视；小尺寸图像在此显示完整矩阵。</div>';
      return;
    }
    let html = '<table class="coeff-table"><tbody>';
    for (let y = 0; y < h; y++) {
      html += '<tr>';
      for (let x = 0; x < w; x++) html += `<td>${coeff[y * w + x]}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  $('coeffCanvas').addEventListener('click', (e) => {
    if (!state.enc) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x = Math.min(state.width - 1, Math.max(0, Math.floor((e.clientX - rect.left) * sx /
      (canvas.width / state.width))));
    const y = Math.min(state.height - 1, Math.max(0, Math.floor((e.clientY - rect.top) * sy /
      (canvas.height / state.height))));
    state.selected = { x, y };
    const useFull = $('fullCoeffChk').checked;
    const coeff = useFull ? state.enc.coeff : state.parser.currentCoefficients();
    updateInspector(coeff);
  });

  /* ---------------- 选项卡 ---------------- */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tabpane').forEach(p =>
        p.hidden = p.id !== 'tab-' + tab.dataset.tab);
    });
  });

  /* ---------------- 画布工具 ---------------- */
  function drawGrayscale(canvas, pixels, w, h) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < pixels.length; i++) {
      const g = pixels[i];
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function hexToRgb(hex) {
    const m = hex.replace('#', '');
    return {
      r: parseInt(m.substring(0, 2), 16),
      g: parseInt(m.substring(2, 4), 16),
      b: parseInt(m.substring(4, 6), 16),
    };
  }
  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

  /* ---------------- 导出 / 导入 ---------------- */
  $('exportBtn').addEventListener('click', () => {
    if (!state.enc) return;
    const blob = new Blob([state.enc.stream], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.srcName.replace(/\.[^.]+$/, '')}-${state.width}x${state.height}-L${state.enc.levels}.g53`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('copyB64Btn').addEventListener('click', async () => {
    if (!state.enc) return;
    const b64 = toBase64(state.enc.stream);
    try {
      await navigator.clipboard.writeText(b64);
      $('copyB64Btn').textContent = '已复制';
      setTimeout(() => { $('copyB64Btn').textContent = '复制 Base64'; }, 1500);
    } catch (e) {
      $('b64Input').value = b64;
    }
  });

  function toBase64(u8) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return 'data:application/octet-stream;base64,' + btoa(bin);
  }

  function fromBase64(text) {
    const cleaned = text.trim().replace(/^data:[\w/+-]+;base64,/, '').replace(/\s+/g, '');
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const g53Input = $('g53Input');
  const g53Drop = $('g53Drop');
  g53Drop.addEventListener('click', () => g53Input.click());
  g53Input.addEventListener('change', () => {
    if (g53Input.files[0]) readFile(g53Input.files[0], (b) => importStream(b));
  });
  bindDrop(g53Drop, (file) => importStream(file.bytes));
  $('b64ImportBtn').addEventListener('click', () => {
    try {
      importStream(fromBase64($('b64Input').value));
    } catch (e) {
      failHard('Base64 解析失败：' + e.message);
    }
  });

  function importStream(bytes) {
    stopPlay();
    // 用完整编码信息重建 records 视图：先尝试解析为 G53
    const parser = new G53.G53StreamParser(zlib);
    parser.feed(bytes);
    if (parser.state === 'error') {
      // 仍然展示错误状态
      state.enc = makeSyntheticEnc(bytes, parser);
      state.effective = bytes;
      state.parser = parser;
      state.fed = bytes.length;
      syncImportedUi(bytes);
      renderAll();
      return;
    }
    // 正常：构造与 encodeStream 同构的 enc 以便复用渲染
    state.enc = makeSyntheticEnc(bytes, parser);
    state.effective = bytes;
    state.parser = parser;
    state.fed = bytes.length;
    state.width = parser.width;
    state.height = parser.height;
    syncImportedUi(bytes);
    renderAll();
  }

  function makeSyntheticEnc(bytes, parser) {
    const records = parser.layers.map(l => ({
      bit: l.bit, rawLen: l.rawLen, compLen: l.compLen, crc: l.crc,
    }));
    return {
      stream: bytes,
      coeff: parser.mag ? parser.currentCoefficients() : [],
      dims: parser.dims || [{ w: parser.width, h: parser.height }],
      highbit: parser.highbit,
      levels: parser.levels,
      records,
    };
  }

  function syncImportedUi(bytes) {
    const p = state.parser;
    const br = $('byteRange');
    br.disabled = false;
    br.max = bytes.length;
    br.value = bytes.length;
    $('byteVal').textContent = `${bytes.length} / ${bytes.length}`;
    $('bytePct').textContent = '100.0%';
    $('exportBtn').disabled = false;
    $('copyB64Btn').disabled = false;
    $('encodeInfo').textContent =
      `导入流 ${bytes.length} B · 最高位号 ${p.highbit} · ` +
      (p.highbit === 255 ? '全零系数，无层' : `${p.layers.length} 条记录`);
    fillRecordTable();
    rebuildBandSelect();
    $('headerInfo').textContent =
      `头：G53A | 宽 ${p.width} | 高 ${p.height} | 层数 ${p.levels} | 最高位号 ${p.highbit}`;
    // 重建图画布在 renderAll 中处理；原图保留当前选择，尺寸不同则提示
    if (!state.srcPixels || state.srcPixels.length !== p.width * p.height) {
      const c = $('origCanvas');
      c.width = p.width; c.height = p.height;
      c.getContext('2d').clearRect(0, 0, p.width, p.height);
      $('origCap').textContent = `${p.width}×${p.height}（无匹配原图）`;
    }
  }

  function failHard(msg) {
    setPill('错误', 'bad');
    $('tStateSub').textContent = '见下方错误条';
    $('errBanner').hidden = false;
    $('errText').innerHTML = '<code></code>';
    $('errText').querySelector('code').textContent = msg;
  }

  /* ---------------- 启动：载入默认样例 ---------------- */
  loadFromUrl(SAMPLES[0].file, SAMPLES[0].label, document.querySelector('.sample-btn'));
})();
