/* Controller for the room early-reflection workbench. */
(function () {
  'use strict';
  const E = window.RoomEngine;
  const $ = (id) => document.getElementById(id);
  const WALL_LABELS = ['x0 西墙', 'x1 东墙', 'y0 南墙', 'y1 北墙', 'z0 地面', 'z1 顶面'];

  const SAMPLE = {
    size: [7000, 4800, 3000],
    sources: [[1300, 2200, 1250], [900, 3500, 1600]],
    receivers: [[4900, 1100, 1450], [5200, 3300, 1600]],
    boxes: [{ min: [2800, 1600, 200], max: [3500, 2500, 1700] }],
    order: 2,
    walls: [[2320, -520, 130], [2048, 0, 0], [1800, 512, 0], [1960, 0, 0], [1500, 220, 0], [2400, 0, 0]],
  };

  // ---------- state ----------
  let raw = deepCopy(SAMPLE);       // editable plain-number room
  let room = null;                   // validated BigInt room
  let sequences = [];
  let allPairPaths = new Map();      // "si,ri" -> paths
  let currentResp = null;            // Float32Array for selected pair
  let si = 0, ri = 0;
  let selectedIdx = -1;              // index into current pair's sorted paths
  let view = 'xy';
  let showBlocked = true;
  let irWindow = 'early';             // 'early' = first 250 ms, 'full' = all 96000 frames
  let planHit = [];                  // clickable path markers for plan
  let recomputeMs = 0;
  let baseline = null;               // prior reachability keyed by "si,ri|wallOrder"
  let diffArmed = false;             // true after a box edit -> render change markers
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function fnum(r) { return E.rtof(r); }
  function v3(v) { return v.map(fnum); }

  // ---------- persistence ----------
  function saveState() {
    try {
      localStorage.setItem('rrefl-room', JSON.stringify(raw));
      localStorage.setItem('rrefl-sel', JSON.stringify({ si, ri, view }));
    } catch (_) { /* storage may be blocked */ }
  }
  function loadState() {
    try {
      const r = localStorage.getItem('rrefl-room');
      if (r) raw = JSON.parse(r);
      const s = JSON.parse(localStorage.getItem('rrefl-sel') || 'null');
      if (s) { si = s.si | 0; ri = s.ri | 0; view = s.view || 'xy'; }
    } catch (_) { /* ignore */ }
  }

  // ---------- recompute ----------
  function showError(msg) {
    const el = $('cfgErr');
    if (msg) { el.textContent = msg; el.classList.add('show'); }
    else el.classList.remove('show');
  }

  function recompute(rebuildAll) {
    const t0 = performance.now();
    let validated;
    try {
      validated = E.validateRoom(raw);
      showError(null);
    } catch (e) {
      showError('配置无效：' + e.message);
      return false;                 // keep the last good room and its render
    }
    room = validated;
    sequences = E.enumerateSequences(room.order);
    const targets = rebuildAll
      ? room.receivers.map((_, r) => [si, r])
      : [[si, ri]];
    for (const [s, r] of targets) {
      allPairPaths.set(s + ',' + r, E.solvePair(room, s, r, sequences));
    }
    currentResp = E.buildResponse(room, currentPaths());
    let energy = 0;
    for (let i = 0; i < currentResp.length; i++) energy += currentResp[i] * currentResp[i];
    window.__irEnergy = energy;
    recomputeMs = performance.now() - t0;
    if (selectedIdx >= currentPaths().length) selectedIdx = -1;
    renderAll();
    return true;
  }

  function currentPaths() { return allPairPaths.get(si + ',' + ri) || []; }

  function reachabilitySnapshot() {
    const snap = new Map();
    for (const [key, paths] of allPairPaths)
      for (const p of paths)
        snap.set(key + '|' + p.wallNames.join(','), p.reachable);
    return snap;
  }
  // 'new-block' | 'reopened' | null relative to the baseline snapshot
  function diffFor(path) {
    if (!baseline || !diffArmed) return null;
    const was = baseline.get(si + ',' + ri + '|' + path.wallNames.join(','));
    if (was === undefined) return null;
    if (was && !path.reachable) return 'new-block';
    if (!was && path.reachable) return 'reopened';
    return null;
  }
  // indices (into the full sorted pair) that the current filter allows
  function visibleIndices() {
    const all = currentPaths();
    const out = [];
    for (let i = 0; i < all.length; i++)
      if (showBlocked || all[i].reachable) out.push(i);
    return out;
  }
  function selectedPath() { return selectedIdx >= 0 ? currentPaths()[selectedIdx] : null; }

  // ---------- selectors / wall taps ----------
  function buildSelectors() {
    $('srcSel').innerHTML = raw.sources.map((p, i) =>
      `<option value="${i}">S${i} (${p.join(', ')})</option>`).join('');
    $('recvSel').innerHTML = raw.receivers.map((p, i) =>
      `<option value="${i}">R${i} (${p.join(', ')})</option>`).join('');
    $('srcSel').value = String(Math.min(si, raw.sources.length - 1));
    $('recvSel').value = String(Math.min(ri, raw.receivers.length - 1));
    si = +$('srcSel').value; ri = +$('recvSel').value;
    $('orderSel').value = String(raw.order);
    $('ordLabel').textContent = raw.order;

    $('wallGrid').innerHTML = raw.walls.map((t, w) => `
      <div class="walltap">
        <b>${E.WALL_NAMES[w]} · ${WALL_LABELS[w].split(' ')[1] || ''}</b>
        ${[0, 1, 2].map(k => `<input type="number" min="-4096" max="4096" step="1"
            data-wall="${w}" data-tap="${k}" value="${t[k]}" aria-label="${E.WALL_NAMES[w]} 抽头${k}">`).join('')}
      </div>`).join('');
  }

  function buildBoxEditor() {
    $('boxTbody').innerHTML = raw.boxes.map((b, i) => `
      <tr data-box="${i}">
        <td><span class="tag">B${i}</span></td>
        ${['min', 'max'].map(side => [0, 1, 2].map(a =>
          `<td><input type="number" step="1" data-side="${side}" data-axis="${a}" value="${b[side][a]}"></td>`).join('')).join('')}
        <td><button class="iconbtn" data-del="${i}" title="删除">✕</button></td>
      </tr>`).join('');
  }

  // ---------- plan view (SVG) ----------
  const PLAN_PAD = 26;
  function viewAxes() {
    return view === 'xy' ? [0, 1] : view === 'xz' ? [0, 2] : [1, 2];
  }
  function planScale(W, H) {
    const [a, b] = viewAxes();
    const rw = Number(room.size[a]), rh = Number(room.size[b]);
    if (![rw, rh, W, H].every(Number.isFinite) || rw <= 0 || rh <= 0) return null;
    const sx = (W - 2 * PLAN_PAD) / rw;
    const sy = (H - 2 * PLAN_PAD) / rh;
    const s = Math.min(sx, sy);
    if (!Number.isFinite(s) || s <= 0) return null;
    const ox = (W - rw * s) / 2, oy = (H - rh * s) / 2;
    return { a, b, s, ox, oy, W, H };
  }
  function pt(p, sc) {
    const x = sc.ox + Number(p[sc.a]) * sc.s, y = sc.oy + Number(p[sc.b]) * sc.s;
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
  }

  function renderPlan() {
    const svg = $('planSvg');
    if (!svg.setAttribute) return;
    const W = svg.clientWidth || 560, H = 380;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const sc = planScale(W, H);
    if (!sc) return;
    const [a, b] = [sc.a, sc.b];
    const css = getComputedStyle(document.documentElement);
    const C = (n) => css.getPropertyValue(n).trim();
    const rw = Number(room.size[a]), rh = Number(room.size[b]);
    const x0 = sc.ox, y0 = sc.oy, x1 = sc.ox + rw * sc.s, y1 = sc.oy + rh * sc.s;
    let out = '';

    // grid + room boundary
    out += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${C('--panel-2')}" stroke="${C('--wall')}" stroke-width="2"/>`;
    const step = niceStep(rw);
    for (let g = step; g < rw; g += step) {
      const gx = sc.ox + g * sc.s;
      out += `<line x1="${gx}" y1="${y0}" x2="${gx}" y2="${y1}" stroke="${C('--grid')}" stroke-width="1"/>`;
    }
    const stepY = niceStep(rh);
    for (let g = stepY; g < rh; g += stepY) {
      const gy = sc.oy + g * sc.s;
      out += `<line x1="${x0}" y1="${gy}" x2="${x1}" y2="${gy}" stroke="${C('--grid')}" stroke-width="1"/>`;
    }
    // dimension labels
    out += `<text x="${(x0 + x1) / 2}" y="${y1 + 16}" fill="${C('--fg-2')}" font-size="11" text-anchor="middle" font-family="${C('--mono')}">${'xyz'[a]}: ${rw} mm</text>`;
    out += `<text x="${x0 - 8}" y="${(y0 + y1) / 2}" fill="${C('--fg-2')}" font-size="11" text-anchor="middle" font-family="${C('--mono')}" transform="rotate(-90 ${x0 - 8} ${(y0 + y1) / 2})">${'xyz'[b]}: ${rh} mm</text>`;

    // boxes (project the two visible faces)
    room.boxes.forEach((bx, i) => {
      const pA = [bx.min[a], bx.min[b]], pB = [bx.max[a], bx.max[b]];
      const [px, py] = [sc.ox + Number(pA[0]) * sc.s, sc.oy + Number(pA[1]) * sc.s];
      const pw = Number(pB[0] - pA[0]) * sc.s, ph = Number(pB[1] - pA[1]) * sc.s;
      out += `<rect class="boxrect" data-box="${i}" x="${px}" y="${py}" width="${pw}" height="${ph}" rx="2"
        fill="${C('--box-fill')}" fill-opacity="0.28" stroke="${C('--box-edge')}" stroke-width="1.5"/>`;
      out += `<text x="${px + 4}" y="${py + 13}" fill="${C('--box-edge')}" font-size="10.5" font-family="${C('--mono')}">B${i}</text>`;
    });

    // paths (selected last so it sits on top); filter honors the blocked toggle
    const paths = currentPaths();
    planHit = [];
    const vis = visibleIndices();
    const ordered = vis.slice().sort((u, v) =>
      (u === selectedIdx ? 1 : 0) - (v === selectedIdx ? 1 : 0));
    for (const i of ordered) {
      const p = paths[i];
      const sel = i === selectedIdx;
      const color = sel ? C('--violet') : p.reachable ? C('--accent') : C('--block');
      const width = sel ? 2.8 : 1.5;
      const style = sel ? '' : (p.reachable ? 'stroke-opacity:.55' : 'stroke-dasharray:6 4;stroke-opacity:.85');
      const dstr = p.vertices.map((v, k) => {
        const [x, y] = pt(v, sc);
        return (k ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }).join(' ');
      out += `<path class="pathline" data-idx="${i}" d="${dstr}" fill="none" stroke="${color}"
        stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" style="${style};cursor:pointer"/>`;
      // reflection vertices
      p.vertices.forEach((v, k) => {
        if (k === 0 || k === p.vertices.length - 1) return;
        const [x, y] = pt(v, sc);
        out += `<circle class="pathline" data-idx="${i}" cx="${x}" cy="${y}" r="${sel ? 3.8 : 2.6}"
          fill="${color}" stroke="${C('--panel')}" stroke-width="0.8" style="cursor:pointer"/>`;
      });
      // blockage marker at the first blocked segment entry
      if (!p.reachable) {
        const seg = p.blockedSegment;
        const P = p.vertices[seg], Q = p.vertices[seg + 1];
        const hitp = blockPoint(P, Q, room.boxes[p.blockedBox]);
        const [hx, hy] = pt(hitp, sc);
        out += `<rect class="pathline" data-idx="${i}" x="${hx - 4.5}" y="${hy - 4.5}" width="9" height="9"
          transform="rotate(45 ${hx} ${hy})" fill="${C('--block')}" stroke="${C('--panel')}" stroke-width="1.2" style="cursor:pointer"/>`;
      }
      planHit.push({ idx: i, verts: p.vertices.map(v => pt(v, sc)) });
    }

    // source / receiver markers
    const [sx, sy] = pt(room.sources[si], sc);
    out += `<circle cx="${sx}" cy="${sy}" r="7" fill="${C('--source')}" stroke="${C('--panel')}" stroke-width="2"/>`;
    out += `<text x="${sx + 10}" y="${sy + 4}" fill="${C('--fg')}" font-size="12" font-weight="700">S${si}</text>`;
    const [rx, ry] = pt(room.receivers[ri], sc);
    out += `<rect x="${rx - 6}" y="${ry - 6}" width="12" height="12" rx="2" fill="${C('--recv')}" stroke="${C('--panel')}" stroke-width="2"/>`;
    out += `<text x="${rx + 10}" y="${ry + 4}" fill="${C('--fg')}" font-size="12" font-weight="700">R${ri}</text>`;

    svg.innerHTML = out;
    $('viewLabel').textContent =
      view === 'xy' ? '俯视图（X–Y，Z 投影）' : view === 'xz' ? '侧视图（X–Z，Y 投影）' : '正视图（Y–Z，X 投影）';
  }

  function niceStep(span) {
    const target = span / 8;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    for (const m of [1, 2, 5, 10]) if (m * pow >= target) return m * pow;
    return 10 * pow;
  }

  // exact block entry point on a segment for a given box (mirrors engine slabs)
  function blockPoint(P, Q, box) {
    let best = Infinity;
    for (let a = 0; a < 3; a++) {
      const p = fnum(P[a]), q = fnum(Q[a]), d = q - p;
      if (Math.abs(d) < 1e-12) continue;
      for (const bound of [Number(box.min[a]), Number(box.max[a])]) {
        const t = (bound - p) / d;
        if (t >= -1e-12 && t <= 1 + 1e-12 && t < best) {
          // only count if the point is inside the box on the other two axes
          const cand = [0, 1, 2].map(k => k === a ? bound : p + t * (fnum(Q[k]) - p));
          let inside = true;
          for (let k = 0; k < 3; k++)
            if (cand[k] < Number(box.min[k]) - 1e-9 || cand[k] > Number(box.max[k]) + 1e-9) inside = false;
          if (inside) best = t;
        }
      }
    }
    if (!isFinite(best)) best = 0;
    return [0, 1, 2].map(a => fnum(P[a]) + best * (fnum(Q[a]) - fnum(P[a])));
  }

  // ---------- impulse response canvas ----------
  function renderIR() {
    const cv = $('irCanvas');
    const ctx = cv.getContext ? cv.getContext('2d') : null;
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 560, H = 300;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const C = (n) => css.getPropertyValue(n).trim();
    ctx.fillStyle = C('--panel-2'); ctx.fillRect(0, 0, W, H);
    const padL = 52, padR = 14, padT = 14, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const data = currentResp;
    const winFrames = irWindow === 'early'
      ? Math.min(data.length, Math.round(E.FS * 0.25))   // first 250 ms
      : data.length;
    let peak = 1e-12;
    for (let i = 0; i < winFrames; i++) peak = Math.max(peak, Math.abs(data[i]));
    const xOf = (f) => padL + (f / (winFrames - 1)) * plotW;
    const yOf = (v) => padT + plotH / 2 - (v / peak) * (plotH / 2 - 6);

    // grid + zero line
    ctx.strokeStyle = C('--grid'); ctx.lineWidth = 1; ctx.fillStyle = C('--fg-2');
    ctx.font = `10.5px ${C('--mono')}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const gy of [-1, -0.5, 0, 0.5, 1]) {
      const y = yOf(gy * peak);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
      ctx.strokeStyle = gy === 0 ? C('--line') : C('--grid'); ctx.stroke();
      ctx.fillText((gy * peak).toExponential(1), padL - 6, y);
    }
    // time axis in ms across the active window
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const winMs = winFrames / E.FS * 1000;
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const frame = Math.round((t / ticks) * (winFrames - 1));
      const x = xOf(frame);
      const ms = (frame / E.FS * 1000);
      ctx.fillText(ms.toFixed(winMs <= 300 ? 1 : 0) + ' ms', x, H - padB + 8);
      ctx.strokeStyle = C('--grid');
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    }

    // envelope: min/max per device pixel column (keeps every spike visible)
    ctx.strokeStyle = C('--accent'); ctx.lineWidth = 1;
    const cols = Math.floor(plotW);
    const per = winFrames / cols;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor(c * per), i1 = Math.max(i0 + 1, Math.floor((c + 1) * per));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1 && i < winFrames; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      const x = padL + c + 0.5;
      ctx.moveTo(x, yOf(mn)); ctx.lineTo(x, yOf(mx));
    }
    ctx.stroke();

    // selected path arrival markers (every tap frame), only if inside the window
    const sp = selectedPath();
    if (sp && sp.reachable) {
      const d = sp.lengthMm * E.FS / E.C;
      const base = Math.floor(d);
      ctx.strokeStyle = C('--violet'); ctx.lineWidth = 1.5;
      for (let k = 0; k < 2 * sp.walls.length + 1; k++) {
        const f = base + k;
        if (f >= winFrames) break;
        const x = xOf(f);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      }
      $('irMeta').textContent = `d=${d.toFixed(1)} 帧 · ${(d / E.FS * 1000).toFixed(2)} ms`;
    } else {
      $('irMeta').textContent = `窗 ${winMs.toFixed(0)}ms · 峰 ${peak.toExponential(2)}`;
    }
    cv._scale = { padL, padR, padT, padB, plotW, plotH, peak, xOf, yOf, W, H, winFrames };
  }

  // ---------- path table ----------
  function renderTable() {
    const paths = currentPaths();
    let ok = 0, blk = 0;
    paths.forEach(p => p.reachable ? ok++ : blk++);
    $('cntOk').textContent = ok; $('cntBlock').textContent = blk;
    const vis = visibleIndices();
    $('tblMeta').textContent = `S${si} → R${ri} · 显示 ${vis.length}/${paths.length} 条`;
    $('timePill').textContent = `计算 ${recomputeMs.toFixed(0)} ms`;
    $('roomSizePill').textContent = raw.size.join(' × ') + ' mm';

    $('pathTbody').innerHTML = vis.map((i) => {
      const p = paths[i];
      const verts = p.vertices.map(v => '(' + v3(v).map(x => Number(x.toFixed(1))).join(', ') + ')').join(' ');
      const diff = diffFor(p);
      const diffBadge = diff === 'new-block'
        ? '<span class="badge diff new">新阻挡</span>'
        : diff === 'reopened' ? '<span class="badge diff open">恢复</span>' : '';
      return `<tr data-idx="${i}" class="${i === selectedIdx ? 'sel' : ''} ${diff === 'new-block' ? 'row-diff' : ''}">
        <td>${i}</td>
        <td>${p.wallNames.length ? p.wallNames.map(w => `<span class="tag">${w}</span>`).join(' ') : '<span class="tag">直达</span>'}</td>
        <td>${p.lengthMm.toFixed(1)}</td>
        <td><span class="badge ${p.reachable ? 'ok' : 'block'}">${p.reachable ? '可达' : '阻挡'}</span>${diffBadge}</td>
        <td>${p.reachable ? '—' : `段${p.blockedSegment} / B${p.blockedBox}`}</td>
        <td style="font-family:var(--mono);font-size:11px;max-width:340px;white-space:normal">${verts}</td>
      </tr>`;
    }).join('');

    // change summary vs the pre-edit baseline
    const banner = $('diffBanner');
    if (diffArmed && baseline) {
      let nb = 0, ob = 0;
      for (const p of paths) {
        const d = diffFor(p);
        if (d === 'new-block') nb++;
        else if (d === 'reopened') ob++;
      }
      if (nb || ob) {
        banner.hidden = false;
        banner.innerHTML = `展柜改动：<span class="nb">${nb} 条回声被新挡住</span>${ob ? ` · <span class="ob">${ob} 条恢复可达</span>` : ''}
          <span class="muted">（按当前声源→麦位）</span><button id="clearDiffBtn">清除标记</button>`;
        $('clearDiffBtn').addEventListener('click', () => {
          diffArmed = false; banner.hidden = true; renderTable();
        });
      } else {
        banner.hidden = true;
      }
    } else {
      banner.hidden = true;
    }
  }

  // ---------- render orchestration ----------
  function renderAll() {
    buildSelectors();
    buildBoxEditor();
    renderPlan();
    renderIR();
    renderTable();
  }

  // ---------- interactions ----------
  function selectPath(i) {
    selectedIdx = i;
    renderPlan(); renderIR(); renderTable();
    const row = $('pathTbody').querySelector(`tr[data-idx="${i}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'srcSel') { si = +t.value; selectedIdx = -1; diffArmed = false; saveState(); recompute(false); }
    else if (t.id === 'recvSel') { ri = +t.value; selectedIdx = -1; diffArmed = false; saveState(); recompute(false); }
    else if (t.id === 'orderSel') { raw.order = +t.value; diffArmed = false; saveState(); recompute(true); }
    else if (t.dataset.wall !== undefined) {
      raw.walls[+t.dataset.wall][+t.dataset.tap] = clampTap(+t.value);
      t.value = raw.walls[+t.dataset.wall][+t.dataset.tap];
      diffArmed = false;
      saveState(); recompute(true);
    }
  });

  function clampTap(v) {
    if (!Number.isFinite(v)) v = 0;
    return Math.max(-4096, Math.min(4096, Math.round(v)));
  }

  $('viewSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    [...$('viewSeg').children].forEach(x => x.classList.toggle('on', x === b));
    renderPlan(); saveState();
  });

  $('blockedToggle').addEventListener('change', (ev) => {
    showBlocked = ev.target.checked;
    if (!showBlocked) {
      const p = selectedPath();
      if (p && !p.reachable) selectedIdx = -1;
    }
    renderPlan(); renderIR(); renderTable();
  });

  $('irWinSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-win]');
    if (!b) return;
    irWindow = b.dataset.win;
    [...$('irWinSeg').children].forEach(x => x.classList.toggle('on', x === b));
    renderIR();
  });

  // plan click -> nearest path within hit radius
  $('planSvg').addEventListener('click', (ev) => {
    const svg = $('planSvg');
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = -1, bestD = 14;
    for (const h of planHit) {
      for (let k = 0; k < h.verts.length - 1; k++) {
        const d = distToSegment(mx, my, h.verts[k], h.verts[k + 1]);
        if (d < bestD) { bestD = d; best = h.idx; }
      }
    }
    if (best >= 0) selectPath(best);
  });

  // plan hover tooltip
  $('planSvg').addEventListener('mousemove', (ev) => {
    const tip = $('planTip');
    const line = ev.target.closest('.pathline');
    if (!line) { tip.style.display = 'none'; return; }
    const p = currentPaths()[+line.dataset.idx];
    tip.innerHTML = `<b>${p.wallNames.join('→') || '直达'}</b><br>
      <code>L=${p.lengthMm.toFixed(1)} mm</code><br>
      <span style="color:${p.reachable ? 'var(--ok)' : 'var(--block)'}">${p.reachable ? '可达' : `阻挡于段${p.blockedSegment}/B${p.blockedBox}`}</span>`;
    tip.style.display = 'block';
    const wrap = svgWrapRect();
    tip.style.left = Math.min(ev.clientX - wrap.left + 12, wrap.width - 250) + 'px';
    tip.style.top = (ev.clientY - wrap.top + 12) + 'px';
  });
  $('planSvg').addEventListener('mouseleave', () => { $('planTip').style.display = 'none'; });
  function svgWrapRect() { return $('planSvg').closest('.plotwrap').getBoundingClientRect(); }

  // IR hover crosshair + tooltip
  $('irCanvas').addEventListener('mousemove', (ev) => {
    const cv = $('irCanvas'), sc = cv._scale; if (!sc) return;
    const rect = cv.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const tip = $('irTip');
    if (x < sc.padL || x > sc.W - sc.padR) { tip.style.display = 'none'; return; }
    const frame = Math.round(((x - sc.padL) / sc.plotW) * (sc.winFrames - 1));
    const v = currentResp[frame];
    tip.innerHTML = `帧 <code>${frame}</code> · ${(frame / E.FS * 1000).toFixed(3)} ms<br>幅值 <code>${v.toExponential(4)}</code>`;
    tip.style.display = 'block';
    const wrap = cv.closest('.plotwrap').getBoundingClientRect();
    tip.style.left = Math.min(ev.clientX - wrap.left + 12, wrap.width - 200) + 'px';
    tip.style.top = (ev.clientY - wrap.top + 10) + 'px';
  });
  $('irCanvas').addEventListener('mouseleave', () => { $('irTip').style.display = 'none'; });

  // table row selection
  $('pathTbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-idx]');
    if (tr) selectPath(+tr.dataset.idx);
  });

  // click on an IR arrival marker frame -> select nearest path by arrival
  $('irCanvas').addEventListener('click', (ev) => {
    const cv = $('irCanvas'), sc = cv._scale; if (!sc) return;
    const rect = cv.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (x < sc.padL || x > sc.W - sc.padR) return;
    const frame = ((x - sc.padL) / sc.plotW) * (sc.winFrames - 1);
    const paths = currentPaths();
    let best = -1, bestD = Infinity;
    paths.forEach((p, i) => {
      if (!p.reachable) return;
      const d = p.lengthMm * E.FS / E.C;
      const dist = Math.abs(Math.floor(d) - frame);
      if (dist < bestD) { bestD = dist; best = i; }
    });
    if (best >= 0 && bestD < 40) selectPath(best);
  });

  function distToSegment(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - a[0], py - a[1]);
    let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  // ---------- box editor ----------
  $('addBoxBtn').addEventListener('click', () => {
    if (raw.boxes.length >= 24) { $('boxErr').textContent = '最多 24 个展柜'; return; }
    const c = raw.size.map(v => Math.round(v / 2));
    raw.boxes.push({ min: c.map(v => v - 300), max: c.map(v => v + 300) });
    buildBoxEditor(); saveState();
  });
  $('boxTbody').addEventListener('click', (ev) => {
    const d = ev.target.dataset.del;
    if (d !== undefined) { raw.boxes.splice(+d, 1); buildBoxEditor(); saveState(); }
  });
  $('boxTbody').addEventListener('change', (ev) => {
    const tr = ev.target.closest('tr[data-box]');
    if (!tr || ev.target.dataset.side === undefined) return;
    const b = raw.boxes[+tr.dataset.box];
    b[ev.target.dataset.side][+ev.target.dataset.axis] = Math.round(+ev.target.value || 0);
    saveState();
  });
  $('applyBoxBtn').addEventListener('click', () => {
    $('boxErr').textContent = '';
    baseline = reachabilitySnapshot();   // compare the new layout against this
    diffArmed = true;
    if (!recompute(true)) { $('boxErr').textContent = '展柜参数无效，见上方错误'; diffArmed = false; }
  });

  // ---------- import / reset / theme ----------
  $('fileInput').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        E.validateRoom(parsed); // throws on bad spec
        raw = parsed; si = 0; ri = 0; selectedIdx = -1;
        saveState(); recompute(true);
      } catch (e) { showError('导入失败：' + e.message); }
    };
    reader.readAsText(f);
    ev.target.value = '';
  });
  $('resetBtn').addEventListener('click', () => {
    raw = deepCopy(SAMPLE); si = 0; ri = 0; selectedIdx = -1;
    try { localStorage.removeItem('rrefl-room'); } catch (_) {}
    recompute(true);
  });
  $('themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const darkNow = root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = darkNow ? 'light' : 'dark';
    renderPlan(); renderIR();
  });

  // ---------- downloads ----------
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  $('wavBtn').addEventListener('click', () => {
    const blob = E.encodeWav(currentResp);
    download(blob, `ir_S${si}_R${ri}_48k_float32.wav`);
  });
  $('jsonBtn').addEventListener('click', () => {
    const payload = E.pathsToJSON(room, si, ri, currentPaths());
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `paths_S${si}_R${ri}.json`);
  });

  window.addEventListener('resize', () => { renderPlan(); renderIR(); });

  // ---------- boot ----------
  loadState();
  [...$('viewSeg').children].forEach(x => x.classList.toggle('on', x.dataset.view === view));
  recompute(true);
})();
