/*
 * app.js — 页面交互：轨道相机、3D 网格视图、2D 线稿联动、拾取与导出
 * 纯原生 JS，无第三方依赖。
 */
(function () {
  'use strict';
  const HLM = window.HLM;
  const M = HLM.math, CAM = HLM.camera, CLIP = HLM.clipper;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const MAX_FACES = 5000;

  const state = {
    name: '',
    rawData: null,
    camSpec: null,
    creaseDegrees: 45,
    orbit: null,
    camera: null, mesh: null, solution: null,
    selectedEdgeId: null,
    selectedFaceId: null,
    exportW: 640, exportH: 480,
    edgeClips: null,          // 每条边的世界->裁剪缓存
    lastIntervalSignature: '',
  };

  /* ---------------- 主题色（供 Canvas 读取 CSS token） ---------------- */

  let C = {};
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    C = {
      fg: v('--fg'), muted: v('--muted'), faint: v('--faint'),
      panel: v('--panel'), line: v('--line'),
      accent: v('--accent'), amber: v('--amber'),
      green: v('--green'), red: v('--red'), violet: v('--violet'),
      paper: v('--paper'),
    };
  }

  function edgeColor(e) {
    if (e.types.nonmanifold) return C.red;
    if (e.types.silhouette) return C.amber;
    if (e.types.boundary) return C.green;
    return C.accent;
  }

  /* ---------------- 数据加载与校验 ---------------- */

  function validateData(d) {
    const errors = [];
    if (!d || typeof d !== 'object') errors.push('文件内容不是 JSON 对象');
    if (!Array.isArray(d.positions) || d.positions.length < 3)
      errors.push('缺少 positions 顶点数组（至少 3 个顶点）');
    if (!Array.isArray(d.triangles) || d.triangles.length === 0)
      errors.push('缺少 triangles 三角形数组');
    if (d.triangles && d.triangles.length > MAX_FACES)
      errors.push(`三角形数 ${d.triangles.length} 超过上限 ${MAX_FACES} 面`);
    if (d.positions && d.positions.some(p => !Array.isArray(p) || p.length !== 3 ||
        p.some(x => typeof x !== 'number' || !Number.isFinite(x))))
      errors.push('positions 中存在非三维有限数顶点');
    const cam = d.camera;
    if (!cam || !['orthographic', 'perspective'].includes(cam.type))
      errors.push('camera.type 必须是 orthographic 或 perspective');
    if (cam && (!cam.origin || !cam.target || !cam.up ||
        cam.near == null || cam.far == null || cam.aspect == null))
      errors.push('camera 缺少 origin/target/up/near/far/aspect');
    if (cam && cam.type === 'orthographic' && cam.height == null)
      errors.push('正交相机缺少 height');
    if (cam && cam.type === 'perspective' && cam.fov_y == null)
      errors.push('透视相机缺少 fov_y');
    return errors;
  }

  function loadData(d, name) {
    const errors = validateData(d);
    showMessages(errors, []);
    if (errors.length) {
      state.rawData = null;
      renderEmpty();
      return;
    }
    state.name = name;
    state.rawData = d;
    state.camSpec = JSON.parse(JSON.stringify(d.camera));
    state.creaseDegrees = Number.isFinite(d.crease_degrees) ? d.crease_degrees : 45;
    state.orbit = specToOrbit(state.camSpec);
    state.selectedEdgeId = null;
    state.selectedFaceId = null;
    $('#crease').value = state.creaseDegrees;
    $('#creaseVal').textContent = state.creaseDegrees.toFixed(0) + '°';
    recompute();
  }

  /* ---------------- 轨道相机 ---------------- */

  function specToOrbit(spec) {
    const f = M.normalize(M.sub(spec.target, spec.origin));
    const dist = Math.max(M.length(M.sub(spec.target, spec.origin)), 1e-6);
    return {
      yaw: Math.atan2(f[0], f[2]),
      pitch: Math.asin(M.clamp(f[1], -1, 1)),
      dist,
      height: spec.height,
    };
  }

  function orbitToSpec(spec, o) {
    const cp = Math.cos(o.pitch);
    const f = [cp * Math.sin(o.yaw), Math.sin(o.pitch), cp * Math.cos(o.yaw)];
    const next = JSON.parse(JSON.stringify(spec));
    next.origin = M.sub(next.target, M.scale(f, o.dist));
    next.up = [0, 1, 0];
    if (o.height != null) next.height = o.height;
    return next;
  }

  function resetView() {
    if (!state.rawData) return;
    state.camSpec = JSON.parse(JSON.stringify(state.rawData.camera));
    state.orbit = specToOrbit(state.camSpec);
    recompute();
  }

  /* ---------------- 求解与渲染 ---------------- */

  function recompute() {
    if (!state.rawData) return;
    const spec = orbitToSpec(state.camSpec, state.orbit);
    state.camSpec = spec;
    state.camera = CAM.createCamera(spec);
    state.mesh = HLM.mesh.buildMesh(state.rawData, state.camera, state.creaseDegrees);
    if (state.mesh.errors.length) {
      showMessages([], state.mesh.warnings, state.mesh.errors);
      renderEmpty();
      return;
    }
    state.solution = HLM.solver.solve(state.mesh, state.camera, state.mesh.positions);
    cacheEdgeClips();
    showMessages([], state.mesh.warnings);
    renderStats();
    render3D();
    render2D();
    renderInspector();
    renderSignature();
  }

  function cacheEdgeClips() {
    state.edgeClips = state.mesh.edges.map(e => {
      const seg = CLIP.clipSegment(
        CAM.worldToClip(state.camera, state.mesh.positions[e.a]),
        CAM.worldToClip(state.camera, state.mesh.positions[e.b]));
      if (!seg) return null;
      const n0 = CAM.clipToNdc(seg.c0), n1 = CAM.clipToNdc(seg.c1);
      return {
        u0: seg.t0, u1: seg.t1, n0, n1,
        pointProjected: Math.hypot(n1[0] - n0[0], n1[1] - n0[1]) <= 1e-12,
      };
    });
  }

  /** 区间签名：证明改导出尺寸不改变区间判定 */
  function renderSignature() {
    const sig = JSON.stringify(state.solution.edges
      .filter(e => e.feature)
      .map(e => e.intervals.map(i => [
        round(i.u0), round(i.u1), i.visible, i.occluderFaceIds])));
    state.lastIntervalSignature = sig;
  }
  const round = x => Number(x.toFixed(10));

  /* ---------------- 3D Canvas ---------------- */

  const canvas3d = $('#view3d');
  const ctx3d = canvas3d.getContext('2d');

  function resizeCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function letterbox(w, h) {
    const aspect = state.camera.aspect;
    let sw, sh;
    if (w / h > aspect) { sh = h; sw = h * aspect; }
    else { sw = w; sh = w / aspect; }
    return {
      sw, sh, ox: (w - sw) / 2, oy: (h - sh) / 2,
      px: n => [ (w - sw) / 2 + n[0] * sw / 2,
                 (h - sh) / 2 - n[1] * sh / 2 ],
    };
  }

  function render3D() {
    if (!state.solution) return;
    readTokens();
    const { w, h } = resizeCanvas(canvas3d);
    const ctx = ctx3d;
    ctx.clearRect(0, 0, w, h);
    const lb = letterbox(w, h);

    // 视锥框
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(lb.ox, lb.oy, lb.sw, lb.sh);
    ctx.setLineDash([]);

    const selEdge = state.mesh.edges[state.selectedEdgeId];
    const occFaces = selEdge ? new Set(
      selEdge ? state.solution.edges[selEdge.id].intervals
        .flatMap(i => i.occluderFaceIds) : []) : null;

    // 面：按 NDC 深度远->近绘制（z 大者远）
    const tris = state.solution.triangles.slice().sort((a, b) => {
      const za = (a.tri[0][2] + a.tri[1][2] + a.tri[2][2]) / 3;
      const zb = (b.tri[0][2] + b.tri[1][2] + b.tri[2][2]) / 3;
      return zb - za;
    });
    for (const g of tris) {
      const isOcc = occFaces && occFaces.has(g.faceId);
      const isSelFace = g.faceId === state.selectedFaceId;
      ctx.beginPath();
      g.tri.forEach((n, i) => {
        const [x, y] = lb.px(n);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      if (isOcc) { ctx.fillStyle = hexA(C.amber, 0.28); ctx.fill(); }
      else if (isSelFace) { ctx.fillStyle = hexA(C.violet, 0.25); ctx.fill(); }
      else { ctx.fillStyle = hexA(C.accent, 0.06); ctx.fill(); }
      ctx.strokeStyle = hexA(C.muted, 0.25);
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // 边
    state.mesh.edges.forEach((e, idx) => {
      const clip = state.edgeClips[idx];
      if (!clip || clip.pointProjected) return;
      const solved = state.solution.edges[idx];
      const selected = idx === state.selectedEdgeId;
      if (selected) return; // 选中边最后画
      const feature = HLM.mesh.isFeatureEdge(e);
      const [x0, y0] = lb.px(clip.n0);
      const [x1, y1] = lb.px(clip.n1);
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.strokeStyle = feature ? hexA(edgeColor(e), 0.9) : hexA(C.muted, 0.18);
      ctx.lineWidth = feature ? 1.4 : 0.7;
      ctx.stroke();
    });

    // 选中边：按区间实线/虚线叠加
    if (selEdge) {
      const clip = state.edgeClips[selEdge.id];
      const solved = state.solution.edges[selEdge.id];
      if (clip) for (const iv of solved.intervals) {
        const pA = edgePointAt(clip, iv.u0), pB = edgePointAt(clip, iv.u1);
        const [x0, y0] = lb.px(pA), [x1, y1] = lb.px(pB);
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.strokeStyle = C.violet;
        ctx.lineWidth = 2.6;
        ctx.setLineDash(iv.visible ? [] : [6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function edgePointAt(clip, u) {
    const t = (u - clip.u0) / (clip.u1 - clip.u0);
    return [
      clip.n0[0] + (clip.n1[0] - clip.n0[0]) * t,
      clip.n0[1] + (clip.n1[1] - clip.n0[1]) * t,
    ];
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ---------------- 3D 拾取 ---------------- */

  function pick3D(mx, my) {
    if (!state.solution) return {};
    const { w, h } = resizeCanvas(canvas3d);
    const lb = letterbox(w, h);
    const inv = n => [ (n[0] * lb.sw / 2 + lb.ox), lb.oy - n[1] * lb.sh / 2 ];

    let bestEdge = -1, bestD = 10;
    state.mesh.edges.forEach((e, idx) => {
      const clip = state.edgeClips[idx];
      if (!clip || clip.pointProjected) return;
      const [ax, ay] = inv(clip.n0), [bx, by] = inv(clip.n1);
      const d = pointSegDistance(mx, my, ax, ay, bx, by);
      if (d < bestD) { bestD = d; bestEdge = idx; }
    });

    let bestFace = -1, bestZ = Infinity;
    for (const g of state.solution.triangles) {
      const pts = g.tri.map(inv);
      if (!pointInPoly(mx, my, pts)) continue;
      const z = (g.tri[0][2] + g.tri[1][2] + g.tri[2][2]) / 3;
      if (z < bestZ) { bestZ = z; bestFace = g.faceId; }
    }
    return { edgeId: bestEdge, faceId: bestFace };
  }

  function pointSegDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return Math.hypot(px - ax, py - ay);
    const t = M.clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------------- 2D SVG 线稿 ---------------- */

  function render2D() {
    if (!state.solution) return;
    const W = state.exportW, H = state.exportH;
    const selEdge = state.mesh.edges[state.selectedEdgeId];
    const occFaces = selEdge ? new Set(
      state.solution.edges[selEdge.id].intervals.flatMap(i => i.occluderFaceIds)) : null;

    const parts = [];
    parts.push(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" ` +
      `xmlns="http://www.w3.org/2000/svg" id="svg2d">`);
    parts.push(`<rect width="100%" height="100%" fill="${C.paper}"/>`);

    // 选中边的遮挡面（半透明轮廓）
    if (occFaces && occFaces.size) {
      parts.push('<g id="occluders">');
      for (const g of state.solution.triangles) {
        if (!occFaces.has(g.faceId)) continue;
        const pts = g.tri.map(n => CAM.ndcToScreen(n, W, H).map(f => f.toFixed(2)).join(',')).join(' ');
        parts.push(`<polygon points="${pts}" fill="${hexA(C.amber, 0.18)}" ` +
          `stroke="${hexA(C.amber, 0.7)}" stroke-width="1" data-face="${g.faceId}"/>`);
      }
      parts.push('</g>');
    }
    // 单独选中的面
    if (state.selectedFaceId != null) {
      parts.push('<g id="sel-face">');
      for (const g of state.solution.triangles) {
        if (g.faceId !== state.selectedFaceId) continue;
        const pts = g.tri.map(n => CAM.ndcToScreen(n, W, H).map(f => f.toFixed(2)).join(',')).join(' ');
        parts.push(`<polygon points="${pts}" fill="${hexA(C.violet, 0.18)}" ` +
          `stroke="${C.violet}" stroke-width="1"/>`);
      }
      parts.push('</g>');
    }

    const hidden = [], visible = [], nonman = [];
    for (const e of state.solution.edges) {
      if (!e.feature || !e.clip || e.clip.pointProjected) continue;
      const toScreen = HLM.exporter.edgeScreenPoints(e, W, H);
      for (const iv of e.intervals) {
        const { a, b } = toScreen(iv);
        const selected = e.edgeId === state.selectedEdgeId;
        const line = `<line class="ln${selected ? ' sel' : ''}" data-edge="${e.edgeId}" ` +
          `data-u0="${iv.u0.toFixed(4)}" data-u1="${iv.u1.toFixed(4)}" ` +
          `data-occ="${iv.occluderFaceIds.join(',')}" ` +
          `x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" ` +
          `x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}"/>`;
        if (e.types.nonmanifold) nonman.push(line);
        else if (iv.visible) visible.push(line);
        else hidden.push(line);
      }
    }
    parts.push(`<g class="g-hidden" stroke="${C.muted}" stroke-width="${Math.max(1, W / 640)}" ` +
      `stroke-dasharray="${Math.max(5, W / 90)} ${Math.max(3.5, W / 150)}" fill="none">`,
      ...hidden, '</g>');
    parts.push(`<g class="g-visible" stroke="${C.fg}" stroke-width="${Math.max(1.2, W / 480)}" fill="none">`,
      ...visible, '</g>');
    parts.push(`<g class="g-nonman" stroke="${C.red}" stroke-width="${Math.max(1.6, W / 360)}" fill="none">`,
      ...nonman, '</g>');
    parts.push('</svg>');

    const host = $('#view2d');
    host.innerHTML = parts.join('\n');
    host.querySelectorAll('.ln').forEach(ln => {
      ln.addEventListener('click', () => selectEdge(Number(ln.dataset.edge)));
      ln.addEventListener('mousemove', ev => showTooltip(ev, ln));
      ln.addEventListener('mouseleave', hideTooltip);
    });
    host.querySelectorAll('polygon[data-face]').forEach(pg => {
      pg.addEventListener('click', () => selectFace(Number(pg.dataset.face)));
    });
  }

  function showTooltip(ev, ln) {
    const e = state.solution.edges[Number(ln.dataset.edge)];
    const types = Object.keys(e.types).filter(k => e.types[k]).join(' / ');
    const occ = ln.dataset.occ ? ln.dataset.occ.split(',').join(', ') : '无';
    const tip = $('#tooltip');
    tip.innerHTML =
      `<b>边 #${e.edgeId}</b> 顶点 ${e.verts[0]}–${e.verts[1]}<br>` +
      `类型: ${types || '非特征'}<br>` +
      `u ∈ [${ln.dataset.u0}, ${ln.dataset.u1}]<br>` +
      `遮挡面: ${occ}`;
    tip.style.display = 'block';
    const r = $('#view2d').getBoundingClientRect();
    tip.style.left = (ev.clientX - r.left + 14) + 'px';
    tip.style.top = (ev.clientY - r.top + 14) + 'px';
  }
  function hideTooltip() { $('#tooltip').style.display = 'none'; }

  /* ---------------- 选择与检视面板 ---------------- */

  function selectEdge(id) {
    state.selectedEdgeId = id;
    state.selectedFaceId = null;
    render3D(); render2D(); renderInspector();
  }
  function selectFace(id) {
    state.selectedFaceId = id;
    state.selectedEdgeId = null;
    render3D(); render2D(); renderInspector();
  }

  function renderInspector() {
    const host = $('#inspector');
    if (state.selectedEdgeId == null && state.selectedFaceId == null) {
      host.innerHTML = '<p class="hint">点击 2D 线稿中的线段或 3D 视图中的边，查看来源边、遮挡面与解析区间。</p>';
      return;
    }
    if (state.selectedFaceId != null) {
      const f = state.mesh.faces[state.selectedFaceId];
      host.innerHTML =
        `<h4>面 #${f.id}</h4>` +
        `<table class="kv"><tbody>` +
        `<tr><td>顶点</td><td>${f.verts.join(' , ')}</td></tr>` +
        `<tr><td>朝向</td><td>${f.front ? '正面 front' : '背面 back'}</td></tr>` +
        `<tr><td>法线</td><td class="mono">${f.normal.map(x => x.toFixed(3)).join(', ')}</td></tr>` +
        `<tr><td>面心</td><td class="mono">${f.center.map(x => x.toFixed(3)).join(', ')}</td></tr>` +
        `</tbody></table>`;
      return;
    }

    const e = state.mesh.edges[state.selectedEdgeId];
    const solved = state.solution.edges[e.id];
    const pA = state.mesh.positions[e.a], pB = state.mesh.positions[e.b];
    const badges = Object.keys(e.types).filter(k => e.types[k])
      .map(k => `<span class="badge b-${k}">${typeLabel(k)}</span>`).join('');
    const rows = solved.intervals.map((iv, i) => `
      <tr class="${iv.visible ? 'r-vis' : 'r-hid'}">
        <td>${i}</td>
        <td class="mono">${iv.u0.toFixed(4)}</td>
        <td class="mono">${iv.u1.toFixed(4)}</td>
        <td>${iv.visible ? '可见' : '隐藏'}</td>
        <td class="mono">${iv.occluderFaceIds.length ? iv.occluderFaceIds.join(', ') : '—'}</td>
      </tr>`).join('');

    const occIds = [...new Set(solved.intervals.flatMap(i => i.occluderFaceIds))];
    const occList = occIds.map(id => {
      const f = state.mesh.faces[id];
      return `<li>面 #${id} <span class="dim">顶点 ${f.verts.join('–')}，` +
        `${f.front ? '正面' : '背面'}</span></li>`;
    }).join('');

    host.innerHTML =
      (e.types.nonmanifold ? '<div class="alert">非流形边：关联面超过 2 个，已标记并保留</div>' : '') +
      `<h4>边 #${e.id} <span class="dim">来源顶点 ${e.a} – ${e.b}</span></h4>` +
      `<div class="badges">${badges || '<span class="dim">非特征边</span>'}</div>` +
      `<table class="kv"><tbody>` +
      `<tr><td>端点 A</td><td class="mono">${pA.map(x => x.toFixed(3)).join(', ')}</td></tr>` +
      `<tr><td>端点 B</td><td class="mono">${pB.map(x => x.toFixed(3)).join(', ')}</td></tr>` +
      `<tr><td>关联面</td><td class="mono">${e.faceIds.join(', ')}（遮挡解析时全部排除）</td></tr>` +
      `<tr><td>裁剪段</td><td class="mono">u ∈ [${solved.clip.u0.toFixed(4)}, ${solved.clip.u1.toFixed(4)}]</td></tr>` +
      `</tbody></table>` +
      `<h5>解析区间（${solved.intervals.length} 段）</h5>` +
      `<div class="table-wrap"><table class="iv">
        <thead><tr><th>#</th><th>u0</th><th>u1</th><th>状态</th><th>遮挡面</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` +
      `<h5>遮挡面（${occIds.length}）</h5>` +
      (occList ? `<ul class="occ">${occList}</ul>` : '<p class="dim">无遮挡面，整条边可见。</p>');
  }

  function typeLabel(k) {
    return { boundary: '边界', crease: '折痕', silhouette: '轮廓', nonmanifold: '非流形' }[k] || k;
  }

  /* ---------------- 统计与消息 ---------------- */

  function renderStats() {
    const s = state.solution;
    let hiddenSegs = 0, visSegs = 0;
    for (const e of s.edges) {
      for (const iv of e.intervals) iv.visible ? visSegs++ : hiddenSegs++;
    }
    const nm = state.mesh.edges.filter(e => e.types.nonmanifold).length;
    $('#stats').innerHTML = [
      ['面', state.mesh.faces.length],
      ['索引边', state.mesh.edges.length],
      ['特征边', s.stats.featureCount],
      ['裁剪三角形', s.stats.clipTriangleCount],
      ['可见/隐藏段', `${visSegs} / ${hiddenSegs}`],
      ['非流形', nm],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  }

  function showMessages(errors, warnings, hardErrors) {
    const host = $('#messages');
    const allE = hardErrors ? errors.concat(hardErrors) : errors;
    host.innerHTML =
      allE.map(m => `<div class="msg err">${m}</div>`).join('') +
      warnings.map(m => `<div class="msg warn">${m}</div>`).join('');
  }

  function renderEmpty() {
    $('#view2d').innerHTML = '<p class="placeholder">无可视化数据</p>';
    const ctx = ctx3d;
    const { w, h } = resizeCanvas(canvas3d);
    ctx.clearRect(0, 0, w, h);
    $('#stats').innerHTML = '';
    $('#inspector').innerHTML = '<p class="hint">导入合法网格后开始分析。</p>';
  }

  /* ---------------- 导出 ---------------- */

  function currentSVG() {
    return HLM.exporter.buildSVG(state.solution, state.mesh,
      state.exportW, state.exportH);
  }
  function currentJSON() {
    return JSON.stringify(HLM.exporter.buildJSON(state.solution, state.mesh,
      state.camSpec, state.exportW, state.exportH), null, 2);
  }

  function openExport() {
    if (!state.solution) return;
    $('#expSVG').innerHTML = currentSVG();
    $('#expJSON').textContent = currentJSON();
    $('#exportModal').hidden = false;
  }
  function closeExport() { $('#exportModal').hidden = true; }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, '已复制');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      flash(btn, '已复制');
    }
  }
  function flash(btn, txt) {
    const old = btn.textContent;
    btn.textContent = txt;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  /* ---------------- 交互绑定 ---------------- */

  function bindEvents() {
    $('#sampleSelect').addEventListener('change', ev => {
      if (!ev.target.value) return;
      loadData(window.HLM_SAMPLES[ev.target.value], ev.target.value);
    });
    $('#fileInput').addEventListener('change', ev => {
      const f = ev.target.files[0];
      if (f) readFile(f);
    });
    const drop = $('#dropZone');
    ['dragover', 'dragenter'].forEach(t =>
      drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t =>
      drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });

    $('#crease').addEventListener('input', ev => {
      state.creaseDegrees = Number(ev.target.value);
      $('#creaseVal').textContent = state.creaseDegrees.toFixed(0) + '°';
      if (state.rawData) recompute();
    });
    $('#resetView').addEventListener('click', resetView);

    // 3D 轨道
    let dragging = false, lx = 0, ly = 0;
    canvas3d.addEventListener('pointerdown', ev => {
      dragging = true; lx = ev.clientX; ly = ev.clientY;
      canvas3d.setPointerCapture(ev.pointerId);
    });
    canvas3d.addEventListener('pointermove', ev => {
      if (!dragging) return;
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      state.orbit.yaw -= dx * 0.01;
      state.orbit.pitch = M.clamp(state.orbit.pitch + dy * 0.01, -1.55, 1.55);
      requestAnimationFrame(() => state.rawData && recompute());
    });
    canvas3d.addEventListener('pointerup', ev => {
      const moved = Math.hypot(ev.clientX - lx, ev.clientY - ly);
      dragging = false;
      if (moved < 4) {
        const r = canvas3d.getBoundingClientRect();
        const pick = pick3D(ev.clientX - r.left, ev.clientY - r.top);
        if (pick.edgeId >= 0) selectEdge(pick.edgeId);
        else if (pick.faceId >= 0) selectFace(pick.faceId);
        else { state.selectedEdgeId = null; state.selectedFaceId = null; render3D(); render2D(); renderInspector(); }
      }
    });
    canvas3d.addEventListener('wheel', ev => {
      ev.preventDefault();
      const k = Math.exp(ev.deltaY * 0.001);
      if (state.camera.type === 'perspective') state.orbit.dist *= k;
      else state.orbit.height = M.clamp(state.orbit.height * k, 0.05, 1000);
      requestAnimationFrame(() => state.rawData && recompute());
    }, { passive: false });

    // 导出尺寸
    const onSize = () => {
      const w = Number($('#expW').value), h = Number($('#expH').value);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) return;
      const before = state.lastIntervalSignature;
      state.exportW = Math.round(w); state.exportH = Math.round(h);
      if (state.solution) { render2D(); renderSignature(); }
      const invariant = before === state.lastIntervalSignature;
      $('#sizeNote').textContent =
        `区间判定不变：${invariant ? '✓ 与上一尺寸完全一致' : '✗ 异常'}（分辨率仅改变坐标尺度）`;
      $('#sizeNote').className = invariant ? 'ok' : 'bad';
    };
    $('#expW').addEventListener('change', onSize);
    $('#expH').addEventListener('change', onSize);
    $$('.size-preset').forEach(b => b.addEventListener('click', () => {
      const [w, h] = b.dataset.size.split('x').map(Number);
      $('#expW').value = w; $('#expH').value = h; onSize();
    }));

    $('#btnExport').addEventListener('click', openExport);
    $('#closeExport').addEventListener('click', closeExport);
    $('#dlSvg').addEventListener('click', () =>
      HLM.exporter.download(`${baseName()}.svg`, currentSVG(), 'image/svg+xml'));
    $('#dlJson').addEventListener('click', () =>
      HLM.exporter.download(`${baseName()}.json`, currentJSON(), 'application/json'));
    $('#cpSvg').addEventListener('click', ev => copyText(currentSVG(), ev.target));
    $('#cpJson').addEventListener('click', ev => copyText(currentJSON(), ev.target));

    $('#themeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme !== 'dark';
      root.dataset.theme = dark ? 'dark' : 'light';
      try { localStorage.setItem('hlm-theme', dark ? 'dark' : 'light'); } catch (_) {}
      if (state.solution) { render3D(); render2D(); }
    });

    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        state.selectedEdgeId = null; state.selectedFaceId = null;
        closeExport();
        if (state.solution) { render3D(); render2D(); renderInspector(); }
      }
    });
    window.addEventListener('resize', () => {
      if (state.solution) { render3D(); render2D(); }
    });
  }

  function baseName() {
    return (state.name || 'hidden-line').replace(/[^\w.-]+/g, '_');
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadData(JSON.parse(reader.result), file.name.replace(/\.json$/, ''));
      } catch (err) {
        showMessages([`JSON 解析失败: ${err.message}`], []);
        renderEmpty();
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    try {
      const t = localStorage.getItem('hlm-theme');
      if (t) document.documentElement.dataset.theme = t;
    } catch (_) {}
    readTokens();
    bindEvents();
    $('#sampleSelect').value = 'single-occluder';
    loadData(window.HLM_SAMPLES['single-occluder'], 'single-occluder');
  }
  document.addEventListener('DOMContentLoaded', init);
})();
