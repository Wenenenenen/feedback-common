// 反查校样台 —— 页面逻辑（DOM / 文件 / 渲染 / 交互）
import {
  validateTable,
  parseBounds,
  parseAnchor,
  parseWeights,
  forward,
  parseP6,
  encodeP6,
  InverseSolver,
} from './lut-core.js';

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const state = {
  table: null, // 已成功解析的表（含文件自带 bounds/anchor/weights）
  tableName: '',
  target: null, // { width, height, rgb }
  targetName: '',
  solver: null,
  codes: null, // 最近一次成功反查的码图 Uint8Array
  proof: null, // 最近一次成功反查的校样 Uint8Array
  runToken: 0, // 中止过期任务
  selected: null, // { x, y }
};

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  chipTable: $('chipTable'),
  chipImage: $('chipImage'),
  nameTable: $('nameTable'),
  nameImage: $('nameImage'),
  banner: $('banner'),
  applyBtn: $('applyBtn'),
  cancelBtn: $('cancelBtn'),
  progressBar: $('progressBar'),
  statCandidates: $('statCandidates'),
  statOutputs: $('statOutputs'),
  statBuild: $('statBuild'),
  statSolve: $('statSolve'),
  statStatus: $('statStatus'),
  metaTarget: $('metaTarget'),
  metaProof: $('metaProof'),
  metaCodes: $('metaCodes'),
  phTarget: $('phTarget'),
  phProof: $('phProof'),
  phCodes: $('phCodes'),
  cvTarget: $('cvTarget'),
  cvProof: $('cvProof'),
  cvCodes: $('cvCodes'),
  boxTarget: $('boxTarget'),
  boxProof: $('boxProof'),
  mkTarget: $('mkTarget'),
  mkProof: $('mkProof'),
  dlCodes: $('dlCodes'),
  dlProof: $('dlProof'),
  themeToggle: $('themeToggle'),
  diffTable: $('diffTable'),
};

const inputs = {
  bounds: [
    [$('bRlo'), $('bRhi')],
    [$('bGlo'), $('bGhi')],
    [$('bBlo'), $('bBhi')],
  ],
  anchor: [$('aR'), $('aG'), $('aB')],
  weights: [$('wR'), $('wG'), $('wB')],
  hints: {
    bounds: [$('hint-bR'), $('hint-bG'), $('hint-bB')],
    anchor: $('hint-anchor'),
    weight: $('hint-weight'),
  },
};

// ---------------------------------------------------------------------------
// 告警 / 状态
// ---------------------------------------------------------------------------

function showError(message, field) {
  els.banner.className = 'banner error show';
  els.banner.innerHTML = field
    ? `非法表或参数，字段 <span class="field-name"></span>：<span></span>`
    : `<span></span>`;
  const spans = els.banner.querySelectorAll('span');
  if (field) {
    spans[0].textContent = field;
    spans[1].textContent = message;
  } else {
    spans[0].textContent = message;
  }
}

function clearError() {
  els.banner.className = 'banner error';
  els.banner.textContent = '';
}

function setStatus(text) {
  els.statStatus.textContent = text;
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('inverse-lut-theme');
  } catch {
    /* 忽略 */
  }
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.dataset.theme = saved;
  }
  els.themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const darkNow =
      cur === 'dark' ||
      (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = darkNow ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('inverse-lut-theme', next);
    } catch {
      /* 忽略 */
    }
  });
}

// ---------------------------------------------------------------------------
// 文件导入（zip / json / ppm）
// ---------------------------------------------------------------------------

