// main.js — 门洞可见性调试器前端
import * as THREE from 'three';
import { validateScene, computeTraversal } from './portal-core.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const wrap = view.parentElement;

// ---------------- 状态 ----------------
const state = {
  data: null,          // 场景 JSON
  sceneName: '',
  open: new Map(),     // portalId -> bool
  mode: 'culled',      // 'full' | 'culled'
  cam: { position: [0, 1.5, 1], yaw: 0, pitch: 0, fov: 80, near: 0.1, far: 30 },
  activePreset: null,
  traversal: null,
  selectedPath: -1,
  uiSig: '',
  idDirty: true,
  diffStats: null,
};

// ---------------- Three.js 主视图 ----------------
const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x14171c);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, 1, 0.1, 30);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30363f, 1.1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(3, 8, 5);
scene.add(dirLight);

const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x8b93a1, side: THREE.DoubleSide });
const closedPortalMaterial = new THREE.MeshLambertMaterial({ color: 0xc08a3e, side: THREE.DoubleSide });
const idMaterialWall = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
const overlayGroup = new THREE.Group();
scene.add(overlayGroup);

const OBJECT_PALETTE = [0xe06c5c, 0x5ca8e0, 0x7dc95e, 0xc95ec2, 0xe0c35c, 0x5ce0d0, 0xe08a4c, 0x9a7de0];

// ---------------- 离屏 ID 渲染器（无 AA、无光照、无色调映射） ----------------
const idRenderer = new THREE.WebGLRenderer({ antialias: false });
idRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
idRenderer.toneMapping = THREE.NoToneMapping;
idRenderer.setClearColor(0x000000, 1);
let idRT = null;
let idW = 0, idH = 0;
const idCamera = new THREE.PerspectiveCamera(80, 1, 0.1, 30);

// ---------------- 场景图 ----------------
const roomNodes = new Map();   // roomId -> {wall, objects[]}
const portalNodes = new Map(); // portalId -> {quad, outline, rooms, tris}
const idMeshes = [];           // 参与 ID pass 的 mesh
let objectIdList = [];         // 展品 id 列表（索引+1 = ID 色）

function encodeIdColor(i) {
  // 仅使用 R 通道，避免 UNORM 舍入歧义；0 = 墙/背景
  return new THREE.Color((i + 1) / 255, 0, 0);
}

function clearSceneGraph() {
  for (const obj of [...scene.children]) {
    if (obj === overlayGroup) continue;
    if (obj.isLight) continue;
    scene.remove(obj);
  }
  overlayGroup.clear();
  roomNodes.clear();
  portalNodes.clear();
  idMeshes.length = 0;
  objectIdList = [];
}

function buildSceneGraph(data) {
  clearSceneGraph();
  for (const room of data.rooms) {
    const node = { wall: null, objects: [] };
    const w = data.walls && data.walls[room.id];
    if (w && w.vertices.length && w.faces.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(w.vertices.flat(), 3));
      g.setIndex(w.faces.flat());
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, wallMaterial);
      mesh.userData = { kind: 'wall', room: room.id, tris: w.faces.length, idMat: idMaterialWall };
      scene.add(mesh);
      idMeshes.push(mesh);
      node.wall = mesh;
    }
    roomNodes.set(room.id, node);
  }
  (data.objects || []).forEach((o, i) => {
    const g = new THREE.BoxGeometry(o.size[0], o.size[1], o.size[2]);
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: OBJECT_PALETTE[i % OBJECT_PALETTE.length] }));
    mesh.position.set(o.center[0], o.center[1], o.center[2]);
    mesh.userData = { kind: 'object', room: o.room, objectId: o.id, tris: 12, idMat: new THREE.MeshBasicMaterial({ color: encodeIdColor(i) }) };
    scene.add(mesh);
    idMeshes.push(mesh);
    roomNodes.get(o.room)?.objects.push(mesh);
    objectIdList.push(o.id);
  });
  for (const p of data.portals || []) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.points.flat(), 3));
    const idx = [];
    for (let i = 1; i < p.points.length - 1; i++) idx.push(0, i, i + 1);
    g.setIndex(idx);
    g.computeVertexNormals();
    const quad = new THREE.Mesh(g, closedPortalMaterial);
    quad.userData = { kind: 'portalQuad', portal: p.id, tris: p.points.length - 2, idMat: idMaterialWall };
    scene.add(quad);
    idMeshes.push(quad);
    const outline = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x4caf7d }));
    overlayGroup.add(outline);
    portalNodes.set(p.id, { quad, outline, rooms: p.rooms, tris: p.points.length - 2 });
  }
}

