/* UI：导入校验、调色板计算、视图渲染、ZIP 导出 */
(function () {
  const IPS = globalThis.IPS;
  const MAX_IMAGES = 8;
  const MAX_DIM = 512;

  const state = {
    images: [], // {name, width, height, data, hash}
    colorCount: 16,
    dither: true,
    selected: 0,
    view: "result", // original | result | heat
    palette: null, // [{r,g,b,a}]
    results: [], // 与 images 对齐：{indices, heat, usage}
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $("fileInput"),
    importBtn: $("importBtn"),
    exportBtn: $("exportBtn"),
    clearBtn: $("clearBtn"),
    colorCount: $("colorCount"),
    colorCountNum: $("colorCountNum"),
    dither: $("dither"),
    status: $("status"),
    thumbs: $("thumbs"),
    tabs: document.querySelectorAll("#tabs button"),
    canvas: $("canvas"),
    canvasInfo: $("canvasInfo"),
    paletteStrip: $("paletteStrip"),
    usage: $("usage"),
  };
  const ctx = els.canvas.getContext("2d");

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle("error", !!isError);
  }

  // ---------- 导入 ----------
  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    importFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
  });

  async function importFiles(files) {
    if (!files.length) return;
    const errors = [];
    let list = files;
    if (files.length > MAX_IMAGES) {
      errors.push(`一次最多导入 ${MAX_IMAGES} 张，已忽略多余的 ${files.length - MAX_IMAGES} 张`);
      list = files.slice(0, MAX_IMAGES);
    }
    const images = [];
    for (const f of list) {
      try {
        const buf = await f.arrayBuffer();
        const img = await IPS.decodePng(buf);
        if (img.width > MAX_DIM || img.height > MAX_DIM) {
          throw new Error(`尺寸 ${img.width}×${img.height} 超限（最大 ${MAX_DIM}×${MAX_DIM}）`);
        }
        images.push({
          name: f.name.replace(/\.[^.]*$/, "") || "image",
          width: img.width,
          height: img.height,
          data: img.data,
        });
      } catch (err) {
        errors.push(`${f.name}：${err.message}`);
      }
    }
    if (!images.length) {
      setStatus(errors.join("；") || "没有可导入的图片", true);
      return;
    }
    // 规范化顺序：按内容哈希排序，导入顺序/重复导入不影响调色板
    for (const img of images) img.hash = IPS.imageHash(img);
    images.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    state.images = images;
    state.selected = 0;
    recompute();
    setStatus(
      `已导入 ${images.length} 张图片` + (errors.length ? `；${errors.join("；")}` : ""),
      errors.length > 0
    );
  }

  els.clearBtn.addEventListener("click", () => {
    state.images = [];
    state.palette = null;
    state.results = [];
    state.selected = 0;
    renderAll();
    setStatus("已清空");
  });

  // ---------- 参数 ----------
  function syncColorCount(v) {
    state.colorCount = Math.min(256, Math.max(2, v | 0));
    els.colorCount.value = state.colorCount;
    els.colorCountNum.value = state.colorCount;
    recompute();
  }
  els.colorCount.addEventListener("input", () => syncColorCount(+els.colorCount.value));
  els.colorCountNum.addEventListener("change", () => syncColorCount(+els.colorCountNum.value));
  els.dither.addEventListener("change", () => {
    state.dither = els.dither.checked;
    recompute();
  });

  // ---------- 计算 ----------
  function recompute() {
    if (!state.images.length) {
      state.palette = null;
      state.results = [];
      renderAll();
      return;
    }
    const bins = IPS.buildBins(state.images);
    const boxes = IPS.medianCut(bins, state.colorCount - 1); // 透明槽计入预算 K
    state.palette = IPS.buildPalette(boxes);
    state.results = state.images.map((img) =>
      IPS.quantizeImage(img, state.palette, state.dither)
    );
    renderAll();
  }

  // ---------- 渲染 ----------
  function renderAll() {
    renderThumbs();
    renderCanvas();
    renderPalette();
    renderUsage();
    els.exportBtn.disabled = !state.images.length;
  }

  function renderThumbs() {
    els.thumbs.innerHTML = "";
    state.images.forEach((img, i) => {
      const div = document.createElement("div");
      div.className = "thumb" + (i === state.selected ? " selected" : "");
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
        0,
        0
      );
      const label = document.createElement("span");
      label.textContent = `${img.name}（${img.width}×${img.height}）`;
      label.title = img.name;
      div.append(c, label);
      div.addEventListener("click", () => {
        state.selected = i;
        renderAll();
      });
      els.thumbs.appendChild(div);
    });
  }

  function renderCanvas() {
    const img = state.images[state.selected];
    if (!img) {
      ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
      els.canvasInfo.textContent = "尚未导入图片";
      return;
    }
    const { width: w, height: h } = img;
    els.canvas.width = w;
    els.canvas.height = h;
    const out = new Uint8ClampedArray(w * h * 4);
    const res = state.results[state.selected];
    if (state.view === "original" || !res) {
      out.set(img.data);
      els.canvasInfo.textContent = `原图 · ${img.name}`;
    } else if (state.view === "result") {
      const pal = state.palette;
      for (let p = 0; p < w * h; p++) {
        const c = pal[res.indices[p]];
        out[p * 4] = c.r;
        out[p * 4 + 1] = c.g;
        out[p * 4 + 2] = c.b;
        out[p * 4 + 3] = c.a;
      }
      els.canvasInfo.textContent = `结果 · ${img.name} · ${pal.length} 槽（含透明槽 0）`;
    } else {
      // 误差热图：线性 RGB 均方根误差，按本图最大误差归一化；透明像素为 0
      let max = 0;
      for (let p = 0; p < w * h; p++) if (res.heat[p] > max) max = res.heat[p];
      const scale = max > 0 ? 1 / max : 0;
      for (let p = 0; p < w * h; p++) {
        const t = res.heat[p] * scale;
        out[p * 4] = Math.min(255, Math.round(t * 2 * 255));
        out[p * 4 + 1] = Math.min(255, Math.round(Math.max(0, t * 2 - 1) * 255));
        out[p * 4 + 2] = Math.min(255, Math.round(Math.max(0, t * 2 - 1.5) * 2 * 255));
        out[p * 4 + 3] = 255;
      }
      els.canvasInfo.textContent =
        `误差热图 · ${img.name} · 最大误差 ${max.toFixed(4)}（按最大值归一化显示）`;
    }
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
  }

  els.tabs.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      els.tabs.forEach((b) => b.classList.toggle("active", b === btn));
      renderCanvas();
    })
  );

  function hex(c) {
    return (
      "#" +
      [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
    );
  }

  function renderPalette() {
    els.paletteStrip.innerHTML = "";
    if (!state.palette) return;
    state.palette.forEach((c, i) => {
      const sw = document.createElement("div");
      sw.className = "swatch" + (c.a === 0 ? " transparent" : "");
      sw.style.background = c.a === 0 ? "" : hex(c);
      sw.title = c.a === 0 ? "槽 0：透明" : `槽 ${i}：${hex(c)}`;
      const lab = document.createElement("span");
      lab.textContent = i;
      sw.appendChild(lab);
      els.paletteStrip.appendChild(sw);
    });
  }

  function renderUsage() {
    els.usage.innerHTML = "";
    if (!state.palette || !state.results.length) return;
    const total = new Uint32Array(state.palette.length);
    for (const r of state.results) {
      for (let i = 0; i < total.length; i++) total[i] += r.usage[i];
    }
    const grand = state.images.reduce((s, im) => s + im.width * im.height, 0);
    const h3 = document.createElement("h3");
    h3.textContent = "每色使用量（全部图片合计，含槽 0）";
    els.usage.appendChild(h3);
    state.palette.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "usage-row";
      const pct = grand ? (total[i] / grand) * 100 : 0;
      const sw = document.createElement("span");
      sw.className = "usage-swatch" + (c.a === 0 ? " transparent" : "");
      sw.style.background = c.a === 0 ? "" : hex(c);
      const bar = document.createElement("div");
      bar.className = "usage-bar";
      const fill = document.createElement("div");
      fill.style.width = pct.toFixed(2) + "%";
      bar.appendChild(fill);
      const txt = document.createElement("span");
      txt.className = "usage-text";
      txt.textContent = `槽 ${i}${c.a === 0 ? "（透明）" : " " + hex(c)} · ${total[i]} px · ${pct.toFixed(1)}%`;
      row.append(sw, bar, txt);
      els.usage.appendChild(row);
    });
  }

  // ---------- 导出 ----------
  els.exportBtn.addEventListener("click", () => {
    if (!state.images.length || !state.palette) return;
    const entries = [];
    const usedNames = new Set();
    const exported = [];
    state.images.forEach((img, i) => {
      let base = img.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "image";
      let name = base + ".png";
      let n = 2;
      while (usedNames.has(name)) name = `${base}-${n++}.png`;
      usedNames.add(name);
      const res = state.results[i];
      entries.push({
        name,
        data: IPS.encodeIndexedPng(img.width, img.height, res.indices, state.palette),
      });
      exported.push({ name, width: img.width, height: img.height });
    });

    const usageTotal = new Uint32Array(state.palette.length);
    for (const r of state.results) {
      for (let i = 0; i < usageTotal.length; i++) usageTotal[i] += r.usage[i];
    }
    const paletteJson = {
      transparentSlot: 0,
      slots: state.palette.map((c, i) => ({
        slot: i,
        hex: hex(c),
        r: c.r,
        g: c.g,
        b: c.b,
        alpha: c.a,
        usage: usageTotal[i],
      })),
    };
    const paramsJson = {
      colorCount: state.colorCount,
      dither: state.dither,
      paletteSlots: state.palette.length,
      transparentSlot: 0,
      images: exported,
    };
    const enc = new TextEncoder();
    entries.push({ name: "palette.json", data: enc.encode(JSON.stringify(paletteJson, null, 2)) });
    entries.push({ name: "params.json", data: enc.encode(JSON.stringify(paramsJson, null, 2)) });

    const zip = IPS.createZip(entries);
    const blob = new Blob([zip], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "indexed-palette-export.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    setStatus(`已导出 ${exported.length} 张索引 PNG + palette.json + params.json`);
  });

  renderAll();
})();
