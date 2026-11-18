// 单文件 artifact 版应用逻辑（UMD 全局 THREE；核心算法由构建脚本内联，与 src/lib 同源）
import {
  analyzeMesh,
  HeatSolver,
  compareFields,
  extractIsolines,
  parseMeshText,
  ParseError,
  fieldColors,
  turboCss,
  buildDistanceExport,
  buildIsolineExport,
  buildDiagnosticExport,
} from './bundled-core.js';

const HM = { analyzeMesh, HeatSolver, compareFields, extractIsolines, parseMeshText, ParseError, fieldColors, turboCss, buildDistanceExport, buildIsolineExport, buildDiagnosticExport };
window.HM = HM;

const state = { analysis: null, solver: null, result: null, sources: [], tau: 1, isoSpacing: 1, meshB: null, comparison: null };

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
function syncSceneBackground() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) scene.background = new THREE.Color(bg);
}
syncSceneBackground();
new MutationObserver(syncSceneBackground).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const media = window.matchMedia('(prefers-color-scheme: dark)');
media.addEventListener?.('change', syncSceneBackground);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(6, -8, 6);
const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.78));
const key = new THREE.DirectionalLight(0xffffff, 1.35);
key.position.set(5, 5, 8);
scene.add(key);

let surfaceMesh = null, unreachableMesh = null, wireMesh = null, isoGroup = null, markerGroup = null, pickPoints = null;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

function frameGeometry(analysis) {
  const box = new THREE.Box3();
  for (const p of analysis.positions) box.expandByPoint(new THREE.Vector3(...p));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  controls.target.copy(center);
  const r = Math.max(size.x, size.y, size.z);
  camera.position.copy(center).add(new THREE.Vector3(r * 0.9, -r * 1.1, r * 0.7));
  camera.near = Math.max(0.001, r / 1000);
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  controls.update();
  const scale = Math.max(r, 0.05) * 0.03;
  raycaster.params.Points.threshold = scale;
  pickPoints.material.size = scale * 0.8;
}

function buildThreeMesh(analysis) {
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(analysis.nV * 3);
  analysis.positions.forEach((p, i) => pos.set(p, i * 3));
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setIndex(analysis.validFaces.flatMap((fi) => analysis.triangles[fi]));
  geom.computeVertexNormals();
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(analysis.nV * 3).fill(0.6), 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05, flatShading: true,
  }));
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 })
  );
  const picks = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
    new THREE.PointsMaterial({ size: 0.18, sizeAttenuation: true, color: 0xffffff })
  );
  picks.visible = false;
  return { mesh, wire, picks };
}

function loadMeshIntoScene(analysis) {
  if (surfaceMesh) {
    scene.remove(surfaceMesh, wireMesh, pickPoints);
    surfaceMesh.geometry.dispose(); wireMesh.geometry.dispose(); pickPoints.geometry.dispose();
  }
  if (unreachableMesh) { scene.remove(unreachableMesh); unreachableMesh.geometry.dispose(); unreachableMesh = null; }
  if (isoGroup) { scene.remove(isoGroup); isoGroup = null; }
  if (markerGroup) { scene.remove(markerGroup); markerGroup = null; }
  const built = buildThreeMesh(analysis);
  surfaceMesh = built.mesh; wireMesh = built.wire; pickPoints = built.picks;
  scene.add(surfaceMesh, wireMesh, pickPoints);
  markerGroup = new THREE.Group(); scene.add(markerGroup);
  isoGroup = new THREE.Group(); scene.add(isoGroup);
  frameGeometry(analysis);
  document.getElementById('emptyHint').classList.add('hidden');
  tooltip.classList.add('hidden');
}

function rebuildUnreachableMesh() {
  if (unreachableMesh) { scene.remove(unreachableMesh); unreachableMesh.geometry.dispose(); unreachableMesh = null; }
  if (!state.result) return;
  const an = state.analysis;
  const nullFaces = an.validFaces.filter((fi) => an.triangles[fi].some((v) => state.result.distances[v] === null));
  if (!nullFaces.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', surfaceMesh.geometry.attributes.position);
  g.setIndex(nullFaces.flatMap((fi) => an.triangles[fi]));
  g.computeVertexNormals();
  unreachableMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x8a8f9c, side: THREE.DoubleSide, roughness: 0.9, flatShading: true,
  }));
  scene.add(unreachableMesh);
}