function setChip(chip, nameEl, ok, name) {
  chip.classList.toggle('ok', ok);
  nameEl.textContent = name;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const collected = { json: [], ppm: [] };

  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (lower.endsWith('.zip')) {
        await collectFromZip(buf, collected);
      } else if (lower.endsWith('.json')) {
        collected.json.push({ name: file.name, bytes: buf });
      } else if (lower.endsWith('.ppm') || lower.endsWith('.pnm')) {
        collected.ppm.push({ name: file.name, bytes: buf });
      }
    } catch (err) {
      showError(err.message || String(err), err.field);
      return;
    }
  }

  let tableOk = false;
  let imageOk = false;

  // 表解析：失败指出字段，且不替换已成功结果
  if (collected.json.length) {
    const item = collected.json[0];
    try {
      const obj = JSON.parse(new TextDecoder('utf-8').decode(item.bytes));
      const parsed = validateTable(obj);
      state.table = parsed;
      state.tableName = item.name;
      tableOk = true;
      syncFormFromTable(parsed);
      // 表改变后旧反查结果失效
      invalidateResult();
    } catch (err) {
      showError(err.message || String(err), err.field);
      // 非法表不替换已成功结果：芯片与状态保持上一次成功导入
      refreshApplyEnabled();
      return;
    }
  }

  if (collected.ppm.length) {
    const item = collected.ppm[0];
    try {
      const parsed = parseP6(item.bytes);
      state.target = parsed;
      state.targetName = item.name;
      imageOk = true;
      invalidateResult();
      renderTarget();
    } catch (err) {
      showError(err.message || String(err), err.field || 'P6');
      // 非法 P6 不替换已成功结果：芯片与状态保持上一次成功导入
      refreshApplyEnabled();
      return;
    }
  }

  if (tableOk) setChip(els.chipTable, els.nameTable, true, state.tableName);
  if (imageOk) setChip(els.chipImage, els.nameImage, true, state.targetName);
  if (tableOk || imageOk) clearError();
  refreshApplyEnabled();
}

function collectFromZip(buf, collected) {
  return new Promise((resolve, reject) => {
    try {
      const entries = fflate.unzipSync(buf);
      for (const [path, bytes] of Object.entries(entries)) {
        const lower = path.toLowerCase();
        const short = path.split('/').pop();
        if (!short) continue;
        if (lower.endsWith('.json')) {
          collected.json.push({ name: short, bytes });
        } else if (lower.endsWith('.ppm') || lower.endsWith('.pnm')) {
          collected.ppm.push({ name: short, bytes });
        }
      }
      resolve();
    } catch (err) {
      reject(new Error(`zip 解析失败：${err.message || err}`));
    }
  });
}

function syncFormFromTable(table) {
  for (let a = 0; a < 3; a++) {
    inputs.bounds[a][0].value = table.bounds[a][0];
    inputs.bounds[a][1].value = table.bounds[a][1];
    inputs.anchor[a].value = table.anchor[a];
    inputs.weights[a].value = table.weights[a];
  }
  clearFormHints();
}

function invalidateResult() {
  state.solver = null;
  state.codes = null;
  state.proof = null;
  state.selected = null;
  els.dlCodes.disabled = true;
  els.dlProof.disabled = true;
  els.cvProof.hidden = true;
  els.cvCodes.hidden = true;
  els.phProof.hidden = false;
  els.phCodes.hidden = false;
  els.metaProof.textContent = '—';
  els.metaCodes.textContent = '—';
  els.progressBar.style.width = '0';
  els.statBuild.textContent = '—';
  els.statSolve.textContent = '—';
  els.statCandidates.textContent = '—';
  els.statOutputs.textContent = '—';
  resetInspector();
}

// ---------------------------------------------------------------------------
// 表单读取与校验
// ---------------------------------------------------------------------------

function readInt(input) {
  if (input.value.trim() === '' || !Number.isInteger(Number(input.value))) {
    return { ok: false, value: null };
  }
  return { ok: true, value: Number(input.value) };
}

function clearFormHints() {
  for (const h of inputs.hints.bounds) h.textContent = '';
  inputs.hints.anchor.textContent = '';
  inputs.hints.weight.textContent = '';
  for (const arr of [inputs.bounds.flat(), inputs.anchor, inputs.weights]) {
    for (const i of arr) i.classList.remove('invalid');
  }
}

