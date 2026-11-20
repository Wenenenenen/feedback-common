/* 页面逻辑：文件加载、标记表、MCU/块网格、块详情、导出 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file');
  const errorBox = $('error'), infoBox = $('info'), actions = $('actions');
  const main = $('main'), view = $('view');
  const markerTbody = document.querySelector('#marker-table tbody');
  const detailBox = $('block-detail');

  let result = null;        // 解码结果
  let baseName = 'image';
  let scale = 1;
  let selection = null;     // { mcu, compId, blockX, blockY }
  let activeComp = 1;

  const hex0x = (n) => '0x' + n.toString(16).toUpperCase();

  // ---------------- 文件加载 ----------------

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });
  ['dragover', 'dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.toggle('over', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    }));

  function loadFile(file) {
    baseName = file.name.replace(/\.[^.]+$/, '');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        result = JpegDecoder.decode(new Uint8Array(reader.result));
        showResult();
      } catch (e) {
        showError(e);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function showError(e) {
    result = null;
    selection = null;
    main.hidden = true;
    actions.hidden = true;
    infoBox.hidden = true;
    errorBox.hidden = false;
    if (e && e.name === 'JpegError') {
      errorBox.textContent =
        `解码失败 — 不输出部分结果\n偏移 ${e.offset}（${hex0x(e.offset)}）：${e.message}`;
    } else {
      errorBox.textContent = `内部错误：${e && e.message ? e.message : e}`;
      console.error(e);
    }
  }

  // ---------------- 渲染 ----------------

  function showResult() {
    errorBox.hidden = true;
    main.hidden = false;
    actions.hidden = false;
    infoBox.hidden = false;
    selection = null;
    activeComp = result.components[0].id;

    const r = result;
    const samp = r.grayscale ? '灰度'
      : r.maxH === 1 ? '4:4:4' : r.maxV === 1 ? '4:2:2' : '4:2:0';
    infoBox.innerHTML =
      `<b>${r.width}×${r.height}</b> · ${samp} · ` +
      r.components.map((c) => `分量${c.id}（${c.H}×${c.V}，Q${c.tq}，平面 ${c.logicalW}×${c.logicalH}）`).join('，') +
      ` · MCU ${r.mcuCols}×${r.mcuRows}（共 ${r.mcus.length} 个）` +
      ` · 重启间隔 ${r.restartInterval || '无'}`;

    renderMarkers();
    computeScale();
    drawView();
    renderDetail();
  }

  function renderMarkers() {
    markerTbody.innerHTML = '';
    for (const m of result.markers) {
      const tr = document.createElement('tr');
      if (m.name.startsWith('RST')) tr.className = 'rst';
      if (m.code === -1) tr.className = 'entropy';
      tr.innerHTML =
        `<td class="off">${hex0x(m.offset)} – ${hex0x(m.end)}</td>` +
        `<td class="mk">${m.name}</td><td></td>`;
      tr.lastChild.textContent = m.summary;
      markerTbody.appendChild(tr);
    }
  }

  function computeScale() {
    const fit = Math.floor(420 / Math.max(result.width, result.height));
    scale = Math.max(1, Math.min(12, fit || 1));
  }

  function drawView() {
    if (!result) return;
    const r = result;
    const W = r.width * scale, H = r.height * scale;
    view.width = W; view.height = H;
    const ctx = view.getContext('2d');

    // 图像（最近邻放大）
    const off = document.createElement('canvas');
    off.width = r.width; off.height = r.height;
    const octx = off.getContext('2d');
    const img = octx.createImageData(r.width, r.height);
    for (let i = 0; i < r.width * r.height; i++) {
      img.data[i * 4] = r.rgb[i * 3];
      img.data[i * 4 + 1] = r.rgb[i * 3 + 1];
      img.data[i * 4 + 2] = r.rgb[i * 3 + 2];
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, W, H);

    // 块网格（8×8 像素）
    if ($('show-block').checked) {
      ctx.strokeStyle = 'rgba(31,111,235,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 8; x < r.width; x += 8) line(ctx, x * scale, 0, x * scale, H);
      for (let y = 8; y < r.height; y += 8) line(ctx, 0, y * scale, W, y * scale);
      ctx.stroke();
    }
    // MCU 网格
    if ($('show-mcu').checked) {
      const mw = 8 * r.maxH, mh = 8 * r.maxV;
      ctx.strokeStyle = 'rgba(230,120,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = mw; x < r.width; x += mw) line(ctx, x * scale, 0, x * scale, H);
      for (let y = mh; y < r.height; y += mh) line(ctx, 0, y * scale, W, y * scale);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    // 选中高亮
    if (selection) {
      const { mcu, compId, blockX, blockY } = selection;
      const comp = r.components.find((c) => c.id === compId);
      const mw = 8 * r.maxH, mh = 8 * r.maxV;
      ctx.strokeStyle = '#e67300';
      ctx.lineWidth = 2;
      ctx.strokeRect(mcu.col * mw * scale, mcu.row * mh * scale,
        Math.min(mw, r.width - mcu.col * mw) * scale,
        Math.min(mh, r.height - mcu.row * mh) * scale);
      const bw = (8 * r.maxH) / comp.H, bh = (8 * r.maxV) / comp.V;
      ctx.strokeStyle = '#d6336c';
      ctx.strokeRect((mcu.col * mw + blockX * bw) * scale, (mcu.row * mh + blockY * bh) * scale,
        bw * scale, bh * scale);
      ctx.lineWidth = 1;
    }
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.moveTo(x1 + 0.5, y1 + 0.5);
    ctx.lineTo(x2 + 0.5, y2 + 0.5);
  }

  $('show-mcu').addEventListener('change', drawView);
  $('show-block').addEventListener('change', drawView);

  // ---------------- 选块 ----------------

  view.addEventListener('click', (e) => {
    if (!result) return;
    const rect = view.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);
    if (x < 0 || y < 0 || x >= result.width || y >= result.height) return;
    const r = result;
    const mw = 8 * r.maxH, mh = 8 * r.maxV;
    const col = Math.floor(x / mw), row = Math.floor(y / mh);
    const mcu = r.mcus[row * r.mcuCols + col];
    const comp = r.components.find((c) => c.id === activeComp);
    const lx = x - col * mw, ly = y - row * mh;
    const bx = Math.min(comp.H - 1, Math.floor((lx * comp.H) / mw));
    const by = Math.min(comp.V - 1, Math.floor((ly * comp.V) / mh));
    selection = { mcu, compId: activeComp, blockX: bx, blockY: by };
    drawView();
    renderDetail();
  });

  function renderDetail() {
    if (!result || !selection) {
      detailBox.className = 'block-detail empty';
      detailBox.textContent = result ? '点击左侧图像选择块' : '尚未选择块';
      return;
    }
    const r = result;
    const { mcu, compId, blockX, blockY } = selection;
    detailBox.className = 'block-detail';
    detailBox.innerHTML = '';

    const h3 = document.createElement('h3');
    h3.textContent = `MCU #${mcu.index}（行 ${mcu.row}，列 ${mcu.col}）· 重启段 #${mcu.restartIndex}`;
    detailBox.appendChild(h3);

    if (mcu.firstAfterRestart && mcu.index > 0) {
      const note = document.createElement('div');
      note.className = 'restart-note';
      const rst = r.markers.filter((m) => m.name.startsWith('RST'))[mcu.restartIndex - 1];
      const prev = r.mcus[mcu.index - 1];
      const tails = r.components.map((c) => {
        const b = prev.blocks.filter((x) => x.component === c.id).pop();
        return `分量${c.id}=${b.dcPredAfter}`;
      }).join('，');
      note.textContent =
        `本 MCU 是重启段起点：${rst ? rst.name + ' @ ' + hex0x(rst.offset) : 'RST'} 处全部 DC 预测器复位为 0` +
        `（复位前上一重启段结束时的预测器：${tails}）`;
      detailBox.appendChild(note);
    }

    // 分量页签
    const tabs = document.createElement('div');
    tabs.className = 'comp-tabs';
    for (const c of r.components) {
      const b = document.createElement('button');
      b.textContent = r.grayscale ? `分量 ${c.id}` : ['', 'Y', 'Cb', 'Cr'][c.id] || `分量 ${c.id}`;
      if (c.id === compId) b.classList.add('active');
      b.addEventListener('click', () => {
        activeComp = c.id;
        selection = { mcu, compId: c.id, blockX: Math.min(blockX, c.H - 1), blockY: Math.min(blockY, c.V - 1) };
        drawView();
        renderDetail();
      });
      tabs.appendChild(b);
    }
    detailBox.appendChild(tabs);

    const blk = mcu.blocks.find(
      (b) => b.component === compId && b.blockX === blockX && b.blockY === blockY);
    if (!blk) {
      const p = document.createElement('p');
      p.textContent = '该分量在此 MCU 中无此块。';
      detailBox.appendChild(p);
      return;
    }

    const comp = r.components.find((c) => c.id === compId);
    const kv = document.createElement('div');
    kv.innerHTML =
      `<div class="kv">块位置：MCU 内 (${blockX}, ${blockY}) · 分量平面块 (${mcu.col * comp.H + blockX}, ${mcu.row * comp.V + blockY})</div>` +
      `<div class="kv">DC 预测器：前 <b>${blk.dcPredBefore}</b> ＋ 差值 <b>${blk.dcDiff}</b> ＝ 后 <b>${blk.dcPredAfter}</b></div>` +
      `<div class="kv">量化表 Q${comp.tq} · Huffman DC${comp.td}/AC${comp.ta}</div>`;
    detailBox.appendChild(kv);

    addCoefTable(detailBox, '量化系数（熵解码输出，自然行优先）', blk.coefficients, false);
    addCoefTable(detailBox, '反量化结果（系数 × 量化表）', blk.dequantized, false);
  }

  function addCoefTable(parent, caption, values) {
    const cap = document.createElement('div');
    cap.className = 'coef-caption';
    cap.textContent = caption;
    parent.appendChild(cap);
    const t = document.createElement('table');
    t.className = 'coef-grid';
    for (let y = 0; y < 8; y++) {
      const tr = document.createElement('tr');
      for (let x = 0; x < 8; x++) {
        const td = document.createElement('td');
        const v = values[y * 8 + x];
        td.textContent = v;
        if (y === 0 && x === 0) td.classList.add('dc');
        else if (v !== 0) td.classList.add('nz');
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    parent.appendChild(t);
  }

  // ---------------- 导出 ----------------

  $('export-png').addEventListener('click', () => {
    if (!result) return;
    const c = document.createElement('canvas');
    c.width = result.width; c.height = result.height;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(result.width, result.height);
    for (let i = 0; i < result.width * result.height; i++) {
      img.data[i * 4] = result.rgb[i * 3];
      img.data[i * 4 + 1] = result.rgb[i * 3 + 1];
      img.data[i * 4 + 2] = result.rgb[i * 3 + 2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    c.toBlob((blob) => download(blob, `${baseName}.decoded.png`), 'image/png');
  });

  $('export-json').addEventListener('click', () => {
    if (!result) return;
    const out = [];
    for (const mcu of result.mcus)
      for (const b of mcu.blocks)
        out.push({
          mcu: mcu.index, component: b.component,
          block_x: b.blockX, block_y: b.blockY,
          coefficients: Array.from(b.coefficients),
        });
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    download(blob, `${baseName}.coefficients.json`);
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
})();