function runSolve() {
  if (!state.solver || state.sources.length === 0) return;
  state.result = state.solver.solve(state.sources, state.tau);
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(fieldColors(state.result.distances, state.result.maxDistance), 3));
  rebuildUnreachableMesh();
  updateMarkers();
  rebuildIsolines();
  renderDiagnostics();
  enableExport(true);
  document.getElementById('legend').classList.remove('hidden');
  document.getElementById('legendMax').textContent = state.result.maxDistance.toFixed(3);
  if (state.meshB) state.meshB.result = state.meshB.solver.solve(state.sources, state.tau);
}

function updateMarkers() {
  markerGroup.clear();
  const pos = surfaceMesh.geometry.attributes.position;
  for (const v of state.sources) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(pos.getX(v), pos.getY(v), pos.getZ(v));
    markerGroup.add(m);
  }
}

function rebuildIsolines() {
  isoGroup.clear();
  if (!document.getElementById('isoToggle').checked) return;
  const segments = HM.extractIsolines(state.result, state.analysis, state.isoSpacing);
  const arr = new Float32Array(segments.length * 6);
  segments.forEach((s, i) => { arr.set(s.a, i * 6); arr.set(s.b, i * 6 + 3); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  isoGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x14161c, transparent: true, opacity: 0.9 })));
}

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.22;
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');

canvas.addEventListener('pointermove', (e) => {
  if (!surfaceMesh) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPoints, false);
  if (hits.length) { showTooltip(e, hits[0].index); canvas.style.cursor = 'pointer'; }
  else { tooltip.classList.add('hidden'); canvas.style.cursor = 'default'; }
});
canvas.addEventListener('pointerleave', () => tooltip.classList.add('hidden'));

function showTooltip(e, v) {
  const an = state.analysis, p = an.positions[v];
  let dTxt;
  if (!state.result) dTxt = '尚未求解';
  else if (state.result.distances[v] === null) dTxt = '<span class="null">不可达（该分量无源点）</span>';
  else dTxt = `<b>${state.result.distances[v].toFixed(5)}</b>`;
  tooltip.innerHTML = `顶点 <b>#${v}</b>${state.sources.includes(v) ? ' · <b>源点</b>' : ''}<br/>坐标 (${p.map((c) => c.toFixed(3)).join(', ')})<br/>表面距离：${dTxt}`;
  tooltip.style.left = `${e.offsetX + 14}px`;
  tooltip.style.top = `${e.offsetY + 14}px`;
  tooltip.classList.remove('hidden');
}

function selectSource(v) {
  const multi = document.getElementById('multiMode').checked;
  if (multi) { if (!state.sources.includes(v)) state.sources.push(v); }
  else state.sources = [v];
  document.getElementById('sourceList').textContent = `源点：[${state.sources.join(', ')}]`;
  runSolve();
}
window.__pickIsolated = (v) => selectSource(v);

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !surfaceMesh) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPoints, false);
  if (hits.length) selectSource(hits[0].index);
});

async function readMeshFile(file) { return HM.parseMeshText(await file.text(), file.name); }

function applyLoadedMesh(parsed, name) {
  let analysis;
  try { analysis = HM.analyzeMesh(parsed.positions, parsed.triangles); }
  catch (err) { showReject(err.message); return null; }
  state.analysis = analysis;
  state.solver = new HeatSolver(analysis);
  state.sources = parsed.sources.length ? parsed.sources.slice(0, 1) : [];
  state.tau = Math.min(10, Math.max(0.1, parsed.tau || 1));
  document.getElementById('tauSlider').value = state.tau;
  document.getElementById('tauVal').textContent = Number(state.tau).toFixed(2);
  state.result = null; state.meshB = null; state.comparison = null;
  document.getElementById('meshBInfo').textContent = '';
  document.getElementById('compareResult').innerHTML = '';
  document.getElementById('compareBtn').disabled = true;
  document.getElementById('clearCompareBtn').disabled = true;
  loadMeshIntoScene(analysis);
  renderMeshInfo(name, analysis);
  renderExcluded(analysis);
  enableExport(false);
  document.getElementById('diagBox').textContent = '网格已就绪，点击顶点选择源点后求解。';
  if (state.sources.length) {
    document.getElementById('sourceList').textContent = `源点：[${state.sources.join(', ')}]`;
    runSolve();
  } else document.getElementById('sourceList').textContent = '';
  return analysis;
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { applyLoadedMesh(await readMeshFile(file), file.name); }
  catch (err) { showReject(err instanceof HM.ParseError ? err.message : `读取失败：${err.message}`); }
  e.target.value = '';
});