function readForm() {
  clearFormHints();
  const bounds = [[0, 0], [0, 0], [0, 0]];
  const anchor = [0, 0, 0];
  const weights = [0, 0, 0];
  const errors = [];

  for (let a = 0; a < 3; a++) {
    const ch = 'RGB'[a];
    const [loI, hiI] = inputs.bounds[a];
    const lo = readInt(loI);
    const hi = readInt(hiI);
    if (!lo.ok || !hi.ok || lo.value < 0 || lo.value > 63 || hi.value < 0 || hi.value > 63) {
      loI.classList.add('invalid');
      hiI.classList.add('invalid');
      inputs.hints.bounds[a].textContent = `${ch} 区间需为 0–63 整数`;
      errors.push(`bounds[${ch}] 需为 0–63 的整数闭区间`);
    } else if (lo.value > hi.value) {
      loI.classList.add('invalid');
      hiI.classList.add('invalid');
      inputs.hints.bounds[a].textContent = '下界不能大于上界';
      errors.push(`bounds[${ch}] 下界不能大于上界`);
    } else {
      bounds[a] = [lo.value, hi.value];
    }

    const an = readInt(inputs.anchor[a]);
    if (!an.ok || an.value < 0 || an.value > 63) {
      inputs.anchor[a].classList.add('invalid');
      errors.push(`anchor[${ch}] 需为 0–63 整数`);
    } else {
      anchor[a] = an.value;
    }

    const wt = readInt(inputs.weights[a]);
    if (!wt.ok || wt.value < 1 || wt.value > 8) {
      inputs.weights[a].classList.add('invalid');
      errors.push(`weights[${ch}] 需为 1–8 的整数`);
    } else {
      weights[a] = wt.value;
    }
  }

  if (errors.length) {
    inputs.hints.anchor.textContent = inputs.anchor.some((i) => i.classList.contains('invalid'))
      ? '参考码需为 0–63 整数'
      : '';
    inputs.hints.weight.textContent = inputs.weights.some((i) => i.classList.contains('invalid'))
      ? '权重需为 1–8 的整数'
      : '';
    return { ok: false, errors };
  }
  return { ok: true, bounds, anchor, weights };
}

function refreshApplyEnabled() {
  els.applyBtn.disabled = !(state.table && state.target);
}

// ---------------------------------------------------------------------------
// 反查执行
// ---------------------------------------------------------------------------

async function runInverse() {
  if (!state.table || !state.target) return;
  const form = readForm();
  if (!form.ok) {
    showError(form.errors[0]);
    return;
  }
  clearError();

  const token = ++state.runToken;
  els.cancelBtn.disabled = false;
  els.applyBtn.disabled = true;
  setStatus('构建候选…');
  els.progressBar.style.width = '0';

  const signal = { cancelled: false };
  state.activeSignal = signal;
  const t0 = performance.now();

  // 参数与当前 solver 对比：区间变了需整体重建，否则只增量更新
  let solver = state.solver;
  let rebuilt = false;
  const sameBounds =
    solver &&
    solver.bounds.every((b, a) => b[0] === form.bounds[a][0] && b[1] === form.bounds[a][1]);

  if (!solver || !sameBounds) {
    try {
      // 用当前表单参数重新校验一份表对象（表结构不变，仅覆盖可调字段）
      parseBounds(form.bounds);
      parseAnchor(form.anchor);
      parseWeights(form.weights);
      solver = new InverseSolver(state.table, form.bounds, form.anchor, form.weights);
      state.solver = solver;
      rebuilt = true;
    } catch (err) {
      showError(err.message, err.field);
      els.cancelBtn.disabled = true;
      refreshApplyEnabled();
      setStatus('参数错误');
      return;
    }
  } else {
    solver.setAnchor(form.anchor);
    solver.setWeights(form.weights);
  }

  const t1 = performance.now();
  if (token !== state.runToken) return;

  setStatus('反查中…');
  let codes;
  try {
    codes = await solver.solveImage(
      state.target.rgb,
      (done, total) => {
        if (token !== state.runToken) return;
        els.progressBar.style.width = `${(done / total) * 100}%`;
        setStatus(`反查中 ${Math.round((done / total) * 100)}%`);
      },
      signal
    );
  } catch (err) {
    if (err.message === 'CANCELLED') {
      setStatus('已中止');
      els.cancelBtn.disabled = true;
      refreshApplyEnabled();
      return;
    }
    throw err;
  }
  if (token !== state.runToken) return;

  const t2 = performance.now();

  // 正向回算校样
  const proof = new Uint8Array(codes.length);
  for (let p = 0; p < codes.length / 3; p++) {
    const o = p * 3;
    const out = forward(state.table, codes[o], codes[o + 1], codes[o + 2]);
    proof[o] = out[0];
    proof[o + 1] = out[1];
    proof[o + 2] = out[2];
  }
  const t3 = performance.now();

  state.codes = codes;
  state.proof = proof;
  state.selected = null;

  els.statCandidates.textContent = solver.candidateCount.toLocaleString('en-US');
  els.statOutputs.textContent = solver.buckets.size.toLocaleString('en-US');
  els.statBuild.textContent = rebuilt ? `${Math.round(t1 - t0)} ms` : '增量更新';
  els.statSolve.textContent = `${Math.round(t2 - t1)} ms（回算 ${Math.round(t3 - t2)} ms）`;
  setStatus('完成');
  els.progressBar.style.width = '100%';
  els.cancelBtn.disabled = true;
  refreshApplyEnabled();

  renderProofAndCodes();
  resetInspector();
}

