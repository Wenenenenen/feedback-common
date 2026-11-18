import { v3, m4, composeTRS } from './math.js';
import { computeTangentFrames, transformFrames } from './tangent.js';
import { decodeNormalPNG, sampleNormalMap } from './normalmap.js';
import { parseScene, checkTextureSize, buildExport, verifyReproduction } from './io.js';
import { View3D } from './view3d.js';
import { UVView } from './uvview.js';
import { drawRawMap, renderShadingPreview } from './preview.js';

const $ = (id) => document.getElementById(id);

const state = {
  mesh: null,
  corners: null,
  instanced: null,
  diagnostics: [],
  normalMap: null, // { name, width, height, data, pngDataUrl }
  trs: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
  instance: m4.identity(),
  detLinear: 1,
  selected: -1,
  bboxSize: 1,
  sceneName: '',
};

const view3d = new View3D($('view3d'));
const uvview = new UVView($('uvview'));

// ---------- 默认平法线贴图（未加载 PNG 时预览用） ----------
function flatNormalMap() {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { data[i * 4] = 128; data[i * 4 + 1] = 128; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255; }
  return { name: '(flat)', width: 4, height: 4, data, pngDataUrl: null };
}

// ---------- 场景装载 ----------
function loadScene(parsed, name) {
  state.mesh = parsed.mesh;
  state.sceneName = name;
  const { corners, diagnostics, stats } = computeTangentFrames(parsed.mesh);
  state.corners = corners;
  state.diagnostics = diagnostics;
  state.selected = corners.length ? 0 : -1;

  if (parsed.instance) {
    setTRSFromMatrix(parsed.instance);
  } else {
    state.trs = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  }
  syncTRSInputs();

  const bb = parsed.mesh.positions.reduce(
    (a, p) => ({ min: a.min.map((v, i) => Math.min(v, p[i])), max: a.max.map((v, i) => Math.max(v, p[i])) }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  );
  state.bboxSize = Math.max(1e-3, Math.hypot(...bb.max.map((v, i) => v - bb.min[i])));

  view3d.setMesh(parsed.mesh, corners);
  uvview.setData(parsed.mesh, corners);
  log(
    `已装载 ${name}：${stats.faceCount} 面 / ${stats.cornerCount} 角 / ${stats.groupCount} 个切线分组` +
      (stats.mirroredGroups ? `，其中 ${stats.mirroredGroups} 个镜像分组` : '')
  );

  // 导出文件复现校验
  if (parsed.expected) {
    const v = verifyReproduction(parsed.expected, corners);
    log(`复现校验（逐角 TBN）：${v.detail}`, v.ok ? 'ok' : 'err');
  }
  state._expectedInstanced = parsed.expectedInstanced || null;

  applyTransform();
}

function setTRSFromMatrix(m) {
  // 仅当矩阵是 TRS（旋转列正交）时可拆；否则退回单位 TRS 并直接采用矩阵
  const sx = Math.hypot(m[0], m[4], m[8]);
  const sy = Math.hypot(m[1], m[5], m[9]);
  const sz = Math.hypot(m[2], m[6], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  const fsx = det < 0 ? -sx : sx;
  const r00 = m[0] / fsx, r01 = m[1] / sy, r02 = m[2] / sz;
  const r10 = m[4] / fsx, r11 = m[5] / sy, r12 = m[6] / sz;
  const r20 = m[8] / fsx, r21 = m[9] / sy, r22 = m[10] / sz;
  // R = Rz*Ry*Rx：r02=sy_, r12=-? 按分解：ry = asin(r02)（列向量约定下 R[0][2]=sin(ry)）
  const ry = Math.asin(Math.min(1, Math.max(-1, r02)));
  const cy = Math.cos(ry);
  let rx, rz;
  if (Math.abs(cy) > 1e-6) {
    rx = Math.atan2(-r12, r22);
    rz = Math.atan2(-r01, r00);
  } else {
    rx = Math.atan2(r21, r11);
    rz = 0;
  }
  state.trs = {
    t: [m[3], m[7], m[11]],
    r: [(rx * 180) / Math.PI, (ry * 180) / Math.PI, (rz * 180) / Math.PI],
    s: [fsx, sy, sz],
  };
}

// ---------- 变换应用 ----------
function applyTransform() {
  if (!state.mesh) return;
  const { t, r, s } = state.trs;
  state.instance = composeTRS(t, r, s);
  try {
    const { frames, detLinear } = transformFrames(state.corners, state.instance);
    state.instanced = frames;
    state.detLinear = detLinear;
    $('detInfo').textContent = `线性行列式 det = ${detLinear.toPrecision(4)}（h 乘 ${detLinear >= 0 ? '+' : '-'}1）`;
    if (state._expectedInstanced) {
      const v = verifyReproduction(
        state._expectedInstanced.map((f, i) => ({ ...f, face: i, corner: 0 })),
        frames.map((f, i) => ({ ...f, face: i, corner: 0 }))
      );
      log(`复现校验（实例 TBN）：${v.detail}`, v.ok ? 'ok' : 'err');
      state._expectedInstanced = null; // 只校验一次
    }
  } catch (e) {
    log(`实例变换失败：${e.message}`, 'err');
    state.instanced = null;
  }
  view3d.setModel(state.instance);
  updateSelection();
  renderDiagnostics();
}

// ---------- 选中角 ----------
function selectCorner(i) {
  if (!state.corners || i < 0 || i >= state.corners.length) return;
  state.selected = i;
  updateSelection();
}

function updateSelection() {
  const i = state.selected;
  uvview.setSelected(i);
  if (i < 0 || !state.corners) { view3d.setAxes([]); return; }
  const c = state.corners[i];
  const f = state.instanced ? state.instanced[i] : { T: c.T, B: c.B, N: c.N, h: c.h };
  const p = m4.transformPoint(state.instance, state.mesh.positions[c.posIndex]);
  const s = state.bboxSize * 0.25;
  view3d.setAxes([
    [p, v3.add(p, v3.scale(f.T, s)), [0.95, 0.25, 0.25]],
    [p, v3.add(p, v3.scale(f.B, s)), [0.3, 0.9, 0.3]],
    [p, v3.add(p, v3.scale(f.N, s)), [0.35, 0.5, 1.0]],
  ]);
  const fmt = (v) => `(${v.map((x) => x.toFixed(4)).join(', ')})`;
  $('cornerInfo').innerHTML = `
    <tr><td>角</td><td>面 ${c.face} / 角 ${c.corner}（位置索引 ${c.posIndex}）</td></tr>
    <tr><td>UV</td><td>(${c.uv.map((x) => x.toFixed(4)).join(', ')})，UV det = ${c.uvDet.toExponential(2)}</td></tr>
    <tr><td>手性 h</td><td>${c.h} → 实例后 ${f.h}${c.fallback ? '（回退）' : ''}</td></tr>
    <tr><td>T</td><td>${fmt(c.T)} → ${fmt(f.T)}</td></tr>
    <tr><td>B</td><td>${fmt(c.B)} → ${fmt(f.B)}</td></tr>
    <tr><td>N</td><td>${fmt(c.N)} → ${fmt(f.N)}</td></tr>`;
  // 法线贴图重算预览
  const tex = state.normalMap || flatNormalMap();
  renderShadingPreview($('preview'), tex, f, view3d.lightDir, false);
  renderShadingPreview($('previewFlip'), tex, f, view3d.lightDir, true);
  if (state.normalMap) {
    const t = sampleNormalMap(tex, c.uv[0], c.uv[1]);
    $('sampleInfo').textContent = `选中角 UV 处采样法线：(${t.map((x) => x.toFixed(4)).join(', ')})`;
  } else {
    $('sampleInfo').textContent = '未加载法线 PNG，预览使用平法线 (0,0,1)';
  }
}

// ---------- 诊断 ----------
function log(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `diag ${kind}`;
  el.textContent = msg;
  $('diagList').prepend(el);
}

function renderDiagnostics() {
  $('diagList').innerHTML = '';
  for (const d of state.diagnostics) log(d, 'warn');
  if (!state.diagnostics.length) log('无诊断：所有角均正常累计', 'ok');
}

// ---------- 文件 ----------
async function loadSceneFile(file) {
  const json = JSON.parse(await file.text());
  const parsed = parseScene(json);
  if (parsed.pngDataUrl) {
    const blob = await (await fetch(parsed.pngDataUrl)).blob();
    await loadNormalMapBlob(blob, parsed.normalMapName || 'embedded.png');
  }
  loadScene(parsed, file.name);
}

async function loadNormalMapBlob(blob, name) {
  const tex = await decodeNormalPNG(blob);
  checkTextureSize(tex.width, tex.height);
  const buf = await blob.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  state.normalMap = { ...tex, name, pngDataUrl: `data:image/png;base64,${b64}` };
  view3d.setNormalMapTexture(tex);
  drawRawMap($('rawmap'), tex);
  log(`法线贴图 ${name}：${tex.width}×${tex.height}（原始字节，未做 sRGB 解码）`, 'ok');
  updateSelection();
}

// ---------- 自检 ----------
async function selfTest() {
  log('—— 自检开始（对照 cases/reference.json）——');
  const ref = await (await fetch('cases/reference.json')).json();
  const close = (a, b, eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) <= eps);
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    log(`${ok ? '✓' : '✗'} ${name}：${detail}`, ok ? 'ok' : 'err');
    ok ? pass++ : fail++;
  };
  for (const name of ['plane', 'mirror', 'zero-uv', 'cancelling']) {
    const mesh = await (await fetch(`cases/${name}.json`)).json();
    const { corners } = computeTangentFrames(mesh);
    const e = ref[name];
    check(name, close(corners[0].T, e.T) && corners[0].h === e.h,
      `T=(${corners[0].T.map((x) => x.toFixed(3))}) h=${corners[0].h}，期望 T=(${e.T}) h=${e.h}`);
    if (e.fallback_corners) {
      const fb = [...new Set(corners.filter((c) => c.fallback).map((c) => c.corner))].sort();
      check(`${name} 回退角`, JSON.stringify(fb) === JSON.stringify(e.fallback_corners),
        `回退角 ${JSON.stringify(fb)}，期望 ${JSON.stringify(e.fallback_corners)}`);
    }
  }
  {
    const scene = await (await fetch('cases/mirror-instance.json')).json();
    const { corners } = computeTangentFrames(scene);
    const { frames } = transformFrames(corners, scene.instance);
    const e = ref['mirror-instance'];
    check('mirror-instance', close(frames[0].T, e.T) && close(frames[0].N, e.N) && frames[0].h === e.h,
      `T=(${frames[0].T.map((x) => x.toFixed(3))}) N=(${frames[0].N.map((x) => x.toFixed(3))}) h=${frames[0].h}`);
  }
  // 健壮性：这些用例不应崩溃
  for (const name of ['angle-weight', 'shared-mirror']) {
    try {
      const mesh = await (await fetch(`cases/${name}.json`)).json();
      const { corners } = computeTangentFrames(mesh);
      check(name, corners.every((c) => Number.isFinite(c.T[0]) && Number.isFinite(c.h)), '计算完成且结果有限');
    } catch (e) { check(name, false, e.message); }
  }
  try {
    const mesh = await (await fetch('cases/invalid-normal.json')).json();
    parseScene(mesh);
    check('invalid-normal', false, '零法线未被拒绝');
  } catch (e) {
    check('invalid-normal', /法线为零/.test(e.message), `正确拒绝：${e.message}`);
  }
  log(`—— 自检结束：${pass} 通过，${fail} 失败 ——`, fail ? 'err' : 'ok');
}