// candSet 为 null 表示完整场景
function applyVisibility(candSet) {
  for (const [roomId, node] of roomNodes) {
    const vis = candSet === null || candSet.has(roomId);
    if (node.wall) node.wall.visible = vis;
    for (const o of node.objects) o.visible = vis;
  }
  for (const [pid, p] of portalNodes) {
    const isOpen = state.open.get(pid) !== false;
    const adjacent = candSet === null || p.rooms.some(r => candSet.has(r));
    p.quad.visible = !isOpen && adjacent; // 关闭的门洞作为墙面绘制
    p.outline.visible = true;
    p.outline.material.color.set(isOpen ? 0x4caf7d : 0xe05c5c);
  }
}

// ---------------- 相机控制 ----------------
const keys = new Set();
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));

let dragging = false;
view.addEventListener('pointerdown', e => { dragging = true; view.setPointerCapture(e.pointerId); });
view.addEventListener('pointerup', () => { dragging = false; });
view.addEventListener('pointermove', e => {
  if (!dragging) return;
  state.cam.yaw -= e.movementX * 0.0032;
  state.cam.pitch = Math.max(-1.5, Math.min(1.5, state.cam.pitch - e.movementY * 0.0032));
});

function forwardVec() {
  const { yaw, pitch } = state.cam;
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c];
}

function updateCamera(dt) {
  const c = state.cam;
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 9 : 3) * dt;
  const f = forwardVec();
  const fh = Math.hypot(f[0], f[2]) > 1e-9 ? [f[0], 0, f[2]].map((v, i, a) => v / Math.hypot(a[0], a[2])) : [0, 0, 1];
  const right = [-fh[2], 0, fh[0]];
  const move = [0, 0, 0];
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.forEach((_, i) => move[i] += fh[i]);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.forEach((_, i) => move[i] -= fh[i]);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.forEach((_, i) => move[i] += right[i]);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.forEach((_, i) => move[i] -= right[i]);
  if (keys.has('KeyE')) move[1] += 1;
  if (keys.has('KeyQ')) move[1] -= 1;
  const l = Math.hypot(...move);
  if (l > 0) {
    c.position = c.position.map((v, i) => v + (move[i] / l) * speed);
    state.activePreset = null;
    refreshPresetButtons();
  }
  const target = [
    c.position[0] + f[0], c.position[1] + f[1], c.position[2] + f[2],
  ];
  camera.position.set(...c.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(...target);
  camera.fov = c.fov; camera.near = c.near; camera.far = c.far;
  camera.updateProjectionMatrix();
  return target;
}

// ---------------- 遍历与 UI ----------------
function camSpec(target, aspect) {
  const c = state.cam;
  return { position: c.position, target, up: [0, 1, 0], fov: c.fov, aspect, near: c.near, far: c.far };
}

function candidateSet() {
  return state.traversal && !state.traversal.error ? new Set(state.traversal.candidates) : null;
}

function triCounts() {
  const count = cand => {
    let n = 0;
    for (const [roomId, node] of roomNodes) {
      if (cand !== null && !cand.has(roomId)) continue;
      if (node.wall) n += node.wall.userData.tris;
      n += node.objects.length * 12;
    }
    for (const [pid, p] of portalNodes) {
      const isOpen = state.open.get(pid) !== false;
      if (isOpen) continue;
      if (cand !== null && !p.rooms.some(r => cand.has(r))) continue;
      n += p.tris;
    }
    return n;
  };
  const cand = candidateSet();
  return { full: count(null), culled: cand === null ? null : count(cand) };
}

