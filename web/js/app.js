// 分级地形接缝检查器 —— 页面主逻辑（依赖全局 THREE，核心算法来自 terrain.js）
import { solveTerrain, precomputeNodes } from './terrain.js';
import { validateMesh } from './validate.js';
import { exportOBJ, exportLeavesJSON, downloadText } from './exporter.js';

const state = {
  input: null,          // 原始输入
  result: null,         // solveTerrain 结果
  cachedNodes: null,    // 仅依赖高度场的预计算节点，相机/阈值变化时复用
  nodeHeights: null,    // 缓存对应的高度场引用，用于判断是否需要重算
  showWireframe: true,
  showLevelColor: true,
  showSeams: true,
  selectedKey: null,
  rebuildTimer: null,
};

// ---------- Three.js 场景 ----------
let renderer, scene, camera, controls, raycaster, pointer;
let terrainMesh, wireMesh, seamLines, pickMesh;
// 复用的材质（不随每次重建新建，减少 GC 卡顿）
let terrainMat, wireMat, seamMat, pickMat;

function initThree(container) {
  const w = container.clientWidth, h = container.clientHeight;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(getCss('--bg-scene'));

  // 观察相机即 LOD 相机：透视参数取自数据 camera（fovY/near），位置即 LOD 距离源
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000);
  camera.position.set(32, 20, -10);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(32, 2, 32);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.55);
  dir.position.set(60, 120, 40);
  scene.add(dir);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPick);

  window.addEventListener('resize', () => onResize(container));
  // 主题切换（系统或手动 data-theme）时同步 3D 场景背景与线框色
  new MutationObserver(applySceneTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySceneTheme);

  animate();
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#11141a';
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onResize(container) {
  const w = container.clientWidth, h = container.clientHeight;
  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ---------- 层级配色（地貌测绘风、相邻层级色相拉开） ----------
const LEVEL_COLORS = [
  0x2f6fd0, 0x1fa38a, 0x7bb042, 0xe0a92e, 0xe2603a, 0xc73e58, 0x8a4fc9, 0x23a6c4,
];
function levelColor(s, size) {
  const depth = Math.log2(size) - Math.log2(s);
  return LEVEL_COLORS[depth % LEVEL_COLORS.length];
}

function applySceneTheme() {
  if (!renderer) return;
  scene.background = new THREE.Color(getCss('--bg-scene'));
  if (wireMesh) wireMesh.material.color.set(getCss('--wire'));
}

// ---------- 重建网格 ----------
function ensureObjects() {
  if (terrainMesh) return;
  terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
  wireMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 });
  seamMat = new THREE.LineBasicMaterial({ color: 0xffd23b, depthTest: false, transparent: true, opacity: 0.95 });
  pickMat = new THREE.MeshBasicMaterial({ visible: false });
  terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
  wireMesh = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat);
  seamLines = new THREE.LineSegments(new THREE.BufferGeometry(), seamMat);
  pickMesh = new THREE.Mesh(new THREE.BufferGeometry(), pickMat);
  scene.add(terrainMesh, wireMesh, seamLines, pickMesh);
}

function rebuild() {
  const r = state.result;
  if (!r) return;
  ensureObjects();
  const oldGeos = [terrainMesh.geometry, wireMesh.geometry, seamLines.geometry, pickMesh.geometry];

  const { positions, indices, triBlocks, leafList } = r.mesh;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));

  // 层级颜色：按每个三角形所属块给顶点色（triBlocks[t] 为叶子在 leafList 中的序号）
  const size = r.size;
  const colors = new Float32Array(positions.length);
  const tmp = new THREE.Color();
  const blockColor = leafList.map((leaf) => {
    tmp.setHex(levelColor(leaf.s, size));
    return [tmp.r, tmp.g, tmp.b];
  });
  for (let t = 0; t < triBlocks.length; t++) {
    const c = blockColor[triBlocks[t]];
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k];
      colors[vi * 3] = c[0]; colors[vi * 3 + 1] = c[1]; colors[vi * 3 + 2] = c[2];
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();

  // 仅替换 geometry，复用材质与场景对象
  const wireGeo = new THREE.WireframeGeometry(g);
  const seamGeo = buildSeamGeometry(r);
  terrainMesh.geometry = g;
  wireMesh.geometry = wireGeo;
  seamLines.geometry = seamGeo;
  pickMesh.geometry = g; // 与显示共享同一 geometry，不再 clone
  wireMat.color.set(getCss('--wire'));

  oldGeos.forEach((geo) => geo?.dispose?.());

  updateStats();
  buildLegend();
  refreshLayerVisibility();
  if (state.selectedKey) selectBlock(state.selectedKey, true);
}

