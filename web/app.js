// 页面主逻辑：参数绑定、采样调度（可取消 + 代际保护）、确定性积分、
// 热力图/表格/详情/查询/校验/导出。
'use strict';

import {
  v3, makeFrame, validateParams, NB, NP, BIN_SOLID_ANGLE, binBounds, TAU,
} from './microfacet-core.js';
import { integrateHemisphere, queryPoint } from './integrator.js';
import { SamplerController, BIN_REJECT } from './sampler.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'), loadDefaultBtn: $('loadDefaultBtn'), importMsg: $('importMsg'),
  vx: $('vx'), vy: $('vy'), vz: $('vz'),
  ax: $('ax'), ay: $('ay'), angle: $('angle'), f0: $('f0'),
  axVal: $('axVal'), ayVal: $('ayVal'), angleVal: $('angleVal'), f0Val: $('f0Val'),
  seed: $('seed'), count: $('count'),
  runBtn: $('runBtn'), cancelBtn: $('cancelBtn'),
  progBar: $('progBar'), statusText: $('statusText'), runPill: $('runPill'), paramErr: $('paramErr'),
  tAttempt: $('tAttempt'), tAcceptSub: $('tAcceptSub'), tReject: $('tReject'), tRejectAna: $('tRejectAna'),
  tEMc: $('tEMc'), tEDir: $('tEDir'), tEDirSub: $('tEDirSub'),
  heat: $('heat'), showNum: $('showNum'), rejSwatch: $('rejSwatch'),
  binTable: $('binTable'),
  qlx: $('qlx'), qly: $('qly'), qlz: $('qlz'), queryBtn: $('queryBtn'), queryOut: $('queryOut'),
  checksOut: $('checksOut'),
  dlCsvBtn: $('dlCsvBtn'), copyCsvBtn: $('copyCsvBtn'),
  dlJsonBtn: $('dlJsonBtn'), copyJsonBtn: $('copyJsonBtn'), exportMsg: $('exportMsg'),
  detailCard: $('detailCard'), detailTitle: $('detailTitle'), detailStats: $('detailStats'),
  sampleTable: $('sampleTable'), sampleHint: $('sampleHint'),
};

// ---------- 全局状态 ----------
const state = {
  params: null,
  sampler: new SamplerController(),
  result: null,       // 最近一次完成的采样结果（代际校验通过才赋值）
  integration: null,  // 对应参数的确定性积分
  binCounts: null,    // 128 格接受样本计数
  metric: 'freq',
  scale: 'log',
  selectedBin: null,
  sortKey: 'bin',
  sortDir: 1,
  heatColors: null,   // 当前主题下的 5 个色阶 RGB
  invokeSeq: 0,       // 应用层调用序号：区分“普通取消”与“被新任务取代”
};

const DEFAULT_JSON = {
  format: '单位法向+Z，观察v与出射l均指离表面',
  params: { view: [0.3, 0.1, 1], ax: 0.22, ay: 0.58, angle: 25, F0: 0.85, seed: 12345, count: 40000 },
};

// ---------- 参数读写 ----------
function readParams() {
  return {
    view: [parseFloat(els.vx.value), parseFloat(els.vy.value), parseFloat(els.vz.value)],
    ax: parseFloat(els.ax.value),
    ay: parseFloat(els.ay.value),
    angleDeg: parseFloat(els.angle.value),
    F0: parseFloat(els.f0.value),
    seed: parseInt(els.seed.value, 10) >>> 0,
    count: parseInt(els.count.value, 10),
  };
}

function writeParams(p) {
  const [vx, vy, vz] = p.view;
  els.vx.value = vx; els.vy.value = vy; els.vz.value = vz;
  els.ax.value = p.ax; els.ay.value = p.ay;
  els.angle.value = p.angleDeg ?? p.angle;
  els.f0.value = p.F0;
  els.seed.value = p.seed;
  els.count.value = p.count;
  syncRangeLabels();
}