function updatePanels() {
  const t = state.traversal;
  const banner = $('#errorBanner');
  if (t && t.error) {
    banner.hidden = false;
    banner.textContent = '⚠ ' + t.error + '\n主视图已回退为完整场景渲染。';
  } else {
    banner.hidden = true;
  }
  $('#hudRoom').textContent = '房间: ' + (t && t.room ? t.room : '（不在任何房间）');
  $('#hudMode').textContent = state.mode === 'full' ? '完整场景' : '裁剪结果';
  $('#candCount').textContent = t && !t.error ? `${t.candidates.length} 个` : '';
  $('#candidateList').innerHTML = (t && !t.error ? t.candidates : [])
    .map(id => `<span class="chip${id === t.room ? ' current' : ''}">${id}</span>`).join('');
  $('#truncatedNote').hidden = !(t && t.truncated);
  const tris = triCounts();
  $('#trisFull').textContent = tris.full;
  $('#trisCulled').textContent = tris.culled === null ? '—' : tris.culled;
  const paths = t ? t.paths : [];
  $('#pathCount').textContent = `${paths.length} 条`;
  const MAX_SHOW = 200;
  $('#pathList').innerHTML = paths.slice(0, MAX_SHOW).map((p, i) => {
    const seq = p.rooms.map((r, j) => j === 0 ? r : `—${p.portals[j - 1]}→ ${r}`).join(' ');
    return `<div class="path-item${i === state.selectedPath ? ' selected' : ''}" data-i="${i}">
      <div class="rooms">${seq}</div>
      <div class="meta">窗口顶点 ${p.window.length} · 面积 ${windowArea(p.window).toFixed(3)}</div>
    </div>`;
  }).join('') + (paths.length > MAX_SHOW ? `<div class="path-more">… 其余 ${paths.length - MAX_SHOW} 条从略</div>` : '');
  document.querySelectorAll('.path-item').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedPath = state.selectedPath === +el.dataset.i ? -1 : +el.dataset.i;
      updatePanels();
    });
  });
  drawNdc();
}

