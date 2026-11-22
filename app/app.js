/* 四面体探针校验台 — interface logic.

   Depends on (loaded before this file):
     TETRA_CORE, TETRA_TRIANGULATE, TETRA_QUERY, TETRA_EXPORT, TETRA_CASES

   The page has no network access beyond the font stylesheet. All state lives in memory;
   the only retained preference is the chosen case id in localStorage. */
'use strict';
(function () {
  const CORE = window.TETRA_CORE;
  const TRI = window.TETRA_TRIANGULATE;
  const QUERY = window.TETRA_QUERY;
  const EXPORT = window.TETRA_EXPORT;
  const EXTRA = window.TETRA_CASES;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : '—');
  const rad = (d) => (d * Math.PI) / 180;

  /* ------------------------------------------------------------------ state */

  const state = {
    caseId: null,
    caseName: '',
    probes: [],            /* {id, position:[x,y,z], coefficients:[3][4]} */
    tri: null,
    error: null,
    query: [0, 0, 0],
    normal: [0, 1, 0],
    plane: { axis: 'z', offset: 0 },
    vis: { tets: true, hull: true, ball: true },
    last: null,            /* last evaluate() result */
    lastAuto: null,        /* region of the last auto-recorded row */
    log: [],
    sweep: null,
  };

  const view = {
    yaw: -0.62,
    pitch: 0.48,
    dist: 2.45,
    target: [0, 0, 0],
    radius: 10,
    userZoomed: false,
  };

  /* ------------------------------------------------------------------ cases */

  let sampleCases = null;

  function loadSampleCases() {
    if (sampleCases) return sampleCases;
    const node = document.getElementById('sample-data');
    if (!node) { sampleCases = []; return sampleCases; }
    try {
      const json = JSON.parse(node.textContent);
      sampleCases = (json.cases || []).map((c, i) => ({
        id: c.id,
        name: c.id === 'affine' ? '仿射样例' : c.id === 'cosphere' ? '共球样例' : c.id,
        desc: c.id === 'affine' ? '5 个探针 · 线性精确' : c.id === 'cosphere' ? '8 个探针 · 共球' : '',
        probes: c.probes.map((p) => ({
          id: String(p.id),
          p: p.p.slice(),
          c: p.c.map((row) => row.slice()),
        })),
        queries: (c.queries || []).map((q) => q.slice()),
      }));
    } catch (err) {
      sampleCases = [];
    }
    return sampleCases;
  }

  function allCases() {
    return loadSampleCases().concat(EXTRA.cases);
  }

  /* ------------------------------------------------------------------ model */

  function buildProject(caseData, pointsOverride) {
    const probes = caseData.probes.map((p) => ({
      id: p.id,
      position: p.p.slice(),
      coefficients: p.c.map((row) => row.slice()),
    }));
    const points = pointsOverride || probes.map((p) => p.position);
    const tri = TRI.triangulate(points);
    if (!tri.ok) {
      return { ok: false, error: tri, probes, tri: null };
    }
    return { ok: true, probes, tri };
  }

  function bounds(points) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k]);
        hi[k] = Math.max(hi[k], p[k]);
      }
    }
    const center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    let radius = 0;
    for (const p of points) {
      radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
    }
    return { lo, hi, center, radius: Math.max(radius, 1) };
  }

  /* ------------------------------------------------------------------ select */

  function selectCase(id, opts) {
    const cse = allCases().find((c) => c.id === id) || allCases()[0];
    if (!cse) return;
    if (state.sweep) stopSweep();
    const project = buildProject(cse);
    state.caseId = cse.id;
    state.caseName = cse.name || cse.id;
    state.probes = project.probes;
    state.error = project.ok ? null : project.error;
    state.tri = project.ok ? project.tri : null;
    state.log = [];
    state.lastAuto = null;

    if (project.ok) {
      const b = bounds(state.probes.map((p) => p.position));
      view.target = b.center.slice();
      view.radius = b.radius;
      view.yaw = -0.62;
      view.pitch = 0.48;
      fitView($('#view3d'));
      state.plane.axis = 'z';
      const q = (cse.queries && cse.queries[0]) || b.center.slice();
      state.query = q.map((v) => Math.round(v * 10) / 10);
      /* Put the cut plane through the first query point so the section view opens
         on the point being inspected. */
      state.plane.offset = clamp(state.query[2], b.lo[2], b.hi[2]);
      state.normal = [0, 1, 0];
      /* Seed the log with the case's own query points. */
      for (const qp of (cse.queries || [])) recordQuery(qp.slice(), '用例查询点', false);
      /* The current query already sits in the log; start auto-recording from its
         region so the first recompute doesn't add a duplicate row. */
      const r0 = evalAt(state.query);
      state.lastAuto = r0 && r0.ok ? { tet: r0.tet, outside: r0.outside } : null;
    } else {
      state.query = [0, 0, 0];
    }

    $('#caseMeta').textContent = state.error
      ? '剖分失败'
      : state.probes.length + ' 探针 · ' + state.tri.tets.length + ' 单元';

    try { localStorage.setItem('tetra.case', state.caseId); } catch (e) { /* ignore */ }

    renderCaseList();
    syncPlaneControls();
    recompute({ keepLog: true });
    if (opts && opts.toast) toast('已切换到 ' + state.caseName);
  }

  /* ------------------------------------------------------------------ recompute */

  function normalFromAngles(azDeg, elDeg) {
    const az = rad(azDeg), el = rad(elDeg);
    return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  }

  function anglesFromNormal(n) {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const el = Math.asin(clamp(n[1] / len, -1, 1));
    const az = Math.atan2(n[0] / len, n[2] / len);
    return { az: ((az * 180) / Math.PI + 360) % 360, el: (el * 180) / Math.PI };
  }

  function recompute(opts) {
    const o = opts || {};
    if (state.error) {
      renderError();
      renderHeaderStats();
      renderQueryPanel();
      renderWeights();
      renderLog();
      renderBall();
      draw3D();
      drawSection();
      return;
    }
    const points = state.probes.map((p) => p.position);
    const coeffs = state.probes.map((p) => p.coefficients);
    const res = QUERY.evaluate(points, state.tri.tets, state.tri.hull, coeffs, state.query, state.normal);
    state.last = res.ok ? res : null;
    if (res.ok && !o.silent) maybeRecord(res);
    renderHeaderStats();
    renderQueryPanel();
    renderWeights();
    renderBall();
    renderLog();
    draw3D();
    drawSection();
  }

  /* ------------------------------------------------------------------ logging */

  function evalAt(q) {
    if (!state.tri) return null;
    const points = state.probes.map((p) => p.position);
    const coeffs = state.probes.map((p) => p.coefficients);
    return QUERY.evaluate(points, state.tri.tets, state.tri.hull, coeffs, q, state.normal);
  }

  function makeRecord(q, category, res) {
    const r = res || evalAt(q);
    if (!r || !r.ok) return null;
    return {
      point: q.slice(),
      region: r.outside ? 'outside' : 'inside',
      category: category || '',
      tet: r.tet,
      probes: r.probes.slice(),
      weights: r.weights.slice(),
      projected: r.projected ? r.projected.slice() : null,
      distance: r.distance || 0,
      distance: r.distance,
      normal: r.normal.slice(),
      raw: r.raw.slice(),
      clamped: r.clamped.slice(),
      negative: r.negative.slice(),
    };
  }

  const LOG_LIMIT = 400;

  function pushRecord(rec) {
    if (!rec) return false;
    state.log.push(rec);
    if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
    return true;
  }

  function recordQuery(q, category, explicit) {
    pushRecord(makeRecord(q, category));
  }

  /* Auto-record when the query crosses into another tetrahedron or leaves the hull. */
  function maybeRecord(res) {
    const prev = state.log[state.log.length - 1];
    const lastAuto = state.lastAuto;
    if (!lastAuto) return;
    const changed = lastAuto.tet !== res.tet || lastAuto.outside !== res.outside;
    if (!changed) return;
    pushRecord(makeRecord(state.query, res.outside ? '包外投影' : '跨单元', res));
    state.lastAuto = { tet: res.tet, outside: res.outside };
    renderLog();
  }

  /* ------------------------------------------------------------------ header */

  function renderHeaderStats() {
    const host = $('#barStats');
    const bits = [];
    if (state.error) {
      bits.push('<span class="pill bad">剖分失败</span>');
    } else if (state.tri) {
      const v = state.tri.validation;
      bits.push('<span class="pill">探针 <b>' + state.probes.length + '</b></span>');
      bits.push('<span class="pill">四面体 <b>' + state.tri.tets.length + '</b></span>');
      bits.push('<span class="pill">凸包面 <b>' + state.tri.hull.length + '</b></span>');
      bits.push('<span class="pill ' + (v.ok ? 'ok' : 'bad') + '">' +
        (v.ok ? '✓ 剖分校验通过' : '剖分校验失败') + '</span>');
      bits.push('<span class="pill fp">指纹 <b class="mono">' + state.tri.fingerprint + '</b></span>');
    }
    host.innerHTML = bits.join('');
  }

  function renderError() {
    /* The 3D canvas paints the reason. The query card and weights show their own
       empty states, and the case list marks the failing case. */
  }

  /* ------------------------------------------------------------------ camera */

  function cameraBasis() {
    const { yaw, pitch } = view;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* world is Z-up. `back` points from the target toward the eye. */
    const back = [cy * cp, sy * cp, sp];
    const eye = [
      view.target[0] + back[0] * view.dist * view.radius,
      view.target[1] + back[1] * view.dist * view.radius,
      view.target[2] + back[2] * view.dist * view.radius,
    ];
    const forward = [-back[0], -back[1], -back[2]];
    /* Screen basis: right = forward x worldUp (worldUp=(0,0,1)), up = back x right.
       Then (right, up, back) is right-handed, matching a standard camera. */
    let right = [forward[1], -forward[0], 0];
    const rl = Math.hypot(right[0], right[1], right[2]);
    if (rl < 1e-6) right = [1, 0, 0];
    else right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up = [
      back[1] * right[2] - back[2] * right[1],
      back[2] * right[0] - back[0] * right[2],
      back[0] * right[1] - back[1] * right[0],
    ];
    return { back, forward, right, up, eye };
  }

  function makeProjector(w, h) {
    const cam = cameraBasis();
    const fov = 0.66;
    const f = (h / 2) / Math.tan(fov / 2);
    const cx = w / 2, cy = h / 2;
    return {
      cam, f, w, h,
      project(p) {
        const dx = p[0] - cam.eye[0], dy = p[1] - cam.eye[1], dz = p[2] - cam.eye[2];
        const x = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
        const y = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
        const z = dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2];
        if (z <= 0.001) return null;
        return { x: cx + (x / z) * f, y: cy - (y / z) * f, z, scale: f / z };
      },
      worldPerPixel(depth) { return depth / f; },
    };
  }

  /* Choose a camera distance that keeps the whole bounding box inside the canvas with
     a margin, for any dataset from a single tetrahedron to the ±1000 extremes. */
  function fitView(canvas) {
    if (!state.tri || !canvas) return;
    if (canvas.id === 'section') {
      /* Section view has its own scaled-to-fit mapping; the canvas box is sized in
         drawSection, so only its aspect needs a nudge here. */
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const b = bounds(state.tri.points);
    view.target = b.center.slice();
    view.radius = b.radius;

    const corners = [];
    for (const x of [b.lo[0], b.hi[0]])
      for (const y of [b.lo[1], b.hi[1]])
        for (const z of [b.lo[2], b.hi[2]]) corners.push([x, y, z]);

    const fits = (dist) => {
      view.dist = dist;
      const P = makeProjector(w, h);
      const mx = w * 0.5 * 0.9, my = h * 0.5 * 0.88;
      for (const c of corners) {
        const v = P.project(c);
        if (!v) return false;
        if (Math.abs(v.x - w / 2) > mx || Math.abs(v.y - h / 2) > my) return false;
      }
      return true;
    };

    let lo = 1.1, hi = 12;
    if (!fits(hi)) { view.dist = hi; return; }
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    view.dist = hi;
  }

  /* ------------------------------------------------------------------ canvas */

  function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h, dpr };
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function colorWithAlpha(hex, a) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ---------------------------------------------------------------- 3D view */

  function draw3D() {
    const canvas = $('#view3d');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    if (state.error || !state.tri) {
      const err = state.error;
      ctx.fillStyle = cssVar('--ink-3');
      ctx.font = '13px "IBM Plex Sans", "Noto Sans SC", sans-serif';
      ctx.textAlign = 'center';
      const msg = err ? err.message : '没有可显示的剖分';
      wrapText(ctx, msg, w / 2, h / 2 - 20, Math.min(w - 60, 520), 22);
      return;
    }

    const P = makeProjector(w, h);
    const points = state.tri.points;
    const tri = state.tri;
    const ink = cssVar('--ink');
    const geo = cssVar('--geo');
    const accent = cssVar('--accent');
    const canvasBg = cssVar('--canvas-bg');

    /* backdrop grid: a faint horizon-ish floor grid at the hull's lowest z */
    drawStageGrid(ctx, P, w, h);

    /* auxiliary axes at the hull corner */
    drawAxes(ctx, P, points);

    /* hull faces, back-to-front */
    if (state.vis.hull && tri.hull.length) {
      const faces = tri.hull.map((hf) => {
        const pts = hf.tri.map((i) => P.project(points[i]));
        if (pts.some((p) => !p)) return null;
        const depth = (pts[0].z + pts[1].z + pts[2].z) / 3;
        return { pts, depth };
      }).filter(Boolean).sort((A, B) => B.depth - A.depth);
      ctx.lineWidth = 1;
      for (const f of faces) {
        ctx.beginPath();
        ctx.moveTo(f.pts[0].x, f.pts[0].y);
        ctx.lineTo(f.pts[1].x, f.pts[1].y);
        ctx.lineTo(f.pts[2].x, f.pts[2].y);
        ctx.closePath();
        ctx.fillStyle = colorWithAlpha(canvasBg, 0.28);
        ctx.fill();
        ctx.strokeStyle = colorWithAlpha(geo, 0.28);
        ctx.stroke();
      }
    }

    /* cut plane */
    drawPlane3D(ctx, P, w, h);

    /* tetrahedron edges */
    const selectedTet = state.last ? state.last.tet : -1;
    const edges = new Map();
    const addEdge = (a, b, tetIndex) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      const e = edges.get(k);
      if (e) e.tets.add(tetIndex); else edges.set(k, { a, b, tets: new Set([tetIndex]) });
    };
    tri.tets.forEach((t, ti) => {
      for (const [i, j] of [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]) addEdge(t[i], t[j], ti);
    });

    if (state.vis.tets) {
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = colorWithAlpha(ink, 0.16);
      ctx.beginPath();
      for (const e of edges.values()) {
        if (e.tets.has(selectedTet)) continue;
        const A = P.project(points[e.a]), B = P.project(points[e.b]);
        if (!A || !B) continue;
        ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
      }
      ctx.stroke();
    }

    if (selectedTet >= 0) {
      const t = tri.tets[selectedTet];
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = colorWithAlpha(accent, 0.9);
      ctx.beginPath();
      for (const [i, j] of [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]) {
        const A = P.project(points[t[i]]), B = P.project(points[t[j]]);
        if (!A || !B) continue;
        ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
      }
      ctx.stroke();
      /* tint the selected cell */
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const v = P.project(points[t[k]]);
        if (!v) continue;
        if (k === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
      }
      ctx.closePath();
      ctx.fillStyle = colorWithAlpha(accent, 0.09);
      ctx.fill();
    }

    /* probes */
    const participating = new Set(state.last ? state.last.probes : []);
    for (let i = 0; i < points.length; i++) {
      const v = P.project(points[i]);
      if (!v) continue;
      const isP = participating.has(i);
      const r = clamp(v.scale * 0.012 * view.radius, 2, 5) * (isP ? 1.55 : 1);
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      if (isP) {
        ctx.fillStyle = accent; ctx.fill();
        ctx.lineWidth = 1.6; ctx.strokeStyle = cssVar('--surface'); ctx.stroke();
      } else {
        ctx.fillStyle = cssVar('--surface');
        ctx.fill();
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = colorWithAlpha(ink, 0.45);
        ctx.stroke();
      }
      if (isP) {
        ctx.fillStyle = accent;
        ctx.font = '600 10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('P' + i, v.x, v.y - r - 4);
      }
    }

    /* projection link and marker */
    const res = state.last;
    if (res && res.outside && res.projected) {
      const a = P.project(state.query), b = P.project(res.projected);
      if (a && b) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = colorWithAlpha(geo, 0.9);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
        drawDiamond(ctx, b.x, b.y, 5, geo, cssVar('--surface'));
        ctx.fillStyle = geo;
        ctx.font = '600 10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('投影 ' + fmt(res.distance, 1), b.x + 9, b.y + 3);
      }
    }

    /* query point + test ball: the ball hangs off the marker on a short leader so it
       never hides the crosshair it belongs to */
    const qv = P.project(state.query);
    if (qv) {
      const ballR = clamp(17 * (w / 900) + 10, 15, 26);
      /* place the ball in whichever quadrant has room around the marker */
      const sx = qv.x < w * 0.5 ? -1 : 1;
      const sy = qv.y < h * 0.5 ? 1 : -1;
      const bx = qv.x + sx * (ballR + 16), by = qv.y + sy * (ballR + 14);
      if (state.vis.ball) {
        ctx.save();
        ctx.strokeStyle = colorWithAlpha(accent, 0.4);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(qv.x, qv.y); ctx.lineTo(bx, by); ctx.stroke();
        ctx.restore();
        drawBall3D(ctx, bx, by, ballR, res);
      }
      drawCrosshair(ctx, qv.x, qv.y, accent);
      ctx.fillStyle = accent;
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Q', qv.x + 9, qv.y - 11);
    }
  }

  function drawStageGrid(ctx, P, w, h) {
    if (!state.tri) return;
    const b = bounds(state.tri.points);
    const z = b.lo[2];
    const N = 6;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = colorWithAlpha(cssVar('--grid-line'), 0.7);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = lerp(b.lo[0], b.hi[0], t);
      const y = lerp(b.lo[1], b.hi[1], t);
      pts.push([P.project([x, b.lo[1], z]), P.project([x, b.hi[1], z])]);
      pts.push([P.project([b.lo[0], y, z]), P.project([b.hi[0], y, z])]);
    }
    ctx.beginPath();
    for (const [a, c] of pts) {
      if (!a || !c) continue;
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
  }

  function drawAxes(ctx, P, points) {
    const b = bounds(points);
    const origin = [b.lo[0] - b.radius * 0.16, b.lo[1] - b.radius * 0.16, b.lo[2]];
    const L = b.radius * 0.28;
    const o = P.project(origin);
    if (!o) return;
    const spec = [
      { d: [L, 0, 0], label: 'x', color: cssVar('--crit') },
      { d: [0, L, 0], label: 'y', color: cssVar('--good') },
      { d: [0, 0, L], label: 'z', color: cssVar('--geo') },
    ];
    ctx.lineWidth = 1.2;
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    for (const s of spec) {
      const v = P.project([origin[0] + s.d[0], origin[1] + s.d[1], origin[2] + s.d[2]]);
      if (!v) continue;
      ctx.strokeStyle = colorWithAlpha(s.color, 0.65);
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(v.x, v.y); ctx.stroke();
      ctx.fillStyle = colorWithAlpha(s.color, 0.85);
      ctx.fillText(s.label, v.x, v.y - 4);
    }
  }

  function drawPlane3D(ctx, P, w, h) {
    const tri = state.tri;
    const b = bounds(tri.points);
    const axis = state.plane.axis;
    const off = state.plane.offset;
    const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    if (off < b.lo[k] - 0.01 || off > b.hi[k] + 0.01) return;
    const corners = [];
    const u = (k + 1) % 3, v = (k + 2) % 3;
    for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = [0, 0, 0];
      p[k] = off;
      p[u] = lerp(b.lo[u], b.hi[u], cu);
      p[v] = lerp(b.lo[v], b.hi[v], cv);
      corners.push(P.project(p));
    }
    if (corners.some((c) => !c)) return;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = colorWithAlpha(cssVar('--geo'), 0.07);
    ctx.fill();
    ctx.strokeStyle = colorWithAlpha(cssVar('--geo'), 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCrosshair(ctx, x, y, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 7, y);
    ctx.moveTo(x + 7, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 7);
    ctx.moveTo(x, y + 7); ctx.lineTo(x, y + 11);
    ctx.stroke();
    ctx.restore();
  }

  function drawDiamond(ctx, x, y, r, color, ring) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = ring; ctx.stroke();
    ctx.restore();
  }

  /* Shaded sphere whose light comes from the evaluated coefficients. The card below
     holds the authoritative readout; this is the in-scene copy. */
  function drawBall3D(ctx, x, y, r, res) {
    const rgb = res && res.ok ? res.clamped : [0.18, 0.18, 0.18];
    const srgb = rgb.map((v) => Math.pow(clamp(v, 0, 1), 1 / 2.2));
    const light = 0.28;
    const base = srgb.map((v) => v * (1 - light) + light * Math.min(1, v * 1.5));
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgb(' + base.map((v) => Math.round(clamp(v * 1.18, 0, 1) * 255)).join(',') + ')');
    g.addColorStop(0.72, 'rgb(' + base.map((v) => Math.round(clamp(v * 0.82, 0, 1) * 255)).join(',') + ')');
    g.addColorStop(1, 'rgb(' + base.map((v) => Math.round(clamp(v * 0.45, 0, 1) * 255)).join(',') + ')');
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = colorWithAlpha(cssVar('--ink'), 0.35);
    ctx.stroke();
    ctx.restore();
  }

  function wrapText(ctx, text, x, y, maxW, lh) {
    const chars = Array.from(text);
    let line = '', yy = y;
    for (const ch of chars) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy); line = ch; yy += lh;
      } else line = test;
    }
    if (line) ctx.fillText(line, x, yy);
  }

  /* ---------------------------------------------------------------- section */

  const AXES = {
    x: { k: 0, u: 1, v: 2, ul: 'Y', vl: 'Z', fixed: 'X' },
    y: { k: 1, u: 0, v: 2, ul: 'X', vl: 'Z', fixed: 'Y' },
    z: { k: 2, u: 0, v: 1, ul: 'X', vl: 'Y', fixed: 'Z' },
  };

  function planePoint(u, v) {
    const ax = AXES[state.plane.axis];
    const p = [0, 0, 0];
    p[ax.k] = state.plane.offset;
    p[ax.u] = u;
    p[ax.v] = v;
    return p;
  }

  function sectionExtent() {
    const ax = AXES[state.plane.axis];
    const b = bounds(state.tri ? state.tri.points : state.probes.map((p) => p.position));
    return {
      u0: b.lo[ax.u], u1: b.hi[ax.u],
      v0: b.lo[ax.v], v1: b.hi[ax.v],
      lo: b.lo, hi: b.hi,
    };
  }

  function makeSectionMap(w, h) {
    const e = sectionExtent();
    const pad = 34;
    const uSpan = Math.max(1e-6, e.u1 - e.u0);
    const vSpan = Math.max(1e-6, e.v1 - e.v0);
    const availW = w - pad * 2, availH = h - pad * 2;
    const s = Math.min(availW / uSpan, availH / vSpan);
    const ox = pad + (availW - uSpan * s) / 2;
    const oy = pad + (availH - vSpan * s) / 2;
    return {
      e, s,
      toScreen(u, v) { return { x: ox + (u - e.u0) * s, y: oy + (e.v1 - v) * s }; },
      toPlane(x, y) { return { u: e.u0 + (x - ox) / s, v: e.v1 - (y - oy) / s }; },
      inside(x, y) { return x >= ox && x <= ox + uSpan * s && y >= oy && y <= oy + vSpan * s; },
    };
  }

  /* Clip a tetrahedron by the section plane, returning the section polygon in plane coords. */
  function clipTet(tet, points) {
    const ax = AXES[state.plane.axis];
    const off = state.plane.offset;
    const d = tet.map((i) => points[i][ax.k] - off);
    const pts = [];
    const edge = (i, j) => {
      if ((d[i] > 0 && d[j] > 0) || (d[i] < 0 && d[j] < 0)) return;
      if (d[i] === 0 && d[j] === 0) return;
      const t = d[i] / (d[i] - d[j]);
      const p = [0, 0, 0];
      p[ax.k] = off;
      p[ax.u] = lerp(points[tet[i]][ax.u], points[tet[j]][ax.u], t);
      p[ax.v] = lerp(points[tet[i]][ax.v], points[tet[j]][ax.v], t);
      pts.push([p[ax.u], p[ax.v]]);
    };
    edge(0, 1); edge(0, 2); edge(0, 3);
    edge(1, 2); edge(1, 3); edge(2, 3);
    if (pts.length < 3) return null;
    /* dedupe and order around centroid */
    const uniq = [];
    for (const p of pts) {
      if (!uniq.some((q) => Math.abs(q[0] - p[0]) < 1e-7 && Math.abs(q[1] - p[1]) < 1e-7)) uniq.push(p);
    }
    if (uniq.length < 3) return null;
    const c = uniq.reduce((s, p) => [s[0] + p[0] / uniq.length, s[1] + p[1] / uniq.length], [0, 0]);
    uniq.sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
    return uniq;
  }

  function drawSection() {
    const canvas = $('#section');
    if (!canvas) return;
    const wrap = $('#sectionWrap');

    /* Fit the canvas to the plane's real proportions inside the available box,
       centred, so nothing is stretched along an axis. */
    if (state.tri) {
      const e = sectionExtent();
      const uSpan = Math.max(1e-6, e.u1 - e.u0);
      const vSpan = Math.max(1e-6, e.v1 - e.v0);
      const availW = Math.max(200, wrap.clientWidth - 2);
      const availH = Math.max(200, wrap.clientHeight - 2);
      const sFit = Math.min(availW / uSpan, availH / vSpan);
      const cssW = Math.max(180, uSpan * sFit);
      const cssH = Math.max(160, vSpan * sFit);
      const cw = cssW.toFixed(1) + 'px', ch = cssH.toFixed(1) + 'px';
      if (canvas.style.width !== cw) canvas.style.width = cw;
      if (canvas.style.height !== ch) canvas.style.height = ch;
    }

    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (state.error || !state.tri) return;

    const ax = AXES[state.plane.axis];
    const map = makeSectionMap(w, h);
    const points = state.tri.points;
    const ink = cssVar('--ink');
    const accent = cssVar('--accent');
    const geo = cssVar('--geo');

    /* frame */
    ctx.strokeStyle = colorWithAlpha(cssVar('--line-strong'), 0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(map.toScreen(map.e.u0, map.e.v1).x, map.toScreen(map.e.u0, map.e.v1).y,
      (map.e.u1 - map.e.u0) * map.s, (map.e.v1 - map.e.v0) * map.s);

    /* section polygons: light fill, selected cell highlighted */
    const selected = state.last ? state.last.tet : -1;
    const polys = [];
    state.tri.tets.forEach((t, ti) => {
      const poly = clipTet(t, points);
      if (poly) polys.push({ ti, poly });
    });

    if (!polys.length) {
      const e = sectionExtent();
      const outside = state.plane.offset < e.lo[ax.k] - 1e-9 || state.plane.offset > e.hi[ax.k] + 1e-9;
      ctx.fillStyle = cssVar('--ink-3');
      ctx.font = '12px "IBM Plex Sans", "Noto Sans SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(outside ? '切面在模型之外，没有截面' : '切面只擦到模型边缘，截面退化为线或点',
        w / 2, h / 2);
      /* still draw probes so the view is not empty */
    }
    for (const { ti, poly } of polys) {
      ctx.beginPath();
      poly.forEach((p, i) => {
        const s = map.toScreen(p[0], p[1]);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      if (ti === selected) {
        ctx.fillStyle = colorWithAlpha(accent, 0.17);
        ctx.fill();
        ctx.strokeStyle = colorWithAlpha(accent, 0.95);
        ctx.lineWidth = 1.8;
      } else {
        ctx.fillStyle = colorWithAlpha(cssVar('--geo'), 0.045);
        ctx.fill();
        ctx.strokeStyle = colorWithAlpha(ink, 0.16);
        ctx.lineWidth = 0.8;
      }
      ctx.stroke();
    }

    /* probes: on-plane strongly, off-plane faint */
    const participating = new Set(state.last ? state.last.probes : []);
    points.forEach((p, i) => {
      const s = map.toScreen(p[ax.u], p[ax.v]);
      const dz = Math.abs(p[ax.k] - state.plane.offset);
      const near = dz < (map.e.hi[ax.k] - map.e.lo[ax.k]) * 0.06;
      const isP = participating.has(i);
      ctx.beginPath();
      ctx.arc(s.x, s.y, isP ? 4.2 : near ? 3.1 : 2.1, 0, Math.PI * 2);
      if (isP) { ctx.fillStyle = accent; ctx.fill(); }
      else {
        ctx.fillStyle = cssVar('--surface');
        ctx.fill();
        ctx.strokeStyle = colorWithAlpha(ink, near ? 0.6 : 0.22);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (isP) {
        ctx.fillStyle = accent;
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('P' + i, s.x + 6, s.y - 5);
      }
    });

    /* projection marker */
    const res = state.last;
    if (res && res.outside && res.projected) {
      const s = map.toScreen(res.projected[ax.u], res.projected[ax.v]);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = colorWithAlpha(geo, 0.85);
      ctx.lineWidth = 1.1;
      const qs = map.toScreen(state.query[ax.u], state.query[ax.v]);
      ctx.beginPath(); ctx.moveTo(qs.x, qs.y); ctx.lineTo(s.x, s.y); ctx.stroke();
      ctx.restore();
      drawDiamond(ctx, s.x, s.y, 4.5, geo, cssVar('--surface'));
    }

    /* query crosshair */
    if (Math.abs(state.query[ax.k] - state.plane.offset) < 1e-6) {
      const qs = map.toScreen(state.query[ax.u], state.query[ax.v]);
      drawCrosshair(ctx, qs.x, qs.y, accent);
    } else {
      const qs = map.toScreen(state.query[ax.u], state.query[ax.v]);
      ctx.save();
      ctx.globalAlpha = 0.35;
      drawCrosshair(ctx, qs.x, qs.y, accent);
      ctx.restore();
      ctx.fillStyle = cssVar('--ink-3');
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Q 在切面外 ' + fmt(state.query[ax.k] - state.plane.offset, 1), qs.x + 10, qs.y + 14);
    }

    /* axis labels */
    ctx.fillStyle = cssVar('--ink-3');
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ax.ul, w - 22, h - 12);
    ctx.textAlign = 'left';
    ctx.fillText(ax.vl, 8, 18);

    /* plane chip: axis, offset and the section's in-plane axes */
    $('#sectionChip').textContent = ax.fixed + ' = ' + fmt(state.plane.offset, 1) +
      ' · 横轴 ' + ax.ul + ' / 纵轴 ' + ax.vl;
  }

  /* ---------------------------------------------------------------- ball card */

  function drawBallCard() {
    const canvas = $('#ball');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const size = Math.max(1, Math.round(rect.width || 132));
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const r = size / 2 - 3;
    const cx = size / 2, cy = size / 2;
    const res = state.last;
    const rgb = res ? res.clamped : [0.1, 0.1, 0.1];
    const srgb = rgb.map((v) => Math.pow(clamp(v, 0, 1), 1 / 2.2));
    const light = 0.3;
    const base = srgb.map((v) => v * (1 - light) + light);
    const g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.06, cx, cy, r * 1.02);
    g.addColorStop(0, 'rgb(' + base.map((v) => Math.round(clamp(v * 1.22, 0, 1) * 255)).join(',') + ')');
    g.addColorStop(0.65, 'rgb(' + base.map((v) => Math.round(clamp(v * 0.86, 0, 1) * 255)).join(',') + ')');
    g.addColorStop(1, 'rgb(' + base.map((v) => Math.round(clamp(v * 0.4, 0, 1) * 255)).join(',') + ')');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = colorWithAlpha(cssVar('--ink'), 0.25); ctx.stroke();

    /* specular puck */
    const sx = cx - r * 0.34, sy = cy - r * 0.36;
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.42);
    sg.addColorStop(0, 'rgba(255,255,255,.55)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.42, 0, Math.PI * 2); ctx.fillStyle = sg; ctx.fill();

    /* normal direction arrow drawn on the sphere rim */
    const n = state.normal;
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
    /* project onto the ball's screen space using the camera basis for coherence */
    const cam = cameraBasis();
    const dx = nx * cam.right[0] + ny * cam.right[1] + nz * cam.right[2];
    const dy = nx * cam.up[0] + ny * cam.up[1] + nz * cam.up[2];
    const tipX = cx + dx * r * 0.92, tipY = cy - dy * r * 0.92;
    ctx.save();
    ctx.strokeStyle = colorWithAlpha(cssVar('--ink'), 0.6);
    ctx.fillStyle = colorWithAlpha(cssVar('--ink'), 0.7);
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tipX, tipY); ctx.stroke();
    const ang = Math.atan2(tipY - cy, tipX - cx);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 6 * Math.cos(ang - 0.4), tipY - 6 * Math.sin(ang - 0.4));
    ctx.lineTo(tipX - 6 * Math.cos(ang + 0.4), tipY - 6 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- panels */

  function renderQueryPanel() {
    const ax = AXES[state.plane.axis];
    $('#qx').textContent = fmt(state.query[0], 1);
    $('#qy').textContent = fmt(state.query[1], 1);
    $('#qz').textContent = fmt(state.query[2], 1);
    $('#planeU').value = fmt(state.query[ax.u], 1);
    $('#planeV').value = fmt(state.query[ax.v], 1);
    $('#planeULabel').textContent = '切面内 ' + ax.ul + ' 坐标';
    $('#planeVLabel').textContent = '切面内 ' + ax.vl + ' 坐标';

    const res = state.last;
    const tag = $('#regionTag');
    if (state.error) {
      tag.className = 'tag crit';
      tag.textContent = '剖分失败';
    } else if (!res) {
      tag.className = 'tag';
      tag.textContent = '—';
    } else if (res.outside) {
      tag.className = 'tag geo';
      tag.textContent = '凸包外 · 已投影';
    } else {
      tag.className = 'tag acc';
      tag.textContent = '凸包内 · 单元 ' + res.tet;
    }

    const chip = $('#regionChip');
    const chipText = $('#regionChipText');
    if (state.error) {
      chip.className = 'chip bad';
      chipText.textContent = '剖分失败：' + state.error.message;
    } else if (!res) {
      chip.className = 'chip';
      chipText.textContent = '—';
    } else if (res.outside) {
      chip.className = 'chip';
      chipText.textContent = '凸包外 · 投影距离 ' + fmt(res.distance, 2) + ' · 权重取自投影点';
    } else {
      chip.className = 'chip';
      chipText.textContent = '单元 ' + res.tet + ' · 四个探针重心插值';
    }

    const angles = anglesFromNormal(state.normal);
    $('#azimuth').value = Math.round(angles.az);
    $('#elevation').value = Math.round(angles.el);
    $('#azVal').textContent = Math.round(angles.az) + '°';
    $('#elVal').textContent = Math.round(angles.el) + '°';
    $('#normalVal').textContent = '[' + state.normal.map((v) => v.toFixed(2)).join(', ') + ']';
  }

  function renderWeights() {
    const host = $('#weightList');
    const res = state.last;
    $('#tetLabel').textContent = res ? '单元 ' + res.tet : '';
    if (state.error || !res) {
      host.innerHTML = '<div class="emptynote">' +
        (state.error ? '剖分未建立，没有权重。' : '把查询点放到模型上。') + '</div>';
      return;
    }
    const rows = res.probes.map((pi, k) => {
      const w = res.weights[k];
      const p = state.probes[pi].position;
      const hot = w > 1e-6;
      return '<div class="wrow' + (hot ? ' hot' : ' zero') + '">' +
        '<span class="idx">' + pi + '</span>' +
        '<span class="coords">' + p.join(',') + '</span>' +
        '<div class="wbar"><i style="width:' + (clamp(w, 0, 1) * 100).toFixed(2) + '%"></i></div>' +
        '<span class="wval">' + w.toFixed(3) + '</span>' +
        '</div>';
    }).join('');
    host.innerHTML = rows;
  }

  function renderBall() {
    drawBallCard();
    const res = state.last;
    const swatch = $('#ballSwatch');
    const val = $('#ballVal');
    const clampLine = $('#clampLine');
    if (!res) {
      swatch.style.background = 'var(--surface-3)';
      val.textContent = '—';
      clampLine.textContent = '—';
      clampLine.className = 'statusline';
      $('#ballMeta').textContent = '';
      $$('.meter').forEach((m) => {
        m.querySelector('[data-fill]').style.width = '0%';
        m.querySelector('[data-val]').textContent = '—';
      });
      return;
    }
    const hex = '#' + res.clamped.map((v) =>
      Math.round(255 * Math.pow(clamp(v, 0, 1), 1 / 2.2)).toString(16).padStart(2, '0')).join('');
    swatch.style.background = hex;
    val.textContent = res.clamped.map((v) => v.toFixed(3)).join(', ');
    const negCount = res.negative.filter(Boolean).length;
    if (negCount) {
      clampLine.className = 'statusline';
      clampLine.innerHTML = '<span class="tag crit">钳制 ' + negCount + '/3</span><span>负值已归零</span>';
    } else {
      clampLine.className = 'statusline';
      clampLine.innerHTML = '<span class="tag">无负值</span><span>未触发钳制</span>';
    }
    $('#ballMeta').textContent = res.outside ? '包外投影后取色' : '凸包内插值取色';

    $$('.meter').forEach((m) => {
      const ch = Number(m.dataset.ch);
      const raw = res.raw[ch];
      const max = 1.2;
      const fill = m.querySelector('[data-fill]');
      const v = m.querySelector('[data-val]');
      const pct = clamp(Math.abs(raw) / max, 0, 1) * 50;
      if (raw < 0) {
        fill.className = 'fill neg';
        fill.style.left = (50 - pct) + '%';
        fill.style.width = pct + '%';
      } else {
        fill.className = 'fill';
        fill.style.left = '50%';
        fill.style.width = pct + '%';
        fill.style.background = 'var(--good)';
      }
      v.textContent = raw.toFixed(2);
    });
  }

  function renderLog() {
    const host = $('#logList');
    $('#logCount').textContent = state.log.length + ' 条';
    if (!state.log.length) {
      host.innerHTML = '<div class="log-empty">拖动查询点跨过单元边界时会自动记录一行；也可以点「记录当前点」。</div>';
      return;
    }
    const rows = state.log.slice(-60).reverse().map((r, i) => {
      const seq = state.log.length - i;
      const colorCss = 'rgb(' + r.clamped.map((v) =>
        Math.round(255 * Math.pow(clamp(v, 0, 1), 1 / 2.2))).join(',') + ')';
      return '<div class="logrow">' +
        '<span class="seq">' + seq + '</span>' +
        '<span class="pt" title="' + r.point.map((v) => fmt(v, 1)).join(', ') + '">' +
          r.point.map((v) => fmt(v, Math.abs(v) < 10 ? 1 : 0)).join(',') + '</span>' +
        '<span class="mid"><span class="tag ' + (r.region === 'outside' ? 'geo' : 'acc') + '">' +
          (r.region === 'outside' ? '外' : 'T' + r.tet) + '</span>' +
          '<span style="width:10px;height:10px;border-radius:3px;background:' + colorCss + '"></span>' +
          (r.negative.some(Boolean) ? '<span class="tag crit">钳</span>' : '') +
        '</span>' +
        '<span class="mono" style="font-size:10px;color:var(--ink-3)" title="最大权重">' +
          'w' + r.weights.slice().sort((a, b) => b - a)[0].toFixed(2) + '</span>' +
        '</div>';
    }).join('');
    host.innerHTML = rows;
  }

  /* ---------------------------------------------------------------- case list */

  function renderCaseList() {
    const host = $('#caseList');
    const cases = allCases();
    host.innerHTML = cases.map((c, i) =>
      '<button class="case-btn" data-case="' + c.id + '" aria-pressed="' + (c.id === state.caseId) + '">' +
      '<span class="n">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<span>' + c.name + '</span>' +
      '<span class="desc">' + c.desc + '</span>' +
      '</button>').join('');
  }

  /* ---------------------------------------------------------------- controls */

  function syncPlaneControls() {
    $$('#axisSeg button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.axis === state.plane.axis));
    });
    const b = bounds(state.tri ? state.tri.points : state.probes.map((p) => p.position));
    const ax = AXES[state.plane.axis];
    const lo = Math.floor(b.lo[ax.k]), hi = Math.ceil(b.hi[ax.k]);
    const slider = $('#planeOffset');
    slider.min = lo; slider.max = hi;
    state.plane.offset = clamp(state.plane.offset, lo, hi);
    slider.value = state.plane.offset;
    $('#planeOffsetVal').textContent = '偏移 ' + fmt(state.plane.offset, 1);
  }

  function setQueryPoint(p, opts) {
    state.query = [0, 1, 2].map((k) => Math.round(clamp(p[k], -4000, 4000) * 100) / 100);
    recompute(opts);
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------------------------------------------------------------- pointer */

  function canvasPos(canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function screenQuery3D(w, h) {
    const P = makeProjector(w, h);
    return P.project(state.query);
  }

  function init3DInteraction() {
    const canvas = $('#view3d');
    let mode = null, last = null, moved = false;

    canvas.addEventListener('pointerdown', (ev) => {
      if (state.error) return;
      const { x, y } = canvasPos(canvas, ev);
      const { w, h } = setupCanvas(canvas);
      const qv = screenQuery3D(w, h);
      canvas.setPointerCapture(ev.pointerId);
      if (qv && Math.hypot(qv.x - x, qv.y - y) < 22) {
        mode = 'moveQuery';
      } else {
        mode = 'orbit';
      }
      last = { x, y };
      moved = false;
    });

    canvas.addEventListener('pointermove', (ev) => {
      if (!mode) {
        const { x, y } = canvasPos(canvas, ev);
        const { w, h } = setupCanvas(canvas);
        const qv = screenQuery3D(w, h);
        canvas.style.cursor = qv && Math.hypot(qv.x - x, qv.y - y) < 22 ? 'move' : 'grab';
        return;
      }
      const { x, y } = canvasPos(canvas, ev);
      const dx = x - last.x, dy = y - last.y;
      if (Math.hypot(dx, dy) > 1) moved = true;
      if (mode === 'orbit') {
        view.yaw -= dx * 0.008;
        view.pitch = clamp(view.pitch + dy * 0.008, -1.45, 1.45);
      } else if (mode === 'moveQuery') {
        const { w, h } = setupCanvas(canvas);
        const P = makeProjector(w, h);
        const qv = P.project(state.query);
        if (qv) {
          const wpp = P.worldPerPixel(qv.z);
          const cam = P.cam;
          const d = [
            -cam.right[0] * dx * wpp + cam.up[0] * dy * wpp,
            -cam.right[1] * dx * wpp + cam.up[1] * dy * wpp,
            -cam.right[2] * dx * wpp + cam.up[2] * dy * wpp,
          ];
          setQueryPoint([state.query[0] + d[0], state.query[1] + d[1], state.query[2] + d[2]], { silent: false });
        }
      }
      last = { x, y };
      if (mode === 'orbit') draw3D();
    });

    canvas.addEventListener('pointerup', () => {
      mode = null;
      canvas.style.cursor = '';
    });

    canvas.addEventListener('pointercancel', () => { mode = null; });

    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      view.dist = clamp(view.dist * Math.exp(ev.deltaY * 0.0012), 1.3, 9);
      view.userZoomed = true;
      draw3D();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => resetView());
  }

  function initSectionInteraction() {
    const canvas = $('#section');
    let dragging = false;
    const move = (ev) => {
      const { w, h } = setupCanvas(canvas);
      const map = makeSectionMap(w, h);
      const { x, y } = canvasPos(canvas, ev);
      const p = map.toPlane(x, y);
      const q = planePoint(p.u, p.v);
      setQueryPoint(q, { silent: false });
    };
    canvas.addEventListener('pointerdown', (ev) => {
      if (state.error) return;
      dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      move(ev);
    });
    canvas.addEventListener('pointermove', (ev) => { if (dragging) move(ev); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  }

  function resetView() {
    view.yaw = -0.62;
    view.pitch = 0.48;
    view.userZoomed = false;
    fitView($('#view3d'));
    draw3D();
  }

  /* ---------------------------------------------------------------- actions */

  function shuffleCheck() {
    if (!state.tri) { toast('当前没有可验证的剖分'); return; }
    const points = state.probes.map((p) => p.position);
    const idx = points.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    const shuffled = idx.map((i) => points[i]);
    const r = TRI.triangulate(shuffled);
    if (!r.ok) { toast('打乱后剖分失败：' + r.message); return; }
    const same = r.fingerprint === state.tri.fingerprint;
    toast(same
      ? '打乱 ' + points.length + ' 个探针的输入顺序，剖分指纹一致（' + r.fingerprint + '），共得到 ' + r.tets.length + ' 个四面体。'
      : '打乱后剖分不同：原 ' + state.tri.fingerprint + '，新 ' + r.fingerprint + '。');
  }

  function runSweep() {
    if (state.sweep) { stopSweep(); return; }
    if (!state.tri) return;
    const ax = AXES[state.plane.axis];
    const e = sectionExtent();
    if (state.plane.offset < e.lo[ax.k] || state.plane.offset > e.hi[ax.k]) {
      state.plane.offset = clamp(state.plane.offset, e.lo[ax.k], e.hi[ax.k]);
      syncPlaneControls();
    }
    const startQ = state.query.slice();
    const u0 = e.u0, u1 = e.u1;
    const v = state.query[ax.v];
    const steps = 120;
    let i = 0;
    const cells = [];
    let lastRegion = null;
    let lastLogLen = state.log.length;
    state.sweep = true;
    $('#sweepLabel').textContent = '停止扫描';
    $('#btnSweep').classList.add('active');
    const tick = () => {
      if (!state.sweep) return;
      const t = i / (steps - 1);
      const u = lerp(u0, u1, t);
      const q = planePoint(u, v);
      state.query = q;
      const res = evalAt(q);
      state.last = res;
      if (res && res.ok) {
        const region = res.outside ? 'out' : 'T' + res.tet;
        if (region !== lastRegion) {
          lastRegion = region;
          cells.push(res.outside ? '外' : 'T' + res.tet);
          pushRecord(makeRecord(q, res.outside ? '扫描·包外' : '扫描·跨单元', res));
        }
      }
      renderQueryPanel(); renderWeights(); renderBall();
      if (state.log.length !== lastLogLen) { lastLogLen = state.log.length; renderLog(); }
      draw3D(); drawSection();
      i++;
      if (i >= steps) {
        finishSweep(startQ, cells);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function finishSweep(startQ, cells) {
    state.sweep = false;
    $('#sweepLabel').textContent = '自动扫描';
    $('#btnSweep').classList.remove('active');
    const unique = cells.filter((c, i) => i === 0 || c !== cells[i - 1]);
    toast('扫描完成，经过 ' + unique.length + ' 个单元：' + unique.join(' → ') + '。记录已写入查询记录。');
    state.lastAuto = null;
    setQueryPoint(startQ);
    renderLog();
  }

  function stopSweep() {
    state.sweep = false;
    $('#sweepLabel').textContent = '自动扫描';
    $('#btnSweep').classList.remove('active');
    toast('扫描已停止');
  }

  /* ---------------------------------------------------------------- import */

  function parseProbeJSON(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (err) { return { ok: false, message: 'JSON 解析失败：' + err.message }; }
    const arr = Array.isArray(data) ? data
      : Array.isArray(data.probes) ? data.probes
      : data.case && Array.isArray(data.case.probes) ? data.case.probes
      : Array.isArray(data.cases) && data.cases[0] ? data.cases[0].probes
      : null;
    if (!arr) return { ok: false, message: '找不到探针数组。请提供 { probes: [...] } 或直接给出探针数组。' };
    if (arr.length < 4) return { ok: false, message: '只有 ' + arr.length + ' 个探针；至少需要 4 个。' };
    if (arr.length > 64) return { ok: false, message: '有 ' + arr.length + ' 个探针，超过上限 64 个。请拆分场景或减少探针。' };
    const probes = [];
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i];
      const pos = raw.p || raw.position || raw.pos;
      const co = raw.c || raw.coefficients || raw.coeff;
      if (!Array.isArray(pos) || pos.length !== 3) {
        return { ok: false, message: '第 ' + i + ' 个探针缺少三维坐标（p 或 position）。' };
      }
      for (let k = 0; k < 3; k++) {
        if (!Number.isInteger(pos[k]) || pos[k] < -1000 || pos[k] > 1000) {
          return { ok: false, message: '第 ' + i + ' 个探针的坐标 ' + JSON.stringify(pos[k]) + ' 不是 −1000–1000 范围内的整数。' };
        }
      }
      if (!Array.isArray(co) || co.length !== 3) {
        return { ok: false, message: '第 ' + i + ' 个探针需要 RGB 三组系数，每组 4 个数（常数、x、y、z）。' };
      }
      const cf = [];
      for (let ch = 0; ch < 3; ch++) {
        const row = co[ch];
        if (!Array.isArray(row) || row.length !== 4 || row.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          return { ok: false, message: '第 ' + i + ' 个探针的 ' + 'RGB'[ch] + ' 系数应包含 4 个有限数。' };
        }
        cf.push(row.slice());
      }
      probes.push({ id: raw.id !== undefined ? String(raw.id) : String(i), p: pos.slice(), c: cf });
    }
    return { ok: true, probes };
  }

  function applyJSON() {
    const text = $('#jsonInput').value;
    const msg = $('#jsonMsg');
    const parsed = parseProbeJSON(text);
    if (!parsed.ok) {
      msg.className = 'msg err';
      msg.textContent = parsed.message;
      return;
    }
    const project = buildProject({ probes: parsed.probes });
    if (!project.ok) {
      msg.className = 'msg err';
      msg.textContent = project.error.message;
      return;
    }
    msg.className = 'msg ok';
    msg.textContent = '剖分完成：' + project.tri.tets.length + ' 个四面体，校验' + (project.tri.validation.ok ? '通过' : '未通过');

    state.caseId = '__custom';
    state.caseName = '自定义探针';
    state.probes = project.probes;
    state.error = null;
    state.tri = project.tri;
    state.log = [];
    state.lastAuto = null;
    const b = bounds(state.probes.map((p) => p.position));
    view.target = b.center.slice();
    view.radius = b.radius;
    view.userZoomed = false;
    fitView($('#view3d'));
    const centroid = [0, 1, 2].map((k) => {
      let s2 = 0;
      for (const p of state.probes) s2 += p.position[k];
      return Math.round((s2 / state.probes.length) * 10) / 10;
    });
    state.query = centroid;
    state.plane.offset = clamp(centroid[2], b.lo[2], b.hi[2]);
    state.normal = [0, 1, 0];
    $('#caseMeta').textContent = state.probes.length + ' 探针 · ' + state.tri.tets.length + ' 单元';
    renderCaseList();
    syncPlaneControls();
    recompute({ silent: true });
    toast('已载入 ' + state.probes.length + ' 个探针');
  }

  /* ---------------------------------------------------------------- export */

  const exportState = { kind: 'tri' };

  function projectSnapshot() {
    return {
      probes: state.probes,
      tri: state.tri,
      caseName: state.caseName,
    };
  }

  function exportContent(kind) {
    if (!state.tri) return { text: '', note: '当前没有可导出的剖分。', size: '' };
    if (kind === 'tri') {
      const json = EXPORT.triangulationJSON(projectSnapshot());
      return {
        text: JSON.stringify(json, null, 2),
        note: '包含探针坐标、系数、每个四面体的顶点与体积、凸包面，以及剖分校验结果。指纹基于坐标，可用于比对两次剖分是否一致。',
      };
    }
    if (kind === 'csv') {
      const text = EXPORT.queryCSV(state.log);
      return {
        text,
        note: '每行一条查询记录：查询点、所在区域与四面体、四个探针的编号与权重、投影点与距离、法线、原始与钳制后的 RGB。',
      };
    }
    const html = EXPORT.reportHTML(projectSnapshot(), state.log);
    return {
      text: html,
      note: '可直接在浏览器打开的独立报告：剖分校验结论、探针表、四面体表、查询记录与颜色样本。',
    };
  }

  function openExport() {
    const dlg = $('#exportDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    refreshExport();
  }

  function refreshExport() {
    const { text, note } = exportContent(exportState.kind);
    const area = $('#exportText');
    area.value = text;
    $('#exportNote').textContent = note;
    $('#exportSize').textContent = text
      ? (new Blob([text]).size / 1024).toFixed(1) + ' KB · ' + text.split('\n').length + ' 行'
      : '';
    $('#exportMeta').textContent = state.caseName + ' · 指纹 ' + (state.tri ? state.tri.fingerprint : '—');
    $$('#exportTabs button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.kind === exportState.kind));
    });
  }

  async function copyExport() {
    const area = $('#exportText');
    const text = area.value;
    if (!text) { toast('没有可复制的内容'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch (err) {
      area.focus();
      area.select();
      try {
        document.execCommand('copy');
        toast('已复制到剪贴板');
      } catch (e2) {
        toast('浏览器不允许自动复制，内容已全选，请手动复制。');
      }
    }
  }

  /* ---------------------------------------------------------------- wiring */

  function init() {
    /* Case list */
    $('#caseList').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.case-btn');
      if (!btn) return;
      selectCase(btn.dataset.case, { toast: true });
    });

    /* Axis segment */
    $('#axisSeg').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-axis]');
      if (!btn) return;
      state.plane.axis = btn.dataset.axis;
      const b = bounds(state.tri ? state.tri.points : state.probes.map((p) => p.position));
      const ax = AXES[state.plane.axis];
      /* Put the new cut plane through the query point so the section view stays
         useful after switching axes. */
      state.plane.offset = clamp(Math.round(state.query[ax.k]), Math.floor(b.lo[ax.k]), Math.ceil(b.hi[ax.k]));
      state.query = planePoint(
        clamp(state.query[ax.u], b.lo[ax.u], b.hi[ax.u]),
        clamp(state.query[ax.v], b.lo[ax.v], b.hi[ax.v]));
      syncPlaneControls();
      recompute();
    });

    $('#planeOffset').addEventListener('input', (ev) => {
      state.plane.offset = Number(ev.target.value);
      $('#planeOffsetVal').textContent = '偏移 ' + fmt(state.plane.offset, 1);
      recompute();
    });

    /* Query coordinate edit */
    for (const [sel, k] of [['#planeU', 'u'], ['#planeV', 'v']]) {
      $(sel).addEventListener('change', (ev) => {
        const ax = AXES[state.plane.axis];
        const val = Number(ev.target.value);
        if (!Number.isFinite(val)) return;
        const q = state.query.slice();
        q[ax[k]] = val;
        setQueryPoint(q);
      });
    }

    /* Normal */
    $('#azimuth').addEventListener('input', (ev) => {
      const az = Number(ev.target.value), el = Number($('#elevation').value);
      state.normal = normalFromAngles(az, el);
      $('#azVal').textContent = az + '°';
      recompute({ silent: true });
    });
    $('#elevation').addEventListener('input', (ev) => {
      const el = Number(ev.target.value), az = Number($('#azimuth').value);
      state.normal = normalFromAngles(az, el);
      $('#elVal').textContent = el + '°';
      recompute({ silent: true });
    });
    $$('[data-normal]').forEach((b) => {
      b.addEventListener('click', () => {
        state.normal = b.dataset.normal.split(',').map(Number);
        recompute({ silent: true });
      });
    });

    /* Visibility toggles */
    const toggle = (id, key) => {
      $(id).addEventListener('click', () => {
        state.vis[key] = !state.vis[key];
        $(id).setAttribute('aria-pressed', String(state.vis[key]));
        draw3D();
      });
    };
    toggle('#btnTets', 'tets');
    toggle('#btnHull', 'hull');
    toggle('#btnBall3d', 'ball');

    $('#btnResetView').addEventListener('click', resetView);
    $('#btnShuffle').addEventListener('click', shuffleCheck);
    $('#btnSweep').addEventListener('click', runSweep);
    $('#btnApplyJson').addEventListener('click', applyJSON);
    $('#btnSampleJson').addEventListener('click', () => {
      const cse = allCases().find((c) => c.id === 'tetra') || allCases()[0];
      const payload = {
        probes: cse.probes.slice(0, 4).map((p) => ({ id: p.id, p: p.p, c: p.c })),
      };
      $('#jsonInput').value = JSON.stringify(payload, null, 1);
      $('#jsonMsg').textContent = '';
    });

    $('#btnRecord').addEventListener('click', () => {
      const res = state.last;
      if (!res) return;
      if (pushRecord(makeRecord(state.query, res.outside ? '手动·包外' : '手动·单元 ' + res.tet, res))) {
        renderLog();
        toast('已记录查询点 ' + state.query.map((v) => fmt(v, 1)).join(', '));
      }
    });

    $('#btnClearLog').addEventListener('click', () => {
      state.log = [];
      renderLog();
      toast('查询记录已清空');
    });

    /* Export dialog */
    $('#btnExport').addEventListener('click', openExport);
    $('#btnCloseExport').addEventListener('click', () => {
      const dlg = $('#exportDialog');
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    });
    $('#exportTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-kind]');
      if (!b) return;
      exportState.kind = b.dataset.kind;
      refreshExport();
    });
    $('#btnCopyExport').addEventListener('click', copyExport);
    $('#btnSelectAll').addEventListener('click', () => {
      const area = $('#exportText');
      area.focus(); area.select();
    });
    $('#exportDialog').addEventListener('click', (ev) => {
      if (ev.target === $('#exportDialog')) {
        const dlg = $('#exportDialog');
        if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
      }
    });

    init3DInteraction();
    initSectionInteraction();

    /* Resize */
    let rafR = 0;
    const onResize = () => {
      if (rafR) return;
      rafR = requestAnimationFrame(() => {
        rafR = 0;
        if (!view.userZoomed) fitView($('#view3d'));
        draw3D(); drawSection(); drawBallCard();
      });
    };
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(onResize);
      ro.observe($('#view3dWrap'));
      ro.observe($('#sectionWrap'));
    }

    /* Re-render when the viewer flips theme. */
    const themeObserver = new MutationObserver(() => {
      draw3D(); drawSection(); drawBallCard();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          draw3D(); drawSection(); drawBallCard();
        });
      } catch (e) { /* older browsers */ }
    }

    /* Keyboard: arrow keys nudge the query in the section plane. */
    document.addEventListener('keydown', (ev) => {
      const ae = document.activeElement;
      if (ae && /input|textarea|select/i.test(ae.tagName)) return;
      if (document.querySelector('dialog[open]')) return;
      const ax = AXES[state.plane.axis];
      const step = ev.shiftKey ? 5 : 0.5;
      const q = state.query.slice();
      if (ev.key === 'ArrowLeft') q[ax.u] -= step;
      else if (ev.key === 'ArrowRight') q[ax.u] += step;
      else if (ev.key === 'ArrowUp') q[ax.v] += step;
      else if (ev.key === 'ArrowDown') q[ax.v] -= step;
      else return;
      ev.preventDefault();
      setQueryPoint(q);
    });

    /* The stage may not have been laid out yet on first paint; refit after a frame. */
    /* Boot */
    let saved = null;
    try { saved = localStorage.getItem('tetra.case'); } catch (e) { /* ignore */ }
    const avail = allCases().map((c) => c.id);
    selectCase(avail.includes(saved) ? saved : avail[0]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