function syncRangeLabels() {
  els.axVal.textContent = (+els.ax.value).toFixed(2);
  els.ayVal.textContent = (+els.ay.value).toFixed(2);
  els.angleVal.textContent = `${els.angle.value}°`;
  els.f0Val.textContent = (+els.f0.value).toFixed(2);
}

// ---------- 运行 / 取消（代际保护：旧任务结果不覆盖新结果） ----------
async function onRun() {
  const params = readParams();
  const errs = validateParams(params);
  els.paramErr.textContent = errs.join('\n');
  if (errs.length) return;
  els.paramErr.textContent = '';

  setRunningUI(true, '运行中…', 'run');
  const myInvoke = ++state.invokeSeq;
  state.params = params;
  state.result = null;
  state.integration = null;
  state.selectedBin = null;
  els.detailCard.hidden = true;

  // 确定性积分只依赖材质与观察方向，与种子无关，先算（约 0.1–0.2s）
  const frame = makeFrame(params.angleDeg);
  const vWorld = v3.normalize(params.view);
  let integration;
  try {
    integration = integrateHemisphere(vWorld, frame, params.ax, params.ay, params.F0);
  } catch (e) {
    if (state.invokeSeq !== myInvoke) return; // 已被新调用取代
    els.paramErr.textContent = `确定性积分失败：${e.message}`;
    setRunningUI(false, '失败', 'cancel');
    return;
  }

  const myRunId = state.sampler.runId + 1;
  const result = await state.sampler.run(params, (done, total, stats) => {
    if (state.sampler.runId !== myRunId) return; // 旧块的迟到回调不更新 UI
    const pct = done / total;
    els.progBar.style.width = `${(pct * 100).toFixed(1)}%`;
    els.statusText.textContent =
      `已完成 ${done.toLocaleString()} / ${total.toLocaleString()} · 拒收 ${stats.rejected.toLocaleString()}`;
  });

  // 代际保护：已有更新的 onRun 启动时，旧结果一律静默丢弃，绝不覆盖新任务的视图
  if (state.invokeSeq !== myInvoke) return;

  if (result.cancelled || !result.ok) {
    setRunningUI(false, result.ok === false ? '运行失败' : '已取消，可改参数后重跑', 'cancel');
    els.progBar.style.width = '0%';
    if (result.errors) els.paramErr.textContent = result.errors.join('\n');
    return;
  }

  state.result = result;
  state.integration = integration;
  state.binCounts = computeBinCounts(result.store);
  renderAll();
  setRunningUI(false, `完成 · ${params.count.toLocaleString()} 次尝试`, 'done');
  els.progBar.style.width = '100%';
}

function onCancel() {
  state.sampler.cancel();
  els.cancelBtn.disabled = true;
  els.statusText.textContent = '正在取消…';
}

function setRunningUI(running, text, pillKind) {
  els.runBtn.disabled = running;
  els.cancelBtn.disabled = !running;
  els.statusText.textContent = text;
  els.runPill.className = pillKind ? `pill ${pillKind}` : '';
  els.runPill.textContent = pillKind === 'run' ? '运行中' : pillKind === 'done' ? '完成' : pillKind === 'cancel' ? '停止' : '';
  if (!running) els.progBar.style.width = els.progBar.style.width || '0%';
}

// ---------- 统计 ----------
function computeBinCounts(store) {
  const counts = new Int32Array(NB * NP);
  for (let i = 0; i < store.count; i++) {
    const b = store.bin[i];
    if (b !== BIN_REJECT) counts[b]++;
  }
  return counts;
}