// ---------------------------------------------------------------------------
// Canvas 渲染
// ---------------------------------------------------------------------------

function putImage(canvas, width, height, rgb) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    img.data[j] = rgb[i];
    img.data[j + 1] = rgb[i + 1];
    img.data[j + 2] = rgb[i + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function renderTarget() {
  const { width, height, rgb } = state.target;
  putImage(els.cvTarget, width, height, rgb);
  els.cvTarget.hidden = false;
  els.phTarget.hidden = true;
  els.metaTarget.textContent = `${width} × ${height} · ${state.targetName}`;
}

function renderProofAndCodes() {
  const { width, height } = state.target;
  putImage(els.cvProof, width, height, state.proof);
  els.cvProof.hidden = false;
  els.phProof.hidden = true;
  els.metaProof.textContent = `${width} × ${height} · 校样色 0–255`;

  // 码图显示放大 4 倍，保持像素化；底层数据仍是 0–63 原值
  const scale = 4;
  els.cvCodes.width = width * scale;
  els.cvCodes.height = height * scale;
  const ctx = els.cvCodes.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(width, height);
  // 仅用于显示：码值映射到 0–255 仅发生在显示 canvas，不影响下载字节
  for (let p = 0, j = 0; p < state.codes.length; p += 3, j += 4) {
    img.data[j] = (state.codes[p] * 255) / 63;
    img.data[j + 1] = (state.codes[p + 1] * 255) / 63;
    img.data[j + 2] = (state.codes[p + 2] * 255) / 63;
    img.data[j + 3] = 255;
  }
  // 先放小图再放大绘制
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.clearRect(0, 0, els.cvCodes.width, els.cvCodes.height);
  ctx.drawImage(tmp, 0, 0, els.cvCodes.width, els.cvCodes.height);
  els.cvCodes.hidden = false;
  els.phCodes.hidden = true;
  els.metaCodes.textContent = `${width} × ${height} · 显示 ×4（下载仍为原始码值）`;

  els.dlCodes.disabled = false;
  els.dlProof.disabled = false;
}

// ---------------------------------------------------------------------------
// 像素检查
// ---------------------------------------------------------------------------

function canvasToPixel(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
  return {
    x: Math.max(0, Math.min(canvas.width - 1, x)),
    y: Math.max(0, Math.min(canvas.height - 1, y)),
  };
}

function moveMarker(marker, box, canvas, x, y) {
  const rect = canvas.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const px = rect.width / canvas.width;
  const py = rect.height / canvas.height;
  marker.style.display = 'block';
  marker.style.left = `${rect.left - boxRect.left + x * px - 1}px`;
  marker.style.top = `${rect.top - boxRect.top + y * py - 1}px`;
  marker.style.width = `${Math.max(2, px)}px`;
  marker.style.height = `${Math.max(2, py)}px`;
}

function inspectPixel(x, y) {
  if (!state.target || !state.codes) return;
  state.selected = { x, y };
  const { width, rgb } = state.target;
  const p = y * width + x;
  const o = p * 3;

  const target = [rgb[o], rgb[o + 1], rgb[o + 2]];
  const code = [state.codes[o], state.codes[o + 1], state.codes[o + 2]];
  const proof = [state.proof[o], state.proof[o + 1], state.proof[o + 2]];
  const form = readForm();
  const weights = form.ok ? form.weights : state.table.weights;
  const anchor = form.ok ? form.anchor : state.table.anchor;

  $('piXY').textContent = `(${x}, ${y})`;
  $('piCode').textContent = `(${code.join(', ')})`;
  $('piTarget').innerHTML = swatch(target) + target.join(', ');
  $('piProof').innerHTML = swatch(proof) + proof.join(', ');

  let totalErr = 0;
  const rows = [];
  for (let c = 0; c < 3; c++) {
    const delta = proof[c] - target[c];
    const werr = weights[c] * delta * delta;
    totalErr += werr;
    rows.push(
      `<tr><td>${'RGB'[c]}</td><td>${target[c]}</td><td>${proof[c]}</td>` +
        `<td>${delta >= 0 ? '+' : ''}${delta}</td><td>${weights[c]}</td><td>${werr}</td></tr>`
    );
  }
  $('piWErr').textContent = String(totalErr);
  const man =
    Math.abs(code[0] - anchor[0]) +
    Math.abs(code[1] - anchor[1]) +
    Math.abs(code[2] - anchor[2]);
  $('piMan').textContent = String(man);

  els.diffTable.hidden = false;
  els.diffTable.querySelector('tbody').innerHTML = rows.join('');

  moveMarker(els.mkTarget, els.boxTarget, els.cvTarget, x, y);
  moveMarker(els.mkProof, els.boxProof, els.cvProof, x, y);
}

function swatch(rgb) {
  return `<span class="swatch" style="background:rgb(${rgb[0]},${rgb[1]},${rgb[2]})"></span>`;
}

function resetInspector() {
  $('piXY').textContent = '—';
  $('piCode').textContent = '—';
  $('piTarget').textContent = '—';
  $('piProof').textContent = '—';
  $('piWErr').textContent = '—';
  $('piMan').textContent = '—';
  els.diffTable.hidden = true;
  els.mkTarget.style.display = 'none';
  els.mkProof.style.display = 'none';
}

function bindCanvasClicks() {
  const bind = (canvas) => {
    canvas.addEventListener('click', (ev) => {
      const { x, y } = canvasToPixel(ev, canvas);
      inspectPixel(x, y);
    });
  };
  bind(els.cvTarget);
  bind(els.cvProof);
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function download(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function bindDownloads() {
  els.dlCodes.addEventListener('click', () => {
    if (!state.codes) return;
    const { width, height } = state.target;
    // 码图 P6：原始 0–63 码值直接写字节，不拉伸
    download(encodeP6(width, height, state.codes), 'codes.ppm', 'image/x-portable-pixmap');
  });
  els.dlProof.addEventListener('click', () => {
    if (!state.proof) return;
    const { width, height } = state.target;
    download(encodeP6(width, height, state.proof), 'proof.ppm', 'image/x-portable-pixmap');
  });
}

// ---------------------------------------------------------------------------
// 事件绑定与启动
// ---------------------------------------------------------------------------

function bindFileInput() {
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    handleFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  ['dragover', 'dragenter'].forEach((evt) =>
    els.dropzone.addEventListener(evt, (ev) => {
      ev.preventDefault();
      els.dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    els.dropzone.addEventListener(evt, (ev) => {
      ev.preventDefault();
      els.dropzone.classList.remove('drag');
    })
  );
  els.dropzone.addEventListener('drop', (ev) => {
    if (ev.dataTransfer?.files?.length) handleFiles(ev.dataTransfer.files);
  });
}

function init() {
  initTheme();
  bindFileInput();
  bindCanvasClicks();
  bindDownloads();
  els.applyBtn.addEventListener('click', runInverse);
  els.cancelBtn.addEventListener('click', () => {
    state.runToken++;
    if (state.activeSignal) state.activeSignal.cancelled = true;
    setStatus('正在中止…');
  });
  refreshApplyEnabled();
}

init();