document.getElementById('fileInputB').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = await readMeshFile(file);
    let analysisB;
    try { analysisB = HM.analyzeMesh(parsed.positions, parsed.triangles); }
    catch (err) { document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`; return; }
    if (state.analysis && (analysisB.nV !== state.analysis.nV || JSON.stringify(analysisB.triangles) !== JSON.stringify(state.analysis.triangles))) {
      document.getElementById('meshBInfo').innerHTML = '<span class="bad">与主网格拓扑不一致，无法对比</span>';
      state.meshB = null; document.getElementById('compareBtn').disabled = true; return;
    }
    const solverB = new HeatSolver(analysisB);
    const resultB = state.sources.length ? solverB.solve(state.sources, state.tau) : null;
    state.meshB = { name: file.name, analysis: analysisB, solver: solverB, result: resultB };
    document.getElementById('meshBInfo').innerHTML = `<b>${file.name}</b><br/>${analysisB.nV} 顶点 / ${analysisB.validFaces.length} 有效面`;
    document.getElementById('compareBtn').disabled = !(state.result && resultB);
    document.getElementById('clearCompareBtn').disabled = false;
  } catch (err) {
    document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`;
  }
  e.target.value = '';
});

document.getElementById('loadSampleBtn').addEventListener('click', () => {
  const positions = [], triangles = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) positions.push([x - 4, y - 4, 0]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = y * 9 + x;
    triangles.push([a, a + 1, a + 9], [a + 1, a + 10, a + 9]);
  }
  applyLoadedMesh({ positions, triangles, sources: [40], tau: 1 }, '内置平面样例');
});

document.getElementById('compareBtn').addEventListener('click', () => {
  if (!state.meshB || !state.result || !state.meshB.result) return;
  const cmp = HM.compareFields(state.result, state.meshB.result, state.analysis, state.meshB.analysis);
  state.comparison = cmp;
  const maxDiff = Math.max(cmp.maxAbsDifference, 1e-12);
  const colors = new Float32Array(state.analysis.nV * 3);
  for (let i = 0; i < state.analysis.nV; i++) {
    if (cmp.perVertexDifference[i] === null) colors.set([0.54, 0.56, 0.61], i * 3);
    else { const m = HM.turboCss(cmp.perVertexDifference[i] / maxDiff).match(/\d+/g).map(Number); colors.set([m[0] / 255, m[1] / 255, m[2] / 255], i * 3); }
  }
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  document.getElementById('compareResult').innerHTML =
    `<b>${state.meshB.name}</b> 对比：<br/>最大绝对差异：<b>${cmp.maxAbsDifference.toExponential(3)}</b><br/>平均绝对差异：${cmp.meanAbsDifference.toExponential(3)}<br/>均方根差异：${cmp.rmsDifference.toExponential(3)}<br/>可达性不一致顶点：${cmp.mismatchedReachability}<br/><small>当前着色为逐顶点差异（归一化）</small>`;
});

document.getElementById('clearCompareBtn').addEventListener('click', () => {
  state.meshB = null; state.comparison = null;
  document.getElementById('meshBInfo').textContent = '';
  document.getElementById('compareResult').innerHTML = '';
  document.getElementById('compareBtn').disabled = true;
  document.getElementById('clearCompareBtn').disabled = true;
  document.getElementById('fileInputB').value = '';
  if (state.result) surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(HM.fieldColors(state.result.distances, state.result.maxDistance), 3));
});

document.getElementById('tauSlider').addEventListener('input', (e) => {
  state.tau = Number(e.target.value);
  document.getElementById('tauVal').textContent = state.tau.toFixed(2);
  if (state.sources.length) runSolve();
});
document.getElementById('isoSlider').addEventListener('input', (e) => {
  state.isoSpacing = Number(e.target.value);
  document.getElementById('isoVal').textContent = state.isoSpacing.toFixed(2);
  if (state.result) rebuildIsolines();
});
document.getElementById('isoToggle').addEventListener('change', (e) => {
  if (isoGroup) isoGroup.visible = e.target.checked;
  if (e.target.checked && state.result) rebuildIsolines();
});
document.getElementById('meshToggle').addEventListener('change', (e) => { wireMesh.visible = e.target.checked; });
document.getElementById('clearSourcesBtn').addEventListener('click', () => {
  state.sources = [];
  document.getElementById('sourceList').textContent = '';
  markerGroup.clear();
});

// 导出：沙箱下载失效，改为模态预览 + 复制
function showExportModal(title, obj) {
  const text = JSON.stringify(obj, null, 2);
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').value = text;
  document.getElementById('modal').classList.remove('hidden');
}
document.getElementById('exportDistBtn').addEventListener('click', () =>
  showExportModal('顶点距离 JSON（可全选复制保存）', HM.buildDistanceExport(state.analysis, state.result)));