// 每格汇总统计
function binStats(bin) {
  const { store } = state.result;
  const n = state.binCounts[bin];
  const total = store.count;
  const accepted = store.acceptedCount;
  const prob = state.integration.binProb[bin];
  const density = state.integration.binDensity[bin];
  return {
    bin, n,
    freq: n / total,                 // 全分母（含拒收）
    condFreq: accepted ? n / accepted : 0,
    prob, density,
    ratio: prob > 0 ? (n / total) / prob : (n === 0 ? 1 : Infinity),
    expected: prob * total,
    z: binBounds(bin).zLo,
  };
}

// ---------- 热力图 ----------
function readHeatColors() {
  const cs = getComputedStyle(document.documentElement);
  state.heatColors = [1, 2, 3, 4, 5].map((k) => parseRgb(cs.getPropertyValue(`--heat-${k}`)));
}
function parseRgb(s) {
  const m = s.trim().match(/#([0-9a-f]{6})/i);
  if (!m) return [255, 255, 255];
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = state.heatColors;
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function cellMetricValue(bin) {
  const s = binStats(bin);
  if (state.metric === 'freq') return s.freq;
  if (state.metric === 'density') return s.density;
  return s.ratio;
}

function renderHeatmap() {
  readHeatColors();
  const heat = els.heat;
  heat.innerHTML = '';
  // 角单元
  const corner = document.createElement('div');
  corner.className = 'corner';
  corner.textContent = 'z 带 ↓ / φ →';
  heat.appendChild(corner);
  // 列头：方位角（度）
  for (let seg = 0; seg < NP; seg++) {
    const d = document.createElement('div');
    d.className = 'axis-x';
    d.textContent = `${Math.round((seg / NP) * 360)}`;
    heat.appendChild(d);
  }
  const values = Array.from({ length: NB * NP }, (_, b) => cellMetricValue(b));
  let lo, hi;
  if (state.metric === 'ratio') {
    lo = 0.5; hi = 2; // 固定中心 1
  } else {
    const finite = values.filter((x) => Number.isFinite(x) && x > 0);
    hi = Math.max(...finite, 1e-12);
    lo = Math.min(...finite, hi);
  }
  const colorOf = (v) => {
    if (state.metric === 'ratio') {
      const t = (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo);
      return ramp(t);
    }
    if (!(v > 0)) return 'var(--surface-2)';
    const t = state.scale === 'log'
      ? Math.log(v / lo) / Math.log(hi / lo)
      : (v - lo) / (hi - lo);
    return ramp(Number.isFinite(t) ? t : 0);
  };

  for (let band = NB - 1; band >= 0; band--) {
    const yd = document.createElement('div');
    yd.className = 'axis-y';
    const zLo = band / NB, zHi = (band + 1) / NB;
    yd.textContent = `${zLo.toFixed(3)}`;
    yd.title = `z∈[${zLo.toFixed(3)},${zHi.toFixed(3)})`;
    heat.appendChild(yd);
    for (let seg = 0; seg < NP; seg++) {
      const bin = band * NP + seg;
      const v = values[bin];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell' + (els.showNum.checked ? ' show-n' : '') + (state.selectedBin === bin ? ' sel' : '');
      cell.style.background = colorOf(v);
      cell.dataset.bin = bin;
      const s = binStats(bin);
      cell.title = `格 #${bin} · z∈[${zLo.toFixed(3)},${zHi.toFixed(3)}) · φ∈[${Math.round((seg / NP) * 360)}°,${Math.round(((seg + 1) / NP) * 360)}°)\n样本 ${s.n} · 频率 ${s.freq.toExponential(2)} · 积分概率 ${s.prob.toExponential(2)}`;
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = s.n;
      cell.appendChild(num);
      cell.addEventListener('click', () => selectBin(bin));
      heat.appendChild(cell);
    }
  }
}

// ---------- 格统计表 ----------
function renderBinTable() {
  const rows = Array.from({ length: NB * NP }, (_, bin) => binStats(bin));
  const key = state.sortKey;
  rows.sort((a, b) => {
    let av, bv;
    if (key === 'bin') { av = a.bin; bv = b.bin; }
    else if (key === 'z') { av = a.z; bv = b.z; }
    else if (key === 'phi') { av = a.bin % NP; bv = b.bin % NP; }
    else { av = a[key === 'rej' ? 'freq' : key]; bv = b[key === 'rej' ? 'freq' : key]; }
    return (av - bv) * state.sortDir;
  });
  const tb = els.binTable.querySelector('tbody');
  tb.innerHTML = '';
  const total = state.result.store.count;
  for (const s of rows) {
    const bnd = binBounds(s.bin);
    const tr = document.createElement('tr');
    if (state.selectedBin === s.bin) tr.className = 'sel';
    tr.innerHTML = `<td>${s.bin}</td>
      <td>[${bnd.zLo.toFixed(3)},${bnd.zHi.toFixed(3)})</td>
      <td>[${(bnd.phiLo * 180 / Math.PI).toFixed(0)}°,${(bnd.phiHi * 180 / Math.PI).toFixed(0)}°)</td>
      <td>${s.n}</td>
      <td>${s.freq.toExponential(3)}</td>
      <td>${s.condFreq.toExponential(3)}</td>
      <td>${s.prob.toExponential(3)}</td>
      <td>${s.density.toExponential(3)}</td>
      <td>${Number.isFinite(s.ratio) ? s.ratio.toFixed(3) : '—'}</td>
      <td class="muted">—</td>`;
    tr.addEventListener('click', () => selectBin(s.bin));
    tb.appendChild(tr);
  }
  // 拒收行（下半球，不占格；频率对全分母）
  const rej = state.result.store.rejectCount;
  const tr = document.createElement('tr');
  tr.className = 'reject-row';
  tr.innerHTML = `<td>拒收</td><td colspan="2">lz ≤ 0（下半球，不重抽）</td>
    <td>${rej}</td><td>${(rej / total).toExponential(3)}</td><td>—</td><td colspan="3">解析拒收率 ${(1 - state.integration.totalProb).toExponential(3)}</td>
    <td>${(rej / total).toFixed(4)}</td>`;
  tb.appendChild(tr);
}

// ---------- 格详情（点格查样本） ----------
function selectBin(bin) {
  state.selectedBin = bin;
  renderHeatmap();
  renderBinTable();
  const { store } = state.result;
  const s = binStats(bin);
  const bnd = binBounds(bin);
  els.detailCard.hidden = false;
  els.detailTitle.textContent = `格 #${bin} 详情 · z∈[${bnd.zLo.toFixed(3)},${bnd.zHi.toFixed(3)}) · φ∈[${(bnd.phiLo * 180 / Math.PI).toFixed(0)}°,${(bnd.phiHi * 180 / Math.PI).toFixed(0)}°)`;
  const zScore = s.expected > 0 ? (s.n - s.expected) / Math.sqrt(s.expected) : 0;
  const residualCls = Math.abs(zScore) > 3 ? 'check-warn' : 'check-ok';
  els.detailStats.innerHTML = kvHtml([
    ['样本数', `${s.n}（占总尝试 ${(s.freq * 100).toFixed(3)}%，分母含拒收）`],
    ['积分概率 P(bin)', s.prob.toExponential(4)],
    ['积分密度 pL（/sr）', s.density.toExponential(4)],
    ['期望样本数 P·N', s.expected.toFixed(1)],
    ['标准化残差 z', `<span class="${residualCls}">${zScore.toFixed(2)}</span>`],
    ['格立体角 ΔΩ', BIN_SOLID_ANGLE.toExponential(4)],
  ]) + `<div class="kv" style="grid-column:1/-1"><div class="k">操作</div>
    <button type="button" id="centerQueryBtn" style="margin-top:6px">用该格中心方向查询 pH / pL</button></div>`;
  $('centerQueryBtn').addEventListener('click', () => {
    const zc = (bnd.zLo + bnd.zHi) / 2;
    const pc = (bnd.phiLo + bnd.phiHi) / 2;
    const r = Math.sqrt(1 - zc * zc);
    els.qlx.value = (r * Math.cos(pc)).toFixed(4);
    els.qly.value = (r * Math.sin(pc)).toFixed(4);
    els.qlz.value = zc.toFixed(4);
    switchTab('query');
    onQuery();
  });

  // 样本明细（上限 200 行，避免 DOM 过大）
  const MAX_ROWS = 200;
  const tb = els.sampleTable.querySelector('tbody');
  tb.innerHTML = '';
  let shown = 0;
  const fmt = (x) => (x >= 0 ? ' ' : '') + x.toFixed(4);
  for (let i = 0; i < store.count && shown < MAX_ROWS; i++) {
    if (store.bin[i] !== bin) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i}</td>
      <td>(${fmt(store.lx[i])},${fmt(store.ly[i])},${fmt(store.lz[i])})</td>
      <td>(${fmt(store.hx[i])},${fmt(store.hy[i])},${fmt(store.hz[i])})</td>
      <td>${store.pH[i].toExponential(3)}</td>
      <td>${store.pL[i].toExponential(3)}</td>
      <td>${store.u1[i].toFixed(5)}</td>
      <td>${store.u2[i].toFixed(5)}</td>`;
    tb.appendChild(tr);
    shown++;
  }
  els.sampleHint.textContent = s.n > MAX_ROWS
    ? `该格共 ${s.n} 个样本，仅展示前 ${MAX_ROWS} 行；完整数据可用导出获取。`
    : `该格共 ${s.n} 个样本。每次尝试的两次 xorshift32 输出 u1、u2 一并列出。`;
}

function kvHtml(pairs) {
  return pairs.map(([k, v]) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

// ---------- 方向查询 ----------
function onQuery() {
  if (!state.params) { els.queryOut.innerHTML = '<p class="muted">请先运行一次采样以确定工况。</p>'; return; }
  const l = [parseFloat(els.qlx.value), parseFloat(els.qly.value), parseFloat(els.qlz.value)];
  if (l.some((x) => !Number.isFinite(x))) { els.queryOut.innerHTML = '<p class="err">方向分量须为有限数。</p>'; return; }
  const p = state.params;
  const frame = makeFrame(p.angleDeg);
  const vWorld = v3.normalize(p.view);
  const lWorld = v3.normalize(l);
  const q = queryPoint(lWorld, vWorld, frame, p.ax, p.ay, p.F0);
  if (!q.accepted) {
    els.queryOut.innerHTML = `<div class="kv" style="grid-column:1/-1"><div class="k">结果</div><div class="v check-bad">${q.reason}</div></div>`;
    return;
  }
  const bin = binOfWorld(lWorld);
  els.queryOut.innerHTML = kvHtml([
    ['半向量密度 pH（/sr）', q.pH.toExponential(6)],
    ['反射方向密度 pL（/sr）', q.pL.toExponential(6)],
    ['换算关系', 'pL = pH / (4|v·h|)'],
    ['v·h', q.vdotH.toFixed(6)],
    ['NDF D(h)', q.D.toExponential(6)],
    ['Fresnel F', q.F.toFixed(6)],
    ['BRDF', q.brdf.toExponential(6)],
    ['Λ(v) / Λ(l)', `${q.LambdaV.toExponential(4)} / ${q.LambdaL.toExponential(4)}`],
    ['能量密度 BRDF·lz', q.energyDensity.toExponential(6)],
    ['所属格', `#${bin}（z 带 ${Math.floor(bin / NP)}，方位 ${bin % NP}）`],
  ]);
}

