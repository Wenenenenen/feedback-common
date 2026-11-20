/* 星座图音频来源检索前端（无框架、无构建） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const state = {
  library: [],
  query: null,          // 最近一次查询响应
  showLines: true,
  pairIndexById: new Map(),
  querySeq: 0,          // 查询请求序号，防止响应乱序覆盖
};
window.__finderState = state;

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  setTimeout(() => t.classList.add("hidden"), 3200);
  t.classList.remove("hidden");
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function postForm(path, formData) {
  return api(path, { method: "POST", body: formData });
}

/* ---------------- 素材库 ---------------- */
// 来源区间试听：播放时显式跳到 data-start，到达 data-end 自动暂停
document.addEventListener("play", (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLAudioElement) || el.dataset.start == null) return;
  const start = parseFloat(el.dataset.start);
  const end = parseFloat(el.dataset.end);
  if (el.dataset.armed !== "1" || Math.abs(el.currentTime - start) > 0.05) {
    el.dataset.armed = "1";
    el.currentTime = start;
  }
  const onTime = () => {
    if (el.paused) { el.removeEventListener("timeupdate", onTime); el.dataset.armed = ""; return; }
    if (el.currentTime >= end) {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.dataset.armed = "";
    }
  };
  el.addEventListener("timeupdate", onTime);
}, true);

async function loadLibrary() {
  const data = await api("/api/library");
  state.library = data.files;
  $("#lib-count").textContent = `${data.files.length}/${data.max_files}`;
  const list = $("#library-list");
  if (!data.files.length) {
    list.innerHTML = `<div class="lib-empty">素材库为空<br>请添加 WAV 文件</div>`;
    return;
  }
  list.innerHTML = "";
  data.files.forEach((f) => {
    const div = document.createElement("div");
    div.className = "lib-item";
    div.innerHTML = `
      <div class="lib-name"><span title="${f.file_id}">${f.file_id}</span></div>
      <div class="lib-meta">
        ${f.duration.toFixed(3)}s · ${f.n_peaks} 峰 · ${f.n_pairs} 配对<br>
        sha256 ${f.sha256.slice(0, 16)}…
      </div>
      <div class="lib-actions">
        <button class="btn btn-ghost act-const">查看星座图</button>
        <button class="btn btn-ghost act-remove">移除</button>
      </div>`;
    div.querySelector(".act-remove").onclick = () => removeFile(f.file_id);
    div.querySelector(".act-const").onclick = () => showLibraryConstellation(f.file_id);
    list.appendChild(div);
  });
}

async function removeFile(fileId) {
  if (!confirm(`确认从素材库移除「${fileId}」？索引与本地副本将一并删除。`)) return;
  try {
    await api("/api/library/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    toast(`已移除 ${fileId}`);
    await loadLibrary();
  } catch (e) { toast(e.message, true); }
}

$("#lib-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file, file.name);
  try {
    const r = await postForm("/api/library/add", fd);
    toast(`已导入：${r.file_id}`);
    await loadLibrary();
  } catch (e) { toast(e.message, true); }
  ev.target.value = "";
});