document.getElementById('exportIsoBtn').addEventListener('click', () =>
  showExportModal('等值线段 JSON（可全选复制保存）', HM.buildIsolineExport(state.analysis, state.result, state.isoSpacing)));
document.getElementById('exportDiagBtn').addEventListener('click', () => {
  const segs = HM.extractIsolines(state.result, state.analysis, state.isoSpacing);
  showExportModal('计算诊断 JSON（可全选复制保存）', HM.buildDiagnosticExport(state.analysis, state.result, state.isoSpacing, segs));
});
document.getElementById('copyBtn').addEventListener('click', async () => {
  const ta = document.getElementById('modalText');
  try { await navigator.clipboard.writeText(ta.value); document.getElementById('copyBtn').textContent = '已复制 ✓'; }
  catch { ta.select(); document.getElementById('copyBtn').textContent = '请手动 Ctrl+C 复制'; }
  setTimeout(() => { document.getElementById('copyBtn').textContent = '复制到剪贴板'; }, 1800);
});
document.getElementById('closeModal').addEventListener('click', () => document.getElementById('modal').classList.add('hidden'));

function showReject(msg) {
  const el = document.getElementById('rejectMsg');
  el.textContent = `导入被拒绝：${msg}`;
  el.classList.remove('hidden');
}
function renderMeshInfo(name, an) {
  document.getElementById('rejectMsg').classList.add('hidden');
  document.getElementById('meshInfo').innerHTML =
    `<b>${name}</b><br/>顶点 <b>${an.nV}</b> · 总面 <b>${an.nF}</b> · 有效面 <b>${an.validFaces.length}</b><br/>连通分量 <b>${an.components.length}</b>（含孤立点 ${an.components.filter((c) => c.isolated).length}）`;
}
function renderExcluded(an) {
  const box = document.getElementById('excludedBox');
  if (an.excludedFaces.length) {
    box.classList.remove('hidden');
    document.getElementById('excludedCount').textContent = an.excludedFaces.length;
    document.getElementById('excludedList').innerHTML = an.excludedFaces.map((f) => `<li>面 #${f.face} [${f.indices.join(', ')}]：${f.reason}</li>`).join('');
  } else box.classList.add('hidden');
  const ob = document.getElementById('obtuseBox');
  if (an.obtuseFaces.length || an.boundaryEdges.length) {
    ob.classList.remove('hidden');
    document.getElementById('obtuseCount').textContent = an.obtuseFaces.length;
    document.getElementById('boundaryCount').textContent = an.boundaryEdges.length;
  } else ob.classList.add('hidden');
}
function enableExport(on) {
  for (const id of ['exportDistBtn', 'exportIsoBtn', 'exportDiagBtn']) document.getElementById(id).disabled = !on;
}
function renderDiagnostics() {
  const r = state.result;
  const rows = r.componentDiagnostics.map((c) => {
    if (c.isolated) return `<tr><td>分量 ${c.component}（孤立点）</td><td>${c.sourced ? '源点→0' : 'null'}</td><td>—</td><td>—</td></tr>`;
    if (!c.sourced) return `<tr><td>分量 ${c.component}</td><td class="bad">不可达</td><td>—</td><td>—</td></tr>`;
    const cls = (x) => (x < 1e-8 ? 'good' : 'bad');
    return `<tr><td>分量 ${c.component}（${c.faceCount} 面）</td><td>已求解</td><td class="${cls(c.heat.relativeResidual)}">${c.heat.relativeResidual.toExponential(2)}</td><td class="${cls(c.poisson.relativeResidual)}">${c.poisson.relativeResidual.toExponential(2)}</td></tr>`;
  }).join('');
  document.getElementById('diagBox').innerHTML =
    `求解耗时 ${r.solveMs.toFixed(1)} ms · 不可达顶点 <b id="unreachableCount">${r.unreachableCount}</b> · 最大距离 <b>${r.maxDistance.toFixed(4)}</b><br/>` +
    `缓存：热分解 命中 ${r.cacheStats.heat.hits}/未命中 ${r.cacheStats.heat.misses}，Poisson 命中 ${r.cacheStats.poisson.hits}/未命中 ${r.cacheStats.poisson.misses}` +
    `<table><thead><tr><th>分量</th><th>状态</th><th>热方程残差</th><th>Poisson 残差</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
resize();
animate();
