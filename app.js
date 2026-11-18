/* CLAHE 分块均衡器 —— 页面逻辑（依赖 clahe.js 的 CLAHE 全局） */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = {
    W: 0, H: 0, isColor: false,
    src: null,        // Uint8Array：灰度 W*H 或 RGB W*H*3
    result: null,     // 同格式输出
    tiles: null,
    tx: 8, ty: 8, clip: 2.0,
    sel: -1,          // 选中分块下标（行优先）
    fileName: 'demo',
  };

  /* ---------- PNG 头部校验（只接受 8 位灰度 / RGB、非隔行、单边 ≤ 2048） ---------- */
  function checkPngHeader(buf) {
    const b = new Uint8Array(buf);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 33 || !sig.every((v, i) => b[i] === v)) throw new Error('不是 PNG 文件。');
    const dv = new DataView(buf);
    if (dv.getUint32(12, false) !== 0x49484452) throw new Error('PNG 缺少 IHDR 块。');
    const w = dv.getUint32(16, false), h = dv.getUint32(20, false);
    const bitDepth = b[24], colorType = b[25], interlace = b[28];
    if (w > 2048 || h > 2048) throw new Error(`尺寸 ${w}×${h} 超过单边 2048 的限制。`);
    if (bitDepth !== 8) throw new Error(`不支持 ${bitDepth} 位 PNG，只支持 8 位灰度或 RGB。`);
    if (colorType === 3) throw new Error('不支持调色板 PNG，请转换为 8 位灰度或 RGB。');
    if (colorType === 4 || colorType === 6) throw new Error('不支持带透明通道的 PNG，请去掉 alpha 后再导入。');
    if (colorType !== 0 && colorType !== 2) throw new Error(`不支持的 PNG 颜色类型 ${colorType}。`);
    if (interlace !== 0) throw new Error('不支持隔行扫描（interlaced）PNG。');
    return { w, h, isColor: colorType === 2 };
  }

  function setStatus(msg, kind) {
    const el = $('statusText');
    el.textContent = msg;
    el.className = kind || '';
  }

  /* ---------- 图像载入 ---------- */
  async function loadFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const hdr = checkPngHeader(buf);
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      const cv = document.createElement('canvas');
      cv.width = hdr.w; cv.height = hdr.h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const rgba = ctx.getImageData(0, 0, hdr.w, hdr.h).data;
      const n = hdr.w * hdr.h;
      let src;
      if (hdr.isColor) {
        src = new Uint8Array(n * 3);
        for (let p = 0; p < n; p++) {
          src[p * 3] = rgba[p * 4];
          src[p * 3 + 1] = rgba[p * 4 + 1];
          src[p * 3 + 2] = rgba[p * 4 + 2];
        }
      } else {
        src = new Uint8Array(n);
        for (let p = 0; p < n; p++) src[p] = rgba[p * 4];
      }
      state.W = hdr.w; state.H = hdr.h; state.isColor = hdr.isColor;
      state.src = src; state.sel = -1;
      state.fileName = file.name.replace(/\.png$/i, '');
      setStatus(`已导入 ${file.name}（${hdr.isColor ? 'RGB' : '灰度'}）`, 'ok');
      process();
    } catch (err) {
      setStatus(`导入失败：${err.message}`, 'err');
    }
  }

  /* ---------- 内置示例图：亮天空 + 暗部结构 + 噪点（RGB） ---------- */
  function makeDemo() {
    const W = 480, H = 320;
    const src = new Uint8Array(W * H * 3);
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 3;
        const noise = (rnd() - 0.5) * 14;
        if (y < H * 0.45) {
          // 天空：上亮下暗的暖色渐变，噪点明显
          const t = y / (H * 0.45);
          const v = 225 - t * 45 + noise;
          src[p] = v; src[p + 1] = v - 4; src[p + 2] = v - 14;
        } else {
          // 地面 / 设备暗部
          let v = 34 + 10 * Math.sin(x / 40) + noise * 0.6;
          if (x > W * 0.3 && x < W * 0.62 && y > H * 0.55 && y < H * 0.9) v = 52 + noise * 0.6; // 设备箱体
          if (x > W * 0.36 && x < W * 0.44 && y > H * 0.6 && y < H * 0.8) v = 18 + noise * 0.4; // 箱上阴影缝隙
          src[p] = v + 6; src[p + 1] = v + 2; src[p + 2] = v;
        }
      }
    }
    state.W = W; state.H = H; state.isColor = true; state.src = src;
    state.fileName = 'demo';
  }

  /* ---------- 处理与绘制 ---------- */
  function drawImage(canvas, data, isColor, W, H) {
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    if (isColor) {
      for (let p = 0; p < W * H; p++) {
        d[p * 4] = data[p * 3]; d[p * 4 + 1] = data[p * 3 + 1];
        d[p * 4 + 2] = data[p * 3 + 2]; d[p * 4 + 3] = 255;
      }
    } else {
      for (let p = 0; p < W * H; p++) {
        d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = data[p]; d[p * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawGrid() {
    const { W, H, tx, ty, sel } = state;
    const xb = CLAHE.tileBounds(W, tx), yb = CLAHE.tileBounds(H, ty);
    for (const id of ['srcGrid', 'resGrid']) {
      const cv = $(id);
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      const lw = Math.max(1, W / 500);
      if (sel >= 0) {
        const t = state.tiles[sel];
        ctx.fillStyle = 'rgba(217,164,65,0.18)';
        ctx.fillRect(t.x0, t.y0, t.x1 - t.x0 + 1, t.y1 - t.y0 + 1);
        ctx.strokeStyle = '#d9a441';
        ctx.lineWidth = lw * 1.6;
        ctx.strokeRect(t.x0 + lw / 2, t.y0 + lw / 2, t.x1 - t.x0 + 1 - lw, t.y1 - t.y0 + 1 - lw);
      }
      ctx.strokeStyle = 'rgba(236,231,220,0.35)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 1; i < tx; i++) { ctx.moveTo(xb[i][0], 0); ctx.lineTo(xb[i][0], H); }
      for (let j = 1; j < ty; j++) { ctx.moveTo(0, yb[j][0]); ctx.lineTo(W, yb[j][0]); }
      ctx.stroke();
    }
  }

  let scheduled = false;
  function process() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const { W, H, src, isColor, tx, ty, clip } = state;
      const res = isColor
        ? CLAHE.applyRgb(src, W, H, tx, ty, clip)
        : CLAHE.applyGray(src, W, H, tx, ty, clip);
      state.tiles = res.tiles;
      state.result = res.out;
      drawImage($('srcCanvas'), src, isColor, W, H);
      drawImage($('resCanvas'), res.out, isColor, W, H);
      drawGrid();
      $('sizeChip').textContent = `${W}×${H} · ${isColor ? 'RGB' : '灰度'} · ${tx}×${ty} 分块 · clip ${clip.toFixed(1)}`;
      $('srcInfo').textContent = `${W}×${H}`;
      $('resInfo').textContent = clip > 0 ? `clip ${clip.toFixed(1)}` : '不裁剪';
      drawInspector();
    });
  }

  /* ---------- 分块检验台 ---------- */
  function setupCanvas(cv, hCss) {
    const dpr = window.devicePixelRatio || 1;
    const wCss = cv.clientWidth || 300;
    cv.width = Math.round(wCss * dpr);
    cv.height = Math.round(hCss * dpr);
    cv.style.height = hCss + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: wCss, h: hCss };
  }

  const INK = '#ece7dc', FAINT = 'rgba(163,156,141,0.5)', ACCENT = '#d9a441';

  function drawHist(cv, counts, opts) {
    const { ctx, w, h } = setupCanvas(cv, 150);
    const padL = 34, padR = 6, padT = 14, padB = 20;
    const iw = w - padL - padR, ih = h - padT - padB;
    const max = Math.max(1, ...counts);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "IBM Plex Mono", monospace';
    // 参考线
    ctx.strokeStyle = 'rgba(236,231,220,0.12)';
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'right';
    for (const f of [0.5, 1]) {
      const y = padT + ih * (1 - f);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(String(Math.round(max * f)), padL - 4, y + 3);
    }
    // 主直方图
    ctx.fillStyle = opts.color || INK;
    for (let v = 0; v < 256; v++) {
      const bh = (counts[v] / max) * ih;
      if (bh > 0) ctx.fillRect(padL + (v / 256) * iw, padT + ih - bh, Math.max(1, iw / 256), bh);
    }
    // 裁剪上限线
    if (opts.limit != null) {
      const y = padT + ih - (opts.limit / max) * ih;
      ctx.strokeStyle = ACCENT;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ACCENT;
      ctx.textAlign = 'right';
      ctx.fillText(`limit ${opts.limit}`, w - padR - 4, Math.max(10, y - 4));
    }
    // 横轴
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'center';
    for (const v of [0, 64, 128, 192, 255]) {
      ctx.fillText(String(v), padL + (v / 255) * iw - (v === 255 ? 6 : 0), h - 6);
    }
  }

  function drawMap(cv, map) {
    const { ctx, w, h } = setupCanvas(cv, 150);
    const padL = 34, padR = 6, padT = 14, padB = 20;
    const iw = w - padL - padR, ih = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.strokeStyle = 'rgba(236,231,220,0.12)';
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'right';
    for (const v of [64, 128, 192, 255]) {
      const y = padT + ih * (1 - v / 255);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(String(v), padL - 4, y + 3);
    }
    // 恒等对角线
    ctx.strokeStyle = 'rgba(236,231,220,0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, padT + ih);
    ctx.lineTo(padL + iw, padT);
    ctx.stroke();
    ctx.setLineDash([]);
    // 映射曲线
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let v = 0; v < 256; v++) {
      const x = padL + (v / 255) * iw;
      const y = padT + ih * (1 - map[v] / 255);
      v === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'center';
    for (const v of [0, 64, 128, 192, 255]) {
      ctx.fillText(String(v), padL + (v / 255) * iw - (v === 255 ? 6 : 0), h - 6);
    }
  }

  function drawInspector() {
    const meta = $('tileMeta');
    const has = state.sel >= 0 && state.tiles;
    $('charts').hidden = !has;
    $('emptyNote').hidden = has;
    if (!has) { meta.innerHTML = ''; return; }
    const t = state.tiles[state.sel];
    const col = state.sel % state.tx, row = Math.floor(state.sel / state.tx);
    const limit = state.clip > 0 ? Math.max(1, Math.floor((state.clip * t.N) / 256)) : null;
    let E = 0;
    if (limit != null) for (let v = 0; v < 256; v++) E += Math.max(0, t.hist[v] - limit);
    meta.innerHTML =
      `<span>分块 <b class="mono">(${col}, ${row})</b></span>` +
      `<span>像素范围 <b class="mono">x ${t.x0}–${t.x1}, y ${t.y0}–${t.y1}</b></span>` +
      `<span>像素数 <b class="mono">N=${t.N}</b></span>` +
      (limit != null
        ? `<span>裁剪上限 <b class="mono">limit=${limit}</b></span><span>重分配计数 <b class="mono">E=${E}</b></span>`
        : `<span>不裁剪（clip=0）</span>`);
    drawHist($('histRaw'), t.hist, {});
    drawHist($('histClip'), t.clipped, { limit, color: ACCENT });
    drawMap($('mapCurve'), t.map);
  }

  function pickTile(e, wrapId) {
    const wrap = $(wrapId);
    const rect = wrap.getBoundingClientRect();
    const x = Math.min(state.W - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * state.W)));
    const y = Math.min(state.H - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * state.H)));
    const xb = CLAHE.tileBounds(state.W, state.tx);
    const yb = CLAHE.tileBounds(state.H, state.ty);
    let col = 0; while (col < state.tx - 1 && x > xb[col][1]) col++;
    let row = 0; while (row < state.ty - 1 && y > yb[row][1]) row++;
    state.sel = row * state.tx + col;
    drawGrid();
    drawInspector();
  }

  /* ---------- 导出 ---------- */
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- 事件 ---------- */
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  for (const [id, key, fmt] of [['tx', 'tx', 0], ['ty', 'ty', 0], ['clip', 'clip', 1]]) {
    $(id).addEventListener('input', () => {
      state[key] = fmt === 0 ? parseInt($(id).value, 10) : parseFloat($(id).value);
      $(id + 'Val').textContent = fmt === 0 ? String(state[key]) : state[key].toFixed(1);
      if (state.sel >= 0 && state.sel >= state.tx * state.ty) state.sel = -1;
      process();
    });
  }
  $('srcWrap').addEventListener('click', (e) => pickTile(e, 'srcWrap'));
  $('resWrap').addEventListener('click', (e) => pickTile(e, 'resWrap'));
  $('exportPng').addEventListener('click', () => {
    $('resCanvas').toBlob((b) => b && download(b, `${state.fileName}-clahe.png`), 'image/png');
  });
  $('exportJson').addEventListener('click', () => {
    const obj = CLAHE.mapsToJSON(state.tiles, state.tx, state.ty, state.clip);
    download(new Blob([JSON.stringify(obj)], { type: 'application/json' }), `${state.fileName}-maps.json`);
  });
  window.addEventListener('resize', () => { if (state.sel >= 0) drawInspector(); });

  /* ---------- 启动 ---------- */
  makeDemo();
  process();
})();