$("#btn-rebuild").onclick = async () => {
  try {
    const r = await api("/api/rebuild", { method: "POST" });
    toast(`索引重建完成，共 ${r.imported.length} 条`);
    await loadLibrary();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- 查询 ---------------- */
$("#query-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $("#query-name").textContent = file.name;
  const fd = new FormData();
  fd.append("file", file, file.name);
  const seq = ++state.querySeq;
  try {
    const data = await postForm("/api/query", fd);
    if (seq !== state.querySeq) return;  // 已有更新的查询，丢弃过期响应
    state.query = data;
    renderQuery(data);
  } catch (e) {
    if (seq === state.querySeq) toast(e.message, true);
  }
  ev.target.value = "";
});

function renderQuery(data) {
  const sum = $("#query-summary");
  sum.classList.remove("hidden");
  const silent = data.silent
    ? `<span class="chip warn">静音 / 无有效频谱峰</span>` : "";
  sum.innerHTML = `
    <span class="chip">时长 <b>${data.duration_seconds}s</b></span>
    <span class="chip">频谱峰 <b>${data.n_peaks}</b></span>
    <span class="chip">配对指纹 <b>${data.n_pairs}</b></span>
    ${silent}`;

  drawConstellation(data.constellation);
  renderVerdict(data);
  renderResults(data);

  const hasQ = !!data.query_id;
  $("#report-json").classList.toggle("disabled", !hasQ);
  $("#report-md").classList.toggle("disabled", !hasQ);
  if (hasQ) {
    $("#report-json").href = `/api/report?query_id=${data.query_id}&format=json`;
    $("#report-md").href = `/api/report?query_id=${data.query_id}&format=markdown`;
  }
}

function renderVerdict(data) {
  const v = $("#verdict");
  v.classList.remove("hidden");
  if (data.has_reliable_match) {
    v.className = "verdict good";
    const names = data.reliable_matches.map((m) => `「${m.file_id}」@${m.offset_samples}`).join("、");
    v.innerHTML = `<h3>✔ 可靠匹配 ${data.reliable_matches.length} 个来源</h3>
      <div>${names}</div>
      <div style="color:var(--muted);margin-top:4px;font-size:12px">
        门槛：票数 ≥ ${data.thresholds.min_votes} 且匹配比例 ≥ ${data.thresholds.min_score}</div>`;
  } else {
    v.className = "verdict bad";
    const reason = data.silent ? "查询为静音，未提取到任何频谱峰。" :
      data.n_pairs === 0 ? "查询未产生配对指纹。" :
      "没有来源同时达到票数与匹配比例门槛（可能为无关音频）。";
    v.innerHTML = `<h3>✘ 无可靠匹配</h3><div>${reason}</div>
      <div style="color:var(--muted);margin-top:4px;font-size:12px">
        下方仍列出全部参考的最高票候选，仅供排查。</div>`;
  }
}

function renderResults(data) {
  const box = $("#results");
  box.innerHTML = "";
  if (!data.results.length) {
    box.innerHTML = `<div class="lib-empty">素材库为空，无法检索</div>`;
    return;
  }
  // 标记重复来源：偏移与票数一致且均可靠
  const reliable = data.results.filter((r) => r.reliable);
  const groups = new Map();
  reliable.forEach((r) => {
    const key = `${r.offset_samples}:${r.votes}`;
    groups.set(key, [...(groups.get(key) || []), r.file_id]);
  });

  data.results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "result-card" + (r.reliable ? " reliable" : "");
    const key = `${r.offset_samples}:${r.votes}`;
    const dup = r.reliable && groups.get(key).length > 1
      ? `<div class="dup-note">重复来源：与 ${groups.get(key).filter((x) => x !== r.file_id).join("、")} 指纹一致，同时列出</div>` : "";
    card.innerHTML = `
      <div class="rc-head">
        <span class="rc-name">${r.file_id}</span>
        <span class="tag ${r.reliable ? "ok" : "no"}">${r.reliable ? "可靠匹配" : "未达门槛"}</span>
      </div>
      <div class="rc-grid">
        <span class="k">起点（样本 d×128）</span><span class="v">${r.offset_samples}</span>
        <span class="k">起点（秒）</span><span class="v">${r.offset_seconds.toFixed(4)}s</span>
        <span class="k">支持票数 / 查询总配对</span><span class="v">${r.votes} / ${r.query_total_pairs}</span>
        <span class="k">匹配比例 score</span><span class="v">${r.match_percent}%</span>
      </div>
      <div class="meter"><i style="width:${Math.min(100, r.match_percent)}%"></i></div>
      <div class="rc-audio">
        <label>来源对应区间（按投票偏移对齐，点击从起点播放）：</label>
        <audio controls preload="none" data-start="${r.offset_seconds}"
          data-end="${(r.offset_seconds + (state.query?.duration_seconds || 0)).toFixed(4)}"
          src="/api/audio?kind=library&file_id=${encodeURIComponent(r.file_id)}"></audio>
        <label>查询录音：</label>
        <audio controls preload="none" src="/api/audio?kind=query&query_id=${data.query_id}"></audio>
      </div>
      ${dup}`;
    box.appendChild(card);
  });
}

