/* app.js — Z-Fail 阴影体逐像素校验页面逻辑(依赖 zfail-core.js) */
/* global ZFail */
'use strict';

const $ = id => document.getElementById(id);

// 与 samples/zfail-volume-cases.json 相同的内置兜底(无 http 服务时也能运行)
const EMBEDDED = {"size":[49,49],"light":[0,0,0],"camera":{"eye":[0.2,0.1,4],"target":[0.2,0.1,9],"fovy":60,"near":0.1},"casters":[{"v":[[-0.5,-0.5,1],[0.5,-0.5,1],[0.5,0.5,1],[-0.5,0.5,1],[-0.5,-0.5,2],[0.5,-0.5,2],[0.5,0.5,2],[-0.5,0.5,2]],"f":[[0,3,2],[4,5,6],[0,1,5],[1,2,6],[2,3,7],[3,0,4],[0,2,1],[4,6,7],[0,5,4],[1,6,5],[2,7,6],[3,4,7]]},{"v":[[-0.55,-0.55,2.5],[0.55,-0.55,2.5],[0.55,0.55,2.5],[-0.55,0.55,2.5],[-0.55,-0.55,3.5],[0.55,-0.55,3.5],[0.55,0.55,3.5],[-0.55,0.55,3.5]],"f":[[0,3,2],[4,5,6],[0,1,5],[1,2,6],[2,3,7],[3,0,4],[0,2,1],[4,6,7],[0,5,4],[1,6,5],[2,7,6],[3,4,7]]}],"receivers":[{"v":[[-8,-8,9],[8,-8,9],[8,8,9],[-8,8,9]],"f":[[0,1,2],[0,2,3]]}]};

const state = {
  scene: null,
  result: null,
  rayCount: null,   // Uint8Array:每像素遮挡它的 caster 数(独立射线参考)
  mismatches: [],   // [x, y, stencil, expected]
  sel: null,        // {x, y}
  zoom: 0,          // 0 = 自动
};

// ---------- 参数 ----------
function readParams() {
  const num = id => parseFloat($(id).value);
  return {
    light: [num('lx'), num('ly'), num('lz')],
    eye: [num('ex'), num('ey'), num('ez')],
    target: [num('tx'), num('ty'), num('tz')],
    fovy: num('fovy'),
    near: Math.max(1e-4, num('near')),
    W: Math.min(192, Math.max(1, Math.round(num('rw')))),
    H: Math.min(144, Math.max(1, Math.round(num('rh')))),
  };
}
function writeParams(scene) {
  const c = scene.camera;
  $('lx').value = scene.light[0]; $('ly').value = scene.light[1]; $('lz').value = scene.light[2];
  $('ex').value = c.eye[0]; $('ey').value = c.eye[1]; $('ez').value = c.eye[2];
  $('tx').value = c.target[0]; $('ty').value = c.target[1]; $('tz').value = c.target[2];
  $('fovy').value = c.fovy; $('near').value = c.near;
  $('rw').value = scene.size[0]; $('rh').value = scene.size[1];
}

// ---------- 计算 ----------
function recompute() {
  const p = readParams();
  const res = ZFail.render(state.scene, p);
  state.result = res;
  if (state.sel && (state.sel.x >= res.W || state.sel.y >= res.H)) state.sel = null;
  // 独立射线参考:每像素遮挡 caster 数 + 不一致列表
  const rayCount = new Uint8Array(res.W * res.H);
  const mismatches = [];
  for (let y = 0; y < res.H; y++) {
    for (let x = 0; x < res.W; x++) {
      const i = y * res.W + x;
      if (res.depth[i] >= 1) continue;
      const P = ZFail.worldPos(res, x, y);
      const { occ } = ZFail.occlusionPerCaster(P, p.light, state.scene.casters);
      const n = occ.filter(Boolean).length;
      rayCount[i] = n;
      if ((res.stencil[i] !== 0) !== (n > 0) || Math.abs(res.stencil[i]) !== n)
        mismatches.push([x, y, res.stencil[i], n]);
    }
  }
  state.rayCount = rayCount;
  state.mismatches = mismatches;
  updateStatus();
  draw();
  updateInspector();
}

function updateStatus() {
  const r = state.result;
  let recv = 0;
  for (let i = 0; i < r.depth.length; i++) if (r.depth[i] < 1) recv++;
  const nMesh = state.scene.casters.reduce((s, c) => s + c.f.length, 0);
  const bad = state.mismatches.length;
  $('status').innerHTML =
    `网格三角形 ${nMesh} · 体积三角形 ${r.vols.length} · 接收面像素 ${recv}\n` +
    (bad === 0
      ? `<span class="ok">✓ 模板计数与独立遮挡射线全部一致</span>`
      : `<span class="bad">✗ ${bad} 个像素不一致(模板≠射线参考)</span>`) +
    (r.warnings.length ? `\n<span class="bad">警告: ${r.warnings.join('; ')}</span>` : '');
  $('sceneInfo').textContent = `${r.W}×${r.H}`;
}