function binOfWorld(lWorld) {
  if (lWorld[2] <= 0) return BIN_REJECT;
  let band = Math.floor(lWorld[2] * NB);
  band = Math.max(0, Math.min(NB - 1, band));
  let phi = Math.atan2(lWorld[1], lWorld[0]);
  if (phi < 0) phi += TAU;
  let seg = Math.floor((phi / TAU) * NP);
  seg = Math.max(0, Math.min(NP - 1, seg));
  return band * NP + seg;
}

// ---------- 校验诊断 ----------
function renderChecks() {
  const { store } = state.result;
  const integ = state.integration;
  const N = store.count;
  const empRej = store.rejectCount / N;
  const anaRej = 1 - integ.totalProb;
  const sigmaRej = Math.sqrt(anaRej * (1 - anaRej) / N);
  const rejOk = Math.abs(empRej - anaRej) < 3 * sigmaRej;
  const eMc = state.result.energyEstimate;
  const eDir = integ.totalEnergy;
  const eRel = Math.abs(eMc - eDir) / Math.max(eDir, 1e-12);

  // 逐格标准化残差最大值
  let worstZ = 0, worstBin = -1;
  for (let bin = 0; bin < NB * NP; bin++) {
    const s = binStats(bin);
    if (s.expected > 5) {
      const z = Math.abs(s.n - s.expected) / Math.sqrt(s.expected);
      if (z > worstZ) { worstZ = z; worstBin = bin; }
    }
  }
  const sumProb = integ.totalProb;
  const row = (name, ok, detail) => `<tr><td style="text-align:left">${name}</td>
    <td class="${ok === true ? 'check-ok' : ok === false ? 'check-bad' : 'check-warn'}">${ok === true ? '通过' : ok === false ? '异常' : '关注'}</td>
    <td style="text-align:left">${detail}</td></tr>`;

  els.checksOut.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th style="text-align:left">校验项</th><th>结论</th><th style="text-align:left">数值</th></tr></thead>
      <tbody>
        ${row('概率守恒：Σ逐格积分概率 + 解析拒收 = 1', Math.abs(sumProb + anaRej - 1) < 1e-9,
          `ΣP=${sumProb.toFixed(6)}，拒收=${anaRej.toFixed(6)}，和=${(sumProb + anaRej).toFixed(9)}`)}
        ${row('经验拒收率 vs 解析拒收率（3σ）', rejOk,
          `经验 ${empRej.toFixed(5)}，解析 ${anaRej.toFixed(5)}，差 ${Math.abs(empRej - anaRej).toExponential(2)}，3σ=${(3 * sigmaRej).toExponential(2)}`)}
        ${row('两种半球反射能量一致性', eRel < 0.02,
          `采样 E=${eMc.toFixed(6)}，积分 E=${eDir.toFixed(6)}，相对差 ${(eRel * 100).toFixed(2)}%`)}
        ${row('逐格频率 vs 积分概率（最大标准化残差）', worstZ < 4.5,
          `最大 |z|=${worstZ.toFixed(2)}（格 #${worstBin}），128 格下 4.5σ 为阈值`)}
        ${row('积分器细化诊断', integ.capBins === 0 ? true : null,
          `评估点 ${integ.evals.toLocaleString()}，最深层级 ${integ.maxDepth}，触顶格数 ${integ.capBins}（触顶格已用更深参考核对，误差仍满足容限）`)}
        ${row('分母完整性', store.acceptedCount + store.rejectCount === N,
          `接受 ${store.acceptedCount.toLocaleString()} + 拒收 ${store.rejectCount.toLocaleString()} = 总尝试 ${N.toLocaleString()}`)}
      </tbody>
    </table></div>
    <p class="hint section-gap">规格容限：数值总能量误差 ≤ 0.0005，逐格概率积分误差 ≤ 0.001。本页积分器采用中点法则两级稳定自适应细化，逐格误差估计存于导出数据的 binErrP / binErrE。</p>`;
}

// ---------- 指标瓦片 ----------
function renderTiles() {
  const { store } = state.result;
  const integ = state.integration;
  els.tAttempt.textContent = store.count.toLocaleString();
  els.tAcceptSub.textContent = `接受 ${store.acceptedCount.toLocaleString()}`;
  els.tReject.textContent = `${(store.rejectCount / store.count * 100).toFixed(2)}%`;
  els.tRejectAna.textContent = `解析 ${((1 - integ.totalProb) * 100).toFixed(2)}% · ${store.rejectCount.toLocaleString()} 次`;
  els.tEMc.textContent = state.result.energyEstimate.toFixed(5);
  els.tEDir.textContent = integ.totalEnergy.toFixed(5);
  const rel = Math.abs(state.result.energyEstimate - integ.totalEnergy) / Math.max(integ.totalEnergy, 1e-12);
  els.tEDirSub.textContent = `相对差 ${(rel * 100).toFixed(2)}%`;
}

function renderAll() {
  renderTiles();
  renderHeatmap();
  renderBinTable();
  renderChecks();
}

// ---------- 导出 ----------
function buildExportData() {
  const { store, params } = state.result;
  const integ = state.integration;
  const bins = [];
  for (let bin = 0; bin < NB * NP; bin++) {
    const s = binStats(bin);
    const bnd = binBounds(bin);
    bins.push({
      bin,
      zLo: +bnd.zLo.toFixed(4), zHi: +bnd.zHi.toFixed(4),
      phiLoDeg: +(bnd.phiLo * 180 / Math.PI).toFixed(2),
      phiHiDeg: +(bnd.phiHi * 180 / Math.PI).toFixed(2),
      sampleCount: s.n,
      frequencyFullDenominator: s.freq,
      conditionalFrequency: s.condFreq,
      integratedProbability: s.prob,
      integratedDensityPL: s.density,
      freqOverProb: Number.isFinite(s.ratio) ? s.ratio : null,
      errEstimateP: integ.binErrP[bin],
      errEstimateE: integ.binErrE[bin],
    });
  }
  return {
    schema: 'microfacet-sampler-proof/export-1',
    exportedAt: new Date().toISOString(),
    params: {
      view: params.view, ax: params.ax, ay: params.ay,
      angleDeg: params.angleDeg, F0: params.F0, seed: params.seed, count: params.count,
    },
    attempts: store.count,
    accepted: store.acceptedCount,
    rejected: store.rejectCount,
    empiricalRejectRate: store.rejectCount / store.count,
    analyticalRejectRate: 1 - integ.totalProb,
    energyMonteCarlo: state.result.energyEstimate,
    energyDeterministic: integ.totalEnergy,
    integration: {
      evals: integ.evals, maxDepth: integ.maxDepth, capBins: integ.capBins,
      binSolidAngle: integ.binSolidAngle,
    },
    bins,
  };
}

function toCsv(data) {
  const head = [
    `# 尝试数,${data.attempts}`, `# 拒收数,${data.rejected}`,
    `# 接受数,${data.accepted}`, `# 经验拒收率,${data.empiricalRejectRate}`,
    `# 解析拒收率,${data.analyticalRejectRate}`,
    `# 能量_采样,${data.energyMonteCarlo}`, `# 能量_确定性积分,${data.energyDeterministic}`,
    `# 种子,${data.params.seed}`, `# ax,${data.params.ax}`, `# ay,${data.params.ay}`,
    `# 拉丝角deg,${data.params.angleDeg}`, `# F0,${data.params.F0}`,
    `# 观察方向,${data.params.view.join(';')}`,
  ].join('\n');
  const cols = ['bin', 'zLo', 'zHi', 'phiLoDeg', 'phiHiDeg', 'sampleCount',
    'frequencyFullDenominator', 'conditionalFrequency', 'integratedProbability',
    'integratedDensityPL', 'freqOverProb', 'errEstimateP', 'errEstimateE'];
  const lines = [cols.join(','), ...data.bins.map((b) => cols.map((c) => b[c]).join(','))];
  return `${head}\n${lines.join('\n')}\n`;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    els.exportMsg.textContent = `${label}已复制到剪贴板（${(text.length / 1024).toFixed(1)} KB）。`;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    els.exportMsg.textContent = ok ? `${label}已复制（兼容路径）。` : '复制被浏览器拒绝，请改用下载按钮。';
  }
}

