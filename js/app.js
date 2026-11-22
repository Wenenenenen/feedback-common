/* Film stack preview application: state, recompute scheduling, UI wiring. */
(function () {
  'use strict';

  const S = window.FILM_SAMPLES;
  const WAVELENGTHS = S.wavelengths;
  const WEIGHTS = S.weights;
  const ANGLES = Array.from({ length: 86 }, (_, i) => i); // 0..85 deg, step 1

  const LIMITS = { d: [0, 5000], n: [1, 3.5], k: [0, 2], maxLayers: 16 };

  // series roles -> categorical palette tokens
  const ROLES = {
    s: { name: 's 偏振', token: '--series-s' },
    p: { name: 'p 偏振', token: '--series-p' },
    u: { name: '无偏振 (s+p)/2', token: '--series-u' }
  };
  const Q_LABEL = { R: '反射率 R', T: '透射率 T', A: '吸收率 A' };

  const state = {
    caseId: S.cases[0].id,
    n0: S.cases[0].n0,
    ns: S.cases[0].ns,
    layers: [],
    angle: 0,
    selectedWl: 550,
    quantity: 'R', // R | T | A
    roles: { s: false, p: false, u: true },
    grid: null,
    rgbTable: null
  };

  // ---------------------------------------------------------------- utilities
  let recomputeScheduled = false;
  function scheduleRecompute() {
    if (recomputeScheduled) return;
    recomputeScheduled = true;
    requestAnimationFrame(() => {
      recomputeScheduled = false;
      recompute();
    });
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function unpolAt(ai, qi) {
    const g = state.grid;
    const row = qi === 0 ? 'R' : qi === 1 ? 'T' : 'A';
    const sRow = g.s[row][ai];
    const pRow = g.p[row][ai];
    return sRow.map((v, i) => 0.5 * (v + pRow[i]));
  }

  function recompute() {
    const t0 = performance.now();
    state.grid = window.TMM.fullGrid(state.n0, state.ns, state.layers, WAVELENGTHS, ANGLES);
    // white-light RGB per integer degree
    state.rgbTable = ANGLES.map((ang, ai) => {
      const reflUnpol = unpolAt(ai, 0);
      return window.FilmColor.rgbFromSpectrum(reflUnpol, WEIGHTS).rgb;
    });
    renderAll();
    const dt = performance.now() - t0;
    setStatus(`已重算 · ${state.layers.length} 层 · ${dt.toFixed(0)} ms`);
  }

  function currentAngleIndex() {
    return clamp(Math.round(state.angle), 0, 85);
  }

  function currentWlIndex() {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < WAVELENGTHS.length; i++) {
      const dd = Math.abs(WAVELENGTHS[i] - state.selectedWl);
      if (dd < best) { best = dd; idx = i; }
    }
    return idx;
  }

  function activeRoleList() {
    return Object.keys(state.roles).filter((r) => state.roles[r]);
  }

  function roleValues(role, quantity, angleIndex) {
    const g = state.grid;
    if (role === 's') return g.s[quantity][angleIndex];
    if (role === 'p') return g.p[quantity][angleIndex];
    return g.s[quantity][angleIndex].map((v, i) => 0.5 * (v + g.p[quantity][angleIndex][i]));
  }

  function roleValuesAcrossAngles(role, quantity, wlIndex) {
    const g = state.grid;
    return ANGLES.map((_, ai) => {
      if (role === 's') return g.s[quantity][ai][wlIndex];
      if (role === 'p') return g.p[quantity][ai][wlIndex];
      return 0.5 * (g.s[quantity][ai][wlIndex] + g.p[quantity][ai][wlIndex]);
    });
  }

  function cssToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------------------------------------------------------------- DOM refs
  const $ = (id) => document.getElementById(id);
  let specChart;
  let angleChart;
  let sphere;

  // ---------------------------------------------------------------- rendering
  function renderAll() {
    renderLayerTable();
    renderHeaderValues();
    renderSpecChart();
    renderAngleChart();
    sphere.setData(state.rgbTable, state.angle);
    $('angleSlider').value = state.angle;
    $('angleReadout').textContent = `${state.angle.toFixed(1)}°`;
    $('sphereCanvas').setAttribute('aria-valuenow', String(state.angle));
  }

  function renderHeaderValues() {
    const ai = currentAngleIndex();
    const wi = currentWlIndex();
    const g = state.grid;
    const rows = [
      ['s', g.s.R[ai][wi], g.s.T[ai][wi], g.s.A[ai][wi]],
      ['p', g.p.R[ai][wi], g.p.T[ai][wi], g.p.A[ai][wi]]
    ];
    const tbody = $('statBody');
    tbody.textContent = '';
    for (const [pol, r, t, a] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<th scope="row">${pol}</th>` +
        `<td>${(r * 100).toFixed(2)}%</td>` +
        `<td>${(t * 100).toFixed(2)}%</td>` +
        `<td>${(a * 100).toFixed(2)}%</td>`;
      tbody.appendChild(tr);
    }
    const lin = window.FilmColor.rgbFromSpectrum(unpolAt(ai, 0), WEIGHTS);
    const swatch = $('rgbSwatch');
    swatch.style.background = window.FilmColor.rgbCss(lin.rgb);
    $('rgbReadout').textContent =
      `RGB(${lin.rgb.join(', ')}) · 线性(${lin.linear.map((v) => v.toFixed(3)).join(', ')})`;
  }

  function seriesDefs(valuesFn) {
    const out = [];
    for (const role of activeRoleList()) {
      out.push({
        name: `${ROLES[role].name} · ${Q_LABEL[state.quantity]}`,
        color: cssToken(ROLES[role].token),
        dash: role === 'u',
        visible: true,
        values: valuesFn(role)
      });
    }
    return out;
  }

  function renderSpecChart() {
    const ai = currentAngleIndex();
    specChart.setData(
      WAVELENGTHS,
      1,
      seriesDefs((role) => roleValues(role, state.quantity, ai))
    );
    specChart.setCursor(state.selectedWl);
  }

  function renderAngleChart() {
    const wi = currentWlIndex();
    angleChart.setData(
      ANGLES,
      1,
      seriesDefs((role) => roleValuesAcrossAngles(role, state.quantity, wi))
    );
    angleChart.setCursor(state.angle);
  }

  // ---------------------------------------------------------------- layer table
  function renderLayerTable() {
    const tbody = $('layerBody');
    tbody.textContent = '';
    state.layers.forEach((layer, i) => {
      const tr = document.createElement('tr');
      tr.className = 'layer-row';
      tr.innerHTML = `
        <td class="layer-index">${i + 1}</td>
        <td><input class="num d-input" type="number" min="${LIMITS.d[0]}" max="${LIMITS.d[1]}" step="1" value="${layer.d}" inputmode="decimal" aria-label="第 ${i + 1} 层厚度（纳米）"></td>
        <td><input class="num n-input" type="number" min="${LIMITS.n[0]}" max="${LIMITS.n[1]}" step="0.001" value="${layer.n}" inputmode="decimal" aria-label="第 ${i + 1} 层折射率 n"></td>
        <td><input class="num k-input" type="number" min="${LIMITS.k[0]}" max="${LIMITS.k[1]}" step="0.001" value="${layer.k}" inputmode="decimal" aria-label="第 ${i + 1} 层消光系数 k"></td>
        <td class="row-actions">
          <button type="button" class="icon-btn up" title="上移" aria-label="上移第 ${i + 1} 层"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon-btn down" title="下移" aria-label="下移第 ${i + 1} 层"${i === state.layers.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="icon-btn dup" title="复制" aria-label="复制第 ${i + 1} 层">⧉</button>
          <button type="button" class="icon-btn del" title="删除" aria-label="删除第 ${i + 1} 层">✕</button>
        </td>`;
      bindLayerRow(tr, i);
      tbody.appendChild(tr);
    });
    $('layerCount').textContent = `${state.layers.length} / ${LIMITS.maxLayers} 层`;
    $('addLayerBtn').disabled = state.layers.length >= LIMITS.maxLayers;
  }

  function bindLayerRow(tr, i) {
    const commit = (input, key, lo, hi) => {
      input.addEventListener('change', () => {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) { input.value = state.layers[i][key]; return; }
        v = clamp(v, lo, hi);
        input.value = v;
        state.layers[i][key] = v;
        scheduleRecompute();
      });
    };
    commit(tr.querySelector('.d-input'), 'd', LIMITS.d[0], LIMITS.d[1]);
    commit(tr.querySelector('.n-input'), 'n', LIMITS.n[0], LIMITS.n[1]);
    commit(tr.querySelector('.k-input'), 'k', LIMITS.k[0], LIMITS.k[1]);
    tr.querySelector('.up').addEventListener('click', () => moveLayer(i, i - 1));
    tr.querySelector('.down').addEventListener('click', () => moveLayer(i, i + 1));
    tr.querySelector('.dup').addEventListener('click', () => duplicateLayer(i));
    tr.querySelector('.del').addEventListener('click', () => deleteLayer(i));
  }

  function moveLayer(from, to) {
    if (to < 0 || to >= state.layers.length) return;
    const [row] = state.layers.splice(from, 1);
    state.layers.splice(to, 0, row);
    scheduleRecompute();
  }

  function duplicateLayer(i) {
    if (state.layers.length >= LIMITS.maxLayers) return;
    const src = state.layers[i];
    state.layers.splice(i + 1, 0, { d: src.d, n: src.n, k: src.k });
    scheduleRecompute();
  }

  function deleteLayer(i) {
    state.layers.splice(i, 1);
    scheduleRecompute();
  }

  function addLayer() {
    if (state.layers.length >= LIMITS.maxLayers) return;
    state.layers.push({ d: 100, n: 1.5, k: 0 });
    scheduleRecompute();
  }

  // ---------------------------------------------------------------- medium inputs
  function bindMediumInputs() {
    const bind = (id, key) => {
      const input = $(id);
      input.addEventListener('change', () => {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v) || v < 1) { input.value = state[key]; return; }
        v = clamp(v, 1, 5);
        input.value = v;
        state[key] = v;
        scheduleRecompute();
      });
    };
    bind('n0Input', 'n0');
    bind('nsInput', 'ns');
  }

  // ---------------------------------------------------------------- case select
  function loadCase(caseData) {
    state.caseId = caseData.id;
    state.n0 = caseData.n0;
    state.ns = caseData.ns;
    state.layers = caseData.layers.map(([d, n, k]) => ({ d, n, k }));
    state.angle = caseData.angle;
    $('n0Input').value = state.n0;
    $('nsInput').value = state.ns;
    scheduleRecompute();
  }

  function buildCasePicker() {
    const sel = $('caseSelect');
    sel.textContent = '';
    S.cases.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const c = S.cases.find((x) => x.id === sel.value);
      if (c) loadCase(c);
    });
  }

  // ---------------------------------------------------------------- export
  function buildExportPayload() {
    return {
      generatedAt: new Date().toISOString(),
      parameters: {
        caseId: state.caseId,
        incidentMediumN: state.n0,
        substrateN: state.ns,
        layers: state.layers.map((l, i) => ({
          order: i + 1,
          thicknessNm: l.d,
          n: l.n,
          k: l.k
        })),
        wavelengthNm: WAVELENGTHS,
        incidenceAngleDeg: ANGLES
      },
      rgbWeights: {
        wavelengths: WAVELENGTHS,
        red: WEIGHTS[0],
        green: WEIGHTS[1],
        blue: WEIGHTS[2]
      },
      spectra: state.grid
    };
  }

  function offerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(buildExportPayload(), null, 2)], {
      type: 'application/json'
    });
    offerDownload(blob, `film-stack-${state.caseId}.json`);
    setStatus('已导出光谱 JSON');
  }

  function exportPng() {
    const W = 1200;
    const H = 900;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx = off.getContext('2d');
    const bg = cssToken('--surface');
    const fg = cssToken('--fg');
    const muted = cssVarSafe('--text-muted', fg);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // header
    ctx.fillStyle = fg;
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.fillText('多层镀膜 · 白光球面反射预览', 48, 56);
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = muted;
    const caseLabel = S.cases.find((c) => c.id === state.caseId)?.label || state.caseId;
    ctx.fillText(
      `${caseLabel} · n₀=${state.n0} · n_s=${state.ns} · ${state.layers.length} 层 · 当前角度 ${state.angle.toFixed(1)}°`,
      48, 86
    );

    // sphere (square)
    const sphereSize = 460;
    const sx = 48;
    const sy = 130;
    const src = $('sphereCanvas');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, src.width, src.width, sx, sy, sphereSize, sphereSize);
    ctx.strokeStyle = cssToken('--sphere-rim');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, sphereSize, sphereSize);

    // parameter table on the right
    let tx = 560;
    let ty = 150;
    ctx.fillStyle = fg;
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText('膜层参数（入射侧 → 基底）', tx, ty);
    ty += 30;
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = muted;
    ctx.fillText('#      d (nm)      n          k', tx, ty);
    ty += 22;
    ctx.fillStyle = fg;
    state.layers.forEach((l, i) => {
      ctx.fillText(
        `${String(i + 1).padStart(2)}   ${String(l.d).padStart(7)}   ${l.n.toFixed(3).padStart(7)}   ${l.k.toFixed(3).padStart(7)}`,
        tx, ty
      );
      ty += 21;
    });
    if (state.layers.length === 0) {
      ctx.fillStyle = muted;
      ctx.fillText('（无膜层，仅裸界面）', tx, ty);
    }

    // current-angle spectrum strip at the bottom
    const ai = currentAngleIndex();
    const plotX = 48;
    const plotY = 640;
    const plotW = W - 96;
    const plotH = 200;
    ctx.fillStyle = fg;
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(`${state.angle.toFixed(1)}° 处的反射/透射/吸收谱（无偏振）`, plotX, plotY - 16);
    ctx.strokeStyle = cssToken('--grid-line');
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const yy = plotY + plotH - (g / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotX, yy);
      ctx.lineTo(plotX + plotW, yy);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`${g * 25}%`, plotX - 40, yy + 4);
    }
    const drawStrip = (quantity, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      WAVELENGTHS.forEach((wl, i) => {
        const x = plotX + (i / (WAVELENGTHS.length - 1)) * plotW;
        const v = 0.5 * (state.grid.s[quantity][ai][i] + state.grid.p[quantity][ai][i]);
        const y = plotY + plotH - v * plotH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawStrip('R', cssToken('--series-u'));
    drawStrip('T', cssToken('--series-s'));
    drawStrip('A', cssToken('--series-p'));
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('400 nm', plotX, plotY + plotH + 18);
    ctx.fillText('700 nm', plotX + plotW - 44, plotY + plotH + 18);

    off.toBlob((blob) => {
      if (blob) {
        offerDownload(blob, `film-stack-${state.caseId}-sphere.png`);
        setStatus('已导出预览 PNG');
      }
    }, 'image/png');
  }

  function cssVarSafe(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function setStatus(text) {
    $('statusLine').textContent = text;
  }

  // ---------------------------------------------------------------- wiring
  function wireControls() {
    $('addLayerBtn').addEventListener('click', addLayer);
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('exportPngBtn').addEventListener('click', exportPng);

    const slider = $('angleSlider');
    slider.addEventListener('input', () => {
      state.angle = parseFloat(slider.value);
      $('angleReadout').textContent = `${state.angle.toFixed(1)}°`;
      renderSpecChart();
      renderAngleChart();
      sphere.setAngle(state.angle);
      renderHeaderValues();
    });

    document.querySelectorAll('input[name="quantity"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.quantity = radio.value;
        renderSpecChart();
        renderAngleChart();
      });
    });

    document.querySelectorAll('input[name="role"]').forEach((check) => {
      check.addEventListener('change', () => {
        state.roles[check.value] = check.checked;
        renderSpecChart();
        renderAngleChart();
      });
    });
  }

  function init() {
    buildCasePicker();
    bindMediumInputs();
    wireControls();

    specChart = new window.LineChart($('specChart'), {
      xLabel: '波长 (nm)',
      xTicks: [400, 450, 500, 550, 600, 650, 700],
      ttTitle: (wl) => `${wl} nm`,
      onCursor: (wl) => {
        state.selectedWl = wl;
        $('wlReadout').textContent = `${wl} nm 切片`;
        angleChart.setCursor(state.angle);
        renderAngleChart();
        renderHeaderValues();
      }
    });
    angleChart = new window.LineChart($('angleChart'), {
      xLabel: '入射角 (°)',
      xTicks: [0, 15, 30, 45, 60, 75, 85],
      ttTitle: (ang) => `${ang}°`,
      onCursor: (ang) => {
        state.angle = ang;
        $('angleSlider').value = ang;
        $('angleReadout').textContent = `${ang.toFixed(1)}°`;
        specChart.setCursor(state.selectedWl);
        renderSpecChart();
        sphere.setAngle(ang);
        renderHeaderValues();
      }
    });
    sphere = new window.SphereView($('sphereCanvas'), {
      onPick: (ang) => {
        state.angle = ang;
        $('angleSlider').value = ang;
        $('angleReadout').textContent = `${ang.toFixed(1)}°`;
        renderSpecChart();
        angleChart.setCursor(ang);
        sphere.setAngle(ang);
        renderHeaderValues();
      }
    });

    // re-render sphere when the theme changes (canvas reads CSS variables)
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => sphere.render());

    loadCase(S.cases[0]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