// ---------- 线框段收集 ----------
function collectSegments() {
  const r = state.result;
  const segs = [];
  const toPx = p => [(p[0] / p[3] + 1) * 0.5 * r.W, (1 - p[1] / p[3]) * 0.5 * r.H];
  // 体积三角形(裁剪后多边形边界)
  r.vols.forEach((v, vid) => {
    if (!v.clip || v.clip.length < 3) return;
    for (let i = 0; i < v.clip.length; i++) {
      const a = toPx(v.clip[i]), b = toPx(v.clip[(i + 1) % v.clip.length]);
      segs.push({ a, b, type: v.type, volId: vid });
    }
  });
  // 网格边(caster 灰、receiver 暗灰),仅做近面裁剪
  const clipSeg = (A, B) => {
    const da = A[2] + A[3], db = B[2] + B[3];
    if (da < 0 && db < 0) return null;
    if (da >= 0 && db >= 0) return [A, B];
    const t = da / (da - db);
    const I = [0, 1, 2, 3].map(k => A[k] + t * (B[k] - A[k]));
    return da >= 0 ? [A, I] : [I, B];
  };
  const meshEdges = (mesh, type) => {
    const seen = new Set();
    mesh.f.forEach(t => {
      for (let e = 0; e < 3; e++) {
        const i = t[e], j = t[(e + 1) % 3];
        const key = i < j ? i + '_' + j : j + '_' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = ZFail.xform(r.cam.vp, [...mesh.v[i], 1]);
        const B = ZFail.xform(r.cam.vp, [...mesh.v[j], 1]);
        const s = clipSeg(A, B);
        if (!s) continue;
        segs.push({ a: toPx(s[0]), b: toPx(s[1]), type, volId: -1 });
      }
    });
  };
  state.scene.casters.forEach(c => meshEdges(c, 'mesh'));
  state.scene.receivers.forEach(c => meshEdges(c, 'recv'));
  return segs;
}

const WIRE_COLOR = {
  side: 'rgba(255,210,90,0.55)',
  capNear: 'rgba(90,210,255,0.55)',
  capFar: 'rgba(255,90,220,0.45)',
  mesh: 'rgba(160,160,170,0.35)',
  recv: 'rgba(120,120,130,0.5)',
};

// ---------- 视图绘制 ----------
function baseImage(mode) {
  const r = state.result;
  const { W, H, depth, stencil, nrm } = r;
  const img = new ImageData(W, H);
  const d = img.data;
  // 深度归一化范围
  let dmin = 1, dmax = -1;
  if (mode === 'depth') {
    for (let i = 0; i < W * H; i++) {
      if (depth[i] < 1) { dmin = Math.min(dmin, depth[i]); dmax = Math.max(dmax, depth[i]); }
    }
    if (dmax <= dmin) dmax = dmin + 1e-9;
  }
  const light = readParams().light;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      let R = 8, G = 8, B = 12;
      if (mode === 'wire') {
        // 纯线框:黑底
      } else if (mode === 'stencil') {
        const s = stencil[i];
        if (s > 0) { const k = Math.min(1, s / 4); R = 40 + 215 * k; G = 30 + 60 * k; B = 30; }
        else if (s < 0) { const k = Math.min(1, -s / 4); R = 30; G = 40 + 80 * k; B = 40 + 215 * k; }
        else { R = 24; G = 24; B = 26; }
      } else if (mode === 'depth') {
        if (depth[i] < 1) {
          const g = Math.round(255 * (1 - (depth[i] - dmin) / (dmax - dmin)));
          R = G = B = g;
        }
      } else if (mode === 'diff') {
        if (depth[i] < 1) {
          const st = stencil[i] !== 0, ray = state.rayCount[i] > 0;
          if (st === ray && Math.abs(stencil[i]) === state.rayCount[i]) {
            if (ray) { R = 30; G = 38; B = 58; } else { R = 22; G = 74; B = 40; }
          } else {
            R = 230; G = st ? 60 : 150; B = 40;
          }
        }
      } else { // shaded
        if (depth[i] < 1) {
          const P = ZFail.worldPos(r, x, y);
          const L = ZFail.norm(ZFail.sub(light, P));
          const N = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
          const diff = Math.max(0, ZFail.dot(N, L));
          const shadow = stencil[i] !== 0 ? 0.12 : 1;
          const k = (0.15 + 0.85 * diff) * shadow;
          R = 190 * k; G = 182 * k; B = 168 * k;
        }
      }
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
    }
  }
  return img;
}

