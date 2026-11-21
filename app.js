/* 线阵相机 暗场/平场校正 —— 界面逻辑（计算在 calib-core.js） */
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  w: 0, h: 0,
  darks: [], // {name, t, data:Uint16Array}
  flats: [], // {name, t, level, data:Uint16Array}
  shot: null, // {name, t, data:Uint16Array}
  calib: null, ok: null, result: null,
  pixel: null,
  meta: null, // 拍摄记录 JSON（用于按文件名自动填 t/level）
};

const QUALITY_TEXT = ["0 无可用值", "1 直接校正", "2 坏点补值", "3 拍摄饱和"];
const QUALITY_COLOR = ["#202024", "#3a7d44", "#e6a817", "#d0342c"];

// ---------- 提示 ----------
function msg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = kind || "";
}

// ---------- 尺寸 ----------
function readSize() {
  const w = +$("inW").value, h = +$("inH").value;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1024 || h > 1024)
    throw new Error("请先填写有效尺寸（1–1024）");
  return { w, h };
}
function onSizeChange() {
  const w = +$("inW").value || 0, h = +$("inH").value || 0;
  if (w === S.w && h === S.h) return;
  S.w = w; S.h = h;
  S.darks = []; S.flats = []; S.shot = null;
  S.calib = null; S.ok = null; S.result = null; S.pixel = null;
  renderFrameTables(); refresh();
  msg("尺寸已变化，请重新导入各帧。", "");
}
$("inW").addEventListener("change", onSizeChange);
$("inH").addEventListener("change", onSizeChange);

// ---------- 帧导入 ----------
async function readFrame(file) {
  const { w, h } = readSize();
  const buf = await file.arrayBuffer();
  return DFC.parseU16(buf, w, h);
}

$("fileDarks").addEventListener("change", async (e) => {
  try {
    for (const f of e.target.files) S.darks.push({ name: f.name, t: NaN, data: await readFrame(f) });
    applyMeta(); renderFrameTables(); refresh(); msg("");
  } catch (err) { msg(err.message, "err"); }
  e.target.value = "";
});
$("fileFlats").addEventListener("change", async (e) => {
  try {
    for (const f of e.target.files) S.flats.push({ name: f.name, t: NaN, level: NaN, data: await readFrame(f) });
    applyMeta(); renderFrameTables(); refresh(); msg("");
  } catch (err) { msg(err.message, "err"); }
  e.target.value = "";
});
$("fileShot").addEventListener("change", async (e) => {
  try {
    const f = e.target.files[0];
    if (!f) return;
    S.shot = { name: f.name, t: parseFloat($("shotT").value), data: await readFrame(f) };
    $("shotName").textContent = f.name;
    applyMeta();
    if (S.shot && Number.isFinite(S.shot.t)) $("shotT").value = S.shot.t;
    if (S.calib) rejudge(); else refresh();
    msg("");
  } catch (err) { msg(err.message, "err"); }
  e.target.value = "";
});
$("shotT").addEventListener("change", () => {
  if (S.shot) S.shot.t = parseFloat($("shotT").value);
  if (S.calib && S.shot) rejudge();
});

function renderFrameTables() {
  const mk = (tbl, frames, cols) => {
    tbl.innerHTML = "";
    if (!frames.length) return;
    const head = tbl.insertRow();
    ["文件", ...cols, ""].forEach((t) => {
      const th = document.createElement("th"); th.textContent = t; head.appendChild(th);
    });
    frames.forEach((fr, idx) => {
      const tr = tbl.insertRow();
      const tdN = tr.insertCell(); tdN.textContent = fr.name; tdN.className = "fname"; tdN.title = fr.name;
      cols.forEach((c) => {
        const td = tr.insertCell();
        const inp = document.createElement("input");
        inp.type = "number"; inp.step = "any";
        inp.value = Number.isFinite(fr[c]) ? fr[c] : "";
        inp.addEventListener("change", () => { fr[c] = parseFloat(inp.value); });
        td.appendChild(inp);
      });
      const tdX = tr.insertCell();
      const btn = document.createElement("button"); btn.textContent = "×";
      btn.addEventListener("click", () => { frames.splice(idx, 1); renderFrameTables(); refresh(); });
      tdX.appendChild(btn);
    });
  };
  mk($("tblDarks"), S.darks, ["t"]);
  mk($("tblFlats"), S.flats, ["t", "level"]);
  const cnt = (el, n) => {
    el.textContent = n ? `${n} 张` : "";
    el.className = "cnt" + (n && (n < 3 || n > 12) ? " bad" : "");
  };
  cnt($("cntDarks"), S.darks.length);
  cnt($("cntFlats"), S.flats.length);
}

