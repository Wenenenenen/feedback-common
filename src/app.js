// 热方法曲面测距台 —— 界面与渲染逻辑
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeMesh, HeatSolver, compareFields } from './lib/heat-method.js';
import { parseMeshText, ParseError } from './lib/parsers.js';
import { fieldColors, turboCss } from './lib/colormap.js';
import {
  buildDistanceExport,
  buildIsolineExport,
  buildDiagnosticExport,
  downloadJSON,
} from './lib/export.js';
import { extractIsolines } from './lib/heat-method.js';

// ---------- 全局状态 ----------
const state = {
  analysis: null,
  solver: null,
  result: null,
  sources: [],
  tau: 1,
  isoSpacing: 1,
  meshB: null, // { analysis, solver, result, name }
  comparison: null,
};

// ---------- Three.js 场景 ----------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
function syncSceneBackground() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) scene.background = new THREE.Color(bg);
}
syncSceneBackground();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(6, -8, 6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const ambient = new THREE.AmbientLight(0xffffff, 0.75);
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(5, 5, 8);
scene.add(ambient, key);

let surfaceMesh = null;
let unreachableMesh = null;
let wireMesh = null;
let isoGroup = null;
let markerGroup = null;
let pickPoints = null;

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
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
  // 拾取阈值与点大小按模型尺度缩放，保证孤立顶点也能点中
  const scale = Math.max(r, 0.05) * 0.03;
  raycaster.params.Points.threshold = scale;
  pickPoints.material.size = scale * 0.8;
}

function buildThreeMesh(analysis) {
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(analysis.nV * 3);
  analysis.positions.forEach((p, i) => pos.set(p, i * 3));
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx = [];
  for (const fi of analysis.validFaces) idx.push(...analysis.triangles[fi]);
  geom.setIndex(idx);
  geom.computeVertexNormals();

  const colors = new Float32Array(analysis.nV * 3).fill(0.6);
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.75,
    metalness: 0.05,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geom, mat);

  // 网格线
  const wireGeom = new THREE.WireframeGeometry(geom);
  const wire = new THREE.LineSegments(
    wireGeom,
    new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 })
  );

  // 顶点拾取点（覆盖全部顶点，含不属于任何有效面的孤立顶点）
  const pickGeom = new THREE.BufferGeometry();
  pickGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const picks = new THREE.Points(
    pickGeom,
    new THREE.PointsMaterial({ size: 0.18, sizeAttenuation: true, color: 0xffffff })
  );
  picks.visible = false;
  return { mesh, wire, picks };
}

function loadMeshIntoScene(analysis) {
  if (surfaceMesh) {
    scene.remove(surfaceMesh, wireMesh, pickPoints);
    surfaceMesh.geometry.dispose();
    wireMesh.geometry.dispose();
    pickPoints.geometry.dispose();
  }
  if (unreachableMesh) {
    scene.remove(unreachableMesh);
    unreachableMesh.geometry.dispose();
    unreachableMesh = null;
  }
  if (isoGroup) {
    scene.remove(isoGroup);
    isoGroup = null;
  }
  if (markerGroup) {
    scene.remove(markerGroup);
    markerGroup = null;
  }
  const built = buildThreeMesh(analysis);
  surfaceMesh = built.mesh;
  wireMesh = built.wire;
  pickPoints = built.picks;
  scene.add(surfaceMesh, wireMesh, pickPoints);
  markerGroup = new THREE.Group();
  scene.add(markerGroup);
  isoGroup = new THREE.Group();
  scene.add(isoGroup);
  frameGeometry(analysis);
  document.getElementById('emptyHint').classList.add('hidden');
  tooltip.classList.add('hidden');
}

/** 把不可达分量的面切换为独立灰色材质（在 solve 后按 null 距离重建） */
function rebuildUnreachableMesh() {
  if (unreachableMesh) {
    scene.remove(unreachableMesh);
    unreachableMesh.geometry.dispose();
    unreachableMesh = null;
  }
  if (!state.result) return;
  const an = state.analysis;
  const nullFaces = an.validFaces.filter((fi) =>
    an.triangles[fi].some((v) => state.result.distances[v] === null)
  );
  if (!nullFaces.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', surfaceMesh.geometry.attributes.position);
  g.setIndex(nullFaces.flatMap((fi) => an.triangles[fi]));
  g.computeVertexNormals();
  unreachableMesh = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({
      color: 0x787880,
      side: THREE.DoubleSide,
      roughness: 0.9,
      flatShading: true,
    })
  );
  scene.add(unreachableMesh);
}

