/* 稀疏角标增量编码器 —— 页面逻辑 */
'use strict';
(function () {
  const S = window.SparseSolver;
  const $ = id => document.getElementById(id);

  // ---------- 全局状态 ----------
  let norm = null;          // 规范化后的输入
  let solver = null;        // 当前求解器（含缓存与诊断）
  let solution = null;      // {ok:true,totalCost,plan} 或 {ok:false,failFrame,failStates}
  let simFrames = null;     // 方案的逐帧画布（显示前/中/后 + 补丁）
  let solveHistory = [];    // 历次求解结果，用于比较重算前后码量
  let dirty = false;        // 候选窗口在求解后被修改
  let curFrame = 1, curMode = 1;
  let viewSource = 'plan';  // plan | replay | state
  let replay = null;        // {parsed, frames, bad:[帧号...]}
  let inspect = null;       // {g, wi, idx, total, reason} 检查可达画布
  let hlWindow = -1, editIdx = -1;
  let playTimer = null;
  let scale = 5, checker = null;

  const view = $('view'), ctx = view.getContext('2d');
  const pixCanvas = document.createElement('canvas'), pixCtx = pixCanvas.getContext('2d');

  // ---------- 工具 ----------
  const DISP_NAMES = ['保留', '清窗口', '恢复'];
  function setStatus(html) { $('statusBar').innerHTML = html; }
  function showBanner(kind, html) {
    const b = $('banner');
    if (!html) { b.className = 'banner'; b.textContent = ''; return; }
    b.className = 'banner show ' + kind;
    b.innerHTML = html;
  }
  function totalWindows() { return norm ? norm.windows.reduce((s, ws) => s + ws.length, 0) : 0; }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  // 当前视图源的尺寸与帧数（JSON 方案或 SOP1 回放）
  function activeDims() {
    if (viewSource === 'replay' && replay) return { W: replay.parsed.W, H: replay.parsed.H, F: replay.parsed.F };
    if (norm) return { W: norm.W, H: norm.H, F: norm.F };
    if (replay) return { W: replay.parsed.W, H: replay.parsed.H, F: replay.parsed.F };
    return null;
  }

  function makeChecker() {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#262a34'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#1e222b'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(c, 'repeat');
  }

  function currentPalette() {
    if (viewSource === 'replay' && replay) return replay.parsed.palette;
    return norm ? norm.palette : [];
  }

  function currentPixels() {
    if (viewSource === 'state' && inspect && solver) return solver.stateCanvas(inspect.g, inspect.wi);
    const frames = viewSource === 'replay' ? (replay && replay.frames) : simFrames;
    if (!frames) return norm ? norm.T[curFrame] : null;
    const fr = frames[curFrame - 1];
    return curMode === 0 ? fr.pre : curMode === 1 ? fr.disp : fr.post;
  }

  // ---------- 画布绘制 ----------
  function draw() {
    const pix = currentPixels();
    const dims = activeDims();
    if (!dims || !pix) { ctx.clearRect(0, 0, view.width, view.height); return; }
    const { W, H } = dims;
    const pal = currentPalette();
    const img = pixCtx.createImageData(W, H);
    const d32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < pix.length; i++) {
      const v = pix[i];
      if (v === 0) { d32[i] = 0; continue; }
      const c = pal[v - 1] || [255, 0, 255];
      d32[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]; // ABGR 小端
    }
    pixCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = checker;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.drawImage(pixCanvas, 0, 0, W * scale, H * scale);

    // 窗口叠加
    if (viewSource === 'plan') {
      const ws = norm.windows[curFrame] || [];
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ws.forEach((w, i) => {
        if (i === hlWindow) return;
        ctx.strokeRect(w.x0 * scale + .5, w.y0 * scale + .5, (w.x1 - w.x0) * scale - 1, (w.y1 - w.y0) * scale - 1);
      });
      if (hlWindow >= 0 && ws[hlWindow]) {
        const w = ws[hlWindow];
        ctx.lineWidth = 2; ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(w.x0 * scale + 1, w.y0 * scale + 1, (w.x1 - w.x0) * scale - 2, (w.y1 - w.y0) * scale - 2);
      }
      if (solution && solution.ok) {
        const st = solution.plan[curFrame - 1];
        ctx.lineWidth = 2; ctx.strokeStyle = '#34d399';
        ctx.strokeRect(st.x0 * scale + 1, st.y0 * scale + 1, (st.x1 - st.x0) * scale - 2, (st.y1 - st.y0) * scale - 2);
      }
    } else if (viewSource === 'replay' && replay) {
      const r = replay.parsed.records[curFrame - 1];
      ctx.lineWidth = 2; ctx.strokeStyle = '#60a5fa';
      ctx.strokeRect(r.x0 * scale + 1, r.y0 * scale + 1, r.w * scale - 2, r.h * scale - 2);
    }
  }

  // ---------- 帧/模式切换 ----------
  function setFrame(f) {
    const dims = activeDims();
    if (!dims) return;
    curFrame = Math.max(1, Math.min(dims.F, f));
    $('frameSlider').max = dims.F;
    $('frameSlider').value = curFrame;
    updateFrameLabel(); draw(); updateStepInfo(); updateWinPanel();
  }
  function updateFrameLabel() {
    const dims = activeDims();
    $('frameLabel').textContent = dims ? `第 ${curFrame} / ${dims.F} 帧` : '—';
  }
  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $('btnPlay').textContent = '▶ 播放'; }
  }

  // ---------- 状态栏与结果面板 ----------
  function refreshStatus() {
    if (!norm) return;
    let html = `画布 <b>${norm.W}×${norm.H}</b> · <b>${norm.F}</b> 帧 · 候选窗口 <b>${totalWindows()}</b> 个 · 调色板 <b>${norm.palette.length}</b> 色`;
    if (solution && solution.ok) html += ` · 总代价 <b>${solution.totalCost}</b> 字节`;
    if (solution && !solution.ok) html += ` · <span style="color:var(--bad)">第 ${solution.failFrame} 帧起不可达</span>`;
    if (dirty) html += ' · <span style="color:var(--warn)">候选窗口已修改，方案为修改前结果，请重算</span>';
    setStatus(html);
  }

  function refreshCostPanel() {
    if (!solveHistory.length) { $('costBody').innerHTML = '<span class="dim">尚未求解。</span>'; return; }
    let html = '';
    solveHistory.forEach((h, i) => {
      let delta = '';
      if (i > 0 && h.ok && solveHistory[i - 1].ok) {
        const d = h.cost - solveHistory[i - 1].cost;
        const cls = d > 0 ? 'deltaUp' : d < 0 ? 'deltaDown' : 'dim';
        delta = ` <span class="${cls}">（较上次 ${d > 0 ? '+' : ''}${d}）</span>`;
      }
      html += `<div class="histItem">第 ${i + 1} 次：${h.ok ? `总代价 <b>${h.cost}</b> 字节` : `<span class="tag bad">不可行</span> 最早不可达第 ${h.failFrame} 帧`}${delta} <span class="dim">· ${h.ms} ms</span></div>`;
    });
    if (solution && solution.ok) {
      const headerBytes = 4 + 2 + 2 + 2 + norm.palette.length * 3;
      html += `<div class="histItem dim">SOP1 文件共 ${headerBytes + solution.totalCost} 字节 = 固定头 ${headerBytes} + 包内代价 ${solution.totalCost}</div>`;
    }
    $('costBody').innerHTML = html;
  }

  // ---------- 方案面板 ----------
  function updateStepInfo() {
    if (!solution || !solution.ok) { $('stepInfo').innerHTML = ''; return; }
    const st = solution.plan[curFrame - 1];
    let cum = 0;
    for (let i = 0; i < curFrame; i++) cum += solution.plan[i].cost;
    $('stepInfo').innerHTML =
      `窗口 <span class="mono">(${st.x0},${st.y0}) → (${st.x1},${st.y1})</span> · ${st.x1 - st.x0}×${st.y1 - st.y0} · ` +
      `处置 <b>${DISP_NAMES[st.d]}</b> · 帧代价 <b>${st.cost}</b> · 累计 <b>${cum}</b>`;
    const rows = $('planTable').tBodies[0].rows;
    for (let i = 0; i < rows.length; i++) rows[i].className = i === curFrame - 1 ? 'sel' : '';
  }

  function buildPlanTable() {
    const tb = $('planTable').tBodies[0];
    tb.innerHTML = '';
    if (!solution || !solution.ok) return;
    solution.plan.forEach((st, i) => {
      const tr = tb.insertRow();
      tr.insertCell().textContent = i + 1;
      tr.insertCell().textContent = `(${st.x0},${st.y0},${st.x1},${st.y1})`;
      tr.insertCell().textContent = DISP_NAMES[st.d];
      tr.insertCell().textContent = st.cost;
      tr.onclick = () => { setFrame(i + 1); };
    });
  }

  // ---------- 候选窗口编辑 ----------
  function updateWinPanel() {
    if (!norm) return;
    $('winFrameNo').textContent = curFrame;
    const tb = $('winTable').tBodies[0];
    tb.innerHTML = '';
    (norm.windows[curFrame] || []).forEach((w, i) => {
      const tr = tb.insertRow();
      if (i === hlWindow) tr.className = 'hl';
      tr.insertCell().textContent = i;
      tr.insertCell().textContent = `(${w.x0},${w.y0}) → (${w.x1},${w.y1})`;
      tr.insertCell().textContent = w.area;
      const td = tr.insertCell();
      const bEdit = document.createElement('button'); bEdit.textContent = '改';
      bEdit.onclick = e => { e.stopPropagation(); startEdit(i); };
      const bDel = document.createElement('button'); bDel.textContent = '删';
      bDel.onclick = e => { e.stopPropagation(); delWindow(i); };
      td.append(bEdit, ' ', bDel);
      tr.onclick = () => { hlWindow = i; draw(); updateWinPanel(); };
    });
  }

  function readWinForm() {
    const v = ['inX0', 'inY0', 'inX1', 'inY1'].map(id => $(id).value.trim());
    if (v.some(s => s === '' || !/^-?\d+$/.test(s))) { alert('请填写 4 个整数坐标'); return null; }
    const [x0, y0, x1, y1] = v.map(Number);
    if (!(0 <= x0 && x0 < x1 && x1 <= norm.W && 0 <= y0 && y0 < y1 && y1 <= norm.H)) {
      alert(`窗口为空或越出画布（需 0≤x0<x1≤${norm.W}，0≤y0<y1≤${norm.H}）`); return null;
    }
    return { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) };
  }

  function markDirty() {
    dirty = true;
    refreshStatus();
    $('btnExport').disabled = true;
  }

  function addWindow() {
    const w = readWinForm(); if (!w) return;
    const ws = norm.windows[curFrame];
    if (ws.length >= 48) { alert('该帧候选窗口已达 48 个上限'); return; }
    if (totalWindows() >= 6000) { alert('全片候选窗口已达 6000 个上限'); return; }
    ws.push(w);
    hlWindow = ws.length - 1;
    markDirty(); updateWinPanel(); draw();
  }

  function startEdit(i) {
    const w = norm.windows[curFrame][i];
    editIdx = i; hlWindow = i;
    $('inX0').value = w.x0; $('inY0').value = w.y0; $('inX1').value = w.x1; $('inY1').value = w.y1;
    $('btnAddWin').hidden = true; $('btnUpdWin').hidden = false; $('btnCancelEdit').hidden = false;
    updateWinPanel(); draw();
  }

  function updateWindow() {
    const w = readWinForm(); if (!w) return;
    norm.windows[curFrame][editIdx] = w;
    cancelEdit(); markDirty(); updateWinPanel(); draw();
  }

  function delWindow(i) {
    norm.windows[curFrame].splice(i, 1);
    if (hlWindow >= norm.windows[curFrame].length) hlWindow = norm.windows[curFrame].length - 1;
    cancelEdit(); markDirty(); updateWinPanel(); draw();
  }

  function cancelEdit() {
    editIdx = -1;
    $('btnAddWin').hidden = false; $('btnUpdWin').hidden = true; $('btnCancelEdit').hidden = true;
  }

  // ---------- 求解 ----------
  async function runSolve() {
    if (!norm) return;
    stopPlay();
    $('btnSolve').disabled = true;
    solver = S.createSolver(norm);
    const gen = solver.solve();
    const t0 = performance.now();
    let r;
    while (!(r = gen.next()).done) {
      setStatus(`求解中… 帧 ${r.value.frame}/${norm.F}，可达状态 ${r.value.states} 个`);
      await new Promise(res => setTimeout(res, 0));
    }
    const ms = Math.round(performance.now() - t0);
    solution = r.value;
    dirty = false;
    inspect = null; viewSource = 'plan'; updateSrcTabs();
    if (solution.ok) {
      simFrames = S.simulate(norm, solution.plan);
      solveHistory.push({ ok: true, cost: solution.totalCost, ms });
      $('failPanel').hidden = true;
      $('planPanel').hidden = false;
      buildPlanTable();
      $('btnExport').disabled = false;
      showBanner(null);
    } else {
      simFrames = null;
      solveHistory.push({ ok: false, failFrame: solution.failFrame, ms });
      $('planPanel').hidden = true;
      $('btnExport').disabled = true;
      buildFailPanel();
      setFrame(solution.failFrame);
    }
    refreshStatus(); refreshCostPanel(); updateStepInfo(); draw();
    $('btnSolve').disabled = false;
  }

  // ---------- 不可达诊断 ----------
  function buildFailPanel() {
    const f = solution.failFrame, states = solution.failStates;
    let html = `<div style="margin-bottom:8px">最早无法到达：<b style="color:var(--bad)">第 ${f} 帧</b>。` +
      `第 ${f - 1} 帧后共有 <b>${states.length}</b> 个可达画布状态，均无法复现第 ${f} 帧目标：</div>`;
    html += '<div class="scroll" style="max-height:300px"><table><thead><tr><th>#</th><th>来源</th><th>累计代价</th><th>不可达原因</th><th></th></tr></thead><tbody>';
    states.forEach((st, i) => {
      const diag = solver.diagnose(st.g, st.wi, f);
      let reason;
      if (diag.bad > 0) reason = `旧像素非 0 而目标为 0 共 ${diag.bad} 处（补丁写 0=跳过，无法清除）`;
      else if (!diag.covered) reason = diag.bbox && diag.bbox[2] >= 0
        ? `差异区域 [${diag.bbox[0]},${diag.bbox[1]} ~ ${diag.bbox[2]},${diag.bbox[3]}] 不被任何候选窗口包含`
        : '无可用候选窗口';
      else reason = '—';
      const src = st.g === 0 ? '起始全 0 画布' : (st.wi < 0 ? `第 ${st.g} 帧目标画布` : `第 ${st.g} 帧目标经窗口 ${st.wi} 清零`);
      html += `<tr><td>${i}</td><td>${esc(src)}</td><td>${st.cost}</td><td>${esc(reason)}</td>` +
        `<td><button data-i="${i}" class="btnInspect">查看画布</button></td></tr>`;
    });
    html += '</tbody></table></div>';
    $('failBody').innerHTML = html;
    $('failPanel').hidden = false;
    $('failBody').querySelectorAll('.btnInspect').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.i;
        const st = states[i];
        const diag = solver.diagnose(st.g, st.wi, f);
        let reason;
        if (diag.bad > 0) reason = `旧像素非 0 而目标为 0 共 ${diag.bad} 处`;
        else if (!diag.covered) reason = '差异区域不被任何候选窗口包含';
        else reason = '';
        inspect = { g: st.g, wi: st.wi };
        viewSource = 'state';
        showBanner('warn', `检查可达画布 ${i + 1}/${states.length}：${st.g === 0 ? '起始全 0 画布' : st.wi < 0 ? `第 ${st.g} 帧目标画布` : `第 ${st.g} 帧目标经窗口 ${st.wi} 清零`}` +
          `（累计代价 ${st.cost}）—— 无法到达第 ${f} 帧：${reason}。<button id="btnBackPlan" style="margin-left:8px">返回方案视图</button>`);
        $('btnBackPlan').onclick = () => { inspect = null; viewSource = 'plan'; showBanner(null); draw(); };
        draw();
      };
    });
  }

  // ---------- SOP1 导出 / 导入 ----------
  function exportSOP1() {
    if (!solution || !solution.ok || dirty) return;
    const bin = S.buildSOP1(norm, solution.plan, simFrames);
    const blob = new Blob([bin], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'overlay-patches.sop1';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function importSOP1(buf) {
    let parsed;
    try { parsed = S.parseSOP1(new Uint8Array(buf)); }
    catch (e) { alert('SOP1 解析失败：' + e.message); return; }
    const frames = S.simulateSOP1(parsed);
    replay = { parsed, frames, bad: [] };
    let html = `画布 ${parsed.W}×${parsed.H} · ${parsed.F} 帧 · ${parsed.palette.length} 色 · 记录代价 ${parsed.records.reduce((s, r) => s + 6 + r.w * r.h, 0)} 字节`;
    if (norm && parsed.W === norm.W && parsed.H === norm.H && parsed.F === norm.F) {
      for (let f = 1; f <= norm.F; f++) {
        const disp = frames[f - 1].disp, T = norm.T[f];
        for (let p = 0; p < disp.length; p++) if (disp[p] !== T[p]) { replay.bad.push(f); break; }
      }
      html += replay.bad.length === 0
        ? `<br><span class="tag ok">校验通过：${norm.F} 帧显示画面与目标逐像素一致</span>`
        : `<br><span class="tag bad">校验失败：第 ${replay.bad.join('、')} 帧与目标不一致</span>`;
    } else {
      html += '<br><span class="dim">未加载匹配 JSON（或尺寸/帧数不符），仅回放，不校验。</span>';
    }
    $('replayBody').innerHTML = html;
    $('replayPanel').hidden = false;
    $('srcTabs').style.display = '';
    viewSource = 'replay'; updateSrcTabs();
    if (!norm) { // 未加载 JSON 时也要能回放：按 SOP1 尺寸初始化画布
      scale = Math.max(1, Math.min(24, Math.floor(640 / parsed.W), Math.floor(360 / parsed.H)));
      view.width = parsed.W * scale; view.height = parsed.H * scale;
      pixCanvas.width = parsed.W; pixCanvas.height = parsed.H;
      makeChecker();
    }
    curFrame = 1; setFrame(1);
  }

  function updateSrcTabs() {
    document.querySelectorAll('#srcTabs button').forEach(b => {
      b.classList.toggle('on', b.dataset.src === viewSource);
    });
  }

  // ---------- 输入加载 ----------
  function loadInput(obj) {
    const errs = S.validate(obj);
    if (errs.length) { alert('输入校验失败：\n' + errs.slice(0, 8).join('\n') + (errs.length > 8 ? `\n…共 ${errs.length} 项` : '')); return; }
    stopPlay();
    norm = S.normalize(obj);
    solver = null; solution = null; simFrames = null; dirty = false;
    solveHistory = []; inspect = null; viewSource = 'plan';
    replay = null; $('replayPanel').hidden = true; $('srcTabs').style.display = 'none';
    $('failPanel').hidden = true; $('planPanel').hidden = true;
    curFrame = 1; curMode = 1; hlWindow = -1; cancelEdit();
    scale = Math.max(1, Math.min(24, Math.floor(640 / norm.W), Math.floor(360 / norm.H)));
    view.width = norm.W * scale; view.height = norm.H * scale;
    pixCanvas.width = norm.W; pixCanvas.height = norm.H;
    makeChecker();
    $('frameSlider').max = norm.F;
    $('btnSolve').disabled = false;
    $('btnExport').disabled = true;
    $('winPanel').hidden = false;
    document.querySelectorAll('.modeTabs [data-mode]').forEach(b => b.classList.toggle('on', +b.dataset.mode === 1));
    showBanner(null);
    refreshStatus(); refreshCostPanel(); setFrame(1);
  }

  // ---------- 事件绑定 ----------
  $('btnLoadJson').onclick = () => $('fileJson').click();
  $('fileJson').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => { try { loadInput(JSON.parse(rd.result)); } catch (err) { alert('JSON 解析失败：' + err.message); } };
    rd.readAsText(file);
    e.target.value = '';
  };
  $('btnSample').onclick = async () => {
    try {
      const resp = await fetch('samples/sparse-overlay.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      loadInput(await resp.json());
    } catch (err) {
      alert('示例加载失败（' + err.message + '）。若直接以 file:// 打开页面，请改用「导入 JSON」手动选择 samples/sparse-overlay.json。');
    }
  };
  $('btnSolve').onclick = runSolve;
  $('btnExport').onclick = exportSOP1;
  $('btnLoadSop1').onclick = () => $('fileSop1').click();
  $('fileSop1').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => importSOP1(rd.result);
    rd.readAsArrayBuffer(file);
    e.target.value = '';
  };
  document.querySelectorAll('.modeTabs [data-mode]').forEach(b => {
    b.onclick = () => {
      curMode = +b.dataset.mode;
      document.querySelectorAll('.modeTabs [data-mode]').forEach(x => x.classList.toggle('on', x === b));
      draw();
    };
  });
  document.querySelectorAll('#srcTabs button').forEach(b => {
    b.onclick = () => { viewSource = b.dataset.src; inspect = null; showBanner(null); updateSrcTabs(); draw(); };
  });
  $('frameSlider').oninput = e => setFrame(+e.target.value);
  $('btnPrev').onclick = () => setFrame(curFrame - 1);
  $('btnNext').onclick = () => setFrame(curFrame + 1);
  $('btnPlay').onclick = () => {
    if (playTimer) { stopPlay(); return; }
    if (!norm) return;
    $('btnPlay').textContent = '⏸ 暂停';
    playTimer = setInterval(() => setFrame(curFrame >= norm.F ? 1 : curFrame + 1), 120);
  };
  $('btnAddWin').onclick = addWindow;
  $('btnUpdWin').onclick = updateWindow;
  $('btnCancelEdit').onclick = cancelEdit;
  document.body.addEventListener('dragover', e => e.preventDefault());
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const buf = rd.result;
      const head = new Uint8Array(buf.slice(0, 4));
      if (head[0] === 0x53 && head[1] === 0x4F && head[2] === 0x50 && head[3] === 0x31) importSOP1(buf);
      else { try { loadInput(JSON.parse(new TextDecoder().decode(buf))); } catch (err) { alert('无法识别文件：' + err.message); } }
    };
    rd.readAsArrayBuffer(file);
  });
})();