// ---------- 拍摄记录 JSON ----------
// 按拍摄记录把 t/level 填到已导入的同名帧上；返回未匹配的文件名
function applyMeta() {
  const o = S.meta;
  if (!o) return [];
  const miss = [];
  const fill = (list, entries, keys) => {
    for (const ent of entries || []) {
      const fr = list.find((f) => f.name === ent.file);
      if (!fr) { miss.push(ent.file); continue; }
      keys.forEach((k) => { fr[k] = ent[k]; });
    }
  };
  fill(S.darks, o.darks, ["t"]);
  fill(S.flats, o.flats, ["t", "level"]);
  if (o.shot) {
    if (S.shot && S.shot.name === o.shot.file) S.shot.t = o.shot.t;
    else if (S.shot) miss.push(o.shot.file);
  }
  return miss;
}

$("fileMeta").addEventListener("change", async (e) => {
  try {
    const o = JSON.parse(await e.target.files[0].text());
    S.meta = o;
    if (o.w && o.h) { $("inW").value = o.w; $("inH").value = o.h; }
    if (o.clip != null) $("thClip").value = o.clip;
    if (o.darkMax != null) $("thDarkMax").value = o.darkMax;
    if (o.gainMin != null) $("thGainMin").value = o.gainMin;
    if (o.gainMax != null) $("thGainMax").value = o.gainMax;
    onSizeChange();
    if (o.shot) $("shotT").value = o.shot.t;
    const miss = applyMeta();
    renderFrameTables(); refresh();
    msg(miss.length ? "记录已载入；以下文件尚未导入：" + miss.join("、") : "记录已载入并匹配。", miss.length ? "err" : "ok");
  } catch (err) { msg("记录 JSON 解析失败：" + err.message, "err"); }
  e.target.value = "";
});

// ---------- 阈值 ----------
function readThresholds() {
  return {
    clip: +$("thClip").value,
    darkMax: +$("thDarkMax").value,
    gainMin: +$("thGainMin").value,
    gainMax: +$("thGainMax").value,
  };
}

// ---------- 计算 ----------
$("btnCompute").addEventListener("click", () => {
  try {
    const { w, h } = readSize();
    if (S.darks.length < 3 || S.darks.length > 12) throw new Error("暗场帧需 3–12 张");
    if (S.flats.length < 3 || S.flats.length > 12) throw new Error("平场帧需 3–12 张");
    for (const d of S.darks) if (!Number.isFinite(d.t)) throw new Error("暗场帧 " + d.name + " 缺少曝光时长");
    for (const f of S.flats)
      if (!Number.isFinite(f.t) || !Number.isFinite(f.level)) throw new Error("平场帧 " + f.name + " 缺少曝光时长或照度 level");
    S.calib = DFC.computeCalibration({ w, h, darks: S.darks, flats: S.flats, clip: readThresholds().clip });
    S.pixel = null;
    rejudge();
    msg("校准完成。", "ok");
  } catch (err) { msg(err.message, "err"); }
});

$("btnRejudge").addEventListener("click", () => { rejudge(); msg("已按当前阈值重新判定。", "ok"); });
$("optRepair").addEventListener("change", () => { if (S.calib) rejudge(); });

function rejudge() {
  if (!S.calib) return;
  const th = readThresholds();
  S.ok = DFC.judgeOk(S.calib, th);
  if (S.shot) {
    if (!Number.isFinite(S.shot.t)) { msg("待校正图缺少曝光时长", "err"); return; }
    S.result = DFC.correctShot({
      shot: S.shot.data, tShot: S.shot.t, clip: th.clip,
      calib: S.calib, ok: S.ok, repair: $("optRepair").checked,
    });
  }
  refresh();
}

// ---------- 校准导入 / 导出 ----------
$("btnExportCalib").addEventListener("click", () => {
  download(new Blob([DFC.exportCalibration(S.calib, readThresholds())], { type: "application/json" }), "calibration.json");
});
$("fileCalib").addEventListener("change", async (e) => {
  try {
    const { calib, th } = DFC.importCalibration(await e.target.files[0].text());
    if (S.w && S.h && (calib.w !== S.w || calib.h !== S.h))
      throw new Error(`校准尺寸 ${calib.w}×${calib.h} 与当前 ${S.w}×${S.h} 不符`);
    $("inW").value = calib.w; $("inH").value = calib.h;
    S.w = calib.w; S.h = calib.h;
    $("thClip").value = th.clip; $("thDarkMax").value = th.darkMax;
    $("thGainMin").value = th.gainMin; $("thGainMax").value = th.gainMax;
    S.calib = calib; S.pixel = null;
    rejudge();
    msg("校准已导入，可直接校正同尺寸新图。", "ok");
  } catch (err) { msg("校准导入失败：" + err.message, "err"); }
  e.target.value = "";
});