// ---------- 求解与可视化联动 ----------
function runSolve() {
  if (!state.solver || state.sources.length === 0) return;
  state.result = state.solver.solve(state.sources, state.tau);
  applyFieldColors();
  rebuildUnreachableMesh();
  updateMarkers();
  rebuildIsolines();
  renderDiagnostics();
  enableExport(true);
  document.getElementById('legend').classList.remove('hidden');
  document.getElementById('legendMax').textContent = state.result.maxDistance.toFixed(3);
  // 若第二网格已载入，自动同步源点重算以便对比
  if (state.meshB) {
    state.meshB.result = state.meshB.solver.solve(state.sources, state.tau);
  }
}

function applyFieldColors() {
  const colors = fieldColors(state.result.distances, state.result.maxDistance);
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function updateMarkers() {
  markerGroup.clear();
  const pos = surfaceMesh.geometry.attributes.position;
  for (const v of state.sources) {
    const g = new THREE.SphereGeometry(0.12, 16, 16);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(pos.getX(v), pos.getY(v), pos.getZ(v));
    markerGroup.add(m);
  }
}

function rebuildIsolines() {
  isoGroup.clear();
  if (!document.getElementById('isoToggle').checked) return;
  const segments = extractIsolines(state.result, state.analysis, state.isoSpacing);
  const arr = new Float32Array(segments.length * 6);
  segments.forEach((s, i) => {
    arr.set(s.a, i * 6);
    arr.set(s.b, i * 6 + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const lines = new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.9 })
  );
  isoGroup.add(lines);
}

// ---------- 顶点拾取 ----------
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
  if (hits.length) {
    const v = hits[0].index;
    showTooltip(e, v);
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.classList.add('hidden');
    canvas.style.cursor = 'default';
  }
});
canvas.addEventListener('pointerleave', () => tooltip.classList.add('hidden'));

function showTooltip(e, v) {
  const an = state.analysis;
  const p = an.positions[v];
  let dTxt;
  if (!state.result) dTxt = '尚未求解';
  else if (state.result.distances[v] === null) dTxt = '<span class="null">不可达（该分量无源点）</span>';
  else dTxt = `<b>${state.result.distances[v].toFixed(5)}</b>`;
  const isSource = state.sources.includes(v);
  tooltip.innerHTML = `
    顶点 <b>#${v}</b>${isSource ? ' · <b>源点</b>' : ''}<br/>
    坐标 (${p.map((c) => c.toFixed(3)).join(', ')})<br/>
    表面距离：${dTxt}`;
  tooltip.style.left = `${e.offsetX + 14}px`;
  tooltip.style.top = `${e.offsetY + 14}px`;
  tooltip.classList.remove('hidden');
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !surfaceMesh) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(pickPoints, false);
  if (!hits.length) return;
  selectSource(hits[0].index);
});

/** 选定（或多源模式下追加）一个源顶点并求解 */
function selectSource(v) {
  const multi = document.getElementById('multiMode').checked;
  if (multi) {
    if (!state.sources.includes(v)) state.sources.push(v);
  } else {
    state.sources = [v];
  }
  document.getElementById('sourceList').textContent = `源点：[${state.sources.join(', ')}]`;
  runSolve();
}
// 测试钩子：按索引直接选源（孤立顶点在屏幕上难以点中时也能验证）
window.__pickIsolated = (v) => selectSource(v);

// ---------- 文件导入 ----------
async function readMeshFile(file) {
  const text = await file.text();
  return parseMeshText(text, file.name);
}