function currentZoom() {
  if (state.zoom > 0) return state.zoom;
  const r = state.result;
  return Math.max(1, Math.min(12, Math.floor(560 / Math.max(r.W, r.H))));
}

const off = document.createElement('canvas');
function draw() {
  const r = state.result;
  if (!r) return;
  const mode = document.querySelector('input[name=view]:checked').value;
  const z = currentZoom();
  const cv = $('view');
  cv.width = r.W * z; cv.height = r.H * z;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  off.width = r.W; off.height = r.H;
  off.getContext('2d').putImageData(baseImage(mode), 0, 0);
  ctx.drawImage(off, 0, 0, cv.width, cv.height);

  // 线框
  const showWire = mode === 'wire' || $('overlayWire').checked;
  const segs = collectSegments();
  const hl = highlightVolIds();
  if (showWire || hl.size) {
    ctx.lineWidth = 1;
    if (showWire) {
      for (const s of segs) {
        if (hl.has(s.volId)) continue;
        ctx.strokeStyle = WIRE_COLOR[s.type];
        line(ctx, s, z);
      }
    }
    // 选中像素的贡献三角形高亮
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff3b30';
    for (const s of segs) if (s.volId >= 0 && hl.has(s.volId)) line(ctx, s, z);
    ctx.lineWidth = 1;
  }

  // 选中像素:十字 + 遮挡射线
  if (state.sel) {
    const { x, y } = state.sel;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x * z - 0.5, y * z - 0.5, z + 1, z + 1);
    const P = ZFail.worldPos(r, x, y);
    if (P) {
      const light = readParams().light;
      const toPx = w => {
        const c = ZFail.xform(r.cam.vp, [...w, 1]);
        if (c[3] <= 1e-9) return null; // 在相机后方
        return [(c[0] / c[3] + 1) * 0.5 * r.W * z, (1 - c[1] / c[3]) * 0.5 * r.H * z];
      };
      const a = toPx(P), b = toPx(light);
      if (a && b) {
        ctx.strokeStyle = 'rgba(255,150,40,0.9)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (a) {
        ctx.fillStyle = '#ff9628';
        ctx.beginPath(); ctx.arc(a[0], a[1], 3, 0, 7); ctx.fill();
      }
      if (b) {
        ctx.fillStyle = '#ffe08a';
        ctx.beginPath(); ctx.arc(b[0], b[1], 4, 0, 7); ctx.fill();
      }
    }
  }
}
function line(ctx, s, z) {
  ctx.beginPath();
  ctx.moveTo(s.a[0] * z, s.a[1] * z);
  ctx.lineTo(s.b[0] * z, s.b[1] * z);
  ctx.stroke();
}
function highlightVolIds() {
  const set = new Set();
  if (state.sel && state.result) {
    for (const c of ZFail.contributionsAt(state.result, state.sel.x, state.sel.y))
      if (c.delta !== 0) set.add(c.volId);
  }
  return set;
}