// ---------- 结果导出 ----------
$("btnExportF32").addEventListener("click", () => {
  download(new Blob([DFC.exportCorrectedF32(S.result)], { type: "application/octet-stream" }), "corrected.f32");
});
$("btnExportQual").addEventListener("click", () => {
  download(new Blob([DFC.exportQualityU8(S.result)], { type: "application/octet-stream" }), "quality.u8");
});
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 渲染 ----------
function refresh() {
  $("btnRejudge").disabled = !S.calib;
  $("btnExportCalib").disabled = !S.calib;
  $("btnExportF32").disabled = !S.result;
  $("btnExportQual").disabled = !S.result;
  renderRaw(); renderCorr(); renderCalib(); renderQual(); renderInspector();
}

function fitCanvas(cv, w, h) {
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv.getContext("2d");
}
function blank(cv) {
  const ctx = cv.getContext("2d");
  cv.width = cv.width || 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cv.width, cv.height);
}
function grayImage(ctx, w, h, valueAt) {
  const img = ctx.createImageData(w, h);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < w * h; i++) {
    const v = valueAt(i);
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi <= lo) hi = lo + 1;
  for (let i = 0; i < w * h; i++) {
    const v = valueAt(i);
    const o = i * 4;
    if (Number.isFinite(v)) {
      const g = Math.round(((v - lo) / (hi - lo)) * 255);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
    } else {
      img.data[o] = 255; img.data[o + 1] = 0; img.data[o + 2] = 255; // NaN 品红
    }
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function markPixel(cv) {
  if (S.pixel == null || !S.w) return;
  const x = S.pixel % S.w, y = Math.floor(S.pixel / S.w);
  const ctx = cv.getContext("2d");
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = Math.max(1, Math.min(S.w, S.h) / 200);
  ctx.strokeRect(x - 1.5, y - 1.5, 4, 4);
}

function renderRaw() {
  const cv = $("cvRaw");
  if (!S.shot) { blank(cv); return; }
  const ctx = fitCanvas(cv, S.w, S.h);
  grayImage(ctx, S.w, S.h, (i) => S.shot.data[i]);
  markPixel(cv);
}
function renderCorr() {
  const cv = $("cvCorr");
  if (!S.result) { blank(cv); return; }
  const ctx = fitCanvas(cv, S.w, S.h);
  grayImage(ctx, S.w, S.h, (i) => S.result.corr[i]);
  markPixel(cv);
}
function renderCalib() {
  const cv = $("cvCalib");
  if (!S.calib) { blank(cv); return; }
  const key = $("selCalibMap").value || "gain";
  const ctx = fitCanvas(cv, S.w, S.h);
  grayImage(ctx, S.w, S.h, (i) => (S.ok && S.ok[i] ? S.calib[key][i] : NaN));
  // 判坏像素叠红
  if (S.ok) {
    const img = ctx.getImageData(0, 0, S.w, S.h);
    for (let i = 0; i < S.w * S.h; i++) {
      if (!S.ok[i]) { img.data[i * 4] = 208; img.data[i * 4 + 1] = 52; img.data[i * 4 + 2] = 44; }
    }
    ctx.putImageData(img, 0, 0);
  }
  markPixel(cv);
}
$("selCalibMap").addEventListener("change", renderCalib);

function renderQual() {
  const cv = $("cvQual");
  if (!S.result) { blank(cv); return; }
  const ctx = fitCanvas(cv, S.w, S.h);
  const img = ctx.createImageData(S.w, S.h);
  for (let i = 0; i < S.w * S.h; i++) {
    const c = QUALITY_COLOR[S.result.qual[i]];
    const o = i * 4;
    img.data[o] = parseInt(c.slice(1, 3), 16);
    img.data[o + 1] = parseInt(c.slice(3, 5), 16);
    img.data[o + 2] = parseInt(c.slice(5, 7), 16);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  markPixel(cv);
}

document.querySelectorAll("#views canvas").forEach((cv) => {
  cv.addEventListener("click", (e) => {
    if (!S.w || !S.h) return;
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * S.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * S.h);
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return;
    S.pixel = y * S.w + x;
    renderRaw(); renderCorr(); renderCalib(); renderQual(); renderInspector();
  });
});

// ---------- 像素检查 ----------
function fmt(v, d = 4) {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? +v.toFixed(d) : "NaN";
  return v;
}
function renderInspector() {
  const el = $("inspector");
  if (S.pixel == null || !S.calib) {
    el.innerHTML = "<h3>像素检查</h3><div class='hint'>" +
      (S.calib ? "点击任意视图查看参与拟合的样本。" : "请先计算或导入校准。") + "</div>";
    return;
  }
  const i = S.pixel, x = i % S.w, y = Math.floor(i / S.w);
  const th = readThresholds();
  const det = DFC.pixelDetail({
    i, calib: S.calib, th,
    darks: S.darks.length ? S.darks : null,
    flats: S.flats.length ? S.flats : null,
    clip: th.clip,
  });
  const q = S.result ? S.result.qual[i] : null;
  const okTag = S.ok && S.ok[i]
    ? "<span class='tag' style='background:#3a7d44;color:#fff'>有效</span>"
    : "<span class='tag' style='background:#d0342c;color:#fff'>判坏</span>";
  let html = `<h3>像素检查 (${x}, ${y}) ${okTag}</h3><div class="grid">`;
  html += `<div><span class="k">质量码：</span>${q == null ? "—" : `<span class="tag" style="background:${QUALITY_COLOR[q]};color:#fff">${QUALITY_TEXT[q]}</span>`}</div>`;
  html += `<div><span class="k">拍摄值：</span>${S.shot ? S.shot.data[i] : "—"}</div>`;
  html += `<div><span class="k">校正值：</span>${S.result ? fmt(S.result.corr[i]) : "—"}</div>`;
  html += `<div><span class="k">暗电平 bias：</span>${fmt(det.bias, 3)}</div>`;
  html += `<div><span class="k">暗斜率 slope：</span>${fmt(det.slope, 4)}（要求 0–${th.darkMax}，${det.slopeOk ? "通过" : "超限"}）</div>`;
  html += `<div><span class="k">增益 gain：</span>${fmt(det.gain, 4)}（要求 ${th.gainMin}–${th.gainMax}，${det.gainOk ? "通过" : "超限"}）</div>`;
  if (det.nDarkT != null) html += `<div><span class="k">暗场有效时长数：</span>${det.nDarkT}（≥3）</div>`;
  if (det.nFlat != null) html += `<div><span class="k">平场有效样本数：</span>${det.nFlat}（≥3）</div>`;
  html += `</div>`;

  if (det.darkSamples) {
    html += `<div class="k">暗场样本（达到 clip 不参与；两点斜率与截距均取中位数，对脉冲异常稳健）</div><table class="samples">` +
      `<tr><th>帧</th><th>曝光 t</th><th>值</th><th>参与</th><th>拟合值</th><th>残差</th></tr>`;
    for (const s of det.darkSamples)
      html += `<tr class="${s.used ? "" : "excluded"}"><td>${s.name}</td><td>${s.t}</td><td>${s.v}</td>` +
        `<td>${s.used ? "✓" : "饱和"}</td><td>${fmt(s.fit, 2)}</td><td>${fmt(s.resid, 2)}</td></tr>`;
    html += `</table>`;
  }
  if (det.flatSamples) {
    html += `<div class="k">平场样本（信号 = 帧值 − 暗场估计；增益估计 = 信号 / level）</div><table class="samples">` +
      `<tr><th>帧</th><th>曝光 t</th><th>level</th><th>值</th><th>参与</th><th>信号</th><th>增益估计</th></tr>`;
    for (const s of det.flatSamples)
      html += `<tr class="${s.used ? "" : "excluded"}"><td>${s.name}</td><td>${s.t}</td><td>${s.level}</td><td>${s.v}</td>` +
        `<td>${s.used ? "✓" : "饱和"}</td><td>${fmt(s.signal, 2)}</td><td>${fmt(s.gainEst, 4)}</td></tr>`;
    html += `</table>`;
  }
  if (!det.darkSamples && !det.flatSamples)
    html += `<div class="hint">当前校准来自导入文件，训练帧不在内存，无法列出样本。</div>`;
  el.innerHTML = html;
}

// 初始
blank($("cvRaw")); blank($("cvCorr")); blank($("cvCalib")); blank($("cvQual"));