// ---------- 导入 ----------
function onFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      const p = json.params ?? json;
      const normalized = {
        view: p.view,
        ax: p.ax, ay: p.ay,
        angleDeg: p.angleDeg ?? p.angle,
        F0: p.F0, seed: p.seed, count: p.count,
      };
      const errs = validateParams(normalized);
      if (errs.length) { els.importMsg.textContent = `文件参数不合法：${errs.join('；')}`; return; }
      writeParams(normalized);
      els.importMsg.textContent = `已导入 ${file.name}：ax=${normalized.ax} ay=${normalized.ay} angle=${normalized.angleDeg}° F0=${normalized.F0} seed=${normalized.seed} count=${normalized.count}`;
    } catch (err) {
      els.importMsg.textContent = `解析失败：${err.message}`;
    }
  };
  reader.readAsText(file);
}

// ---------- Tab 切换 ----------
function switchTab(name) {
  document.querySelectorAll('.tab-row button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
}

// ---------- 事件绑定 ----------
function bind() {
  ['ax', 'ay', 'angle', 'f0'].forEach((id) => $(id).addEventListener('input', syncRangeLabels));
  els.runBtn.addEventListener('click', onRun);
  els.cancelBtn.addEventListener('click', onCancel);
  els.fileInput.addEventListener('change', onFile);
  els.loadDefaultBtn.addEventListener('click', () => {
    writeParams({ ...DEFAULT_JSON.params, angleDeg: DEFAULT_JSON.params.angle });
    els.importMsg.textContent = '已载入 samples/microfacet-proof.json 内置样例参数。';
  });
  document.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => {
    state.metric = b.dataset.metric;
    document.querySelectorAll('[data-metric]').forEach((x) => x.classList.toggle('on', x === b));
    if (state.result) renderHeatmap();
  }));
  document.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => {
    state.scale = b.dataset.scale;
    document.querySelectorAll('[data-scale]').forEach((x) => x.classList.toggle('on', x === b));
    if (state.result) renderHeatmap();
  }));
  els.showNum.addEventListener('change', () => state.result && renderHeatmap());
  els.queryBtn.addEventListener('click', onQuery);
  document.querySelectorAll('.tab-row button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  els.binTable.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = 1; }
    if (state.result) renderBinTable();
  }));
  els.dlCsvBtn.addEventListener('click', () => {
    if (!guardExport()) return;
    download('microfacet-bin-stats.csv', toCsv(buildExportData()), 'text/csv;charset=utf-8');
    els.exportMsg.textContent = '已触发 CSV 下载；若浏览器拦截请用“复制 CSV”。';
  });
  els.copyCsvBtn.addEventListener('click', () => guardExport() && copyText(toCsv(buildExportData()), 'CSV'));
  els.dlJsonBtn.addEventListener('click', () => {
    if (!guardExport()) return;
    download('microfacet-export.json', JSON.stringify(buildExportData(), null, 2), 'application/json');
    els.exportMsg.textContent = '已触发 JSON 下载；若浏览器拦截请用“复制 JSON”。';
  });
  els.copyJsonBtn.addEventListener('click', () => guardExport() && copyText(JSON.stringify(buildExportData(), null, 2), 'JSON'));
  // 主题变化时重取色阶
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.result && renderHeatmap());
}

function guardExport() {
  if (!state.result) { els.exportMsg.textContent = '请先完成一次采样。'; return false; }
  return true;
}

// ---------- 启动 ----------
writeParams({ ...DEFAULT_JSON.params, angleDeg: DEFAULT_JSON.params.angle });
els.rejSwatch.style.background = 'var(--reject)';
bind();