/* ---------------- 星座图绘制 ---------------- */
function drawConstellation(c) {
  const canvas = $("#constellation");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth - 16;
  const cssH = 420;
  canvas.style.width = cssW + "px";
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = cssW, H = cssH;
  const padL = 56, padB = 28, padT = 10, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, W, H);
  $("#canvas-empty").classList.add("hidden");

  const nFrames = c.n_frames || 1;
  const nBins = c.n_bins || 257;
  const xOf = (frame) => padL + (frame / Math.max(1, nFrames - 1)) * plotW;
  const yOf = (bin) => padT + plotH - (bin / (nBins - 1)) * plotH;

  // 热力图背景（下采样矩阵，按列用线性渐变平滑渲染，避免网格缝隙）
  const m = c.matrix;
  if (m && m.length) {
    const rows = m.length, cols = m[0].length;
    let maxV = 1e-9;
    for (const row of m) for (const v of row) if (v > maxV) maxV = v;
    const colW = plotW / cols;
    const rowH = plotH / rows;
    for (let j = 0; j < cols; j++) {
      const grad = ctx.createLinearGradient(0, padT + plotH, 0, padT);
      for (let i = 0; i < rows; i++) {
        const a = m[i][j] / maxV;
        const alpha = a < 0.04 ? 0 : Math.min(0.6, a * 0.55);
        grad.addColorStop(rows === 1 ? 0 : i / (rows - 1),
          `rgba(70,120,200,${alpha.toFixed(3)})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(padL + j * colW, padT, colW + 0.8, plotH);
    }
  }

  // 轴
  ctx.strokeStyle = "#2a3342"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  ctx.fillStyle = "#8b97a8"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
  const dur = nFrames * c.hop / c.sample_rate;
  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    const x = padL + p * plotW;
    ctx.fillText((dur * p).toFixed(2) + "s", x, H - 8);
  });
  ctx.textAlign = "right";
  [0, 2000, 4000, 6000, 8000].forEach((freq) => {
    const bin = freq / (c.sample_rate / c.nfft);
    const y = yOf(bin);
    ctx.fillText(freq + "Hz", padL - 7, y + 4);
  });

  // 配对连线
  state.pairIndexById.clear();
  if (state.showLines) {
    c.lines.forEach((ln, idx) => {
      ctx.strokeStyle = "rgba(122,162,255,0.4)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(xOf(ln.af), yOf(ln.ab));
      ctx.lineTo(xOf(ln.tf), yOf(ln.tb));
      ctx.stroke();
      // 用中点做点击命中区
      const mx = (xOf(ln.af) + xOf(ln.tf)) / 2;
      const my = (yOf(ln.ab) + yOf(ln.tb)) / 2;
      state.pairIndexById.set(`${idx}`, { mx, my, idx });
    });
  }

  // 峰
  c.peaks.forEach((p) => {
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(xOf(p.frame), yOf(p.bin), 2.2, 0, Math.PI * 2);
    ctx.fill();
  });

  canvas._geom = { xOf, yOf, padL, padT, plotW, plotH, constellation: c };
}

$("#toggle-lines").addEventListener("change", (e) => {
  state.showLines = e.target.checked;
  if (state.query) drawConstellation(state.query.constellation);
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.query) drawConstellation(state.query.constellation); }, 150);
});

/* 点击连线 -> 查询该配对为何投到某个时间 */
$("#constellation").addEventListener("click", async (ev) => {
  if (!state.query) return;
  const canvas = ev.target;
  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
  let best = null, bestD = 14;
  for (const [, info] of state.pairIndexById) {
    const d = Math.hypot(info.mx - cx, info.my - cy);
    if (d < bestD) { bestD = d; best = info; }
  }
  if (!best) { $("#pair-info").classList.add("hidden"); return; }
  const pairIdx = best.idx;
  const ln = state.query.constellation.lines[pairIdx];
  const info = $("#pair-info");
  info.classList.remove("hidden");
  info.innerHTML = `<h3>配对 #${pairIdx}：锚帧 ${ln.af}(${ln.at.toFixed(3)}s, ${ln.afreq.toFixed(0)}Hz)
    → 目标帧 ${ln.tf}(${ln.tt.toFixed(3)}s, ${ln.tfreq.toFixed(0)}Hz)，正在查询投票依据…</h3>`;
  try {
    const data = await api(`/api/explain?query_id=${state.query.query_id}&pair=${pairIdx}`);
    renderExplain(data, pairIdx);
  } catch (e) { info.innerHTML = `<h3 style="color:var(--danger)">${e.message}</h3>`; }
});

function renderExplain(d, pairIdx) {
  const info = $("#pair-info");
  const [ab, tb, df] = d.hash_tuple;
  let rows;
  if (!d.postings.length) {
    rows = `<tr><td colspan="4" style="color:var(--muted)">该哈希在库索引中无任何发布记录，不产生投票。</td></tr>`;
  } else {
    rows = d.postings.map((p) => `
      <tr>
        <td><code>${p.file_id}</code></td>
        <td>帧 ${p.ref_anchor_frame}（${p.ref_anchor_seconds.toFixed(4)}s）</td>
        <td>d = ${p.ref_anchor_frame} − ${d.query_anchor.frame} = <b>${p.offset_d}</b></td>
        <td>${p.offset_samples} 样本</td>
      </tr>`).join("");
  }
  const contrib = d.final_contributions.length
    ? d.final_contributions.map((x) => `${x.file_id}(原始偏移 ${x.raw_offset_d})`).join("、")
    : "未落入任何参考的最佳中心 ±1 范围，不计票";
  info.innerHTML = `
    <h3>配对 #${pairIdx} 的投票解释</h3>
    <div style="margin-bottom:8px;color:var(--muted)">
      哈希 = (锚箱 ${ab}, 目标箱 ${tb}, 帧差 ${df}) → 整数 <code>${d.hash}</code>；
      查询配对唯一标识 (锚帧 ${d.query_anchor.frame}, 锚箱 ${ab}, 目标帧 ${d.query_target.frame}, 目标箱 ${tb})
    </div>
    <table>
      <thead><tr><th>命中库文件</th><th>库内锚峰位置</th><th>偏移 d = 参考锚帧 − 查询锚帧</th><th>偏移样本</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:8px"><span class="kv">最终计票：</span>${contrib}
      （每个查询配对在每个参考的最佳中心下最多计 1 票，容差 [d−1, d+1]）</div>`;
}

/* ---------------- 库文件星座图（复用查询画布） ---------------- */
async function showLibraryConstellation(fileId) {
  try {
    const data = await api(`/api/constellation?file_id=${encodeURIComponent(fileId)}`);
    drawConstellation(data.constellation);
    $("#canvas-empty").classList.add("hidden");
    toast(`已绘制库文件「${fileId}」的星座图（${data.constellation.peaks.length} 峰）`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { toast(e.message, true); }
}

loadLibrary().catch((e) => toast(e.message, true));