function applyLoadedMesh(parsed, name, isB = false) {
  let analysis;
  try {
    analysis = analyzeMesh(parsed.positions, parsed.triangles);
  } catch (err) {
    if (isB) {
      document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`;
    } else {
      showReject(err.message);
    }
    return null;
  }
  if (!isB) {
    state.analysis = analysis;
    state.solver = new HeatSolver(analysis);
    state.sources = parsed.sources.length ? parsed.sources.slice(0, 1) : [];
    state.tau = Math.min(10, Math.max(0.1, parsed.tau || 1));
    document.getElementById('tauSlider').value = state.tau;
    document.getElementById('tauVal').textContent = Number(state.tau).toFixed(2);
    state.result = null;
    state.meshB = null;
    state.comparison = null;
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
    } else {
      document.getElementById('sourceList').textContent = '';
    }
  }
  return analysis;
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = await readMeshFile(file);
    applyLoadedMesh(parsed, file.name, false);
  } catch (err) {
    showReject(err instanceof ParseError ? err.message : `读取失败：${err.message}`);
  }
  e.target.value = '';
});

document.getElementById('fileInputB').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = await readMeshFile(file);
    let analysisB;
    try {
      analysisB = analyzeMesh(parsed.positions, parsed.triangles);
    } catch (err) {
      document.getElementById('meshBInfo').innerHTML = `<span class="bad">${err.message}</span>`;
      return;
    }
    if (state.analysis && (analysisB.nV !== state.analysis.nV ||
      JSON.stringify(analysisB.triangles) !== JSON.stringify(state.analysis.triangles))) {
      document.getElementById('meshBInfo').innerHTML =
        '<span class="bad">与主网格拓扑不一致（顶点数或连接关系不同），无法对比</span>';
      state.meshB = null;
      document.getElementById('compareBtn').disabled = true;
      return;
    }
    const solverB = new HeatSolver(analysisB);
    const resultB = state.sources.length ? solverB.solve(state.sources, state.tau) : null;
    state.meshB = { name: file.name, analysis: analysisB, solver: solverB, result: resultB };
    document.getElementById('meshBInfo').innerHTML =
      `<b>${file.name}</b><br/>${analysisB.nV} 顶点 / ${analysisB.validFaces.length} 有效面`;
    document.getElementById('compareBtn').disabled = !(state.result && resultB);
    document.getElementById('clearCompareBtn').disabled = false;
  } catch (err) {
    document.getElementById('meshBInfo').innerHTML =
      `<span class="bad">${err instanceof ParseError ? err.message : err.message}</span>`;
  }
  e.target.value = '';
});

// ---------- 内置样例（9x9 平面，与 samples/flat.json 同构） ----------
document.getElementById('loadSampleBtn').addEventListener('click', () => {
  const positions = [];
  const triangles = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) positions.push([x - 4, y - 4, 0]);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = y * 9 + x;
      triangles.push([a, a + 1, a + 9]);
      triangles.push([a + 1, a + 10, a + 9]);
    }
  }
  applyLoadedMesh({ positions, triangles, sources: [40], tau: 1 }, '内置平面样例', false);
});

// ---------- 对比 ----------
document.getElementById('compareBtn').addEventListener('click', () => {
  if (!state.meshB || !state.result || !state.meshB.result) return;
  const cmp = compareFields(state.result, state.meshB.result, state.analysis, state.meshB.analysis);
  state.comparison = cmp;
  // 把逐顶点差异作为新的颜色场显示
  const maxDiff = Math.max(cmp.maxAbsDifference, 1e-12);
  const colors = new Float32Array(state.analysis.nV * 3);
  for (let i = 0; i < state.analysis.nV; i++) {
    if (cmp.perVertexDifference[i] === null) {
      colors.set([0.47, 0.47, 0.5], i * 3);
    } else {
      const c = turboCss(cmp.perVertexDifference[i] / maxDiff);
      const m = c.match(/\d+/g).map(Number);
      colors.set([m[0] / 255, m[1] / 255, m[2] / 255], i * 3);
    }
  }
  surfaceMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  document.getElementById('compareResult').innerHTML = `
    <b>${state.meshB.name}</b> 对比：<br/>
    最大绝对差异：<b>${cmp.maxAbsDifference.toExponential(3)}</b><br/>
    平均绝对差异：${cmp.meanAbsDifference.toExponential(3)}<br/>
    均方根差异：${cmp.rmsDifference.toExponential(3)}<br/>
    可达性不一致顶点：${cmp.mismatchedReachability}<br/>
    <small>当前着色为逐顶点差异（归一化）</small>`;
});

document.getElementById('clearCompareBtn').addEventListener('click', () => {
  state.meshB = null;
  state.comparison = null;
  document.getElementById('meshBInfo').textContent = '';
  document.getElementById('compareResult').innerHTML = '';
  document.getElementById('compareBtn').disabled = true;
  document.getElementById('clearCompareBtn').disabled = true;
  document.getElementById('fileInputB').value = '';
  if (state.result) applyFieldColors();
});

// ---------- 控件 ----------
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
document.getElementById('meshToggle').addEventListener('change', (e) => {
  wireMesh.visible = e.target.checked;
});
document.getElementById('clearSourcesBtn').addEventListener('click', () => {
  state.sources = [];
  document.getElementById('sourceList').textContent = '';
  markerGroup.clear();
});

// ---------- 导出 ----------
document.getElementById('exportDistBtn').addEventListener('click', () => {
  downloadJSON(buildDistanceExport(state.analysis, state.result), 'distances.json');
});
document.getElementById('exportIsoBtn').addEventListener('click', () => {
  downloadJSON(buildIsolineExport(state.analysis, state.result, state.isoSpacing), 'isolines.json');
});
document.getElementById('exportDiagBtn').addEventListener('click', () => {
  const segs = extractIsolines(state.result, state.analysis, state.isoSpacing);
  const extra = state.meshB
    ? {
        comparison: state.comparison
          ? {
              meshB: state.meshB.name,
              maxAbsDifference: state.comparison.maxAbsDifference,
              meanAbsDifference: state.comparison.meanAbsDifference,
              rmsDifference: state.comparison.rmsDifference,
            }
          : { meshB: state.meshB.name, status: '已载入但尚未点击计算差异' },
      }
    : {};
  downloadJSON(buildDiagnosticExport(state.analysis, state.result, state.isoSpacing, segs, extra), 'diagnostics.json');
});

// ---------- 信息面板 ----------
function showReject(msg) {
  const el = document.getElementById('rejectMsg');
  el.textContent = `导入被拒绝：${msg}`;
  el.classList.remove('hidden');
}
function renderMeshInfo(name, an) {
  document.getElementById('rejectMsg').classList.add('hidden');
  document.getElementById('meshInfo').innerHTML = `
    <b>${name}</b><br/>
    顶点 <b>${an.nV}</b> · 总面 <b>${an.nF}</b> · 有效面 <b>${an.validFaces.length}</b><br/>
    连通分量 <b>${an.components.length}</b>（含孤立点 ${an.components.filter((c) => c.isolated).length}）`;
}
function renderExcluded(an) {
  const box = document.getElementById('excludedBox');
  if (an.excludedFaces.length) {
    box.classList.remove('hidden');
    document.getElementById('excludedCount').textContent = an.excludedFaces.length;
    document.getElementById('excludedList').innerHTML = an.excludedFaces
      .map((f) => `<li>面 #${f.face} [${f.indices.join(', ')}]：${f.reason}</li>`)
      .join('');
  } else {
    box.classList.add('hidden');
  }
  const ob = document.getElementById('obtuseBox');
  if (an.obtuseFaces.length || an.boundaryEdges.length) {
    ob.classList.remove('hidden');
    document.getElementById('obtuseCount').textContent = an.obtuseFaces.length;
    document.getElementById('boundaryCount').textContent = an.boundaryEdges.length;
  } else {
    ob.classList.add('hidden');
  }
}
function enableExport(on) {
  for (const id of ['exportDistBtn', 'exportIsoBtn', 'exportDiagBtn']) {
    document.getElementById(id).disabled = !on;
  }
}
function renderDiagnostics() {
  const r = state.result;
  const rows = r.componentDiagnostics
    .map((c) => {
      if (c.isolated) {
        return `<tr><td>分量 ${c.component}（孤立点）</td><td>${c.sourced ? '源点→0' : 'null'}</td><td>—</td><td>—</td></tr>`;
      }
      if (!c.sourced) {
        return `<tr><td>分量 ${c.component}</td><td class="bad">不可达</td><td>—</td><td>—</td></tr>`;
      }
      const hr = c.heat.relativeResidual;
      const pr = c.poisson.relativeResidual;
      const cls = (x) => (x < 1e-8 ? 'good' : 'bad');
      return `<tr>
        <td>分量 ${c.component}（${c.faceCount} 面）</td>
        <td>已求解</td>
        <td class="${cls(hr)}">${hr.toExponential(2)}</td>
        <td class="${cls(pr)}">${pr.toExponential(2)}</td></tr>`;
    })
    .join('');
  document.getElementById('diagBox').innerHTML = `
    求解耗时 ${r.solveMs.toFixed(1)} ms · 不可达顶点 <b id="unreachableCount">${r.unreachableCount}</b> · 最大距离 <b>${r.maxDistance.toFixed(4)}</b><br/>
    缓存：热分解 命中 ${r.cacheStats.heat.hits}/未命中 ${r.cacheStats.heat.misses}，
    Poisson 命中 ${r.cacheStats.poisson.hits}/未命中 ${r.cacheStats.poisson.misses}
    <table><thead><tr><th>分量</th><th>状态</th><th>热方程残差</th><th>Poisson 残差</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// ---------- 渲染循环 ----------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
resize();
animate();