// 按当前实际出现的层级深度生成图例
function buildLegend() {
  const r = state.result;
  const depths = new Map();
  for (const leaf of r.mesh.leafList) {
    const depth = Math.log2(r.size) - Math.log2(leaf.s);
    depths.set(depth, levelColor(leaf.s, r.size));
  }
  const rows = [...depths.entries()].sort((a, b) => a[0] - b[0]).map(([depth, hex]) => {
    const s = r.size / 2 ** depth;
    const c = '#' + hex.toString(16).padStart(6, '0');
    return `<div class="row"><span class="swatch" style="background:${c}"></span> 深度 ${depth} · 块边长 ${s}</div>`;
  }).join('');
  document.getElementById('levelLegend').innerHTML = rows;
}

// 构造接缝线 geometry：遍历叶子，凡是带细邻居的边（ring 上有中点）就画这条边
function buildSeamGeometry(r) {
  const { leafList } = r.mesh;
  // 用 N×N 单元索引做 O(1) 邻居点查
  const N = r.size;
  const cell = new Array(N * N).fill(null);
  for (const l of leafList) {
    for (let iz = l.z; iz < l.z + l.s; iz++) {
      const b = iz * N;
      for (let ix = l.x; ix < l.x + l.s; ix++) cell[b + ix] = l;
    }
  }
  const leafAtCell = (px, pz) => {
    const ix = Math.floor(px), iz = Math.floor(pz);
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return null;
    return cell[iz * N + ix];
  };
  const pts = [];
  const push = (ax, az, bx, bz) => {
    const H = (x, z) => r.heights[z * (N + 1) + x];
    pts.push(ax, H(ax, az) + 0.15, az, bx, H(bx, bz) + 0.15, bz);
  };
  for (const leaf of leafList) {
    const { x, z, s } = leaf;
    const h = s >> 1;
    const finerSide = (side) => {
      // 与 terrain.js neighborsAlongSide 同逻辑（向邻居侧 eps 探测内部点）
      const eps = 1e-6, q = h / 2;
      for (let t = 0; t < s; t += h) {
        let px, pz;
        if (side === 0) { px = x - eps; pz = z + t + q; }
        else if (side === 1) { px = x + s + eps; pz = z + t + q; }
        else if (side === 2) { px = x + t + q; pz = z - eps; }
        else { px = x + t + q; pz = z + s + eps; }
        const n = leafAtCell(px, pz);
        if (n && n.s === h) return true;
      }
      return false;
    };
    if (finerSide(0)) push(x, z, x, z + s);
    if (finerSide(1)) push(x + s, z, x + s, z + s);
    if (finerSide(2)) push(x, z, x + s, z);
    if (finerSide(3)) push(x, z + s, x + s, z + s);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function leafAt(leavesMap, px, pz) {
  for (const l of leavesMap.values()) {
    if (px >= l.x && px <= l.x + l.s && pz >= l.z && pz <= l.z + l.s) return l;
  }
  return null;
}

function refreshLayerVisibility() {
  if (wireMesh) wireMesh.visible = state.showWireframe;
  if (seamLines) seamLines.visible = state.showSeams;
  if (terrainMesh) {
    terrainMesh.material.vertexColors = state.showLevelColor;
    terrainMesh.material.color.set(state.showLevelColor ? 0xffffff : getCss('--terrain-solid'));
    terrainMesh.material.needsUpdate = true;
  }
}

// ---------- 拾取点块（区分点击与 OrbitControls 拖动） ----------
let downPos = null;
function onPointerDown(ev) {
  downPos = { x: ev.clientX, y: ev.clientY };
}
function onPick(ev) {
  if (!state.result || !pickMesh || !downPos) return;
  const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return; // 是旋转/平移拖动，不选块
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickMesh);
  if (!hits.length) { clearSelection(); return; }
  const p = hits[0].point;
  const gx = Math.round(p.x), gz = Math.round(p.z);
  const leaf = leafAt(new Map(state.result.mesh.leafList.map((l) => [`${l.x},${l.z},${l.s}`, l])), gx, gz);
  if (leaf) selectBlock(`${leaf.x},${leaf.z},${leaf.s}`);
}

let highlightBox = null;
function selectBlock(key, keepIfMissing) {
  const leaf = state.result.leaves.get(key);
  if (!leaf) { if (!keepIfMissing) clearSelection(); return; }
  state.selectedKey = key;
  if (highlightBox) { scene.remove(highlightBox); highlightBox.geometry.dispose(); highlightBox.material.dispose(); }
  const { x, z, s } = leaf;
  const yTop = leaf.hmax + 0.6;
  const box = new THREE.Box3(
    new THREE.Vector3(x, leaf.hmin - 0.2, z),
    new THREE.Vector3(x + s, yTop, z + s));
  highlightBox = new THREE.Box3Helper(box, 0xff5fa8);
  highlightBox.material.depthTest = false;
  highlightBox.renderOrder = 998;
  scene.add(highlightBox);
  showBlockInfo(leaf);
}

function clearSelection() {
  state.selectedKey = null;
  if (highlightBox) { scene.remove(highlightBox); highlightBox.geometry.dispose(); highlightBox.material.dispose(); highlightBox = null; }
  document.getElementById('blockInfo').innerHTML =
    '<p class="muted">点击地形上的任意块，查看误差、距离与拆分原因。</p>';
}

function showBlockInfo(leaf) {
  const reason = state.result.splitReasons.get(`${leaf.x},${leaf.z},${leaf.s}`);
  const sourceText = {
    root: '根块（未拆分）',
    kept: '误差未超阈值，保留',
    error: '误差驱动拆分',
    balance: '邻块平衡强制拆分',
  }[leaf.source] || leaf.source;
  const reasonDetail = reason ? (reason.type === 'error'
    ? `屏幕误差 ${reason.rho.toFixed(3)} > 阈值 ${reason.pixelError}（E=${reason.E.toFixed(4)}，D=${reason.D.toFixed(2)}）`
    : `邻居 (${reason.neighbor.x},${reason.neighbor.z},s=${reason.neighbor.s}) 更细，强制拆分维持层级差≤1`)
    : '该块本身是叶子，没有再拆分';
  const adj = state.result.adjacency.find((a) => a.x === leaf.x && a.z === leaf.z && a.s === leaf.s);
  const nb = (side) => {
    const v = adj.neighbors[side];
    if (!v) return '域外';
    if (v.length === 1) return `同级 s=${v[0].s}`;
    return `更细 ×2（s=${v[0].s}）`;
  };
  document.getElementById('blockInfo').innerHTML = `
    <dl class="info">
      <dt>块坐标 (x, z, size)</dt><dd>(${leaf.x}, ${leaf.z}, ${leaf.s})</dd>
      <dt>块误差 E</dt><dd>${leaf.E.toFixed(5)}</dd>
      <dt>相机 AABB 距离 D</dt><dd>${leaf.D.toFixed(3)}</dd>
      <dt>屏幕误差 ρ</dt><dd>${leaf.rho.toFixed(4)} <span class="muted">/ 阈值 ${state.result.pixelError}</span></dd>
      <dt>高度范围</dt><dd>[${leaf.hmin.toFixed(2)}, ${leaf.hmax.toFixed(2)}]</dd>
      <dt>拆分来源</dt><dd><span class="pill src-${leaf.source}">${sourceText}</span></dd>
      <dt>拆分原因</dt><dd>${reasonDetail}</dd>
      <dt>四邻</dt><dd class="nb">
        <span>左(-x): ${nb(0)}</span><span>右(+x): ${nb(1)}</span>
        <span>上(-z): ${nb(2)}</span><span>下(+z): ${nb(3)}</span></dd>
    </dl>`;
}

// ---------- 统计与校验状态 ----------
function updateStats() {
  const r = state.result;
  const rep = validateMesh(r);
  state.lastReport = rep;
  const k = rep.stats.edgeKinds;
  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${rep.stats.leaves}</b><span>叶块</span></div>
    <div class="stat"><b>${rep.stats.triangles}</b><span>三角形</span></div>
    <div class="stat"><b>${rep.stats.vertices}</b><span>焊接顶点</span></div>
    <div class="stat"><b>${k.internal}</b><span>内部边</span></div>
    <div class="stat"><b>${k.boundary}</b><span>边界边</span></div>
    <div class="stat"><b>${k.hanging}</b><span>悬挂边</span></div>`;
  const ok = document.getElementById('validity');
  ok.className = 'validity ' + (rep.ok ? 'ok' : 'bad');
  ok.textContent = rep.ok
    ? `✓ 网格合法：无悬挂边 / 重叠面 / 退化面，层级差处处 ≤ 1`
    : `✗ ${rep.problems.length} 个问题：` + rep.problems.slice(0, 2).join('；');
}

// ---------- 重新求解（相机/阈值变化） ----------
function solve() {
  if (!state.input) return;
  // 高度场不变时复用预计算节点（块误差 E、AABB 不随相机/阈值变化）
  if (state.nodeHeights !== state.input.heights) {
    state.cachedNodes = precomputeNodes(state.input.size, state.input.heights);
    state.nodeHeights = state.input.heights;
  }
  const t0 = performance.now();
  state.result = solveTerrain(state.input, state.cachedNodes);
  state.lastSolveMs = performance.now() - t0;
  const t1 = performance.now();
  rebuild();
  state.lastRebuildMs = performance.now() - t1;
}

function scheduleSolve() {
  clearTimeout(state.rebuildTimer);
  state.rebuildTimer = setTimeout(solve, 40);
}

// ---------- 加载样例 / 文件 ----------
const SAMPLES = ['flat.json', 'peak.json', 'ridge.json', 'capacity.json'];

async function loadSample(name) {
  const res = await fetch(`data/${name}`);
  if (!res.ok) throw new Error(`样例 ${name} 加载失败`);
  return res.json();
}

function applyInput(input) {
  state.input = input;
  // 观察相机即 LOD 相机：透视参数与位置都取自数据
  camera.fov = input.camera.fovY;
  camera.near = input.camera.near;
  camera.updateProjectionMatrix();
  const [cx, cy, cz] = input.camera.position;
  camera.position.set(cx, cy, cz);
  controls.target.set(input.size / 2, 1, input.size / 2);
  controls.update();
  solve();
  clearSelection();
  syncCameraInputs();
}

// ---------- UI 绑定 ----------
function bindUI() {
  // 样例按钮
  document.getElementById('samples').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-sample]');
    if (!btn) return;
    setError(null);
    try {
      const input = await loadSample(btn.dataset.sample);
      applyInput(input);
      document.querySelectorAll('#samples button').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('pixelError').value = input.pixelError;
      document.getElementById('peVal').textContent = input.pixelError;
      syncCameraInputs();
    } catch (err) { setError(err.message); }
  });

  // 文件上传
  document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError(null);
    try {
      const input = JSON.parse(await file.text());
      // 用核心校验先拦截
      const probe = solveTerrain(input);
      if (probe.error) { setError('输入无效：' + probe.error); return; }
      applyInput(input);
      document.getElementById('pixelError').value = input.pixelError;
      document.getElementById('peVal').textContent = input.pixelError;
      syncCameraInputs();
    } catch (err) { setError('JSON 解析失败：' + err.message); }
  });

  // 像素误差
  const pe = document.getElementById('pixelError');
  pe.addEventListener('input', () => {
    document.getElementById('peVal').textContent = pe.value;
    if (!state.input) return;
    state.input.pixelError = Number(pe.value);
    scheduleSolve();
  });

  // 显示开关
  for (const [id, key] of [['togWire', 'showWireframe'], ['togLevel', 'showLevelColor'], ['togSeam', 'showSeams']]) {
    document.getElementById(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      refreshLayerVisibility();
    });
  }

  // 相机拖动 -> 相机位置即 LOD 距离源，实时重算
  controls.addEventListener('change', () => {
    if (!state.input) return;
    state.input.camera.position = [camera.position.x, camera.position.y, camera.position.z];
    syncCameraInputs();
    scheduleSolve();
  });

  // 相机坐标手动输入：写回相机位置并保持观察目标
  for (const ax of ['x', 'y', 'z']) {
    document.getElementById('cam' + ax.toUpperCase()).addEventListener('input', () => {
      if (!state.input) return;
      const v = Number(document.getElementById('cam' + ax.toUpperCase()).value);
      if (!Number.isFinite(v)) return;
      state.input.camera.position[({ x: 0, y: 1, z: 2 })[ax]] = v;
      camera.position.set(...state.input.camera.position);
      scheduleSolve();
    });
  }

  // 导出
  document.getElementById('exportObj').addEventListener('click', () => {
    if (!state.result) return;
    downloadText('terrain-lod.obj', exportOBJ(state.result), 'text/plain');
  });
  document.getElementById('exportJson').addEventListener('click', () => {
    if (!state.result) return;
    downloadText('terrain-leaves.json', JSON.stringify(exportLeavesJSON(state.result), null, 1), 'application/json');
  });
}

function syncCameraInputs() {
  if (!state.input) return;
  const [x, y, z] = state.input.camera.position;
  document.getElementById('camX').value = x.toFixed(1);
  document.getElementById('camY').value = y.toFixed(1);
  document.getElementById('camZ').value = z.toFixed(1);
}

function setError(msg) {
  const el = document.getElementById('errorBar');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// ---------- 启动 ----------
async function main() {
  initThree(document.getElementById('viewport'));
  bindUI();
  try {
    const input = await loadSample('ridge.json');
    applyInput(input);
    document.querySelector('#samples button[data-sample="ridge.json"]')?.classList.add('active');
    document.getElementById('pixelError').value = input.pixelError;
    document.getElementById('peVal').textContent = input.pixelError;
    syncCameraInputs();
  } catch (err) {
    setError('初始样例加载失败：' + err.message);
  }
}

// 调试/性能探针（页面内部状态，便于检查，不影响功能）
window.__terrainState = state;

main();