// ---------- 检查器 ----------
const TYPE_NAME = { side: '侧面', capNear: '近盖', capFar: '远盖' };
function updateInspector() {
  const has = !!state.sel;
  $('inspNone').style.display = has ? 'none' : '';
  $('inspBody').style.display = has ? '' : 'none';
  if (!has) return;
  const r = state.result;
  const { x, y } = state.sel;
  const i = y * r.W + x;
  $('iPix').textContent = `(${x}, ${y})`;
  const P = ZFail.worldPos(r, x, y);
  $('iPos').textContent = P ? P.map(v => v.toFixed(3)).join(', ') : '—(无接收面)';
  $('iDS').textContent = r.depth[i] >= 1
    ? `— / ${r.stencil[i]}`
    : `z=${r.depth[i].toFixed(5)} / ${r.stencil[i]}`;

  const cons = ZFail.contributionsAt(r, x, y);
  let html = '<table><tr><th class="l">体</th><th class="l">类型</th><th class="l">源面</th>' +
    '<th>朝向</th><th>片元z</th><th>判定</th><th>Δ</th></tr>';
  let sum = 0;
  for (const c of cons) {
    sum += c.delta;
    html += `<tr><td class="l">${c.caster}</td>` +
      `<td class="l"><span class="pill ${c.type}">${TYPE_NAME[c.type]}</span></td>` +
      `<td class="l">f${c.src}</td>` +
      `<td>${c.front ? '正' : '背'}</td><td>${c.z.toFixed(4)}</td>` +
      `<td>${c.fail ? 'z失败' : 'z通过'}</td>` +
      `<td>${c.delta > 0 ? '+' + c.delta : c.delta}</td></tr>`;
  }
  html += `<tr><th class="l" colspan="6">合计(=模板值 ${r.stencil[i]})</th><th>${sum > 0 ? '+' + sum : sum}</th></tr></table>`;
  if (!cons.length) html = '<div class="hint">无体积三角形覆盖此像素</div>';
  $('iContribs').innerHTML = html;

  if (P) {
    const light = readParams().light;
    const { hits } = ZFail.rayCast(P, light, state.scene.casters);
    const nOcc = state.rayCount[i];
    let rh = `<div>命中 ${hits.length} 次,遮挡体 ${nOcc} 个(期望 |模板|=${nOcc})</div>`;
    if (hits.length) {
      rh += '<table><tr><th class="l">体</th><th class="l">面</th><th>t</th></tr>';
      for (const h of hits)
        rh += `<tr><td class="l">${h.caster}</td><td class="l">f${h.tri}</td><td>${h.t.toFixed(4)}</td></tr>`;
      rh += '</table>';
    }
    $('iRay').innerHTML = rh;
    const ok = (r.stencil[i] !== 0) === (nOcc > 0) && Math.abs(r.stencil[i]) === nOcc;
    $('iVerdict').className = 'verdict ' + (ok ? 'ok' : 'bad');
    $('iVerdict').textContent = ok
      ? `✓ 一致:模板=${r.stencil[i]},射线=${nOcc > 0 ? '阴影' : '受光'}`
      : `✗ 不一致:模板=${r.stencil[i]}(${r.stencil[i] !== 0 ? '阴影' : '受光'}),射线=${nOcc > 0 ? '阴影' : '受光'}(期望|计数|=${nOcc})`;
  } else {
    $('iRay').innerHTML = '<div class="hint">此像素无接收面,不做射线对照</div>';
    $('iVerdict').className = 'verdict';
    $('iVerdict').textContent = '';
  }
}

// ---------- 导出 ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportStencilCSV() {
  const r = state.result;
  const rows = [];
  for (let y = 0; y < r.H; y++) {
    const row = [];
    for (let x = 0; x < r.W; x++) row.push(r.stencil[y * r.W + x]);
    rows.push(row.join(','));
  }
  download('stencil.csv', new Blob([rows.join('\n')], { type: 'text/csv' }));
}
function exportPNG(mode, name) {
  const img = baseImage(mode);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  c.toBlob(b => download(name, b), 'image/png');
}

// ---------- 场景加载 ----------
function setScene(scene) {
  state.scene = scene;
  state.sel = null;
  writeParams(scene);
  recompute();
}
function loadDefault() {
  fetch('samples/zfail-volume-cases.json')
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(setScene)
    .catch(() => setScene(EMBEDDED));
}

// ---------- 事件 ----------
function bind() {
  const ids = ['lx','ly','lz','ex','ey','ez','tx','ty','tz','fovy','near','rw','rh'];
  ids.forEach(id => $(id).addEventListener('input', recompute));
  document.querySelectorAll('input[name=view]').forEach(el => el.addEventListener('change', draw));
  $('overlayWire').addEventListener('change', draw);
  $('zoom').addEventListener('change', e => { state.zoom = +e.target.value; draw(); });
  $('reset').addEventListener('click', loadDefault);
  $('file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { setScene(JSON.parse(rd.result)); }
      catch (err) { alert('JSON 解析失败: ' + err.message); }
    };
    rd.readAsText(f);
  });
  $('view').addEventListener('click', e => {
    const r = state.result, z = currentZoom();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / z);
    const y = Math.floor((e.clientY - rect.top) / z);
    if (x < 0 || y < 0 || x >= r.W || y >= r.H) return;
    state.sel = { x, y };
    draw();
    updateInspector();
  });
  $('dlStencil').addEventListener('click', exportStencilCSV);
  $('dlDiff').addEventListener('click', () => exportPNG('diff', 'diff.png'));
  $('dlView').addEventListener('click', () => {
    const mode = document.querySelector('input[name=view]:checked').value;
    exportPNG(mode, 'view-' + mode + '.png');
  });
  $('jumpBad').addEventListener('click', () => {
    if (!state.mismatches.length) return;
    const [x, y] = state.mismatches[0];
    state.sel = { x, y };
    draw();
    updateInspector();
  });
}

bind();
loadDefault();
