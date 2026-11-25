/* 页面主逻辑：导入、求解结果渲染、校验行停用/恢复（防抖只发最后一版）、试听与导出 */
(function () {
  'use strict';
  const E = window.ParityEngine;
  const AU = window.ParityAudio;
  const $ = (id) => document.getElementById(id);

  const state = {
    model: null,
    solution: null,
    disabled: new Set(),
    fileName: null,
    checkFilter: 'all',
    checkPage: 0,
    checkPageSize: 25,
    checkSearch: '',
    audio: { ctx: null, source: null, built: null, silenceConfirmed: false },
    solveTimer: null,
  };

  const STATUS_LABEL = {
    known: '有效原音块', recovered: '已恢复',
    undetermined: '未定', contradiction: '矛盾',
  };

  /* ---------------- 导入 ---------------- */
  $('fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch (e) {
      return showImportError(`JSON 解析失败（${e.message}），已保留上一份结果。`);
    }
    const structErrs = E.validateStructure(json);
    if (structErrs.length) {
      return showImportError(`归档结构错误，整份文件已拒绝并保留上一份结果：<br>· ${structErrs.slice(0, 12).join('<br>· ')}`);
    }
    let model;
    try {
      model = E.buildModel(json);
    } catch (e) {
      return showImportError(`归档解码异常（${e.message}），已保留上一份结果。`);
    }
    // 通过：替换为新结果
    state.model = model;
    state.fileName = file.name;
    state.disabled = new Set();
    state.checkPage = 0;
    state.checkSearch = '';
    hideImportError();
    invalidateAudio();
    runSolve(true);
    $('fileName').textContent = file.name;
    $('app').hidden = false;
  });

  function showImportError(html) {
    const b = $('importError');
    b.innerHTML = '⛔ ' + html;
    b.hidden = false;
  }
  function hideImportError() { $('importError').hidden = true; }

  /* ---------------- 求解（连改防抖：只发布最后一版） ---------------- */
  function runSolve(resetViews) {
    clearTimeout(state.solveTimer);
    $('busyBanner').hidden = false;
    state.solveTimer = setTimeout(() => {
      state.solution = E.solve(state.model, state.disabled);
      state.solveTimer = null;
      $('busyBanner').hidden = true;
      invalidateAudio();
      if (resetViews) {
        state.checkPage = 0;
        initTrackSelect();
      }
      renderAll();
    }, 250);
  }

  function recoveredMap() {
    const m = new Map();
    if (state.solution) for (const r of state.solution.recovered) m.set(r.blockId, r.data);
    return m;
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    renderStats();
    renderGrids();
    renderBlockDetail(state.detailBlockId ?? null);
    renderContradictions();
    renderGroups();
    renderCheckTable();
    renderBadLists();
  }

  function renderStats() {
    const s = state.solution.stats;
    const m = state.model;
    const overBudget = state.solution.durationMs > 8000;
    const cards = [
      ['known', s.known, '有效原音块'],
      ['recovered', s.recovered, '已恢复块'],
      ['undetermined', s.undetermined, '未定块'],
      ['contradiction', s.contradiction, '矛盾块'],
      ['', m.missingBlocks.length, '缺失/坏块总数'],
      ['', s.activeChecks, '启用校验行'],
      ['', s.disabledChecks, '停用校验行'],
      ['', m.badChecks.length, '坏校验行（不参与）'],
    ];
    $('stats').innerHTML = cards.map(([cls, num, lbl]) =>
      `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join('')
      + `<div class="stat"><div class="num" style="color:${overBudget ? 'var(--danger)' : '#76c794'}">`
      + `${state.solution.durationMs >= 100 ? Math.round(state.solution.durationMs) : state.solution.durationMs.toFixed(1)}ms</div><div class="lbl">本次求解${overBudget ? '（超 8 秒预算！）' : ''}</div></div>`;
  }

  function renderGrids() {
    const { model, solution } = state;
    const wrap = $('trackGrids');
    wrap.innerHTML = '';
    for (let t = 0; t < model.trackNames.length; t++) {
      const head = document.createElement('div');
      head.className = 'track-block';
      const counts = countTrackStatus(t);
      head.innerHTML = `<div class="track-name"><span>轨 ${t} · ${escapeHtml(model.trackNames[t])}</span>`
        + `<span>恢复 ${counts.recovered} / 未定 ${counts.undetermined} / 矛盾 ${counts.contradiction}（共 ${model.blocksPerTrack} 块）</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'grid';
      const base = t * model.blocksPerTrack;
      for (let lb = 0; lb < model.blocksPerTrack; lb++) {
        const id = base + lb;
        const cell = document.createElement('div');
        cell.className = 'cell ' + solution.statusByBlock[id];
        cell.title = `块 ${id}（轨 ${t} #${lb}）：${STATUS_LABEL[solution.statusByBlock[id]]}`;
        cell.addEventListener('click', () => renderBlockDetail(id));
        grid.appendChild(cell);
      }
      head.appendChild(grid);
      wrap.appendChild(head);
    }
  }

  function countTrackStatus(t) {
    const { model, solution } = state;
    const c = { known: 0, recovered: 0, undetermined: 0, contradiction: 0 };
    const base = t * model.blocksPerTrack;
    for (let lb = 0; lb < model.blocksPerTrack; lb++) c[solution.statusByBlock[base + lb]]++;
    return c;
  }

  function blockLocation(id) {
    const bpt = state.model.blocksPerTrack;
    return { track: Math.floor(id / bpt), local: id % bpt };
  }

  function renderBlockDetail(id) {
    state.detailBlockId = id;
    const box = $('blockDetail');
    if (id === null || id === undefined) {
      box.className = 'detail-empty';
      box.textContent = '点击左侧块网格中的块查看状态与恢复依据。';
      return;
    }
    box.className = '';
    const { model, solution } = state;
    const st = solution.statusByBlock[id];
    const loc = blockLocation(id);
    const rec = solution.recovered.find((r) => r.blockId === id);
    const reason = model.blockReason[id];
    let rows = `
      <table class="detail-table">
      <tr><td>全局块号</td><td class="mono">${id}</td></tr>
      <tr><td>所在位置</td><td>轨 ${loc.track}「${escapeHtml(model.trackNames[loc.track])}」轨内块 #${loc.local}</td></tr>
      <tr><td>状态</td><td><span class="pill ${st}">${STATUS_LABEL[st]}</span></td></tr>`;
    if (reason) rows += `<tr><td>缺失原因</td><td>${escapeHtml(reason)}</td></tr>`;

    if (st === 'known') {
      rows += `<tr><td>数据</td><td>${hexPreview(model.blockData[id])}</td></tr>`;
    }
    if (rec) {
      const grp = solution.groups.find((g) => g.seq === rec.groupSeq);
      rows += `<tr><td>恢复依据</td><td>
          连通组 #${rec.groupSeq}${grp && grp.state === 'contradiction' ? '（矛盾组）' : ''}<br>
          可重验校验行组合（互异行 id，逐行异或并代入已知块后左边只剩本块）：
          <div class="combo">${rec.checks.join(' ⊕ ')}</div>
          <button class="btn-mini" id="verifyComboBtn">用原始校验行重新验证此组合</button>
          <div id="verifyComboResult" class="hex-preview" hidden></div>
        </td></tr>
        <tr><td>恢复数据</td><td>${hexPreview(rec.data)}</td></tr>`;
    }
    if (st === 'contradiction') {
      const grp = solution.groups.find((g) => g.state === 'contradiction' && g.blocks.includes(id));
      if (grp) {
        rows += `<tr><td>封锁来源</td><td>连通组 #${grp.seq} 内出现无解；冲突由校验行
          <span class="combo">${grp.evidence.checkIds.join(' ⊕ ')}</span> 异或产生，
          首个不一致字节位置：${grp.evidence.mismatchBytes.slice(0, 8).join(', ')}</td></tr>`;
      }
    }
    if (st === 'undetermined') {
      const grp = solution.groups.find((g) => g.blocks.includes(id));
      rows += `<tr><td>说明</td><td>所在连通组${grp ? ` #${grp.seq}（秩 ${grp.rank} / 未知量 ${grp.blocks.length}，存在自由变量）` : ''}无法唯一确定本块，试听/导出按待确认静音处理。</td></tr>`;
    }
    rows += '</table>';
    box.innerHTML = rows;

    const btn = $('verifyComboBtn');
    if (btn) btn.addEventListener('click', () => {
      const out = $('verifyComboResult');
      out.hidden = false;
      const v = E.verifyRecovery(model, rec.checks, rec.data, recoveredMap(), rec.blockId);
      if (v.ok === true) {
        out.style.color = '#9adcb3';
        out.textContent = `✓ 重验通过：异或行 [${v.rows.join(', ')}] 并代入已知/已恢复块后，512 字节与恢复值逐字节相等。`;
      } else if (v.unresolved && v.unresolved.length) {
        out.style.color = '#e6c983';
        out.textContent = `△ 暂不能完全重验：组合中还有未定值的块 ${v.unresolved.join(', ')}。`;
      } else {
        out.style.color = '#f2a7aa';
        out.textContent = `✗ 重验失败：不一致字节位置 ${v.mismatches.slice(0, 16).join(', ')}。`;
      }
    });
  }

  function renderContradictions() {
    const { solution } = state;
    const pc = $('pureContradictions');
    if (!solution.pureContradictions.length) {
      pc.innerHTML = '<p class="hint">无纯已知矛盾。</p>';
    } else {
      pc.innerHTML = solution.pureContradictions.map((c) =>
        `<div class="row">校验行 <b class="mono">${c.checkId}</b>：成员全部已知但异或不为零，`
        + `${c.mismatchCount} 个字节不一致（位置 ${c.mismatchBytes.slice(0, 8).join(', ')}…）</div>`).join('');
    }
    const cg = $('contradictionGroups');
    const groups = solution.groups.filter((g) => g.state === 'contradiction');
    if (!groups.length) {
      cg.innerHTML = '<p class="hint">无矛盾封锁组。</p>';
    } else {
      cg.innerHTML = groups.map((g) =>
        `<div class="row">连通组 #${g.seq}：块 ${g.blocks.slice(0, 12).join(', ')}${g.blocks.length > 12 ? ' …' : ''}；`
        + `冲突组合 <span class="combo">${g.evidence.checkIds.join(' ⊕ ')}</span>，`
        + `${g.evidence.mismatchCount} 字节不一致。组内已知原音块照常保留。</div>`).join('');
    }
  }

  function renderGroups() {
    const { solution } = state;
    const sizes = solution.groups.map((g) => g.blocks.length);
    const max = sizes.length ? Math.max(...sizes) : 0;
    const contra = solution.groups.filter((g) => g.state === 'contradiction').length;
    $('groupsSummary').innerHTML =
      `<span>连通组 <b>${solution.groups.length}</b> 个</span>`
      + `<span>矛盾组 <b style="color:var(--danger)">${contra}</b> 个</span>`
      + `<span>最大组未知量 <b>${max}</b> 个（导入全启用时上限 256）</span>`;
    $('groupList').innerHTML = `<table><thead><tr><th>组</th><th>状态</th><th>未知量</th><th>秩</th><th>已恢复</th><th>块号（前 10）</th></tr></thead><tbody>`
      + solution.groups.map((g) => `<tr>
          <td>#${g.seq}</td>
          <td>${g.state === 'contradiction' ? '<span class="pill contradiction">矛盾封锁</span>' : '自洽'}</td>
          <td>${g.blocks.length}</td><td>${g.rank}</td><td>${g.recoveredCount}</td>
          <td class="mono">${g.blocks.slice(0, 10).join(', ')}${g.blocks.length > 10 ? ' …' : ''}</td>
        </tr>`).join('') + '</tbody></table>';
  }

  /* ---------------- 校验行表格（筛选 + 分页 + 停用/恢复） ---------------- */
  function renderCheckTable() {
    const { model, solution } = state;
    const q = state.checkSearch.trim();
    const rows = model.checks.filter((c) => {
      const isOff = state.disabled.has(c.id);
      if (state.checkFilter === 'enabled' && isOff) return false;
      if (state.checkFilter === 'disabled' && !isOff) return false;
      if (q) {
        const hay = `${c.id} ${c.members.join(' ')}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const pageCount = Math.max(1, Math.ceil(rows.length / state.checkPageSize));
    if (state.checkPage >= pageCount) state.checkPage = pageCount - 1;
    const slice = rows.slice(state.checkPage * state.checkPageSize, (state.checkPage + 1) * state.checkPageSize);
    $('checkTbody').innerHTML = slice.map((c) => {
      const isOff = state.disabled.has(c.id);
      return `<tr class="${isOff ? 'off' : ''}" data-id="${c.id}">
        <td class="mono">${c.id}</td>
        <td class="mono">${c.members.map((m) => `${m}<span class="hint">[${solution.statusByBlock[m]}]</span>`).join(', ')}</td>
        <td>${isOff ? '<span class="pill disabled">已停用</span>' : '<span class="pill recovered">启用中</span>'}</td>
        <td>
          <button class="btn-mini toggle-btn">${isOff ? '恢复启用' : '停用'}</button>
          <button class="btn-mini verify-btn">重验此行</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="4" class="hint">没有匹配的校验行。</td></tr>';

    $('checkTbody').querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.closest('tr').dataset.id);
        if (state.disabled.has(id)) state.disabled.delete(id); else state.disabled.add(id);
        runSolve(false); // 防抖：连改只发布最后一版
      });
    });
    $('checkTbody').querySelectorAll('.verify-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.closest('tr').dataset.id);
        const v = E.verifyCheck(model, id);
        if (v.ok === true) alert(`校验行 ${id}：成员全部已知，异或结果为零，行自洽 ✓`);
        else if (v.ok === false) alert(`校验行 ${id}：纯已知矛盾 ✗ 不一致字节 ${v.mismatchBytes.slice(0, 10).join(', ')}`);
        else alert(`校验行 ${id}：仍含未知成员 [${v.unknownMembers.join(', ')}]，需结合求解结果判断。`);
      });
    });
    $('checkPageInfo').textContent = `第 ${state.checkPage + 1} / ${pageCount} 页（共 ${rows.length} 行，有效行 ${model.checks.length}）`;
  }

  $('checkFilters').addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.checkFilter = e.target.dataset.filter;
    state.checkPage = 0;
    document.querySelectorAll('#checkFilters button').forEach((b) => b.classList.toggle('active', b === e.target));
    renderCheckTable();
  });
  $('checkSearch').addEventListener('input', (e) => {
    state.checkSearch = e.target.value;
    state.checkPage = 0;
    renderCheckTable();
  });
  $('checkPrev').addEventListener('click', () => { state.checkPage = Math.max(0, state.checkPage - 1); renderCheckTable(); });
  $('checkNext').addEventListener('click', () => { state.checkPage++; renderCheckTable(); });
  $('enableAll').addEventListener('click', () => {
    if (!state.disabled.size) return;
    state.disabled.clear();
    runSolve(false);
  });

  function renderBadLists() {
    const m = state.model;
    const parts = [];
    if (m.badBlocks.length) {
      parts.push(`<div class="row">坏原音块（按缺失处理）：`
        + m.badBlocks.map((b) => `块 ${b.id}（${escapeHtml(b.reason)}）`).join('；') + '</div>');
    }
    if (m.badChecks.length) {
      parts.push(`<div class="row">坏校验行（不参与求解）：`
        + m.badChecks.map((b) => `行 ${b.id}（${escapeHtml(b.reason)}）`).join('；') + '</div>');
    }
    if (!parts.length) parts.push('<div class="hint">所有记录的 Base64、长度与 CRC 均有效。</div>');
    $('badChecks').innerHTML = parts.join('');
  }

  /* ---------------- 试听 / 导出（同源 PCM） ---------------- */
  function initTrackSelect() {
    const sel = $('trackSelect');
    sel.innerHTML = state.model.trackNames.map((n, i) => `<option value="${i}">${i} · ${escapeHtml(n)}</option>`).join('');
    const total = state.model.blocksPerTrack * AU.BLOCK_SAMPLES;
    $('rangeStart').value = 0;
    $('rangeEnd').value = total;
  }

  function getBlockView(id) {
    const m = state.model;
    const bytes = m.blockData[id];
    if (bytes) return AU.blockBytesToInt16(bytes);
    const rec = state.solution.recovered.find((r) => r.blockId === id);
    return rec ? AU.blockBytesToInt16(rec.data) : null;
  }

  $('buildRange').addEventListener('click', () => {
    const m = state.model;
    const trackIndex = Number($('trackSelect').value);
    const total = m.blocksPerTrack * AU.BLOCK_SAMPLES;
    const start = Number($('rangeStart').value);
    const end = Number($('rangeEnd').value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total) {
      return audioMsg(`区间非法：要求 0 ≤ start < end ≤ ${total}（整数采样）`, true);
    }
    const built = AU.buildTrackPcm(m, trackIndex, start, end, getBlockView, false);
    state.audio.built = { pcm: built.pcm, start, end, trackIndex, unresolved: built.unresolved };
    state.audio.silenceConfirmed = false;
    $('silenceConfirm').checked = false;
    $('playBtn').disabled = false;
    $('stopBtn').disabled = false;
    $('exportBtn').disabled = built.unresolved.length > 0;
    $('rangeInfo').textContent =
      `区间 [${start}, ${end})，${built.pcm.length} 采样 ≈ ${(built.pcm.length / AU.SAMPLE_RATE).toFixed(3)}s`;
    const box = $('unresolvedBox');
    if (built.unresolved.length) {
      box.hidden = false;
      $('unresolvedList').innerHTML = built.unresolved.map((u) => {
        const loc = blockLocation(u.blockId);
        const st = state.solution.statusByBlock[u.blockId];
        return `块 ${u.blockId}（轨 ${loc.track} #${loc.local}，${STATUS_LABEL[st]}）采样 ${u.sampleRange[0]}–${u.sampleRange[1]}`;
      }).join('<br>');
    } else {
      box.hidden = true;
    }
    audioMsg('区间缓冲已生成，试听与导出将共用这一份 PCM。', false);
  });

  $('silenceConfirm').addEventListener('change', (e) => {
    state.audio.silenceConfirmed = e.target.checked;
    const b = state.audio.built;
    $('exportBtn').disabled = !(b && (b.unresolved.length === 0 || e.target.checked));
  });

  $('playBtn').addEventListener('click', () => {
    const b = state.audio.built;
    if (!b) return;
    if (!state.audio.ctx) state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.audio.ctx.resume();
    if (state.audio.source) { try { state.audio.source.stop(); } catch (_) {} }
    // 直接把同源 Int16Array 送入播放器
    state.audio.source = AU.playPcm(state.audio.ctx, b.pcm);
    audioMsg('正在试听送给播放器的 PCM（声卡重采样不计入逐样本比较）。', false);
  });
  $('stopBtn').addEventListener('click', () => {
    if (state.audio.source) { try { state.audio.source.stop(); } catch (_) {} state.audio.source = null; }
  });

  $('exportBtn').addEventListener('click', () => {
    const b = state.audio.built;
    if (!b) return;
    if (b.unresolved.length && !state.audio.silenceConfirmed) {
      return audioMsg('存在未定/矛盾块，须先确认补静音才能导出。', true);
    }
    // 与试听完全相同的 pcm 对象 → WAV 数据区逐样本一致
    const wav = AU.pcmToWavBytes(b.pcm);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = state.model.trackNames[b.trackIndex].replace(/[\\/:*?"<>|\s]+/g, '_');
    a.href = url;
    a.download = `${name}_${b.start}-${b.end}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    audioMsg(`已导出 ${a.download}（${wav.length} 字节，48kHz/16bit/单声道，数据区与试听同源）。`, false);
  });

  function audioMsg(text, isErr) {
    const el = $('audioMsg');
    el.textContent = text;
    el.style.color = isErr ? 'var(--danger)' : 'var(--muted)';
  }
  function invalidateAudio() {
    state.audio.built = null;
    state.audio.silenceConfirmed = false;
    $('silenceConfirm').checked = false;
    $('unresolvedBox').hidden = true;
    $('playBtn').disabled = true;
    $('stopBtn').disabled = true;
    $('exportBtn').disabled = true;
    $('rangeInfo').textContent = '求解结果已更新，请重新生成区间缓冲。';
  }

  /* ---------------- 小工具 ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function hexPreview(bytes) {
    const head = [...bytes.slice(0, 24)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    return `<div class="hex-preview">前 24 字节：${head} …（共 ${bytes.length} 字节）</div>`;
  }
})();