function windowArea(w) {
  let s = 0;
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[(i + 1) % w.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

function drawNdc() {
  const cv = $('#ndcView');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const px = x => ((x + 1) / 2) * W;
  const py = y => ((1 - y) / 2) * H;
  ctx.strokeStyle = '#3a4353';
  ctx.strokeRect(px(-1), py(1), W, H);
  const t = state.traversal;
  if (!t || t.error) return;
  const drawPoly = (w, hue, alpha, line) => {
    ctx.beginPath();
    w.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.closePath();
    ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${alpha})`;
    ctx.fill();
    if (line) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
  };
  t.paths.forEach((p, i) => {
    if (i === state.selectedPath) return;
    drawPoly(p.window, (i * 47) % 360, 0.25, false);
  });
  if (state.selectedPath >= 0 && t.paths[state.selectedPath]) {
    const p = t.paths[state.selectedPath];
    p.steps.forEach(s => drawPoly(s.window, 200, 0.15, false));
    drawPoly(p.window, 120, 0.5, true);
  }
}

// ---------------- 物体 ID 对比 ----------------
function setupIdTarget(aspect) {
  idW = 384;
  idH = Math.max(2, Math.round(idW / aspect));
  if (idRT) idRT.dispose();
  idRT = new THREE.WebGLRenderTarget(idW, idH, { samples: 0 });
}

function renderIdImage(candSet) {
  applyVisibility(candSet);
  overlayGroup.visible = false;
  const saved = idMeshes.map(m => m.material);
  idMeshes.forEach(m => { m.material = m.userData.idMat; });
  idRenderer.setRenderTarget(idRT);
  idRenderer.render(scene, idCamera);
  const px = new Uint8Array(idW * idH * 4);
  idRenderer.readRenderTargetPixels(idRT, 0, 0, idW, idH, px);
  idRenderer.setRenderTarget(null);
  idMeshes.forEach((m, i) => { m.material = saved[i]; });
  overlayGroup.visible = true;
  return px;
}

const ID_DISPLAY_PALETTE = [[0, 0, 0]];
for (let i = 1; i < 256; i++) {
  ID_DISPLAY_PALETTE.push([
    (i * 167 + 60) % 220 + 35,
    (i * 97 + 120) % 200 + 55,
    (i * 57 + 200) % 180 + 60,
  ]);
}

function drawIdCanvas(canvas, px) {
  canvas.width = idW; canvas.height = idH;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(idW, idH);
  for (let y = 0; y < idH; y++) {
    for (let x = 0; x < idW; x++) {
      const src = ((idH - 1 - y) * idW + x) * 4; // GL 行序翻转
      const id = px[src];
      const c = ID_DISPLAY_PALETTE[id] || [255, 255, 255];
      const dst = (y * idW + x) * 4;
      img.data[dst] = c[0]; img.data[dst + 1] = c[1]; img.data[dst + 2] = c[2]; img.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function runIdCompare() {
  if (!state.data || !idRT) return;
  const aspect = camera.aspect;
  idCamera.fov = state.cam.fov;
  idCamera.near = state.cam.near;
  idCamera.far = state.cam.far;
  idCamera.aspect = aspect;
  idCamera.position.copy(camera.position);
  idCamera.quaternion.copy(camera.quaternion);
  idCamera.updateProjectionMatrix();

  const cand = candidateSet();
  const full = renderIdImage(null);
  const culled = renderIdImage(cand);
  let mismatch = 0;
  const diff = new Uint8Array(idW * idH * 4);
  for (let i = 0; i < idW * idH; i++) {
    const a = full[i * 4], b = culled[i * 4];
    if (a !== b) {
      mismatch++;
      diff[i * 4] = 255; diff[i * 4 + 3] = 255;
    } else {
      const v = a === 0 ? 24 : 70;
      diff[i * 4] = v; diff[i * 4 + 1] = v; diff[i * 4 + 2] = v; diff[i * 4 + 3] = 255;
    }
  }
  drawIdCanvas($('#idFull'), full);
  drawIdCanvas($('#idCulled'), culled);
  const dc = $('#idDiff');
  dc.width = idW; dc.height = idH;
  const ctx = dc.getContext('2d');
  const img = ctx.createImageData(idW, idH);
  for (let y = 0; y < idH; y++) {
    const srcRow = (idH - 1 - y) * idW * 4;
    img.data.set(diff.subarray(srcRow, srcRow + idW * 4), y * idW * 4);
  }
  ctx.putImageData(img, 0, 0);
  state.diffStats = { width: idW, height: idH, mismatchPixels: mismatch, totalPixels: idW * idH };
  $('#diffStats').innerHTML = mismatch === 0
    ? `<span class="ok">✓ 一致</span><br>${idW}×${idH}，0 个差异像素`
    : `<span class="bad">✗ ${mismatch} 个差异像素</span><br>${idW}×${idH} 共 ${idW * idH} 像素`;
}

// ---------------- 报告导出 ----------------
function exportReport() {
  const t = state.traversal;
  const tris = triCounts();
  const c = state.cam;
  const f = forwardVec();
  const report = {
    generatedAt: new Date().toISOString(),
    scene: state.sceneName,
    camera: {
      preset: state.activePreset,
      position: c.position,
      target: c.position.map((v, i) => v + f[i]),
      up: [0, 1, 0],
      fov: c.fov, aspect: camera.aspect, near: c.near, far: c.far,
    },
    currentRoom: t ? t.room : null,
    error: t ? t.error : '场景未加载',
    portals: (state.data ? state.data.portals : []).map(p => ({
      id: p.id, rooms: p.rooms, open: state.open.get(p.id) !== false,
    })),
    candidates: t && !t.error ? t.candidates : [],
    truncated: t ? t.truncated : false,
    paths: t ? t.paths.map(p => ({ rooms: p.rooms, portals: p.portals, window: p.window })) : [],
    submittedTriangles: tris,
    objectIdDiff: state.diffStats,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'portal-visibility-report.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 场景加载 ----------------
function showLoadErrors(errors, name) {
  const banner = $('#errorBanner');
  banner.hidden = false;
  banner.textContent = `场景 ${name} 校验失败，未加载：\n` + errors.map(e => '· ' + e).join('\n');
}

function initScene(data, name) {
  const errors = validateScene(data);
  if (errors.length > 0) { showLoadErrors(errors, name); return; }
  state.data = data;
  state.sceneName = name;
  state.open = new Map((data.portals || []).map(p => [p.id, p.open !== false]));
  state.selectedPath = -1;
  buildSceneGraph(data);
  buildPortalList();
  buildPresetButtons();
  const first = data.cameras && (data.cameras.main ? 'main' : Object.keys(data.cameras)[0]);
  if (first) applyPreset(first);
  state.uiSig = '';
  $('#errorBanner').hidden = true;
}

function applyPreset(name) {
  const p = state.data.cameras[name];
  if (!p) return;
  const c = state.cam;
  c.position = [...p.position];
  const d = [p.target[0] - p.position[0], p.target[1] - p.position[1], p.target[2] - p.position[2]];
  const l = Math.hypot(...d) || 1;
  c.yaw = Math.atan2(d[0], d[2]);
  c.pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / l)));
  c.fov = p.fov; c.near = p.near; c.far = p.far;
  state.activePreset = name;
  refreshPresetButtons();
}

function buildPresetButtons() {
  const box = $('#cameraPresets');
  box.innerHTML = '';
  for (const name of Object.keys(state.data.cameras || {})) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.dataset.name = name;
    b.addEventListener('click', () => applyPreset(name));
    box.appendChild(b);
  }
  refreshPresetButtons();
}

function refreshPresetButtons() {
  document.querySelectorAll('#cameraPresets button').forEach(b => {
    b.classList.toggle('active', b.dataset.name === state.activePreset);
  });
}

function buildPortalList() {
  const box = $('#portalList');
  box.innerHTML = '';
  for (const p of state.data.portals || []) {
    const row = document.createElement('div');
    row.className = 'portal-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.open.get(p.id) !== false;
    cb.addEventListener('change', () => {
      state.open.set(p.id, cb.checked);
      state.uiSig = '';
    });
    const label = document.createElement('label');
    label.textContent = `${p.id} `;
    const rooms = document.createElement('span');
    rooms.className = 'rooms';
    rooms.textContent = `${p.rooms[0]} ↔ ${p.rooms[1]}`;
    label.appendChild(rooms);
    row.append(cb, label);
    const sync = () => row.classList.toggle('closed', !cb.checked);
    cb.addEventListener('change', sync);
    sync();
    box.appendChild(row);
  }
}

async function loadSceneFromUrl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    initScene(await r.json(), url);
  } catch (e) {
    showLoadErrors([`读取失败: ${e.message}（若直接以 file:// 打开，请改用本地 http 服务或“加载 JSON”按钮）`], url);
  }
}

$('#sceneSelect').addEventListener('change', e => loadSceneFromUrl(e.target.value));
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try { initScene(JSON.parse(rd.result), f.name); }
    catch (err) { showLoadErrors([`JSON 解析失败: ${err.message}`], f.name); }
  };
  rd.readAsText(f);
});
$('#modeFull').addEventListener('click', () => setMode('full'));
$('#modeCulled').addEventListener('click', () => setMode('culled'));
function setMode(m) {
  state.mode = m;
  $('#modeFull').classList.toggle('active', m === 'full');
  $('#modeCulled').classList.toggle('active', m === 'culled');
  state.uiSig = '';
}
$('#exportBtn').addEventListener('click', exportReport);

// ---------------- 尺寸 ----------------
function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  setupIdTarget(camera.aspect);
  state.idDirty = true;
}
new ResizeObserver(resize).observe(wrap);

// ---------------- 主循环 ----------------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const target = updateCamera(dt);

  if (state.data) {
    state.traversal = computeTraversal(state.data, id => state.open.get(id) !== false, camSpec(target, camera.aspect));
    const sig = JSON.stringify([
      state.traversal.room, state.traversal.error, state.traversal.candidates,
      state.traversal.paths.length, state.mode, [...state.open.entries()],
      state.cam.position.map(v => +v.toFixed(6)), state.cam.yaw.toFixed(4), state.cam.pitch.toFixed(4),
    ]);
    if (sig !== state.uiSig) {
      state.uiSig = sig;
      updatePanels();
      state.idDirty = true;
    }
    const cand = candidateSet();
    applyVisibility(state.mode === 'culled' && cand !== null ? cand : null);
    if (state.idDirty) {
      state.idDirty = false;
      runIdCompare();
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
loadSceneFromUrl($('#sceneSelect').value);
requestAnimationFrame(frame);

// 调试句柄（控制台可用）
window.__pfi = { state, scene, camera, renderer };