// ---------- UI 绑定 ----------
function syncTRSInputs() {
  const { t, r, s } = state.trs;
  ['x', 'y', 'z'].forEach((ax, i) => {
    $(`t${ax}`).value = +t[i].toFixed(6);
    $(`r${ax}`).value = +r[i].toFixed(3);
    $(`s${ax}`).value = +s[i].toFixed(6);
  });
}

function readTRSInputs() {
  const { t, r, s } = state.trs;
  ['x', 'y', 'z'].forEach((ax, i) => {
    t[i] = parseFloat($(`t${ax}`).value) || 0;
    r[i] = parseFloat($(`r${ax}`).value) || 0;
    let sv = parseFloat($(`s${ax}`).value);
    if (!Number.isFinite(sv)) sv = 1;
    if (sv === 0) {
      sv = 0.001;
      $(`s${ax}`).value = 0.001;
      log(`缩放 ${ax.toUpperCase()} 不能为 0，已钳到 0.001`, 'warn');
    }
    s[i] = sv;
  });
}

$('fileScene').addEventListener('change', async (e) => {
  try { await loadSceneFile(e.target.files[0]); } catch (err) { log(`场景导入失败：${err.message}`, 'err'); }
  e.target.value = '';
});
$('filePNG').addEventListener('change', async (e) => {
  try { await loadNormalMapBlob(e.target.files[0], e.target.files[0].name); } catch (err) { log(`PNG 导入失败：${err.message}`, 'err'); }
  e.target.value = '';
});
$('btnExport').addEventListener('click', () => {
  if (!state.mesh) { log('尚未装载场景', 'err'); return; }
  const out = buildExport({
    mesh: state.mesh,
    normalMap: state.normalMap,
    instance: state.instance,
    corners: state.corners,
    instanced: state.instanced || state.corners.map((c) => ({ T: c.T, B: c.B, N: c.N, h: c.h })),
    diagnostics: state.diagnostics,
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `${state.sceneName.replace(/\.json$/, '') || 'scene'}-audited.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  log('已导出逐角切线、手性、实例后基向量与诊断', 'ok');
});
$('btnSelfTest').addEventListener('click', () => selfTest().catch((e) => log(`自检异常：${e.message}`, 'err')));
$('btnResetTRS').addEventListener('click', () => {
  state.trs = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  syncTRSInputs();
  applyTransform();
});
$('btnMirrorX').addEventListener('click', () => {
  state.trs.s[0] = -Math.abs(state.trs.s[0]);
  syncTRSInputs();
  applyTransform();
});
for (const ax of ['x', 'y', 'z']) {
  for (const g of ['t', 'r', 's']) {
    $(`${g}${ax}`).addEventListener('change', () => { readTRSInputs(); applyTransform(); });
  }
}
document.querySelectorAll('input[name=shademode]').forEach((el) =>
  el.addEventListener('change', () => { view3d.mode = +el.value; view3d.render(); })
);
view3d.onPick = (e) => {
  if (!state.mesh) return;
  const r = view3d.canvas.getBoundingClientRect();
  const i = view3d.pickCorner(e.clientX - r.left, e.clientY - r.top, state.mesh, state.corners, state.instance);
  if (i >= 0) selectCorner(i);
};
uvview.onPick = (i) => selectCorner(i);

// 样例快捷按钮
document.querySelectorAll('button[data-case]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const name = btn.dataset.case;
    try {
      const json = await (await fetch(`cases/${name}.json`)).json();
      const parsed = parseScene(json);
      if (json.normal_map && !state.normalMap) {
        const blob = await (await fetch('cases/normal.png')).blob();
        await loadNormalMapBlob(blob, 'normal.png');
      }
      loadScene(parsed, `${name}.json`);
    } catch (e) { log(`样例 ${name} 装载失败：${e.message}`, 'err'); }
  })
);

syncTRSInputs();
log('就绪。装载场景 JSON 与法线 PNG，或点击上方样例。');
